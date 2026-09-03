/**
 * MonsterData — TypeDataModel for monster / NPC creature actors.
 *
 * Stats + skills + derived stats, plus enough counters for combat.
 * No IP/lifepath fields — monsters don't advance.
 *
 * Bestiary research state for a given monster lives on the **character**
 * actor that researched it (`character.system.bestiary[encKey]`), not on
 * the monster itself. The monster carries the *authored* content: graded
 * `knowledge` tiers (label + skill + DC + lore text), each with a `shown`
 * visibility flag the research system will later drive. Combat profile
 * (attacks, armor, damage reactions, immunities, abilities) and loot drops
 * live here too.
 */

import { statsSchema }        from "./templates/stats.mjs";
import { skillsSchema }       from "./templates/skills.mjs";
import { derivedStatsSchema } from "./templates/derivedStats.mjs";
import { currencySchema, calcCurrencyWeight, CURRENCY_KEYS } from "./templates/currency.mjs";
import { combatRoundSchema }  from "./templates/combatRound.mjs";
import { guardSchema }        from "./templates/guard.mjs";
import { applyConditionActions, applyEventLedger, DAMAGE_TYPES, defaultWeaponWeaknessFor } from "../../setup/config.mjs";

const fields = foundry.data.fields;

/* One "shown" flag rides on every authored entry (attack, ability, loot,
 * knowledge tier). It is the *visibility layer*: GM-authored content that
 * the bestiary / player-facing views can later filter on. Nothing reads it
 * for gating yet — the monster sheet (a GM editor) always shows everything,
 * dimming the entries that are not yet revealed. */
const shown = () => new fields.BooleanField({ initial: false });

export class MonsterData extends foundry.abstract.TypeDataModel {

    static defineSchema() {
        return {
            ...statsSchema({ statMax: null, includeCap: false }),
            ...skillsSchema({ rankMax: null }),
            ...derivedStatsSchema(),
            ...currencySchema(),
            ...combatRoundSchema(),
            // Combat Extended guard-stance state (gated on the
            // extendedCombat homebrew toggle at runtime; schema present
            // unconditionally so values survive a toggle flip).
            ...guardSchema(),

            // Icons used for the remains (carcass) and trophy items generated
            // from this monster — configured via the monster sheet's icon
            // button. Empty falls back to the monster portrait. See
            // chrome/monster-remains.js and chrome/context-menu-item.js.
            remainsIcon: new fields.FilePathField({ categories: ["IMAGE"], required: false }),
            trophyIcon:  new fields.FilePathField({ categories: ["IMAGE"], required: false }),

            adrenaline: new fields.SchemaField({
                value: new fields.NumberField({ initial: 0, integer: true, min: 0 })
            }),

            // Death-save success counter (Core p.162). Monsters rarely make
            // these, but the GM-facing Death Save button writes here, so the
            // field must exist on the schema (never conditional, per ADR 0003).
            deathSaves: new fields.NumberField({ initial: 0, integer: true, min: 0 }),

            // ── Taxonomy & danger rating (Core pp.268-270). ──────────────
            /* Flags the monster as a "person" — bandit, cultist, city guard,
             * mage's apprentice — for the carcass-action UI. People carcasses
             * don't offer Harvest / Extract Mutagen / Dissect (there's no
             * monster material to render, no witcher mutagen to extract,
             * no bestiary dissection facts to log); they offer Take Trophy
             * (grim souvenir) and Loot (their gear, no Survival check
             * needed — it's not craft, it's pockets). The flag rides
             * along on the created remains item so the carcass menu can
             * branch without re-resolving the source actor every render. */
            isPeople: new fields.BooleanField({ initial: false }),
            category: new fields.StringField({ initial: "beast" }), // MONSTER_TYPES key
            // GM opt-out: when true this monster never appears in the Bestiary
            // panel (as a world actor OR its compendium entry), regardless of the
            // category-exclusion settings. Toggled from the sheet's Notes tab.
            hideFromBestiary: new fields.BooleanField({ initial: false }),
            threat: new fields.SchemaField({
                difficulty: new fields.StringField({ initial: "easy" }),   // MONSTER_THREAT
                complexity: new fields.StringField({ initial: "simple" })  // MONSTER_COMPLEXITY
            }),
            bounty: new fields.NumberField({ initial: 0, integer: true, min: 0 }),

            // Flavor sidebar shown in the printed stat-block. Free text.
            descriptors: new fields.SchemaField({
                height:       new fields.StringField({ initial: "" }),
                weight:       new fields.StringField({ initial: "" }),
                environment:  new fields.StringField({ initial: "" }),
                intelligence: new fields.StringField({ initial: "" }),
                organization: new fields.StringField({ initial: "" })
            }),

            // ── Combat block. ───────────────────────────────────────────
            // RAW monsters carry a single flat Armor (SP), not by-location.
            // `attacks` are inline RAW-style rows (claws, bite); a humanoid
            // monster can additionally hold dragged-in weapon Items.
            combat: new fields.SchemaField({
                armor: new fields.NumberField({ initial: 0, integer: true, min: 0 }),
                /* Whether the monster's natural armor is ablatable — RAW
                 * default is FALSE (a drowner's hide doesn't wear down
                 * over the fight), but some homebrew monsters use
                 * degrading armor (rusted plate on a wight, brittle
                 * carapace on an insectoid, etc.). Toggle on the monster
                 * sheet; when true, every penetrating hit chips
                 * `combat.armor` by the standard SP-ablation amount
                 * (base ±ablating chip bonus), same as worn armor. */
                armorAblates: new fields.BooleanField({ initial: false }),
                /* Organ-crit immunity override (RAW Core p.159 — elemental
                 * / spectral creatures don't take organ-based critical
                 * wounds; they take a higher flat damage bonus instead,
                 * +5/+10/+15/+20 vs +3/+5/+8/+10).
                 *   "auto"  = derive from `category` (elementa/specter
                 *             default to immune, everything else doesn't)
                 *   "true"  = force-immune regardless of category
                 *   "false" = force-vulnerable regardless of category
                 *
                 * Stored as a string (not a boolean) so the sheet's
                 * <select> can serialize all three states without
                 * Foundry's BooleanField rejecting the "" auto value. */
                immuneToOrganCrits: new fields.StringField({
                    initial: "auto",
                    choices: ["auto", "true", "false"]
                }),
                /* Weapon-material weakness gate. Death March folds the RAW
                 * meteorite column into silver so every non-humanoid monster
                 * halves any damage that isn't from a silver weapon or fire
                 * (fire bypass lives in damageCalculator's applyNaturalResists).
                 * "meteorite" is kept as a valid value for imported worlds and
                 * hand-authored one-offs; "none" disables the gate (humanoids
                 * and houseruled monsters). MonsterSheet seeds the default from
                 * category (defaultWeaponWeaknessFor); GM picks the final. */
                weaponWeakness: new fields.StringField({ initial: "none" }),
                attacks: new fields.ArrayField(new fields.SchemaField({
                    name:   new fields.StringField({ initial: "" }),
                    damage: new fields.StringField({ initial: "" }),  // dice e.g. "3d6+2"
                    effect: new fields.StringField({ initial: "" }),
                    rof:    new fields.NumberField({ initial: 1, integer: true, min: 1 }),
                    /* Melee vs ranged distinction. `melee` (default) is the
                     * canonical natural-weapon case (bite, claw, gore).
                     * `ranged` is for creatures that print a printed range
                     * (harpy dive-bomb, mage-hunter bolt-thrower, a bandit
                     * with a crossbow). `rangeMeters` is the printed range
                     * band the attack fires within — 0 means "no printed
                     * range" (default state — schema field always present
                     * so ranged attacks can populate it without a data
                     * migration). Consumed by monsterVirtualWeapon to
                     * flip `weaponType` in the virtual weapon so range
                     * penalties, ammo checks, and the ranged-attack path
                     * of weaponAttackMixin engage. */
                    weaponType:  new fields.StringField({ initial: "melee" }),
                    rangeMeters: new fields.NumberField({ initial: 0, integer: true, min: 0 }),
                    // Reliability — hits the weapon withstands before damaging.
                    // Listed for book monster attacks (WJ etc.); Core natural
                    // weapons print none, so null = "not applicable / blank".
                    reliability: new fields.NumberField({ initial: null, integer: true, min: 0, nullable: true }),
                    /* Stamina cost per use — modern Witcher stat blocks
                     * (Monsters on the Road, Lords & Lands, Easy Mode) print
                     * "STA X" alongside damage for taxing signature attacks.
                     * On invocation the monster spends this much STA; if the
                     * pool can't cover it the attack is refused (with a
                     * warning), matching the character-side cast/defense
                     * STA-gate. Default 0 = no cost (Core natural weapons). */
                    staminaCost: new fields.NumberField({ initial: 0, integer: true, min: 0 }),
                    /* Weapon skill the to-hit rolls with: 1d10 + the skill's
                     * governing stat + its rank + WA. Defaults to Melee. */
                    skill:  new fields.StringField({ initial: "melee" }),
                    /* WA — Weapon Accuracy bonus added on top of the skill-derived
                     * to-hit (and folded into the parry/block defense roll).
                     * Mirrors a PC weapon's accuracy. */
                    weaponAccuracy: new fields.NumberField({ initial: 0, integer: true }),
                    /* Legacy: pre-skill-model attacks stored a single flat "Attack
                     * +X" here. No longer used for rolling (attacks are always
                     * skill-derived now), but retained so the bestiary / dissect
                     * knowledge readouts can still surface it for old monsters. */
                    flatBonus:    new fields.NumberField({ initial: 0, integer: true }),
                    /* Defense toggles — when on, this base attack can be used to
                     * Parry / Block an incoming melee strike (the monster analog
                     * of a character's natural-weapon parry/block race toggle).
                     * Item-less: the defense rolls this attack's own skill (or
                     * flat bonus). A claw might parry; a bite might not. */
                    canParry: new fields.BooleanField({ initial: false }),
                    canBlock: new fields.BooleanField({ initial: false }),
                    // Weapon Effects keys (WEAPON_QUALITIES) the attack carries
                    // — Silver, Bleeding, etc. Parameterized ones store their
                    // inline value (the % / dice / integer) in `qualityValues`,
                    // mirroring the weapon item model so the combat engine reads
                    // both the same way.
                    qualities:     new fields.ArrayField(new fields.StringField()),
                    qualityValues: new fields.ObjectField(),
                    /* Damage types the attack inflicts (DAMAGE_TYPES keys —
                     * slashing, piercing, bludgeoning, fire, ...). Surfaces in
                     * the damage calculator's per-type reaction lookup on the
                     * target (resistant/vulnerable/immune). Without this the
                     * monster's attack rolled as typeless and bypassed every
                     * vulnerability the target had set. */
                    damageTypes:   new fields.ArrayField(new fields.StringField()),
                    shown:  shown()
                })),
                // Per-damage-type reaction (none/resistant/vulnerable/immune).
                damageProfile: new fields.SchemaField(
                    Object.fromEntries(Object.keys(DAMAGE_TYPES).map(k =>
                        [k, new fields.StringField({ initial: "none" })]))
                ),
                // Status-effect ids the monster cannot suffer (poison, etc.).
                statusImmunities: new fields.ArrayField(new fields.StringField()),
                // Status ids the monster RESISTS (not negates) — the middle
                // tier between none and immune. RAW leaves the mechanical
                // effect per-condition (deferred to the combat engine, like
                // damageProfile "resistant"); for now it's authored data the
                // bestiary lists under Resistances. A status sits in at most
                // one of the two arrays (the sheet chip cycles none→resist→
                // immune); immune wins if both are somehow set.
                statusResistances: new fields.ArrayField(new fields.StringField()),
                // Free-text "Vulnerabilities" box (oils, silver, tactics).
                vulnerabilities: new fields.ArrayField(new fields.SchemaField({
                    name:  new fields.StringField({ initial: "" }),
                    note:  new fields.StringField({ initial: "" }),
                    shown: shown()
                })),
                // Free-text "Abilities" box (Amphibious, Feral, …).
                specialAbilities: new fields.ArrayField(new fields.SchemaField({
                    name:        new fields.StringField({ initial: "" }),
                    description: new fields.HTMLField({ initial: "" }),
                    shown:       shown()
                })),
                /* Linked spells / hexes / rituals. A caster monster (necromancer,
                 * mage-hunter, ancient vampire) doesn't need its own attack row
                 * for a signature spell — it points at a spell item (world or
                 * compendium) via UUID and stamps a monster-side range / ROF /
                 * flat cast bonus. The chrome monster dock and the sheet's
                 * spells section fold these into cast-buttons that route
                 * through the shared castSpell pipeline. `stayCost` overrides
                 * the spell's STA cost when the printed stat block deviates
                 * from the RAW spell (many book monsters cast at reduced
                 * cost or free). Empty rangeMeters means "use the spell's
                 * own range"; non-zero overrides. */
                spells: new fields.ArrayField(new fields.SchemaField({
                    uuid:        new fields.StringField({ initial: "" }),
                    name:        new fields.StringField({ initial: "" }),
                    rangeMeters: new fields.NumberField({ initial: 0, integer: true, min: 0 }),
                    rof:         new fields.NumberField({ initial: 1, integer: true, min: 1 }),
                    flatBonus:   new fields.NumberField({ initial: 0, integer: true }),
                    staCost:     new fields.NumberField({ initial: null, integer: true, min: 0, nullable: true }),
                    shown:       shown()
                }))
            }),

            notes: new fields.HTMLField({ initial: "" }),

            // ── Knowledge tiers (bestiary research, always on). ──────────
            // Each tier is lore gated behind a skill check at a DC (Core
            // bestiary: "Commoner Superstition (Education DC:14)" etc.).
            // `shown` is the visibility flag the research system will drive.
            knowledge: new fields.ArrayField(new fields.SchemaField({
                label: new fields.StringField({ initial: "" }),   // "Academic Knowledge"
                skill: new fields.StringField({ initial: "education" }), // skillMap key
                dc:    new fields.NumberField({ initial: 10, integer: true, min: 0 }),
                text:  new fields.HTMLField({ initial: "" }),
                shown: shown()
            })),

            // ── Signature mutagen. ───────────────────────────────────────
            // RAW: slaying a monster and harvesting it yields its mutagen,
            // the alchemy ingredient for decoctions tied to that creature.
            // A single linked mutagen Item (dragged onto the sheet) — `uuid`
            // points at the source so the (future) harvest flow can grant it;
            // `name` is cached for display when the source is unavailable.
            mutagen: new fields.SchemaField({
                name: new fields.StringField({ initial: "" }),
                uuid: new fields.StringField({ initial: "" })
            }),

            // ── Loot / harvest drops. ────────────────────────────────────
            // Mostly real alchemy components; `uuid` optionally links the
            // source item so the (future) harvest flow can grant it.
            //
            // `kind` distinguishes two row shapes:
            //   "item"   — a single linked drop (name + qty + uuid).
            //   "random" — a *pool* of candidates (`pool`); the harvest flow
            //              rolls from it `qty` times (qty parses as a dice
            //              code, e.g. "1d6"). Each candidate links an Item or
            //              a RollTable; candidates never stack (deduped by uuid).
            loot: new fields.ArrayField(new fields.SchemaField({
                kind:  new fields.StringField({ initial: "item" }),  // "item" | "random"
                name:  new fields.StringField({ initial: "" }),
                qty:   new fields.StringField({ initial: "1" }),  // dice code, e.g. "1" or "3d10"
                uuid:  new fields.StringField({ initial: "" }),
                shown: shown(),
                pool:  new fields.ArrayField(new fields.SchemaField({
                    name: new fields.StringField({ initial: "" }),
                    uuid: new fields.StringField({ initial: "" }),
                    kind: new fields.StringField({ initial: "item" })  // "item" | "table"
                }))
            })),

            // Coin loot. Each denomination stores an OPTIONAL dice expression
            // (blank = no coins of that kind on this monster). The harvest flow
            // rolls each expression at loot time; the rolled totals surface in
            // the carcass popup as Take rows that transfer straight into the
            // taker's currency.
            coinLoot: new fields.SchemaField(
                Object.fromEntries(CURRENCY_KEYS.map(k => [
                    k, new fields.StringField({ initial: "" })
                ]))
            ),

            // Mount role. A monster (e.g. a horse stat-block) can serve as
            // a mount. `controlBonus` is a modifier (can be negative for an
            // unruly beast) that, when this monster is linked as a rider's
            // mount in the inventory chrome UI, is applied as a bonus to the
            // rider's Riding skill (see chrome/sheets/character-mount.js).
            mount: new fields.SchemaField({
                isMount:      new fields.BooleanField({ initial: false }),
                controlBonus: new fields.NumberField({ initial: 0, integer: true })
            })
        };
    }

    /* Seed `combat.weaponWeakness` for legacy monsters that pre-date the
     * field. Under the Death March house rule every non-humanoid category
     * defaults to "silver" (defaultWeaponWeaknessFor), folding the RAW
     * meteorite column into a single silver-material gate. Any world that
     * already stored "meteorite" is preserved; the GM can override per
     * monster in the sheet.
     *
     * v14 gotcha: Foundry runs migrateData on PARTIAL update deltas too.
     * A partial like `{ combat: { hp: { value: 8 } } }` (edit HP) hits
     * the `data.combat` guard AND has `weaponWeakness` undefined AND has
     * `category` undefined at the top level — so the seed fires with
     * `defaultWeaponWeaknessFor(undefined) === "none"` and silently
     * resets a GM-authored `silver` back to `none` on every HP change.
     *
     * The `data.category` guard below skips partial deltas (category is
     * only present in FULL source loads — creation, world open, world
     * migration). Legacy full loads still hit the seed; partial updates
     * pass through untouched. */
    static migrateData(data) {
        if (data?.combat && data?.category !== undefined
            && (data.combat.weaponWeakness === undefined
                || data.combat.weaponWeakness === null
                || data.combat.weaponWeakness === "")) {
            data.combat.weaponWeakness = defaultWeaponWeaknessFor(data.category);
        }
        return super.migrateData(data);
    }

    calcCurrencyWeight() {
        return calcCurrencyWeight(this.currency);
    }

    /**
     * Secondary stats — same RAW formulas as character (Core p.48 / p.156
     * / p.162 / p.176). Wound + death penalties, brawling math, skill
     * totals. See character.mjs for the full pipeline writeup.
     */
    prepareDerivedData() {
        // Fold each core stat's unbounded AE `modifier` into its prepared
        // `value` before any derived math (see CharacterData.prepareDerivedData).
        for (const stat of Object.values(this.stats ?? {})) {
            if (typeof stat?.modifier === "number" && stat.modifier !== 0) {
                stat.value = (Number(stat.value) || 0) + stat.modifier;
            }
        }

        const baseBody = Number(this.stats?.body?.value) || 0;
        const baseWill = Number(this.stats?.will?.value) || 0;
        const baseWoundThreshold = Math.floor((baseBody + baseWill) / 2);

        const hpVal   = Number(this.derivedStats?.hp?.value) || 0;
        // HP max is MANUAL for monsters, so the dying check reads the actual
        // authored max (a high-HP monster with low BODY+WILL must still count
        // as alive); a blank new monster (max 0) is correctly never "dying".
        const hpMax   = Number(this.derivedStats?.hp?.max) || 0;
        // House rule: Death State is STRICTLY negative HP — exactly 0 does not count.
        const dying   = hpMax > 0 && hpVal < 0;
        const wounded = !dying && baseWoundThreshold > 0 && hpVal > 0 && hpVal < baseWoundThreshold;
        this.healthState = { wounded, dying, woundThreshold: baseWoundThreshold };

        /* Snapshot the unmodified stat values BEFORE the wound/dying halving
         * mutates them. monsterVirtualWeapon reads `refUnmodified` to compute
         * the wound penalty on flat-bonus attacks (penalty = unmodified −
         * current). Without this snapshot, the source value is only on
         * `_source` which isn't reliably populated for synthetic actors. */
        this.derivedStats.refUnmodified  = Number(this.stats?.ref?.value)  || 0;
        this.derivedStats.dexUnmodified  = Number(this.stats?.dex?.value)  || 0;
        this.derivedStats.intUnmodified  = Number(this.stats?.int?.value)  || 0;
        this.derivedStats.willUnmodified = Number(this.stats?.will?.value) || 0;

        if (dying) {
            for (const k of ["int","ref","dex","body","spd","emp","cra","will","luck"]) {
                if (this.stats?.[k]) {
                    this.stats[k].value = Math.floor((Number(this.stats[k].value) || 0) / 3);
                }
            }
            if (this.stats?.toxicity) {
                this.stats.toxicity.value = Math.floor((Number(this.stats.toxicity.value) || 0) / 3);
            }
        } else if (wounded) {
            for (const k of ["ref","dex","int","will"]) {
                if (this.stats?.[k]) {
                    this.stats[k].value = Math.floor((Number(this.stats[k].value) || 0) / 2);
                }
            }
        }

        const body = Number(this.stats?.body?.value) || 0;
        const will = Number(this.stats?.will?.value) || 0;
        const intl = Number(this.stats?.int?.value)  || 0;
        const spd  = Number(this.stats?.spd?.value)  || 0;
        const bwHalf = Math.floor((body + will) / 2);
        const wiHalf = Math.floor((will + intl) / 2);

        // Secondary stats. Audited against the Core bestiary (p.268+): stun,
        // ENC, Run and Leap match the character formulas for EVERY monster, so
        // they always derive. HP, STA and REC are disconnected — HP is often
        // ~2× the formula, STA can be "—"/0 for constructs (Golem), and REC
        // deviates for a few (Mage, Fiend) — so they are MANUAL on the monster
        // sheet: an authored stat block (hp.max > 0) keeps its printed
        // HP/STA/REC verbatim, INCLUDING an intentional STA of 0. Only a blank
        // new monster (hp.max 0) seeds those three from the formula as an
        // authoring convenience. resolve/woundThreshold are never printed, so
        // they always derive.
        this.derivedStats.stun           = Math.max(1, Math.min(10, bwHalf));
        this.derivedStats.stunUnmodified = Math.max(1, Math.min(10, baseWoundThreshold));
        this.derivedStats.resolve        = wiHalf * 5;
        this.derivedStats.woundThreshold = bwHalf;
        this.derivedStats.enc            = body * 10;
        this.derivedStats.run            = spd * 3;
        this.derivedStats.leap           = Math.floor((spd * 3) / 5);

        const authored = Number(this.derivedStats?.hp?.max) > 0;
        if (!authored) {
            this.derivedStats.hp.max  = bwHalf * 5;
            this.derivedStats.sta.max = bwHalf * 5;
            this.derivedStats.rec     = bwHalf;
        }

        const meleeBonus = Math.ceil((body - 6) / 2) * 2;
        this.derivedStats.meleeBonus = meleeBonus;
        this.derivedStats.punch = `1d6${meleeBonus >= 0 ? "+" : ""}${meleeBonus}`;
        this.derivedStats.kick  = `1d6+${meleeBonus + 4}`;

        const skillMap = globalThis.CONFIG?.WITCHER?.skillMap ?? {};
        for (const [statKey, group] of Object.entries(this.skills ?? {})) {
            const statVal = Number(this.stats?.[statKey]?.value) || 0;
            for (const [skillKey, skill] of Object.entries(group)) {
                const rank = Number(skill?.value)    || 0;
                const mod  = Number(skill?.modifier) || 0;
                skill.total = statVal + rank + mod;
                skill.isDifficult = skillMap[skillKey]?.costMultiplier === 2;
                skill.hasRank = rank > 0;
            }
        }

        // Event ledger + conditional actions — applied last (see character.mjs step 6).
        applyEventLedger(this.parent);
        applyConditionActions(this.parent);
    }
}
