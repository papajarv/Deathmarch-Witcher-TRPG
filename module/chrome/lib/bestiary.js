/**
 * Bestiary state helpers — minimal, per-character.
 *
 * Research tier is GM-controlled directly via the star buttons; encounter
 * events are auto-logged on createCombatant by chrome/bestiary-encounters.js.
 *
 * Per-entry shape on each PC's actor flag:
 *   actor.flags["witcher-ttrpg-death-march"].bestiary[encoded-key] = {
 *     research:   0..6,   // current unlocked tier
 *     pinned:     boolean,
 *     rp:         number, // research points accumulated for this entry,
 *                         //   spendable to advance the research tier
 *     encounters: [{ id, combatId, worldTime, sceneId, sceneName,
 *                    title, note, outcome, authorId }]
 *   }
 *
 * The bestiary key is the doc UUID (with the variant-flag override).  Keys
 * contain dots, which Foundry's `update()` expands as nested paths, so we
 * encode them at the storage boundary (see encKey / decKey).
 */

import { MODULE_ID } from "../setup/settings.js";

const VARIANT_FLAG = "bestiaryVariant";
const ACTOR_FLAG_KEY = "bestiary";

/* Foundry's `update()` calls `expandObject()`, which recurses into object
 * values and treats every ASCII dot as a nested-path separator.  UUIDs
 * are dot-heavy ("Compendium.witcher.monsters.werewolf") so they cannot
 * be used directly as Object keys inside any flag value or they'll be
 * blown into deep nesting on save.  We sub in middle-dot (U+00B7), a
 * character Foundry doesn't treat as a separator and one that never
 * appears in standard UUIDs. */
const KEY_ENC_DOT = "·";
export function encKey(k) { return String(k ?? "").replaceAll(".", KEY_ENC_DOT); }
export function decKey(k) { return String(k ?? "").replaceAll(KEY_ENC_DOT, "."); }

/** Max research tier (L6 is the "research bonuses" tier). */
export const MAX_RESEARCH = 6;

/** RP cost to ADVANCE INTO each tier, indexed by target tier.
 *  Index 0/1 are 0 because L0 is the default state and L1 unlocks
 *  automatically on first encounter (no spend).  Levels 2-6 are paid.
 *  Curve: 1, 2, 3, 5, 7  →  18 RP total to max a monster. */
export const RESEARCH_COSTS = [0, 0, 1, 2, 3, 5, 7];

/** Cost to advance INTO targetTier (from targetTier - 1). 0 if free
 *  (L0/L1) or out-of-range. */
export function costToAdvance(targetTier) {
  const t = Number(targetTier);
  if (!Number.isFinite(t) || t < 0 || t > MAX_RESEARCH) return 0;
  return RESEARCH_COSTS[t] ?? 0;
}

/** Linear familiarity taper, shared by every RP source that depends on
 *  re-observation.  1.0 at L0 → 0.0 at L6.  Captures "the more you've
 *  studied this creature, the less a casual glance / another kill
 *  teaches you" — late-tier RP needs new sources (books, alchemy). */
export function tierFamiliarityTaper(currentTier) {
  const t = Number(currentTier) || 0;
  if (t <= 0) return 1;
  if (t >= MAX_RESEARCH) return 0;
  return 1 - t / MAX_RESEARCH;
}

/** Probability a confirmed kill grants +1 RP — full strength at L0, 0 at L6. */
export function killRpChance(currentTier) {
  return tierFamiliarityTaper(currentTier);
}

/** Probability the post-combat observation roll grants +1 RP.
 *  Base chance is INT/10 (the d10 ≤ INT roll, expressed as a fraction),
 *  multiplied by the familiarity taper.  INT 5 at L0 = 50%; INT 5 at L3
 *  = 25%; anyone at L6 = 0%. */
export function observationRpChance(intStat, currentTier) {
  const i = Number(intStat) || 0;
  if (i <= 0) return 0;
  return Math.min(1, i / 10) * tierFamiliarityTaper(currentTier);
}

/* =========================================================================
   Default shape
   ========================================================================= */

export function defaultEntryState() {
  return {
    research:   0,
    pinned:     false,
    rp:         0,
    encounters: [],
    /* Knowledge-tier reveal state — per-PC per-monster, keyed by the
     * monster's `system.knowledge[]` tier INDEX (as a string, since flag
     * keys are strings).  Each tier:
     *   revealed:        bool — flipped true on a successful skill roll
     *   lastFailedTier:  number|null — research tier at which the last
     *                    failed roll happened; player can retry only when
     *                    research has advanced beyond that.
     * Empty by default — entries are created lazily for whichever tiers a
     * given monster actually authors. */
    knowledge: {}
  };
}

/* =========================================================================
   Encounter-log helpers — aggregated count + last-seen for the card meta
   ========================================================================= */

export function getEncounters(actor, key) {
  if (!actor || !key) return [];
  const raw = actor.flags?.[MODULE_ID]?.[ACTOR_FLAG_KEY] ?? {};
  return Array.isArray(raw[encKey(key)]?.encounters)
    ? raw[encKey(key)].encounters
    : [];
}

/** Merge `partial` into the encounter with id=eventId on this PC's log.
 *  Permission: actor owner or GM.  Returns true on success. */
export async function updateEncounter(actor, key, eventId, partial) {
  if (!actor || !key || !eventId) return false;
  if (!actor.testUserPermission?.(game.user, "OWNER") && !game.user?.isGM) return false;
  const raw = actor.flags?.[MODULE_ID]?.[ACTOR_FLAG_KEY] ?? {};
  const eKey = encKey(key);
  const state = raw[eKey];
  if (!state || !Array.isArray(state.encounters)) return false;
  const idx = state.encounters.findIndex(e => e.id === eventId);
  if (idx === -1) return false;
  const next = state.encounters.slice();
  next[idx] = { ...next[idx], ...partial };
  await updateActorEntryState(actor, key, { encounters: next });
  return true;
}

export function getViewerEncounters(key) {
  const viewer = getViewerCharacter();
  if (viewer) return getEncounters(viewer, key);
  if (game.user?.isGM) {
    /* GM aggregated view: union encounter logs across all PCs, dedup by id. */
    const seen = new Map();
    for (const pc of allPCs()) {
      for (const e of getEncounters(pc, key)) {
        if (!seen.has(e.id)) seen.set(e.id, e);
      }
    }
    return [...seen.values()];
  }
  return [];
}

export function getEncounterCount(key) {
  return getViewerEncounters(key).length;
}

export function getLastEncounterTime(key) {
  const list = getViewerEncounters(key);
  if (!list.length) return null;
  return list.reduce((m, e) => Math.max(m, e.worldTime ?? 0), 0);
}

/** Cumulative confirmed kills — sum of `kills` per encounter event.  Each
 *  event's `kills` is set on deleteCombat to the number of monster
 *  combatants of that key marked `defeated` when the combat ended. */
export function getKillCount(key) {
  return getViewerEncounters(key).reduce((s, e) => s + (e.kills ?? 0), 0);
}

/* =========================================================================
   Research-point helpers
   ========================================================================= */

export function getResearchPoints(actor, key) {
  if (!actor || !key) return 0;
  const raw = actor.flags?.[MODULE_ID]?.[ACTOR_FLAG_KEY] ?? {};
  return Number(raw[encKey(key)]?.rp ?? 0);
}

export function getViewerResearchPoints(key) {
  const viewer = getViewerCharacter();
  if (viewer) return getResearchPoints(viewer, key);
  if (game.user?.isGM) {
    /* GM aggregated view: max RP across all PCs. */
    let max = 0;
    for (const pc of allPCs()) {
      max = Math.max(max, getResearchPoints(pc, key));
    }
    return max;
  }
  return 0;
}

/** Returns the cost to unlock the NEXT tier for a given current tier,
 *  or 0 if already at max. */
export function nextTierCost(currentTier) {
  const t = Number(currentTier) || 0;
  if (t >= MAX_RESEARCH) return 0;
  return costToAdvance(t + 1);
}

/** True iff this PC has enough RP to unlock the next tier from `currentTier`. */
export function canAffordNextTier(actor, key) {
  const cur = getActorEntryState(actor, key);
  const cost = nextTierCost(cur.research);
  if (cost <= 0) return false;          // at max or otherwise no cost
  return getResearchPoints(actor, key) >= cost;
}

/* =========================================================================
   Knowledge-track helpers (L3 lore reveal)
   ========================================================================= */

/** Can this PC attempt the roll for this knowledge tier right now?
 *  `tierIndex` is the index into the monster's system.knowledge[] array. */
export function canAttemptKnowledge(actor, key, tierIndex) {
  if (!actor || !key || tierIndex == null) return false;
  const cur = getActorEntryState(actor, key);
  if (cur.research < 3) return false;
  const track = cur.knowledge?.[String(tierIndex)] ?? { revealed: false, lastFailedTier: null };
  if (track.revealed) return false;
  if (track.lastFailedTier == null) return true;
  return cur.research > track.lastFailedTier;
}

/** Is a given knowledge tier already revealed for this PC? */
export function isKnowledgeRevealed(actor, key, tierIndex) {
  if (!actor || !key || tierIndex == null) return false;
  const cur = getActorEntryState(actor, key);
  return !!cur.knowledge?.[String(tierIndex)]?.revealed;
}

/** Book-driven knowledge grant — bumps research to ≥ L2 (book implies you
 *  know what the creature IS) AND marks the listed knowledge tiers as
 *  revealed in one write.  `tierIndices` are indices into the monster's
 *  system.knowledge[] array.  Per-PC.  Returns true on a successful write. */
export async function grantKnowledgeViaBook(actor, key, tierIndices) {
  if (!actor || !key || !Array.isArray(tierIndices) || !tierIndices.length) return false;
  const cur = getActorEntryState(actor, key);
  const knowledge = { ...(cur.knowledge ?? {}) };
  for (const idx of tierIndices) {
    if (idx == null) continue;
    const k = String(idx);
    const track = { ...(knowledge[k] ?? { revealed: false, lastFailedTier: null }) };
    track.revealed = true;
    knowledge[k] = track;
  }
  const patch = { knowledge };
  if ((cur.research ?? 0) < 2) patch.research = 2;
  await updateActorEntryState(actor, key, patch);
  return true;
}

/** Record the result of a knowledge-roll attempt.  success → revealed.
 *  fail → lastFailedTier := current research tier (locks until next tier).
 *  Returns true on success of the WRITE (not the roll). */
export async function recordKnowledgeAttempt(actor, key, tierIndex, success) {
  if (!actor || !key || tierIndex == null) return false;
  const cur = getActorEntryState(actor, key);
  const knowledge = { ...(cur.knowledge ?? {}) };
  const k = String(tierIndex);
  const track = { ...(knowledge[k] ?? { revealed: false, lastFailedTier: null }) };
  if (success) track.revealed = true;
  else         track.lastFailedTier = cur.research;
  knowledge[k] = track;
  await updateActorEntryState(actor, key, { knowledge });
  return true;
}

/** Credit RP to one bestiary entry on this PC.  Any RP gain implies the
 *  PC has at least heard of the creature — auto-bumps research from L0
 *  to L1 so the freshly-gained points can actually be spent.  Single
 *  setFlag call.  Returns true on a successful write. */
export async function grantRpToEntry(actor, key, points) {
  if (!actor || !key) return false;
  const pts = Math.max(0, Number(points) || 0);
  if (pts <= 0) return false;
  const cur = getActorEntryState(actor, key);
  const patch = { rp: (cur.rp ?? 0) + pts };
  if ((cur.research ?? 0) < 1) patch.research = 1;
  await updateActorEntryState(actor, key, patch);
  return true;
}

/** Spend RP from THIS actor's pool to advance their research by one tier.
 *  Idempotent on failure (no partial writes).  Returns true on success. */
export async function spendRpToAdvance(actor, key) {
  if (!actor || !key) return false;
  const cur  = getActorEntryState(actor, key);
  const cost = nextTierCost(cur.research);
  if (cost <= 0) return false;                    // at max
  const rp = Number(cur.rp ?? 0);
  if (rp < cost) return false;                    // not affordable
  await updateActorEntryState(actor, key, {
    research: cur.research + 1,
    rp: rp - cost
  });
  return true;
}

function decorate(entry) {
  return { ...defaultEntryState(), ...(entry ?? {}) };
}

/* =========================================================================
   Per-actor read / write
   ========================================================================= */

export function getActorBestiary(actor) {
  if (!actor || actor.type !== "character") return {};
  const raw = actor.flags?.[MODULE_ID]?.[ACTOR_FLAG_KEY] ?? {};
  const decoded = {};
  for (const [k, v] of Object.entries(raw)) decoded[decKey(k)] = v;
  return decoded;
}

export function getActorEntryState(actor, key) {
  if (!actor || !key) return decorate(null);
  const raw = actor.flags?.[MODULE_ID]?.[ACTOR_FLAG_KEY] ?? {};
  return decorate(raw[encKey(key)]);
}

export async function updateActorEntryState(actor, key, partial) {
  if (!actor || !key) return;
  if (!actor.testUserPermission?.(game.user, "OWNER") && !game.user?.isGM) return;
  const cur = getActorEntryState(actor, key);
  const next = { ...cur, ...partial };
  const map = { ...(actor.flags?.[MODULE_ID]?.[ACTOR_FLAG_KEY] ?? {}) };
  map[encKey(key)] = next;
  await actor.setFlag(MODULE_ID, ACTOR_FLAG_KEY, map);
}

/* =========================================================================
   Viewer / aggregated state
   ========================================================================= */

/* The viewer override is the shared "view as" selection from lib/actor.js
 * — picking a character in any tab's dropdown (bestiary, inventory, char,
 * journal) propagates to every other surface.  Re-exported here so the
 * bestiary chrome's existing import paths keep working. */
import { setActorOverride, getActorOverride } from "./actor.js";

export const setViewerOverride = setActorOverride;
export const getViewerOverride = getActorOverride;

export function getViewerCharacter() {
  const u = game.user;
  if (!u) return null;
  /* GM override takes precedence over any default viewer resolution. */
  if (u.isGM) {
    const overrideId = getActorOverride();
    if (overrideId) {
      const override = game.actors?.get?.(overrideId);
      if (override?.type === "character") return override;
    }
  }
  if (u.character) return u.character;
  if (u.isGM) return null;
  return (game.actors?.contents ?? []).find(a =>
    a.type === "character" && a.testUserPermission?.(u, "OWNER")
  ) ?? null;
}

function allPCs() {
  return (game.actors?.contents ?? []).filter(a => a.type === "character");
}

/** GM aggregated view — max research, OR'd pinned, OR'd knowledge.revealed
 *  across all PCs.  RP and lastFailedTier are not aggregated (per-PC only). */
export function getAggregatedEntryState(key) {
  const agg = defaultEntryState();
  for (const pc of allPCs()) {
    const e = getActorEntryState(pc, key);
    agg.research = Math.max(agg.research, e.research);
    agg.pinned   = agg.pinned || e.pinned;
    /* Union revealed knowledge tiers across PCs, keyed by tier index. */
    for (const [k, track] of Object.entries(e.knowledge ?? {})) {
      if (track?.revealed) agg.knowledge[k] = { revealed: true, lastFailedTier: null };
    }
  }
  return decorate(agg);
}

export function getViewerEntryState(key) {
  const viewer = getViewerCharacter();
  if (viewer) return getActorEntryState(viewer, key);
  if (game.user?.isGM) return getAggregatedEntryState(key);
  return decorate(null);
}

/* =========================================================================
   Key resolution + variant flag
   ========================================================================= */

export function bestiaryKeyFor(doc) {
  if (!doc) return null;
  if (doc.pack && doc.uuid) return doc.uuid;
  if (doc.flags?.[MODULE_ID]?.[VARIANT_FLAG]) return doc.uuid;
  /* V13 moved the "imported from compendium" pointer from
   * flags.core.sourceId to _stats.compendiumSource.  Check both so worlds
   * upgraded from V12 still resolve correctly. */
  const sourceId =
    doc._stats?.compendiumSource ??
    doc.flags?.core?.sourceId ??
    null;
  if (sourceId) return String(sourceId);
  return doc.uuid;
}

export function isBestiaryVariant(actor) {
  return !!actor?.flags?.[MODULE_ID]?.[VARIANT_FLAG];
}

/* ------------------------------------------------------------------------
 * Research-tier "0 → 1" bump
 *
 * Shared helper used by every carcass action (dissect, extract mutagen,
 * harvest). Touches a PC's bestiary entry for the given monster:
 *   - If the entry's `research` is currently 0 or missing, sets it to 1.
 *   - If the entry's `research` is already 1 or higher, returns without
 *     modifying anything — a player at tier 3 never gets knocked down to 1.
 * Other fields on the entry (encounters, dissection facts, rp,
 * knowledge tracks, etc.) are preserved via spread-merge.
 * ----------------------------------------------------------------------- */
export async function bumpResearchIfZero(actor, monster) {
  if (!actor || !monster) return;
  const key = bestiaryKeyFor(monster);
  if (!key) return;
  const path  = `${ACTOR_FLAG_KEY}.${encKey(key)}`;
  const entry = actor.getFlag(MODULE_ID, path) ?? {};
  /* Bail when already non-zero. Number() handles strings/undefined cleanly:
   *   undefined → NaN > 0 → false (continue, fresh entry).
   *   0         → false (continue, exactly the case we want to bump).
   *   1+        → true  (return, leave alone — never demote). */
  if (Number(entry?.research) > 0) return;
  const merged = { ...entry, research: 1 };
  try { await actor.setFlag(MODULE_ID, path, merged); }
  catch (err) { console.warn(`${MODULE_ID} | failed to bump research tier`, err); }
}

export async function setBestiaryVariant(actor, value) {
  if (!actor || !game.user?.isGM) return;
  await actor.setFlag(MODULE_ID, VARIANT_FLAG, !!value);
}

/* =========================================================================
   Schema migration — one-time wipe of legacy world-shared state
   ========================================================================= */

const SCHEMA_VERSION = 2;
const SCHEMA_SETTING_KEY = "bestiary.schemaVersion";

export async function migrateBestiarySchemaIfNeeded() {
  if (!game.user?.isGM) return;
  let cur = 0;
  try { cur = Number(game.settings.get(MODULE_ID, SCHEMA_SETTING_KEY)) || 0; }
  catch { cur = 0; }
  if (cur >= SCHEMA_VERSION) return;
  try { await game.settings.set(MODULE_ID, "bestiary.state", {}); } catch { /* may not exist */ }
  try { await game.settings.set(MODULE_ID, SCHEMA_SETTING_KEY, SCHEMA_VERSION); } catch { /* */ }
  console.log(`[${MODULE_ID}] bestiary schema migrated → v${SCHEMA_VERSION}`);
}
