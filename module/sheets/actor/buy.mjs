/**
 * MerchantBuySheet — player-facing shop window.
 *
 * A standalone ApplicationV2 (NOT the merchant's document sheet — that's the
 * GM config sheet). Opened from a scene portrait card or the GM sheet's
 * "Open shop" button via `openMerchantShop(merchant, buyer)`.
 *
 * Two tabs:
 *   Buy  — the merchant's whole stock as ONE Witcher-3 style tile lattice (no
 *          type sections), using the inventory's own .wou-slot tiles so square
 *          and 2:1 tall icons render exactly as they do in your pack. Hovering
 *          a tile raises the same item card the inventory overlay uses;
 *          clicking adds to the basket;
 *          middle-clicking spends a Business check to appraise the fair price,
 *          which then rides along under the hover card.
 *          The basket is a panel down the LEFT of the same window, holding what
 *          you've picked up and the merchant's asking total; checkout settles
 *          every line atomically.
 *   Sell — the mirror image: your own pack as the same tile lattice, filtered
 *          by the inventory's category tabs, with the sell cart down the left.
 *          The offer that crosses to the GM is the WHOLE cart, haggled as one
 *          combined price and settled atomically (finalizeBundleSale).
 *
 * The window reads the merchant actor directly, so a player needs at least
 * OBSERVER permission on the merchant (the GM grants this on the shop actor).
 * All mutations route through net.mjs to the GM.
 *
 * Ported from witcher-merchant-system buy-sheet.js (MerchantBuySheet), trimmed
 * to the new system's net layer (no per-call socket request/response plumbing —
 * net.mjs owns that) and pricing helpers.
 */

import { snapshotUnitPrice, rarityOf, NON_MERCHANT_TYPES, buybackUnitPrice, acceptsBuyCategory, toShopPrice } from "../../merchant/pricing.mjs";
import { getRevealedPricesFor, isAppraisalLocked, appraisalChecksRemaining } from "../../merchant/transactions.mjs";
import { requestPriceReveal, requestCartBuy, startBundleSellNegotiation, registerBuySheet, unregisterBuySheet } from "../../merchant/net.mjs";
import { showItemHoverCard, hideItemHoverCard, isTallItem, tallCropStyleFor, fitTallIconsIn,
         INV_CATEGORIES, INV_SORTS, RARITY_ORDER, categorizeItem } from "../../chrome/chrome/inventory.js";
import { getAssignedActor, VIEWER_OVERRIDE_HOOK } from "../../chrome/lib/actor.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const SYSTEM_ID = "witcher-ttrpg-death-march";

/** Dwell time before a tile raises its item card. Matches the inventory grid so
 *  the two windows feel like one interface. */
const HOVER_DELAY_MS = 500;

/* ── Shelf sorting ─────────────────────────────────────────────────────────
 * Both shelves use the inventory's own sort vocabulary (INV_SORTS) so the shop
 * reads with the same words as the player's pack. The rows here are flat view
 * models, not Item documents, so we can't reuse the inventory's applySort —
 * that one reaches into `system.*`. `value` maps to the SHOP price (asking
 * price on the buy tab, buyback offer on the sell tab), which is what a shopper
 * actually cares about, not the item's raw system cost.
 *
 * Persisted per user (not per merchant): a player who sorts by price wants
 * every shop to open that way. */
const SORT_FLAG = "merchantSorts";
/* "type" (type-then-name) is what both shelves did before there was a control,
 * so an untouched shop opens looking exactly as it always has. */
const DEFAULT_SHELF_SORT = "type";

function shelfRarityRank(row) {
    const idx = RARITY_ORDER.indexOf(String(row?.rarity ?? "").toLowerCase());
    return idx === -1 ? RARITY_ORDER.length : idx;
}

/** Sort a shelf of view-model rows. `priceKey` names the row field holding the
 *  shop price for this tab. Pinned and Service stock keep leading the buy shelf
 *  under every mode — that ordering is the merchant's display intent, not a
 *  sort preference, so the chosen mode orders WITHIN those bands. */
function sortShelf(rows, sortKey, priceKey) {
    const byName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" });
    const within = (a, b) => {
        switch (sortKey) {
            case "qty":    return (Number(b.quantity) || 0) - (Number(a.quantity) || 0) || byName(a, b);
            case "weight": return (Number(b.weight) || 0) - (Number(a.weight) || 0) || byName(a, b);
            case "value":  return (Number(b[priceKey]) || 0) - (Number(a[priceKey]) || 0) || byName(a, b);
            case "rarity": return shelfRarityRank(a) - shelfRarityRank(b) || byName(a, b);
            case "type":   return String(a.type || "").toLowerCase()
                                  .localeCompare(String(b.type || "").toLowerCase()) || byName(a, b);
            default:       return byName(a, b);
        }
    };
    return rows.slice().sort((a, b) =>
        (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)
        || (b.isService ? 1 : 0) - (a.isService ? 1 : 0)
        || within(a, b));
}

/** Escape text destined for the hover card, which we build as a raw HTML
 *  string (item names and localized strings both reach it). */
function esc(str) {
    return String(str ?? "").replace(/[&<>"']/g, c => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
}

/** The buyer character for the current user. Routes through the shared
 *  `getAssignedActor()` so a GM using the "View As" override sees the shop
 *  as that character (coin comes from THAT actor's pouch, sell tab lists
 *  THAT actor's items). Fall back to game.user.character then a controlled
 *  token so a player without View As still gets their assigned actor. */
function resolveBuyer() {
    const assigned = getAssignedActor();
    if (assigned?.type === "character") return assigned;
    if (game.user.character) return game.user.character;
    const controlled = canvas?.tokens?.controlled ?? [];
    const fromToken = controlled.map(t => t.actor).find(a => a?.type === "character");
    return fromToken ?? null;
}

export class MerchantBuySheet extends HandlebarsApplicationMixin(ApplicationV2) {

    static DEFAULT_OPTIONS = {
        classes: ["witcher-ttrpg-death-march", "merchant-buy"],
        tag: "div",
        window: { title: "WITCHER.Merchant.Shop", icon: "fas fa-shop", resizable: true },
        position: { width: 860, height: 760 },
        actions: {
            addToCart:    MerchantBuySheet._onAddToCart,
            cartInc:      MerchantBuySheet._onCartInc,
            cartDec:      MerchantBuySheet._onCartDec,
            cartRemove:   MerchantBuySheet._onCartRemove,
            cartClear:    MerchantBuySheet._onCartClear,
            cartCheckout: MerchantBuySheet._onCartCheckout,
            addToSell:    MerchantBuySheet._onAddToSell,
            sellInc:      MerchantBuySheet._onSellInc,
            sellDec:      MerchantBuySheet._onSellDec,
            sellRemove:   MerchantBuySheet._onSellRemove,
            sellClear:    MerchantBuySheet._onSellClear,
            sellOffer:    MerchantBuySheet._onSellOffer,
            sellCategory: MerchantBuySheet._onSellCategory,
            switchTab:   MerchantBuySheet._onSwitchTab,
            togglePin:   MerchantBuySheet._onTogglePin,
            viewItem:    MerchantBuySheet._onViewItem,
            refresh:     MerchantBuySheet._onRefresh
        }
    };

    static PARTS = {
        body: {
            template: "systems/witcher-ttrpg-death-march/templates/actor/merchant/buy.hbs",
            scrollable: [".bs-grid-wrap", ".bs-cart-lines", ".bs-content"]
        }
    };

    constructor(merchant, options = {}) {
        super(options);
        this.merchant = merchant;
        this.buyer = options.buyer ?? resolveBuyer();
        this.activeTab = "buy";
        /* The basket: merchant itemId → qty. Owned HERE, not by the cart window,
         * so the grid's in-cart badges and the cart window's lines always agree
         * and closing the basket doesn't lose your picks. */
        this.cart = new Map();
        /* The sell cart: seller itemId → qty. Mirrors `cart`, but the goods
         * flow the other way and settle through one haggled bundle price. */
        this.sellCart = new Map();
        /* Which inventory category tab the sell grid is showing. */
        this.sellCategory = "gear";
        /* Shelf sort mode per tab, seeded from the user's remembered choice. */
        const savedSorts = game.user?.getFlag?.(SYSTEM_ID, SORT_FLAG) ?? {};
        this.buySort  = savedSorts.buy  ?? DEFAULT_SHELF_SORT;
        this.sellSort = savedSorts.sell ?? DEFAULT_SHELF_SORT;
        this._checkingOut = false;   // guards double-clicks on an in-flight checkout
        this._offering = false;      // guards double-clicks on an in-flight offer
        /* Hover-card timer for the grid tiles (see _wireGridInteractions). */
        this._hoverTimer = null;
        this._hoverItemId = null;

        // Stay in sync when the GM's render:false writes land on either actor.
        const refresh = foundry.utils.debounce(() => this.render(false), 80);
        this._refreshIfMine = (doc) => {
            const ids = [doc?.id, doc?.parent?.id];
            if (ids.includes(this.merchant?.id) || (this.buyer && ids.includes(this.buyer.id))) refresh();
        };
        // GM "View As" swap: if this sheet's buyer WASN'T pinned via an
        // explicit `options.buyer`, follow the assigned actor when the GM
        // switches. Otherwise (opened for a specific character), leave it
        // alone so a pinned shop window stays with its intended buyer.
        this._buyerPinned = !!options.buyer;
        this._onViewerOverride = () => {
            if (this._buyerPinned) return;
            const next = resolveBuyer();
            if (next?.id === this.buyer?.id) return;
            this.buyer = next;
            this.render(false);
        };

        this._hookIds = [
            ["updateActor",         Hooks.on("updateActor",         this._refreshIfMine)],
            ["createItem",          Hooks.on("createItem",          this._refreshIfMine)],
            ["updateItem",          Hooks.on("updateItem",          this._refreshIfMine)],
            ["deleteItem",          Hooks.on("deleteItem",          this._refreshIfMine)],
            [VIEWER_OVERRIDE_HOOK,  Hooks.on(VIEWER_OVERRIDE_HOOK,  this._onViewerOverride)]
        ];
        registerBuySheet(this);
    }

    get title() {
        return this.merchant?.system?.shopName || this.merchant?.name || game.i18n.localize("WITCHER.Merchant.Shop");
    }

    async close(options) {
        for (const [hook, id] of this._hookIds ?? []) Hooks.off(hook, id);
        this._hookIds = [];
        this._cancelHover();
        unregisterBuySheet(this);
        return super.close(options);
    }

    /* ── Cart ─────────────────────────────────────────────────
     * All mutations funnel through here so both windows repaint together.
     * Quantities are clamped to what's actually on the shelf; services have no
     * stock ceiling (buying two nights at an inn is legitimate). */

    /** Add `delta` (may be negative) to an item's cart line. */
    addToCart(itemId, delta = 1) {
        const item = this.merchant?.items?.get?.(itemId);
        if (!item) return;
        const isService = !!item.getFlag(SYSTEM_ID, "isService");
        const stock = Number(item.system?.quantity) || 0;
        const max = isService ? Number.MAX_SAFE_INTEGER : stock;
        if (!isService && stock <= 0) return;

        const next = (this.cart.get(itemId) ?? 0) + delta;
        if (next <= 0) this.cart.delete(itemId);
        else if (next > max) {
            this.cart.set(itemId, max);
            ui.notifications.info(game.i18n.format("WITCHER.Merchant.CartAtStockN", { n: max, item: item.name }));
        }
        else this.cart.set(itemId, next);
        this._syncCart();
    }

    removeFromCart(itemId) {
        this.cart.delete(itemId);
        this._syncCart();
    }

    clearCart() {
        if (!this.cart.size) return;
        this.cart.clear();
        this._syncCart();
    }

    /** Repaint after a cart change. The basket is a panel in this very window,
     *  so one render covers both the grid badges and the cart lines. */
    _syncCart() {
        this.render(false);
    }

    /* ── Sell cart ─────────────────────────────────────────
     * Same shape as the buy cart, clamped to what the SELLER actually holds. */

    addToSellCart(itemId, delta = 1) {
        const item = this.buyer?.items?.get?.(itemId);
        if (!item) return;
        const held = Number(item.system?.quantity) || 0;
        if (held <= 0) return;
        const next = (this.sellCart.get(itemId) ?? 0) + delta;
        if (next <= 0) this.sellCart.delete(itemId);
        else if (next > held) {
            this.sellCart.set(itemId, held);
            ui.notifications.info(game.i18n.format("WITCHER.Merchant.SellAtHeldN", { n: held, item: item.name }));
        }
        else this.sellCart.set(itemId, next);
        this.render(false);
    }

    removeFromSellCart(itemId) {
        this.sellCart.delete(itemId);
        this.render(false);
    }

    clearSellCart() {
        if (!this.sellCart.size) return;
        this.sellCart.clear();
        this.render(false);
    }

    /** The sell cart as offer lines. */
    _sellCartLines() {
        return [...this.sellCart].map(([itemId, qty]) => ({ itemId, qty }));
    }

    /** The cart as settlement lines, newest picks last. */
    _cartLines() {
        return [...this.cart].map(([itemId, qty]) => ({ itemId, qty }));
    }

    async _prepareContext(options) {
        const merchant = this.merchant;
        const denom = merchant.system.shopDenom || "crown";
        const buyerCoin = Number(foundry.utils.getProperty(this.buyer ?? {}, `system.currency.${denom}`)) || 0;
        const pinned = new Set(merchant.system.featuredPinned ?? []);

        const buyItems = merchant.items.map(item => {
            const isService = !!item.getFlag(SYSTEM_ID, "isService");
            return {
                id:                item.id,
                name:              item.name,
                img:               item.img,
                type:              item.type,
                quantity:          Number(item.system.quantity) || 0,
                weight:            Number(item.system.weight) || 0,
                price:             snapshotUnitPrice(merchant, item, this.buyer),
                rarity:            rarityOf(item),
                flairColor:        item.system?.flairColor ?? null,
                pinned:            pinned.has(item.id),
                // How many of this item are already in the basket — drives the
                // tile's corner badge and its "in cart" frame.
                inCart:            this.cart.get(item.id) ?? 0,
                // Tall (2:1) tiles use the inventory's own classification, so a
                // sword reads as a sword on the shelf exactly as it does in your
                // pack. cropStyle is the cached subject crop baked in so the
                // tile paints right on first frame; fitTallIconsIn() measures
                // any miss after render.
                isTall:            isTallItem(item),
                cropStyle:         isTallItem(item) ? tallCropStyleFor(item.img) : "",
                isService
            };
        }).filter(i => i.isService || (i.quantity > 0 && !NON_MERCHANT_TYPES.includes(i.type)));

        /* Everything currently tucked inside one of the seller's containers.
         * `system.isStored` is the maintained flag, but the inventory's own
         * take-out path notes it can drift out of sync (legacy imports, hand
         * edits), so we also walk every container's `content` array — which is
         * the actual source of truth for what a bag holds. */
        const storedIds = new Set();
        for (const c of (this.buyer?.items ?? [])) {
            if (c.type !== "container") continue;
            for (const ref of (c.system?.content ?? [])) storedIds.add(ref);
        }
        const isStored = (it) => !!it.system?.isStored || storedIds.has(it.uuid) || storedIds.has(it.id);

        /* The seller's own pack, as tiles. Only goods this merchant will touch
         * and that carry a value — nothing else is sellable.
         *
         * Packed goods are NOT on the shelf: an item inside a bag is listed in
         * that bag's `content` array, so selling it out from under the container
         * would leave a dangling reference behind. Take it out of the bag first.
         * By the same logic a container only goes on the shelf when it's EMPTY —
         * selling a loaded one would orphan everything in it. */
        const sellable = (this.buyer?.items ?? [])
            .filter(it => (Number(it.system?.quantity) || 0) > 0 && it.system?.cost != null
                && acceptsBuyCategory(merchant, it.type)
                && !isStored(it)
                && !(it.type === "container" && (it.system?.content ?? []).length > 0));

        const sellItems = sellable.map(it => ({
            id:            it.id,
            name:          it.name,
            img:           it.img,
            type:          it.type,
            rarity:        rarityOf(it),
            flairColor:    it.system?.flairColor ?? null,
            quantity:      Number(it.system.quantity) || 0,
            weight:        Number(it.system.weight) || 0,
            // Buyback rate (default 50%), converted to the shop denom and
            // adjusted for the seller's race / profession standing.
            suggestedPrice: buybackUnitPrice(merchant, it, this.buyer),
            currency:      denom,
            inCart:        this.sellCart.get(it.id) ?? 0,
            isTall:        isTallItem(it),
            cropStyle:     isTallItem(it) ? tallCropStyleFor(it.img) : "",
            // Which inventory category tab this belongs under.
            cat:           categorizeItem(it)?.cat ?? "misc"
        }));

        /* Category tabs, taken straight from the inventory so the shelf reads
         * with the same vocabulary as the player's own pack. Only categories
         * that actually hold something are offered — an empty tab is a dead end.
         * Containers aren't a category tab in the inventory either. */
        const sellCounts = sellItems.reduce((m, i) => m.set(i.cat, (m.get(i.cat) ?? 0) + 1), new Map());
        const sellCats = INV_CATEGORIES()
            .filter(c => sellCounts.has(c.id))
            .map(c => ({ id: c.id, label: c.label, icon: c.icon, count: sellCounts.get(c.id) }));
        // The remembered tab can go empty as goods leave the pack — fall back to
        // the first tab that still has something rather than showing a void.
        const activeSellCat = sellCats.some(c => c.id === this.sellCategory)
            ? this.sellCategory
            : (sellCats[0]?.id ?? this.sellCategory);
        const sellShelf = sortShelf(
            sellItems.filter(i => i.cat === activeSellCat), this.sellSort, "suggestedPrice");

        return {
            snapshot: {
                img:         merchant.img,
                shopName:    merchant.system.shopName || merchant.name,
                name:        merchant.name,
                personality: merchant.system.personality?.type || "neutral",
                currency:    denom
            },
            activeTab:  this.activeTab,
            // ONE flat lattice — no type sections. Pinned stock leads, then
            // services, then the shopper's chosen sort mode orders the rest
            // (default: type-then-name, the old fixed clustering).
            items:      sortShelf(buyItems, this.buySort, "price"),
            sellItems,
            // Sort chips for both toolbars — same vocabulary as the inventory.
            sortOptions: INV_SORTS(),
            buySort:    this.buySort,
            sellSort:   this.sellSort,
            buySortIcon:  (INV_SORTS().find(s => s.id === this.buySort)  ?? INV_SORTS()[0]).icon,
            sellSortIcon: (INV_SORTS().find(s => s.id === this.sellSort) ?? INV_SORTS()[0]).icon,
            sellShelf,
            sellCats,
            activeSellCat,
            hasBuyer:   !!this.buyer,
            buyerName:  this.buyer?.name ?? game.i18n.localize("WITCHER.Merchant.NoCharacter"),
            appraisalLocked: isAppraisalLocked(this.buyer, merchant.id),
            appraisalChecksLeft: appraisalChecksRemaining(this.buyer, merchant.id),
            isGM:       game.user.isGM,
            // What the trader has in the till, in his own shop denomination.
            merchantCoin: Number(foundry.utils.getProperty(merchant, `system.currency.${denom}`)) || 0,
            buyerCoin,
            ...this._cartContext(denom),
            ...this._sellCartContext(denom)
        };
    }

    /** The left-hand basket panel: one line per picked item, plus the totals. */
    _cartContext(denom) {
        const merchant = this.merchant;
        const lines = [];
        let total = 0;
        for (const [itemId, qty] of this.cart) {
            const item = merchant.items.get(itemId);
            // A line whose item left the shelf (GM edit, another shopper) is
            // shown as stale rather than silently dropped, so the player can see
            // WHY the total moved instead of watching it change on its own.
            if (!item) {
                lines.push({ id: itemId, qty, stale: true, name: game.i18n.localize("WITCHER.Merchant.CartLineGone") });
                continue;
            }
            const isService = !!item.getFlag(SYSTEM_ID, "isService");
            const unit = snapshotUnitPrice(merchant, item, this.buyer);
            const stock = Number(item.system?.quantity) || 0;
            total += unit * qty;
            lines.push({
                id: itemId, name: item.name, img: item.img, qty, unit,
                lineTotal: unit * qty, isService, stale: false,
                atMax: !isService && qty >= stock
            });
        }
        const buyerCoin = Number(foundry.utils.getProperty(this.buyer ?? {}, `system.currency.${denom}`)) || 0;
        return {
            cartLines:  lines,
            cartHasLines: lines.length > 0,
            cartCount:  [...this.cart.values()].reduce((n, q) => n + q, 0),
            cartTotal:  total,
            canAfford:  buyerCoin >= total,
            remainder:  Math.abs(buyerCoin - total),
            checkingOut: this._checkingOut
        };
    }

    /** The left-hand sell panel: what you're offering, and the suggested total.
     *  The suggestion is only a starting point — the actual figure is whatever
     *  you and the GM settle on in the haggle. */
    _sellCartContext(denom) {
        const lines = [];
        let suggested = 0;
        for (const [itemId, qty] of this.sellCart) {
            const item = this.buyer?.items?.get?.(itemId);
            // Sold, dropped or consumed since it went in the cart.
            if (!item) {
                lines.push({ id: itemId, qty, stale: true, name: game.i18n.localize("WITCHER.Merchant.SellLineGoneShort") });
                continue;
            }
            const unit = buybackUnitPrice(this.merchant, item, this.buyer);
            const held = Number(item.system?.quantity) || 0;
            suggested += unit * qty;
            lines.push({
                id: itemId, name: item.name, img: item.img, qty, unit,
                lineTotal: unit * qty, stale: false, atMax: qty >= held
            });
        }
        return {
            sellCartLines: lines,
            sellCartHasLines: lines.length > 0,
            sellCartCount: [...this.sellCart.values()].reduce((n, q) => n + q, 0),
            sellCartSuggested: suggested,
            // What the trader can actually pay — an offer above his reserve is
            // worth flagging before the haggle rather than after.
            merchantCanPay: (Number(foundry.utils.getProperty(this.merchant, `system.currency.${denom}`)) || 0) >= suggested,
            offering: this._offering
        };
    }

    /* ── Actions ──────────────────────────────────────────── */

    static _onSwitchTab(event, target) {
        this.activeTab = target.dataset.tab;
        this.render(false);
    }

    static async _onTogglePin(event, target) {
        if (!game.user.isGM) return;
        const itemId = target.dataset.itemId;
        const pinned = new Set(this.merchant.system.featuredPinned ?? []);
        if (pinned.has(itemId)) pinned.delete(itemId); else pinned.add(itemId);
        await this.merchant.update({ "system.featuredPinned": [...pinned] });
    }

    static _onRefresh() {
        this.render(false);
    }

    /* Open the item's own Foundry sheet. Item sheets in this system default
     * to display mode (see sheets/item/base.mjs — `#mode = "display"`), and
     * non-owners are pinned to it, so a buyer with OBSERVER on the merchant
     * gets the Witcher-3 style read-only tooltip without an extra flag. */
    static _onViewItem(event, target) {
        const itemId = target.dataset.itemId;
        // Your own goods: just open the real sheet. The read-only copy below
        // exists to hide the merchant's cost basis, which is meaningless for an
        // item you already own and can inspect from your pack anyway.
        if (this.activeTab === "sell") {
            this.buyer?.items?.get?.(itemId)?.sheet?.render(true);
            return;
        }
        const item = this.merchant?.items?.get?.(itemId);
        if (!item) return;
        // Everyone — players AND the GM — gets an in-memory, read-only COPY rather
        // than the live embedded sheet. This dodges the "insufficient permissions"
        // wall for shoppers AND keeps the price gated behind the Business appraisal
        // for the GM too (the shop list is the only place the price is revealed).
        // The GM manages real stock/prices from the merchant's own config sheet.
        try {
            const data = item.toObject();
            data.ownership = { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER };
            // Hide the base cost: zero the underlying value (defence in depth) AND
            // flag the sheet to blank every cost field it shows.
            if (data.system) data.system.cost = 0;
            data.flags = { ...(data.flags ?? {}), [SYSTEM_ID]: { ...(data.flags?.[SYSTEM_ID] ?? {}), merchantPreviewHideCost: true } };
            const temp = new CONFIG.Item.documentClass(data, { parent: null });
            temp.sheet?.render(true);
        } catch (err) {
            console.warn(`${SYSTEM_ID} | merchant item preview failed`, err);
            ui.notifications?.warn(game.i18n.localize("WITCHER.Merchant.ViewItemFailed"));
        }
    }

    /** Left-click a tile → one more of that item in the basket. Clicking the
     *  same tile again increments the line (capped at stock in addToCart). */
    static _onAddToCart(event, target) {
        if (!this._requireBuyer()) return;
        this.addToCart(target.dataset.itemId, 1);
    }

    static _onCartInc(event, target)    { this.addToCart(target.dataset.itemId, 1); }
    static _onCartDec(event, target)    { this.addToCart(target.dataset.itemId, -1); }
    static _onCartRemove(event, target) { this.removeFromCart(target.dataset.itemId); }
    static _onCartClear()               { this.clearCart(); }

    /** Settle the whole basket in one atomic transaction. */
    static async _onCartCheckout() {
        if (this._checkingOut) return;
        if (!this._requireBuyer()) return;
        const lines = this._cartLines();
        if (!lines.length) return ui.notifications.warn(game.i18n.localize("WITCHER.Merchant.CartEmpty"));

        this._checkingOut = true;
        this.render(false);
        try {
            const result = await requestCartBuy({
                merchantId: this.merchant.id,
                lines,
                buyerActorId: this.buyer.id
            });
            // Only empty the basket on a settlement we KNOW succeeded — a
            // rejected cart (not enough coin, stock moved) must stay intact so
            // the player can drop a line and retry.
            //
            // The GM path resolves with the real outcome. A player path returns
            // `pending`; the answer arrives later over the socket and net.mjs
            // clears the cart from its "buyResult" handler. Clearing optimisti-
            // cally here would throw the basket away on a rejected purchase.
            if (result?.ok && !result.pending) this.clearCart();
        } finally {
            this._checkingOut = false;
            this.render(false);
        }
    }

    /* ── Grid interactions ────────────────────────────────────
     * Hover cards, middle-click appraisal and right-click-to-inspect are wired
     * by hand rather than through the `actions` table: ApplicationV2 actions
     * only dispatch plain left clicks, and we need mouseover / auxclick /
     * contextmenu.
     *
     * Delegated from the app root and wired ONCE — a re-render swaps out the
     * part's innerHTML but keeps `this.element`, so per-render binding would
     * stack duplicate listeners. */

    async _onRender(context, options) {
        await super._onRender(context, options);
        this._wireGridInteractions();
        this._wireSortControls();
        // Measure + apply the 2:1 subject crop on tall tiles, same as the
        // inventory grid does. Cache hits were already baked into the markup
        // via cropStyle; this catches art seen for the first time.
        fitTallIconsIn(this.element);
        this._reanchorHoverCard();
    }

    /** Shelf sort dropdowns (one per tab). A `<select>` change isn't an
     *  ApplicationV2 `action`, so it's wired by hand here. Applies immediately —
     *  no separate apply button, matching the inventory overlay. The user flag
     *  write is fire-and-forget: a failure (rare) costs the memory of the
     *  choice, not the sort itself, which is already applied locally. */
    _wireSortControls() {
        for (const sel of this.element?.querySelectorAll(".bs-sort select[data-sort-tab]") ?? []) {
            sel.addEventListener("change", async (ev) => {
                const tab = ev.currentTarget.dataset.sortTab;   // "buy" | "sell"
                const key = ev.currentTarget.value;
                if (tab === "sell") this.sellSort = key; else this.buySort = key;
                this.render(false);
                try {
                    await game.user.setFlag(SYSTEM_ID, SORT_FLAG, { buy: this.buySort, sell: this.sellSort });
                } catch (err) {
                    console.warn(`${SYSTEM_ID} | could not persist merchant shelf sort`, err);
                }
            });
        }
    }

    /** A re-render replaces every tile, orphaning a card anchored to the old
     *  node — and adding to the basket re-renders, so that is the COMMON case,
     *  not an edge one. Rather than dropping the card mid-shop (forcing the
     *  user to jiggle the mouse to get it back), re-anchor it to the fresh tile
     *  for the same item; the footer is rebuilt too, so a just-rolled appraisal
     *  shows up immediately. */
    _reanchorHoverCard() {
        const id = this._hoverItemId;
        if (!id) return;
        const tile = this.element?.querySelector(`.bs-tile[data-item-id="${CSS.escape(id)}"]`);
        const item = this._tileItem(id);
        // Sold out, filtered away by a category switch, or the tab changed under
        // us → nothing left to point at.
        if (!tile || !item) { this._cancelHover(); return; }
        showItemHoverCard(item, tile, { footerHTML: this._tileFooterFor(item) });
    }

    /** Both tabs render `.bs-tile` elements, but a buy tile's item belongs to the
     *  MERCHANT and a sell tile's belongs to the BUYER. Every tile handler has to
     *  go through here — resolving a sell tile against merchant.items silently
     *  yields null, which is how the sell grid ended up with no hover card. */
    _tileItem(id) {
        if (!id) return null;
        const owner = this.activeTab === "sell" ? this.buyer : this.merchant;
        return owner?.items?.get?.(id) ?? null;
    }

    _wireGridInteractions() {
        const root = this.element;
        if (!root || this._gridWired) return;
        this._gridWired = true;

        const tileOf = (ev) => ev.target?.closest?.(".bs-tile[data-item-id]");

        /* Hover → the same item card the inventory grid raises, with the
         * appraisal line appended underneath. */
        root.addEventListener("mouseover", (ev) => {
            const tile = tileOf(ev);
            const id = tile?.dataset?.itemId;
            if (!id || id === this._hoverItemId) return;
            this._cancelHover();
            this._hoverItemId = id;
            this._hoverTimer = setTimeout(() => {
                const item = this._tileItem(id);
                if (!item || !tile.isConnected) return;
                showItemHoverCard(item, tile, { footerHTML: this._tileFooterFor(item) });
            }, HOVER_DELAY_MS);
        });

        root.addEventListener("mouseout", (ev) => {
            const tile = tileOf(ev);
            if (!tile || tile.contains(ev.relatedTarget)) return;   // still inside the tile
            if (tile.dataset.itemId === this._hoverItemId) this._cancelHover();
        });

        /* Middle-click → spend a Business check to appraise this item. The
         * mousedown handler exists purely to swallow the browser's autoscroll
         * cursor; auxclick is what actually fires the check. */
        root.addEventListener("mousedown", (ev) => {
            if (ev.button === 1 && tileOf(ev)) ev.preventDefault();
        });

        root.addEventListener("auxclick", (ev) => {
            if (ev.button !== 1) return;
            const tile = tileOf(ev);
            if (!tile) return;
            ev.preventDefault();
            // Appraisal is a buy-side mechanic — it reads the merchant's asking
            // price against fair value. There's nothing to appraise about your
            // own goods, so sell tiles ignore the gesture entirely.
            if (this.activeTab === "sell") return;
            this._appraise(tile.dataset.itemId);
        });

        /* Right-click → the item's own read-only sheet (the old eye button).
         * NOT double-click: a dblclick also delivers two plain clicks, which
         * the action table would happily read as "add two to the cart". */
        root.addEventListener("contextmenu", (ev) => {
            const tile = tileOf(ev);
            if (!tile) return;
            ev.preventDefault();
            MerchantBuySheet._onViewItem.call(this, ev, tile);
        });

        // A card anchored to a tile that a re-render is about to replace would
        // hang in mid-air; drop it whenever the grid scrolls or the window closes.
        root.addEventListener("scroll", () => this._cancelHover(), true);
    }

    _cancelHover() {
        clearTimeout(this._hoverTimer);
        this._hoverTimer = null;
        this._hoverItemId = null;
        hideItemHoverCard();
    }

    /** Roll the Business check for a tile, honouring the daily lock. Shared by
     *  the middle-click path and the tile's appraise button. */
    async _appraise(itemId) {
        if (!itemId || !this._requireBuyer()) return;
        if (isAppraisalLocked(this.buyer, this.merchant.id)) {
            return ui.notifications.warn(game.i18n.localize("WITCHER.Merchant.AppraisalLocked"));
        }
        this._cancelHover();
        await requestPriceReveal({ merchantId: this.merchant.id, itemId, buyerActorId: this.buyer.id });
    }

    /** The block appended under the hover card. Which one depends on the
     *  direction of trade: buying shows what the merchant wants for it, selling
     *  shows what he'll give you. */
    _tileFooterFor(item) {
        return this.activeTab === "sell"
            ? this._buybackFooterFor(item)
            : this._appraisalFooterFor(item);
    }

    /** Sell-side footer: the trader's per-unit buyback offer. No appraisal here
     *  — appraisal weighs HIS asking price against fair value, and there's
     *  nothing to uncover about goods already in your own pack. */
    _buybackFooterFor(item) {
        const denom = this.merchant.system.shopDenom || "crown";
        const unit = buybackUnitPrice(this.merchant, item, this.buyer);
        const inCart = this.sellCart.get(item.id) ?? 0;
        const held = Number(item.system?.quantity) || 0;
        const line = inCart
            ? game.i18n.format("WITCHER.Merchant.SellHoverInCart", { n: inCart, held })
            : game.i18n.localize("WITCHER.Merchant.SellHoverHint");
        return `<div class="bs-hover-appraise">
            <div class="bs-hover-ask">
                <span class="bs-hover-label">${esc(game.i18n.localize("WITCHER.Merchant.SellHoverOffer"))}</span>
                <span class="bs-hover-value">${unit} ${esc(denom)}</span>
            </div>
            <div class="bs-hover-hint">
                <i class="fas fa-hand-holding-usd"></i><span>${esc(line)}</span>
            </div>
        </div>`;
    }

    /** Buy-side footer: what the merchant is asking, and — once appraised —
     *  what the goods are actually worth. */
    _appraisalFooterFor(item) {
        const merchant = this.merchant;
        const denom = merchant.system.shopDenom || "crown";
        const asking = snapshotUnitPrice(merchant, item, this.buyer);
        const isService = !!item.getFlag(SYSTEM_ID, "isService");

        const askRow = `<div class="bs-hover-ask">
            <span class="bs-hover-label">${esc(game.i18n.localize("WITCHER.Merchant.AskingPrice"))}</span>
            <span class="bs-hover-value">${asking} ${esc(denom)}</span>
        </div>`;

        // A service has no fair market value to weigh the price against, so it
        // gets the asking line only (matching the hidden appraise button).
        if (isService) return `<div class="bs-hover-appraise">${askRow}</div>`;

        const slug = String(item.name).toLowerCase().trim();
        const fair = getRevealedPricesFor(this.buyer, merchant.id)[slug];

        if (fair === undefined) {
            const locked = isAppraisalLocked(this.buyer, merchant.id);
            // Locked → explain why it's unavailable. Otherwise teach the gesture:
            // middle-click is the ONLY route to an appraisal now that the tile
            // carries no button, so this callout has to actually read as one.
            const hint = locked
                ? game.i18n.localize("WITCHER.Merchant.AppraisalLockedHint")
                : game.i18n.localize("WITCHER.Merchant.AppraiseHint");
            const icon = locked ? "fa-lock" : "fa-computer-mouse";
            return `<div class="bs-hover-appraise is-unknown">
                ${askRow}
                <div class="bs-hover-hint${locked ? " is-locked" : ""}">
                    <i class="fas ${icon}"></i><span>${esc(hint)}</span>
                </div>
            </div>`;
        }

        // Stored fair value is the crown base — convert so it's comparable to
        // the (already converted) asking price.
        const fairShop = toShopPrice(merchant, fair);
        const delta = asking - fairShop;
        const verdictKey = delta > 0 ? "WITCHER.Merchant.AppraiseOver"
                         : delta < 0 ? "WITCHER.Merchant.AppraiseUnder"
                                     : "WITCHER.Merchant.AppraiseFair";
        const verdictCls = delta > 0 ? "is-over" : delta < 0 ? "is-under" : "is-even";
        const verdict = game.i18n.format(verdictKey, { n: Math.abs(delta), denom });

        return `<div class="bs-hover-appraise is-known ${verdictCls}">
            ${askRow}
            <div class="bs-hover-fair">
                <span class="bs-hover-label"><i class="fas fa-balance-scale"></i> ${esc(game.i18n.localize("WITCHER.Merchant.Fair"))}</span>
                <span class="bs-hover-value">${fairShop} ${esc(denom)}</span>
            </div>
            <div class="bs-hover-verdict">${esc(verdict)}</div>
        </div>`;
    }

    static _onAddToSell(event, target) {
        if (!this._requireBuyer()) return;
        this.addToSellCart(target.dataset.itemId, 1);
    }
    static _onSellInc(event, target)    { this.addToSellCart(target.dataset.itemId, 1); }
    static _onSellDec(event, target)    { this.addToSellCart(target.dataset.itemId, -1); }
    static _onSellRemove(event, target) { this.removeFromSellCart(target.dataset.itemId); }
    static _onSellClear()               { this.clearSellCart(); }

    static _onSellCategory(event, target) {
        this.sellCategory = target.dataset.cat;
        this.render(false);
    }

    /** Send the WHOLE sell cart to the GM as one offer, haggled at a single
     *  combined price. The cart is emptied only when the GM's "concluded"
     *  message says the goods actually changed hands (net.mjs does that), so a
     *  refused offer leaves it intact to re-price and send again. */
    static async _onSellOffer() {
        if (this._offering) return;
        if (!this._requireBuyer()) return;
        const lines = this._sellCartLines();
        if (!lines.length) return ui.notifications.warn(game.i18n.localize("WITCHER.Merchant.SellCartEmpty"));
        // Something in the cart may have been packed into a bag since it was
        // added. Catch it here rather than sending an offer that would strand a
        // reference in the container.
        const packed = lines.find(l => this.buyer.items.get(l.itemId)?.system?.isStored);
        if (packed) {
            const it = this.buyer.items.get(packed.itemId);
            return ui.notifications.warn(game.i18n.format("WITCHER.Merchant.SellItemPacked", { item: it?.name ?? "" }));
        }

        this._offering = true;
        this.render(false);
        try {
            await startBundleSellNegotiation({
                merchantId: this.merchant.id,
                sellerActorId: this.buyer.id,
                lines
            });
        } finally {
            this._offering = false;
            this.render(false);
        }
    }

    _requireBuyer() {
        if (this.buyer) return true;
        ui.notifications.warn(game.i18n.localize("WITCHER.Merchant.NoCharacter"));
        return false;
    }
}

/** Open (or focus) the shop window for a merchant. */
export function openMerchantShop(merchant, buyer = null) {
    if (!merchant) return;
    const existing = Object.values(foundry.applications.instances ?? {})
        .find(a => a instanceof MerchantBuySheet && a.merchant?.id === merchant.id);
    if (existing) return existing.render(true);
    return new MerchantBuySheet(merchant, buyer ? { buyer } : {}).render(true);
}
