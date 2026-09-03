/**
 * Active-Effect per-turn ticking — the EVENT backend of the unified action
 * model.
 *
 * Effects store a single list of action rows at flags.<MODULE_ID>.actions[]
 * (edited in WitcherActiveEffectConfig). This engine fires the *event* actions
 * once per turn:
 *
 *   { type: "heal",   amount: "3" | "1d6+2", when: "always" | "undamaged"
 *                     | "damaged" | "adrenaline" }
 *   { type: "damage", formula: "5" | "2d6", locations: [<loc>…],
 *                     throughArmor: bool }
 *
 *   locations: head, torso, rightArm, leftArm, rightLeg, leftLeg,
 *              randomHuman, randomMonster, everyLocation. Empty → torso.
 *   throughArmor: when true, raw damage skips the location's armor SP. The
 *   location multiplier (head×3, limbs ×½, etc.) still applies.
 *
 * Modifier actions (stat buffs) are compiled into native AE changes by
 * WitcherActiveEffect; suppress actions are read in
 * character.prepareDerivedData. Neither is handled here.
 *
 * Damage flow (per Witcher TRPG rules):
 *   raw → −SP (unless tickGoesThroughArmor) → ×locationFormula → floor → HP.
 * If damage is fully absorbed by armor, no HP changes but a chat line still
 * fires so the table sees the absorption.
 *
 * Combat tracking:
 *   combat.flags[MODULE_ID].tickedRound = { round, ids[] } tracks which
 *   combatants have ticked this round (idempotent — each combatant fires at
 *   most once per round, even across leapfrogged turn changes).
 *
 * Backwards compat: existing data using the witcher-bug-fixes flag namespace
 * is still read; new writes go to MODULE_ID. Both can coexist transiently.
 *
 * Migrated in from the standalone witcher-bug-fixes module.
 */

import { MODULE_ID } from "../setup/settings.js";
import {
  drainHp,
  normalizeAction,
  effectTrigger,
  effectOperation,
  applyOperation,
  actionValue,
  isActionValueFormula,
  isPoolCurrentTarget
} from "../../setup/config.mjs";
import { clauseFor, runTurnStartMutations, runTurnEndMutations } from "../../mechanics/statusEngine.mjs";
import { durableAblationNegated } from "../../mechanics/durable.mjs";
import { equippedAdrenalizedBonus } from "../../api/adrenaline.mjs";

/* Regenerating(N) rune/glyph — sum of the extra HP the actor's EQUIPPED gear
 * ARMOR glyph grants whenever the actor heals HP (glyph-only quality).
 * Reads `effective` qualities so a socketed / stacked Regenerating counts. */
function equippedRegeneratingBonus(actor) {
  let bonus = 0;
  for (const it of (actor?.items ?? [])) {
    if (it.type !== "armor" || !it.system?.equipped) continue;
    const quals = it.system?.effective?.qualities ?? it.system?.qualities ?? [];
    if (!Array.isArray(quals) || !quals.includes("regenerating")) continue;
    const vals = it.system?.effective?.qualityValues ?? it.system?.qualityValues ?? {};
    bonus += Math.max(0, Math.trunc(Number(vals.regenerating) || 0));
  }
  return bonus;
}
import { ceChokeholdDoTAmount } from "../../mechanics/holdModifiers.mjs";
import { getLocationSP, decrementArmorSP } from "../chrome/dock.js";
import { t, tFormat } from "../lib/i18n.js";

const LEGACY_MOD = "witcher-bug-fixes";   // old namespace — read-only fallback

/* Hard cap on per-turn ticks applied for a single out-of-combat world-clock
 * advance. A permanent (duration-less) per-turn effect would otherwise fire
 * `delta / turnTime` times — advancing 8 hours of rest is ~9600 ticks, which
 * would freeze the client and flood chat. 120 ticks ≈ 6 minutes of game time
 * at 3s/turn, enough for any real potion duration while staying responsive. */
const MAX_OOC_TICKS = 120;

/* Anchor for OOC per-turn ticking.
 *
 * A tick fires whenever `floor(worldTime / turnTime)` crosses a new integer.
 * This lets the running world clock (time-flow.mjs, +1s per real second) fire
 * a tick once every `turnTime` real seconds — the delta-based approach used
 * before rounded 1/3 = 0 and never ticked under time-flow. It also handles
 * a manual +Nmin skip in one go: cross ⌊N·60/turnTime⌋ boundaries, cap at
 * MAX_OOC_TICKS, done.
 *
 * -1 = uninitialized; lazy-init on the first updateWorldTime seen so we don't
 * rely on the ordering between `ready` and any earlier world-time event. */
let lastOocTurnIdx = -1;
/* The combatant whose turn is currently active, tracked GM-side across
 * updateCombat fires. On the next turn change this is the OUTGOING combatant —
 * the reliable way to run "clears at turn end" (combat.previous and the
 * combatTurnChange `prior` arg both proved to lag across rollovers). */
let _activeCombatantId = null;

function currentTurnIdx(turnTime) {
  return Math.floor(Number(game.time?.worldTime ?? 0) / turnTime);
}

/* Read flag preferring new namespace; fall back to legacy module so existing
 * world data keeps working until the user re-saves the effect. */
function readFlag(effect, key) {
  const v = effect.flags?.[MODULE_ID]?.[key];
  return v !== undefined ? v : effect.flags?.[LEGACY_MOD]?.[key];
}

/* ──────────────────────────────────────────────────────────────────────────
 * Public install
 * ────────────────────────────────────────────────────────────────────────── */

/* Toxicity tier marker ids — kept here so the real-time DoT interval
 * below can cheaply check "does this actor carry any tier?" without
 * importing from consume-item.js (would create another circular). */
const TOXICITY_TIER_STATUS_IDS = [
  "toxicity-mild", "toxicity-strong", "toxicity-severe", "toxicity-deadly"
];

/* Wall-clock real-time DoT for toxicity tier markers. worldTime only
 * advances when something explicitly bumps it (manual buttons, time-flow
 * modules, combat); for a poisoned character resting at the table while
 * the GM narrates, the OOC tick path in tickActorOverTime never fires
 * because no worldTime ever advances. This setInterval runs once per
 * 3 real seconds (= one in-game turn at default CONFIG.time.turnTime),
 * GM-only, no-op during active combat. Limited to toxicity tier statuses
 * so other DoTs (bleed/burning/poison) still need either combat or a
 * worldTime advance to bite — those have author intent we shouldn't
 * silently override.
 *
 * Suppressed when worldTime has advanced recently: the updateWorldTime tick
 * path already applies status DoTs (see tickActorOverTime → applyStatusDots-
 * OverTicks), so under time-flow or after a manual skip this setInterval
 * would double-tick toxicity. `lastWorldAdvanceMs` is stamped on every
 * forward worldTime advance; if that stamp is within the suppress window,
 * the interval treats the worldTime path as authoritative and skips. */
const REAL_TIME_DOT_INTERVAL_MS = 3000;
const REAL_TIME_DOT_SUPPRESS_MS = 2 * REAL_TIME_DOT_INTERVAL_MS;   // 6s after last worldTime bump
let _realTimeDotTimer = null;
let lastWorldAdvanceMs = 0;
function startRealTimeToxicityDotTimer() {
  if (_realTimeDotTimer) return;
  _realTimeDotTimer = setInterval(async () => {
    try {
      if (!game.user?.isActiveGM) return;
      if (game.combat?.started) return;
      /* Paused world = fiction is frozen. Everything else that advances
       * game state OOC already respects the pause (time-flow.mjs
       * shouldFlow returns false when paused; the updateWorldTime path
       * only fires when someone advances worldTime, which paused
       * time-flow never does), but this wall-clock setInterval kept
       * ticking Alchemy Reborn toxicity damage into a table narrating
       * during a pause. Gate it here so the DoT respects the pause
       * the same way the rest of the OOC clock does. */
      if (game.paused) return;
      // worldTime advanced within the last suppress window → the worldTime
      // tick path is already handling status DoTs; don't double-fire.
      if (lastWorldAdvanceMs && (performance.now() - lastWorldAdvanceMs) < REAL_TIME_DOT_SUPPRESS_MS) return;
      for (const actor of game.actors ?? []) {
        const has = TOXICITY_TIER_STATUS_IDS.some(id => actor.statuses?.has?.(id));
        if (!has) continue;
        await applyStatusDotsOverTicks(actor, 1);
      }
    } catch (err) { console.warn("witcher-ttrpg-death-march | real-time tox DoT failed", err); }
  }, REAL_TIME_DOT_INTERVAL_MS);
}

export function installTickEffects() {
  /* Delete expired effects natively instead of just flagging them. Core
   * defaults expiryAction to "update" (mark duration.expired, keep the
   * document), which means the deleteActiveEffect hook — the single signal the
   * consume/temp-HP/event-ledger reclaim logic listens on — never fires when an
   * effect runs out of time OUT of combat. The symptom was a potion's toxicity
   * lingering after its effect expired on the clock. "delete" makes Foundry
   * remove the effect on expiry everywhere (clock advance AND combat), firing
   * the reclaim hooks; it matches what sweepExpiredEffects already does in
   * combat, so the two are consistent. */
  CONFIG.ActiveEffect.expiryAction = "delete";

  /* Kick off the wall-clock toxicity tier DoT timer once the world is
   * ready. Setting it up at ready (rather than init) means game.actors
   * is populated and game.user is resolved on the first fire. */
  Hooks.once("ready", () => {
    startRealTimeToxicityDotTimer();
    // Seed the outgoing-combatant tracker if a fight is already running (e.g.
    // GM reloaded mid-combat), so the first turn-end after load isn't missed.
    if (game.combat?.started) _activeCombatantId = game.combat.current?.combatantId ?? null;
  });

  Hooks.on("updateCombat", async (combat, update) => {
    if (!("turn" in update) && !("round" in update)) return;
    /* Turn-END status clearing for the OUTGOING combatant. Runs BEFORE the
     * turn-start tick below (end-of-turn precedes start-of-next). GM-side only
     * (one writer), tracked manually because the combat doc is already updated
     * here and its `previous` pointer lags. */
    if (game.user.isActiveGM) {
      const newCurrentId = combat.current?.combatantId ?? combat.combatant?.id ?? null;
      const outgoingId = _activeCombatantId;
      _activeCombatantId = newCurrentId;
      if (outgoingId && outgoingId !== newCurrentId) {
        const outActor = combat.combatants?.get?.(outgoingId)?.actor;
        if (outActor) {
          try { await runTurnEndMutations(outActor); }
          catch (err) { console.warn("witcher-ttrpg-death-march | turn-end status clear failed", err); }
        }
      }
    }
    // roundStart fires before the per-turn tick so a round-scoped buff is in
    // place for the first combatant's turn in the new round.
    if ("round" in update) await fireTriggerForCombat(combat, "roundStart");
    await processTickEffects(combat);
    // Expiry deletes are handled by Foundry's ActiveEffectRegistry via the
    // `expiryAction = "delete"` config above — running our own
    // sweepExpiredEffects alongside it raced (two clients each computed the
    // same expired list, one deleted, the other hit "does not exist").
  });

  /* Out-of-combat ticking: when the GM advances the world clock and no combat
   * is running, per-turn effects fire once every `turnTime` (3s) of world time
   * crossed — the same heal/damage/tick-modify/eachTurn pulses a combat turn
   * would apply. In combat, updateCombat owns ticking (and each round/turn
   * advance also bumps worldTime), so we resync the counter and bail to avoid
   * double-firing.
   *
   * Boundary-anchored, not delta-anchored: the running world clock
   * (time-flow.mjs) fires `updateWorldTime` with delta=1 each real second, so
   * a delta-based `floor(delta/turnTime)` would round to 0 and never tick.
   * Comparing `floor(worldTime/turnTime)` against `lastOocTurnIdx` accumulates
   * across small deltas and still handles a big manual skip in a single shot.
   *
   * Core's ActiveEffect.registry.refresh("updateWorldTime") runs immediately
   * BEFORE this hook (helpers/time.mjs), so durations are already recomputed
   * against the new worldTime and expired effects are already deleted (the
   * expiryAction=delete set at the top of installTickEffects). Any effect
   * still in allApplicableEffects survived the advance — no per-effect
   * alive-window calculation needed. */
  Hooks.on("updateWorldTime", async (worldTime, delta) => {
    if (!game.user.isActiveGM) return;
    if (!(Number(delta) > 0)) return;                 // only forward advances tick
    // Suppress the real-time toxicity DoT interval while worldTime is
    // actively advancing (otherwise both paths would tick toxicity — see
    // startRealTimeToxicityDotTimer). Stamped on every forward advance so
    // manual skips also refresh the suppression window.
    lastWorldAdvanceMs = performance.now();

    // Alchemy pause is handled by the snapshot-on-create /
    // _prepareDuration override / restore-on-delete cycle. No per-tick
    // work needed here — the derived `remaining` for paused AEs returns
    // the frozen snapshot, so Foundry's registry never expires them.

    // Timed-cadence heal actions (minute / hour / day) fire regardless of
    // combat state — they're anchored to the world clock, not the turn
    // engine. Doing this BEFORE the combat short-circuit means a Swallow-
    // style hourly regen keeps ticking even mid-fight if the GM advances
    // the clock.
    for (const actor of game.actors) {
      await tickTimedHeals(actor, worldTime);
    }

    const turnTime = Number(CONFIG.time.turnTime) || 3;
    const newIdx = currentTurnIdx(turnTime);
    if (game.combat?.started) {
      // Combat path owns ticking; resync so the first OOC advance after the
      // fight ends counts from the post-combat baseline rather than firing
      // once for every turn combat consumed.
      lastOocTurnIdx = newIdx;
      return;
    }
    if (lastOocTurnIdx < 0) { lastOocTurnIdx = newIdx; return; }  // first-time init
    let ticks = newIdx - lastOocTurnIdx;
    lastOocTurnIdx = newIdx;
    if (ticks <= 0) return;
    if (ticks > MAX_OOC_TICKS) ticks = MAX_OOC_TICKS;
    for (const actor of game.actors) {
      await tickActorOverTime(actor, ticks);
    }
  });

  /* combatStart is its own hook in v14 (Combat#startCombat) — round 1 doesn't
   * arrive as a "round" delta on updateCombat, so combatStart triggers wouldn't
   * fire from the updateCombat handler above. */
  Hooks.on("combatStart", async (combat) => {
    // Seed the outgoing-combatant tracker with the opening combatant so the
    // first turn's end clears correctly.
    if (game.user.isActiveGM) _activeCombatantId = combat.current?.combatantId ?? null;
    await fireTriggerForCombat(combat, "combatStart");
  });

  /* Combat-end cleanup: clear the `damagedSinceTick` marker for every
   * combatant. It's set on HP loss during combat and cleared at each
   * combatant's turn-tick, but if the fight ends before an actor's turn
   * came around after taking damage, the flag lingers. That would then
   * block Swallow's `undamaged` heal from firing on the next world-clock
   * advance (the OOC path treats "no flag" as trivially undamaged), so
   * the actor would look stuck-not-regenerating until another combat
   * ticks them. Clearing on delete is the safest cutover point. */
  Hooks.on("deleteCombat", async (combat) => {
    if (!game.user.isActiveGM) return;
    // Resync the OOC turn counter to the current worldTime so the first
    // post-combat OOC advance counts from now, not from before the fight.
    // Belt-and-braces: the in-combat updateWorldTime path already resyncs
    // on every combat-driven advance, but a combat that started/ended
    // without moving worldTime would leave the counter stale.
    const turnTime = Number(CONFIG.time.turnTime) || 3;
    lastOocTurnIdx = currentTurnIdx(turnTime);

    const seen = new Set();
    for (const c of combat.turns ?? []) {
      const actor = c.actor;
      if (!actor || seen.has(actor.id)) continue;
      seen.add(actor.id);
      if (actor.getFlag(MODULE_ID, "damagedSinceTick")) {
        await engineUpdate(actor, { [`flags.${MODULE_ID}.damagedSinceTick`]: false });
      }
    }
  });

  /* Per-round state tracking for the heal-gate conditions (Swallow etc.).
   * preUpdate sees both old and new values, so it decides direction and
   * stashes a marker in `options`; updateActor (GM-side) writes the round
   * number to a flag the tick engine reads. The flag write only fires
   * during an active combat, so there's no churn outside encounters. */
  Hooks.on("preUpdateActor", (actor, changes, options) => {
    // Loop guard: the engine's own writes (engineUpdate) must not re-trigger
    // event detection, or "+1 adrenaline on adrenaline gain" would run away.
    if (options?.[MODULE_ID]?.engineApplied) return;
    // NOTE: manual writes are intentionally NOT excluded — a manual INCREASE to
    // a resource counts as a real gain and fires its on-gain effect scaled by
    // the amount (adrenalineGain / Regenerating). Only the engine's own writes
    // (engineApplied, above) are skipped, so the effect's own +N write can't
    // re-trigger. A manual DECREASE never matches `> oldAdr`, so it fires nothing.

    const newAdr = foundry.utils.getProperty(changes, "system.adrenaline.value");
    const oldAdr = Number(actor.system?.adrenaline?.value);
    // adrenalineGain fires whenever adrenaline rises — combat or not.
    if (newAdr !== undefined && Number(newAdr) > oldAdr) {
      foundry.utils.setProperty(options, `${MODULE_ID}.adrGain`, Number(newAdr) - oldAdr);
    }

    // Regenerating(N) — stash any HP RISE (a heal) so equipped Regenerating
    // gear can grant N extra HP on it. Fires combat or not, like adrenalineGain.
    const newHpRise = foundry.utils.getProperty(changes, "system.derivedStats.hp.value");
    const oldHpRise = Number(actor.system?.derivedStats?.hp?.value);
    if (newHpRise !== undefined && Number(newHpRise) > oldHpRise) {
      foundry.utils.setProperty(options, `${MODULE_ID}.hpGain`, Number(newHpRise) - oldHpRise);
    }

    // Per-round markers for the heal-gate conditions (Swallow etc.) only have
    // meaning inside an active combat.
    if (!game.combat?.started) return;
    const round = game.combat.round;
    const newHp = foundry.utils.getProperty(changes, "system.derivedStats.hp.value");
    const oldHp = Number(actor.system?.derivedStats?.hp?.value);
    const marks = {};
    if (newHp  !== undefined && Number(newHp)  < oldHp)  marks.damaged    = round;
    if (newAdr !== undefined && Number(newAdr) > oldAdr) marks.adrenaline = round;
    if (Object.keys(marks).length) {
      foundry.utils.setProperty(options, `${MODULE_ID}.roundMarks`, marks);
    }
  });

  Hooks.on("updateActor", async (actor, _changes, options) => {
    if (!game.user.isActiveGM) return;
    if (options?.[MODULE_ID]?.engineApplied) return;

    const marks = options?.[MODULE_ID]?.roundMarks;
    if (marks) {
      const upd = {};
      if (marks.damaged    !== undefined) upd[`flags.${MODULE_ID}.damagedSinceTick`]    = true;
      if (marks.adrenaline !== undefined) upd[`flags.${MODULE_ID}.lastAdrenalineRound`] = marks.adrenaline;
      if (Object.keys(upd).length) await actor.update(upd);
    }

    const adrGain = options?.[MODULE_ID]?.adrGain;
    if (adrGain > 0) {
      await fireTrigger(actor, "adrenalineGain", adrGain);
      /* Adrenalized(N) rune — a "real" (non-engine) adrenaline gain grants N
       * more from the actor's equipped Adrenalized runes, capped at BODY.
       * Written through engineUpdate so the loop guard skips re-detecting it
       * (no runaway), exactly like an AE-driven "+N adrenaline on gain". */
      const adrBonus = equippedAdrenalizedBonus(actor);
      if (adrBonus > 0) {
        const cur = Number(actor.system?.adrenaline?.value);
        const cap = Number(actor.system?.stats?.body?.value) || 0;
        if (Number.isFinite(cur)) {
          const next = Math.min(cur + adrBonus, cap);
          if (next > cur) await engineUpdate(actor, { "system.adrenaline.value": next });
        }
      }
    }

    /* Regenerating(N) rune/glyph — a "real" (non-engine) HP heal grants N more
     * HP from equipped Regenerating gear, capped at max HP. engineUpdate stamps
     * the write so the loop guard skips re-detecting it (no runaway). */
    const hpGain = options?.[MODULE_ID]?.hpGain;
    if (hpGain > 0) {
      const regen = equippedRegeneratingBonus(actor);
      if (regen > 0) {
        const cur = Number(actor.system?.derivedStats?.hp?.value);
        const max = Number(actor.system?.derivedStats?.hp?.max) || 0;
        if (Number.isFinite(cur) && max > 0) {
          const next = Math.min(cur + regen, max);
          if (next > cur) await engineUpdate(actor, { "system.derivedStats.hp.value": next });
        }
      }
    }
  });

  /* Temp HP grant (one-shot): an effect carrying a tempHp action grants a
   * non-regenerable buffer once, when it lands on an actor, and that buffer
   * is clawed back when the effect is removed. GM-only so the buffer is
   * written exactly once. */
  Hooks.on("createActiveEffect", async (effect) => {
    if (!game.user.isActiveGM) return;
    await syncTempHp(effect);
    await syncOneOffBumps(effect);
  });
  /* The tempHp action is almost always added/edited AFTER the blank effect is
   * created (the config sheet's Save is an update, not a create), and toggling
   * the effect on/off is also an update — so reconcile here too, not just on
   * create. syncTempHp is idempotent: it grants once and never re-rolls. */
  Hooks.on("updateActiveEffect", async (effect) => {
    if (!game.user.isActiveGM) return;
    await syncTempHp(effect);
    await syncOneOffBumps(effect);
    // A disabled effect's event mutations are reverted, same as on delete —
    // toggling the effect off should undo what its triggers accumulated.
    if (effect.disabled) await reclaimEventActions(effect);
  });
  Hooks.on("deleteActiveEffect", async (effect) => {
    if (!game.user.isActiveGM) return;
    await reclaimTempHp(effect);
    // One-off pool bumps are FIRE-AND-FORGET — no reclaim on delete. The
    // granted amount is now part of the actor's baseline for that pool
    // (matches tempHp's "grant and forget" model). The per-effect latch
    // flag lives on as dead data keyed by a gone effect id; harmless.
    await reclaimEventActions(effect);
    await reclaimTimedHealLedger(effect);
  });

  /* Heal / damage actions are edited on the AE config's unified "Effects"
   * tab (WitcherActiveEffectConfig) — see templates/active-effect/effects.hbs.
   * No DOM injection here anymore. */
}

/* The actor a (possibly item-owned / transferred) effect applies to. */
function effectActor(effect) {
  return effect?.parent instanceof Actor ? effect.parent : (effect?.parent?.actor ?? null);
}

/* ── Manual per-effect pause ──────────────────────────────────────────────
 *
 * The user pauses / resumes individual AEs by clicking a button on the actor
 * sheet or chrome UI. Semantics:
 *   Pause  → snapshot the AE's current remaining seconds into a flag. The
 *            _prepareDuration override on WitcherActiveEffect reads the flag
 *            and returns the frozen value on every prep cycle. Foundry's
 *            registry-refresh sees a positive remaining and never expires
 *            the AE. Tick engine also skips per-turn / cadence firings while
 *            the flag is set.
 *   Resume → restore the AE's start.time so live `remaining` equals the
 *            snapshot at the unpause moment. Clear the flag. Reset heal-
 *            cadence anchors to now so heals don't over-fire catch-up doses.
 *
 * Applies to any AE with a time-based duration (seconds/minutes/hours/days).
 * Round-based durations are unaffected (they only advance in combat and the
 * flag never gets set for them — _rawRemainingSecs returns null). */

/* Seconds-per-unit for a Foundry v14 duration.units value. */
const DURATION_UNIT_SECONDS = Object.freeze({
  seconds: 1, minutes: 60, hours: 3600, days: 86400, weeks: 604800,
  months: 2628000, years: 31536000
});

/* Compute an AE's current remaining seconds. Handles both v14 shapes for
 * time-based durations:
 *   (a) authored as {units, value}   — e.g. {units:"minutes", value:5}
 *   (b) authored as {seconds}        — Foundry-computed total in seconds,
 *                                       populated by _prepareDuration
 *
 * Prefer the DERIVED `duration.secondsRemaining` when available (Foundry
 * already computed it against the current worldTime) — that's the value
 * displayed in the UI, so freezing it matches what the user sees. Fall
 * back to raw math for AEs whose derived duration hasn't been prepared
 * yet. Returns null for durations we won't pause (round/turn/none). */
function _rawRemainingSecs(effect) {
  if (!effect) return null;
  // 1. Prefer derived secondsRemaining — already computed correctly by
  //    Foundry's _prepareDuration (uses start.time + secondsPer * value − now).
  const derivedRem = Number(effect.duration?.secondsRemaining);
  if (Number.isFinite(derivedRem)) return Math.max(0, derivedRem);
  // 2. Fall back to raw. Read units/value + seconds — v14 shapes both work.
  const src = effect._source?.duration ?? {};
  const der = effect.duration ?? {};
  const units = src.units ?? der.units;
  const value = Number(src.value ?? der.value ?? 0);
  const secondsPer = DURATION_UNIT_SECONDS[units] ?? 0;
  let totalSecs;
  if (secondsPer > 0 && value > 0) {
    totalSecs = value * secondsPer;
  } else {
    // Foundry v14 duration.seconds is the computed total in seconds.
    totalSecs = Number(src.seconds ?? der.seconds ?? 0);
  }
  if (!(totalSecs > 0)) return null;
  const now = Number(game.time?.worldTime ?? 0);
  const startTime = Number(effect.start?.time ?? effect._source?.start?.time ?? now);
  return Math.max(0, startTime + totalSecs - now);
}

/* True while this AE has been manually paused (pausedRemainingSecs flag set).
 * Read by tick-engine's per-turn / cadence loops to skip firings, and by
 * WitcherActiveEffect._prepareDuration to freeze the derived remaining. */
export function isEffectPaused(effect) {
  return effect?.getFlag?.(MODULE_ID, "pausedRemainingSecs") != null;
}

/* Snapshot the AE's remaining seconds into a flag. No-op if already paused
 * or if the AE has no time-based duration. */
export async function pauseEffect(effect) {
  if (!effect) return;
  if (isEffectPaused(effect)) return;
  const secs = _rawRemainingSecs(effect);
  if (secs == null) {
    ui.notifications?.warn?.(tFormat("WITCHER.Chrome.TickEffects.Notify.NoTimeDurationToPause", { name: effect.name }, `${effect.name}: no time-based duration to pause.`));
    return;
  }
  try {
    await effect.update({ [`flags.${MODULE_ID}.pausedRemainingSecs`]: secs });
  } catch (err) { console.warn(`${MODULE_ID} | pauseEffect failed`, err); }
}

/* Restore start.time so live remaining equals the snapshot, drop the flag,
 * reset heal-cadence anchors to now. No-op if not paused.
 *
 * Total duration is computed from `effect._source.duration.value * unit`
 * — NOT from `effect.duration.seconds`, because our own `_prepareDuration`
 * override overwrites the derived `duration.seconds` with the paused
 * snapshot value while the AE is paused (so the UI shows the frozen
 * remaining). Reading from _source sidesteps that: the source keeps the
 * authored value + units regardless of pause state. */
export async function resumeEffect(effect) {
  if (!effect) return;
  const snap = Number(effect.getFlag?.(MODULE_ID, "pausedRemainingSecs"));
  if (!Number.isFinite(snap)) return;
  const src = effect._source?.duration ?? {};
  const units = src.units ?? effect.duration?.units;
  const value = Number(src.value ?? effect.duration?.value ?? 0);
  const secondsPer = DURATION_UNIT_SECONDS[units] ?? 0;
  const totalSecs = (secondsPer > 0 && value > 0) ? (value * secondsPer) : 0;
  if (!(totalSecs > 0)) {
    /* No time-based duration on source — just clear the flag so we don't
     * leave the AE stuck paused. Nothing to re-anchor. */
    try { await effect.update({ [`flags.${MODULE_ID}.pausedRemainingSecs`]: new foundry.data.operators.ForcedDeletion() }); }
    catch (err) { console.warn(`${MODULE_ID} | resumeEffect flag-clear failed`, err); }
    return;
  }
  const worldTime = Number(game.time?.worldTime ?? 0);
  const nextStart = worldTime - totalSecs + snap;
  try {
    /* Nested-object form for `start` — Foundry v14 pattern used in
     * BaseActiveEffect._preCreate (updateSource({start})). The dot-
     * notation form ("start.time": X) is technically valid via
     * expandObject, but in combination with a flag-delete key in the
     * SAME update() call some builds were observed to drop the
     * start.time write silently, leaving the AE with its original
     * (creation) start.time and thus its full original duration
     * remaining — the "unpause resets to full" symptom. */
    await effect.update({
      start: { time: nextStart },
      [`flags.${MODULE_ID}.-=pausedRemainingSecs`]: null
    });
  } catch (err) { console.warn(`${MODULE_ID} | resumeEffect failed`, err); }
  // Reset healTickAt for this effect so cadence heals resume from now.
  const actor = effectActor(effect);
  const anchors = actor?.flags?.[MODULE_ID]?.healTickAt?.[effect.id];
  if (anchors && typeof anchors === "object") {
    const patch = {};
    for (const idx of Object.keys(anchors)) {
      patch[`flags.${MODULE_ID}.healTickAt.${effect.id}.${idx}`] = worldTime;
    }
    try { await engineUpdate(actor, patch); }
    catch (err) { console.warn(`${MODULE_ID} | resumeEffect heal-anchor reset failed`, err); }
  }
}

/* One-shot toggle — pause → resume → pause. */
export async function toggleEffectPause(effect) {
  return isEffectPaused(effect) ? resumeEffect(effect) : pauseEffect(effect);
}

/* True if the effect carries at least one tempHp action with a non-empty
 * amount. Drives whether the effect should currently own a temp-HP grant. */
function hasTempHpAction(effect) {
  return effectActions(effect).some(
    a => a?.type === "tempHp" && String(a?.amount ?? "").trim() !== ""
  );
}

/* Reconcile this effect's temp-HP contribution. One-shot + idempotent: grants
 * exactly once (the first time the effect is active AND carries a tempHp
 * action), and reclaims if it later goes disabled or loses the action. The
 * per-effect grant RECORD (presence of flags.<MODULE_ID>.tempHpGrants[id]) is
 * the latch — so editing the effect again never re-rolls or double-grants.
 * Routed from create, update, and the enable/disable toggle. */
async function syncTempHp(effect) {
  const actor = effectActor(effect);
  if (!actor?.system?.derivedStats?.hp) return;
  const grants    = actor.flags?.[MODULE_ID]?.tempHpGrants ?? {};
  const hasRecord = Object.prototype.hasOwnProperty.call(grants, effect.id);
  const wants     = !effect.disabled && hasTempHpAction(effect);
  if      (wants  && !hasRecord) await grantTempHp(effect);
  else if (!wants &&  hasRecord) await reclaimTempHp(effect);
}

/* Grant temp HP once. Take-higher: a grant only raises the buffer if it
 * exceeds the current temp; the amount it actually ADDED is recorded per
 * effect (flags.<MODULE_ID>.tempHpGrants[effectId]) so reclaimTempHp can
 * remove exactly that much on delete. The record is ALWAYS written when a
 * tempHp action is present (even if take-higher suppressed the buffer bump to
 * 0) — it's the latch that stops syncTempHp re-rolling on later edits. */
async function grantTempHp(effect) {
  if (effect?.disabled) return;
  const actor = effectActor(effect);
  if (!actor?.system?.derivedStats?.hp) return;
  let added = 0;
  for (const action of effectActions(effect)) {
    if (action?.type !== "tempHp") continue;
    const grant = await rollOrFlat(String(action?.amount ?? "").trim());
    if (grant > 0) added = Math.max(added, grant);
  }
  if (added <= 0) return;
  const curTemp = Math.max(0, Number(actor.system.derivedStats.hp.temp) || 0);
  const delta   = Math.max(0, added - curTemp);   // take-higher: don't stack
  const upd = { [`flags.${MODULE_ID}.tempHpGrants.${effect.id}`]: delta };
  if (delta > 0) upd["system.derivedStats.hp.temp"] = curTemp + delta;
  await actor.update(upd);
}

/* Remove the buffer a tempHp effect added, capped at what's left (damage may
 * already have drained some). Clears the per-effect grant record. */
async function reclaimTempHp(effect) {
  const actor = effectActor(effect);
  if (!actor) return;
  const grants = actor.flags?.[MODULE_ID]?.tempHpGrants ?? {};
  if (!Object.prototype.hasOwnProperty.call(grants, effect.id)) return;
  const added   = Math.max(0, Number(grants[effect.id]) || 0);
  const curTemp = Math.max(0, Number(actor.system?.derivedStats?.hp?.temp) || 0);
  const upd = { [`flags.${MODULE_ID}.tempHpGrants.-=${effect.id}`]: null };
  if (added > 0) upd["system.derivedStats.hp.temp"] = Math.max(0, curTemp - added);
  await actor.update(upd);
}

/* ──────────────────────────────────────────────────────────────────────────
 * One-off pool bumps (WHEN clause = "onceOnApply" on a modify action)
 *
 * Semantics: on effect apply, roll the value (dice or flat), and BUMP the
 * target's source value by the rolled amount — a current-pool boost the
 * player can spend (STA regen, HP regen, adrenaline points, etc.). On
 * effect removal, subtract the same amount from the source, clamped at 0.
 * A per-effect ledger (flags.<sys>.oneOffBumps[effectId]) records
 * `{ target, amount }[]` so reclaim knows exactly what to undo — and doubles
 * as an idempotency latch so re-firing the create/update hook can't grant
 * twice.
 *
 * Different from tempHp: temp HP is a specific field (hp.temp) that damage
 * eats first; one-off bumps write to any target the user picks (typically
 * the .value of a pool) so the boost lives inside the normal pool rules.
 * ──────────────────────────────────────────────────────────────────────── */

function isOneOffBumpAction(a) {
  return a?.type === "modify" && a?.when === "onceOnApply" && a?.target
      && String(a?.value ?? "").trim() !== "";
}

function hasOneOffBumpAction(effect) {
  return effectActions(effect).some(isOneOffBumpAction);
}

/* Reconcile the effect's one-off bumps. Fire-and-forget: grant once when
 * the effect is first active AND carries a bump action; NEVER reclaim.
 * The per-effect ledger flag exists solely as an idempotency latch so
 * re-toggling / re-editing the AE can't re-grant. If the effect is later
 * disabled or removed, the granted amount stays with the actor — that's
 * the whole point (matches tempHp's "grant and forget" behavior). */
async function syncOneOffBumps(effect) {
  const actor = effectActor(effect);
  if (!actor) return;
  const records = actor.flags?.[MODULE_ID]?.oneOffBumps ?? {};
  const hasRecord = Object.prototype.hasOwnProperty.call(records, effect.id);
  const wants     = !effect.disabled && hasOneOffBumpAction(effect);
  if (wants && !hasRecord) await grantOneOffBumps(effect);
}

/* Grant this effect's one-off bumps. Rolls each qualifying action's value
 * once and adds it to the target's source. Reads and writes each target in
 * a single actor.update so multiple bumps on the same target don't stomp
 * each other. Writes the ledger unconditionally when a bump action is
 * present so the latch stops re-firing even if the roll produced 0.
 *
 * Fire-and-forget: NO reclaim on effect end. The bump becomes the actor's
 * new baseline for that pool (like tempHp: once granted, it's yours).
 *
 * Prefer the pre-rolled value from `flags.<sys>.rolledValues[i]` when
 * present — consume-item / _preCreate populate that cache. Fall back to a
 * fresh rollOrFlat when the cache is missing (a GM manually toggling an
 * already-created AE, a macro-added AE, etc.). */
async function grantOneOffBumps(effect) {
  if (effect?.disabled) return;
  const actor = effectActor(effect);
  if (!actor) return;

  const rolledCache = effect?.getFlag?.(MODULE_ID, "rolledValues") ?? {};
  const targetDeltas = new Map();   // target path → integer bump (signed)
  const actionList = effectActions(effect);
  for (let i = 0; i < actionList.length; i++) {
    const action = actionList[i];
    if (!isOneOffBumpAction(action)) continue;
    let magnitude;
    if (Object.prototype.hasOwnProperty.call(rolledCache, i)) {
      magnitude = Math.floor(Number(rolledCache[i]) || 0);
    } else {
      const rolled = await rollOrFlat(String(action.value ?? "").trim());
      magnitude = Math.floor(Number(rolled) || 0);
    }
    const op = effectOperation(normalizeAction(action).op);
    const sign = op?.negate ? -1 : 1;
    const amount = magnitude * sign;
    if (amount) targetDeltas.set(action.target, (targetDeltas.get(action.target) || 0) + amount);
  }

  // The ledger stores `true` as a latch — reclaim is gone, so we don't
  // need per-target amounts anymore. Just enough to say "we already fired
  // for this effect id, don't re-grant".
  const upd = { [`flags.${MODULE_ID}.oneOffBumps.${effect.id}`]: true };
  for (const [target, delta] of targetDeltas) {
    const cur = Number(foundry.utils.getProperty(actor, target)) || 0;
    upd[target] = Math.max(0, cur + delta);
  }
  await actor.update(upd);
}

/* Evaluate a heal-gate condition against the per-round markers stamped on
 * the actor.
 *
 * Out-of-combat handling: `damagedSinceTick` is only written during active
 * combat (see the preUpdateActor guard at "if (!game.combat?.started) return"),
 * so OOC every tick is trivially "undamaged". Swallow's authored gate is
 * `undamaged`, and the intended fiction — a witcher sipping Swallow at rest
 * regenerates — needs `undamaged` to pass OOC so world-clock ticks fire the
 * heal action. `damaged` is trivially false OOC for the same reason (nothing
 * writes the flag), and `adrenaline` is combat-only by definition. */
function healPassesCondition(actor, cond) {
  if (!cond || cond === "always") return true;
  const inCombat = !!game.combat?.started;
  // damaged/undamaged track HP loss SINCE THE ACTOR'S LAST TICK, not the
  // calendar round: the heal fires on the actor's turn, so damage taken last
  // round (after the prior heal) must still block this round's heal. The marker
  // is set on HP loss (preUpdateActor/updateActor) and cleared after each tick.
  switch (cond) {
    case "undamaged":  return !actor.getFlag(MODULE_ID, "damagedSinceTick");
    case "damaged":    return !!actor.getFlag(MODULE_ID, "damagedSinceTick");
    case "adrenaline": return inCombat && actor.getFlag(MODULE_ID, "lastAdrenalineRound") === game.combat.round;
    default:           return true;
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * Combat → tick everyone who hasn't ticked yet this round
 * ────────────────────────────────────────────────────────────────────────── */

async function processTickEffects(combat) {
  if (!game.user.isActiveGM) return;
  const newRound      = combat.round;
  const newCurrentId  = combat.current?.combatantId;
  if (!newCurrentId) return;
  const turnOrder = combat.turns;
  const newIdx    = turnOrder.findIndex(c => c.id === newCurrentId);
  if (newIdx < 0) return;

  const stored    = combat.flags?.[MODULE_ID]?.tickedRound
                 ?? combat.flags?.[LEGACY_MOD]?.tickedRound
                 ?? { round: 0, ids: [] };
  const sameRound = stored.round === newRound;

  /* ROUND CHANGE: catch up any combatants in the previous round who got
   * leapfrogged (GM clicked "next round" mid-round). One tick each. */
  if (!sameRound && stored.round > 0) {
    const prevTicked = new Set(stored.ids);
    for (const c of turnOrder) {
      if (!c || prevTicked.has(c.id)) continue;
      if (c.actor) await tickActor(c.actor);
    }
  }

  /* CURRENT ROUND: tick everyone from index 0 to newIdx who hasn't been
   * ticked yet this round. Normal next-turn → just the new current
   * combatant. */
  const tickedIds = sameRound ? new Set(stored.ids) : new Set();
  for (let i = 0; i <= newIdx; i++) {
    const c = turnOrder[i];
    if (!c || tickedIds.has(c.id)) continue;
    if (c.actor) await tickActor(c.actor);
    tickedIds.add(c.id);
  }
  await combat.setFlag(MODULE_ID, "tickedRound", { round: newRound, ids: Array.from(tickedIds) });
}

/* Delete effects whose duration has run out. Foundry only marks expired
 * effects inactive (and only for TIME-based durations — combat rounds/turns
 * never set duration.expired in v14), and it never deletes them, so without
 * this they linger on the sheet forever.
 *
 * v14 duration is {value, units}; `remaining` is the reliable expiry signal
 * for every unit type. It is recomputed at data-prep time, so we call the
 * public updateDuration() with the CURRENT round/turn to avoid acting on a
 * stale value. Permanent / unanchored durations report remaining === Infinity
 * and are left alone. Works on actor-direct AND item-transferred effects
 * (delete() routes to the effect's parent either way). GM-only. */
async function sweepExpiredEffects(combat) {
  if (!game.user.isActiveGM) return;
  const seen = new Set();
  for (const c of combat.turns) {
    const actor = c.actor;
    if (!actor) continue;
    for (const effect of actor.allApplicableEffects()) {
      if (seen.has(effect.id)) continue;
      seen.add(effect.id);
      let remaining = effect.duration?.remaining;
      try {
        remaining = effect.updateDuration({ round: combat.round, turn: combat.turn })?.remaining
                 ?? remaining;
      } catch (_) { /* fall back to the already-prepared remaining */ }
      if (Number.isFinite(remaining) && remaining <= 0) {
        try { await effect.delete(); } catch (_) { /* already gone */ }
      }
    }
  }
}

/* Run an effect's instantaneous (heal / damage) actions once against `actor`,
 * regardless of whose document the effect lives on. Used by the consume flow
 * for duration-less "instant" potion effects — the same pulse a turn-tick
 * would apply, fired a single time. Modifier/condition/event actions are NOT
 * run here: those only mean something while a hosting effect is present, so a
 * lingering effect (one with a duration) carries them instead.
 *
 * Optional `report` array: if provided, each fired action pushes a
 * `{ kind, formula, rolled }` entry so the caller (e.g. consume-item) can
 * surface roll totals in its own chat card. The apply helpers still post
 * their own combat cards — this is purely a data breadcrumb. */
export async function applyInstantEffectActions(actor, effect, report = null) {
  if (!actor || !effect) return;
  for (const action of effectActions(effect)) {
    if (action?.type === "heal") {
      const formula = String(action?.amount ?? "").trim();
      if (report && formula) {
        // Pre-roll for the report, then hand a numeric copy to applyHealAction
        // so the healing that lands matches the number the card reports.
        const rolled = await rollOrFlat(formula);
        report.push({ kind: "heal", formula, rolled });
        await applyHealAction(actor, effect, { ...action, amount: String(rolled) });
      } else {
        await applyHealAction(actor, effect, action);
      }
    } else if (action?.type === "damage") {
      const formula = String(action?.formula ?? "").trim();
      if (report && formula) {
        const rolled = await rollOrFlat(formula);
        report.push({ kind: "damage", formula, rolled });
        await applyDamageAction(actor, effect, { ...action, formula: String(rolled) });
      } else {
        await applyDamageAction(actor, effect, action);
      }
    } else if (action?.type === "purge") {
      await actor.purgeToxicEffects?.();
    }
  }
}

async function tickActor(actor) {
  // Per-turn event-modifier triggers (eachTurn / tookDamage / undamaged) fire
  // once per turn, before the heal/damage tick.
  await fireTurnTriggers(actor);

  /* allApplicableEffects() — NOT actor.effects — so effects transferred from
   * owned items (e.g. an effect configured on a potion) tick too. `.active`
   * is false for disabled / suppressed / expired effects, which also gives
   * us the duration cutoff for free. */
  for (const effect of actor.allApplicableEffects()) {
    if (!effect.active) continue;
    for (const action of effectActions(effect)) {
      // Heal cadence gate — non-turn cadences (minute/hour/day) fire from
      // the world-time firer instead of the turn tick.
      if (action?.type === "heal" && healCadenceOf(action) !== "turn") continue;
      if (action?.type === "heal")        await applyHealAction(actor, effect, action);
      else if (action?.type === "damage") await applyDamageAction(actor, effect, action);
      else if (action?.type === "modify" && effectTrigger(action?.when)?.mode === "tick")
        await applyTickModify(actor, effect, action);
    }
  }

  // Status-effect damage-over-time (poison/bleed/burning/acid/suffocation),
  // read THROUGH the clause registry and routed through the same armor- and
  // location-aware damage path as authored effects.
  await applyStatusDots(actor);

  // GM-side status bookkeeping at the bearer's turn start: auto-clear lapsing
  // statuses (staggered) and roll periodic saves (nausea). State only — the
  // owner-side end-check prompts run from the combat-round reset policy.
  await runTurnStartMutations(actor);

  // Per-tick reset: this turn's triggers and heals have now read the damage
  // marker, so clear it. Next turn starts "undamaged" until HP drops again.
  // engineApplied-stamped so the clear isn't itself seen as a trigger event.
  if (actor.getFlag(MODULE_ID, "damagedSinceTick")) {
    await engineUpdate(actor, { [`flags.${MODULE_ID}.damagedSinceTick`]: false });
  }
}

/* Localized display label for a status id, from the registered effect set. */
function statusDisplayLabel(id) {
  const def = (CONFIG.statusEffects ?? []).find(s => s.id === id);
  const name = def?.name ?? def?.label;
  return name ? game.i18n.localize(name) : id;
}

/* Apply each active status's DoT clause once. Synthesizes a damage action from
 * the clause and reuses applyDamageAction so armor SP, hit-location multipliers,
 * and the every-location scope are all honored. bypassArmor → throughArmor;
 * scope "all-locations" → everyLocation (else torso). A clause may also carry
 * `dot.ablateArmor: N` (burning/fire) — after the wearer takes the hit, the
 * flames erode N SP off the armor covering each affected location (once per
 * turn, NOT multiplied by stacked instances). */
async function applyStatusDots(actor) {
  // DoT stacks PER INSTANCE: count how many active effects carry each DoT
  // status, so e.g. two bleeding critical wounds tick twice (2+2) rather than
  // collapsing to one doubled tick. A single-source status (combat bleed) is
  // one effect → one tick, unchanged.
  const counts = new Map();
  for (const e of (actor.appliedEffects ?? actor.effects ?? [])) {
    if (e.disabled || e.system?.isSuppressed) continue;
    for (const id of (e.statuses ?? [])) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const [id, instances] of counts) {
    const dot = clauseFor(id, actor)?.dot;
    // amount can be a flat number or a dice formula ("1d6+2"); pass it to
    // applyDamageAction as a string so rollOrFlat evaluates it per instance.
    let amount = dot?.amount == null ? "" : String(dot.amount).trim();
    /* CE Combat Extended chokehold damage — suffocation induced by an
     * active chokeheld pair uses `3 + max(0, choker.meleeBonus)`
     * instead of the clause's flat 3. Only fires when CE is on AND
     * this actor is the TARGET of at least one chokeheld pair; other
     * sources of suffocation (drowning, poison) still use the flat
     * clause amount. */
    if (id === "suffocation") {
        const ceAmt = ceChokeholdDoTAmount(actor);
        if (typeof ceAmt === "number") amount = String(ceAmt);
    }
    if (!amount || amount === "0") continue;
    /* Cadence gate: a clause may declare `dot.cadence: N` to mean "fire
     * the damage every N turns, not every turn". Used by Alchemy Reborn's
     * toxicity tiers (Slight = every 3 turns, Strong = every 2). Default
     * cadence 1 → every turn, matching the legacy behaviour. We anchor
     * on combat.round so two same-cadence effects always fire on the
     * same rounds (no per-actor drift); out of combat there's no round
     * counter — caller in tickEffect handles that path separately. */
    const cadence = Math.max(1, Number(dot?.cadence) || 1);
    if (cadence > 1) {
      const round = Number(game.combat?.round) || 0;
      if (round <= 0 || (round % cadence) !== 0) continue;
    }
    /* Ablation values passed as raw strings so dice formulas
     * ("1d6", "1d3+1") survive to applyDamageAction's rollOrFlat.
     * Empty / "0" strings are no-ops downstream. Only the first
     * instance carries them so stacks don't multiply per-turn
     * erosion. */
    const ablate       = String(dot?.ablateArmor  ?? "").trim();
    const ablateWeapon = String(dot?.ablateWeapon ?? "").trim();
    const clause = clauseFor(id, actor);
    for (let i = 0; i < instances; i++) {
      const action = {
        type: "damage",
        formula: amount,
        locations: dot.scope === "all-locations" ? ["everyLocation"] : ["torso"],
        throughArmor: !!dot.bypassArmor,
        ablateArmor:  i === 0 ? ablate       : "",
        ablateWeapon: i === 0 ? ablateWeapon : "",
        ablateArmorOnlyIfPenetrated:  !!dot.ablateArmorOnlyIfPenetrated,
        ablateWeaponOnlyIfPenetrated: !!dot.ablateWeaponOnlyIfPenetrated,
        // Custom-status DoTs may declare a damage type so monster damageProfile
        // (immune → 0×, resistant → 0.5×, vulnerable → 2×) applies. Empty for
        // untyped world statuses — applyDamageAction skips the multiplier.
        damageType: String(dot.damageType ?? ""),
        // Status id + countsAs so applyDamageAction can look up
        // statusImmunities / statusResistances (monster.combat.*) and halve /
        // zero the DoT accordingly. countsAs is the custom-status "treat this
        // as [ids]" list — poisoned countsAs of a spider-poison AE lets a
        // poison-resistant monster resist the spider-poison DoT too.
        statusId: id,
        statusCountsAs: Array.isArray(clause?.countsAs) ? clause.countsAs : []
      };
      await applyDamageAction(actor, { name: statusDisplayLabel(id) }, action);
    }
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * Out-of-combat ticking over a world-clock advance
 * ────────────────────────────────────────────────────────────────────────── */

/* True if the effect would do anything on a per-turn tick: a TURN-cadence
 * heal, any damage, a recurring "tick"-mode modify, or an eachTurn
 * event-modifier. Non-turn-cadence heals are handled by tickTimedHeals and
 * intentionally excluded here — a Swallow-style hourly regen shouldn't
 * fire on every combat turn. */
function hasPerTurnAction(effect) {
  for (const action of effectActions(effect)) {
    if (action?.type === "heal" && healCadenceOf(action) === "turn") return true;
    // Damage counts as per-turn ONLY at turn cadence; minute/hour/day damage
    // fires from the world-time path (tickTimedActions), same as heal.
    if (action?.type === "damage" && healCadenceOf(action) === "turn") return true;
    if (action?.type === "modify" && effectTrigger(action?.when)?.mode === "tick") return true;
  }
  return eventActionsOf(effect).some(({ a }) => a.when === "eachTurn");
}

/* ── World-time cadence heals ─────────────────────────────────────────────
 *
 * Heal actions can carry a `cadence` field: "turn" (default, fires from the
 * combat/OOC turn engine), "minute", "hour", or "day" (fire on world-clock
 * crossings from updateWorldTime, regardless of combat state).
 *
 * Bookkeeping: per-(effect id, action index) last-fire timestamp stored at
 *   actor.flags.<sys>.healTickAt[effectId][actionIndex] = worldTimeSeconds
 * On each world-time advance we compute how many whole cadence intervals
 * have elapsed since lastFireAt and fire that many doses. Capped at
 * MAX_OOC_TICKS so a huge time-skip can't hang the engine.
 * ──────────────────────────────────────────────────────────────────────── */

const CADENCE_SECONDS = Object.freeze({
  minute: 60,
  hour:   3600,
  day:    86400
});

function healCadenceOf(action) {
  const raw = String(action?.cadence ?? "turn").trim().toLowerCase();
  return (raw === "minute" || raw === "hour" || raw === "day") ? raw : "turn";
}

async function tickTimedHeals(actor, worldTime) {
  if (!actor) return;
  const now = Number(worldTime);
  if (!Number.isFinite(now)) return;
  const store = actor.flags?.[MODULE_ID]?.healTickAt ?? {};
  const upd = {};
  let dirty = false;

  for (const effect of actor.allApplicableEffects()) {
    if (!effect.active) continue;
    const perEffect = store[effect.id] ?? {};
    const actions = effectActions(effect);
    // Manual pause: freeze cadence anchors to `now` while this specific
    // effect is paused so on resume the next fire is one full interval
    // away rather than a catch-up burst.
    const skipForPause = isEffectPaused(effect);
    for (let index = 0; index < actions.length; index++) {
      const action = actions[index];
      // Both heal AND damage actions honor a non-turn cadence here (turn
      // cadence fires from the per-turn engine instead).
      if (action?.type !== "heal" && action?.type !== "damage") continue;
      const cadence = healCadenceOf(action);
      if (cadence === "turn") continue;
      const interval = CADENCE_SECONDS[cadence];
      if (!(interval > 0)) continue;

      if (skipForPause) {
        upd[`flags.${MODULE_ID}.healTickAt.${effect.id}.${index}`] = now;
        dirty = true;
        continue;
      }

      // First-time seed: anchor to now so the first fire is one interval
      // from apply, not immediately (potion drunk at 12:00:00 with hour
      // cadence first heals at 13:00:00).
      let lastAt = Number(perEffect[index]);
      if (!Number.isFinite(lastAt)) {
        lastAt = now;
        upd[`flags.${MODULE_ID}.healTickAt.${effect.id}.${index}`] = now;
        dirty = true;
        continue;
      }

      const elapsed = now - lastAt;
      let firings = Math.floor(elapsed / interval);
      if (firings <= 0) continue;
      if (firings > MAX_OOC_TICKS) firings = MAX_OOC_TICKS;

      for (let i = 0; i < firings; i++) {
        if (action.type === "heal") await applyHealAction(actor, effect, action);
        else                        await applyDamageAction(actor, effect, action);
      }
      const nextAnchor = lastAt + firings * interval;
      upd[`flags.${MODULE_ID}.healTickAt.${effect.id}.${index}`] = nextAnchor;
      dirty = true;
    }
  }

  if (dirty) {
    try { await engineUpdate(actor, upd); }
    catch (err) { console.warn(`${MODULE_ID} | tickTimedHeals flag update failed`, err); }
  }
}

/* Drop this effect's timed-heal ledger entry on delete so a re-applied
 * potion / new AE doesn't inherit a stale lastFireAt anchor. */
async function reclaimTimedHealLedger(effect) {
  const actor = effectActor(effect);
  if (!actor) return;
  const store = actor.flags?.[MODULE_ID]?.healTickAt;
  if (!store || !Object.prototype.hasOwnProperty.call(store, effect.id)) return;
  try { await actor.unsetFlag(MODULE_ID, `healTickAt.${effect.id}`); }
  catch (_) { /* actor gone / permission */ }
}

/* Apply an effect's per-turn pulses `times` times against `actor`. heal /
 * damage / tick-modify roll fresh each iteration (so dice vary per turn);
 * eachTurn event-modifiers stack all `times` occurrences in one ledger write.
 *
 * Out-of-combat behaviour: heal actions gated on `undamaged` still fire, because
 * OOC nothing sets `damagedSinceTick` so the actor is trivially undamaged (this
 * matches the fiction of Swallow regenerating a witcher at rest). `damaged` /
 * `adrenaline` gates are trivially false OOC — see healPassesCondition. */
async function tickEffect(actor, effect, times) {
  if (times <= 0) return;
  // Alchemy pause — freeze per-turn event pulses for AEs born of alchemical
  // items whenever the actor carries a pauseAlchemyDurations effect.
  if (isEffectPaused(effect)) return;
  for (const action of effectActions(effect)) {
    // Skip non-turn cadence heals AND damage — they fire from the world-time
    // path (tickTimedActions) on updateWorldTime, not from the per-turn engine.
    if ((action?.type === "heal" || action?.type === "damage") && healCadenceOf(action) !== "turn") continue;
    if (action?.type === "heal") {
      for (let i = 0; i < times; i++) await applyHealAction(actor, effect, action);
    } else if (action?.type === "damage") {
      for (let i = 0; i < times; i++) await applyDamageAction(actor, effect, action);
    } else if (action?.type === "modify" && effectTrigger(action?.when)?.mode === "tick") {
      for (let i = 0; i < times; i++) await applyTickModify(actor, effect, action);
    }
  }
  for (const { a, index } of eventActionsOf(effect)) {
    if (a.when === "eachTurn") await applyEventModify(actor, effect, a, index, times);
  }
}

/* Tick every per-turn effect on `actor` `ticks` times. Core has already
 * refreshed durations and deleted expired effects before this runs (see the
 * expiryAction=delete set at the top of installTickEffects), so any effect
 * still in allApplicableEffects survived the whole advance window and can
 * safely tick for the full `ticks` count. The caller (updateWorldTime hook)
 * has already capped `ticks` at MAX_OOC_TICKS. */
async function tickActorOverTime(actor, ticks) {
  if (!actor || !(ticks > 0)) return;
  for (const effect of actor.allApplicableEffects()) {
    if (effect.disabled || effect.system?.isSuppressed) continue;
    if (!hasPerTurnAction(effect)) continue;
    await tickEffect(actor, effect, ticks);
  }
  // Status-clause DoTs (poison/bleed/burning/toxicity tiers/etc.) need to
  // bite out of combat too — a character resting at Severe toxicity should
  // still bleed HP every 3 seconds of worldTime, not freeze damage until
  // the next encounter. applyStatusDots in-combat fires once per combat
  // turn; here we apply it `ticks` times in a single OOC pass, batched
  // by applyStatusDotsOverTicks so a long advance doesn't flood chat.
  await applyStatusDotsOverTicks(actor, ticks);
}

/* OOC equivalent of applyStatusDots — but BATCHED. Instead of firing
 * `applyDamageAction` once per virtual turn (which would flood chat with
 * 200 messages on a 10-minute timeskip), the per-status totals are
 * summed and applied as a single hit per status: amount × fires ×
 * instances. Cadence is honoured via floor(ticks / cadence) so a
 * cadence-3 status still respects its rate. All current Alchemy Reborn
 * tiers have cadence 1, so the math collapses to amount × ticks ×
 * instances. Armor ablation runs at most once per OOC sweep (matches
 * the in-combat "once per turn, not multiplied" invariant). */
async function applyStatusDotsOverTicks(actor, ticks) {
  if (!(ticks > 0)) return;
  const counts = new Map();
  for (const e of (actor.appliedEffects ?? actor.effects ?? [])) {
    if (e.disabled || e.system?.isSuppressed) continue;
    for (const id of (e.statuses ?? [])) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const [id, instances] of counts) {
    const dot = clauseFor(id, actor)?.dot;
    let amount = dot?.amount == null ? "" : String(dot.amount).trim();
    /* CE chokehold — see in-combat path above. Same rule applies for
     * OOC ticks (a chokehold left running over world-time still uses
     * the choker's melee mod for its per-turn damage). */
    if (id === "suffocation") {
        const ceAmt = ceChokeholdDoTAmount(actor);
        if (typeof ceAmt === "number") amount = String(ceAmt);
    }
    if (!amount || amount === "0") continue;
    const cadence = Math.max(1, Number(dot?.cadence) || 1);
    const fires = Math.floor(ticks / cadence);
    if (fires <= 0) continue;
    // Flat amount → collapse to a single pre-summed hit (fast path). Dice
    // formula → roll fresh fires×instances times and sum the totals, so
    // variance is preserved. Both paths post ONE chat message via the
    // scaled formula string.
    let totalFormula;
    if (!amount.includes("d")) {
      const total = (Number(amount) || 0) * fires * instances;
      if (total <= 0) continue;
      totalFormula = String(total);
    } else {
      let sum = 0;
      for (let n = fires * instances; n > 0; n--) sum += await rollOrFlat(amount);
      if (sum <= 0) continue;
      totalFormula = String(sum);
    }
    const clause = clauseFor(id, actor);
    const action = {
      type: "damage",
      formula: totalFormula,
      locations: dot.scope === "all-locations" ? ["everyLocation"] : ["torso"],
      throughArmor: !!dot.bypassArmor,
      ablateArmor: Number(dot?.ablateArmor) || 0,
      damageType: String(dot.damageType ?? ""),
      statusId: id,
      statusCountsAs: Array.isArray(clause?.countsAs) ? clause.countsAs : []
    };
    // Name the source so the chat line reads as e.g. "Toxicity Severe
    // (×20 turns)" rather than the bare status label — helps the table
    // see that this hit represents accumulated OOC ticks.
    const label = `${statusDisplayLabel(id)} (×${fires}${cadence > 1 ? `/c${cadence}` : ""} turn${fires === 1 ? "" : "s"})`;
    await applyDamageAction(actor, { name: label }, action);
  }
}

/* The unified action list (flags.<MODULE_ID>.actions). Only event actions
 * (heal / damage) matter to the tick engine — modifier actions are compiled
 * into native changes by WitcherActiveEffect, and suppress is read in
 * character.prepareDerivedData. When no actions array is present, synthesize
 * event actions from the legacy flat tick flags so effects authored before
 * the unified editor keep ticking until they're re-saved. Legacy synthesis
 * intentionally ignores the old tickOnTurn master switch: a non-empty
 * tickHeal/tickDamage value is enough — that master checkbox being separate
 * from the value was the original "heal does nothing" bug. */
function effectActions(effect) {
  const actions = effect.getFlag(MODULE_ID, "actions");
  if (Array.isArray(actions)) return actions;

  const out = [];
  const heal = readFlag(effect, "tickHeal");
  if (heal != null && String(heal).trim() !== "") {
    out.push({
      type: "heal",
      amount: String(heal),
      when: String(readFlag(effect, "tickHealCondition") ?? "always") || "always"
    });
  }
  const dmg = readFlag(effect, "tickDamage");
  if (dmg != null && String(dmg).trim() !== "") {
    out.push({
      type: "damage",
      formula: String(dmg),
      locations: normalizeLocationKeys(readFlag(effect, "tickLocation")),
      throughArmor: !!readFlag(effect, "tickGoesThroughArmor")
    });
  }
  return out;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Event-modifier engine — the stacking `modify … when:<event>` actions.
 *
 * Native AE changes can't express "every time X happens, mutate Y by Z and
 * keep it" — they re-apply once per prep cycle, not once per occurrence. So
 * each occurrence is COUNTED here into a per-actor ledger scoped to the
 * effect's lifetime:
 *
 *   flags.<MODULE_ID>.fx.<effectId>.<actionIndex> = { fires }
 *     fires — occurrences counted so far (drives stacking AND the fireCap).
 *
 * The mutation itself is NOT written here for the default `untilEffectEnds`
 * row: applyEventLedger (config.mjs) re-applies the op `fires` times to the
 * PREPARED data every prepareDerivedData cycle. This keeps the engine off the
 * source field — which clamps stats to 1-10 and is the player's own allocated
 * value — and makes reverting trivial: reclaimEventActions just drops the
 * ledger subtree and the next prepare omits the buff. Only `lasts:permanent`
 * rows write to the source (a real, lasting change that outlives the effect).
 *
 * Loop guard: every write goes through engineUpdate, which stamps the update
 * options so the trigger detectors (preUpdateActor) skip the engine's own
 * writes. This is what stops "+1 adrenaline whenever you gain adrenaline" from
 * running away — the manual gain fires once, the engine only bumps a flag
 * (and the prepared bump is never itself a source-level gain to react to).
 * ────────────────────────────────────────────────────────────────────────── */

/* All writes the engine makes carry this stamp so trigger detection skips
 * them (see preUpdateActor / updateActor loop guards). */
function engineUpdate(actor, data) {
  return actor.update(data, { [MODULE_ID]: { engineApplied: true } });
}

/* Normalized event-mode modifier actions of an effect, paired with their
 * stable index in the actions array (the ledger key). */
function eventActionsOf(effect) {
  const actions = effect.getFlag(MODULE_ID, "actions");
  if (!Array.isArray(actions)) return [];
  const out = [];
  actions.forEach((raw, index) => {
    const a = normalizeAction(raw);
    if (a?.type === "modify" && a.target && effectTrigger(a.when)?.mode === "event") {
      out.push({ a, index });
    }
  });
  return out;
}

/* Apply one event-modifier action `times` occurrences. Stacks: the op is
 * applied once per occurrence (so 3 adrenaline gains → +3, not +1). Honors an
 * optional fireCap (max total occurrences across the effect's life).
 *
 * The default `untilEffectEnds` row writes ONLY a fire count to the ledger;
 * the accumulated mutation is applied to the PREPARED value each prep cycle by
 * applyEventLedger (config.mjs). It deliberately never writes the target's
 * source field — that would clamp stats to their 1-10 range and clobber the
 * player's allocated value. Reverting such a row is just deleting its ledger
 * entry (reclaimEventActions), so no per-occurrence delta is tracked.
 *
 * A `permanent` row is a real, lasting change: it's written to the SOURCE
 * value (accepting the field's own clamp, which is correct for a permanent
 * stat gain) so it persists after the effect is gone. Its fire count is still
 * recorded for fireCap accounting. */
async function applyEventModify(actor, effect, a, index, times) {
  if (times <= 0) return;
  const entry = actor.flags?.[MODULE_ID]?.fx?.[effect.id]?.[index] ?? { fires: 0 };
  const fired = Number(entry.fires) || 0;
  const cap   = parseInt(a.fireCap, 10);
  const capN  = Number.isFinite(cap) && cap > 0 ? cap : 0;
  const firings = capN > 0 ? Math.min(times, capN - fired) : times;
  if (firings <= 0) return;

  const key = `flags.${MODULE_ID}.fx.${effect.id}.${index}`;

  // A dice value can't be replayed deterministically at prep time
  // (Number("1d6") → 0 in applyEventLedger), so roll it HERE — once per firing.
  // Permanent rows apply the rolls straight to the source; untilEffectEnds rows
  // bank the accumulated total in the ledger's `amount`, which applyEventLedger
  // adds once. Numeric values keep the original value×fires path untouched.
  const isFormula = isActionValueFormula(a.value);

  /* Pool-current targets (adrenaline / hp / sta / toxicity / luck / shield /
   * vigor) are spendable resources that gameplay reads-modifies-writes to
   * SOURCE. An event gain on them MUST be a one-time source write — exactly the
   * `permanent` path — never banked in the every-prep ledger, or it re-applies
   * each render and snowballs (see POOL_CURRENT_TARGETS / applyEventLedger). */
  const writeToSource = (a.lasts === "permanent") || isPoolCurrentTarget(a.target);

  if (writeToSource) {
    const src   = Number(foundry.utils.getProperty(actor._source, a.target));
    let cur = Number.isFinite(src) ? src : (Number(foundry.utils.getProperty(actor, a.target)) || 0);
    if (isFormula) {
      for (let i = 0; i < firings; i++) cur = applyOperation(cur, a.op, Number(await rollOrFlat(a.value)) || 0);
    } else {
      const value = actionValue(a.value);
      for (let i = 0; i < firings; i++) cur = applyOperation(cur, a.op, value);
    }
    await engineUpdate(actor, { [a.target]: cur, [`${key}.fires`]: fired + firings });
    return;
  }

  if (isFormula) {
    let add = 0;
    for (let i = 0; i < firings; i++) add += Number(await rollOrFlat(a.value)) || 0;
    const priorAmt = Number(entry.amount) || 0;
    await engineUpdate(actor, { [`${key}.fires`]: fired + firings, [`${key}.amount`]: priorAmt + add });
    return;
  }

  await engineUpdate(actor, { [`${key}.fires`]: fired + firings });
}

/* Fire every active effect's event-modifier actions that match `when`,
 * stacking `occurrences` times each. */
async function fireTrigger(actor, when, occurrences = 1) {
  if (!actor || occurrences <= 0) return;
  for (const effect of actor.allApplicableEffects()) {
    if (!effect.active) continue;
    for (const { a, index } of eventActionsOf(effect)) {
      if (a.when !== when) continue;
      await applyEventModify(actor, effect, a, index, occurrences);
    }
  }
}

/* GM-side fan-out of a single-occurrence trigger across every combatant,
 * deduped by actor (one actor can hold several combatants). */
async function fireTriggerForCombat(combat, when) {
  if (!game.user.isActiveGM) return;
  const seen = new Set();
  for (const c of combat.turns) {
    const actor = c.actor;
    if (!actor || seen.has(actor.id)) continue;
    seen.add(actor.id);
    await fireTrigger(actor, when, 1);
  }
}

/* Per-turn triggers, fired from tickActor. eachTurn always fires; tookDamage /
 * undamaged reuse the round-marker gate that the heal conditions use. */
async function fireTurnTriggers(actor) {
  await fireTrigger(actor, "eachTurn", 1);
  if (healPassesCondition(actor, "damaged"))   await fireTrigger(actor, "tookDamage", 1);
  if (healPassesCondition(actor, "undamaged")) await fireTrigger(actor, "undamaged", 1);
}

/* Drop an effect's event ledger. Called when the effect is deleted (incl.
 * duration expiry via sweepExpiredEffects) or disabled. The mutations live
 * only on the PREPARED data (applyEventLedger reads this ledger every prep
 * cycle), so removing the ledger entry is the whole revert — the next prepare
 * simply omits the buff. `lasts:permanent` rows already wrote their change to
 * the source value, so they persist regardless; clearing their fire count
 * here is harmless (it only gated fireCap during the effect's life). */
async function reclaimEventActions(effect) {
  const actor = effectActor(effect);
  if (!actor) return;
  const fx = actor.flags?.[MODULE_ID]?.fx;
  if (!fx || typeof fx !== "object" || !(effect.id in fx)) return;
  await actor.unsetFlag(MODULE_ID, `fx.${effect.id}`);
}

/* ──────────────────────────────────────────────────────────────────────────
 * Heal (existing) + Damage (new) per tick
 * ────────────────────────────────────────────────────────────────────────── */

async function rollOrFlat(expr) {
  if (!expr) return 0;
  if (expr.includes("d")) return (await new Roll(expr).evaluate()).total;
  return parseInt(expr) || 0;
}

/* Hit-location → damage multiplier (Core p.152). Self-contained so the tick
 * engine doesn't depend on a WitcherActor location helper that this system
 * doesn't expose yet. randomHuman/randomMonster pick a concrete location
 * with the RAW d10 location roll, then resolve its multiplier. */
const LOCATION_FORMULA = {
  head: 3, torso: 1, rightArm: 0.5, leftArm: 0.5, rightLeg: 0.5, leftLeg: 0.5
};
const HUMAN_LOC_TABLE = [
  [1, 1, "head"], [2, 4, "torso"], [5, 5, "rightArm"], [6, 6, "leftArm"],
  [7, 8, "rightLeg"], [9, 10, "leftLeg"]
];
function resolveLocation(locKey) {
  let key = locKey;
  if (locKey === "randomHuman" || locKey === "randomMonster") {
    const r = Math.floor(Math.random() * 10) + 1;
    key = (HUMAN_LOC_TABLE.find(([lo, hi]) => r >= lo && r <= hi)?.[2]) ?? "torso";
  }
  return { name: key, alias: key, formula: LOCATION_FORMULA[key] ?? 1 };
}

/* The Logic tab stores tickLocation as a multi-select array; legacy data may
 * be a single string. Normalize to a concrete list of location keys:
 *   - empty            → ["torso"]
 *   - "everyLocation"  → all six body locations
 * random* keys are left as-is for resolveLocation() to roll per-location. */
function normalizeLocationKeys(raw) {
  let list = Array.isArray(raw) ? raw : (raw != null && raw !== "" ? [raw] : []);
  list = list.map(s => String(s).trim()).filter(Boolean);
  if (!list.length) list = ["torso"];
  if (list.includes("everyLocation")) {
    list = ["head", "torso", "rightArm", "leftArm", "rightLeg", "leftLeg"];
  }
  return list;
}

/* Recurring per-turn modify (trigger mode "tick"): roll the value fresh, gate
 * on the heal-style per-turn condition, and write the op result straight to the
 * target's SOURCE — same lifecycle as heal/damage (a real per-turn mutation,
 * not reverted when the effect ends). Stamped engineApplied so an adrenaline /
 * HP tick doesn't re-fire the event detectors. Meant for current-value pools
 * (hp/sta/toxicity/adrenaline); a derived target would just be recomputed away. */
async function applyTickModify(actor, effect, action) {
  const a = normalizeAction(action);
  if (!a?.target) return;
  if (!healPassesCondition(actor, a.gate || "always")) return;
  const expr = String(a.value ?? "").trim();
  if (!expr) return;
  const amount = await rollOrFlat(expr);
  const cur    = Number(foundry.utils.getProperty(actor, a.target)) || 0;
  const next   = applyOperation(cur, a.op, amount);
  if (next === cur) return;
  await engineUpdate(actor, { [a.target]: next });
}

async function applyHealAction(actor, effect, action) {
  const healExpr = String(action?.amount ?? "").trim();
  if (!healExpr) return;
  const cond = String(action?.when ?? "always").trim() || "always";
  if (!healPassesCondition(actor, cond)) return;
  const amount = await rollOrFlat(healExpr);
  if (amount <= 0) return;
  const hp = actor.system?.derivedStats?.hp;
  if (!hp) return;
  const healed = Math.min(amount, Number(hp.max) - Number(hp.value));
  if (healed <= 0) return;
  await actor.update({ "system.derivedStats.hp.value": Number(hp.value) + healed });
  if (typeof actor.createHealMessage === "function") {
    await actor.createHealMessage(healed);
  }
}

async function applyDamageAction(actor, effect, action) {
  const dmgExpr        = String(action?.formula      ?? "").trim();
  const ablateArmorRaw = String(action?.ablateArmor  ?? "").trim();
  const ablateWpnRaw   = String(action?.ablateWeapon ?? "").trim();
  const hasAblation    = !!(ablateArmorRaw || ablateWpnRaw);
  /* No damage AND no ablation → nothing to do. But if the AE has
   * ablation set, we must NOT early-return on "no damage" — an
   * "armor-eater" AE with only ablation would silently do nothing. */
  if (!dmgExpr && !hasAblation) return;
  let raw = dmgExpr ? await rollOrFlat(dmgExpr) : 0;
  if (raw <= 0 && !hasAblation) return;

  /* Damage-type + status-based reactions on the target.
   *
   * Two axes:
   *   (a) damageType — checked against monster.combat.damageProfile (fire /
   *       acid / cold / slashing etc.). Only fires when the DoT declares a
   *       damageType.
   *   (b) statusId + countsAs — checked against monster.combat.statusImmunities
   *       and statusResistances. Status-based reactions live on the same
   *       actor.combat block; poisoned in statusResistances halves a DoT
   *       whose statusId is poisoned OR whose countsAs list contains
   *       poisoned. Immunity zeroes it (usually redundant since immunity
   *       already blocks the AE at preCreate, but a stale AE that survived
   *       an immunity grant still gets its DoT neutralised here).
   *
   * We collect ALL applicable reactions and apply the STRONGEST once (not
   * stacked): immune > vulnerable > resistant > none. Rank order flips
   * "vulnerable > resistant" because a monster that's both should feel the
   * weakness, not average out to nothing. Reaction is stashed on the info
   * object so postTickDamageMessage can annotate the chat line. */
  const reactions = [];
  const dmgType = String(action?.damageType ?? "").trim().toLowerCase();
  if (dmgType) {
    const r = actor?.system?.combat?.damageProfile?.[dmgType];
    if (r && r !== "none") reactions.push({ kind: r, source: "damage type", key: dmgType });
  }
  /* Status-id resolution.
   *
   * applyStatusDots explicitly stamps `action.statusId` + `action.statusCountsAs`
   * on its damage action so applyDamageAction knows this is a status DoT and
   * whose. But damage that flows through tickEffect (an Effects-tab damage
   * action row on the AE, or any other caller that doesn't stamp status
   * context) also needs the resistance check when its source AE carries a
   * customStatus — so we FALL BACK to reading the id + countsAs directly off
   * the source AE's flags. Explicit action fields win; effect-flag lookup only
   * fires when the action didn't carry them. */
  const csFlag = effect?.flags?.[MODULE_ID]?.customStatus;
  const csEnabled = !!csFlag?.enabled;
  const effectStatusId = csEnabled ? String(csFlag?.id ?? "").trim() : "";
  const effectCountsAs = csEnabled && Array.isArray(csFlag?.countsAs)
      ? csFlag.countsAs.map(String).filter(Boolean)
      : [];
  const rawStatusId = String(action?.statusId ?? "").trim() || effectStatusId;
  const rawCountsAs = Array.isArray(action?.statusCountsAs) && action.statusCountsAs.length
      ? action.statusCountsAs.map(String)
      : effectCountsAs;
  const statusIds = [rawStatusId, ...rawCountsAs].filter(Boolean);
  const combat = actor?.system?.combat ?? {};
  const immSet = new Set(combat.statusImmunities ?? []);
  const resSet = new Set(combat.statusResistances ?? []);
  if (statusIds.length) {
    for (const sid of statusIds) {
      if (immSet.has(sid))      reactions.push({ kind: "immune",    source: "status", key: sid });
      else if (resSet.has(sid)) reactions.push({ kind: "resistant", source: "status", key: sid });
    }
  }
  /* Debug — flip `game.system.api.dotResistDebug = true` in the F12 console
   * to log every DoT reaction check. Prints target, raw damage, the ids we
   * checked, the resistances/immunities we found on the target, and the
   * winning reaction (or "none"). Off by default so it doesn't spam. */
  if (globalThis.game?.system?.api?.dotResistDebug) {
    console.info(`[DoT ${effect?.name ?? "?"} → ${actor?.name ?? "?"}]`, {
      raw, dmgType, statusIds,
      target_immunities:   [...immSet],
      target_resistances:  [...resSet],
      damageProfileEntry:  dmgType ? actor?.system?.combat?.damageProfile?.[dmgType] : null,
      reactions
    });
  }
  let reaction = null;
  const preRaw = raw;
  if (reactions.length) {
    // Rank: immune > vulnerable > resistant > (none).
    const rank = { immune: 3, vulnerable: 2, resistant: 1 };
    reaction = reactions.reduce((best, r) => (rank[r.kind] ?? 0) > (rank[best?.kind] ?? -1) ? r : best, null);
    if      (reaction?.kind === "immune")     raw = 0;
    else if (reaction?.kind === "resistant")  raw = Math.floor(raw * 0.5);
    else if (reaction?.kind === "vulnerable") raw = raw * 2;
    /* Reactions dropped damage to 0. Skip the location loop (no
     * damage rows to build) BUT still run ablation below if the AE
     * has ablation set — an "armor-eater" AE fires its rust even
     * when the target is damage-immune. */
    if (raw <= 0 && reaction?.kind === "immune") {
      await postTickDamageMessage(actor, effect, {
        raw: preRaw, through: !!action?.throughArmor, rows: [], totalFinal: 0,
        reaction, preRaw
      });
      if (!hasAblation) return;
    }
    if (raw <= 0 && reaction?.kind !== "immune" && !hasAblation) return;
  }

  const locKeys = normalizeLocationKeys(action?.locations);
  const through = !!action?.throughArmor;

  /* Per-location worn+natural Stopping Power, summed the same way the dock
   * paperdoll displays it — so a DoT soak matches the SP the player sees.
   * Skipped entirely when the damage bypasses armor (poison/bleed/acid). */
  const spMap = through ? null : getLocationSP(actor);

  /* The same raw amount lands on each selected location; per-location armor
   * SP and the location multiplier are applied independently, then summed
   * into a single HP update. */
  const rows = [];
  let totalFinal = 0;
  for (const locKey of locKeys) {
    const locObj = resolveLocation(locKey);
    if (!locObj) continue;

    const armorSP = through ? 0 : (Number(spMap?.[locObj.name]) || 0);

    const formula = Number(locObj.formula ?? 1);
    const final   = Math.floor(Math.max(0, raw - armorSP) * formula);
    totalFinal += final;
    rows.push({ locObj, armorSP, formula, final });
  }
  if (!rows.length) return;

  const hp = actor.system?.derivedStats?.hp;
  if (hp && totalFinal > 0) {
    const { value, temp } = drainHp(hp, totalFinal);
    await actor.update({
      "system.derivedStats.hp.value": value,
      "system.derivedStats.hp.temp":  temp
    });
  }

  // Configurable armor ablation (fire/acid effects) — erode N SP off the armor
  // at each struck location. `ablateArmor` accepts either a flat integer or
  // a dice formula ("1d6", "1d3+1") — same rollOrFlat pattern used by the
  // damage formula itself. Rolled ONCE per tick and applied uniformly across
  // affected locations (a "1d6 acid burn" doesn't reroll for each limb).
  // By default independent of whether the damage itself soaked; the AE
  // author can set `ablateArmorOnlyIfPenetrated: true` to require post-armor
  // damage > 0 before ablation fires.
  //
  // Monster natural armor is a single flat pool covering every location, so
  // a burning striking all six locations must only ablate the pool ONCE
  // per turn (not 6×). Characters keep the per-location loop since each
  // location may map to a different equipped armor piece.
  const ablateExpr = String(action?.ablateArmor ?? "").trim();
  const ablateArmorGated = !!action?.ablateArmorOnlyIfPenetrated;
  if (ablateExpr && (!ablateArmorGated || totalFinal > 0)) {
    const ablate = Math.max(0, Math.floor(await rollOrFlat(ablateExpr)));
    if (ablate > 0) {
      if (actor.type === "monster") {
        for (let k = 0; k < ablate; k++) await decrementArmorSP(actor, rows[0].locObj.name);
      } else {
        for (const { locObj } of rows)
          for (let k = 0; k < ablate; k++) await decrementArmorSP(actor, locObj.name);
      }
    }
  }

  /* Weapon ablation — corrosive / rust-inducing effects chip N points
   * off each of the target's equipped weapons' Reliability per tick.
   * Accepts flat integers or dice formulas (rollOrFlat). Rolled ONCE
   * per tick and applied uniformly to every equipped weapon/shield.
   * Weapons with reliability.max === 0 (unbreakable / not tracked)
   * are skipped. Reliability floors at 0; a weapon at 0 stays in the
   * equipped slot and is flagged broken by the standard equipment
   * pipeline (weaponAttack refuses to fire a broken weapon). Same
   * penetration-gate toggle as armor ablation. */
  const ablateWeaponExpr = String(action?.ablateWeapon ?? "").trim();
  const ablateWeaponGated = !!action?.ablateWeaponOnlyIfPenetrated;
  if (ablateWeaponExpr && (!ablateWeaponGated || totalFinal > 0)) {
    const ablateWeapon = Math.max(0, Math.floor(await rollOrFlat(ablateWeaponExpr)));
    if (ablateWeapon > 0) {
      const equipped = (actor.items ?? []).filter(i =>
          (i.type === "weapon" || i.type === "shield") && i.system?.equipped);
      for (const w of equipped) {
        const cur = Number(w.system?.reliability?.value) || 0;
        const max = Number(w.system?.reliability?.max)   || 0;
        if (max <= 0 || cur <= 0) continue;
        if (await durableAblationNegated(w, { actor })) continue;   // Durable rune save
        const next = Math.max(0, cur - ablateWeapon);
        if (next !== cur) {
          try { await w.update({ "system.reliability.value": next }); }
          catch (err) { console.warn(`witcher-ttrpg-death-march | ablateWeapon update failed on ${w?.name}`, err); }
        }
      }
    }
  }

  await postTickDamageMessage(actor, effect, { raw, through, rows, totalFinal, reaction, preRaw });
}

async function postTickDamageMessage(actor, effect, info) {
  const { raw, through, rows, totalFinal, reaction, preRaw } = info;
  const colour = totalFinal > 0 ? "#8b0000" : "#4a4a4a";
  const lines = rows.map(({ locObj, armorSP, formula, final }) => {
    const armorLine = through
      ? `<small style="opacity:0.7">${t("WITCHER.Chrome.Policy.TickEffects.Text.IgnoredArmor", "ignored armor")}</small>`
      : `<small style="opacity:0.7">${tFormat("WITCHER.Chrome.Policy.TickEffects.Text.SPN", { sp: armorSP }, `SP ${armorSP}`)}</small>`;
    return `<div>${armorLine} · ×${formula} → <b style="color:${colour}">${final}</b> ${tFormat("WITCHER.Chrome.Policy.TickEffects.Text.ToLocation", { loc: locObj.alias ?? locObj.name }, `to <b>${locObj.alias ?? locObj.name}</b>`)}</div>`;
  }).join("");
  const total = rows.length > 1
    ? `<div style="margin-top:2px"><b style="color:${colour}">${totalFinal}</b> total</div>`
    : "";
  // Reaction chip — shown when damageProfile or statusResistances/Immunities
  // altered the raw amount before soak. Colour cues: green = target reduced it,
  // amber = vulnerability doubled it.
  let reactionLine = "";
  if (reaction && preRaw != null) {
    const label = reaction.kind === "immune"     ? "immune"
                : reaction.kind === "resistant"  ? "resistant"
                : reaction.kind === "vulnerable" ? "vulnerable"
                : reaction.kind;
    const tone = reaction.kind === "vulnerable" ? "#c88a3a" : "#5c8a5c";
    const arrow = reaction.kind === "immune" ? "→ 0" : `${preRaw} → ${raw}`;
    reactionLine = `<div style="margin-top:2px"><small style="color:${tone}">${label} to ${reaction.source} <code>${reaction.key}</code>: ${arrow}</small></div>`;
  }
  const content = `
    <div style="border-left:3px solid ${colour};padding:4px 8px;margin:2px 0">
      <b>${actor.name}</b> · ${effect.name}<br>
      <b>${raw}</b> raw${rows.length > 1 ? " each" : ""}
      ${reactionLine}
      ${lines}${total}
    </div>`;
  await ChatMessage.create({
    content,
    speaker: ChatMessage.getSpeaker({ actor }),
    style: CONST.CHAT_MESSAGE_STYLES.OTHER
  });
}
