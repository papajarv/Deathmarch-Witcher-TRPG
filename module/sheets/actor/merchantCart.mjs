/**
 * MerchantCartSheet — the shop's basket window.
 *
 * A companion window to MerchantBuySheet: the shop grid holds the goods, this
 * holds what you've picked up and what the merchant is asking for the lot.
 *
 * The cart itself is NOT stored here. It lives on the parent MerchantBuySheet
 * (`shop.cart`, a Map of itemId → qty) so there is exactly one source of truth:
 * the grid paints its in-cart badges from it, this window paints its lines from
 * it, and closing the shop takes the cart with it. This window is a view.
 *
 * Checkout routes through `requestCartBuy` → `processCartPurchase`, which
 * settles every line in one atomic transaction — the cart is either bought
 * whole or not at all.
 */

import { snapshotUnitPrice } from "../../merchant/pricing.mjs";
import { requestCartBuy } from "../../merchant/net.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const SYSTEM_ID = "witcher-ttrpg-death-march";

export class MerchantCartSheet extends HandlebarsApplicationMixin(ApplicationV2) {

    static DEFAULT_OPTIONS = {
        classes: ["witcher-ttrpg-death-march", "merchant-cart"],
        tag: "div",
        window: { title: "WITCHER.Merchant.Cart", icon: "fas fa-basket-shopping", resizable: true },
        position: { width: 380, height: 520 },
        actions: {
            cartInc:      MerchantCartSheet._onInc,
            cartDec:      MerchantCartSheet._onDec,
            cartRemove:   MerchantCartSheet._onRemove,
            cartClear:    MerchantCartSheet._onClear,
            cartCheckout: MerchantCartSheet._onCheckout
        }
    };

    static PARTS = {
        body: {
            template: `systems/${SYSTEM_ID}/templates/actor/merchant/cart.hbs`,
            scrollable: [".mc-lines"]
        }
    };

    constructor(shop, options = {}) {
        super(options);
        this.shop = shop;
        this._busy = false;   // guards double-clicks during an in-flight checkout
    }

    get title() {
        const shopName = this.shop?.merchant?.system?.shopName || this.shop?.merchant?.name || "";
        const cart = game.i18n.localize("WITCHER.Merchant.Cart");
        return shopName ? `${cart} — ${shopName}` : cart;
    }

    /** Dropping the reference lets the shop know to re-open a fresh window,
     *  and stops it pushing renders at a closed app. */
    async close(options) {
        if (this.shop?.cartWindow === this) this.shop.cartWindow = null;
        return super.close(options);
    }

    async _prepareContext(options) {
        const shop = this.shop;
        const merchant = shop?.merchant;
        const denom = merchant?.system?.shopDenom || "crown";
        const cart = shop?.cart ?? new Map();

        const lines = [];
        let total = 0;
        for (const [itemId, qty] of cart) {
            const item = merchant?.items?.get?.(itemId);
            // A line whose item vanished from stock (GM edit, another shopper)
            // is shown as stale rather than silently dropped, so the player can
            // see WHY their total changed instead of watching it move on its own.
            if (!item) {
                lines.push({ id: itemId, name: game.i18n.localize("WITCHER.Merchant.CartLineGone"), stale: true, qty });
                continue;
            }
            const isService = !!item.getFlag(SYSTEM_ID, "isService");
            const unit = snapshotUnitPrice(merchant, item, shop.buyer);
            const stock = Number(item.system?.quantity) || 0;
            const lineTotal = unit * qty;
            total += lineTotal;
            lines.push({
                id: itemId,
                name: item.name,
                img: item.img,
                type: item.type,
                qty,
                unit,
                lineTotal,
                isService,
                stock,
                // Services have no stock ceiling; goods cap at what's on the shelf.
                atMax: !isService && qty >= stock,
                stale: false
            });
        }

        const buyerCoin = Number(foundry.utils.getProperty(shop?.buyer ?? {}, `system.currency.${denom}`)) || 0;

        return {
            lines,
            hasLines: lines.length > 0,
            total,
            currency: denom,
            buyerName: shop?.buyer?.name ?? game.i18n.localize("WITCHER.Merchant.NoCharacter"),
            hasBuyer: !!shop?.buyer,
            buyerCoin,
            canAfford: buyerCoin >= total,
            remainder: buyerCoin - total,
            busy: this._busy
        };
    }

    /* ── Actions ──────────────────────────────────────────── */

    static _onInc(event, target) {
        this.shop?.addToCart(target.dataset.itemId, 1);
    }

    static _onDec(event, target) {
        this.shop?.addToCart(target.dataset.itemId, -1);
    }

    static _onRemove(event, target) {
        this.shop?.removeFromCart(target.dataset.itemId);
    }

    static _onClear() {
        this.shop?.clearCart();
    }

    static async _onCheckout() {
        const shop = this.shop;
        if (!shop) return;
        if (this._busy) return;
        if (!shop.buyer) {
            return ui.notifications.warn(game.i18n.localize("WITCHER.Merchant.NoCharacter"));
        }
        const lines = [...(shop.cart ?? new Map())].map(([itemId, qty]) => ({ itemId, qty }));
        if (!lines.length) {
            return ui.notifications.warn(game.i18n.localize("WITCHER.Merchant.CartEmpty"));
        }

        this._busy = true;
        this.render(false);
        try {
            const result = await requestCartBuy({
                merchantId: shop.merchant.id,
                lines,
                buyerActorId: shop.buyer.id
            });
            // Only empty the cart on a settlement we KNOW succeeded — a rejected
            // cart (not enough coin, stock moved) must stay intact so the player
            // can fix it and retry.
            //
            // The GM path resolves with the real outcome, so we can act on it
            // here. A player path returns `pending` and the answer arrives later
            // over the socket: net.mjs clears the cart from its "buyResult"
            // handler once the GM confirms. Clearing optimistically here would
            // throw the basket away on a rejected purchase.
            if (result?.ok && !result.pending) shop.clearCart();
        } finally {
            this._busy = false;
            this.render(false);
        }
    }
}
