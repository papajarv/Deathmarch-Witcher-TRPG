/**
 * MutagenData — character mutagens (red / green / blue).
 *
 * A mutagen carries a mutation the character can install. Its mechanical
 * payload is a Foundry ActiveEffect that does NOT auto-transfer (it's
 * granted by the install flow, not by merely holding the item). The color
 * type tints the display window.
 *
 * Alchemy Reborn (homebrew `alchemyPotency`): mutagens ALSO act as substance
 * ingredients for the brew wheel — per alch7-9 every mutagen carries a
 * substance (Vitriol / Rebis / Aether / …) and a potency value (1-8 in the
 * source sheet). When the toggle is on, the chrome wheel surfaces mutagens
 * alongside components for the substance they provide and a brew may "burn"
 * one to satisfy a substance requirement. With the toggle off, the fields
 * stay in the schema (ADR 0003) but the wheel skips mutagens, so legacy
 * worlds that treat mutagens as install-only items are unaffected.
 */

import { baseItemSchema } from "./templates/base.mjs";

const fields = foundry.data.fields;

export class MutagenData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            ...baseItemSchema(),
            // Mutagen colour — tints the sheet and groups the mutation type.
            type:          new fields.StringField({ initial: "red", choices: ["red", "green", "blue"] }),
            // DC of the mutation roll to install this mutagen.
            mutationDC:    new fields.NumberField({ initial: 0, integer: true, min: 0 }),
            // The lesser bonus the mutagen grants — a terse one-liner.
            minorEffect:   new fields.StringField({ initial: "" }),
            // The transmutation requirement / pathway — a terse one-liner.
            transmutation: new fields.StringField({ initial: "" }),
            // ── Alchemy Reborn ingredient fields ──────────────────────
            // substanceType : canonical lowercase substance key (vitriol,
            //                 rebis, aether, …). The chrome wheel reads
            //                 this via ingredientSubstance() to slot the
            //                 mutagen into a substance row.
            // substance     : legacy alias mirroring ComponentData. Both
            //                 are read in priority order (substanceType
            //                 first); a pre-existing alchemy-craft flag
            //                 (`flags["witcher-alchemy-craft"].substance`)
            //                 still wins as the fallback so stock-pack
            //                 mutagens authored on the flag keep working.
            // potency       : 0-10, summed into the brew's total potency
            //                 for tier resolution. 0 = no contribution
            //                 (satisfies a count, doesn't advance tier).
            substanceType: new fields.StringField({ initial: "" }),
            substance:     new fields.StringField({ initial: "" }),
            potency:       new fields.NumberField({ initial: 0, integer: true, min: 0, max: 10 })
        };
    }

    calcWeight() {
        return 0;
    }
}
