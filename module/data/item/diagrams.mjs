/**
 * DiagramsData — crafting blueprints, alchemy formulae, and cooking recipes
 * (Core p.127-146; recipes added by the food & drink homebrew, though the
 * schema is universal per ADR 0003 — `kind === "recipe"` is always valid).
 *
 *   kind        : "diagram" | "formula" | "recipe"
 *                 - diagram  → crafting blueprint (weapons/armor/traps);
 *                              specific named ingredients; rolled against
 *                              Crafting (or Trap Crafting for traps).
 *                 - formula  → alchemy formula (potions/oils/bombs/decoctions);
 *                              uses the nine substances; rolled against Alchemy.
 *                 - recipe   → cooking recipe (homebrew food & drink); produces
 *                              a food item; rolled against the Cooking skill.
 *   level       : "novice" | "journeyman" | "master" | "grandmaster" — the
 *                  rulebook tier groupings.
 *   type        : sub-type (potion/oil/bomb/weapon/armor/…) used for crafting-
 *                  panel grouping. The valid options depend on `kind`.
 *   alchemyDC   : craft DC for formulae (Alchemy roll). Recipes also use this
 *                  field for the Cooking DC (rolled vs Cooking skill) so a GM
 *                  doesn't have to duplicate it; the sheet relabels.
 *   craftingDC  : craft DC for crafting diagrams (Crafting roll).
 *   craftingTime : display string, e.g. "1 Hour", "2 Days".
 *   investment   : crowns paid to speed up the craft (Core p.130).
 *   availability : market availability (shared AVAILABILITY enum).
 *   alchemyComponents  : { [substance]: qty } — formula substance reqs.
 *                         Reused by recipes too (a "spices" / "broth" substance
 *                         set could be wired here later).
 *   craftingComponents : [{ uuid?, name, quantity }, …] — ingredient links.
 *                         Recipes use this for the raw food ingredients.
 *   associatedItem : { name, uuid, img } — the item produced.
 *   learned        : whether memorized (craftable without the paper).
 *
 * Backwards-compat: the original boolean `isFormulae` is kept as a transient
 * field+getter so any code path still reading it sees a sensible value during
 * the rollover. New code should switch on `kind`.
 *
 * The potency-tier outputs (Normal / Enhanced / Superior) from
 * witcher-alchemy-craft are removed under RAW-only mode. RAW diagrams produce
 * one item; if quality matters, author it as a separate diagram / recipe.
 */

import { baseItemSchema }            from "./templates/base.mjs";
import { craftingComponentsSchema } from "./templates/craftingComponents.mjs";

const fields = foundry.data.fields;

export const DIAGRAM_KINDS = Object.freeze({
    diagram: "WITCHER.Crafting.KindDiagram",
    formula: "WITCHER.Crafting.KindFormula",
    recipe:  "WITCHER.Crafting.KindRecipe"
});

export class DiagramsData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            ...baseItemSchema(),
            ...craftingComponentsSchema(),
            kind: new fields.StringField({
                initial: "diagram",
                choices: Object.keys(DIAGRAM_KINDS)
            }),
            level:        new fields.StringField({ initial: "novice" }),
            type:         new fields.StringField({ initial: "" }),
            alchemyDC:    new fields.NumberField({ initial: 0, integer: true, min: 0 }),
            craftingDC:   new fields.NumberField({ initial: 0, integer: true, min: 0 }),
            // Metalwork — when true the craft needs a Forge, not just a Crafting
            // kit. Drives the tool label/penalty on the crafting panel. Alchemy
            // formulae always need an Alchemy set, recipes always need a Cooking
            // pot — so this flag is only meaningful for `kind === "diagram"`.
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

    /**
     * Back-compat shim: pre-redesign code reads `system.isFormulae`. Until
     * every reader is on `kind`, expose it as a derived boolean.
     */
    get isFormulae() {
        return this.kind === "formula";
    }

    /* migrateData maps:
     *   - existing `kind` → keep as-is.
     *   - legacy `isFormulae === true` → kind: "formula".
     *   - missing isFormulae but an alchemy sub-type / substance map present
     *     (the old back-fill rule) → kind: "formula".
     *   - everything else → kind: "diagram".
     * Recipes can only exist on freshly-authored items — there is no legacy
     * recipe data to migrate from.
     */
    static migrateData(data) {
        if (data?.kind === undefined) {
            let inferred = "diagram";
            if (data?.isFormulae === true) {
                inferred = "formula";
            } else if (data?.isFormulae === undefined) {
                const t = String(data?.type ?? "").toLowerCase();
                const hasSubs = data?.alchemyComponents
                    && Object.keys(data.alchemyComponents).length > 0;
                if (["potion", "oil", "bomb", "decoction"].includes(t) || hasSubs) {
                    inferred = "formula";
                }
            }
            data.kind = inferred;
        }
        return super.migrateData(data);
    }

    calcWeight() {
        return this.weight * this.quantity;
    }
}
