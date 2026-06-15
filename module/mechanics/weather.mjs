/**
 * Inbuilt weather engine — deterministic, persistence-free, original to this
 * system.
 *
 * Design: weather is a PURE FUNCTION of (absolute calendar day, place). For each
 * day we evaluate layered value-noise fields — cold, wet, wind, cloud — that
 * vary smoothly from day to day (so weather fronts persist for a few days
 * rather than flickering) yet are computable directly for ANY day, past or
 * future, with no stored state. Given a place {u,v,terrain,biome} the fields are
 * sampled from 2D noise advected west→east (fronts sweep the map) with a
 * latitude gradient and terrain biases; with no place they reduce EXACTLY to the
 * original day-only field (the global, single-region behaviour). Season and biome
 * ("climate") shift those fields and the temperature. The continuous axes are
 * then thresholded into a discrete weather state. Snow-vs-rain falls straight out
 * of the temperature, so there is no separate freezing-variant swap.
 *
 * Each state carries `tags` (fog / wind / precip / snow / storm / heat /
 * aurora) so the Phase 3 modifier layer and Phase 4 scene-FX layer can consume
 * one weather object without re-deriving anything.
 *
 * Tables (WEATHER_STATES, CLIMATES, SEASONS) are exported so a later phase can
 * expose GM editing.
 */

import { seasonMidpoints } from "../setup/calendar.mjs";
import { resolveActivePlace } from "./weather-map.mjs";

const FREEZING_C = 0;

/* How strongly the season tilts the daily temperature SWING (diurnal range),
 * on top of the cloud-cover factor. Real diurnal range is wider in summer (long
 * days, strong high-angle sun, drier/clearer air) and narrower in winter (short
 * days, weak low-angle sun, frequent cloud/snow). A day at the warmest season
 * swings ×(1+TILT); the coldest ×(1−TILT); spring/autumn ≈ ×1. */
const DIURNAL_SEASON_TILT = 0.3;

/* Spatial weather (place-aware generation). Weather is a pure function of
 * (absDay, place); these tune the spatial dimension:
 *   - SWEEP_DAYS: days a front takes to cross the map W→E. East longitudes
 *     sample the noise later in time (advection), so the same system arrives in
 *     the east ~SWEEP_DAYS after the west and visibly evolves en route.
 *   - LAT_SCALE: N–S noise scale across the map height (≈1.5–2 weather bands).
 *   - LAT_SPAN: °C edge-to-edge latitude spread (±LAT_SPAN/2 about map centre);
 *     north (v=0) colder, south (v=1) warmer.
 *   - SWING_MULT_FLOOR: floor on the COMPOUNDED biome×terrain diurnal swing, so
 *     a damp maritime coast over a low-swing biome can't collapse into a flat,
 *     permanently-overcast climate. (Applied only when a place is present.) */
const SWEEP_DAYS = 3;
const LAT_SCALE = 3.5;
const LAT_SPAN = 12;
const SWING_MULT_FLOOR = 0.3;

/* Blocking high ("heat dome"). The four climate axes are independent noise, so
 * left alone a hot day is as likely to be cloudy as clear and the dramatic
 * `heatwave` state almost never fires — summer just never coheres into a hot,
 * clear, dry SPELL. Physically a hot daily air mass IS a subsiding high: it
 * clears, dries and stills. So we let the day's own `dayHigh` pull the wet/wind/
 * cloud axes down, ramped in over [HEAT_DOME_LO, HEAT_DOME_HI] °C, engaging only
 * on genuinely hot days. This is what turns the hot tail of summer into clear,
 * dry heatwave spells. `dayHigh` itself is never touched (the heat is already in
 * the air mass — adding more would double-count); only the three "sky" axes move,
 * which is exactly what lets pickState reach its clear / heatwave branch. Winter
 * dayHighs sit far below HEAT_DOME_LO, so winter is untouched. */
const HEAT_DOME_LO = 23;
const HEAT_DOME_HI = 31;
const HEAT_DOME_CLOUD_CUT = 0.55;
const HEAT_DOME_WET_CUT = 0.40;
const HEAT_DOME_WIND_CUT = 0.40;

/* Weather states. `t` is the °C offset applied on top of the day's base temp.
 * `label` is an i18n key (WITCHER.Weather.*). `tags` feed downstream layers. */
export const WEATHER_STATES = {
    clear:        { label: "WITCHER.Weather.Clear",     icon: "fas fa-sun",                 t:  6, tags: { clear: true } },
    fair:         { label: "WITCHER.Weather.Fair",      icon: "fas fa-cloud-sun",           t:  3, tags: { cloud: 1 } },
    overcast:     { label: "WITCHER.Weather.Overcast",  icon: "fas fa-cloud",               t:  0, tags: { cloud: 2 } },
    fog:          { label: "WITCHER.Weather.Fog",       icon: "fas fa-smog",                t: -2, tags: { fog: true } },
    drizzle:      { label: "WITCHER.Weather.Drizzle",   icon: "fas fa-cloud-rain",          t: -2, tags: { precip: 1 } },
    rain:         { label: "WITCHER.Weather.Rain",      icon: "fas fa-cloud-showers-heavy", t: -5, tags: { precip: 2 } },
    downpour:     { label: "WITCHER.Weather.Downpour",  icon: "fas fa-cloud-showers-water", t: -6, tags: { precip: 3 } },
    thunderstorm: { label: "WITCHER.Weather.Storm",     icon: "fas fa-cloud-bolt",          t: -5, tags: { precip: 3, wind: 1, storm: true } },
    windy:        { label: "WITCHER.Weather.Windy",     icon: "fas fa-wind",                t: -3, tags: { wind: 2 } },
    gale:         { label: "WITCHER.Weather.Gale",      icon: "fas fa-wind",                t: -5, tags: { wind: 3 } },
    sleet:        { label: "WITCHER.Weather.Sleet",     icon: "fas fa-cloud-hail",          t: -3, tags: { precip: 1, hail: true } },
    flurries:     { label: "WITCHER.Weather.Flurries",  icon: "fas fa-snowflake",           t: -3, tags: { snow: 1 } },
    snow:         { label: "WITCHER.Weather.Snow",      icon: "fas fa-snowflake",           t: -7, tags: { snow: 2 } },
    heavySnow:    { label: "WITCHER.Weather.HeavySnow", icon: "fas fa-snowflake",           t: -8, tags: { snow: 3 } },
    blizzard:     { label: "WITCHER.Weather.Blizzard",  icon: "fas fa-snow-blowing",        t: -9, tags: { snow: 3, wind: 3, storm: true } },
    heatwave:     { label: "WITCHER.Weather.Heatwave",  icon: "fas fa-sun-haze",            t:  6, tags: { heat: true } },
    aurora:       { label: "WITCHER.Weather.Aurora",    icon: "fas fa-meteor",              t: -4, tags: { aurora: true } }
};

/* Climates ("biomes"). Continent-flavoured defaults; GM-selectable. Temperature
 * is built from TWO orthogonal axes (see generateWeather):
 *   - WARMTH (latitude): the world-level `regionBaseline` °C offset, NOT stored
 *     here, lets a GM slide the whole world warmer/colder for their campaign's
 *     latitude (Kovir's far north ↔ Ofir's savanna south). Default 0 = the
 *     Northern Kingdoms (Poland-analogue) heartland these biomes are tuned for.
 *   - CONTINENTALITY: `seasonMult` scales the seasonal swing — maritime climates
 *     (<1) have mild winters / cool summers, continental interiors (≈1) the full
 *     range. This is the fix for "a coast at the same latitude is milder, not
 *     colder, than inland".
 * `tempBase` is the biome's local mean °C at the default latitude; `tempSwing`
 * scales the day-to-day cold-axis noise; the *Bias fields nudge the three
 * climate axes; `dailySwing` scales the morning/evening diurnal spread.
 *
 * Grounded in Köppen climate data:
 *   - temperate: humid-continental baseline (Dfb) — neutral anchor, biases 0,
 *     seasonMult 1.0. Mean ≈11°C, full continental annual + diurnal range.
 *   - highland:  alpine (ET/Dfc) — cold mean, wide annual range, large thin-air
 *     diurnal swing; orographic cloud/wet/wind. (Blue Mts / Mahakam / Dragon Mts.)
 *   - coastal:   oceanic/maritime (Cfb) — seasonMult ≈0.55 (annual range ≈HALF
 *     continental), SMALLEST diurnal swing (warm nights), persistent cloud/fog,
 *     strong wind. (Great Sea / Skellige seaboard.)
 *   - arid:      semi-arid steppe/desert (BSk/BSh) — a DRYNESS character, not a
 *     hot latitude: big annual range, the LARGEST diurnal swing (20°C+), dry and
 *     near-cloudless. `tempBase` is latitude-neutral (a cool steppe at default
 *     region); set a southern `regionBaseline` (Korath/Ofir) for a hot desert,
 *     so the heat isn't double-counted. */
export const CLIMATES = {
    temperate: { tempBase: 11, tempSwing:  7, wetBias:  0.00, windBias:  0.00, cloudBias:  0.00, dailySwing: 1.0, seasonMult: 1.0 },
    highland:  { tempBase:  2, tempSwing: 10, wetBias:  0.08, windBias:  0.12, cloudBias:  0.08, dailySwing: 1.4, seasonMult: 1.1 },
    coastal:   { tempBase: 10, tempSwing:  4, wetBias:  0.15, windBias:  0.20, cloudBias:  0.12, dailySwing: 0.6, seasonMult: 0.55 },
    arid:      { tempBase: 14, tempSwing: 12, wetBias: -0.25, windBias:  0.05, cloudBias: -0.20, dailySwing: 1.8, seasonMult: 1.15 }
};

/* Per-season shifts, keyed by the calendar's season name. `temp` °C; the bias
 * fields nudge the climate axes; `aurora` permits clear-night auroras. The
 * winter/summer spread is widened to ±13 so a continental year reaches the
 * >30°C annual range the climate data shows once `tempSwing` noise is added. */
export const SEASONS = {
    Winter: { temp: -13, wetBias: 0.05, windBias: 0.05, cloudBias: 0.10, aurora: true },
    Spring: { temp:   0, wetBias: 0.10, windBias: 0.05, cloudBias: 0.05, aurora: false },
    Summer: { temp:  13, wetBias: -0.05, windBias: -0.02, cloudBias: -0.05, aurora: false },
    Autumn: { temp:   3, wetBias: 0.08, windBias: 0.08, cloudBias: 0.08, aurora: false }
};

/* Dayparts — the day's single "air mass" (the per-day cold/wet/wind/cloud
 * fields) is modulated through five slots so weather EVOLVES across the day
 * rather than holding one state midnight-to-midnight. The biases are grounded
 * in real diurnal meteorology:
 *   - dawn: coldest hour; calm + damp air near saturation ⇒ radiation FOG. We
 *     drop wind hard and nudge cloud, but DON'T raise wet much (fog lives in the
 *     0.32–0.45 wet band; pushing higher would make rain, not mist).
 *   - morning: fog burns off after sunrise — wet/cloud ease, a little wind picks up.
 *   - afternoon: warmest; solar heating drives CONVECTION ⇒ thunderstorms when
 *     the air is warm and has moisture. `diurnal` 0 = this is the day's high
 *     (matches the old single-state "noon"), so validated temps are preserved.
 *   - evening: settling — wet and wind ease as heating fades.
 *   - night: cold, calm, clearing skies ⇒ best aurora window.
 * `diurnal` is the slot's position on the daily temperature curve (0 = daytime
 * high, negative = cooler); it scales the diurnal amplitude. `salt` makes each
 * slot's small jitter deterministic yet distinct. */
export const DAYPARTS = Object.freeze([
    { key: "dawn",      diurnal: -1.00, wetBias:  0.05, windBias: -0.16, cloudBias:  0.03, salt: 0xA1, fog: true },
    { key: "morning",   diurnal: -0.45, wetBias: -0.08, windBias:  0.02, cloudBias: -0.06, salt: 0xB2 },
    { key: "afternoon", diurnal:  0.00, wetBias:  0.00, windBias:  0.08, cloudBias:  0.00, salt: 0xC3, convective: true },
    { key: "evening",   diurnal: -0.35, wetBias: -0.04, windBias: -0.06, cloudBias: -0.02, salt: 0xD4 },
    { key: "night",     diurnal: -0.85, wetBias: -0.02, windBias: -0.14, cloudBias: -0.05, salt: 0xE5, aurora: true }
]);

/* ─────────── deterministic noise ─────────────────────────────────────────── */

function hash01(n, salt) {
    let h = Math.imul((((n | 0) ^ (salt | 0)) >>> 0), 0x27d4eb2d);
    h ^= h >>> 15; h = Math.imul(h >>> 0, 0x85ebca6b); h ^= h >>> 13;
    return (h >>> 0) / 4294967296;
}

/** Smooth (smoothstep-interpolated) value noise; `period` days per cycle. */
function noise1(day, period, salt) {
    const t = day / period;
    const i0 = Math.floor(t);
    const f = t - i0;
    const a = hash01(i0, salt);
    const b = hash01(i0 + 1, salt);
    const s = f * f * (3 - 2 * f);
    return a + (b - a) * s;
}

/** Fractal sum → smooth field in roughly [0,1) with both slow and fast wobble. */
function fbm(day, salt) {
    return 0.6 * noise1(day, 7, salt)
        + 0.3 * noise1(day, 3, salt + 101)
        + 0.1 * noise1(day, 1.6, salt + 211);
}

/** 2D smooth value noise; bilinear smoothstep on the integer lattice. Reduces
 *  EXACTLY to noise1 at y=0 (the lattice's y=0 corners hash identically to the
 *  1D points), so the spatial path degenerates to the day-only path on the map's
 *  north–south centre line. */
function noise2(x, y, period, salt) {
    const tx = x / period, ty = y / period;
    const ix = Math.floor(tx), iy = Math.floor(ty);
    const fx = tx - ix, fy = ty - iy;
    const corner = (gx, gy) => hash01(gx + Math.imul(0x9e3779b1, gy), salt);
    const a = corner(ix, iy), b = corner(ix + 1, iy);
    const c = corner(ix, iy + 1), d = corner(ix + 1, iy + 1);
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const top = a + (b - a) * sx, bot = c + (d - c) * sx;
    return top + (bot - top) * sy;
}

/** 2D fractal sum — the spatial twin of `fbm`. Same octaves/periods/salt offsets,
 *  so `fbm2(x, 0, salt) === fbm(x, salt)` exactly (the spatial regression guard). */
function fbm2(x, y, salt) {
    return 0.6 * noise2(x, y, 7, salt)
        + 0.3 * noise2(x, y, 3, salt + 101)
        + 0.1 * noise2(x, y, 1.6, salt + 211);
}

const SALT_COLD = 0x10f3;
const SALT_WET = 0x2a5b;
const SALT_WIND = 0x3c71;
const SALT_CLOUD = 0x4d97;
const SALT_AURORA = 0x5e2d;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const round = (n) => Math.round(n);

/* ─────────── public engine ───────────────────────────────────────────────── */

/**
 * The day's synoptic "air mass": the per-day cold/wet/wind/cloud noise fields
 * and the daily-mean temperature, before any daypart modulation. Pure function
 * of the absolute day, season and climate.
 */
function dayAirMass(absDay, s, climate, place = null) {
    // WET/WIND baselines pull the noise mean (~0.5) down so mild days dominate
    // and rain/gales sit in the upper tail — a temperate year is mostly fair.
    // A per-day/per-month reroll seed (0 when none) reshuffles the noise lattice.
    const mix = weatherSeedMix(absDay);
    const t = place?.terrain ?? null;
    const tWet = t?.wetBias ?? 0, tWind = t?.windBias ?? 0, tCloud = t?.cloudBias ?? 0;

    // Spatial path: sample the 2D noise advected W→E — east longitudes lag west
    // by up to SWEEP_DAYS, so a feature reaches the east later and fronts sweep
    // across the map — with a N–S coordinate for seamless latitude continuity.
    // Terrain biases nudge the wet/wind/cloud axes. The reroll `mix` threads
    // through exactly as the 1D path, so seeded rerolls still move painted cells.
    // No place → the original 1D day-only field, byte-for-byte (regression guard).
    let cold, wet, wind, cloud;
    if (place) {
        const u = clamp01(place.u ?? 0.5), v = clamp01(place.v ?? 0.5);
        const x = absDay - u * getFrontSweepDays();
        const y = v * LAT_SCALE;
        cold = clamp01(fbm2(x, y, SALT_COLD ^ mix));
        wet = clamp01(fbm2(x, y, SALT_WET ^ mix) + s.wetBias + climate.wetBias + tWet - 0.15);
        wind = clamp01(fbm2(x, y, SALT_WIND ^ mix) + s.windBias + climate.windBias + tWind - 0.10);
        cloud = clamp01(fbm2(x, y, SALT_CLOUD ^ mix) + s.cloudBias + climate.cloudBias + tCloud + wet * 0.35);
    } else {
        cold = clamp01(fbm(absDay, SALT_COLD ^ mix));
        wet = clamp01(fbm(absDay, SALT_WET ^ mix) + s.wetBias + climate.wetBias - 0.15);
        wind = clamp01(fbm(absDay, SALT_WIND ^ mix) + s.windBias + climate.windBias - 0.10);
        cloud = clamp01(fbm(absDay, SALT_CLOUD ^ mix) + s.cloudBias + climate.cloudBias + wet * 0.35);
    }

    // Daytime-high reference temperature, from orthogonal axes: WARMTH (biome
    // mean + region latitude offset + terrain tempOffset) and CONTINENTALITY
    // (`seasonMult` damps the seasonal swing toward maritime mildness). Latitude
    // adds a N→S gradient about the map centre (north colder); terrain's
    // `swingMult` exaggerates/damps BOTH the seasonal swing and (via dailyMult)
    // the diurnal range. (`dayHigh` matches the old single-state "noon".)
    const region = getRegionBaseline() + (place ? getLatitudeSpan() * (clamp01(place.v ?? 0.5) - 0.5) : 0);
    const seasonMult = climate.seasonMult ?? 1;
    const swingMult = t?.swingMult ?? 1;
    const tTemp = t?.tempOffset ?? 0;
    const dayHigh = climate.tempBase + region + tTemp + s.temp * seasonMult + (cold - 0.5) * 2 * climate.tempSwing * swingMult;

    // Blocking high (see HEAT_DOME_* above): a hot air mass subsides, so the
    // hottest days clear, dry and still — coupling the otherwise-independent sky
    // axes so summer's hot tail coheres into clear, dry HEATWAVE spells instead
    // of random cloud. Ramped on dayHigh, so winter (far below HEAT_DOME_LO) is
    // untouched; dayHigh is read, never written. Applies to both paths.
    const heatDome = clamp01((dayHigh - HEAT_DOME_LO) / (HEAT_DOME_HI - HEAT_DOME_LO));
    if (heatDome > 0) {
        cloud = clamp01(cloud - heatDome * HEAT_DOME_CLOUD_CUT);
        wet = clamp01(wet - heatDome * HEAT_DOME_WET_CUT);
        wind = clamp01(wind - heatDome * HEAT_DOME_WIND_CUT);
    }

    // Diurnal multiplier carries the biome's dailySwing × terrain swingMult. The
    // floor guards only the compounded (place) case — with no place it is exactly
    // climate.dailySwing, preserving the global numbers.
    let dailyMult = (climate.dailySwing ?? 1) * swingMult;
    if (place) dailyMult = Math.max(SWING_MULT_FLOOR, dailyMult);

    return { cold, wet, wind, cloud, dayHigh, dailyMult, fogBias: t?.fogBias ?? 0 };
}

/**
 * Resolve one daypart against the day's air mass into a discrete weather state.
 * @returns {{key,type,label,icon,tags,freezing,aurora,temp}}
 */
function generateDaypartState(absDay, air, dp, seasonAllowsAurora, diurnalScale = 1) {
    // Diurnal amplitude (°C below the day's high): clearer, drier air swings more,
    // and `diurnalScale` tilts the range by season (wider in summer, narrower in
    // winter). All dayparts sit at or below the high (diurnal ≤ 0), so this only
    // deepens night/dawn cooling — it never pushes a slot above the day's high.
    const amp = air.dailyMult * 5 * (1.1 - 0.4 * air.cloud) * diurnalScale;
    const temp0 = air.dayHigh + dp.diurnal * amp;
    const freezing = temp0 <= FREEZING_C;

    // Small deterministic per-slot jitter so dayparts differ within one air mass
    // (the air mass still dominates — a rainy day stays mostly wet all day).
    const jWet = (hash01(absDay, dp.salt) - 0.5) * 0.10;
    const jWind = (hash01(absDay, dp.salt + 1) - 0.5) * 0.10;
    const jCloud = (hash01(absDay, dp.salt + 2) - 0.5) * 0.08;

    let wet = clamp01(air.wet + dp.wetBias + jWet);
    let wind = clamp01(air.wind + dp.windBias + jWind);
    let cloud = clamp01(air.cloud + dp.cloudBias + jCloud);

    // Afternoon convection: warm, moist afternoons brew storms. Only bites when
    // there's both heat and some ambient moisture, so deserts stay clear.
    if (dp.convective && temp0 > 16) {
        const heat = clamp01((temp0 - 16) / 16);
        wet = clamp01(wet + heat * 0.18 * air.wet);
        wind = clamp01(wind + heat * 0.12);
    }

    let type = pickState({ baseTemp: temp0, freezing, wet, wind, cloud, fogBias: air.fogBias });

    // Aurora: clear, cold, dark slots (night) in winter/highland skies.
    let aurora = false;
    if (type === "clear" && dp.aurora && (seasonAllowsAurora || air.cold > 0.7)
        && hash01(absDay, SALT_AURORA + dp.salt) < 0.22) {
        type = "aurora";
        aurora = true;
    }

    const state = WEATHER_STATES[type] ?? WEATHER_STATES.overcast;
    // The single pick gives the dominant condition — its `type`, temperature and
    // base glyph stay authoritative. Layering then adds the co-occurring tags the
    // pick can't express (foggy rain, driving snow, thunder) plus label modifiers.
    const layered = layerWeather({ type, baseTemp: temp0, freezing, wet, wind, cloud, fogBias: air.fogBias }, state);
    return {
        key: dp.key,
        type,
        label: state.label,
        icon: layered.icon,
        tags: layered.tags,
        mods: layered.mods,
        freezing,
        aurora,
        temp: round(temp0 + state.t)
    };
}

/**
 * Generate all five dayparts for a single absolute day.
 * @param {object} opts
 * @param {number} opts.absDay      Integer day index (floor(worldTime/secondsPerDay)).
 * @param {string} opts.seasonName  One of SEASONS keys.
 * @param {string} [opts.biome]     CLIMATES key (default "temperate").
 * @param {object} [opts.place]     Spatial location {u,v,terrain,biome?} — enables
 *                                  place-aware (multi-region) generation; null = global.
 * @returns {Array<{key,type,label,icon,tags,freezing,aurora,temp}>}  Dawn→Night.
 */
export function generateDayparts({ absDay, seasonName, dayOfYear, biome = "temperate", place = null } = {}) {
    const climates = getActiveClimates();
    const biomeKey = place?.biome ?? biome;
    const climate = climates[biomeKey] ?? climates.temperate ?? CLIMATES.temperate;
    const seasons = getActiveSeasons();

    // Continuous seasonal curve when the day-of-year + calendar geometry are
    // known; otherwise fall back to the discrete season block (direct callers,
    // calendar-less contexts). This is what removes the season-boundary cliffs.
    let s;
    if (Number.isFinite(dayOfYear)) {
        const info = getSeasonAnchors();
        if (info) s = blendSeasonAnchors(dayOfYear, info.yearLength, info.anchors);
    }
    if (!s) {
        const season = seasons[seasonName] ? seasonName : "Spring";
        s = seasons[season] ?? SEASONS.Spring;
    }

    // Aurora permission stays keyed to the discrete season (a yes/no flag, not a
    // magnitude → no boundary temperature effect); cold nights still trigger it.
    const seasonAllowsAurora = !!(seasons[seasonName]?.aurora);

    // Continuous seasonal tilt to the diurnal swing: normalize the day's blended
    // seasonal temp within the year's season-temp range to [-1,1], so it tracks
    // the same smooth curve as the temperature (no boundary step) and stays
    // self-scaling if a GM edits the season temps.
    const temps = Object.values(seasons).map(v => Number(v?.temp)).filter(Number.isFinite);
    let diurnalScale = 1;
    if (temps.length >= 2) {
        const tMin = Math.min(...temps), tMax = Math.max(...temps);
        const mid = (tMin + tMax) / 2, half = (tMax - tMin) / 2;
        if (half > 0) {
            const norm = Math.max(-1, Math.min(1, ((s.temp ?? mid) - mid) / half));
            diurnalScale = 1 + DIURNAL_SEASON_TILT * norm;
        }
    }

    const air = dayAirMass(absDay, s, climate, place);
    return DAYPARTS.map(dp => generateDaypartState(absDay, air, dp, seasonAllowsAurora, diurnalScale));
}

/* How "notable" a weather state is, for choosing a day's headline glyph. */
function severity(w) {
    const t = w.tags ?? {};
    let sc = 0;
    if (t.storm) sc += 100;
    sc += (Number(t.precip) || 0) * 12;
    sc += (Number(t.snow) || 0) * 12;
    if (t.fog) sc += (typeof t.fog === "number" ? t.fog : 1) * 6 + 6;
    sc += (Number(t.wind) || 0) * 7;
    if (t.heat) sc += 14;
    if (t.aurora) sc += 4;
    return sc;
}

/* The day's representative ("headline") daypart — its most notable condition,
 * ties broken toward the daytime slots a GM is most likely to care about. */
export function dayHeadline(dayparts) {
    let best = dayparts[2] ?? dayparts[0];
    let bestScore = -1;
    for (const i of [2, 3, 1, 4, 0]) {          // afternoon → evening → morning → night → dawn
        const dp = dayparts[i];
        if (!dp) continue;
        const sc = severity(dp);
        if (sc > bestScore) { bestScore = sc; best = dp; }
    }
    return best;
}

/* Three-point temperature digest kept for back-compat consumers; "noon" is the
 * afternoon high (the old single-state engine's noon). */
function dayTemps(parts) {
    return { morning: parts[1]?.temp, noon: parts[2]?.temp, evening: parts[3]?.temp };
}

/**
 * Back-compat single-object day weather: the headline condition, with the
 * daypart array and the temperature digest attached.
 * @returns {{type,label,icon,tags,freezing,aurora,temp,temps,dayparts}}
 */
export function generateWeather(opts = {}) {
    const parts = generateDayparts(opts);
    return { ...dayHeadline(parts), temps: dayTemps(parts), dayparts: parts };
}

/** Threshold the continuous climate axes into a discrete weather state. */
function pickState({ baseTemp, freezing, wet, wind, cloud, fogBias = 0 }) {
    if (wind > 0.8) return freezing && wet > 0.45 ? "blizzard" : "gale";

    if (wet > 0.78) {
        if (freezing) return wind > 0.5 ? "blizzard" : "heavySnow";
        return wind > 0.5 ? "thunderstorm" : "downpour";
    }
    if (wet > 0.6) return freezing ? "snow" : "rain";
    if (wet > 0.45) {
        if (freezing) return "flurries";
        if (baseTemp <= 3) return "sleet";
        return "drizzle";
    }

    // Calm, damp, cool and not too cloudy → fog. Terrain `fogBias` (river valleys,
    // forest) relaxes the wet/cloud floors here ONLY — never on the global axes,
    // or cells would wrongly tip into overcast/rain.
    if (wet > 0.32 - fogBias && wind < 0.3 && cloud > 0.35 - 0.5 * fogBias && baseTemp > -3 && baseTemp < 16) return "fog";

    if (cloud > 0.66) return "overcast";
    if (cloud > 0.4) return wind > 0.6 ? "windy" : "fair";

    if (wind > 0.62) return "windy";
    if (baseTemp >= 28) return "heatwave";
    return "clear";
}

/* The glyph a thunder-bearing sky shows regardless of its precip base. */
const STORM_ICON = "fas fa-cloud-bolt";

/* i18n key for the adjective each layer prepends to the base label. The `foggy`
 * overlay is tier-aware (see FOGGY_MOD_BY_TIER); the rest are fixed words. */
const WEATHER_MOD_LABELS = Object.freeze({
    foggy:      "WITCHER.Weather.Compound.Foggy",
    windy:      "WITCHER.Weather.Compound.Windy",
    blustery:   "WITCHER.Weather.Compound.Blustery",
    driving:    "WITCHER.Weather.Compound.Driving",
    thunderous: "WITCHER.Weather.Compound.Thunderous"
});

/* The fog STATE's display name by density tier — the only base state whose tier
 * isn't already baked into its label (Drizzle/Rain/Downpour and Flurries/Snow/
 * Heavy Snow already encode theirs). */
const FOG_STATE_BY_TIER = Object.freeze({
    1: "WITCHER.Weather.Mist", 2: "WITCHER.Weather.Fog", 3: "WITCHER.Weather.ThickFog"
});
/* The `foggy` overlay adjective by the density riding on the precip beneath it. */
const FOGGY_MOD_BY_TIER = Object.freeze({
    1: "WITCHER.Weather.Compound.Misty", 2: "WITCHER.Weather.Compound.Foggy", 3: "WITCHER.Weather.Compound.Murky"
});

/**
 * Enrich the dominant state with co-occurring conditions the single pick can't
 * express. The dominant `type`/temperature are untouched (generation stays
 * regression-stable); this only adds tags, a promoted glyph and label modifiers
 * that downstream layers (FX / audio / modifiers) already consume. Every layer
 * is physically gated:
 *  - thunderstorms always carry `lightning` (what finally drives lightning-fx),
 *    and any warm (≥16°C) rain or downpour brews its own convective thunder —
 *    summer afternoon air-mass storms, the common warm-season case;
 *  - fog rides only on calm, cool, damp air over LIGHT precip (foggy rain/snow);
 *  - a wind tier rides on any precip below gale force (windy → driving).
 * Thunder is resolved FIRST and sets `tags.storm`; fog and the wind tiers both
 * skip when `tags.storm`, so a promoted storm never also reads "foggy"/"driving"
 * and every composed label stays to a single adjective.
 * @returns {{tags:object, icon:string, mods:string[]}}
 */
function layerWeather({ type, baseTemp, freezing, wet, wind, cloud, fogBias = 0 }, state) {
    const base = state ?? WEATHER_STATES[type] ?? WEATHER_STATES.overcast;
    const tags = { ...base.tags };          // clone — never mutate the shared table
    let icon = base.icon;
    const mods = [];
    const precip = Number(tags.precip) || 0;
    const snow = Number(tags.snow) || 0;

    // Thunder FIRST, so a promoted storm suppresses the fog/wind layers below
    // (both skip when tags.storm) and the composed label stays to one adjective.
    // Warm (≥16°C) rain or downpour brews air-mass convective thunder — summer
    // afternoon storms need no gale, they're often calm — which is what makes
    // storms a visible part of the warm season instead of a once-a-decade event.
    // The dominant `type`/temperature are untouched (regression-safe); we only
    // add the storm+lightning tags, a gust, the bolt glyph and the label. Cold
    // precip (snow/blizzard) keeps its storm darkness but never strobes —
    // thundersnow is too rare to fire on every winter storm.
    // Co-occurring tiers are GRADED off the climate axes, not pinned at 1: the gust
    // scales with the wind axis (and a downpour's sheer mass), and fog density with
    // how STILL and damp the air is — so the full 1→3 range reaches the FX, scene
    // tint and ranged-penalty layers instead of every storm/fog reading as tier 1.
    const gustLevel  = () => wind > 0.72 ? 3 : (wind > 0.48 || type === "downpour") ? 2 : 1;
    const fogDensity = () => (wind < 0.12 && wet > 0.40) ? 3 : (wind < 0.22 && wet > 0.34) ? 2 : 1;

    if (type === "thunderstorm") {
        tags.lightning = true;
        tags.wind = Math.max(Number(tags.wind) || 0, gustLevel());
    } else if ((type === "rain" || type === "downpour") && baseTemp >= 16) {
        tags.storm = true;
        tags.lightning = true;
        tags.wind = Math.max(Number(tags.wind) || 0, gustLevel());   // a storm always gusts ≥1
        icon = STORM_ICON;
        mods.push("thunderous");
    } else if (type === "fog") {
        tags.fog = fogDensity();   // the table pins fog at 1; grade by stillness/damp
    }

    // Fog overlay: the calm/cool/damp air pickState calls fog, but here holding
    // through light precip or under a snow sky it would otherwise lose to.
    const fogConds = wind < 0.32 && baseTemp > -3 && baseTemp < 16 && wet > 0.32 - fogBias;
    const lightPrecip = (precip >= 1 && precip <= 2) || (snow >= 1 && snow <= 2);
    if (fogConds && lightPrecip && !tags.storm) {
        tags.fog = fogDensity();
        mods.push("foggy");
    }

    // Wind layering: promote any blowing sky into a labelled wind tier. Applies
    // to DRY states too (overcast/fair/clear), not just precip — so a windy
    // overcast day reads "Windy Overcast" instead of swallowing the wind. Wet
    // skies drive their rain/snow ("driving"); dry skies are "blustery". The
    // "windy"/"gale" base STATES already carry wind 2/3 for strong dry wind, and
    // the cur< guards keep us from downgrading those. Storms set their own gust.
    if (!tags.storm) {
        const wet = precip >= 1 || snow >= 1;
        const cur = Number(tags.wind) || 0;
        if (wind > 0.7 && cur < 2) { tags.wind = 2; mods.push(wet ? "driving" : "blustery"); }
        else if (wind > 0.55 && cur < 1) { tags.wind = 1; mods.push("windy"); }
    }

    return { tags, icon, mods };
}

/**
 * Compose a display label from a weather object's base label + layer modifiers,
 * e.g. "Foggy Drizzle", "Driving Snow", "Thunderous Downpour". Tier-aware: the
 * fog STATE name follows `tags.fog` (Mist/Fog/Thick Fog) and the `foggy` overlay
 * adjective follows the density beneath it (Misty/Foggy/Murky); the other
 * intensities (Drizzle/Rain/Downpour, Flurries/Snow/Heavy Snow) already bake
 * their tier into the base label. Pure: takes a `localize` fn so the engine
 * stays free of the `game` global (and callers in a plain-node context can pass
 * an identity fn). Falls back to "{mods} {base}" word order when the pattern key
 * is absent.
 * @param {{type?:string, label?:string, tags?:object, mods?:string[]}} weather
 * @param {(key:string)=>string} localize
 * @returns {string}
 */
export function composeWeatherLabel(weather, localize) {
    const tags = weather?.tags ?? {};
    let baseKey = weather?.label ?? "";
    if (weather?.type === "fog") baseKey = FOG_STATE_BY_TIER[Number(tags.fog) || 1] ?? baseKey;
    const base = localize(baseKey) || "";
    const mods = weather?.mods ?? [];
    if (!mods.length) return base;
    const adjs = mods.map(m =>
        m === "foggy" ? localize(FOGGY_MOD_BY_TIER[Number(tags.fog) || 1] ?? "")
                      : localize(WEATHER_MOD_LABELS[m] ?? "")
    ).filter(Boolean).join(" ");
    if (!adjs) return base;
    const pat = localize("WITCHER.Weather.Compound.Pattern");
    return pat && pat.includes("{") ? pat.replace("{mods}", adjs).replace("{base}", base) : `${adjs} ${base}`;
}

/* The intensity-bearing tags, in the order they read on the debug badge. */
const TIER_TAG_KEYS = Object.freeze(["cloud", "precip", "snow", "wind", "fog"]);
const FLAG_TAG_KEYS = Object.freeze(["storm", "hail", "lightning", "heat", "aurora", "dust"]);

/**
 * A terse numeric breakdown of the active tags for GM debug, e.g.
 * `[cloud 2 · snow 1 · wind 0]` — so the GM can see WHICH intensity each layer
 * is running at, not just the composed name. Players never see this (it's the
 * GM weather panel only). Returns "" when no tags are set.
 * @param {{tags?:object}} weather
 * @returns {string}
 */
export function weatherTierBadge(weather) {
    const t = weather?.tags ?? {};
    const parts = [];
    for (const k of TIER_TAG_KEYS) { const v = Number(t[k]) || 0; if (v) parts.push(`${k} ${v}`); }
    for (const f of FLAG_TAG_KEYS) if (t[f]) parts.push(f);
    return parts.length ? `[${parts.join(" · ")}]` : "";
}

/* ─────────── calendar-aware wrappers ─────────────────────────────────────── */

const SYSTEM_ID = "witcher-ttrpg-death-march";

/** Absolute integer day index for a world time, from the live calendar. */
export function dayIndexForTime(worldTime = game.time?.worldTime ?? 0) {
    const spd = game.time?.calendar?.secondsPerDay || 86400;
    return Math.floor(worldTime / spd);
}

/** 0-indexed day-of-year for a world time (leap-aware, from the calendar). Used
 *  to position a day on the continuous annual curve; null if no calendar. */
function dayOfYearForTime(worldTime = game.time?.worldTime ?? 0) {
    const cal = game.time?.calendar;
    if (!cal?.timeToComponents) return null;
    const c = cal.timeToComponents(worldTime);
    return Number.isFinite(c?.day) ? c.day : null;
}

/** Season name (calendar season-config name) for a world time. */
function seasonNameForTime(worldTime) {
    const cal = game.time?.calendar;
    if (!cal?.timeToComponents) return "Spring";
    const comps = cal.timeToComponents(worldTime);
    const raw = cal.seasons?.values?.[comps.season]?.name ?? "";
    // Season config names are i18n keys like WITCHER.Calendar.Seasons.Winter —
    // the engine keys off the bare season word (last key segment).
    const key = String(raw).split(".").pop();
    return SEASONS[key] ? key : "Spring";
}

/**
 * Live climate catalog: seed CLIMATES merged with the GM's `climateConfig`
 * override (empty override = seed unchanged). Lets the config panel edit biome
 * profiles and add new ones without touching code.
 */
export function getActiveClimates() {
    let override = {};
    try {
        const o = game.settings.get(SYSTEM_ID, "climateConfig");
        if (o && typeof o === "object") override = o;
    } catch (_) { /* settings not ready */ }
    if (!Object.keys(override).length) return { ...CLIMATES };
    const out = {};
    for (const [key, seed] of Object.entries(CLIMATES)) out[key] = { ...seed, ...(override[key] ?? {}) };
    for (const [key, val] of Object.entries(override)) {
        if (!out[key] && val && typeof val === "object") out[key] = { ...val };
    }
    return out;
}

/**
 * Live season catalog: seed SEASONS merged with the GM's `seasonConfig`
 * override (empty override = seed unchanged). Lets the config panel retune the
 * per-season temperature/precip shifts without touching code.
 */
export function getActiveSeasons() {
    let override = {};
    try {
        const o = game.settings.get(SYSTEM_ID, "seasonConfig");
        if (o && typeof o === "object") override = o;
    } catch (_) { /* settings not ready */ }
    if (!Object.keys(override).length) return { ...SEASONS };
    const out = {};
    for (const [key, seed] of Object.entries(SEASONS)) out[key] = { ...seed, ...(override[key] ?? {}) };
    for (const [key, val] of Object.entries(override)) {
        if (!out[key] && val && typeof val === "object") out[key] = { ...val };
    }
    return out;
}

/* ─────────── continuous annual (seasonal) curve ───────────────────────────
 * The discrete SEASONS table gives one temp/bias block per season. Applying it
 * as a flat per-season value makes a STEP FUNCTION: crossing a season boundary
 * jumps the baseline overnight (Winter −13 → Spring 0 = +13 °C in one day). Real
 * annual temperature is a smooth curve — coldest at mid-winter, warmest at
 * mid-summer, flat at those extremes and steepest at the equinoxes. So instead
 * of reading one season's block, we place each season's block at that season's
 * MIDPOINT (day-of-year) and cosine-interpolate between the bracketing seasons.
 * The four editable season values keep their meaning (they are now the curve's
 * peaks/troughs rather than plateaus); the spring/autumn asymmetry (autumn
 * warmer — thermal lag) is preserved because all four anchors drive the curve. */

/** Day-of-year midpoint + params for each calendar season, sorted by midpoint.
 *  Reuses the shared `seasonMidpoints` calendar geometry (so this temperature
 *  curve and the calendar's sun-time curve can't drift apart) and pairs each
 *  midpoint with the editable SEASONS params. Returns null when there is no
 *  usable calendar data. */
function getSeasonAnchors() {
    const cal = game.time?.calendar;
    const seasonDefs = cal?.seasons?.values;
    if (!Array.isArray(seasonDefs) || !seasonDefs.length) return null;
    const geom = seasonMidpoints(cal);
    if (!geom) return null;

    const seasonsTable = getActiveSeasons();
    const { yearLength, centers } = geom;
    const anchors = [];
    for (const c of centers) {
        const sv = seasonDefs[c.index];
        const key = String(sv?.name ?? "").split(".").pop();
        const params = seasonsTable[key];
        if (!params) {
            // A GM-edited calendar uses a season name that doesn't map to a
            // known season params block, so it can't anchor the annual curve.
            // Warn rather than silently dropping it — with too few anchors the
            // curve quietly loses its spring/autumn shape.
            console.warn(`Witcher Weather | season "${key}" has no temperature params; skipping it as a seasonal-curve anchor.`);
            continue;
        }
        anchors.push({ key, center: c.center, params });
    }
    if (anchors.length < 2) return null;
    anchors.sort((a, b) => a.center - b.center);
    return { anchors, yearLength };
}

/** Continuous seasonal params at a day-of-year: cosine-interpolate the season
 *  anchors (each at its midpoint) so temp & biases flow smoothly across the year
 *  instead of stepping at boundaries. */
function blendSeasonAnchors(dayOfYear, yearLength, anchors) {
    const n = anchors.length;
    // First anchor whose midpoint is strictly after the query day (periodic).
    let i = 0;
    while (i < n && dayOfYear >= anchors[i].center) i++;
    const b = anchors[i % n];
    const a = anchors[(i - 1 + n) % n];
    const span = (((b.center - a.center) % yearLength) + yearLength) % yearLength || yearLength;
    const pos = (((dayOfYear - a.center) % yearLength) + yearLength) % yearLength;
    const e = (1 - Math.cos(Math.PI * clamp01(pos / span))) / 2;   // cosine ease
    const mix = (x, y) => (x ?? 0) + ((y ?? 0) - (x ?? 0)) * e;
    return {
        temp: mix(a.params.temp, b.params.temp),
        wetBias: mix(a.params.wetBias, b.params.wetBias),
        windBias: mix(a.params.windBias, b.params.windBias),
        cloudBias: mix(a.params.cloudBias, b.params.cloudBias)
    };
}

/* Lore-anchored regional warmth presets (°C added to every biome mean). 0 is
 * the Northern Kingdoms heartland the biomes are tuned for; the rest follow the
 * Continent's north→south latitude gradient (Kovir's subarctic far north down to
 * Ofir's Sahel-analogue savanna south). A GM picks where their campaign sits
 * instead of guessing a number; this will later become per-location on the
 * painted world map (each region/hex its own baseline) for true microclimates. */
export const REGION_PRESETS = Object.freeze([
    { key: "kovir",     baseline: -5 },   // far north — Scandinavia/Baltic
    { key: "northern",  baseline:  0 },   // Northern Kingdoms — Poland (default)
    { key: "nilfgaard", baseline:  7 },   // south of the Amell Mts — Mediterranean
    { key: "korath",    baseline: 12 },   // Korath / Zerrikania — N. Africa / Near East
    { key: "ofir",      baseline: 16 }    // Far South — Sahel / savanna
]);

/** World-level latitude warmth offset (°C). Default 0 = Northern Kingdoms. */
export function getRegionBaseline() {
    try {
        const v = Number(game.settings.get(SYSTEM_ID, "regionBaseline"));
        return Number.isFinite(v) ? v : 0;
    } catch (_) { return 0; }
}

/** Edge-to-edge latitude temperature spread (°C) across the map's N–S extent.
 *  GM-tunable; falls back to the LAT_SPAN engine default. */
export function getLatitudeSpan() {
    try {
        const v = Number(game.settings.get(SYSTEM_ID, "latitudeSpan"));
        return Number.isFinite(v) ? v : LAT_SPAN;
    } catch (_) { return LAT_SPAN; }
}

/** Days a weather front takes to cross the map W→E. GM-tunable; falls back to
 *  the SWEEP_DAYS engine default. Must be > 0 (it divides the advection rate). */
export function getFrontSweepDays() {
    try {
        const v = Number(game.settings.get(SYSTEM_ID, "frontSweepDays"));
        return (Number.isFinite(v) && v > 0) ? v : SWEEP_DAYS;
    } catch (_) { return SWEEP_DAYS; }
}

/* ─────────── weather reroll seeds ─────────────────────────────────────────
 * The engine is a pure function of the day index, so "regenerate" can't mean
 * "roll again" — it means mixing a stored seed into the noise salt so a
 * month/day samples a DIFFERENT deterministic draw while everything else is
 * untouched. Day-seed beats month-seed beats nothing. A seam appears wherever
 * two adjacent days use different mixes (a rerolled month's edges, a rerolled
 * day's two sides) — that is the accepted cost of localized regeneration. */

/** Stored reroll seeds: { months: { "<year>-<month0>": seed }, days: { <absDay>: seed } }. */
export function getWeatherSeeds() {
    try {
        const o = game.settings.get(SYSTEM_ID, "weatherSeeds");
        if (o && typeof o === "object") return { months: o.months ?? {}, days: o.days ?? {} };
    } catch (_) { /* settings not ready */ }
    return { months: {}, days: {} };
}

/* Scramble a stored seed integer into a 32-bit salt offset (0 stays 0). */
function seedSalt(seed) {
    if (seed == null) return 0;
    let h = Math.imul((seed | 0) >>> 0, 0x9e3779b1);
    h ^= h >>> 16;
    return h >>> 0;
}

/* "<year>-<month0>" for an absolute day index, via the live calendar. */
function monthKeyForDay(absDay) {
    const cal = game.time?.calendar;
    if (!cal?.timeToComponents) return null;
    const spd = cal.secondsPerDay || 86400;
    const c = cal.timeToComponents(absDay * spd + Math.floor(spd / 2));
    return `${c.year}-${c.month}`;
}

/* The salt offset that applies to a given absolute day (day override wins). */
function weatherSeedMix(absDay) {
    const seeds = getWeatherSeeds();
    if (seeds.days && seeds.days[absDay] != null) return seedSalt(seeds.days[absDay]) ^ 0x5a5a5a5a;
    const mk = monthKeyForDay(absDay);
    if (mk && seeds.months && seeds.months[mk] != null) return seedSalt(seeds.months[mk]);
    return 0;
}

/* A fresh seed for an explicit GM reroll. This is the one place randomness is
 * intended — the GM is asking for a different draw — but it is stored, so the
 * result stays deterministic and identical across clients once set. */
function newSeed() {
    return (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
}

/** Reroll a whole month (0-indexed) of a year: assigns it a fresh seed. */
export async function regenerateMonth(year, month) {
    const seeds = foundry.utils.deepClone(getWeatherSeeds());
    seeds.months[`${year}-${month}`] = newSeed();
    await game.settings.set(SYSTEM_ID, "weatherSeeds", seeds);
}

/** Reroll a single absolute day: assigns it a fresh seed. */
export async function regenerateDay(absDay) {
    const seeds = foundry.utils.deepClone(getWeatherSeeds());
    seeds.days[absDay] = newSeed();
    await game.settings.set(SYSTEM_ID, "weatherSeeds", seeds);
}

/** Clear a month's reroll (back to the canonical default weather). */
export async function resetMonth(year, month) {
    const seeds = foundry.utils.deepClone(getWeatherSeeds());
    if (seeds.months[`${year}-${month}`] == null) return;
    delete seeds.months[`${year}-${month}`];
    await game.settings.set(SYSTEM_ID, "weatherSeeds", seeds);
}

/** Clear a single day's reroll (back to the month/canonical default). */
export async function resetDay(absDay) {
    const seeds = foundry.utils.deepClone(getWeatherSeeds());
    if (seeds.days[absDay] == null) return;
    delete seeds.days[absDay];
    await game.settings.set(SYSTEM_ID, "weatherSeeds", seeds);
}

/** Whether a given month (0-indexed) currently has a reroll override. */
export function monthHasSeed(year, month) {
    return getWeatherSeeds().months[`${year}-${month}`] != null;
}

/** Whether a given absolute day currently has a reroll override. */
export function dayHasSeed(absDay) {
    return getWeatherSeeds().days[absDay] != null;
}

/** Configured climate (world setting), default temperate. */
export function currentBiome() {
    try {
        const b = game.settings.get(SYSTEM_ID, "weatherBiome");
        return getActiveClimates()[b] ? b : "temperate";
    } catch (_) { return "temperate"; }
}

/** All five dayparts (Dawn→Night) for the day containing `worldTime`. */
export function getDaypartsForTime(worldTime = game.time?.worldTime ?? 0) {
    return generateDayparts({
        absDay: dayIndexForTime(worldTime),
        seasonName: seasonNameForTime(worldTime),
        dayOfYear: dayOfYearForTime(worldTime),
        biome: currentBiome(),
        place: resolveActivePlace(worldTime)
    });
}

/* Which daypart (index into DAYPARTS) an hour falls in, using the season's
 * sun times so "dawn"/"night" track sunrise/sunset rather than fixed clock
 * hours. */
export function daypartIndexForHour(hour, sun) {
    const dawn = Number.isFinite(sun?.dawn) ? sun.dawn : 6;
    const dusk = Number.isFinite(sun?.dusk) ? sun.dusk : 18;
    if (hour >= dawn - 1 && hour < dawn + 2) return 0;   // dawn
    if (hour >= dawn + 2 && hour < 12)       return 1;   // morning
    if (hour >= 12 && hour < dusk - 1)       return 2;   // afternoon
    if (hour >= dusk - 1 && hour < dusk + 2) return 3;   // evening
    return 4;                                            // night
}

/** The active weather right now: the daypart of `worldTime`'s hour. Carries the
 *  day's daypart array + temperature digest so callers can show the breakdown. */
export function getWeatherForTime(worldTime = game.time?.worldTime ?? 0) {
    const cal = game.time?.calendar;
    const comps = cal?.timeToComponents ? cal.timeToComponents(worldTime) : null;
    const parts = generateDayparts({
        absDay: dayIndexForTime(worldTime),
        seasonName: seasonNameForTime(worldTime),
        dayOfYear: Number.isFinite(comps?.day) ? comps.day : dayOfYearForTime(worldTime),
        biome: currentBiome(),
        place: resolveActivePlace(worldTime)
    });
    const sun = (cal?.getSunTimes && comps) ? cal.getSunTimes(comps) : { dawn: 6, dusk: 18 };
    const idx = comps ? daypartIndexForHour(comps.hour ?? 12, sun) : 2;
    const active = parts[idx] ?? parts[2];
    return { ...active, temps: dayTemps(parts), dayparts: parts, daypartIndex: idx };
}

/** The day's headline weather (most notable daypart) for the day of `worldTime`.
 *  Used where one glyph stands for the whole day (calendar grid, forecast). */
export function getDayHeadline(worldTime = game.time?.worldTime ?? 0) {
    const parts = getDaypartsForTime(worldTime);
    return { ...dayHeadline(parts), temps: dayTemps(parts), dayparts: parts };
}

/** N-day forecast starting `fromTime`. Returns [{absDay, weather}] (headlines). */
export function getForecast(fromTime = game.time?.worldTime ?? 0, days = 5) {
    const spd = game.time?.calendar?.secondsPerDay || 86400;
    const out = [];
    for (let i = 0; i < days; i++) {
        const t = fromTime + i * spd;
        out.push({ absDay: dayIndexForTime(t), weather: getDayHeadline(t) });
    }
    return out;
}

export const weatherApi = Object.freeze({
    generateWeather,
    generateDayparts,
    dayHeadline,
    composeWeatherLabel,
    weatherTierBadge,
    getWeatherForTime,
    getDaypartsForTime,
    getDayHeadline,
    daypartIndexForHour,
    getForecast,
    dayIndexForTime,
    currentBiome,
    getActiveClimates,
    getActiveSeasons,
    getRegionBaseline,
    getLatitudeSpan,
    getFrontSweepDays,
    REGION_PRESETS,
    getWeatherSeeds,
    regenerateMonth,
    regenerateDay,
    resetMonth,
    resetDay,
    monthHasSeed,
    dayHasSeed,
    tables: { WEATHER_STATES, CLIMATES, SEASONS, DAYPARTS }
});
