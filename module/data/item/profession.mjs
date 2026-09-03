/**
 * ProfessionData — a profession item (Core p.62-70). Dropped onto a
 * character to populate its profession pane: the defining skill, the
 * three skill-tree paths, and the package of regular skills the
 * profession grants.
 *
 * Field shape is load-bearing — the chrome profession pane
 * (chrome/character.js renderProfessionPane / onLevelUpProfessionSkill)
 * and the skills panel (chrome/skills-panel.js buildProfessionTab) read
 * `definingSkill {skillName, stat, definition, level}` and
 * `skillPath1/2/3 {pathName, skill1/2/3 {...}}` directly. Don't rename.
 *
 * Combat sub-schemas from the reference system (skillAttack/skillDefense/
 * etc.) are intentionally out of scope here — this item is about display
 * + advancement, not the combat engine.
 */

import { baseItemSchema } from "./templates/base.mjs";

const fields = foundry.data.fields;

/* A single tree/defining slot. `skillName` is the display label; `stat`
 * is the governing stat key (STATS); `level` is the trained rank used by
 * the level-up flow. `isMagical` marks the slot as magic-eligible so it
 * shows up as level-uppable in the character chrome's magic-mode IP
 * banner and its rank-up may be paid out of Magic IP. */
function professionSkill() {
    return new fields.SchemaField({
        skillName:  new fields.StringField({ initial: "" }),
        stat:       new fields.StringField({ initial: "" }),
        definition: new fields.HTMLField({ initial: "" }),
        level:      new fields.NumberField({ initial: 0, integer: true, min: 0 }),
        isMagical:  new fields.BooleanField({ initial: false })
    });
}

/* One of the three skill-tree paths: a name + three ordered slots. */
function professionPath() {
    return new fields.SchemaField({
        pathName: new fields.StringField({ initial: "" }),
        skill1:   professionSkill(),
        skill2:   professionSkill(),
        skill3:   professionSkill()
    });
}

export class ProfessionData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            ...baseItemSchema(),
            // SVG (or image) shown in the dock medallion when this profession
            // is the controlled character's. Empty → no medallion icon.
            medallionIcon: new fields.StringField({ initial: "" }),
            // Starting Vigor allowance (Core p.38). Acts as a FLOOR on the
            // character's Vigor threshold — the profession grants this much and
            // it can't be lost; the player can only raise vigor above it.
            // 0 for non-casters (most professions).
            vigor: new fields.NumberField({ initial: 0, integer: true, min: 0 }),
            // Spellcasting foci: when true, a caster with this profession may
            // cast spells through equipped gear carrying the Focus / Greater
            // Focus quality (see castSpellMixin). Off for non-caster professions.
            canUseFoci: new fields.BooleanField({ initial: false }),
            // The single defining skill (each profession has one).
            definingSkill: professionSkill(),
            // The three advancement trees (Core pp.62-70).
            skillPath1: professionPath(),
            skillPath2: professionPath(),
            skillPath3: professionPath(),
            // The regular SKILL_MAP skills this profession grants outright.
            // Stored as skill keys; governing stat is derived from SKILL_MAP at
            // display time. On drop these are auto-marked "profession" (P).
            professionSkills: new fields.SetField(new fields.StringField({ initial: "" })),
            // "Choose X of Y" packages: each grants `choose` skills picked from
            // `options` (SKILL_MAP keys) by the player when the profession is
            // dropped onto a character. A profession can have several.
            skillChoices: new fields.ArrayField(new fields.SchemaField({
                choose:  new fields.NumberField({ initial: 1, integer: true, min: 1 }),
                options: new fields.SetField(new fields.StringField({ initial: "" }))
            }), { initial: [] })
        };
    }

    calcWeight() {
        return 0;
    }
}
