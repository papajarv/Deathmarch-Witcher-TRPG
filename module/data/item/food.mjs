/**
 * FoodData — edible / drinkable provisions for the food & drink homebrew.
 *
 * Schema fields are ALWAYS present (ADR 0003); the homebrew toggle only
 * gates BEHAVIOR (hourly satiety drain, charge ticks on consume, drunk
 * endurance roll, taste-in-chat). So enabling, disabling, then re-enabling
 * the toggle never loses authored data.
 *
 *   kind            "meal" | "drink" — display category. The sheet only
 *                                 surfaces the alcohol block when kind is
 *                                 "drink"; a meal can't be alcoholic by
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
    meal:       "WITCHER.Food.KindMeal",
    drink:      "WITCHER.Food.KindDrink",
    // Raw ingredient — for cooking recipe inputs. Functionally identical to
    // a meal at the schema level (charges, satiety, effects all valid) so
    // a GM can still author a "raw apple" that grants a little satiety on
    // consume; the kind tag is what flags it as a recipe-eligible input.
    ingredient: "WITCHER.Food.KindIngredient"
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
            //
            // NOTE: the legacy `bypassWitcherResist` field was removed — the
            // witcher-resistance roll-twice perk is now data-driven via the AE
            // editor's `alcoholRollAdvantage` action attached to the Witcher
            // race / a perk / etc. Stale `bypassWitcherResist` values on
            // pre-migration items are silently dropped on the next save.
            drunk: new fields.SchemaField({
                isAlcohol:  new fields.BooleanField({ initial: false }),
                dc:         new fields.NumberField({ initial: 10, integer: true, min: 0 }),
                levelJump:  new fields.NumberField({ initial: 1, integer: true, min: 0 }),
                flavorVerb: new fields.StringField({ initial: "drinks" }),
                effectIcon: new fields.StringField({ initial: "" })
            }),
            // Ingredient metadata — only meaningful when `kind === "ingredient"`.
            // Edible: when off, consuming the raw ingredient is refused; when
            //         on, the satiety/effects path runs as it does for meals.
            // MakesSick: when on, consuming routes through the spoiled-food
            //            hazard (Endurance vs DC 14; fail = Food Sickness AE).
            //            Stacks with edible — an edible-but-sickening item
            //            grants satiety AND triggers the save.
            // Schema is always present (ADR 0003); the sheet hides the block
            // for non-ingredient kinds.
            ingredient: new fields.SchemaField({
                edible:    new fields.BooleanField({ initial: false }),
                makesSick: new fields.BooleanField({ initial: false })
            }),
            // Spoilage. shelfLifeDays === 0 disables tracking entirely (the
            // food is treated as "fresh forever"); a positive number is the
            // in-game day budget after the freshness clock starts. anchorTime
            // is stamped automatically when the item is FIRST acquired by an
            // actor (see stampFreshnessAnchor in mechanics/foodAndDrink.mjs);
            // sidebar items stay un-anchored (null = no aging in the world
            // template). The anchor SURVIVES transfers between actors so a
            // half-spoiled loaf doesn't reset when traded.
            freshness: new fields.SchemaField({
                shelfLifeDays: new fields.NumberField({ initial: 0, min: 0 }),
                anchorTime:    new fields.NumberField({ initial: null, nullable: true, required: false })
            }),
            availability: new fields.StringField({ initial: "common" })
        };
    }

    /* Back-fill `kind` for foods authored before the field existed.
     *
     * IMPORTANT: migrateData fires in two scenarios in Foundry v14:
     *   1. Document construction from the full persisted source (legit
     *      migration target — kind may genuinely be missing on legacy data).
     *   2. Update validation when item.update() is called with a partial
     *      diff (the diff is merged with existing source first, but in
     *      practice some Foundry code paths hand the raw diff to validators
     *      instead of the merged shape). A partial diff for
     *      `system.charges.current` has neither `kind` NOR any other field —
     *      so the original "kind undefined → default to meal" check fires
     *      and resets drinks to meals on every charge tick.
     *
     * Guard: require BOTH `kind === undefined` AND at least one always-
     * present base field (quantity) in the data. If the data carries no
     * quantity, it's a partial diff, not a full source — skip migration. */
    static migrateData(data) {
        // Heuristic: a FULL source has every base schema field initialized
        // by `defineSchema()`. A partial update diff (e.g. `{ quantity: 5 }`
        // from an inventory stack merge) has only the touched keys, so the
        // SchemaField for `drunk` reads undefined. Require BOTH a `drunk`
        // object AND an `availability` string to be present before treating
        // `data.kind === undefined` as legacy-data-needing-backfill. This
        // is the conservative check; missing it caused stacked foods to
        // reset to meal on every quantity bump.
        const looksLikeFullSource = data?.drunk !== undefined
                                 && data?.availability !== undefined;
        if (looksLikeFullSource && data?.kind === undefined) {
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
