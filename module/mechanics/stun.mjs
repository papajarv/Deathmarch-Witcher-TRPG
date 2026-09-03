/**
 * Stun-at-0-STA — ONE-SHOT.
 *
 * Reaching 0 Stamina applies the `stunned` status ONCE, on the transition into
 * depletion. After that it is an ordinary, clearable condition: a hit
 * (statusClauses `clearOnHit`), a save, or a manual toggle removes it, and —
 * crucially — it is NOT re-applied while STA merely sits at 0. Clearing the
 * stun is decoupled from Stamina: an un-stunned actor at 0 STA no longer shows
 * the condition but still owes a Recovery action to refill the pool (the
 * action-economy lock in combatRoundMixin._stunned is STA-based and unchanged).
 *
 * Recovering STA back above 0 clears the stun as before — you're no longer
 * winded.
 *
 * (Previously the status was continuously slaved to STA==0, so it re-applied
 * the instant anything cleared it. That made a 0-STA actor unable to ever be
 * both un-stunned AND still needing Recovery.)
 */

const STATUS_ID = "stunned";

/** True when the actor has a stamina pool (max > 0) that's depleted to 0. */
export function isStaDepleted(actor) {
    const sta = actor?.system?.derivedStats?.sta ?? {};
    return (Number(sta.max) || 0) > 0 && (Number(sta.value) || 0) === 0;
}

/** preUpdateActor — snapshot the PRE-update depletion state so updateActor can
 *  fire only on the transition INTO 0 STA, not on every write while sitting at
 *  0. In preUpdate, `actor.system` still holds the old value. */
export function onPreUpdateActorStun(actor, changes) {
    if (changes?.system?.derivedStats?.sta?.value === undefined) return;
    actor._preStaDepleted = isStaDepleted(actor);
}

/** updateActor hook — apply the stun ONCE on entering depletion; clear it on
 *  recovery. Never re-applies while merely at 0 STA. Only the updating client
 *  runs the toggle (the AE write replicates to everyone). */
export async function onUpdateActorStun(actor, changes, options, userId) {
    const wasDepleted = actor._preStaDepleted;
    delete actor._preStaDepleted;
    if (userId !== game.userId) return;
    if (changes?.system?.derivedStats?.sta?.value === undefined) return;
    if (!actor?.isOwner && !game.user.isGM) return;

    const nowDepleted = isStaDepleted(actor);
    const hasStun = actor.statuses?.has?.(STATUS_ID) ?? false;
    try {
        if (!wasDepleted && nowDepleted && !hasStun) {
            // Entered 0 STA this update — apply the stun a single time.
            await actor.toggleStatusEffect(STATUS_ID, { active: true });
        } else if (wasDepleted && !nowDepleted && hasStun) {
            // Recovered STA above 0 — no longer winded, drop the stun.
            await actor.toggleStatusEffect(STATUS_ID, { active: false });
        }
        // Otherwise (still at 0 STA, or a no-op change): leave the status alone,
        // so a cleared stun stays cleared.
    } catch (err) {
        console.warn("witcher-ttrpg-death-march | stun sync failed", err);
    }
}
