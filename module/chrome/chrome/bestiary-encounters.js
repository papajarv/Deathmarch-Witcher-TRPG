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
import { t, tFormat } from "../lib/i18n.js";
import {
  bestiaryKeyFor,
  encKey,
  decKey,
  defaultEntryState,
  killRpChance,
  observationRpChance,
  effectiveTier
} from "../lib/bestiary.js";

let _writeQueue = Promise.resolve();
function enqueue(fn) {
  _writeQueue = _writeQueue.then(fn).catch(err =>
    console.error("[witcher-ttrpg-death-march] bestiary-encounters:", err)
  );
  return _writeQueue;
}

/** Flip to false to silence the GM's per-encounter research summary. */
const SHOW_RP_SUMMARY = true;

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

/** Per-PC, per-monster research summary sent when a combat ends. Written to be
 *  read by someone who has NEVER seen the bestiary system: it spells out what
 *  this character learned and why, roll by roll. Whispered ONLY to the GM(s) and
 *  the OWNER of the character who earned it — it's that player's own knowledge,
 *  and other players shouldn't see another PC's roll outcomes. */
function whisperRpRolls(pc, monsterName, gain, checks) {
  if (!SHOW_RP_SUMMARY || !checks.length) return;
  const esc = (s) => foundry.utils.escapeHTML?.(String(s ?? "")) ?? String(s ?? "");
  // GM(s) + the owning player(s) of this character. testUserPermission("OWNER")
  // already returns true for GMs, but keep the explicit isGM for clarity.
  const recipients = (game.users?.contents ?? [])
    .filter(u => u.isGM || pc?.testUserPermission?.(u, "OWNER"))
    .map(u => u.id);
  if (!recipients.length) return;

  /* Headline — what changed, in plain terms. */
  const head = gain > 0
    ? tFormat(
        "WITCHER.Chrome.BestiaryEncounters.Summary.Gained",
        { pc: esc(pc.name), monster: esc(monsterName), n: gain, s: gain === 1 ? "" : "s" },
        `<strong>${esc(pc.name)}</strong> learned more about <em>${esc(monsterName)}</em> — <span style="color:#a8c878">+${gain} Research Point${gain === 1 ? "" : "s"}</span>.`
      )
    : tFormat(
        "WITCHER.Chrome.BestiaryEncounters.Summary.NothingLearned",
        { pc: esc(pc.name), monster: esc(monsterName) },
        `<strong>${esc(pc.name)}</strong> fought <em>${esc(monsterName)}</em> but <span style="color:#a25050">picked up nothing new</span> this time.`
      );

  const rollsHeader = t(
    "WITCHER.Chrome.BestiaryEncounters.Summary.RollsHeader",
    "How it was earned — one knowledge roll per creature of this kind, for studying it during the fight and for slaying one:"
  );

  const nothingNew = t("WITCHER.Chrome.BestiaryEncounters.Summary.NothingNew", "nothing new");
  const lineFor = (c) => {
    const pct    = Math.round(c.chance * 100);
    const icon   = c.pass ? "✓" : "✗";
    const result = c.pass
      ? `<b>+1 RP</b>`
      : `<span style="opacity:0.8">${nothingNew}</span>`;
    if (c.source === "observation") {
      return tFormat(
        "WITCHER.Chrome.BestiaryEncounters.Summary.ObsLine",
        { icon, pct, int: c.intVal, result },
        `${icon} Studied it in the fight — <b>${pct}%</b> (from INT ${c.intVal}, reduced the more you already know) → ${result}`
      );
    }
    return tFormat(
      "WITCHER.Chrome.BestiaryEncounters.Summary.KillLine",
      { icon, pct, result },
      `${icon} Slew one — <b>${pct}%</b> (reduced the more you already know) → ${result}`
    );
  };
  const lines = checks.map(c =>
    `<div style="color:${c.pass ? "#a8c878" : "#8a8578"};font-size:0.92em;margin:1px 0">${lineFor(c)}</div>`
  ).join("");

  const taperNote = t(
    "WITCHER.Chrome.BestiaryEncounters.Summary.TaperNote",
    "Each success makes the next roll less likely — the more you already know, the less a fresh sighting teaches. A fully-researched creature teaches nothing from combat; the last points come from books and dissection."
  );

  ChatMessage.create({
    content: `<div class="wou-bst-rp" style="font-family:'PF DIN Text Cond Pro','Barlow Condensed',sans-serif;font-size:0.8rem;line-height:1.4">
      <div style="font-size:0.7rem;letter-spacing:0.1em;text-transform:uppercase;opacity:0.7;margin-bottom:2px">📖 ${t("WITCHER.Chrome.BestiaryEncounters.Summary.Header", "Bestiary Research")}</div>
      <div>${head}</div>
      <div style="opacity:0.85;font-size:0.9em;margin-top:5px">${rollsHeader}</div>
      ${lines}
      <div style="opacity:0.6;font-size:0.85em;margin-top:5px;font-style:italic">${taperNote}</div>
    </div>`,
    whisper: recipients
  }).catch(err => console.warn("[witcher-ttrpg-death-march] RP summary whisper failed:", err));
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
        title: sceneName || t("WITCHER.Chrome.BestiaryEncounters.Text.Encounter", "Encounter"),
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
       * re-fire of the hook can't double-pay.  Both sources roll ONCE
       * PER INDIVIDUAL COMBATANT of this bestiary key, scaled by the
       * familiarity taper so late-tier encounters teach less. Rationale:
       * fighting a wave of drowners teaches more than a single one —
       * each monster you observe / defeat is an additional data point.
       * Every roll is recorded in `checks` so the debug whisper can
       * show passes AND fails. */
      const tier = state.research ?? 0;
      /* Unspent RP counts toward the effective tier — see
         bestiary.js#effectiveTier. Chance is recomputed inside the
         loops with the RUNNING total (banked + rpGain-so-far), so a
         wave of 10 Scoia'tael doesn't all roll at the same starting
         chance — every successful pass makes the next roll less likely
         in step with what the PC has just learned. Without this, 10
         kills at a starting 83% could realistically pay out ~13 RP;
         with it, the taper closes the pool as it fills. */
      const bankedRp = Number(state.rp ?? 0);
      let rpGain = 0;
      const checks = [];
      if (!cur.rpGranted) {
        if (intVal > 0) {
          for (let i = 0; i < monsterCs.length; i++) {
            const effTier = effectiveTier(tier, bankedRp + rpGain);
            const chance = observationRpChance(intVal, tier, bankedRp + rpGain);
            const pass = Math.random() < chance;
            checks.push({ source: "observation", chance, pass, intVal, tier, effTier, bankedRp, running: rpGain, index: i });
            if (pass) rpGain += 1;
          }
        }
        if (killedCount > 0) {
          for (let i = 0; i < killedCount; i++) {
            const effTier = effectiveTier(tier, bankedRp + rpGain);
            const chance = killRpChance(tier, bankedRp + rpGain);
            const pass = Math.random() < chance;
            checks.push({ source: "kill", chance, pass, tier, effTier, bankedRp, running: rpGain, killedCount, index: i });
            if (pass) rpGain += 1;
          }
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
