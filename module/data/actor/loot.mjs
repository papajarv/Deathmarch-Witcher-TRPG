/**
 * LootData — TypeDataModel for inert loot pile actors.
 *
 * No stats, no skills. Just a currency pouch and embedded items (items
 * are part of the actor document itself, not the system data).
 */

import { currencySchema, calcCurrencyWeight } from "./templates/currency.mjs";

const fields = foundry.data.fields;

export class LootData extends foundry.abstract.TypeDataModel {

    static defineSchema() {
        return {
            ...currencySchema(),
            notes: new fields.HTMLField({ initial: "" })
        };
    }

    calcCurrencyWeight() {
        return calcCurrencyWeight(this.currency);
    }
}
