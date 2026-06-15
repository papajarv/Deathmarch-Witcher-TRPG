/**
 * DiagramsData — crafting blueprints and alchemy formulae (Core p.127-146).
 *
 *   isFormulae  : false → crafting diagram (weapons/armor/traps; uses
 *                 specific ingredients). true → alchemical formula
 *                 (potions/oils/bombs/decoctions; uses the nine substances).
 *   level       : "novice" | "journeyman" | "master" | "grandmaster"
 *                 — the rulebook groups every recipe by these tiers.
 *   type        : sub-type used for the crafting screen's section
 *                 grouping. Formulae: potion/oil/bomb/decoction. Diagrams:
 *                 weapon/armor/armor-enhancement/ammunition/traps/… Kept as
 *                 the existing field because chrome/crafting.js groups on it.
 *   alchemyDC   : craft DC for formulae (Alchemy roll).
 *   craftingDC  : craft DC for diagrams (Crafting roll). The sheet surfaces
 *                 ONE "DC to craft" bound to whichever the isFormulae flag
 *                 selects; both fields persist for crafting.js.
 *   craftingTime : display string, e.g. "1 Hour", "2 Days".
 *   investment   : crowns paid to speed up the craft (Core p.130).
 *   availability : market availability (shared AVAILABILITY enum).
 *   alchemyComponents  : { [substance]: qty } — formulae substance reqs.
 *   craftingComponents : [{ uuid?, name, quantity }, …] — ingredient links.
 *   associatedItem : { name, uuid, img } — the item produced.
 *   learned        : whether memorized (craftable without the paper).
 *
 * The potency-tier outputs (Normal / Enhanced / Superior) from
 * witcher-alchemy-craft are removed under RAW-only mode. RAW diagrams
 * produce one item; if quality matters, author it as a separate diagram.
 */

import { baseItemSchema }            from "./templates/base.mjs";
import { craftingComponentsSchema } from "./templates/craftingComponents.mjs";

const fields = foundry.data.fields;

export class DiagramsData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            ...baseItemSchema(),
            ...craftingComponentsSchema(),
            isFormulae:   new fields.BooleanField({ initial: false }),
            level:        new fields.StringField({ initial: "novice" }),
            type:         new fields.StringField({ initial: "" }),
            alchemyDC:    new fields.NumberField({ initial: 0, integer: true, min: 0 }),
            craftingDC:   new fields.NumberField({ initial: 0, integer: true, min: 0 }),
            // Metalwork — when true the craft needs a Forge, not just a Crafting
            // kit. Drives the tool label/penalty on the crafting panel. Alchemy
            // formulae always need an Alchemy set (isFormulae), so this is the
            // only material flag needed.
            requiresForge: new fields.BooleanField({ initial: false }),
            investment:   new fields.NumberField({ initial: 0, integer: true, min: 0 }),
            availability: new fields.StringField({ initial: "common" }),
            learned:      new fields.BooleanField({ initial: false }),
            craftingTime: new fields.StringField({ initial: "" }),
            associatedItem: new fields.SchemaField({
                name: new fields.StringField({ initial: "" }),
                uuid: new fields.StringField({ initial: "" }),
                img:  new fields.FilePathField({
                    categories: ["IMAGE"],
                    required: false
                })
            }),
            // Migration anchor — original diagram id on cloned learned
            // copies (from witcher-overhaul-ui's "memorize" flow). Kept
            // because old worlds carry this value on memorized diagrams.
            memorizedFrom: new fields.StringField({ initial: "" })
        };
    }

    /* Back-fill isFormulae for diagrams authored before the flag existed:
     * an alchemy sub-type (potion/oil/bomb/decoction) or any substance
     * requirement means it was a formula. */
    static migrateData(data) {
        if (data?.isFormulae === undefined) {
            const t = String(data?.type ?? "").toLowerCase();
            const hasSubs = data?.alchemyComponents
                && Object.keys(data.alchemyComponents).length > 0;
            if (["potion", "oil", "bomb", "decoction"].includes(t) || hasSubs) {
                data.isFormulae = true;
            }
        }
        return super.migrateData(data);
    }

    calcWeight() {
        return this.weight * this.quantity;
    }
}
