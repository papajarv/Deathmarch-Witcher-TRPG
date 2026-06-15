/**
 * Status immunity — enforces the immunity set built by statusEngine
 * (monster `statusImmunities[]` + AE `immunity` actions, e.g. Golden Oriole →
 * poisoned). Until now that data was display-only; these two hooks make it bite.
 *
 *   preCreateActiveEffect — a status the actor is immune to never lands. Immune
 *     ids are stripped from the incoming effect's `statuses`; if that empties
 *     the set (a pure status marker) the creation is cancelled.
 *   create/updateActiveEffect, updateActor — whenever immunity could have just
 *     been GRANTED (an AE immunity action added/edited/enabled, or a monster's
 *     statusImmunities[] changed), any matching status already on the bearer is
 *     cleared ("neutralises toxins already present"). Sweep-based off the full
 *     immunity set, so it's robust no matter how the grant arrived. GM-gated.
 */

import { statusImmunities } from "../mechanics/statusEngine.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";

/* The status ids an effect would apply (its `statuses` set, as an array). */
function effectStatusIds(effect) {
    const s = effect?.statuses;
    if (!s) return [];
    return (Array.isArray(s) ? s : [...s]).map(String);
}

/* Resolve the bearing Actor for an effect document — directly on an actor, or
 * on an owned item whose parent is the actor. Null for world/unowned effects. */
function actorOf(effect) {
    const p = effect?.parent;
    if (p instanceof Actor) return p;
    if (p?.parent instanceof Actor) return p.parent;
    return null;
}

/* Only the active GM writes; if none is online the actor's owner does. */
function iShouldWrite(actor) {
    const gm = game.users?.activeGM;
    return gm ? gm.isSelf : !!actor?.isOwner;
}

/* Block / strip an immune status before it ever applies. Runs on the client
 * initiating the create (returning false there cancels the operation). */
function onPreCreate(effect) {
    const actor = effect?.parent;
    if (!(actor instanceof Actor)) return;          // item-borne effects don't apply yet
    const ids = effectStatusIds(effect);
    if (!ids.length) return;
    const immune = statusImmunities(actor);
    if (!immune.size) return;
    const blocked = ids.filter(id => immune.has(id));
    if (!blocked.length) return;
    const remaining = ids.filter(id => !immune.has(id));
    ui?.notifications?.info?.(`${actor.name} is immune — ${blocked.join(", ")} did not take hold.`);
    if (!remaining.length) return false;            // nothing left → cancel creation
    effect.updateSource({ statuses: remaining });   // mixed marker → keep the rest
}

/* Remove every currently-active status the bearer is now immune to. Reads the
 * full immunity set (monster list + every AE immunity action), so it's correct
 * however the grant arrived. Cheap and idempotent — only toggles off active
 * matches; a no-op when nothing is immune or no status is up. GM-gated. */
async function cureImmuneStatuses(actor) {
    if (!(actor instanceof Actor) || !actor.statuses?.size || !iShouldWrite(actor)) return;
    const immune = statusImmunities(actor);
    if (!immune.size) return;
    for (const id of [...actor.statuses]) {
        if (!immune.has(id)) continue;
        try { await actor.toggleStatusEffect?.(id, { active: false }); }
        catch (err) { console.warn(`${SYSTEM_ID} | immunity cure of ${id} failed`, err); }
    }
}

export function registerStatusImmunity() {
    Hooks.on("preCreateActiveEffect", onPreCreate);
    // Any effect change that could add/enable an immunity action → re-sweep.
    Hooks.on("createActiveEffect", (effect) => cureImmuneStatuses(actorOf(effect)));
    Hooks.on("updateActiveEffect", (effect) => cureImmuneStatuses(actorOf(effect)));
    // A GM toggling a monster's statusImmunities[] is an actor update.
    Hooks.on("updateActor", (actor, changes) => {
        if (foundry.utils.hasProperty(changes, "system.combat.statusImmunities")) cureImmuneStatuses(actor);
    });
}
