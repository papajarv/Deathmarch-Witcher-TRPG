/**
 * MerchantBuySheet — player-facing shop window.
 *
 * A standalone ApplicationV2 (NOT the merchant's document sheet — that's the
 * GM config sheet). Opened from a scene portrait card or the GM sheet's
 * "Open shop" button via `openMerchantShop(merchant, buyer)`.
 *
 * Two tabs:
 *   Buy  — the merchant's stock, grouped by item type, priced via pricing.mjs.
 *          A buyer can roll a Business check to reveal an item's fair price.
 *   Sell — the buyer's own goods, each offered to the merchant through the
 *          multi-round negotiation in net.mjs.
 *
 * The window reads the merchant actor directly, so a player needs at least
 * OBSERVER permission on the merchant (the GM grants this on the shop actor).
 * All mutations route through net.mjs to the GM.
 *
 * Ported from witcher-merchant-system buy-sheet.js (MerchantBuySheet), trimmed
 * to the new system's net layer (no per-call socket request/response plumbing —
 * net.mjs owns that) and pricing helpers.
 */

import { snapshotUnitPrice, rarityOf, rarityDC, NON_MERCHANT_TYPES } from "../../merchant/pricing.mjs";
import { getRevealedPricesFor, isAppraisalLocked } from "../../merchant/transactions.mjs";
import { requestBuy, requestPriceReveal, startSellNegotiation, registerBuySheet, unregisterBuySheet } from "../../merchant/net.mjs";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

const SYSTEM_ID = "witcher-ttrpg-death-march";

/** First non-empty value among an item's possible description fields. */
function itemDescription(item) {
    const sys = item.system ?? {};
    return sys.description?.value ?? sys.description ?? sys.notes ?? "";
}

/** The buyer character for the current user: assigned, else a controlled token. */
function resolveBuyer() {
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
        position: { width: 720, height: 720 },
        actions: {
            buyItem:     MerchantBuySheet._onBuyItem,
            revealPrice: MerchantBuySheet._onRevealPrice,
            offerSell:   MerchantBuySheet._onOfferSell,
            switchTab:   MerchantBuySheet._onSwitchTab,
            toggleGroup: MerchantBuySheet._onToggleGroup,
            toggleItem:  MerchantBuySheet._onToggleItem,
            togglePin:   MerchantBuySheet._onTogglePin,
            refresh:     MerchantBuySheet._onRefresh
        }
    };

    static PARTS = {
        body: { template: "systems/witcher-ttrpg-death-march/templates/actor/merchant/buy.hbs", scrollable: [".bs-content"] }
    };

    constructor(merchant, options = {}) {
        super(options);
        this.merchant = merchant;
        this.buyer = options.buyer ?? resolveBuyer();
        this.activeTab = "buy";
        this.collapsed = { buy: new Set(), sell: new Set() };
        // Item rows whose description is expanded, per tab.
        this.expandedItems = { buy: new Set(), sell: new Set() };

        // Stay in sync when the GM's render:false writes land on either actor.
        const refresh = foundry.utils.debounce(() => this.render(false), 80);
        this._refreshIfMine = (doc) => {
            const ids = [doc?.id, doc?.parent?.id];
            if (ids.includes(this.merchant?.id) || (this.buyer && ids.includes(this.buyer.id))) refresh();
        };
        this._hookIds = [
            ["updateActor", Hooks.on("updateActor", this._refreshIfMine)],
            ["createItem",  Hooks.on("createItem",  this._refreshIfMine)],
            ["updateItem",  Hooks.on("updateItem",  this._refreshIfMine)],
            ["deleteItem",  Hooks.on("deleteItem",  this._refreshIfMine)]
        ];
        registerBuySheet(this);
    }

    get title() {
        return this.merchant?.system?.shopName || this.merchant?.name || game.i18n.localize("WITCHER.Merchant.Shop");
    }

    async close(options) {
        for (const [hook, id] of this._hookIds ?? []) Hooks.off(hook, id);
        this._hookIds = [];
        unregisterBuySheet(this);
        return super.close(options);
    }

    /** Group a flat item list by type; pinned-bearing groups float to the top. */
    _group(items, scope) {
        const collapsed = this.collapsed[scope];
        const byType = new Map();
        for (const it of items) {
            if (!byType.has(it.type)) byType.set(it.type, []);
            byType.get(it.type).push(it);
        }
        const labelFor = (t) => {
            const key = `TYPES.Item.${t}`;
            const loc = game.i18n.localize(key);
            return loc !== key ? loc : String(t || "misc").replace(/^\w/, c => c.toUpperCase());
        };
        return [...byType.entries()]
            .map(([type, list]) => {
                list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
                return { type, label: labelFor(type), count: list.length, collapsed: collapsed.has(type), items: list };
            })
            .sort((a, b) => {
                const ap = a.items.some(i => i.pinned) ? 0 : 1;
                const bp = b.items.some(i => i.pinned) ? 0 : 1;
                return ap !== bp ? ap - bp : a.label.localeCompare(b.label);
            });
    }

    async _prepareContext(options) {
        const merchant = this.merchant;
        const denom = merchant.system.shopDenom || "crown";
        const reveals = getRevealedPricesFor(this.buyer, merchant.id);
        const pinned = new Set(merchant.system.featuredPinned ?? []);
        const expBuy = this.expandedItems.buy;
        const expSell = this.expandedItems.sell;

        const buyItems = merchant.items.map(item => {
            const slug = String(item.name).toLowerCase().trim();
            const fair = reveals[slug];
            return {
                id:                item.id,
                name:              item.name,
                img:               item.img,
                type:              item.type,
                quantity:          Number(item.system.quantity) || 0,
                weight:            Number(item.system.weight) || 0,
                price:             snapshotUnitPrice(merchant, item),
                rarity:            rarityOf(item),
                dc:                rarityDC(item),
                revealedBasePrice: fair,
                isRevealed:        fair !== undefined,
                pinned:            pinned.has(item.id),
                expanded:          expBuy.has(item.id),
                description:       itemDescription(item)
            };
        }).filter(i => i.quantity > 0 && !NON_MERCHANT_TYPES.includes(i.type));

        const sellItems = (this.buyer?.items ?? [])
            .filter(it => (Number(it.system?.quantity) || 0) > 0 && it.system?.cost != null
                && !NON_MERCHANT_TYPES.includes(it.type))
            .map(it => {
                const basePrice = Number(it.system.cost) || 0;
                return {
                    id:            it.id,
                    name:          it.name,
                    img:           it.img,
                    type:          it.type,
                    rarity:        rarityOf(it),
                    quantity:      Number(it.system.quantity) || 0,
                    weight:        Number(it.system.weight) || 0,
                    basePrice,
                    suggestedPrice: Math.max(1, Math.floor(basePrice * 0.5)),
                    currency:      denom,
                    expanded:      expSell.has(it.id),
                    description:   itemDescription(it)
                };
            });

        return {
            snapshot: {
                img:         merchant.img,
                shopName:    merchant.system.shopName || merchant.name,
                name:        merchant.name,
                personality: merchant.system.personality?.type || "neutral",
                currency:    denom
            },
            activeTab:  this.activeTab,
            items:      buyItems,
            groups:     this._group(buyItems, "buy"),
            sellItems,
            sellGroups: this._group(sellItems, "sell"),
            hasBuyer:   !!this.buyer,
            buyerName:  this.buyer?.name ?? game.i18n.localize("WITCHER.Merchant.NoCharacter"),
            appraisalLocked: isAppraisalLocked(this.buyer, merchant.id),
            isGM:       game.user.isGM
        };
    }

    /* ── Actions ──────────────────────────────────────────── */

    static _onSwitchTab(event, target) {
        this.activeTab = target.dataset.tab;
        this.render(false);
    }

    static _onToggleGroup(event, target) {
        const { group, scope = "buy" } = target.dataset;
        const set = this.collapsed[scope];
        if (set.has(group)) set.delete(group); else set.add(group);
        target.closest(".bs-group")?.classList.toggle("is-collapsed");
    }

    static _onToggleItem(event, target) {
        const { itemId, scope = "buy" } = target.dataset;
        const set = this.expandedItems[scope];
        if (set.has(itemId)) set.delete(itemId); else set.add(itemId);
        target.closest(".bs-item")?.classList.toggle("is-expanded");
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

    static async _onBuyItem(event, target) {
        if (!this._requireBuyer()) return;
        const item = this.merchant.items.get(target.dataset.itemId);
        if (!item) return;
        const max = Number(item.system.quantity) || 1;
        const denom = this.merchant.system.shopDenom || "crown";

        const qty = await DialogV2.prompt({
            window: { title: `${game.i18n.localize("WITCHER.Merchant.Buy")}: ${item.name}` },
            content: `
                <form class="wdm-merchant-buy-qty">
                    <p>${game.i18n.format("WITCHER.Merchant.HowMany", { max })}</p>
                    <p><strong>${snapshotUnitPrice(this.merchant, item)} ${denom}</strong> ${game.i18n.localize("WITCHER.Merchant.PerUnit")}</p>
                    <input type="number" name="qty" value="1" min="1" max="${max}" autofocus />
                </form>`,
            ok: {
                label: game.i18n.localize("WITCHER.Merchant.Buy"),
                callback: (e, button) => Math.max(1, Math.min(max, Number(button.form.elements.qty.value) || 1))
            },
            modal: true, rejectClose: false
        }).catch(() => null);
        if (!qty) return;

        await requestBuy({ merchantId: this.merchant.id, itemId: item.id, qty, buyerActorId: this.buyer.id });
    }

    static async _onRevealPrice(event, target) {
        if (!this._requireBuyer()) return;
        if (isAppraisalLocked(this.buyer, this.merchant.id)) {
            return ui.notifications.warn(game.i18n.localize("WITCHER.Merchant.AppraisalLocked"));
        }
        await requestPriceReveal({ merchantId: this.merchant.id, itemId: target.dataset.itemId, buyerActorId: this.buyer.id });
    }

    static async _onOfferSell(event, target) {
        if (!this._requireBuyer()) return;
        const item = this.buyer.items.get(target.dataset.itemId);
        if (!item) return;
        if (NON_MERCHANT_TYPES.includes(item.type)) {
            return ui.notifications.warn(game.i18n.format("WITCHER.Merchant.NoStockType", { type: item.type }));
        }
        await startSellNegotiation({ merchantId: this.merchant.id, sellerActorId: this.buyer.id, item });
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
