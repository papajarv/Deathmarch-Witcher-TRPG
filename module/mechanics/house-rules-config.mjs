/**
 * house-rules-config — one shared source of truth for every GLOBAL
 * house-rules tunable.
 *
 * These are world-wide defaults for combat mechanics that RAW hardcodes
 * (or that this system hardcoded as constants). Per-actor Active Effect
 * modifiers (`offhandPenaltyReduction`, strong-strike penalty reductions,
 * additive-defense recurrence tuneables, etc.) still layer ON TOP of
 * these globals — the panel sets the baseline, AEs adjust per actor.
 *
 * Consumers pull the LIVE config every time they need it (via
 * `getHouseRulesConfig()`) so GM edits take effect on the next check
 * without a world reload.
 *
 * The world setting stores only fields the GM has changed vs. the
 * defaults — reading is always `deepClone(defaults) → mergeObject(stored)`
 * so freshly added fields pick up their default value automatically.
 */

const SYSTEM_ID = "witcher-ttrpg-death-march";
const SETTING_KEY = "houseRulesConfig";

/** Defaults for every house-rules tunable. Adding a new field here:
 *   1. Extend this object.
 *   2. Surface it in the HouseRulesConfigApp form template + submit path.
 *   3. Read it via `getHouseRulesConfig().<newField>` at the consumer.
 *      Wrap the read behind a `hr*` helper (see the getters at the
 *      bottom of this file) so consumer sites stay short and any
 *      future rename lands in one place.
 * No migration needed — `mergeObject` fills any missing key from
 * defaults on read. */
export const HOUSE_RULES_CONFIG_DEFAULTS = Object.freeze({
    /* ═════════════ COMBAT STRIKE RESTRICTIONS ═════════════ */

    /* When true, bows cannot use the Strong Strike variant. Common
     * house rule: a bow's shot placement is precise but low-force —
     * a Strong Strike (doubled damage at -3 to hit) is thematically
     * a melee power strike, not a bow shot. Crossbows and thrown
     * weapons are already blocked from strong strike by the shipped
     * code (allowsStrikeVariants in attackDialog.mjs); this toggle
     * folds bows into the same category. */
    bowsCannotStrongStrike: false,

    /* ═════════════ CRITICAL WOUND SEVERITY BRACKETS ═════════════ */

    /* Attack-vs-defense delta thresholds that decide which critical
     * wound severity is scored. RAW defaults (Core p.152 sidebar + Core
     * p.158 Critical Wounds): simple=7, complex=10, difficult=13,
     * deadly=15. Table adjusts the "beat defense by" ladder for tables
     * that want a swingier or more forgiving crit rhythm.
     *
     * Consumed via hrCritBrackets() below, which enforces ascending
     * order + integers ≥ 1 on read. The pure helper in
     * combat/critSeverity.mjs takes the object as an argument so tests
     * stay deterministic against the RAW ladder. */
    critBracketSimple:    7,
    critBracketComplex:  10,
    critBracketDifficult: 13,
    critBracketDeadly:   15,

    /* ═════════════ CRIT BONUS DAMAGE SP GATE ═════════════ */

    /* When true, crit BONUS damage is also suppressed if the base
     * weapon damage failed to break through the target's Stopping
     * Power at the hit location (i.e. SP soaked every point of
     * weapon damage). RAW: crit bonus bypasses armor SP + DR and
     * lands even when the base strike was fully absorbed. House
     * rule: no crit "kicker" if the strike itself was completely
     * turned by armor. Toggle this OFF to keep RAW behavior. */
    critBonusNeedsSpBreak: false,

    /* ═════════════ SILVER RULES ═════════════ */
    /* The 7/11/25 "Silver Weapon Trait" model is now the system's ONLY silver
     * rule — no longer optional. The legacy "standard + separate silver damage"
     * quality is gone. See hrNewSilverRules() below (always true). */

    /* ═════════════ CRIT BONUS DAMAGE LADDERS ═════════════ */

    /* Flat bonus damage added on top of the weapon damage roll per
     * critical wound severity. Two RAW ladders (Core p.158/159):
     *   normal   → 3/5/8/10
     *   noOrgans → 5/10/15/20  (elementa / specter / immuneToOrganCrits;
     *                            the higher table replaces the wound
     *                            effect that doesn't apply to them)
     * Consumed via hrCritBonusLadders() below, which clamps each field
     * to a non-negative integer (0 disables that tier's bonus; negative
     * would heal the target — silly). */
    critBonusSimple:           3,
    critBonusComplex:          5,
    critBonusDifficult:        8,
    critBonusDeadly:          10,
    critBonusNoOrgansSimple:   5,
    critBonusNoOrgansComplex: 10,
    critBonusNoOrgansDifficult:15,
    critBonusNoOrgansDeadly:  20,

    /* ═════════════ CRITICAL WOUND SP GATE ═════════════ */

    /* When a critical wound is about to be auto-applied to a target,
     * check whether the incoming damage actually broke through the
     * target's Stopping Power at the hit location. If not, downgrade
     * the wound per this mode.
     *
     * Modes:
     *   "off"                  — no downgrade; RAW behavior
     *   "greaterToLesser"      — Difficult/Deadly wounds downgrade one
     *                            tier (Deadly→Difficult, Difficult→Complex).
     *                            Simple/Complex land at their rolled tier.
     *   "anyToSimple"          — Any crit that doesn't pierce SP lands
     *                            as Simple regardless of the rolled tier.
     *                            (Strictest interpretation — armor
     *                            "absorbed" most of the strike.) */
    critSpDowngradeMode: "off",

    /* ═════════════ D10 EXPLODE / COLLAPSE CHAINS ═════════════ */

    /* Witcher TRPG's "kickass / bad-day" rule (Core p.21) applied to
     * every d10 skill / check / attack roll:
     *
     *   Nat 10 → EXPLODE UP: roll another d10, ADD, repeat on 10s.
     *   Nat  1 → COLLAPSE DOWN: roll another d10, SUBTRACT, repeat
     *            on 10s. (The nat-1 still counts as a fumble
     *            regardless — the collapse chain is only the "drain"
     *            part of the mechanic.)
     *
     * Both default to TRUE — RAW behavior. Common house rules turn
     * one or both off to make rolls less swingy. When collapse is
     * off, a nat 1 still fires the fumble flag but the drain die(s)
     * don't get rolled or subtracted. When explode is off, a nat 10
     * just stays a 10 with no bonus chain. */
    d10Explode:  true,
    d10Collapse: true,

    /* ═════════════ ACTION ECONOMY ═════════════ */

    /* Extra Action rider — RAW: taking a second attack in an exchange
     * is -3 to hit and costs 3 STA on top of the swing's own cost.
     * `toHit` here is the per-shot penalty on any shot flagged as an
     * "extra action" (the second shot of Fast, second Joint shot,
     * caster action after weapon action, etc.). `staCost` is the flat
     * STA drain applied at round-tally time. */
    extraActionToHit:  -3,
    extraActionStaCost: 3,

    /* Per-defense STA cost after the first free defense of the round.
     * RAW: 1st defense free, +1 STA each. Every extra defense in the
     * same round drains this many STA. Set to 0 to disable the
     * cumulative cost entirely (rare — usually a fast-play house
     * rule). */
    extraDefenseStaCost: 1,

    /* Base Strong Strike to-hit penalty (RAW -3; halved to +2/x2 by
     * some rulebooks or house rules). Applies to any strike whose
     * strike-table entry is `strong`. Per-actor reductions
     * (`combatMods.strongStrikePenaltyReduction`) still fold on top
     * — they REDUCE the penalty, so a -3 base plus a +1 reduction
     * yields -2 on that actor's roll. */
    strongStrikePenalty: -3,

    /* Base Off-Hand attack penalty (RAW -3). Applies to any shot with
     * an off-hand weapon: the second shot of a Joint Attack, an
     * ambidextrous swap, or a single attack with a weapon flagged
     * `offhand`. Per-actor reductions (`combatMods.
     * offhandPenaltyReduction`) still fold on top. */
    offhandPenalty: -3,

    /* ═════════════ MOVEMENT ═════════════ */

    /* Prone crawl (house rule, NOT RAW). RAW: a prone actor can't move until
     * they spend a move action to Stand — no crawling. With this ON, a prone
     * actor may instead CRAWL: a normal move caps at ⌊SPD/5⌋ and a full-turn
     * RUN derives from that (×3 → 3·⌊SPD/5⌋), both floored to a MINIMUM of 1
     * (so a running crawl always covers ≥1 step — ≥2m on a 2m grid — even at
     * low SPD). Running IS allowed and gains ground. Standing is still the
     * alternative. Default OFF = RAW (no movement cap from prone). */
    proneCrawlQuarterSpd: false,

    /* ═════════════ ADRENALINE ═════════════ */

    /* Adrenaline → temporary stamina (house rule, NOT RAW). When ON, the
     * adrenaline-spend menu gains a "Temp STA" option alongside "Temp HP":
     * each adrenaline die converts to 6 temporary stamina (a frost-shield
     * buffer on the STA bar, spent BEFORE real STA). Unlike temp HP it costs
     * NO stamina to convert, and the buffer evaporates at the start of the
     * actor's next turn. Default OFF. */
    adrenalineToTempSta: false,

    /* ═════════════ ENCUMBRANCE ═════════════ */

    /* Container carry limit (house rule, NOT RAW). A character may equip up
     * to `1 + ceil(BODY / 3)` containers for free; every container equipped
     * beyond that adds +1 EV (encumbrance) apiece — folded into the same
     * armor-EV total that penalizes REF / DEX and magic rolls. Default OFF. */
    containerEquipEV: false
});

/** Live, merged config. Reads directly from the world setting; falls
 *  back to defaults for any field the GM hasn't overridden.
 *
 *  NOT CACHED. Object-type settings in Foundry V14 have inconsistent
 *  onChange behavior; a module-scope cache risks serving stale values
 *  after a save. The mergeObject on ~10 flat fields is sub-ms and hot
 *  callers already gate on a broader condition before reading, so
 *  correctness > caching. */
export function getHouseRulesConfig() {
    let stored = {};
    try { stored = game.settings?.get?.(SYSTEM_ID, SETTING_KEY) ?? {}; }
    catch (_) { stored = {}; }
    return foundry.utils.mergeObject(HOUSE_RULES_CONFIG_DEFAULTS, stored, {
        inplace: false,
        overwrite: true
    });
}

/** Persist an edited config object. Merges over the current stored
 *  state so partial edits (single field via the form) don't wipe
 *  unrelated fields. Notifies consumers via a hook so anyone caching
 *  a derived value can invalidate. */
export async function setHouseRulesConfig(patch) {
    const current = game.settings?.get?.(SYSTEM_ID, SETTING_KEY) ?? {};
    const next = foundry.utils.mergeObject(current, patch ?? {}, {
        inplace: false, overwrite: true
    });
    await game.settings.set(SYSTEM_ID, SETTING_KEY, next);
    Hooks.callAll("wdmHouseRulesConfigChanged", next);
}

/* ─────────────── One-liner getters for consumers ─────────────── */

/** True iff bows are house-ruled out of Strong Strike. */
export function hrBowsCannotStrongStrike() {
    return !!getHouseRulesConfig().bowsCannotStrongStrike;
}

/** True iff the "adrenaline → temporary stamina" house rule is on: the
 *  adrenaline-spend menu offers converting dice to 6 temp STA each (free,
 *  expires next turn). Default OFF. */
export function hrAdrenalineToTempSta() {
    return getHouseRulesConfig().adrenalineToTempSta === true;
}

/** True iff the container carry-limit EV house rule is on: equipping more
 *  than 1 + ceil(BODY/3) containers adds +1 EV each. */
export function hrContainerEquipEV() {
    return !!getHouseRulesConfig().containerEquipEV;
}

/** The free equipped-container limit for a BODY score: 1 + ceil(BODY/3). */
export function containerEquipLimit(body) {
    return 1 + Math.ceil((Math.max(0, Number(body) || 0)) / 3);
}

/** Crit SP downgrade mode: "off" | "greaterToLesser" | "anyToSimple". */
export function hrCritSpDowngradeMode() {
    const m = String(getHouseRulesConfig().critSpDowngradeMode ?? "off");
    return (m === "greaterToLesser" || m === "anyToSimple") ? m : "off";
}

/** True iff crit BONUS damage is suppressed when the base weapon
 *  damage failed to break through SP. Default off = RAW behavior
 *  (crit bonus bypasses armor). */
export function hrCritBonusNeedsSpBreak() {
    return !!getHouseRulesConfig().critBonusNeedsSpBreak;
}

/** The Silver Weapon Trait model (R. Talsorian 7/11/25) is now the ONLY silver
 *  rule — it is no longer optional, so this is always true. Kept as a function
 *  so the existing gate call sites don't need rewriting; the legacy branches
 *  they guard are now permanently dead. */
export function hrNewSilverRules() {
    return true;
}

/** Crit bonus-damage ladders — flat bonus per severity, one pair for
 *  normal targets and one for organ-immune (elementa / specter). Each
 *  field clamped to a non-negative integer on read (0 disables that
 *  tier; negative would heal the target). RAW defaults:
 *    normal   → 3/5/8/10
 *    noOrgans → 5/10/15/20 */
export function hrCritBonusLadders() {
    const c = getHouseRulesConfig();
    const clean = (v, fallback) => {
        const n = Math.round(Number(v));
        return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    return {
        normal: {
            simple:    clean(c.critBonusSimple,     3),
            complex:   clean(c.critBonusComplex,    5),
            difficult: clean(c.critBonusDifficult,  8),
            deadly:    clean(c.critBonusDeadly,    10)
        },
        noOrgans: {
            simple:    clean(c.critBonusNoOrgansSimple,     5),
            complex:   clean(c.critBonusNoOrgansComplex,   10),
            difficult: clean(c.critBonusNoOrgansDifficult, 15),
            deadly:    clean(c.critBonusNoOrgansDeadly,    20)
        }
    };
}

/** Critical-wound severity brackets — the "beat defense by" thresholds
 *  for simple/complex/difficult/deadly. Enforces ordered, integer,
 *  ≥1 values on read so a bad config (e.g. simple ≥ complex, from a
 *  console edit or a corrupted save) can never make a tier
 *  unreachable at runtime. RAW defaults: 7/10/13/15. */
export function hrCritBrackets() {
    const c = getHouseRulesConfig();
    const clean = (v, fallback) => {
        const n = Math.round(Number(v));
        return Number.isFinite(n) && n >= 1 ? n : fallback;
    };
    let simple    = clean(c.critBracketSimple,     7);
    let complex   = clean(c.critBracketComplex,   10);
    let difficult = clean(c.critBracketDifficult, 13);
    let deadly    = clean(c.critBracketDeadly,    15);
    /* Enforce strictly ascending — each tier at least one above the
     * previous so every severity is reachable. Bumps upward only, so
     * user's higher-tier intent isn't clobbered by a fat-fingered
     * lower tier. */
    if (complex   <= simple)    complex   = simple    + 1;
    if (difficult <= complex)   difficult = complex   + 1;
    if (deadly    <= difficult) deadly    = difficult + 1;
    return { simple, complex, difficult, deadly };
}

/** Numeric to-hit penalty for extra-action shots (typically negative). */
export function hrExtraActionToHit() {
    return Number(getHouseRulesConfig().extraActionToHit) || 0;
}

/** Flat STA cost drained when an extra action fires. */
export function hrExtraActionStaCost() {
    return Math.max(0, Number(getHouseRulesConfig().extraActionStaCost) || 0);
}

/** Per-defense STA cost after the first free defense in the round. */
export function hrExtraDefenseStaCost() {
    return Math.max(0, Number(getHouseRulesConfig().extraDefenseStaCost) || 0);
}

/** Base Strong Strike to-hit penalty (typically negative). */
export function hrStrongStrikePenalty() {
    return Number(getHouseRulesConfig().strongStrikePenalty) || 0;
}

/** Base Off-Hand attack penalty (typically negative). */
export function hrOffhandPenalty() {
    return Number(getHouseRulesConfig().offhandPenalty) || 0;
}

/** House rule (not RAW): a prone actor may crawl at ¼ SPD (rounded down)
 *  instead of the RAW "can't move until you Stand". Default OFF. */
export function hrProneCrawlQuarterSpd() {
    return getHouseRulesConfig().proneCrawlQuarterSpd === true;
}

/** Whether d10 rolls should chain on nat 10 (add another d10). */
export function hrD10Explode() {
    return getHouseRulesConfig().d10Explode !== false;
}

/** Whether d10 rolls should chain on nat 1 (subtract another d10).
 *  Independent from the fumble flag — a nat 1 still fumbles even
 *  when this is off; only the drain chain is suppressed. */
export function hrD10Collapse() {
    return getHouseRulesConfig().d10Collapse !== false;
}

export const HOUSE_RULES_CONFIG_KEY = SETTING_KEY;
