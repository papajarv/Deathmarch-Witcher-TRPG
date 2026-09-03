/**
 * ArmorData — TypeDataModel for armor pieces.
 *
 * Base + per-location stopping (head, torso, arms, legs) and damage-type
 * modifiers. The enhancement application logic in overhaul-ui
 * (itemMixin.js:236+) writes to every `{location}Stopping` /
 * `{location}MaxStopping` pair, so they all need to exist.
 */

import { baseItemSchema }                              from "./templates/base.mjs";
import { defensePropertiesSchema, migrateArmorReliability, migrateArmorAeSlots } from "./templates/defenseProperties.mjs";
import { deriveArmorEffective }                         from "./templates/enhancementDerivation.mjs";
import { containerCapableSchema, deriveContainerCapableStoredWeight } from "./templates/containerCapable.mjs";

export class ArmorData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            ...baseItemSchema(),
            ...defensePropertiesSchema(),
            // Armor can be outfitted with pockets → holds items like a
            // container (gated by `system.pockets`).
            ...containerCapableSchema()
        };
    }

    /** Pre-validation migration:
     *  - `reliability: 10` → `reliability: { value: 10, max: 10 }`
     *  - per-limb aeSlots (leftArm/rightArm/leftLeg/rightLeg) folded
     *    into 4-zone aeSlots (arms/legs), applied-enh location tags
     *    normalized to zones. */
    static migrateData(data) {
        migrateArmorReliability(data);
        migrateArmorAeSlots(data);
        return super.migrateData(data);
    }

    /** Effective stats after socketed enhancements (glyphs / armor mods).
     *  `system.effective` holds per-location stopping (value/max), the
     *  three damage-type resistance booleans, effective EV and merged
     *  qualities. Base fields are untouched so detaching reverts cleanly. */
    prepareDerivedData() {
        this.effective = deriveArmorEffective(this);
        // Pocket load — folds any stored items into the piece's weight so the
        // wearer's encumbrance picks them up (contained items return 0 from
        // their own calcWeight, so this is the sole count).
        deriveContainerCapableStoredWeight(this);
    }

    calcWeight() {
        return this.weight * this.quantity + (Number(this.storedWeight) || 0);
    }
}
