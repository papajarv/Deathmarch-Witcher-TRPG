/**
 * Weather pins — per-daypart forecast overrides.
 *
 * The deterministic engine (mechanics/weather.mjs) produces 5 dayparts per day.
 * A "pin" is an explicit GM-authored override for a specific daypart on a
 * specific absolute day: it substitutes the layer-composed conditions
 * (cloud/precip/special/wind/fog) while keeping temp/freezing/aurora derived
 * from the engine so pinned weather still respects the season/biome/climate
 * model. Multi-day pinning is per-daypart: any of the 5 dayparts on any day
 * may be pinned independently.
 *
 * Storage: world setting `weatherPins`, shape
 *   { [absDay]: { [daypartKey]: { cloud, precip, special, wind, fog } } }
 * Only pinned dayparts are stored; missing entries fall through to the
 * engine unchanged.
 *
 * All UI wiring lives in the WeatherControlApp calendar tab. Reads flow
 * through the engine helpers (getDaypartsForTime / getWeatherForTime) via
 * applyDaypartPins() so every downstream consumer picks pins up transparently.
 */

// `composeManualWeather` is only referenced at call time (inside
// applyDaypartPins), so the import cycle
//   weather.mjs → weather-pins.mjs → manual-weather.mjs → weather.mjs
// is safe. Do NOT reference module-level exports from manual-weather.mjs at
// this file's top level — those bindings can be uninitialized when this
// module first evaluates during the cycle.
import { composeManualWeather } from "./manual-weather.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const SETTING_KEY = "weatherPins";

const DEFAULT_LAYER_SELECTION = Object.freeze({
    cloud: "", precip: "", special: "", wind: "", fog: ""
});

const VALID_DAYPARTS = new Set(["dawn", "morning", "afternoon", "evening", "night"]);

function readAll() {
    try {
        const raw = game.settings.get(SYSTEM_ID, SETTING_KEY);
        return raw && typeof raw === "object" ? raw : {};
    } catch (_) { return {}; }
}

/**
 * Reverse the engine's `weather.tags` output back into layer state ids from
 * WEATHER_LAYERS. Used to pre-fill the Edit-daypart editor with whatever the
 * engine (or a prior override) is currently showing, so the GM starts from
 * the current state rather than a blank slate. Mapping is direct — every
 * layer state defines its own tag pattern in manual-weather.mjs.
 */
export function tagsToLayerSelection(tags = {}) {
    const sel = { ...DEFAULT_LAYER_SELECTION };
    const t = tags || {};

    if (t.clear || t.cloud === 0)   sel.cloud = "sunny";
    else if (t.cloud === 1)         sel.cloud = "cloudy";
    else if (t.cloud === 2)         sel.cloud = "overcast";

    if (t.hail && t.storm)          sel.precip = "hailstorm";
    else if (t.hail)                sel.precip = "hail";
    else if (t.snow === 3 && t.storm) sel.precip = "blizzard";
    else if (t.snow === 3)          sel.precip = "heavySnow";
    else if (t.snow === 2)          sel.precip = "snowfall";
    else if (t.snow === 1)          sel.precip = "flurries";
    else if (t.precip === 3)        sel.precip = "heavyRain";
    else if (t.precip === 2)        sel.precip = "rainfall";
    else if (t.precip === 1)        sel.precip = "showers";

    if (t.lightning)                sel.special = "lightning";

    if (t.wind === 4)               sel.wind = "stormWind";
    else if (t.wind === 3)          sel.wind = "strong";
    else if (t.wind === 2)          sel.wind = "winds";
    else if (t.wind === 1)          sel.wind = "breeze";

    if (t.fog === 3)                sel.fog = "thickFog";
    else if (t.fog === 2)           sel.fog = "fog";
    else if (t.fog === 1)           sel.fog = "misty";

    return sel;
}

/** Return the pinned layer selection for a daypart, or null if not pinned. */
export function getDaypartPin(absDay, daypartKey) {
    if (!VALID_DAYPARTS.has(daypartKey)) return null;
    const all = readAll();
    const day = all[absDay];
    const pin = day?.[daypartKey];
    if (!pin || typeof pin !== "object") return null;
    return { ...DEFAULT_LAYER_SELECTION, ...pin };
}

/** True if any daypart on this day is pinned. */
export function dayHasPin(absDay) {
    const day = readAll()[absDay];
    if (!day || typeof day !== "object") return false;
    for (const k of Object.keys(day)) {
        if (VALID_DAYPARTS.has(k) && day[k] && typeof day[k] === "object") return true;
    }
    return false;
}

/** True if this specific daypart is pinned. */
export function daypartIsPinned(absDay, daypartKey) {
    return !!getDaypartPin(absDay, daypartKey);
}

/** Write a pin for a specific daypart. Empty/all-blank selection clears it. */
export async function setDaypartPin(absDay, daypartKey, selection) {
    if (!VALID_DAYPARTS.has(daypartKey)) return;
    const clean = { ...DEFAULT_LAYER_SELECTION, ...(selection && typeof selection === "object" ? selection : {}) };
    // Strip to only known layer keys.
    for (const k of Object.keys(clean)) {
        if (!(k in DEFAULT_LAYER_SELECTION)) delete clean[k];
    }
    const empty = Object.values(clean).every(v => !v);
    if (empty) return clearDaypartPin(absDay, daypartKey);

    const all = { ...readAll() };
    const day = { ...(all[absDay] ?? {}) };
    day[daypartKey] = clean;
    all[absDay] = day;
    await game.settings.set(SYSTEM_ID, SETTING_KEY, all);
    Hooks.callAll("wdm:weatherPinsChanged", { absDay, daypartKey });
}

/** Set/clear a single layer on a daypart pin. Creates the pin if needed. */
export async function setDaypartPinLayer(absDay, daypartKey, layerKey, stateId) {
    if (!VALID_DAYPARTS.has(daypartKey)) return;
    if (!(layerKey in DEFAULT_LAYER_SELECTION)) return;
    const cur = getDaypartPin(absDay, daypartKey) ?? { ...DEFAULT_LAYER_SELECTION };
    cur[layerKey] = stateId || "";
    await setDaypartPin(absDay, daypartKey, cur);
}

/** Clear one daypart's pin. */
export async function clearDaypartPin(absDay, daypartKey) {
    const all = { ...readAll() };
    const day = all[absDay];
    if (!day || !day[daypartKey]) return;
    const nextDay = { ...day };
    delete nextDay[daypartKey];
    if (Object.keys(nextDay).length === 0) delete all[absDay];
    else all[absDay] = nextDay;
    await game.settings.set(SYSTEM_ID, SETTING_KEY, all);
    Hooks.callAll("wdm:weatherPinsChanged", { absDay, daypartKey });
}

/** Clear every daypart pin for a day. */
export async function clearDayPins(absDay) {
    const all = { ...readAll() };
    if (!(absDay in all)) return;
    delete all[absDay];
    await game.settings.set(SYSTEM_ID, SETTING_KEY, all);
    Hooks.callAll("wdm:weatherPinsChanged", { absDay });
}

/**
 * Apply pinned overrides to a fresh dayparts array from the engine.
 * Returns a new array; unpinned dayparts pass through unchanged. Pinned
 * dayparts get their conditions (label/icon/tags/mods/type) replaced with
 * the layer-composed override, while temp/freezing/aurora are preserved
 * from the engine part so the pin doesn't fight the season/biome climate.
 */
export function applyDaypartPins(parts, absDay) {
    if (!Array.isArray(parts) || !parts.length) return parts;
    const day = readAll()[absDay];
    if (!day || typeof day !== "object") return parts;
    let touched = false;
    const out = parts.map(part => {
        const pin = day[part?.key];
        if (!pin || typeof pin !== "object") return part;
        const composed = composeManualWeather({ ...DEFAULT_LAYER_SELECTION, ...pin });
        touched = true;
        return {
            ...part,
            type: "pinned",
            label: composed.label,
            icon: composed.icon,
            tags: composed.tags,
            // Drop engine-generated label modifiers (foggy/driving/etc.); the
            // pinned composition already speaks for itself.
            mods: [],
            // Preserve engine-derived temp/climate flags.
            temp: part.temp,
            freezing: part.freezing,
            aurora: !!composed.tags.aurora || !!part.aurora
        };
    });
    return touched ? out : parts;
}

export const weatherPinsApi = Object.freeze({
    getDaypartPin,
    setDaypartPin,
    setDaypartPinLayer,
    clearDaypartPin,
    clearDayPins,
    dayHasPin,
    daypartIsPinned,
    applyDaypartPins,
    tagsToLayerSelection
});
