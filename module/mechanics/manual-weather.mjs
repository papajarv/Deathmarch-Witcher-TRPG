/**
 * Manual weather override — GM-driven layered weather states.
 *
 * The deterministic engine (mechanics/weather.mjs) is a pure function of the
 * calendar day. This layer lets a GM override it with hand-picked weather built
 * from five INDEPENDENT layers that combine into one weather object:
 *
 *   cloud    — Sunny Day / Cloudy / Overcast
 *   precip   — Showers … Blizzard (rain + snow + hail ladder)
 *   special  — Lightning Storm
 *   wind     — Breeze / Winds / Strong Winds / Gale
 *   fog      — Misty / Fog / Thick Fog
 *
 * Each state carries the same abstract `tags` the engine uses (fog / wind /
 * precip / snow / storm / heat / aurora, plus hail / lightning) so the
 * modifier layer and scene-FX layer consume the composed result with no special
 * casing. Composition merges tags: numeric → max, boolean → OR.
 *
 * Selection lives in the `manualWeather` world setting; when `enabled` is off,
 * `getActiveWeather` falls straight through to the deterministic engine. The
 * temperature is always borrowed from the engine — this layer controls the
 * *conditions*, not the climate.
 *
 * All tables are original to this system.
 */

import { getWeatherForTime } from "./weather.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";

/* Ordered layers. `key` is the manualWeather field; `title` an i18n key; each
 * state has an `id` (stored value), `label` i18n key, FA `icon`, and `tags`. */
export const WEATHER_LAYERS = Object.freeze([
    {
        key: "cloud",
        title: "WITCHER.Weather.Layer.Cloud",
        states: [
            { id: "sunny",    label: "WITCHER.Weather.State.Sunny",    icon: "fas fa-sun",       tags: { clear: true } },
            { id: "cloudy",   label: "WITCHER.Weather.State.Cloudy",   icon: "fas fa-cloud-sun", tags: { cloud: 1 } },
            { id: "overcast", label: "WITCHER.Weather.State.Overcast", icon: "fas fa-cloud",     tags: { cloud: 2 } }
        ]
    },
    {
        key: "precip",
        title: "WITCHER.Weather.Layer.Precip",
        states: [
            { id: "showers",    label: "WITCHER.Weather.State.Showers",    icon: "fas fa-cloud-rain",          tags: { precip: 1 } },
            { id: "rainfall",   label: "WITCHER.Weather.State.Rainfall",   icon: "fas fa-cloud-showers-heavy", tags: { precip: 2 } },
            { id: "heavyRain",  label: "WITCHER.Weather.State.HeavyRain",  icon: "fas fa-cloud-showers-water", tags: { precip: 3 } },
            { id: "hail",       label: "WITCHER.Weather.State.Hail",       icon: "fas fa-cloud-hail",          tags: { precip: 2, hail: true } },
            { id: "hailstorm",  label: "WITCHER.Weather.State.Hailstorm",  icon: "fas fa-cloud-hail-mixed",    tags: { precip: 3, storm: true, hail: true } },
            { id: "flurries",   label: "WITCHER.Weather.State.Flurries",   icon: "fas fa-snowflake",           tags: { snow: 1 } },
            { id: "snowfall",   label: "WITCHER.Weather.State.Snowfall",   icon: "fas fa-snowflake",           tags: { snow: 2 } },
            { id: "heavySnow",  label: "WITCHER.Weather.State.HeavySnow",  icon: "fas fa-snowflake",           tags: { snow: 3 } },
            { id: "blizzard",   label: "WITCHER.Weather.State.Blizzard",   icon: "fas fa-snow-blowing",        tags: { snow: 3, storm: true } }
        ]
    },
    {
        key: "special",
        title: "WITCHER.Weather.Layer.Special",
        states: [
            { id: "lightning", label: "WITCHER.Weather.State.Lightning", icon: "fas fa-bolt-lightning", tags: { lightning: true } }
        ]
    },
    {
        key: "wind",
        title: "WITCHER.Weather.Layer.Wind",
        states: [
            { id: "breeze",    label: "WITCHER.Weather.State.Breeze",    icon: "fas fa-wind", tags: { wind: 1 } },
            { id: "winds",     label: "WITCHER.Weather.State.Winds",     icon: "fas fa-wind", tags: { wind: 2 } },
            { id: "strong",    label: "WITCHER.Weather.State.Strong",    icon: "fas fa-wind", tags: { wind: 3 } },
            { id: "stormWind", label: "WITCHER.Weather.State.StormWind", icon: "fas fa-wind", tags: { wind: 4 } }
        ]
    },
    {
        key: "fog",
        title: "WITCHER.Weather.Layer.Fog",
        states: [
            { id: "misty",    label: "WITCHER.Weather.State.Misty",    icon: "fas fa-smog", tags: { fog: 1 } },
            { id: "fog",      label: "WITCHER.Weather.State.Fog",      icon: "fas fa-smog", tags: { fog: 2 } },
            { id: "thickFog", label: "WITCHER.Weather.State.ThickFog", icon: "fas fa-smog", tags: { fog: 3 } }
        ]
    }
]);

/* Layer key → state id → state, for O(1) lookup during composition. */
const STATE_INDEX = (() => {
    const idx = {};
    for (const layer of WEATHER_LAYERS) {
        idx[layer.key] = {};
        for (const st of layer.states) idx[layer.key][st.id] = st;
    }
    return idx;
})();

/* Icon priority when composing — the "headline" layer wins the strip glyph. */
const ICON_PRIORITY = ["special", "precip", "fog", "wind", "cloud"];

const DEFAULT_SELECTION = Object.freeze({
    enabled: false, cloud: "", precip: "", special: "", wind: "", fog: ""
});

/* Scene flag keys mirror the world setting: when a scene is "pinned", its
 * flag `manualWeather` holds the override for THAT scene only, and reads
 * short-circuit the world setting while viewing the scene. The pin toggle
 * lives on flag `manualWeatherPinned`. */
const SCENE_SELECTION_FLAG = "manualWeather";
const SCENE_PINNED_FLAG    = "manualWeatherPinned";

/** True when the currently-viewed scene has its own override pinned. */
export function isManualPinnedToScene() {
    try { return !!canvas?.scene?.getFlag?.(SYSTEM_ID, SCENE_PINNED_FLAG); }
    catch (_) { return false; }
}

/** Read the raw world-scope selection (never scene). */
function getWorldSelection() {
    try {
        const s = game.settings.get(SYSTEM_ID, "manualWeather");
        return { ...DEFAULT_SELECTION, ...(s && typeof s === "object" ? s : {}) };
    } catch (_) {
        return { ...DEFAULT_SELECTION };
    }
}

/** Read the raw scene-scope selection for the current scene (never world). */
function getSceneSelection() {
    try {
        const s = canvas?.scene?.getFlag?.(SYSTEM_ID, SCENE_SELECTION_FLAG);
        return { ...DEFAULT_SELECTION, ...(s && typeof s === "object" ? s : {}) };
    } catch (_) {
        return { ...DEFAULT_SELECTION };
    }
}

/** The stored manual selection (safe before the setting registers).
 *  Resolves scene-pinned override transparently when the current scene is
 *  pinned; otherwise falls back to the world setting. */
export function getManualSelection() {
    return isManualPinnedToScene() ? getSceneSelection() : getWorldSelection();
}

/** Is the manual override currently active? */
export function isManualWeatherOn() {
    return !!getManualSelection().enabled;
}

/** Set one layer to a state id ("" clears it). GM write. Writes to the
 *  current scene's flag when the override is pinned to the scene, else to
 *  the world setting. */
export async function setManualLayer(layerKey, stateId) {
    if (!STATE_INDEX[layerKey]) return;
    const next = getManualSelection();
    next[layerKey] = (stateId && STATE_INDEX[layerKey][stateId]) ? stateId : "";
    if (isManualPinnedToScene()) {
        await canvas.scene.setFlag(SYSTEM_ID, SCENE_SELECTION_FLAG, next);
    } else {
        await game.settings.set(SYSTEM_ID, "manualWeather", next);
    }
}

/** Toggle the manual override master switch. GM write. Same routing as
 *  setManualLayer — writes to whichever scope currently owns the override. */
export async function setManualEnabled(on) {
    const next = getManualSelection();
    next.enabled = !!on;
    if (isManualPinnedToScene()) {
        await canvas.scene.setFlag(SYSTEM_ID, SCENE_SELECTION_FLAG, next);
    } else {
        await game.settings.set(SYSTEM_ID, "manualWeather", next);
    }
}

/** Toggle pin-to-scene. When turning ON, seed the scene flag with the
 *  current world selection so the scene inherits whatever the GM had set
 *  world-wide. When turning OFF, delete both scene flags so the scene
 *  falls back to the world setting cleanly. GM write, current scene. */
export async function setManualPinnedToScene(on) {
    const scene = canvas?.scene;
    if (!scene) return;
    if (on) {
        const seed = getWorldSelection();
        await scene.setFlag(SYSTEM_ID, SCENE_SELECTION_FLAG, seed);
        await scene.setFlag(SYSTEM_ID, SCENE_PINNED_FLAG, true);
    } else {
        await scene.unsetFlag(SYSTEM_ID, SCENE_PINNED_FLAG);
        await scene.unsetFlag(SYSTEM_ID, SCENE_SELECTION_FLAG);
    }
}

/* Merge a state's tags into an accumulator: numeric → max, boolean → OR. */
function mergeTags(acc, tags) {
    for (const [k, v] of Object.entries(tags ?? {})) {
        if (typeof v === "number") acc[k] = Math.max(Number(acc[k]) || 0, v);
        else if (v) acc[k] = true;
    }
}

/**
 * Compose the selected layer states into one weather-shaped object.
 * @param {object} selection  A getManualSelection() result.
 * @returns {{type, label, icon, tags}}  label is a pre-localized joined string.
 */
export function composeManualWeather(selection = getManualSelection()) {
    const chosen = [];
    for (const layer of WEATHER_LAYERS) {
        const st = STATE_INDEX[layer.key]?.[selection[layer.key]];
        if (st) chosen.push({ layer: layer.key, st });
    }

    const tags = {};
    for (const { st } of chosen) mergeTags(tags, st.tags);

    // Icon: highest-priority layer that has a selection.
    let icon = "fas fa-cloud";
    for (const key of ICON_PRIORITY) {
        const hit = chosen.find(c => c.layer === key);
        if (hit) { icon = hit.st.icon; break; }
    }

    // Label: join localized state names; fall back to "Clear" when nothing set.
    const loc = (k) => (game?.i18n?.localize ? game.i18n.localize(k) : k);
    const names = chosen.map(c => loc(c.st.label));
    const label = names.length ? names.join(" · ") : loc("WITCHER.Weather.Clear");

    return { type: "manual", label, icon, tags };
}

/**
 * The fully-formed manual weather object, with temperature borrowed from the
 * deterministic engine so the strip still shows a sensible °C.
 */
export function getManualWeather(worldTime = game.time?.worldTime ?? 0) {
    const base = getWeatherForTime(worldTime);
    const composed = composeManualWeather();
    return {
        ...composed,
        freezing: base.freezing,
        aurora: !!composed.tags.aurora,
        temp: base.temp,
        temps: base.temps
    };
}

/**
 * The weather in effect right now: the manual override when enabled, otherwise
 * the deterministic engine. Single entry point for all "current weather"
 * consumers (strip, modifiers, scene FX).
 */
export function getActiveWeather(worldTime = game.time?.worldTime ?? 0) {
    return isManualWeatherOn() ? getManualWeather(worldTime) : getWeatherForTime(worldTime);
}

export const manualWeatherApi = Object.freeze({
    getActiveWeather,
    getManualWeather,
    composeManualWeather,
    getManualSelection,
    isManualWeatherOn,
    isManualPinnedToScene,
    setManualLayer,
    setManualEnabled,
    setManualPinnedToScene,
    layers: WEATHER_LAYERS,
    STATE_INDEX
});
