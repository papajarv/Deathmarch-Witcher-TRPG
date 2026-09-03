/**
 * Dissect (autopsy) mechanic for remains items.
 *
 *   - Pick one of three autopsy types (Combat / Stats / Skills) and the
 *     skill to use (Combat: Witcher Training ÷2 vs Monster Lore ÷4 ;
 *     Stats: First Aid ÷2 vs Wilderness Survival ÷4 ; Skills: Alchemy ÷2).
 *   - DC comes from the source monster's `system.threat.difficulty`:
 *       easy 14 · medium 16 · hard 18  (default 16).
 *   - On pass: 1 + floor((total − DC) / divisor) "hits".
 *   - Each hit pulls a random fact from the chosen autopsy's pool, rerolling
 *     against facts already known on this PC's bestiary entry. Skips a hit
 *     when the pool is exhausted.
 *   - Newly revealed facts are appended to the bestiary flag at:
 *       actor.flags["witcher-ttrpg-death-march"].bestiary[<encKey>].knowledge.facts
 *     as opaque string ids; bestiary.js renders them.
 *
 * Called from chrome/context-menu-item.js via runCarcassAction("dissect").
 */

import { MODULE_ID } from "../setup/settings.js";
import { encKey, bestiaryKeyFor, bumpResearchIfZero, grantRpToEntry, resolveCarcassMonster } from "../lib/bestiary.js";

import { t, tFormat } from "../lib/i18n.js";
const DialogV2 = foundry.applications.api.DialogV2;

const MONSTER_UUID_FLAG = "monsterUuid";   // set by monster-remains.js

/* Autopsy categories the GM can enable/disable in Bestiary Settings. Default
 * on. When NONE are enabled, the Dissect action is hidden on every carcass
 * (context-menu-item.js remainsAction), and the dialog only offers the enabled
 * ones. */
export const AUTOPSY_TYPE_IDS = ["combat", "stats", "skills", "research"];
export function autopsyTypeEnabled(id) {
  try { return (game.settings.get(MODULE_ID, "bestiary.autopsyTypes") ?? {})[id] !== false; }
  catch (_) { return true; }
}
export function anyAutopsyEnabled() {
  return AUTOPSY_TYPE_IDS.some(id => autopsyTypeEnabled(id));
}
/* Separate path from the existing `knowledge` (L3 reveal tracks defined in
 * lib/bestiary.js) so the two don't fight over the same key. */
const DISSECTION_PATH   = "dissection.facts";

const DIFFICULTY_DC = {
  easy: 14, medium: 16, hard: 18,
};
const DEFAULT_DC = 16;

/* Independent second axis of monster prep difficulty (Core p.268 —
 * threat vs complexity are two separate dials). Complexity adds a
 * flat DC bump on top of the base difficulty for every autopsy
 * roll: knowing that a rare-and-strange creature is genuinely
 * harder to interpret than a common one.
 *
 *   Simple    → +0  (mundane beast, easy to read)
 *   Complex   → +2  (moderately unusual — hybrid, exotic biology)
 *   Difficult → +4  (deeply strange — outer-planar, magic-suffused) */
const COMPLEXITY_DC_BONUS = {
  simple: 0, complex: 2, difficult: 4,
};

const LAB_OPTIONS = () => [
  { id: "none",       label: t("WITCHER.Chrome.Dissect.Dialog.Button.NoLaboratory", "No Laboratory"),   sub: "Field dissection, no proper tools.",                                       bonus: 0 },
  { id: "makeshift",  label: t("WITCHER.Chrome.Dissect.Dialog.Button.MakeshiftLab", "Makeshift Lab"),   sub: "Morgues, medic huts, torture chambers — improvised but useable.",         bonus: 2 },
  { id: "laboratorium", label: t("WITCHER.Chrome.Dissect.Dialog.Button.Laboratorium", "Laboratorium"),  sub: "A dedicated alchemical lab designed for this kind of procedure.",         bonus: 4 },
];

const COMBAT_SKILLS = () => [
  { id: "witcher-training", label: t("WITCHER.Chrome.Dissect.Dialog.Button.WitcherTraining", "Witcher Training"),    divisor: 2, isProfession: true,  skillName: t("WITCHER.Chrome.Dissect.Dialog.Button.WitcherTraining", "Witcher Training") },
  { id: "monster-lore",     label: t("WITCHER.Chrome.Dissect.Dialog.Button.MonsterLore", "Monster Lore"),        divisor: 4, isProfession: false, mapKey: "monster" },
];
const STATS_SKILLS = () => [
  { id: "first-aid",        label: t("WITCHER.Chrome.Dissect.Dialog.Button.FirstAid", "First Aid"),           divisor: 2, isProfession: false, mapKey: "firstaid" },
  { id: "wilderness",       label: t("WITCHER.Chrome.Dissect.Dialog.Button.WildernessSurvival", "Wilderness Survival"), divisor: 4, isProfession: false, mapKey: "wilderness" },
];
const SKILLS_SKILLS = () => [
  { id: "alchemy",          label: t("WITCHER.Common.Alchemy", "Alchemy"),             divisor: 2, isProfession: false, mapKey: "alchemy" },
];
/* Research autopsy — pure RP grant, no fact reveals. Witcher
 * Training is fastest (÷2) because you're literally trained for
 * this; Deduction is the fallback for non-witchers using pattern
 * recognition and induction. Each hit awards +1 RP toward the
 * monster's bestiary entry (same pool other RP-granting flows
 * feed via grantRpToEntry). */
const RESEARCH_SKILLS = () => [
  { id: "witcher-training", label: t("WITCHER.Chrome.Dissect.Dialog.Button.WitcherTraining", "Witcher Training"), divisor: 2, isProfession: true,  skillName: t("WITCHER.Chrome.Dissect.Dialog.Button.WitcherTraining", "Witcher Training") },
  { id: "deduction",        label: t("WITCHER.Chrome.Dissect.Dialog.Button.Deduction",       "Deduction"),        divisor: 4, isProfession: false, mapKey: "deduction" },
];

/** Public: invoked by runCarcassAction("dissect"). Returns false if the
 *  pre-conditions aren't met so the carcass charges aren't spent. */
export async function doDissect(item, actor) {
  if (!actor) {
    ui.notifications?.warn(t("WITCHER.Notify.Dissect.NotSidebar", "Dissect must be triggered from a character sheet, not the sidebar."));
    return false;
  }
  // The SPECIFIC instance this carcass came from (its parent token actor, whose
  // stat block the GM may have edited after spawn) — not the compendium source.
  const monster = await resolveCarcassMonster(item);
  if (!monster) {
    ui.notifications?.error(t("WITCHER.Notify.Dissect.MonsterMissing", "The source monster could not be found."));
    return false;
  }

  /* Combined dialog: lab + type in one screen, then optional skill
   * second dialog when the chosen type has more than one skill option. */
  const choice = await pickLabAndType(monster);
  if (!choice) return false;
  const { lab, type, mod = 0 } = choice;
  const set = type === "combat"   ? COMBAT_SKILLS()
            : type === "stats"    ? STATS_SKILLS()
            : type === "research" ? RESEARCH_SKILLS()
            : SKILLS_SKILLS();
  let skill = set[0];
  if (set.length > 1) {
    skill = await pickSkill(type, set);
    if (!skill) return false;
  }

  /* Roll. */
  const dc = monsterDC(monster);
  const rollResult = await rollChosenSkill(actor, skill);
  if (rollResult == null) return false;     // skill missing or roll-helper missing — message already shown
  const rolledTotal = rollResult.total;
  const formula     = rollResult.formula;
  /* Lab bonus + the user's custom situational modifier stack on top of the
   * d10-roll total before DC comparison — both are post-roll adjustments, not
   * bonuses to the specific skill the system rolled. */
  const effectiveTotal = rolledTotal + (lab.bonus || 0) + (mod || 0);

  /* Hits = 1 base + extras per divisor over DC. */
  const margin = effectiveTotal - dc;
  let hits = 0;
  if (margin >= 0) {
    hits = 1 + Math.floor(margin / skill.divisor);
  }

  /* Research type diverges from the other three: no fact pool, no
   * random reveal — just award +1 RP per hit to the dissector's
   * bestiary entry for this monster. The RP feeds the standard
   * research-tier progression (grantRpToEntry also auto-bumps L0→L1
   * on any RP gain, so no separate bumpResearchIfZero call needed). */
  let pool = [], knownSet = new Set(), revealedFacts = [];
  let rpAwarded = 0;
  if (type === "research") {
    if (hits > 0) {
      const bestKey = bestiaryKeyFor(monster) ?? monster.uuid;
      try {
        await grantRpToEntry(actor, bestKey, hits);
        rpAwarded = hits;
      } catch (err) {
        console.warn(`${MODULE_ID} | dissect research grantRp failed`, err);
      }
    } else {
      /* Even a failed research attempt still marks "you looked at
       * this creature" — bump L0→L1 so the entry appears in the
       * bestiary panel. */
      await bumpResearchIfZero(actor, monster);
    }
  } else {
    /* Build the pool and the already-known set, draw N unique
     * unrevealed facts (skip exhausted hits silently). */
    pool          = buildPool(type, monster);
    knownSet      = getKnownSet(actor, monster);
    revealedFacts = drawRevealed(pool, knownSet, hits);

    if (revealedFacts.length) {
      await appendKnownFacts(actor, monster, revealedFacts);
    }

    /* Performing a dissection unlocks the bestiary entry at tier 1
     * if it was still at tier 0 (un-researched). The act of cutting
     * the body open is itself the threshold to "known creature,
     * anonymous". */
    await bumpResearchIfZero(actor, monster);
  }

  /* Chat card summary. */
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: renderChatCard({
      actorName: actor.name,
      monster, item, type, skill, lab, mod,
      dc, rolledTotal, effectiveTotal, formula, hits, revealedFacts, pool, knownSet,
      rpAwarded
    })
  });

  return true;
}

/* ──────────────────────────────────────────────────────────────────────────
   Dialog: pick autopsy type + skill in one form
   ────────────────────────────────────────────────────────────────────────── */

/* Combined first dialog: explanation + lab radio + type-as-button. The
 * type buttons each capture the lab radio's current value, so the user
 * gets to one click + one button-press total instead of two dialogs.
 * Returns { lab, type } or null on cancel. */
async function pickLabAndType(monster) {
  const dc = monsterDC(monster);
  const diffKey       = monster.system?.threat?.difficulty;
  const complexityKey = monster.system?.threat?.complexity;
  const diffLabel     = CONFIG.WITCHER?.monster?.threat?.[diffKey];
  const complexLabel  = CONFIG.WITCHER?.monster?.complexity?.[complexityKey];
  const diff       = diffLabel    ? game.i18n.localize(diffLabel)    : (diffKey       || "—");
  const complex    = complexLabel ? game.i18n.localize(complexLabel) : (complexityKey || "—");
  const complexBonus = COMPLEXITY_DC_BONUS[complexityKey] ?? 0;
  const complexBonusStr = complexBonus > 0 ? ` (+${complexBonus})` : "";
  // Base difficulty DC before the complexity bump — mirrors monsterDC() so the
  // breakdown always sums to `dc`.
  const baseDC = DIFFICULTY_DC[diffKey || "medium"] ?? DEFAULT_DC;
  const content = `
    <div style="display:grid;gap:8px;font-size:0.75rem;line-height:1.45;max-height:70vh;overflow-y:auto;overflow-x:hidden;padding-right:6px;">
      <p style="margin:0;">
        ${tFormat(
          "WITCHER.Chrome.Dissect.Text.DissectingWithComplexity",
          { name: escText(monster.name), diff: escText(diff), complex: escText(complex), bonus: escText(complexBonusStr), dc },
          `Dissecting <b>${escText(monster.name)}</b> — difficulty <b>${escText(diff)}</b> · complexity <b>${escText(complex)}</b>${escText(complexBonusStr)} (DC <b>${dc}</b>).`
        )}
      </p>

      <div style="padding:6px 10px;border:1px solid var(--color-border-light-tertiary,#aaa);border-left:3px solid var(--color-text-hyperlink,#a47a3a);">
        <b>${t("WITCHER.Chrome.Dissect.Text.DcBreakdown", "Difficulty DC breakdown")}</b>
        <div style="display:grid;grid-template-columns:1fr auto;gap:1px 12px;margin-top:4px;font-family:var(--font-mono,monospace);font-size:0.6875rem;">
          <span>${t("WITCHER.Chrome.Dissect.Text.DcBase", "Base — difficulty")}: <b>${escText(diff)}</b></span>
          <span style="text-align:right;">${baseDC}</span>
          <span>${t("WITCHER.Chrome.Dissect.Text.DcComplexity", "Complexity")}: <b>${escText(complex)}</b></span>
          <span style="text-align:right;">${complexBonus > 0 ? `+${complexBonus}` : "+0"}</span>
          <span style="border-top:1px solid var(--color-border-light-tertiary,#aaa);margin-top:2px;padding-top:2px;font-weight:bold;">${t("WITCHER.Chrome.Dissect.Text.DcTotal", "Dissection DC")}</span>
          <span style="border-top:1px solid var(--color-border-light-tertiary,#aaa);margin-top:2px;padding-top:2px;text-align:right;font-weight:bold;">${dc}</span>
        </div>
      </div>

      <div style="padding:6px 10px;background:rgba(0,0,0,0.06);border-left:3px solid var(--color-text-hyperlink,#a47a3a);">
        <b>${t("WITCHER.Chrome.Dissect.Text.HowAutopsyWorks", "How autopsy works.")}</b>
        ${t("WITCHER.Chrome.Dissect.Text.HowAutopsyBody", "Pick the setting where the dissection is performed (it adds a flat bonus to your roll), then click one of the category buttons below. If the category has more than one skill, a second dialog lets you pick which to roll. Meet the DC for <b>1 hit</b>. Every additional <b>divisor</b> points above the DC = <b>+1 hit</b>. Each hit reveals one random unknown fact stored on this character's bestiary; already-known facts are re-rolled until something new comes up, and extra hits fizzle once the category is fully known.")}
      </div>

      <fieldset style="padding:6px 10px;border:1px solid var(--color-border-light-tertiary,#aaa);">
        <legend style="font-weight:bold;">${t("WITCHER.Chrome.Dissect.Text.Setting", "Setting")}</legend>
        ${LAB_OPTIONS().map((o, i) => `
          <label style="display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:center;cursor:pointer;padding:2px 0;">
            <input type="radio" name="lab" value="${escAttr(o.id)}" ${i === 0 ? "checked" : ""} />
            <span>
              <span style="font-weight:bold;">${escText(o.label)}</span>
              <span style="display:block;font-size:0.6875rem;opacity:0.75;">${escText(o.sub)}</span>
            </span>
            <span style="font-family:var(--font-mono,monospace);font-weight:bold;color:${o.bonus > 0 ? "#5a8a4a" : "#999"};">
              ${o.bonus > 0 ? `+${o.bonus}` : "—"}
            </span>
          </label>
        `).join("")}
        <label style="display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:center;padding:4px 0 0;margin-top:4px;border-top:1px solid var(--color-border-light-tertiary,#aaa);">
          <span style="font-weight:bold;">${t("WITCHER.Chrome.Dissect.Text.CustomModifier", "Custom modifier")}</span>
          <span style="font-size:0.6875rem;opacity:0.75;">${t("WITCHER.Chrome.Dissect.Text.CustomModifierHint", "Any situational bonus/penalty — proper tools, poor light, a GM ruling…")}</span>
          <input type="number" name="dissectMod" value="0" step="1" style="width:4.5rem;font-family:var(--font-mono,monospace);text-align:right;" />
        </label>
      </fieldset>

      ${autopsyTypeEnabled("combat") ? `<div style="padding:6px 10px;border:1px solid var(--color-border-light-tertiary,#aaa);">
        <div><b>${t("WITCHER.Chrome.Dissect.Text.CombatAttacks", "Combat (attacks)")}</b> — ${t("WITCHER.Chrome.Dissect.Text.CombatAttacksDesc", "name, damage, effect, ROF, qualities.")}</div>
        <div style="margin-left:12px;">• <b>${t("WITCHER.Chrome.Dissect.Dialog.Button.WitcherTraining", "Witcher Training")}</b> &nbsp;÷2 &nbsp;${t("WITCHER.Chrome.Dissect.Text.FasterEvery2", "(faster — every <b>2</b> over DC = +1 hit)")}</div>
        <div style="margin-left:12px;">• <b>${t("WITCHER.Chrome.Dissect.Dialog.Button.MonsterLore", "Monster Lore")}</b> &nbsp;÷4 &nbsp;${t("WITCHER.Chrome.Dissect.Text.SlowerEvery4", "(slower — every <b>4</b> over DC = +1 hit)")}</div>
      </div>` : ""}
      ${autopsyTypeEnabled("stats") ? `<div style="padding:6px 10px;border:1px solid var(--color-border-light-tertiary,#aaa);">
        <div><b>${t("WITCHER.Chrome.Dissect.Text.Stats", "Stats")}</b> — ${t("WITCHER.Chrome.Dissect.Text.StatsDesc", "base attributes and derived stats.")}</div>
        <div style="margin-left:12px;">• <b>${t("WITCHER.Chrome.Dissect.Dialog.Button.FirstAid", "First Aid")}</b> &nbsp;÷2</div>
        <div style="margin-left:12px;">• <b>${t("WITCHER.Chrome.Dissect.Dialog.Button.WildernessSurvival", "Wilderness Survival")}</b> &nbsp;÷4</div>
      </div>` : ""}
      ${autopsyTypeEnabled("skills") ? `<div style="padding:6px 10px;border:1px solid var(--color-border-light-tertiary,#aaa);">
        <div><b>${t("WITCHER.Chrome.Dissect.Text.Skills", "Skills")}</b> — ${t("WITCHER.Chrome.Dissect.Text.SkillsDesc", "the monster's skill <b>ranks</b> (just the skill value, <i>not</i> the rolled total of stat + rank).")}</div>
        <div style="margin-left:12px;">• <b>${t("WITCHER.Common.Alchemy", "Alchemy")}</b> &nbsp;÷2 &nbsp;${t("WITCHER.Chrome.Dissect.Text.OnlyOption", "(only option for this category)")}</div>
      </div>` : ""}
      ${autopsyTypeEnabled("research") ? `<div style="padding:6px 10px;border:1px solid var(--color-border-light-tertiary,#aaa);">
        <div><b>${t("WITCHER.Chrome.Dissect.Text.Research", "Research")}</b> — ${t("WITCHER.Chrome.Dissect.Text.ResearchDesc", "grants <b>+1 RP</b> per hit toward this monster's bestiary research tier. No random fact reveal — just research points.")}</div>
        <div style="margin-left:12px;">• <b>${t("WITCHER.Chrome.Dissect.Dialog.Button.WitcherTraining", "Witcher Training")}</b> &nbsp;÷2 &nbsp;${t("WITCHER.Chrome.Dissect.Text.MostEfficient", "(most efficient)")}</div>
        <div style="margin-left:12px;">• <b>${t("WITCHER.Chrome.Dissect.Dialog.Button.Deduction", "Deduction")}</b> &nbsp;÷4 &nbsp;${t("WITCHER.Chrome.Dissect.Text.LeastEfficient", "(least efficient)")}</div>
      </div>` : ""}
      <p style="margin:0;font-size:0.6875rem;opacity:0.75;">
        ${t("WITCHER.Chrome.Dissect.Text.PerformingBumpsTier", "Performing the dissection itself bumps a brand-new bestiary entry from research tier 0 → 1.")}
      </p>
    </div>
  `;

  /* Each category button captures the currently-checked lab radio in its
   * callback and returns { lab, type }. */
  const typeButton = (action, type) => ({
    action, label: action[0].toUpperCase() + action.slice(1),
    callback: (_ev, button) => {
      const id = button.form.querySelector("input[name='lab']:checked")?.value;
      const labOptions = LAB_OPTIONS();
      const lab = labOptions.find(o => o.id === id) ?? labOptions[0];
      const mod = Number(button.form.querySelector("input[name='dissectMod']")?.value) || 0;
      return { lab, type, mod };
    },
  });

  return DialogV2.wait({
    window: { title: t("WITCHER.Dialog.Dissect.Category", "Choose autopsy category"), resizable: true },
    content,
    position: { width: 560 },
    buttons: [
      ...(autopsyTypeEnabled("combat")   ? [typeButton("combat", "combat")] : []),
      ...(autopsyTypeEnabled("stats")    ? [typeButton("stats",  "stats")]  : []),
      ...(autopsyTypeEnabled("skills")   ? [typeButton("skills", "skills")] : []),
      ...(autopsyTypeEnabled("research") ? [{ ...typeButton("research", "research"), default: true }] : []),
      { action: "cancel", label: t("WITCHER.Common.Cancel", "Cancel") },
    ],
    rejectClose: false,
  });
}

/* Step 2: pick the skill within the chosen type. Skipped by the caller
 * when there's only one option. */
async function pickSkill(type, options) {
  const typeLabel = type === "combat" ? "Combat info"
                  : type === "stats"  ? "Stats info"
                  : "Skills info";
  const content = `
    <div style="display:grid;gap:6px;max-height:70vh;overflow-y:auto;overflow-x:hidden;padding-right:6px;">
      <p style="margin:0;">${escText(typeLabel)} — choose which skill to roll:</p>
      ${options.map((s, i) => `
        <label style="display:flex;gap:6px;align-items:center;cursor:pointer;">
          <input type="radio" name="skill" value="${s.id}" ${i === 0 ? "checked" : ""} />
          <span>${escText(s.label)} <span style="opacity:0.6;">(÷${s.divisor})</span></span>
        </label>
      `).join("")}
    </div>
  `;
  return DialogV2.wait({
    window: { title: tFormat("WITCHER.Dialog.Dissect.Skill", { type: typeLabel }, "Choose skill — {type}"), resizable: true },
    content,
    position: { width: 380 },
    buttons: [
      {
        action: "roll", label: t("WITCHER.Common.Roll", "Roll"), default: true,
        callback: (_ev, button) => {
          const id = button.form.querySelector("input[name='skill']:checked")?.value;
          return options.find(s => s.id === id) ?? options[0];
        },
      },
      { action: "cancel", label: t("WITCHER.Common.Cancel", "Cancel") },
    ],
    rejectClose: false,
  });
}

function monsterDC(monster) {
  const diff       = monster.system?.threat?.difficulty || "medium";
  const complexity = monster.system?.threat?.complexity || "simple";
  const base       = DIFFICULTY_DC[diff] ?? DEFAULT_DC;
  const bonus      = COMPLEXITY_DC_BONUS[complexity] ?? 0;
  return base + bonus;
}

/* ──────────────────────────────────────────────────────────────────────────
   Roll the chosen skill via the system's existing helpers
   ────────────────────────────────────────────────────────────────────────── */

async function rollChosenSkill(actor, skill) {
  if (skill.isProfession) {
    if (typeof actor.rollProfessionSkill !== "function" || typeof actor.findProfessionSlot !== "function") {
      ui.notifications?.error(t("WITCHER.Notify.Dissect.HelperMissingProf", "System's profession-skill roll helper missing."));
      return null;
    }
    const slot = actor.findProfessionSlot(skill.skillName);
    if (!slot) {
      ui.notifications?.error(tFormat("WITCHER.Notify.Dissect.NoSkill", { actor: actor.name, skill: skill.skillName }, "{actor} doesn't have the \"{skill}\" profession skill."));
      return null;
    }
    const roll = await actor.rollProfessionSkill(slot);
    return { total: roll?.total ?? 0, formula: roll?.formula ?? "" };
  }
  if (!CONFIG.WITCHER?.skillMap?.[skill.mapKey]) {
    ui.notifications?.error(tFormat("WITCHER.Notify.Dissect.SkillMissingMap", { key: skill.mapKey }, "Skill \"{key}\" missing from skillMap."));
    return null;
  }
  if (typeof actor.rollSkillCheck !== "function") {
    ui.notifications?.error(t("WITCHER.Notify.Dissect.HelperMissingSkill", "System's rollSkillCheck helper missing."));
    return null;
  }
  const roll = await actor.rollSkillCheck(skill.mapKey, null);
  return { total: roll?.total ?? 0, formula: roll?.formula ?? "" };
}

/* ──────────────────────────────────────────────────────────────────────────
   Pool builders — return arrays of opaque fact ids
   ────────────────────────────────────────────────────────────────────────── */

function buildPool(type, monster) {
  if (type === "combat") return buildCombatPool(monster);
  if (type === "stats")  return buildStatsPool(monster);
  if (type === "skills") return buildSkillsPool(monster);
  return [];
}

/** Per inline attack row (claws, bite, etc.): name, damage, attack base
 *  (the printed `Attack +X`), effect, ROF, plus each Weapon-Effect quality
 *  the attack carries. */
function buildCombatPool(monster) {
  const facts = [];
  const attacks = Array.isArray(monster.system?.combat?.attacks) ? monster.system.combat.attacks : [];
  attacks.forEach((atk, idx) => {
    facts.push(`attack:${idx}:name`);
    if (atk?.damage)                  facts.push(`attack:${idx}:damage`);
    if (Number(atk?.flatBonus) || 0)  facts.push(`attack:${idx}:flatBonus`);
    /* Weapon effect/description text is intentionally NOT a discoverable autopsy
     * fact — the combat pull is stats (damage, RoF, qualities, SP), not prose. */
    if (Number.isFinite(atk?.rof) && Number(atk.rof) > 1) {
      facts.push(`attack:${idx}:rof`);
    }
    const qualities = Array.isArray(atk?.qualities) ? atk.qualities : [];
    qualities.forEach((_, qidx) => facts.push(`attack:${idx}:quality:${qidx}`));
  });
  /* Natural armor (Stopping Power) is a combat characteristic — discoverable
   * alongside the attacks. */
  facts.push("combat:armor");
  return facts;
}

/** The ONLY derived stats the autopsy lifts to the bestiary — the four
 *  combat-relevant ones. Everything else (bonuses, movement, punch/kick dice,
 *  the *Unmodified wound-math snapshots) is intentionally not discoverable. */
const AUTOPSY_DERIVED_FACTS = ["hp", "sta", "stun", "woundThreshold"];
/* Luck and Toxicity aren't physical traits a dissection would reveal — never
 * offer them as discoverable stat facts. */
const EXCLUDED_STAT_FACTS = new Set(["luck", "toxicity"]);
function buildStatsPool(monster) {
  const facts = [];
  for (const k of Object.keys(monster.system?.stats ?? {})) {
    if (EXCLUDED_STAT_FACTS.has(k)) continue;
    facts.push(`stat:${k}`);
  }
  const derived = monster.system?.derivedStats ?? {};
  for (const k of AUTOPSY_DERIVED_FACTS) {
    if (k in derived) facts.push(`derived:${k}`);
  }
  return facts;
}

/** Per skill: only included when value > 0. */
function buildSkillsPool(monster) {
  const facts = [];
  const groups = monster.system?.skills ?? {};
  for (const [statKey, group] of Object.entries(groups)) {
    if (!group || typeof group !== "object") continue;
    for (const [skillKey, skill] of Object.entries(group)) {
      if (!skill || typeof skill !== "object") continue;
      const v = Number(skill.value) || 0;
      if (v <= 0) continue;
      facts.push(`skill:${statKey}.${skillKey}`);
    }
  }
  return facts;
}

/* ──────────────────────────────────────────────────────────────────────────
   Known-facts storage on the PC's bestiary entry for this monster
   ────────────────────────────────────────────────────────────────────────── */

function bestiaryEntryFlagPath(monster) {
  /* Match the bestiary panel's keying: bestiaryKeyFor() collapses
   * compendium-derivative world copies onto their upstream UUID, so this
   * stays consistent whether the player dissected a world clone or the
   * canonical compendium creature. encKey() escapes the dots so the
   * full UUID stays atomic inside the flag object. */
  const key = bestiaryKeyFor(monster) ?? monster.uuid;
  return `bestiary.${encKey(key)}`;
}

function getKnownSet(actor, monster) {
  const entry = actor.getFlag(MODULE_ID, bestiaryEntryFlagPath(monster)) ?? {};
  const facts = Array.isArray(entry?.dissection?.facts) ? entry.dissection.facts : [];
  return new Set(facts);
}

async function appendKnownFacts(actor, monster, newFacts) {
  const path  = bestiaryEntryFlagPath(monster);
  const entry = actor.getFlag(MODULE_ID, path) ?? {};
  const prior = Array.isArray(entry?.dissection?.facts) ? entry.dissection.facts : [];
  const next  = Array.from(new Set([...prior, ...newFacts]));
  /* Merge so existing keys (research, encounters, etc.) aren't blown away. */
  const merged = { ...entry, dissection: { ...(entry.dissection ?? {}), facts: next } };
  await actor.setFlag(MODULE_ID, path, merged);
}

/* bumpResearchIfZero now lives in lib/bestiary.js so the other carcass
 * actions (Extract Mutagen, Harvest) can call the same safe-against-
 * downgrade implementation. */

/* ──────────────────────────────────────────────────────────────────────────
   Reveal — pick N unique unrevealed facts, skip exhausted slots
   ────────────────────────────────────────────────────────────────────────── */

function drawRevealed(pool, knownSet, hitCount) {
  const candidates = pool.filter(f => !knownSet.has(f));
  const out = [];
  for (let i = 0; i < hitCount; i++) {
    if (!candidates.length) break;   // pool exhausted — silently skip the hit
    const idx = Math.floor(Math.random() * candidates.length);
    out.push(candidates[idx]);
    candidates.splice(idx, 1);
  }
  return out;
}

/* ──────────────────────────────────────────────────────────────────────────
   Chat card output
   ────────────────────────────────────────────────────────────────────────── */

function renderChatCard({ actorName, monster, item, type, skill, lab, mod = 0, dc, rolledTotal, effectiveTotal, formula, hits, revealedFacts, pool, knownSet, rpAwarded = 0 }) {
  const typeLabel = type === "combat"
    ? t("WITCHER.Chrome.Dissect.Text.TypeCombat", "Combat")
    : type === "stats"
    ? t("WITCHER.Chrome.Dissect.Text.TypeStats", "Stats")
    : type === "research"
    ? t("WITCHER.Chrome.Dissect.Text.Research", "Research")
    : t("WITCHER.Chrome.Dissect.Text.TypeSkills", "Skills");
  const isResearch = type === "research";
  const exhausted  = isResearch ? 0 : (hits - revealedFacts.length);
  /* Research type: single line summarizing RP earned. Everything
   * else: bullet list of revealed facts (or "no new information"
   * when the pool was exhausted). */
  const factLines = isResearch
    ? (rpAwarded > 0
        ? `<li>${tFormat("WITCHER.Chrome.Dissect.Text.RpEarnedLine", { rp: rpAwarded }, `<b>+${rpAwarded} RP</b> gained toward this bestiary entry.`)}</li>`
        : `<li style="opacity:0.7;font-style:italic;">${t("WITCHER.Chrome.Dissect.Text.NoRpGained", "No RP gained.")}</li>`)
    : (revealedFacts.length
        ? revealedFacts.map(f => `<li>${escText(describeFact(f, monster))}</li>`).join("")
        : `<li style="opacity:0.7;font-style:italic;">${t("WITCHER.Chrome.Dissect.Text.NoNewInformation", "No new information.")}</li>`);
  const exhaustNote = exhausted > 0
    ? `<p style="margin:4px 0 0;font-size:0.6875rem;opacity:0.7;">${exhausted} hit${exhausted === 1 ? "" : "s"} fizzled — the bestiary entry is full on this category.</p>`
    : "";
  const passFail = effectiveTotal >= dc
    ? `<span style="color:#5a8a4a;font-weight:bold;">${t("WITCHER.Chrome.Dissect.Text.Pass", "Pass")}</span>`
    : `<span style="color:#a25050;font-weight:bold;">${t("WITCHER.Chrome.Dissect.Text.Fail", "Fail")}</span>`;
  const labBonus = Number(lab?.bonus) || 0;
  const modVal   = Number(mod) || 0;
  const modStr   = (n) => `${n > 0 ? "+" : ""}${n}`;
  const adj = [];
  if (labBonus) adj.push(`Lab bonus: <b>+${labBonus}</b> (${escText(lab.label)})`);
  if (modVal)   adj.push(`Modifier: <b>${modStr(modVal)}</b>`);
  const adjStr = adj.length ? ` &nbsp;·&nbsp; ${adj.join(" &nbsp;·&nbsp; ")} &nbsp;→ <b>${effectiveTotal}</b>` : "";
  const formulaLine = formula ? `
      <div style="font-size:0.6875rem;opacity:0.85;font-family:var(--font-mono,monospace);background:rgba(0,0,0,0.08);padding:2px 6px;margin:2px 0;">
        Rolled: ${escText(formula)} = <b>${rolledTotal}</b>${adjStr}
      </div>` : "";
  const labLine = !formula && lab ? `
      <div style="font-size:0.6875rem;opacity:0.85;">
        Setting: <b>${escText(lab.label)}</b>${labBonus ? ` (+${labBonus})` : ""}${modVal ? ` &nbsp;·&nbsp; Modifier: <b>${modStr(modVal)}</b>` : ""}
      </div>` : "";
  return `
    <div class="wou-dissect-card">
      <h3 style="margin:0 0 4px;">Dissection · ${escText(item.name)}</h3>
      <div style="font-size:0.6875rem;opacity:0.85;">
        ${escText(actorName)} → ${escText(monster.name)} · ${typeLabel} (${escText(skill.label)})
      </div>
      ${formulaLine}${labLine}
      <div style="margin:4px 0;">
        ${passFail} <b>${effectiveTotal}</b> vs DC <b>${dc}</b>
        ${hits > 0 ? `· <b>${hits}</b> hit${hits === 1 ? "" : "s"} · <b>${revealedFacts.length}</b> learned` : ""}
      </div>
      <ul style="margin:4px 0 0;padding-left:18px;">
        ${factLines}
      </ul>
      ${exhaustNote}
    </div>
  `;
}

/** Turn an opaque fact id into a human-readable string for the chat card. */
function describeFact(factId, monster) {
  if (factId.startsWith("stat:")) {
    const k = factId.slice("stat:".length);
    const v = monster.system?.stats?.[k]?.value ?? "?";
    return tFormat("WITCHER.Chrome.Dissect.Text.StatLine", { label: labelFor(k), value: v }, `Stat · ${labelFor(k)}: ${v}`);
  }
  if (factId.startsWith("derived:")) {
    const k = factId.slice("derived:".length);
    /* Only hp/sta are pools ({value,max}); the rest (stun, rec, run, leap,
     * punch, …) are bare numbers/strings on derivedStats. */
    const d = monster.system?.derivedStats?.[k];
    const v = (d !== null && typeof d === "object") ? (d.value ?? "?") : (d ?? "?");
    return tFormat("WITCHER.Chrome.Dissect.Text.DerivedLine", { label: labelFor(k), value: v }, `Derived · ${labelFor(k)}: ${v}`);
  }
  if (factId.startsWith("skill:")) {
    const [statKey, skillKey] = factId.slice("skill:".length).split(".");
    const sk = monster.system?.skills?.[statKey]?.[skillKey];
    const v = sk?.value ?? "?";
    return tFormat("WITCHER.Chrome.Dissect.Text.SkillRankLine", { skill: labelFor(skillKey), stat: labelFor(statKey), value: v }, `Skill rank · ${labelFor(skillKey)} (${labelFor(statKey)}): ${v}`);
  }
  if (factId.startsWith("attack:")) {
    const rest = factId.slice("attack:".length);
    const [idxStr, prop, ...tail] = rest.split(":");
    const atk = monster.system?.combat?.attacks?.[Number(idxStr)];
    if (!atk) return t("WITCHER.Chrome.Dissect.Text.AttackMissing", "Attack · (missing)");
    const name = atk.name || t("WITCHER.Chrome.Dissect.Text.Attack", "Attack");
    if (prop === "name")      return tFormat("WITCHER.Chrome.Dissect.Text.AttackName", { name }, `Attack · ${name}`);
    if (prop === "damage")    return tFormat("WITCHER.Chrome.Dissect.Text.AttackDamage", { name, value: atk.damage ?? "?" }, `Attack · ${name} damage: ${atk.damage ?? "?"}`);
    if (prop === "effect")    return tFormat("WITCHER.Chrome.Dissect.Text.AttackEffect", { name, value: atk.effect ?? "?" }, `Attack · ${name} effect: ${atk.effect ?? "?"}`);
    if (prop === "rof")       return tFormat("WITCHER.Chrome.Dissect.Text.AttackROF", { name, value: atk.rof ?? "?" }, `Attack · ${name} ROF: ${atk.rof ?? "?"}`);
    if (prop === "flatBonus") {
      const v = Number(atk.flatBonus) || 0;
      return tFormat("WITCHER.Chrome.Dissect.Text.AttackBase", { name, value: `${v >= 0 ? "+" : ""}${v}` }, `Attack · ${name} base: ${v >= 0 ? "+" : ""}${v}`);
    }
    if (prop === "quality") {
      const qidx = Number(tail[0]) || 0;
      const key = Array.isArray(atk.qualities) ? atk.qualities[qidx] : undefined;
      return tFormat("WITCHER.Chrome.Dissect.Text.AttackQuality", { name, value: qualityLabel(key, atk.qualityValues) }, `Attack · ${name} quality: ${qualityLabel(key, atk.qualityValues)}`);
    }
  }
  return factId;
}

/** Resolve a Weapon-Effect quality key to its label, appending the inline
 *  parameter value (e.g. "Bleeding 25%") when one is stored. */
function qualityLabel(key, qualityValues) {
  if (!key) return "?";
  const catalog = CONFIG.WITCHER?.weapon?.qualities ?? {};
  const entry = catalog[key];
  const label = entry?.label ? game.i18n.localize(entry.label) : labelFor(key);
  const val = qualityValues?.[key];
  if (val != null && String(val).trim()) {
    const suffix = entry?.param?.suffix ?? "";
    return `${label} ${val}${suffix}`;
  }
  return label;
}

function labelFor(k) {
  /* Lightweight prettifier — splits camelCase / kebab-case and Titles it. */
  if (!k) return "";
  return String(k)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_·]+/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());
}

function escText(s) {
  return String(s ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
}
function escAttr(s) {
  return String(s ?? "")
    .replaceAll("&","&amp;").replaceAll('"',"&quot;").replaceAll("'","&#39;")
    .replaceAll("<","&lt;").replaceAll(">","&gt;");
}
