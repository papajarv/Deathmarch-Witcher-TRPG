/**
 * WeaponData — TypeDataModel for weapons.
 *
 * Schema includes base item fields, damage properties, and weapon-specific
 * equipment fields:
 *  - `hands`: the weapon TRAIT — "one" | "two" (how many hands it needs).
 *  - `slot`:  the equip slot it last occupied — "right" | "left" | "quick"
 *             (doubles as "last slot" memory for drawing). A two-handed
 *             weapon occupies both hands regardless of `slot`.
 *  - `quick`: whether this weapon may sit in the off-hand Quick slot
 *             (throwing knives, daggers, etc.). Non-quick one-handed
 *             weapons only fit Right or Left.
 */

import { baseItemSchema }                              from "./templates/base.mjs";
import { damagePropertiesSchema, migrateDamageType }   from "./templates/damageProperties.mjs";
import { deriveWeaponEffective }                       from "./templates/enhancementDerivation.mjs";

const fields = foundry.data.fields;

export class WeaponData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            ...baseItemSchema(),
            ...damagePropertiesSchema(),
            hands: new fields.StringField({ initial: "one", choices: ["one", "two"] }),
            slot:  new fields.StringField({ initial: "right", choices: ["right", "left", "quick"] }),
            quick: new fields.BooleanField({ initial: false })
        };
    }

    /** Pre-validation migration. Runs once on actor/item load before
     *  schema validation, so legacy fields are reshaped silently:
     *  - `damageType: "slashing"` → `damageTypes: ["slashing"]`
     *  - `reliability: 10` → `reliability: { value: 10, max: 10 }`
     *  - `range: 10` → `range: "10"` (now free-form text, e.g. "BODYx4") */
    static migrateData(data) {
        migrateDamageType(data);
        // Equipment model v2: the old `hands` conflated trait + slot
        // ("left"/"right"/"quick"/"two-handed"/"both"). Split it into the
        // trait (`hands` = one|two), the equip slot (`slot`), and a `quick`
        // flag. Already-migrated values ("one"/"two") fall through untouched.
        const oh = data.hands;
        if (oh === "two-handed" || oh === "both") {
            data.hands = "two";
            if (data.slot == null) data.slot = "right";
        } else if (oh === "left" || oh === "right" || oh === "quick") {
            if (data.quick == null) data.quick = (oh === "quick");
            if (data.slot == null)  data.slot  = (oh === "quick") ? "quick" : oh;
            data.hands = "one";
        }
        if (typeof data.reliability === "number") {
            const n = data.reliability;
            data.reliability = { value: n, max: n };
        }
        if (typeof data.range === "number") {
            data.range = data.range ? String(data.range) : "";
        }
        // RAW "Slow Reload" = 1 action to reload. Seed reloadActions from the
        // quality for weapons authored before the numeric field existed.
        if (data.reloadActions == null && Array.isArray(data.qualities)
            && data.qualities.includes("slowReload")) {
            data.reloadActions = 1;
        }
        // Seed accepted ammo class for weapons authored before ammoType
        // existed: crossbows fire bolts, everything else (bows) arrows.
        if (data.ammoType == null && data.requiresAmmo) {
            data.ammoType = data.skillKey === "crossbow" ? "bolt" : "arrow";
        }
        return super.migrateData(data);
    }

    /** Effective stats after socketed enhancements (runes / weapon mods).
     *  `system.effective` holds accuracy, reliabilityMax, damage formula,
     *  damageTypes, qualities + qualityValues. Base fields are untouched, so
     *  display + roll consumers read `effective` when they want the
     *  enhanced numbers and the raw fields when they want the base. */
    prepareDerivedData() {
        this.effective = deriveWeaponEffective(this);
    }

    /** Total weight contribution. Phase 5 may refine for stacking edge cases. */
    calcWeight() {
        return this.weight * this.quantity;
    }
}
