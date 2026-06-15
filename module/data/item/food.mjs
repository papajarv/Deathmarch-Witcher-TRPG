/**
 * FoodData — edible/drinkable provisions.
 *
 * Simple gear item: identity (name/img on the document), value (cost),
 * weight, availability (the shared RAW rarity scale), and a description.
 * No charges / nourishment / drunk blocks yet — the food & drink mechanic
 * (module/mechanics/foodAndDrink.mjs) currently rides on valuables; this
 * type is the standalone home those features can grow into later.
 *
 * For multi-portion stacks use `quantity`.
 */

import { baseItemSchema } from "./templates/base.mjs";

const fields = foundry.data.fields;

export class FoodData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            ...baseItemSchema(),
            // Shared AVAILABILITY scale (everywhere / common / poor / rare /
            // witcher / na) — the system's rarity concept (CONFIG.WITCHER.availability).
            availability: new fields.StringField({ initial: "common" })
        };
    }

    calcWeight() {
        return this.weight * this.quantity;
    }
}
