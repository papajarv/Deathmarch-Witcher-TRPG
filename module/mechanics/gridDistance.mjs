/**
 * Distance, on a grid and without one.
 *
 * The system counts reach and range in TILES: Chebyshev distance between token
 * centres, so a diagonal neighbour is one tile away exactly like an orthogonal
 * one. That is the Witcher grid model and `canvas.grid.measureDistance` is
 * deliberately not used for it (it honours the scene's diagonal-cost rule and
 * would call a diagonal 1.5 tiles).
 *
 * None of that survives a GRIDLESS scene. There are no tiles to count, and
 * Foundry's offset APIs switch to speaking in PIXELS — one "offset" per point —
 * so any code that walks cells walks the whole map a pixel at a time. The
 * targeting overlay used to refuse to open at all rather than deal with it, and
 * the area preview did not refuse, which is how a spell template turned into a
 * flat block of colour made of ~80,000 hairline fills.
 *
 * The fix is to stop asking the grid and start asking the distance. Everything
 * the rules actually need — is this within reach, which range band is it in,
 * who does the blast catch — is a question about METRES. On a gridded scene
 * these helpers reproduce the tile answer exactly, so nothing about existing
 * play changes; on a gridless one they answer in a straight line.
 *
 * Sizes are handled the same way in both modes. A tile-counted reach measures
 * to the nearest cell a big token stands on, so a 2x2 monster is reachable from
 * its edge rather than its middle. Gridless has no cells to measure to, so the
 * token's radius BEYOND a medium token's half-tile is subtracted instead —
 * which gives the same answer for the medium tokens that make up most of a
 * fight, and keeps a large one reachable from its flank.
 */

const SYSTEM_ID = "witcher-ttrpg-death-march";

/** True when the scene has no grid (`CONST.GRID_TYPES.GRIDLESS === 0`). */
export function isGridless() {
    return (Number(canvas?.scene?.grid?.type) || 0) === 0;
}

/** Scene grid square in pixels. Defined even on a gridless scene — Foundry
 *  still uses it as the unit token sizes are expressed in. */
export function gridPx() {
    return Number(canvas?.scene?.grid?.size) || 100;
}

/** Scene distance units per grid square (metres, in this system). */
export function gridMetres() {
    return Number(canvas?.scene?.grid?.distance) || 1.5;
}

/** Metres → pixels at the current scene scale. */
export function metresToPx(m) {
    return (Number(m) || 0) * gridPx() / gridMetres();
}

/** Pixels → metres at the current scene scale. */
export function pxToMetres(px) {
    return (Number(px) || 0) / gridPx() * gridMetres();
}

/** A point {x, y} for a token placeable, a token document, or a bare point. */
function pointOf(thing) {
    if (!thing) return null;
    const c = thing.center ?? thing;
    const x = Number(c?.x), y = Number(c?.y);
    return (Number.isFinite(x) && Number.isFinite(y)) ? { x, y } : null;
}

/**
 * How far a token's own body extends past a medium token's, in metres.
 *
 * Zero for anything a single square or smaller, which is the overwhelming
 * majority of what is on the board — so on a gridless scene a normal fight
 * measures plain centre-to-centre, exactly as the Chebyshev model does on a
 * grid. A 2x2 creature contributes half a square, a 3x3 a whole one, so reach
 * lands on its flank instead of demanding you stand in its middle.
 */
export function oversizeMetres(token) {
    if (!token) return 0;
    let radiusPx;
    const b = token.bounds;
    if (b && Number.isFinite(b.width) && b.width > 0) radiusPx = Math.min(b.width, b.height) / 2;
    else {
        const w = Number(token.document?.width ?? token.width) || 1;
        const h = Number(token.document?.height ?? token.height) || 1;
        radiusPx = Math.min(w, h) * gridPx() / 2;
    }
    return Math.max(0, pxToMetres(radiusPx) - gridMetres() / 2);
}

/**
 * Distance in metres between two things (tokens or bare points), by the rule
 * that fits the scene.
 *
 * GRIDDED   — Chebyshev between centres, converted to metres. Byte-for-byte
 *             the number the reach gate, the range brackets and the targeting
 *             overlay already used, so a gridded scene plays identically.
 * GRIDLESS  — Euclidean between centres, less each side's oversize (above).
 *
 * Returns null when either end has no usable position.
 */
export function separationMetres(a, b) {
    const pa = pointOf(a), pb = pointOf(b);
    if (!pa || !pb) return null;
    const dx = pa.x - pb.x, dy = pa.y - pb.y;
    if (!isGridless()) return pxToMetres(Math.max(Math.abs(dx), Math.abs(dy)));
    const centre = pxToMetres(Math.hypot(dx, dy));
    return Math.max(0, centre - oversizeMetres(a) - oversizeMetres(b));
}

/**
 * Melee reach in METRES for a weapon, from its reach qualities.
 *
 * The tile form is `1 + floor(reachExtendMeters / gridMetres)` tiles; this is
 * that same number expressed as a distance, so the two agree on a grid. A plain
 * weapon reaches one square; Long / Superior / Extreme Reach add their metres on
 * top. `graceMetres` is the "half tiles are still tiles" allowance the overlay
 * and the attack gate both apply — kept here so they cannot drift apart.
 */
export function meleeReachMetres(reachExtendMeters) {
    const ext = Number(reachExtendMeters) || 0;
    const g = gridMetres();
    if (!isGridless()) return (1 + Math.floor(ext / g)) * g;
    return g + ext;
}

/** The half-tile grace both the overlay and the attack gate allow. */
export function graceMetres() {
    return gridMetres() * 0.5;
}

void SYSTEM_ID;
