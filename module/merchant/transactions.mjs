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
import { t, tFormat } from "../chrome/lib/i18n.js";
import { extendedRoll } from "../rolls/extendedRoll.mjs";
import { finalUnitPrice, totalPrice as totalPriceOf, rarityDC, itemMarkupOf } from "./pricing.mjs";

const MODULE_ID = SYSTEM_ID;
const ITEM_MARKUP_FLAG = "itemMarkup";

/** Coins an actor holds in a given denomination (flat integer in the schema). */
function coinOf(actor, denom) {
    return Number(foundry.utils.getProperty(actor, `system.currency.${denom}`)) || 0;
}

/** Strip ids and merchant-only flags so item data is clean to re-create.
 *
 * Merchant-scoped flags (`itemMarkup`, `isService`, `merchantFreshnessDecay`)
 * are only meaningful while the item is on a merchant sheet — carrying them
 * onto a buyer / seller-side actor would leave stale metadata that other
 * code paths might read defensively later. Drop them all here. */
function portableItemData(item, qty) {
    const data = item.toObject();
    delete data._id;
    data.system.quantity = qty;
    const modFlags = data.flags?.[MODULE_ID];
    if (modFlags) {
        delete modFlags[ITEM_MARKUP_FLAG];
        delete modFlags.isService;
        delete modFlags.merchantFreshnessDecay;
    }
    return data;
}

/** Add a stack to an actor, merging into a same name+type row when present.
 *
 * Exception: freshness-tracked food (`system.freshness.shelfLifeDays > 0`
 * on either the incoming or the existing stack) is NEVER merged. Each
 * stack carries a single `anchorTime` for its whole quantity; folding a
 * newly-purchased fresh apple into an existing spoiled apple row would
 * silently keep the old anchor and mark every unit spoiled. Keeping the
 * new purchase as its own row preserves per-stack freshness state. */
async function depositItem(actor, itemData, qty, renderOpt) {
    const incomingTracked = itemData?.type === "food"
        && (Number(itemData?.system?.freshness?.shelfLifeDays) || 0) > 0;
    const existing = incomingTracked ? null
        : actor.items.find(i => i.name === itemData.name && i.type === itemData.type
            && !((i.type === "food") && (Number(i.system?.freshness?.shelfLifeDays) || 0) > 0));
    if (existing) {
        const newQty = (Number(existing.system.quantity) || 0) + qty;
        await existing.update({ "system.quantity": newQty }, renderOpt);
    } else {
        await actor.createEmbeddedDocuments("Item", [itemData], renderOpt);
    }
}

/** Drop every reference to `item` from the actor's containers.
 *
 * A container tracks what it holds in `system.content` (uuids/ids of items that
 * still live on the actor). Selling an item straight out of a bag would leave
 * that reference pointing at nothing, so anything that removes an item from an
 * actor has to sweep the bags too. The sell UI already keeps packed goods off
 * the shelf; this is the backstop for a stale `isStored` flag or a client that
 * bypassed it. */
async function pruneFromContainers(actor, item, renderOpt) {
    const patches = [];
    for (const c of (actor?.items ?? [])) {
        if (c.type !== "container") continue;
        const refs = c.system?.content ?? [];
        if (!refs.length) continue;
        const kept = refs.filter(u => u !== item.uuid && u !== item.id);
        if (kept.length !== refs.length) patches.push({ _id: c.id, "system.content": kept });
    }
    if (patches.length) await actor.updateEmbeddedDocuments("Item", patches, renderOpt);
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

    // Service listings (a night at the inn, ferry passage, training) skip
    // both the stock check AND the item transfer — buying just pays the
    // coin. Merchant stock isn't decremented (services don't run out).
    const SYSTEM_ID = "witcher-ttrpg-death-march";
    const isService = !!item.getFlag(SYSTEM_ID, "isService");

    qty = Math.max(1, Math.floor(Number(qty) || 1));
    const available = Number(item.system.quantity) || 0;
    if (!isService && available < qty) return { ok: false, message: tFormat("WITCHER.Merchant.Transactions.OnlyNAvailable", { n: available }, `Only ${available} available.`) };

    const denom = merchant.system.shopDenom || "crown";
    const price = totalPriceOf(merchant, item, qty, buyerActorId);

    const buyerCoin = coinOf(buyer, denom);
    if (buyerCoin < price) {
        return { ok: false, message: tFormat("WITCHER.Merchant.Transactions.NotEnoughCoin", { denom, price, have: buyerCoin }, `Not enough ${denom}. Need ${price}, have ${buyerCoin}.`) };
    }

    const renderOpt = { render: false };
    await buyer.update({ [`system.currency.${denom}`]: buyerCoin - price }, renderOpt);
    await merchant.update({ [`system.currency.${denom}`]: coinOf(merchant, denom) + price }, renderOpt);

    if (!isService) {
        const itemData = portableItemData(item, qty);
        await withdrawItem(item, qty, available, renderOpt);
        await depositItem(buyer, itemData, qty, renderOpt);
    }

    const verb = isService ? t("WITCHER.Merchant.Transactions.PaidFor", "Paid for") : t("WITCHER.Merchant.Transactions.Purchased", "Purchased");
    return { ok: true, message: tFormat("WITCHER.Merchant.Transactions.PurchaseResult", { verb, qty, item: item.name, price, denom }, `${verb} ${qty}× ${item.name} for ${price} ${denom}.`), finalPrice: price };
}

/**
 * GM-side: buy a whole CART in one settlement.
 *
 * Atomic by construction: every line is priced and stock-checked, and the grand
 * total is measured against the buyer's purse, BEFORE a single document is
 * touched. Looping processPurchase() per line would deduct coin as it went and
 * could strand the buyer half-way through a cart with no way to roll back.
 *
 * Lines arrive from an untrusted client, so duplicate itemIds are folded
 * together first — otherwise two lines of the same item would each pass their
 * own `available` check while together exceeding stock.
 *
 * @param {object}   args
 * @param {string}   args.merchantId
 * @param {Array<{itemId: string, qty: number}>} args.lines
 * @param {string}   args.buyerActorId
 * @returns {Promise<{ok: boolean, message: string, finalPrice?: number}>}
 */
export async function processCartPurchase({ merchantId, lines, buyerActorId }) {
    const merchant = game.actors.get(merchantId);
    if (!merchant) return { ok: false, message: t("WITCHER.Merchant.Transactions.MerchantNotFound", "Merchant not found.") };
    const buyer = game.actors.get(buyerActorId);
    if (!buyer) return { ok: false, message: t("WITCHER.Merchant.Transactions.BuyerNotFound", "Buyer character not found.") };
    if (!Array.isArray(lines) || !lines.length) {
        return { ok: false, message: t("WITCHER.Merchant.CartEmpty", "Your cart is empty.") };
    }

    // Fold duplicate itemIds so each item is validated once, against its real total.
    const merged = new Map();
    for (const line of lines) {
        const id = String(line?.itemId ?? "");
        if (!id) continue;
        const qty = Math.max(1, Math.floor(Number(line?.qty) || 1));
        merged.set(id, (merged.get(id) ?? 0) + qty);
    }
    if (!merged.size) return { ok: false, message: t("WITCHER.Merchant.CartEmpty", "Your cart is empty.") };

    const denom = merchant.system.shopDenom || "crown";

    /* ── Phase 1: validate everything, mutate nothing ─────────────────────── */
    const plan = [];
    let total = 0;
    for (const [itemId, qty] of merged) {
        const item = merchant.items.get(itemId);
        if (!item) {
            return { ok: false, message: t("WITCHER.Merchant.CartItemGone", "One of the items in your cart is no longer in stock. Nothing was bought.") };
        }
        const isService = !!item.getFlag(MODULE_ID, "isService");
        const available = Number(item.system.quantity) || 0;
        if (!isService && available < qty) {
            return { ok: false, message: tFormat("WITCHER.Merchant.CartOnlyNAvailable", { n: available, item: item.name }, `Only ${available} of ${item.name} available. Nothing was bought.`) };
        }
        const price = totalPriceOf(merchant, item, qty, buyerActorId);
        total += price;
        plan.push({ item, qty, available, isService, price });
    }

    const buyerCoin = coinOf(buyer, denom);
    if (buyerCoin < total) {
        return { ok: false, message: tFormat("WITCHER.Merchant.Transactions.NotEnoughCoin", { denom, price: total, have: buyerCoin }, `Not enough ${denom}. Need ${total}, have ${buyerCoin}.`) };
    }

    /* ── Phase 2: commit ──────────────────────────────────────────────────── */
    const renderOpt = { render: false };
    await buyer.update({ [`system.currency.${denom}`]: buyerCoin - total }, renderOpt);
    await merchant.update({ [`system.currency.${denom}`]: coinOf(merchant, denom) + total }, renderOpt);

    for (const p of plan) {
        // Services are paid for but never transfer stock (see processPurchase).
        if (p.isService) continue;
        const itemData = portableItemData(p.item, p.qty);
        await withdrawItem(p.item, p.qty, p.available, renderOpt);
        await depositItem(buyer, itemData, p.qty, renderOpt);
    }

    const units = plan.reduce((n, p) => n + p.qty, 0);
    return {
        ok: true,
        finalPrice: total,
        message: tFormat("WITCHER.Merchant.CartPurchaseResult",
            { units, lines: plan.length, price: total, denom },
            `Purchased ${units} item(s) across ${plan.length} line(s) for ${total} ${denom}.`)
    };
}

/**
 * GM-side: settle an agreed BUNDLE sale — every line the seller put in their
 * cart, for one combined price.
 *
 * Atomic for the same reason processCartPurchase is: the haggle produced a
 * single number for the whole lot, so a partial transfer would be a different
 * deal than the one both sides agreed to. Everything is validated — lines still
 * present, quantities still held, merchant reserve sufficient — before any
 * document is touched.
 *
 * `price` is the TOTAL for the bundle, not a per-unit rate: that is what was
 * negotiated, and re-deriving per-unit rates would reintroduce rounding drift
 * the players never agreed to.
 *
 * @param {object} args
 * @param {string} args.sellerActorId
 * @param {string} args.merchantId
 * @param {Array<{itemId: string, qty: number}>} args.lines
 * @param {number} args.price   combined price for the whole bundle
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export async function finalizeBundleSale({ sellerActorId, merchantId, lines, price }) {
    const seller = game.actors.get(sellerActorId);
    const merchant = game.actors.get(merchantId);
    if (!seller || !merchant) return { ok: false, message: t("WITCHER.Merchant.Transactions.SellerOrMerchantNotFound", "Seller or merchant not found.") };
    if (!Array.isArray(lines) || !lines.length) return { ok: false, message: t("WITCHER.Merchant.CartEmpty", "Your cart is empty.") };

    // Fold duplicate itemIds so each line is validated once against its real
    // total — the payload came off a client and can't be trusted to be unique.
    const merged = new Map();
    for (const line of lines) {
        const id = String(line?.itemId ?? "");
        if (!id) continue;
        merged.set(id, (merged.get(id) ?? 0) + Math.max(1, Math.floor(Number(line?.qty) || 1)));
    }
    if (!merged.size) return { ok: false, message: t("WITCHER.Merchant.CartEmpty", "Your cart is empty.") };

    const denom = merchant.system.shopDenom || "crown";
    const total = Math.max(0, Math.floor(Number(price) || 0));

    /* ── Phase 1: validate, mutate nothing ────────────────────────────────── */
    const plan = [];
    for (const [itemId, qty] of merged) {
        const item = seller.items.get(itemId);
        if (!item) return { ok: false, message: t("WITCHER.Merchant.SellLineGone", "One of the offered items is no longer in your pack. Nothing was sold.") };
        const held = Number(item.system.quantity) || 0;
        if (held < qty) {
            return { ok: false, message: tFormat("WITCHER.Merchant.SellOnlyNHeld", { n: held, item: item.name }, `You only hold ${held}× ${item.name}. Nothing was sold.`) };
        }
        plan.push({ item, qty, held });
    }

    const reserve = coinOf(merchant, denom);
    if (reserve < total) {
        return { ok: false, message: tFormat("WITCHER.Merchant.Transactions.MerchantCantAfford", { denom, price: total, have: reserve }, `${merchant.name} only has ${reserve} ${denom}.`) };
    }

    /* ── Phase 2: commit ──────────────────────────────────────────────────── */
    const renderOpt = { render: false };
    await merchant.update({ [`system.currency.${denom}`]: reserve - total }, renderOpt);
    await seller.update({ [`system.currency.${denom}`]: coinOf(seller, denom) + total }, renderOpt);

    for (const p of plan) {
        const itemData = portableItemData(p.item, p.qty);
        // Sweep the bags BEFORE the row can be deleted — once it's gone we can
        // no longer match its uuid against a container's content array.
        if (p.held <= p.qty) await pruneFromContainers(seller, p.item, renderOpt);
        await withdrawItem(p.item, p.qty, p.held, renderOpt);
        await depositItem(merchant, itemData, p.qty, renderOpt);
    }

    const units = plan.reduce((n, p) => n + p.qty, 0);
    const message = tFormat("WITCHER.Merchant.SellBundleResult",
        { units, lines: plan.length, price: total, denom },
        `Sold ${units} item(s) across ${plan.length} line(s) for ${total} ${denom}.`);

    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: seller }),
        content: `<em>${tFormat("WITCHER.Merchant.Chat.SoldBundle",
            { units, merchant: merchant.name, total, denom },
            `sold ${units} item(s) to ${merchant.name} for ${total} ${denom}.`)}</em>`
    });

    return { ok: true, message };
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
    if (!seller || !merchant) return { ok: false, message: t("WITCHER.Merchant.Transactions.SellerOrMerchantNotFound", "Seller or merchant not found.") };

    const item = seller.items.get(itemId);
    if (!item) return { ok: false, message: t("WITCHER.Merchant.Transactions.ItemNoLonger", "Item is no longer in seller inventory.") };

    qty = Math.max(1, Math.floor(Number(qty) || 1));
    const available = Number(item.system.quantity) || 0;
    if (available < qty) return { ok: false, message: tFormat("WITCHER.Merchant.Transactions.SellerOnlyHasN", { n: available }, `Seller only has ${available} of that item.`) };

    const denom = merchant.system.shopDenom || "crown";
    const total = Math.max(0, Math.round((Number(price) || 0) * qty));
    const reserve = coinOf(merchant, denom);
    if (total > reserve) return { ok: false, message: tFormat("WITCHER.Merchant.Transactions.MerchantNotEnoughCoin", { reserve, denom }, `Merchant doesn't have enough coin (${reserve} ${denom}).`) };

    const itemData = portableItemData(item, qty);
    const itemName = item.name;
    const renderOpt = { render: false };

    await withdrawItem(item, qty, available, renderOpt);
    await merchant.update({ [`system.currency.${denom}`]: reserve - total }, renderOpt);
    await seller.update({ [`system.currency.${denom}`]: coinOf(seller, denom) + total }, renderOpt);
    await depositItem(merchant, itemData, qty, renderOpt);

    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: seller }),
        content: tFormat("WITCHER.Merchant.Chat.Sold", { qty, item: itemName, merchant: merchant.name, total, denom }, "<em>sold {qty}× {item} to {merchant} for {total} {denom}.</em>")
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

/** The buyer's daily appraisal allowance at a merchant = their (prepared) INT.
 *  6 INT → 6 Business checks per in-game day at that merchant, success OR fail. */
function appraisalCap(buyerActor) {
    return Math.max(0, Math.trunc(Number(foundry.utils.getProperty(buyerActor, "system.stats.int.value")) || 0));
}

/** Checks this buyer has already made at this merchant TODAY (0 on a new day). */
function appraisalChecksUsed(buyerActor, merchantId) {
    const rec = (buyerActor?.getFlag(MODULE_ID, "appraisalChecks") || {})[merchantId];
    return (rec && Number(rec.day) === currentInGameDay()) ? Math.max(0, Number(rec.count) || 0) : 0;
}

/** Appraisal checks this buyer may still make at this merchant today (≥ 0). */
export function appraisalChecksRemaining(buyerActor, merchantId) {
    if (!buyerActor) return 0;
    return Math.max(0, appraisalCap(buyerActor) - appraisalChecksUsed(buyerActor, merchantId));
}

/**
 * True if this buyer has no appraisal checks left at this merchant today — they
 * get INT-many checks per in-game day (success or failure both count).
 */
export function isAppraisalLocked(buyerActor, merchantId) {
    if (!buyerActor) return false;
    return appraisalChecksRemaining(buyerActor, merchantId) <= 0;
}

/** Record one appraisal check (success or fail) against today's per-merchant
 *  count, resetting the count when the in-game day has rolled over. */
async function recordAppraisalCheck(buyerActor, merchantId) {
    if (!buyerActor) return;
    const all = foundry.utils.duplicate(buyerActor.getFlag(MODULE_ID, "appraisalChecks") || {});
    all[merchantId] = { day: currentInGameDay(), count: appraisalChecksUsed(buyerActor, merchantId) + 1 };
    try {
        await buyerActor.setFlag(MODULE_ID, "appraisalChecks", all);
    } catch (err) {
        console.warn(`[${MODULE_ID}] failed to persist appraisal check:`, err);
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

    // Services have no fair-market baseline to compare against — reject
    // appraisal so a client that bypassed the hidden UI button can't
    // burn a Business check on nothing. The buy sheet also hides the
    // reveal button for service items.
    const SYSTEM_ID = "witcher-ttrpg-death-march";
    if (item.getFlag(SYSTEM_ID, "isService")) {
        return { ok: false, message: "Services don't have a fair-market price to appraise." };
    }

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

    // Every attempt — success or failure — burns one of the buyer's INT-many
    // daily appraisal checks at this merchant.
    await recordAppraisalCheck(buyer, merchantId);

    const success = result.total >= dc;
    const basePrice = Number(item.system.cost) || 0;
    if (success) await setRevealedPriceFor(buyer, merchantId, item.name, basePrice);

    return { ok: true, success, roll: result.total, dc, basePrice, checksLeft: appraisalChecksRemaining(buyer, merchantId) };
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
