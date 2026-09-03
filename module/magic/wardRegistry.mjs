/**
 * Wards, rebuilt from the world instead of remembered in a tab.
 *
 * THE BUG THIS EXISTS FOR. `bus.mjs`'s `_subs` is a module-level array, which
 * means one per browser. `core:createShield` subscribes on the client that
 * cast the ward — the defender's. But interception is published by the
 * ATTACKER: `offerMagicInterception` runs inside the attacking cast's `oppose`
 * (`frame.mjs`), `takeDamage` is published from inside `core:dealDamage`, and
 * `offerAttackInterception` runs on the GM's client from the damage socket.
 * None of those clients has ever called `subscribe()`, so `publish` finds an
 * empty list and returns without a word. Demetia's Crest Surge never spends a
 * charge; Quen's tree never runs; Gwynt Troelli deflects nothing. The ward
 * works only when one client happens to be both caster and attacker.
 *
 * THE FIX. A ward is already written to the world as an ActiveEffect badge
 * carrying the item that raised it and what is left of it. That badge is the
 * real record; the subscription is a cache of it. So the subscription list is
 * REBUILT from the badges rather than accumulated by whoever cast — on the
 * active GM, who is the one client guaranteed to be present for every attack.
 *
 * Two things fall out of that for free:
 *   - A reload no longer disarms every ward in play. The badges survive; the
 *     rebuild reads them back.
 *   - The ward's own writes (spending a charge, draining a pool) now happen on
 *     the GM's client, so they stop being silently refused by the permission
 *     layer when the ward belongs to somebody else's character.
 *
 * WHAT IT DOES NOT DO. It does not rebuild the ward's LIFETIME — durations,
 * `onExpire` trees and upkeep still live in `lifetimes.mjs`'s in-memory list.
 * A rebuilt ward absorbs correctly and ends when its pool or charges run out;
 * it does not remember that it had four of its ten rounds left. That is the
 * next piece, and it is deliberately not smuggled in here.
 */

import { subscribe, unsubscribeOwner, allSubscriptions, ENTRY } from "./bus.mjs";
import { SYSTEM_ID } from "./systemId.mjs";

/** Badge flags that mark an actor as carrying a ward this engine raised. */
const WARD_FLAGS = ["castShield", "castWard"];

/**
 * The ward badges on one actor, as plain descriptors.
 *
 * Pure, so it can be tested without Foundry: it reads only the flag bag each
 * effect carries. Returns one descriptor per badge, in effect order.
 */
export function wardsOn(actor, systemId = SYSTEM_ID) {
    const effects = actor?.effects?.contents ?? actor?.effects ?? [];
    const out = [];
    for (const e of effects) {
        const f = e?.flags?.[systemId];
        if (!f) continue;
        if (!WARD_FLAGS.some(k => f[k])) continue;
        out.push({
            effect:     e,
            itemUuid:   f.sourceItem ?? null,
            itemId:     f.sourceItemId ?? null,
            /* One of the two is meaningful; the other is null. A pool ward
             * carries hit points, a charge ward carries blocks. */
            pool:       Number(f.activeShieldHp) || 0,
            charges:    Number(f.wardCharges) || 0,
            absorbs:    f.absorbs ?? f.wardAbsorbs ?? "all",
            magicKind:  f.magicKind ?? null,
            casterRoll: Number(f.casterRoll) || null
        });
    }
    return out;
}

/**
 * Is this ward still worth subscribing?
 *
 * A badge with nothing left behind it is a leftover — the pool hit zero and
 * the delete lost a race, or a GM edited it down by hand. Subscribing it would
 * put a ward on the bus that absorbs nothing and never expires.
 */
export function wardIsLive(ward) {
    return (Number(ward?.pool) || 0) > 0 || (Number(ward?.charges) || 0) > 0;
}

/** The interception trees an item declares, as [entry, tree] pairs. */
export function interceptionTreesOf(item) {
    const on = item?.system?.magic?.on ?? {};
    const out = [];
    for (const entry of Object.values(ENTRY)) {
        const tree = on[entry];
        if (Array.isArray(tree) && tree.length) out.push([entry, tree]);
    }
    return out;
}

/**
 * Rebuild every ward subscription for one actor from that actor's badges.
 *
 * Clears the actor's existing subscriptions first, so a dispelled ward stops
 * intercepting rather than lingering until the tab closes. Returns the number
 * of subscriptions registered.
 */
export async function rebuildWardsFor(actor, { resolveItem = null } = {}) {
    if (!actor) return 0;

    /* CARRY THE LIFETIME ACROSS THE REBUILD.
     *
     * `core:createShield` attaches the ward's lifetime to the same state object
     * the subscription holds (`state.life`), and `absorbDamage` /
     * `consumeCharge` end the ward by firing `POOL_EMPTY` through it. A rebuild
     * that hands the subscription a fresh state object silently drops that
     * handle — the pool would empty, the ward would stop absorbing, and the
     * `onExpire` tree would never run. Active Shield's parting blast is the
     * case that would go missing.
     *
     * The badge is authoritative for what is LEFT; the old state is
     * authoritative for what the ward is attached to. */
    const carried = new Map();
    for (const sub of allSubscriptions()) {
        if (sub.owner !== actor || !sub.state?.life) continue;
        carried.set(sub.key ?? `${sub.entry}|${sub.source?.uuid ?? ""}`, sub.state.life);
    }
    unsubscribeOwner(actor);

    const lookup = resolveItem ?? (async (uuid, id) => {
        if (uuid) { try { return await fromUuid(uuid); } catch (_) { /* fall through */ } }
        return id ? (actor.items?.get?.(id) ?? null) : null;
    });

    let n = 0;
    for (const ward of wardsOn(actor)) {
        if (!wardIsLive(ward)) continue;
        let item = null;
        try { item = await lookup(ward.itemUuid, ward.itemId); }
        catch (_) { item = null; }
        if (!item) continue;

        const trees = interceptionTreesOf(item);
        if (!trees.length) continue;

        /* One state object shared by every entry the item declares, exactly as
         * `core:createShield` builds it — a ward that intercepts at two stages
         * spends from one pool. */
        const state = { pool: ward.pool, charges: ward.charges, absorbs: ward.absorbs };
        const record = { kind: ward.magicKind, casterRoll: ward.casterRoll };
        for (const [entry, tree] of trees) {
            const key  = `${actor.uuid}|${entry}|${item.uuid}`;
            const life = carried.get(key) ?? carried.get(`${entry}|${item.uuid}`) ?? null;
            if (life) state.life = life;
            subscribe({ owner: actor, entry, tree, state, record, source: item });
            n++;
        }
    }
    return n;
}

/**
 * Rebuild every ward in the world. Run by the active GM on `ready` and
 * whenever a ward badge is created, changed or removed.
 *
 * Deliberately walks `game.actors` rather than the current scene's tokens: a
 * ward belongs to a person, not to a placement, and an unlinked token actor
 * appears in neither list reliably. Synthetic token actors are picked up via
 * the scene sweep below.
 */
export async function rebuildAllWards() {
    let total = 0;
    const seen = new Set();
    const consider = async (actor) => {
        if (!actor || seen.has(actor.uuid)) return;
        seen.add(actor.uuid);
        total += await rebuildWardsFor(actor);
    };
    for (const actor of globalThis.game?.actors ?? []) await consider(actor);
    for (const scene of globalThis.game?.scenes ?? []) {
        for (const token of scene.tokens ?? []) {
            if (token.actorLink) continue;          // already covered by game.actors
            await consider(token.actor);
        }
    }
    return total;
}

/** True when this client is the one that owns engine state. */
export function isEngineHost() {
    /* `globalThis.game`, not a bare `game`: this module is imported by
     * `intercept.mjs`, which the unit suites exercise outside Foundry. A bare
     * identifier that does not resolve is a ReferenceError, not `undefined`,
     * so the bare form turned every interception test into a crash. */
    return !!globalThis.game?.user?.isActiveGM;
}
