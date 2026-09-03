// module/magic/wardCharges.test.mjs
//
// EXECUTING test for a ward counted in BLOCKS rather than hit points.
//
// Demetia's Crest Surge turns aside "a number of water spells equal to 2 times
// your Spell Casting skill value" and has no pool at all, so it is authored
// `pool: "0"`. Two things followed from that and neither was visible from the
// spell's own tree:
//
//   1. `createShield` bailed on `hp <= 0`, so no badge was ever written. The
//      ward ran entirely off `state.charges` — a number on a bus subscription,
//      invisible on the sheet and gone on reload.
//   2. `consumeCharge` decremented that number and nothing else, so even once
//      a badge existed the count on the character would have drifted from the
//      count the block was working from.
//
// The point of the suite is that the badge and the block are the SAME number.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { _resetRegistry } from "./registry.mjs";
import { registerCoreBlocks } from "./blocks/core.mjs";
import { registerDefensiveBlocks } from "./blocks/defensive.mjs";
import { _resetBus, subscribe, publish, unsubscribe, subscriptionCount, ENTRY } from "./bus.mjs";
import { makeInterceptContext } from "./intercept.mjs";
import { runBody } from "./frame.mjs";
import { _resetLifetimes } from "./lifetimes.mjs";

const ADAPTER_SRC = readFileSync(new URL("./adapter.mjs", import.meta.url), "utf8");
const OWNER = { name: "Caster", id: "caster1" };
const WARD_ITEM = { id: "crest1", name: "Demetia's Crest Surge" };

/** A stand-in for the badge: one number, read and written the way the real
 *  ActiveEffect is. */
function badgeAdapter(start) {
    const log = [];
    return {
        log,
        charges: start,
        wardCharges(_a, itemId) { log.push(["read", itemId]); return this.charges; },
        async setWardCharges(_a, n, { itemId } = {}) {
            log.push(["write", n, itemId]);
            this.charges = n;
            return { charges: n };
        },
        async onNegate() { log.push(["negate"]); }
    };
}

/** Subscribe one charge ward and return a function that throws a spell at it. */
function raiseWard({ adapter, charges, state = {} }) {
    const tree = [
        { b: "core:consumeCharge", a: { n: "1" }, body: [{ b: "core:negateMagic" }] }
    ];
    const sub = subscribe({
        owner: OWNER, entry: ENTRY.INCOMING_MAGIC, tree,
        state: { pool: 0, charges, absorbs: "none", ...state },
        record: { casterRoll: 14 }, source: WARD_ITEM
    });
    const throwSpell = async () => {
        const payload = { target: OWNER, record: { kind: "spell", element: "water" }, vetoed: false };
        await publish(ENTRY.INCOMING_MAGIC, {
            owner: OWNER, payload,
            runTree: async (s, p) => {
                const ctx = makeInterceptContext(s, p, adapter);
                ctx.expire = () => unsubscribe(s);
                await runBody(s.tree, ctx);
            }
        });
        return payload;
    };
    return { sub, throwSpell };
}

test.beforeEach(() => {
    _resetRegistry(); _resetBus(); _resetLifetimes();
    registerCoreBlocks(); registerDefensiveBlocks();
});

test("spending a charge writes the remainder back to the badge", async () => {
    const adapter = badgeAdapter(3);
    const { throwSpell } = raiseWard({ adapter, charges: 3 });

    const out = await throwSpell();
    assert.equal(out.vetoed, true, "the ward should have turned the spell aside");
    assert.equal(adapter.charges, 2, "the badge must carry the decrement, not just `state`");
    assert.deepEqual(adapter.log.filter(r => r[0] === "write"), [["write", 2, "crest1"]]);
});

test("the badge is the source of truth, not the subscription's own number", async () => {
    /* The two disagree on purpose: a reload, a second client, or a GM editing
     * the effect leaves `state` stale. The badge wins. */
    const adapter = badgeAdapter(1);
    const { throwSpell } = raiseWard({ adapter, charges: 99 });

    await throwSpell();
    assert.equal(adapter.charges, 0, "spent the badge's last charge, not state's 99th");
});

test("a ward with no charges left turns nothing aside", async () => {
    const adapter = badgeAdapter(0);
    const { throwSpell } = raiseWard({ adapter, charges: 0 });

    const out = await throwSpell();
    assert.equal(out.vetoed, false, "an empty ward must let the spell through");
    assert.deepEqual(adapter.log.filter(r => r[0] === "write"), [], "and must not write a negative count");
});

test("the ward ends when its last charge goes", async () => {
    const adapter = badgeAdapter(1);
    const { throwSpell } = raiseWard({ adapter, charges: 1 });

    await throwSpell();
    assert.equal(subscriptionCount(), 0, "the subscription should have torn itself down");
    assert.equal(adapter.charges, 0);
});

test("charges are read against the ward's OWN item, not the incoming spell's", async () => {
    /* During an interception the adapter belongs to the attacking cast, so
     * anything keyed off `adapter.item` would look up the wrong ward. The
     * block passes the subscription's source id instead. */
    const adapter = badgeAdapter(2);
    const { throwSpell } = raiseWard({ adapter, charges: 2 });

    await throwSpell();
    assert.ok(adapter.log.some(r => r[0] === "read" && r[1] === "crest1"),
        "the read must name the ward's item");
    assert.ok(adapter.log.some(r => r[0] === "write" && r[2] === "crest1"),
        "and so must the write");
});

test("createShield no longer discards a ward that has charges but no pool", () => {
    /* The one-line bail this whole file exists because of. */
    assert.match(ADAPTER_SRC, /if \(grant <= 0 && nCharges > 0\)/);
    assert.match(ADAPTER_SRC, /writeWardCharges\(a, nCharges/);
});
