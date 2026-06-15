/**
 * MutagenData — character mutagens (red / green / blue).
 *
 * A mutagen carries a mutation the character can install. Its mechanical
 * payload is a Foundry ActiveEffect that does NOT auto-transfer (it's
 * granted by the install flow, not by merely holding the item). The color
 * type tints the display window. Mutagens are NOT alchemy ingredients —
 * the ingredient/substance system is a separate, later addition.
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
            transmutation: new fields.StringField({ initial: "" })
        };
    }

    calcWeight() {
        return 0;
    }
}
