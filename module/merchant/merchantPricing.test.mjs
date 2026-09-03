// module/merchant/merchantPricing.test.mjs
//
// EXECUTING test for the merchant currency conversion (crown-anchored),
// buy-category acceptance, and the symmetric race/profession price modifier.

import test from "node:test";
import assert from "node:assert/strict";

// currency.mjs reads `foundry.data.fields` at import; pricing.mjs resolves a
// buyer id via `game.actors.get`. Mock the minimum before importing.
globalThis.foundry = { data: { fields: {} } };
const ACTORS = {};
globalThis.game = { actors: { get: (id) => ACTORS[id] ?? null } };

const { convertCurrency, ITEM_BASE_DENOM } = await import("../data/actor/templates/currency.mjs");
const { toShopPrice, buybackUnitPrice, finalUnitPrice, totalPrice,
        acceptsBuyCategory, demographicModifier, snapshotUnitPrice } = await import("./pricing.mjs");

const approx = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} ≈ ${b}`);

test("ITEM_BASE_DENOM is crown", () => assert.equal(ITEM_BASE_DENOM, "crown"));

test("convertCurrency is crown-anchored and matches the lore rates", () => {
    approx(convertCurrency(1, "crown", "crown"), 1, "crown→crown");
    approx(convertCurrency(1, "crown", "oren"),  1, "1 crown = 1 oren");
    approx(convertCurrency(1, "crown", "ducat"), 3, "1 crown = 3 ducats");
    approx(convertCurrency(3, "crown", "floren"), 1, "3 crowns = 1 floren");
    approx(convertCurrency(4, "crown", "bizant"), 1, "4 crowns = 1 bizant");
    approx(convertCurrency(2, "crown", "lintar"), 1, "2 crowns = 1 lintar");
    approx(convertCurrency(3, "ducat", "crown"), 1, "3 ducats = 1 crown (round-trip)");
});

const merchant = (over = {}) => ({
    system: {
        shopDenom: "crown",
        pricing: { baseMarkup: 1.0, buybackPercent: 50, bulkDiscountThreshold: 0, bulkDiscountPercent: 0 },
        personality: { type: "neutral" },
        playerRelations: [],
        buyCategories: [],
        demographicModifiers: [],
        ...over
    }
});
const item = (cost) => ({ system: { cost }, getFlag: () => undefined });

test("toShopPrice converts a crown base into the shop denom, whole coins", () => {
    assert.equal(toShopPrice(merchant({ shopDenom: "crown" }), 10), 10);
    assert.equal(toShopPrice(merchant({ shopDenom: "ducat" }), 10), 30);   // 10 crowns → 30 ducats
    assert.equal(toShopPrice(merchant({ shopDenom: "floren" }), 9), 3);    // 9 crowns → 3 florens
    assert.equal(toShopPrice(merchant({ shopDenom: "bizant" }), 8), 2);    // 8 crowns → 2 bizants
});

test("acceptsBuyCategory: empty = all, listed = only those, non-merchant always excluded", () => {
    assert.equal(acceptsBuyCategory(merchant(), "weapon"), true);           // empty → all
    assert.equal(acceptsBuyCategory(merchant({ buyCategories: ["weapon"] }), "weapon"), true);
    assert.equal(acceptsBuyCategory(merchant({ buyCategories: ["weapon"] }), "armor"), false);
    assert.equal(acceptsBuyCategory(merchant({ buyCategories: [] }), "spell"), false); // NON_MERCHANT_TYPES

    // A critical wound is an injury modelled as an item — never merchandise, in
    // either direction, even for a merchant with no category restrictions at all.
    assert.equal(acceptsBuyCategory(merchant(), "criticalWound"), false);
    assert.equal(acceptsBuyCategory(merchant({ buyCategories: ["criticalWound"] }), "criticalWound"), false,
        "an explicit buyCategory must not re-open it");
});

test("demographic modifier is symmetric: a disliked race pays MORE to buy, LESS on buyback", () => {
    ACTORS.elf = { items: [{ type: "race", name: "Elf" }] };
    const m = merchant({ demographicModifiers: [{ kind: "race", name: "Elf", pricePercent: 120 }] });

    // multiplier
    assert.equal(demographicModifier(m, ACTORS.elf), 1.2);
    assert.equal(demographicModifier(m, { items: [{ type: "race", name: "Human" }] }), 1.0);

    // buy: 100-crown item → Elf pays 120 (crowns, shopDenom=crown)
    assert.equal(totalPrice(m, item(100), 1, "elf"), 120);
    // buyback: 50% of 100 = 50 base, ×(1/1.2) → 42 (paid less)
    assert.equal(buybackUnitPrice(m, item(100), ACTORS.elf), 42);
    // a neutral human: buy 100, buyback 50
    ACTORS.human = { items: [{ type: "race", name: "Human" }] };
    assert.equal(totalPrice(m, item(100), 1, "human"), 100);
    assert.equal(buybackUnitPrice(m, item(100), ACTORS.human), 50);
});

test("snapshot with no buyer is demographic-neutral, still converts", () => {
    const m = merchant({ shopDenom: "ducat" });
    assert.equal(snapshotUnitPrice(m, item(10)), 30);   // 10 crowns → 30 ducats, no buyer
});

test("demographic match is EXACT item-name + kind — not a word/substring search", () => {
    const m = merchant({ demographicModifiers: [{ kind: "profession", name: "Witcher", pricePercent: 120 }] });
    // a PROFESSION item literally named "Witcher" (case-insensitive) → matches
    assert.equal(demographicModifier(m, { items: [{ type: "profession", name: "witcher" }] }), 1.2);
    // a RACE named "Witcher" → wrong kind, no match
    assert.equal(demographicModifier(m, { items: [{ type: "race", name: "Witcher" }] }), 1.0);
    // "Witcher Trainer" profession → not the exact name, no match (not a substring)
    assert.equal(demographicModifier(m, { items: [{ type: "profession", name: "Witcher Trainer" }] }), 1.0);
    // some other item type named Witcher → ignored
    assert.equal(demographicModifier(m, { items: [{ type: "weapon", name: "Witcher" }] }), 1.0);
});

test("shelf (browse) price reflects the browsing buyer's profession", () => {
    ACTORS.witcherPC = { items: [{ type: "profession", name: "Witcher" }] };
    const m = merchant({ demographicModifiers: [{ kind: "profession", name: "Witcher", pricePercent: 120 }] });
    assert.equal(snapshotUnitPrice(m, item(100), null), 100);            // neutral browser
    assert.equal(snapshotUnitPrice(m, item(100), ACTORS.witcherPC), 120); // Witcher browser pays 20% more
});
