/**
 * Toxicity policy — drives the Overdosed status off the toxicity pool, and the
 * White Honey purge for lingering purge effects.
 *
 * Bookkeeping (adding/reclaiming a potion's toxicity on `system.stats.toxicity`)
 * lives in the consume policy; this just reacts to the resulting changes:
 *   updateActor (toxicity changed) → reconcile Overdosed against the cap.
 *   createActiveEffect (effect with a `purge` action AND a duration) → purge.
 *     White Honey is instant, so its purge fires through the consume engine's
 *     applyInstantEffectActions instead — this covers any duration-bearing
 *     purge effect a GM authors.
 * GM-gated (single writer) like the other policies.
 */

const SYSTEM_ID = "witcher-ttrpg-death-march";

function iShouldWrite(actor) {
    const gm = game.users?.activeGM;
    return gm ? gm.isSelf : !!actor?.isOwner;
}

const hasPurgeAction = (effect) => {
    const actions = effect?.flags?.[SYSTEM_ID]?.actions;
    return Array.isArray(actions) && actions.some(a => a?.type === "purge");
};

export function registerToxicity() {
    // A purge effect landed as a real AE (e.g. dragged on, or a duration-bearing
    // purge potion): clear the toxic effects, then delete itself — a purge is a
    // one-shot and must never linger. (White Honey is instant and fires through
    // the consume engine instead, never reaching here.)
    Hooks.on("createActiveEffect", async (effect) => {
        const actor = effect?.parent instanceof Actor ? effect.parent : null;
        if (!actor || !hasPurgeAction(effect) || !iShouldWrite(actor)) return;
        await actor.purgeToxicEffects?.(effect.id);
        try { await effect.delete(); } catch (_) { /* already gone */ }
    });
    // Toxicity value/cap changed (a potion applied/reclaimed, or cap retuned)
    // → re-evaluate Overdosed.
    Hooks.on("updateActor", (actor, changes) => {
        if (foundry.utils.hasProperty(changes, "system.stats.toxicity") && iShouldWrite(actor)) {
            actor.reconcileToxicity?.();
        }
    });
}
