/**
 * Bestiary encounter logging — GM-side hooks.
 *
 * createCombatant → for each unique monster bestiary-key in the combat,
 *   append one event to each PC combatant's bestiary.encounters[].
 *   Dedupe per (combatId, key) so adding 3 drowners or re-rolling
 *   initiative doesn't multi-log.
 *
 * deleteCombat → for each PC combatant, for each monster key in the combat:
 *   1. set outcome on the matching event:
 *        - PC defeated                     → "lost"
 *        - all monsters of this key down   → "won"
 *        - else                            → null (manual edit later)
 *   2. set kills = (defeated monster combatants of this key)
 *   3. grant research points (one-time, gated on event.rpGranted):
 *        - observation roll: chance = (INT/10) × tier-familiarity taper.
 *          INT 5 at L0 = 50%, INT 5 at L3 = 25%, anyone at L6 = 0%.
 *        - any monster of this key defeated  →  +1 RP, chance scaled by
 *          the same taper (killRpChance).  Late-tier kills give less; max
 *          RP must come from other sources (books, alchemy, etc.).
 *        - max +2 RP per PC per combat per key
 *
 * Writes are GM-only and serialized through a single promise queue so
 * back-to-back hook fires (3 monsters added in quick succession) can't
 * race and clobber each other's setFlag.
 */

import { MODULE_ID } from "../setup/settings.js";
import {
  bestiaryKeyFor,
  encKey,
  decKey,
  defaultEntryState,
  killRpChance,
  observationRpChance
} from "../lib/bestiary.js";

let _writeQueue = Promise.resolve();
function enqueue(fn) {
  _writeQueue = _writeQueue.then(fn).catch(err =>
    console.error("[witcher-ttrpg-death-march] bestiary-encounters:", err)
  );
  return _writeQueue;
}

/** Debug toggle — flip to false to silence the per-grant whispers. */
const DEBUG_RP_WHISPERS = true;

/** Treat a combatant as defeated if ANY of these signals fire:
 *
 *   - `c.isDefeated` — Foundry v13's canonical getter (rolls up the
 *     tracker's defeated flag PLUS the "dead" status effect on the token).
 *   - `c.defeated` — the older boolean flag (kept for safety; some flows
 *     still set this directly).
 *   - The actor (or one of its active effects) carries the `"dead"` status.
 *     Catches monsters that enter combat already marked dead via the token
 *     status menu but with HP > 0.
 *   - HP <= 0.  Catches corpse tokens dragged in at zero HP without any
 *     explicit defeated flag set, and the normal "reduced to 0 in combat
 *     but GM didn't click the skull" case.
 *
 *  Before this widening, monsters that entered combat already defeated
 *  (status effect applied, but no `defeated` flag and HP still > 0) never
 *  counted toward the kill bonus — only mid-combat deaths did. */
function isCombatantDefeated(c) {
  if (!c) return false;
  if (c.isDefeated) return true;
  if (c.defeated) return true;
  const actor = c.actor;
  if (actor?.statuses?.has?.("dead")) return true;
  if (actor?.effects?.some?.(e => !e.disabled && e.statuses?.has?.("dead"))) return true;
  const hp = actor?.system?.derivedStats?.hp?.value;
  return typeof hp === "number" && hp <= 0;
}

/** Whisper every RP roll, pass or fail, to the GMs only.  Players never
 *  see these — they're debug telemetry for the GM to verify the taper /
 *  RP-grant logic is firing correctly, and surfacing them to the actor's
 *  owners would spoil knowledge-roll outcomes. */
function whisperRpRolls(pc, monsterName, gain, checks) {
  if (!DEBUG_RP_WHISPERS || !checks.length) return;
  const esc = (s) => foundry.utils.escapeHTML?.(String(s ?? "")) ?? String(s ?? "");
  const recipients = (game.users?.contents ?? [])
    .filter(u => u.isGM && u.active)
    .map(u => u.id);
  if (!recipients.length) return;
  const summary = gain > 0
    ? `<span style="color:#a8c878">+${gain} RP</span>`
    : `<span style="color:#a25050">no RP</span>`;
  const lineFor = (c) => {
    const pct  = Math.round(c.chance * 100);
    const icon = c.pass ? "✓" : "✗";
    const tail = c.pass ? " · +1 RP" : "";
    if (c.source === "observation") {
      return `${icon} observation @ ${pct}% (INT ${c.intVal} · L${c.tier} taper)${tail}`;
    }
    return `${icon} kill bonus @ ${pct}% (L${c.tier} taper · ${c.killedCount} defeated)${tail}`;
  };
  const lines = checks.map(c =>
    `<span style="opacity:0.85;font-size:0.9em">${esc(lineFor(c))}</span>`
  ).join("<br>");
  ChatMessage.create({
    content: `<div class="wou-bst-debug" style="font-family:'PF DIN Text Cond Pro','Barlow Condensed',sans-serif">
      <strong>${esc(pc.name)}</strong> on <em>${esc(monsterName)}</em>: ${summary}
      <br>${lines}
    </div>`,
    whisper: recipients
  }).catch(err => console.warn("[witcher-ttrpg-death-march] RP whisper failed:", err));
}

export function registerBestiaryEncounterHooks() {
  Hooks.on("createCombatant", (combatant) => {
    if (!game.user?.isGM) return;
    enqueue(() => onCombatantAdded(combatant));
  });
  Hooks.on("deleteCombat", (combat) => {
    if (!game.user?.isGM) return;
    enqueue(() => onCombatEnded(combat));
  });
}

/* When ANY combatant is added, re-pair the current PC × monster sets in the
 * combat and write any missing (combatId,key) events.  This handles both
 * orderings: monster added before PCs and vice-versa. */
async function onCombatantAdded(combatant) {
  const combat = combatant?.parent;
  if (!combat) return;

  const actors    = combat.combatants.map(c => c.actor).filter(Boolean);
  const monsters  = actors.filter(a => a.type === "monster");
  const pcs       = actors.filter(a => a.type === "character");
  if (!monsters.length || !pcs.length) return;

  const monsterKeys = new Set();
  for (const m of monsters) {
    const k = bestiaryKeyFor(m);
    if (k) monsterKeys.add(k);
  }
  if (!monsterKeys.size) return;

  const sceneName = combat.scene?.name ?? "";
  const sceneId   = combat.scene?.id   ?? null;
  const worldTime = game.time.worldTime;
  const combatId  = combat.id;

  for (const pc of pcs) {
    const raw = pc.flags?.[MODULE_ID]?.bestiary ?? {};
    const map = { ...raw };
    let changed = false;
    for (const key of monsterKeys) {
      const eKey = encKey(key);
      const cur  = map[eKey] ?? defaultEntryState();
      const encs = Array.isArray(cur.encounters) ? cur.encounters : [];
      if (encs.some(e => e.combatId === combatId)) continue;
      const event = {
        id: `wou-enc-${foundry.utils.randomID()}`,
        combatId,
        worldTime,
        createdAt: Date.now(),
        sceneId,
        sceneName,
        title: sceneName || "Encounter",
        note: "",
        outcome: null,
        authorId: game.user.id
      };
      /* L0 → L1 is free on first sight.  Bump research to at least 1 for
       * this PC the moment they're in an encounter with this monster.
       * max() makes it idempotent and won't demote a higher tier. */
      map[eKey] = {
        ...cur,
        research: Math.max(Number(cur.research) || 0, 1),
        encounters: [...encs, event]
      };
      changed = true;
    }
    if (changed) await pc.setFlag(MODULE_ID, "bestiary", map);
  }
}

/* When a combat ends: for each PC, set the outcome on any encounter event
 * tagged with this combatId where outcome is still null.  We only touch
 * null outcomes so a manually-set outcome is never clobbered. */
async function onCombatEnded(combat) {
  if (!combat) return;

  /* Group monster combatants by bestiary key — we need to know whether
   * EVERY combatant of a given key was defeated. */
  const monstersByKey = new Map();
  for (const c of combat.combatants) {
    const a = c.actor;
    if (!a || a.type !== "monster") continue;
    /* Same fallback as combat-end: HP <= 0 counts as defeated even if
     * the GM didn't toggle the skull icon. */
    const key = bestiaryKeyFor(a);
    if (!key) continue;
    if (!monstersByKey.has(key)) monstersByKey.set(key, []);
    monstersByKey.get(key).push(c);
  }
  if (!monstersByKey.size) return;

  const pcCombatants = combat.combatants.filter(c => c.actor?.type === "character");
  if (!pcCombatants.length) return;

  for (const pcC of pcCombatants) {
    const pc = pcC.actor;
    const pcDefeated = !!pcC.defeated;
    const intVal = Number(pc.system?.stats?.int?.value ?? 0);
    const raw = pc.flags?.[MODULE_ID]?.bestiary ?? {};
    const map = { ...raw };
    let changed = false;
    for (const [eKey, state] of Object.entries(raw)) {
      const decoded = decKey(eKey);
      const monsterCs = monstersByKey.get(decoded);
      if (!monsterCs) continue;
      const allMonstersDefeated = monsterCs.every(isCombatantDefeated);
      const killedCount = monsterCs.filter(isCombatantDefeated).length;

      let outcome = null;
      if (pcDefeated)               outcome = "lost";
      else if (allMonstersDefeated) outcome = "won";
      /* else couldn't determine → leave null */

      const encs = Array.isArray(state?.encounters) ? state.encounters : [];
      const idx = encs.findIndex(e => e.combatId === combat.id);
      if (idx === -1) continue;
      const cur = encs[idx];

      /* Research-point grant — one-time, gated on event.rpGranted so a
       * re-fire of the hook can't double-pay.  Both sources roll
       * independently, both scaled by the same familiarity taper so
       * late-tier encounters teach less.  Every roll is recorded in
       * `checks` so the debug whisper can show passes AND fails. */
      const tier = state.research ?? 0;
      let rpGain = 0;
      const checks = [];
      if (!cur.rpGranted) {
        if (intVal > 0) {
          const chance = observationRpChance(intVal, tier);
          const pass   = Math.random() < chance;
          checks.push({ source: "observation", chance, pass, intVal, tier });
          if (pass) rpGain += 1;
        }
        if (killedCount > 0) {
          const chance = killRpChance(tier);
          const pass   = Math.random() < chance;
          checks.push({ source: "kill", chance, pass, tier, killedCount });
          if (pass) rpGain += 1;
        }
      }

      /* Apply updates: outcome only if not manually set already; kills
       * always reflects the latest defeated count for this combat. */
      const eventUpdates = {};
      if (outcome != null && cur.outcome == null) eventUpdates.outcome   = outcome;
      if ((cur.kills ?? 0) !== killedCount)       eventUpdates.kills     = killedCount;
      if (!cur.rpGranted)                          eventUpdates.rpGranted = true;

      const stateUpdates = {};
      if (rpGain > 0) stateUpdates.rp = (state.rp ?? 0) + rpGain;

      const eventChanged = Object.keys(eventUpdates).length > 0;
      const stateChanged = Object.keys(stateUpdates).length > 0;
      if (!eventChanged && !stateChanged) continue;

      const next = encs.slice();
      if (eventChanged) next[idx] = { ...cur, ...eventUpdates };
      map[eKey] = { ...state, ...stateUpdates, encounters: next };
      changed = true;

      /* Debug whisper — every roll (pass AND fail) to the PC's owners.
       * Fire-and-forget; doesn't gate the data write. */
      if (checks.length > 0) {
        const monsterName = monsterCs[0]?.actor?.name ?? decoded;
        whisperRpRolls(pc, monsterName, rpGain, checks);
      }
    }
    if (changed) await pc.setFlag(MODULE_ID, "bestiary", map);
  }
}
