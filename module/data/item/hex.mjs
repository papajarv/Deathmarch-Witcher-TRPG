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
            // Structured damage the hex deals on a successful weave. Empty
            // formula = non-damaging (nearly all RAW hexes fall here — the
            // 12 corpus items all impose long-term status penalties, not
            // HP damage). Same shape as SpellData.damageFormula, including
            // {sta}/{margin} placeholder support for future scaling.
            damageFormula: new fields.StringField({ initial: "" }),
            damageElement: new fields.StringField({ initial: "none" }),
            damageType:    new fields.StringField({ initial: "none" }),
            // Tangibility — see spell.mjs. Hexes are typically INTANGIBLE
            // (curses working through magic rather than physical impact),
            // so the default is FALSE for hexes. Author flips it on for
            // the rare hex that delivers physical damage.
            tangible: new fields.BooleanField({ initial: false }),
            // Area shape + size — used for cursed-area hexes (none currently
            // in RAW; kept for parity with SpellData in case a GM authors
            // an area-effect hex).
            areaShape: new fields.StringField({ initial: "none" }),
            areaSize:  new fields.NumberField({ initial: 0, integer: false, min: 0 }),
            // See SpellData.areaAnchor. Caster-anchored curses (an aura
            // around the hexer) vs free-placed (a cursed patch of ground
            // in the distance). Default caster.
            areaAnchor: new fields.StringField({ initial: "caster" }),
            // Status effect riders — mirrors SpellData (see spell.mjs for
            // full docs on mode / stripOnExit / staScale semantics).
            statusRiders: new fields.ArrayField(new fields.SchemaField({
                statusId:    new fields.StringField({ required: true, blank: false }),
                chance:      new fields.NumberField({ initial: 100, integer: true, min: 0, max: 100 }),
                duration:    new fields.SchemaField({
                    value: new fields.StringField({ initial: "" }),
                    unit:  new fields.StringField({ initial: "instant" })
                }),
                mode:        new fields.StringField({ initial: "onHit" }),
                stripOnExit: new fields.BooleanField({ initial: true }),
                staScale:    new fields.SchemaField({
                    offset:  new fields.NumberField({ initial: 0, integer: true }),
                    divisor: new fields.NumberField({ initial: 1, integer: true, min: 1 }),
                    cap:     new fields.NumberField({ initial: 0, integer: true })
                })
            })),
            // What it takes to break the curse (RAW "lifting requirement").
            liftRequirement: new fields.HTMLField({ initial: "" }),
            // Required materials, as links to real items (any type), each
            // with a quantity.
            components:  new fields.ArrayField(new fields.SchemaField({
                uuid: new fields.StringField({ required: true, blank: false }),
                name: new fields.StringField(),
                img:  new fields.StringField(),
                qty:  new fields.NumberField({ initial: 1, integer: true, min: 1 })
            })),
            // Narrative-only escape hatch (see SpellData.narrative).
            narrative: new fields.BooleanField({ initial: false }),
            // Handler registry key (see SpellData.mechanicHandler).
            mechanicHandler: new fields.StringField({ initial: "" }),
            // Clone the hex item's authored AEs onto the target on
            // successful hex — see SpellData.castsAuthoredAE. Some
            // hexes (Bones of Glass, Hex of Forgetfulness) are best
            // authored as AEs on the item since the effect is a
            // static list of stat/skill deltas.
            castsAuthoredAE: new fields.BooleanField({ initial: false }),
            // See SpellData.areaPersist / areaExcludeCaster — a rare
            // cursed-area hex needs these too (a Zone of Ill Omen aura).
            areaPersist:       new fields.BooleanField({ initial: false }),
            areaExcludeCaster: new fields.BooleanField({ initial: true }),
            // Escape check for shakeable curses (Curse of Sedna's slow-
            // drowning check, some Journeyman hexes). See SpellData.
            escapeCheck: new fields.SchemaField({
                skill:          new fields.StringField({ initial: "" }),
                dcSource:       new fields.StringField({ initial: "castRoll" }),
                dcDrift:        new fields.NumberField({ initial: 0, integer: true }),
                cadence:        new fields.StringField({ initial: "round" }),
                consumesAction: new fields.BooleanField({ initial: false })
            }),
            // Per-round escalation (Seirff Haul DC drift).
            escalationPerRound: new fields.SchemaField({
                attribute: new fields.StringField({ initial: "" }),
                delta:     new fields.NumberField({ initial: 0, integer: true })
            })
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
        } else if (Array.isArray(data.defense)) {
            // Roll back the brief array shape from earlier development —
            // pick the first real entry (or "resistmagic" if none).
            const first = data.defense.find(d => d && d !== "none");
            data.defense = first ?? (data.defense.includes("none") ? "none" : "resistmagic");
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
