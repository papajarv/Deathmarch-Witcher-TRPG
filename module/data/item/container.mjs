/**
 * ContainerData — TypeDataModel for inventory containers (bags, satchels).
 *
 * Schema additions over base (from docs/compatibility.md §3 / container):
 *   content       : [uuid, …]                   contained items by UUID
 *   itemContent   : [{ name, img, weight, … }]  cached metadata (overhaul-ui)
 *   carry         : number                       capacity in kg
 *   storedWeight  : number                       current load (derived)
 *
 * `prepareDerivedData` will rebuild `storedWeight` by resolving `content`
 * UUIDs and summing their `calcWeight()`. Phase 5 fills it in; current
 * stub returns 0 to keep documents creating cleanly.
 *
 * Note: overhaul-ui's containerData.js historically had a `fromUuidSync`
 * crash on missing items (see project_witcher_kb memory). Our
 * implementation guards against missing references.
 */

import { baseItemSchema } from "./templates/base.mjs";

const fields = foundry.data.fields;

export class ContainerData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            ...baseItemSchema(),
            content:     new fields.ArrayField(new fields.StringField()),
            itemContent: new fields.ArrayField(new fields.ObjectField()),
            carry:       new fields.NumberField({ initial: 0, min: 0 }),
            storedWeight: new fields.NumberField({ initial: 0, min: 0 })
        };
    }

    prepareDerivedData() {
        // Phase 5: resolve content UUIDs (with null-guard), sum calcWeight,
        // write to this.storedWeight.
    }

    calcWeight() {
        // Container itself + (Phase 5) optionally its contents
        return this.weight * this.quantity;
    }
}
