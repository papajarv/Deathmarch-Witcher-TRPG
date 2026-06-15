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
  applyOperation,
  actionValue
} from "../../setup/config.mjs";
import { clauseFor, runTurnStartMutations } from "../../mechanics/statusEngine.mjs";
import { getLocationSP, decrementArmorSP } from "../chrome/dock.js";

const LEGACY_MOD = "witcher-bug-fixes";   // old namespace — read-only fallback

/* Hard cap on per-turn ticks applied for a single out-of-combat world-clock
 * advance. A permanent (duration-less) per-turn effect would otherwise fire
 * `delta / turnTime` times — advancing 8 hours of rest is ~9600 ticks, which
 * would freeze the client and flood chat. 120 ticks ≈ 6 minutes of game time
 * at 3s/turn, enough for any real potion duration while staying responsive. */
const MAX_OOC_TICKS = 120;

/* Read flag preferring new namespace; fall back to legacy module so existing
 * world data keeps working until the user re-saves the effect. */
function readFlag(effect, key) {
  const v = effect.flags?.[MODULE_ID]?.[key];
  return v !== undefined ? v : effect.flags?.[LEGACY_MOD]?.[key];
}

/* ──────────────────────────────────────────────────────────────────────────
 * Public install
 * ────────────────────────────────────────────────────────────────────────── */

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

  Hooks.on("updateCombat", async (combat, update) => {
    if (!("turn" in update) && !("round" in update)) return;
    // roundStart fires before the per-turn tick so a round-scoped buff is in
    // place for the first combatant's turn in the new round.
    if ("round" in update) await fireTriggerForCombat(combat, "roundStart");
    await processTickEffects(combat);
    await sweepExpiredEffects(combat);
  });

  /* Out-of-combat ticking: when the GM advances the world clock and no combat
   * is running, per-turn effects fire once per turnTime (3s) elapsed — the
   * same heal/damage/tick-modify/eachTurn pulses a combat turn would apply.
   * In combat, updateCombat owns ticking (and each round/turn advance also
   * bumps worldTime), so we bail when a combat is started to avoid double-firing.
   *
   * Core's ActiveEffect.registry.refresh("updateWorldTime") runs immediately
   * BEFORE this hook (helpers/time.mjs), so durations are already recomputed
   * against the new worldTime and expired effects are already deleted/marked —
   * we just need to tick whatever was alive during the advance window. */
  Hooks.on("updateWorldTime", async (_worldTime, delta) => {
    if (!game.user.isActiveGM) return;
    if (!(Number(delta) > 0)) return;        // only forward advances tick
    if (game.combat?.started) return;        // combat path owns ticking
    const turnTime = Number(CONFIG.time.turnTime) || 3;
    for (const actor of game.actors) {
      await tickActorOverTime(actor, Number(delta), turnTime);
    }
  });

  /* combatStart is its own hook in v14 (Combat#startCombat) — round 1 doesn't
   * arrive as a "round" delta on updateCombat, so combatStart triggers wouldn't
   * fire from the updateCombat handler above. */
  Hooks.on("combatStart", async (combat) => {
    await fireTriggerForCombat(combat, "combatStart");
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

    const newAdr = foundry.utils.getProperty(changes, "system.adrenaline.value");
    const oldAdr = Number(actor.system?.adrenaline?.value);
    // adrenalineGain fires whenever adrenaline rises — combat or not.
    if (newAdr !== undefined && Number(newAdr) > oldAdr) {
      foundry.utils.setProperty(options, `${MODULE_ID}.adrGain`, Number(newAdr) - oldAdr);
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
    if (adrGain > 0) await fireTrigger(actor, "adrenalineGain", adrGain);
  });

  /* Temp HP grant (one-shot): an effect carrying a tempHp action grants a
   * non-regenerable buffer once, when it lands on an actor, and that buffer
   * is clawed back when the effect is removed. GM-only so the buffer is
   * written exactly once. */
  Hooks.on("createActiveEffect", async (effect) => {
    if (!game.user.isActiveGM) return;
    await syncTempHp(effect);
  });
  /* The tempHp action is almost always added/edited AFTER the blank effect is
   * created (the config sheet's Save is an update, not a create), and toggling
   * the effect on/off is also an update — so reconcile here too, not just on
   * create. syncTempHp is idempotent: it grants once and never re-rolls. */
  Hooks.on("updateActiveEffect", async (effect) => {
    if (!game.user.isActiveGM) return;
    await syncTempHp(effect);
    // A disabled effect's event mutations are reverted, same as on delete —
    // toggling the effect off should undo what its triggers accumulated.
    if (effect.disabled) await reclaimEventActions(effect);
  });
  Hooks.on("deleteActiveEffect", async (effect) => {
    if (!game.user.isActiveGM) return;
    await reclaimTempHp(effect);
    await reclaimEventActions(effect);
  });

  /* Heal / damage actions are edited on the AE config's unified "Effects"
   * tab (WitcherActiveEffectConfig) — see templates/active-effect/effects.hbs.
   * No DOM injection here anymore. */
}

/* The actor a (possibly item-owned / transferred) effect applies to. */
function effectActor(effect) {
  return effect?.parent instanceof Actor ? effect.parent : (effect?.parent?.actor ?? null);
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

/* Evaluate a heal-gate condition against the per-round markers stamped on
 * the actor. Outside combat, only "always" heals (round-scoped conditions
 * have no meaning with no round). */
function healPassesCondition(actor, cond) {
  if (!cond || cond === "always") return true;
  // Round-scoped conditions only have meaning inside an active combat.
  if (!game.combat?.started) return false;
  // damaged/undamaged track HP loss SINCE THE ACTOR'S LAST TICK, not the
  // calendar round: the heal fires on the actor's turn, so damage taken last
  // round (after the prior heal) must still block this round's heal. The marker
  // is set on HP loss (preUpdateActor/updateActor) and cleared after each tick.
  switch (cond) {
    case "undamaged":  return !actor.getFlag(MODULE_ID, "damagedSinceTick");
    case "damaged":    return !!actor.getFlag(MODULE_ID, "damagedSinceTick");
    case "adrenaline": return actor.getFlag(MODULE_ID, "lastAdrenalineRound") === game.combat.round;
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
 * lingering effect (one with a duration) carries them instead. */
export async function applyInstantEffectActions(actor, effect) {
  if (!actor || !effect) return;
  for (const action of effectActions(effect)) {
    if (action?.type === "heal")        await applyHealAction(actor, effect, action);
    else if (action?.type === "damage") await applyDamageAction(actor, effect, action);
    else if (action?.type === "purge")  await actor.purgeToxicEffects?.();
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
    const dot = clauseFor(id)?.dot;
    const amount = Number(dot?.amount) || 0;
    if (amount <= 0) continue;
    const ablate = Number(dot?.ablateArmor) || 0;
    for (let i = 0; i < instances; i++) {
      const action = {
        type: "damage",
        formula: String(amount),
        locations: dot.scope === "all-locations" ? ["everyLocation"] : ["torso"],
        throughArmor: !!dot.bypassArmor,
        // Armor ablation (fire) runs through applyDamageAction — only on the
        // first instance so stacks don't multiply the per-turn armor erosion.
        ablateArmor: i === 0 ? ablate : 0
      };
      await applyDamageAction(actor, { name: statusDisplayLabel(id) }, action);
    }
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * Out-of-combat ticking over a world-clock advance
 * ────────────────────────────────────────────────────────────────────────── */

/* True if the effect would do anything on a per-turn tick: a heal/damage
 * action, a recurring "tick"-mode modify, or an eachTurn event-modifier. Used
 * to skip the (cheap) tick loop for effects that have no per-turn behaviour. */
function hasPerTurnAction(effect) {
  for (const action of effectActions(effect)) {
    if (action?.type === "heal" || action?.type === "damage") return true;
    if (action?.type === "modify" && effectTrigger(action?.when)?.mode === "tick") return true;
  }
  return eventActionsOf(effect).some(({ a }) => a.when === "eachTurn");
}

/* Apply an effect's per-turn pulses `times` times against `actor`. heal /
 * damage / tick-modify roll fresh each iteration (so dice vary per turn);
 * eachTurn event-modifiers stack all `times` occurrences in one ledger write.
 * The damaged / undamaged / adrenaline conditions are round-scoped, so out of
 * combat only "always"-gated heals and eachTurn modifiers do anything — same
 * cutoff fireTurnTriggers / healPassesCondition enforce on the combat path. */
async function tickEffect(actor, effect, times) {
  if (times <= 0) return;
  for (const action of effectActions(effect)) {
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

/* Tick every per-turn effect on `actor` for the portion of a `delta`-second
 * world-clock advance it was alive. Core already refreshed durations and
 * removed expired effects before this runs, so a survivor's secondsRemaining
 * is post-advance: it was alive for the whole window. An effect that expired
 * mid-window (only present if expiryAction is "update", not "delete") reports a
 * non-positive remaining; it ticks only for the seconds before it hit zero.
 * No duration → permanent → alive the whole window. Capped at MAX_OOC_TICKS. */
async function tickActorOverTime(actor, delta, turnTime) {
  if (!actor || !(turnTime > 0)) return;
  for (const effect of actor.allApplicableEffects()) {
    if (effect.disabled || effect.system?.isSuppressed) continue;
    if (!hasPerTurnAction(effect)) continue;
    const rem = Number(effect.duration?.secondsRemaining);
    const aliveSecs = Number.isFinite(rem) ? Math.max(0, Math.min(delta, rem + delta)) : delta;
    let ticks = Math.floor(aliveSecs / turnTime);
    if (ticks <= 0) continue;
    if (ticks > MAX_OOC_TICKS) ticks = MAX_OOC_TICKS;
    await tickEffect(actor, effect, ticks);
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

  if (a.lasts === "permanent") {
    const value = actionValue(a.value);
    const src   = Number(foundry.utils.getProperty(actor._source, a.target));
    let cur = Number.isFinite(src) ? src : (Number(foundry.utils.getProperty(actor, a.target)) || 0);
    for (let i = 0; i < firings; i++) cur = applyOperation(cur, a.op, value);
    await engineUpdate(actor, { [a.target]: cur, [`${key}.fires`]: fired + firings });
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
  const dmgExpr = String(action?.formula ?? "").trim();
  if (!dmgExpr) return;
  const raw = await rollOrFlat(dmgExpr);
  if (raw <= 0) return;

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
  // at each struck location. Independent of whether the damage itself soaked.
  const ablate = Math.max(0, Number(action?.ablateArmor) || 0);
  if (ablate > 0) {
    for (const { locObj } of rows)
      for (let k = 0; k < ablate; k++) await decrementArmorSP(actor, locObj.name);
  }

  await postTickDamageMessage(actor, effect, { raw, through, rows, totalFinal });
}

async function postTickDamageMessage(actor, effect, info) {
  const { raw, through, rows, totalFinal } = info;
  const colour = totalFinal > 0 ? "#8b0000" : "#4a4a4a";
  const lines = rows.map(({ locObj, armorSP, formula, final }) => {
    const armorLine = through
      ? `<small style="opacity:0.7">ignored armor</small>`
      : `<small style="opacity:0.7">SP ${armorSP}</small>`;
    return `<div>${armorLine} · ×${formula} → <b style="color:${colour}">${final}</b> to <b>${locObj.alias ?? locObj.name}</b></div>`;
  }).join("");
  const total = rows.length > 1
    ? `<div style="margin-top:2px"><b style="color:${colour}">${totalFinal}</b> total</div>`
    : "";
  const content = `
    <div style="border-left:3px solid ${colour};padding:4px 8px;margin:2px 0">
      <b>${actor.name}</b> · ${effect.name}<br>
      <b>${raw}</b> raw${rows.length > 1 ? " each" : ""}
      ${lines}${total}
    </div>`;
  await ChatMessage.create({
    content,
    speaker: ChatMessage.getSpeaker({ actor }),
    style: CONST.CHAT_MESSAGE_STYLES.OTHER
  });
}
