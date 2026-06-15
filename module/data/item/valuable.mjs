/**
 * ValuableData — miscellaneous items (books, maps, remains).
 *
 * Schema additions over base:
 *   type : "map" | "remains" | "book" | ""  (subtype)
 *
 * Homebrew (ADR 0003): the book system stores its configuration on
 * valuables of subtype "book". The book mechanic is opt-in via
 * isHomebrewEnabled("bookSystem"); the schema field is always present so
 * disabling+re-enabling doesn't lose configuration.
 *
 * bookConfig shape:
 *   bookType : "monster" | "skill" | "stress"
 *   monster / skill / stress : per-type ObjectField
 *
 * RAW-only system: no charges / drunk / alchemyBase blocks. For
 * multi-dose items use `quantity`.
 */

import { baseItemSchema } from "./templates/base.mjs";

const fields = foundry.data.fields;

export class ValuableData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            ...baseItemSchema(),
            type: new fields.StringField({ initial: "" }),

            // Market rarity on the shared RAW availability scale
            // (CONFIG.WITCHER.availability: everywhere / common / poor / rare …).
            availability: new fields.StringField({ initial: "common" }),

            // Homebrew (bookSystem): book configuration
            bookConfig: new fields.SchemaField({
                bookType: new fields.StringField({ initial: "monster" }),
                monster:  new fields.ObjectField({ initial: {} }),
                skill:    new fields.ObjectField({ initial: {} }),
                stress:   new fields.ObjectField({ initial: {} })
            }),

            // Subtype "trophy": magical monster trophies (A Tome of Chaos
            // pp.124-125), created by the Imbue Trophy ritual. The trophy's
            // benefit is authored as ordinary transfer Active Effects on the
            // item itself (added through the sheet's effects list) and applies
            // to the holder while carried — no bespoke effect/active fields.
            // Only the source-monster category is metadata.
            trophyConfig: new fields.SchemaField({
                monsterCategory: new fields.StringField({ initial: "" })
            }),

            // When type === "remains", monsterUuid points to the source
            // monster actor (overhaul-ui monster-remains.js:156).
            monsterUuid: new fields.StringField({ initial: "" }),

            // Map image path for type === "map"
            // (overhaul-ui valuable-map.js MAP_IMAGE_FLAG → field).
            mapImage: new fields.FilePathField({
                categories: ["IMAGE"],
                required: false
            })
        };
    }

    calcWeight() {
        return this.weight * this.quantity;
    }
}
