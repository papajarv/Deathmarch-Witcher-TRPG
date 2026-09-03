/**
 * ShieldData — TypeDataModel for shields.
 *
 * Shields are wielded like weapons (they hold a hand slot) but their RAW
 * profile is defensive (Core p.78-81): a Reliability pool of blocks before
 * the shield breaks, an Encumbrance Value, an Armor-Enhancement slot count,
 * Availability, and an optional Full-Cover effect (pavises).
 *
 * Wielding fields (`hands` / `slot` / `quick`) mirror WeaponData so the
 * equip rail, dock and occupancy logic treat a shield the same as a weapon.
 * Shields default to the off-hand (quick) slot but may be seated in either
 * hand.
 */

import { baseItemSchema } from "./templates/base.mjs";
import { migrateArmorAeSlots } from "./templates/defenseProperties.mjs";

const fields = foundry.data.fields;
const num = (initial = 0) => new fields.NumberField({ initial, integer: true, min: 0 });

export class ShieldData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            ...baseItemSchema(),
            // Shield size class (Core p.80-81): light / medium / heavy.
            category: new fields.StringField({ initial: "medium", choices: ["light", "medium", "heavy"] }),
            // Reliability — blocks absorbed before the shield breaks (Core p.78).
            reliability: new fields.SchemaField({ value: num(), max: num() }),
            // EV — encumbrance penalty applied while the shield is wielded.
            encumbranceValue: num(),
            // AE — glyph / armor-mod slots the shield can host (Core p.78).
            armorEnhancement: num(),
            availability: new fields.StringField({ initial: "common" }),
            // Pavise-style full cover (Core p.81); `effect` carries any other
            // special rule as free text.
            fullCover: new fields.BooleanField({ initial: false }),
            // Cover Value (Equipment Overhaul / Combat Extended): how many
            // hit locations this shield can cover via the Raise Shield
            // action. CV 1 = one location; CV 2-3 typical for bucklers /
            // round shields; CV 6+ = full cover (no picker, all locations);
            // CV 7+ also too unwieldy to Parry / Block in melee (cover only).
            // Schema present always so values survive a CE toggle flip;
            // surfaced on the shield item sheet only when CE is on.
            coverValue: num(),
            effect:    new fields.HTMLField({ initial: "" }),
            // Wielding model — a shield is a plain one-handed (or two-handed
            // pavise) hand item. It is NEVER a quick item: it occupies a full
            // hand slot, off-hand by default. (Mirrors WeaponData minus `quick`.)
            hands: new fields.StringField({ initial: "one", choices: ["one", "two"] }),
            slot:  new fields.StringField({ initial: "left", choices: ["right", "left"] }),
            // Offensive profile — a shield bash (Core p.164) is a Melee attack
            // dealing bludgeoning, lethal damage. The damage FORMULA isn't stored:
            // it's derived per-wielder from Punch + size (see shieldBashDamage in
            // config.mjs), so the attack flow computes it at roll time. weaponType
            // "melee" keeps the attack dialog on the melee branch.
            skillKey:    new fields.StringField({ initial: "melee" }),
            damageTypes: new fields.ArrayField(new fields.StringField(), { initial: ["bludgeoning"] }),
            weaponType:  new fields.StringField({ initial: "melee" }),
            // Socketed enhancements + selected qualities, capped by armorEnhancement.
            qualities:     new fields.ArrayField(new fields.StringField(), { initial: [] }),
            qualityValues: new fields.ObjectField({ initial: {} }),
            appliedEnhancements: new fields.ArrayField(new fields.SchemaField({
                uuid: new fields.StringField({ initial: "" }),
                name: new fields.StringField({ initial: "" }),
                img:  new fields.StringField({ initial: "" }),
                /* Type + snapshot of the enhancement's system data captured
                 * at attach time. Lets effective-stats derivation and the
                 * detach-recreate path work after the source item is
                 * deleted from inventory. Legacy worlds without a snapshot
                 * fall back to fromUuidSync via the uuid. */
                type:   new fields.StringField({ initial: "" }),
                system: new fields.ObjectField({ initial: {} }),
                /* True when the enhancement's stopping bonus has been
                 * baked into the parent's base fields at attach time. */
                baked:  new fields.BooleanField({ initial: false })
            }), { initial: [] })
        };
    }

    /** Pre-validation migration: legacy `reliability: 10` → `{ value: 10, max: 10 }`;
     *  legacy quick shields (slot "quick" / quick:true) → off-hand, quick dropped. */
    static migrateData(data) {
        if (typeof data.reliability === "number") {
            const n = data.reliability;
            data.reliability = { value: n, max: n };
        }
        if (data.slot === "quick") data.slot = "left";
        delete data.quick;
        /* Same aeSlots migration as ArmorData — shields share the
         * defenseProperties.aeSlots schema. */
        migrateArmorAeSlots(data);
        return super.migrateData(data);
    }

    calcWeight() {
        return this.weight * this.quantity;
    }
}
