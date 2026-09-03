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
import { getWeatherForTime, composeWeatherLabel } from "./weather.mjs";
import { lightLevelAt, ambientLightLevel, lightTierRecords, lightTierWaivedFor,
         LIGHT_TIER_LABEL, LIGHT_TIER_ICON, LIGHT_TIER_PENALTY, getActiveLightPenalties, ambientLightMode } from "./light-level.mjs";
import { suppressWeatherVisuals, tokenInsideSuppressWeather } from "./scene-weather-mode.mjs";
import { hrProneCrawlQuarterSpd } from "./house-rules-config.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";

/* Temperature (°C) at which extreme-heat Stamina exhaustion sets in — the
 * trigger for the heat Active Effect and the heat readout note. */
export const HEAT_EXHAUSTION_C = 40;

/* Per-tag modifier rules as a SERIALIZABLE table (so a GM can edit them — see
 * the Weather & Calendar config panel / the `weatherModifiersOverride` setting).
 *
 * ONE shape — an explicit value per intensity tier:
 *   { target, byLevel: { 1: v, 2: v, 3: v }, label }
 *     byLevel   — the EXACT value at that intensity level (no carry-forward). A
 *                 missing/blank tier = no effect at that level (not "same as the
 *                 tier below" — that ambiguity is gone). So a rule that only bites
 *                 in heavier weather simply omits the light tiers, and one that
 *                 applies at all thicknesses lists the value three times.
 *
 * Values are GROUNDED in the Core rulebook's Environmental Effects page (p.165):
 * the sensory scale (−2 dim → −4 blind), melee −2, tracking ±3 in snow, footing
 * checks on snow/ice, and ranged penalties in poor conditions. Where the book has
 * no direct rule (fog, wind, rain) the value is extrapolated to that same scale.
 * Two book rules aren't in this table (not per-tier steps): light level (→
 * getLightModifiers) and the extreme-heat STA cut (→ staminaHeatFactor, a NOTE).
 *
 * Multiple tags on one state stack onto the same target — that stacking IS the
 * readout's whole point. ★ marks a direct book number; the rest extrapolate it. */
export const WEATHER_MODIFIER_RULES = Object.freeze({
    fog: [
        // Mist≈dim light, thick fog stays ABOVE melee-blind darkness (−3 ceiling).
        { target: "awareness", byLevel: { 1: -2, 2: -3, 3: -3 }, label: "WITCHER.Weather.Mod.FogSight" },
        { target: "ranged",    byLevel: {        2: -2, 3: -2 }, label: "WITCHER.Weather.Mod.FogRanged" },
        // Fog conceals equally at every thickness — a mechanical STEALTH bonus for
        // the hider (concealment), not just flavour.
        { target: "stealth", byLevel: { 1:  1, 2:  1, 3:  1 }, label: "WITCHER.Weather.Mod.FogConceal" }
    ],
    wind: [
        // Wind fights your aim harder the stronger it blows.
        { target: "ranged",   byLevel: { 1: -1, 2: -2, 3: -3 }, label: "WITCHER.Weather.Mod.Wind" },
        { target: "movement", byLevel: {               3: -1 }, label: "WITCHER.Weather.Mod.WindFooting" }
    ],
    precip: [
        { target: "ranged",     byLevel: {        2: -1, 3: -2 }, label: "WITCHER.Weather.Mod.RainRanged" },
        { target: "awareness",  byLevel: {               3: -2 }, label: "WITCHER.Weather.Mod.RainSight" },
        // Tracking = flavour only (no tracking roll consumes it): shown, not applied.
        { target: "narrative",  byLevel: {        2: -2, 3: -3 }, label: "WITCHER.Weather.Mod.RainTracks" },
        { target: "narrative",  byLevel: {        2: -1, 3: -2 }, label: "WITCHER.Weather.Mod.RainFreshTracks" },
        { target: "movement",   byLevel: {               3: -1 }, label: "WITCHER.Weather.Mod.RainFooting" }
    ],
    snow: [
        // ★ p.165: +3 to follow FRESH tracks in snow, −3 to follow OLD ones — snow lies
        // at any depth. Flavour only: no tracking roll consumes it (shown, not applied).
        { target: "narrative",  byLevel: { 1:  3, 2:  3, 3:  3 }, label: "WITCHER.Weather.Mod.SnowTrackFresh" },
        { target: "narrative",  byLevel: { 1: -3, 2: -3, 3: -3 }, label: "WITCHER.Weather.Mod.SnowTrackOld" },
        // ★ p.165: fighting on snow/ice needs a footing check — per-tier stand-in.
        { target: "movement",   byLevel: {        2: -2, 3: -3 }, label: "WITCHER.Weather.Mod.SnowMove" },
        { target: "awareness",  byLevel: {        2: -1, 3: -2 }, label: "WITCHER.Weather.Mod.SnowSight" },
        { target: "ranged",     byLevel: {               3: -1 }, label: "WITCHER.Weather.Mod.SnowRanged" }
    ],
    storm: [
        { target: "awareness", byLevel: { 1: -2, 2: -2, 3: -2 }, label: "WITCHER.Weather.Mod.StormSenses" }
    ],
    heat: [],  // proportional STA cut — see staminaHeatFactor() / getActiveWeatherNotes().
    hail: [
        { target: "ranged",    byLevel: { 1: -1, 2: -1, 3: -1 }, label: "WITCHER.Weather.Mod.HailRanged" },
        { target: "awareness", byLevel: { 1: -1, 2: -1, 3: -1 }, label: "WITCHER.Weather.Mod.HailSight" }
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

/* Evaluate one tag's record list at a given intensity level → modifier records.
 * The unified shape is byLevel with the EXACT value at that level (blank/0 = no
 * effect at that tier). A legacy flat minLevel/value/perLevel shape is still
 * honoured so a hand-edited old override doesn't break. */
function evalTagRules(records, lvl) {
    const out = [];
    for (const r of records ?? []) {
        let value = 0;
        if (r.byLevel) {
            value = Number(r.byLevel[lvl]) || 0;          // exact tier — no carry-forward
        } else {
            if (lvl < (r.minLevel ?? 1)) continue;         // legacy flat shape
            const base = Number(r.value) || 0;
            value = r.perLevel ? base * lvl : base;
        }
        if (!value) continue;                              // 0 / blank tier = no penalty (no ±0 rows)
        out.push({ target: r.target, value, label: r.label });
    }
    return out;
}

/* Display order + i18n label key for each modifier target. Anything not listed
 * still works (falls back to the raw key) but sorts last. */
const TARGET_ORDER = ["awareness", "attack", "defense", "ranged", "trackFresh", "trackOld", "stealth", "movement", "narrative"];
const TARGET_LABEL = {
    awareness:  "WITCHER.Weather.Target.Awareness",
    attack:     "WITCHER.Weather.Target.Attack",
    defense:    "WITCHER.Weather.Target.Defense",
    ranged:     "WITCHER.Weather.Target.Ranged",
    trackFresh: "WITCHER.Weather.Target.TrackFresh",
    trackOld:   "WITCHER.Weather.Target.TrackOld",
    tracking:   "WITCHER.Weather.Target.Tracking",
    stealth:    "WITCHER.Weather.Target.Stealth",
    movement:   "WITCHER.Weather.Target.Movement",
    // Purely narrative — shown in the weather readout as GM/player colour, but NO
    // roll consumes it (like trackFresh/trackOld: the engine applies only awareness
    // / ranged / attack / defense / movement). Flavour, not dice.
    narrative:  "WITCHER.Weather.Target.Narrative"
};

/* Targets that are flavour only — surfaced in the readout, never applied to a roll.
 * (The mechanical targets are opt-in per roll site; these are here so the readout
 * and editor can flag them as non-mechanical.) */
export const NARRATIVE_TARGETS = Object.freeze(["narrative", "trackFresh", "trackOld", "tracking"]);
export function isNarrativeTarget(target) { return NARRATIVE_TARGETS.includes(target); }

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

/* ─────────── light level (Core p.165) — now PER-TOKEN & POSITIONAL ────────────
 * The book's Light Level Table used to be derived here from moon phase + daypart
 * (a scene-global guess). It is now sampled from the ACTUAL Foundry lighting at a
 * token's tile by mechanics/light-level.mjs — a torch's bright ring, an unlit
 * corner, the Pitch Black weather category, all read straight off the canvas.
 * This layer just maps that tier to the book's records and drops the ones the
 * token's own vision (race Dim Light / Dark Vision) waives. The moon now only
 * gates the Pitch Black category (isPitchBlack, above); it no longer produces
 * its own Moonlight/Darkness lines. Snow glare is replaced by the weather-track
 * Snow Blindness rule below. */

/* Heavy enough cloud/precip/fog to blot the moon out → drives the Pitch Black
 * category (isPitchBlack). Kept here as that category's occlusion test. */
function moonOccluded(tags = {}) {
    return (Number(tags.cloud) || 0) >= 2
        || (Number(tags.precip) || 0) >= 2
        || (Number(tags.snow) || 0) >= 2
        || (Number(tags.fog) || 0) >= 2
        || !!tags.storm;
}

/** Daypart index (0 dawn … 4 night) for a time. */
function daypartIndexFor(worldTime) {
    try { return getWeatherForTime(worldTime).daypartIndex ?? 2; } catch (_) { return 2; }
}

/** Fractional hour-of-day for a world time, or null with no calendar. */
function hourOfDay(worldTime = game.time?.worldTime ?? 0) {
    const cal = game.time?.calendar;
    if (!cal?.timeToComponents) return null;
    const c = cal.timeToComponents(worldTime);
    const h = Number(c?.hour);
    if (!Number.isFinite(h)) return null;
    return h + (Number(c?.minute) || 0) / 60;
}

/* The token whose tile/vision a light or exposure query is about. An explicit
 * token (a roller, or a stealth subject) always wins; otherwise fall back to the
 * client's controlled token, then the assigned character's token, so the readout
 * still reflects "the token I'm looking through". Null when none resolves. */
function resolveSubjectToken(token) {
    if (token) return token;                           // Token or TokenDocument
    const controlled = canvas?.tokens?.controlled ?? [];
    if (controlled.length) return controlled[0];
    return game.user?.character?.getActiveTokens?.()?.[0] ?? null;
}

/**
 * The "Pitch Black" weather category: a night whose sky is occluded enough to
 * blot out all sky light (heavy cloud / precip / snow / fog / storm — the same
 * `moonOccluded` test that hides the moon for the light readout). This is the
 * condition scene-fx uses to DISABLE global illumination (holding darkness at 1),
 * which is what tells Pitch Black apart from plain Darkness: a clear night keeps
 * a faint ambient (starlight / moon) and stays lit (Darkness, −4), but an
 * occluded night goes truly dark — only Dark Vision or a local light sees.
 *
 * Occlusion alone gates it (clouds hide the moon regardless of its phase); the
 * moon phase only distinguishes Dim (moonlit) vs Darkness on a CLEAR night, which
 * is the light-tier layer's job, not this category's.
 * @param {number} [worldTime]
 * @returns {boolean}
 */
export function isPitchBlack(worldTime = game.time?.worldTime ?? 0) {
    if (daypartIndexFor(worldTime) !== 4) return false;   // night only
    let weather = null;
    try { weather = getActiveWeather(worldTime); } catch (_) { return false; }
    return moonOccluded(weather?.tags ?? {});
}

/**
 * Effective moonlight right now, in [0,1]: 0 when the sky is occluded (clouds
 * hide the moon — the same `moonOccluded` test), otherwise the moon's
 * illuminated fraction (0 = new → 1 = full), smooth across the intervening
 * phases from the calendar's continuous `dayInCycle / cycleLength`. scene-fx uses
 * it to LIFT a clear night's darkness — a full moon reads as Dim, a new moon
 * (or any occluded night) stays Darkness.
 * @param {number} [worldTime]
 * @returns {number}
 */
export function moonBrightness(worldTime = game.time?.worldTime ?? 0) {
    let weather = null;
    try { weather = getActiveWeather(worldTime); } catch (_) { /* not ready */ }
    if (moonOccluded(weather?.tags ?? {})) return 0;
    const mp = game.time?.calendar?.getMoonPhase?.(worldTime);
    const cl = Number(mp?.cycleLength);
    if (!(cl > 0)) return 0;
    const f = ((((Number(mp.dayInCycle) || 0) % cl) + cl) % cl) / cl;   // 0 new → 0.5 full → 1 new
    return (1 - Math.cos(2 * Math.PI * f)) / 2;
}

/* Temperatures / hours bounding Snow Blindness (below). */
export const SNOW_BLINDNESS_START_HOUR = 11;
export const SNOW_BLINDNESS_END_HOUR   = 16;

/**
 * Light-level modifier records for a token, sampled from the ACTUAL lighting at
 * its tile (mechanics/light-level.mjs), with the tier's penalties dropped when
 * the token's own vision waives them (Dim Light Vision → Dim; Dark Vision →
 * Darkness/Pitch). No token → the client's viewer token (controlled / assigned),
 * so the readout still shows something. Empty in Bright/Daylight, when a vision
 * toggle cancels the tier, or when the tier can't be sampled (no canvas).
 * @param {Token|TokenDocument|null} [token]
 * @returns {Array<{target,value,label,source,lightTier}>}
 */
export function getLightModifiers(token = null) {
    const subject = resolveSubjectToken(token);
    let tier = null, actor = null;
    if (subject) {
        try { tier = lightLevelAt(subject); } catch (_) { return []; }
        actor = subject.actor;
    } else {
        // No token to sample (e.g. the GM weather panel with nothing selected) —
        // fall back to the scene-AMBIENT tier so the readout still shows the light.
        try { tier = ambientLightLevel(); } catch (_) { return []; }
    }
    if (!tier) return [];
    if (actor && lightTierWaivedFor(tier, actor)) return [];   // the viewer's vision cancels this tier
    return lightTierRecords(tier);
}

/**
 * Snow Blindness — a WEATHER-track −3 Awareness penalty (exposure-gated like the
 * other weather mods, NOT a light tier). Fires only when the day is bright and
 * the ground is snow-covered enough to glare: over light snow (snow ≥ 2), in the
 * 11:00–16:00 window, on an outdoor scene, and only if the subject's own token
 * is NOT sheltered inside an ignore-weather (suppress-weather) region. Awareness
 * only — the book's Attack/Defense half needs "facing the sun", which can't be
 * auto-known, so it is dropped.
 * @param {number} [worldTime]
 * @param {Token|TokenDocument|null} [token]
 * @returns {Array<{target,value,label,source}>}
 */
export function getSnowBlindnessModifiers(worldTime = game.time?.worldTime ?? 0, token = null) {
    let weather = null;
    try { weather = getActiveWeather(worldTime); } catch (_) { return []; }
    if ((Number(weather?.tags?.snow) || 0) < 2) return [];                 // over light snow only
    // Glare needs sun ON the snow — a sunny/clear sky. Cloudy or overcast skies
    // scatter the light and there's no blinding glare (matches the "sunny"
    // predicate in weather-pins: clear flag, or cloud tier 0).
    if (!(weather?.tags?.clear || (Number(weather?.tags?.cloud) || 0) === 0)) return [];
    const hour = hourOfDay(worldTime);
    if (hour == null || hour < SNOW_BLINDNESS_START_HOUR || hour >= SNOW_BLINDNESS_END_HOUR) return [];
    try { if (suppressWeatherVisuals()) return []; } catch (_) { /* no scene → treat as open air */ }
    const subject = resolveSubjectToken(token);
    const tokenDoc = subject?.document ?? subject ?? null;
    try { if (tokenDoc && tokenInsideSuppressWeather(tokenDoc)) return []; } catch (_) { /* ignore */ }
    return [{ target: "awareness", value: -3, label: "WITCHER.Weather.Mod.SnowBlindness", source: "snowBlindness" }];
}

/**
 * Non-numeric / conditional notes for the active weather — rules that aren't flat
 * step modifiers: currently just the proportional extreme-heat STA cut. (The old
 * "facing the sun" glare note is gone — sun-off-snow is now the Snow Blindness
 * modifier, a real −3 Awareness rather than an advisory line.) i18n keys.
 * @returns {string[]}
 */
export function getActiveWeatherNotes(worldTime = game.time?.worldTime ?? 0) {
    const notes = [];
    let weather = null;
    try { weather = getActiveWeather(worldTime); } catch (_) { /* not ready */ }
    if (Number(weather?.temp) >= HEAT_EXHAUSTION_C) notes.push("WITCHER.Weather.Note.Heat");
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
 *  the positional light-level records and Snow Blindness for `token` (the roller
 *  / stealth subject; falls back to the client's viewer token for the readout). */
export function getActiveWeatherModifiers(worldTime = game.time?.worldTime ?? 0, token = null) {
    return [
        ...getWeatherModifiers(getActiveWeather(worldTime)),
        ...getLightModifiers(token),
        ...getSnowBlindnessModifiers(worldTime, token)
    ];
}

/**
 * The environmental (weather + light) modifier records that apply to a given
 * roll `target` for a specific ACTOR — the single source both the skill roll and
 * the dock readout use, so they can't disagree and the penalties stack naturally
 * (Dim Light −2 + blizzard −2 = −4). Sampled from the actor's own token (light
 * tier + snow blindness are positional); plain weather penalties (fog/rain/storm)
 * are dropped when the actor is SHELTERED — an indoor/weather-off scene, or the
 * token inside a suppress-weather region. Light + snow-blindness self-gate, so
 * they always apply. Returns [{label,value}] with `label` an i18n key.
 * @param {Actor} actor
 * @param {string} target   A weather-modifier target ("awareness", "stealth", …).
 * @returns {Array<{label:string, value:number}>}
 */
/**
 * The current light level for a display INDICATOR (weather menu / token badge).
 * Uses the viewer's own token tile when one resolves (controlled / assigned),
 * else the scene ambient. Returns display-ready fields, or null pre-canvas.
 * @param {Token|TokenDocument|null} [token]
 * @returns {{tier:string, label:string, icon:string, awareness:number, waived:boolean}|null}
 */
export function getActiveLightInfo() {
    // The OUTSIDE (scene-ambient) light — the weather widget describes the light
    // "out here", NOT any one token's tile. A token's own local light (torches,
    // its emission) is shown on the token badge, not here.
    let tier = null;
    try { tier = ambientLightLevel(); } catch (_) { /* not ready */ }
    if (!tier) return null;
    let mode = null;
    try { mode = ambientLightMode(); } catch (_) { /* not ready */ }
    return {
        tier,
        label:     LIGHT_TIER_LABEL[tier] ?? "",
        icon:      LIGHT_TIER_ICON[tier] ?? "fa-circle",
        awareness: Number(getActiveLightPenalties()[tier]?.awareness) || 0,
        waived:    false,
        mode
    };
}

/**
 * Display bundle for the "current weather + its penalties" readout: the composed
 * weather NAME + icon + temperature, and a FLAT list of every active weather
 * penalty (fog/rain/snow/storm/wind + snow blindness) as {value, targetLabel,
 * label}. Light-tier penalties are EXCLUDED — they belong to the separate Light
 * Level indicator. `token` scopes the positional/exposure gating to a viewer.
 * @param {Token|TokenDocument|null} [token]
 * @returns {{label:string, icon:string, temp:number|null, penalties:Array}|null}
 */
export function getActiveWeatherDisplay(token = null) {
    let w = null;
    try { w = getActiveWeather(); } catch (_) { return null; }
    if (!w) return null;
    // Shelter: an indoor/off scene, or the viewer's token inside a suppress-weather
    // region, negates the weather penalties (they simply don't apply there).
    const subject = resolveSubjectToken(token);
    const tokenDoc = subject?.document ?? subject ?? null;
    let sheltered = false;
    try { sheltered = suppressWeatherVisuals() || (!!tokenDoc && tokenInsideSuppressWeather(tokenDoc)); }
    catch (_) { /* no scene/canvas — open air */ }
    const loc = (k) => (game?.i18n?.localize ? game.i18n.localize(k) : k);
    const penalties = (getActiveWeatherModifiers(undefined, subject) ?? [])
        .filter(m => m.source !== "light")            // light lives in the Light Level indicator
        .filter(m => !sheltered)                        // sheltered → weather penalties negated
        .map(m => ({
            value: Number(m.value) || 0,
            targetLabel: weatherTargetLabel(m.target),  // i18n key
            label: m.label,                             // i18n key
            narrative: isNarrativeTarget(m.target)      // flavour only — not applied to any roll
        }))
        .filter(m => m.value);
    return {
        label: composeWeatherLabel(w, loc),
        icon:  w.icon ?? "fa-cloud",
        temp:  (w.temp != null && Number.isFinite(Number(w.temp))) ? Number(w.temp) : null,
        penalties
    };
}

export function getEnvironmentalModifiersForActor(actor, target) {
    if (!target) return [];
    const token = actor?.getActiveTokens?.()?.[0] ?? null;
    const tokenDoc = token?.document ?? token ?? null;
    let sheltered = false;
    try { sheltered = suppressWeatherVisuals() || (!!tokenDoc && tokenInsideSuppressWeather(tokenDoc)); }
    catch (_) { /* no scene/canvas — treat as open air */ }
    let mods = [];
    try { mods = getActiveWeatherModifiers(undefined, token) ?? []; } catch (_) { return []; }
    return mods
        .filter(m => m.target === target)
        .filter(m => m.source === "light" || m.source === "snowBlindness" || !sheltered)
        .map(m => ({ label: m.label, value: Number(m.value) || 0, source: m.source }))
        .filter(m => m.value);
}

/** The live weather FOOTING penalty (≥ 0) against combat movement for an actor —
 *  the `movement` target (wind/rain/snow footing), shelter-gated (Indoors /
 *  suppress-weather region negate it). 0 when none applies. */
export function weatherMovementPenalty(actor) {
    try {
        return -getEnvironmentalModifiersForActor(actor, "movement")
            .reduce((s, m) => s + (Number(m.value) || 0), 0);
    } catch (_) { return 0; }
}

/** The combat movement cap after weather footing. The penalty bites the NORMAL
 *  per-action speed (floored at 1 so it can't hit 0), and Run is 3× that ALREADY-
 *  penalised speed — so footing that costs you 2m of walking costs 6m of running.
 *  `bonus` (Lightning-Fast rolled metres) rides on top, untripled. Shared by the
 *  action-economy budget (combatRoundMixin), the canvas-drag cap
 *  (policy/canvas-movement) and the readouts, so they never disagree.
 *  @param {number} spd     the actor's SPD (normal per-action move)
 *  @param {number} runMul  1 walking, 3 running
 *  @param {number} bonus   flat metres added after the multiplier (Lightning Fast)
 *  @param {Actor}  actor */
export function weatherAdjustedMoveCap(spd, runMul = 1, bonus = 0, actor) {
    const base = Math.max(0, Number(spd) || 0);
    const pen = weatherMovementPenalty(actor);
    const penalised = pen > 0 ? Math.max(Math.min(base, 1), base - pen) : base;
    /* Prone crawl (house rule, off by default). A normal move caps at ⌊SPD/5⌋;
     * a full-turn RUN derives from that (×3 → 3·⌊SPD/5⌋). Floored to a MINIMUM
     * of 1 so even the slowest crawler covers at least one step (≥2m/turn on a
     * 2m grid). Running is fully available AND gains ground (run cap > walk cap,
     * so the upgrade-to-Run prompt still fires). Weather-adjusted; no flat
     * movement bonus while crawling. RAW leaves prone unrestricted, so this only
     * bites with the house rule on. */
    if (actor?.statuses?.has?.("prone") && hrProneCrawlQuarterSpd()) {
        return Math.max(1, Math.floor(penalised / 5) * (Number(runMul) || 1));
    }
    return penalised * (Number(runMul) || 1) + (Number(bonus) || 0);
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
    getSnowBlindnessModifiers,
    getActiveWeatherNotes,
    staminaHeatFactor,
    getActiveStaminaHeatFactor,
    groupWeatherModifiers,
    weatherTargetLabel,
    getActiveModifierRules,
    isPitchBlack,
    moonBrightness,
    getActiveLightInfo,
    getActiveWeatherDisplay,
    getEnvironmentalModifiersForActor,
    rules: WEATHER_MODIFIER_RULES
});
