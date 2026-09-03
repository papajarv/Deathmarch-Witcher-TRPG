import { t, tFormat } from "../chrome/lib/i18n.js";
/**
 * Fumble table — the single canonical source consumed by
 *   - mechanics/autoFumble.mjs (auto-roll on nat-1 in combat)
 *   - chrome/chrome/fumble-dialog.js (manual dock-button picker)
 *
 * Category keys match the strings callers pass as
 * `config.fumbleCategory` to extendedRoll and the option values in the
 * manual picker dropdown. Rows are inclusive ranges → outcome text;
 * inline [[dice]] formulas are rendered by Foundry's TextEditor when
 * the text is posted to chat.
 */

export const FUMBLE_TABLE = () => Object.freeze({
    meleeAttack: {
        label: t("WITCHER.Mech.FumbleTable.Dialog.Button.MeleeAttackArmed", "Melee Attack (Armed)"),
        rows: [
            [1,  5,        "Nothing happens — your strike misses cleanly."],
            [6,  6,        "Your weapon glances off and you are staggered."],
            [7,  7,        "Your weapon lodges in a nearby object and it takes 1 round to free."],
            [8,  8,        "You damage your weapon severely. Your weapon takes [[1d10]] points of reliability damage."],
            [9,  9,        "You manage to wound yourself. Roll for location."],
            [10, Infinity, "You wound a nearby ally. Roll location on a random ally within range."]
        ]
    },
    armedDefense: {
        label: t("WITCHER.Mech.FumbleTable.Dialog.Button.MeleeDefenseArmed", "Melee Defense (Armed)"),
        rows: [
            [1,  5,        "Nothing happens — your defense holds."],
            [6,  6,        "Your weapon takes [[1d6]] extra points of reliability damage."],
            [7,  7,        "Your weapon is knocked from your hand and flies [[1d6]] meters away in a random direction (see Scatter table)."],
            [8,  8,        "You are knocked to the ground. You are now prone and must make a Stun save."],
            [9,  9,        "Your weapon takes [[2d6]] extra points of reliability damage."],
            [10, Infinity, "Your weapon ricochets back and hits you. Roll for location."]
        ]
    },
    rangedAttack: {
        label: t("WITCHER.Mech.FumbleTable.Dialog.Button.RangedAttack", "Ranged Attack"),
        rows: [
            [1,  5,        "Nothing happens — your shot just misses."],
            [6,  7,        "The ammunition you fired, or weapon you threw, hits something hard, breaking."],
            [8,  9,        "Your bowstring comes partially undone, your crossbow jams, or you drop your thrown weapon. It takes 1 round to undo this."],
            [10, Infinity, "You strike one of your allies with a ricochet. Roll location on a random ally within range."]
        ]
    },
    magic: {
        label: t("WITCHER.Mech.FumbleTable.Dialog.Button.MagicSpellcasting", "Magic / Spellcasting"),
        rows: [
            [1,  6,        "Magic sparks and crackles and you take 1 point of damage for every point you fumbled by, but the spell still goes off."],
            [7,  9,        "The magic that is already partially through you ignites inside you. Not only does the spell fail but you suffer an elemental fumble effect."],
            [10, Infinity, "Your magic explodes with a catastrophic effect. Not only do you suffer an elemental fumble effect, but any focusing item you are carrying explodes as if it were a bomb ([[1d10]] damage, 2m radius)."]
        ]
    },
    /* Generic skill-check fumbles have no RAW auto-roll table — the
     * outcome is GM adjudication ("you botched the roll, describe how").
     * Registered so Balanced Stance (Wolf) can offer its 5-STA skip on
     * "a fumble of any kind" per the perk text. autoFumble bails on the
     * auto-roll step when rows is empty. */
    skillCheck: {
        label: t("WITCHER.Mech.FumbleTable.Dialog.Button.SkillCheck", "Skill Check"),
        rows: []
    },
    unarmedAttack: {
        label: t("WITCHER.Mech.FumbleTable.Dialog.Button.BrawlingUnarmedAttack", "Brawling / Unarmed Attack"),
        rows: [
            [1,  5,        "Nothing happens — your blow goes wide."],
            [6,  6,        "You are knocked off balance and are staggered."],
            [7,  7,        "You trip on something and fall prone."],
            [8,  8,        "You trip and fall prone. You must make a Stun save."],
            [9,  9,        "You trip and hit your head. You are knocked prone, take [[1d6]] non-lethal damage to the head, and must make a Stun save."],
            [10, Infinity, "You fail horribly and not only fall prone but also take [[1d6]] lethal damage to the head and must make a Stun save."]
        ]
    },
    unarmedDefense: {
        /* Same underlying table as unarmedAttack — RAW.  Kept as a separate
         * category for picker clarity since the in-fiction story is different. */
        label: t("WITCHER.Mech.FumbleTable.Dialog.Button.UnarmedDefenseDodgeAthletics", "Unarmed Defense / Dodge / Athletics"),
        rows: [
            [1,  5,        "Nothing happens — you recover."],
            [6,  6,        "You are knocked off balance and are staggered."],
            [7,  7,        "You trip on something and fall prone."],
            [8,  8,        "You trip and fall prone. You must make a Stun save."],
            [9,  9,        "You trip and hit your head. You are knocked prone, take [[1d6]] non-lethal damage to the head, and must make a Stun save."],
            [10, Infinity, "You fail horribly and not only fall prone but also take [[1d6]] lethal damage to the head and must make a Stun save."]
        ]
    }
});

/* Look up the outcome text for a category + rolled total. Returns null
 * on unknown category; a placeholder note on out-of-range roll. The row
 * text is localized at CALL time so a language swap takes effect without
 * a reload — the source rows carry the English fallback as row[2] and
 * the key is derived from category+index. */
export function fumbleOutcome(category, roll) {
    const table = FUMBLE_TABLE()[category];
    if (!table) return null;
    const rows = table.rows;
    const idx  = rows.findIndex(([lo, hi]) => roll >= lo && roll <= hi);
    if (idx < 0) return t("WITCHER.Mech.FumbleTable.OutOfRange", "(out of range — GM ruling)");
    return t(`WITCHER.Mech.FumbleTable.${category}.Row${idx}`, rows[idx][2]);
}
