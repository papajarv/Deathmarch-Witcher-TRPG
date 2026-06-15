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

export const MODULE_ID = "witcher-ttrpg-death-march";
export const ITEM_MARKUP_FLAG = "itemMarkup";

/** Item types a merchant never stocks, sells, or buys: character-build items
 *  (profession/race/homeland) and learned magic (spell/hex/ritual) — knowledge,
 *  not tradeable goods. */
export const NON_MERCHANT_TYPES = ["profession", "race", "homeland", "spell", "hex", "ritual"];

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
    everywhere: 10,
    common:     12,
    poor:       14,
    rare:       18,
    witcher:    22
};

export function getPersonalityModifier(type) {
    return PERSONALITY_MODS[type] ?? 0;
}

/** Per-item markup multiplier (1.0 = no change), stored as a flag. */
export function itemMarkupOf(item) {
    return Number(item.getFlag(MODULE_ID, ITEM_MARKUP_FLAG)) || 1.0;
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
export function snapshotUnitPrice(merchant, item) {
    const baseCost      = Number(item.system.cost) || 0;
    const itemMarkup    = itemMarkupOf(item);
    const merchantMarkup = merchant.system.pricing?.baseMarkup ?? 1.0;
    const personalityMod = getPersonalityModifier(merchant.system.personality?.type);
    return Math.round(baseCost * itemMarkup * merchantMarkup * (1 + personalityMod));
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

    let unit = baseCost * itemMarkup * merchantMarkup * (1 + personalityMod) * (1 + relationMod);

    const bulkThreshold = merchant.system.pricing?.bulkDiscountThreshold ?? 0;
    const bulkPct       = merchant.system.pricing?.bulkDiscountPercent ?? 0;
    if (bulkThreshold > 0 && qty >= bulkThreshold && bulkPct > 0) {
        unit *= (1 - bulkPct / 100);
    }
    return unit;
}

/** Total price for a stack, never negative, rounded. */
export function totalPrice(merchant, item, qty, buyerActorId) {
    return Math.max(0, Math.round(finalUnitPrice(merchant, item, qty, buyerActorId) * qty));
}
