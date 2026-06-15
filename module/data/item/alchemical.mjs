/**
 * AlchemicalData — finished alchemy products (potions, oils, decoctions,
 * bombs, poisons). RAW Core p.83-95.
 *
 * Alchemical items are single-use unless noted (Core p.87). Multi-dose
 * items just bump `quantity`. The potency / baseMod / charges scaling
 * from the witcher-alchemy-craft module is NOT part of this schema —
 * RAW only.
 */

import { baseItemSchema }   from "./templates/base.mjs";

const fields = foundry.data.fields;

export class AlchemicalData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            ...baseItemSchema(),

            // Type — potion / oil / decoction / bomb / item / other
            // (Core p.87 introduces categories; specifics live in the
            // category's section pp.84-95).
            type:     new fields.StringField({ initial: "potion" }),

            // Toxicity contribution when consumed (Core p.84 — potions
            // and decoctions add their Toxicity to the character's pool;
            // pool > 100 → damage). Oils, bombs, etc. contribute 0.
            toxicity: new fields.NumberField({ initial: 0, integer: true, min: 0 }),

            // Mechanical effect description + duration (RAW each item
            // sidebar).
            effects:  new fields.HTMLField({ initial: "" }),
            duration: new fields.StringField({ initial: "" }),

            // For bombs and other AOE items (Core p.88 bomb section).
            // `range` is free-form text — bomb throwing range is often a
            // formula like "BODYx4" rather than a fixed number.
            damage:     new fields.StringField({ initial: "" }),
            damageType: new fields.StringField({ initial: "" }),
            range:      new fields.StringField({ initial: "" }),
            area:       new fields.NumberField({ initial: 0, integer: true, min: 0 }),

            // Crafting metadata — the diagram that produces this item has
            // its own DC; storing the originating DC here lets us echo it
            // in chat cards (Core p.124+).
            craftingDC: new fields.NumberField({ initial: 0, integer: true, min: 0 }),

            // Availability + concealment per RAW p.73 conventions.
            availability: new fields.StringField({ initial: "common" }),
            conceal:      new fields.StringField({ initial: "S" })
        };
    }

    calcWeight() {
        return this.weight * this.quantity;
    }

    /* Legacy migrations:
     *  - "poison" → "substance" → "item" (the subtype now reads
     *    "Alchemical Item"); fold both legacy keys forward.
     *  - `range` changed from number to free-form string; a stored 0
     *    becomes "" so it doesn't render as a literal "0". */
    static migrateData(data) {
        if (data?.type === "poison" || data?.type === "substance") data.type = "item";
        if (typeof data?.range === "number") data.range = data.range ? String(data.range) : "";
        return super.migrateData(data);
    }
}
