/**
 * HexData — a castable curse (RAW Core p.120-122).
 *
 * Fields are structured (not free strings) so the combat engine can reason
 * about them numerically:
 *   - staminaCost / castingTime  → numbers (STA spent; cost in ACTIONS)
 *   - defense                    → enum: how the target resists (resistmagic | none)
 *   - duration                   → { value, unit } so round-based hexes auto-tick
 *   - danger                     → enum severity (low | medium | high)
 *   - components                 → item links ({uuid,name,img}), any item type
 *   - effect / liftRequirement   → narrative HTML (the descriptive trio is
 *                                  Effect + Danger + Requirements to Lift)
 */

import { baseItemSchema } from "./templates/base.mjs";

const fields = foundry.data.fields;

export class HexData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            ...baseItemSchema(),
            staminaCost: new fields.NumberField({ initial: 4, integer: true, min: 0 }),
            // Cast time as an action count — "1 action" is the number 1.
            castingTime: new fields.NumberField({ initial: 1, integer: true, min: 0 }),
            // How the target resists. Hexes are magic, so Resist Magic or
            // (for unavoidable curses) None.
            defense:     new fields.StringField({ initial: "resistmagic" }),
            range:       new fields.StringField({ initial: "" }),
            // Structured duration so combat can decrement round-based hexes.
            // unit ∈ instant | rounds | minutes | hours | days | lifted.
            duration:    new fields.SchemaField({
                value: new fields.NumberField({ initial: 0, integer: true, min: 0 }),
                unit:  new fields.StringField({ initial: "lifted" })
            }),
            // Severity rating — low | medium | high.
            danger:      new fields.StringField({ initial: "medium" }),
            effect:      new fields.HTMLField({ initial: "" }),
            // What it takes to break the curse (RAW "lifting requirement").
            liftRequirement: new fields.HTMLField({ initial: "" }),
            // Required materials, as links to real items (any type), each
            // with a quantity.
            components:  new fields.ArrayField(new fields.SchemaField({
                uuid: new fields.StringField({ required: true, blank: false }),
                name: new fields.StringField(),
                img:  new fields.StringField(),
                qty:  new fields.NumberField({ initial: 1, integer: true, min: 1 })
            }))
        };
    }

    static migrateData(data) {
        // castingTime: legacy free string "1 action" → leading integer.
        if (typeof data.castingTime === "string") {
            const n = parseInt(data.castingTime, 10);
            data.castingTime = Number.isFinite(n) ? n : 1;
        }
        // defense: legacy free string → enum.
        if (typeof data.defense === "string") {
            data.defense = /resist|magic|will/i.test(data.defense) ? "resistmagic"
                         : (data.defense.trim() === "" ? "resistmagic" : "none");
        }
        // duration: legacy free string → { value, unit }.
        if (typeof data.duration === "string") {
            const s = data.duration;
            const value = parseInt(s, 10);
            let unit = "instant";
            if (/lift|permanent|until/i.test(s)) unit = "lifted";
            else if (/round/i.test(s))           unit = "rounds";
            else if (/min/i.test(s))             unit = "minutes";
            else if (/hour/i.test(s))            unit = "hours";
            else if (/day/i.test(s))             unit = "days";
            data.duration = { value: Number.isFinite(value) ? value : 0, unit };
        }
        // components: legacy HTML string → drop (can't infer item links).
        if (typeof data.components === "string") data.components = [];
        // hexType: category was dropped — strip the orphan key.
        if ("hexType" in data) delete data.hexType;
        return super.migrateData(data);
    }

    calcWeight() {
        return 0;
    }
}
