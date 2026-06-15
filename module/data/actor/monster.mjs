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
import { currencySchema, calcCurrencyWeight } from "./templates/currency.mjs";
import { applyConditionActions, applyEventLedger, DAMAGE_TYPES } from "../../setup/config.mjs";

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
            ...statsSchema({ statMax: null }),
            ...skillsSchema({ rankMax: null }),
            ...derivedStatsSchema(),
            ...currencySchema(),

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
            category: new fields.StringField({ initial: "beast" }), // MONSTER_TYPES key
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
                attacks: new fields.ArrayField(new fields.SchemaField({
                    name:   new fields.StringField({ initial: "" }),
                    damage: new fields.StringField({ initial: "" }),  // dice e.g. "3d6+2"
                    effect: new fields.StringField({ initial: "" }),
                    rof:    new fields.NumberField({ initial: 1, integer: true, min: 1 }),
                    // Reliability — hits the weapon withstands before damaging.
                    // Listed for book monster attacks (WJ etc.); Core natural
                    // weapons print none, so null = "not applicable / blank".
                    reliability: new fields.NumberField({ initial: null, integer: true, min: 0, nullable: true }),
                    // skillMap key the to-hit roll uses (1d10 + that skill's
                    // total). Natural weapons default to Melee.
                    skill:  new fields.StringField({ initial: "melee" }),
                    // Weapon Effects keys (WEAPON_QUALITIES) the attack carries
                    // — Silver, Bleeding, etc. Parameterized ones store their
                    // inline value (the % / dice / integer) in `qualityValues`,
                    // mirroring the weapon item model so the combat engine reads
                    // both the same way.
                    qualities:     new fields.ArrayField(new fields.StringField()),
                    qualityValues: new fields.ObjectField(),
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
        const dying   = hpMax > 0 && hpVal <= 0;
        const wounded = !dying && baseWoundThreshold > 0 && hpVal > 0 && hpVal < baseWoundThreshold;
        this.healthState = { wounded, dying, woundThreshold: baseWoundThreshold };

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
