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
 * Ammo is only eligible if it lives inside one of the wielder's EQUIPPED
 * containers (a worn quiver / bolt-case). Loose ammo and ammo in stowed
 * packs cannot be drawn mid-combat.
 */

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

    /** Ready to fire? Bows are always ready (ammo is checked at fire time);
     *  a chambered weapon is ready only while it holds a round. */
    get isLoaded() {
        return !this.hasChamber || (Number(this.system?.loaded?.count) || 0) > 0;
    }

    /** The ammo class this weapon fires ("arrow" / "bolt"). */
    get ammoType() {
        return this.usesAmmo ? (this.system?.ammoType || "arrow") : "";
    }

    /** Ammo the wielder may load: type "ammo", matching this weapon's
     *  ammoType (arrows in bows, bolts in crossbows), quantity > 0, inside
     *  one of the actor's equipped containers. Returns
     *  [{ item, container, qty }]. */
    getEligibleAmmo() {
        const actor = this.actor;
        if (!actor) return [];
        const want = this.ammoType;
        const out = [];
        const seen = new Set();
        for (const c of actor.items) {
            if (c.type !== "container" || c.system?.equipped !== true) continue;
            for (const ref of c.system?.content ?? []) {
                const it = (typeof fromUuidSync === "function") ? fromUuidSync(ref) : null;
                if (!it || it.type !== "ammo" || seen.has(it.id)) continue;
                if ((it.system?.ammoType || "arrow") !== want) continue;
                if ((Number(it.system?.quantity) || 0) <= 0) continue;
                seen.add(it.id);
                out.push({ item: it, container: c, qty: Number(it.system?.quantity) || 0 });
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

    /** Take one reload action. Weapons that need several actions to reload
     *  (reloadActions > 1) bank progress here; only once enough actions have
     *  accumulated do rounds actually move from the ammo stack into the
     *  chamber. A reloadActions === 1 weapon chambers on the first call. The
     *  rounds leave the ammo stack at completion (they're in the chamber).
     *  No-op for bows. Returns { ammo, complete, progress, needed }. */
    async reload(ammoId = null) {
        if (!this.hasChamber) return;
        const ammo = ammoId ? this.#resolveAmmo(ammoId) : this.getSelectedAmmo();
        if (!ammo) {
            ui.notifications?.warn("No ammunition in an equipped container.");
            return;
        }
        const capacity = Math.max(1, Number(this.system?.loaded?.capacity) || 1);
        const already  = Number(this.system?.loaded?.count) || 0;
        if (already >= capacity) {
            ui.notifications?.warn(`${this.name} is already loaded.`);
            return;
        }
        // Multi-action reload: each action banks one step of progress; the
        // chamber fills only when progress reaches reloadActions. Out of combat
        // there's no turn structure, so the reload just completes in one go.
        const needed   = this.actor?._inActiveCombat ? Math.max(1, this.reloadActions) : 1;
        const progress = (Number(this.system?.loaded?.reloadProgress) || 0) + 1;
        if (progress < needed) {
            await this.update({
                "system.loaded.uuid":           ammo.uuid,
                "system.loaded.name":           ammo.name,
                "system.loaded.img":            ammo.img,
                "system.loaded.reloadProgress": progress
            });
            return { ammo, loaded: already, complete: false, progress, needed };
        }
        const have = Number(ammo.system?.quantity) || 0;
        const take = Math.min(Math.max(0, capacity - already), have);
        if (take <= 0) {
            ui.notifications?.warn(`${ammo.name} is empty.`);
            await this.update({ "system.loaded.reloadProgress": 0 });
            return;
        }
        await ammo.update({ "system.quantity": have - take });
        await this.update({
            "system.loaded.uuid":           ammo.uuid,
            "system.loaded.name":           ammo.name,
            "system.loaded.img":            ammo.img,
            "system.loaded.count":          already + take,
            "system.loaded.reloadProgress": 0
        });
        return { ammo, loaded: already + take, complete: true, progress: needed, needed };
    }

    /** Empty the chamber: return any chambered rounds to their ammo stack
     *  (resolved from `loaded.uuid`, if it still exists) and zero the count.
     *  The ammo selection is preserved so a later reload pulls the same
     *  round. No-op for bows / empty chambers. */
    async unload() {
        if (!this.hasChamber) return;
        const count = Number(this.system?.loaded?.count) || 0;
        if (count <= 0) return;
        const ref  = this.system?.loaded?.uuid;
        const ammo = ref && typeof fromUuidSync === "function" ? fromUuidSync(ref) : null;
        if (ammo) {
            const have = Number(ammo.system?.quantity) || 0;
            await ammo.update({ "system.quantity": have + count });
        }
        await this.update({ "system.loaded.count": 0, "system.loaded.reloadProgress": 0 });
        return { ammo, returned: count };
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
            const count = Number(this.system?.loaded?.count) || 0;
            if (count <= 0) return { ok: false, reason: "empty" };
            const ref  = this.system?.loaded?.uuid;
            const ammo = ref && typeof fromUuidSync === "function" ? fromUuidSync(ref) : null;
            await this.update({ "system.loaded.count": count - 1 });
            return { ok: true, ammo: ammo ?? null,
                     ammoData: { name: this.system?.loaded?.name, img: this.system?.loaded?.img } };
        }

        // Bow: draw straight from the chosen (or selected) eligible ammo.
        const ammo = ammoId ? this.#resolveAmmo(ammoId) : this.getSelectedAmmo();
        const have = Number(ammo?.system?.quantity) || 0;
        if (!ammo || have <= 0) return { ok: false, reason: "noAmmo" };
        await ammo.update({ "system.quantity": have - 1 });
        return { ok: true, ammo };
    }
};
