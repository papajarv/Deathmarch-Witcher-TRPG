/**
 * Skills template — skills grouped by their owning stat.
 *
 * Schema shape (per skill):
 *   value     : integer 0-10  trained rank (0 = untrained; chargen cap 6)
 *   modifier  : integer       temporary adjustment (items, conditions)
 *   category  : enum ""|"profession"|"pickup"
 *                  ""          unmarked (default)
 *                  "profession" — in the character's Skill Package
 *                                 (Core p.49 — 10 profession + 1 Defining)
 *                  "pickup"    — bought with INT+REF starting points or
 *                                later IP. Per p.59, pickup skills cost
 *                                ×2 IP per rank. We don't enforce cost
 *                                yet — this is the marker the future
 *                                leveling UI will read.
 *
 * The skill-to-stat assignment is derived from SKILL_MAP in setup/config.mjs
 * so adding a skill there auto-includes it in the schema.
 */

import { SKILL_MAP } from "../../../setup/config.mjs";

const fields = foundry.data.fields;

/* Skill rank clamped 0-10 for characters (RAW caps at 10; 0 = untrained, the
 * default). NumberField clamps via _cleanType, so values outside the range
 * round to 0 or 10 on validation. Monsters pass `rankMax: null` — their
 * printed stat blocks can exceed 10 (e.g. Fiend Spell Casting 15). */
const skillField = (rankMax = 10) => new fields.SchemaField({
    value:    new fields.NumberField({ initial: 0, integer: true, min: 0, ...(rankMax == null ? {} : { max: rankMax }) }),
    modifier: new fields.NumberField({ initial: 0, integer: true }),
    category: new fields.StringField({ initial: "" })  // "" | "profession" | "pickup"
});

export function skillsSchema({ rankMax = 10 } = {}) {
    const byStat = {};
    for (const [skillKey, meta] of Object.entries(SKILL_MAP)) {
        const statKey = meta.statKey;
        if (!byStat[statKey]) byStat[statKey] = {};
        byStat[statKey][skillKey] = skillField(rankMax);
    }
    const skills = {};
    for (const [statKey, group] of Object.entries(byStat)) {
        skills[statKey] = new fields.SchemaField(group);
    }
    return { skills: new fields.SchemaField(skills) };
}
