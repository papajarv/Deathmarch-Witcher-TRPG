/**
 * AlchemicalData — finished alchemy products (potions, oils, decoctions,
 * bombs, poisons). RAW Core p.83-95.
 *
 * Alchemical items are single-use unless noted (Core p.87). Multi-dose
 * items just bump `quantity`.
 *
 * Alchemy Reborn (homebrew `alchemyPotency`): an alchemical item can ALSO
 * be authored as a brew BASE — typically oil bases (Sunflower Oil etc.)
 * sit here. The `alchemyBase` block holds the GM-set base kind and DC
 * modifier; the chrome brew wheel pulls it via `mechanics/alchemy.readBase`
 * when a player drags / selects this item as the formula's base. With the
 * toggle OFF the block stays in the schema (ADR 0003) and is ignored.
 */

import { baseItemSchema }   from "./templates/base.mjs";

const fields = foundry.data.fields;

export class AlchemicalData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            ...baseItemSchema(),

            // Type — potion / oil / decoction / bomb / item / other
            // (Core p.87 introduces categories; specifics live in the
            // category's section pp.84-95).
            type:     new fields.StringField({ initial: "potion" }),

            // Toxicity contribution when consumed (Core p.84 — potions
            // and decoctions add their Toxicity to the character's pool;
            // pool > 100 → damage). Oils, bombs, etc. contribute 0.
            toxicity: new fields.NumberField({ initial: 0, integer: true, min: 0 }),

            // Mechanical effect description + duration (RAW each item
            // sidebar).
            effects:  new fields.HTMLField({ initial: "" }),
            duration: new fields.StringField({ initial: "" }),

            // For bombs and other AOE items (Core p.88 bomb section).
            // `range` is free-form text — bomb throwing range is often a
            // formula like "BODYx4" rather than a fixed number.
            damage:     new fields.StringField({ initial: "" }),
            damageType: new fields.StringField({ initial: "" }),
            range:      new fields.StringField({ initial: "" }),
            area:       new fields.NumberField({ initial: 0, integer: true, min: 0 }),

            // Crafting metadata — the diagram that produces this item has
            // its own DC; storing the originating DC here lets us echo it
            // in chat cards (Core p.124+).
            craftingDC: new fields.NumberField({ initial: 0, integer: true, min: 0 }),

            // Availability + concealment per RAW p.73 conventions.
            availability: new fields.StringField({ initial: "common" }),
            conceal:      new fields.StringField({ initial: "S" }),

            // ── Alchemy Reborn: brew base configuration ────────────────
            // enabled  : GM ticked this item as usable as a brew base
            //            (otherwise the wheel doesn't show it). Default
            //            false so authoring an alchemical item doesn't
            //            silently make it a base.
            // baseType : which brew the base is valid for (potion / oil /
            //            bomb / decoction). Empty = unspecified.
            // baseMod  : flat DC adjustment applied by computeEffectiveDC
            //            when this base is picked. Negative = easier brew.
            alchemyBase: new fields.SchemaField({
                enabled:  new fields.BooleanField({ initial: false }),
                baseType: new fields.StringField({ initial: "", blank: true }),
                baseMod:  new fields.NumberField({ initial: 0, integer: true })
            }),

            // ── Oil-specific authoring fields ─────────────────────────
            // Only meaningful when `type === "oil"`. Schema stays present
            // for every alchemical (ADR 0003); the sheet hides them for
            // non-oil subtypes. Replaces the AE-on-oil approach: an oil
            // item now declares WHAT category of target it damages and
            // by HOW MUCH, instead of being a black-box bundle of effects
            // the GM has to author per-oil.
            //   oilTarget       : monster category key (humanoid, beast,
            //                     specter, …). Empty = applies to every
            //                     target ("universal" oil — rare but
            //                     allowed). Matched against the target's
            //                     `system.category` at damage time.
            //   oilBonusDamage  : flat HP added to the weapon's roll on
            //                     a target-match. Folded into weaponDamage
            //                     by the attack flow; armour soaks it the
            //                     same way it soaks the base hit.
            //   oilDuration     : RAW-only structured duration. value +
            //                     units (seconds / minutes / hours / days)
            //                     define how long a coating lasts; the
            //                     applyOilToWeapon flow stamps an expire-
            //                     at worldTime onto the weapon and the
            //                     sweep clears it. Under Alchemy Reborn
            //                     this is ignored — charges replace
            //                     duration.
            oilTarget:      new fields.StringField({ initial: "", blank: true }),
            oilBonusDamage: new fields.NumberField({ initial: 0, integer: true, min: 0 }),
            oilDuration:    new fields.SchemaField({
                value: new fields.NumberField({ initial: 30, integer: true, min: 0 }),
                units: new fields.StringField({ initial: "minutes", blank: true })
            }),
            // Alchemy Reborn — number of successful-hit charges the
            // coating carries. Authored directly on the oil item (the
            // install macro pre-fills Normal=5 / Enhanced=10 / Superior=15
            // per the source-sheet table; GMs can author whatever they
            // want for custom oils). Ignored in RAW — `oilDuration`
            // drives expiry instead. 0 falls back to a sensible default
            // (5) so a GM enabling Reborn on a freshly-authored oil
            // doesn't get a zero-charge coating that depletes on the
            // first hit.
            oilCharges:     new fields.NumberField({ initial: 5, integer: true, min: 0 })
            // No `potency` field on alchemical: potency is an INPUT property
            // of ingredients (components + mutagens), not a property of
            // brewed output. Quality tier of a finished brew is encoded in
            // the item name suffix ("(Normal)" / "(Enhanced)" / "(Superior)")
            // and read by oilTierFromPotency directly off the name.
        };
    }

    calcWeight() {
        return this.weight * this.quantity;
    }

    /* Legacy migrations:
     *  - "poison" → "substance" → "item" (the subtype now reads
     *    "Alchemical Item"); fold both legacy keys forward.
     *  - `range` changed from number to free-form string; a stored 0
     *    becomes "" so it doesn't render as a literal "0".
     *  - alchemy-craft top-level `baseType` / `baseMod` → nested
     *    `alchemyBase.{baseType, baseMod}` + `enabled: true` (since the
     *    presence of a top-level baseType was the legacy enable signal).
     *    Existing alchemy.mjs readBase() reads the old top-level path as
     *    a fallback so a half-migrated item still resolves. */
    static migrateData(data) {
        if (data?.type === "poison" || data?.type === "substance") data.type = "item";
        if (typeof data?.range === "number") data.range = data.range ? String(data.range) : "";
        const hasLegacyBase = (data?.baseType !== undefined) || (data?.baseMod !== undefined);
        if (hasLegacyBase && !data?.alchemyBase) {
            data.alchemyBase = {
                enabled:  !!data.baseType,
                baseType: String(data.baseType ?? ""),
                baseMod:  Number(data.baseMod) || 0
            };
        }
        /* Potion and Decoction bases are mechanically identical (same +50%
         * charge gate, same DC-mod scale, same wheel category since
         * detectFormulaCategory collapses decoction → potion). The base
         * dropdown only offers "Potion / Decoction" now, so any stored
         * legacy "decoction" baseType folds into "potion" — both the
         * nested alchemyBase shape and the legacy top-level field. */
        if (data?.alchemyBase?.baseType === "decoction") data.alchemyBase.baseType = "potion";
        if (data?.baseType === "decoction") data.baseType = "potion";
        return super.migrateData(data);
    }
}
