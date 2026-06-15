/**
 * Merchant transactions — GM-authoritative asset transfers.
 *
 * These run on the active GM's client only (the socket layer in
 * module/merchant/net.mjs proxies player requests here). They mutate two
 * actors at once — buyer/seller and merchant — so they must never run
 * speculatively on a player client.
 *
 * Ported from witcher-merchant-system buy-sheet.js (gmProcessPurchase,
 * gmFinalizeSale, gmRollPriceReveal). Adapted to the new actor model:
 *   - settlement denomination is `merchant.system.shopDenom` (a six-denom
 *     currencySchema key), not a free string — no plural normalization.
 *   - rarity DC reads `system.availability` via pricing.rarityDC.
 *   - the Business check uses extendedRoll (Witcher d10 explode/fumble),
 *     reading the PREPARED stat/skill values (modifiers already folded in).
 */

import { SYSTEM_ID } from "../setup/config.mjs";
import { extendedRoll } from "../rolls/extendedRoll.mjs";
import { finalUnitPrice, totalPrice as totalPriceOf, rarityDC, itemMarkupOf } from "./pricing.mjs";

const MODULE_ID = SYSTEM_ID;
const ITEM_MARKUP_FLAG = "itemMarkup";

/** Coins an actor holds in a given denomination (flat integer in the schema). */
function coinOf(actor, denom) {
    return Number(foundry.utils.getProperty(actor, `system.currency.${denom}`)) || 0;
}

/** Strip ids and merchant-only flags so item data is clean to re-create. */
function portableItemData(item, qty) {
    const data = item.toObject();
    delete data._id;
    data.system.quantity = qty;
    if (data.flags?.[MODULE_ID]?.[ITEM_MARKUP_FLAG]) delete data.flags[MODULE_ID][ITEM_MARKUP_FLAG];
    return data;
}

/** Add a stack to an actor, merging into a same name+type row when present. */
async function depositItem(actor, itemData, qty, renderOpt) {
    const existing = actor.items.find(i => i.name === itemData.name && i.type === itemData.type);
    if (existing) {
        const newQty = (Number(existing.system.quantity) || 0) + qty;
        await existing.update({ "system.quantity": newQty }, renderOpt);
    } else {
        await actor.createEmbeddedDocuments("Item", [itemData], renderOpt);
    }
}

/** Remove `qty` from a stock row, deleting the row when it empties. */
async function withdrawItem(item, qty, available, renderOpt) {
    if (available <= qty) await item.delete(renderOpt);
    else await item.update({ "system.quantity": available - qty }, renderOpt);
}

/**
 * GM-side: a buyer purchases `qty` of a merchant's item. Deducts buyer coin in
 * the shop denomination, credits the merchant reserve, moves stock.
 *
 * @returns {Promise<{ok: boolean, message: string, finalPrice?: number}>}
 */
export async function processPurchase({ merchantId, itemId, qty, buyerActorId }) {
    const merchant = game.actors.get(merchantId);
    if (!merchant) return { ok: false, message: "Merchant not found." };
    const buyer = game.actors.get(buyerActorId);
    if (!buyer) return { ok: false, message: "Buyer character not found." };
    const item = merchant.items.get(itemId);
    if (!item) return { ok: false, message: "Item no longer available." };

    qty = Math.max(1, Math.floor(Number(qty) || 1));
    const available = Number(item.system.quantity) || 0;
    if (available < qty) return { ok: false, message: `Only ${available} available.` };

    const denom = merchant.system.shopDenom || "crown";
    const price = totalPriceOf(merchant, item, qty, buyerActorId);

    const buyerCoin = coinOf(buyer, denom);
    if (buyerCoin < price) {
        return { ok: false, message: `Not enough ${denom}. Need ${price}, have ${buyerCoin}.` };
    }

    const itemData = portableItemData(item, qty);
    const renderOpt = { render: false };

    await buyer.update({ [`system.currency.${denom}`]: buyerCoin - price }, renderOpt);
    await merchant.update({ [`system.currency.${denom}`]: coinOf(merchant, denom) + price }, renderOpt);
    await withdrawItem(item, qty, available, renderOpt);
    await depositItem(buyer, itemData, qty, renderOpt);

    return { ok: true, message: `Purchased ${qty}× ${item.name} for ${price} ${denom}.`, finalPrice: price };
}

/**
 * GM-side: finalize an agreed sale. Seller's item → merchant; merchant coin →
 * seller, at the negotiated `price` per unit in the shop denomination.
 *
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export async function finalizeSale({ sellerActorId, merchantId, itemId, qty, price }) {
    const seller = game.actors.get(sellerActorId);
    const merchant = game.actors.get(merchantId);
    if (!seller || !merchant) return { ok: false, message: "Seller or merchant not found." };

    const item = seller.items.get(itemId);
    if (!item) return { ok: false, message: "Item is no longer in seller inventory." };

    qty = Math.max(1, Math.floor(Number(qty) || 1));
    const available = Number(item.system.quantity) || 0;
    if (available < qty) return { ok: false, message: `Seller only has ${available} of that item.` };

    const denom = merchant.system.shopDenom || "crown";
    const total = Math.max(0, Math.round((Number(price) || 0) * qty));
    const reserve = coinOf(merchant, denom);
    if (total > reserve) return { ok: false, message: `Merchant doesn't have enough coin (${reserve} ${denom}).` };

    const itemData = portableItemData(item, qty);
    const itemName = item.name;
    const renderOpt = { render: false };

    await withdrawItem(item, qty, available, renderOpt);
    await merchant.update({ [`system.currency.${denom}`]: reserve - total }, renderOpt);
    await seller.update({ [`system.currency.${denom}`]: coinOf(seller, denom) + total }, renderOpt);
    await depositItem(merchant, itemData, qty, renderOpt);

    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: seller }),
        content: `<em>sold ${qty}× ${itemName} to ${merchant.name} for ${total} ${denom}.</em>`
    });

    return { ok: true, message: `Sold ${qty}× ${itemName} for ${total} ${denom}.` };
}

/* -------------------------------------------- */
/*  Price-reveal Business check                 */
/* -------------------------------------------- */

/** Lowercased, trimmed item name — a stable key across restocks. */
function slugItemName(name) {
    return String(name ?? "").toLowerCase().trim();
}

const SECONDS_PER_DAY = 86400;

/** Current in-game day index from the native world clock (no calendar needed). */
function currentInGameDay() {
    return Math.floor((game.time?.worldTime ?? 0) / SECONDS_PER_DAY);
}

/**
 * True if this buyer is barred from appraising at this merchant — a prior
 * Business check failed and the in-game day hasn't rolled over yet.
 */
export function isAppraisalLocked(buyerActor, merchantId) {
    if (!buyerActor) return false;
    const locks = buyerActor.getFlag(MODULE_ID, "appraisalLocks") || {};
    const unlockDay = Number(locks[merchantId]);
    return Number.isFinite(unlockDay) && currentInGameDay() < unlockDay;
}

/** Bar this buyer from appraising at this merchant until the next in-game day. */
async function lockAppraisal(buyerActor, merchantId) {
    if (!buyerActor) return;
    const locks = foundry.utils.duplicate(buyerActor.getFlag(MODULE_ID, "appraisalLocks") || {});
    locks[merchantId] = currentInGameDay() + 1;
    try {
        await buyerActor.setFlag(MODULE_ID, "appraisalLocks", locks);
    } catch (err) {
        console.warn(`[${MODULE_ID}] failed to persist appraisal lock:`, err);
    }
}

/** Prices this buyer has already identified at a given merchant. */
export function getRevealedPricesFor(buyerActor, merchantId) {
    if (!buyerActor) return {};
    const all = buyerActor.getFlag(MODULE_ID, "revealedPrices") || {};
    return all[merchantId] || {};
}

async function setRevealedPriceFor(buyerActor, merchantId, itemName, basePrice) {
    if (!buyerActor) return;
    const all = foundry.utils.duplicate(buyerActor.getFlag(MODULE_ID, "revealedPrices") || {});
    const perMerchant = all[merchantId] || {};
    perMerchant[slugItemName(itemName)] = basePrice;
    all[merchantId] = perMerchant;
    try {
        await buyerActor.setFlag(MODULE_ID, "revealedPrices", all);
    } catch (err) {
        console.warn(`[${MODULE_ID}] failed to persist revealed price:`, err);
    }
}

/**
 * GM-side: roll a buyer's Business check (1d10 + INT + Business) to identify an
 * item's fair price. On success, persist the reveal on the buyer actor so it
 * survives restocks. Posts a Witcher-dice chat card via extendedRoll.
 *
 * @returns {Promise<{ok: boolean, message?: string, success?: boolean,
 *                     roll?: number, dc?: number, basePrice?: number}>}
 */
export async function rollPriceReveal({ merchantId, itemId, buyerActorId }) {
    const merchant = game.actors.get(merchantId);
    if (!merchant) return { ok: false, message: "Merchant not found." };
    const buyer = game.actors.get(buyerActorId);
    if (!buyer) return { ok: false, message: "Character not found." };
    const item = merchant.items.get(itemId);
    if (!item) return { ok: false, message: "Item not found." };

    if (isAppraisalLocked(buyer, merchantId)) {
        return { ok: false, locked: true, message: game.i18n.localize("WITCHER.Merchant.AppraisalLocked") };
    }

    const dc = rarityDC(item);

    // Prepared values already fold in stat/skill modifiers (prepareDerivedData).
    const intVal = Number(foundry.utils.getProperty(buyer, "system.stats.int.value")) || 0;
    const skill = foundry.utils.getProperty(buyer, "system.skills.int.business") || {};
    const skillTotal = (Number(skill.value) || 0) + (Number(skill.modifier) || 0);

    const flavor = `<div class="wdm-merchant-check">
        <strong>${game.i18n.localize("WITCHER.Merchant.BusinessCheck")}</strong> — ${item.name}
    </div>`;

    const result = await extendedRoll(
        `1d10 + ${intVal} + ${skillTotal}`,
        { speaker: ChatMessage.getSpeaker({ actor: buyer }), flavor },
        {
            threshold: dc,
            messageOnSuccess: game.i18n.localize("WITCHER.Merchant.PriceRevealed"),
            messageOnFailure: game.i18n.localize("WITCHER.Merchant.PriceHidden")
        }
    );

    const success = result.total >= dc;
    const basePrice = Number(item.system.cost) || 0;
    if (success) await setRevealedPriceFor(buyer, merchantId, item.name, basePrice);
    else await lockAppraisal(buyer, merchantId);

    return { ok: true, success, roll: result.total, dc, basePrice };
}

/* -------------------------------------------- */
/*  Relationship standing                       */
/* -------------------------------------------- */

/**
 * GM-side: nudge a buyer's standing with a merchant by `delta`, clamped to
 * [-100, 100]. Creates the relation row if absent. Used by negotiation
 * outcomes and manual GM adjustments.
 *
 * @returns {Promise<number>} the new standing value
 */
export async function adjustRelationship(merchant, buyerActorId, delta) {
    const relations = foundry.utils.duplicate(merchant.system.playerRelations ?? []);
    let entry = relations.find(r => r.playerId === buyerActorId);
    if (!entry) {
        entry = { playerId: buyerActorId, relationship: 0, lastNegotiation: 0, notes: "" };
        relations.push(entry);
    }
    entry.relationship = Math.max(-100, Math.min(100, (Number(entry.relationship) || 0) + delta));
    entry.lastNegotiation = Date.now();
    await merchant.update({ "system.playerRelations": relations });
    return entry.relationship;
}

export { finalUnitPrice, itemMarkupOf };
