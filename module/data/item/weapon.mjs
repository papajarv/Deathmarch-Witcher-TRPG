/**
 * WeaponData — TypeDataModel for weapons.
 *
 * Schema includes base item fields, damage properties, and weapon-specific
 * equipment fields:
 *  - `hands`: the weapon TRAIT — "one" | "two" (how many hands it needs).
 *  - `slot`:  the equip slot it last occupied — "right" | "left" | "quick"
 *             (doubles as "last slot" memory for drawing). A two-handed
 *             weapon occupies both hands regardless of `slot`.
 *  - `quick`: whether this weapon may sit in the off-hand Quick slot
 *             (throwing knives, daggers, etc.). Non-quick one-handed
 *             weapons only fit Right or Left.
 */

import { baseItemSchema }                              from "./templates/base.mjs";
import { damagePropertiesSchema, migrateDamageType }   from "./templates/damageProperties.mjs";
import { deriveWeaponEffective }                       from "./templates/enhancementDerivation.mjs";

const fields = foundry.data.fields;

export class WeaponData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            ...baseItemSchema(),
            ...damagePropertiesSchema(),
            hands: new fields.StringField({ initial: "one", choices: ["one", "two"] }),
            slot:  new fields.StringField({ initial: "right", choices: ["right", "left", "quick"] }),
            quick: new fields.BooleanField({ initial: false }),
            /* Runtime wielding mode. A one-handed weapon flagged with the
             * Two-Hand EO quality can be wielded with both hands for the
             * authored Two-Hand bonus (see openCategoryBonuses.mjs). This
             * flag tracks the player's current grip; the toggle lives on
             * the combat dock. Has no effect on a baseline two-handed
             * weapon (already always two-handed). */
            twoHandMode: new fields.BooleanField({ initial: false }),
            // Oil coating snapshot. Populated by mechanics/alchemy.applyOilToWeapon
            // when a player coats this weapon; cleared on expiry (RAW) or
            // when the last charge depletes (Alchemy Reborn). Holds the
            // oil's authoring data directly so the combat hook can read
            // bonus damage + target category without re-resolving the
            // source oil item (which may have been consumed when applied).
            //   id              : the source oil item id (book-keeping; not
            //                     load-bearing — the source may be deleted
            //                     once applied)
            //   name / img      : display copies for the inventory chip
            //   oilTarget       : monster category key the bonus applies to.
            //                     Empty means "every target".
            //   oilBonusDamage  : flat HP added when the target matches.
            //   expireAt        : worldTime seconds when the coating ends.
            //                     0 / null means no time-based expiry
            //                     (Alchemy Reborn — charges drive expiry
            //                     instead).
            //   charges / maxCharges : Alchemy Reborn charges. 0 = unused
            //                     (RAW duration-only mode).
            /* ── Bomb subtype (weaponType === "bomb") ────────────────
             * A bomb reuses the shared damageProperties fields:
             *   range     : throw distance formula (supports "BODYxN")
             *   radius    : AoE radius (metres) for circle-shape templates
             *   damage    : damage roll formula
             *   damageTypes: damage type list
             *   skillKey  : throw skill (Athletics is the default the sheet
             *               offers; author-selectable)
             *   conceal / availability / weight / cost / quantity : shared
             *               with any other weapon
             * The fields below add what a bomb specifically needs. On any
             * non-bomb weapon these sit at defaults and are ignored by the
             * sheet's gated section. */
            // Template shape + secondary size for the AoE placed at the
            // landing hex. Circle-shape reads `radius` (damageProperties)
            // for its size; the other three read this field's `size`.
            bombTemplate: new fields.SchemaField({
                shape: new fields.StringField({ initial: "circle", choices: ["circle", "cone", "line", "rect"] }),
                size:  new fields.NumberField({ initial: 0, min: 0 })
            }),
            // Which defenses each target caught in the AoE may attempt.
            // RAW/Design intent: Block requires a shield with Full Cover
            // (RAW) or CV ≥ 6 (Combat Extended); Reposition requires
            // physically leaving the AoE by that target's next movement.
            // Dodge / Parry are NOT options for area weapons.
            bombDefenses: new fields.SchemaField({
                block:      new fields.BooleanField({ initial: true }),
                reposition: new fields.BooleanField({ initial: true })
            }),
            /* Bomb-native ablation. Rolled on hit and applied
             * directly to failed defenders — no AE round-trip. Both
             * fields accept a plain integer OR a dice formula
             * (`"1d6/2"`, `"1d3+1"`). Empty = no chip. Runtime lives
             * in mechanics/bombs.mjs applyBombToVictim. */
            bombArmorAblation:  new fields.StringField({ initial: "" }),
            bombWeaponAblation: new fields.StringField({ initial: "" }),
            // DEPRECATED (removed 2026-07-24) — bomb riders now live
            // as native embedded ActiveEffects on the bomb item itself
            // (see WitcherWeaponSheet's Add-Effect flow). This array
            // stays in the schema so any pre-refactor bomb still
            // validates without a migration; readers should treat it
            // as empty. New authoring writes to `item.effects` and each
            // effect optionally carries a `flags[MODULE].bombRiderDamage`
            // formula for application damage.
            bombRiders: new fields.ArrayField(new fields.SchemaField({
                uuid: new fields.StringField({ initial: "" }),
                name: new fields.StringField({ initial: "" }),
                img:  new fields.StringField({ initial: "" })
            }), { initial: [] }),
            // Whether throwing decrements the stack by 1. Default true —
            // bombs go bang. Flip false on infinite-use artifact grenades.
            consumeOnThrow: new fields.BooleanField({ initial: true }),

            appliedOil: new fields.SchemaField({
                id:             new fields.StringField({ initial: "", blank: true }),
                name:           new fields.StringField({ initial: "", blank: true }),
                img:            new fields.StringField({ initial: "", blank: true }),
                oilTarget:      new fields.StringField({ initial: "", blank: true }),
                oilBonusDamage: new fields.NumberField({ initial: 0, integer: true, min: 0 }),
                // worldTime second when the coating was applied. Needed so
                // the dock progress bar can compute `total = expireAt -
                // appliedAt` and render the percentage as `remaining / total`
                // — without this, the bar would divide by the expireAt
                // timestamp itself (a huge number), making the fill width
                // collapse to a hairline immediately after application.
                appliedAt:      new fields.NumberField({ initial: 0, integer: true, min: 0 }),
                expireAt:       new fields.NumberField({ initial: 0, integer: true, min: 0 }),
                charges:        new fields.NumberField({ initial: 0, integer: true, min: 0 }),
                maxCharges:     new fields.NumberField({ initial: 0, integer: true, min: 0 }),
                // Snapshot of the source oil's active effects (via toObject),
                // taken at coat time. On every damaging hit the socketHook
                // damage handler spawns each of these as a fresh AE on the
                // target actor. Stored as raw AE data (not documents) so
                // the coating survives deletion of the source oil item.
                onHitStatuses:  new fields.ArrayField(new fields.ObjectField(), { initial: [] })
            })
        };
    }

    /** Pre-validation migration. Runs once on actor/item load before
     *  schema validation, so legacy fields are reshaped silently:
     *  - `damageType: "slashing"` → `damageTypes: ["slashing"]`
     *  - `reliability: 10` → `reliability: { value: 10, max: 10 }`
     *  - `range: 10` → `range: "10"` (now free-form text, e.g. "BODYx4")
     *  - `weaponType: "thrown"` → `weaponType: "melee"` and hoist
     *    `meleeSkillKey` into `skillKey` when non-empty and not
     *    "athletics". The system model now uses melee-with-a-range as
     *    the throwability marker, and always rolls Athletics on the
     *    throw itself (hard-coded in the strike table). See
     *    tools/migrate-thrown-to-melee.mjs for the compendium
     *    equivalent. */
    static migrateData(data) {
        migrateDamageType(data);
        if (data.weaponType === "thrown") {
            data.weaponType = "melee";
            const mSkill = String(data.meleeSkillKey ?? "").trim();
            const sSkill = String(data.skillKey ?? "").trim();
            if (mSkill && mSkill.toLowerCase() !== "athletics") {
                data.skillKey = mSkill;
            } else if (!sSkill) {
                data.skillKey = "athletics";
            }
            data.meleeSkillKey = "";
        }
        // Equipment model v2: the old `hands` conflated trait + slot
        // ("left"/"right"/"quick"/"two-handed"/"both"). Split it into the
        // trait (`hands` = one|two), the equip slot (`slot`), and a `quick`
        // flag. Already-migrated values ("one"/"two") fall through untouched.
        const oh = data.hands;
        if (oh === "two-handed" || oh === "both") {
            data.hands = "two";
            if (data.slot == null) data.slot = "right";
        } else if (oh === "left" || oh === "right" || oh === "quick") {
            if (data.quick == null) data.quick = (oh === "quick");
            if (data.slot == null)  data.slot  = (oh === "quick") ? "quick" : oh;
            data.hands = "one";
        }
        if (typeof data.reliability === "number") {
            const n = data.reliability;
            data.reliability = { value: n, max: n };
        }
        if (typeof data.range === "number") {
            data.range = data.range ? String(data.range) : "";
        }
        // RAW "Slow Reload" = 1 action to reload. Seed reloadActions from the
        // quality for weapons authored before the numeric field existed.
        if (data.reloadActions == null && Array.isArray(data.qualities)
            && data.qualities.includes("slowReload")) {
            data.reloadActions = 1;
        }
        // Seed accepted ammo class for weapons authored before ammoType
        // existed. crossbows + scorpios fire bolts, slings fire slingBullets,
        // siege engines (mangonel/trebuchet) fire siege rounds, everything
        // else (bows) is arrows.
        if (data.ammoType == null && data.requiresAmmo) {
            const skill = data.skillKey;
            data.ammoType = skill === "crossbow"  ? "bolt"
                          : skill === "athletics" ? "slingBullet" /* slings use Athletics */
                          : skill === "artillery" ? "siege"
                          : "arrow";
        }
        return super.migrateData(data);
    }

    /** Effective stats after socketed enhancements (runes / weapon mods).
     *  `system.effective` holds accuracy, reliabilityMax, damage formula,
     *  damageTypes, qualities + qualityValues. Base fields are untouched, so
     *  display + roll consumers read `effective` when they want the
     *  enhanced numbers and the raw fields when they want the base. */
    prepareDerivedData() {
        this.effective = deriveWeaponEffective(this);
        /* Make the meteorite/rune-boosted max AUTHORITATIVE. `effective.reliability
         * Max` is base + quality/rune bonuses, but only the item sheet used it —
         * every other consumer (repair & damage clamps, the broken check, the
         * hover card, merchant/defense readouts) reads `system.reliability.max`,
         * so the +5 was cosmetic and mechanically inert. Fold it into the prepared
         * max here so all of them use it. Safe from runaway: Foundry re-derives
         * `this.reliability` from `_source` each prep cycle, so the fold never
         * compounds. Also clamp the current value so a removed bonus can't leave
         * value > max. The pristine "top up value to the new max" is a one-time
         * data write (see setup/hooks reliability fill) — deliberately NOT done
         * here, so normal damage passing through the base max can't re-heal. */
        const effMax = Number(this.effective?.reliabilityMax) || 0;
        if (this.reliability && effMax > 0) {
            this.reliability.max = effMax;
            if (Number(this.reliability.value) > effMax) this.reliability.value = effMax;
        }
    }

    /** Total weight contribution. Phase 5 may refine for stacking edge cases. */
    calcWeight() {
        return this.weight * this.quantity;
    }
}
