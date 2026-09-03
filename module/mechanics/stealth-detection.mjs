/**
 * stealth-detection — the detection model.
 *
 * TWO IDEAS, KEPT SEPARATE. Confusing them is what broke every earlier version.
 *
 *  1. The CONE is where checks happen. Its size comes from BASE numbers
 *     (`stat + skill`, both sides) plus the world — ambient light, weather, the
 *     watcher's arc. NO DICE. It holds still, so it can be learned and planned
 *     around. An earlier cone folded in the d10 result and swung between 0.4×
 *     and 2.5×, so re-entering stealth redrew every cone on the map and the
 *     world's geometry appeared to change because the player rolled dice.
 *
 *  2. INSIDE it, the SNEAK rolls every tick. Guards never roll — a guard is a
 *     static DC. Distance modifies the CHECK, never the shape, so a tier can
 *     honestly say "checks here are at −10" and stay true tick after tick.
 *
 * Base is `stat + skill` — the guaranteed floor of a Witcher roll, NOT the D&D
 * `10 + …` passive (that convention is used only for the DC).
 *
 * PURE MODULE: plain values in, plain values out. No canvas, no documents, no
 * Foundry globals beyond the config read. The caller gathers the facts. That
 * keeps it unit-testable and free of the import cycle it would otherwise form
 * with stealth-hooks via light-level.
 */

import { getStealthConfig } from "./stealth-config.mjs";

/** Movement pace, derived from measured distance covered in the window. */
export const PACE = Object.freeze({
    STILL: "still", CREEP: "creep", WALK: "walk", RUN: "run"
});

/** Numeric config read with a fallback. `Number(undefined)` is NaN, and one NaN
 *  factor silently poisons every multiplication downstream — a NaN reach
 *  compares false against everything and reads as "never detected". A
 *  configured 0 is preserved; only non-finite falls back. */
function num(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

/** One d10. Single source of randomness for the model. */
export function rollD10() {
    return Math.floor(Math.random() * 10) + 1;
}

/* ─────────── cone size: base vs base, plus the world ─────────── */

/**
 * Light's effect on how far a watcher sees. LINEAR, not geometric:
 * daylight 1.0 · dim−1 0.8 · dim−2 0.6 · dim−3 0.4 · darkness 0.2 · pitch 0.
 *
 * An even ladder gives every tier the same weight, so moving one step deeper
 * into the dark is always worth the same. The previous `0.65 ^ penalty` curve
 * bunched the three dim tiers near the top (0.65 / 0.42 / 0.27) and left
 * darkness barely distinct from deep gloom.
 *
 * Still derived from `LIGHT_TIER_PENALTY` (the caller passes the penalty), so
 * retuning that ladder retunes stealth and the two cannot drift apart.
 */
export function kLight(awarenessPenalty, isPitch = false) {
    if (isPitch) return 0;
    const step = num(getStealthConfig().lightStep, 0.2);
    return Math.max(0, 1 - step * Math.abs(num(awarenessPenalty, 0)));
}

/** Weather on the WATCHER, on the same ladder as light — so "fog costs two
 *  points of awareness" and "two tiers darker" shorten reach identically. */
export function kWeather(awarenessPenalty) {
    const penalty = Math.abs(num(awarenessPenalty, 0));
    if (penalty <= 0) return 1;
    return Math.max(0, 1 - num(getStealthConfig().lightStep, 0.2) * penalty);
}

/** Angular position within the watcher's arc — the cone narrows at the edges. */
export function kZone(zoneKey) {
    const m = getStealthConfig().zoneMults ?? {};
    return num(m[zoneKey], num(m.focused, 1.0));
}

/**
 * Skill term for the cone's SIZE: base vs base, never a roll.
 *
 * The clamp is deliberately narrow. The sneak's base is also in the in-cone
 * roll, so a wide clamp would count the same advantage twice and make a high
 * base untouchable — which is exactly what happened before. Skill mainly
 * expresses in the roll; the cone shifts only modestly with it.
 */
export function kBaseSkill(awarenessBase, stealthBase) {
    const cfg  = getStealthConfig();
    const base = num(cfg.skillBase, 1.12);
    const lo   = num(cfg.skillClampMin, 0.5);
    const hi   = num(cfg.skillClampMax, 2.0);
    return Math.min(hi, Math.max(lo, base ** (num(awarenessBase, 0) - num(stealthBase, 0))));
}

/**
 * Radius of the region in which this watcher rolls against this sneak.
 * Contains no dice and nothing that changes tick to tick.
 */
export function coneReachMetres(facts = {}) {
    const cfg  = getStealthConfig();
    const base = num(cfg.dBaseMetres, 80);

    /* Reach ignoring light — what this watcher would see in daylight. */
    const bright = base
        * kWeather(facts.weatherPenalty)
        * kZone(facts.zoneKey)
        * kBaseSkill(facts.awarenessBase, facts.stealthBase);

    const lit = bright * kLight(facts.lightPenalty, facts.lightPitch);

    /* DARKVISION IS A RANGE, NOT A PENALTY REDUCTION.
     *
     * It used to step the light tier one rank brighter, so a creature with 60 m
     * of darkvision still had its cone multiplied down by the dark — nonsense,
     * since within its darkvision it sees as though lit. Treated as a FLOOR:
     * out to `darkvisionRange` the watcher sees as if in daylight; beyond it
     * ordinary light rules resume.
     *
     * Self-balancing: darkvision only matters once the dark is deeper than
     * natural night sight. A 12 m race gains nothing until true pitch, because
     * ambient reach already exceeds 12 m in every dim tier.
     *
     * Pitch black stays absolute for anyone without it — `darkVisionRange`
     * returns 0 for those creatures, so both terms are 0.
     */
    const dvFloor = Math.min(Math.max(0, num(facts.darkvisionRange, 0)), bright);
    const D = Math.max(lit, dvFloor);

    /* The night ceiling stops a brightly-lit sneak being seen from the full base
     * distance after dark. It must not cap darkvision, which is a deliberate,
     * purchased ability to see further than that. */
    const ceiling = Number(facts.sightCeiling);
    if (!Number.isFinite(ceiling)) return D;
    return Math.min(D, Math.max(ceiling, dvFloor));
}

/* ─────────── position inside the cone ─────────── */

/** Which display/difficulty tier a position falls in, outermost first. */
export function coneBandFor(d, D) {
    const dd = num(D, 0);
    if (dd <= 0) return null;
    const t = num(d, 0) / dd;
    if (t > 1)    return null;
    if (t > 0.75) return "outer";
    if (t > 0.50) return "mid";
    if (t > 0.25) return "inner";
    return "core";
}

/**
 * Check modifier for how deep into the cone you are. Steep on purpose: the
 * inner tiers must punish proximity hard enough that a towering Stealth base
 * does not make someone untouchable at close range.
 */
export function distanceModifier(d, D) {
    const band = coneBandFor(d, D);
    if (!band) return 0;
    const table = getStealthConfig().tierModifiers ?? {};
    const fallback = { outer: 0, mid: -5, inner: -10, core: -15 };
    return num(table[band], fallback[band] ?? 0);
}

/* ─────────── measured pace ─────────── */

/**
 * Classify ground covered during the window against SPD.
 *
 * MEASURED, never declared: cover 15 m in three seconds and you were running,
 * whatever the HUD says. Two earlier approaches failed and must not return —
 * declared movement action (let a sprint be called walking) and buffering the
 * distance (made the readout lag behind the player by seconds).
 */
export function paceFromDistance(metres, spd) {
    const d = num(metres, 0);
    const s = num(spd, 0);
    if (d <= 0)     return PACE.STILL;
    if (s <= 0)     return PACE.WALK;
    if (d <= s / 2) return PACE.CREEP;
    if (d <= s)     return PACE.WALK;
    return PACE.RUN;
}

/** Pace from Foundry's movement action, kept for callers that want intent
 *  rather than measurement (the badge and mechanics both use the measured
 *  path; this exists for tooling). */
export function paceFromAction(movementAction) {
    switch (String(movementAction ?? "walk")) {
        case "crawl": return PACE.CREEP;
        case "run":   return PACE.RUN;
        default:      return PACE.WALK;
    }
}


/* ─────────── narration ladder ─────────── */

/**
 * Which ladder steps a tick crossed going UP — exclusive of `from`, inclusive
 * of `to`, so a step fires exactly once and a tick that leaps several reports
 * all of them in order.
 */
export function laddersCrossed(from, to, threshold, ladder = []) {
    const f = num(from, 0);
    const t = num(to, 0);
    const th = num(threshold, 0);
    if (th <= 0 || !Array.isArray(ladder)) return [];
    return ladder
        .filter((frac) => { const at = num(frac, 0) * th; return f < at && t >= at; })
        .map((frac) => Math.round(num(frac, 0) * 100))
        .sort((a, b) => a - b);
}

/* ═══════════════════════════════════════════════════════════════════════
 * THE STEALTH CHECK — the stealther rolls; guards never do.
 *
 *     roll = 1d10 + stealthBase + Σ situational modifiers
 *     DC   = 10 + awarenessBase
 *     miss = DC − roll   →   exposure += miss   (spotted at threshold)
 *
 * Margin rather than pass/fail: scraping the DC by one is not the same event as
 * blowing it by eight. Margin makes a bad position degrade fast and a good one
 * degrade slowly, which is what makes the eye's fill mean something.
 *
 * Modifiers are ADDITIVE and phrased from the sneak's side — positive helps you.
 * They are deliberately NOT multiplicative per-factor distances: that was the
 * old model, and folding them into a single reach is what made the cone move
 * for invisible reasons.
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * Darkness helps the sneak: one point per step of the light ladder, AFTER the
 * watcher's night vision has been applied by `resolveLightPenalty`. A tier that
 * watcher's vision waives contributes nothing, which is the whole point of
 * having Night Vision.
 *
 * NEVER Infinity. It used to return Infinity for pitch black as an
 * "undetectable" sentinel, and that leaked into the roll: the total became
 * Infinity, every check was held, and the card printed `Darkness +Infinity` —
 * so a Dark Vision watcher with someone at point-blank range could never see
 * them. Two separate mistakes in one value.
 *
 * "Undetectable" is not this function's job. It is already expressed, correctly
 * and finitely, by `coneReachMetres` returning 0 — no cone means no roll. If a
 * roll IS happening in pitch black, the watcher can necessarily see there
 * (darkvision, or a carried light), so darkness earns the sneak nothing.
 */
export function lightBonus(awarenessPenalty, isPitch) {
    if (isPitch) return 0;
    return Math.abs(num(awarenessPenalty, 0));
}

/** Cover, keyed on the visible fraction from `computeCoverageFraction`. */
export function coverBonus(fraction) {
    const m = getStealthConfig().coverBonuses ?? {};
    const f = num(fraction, 0);
    if (f >= 1.0)  return num(m.exposed,      0);
    if (f >= 0.75) return num(m.threeQuarter, 1);
    if (f >= 0.50) return num(m.half,         2);
    if (f >= 0.25) return num(m.quarter,      4);
    return num(m.sliver, 6);
}

export function postureBonus(isProne) {
    const m = getStealthConfig().postureBonuses ?? {};
    return isProne ? num(m.prone, 2) : num(m.standing, 0);
}

export function paceBonus(pace) {
    const m = getStealthConfig().paceBonuses ?? {};
    const fallback = { still: 2, creep: 1, walk: 0, run: -2 };
    return num(m[pace], fallback[pace] ?? 0);
}

/** Human label for the distance term: which depth tier, and where in the arc. */
function distanceLabel(band, zoneKey) {
    const tier = band ? String(band) : "distance";
    const arc = zoneKey === "far"  ? ", far periphery"
              : zoneKey === "near" ? ", periphery"
              : zoneKey === "focused" ? ", dead ahead"
              : "";
    return `Distance (${tier}${arc})`;
}

/**
 * Every modifier on the sneak's roll, itemised.
 *
 * Returned as parts rather than a bare total so the diagnostic and any future
 * roll card can show the breakdown — "why am I being seen here" should always
 * be answerable without reading source.
 */
export function stealthCheckModifiers(facts = {}) {
    const parts = [
        { key: "light",    label: "Darkness", value: lightBonus(facts.lightPenalty, facts.lightPitch) },
        { key: "cover",    label: "Cover",    value: coverBonus(facts.coverFraction) },
        /* Labelled with the tier AND the arc position it came from. The bare
         * "Distance −5" gave no hint why the number moved when the player
         * sidestepped: being peripheral is not a separate modifier (that would
         * double-count against the cone's zone multiplier) — it shrinks the
         * watcher's reach, so the same tile falls in a gentler tier. Naming
         * both makes that visible instead of mysterious. */
        { key: "distance",
          label: distanceLabel(facts.band, facts.zoneKey),
          value: num(facts.distanceMod, 0) },
        { key: "posture",  label: "Prone",    value: postureBonus(!!facts.prone) },
        { key: "pace",     label: "Movement", value: paceBonus(facts.pace) },
        { key: "weather",  label: "Weather",  value: Math.abs(num(facts.weatherPenalty, 0)) },
        /* Agreed with the GM when the sneak began — a good approach, a bad one,
         * a distraction arranged beforehand. This is what the entry dialog is
         * actually for now that there is no entry roll. */
        { key: "situational", label: "Situational", value: num(facts.entryModifier, 0) }
    ].filter(p => p.value !== 0);

    const total = parts.reduce((sum, p) => sum + p.value, 0);
    return { parts, total };
}

/**
 * Resolve one tick against one guard.
 * @returns {{roll:number, total:number, dc:number, miss:number, modifiers:object}}
 */
export function resolveStealthCheck(facts = {}, dc = 0, d10 = null) {
    const modifiers = stealthCheckModifiers(facts);
    const roll = Number.isFinite(d10) ? d10 : rollD10();

    /* A real Stealth check: 1d10 + stat + skill + situation, against the
     * watcher's passive Awareness. The base IS here — the player is rolling
     * their character's Stealth, not an abstract situation score.
     *
     * The base gap also sizes the cone, which would double-count if left
     * unchecked — that is what made a high base practically invisible. Two
     * things hold it: the cone's clamp is narrow (0.5–2.0), so skill only
     * modestly moves the geometry, and the inner tiers carry heavy penalties
     * (−5 and −12) that no realistic base simply shrugs off. Skill should make
     * you hard to catch at range, not immune at arm's length. */
    const total = roll + num(facts.stealthBase, 0) + modifiers.total;
    return { roll, total, dc: num(dc, 0), miss: num(dc, 0) - total, modifiers };
}
