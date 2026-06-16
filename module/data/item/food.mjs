/**
 * FoodData — edible / drinkable provisions for the food & drink homebrew.
 *
 * Schema fields are ALWAYS present (ADR 0003); the homebrew toggle only
 * gates BEHAVIOR (hourly satiety drain, charge ticks on consume, drunk
 * endurance roll, taste-in-chat). So enabling, disabling, then re-enabling
 * the toggle never loses authored data.
 *
 *   kind            "meal" | "snack" | "drink" — display category. The sheet
 *                                 only surfaces the alcohol block when kind
 *                                 is "drink"; a meal can't be alcoholic by
 *                                 design (carry it as a separate drink item).
 *   description     HTML (base) — visual layer only; shown on the sheet.
 *   taste           string      — flavor line posted to chat on consume,
 *                                 distinct from description per spec.
 *   charges         {current, max}  — per-item portion tracking. When
 *                                 current → 0 the consume flow either drops
 *                                 quantity (resetting current to max) or
 *                                 deletes the item.
 *   satietyRestore  number      — satiety restored when one charge is
 *                                 eaten. 0 = pure flavor item.
 *   drunk           shape       — alcoholic items only. Mirrors the shape
 *                                 the food-and-drink mechanic reads:
 *                                   isAlcohol            bool
 *                                   dc                   Endurance DC to
 *                                                        resist drunkening
 *                                   levelJump            tiers to advance
 *                                                        on a failed save
 *                                   bypassWitcherResist  ignore the witcher
 *                                                        roll-twice rule
 *                                   flavorVerb           "drinks"/"sips"/…
 *                                   effectIcon           per-item override
 *   availability    string      — shared rarity scale.
 *
 * For multi-portion stacks use `quantity` × `charges`.
 */

import { baseItemSchema } from "./templates/base.mjs";

const fields = foundry.data.fields;

export const FOOD_KINDS = Object.freeze({
    meal:  "WITCHER.Food.KindMeal",
    snack: "WITCHER.Food.KindSnack",
    drink: "WITCHER.Food.KindDrink"
});

export class FoodData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            ...baseItemSchema(),
            // Display category. We DO NOT use `choices:` here — Foundry's
            // StringField with a choices constraint silently resets invalid
            // values to `initial` on validation, which has been observed to
            // swap drinks back to meals after drag-create (the dropped data
            // briefly fails validation during the create pipeline and
            // reverts). The dropdown UI already restricts input to the three
            // valid values; runtime code clamps via the static helper below.
            kind: new fields.StringField({ initial: "meal", blank: false }),
            // Player-facing flavor printed in chat the instant a charge is
            // consumed. Description stays sheet-only (the visual layer).
            taste: new fields.StringField({ initial: "" }),
            // Per-portion ticker; max:0 disables the charges path (the
            // consume flow falls back to the base quantity decrement).
            charges: new fields.SchemaField({
                current: new fields.NumberField({ initial: 0, integer: true, min: 0 }),
                max:     new fields.NumberField({ initial: 0, integer: true, min: 0 })
            }),
            satietyRestore: new fields.NumberField({ initial: 0, min: 0 }),
            // Alcohol metadata. isAlcohol:false on every other food disables
            // the endurance roll path cleanly. Sheet hides the editor unless
            // kind === "drink", but the schema accepts the values regardless
            // so an authoring mistake doesn't lose data on the next save.
            drunk: new fields.SchemaField({
                isAlcohol:           new fields.BooleanField({ initial: false }),
                dc:                  new fields.NumberField({ initial: 10, integer: true, min: 0 }),
                levelJump:           new fields.NumberField({ initial: 1, integer: true, min: 0 }),
                bypassWitcherResist: new fields.BooleanField({ initial: false }),
                flavorVerb:          new fields.StringField({ initial: "drinks" }),
                effectIcon:          new fields.StringField({ initial: "" })
            }),
            availability: new fields.StringField({ initial: "common" })
        };
    }

    /* Back-fill `kind` for foods authored before the field existed.
     *
     * IMPORTANT: only act when `kind` is genuinely UNDEFINED on the source.
     * Foundry calls migrateData with PARTIAL DIFF data during updates
     * (`item.update({ "system.charges.current": N })` → the diff has no
     * `kind` key). A previous version of this fix treated any non-canonical
     * value (including undefined-in-the-diff) as "needs clamp" and reset
     * drinks/snacks back to "meal" every time a charge was consumed. The
     * narrower undefined-only check mirrors DiagramsData.migrateData and is
     * safe for both initial load (no kind on legacy items) and partial
     * updates (no spurious overwrite). */
    static migrateData(data) {
        if (data?.kind === undefined) {
            data.kind = data?.drunk?.isAlcohol ? "drink" : "meal";
        }
        return super.migrateData(data);
    }

    /* Weight / cost both scale by the portion ratio. A half-eaten loaf
     * weighs half as much; the partially-empty wine bottle is worth half
     * as much. Math: (quantity - 1) full units + the top unit's portion
     * ratio. If charges aren't configured (max === 0) we fall back to the
     * plain quantity total. */
    calcWeight() {
        return this.weight * this.#unitMultiplier();
    }

    calcCost() {
        return this.cost * this.#unitMultiplier();
    }

    /* Effective unit count across the stack, accounting for partial top
     * portion. Exposed so inventory readers can show the same number on
     * the tile / inspect card the carry-weight tally uses. */
    get effectiveUnits() {
        return this.#unitMultiplier();
    }

    #unitMultiplier() {
        const qty = Number(this.quantity) || 0;
        if (qty <= 0) return 0;
        const max = Number(this.charges?.max) || 0;
        if (max <= 0) return qty;
        const cur = Math.max(0, Math.min(max, Number(this.charges?.current) || 0));
        // (qty - 1) full units + the top-of-stack ratio.
        return (qty - 1) + (cur / max);
    }
}
