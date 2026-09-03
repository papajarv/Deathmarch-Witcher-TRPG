/**
 * AmmoData — TypeDataModel for ammunition (arrows, bolts, thrown shot).
 *
 * Ammo was previously a `weapon` carrying an `isAmmo` flag; it is now its
 * own item type. It drops every field that belongs to the wielded weapon
 * rather than the projectile: damage formula, attack skill, WA (accuracy),
 * enhancement slots, hands, and the melee-bonus toggle. The ranged weapon
 * that fires it owns those; the ammo only carries what travels with the
 * shot — its damage type(s) and any on-hit qualities (e.g. Armor-Piercing
 * bodkins). Field names that survive (`damageTypes`, `qualities`,
 * `qualityValues`, `availability`, `conceal`, `effects`) keep their weapon
 * spellings so the inventory chrome reads them unchanged.
 */

import { baseItemSchema } from "./templates/base.mjs";

const fields = foundry.data.fields;

export class AmmoData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            ...baseItemSchema(),
            // Which weapon class this projectile fits: "arrow" (bows) or
            // "bolt" (crossbows). A weapon only loads ammo whose ammoType
            // matches its own — see CONFIG.WITCHER.weapon.ammoTypes.
            ammoType:      new fields.StringField({ initial: "arrow" }),
            // The projectile dictates the damage type of a shot from a bow
            // / crossbow (the weapon declares none, `requiresAmmo`).
            damageTypes:   new fields.ArrayField(new fields.StringField(), { initial: [] }),
            // On-hit qualities (Armor-Piercing, etc.) — KEY references into
            // CONFIG.WITCHER.weapon.qualities, same catalog as weapons.
            qualities:     new fields.ArrayField(new fields.StringField(), { initial: [] }),
            qualityValues: new fields.ObjectField({ initial: {} }),
            availability:  new fields.StringField({ initial: "common" }),
            conceal:       new fields.StringField({ initial: "N/A" }),
            effects:       new fields.HTMLField({ initial: "" }),
            /* Oil coating on the ammo — a single arrow/bolt is coated at
             * a time (the apply-oil flow splits a 1-qty spinoff so the
             * uncoated remainder stays a stack). The damage fold reads
             * this on ranged shots instead of weapon.system.appliedOil,
             * so oiling arrows works the way Core p.166 describes: the
             * projectile carries the coating, not the bow. Shape mirrors
             * WeaponData.appliedOil exactly so the same helpers, badge
             * rendering, and sweep code work on both. */
            appliedOil: new fields.SchemaField({
                id:             new fields.StringField({ initial: "", blank: true }),
                name:           new fields.StringField({ initial: "", blank: true }),
                img:            new fields.StringField({ initial: "", blank: true }),
                oilTarget:      new fields.StringField({ initial: "", blank: true }),
                oilBonusDamage: new fields.NumberField({ initial: 0, integer: true, min: 0 }),
                appliedAt:      new fields.NumberField({ initial: 0, integer: true, min: 0 }),
                expireAt:       new fields.NumberField({ initial: 0, integer: true, min: 0 }),
                charges:        new fields.NumberField({ initial: 0, integer: true, min: 0 }),
                maxCharges:     new fields.NumberField({ initial: 0, integer: true, min: 0 })
            })
        };
    }

    /** Total weight contribution (ammo stacks, so quantity matters). */
    calcWeight() {
        return this.weight * this.quantity;
    }
}
