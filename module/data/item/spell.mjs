/**
 * SpellData — a castable spell / sign / invocation (RAW Core p.99-115).
 *
 * Fields are structured (not free strings) so the combat / cast flow can
 * reason about them numerically — mirrors HexData / RitualData:
 *   - staminaCost / castingTime  → numbers (STA spent; cost in ACTIONS)
 *   - defense                    → enum: how the target resists
 *                                  (resistmagic | dodge | block | none)
 *   - targetType                 → enum (direct | area | self) — decides
 *                                  whether a defense is rolled at all (p.169)
 *   - duration                   → { value, unit } so round-based spells tick
 *   - school / form / tier       → enums (Earth…Mixed / spell·sign·invocation /
 *                                  Novice·Journeyman·Master)
 *   - components                 → item links ({uuid,name,img,qty}), any type
 *   - effect                     → narrative HTML
 */

import { baseItemSchema } from "./templates/base.mjs";

const fields = foundry.data.fields;

export class SpellData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            ...baseItemSchema(),
            staminaCost: new fields.NumberField({ initial: 0, integer: true, min: 0 }),
            // Some spells cost a variable amount (e.g. Dispel spends half the
            // target spell's cost) — flag it so the cast flow prompts and the
            // sheet shows "Variable" instead of the staminaCost default.
            variableCost: new fields.BooleanField({ initial: false }),
            // Cast time as an action count — "1 action" is the number 1.
            castingTime: new fields.NumberField({ initial: 1, integer: true, min: 0 }),
            // How the target resists — a multi-select (a spell can offer more
            // than one valid defense, e.g. "Dodge or Block"). Empty = no
            // defense ("None"). Each entry is a SPELL_DEFENSES key.
            defense:     new fields.ArrayField(new fields.StringField(), { initial: ["resistmagic"] }),
            range:       new fields.StringField({ initial: "" }),
            // Structured duration so combat can decrement round-based spells.
            // unit ∈ instant | rounds | minutes | hours | days | permanent.
            // value is a string so RAW dice durations ("1d10", "1d6") round
            // at cast time, not just fixed integers.
            duration:    new fields.SchemaField({
                value: new fields.StringField({ initial: "" }),
                unit:  new fields.StringField({ initial: "instant" })
            }),
            // School & form (Core p.99) — Earth / Air / Fire / Water / Mixed,
            // plus a form distinguishing mage spell vs witcher sign vs priest
            // invocation. Signs share STA-cost mechanics but cap at 7 STA per
            // cast (Core p.115).
            school:      new fields.StringField({ initial: "mixed" }),
            spellForm:   new fields.StringField({ initial: "spell" }),
            // RAW tier — gates the Magic Training rank needed to learn it.
            spellType:   new fields.StringField({ initial: "novice" }),
            // Targeting (Core p.169) — direct / area / self decides whether
            // the defender rolls a defense at all.
            targetType:  new fields.StringField({ initial: "direct" }),
            effect:      new fields.HTMLField({ initial: "" }),
            // Magical Gifts (A Tome of Chaos pp.74-75) are non-mage minor magic
            // (spellForm "gift") carrying a mandatory side-effect; its text lives here.
            sideEffect:  new fields.HTMLField({ initial: "" }),
            // Required materials / foci, as links to real items (any type),
            // each with a quantity. Most RAW spells need none.
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
        // defense: legacy free string / single enum → array of enum keys
        // (matches the RAW "Defense:" wordings — "Dodge or Block" → both,
        // opposed "Spell Casting", GM-set DC, "None" → empty).
        if (typeof data.defense === "string") {
            const s = data.defense.trim();
            const out = [];
            if (/dodge|reflex|evade/i.test(s)) out.push("dodge");
            if (/block|parry/i.test(s))        out.push("block");
            if (/resist|magic|will/i.test(s))  out.push("resistmagic");
            if (/spell\s*cast|opposed/i.test(s)) out.push("spellcasting");
            if (/\bgm\b|game\s*master|discretion/i.test(s)) out.push("gm");
            // Legacy single-key "dodgeblock" splits into both.
            if (s === "dodgeblock") { out.push("dodge", "block"); }
            // "None" / "N/A" / "Self" and unmatched non-empty → empty / default.
            data.defense = out.length ? [...new Set(out)]
                         : (/none|n\/a|self/i.test(s) || s === "" ? [] : ["resistmagic"]);
        }
        // duration: legacy free string → { value, unit }. Preserve the
        // leading count token whether it's a dice formula ("1d10") or a
        // plain integer ("5") so the string field keeps the roll.
        if (typeof data.duration === "string") {
            const s = data.duration;
            const token = s.match(/\d+d\d+(?:[+-]\d+)?|\d+/i)?.[0] ?? "";
            let unit = "instant";
            if (/perm|until|indefinit/i.test(s)) unit = "permanent";
            else if (/round/i.test(s))           unit = "rounds";
            else if (/day/i.test(s))             unit = "days";
            else if (/hour/i.test(s))            unit = "hours";
            else if (/min/i.test(s))             unit = "minutes";
            data.duration = { value: token, unit };
        } else if (data.duration && typeof data.duration.value === "number") {
            // structured-but-numeric (earlier schema) → stringify the count.
            data.duration.value = String(data.duration.value);
        }
        // components: legacy HTML string → drop (can't infer item links).
        if (typeof data.components === "string") data.components = [];
        return super.migrateData(data);
    }

    calcWeight() {
        return 0;
    }
}
