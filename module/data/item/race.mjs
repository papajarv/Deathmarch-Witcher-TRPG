/**
 * RaceData — a race item dropped on a character. Carries:
 *   - four "quality" boxes describing the race's defining traits
 *     (name + description each), and
 *   - any number of Foundry ActiveEffects that transfer to the actor
 *     (transfer:true is the sheet default — see WitcherItemSheet).
 *
 * The mechanical stat changes live in the effects; the quality boxes are
 * the human-readable description of what the race grants.
 */

import { baseItemSchema } from "./templates/base.mjs";

const fields = foundry.data.fields;

/* One quality box — a short title + a description. */
function raceQuality() {
    return new fields.SchemaField({
        name:        new fields.StringField({ initial: "" }),
        description: new fields.HTMLField({ initial: "" })
    });
}

export class RaceData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            ...baseItemSchema(),
            // The four race-quality boxes.
            qualities: new fields.SchemaField({
                box1: raceQuality(),
                box2: raceQuality(),
                box3: raceQuality(),
                box4: raceQuality()
            }),

            // Opt-in: when a character owns a race with this checked, the
            // character chrome shows a "Variable portrait" button that swaps
            // actor.img across toxicity tiers / conditions. See
            // module/chrome/integrations/portrait-toxicity.js.
            variablePortrait: new fields.BooleanField({ initial: false }),

            // Lords & Land p.9 Halflings: cannot channel magic (no Mage/Priest),
            // Witcher & magic potions never benefit them, immune to Blue Mutagens.
            // Defaults false so existing races are unaffected. Enforcement is
            // later behavior; the schema records intent.
            noMagicProfession: new fields.BooleanField({ initial: false }),
            potionImmune:      new fields.BooleanField({ initial: false }),
            blueMutagenImmune: new fields.BooleanField({ initial: false })
        };
    }

    calcWeight() {
        return 0;
    }
}
