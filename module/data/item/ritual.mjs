/**
 * RitualData — a castable ritual (RAW Core p.116-119).
 *
 * Fields are structured (not free strings) so the combat / cast flow can
 * reason about them numerically — mirrors HexData:
 *   - staminaCost                → number (STA spent)
 *   - difficulty / variableDC    → the Ritual Crafting check DC; some rituals
 *                                  scale the DC to the task (Cleansing 12/15/18),
 *                                  flagged variableDC so the flow prompts
 *   - castingTime                → { value, unit } preparation time
 *   - duration                   → { value, unit } so persistent rituals tick
 *   - tier / school              → enums (graded by Ritual Crafting rank;
 *                                  draws on a magic school)
 *   - components                 → item links ({uuid,name,img}), any item type
 *   - effect                     → narrative HTML
 */

import { baseItemSchema } from "./templates/base.mjs";

const fields = foundry.data.fields;

export class RitualData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            ...baseItemSchema(),
            staminaCost: new fields.NumberField({ initial: 3, integer: true, min: 0 }),
            // The Ritual Crafting check DC. When variableDC is true the number
            // is a default suggestion and the cast flow should prompt for the
            // task-appropriate DC instead (Core: Cleansing 12 / 15 / 18).
            difficulty:  new fields.NumberField({ initial: 14, integer: true, min: 0 }),
            variableDC:  new fields.BooleanField({ initial: false }),
            // Preparation time, structured {value, unit}.
            // unit ∈ rounds | minutes | hours | days.
            castingTime: new fields.SchemaField({
                value: new fields.NumberField({ initial: 5, integer: true, min: 0 }),
                unit:  new fields.StringField({ initial: "rounds" })
            }),
            range:       new fields.StringField({ initial: "" }),
            // Effect duration, structured so persistent rituals can tick.
            // unit ∈ instant | rounds | minutes | hours | days | permanent.
            duration:    new fields.SchemaField({
                value: new fields.NumberField({ initial: 0, integer: true, min: 0 }),
                unit:  new fields.StringField({ initial: "instant" })
            }),
            // RAW grade — gates the Ritual Crafting rank needed to attempt it.
            tier:        new fields.StringField({ initial: "novice" }),
            school:      new fields.StringField({ initial: "mixed" }),
            effect:      new fields.HTMLField({ initial: "" }),
            // Required materials, as links to real items (any type), each
            // with a quantity (RAW lists "Chalk (x2)" etc.).
            components:  new fields.ArrayField(new fields.SchemaField({
                uuid: new fields.StringField({ required: true, blank: false }),
                name: new fields.StringField(),
                img:  new fields.StringField(),
                qty:  new fields.NumberField({ initial: 1, integer: true, min: 1 })
            }))
        };
    }

    static migrateData(data) {
        // castingTime: legacy free string "5 Rounds" → { value, unit }.
        if (typeof data.castingTime === "string") {
            const s = data.castingTime;
            const value = parseInt(s, 10);
            let unit = "rounds";
            if (/day/i.test(s))       unit = "days";
            else if (/hour/i.test(s)) unit = "hours";
            else if (/min/i.test(s))  unit = "minutes";
            data.castingTime = { value: Number.isFinite(value) ? value : 5, unit };
        }
        // duration: legacy free string → { value, unit }.
        if (typeof data.duration === "string") {
            const s = data.duration;
            const value = parseInt(s, 10);
            let unit = "instant";
            if (/perm|until|indefinit/i.test(s)) unit = "permanent";
            else if (/round/i.test(s))           unit = "rounds";
            else if (/day/i.test(s))             unit = "days";
            else if (/hour/i.test(s))            unit = "hours";
            else if (/min/i.test(s))             unit = "minutes";
            data.duration = { value: Number.isFinite(value) ? value : 0, unit };
        }
        // components: legacy HTML string → drop (can't infer item links).
        if (typeof data.components === "string") data.components = [];
        // ritualType: free-text category dropped in favor of tier/school.
        if ("ritualType" in data) delete data.ritualType;
        return super.migrateData(data);
    }

    calcWeight() {
        return 0;
    }
}
