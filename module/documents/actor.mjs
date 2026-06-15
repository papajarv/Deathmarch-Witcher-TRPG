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
        if (t === "container" || t === "weapon" || t === "armor") return false;
        const effects = itemOrData.effects;
        if (!effects) return true;
        const moduleId = "witcher-ttrpg-death-march";
        for (const e of effects) {
            if (e?.getFlag?.(moduleId, "oilCoating") ?? e?.flags?.[moduleId]?.oilCoating) return false;
        }
        return true;
    }
}
