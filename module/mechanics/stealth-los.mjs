/**
 * stealth-los — Foundry V14 scene-level-aware line-of-sight primitives.
 *
 * All stealth detection and cone rendering routes through this module
 * so wall filtering, cross-level visibility, and cone geometry stay
 * consistent between the mechanics dispatch (detection) and the
 * spotter-vision overlay (rendering).
 *
 * V14 vision model recap:
 *   - Every token has `token.document.level` — a SceneLevel document
 *     ID identifying which level the token is on.
 *   - Every wall has `wall.document.levels` — a Set of SceneLevel IDs.
 *     Empty = universal (registered in every level's edge collection).
 *     Non-empty = registered ONLY in those specific levels' edges.
 *   - Each SceneLevel has `visibility.levels` — a Set of OTHER
 *     SceneLevel IDs visible from THIS level. This is the sole
 *     mechanism for cross-level visibility ("I'm on the ground floor
 *     but I can see the balcony above").
 *   - `ClockwiseSweepPolygon.create(origin, {type, level, angle,
 *     rotation, radius})` builds a sight polygon that only clips
 *     against walls in `level.edges`. Pass the SPOTTER's level and
 *     ground-floor walls stop blocking upper-floor sight naturally.
 */

const SYSTEM_ID = "witcher-ttrpg-death-march";

/** Resolve the SceneLevel document for a token. Every V14 token has
 *  a required `document.level` field defaulting to the scene's
 *  `defaultLevelId`, so this should never fail on a properly-set-up
 *  scene. Falls back to the scene's initial level (which always
 *  exists) if the token's level ID is stale (deleted level, imported
 *  from another scene, etc.). */
export function getTokenLevel(token) {
    const scene = canvas?.scene;
    if (!scene) return null;
    const lvlId = token?.document?.level;
    const lvl = lvlId ? scene.levels?.get?.(lvlId) : null;
    return lvl ?? scene.initialLevel ?? scene.levels?.contents?.[0] ?? null;
}

/** True if a viewer on `fromLevel` is allowed to see anything on
 *  `toLevel`. Same-level is always visible. Different-level relies on
 *  Foundry's explicit `visibility.levels` configuration on the source
 *  level. Missing / broken level records fall through to "visible" so
 *  a mis-configured scene doesn't silently hide everything. */
export function canLevelSee(fromLevel, toLevel) {
    if (!fromLevel || !toLevel) return true;
    if (fromLevel.id === toLevel.id) return true;
    const cross = fromLevel.visibility?.levels;
    if (!cross) return true;
    return cross.has?.(toLevel.id) ?? false;
}

/** Foundry's ClockwiseSweepPolygon class. Resolved lazily so this
 *  module can be imported before canvas init. */
function getSweepClass() {
    return foundry?.canvas?.geometry?.ClockwiseSweepPolygon
        ?? globalThis.ClockwiseSweepPolygon
        ?? null;
}

/** Build a sight polygon for a viewer at `origin` on `level` with the
 *  given `angle`/`rotation`/`radius`. Returns null on failure so
 *  callers can degrade gracefully (empty polygon behaves as "sees
 *  nothing" from `polygon.contains()`'s perspective).
 *
 *  `angle` in degrees (360 = full circle). `rotation` in Foundry's
 *  convention (0 = facing south / +y, CW increase — matches
 *  `token.document.rotation`). `radius` in pixels.
 *
 *  `useThreshold: true` mirrors Foundry's own `PointVisionSource`
 *  configuration (see `point-vision-source.mjs:286`). Without this,
 *  the sweep's `_testEdgeInclusion` short-circuits the threshold
 *  filter (`clockwise-sweep.mjs:277`) and walls with `sight:
 *  PROXIMITY (30)` or `sight: DISTANCE (40)` are treated as
 *  unconditional blockers — proximity windows would never let a
 *  spotter see through them regardless of distance. Enabling
 *  threshold makes the sweep respect the wall's `threshold.sight`
 *  proximity band exactly as Foundry's built-in vision does. */
/**
 * A token's external radius in pixels — half its smallest dimension, matching
 * Foundry's own `Token#externalRadius`.
 *
 * This matters for PROXIMITY (threshold) walls. `Edge#applyThreshold` resolves
 * them as `Math.max(sourceDistance - externalRadius, 0) < threshold`, so the
 * external radius is what makes the distance measure from the token's EDGE
 * rather than its centre. Foundry's own vision source passes it; omitting it
 * silently made every one of our sweeps require the viewer to stand half a
 * square closer than Foundry does before a proximity window opened up. A
 * spotter standing AT a window would have it register as still blocked.
 */
export function externalRadiusOf(token) {
    const r = Number(token?.externalRadius);
    if (Number.isFinite(r) && r > 0) return r;
    const w = Number(token?.w) || 0;
    const h = Number(token?.h) || 0;
    return (w && h) ? Math.min(w, h) / 2 : 0;
}

export function buildSightPolygon(origin, level, { angle = 360, rotation = 0, radius, type = "sight",
                                                  externalRadius = 0 }) {
    const SweepCls = getSweepClass();
    if (!SweepCls) return null;
    if (!level) return null;
    if (!(radius > 0)) return null;
    try {
        return SweepCls.create({
            x: origin.x,
            y: origin.y,
            elevation: origin.elevation ?? level.elevation?.base ?? 0
        }, {
            type:          type,
            level:         level,
            angle:         angle,
            rotation:      rotation,
            radius:        radius,
            /* Threshold walls measure from the viewer's EDGE, not their centre
             * — see `externalRadiusOf`. Foundry's PointVisionSource passes this;
             * without it proximity windows stay shut half a square too long. */
            externalRadius: externalRadius,
            useThreshold:  true
        });
    } catch (err) {
        console.warn(`${SYSTEM_ID} | buildSightPolygon failed`, err);
        return null;
    }
}

/** Pure geometric cone polygon — angle + rotation + radius, NO wall
 *  filtering. Used for cross-level detection/rendering where wall
 *  clipping at the spotter's own level would incorrectly block sight
 *  to a target on a different level (Foundry walls are 2D infinite-
 *  height barriers, so a ground-floor wall between the spotter's XY
 *  and a roof-target's XY blocks the sweep polygon even though the
 *  spotter would physically look up over the wall to see the roof).
 *
 *  Cross-level visibility is a scene-config decision made via
 *  `level.visibility.levels` — once that grants visibility, the
 *  target level is treated as fully exposed. Range + angular gate
 *  still apply (that's what this polygon encodes); only the wall
 *  test is dropped.
 *
 *  Uses Foundry's `LimitedAnglePolygon` — the same geometric
 *  primitive `ClockwiseSweepPolygon` uses internally as its
 *  angular boundary shape before wall clipping is applied. */
export function buildAngularConePolygon(origin, { angle = 360, rotation = 0, radius }) {
    const Cls = foundry?.canvas?.geometry?.LimitedAnglePolygon
             ?? globalThis.LimitedAnglePolygon;
    if (!Cls) return null;
    if (!(radius > 0)) return null;
    try {
        return new Cls({ x: origin.x, y: origin.y }, {
            radius:   radius,
            angle:    angle,
            rotation: rotation
        });
    } catch (err) {
        console.warn(`${SYSTEM_ID} | buildAngularConePolygon failed`, err);
        return null;
    }
}

/** Full-circle unbounded-radius vision sweep for a token at its own
 *  level — used as the stealther's own "what area of the map can I
 *  possibly see" mask. Radius is the scene's max reach (`dimensions.
 *  maxR`) so the polygon covers the whole scene except for wall-
 *  blocked areas. */
export function buildFullVisionPolygonForToken(token) {
    const level = getTokenLevel(token);
    const gridDim = canvas?.dimensions;
    if (!level || !gridDim) return null;
    const radius = gridDim.maxR ?? Math.hypot(gridDim.sceneWidth, gridDim.sceneHeight);
    return buildSightPolygon(
        { x: token.center?.x ?? 0, y: token.center?.y ?? 0,
          elevation: Number(token.document?.elevation) || 0 },
        level,
        { angle: 360, rotation: 0, radius, externalRadius: externalRadiusOf(token) }
    );
}
