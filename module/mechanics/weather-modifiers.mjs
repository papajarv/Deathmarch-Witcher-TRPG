/**
 * Weather → mechanical modifiers (Phase 3 of the inbuilt weather subsystem).
 *
 * The weather engine (mechanics/weather.mjs) tags each state with abstract
 * conditions — fog / wind / precip / snow / storm / heat / aurora. This layer
 * turns those tags into TYPED modifier data: a flat list of
 * `{ target, value, label, source }` records. Two consumers share that one
 * shape:
 *
 *   - NOW: a display-only "stacked readout" panel (see chrome/weather.js) that
 *     groups the records by target and shows the net effect with a per-source
 *     breakdown.
 *   - LATER: the planned combat overhaul reads the same records to auto-apply
 *     penalties, summing `value` per `target`. No re-derivation needed.
 *
 * The rule TABLE is original to this system (nothing lifted from any rulebook
 * table or third-party module) and is exported so a future phase can surface
 * GM editing, exactly like WEATHER_STATES / CLIMATES.
 *
 * `target` is a stable key the combat layer keys off; `value` is an integer
 * step modifier (negative = penalty); `label` is an i18n key naming the
 * specific effect; `source` is the weather state type that produced it.
 */

import { getActiveWeather } from "./manual-weather.mjs";
import { getWeatherForTime, currentBiome } from "./weather.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";

/* Temperature (°C) at which extreme-heat Stamina exhaustion sets in — the
 * trigger for the heat Active Effect and the heat readout note. */
export const HEAT_EXHAUSTION_C = 40;

/* Per-tag modifier rules as a SERIALIZABLE table (so a GM can edit them — see
 * the Weather & Calendar config panel / the `weatherModifiersOverride` setting).
 *
 * Each tag maps to a list of records, in one of two shapes:
 *   { target, value, label, minLevel?, perLevel? }
 *     minLevel  — apply only when the tag's level (booleans → 1) is >= this
 *     value     — integer step modifier (negative = penalty)
 *     perLevel  — if true, the effective value is `value * level`
 *   { target, byLevel: { <tier>: value, … }, label }
 *     byLevel   — explicit value per intensity tier; the entry for the highest
 *                 defined tier <= the tag's level is used (one record → one
 *                 readout part, with a hard ceiling per tier)
 *
 * Values are GROUNDED in the Core rulebook's Environmental Effects page (p.165):
 * the sensory scale (−2 dim → −4 blind), melee −2, tracking ±3 in snow, footing
 * checks on snow/ice, and ranged penalties in poor conditions. Where the book has
 * no direct rule (fog, wind, rain) the value is extrapolated to that same scale.
 * Two book rules are NOT in this flat table because they aren't flat steps:
 *   - Light level (moonlight / darkness / glare) → getLightModifiers(), since it
 *     depends on the moon phase + daypart, not a weather tag.
 *   - Extreme heat → a proportional STA cut (×⅔, ×½ in medium/heavy armor),
 *     applied as an Active Effect once the temperature passes HEAT_EXHAUSTION_C;
 *     staminaHeatFactor() supplies the factor, and it is surfaced as a NOTE.
 *
 * Multiple tags on one state stack onto the same target — that stacking IS the
 * readout's whole point. ★ marks a direct book number; the rest extrapolate it. */
export const WEATHER_MODIFIER_RULES = Object.freeze({
    fog: [
        // Mist≈dim light, thick fog stays ABOVE melee-blind darkness (−3 ceiling).
        { target: "awareness", byLevel: { 1: -2, 2: -3, 3: -3 }, label: "WITCHER.Weather.Mod.FogSight" },
        { target: "ranged",    byLevel: { 2: -2, 3: -2 },        label: "WITCHER.Weather.Mod.FogRanged" },
        { target: "stealth",   byLevel: { 1:  1 },               label: "WITCHER.Weather.Mod.FogConceal" }
    ],
    wind: [
        { target: "ranged",   value: -1, perLevel: true, label: "WITCHER.Weather.Mod.Wind" },
        { target: "movement", byLevel: { 3: -1 },        label: "WITCHER.Weather.Mod.WindFooting" }
    ],
    precip: [
        { target: "ranged",     byLevel: { 2: -1, 3: -2 }, label: "WITCHER.Weather.Mod.RainRanged" },
        { target: "awareness",  byLevel: { 3: -2 },        label: "WITCHER.Weather.Mod.RainSight" },
        { target: "trackOld",   byLevel: { 2: -2, 3: -3 }, label: "WITCHER.Weather.Mod.RainTracks" },
        { target: "trackFresh", byLevel: { 2: -1, 3: -2 }, label: "WITCHER.Weather.Mod.RainFreshTracks" },
        { target: "movement",   byLevel: { 3: -1 },        label: "WITCHER.Weather.Mod.RainFooting" }
    ],
    snow: [
        // ★ p.165: +3 to follow FRESH tracks in snow, −3 to follow OLD ones.
        { target: "trackFresh", byLevel: { 1:  3 },        label: "WITCHER.Weather.Mod.SnowTrackFresh" },
        { target: "trackOld",   byLevel: { 1: -3 },        label: "WITCHER.Weather.Mod.SnowTrackOld" },
        // ★ p.165: fighting on snow/ice needs a footing check — flat-step stand-in.
        { target: "movement",   byLevel: { 2: -2, 3: -3 }, label: "WITCHER.Weather.Mod.SnowMove" },
        { target: "awareness",  byLevel: { 2: -1, 3: -2 }, label: "WITCHER.Weather.Mod.SnowSight" },
        { target: "ranged",     byLevel: { 3: -1 },        label: "WITCHER.Weather.Mod.SnowRanged" }
    ],
    storm: [
        { minLevel: 1, target: "awareness", value: -2, label: "WITCHER.Weather.Mod.StormSenses" }
    ],
    heat: [],  // proportional STA cut — see staminaHeatFactor() / getActiveWeatherNotes().
    hail: [
        { minLevel: 1, target: "ranged",    value: -1, label: "WITCHER.Weather.Mod.HailRanged" },
        { minLevel: 1, target: "awareness", value: -1, label: "WITCHER.Weather.Mod.HailSight" }
    ],
    dust: [
        { minLevel: 1, target: "awareness", value: -2, label: "WITCHER.Weather.Mod.DustSight" },
        { minLevel: 1, target: "ranged",    value: -1, label: "WITCHER.Weather.Mod.DustRanged" }
    ],
    lightning: [],  // dramatic, but the storm tag already carries the penalty.
    aurora: []      // purely atmospheric — no mechanical effect.
});

/* The live rules table: GM override (a non-empty `weatherModifiersOverride`
 * world setting) or the seed defaults above. Safe before settings register. */
export function getActiveModifierRules() {
    let override = null;
    try { override = game.settings.get(SYSTEM_ID, "weatherModifiersOverride"); }
    catch (_) { /* setting not registered yet */ }
    return (override && typeof override === "object" && Object.keys(override).length)
        ? override
        : WEATHER_MODIFIER_RULES;
}

/* Evaluate one tag's record list at a given level → modifier records. Supports
 * both the minLevel/value/perLevel shape and the byLevel tier-ceiling map. */
function evalTagRules(records, lvl) {
    const out = [];
    for (const r of records ?? []) {
        let value;
        if (r.byLevel) {
            let pick = null;
            for (const k of Object.keys(r.byLevel).map(Number).sort((a, b) => a - b)) {
                if (lvl >= k) pick = r.byLevel[k];
            }
            if (pick == null) continue;
            value = Number(pick) || 0;
        } else {
            if (lvl < (r.minLevel ?? 1)) continue;
            const base = Number(r.value) || 0;
            value = r.perLevel ? base * lvl : base;
        }
        out.push({ target: r.target, value, label: r.label });
    }
    return out;
}

/* Display order + i18n label key for each modifier target. Anything not listed
 * still works (falls back to the raw key) but sorts last. */
const TARGET_ORDER = ["awareness", "attack", "defense", "ranged", "trackFresh", "trackOld", "stealth", "movement"];
const TARGET_LABEL = {
    awareness:  "WITCHER.Weather.Target.Awareness",
    attack:     "WITCHER.Weather.Target.Attack",
    defense:    "WITCHER.Weather.Target.Defense",
    ranged:     "WITCHER.Weather.Target.Ranged",
    trackFresh: "WITCHER.Weather.Target.TrackFresh",
    trackOld:   "WITCHER.Weather.Target.TrackOld",
    tracking:   "WITCHER.Weather.Target.Tracking",
    stealth:    "WITCHER.Weather.Target.Stealth",
    movement:   "WITCHER.Weather.Target.Movement"
};

/** i18n key for a target group (raw key if unknown). */
export function weatherTargetLabel(target) {
    return TARGET_LABEL[target] ?? target;
}

/**
 * Flat list of modifier records for a weather object.
 * @param {{type?:string, tags?:object}} weather
 * @returns {Array<{target,value,label,source}>}
 */
export function getWeatherModifiers(weather) {
    const tags = weather?.tags ?? {};
    const rules = getActiveModifierRules();
    const out = [];
    for (const [tag, records] of Object.entries(rules)) {
        const raw = tags[tag];
        if (!raw) continue;
        const lvl = raw === true ? 1 : (Number(raw) || 0);
        for (const rec of evalTagRules(records, lvl)) out.push({ ...rec, source: weather?.type ?? "" });
    }
    return out;
}

/* ─────────── light level: moon phase + daypart (Core p.165) ──────────────────
 * The book's Light Level Table is a function of how much light is in the sky, not
 * of any weather tag — so it lives here rather than in WEATHER_MODIFIER_RULES.
 * Night light is set by the MOON PHASE (our 8-phase calendar moon) and whether
 * cloud/precip/fog hides it; daytime "glaring light" is the clear-sky desert sun
 * or sun off snow. Book numbers: Moonlight (dim) −2 Awareness; Darkness −4
 * Awareness and −2 Attack/Defense; Glaring −3 Awareness (and −3 Attack/Defense
 * facing the sun — surfaced as a note, since "facing" can't be auto-known). */

/* Heavy enough cloud/precip/fog to blot the moon out → night reads as Darkness. */
function moonOccluded(tags = {}) {
    return (Number(tags.cloud) || 0) >= 2
        || (Number(tags.precip) || 0) >= 2
        || (Number(tags.snow) || 0) >= 2
        || (Number(tags.fog) || 0) >= 2
        || !!tags.storm;
}

/* Clear enough for the sun to glare (daytime) — no cloud deck, precip or fog. */
function skyIsClear(tags = {}) {
    return (Number(tags.cloud) || 0) <= 1
        && !(Number(tags.precip) > 0)
        && !(Number(tags.snow) > 0)
        && !(Number(tags.fog) > 0)
        && !tags.storm;
}

/** Daypart index (0 dawn … 4 night) for a time — light is a function of time of
 *  day, independent of the manual/auto weather condition. */
function daypartIndexFor(worldTime) {
    try { return getWeatherForTime(worldTime).daypartIndex ?? 2; } catch (_) { return 2; }
}

/** Moon-phase index (0 = new … 4 = full) for a time, or null if unavailable. */
function moonPhaseIndex(worldTime) {
    try { return game.time?.calendar?.getMoonPhase?.(worldTime)?.index ?? null; }
    catch (_) { return null; }
}

/**
 * Light-level modifier records for a time: night moonlight/darkness by moon
 * phase, or daytime glare. Same record shape as getWeatherModifiers.
 * @returns {Array<{target,value,label,source}>}
 */
export function getLightModifiers(worldTime = game.time?.worldTime ?? 0) {
    const out = [];
    const src = "light";
    let weather = null;
    try { weather = getActiveWeather(worldTime); } catch (_) { /* not ready */ }
    const tags = weather?.tags ?? {};
    const dp = daypartIndexFor(worldTime);
    // `lightTier` classifies each line: "dim" = any visible-moon night (a witcher's
    // mutated eyes ignore this), "dark" = no usable moon (NOT ignored — needs Cat),
    // "glare" = daytime sun glare (never ignored). Crescent/quarter is folded into
    // "dim" per the book's binary dim/dark model.
    const push = (target, value, label, lightTier) =>
        out.push({ target, value, label, source: src, lightTier });

    if (dp === 4) {                                  // night
        const phase = moonPhaseIndex(worldTime);
        const occluded = moonOccluded(tags);              // moon hidden by cloud/precip/fog/storm
        const newMoon = phase === 0;
        if (newMoon || occluded) {
            // Same −4/−2 numbers either way, but name WHICH darkness it is.
            const sight = occluded ? "WITCHER.Weather.Mod.DarknessCloudSight"
                                   : "WITCHER.Weather.Mod.DarknessNewMoonSight";
            const fight = occluded ? "WITCHER.Weather.Mod.DarknessCloudFight"
                                   : "WITCHER.Weather.Mod.DarknessNewMoonFight";
            push("awareness", -4, sight, "dark");
            push("attack",    -2, fight, "dark");
            push("defense",   -2, fight, "dark");
        } else if (phase === 3 || phase === 4 || phase === 5) {   // gibbous / full
            push("awareness", -2, "WITCHER.Weather.Mod.Moonlight", "dim");
        } else {                                                  // quarter / crescent
            push("awareness", -3, "WITCHER.Weather.Mod.MoonPartial", "dim");
        }
    } else if (dp === 1 || dp === 2 || dp === 3) {    // daytime
        let biome = "temperate";
        try { biome = currentBiome(); } catch (_) { /* not ready */ }
        const desert = biome === "arid";
        const snowGlare = !!weather?.freezing;       // clear + below-freezing ⇒ snow/ice glare
        if (skyIsClear(tags) && (desert || snowGlare)) {
            push("awareness", -3, desert ? "WITCHER.Weather.Mod.GlareSun" : "WITCHER.Weather.Mod.GlareSnow", "glare");
        }
    }
    return out;
}

/**
 * Non-numeric / conditional notes for the active weather — rules that aren't flat
 * step modifiers: the proportional extreme-heat STA cut and the "facing the sun"
 * half of glare. i18n keys, for the readout to render as plain lines.
 * @returns {string[]}
 */
export function getActiveWeatherNotes(worldTime = game.time?.worldTime ?? 0) {
    const notes = [];
    let weather = null, biome = "temperate";
    try { weather = getActiveWeather(worldTime); } catch (_) { /* not ready */ }
    try { biome = currentBiome(); } catch (_) { /* not ready */ }
    const tags = weather?.tags ?? {};
    if (Number(weather?.temp) >= HEAT_EXHAUSTION_C) notes.push("WITCHER.Weather.Note.Heat");
    const dp = daypartIndexFor(worldTime);
    const daytime = dp === 1 || dp === 2 || dp === 3;
    if (daytime && skyIsClear(tags) && (biome === "arid" || weather?.freezing)) {
        notes.push("WITCHER.Weather.Note.GlareCombat");
    }
    return notes;
}

/**
 * Extreme-heat Stamina multiplier (Core p.165): once the temperature passes
 * HEAT_EXHAUSTION_C, STA drops by a third — halved instead in medium or heavy
 * armor. 1 below the threshold. The temperature, not the `heat` weather tag,
 * is the trigger (a clear 35 °C heatwave and a 42 °C desert noon differ).
 * @param {{temp?:number}} weather
 * @param {{armorType?:string}} [opts]
 */
export function staminaHeatFactor(weather, { armorType } = {}) {
    if (!(Number(weather?.temp) >= HEAT_EXHAUSTION_C)) return 1;
    return (armorType === "medium" || armorType === "heavy") ? 0.5 : (2 / 3);
}

/** Heat STA multiplier for the weather active right now, for the given armor. */
export function getActiveStaminaHeatFactor(armorType, worldTime = game.time?.worldTime ?? 0) {
    let weather = null;
    try { weather = getActiveWeather(worldTime); } catch (_) { return 1; }
    return staminaHeatFactor(weather, { armorType });
}

/** Modifiers for the weather active right now (live calendar + climate), plus
 *  the moon-phase / light-level records for the current time of day. */
export function getActiveWeatherModifiers(worldTime = game.time?.worldTime ?? 0) {
    return [
        ...getWeatherModifiers(getActiveWeather(worldTime)),
        ...getLightModifiers(worldTime)
    ];
}

/**
 * Group a flat modifier list by target for the stacked readout: net total per
 * target plus the contributing parts. Sorted by TARGET_ORDER.
 * @returns {Array<{target, targetLabel, total, parts:Array<{value,label}>}>}
 */
export function groupWeatherModifiers(mods) {
    const byTarget = new Map();
    for (const mod of mods ?? []) {
        if (!byTarget.has(mod.target)) byTarget.set(mod.target, { total: 0, parts: [] });
        const g = byTarget.get(mod.target);
        g.total += Number(mod.value) || 0;
        g.parts.push({ value: Number(mod.value) || 0, label: mod.label });
    }
    return [...byTarget.entries()]
        .map(([target, g]) => ({ target, targetLabel: weatherTargetLabel(target), ...g }))
        .sort((a, b) => {
            const ia = TARGET_ORDER.indexOf(a.target), ib = TARGET_ORDER.indexOf(b.target);
            return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        });
}

export const weatherModifierApi = Object.freeze({
    getWeatherModifiers,
    getActiveWeatherModifiers,
    getLightModifiers,
    getActiveWeatherNotes,
    staminaHeatFactor,
    getActiveStaminaHeatFactor,
    groupWeatherModifiers,
    weatherTargetLabel,
    getActiveModifierRules,
    rules: WEATHER_MODIFIER_RULES
});
