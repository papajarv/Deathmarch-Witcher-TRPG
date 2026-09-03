/**
 * WitcherLootSheet — shared loot pile actor sheet.
 *
 * A loot actor is a passive container the GM populates with items and
 * currency for the party. Any player who can see the sheet (Observer
 * or higher) can click Take on a row to move that item / coin stack
 * to their assigned character. Transfers route through the GM socket
 * proxy so no per-player permission relaxation is needed.
 *
 * Layout:
 *  - Banner: portrait + name + weight/count summary
 *  - Currency: 6 coin rows, per-coin Take with quantity picker
 *  - Items:   list of top-level items, per-item Take with quantity picker
 *  - Bulk:    "Take everything" (per player) + "Empty pile" (GM only)
 *  - Notes
 *
 * Hook name: `renderWitcherLootSheet`.
 */

import { WitcherActorSheet } from "./base.mjs";
import { t, tFormat } from "../../chrome/lib/i18n.js";
import {
    emitGiftItem,
    emitTransferLootCurrency,
    emitTakeAllLoot
} from "../../setup/socketHook.mjs";

const SYSTEM_ID  = "witcher-ttrpg-death-march";
const DialogV2   = foundry.applications.api.DialogV2;
const COIN_KEYS  = ["crown", "oren", "bizant", "ducat", "lintar", "floren"];

/* Normalized stack signature for LOOT-actor stacking.
 * Same shape as WitcherActor.stackSignature (name + type + img + system
 * minus quantity/placement + effects minus per-copy ids) BUT ALSO strips
 * fields that get auto-stamped after `createItem` fires:
 *   - freshness.anchorTime — stampFreshnessAnchor writes worldTime the
 *     moment food lands on any actor, so the on-actor sig would diverge
 *     from the incoming compendium sig on every subsequent drop.
 * Two items merge only when these fields match; per-instance mutations
 * that the user didn't author don't gate stacking. */
function lootStackSignature(itemOrData) {
    if (!itemOrData) return "";
    const o = itemOrData.toObject ? itemOrData.toObject() : foundry.utils.deepClone(itemOrData);
    const sys = o.system ?? {};
    delete sys.quantity;
    delete sys.isStored;
    delete sys.equipped;
    if (sys.freshness) delete sys.freshness.anchorTime;
    const effects = (o.effects ?? []).map(e => {
        const c = { ...e };
        delete c._id;
        delete c.origin;
        return c;
    });
    return JSON.stringify({ name: o.name, type: o.type, img: o.img, system: sys, effects });
}


const COIN_LABEL = {
    crown:  "WITCHER.Sheet.Loot.Text.Crown",
    oren:   "WITCHER.Sheet.Loot.Text.Oren",
    bizant: "WITCHER.Sheet.Loot.Text.Bizant",
    ducat:  "WITCHER.Sheet.Loot.Text.Ducat",
    lintar: "WITCHER.Sheet.Loot.Text.Lintar",
    floren: "WITCHER.Sheet.Loot.Text.Floren"
};

export class WitcherLootSheet extends WitcherActorSheet {

    static DEFAULT_OPTIONS = {
        classes: [...WitcherActorSheet.DEFAULT_OPTIONS.classes, "loot"],
        position: { width: 560, height: 640 },
        actions: {
            takeLootItem:  WitcherLootSheet._onTakeLootItem,
            takeLootCoin:  WitcherLootSheet._onTakeLootCoin,
            takeAllLoot:   WitcherLootSheet._onTakeAllLoot,
            emptyLootPile: WitcherLootSheet._onEmptyLootPile
        }
    };

    static PARTS = {
        main: {
            template: "systems/witcher-ttrpg-death-march/templates/actor/loot/main.hbs",
            scrollable: [""]
        }
    };

    /* Hook ids for the actor-change auto-refresh listeners. Registered in
     * _onFirstRender, torn down in close(). Needed because the mutations
     * for takeAllLoot / emptyLootPile can originate from a socket handler
     * on the GM client — the player's sheet is downstream of that write
     * and needs to re-render when the doc sync arrives. Also catches
     * dropped items so the list updates immediately. */
    _lootHookIds = null;

    /* Currency inputs accept either a bare integer OR a dice expression
     * (e.g. `2d10`, `3d6+5`). A leading `+` or `-` folds the roll into the
     * current stack; no prefix replaces it. The roll is posted to chat so
     * players see the outcome. Non-currency fields fall through to base. */
    _onChangeForm(formConfig, event) {
        const el = event.target;
        const name = el?.name || "";
        if (name.startsWith("system.currency.")) {
            const raw = String(el.value ?? "").trim();
            if (raw && /d/i.test(raw)) {
                event.preventDefault();
                event.stopPropagation?.();
                this._rollAndSetCurrency(el, name, raw).catch(err => {
                    console.warn(`${SYSTEM_ID} | currency dice roll failed`, err);
                    ui.notifications?.error(tFormat("WITCHER.Notify.Loot.BadDice", { raw: raw }, "Couldn't parse \"{raw}\" as a dice expression."));
                });
                return;
            }
        }
        return super._onChangeForm(formConfig, event);
    }

    async _rollAndSetCurrency(inputEl, fieldName, expression) {
        let op = "set";
        let expr = expression;
        if (expr.startsWith("+")) { op = "add"; expr = expr.slice(1).trim(); }
        else if (expr.startsWith("-")) { op = "sub"; expr = expr.slice(1).trim(); }
        if (!expr) throw new Error("empty expression");

        const roll = await new Roll(expr).evaluate();
        const rolled = Math.max(0, Math.floor(Number(roll.total) || 0));

        const coinKey = fieldName.split(".").pop();
        const current = Number(this.actor.system?.currency?.[coinKey]) || 0;
        let next = rolled;
        if (op === "add") next = current + rolled;
        else if (op === "sub") next = Math.max(0, current - rolled);

        const opTag = op === "add" ? " (+)" : op === "sub" ? " (-)" : "";
        const flavor = `<div class="wdm-loot-currency-roll"><strong>${this.actor.name}</strong>: `
            + `${expression} → <strong>${rolled}</strong>${opTag} → `
            + `<strong>${next} ${coinKey}${next === 1 ? "" : "s"}</strong></div>`;
        await roll.toMessage({
            speaker: ChatMessage.getSpeaker({ actor: this.actor }),
            flavor
        });

        // Reflect the numeric outcome and commit via update() so the schema's
        // NumberField never sees the raw dice string.
        inputEl.value = String(next);
        await this.actor.update({ [`system.currency.${coinKey}`]: next });
    }

    async _onFirstRender(context, options) {
        await super._onFirstRender?.(context, options);
        if (this._lootHookIds) return;
        const actorId  = this.actor?.id;
        const rerender = (doc) => {
            const owner = doc?.parent ?? doc;
            if (owner?.id !== actorId) return;
            try { this.render(false); } catch (_) { /* sheet may already be closing */ }
        };
        this._lootHookIds = [];
        for (const name of ["updateActor", "createItem", "updateItem", "deleteItem"]) {
            const id = Hooks.on(name, rerender);
            this._lootHookIds.push({ name, id });
        }
    }

    async close(options) {
        if (this._lootHookIds) {
            for (const h of this._lootHookIds) Hooks.off(h.name, h.id);
            this._lootHookIds = null;
        }
        return super.close(options);
    }

    /* Loot-specific drop handler.
     *
     * The base sheet's `_onDropItem` runs `findStackTarget(data)` which
     * excludes `i.id === data._id`. When a compendium item is dropped and
     * Foundry preserves the compendium _id on the freshly-created embedded
     * doc, the on-actor item shares the incoming data._id and gets
     * filtered OUT of the stack search — so the 2nd identical drop can't
     * find its predecessor and creates a dupe. Only the 3rd drop matches
     * (the 2nd dupe had a regenerated id).
     *
     * Loot piles also don't need combat-action gating or special-type
     * routing (profession/perk/race/etc.), so bypass the base sheet
     * entirely and use a simple name+type+img stack policy. */
    async _onDropItem(event, item) {
        const sameActor = item?.parent?.id === this.actor.id;
        if (sameActor) return super._onDropItem(event, item);
        return this._addLootPileItem(item);
    }

    async _addLootPileItem(item) {
        /* Containers: recursively clone the whole subtree so the pile
         * remembers what's inside. Without this, dropping a full satchel
         * onto a loot actor plants just the satchel item and drops every
         * ref — looters open the bag on the other side to find it empty.
         * Container quantity is capped at 1 by a system-wide preUpdate
         * invariant, so container stacking is NOT attempted on loot piles
         * either — each dropped container gets its own row. */
        if (item?.type === "container") {
            return this._addLootPileContainerTree(item);
        }
        /* Normalize the incoming shape — v14 sheet dispatches `_onDropItem`
         * sometimes with an Item document, sometimes with raw JSON payload
         * (compendium drops occasionally serialize before the dispatch).
         * `toObject` covers documents; the deepClone covers raw JSON. */
        const rawData  = item?.toObject?.() ?? foundry.utils.deepClone(item);
        const incoming = Math.max(1, Number(rawData.system?.quantity) || 1);
        /* Clean placement flags on the seed BEFORE the stack search so
         * the resulting item can be matched by the next identical drop.
         * `isStored`/`equipped` from a PC-source drag would otherwise
         * poison the search (the signature reads system data). */
        rawData.system = {
            ...(rawData.system ?? {}),
            isStored: false,
            equipped: false
        };
        /* Loot-actor stack policy — deliberately WIDER than the character
         * sheet's `WitcherActor.addItem`:
         *   - weapons/armor stack when name+type+img+state match (same
         *     source, same reliability, same enhancements). The character
         *     path excludes them because equip state / hands / oils are
         *     per-instance — loot piles have none of that.
         *   - foods stack even when their per-instance `freshness.anchorTime`
         *     diverges (stampFreshnessAnchor runs post-createItem on the
         *     landed copy, so the on-actor sig would otherwise differ from
         *     the incoming compendium sig on every second drop). The
         *     older-lands anchor wins by virtue of `target.update`.
         *   - identical-charge foods stack; different current/max charges
         *     don't (the signature includes `system.charges`). */
        const target = this._findLootStackTarget(rawData);
        if (target) {
            const cur = Number(target.system?.quantity) || 1;
            await target.update({ "system.quantity": cur + incoming });
            return [target];
        }
        delete rawData._id;
        rawData.system.quantity = incoming;
        const created = await this.actor.createEmbeddedDocuments("Item", [rawData]);
        return created;
    }

    /* Search the loot pile for a stackable predecessor of `data`.
     * Returns the matching on-actor Item, or null. Excluded from stacking:
     *  - stored / equipped items (would poison in-container inventories)
     *  - different `type`
     *  - containers (system quantity invariant is 1 — stacking would
     *    silently swallow additional drops) */
    _findLootStackTarget(data) {
        if (data?.type === "container") return null;
        const sig = lootStackSignature(data);
        return this.actor.items.find(i => {
            if (i.type !== data.type) return false;
            if (i.system?.isStored) return false;
            if (i.system?.equipped) return false;
            return lootStackSignature(i) === sig;
        }) ?? null;
    }

    /* Clone a container + everything nested inside it onto this loot pile.
     * Mirrors the giftContainerTree pattern in setup/socketHook.mjs: snapshot
     * each container's content array on the source BEFORE creation (the
     * preCreateItem hook wipes it on the fresh copy), batch-create the
     * subtree on the loot actor, then rewrite each new container's content
     * to point at the sibling UUIDs on this actor. Source is left alone —
     * dropping onto loot is a COPY, not a move. */
    async _addLootPileContainerTree(rootContainer) {
        const sourceActor = rootContainer.parent;
        /* Compendium / world drops: no parent actor to walk content on.
         * Just clone the container itself as a simple non-stack item. */
        if (!sourceActor?.items) {
            const data = rootContainer.toObject();
            delete data._id;
            data.system = { ...(data.system ?? {}), isStored: false, equipped: false };
            return this.actor.createEmbeddedDocuments("Item", [data]);
        }

        /* DFS collect: root + every embedded item referenced through
         * nested containers. Skips refs that don't resolve on the source
         * (stale UUIDs from prior moves). */
        const seen = new Set();
        const subtree = [];
        const walk = (it) => {
            if (!it || seen.has(it.id)) return;
            seen.add(it.id);
            subtree.push(it);
            if (it.type !== "container") return;
            for (const ref of it.system?.content ?? []) {
                const child = sourceActor.items.find(i => i.uuid === ref || i.id === ref);
                if (child) walk(child);
            }
        };
        walk(rootContainer);

        /* Snapshot content BY SOURCE ID so batch-return ordering can't
         * misalign us. Same reasoning as socketHook.mjs's gift path. */
        const contentBySrcId = new Map();
        for (const it of subtree) {
            if (it.type !== "container") continue;
            contentBySrcId.set(it.id, (it.system?.content ?? []).slice());
        }

        const FLAG_MOD = "witcher-ttrpg-death-march";
        const FLAG_KEY = "giftSrcId";
        const protos = subtree.map((it, idx) => {
            const p = it.toObject();
            delete p._id;
            p.flags = p.flags ?? {};
            p.flags[FLAG_MOD] = { ...(p.flags[FLAG_MOD] ?? {}), [FLAG_KEY]: it.id };
            /* Root is loose in the pile; children keep the source's isStored
             * so they surface INSIDE the container, not on the pile's grid. */
            if (idx === 0) {
                p.system = { ...(p.system ?? {}), isStored: false, equipped: false };
            }
            return p;
        });

        let created;
        try {
            created = await this.actor.createEmbeddedDocuments("Item", protos);
        } catch (err) {
            console.error("witcher-ttrpg-death-march | loot container drop create failed", err);
            ui.notifications?.error(tFormat("WITCHER.Notify.Loot.DropFailed", { msg: err?.message ?? err }, "Loot drop failed: {msg}"));
            return [];
        }
        if (!created || created.length !== subtree.length) {
            ui.notifications?.error(tFormat("WITCHER.Notify.Loot.DropPartial", { landed: created?.length ?? 0, total: subtree.length }, "Loot drop partial: {landed}/{total} items landed."));
            if (Array.isArray(created) && created.length) {
                try { await this.actor.deleteEmbeddedDocuments("Item", created.map(c => c.id)); }
                catch (rbErr) { console.warn("loot drop rollback failed", rbErr); }
            }
            return [];
        }

        /* Build refs deterministically from actor uuid + item id. `newItem.uuid`
         * is a getter and has surfaced intermittent mid-flow inconsistencies —
         * see the note in socketHook.mjs's giftContainerTree for detail. */
        const targetUuidOf = (id) => `${this.actor.uuid}.Item.${id}`;
        const newIdByOldRef = new Map();
        const oldIdByNewId  = new Map();
        for (const newItem of created) {
            if (!newItem?.id) {
                console.error("witcher-ttrpg-death-march | loot drop: created item missing id — abort rewrite");
                ui.notifications?.error(tFormat("WITCHER.Notify.Loot.DropIdMissing", { actor: this.actor.name }, "Loot drop failed on {actor}: internal id missing (see console)."));
                return [];
            }
            const srcId = newItem.getFlag?.(FLAG_MOD, FLAG_KEY);
            if (!srcId) continue;
            const oldItem = subtree.find(it => it.id === srcId);
            if (!oldItem) continue;
            newIdByOldRef.set(oldItem.uuid, newItem.id);
            newIdByOldRef.set(oldItem.id,   newItem.id);
            oldIdByNewId.set(newItem.id, oldItem.id);
        }

        for (const newItem of created) {
            if (newItem.type !== "container") continue;
            const srcId = oldIdByNewId.get(newItem.id);
            if (!srcId) continue;
            const orig = contentBySrcId.get(srcId);
            if (!orig || !orig.length) continue;
            const newIds = orig.map(ref => newIdByOldRef.get(ref)).filter(Boolean);
            if (!newIds.length) continue;
            const newContent = newIds.map(targetUuidOf);
            try {
                await newItem.update({ "system.content": newContent });
            } catch (err) {
                console.error("witcher-ttrpg-death-march | loot content rewrite failed", err);
                ui.notifications?.error(tFormat("WITCHER.Notify.Loot.DropLinkFailed", { item: newItem.name }, "Loot drop: '{item}' failed to link contents (see console)."));
                continue;
            }
            /* Verify from held ref AND from Collection lookup — v14 has
             * shown them briefly diverge just after an embedded update. */
            const liveByRef  = Array.isArray(newItem?.system?.content) ? newItem.system.content : [];
            const liveByGet  = this.actor.items.get(newItem.id);
            const liveByColl = Array.isArray(liveByGet?.system?.content) ? liveByGet.system.content : [];
            const wroteLen   = Math.max(liveByRef.length, liveByColl.length);
            if (wroteLen !== newContent.length) {
                console.error(
                    `witcher-ttrpg-death-march | loot content rewrite dropped refs on ${newItem.name} (type=${newItem.type}, id=${newItem.id})`
                    + ` — wanted ${newContent.length}, saved ${wroteLen}.`
                    + ` newContent=${JSON.stringify(newContent)}`
                    + ` sourceContent=${JSON.stringify(orig)}`
                );
            }
            /* Assert isStored=true on every child ref — same rationale as the
             * gift path: source flag preservation via toObject isn't enough
             * when a preCreate hook or schema default flips it back. */
            for (const childId of newIds) {
                const child = this.actor.items.get(childId);
                if (child && child.system?.isStored !== true) {
                    try { await child.update({ "system.isStored": true }); }
                    catch (err) { console.warn("witcher-ttrpg-death-march | loot child isStored assert failed", err); }
                }
            }
        }
        /* Tear down the temp giftSrcId flag on all created items so it
         * doesn't linger on the loot pile between drops. */
        for (const newItem of created) {
            try { await newItem.unsetFlag?.(FLAG_MOD, FLAG_KEY); }
            catch (err) { /* ignore — cosmetic cleanup */ }
        }

        return created;
    }

    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);

        const isGM    = !!game.user?.isGM;
        const pc      = game.user?.character ?? null;
        const canTake = !!pc;
        const takeTooltip = canTake
            ? `Send to ${pc.name}'s inventory.`
            : "Assign a character to your user before taking loot.";

        /* Top-level items only — items inside containers are visible via
         * the container itself, and taking the container carries its
         * subtree via giftContainerTree. */
        const topItems = (this.actor.items?.contents ?? [])
            .filter(i => i && !i.system?.isStored);

        ctx.lootRows = topItems
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(item => ({
                id:       item.id,
                name:     item.name,
                img:      item.img || "icons/svg/item-bag.svg",
                quantity: Math.max(1, Number(item.system?.quantity) || 1),
                isContainer: item.type === "container"
            }));

        /* Total weight — item.weight * quantity for every top-level row,
         * plus storedWeight for containers (their derived rollup of nested
         * contents), plus loose coin weight (0.0025 kg / coin). Mirrors
         * the encumbrance sum on WitcherActor. */
        let totalWeight = 0;
        for (const item of topItems) {
            const w = Number(item.system?.weight) || 0;
            const q = Math.max(1, Number(item.system?.quantity) || 1);
            const stored = item.type === "container"
                ? (Number(item.system?.storedWeight) || 0)
                : 0;
            totalWeight += w * q + stored;
        }
        try {
            const coinW = typeof this.actor.system?.calcCurrencyWeight === "function"
                ? Number(this.actor.system.calcCurrencyWeight()) || 0
                : 0;
            totalWeight += coinW;
        } catch (_) { /* older data models w/o calcCurrencyWeight — ignore */ }
        ctx.totalWeight     = totalWeight;
        ctx.totalWeightText = totalWeight > 0
            ? `${Math.round(totalWeight * 100) / 100} kg`
            : "0 kg";
        ctx.itemCount       = topItems.length;

        const cur = this.actor.system?.currency ?? {};
        ctx.coinRows = COIN_KEYS.map(k => ({
            key:   k,
            label: COIN_LABEL[k],
            value: Math.max(0, Number(cur[k]) || 0)
        }));
        ctx.hasAnyCoins = ctx.coinRows.some(r => r.value > 0);
        ctx.hasAnyLoot  = ctx.itemCount > 0 || ctx.hasAnyCoins;

        ctx.isGM        = isGM;
        ctx.canTake     = canTake;
        ctx.takeTooltip = takeTooltip;
        return ctx;
    }

    /* Small quantity picker used by all per-row Takes. Returns the
     * clamped integer the user chose, or null if they cancelled. */
    static async _askQuantity({ title, prompt, max, defaultQty }) {
        const cap = Math.max(1, Math.floor(Number(max) || 1));
        const initial = Math.max(1, Math.min(cap, Math.floor(Number(defaultQty ?? cap) || cap)));
        const content = `
            <form class="wdm-loot-qty-form">
                <p style="opacity:0.75;font-size:0.85rem;margin:0 0 0.4rem 0;">${prompt}</p>
                <div class="form-group" style="display:flex;align-items:center;gap:0.5rem;">
                    <input type="range" name="qtyRange" min="1" max="${cap}" step="1" value="${initial}" style="flex:1;"/>
                    <input type="number" name="qty" min="1" max="${cap}" step="1" value="${initial}" style="width:5.5rem;" autofocus/>
                </div>
                <p style="opacity:0.6;font-size:0.75rem;margin:0.3rem 0 0 0;">Available: ${cap}</p>
            </form>`;
        try {
            const val = await DialogV2.wait({
                window: { title },
                content,
                buttons: [
                    { action: "ok", label: t("WITCHER.Sheet.Actor.Loot.Dialog.Button.Take", "Take"), default: true, callback: (e, button) => {
                        const v = Number(button.form?.elements?.qty?.value) || initial;
                        return Math.max(1, Math.min(cap, Math.floor(v)));
                    }},
                    { action: "cancel", label: t("WITCHER.Common.Cancel", "Cancel"), callback: () => null }
                ],
                modal: true, rejectClose: false,
                render: (e, dialog) => {
                    const root = dialog.element || dialog;
                    const range = root.querySelector?.('input[name="qtyRange"]');
                    const num   = root.querySelector?.('input[name="qty"]');
                    if (range && num) {
                        range.addEventListener("input", () => { num.value = range.value; });
                        num.addEventListener("input",   () => { range.value = num.value; });
                    }
                }
            });
            return typeof val === "number" && val > 0 ? val : null;
        } catch (_) {
            return null;
        }
    }

    static async _onTakeLootItem(event, target) {
        event.preventDefault();
        event.stopPropagation();
        if (target?.dataset?.busy) return;
        target.dataset.busy = "1";
        try {
            const itemId = target?.dataset?.itemId;
            if (!itemId) return;
            const item = this.actor.items?.get?.(itemId);
            if (!item) {
                ui.notifications?.warn?.(t("WITCHER.Sheet.Actor.Loot.Notify.ItemGone", "That item is no longer on the pile."));
                return;
            }
            const recipient = game.user?.character ?? null;
            if (!recipient) {
                ui.notifications?.warn?.(t("WITCHER.Sheet.Actor.Loot.Notify.NoCharacterLoot", "Assign a character to your user before taking loot."));
                return;
            }
            const stackQty = Math.max(1, Number(item.system?.quantity) || 1);
            let qty = stackQty;
            /* Containers gift their whole subtree — no partial split. */
            if (stackQty > 1 && item.type !== "container") {
                qty = await WitcherLootSheet._askQuantity({
                    title: tFormat("WITCHER.Dialog.Loot.TakeItem", { item: item.name }, "Take {item}"),
                    prompt: t("WITCHER.Sheet.Actor.Loot.Text.HowManyItem", "How many to take?"),
                    max: stackQty,
                    defaultQty: stackQty
                });
                if (!qty) return;
            }
            await emitGiftItem({
                sourceActorUuid: this.actor.uuid,
                targetActorUuid: recipient.uuid,
                itemId,
                quantity: qty,
                fromUserId: game.user?.id ?? null
            });
            ui.notifications?.info?.(tFormat(
                "WITCHER.Sheet.Actor.Loot.Notify.TookItem",
                { recipient: recipient.name, item: item.name, qty: qty > 1 ? ` ×${qty}` : "" },
                "{recipient} took {item}{qty}."
            ));
        } catch (err) {
            console.warn(`${SYSTEM_ID} | loot take failed`, err);
            ui.notifications?.error?.(t("WITCHER.Sheet.Actor.Loot.Notify.TakeItemFailed", "Failed to take item — see console."));
        } finally {
            delete target.dataset.busy;
        }
    }

    static async _onTakeLootCoin(event, target) {
        event.preventDefault();
        event.stopPropagation();
        if (target?.dataset?.busy) return;
        target.dataset.busy = "1";
        try {
            const coin = target?.dataset?.coin;
            if (!COIN_KEYS.includes(coin)) return;
            const available = Math.max(0, Number(this.actor.system?.currency?.[coin]) || 0);
            if (available <= 0) return;
            const recipient = game.user?.character ?? null;
            if (!recipient) {
                ui.notifications?.warn?.(t("WITCHER.Sheet.Actor.Loot.Notify.NoCharacterCoins", "Assign a character to your user before taking coins."));
                return;
            }
            const qty = await WitcherLootSheet._askQuantity({
                title: tFormat("WITCHER.Dialog.Loot.TakeCoin", { coin: coin }, "Take {coin}"),
                prompt: tFormat("WITCHER.Sheet.Actor.Loot.Text.HowManyCoin", { coin }, "How many {coin} to take?"),
                max: available,
                defaultQty: available
            });
            if (!qty) return;
            await emitTransferLootCurrency({
                sourceActorUuid: this.actor.uuid,
                targetActorUuid: recipient.uuid,
                coin,
                quantity: qty,
                fromUserId: game.user?.id ?? null
            });
            ui.notifications?.info?.(tFormat("WITCHER.Sheet.Actor.Loot.Notify.TookCoin", { recipient: recipient.name, qty, coin }, "{recipient} took {qty} {coin}."));
        } catch (err) {
            console.warn(`${SYSTEM_ID} | loot coin take failed`, err);
            ui.notifications?.error?.(t("WITCHER.Sheet.Actor.Loot.Notify.TakeCoinsFailed", "Failed to take coins — see console."));
        } finally {
            delete target.dataset.busy;
        }
    }

    static async _onTakeAllLoot(event, target) {
        event.preventDefault();
        event.stopPropagation();
        if (target?.dataset?.busy) return;
        target.dataset.busy = "1";
        try {
            const recipient = game.user?.character ?? null;
            if (!recipient) {
                ui.notifications?.warn?.(t("WITCHER.Sheet.Actor.Loot.Notify.NoCharacterLoot", "Assign a character to your user before taking loot."));
                return;
            }
            const ok = await DialogV2.confirm({
                window: { title: t("WITCHER.Dialog.Loot.TakeEverything", "Take everything?") },
                content: `<p>${t("WITCHER.Sheet.Actor.Loot.Text.SendEveryItemAndCoinFrom", "Send every item and coin from")} <strong>${this.actor.name}</strong> to <strong>${recipient.name}</strong>?</p>`,
                modal: true, rejectClose: false
            });
            if (!ok) return;
            await emitTakeAllLoot({
                sourceActorUuid: this.actor.uuid,
                targetActorUuid: recipient.uuid,
                fromUserId: game.user?.id ?? null
            });
            ui.notifications?.info?.(tFormat("WITCHER.Sheet.Actor.Loot.Notify.TookEverything", { recipient: recipient.name, source: this.actor.name }, "{recipient} took everything from {source}."));
        } catch (err) {
            console.warn(`${SYSTEM_ID} | take all loot failed`, err);
            ui.notifications?.error?.(t("WITCHER.Sheet.Actor.Loot.Notify.TakePileFailed", "Failed to take pile — see console."));
        } finally {
            delete target.dataset.busy;
        }
    }

    static async _onEmptyLootPile(event, target) {
        event.preventDefault();
        event.stopPropagation();
        if (!game.user?.isGM) return;
        if (target?.dataset?.busy) return;
        target.dataset.busy = "1";
        try {
            const ok = await DialogV2.confirm({
                window: { title: t("WITCHER.Dialog.Loot.EmptyPile", "Empty pile?") },
                content: `<p>${t("WITCHER.Sheet.Actor.Loot.Text.DeleteEveryItemAndResetAllCurrencyOn", "Delete every item and reset all currency on")} <strong>${this.actor.name}</strong>?</p>
                          <p style="opacity:0.7;">${t("WITCHER.Sheet.Actor.Loot.Text.ThisCannotBeUndone", "This cannot be undone.")}</p>`,
                modal: true, rejectClose: false
            });
            if (!ok) return;
            const ids = (this.actor.items?.contents ?? []).map(i => i.id);
            if (ids.length) {
                try { await this.actor.deleteEmbeddedDocuments("Item", ids); }
                catch (err) { console.warn(`${SYSTEM_ID} | empty loot: delete items failed`, err); }
            }
            const patch = {};
            for (const k of COIN_KEYS) patch[`system.currency.${k}`] = 0;
            try { await this.actor.update(patch); }
            catch (err) { console.warn(`${SYSTEM_ID} | empty loot: reset currency failed`, err); }
            ui.notifications?.info?.(tFormat("WITCHER.Sheet.Actor.Loot.Notify.PileEmptied", { actor: this.actor.name }, "{actor} emptied."));
            try { this.render(false); } catch (_) { /* sheet closed */ }
        } catch (err) {
            console.warn(`${SYSTEM_ID} | empty loot failed`, err);
            ui.notifications?.error?.(t("WITCHER.Sheet.Actor.Loot.Notify.EmptyPileFailed", "Failed to empty pile — see console."));
        } finally {
            delete target.dataset.busy;
        }
    }
}
