/**
 * HomelandData — character region of origin (Core p.43-44). In RAW a
 * homeland grants a small fixed bonus tied to where the character is from
 * (a +1 to a stat or skill). That bonus is modeled as a Foundry
 * ActiveEffect on the item (transfer:true), so the schema itself is just
 * the base item shell (name/img/description live there) plus a zero weight.
 */

import { baseItemSchema } from "./templates/base.mjs";

export class HomelandData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            ...baseItemSchema()
        };
    }

    calcWeight() {
        return 0;
    }
}
