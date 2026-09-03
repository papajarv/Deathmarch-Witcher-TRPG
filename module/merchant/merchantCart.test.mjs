// module/merchant/merchantCart.test.mjs
//
// EXECUTING test for processCartPurchase — the atomic multi-line checkout
// behind the shop's basket window.
//
// The property under test is all-or-nothing: a cart that fails ANY line (stock
// gone, not enough coin in the purse for the GRAND total) must leave both
// actors exactly as it found them. Looping the single-item processPurchase
// would deduct coin line by line and strand a buyer mid-cart, which is the
// regression these cases exist to catch.

import test from "node:test";
import assert from "node:assert/strict";

// transactions.mjs pulls in setup/config.mjs (SYSTEM_ID), the i18n helpers, and
// extendedRoll at import time. Stub the Foundry globals they touch first.
globalThis.foundry = {
    data: { fields: {} },
    utils: {
        getProperty: (obj, path) => path.split(".").reduce((o, k) => o?.[k], obj)
    }
};

const ACTORS = {};
globalThis.game = {
    actors: { get: (id) => ACTORS[id] ?? null },
    i18n: {
        localize: (k) => k,
        format: (k, d) => `${k} ${JSON.stringify(d)}`
    },
    settings: { get: () => undefined }
};
globalThis.CONFIG = {};
globalThis.Hooks = { on: () => {}, once: () => {}, callAll: () => {} };
globalThis.ui = { notifications: { warn: () => {}, info: () => {}, error: () => {} } };

globalThis.ChatMessage = { create: async()=>{}, getSpeaker: ()=>({}) };

const { processCartPurchase, finalizeBundleSale } = await import("./transactions.mjs");

/* ── Fixtures ─────────────────────────────────────────────────────────────
 * Minimal stand-ins for Foundry documents: just enough surface for the code
 * under test (items.get, update, delete, createEmbeddedDocuments, getFlag). */

function makeItem(id, name, cost, quantity, { service = false } = {}) {
    return {
        id, name, type: "valuable",
        deleted: false,
        system: { cost, quantity },
        getFlag: (_scope, key) => (key === "isService" ? service : undefined),
        toObject() {
            return { _id: id, name, type: "valuable", system: { ...this.system }, flags: {} };
        },
        async update(data) { Object.assign(this.system, { quantity: data["system.quantity"] }); },
        async delete() { this.deleted = true; }
    };
}

function makeMerchant(id, items, coin = 0) {
    const map = new Map(items.map(i => [i.id, i]));
    const actor = {
        id,
        system: {
            shopDenom: "crown",
            currency: { crown: coin },
            pricing: { baseMarkup: 1.0, buybackPercent: 50, bulkDiscountThreshold: 0, bulkDiscountPercent: 0 },
            personality: { type: "neutral" },
            playerRelations: [],
            buyCategories: [],
            demographicModifiers: []
        },
        // `find` + `createEmbeddedDocuments` are only exercised by the SELL
        // direction, where goods are deposited INTO the merchant.
        received: [],
        items: { get: (i) => map.get(i) ?? null, find: (fn) => items.find(fn) ?? null },
        async update(data) {
            for (const [k, v] of Object.entries(data)) {
                if (k === "system.currency.crown") actor.system.currency.crown = v;
            }
        },
        async createEmbeddedDocuments(_type, docs) { actor.received.push(...docs); return docs; },
        async updateEmbeddedDocuments(_type, patches) { actor.patched = patches; return patches; }
    };
    return actor;
}

function makeBuyer(id, coin) {
    const created = [];
    return {
        id, created,
        system: { currency: { crown: coin } },
        items: { find: () => null, get: () => null },
        async update(data) {
            for (const [k, v] of Object.entries(data)) {
                if (k === "system.currency.crown") this.system.currency.crown = v;
            }
        },
        async createEmbeddedDocuments(_type, docs) { created.push(...docs); return docs; }
    };
}

function scenario({ buyerCoin = 1000, stock } = {}) {
    const items = stock ?? [
        makeItem("sword", "Steel Sword", 100, 2),
        makeItem("rope", "Rope", 10, 5)
    ];
    const merchant = makeMerchant("m1", items, 50);
    const buyer = makeBuyer("b1", buyerCoin);
    ACTORS.m1 = merchant;
    ACTORS.b1 = buyer;
    return { merchant, buyer, items };
}

/* ── Happy path ───────────────────────────────────────────────────────────── */

test("a cart settles every line in one transaction", async () => {
    const { merchant, buyer, items } = scenario();

    const r = await processCartPurchase({
        merchantId: "m1", buyerActorId: "b1",
        lines: [{ itemId: "sword", qty: 1 }, { itemId: "rope", qty: 3 }]
    });

    assert.equal(r.ok, true);
    assert.equal(r.finalPrice, 130);                       // 100 + 3×10
    assert.equal(buyer.system.currency.crown, 870);        // 1000 − 130
    assert.equal(merchant.system.currency.crown, 180);     // 50 + 130
    assert.equal(items[0].system.quantity, 1);             // 2 − 1
    assert.equal(items[1].system.quantity, 2);             // 5 − 3
    assert.equal(buyer.created.length, 2);
});

test("a line that clears the shelf deletes the stock row", async () => {
    const { items } = scenario();

    const r = await processCartPurchase({
        merchantId: "m1", buyerActorId: "b1",
        lines: [{ itemId: "sword", qty: 2 }]
    });

    assert.equal(r.ok, true);
    assert.equal(items[0].deleted, true);
});

/* ── Atomicity ────────────────────────────────────────────────────────────── */

test("an unaffordable cart changes NOTHING — coin and stock both untouched", async () => {
    // 1×sword (100) + 5×rope (50) = 150, purse holds 120.
    const { merchant, buyer, items } = scenario({ buyerCoin: 120 });

    const r = await processCartPurchase({
        merchantId: "m1", buyerActorId: "b1",
        lines: [{ itemId: "sword", qty: 1 }, { itemId: "rope", qty: 5 }]
    });

    assert.equal(r.ok, false);
    assert.equal(buyer.system.currency.crown, 120, "purse untouched");
    assert.equal(merchant.system.currency.crown, 50, "merchant reserve untouched");
    assert.equal(items[0].system.quantity, 2, "sword stock untouched");
    assert.equal(items[1].system.quantity, 5, "rope stock untouched");
    assert.equal(buyer.created.length, 0, "nothing delivered");
});

test("one out-of-stock line rejects the WHOLE cart, including affordable lines", async () => {
    const { buyer, items } = scenario();

    const r = await processCartPurchase({
        merchantId: "m1", buyerActorId: "b1",
        // rope is fine; sword asks for 5 when only 2 are on the shelf.
        lines: [{ itemId: "rope", qty: 1 }, { itemId: "sword", qty: 5 }]
    });

    assert.equal(r.ok, false);
    assert.equal(items[1].system.quantity, 5, "the good line was NOT bought");
    assert.equal(buyer.system.currency.crown, 1000);
    assert.equal(buyer.created.length, 0);
});

test("a vanished item rejects the cart rather than silently skipping it", async () => {
    const { buyer } = scenario();

    const r = await processCartPurchase({
        merchantId: "m1", buyerActorId: "b1",
        lines: [{ itemId: "sword", qty: 1 }, { itemId: "ghost", qty: 1 }]
    });

    assert.equal(r.ok, false);
    assert.equal(buyer.system.currency.crown, 1000);
});

/* ── Untrusted input ──────────────────────────────────────────────────────── */

test("duplicate lines are folded before the stock check, not validated apart", async () => {
    // Two lines of 2 each against a shelf of 2. Checked separately both would
    // pass; folded to 4 the cart is correctly refused.
    const { buyer, items } = scenario();

    const r = await processCartPurchase({
        merchantId: "m1", buyerActorId: "b1",
        lines: [{ itemId: "sword", qty: 2 }, { itemId: "sword", qty: 2 }]
    });

    assert.equal(r.ok, false, "4 swords requested, 2 in stock");
    assert.equal(items[0].system.quantity, 2);
    assert.equal(buyer.system.currency.crown, 1000);
});

test("duplicate lines that DO fit are charged once, at the combined quantity", async () => {
    const { buyer, items } = scenario();

    const r = await processCartPurchase({
        merchantId: "m1", buyerActorId: "b1",
        lines: [{ itemId: "rope", qty: 2 }, { itemId: "rope", qty: 1 }]
    });

    assert.equal(r.ok, true);
    assert.equal(r.finalPrice, 30, "3×10, not double-counted");
    assert.equal(items[1].system.quantity, 2, "5 − 3");
    assert.equal(buyer.created.length, 1, "one merged delivery, not two");
});

test("an empty cart is refused without touching either actor", async () => {
    const { buyer, merchant } = scenario();
    for (const lines of [[], undefined, null]) {
        const r = await processCartPurchase({ merchantId: "m1", buyerActorId: "b1", lines });
        assert.equal(r.ok, false);
    }
    assert.equal(buyer.system.currency.crown, 1000);
    assert.equal(merchant.system.currency.crown, 50);
});

/* ── Services ─────────────────────────────────────────────────────────────── */

test("a service line is paid for but transfers no stock and never runs out", async () => {
    const bed = makeItem("bed", "A Night at the Inn", 15, 0, { service: true });
    const { merchant, buyer } = scenario({ stock: [bed, makeItem("rope", "Rope", 10, 5)] });

    const r = await processCartPurchase({
        merchantId: "m1", buyerActorId: "b1",
        lines: [{ itemId: "bed", qty: 2 }]      // qty 2 despite quantity: 0
    });

    assert.equal(r.ok, true, "a service ignores the stock check");
    assert.equal(r.finalPrice, 30);
    assert.equal(buyer.system.currency.crown, 970);
    assert.equal(merchant.system.currency.crown, 80);
    assert.equal(buyer.created.length, 0, "no item delivered for a service");
    assert.equal(bed.deleted, false, "service stock is not consumed");
});

/* ── Bundle sale (the sell cart's mirror of processCartPurchase) ──────────── */

function sellScenario({ reserve = 500, held } = {}) {
    const pack = held ?? [makeItem("boots", "Old Boots", 20, 1), makeItem("pelt", "Pelt", 5, 3)];
    const packMap = new Map(pack.map(i => [i.id, i]));
    const merchant = makeMerchant("m1", [], reserve);
    const seller = makeBuyer("b1", 0);
    seller.items = Object.assign([...pack], { find: () => null, get: (i) => packMap.get(i) ?? null });
    seller.updateEmbeddedDocuments = async (_t, patches) => { seller.patched = patches; return patches; };
    ACTORS.m1 = merchant; ACTORS.b1 = seller;
    return { merchant, seller, pack };
}

test("a bundle sale moves every line and pays the ONE negotiated total", async () => {
    const { merchant, seller, pack } = sellScenario();

    const r = await finalizeBundleSale({
        sellerActorId: "b1", merchantId: "m1", price: 42,
        lines: [{ itemId: "boots", qty: 1 }, { itemId: "pelt", qty: 2 }]
    });

    assert.equal(r.ok, true);
    assert.equal(seller.system.currency.crown, 42, "paid the haggled total, not a re-derived per-unit sum");
    assert.equal(merchant.system.currency.crown, 458);   // 500 − 42
    assert.equal(pack[0].deleted, true, "the single pair of boots left the pack");
    assert.equal(pack[1].system.quantity, 1, "3 − 2 pelts");
    assert.equal(merchant.received.length, 2, "both lines landed in the merchant's stock");
});

test("a bundle the merchant can't cover changes NOTHING", async () => {
    const { merchant, seller, pack } = sellScenario({ reserve: 30 });

    const r = await finalizeBundleSale({
        sellerActorId: "b1", merchantId: "m1", price: 100,
        lines: [{ itemId: "boots", qty: 1 }]
    });

    assert.equal(r.ok, false);
    assert.equal(merchant.system.currency.crown, 30, "reserve untouched");
    assert.equal(seller.system.currency.crown, 0, "seller unpaid");
    assert.equal(pack[0].deleted, false, "goods stay in the pack");
});

test("a line the seller no longer holds rejects the whole bundle", async () => {
    const { merchant, seller, pack } = sellScenario();

    const r = await finalizeBundleSale({
        sellerActorId: "b1", merchantId: "m1", price: 40,
        lines: [{ itemId: "pelt", qty: 1 }, { itemId: "boots", qty: 9 }]   // holds 1
    });

    assert.equal(r.ok, false);
    assert.equal(pack[1].system.quantity, 3, "the good line was NOT sold");
    assert.equal(seller.system.currency.crown, 0);
    assert.equal(merchant.system.currency.crown, 500);
});

test("duplicate sell lines are folded before the held-quantity check", async () => {
    const { seller, pack } = sellScenario();
    // Two lines of 2 pelts against 3 held: apart both pass, folded to 4 it fails.
    const r = await finalizeBundleSale({
        sellerActorId: "b1", merchantId: "m1", price: 20,
        lines: [{ itemId: "pelt", qty: 2 }, { itemId: "pelt", qty: 2 }]
    });

    assert.equal(r.ok, false);
    assert.equal(pack[1].system.quantity, 3);
    assert.equal(seller.system.currency.crown, 0);
});

test("an empty bundle is refused", async () => {
    const { merchant, seller } = sellScenario();
    for (const lines of [[], undefined, null]) {
        assert.equal((await finalizeBundleSale({ sellerActorId:"b1", merchantId:"m1", price: 10, lines })).ok, false);
    }
    assert.equal(seller.system.currency.crown, 0);
    assert.equal(merchant.system.currency.crown, 500);
});

test("selling an item out of a bag sweeps the container's dangling reference", async () => {
    const boots = makeItem("boots", "Old Boots", 20, 1);
    const bag = makeItem("bag", "Satchel", 5, 1);
    bag.type = "container";
    bag.system.content = ["boots", "other"];
    const { seller } = sellScenario({ held: [boots, bag] });

    const r = await finalizeBundleSale({
        sellerActorId: "b1", merchantId: "m1", price: 10,
        lines: [{ itemId: "boots", qty: 1 }]
    });

    assert.equal(r.ok, true);
    assert.deepEqual(seller.patched, [{ _id: "bag", "system.content": ["other"] }],
        "the sold item was pruned from the bag, the rest of its contents kept");
});

test("a partial sale leaves the container reference alone (the row survives)", async () => {
    const pelt = makeItem("pelt", "Pelt", 5, 3);
    const bag = makeItem("bag", "Satchel", 5, 1);
    bag.type = "container";
    bag.system.content = ["pelt"];
    const { seller } = sellScenario({ held: [pelt, bag] });
    seller.patched = undefined;

    await finalizeBundleSale({
        sellerActorId: "b1", merchantId: "m1", price: 5,
        lines: [{ itemId: "pelt", qty: 1 }]   // 3 held → row stays
    });

    assert.equal(pelt.system.quantity, 2);
    assert.equal(seller.patched, undefined, "row still exists, so its reference is still valid");
});
