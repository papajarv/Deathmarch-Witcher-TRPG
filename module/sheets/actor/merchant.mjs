/**
 * WitcherMerchantSheet — GM shop-keeper sheet.
 *
 * Faithful port of witcher-merchant-system's merchant-sheet-enhanced.js: a
 * header (portrait / name / shop / personality / currency / quirk) plus five
 * tabs — General (summary + description), Pricing (markup + bulk sliders),
 * Inventory (sortable stock with per-item markup, coin reserve, expand rows),
 * Relationships (auto-listed assigned PCs with standing controls), and Stocking
 * (compendium sources, quantity, rarity, presets).
 *
 * Adapted to the new schema: the original's `system.currency` (string denom)
 * and `system.coinReserve` (number) become `system.shopDenom` plus the
 * six-denomination wallet `system.currency.<denom>`. Stocking presets, which
 * the old module kept in a world setting, live per-merchant on
 * `system.stocking.presets`. The roll engine itself lives in
 * module/merchant/stocking.mjs; this sheet only configures + triggers it.
 *
 * The player-facing buy/sell view is a separate application (buy.mjs).
 *
 * Hook name: `renderWitcherMerchantSheet`.
 */

import { WitcherActorSheet } from "./base.mjs";
import { stockMerchant } from "../../merchant/stocking.mjs";
import { snapshotUnitPrice, itemMarkupOf, ITEM_MARKUP_FLAG, NON_MERCHANT_TYPES, rarityOf } from "../../merchant/pricing.mjs";

import { t, tFormat } from "../../chrome/lib/i18n.js";
const SYSTEM_ID = "witcher-ttrpg-death-march";
const DialogV2 = foundry.applications.api.DialogV2;

const MERCHANT_TABS = ["general", "pricing", "inventory", "relationships", "stocking"];

/** Enrich item description HTML (links, rolls) via Foundry's TextEditor. */
async function enrichDesc(text) {
    if (!text) return "";
    const TE = foundry?.applications?.ux?.TextEditor?.implementation
            ?? foundry?.applications?.ux?.TextEditor
            ?? window?.TextEditor;
    try { return TE?.enrichHTML ? await TE.enrichHTML(text, { async: true }) : text; }
    catch (_e) { return text; }
}

/** Rebalance a sources array so its weights sum to 100. Mutates in place. */
function redistributeSources(sources) {
    if (sources.length === 0) return;
    let total = sources.reduce((s, src) => s + (Number(src.weight) || 0), 0);
    if (total === 0) {
        const each = Math.floor(100 / sources.length);
        sources.forEach(s => s.weight = each);
        sources[0].weight += 100 - (each * sources.length);
    } else if (total !== 100) {
        const ratio = 100 / total;
        sources.forEach(s => s.weight = Math.round((Number(s.weight) || 0) * ratio));
        const finalSum = sources.reduce((sum, src) => sum + src.weight, 0);
        if (finalSum !== 100) sources[0].weight += 100 - finalSum;
    }
}

export class WitcherMerchantSheet extends WitcherActorSheet {

    static DEFAULT_OPTIONS = {
        classes: [...WitcherActorSheet.DEFAULT_OPTIONS.classes, "merchant"],
        position: { width: 860, height: 760 },
        actions: {
            depositCoin:       WitcherMerchantSheet._onDepositCoin,
            withdrawCoin:      WitcherMerchantSheet._onWithdrawCoin,
            clearStock:        WitcherMerchantSheet._onClearStock,
            sortInventory:     WitcherMerchantSheet._onSortInventory,
            toggleItemExpand:  WitcherMerchantSheet._onToggleItemExpand,
            editItemMarkup:    WitcherMerchantSheet._onEditItemMarkup,
            toggleItemService: WitcherMerchantSheet._onToggleItemService,
            toggleItemFreshness: WitcherMerchantSheet._onToggleItemFreshness,
            inventoryDelete:   WitcherMerchantSheet._onInventoryDelete,
            adjustRelationship: WitcherMerchantSheet._onAdjustRelationship,
            resetRelationship:  WitcherMerchantSheet._onResetRelationship,
            addDemographic:     WitcherMerchantSheet._onAddDemographic,
            removeDemographic:  WitcherMerchantSheet._onRemoveDemographic,
            runStocking:       WitcherMerchantSheet._onRunStocking,
            runRestock:        WitcherMerchantSheet._onRunRestock,
            addSource:         WitcherMerchantSheet._onAddSource,
            editSource:        WitcherMerchantSheet._onEditSource,
            removeSource:      WitcherMerchantSheet._onRemoveSource,
            savePreset:        WitcherMerchantSheet._onSavePreset,
            loadPreset:        WitcherMerchantSheet._onLoadPreset,
            deletePreset:      WitcherMerchantSheet._onDeletePreset,
            saveItemPool:      WitcherMerchantSheet._onSaveItemPool,
            clearItemPool:     WitcherMerchantSheet._onClearItemPool
        }
    };

    static PARTS = {
        main: {
            template: "systems/witcher-ttrpg-death-march/templates/actor/merchant/main.hbs",
            scrollable: [".wdm-merchant-panels"]
        }
    };

    /* Inventory sort state, persisted across re-renders. */
    _sortField = "name";
    _sortDir = "asc";
    _expandedItems = new Set();

    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);

        const flag = this.actor.getFlag(SYSTEM_ID, "activeTab");
        ctx.activeTab = MERCHANT_TABS.includes(flag) ? flag : "general";

        const sys = this.actor.system;
        const denom = sys.shopDenom || "crown";
        ctx.shopDenom = denom;
        ctx.coinReserve = Number(sys.currency?.[denom]) || 0;

        // Personality + pricing readouts (markupPercent etc. precomputed —
        // the template's gt/lt/capitalize helpers aren't registered here).
        const personality = sys.personality?.type || "neutral";
        ctx.currentPersonality = personality;
        ctx.personalityLabel = personality.charAt(0).toUpperCase() + personality.slice(1);
        ctx.personalityQuirk = sys.personality?.quirk || "";

        const markup = sys.pricing?.baseMarkup ?? 1.0;
        ctx.baseMarkup = markup;
        ctx.markupPercent = Math.round((markup - 1) * 100);
        ctx.markupSign = ctx.markupPercent > 0 ? "+" : "";
        ctx.markupClass = ctx.markupPercent > 0 ? "markup-positive" : ctx.markupPercent < 0 ? "markup-negative" : "markup-zero";
        ctx.bulkDiscountThreshold = sys.pricing?.bulkDiscountThreshold ?? 5;
        ctx.bulkDiscountPercent = sys.pricing?.bulkDiscountPercent ?? 10;
        ctx.hasBulkDiscount = ctx.bulkDiscountPercent > 0;
        ctx.buybackPercent = sys.pricing?.buybackPercent ?? 50;

        // Accepted buy categories (Pricing tab). Empty stored list = accept every
        // tradeable type, so an empty list renders as all-checked.
        const allItemTypes = game.documentTypes?.Item ?? Object.keys(CONFIG.Item?.dataModels ?? {});
        const tradeable = allItemTypes.filter(ty => ty !== "base" && !NON_MERCHANT_TYPES.includes(ty));
        const accepted = new Set(sys.buyCategories ?? []);
        ctx.buyCategoryOptions = tradeable.map(ty => {
            const key = `TYPES.Item.${ty}`;
            const loc = game.i18n.localize(key);
            return { type: ty, label: loc !== key ? loc : ty.charAt(0).toUpperCase() + ty.slice(1), checked: !accepted.size || accepted.has(ty) };
        });

        // Race / profession price rules (Relationships tab).
        ctx.demographicRules = (sys.demographicModifiers ?? []).map((r, i) => ({
            index: i,
            kind: r?.kind === "profession" ? "profession" : "race",
            name: r?.name ?? "",
            pricePercent: Number.isFinite(Number(r?.pricePercent)) ? Number(r.pricePercent) : 100
        }));

        await this._prepareInventory(ctx);
        ctx.relationships = this._prepareRelationships();
        ctx.stockingData = this._prepareStocking();
        ctx.sortField = this._sortField;
        ctx.sortDir = this._sortDir;

        return ctx;
    }

    async _prepareInventory(ctx) {
        const field = this._sortField;
        const dir = this._sortDir === "asc" ? 1 : -1;
        const merchantMarkup = this.actor.system.pricing?.baseMarkup ?? 1.0;

        const items = Array.from(this.actor.items).sort((a, b) => {
            switch (field) {
                case "type":     return a.type < b.type ? -dir : a.type > b.type ? dir : 0;
                case "cost":     return ((Number(a.system.cost) || 0) - (Number(b.system.cost) || 0)) * dir;
                case "quantity": return ((Number(a.system.quantity) || 0) - (Number(b.system.quantity) || 0)) * dir;
                case "weight":   return ((Number(a.system.weight) || 0) - (Number(b.system.weight) || 0)) * dir;
                default: {
                    const an = a.name.toLowerCase(), bn = b.name.toLowerCase();
                    return an < bn ? -dir : an > bn ? dir : 0;
                }
            }
        });

        const enriched = [];
        for (const item of items) {
            const raw = item.system.description?.value ?? item.system.description ?? item.system.notes ?? "";
            const itemMarkup = itemMarkupOf(item);
            const itemMarkupPercent = Math.round((itemMarkup - 1) * 100);
            const baseCost = Number(item.system.cost) || 0;
            const isService = !!item.getFlag(SYSTEM_ID, "isService");
            /* Freshness decay toggle — only meaningful for food items.
             * Default (flag absent) = frozen on shelf; button off. GM
             * clicks the button to opt this specific stock item into
             * normal shelf-life advancement. See
             * `isMerchantFrozenFood` in mechanics/foodAndDrink.mjs. */
            const isFood = item.type === "food";
            const freshnessDecayOn = isFood
                && item.getFlag(SYSTEM_ID, "merchantFreshnessDecay") === true;
            enriched.push({
                id:                item.id,
                name:              item.name,
                img:               item.img,
                type:              item.type,
                rarity:            rarityOf(item),
                flairColor:        item.system?.flairColor ?? null,
                cost:              baseCost,
                quantity:          Number(item.system.quantity) || 0,
                weight:            Number(item.system.weight) || 0,
                description:       await enrichDesc(raw),
                hasDescription:    !!raw,
                isExpanded:        this._expandedItems.has(item.id),
                itemMarkupPercent,
                itemMarkupSign:    itemMarkupPercent > 0 ? "+" : "",
                itemMarkupClass:   itemMarkupPercent > 0 ? "up" : "down",
                effectivePrice:    Math.round(baseCost * itemMarkup * merchantMarkup),
                hasItemMarkup:     itemMarkup !== 1.0,
                isService,         // Service = payment-only listing (buy pays,
                                   // no item transfer, merchant stock isn't
                                   // decremented). Toggled per-item by the GM.
                isFood,
                freshnessDecayOn
            });
        }

        ctx.allItems = enriched;
        ctx.itemCount = enriched.length;
        ctx.totalInventoryValue = enriched.reduce((s, i) => s + (i.cost * (i.quantity || 1)), 0);
        ctx.totalWeight = Math.round(enriched.reduce((s, i) => s + (i.weight * (i.quantity || 1)), 0) * 100) / 100;
    }

    /** Auto-list characters assigned to a User; merge stored standing. */
    _prepareRelationships() {
        const assignedActorIds = new Set();
        for (const user of game.users) if (user.character) assignedActorIds.add(user.character.id);
        const pcs = game.actors.filter(a => assignedActorIds.has(a.id));
        const stored = this.actor.system.playerRelations || [];

        return pcs.map(pc => {
            const existing = stored.find(r => r.playerId === pc.id);
            const value = Number(existing?.relationship) || 0;
            const priceModifier = value >= 0 ? -Math.round(value * 0.25) : -Math.round(value * 0.50);
            return {
                playerId:           pc.id,
                playerName:         pc.name,
                playerImg:          pc.img,
                relationship:       value,
                relationshipLabel:  this._relationshipLabel(value),
                relationshipColor:  this._relationshipColor(value),
                priceModifier,
                priceModifierLabel: priceModifier > 0 ? tFormat("WITCHER.Sheet.Actor.Merchant.Text.PricePlus",    { p: priceModifier }, "+{p}% price")
                                  : priceModifier < 0 ? tFormat("WITCHER.Sheet.Actor.Merchant.Text.PriceDiscount", { p: priceModifier }, "{p}% discount")
                                  : t("WITCHER.Sheet.Actor.Merchant.Text.StandardPrice", "standard price"),
                notes:              existing?.notes ?? ""
            };
        });
    }

    _relationshipLabel(v) {
        if (v >= 75)  return t("WITCHER.Sheet.Actor.Merchant.Relation.TrustedFriend", "Trusted Friend");
        if (v >= 50)  return t("WITCHER.Sheet.Actor.Merchant.Relation.Friendly",      "Friendly");
        if (v >= 25)  return t("WITCHER.Sheet.Actor.Merchant.Relation.Cordial",       "Cordial");
        if (v >= -24) return t("WITCHER.Sheet.Actor.Merchant.Relation.Neutral",       "Neutral");
        if (v >= -49) return t("WITCHER.Sheet.Actor.Merchant.Relation.Wary",          "Wary");
        if (v >= -74) return t("WITCHER.Sheet.Actor.Merchant.Relation.Hostile",       "Hostile");
        return t("WITCHER.Sheet.Actor.Merchant.Relation.SwornEnemy", "Sworn Enemy");
    }

    _relationshipColor(v) {
        if (v >= 50) return "good";
        if (v >= 25) return "okay";
        if (v >= -24) return "neutral";
        if (v >= -49) return "bad";
        return "terrible";
    }

    _prepareStocking() {
        const stocking = this.actor.system.stocking || {};
        return {
            sources:        (stocking.sources || []).map(s => ({
                packId:          s.packId ?? "",
                packLabel:       s.packLabel ?? s.packId ?? "",
                folderPaths:     s.folderPaths ?? [],
                includeKeywords: s.includeKeywords ?? "",
                excludeKeywords: s.excludeKeywords ?? "",
                weight:          Number(s.weight) || 0
            })),
            useItemPool:    stocking.useItemPool ?? false,
            itemPoolCount:  (this.actor.system.itemPool || []).length,
            totalMode:      stocking.totalMode || "fixed",
            totalFixed:     stocking.totalFixed ?? 20,
            totalRandomMin: stocking.totalRandomMin ?? 10,
            totalRandomMax: stocking.totalRandomMax ?? 30,
            allowStacks:    stocking.allowStacks ?? true,
            maxStack:       stocking.maxStack ?? 3,
            stackChance:    stocking.stackChance ?? 30,
            rarityEnabled:  stocking.rarityEnabled || { everywhere: true, common: true, poor: true, rare: true, witcher: false, elderfolk: false, relic: false, goetia: false, experimental: false },
            useRarityWeights: stocking.useRarityWeights ?? false,
            rarityWeights:  stocking.rarityWeights || { everywhere: 50, common: 30, poor: 15, rare: 4, witcher: 1, elderfolk: 1, relic: 1, goetia: 1, experimental: 1 },
            presets:        stocking.presets || [],
            lastStockCount: stocking.lastStockCount ?? 0,
            hasLastStock:   (stocking.lastStock || []).length > 0,
            lastStockedAtFormatted: stocking.lastStockedAt ? new Date(stocking.lastStockedAt).toLocaleString() : t("WITCHER.Sheet.Actor.Merchant.Text.Never", "Never")
        };
    }

    /* ── Form wiring ──────────────────────────────────────── */

    /**
     * Merge stock-by-name on drop (no combat-action gating — a merchant isn't a
     * combatant). Bypasses the base sheet's pick-up-is-an-action handling.
     */
    async _onDropItem(event, item) {
        if (!this.isEditable) return;
        if (NON_MERCHANT_TYPES.includes(item.type)) {
            return ui.notifications.warn(game.i18n.format("WITCHER.Merchant.NoStockType", { type: item.type }));
        }
        const existing = this.actor.items.find(i => i.name === item.name && i.type === item.type);
        if (existing) {
            const qty = (Number(existing.system.quantity) || 1) + (Number(item.system.quantity) || 1);
            return existing.update({ "system.quantity": qty });
        }
        return this.actor.createEmbeddedDocuments("Item", [item.toObject()]);
    }

    /**
     * Gate the no-`name` interactive controls so they don't trigger a full form
     * submit: inline item quantity, relationship slider/notes, and source weight
     * sliders each route to a targeted update instead.
     */
    _onChangeForm(formConfig, event) {
        const el = event.target;

        if (el?.dataset?.itemQty !== undefined && el?.dataset?.itemId) {
            event.preventDefault();
            const item = this.actor.items.get(el.dataset.itemId);
            const qty = Math.max(0, Math.round(Number(el.value) || 0));
            if (!item) return;
            if (qty === 0) item.delete();
            else item.update({ "system.quantity": qty }, { render: false }).catch(e => ui.notifications.error(e, { console: true }));
            return;
        }

        if (el?.classList?.contains("relation-slider")) {
            event.preventDefault();
            const value = Math.max(-100, Math.min(100, Number(el.value) || 0));
            this._upsertRelation(el.dataset.playerId, entry => { entry.relationship = value; });
            return;
        }

        if (el?.classList?.contains("relation-notes")) {
            event.preventDefault();
            this._upsertRelation(el.dataset.playerId, entry => { entry.notes = el.value; });
            return;
        }

        if (el?.classList?.contains("source-slider")) {
            event.preventDefault();
            const sliders = [...(this.element?.querySelectorAll(".source-slider") ?? [])];
            const sources = foundry.utils.duplicate(this.actor.system.stocking?.sources ?? []);
            sliders.forEach((s, i) => { if (sources[i]) sources[i].weight = Number(s.value); });
            this.actor.update({ "system.stocking.sources": sources });
            return;
        }

        // Accepted buy categories — collect every checked box into the array.
        // All-checked is stored explicitly; an empty result means "accept all".
        if (el?.classList?.contains("wdm-buycat-check")) {
            event.preventDefault();
            const checks = [...(this.element?.querySelectorAll(".wdm-buycat-check") ?? [])];
            const picked = checks.filter(c => c.checked).map(c => c.dataset.category);
            this.actor.update({ "system.buyCategories": picked });
            return;
        }

        // Race/profession rule field edits — patch the one field on its row.
        if (el?.classList?.contains("wdm-demo-field")) {
            event.preventDefault();
            const index = Number(el.dataset.index);
            const field = el.dataset.field;
            const rules = foundry.utils.duplicate(this.actor.system.demographicModifiers ?? []);
            if (index < 0 || index >= rules.length) return;
            if (field === "pricePercent")   rules[index].pricePercent = Math.max(0, Math.round(Number(el.value) || 0));
            else if (field === "kind")      rules[index].kind = el.value === "profession" ? "profession" : "race";
            else if (field === "name")      rules[index].name = el.value;
            else return;
            this.actor.update({ "system.demographicModifiers": rules }, { render: false });
            return;
        }

        // Stocking toggles gate {{#if}} blocks; the focus-guarded periodic
        // refresh skips the active sheet, so force a re-render after the save.
        const name = el?.name || "";
        if (name === "system.stocking.useRarityWeights" ||
            name === "system.stocking.useItemPool" ||
            name === "system.stocking.totalMode" ||
            name === "system.stocking.allowStacks" ||
            name.startsWith("system.stocking.rarityEnabled.")) {
            event.preventDefault();
            this.submit({ render: false })
                .then(() => this.render(false))
                .catch(err => ui.notifications.error(err, { console: true }));
            return;
        }

        return super._onChangeForm(formConfig, event);
    }

    /** Coerce the radio-string useItemPool back to a boolean before submit. */
    _prepareSubmitData(event, form, formData) {
        const data = super._prepareSubmitData(event, form, formData);
        const v = foundry.utils.getProperty(data, "system.stocking.useItemPool");
        if (typeof v === "string") foundry.utils.setProperty(data, "system.stocking.useItemPool", v === "true");
        return data;
    }

    async _onRender(context, options) {
        await super._onRender(context, options);
        const root = this.element;
        if (!root) return;
        this._wireLiveReadouts(root);
        this._wireSourceSliders(root);
    }

    /** Live readout text on sliders + paired slider/number sync (display only). */
    _wireLiveReadouts(root) {
        const markup = root.querySelector(".markup-slider");
        const markupReadout = markup?.closest(".slider-row")?.querySelector(".slider-readout");
        markup?.addEventListener("input", () => {
            const pct = Math.round((Number(markup.value) - 1) * 100);
            markupReadout.textContent = (pct > 0 ? "+" : "") + pct + "%";
            markupReadout.classList.remove("markup-positive", "markup-negative", "markup-zero");
            markupReadout.classList.add(pct > 0 ? "markup-positive" : pct < 0 ? "markup-negative" : "markup-zero");
        });

        const discount = root.querySelector(".discount-slider");
        const discountReadout = discount?.closest(".slider-row")?.querySelector(".slider-readout");
        discount?.addEventListener("input", () => { discountReadout.textContent = `${discount.value}% off`; });

        const stack = root.querySelector(".stack-chance-slider");
        const stackReadout = root.querySelector(".stack-chance-readout");
        stack?.addEventListener("input", () => { stackReadout.textContent = `${stack.value}%`; });

        root.querySelectorAll(".rarity-weight-row input[type='range']").forEach(slider => {
            const readout = slider.closest(".rarity-weight-row")?.querySelector(".slider-readout");
            slider.addEventListener("input", () => { if (readout) readout.textContent = `${slider.value}%`; });
        });

        // Paired number → slider (number carries no name; slider does the save).
        root.querySelectorAll("[data-sync-source]").forEach(num => {
            const slider = root.querySelector(`.${num.dataset.syncSource}`);
            if (!slider) return;
            num.addEventListener("input", () => { slider.value = num.value; });
            num.addEventListener("change", () => { slider.value = num.value; slider.dispatchEvent(new Event("change", { bubbles: true })); });
        });
        root.querySelectorAll("[data-sync-target]").forEach(slider => {
            const num = root.querySelector(`[data-sync-id="${slider.dataset.syncTarget}"]`);
            if (!num) return;
            slider.addEventListener("input", () => { num.value = slider.value; });
        });
    }

    /** Source weight sliders rebalance to 100 live; commit lands via _onChangeForm. */
    _wireSourceSliders(root) {
        const pool = root.querySelector("[data-source-pool]");
        if (!pool) return;
        const sliders = [...pool.querySelectorAll(".source-slider")];
        const readouts = [...pool.querySelectorAll(".source-readout")];
        const poolTotal = root.querySelector(".pool-total");

        const paint = (values) => {
            values.forEach((v, i) => {
                if (readouts[i]) readouts[i].textContent = `${v}%`;
                if (sliders[i]) sliders[i].value = v;
            });
            const total = values.reduce((a, b) => a + b, 0);
            if (poolTotal) { poolTotal.textContent = `${total}%`; poolTotal.style.color = total === 100 ? "" : "#e57373"; }
        };

        sliders.forEach((slider, changedIdx) => {
            slider.addEventListener("input", () => {
                const sources = foundry.utils.duplicate(this.actor.system.stocking?.sources ?? []);
                const newValue = Number(slider.value);
                if (!sources[changedIdx]) return;
                sources[changedIdx].weight = newValue;
                const others = sources.filter((s, i) => i !== changedIdx);
                const othersSum = others.reduce((sum, s) => sum + (Number(s.weight) || 0), 0);
                const remaining = 100 - newValue;
                if (others.length === 0) {
                    sources[changedIdx].weight = 100;
                } else if (othersSum === 0) {
                    const each = Math.floor(remaining / others.length);
                    others.forEach(s => s.weight = each);
                    const sum = others.reduce((s, src) => s + src.weight, 0);
                    if (sum < remaining) others[0].weight += remaining - sum;
                } else {
                    const ratio = remaining / othersSum;
                    others.forEach(s => s.weight = Math.max(0, Math.round((Number(s.weight) || 0) * ratio)));
                    const sum = sources.reduce((s, src) => s + (Number(src.weight) || 0), 0);
                    if (sum !== 100) others[0].weight += 100 - sum;
                }
                paint(sources.map(s => Number(s.weight) || 0));
            });
        });
    }

    async _upsertRelation(playerId, mutate) {
        if (!playerId) return;
        const relations = foundry.utils.duplicate(this.actor.system.playerRelations ?? []);
        let entry = relations.find(r => r.playerId === playerId);
        if (!entry) { entry = { playerId, relationship: 0, lastNegotiation: 0, notes: "" }; relations.push(entry); }
        mutate(entry);
        await this.actor.update({ "system.playerRelations": relations });
    }

    /* ── Inventory ────────────────────────────────────────── */

    static _onSortInventory(event, target) {
        const field = target.dataset.sortField;
        if (!field) return;
        if (this._sortField === field) this._sortDir = this._sortDir === "asc" ? "desc" : "asc";
        else { this._sortField = field; this._sortDir = "asc"; }
        this.render(false);
    }

    static _onToggleItemExpand(event, target) {
        const id = target.closest("[data-item-id]")?.dataset.itemId;
        if (!id) return;
        if (this._expandedItems.has(id)) this._expandedItems.delete(id);
        else this._expandedItems.add(id);
        this.render(false);
    }

    static async _onInventoryDelete(event, target) {
        const id = target.closest("[data-item-id]")?.dataset.itemId;
        const item = this.actor.items.get(id);
        if (!item) return;
        const ok = await DialogV2.confirm({
            window: { title: t("WITCHER.Dialog.Merchant.RemoveItem", "Remove Item") },
            content: `<p>${t("WITCHER.Sheet.Actor.Merchant.Text.Remove", "Remove")} <strong>${item.name}</strong> from inventory?</p>`,
            modal: true, rejectClose: false
        });
        if (ok) { await item.delete(); this.render(false); }
    }

    /** Flip the per-item Service flag. Service items pay coin on buy but
     *  don't transfer any item to the buyer, and don't decrement the
     *  merchant's stock — they're payment-only listings (a night at the
     *  inn, a bath, ferry passage, training sessions, etc.). */
    static async _onToggleItemService(event, target) {
        const id = target.closest("[data-item-id]")?.dataset.itemId;
        const item = this.actor.items.get(id);
        if (!item) return;
        const cur = !!item.getFlag(SYSTEM_ID, "isService");
        await item.setFlag(SYSTEM_ID, "isService", !cur);
        this.render(false);
    }

    /** Flip the per-item merchant freshness-decay flag. Food items on a
     *  merchant DO NOT age by default (a fresh apple stays fresh no matter
     *  how many game weeks the shop sits on it) — GMs opt-in per item
     *  by flipping this on, at which point normal shelf-life advancement
     *  resumes AND an anchor is stamped so decay starts counting now.
     *  Flipping OFF clears the anchor so the item reads as fresh again. */
    static async _onToggleItemFreshness(event, target) {
        const id = target.closest("[data-item-id]")?.dataset.itemId;
        const item = this.actor.items.get(id);
        if (!item || item.type !== "food") return;
        const cur = item.getFlag(SYSTEM_ID, "merchantFreshnessDecay") === true;
        const next = !cur;
        const update = {
            [`flags.${SYSTEM_ID}.merchantFreshnessDecay`]: next
        };
        /* Turning decay ON: stamp anchor to now so the shelf-life countdown
         * starts from this moment (rather than inheriting a stale value).
         * Turning decay OFF: clear the anchor so getFreshnessState reads
         * as fresh regardless of any old anchor from before. */
        if (next) {
            update["system.freshness.anchorTime"] = Number(game.time?.worldTime) || 0;
        } else {
            update["system.freshness.anchorTime"] = null;
        }
        await item.update(update);
        this.render(false);
    }

    static async _onClearStock(event, target) {
        const count = this.actor.items.size;
        if (count === 0) return ui.notifications.info(t("WITCHER.Notify.Merchant.InventoryEmpty", "Inventory is already empty."));
        const ok = await DialogV2.confirm({
            window: { title: t("WITCHER.Dialog.Merchant.ClearStock", "Clear Stock") },
            content: `<p>${t("WITCHER.Sheet.Actor.Merchant.Text.DeleteAll", "Delete all")} <strong>${count}</strong> items from this merchant's inventory?</p><p>${t("WITCHER.Sheet.Actor.Merchant.Text.ThisCannotBeUndone", "This cannot be undone.")}</p>`,
            modal: true, rejectClose: false
        });
        if (!ok) return;
        await this.actor.deleteEmbeddedDocuments("Item", this.actor.items.map(i => i.id), { render: false });
        this.render(false);
    }

    /** Per-item markup slider dialog (−90% … +300%), stored as a flag. */
    static async _onEditItemMarkup(event, target) {
        const id = target.closest("[data-item-id]")?.dataset.itemId;
        const item = this.actor.items.get(id);
        if (!item) return;
        const currentPct = Math.round((itemMarkupOf(item) - 1) * 100);

        const result = await DialogV2.wait({
            window: { title: tFormat("WITCHER.Dialog.Merchant.Markup", { item: item.name }, "Markup: {item}") },
            content: `
                <form class="markup-dialog">
                    <p style="opacity:0.7;font-size:0.85rem;margin:0 0 0.6rem 0;">${t("WITCHER.Sheet.Actor.Merchant.Text.CustomMarkupHint", "Apply a custom per-item adjustment, applied <em>before</em> the merchant's base markup, personality modifier, and other price changes.")}</p>
                    <div class="form-group">
                        <label>Markup %:</label>
                        <div style="display:flex;align-items:center;gap:0.5rem;">
                            <input type="range" name="pct" min="-100" max="300" step="1" value="${currentPct}" class="markup-dialog-slider" style="flex:1;" />
                            <input type="number" name="pctNum" min="-100" max="300" step="1" value="${currentPct}" class="markup-dialog-num" style="width:70px;" />
                            <span>%</span>
                        </div>
                        <p class="dialog-hint">0% = no change. Positive = more expensive. Negative = discount (−100% = free).</p>
                    </div>
                </form>`,
            buttons: [
                { action: "ok", label: t("WITCHER.Sheet.Actor.Merchant.Dialog.Button.Apply", "Apply"), default: true, callback: (e, button) => Number(button.form.elements.pct.value) },
                { action: "reset", label: t("WITCHER.Sheet.Actor.Merchant.Dialog.Button.Reset0", "Reset (0%)"), callback: () => 0 },
                { action: "cancel", label: t("WITCHER.Common.Cancel", "Cancel"), callback: () => null }
            ],
            modal: true, rejectClose: false,
            render: (e, dialog) => {
                const root = dialog.element || dialog;
                const slider = root.querySelector(".markup-dialog-slider");
                const num = root.querySelector(".markup-dialog-num");
                if (slider && num) {
                    slider.addEventListener("input", () => num.value = slider.value);
                    num.addEventListener("input", () => slider.value = num.value);
                }
            }
        }).catch(() => null);

        if (result === null || result === undefined) return;
        const pct = Math.max(-100, Math.min(300, Number(result) || 0));
        const multiplier = 1 + (pct / 100);
        if (multiplier === 1.0) await item.unsetFlag(SYSTEM_ID, ITEM_MARKUP_FLAG);
        else await item.setFlag(SYSTEM_ID, ITEM_MARKUP_FLAG, multiplier);
        this.render(false);
    }

    /* ── Coin reserve ─────────────────────────────────────── */

    static async _onDepositCoin(event, target) {
        const denom = this.actor.system.shopDenom || "crown";
        const current = Number(this.actor.system.currency?.[denom]) || 0;
        const amount = await DialogV2.prompt({
            window: { title: t("WITCHER.Dialog.Merchant.Deposit", "Deposit Coin") },
            content: `<form><p>${t("WITCHER.Sheet.Actor.Merchant.Text.CurrentReserve", "Current reserve:")} <strong>${current} ${denom}</strong></p><div class="form-group"><label>${t("WITCHER.Sheet.Actor.Merchant.Text.AmountToDeposit", "Amount to deposit:")}</label><input type="number" name="amount" value="100" min="1" autofocus /></div></form>`,
            ok: { label: t("WITCHER.Sheet.Actor.Merchant.Dialog.Button.Deposit", "Deposit"), callback: (e, button) => Number(button.form.elements.amount.value) || 0 },
            modal: true, rejectClose: false
        }).catch(() => null);
        if (amount && amount > 0) {
            await this.actor.update({ [`system.currency.${denom}`]: current + amount });
            ui.notifications.info(tFormat("WITCHER.Notify.Merchant.Deposited", { amount: amount, denom: denom, reserve: current + amount }, "Deposited {amount} {denom}. New reserve: {reserve}."));
        }
    }

    static async _onWithdrawCoin(event, target) {
        const denom = this.actor.system.shopDenom || "crown";
        const current = Number(this.actor.system.currency?.[denom]) || 0;
        if (current <= 0) return ui.notifications.warn(t("WITCHER.Notify.Merchant.ReserveEmpty", "Coin reserve is empty."));
        const amount = await DialogV2.prompt({
            window: { title: t("WITCHER.Dialog.Merchant.Withdraw", "Withdraw Coin") },
            content: `<form><p>${t("WITCHER.Sheet.Actor.Merchant.Text.CurrentReserve", "Current reserve:")} <strong>${current} ${denom}</strong></p><div class="form-group"><label>${t("WITCHER.Sheet.Actor.Merchant.Text.AmountToWithdraw", "Amount to withdraw:")}</label><input type="number" name="amount" value="${Math.min(100, current)}" min="1" max="${current}" autofocus /></div></form>`,
            ok: { label: t("WITCHER.Sheet.Actor.Merchant.Dialog.Button.Withdraw", "Withdraw"), callback: (e, button) => Number(button.form.elements.amount.value) || 0 },
            modal: true, rejectClose: false
        }).catch(() => null);
        if (amount && amount > 0) {
            const taken = Math.min(amount, current);
            await this.actor.update({ [`system.currency.${denom}`]: current - taken });
            ui.notifications.info(tFormat("WITCHER.Notify.Merchant.Withdrew", { taken: taken, denom: denom, reserve: current - taken }, "Withdrew {taken} {denom}. New reserve: {reserve}."));
        }
    }

    /* ── Relationships ────────────────────────────────────── */

    static async _onAdjustRelationship(event, target) {
        const { playerId, delta } = target.dataset;
        if (!playerId) return;
        const d = Number(delta) || 0;
        await this._upsertRelation(playerId, entry => {
            entry.relationship = Math.max(-100, Math.min(100, (Number(entry.relationship) || 0) + d));
        });
    }

    static async _onResetRelationship(event, target) {
        const playerId = target.dataset.playerId;
        if (!playerId) return;
        await this._upsertRelation(playerId, entry => { entry.relationship = 0; });
    }

    /* ── Stocking: run ────────────────────────────────────── */

    static async _onRunStocking(event, target) {
        await this._flushForm();
        if (!this.actor.system.stocking?.useItemPool && (this.actor.system.stocking?.sources ?? []).length === 0) {
            return ui.notifications.warn(t("WITCHER.Notify.Merchant.NoSources", "No compendium sources configured. Add a source, or switch to Item Pool mode."));
        }
        const count = this.actor.items.size;
        if (count > 0) {
            const proceed = await DialogV2.confirm({
                window: { title: t("WITCHER.Dialog.Merchant.RunStock", "Run Stocking") },
                content: tFormat("WITCHER.Sheet.Actor.Merchant.Dialog.RunStockConfirm", { count }, "<p>This will clear the current inventory ({count} items) and generate fresh stock. Continue?</p>"),
                modal: true, rejectClose: false
            });
            if (!proceed) return;
        }
        this._reportStock(await stockMerchant(this.actor, { isRestock: false }));
        this.render(false);
    }

    static async _onRunRestock(event, target) {
        await this._flushForm();
        if ((this.actor.system.stocking?.lastStock ?? []).length === 0) {
            return ui.notifications.warn(t("WITCHER.Notify.Merchant.NoPreviousStock", "No previous stocking found. Run a full stock first."));
        }
        this._reportStock(await stockMerchant(this.actor, { isRestock: true }));
        this.render(false);
    }

    _reportStock(result) {
        if (result.ok) return ui.notifications.info(tFormat("WITCHER.Notify.Merchant.Stocked", { count: result.count }, "{count} items stocked."));
        const reasons = {
            noSources: t("WITCHER.Sheet.Actor.Merchant.StockFail.NoSources", "No compendium sources configured."),
            emptyPool: t("WITCHER.Sheet.Actor.Merchant.StockFail.EmptyPool", "Item pool is empty. Drop items onto Inventory, then Save as Pool."),
            noItems:   t("WITCHER.Sheet.Actor.Merchant.StockFail.NoItems",   "No items rolled. Check folders, keywords, and rarity settings.")
        };
        ui.notifications.warn(reasons[result.reason] ?? reasons.noItems);
    }

    /* ── Stocking: sources ────────────────────────────────── */

    static async _onAddSource(event, target) {
        await this._flushForm();
        await this._openSourceDialog(null);
    }

    static async _onEditSource(event, target) {
        await this._flushForm();
        const index = Number(target.dataset.index);
        if (Number.isNaN(index)) return;
        await this._openSourceDialog(index);
    }

    static async _onRemoveSource(event, target) {
        const index = Number(target.dataset.index);
        const sources = foundry.utils.duplicate(this.actor.system.stocking?.sources ?? []);
        if (index < 0 || index >= sources.length) return;
        sources.splice(index, 1);
        redistributeSources(sources);
        await this.actor.update({ "system.stocking.sources": sources });
    }

    /* ── Race / profession price rules ──────────────────────────── */

    static async _onAddDemographic(event, target) {
        await this._flushForm();
        const rules = foundry.utils.duplicate(this.actor.system.demographicModifiers ?? []);
        rules.push({ kind: "race", name: "", pricePercent: 100 });
        await this.actor.update({ "system.demographicModifiers": rules });
    }

    static async _onRemoveDemographic(event, target) {
        const index = Number(target.dataset.index);
        const rules = foundry.utils.duplicate(this.actor.system.demographicModifiers ?? []);
        if (index < 0 || index >= rules.length) return;
        rules.splice(index, 1);
        await this.actor.update({ "system.demographicModifiers": rules });
    }

    /**
     * Compendium source dialog (add or edit): pack picker, live folder-tree
     * checkboxes, and include/exclude keyword fields.
     */
    async _openSourceDialog(existingIndex) {
        const sources = foundry.utils.duplicate(this.actor.system.stocking?.sources ?? []);
        const allPacks = Array.from(game.packs).filter(p => p.documentName === "Item");
        const existing = existingIndex !== null ? sources[existingIndex] : null;

        const used = new Set(sources.map((s, i) => (i === existingIndex ? null : s.packId)).filter(Boolean));
        const available = allPacks.filter(p => !used.has(p.collection));
        if (!existing && available.length === 0) return ui.notifications.info(t("WITCHER.Notify.Merchant.AllAdded", "All Item compendiums have already been added."));

        const packOptions = available.map(p =>
            `<option value="${p.collection}" ${existing?.packId === p.collection ? "selected" : ""}>${p.metadata.label} (${p.metadata.packageName})</option>`
        ).join("");

        const folderPathOf = (f) => { const parts = []; let cur = f; while (cur) { parts.unshift(cur.name); cur = cur.folder; } return parts.join(" / "); };

        const buildFolderTree = (packId) => {
            const pack = game.packs.get(packId);
            if (!pack) return '<div class="folder-empty">— entire compendium —</div>';
            const folders = Array.from(pack.folders || []);
            if (folders.length === 0) return '<div class="folder-empty">— entire compendium (no folders) —</div>';
            const entries = folders.map(f => { const path = folderPathOf(f); return { folder: f, path, depth: path.split(" / ").length - 1 }; })
                .sort((a, b) => a.path.localeCompare(b.path));
            const selected = existing?.folderPaths?.length ? existing.folderPaths : (existing?.folderPath ? [existing.folderPath] : []);
            const rows = [`<div class="folder-row folder-all"><label><input type="checkbox" class="folder-all-check" ${selected.length === 0 ? "checked" : ""} /> <em>— entire compendium —</em></label></div>`];
            for (const { folder, path, depth } of entries) {
                rows.push(`<div class="folder-row" style="padding-left:${depth * 1.2}rem;"><label><input type="checkbox" class="folder-check" data-path="${path}" ${selected.includes(path) ? "checked" : ""} /> <i class="fas fa-folder"></i> ${folder.name}</label></div>`);
            }
            return `<div class="folder-tree">${rows.join("")}</div>`;
        };

        const wireFolders = (container) => {
            if (!container) return;
            const allCheck = container.querySelector(".folder-all-check");
            const folderChecks = container.querySelectorAll(".folder-check");
            const syncAll = () => { if (allCheck) allCheck.checked = !Array.from(folderChecks).some(c => c.checked); };
            allCheck?.addEventListener("change", () => { if (allCheck.checked) folderChecks.forEach(c => c.checked = false); });
            folderChecks.forEach(c => c.addEventListener("change", syncAll));
            syncAll();
        };

        const initialPackId = existing?.packId || available[0]?.collection;
        const content = `
            <form class="source-dialog">
                <div class="form-group"><label>Compendium:</label><select name="pack" class="pack-select">${packOptions}</select></div>
                <div class="form-group"><label>${t("WITCHER.Sheet.Actor.Merchant.Label.Folders", "Folders:")}</label><div class="folder-picker">${buildFolderTree(initialPackId)}</div>
                    <p class="dialog-hint">${t("WITCHER.Sheet.Actor.Merchant.Hint.Folders", "Check one or more folders to restrict to those subsets. Leave nothing checked for all items. Selecting a folder includes its descendants too.")}</p></div>
                <div class="form-group"><label>${t("WITCHER.Sheet.Actor.Merchant.Label.IncludeKeywords", "Include keywords (comma-separated):")}</label><input type="text" name="include" placeholder="${t("WITCHER.Sheet.Actor.Merchant.Text.EGSwordBladeAxe", "e.g. sword, blade, axe")}" value="${existing?.includeKeywords || ""}" />
                    <p class="dialog-hint">${t("WITCHER.Sheet.Actor.Merchant.Hint.IncludeKeywords", "Item name must match at least one. Leave blank to include all.")}</p></div>
                <div class="form-group"><label>${t("WITCHER.Sheet.Actor.Merchant.Label.ExcludeKeywords", "Exclude keywords (comma-separated):")}</label><input type="text" name="exclude" placeholder="${t("WITCHER.Sheet.Actor.Merchant.Text.EGBrokenRusted", "e.g. broken, rusted")}" value="${existing?.excludeKeywords || ""}" />
                    <p class="dialog-hint">${t("WITCHER.Sheet.Actor.Merchant.Hint.ExcludeKeywords", "Item name must NOT match any. Leave blank for no exclusions.")}</p></div>
            </form>`;

        const result = await DialogV2.wait({
            window: { title: existing ? t("WITCHER.Sheet.Actor.Merchant.Dialog.EditCompendiumSource", "Edit Compendium Source") : t("WITCHER.Sheet.Actor.Merchant.Dialog.AddCompendiumSource", "Add Compendium Source") },
            content,
            buttons: [
                {
                    action: "ok", label: existing ? t("WITCHER.Common.Save", "Save") : "Add", default: true,
                    callback: (e, button) => {
                        const form = button.form;
                        const folderPaths = Array.from(form.querySelectorAll(".folder-check:checked")).map(c => c.dataset.path).filter(Boolean);
                        return { packId: form.elements.pack.value, folderPaths, includeKeywords: form.elements.include.value.trim(), excludeKeywords: form.elements.exclude.value.trim() };
                    }
                },
                { action: "cancel", label: t("WITCHER.Common.Cancel", "Cancel") }
            ],
            modal: true, rejectClose: false,
            render: (e, dialog) => {
                const root = dialog.element || dialog;
                const packSel = root.querySelector(".pack-select");
                const folderContainer = root.querySelector(".folder-picker");
                packSel?.addEventListener("change", () => { folderContainer.innerHTML = buildFolderTree(packSel.value); wireFolders(folderContainer); });
                wireFolders(folderContainer);
            }
        }).catch(() => null);

        if (!result?.packId) return;
        const pack = game.packs.get(result.packId);
        const sourceData = {
            packId:          result.packId,
            packLabel:       pack?.metadata.label || result.packId,
            folderPaths:     result.folderPaths || [],
            includeKeywords: result.includeKeywords || "",
            excludeKeywords: result.excludeKeywords || "",
            enabled:         true,
            weight:          existing?.weight ?? 0
        };
        if (existing !== null && existingIndex !== null) {
            sources[existingIndex] = sourceData;
        } else {
            sources.push(sourceData);
            redistributeSources(sources);
        }
        await this.actor.update({ "system.stocking.sources": sources });
    }

    /* ── Stocking: presets (per-merchant) ─────────────────── */

    static async _onSavePreset(event, target) {
        await this._flushForm();
        const name = await DialogV2.prompt({
            window: { title: t("WITCHER.Dialog.Merchant.SavePreset", "Save Stocking Preset") },
            content: `<form><div class="form-group"><label>${t("WITCHER.Sheet.Actor.Merchant.Text.PresetName", "Preset name:")}</label><input type="text" name="name" placeholder="${t("WITCHER.Sheet.Actor.Merchant.Text.EGFrontierBlacksmith", "e.g. Frontier Blacksmith")}" autofocus /></div></form>`,
            ok: { label: t("WITCHER.Common.Save", "Save"), callback: (e, button) => button.form.elements.name.value.trim() },
            modal: true, rejectClose: false
        }).catch(() => null);
        if (!name) return;

        const s = this.actor.system.stocking;
        const presets = foundry.utils.duplicate(s.presets ?? []);
        presets.push({
            id: foundry.utils.randomID(),
            name,
            createdAt: Date.now(),
            createdBy: game.user.name,
            config: {
                sources:          foundry.utils.duplicate(s.sources ?? []),
                totalMode:        s.totalMode,
                totalFixed:       s.totalFixed,
                totalRandomMin:   s.totalRandomMin,
                totalRandomMax:   s.totalRandomMax,
                allowStacks:      s.allowStacks,
                maxStack:         s.maxStack,
                stackChance:      s.stackChance,
                rarityEnabled:    foundry.utils.duplicate(s.rarityEnabled ?? {}),
                useRarityWeights: s.useRarityWeights,
                rarityWeights:    foundry.utils.duplicate(s.rarityWeights ?? {})
            }
        });
        await this.actor.update({ "system.stocking.presets": presets });
        this.render(false);
        ui.notifications.info(tFormat("WITCHER.Notify.Merchant.PresetSaved", { name: name }, "Saved preset \"{name}\"."));
    }

    static async _onLoadPreset(event, target) {
        const preset = (this.actor.system.stocking?.presets ?? []).find(p => p.id === target.dataset.presetId);
        if (!preset) return;
        const ok = await DialogV2.confirm({
            window: { title: t("WITCHER.Dialog.Merchant.LoadPreset", "Load Preset") },
            content: `<p>${t("WITCHER.Sheet.Actor.Merchant.Text.LoadPreset", "Load preset")} <strong>${preset.name}</strong> into this merchant?</p><p style="opacity:0.7;font-size:0.85rem;">${t("WITCHER.Sheet.Actor.Merchant.Text.ThisOverwritesTheCurrentStockingConfigur", "This overwrites the current stocking configuration.")}</p>`,
            modal: true, rejectClose: false
        });
        if (!ok) return;
        const updates = {};
        for (const [k, v] of Object.entries(preset.config)) updates[`system.stocking.${k}`] = v;
        await this.actor.update(updates);
        this.render(false);
        ui.notifications.info(tFormat("WITCHER.Notify.Merchant.PresetLoaded", { name: preset.name }, "Loaded preset \"{name}\"."));
    }

    static async _onDeletePreset(event, target) {
        const presets = foundry.utils.duplicate(this.actor.system.stocking?.presets ?? []);
        const idx = presets.findIndex(p => p.id === target.dataset.presetId);
        if (idx === -1) return;
        const ok = await DialogV2.confirm({
            window: { title: t("WITCHER.Dialog.Merchant.DeletePreset", "Delete Preset") },
            content: `<p>${t("WITCHER.Sheet.Actor.Merchant.Text.DeletePreset", "Delete preset")} <strong>${presets[idx].name}</strong>?</p>`,
            modal: true, rejectClose: false
        });
        if (!ok) return;
        presets.splice(idx, 1);
        await this.actor.update({ "system.stocking.presets": presets });
        this.render(false);
    }

    /* ── Stocking: item pool ──────────────────────────────── */

    static async _onSaveItemPool(event, target) {
        const items = this.actor.items.map(i => i.toObject());
        if (items.length === 0) return ui.notifications.warn(t("WITCHER.Notify.Merchant.NoItemsToSave", "No items in inventory to save. Drop items onto Inventory first."));
        await this.actor.update({ "system.itemPool": items });
        ui.notifications.info(tFormat("WITCHER.Notify.Merchant.PoolSaved", { n: items.length }, "Saved {n} items as the item pool."));
    }

    static async _onClearItemPool(event, target) {
        const ok = await DialogV2.confirm({
            window: { title: t("WITCHER.Dialog.Merchant.ClearPool", "Clear Item Pool") },
            content: `<p>${t("WITCHER.Sheet.Actor.Merchant.Text.ClearPoolConfirm", "Clear the saved item pool? This won't affect current inventory.")}</p>`,
            modal: true, rejectClose: false
        });
        if (!ok) return;
        await this.actor.update({ "system.itemPool": [] });
        ui.notifications.info(t("WITCHER.Notify.Merchant.PoolCleared", "Item pool cleared."));
    }
}
