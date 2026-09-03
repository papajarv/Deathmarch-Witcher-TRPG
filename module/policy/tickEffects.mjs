/**
 * Tick-effects policy — applies recurring damage / healing from
 * ActiveEffects on each combat round or turn.
 *
 * Ported from witcher-overhaul-ui/policy/tick-effects.js as a hook handler
 * (not a separate module). Behavior unchanged but rewritten for our idiom.
 *
 * Convention: an ActiveEffect with a `tickDamage` / `tickHeal` system
 * flag (now: data field on the effect's data model) ticks once per round
 * at the start of its parent actor's turn. State is tracked on the
 * combatant via a `tickedRound` flag to avoid double-ticking.
 *
 * Phase 6 skeleton: the hook is wired but the application is a TODO.
 * Phase 7 fills it in alongside the rest of the policy port.
 */

const SYSTEM_ID = "witcher-ttrpg-death-march";
const TICKED_FLAG = "tickedRound";

/**
 * `updateCombat` hook entry point. Fires when round / turn changes.
 */
export async function onUpdateCombat(combat, changes, options, userId) {
    if (!game.user.isActiveGM) return;
    if (!("turn" in changes) && !("round" in changes)) return;

    const current = combat.combatant;
    if (!current?.actor) return;

    const round = combat.round;
    const ticked = current.getFlag(SYSTEM_ID, TICKED_FLAG)?.round;
    if (ticked === round) return; // already ticked this round

    await applyTicks(current.actor, round);
    await current.setFlag(SYSTEM_ID, TICKED_FLAG, { round, ids: [] });
}

/**
 * Walk the actor's effects, apply any that carry a tick payload.
 *
 * Phase 7 implementation:
 *   - effect.system has tickDamage / tickHeal / tickLocation / tickGoesThroughArmor
 *   - resolve damage roll formula in `tickDamage`, apply to derivedStats.hp
 *   - resolve heal roll formula in `tickHeal`, add to derivedStats.hp
 *   - respect tickGoesThroughArmor for damage
 */
async function applyTicks(actor, round) {
    // Phase 7: implement.
}
