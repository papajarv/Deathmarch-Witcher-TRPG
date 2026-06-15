/**
 * ArmorData — TypeDataModel for armor pieces.
 *
 * Base + per-location stopping (head, torso, arms, legs) and damage-type
 * modifiers. The enhancement application logic in overhaul-ui
 * (itemMixin.js:236+) writes to every `{location}Stopping` /
 * `{location}MaxStopping` pair, so they all need to exist.
 */

import { baseItemSchema }                              from "./templates/base.mjs";
import { defensePropertiesSchema, migrateArmorReliability } from "./templates/defenseProperties.mjs";
import { deriveArmorEffective }                         from "./templates/enhancementDerivation.mjs";

export class ArmorData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            ...baseItemSchema(),
            ...defensePropertiesSchema()
        };
    }

    /** Pre-validation migration:
     *  - `reliability: 10` → `reliability: { value: 10, max: 10 }`  */
    static migrateData(data) {
        migrateArmorReliability(data);
        return super.migrateData(data);
    }

    /** Effective stats after socketed enhancements (glyphs / armor mods).
     *  `system.effective` holds per-location stopping (value/max), the
     *  three damage-type resistance booleans, effective EV and merged
     *  qualities. Base fields are untouched so detaching reverts cleanly. */
    prepareDerivedData() {
        this.effective = deriveArmorEffective(this);
    }

    calcWeight() {
        return this.weight * this.quantity;
    }
}
