/**
 * MapData — first-class Map item.
 *
 * A Map carries a configured image surfaced full-screen by the map overlay
 * (chrome/chrome/map.js). Previously a subtype on `valuable`; promoted to its
 * own item type so categorization, sheet rendering, and authoring no longer
 * need the `valuable + system.type === "map"` two-step.
 */

import { baseItemSchema } from "./templates/base.mjs";

const fields = foundry.data.fields;

export class MapData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            ...baseItemSchema(),

            // Market rarity on the shared RAW availability scale.
            availability: new fields.StringField({ initial: "common" }),

            // Image shown in the chrome's full-screen map overlay.
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
