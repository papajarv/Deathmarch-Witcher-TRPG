/**
 * FocusData — a spellcasting focus item.
 *
 * Equippable in an armor slot (it occupies a slot but is NOT an SP layer).
 * Carries a Focus value (reduces a spell's STA cost, min 1) and/or a Greater
 * Focus value (adds to the spellcasting roll). It derives
 * `effective.qualities` / `effective.qualityValues` so the cast flow reads a
 * Focus item exactly the same way it reads the Focus / Greater Focus quality
 * on weapons and armor — one code path, no special-casing by type.
 */

import { baseItemSchema } from "./templates/base.mjs";

const fields = foundry.data.fields;

export class FocusData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            ...baseItemSchema(),
            // Market rarity on the shared RAW availability scale
            // (CONFIG.WITCHER.availability: everywhere / common / poor / rare …).
            // Drives the rarity-flair wash like every other gear item.
            availability: new fields.StringField({ initial: "common" }),
            // STA-cost reduction when cast through (min spell cost is always 1).
            focus:        new fields.NumberField({ initial: 0, integer: true, min: 0 }),
            // Spellcasting-roll bonus when cast through.
            greaterFocus: new fields.NumberField({ initial: 0, integer: true, min: 0 })
        };
    }

    /* Mirror the two numeric fields into the shared effective-quality shape the
     * casting code consumes (`effective.qualities` + `effective.qualityValues`),
     * so a Focus item is indistinguishable from a weapon/armor carrying the
     * Focus / Greater Focus quality at the read layer. */
    prepareDerivedData() {
        const focus        = Math.max(0, Number(this.focus) || 0);
        const greaterFocus = Math.max(0, Number(this.greaterFocus) || 0);
        const qualities = [];
        if (focus > 0)        qualities.push("focus");
        if (greaterFocus > 0) qualities.push("greaterFocus");
        this.effective = { qualities, qualityValues: { focus, greaterFocus } };
    }

    calcWeight() {
        return (Number(this.weight) || 0) * (Number(this.quantity) || 1);
    }
}
