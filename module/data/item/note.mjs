/**
 * NoteData — simple HTML note. Non-encumbering.
 */

import { baseItemSchema } from "./templates/base.mjs";

export class NoteData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            ...baseItemSchema()
        };
    }

    calcWeight() {
        return 0;
    }
}
