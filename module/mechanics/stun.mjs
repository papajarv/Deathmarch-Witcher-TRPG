/**
 * Stun-at-0-STA — the `stunned` status is auto-applied whenever an actor's
 * stamina pool is depleted to 0, and removed once STA climbs back to ≥1.
 *
 * This makes "stunned" a real, token-visible condition driven purely by STA
 * (user ruling), rather than something enforced only when a dock button is
 * clicked. The action-economy guards (combatRoundMixin._stunned) and the dock
 * greying both key off the same condition, so all three stay in lock-step.
 */

const STATUS_ID = "stunned";

/** True when the actor has a stamina pool (max > 0) that's depleted to 0. */
export function isStaDepleted(actor) {
    const sta = actor?.system?.derivedStats?.sta ?? {};
    return (Number(sta.max) || 0) > 0 && (Number(sta.value) || 0) === 0;
}

/** Toggle the `stunned` status to match the actor's STA, if it's out of sync. */
async function syncStun(actor) {
    if (!actor?.isOwner && !game.user.isGM) return;
    const shouldStun = isStaDepleted(actor);
    const hasStun = actor.statuses?.has?.(STATUS_ID) ?? false;
    if (shouldStun === hasStun) return;
    try { await actor.toggleStatusEffect(STATUS_ID, { active: shouldStun }); }
    catch (err) { console.warn("witcher-ttrpg-death-march | stun sync failed", err); }
}

/** updateActor hook — react to STA value changes. Only the updating client runs
 *  the toggle (the AE write replicates to everyone). */
export async function onUpdateActorStun(actor, changes, options, userId) {
    if (userId !== game.userId) return;
    if (changes?.system?.derivedStats?.sta?.value === undefined) return;
    await syncStun(actor);
}
