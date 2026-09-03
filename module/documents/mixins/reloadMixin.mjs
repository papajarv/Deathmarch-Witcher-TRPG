/**
 * reloadMixin — ammunition & reload behavior for ranged weapons.
 *
 * Composed onto WitcherItem; every method is a no-op unless the item is a
 * `weapon` with `requiresAmmo`. Models two RAW firing styles (Core weapon
 * tables / weapon-effects sidebar):
 *
 *   • Bows (reloadActions === 0): nock-and-loose. No chamber; each shot
 *     draws one round straight from the selected ammo at fire time.
 *   • Slow Reload (reloadActions >= 1, all crossbows): a chamber that must
 *     be filled by a reload action. `reload()` pulls rounds from ammo into
 *     `system.loaded`; firing spends a chambered round and is refused when
 *     the chamber is empty.
 *
 * Ammo eligibility depends on combat state (user spec 2026-07-02):
 *   • In combat: only ammo inside a WORN, equipped container counts —
 *     matches RAW's action-economy for drawing rounds mid-fight.
 *   • Out of combat: LOOSE ammo (in the actor's on-person inventory
 *     but not stored inside any container) is also eligible, alongside
 *     equipped-container ammo. Reflects the low-stakes preparation of
 *     stringing your crossbow between encounters.
 *
 * "Loose" means on the actor's Items and not referenced by any
 * container's `system.content`. Ammo inside a STOWED (isStored) container
 * is never eligible either way — you'd have to unpack it first.
 */

import { isActorInActiveCombat } from "../../chrome/lib/actor.js";
import { isCESubsystemEnabled } from "../../api/homebrew.mjs";

import { t, tFormat } from "../../chrome/lib/i18n.js";
export const reloadMixin = (Base) => class extends Base {

    /** This weapon fires loaded ammunition (bow / crossbow / etc.). */
    get usesAmmo() {
        return this.type === "weapon" && this.system?.requiresAmmo === true;
    }

    /** Actions to reload one chamber-load (0 for bows). */
    get reloadActions() {
        return this.usesAmmo ? Math.max(0, Number(this.system?.reloadActions) || 0) : 0;
    }

    /** Slow-reload weapons hold a chamber that must be filled by an action. */
    get hasChamber() {
        return this.usesAmmo && this.reloadActions >= 1;
    }

    /** Magazine size (rounds the weapon can hold). Default 1 = single chamber. */
    get magazineCapacity() {
        return Math.max(1, Number(this.system?.loaded?.capacity) || 1);
    }

    /** Combat-Extended magazine model in effect for THIS weapon: a chamber
     *  weapon whose magazine holds 2+, while the CE `magazineReload` subsystem is
     *  on. When true, loading the magazine and COCKING are separate operations
     *  and firing is gated on `armed`. Otherwise the classic load-and-cock
     *  reload applies (RAW, capacity-1, or CE off). */
    get usesMagazine() {
        return this.hasChamber && this.magazineCapacity >= 2 && isCESubsystemEnabled("magazineReload");
    }

    /** Repeating quality — under the magazine model, firing re-cocks the weapon
     *  from the magazine so you can fire through it without re-cocking. */
    get isRepeating() {
        const q = this.system?.effective?.qualities ?? this.system?.qualities ?? [];
        return Array.isArray(q) && q.includes("repeating");
    }

    /** Is the weapon COCKED and ready to loose? Under the magazine model this is
     *  the explicit `armed` flag; otherwise a loaded chamber is always ready. */
    get isArmed() {
        if (!this.usesMagazine) return this.getChamberRounds().length > 0;
        return !!this.system?.loaded?.armed && this.getChamberRounds().length > 0;
    }

    /** The ordered chamber STACK — one entry per chambered round, each with its
     *  own {uuid,name,img,appliedOil,sourceData}. FILO: index 0 = first loaded
     *  (last to fire); the last element = last loaded (NEXT to fire). Legacy
     *  documents (a `count` with scalar type but no rounds array) are expanded
     *  here on read into `count` identical copies, so old chambers keep working
     *  without a bulk data migration. Returns fresh copies (safe to mutate). */
    getChamberRounds() {
        const lo = this.system?.loaded ?? {};
        const rounds = Array.isArray(lo.rounds) ? lo.rounds : [];
        if (rounds.length) {
            return rounds.map(r => ({ ...r, appliedOil: { ...(r.appliedOil ?? {}) }, sourceData: r.sourceData ?? {} }));
        }
        const count = Number(lo.count) || 0;
        if (count <= 0) return [];
        const legacy = () => ({
            uuid: lo.uuid ?? "",
            name: lo.name ?? "",
            img:  lo.img  ?? "",
            appliedOil: {
                name:           lo.appliedOil?.name ?? "",
                oilTarget:      lo.appliedOil?.oilTarget ?? "",
                oilBonusDamage: Number(lo.appliedOil?.oilBonusDamage) || 0
            },
            sourceData: lo.sourceData ?? {}
        });
        return Array.from({ length: count }, legacy);
    }

    /** Build the `system.loaded` update for a new chamber stack: writes `rounds`
     *  AND mirrors the NEXT-TO-FIRE round (top of stack = last element) onto the
     *  scalar fields, so every reader that still consults `count`/`name`/`img`/
     *  `uuid`/`appliedOil` (attack flow, dock, inventory) stays correct. An empty
     *  stack clears the chamber. */
    _chamberUpdate(rounds, extra = {}) {
        const arr = Array.isArray(rounds) ? rounds : [];
        const top = arr.length ? arr[arr.length - 1] : null;
        return {
            "system.loaded.rounds": arr,
            "system.loaded.count":  arr.length,
            "system.loaded.uuid":   top?.uuid ?? "",
            "system.loaded.name":   top?.name ?? "",
            "system.loaded.img":    top?.img  ?? "",
            "system.loaded.appliedOil": {
                name:           top?.appliedOil?.name ?? "",
                oilTarget:      top?.appliedOil?.oilTarget ?? "",
                oilBonusDamage: Number(top?.appliedOil?.oilBonusDamage) || 0
            },
            ...extra
        };
    }

    /** Ready to fire? Bows are always ready (ammo is checked at fire time); a
     *  classic chamber is ready while it holds a round; a magazine crossbow is
     *  ready only while COCKED (armed) with a round in the magazine. */
    get isLoaded() {
        if (!this.hasChamber) return true;
        if (this.usesMagazine) return this.isArmed;
        return this.getChamberRounds().length > 0;
    }

    /** The ammo class this weapon fires ("arrow" / "bolt"). */
    get ammoType() {
        return this.usesAmmo ? (this.system?.ammoType || "arrow") : "";
    }

    /** Ammo the wielder may load: type "ammo", matching this weapon's
     *  ammoType (arrows in bows, bolts in crossbows), quantity > 0.
     *
     *  In combat: only ammo inside an equipped container counts.
     *  Out of combat: ALSO include loose ammo (on-person, not stored
     *  inside any container). See the file header for the rationale.
     *
     *  Returns [{ item, container, qty }] — `container` is null for
     *  loose ammo (callers use it to render a source label). */
    getEligibleAmmo() {
        const actor = this.actor;
        if (!actor) return [];
        const want = this.ammoType;
        const out = [];
        const seen = new Set();
        /* Monster shortcut: no equipped-container concept applies. Any ammo
         * item on the monster that matches this weapon's ammoType with a
         * positive stack is eligible — bandits don't wear quivers, and
         * dragging arrows onto a monster's Combat block is the whole point
         * of the per-weapon ammo section on the monster sheet. */
        if (actor.type === "monster") {
            for (const it of actor.items) {
                if (it.type !== "ammo" || seen.has(it.id)) continue;
                if ((it.system?.ammoType || "arrow") !== want) continue;
                if ((Number(it.system?.quantity) || 0) <= 0) continue;
                seen.add(it.id);
                out.push({ item: it, container: null, qty: Number(it.system?.quantity) || 0 });
            }
            return out;
        }
        /* Pass 1 — equipped-container ammo (always eligible). Two entry
         * points into "stored" — either the container's content array
         * references the ammo, OR the ammo carries `isStored: true`.
         * Both should agree in a well-formed inventory, but the
         * ammo-side flag alone is enough: it means the player has
         * treated the projectile as stashed (in a quiver / bandolier /
         * whatever), which is what "in an equipped container" means at
         * the combat-eligibility level. The redundancy also rescues
         * coated 1-qty spinoffs whose container-content sync ever
         * lags — the spinoff inherits `isStored: true` from its source
         * at creation, so it lands eligible immediately regardless of
         * how the content-array update settled. */
        const containerRefs = new Set();
        const containerByRef = new Map();
        for (const c of actor.items) {
            if (c.type !== "container" || c.system?.equipped !== true) continue;
            for (const ref of c.system?.content ?? []) {
                containerRefs.add(ref);
                containerByRef.set(ref, c);
                const it = (typeof fromUuidSync === "function") ? fromUuidSync(ref) : null;
                if (!it || it.type !== "ammo" || seen.has(it.id)) continue;
                if ((it.system?.ammoType || "arrow") !== want) continue;
                if ((Number(it.system?.quantity) || 0) <= 0) continue;
                seen.add(it.id);
                out.push({ item: it, container: c, qty: Number(it.system?.quantity) || 0 });
            }
        }
        /* Pass 1b — actor-level ammo flagged `isStored: true` that isn't
         * (yet) referenced by any equipped container. The flag is the
         * fiction ("I put it in my quiver"); missing it from the content
         * list is a plumbing gap this pass papers over. Container label
         * falls back to whichever equipped container we can find (for
         * the picker's "×N · Belt Quiver" meta line), or a generic
         * "Stored" label. */
        for (const it of actor.items) {
            if (it.type !== "ammo" || seen.has(it.id)) continue;
            if (it.system?.isStored !== true) continue;
            if ((it.system?.ammoType || "arrow") !== want) continue;
            if ((Number(it.system?.quantity) || 0) <= 0) continue;
            seen.add(it.id);
            const c = containerByRef.get(it.uuid) ?? containerByRef.get(it.id) ?? null;
            out.push({ item: it, container: c, qty: Number(it.system?.quantity) || 0 });
        }
        /* Pass 2 — loose ammo on the actor (out of combat only). Loose
         * means: type=ammo, not marked isStored, and NOT referenced by
         * any container's content list (a stowed container's ammo is
         * still ineligible because the ammo is inside — we'd have to
         * unpack it first). We also collect refs from ALL containers,
         * not just equipped ones, so ammo inside a stowed pack isn't
         * accidentally re-added as "loose". */
        if (!isActorInActiveCombat(actor)) {
            /* Collect refs from every container to filter loose. */
            const anyContainerRefs = new Set(containerRefs);
            for (const c of actor.items) {
                if (c.type !== "container") continue;
                for (const ref of c.system?.content ?? []) anyContainerRefs.add(ref);
            }
            for (const it of actor.items) {
                if (it.type !== "ammo" || seen.has(it.id)) continue;
                if ((it.system?.ammoType || "arrow") !== want) continue;
                if ((Number(it.system?.quantity) || 0) <= 0) continue;
                if (it.system?.isStored === true) continue;
                if (anyContainerRefs.has(it.uuid) || anyContainerRefs.has(it.id)) continue;
                seen.add(it.id);
                out.push({ item: it, container: null, qty: Number(it.system?.quantity) || 0 });
            }
        }
        return out;
    }

    /** Resolve the chosen ammo id/uuid against the eligible set, or null. */
    #resolveAmmo(ammoId) {
        if (!ammoId) return null;
        return this.getEligibleAmmo().find(e => e.item.id === ammoId || e.item.uuid === ammoId)?.item ?? null;
    }

    /** The ammo currently selected/chambered (from `loaded.uuid`), falling
     *  back to the first eligible ammo. null when nothing is available. */
    getSelectedAmmo() {
        const eligible = this.getEligibleAmmo();
        const uuid = this.system?.loaded?.uuid;
        if (uuid) {
            const hit = eligible.find(e => e.item.uuid === uuid || e.item.id === uuid);
            if (hit) return hit.item;
        }
        return eligible[0]?.item ?? null;
    }

    /** Record which ammo this weapon draws, without chambering it. For bows
     *  this is the nocking preference; for slow weapons it sets what a
     *  later reload() will pull. */
    async selectAmmo(ammoId) {
        if (!this.usesAmmo) return;
        const ammo = this.#resolveAmmo(ammoId);
        return this.update({
            "system.loaded.uuid": ammo?.uuid ?? "",
            "system.loaded.name": ammo?.name ?? "",
            "system.loaded.img":  ammo?.img  ?? ""
        });
    }

    /** Feed ONE round into the magazine (up to capacity) WITHOUT cocking — the
     *  magazine-model "Load Magazine" operation. In active combat this costs
     *  ONE action per round (self-accounted here, so every surface — sheet,
     *  dock, context menu — is consistent); out of combat it's free. Snapshots
     *  the round's oil + source like reload() so a coated 1-qty stack deleted
     *  here comes back on unload. Does NOT touch `armed`. Returns the fed ammo,
     *  or undefined when nothing was fed. */
    async feedMagazine(ammoId = null, { silent = false } = {}) {
        if (!this.hasChamber) return;
        const rounds = this.getChamberRounds();
        if (rounds.length >= this.magazineCapacity) {
            if (!silent) ui.notifications?.warn(tFormat("WITCHER.Doc.ReloadMixin.Notify.MagazineFull", { this: this.name }, "{this}'s magazine is full."));
            return;
        }
        /* Feeding a bolt is an action in combat. Refuse up-front when the
         * wielder has no action slot left this turn — checked BEFORE consuming
         * ammo so a blocked feed doesn't decrement the stack. Out of combat the
         * economy is untracked, so it stays free. */
        const actor = this.actor;
        const chargeAction = !!actor?._inActiveCombat;
        if (chargeAction && actor.hasActionSlot === false) {
            if (!silent) ui.notifications?.warn(t("WITCHER.Notify.Dock.NoActions", "No actions left this turn."));
            return;
        }
        const ammo = ammoId ? this.#resolveAmmo(ammoId) : this.getSelectedAmmo();
        if (!ammo) {
            if (!silent) ui.notifications?.warn(t("WITCHER.Doc.ReloadMixin.Notify.NoAmmunitionInAnEquippedContainer", "No ammunition in an equipped container."));
            return;
        }
        const have = Number(ammo.system?.quantity) || 0;
        if (have <= 0) {
            if (!silent) ui.notifications?.warn(tFormat("WITCHER.Doc.ReloadMixin.Notify.XIsEmpty", { ammo: ammo.name }, "{ammo} is empty."));
            return;
        }
        const ammoAo = ammo.system?.appliedOil;
        const oilSnap = (ammoAo && ammoAo.name)
            ? { name: String(ammoAo.name), oilTarget: String(ammoAo.oilTarget || ""), oilBonusDamage: Number(ammoAo.oilBonusDamage) || 0 }
            : { name: "", oilTarget: "", oilBonusDamage: 0 };
        let sourceSnap = {};
        try { sourceSnap = ammo.toObject(false); } catch (_) { sourceSnap = {}; }
        const nextQty = have - 1;
        if (nextQty <= 0) { try { await ammo.delete(); } catch (_) { /* soft-fail */ } }
        else await ammo.update({ "system.quantity": nextQty });
        rounds.push({ uuid: ammo.uuid, name: ammo.name, img: ammo.img, appliedOil: oilSnap, sourceData: sourceSnap });
        await this.update(this._chamberUpdate(rounds));
        /* Burn the action only once a bolt has actually seated. markReloadAction
         * flags the turn (parity with cocking) so turn bookkeeping stays intact. */
        if (chargeAction) {
            try { await actor.spendActionSlot?.(tFormat("WITCHER.Sheet.Item.Base.LoadMagazine", { item: this.name }, "Load magazine: {item}")); }
            catch (_) { /* soft-fail: never block the feed on action bookkeeping */ }
            try { await actor.markReloadAction?.(); } catch (_) { /* soft-fail */ }
        }
        return ammo;
    }

    /** Take one reload action. Weapons that need several actions to reload
     *  (reloadActions > 1) bank progress here; only once enough actions have
     *  accumulated do rounds actually move from the ammo stack into the
     *  chamber. A reloadActions === 1 weapon chambers on the first call. The
     *  rounds leave the ammo stack at completion (they're in the chamber).
     *  No-op for bows. Returns { ammo, complete, progress, needed }. */
    async reload(ammoId = null) {
        if (!this.hasChamber) return;

        /* Magazine model (CE): the Reload button = COCK. It banks reloadActions
         * like a classic reload and, on completion, arms the TOP magazine round
         * — auto-feeding one from the chosen ammo if the magazine is empty (so a
         * fresh crossbow still just "reload and shoot" in one). Pre-stuffing
         * spare rounds is the separate feedMagazine() operation. */
        if (this.usesMagazine) {
            if (this.system?.loaded?.armed) {
                ui.notifications?.warn(tFormat("WITCHER.Doc.ReloadMixin.Notify.XIsAlreadyLoaded", { this: this.name }, "{this} is already loaded."));
                return;
            }
            const needed   = this.actor?._inActiveCombat ? Math.max(1, this.reloadActions) : 1;
            const progress = (Number(this.system?.loaded?.reloadProgress) || 0) + 1;
            if (progress < needed) {
                await this.update({ "system.loaded.reloadProgress": progress });
                return { complete: false, progress, needed };
            }
            let rounds = this.getChamberRounds();
            if (!rounds.length) {
                const fed = await this.feedMagazine(ammoId, { silent: false });
                if (!fed) { await this.update({ "system.loaded.reloadProgress": 0 }); return; }
                rounds = this.getChamberRounds();
            }
            await this.update(this._chamberUpdate(rounds, { "system.loaded.armed": true, "system.loaded.reloadProgress": 0 }));
            return { complete: true, cocked: true, loaded: rounds.length };
        }

        const ammo = ammoId ? this.#resolveAmmo(ammoId) : this.getSelectedAmmo();
        if (!ammo) {
            ui.notifications?.warn(t("WITCHER.Doc.ReloadMixin.Notify.NoAmmunitionInAnEquippedContainer", "No ammunition in an equipped container."));
            return;
        }
        const capacity = Math.max(1, Number(this.system?.loaded?.capacity) || 1);
        const rounds   = this.getChamberRounds();
        if (rounds.length >= capacity) {
            ui.notifications?.warn(tFormat("WITCHER.Doc.ReloadMixin.Notify.XIsAlreadyLoaded", { this: this.name }, "{this} is already loaded."));
            return;
        }
        // Multi-action reload banks one step toward chambering ONE round; the
        // round enters the chamber only when progress reaches reloadActions. Out
        // of combat there's no turn structure, so it completes in one go. Filling
        // a capacity-N chamber therefore takes N reload cycles of `reloadActions`.
        const needed   = this.actor?._inActiveCombat ? Math.max(1, this.reloadActions) : 1;
        const progress = (Number(this.system?.loaded?.reloadProgress) || 0) + 1;
        if (progress < needed) {
            await this.update({ "system.loaded.reloadProgress": progress });
            return { ammo, loaded: rounds.length, complete: false, progress, needed };
        }
        const have = Number(ammo.system?.quantity) || 0;
        if (have <= 0) {
            ui.notifications?.warn(tFormat("WITCHER.Doc.ReloadMixin.Notify.XIsEmpty", { ammo: ammo.name }, "{ammo} is empty."));
            await this.update({ "system.loaded.reloadProgress": 0 });
            return;
        }
        /* Snapshot THIS round's coating + source document before consuming the
         * source stack — a coated 1-qty stack is deleted here (the round now
         * lives in the chamber), so both survive on the round entry: appliedOil
         * for the attack-roll oil fold, sourceData for unload() to give it back
         * faithfully. Uncoated rounds get an empty oil snapshot. */
        const ammoAo = ammo.system?.appliedOil;
        const oilSnap = (ammoAo && ammoAo.name)
            ? { name: String(ammoAo.name), oilTarget: String(ammoAo.oilTarget || ""), oilBonusDamage: Number(ammoAo.oilBonusDamage) || 0 }
            : { name: "", oilTarget: "", oilBonusDamage: 0 };
        let sourceSnap = {};
        try { sourceSnap = ammo.toObject(false); } catch (_) { sourceSnap = {}; }

        // Consume exactly ONE round from the source stack.
        const nextQty = have - 1;
        if (nextQty <= 0) { try { await ammo.delete(); } catch (_) { /* soft-fail */ } }
        else await ammo.update({ "system.quantity": nextQty });

        // Push onto the top of the FILO stack — last loaded is next to fire.
        rounds.push({ uuid: ammo.uuid, name: ammo.name, img: ammo.img, appliedOil: oilSnap, sourceData: sourceSnap });
        await this.update(this._chamberUpdate(rounds, { "system.loaded.reloadProgress": 0 }));
        return { ammo, loaded: rounds.length, complete: true, progress: needed, needed };
    }

    /** Empty the chamber: return any chambered rounds to their ammo stack
     *  (resolved from `loaded.uuid`, if it still exists) and zero the count.
     *  The ammo selection is preserved so a later reload pulls the same
     *  round. No-op for bows / empty chambers.
     *
     *  Two paths depending on whether the source ammo document still
     *  exists on the actor:
     *    - Source alive (plain multi-qty stack): add `count` back to
     *      the existing document. Same behaviour as before.
     *    - Source gone (coated 1-qty stack that was deleted on reload):
     *      recreate the ammo from `system.loaded.sourceData`, sized to
     *      `count`, and drop it back into the actor's inventory. If the
     *      original lived in a container, the recreated stack joins it
     *      too — same helper the coating flow uses. */
    async unload() {
        if (!this.hasChamber) return;
        const rounds = this.getChamberRounds();
        if (!rounds.length) return;
        const actor = this.actor;
        /* Return each round to inventory, FILO (top of the stack first). A round
         * whose source document still exists (plain multi-qty stack) merges back
         * with +1; a round whose source was deleted on reload (coated 1-qty) is
         * recreated from ITS OWN sourceData snapshot as a fresh 1-qty item — so a
         * chamber holding mixed / coated rounds gives each back faithfully. */
        for (let i = rounds.length - 1; i >= 0; i--) {
            const r   = rounds[i];
            const ref = r?.uuid;
            const ammo = ref && typeof fromUuidSync === "function" ? fromUuidSync(ref) : null;
            if (ammo) {
                await ammo.update({ "system.quantity": (Number(ammo.system?.quantity) || 0) + 1 });
                continue;
            }
            const src = r?.sourceData;
            if (actor && src && typeof src === "object" && Object.keys(src).length > 0) {
                const data = foundry.utils.deepClone(src);
                delete data._id;
                data.effects = [];
                data.system = { ...(data.system ?? {}), quantity: 1 };
                try {
                    const [created] = await actor.createEmbeddedDocuments("Item", [data]);
                    /* Rejoin the original container if the source lived in one. */
                    if (created && src.system?.isStored === true) {
                        try {
                            const mod = await import("../../chrome/chrome/inventory.js");
                            await mod.addToSourceContainer?.(actor, { uuid: ref, id: null, system: src.system }, created);
                        } catch (_) { /* helper not exposed; leave loose */ }
                    }
                } catch (err) {
                    console.warn("witcher-ttrpg-death-march | unload recreate failed", err);
                }
            }
        }
        await this.update(this._chamberUpdate([], { "system.loaded.reloadProgress": 0, "system.loaded.sourceData": {}, "system.loaded.armed": false }));
        return { returned: rounds.length };
    }

    /** Spend one round to make an attack. Returns
     *    { ok: true,  ammo }                  — the round fired (read its
     *                                            damageTypes / qualities)
     *    { ok: false, reason: "empty" }       — chamber empty, reload first
     *    { ok: false, reason: "noAmmo" }      — bow with no eligible ammo
     *  Non-ammo weapons return { ok: true, ammo: null }.
     *
     *  `ammoId` (bows only) draws from a specific eligible round instead of the
     *  weapon's current selection — used so a Fast strike can loose two
     *  different arrows. Ignored by chambered weapons (they fire what's loaded). */
    async spendShot(ammoId = null) {
        if (!this.usesAmmo) return { ok: true, ammo: null };

        if (this.hasChamber) {
            const rounds = this.getChamberRounds();
            if (!rounds.length) return { ok: false, reason: "empty" };
            // Magazine model: can't fire while un-cocked.
            if (this.usesMagazine && !this.system?.loaded?.armed) return { ok: false, reason: "notCocked" };
            const fired = rounds.pop();   // FILO: the last loaded round fires first
            const ref   = fired?.uuid;
            const ammo  = ref && typeof fromUuidSync === "function" ? fromUuidSync(ref) : null;
            /* Magazine: a `repeating` crossbow re-cocks itself from the magazine
             * as long as a round remains; a non-repeating one drops to un-cocked
             * and must be cocked again before the next shot. Classic chambers
             * ignore `armed`. */
            const stayArmed = this.usesMagazine && this.isRepeating && rounds.length > 0;
            await this.update(this._chamberUpdate(rounds, { "system.loaded.armed": stayArmed }));
            return { ok: true, ammo: ammo ?? null,
                     ammoData: { name: fired?.name, img: fired?.img, appliedOil: fired?.appliedOil } };
        }

        // Bow: draw straight from the chosen (or selected) eligible ammo.
        const ammo = ammoId ? this.#resolveAmmo(ammoId) : this.getSelectedAmmo();
        const have = Number(ammo?.system?.quantity) || 0;
        if (!ammo || have <= 0) return { ok: false, reason: "noAmmo" };
        /* Free Ammunition (EO p.13 — sling rocks, etc.) — the weapon's
         * `freeAmmunition` quality says environment-found rounds don't
         * deplete the carried stack. The check lives on the WEAPON side
         * (a sling carries the quality), not on the ammo. */
        const wq = this.system?.effective?.qualities ?? this.system?.qualities ?? [];
        if (!wq.includes("freeAmmunition")) {
            const next = have - 1;
            /* Coated 1-qty spinoffs (produced by the apply-oil-to-ammo
             * flow) would otherwise linger as phantom "0-qty" entries
             * in inventory after firing. Delete on zero so the coated
             * arrow physically vanishes with its oil — matches Core
             * p.166 ("the projectile carries the coating"). Uncoated
             * empty stacks are dropped the same way for consistency;
             * no reason to keep a zero-quantity ammo document around. */
            if (next <= 0) {
                try { await ammo.delete(); } catch (_) { /* soft-fail */ }
            } else {
                await ammo.update({ "system.quantity": next });
            }
        }
        return { ok: true, ammo };
    }
};
