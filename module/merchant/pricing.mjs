/**
 * Merchant pricing — how a base item cost becomes a shop price.
 *
 * Ported from witcher-merchant-system buy-sheet.js (the authoritative buy-flow
 * formula, not the negotiation-dialog variant):
 *
 *   unit = baseCost × itemMarkup × merchantMarkup × (1 + personalityMod)
 *               × (1 + relationshipMod)
 *   unit ×= (1 − bulkPct/100)   when qty ≥ bulkThreshold
 *
 * `itemMarkup` is a per-item override stored as a flag on the merchant's
 * embedded item. The "snapshot" price shown in the buy list omits the
 * per-buyer relationship + bulk factors (those resolve at purchase time).
 *
 * Rarity drives the price-reveal Business-check DC. New-system items expose
 * rarity at `system.availability` (enum; absent on weapons/armor → everywhere).
 */

import { convertCurrency, ITEM_BASE_DENOM } from "../data/actor/templates/currency.mjs";

export const MODULE_ID = "witcher-ttrpg-death-march";
export const ITEM_MARKUP_FLAG = "itemMarkup";

/** Item types a merchant never stocks, sells, or buys: character-build items
 *  (profession/race/homeland) and learned magic (spell/hex/ritual) — knowledge,
 *  not tradeable goods. */
/* Types a merchant will never stock or take off your hands. Character-defining
 * entries (profession/race/homeland) and known abilities (spell/hex/ritual/perk)
 * aren't goods — and neither is a criticalWound, which is an injury on your body
 * modelled as an item. criticalWound happens to be the one item type that
 * doesn't spread baseItemSchema, so it carries no cost/quantity and today gets
 * filtered by the quantity check anyway; listing it here makes that intent
 * explicit instead of leaving it resting on a schema accident. */
export const NON_MERCHANT_TYPES = ["profession", "race", "homeland", "spell", "hex", "ritual", "perk", "criticalWound"];

const PERSONALITY_MODS = {
    friendly:  -0.10,
    grumpy:     0.15,
    shifty:     0.20,
    noble:      0.05,
    desperate: -0.25,
    neutral:    0
};

/** Business-check DC by item rarity (Core-ish difficulty ladder). */
export const RARITY_DC = {
    everywhere:   10,
    common:       12,
    poor:         14,
    rare:         18,
    witcher:      22,
    elderfolk:    20,
    relic:        24,
    goetia:       24,
    experimental: 22
};

export function getPersonalityModifier(type) {
    return PERSONALITY_MODS[type] ?? 0;
}

/* ── currency conversion ──────────────────────────────────────────────── */

/** The denomination a merchant quotes & settles in. */
function shopDenomOf(merchant) {
    return merchant?.system?.shopDenom || "crown";
}

/** Convert a base-denomination (crown) value into the merchant's shopDenom,
 *  rounded to whole coins — the settlement + display granularity. */
export function toShopPrice(merchant, baseValue) {
    return Math.max(0, Math.round(convertCurrency(Number(baseValue) || 0, ITEM_BASE_DENOM, shopDenomOf(merchant))));
}

/* ── buy-category acceptance ──────────────────────────────────────────── */

/** Whether this merchant will BUY items of `type` from a player. A type is
 *  accepted when it's tradeable (not in NON_MERCHANT_TYPES) AND either the
 *  merchant's `buyCategories` list is empty (accept all) or lists that type. */
export function acceptsBuyCategory(merchant, type) {
    if (NON_MERCHANT_TYPES.includes(type)) return false;
    const cats = merchant?.system?.buyCategories ?? [];
    return !cats.length || cats.includes(type);
}

/* ── race / profession price modifier ─────────────────────────────────── */

/** Multiplier from the buyer's race / profession per the merchant's
 *  `demographicModifiers`. Matches the buyer's embedded `race` / `profession`
 *  item NAMES (case-insensitive); multiple matches multiply together. Returns
 *  1.0 when nothing matches or there's no buyer. This is the BUY-side factor
 *  (>1 means the buyer pays more); the buyback side uses its reciprocal. */
export function demographicModifier(merchant, buyer) {
    const rules = merchant?.system?.demographicModifiers ?? [];
    if (!rules.length || !buyer) return 1.0;
    const have = { race: new Set(), profession: new Set() };
    for (const it of (buyer.items ?? [])) {
        if (it.type === "race")            have.race.add(String(it.name).toLowerCase().trim());
        else if (it.type === "profession") have.profession.add(String(it.name).toLowerCase().trim());
    }
    let mult = 1.0;
    for (const r of rules) {
        const kind = r?.kind === "profession" ? "profession" : "race";
        const nm   = String(r?.name ?? "").toLowerCase().trim();
        if (!nm || !have[kind].has(nm)) continue;
        const pct = Number(r.pricePercent);
        if (Number.isFinite(pct)) mult *= Math.max(0, pct) / 100;
    }
    return mult;
}

/** Resolve a buyer/seller actor from an id or pass through an actor. */
function resolveActor(buyerOrId) {
    if (!buyerOrId) return null;
    if (typeof buyerOrId === "string") return game.actors?.get(buyerOrId) ?? null;
    return buyerOrId;   // already an Actor
}

/** Per-item markup multiplier (1.0 = no change), stored as a flag. A stored
 *  0 means "free" (−100% discount) and must survive the read — the previous
 *  `Number(x) || 1.0` collapsed 0 back to 1.0 because 0 is falsy. */
export function itemMarkupOf(item) {
    const raw = item.getFlag(MODULE_ID, ITEM_MARKUP_FLAG);
    if (raw == null || raw === "") return 1.0;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, n) : 1.0;
}

/** Rarity key for an item; "everywhere" when the type carries no availability. */
export function rarityOf(item) {
    const raw = String(item?.system?.availability ?? "everywhere").toLowerCase().trim();
    return raw && raw !== "na" ? raw : "everywhere";
}

export function rarityDC(item) {
    return RARITY_DC[rarityOf(item)] ?? 10;
}

/**
 * Standing entry for a buyer character, or null.
 * Entries are keyed by the buyer's actor id (stored as `playerId`).
 */
export function getRelationEntry(merchant, buyerActorId) {
    const relations = merchant.system.playerRelations ?? [];
    return relations.find(r => r.playerId === buyerActorId) ?? null;
}

/**
 * Relationship price modifier: positive standing discounts (down to −25%),
 * negative standing marks up (up to +50%).
 */
export function getRelationshipModifier(merchant, buyerActorId) {
    const entry = getRelationEntry(merchant, buyerActorId);
    if (!entry) return 0;
    const v = Number(entry.relationship) || 0;
    return v >= 0 ? -(v * 0.0025) : -(v * 0.005);
}

/**
 * The price shown in the buy list — markup + personality only, rounded.
 * Per-buyer relationship and bulk discounts are applied at purchase.
 */
export function snapshotUnitPrice(merchant, item, buyer = null) {
    const baseCost      = Number(item.system.cost) || 0;
    const itemMarkup    = itemMarkupOf(item);
    const merchantMarkup = merchant.system.pricing?.baseMarkup ?? 1.0;
    const personalityMod = getPersonalityModifier(merchant.system.personality?.type);
    // The race/profession modifier is deterministic for a given buyer, so it IS
    // shown on the shelf when a `buyer` is supplied (the browsing character) —
    // that's what makes "a Witcher pays more here" visible while browsing. The
    // relationship + bulk factors still resolve only at purchase. Base value is
    // in crowns → convert to the shop's denomination for display.
    const demoMult = demographicModifier(merchant, resolveActor(buyer));
    return toShopPrice(merchant, baseCost * itemMarkup * merchantMarkup * (1 + personalityMod) * demoMult);
}

/**
 * The actual unit price a specific buyer pays, including relationship and the
 * bulk discount when the quantity clears the threshold.
 */
export function finalUnitPrice(merchant, item, qty, buyerActorId) {
    const baseCost       = Number(item.system.cost) || 0;
    const itemMarkup     = itemMarkupOf(item);
    const merchantMarkup = merchant.system.pricing?.baseMarkup ?? 1.0;
    const personalityMod = getPersonalityModifier(merchant.system.personality?.type);
    const relationMod    = getRelationshipModifier(merchant, buyerActorId);
    const demoMult       = demographicModifier(merchant, resolveActor(buyerActorId));

    let unit = baseCost * itemMarkup * merchantMarkup * (1 + personalityMod) * (1 + relationMod) * demoMult;

    const bulkThreshold = merchant.system.pricing?.bulkDiscountThreshold ?? 0;
    const bulkPct       = merchant.system.pricing?.bulkDiscountPercent ?? 0;
    if (bulkThreshold > 0 && qty >= bulkThreshold && bulkPct > 0) {
        unit *= (1 - bulkPct / 100);
    }
    return unit;   // per-unit value in the BASE denomination (crowns), unrounded
}

/** Total price for a stack in the merchant's shopDenom, never negative, rounded
 *  once after conversion. */
export function totalPrice(merchant, item, qty, buyerActorId) {
    return toShopPrice(merchant, finalUnitPrice(merchant, item, qty, buyerActorId) * qty);
}

/**
 * Per-unit price this merchant offers when BUYING an item from a player.
 * Uses only the item's base cost (not the merchant's sell-side markup) so
 * a greedy shop isn't inadvertently more generous on buybacks.
 */
export function buybackUnitPrice(merchant, item, seller = null) {
    const baseCost = Number(item?.system?.cost) || 0;
    const pct      = Number(merchant?.system?.pricing?.buybackPercent);
    const rate     = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 50;
    // Symmetric demographic factor: a race charged MORE to buy (mult > 1) is
    // paid proportionally LESS on a buyback → reciprocal of the buy-side mult.
    const demoMult = demographicModifier(merchant, resolveActor(seller));
    const sellMult = demoMult > 0 ? 1 / demoMult : 1;
    return toShopPrice(merchant, baseCost * rate / 100 * sellMult);
}
