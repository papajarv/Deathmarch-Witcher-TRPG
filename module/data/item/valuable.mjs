/**
 * ValuableData — miscellaneous items (trophies, generic valuables).
 *
 * Schema additions over base:
 *   type : "trophy" | ""  (subtype)
 *
 * Map, Remains, and Book are no longer valuable subtypes; they live as
 * their own first-class item types (`map`, `remains`, `book`). The legacy
 * options were removed from the subtype <select>; existing items that
 * still carry one of those legacy strings render as generic valuables
 * until the migration in migrateLegacyFlags.mjs promotes them.
 *
 * The `bookConfig` field stays on the schema as a frozen migration target
 * — when the v5 migration walks the world, it reads `bookConfig` off
 * legacy valuable-books to seed the new first-class `book` documents.
 * Removing the field would strip that data before the migration could
 * read it. Once a world has run migration v5, this field is inert.
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
            })
        };
    }

    calcWeight() {
        return this.weight * this.quantity;
    }
}
