/**
 * The ward list is rebuilt from the world, not accumulated by whoever cast.
 *
 * The defect these tests stand against is a whole class, not a case: a
 * module-level array is per BROWSER, and the browser that raises a ward is
 * never the browser that resolves an attack against it. Everything here is
 * about the rebuild being faithful to the badges — because once the list is
 * derived from documents rather than from history, the client it is derived on
 * is a choice rather than an accident.
 *
 * Deliberately no Foundry: `wardsOn` reads a flag bag, `rebuildWardsFor` takes
 * its item lookup as a parameter. The parts that need a real world (the socket
 * hop, the AE hooks) are not testable here and are called out in the report
 * rather than faked.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { wardsOn, wardIsLive, interceptionTreesOf, rebuildWardsFor } from "./wardRegistry.mjs";
import { _resetBus, subscriptionsFor, subscriptionCount, subscribe,
         allSubscriptions, ENTRY } from "./bus.mjs";
import { SYSTEM_ID } from "./systemId.mjs";

const TREE = [{ b: "core:negateMagic" }];

/** An item carrying an interception tree. */
function item(uuid, on = { incomingMagic: TREE }) {
    return { uuid, id: uuid.split(".").pop(), name: "Ward", system: { magic: { on } } };
}

/** An actor carrying ward badges. */
function actor(uuid, badges = []) {
    return {
        uuid, name: uuid,
        effects: badges.map(f => ({ flags: { [SYSTEM_ID]: f } })),
        items: { get: () => null }
    };
}

const crestBadge = (over = {}) => ({
    castWard: true, wardCharges: 4, wardAbsorbs: "none",
    sourceItem: "Item.crest", sourceItemId: "crest", magicKind: "spell", ...over
});
const quenBadge = (over = {}) => ({
    castShield: true, activeShieldHp: 15, absorbs: "blockable",
    sourceItem: "Item.quen", sourceItemId: "quen", magicKind: "sign", ...over
});

test.beforeEach(() => _resetBus());

test("a badge is read back into the descriptor the rebuild needs", () => {
    const [w] = wardsOn(actor("a", [crestBadge()]));
    assert.equal(w.charges, 4);
    assert.equal(w.pool, 0, "a charge ward has no pool");
    assert.equal(w.itemUuid, "Item.crest");
    assert.equal(w.absorbs, "none");
});

test("an effect that is not a ward is ignored", () => {
    const a = actor("a", [{ someOtherFlag: true }, crestBadge()]);
    assert.equal(wardsOn(a).length, 1);
});

test("a spent ward is not put back on the bus", () => {
    assert.equal(wardIsLive({ pool: 0, charges: 0 }), false,
        "a leftover badge with nothing behind it would absorb nothing and never end");
    assert.equal(wardIsLive({ pool: 15, charges: 0 }), true);
    assert.equal(wardIsLive({ pool: 0, charges: 1 }), true);
});

test("only the entries the item actually declares are subscribed", () => {
    const pairs = interceptionTreesOf(item("Item.x", {
        incomingMagic: TREE, takeDamage: TREE, hit: [{ b: "core:dealDamage" }], miss: []
    }));
    const entries = pairs.map(([e]) => e);
    assert.deepEqual(entries.sort(), ["incomingMagic", "takeDamage"]);
    assert.ok(!entries.includes("hit"), "a cast tree is not an interception");
});

test("rebuilding subscribes the ward the badge describes", async () => {
    const a = actor("Actor.geralt", [crestBadge()]);
    const n = await rebuildWardsFor(a, { resolveItem: async () => item("Item.crest") });
    assert.equal(n, 1);
    const subs = subscriptionsFor(a, ENTRY.INCOMING_MAGIC);
    assert.equal(subs.length, 1);
    assert.equal(subs[0].state.charges, 4, "the badge is authoritative for what is left");
});

test("the badge overrides a stale in-memory count", async () => {
    /* The whole point of deriving from documents: whatever the tab thought,
     * the world is right. */
    const a = actor("Actor.geralt", [crestBadge({ wardCharges: 1 })]);
    const it = item("Item.crest");
    subscribe({ owner: a, entry: ENTRY.INCOMING_MAGIC, tree: TREE,
                state: { charges: 99 }, source: it });
    await rebuildWardsFor(a, { resolveItem: async () => it });
    assert.equal(subscriptionsFor(a, ENTRY.INCOMING_MAGIC)[0].state.charges, 1);
});

test("rebuilding does not double-subscribe", async () => {
    const a = actor("Actor.geralt", [crestBadge()]);
    const it = item("Item.crest");
    await rebuildWardsFor(a, { resolveItem: async () => it });
    await rebuildWardsFor(a, { resolveItem: async () => it });
    await rebuildWardsFor(a, { resolveItem: async () => it });
    assert.equal(subscriptionCount(), 1,
        "three rebuilds must leave one ward, or a Crest spends three charges per spell");
});

test("a ward that has gone stops intercepting", async () => {
    const a = actor("Actor.geralt", [crestBadge()]);
    const it = item("Item.crest");
    await rebuildWardsFor(a, { resolveItem: async () => it });
    a.effects = [];                                   // dispelled
    await rebuildWardsFor(a, { resolveItem: async () => it });
    assert.equal(subscriptionCount(), 0);
});

test("the lifetime handle survives a rebuild", async () => {
    /* `absorbDamage` ends the ward by firing POOL_EMPTY through `state.life`.
     * A rebuild that hands over a fresh state object would silently drop it —
     * the pool empties, and the onExpire tree never runs. */
    const a = actor("Actor.geralt", [quenBadge()]);
    const it = item("Item.quen", { takeDamage: TREE });
    const life = { id: "life-1" };
    subscribe({ owner: a, entry: ENTRY.TAKE_DAMAGE, tree: TREE,
                state: { pool: 15, life }, source: it });
    await rebuildWardsFor(a, { resolveItem: async () => it });
    assert.equal(subscriptionsFor(a, ENTRY.TAKE_DAMAGE)[0].state.life, life);
});

test("two different wards on one person both survive", async () => {
    const a = actor("Actor.geralt", [quenBadge(), crestBadge()]);
    const byUuid = { "Item.quen": item("Item.quen", { takeDamage: TREE }),
                     "Item.crest": item("Item.crest") };
    await rebuildWardsFor(a, { resolveItem: async (uuid) => byUuid[uuid] });
    assert.equal(subscriptionCount(), 2);
    assert.equal(subscriptionsFor(a, ENTRY.TAKE_DAMAGE).length, 1);
    assert.equal(subscriptionsFor(a, ENTRY.INCOMING_MAGIC).length, 1);
});

test("a ward whose item is gone is skipped rather than throwing", async () => {
    const a = actor("Actor.geralt", [crestBadge()]);
    const n = await rebuildWardsFor(a, { resolveItem: async () => null });
    assert.equal(n, 0);
    assert.equal(subscriptionCount(), 0);
});

test("one item cannot hold two subscriptions at the same entry", () => {
    /* The bus key. Without it the rebuild and `core:createShield`'s own inline
     * subscribe both land when the caster IS the host. */
    const a = actor("Actor.geralt");
    const it = item("Item.quen", { takeDamage: TREE });
    subscribe({ owner: a, entry: ENTRY.TAKE_DAMAGE, tree: TREE, state: { pool: 15 }, source: it });
    subscribe({ owner: a, entry: ENTRY.TAKE_DAMAGE, tree: TREE, state: { pool: 15 }, source: it });
    assert.equal(subscriptionCount(), 1);
    assert.equal(allSubscriptions()[0].state.pool, 15);
});

test("a subscription with no source item keeps the old append behaviour", () => {
    /* Hand-built wards and the existing test suites rely on it. */
    const a = actor("Actor.geralt");
    subscribe({ owner: a, entry: ENTRY.TAKE_DAMAGE, tree: TREE, state: {} });
    subscribe({ owner: a, entry: ENTRY.TAKE_DAMAGE, tree: TREE, state: {} });
    assert.equal(subscriptionCount(), 2);
});
