/**
 * weather-map.mjs — spatial place resolution for the weather engine.
 *
 * The engine (weather.mjs) is a pure function of (absDay, place). This module
 * supplies the `place`: it reads a GM-painted terrain map stored on a designated
 * world-map scene and resolves the party's current location into the
 * {u, v, terrain, biome} the engine samples.
 *
 * AUTHORED DATA ONLY. The painted map and the party marker are scene flags
 * (authoring), never generated weather state — generation stays a pure function
 * of (absDay, cell). Nothing here is written during normal play; the GM paints
 * from the Phase 3 canvas tool (which owns the write path).
 *
 * Scene-flag schema — scene.getFlag(SYSTEM_ID, "weatherMap"):
 *   {
 *     version: 1,
 *     cells:   { "<i>,<j>": { terrain: "<terrainKey>", biome?: "<climateKey>" } },
 *     marker:  { i, j } | null,   // the stored "party is here" cell
 *     biome?:  "<climateKey>"     // optional scene-wide default biome
 *   }
 *
 * Resolution chain (resolveActivePlace): a token flagged as the party marker on
 * the map scene → the stored marker cell → a scene-wide default biome (map
 * centre) → null (the engine's global, single-region path — no regression on an
 * un-designated/un-painted world).
 */

import { getTerrain } from "./terrain.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";
export const WEATHER_MAP_FLAG = "weatherMap";
export const WEATHER_MAP_VERSION = 1;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** The GM-designated world-map scene, or null when none is set / it's missing. */
export function getMapScene() {
    let id = "";
    try { id = game.settings.get(SYSTEM_ID, "weatherMapScene") || ""; } catch (_) { /* settings not ready */ }
    if (!id) return null;
    return game.scenes?.get(id) ?? null;
}

/** The normalized weatherMap flag for a scene (defaults filled, shape sanitized). */
export function getWeatherMap(scene) {
    let raw = null;
    try { raw = scene?.getFlag?.(SYSTEM_ID, WEATHER_MAP_FLAG) ?? null; } catch (_) { /* no scene */ }
    const cells = (raw && typeof raw.cells === "object" && raw.cells) ? raw.cells : {};
    const m = raw?.marker;
    const marker = (m && Number.isFinite(m.i) && Number.isFinite(m.j)) ? { i: m.i, j: m.j } : null;
    return {
        version: Number.isFinite(raw?.version) ? raw.version : WEATHER_MAP_VERSION,
        cells,
        marker,
        biome: typeof raw?.biome === "string" ? raw.biome : null
    };
}

/** The painted cell at offset (i,j) — `{ terrain, biome? }` — or null if unpainted. */
export function cellAt(scene, i, j) {
    const c = getWeatherMap(scene).cells[`${i},${j}`];
    return (c && typeof c === "object") ? c : null;
}

/**
 * Normalized scene coordinates of a grid cell's centre: u (0 = west … 1 = east),
 * v (0 = north … 1 = south). Pixel-centre based (via scene.grid.getCenterPoint),
 * so it is correct for square AND hex grids. Works off-canvas: scene.grid and
 * scene.dimensions are prepared for every loaded scene, not just the active one.
 */
export function normalizedCoords(scene, i, j) {
    try {
        const c = scene.grid.getCenterPoint({ i, j });
        const d = scene.dimensions ?? scene.getDimensions();
        return {
            u: clamp01((c.x - d.sceneX) / d.sceneWidth),
            v: clamp01((c.y - d.sceneY) / d.sceneHeight)
        };
    } catch (_) {
        return { u: 0.5, v: 0.5 };
    }
}

/** Cell offset {i,j} of a token flagged as the party marker on `scene`, or null. */
function markerTokenCell(scene) {
    try {
        const tokens = scene?.tokens;
        if (!tokens?.size) return null;
        const marker = tokens.find(t => t.getFlag(SYSTEM_ID, "weatherMarker"));
        if (!marker) return null;
        const off = scene.grid.getOffset(marker.getCenterPoint());   // getCenterPoint uses scene.grid
        return { i: off.i, j: off.j };
    } catch (_) { return null; }
}

/**
 * Walk the place-resolution chain once and report WHERE the weather is read from
 * — the source, the cell, and the terrain — so both the engine projection
 * (resolveActivePlace) and the GM panel (describeActivePlace) share one truth.
 * Always returns an object; `source: "global"` means fall through to the
 * engine's single-region path.
 * @returns {{scene:Scene|null, sceneName:string,
 *   source:"global"|"markerToken"|"markerCell"|"sceneBiome",
 *   cell:{i:number,j:number}|null, terrainKey:string|null, terrain:object|null,
 *   biome:string|null, u:number, v:number}}
 */
function resolvePlaceInfo(_worldTime = 0) {
    const info = {
        scene: null, sceneName: "", source: "global",
        cell: null, terrainKey: null, terrain: null, biome: null, u: 0.5, v: 0.5
    };
    try {
        const scene = getMapScene();
        if (!scene) return info;
        info.scene = scene;
        info.sceneName = scene.name ?? "";
        const map = getWeatherMap(scene);

        // A flagged marker token wins (the GM can just drag a token); else the
        // stored marker cell set from the paint tool.
        const tokenCell = markerTokenCell(scene);
        const cell = tokenCell ?? map.marker;
        if (cell) {
            const painted = cellAt(scene, cell.i, cell.j);
            const { u, v } = normalizedCoords(scene, cell.i, cell.j);
            info.source = tokenCell ? "markerToken" : "markerCell";
            info.cell = { i: cell.i, j: cell.j };
            info.terrainKey = painted?.terrain ?? null;
            info.terrain = info.terrainKey ? getTerrain(info.terrainKey) : null;
            info.biome = painted?.biome || map.biome || null;
            info.u = u; info.v = v;
            return info;
        }

        // No marker but a scene-wide default biome → the map centre.
        if (map.biome) { info.source = "sceneBiome"; info.biome = map.biome; return info; }

        return info;   // designated scene but nothing to resolve → global path
    } catch (_) {
        return info;
    }
}

/**
 * The active weather `place` for a world time, or null to fall through to the
 * engine's global path. `worldTime` is accepted for symmetry / future
 * time-varying resolution but is not used yet (the marker is authored, not timed).
 * @returns {{u:number, v:number, terrain:object|null, biome:string|undefined}|null}
 */
export function resolveActivePlace(worldTime = 0) {
    const info = resolvePlaceInfo(worldTime);
    if (info.source === "global") return null;
    if (info.source === "sceneBiome") return { u: 0.5, v: 0.5, terrain: null, biome: info.biome };
    // undefined (not null) so generateDayparts falls back to the global biome opt.
    return { u: info.u, v: info.v, terrain: info.terrain, biome: info.biome || undefined };
}

/** GM-panel-facing description of the active place (see {@link resolvePlaceInfo}). */
export function describeActivePlace(worldTime = 0) {
    return resolvePlaceInfo(worldTime);
}

/* ─────────── write path (Phase 3 paint tool) ────────────────────────────────
 * Foundry's setFlag deep-MERGES, so it can add a cell but never remove one — an
 * erase would silently survive. The paint layer therefore holds the whole map in
 * memory and flushes it wholesale through a ForcedReplacement operator (v14's
 * non-recursive assignment, the documented successor to the deprecated "-=key"
 * deletion syntax), so deletions and edits both take. GM-only writes. */

/** Replace the scene's entire weatherMap flag with `model` (no deep-merge). */
export async function writeWeatherMap(scene, model = {}) {
    if (!scene?.update) return null;
    const cells = (model.cells && typeof model.cells === "object") ? model.cells : {};
    const m = model.marker;
    const marker = (m && Number.isFinite(m.i) && Number.isFinite(m.j)) ? { i: m.i, j: m.j } : null;
    const value = { version: WEATHER_MAP_VERSION, cells, marker };
    if (typeof model.biome === "string" && model.biome) value.biome = model.biome;
    const ForcedReplacement = foundry.data.operators.ForcedReplacement;
    return scene.update({ flags: { [SYSTEM_ID]: { [WEATHER_MAP_FLAG]: ForcedReplacement.create(value) } } });
}

/** Wipe the painted map (terrain + marker + biome) on a scene. */
export async function clearMap(scene) {
    if (!scene?.unsetFlag) return null;
    return scene.unsetFlag(SYSTEM_ID, WEATHER_MAP_FLAG);
}

export const weatherMapApi = Object.freeze({
    getMapScene,
    getWeatherMap,
    cellAt,
    normalizedCoords,
    resolveActivePlace,
    describeActivePlace,
    writeWeatherMap,
    clearMap,
    WEATHER_MAP_FLAG,
    WEATHER_MAP_VERSION
});
