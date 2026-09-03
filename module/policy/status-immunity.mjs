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

/* The `countsAs` id list from an effect's customStatus flag — the ids this
 * effect should be treated AS for resistance / immunity checks even though
 * its own status id is different. Empty when the effect has no custom status
 * OR the custom status has no counts-as entries. */
function effectCountsAsIds(effect) {
    const cs = effect?.flags?.[SYSTEM_ID]?.customStatus;
    if (!cs?.enabled) return [];
    const arr = Array.isArray(cs.countsAs) ? cs.countsAs : [];
    return arr.map(String).filter(Boolean);
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
 * initiating the create (returning false there cancels the operation).
 *
 * Also honors `customStatus.countsAs` — a custom "spider-poison" that counts
 * as "poisoned" is blocked when the target is immune to poisoned. Because
 * countsAs is an effect-wide property (not per-status-id), a match against
 * ANY counts-as id cancels the whole creation regardless of what's in
 * `statuses`. */
function onPreCreate(effect) {
    const actor = effect?.parent;
    if (!(actor instanceof Actor)) return;          // item-borne effects don't apply yet
    const immune = statusImmunities(actor);
    if (!immune.size) return;

    const countsAs = effectCountsAsIds(effect);
    const blockedByCountsAs = countsAs.filter(id => immune.has(id));
    if (blockedByCountsAs.length) {
        ui?.notifications?.info?.(`${actor.name} is immune — ${effect.name || "effect"} counts as ${blockedByCountsAs.join(", ")} and did not take hold.`);
        return false;                                // countsAs is effect-wide → block whole create
    }

    const ids = effectStatusIds(effect);
    if (!ids.length) return;
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
 * matches; a no-op when nothing is immune or no status is up. GM-gated.
 *
 * Also sweeps custom-status AEs whose `countsAs` overlaps the immunity set —
 * a Golden-Oriole potion (grants poisoned immunity) also clears any active
 * "spider-poison" that counts-as poisoned. Those AEs get deleted outright
 * because they're not registered in CONFIG.statusEffects and can't be toggled
 * off via actor.toggleStatusEffect. */
async function cureImmuneStatuses(actor) {
    if (!(actor instanceof Actor) || !iShouldWrite(actor)) return;
    const immune = statusImmunities(actor);
    if (!immune.size) return;
    // Native (registered) status ids on the actor.
    if (actor.statuses?.size) {
        for (const id of [...actor.statuses]) {
            if (!immune.has(id)) continue;
            try { await actor.toggleStatusEffect?.(id, { active: false }); }
            catch (err) { console.warn(`${SYSTEM_ID} | immunity cure of ${id} failed`, err); }
        }
    }
    // Custom-status AEs whose countsAs matches an immunity → delete the AE
    // entirely (there is no CONFIG.statusEffects entry to toggle off).
    for (const e of (actor.effects?.contents ?? [])) {
        if (e.disabled) continue;
        const countsAs = effectCountsAsIds(e);
        if (!countsAs.length) continue;
        if (!countsAs.some(id => immune.has(id))) continue;
        try { await e.delete(); }
        catch (err) { console.warn(`${SYSTEM_ID} | immunity cure (custom-status) of ${e.name} failed`, err); }
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
