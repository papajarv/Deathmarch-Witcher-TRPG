/**
 * CharacterData — TypeDataModel for player characters.
 *
 * Composes the shared actor templates (stats, skills, derived stats,
 * currency, lifepath, counters) and adds homebrew fields per ADR 0003.
 *
 * Per the homebrew toggle convention: schema fields are always present;
 * runtime *behavior* gates on `isHomebrewEnabled(...)`. Disabling a
 * homebrew toggle therefore never loses data.
 */

import { statsSchema }        from "./templates/stats.mjs";
import { skillsSchema }       from "./templates/skills.mjs";
import { derivedStatsSchema } from "./templates/derivedStats.mjs";
import { currencySchema, calcCurrencyWeight } from "./templates/currency.mjs";
import { lifepathSchema }     from "./templates/lifepath.mjs";
import { countersSchema }     from "./templates/counters.mjs";
import { combatRoundSchema }  from "./templates/combatRound.mjs";
import { combatModsSchema }   from "./templates/combatMods.mjs";
import { applyConditionActions, applyEventLedger } from "../../setup/config.mjs";
import { derivedMods } from "../../mechanics/statusEngine.mjs";

const fields = foundry.data.fields;

const SYSTEM_ID = "witcher-ttrpg-death-march";

/* Skills the armor EV penalty folds into (Core p.78 "EV & Magic"). The
 * penalty lands on each skill's `modifier` in prepareDerivedData so it
 * surfaces on the sheet and in the roll total, not just at roll time. */
const EV_MAGIC_SKILLS = new Set(["spellcast", "hexweave", "ritcraft"]);

export class CharacterData extends foundry.abstract.TypeDataModel {

    static defineSchema() {
        return {
            ...statsSchema(),
            ...skillsSchema(),
            ...derivedStatsSchema(),
            ...currencySchema(),
            ...lifepathSchema(),
            ...countersSchema(),
            ...combatRoundSchema(),
            ...combatModsSchema(),

            // Homebrew (ADR 0003): stress mechanic. Schema always present;
            // sheet renders the stress tab + accumulation logic gates on
            // isHomebrewEnabled("stress").
            stress: new fields.NumberField({ initial: 0, integer: true, min: 0 }),

            // Homebrew (ADR 0003): food & drink — current satiety pool. Range
            // is conceptually -100 … 125 (the food-and-drink mechanic clamps
            // updates). Default 100 = Full. Fractional values are valid (combat
            // STA→satiety drain hands out -0.5 per STA), so this is NOT an
            // integer field. The hunger TIER is NOT stored — it derives from
            // satiety every reconcile cycle (mechanics/foodAndDrink.mjs).
            // Schema always present; the tick / display / consume flow gates
            // on isHomebrewEnabled("foodAndDrink").
            satiety: new fields.NumberField({ initial: 100, min: -100, max: 125 }),

            // Per-actor satiety drain modifiers. ActiveEffects target these
            // paths via the standard AE change pipeline — e.g. an "Iron
            // Stomach" perk multiplies `scale` by 0.5 to halve the per-hour
            // and per-combat-STA drain; a "Cursed Appetite" effect ADDs 3
            // to `flatPerHour` to make the actor lose extra satiety on top
            // of the normal formula. Schema is always present (ADR 0003);
            // only the reading code paths gate on foodAndDrink.
            satietyDrain: new fields.SchemaField({
                scale:       new fields.NumberField({ initial: 1, min: 0 }),
                flatPerHour: new fields.NumberField({ initial: 0 })
            }),

            // Per-character bestiary knowledge tracking. Bestiary research is
            // always on (no toggle). NOTE: the live chrome bestiary stores
            // per-character progress in flags[SYSTEM_ID].bestiary, not here;
            // this field is retained only so legacy data on existing worlds
            // isn't dropped by schema validation.
            bestiary: new fields.ObjectField({ initial: {} }),

            // Homebrew (ADR 0003): per-book reading state. Keyed by encoded
            // book item UUID. { lastAttemptDay, hits, currentStep, completed }.
            bookUsage: new fields.ObjectField({ initial: {} }),

            // Variable portrait config. Schema always present; the feature is
            // enabled per-actor by owning a race with system.variablePortrait
            // checked (gate lives on the race item, not here). `base` holds one
            // image path per toxicity tier (index 0..6); `conditions` are
            // user-defined override columns matched against active-effect /
            // status names, each carrying its own per-tier image array. See
            // module/chrome/integrations/portrait-toxicity.js.
            variablePortrait: new fields.SchemaField({
                base: new fields.ArrayField(new fields.StringField({ initial: "" }), { initial: [] }),
                conditions: new fields.ArrayField(new fields.SchemaField({
                    name:  new fields.StringField({ initial: "" }),
                    match: new fields.StringField({ initial: "" }),
                    tiers: new fields.ArrayField(new fields.StringField({ initial: "" }), { initial: [] })
                }), { initial: [] })
            })
        };
    }

    /**
     * Sum the weight of all carried coinage.
     * Read at overhaul-ui topbar.js:221 as `actor.system.calcCurrencyWeight()`.
     */
    calcCurrencyWeight() {
        return calcCurrencyWeight(this.currency);
    }

    /**
     * Derived data — RAW Witcher TRPG (Core p.48 master table, p.176
     * verbal combat, p.156 wound threshold, p.162 death state).
     *
     * Pipeline:
     *   1. Snapshot post-AE stats and compute base wound threshold.
     *   2. Decide health state by comparing hp.value to threshold:
     *        - hp ≤ 0  → dying    → ALL stats × 1/3 (p.162)
     *        - hp < wt → wounded  → REF/DEX/INT/WILL × 1/2 (p.156)
     *      Penalties mutate `this.stats[k].value` in place so every
     *      downstream calculation (derived numbers AND skill totals)
     *      reads the reduced number without further work.
     *   3. Compute all derived numbers from the (possibly penalized)
     *      stat values. HP/STA max therefore also reduce when dying —
     *      that's the RAW behavior ("primary AND derived drop to 1/3").
     *   4. Compute Punch / Kick / Bonus Melee from the BODY table.
     *   5. Recompute skill totals = stat.value + rank + modifier.
     *
     * Auto-derived (player can't edit):
     *   hp.max / sta.max  = ((BODY+WILL)/2) × 5         p.48
     *   resolve            = ((WILL+INT)/2) × 5         p.176
     *   focus.max          = ((WILL+INT)/2) × 3         Journal p.145
     *   stun               = clamp((BODY+WILL)/2,1,10)  p.48
     *   rec / woundThr     = (BODY+WILL)/2              p.48/p.156
     *   enc                = BODY × 10                  p.47
     *   run/leap           = SPD×3 / Run÷5              p.47
     *   meleeBonus         = ceil((BODY-6)/2)×2         p.48
     *   punch / kick       = 1d6+meleeBonus / +4        p.48
     *
     * Player-set: hp.value, sta.value, shield, vigor.
     */
    prepareDerivedData() {
        // (0a) Fold each core stat's ActiveEffect `modifier` into its prepared
        //      `value`. The base value is clamped 1-10 at the schema (IP can't
        //      exceed RAW range), but the modifier field is unbounded — so a
        //      buff/debuff can take the PREPARED stat above 10 or below 1.
        //      Done FIRST so every downstream calc (armor EV, wound/death,
        //      derived numbers, skill totals) reads the modified stat. Only
        //      stats carrying a `.modifier` field participate (luck/toxicity
        //      are pools and don't). The statblock's delta readout then shows
        //      `modified - base` = the net modifier.
        for (const stat of Object.values(this.stats ?? {})) {
            if (typeof stat?.modifier === "number" && stat.modifier !== 0) {
                stat.value = (Number(stat.value) || 0) + stat.modifier;
            }
        }

        // (0a′) Empathy floors at 1 no matter how deep the penalty runs — the
        //       witcher mutation's −4 "cannot reduce Empathy below 1" (Core
        //       p.47). The fold above is otherwise uncapped, so clamp the
        //       prepared EMP value here.
        if (this.stats?.emp) {
            this.stats.emp.value = Math.max(1, Number(this.stats.emp.value) || 1);
        }

        // (0) Armor EV penalty (Core p.78). Sum the encumbranceValue from
        //     all equipped armor pieces (shields excluded — they're held,
        //     not worn). Subtracted from REF and DEX with a floor of 1.
        //     Applied BEFORE wound / death state so all downstream math
        //     reflects the encumbered numbers. Per the "EV & Magic" sidebar
        //     the same total is ALSO subtracted from Spell Casting, Hex
        //     Weaving, and Ritual Crafting rolls (it does NOT touch Vigor).
        //     We expose the total on `this.armorEV` so the casting flow can
        //     apply that roll penalty; we don't fold it into the skill
        //     totals here because it only applies to magic rolls, not the
        //     general skill check.
        const armorPieces = this.lifepathModifiers?.ignoredArmorEncumbrance
            ? []
            : (this.parent?.items?.filter?.(
                i => i.type === "armor" && i.system?.equipped &&
                     (i.system?.location !== "Shield" && i.system?.armorType !== "shield")
            ) ?? []);
        let evTotal = 0;
        for (const a of armorPieces) evTotal += Number(a.system?.encumbranceValue) || 0;
        // Schools that tolerate encumbrance (combatMods.evTolerance) ignore that
        // many points of EV (Bear School ignores armor penalties entirely).
        evTotal = Math.max(0, evTotal - (Number(this.combatMods?.evTolerance) || 0));
        if (evTotal > 0) {
            for (const k of ["ref", "dex"]) {
                if (this.stats?.[k]) {
                    this.stats[k].value = Math.max(1, (Number(this.stats[k].value) || 0) - evTotal);
                }
            }
        }
        this.armorEV = evTotal;

        // (1) Base wound threshold — needed BEFORE any penalty is applied
        //     so the dying/wounded decision uses the un-penalized number.
        const baseBody = Number(this.stats?.body?.value) || 0;
        const baseWill = Number(this.stats?.will?.value) || 0;
        const baseWoundThreshold = Math.floor((baseBody + baseWill) / 2);

        // (2) Health state — RAW penalties stack as floor division on the
        //     stat.value. Dying supersedes wounded (you can only be one).
        //     Temp HP is effective HP: it absorbs damage before real HP, so it
        //     also counts toward the wound/death decision — a big enough temp
        //     buffer pulls you back above the threshold and out of death state.
        const hpVal   = Number(this.derivedStats?.hp?.value) || 0;
        const hpTemp  = Math.max(0, Number(this.derivedStats?.hp?.temp) || 0);
        const hpEff   = hpVal + hpTemp;
        const hpMax   = baseWoundThreshold * 5;  // would-be max before penalty
        // Death state needs a *filled* character — fresh sheets are 0/0,
        // and applying ×⅓ to a zeroed character would just lock them at 0.
        // Same logic for wounded: no threshold means no penalty.
        const dying   = hpMax > 0 && hpEff <= 0;
        const wounded = !dying && baseWoundThreshold > 0 && hpEff > 0 && hpEff < baseWoundThreshold;

        // State-penalty suppression — alchemical effects (e.g. Golden Oriole,
        // bespoke potions) can carry AE flags that switch off the RAW death /
        // wound stat reductions. Scanned from the active applicable effects;
        // the "initial" AE phase has already run, so flags are settled on the
        // documents. The dying / wounded *state* still reports true — only the
        // stat mutation is gated, so the rest of the sheet still shows the
        // condition.
        let suppressDeath = false, suppressWound = false;
        for (const e of this.parent?.allApplicableEffects?.() ?? []) {
            if (!e.active) continue;
            // Unified action model: suppress-type rows in flags.<sys>.actions.
            const actions = e.flags?.[SYSTEM_ID]?.actions;
            if (Array.isArray(actions)) {
                for (const a of actions) {
                    if (a?.type !== "suppress") continue;
                    if (a.what === "death") suppressDeath = true;
                    if (a.what === "wound") suppressWound = true;
                }
            }
            // Legacy flat flags — honored until the effect is re-saved.
            if (e.getFlag(SYSTEM_ID, "suppressDeathPenalty")) suppressDeath = true;
            if (e.getFlag(SYSTEM_ID, "suppressWoundPenalty")) suppressWound = true;
        }
        this.healthState = { wounded, dying, woundThreshold: baseWoundThreshold, suppressDeath, suppressWound };

        // A dying character is also below the wound threshold. If only the
        // DEATH penalty is suppressed, they still take the (lighter) WOUND
        // penalty — otherwise dropping to 0 HP would make you BETTER off than
        // sitting at 1 HP. The wound penalty only goes away if it's
        // suppressed in its own right.
        const applyDeath = dying && !suppressDeath;
        const applyWound = !applyDeath && (wounded || dying) && !suppressWound;

        if (applyDeath) {
            // All primary stats (incl. SPD, LUCK) and toxicity × 1/3.
            // Derived numbers will reduce on their own once stats reduce.
            for (const k of ["int","ref","dex","body","spd","emp","cra","will","luck"]) {
                if (this.stats?.[k]) {
                    this.stats[k].value = Math.floor((Number(this.stats[k].value) || 0) / 3);
                }
            }
            if (this.stats?.toxicity) {
                this.stats.toxicity.value = Math.floor((Number(this.stats.toxicity.value) || 0) / 3);
            }
        } else if (applyWound) {
            // REF / DEX / INT / WILL × 1/2 (p.156). BODY/EMP/CRA/SPD/LUCK
            // are unaffected by the wound penalty per RAW.
            for (const k of ["ref","dex","int","will"]) {
                if (this.stats?.[k]) {
                    this.stats[k].value = Math.floor((Number(this.stats[k].value) || 0) / 2);
                }
            }
        }

        // (3) Derived numbers — read from CURRENT (possibly penalized) stats.
        const body = Number(this.stats?.body?.value) || 0;
        const will = Number(this.stats?.will?.value) || 0;
        const intl = Number(this.stats?.int?.value)  || 0;
        const spd  = Number(this.stats?.spd?.value)  || 0;
        const bwHalf = Math.floor((body + will) / 2);
        const wiHalf = Math.floor((will + intl) / 2);

        this.derivedStats.hp.max         = bwHalf * 5;
        this.derivedStats.sta.max        = bwHalf * 5;
        // Engine-driven derived modifiers (mechanics/statusEngine.derivedMods).
        // Sums every active status's `mods.derived.*` aggregate — currently:
        //   staMaxFraction  shrinks sta.max multiplicatively (hungry: -0.2,
        //                   famished: -0.4). Floor at 0 so a stacked debuff
        //                   never goes negative.
        //   recBonus        flat REC add (gorged: +2). Composed with the BODY/
        //                   WILL base below.
        // This is the food-and-drink (hunger / gorged) hook. Any other future
        // status can declare the same clause fields to ride the same pipe.
        const sMods = derivedMods(this.parent);
        if (sMods.staMaxFraction !== 0) {
            this.derivedStats.sta.max = Math.max(0,
                Math.floor(this.derivedStats.sta.max * (1 + sMods.staMaxFraction)));
        }
        this.derivedStats.resolve        = wiHalf * 5;
        // Investigation Focus pool (A Witcher's Journal p.145): max is derived,
        // value is player-set and drained by failed Evidence checks / obstacles.
        this.derivedStats.focus.max      = wiHalf * 3;
        this.derivedStats.stun           = Math.max(1, Math.min(10, bwHalf));
        // Unmodified stun = from the pre death/wound-penalty BODY+WILL
        // (baseWoundThreshold). Death saves use this so the death-state ×⅓
        // debuff doesn't also drag down the save made to survive it.
        this.derivedStats.stunUnmodified = Math.max(1, Math.min(10, baseWoundThreshold));
        // REC = daily HP recovery (p.173). The wound penalty (p.156) halves
        // only REF/DEX/INT/WILL and does NOT recalc derived stats, so REC stays
        // on the FULL BODY+WILL when wounded. Death State is the lone exception:
        // "all stats (both primary & derived) fall to 1/3" (p.158). This stays
        // the canonical value — final-phase AEs (DERIVED_STAT_TARGETS) fold on
        // top of it, so REC remains modifiable by effects/items.
        this.derivedStats.rec            = (applyDeath ? Math.floor(baseWoundThreshold / 3) : baseWoundThreshold)
                                            + (sMods.recBonus || 0);
        this.derivedStats.woundThreshold = bwHalf;
        this.derivedStats.enc            = body * 10;
        this.derivedStats.run            = spd * 3;
        this.derivedStats.leap           = Math.floor((spd * 3) / 5);

        // Vigor floor — the profession's starting Vigor allowance (Core p.38)
        // is a baseline the character can't drop below. The stored vigor is
        // player-set (+ any AE modifiers, already applied this prepare cycle);
        // we only raise it to the profession floor, never lower it. Multiple
        // profession items (edge case) → the highest baseline wins.
        let profVigor = 0;
        for (const it of this.parent?.items ?? []) {
            if (it.type === "profession") profVigor = Math.max(profVigor, Number(it.system?.vigor) || 0);
        }
        this.derivedStats.vigor = Math.max(Number(this.derivedStats.vigor) || 0, profVigor);

        // (4) BODY-table brawling math (p.48). Formula derived to match
        //     the printed table exactly:
        //       BODY 1-2  → -4  (1d6-4 punch / 1d6 kick)
        //       BODY 3-4  → -2
        //       BODY 5-6  →  0
        //       BODY 7-8  → +2
        //       BODY 9-10 → +4   etc.
        const meleeBonus = Math.ceil((body - 6) / 2) * 2;
        this.derivedStats.meleeBonus = meleeBonus;
        this.derivedStats.punch = `1d6${meleeBonus >= 0 ? "+" : ""}${meleeBonus}`;
        this.derivedStats.kick  = `1d6+${meleeBonus + 4}`;

        // (5) Skill totals + difficulty flag. Totals pick up any wound /
        //     death penalties via the reduced stats.X.value snapshot.
        //     isDifficult mirrors SKILL_MAP[key].costMultiplier === 2
        //     (RAW Core p.49 — the 10 two-cost skills) so the sheet can
        //     mark them without re-reading config in the template.
        const skillMap = globalThis.CONFIG?.WITCHER?.skillMap ?? {};
        for (const [statKey, group] of Object.entries(this.skills ?? {})) {
            const statVal = Number(this.stats?.[statKey]?.value) || 0;
            for (const [skillKey, skill] of Object.entries(group)) {
                // Fold the armor EV penalty into the magic skills' modifier
                // (evTotal is already 0 when ignoredArmorEncumbrance).
                if (evTotal > 0 && EV_MAGIC_SKILLS.has(skillKey)) {
                    skill.modifier = (Number(skill.modifier) || 0) - evTotal;
                }
                const rank = Number(skill?.value)    || 0;
                const mod  = Number(skill?.modifier) || 0;
                skill.total = statVal + rank + mod;
                skill.isDifficult = skillMap[skillKey]?.costMultiplier === 2;
            }
        }

        // (6) Event-triggered accumulations (adrenalineGain, eachTurn, …) from
        //     the engine's persistent ledger, then conditional actions — both
        //     applied last so they see the fully-derived values. Ledger first
        //     so a condition can test an event-modified value.
        applyEventLedger(this.parent);
        applyConditionActions(this.parent);
    }
}
