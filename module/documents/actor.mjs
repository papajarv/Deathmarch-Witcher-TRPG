/**
 * WitcherActor — base Actor document for the system.
 *
 * Behavior composes via class mixins. Add a mixin by importing it and
 * wrapping the next layer (`mixin(Base)`). Phase 5 adds skill rolls;
 * Phase 6 adds combat / modifier flows.
 */

import { skillMixin } from "./mixins/skillMixin.mjs";
import { saveMixin } from "./mixins/saveMixin.mjs";
import { combatRoundMixin } from "./mixins/combatRoundMixin.mjs";
import { weaponAttackMixin } from "./mixins/weaponAttackMixin.mjs";
import { brawlMixin } from "./mixins/brawlMixin.mjs";
import { castSpellMixin } from "./mixins/castSpellMixin.mjs";
import { defenseMixin } from "./mixins/defenseMixin.mjs";
import { toxicityMixin } from "./mixins/toxicityMixin.mjs";

export class WitcherActor extends toxicityMixin(combatRoundMixin(defenseMixin(castSpellMixin(brawlMixin(weaponAttackMixin(saveMixin(skillMixin(Actor)))))))) {

    /**
     * Final-pass REC floor. Runs after the whole prepare pipeline — that
     * means after `prepareDerivedData` (which seeds REC from BODY+WILL plus
     * any `mods.derived.recBonus` from active statuses) AND after Foundry
     * applies "final" phase ActiveEffect changes (hangover's flat −N, any
     * other heavy REC debuff). Clamps REC at 1 so a brutal stack of
     * penalties can't drive it to 0 or negative — recovery slows but never
     * inverts. Consumers (heal dialog, dock REC pill, sheet readout) all
     * read `actor.system.derivedStats.rec` so the floor applies everywhere
     * at once.
     */
    prepareData() {
        super.prepareData();
        const ds = this.system?.derivedStats;
        if (ds && typeof ds.rec === "number") {
            ds.rec = Math.max(1, ds.rec);
        }
    }

    /**
     * Foundry's default rolls initiative on `CONFIG.Combat.initiative.formula`
     * (falls back to `1d20` when unset — which is why every path that
     * didn't pass an explicit `formula` — token HUD toggle, drag-onto-tracker,
     * combat-tracker Roll button — was ignoring REF). Override here so
     * EVERY code path uses the Witcher rule `1d10 + REF` including any
     * bonuses folded onto the prepared REF (buffs, statuses, mutations).
     * Character sheets, monster sheets, and dock buttons that pass their
     * own formula still win — they call `combat.rollInitiative(ids,
     * { formula })` which bypasses this helper.
     */
    getInitiativeFormula() {
        const ref = Number(this.system?.stats?.ref?.value) || 0;
        return `1d10 + ${ref}`;
    }

    /**
     * Total carried weight — the single authoritative sum every encumbrance
     * readout consults (top-bar chip, chrome inventory rail, mount saddlebag
     * popup, monster/loot sheets).
     *
     * Walks each owned item and adds `system.calcWeight()`. Skips items with
     * `isCarried:false` (dropped/staged out of inventory) and `isStored:true`
     * (their weight enters via their container's calcWeight rollup, which
     * folds in the container's `storedWeight` — see data/item/container.mjs).
     * Adds currency weight via `system.calcCurrencyWeight()` when defined.
     *
     * Without this method the chrome falls back to a manual sum that has to
     * re-derive container aggregation itself — the fallback works, but it
     * runs on every render whereas this method lets Foundry pipe the same
     * value through every consumer coherently.
     */
    getTotalWeight() {
        let total = 0;
        for (const item of this.items ?? []) {
            const s = item?.system ?? {};
            if (s.isCarried === false) continue;
            if (s.isStored   === true)  continue;
            total += typeof s.calcWeight === "function"
                ? Number(s.calcWeight()) || 0
                : (Number(s.quantity) || 0) * (Number(s.weight) || 0);
        }
        if (typeof this.system?.calcCurrencyWeight === "function") {
            total += Number(this.system.calcCurrencyWeight()) || 0;
        }
        return Math.round(total * 100) / 100;
    }

    /**
     * Add an item (Item document or raw item data) to this actor, merging
     * into an existing stackable item when one matches instead of creating a
     * duplicate.  Returns the resulting item document.
     */
    async addItem(item, quantity = 1) {
        const data = item?.toObject ? item.toObject() : foundry.utils.deepClone(item);
        const incoming = Number(quantity) || Number(data.system?.quantity) || 1;
        const target = this.findStackTarget(data);
        if (target) {
            const cur = Number(target.system?.quantity) || 1;
            await target.update({ "system.quantity": cur + incoming });
            return target;
        }
        delete data._id;
        data.system = { ...(data.system ?? {}), quantity: incoming };
        const [created] = await this.createEmbeddedDocuments("Item", [data]);
        return created;
    }

    /**
     * The loose, on-person item this actor already carries that the given
     * item/data could stack into, or null.  Containers and items carrying
     * unique effects (e.g. an applied oil) never stack.
     */
    findStackTarget(data) {
        if (!WitcherActor.itemIsStackable(data)) return null;
        const sig = WitcherActor.stackSignature(data);
        return this.items.find(i =>
            i.id !== data._id &&
            !i.system?.isStored &&
            !i.system?.equipped &&
            WitcherActor.itemIsStackable(i) &&
            WitcherActor.stackSignature(i) === sig
        ) ?? null;
    }

    /** Per-instance fingerprint for stack-merge decisions: name, type, img,
     *  source system data (minus volatile quantity / placement fields) and
     *  effects (minus per-copy ids).  Two items merge only when these match, so
     *  a copy the player has MODIFIED never re-merges into the base stack and
     *  loses the change.  Mirrors `stackSignature` in chrome/inventory.js. */
    static stackSignature(itemOrData) {
        if (!itemOrData) return "";
        const o = itemOrData.toObject ? itemOrData.toObject() : foundry.utils.deepClone(itemOrData);
        const sys = o.system ?? {};
        delete sys.quantity;
        delete sys.isStored;
        delete sys.equipped;
        const effects = (o.effects ?? []).map(e => {
            const c = { ...e };
            delete c._id;
            delete c.origin;
            return c;
        });
        return JSON.stringify({ name: o.name, type: o.type, img: o.img, system: sys, effects });
    }

    /** An item/data may stack only if it isn't a container, weapon or armor
     *  (each piece of gear is tracked individually — equip state, hands, oils
     *  and enhancements are per-instance) and carries no applied oil coating
     *  (a transient, per-copy effect tagged flags.<systemId>.oilCoating).
     *  Inherent item effects — a mutagen's mutation, a potion's buff
     *  (transfer:false, applied on use) — are identical across copies and
     *  don't block stacking. */
    static itemIsStackable(itemOrData) {
        if (!itemOrData) return false;
        const t = itemOrData.type;
        // `remains` (monster carcasses) never stack — each carries its own harvest
        // charges + source-monster config, so two carcasses must stay distinct.
        if (t === "container" || t === "weapon" || t === "armor" || t === "remains") return false;
        // Food & drink track freshness/spoilage per-item, so each stays its own
        // document and must never auto-merge into a single stack (matches the
        // chrome's `isFoodOrDrink`/`itemsStackTogether` rule).
        if (t === "food"
            || Number(itemOrData.flags?.["witcher-food-and-drink"]?.charges?.max) > 0
            || (t === "valuable" && String(itemOrData.system?.type ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-") === "food-drink")) {
            return false;
        }
        const effects = itemOrData.effects;
        if (!effects) return true;
        const moduleId = "witcher-ttrpg-death-march";
        for (const e of effects) {
            if (e?.getFlag?.(moduleId, "oilCoating") ?? e?.flags?.[moduleId]?.oilCoating) return false;
        }
        return true;
    }
}
