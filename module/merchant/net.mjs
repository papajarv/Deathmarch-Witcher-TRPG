/**
 * Merchant transport — GM-authoritative shop traffic.
 *
 * Unlike the Farkle peer relay, every mutation here funnels through the active
 * GM (the only client allowed to move coin/items between two actors). Players
 * emit requests; the GM handles them and replies to the requesting user.
 *
 * Envelope: { type: "merchant", from, to, sub, payload }
 *   sub (player → GM):   "buy" | "cartBuy" | "priceReveal" | "offer" | "accept" | "refuse"
 *   sub (GM → player):   "buyResult" | "priceResult" | "counter" | "concluded"
 *   `to` is a user id, or null to address the active GM. Foundry does not echo
 *   emits to the sender, so the GM path is taken inline when game.user is GM.
 *
 * Selling is multi-round: the player offers a price, the GM accepts / refuses /
 * counters, and counters bounce until one side commits. `history` is an
 * append-only bargaining record shown in both dialogs.
 *
 * A sell offer is a BUNDLE: the whole sell cart goes over as `lines`, and the
 * haggled `price` is the combined total for the lot (not a per-unit rate). One
 * negotiation, one number, one atomic settlement — see finalizeBundleSale.
 *
 * Ported from witcher-merchant-system buy-sheet.js negotiation subsystem.
 */

import { processPurchase, processCartPurchase, finalizeSale, finalizeBundleSale, rollPriceReveal } from "./transactions.mjs";
import { buybackUnitPrice, acceptsBuyCategory } from "./pricing.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const CHANNEL = `system.${SYSTEM_ID}`;
const ENVELOPE = "merchant";

const DialogV2 = foundry.applications.api.DialogV2;

/** negotiationId → { role, sellerUserId, merchantId, ...lastState }. */
const negotiations = new Map();

/** Open buy sheets to nudge after a GM-side mutation, keyed by appId. */
const openSheets = new Map();
export function registerBuySheet(app) { openSheets.set(app.id, app); }
export function unregisterBuySheet(app) { openSheets.delete(app.id); }
function refreshBuySheets(merchantId) {
    for (const app of openSheets.values()) {
        if (!merchantId || app.merchant?.id === merchantId) app.render(false);
    }
}

/** Empty the basket on every open shop window for a merchant. Called when the
 *  GM confirms a cart purchase settled (the player client can't know on its own,
 *  since the transaction runs entirely on the GM). */
function clearCartsFor(merchantId) {
    for (const app of openSheets.values()) {
        if (merchantId && app.merchant?.id !== merchantId) continue;
        app.clearCart?.();
    }
}

function send({ to = null, sub, payload = {} }) {
    game.socket.emit(CHANNEL, { type: ENVELOPE, from: game.user.id, to, sub, payload });
}

/** Negotiation subs the GM client handles; the rest are player-facing. */
const GM_SUBS = new Set(["offer", "accept", "refuse"]);

/** Route a negotiation message locally. */
function routeLocal(sub, payload) {
    const data = { type: ENVELOPE, from: game.user.id, sub, payload };
    if (GM_SUBS.has(sub)) onGMMessage(data);
    else onPlayerMessage(data);
}

/**
 * Send a negotiation message, but short-circuit to a local handler when the
 * recipient is this very client. Foundry never echoes a client's own emit, so
 * a GM trading as their own character (both seller and merchant on one client)
 * would otherwise talk into the void.
 */
function dispatch({ to = null, sub, payload = {} }) {
    const isSelf = to === game.user.id || (to == null && game.user.isActiveGM);
    if (isSelf) return routeLocal(sub, payload);
    send({ to, sub, payload });
}

function activeGMOnline() {
    return game.users.some(u => u.isGM && u.active);
}

/* -------------------------------------------------------------------------- */
/* Reachability acks                                                          */
/* -------------------------------------------------------------------------- */
//
// Foundry's socket can silently drop an emit when GM and player connected via
// different host strings (localhost vs LAN/web). The player would then see
// "offer sent" / nothing happens with no error. So every player→GM request
// arms a short timer; the GM's reply (or, for negotiation, an immediate ack
// before the GM opens a dialog) clears it. If nothing lands in time, we warn
// the player to try again instead of failing silently.

const ACK_TIMEOUT_MS = 10_000;
const pendingAcks = new Map(); // ackId → timeout handle

function armAck(ackId) {
    clearAck(ackId);
    pendingAcks.set(ackId, setTimeout(() => {
        pendingAcks.delete(ackId);
        ui.notifications.warn(localize("NoGMReply"));
    }, ACK_TIMEOUT_MS));
}

function clearAck(ackId) {
    const h = pendingAcks.get(ackId);
    if (h == null) return;
    clearTimeout(h);
    pendingAcks.delete(ackId);
}

export function registerMerchantNet() {
    game.socket.on(CHANNEL, (data) => {
        if (data?.type !== ENVELOPE) return;
        // Player → GM messages are addressed to whichever client is the active GM.
        if (data.to == null) {
            if (game.user.isActiveGM) onGMMessage(data);
            return;
        }
        if (data.to === game.user.id) onPlayerMessage(data);
    });
}

/* -------------------------------------------------------------------------- */
/* Player-facing senders                                                      */
/* -------------------------------------------------------------------------- */

/** Buy `qty` of an item. Resolves GM-side directly, else proxies to the GM. */
export async function requestBuy({ merchantId, itemId, qty, buyerActorId }) {
    if (game.user.isActiveGM) {
        const result = await processPurchase({ merchantId, itemId, qty, buyerActorId });
        report(result);
        refreshBuySheets(merchantId);
        return;
    }
    if (!activeGMOnline()) return ui.notifications.warn(localize("NoGM"));
    const requestId = foundry.utils.randomID();
    armAck(requestId);
    send({ sub: "buy", payload: { merchantId, itemId, qty, buyerActorId, buyerUserId: game.user.id, requestId } });
}

/** Buy an entire cart in one settlement. Same GM-inline / socket-proxy shape as
 *  requestBuy, but the GM side settles all lines atomically (see
 *  processCartPurchase) so a cart can never be half-bought. */
export async function requestCartBuy({ merchantId, lines, buyerActorId }) {
    if (game.user.isActiveGM) {
        const result = await processCartPurchase({ merchantId, lines, buyerActorId });
        report(result);
        refreshBuySheets(merchantId);
        return result;
    }
    if (!activeGMOnline()) {
        ui.notifications.warn(localize("NoGM"));
        return { ok: false, message: localize("NoGM") };
    }
    const requestId = foundry.utils.randomID();
    armAck(requestId);
    send({ sub: "cartBuy", payload: { merchantId, lines, buyerActorId, buyerUserId: game.user.id, requestId } });
    // Fire-and-forget: the GM's "buyResult" reply clears the ack and reports.
    return { ok: true, pending: true };
}

/** Roll the buyer's Business check to reveal an item's fair price. */
export async function requestPriceReveal({ merchantId, itemId, buyerActorId }) {
    if (game.user.isActiveGM) {
        const r = await rollPriceReveal({ merchantId, itemId, buyerActorId });
        if (r?.locked) ui.notifications.warn(r.message);
        refreshBuySheets(merchantId);
        return;
    }
    if (!activeGMOnline()) return ui.notifications.warn(localize("NoGM"));
    const requestId = foundry.utils.randomID();
    armAck(requestId);
    send({ sub: "priceReveal", payload: { merchantId, itemId, buyerActorId, requestId } });
}

/**
 * Open the initial sell offer dialog and send it to the GM. The merchant
 * replies with a counter (→ player counter dialog) or a conclusion.
 */
export async function startSellNegotiation({ merchantId, sellerActorId, item }) {
    if (!activeGMOnline()) return ui.notifications.warn(localize("NoGM"));

    const merchant = game.actors.get(merchantId);
    const denom = merchant?.system?.shopDenom || "crown";
    const maxQty = Number(item.system.quantity) || 1;
    // Refuse categories this merchant won't buy (mirrors the buy-sheet gate; a
    // player client that bypassed the disabled button still gets stopped here).
    if (!acceptsBuyCategory(merchant, item.type)) {
        return ui.notifications.warn(game.i18n.format("WITCHER.Merchant.NoStockType", { type: item.type }));
    }
    // Seed with the merchant's configured buyback rate rather than a hardcoded
    // 50%. Converted to the shop denom and adjusted for the seller's race /
    // profession standing. GMs can still negotiate up/down in the sell dialog.
    const seller = game.actors.get(sellerActorId);
    const suggested = buybackUnitPrice(merchant, item, seller);

    const result = await DialogV2.prompt({
        window: { title: localize("SellTitle") + `: ${item.name}` },
        content: `
            <form class="wdm-merchant-sell">
                <p>${game.i18n.format("WITCHER.Merchant.SellIntro", { item: item.name, merchant: merchant?.name ?? "" })}</p>
                <div class="wdm-form-row">
                    <label>${localize("Quantity")} (max ${maxQty})</label>
                    <input type="number" name="qty" value="1" min="1" max="${maxQty}" />
                </div>
                <div class="wdm-form-row">
                    <label>${localize("AskingPrice")}</label>
                    <input type="number" name="price" value="${suggested}" min="0" />
                    <span class="wdm-form-suffix">${denom}</span>
                </div>
                <p class="wdm-form-hint">${game.i18n.format("WITCHER.Merchant.SellHint", { price: suggested, denom })}</p>
            </form>`,
        ok: {
            label: localize("SendOffer"),
            callback: (event, button) => ({
                qty: clamp(button.form.elements.qty.value, 1, maxQty),
                price: Math.max(0, Math.floor(Number(button.form.elements.price.value) || 0))
            })
        },
        modal: true, rejectClose: false
    });
    if (!result) return;

    const negotiationId = foundry.utils.randomID();
    const history = [{ from: "player", price: result.price, round: 1 }];
    negotiations.set(negotiationId, {
        role: "player", merchantId, sellerActorId, itemId: item.id,
        qty: result.qty, denom, round: 1
    });

    // A player offer crosses the socket to the GM, who may sit on it inside a
    // dialog — so we can't wait on the real reply. Arm a reachability timer
    // that the GM's immediate "ack" clears; a GM self-sell routes locally and
    // never arms it.
    if (!game.user.isActiveGM) armAck(negotiationId);
    dispatch({
        sub: "offer",
        payload: {
            negotiationId, from: "player", sellerUserId: game.user.id,
            merchantId, sellerActorId,
            itemId: item.id, itemName: item.name, itemImg: item.img,
            qty: result.qty, price: result.price, denom, history, round: 1
        }
    });
    ui.notifications.info(game.i18n.format("WITCHER.Merchant.OfferSent",
        { qty: result.qty, item: item.name, price: result.price, denom }));
}

/**
 * Open the bundle sell-offer dialog and send it to the GM. `lines` is the
 * seller's whole cart; the asking price is ONE number for the lot.
 */
export async function startBundleSellNegotiation({ merchantId, sellerActorId, lines }) {
    if (!activeGMOnline()) return ui.notifications.warn(localize("NoGM"));

    const merchant = game.actors.get(merchantId);
    const seller = game.actors.get(sellerActorId);
    if (!merchant || !seller) return ui.notifications.error(localize("NegAborted"));
    const denom = merchant?.system?.shopDenom || "crown";

    // Resolve + validate every line before we bother the GM: a category this
    // merchant won't touch, or stock the seller no longer holds, kills the offer
    // here rather than half-way through a haggle.
    const resolved = [];
    let suggested = 0;
    for (const line of lines ?? []) {
        const item = seller.items.get(line.itemId);
        if (!item) continue;
        if (!acceptsBuyCategory(merchant, item.type)) {
            return ui.notifications.warn(game.i18n.format("WITCHER.Merchant.NoStockType", { type: item.type }));
        }
        const qty = Math.max(1, Math.min(Number(line.qty) || 1, Number(item.system.quantity) || 1));
        const unit = buybackUnitPrice(merchant, item, seller);
        suggested += unit * qty;
        resolved.push({ itemId: item.id, name: item.name, img: item.img, qty, unit });
    }
    if (!resolved.length) return ui.notifications.warn(localize("SellCartEmpty"));

    const units = resolved.reduce((n, l) => n + l.qty, 0);
    const rows = resolved.map(l =>
        `<li><span class="wdm-neg-item">${l.qty}× ${escapeText(l.name)}</span>
             <span class="wdm-neg-unit">${l.unit * l.qty} ${escapeText(denom)}</span></li>`).join("");

    const result = await DialogV2.prompt({
        window: { title: localize("SellTitle") },
        content: `
            <form class="wdm-merchant-sell">
                <p>${game.i18n.format("WITCHER.Merchant.SellBundleIntro", { units, merchant: merchant.name })}</p>
                <ul class="wdm-neg-lines">${rows}</ul>
                <div class="wdm-form-row">
                    <label>${localize("AskingPrice")}</label>
                    <input type="number" name="price" value="${suggested}" min="0" />
                    <span class="wdm-form-suffix">${denom}</span>
                </div>
                <p class="wdm-form-hint">${game.i18n.format("WITCHER.Merchant.SellBundleHint", { price: suggested, denom })}</p>
            </form>`,
        ok: {
            label: localize("SendOffer"),
            callback: (event, button) => Math.max(0, Math.floor(Number(button.form.elements.price.value) || 0))
        },
        modal: true, rejectClose: false
    }).catch(() => null);
    if (result == null) return;

    const negotiationId = foundry.utils.randomID();
    const history = [{ from: "player", price: result, round: 1 }];
    negotiations.set(negotiationId, {
        role: "player", merchantId, sellerActorId, bundle: true,
        lines: resolved, qty: units, denom, round: 1
    });

    if (!game.user.isActiveGM) armAck(negotiationId);
    dispatch({
        sub: "offer",
        payload: {
            negotiationId, from: "player", sellerUserId: game.user.id,
            merchantId, sellerActorId,
            bundle: true, lines: resolved, qty: units,
            price: result, denom, history, round: 1
        }
    });
    ui.notifications.info(game.i18n.format("WITCHER.Merchant.BundleOfferSent",
        { units, price: result, denom }));
    return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* GM-side routing                                                            */
/* -------------------------------------------------------------------------- */

async function onGMMessage(data) {
    const { sub, payload, from } = data;
    switch (sub) {
        case "buy": {
            const result = await processPurchase(payload);
            send({ to: payload.buyerUserId ?? from, sub: "buyResult", payload: { ...result, requestId: payload.requestId } });
            refreshBuySheets(payload.merchantId);
            return;
        }
        case "cartBuy": {
            const result = await processCartPurchase(payload);
            // `cart` + `merchantId` let the buyer's client empty the right basket
            // once we confirm the settlement actually went through.
            send({ to: payload.buyerUserId ?? from, sub: "buyResult",
                   payload: { ...result, cart: true, merchantId: payload.merchantId, requestId: payload.requestId } });
            refreshBuySheets(payload.merchantId);
            return;
        }
        case "priceReveal": {
            const r = await rollPriceReveal(payload);
            send({ to: from, sub: "priceResult", payload: { merchantId: payload.merchantId, locked: r?.locked, message: r?.message, requestId: payload.requestId } });
            return;
        }
        case "offer":    return gmShowNegotiation(payload);
        case "accept":   return gmHandleAccept(payload);
        case "refuse":   return gmHandleRefuse(payload);
        default: console.warn(`${SYSTEM_ID} | merchant: unknown GM sub`, sub);
    }
}

async function gmShowNegotiation(payload) {
    // Confirm the offer reached us before the GM disappears into the dialog,
    // so the seller's reachability timer is cleared even if haggling is slow.
    dispatch({ to: payload.sellerUserId, sub: "ack", payload: { negotiationId: payload.negotiationId } });

    const merchant = game.actors.get(payload.merchantId);
    const seller = game.actors.get(payload.sellerActorId);
    if (!merchant || !seller) return ui.notifications.error(localize("NegAborted"));

    negotiations.set(payload.negotiationId, {
        role: "gm", sellerUserId: payload.sellerUserId, merchantId: payload.merchantId,
        sellerActorId: payload.sellerActorId, itemId: payload.itemId,
        qty: payload.qty, denom: payload.denom, round: payload.round
    });

    // A bundle's `price` IS the total for the lot; a legacy single-item offer
    // prices per unit. negTotal() is the one place that distinction lives.
    const total = negTotal(payload);
    const reserve = Number(merchant.system.currency?.[payload.denom]) || 0;
    const warn = total > reserve
        ? `<p class="wdm-neg-warn"><i class="fas fa-exclamation-triangle"></i> ${game.i18n.format("WITCHER.Merchant.ReserveLow", { reserve, denom: payload.denom })}</p>`
        : "";

    const content = `
        <div class="wdm-neg">
            ${negHeader(payload, `${seller.name} → ${merchant.name}`)}
            <p>${payload.bundle
                ? game.i18n.format("WITCHER.Merchant.OfferLineBundle",
                    { seller: seller.name, units: payload.qty, total, denom: payload.denom })
                : game.i18n.format("WITCHER.Merchant.OfferLine",
                    { seller: seller.name, qty: payload.qty, price: payload.price, denom: payload.denom, total })}</p>
            ${bundleLines(payload)}
            ${warn}
            ${historyBlock(payload.history)}
        </div>`;

    const choice = await DialogV2.wait({
        window: { title: localize("OfferReceived") },
        content,
        buttons: [
            { action: "accept",  label: localize("Accept"),  icon: "fas fa-check", default: true },
            { action: "counter", label: localize("Counter"), icon: "fas fa-balance-scale" },
            { action: "refuse",  label: localize("Refuse"),  icon: "fas fa-times" }
        ],
        rejectClose: false
    }).catch(() => null);

    if (!choice || choice === "refuse") return gmConclude(payload, "refused",
        game.i18n.format("WITCHER.Merchant.Declined", { merchant: merchant.name }), merchant, seller);

    if (choice === "accept") {
        const result = await settleOffer(payload);
        negotiations.delete(payload.negotiationId);
        dispatch({ to: payload.sellerUserId, sub: "concluded",
            payload: { negotiationId: payload.negotiationId, merchantId: payload.merchantId, outcome: result.ok ? "accepted" : "failed", message: result.message } });
        refreshBuySheets(payload.merchantId);
        return;
    }

    // Counter
    const newPrice = await promptPrice(localize("CounterTitle"), payload.price, payload.denom);
    if (newPrice == null) return gmConclude(payload, "refused",
        game.i18n.format("WITCHER.Merchant.NoFurther", { merchant: merchant.name }), merchant, seller);

    const round = payload.round + 1;
    const history = [...payload.history, { from: "gm", price: newPrice, round }];
    dispatch({
        to: payload.sellerUserId, sub: "counter",
        payload: { ...payload, from: "gm", price: newPrice, history, round }
    });
}

async function gmHandleAccept(payload) {
    // The negotiation entry is gone if the GM client reloaded mid-bargain;
    // the half-finished deal is stale, so decline rather than honor it blind.
    if (!negotiations.has(payload.negotiationId)) {
        return dispatch({ to: payload.sellerUserId, sub: "concluded",
            payload: { negotiationId: payload.negotiationId, merchantId: payload.merchantId, outcome: "failed",
                       message: game.i18n.localize("WITCHER.Merchant.NegExpired") } });
    }
    const result = await settleOffer(payload);
    negotiations.delete(payload.negotiationId);
    dispatch({ to: payload.sellerUserId, sub: "concluded",
        payload: { negotiationId: payload.negotiationId, merchantId: payload.merchantId, outcome: result.ok ? "accepted" : "failed", message: result.message } });
    refreshBuySheets(payload.merchantId);
}

function gmHandleRefuse(payload) {
    negotiations.delete(payload.negotiationId);
    const merchant = game.actors.get(payload.merchantId);
    if (merchant) ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: merchant }),
        content: `<em>${game.i18n.localize("WITCHER.Merchant.WalkedAway")}</em>`
    });
}

async function gmConclude(payload, outcome, message, merchant, seller) {
    negotiations.delete(payload.negotiationId);
    dispatch({ to: payload.sellerUserId, sub: "concluded", payload: { negotiationId: payload.negotiationId, merchantId: payload.merchantId, outcome, message } });
    if (merchant && seller) await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: merchant }),
        content: `<em>${game.i18n.format("WITCHER.Merchant.RefusesOffer", { seller: seller.name })}</em>`
    });
}

/* -------------------------------------------------------------------------- */
/* Player-side routing                                                        */
/* -------------------------------------------------------------------------- */

function onPlayerMessage(data) {
    const { sub, payload } = data;
    switch (sub) {
        case "ack":         clearAck(payload.negotiationId); return;
        case "buyResult":
            clearAck(payload.requestId);
            report(payload);
            // A cart settles all-or-nothing GM-side; empty the basket only once
            // the GM confirms it went through. A rejected cart stays put so the
            // player can drop a line and try again.
            if (payload.cart && payload.ok) clearCartsFor(payload.merchantId);
            refreshBuySheets();
            return;
        case "priceResult":
            clearAck(payload.requestId);
            if (payload.locked && payload.message) ui.notifications.warn(payload.message);
            refreshBuySheets(payload.merchantId);
            return;
        case "counter":     clearAck(payload.negotiationId); return playerShowCounter(payload);
        case "concluded":   clearAck(payload.negotiationId); return playerConcluded(payload);
        default: console.warn(`${SYSTEM_ID} | merchant: unknown player sub`, sub);
    }
}

async function playerShowCounter(payload) {
    const merchant = game.actors.get(payload.merchantId);
    const total = negTotal(payload);
    const content = `
        <div class="wdm-neg">
            ${negHeader(payload, game.i18n.format("WITCHER.Merchant.NegotiatingWith", { merchant: merchant?.name ?? "" }))}
            <p>${payload.bundle
                ? game.i18n.format("WITCHER.Merchant.CounterLineBundle",
                    { merchant: merchant?.name ?? "", total, denom: payload.denom })
                : game.i18n.format("WITCHER.Merchant.CounterLine",
                    { merchant: merchant?.name ?? "", price: payload.price, denom: payload.denom, total })}</p>
            ${bundleLines(payload)}
            ${historyBlock(payload.history)}
        </div>`;

    const choice = await DialogV2.wait({
        window: { title: localize("MerchantCounter") },
        content,
        buttons: [
            { action: "accept",  label: localize("Accept"),  icon: "fas fa-check", default: true },
            { action: "counter", label: localize("Counter"), icon: "fas fa-balance-scale" },
            { action: "refuse",  label: localize("Refuse"),  icon: "fas fa-times" }
        ],
        rejectClose: false
    }).catch(() => null);

    if (!choice || choice === "refuse") {
        dispatch({ sub: "refuse", payload: { ...payload } });
        negotiations.delete(payload.negotiationId);
        return ui.notifications.info(localize("WalkedAway"));
    }

    if (choice === "accept") {
        dispatch({ sub: "accept", payload: { ...payload } });
        return ui.notifications.info(localize("AcceptedWaiting"));
    }

    const newPrice = await promptPrice(
        game.i18n.format("WITCHER.Merchant.CounterMerchant", { merchant: merchant?.name ?? "" }),
        payload.price, payload.denom);
    if (newPrice == null) {
        dispatch({ sub: "refuse", payload: { ...payload } });
        negotiations.delete(payload.negotiationId);
        return;
    }

    const round = payload.round + 1;
    const history = [...payload.history, { from: "player", price: newPrice, round }];
    dispatch({ sub: "offer", payload: { ...payload, from: "player", price: newPrice, history, round } });
}

function playerConcluded(payload) {
    negotiations.delete(payload.negotiationId);
    // The goods actually left the pack — drop them from the sell cart. A refused
    // or failed offer keeps the cart intact so the player can re-price and retry.
    if (payload.outcome === "accepted") clearSellCartsFor(payload.merchantId);
    if (payload.message) {
        if (payload.outcome === "accepted") ui.notifications.info(payload.message);
        else ui.notifications.warn(payload.message);
    }
    refreshBuySheets();
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

/** What the offer on the table is worth in total. A bundle negotiates ONE
 *  number for the whole lot; a single-item offer negotiates a per-unit rate. */
function negTotal(payload) {
    return payload.bundle ? payload.price : payload.price * payload.qty;
}

/** Route an accepted offer to the right settlement. Bundles move every line for
 *  the agreed combined price; single-item offers keep the original per-unit path. */
function settleOffer(payload) {
    return payload.bundle
        ? finalizeBundleSale({
            sellerActorId: payload.sellerActorId,
            merchantId:    payload.merchantId,
            lines:         payload.lines,
            price:         payload.price
        })
        : finalizeSale(payload);
}

/** Empty the sell cart on every open shop window for a merchant, once the GM
 *  confirms the bundle actually changed hands. */
function clearSellCartsFor(merchantId) {
    for (const app of openSheets.values()) {
        if (merchantId && app.merchant?.id !== merchantId) continue;
        app.clearSellCart?.();
    }
}

function report(result) {
    if (!result) return;
    if (result.ok) ui.notifications.info(result.message);
    else ui.notifications.warn(result.message);
}

function clamp(raw, lo, hi) {
    return Math.max(lo, Math.min(hi, Math.floor(Number(raw) || lo)));
}

function localize(key) {
    return game.i18n.localize(`WITCHER.Merchant.${key}`);
}

function negHeader(payload, meta) {
    // A bundle has no single item to headline — it gets a count and the goods
    // are itemised below. Rendering payload.itemName here printed the literal
    // "undefined" over a broken image for every bundle offer.
    const title = payload.bundle
        ? game.i18n.format("WITCHER.Merchant.NegBundleTitle", { units: payload.qty })
        : escapeText(payload.itemName);
    const img = payload.bundle
        ? "icons/svg/item-bag.svg"
        : (payload.itemImg || "icons/svg/item-bag.svg");
    return `
        <div class="wdm-neg-header">
            <img src="${escapeText(img)}" />
            <div>
                <div class="wdm-neg-item">${title}</div>
                <div class="wdm-neg-meta">${meta}</div>
            </div>
        </div>`;
}

/** Itemised bundle contents for the haggle dialogs. Without this the GM was
 *  asked to accept or refuse a price for goods they couldn't see. */
function bundleLines(payload) {
    if (!payload?.bundle || !payload.lines?.length) return "";
    const rows = payload.lines.map(l =>
        `<li><span class="wdm-neg-item">${l.qty}× ${escapeText(l.name)}</span>
             <span class="wdm-neg-unit">${l.unit * l.qty} ${escapeText(payload.denom)}</span></li>`).join("");
    return `<ul class="wdm-neg-lines">${rows}</ul>`;
}

/** Escape interpolated text. foundry.utils.escapeHTML exists in v13, but the
 *  optional-call form used previously fell back to the RAW string when absent,
 *  which is the one fallback that defeats the point. */
function escapeText(str) {
    const fn = foundry.utils.escapeHTML;
    if (typeof fn === "function") return fn(String(str ?? ""));
    return String(str ?? "").replace(/[&<>"']/g, c => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
}

function historyBlock(history) {
    if (!history?.length) return "";
    const rows = history.map(h => {
        const who = h.from === "gm" ? localize("Merchant") : localize("You");
        return `<div class="wdm-neg-row"><span class="wdm-neg-from">${who}:</span> ${h.price} <span class="wdm-neg-round">(${localize("Round")} ${h.round})</span></div>`;
    }).join("");
    return `<div class="wdm-neg-history">${rows}</div>`;
}

async function promptPrice(title, value, denom) {
    return DialogV2.prompt({
        window: { title },
        content: `
            <form class="wdm-merchant-sell">
                <div class="wdm-form-row">
                    <label>${localize("PricePerUnit")}</label>
                    <input type="number" name="price" value="${value}" min="0" />
                    <span class="wdm-form-suffix">${denom}</span>
                </div>
            </form>`,
        ok: {
            label: localize("Send"),
            callback: (event, button) => Math.max(0, Math.floor(Number(button.form.elements.price.value) || 0))
        },
        modal: false, rejectClose: false
    }).catch(() => null);
}
