/**
 * Stealth spotter-vision overlay — a single flat red wash showing where
 * every potential enemy could see the sneaking player, drawn on the map for
 * the player who owns a currently-stealthed actor.
 *
 * Purpose: give the sneaking player a HUD so they can see where they
 * need to move to avoid being spotted. Foundry doesn't expose enemy
 * vision to players by default; this synthesizes each enemy's sweep
 * polygon (same primitive the spot-check engine uses) and paints it.
 *
 * Compositing:
 *   - FLAT UNION. Every spotter's cone geometry is drawn into ONE stencil
 *     and painted with ONE fill, so overlapping cones read as a single
 *     uniform wash rather than stacking darker where they cross.
 *   - LIGHTING-CLIPPED. The union is masked by (a) the stealther's own wall
 *     LOS and (b) a lit-region mask built from Foundry's active light
 *     sources — so cones don't render in darkness the spotter (or the
 *     viewer) can't see into. Skipped when the scene is globally lit.
 *
 * Visibility gate:
 *   - Shown ONLY on clients that own a stealthed actor, plus GM (who
 *     always wants to see what enemies can see).
 *   - Hidden entirely for players who don't own a stealthed actor
 *     (no cheating: you don't get to see enemy cones just because
 *     someone else on the team is sneaking).
 *
 * Layer: `canvas.primary`, sorted below the token meshes so rings, bars and
 * effect decorations stay readable on top of the wash. It must be in primary —
 * not interface or controls — because those are separate render groups drawn
 * after it, and z-index cannot order across groups. Darkness is respected by
 * the lit-region mask; being in primary also means the darkness filter dims the
 * wash, which is the accepted cost of sitting under the decorations.
 *
 * Refresh triggers:
 *   - Any potential spotter moves / rotates / changes elevation.
 *   - Any actor's stealth flag toggles active/inactive.
 *   - Scene change (canvasReady rebuild).
 */

import { computeMaxSightMetres, computeZoneAngles, getAllowedVisionAngle,
         isEligibleSpotterToken,
         spotterCanPerceive, sceneAmbientlyLit, visionRangeMetres } from "../mechanics/stealth-hooks.mjs";
import { getTokenLevel, canLevelSee, buildSightPolygon,
         buildAngularConePolygon, externalRadiusOf } from "../mechanics/stealth-los.mjs";
import { isStealthed, getStealthState, exposureKey } from "../mechanics/stealth.mjs";
import { getStealthConfig } from "../mechanics/stealth-config.mjs";
import { computePassivePerception, stealthBaseOf, coneReachFor,
         darkSightMetres } from "../mechanics/stealth-hooks.mjs";
import { coneReachMetres } from "../mechanics/stealth-detection.mjs";

import { lightLevelAt, ambientLightLevel, visionRank } from "../mechanics/light-level.mjs";
import { getActiveWeather } from "../mechanics/manual-weather.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";

const CONE_COLOR = 0xff2020;

/* Flat union opacity. Every spotter's cone geometry is unioned into a single
 * stencil and painted with ONE fill at this alpha, so overlapping cones read
 * as one uniform wash instead of stacking darker. */
const CONE_UNION_ALPHA = 0.26;


/* ─────────── layer lifecycle ─────────── */

let _layer = null;

function ensureLayer() {
    if (_layer && !_layer.destroyed) return _layer;
    /* Lives in `canvas.primary`, sorted BELOW the token meshes.
     *
     * This is the third home it has had, and the first that can actually work.
     * `canvas.controls` and then `canvas.interface` both render as SEPARATE
     * GROUPS after primary — so the wash painted over token rings, effect rings
     * and bars no matter what z-index it was given. zIndex only orders siblings
     * within a group; it cannot reach across groups. The token decorations live
     * on an occlusion carrier added to `canvas.primary`, so the cone has to be
     * in primary as well to sit beneath them.
     *
     * TRADE-OFF, accepted deliberately: primary is the group the darkness
     * filter dims, which is exactly why the layer was moved out of it
     * originally to keep the red crisp. The lit-region mask now restricts the
     * cone to places sight is actually possible, so most of what remains is lit
     * anyway. The cost is that a darkvision watcher's cone drawn across an
     * unlit room will be dimmed along with the room. If that reads too faint,
     * the fix is to raise CONE_UNION_ALPHA rather than to leave the group.
     *
     * Sort keys mirror what `getOrCreateOcclusionCarrier` sets, since primary
     * sorts by elevation → sortLayer → sort → zIndex. A sortLayer below the
     * tokens' puts the wash under every token and its decorations. */
    const parent = canvas?.primary ?? canvas?.interface ?? canvas?.stage;
    if (!parent) return null;
    _layer = new PIXI.Container();
    _layer.name = "WDMStealthSpotterVision";
    _layer.eventMode = "none";

    const LAYERS = PIXI?.Container && globalThis.PrimaryCanvasGroup?.SORT_LAYERS;
    const tokenLayer = Number(LAYERS?.TOKENS);
    _layer.elevation = 0;
    _layer.sortLayer = Number.isFinite(tokenLayer) ? tokenLayer - 10 : 690;
    _layer.sort      = 0;
    _layer.zIndex    = 0;
    parent.addChild(_layer);
    if (parent) parent.sortDirty = true;
    return _layer;
}

function destroyLayer() {
    if (_layer && !_layer.destroyed) {
        try { _layer.destroy({ children: true }); } catch (_) {}
    }
    _layer = null;
}

/* ─────────── visibility gate ─────────── */

/** True when the current user should see the spotter-vision overlay.
 *  Bound to SELECTION, not ownership: cones only render for the
 *  perspective of a currently-controlled stealthed token. Deselect
 *  and the cones vanish (you're no longer "viewing through" them).
 *  Reselect and they come back. */
function shouldShowForCurrentUser() {
    if (!canvas?.scene) return false;
    /* Master enable — GM can flip the whole stealth system off at
     * runtime; overlay tears down cleanly and stays empty until
     * re-enabled. */
    if (!getStealthConfig().enabled) return false;
    return controlledStealthedTokens().length > 0;
}

function anyStealthActive() {
    const tokens = canvas.tokens?.placeables ?? [];
    for (const t of tokens) {
        if (t?.actor && isStealthed(t.actor)) return true;
    }
    return false;
}

/** Currently-selected tokens that are also stealthed. Used both for
 *  the visibility gate and as the "viewer perspective" set — mask,
 *  LOS check, and cone hide-my-own filter all key off this list.
 *  Zero controlled stealthers = zero cones. */
function controlledStealthedTokens() {
    const out = [];
    for (const t of (canvas.tokens?.controlled ?? [])) {
        if (!t?.actor || t.destroyed) continue;
        if (!isStealthed(t.actor)) continue;
        out.push(t);
    }
    return out;
}

/** Every "potential spotter" token — filtered by DISPOSITION, not
 *  ownership. Ownership-based filtering failed for the GM (GM owns
 *  every token on the scene, so an "exclude owned" filter excluded
 *  everything). Disposition inclusion:
 *   - HOSTILE (-1) — enemies, obvious spotters
 *   - NEUTRAL ( 0) — guards, uncommitted NPCs who'd still notice
 *   - FRIENDLY ( 1) — allies. Still eligible spotters: a stealthing
 *                     PC sneaking past their own party's guard, or a
 *                     player wanting to see where their ally token is
 *                     looking, both need friendly cones visible. The
 *                     `controlled.has(t.id)` gate below prevents the
 *                     currently-selected token from painting its own
 *                     cone regardless of disposition, which was the
 *                     original "no self-spotting" concern.
 *   - SECRET  (-2) — hidden combatants; only visible to GM anyway,
 *                     so players' overlay quietly omits them (their
 *                     token isn't rendered), GM sees them. */
function spottersForOverlay() {
    const tokens = canvas.tokens?.placeables ?? [];
    const cfg = getStealthConfig();
    const hideWhenSpotted = !!cfg.hideConeWhenSpotted;
    /* Union of `spottedBy` UUIDs across every currently-controlled
     * stealthed token — spotters already listed there have SEEN this
     * viewer; if `hideConeWhenSpotted` is on, we drop their cones to
     * cut visual clutter (the cone carries no more information). */
    const alreadySpottedByUuids = new Set();
    if (hideWhenSpotted) {
        for (const st of controlledStealthedTokens()) {
            const state = getStealthState(st.actor);
            for (const uuid of (state?.spottedBy ?? [])) alreadySpottedByUuids.add(uuid);
        }
    }
    const out = [];
    const controlled = new Set((canvas.tokens?.controlled ?? []).map(t => t.id));
    for (const t of tokens) {
        /* ELIGIBILITY comes from the mechanic — one list, so a drawn cone always
         * means a watcher who actually rolls. Everything below this line is
         * PRESENTATION: what to draw, never who can detect. */
        if (!isEligibleSpotterToken(t)) continue;
        /* Never show cones for tokens the viewer currently has
         * SELECTED. Ownership isn't the gate — GM often owns every
         * token on the map but only cares about excluding whatever
         * they're currently controlling / viewing through. */
        if (controlled.has(t.id)) continue;
        /* Stealthed enemies: skip UNLESS we've already spotted them.
         * A stealthed enemy I've located is a live threat — their
         * cone shows me where THEY are looking (so I can stay out
         * of their sightlines), even though they don't yet know I
         * exist. Foundry's `t.visible` is authoritative here:
         * stealth-token-visibility.mjs sets visible=false for
         * stealthed enemies I haven't spotted, and leaves it true
         * for stealthed enemies whose `spottedBy` includes one of
         * my owned actors. */
        if (isStealthed(t.actor) && !t.visible) continue;
        /* Spotters who already know we're here are TAGGED, not dropped.
         * Dropping them removed their suspicion eye along with their cone, so a
         * watcher who had just caught you vanished from the display entirely at
         * the exact moment that fact mattered most — the eye appeared to blink
         * out rather than lock red. The cone is still suppressed for them below
         * (it carries no more information); the eye is not. */
        t.__wdmAlreadySpotted = alreadySpottedByUuids.has(t.actor.uuid);
        out.push(t);
    }
    return out;
}

/** True if `stealtherToken` has line of sight to ANY part of the
 *  spotter — center + four corners of the spotter's bounding box.
 *  Reveals the cone when even a fragment of the spotter is visible
 *  (a shoulder sticking past a wall corner counts). Prefers
 *  Foundry's collision backend (fast raycast); falls back to a full
 *  sweep polygon containment if the backend isn't exposed.
 *
 *  No wallhacking: if EVERY probe point is blocked by walls, the
 *  spotter's cone is not drawn.
 *
 *  Elevation is NOT passed to the sweep/collision test — Foundry's
 *  default behaviour is used, matching whatever the scene's normal
 *  vision rendering does. Cross-floor visibility (via reveal-raised-
 *  areas region behaviors etc.) is the scene's own concern.
 *  walls are set up with the right vertical bounds. */
/** Build the vision polygon for one of MY controlled stealthed
 *  tokens, respecting BOTH the wall LOS AND the token's angular
 *  vision (`sight.angle` clipped by allowedVisionAngle). Returns
 *  null if the token has no level or the sweep fails.
 *
 *  This is what powers the "cones only render inside my LOS" rule.
 *  A stealther with 180° vision has a semicircular polygon in
 *  front of them — spotters standing behind the stealther fall
 *  OUTSIDE the polygon and their cones don't render.
 *
 *  Cost: one ClockwiseSweepPolygon per stealther per REBUILD (not
 *  per frame). Cached by refresh(), keyed by stealther id. */
function buildStealtherVisionPoly(stealtherToken) {
    const stealtherLevel = getTokenLevel(stealtherToken);
    const gridDim = canvas?.dimensions;
    if (!gridDim) return null;
    const radius = gridDim.maxR
        ?? Math.hypot(gridDim.sceneWidth, gridDim.sceneHeight);
    const angle    = getAllowedVisionAngle(stealtherToken) ?? 360;
    const rotation = Number(stealtherToken.document?.rotation) || 0;
    return buildSightPolygon(
        { x: stealtherToken.center?.x ?? 0,
          y: stealtherToken.center?.y ?? 0,
          elevation: Number(stealtherToken.document?.elevation) || 0 },
        stealtherLevel,
        { angle, rotation, radius, externalRadius: externalRadiusOf(stealtherToken) }
    );
}

/** True if the pre-built stealther vision polygon contains ANY part
 *  of the spotter (center + four bounding-box corners). Used per-
 *  spotter inside the main loop; polygon reused across spotters
 *  via the caller-supplied cache. */
function stealtherCanSee(stealtherToken, spotterToken, poly) {
    /* Cross-level gate first — cheap, no polygon math. If the two
     * tokens are on different levels and Foundry says those levels
     * can't see each other, no cone. */
    const stealtherLevel = getTokenLevel(stealtherToken);
    const spotterLevel   = getTokenLevel(spotterToken);
    if (stealtherLevel && spotterLevel && stealtherLevel.id !== spotterLevel.id) {
        if (!canLevelSee(stealtherLevel, spotterLevel)) return false;
    }
    if (!poly) return false;

    const cx = spotterToken.center?.x ?? 0;
    const cy = spotterToken.center?.y ?? 0;
    const halfW = ((Number(spotterToken.w) || 0) / 2) - 2;
    const halfH = ((Number(spotterToken.h) || 0) / 2) - 2;
    if (poly.contains(cx,         cy        )) return true;
    if (poly.contains(cx - halfW, cy - halfH)) return true;
    if (poly.contains(cx + halfW, cy - halfH)) return true;
    if (poly.contains(cx + halfW, cy + halfH)) return true;
    if (poly.contains(cx - halfW, cy + halfH)) return true;
    return false;
}

/** For a given spotter, true if ANY of the viewer's stealthed tokens
 *  can see them (union of LOS across all owned stealthers). Takes a
 *  pre-built Map of stealther-id → vision polygon so we don't
 *  rebuild sweeps per spotter. */
function anyStealtherSees(spotter, stealthers, visionPolys) {
    for (const st of stealthers) {
        if (stealtherCanSee(st, spotter, visionPolys?.get(st.id))) return true;
    }
    return false;
}


/* ─────────── polygon build + draw ─────────── */

/** Build a sweep polygon from a token's origin. `opts.angle` and
 *  `opts.rotation` override the token's own sight config — use for
 *  the stealther's own vision mask, where we want 360° walls-only
 *  (the sneaker can turn their head to look anywhere; only walls
 *  determine what they know exists). Spotter cones pass through
 *  the token's own cone / rotation as-is.
 *
 *  Passing `elevation` to the sweep lets Foundry filter walls by
 *  their `top` / `bottom` bounds — a token at elevation 5 sees over
 *  a wall bounded 0-3. */
/* Sweep cache.
 *
 * `ClockwiseSweepPolygon.create` walks the level's wall edges — the single most
 * expensive call in the overlay — and the tiered cone asks for FOUR radii × THREE
 * zones per watcher, so a scene with five guards was doing sixty full sweeps per
 * refresh. Between refreshes almost none of the inputs change: a stationary
 * guard on an unchanged map produces byte-identical geometry every time.
 *
 * Keyed on everything the sweep reads, plus `_invalidationVersion`, which the
 * overlay already bumps for wall / light / token-population changes. A moved or
 * rotated watcher changes its own key, so staleness isn't possible. */
const _sweepCache = new Map();
let _sweepCacheVersion = -1;

function buildVisionPolygonAtRadius(token, radiusPx, opts = {}) {
    const doc = token?.document;
    if (!doc) return null;

    if (_sweepCacheVersion !== _invalidationVersion) {
        _sweepCache.clear();
        _sweepCacheVersion = _invalidationVersion;
    }
    const key = `${token.id}:${Math.round(radiusPx)}:${Math.round(opts.angle ?? -1)}`
              + `:${Math.round(opts.rotation ?? Number(doc.rotation) ?? 0)}`
              + `:${Math.round(token.center?.x ?? 0)},${Math.round(token.center?.y ?? 0)}`
              + `:${Number(doc.elevation) || 0}`;
    const hit = _sweepCache.get(key);
    if (hit !== undefined) return hit;

    const origin = {
        x: token.center?.x ?? 0,
        y: token.center?.y ?? 0,
        elevation: Number(doc.elevation) || 0
    };
    const angle    = opts.angle    ?? getAllowedVisionAngle(token) ?? 360;
    const rotation = opts.rotation ?? Number(doc.rotation)         ?? 0;

    /* Sight sweep at the TOKEN'S OWN level. Foundry's sweep is
     * level-aware: it queries `level.edges` (only walls registered
     * to that level, plus universal walls), then clips by cone
     * angle / rotation / one-way / LIMITED / threshold / door state.
     * Result:
     *   - Walls on the spotter's floor DO clip their cone.
     *   - Walls on OTHER floors don't — an upper-floor spotter's
     *     cone isn't cut off by ground-floor room walls.
     *   - Cross-level rendering is handled by the outer stealther
     *     mask (see refresh() below).
     * Falls back to null on failure; caller degrades to no cone. */
    const level = getTokenLevel(token);
    if (!level) return null;
    const poly = buildSightPolygon(origin, level,
        { angle, rotation, radius: radiusPx, externalRadius: externalRadiusOf(token) });
    _sweepCache.set(key, poly);
    return poly;
}

/** Stealther's own "what can I see" mask polygon, at their own level and
 *  extended to a generous radius.
 *
 *  This used to force `{ angle: 360, rotation: 0 }` on the reasoning that a
 *  sneaker can turn their head. The effect was that enemy cones rendered in
 *  the sneaker's BLIND SPOT — the overlay showed you a watcher's cone sweeping
 *  space your character cannot see, which is exactly the information the FOV
 *  is supposed to withhold. If a token has a facing, the overlay honours it.
 *
 *  The angle comes from `getAllowedVisionAngle`, the SAME function that sizes
 *  a watcher's cone, so "what I can see" and "what they can see" obey one set
 *  of rules — including the `fullCircleIsUnset` reading of a bare 360 and the
 *  per-token True Angle / Allowed Angle flags.
 *
 *  Set `clipOverlayToOwnFov: false` to restore the old head-turning behaviour. */
function buildVisionPolygon(token) {
    const gridDim = canvas?.dimensions;
    if (!gridDim) return null;
    const pxPerUnit = (gridDim.size || 100) / (gridDim.distance || 1);
    const maxM = computeMaxSightMetres(token);
    /* Cap the sneaker's own view at what it can actually see now — in darkness
     * that's its darkvision (Foundry sight) range — so cones render only where
     * the sneaker can see, not across the whole dark map. Infinity when lit. */
    const cappedM = Math.min(maxM * 2, visionRangeMetres(token));
    const radiusPx = (cappedM * pxPerUnit)
                   || gridDim.maxR
                   || Math.hypot(gridDim.sceneWidth, gridDim.sceneHeight);
    /* Omitting `angle`/`rotation` lets buildVisionPolygonAtRadius fall back to
     * the token's own configured arc and facing. */
    return getStealthConfig().clipOverlayToOwnFov === false
        ? buildVisionPolygonAtRadius(token, radiusPx, { angle: 360, rotation: 0 })
        : buildVisionPolygonAtRadius(token, radiusPx);
}

/** Repaint the whole overlay. Cheap enough at typical spotter counts
 *  (< 30 enemies per scene) to just wipe + redraw on every trigger. */
/** Hash of state that affects the CONE draw — spotter identity, their
 *  position/rotation/sight config/elevation, and the stealthers'
 *  identity/position (mask geometry depends on stealthers). If this
 *  hash is unchanged since the last refresh, we skip the expensive
 *  cone rebuild (sweep polygons, per-spotter zone masks, blur filter
 *  reinit) and only redraw the cheap mask (which handles the token-
 *  cutout tracking during animation). */
let _coneStateHash = "";
let _cachedConesContainer = null;
/* Assigned at :1406 and read at :710/:836/:856 — and never declared, so every
 * one of those threw `ReferenceError: _cachedMetersContainer is not defined`
 * in strict-mode ESM. Surfaced while token-moving during spell tests: the
 * spotter overlay's refresh failed on every move. */
let _cachedMetersContainer = null;
/* NOTE: the pace/movement badge is NOT drawn here any more. It lives on the
 * token itself (policy/stealth-pace-indicator.mjs) so it moves with the mesh
 * during an animated move instead of teleporting to the destination while the
 * token slides to catch up. Its accumulation state went with it. */

let _cachedMask = null;
let _maskContentHash = "";

/* Version counter — bumped by hooks that INVALIDATE the overlay's
 * inputs (new tokens, deleted tokens, control changes, config
 * changes, wall/level changes, actor stealth-flag flips, etc.).
 * `refresh()` early-exits if the version hasn't advanced since the
 * last run AND the token that fired refreshToken didn't change
 * anything the overlay cares about — this is what makes refresh()
 * a true no-op during rotation of the immersive-camera token, when
 * refreshToken fires per animation frame but nothing about the
 * overlay's state has actually changed. */
let _invalidationVersion = 0;
let _lastRunVersion = -1;
let _lastRunControlledKey = "";
let _lastRunViewportKey = "";
function _bumpInvalidation() { _invalidationVersion++; }
/* Whether the cached mask holds at least one usable stealther
 * polygon. Tracked separately from the hash because clearing the
 * Graphics zeroes its geometry but we want to remember that the
 * rebuild was attempted. */
let _maskHasContent = false;

/* ─────────── stealther vision polygon cache ─────────── */

/** Per-stealther cached sight polygon, keyed by a position hash. The
 *  polygon is generated by Foundry's ClockwiseSweepPolygon which is
 *  the DOMINANT per-frame cost during animations (mask is rebuilt
 *  every rAF; the sweep otherwise runs every rAF regardless of
 *  whether the stealther moved). Cache it and reuse across refreshes
 *  as long as the stealther's document position + level + elevation
 *  are unchanged.
 *
 *  Invalidation: bumped `_polyEpoch` counter forces a global cache
 *  miss on scene mutations (wall create/update/delete, level change,
 *  canvas reload) so we never render against stale wall geometry.
 *  Per-entry position hash covers the token-move case. */
const _stealtherPolyCache = new Map();
let _polyEpoch = 0;

function _invalidateStealtherPolyCache() {
    _polyEpoch++;
    _stealtherPolyCache.clear();
}

function getCachedStealtherVisionPolygon(token) {
    if (!token) return null;
    const d = token.document;
    if (!d) return null;
    /* Hash captures every input the sweep polygon depends on. QUANTIZED
     * to grid cells (Foundry V14 mutates document x/y on every
     * animation frame — see token.mjs:2378 — so a per-pixel hash
     * cache-misses on every rAF and rebuilds a Foundry sweep polygon
     * per frame). Snapping to grid cells means the polygon rebuilds
     * at most once per cell crossing (~5-10× per second at a run),
     * not 60× per second. Level is included so a floor change
     * always invalidates. */
    const gs = canvas?.grid?.size ?? canvas?.scene?.grid?.size ?? 100;
    const gx = Math.floor((Number(d.x) || 0) / gs);
    const gy = Math.floor((Number(d.y) || 0) / gs);
    /* Rotation bucket: the mask wedge now depends on facing, so turning in
     * place has to rebuild the sweep. Bucketed to 5° so a turn ANIMATION
     * (V14 mutates document.rotation every tick) doesn't rebuild per frame,
     * while the resting wedge is never more than 2.5° off. */
    const rot = Math.round((Number(d.rotation) || 0) / 5) * 5;
    const hash = `${_polyEpoch}|${gx},${gy},${rot},${d.elevation ?? 0},${d.level ?? ""}`;
    const entry = _stealtherPolyCache.get(token.id);
    if (entry && entry.hash === hash) return entry.poly;
    const poly = buildVisionPolygon(token);
    _stealtherPolyCache.set(token.id, { hash, poly });
    return poly;
}

/* ─────────── viewport / frustum culling ─────────── */

/** Return the current viewport's bounds in WORLD (scene) coordinates
 *  as `{ left, right, top, bottom }`, or `null` if the canvas isn't
 *  ready. Used for frustum culling so we don't build cones for
 *  spotters whose entire sight-range circle is off-screen — the
 *  primary scalability lever for scenes with many NPCs. */
function _getViewportWorldBounds() {
    const stage = canvas?.stage;
    const renderer = canvas?.app?.renderer;
    if (!stage || !renderer) return null;
    /* Invert the stage's world transform on the two screen corners
     * to get the world rectangle currently visible. `worldTransform`
     * accounts for zoom, pan, and any parent scaling — the same
     * transform PIXI uses to render, so the result is exact. */
    try {
        const wt = stage.worldTransform;
        const tl = wt.applyInverse(new PIXI.Point(0, 0));
        const br = wt.applyInverse(new PIXI.Point(renderer.screen.width, renderer.screen.height));
        return {
            left:   Math.min(tl.x, br.x),
            right:  Math.max(tl.x, br.x),
            top:    Math.min(tl.y, br.y),
            bottom: Math.max(tl.y, br.y)
        };
    } catch (_) { return null; }
}

/** True if `spotter`'s sight-range circle (centred on the spotter,
 *  radius = `sightPx`) intersects the viewport rectangle. Uses an
 *  inflated-AABB test — a spotter is kept when their sight-reach
 *  square overlaps the (padded) viewport. `margin` prevents cones
 *  popping in/out right at the edge of the screen. */
function _spotterInFrustum(spotter, sightPx, view, margin = 32) {
    if (!view) return true;    /* no viewport info → don't cull */
    const cx = spotter.center?.x ?? 0;
    const cy = spotter.center?.y ?? 0;
    const reach = sightPx + margin;
    if (cx + reach < view.left)   return false;
    if (cx - reach > view.right)  return false;
    if (cy + reach < view.top)    return false;
    if (cy - reach > view.bottom) return false;
    return true;
}


/** Redraw the mask Graphics from scratch. The mask defines the area
 *  cones can render into — polygon (stealther's own vision), reveal
 *  discs (cross-level spotters), MINUS token cutouts (holes at every
 *  visible token so tokens poke through cones fully clear).
 *
 *  Cutouts read `mesh.position` which is Foundry's animated position.
 *  Because refresh() runs at PIXI ticker LOW priority — AFTER
 *  Foundry's OBJECTS priority (23) where mesh.position is updated,
 *  BEFORE the frame renders — the cutout mask contains the current
 *  frame's token positions and stays in sync with the visible tokens.
 *
 *  This function is gated by `_maskContentHash` so it only runs when
 *  something actually changed (stealther crossed grid cell, spotter
 *  moved, OR any visible token's position changed). Per-frame during
 *  animation the tokens are moving so this DOES run per frame, but
 *  its cost is just drawPolygon (cached) + N drawCircle — no sweep
 *  polygons. */
function _rebuildMaskInto(mask, stealthers, spotters, memoLevel, memoSight,
                          pxPerUnit, notifyHasContent) {
    for (const st of stealthers) {
        const poly = getCachedStealtherVisionPolygon(st);
        if (!poly) continue;
        mask.beginFill(0xffffff, 1);
        mask.drawPolygon(poly);
        const stealtherLvl = memoLevel(st);
        /* Angular-only view of the sneak, built lazily and only when a
         * cross-level watcher actually turns up.
         *
         * Cross-level reveal must NOT be tested against the sneak's wall-aware
         * polygon. Foundry walls are 2D infinite-height barriers, so a wall on
         * the sneak's own floor clips a sweep that has no business blocking a
         * view of another storey — the same reason `computeCoverageFraction`
         * drops wall filtering for cross-level pairs. Arc and range still
         * apply; only walls are ignored. */
        let crossPoly = null;
        const crossPolyFor = () => {
            if (crossPoly !== null) return crossPoly;
            const gridDim = canvas?.dimensions;
            const ppu = (gridDim?.size || 100) / (gridDim?.distance || 1);
            const capM = Math.min(computeMaxSightMetres(st) * 2, visionRangeMetres(st));
            const radius = (Number.isFinite(capM) ? capM : computeMaxSightMetres(st) * 2) * ppu;
            const angle = getStealthConfig().clipOverlayToOwnFov === false
                ? 360 : (getAllowedVisionAngle(st) ?? 360);
            crossPoly = buildAngularConePolygon(
                { x: st.center?.x ?? 0, y: st.center?.y ?? 0 },
                { angle, rotation: Number(st.document?.rotation) || 0, radius }) ?? false;
            return crossPoly;
        };
        for (const spotter of spotters) {
            if (!spotter?.center) continue;
            const spotterLvl = memoLevel(spotter);
            if (!stealtherLvl || !spotterLvl) continue;
            if (stealtherLvl.id === spotterLvl.id) continue;
            /* Pass the polygon EXPLICITLY. `stealtherCanSee` bails on
             * `if (!poly) return false`, so the old two-argument call returned
             * false for every cross-level pair and the reveal disc was never
             * drawn once — cross-level cones simply did not render. */
            const cp = crossPolyFor();
            if (!cp) continue;
            if (!stealtherCanSee(st, spotter, cp)) continue;
            const maxM = memoSight(spotter);
            const discRadius = (maxM * pxPerUnit) + 40;
            mask.drawCircle(spotter.center.x, spotter.center.y, discRadius);
        }
        /* Cutout holes at every visible token position. Cones
         * don't render inside these circles → tokens appear
         * fully visible with no red tint. Reads `tok.mesh.position`
         * (animated coord) so cutouts track the token during
         * movement. */
        for (const tok of (canvas.tokens?.placeables ?? [])) {
            if (!tok || tok.destroyed) continue;
            if (!tok.visible) continue;
            const tw = Number(tok.w) || 100;
            const th = Number(tok.h) || 100;
            const meshX = Number(tok.mesh?.position?.x);
            const meshY = Number(tok.mesh?.position?.y);
            const cx = Number.isFinite(meshX)
                ? meshX
                : (tok.center?.x ?? (Number(tok.x) + tw / 2));
            const cy = Number.isFinite(meshY)
                ? meshY
                : (tok.center?.y ?? (Number(tok.y) + th / 2));
            /* Cutout radius matches the token's drawn silhouette
             * (0.9× the half-diagonal — inside the visible token
             * ring, not the transparent grid-cell margin). */
            const radius = Math.max(1, Math.min(tw, th) / 2 * 0.9);
            mask.beginHole();
            mask.drawCircle(cx, cy, radius);
            mask.endHole();
        }
        mask.endFill();
        notifyHasContent();
    }
}

/** Hash of everything that affects the MASK GEOMETRY. Mask changes
 *  when: stealther crosses a grid cell (polygon quantization),
 *  spotter moves (reveal disc positions), OR any visible token's
 *  mesh position changes (cutout positions).
 *
 *  Including token mesh positions means the mask WILL rebuild every
 *  frame during animation — but the rebuild is cheap (drawPolygon
 *  on cached polygon + N drawCircle for discs + N beginHole/
 *  drawCircle for cutouts). No sweep polygons. What we save is the
 *  per-frame rebuild in STATIC scenes (hash stable, mask skipped)
 *  and the constant work of the reveal-disc / stealther-polygon
 *  cache lookups.
 *
 *  Positions are rounded to integers because sub-pixel changes
 *  don't matter for cutout circles at token-size radii. */
function computeMaskContentHash(spotters, stealthers) {
    const parts = [];
    const gs = canvas?.grid?.size ?? canvas?.scene?.grid?.size ?? 100;
    for (const st of stealthers) {
        const d = st.document;
        const gx = Math.floor((Number(d.x) || 0) / gs);
        const gy = Math.floor((Number(d.y) || 0) / gs);
        const rot = Math.round((Number(d.rotation) || 0) / 5) * 5;
        parts.push(`t:${st.id}:${gx},${gy},${rot},${d.elevation ?? 0},${d.level ?? ""}`);
    }
    for (const s of spotters) {
        const d = s.document;
        parts.push(`s:${s.id}:${d.x},${d.y},${d.elevation ?? 0},${d.level ?? ""}`);
    }
    /* Visible token mesh positions — affects cutout hole positions.
     * Rounded to integers; anything sub-pixel is imperceptible in a
     * token-sized circle. Iterating placeables is O(N) but the loop
     * body is dead simple.
     *
     */
    const tokens = canvas.tokens?.placeables ?? [];
    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        if (!tok || tok.destroyed || !tok.visible) continue;
        const mx = tok.mesh?.position?.x;
        const my = tok.mesh?.position?.y;
        if (Number.isFinite(mx) && Number.isFinite(my)) {
            parts.push(`c:${tok.id}:${mx|0},${my|0}`);
        }
    }
    return parts.join("|");
}

function computeConeStateHash(spotters, stealthers, controlledIds, view) {
    const parts = [];
    parts.push(`ctrl:${controlledIds.join(",")}`);
    /* Viewport bounds rounded to 100px buckets — panning within a
     * bucket keeps the cache hot (cheap movement), crossing into a
     * new bucket invalidates so newly-visible spotters get cones
     * built. */
    if (view) {
        const bx = Math.floor(view.left / 100), by = Math.floor(view.top / 100);
        const bw = Math.floor((view.right - view.left) / 100);
        const bh = Math.floor((view.bottom - view.top) / 100);
        parts.push(`v:${bx},${by},${bw},${bh}`);
    }
    for (const s of spotters) {
        const d = s.document;
        parts.push(`s:${s.id}:${d.x},${d.y},${d.rotation},${d.sight?.angle ?? ""},${d.sight?.range ?? ""},${d.sight?.visionMode ?? ""},${d.elevation ?? 0},${d.level ?? ""},${d.disposition ?? 0}`);
        /* Passive perception is derived from actor stats; include it
         * so per-zone alpha rebuilds when the spotter's INT /
         * Awareness / mods change (e.g. an active effect fires). */
        parts.push(`sp:${s.id}:${computePassivePerception(s)}`);
        /* Night-vision RANK — cheap (owned race items, no weather call). It
         * decides whether this spotter sees through a sneaker's Dim/Darkness/
         * Pitch tier, so a vision change must rebuild. */
        parts.push(`vr:${s.id}:${visionRank(s.actor)}`);
    }
    /* STEALTHERS: only their level + id matter for cone GEOMETRY —
     * their position does not affect any cone. Foundry V14 mutates
     * `document.x/y` on every animation frame (see token.mjs:2378),
     * so including position here would cache-miss on every rAF and
     * force a full 40-spotter cone rebuild per frame — the exact
     * pathology producing the 24fps drop and the cutout trail. Only
     * hash fields that actually change the CONES: identity + level,
     * Stealth BASE (one half of the pair that sizes the reach), light
     * tier, posture, and accumulated exposure. Notably absent is the
     * sneak's d10 — the cone is sized from bases alone, so a tick's
     * roll never moves the geometry. */
    for (const st of stealthers) {
        /* Bucketed stealther rotation (nearest 10°) so the vision-
         * polygon cache invalidates when the token actually turns to
         * face a new direction — but small in-flight rotation
         * animation frames (V14 mutates document.rotation per tick,
         * see token.mjs:2378) stay within the bucket and don't
         * force a rebuild every frame. 10° is granular enough that
         * a spotter crossing the FOV edge triggers invalidation
         * within one bucket-crossing. */
        const rotBucket = Math.round((Number(st.document?.rotation) || 0) / 10) * 10;
        /* The sneaker's own light TIER (a discrete bucket — changes only when they
         * cross a light boundary, not every animation frame), so a sneaker moving
         * into a torch's ring or from day into shadow rebuilds the danger surface. */
        /* Pace and posture are exposure-model inputs to D, so the cone has to
         * redraw when either changes — otherwise going prone or stopping dead
         * leaves the old, larger cone on screen until something else dirties
         * the hash. Harmless extra fields under the legacy model. */
        const _st8 = getStealthState(st.actor);
        parts.push(`t:${st.id}:${st.document.level ?? ""}:sb${stealthBaseOf(st.actor)}:d${rotBucket}:lt${lightLevelAt(st) ?? ""}`
            /* The live pace CATEGORY, computed exactly as the label computes it.
             *
             * This was the bug stopping the label from updating on a threshold
             * crossing: the hash tracked "did it move recently" and the chosen
             * movement action, neither of which changes when banked distance
             * crosses SPD/2. The hash therefore matched, the fast path re-served
             * the cached container, and the label kept its old word until
             * something unrelated dirtied the overlay. Hash what you draw. */
            + `:pr${st.actor?.statuses?.has?.("prone") ? 1 : 0}`
            /* Exposure drives the suspicion meters, so it has to dirty the
             * hash — otherwise the bars freeze at whatever they were when some
             * unrelated field last changed. Rounded to keep sub-point drift
             * from forcing a rebuild every single tick. */
            + `:ex${Object.entries(_st8?.exposure ?? {}).sort()
                    .map(([k, v]) => `${k.slice(-6)}=${Math.round(Number(v) || 0)}`).join(",")}`);
    }
    /* Lighting signature — cones are clipped to lit areas, so the union must
     * rebuild when the lit region changes: the ambient-lit state (a BOOLEAN, so
     * continuous weather-darkness drift within the global-light range doesn't
     * thrash the cache; it flips only when darkness crosses the scene's global-
     * illumination threshold or the toggle changes) and each active light's
     * position + reach. Light DATA is read (not the live, animated shape) so a
     * flickering light doesn't force a rebuild; genuine moves / toggles /
     * placements still change it. */
    parts.push(`al:${sceneAmbientlyLit() ? 1 : 0}`);
    /* Stage rotation: the eye and pace label counter-rotate against it, so a
     * camera spin must dirty the cache — otherwise the fast path re-attaches
     * containers still holding the previous rotation and the labels lie flat. */
    parts.push(`rot:${Math.round((canvas?.stage?.rotation ?? 0) * 100)}`);
    /* Weather + ambient-darkness TIER — computed ONCE (not per spotter×stealther
     * pair, which would resample the weather engine every animation frame). The
     * `al` boolean above only flips at the global-illumination threshold; this
     * adds the Daylight→Dim→Darkness drift (so day↔night rebuilds) and the
     * weather that dents a spotter's perception (fog/precip/snow/storm). */
    try {
        const wt = getActiveWeather()?.tags ?? {};
        parts.push(`wx:${wt.fog || 0},${wt.precip || 0},${wt.snow || 0},${wt.storm ? 1 : 0}:amb:${ambientLightLevel() ?? ""}`);
    } catch (_) { /* weather not ready */ }
    const lights = canvas?.effects?.lightSources;
    if (lights) {
        for (const src of lights) {
            if (!src?.active) continue;
            const ld = src.data ?? {};
            parts.push(`L:${Math.round(Number(ld.x) || 0)},${Math.round(Number(ld.y) || 0)},${ld.bright ?? 0},${ld.dim ?? 0},${ld.angle ?? 360},${Math.round(Number(ld.rotation) || 0)}`);
        }
    }
    return parts.join("|");
}

/** Full teardown of the overlay — used when the visibility gate
 *  fails. Destroys cached cones + mask so the next enter-stealth
 *  builds fresh. */
function cleanupLayer() {
    _overlayShowing = false;
    if (!_layer || _layer.destroyed) return;
    _layer.removeChildren().forEach(c => { try { c.destroy(); } catch (_) {} });
    _cachedConesContainer = null;
    _cachedMetersContainer = null;
    _cachedMask = null;
    _coneStateHash = "";
    _maskContentHash = "";
    _maskHasContent = false;
    _layer.visible = false;
}

function refresh() {
    const layer = ensureLayer();
    if (!layer || layer.destroyed) return;

    /* No blanket fast-path: the mask has TOKEN CUTOUTS that must
     * track `mesh.position` per animation frame, so the mask hash
     * DOES change every frame during movement. The cheap hash
     * checks below (mask + cone) correctly detect when a rebuild
     * is needed vs. can be skipped. Attempting a coarser fast
     * exit here would skip the mask hash check and leave cutouts
     * trailing behind moving tokens (the immersive-camera lag
     * symptom). */

    if (!shouldShowForCurrentUser()) {
        _overlayShowing = false;
        cleanupLayer();
        return;
    }
    layer.visible = true;
    _overlayShowing = true;

    const stealthers = controlledStealthedTokens();
    const spotters = spottersForOverlay();
    const controlledIds = (canvas?.tokens?.controlled ?? []).map(t => t.id).sort();
    /* Compute viewport bounds ONCE per refresh and thread it through
     * both the cache-invalidation hash and the frustum-culling
     * predicate downstream. */
    const viewBoundsForHash = _getViewportWorldBounds();
    const newConeHash = computeConeStateHash(spotters, stealthers, controlledIds, viewBoundsForHash);

    /* Build the STEALTHER-VISION MASK — ALWAYS rebuilt because it
     * carries the token cutouts, which must track EVERY token's
     * live position (updates per animation frame during moves).
     * This is the cheap part of the refresh.
     *
     * Two components per stealther:
     *  A) Their own same-floor sight polygon (walls at their elev
     *     clip it — normal LOS mask, prevents wallhacks).
     *  B) A REVEAL DISC around each spotter the stealther has
     *     cross-elevation LOS to (per manual raycast). Ensures
     *     upper- / lower-floor spotter cones have canvas area to
     *     render on, even if the stealther's own-floor sight
     *     polygon doesn't reach the spotter's XY (which happens
     *     when the spotter is above a ground-floor wall — sweep
     *     at ground floor is blocked by that wall, so the mask
     *     stops there, and the spotter's cone up top gets clipped
     *     to nothing without this reveal disc). */
    const gridDimForMask = canvas?.dimensions;
    const pxPerUnitForMask = (gridDimForMask?.size || 100) / (gridDimForMask?.distance || 1);

    /* Per-refresh memoization tables. `computeMaxSightMetres` and
     * `getTokenLevel` are pure functions of token state, but they
     * get called from multiple sites in one refresh (mask reveal-
     * disc loop + cone loop). One Map
     * lookup is orders of magnitude cheaper than re-reading actor
     * skill data on every call. */
    const _sightMemo = new Map();
    const _levelMemo = new Map();
    const memoSight = (tok) => {
        if (!tok) return 20;
        if (_sightMemo.has(tok.id)) return _sightMemo.get(tok.id);
        const v = computeMaxSightMetres(tok);
        _sightMemo.set(tok.id, v);
        return v;
    };
    const memoLevel = (tok) => {
        if (!tok) return null;
        if (_levelMemo.has(tok.id)) return _levelMemo.get(tok.id);
        const v = getTokenLevel(tok);
        _levelMemo.set(tok.id, v);
        return v;
    };

    /* Reuse the SAME mask Graphics object across frames. */
    if (!_cachedMask || _cachedMask.destroyed) {
        _cachedMask = new PIXI.Graphics();
        _cachedMask.eventMode = "none";
        _maskContentHash = "";    /* force rebuild since geometry is empty */
    }
    const mask = _cachedMask;

    /* MASK-CONTENT CACHE. Compute a cheap hash of the inputs that
     * affect mask geometry (stealther grid position, spotter
     * positions, levels). If unchanged since last frame we skip
     * the entire draw call sequence — the biggest per-frame cost
     * remaining after cone caching. During stealther movement WITHIN
     * a grid cell, this hash is stable → mask is a no-op per frame. */
    const newMaskHash = computeMaskContentHash(spotters, stealthers);
    if (newMaskHash !== _maskContentHash) {
        mask.clear();
        _maskContentHash = newMaskHash;
        _maskHasContent = false;
        _rebuildMaskInto(mask, stealthers, spotters, memoLevel, memoSight,
                         pxPerUnitForMask, () => { _maskHasContent = true; });
    }

    if (!_maskHasContent) {
        /* No usable vision polygon for any stealther (rare — no
         * sight config + no fallback available). Rather than render
         * unclipped cones and leak information, render NOTHING.
         * Don't destroy the mask — clear() already emptied its
         * geometry and we want to reuse the object on next refresh. */
        cleanupLayer();
        return;
    }

    /* CONE-CACHE HIT PATH: state hash unchanged and we still have
     * the cached cones container. Because the mask Graphics object
     * is STABLE across frames (we just cleared + redrew its geometry
     * above), the container's `.mask` reference is still valid and
     * PIXI's stencil setup doesn't need to be rebuilt. All we do is
     * ensure both are attached to the layer. This is the fast path
     * that must stay cheap during animation. */
    if (newConeHash === _coneStateHash
        && _cachedConesContainer && !_cachedConesContainer.destroyed) {
        if (mask.parent !== layer) layer.addChild(mask);
        if (_cachedConesContainer.parent !== layer) layer.addChild(_cachedConesContainer);
        if (_cachedMetersContainer && !_cachedMetersContainer.destroyed
            && _cachedMetersContainer.parent !== layer) {
            layer.addChild(_cachedMetersContainer);
        }
        return;
    }

    /* CONE-CACHE MISS: state changed since last refresh. Tear down
     * the OLD cones container (children have per-container blur
     * filters + zone sprites; freeing them all together is fastest
     * via `destroy({children:true})`). Do NOT destroy the mask —
     * it's stable and reused. */
    if (_cachedConesContainer && !_cachedConesContainer.destroyed) {
        try { _cachedConesContainer.destroy({ children: true }); } catch (_) {}
        _cachedConesContainer = null;
    }
    if (_cachedMetersContainer && !_cachedMetersContainer.destroyed) {
        try { _cachedMetersContainer.destroy({ children: true }); } catch (_) {}
        _cachedMetersContainer = null;
    }
    if (layer.children.length > 0) layer.removeChildren();
    _coneStateHash = newConeHash;
    layer.addChild(mask);

    /* Soften zone boundaries with a small blur filter on the cone
     * container. Feathers the alpha step between focused / near /
     * far so the tiers read as a gradient instead of three
     * stepped rings. Blur strength kept low (3 px) so the cone
     * shape itself still reads sharply. */
    /* --- moved to bottom, applied after all sprites are added --- */

    /* `coneContainer` holds the whole overlay and is masked by the stealther-
     * vision `mask` (walls LOS + reveal discs − token cutouts) so cones never
     * wallhack. Lighting is handled per-spotter by the spotterCanPerceive gate
     * in the loop (a spotter that can't see in the dark just isn't drawn), not
     * by clipping cone SHAPES — that's more robust than mask geometry. */
    const _cfgAlphaEarly = getStealthConfig();

    const coneContainer = new PIXI.Container();
    coneContainer.eventMode = "none";
    coneContainer.mask = mask;

    /* ── lit-region clip ──────────────────────────────────────────────────
     * A cone drawn across an unlit room claims a watcher can see into a place
     * they cannot. Clip the whole thing to where sight is actually possible:
     * the union of every active light, plus a disc around each watcher for
     * their own dark sight (darkvision or a carried lamp) — otherwise this clip
     * would blind the very creatures that see in the dark.
     *
     * PIXI allows one mask per object, and `coneContainer` already uses the
     * wall-LOS mask, so the clip is applied by NESTING: cones sit inside a
     * container carrying the lit mask. Skipped entirely when the scene is
     * globally lit, where every tile qualifies and the mask would be pure cost.
     */
    const ambientLit = sceneAmbientlyLit();
    let litWrapper = null;
    let litMask = null;
    if (!ambientLit) {
        litMask = new PIXI.Graphics();
        litMask.eventMode = "none";
        litMask.beginFill(0xffffff, 1);
        litWrapper = new PIXI.Container();
        litWrapper.eventMode = "none";
        litWrapper.addChild(litMask);
        litWrapper.addChild(coneContainer);
        litWrapper.mask = litMask;
    }

    /* ONE stencil PER BAND. A boolean stencil doesn't accumulate where cones
     * overlap, so one flat fill through each paints that band at a single
     * uniform alpha — no darker seams where cones cross.
     *
     * Under the exposure model the cone is banded by TIME TO SPOT rather than
     * being one flat catch region. Because `rate = threshold × (1 − d/D)` is
     * monotonic in distance, every rate cut-off is just a fraction of D:
     *
     *     rate ≥ R   ⟺   d ≤ D × (1 − R/threshold)
     *
     * so the bands are nested radii and need no per-tile sampling. Ordered
     * FAINTEST/LARGEST first: they are painted in this order, so the hotter
     * inner bands land on top.
     *
     * Legacy model keeps exactly one band — the 100%-catch region — so its
     * appearance is unchanged. */
    /* Difficulty tiers. These work now, where the old four-band version didn't,
     * for two reasons:
     *
     *   1. The cone no longer contains dice or sneak state, so a band is a
     *      FIXED fraction of a shape that holds still. A patch of floor keeps
     *      the same tier tick after tick, which is what makes it learnable.
     *   2. They are separated by HUE as well as alpha. The previous attempt was
     *      four shades of one red about 0.06 alpha apart, which is invisible
     *      over textured map art — four levels encoded in a channel that
     *      carries two.
     *
     * Each tier is the distance modifier applied to the check inside it, so the
     * colour is telling the player something exact rather than vibes:
     *
     *   amber  outer  0.75–1.00 D   about +3 to your check
     *   orange mid    0.50–0.75 D   about +1
     *   ember  inner  0.25–0.50 D   about −1
     *   red    core   0.00–0.25 D   about −3   (and inside 1 m, no check at all)
     *
     * Ordered outermost first: they are painted in this order so the tighter,
     * hotter tiers land on top. */
    const CONE_BANDS = [
        { key: "outer", frac: 1.00, colour: 0xd8a24c, alpha: 0.10 },
        { key: "mid",   frac: 0.75, colour: 0xe8802c, alpha: 0.16 },
        { key: "inner", frac: 0.50, colour: 0xf0552a, alpha: 0.24 },
        { key: "core",  frac: 0.25, colour: 0xff2020, alpha: 0.34 }
    ];

    /* bandKey → polygons from every spotter, collected during the loop and
     * turned into stencils afterwards. Declared BEFORE the mask loop that fills
     * it — it was declared after, which put every refresh in a temporal dead
     * zone and threw a ReferenceError before a single polygon was drawn. The
     * cone simply stopped existing, with the error swallowed by the ticker's
     * catch. `const` hoists into TDZ, it does not hoist into `undefined`. */
    const bandGeom = {};
    const bandMasks = {};
    for (const b of CONE_BANDS) bandGeom[b.key] = [];
    for (const b of CONE_BANDS) {
        const g = new PIXI.Graphics();
        g.eventMode = "none";
        g.beginFill(0xffffff, 1);
        bandMasks[b.key] = g;
    }
    let anyConeGeom = false;
    /* [{ token, frac, spotted }] — suspicion meters drawn above each watcher
     * after the cone fills, so they sit on top of the wash rather than under it. */
    const meterData = [];
    /* Per-refresh memo for cone reach: light is constant per sneak, weather per
     * watcher, so neither belongs inside the pair loop. */
    const _coneMemo = {
        light: new Map(), weather: new Map(),
        perceive: new Map(), ceiling: new Map(), darkSight: new Map()
    };
    /* Each controlled sneak's stealth state, read ONCE per refresh instead of
     * once per (spotter × sneak). */
    const _meterThreshold = Number(_cfgAlphaEarly.threshold) || 10;
    const _meterStates = stealthers.map(st => ({ uuid: st.actor?.uuid, state: getStealthState(st.actor) }));

    const gridDim   = canvas?.dimensions;
    const pxPerUnit = (gridDim?.size || 100) / (gridDim?.distance || 1);

    /* Config read once per refresh. Cones always render the 100%-catch
     * sub-region only (the sole display mode). Band mods + fractions read once —
     * every spotter needs them for the catch-radius calculation. Ordered from
     * LARGEST band mod (easiest spot) to SMALLEST, matching how band-boundary
     * radii grow (close inside medium inside long …). */
    const _cfgAlpha = _cfgAlphaEarly;
    /* Reuse the viewport bounds already computed for the state hash
     * at the top of refresh() — no need to invoke worldTransform's
     * matrix inversion twice. */
    const viewBounds = viewBoundsForHash;

    /* Pre-build each controlled stealther's own vision polygon (walls
     * + angular sight.angle + rotation), keyed by token id. Reused
     * across every spotter in the loop below — one sweep per
     * stealther per rebuild (not per spotter, not per frame). This is
     * how the "cones only render inside my LOS" rule stays cheap: we
     * pay for one polygon build per stealther, then N × M contains-
     * point checks (N spotters × M stealthers, typically small).
     *
     * Rebuild frequency: only on cone-state-hash miss, which now
     * includes bucketed stealther rotation, so a stealther turning
     * to face a new direction invalidates the cache and cones
     * re-cull. Small angular drift (below the bucket size) stays
     * cache-hot. */
    const _stealtherVisionPolys = new Map();
    for (const st of stealthers) {
        try { _stealtherVisionPolys.set(st.id, buildStealtherVisionPoly(st)); }
        catch (_) { _stealtherVisionPolys.set(st.id, null); }
    }

    /* Reuse the `spotters` list we already built for the state hash
     * instead of calling `spottersForOverlay()` a second time (which
     * would re-scan every token on the scene, re-check dispositions,
     * re-check the spottedBy filter, etc.). */
    for (const spotter of spotters) {
        /* Wallhack + angular-vision gate: only draw cones for spotters
         * that at least one of the viewer's stealthed tokens has both
         * wall LOS to AND has within their angular field of view. */
        if (!anyStealtherSees(spotter, stealthers, _stealtherVisionPolys)) continue;

        /* Suspicion meter, gathered BEFORE the vision gate below.
         *
         * Two reasons it can't live further down. Hearing is deliberately
         * ungated by sight in the mechanics — a watcher blind in the dark still
         * accrues exposure by ear — so gating the eye on `spotterCanPerceive`
         * would hide a meter that is actively filling. And it must precede the
         * already-spotted skip, or the eye blinks out at the exact moment a
         * watcher catches you instead of locking red.
         *
         * The eye reads real exposure, so a watcher who genuinely cannot detect
         * you just shows an empty outline — which is still useful: it says who
         * is in play. */
        /* Don't draw an eye over a watcher the viewer cannot actually see.
         *
         * The eye is anchored in world space over the token, so a watcher hidden
         * behind a wall, out of the viewer's own vision, or GM-hidden still had
         * an eye floating at their position — which both looks wrong and leaks
         * exactly the intelligence stealth is supposed to withhold: where an
         * unseen guard is standing and how suspicious he is. `token.visible` is
         * Foundry's own answer to "can this client see it", so it already
         * accounts for vision, walls and the hidden flag. */
        if (spotter.visible) {
            let worst = 0;
            let seen = false;
            /* `exposure` now stores this watcher's chance of spotting you on the
             * NEXT tick, 0..1 — honest risk rather than progress toward
             * anything, since a failed check spots you outright. Hoisted state:
             * re-reading each sneak's flag per spotter meant N×M getFlag calls
             * per refresh for data that cannot change mid-loop. */
            for (const { uuid: _u, state: st2state } of _meterStates) {
                const ex = Number(st2state?.exposure?.[exposureKey(spotter.actor?.uuid)]) || 0;
                if (ex > worst) worst = ex;
                if (st2state?.spottedBy?.includes?.(spotter.actor?.uuid)) seen = true;
            }
            const thr = Number(_cfgAlpha.threshold) || 10;
            meterData.push({
                token: spotter,
                frac:  seen ? 1 : Math.min(1, worst / thr),
                spotted: seen
            });
        }

        /* Lighting gate: a spotter that can't actually perceive right now
         * (basic vision, standing in darkness with no light; or blindness mode)
         * projects NO cone. Darkvision-class and lit spotters pass. */
        if (!spotterCanPerceive(spotter)) continue;

        /* Cone suppressed for a watcher who already has us (per GM config).
         * Sits AFTER the meter collection above so the eye survives — that
         * ordering is the whole point of tagging rather than filtering. */
        if (spotter.__wdmAlreadySpotted) continue;

        const maxM = memoSight(spotter);
        /* Cone radius spans OUT TO EXTREME RANGE, not just long.
         * Mechanically a spotter can still catch a stealther between
         * long and extreme (extreme band is 1× to `extremeFrac`× the
         * max sight distance, with a −5 penalty), so the overlay
         * needs to visualize that region. Reading extremeFrac from
         * config so a GM who retunes the range bands sees cones
         * that grow / shrink accordingly. */
        /* Upper bound on how far ANY band can be drawn for this watcher.
         *
         * This used to be `computeMaxSightMetres * rangeBandFractions.extreme`
         * — a legacy formula (base 20 + INT + Awareness, doubled ≈ 60 m) reading
         * a config key that no longer exists. The MECHANIC reaches
         * `dBaseMetres * skillClampMax` (80 × 2 = 160 m) in a lit scene, so
         * checks fired far outside the drawn wash. The bound now covers the
         * mechanic's true maximum, and `visionRangeMetres` still caps it in
         * darkness — which is the same cap `coneReachMetres` applies through
         * `sightCeiling`, so the two agree by construction rather than by
         * coincidence. Bands are still clamped to it as a sanity bound; the
         * real shaping is done by `coneReachMetres` per zone below. */
        /* `rangeBandFractions` is a retired config key, so this read always
         * fell back to 2 — a phantom knob that looked tunable and was not.
         * The TERM is still live though: it only loses to `_mechMaxM` under the
         * default ladder (it would need INT + Awareness > 60), and a GM who
         * lowers `dBaseMetres` makes it win. Kept as an explicit constant. */
        const _extremeFrac = 2;
        const _mechMaxM = (Number(_cfgAlpha.dBaseMetres) || 80)
                        * (Number(_cfgAlpha.skillClampMax) || 2);
        /* Cap the cone reach at the spotter's real vision range — in darkness
         * its darkvision (Foundry sight) range — so a 30 m-darkvision spotter's
         * cone stops at 30 m instead of running out to its full mechanical
         * sight. Infinity when the scene is lit (mechanical extreme governs). */
        const coneReachM = Math.min(Math.max(maxM * _extremeFrac, _mechMaxM),
                                    visionRangeMetres(spotter));
        const coneRadiusPx = coneReachM * pxPerUnit;
        if (coneRadiusPx <= 0) continue;

        /* Off-screen? Skip the whole cone build — no point rendering
         * pixels the user can't see. Uses inflated AABB so cones
         * don't pop in exactly at the screen edge. Frustum check uses
         * the full extreme radius so cones near the viewport edge
         * pop in at the right moment. */
        if (!_spotterInFrustum(spotter, coneRadiusPx, viewBounds)) continue;

        const doc = spotter.document;
        const rotation = Number(doc?.rotation) || 0;

        const spotterX = spotter.center?.x ?? 0;
        const spotterY = spotter.center?.y ?? 0;

        /* Zone angles from the shared helper — uses TRUE angle for
         * peripheral boundaries but clips to ALLOWED so equipment
         * (helmet, hood) hides parts of the natural cone without
         * shifting the peripheral bands inward. Zones that collapse
         * to ≤ 0° for narrow-vision spotters just aren't drawn. */
        const { focusedAngle, nearAngle, totalAngle } = computeZoneAngles(spotter);

        {
            /* Per-zone band radii for this watcher: radii[bandKey][zoneKey], px.
             * Cross-sneak union — whichever of my characters is more exposed
             * dictates the warning for that zone. */
            const bandRadii = {};
            for (const b of CONE_BANDS) bandRadii[b.key] = { focused: 0, near: 0, far: 0 };

            /* Cone reach: BASE vs BASE plus the world. No dice, nothing
             * that changes tick to tick — so the shape holds still while
             * the player moves, crouches, or rolls. It is per-PAIR (your
             * Stealth base against this watcher's Awareness base), which is
             * what makes it meaningful without making it volatile. */
            for (const st of stealthers) {
                /* skipZone: every zone is recomputed below, so the sneak's
                 * own zone is never read from this result. */
                const r = coneReachFor(spotter, st, _coneMemo, { skipZone: true });
                if (!r.facts) continue;   /* watcher can't perceive at all */
                for (const zk of ["focused", "near", "far"]) {
                    /* Each zone's reach is computed properly rather than
                     * scaled from the sneak's own zone — the clamps inside
                     * `coneReachMetres` (night ceiling, darkvision floor)
                     * make that ratio invalid, and the cone visibly grew
                     * when the player moved into a watcher's periphery. The
                     * expensive parts (light, weather, zone classification)
                     * are already in `r.facts`; this is pure arithmetic. */
                    const zoneReach = coneReachMetres({ ...r.facts, zoneKey: zk });
                    for (const b of CONE_BANDS) {
                        const rPx = Math.min(zoneReach * (b.frac ?? 1) * pxPerUnit, coneRadiusPx);
                        if (rPx > bandRadii[b.key][zk]) bandRadii[b.key][zk] = rPx;
                    }
                }
            }

            /* Nothing reaches me anywhere for this spotter — skip. The
             * outermost band is the widest, so testing it alone suffices. */
            const outer = bandRadii[CONE_BANDS[0].key];
            if (outer.focused <= 0 && outer.near <= 0 && outer.far <= 0) {
                continue;
            }
            /* Build per-zone polygons at their catch radii — kept as
             * separate polygons because each has a different angular
             * span (focused < near < far angularly). They will be
             * UNIONED at render time via mask-and-fill so the final
             * catch region renders at ONE uniform alpha, not stacked
             * darker where zones overlap. */
            const zoneAngles = {
                far:     totalAngle ?? getAllowedVisionAngle(spotter) ?? 360,
                near:    nearAngle    > 0 ? nearAngle    : null,
                focused: focusedAngle > 0 ? focusedAngle : null
            };
            let drewAny = false;
            for (const b of CONE_BANDS) {
                for (const zk of ["far", "near", "focused"]) {
                    const radius = bandRadii[b.key][zk];
                    const angle  = zoneAngles[zk];
                    if (!angle || radius <= 0) continue;
                    const zp = buildVisionPolygonAtRadius(
                        spotter, radius, { angle, rotation });
                    if (!zp) continue;
                    /* Banked rather than drawn immediately: the stencils are
                     * built after the loop so an inner band can be punched out
                     * of every outer one ACROSS ALL SPOTTERS. Drawing here
                     * would let two overlapping cones paint the same tile twice
                     * and stack their alpha. */
                    bandGeom[b.key].push(zp);
                    drewAny = true;
                }
            }
            if (!drewAny) continue;

            /* Geometry already fed into the per-band stencils above; each is
             * filled once after the loop. Overlaps within a band — across zones
             * AND across spotters — flatten to one wash for that band. */
            anyConeGeom = true;

        }
    }

    /* Each band's stencil is simply its own geometry from every spotter.
     *
     * An attempt to make the bands DISJOINT by punching tighter bands out with
     * `beginHole()` broke rendering entirely: PIXI's triangulation only handles
     * a hole contained within the immediately-preceding shape, and this punches
     * many holes across many polygons per band, which silently yields empty
     * geometry — no cone at all. Flattening the overlap needs a different
     * technique (render-to-texture / cacheAsBitmap), not path holes. */
    for (const b of CONE_BANDS) {
        const g = bandMasks[b.key];
        for (const poly of bandGeom[b.key]) g.drawPolygon(poly);
        g.endFill();
    }

    if (anyConeGeom) {
        /* One flat fill per band, through that band's own stencil (inside the
         * LOS mask). A full-canvas rect clipped by the stencil covers that
         * band's union at a single uniform alpha — overlaps included, no darker
         * seams. Painted in CONE_BANDS order (faintest/largest first), so the
         * hotter inner bands sit on top and the result reads as nested rings
         * of time-to-spot rather than one flat wash. */
        const W = Number(gridDim?.width)  || 100000;
        const H = Number(gridDim?.height) || 100000;
        for (const b of CONE_BANDS) {
            const m = bandMasks[b.key];
            coneContainer.addChild(m);
            const fill = new PIXI.Graphics();
            fill.eventMode = "none";
            fill.beginFill(b.colour ?? CONE_COLOR, b.alpha);
            fill.drawRect(0, 0, W, H);
            fill.endFill();
            fill.mask = m;
            coneContainer.addChild(fill);
        }
    }

    /* ── suspicion meters ──────────────────────────────────────────────
     * A small bar above each watcher, filling as they close in on spotting
     * you. Chat cards are a poor channel for this: they scroll away, they
     * arrive detached from the thing they describe, and reading them means
     * looking away from the map at the exact moment you need to be watching
     * it. The meter puts the information on the watcher it belongs to.
     *
     * Added OUTSIDE `coneContainer` so the LOS mask doesn't clip it — you
     * should be able to see how suspicious a guard is even when a wall corner
     * cuts across his token. */
    if (litMask) {
        /* Every active light's own shape where Foundry exposes one — it already
         * accounts for walls and the light's angle — falling back to a plain
         * disc of its outer radius. */
        const dim = canvas?.dimensions;
        const pxPerUnit = (dim?.size || 100) / (dim?.distance || 1);
        for (const src of (canvas?.effects?.lightSources ?? [])) {
            if (!src?.active) continue;
            const poly = src.shape?.points?.length ? src.shape : null;
            if (poly) { litMask.drawPolygon(poly); continue; }
            const ld = src.data ?? {};
            const r = Math.max(Number(ld.bright) || 0, Number(ld.dim) || 0) * pxPerUnit;
            if (r > 0) litMask.drawCircle(Number(ld.x) || 0, Number(ld.y) || 0, r);
        }
        /* Each watcher's own dark sight, so darkvision and lamp-carriers are not
         * clipped away by the very darkness they can see through. */
        for (const spotter of spotters) {
            const r = darkSightMetres(spotter) * pxPerUnit;
            if (r > 0 && spotter?.center) {
                litMask.drawCircle(spotter.center.x, spotter.center.y, r);
            }
        }
        litMask.endFill();
    }

    layer.addChild(litWrapper ?? coneContainer);
    _cachedConesContainer = litWrapper ?? coneContainer;   /* cache for hash-match reuse */

    if (meterData.length) {
        const meters = new PIXI.Container();
        meters.eventMode = "none";
        for (const { token, frac, spotted } of meterData) {
            /* An eye that opens as the watcher closes in: outline always drawn
             * so you can see WHO is in play even at zero, iris flooding upward
             * as suspicion mounts. Reads at a glance without measuring a bar,
             * and the shape says "being looked at" without a legend.
             *
             * Almond built from two quadratic curves meeting at the corners.
             * The fill is a rect clipped by a copy of that same path — the same
             * stencil-and-fill technique the cone bands use above. */
            const hw = Math.max(11, (token.w || 100) * 0.23);  /* half width  */
            const hh = hw * 0.58;                              /* half height */

            /* Drawn inside a holder pinned to the token centre and counter-
             * rotated against the camera. With the immersive camera the whole
             * stage rotates, so anything drawn in world space rotates with it —
             * the eye orbited off the token's head and ended up sideways or
             * upside-down. Anchoring here and cancelling the stage rotation
             * keeps it upright and directly above the token on screen, whatever
             * the camera is doing. */
            const holder = new PIXI.Container();
            holder.eventMode = "none";
            holder.position.set((token.x ?? 0) + (token.w || 100) / 2,
                                (token.y ?? 0) + (token.h || 100) / 2);
            holder.rotation = -(canvas?.stage?.rotation ?? 0);
            meters.addChild(holder);

            const cx = 0;
            const cy = -((token.h || 100) / 2) - hh - 5;
            const CTRL = hh * 1.95;   /* control offset → almond, not lens */

            const tracePath = (g) => {
                g.moveTo(cx - hw, cy);
                g.quadraticCurveTo(cx, cy - CTRL, cx + hw, cy);
                g.quadraticCurveTo(cx, cy + CTRL, cx - hw, cy);
                g.closePath();
            };

            /* Amber while merely curious, red once they are most of the way
             * there — the colour shift is the warning, so it lands without
             * having to judge how full the eye is. */
            const colour = (spotted || frac >= 0.75) ? 0xff2020
                         : (frac >= 0.4 ? 0xff8c1a : 0xd8a24c);

            /* 1. Dark sclera, so a nearly-empty eye stays legible on bright
             *    terrain and the outline never floats unsupported. */
            const socket = new PIXI.Graphics();
            socket.eventMode = "none";
            socket.beginFill(0x000000, 0.62);
            tracePath(socket);
            socket.endFill();
            holder.addChild(socket);

            /* 2. Iris — rising from the lower lid, bottom to top.
             *
             * The naive version (height = frac × eye height) was invisible at
             * low values: the almond's bottom is a narrow point, so 10% painted
             * a ~1px sliver a few pixels wide and read as an empty eye, and it
             * only reached the wide middle around half full.
             *
             * Fixed by giving the fill a floor rather than by abandoning the
             * bottom-up direction: any non-zero exposure starts at a fifth of
             * the height, which lands in real width, then grows linearly to
             * full. The eye is a "how worried is he" gauge, not a percentage
             * readout — what matters is that the first tick of suspicion is
             * unmistakably different from none, and that it climbs from there. */
            if (frac > 0) {
                const clip = new PIXI.Graphics();
                clip.eventMode = "none";
                clip.beginFill(0xffffff, 1);
                tracePath(clip);
                clip.endFill();

                /* True vertical extent of the almond: a quadratic curve peaks at
                 * half its control offset, so the shape spans cy ± CTRL/2.
                 *
                 * The fill is LINEAR and exact — half full means exactly half
                 * the exposure needed to be spotted. An earlier version floored
                 * it at a fifth so low values stayed visible; that was papering
                 * over the real fault (exposure always read as 0 because of the
                 * dotted-flag-key bug) and it made the gauge lie. With that
                 * fixed, a tick lands 10–50% of the way in typical positions,
                 * so honest values are perfectly legible. */
                const top    = cy - CTRL / 2;
                const height = CTRL;
                const fillH  = height * Math.min(1, Math.max(0, frac));

                const iris = new PIXI.Graphics();
                iris.eventMode = "none";
                iris.beginFill(colour, 0.95);
                iris.drawRect(cx - hw, top + height - fillH, hw * 2, fillH);
                iris.endFill();
                iris.mask = clip;

                holder.addChild(clip);
                holder.addChild(iris);

                /* Pupil once they are properly onto you — the clearest "this
                 * one nearly has you" signal in peripheral vision. */
                if (frac >= 0.5) {
                    const pupil = new PIXI.Graphics();
                    pupil.eventMode = "none";
                    pupil.beginFill(0x120b08, 0.9);
                    pupil.drawCircle(cx, cy, Math.max(1.2, hh * 0.36 * frac));
                    pupil.endFill();
                    holder.addChild(pupil);
                }
            }

            /* 4. Lid outline last, so it sits crisply over iris and pupil. */
            const lid = new PIXI.Graphics();
            lid.eventMode = "none";
            /* A watcher who HAS you keeps a hard red eye on screen for as long
             * as it is true. That persistent mark is what replaces the chat
             * card — the information stays attached to the guard it concerns
             * instead of scrolling away in a log. */
            lid.lineStyle(spotted ? 2 : 1, colour, spotted ? 1 : 0.95);
            tracePath(lid);
            holder.addChild(lid);
        }
        layer.addChild(meters);
        _cachedMetersContainer = meters;
    }



}

/* ─────────── scheduling (PIXI ticker, coalesced) ─────────── */

/* Dirty flag + PIXI ticker callback. Using `requestAnimationFrame`
 * from inside a Foundry token-animation callback (which is itself
 * inside a PIXI ticker tick) defers the rAF to the NEXT browser
 * frame — so our mask cutouts render one frame behind the token
 * position, producing visible lag in the immersive-camera setup
 * where the camera follows the token every tick.
 *
 * PIXI.Ticker.add() with LOW priority runs in the SAME tick, AFTER
 * Foundry's animation callbacks (which sit at NORMAL priority).
 * Dirty flag prevents unnecessary refresh work on ticks where
 * nothing changed. Registered lazily on first schedule, torn down
 * on canvas teardown. */
let _refreshDirty = false;
let _tickerHooked = false;
/* Whether the overlay is currently being shown for this client (i.e. the local
 * user controls a stealthed token). Set inside refresh(). Used to gate the
 * per-animation-frame refreshToken trigger: when the overlay ISN'T showing —
 * the common case for the GM and any non-sneaking player — a token animating
 * shouldn't schedule a refresh at all. Transitions INTO the showing state come
 * exclusively from controlToken / stealth-flag hooks (which scheduleRefresh
 * with a version bump), never from refreshToken, so gating here can't miss the
 * moment the overlay should appear. */
let _overlayShowing = false;
/* Minimum gap between full refreshes, in ms. `refreshToken` fires once per
 * token per animation frame, so a moving party can schedule 60+ refreshes a
 * second. The hash short-circuits the DRAWING, but computing the hash itself
 * samples light at each sneak's tile (5 points) and measures every
 * stealther×spotter pair — real work, sixty times a second, to discover that
 * almost nothing changed.
 *
 * Cones and eyes convey slow-moving information; 10 fps is imperceptible for
 * them and cuts that cost by ~6×. Anything that genuinely must land at once —
 * stealth toggling, config edits, scene changes — calls `forceRefresh()`,
 * which bypasses the throttle. */
const MIN_REFRESH_MS = 100;
let _lastRefreshAt = 0;
let _forceNextRefresh = false;

/** Schedule a refresh that ignores the throttle. For state changes the viewer
 *  must see immediately rather than up to 100 ms later. */
function forceRefresh() {
    _forceNextRefresh = true;
    scheduleRefresh();
}

function _tickCallback() {
    if (!_refreshDirty) return;

    const now = performance.now();
    if (!_forceNextRefresh && (now - _lastRefreshAt) < MIN_REFRESH_MS) {
        /* Stay dirty so the coalesced update lands on a later tick — dropping
         * the flag here would lose the final frame of a movement and leave the
         * overlay stale at the position that actually matters. */
        return;
    }

    _refreshDirty = false;
    _forceNextRefresh = false;
    _lastRefreshAt = now;
    try { refresh(); } catch (err) {
        console.warn(`${SYSTEM_ID} | spotter-vision refresh failed`, err);
    }
}
function _ensureTickerHook() {
    if (_tickerHooked) return;
    const ticker = canvas?.app?.ticker;
    if (!ticker) return;
    /* Priority = LOW + 1. Critical timing constraint:
     *   PIXI.Application.render() is registered at UPDATE_PRIORITY.LOW
     *   (-25) — verified in @pixi/ticker/TickerPlugin.mjs:20. Ticker
     *   runs equal-priority callbacks in REGISTRATION order, and
     *   PIXI Application registers FIRST during canvas construction.
     *   If we register at LOW too, our mask update happens AFTER
     *   PIXI has already drawn the frame → cutouts trail by exactly
     *   one frame (the immersive-camera lag symptom).
     *
     *   Registering at LOW + 1 = -24 puts us ABOVE PIXI's render in
     *   priority ordering, so our mask geometry is updated BEFORE
     *   PIXI reads the display tree for the frame. Still comfortably
     *   AFTER Foundry's OBJECTS priority (23) where mesh.position is
     *   written by the animation pipeline, so we see the current
     *   frame's token positions. Zero-frame lag. */
    const LOW = PIXI?.UPDATE_PRIORITY?.LOW ?? -25;
    ticker.add(_tickCallback, null, LOW + 1);
    _tickerHooked = true;
}
function _teardownTickerHook() {
    if (!_tickerHooked) return;
    try { canvas?.app?.ticker?.remove?.(_tickCallback); } catch (_) {}
    _tickerHooked = false;
}
function scheduleRefresh() {
    _refreshDirty = true;
    _ensureTickerHook();
}

/** Force an immediate refresh, skipping the ticker deferral. Used
 *  from tight-loop update paths that need a synchronous redraw. */
function refreshNow() {
    _refreshDirty = false;
    try { refresh(); } catch (err) {
        console.warn(`${SYSTEM_ID} | spotter-vision immediate refresh failed`, err);
    }
}

/* ─────────── registration ─────────── */

/** Console diagnostic — run `wdmStealthVision()` on the player's
 *  browser console to see why the red cones aren't showing.
 *  Reports layer state, visibility gate, spotter count, per-spotter
 *  polygon build results. */
function _dumpSpotterVisionState() {
    const dump = {};
    dump.user = { id: game.user?.id, name: game.user?.name, isGM: game.user?.isGM };
    dump.canvasReady = !!canvas?.ready;
    dump.layerExists = !!_layer && !_layer.destroyed;
    dump.layerParent = _layer?.parent?.name ?? _layer?.parent?.constructor?.name ?? null;
    dump.layerVisible = _layer?.visible;
    dump.layerChildren = _layer?.children?.length ?? 0;
    dump.shouldShow  = shouldShowForCurrentUser();
    dump.anyStealthActive = anyStealthActive();
    dump.controlledStealthedCount = controlledStealthedTokens().length;
    dump.controlledStealthed = controlledStealthedTokens().map(t => ({ id: t.id, name: t.name, actorId: t.actor?.id }));
    const spotters = spottersForOverlay();
    dump.spotterCount = spotters.length;
    dump.spotters = spotters.map(s => {
        const gridDim = canvas?.dimensions;
        const pxPerUnit = (gridDim?.size || 100) / (gridDim?.distance || 1);
        const coneRadiusPx = computeMaxSightMetres(s) * pxPerUnit;
        const poly = buildVisionPolygonAtRadius(s, coneRadiusPx);
        const lvl = getTokenLevel(s);
        return {
            id: s.id, name: s.name,
            rotation: s.document?.rotation,
            level: lvl?.name ?? lvl?.id ?? null,
            sight: { enabled: s.document?.sight?.enabled, range: s.document?.sight?.range, angle: s.document?.sight?.angle },
            polygonBuilt: !!poly,
            polygonPointCount: poly?.points?.length ?? null
        };
    });
    console.log("%c[WDM] Stealth Spotter Vision Diagnostic", "color:#ff6060;font-weight:bold;", dump);
    /* Force a refresh so the layer's current visible state matches
     * what the dump reported. */
    refresh();
    return dump;
}
try { window.wdmStealthVision = _dumpSpotterVisionState; }
catch (_) { /* non-browser env */ }

/** Cross-level LOS diagnostic. Pass no args to test between the
 *  controlled token and EVERY OTHER token on the scene. Or pass
 *  (spotterId, stealtherId) for a specific pair. Uses the same
 *  level-aware sight polygon the detection engine uses, so results
 *  reflect the ACTUAL rules Foundry V14 applies. */
function _dumpStealthLOS(spotterId, stealtherId) {
    const gridDim = canvas.dimensions;
    const radiusPx = gridDim?.maxR ?? 10000;

    const sightFor = (tok) => {
        const lvl = getTokenLevel(tok);
        if (!lvl) return null;
        return buildSightPolygon(
            { x: tok.center.x, y: tok.center.y,
              elevation: Number(tok.document?.elevation) || 0 },
            lvl,
            { angle: 360, rotation: 0, radius: radiusPx,
              externalRadius: externalRadiusOf(tok) }
        );
    };

    const pairInfo = (viewer, target) => {
        const vLvl = getTokenLevel(viewer);
        const tLvl = getTokenLevel(target);
        const crossOK = canLevelSee(vLvl, tLvl);
        const poly = crossOK ? sightFor(viewer) : null;
        const sameLevel = vLvl?.id === tLvl?.id;
        return {
            viewerLevel: vLvl?.name ?? vLvl?.id ?? null,
            targetLevel: tLvl?.name ?? tLvl?.id ?? null,
            sameLevel,
            crossLevelVisibilityAllowed: crossOK,
            polygonReachesTarget: sameLevel
                ? !!poly?.contains?.(target.center.x, target.center.y)
                : crossOK    /* cross-level = trust visibility.levels */
        };
    };

    /* Two-arg form — one specific pair. */
    if (spotterId && stealtherId) {
        const sp = canvas.tokens?.get(spotterId);
        const st = canvas.tokens?.get(stealtherId);
        if (!sp || !st) { console.log("[WDM LOS] unknown ID"); return; }
        console.log("%c[WDM LOS pair]", "color:#ff6060;font-weight:bold;", {
            spotter:   { id: sp.id, name: sp.name, elev: sp.document.elevation, level: sp.document.level },
            stealther: { id: st.id, name: st.name, elev: st.document.elevation, level: st.document.level },
            spotterCanSeeStealther: pairInfo(sp, st),
            stealtherCanSeeSpotter: pairInfo(st, sp)
        });
        return;
    }

    /* No-arg form — controlled token vs everyone else. */
    const me = canvas.tokens?.controlled?.[0];
    if (!me) { console.log("[WDM LOS] no controlled token"); return; }
    const rows = [];
    for (const other of (canvas.tokens?.placeables ?? [])) {
        if (!other || other.id === me.id) continue;
        rows.push({
            token: other.name,
            id: other.id,
            elev: other.document.elevation,
            level: other.document.level,
            iCanSeeThem: pairInfo(me, other),
            theyCanSeeMe: pairInfo(other, me)
        });
    }
    console.log("%c[WDM LOS] controlled = " + me.name + " (elev " + me.document.elevation + ")",
        "color:#ff6060;font-weight:bold;", rows);
}
try { window.wdmStealthLOS = _dumpStealthLOS; } catch (_) {}

/** Deep diagnostic for "why doesn't this specific spotter's cone show?"
 *  Run with the offending spotter SELECTED (or pass a token ID). Reports
 *  everything that gates cone rendering, in order:
 *    1. spotter.document.level  — Foundry's authoritative level ID
 *    2. resolved SceneLevel doc — what level the token is actually on
 *    3. every stealther on the scene: cross-level visibility from stealther → spotter
 *    4. every wall within the cone bounding box: sight value + level assignment
 *
 *  If your werewolf-by-window has no cone, walk the report top→bottom.
 *  Usually the answer is one of:
 *    - Wall's sight isn't NONE (0). Windows must be sight=NONE.
 *    - stealtherLevel.visibility.levels doesn't include spotter's level.
 *    - Spotter's token.level is the scene default, not the 2nd-floor level. */
function _dumpWhyNoCone(spotterId) {
    const spotter = spotterId
        ? canvas.tokens?.get(spotterId)
        : canvas.tokens?.controlled?.[0];
    if (!spotter) { console.log("[WDM] Select a token or pass an ID"); return; }
    const sLvl = getTokenLevel(spotter);
    const dump = {
        spotter: { id: spotter.id, name: spotter.name,
                   elevation: spotter.document.elevation,
                   rawLevelId: spotter.document.level },
        resolvedLevel: sLvl
            ? { id: sLvl.id, name: sLvl.name, elevation: sLvl.elevation }
            : "NULL — cone will not render",
    };
    /* Cross-level check from every stealthed token. */
    const stealthers = canvas.tokens?.placeables?.filter(t => t?.actor && isStealthed(t.actor)) ?? [];
    dump.stealthersOnScene = stealthers.length;
    dump.crossLevelChecks = stealthers.map(st => {
        const stLvl = getTokenLevel(st);
        return {
            stealther: st.name,
            stealtherLevel: stLvl?.name ?? stLvl?.id,
            spotterLevel:   sLvl?.name  ?? sLvl?.id,
            sameLevel: stLvl?.id === sLvl?.id,
            canSeeSpotterLevel: canLevelSee(stLvl, sLvl),
            stealtherCanSeeSpotterResult: stealtherCanSee(st, spotter, getCachedStealtherVisionPolygon(st))
        };
    });
    /* Walls near the spotter — check what actually applies. */
    const nearRadius = 400;    /* px — a couple grid cells around the token */
    const walls = canvas.walls?.placeables ?? [];
    const cx = spotter.center.x, cy = spotter.center.y;
    const nearby = walls.filter(w => {
        const c = w.document?.c;
        if (!c) return false;
        const midX = (c[0] + c[2]) / 2;
        const midY = (c[1] + c[3]) / 2;
        return Math.hypot(midX - cx, midY - cy) < nearRadius;
    });
    dump.wallsNearSpotter = nearby.map(w => {
        const d = w.document;
        const lvls = d.levels;
        const size = lvls?.size ?? lvls?.length ?? 0;
        const appliesAtSpotterLevel = size === 0
            || (sLvl && (lvls.has?.(sLvl.id) ?? false));
        return {
            wallId: d.id,
            sight: d.sight,
            sightMeaning: d.sight === 0  ? "NONE (always passes)"
                        : d.sight === 10 ? "LIMITED (blocks after 2nd cross)"
                        : d.sight === 20 ? "NORMAL (always blocks)"
                        : d.sight === 30 ? `PROXIMITY (passes when spotter is within threshold ${d.threshold?.sight ?? "?"} scene units)`
                        : d.sight === 40 ? `DISTANCE (passes when spotter is beyond threshold ${d.threshold?.sight ?? "?"} scene units)`
                        : `unknown (${d.sight})`,
            thresholdSight: d.threshold?.sight ?? null,
            door: d.door, doorState: d.ds,
            isOpenDoor: d.ds === 1,
            wallLevels: size === 0 ? "UNIVERSAL (all levels)" : Array.from(lvls),
            appliesAtSpotterLevel,
        };
    });
    console.log("%c[WDM] Why-no-cone diagnostic", "color:#ff8c00;font-weight:bold;", dump);
    return dump;
}
try { window.wdmWhyNoCone = _dumpWhyNoCone; } catch (_) {}

export function registerStealthSpotterVision() {
    /* Rebuild layer + repaint on scene load. Also flush the polygon
     * cache — a new scene has different walls, so every cached
     * sight polygon is stale. */
    Hooks.on("canvasReady", () => {
        _invalidateStealtherPolyCache();
        destroyLayer();
        scheduleRefresh();
    });
    Hooks.on("canvasTearDown", () => {
        _invalidateStealtherPolyCache();
        _teardownTickerHook();
        destroyLayer();
    });

    /* Wall / level / door changes invalidate every cached vision
     * polygon (the sweep is a pure function of wall geometry + the
     * queried point, and any of these can shift the geometry the
     * sweep would clip against). Cheap counter bump — next refresh
     * rebuilds only the polygons that are still active. Also bumps
     * the overall invalidation version so refresh() breaks its
     * fast-path early-exit. */
    const walletChange = () => {
        _invalidateStealtherPolyCache();
        _bumpInvalidation();
        scheduleRefresh();
    };
    Hooks.on("createWall", walletChange);
    Hooks.on("updateWall", walletChange);
    Hooks.on("deleteWall", walletChange);
    Hooks.on("createLevel", walletChange);
    Hooks.on("updateLevel", walletChange);
    Hooks.on("deleteLevel", walletChange);

    /* Token document updates that could affect the overlay. Only
     * committed updates fire (Foundry V14 animation mutates
     * document properties DIRECTLY, no hook per frame). */
    Hooks.on("updateToken", (tokenDoc, changes) => {
        const posChange = changes?.x !== undefined
                       || changes?.y !== undefined
                       || changes?.elevation !== undefined
                       || changes?.level !== undefined;
        const rotChange = changes?.rotation !== undefined;
        const sightChange = changes?.sight !== undefined;

        if (!posChange && !rotChange && !sightChange) return;

        /* Precision-invalidation: rotation of a token that's
         * neither a spotter (stealthed tokens, controlled tokens
         * are excluded from the spotters list) NOR a stealther
         * has zero effect on any cone or mask — skip the version
         * bump so refresh's fast-path exit still works during
         * the user's rotation drag of their own token. Position
         * changes DO affect the mask (reveal disc + stealther
         * polygon) even for the user's own token, so those always
         * bump. */
        if (rotChange && !posChange && !sightChange) {
            const token = canvas?.tokens?.get?.(tokenDoc?.id);
            const isControlled = !!token?.controlled;
            const stealthed = token?.actor && isStealthed(token.actor);
            /* Controlled or stealthed = not in our spotters set;
             * their rotation is a visual/facing change with no cone
             * impact. Skip invalidation entirely for rotation-only
             * commits from these tokens. */
            if (isControlled || stealthed) return;
        }

        _bumpInvalidation();
        scheduleRefresh();
    });

    /* Stealth flag toggled on any actor → visibility gate + the
     * spotter's inclusion in the "already spotted me" list may flip. */
    Hooks.on("updateActor", (_actor, changes) => {
        const stealthChange = changes?.flags?.[SYSTEM_ID]?.stealth;
        if (stealthChange === undefined) return;
        _bumpInvalidation();
        forceRefresh();   /* stealth state changed — show it now, not in 100 ms */
    });

    /* New tokens dropped, or old ones removed — the spotter set
     * itself changed, so drop the fast-path cache. */
    Hooks.on("createToken", () => { _bumpInvalidation(); scheduleRefresh(); });
    Hooks.on("deleteToken", () => { _bumpInvalidation(); scheduleRefresh(); });
    /* Ambient light placed / moved / removed changes the lit region cones are
     * clipped to. (Token-attached lights move via refreshToken; day↔night
     * global-light flips ride the constant gameplay refreshes and the lighting
     * signature in the cone hash.) */
    Hooks.on("createAmbientLight", () => { _bumpInvalidation(); scheduleRefresh(); });
    Hooks.on("updateAmbientLight", () => { _bumpInvalidation(); scheduleRefresh(); });
    Hooks.on("deleteAmbientLight", () => { _bumpInvalidation(); scheduleRefresh(); });
    /* Lighting/darkness changed — day↔night, weather gloom, AND the weather
     * lightning FLASH (which drops darknessLevel for a split second, firing this
     * via canvas.perception refreshLighting). Re-tick so cones appear for the
     * duration the flash makes the scene ambiently lit, then vanish. No version
     * bump — the cone hash's ambient-lit boolean gates the actual rebuild, so a
     * flash costs at most two rebuilds (on and off). */
    Hooks.on("lightingRefresh", scheduleRefresh);
    /* Pan / zoom / rotate — the overlay's screen-facing elements depend on
     * stage rotation and scale. Throttled like everything else. */
    Hooks.on("canvasPan", scheduleRefresh);
    /* Switching crawl/walk/run in the token HUD changes the label with no
     * movement involved, so it needs its own trigger. */
    Hooks.on("updateToken", (_doc, ch) => {
        if (ch?.movementAction !== undefined) forceRefresh();
    });
    /* Time advancing changes the light tier (day↔night) even when the subsystem
     * isn't driving scene darkness — so refresh directly on world-time change too,
     * not only via the lightingRefresh that scene-fx fires. The cone hash carries
     * the per-pair env modifier, so this rebuilds only when a tier actually flips. */
    Hooks.on("updateWorldTime", scheduleRefresh);
    /* Weather changes that DON'T move scene darkness (fog rolling in on a clear
     * day, a manual-weather toggle, a biome/reroll, or the GM editing penalties)
     * still change a spotter's perception — refresh so the cone hash re-reads its
     * cheap weather signature. Only scheduleRefresh (no version bump): the hash
     * gates the actual rebuild, so an unchanged signature costs nothing. */
    Hooks.on("updateScene", scheduleRefresh);
    Hooks.on("wdm:weatherModifiersChanged", scheduleRefresh);
    Hooks.on("updateSetting", (setting) => {
        const k = setting?.key ?? "";
        if (k.startsWith(`${SYSTEM_ID}.weather`) || k === `${SYSTEM_ID}.manualWeather`) scheduleRefresh();
    });
    /* Selection / deselection changes which tokens count as
     * stealthers-in-view. */
    Hooks.on("controlToken",  () => { _bumpInvalidation(); forceRefresh(); });
    /* Panning or zooming changes viewport-relative computations;
     * viewport key inside refresh() catches this without a version
     * bump, but we still need to trigger the refresh call. */
    Hooks.on("canvasPan", scheduleRefresh);
    /* refreshToken fires DURING animation (potentially many times
     * per frame per token). We do NOT bump the invalidation counter
     * here — for the vast majority of refreshToken fires (rotation,
     * hover, target reticle) nothing about the overlay's inputs has
     * changed, and the fast-path in refresh() exits cheaply. Only
     * events that actually mutate the overlay's state bump the
     * counter above.
     *
     * Gated on `_overlayShowing`: the per-frame mask cutout tracking only
     * matters while the overlay is actually visible for this client. When it
     * isn't (GM overview, or any player not currently viewing through a
     * stealthed token — the common case), a token animating shouldn't wake the
     * refresh at all. The overlay can only BECOME visible via controlToken /
     * stealth-flag hooks, which scheduleRefresh on their own, so this never
     * suppresses the appearance transition. */
    Hooks.on("refreshToken", () => { if (_overlayShowing) scheduleRefresh(); });

    /* Stealth config edited — teardown the cached cones (their
     * alpha / hide-when-spotted filter may have changed) and force
     * a rebuild. */
    Hooks.on("wdmStealthConfigChanged", () => {
        try { cleanupLayer(); } catch (_) {}
        _bumpInvalidation();
        forceRefresh();
    });
}
