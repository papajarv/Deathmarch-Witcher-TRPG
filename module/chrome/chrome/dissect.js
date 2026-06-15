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
import { encKey, bestiaryKeyFor, bumpResearchIfZero } from "../lib/bestiary.js";

const DialogV2 = foundry.applications.api.DialogV2;

const MONSTER_UUID_FLAG = "monsterUuid";   // set by monster-remains.js
/* Separate path from the existing `knowledge` (L3 reveal tracks defined in
 * lib/bestiary.js) so the two don't fight over the same key. */
const DISSECTION_PATH   = "dissection.facts";

const DIFFICULTY_DC = {
  easy: 14, medium: 16, hard: 18,
};
const DEFAULT_DC = 16;

const LAB_OPTIONS = [
  { id: "none",       label: "No Laboratory",   sub: "Field dissection, no proper tools.",                                       bonus: 0 },
  { id: "makeshift",  label: "Makeshift Lab",   sub: "Morgues, medic huts, torture chambers — improvised but useable.",         bonus: 2 },
  { id: "laboratorium", label: "Laboratorium",  sub: "A dedicated alchemical lab designed for this kind of procedure.",         bonus: 4 },
];

const COMBAT_SKILLS = [
  { id: "witcher-training", label: "Witcher Training",    divisor: 2, isProfession: true,  skillName: "Witcher Training" },
  { id: "monster-lore",     label: "Monster Lore",        divisor: 4, isProfession: false, mapKey: "monster" },
];
const STATS_SKILLS = [
  { id: "first-aid",        label: "First Aid",           divisor: 2, isProfession: false, mapKey: "firstaid" },
  { id: "wilderness",       label: "Wilderness Survival", divisor: 4, isProfession: false, mapKey: "wilderness" },
];
const SKILLS_SKILLS = [
  { id: "alchemy",          label: "Alchemy",             divisor: 2, isProfession: false, mapKey: "alchemy" },
];

/** Public: invoked by runCarcassAction("dissect"). Returns false if the
 *  pre-conditions aren't met so the carcass charges aren't spent. */
export async function doDissect(item, actor) {
  if (!actor) {
    ui.notifications?.warn("Dissect must be triggered from a character sheet, not the sidebar.");
    return false;
  }
  const monsterUuid = item.system?.monsterUuid || item.flags?.[MODULE_ID]?.[MONSTER_UUID_FLAG];
  if (!monsterUuid) {
    ui.notifications?.error("These remains aren't linked to a source monster.");
    return false;
  }
  const monster = await fromUuid(monsterUuid);
  if (!monster) {
    ui.notifications?.error("The source monster could not be found.");
    return false;
  }

  /* Combined dialog: lab + type in one screen, then optional skill
   * second dialog when the chosen type has more than one skill option. */
  const choice = await pickLabAndType(monster);
  if (!choice) return false;
  const { lab, type } = choice;
  const set = type === "combat" ? COMBAT_SKILLS
            : type === "stats"  ? STATS_SKILLS
            : SKILLS_SKILLS;
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
  /* Lab bonus stacks on top of the d10-roll's total before DC comparison —
   * it represents the proper tooling for the autopsy, not a bonus to any
   * specific skill the system rolled, so we add it post-roll. */
  const effectiveTotal = rolledTotal + (lab.bonus || 0);

  /* Hits = 1 base + extras per divisor over DC. */
  const margin = effectiveTotal - dc;
  let hits = 0;
  if (margin >= 0) {
    hits = 1 + Math.floor(margin / skill.divisor);
  }

  /* Build the pool and the already-known set, draw N unique unrevealed
   * facts (skip exhausted hits silently). */
  const pool          = buildPool(type, monster);
  const knownSet      = getKnownSet(actor, monster);
  const revealedFacts = drawRevealed(pool, knownSet, hits);

  if (revealedFacts.length) {
    await appendKnownFacts(actor, monster, revealedFacts);
  }

  /* Performing a dissection unlocks the bestiary entry at tier 1 if it was
   * still at tier 0 (un-researched). The act of cutting the body open is
   * itself the threshold to "known creature, anonymous". */
  await bumpResearchIfZero(actor, monster);

  /* Chat card summary. */
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: renderChatCard({
      actorName: actor.name,
      monster, item, type, skill, lab,
      dc, rolledTotal, effectiveTotal, formula, hits, revealedFacts, pool, knownSet
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
  const diffKey = monster.system?.threat?.difficulty;
  const diffLabel = CONFIG.WITCHER?.monster?.threat?.[diffKey];
  const diff = diffLabel ? game.i18n.localize(diffLabel) : (diffKey || "—");
  const content = `
    <div style="display:grid;gap:8px;font-size:12px;line-height:1.45;">
      <p style="margin:0;">
        Dissecting <b>${escText(monster.name)}</b>
        — difficulty <b>${escText(diff)}</b> (DC <b>${dc}</b>).
      </p>
      <div style="padding:6px 10px;background:rgba(0,0,0,0.06);border-left:3px solid var(--color-text-hyperlink,#a47a3a);">
        <b>How autopsy works.</b>
        Pick the setting where the dissection is performed (it adds a flat
        bonus to your roll), then click one of the category buttons below.
        If the category has more than one skill, a second dialog lets you
        pick which to roll. Meet the DC for <b>1 hit</b>. Every additional
        <b>divisor</b> points above the DC = <b>+1 hit</b>. Each hit reveals
        one random unknown fact stored on this character's bestiary; already-
        known facts are re-rolled until something new comes up, and extra
        hits fizzle once the category is fully known.
      </div>

      <fieldset style="padding:6px 10px;border:1px solid var(--color-border-light-tertiary,#aaa);">
        <legend style="font-weight:bold;">Setting</legend>
        ${LAB_OPTIONS.map((o, i) => `
          <label style="display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:center;cursor:pointer;padding:2px 0;">
            <input type="radio" name="lab" value="${escAttr(o.id)}" ${i === 0 ? "checked" : ""} />
            <span>
              <span style="font-weight:bold;">${escText(o.label)}</span>
              <span style="display:block;font-size:11px;opacity:0.75;">${escText(o.sub)}</span>
            </span>
            <span style="font-family:var(--font-mono,monospace);font-weight:bold;color:${o.bonus > 0 ? "#5a8a4a" : "#999"};">
              ${o.bonus > 0 ? `+${o.bonus}` : "—"}
            </span>
          </label>
        `).join("")}
      </fieldset>

      <div style="padding:6px 10px;border:1px solid var(--color-border-light-tertiary,#aaa);">
        <div><b>Combat (attacks)</b> — name, damage, effect, ROF, qualities.</div>
        <div style="margin-left:12px;">• <b>Witcher Training</b> &nbsp;÷2 &nbsp;(faster — every <b>2</b> over DC = +1 hit)</div>
        <div style="margin-left:12px;">• <b>Monster Lore</b> &nbsp;÷4 &nbsp;(slower — every <b>4</b> over DC = +1 hit)</div>
      </div>
      <div style="padding:6px 10px;border:1px solid var(--color-border-light-tertiary,#aaa);">
        <div><b>Stats</b> — base attributes and derived stats.</div>
        <div style="margin-left:12px;">• <b>First Aid</b> &nbsp;÷2</div>
        <div style="margin-left:12px;">• <b>Wilderness Survival</b> &nbsp;÷4</div>
      </div>
      <div style="padding:6px 10px;border:1px solid var(--color-border-light-tertiary,#aaa);">
        <div><b>Skills</b> — the monster's skill <b>ranks</b> (just the skill
          value, <i>not</i> the rolled total of stat + rank).</div>
        <div style="margin-left:12px;">• <b>Alchemy</b> &nbsp;÷2 &nbsp;(only option for this category)</div>
      </div>
      <p style="margin:0;font-size:11px;opacity:0.75;">
        Performing the dissection itself bumps a brand-new bestiary entry from
        research tier 0 → 1.
      </p>
    </div>
  `;

  /* Each category button captures the currently-checked lab radio in its
   * callback and returns { lab, type }. */
  const typeButton = (action, type) => ({
    action, label: action[0].toUpperCase() + action.slice(1),
    callback: (_ev, button) => {
      const id = button.form.querySelector("input[name='lab']:checked")?.value;
      const lab = LAB_OPTIONS.find(o => o.id === id) ?? LAB_OPTIONS[0];
      return { lab, type };
    },
  });

  return DialogV2.wait({
    window: { title: "Choose autopsy category" },
    content,
    position: { width: 560 },
    buttons: [
      typeButton("combat", "combat"),
      typeButton("stats",  "stats"),
      { ...typeButton("skills", "skills"), default: true },
      { action: "cancel", label: "Cancel" },
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
    <div style="display:grid;gap:6px;">
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
    window: { title: `Choose skill — ${typeLabel}` },
    content,
    position: { width: 380 },
    buttons: [
      {
        action: "roll", label: "Roll", default: true,
        callback: (_ev, button) => {
          const id = button.form.querySelector("input[name='skill']:checked")?.value;
          return options.find(s => s.id === id) ?? options[0];
        },
      },
      { action: "cancel", label: "Cancel" },
    ],
    rejectClose: false,
  });
}

function monsterDC(monster) {
  const diff = monster.system?.threat?.difficulty || "medium";
  return DIFFICULTY_DC[diff] ?? DEFAULT_DC;
}

/* ──────────────────────────────────────────────────────────────────────────
   Roll the chosen skill via the system's existing helpers
   ────────────────────────────────────────────────────────────────────────── */

async function rollChosenSkill(actor, skill) {
  if (skill.isProfession) {
    if (typeof actor.rollProfessionSkill !== "function" || typeof actor.findProfessionSlot !== "function") {
      ui.notifications?.error("System's profession-skill roll helper missing.");
      return null;
    }
    const slot = actor.findProfessionSlot(skill.skillName);
    if (!slot) {
      ui.notifications?.error(`${actor.name} doesn't have the "${skill.skillName}" profession skill.`);
      return null;
    }
    const roll = await actor.rollProfessionSkill(slot);
    return { total: roll?.total ?? 0, formula: roll?.formula ?? "" };
  }
  if (!CONFIG.WITCHER?.skillMap?.[skill.mapKey]) {
    ui.notifications?.error(`Skill "${skill.mapKey}" missing from skillMap.`);
    return null;
  }
  if (typeof actor.rollSkillCheck !== "function") {
    ui.notifications?.error("System's rollSkillCheck helper missing.");
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

/** Per inline attack row (claws, bite, etc.): name, damage, effect, ROF,
 *  plus each Weapon-Effect quality the attack carries. */
function buildCombatPool(monster) {
  const facts = [];
  const attacks = Array.isArray(monster.system?.combat?.attacks) ? monster.system.combat.attacks : [];
  attacks.forEach((atk, idx) => {
    facts.push(`attack:${idx}:name`);
    if (atk?.damage)                  facts.push(`attack:${idx}:damage`);
    if (String(atk?.effect ?? "").trim()) facts.push(`attack:${idx}:effect`);
    if (Number.isFinite(atk?.rof) && Number(atk.rof) > 1) {
      facts.push(`attack:${idx}:rof`);
    }
    const qualities = Array.isArray(atk?.qualities) ? atk.qualities : [];
    qualities.forEach((_, qidx) => facts.push(`attack:${idx}:quality:${qidx}`));
  });
  return facts;
}

/** All base stats + derived stats as candidate facts. */
function buildStatsPool(monster) {
  const facts = [];
  for (const k of Object.keys(monster.system?.stats ?? {})) {
    facts.push(`stat:${k}`);
  }
  for (const k of Object.keys(monster.system?.derivedStats ?? {})) {
    facts.push(`derived:${k}`);
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

function renderChatCard({ actorName, monster, item, type, skill, lab, dc, rolledTotal, effectiveTotal, formula, hits, revealedFacts, pool, knownSet }) {
  const typeLabel = type === "combat" ? "Combat" : type === "stats" ? "Stats" : "Skills";
  const exhausted = hits - revealedFacts.length;
  const factLines = revealedFacts.length
    ? revealedFacts.map(f => `<li>${escText(describeFact(f, monster))}</li>`).join("")
    : `<li style="opacity:0.7;font-style:italic;">No new information.</li>`;
  const exhaustNote = exhausted > 0
    ? `<p style="margin:4px 0 0;font-size:11px;opacity:0.7;">${exhausted} hit${exhausted === 1 ? "" : "s"} fizzled — the bestiary entry is full on this category.</p>`
    : "";
  const passFail = effectiveTotal >= dc
    ? `<span style="color:#5a8a4a;font-weight:bold;">Pass</span>`
    : `<span style="color:#a25050;font-weight:bold;">Fail</span>`;
  const labBonus = Number(lab?.bonus) || 0;
  const formulaLine = formula ? `
      <div style="font-size:11px;opacity:0.85;font-family:var(--font-mono,monospace);background:rgba(0,0,0,0.08);padding:2px 6px;margin:2px 0;">
        Rolled: ${escText(formula)} = <b>${rolledTotal}</b>${labBonus ? ` &nbsp;·&nbsp; Lab bonus: <b>+${labBonus}</b> (${escText(lab.label)}) &nbsp;→ <b>${effectiveTotal}</b>` : ""}
      </div>` : "";
  const labLine = !formula && lab ? `
      <div style="font-size:11px;opacity:0.85;">
        Setting: <b>${escText(lab.label)}</b>${labBonus ? ` (+${labBonus})` : ""}
      </div>` : "";
  return `
    <div class="wou-dissect-card">
      <h3 style="margin:0 0 4px;">Dissection · ${escText(item.name)}</h3>
      <div style="font-size:11px;opacity:0.85;">
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
    return `Stat · ${labelFor(k)}: ${v}`;
  }
  if (factId.startsWith("derived:")) {
    const k = factId.slice("derived:".length);
    /* Only hp/sta are pools ({value,max}); the rest (stun, rec, run, leap,
     * punch, …) are bare numbers/strings on derivedStats. */
    const d = monster.system?.derivedStats?.[k];
    const v = (d !== null && typeof d === "object") ? (d.value ?? "?") : (d ?? "?");
    return `Derived · ${labelFor(k)}: ${v}`;
  }
  if (factId.startsWith("skill:")) {
    const [statKey, skillKey] = factId.slice("skill:".length).split(".");
    const sk = monster.system?.skills?.[statKey]?.[skillKey];
    const v = sk?.value ?? "?";
    return `Skill rank · ${labelFor(skillKey)} (${labelFor(statKey)}): ${v}`;
  }
  if (factId.startsWith("attack:")) {
    const rest = factId.slice("attack:".length);
    const [idxStr, prop, ...tail] = rest.split(":");
    const atk = monster.system?.combat?.attacks?.[Number(idxStr)];
    if (!atk) return `Attack · (missing)`;
    const name = atk.name || "Attack";
    if (prop === "name")    return `Attack · ${name}`;
    if (prop === "damage")  return `Attack · ${name} damage: ${atk.damage ?? "?"}`;
    if (prop === "effect")  return `Attack · ${name} effect: ${atk.effect ?? "?"}`;
    if (prop === "rof")     return `Attack · ${name} ROF: ${atk.rof ?? "?"}`;
    if (prop === "quality") {
      const qidx = Number(tail[0]) || 0;
      const key = Array.isArray(atk.qualities) ? atk.qualities[qidx] : undefined;
      return `Attack · ${name} quality: ${qualityLabel(key, atk.qualityValues)}`;
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
