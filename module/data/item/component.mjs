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
 *   potency        : number  Alchemy Reborn potency (1-10). Sum of all
 *                            ingredient potencies fed into a brew → tier
 *                            (Normal/Enhanced/Superior) of the output.
 *                            Schema always present (ADR 0003); the
 *                            alchemyPotency homebrew toggle gates whether
 *                            it's surfaced in the sheet UI and read by
 *                            craftAlchemy. Defaults to 0 on legacy items;
 *                            a 0-potency component still satisfies a
 *                            substance count requirement, it just doesn't
 *                            advance the output's quality tier.
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
            /* Pure substance (Core p.83): a PURE unit is worth TWO units of its
             * substance when brewing. Purely an alchemy-accounting flag — each
             * physical unit of a pure component counts double toward a formula's
             * substance requirement (it's still consumed as one item). */
            pure:           new fields.BooleanField({ initial: false }),
            substanceType:  new fields.StringField({ initial: "" }),
            substance:      new fields.StringField({ initial: "" }),
            potency:        new fields.NumberField({ initial: 0, integer: true, min: 0, max: 10 }),
            availability:   new fields.StringField({ initial: "common" }),
            forageLocation: new fields.StringField({ initial: "" }),
            forageDC:       new fields.NumberField({ initial: 0, integer: true, min: 0 }),
            forageQuantity: new fields.StringField({ initial: "" }),
            // ── Alchemy Reborn: brew base configuration ────────────────
            // Mirrors AlchemicalData.alchemyBase. Some raw ingredients
            // (Saltpetre, Sulphur, Timber, dry substances) legitimately
            // serve as bomb / potion bases in Alchemy Reborn — surfacing
            // the block here lets the wheel pull them the same way it
            // pulls alchemical / food bases. Off by default (a fresh
            // component isn't a base until a GM flips it).
            alchemyBase: new fields.SchemaField({
                enabled:  new fields.BooleanField({ initial: false }),
                baseType: new fields.StringField({ initial: "" }),
                baseMod:  new fields.NumberField({ initial: 0, integer: true })
            })
        };
    }

    /* Back-fill `isSubstance` for components authored before the flag
     * existed: if a substanceType was set, it was a substance source. */
    static migrateData(data) {
        if (data?.isSubstance === undefined && data?.substanceType) {
            data.isSubstance = true;
        }
        /* Same "decoction → potion" fold used by AlchemicalData / FoodData —
         * the base dropdown only offers Potion/Oil/Bomb now. */
        if (data?.alchemyBase?.baseType === "decoction") data.alchemyBase.baseType = "potion";
        return super.migrateData(data);
    }

    calcWeight() {
        return this.weight * this.quantity;
    }
}
