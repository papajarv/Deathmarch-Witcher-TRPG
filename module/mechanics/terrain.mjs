/**
 * Terrain types — the landsite catalog the weather engine and the (planned)
 * paintable weather map share. Each type contributes biases on the SAME axes
 * the climate/season system already uses (temp / wet / wind / cloud) plus a
 * `fog` propensity and an `elevation` hint, so terrain layers cleanly on top of
 * the biome + season without a second model.
 *
 * The biases are grounded in real orographic/local meteorology:
 *   - mountains: cold (env. lapse rate ≈6.5°C/km → ≈-9.75°C at 1500 m, damped
 *                to -9 since biome already carries the regional mean), wet
 *                (orographic lift on the windward side), windy, cloudy
 *   - hills:     milder version of mountains (200 m → ≈-1.3°C → -1)
 *   - forest:    humid + morning mist, sheltered (less wind), mild swing
 *   - river:     strong overnight/valley radiation fog (cold-air drainage), humid
 *   - coast:     maritime — milder mean, SMALLER diurnal swing, wet, windy, sea fog
 *   - plains:    open/continental — bigger swing, a touch more wind
 *
 * `swingMult` scales the daily/seasonal temperature spread (coast moderates →
 * <1; mountains/plains exaggerate → >1). `color`/`icon` are for the paintable
 * map UI. Edited live through the `terrainConfig` world setting (empty = seed).
 */

const SYSTEM_ID = "witcher-ttrpg-death-march";

/* Seed catalog. An empty `terrainConfig` override falls through to this. */
export const SEED_TERRAIN = Object.freeze({
    plains:    { label: "WITCHER.Weather.Terrain.plains",    icon: "fa-solid fa-wheat-awn",    color: "#c9b977", elevation:    0, tempOffset:  0,   wetBias:  0.00, windBias:  0.05, cloudBias:  0.00, fogBias:  0.00, swingMult: 1.1 },
    hills:     { label: "WITCHER.Weather.Terrain.hills",     icon: "fa-solid fa-mound",        color: "#9caf6b", elevation:  200, tempOffset: -1,   wetBias:  0.05, windBias:  0.08, cloudBias:  0.03, fogBias:  0.02, swingMult: 1.15 },
    mountains: { label: "WITCHER.Weather.Terrain.mountains", icon: "fa-solid fa-mountain",     color: "#8d8f96", elevation: 1500, tempOffset: -9,   wetBias:  0.15, windBias:  0.18, cloudBias:  0.10, fogBias:  0.05, swingMult: 1.3 },
    forest:    { label: "WITCHER.Weather.Terrain.forest",    icon: "fa-solid fa-tree",         color: "#4f7d4a", elevation:    0, tempOffset: -0.5, wetBias:  0.05, windBias: -0.10, cloudBias:  0.02, fogBias:  0.08, swingMult: 0.9 },
    river:     { label: "WITCHER.Weather.Terrain.river",     icon: "fa-solid fa-water",        color: "#5b8fb0", elevation:    0, tempOffset:  0,   wetBias:  0.05, windBias:  0.00, cloudBias:  0.00, fogBias:  0.15, swingMult: 0.95 },
    coast:     { label: "WITCHER.Weather.Terrain.coast",     icon: "fa-solid fa-umbrella-beach", color: "#7fb5c9", elevation: 0, tempOffset:  1,   wetBias:  0.12, windBias:  0.18, cloudBias:  0.08, fogBias:  0.10, swingMult: 0.7 }
});

/* Numeric/string fields a saved terrain type may carry (used to sanitize the
 * stored override against the seed shape). */
export const TERRAIN_NUM_FIELDS = ["elevation", "tempOffset", "wetBias", "windBias", "cloudBias", "fogBias", "swingMult"];

function readOverride() {
    try {
        const o = game.settings.get(SYSTEM_ID, "terrainConfig");
        return o && typeof o === "object" ? o : {};
    } catch (_) { return {}; }
}

/**
 * The live terrain catalog: the seed merged with the GM's `terrainConfig`
 * override. An empty override returns the seed unchanged; a partial override
 * patches per-type fields, and brand-new GM-authored types are kept as-is.
 */
export function getActiveTerrain() {
    const override = readOverride();
    if (!Object.keys(override).length) return { ...SEED_TERRAIN };
    const out = {};
    for (const [key, seed] of Object.entries(SEED_TERRAIN)) {
        out[key] = { ...seed, ...(override[key] ?? {}) };
    }
    for (const [key, val] of Object.entries(override)) {
        if (!out[key] && val && typeof val === "object") out[key] = { ...val };
    }
    return out;
}

/** One terrain type's modifiers (falls back to plains if the key is unknown). */
export function getTerrain(key) {
    const all = getActiveTerrain();
    return all[key] ?? all.plains ?? SEED_TERRAIN.plains;
}

export const terrainApi = Object.freeze({
    getActiveTerrain,
    getTerrain,
    SEED_TERRAIN,
    TERRAIN_NUM_FIELDS
});
