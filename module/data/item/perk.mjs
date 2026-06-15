/**
 * PerkData — a minimal "perk" item: an icon, a description, and a place to hang
 * a transfer:true Active Effect. Used for miscellaneous character grants (life-
 * event modifiers, witcher-school bonuses, etc.) that live under Race & Homeland.
 * Non-encumbering; the real mechanics ride on the attached AE.
 */

import { baseItemSchema } from "./templates/base.mjs";

export class PerkData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            ...baseItemSchema()
        };
    }

    calcWeight() {
        return 0;
    }
}
