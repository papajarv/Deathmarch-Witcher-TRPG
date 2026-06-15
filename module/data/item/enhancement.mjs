/**
 * EnhancementData — runes, glyphs and craftsman mods that attach to a
 * weapon or armor and modify its stats (Core p.78-79, gear & craftsman
 * sections).
 *
 * A single enhancement targets ONE class of item, decided by `type`:
 *   rune   → weapon   (gear runestones)
 *   weapon → weapon   (craftsman-tree weapon augmentations)
 *   glyph  → armor    (gear glyphs)
 *   armor  → armor    (gear armor enhancements / craftsman augmentations)
 *
 * The parent weapon/armor stores a slot reference (uuid) and computes its
 * effective stats from the live enhancement in `prepareDerivedData` — the
 * base stats are never mutated, so detaching reverts cleanly. The fields
 * below are the bounded modifier vocabulary those derivations read.
 *
 * Weapon-side modifiers (rune / weapon):
 *   accuracyBonus    : number    added to WA
 *   reliabilityBonus : number    added to reliability.max
 *   damageBonus      : string    formula fragment folded into damage (e.g. "+2", "1d6")
 *   addedDamageTypes : string[]  extra damage types (e.g. an elemental rune)
 *
 * Armor-side modifiers (glyph / armor):
 *   stopping         : number    bonus SP added to every covered location
 *   slashing         : boolean   grants the matching damage-type resistance
 *   piercing         : boolean   (booleans to match ArmorData's resistances)
 *   bludgeoning      : boolean
 *   encumbranceMod   : number    EV change (negative = lighter)
 *
 * Shared:
 *   grantedQualities : string[]  catalog keys added to the parent's qualities
 *                                (WEAPON_QUALITIES for weapon-side, ARMOR_QUALITIES
 *                                for armor-side); on-hit statuses like Bleeding/Fire
 *                                live in that catalog as parameterized qualities
 *   qualityValues    : object    per-key parameter values for granted qualities
 *   effects          : HTML      free-form narrative effect text
 */

import { baseItemSchema } from "./templates/base.mjs";

const fields = foundry.data.fields;

/** Target item class per enhancement type. */
export const ENHANCEMENT_TARGET = Object.freeze({
    rune:   "weapon",
    weapon: "weapon",
    glyph:  "armor",
    armor:  "armor"
});

export class EnhancementData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            ...baseItemSchema(),
            availability: new fields.StringField({ initial: "common" }),
            type:        new fields.StringField({ initial: "rune" }),
            applied:     new fields.BooleanField({ initial: false }),
            // Runewords (Lesser) consume 2 slots, Greater 3; glyphwords likewise.
            // Plain enhancements occupy 1. The parent item sums slotCost on attach.
            slotCost:    new fields.NumberField({ initial: 1, integer: true, min: 1 }),
            // Back-reference to the parent item this is socketed into.
            // Set on attach, cleared on detach — lets the enhancement
            // sheet show "applied to X" without scanning every item.
            attachedTo:  new fields.StringField({ initial: "" }),

            /* Weapon-side */
            accuracyBonus:    new fields.NumberField({ initial: 0, integer: true }),
            reliabilityBonus: new fields.NumberField({ initial: 0, integer: true }),
            damageBonus:      new fields.StringField({ initial: "" }),
            addedDamageTypes: new fields.ArrayField(new fields.StringField(), { initial: [] }),

            /* Armor-side */
            stopping:       new fields.NumberField({ initial: 0, integer: true, min: 0 }),
            slashing:       new fields.BooleanField({ initial: false }),
            piercing:       new fields.BooleanField({ initial: false }),
            bludgeoning:    new fields.BooleanField({ initial: false }),
            encumbranceMod: new fields.NumberField({ initial: 0, integer: true }),

            /* Shared */
            grantedQualities: new fields.ArrayField(new fields.StringField(), { initial: [] }),
            qualityValues:    new fields.ObjectField({ initial: {} }),
            effects:          new fields.HTMLField({ initial: "" })
        };
    }

    /** Pre-validation migration: legacy schema stored slashing/piercing/
     *  bludgeoning as quantitative NumberFields. The new schema (matching
     *  ArmorData) makes them binary resistances — any positive value
     *  becomes true, 0/absent becomes false. */
    static migrateData(data) {
        for (const k of ["slashing", "piercing", "bludgeoning"]) {
            if (typeof data[k] === "number") data[k] = data[k] > 0;
        }
        return super.migrateData(data);
    }

    /** Which item class this enhancement attaches to ("weapon" | "armor"). */
    get target() {
        return ENHANCEMENT_TARGET[this.type] ?? "weapon";
    }

    addEffects(toAdd) {
        return this.effects + (toAdd ?? "");
    }

    calcWeight() {
        return this.weight * this.quantity;
    }
}
