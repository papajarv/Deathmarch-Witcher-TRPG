/**
 * Shared "is this actor dead" predicate.
 *
 * Dead is the `dead` status effect — applied by the death-save flow
 * (saveMixin), the food/drink death path, and the combat tracker's Defeated
 * toggle (which syncs CONFIG.specialStatusEffects.DEFEATED === "dead").
 * `actor.statuses` already aggregates statuses carried by active effects, so a
 * single check covers all of those sources.
 *
 * Used to exclude the dead from every targeting flow (weapon, ranged,
 * brawling, magic) and from clinch target selection — you can't attack or
 * grapple a corpse.
 */
export function isDeadActor(actor) {
    return !!actor?.statuses?.has?.("dead");
}

/** Convenience wrapper for a Token placeable / TokenDocument-bearing object. */
export function isDeadToken(token) {
    return isDeadActor(token?.actor);
}
