/**
 * RaceData — a race item dropped on a character. Carries:
 *   - four "quality" boxes describing the race's defining traits
 *     (name + description each), and
 *   - any number of Foundry ActiveEffects that transfer to the actor
 *     (transfer:true is the sheet default — see WitcherItemSheet).
 *
 * The mechanical stat changes live in the effects; the quality boxes are
 * the human-readable description of what the race grants.
 */

import { baseItemSchema } from "./templates/base.mjs";
import { MONSTER_TYPES } from "../../setup/config.mjs";

const fields = foundry.data.fields;

/* One quality box — a short title + a description. */
function raceQuality() {
    return new fields.SchemaField({
        name:        new fields.StringField({ initial: "" }),
        description: new fields.HTMLField({ initial: "" })
    });
}

export class RaceData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            ...baseItemSchema(),
            // The four race-quality boxes.
            qualities: new fields.SchemaField({
                box1: raceQuality(),
                box2: raceQuality(),
                box3: raceQuality(),
                box4: raceQuality()
            }),

            // Opt-in: when a character owns a race with this checked, the
            // character chrome shows a "Variable portrait" button that swaps
            // actor.img across toxicity tiers / conditions. See
            // module/chrome/integrations/portrait-toxicity.js.
            variablePortrait: new fields.BooleanField({ initial: false }),

            // Lords & Land p.9 Halflings: cannot channel magic (no Mage/Priest),
            // Witcher & magic potions never benefit them, immune to Blue Mutagens.
            // Defaults false so existing races are unaffected. Enforcement is
            // later behavior; the schema records intent.
            noMagicProfession: new fields.BooleanField({ initial: false }),
            potionImmune:      new fields.BooleanField({ initial: false }),
            blueMutagenImmune: new fields.BooleanField({ initial: false }),

            // Race-level immunity to Food Sickness (the status applied when a
            // character eats spoiled food and fails the Endurance hazard —
            // mechanics/foodAndDrink.mjs). Ghouls, dwarves with iron guts,
            // etc. Consulted BEFORE the roll: the hazard is skipped entirely,
            // no chat card, no status effect.
            foodSicknessImmune: new fields.BooleanField({ initial: false }),

            // Race-level Resistance to Infection. Characters of this race
            // always benefit from the "Sterilized Wounds" +2 healing bonus
            // during rest — the checkbox in the Heal/Rest dialog is auto-
            // ticked AND locked so the bonus can't be turned off. Consulted
            // by sheets/actor/mixins/healSheetMixin.mjs when the dialog opens.
            infectionImmune:    new fields.BooleanField({ initial: false }),

            /* Creature type this race maps to, using the same enum as the
             * monster `system.category` (see setup/config.mjs MONSTER_TYPES).
             * When a character owns a race with a non-empty creatureType,
             * blade oils that target that category (e.g. "humanoid" oil on
             * a human PC) apply their bonus in the damage calculator. Empty
             * = "no category" — oils that target a specific category miss;
             * universal oils (empty oilTarget) still apply. */
            creatureType: new fields.StringField({
                initial: "",
                blank: true,
                choices: ["", ...Object.keys(MONSTER_TYPES)]
            }),

            // Race-level Alcohol Resistance — gated on the food-and-drink
            // homebrew. Consulted by mechanics/foodAndDrink.mjs to modify
            // the auto-sober tick cadence AND the hangover duration:
            //   "none" → 60-min sober tick, full hangover duration
            //   "half" → 30-min sober tick, hangover duration ×0.5
            //   "full" → 15-min sober tick, hangover duration ×0.25
            // Multiple race items on the same actor take the strongest.
            alcoholResistance:  new fields.StringField({
                initial: "none",
                choices: ["none", "half", "full"]
            }),

            // Night-vision tier (mechanics/light-level.mjs), CUMULATIVE — each
            // level waives its light tier and every lighter one:
            //   "night"    (Night Vision)          → waives Dim
            //   "improved" (Improved Night Vision) → waives Darkness (and Dim)
            //   "dark"     (Dark Vision)           → waives Pitch Black (and Darkness, Dim)
            //   ""         → no low-light vision
            // A character takes the BEST tier among owned race items. Dark Vision
            // should also carry a Foundry token sight range (Pitch Black is the
            // global-illumination-off state the stealth cones read).
            nightVision: new fields.StringField({
                initial: "",
                blank: true,
                choices: ["", "night", "improved", "dark"]
            }),
            // Dark Vision only: how far (scene distance units) the character sees in
            // the dark. Applied to the token's Foundry sight RANGE when Dark Vision
            // is active (policy/darkvision-sight.mjs). 0 = leave the token's own range.
            darkVisionRange: new fields.NumberField({
                initial: 0, min: 0, nullable: false
            }),
            // Dark Vision only: which Foundry vision mode the token gets — the visual
            // filter used to render the dark. See DARK_VISION_MODES in
            // mechanics/light-level.mjs for what each does.
            darkVisionMode: new fields.StringField({
                initial: "monochromatic", blank: false,
                choices: ["monochromatic", "darkvision", "lightAmplification"]
            }),
            // Natural armor: a full-body SP the race grants (tough hide, scales,
            // chitin…). It adds ON TOP of worn armor on EVERY hit location, does
            // NOT count as an armor-layering layer (it isn't a worn item), and
            // can never be ablated. 0 = none. Consumed by buildNaturalArmorShape
            // in socketHook when assembling the damage target.
            naturalArmorSP: new fields.NumberField({
                initial: 0, min: 0, integer: true, nullable: false
            }),

            /* ── Natural Weapons (claws / bite / etc.) ─────────────────────
             * When enabled, this race's damage code REPLACES the character's
             * core unarmed (punch/kick) damage: punch = code + MeleeBonus,
             * kick = code + MeleeBonus + 4. The configured qualities + damage
             * type ride the unarmed strike through the normal damage pipeline
             * (Bleeding etc. fire; damage type feeds resistances). `lethal`
             * routes damage to HP; non-lethal routes to STAMINA (system rule).
             * Brawling-quality weapons (cestus) still add on top. */
            naturalWeapons:            new fields.BooleanField({ initial: false }),
            naturalWeaponDamage:       new fields.StringField({ initial: "1d6" }),
            naturalWeaponLethal:       new fields.BooleanField({ initial: false }),
            /* Defensive use of the natural weapon (claws/horns can turn a blade;
             * a bite can't). Off by default — a natural weapon is offence-only
             * unless the race explicitly grants it. `canBlock` blocks cost 1 HP
             * (the limb takes the strain) — see defensePromptDialog. The generic
             * unarmed "Arm Block" (brawlBlock) stays available regardless. */
            naturalWeaponCanParry:     new fields.BooleanField({ initial: false }),
            naturalWeaponCanBlock:     new fields.BooleanField({ initial: false }),
            // Damage types — multiple, like a regular weapon.
            // Empty by default so bludgeoning is a *fallback* (applied only when
            // nothing is selected — see naturalWeaponConfig), not a pre-checked
            // value that stacks on top of whatever override the user picks.
            naturalWeaponTypes:        new fields.ArrayField(new fields.StringField(), { initial: [] }),
            naturalWeaponQualities:    new fields.ArrayField(new fields.StringField(), { initial: [] }),
            naturalWeaponQualityValues: new fields.ObjectField({ initial: {} })
        };
    }

    /* Migrate the old single `naturalWeaponType` string to the multi-type
     * `naturalWeaponTypes` array. */
    static migrateData(data) {
        if (data && data.naturalWeaponType && !Array.isArray(data.naturalWeaponTypes)) {
            data.naturalWeaponTypes = [String(data.naturalWeaponType)];
        }
        return super.migrateData(data);
    }

    calcWeight() {
        return 0;
    }
}
