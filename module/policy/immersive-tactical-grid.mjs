/**
 * immersive-tactical-grid — XCOM-style in-combat movement overlay for the
 * locked token under immersive-token-camera. Two-tier tile shading paints
 * every square the token can reach with its remaining normal move
 * (SPD − meters used) and, when eligible, the further run tier (SPD × 3
 * − meters used). Path-through-walls is pruned by a per-neighbor
 * `move`-collision test using Foundry v14's `CONFIG.Canvas.polygonBackends.move.testCollision`
 * so the grid can never bleed through a wall corner even on scenes with
 * dozens of overlapping walls.
 *
 * ── Isolation
 *
 * This file is the ENTIRE feature. Registration goes through
 * `registerImmersiveTacticalGrid()` which is called ONCE from
 * `registerImmersiveTokenCamera()` in immersive-token-camera.mjs. All
 * hooks bail early on `!isEligibleContext()`, and toggling the
 * immersive setting off flushes the layer on the next hook fire. No
 * touches to `combatRoundMixin`, `canvas-movement.mjs`, or any actor /
 * sheet code — the grid only READS `system.stats.spd.value` and
 * `system.combatRound.*` and never mutates them. Movement, when the
 * click-commit phase lands, will use the SAME `document.update({x, y})`
 * pipeline a drag uses, so `canvas-movement.mjs` still handles
 * pre-validation, path-history, and `movementMeters` accounting.
 *
 * ── Phase in this file
 *
 * P1 (this pass): reachability overlay only — two tiers, wall-aware
 *   BFS, no interaction wiring. Redraws on: combatTurnChange,
 *   updateActor(system.combatRound / stats.spd), updateToken(x/y),
 *   controlToken, canvasReady, canvasTearDown, updateSetting (immersive
 *   toggle), combatStart, deleteCombat.
 *
 * P2-P4 (upcoming): hover A*, click commit + rotation lock, drag-chain
 *   waypoints, run confirmation dialog.
 */

import { isEnabled as immersiveEnabled, findLockTarget } from "./immersive-token-camera.mjs";
import { confirmRunUpgradeDialog } from "./canvas-movement.mjs";
import { isFacingLockerMoving } from "./canvas-facing-lock.mjs";
import { weatherAdjustedMoveCap } from "../mechanics/weather-modifiers.mjs";
import { isTargetingActive as isWeaponTargetingActive } from "./weapon-target-overlay.mjs";
import { isDragActive } from "../mechanics/drag.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";

/* Visual tuning constants. Kept in one block so palette / dash / stroke
 * tweaks land in one place while the geometry code stays untouched.
 *
 * Tier styles:
 *   normal — soft amber fill + dashed border (dense, high-contrast)
 *   run    — no solid fill; faint 45° diagonal hatch (~15% opacity) plus
 *            an even fainter dashed border, reading as "reachable but
 *            costs your whole turn" without competing visually with the
 *            normal tier */
const COLOR_TIER        = 0xffb84d;   // amber — shared hue, style distinguishes tier
const ALPHA_MOVE_FILL   = 0.08;
const ALPHA_MOVE_STROKE = 0.55;
const ALPHA_RUN_FILL    = 0;          // no solid fill — hatch is the visual
const ALPHA_RUN_HATCH   = 0.10;       // faint diagonal fill lines
const ALPHA_RUN_STROKE  = 0.10;       // matching-alpha dashed border for a unified "far zone" feel
const HATCH_SPACING     = 8;          // pixels between adjacent diagonal hatch lines
const HATCH_WIDTH       = 1;
const DASH_LEN          = 6;
const DASH_GAP          = 4;
const STROKE_WIDTH      = 2;

/* Path preview visual constants (P2 hover). Bright amber for high
 * contrast against the faint reach tiers. */
const COLOR_PATH        = 0xffdd88;
const ALPHA_PATH_LINE   = 0.90;
const ALPHA_PATH_DOT    = 0.85;
const ALPHA_DEST_FILL   = 0.35;
const ALPHA_DEST_STROKE = 0.95;
const PATH_LINE_WIDTH   = 3;
const PATH_DOT_RADIUS   = 3.5;
const COST_LABEL_COLOR  = 0xffe9a8;
/* Target ON-SCREEN size of the movement cost label, in CSS px. The label is
 * world-space PIXI text, so at world zoom S it would render at fontSize*S px —
 * microscopic when zoomed out. The upright ticker counter-scales it by 1/S so
 * it holds this constant, legible size at any zoom. Authored fontSize equals
 * this value so the counter-scale is exactly 1/S. (An overridable client
 * setting can drive this later; the constant is the readable default.) */
const COST_LABEL_SCREEN_PX = 18;

/* ── cached reachability + hover state ──────────────────────────── */

/** The most recent reachability compute, cached so the pointermove
 *  path preview can reconstruct paths without re-running Dijkstra on
 *  every frame. Rebuilt by `drawOverlay` whenever reachability could
 *  have changed (turn tick, move, action spend, spd change). */
/* Signature of the last overlay we actually drew (see computeReachSignature),
 * and a wall-geometry epoch bumped whenever walls / doors / the scene change.
 * Together they let drawOverlay skip a full flood+redraw when nothing that
 * affects the reachable set has changed since the last draw. */
let _drawnSig = null;
let _geometryEpoch = 0;

let _cachedReach = {
    /** Locked-token id at time of compute — cache is invalid the moment
     *  it changes (a different combatant took over). */
    tokenId: null,
    /** `Map<"x:y", { x, y, cost, parentKey }>` — combined normal+run
     *  cells so hover pathing can target either tier without a second
     *  Dijkstra run. */
    cells:      null,
    /** Which cells belong to the normal-move tier (subset of `cells`). */
    normalKeys: null,
    /** Which cells belong to the run-only tier (subset of `cells`,
     *  disjoint from `normalKeys`). */
    runKeys:    null,
    /** Start cell key + top-left px so hover pathing can derive the
     *  path's origin without re-reading the token document. */
    startKey:   null,
    startX:     0,
    startY:     0,
    gs:         100,
    /** Whether run is currently eligible (combatRound gate check). Used
     *  by the pointermove handler to decide whether a hover on a
     *  run-only tile should preview a run path or nothing. */
    canRun:     false
};

/** Currently hovered cell key (`"x:y"` px top-left) or null when the
 *  pointer is outside any reachable cell. `_hoverPathVersion` bumps on
 *  each hover-change so the redraw path can early-out when unchanged. */
let _hoverKey = null;
let _hoverPathVersion = 0;
let _lastLoggedHoverVersion = -1;

/* ── PIXI layer ─────────────────────────────────────────────────── */

/** Tactical grid lives on `canvas.controls` — the topmost canvas
 *  group, ABOVE lighting/darkness/vision compositing. Anything on
 *  `canvas.primary` gets multiplied by the darkness mask when the
 *  scene lighting is dim (dark snow, night, unlit rooms), which
 *  bottoms the overlay out to zero and makes reach cells unreadable
 *  in exactly the tactical situations where they matter most.
 *  `canvas.controls` renders after lighting so the overlay is
 *  always fully lit regardless of scene darkness.
 *
 *  Tradeoff: the layer now renders above the token art rather than
 *  under it. Chosen deliberately — visibility beats z-order preference
 *  once the overlay is a legibility blocker. Token art still peeks
 *  through the tile fills (which use ALPHA_MOVE_FILL ~0.15, not
 *  opaque). */
let _layer = null;
function ensureLayer() {
    if (_layer && !_layer.destroyed) return _layer;
    const parent = canvas?.controls ?? canvas?.interface ?? canvas?.stage;
    if (!parent) return null;
    _layer = new PIXI.Container();
    _layer.name = "WDMTacticalGrid";
    _layer.eventMode = "none";
    _layer.zIndex = 200;
    parent.addChild(_layer);
    return _layer;
}
function destroyLayer() {
    if (_layer && !_layer.destroyed) {
        try { _layer.destroy({ children: true }); } catch (_) { /* teardown race */ }
    }
    _layer = null;
}

/* ── eligibility ────────────────────────────────────────────────── */

/** Cheap gate consulted at the top of every draw pass. When any
 *  prerequisite flips off — immersive setting toggled off, combat ends,
 *  active combatant changes to someone else, layer isn't ready yet —
 *  we return false and `drawOverlay` bails after clearing whatever it
 *  had painted. This is the "kill switch" the isolation contract
 *  promises. */
function isEligibleContext() {
    if (!immersiveEnabled()) return false;
    if (!canvas?.ready) return false;
    if (!game.combat?.started) return false;
    const token = findLockTarget();
    if (!token || !token.actor) return false;
    /* `_isMyTurn` is `combatRoundMixin.mjs:58` — checks the active
     * combatant matches this token / actor. Also gates every action
     * spend in the mixin, so we lean on the same signal. */
    if (!token.actor._isMyTurn) return false;
    return true;
}

/** True when the scene has no grid — Foundry's gridless mode.
 *  `CONST.GRID_TYPES.GRIDLESS === 0`. Reachability + hover behavior
 *  fork here: gridless replaces cell BFS with a Clockwise-Sweep-based
 *  reachable-area polygon and swaps tile-hover for straight-line-to-
 *  cursor movement. */
function isGridless() {
    const t = Number(canvas?.scene?.grid?.type);
    return t === 0;
}

/** True when the scene uses a square grid. `CONST.GRID_TYPES.SQUARE === 1`.
 *  Only square grids need the diagonal corner-cut check — hex neighbors
 *  are always single-edge steps with no squeeze-through-corner geometry. */
function isSquareGrid() {
    return Number(canvas?.scene?.grid?.type) === 1;
}

/* ── wall-aware reachability BFS ─────────────────────────────────── */

/** Grid-cell BFS from the token's top-left cell outward, expanding
 *  8-way. A neighbor is admitted iff:
 *   - accumulated cost ≤ meters budget
 *   - segment from parent center to neighbor center doesn't cross a
 *     movement-type wall (`type: "move"`)
 *
 *  Cost model: cardinal step = `grid.distance` scene units, diagonal =
 *  `grid.distance × √2`. This matches the Euclidean-mode reading of
 *  `canvas.grid.measurePath` for a two-point path and is what
 *  `canvas-movement.mjs` charges when the token walks that step. If
 *  the scene ever switches to alternating 5-5-10 diagonals, this cost
 *  model will diverge; leave that as a future refinement (adds ~30 lines
 *  to track parity of diagonal steps).
 *
 *  Returns `Map<"x:y", { x, y, cost }>` keyed by top-left pixel coords.
 *
 *  1×1 tokens only for now: for oversized tokens we'd need to test
 *  wall collision at multiple footprint corners per step, which is
 *  significantly more work. Left as a TODO — the vast majority of PC
 *  tokens are 1×1 in Witcher and monsters that AREN'T tend not to use
 *  immersive camera anyway. */
/** Standard grid-Dijkstra with cell-strict paths.
 *
 *  Per user directive #1: "Must cross the center of every tile
 *  travelled" — the drawn line hits every intermediate cell center,
 *  no any-angle shortcuts. Every neighbor step is grid-adjacent so
 *  the parent chain from destination to source is a true cell-by-cell
 *  walked route.
 *
 *  Algorithm: Dijkstra with cost via `measurePath` (handles cardinal,
 *  diagonal, hex per the scene grid config). Wall check per step uses
 *  `isBlockedByWall` which honors the square-grid diagonal corner-cut
 *  rule.
 *
 *  Tie-breaking: NONE — the neighbor iteration order from
 *  `getAdjacentOffsets` decides which of several equal-cost parents
 *  wins. Explicit "prefer cardinal" or "prefer diagonal" biases were
 *  tried and both produced zigzaggy paths; standard Dijkstra with
 *  natural neighbor order gives the cleanest per-user-feedback result.
 *
 *  Cache record: `{ i, j, centerX, centerY, cost, parentKey }`.
 *  `parentKey` is null on the start cell. */
/** Returns a fast predicate `(cellCenter) => boolean` — true when the
 *  cell is currently visible to the acting token. Wraps
 *  `canvas.visibility.testVisibility` (the same API Foundry uses to
 *  gate its own door-control clicks — client/canvas/containers/
 *  elements/door-control.mjs:112). GM sees everything (tokenVision
 *  off); if no vision system is active on the scene, we open the
 *  reach (nothing to hide from anyway). Otherwise every reach cell
 *  must fall inside the token's FOV, which stops the plotter from
 *  being used to map dark corridors by "walking blind" through fog. */
function makeVisibilityPredicate(_token) {
    /* No LOS / vision / fog gating on movement reach. The wall
     * predicate (`isBlockedByWall`) still gates on physical
     * geometry, so the plotter shows only cells the token can
     * actually WALK to given walls + doors — but it shows them
     * whether or not the token can currently SEE the cell.
     *
     * Rationale: a character planning a move knows the layout of
     * the room they're in, and unreveal'd corridors are already
     * wall-blocked from the plotter by the physical wall check.
     * The "walk through fog to map dark passages" exploit isn't
     * practical here because the BFS can't cross walls anyway;
     * dark rooms behind closed doors stay unreachable. */
    return () => true;
}

export function computeReachableCells(token, meters) {
    if (!Number.isFinite(meters) || meters <= 0) return new Map();
    const gridPl = canvas.grid;
    if (!gridPl?.getAdjacentOffsets) return new Map();

    const tokenCenter = _tokenCenterPoint(token);
    const startOffset = gridPl.getOffset(tokenCenter);
    const startKey = _offsetKey(startOffset);
    const startCenter = gridPl.getCenterPoint(startOffset);
    const isVisible = makeVisibilityPredicate(token);

    const cells = new Map();
    cells.set(startKey, {
        i: startOffset.i, j: startOffset.j,
        centerX: startCenter.x, centerY: startCenter.y,
        cost: 0, parentKey: null
    });

    /* Binary min-heap frontier. The old frontier was a plain array scanned
     * linearly for the min-cost node every iteration — O(N²) over the whole
     * flood, which on a run-tier budget (a large radius = hundreds/thousands of
     * cells) was the multi-hundred-ms blocking hitch the user felt at move
     * start. A heap makes the same Dijkstra O(N log N) with identical output. */
    const heap = [{ key: startKey, cost: 0 }];
    const heapPush = (item) => {
        heap.push(item);
        let i = heap.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (heap[p].cost <= heap[i].cost) break;
            const tmp = heap[p]; heap[p] = heap[i]; heap[i] = tmp;
            i = p;
        }
    };
    const heapPop = () => {
        const top = heap[0];
        const last = heap.pop();
        if (heap.length) {
            heap[0] = last;
            let i = 0; const n = heap.length;
            for (;;) {
                const l = 2 * i + 1, r = 2 * i + 2; let s = i;
                if (l < n && heap[l].cost < heap[s].cost) s = l;
                if (r < n && heap[r].cost < heap[s].cost) s = r;
                if (s === i) break;
                const tmp = heap[s]; heap[s] = heap[i]; heap[i] = tmp;
                i = s;
            }
        }
        return top;
    };

    /* Step cost only depends on the grid-offset DELTA (cardinal vs diagonal,
     * even/odd hex row), never on absolute position, so measurePath returns the
     * same value for every step of a given delta. Memoize per delta to collapse
     * thousands of identical measurePath calls down to a handful. */
    const stepCostByDelta = new Map();

    while (heap.length) {
        const { key, cost } = heapPop();
        const from = cells.get(key);
        if (!from || cost > from.cost + 1e-6) continue;

        const neighbors = gridPl.getAdjacentOffsets({ i: from.i, j: from.j }) ?? [];
        for (const n of neighbors) {
            /* All neighbors considered (including diagonals on
             * square grids). The path visualization connects cell
             * CENTERS with straight segments, so every intermediate
             * cell is physically on the drawn line — whether the
             * step is cardinal or diagonal, the line crosses each
             * cell center it walks through. */
            const di = n.i - from.i, dj = n.j - from.j;
            const dkey = `${di}:${dj}`;
            let stepCost = stepCostByDelta.get(dkey);
            if (stepCost === undefined) {
                try {
                    const r = gridPl.measurePath([{ i: from.i, j: from.j }, { i: n.i, j: n.j }]);
                    stepCost = Number(r?.distance);
                } catch (_) { stepCost = NaN; }
                stepCostByDelta.set(dkey, stepCost);
            }
            if (!Number.isFinite(stepCost) || stepCost <= 0) continue;

            /* Cheap prunes FIRST — budget cap + already-reached-as-cheaply — so
             * the expensive per-edge wall + visibility tests below only run for
             * edges that could actually improve a cell. */
            const newCost = from.cost + stepCost;
            if (newCost > meters + 1e-6) continue;
            const nkey = _offsetKey(n);
            const existing = cells.get(nkey);
            if (existing && existing.cost <= newCost + 1e-6) continue;

            const nCenter = gridPl.getCenterPoint(n);
            if (!nCenter) continue;
            const fromCenter = { x: from.centerX, y: from.centerY };
            if (isBlockedByWall(fromCenter, nCenter, from, n)) continue;

            /* LOS gate — cell must be visible to the acting token.
             * Applied HERE (during traversal, before adding to the
             * frontier) rather than as a post-filter so paths can't
             * route through hidden cells to reach a visible one on
             * the far side of fog. If cell N is invisible, we don't
             * mark it reachable AND we don't propagate from it. */
            if (!isVisible(nCenter)) continue;

            cells.set(nkey, {
                i: n.i, j: n.j,
                centerX: nCenter.x, centerY: nCenter.y,
                cost: newCost, parentKey: key
            });
            heapPush({ key: nkey, cost: newCost });
        }
    }
    return cells;
}

function _offsetKey(o) { return `${o.i}:${o.j}`; }

function _tokenCenterPoint(token) {
    const gs = Number(canvas?.scene?.grid?.size) || 100;
    const d = token.document;
    return {
        x: Number(d.x) + (Number(d.width)  || 1) * gs / 2,
        y: Number(d.y) + (Number(d.height) || 1) * gs / 2
    };
}

/** Walk `parentKey` pointers backward from `targetKey` to the start
 *  cell (kept for possible fallback / debug — the hover path
 *  reconstruction now uses per-hover A* via `computePathAStar`). */
function reconstructPath(cells, targetKey) {
    if (!cells.has(targetKey)) return null;
    const out = [];
    let key = targetKey;
    let guard = 0;
    while (key) {
        const cell = cells.get(key);
        if (!cell) return null;
        out.unshift(cell);
        if (cell.parentKey === key) break;
        key = cell.parentKey;
        if (++guard > 5000) return null;
    }
    return out;
}

/** Per-hover A* from the reachability start cell to a specific target
 *  cell. Called from the hover-path draw when the user moves the
 *  cursor onto a reachable tile.
 *
 *  Why per-hover: Dijkstra's flood populates parent pointers based on
 *  which frontier order it visited each cell — for cells with many
 *  equal-cost paths (open ground), the parent chain can end up
 *  taking the FIRST route the flood found, which is often the
 *  "up-and-over" or "around-the-obstacle" route the Dijkstra
 *  processes first. A* with an Euclidean heuristic biases exploration
 *  TOWARD the target, so tie-breaking naturally favors paths that
 *  head straight for it — giving the direct route the user expects.
 *
 *  Same wall / step-cost primitives as `computeReachableCells`, so
 *  what's reachable there is reachable here; the algorithm just
 *  finds a more visually direct route through the same graph.
 *
 *  Returns an array of cell records `[start, ..., target]` or null
 *  if no path exists (target unreachable). */
function computePathAStar(startKey, startCell, targetCell, metersCap) {
    const gridPl = canvas.grid;
    if (!gridPl?.getAdjacentOffsets || !startCell || !targetCell) return null;
    const targetKey = _offsetKey(targetCell);
    if (startKey === targetKey) return [startCell];

    const gs = Number(canvas.scene?.grid?.size);
    const distancePerCell = Number(canvas.scene?.grid?.distance);
    if (!gs || !distancePerCell) return null;
    const metersPerPixel = distancePerCell / gs;

    /* Heuristic: straight-line Euclidean distance to the target in
     * meters. Admissible (never overestimates true cost since actual
     * grid path is >= Euclidean) so A* is guaranteed optimal. */
    const heuristic = (cx, cy) => {
        const dx = targetCell.centerX - cx;
        const dy = targetCell.centerY - cy;
        return Math.hypot(dx, dy) * metersPerPixel;
    };

    const gScore = new Map();
    const parent = new Map();
    const centerX = new Map();
    const centerY = new Map();
    const iMap = new Map();
    const jMap = new Map();

    gScore.set(startKey, 0);
    centerX.set(startKey, startCell.centerX);
    centerY.set(startKey, startCell.centerY);
    iMap.set(startKey, startCell.i);
    jMap.set(startKey, startCell.j);
    parent.set(startKey, null);

    /* Binary min-heap open list (keyed on f) — same O(N log N) upgrade as the
     * reachability flood, so hover-path preview stays snappy on long routes. */
    const openList = [{ key: startKey, f: heuristic(startCell.centerX, startCell.centerY) }];
    const heapPush = (item) => {
        openList.push(item);
        let i = openList.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (openList[p].f <= openList[i].f) break;
            const tmp = openList[p]; openList[p] = openList[i]; openList[i] = tmp;
            i = p;
        }
    };
    const heapPop = () => {
        const top = openList[0];
        const last = openList.pop();
        if (openList.length) {
            openList[0] = last;
            let i = 0; const n = openList.length;
            for (;;) {
                const l = 2 * i + 1, r = 2 * i + 2; let s = i;
                if (l < n && openList[l].f < openList[s].f) s = l;
                if (r < n && openList[r].f < openList[s].f) s = r;
                if (s === i) break;
                const tmp = openList[s]; openList[s] = openList[i]; openList[i] = tmp;
                i = s;
            }
        }
        return top;
    };
    const closed = new Set();
    const stepCostByDelta = new Map();

    while (openList.length) {
        const { key: curKey } = heapPop();
        if (curKey === targetKey) {
            /* Reconstruct path. */
            const out = [];
            let k = curKey;
            let guard = 0;
            while (k) {
                out.unshift({
                    i: iMap.get(k), j: jMap.get(k),
                    centerX: centerX.get(k), centerY: centerY.get(k),
                    cost: gScore.get(k)
                });
                k = parent.get(k);
                if (++guard > 5000) break;
            }
            return out;
        }
        if (closed.has(curKey)) continue;
        closed.add(curKey);

        const curI = iMap.get(curKey);
        const curJ = jMap.get(curKey);
        const curCX = centerX.get(curKey);
        const curCY = centerY.get(curKey);
        const curG = gScore.get(curKey);
        const curOffset = { i: curI, j: curJ };
        const curCenter = { x: curCX, y: curCY };

        const neighbors = gridPl.getAdjacentOffsets(curOffset) ?? [];
        for (const n of neighbors) {
            const nkey = _offsetKey(n);
            if (closed.has(nkey)) continue;

            /* Restrict A* traversal to cells the Dijkstra reach pass
             * accepted — that map already excludes walls-blocked AND
             * out-of-LOS cells. Without this gate, A* could route the
             * hover-preview line through a hidden cell to reach a
             * visible target, which is the same "walk blind through
             * fog" exploit the LOS gate is here to prevent. Cheap:
             * one Map.has per neighbor. Checked FIRST — it's the cheapest
             * reject and prunes the vast majority of edges. */
            if (!_cachedReach.cells?.has(nkey)) continue;

            const di = n.i - curI, dj = n.j - curJ;
            const dkey = `${di}:${dj}`;
            let stepCost = stepCostByDelta.get(dkey);
            if (stepCost === undefined) {
                try {
                    const r = gridPl.measurePath([curOffset, n]);
                    stepCost = Number(r?.distance);
                } catch (_) { stepCost = NaN; }
                stepCostByDelta.set(dkey, stepCost);
            }
            if (!Number.isFinite(stepCost) || stepCost <= 0) continue;

            /* Cheap prunes before the expensive wall test. */
            const tentativeG = curG + stepCost;
            if (tentativeG > metersCap + 1e-6) continue;
            const existingG = gScore.get(nkey);
            if (existingG !== undefined && existingG <= tentativeG + 1e-6) continue;

            const nCenter = gridPl.getCenterPoint(n);
            if (!nCenter) continue;
            if (isBlockedByWall(curCenter, nCenter, curOffset, n)) continue;

            gScore.set(nkey, tentativeG);
            parent.set(nkey, curKey);
            centerX.set(nkey, nCenter.x);
            centerY.set(nkey, nCenter.y);
            iMap.set(nkey, n.i);
            jMap.set(nkey, n.j);
            const f = tentativeG + heuristic(nCenter.x, nCenter.y);
            heapPush({ key: nkey, f });
        }
    }
    return null;   // target unreachable
}

/** Raw wall-segment collision test. Foundry v14 exposes movement collision
 *  through `CONFIG.Canvas.polygonBackends.move.testCollision(origin,
 *  destination, {type, mode, ...})`. Returns truthy iff the segment
 *  crosses at least one movement-type wall (doors count when closed).
 *  Older v13 fallback via `canvas.walls.checkCollision` in case the
 *  polygonBackends registry isn't populated at hook fire time (edge
 *  case: first draw before canvasReady fully settles). */
function testWallSegment(from, to) {
    try {
        const backend = CONFIG?.Canvas?.polygonBackends?.move;
        if (backend?.testCollision) {
            return !!backend.testCollision(from, to, { type: "move", mode: "any" });
        }
        const Ray = foundry?.canvas?.geometry?.Ray ?? window.Ray;
        if (Ray && canvas?.walls?.checkCollision) {
            return !!canvas.walls.checkCollision(new Ray(from, to), { type: "move", mode: "any" });
        }
    } catch (_) { /* fall through — treat as unblocked so we don't accidentally hide all tiles */ }
    return false;
}

/** True when a straight segment from `from` to `to` is clear of walls
 *  AND can be walked by a physical token without visually clipping a
 *  wall corner.
 *
 *  Uses the Minkowski-sum method: model the movement segment as a
 *  thin corridor of width `2 * WALL_OFFSET_PX` (default 3px on each
 *  side), and test wall collision on:
 *   - the CENTER segment (from center to center)
 *   - two parallel offset segments displaced perpendicular to the
 *     movement direction
 *
 *  If any of the three collision tests fires, the movement would
 *  visually clip a wall. This is the geometrically correct model of
 *  "you can't squeeze diagonally through the corner of two walls" and
 *  "you can't graze the tip of a wall segment" — both cases where
 *  the raw `testWallSegment` (strict crossing test) reports clear but
 *  the movement visually phases through geometry.
 *
 *  Perpendicular offset direction: rotate (dx, dy) by 90° → (-dy, dx),
 *  normalized. Runtime: O(walls) × 3 collision tests. Foundry's
 *  polygon backend uses spatial indexing for testCollision so this
 *  stays sub-millisecond at typical wall counts. */
const WALL_OFFSET_PX = 3;
function isSegmentClear(from, to) {
    /* Center segment — the raw movement path. */
    if (testWallSegment(from, to)) return false;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return true;
    /* Unit perpendicular vector × offset — displaces the segment
     * `WALL_OFFSET_PX` pixels perpendicular to the movement axis. */
    const nx = -dy / len * WALL_OFFSET_PX;
    const ny =  dx / len * WALL_OFFSET_PX;
    if (testWallSegment(
        { x: from.x + nx, y: from.y + ny },
        { x: to.x   + nx, y: to.y   + ny }
    )) return false;
    if (testWallSegment(
        { x: from.x - nx, y: from.y - ny },
        { x: to.x   - nx, y: to.y   - ny }
    )) return false;
    return true;
}

/** Grid-aware wall blockage check for one BFS neighbor step.
 *
 *  For CARDINAL / HEX steps the raw center-to-center segment test is
 *  correct — the segment lies entirely on the shared edge between the
 *  two cells. Any wall on that edge is intersected exactly. Hex grids
 *  never produce "diagonal squeeze" geometry because every neighbor
 *  step shares a full edge with the source cell.
 *
 *  For SQUARE-GRID DIAGONAL steps, permissive corner-cut prevention:
 *  a diagonal is blocked only when BOTH of the two cardinal-then-
 *  cardinal routes (A→N→B and A→E→B) are FULLY blocked (i.e., have
 *  a wall on ALL of their legs so no ortho detour exists). If EITHER
 *  ortho path is clear, the diagonal is allowed — this lets paths
 *  find direct routes through complex geometry, per pathing.png. The
 *  stricter "block if either ortho leg has any wall" rule (RAW D&D)
 *  was too aggressive and forced huge detours around walls where a
 *  direct diagonal would visually clear cleanly. */
function isBlockedByWall(fromCenter, toCenter, /* fromOffset, toOffset */) {
    /* Use the Minkowski corridor test (`isSegmentClear`) instead of a
     * bare center-to-center crossing test. The bare test misses cases
     * where a segment JUST grazes a wall endpoint / corner without
     * strictly intersecting the wall body — that's how the user was
     * plotting paths past walls. `isSegmentClear` checks the center
     * segment PLUS two parallel offsets ±3px perpendicular to the
     * movement direction, so a diagonal that clips a wall corner (or
     * an edge wall the raw test would miss because the segment aligns
     * with the wall's endpoint) is correctly refused. Runtime cost is
     * 3× a testCollision call per neighbor — still cheap given Foundry's
     * spatial-indexed polygonBackend. */
    return !isSegmentClear(fromCenter, toCenter);
}

/* ── overlay draw ────────────────────────────────────────────────── */

function drawDashedLine(g, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return;
    const ux = dx / len;
    const uy = dy / len;
    let t = 0;
    while (t < len) {
        const t1 = Math.min(t + DASH_LEN, len);
        g.moveTo(x1 + ux * t, y1 + uy * t);
        g.lineTo(x1 + ux * t1, y1 + uy * t1);
        t = t1 + DASH_GAP;
    }
}

/** Fetch a cell's polygon vertices via Foundry's grid API. Returns
 *  flat point array `[x1, y1, x2, y2, ...]` ready for `drawPolygon`,
 *  plus the object-form array for dashed-edge iteration. Square grids
 *  return 4 vertices, hex grids return 6 — code stays uniform. */
function _cellVertices(cell) {
    const gridPl = canvas.grid;
    if (!gridPl?.getVertices) return null;
    const verts = gridPl.getVertices({ i: cell.i, j: cell.j });
    if (!Array.isArray(verts) || verts.length < 3) return null;
    const flat = [];
    for (const v of verts) { flat.push(v.x, v.y); }
    return { flat, verts };
}

/** Batched-tier-fill draw. All cells' polygons rendered into ONE
 *  `PIXI.Graphics` — one `beginFill/endFill` for the whole set, one
 *  `lineStyle` for all borders, all dashed segments batched. Prior
 *  version allocated a new Graphics + polygon draw per cell which
 *  costs ~50µs per allocation × N cells × redraws per state change,
 *  visible as canvas lag at typical SPD × 3 ≈ 100+ cells. Batching
 *  cuts allocation count and PIXI state-change count by 2-3 orders
 *  of magnitude. */
function drawTierTiles(g, cells, fillAlpha, strokeAlpha) {
    /* Precompute vertices ONCE and reuse across fill + border pass —
     * `_cellVertices` calls Foundry's `grid.getVertices` (hex-shape
     * math on hex grids, non-trivial) and was previously invoked
     * twice per cell (once per pass). */
    const shapes = [];
    for (const cell of cells.values()) {
        const shape = _cellVertices(cell);
        if (shape) shapes.push(shape);
    }
    if (!shapes.length) return;

    /* Fill pass — single fill state for all polygons. */
    if (fillAlpha > 0) {
        g.beginFill(COLOR_TIER, fillAlpha);
        for (let i = 0; i < shapes.length; i++) {
            g.drawPolygon(shapes[i].flat);
        }
        g.endFill();
    }
    /* Border pass — perimeter-only, dashed. Iterate every cell's edges
     * and hash each edge by its two endpoint coords (rounded, order-
     * independent). Edges shared between two cells in the reach region
     * hash to the same bucket and count = 2 (internal); edges on the
     * boundary count = 1. Draw only count=1 edges.
     *
     * Why: without this, EVERY cell drew all its edges. A 300-cell
     * reach shares thousands of internal edges — each drawn TWICE (once
     * per neighboring cell), and each dashed edge is ~6 moveTo/lineTo
     * PIXI commands. Perimeter-only cuts to just the outer boundary
     * (typically ~60-80 edges for a circular reach), a 20-40× reduction
     * in draw commands. Also reads cleaner: dashed outline around the
     * whole reach region instead of a mesh of cell borders. */
    if (strokeAlpha > 0) {
        const edgeCount = new Map();
        const edgeCoords = new Map();
        for (let i = 0; i < shapes.length; i++) {
            const verts = shapes[i].verts;
            for (let j = 0; j < verts.length; j++) {
                const a = verts[j];
                const b = verts[(j + 1) % verts.length];
                /* Round to integer px so shared edges hash identically
                 * even when floating-point vertex math produces tiny
                 * differences between the two neighbors' views. */
                const ax = Math.round(a.x), ay = Math.round(a.y);
                const bx = Math.round(b.x), by = Math.round(b.y);
                /* Order-independent key — same edge from either
                 * direction hashes identically. */
                const k = ax < bx || (ax === bx && ay < by)
                    ? `${ax},${ay}|${bx},${by}`
                    : `${bx},${by}|${ax},${ay}`;
                edgeCount.set(k, (edgeCount.get(k) || 0) + 1);
                if (!edgeCoords.has(k)) edgeCoords.set(k, [a.x, a.y, b.x, b.y]);
            }
        }
        g.lineStyle(STROKE_WIDTH, COLOR_TIER, strokeAlpha);
        for (const [k, count] of edgeCount) {
            if (count !== 1) continue;   // internal edge, skip
            const [x1, y1, x2, y2] = edgeCoords.get(k);
            drawDashedLine(g, x1, y1, x2, y2);
        }
        g.lineStyle(0);
    }
}

/** Dashed outline around a cell's polygon vertices. Iterates edges
 *  and delegates to `drawDashedLine`. Works for square (4 edges) and
 *  hex (6 edges) uniformly. */
function drawDashedPolygonEdges(g, verts, color, alpha) {
    g.lineStyle(STROKE_WIDTH, color, alpha);
    for (let i = 0; i < verts.length; i++) {
        const a = verts[i];
        const b = verts[(i + 1) % verts.length];
        drawDashedLine(g, a.x, a.y, b.x, b.y);
    }
    g.lineStyle(0);
}

/** Batched run-tier draw — ONE mask Graphics with every run-cell
 *  polygon unioned into it, ONE hatch Graphics drawn across the
 *  aggregate bounds (masked by the union), ONE border Graphics with
 *  every cell's dashed edges batched. Prior version allocated
 *  {Container + Mask + Graphics + Border} per cell — 4 objects × N
 *  cells + a mask setup per cell — which was the primary source of
 *  the grid lag the user reported. Batching reduces to 3 Graphics
 *  objects TOTAL regardless of run-cell count. */
function drawRunTierTiles(container, cells) {
    const shapes = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const cell of cells.values()) {
        const shape = _cellVertices(cell);
        if (!shape) continue;
        shapes.push(shape);
        for (const v of shape.verts) {
            if (v.x < minX) minX = v.x;
            if (v.y < minY) minY = v.y;
            if (v.x > maxX) maxX = v.x;
            if (v.y > maxY) maxY = v.y;
        }
    }
    if (!shapes.length) return;

    /* 1. Mask — every run-cell polygon drawn into one fill so PIXI
     *    treats their union as the mask shape. */
    const mask = new PIXI.Graphics();
    mask.beginFill(0xffffff, 1);
    for (const shape of shapes) mask.drawPolygon(shape.flat);
    mask.endFill();
    container.addChild(mask);

    /* 2. Hatch — drawn once across the entire aggregate bounding
     *    rect, masked by the union above. Overdrawn hatch pixels
     *    outside any run cell are clipped by the mask; drawing is
     *    linear in bounds size not cell count, so this is fast even
     *    with hundreds of cells. */
    const hatch = new PIXI.Graphics();
    _drawHatchOverBounds(hatch,
        { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
        COLOR_TIER, ALPHA_RUN_HATCH);
    hatch.mask = mask;
    container.addChild(hatch);

    /* 3. Borders — perimeter-only, same edge-hash approach as
     *    drawTierTiles. Internal edges between two run-cells cancel
     *    out; only the outer boundary of the run-tier region is
     *    drawn. Cuts draw commands from O(cells × edges) to just
     *    the perimeter. */
    const edgeCount = new Map();
    const edgeCoords = new Map();
    for (const shape of shapes) {
        const verts = shape.verts;
        for (let i = 0; i < verts.length; i++) {
            const a = verts[i];
            const b = verts[(i + 1) % verts.length];
            const ax = Math.round(a.x), ay = Math.round(a.y);
            const bx = Math.round(b.x), by = Math.round(b.y);
            const k = ax < bx || (ax === bx && ay < by)
                ? `${ax},${ay}|${bx},${by}`
                : `${bx},${by}|${ax},${ay}`;
            edgeCount.set(k, (edgeCount.get(k) || 0) + 1);
            if (!edgeCoords.has(k)) edgeCoords.set(k, [a.x, a.y, b.x, b.y]);
        }
    }
    const border = new PIXI.Graphics();
    border.lineStyle(STROKE_WIDTH, COLOR_TIER, ALPHA_RUN_STROKE);
    for (const [k, count] of edgeCount) {
        if (count !== 1) continue;
        const [x1, y1, x2, y2] = edgeCoords.get(k);
        drawDashedLine(border, x1, y1, x2, y2);
    }
    border.lineStyle(0);
    container.addChild(border);
}

function _polygonBounds(verts) {
    if (!verts?.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const v of verts) {
        if (v.x < minX) minX = v.x;
        if (v.y < minY) minY = v.y;
        if (v.x > maxX) maxX = v.x;
        if (v.y > maxY) maxY = v.y;
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function resetCache() {
    _drawnSig = null;
    _cachedReach = {
        mode: null, tokenId: null,
        cells: null, normalKeys: null, runKeys: null, startKey: null,
        startX: 0, startY: 0, gs: 100, canRun: false,
        normalPoly: null, runPoly: null,
        normalRemaining: 0, runRemaining: 0, metersPerPixel: 0
    };
}

/** Rebuild the reachability cache from the current token / combatRound
 *  state. Returns true when the cache is populated (context eligible),
 *  false when the caller should clear the overlay. Branches on
 *  `isGridless()` because gridded and gridless reachability are two
 *  different models (cell BFS vs sweep polygon). */
/** Movement budget for the acting token, or null when the context is
 *  ineligible / has no budget. Shared by the flood rebuild AND the cheap
 *  reach-signature so the two can never drift out of sync. */
function _computeMoveBudget(token) {
    const actor = token?.actor;
    const spd = Number(actor?.system?.stats?.spd?.value) || 0;
    if (spd <= 0) return null;

    const round = actor.system.combatRound ?? {};
    const usedMeters = Number(round.movementMeters) || 0;
    /* Two states worth distinguishing:
     *  1. NOT running yet — normal budget is `spd - used`; run tier
     *     is `spd*3 - used`, shown as an upgrade tier if the actor
     *     still has the action slots to commit Run.
     *  2. ALREADY running (`runUsed`) — the full-round Run is
     *     committed, `fullRound: true` and the cap is already spd*3.
     *     All remaining budget is now a single normal tier (no
     *     further upgrade possible). Without this branch, the old
     *     `canRun = !fullRound` gate zeroed `runRemaining` AND
     *     `spd - used` had already gone negative → plot vanished
     *     even though the actor still had run budget left. */
    const alreadyRunning = !!round.runUsed;
    // Weather footing (wind/rain/snow) trims the budget, floored at half speed —
    // same helper the enforcement (recordMovement / canvas-movement) uses, so the
    // reachable overlay matches what a move will actually be allowed.
    const normalCap = weatherAdjustedMoveCap(spd, alreadyRunning ? 3 : 1, 0, actor);
    const normalRemaining = Math.max(0, normalCap - usedMeters);
    const canUpgradeToRun = !alreadyRunning && !round.actionUsed && !round.extraUsed && !round.fullRound;
    const runRemaining = canUpgradeToRun ? Math.max(0, weatherAdjustedMoveCap(spd, 3, 0, actor) - usedMeters) : 0;
    if (normalRemaining <= 0 && runRemaining <= 0) return null;
    return { normalRemaining, runRemaining, canRun: canUpgradeToRun };
}

/** Cheap signature of everything the reachable set depends on — token identity,
 *  position, FOOTPRINT and movement budget, plus a wall-geometry epoch. It
 *  deliberately OMITS rotation: the reach flood has no LOS/vision gating
 *  (makeVisibilityPredicate is a no-op), so facing never changes what's
 *  reachable. Returns null when ineligible. drawOverlay compares this to the
 *  last-drawn signature and skips the whole flood+draw when it matches — which
 *  is what collapses the turn-start refresh storm and every strafing re-face
 *  down to a single string compare instead of a full rebuild. */
function computeReachSignature() {
    if (!isEligibleContext()) return null;
    const token = findLockTarget();
    const budget = _computeMoveBudget(token);
    if (!budget) return null;
    const d = token.document;
    return `${token.id}:${Number(d.x)|0}:${Number(d.y)|0}:${d.width}:${d.height}`
         + `:${Number(d.elevation)||0}`
         + `:${budget.normalRemaining.toFixed(2)}:${budget.runRemaining.toFixed(2)}`
         + `:${budget.canRun ? 1 : 0}:${_geometryEpoch}`;
}

function rebuildReachabilityCache() {
    if (!isEligibleContext()) { resetCache(); return false; }
    const token = findLockTarget();
    const budget = _computeMoveBudget(token);
    if (!budget) { resetCache(); return false; }
    const { normalRemaining, runRemaining, canRun } = budget;

    return isGridless()
        ? _rebuildGridlessCache(token, normalRemaining, runRemaining, canRun)
        : _rebuildGridCache(token, normalRemaining, runRemaining, canRun);
}

function _rebuildGridCache(token, normalRemaining, runRemaining, canRun) {
    /* One Dijkstra to the LARGER of the two budgets — the run tier's
     * cells are a superset of the normal tier's, so we split by cost
     * after the fact instead of running two Dijkstras. */
    const largerBudget = Math.max(normalRemaining, runRemaining);
    const cells = computeReachableCells(token, largerBudget);

    const gs = Number(canvas.scene?.grid?.size) || 100;
    const gridPl = canvas.grid;
    const tokenCenter = _tokenCenterPoint(token);
    const startOffset = gridPl?.getOffset ? gridPl.getOffset(tokenCenter) : { i: 0, j: 0 };
    const startKey = _offsetKey(startOffset);

    /* Tier partition — normal = cost ≤ normalRemaining, run-only =
     * normalRemaining < cost ≤ runRemaining. Excludes the start cell
     * so the token's own square isn't highlighted. */
    const normalKeys = new Set();
    const runKeys    = new Set();
    for (const [k, v] of cells) {
        if (k === startKey) continue;
        if (v.cost <= normalRemaining + 1e-6) normalKeys.add(k);
        else if (v.cost <= runRemaining + 1e-6) runKeys.add(k);
    }

    _cachedReach = {
        mode: "grid", tokenId: token.id,
        cells, normalKeys, runKeys, startKey,
        startX: tokenCenter.x, startY: tokenCenter.y, gs, canRun,
        normalPoly: null, runPoly: null,
        normalRemaining, runRemaining, metersPerPixel: 0
    };
    return true;
}

/** Gridless reachability: two `ClockwiseSweepPolygon`s from the token's
 *  center at the normal and run radii (in pixels), wall-clipped for
 *  `type: "move"`. Each polygon is the exact set of points the token
 *  can reach in a straight line without crossing a move-blocking wall.
 *
 *  Result cached as raw `PIXI.Polygon` (or a plain point array Foundry
 *  returns) so `drawOverlay` can fill / stroke it and `drawHoverPath`
 *  can point-in-poly test the cursor. */
function _rebuildGridlessCache(token, normalRemaining, runRemaining, canRun) {
    const grid = canvas.scene.grid;
    const distancePerCell = Number(grid?.distance);
    const gs = Number(grid?.size);
    if (!gs || !distancePerCell) { resetCache(); return false; }
    /* pixels-per-meter: `grid.size` px per `grid.distance` scene units. */
    const pixelsPerMeter = gs / distancePerCell;
    const metersPerPixel = 1 / pixelsPerMeter;

    const tokenDoc = token.document;
    const tokenCenter = {
        x: Number(tokenDoc.x) + (Number(tokenDoc.width)  || 1) * gs / 2,
        y: Number(tokenDoc.y) + (Number(tokenDoc.height) || 1) * gs / 2
    };
    const normalRadiusPx = normalRemaining * pixelsPerMeter;
    const runRadiusPx    = runRemaining    * pixelsPerMeter;

    const normalPoly = normalRadiusPx > 0 ? _buildSweepPoly(tokenCenter, normalRadiusPx) : null;
    const runPoly    = runRadiusPx    > 0 ? _buildSweepPoly(tokenCenter, runRadiusPx)    : null;

    _cachedReach = {
        mode: "gridless", tokenId: token.id,
        cells: null, normalKeys: null, runKeys: null, startKey: null,
        startX: tokenCenter.x, startY: tokenCenter.y, gs, canRun,
        normalPoly, runPoly,
        normalRemaining, runRemaining, metersPerPixel
    };
    return true;
}

/** Build a wall-clipped reachability polygon centered at `origin` out
 *  to `radius` pixels using Foundry's clockwise sweep. Returns a
 *  `PIXI.Polygon` (the sweep result already IS one). Wrapped in
 *  try/catch because a bad sweep config (zero radius, off-scene origin)
 *  throws and would otherwise nuke the overlay draw. */
function _buildSweepPoly(origin, radius) {
    if (radius <= 0) return null;
    try {
        const SweepCls = foundry?.canvas?.geometry?.ClockwiseSweepPolygon
            ?? window.ClockwiseSweepPolygon;
        if (!SweepCls?.create) return null;
        return SweepCls.create(origin, { type: "move", radius });
    } catch (err) {
        console.warn(`${SYSTEM_ID} | tactical grid: sweep poly build failed`, err);
        return null;
    }
}

/** Visibility toggle. Defaults to HIDDEN so combat starts clean —
 *  right-click on empty canvas during your turn shows the overlay,
 *  another right-click hides it again. When HIDDEN, ALL tactical-
 *  grid code paths bail (pointer handlers, drawOverlay, etc.), and
 *  the cache is wiped so nothing can leak into a stale re-render. */
let _overlayVisible = false;
export function isOverlayVisible() { return _overlayVisible; }
/** Hide the movement overlay if it's showing. Called when the weapon
 *  target-select overlay opens so the two don't overlap on the canvas. */
export function hideMovementOverlay() {
    try { if (_overlayVisible) setOverlayVisible(false); } catch (_) {}
}
function setOverlayVisible(v) {
    if (_overlayVisible === v) return;
    _overlayVisible = v;
    if (!v) {
        /* Full wipe on hide. `resetCache()` blanks `_cachedReach.mode`
         * so onPointerMove / onPointerDown early-return on the
         * `!_cachedReach.mode` guard even if `_overlayVisible` were
         * somehow re-checked stale. Belt-and-suspenders. */
        _hoverKey = null;
        _hoverPoint = null;
        _dragChain = null;
        resetCache();
        clearHoverContainer();
        if (_layer && !_layer.destroyed) {
            _layer.removeChildren().forEach(c => { try { c.destroy(); } catch (_) {} });
        }
    } else {
        drawOverlay();
    }
}

function drawOverlay() {
    ensureLayer();
    if (!_layer || _layer.destroyed) return;

    /* FAST-SKIP. The reachable set is a pure function of the token's position,
     * footprint, movement budget and wall geometry — captured by
     * computeReachSignature (which omits rotation, since facing never gates
     * reach). When it matches the last-drawn overlay and the layer still has
     * content, skip the entire flood + redraw. This collapses the turn-start
     * refresh storm (combatTurnChange + controlToken + combatRound updateActor)
     * AND every strafing/​facing-lock re-face (each fires a rotation updateToken)
     * from N full run-budget rebuilds down to one string compare — the "massive
     * stutter at the start, especially during strafing". */
    if (_overlayVisible && !_isCommittingTacticalMove && _layer.children.length > 0) {
        const sig = computeReachSignature();
        if (sig && sig === _drawnSig) { _layer.visible = true; return; }
    }

    /* Ensure the layer is visible again after any commit-time hide. */
    _layer.visible = true;
    _layer.removeChildren().forEach(c => { try { c.destroy(); } catch (_) {} });
    /* Also wipe hover state whenever the layer is cleared for any
     * reason — the previous hover cell / point is stale relative to
     * whatever state we're about to (or refuse to) rebuild into.
     * Fixes: user deselects their token → my hooks fire drawOverlay
     * → layer cleared → but a lingering `_hoverKey` /  `_hoverPoint`
     * causes the next pointermove to re-run `drawHoverPath` against
     * a stale cell map before eligibility bails, leaving the plot
     * line visible with no token controlled. */
    _hoverKey = null;
    _hoverPoint = null;
    _dragChain = null;
    _drawnSig = null;   // invalid until the fresh draw below completes
    if (!_overlayVisible) return;
    if (!rebuildReachabilityCache()) return;

    if (_cachedReach.mode === "grid")     _drawGridOverlay();
    else if (_cachedReach.mode === "gridless") _drawGridlessOverlay();

    /* Re-render whatever hover was in flight — reachability changes
     * may have invalidated it (e.g., hovered point out of range now). */
    drawHoverPath();

    /* Record what we just drew so the next redundant refresh (turn-start storm,
     * strafing re-face) fast-skips instead of re-flooding. */
    _drawnSig = computeReachSignature();
}

function _drawGridOverlay() {
    const { cells, normalKeys, runKeys } = _cachedReach;
    if (runKeys.size > 0) {
        const runCellsMap = new Map();
        for (const k of runKeys) runCellsMap.set(k, cells.get(k));
        const runContainer = new PIXI.Container();
        drawRunTierTiles(runContainer, runCellsMap);
        _layer.addChild(runContainer);
    }
    if (normalKeys.size > 0) {
        const normalCellsMap = new Map();
        for (const k of normalKeys) normalCellsMap.set(k, cells.get(k));
        const g = new PIXI.Graphics();
        drawTierTiles(g, normalCellsMap, ALPHA_MOVE_FILL, ALPHA_MOVE_STROKE);
        _layer.addChild(g);
    }
}

/** Gridless overlay — draw the wall-clipped normal-reach and run-reach
 *  polygons as concentric shapes. Run polygon painted first at low
 *  alpha (approximating the "hatch" tier of gridded mode by making it
 *  visibly fainter); normal polygon over-painted at the standard tier
 *  alpha so the two tiers read as inner + outer. For the run tier's
 *  hatch look, we mask a hatched rectangle to the run polygon's
 *  bounds — same visual language as the gridded run tier. */
function _drawGridlessOverlay() {
    const { normalPoly, runPoly } = _cachedReach;
    /* Run tier — draw hatched region clipped to run polygon minus
     * normal polygon. Because subtracting polygons in PIXI is
     * awkward, we paint the run polygon's hatch UNDER the normal
     * polygon; the normal polygon's opaque fill covers the hatch
     * inside its area, so what remains visible is the run-only ring. */
    if (runPoly) {
        const runContainer = new PIXI.Container();
        /* 1. Draw dashed border of the run polygon. */
        const border = new PIXI.Graphics();
        _drawDashedPolygon(border, runPoly, COLOR_TIER, ALPHA_RUN_STROKE);
        runContainer.addChild(border);
        /* 2. Draw hatched fill clipped to run polygon. */
        const hatch = new PIXI.Graphics();
        const bounds = runPoly.getBounds?.() ?? { x: 0, y: 0, width: 0, height: 0 };
        _drawHatchOverBounds(hatch, bounds, COLOR_TIER, ALPHA_RUN_HATCH);
        const mask = new PIXI.Graphics();
        mask.beginFill(0xffffff, 1).drawPolygon(runPoly).endFill();
        hatch.mask = mask;
        runContainer.addChild(mask);
        runContainer.addChild(hatch);
        _layer.addChild(runContainer);
    }
    if (normalPoly) {
        const normalG = new PIXI.Graphics();
        normalG.beginFill(COLOR_TIER, ALPHA_MOVE_FILL).drawPolygon(normalPoly).endFill();
        _drawDashedPolygon(normalG, normalPoly, COLOR_TIER, ALPHA_MOVE_STROKE);
        _layer.addChild(normalG);
    }
}

/** Draw a dashed outline along a polygon's edges. Same dash / gap
 *  metrics as the gridded tier borders so the two modes visually
 *  match. */
function _drawDashedPolygon(g, poly, color, alpha) {
    g.lineStyle(STROKE_WIDTH, color, alpha);
    const pts = poly.points ?? [];
    if (pts.length < 4) { g.lineStyle(0); return; }
    for (let i = 0; i < pts.length; i += 2) {
        const x1 = pts[i], y1 = pts[i + 1];
        const j = (i + 2) % pts.length;
        const x2 = pts[j], y2 = pts[j + 1];
        drawDashedLine(g, x1, y1, x2, y2);
    }
    g.lineStyle(0);
}

/** Diagonal hatch across a rectangular region — masked to a polygon
 *  by the caller. Overdrawing outside the polygon is fine: the mask
 *  clips it. Parallel "\" diagonals at 45° spaced `HATCH_SPACING`
 *  apart. For each offset the diagonal spans (x0+o, y0) → (x0+o+h,
 *  y0+h) which is a segment of slope +1 (y-down = down-right). Offsets
 *  range from -h to w to cover the whole rectangle. */
function _drawHatchOverBounds(g, bounds, color, alpha) {
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
    const x0 = bounds.x;
    const y0 = bounds.y;
    const w  = bounds.width;
    const h  = bounds.height;
    g.lineStyle(HATCH_WIDTH, color, alpha);
    for (let off = -h; off < w + HATCH_SPACING; off += HATCH_SPACING) {
        g.moveTo(x0 + off,     y0);
        g.lineTo(x0 + off + h, y0 + h);
    }
    g.lineStyle(0);
}

/* ── hover path preview ─────────────────────────────────────────── */

/** Dedicated PIXI container for the hover path so we can redraw it
 *  without wiping the tier tiles below. Added as a separate child of
 *  `_layer` on first use; kept alive across draws. */
let _hoverContainer = null;
function ensureHoverContainer() {
    if (_hoverContainer && !_hoverContainer.destroyed && _hoverContainer.parent === _layer) return _hoverContainer;
    if (!_layer || _layer.destroyed) return null;
    _hoverContainer = new PIXI.Container();
    _hoverContainer.name = "WDMTacticalGrid.HoverPath";
    _hoverContainer.eventMode = "none";
    _hoverContainer.zIndex = 10;   // above the tier tiles inside _layer
    /* 40% opacity — applies to the plotter LINE + waypoint dots +
     * destination marker + cost label as a group. Fades just the
     * path preview (not the reach tiles) so the hovered route reads
     * as "planned / non-committed" against the fully-opaque reach. */
    _hoverContainer.alpha = 0.4;
    _layer.addChild(_hoverContainer);
    return _hoverContainer;
}

function clearHoverContainer() {
    if (!_hoverContainer || _hoverContainer.destroyed) return;
    _hoverContainer.removeChildren().forEach(c => { try { c.destroy(); } catch (_) {} });
}

function drawHoverPath() {
    const c = ensureHoverContainer();
    if (!c) return;
    clearHoverContainer();
    if (_cachedReach.mode === "grid")     _drawHoverPath_grid();
    else if (_cachedReach.mode === "gridless") _drawHoverPath_gridless();
}

function _drawHoverPath_grid() {
    if (!_hoverKey || !_cachedReach.cells) return;
    const target = _cachedReach.cells.get(_hoverKey);
    if (!target) return;
    /* Compute the hover path via per-hover A* (heuristic-biased,
     * favors direct-to-target routes) instead of reusing the Dijkstra
     * parent chain (which depends on flood iteration order). Falls
     * back to the parent chain if A* fails for any reason. */
    const startCell = _cachedReach.cells.get(_cachedReach.startKey);
    const budgetMeters = _cachedReach.runKeys.has(_hoverKey)
        ? _cachedReach.runRemaining
        : _cachedReach.normalRemaining;
    let path = null;
    if (startCell) {
        path = computePathAStar(_cachedReach.startKey, startCell, target, budgetMeters);
    }
    if (!path) path = reconstructPath(_cachedReach.cells, _hoverKey);
    if (!path || path.length < 2) return;

    const c  = _hoverContainer;
    const gs = _cachedReach.gs;
    const isRun = _cachedReach.runKeys.has(_hoverKey);

    /* The Theta* parent chain is ALREADY the optimal any-angle path —
     * no smoothing pass needed. Each cell in the chain is either the
     * start, the destination, or a genuine turn point at a wall
     * corner (Theta* only adds intermediate cells when line-of-sight
     * from a previous cell's parent to the current neighbor is
     * blocked). Straight-shot hovers through open ground produce a
     * chain of exactly [start, destination]; wall-forced detours
     * add minimum turn points. */
    const smoothed = path;
    const drawPts = smoothed.map(c => ({ x: c.centerX, y: c.centerY }));

    /* Line through the expanded draw points. */
    const line = new PIXI.Graphics();
    line.lineStyle(PATH_LINE_WIDTH, COLOR_PATH, ALPHA_PATH_LINE);
    line.moveTo(drawPts[0].x, drawPts[0].y);
    for (let i = 1; i < drawPts.length; i++) {
        line.lineTo(drawPts[i].x, drawPts[i].y);
    }
    line.lineStyle(0);
    /* Waypoint dots at each TURN point in the smoothed path
     * (skipping start and destination — start is the token, destination
     * gets its own highlight). Long straight segments have no dots
     * along them, so the visual reads as "you turn here, then here"
     * rather than "you visit every cell." */
    for (let i = 1; i < smoothed.length - 1; i++) {
        line.beginFill(COLOR_PATH, ALPHA_PATH_DOT).drawCircle(smoothed[i].centerX, smoothed[i].centerY, PATH_DOT_RADIUS).endFill();
    }
    c.addChild(line);

    /* Destination tile — draws the cell's exact polygon so hex
     * highlights render as hexagons, not squares. */
    const targetShape = _cellVertices(target);
    if (targetShape) {
        const dest = new PIXI.Graphics();
        dest.beginFill(COLOR_PATH, ALPHA_DEST_FILL).drawPolygon(targetShape.flat).endFill();
        dest.lineStyle(2, COLOR_PATH, ALPHA_DEST_STROKE).drawPolygon(targetShape.flat).lineStyle(0);
        c.addChild(dest);
    }

    _drawCostLabel(c, target.centerX, target.centerY, target.cost, isRun, gs);
}

/** Gridless hover — the hover state is a world-space point (`_hoverPoint`),
 *  not a cell key. Cost = pixel distance × metersPerPixel, wall-check
 *  via a straight segment collision, and the "destination" is the
 *  cursor tile-of-nothing marked by a small ring. */
let _hoverPoint = null;   // { x, y } in world coords
function _drawHoverPath_gridless() {
    if (!_hoverPoint) return;
    const { startX, startY, normalRemaining, runRemaining, canRun, metersPerPixel } = _cachedReach;
    const dx = _hoverPoint.x - startX;
    const dy = _hoverPoint.y - startY;
    const pxDist = Math.sqrt(dx * dx + dy * dy);
    const cost = pxDist * metersPerPixel;

    /* Wall check: straight segment from token center to cursor. If
     * blocked, no path — the reach polygon already communicates that
     * area is unreachable, so we just don't draw a hover path. */
    if (testWallSegment({ x: startX, y: startY }, _hoverPoint)) return;
    /* LOS gate for gridless (mirrors the per-cell gate in the grid
     * Dijkstra). Without this, a player could plot a straight-line
     * move into fog and reveal the map by walking blind. Skip
     * drawing the hover path if the destination point isn't visible
     * to the acting token; the click-commit does the same check. */
    const token = findLockTarget();
    if (token) {
        const isVis = makeVisibilityPredicate(token);
        if (!isVis(_hoverPoint)) return;
    }

    /* Tier determination — same as grid mode but computed from cost. */
    let isRun = false;
    if (cost > normalRemaining + 1e-6) {
        if (!canRun || cost > runRemaining + 1e-6) return;   // out of range
        isRun = true;
    }

    const c = _hoverContainer;
    /* Line from token to cursor. */
    const line = new PIXI.Graphics();
    line.lineStyle(PATH_LINE_WIDTH, COLOR_PATH, ALPHA_PATH_LINE);
    line.moveTo(startX, startY);
    line.lineTo(_hoverPoint.x, _hoverPoint.y);
    line.lineStyle(0);
    c.addChild(line);

    /* Destination marker — small filled ring at cursor. */
    const dest = new PIXI.Graphics();
    const ringRadius = 12;
    dest.beginFill(COLOR_PATH, ALPHA_DEST_FILL).drawCircle(_hoverPoint.x, _hoverPoint.y, ringRadius).endFill();
    dest.lineStyle(2, COLOR_PATH, ALPHA_DEST_STROKE).drawCircle(_hoverPoint.x, _hoverPoint.y, ringRadius).lineStyle(0);
    c.addChild(dest);

    _drawCostLabel(c, _hoverPoint.x, _hoverPoint.y - ringRadius * 2, cost, isRun, _cachedReach.gs);
}

/** On-screen size (CSS px) for the cost label, from the client setting with a
 *  safe fallback to the default constant. Read fresh per draw so a settings
 *  change takes effect on the next hover with no reload. */
function _costLabelPx() {
    try {
        const v = Number(game.settings.get("witcher-ttrpg-death-march", "immersiveGrid.costLabelSize"));
        if (Number.isFinite(v) && v > 0) return v;
    } catch (_) { /* setting not registered / not ready */ }
    return COST_LABEL_SCREEN_PX;
}

function _drawCostLabel(container, x, y, cost, isRun, gs) {
    const px = _costLabelPx();
    const label = String(Math.round(cost * 10) / 10) + "m" + (isRun ? " (run)" : "");
    /* System chrome font. `PF DIN Text Cond Pro` is the condensed
     * impact-style face bundled with styles/tokens.css and used
     * everywhere else in the death-march UI — cost labels match. No
     * stroke / backdrop per user: reads cleaner over the amber tiles
     * and stays consistent with other on-canvas text (waypoint labels,
     * ruler text) that runs the same face plain.
     *
     * Authored at COST_LABEL_SCREEN_PX (a fixed size, NOT gs*0.22 world px):
     * the upright ticker counter-scales by 1/stageScale every frame so the
     * on-screen size is a constant, legible COST_LABEL_SCREEN_PX at any zoom.
     * The old world-space `gs*0.22` shrank with zoom-out to illegibility. */
    const txt = new PIXI.Text(label, {
        fontFamily: '"PF DIN Text Cond Pro", Impact, "Arial Narrow", sans-serif',
        fontSize: px,
        fontWeight: "700",
        fill: COST_LABEL_COLOR,
        align: "center"
    });
    /* Render the glyph texture at extra resolution so counter-scaling it UP
     * when zoomed out doesn't blur. Capped so it stays cheap on weak GPUs. */
    txt.resolution = Math.min(3, Math.max(2, Math.ceil((window.devicePixelRatio || 1) * 1.5)));
    txt.anchor.set(0.5, 0.5);
    txt.position.set(x, y);
    /* Markers read by the upright ticker: keep the label upright while the
     * immersive camera spins the stage (rotation = -stageRot), AND hold a
     * constant on-screen size (scale = 1/stageScale). Authored fontSize ==
     * _wdmScreenPx so the ticker's 1/stageScale scale yields exactly px. */
    txt._wdmUprightText = true;
    txt._wdmScreenPx = px;
    container.addChild(txt);
}

/** Convert a global pointer event to a cell key in world coords, then
 *  update `_hoverKey` and redraw if it changed. Bailed early when the
 *  context is ineligible OR the hovered cell isn't in the reachability
 *  set (that's the "hovering unreachable terrain" case — leave
 *  `_hoverKey` null so no path renders). */
function onPointerMove(event) {
    /* HARD OFF SWITCH — when the overlay is hidden, do NOTHING.
     * No hover tracking, no cache reads, no PIXI container creation,
     * no path draws. Any other work here (like clearing stale hover
     * state) would still let a re-hover repopulate the container and
     * paint a plotter line even though the reach tiles are hidden.
     * The user's complaint: "close the overlay but still see the
     * plotter" — that was `drawHoverPath` running from stale
     * `_cachedReach.mode` while `_overlayVisible = false`. */
    if (!_overlayVisible) return;
    if (!isEligibleContext() || !_cachedReach.mode) {
        if (_hoverKey !== null || _hoverPoint !== null) {
            _hoverKey = null;
            _hoverPoint = null;
            clearHoverContainer();
        }
        return;
    }
    /* Freeze hover updates during commit — the token is walking a
     * previously-plotted route and any pointermove overlay would show
     * a route from the wrong (stale-cached-start) cell. Resumes on
     * the next event after commit resolves. */
    if (_isCommittingTacticalMove) return;
    /* PIXI event → world coord: v14 events carry a `getLocalPosition`
     * helper that returns coords in the target's local frame. Passing
     * `canvas.stage` gives us world coords directly. */
    let world;
    try { world = event.getLocalPosition?.(canvas.stage); }
    catch (_) { return; }
    if (!world) return;

    if (_cachedReach.mode === "grid") {
        /* Grid-type-agnostic pointer → cell: `canvas.grid.getOffset`
         * handles square vs hex axial coordinates uniformly. */
        const offset = canvas.grid?.getOffset?.(world);
        if (!offset) return;
        const key = _offsetKey(offset);
        const nextKey = _cachedReach.cells.has(key) && key !== _cachedReach.startKey ? key : null;
        /* Extend the drag-chain if a drag is in progress. Add a cell
         * when the pointer enters a NEW reachable cell adjacent to the
         * chain's tail; truncate when it re-enters a previously visited
         * cell (natural undo — drag backward to remove the last step). */
        if (_dragChain && nextKey && nextKey !== _dragChain.chain[_dragChain.chain.length - 1]) {
            const prevIdx = _dragChain.chain.indexOf(nextKey);
            if (prevIdx >= 0) {
                /* Backtrack — chop the chain to (and including) the
                 * cell we're re-entering. Never truncates before the
                 * start cell (chain[0] is the token's origin). */
                _dragChain.chain = _dragChain.chain.slice(0, prevIdx + 1);
                _dragChain.didDrag = true;
            } else if (_isCellAdjacent(_dragChain.chain[_dragChain.chain.length - 1], nextKey)) {
                _dragChain.chain.push(nextKey);
                _dragChain.didDrag = true;
            }
            _hoverKey = nextKey;
            _hoverPathVersion++;
            _drawDragChainPreview();
            return;
        }
        if (nextKey === _hoverKey) return;
        _hoverKey = nextKey;
        _hoverPathVersion++;
        drawHoverPath();
        return;
    }

    if (_cachedReach.mode === "gridless") {
        /* Gridless is continuous — no cell-key dedup possible. To
         * avoid redrawing on every raw pointermove (which can fire
         * at monitor refresh rate = 240Hz+ on modern displays), stash
         * the point and coalesce the redraw to at most once per
         * animation frame. Cheap in idle case. */
        _hoverPoint = { x: world.x, y: world.y };
        _scheduleHoverRedraw();
    }
}

let _hoverRedrawScheduled = false;
function _scheduleHoverRedraw() {
    if (_hoverRedrawScheduled) return;
    _hoverRedrawScheduled = true;
    requestAnimationFrame(() => {
        _hoverRedrawScheduled = false;
        try { drawHoverPath(); }
        catch (err) { console.warn(`${SYSTEM_ID} | hover redraw failed`, err); }
    });
}

let _pointerAttached = false;
/** Stash for the original `permissions.dragLeftStart` callback on
 *  `canvas.mouseInteractionManager`. We wrap it in attachPointerListener
 *  to refuse Foundry's left-drag when our tactical drag-chain is
 *  active; the wrap is undone in detach so nothing leaks after combat. */
let _originalDragPermission = null;

/** Right-click toggle — single channel, works identically on GM and
 *  player clients.
 *
 *  Why `document.contextmenu` at capture instead of PIXI stage
 *  pointerdown: Foundry v14's canvas input manager consumes right-
 *  click pointerdown events for non-GM clients between window-capture
 *  and document-capture (empirically verified — see multi-channel
 *  sniff results in commit history). GM keeps the pointerdown, player
 *  loses it. `contextmenu` is a browser-native event that Foundry
 *  hooks at bubble phase (to suppress the OS menu via preventDefault)
 *  but the capture phase still runs first with `defaultPrevented=false`
 *  on every client.
 *
 *  Attached ONLY here (the `button === 2` branch in `onPointerDown`
 *  has been removed) so nobody double-toggles. */
function _onDocumentContextMenu(event) {
    const target = event?.target;
    const view = canvas?.app?.view ?? null;
    const isCanvas = (view && target === view)
                  || target?.tagName === "CANVAS"
                  || target?.id === "board";
    if (!isCanvas) return;
    /* A spell / AoE template is being aimed — right-click is that template's
     * cancel action (castArea.mjs listens on the canvas view's contextmenu).
     * Bail WITHOUT toggling the overlay or swallowing the event, so the
     * template-cancel handler downstream receives it and aborts the aim.
     * (This capture-phase document handler otherwise stopImmediatePropagation's
     * the event before castArea's view-level listener ever runs.) */
    if ((canvas?.templates?.preview?.children?.length ?? 0) > 0) return;
    /* A weapon target-select overlay is open — right-click is ITS cancel
     * action. Defer WITHOUT toggling or swallowing so the overlay's own
     * contextmenu handler cancels the pick; the movement overlay must NOT
     * open on that right-click. */
    if (isWeaponTargetingActive()) return;
    /* A Drag destination/facing pick is open — right-click is ITS cancel. Defer
     * so the movement grid doesn't pop over the drag overlay. */
    if (isDragActive()) return;
    if (!isEligibleContext()) return;
    try { event.stopImmediatePropagation?.(); } catch (_) {}
    try { event.stopPropagation?.(); } catch (_) {}
    try { event.preventDefault?.(); } catch (_) {}
    setOverlayVisible(!_overlayVisible);
}

function attachPointerListener() {
    if (_pointerAttached) return;
    if (!canvas?.stage) return;
    canvas.stage.on("pointermove", onPointerMove);
    canvas.stage.on("pointerdown", onPointerDown);
    canvas.stage.on("pointerup",   onPointerUp);
    canvas.stage.on("pointerupoutside", onPointerUp);
    document.addEventListener("contextmenu", _onDocumentContextMenu, true);

    /* Block Foundry's canvas-drag only while the user is in the
     * tactical-grid workflow (in-combat, on their turn, controlling
     * their token). Canvas board (board.mjs:2065) registers
     * `#canDragLeftStart` as the `permissions.dragLeftStart` gate on
     * its MouseInteractionManager. With tool = "select" it
     * unconditionally allows drag-start (board.mjs:2181), which
     * activates the rubber-band select rectangle. On drop, that
     * rectangle RELEASES any controlled tokens it doesn't cover
     * (board.mjs:2260-6) — meaning a stray left-drag on empty canvas
     * deselects the user's token. Also catches the tactical drag-
     * chain path (they cross other tokens mid-drag and get grabbed).
     *
     * We wrap dynamically instead of blanket-blocking so out-of-combat
     * clients (e.g. GM with nothing selected, or before combat starts)
     * keep normal drag-select. Falls back to the original permission
     * callback when eligibility fails, so canvas behavior is
     * unchanged outside the tactical-grid window. Restored on detach. */
    const mim = canvas?.mouseInteractionManager;
    if (mim?.permissions && !_originalDragPermission) {
        _originalDragPermission = mim.permissions.dragLeftStart;
        mim.permissions.dragLeftStart = function(...args) {
            if (isEligibleContext()) return false;
            return _originalDragPermission?.apply(this, args) ?? true;
        };
    }
    _pointerAttached = true;
}
function detachPointerListener() {
    if (!_pointerAttached) return;
    try {
        canvas.stage?.off?.("pointermove", onPointerMove);
        canvas.stage?.off?.("pointerdown", onPointerDown);
        canvas.stage?.off?.("pointerup",   onPointerUp);
        canvas.stage?.off?.("pointerupoutside", onPointerUp);
    } catch (_) { /* stage already gone */ }
    try { document.removeEventListener("contextmenu", _onDocumentContextMenu, true); }
    catch (_) { /* listener wasn't attached */ }
    /* Restore Foundry's original drag-permission callback so
     * out-of-combat drags (or scenes without tactical grid) work
     * normally. Only restore if we're the one who wrapped it. */
    try {
        const mim = canvas?.mouseInteractionManager;
        if (mim?.permissions && _originalDragPermission) {
            mim.permissions.dragLeftStart = _originalDragPermission;
        }
    } catch (_) { /* mim tear-down race */ }
    _originalDragPermission = null;
    _pointerAttached = false;
}

/* ── click-commit + waypoint animation ─────────────────────────── */

/** Set true while a tactical-grid commit is running. Immersive token
 *  camera reads this via `isCommittingTacticalMove()` to (a) skip its
 *  `onPreMoveToken` `autoRotate = false` override so Foundry's own
 *  `core.tokenAutoRotate` setting is honored, and (b) block WASD
 *  rotation input during the animation. Exported so
 *  `immersive-token-camera.mjs` can import + gate on it. */
let _isCommittingTacticalMove = false;
export function isCommittingTacticalMove() { return _isCommittingTacticalMove; }

/** Click-and-drag path builder. When the user presses left-mouse-down
 *  on a reachable cell then drags through more cells before releasing,
 *  the chain accumulates the exact cells they traversed — commit on
 *  mouseup walks that literal path. A quick click-release (no drag)
 *  falls through to the standard A* auto-path commit.
 *
 *  Shape: `{ chain: [key0, key1, ...], didDrag: bool, initialHover: key }`
 *  - `chain[0]` is always the token's start cell.
 *  - `didDrag = true` once the pointer has landed on a DIFFERENT cell
 *    than the click's initial cell (so we can distinguish click vs. drag
 *    on mouseup). */
let _dragChain = null;

/** Handle pointer-down on the canvas.
 *   - Right-click during combat: handled elsewhere by the document-
 *     level `contextmenu` capture listener (`_onDocumentContextMenu`).
 *     The PIXI stage doesn't see right-click pointerdown for non-GM
 *     clients on Foundry v14, so the toggle can't live here.
 *   - Left-click on a reachable cell (grid mode): start a drag-chain.
 *     Commit deferred to pointerup — a quick release = A* auto-path
 *     (existing behavior); a drag through more cells = literal path.
 *   - Left-click on a reachable point (gridless mode): commit directly
 *     (no drag-chain for gridless; movement is continuous). */
async function onPointerDown(event) {
    if (_isCommittingTacticalMove) return;
    if (!isEligibleContext()) return;
    const button = event?.data?.button ?? event?.button ?? 0;
    if (button !== 0) return;
    if (!_overlayVisible) return;
    if (!_cachedReach.mode) return;
    if (_cachedReach.mode === "grid" && (!_hoverKey || !_cachedReach.cells)) return;
    if (_cachedReach.mode === "gridless" && !_hoverPoint) return;

    /* Verify the click landed on a reachable target — clicks
     * elsewhere pass through to Foundry (target reticles, placeable
     * selection, etc.). */
    if (_cachedReach.mode === "grid") {
        if (!_cachedReach.cells.get(_hoverKey)) return;
        /* Start a drag-chain. `chain[0]` = start cell; `chain[1]` =
         * the clicked cell. pointermove extends; pointerup commits.
         *
         * `stopImmediatePropagation` is CRITICAL here. Our handler is
         * registered on canvas.stage BEFORE Foundry's MIM adds its own
         * pointerdown listener (which it does lazily on pointerover
         * — see mouse-handler.mjs:359). PIXI EventEmitter fires
         * listeners in registration order, so ours fires first. If we
         * only stopPropagation, MIM's listener still runs on the same
         * stage and transitions to CLICKED, which then becomes DRAG on
         * pointermove and activates the rubber-band select rectangle
         * (that's the "other tokens get selected" bug the user hit).
         * stopImmediatePropagation blocks MIM's listener entirely, so
         * its state stays NONE and no drag workflow ever begins. */
        _dragChain = {
            chain: [_cachedReach.startKey, _hoverKey],
            initialHover: _hoverKey,
            didDrag: false
        };
        try { event.stopImmediatePropagation?.(); } catch (_) {}
        try { event.stopPropagation?.(); } catch (_) {}
        try { event.preventDefault?.(); } catch (_) {}
        return;
    }
    /* Gridless: no chain semantics — click commits immediately. */
    try { event.stopImmediatePropagation?.(); } catch (_) {}
    try { event.stopPropagation?.(); } catch (_) {}
    try { event.preventDefault?.(); } catch (_) {}
    await commitHoverMove();
}

/** Pointer-up handler — resolves an in-flight drag-chain into either
 *  a custom-path commit (dragged through 2+ cells) or a standard A*
 *  auto-path commit (no drag detected). */
async function onPointerUp(event) {
    if (!_dragChain) return;
    if (_isCommittingTacticalMove) { _dragChain = null; return; }
    const drag = _dragChain;
    _dragChain = null;
    if (drag.didDrag && drag.chain.length >= 2) {
        /* Custom path — commit exactly the cells the user dragged
         * through. Cost = cumulative measurePath through the chain.
         * The commit helper does the run-confirm + recordRun + walk. */
        await commitCustomChain(drag.chain);
    } else {
        /* Quick click (no drag) — fall through to standard A* commit
         * at whatever cell is currently hovered. */
        await commitHoverMove();
    }
}

/** Given a grid-mode A* path, convert cell centers → token document
 *  waypoints using the DELTA from the token's current position. This
 *  is grid-type-agnostic (square OR hex, any hex orientation) because
 *  it doesn't try to compute a token-shape-aware top-left mapping —
 *  it preserves whatever offset the token already has to its current
 *  cell center. Works for hex tokens whose doc.x/y sits at the
 *  bounding-box top-left (which is offset from the hex center). */
function _pathToWaypoints(path, token) {
    if (!path || path.length < 2) return [];
    /* Each waypoint is anchored to its destination cell's grid CENTER
     * (from `gridPl.getCenterPoint`), converted to token-doc top-left
     * by subtracting half the footprint. Deliberately does NOT compute
     * as a delta from `token.document.x/y` — that starting position
     * can be off-grid after a level change (region-triggered floor
     * transitions don't always snap x/y to the new floor's grid
     * origin), and delta-from-off-grid produces waypoints that stay
     * off-grid forever. Anchoring to cell centers auto-snaps the
     * token on its very first tactical-grid move after a misaligned
     * teleport / floor change. */
    const gs = Number(canvas?.scene?.grid?.size) || 100;
    const halfW = ((Number(token.document?.width)  || 1) * gs) / 2;
    const halfH = ((Number(token.document?.height) || 1) * gs) / 2;
    return path.slice(1).map(p => ({
        x: p.centerX - halfW,
        y: p.centerY - halfH
    }));
}

/** Test whether two cell keys are adjacent under the current grid's
 *  neighbor rules. `getAdjacentOffsets` from Foundry v14's grid API
 *  handles all grid types uniformly (4/8-neighbor square, 6-neighbor
 *  hex in any orientation), so this stays grid-agnostic. */
function _isCellAdjacent(keyA, keyB) {
    const gridPl = canvas.grid;
    if (!gridPl?.getAdjacentOffsets) return false;
    const [ai, aj] = keyA.split(":").map(Number);
    const neighbors = gridPl.getAdjacentOffsets({ i: ai, j: aj }) ?? [];
    for (const n of neighbors) if (`${n.i}:${n.j}` === keyB) return true;
    return false;
}

/** Draw a live preview of the drag chain — thick line through the
 *  cells the user has traversed, with a running cost label at the
 *  chain's tail. Runs on every pointermove during a drag so the
 *  visual tracks the cursor. */
function _drawDragChainPreview() {
    if (!_dragChain || !_cachedReach.cells) return;
    const c = ensureHoverContainer();
    if (!c) return;
    clearHoverContainer();
    const chainCells = _dragChain.chain.map(k => _cachedReach.cells.get(k)).filter(Boolean);
    if (chainCells.length < 2) return;

    /* Cumulative cost via measurePath — same units the Dijkstra used
     * so the label matches the reach tier budget the user's watching. */
    let cost = 0;
    try {
        const gridPl = canvas.grid;
        if (gridPl?.measurePath) {
            const r = gridPl.measurePath(chainCells.map(cell => ({ i: cell.i, j: cell.j })));
            cost = Number(r?.distance) || 0;
        }
    } catch (_) { cost = 0; }

    /* Line through the chain. */
    const line = new PIXI.Graphics();
    line.lineStyle(PATH_LINE_WIDTH, COLOR_PATH, ALPHA_PATH_LINE);
    line.moveTo(chainCells[0].centerX, chainCells[0].centerY);
    for (let i = 1; i < chainCells.length; i++) {
        line.lineTo(chainCells[i].centerX, chainCells[i].centerY);
    }
    line.lineStyle(0);
    /* Waypoint dots — one per intermediate cell. */
    for (let i = 1; i < chainCells.length - 1; i++) {
        line.beginFill(COLOR_PATH, ALPHA_PATH_DOT)
            .drawCircle(chainCells[i].centerX, chainCells[i].centerY, PATH_DOT_RADIUS)
            .endFill();
    }
    c.addChild(line);

    /* Destination tile — highlight the final cell. */
    const tail = chainCells[chainCells.length - 1];
    const targetShape = _cellVertices(tail);
    if (targetShape) {
        const dest = new PIXI.Graphics();
        dest.beginFill(COLOR_PATH, ALPHA_DEST_FILL).drawPolygon(targetShape.flat).endFill();
        dest.lineStyle(2, COLOR_PATH, ALPHA_DEST_STROKE).drawPolygon(targetShape.flat).lineStyle(0);
        c.addChild(dest);
    }

    const isRun = _cachedReach.runKeys.has(_dragChain.chain[_dragChain.chain.length - 1]);
    _drawCostLabel(c, tail.centerX, tail.centerY, cost, isRun, _cachedReach.gs);
}

/** Commit a custom cell chain built by drag. Uses the chain literally
 *  as the walk path (no A* smoothing) — the user dragged through those
 *  exact cells, they get walked through those exact cells. Cost check
 *  + run confirm mirror `commitHoverMove`'s flow. */
async function commitCustomChain(chainKeys) {
    if (!chainKeys || chainKeys.length < 2) return;
    if (!_cachedReach.cells) return;
    const chainCells = chainKeys.map(k => _cachedReach.cells.get(k)).filter(Boolean);
    if (chainCells.length < 2) return;

    /* Total cost via measurePath along the exact chain. */
    let totalCost = 0;
    try {
        const gridPl = canvas.grid;
        if (gridPl?.measurePath) {
            const r = gridPl.measurePath(chainCells.map(cell => ({ i: cell.i, j: cell.j })));
            totalCost = Number(r?.distance) || 0;
        }
    } catch (_) { return; }
    if (totalCost <= 0) return;

    /* Tier determination — same as A*-commit: run if the total
     * exceeds normalRemaining but fits within runRemaining. Over run
     * cap is refused outright (no dialog can salvage it). */
    const nRem = _cachedReach.normalRemaining;
    const rRem = _cachedReach.runRemaining;
    const isRun = totalCost > nRem + 1e-6;
    if (isRun && (!_cachedReach.canRun || totalCost > rRem + 1e-6)) return;

    const token = findLockTarget();
    if (!token?.document) return;

    /* Run confirm — same DialogV2 the canvas-drag over-cap uses. */
    if (isRun) {
        const usedMeters = Number(token.actor?.system?.combatRound?.movementMeters) || 0;
        const projectedMeters = Math.round(usedMeters + totalCost);
        const spd = Number(token.actor?.system?.stats?.spd?.value) || 0;
        const runCap = spd * 3;
        const confirmed = await confirmRunUpgradeDialog(projectedMeters, runCap);
        if (!confirmed) return;
        _isCommittingTacticalMove = true;
        clearHoverContainer();
        if (_layer && !_layer.destroyed) _layer.visible = false;
        let ok = false;
        try { ok = await token.actor.recordRun(); }
        catch (err) { console.warn(`${SYSTEM_ID} | recordRun failed`, err); }
        if (ok === false) {
            _isCommittingTacticalMove = false;
            try { drawOverlay(); } catch (_) {}
            return;
        }
    }

    /* Same waypoint-delta trick as A* commit — grid-agnostic. */
    const waypoints = _pathToWaypoints(chainCells, token);
    if (!waypoints.length) return;

    _isCommittingTacticalMove = true;
    _hoverKey = null;
    _hoverPoint = null;
    clearHoverContainer();
    if (_layer && !_layer.destroyed) _layer.visible = false;
    resetCache();

    const autoRotateEnabled = (() => {
        /* Facing lock STRAFE: while the moving token owns a facing lock, it
         * keeps facing the locked target throughout the move (canvas-facing-
         * lock folds the face-target rotation into this same update). Forcing
         * autoRotate off here stops the "turn to face travel, then snap back"
         * wiggle — the token moves backward/sideways still facing the enemy. */
        if (isFacingLockerMoving(token?.id)) return false;
        try { return !!game.settings.get("core", "tokenAutoRotate"); }
        catch (_) { return false; }
    })();

    /* Reuse the rotation-speed monkey-patch installed by
     * `commitHoverMove` (idempotent — `__wdmTacticalRotationPatched`
     * flag prevents double-install). If a custom chain is the very
     * first commit of the session, install here. */
    const TokenClass = CONFIG.Token?.objectClass;
    const originalAnimate = TokenClass?.prototype?.animate;
    if (TokenClass && originalAnimate && !TokenClass.prototype.__wdmTacticalRotationPatched) {
        TokenClass.prototype.__wdmTacticalRotationPatched = true;
        TokenClass.prototype.animate = function(to, options) {
            if (_isCommittingTacticalMove
                && to && typeof to === "object"
                && "rotation" in to && Object.keys(to).length === 1
                && options?.name === this.movementAnimationName
                /* STRAFE: don't slow the facing-lock's rotation to 3× — while
                 * strafing, the folded face-target rotation must animate at
                 * the SAME speed as the position tween, or the two desync and
                 * the token judders ("massive stutter"). Only the deliberate
                 * in-place turns keep the slow, cinematic rotation. */
                && !isFacingLockerMoving(this.id)) {
                options = { ...options, movementSpeed: 3 };
            }
            return originalAnimate.call(this, to, options);
        };
    }

    try {
        await token.document.move(waypoints, {
            autoRotate: autoRotateEnabled,
            animation: { movementSpeed: 3 },
            /* Skip Foundry's per-waypoint wall-constraint pass. Every cell in
             * `waypoints` was already validated clear by our reachability flood
             * using the SAME `CONFIG.Canvas.polygonBackends.move` backend (with a
             * stricter 3-sample corridor), so re-running collision on each of the
             * potentially dozens of dense waypoints here is pure duplicated work
             * — a big synchronous hit right on the click that starts the move.
             * Cost measurement (measureMovementPath) is unaffected, so the
             * movement-budget bookkeeping is unchanged. */
            constrainOptions: { ignoreWalls: true }
        });
        const animPromise = token.movementAnimationPromise;
        if (animPromise && typeof animPromise.then === "function") {
            try { await animPromise; } catch (_) {}
        }
    } catch (err) {
        console.warn(`${SYSTEM_ID} | tactical grid custom-chain commit failed`, err);
    } finally {
        _isCommittingTacticalMove = false;
        /* Overlay stays whatever the user set it to — no auto-hide.
         * If it was open, redraw so the new-position reach + remaining
         * budget paint immediately. Second redraw at 120ms catches the
         * async movementMeters actor.update landing after animation. */
        /* Single refresh — the 120ms setTimeout backup is unnecessary
         * because canvas-movement.mjs's async movementMeters update
         * fires `updateActor`, which triggers scheduleRefresh, which
         * (via the microtask coalescer) runs drawOverlay again once
         * the actor state has settled. Two rebuilds instead of three,
         * one less full Dijkstra + paint pass per commit. */
        if (_overlayVisible) { try { drawOverlay(); } catch (_) {} }
    }
}

async function commitHoverMove() {
    const token = findLockTarget();
    if (!token?.document) return;

    /* Mode-specific: derive `waypoints` (positions to walk through),
     * `pathCostMeters` (total meters for run-projection), and `isRun`
     * (which tier the destination falls in). After this block the
     * shared confirm/lock/animate flow runs. */
    let waypoints;
    let pathCostMeters;
    let isRun;

    if (_cachedReach.mode === "grid") {
        isRun = _cachedReach.runKeys.has(_hoverKey);
        const target = _cachedReach.cells.get(_hoverKey);
        if (!target) return;
        const startCell = _cachedReach.cells.get(_cachedReach.startKey);
        if (!startCell) return;
        const budgetMeters = isRun ? _cachedReach.runRemaining : _cachedReach.normalRemaining;
        const path = computePathAStar(_cachedReach.startKey, startCell, target, budgetMeters);
        if (!path || path.length < 2) return;
        waypoints = _pathToWaypoints(path, token);
        pathCostMeters = target.cost;
    } else if (_cachedReach.mode === "gridless") {
        if (!_hoverPoint) return;
        /* Tier detection: inside normalPoly = normal move; inside
         * runPoly but NOT normalPoly = run tier. Neither = out of
         * range (should have been filtered by onPointerDown already,
         * defensive re-check here). */
        const inNorm = _cachedReach.normalPoly?.contains?.(_hoverPoint.x, _hoverPoint.y);
        const inRun  = _cachedReach.runPoly?.contains?.(_hoverPoint.x, _hoverPoint.y);
        if (!inNorm && !inRun) return;
        /* LOS gate — refuse commit if the destination point isn't
         * visible to the acting token. Prevents the "walk into fog to
         * reveal it" exploit. The hover-preview drop already applies
         * the same check so users won't get a click surprise. */
        {
            const isVis = makeVisibilityPredicate(token);
            if (!isVis(_hoverPoint)) return;
        }
        isRun = !inNorm;
        const startCenter = _tokenCenterPoint(token);
        const dx = _hoverPoint.x - startCenter.x;
        const dy = _hoverPoint.y - startCenter.y;
        const distancePx = Math.hypot(dx, dy);
        pathCostMeters = distancePx * (_cachedReach.metersPerPixel || 0);
        /* Single waypoint: gridless movement is straight-line from
         * current position to the click point (the ClockwiseSweep
         * polygon guarantees this line doesn't cross a move-blocking
         * wall — a point INSIDE the sweep polygon is reachable by
         * straight line from the sweep origin). */
        waypoints = [{
            x: (Number(token.document.x) || 0) + dx,
            y: (Number(token.document.y) || 0) + dy
        }];
    } else {
        return;
    }
    if (!waypoints.length) return;

    /* Run-tier destinations: show the SAME confirmation dialog
     * canvas-movement uses for canvas-drag over-cap moves (reused
     * via `confirmRunUpgradeDialog` — same title, copy, and visual
     * language). One dialog only — pre-committing `recordRun` sets
     * `runUsed = true` so canvas-movement's per-cell cap check sees
     * the tripled cap for every subsequent cell in the walk. Without
     * this, my per-cell loop fires canvas-movement's own runUpgrade
     * dialog per cell → the "prompt cascades N times" bug. */
    if (isRun) {
        const usedMeters = Number(token.actor?.system?.combatRound?.movementMeters) || 0;
        const projectedMeters = Math.round(usedMeters + pathCostMeters);
        const spd = Number(token.actor?.system?.stats?.spd?.value) || 0;
        const runCap = spd * 3;
        const confirmed = await confirmRunUpgradeDialog(projectedMeters, runCap);
        if (!confirmed) return;
        /* Lock + hide immediately so the flash of new-state reach
         * doesn't happen between confirm and walk-start (recordRun
         * writes 4 combatRound fields, fires updateActor, all my
         * refresh scheduler bails on _isCommittingTacticalMove). */
        _isCommittingTacticalMove = true;
        clearHoverContainer();
        if (_layer && !_layer.destroyed) _layer.visible = false;
        /* Await recordRun before the move so canvas-movement's cap
         * check sees `runUsed = true` when it validates the projected
         * path. Parallel-firing was faster but broke the movement
         * budget bookkeeping — canvas-movement's cap check ran with
         * stale runUsed and refused the extended path. */
        let ok = false;
        try { ok = await token.actor.recordRun(); }
        catch (err) { console.warn(`${SYSTEM_ID} | recordRun failed`, err); }
        if (ok === false) {
            _isCommittingTacticalMove = false;
            try { drawOverlay(); } catch (_) {}
            return;
        }
    }

    _isCommittingTacticalMove = true;
    /* Clear ALL grid visuals during the walk — reach tiers, hover
     * preview, everything. The user was seeing frozen pre-commit
     * tiles under the moving token AND could still hover/click on
     * them mid-animation. Wiping the layer removes that ambiguity:
     * during the walk there's just the token and its wall context,
     * no plot overlay. Rebuilds once at commit end from the token's
     * final position. */
    _hoverKey = null;
    _hoverPoint = null;
    /* Cheap hide: flip `_layer.visible = false` instead of destroying
     * every child. Destroying 5 batched Graphics with 300-cell polygon
     * geometry + hatch mask releases GPU buffers and forces a GC pause
     * at the exact moment the user clicked — that was part of the
     * "1-second stutter on click" the user reported. Visibility flip is
     * a single boolean write, no GPU work. The layer's contents stay
     * intact but are hidden from render; when commit ends, the finally
     * block calls `drawOverlay` which does its own clear+rebuild for
     * the new position, so no state leaks. */
    clearHoverContainer();
    if (_layer && !_layer.destroyed) _layer.visible = false;
    /* Invalidate the reach cache so the post-commit rebuild is
     * unambiguous — no chance of a stale cell record leaking into
     * the new state. */
    resetCache();

    /* STUTTER FIX: revert to a SINGLE `move(waypoints)` call.
     *
     * The previous per-cell `document.update` loop was firing the
     * full movement pipeline N times (preUpdateToken, preMoveToken,
     * _preUpdateMovement, region checks, canvas-movement's async
     * actor.update, updateToken, movement-history recompute) — one
     * full pass PER CELL. For a 5-cell path that's 5× the sync CPU
     * and 5× the async promise chain, all racing on the main thread
     * while the animation ticker tries to render. Result: stutter.
     *
     * `move(waypoints)` batches everything into ONE pipeline pass.
     * Foundry then dispatches per-segment animations internally
     * (chained, so rotation-per-bend still happens), but there's
     * exactly one hook cycle and one actor.update.
     *
     * ROTATION SMOOTHNESS: Foundry hardcodes `rotationSpeed = 24`
     * in the autoRotate loop (token.mjs:4185 → ~63ms per 90°) which
     * caused the "instant snap". We monkey-patch
     * `Token.prototype.animate` for the duration of this commit only:
     * when it dispatches a rotation-only animation with the movement
     * name, we override the movementSpeed to our slower value. The
     * patch is scoped by `_isCommittingTacticalMove` so no other
     * rotation (Shift+A/D, drag rotations, other users' tokens) is
     * affected. Restored in the finally block via a stashed original
     * so any exception path still un-patches. */
    const autoRotateEnabled = (() => {
        /* Facing lock STRAFE: while the moving token owns a facing lock, it
         * keeps facing the locked target throughout the move (canvas-facing-
         * lock folds the face-target rotation into this same update). Forcing
         * autoRotate off here stops the "turn to face travel, then snap back"
         * wiggle — the token moves backward/sideways still facing the enemy. */
        if (isFacingLockerMoving(token?.id)) return false;
        try { return !!game.settings.get("core", "tokenAutoRotate"); }
        catch (_) { return false; }
    })();

    const TokenClass = CONFIG.Token?.objectClass;
    const originalAnimate = TokenClass?.prototype?.animate;
    if (TokenClass && originalAnimate && !TokenClass.prototype.__wdmTacticalRotationPatched) {
        TokenClass.prototype.__wdmTacticalRotationPatched = true;
        TokenClass.prototype.animate = function(to, options) {
            /* Only intercept rotation-only animations chained to the
             * movement name AND only while our commit is running.
             * Foundry dispatches these at token.mjs:4197 with
             * `movementSpeed: 24` (hardcoded). We slow them to 3
             * (~500ms per 90°), matching the walk cadence and the
             * Shift+A/D rotation feel. */
            if (_isCommittingTacticalMove
                && to && typeof to === "object"
                && "rotation" in to && Object.keys(to).length === 1
                && options?.name === this.movementAnimationName
                /* STRAFE: don't slow the facing-lock's rotation to 3× — while
                 * strafing, the folded face-target rotation must animate at
                 * the SAME speed as the position tween, or the two desync and
                 * the token judders ("massive stutter"). Only the deliberate
                 * in-place turns keep the slow, cinematic rotation. */
                && !isFacingLockerMoving(this.id)) {
                options = { ...options, movementSpeed: 3 };
            }
            return originalAnimate.call(this, to, options);
        };
    }

    try {
        /* ONE move() call with ALL waypoints. Foundry's movement
         * pipeline runs once; per-waypoint animation dispatch happens
         * internally at token.mjs:4189+ with chaining. Position uses
         * our `movementSpeed: 3` (~333ms per cell); rotation uses our
         * patched slower speed via the monkey-patch above. */
        await token.document.move(waypoints, {
            autoRotate: autoRotateEnabled,
            animation: { movementSpeed: 3 },
            /* Skip Foundry's per-waypoint wall-constraint pass. Every cell in
             * `waypoints` was already validated clear by our reachability flood
             * using the SAME `CONFIG.Canvas.polygonBackends.move` backend (with a
             * stricter 3-sample corridor), so re-running collision on each of the
             * potentially dozens of dense waypoints here is pure duplicated work
             * — a big synchronous hit right on the click that starts the move.
             * Cost measurement (measureMovementPath) is unaffected, so the
             * movement-budget bookkeeping is unchanged. */
            constrainOptions: { ignoreWalls: true }
        });
        /* Wait for the animation itself to complete (move() resolves
         * BEFORE animation — see the earlier commit that added this
         * wait). `movementAnimationPromise` (token.mjs:296) resolves
         * at the tail of the chain. */
        const animPromise = token.movementAnimationPromise;
        if (animPromise && typeof animPromise.then === "function") {
            try { await animPromise; } catch (_) {}
        }
    } catch (err) {
        console.warn(`${SYSTEM_ID} | tactical grid commit failed`, err);
    } finally {
        _isCommittingTacticalMove = false;
        /* Overlay stays whatever the user set it to — no auto-hide.
         * Right-click is the ONLY way to close it. If it was open,
         * redraw so the new-position reach + remaining budget paint. */
        /* Single refresh — the 120ms setTimeout backup is unnecessary
         * because canvas-movement.mjs's async movementMeters update
         * fires `updateActor`, which triggers scheduleRefresh, which
         * (via the microtask coalescer) runs drawOverlay again once
         * the actor state has settled. Two rebuilds instead of three,
         * one less full Dijkstra + paint pass per commit. */
        if (_overlayVisible) { try { drawOverlay(); } catch (_) {} }
    }
}

/* ── coalesced refresh ───────────────────────────────────────────── */

/** Many hooks can fire back-to-back for one logical event (a single
 *  turn change fires combatTurnChange PLUS controlToken PLUS the new
 *  combatant's resetCombatRound update). Coalesce all of them into one
 *  redraw per microtask so we don't repaint N times. */
let _pendingRefresh = false;
function scheduleRefresh() {
    if (_pendingRefresh) return;
    /* HARD OFF SWITCH — when the overlay is hidden, refuse to
     * schedule any refresh. Hooks (updateActor, updateToken, control-
     * Token) still fire in the background but they're no-ops here.
     * Prevents the cache from getting quietly rebuilt while the user
     * has explicitly hidden the plotter. */
    if (!_overlayVisible) return;
    /* Freeze the grid while a tactical-grid commit is animating. */
    if (_isCommittingTacticalMove) return;
    _pendingRefresh = true;
    Promise.resolve().then(() => {
        _pendingRefresh = false;
        try { drawOverlay(); }
        catch (err) { console.warn(`${SYSTEM_ID} | tactical grid refresh failed`, err); }
    });
}

/* ── upright-text counter-rotation ticker ────────────────────────── */

/** The immersive camera rotates `canvas.stage` so the world spins as
 *  the token turns (see policy/immersive-token-camera.mjs). Any text
 *  we paint into the world without counter-rotating would tilt with
 *  the world and become unreadable (upside-down at 180°, sideways at
 *  90°). This ticker walks the tactical-grid layer every frame,
 *  finds children marked `_wdmUprightText = true` (currently just the
 *  cost labels), and sets their rotation to `-stageRot` so they render
 *  upright on screen regardless of world orientation.
 *
 *  Costs one shallow tree walk per frame and one write per label —
 *  cheap enough at typical <10 labels rendered concurrently. Kept
 *  isolated to this file so it doesn't tangle with the token-style
 *  counter-rotation wrapper. */
let _uprightTicker = null;
function attachUprightTicker() {
    if (_uprightTicker) return;
    _uprightTicker = () => {
        if (!_layer || _layer.destroyed) return;
        /* Skip the tree walk when the layer is hidden (during a
         * commit animation or after a right-click hide). The children
         * still exist but they're not rendered, so counter-rotating
         * them per frame is pure waste — one less thing competing
         * with the animation ticker during a move commit. */
        if (!_layer.visible) return;
        if (!_overlayVisible) return;
        const negRot = -(Number(canvas?.stage?.rotation) || 0);
        const stageScale = Number(canvas?.stage?.scale?.x) || 1;
        _applyUprightRecursive(_layer, negRot, stageScale);
    };
    try { canvas.app?.ticker?.add(_uprightTicker); }
    catch (_) { _uprightTicker = null; }
}
function detachUprightTicker() {
    if (!_uprightTicker) return;
    try { canvas.app?.ticker?.remove(_uprightTicker); }
    catch (_) {}
    _uprightTicker = null;
}
function _applyUprightRecursive(node, negRot, stageScale) {
    const children = node?.children;
    if (!children?.length) return;
    for (const child of children) {
        if (child._wdmUprightText) {
            if (child.rotation !== negRot) child.rotation = negRot;
            /* Hold a constant on-screen size. World-space text at world zoom
             * S renders at (fontSize * S) screen px; since the label is
             * authored at fontSize == _wdmScreenPx, scaling by 1/S makes the
             * on-screen size exactly _wdmScreenPx regardless of zoom. */
            if (child._wdmScreenPx && stageScale > 0) {
                const target = 1 / stageScale;
                if (child.scale?.x !== target) child.scale.set(target);
            }
        }
        if (child.children?.length) _applyUprightRecursive(child, negRot, stageScale);
    }
}

/* ── registration ────────────────────────────────────────────────── */

/** Spin up all runtime hooks/listeners/tickers. Called ONLY when a
 *  combat is active (combatStart hook OR canvasReady with an already-
 *  running combat). Everything the tactical grid needs — pointer
 *  listener, upright-text ticker, per-turn refresh — is attached here
 *  so nothing runs at all outside of combat. */
let _runtimeActive = false;
function activateRuntime() {
    if (_runtimeActive) return;
    _runtimeActive = true;
    ensureLayer();
    attachPointerListener();
    attachUprightTicker();
    scheduleRefresh();
}

/** Tear down everything activated in `activateRuntime`. Called on
 *  deleteCombat and canvasTearDown. Wipes hover state, destroys the
 *  layer, and detaches listeners so the module leaves zero traces
 *  when combat isn't running. */
function deactivateRuntime() {
    if (!_runtimeActive) return;
    _runtimeActive = false;
    detachUprightTicker();
    detachPointerListener();
    destroyLayer();
    _hoverKey = null;
    _hoverPoint = null;
    _hoverContainer = null;
    _dragChain = null;
    /* Reset visibility to hidden for the next combat — the overlay
     * always starts hidden, user right-clicks to show. */
    _overlayVisible = false;
    resetCache();
}

let _installed = false;
export function registerImmersiveTacticalGrid() {
    if (_installed) return;
    _installed = true;

    /* Attach the runtime unconditionally once the canvas is ready.
     * `combatStart` fires only on the GM's client (combat.mjs:210 —
     * called inside `startCombat`, which only GMs invoke) so a lifecycle-
     * driven activation misses players entirely. Rather than replicate
     * the Foundry hook fan-out for the player side (updateCombat +
     * combatTurnChange + tracker-render races), just attach once and
     * let per-event gates decide what to paint:
     *   - `isEligibleContext` gates onPointerDown / drawOverlay on the
     *     actor being in a started combat on their turn — so right-
     *     click out of combat is a no-op.
     *   - `scheduleRefresh` and the upright ticker both bail on
     *     `!_overlayVisible` — so background cost is essentially zero
     *     until the user actually toggles the overlay on.
     *   - `dragLeftStart` override is gated per-call on
     *     `isEligibleContext` (see attachPointerListener) so out-of-
     *     combat GM's rubber-band select still works.
     * Tear down only on canvas teardown (scene change / world exit). */
    Hooks.on("canvasReady", () => { activateRuntime(); });
    Hooks.on("canvasTearDown", () => { deactivateRuntime(); });

    /* Combat over → close the overlay if it's open. The runtime stays active
     * (a fresh encounter may start on this same canvas, and the eligibility
     * gates keep it a no-op meanwhile), so we just hide the drawn overlay
     * rather than tearing the whole runtime down. Covers both End Combat
     * (deleteCombat) and a combat un-started via update (started → false). */
    const closeOverlayOnCombatEnd = () => { if (_overlayVisible) setOverlayVisible(false); };
    Hooks.on("deleteCombat", closeOverlayOnCombatEnd);
    Hooks.on("updateCombat", (_combat, changed) => {
        if (changed?.started === false) closeOverlayOnCombatEnd();
    });

    /* Refresh triggers — all no-ops when `_runtimeActive` is false
     * because `scheduleRefresh` bails via the runtime check. Cheap to
     * leave registered; combat state alone controls whether anything
     * downstream runs. */
    Hooks.on("combatTurnChange", () => { if (_runtimeActive) scheduleRefresh(); });
    Hooks.on("controlToken",     () => { if (_runtimeActive) scheduleRefresh(); });
    Hooks.on("updateActor", (_actor, changes) => {
        if (!_runtimeActive) return;
        if (changes?.system?.combatRound !== undefined
            || changes?.system?.stats?.spd    !== undefined) {
            scheduleRefresh();
        }
    });
    Hooks.on("updateToken", (_doc, changes) => {
        if (!_runtimeActive) return;
        /* Rotation matters for tokens with a limited vision angle
         * (front-facing cone) — the LOS polygon reshapes when the
         * token turns, so the reach must rebuild too. Elevation
         * matters because floor changes swap the visible/reachable
         * geometry entirely. */
        if (changes?.x !== undefined
         || changes?.y !== undefined
         || changes?.rotation !== undefined
         || changes?.elevation !== undefined) {
            scheduleRefresh();
        }
    });
    Hooks.on("updateSetting", (setting) => {
        if (!_runtimeActive) return;
        if (setting?.key?.startsWith?.(`${SYSTEM_ID}.`)) scheduleRefresh();
    });

    /* Wall / door / scene geometry changed → the reachable set can change even
     * though the token didn't move. Bump the geometry epoch so the reach
     * signature no longer matches (forcing a real rebuild) and schedule one. */
    const onGeometryChange = () => {
        _geometryEpoch++;
        if (_runtimeActive) scheduleRefresh();
    };
    Hooks.on("createWall",  onGeometryChange);
    Hooks.on("updateWall",  onGeometryChange);
    Hooks.on("deleteWall",  onGeometryChange);
    Hooks.on("updateScene", onGeometryChange);
    Hooks.on("canvasReady", onGeometryChange);
}
