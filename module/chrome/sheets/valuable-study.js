/**
 * Book system — three types of "book" valuables.
 *
 * monster  Grants 1 RP per successful Education check (once/day, stress on fail).
 *          Stops when all matched entries are at MAX_RESEARCH.
 *
 * skill    Trains a specific skill 5 successful checks per rank, up to a
 *          configured rank cap (once/day, stress on fail).
 *
 * stress   Sequential reading sessions — each session reveals a text excerpt
 *          and applies a per-step stress delta. No skill check, no daily limit.
 *
 * Item flag  flags["witcher-ttrpg-death-march"].bookConfig = {
 *   bookType: "monster"|"skill"|"stress",
 *   monster: { mode, specificKey, listKeys, filter, dc,
 *              totalReadings, rpPerReading,
 *              commonKnowledgeReading, secondKnowledgeReading },
 *   skill:   { skillStat, skillId, rangeMin, rangeMax, dc },
 *   stress:  { steps: [{ text, stressChange }] }
 * }
 *
 * Actor flag  flags["witcher-ttrpg-death-march"].bookUsage[encKey(uuid)] = {
 *   lastAttemptDay,  // monster + skill: once-per-day gate
 *   hits,            // skill: cumulative successful roll-hits
 *   currentStep,     // stress: index of next unread step
 *   completed        // stress: true when all steps read
 * }
 */

import { MODULE_ID } from "../setup/settings.js";
import { loadEntries } from "../chrome/bestiary.js";
import { t, tFormat } from "../lib/i18n.js";
import {
  encKey,
  grantRpToEntry,
  grantKnowledgeViaBook,
  getActorEntryState,
  updateActorEntryState,
  MAX_RESEARCH,
  RESEARCH_COSTS
} from "../lib/bestiary.js";

export const BOOK_TYPE_SLUG = "book";
const LEGACY_ID        = "witcher-overhaul-ui";
const BOOK_FLAG        = "bookConfig";
const LEGACY_BOOK_FLAG = "bestiaryBook";
const USAGE_FLAG       = "bookUsage";
const SECONDS_PER_DAY  = 14400; // 4-hour reading cooldown
const HITS_PER_RANK    = 5;

export const BOOK_TYPES = {
  MONSTER: "monster",
  SKILL:   "skill",
  STRESS:  "stress"
};

const STUDY_SKILL       = "education";
const STUDY_SKILL_LABEL = "Education";
const STUDY_DC          = 15;

/* The written languages (all INT skills). A book can be "written in" one of
 * these and require a rank to read; see evalBookLanguage. NOTE: the "monster"
 * skill (Monster Lore) is intentionally excluded — it's a body of knowledge,
 * not a written language you can author a book in. */
const LANGUAGE_SKILLS = ["commonspeech", "eldersp", "elderspskellige", "dwarven", "nilfgaardian"];

/* Reading cooldowns are GM-configurable via the Book System settings menu
 * (bookSystemConfig). These are the fallback defaults (previously hard-coded
 * as SECONDS_PER_DAY / STRESS_STEP_COOLDOWN_S = 4h each). Read live so a
 * changed cooldown takes effect on the next reading. */
function getBookTimings() {
  let stored = {};
  try { stored = game.settings?.get?.(MODULE_ID, "bookSystemConfig") ?? {}; }
  catch (_) { stored = {}; }
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
  return {
    studySeconds: num(stored.studyCooldownHours, 4) * 3600,
    novelSeconds: num(stored.novelStepCooldownHours, 4) * 3600
  };
}

/* Whether failed monster/skill readings add stress, and how much. Both live
 * on the stress config (bookFailStressEnabled default true, bookFailStressAmount
 * default 1) so GMs can turn off — or retune — the toll. */
function bookFailStressEnabled() {
  let stored = {};
  try { stored = game.settings?.get?.(MODULE_ID, "stressConfig") ?? {}; }
  catch (_) { stored = {}; }
  return stored.bookFailStressEnabled !== false;
}
function bookFailStressAmount() {
  let stored = {};
  try { stored = game.settings?.get?.(MODULE_ID, "stressConfig") ?? {}; }
  catch (_) { stored = {}; }
  const n = Number(stored.bookFailStressAmount);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

/* Language subsystem config (Book System menu): a master enable toggle and
 * the skill-gap penalty ratio ("−1 Education per N ranks short"). Disabled =
 * no language gate, no penalty, no flavour anywhere. */
function getBookLangCfg() {
  let stored = {};
  try { stored = game.settings?.get?.(MODULE_ID, "bookSystemConfig") ?? {}; }
  catch (_) { stored = {}; }
  return {
    enabled:  stored.languageEnabled !== false,
    perRanks: Math.max(1, Number(stored.languagePenaltyPerRanks) || 2)
  };
}

/* The three Elder Speech dialects are mutually intelligible at a −4 rank cost:
 * a reader lacking the exact dialect a book needs can fall back on another. */
const ELDER_SPEECH_VARIANTS = ["eldersp", "elderspskellige", "nilfgaardian"];
const ELDER_SPEECH_CROSS_PENALTY = 2;

/* Reader's EFFECTIVE rank in a book's language (all INT skills). A direct rank
 * wins; for an Elder Speech dialect the reader has NO ranks in, the best other
 * dialect they know substitutes at −4 (floored at 0). The book's own shortfall
 * penalty then applies on top of the reduced rank. */
function readerLanguageRank(actor, skillId) {
  const rankIn = (id) => {
    const s = actor?.system?.skills?.int?.[id];
    return Number(s?.modifiedValue ?? s?.value ?? 0);
  };
  const direct = rankIn(skillId);
  if (direct > 0 || !ELDER_SPEECH_VARIANTS.includes(skillId)) return direct;
  const best = Math.max(0, ...ELDER_SPEECH_VARIANTS.filter(id => id !== skillId).map(rankIn));
  return best > 0 ? Math.max(0, best - ELDER_SPEECH_CROSS_PENALTY) : 0;
}

/**
 * Evaluate a book's language requirement against a reader.
 * Returns { skillId, requiredRank, readerRank, blocked, penalty, langLabel }:
 *   blocked  — book has a language but the reader has zero ranks in it
 *              ("written in a language you cannot read").
 *   penalty  — −1 Education per 2 ranks short of the required rank (≥0). Only
 *              meaningful for check-based books; novels ignore it.
 * A book with no language set is language-agnostic (blocked=false, penalty=0).
 */
function evalBookLanguage(actor, cfg) {
  const none = { skillId: "", requiredRank: 0, readerRank: 0, blocked: false, penalty: 0, langLabel: "" };
  const { enabled, perRanks } = getBookLangCfg();
  if (!enabled) return none;                        // language subsystem off
  const lang = cfg?.language ?? {};
  const skillId = String(lang.skillId ?? "");
  if (!skillId || !LANGUAGE_SKILLS.includes(skillId)) return none;
  const requiredRank = Math.max(0, Number(lang.requiredRank) || 0);
  const readerRank   = readerLanguageRank(actor, skillId);
  const shortfall    = Math.max(0, requiredRank - readerRank);
  return {
    skillId, requiredRank, readerRank,
    blocked: readerRank <= 0,
    penalty: Math.floor(shortfall / perRanks),      // −1 Education per `perRanks` ranks short
    langLabel: localizeSkill(skillId)
  };
}

const DC_OPTIONS = () => [
  { value: 10, label: t("WITCHER.Sheet.ValuableStudy.Dialog.Button.EasyDC10", "Easy (DC 10)") },
  { value: 12, label: t("WITCHER.Sheet.ValuableStudy.Dialog.Button.AverageDC12", "Average (DC 12)") },
  { value: 15, label: t("WITCHER.Sheet.ValuableStudy.Dialog.Button.DifficultDC15", "Difficult (DC 15)") },
  { value: 18, label: t("WITCHER.Sheet.ValuableStudy.Dialog.Button.HardDC18", "Hard (DC 18)") },
  { value: 20, label: t("WITCHER.Sheet.ValuableStudy.Dialog.Button.VeryHardDC20", "Very Hard (DC 20)") },
  { value: 22, label: t("WITCHER.Sheet.ValuableStudy.Dialog.Button.ExtremeDC22", "Extreme (DC 22)") }
];

const TRACK_OPTIONS = () => [
  { id: "common",   label: t("WITCHER.Sheet.ValuableStudy.Dialog.Button.CommonKnowledge", "Common Knowledge") },
  { id: "academic", label: t("WITCHER.Sheet.ValuableStudy.Dialog.Button.AcademicKnowledge", "Academic Knowledge") },
  { id: "monster",  label: t("WITCHER.Sheet.ValuableStudy.Dialog.Button.WitcherKnowledgeMonsterLore", "Witcher Knowledge (Monster Lore)") }
];

// stat+id pairs mirror SKILL_MAP in config.mjs. The i18n label key is always
// `WITCHER.skills.<id>.label` (raw skill key) — derived via skillLabelKey() at
// use sites rather than stored here, so it can never drift from the id.
const SKILL_LIST = [
  { stat: "int",  id: "awareness" },
  { stat: "int",  id: "business" },
  { stat: "int",  id: "deduction" },
  { stat: "int",  id: "education" },
  { stat: "int",  id: "commonspeech" },
  { stat: "int",  id: "eldersp" },
  { stat: "int",  id: "elderspskellige" },
  { stat: "int",  id: "dwarven" },
  { stat: "int",  id: "nilfgaardian" },
  { stat: "int",  id: "monster" },
  { stat: "int",  id: "socialetq" },
  { stat: "int",  id: "streetwise" },
  { stat: "int",  id: "tactics" },
  { stat: "int",  id: "teaching" },
  { stat: "int",  id: "wilderness" },
  { stat: "ref",  id: "brawling" },
  { stat: "ref",  id: "dodge" },
  { stat: "ref",  id: "melee" },
  { stat: "ref",  id: "riding" },
  { stat: "ref",  id: "sailing" },
  { stat: "ref",  id: "smallblades" },
  { stat: "ref",  id: "staffspear" },
  { stat: "ref",  id: "swordsmanship" },
  { stat: "dex",  id: "archery" },
  { stat: "dex",  id: "athletics" },
  { stat: "dex",  id: "crossbow" },
  { stat: "dex",  id: "sleight" },
  { stat: "dex",  id: "stealth" },
  { stat: "body", id: "physique" },
  { stat: "body", id: "endurance" },
  { stat: "emp",  id: "charisma" },
  { stat: "emp",  id: "deceit" },
  { stat: "emp",  id: "finearts" },
  { stat: "emp",  id: "gambling" },
  { stat: "emp",  id: "grooming" },
  { stat: "emp",  id: "perception" },
  { stat: "emp",  id: "leadership" },
  { stat: "emp",  id: "persuasion" },
  { stat: "emp",  id: "performance" },
  { stat: "emp",  id: "seduction" },
  { stat: "will", id: "courage" },
  { stat: "will", id: "hexweave" },
  { stat: "will", id: "intimidation" },
  { stat: "will", id: "spellcast" },
  { stat: "will", id: "resistmagic" },
  { stat: "will", id: "resistcoerc" },
  { stat: "will", id: "ritcraft" },
  { stat: "cra",  id: "alchemy" },
  { stat: "cra",  id: "crafting" },
  { stat: "cra",  id: "disguise" },
  { stat: "cra",  id: "firstaid" },
  { stat: "cra",  id: "forgery" },
  { stat: "cra",  id: "picklock" },
  { stat: "cra",  id: "trapcraft" },
];

const skillLabelKey = (id) => `WITCHER.skills.${id}.label`;
const localizeSkill = (id) => game.i18n?.localize(skillLabelKey(id)) || id;

const STAT_LABEL = { int: "INT", ref: "REF", dex: "DEX", body: "BOD", emp: "EMP", will: "WIL", cra: "CRA" };

const MONSTER_CATEGORIES = [
  "Humanoid", "Necrophage", "Specter", "Beast", "CursedOne", "Hybrid",
  "Insectoid", "Elementa", "Relict", "Ogroid", "Draconid", "Vampire"
];
const DIFFICULTY_ORDER = ["easy", "medium", "hard", "exceptional"];
const DIFFICULTY_LABEL_FALLBACKS = { easy: "Easy", medium: "Medium", hard: "Hard", exceptional: "Exceptional" };
const DIFFICULTY_LABEL = new Proxy(DIFFICULTY_LABEL_FALLBACKS, {
  get(target, prop) {
    if (!(prop in target)) return undefined;
    return t(`WITCHER.Sheet.ValuableStudy.Difficulty.${String(prop)}`, target[prop]);
  }
});
const monsterCategoryLabel = (cat) => t(`WITCHER.Sheet.ValuableStudy.MonsterCategory.${cat}`, cat);

/* =========================================================================
   PUBLIC HELPERS
   ========================================================================= */

/* A "book" item is either the first-class `book` document type (Phase 1
 * promotion — see data/item/book.mjs) OR the legacy valuable subtype that
 * predates the promotion (`valuable + system.type === "book"`). The
 * migration in migrateLegacyFlags.mjs rewrites legacy items to the new
 * type; in the meantime, both paths classify as books here so the chrome
 * study UI, context menus, and inventory filters keep working uniformly. */
export function isBookItem(item) {
  if (!item) return false;
  if (item.type === "book") return true;
  return item.type === "valuable"
      && String(item?.system?.type ?? "").toLowerCase() === BOOK_TYPE_SLUG;
}

export function getBookConfig(item) {
  if (!item) return null;
  // Canonical: system.bookConfig (always present on the data model, with a
  // default bookType). Merge over defaults so downstream readers can assume
  // every sub-key exists.
  const sys = item.system?.bookConfig;
  if (sys && sys.bookType) return mergeBookConfig(sys);
  // Legacy fallbacks for dev worlds that predate the system-field unification.
  const fresh = item.flags?.[MODULE_ID]?.[BOOK_FLAG] ?? item.flags?.[LEGACY_ID]?.[BOOK_FLAG];
  if (fresh) return mergeBookConfig(fresh);
  // Migrate legacy bestiaryBook flag → bookConfig monster type
  const old = item.flags?.[MODULE_ID]?.[LEGACY_BOOK_FLAG] ?? item.flags?.[LEGACY_ID]?.[LEGACY_BOOK_FLAG];
  if (old?.enabled) {
    const cfg = defaultBookConfig();
    cfg.bookType = BOOK_TYPES.MONSTER;
    cfg.monster.mode         = old.mode         ?? "specific";
    cfg.monster.specificKey  = old.specificKey  ?? "";
    cfg.monster.listKeys     = old.listKeys     ?? [];
    cfg.monster.filter       = { ...defaultMonsterFilter(), ...(old.filter ?? {}) };
    cfg.monster.dc                       = old.dc ?? STUDY_DC;
    cfg.monster.totalReadings            = 5;
    cfg.monster.rpPerReading             = 1;
    cfg.monster.commonKnowledgeReading = 0;
    cfg.monster.secondKnowledgeReading = 0;
    return cfg;
  }
  return null;
}

/** True for monster/skill books that are configured and ready for study. */
export function isStudyBook(item) {
  if (!isBookItem(item)) return false;
  const t = getBookConfig(item)?.bookType;
  return t === BOOK_TYPES.MONSTER || t === BOOK_TYPES.SKILL;
}

/** True for stress books that are configured and ready to read. */
export function isReadableBook(item) {
  return isBookItem(item) && getBookConfig(item)?.bookType === BOOK_TYPES.STRESS;
}

/** True for any configured interactive book. */
export function isInteractiveBook(item) {
  return isStudyBook(item) || isReadableBook(item);
}

/* =========================================================================
   USAGE (cooldown + progress)
   ========================================================================= */

function currentInGameDay() {
  const { studySeconds } = getBookTimings();
  const wt = Number(game.time?.worldTime) || 0;
  // studySeconds === 0 → no cooldown: bucket by raw worldTime so any forward
  // tick clears the once-per-session gate.
  return studySeconds > 0 ? Math.floor(wt / studySeconds) : wt;
}

function getBookUsage(actor, itemUuid) {
  const map = actor?.flags?.[MODULE_ID]?.[USAGE_FLAG] ?? {};
  return { lastAttemptDay: -Infinity, hits: 0, readingCount: 0, currentStep: 0, completed: false, lastReadTime: 0, ...(map[encKey(itemUuid)] ?? {}) };
}

/* In-world seconds between two successive stress-book (novel/lore) steps —
 * one chapter per sitting so a reader can't blitz the whole book. Now
 * GM-configurable (Book System menu → novelStepCooldownHours); read live. */
function novelStepCooldownSeconds() {
  return getBookTimings().novelSeconds;
}

async function setBookUsage(actor, itemUuid, patch) {
  if (!actor || !itemUuid) return;
  const map = { ...(actor.flags?.[MODULE_ID]?.[USAGE_FLAG] ?? {}) };
  const k = encKey(itemUuid);
  map[k] = { ...(map[k] ?? {}), ...patch };
  await actor.setFlag(MODULE_ID, USAGE_FLAG, map);
}

/* =========================================================================
   STRESS INTEGRATION
   ========================================================================= */

async function applyStress(actor, amount) {
  if (!actor || !amount) return;
  if (!game.system?.api?.homebrew?.isEnabled?.("stress")) return;
  const cur  = Number(actor.system?.stress ?? 0);
  const next = Math.max(0, cur + amount);
  try { await actor.update({ "system.stress": next }); }
  catch (err) { console.warn(`[${MODULE_ID}] could not apply stress`, err); }
}

/* =========================================================================
   CHAT MESSAGES
   ========================================================================= */

async function postBookChatMessage(actor, item, { title, detail, kind, excerpt }) {
  const tint = {
    success:   "rgba(110,138,74,0.35)",
    exhausted: "rgba(184,148,100,0.35)",
    failed:    "rgba(176,74,60,0.35)",
    read:      "rgba(90,120,180,0.25)"
  }[kind] ?? "rgba(184,148,100,0.35)";

  const excerptHtml = excerpt
    ? `<div style="margin-top:8px;padding:8px 10px;background:rgba(0,0,0,0.25);border-left:2px solid rgba(184,148,100,0.40);font-style:italic;font-size:0.75rem;line-height:1.6;white-space:pre-wrap;">${escapeText(excerpt)}</div>`
    : "";

  /* Reading is a private act. Whisper the log to the actor's owners
   * (typically the player playing this PC) plus any GM. Other players
   * shouldn't see what someone else is reading. Falls back to a public
   * message only if the actor has no discoverable owner (edge case). */
  const whisper = collectBookAudience(actor);

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    whisper: whisper.length ? whisper : undefined,
    content: `
      <div style="border:1px dashed ${tint};padding:8px;background:rgba(0,0,0,0.15);">
        <div style="font-family:var(--wdm-font-display,serif);font-size:0.8125rem;letter-spacing:0.12em;text-transform:uppercase;color:var(--wdm-amber-bright,#d6a55a);margin-bottom:4px;">${escapeText(title)}</div>
        <div style="font-size:0.75rem;line-height:1.5;white-space:pre-wrap;">${escapeText(detail)}</div>
        ${excerptHtml}
      </div>`
  });
}

/* Audience for a book-reading chat message: every user who OWNS the
 * reading actor (usually the assigned player), plus all active GMs.
 * De-duplicated. Empty return means "broadcast" — caller falls through
 * to a public message so an unowned actor's reading doesn't vanish. */
function collectBookAudience(actor) {
  const ids = new Set();
  const users = game.users?.contents ?? [];
  for (const u of users) {
    if (u.isGM) { ids.add(u.id); continue; }
    /* OWNER = 3 in Foundry's permission table; testUserPermission is the
     * canonical accessor and handles the "default" ownership fallback. */
    if (actor?.testUserPermission?.(u, "OWNER")) ids.add(u.id);
  }
  return [...ids];
}

/* =========================================================================
   MONSTER BOOK
   ========================================================================= */

async function studyMonsterBook(item, studyActor, cfg) {
  const mc = cfg.monster ?? {};
  const totalReadings            = Math.max(1, Number(mc.totalReadings ?? 5));
  const rpPerReading             = Math.max(0, Number(mc.rpPerReading ?? 1));
  const commonKnowledgeReading = Number(mc.commonKnowledgeReading ?? 0);
  const secondKnowledgeReading = Number(mc.secondKnowledgeReading ?? 0);

  // Load + filter bestiary entries; hydrate docs for filter mode.
  const entries = await loadEntries().catch(() => []);
  if (mc.mode === "filter") {
    for (const e of entries) {
      if (!e.doc && e.uuid) {
        try { e.doc = await fromUuid(e.uuid); } catch { /* skip */ }
      }
    }
  }
  const matching = entries.filter(e => entryMatchesBook(e, mc));

  if (!matching.length) {
    ui.notifications?.warn(tFormat("WITCHER.Notify.Study.NoMatches", { item: item.name }, "\"{item}\" matches no bestiary entries — check the book's configuration."));
    return;
  }

  const usage        = getBookUsage(studyActor, item.uuid);
  const readingCount = Number(usage.readingCount ?? 0);

  if (readingCount >= totalReadings) {
    ui.notifications?.info(tFormat("WITCHER.Notify.Study.NothingMore", { item: item.name }, "There's nothing more you can learn from \"{item}\"."));
    return;
  }

  const today = currentInGameDay();
  if (usage.lastAttemptDay >= today) {
    ui.notifications?.info(t("WITCHER.Notify.Study.TooSoon", "You've already studied this book recently — wait a few hours before returning to it."));
    return;
  }

  const dc       = validDc(mc.dc);
  const intVal   = Number(studyActor.system?.stats?.int?.value ?? 0);
  const skillObj = studyActor.system?.skills?.int?.[STUDY_SKILL];
  const skillVal = Number(skillObj?.modifiedValue ?? skillObj?.value ?? 0);
  const lang     = evalBookLanguage(studyActor, cfg);
  const roll     = await new Roll(`1d10 + ${intVal} + ${skillVal}${lang.penalty ? ` - ${lang.penalty}` : ""}`).evaluate();
  const pass     = roll.total >= dc;

  let flavor = tFormat(
    "WITCHER.Sheet.ValuableStudy.Chat.Flavor",
    {
      item:      escapeText(item.name),
      skill:     t("WITCHER.Sheet.ValuableStudy.Text.SkillEducation", STUDY_SKILL_LABEL),
      dc,
      color:     pass ? "#6e8a4a" : "#a25050",
      outcome:   pass ? t("WITCHER.Sheet.ValuableStudy.Text.Recalled", "RECALLED")
                      : t("WITCHER.Sheet.ValuableStudy.Text.Failed",   "FAILED")
    },
    "<strong>Studying {item}</strong> · <em>{skill}</em> vs DC {dc} — <strong style=\"color:{color}\">{outcome}</strong>"
  );
  if (lang.penalty) flavor += tFormat("WITCHER.Sheet.ValuableStudy.Chat.LangPenalty", { penalty: lang.penalty, lang: escapeText(lang.langLabel) }, " · <span style=\"color:#a25050\">−{penalty} unfamiliar {lang}</span>");
  try { await roll.toMessage({ flavor, speaker: ChatMessage.getSpeaker({ actor: studyActor }) }); }
  catch (err) { console.warn(`[${MODULE_ID}] book roll toMessage failed`, err); }

  if (!pass) {
    await setBookUsage(studyActor, item.uuid, { lastAttemptDay: today });
    const amt = bookFailStressAmount();
    const stressOn = bookFailStressEnabled() && amt > 0 && !!game.system?.api?.homebrew?.isEnabled?.("stress");
    if (stressOn) await applyStress(studyActor, amt);
    const base = t("WITCHER.Chrome.ValuableStudy.Text.BookFail", "The words blur before your eyes. You set it down for today.");
    await postBookChatMessage(studyActor, item, {
      title:  t("WITCHER.Dialog.Study.Failed", "Study Failed"),
      detail: stressOn ? `${base} ${tFormat("WITCHER.Chrome.ValuableStudy.Text.PlusNStress", { amt }, "+{amt} STRESS.")}` : base,
      kind: "failed"
    });
    return;
  }

  const newReadingCount = readingCount + 1;
  await setBookUsage(studyActor, item.uuid, { lastAttemptDay: today, readingCount: newReadingCount });

  // Grant RP to all non-maxed matched entries.
  const affected = [];
  for (const entry of matching) {
    const state = getActorEntryState(studyActor, entry.key);
    if (state.research < MAX_RESEARCH) {
      if (rpPerReading > 0) await grantRpToEntry(studyActor, entry.key, rpPerReading);
      affected.push(entry.name);
    }
  }

  // Knowledge milestone unlocks (fire exactly on the configured reading
  // number). The first milestone reveals the monster's first knowledge tier;
  // the second milestone reveals the rest. Tiers are system.knowledge[] rows,
  // unlocked by array index.
  const unlockFirst = commonKnowledgeReading > 0 && newReadingCount === commonKnowledgeReading;
  const unlockRest  = secondKnowledgeReading > 0 && newReadingCount === secondKnowledgeReading;
  let anyUnlocked = false;
  if (unlockFirst || unlockRest) {
    for (const entry of matching) {
      let entryDoc = entry.doc;
      if (!entryDoc && entry.uuid) {
        try { entryDoc = await fromUuid(entry.uuid); } catch { /* skip */ }
      }
      const tiers = Array.isArray(entryDoc?.system?.knowledge) ? entryDoc.system.knowledge : [];
      // Only tiers the monster actually has content for (non-empty text).
      // `shown` is ignored — it defaults false on freshly-added rows and would
      // hide every tier; visibility is driven by text presence + reveal state.
      const presentIdx = tiers
        .map((t, idx) => ({ t, idx }))
        .filter(({ t }) => String(t?.text ?? "").trim())
        .map(({ idx }) => idx);
      if (!presentIdx.length) continue;

      const toUnlock = [];
      if (unlockFirst) toUnlock.push(presentIdx[0]);
      if (unlockRest)  toUnlock.push(...presentIdx.slice(1));
      const uniq = [...new Set(toUnlock)];
      if (!uniq.length) continue;

      await grantKnowledgeViaBook(studyActor, entry.key, uniq);
      anyUnlocked = true;

      // If every tier this monster has is now revealed, promote research to ≥ 3.
      const state = getActorEntryState(studyActor, entry.key);
      const allRevealed = presentIdx.every(idx => state.knowledge?.[String(idx)]?.revealed);
      if (allRevealed && (state.research ?? 0) < 3) {
        await updateActorEntryState(studyActor, entry.key, { research: 3 });
      }
    }
  }

  const parts = [];
  if (affected.length && rpPerReading > 0) parts.push(tFormat("WITCHER.Sheet.ValuableStudy.Text.PlusRPPerReading", { rp: rpPerReading }, `+${rpPerReading} RP`));
  if (anyUnlocked)                         parts.push(t("WITCHER.Sheet.ValuableStudy.Text.KnowledgeRevealed", "knowledge revealed"));
  const payout = parts.join(" · ") || t("WITCHER.Sheet.ValuableStudy.Text.KnowledgeGained", "knowledge gained");

  const isLastPage = newReadingCount >= totalReadings;
  if (isLastPage) {
    await postBookChatMessage(studyActor, item, {
      title:  t("WITCHER.Dialog.Study.LastPage", "The Last Page"),
      detail: `You've read "${item.name}" front to back — ${payout}${affected.length ? ` on ${affected.join(", ")}` : ""}.`,
      kind:   "exhausted"
    });
  } else {
    await postBookChatMessage(studyActor, item, {
      title:  t("WITCHER.Dialog.Study.Session", "Study Session"),
      detail: `${payout}${affected.length ? ` — ${affected.join(", ")}` : ""}. Reading ${newReadingCount}/${totalReadings}.`,
      kind:   "success"
    });
  }
}

/* =========================================================================
   SKILL BOOK
   ========================================================================= */

async function studySkillBook(item, studyActor, cfg) {
  const sc = cfg.skill ?? {};
  const { skillStat, skillId, rangeMin = 0, rangeMax = 1 } = sc;

  if (!skillStat || !skillId) {
    ui.notifications?.warn(tFormat("WITCHER.Notify.Study.NoSkill", { item: item.name }, "\"{item}\" is not fully configured — no skill selected."));
    return;
  }

  const skillData     = studyActor.system?.skills?.[skillStat]?.[skillId];
  const baseRank      = Number(skillData?.value ?? 0);
  const effectiveRank = Number(skillData?.modifiedValue ?? baseRank);

  if (effectiveRank < rangeMin) {
    ui.notifications?.info(tFormat("WITCHER.Notify.Study.RankTooLow", { item: item.name, min: rangeMin }, "Your rank is too low for \"{item}\" — it requires at least rank {min}."));
    return;
  }
  if (effectiveRank >= rangeMax) {
    ui.notifications?.info(tFormat("WITCHER.Notify.Study.NothingMore", { item: item.name }, "There's nothing more you can learn from \"{item}\"."));
    return;
  }

  const usage = getBookUsage(studyActor, item.uuid);
  const today = currentInGameDay();
  if (usage.lastAttemptDay >= today) {
    ui.notifications?.info(t("WITCHER.Notify.Study.TooSoon", "You've already studied this book recently — wait a few hours before returning to it."));
    return;
  }

  const dc       = validDc(sc.dc);
  const intVal   = Number(studyActor.system?.stats?.int?.value ?? 0);
  const skillObj = studyActor.system?.skills?.int?.[STUDY_SKILL];
  const skillVal = Number(skillObj?.modifiedValue ?? skillObj?.value ?? 0);
  const lang     = evalBookLanguage(studyActor, cfg);
  const roll     = await new Roll(`1d10 + ${intVal} + ${skillVal}${lang.penalty ? ` - ${lang.penalty}` : ""}`).evaluate();
  const pass     = roll.total >= dc;

  const skillDef  = SKILL_LIST.find(s => s.stat === skillStat && s.id === skillId);
  const skillName = skillDef ? localizeSkill(skillId) : skillId;

  let flavor = tFormat(
    "WITCHER.Sheet.ValuableStudy.Chat.Flavor",
    {
      item:      escapeText(item.name),
      skill:     t("WITCHER.Sheet.ValuableStudy.Text.SkillEducation", STUDY_SKILL_LABEL),
      dc,
      color:     pass ? "#6e8a4a" : "#a25050",
      outcome:   pass ? t("WITCHER.Sheet.ValuableStudy.Text.Recalled", "RECALLED")
                      : t("WITCHER.Sheet.ValuableStudy.Text.Failed",   "FAILED")
    },
    "<strong>Studying {item}</strong> · <em>{skill}</em> vs DC {dc} — <strong style=\"color:{color}\">{outcome}</strong>"
  );
  if (lang.penalty) flavor += tFormat("WITCHER.Sheet.ValuableStudy.Chat.LangPenalty", { penalty: lang.penalty, lang: escapeText(lang.langLabel) }, " · <span style=\"color:#a25050\">−{penalty} unfamiliar {lang}</span>");
  try { await roll.toMessage({ flavor, speaker: ChatMessage.getSpeaker({ actor: studyActor }) }); }
  catch (err) { console.warn(`[${MODULE_ID}] book roll toMessage failed`, err); }

  if (!pass) {
    await setBookUsage(studyActor, item.uuid, { lastAttemptDay: today });
    const amt = bookFailStressAmount();
    const stressOn = bookFailStressEnabled() && amt > 0 && !!game.system?.api?.homebrew?.isEnabled?.("stress");
    if (stressOn) await applyStress(studyActor, amt);
    const base = t("WITCHER.Chrome.ValuableStudy.Text.ManualFail", "The concepts won't stick right now. Give it a few hours.");
    await postBookChatMessage(studyActor, item, {
      title:  t("WITCHER.Dialog.Study.Failed", "Study Failed"),
      detail: stressOn ? `${tFormat("WITCHER.Chrome.ValuableStudy.Text.PlusNStress", { amt }, "+{amt} STRESS.")} ${base}` : base,
      kind: "failed"
    });
    return;
  }

  const newHits      = (usage.hits ?? 0) + 1;
  const hitsIntoRank = newHits % HITS_PER_RANK;

  await setBookUsage(studyActor, item.uuid, { lastAttemptDay: today, hits: newHits });

  if (hitsIntoRank === 0) {
    const newRank = baseRank + 1;
    await studyActor.update({ [`system.skills.${skillStat}.${skillId}.value`]: newRank });
    if (newRank >= rangeMax) {
      await postBookChatMessage(studyActor, item, {
        title:  t("WITCHER.Dialog.Study.Mastery", "Mastery Achieved"),
        detail: `You've learned all this tome can teach. ${skillName} is now rank ${newRank}.`,
        kind:   "exhausted"
      });
    } else {
      await postBookChatMessage(studyActor, item, {
        title:  t("WITCHER.Dialog.Study.RankUp", "Rank Advanced!"),
        detail: tFormat("WITCHER.Chrome.ValuableStudy.Text.NowRankContinue", { skill: skillName, rank: newRank, next: newRank + 1 }, `${skillName} is now rank ${newRank}. Continue studying for rank ${newRank + 1}.`),
        kind:   "success"
      });
    }
  } else {
    const hitsLeft = HITS_PER_RANK - hitsIntoRank;
    await postBookChatMessage(studyActor, item, {
      title:  t("WITCHER.Dialog.Study.Session", "Study Session"),
      detail: tFormat("WITCHER.Chrome.ValuableStudy.Text.ProgressTowardRank", { skill: skillName, rank: baseRank + 1, hits: hitsIntoRank, cap: HITS_PER_RANK, left: hitsLeft }, `Progress toward ${skillName} rank ${baseRank + 1}: ${hitsIntoRank}/${HITS_PER_RANK} — ${hitsLeft} more to advance.`),
      kind:   "success"
    });
  }
}

/* =========================================================================
   STRESS BOOK
   ========================================================================= */

async function readStressBook(item, readActor, cfg) {
  const steps = cfg.stress?.steps;
  if (!Array.isArray(steps) || !steps.length) {
    ui.notifications?.warn(tFormat("WITCHER.Notify.Study.NoSteps", { item: item.name }, "\"{item}\" has no reading steps configured."));
    return;
  }

  const usage = getBookUsage(readActor, item.uuid);

  if (usage.completed) {
    ui.notifications?.info(tFormat("WITCHER.Notify.Study.AlreadyDone", { item: item.name }, "You've already finished reading \"{item}\"."));
    return;
  }

  /* 4h step cooldown. Reader can't blitz every chapter of a novel in one
   * sitting — each step needs in-world time to sink in. Skipped for the
   * very first read (lastReadTime === 0). */
  const now  = Number(game.time?.worldTime) || 0;
  const last = Number(usage.lastReadTime) || 0;
  const stepCooldown = novelStepCooldownSeconds();
  if (last > 0 && stepCooldown > 0 && (now - last) < stepCooldown) {
    const remain = stepCooldown - (now - last);
    const hrs    = Math.floor(remain / 3600);
    const mins   = Math.ceil((remain % 3600) / 60);
    const wait   = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
    ui.notifications?.info(tFormat(
      "WITCHER.Notify.Study.NeedRestBeforeNextChapter",
      { item: item.name, wait },
      `You need {wait} before reading the next chapter of "{item}".`
    ));
    return;
  }

  const stepIdx = usage.currentStep ?? 0;
  const step    = steps[stepIdx];
  if (!step) {
    await setBookUsage(readActor, item.uuid, { completed: true });
    ui.notifications?.info(tFormat("WITCHER.Notify.Study.Finished", { item: item.name }, "You've finished reading \"{item}\"."));
    return;
  }

  const newStepIdx = stepIdx + 1;
  const isLast     = newStepIdx >= steps.length;
  await setBookUsage(readActor, item.uuid, { currentStep: newStepIdx, lastReadTime: now, ...(isLast ? { completed: true } : {}) });

  const delta = Number(step.stressChange) || 0;
  await applyStress(readActor, delta);

  const stressNote = delta < 0
    ? tFormat("WITCHER.Chrome.ValuableStudy.Text.StressRelieved", { delta }, `${delta} Stress (relieved)`)
    : delta > 0
    ? tFormat("WITCHER.Chrome.ValuableStudy.Text.StressGained",   { delta }, `+${delta} Stress`)
    : "";

  let title, detail, kind;
  if (isLast) {
    title  = t("WITCHER.Chrome.ValuableStudy.Text.BookFinished", "Book Finished");
    detail = tFormat("WITCHER.Chrome.ValuableStudy.Text.FinalPage", { name: item.name, note: stressNote ? ` (${stressNote})` : "" }, `You read the final page of "${item.name}".${stressNote ? ` (${stressNote})` : ""}`);
    kind   = "exhausted";
  } else {
    title  = tFormat("WITCHER.Chrome.ValuableStudy.Text.ReadingProgress", { current: newStepIdx, total: steps.length }, `Reading — ${newStepIdx} / ${steps.length}`);
    detail = stressNote || t("WITCHER.Chrome.ValuableStudy.Text.ReadOn", "You read on.");
    kind   = "read";
  }

  await postBookChatMessage(readActor, item, { title, detail, kind, excerpt: step.text || undefined });

  /* Lore capture — if this novel is flagged "Save to Lore", copy the chapter
   * into the reader's own Lore journal (one page per book, chapters appended).
   * Lazy import keeps the data flow off the chrome journal module unless a
   * lore book is actually read. Best-effort: a failed capture never blocks
   * the read. */
  if (cfg.stress?.lore && step.text) {
    try {
      const { appendLoreEntry } = await import("../chrome/journal.js");
      await appendLoreEntry(
        readActor,
        item.name,
        `<div style="white-space:pre-wrap;">${escapeText(step.text)}</div>`,
        { chapterLabel: tFormat("WITCHER.Chrome.ValuableStudy.Text.ChapterN", { n: newStepIdx }, `Chapter ${newStepIdx}`) }
      );
    } catch (e) { console.warn(`[${MODULE_ID}] lore capture failed`, e); }
  }
}

/* =========================================================================
   REVIEW (re-read past chapters of a stress book)
   ========================================================================= */

/** True if the viewing actor has read at least one chapter of this stress book. */
export function canReviewBook(item, actor) {
  if (!isReadableBook(item) || !actor) return false;
  const usage = getBookUsage(actor, item.uuid);
  return Number(usage.currentStep ?? 0) > 0 || usage.completed === true;
}

/** True if the viewing actor has fully exhausted this book (any type). */
export function isBookCompleted(item, actor) {
  if (!isBookItem(item) || !actor) return false;
  const cfg = getBookConfig(item);
  if (!cfg?.bookType) return false;

  if (cfg.bookType === BOOK_TYPES.STRESS) {
    return getBookUsage(actor, item.uuid).completed === true;
  }
  if (cfg.bookType === BOOK_TYPES.MONSTER) {
    const totalReadings = Math.max(1, Number(cfg.monster?.totalReadings ?? 5));
    return getBookUsage(actor, item.uuid).readingCount >= totalReadings;
  }
  if (cfg.bookType === BOOK_TYPES.SKILL) {
    const sc = cfg.skill ?? {};
    const rangeMax = Number(sc.rangeMax ?? 1);
    const skillData = actor.system?.skills?.[sc.skillStat]?.[sc.skillId];
    const effectiveRank = Number(skillData?.modifiedValue ?? skillData?.value ?? 0);
    return effectiveRank >= rangeMax;
  }
  return false;
}

/** Reading progress for the viewing actor as a 0–100 percentage.
 *  Returns null when there's no actor or the item isn't a configured book —
 *  callers should hide the progress UI in that case. */
export function getBookProgress(item, actor) {
  if (!isBookItem(item) || !actor) return null;
  const cfg = getBookConfig(item);
  if (!cfg?.bookType) return null;
  const usage = getBookUsage(actor, item.uuid);

  if (cfg.bookType === BOOK_TYPES.STRESS) {
    const total = Math.max(0, (cfg.stress?.steps ?? []).length);
    if (!total) return null;
    const read = usage.completed ? total : Math.min(total, Number(usage.currentStep ?? 0));
    return { percent: Math.round((read / total) * 100), completed: usage.completed === true };
  }
  if (cfg.bookType === BOOK_TYPES.MONSTER) {
    const total = Math.max(1, Number(cfg.monster?.totalReadings ?? 5));
    const read  = Math.min(total, Number(usage.readingCount ?? 0));
    return { percent: Math.round((read / total) * 100), completed: read >= total };
  }
  if (cfg.bookType === BOOK_TYPES.SKILL) {
    const sc = cfg.skill ?? {};
    const rangeMin = Number(sc.rangeMin ?? 0);
    const rangeMax = Math.max(rangeMin + 1, Number(sc.rangeMax ?? 1));
    const skillData = actor.system?.skills?.[sc.skillStat]?.[sc.skillId];
    const rank = Number(skillData?.modifiedValue ?? skillData?.value ?? 0);
    // Whole ranks gained from the floor, plus partial progress within the
    // current rank (HITS_PER_RANK hits = one rank).
    const ranksDone = Math.max(0, Math.min(rangeMax - rangeMin, rank - rangeMin));
    const partial   = (Number(usage.hits ?? 0) % HITS_PER_RANK) / HITS_PER_RANK;
    const span      = rangeMax - rangeMin;
    const raw       = (ranksDone + (ranksDone < span ? partial : 0)) / span;
    return { percent: Math.round(Math.max(0, Math.min(1, raw)) * 100), completed: rank >= rangeMax };
  }
  return null;
}

export async function reviewStressBookChapters(itemOrUuid) {
  const item = (typeof itemOrUuid === "string") ? await fromUuid(itemOrUuid) : itemOrUuid;
  if (!item || !isReadableBook(item)) { ui.notifications?.warn(t("WITCHER.Notify.Study.NotReadable", "Not a readable book.")); return; }
  const actor = (item.parent?.type === "character") ? item.parent : game.user?.character;
  if (!actor) { ui.notifications?.warn(t("WITCHER.Notify.Study.NoReviewer", "No character to review with.")); return; }

  const cfg   = getBookConfig(item);
  const steps = cfg?.stress?.steps ?? [];
  const usage = getBookUsage(actor, item.uuid);
  const readCount = usage.completed ? steps.length : Math.min(steps.length, Number(usage.currentStep ?? 0));

  if (readCount <= 0) {
    ui.notifications?.info(tFormat("WITCHER.Notify.Study.NoneRead", { item: item.name }, "You haven't read any of \"{item}\" yet."));
    return;
  }

  const rows = steps.slice(0, readCount).map((s, i) => `
    <details class="wou-book-review-row" ${i === readCount - 1 ? "open" : ""}>
      <summary>Chapter ${i + 1} of ${steps.length}</summary>
      <div class="wou-book-review-text">${escapeText(s.text ?? "")}</div>
    </details>`).join("");

  const DialogV2 = foundry.applications.api.DialogV2;
  await DialogV2.prompt({
    window:  { title: tFormat("WITCHER.Dialog.Study.Reviewing", { item: item.name }, "Reviewing — {item}"), icon: "fa-solid fa-book-bookmark" },
    classes: ["wou-book-review-dialog"],
    position: { width: 520 },
    content: `<div class="wou-book-review">${rows}</div>`,
    ok: { label: t("WITCHER.Common.Close", "Close") },
    rejectClose: false
  });
}

/* =========================================================================
   ENTRY POINT
   ========================================================================= */

export async function interactWithBook(itemOrUuid) {
  const item = (typeof itemOrUuid === "string") ? await fromUuid(itemOrUuid) : itemOrUuid;
  if (!item || !isBookItem(item)) { ui.notifications?.warn(t("WITCHER.Notify.Study.NotBook", "Not a book item.")); return; }

  const cfg = getBookConfig(item);
  if (!cfg?.bookType) {
    ui.notifications?.warn(tFormat("WITCHER.Notify.Study.NotConfigured", { item: item.name }, "\"{item}\" is not configured. Right-click the item sheet's book icon to set it up."));
    return;
  }

  const actor = (item.parent?.type === "character") ? item.parent : game.user?.character;
  if (!actor) { ui.notifications?.warn(t("WITCHER.Notify.Study.NoReader", "No character to read with.")); return; }
  if (!actor.testUserPermission?.(game.user, "OWNER") && !game.user?.isGM) {
    ui.notifications?.warn(t("WITCHER.Notify.Study.NotOwner", "You don't own this character.")); return;
  }

  /* Language gate (all book types): a book written in a language the reader
   * has zero ranks in simply can't be read. Ranks below the required rank are
   * allowed but incur an Education penalty on check-based books (applied in
   * studyMonsterBook / studySkillBook); novels are exempt from the penalty. */
  const lang = evalBookLanguage(actor, cfg);
  if (lang.blocked) {
    ui.notifications?.warn(tFormat("WITCHER.Notify.Study.LanguageUnreadable", { item: item.name, lang: lang.langLabel }, "This book is written in a language you cannot read."));
    return;
  }

  if (cfg.bookType === BOOK_TYPES.MONSTER) return studyMonsterBook(item, actor, cfg);
  if (cfg.bookType === BOOK_TYPES.SKILL)   return studySkillBook(item, actor, cfg);
  if (cfg.bookType === BOOK_TYPES.STRESS)  return readStressBook(item, actor, cfg);
}

/* =========================================================================
   FILTER HELPERS (monster mode)
   ========================================================================= */

function entryMatchesBook(entry, mc) {
  if (!mc) return false;
  if (mc.mode === "specific") return entry.key === mc.specificKey;
  if (mc.mode === "list")     return Array.isArray(mc.listKeys) && mc.listKeys.includes(entry.key);
  if (mc.mode !== "filter")   return false;

  const f = mc.filter ?? {};
  if (f.category && entry.type !== f.category) return false;

  const sys = entry?.doc?.system;
  if (!sys) return false;

  if (f.difficultyOp && f.difficultyOp !== "any" && f.difficultyValue) {
    const target = DIFFICULTY_ORDER.indexOf(String(f.difficultyValue).toLowerCase());
    const actual = DIFFICULTY_ORDER.indexOf(String(sys.threat?.difficulty ?? "").toLowerCase());
    if (target >= 0) {
      if (actual < 0) return false;
      if (f.difficultyOp === "max"   && actual > target)   return false;
      if (f.difficultyOp === "exact" && actual !== target) return false;
    }
  }

  if (f.environment) {
    if (!String(sys.descriptors?.environment ?? "").toLowerCase().includes(String(f.environment).toLowerCase())) return false;
  }
  return true;
}

/* =========================================================================
   SHEET HOOK — completion badge only
   The bespoke valuable sheet (templates/item/valuable.hbs + WitcherValuableSheet)
   owns the subtype select and the "Configure Book" control now; this hook only
   decorates a finished book's portrait.
   ========================================================================= */

Hooks.on("renderWitcherValuableSheet", (app, _html, _ctx, _opts) => {
  const root = app?.element;
  const item = app?.item;
  if (!root || !item || !isBookItem(item)) return;
  applyCompletionBadgeToSheet(root, item);
});

function viewerForBookCompletion(item) {
  if (item?.parent?.type === "character") return item.parent;
  return game.user?.character ?? null;
}

function applyCompletionBadgeToSheet(root, item) {
  const viewer = viewerForBookCompletion(item);
  if (!viewer || !isBookCompleted(item, viewer)) return;
  const img = root.querySelector(".wdm-w3-portrait img, .wdm-cfg-portrait img, .wdm-w3-portrait, .wdm-cfg-portrait");
  if (!img) return;
  img.classList.add("wou-book-completed-img");
  const target = img.parentElement;
  if (!target || target.querySelector(".wou-book-completed-badge")) return;
  const badge = document.createElement("div");
  badge.className = "wou-book-completed-badge";
  badge.innerHTML = `<i class="fa-solid fa-bookmark"></i>`;
  badge.dataset.tooltip = t("WITCHER.Chrome.ValuableStudy.Tip.Finished", "Finished");
  target.appendChild(badge);
}

/* Mark book rows on the character sheet inventory once it renders. */
Hooks.on("renderWitcherCharacterSheet", (app, _html, _ctx, _opts) => {
  const root  = app?.element;
  const actor = app?.actor ?? app?.document;
  if (!root || !actor) return;
  for (const el of root.querySelectorAll("[data-item-id]")) {
    const item = actor.items?.get?.(el.dataset.itemId);
    if (!item || !isBookCompleted(item, actor)) continue;
    const img    = el.querySelector("img");
    const anchor = img?.parentElement ?? el;
    img?.classList.add("wou-book-completed-img");
    if (!anchor.querySelector(".wou-book-completed-badge")) {
      const badge = document.createElement("div");
      badge.className = "wou-book-completed-badge";
      badge.innerHTML = `<i class="fa-solid fa-bookmark"></i>`;
      badge.dataset.tooltip = t("WITCHER.Chrome.ValuableStudy.Tip.Finished", "Finished");
      anchor.appendChild(badge);
    }
  }
});

/* =========================================================================
   CONFIG DEFAULTS
   ========================================================================= */

function defaultMonsterFilter() {
  return { category: "", difficultyOp: "any", difficultyValue: "", environment: "" };
}

function defaultBookConfig() {
  return {
    bookType: BOOK_TYPES.MONSTER,
    monster: {
      mode: "specific", specificKey: "", listKeys: [], filter: defaultMonsterFilter(),
      dc: STUDY_DC,
      totalReadings: 5, rpPerReading: 1,
      commonKnowledgeReading: 0, secondKnowledgeReading: 0
    },
    skill:   { skillStat: "int", skillId: "education", rangeMin: 0, rangeMax: 1, dc: STUDY_DC },
    stress:  { steps: [], lore: false },
    // Language the book is written in + rank needed to read it. Empty skillId
    // = language-agnostic (no gate, no penalty). Required rank ranges 1–10.
    language: { skillId: "", requiredRank: 1 }
  };
}

/** Merge a stored book config (system.bookConfig or a legacy flag) over the
 *  defaults so every sub-key (monster/skill/stress/filter) is guaranteed to
 *  exist for downstream readers. */
function mergeBookConfig(stored) {
  const base = defaultBookConfig();
  if (!stored || typeof stored !== "object") return base;
  return {
    bookType: stored.bookType ?? base.bookType,
    monster: {
      ...base.monster,
      ...(stored.monster ?? {}),
      filter: { ...base.monster.filter, ...(stored.monster?.filter ?? {}) }
    },
    skill:  { ...base.skill,  ...(stored.skill ?? {}) },
    stress: {
      steps: Array.isArray(stored.stress?.steps) ? stored.stress.steps.map(s => ({ ...s })) : [],
      lore:  !!stored.stress?.lore
    },
    language: { ...base.language, ...(stored.language ?? {}) }
  };
}

function validDc(raw) {
  const n = Number(raw);
  return DC_OPTIONS().some(o => o.value === n) ? n : STUDY_DC;
}

/* =========================================================================
   CONFIG DIALOG
   ========================================================================= */

export async function openBookConfigDialog(item) {
  const isGM  = game.user?.isGM;
  const cfg   = getBookConfig(item) ?? defaultBookConfig();
  const entries = await loadEntries().catch(() => []);
  const sorted  = entries.slice().sort((a, b) => a.name.localeCompare(b.name));

  const DialogV2 = foundry.applications.api.DialogV2;

  if (!isGM) {
    await DialogV2.prompt({
      window: { title: item.name, icon: "fa-solid fa-book-bookmark" },
      content: `<p style="font-style:italic;padding:8px;">${escapeText(summariseConfig(cfg, sorted))}</p>`,
      ok: { label: t("WITCHER.Common.Close", "Close") },
      rejectClose: false
    });
    return;
  }

  let editSteps = (cfg.stress?.steps ?? []).map(s => ({ ...s }));

  const result = await DialogV2.wait({
    window:  { title: tFormat("WITCHER.Dialog.Study.ConfigureBook", { item: item.name }, "Configure Book — {item}"), icon: "fa-solid fa-book-bookmark" },
    content: buildConfigDialogContent(cfg, sorted),
    classes: ["wou-book-config-dialog-window"],
    position: { width: 560 },
    buttons: [
      {
        action:   "save",
        label:    t("WITCHER.Common.Save", "Save"),
        icon:     "fa-solid fa-check",
        default:  true,
        callback: (_ev, _btn, dialog) => readConfigFromDialog(dialog.element ?? dialog, cfg, editSteps)
      },
      { action: "cancel", label: t("WITCHER.Common.Cancel", "Cancel"), icon: "fa-solid fa-xmark" }
    ],
    render: (_ev, dialog) => wireConfigDialog(dialog.element ?? dialog, editSteps),
    rejectClose: false
  });

  if (!result || typeof result !== "object") return;
  try { await item.update({ "system.bookConfig": result }); }
  catch (err) { console.warn(`${MODULE_ID} | book persist failed`, err); }
}

/* =========================================================================
   DIALOG HTML BUILDERS
   ========================================================================= */

function buildConfigDialogContent(cfg, sorted) {
  // The book's type is chosen on the item sheet (system.bookConfig.bookType).
  // The configure dialog only ever edits THAT type — no tabs, no type switching.
  // NOTE: local was named `t` and shadowed the imported `t()` i18n helper — the
  // META literal below then invoked the string as if it were a function
  // (`TypeError: t is not a function`), which killed the dialog before it
  // could ever render. Renamed to `bookType` to unshadow.
  const bookType = cfg.bookType ?? BOOK_TYPES.MONSTER;

  const META = {
    [BOOK_TYPES.MONSTER]: { icon: "fa-dragon",         label: t("WITCHER.Sheet.ValuableStudy.Dialog.Button.MonsterStudy", "Monster Study") },
    [BOOK_TYPES.SKILL]:   { icon: "fa-graduation-cap", label: t("WITCHER.Sheet.ValuableStudy.Dialog.Button.SkillBook", "Skill Book") },
    [BOOK_TYPES.STRESS]:  { icon: "fa-book-open",       label: t("WITCHER.Sheet.ValuableStudy.Dialog.Button.NovelLore", "Novel / Lore") }
  };
  const meta = META[bookType] ?? META[BOOK_TYPES.MONSTER];

  let pane;
  if (bookType === BOOK_TYPES.SKILL)       pane = buildSkillPane(cfg.skill ?? {});
  else if (bookType === BOOK_TYPES.STRESS) pane = buildStressPane(cfg.stress ?? {});
  else                                     pane = buildMonsterPane(cfg.monster ?? {}, sorted);

  return `
    <div class="wou-book-config" data-book-type="${bookType}">
      <div class="wou-book-config-head">
        <i class="fa-solid ${meta.icon}"></i> <span>${meta.label}</span>
      </div>
      <div class="wou-book-type-pane" data-type-pane="${bookType}">${pane}</div>
      ${buildLanguagePane(cfg.language ?? {}, bookType)}
    </div>`;
}

/* Language section — shared across all book types. Which language the book is
 * written in, and the language-skill rank needed to read it. */
function buildLanguagePane(lang, bookType) {
  const cur = String(lang?.skillId ?? "");
  const req = Math.max(0, Number(lang?.requiredRank) || 0);
  const opts = [
    `<option value="">${t("WITCHER.Sheet.ValuableStudy.Option.NoLanguage", "— None (any reader) —")}</option>`,
    ...LANGUAGE_SKILLS.map(id => `<option value="${id}" ${id === cur ? "selected" : ""}>${escapeText(localizeSkill(id))}</option>`)
  ].join("");
  // Novels are gated (rank 0 can't read) but exempt from the Education penalty.
  const { enabled, perRanks } = getBookLangCfg();
  const hint = !enabled
    ? t("WITCHER.Sheet.ValuableStudy.Hint.LanguageDisabled", "The language subsystem is disabled in the Book System settings — this has no effect until it's re-enabled.")
    : bookType === BOOK_TYPES.STRESS
    ? t("WITCHER.Sheet.ValuableStudy.Hint.LanguageRankNovel", "Rank 0 in this language = can't read it. Novels take no Education penalty for a low rank.")
    : tFormat("WITCHER.Sheet.ValuableStudy.Hint.LanguageRankN", { n: perRanks }, `Rank 0 = can't read it. Below the required rank = −1 Education per {n} ranks short.`);
  return `
    <div class="wou-book-config-head" style="margin-top:12px;">
      <i class="fa-solid fa-language"></i> <span>${t("WITCHER.Sheet.ValuableStudy.Label.Language", "Language")}</span>
    </div>
    <div class="wou-book-row">
      <label>${t("WITCHER.Sheet.ValuableStudy.Label.WrittenIn", "Written in")}</label>
      <select data-book-language>${opts}</select>
    </div>
    <div class="wou-book-row">
      <label>${t("WITCHER.Sheet.ValuableStudy.Label.RequiredRank", "Required Rank")}</label>
      <input type="number" data-book-language-rank min="1" max="10" step="1"
             style="width:72px;text-align:center;" value="${Math.min(10, Math.max(1, req || 1))}"/>
      <span class="wou-book-hint">${hint}</span>
    </div>`;
}

function buildMonsterPane(mc, sorted) {
  const specificOptions = sorted.map(e =>
    `<option value="${escapeAttr(e.key)}" ${e.key === mc.specificKey ? "selected" : ""}>${escapeText(e.name)}</option>`
  ).join("");
  const listOptionsHtml = sorted.map(e =>
    `<label class="wou-book-list-option"><input type="checkbox" data-list-key="${escapeAttr(e.key)}" ${(mc.listKeys ?? []).includes(e.key) ? "checked" : ""}/> ${escapeText(e.name)}</label>`
  ).join("");
  const catOptions = ['<option value="">— Any —</option>',
    ...MONSTER_CATEGORIES.map(c => `<option value="${c}" ${c === mc.filter?.category ? "selected" : ""}>${escapeText(monsterCategoryLabel(c))}</option>`)
  ].join("");
  const diffValueOptions = ['<option value="">— pick —</option>',
    ...DIFFICULTY_ORDER.map(d => `<option value="${d}" ${d === mc.filter?.difficultyValue ? "selected" : ""}>${DIFFICULTY_LABEL[d]}</option>`)
  ].join("");

  return `
    <div class="wou-book-row">
      <label>${t("WITCHER.Sheet.ValuableStudy.Label.Mode", "Mode")}</label>
      <select data-book-mode>
        <option value="specific" ${mc.mode === "specific" ? "selected" : ""}>${t("WITCHER.Sheet.ValuableStudy.Option.SpecificMonster", "Specific monster")}</option>
        <option value="list"     ${mc.mode === "list"     ? "selected" : ""}>${t("WITCHER.Sheet.ValuableStudy.Option.CuratedList", "Curated list")}</option>
        <option value="filter"   ${mc.mode === "filter"   ? "selected" : ""}>${t("WITCHER.Sheet.ValuableStudy.Option.Filter", "Filter")}</option>
      </select>
    </div>
    <div class="wou-book-pane" data-pane="specific" ${(mc.mode ?? "specific") === "specific" ? "" : "hidden"}>
      <label>${t("WITCHER.Sheet.ValuableStudy.Label.Monster", "Monster")}</label>
      <select data-book-specific>
        <option value="">${t("WITCHER.Sheet.ValuableStudy.Option.SelectMonster", "— Select monster —")}</option>
        ${specificOptions}
      </select>
    </div>
    <div class="wou-book-pane" data-pane="list" ${mc.mode === "list" ? "" : "hidden"}>
      <label>${t("WITCHER.Sheet.ValuableStudy.Label.SelectedMonsters", "Selected monsters")}</label>
      <div class="wou-book-list-scroll">${listOptionsHtml}</div>
    </div>
    <div class="wou-book-pane" data-pane="filter" ${mc.mode === "filter" ? "" : "hidden"}>
      <div class="wou-book-row">
        <label>${t("WITCHER.Sheet.ValuableStudy.Label.Category", "Category")}</label>
        <select data-book-filter="category">${catOptions}</select>
      </div>
      <div class="wou-book-row">
        <label>${t("WITCHER.Sheet.ValuableStudy.Label.Difficulty", "Difficulty")}</label>
        <select data-book-filter="difficultyOp">
          <option value="any"   ${(mc.filter?.difficultyOp ?? "any") === "any"   ? "selected" : ""}>${t("WITCHER.Sheet.ValuableStudy.Option.Any", "Any")}</option>
          <option value="max"   ${mc.filter?.difficultyOp === "max"   ? "selected" : ""}>${t("WITCHER.Sheet.ValuableStudy.Option.AtMost", "At most")}</option>
          <option value="exact" ${mc.filter?.difficultyOp === "exact" ? "selected" : ""}>${t("WITCHER.Sheet.ValuableStudy.Option.Exactly", "Exactly")}</option>
        </select>
        <select data-book-filter="difficultyValue" ${(mc.filter?.difficultyOp ?? "any") === "any" ? "disabled" : ""}>
          ${diffValueOptions}
        </select>
      </div>
      <div class="wou-book-row">
        <label>${t("WITCHER.Sheet.ValuableStudy.Label.Environment", "Environment")}</label>
        <input type="text" data-book-filter="environment" value="${escapeAttr(mc.filter?.environment ?? "")}" placeholder="${t("WITCHER.Sheet.ValuableStudy.Text.ForestSwamp", "forest, swamp…")}"/>
      </div>
    </div>
    <div class="wou-book-row">
      <label>${t("WITCHER.Sheet.ValuableStudy.Label.StudyDifficulty", "Study Difficulty")}</label>
      <select data-book-dc data-dc-pane="monster">
        ${DC_OPTIONS().map(o => `<option value="${o.value}" ${validDc(mc.dc) === o.value ? "selected" : ""}>${escapeText(o.label)}</option>`).join("")}
      </select>
      <span class="wou-book-hint">${t("WITCHER.Sheet.ValuableStudy.Hint.EducationCheck", "Education check to extract the lore.")}</span>
    </div>
    <div class="wou-book-row">
      <label>${t("WITCHER.Sheet.ValuableStudy.Label.TotalReadings", "Total Readings")}</label>
      <input type="number" data-book-total-readings min="1" max="99" step="1" value="${Number(mc.totalReadings ?? 5)}"/>
      <span class="wou-book-hint">${t("WITCHER.Sheet.ValuableStudy.Hint.BookExhausts", "Book exhausts after this many successful readings.")}</span>
    </div>
    <div class="wou-book-row">
      <label>${t("WITCHER.Sheet.ValuableStudy.Label.RPPerReading", "RP per Reading")}</label>
      <input type="number" data-book-rp-per-reading min="0" max="20" step="1" value="${Number(mc.rpPerReading ?? 1)}"/>
      <span class="wou-book-hint">${t("WITCHER.Sheet.ValuableStudy.Hint.RPGranted", "Research Points granted to each matched entry on success.")}</span>
    </div>
    <div class="wou-book-row">
      <label>${t("WITCHER.Sheet.ValuableStudy.Label.FirstKnowledgeTierAt", "First Knowledge Tier at")}</label>
      <input type="number" data-book-common-reading min="0" max="99" step="1" value="${Number(mc.commonKnowledgeReading ?? 0)}"/>
      <span class="wou-book-hint">${t("WITCHER.Sheet.ValuableStudy.Hint.FirstTierReading", "Reading # that reveals the monster's first knowledge tier (0 = never).")}</span>
    </div>
    <div class="wou-book-row">
      <label>${t("WITCHER.Sheet.ValuableStudy.Label.RemainingTiersAt", "Remaining Tiers at")}</label>
      <input type="number" data-book-second-reading min="0" max="99" step="1" value="${Number(mc.secondKnowledgeReading ?? 0)}"/>
      <span class="wou-book-hint">${t("WITCHER.Sheet.ValuableStudy.Hint.RemainingTiersReading", "Reading # that reveals the monster's remaining knowledge tiers (0 = never).")}</span>
    </div>`;
}

function buildSkillPane(sc) {
  const statOrder  = ["int", "ref", "dex", "body", "emp", "will", "cra"];
  const skillOptHtml = statOrder.map(stat => {
    const group = SKILL_LIST.filter(s => s.stat === stat);
    if (!group.length) return "";
    const opts = group.map(sk => {
      const label = localizeSkill(sk.id);
      const sel   = (sc.skillStat === sk.stat && sc.skillId === sk.id) ? "selected" : "";
      return `<option value="${sk.stat}|${sk.id}" ${sel}>${escapeText(label)}</option>`;
    }).join("");
    return `<optgroup label="${STAT_LABEL[stat] ?? stat.toUpperCase()}">${opts}</optgroup>`;
  }).join("");

  const rankRange = (lo, hi, sel) =>
    Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)
      .map(v => `<option value="${v}" ${v === sel ? "selected" : ""}>${v}</option>`)
      .join("");

  const fromSel = Number(sc.rangeMin ?? 0);
  const toSel   = Number(sc.rangeMax ?? 1);

  return `
    <div class="wou-book-row">
      <label>${t("WITCHER.Sheet.ValuableStudy.Label.Skill", "Skill")}</label>
      <select data-book-skill-id>${skillOptHtml}</select>
    </div>
    <div class="wou-book-row">
      <label>${t("WITCHER.Sheet.ValuableStudy.Label.RankRange", "Rank Range")}</label>
      <span class="wou-book-range-row">
        <span class="wou-book-hint">${t("WITCHER.Sheet.ValuableStudy.Text.From", "From")}</span>
        <select data-book-range-min class="wou-book-range-sel">${rankRange(0, 2, fromSel)}</select>
        <span class="wou-book-hint">${t("WITCHER.Sheet.ValuableStudy.Text.To", "To")}</span>
        <select data-book-range-max class="wou-book-range-sel">${rankRange(1, 3, toSel)}</select>
      </span>
      <span class="wou-book-hint">${t("WITCHER.Sheet.ValuableStudy.Hint.SessionsPerRank", "5 successful sessions per rank. The From rank is for reference — only the To rank is enforced as a cap.")}</span>
    </div>
    <div class="wou-book-row">
      <label>${t("WITCHER.Sheet.ValuableStudy.Label.StudyDifficulty", "Study Difficulty")}</label>
      <select data-book-dc data-dc-pane="skill">
        ${DC_OPTIONS().map(o => `<option value="${o.value}" ${validDc(sc.dc) === o.value ? "selected" : ""}>${escapeText(o.label)}</option>`).join("")}
      </select>
      <span class="wou-book-hint">${t("WITCHER.Sheet.ValuableStudy.Hint.EducationEachSession", "Education check for each study session.")}</span>
    </div>`;
}

function buildStressPane(sc) {
  const loreOn = !!sc?.lore;
  return `
    <div class="wou-book-stress-editor">
      <p class="wou-book-hint" style="margin-bottom:10px;">${t("WITCHER.Sheet.ValuableStudy.Hint.StressExplain", "Each reading session advances one step. Negative stress = relief; positive = tension. Steps play in order.")}</p>
      <label class="wou-book-list-option" style="margin-bottom:10px;">
        <input type="checkbox" data-book-lore ${loreOn ? "checked" : ""}/>
        <span><i class="fa-solid fa-feather-pointed"></i> ${t("WITCHER.Sheet.ValuableStudy.Label.SaveToLore", "Save to the reader's Lore journal")}</span>
      </label>
      <div class="wou-book-steps-list"></div>
      <button type="button" data-step-add class="wou-book-step-add-btn">
        <i class="fa-solid fa-plus"></i> ${t("WITCHER.Sheet.ValuableStudy.Button.AddReadingStep", "Add Reading Step")}
      </button>
    </div>`;
}

/* =========================================================================
   DIALOG WIRING
   ========================================================================= */

function wireConfigDialog(root, editSteps) {
  // Single-type dialog — no type tabs. Wire only the active type's controls.

  // Monster: mode panes
  const modeSel = root.querySelector("[data-book-mode]");
  modeSel?.addEventListener("change", () => {
    root.querySelectorAll("[data-pane]").forEach(p => { p.hidden = p.dataset.pane !== modeSel.value; });
  });

  // Monster: difficulty op → enable/disable value select
  const diffOp  = root.querySelector('[data-book-filter="difficultyOp"]');
  const diffVal = root.querySelector('[data-book-filter="difficultyValue"]');
  diffOp?.addEventListener("change", () => { if (diffVal) diffVal.disabled = (diffOp.value === "any"); });

  // Stress: step editor
  wireStepsEditor(root, editSteps);
}

function wireStepsEditor(root, editSteps) {
  const container = root.querySelector(".wou-book-steps-list");
  if (!container) return;

  function rerender() {
    container.innerHTML = editSteps.map((s, i) => renderStepRow(s, i)).join("");
    // Remove buttons
    container.querySelectorAll("[data-step-remove]").forEach(btn => {
      btn.addEventListener("click", () => {
        editSteps.splice(Number(btn.dataset.stepRemove), 1);
        rerender();
      });
    });
    // Sync stress inputs
    container.querySelectorAll("[data-step-stress]").forEach(inp => {
      inp.addEventListener("input", () => {
        const i = Number(inp.dataset.stepIdx);
        if (i >= 0 && i < editSteps.length) editSteps[i].stressChange = Number(inp.value) || 0;
      });
    });
    // Sync text areas
    container.querySelectorAll("[data-step-text]").forEach(ta => {
      ta.addEventListener("input", () => {
        const i = Number(ta.dataset.stepIdx);
        if (i >= 0 && i < editSteps.length) editSteps[i].text = ta.value;
      });
    });
  }

  rerender();
  root.querySelector("[data-step-add]")?.addEventListener("click", () => {
    editSteps.push({ text: "", stressChange: 0 });
    rerender();
  });
}

function renderStepRow(step, i) {
  return `
    <div class="wou-book-step-row">
      <div class="wou-book-step-hdr">
        <span class="wou-book-step-num">${tFormat("WITCHER.Sheet.ValuableStudy.Text.StepN", { n: i + 1 }, `Step ${i + 1}`)}</span>
        <label class="wou-book-step-stress-label">${t("WITCHER.Sheet.ValuableStudy.Label.Stress", "Stress")}</label>
        <input type="number" class="wou-book-step-stress" data-step-idx="${i}" data-step-stress
               value="${Number(step.stressChange) || 0}" min="-20" max="20" step="1"
               title="${t("WITCHER.Sheet.ValuableStudy.Text.NegativeRelieveStressPositiveAddStress", "Negative = relieve stress · Positive = add stress")}">
        <span class="wou-book-hint">(− relieve · + add)</span>
        <button type="button" class="wou-book-step-remove" data-step-remove="${i}" title="${t("WITCHER.Sheet.ValuableStudy.Text.RemoveStep", "Remove step")}">×</button>
      </div>
      <textarea class="wou-book-step-text" data-step-idx="${i}" data-step-text rows="3"
                placeholder="${t("WITCHER.Sheet.ValuableStudy.Text.WhatTheCharacterReadsAtThisStep", "What the character reads at this step...")}">${escapeText(step.text ?? "")}</textarea>
    </div>`;
}

/* =========================================================================
   READ CONFIG FROM DIALOG
   ========================================================================= */

function readConfigFromDialog(root, prev, editSteps) {
  // Type is fixed (set on the sheet); the dialog only renders that one pane.
  // Read just the active type and carry the others over from prev untouched —
  // their inputs aren't in the DOM, so reading them would reset to defaults.
  const bookType = prev.bookType ?? BOOK_TYPES.MONSTER;

  const monster = prev.monster ? { ...prev.monster } : {};
  const skill   = prev.skill   ? { ...prev.skill }   : {};
  let   stress  = prev.stress  ? { ...prev.stress }  : { steps: [] };

  if (bookType === BOOK_TYPES.MONSTER) {
    Object.assign(monster, {
      mode:         root.querySelector("[data-book-mode]")?.value         ?? "specific",
      specificKey:  root.querySelector("[data-book-specific]")?.value     ?? "",
      listKeys:     Array.from(root.querySelectorAll("[data-list-key]")).filter(i => i.checked).map(i => i.dataset.listKey),
      filter: {
        category:        root.querySelector('[data-book-filter="category"]')?.value        ?? "",
        difficultyOp:    root.querySelector('[data-book-filter="difficultyOp"]')?.value    ?? "any",
        difficultyValue: root.querySelector('[data-book-filter="difficultyValue"]')?.value ?? "",
        environment:     root.querySelector('[data-book-filter="environment"]')?.value     ?? ""
      },
      dc:                     Number(root.querySelector('[data-dc-pane="monster"]')?.value)       || STUDY_DC,
      totalReadings:          Math.max(1, Number(root.querySelector("[data-book-total-readings]")?.value)    || 5),
      rpPerReading:           Math.max(0, Number(root.querySelector("[data-book-rp-per-reading]")?.value)    || 1),
      commonKnowledgeReading: Math.max(0, Number(root.querySelector("[data-book-common-reading]")?.value) || 0),
      secondKnowledgeReading: Math.max(0, Number(root.querySelector("[data-book-second-reading]")?.value) || 0)
    });
  } else if (bookType === BOOK_TYPES.SKILL) {
    const skillRaw = root.querySelector("[data-book-skill-id]")?.value ?? "int|education";
    const [skillStat = "int", skillId = "education"] = skillRaw.split("|");
    const rangeMin    = Number(root.querySelector("[data-book-range-min]")?.value) || 0;
    const rangeMaxRaw = Number(root.querySelector("[data-book-range-max]")?.value) || 1;
    Object.assign(skill, {
      skillStat,
      skillId,
      rangeMin,
      rangeMax: Math.max(rangeMaxRaw, rangeMin + 1),
      dc: Number(root.querySelector('[data-dc-pane="skill"]')?.value) || STUDY_DC
    });
  } else if (bookType === BOOK_TYPES.STRESS) {
    // Final DOM sync for stress steps (catches any unsynchronised inputs)
    root.querySelectorAll("[data-step-stress]").forEach(inp => {
      const i = Number(inp.dataset.stepIdx);
      if (i >= 0 && i < editSteps.length) editSteps[i].stressChange = Number(inp.value) || 0;
    });
    root.querySelectorAll("[data-step-text]").forEach(ta => {
      const i = Number(ta.dataset.stepIdx);
      if (i >= 0 && i < editSteps.length) editSteps[i].text = ta.value;
    });
    stress = {
      lore: !!root.querySelector("[data-book-lore]")?.checked,
      steps: editSteps.map(s => ({ text: String(s.text ?? ""), stressChange: Number(s.stressChange) || 0 }))
    };
  }

  // Language section is shared across all types — always in the DOM.
  const language = {
    skillId: LANGUAGE_SKILLS.includes(root.querySelector("[data-book-language]")?.value)
      ? root.querySelector("[data-book-language]").value : "",
    requiredRank: Math.min(10, Math.max(1, Number(root.querySelector("[data-book-language-rank]")?.value) || 1))
  };

  return { bookType, monster, skill, stress, language };
}

/* =========================================================================
   SUMMARISE (non-GM read-only view)
   ========================================================================= */

function summariseConfig(cfg, sorted) {
  if (!cfg?.bookType) return t("WITCHER.Chrome.ValuableStudy.Summary.NotConfigured", "Not configured as a study material.");
  if (cfg.bookType === BOOK_TYPES.MONSTER) {
    const mc    = cfg.monster ?? {};
    const total = mc.totalReadings ?? 5;
    const rp    = mc.rpPerReading ?? 1;
    const suffix = tFormat("WITCHER.Chrome.ValuableStudy.Summary.MonsterSuffix", { total, rp, dc: mc.dc ?? STUDY_DC }, ` · ${total} readings · ${rp} RP/reading · DC ${mc.dc ?? STUDY_DC}.`);
    if (mc.mode === "specific") {
      const e = sorted.find(x => x.key === mc.specificKey);
      return tFormat("WITCHER.Chrome.ValuableStudy.Summary.MonsterSpecific", { name: e?.name ?? t("WITCHER.Chrome.ValuableStudy.Summary.Unknown", "(unknown)"), suffix }, `Monster Study · ${e?.name ?? "(unknown)"}${suffix}`);
    }
    if (mc.mode === "list") return tFormat("WITCHER.Chrome.ValuableStudy.Summary.MonsterList", { count: (mc.listKeys ?? []).length, suffix }, `Monster Study · ${(mc.listKeys ?? []).length} monsters${suffix}`);
    return tFormat("WITCHER.Chrome.ValuableStudy.Summary.MonsterFilter", { suffix }, `Monster Study · filter mode${suffix}`);
  }
  if (cfg.bookType === BOOK_TYPES.SKILL) {
    const sc      = cfg.skill ?? {};
    const skillDef = SKILL_LIST.find(s => s.stat === sc.skillStat && s.id === sc.skillId);
    const sName   = skillDef ? localizeSkill(sc.skillId) : (sc.skillId ?? "?");
    return tFormat("WITCHER.Chrome.ValuableStudy.Summary.SkillBook", { name: sName, min: sc.rangeMin ?? 0, max: sc.rangeMax ?? 1, dc: sc.dc ?? STUDY_DC }, `Skill Book · ${sName} (rank ${sc.rangeMin ?? 0}→${sc.rangeMax ?? 1}) · DC ${sc.dc ?? STUDY_DC}.`);
  }
  if (cfg.bookType === BOOK_TYPES.STRESS) {
    const count = (cfg.stress?.steps ?? []).length;
    return tFormat("WITCHER.Chrome.ValuableStudy.Summary.NovelLore", { count, plural: count !== 1 ? "s" : "" }, `Novel / Lore · ${count} reading step${count !== 1 ? "s" : ""}.`);
  }
  return t("WITCHER.Chrome.ValuableStudy.Summary.Configured", "Configured.");
}

/* =========================================================================
   UTILS
   ========================================================================= */

function escapeText(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function escapeAttr(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
