/**
 * ComponentData — alchemical / crafting ingredient (Core p.83, p.143).
 *
 * The Core "Crafting Components" and "Substances" tables share a shape:
 *   Name · Rarity · Location · Quantity · Forage DC · Weight · Cost
 * A component either yields one of the nine alchemical substances
 * (`isSubstance` + `substanceType`) or is a plain crafting material
 * (Ashes, Coal, Timber …) with no substance.
 *
 * Schema additions over base:
 *   isSubstance    : boolean does this component yield an alchemical substance
 *   substanceType  : string  the substance key (Vitriol / Sol / …) — the
 *                            crafting wheel reads THIS field (lower-cased) to
 *                            match a diagram's `alchemyComponents` map.
 *   substance      : string  legacy / mutagen-fallback alias (kept for compat).
 *   availability   : string  rarity key (everywhere / common / poor / rare …).
 *   forageLocation : string  where it occurs ("Fields", "Mountains …").
 *   forageDC       : number  Wilderness Survival DC to find it (0 = N/A).
 *   forageQuantity : string  units yielded per find ("1d10 Units", "N/A").
 */

import { baseItemSchema } from "./templates/base.mjs";

const fields = foundry.data.fields;

export class ComponentData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            ...baseItemSchema(),
            isSubstance:    new fields.BooleanField({ initial: false }),
            substanceType:  new fields.StringField({ initial: "" }),
            substance:      new fields.StringField({ initial: "" }),
            availability:   new fields.StringField({ initial: "common" }),
            forageLocation: new fields.StringField({ initial: "" }),
            forageDC:       new fields.NumberField({ initial: 0, integer: true, min: 0 }),
            forageQuantity: new fields.StringField({ initial: "" })
        };
    }

    /* Back-fill `isSubstance` for components authored before the flag
     * existed: if a substanceType was set, it was a substance source. */
    static migrateData(data) {
        if (data?.isSubstance === undefined && data?.substanceType) {
            data.isSubstance = true;
        }
        return super.migrateData(data);
    }

    calcWeight() {
        return this.weight * this.quantity;
    }
}
