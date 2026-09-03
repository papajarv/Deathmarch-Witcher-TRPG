/**
 * castArea — MeasuredTemplate placement + token harvest for area spells.
 *
 * When castSpellMixin resolves an area spell (cone / radius / cube /
 * line) with NO targets picked, `pickAreaTargets` drops an interactive
 * template preview and honours the item's `areaAnchor` schema field:
 *
 *   anchor "caster"  — origin LOCKED to the caster's token; mousemove
 *                      aims the direction (the shape spins around the
 *                      caster like an axis); wheel provides fine
 *                      adjust. Signs and self-emanating cones/lines/
 *                      domes (Aard, Igni, Quen, Aard Sweep).
 *   anchor "free"    — origin free to place; mousemove snaps to grid
 *                      centers; wheel rotates. Ranged zone spells
 *                      (Cinder Door, Lightning Storm, Magic Flare).
 *
 * Live targeting: while the preview is up, tokens whose center falls
 * inside the current shape are flagged via `token.setTarget(true)` so
 * Foundry's own yellow reticle renders on them. This gives a
 * continuously-updated highlight as the player aims/moves the
 * template. Any target added by the preview is un-set on cancel and
 * on commit — castSpellMixin uses the returned actor array, not the
 * reticle state.
 *
 * On commit the preview's PIXI shape + origin (x, y) is captured, the
 * preview object is destroyed, and every token in the scene is tested
 * against the captured shape. Actors whose token center falls inside
 * are returned, deduped by uuid. Caller feeds the array into the same
 * defense fan-out flow that manual targeting uses.
 *
 * Preview-only, no persist: earlier revisions called
 * `canvas.scene.createEmbeddedDocuments("MeasuredTemplate", ...)` then
 * `placed.delete()` — the delete could silently fail (permission
 * mismatch, render race) leaving stale outlines on the canvas. This
 * version never creates a scene document; the preview lives only for
 * the duration of the click loop.
 *
 * Skipped shapes: "touch" (single-target physical), "self" (caster
 * only), "none" (no area). Those fall through to `getActorTarget()`.
 *
 * Implementation: subclass `CONFIG.MeasuredTemplate.objectClass` so the
 * preview lives inside Foundry's own PlaceableObject lifecycle
 * (`draw()`, `refresh()`, layer.preview membership). Attempting to run
 * an inline `preview.draw()` without inheriting the placeable class
 * silently fails in Foundry v13 — the PIXI draw pipeline expects a
 * properly-constructed placeable with document + shape wiring already
 * in place. Extending the class inherits the shape-recomputation
 * machinery for free, so wheel-rotate / mousemove refreshes redraw
 * correctly.
 */

import { t, tFormat } from "../chrome/lib/i18n.js";
import { parseRangeMeters } from "../applications/castDialog.mjs";
import { hideMovementOverlay } from "../policy/immersive-tactical-grid.mjs";
import { isGridless } from "./gridDistance.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";

/* Tile style — kept IDENTICAL to the weapon target-select overlay
 * (policy/weapon-target-overlay.mjs) so aiming a spell and aiming a weapon
 * read the same: same red, same opacities, same per-cell polygon + stroke.
 *   base   = the in-range placement tiles (like the overlay's reachable cells)
 *   target = the cells the AoE actually covers (like the overlay's target cell) */
const TILE_COLOR         = 0xa25050;   // --wdm-red-bright
const TILE_FILL          = 0.16;
const TILE_FILL_TARGET   = 0.34;
const TILE_STROKE_ALPHA  = 0.55;
const TILE_STROKE_WIDTH  = 2;

/* True when the scene has no grid (grid type 0). Matches the helper in
 * clinch.mjs and the guard `beginWeaponTargeting` opens with.
 *
 * This matters more here than it reads. On a GRIDLESS scene Foundry's
 * `getOffsetRange` / `getOffset` speak in PIXELS, not cells — an "offset" is a
 * point. Every cell loop in this file then iterates once per pixel and paints a
 * 1x1 polygon for each: a 1-tile melee reach measured 160,000 offsets, and an
 * area spell's range underlay covers the map in hundreds of thousands of
 * hairline fills that composite into one flat block of colour, at a framerate
 * that reads as the client hanging. That is the "solid colour block" and the
 * bomb-throw lag, and it is a rendering artefact of the missing grid rather
 * than anything wrong with the aim.
 *
 * Gridless is not a supported layout for this system's tactical rules (tile
 * targeting is mandatory, reach and range bands are counted in tiles), so the
 * response is to draw the aim as plain geometry and let the shape itself carry
 * the area, not to reconstruct a tile UX without tiles. */
const isGridlessScene = isGridless;

/* Paint a computed template shape directly, in world space. The shapes from
 * `_computeShape` are local to the template origin, so everything shifts by
 * (ox, oy). Used only on gridless scenes, where there are no cells to fill. */
function drawShapeInto(g, shape, ox, oy) {
    if (!shape) return;
    if (shape instanceof PIXI.Circle)         g.drawCircle(ox + shape.x, oy + shape.y, shape.radius);
    else if (shape instanceof PIXI.Rectangle) g.drawRect(ox + shape.x, oy + shape.y, shape.width, shape.height);
    else if (Array.isArray(shape.points) && shape.points.length >= 6) {
        g.drawPolygon(shape.points.map((v, i) => (i % 2 === 0 ? v + ox : v + oy)));
    }
}

/* Spell range → pixels for the free-placement range clamp. Spells take no
 * range-band penalty (per house rule) — a listed range is a hard cap on how
 * far a FREE-anchored template can be dropped; caster-anchored cones ignore it
 * (they emanate from the caster). Returns null when the spell has no finite
 * positive range. */
function spellRangePx(item) {
    try {
        const rM = parseRangeMeters(item);
        if (!Number.isFinite(rM) || rM <= 0) return null;
        const gs = Number(canvas.dimensions?.size) || 100;
        const gd = Number(canvas.dimensions?.distance) || 1;
        return (rM * gs) / gd;
    } catch (_) { return null; }
}

/* Witcher area shape → Foundry MeasuredTemplate.t enum. */
const SHAPE_TO_FOUNDRY = Object.freeze({
    cone:   "cone",
    radius: "circle",
    cube:   "rect",
    line:   "ray"
});

/* Free-text range parser — many legacy spells were authored with the
 * shape in the RANGE field ("2m Cone", "3-meter radius", "5m line")
 * instead of the structured areaShape / areaSize fields. This lets
 * those spells behave as areas without editing every item. Runs ONLY
 * when the schema fields are unset ("none" / 0). */
const RANGE_AREA_RE = /(\d+(?:\.\d+)?)\s*(?:m|meters?)[\s\-]*(cone|radius|sphere|circle|cube|line|ray)/i;
const RANGE_SHAPE_ALIASES = Object.freeze({
    sphere: "radius",
    circle: "radius",
    ray:    "line"
});

/**
 * Return effective { shape, size } for an item, preferring the schema
 * fields when set. Falls back to parsing the free-text range string
 * for legacy spells authored before the schema fields existed. Returns
 * `{ shape: "none", size: 0 }` when neither yields an area.
 */
/* Distinct sentinel returned when the user actively CANCELS the template aim
 * (right-click / Esc), as opposed to a guard-bail (no canvas token, unmappable
 * shape) or a placed-but-missed hit. The caster reads this to abort the whole
 * cast — no roll, no STA, no action — vs. falling through to a plain cast. */
export const AREA_CANCELLED = "wdm-area-cancelled";

export function resolveAreaInfo(item) {
    const rawShape = String(item?.system?.areaShape ?? "none");
    const rawSize  = Number(item?.system?.areaSize) || 0;
    if (rawShape && rawShape !== "none" && rawSize > 0) {
        return { shape: rawShape, size: rawSize };
    }
    /* Fallback: extract "Nm cone" / "Nm radius" / "Nm line" from the
     * range field. Only accepts positive N; unknown shape aliases
     * ("sphere" → "radius", "ray" → "line") normalize into the four
     * mapped enum values. */
    const rangeStr = String(item?.system?.range ?? "");
    const match    = rangeStr.match(RANGE_AREA_RE);
    if (!match) return { shape: "none", size: 0 };
    const parsedSize  = Number(match[1]) || 0;
    const parsedShape = String(match[2]).toLowerCase();
    const shape       = RANGE_SHAPE_ALIASES[parsedShape] ?? parsedShape;
    if (parsedSize <= 0 || !SHAPE_TO_FOUNDRY[shape]) return { shape: "none", size: 0 };
    return { shape, size: parsedSize };
}

/**
 * Public entry point — present an interactive template preview and
 * resolve to an array of Actor documents whose tokens intersect the
 * placed template. Empty array on cancel, missing shape/size, or no
 * active canvas.
 *
 * @param {object} args
 * @param {Actor}  args.actor  — caster (used to origin the preview on their token)
 * @param {Item}   args.item   — spell/hex item (system.areaShape, areaSize read here)
 */
export async function pickAreaTargets({ actor, item }) {
    if (!canvas?.scene || !canvas?.ready) return [];
    if (!actor || !item) return [];
    /* Opening AoE aiming supersedes the movement plotter — close it so the two
     * overlays don't stack on the canvas (matches beginWeaponTargeting for
     * single-target casts). */
    try { hideMovementOverlay(); } catch (_) {}

    const { shape, size } = resolveAreaInfo(item);
    const foundryType = SHAPE_TO_FOUNDRY[shape];
    if (!foundryType || size <= 0) return [];

    /* No-canvas / theater-of-mind guard: if the caster has no active
     * token on this scene, the template is meaningless (there's
     * nothing to project it FROM). Bail out with an empty array so
     * castSpellMixin skips the fan-out entirely and the cast resolves
     * as a plain spellcasting roll with the item's effect description
     * on the chat card. Same guard fires when the scene simply has
     * no tokens placed at all. */
    const casterToken = actor.getActiveTokens?.()?.[0] ?? null;
    const anyTokens = (canvas.tokens?.placeables?.length ?? 0) > 0;
    if (!casterToken || !anyTokens) return [];
    const origin = casterToken.center;

    /* Cone sizing (user spec): "an Nm cone" reaches N metres forward
     * AND N metres to each side at the far edge. Foundry's cone
     * `distance` is the SLANT (ray) length from apex, so with a 90°
     * angle we multiply by √2 to make the endpoint at ±45° land at
     * (N, ±N) — the far corners the user asked for. The arc between
     * the rays extends slightly past N on the direction axis
     * (radius = N√2 at 0° gives x ≈ 1.41N), which is visually the
     * "curved wedge" the user prefers to a flat triangle — and, more
     * importantly, populates the polygon with 30 vertices spread along
     * that arc so `shapeHitsTokenCell`'s vertex-in-rect test reliably
     * catches every diagonal cell whose center sits at (N, ±N). A
     * strict triangle put the vertex EXACTLY at the diagonal tile
     * center, which is a knife-edge case that PIXI.Polygon.contains
     * misses at boundaries.
     * Non-cone shapes keep their raw size. */
    const templateData = {
        t: foundryType,
        user: game.user?.id ?? null,
        distance: foundryType === "cone" ? size * Math.SQRT2 : size,
        direction: 0,
        x: origin.x,
        y: origin.y,
        fillColor: "#c8a878",
        flags: { [SYSTEM_ID]: { areaSpell: true, sourceItem: item.uuid } }
    };
    if (foundryType === "cone") templateData.angle = 90;
    /* 1m-wide beam matches how the system treats line spells. */
    if (foundryType === "ray")  templateData.width = 1;

    /* Anchor mode — controls whether the preview's origin is locked to
     * the caster ("caster") or free-placed anywhere ("free"). Default
     * "caster" matches the schema default. */
    const anchor = String(item?.system?.areaAnchor ?? "caster") === "free" ? "free" : "caster";

    const AreaTemplateClass = buildAreaTemplateClass();
    /* place() now resolves to { shape, x, y, direction, t } captured
     * from the preview at commit time, NOT a persisted scene document.
     * This avoids a whole class of "template never disappears" bugs
     * where the delete silently failed. The preview is destroyed
     * inside teardown() before place() resolves, so nothing is left
     * on the canvas at all. */
    /* Range gate — only for FREE-anchored templates (radius/cube dropped at a
     * point). Caster-anchored cones emanate from the caster, so their reach is
     * the cone size, not a placement range. Shows the range ring + clamps the
     * drop point to the spell's range. */
    const _rangePx = anchor === "free" ? spellRangePx(item) : null;
    const captured = await AreaTemplateClass.place({
        templateData,
        itemName: item.name,
        anchor,
        casterCenter: origin,
        casterToken,
        maxRangePx: _rangePx,
        showRangeRing: !!_rangePx
    });
    if (captured === AREA_CANCELLED) return AREA_CANCELLED;   // user aborted the aim
    if (!captured) return [];   // setup fail / no preview → plain cast, not abort
    /* Ignore Caster toggle (default ON = caster safe in their own AoE). When
     * OFF, don't exclude the caster's token — a caster caught in their own
     * blast takes the hit. */
    const _excludeCaster = item?.system?.areaExcludeCaster !== false;
    return harvestTokens(captured, { excludeTokenId: _excludeCaster ? (casterToken?.id ?? "") : "" });
}

/**
 * Persistent-zone entry point — same preview UX as pickAreaTargets
 * but returns the placement SNAPSHOT (x, y, direction, shape name,
 * size, foundryType) alongside the harvested actors, so
 * castSpellMixin can hand the snapshot to `createZoneTemplate` in
 * zoneEffects.mjs. Actors are still returned because a persistent
 * zone MAY still deal one-shot damage on placement (damagePer:
 * "cast") in addition to the ongoing zone effect.
 *
 * Returns null on cancel / missing area / no active token.
 *
 * @param {object} args
 * @param {Actor}  args.actor
 * @param {Item}   args.item
 * @returns {Promise&lt;{placement:{x,y,direction,shape,size,foundryType}, actors:Actor[]}|null&gt;}
 */
export async function pickAreaSnapshot({ actor, item }) {
    if (!canvas?.scene || !canvas?.ready) return null;
    if (!actor || !item) return null;
    /* Close the movement plotter when zone aiming opens — same as pickAreaTargets. */
    try { hideMovementOverlay(); } catch (_) {}

    const { shape, size } = resolveAreaInfo(item);
    const foundryType = SHAPE_TO_FOUNDRY[shape];
    if (!foundryType || size <= 0) return null;

    const casterToken = actor.getActiveTokens?.()?.[0] ?? null;
    const anyTokens = (canvas.tokens?.placeables?.length ?? 0) > 0;
    if (!casterToken || !anyTokens) return null;
    const origin = casterToken.center;

    /* Same cone slant scaling as pickAreaTargets — see the extended
     * comment above. Keeps the persistent-zone preview visually and
     * geometrically consistent with the one-shot cast preview. */
    const templateData = {
        t: foundryType,
        user: game.user?.id ?? null,
        distance: foundryType === "cone" ? size * Math.SQRT2 : size,
        direction: 0,
        x: origin.x,
        y: origin.y,
        fillColor: "#c8a878",
        flags: { [SYSTEM_ID]: { areaSpell: true, sourceItem: item.uuid } }
    };
    if (foundryType === "cone") templateData.angle = 90;
    if (foundryType === "ray")  templateData.width = 1;

    const anchor = String(item?.system?.areaAnchor ?? "caster") === "free" ? "free" : "caster";
    const AreaTemplateClass = buildAreaTemplateClass();
    /* Pass casterToken (FOV/LoS gating) + range gate, matching pickAreaTargets
     * so persistent-zone placement is constrained the same way. */
    const _rangePx = anchor === "free" ? spellRangePx(item) : null;
    const captured = await AreaTemplateClass.place({
        templateData, itemName: item.name, anchor, casterCenter: origin, casterToken,
        maxRangePx: _rangePx, showRangeRing: !!_rangePx
    });
    if (captured === AREA_CANCELLED) return AREA_CANCELLED;   // user aborted the aim
    if (!captured) return null;   // setup fail → plain cast, not abort
    /* Ignore Caster toggle — see pickAreaTargets. */
    const _excludeCaster = item?.system?.areaExcludeCaster !== false;
    const actors = harvestTokens(captured, { excludeTokenId: _excludeCaster ? (casterToken?.id ?? "") : "" });
    return {
        placement: {
            x:           captured.x,
            y:           captured.y,
            direction:   captured.direction,
            shape,
            size,
            foundryType
        },
        actors
    };
}

/** Segment-vs-segment intersection (proper, no floating-point-fudge). */
function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
    const denom = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
    if (denom === 0) return false;   /* parallel or collinear — no proper intersection */
    const u1 = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / denom;
    const u2 = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / denom;
    return u1 >= 0 && u1 <= 1 && u2 >= 0 && u2 <= 1;
}

/** Proper polygon-vs-token-cell intersection. Point sampling misses cases
 *  where a cone's edge slices across a cell without any sample point
 *  landing inside — the exact "cone is touching a tile but tile isn't
 *  selected" bug. This tests three overlap conditions in order:
 *
 *    1. any rect corner (or center) inside the polygon
 *    2. any polygon vertex inside the rect
 *    3. any polygon edge intersecting any rect edge
 *
 *  If none of these hits, the shapes are truly disjoint. This is the
 *  standard convex-vs-convex overlap test (cones are triangles, tokens
 *  are rectangles — both convex).
 *
 *  `cx, cy` — token center in TEMPLATE-LOCAL space (already translated).
 *  `halfW, halfH` — half the token's rendered footprint. */
function shapeHitsTokenCell(shape, cx, cy, halfW, halfH) {
    if (!shape) return false;
    const x0 = cx - halfW, x1 = cx + halfW;
    const y0 = cy - halfH, y1 = cy + halfH;

    /* 1. Rect corners + center — any inside polygon? */
    const testPoints = [
        [cx,  cy ],
        [x0,  y0], [x1,  y0], [x1,  y1], [x0,  y1]
    ];
    for (const [px, py] of testPoints) {
        try { if (shape.contains(px, py)) return true; } catch (_) {}
    }

    /* PIXI.Polygon exposes vertices as a flat [x0, y0, x1, y1, ...] array. */
    const pts = shape.points;
    if (!Array.isArray(pts) || pts.length < 4) return false;

    /* 2. Polygon vertex inside rect? */
    for (let i = 0; i < pts.length; i += 2) {
        const vx = pts[i], vy = pts[i + 1];
        if (vx >= x0 && vx <= x1 && vy >= y0 && vy <= y1) return true;
    }

    /* 3. Edge intersections. Rect edges (TL→TR, TR→BR, BR→BL, BL→TL) vs
     *    polygon edges (last vertex → first closes the loop). */
    const rectEdges = [
        [x0, y0, x1, y0],
        [x1, y0, x1, y1],
        [x1, y1, x0, y1],
        [x0, y1, x0, y0]
    ];
    for (let i = 0; i < pts.length; i += 2) {
        const j = (i + 2) % pts.length;
        const ex1 = pts[i],  ey1 = pts[i + 1];
        const ex2 = pts[j],  ey2 = pts[j + 1];
        for (const [rx1, ry1, rx2, ry2] of rectEdges) {
            if (segmentsIntersect(ex1, ey1, ex2, ey2, rx1, ry1, rx2, ry2)) return true;
        }
    }
    return false;
}

/** Strict "token cell centre is on the shape" test — the SAME 3×3 ±1px centre
 *  probe the tile highlight uses (_getGridHighlightPositions). Used for LINE
 *  (ray) spells only: a thin line at a diagonal angle can clip the corner of a
 *  diagonally-adjacent cell, and the generous convex-overlap test in
 *  `shapeHitsTokenCell` counts that graze as a hit — letting a line catch a
 *  token standing OUTSIDE the visible line tiles (the "hits one extra person"
 *  bug). Requiring the cell centre to fall in the polygon keeps the hit set
 *  equal to the highlighted tiles, so a token is hit iff it stands on a red
 *  tile. Cones/circles/rects keep the generous test (they WANT edge-clip
 *  cells — see shapeHitsTokenCell). */
/** Grid cells a LINE (ray) passes through, as offset objects {i, j}, using the
 *  grid's OWN straight-line traversal (getDirectPath) from the line origin to
 *  its far-edge midpoint. A thin euclidean line band cannot cover the diagonal
 *  staircase cell centres when the aim isn't exactly 45°, so point-probing the
 *  polygon can't render (or harvest) diagonal lines — getDirectPath gives the
 *  clean single-cell staircase every grid type agrees on. Returns null when the
 *  API or the polygon isn't usable (caller then falls back to the probe). */
function rayLineCells(shape, originX, originY) {
    const grid = canvas?.grid;
    const pts = shape?.points;
    if (typeof grid?.getDirectPath !== "function" || !Array.isArray(pts) || pts.length < 8) return null;
    /* Ray polygon vertex order is [p00, p10, p11, p01]; p10 and p11 are the two
     * FAR corners, so their midpoint is the line's end point (local → world). */
    const farX = originX + (pts[2] + pts[4]) / 2;
    const farY = originY + (pts[3] + pts[5]) / 2;
    try {
        const offsets = grid.getDirectPath([{ x: originX, y: originY }, { x: farX, y: farY }]);
        return Array.isArray(offsets) ? offsets : null;
    } catch (_) { return null; }
}

/** True when a sight-blocking wall lies between the template ORIGIN and the
 *  point (tx, ty) — i.e. that cell/token is behind a wall and shouldn't be part
 *  of the area (line of effect). Uses the sight polygon backend (same wall set
 *  the caster's LoS gate uses). Falls open (not blocked) if the API is missing
 *  so a template can never vanish entirely on an odd build. */
function originBlockedToPoint(ox, oy, tx, ty) {
    try {
        const backend = CONFIG?.Canvas?.polygonBackends?.sight;
        if (backend?.testCollision) {
            return !!backend.testCollision({ x: ox, y: oy }, { x: tx, y: ty }, { type: "sight", mode: "any" });
        }
    } catch (_) { /* fall open */ }
    return false;
}

function tokenCentreInShape(shape, token, originX, originY) {
    if (!shape) return false;
    const cx = (token.center?.x ?? token.x) - originX;
    const cy = (token.center?.y ?? token.y) - originY;
    /* 3×3 ±1px centre probe — matches the ray branch of
     * _getGridHighlightPositions (centre probe, no vertex fallback) so a line
     * hits a token iff that token stands on a lit line tile. */
    for (let px = -1; px <= 1; px++) {
        for (let py = -1; py <= 1; py++) {
            try { if (shape.contains(cx + px, cy + py)) return true; } catch (_) {}
        }
    }
    return false;
}

/** Convenience — probe a shape at a token's cell. Reads the token's own
 *  rendered w/h so multi-square (2×2, 3×3, dragon-sized) tokens count
 *  as hit if ANY part of their footprint overlaps the shape. */
function shapeHitsToken(shape, token, originX, originY) {
    const cx = (token.center?.x ?? token.x) - originX;
    const cy = (token.center?.y ?? token.y) - originY;
    const halfW = (Number(token.w) || Number(canvas?.grid?.size) || 100) / 2;
    const halfH = (Number(token.h) || Number(canvas?.grid?.size) || 100) / 2;
    return shapeHitsTokenCell(shape, cx, cy, halfW, halfH);
}

/** Every actor whose token cell footprint overlaps the captured template
 *  shape. Deduped by actor uuid. Takes the raw { shape, x, y } snapshot
 *  from the preview so no persisted document is required.
 *
 *  `excludeTokenId` skips the caster's own token — for caster-anchored
 *  shapes the caster sits at the shape's origin (0, 0), which is a
 *  polygon vertex, and `PIXI.Polygon.contains(0, 0)` is implementation-
 *  defined at a vertex (may return true). Without this filter, an Igni
 *  cone anchored on the caster reads the caster as inside itself and
 *  the spell burns its own author. Filtering by TOKEN id (not actor
 *  uuid) so an unlinked / synthetic caster doesn't accidentally exclude
 *  other tokens that share the base actor. */
export { SHAPE_TO_FOUNDRY };
export function harvestTokens({ shape, x: originX, y: originY, t: shapeType = "", elevation: castElevation = null }, { excludeTokenId = "" } = {}) {
    if (!shape) return [];
    const tokens = canvas.tokens?.placeables ?? [];
    const seen = new Set();
    const out = [];
    /* LINE spells: a token is hit iff its cell is one the line traverses (the
     * same grid-cell staircase the highlight draws), so the hit set equals the
     * lit tiles and a diagonal line can't catch a token off the line. Falls back
     * to the centre probe if getDirectPath is unavailable. Everything else keeps
     * the generous cell-overlap test. */
    /* The strict line test asks "is the token standing on a cell the line
     * traverses". With no grid there are no such cells — `getDirectPath` on a
     * gridless scene returns the two endpoints, so the strict set would be
     * two points and a line spell would catch nobody. Geometry answers it
     * properly instead: the token's footprint either overlaps the line band or
     * it doesn't. */
    const strictLine = String(shapeType) === "ray" && !isGridless();
    let rayCellSet = null;
    if (strictLine) {
        const offs = rayLineCells(shape, originX, originY);
        if (offs) rayCellSet = new Set(offs.map(o => `${o.i}:${o.j}`));
    }
    /* Elevation filter: 2D shape.contains would hit a token standing on
     * a floor above/below the caster if their (x, y) footprint overlaps.
     * A caster on the ground floor casting Igni shouldn't scorch someone
     * on the balcony above just because they line up in plan view.
     * Compare token elevation to `castElevation` (falls back to 0 when
     * the shape snapshot didn't stamp one — matches core's default). */
    const eLevel = Number(castElevation);
    const eDefined = Number.isFinite(eLevel);
    for (const token of tokens) {
        if (!token?.actor) continue;
        if (token.actor.type === "loot") continue;   // loot piles aren't combatants — skip in area effects
        if (excludeTokenId && token.id === excludeTokenId) continue;
        if (seen.has(token.actor.uuid)) continue;
        /* Full cell-vs-shape polygon intersection — cone edges that
         * clip a corner of the cell without covering the center still
         * count. See shapeHitsTokenCell for the 3-part test. Lines use the
         * strict centre probe instead (see strictLine above). */
        let hit;
        if (strictLine && rayCellSet) {
            const off = canvas.grid?.getOffset?.(token.center ?? { x: token.x, y: token.y });
            hit = off ? rayCellSet.has(`${off.i}:${off.j}`) : false;
        } else if (strictLine) {
            hit = tokenCentreInShape(shape, token, originX, originY);   // fallback
        } else {
            hit = shapeHitsToken(shape, token, originX, originY);
        }
        if (!hit) continue;
        /* Line of effect — a token behind a wall from the template origin is
         * NOT in the area, even if its cell geometrically overlaps the shape.
         * Matches the wall-clipped tile highlight (_clipLoE). */
        const tc = token.center ?? { x: token.x, y: token.y };
        if (originBlockedToPoint(originX, originY, tc.x, tc.y)) continue;
        if (eDefined) {
            const tokenElev = Number(token.document?.elevation ?? token.elevation ?? 0);
            if (Number.isFinite(tokenElev) && tokenElev !== eLevel) continue;
        }
        seen.add(token.actor.uuid);
        out.push(token.actor);
    }
    return out;
}

/* The two legacy `core.*` template-shape settings, read ONCE and cached.
 * Foundry's own `_refreshShape` / `getConeShape` read these on every render
 * tick, which (a) spams the v14 "deprecated without replacement" warning and
 * (b) is redundant work. Our subclass inlines the shape math (see
 * `_refreshShape` / `_computeShape` overrides) and pulls the settings from here
 * instead. Cached so the deprecation getter is touched at most once per session
 * (invalidated on updateSetting); wrapped in try/catch so it degrades to sane
 * defaults if the settings are gone entirely (Foundry v16+). */
let _tplShapeSettings = null;
export function invalidateTemplateShapeSettings() { _tplShapeSettings = null; }
export function readTemplateShapeSettings() {
    if (_tplShapeSettings) return _tplShapeSettings;
    let gridTemplates = false;
    let coneType = "round";
    try { gridTemplates = !!game.settings.get("core", "gridTemplates"); } catch (_) {}
    try { coneType = String(game.settings.get("core", "coneTemplateType") || "round"); } catch (_) {}
    /* `gridTemplates` snaps template geometry to whole cells. With no grid
     * there is nothing to snap to, and Foundry's grid-shape helpers answer for
     * a grid that doesn't exist — so a gridless scene always uses the true
     * circle / cone / rectangle, which is what the distances mean anyway. */
    if (isGridless()) gridTemplates = false;
    _tplShapeSettings = { gridTemplates, coneType };
    return _tplShapeSettings;
}

/** Build native RegionDocument creation data from MeasuredTemplate-shaped
 *  geometry.
 *
 *  Generic bridge used by BOTH persistent zones (`zoneEffects.createZoneTemplate`)
 *  and the transient bomb-scatter flash (`bombs.mjs`). The MeasuredTemplate
 *  document was merged into Region in v14, so anything that used to create a
 *  `MeasuredTemplate` now creates a Region whose shape matches the template
 *  geometry exactly. Uses Foundry's own `_migrateMeasuredTemplateData` — the
 *  SAME function the deprecation shim runs — so the region visual is
 *  byte-identical to what the shim produced (smooth vs. grid-snapped
 *  circles/cones honour the core `gridTemplates` / `coneTemplateType`
 *  settings, matching the castArea placement preview). Falls back to an inline
 *  euclidean builder if that internal ever disappears (Foundry v16+).
 *
 *  Whatever `templateData.flags` carries (zoneEffect for zones, bombScatter
 *  for the flash) is preserved by the migrator so the caller's own hooks can
 *  find its regions.
 *
 *  Lives HERE (not in zoneEffects.mjs) on purpose: bombs.mjs — which is
 *  dynamic-imported by dock.js — also needs it, and a `bombs → zoneEffects`
 *  edge formed a module-load cycle that made the named export fail to resolve
 *  ("does not provide an export named …"). castArea.mjs is a shared leaf both
 *  callers already import cleanly, so hosting it here breaks the cycle.
 *
 *  @param {object} templateData      MeasuredTemplate-shaped geometry + flags
 *  @param {object} [opts]
 *  @param {number} [opts.elevation]  region floor elevation (default 0)
 *  @param {number} [opts.visibility] CONST.REGION_VISIBILITY.* (default ALWAYS)
 *  @returns {object|null}            RegionDocument creation data */
export function buildTemplateRegionData(templateData, { elevation = 0, visibility } = {}) {
    const grid = canvas?.grid ?? canvas?.scene?.grid;
    const { gridTemplates, coneType } = readTemplateShapeSettings();
    let regionData = null;
    const BaseRegion = foundry?.documents?.BaseRegion ?? CONFIG?.Region?.documentClass;
    const migrate = BaseRegion?._migrateMeasuredTemplateData;
    if (typeof migrate === "function") {
        try {
            regionData = migrate.call(BaseRegion, templateData, {
                grid, gridTemplates, coneTemplateType: coneType,
                users: game.users?.contents ?? []
            });
        } catch (err) {
            console.warn(`${SYSTEM_ID} | native template→region migrate failed; using fallback`, err);
            regionData = null;
        }
    }
    if (!regionData) regionData = _fallbackTemplateRegionData(templateData, grid, gridTemplates, coneType, elevation);
    if (!regionData) return null;

    /* Common invariants: caller flags preserved (migrator deep-clones them;
     * re-assert from source only if the fallback dropped them), always-visible
     * unless the caller narrows it, measurement outline shown
     * (onRefreshRegionOcclusion reparents `_measurementLines`), and NO
     * `flags.core.MeasuredTemplate` marker — that marker would re-route the
     * region back through the deprecation shim / `scene.templates`. */
    regionData.flags = regionData.flags ?? {};
    if (templateData.flags && Object.keys(regionData.flags).length === 0) {
        regionData.flags = foundry.utils.duplicate(templateData.flags);
    }
    if (regionData.flags.core?.MeasuredTemplate) delete regionData.flags.core.MeasuredTemplate;
    regionData.visibility = visibility ?? CONST.REGION_VISIBILITY.ALWAYS;
    regionData.displayMeasurements = true;
    regionData.highlightMode = regionData.highlightMode ?? "coverage";
    regionData.hidden = false;
    regionData.locked = false;
    if (!regionData.elevation || typeof regionData.elevation !== "object") {
        regionData.elevation = { bottom: elevation, top: null };
    }
    return regionData;
}

/** Inline euclidean shape builder — only runs if Foundry's own migrator
 *  is unavailable (Foundry v16+). Purely for the region VISUAL; zone
 *  containment is driven separately by `zoneEffects.testPointOnTemplate`
 *  reading the stored `geometry` flag (exact math) and the bomb flash is
 *  visual-only, so even a slightly-off rect here changes nothing mechanically. */
function _fallbackTemplateRegionData(templateData, grid, gridTemplates, coneType, elevation) {
    try {
        const t = templateData.t || "circle";
        const x = Math.round(Number(templateData.x) || 0);
        const y = Math.round(Number(templateData.y) || 0);
        const distance = Math.abs(Number(templateData.distance) || 0);
        const direction = (((Number(templateData.direction) || 0) % 360) + 360) % 360;
        const angle = Math.max(0, Math.min(360, templateData.angle == null ? 90 : (Number(templateData.angle) || 0)));
        const width = Math.abs(Number(templateData.width) || 0);
        const size = Number(grid?.size) || Number(canvas?.scene?.grid?.size) || 100;
        const dist = Number(grid?.distance) || Number(canvas?.scene?.grid?.distance) || 1;
        const distancePixels = size / dist;
        const gridBased = gridTemplates === true;
        let shape;
        switch (t) {
            case "cone": {
                const curvature = gridBased || coneType === "round" ? "round" : "flat";
                shape = { type: "cone", x, y, radius: distance * distancePixels, angle, rotation: direction, curvature, gridBased };
                break;
            }
            case "rect": {
                /* A CUBE IS A SQUARE, CENTRED ON WHERE YOU PUT IT.
                 *
                 * This built the rectangle from the direction vector — width
                 * from cos, height from sin — so at the default direction of 0
                 * the height collapsed to `|| distancePixels`, one grid square,
                 * and the whole thing hung off the click point's top-left
                 * corner. A 2m cube dropped squarely on a victim missed them:
                 * live, Tanio Ilchar caught nobody while an identically aimed
                 * 2m radius caught two.
                 *
                 * The book's cubes are "an Nm cube" — N on a side, around the
                 * point you chose. */
                const side = distance * distancePixels;
                shape = { type: "rectangle", x, y, width: side, height: side,
                          anchorX: 0.5, anchorY: 0.5, rotation: 0, gridBased };
                break;
            }
            case "ray": {
                shape = { type: "line", x, y, length: distance * distancePixels, width: (width || 1) * distancePixels, rotation: direction, gridBased };
                break;
            }
            case "circle":
            default:
                shape = { type: "circle", x, y, radius: distance * distancePixels, gridBased };
        }
        return {
            name: String(templateData.itemName || "Zone"),
            color: templateData.fillColor || "#c8a878",
            shapes: [shape],
            elevation: { bottom: elevation, top: null },
            visibility: CONST.REGION_VISIBILITY.ALWAYS,
            highlightMode: "coverage",
            displayMeasurements: true,
            hidden: false,
            locked: false,
            flags: foundry.utils.duplicate(templateData.flags || {})
        };
    } catch (err) {
        console.warn(`${SYSTEM_ID} | fallback template region build failed`, err);
        return null;
    }
}

/** Late-build the subclass so `CONFIG.MeasuredTemplate.objectClass`
 *  is available (only populated after Foundry sets up its canvas
 *  document classes). Cached across calls. */
let _areaTemplateClass = null;
let _tplSettingsHookBound = false;
export function buildAreaTemplateClass() {
    if (_areaTemplateClass) return _areaTemplateClass;
    /* Invalidate the shape-settings cache when the GM flips either legacy
     * template setting, so a live change still takes effect. Bound once. */
    if (!_tplSettingsHookBound) {
        _tplSettingsHookBound = true;
        Hooks.on("updateSetting", (setting) => {
            const k = setting?.key ?? "";
            if (k === "core.gridTemplates" || k === "core.coneTemplateType") invalidateTemplateShapeSettings();
        });
        /* The cached value now depends on the SCENE as well as the settings
         * (gridless forces true geometry), so a scene change has to drop it —
         * otherwise walking from a square map onto a gridless one keeps
         * snapping templates to cells that are no longer there. */
        Hooks.on("canvasReady", () => invalidateTemplateShapeSettings());
    }

    /* Stage 2 — the AoE aiming preview is a PLAIN PIXI.Container, NOT a Foundry
     * MeasuredTemplate placeable. Constructing a MeasuredTemplate / its Document
     * is what fired the v14 "merged into Region" deprecations
     * (MeasuredTemplateDocument, MeasuredTemplate, MEASURED_TEMPLATE_TYPES,
     * Scene#templates, ControlIcon#refresh). We don't need one: the area is
     * conveyed purely by our own grid tiles + red range underlay, the geometry
     * is our own `_computeShape`, and aiming is driven by canvas.stage pointer
     * listeners — none of that requires a document. `this.document` is a
     * lightweight plain data holder that mimics the tiny slice of the document
     * API the aim handlers use (the fields + `updateSource`). */
    class WitcherAreaTemplate extends PIXI.Container {
        constructor(templateData = {}) {
            super();
            const d = templateData || {};
            this.document = {
                t:         String(d.t ?? "circle"),
                x:         Number(d.x) || 0,
                y:         Number(d.y) || 0,
                direction: Number(d.direction) || 0,
                distance:  Number(d.distance) || 0,
                angle:     Number(d.angle) || 0,
                width:     Number(d.width) || 0,
                hidden:    false,
                sort:      0,
                updateSource(patch) { if (patch) Object.assign(this, patch); return this; }
            };
            this.shape = null;
            /* No pointer interception — commit/aim come from our own stage
             * listeners (previously achieved via _previewType → eventMode none). */
            this.eventMode = "none";
        }

        /* highlightGrid() blanks its tiles when isVisible is false; the preview
         * is always visible while aiming. */
        get isVisible() { return true; }

        /* Compute geometry + paint tiles. Replaces Foundry's placeable draw —
         * no vector template, no ControlIcon, no ruler; the area reads purely as
         * the grid tiles. Async so the existing `await this.draw()` site is
         * unchanged. */
        async draw() { this.refresh(); return this; }

        /* Recompute the shape from the (just-updated) document and repaint the
         * affected-cell tiles. The aim handlers call this after updateSource. */
        refresh() {
            this.shape = this._computeShape();
            try { this.highlightGrid(); } catch (_) {}
            return this;
        }

        /* Replace Foundry's default grid highlight with the WEAPON TARGET-SELECT
         * OVERLAY tile style — same red, opacity, per-cell polygon + stroke — so
         * the AoE's covered cells look exactly like the weapon overlay's target
         * tiles. Drawn into our own graphic on the templates preview layer (world
         * space) and redrawn each refresh so it tracks the aim. */
        highlightGrid() {
            const grid = canvas?.grid;
            const layer = canvas?.templates?.preview;
            if (!grid || !layer) return;
            let g = this._wdmAffectedTiles;
            if (!g || g.destroyed) {
                g = this._wdmAffectedTiles = new PIXI.Graphics();
                g.eventMode = "none";
                layer.addChild(g);   // above the range underlay (added at index 0)
            }
            g.clear();
            if (this.isVisible === false) return;
            /* No grid, no cells: draw the aimed shape itself in the same red.
             * `_getGridHighlightPositions` below would otherwise probe once per
             * PIXEL of the shape's bounding box (see isGridlessScene). */
            if (isGridlessScene()) {
                g.beginFill(TILE_COLOR, TILE_FILL_TARGET);
                g.lineStyle(TILE_STROKE_WIDTH, TILE_COLOR, TILE_STROKE_ALPHA);
                drawShapeInto(g, this.shape, Number(this.document?.x) || 0, Number(this.document?.y) || 0);
                g.endFill();
                g.lineStyle(0);
                return;
            }
            const gs = Number(grid.size) || 100;
            for (const p of (this._getGridHighlightPositions() ?? [])) {
                const off   = grid.getOffset?.({ x: p.x + gs / 2, y: p.y + gs / 2 });
                const verts = off && grid.getVertices?.(off);
                if (!Array.isArray(verts) || !verts.length) continue;
                g.beginFill(TILE_COLOR, TILE_FILL_TARGET);
                g.lineStyle(TILE_STROKE_WIDTH, TILE_COLOR, TILE_STROKE_ALPHA);
                g.drawPolygon(verts.flatMap(v => [v.x, v.y]));
                g.endFill();
            }
            g.lineStyle(0);
        }

        /**
         * Override Foundry's grid-highlight cell selection. Foundry's
         * default only lights up a cell when the cell CENTER (probed at
         * ±1 pixel) falls inside the shape — for a cone with a ±45° ray
         * endpoint exactly at a diagonal cell's CENTER (extremely common
         * on the standard 90° cone geometry), that's a knife-edge case
         * that PIXI.Polygon.contains misses and the diagonal tile stays
         * dark.
         *
         * We keep Foundry's 3×3 center probe (so cells the cone
         * substantially covers get highlighted the normal way) and add
         * ONE narrow fallback: light up a cell when a polygon vertex
         * sits inside its footprint. That catches the "arc endpoint at
         * diagonal cell center" case without also lighting up cells
         * the cone is only brushing at a corner. Corner-in-polygon and
         * edge-edge tests are deliberately NOT used here (they're too
         * generous for grid highlighting — they were the source of the
         * "overcorrected, lens/diamond of cells lights up" bug — but
         * are still applied to token targeting, since a token whose
         * cell the cone visibly clips should still be caught).
         */
        _getGridHighlightPositions() {
            const grid = canvas.grid;
            const shape = this.shape;
            if (!shape) return [];
            const isRay = String(this.document?.t ?? "") === "ray";
            /* LINE: light exactly the grid cells the line traverses (clean
             * diagonal staircase). Point-probing the thin band can't cover the
             * diagonal cell centres. Falls through to the probe if getDirectPath
             * isn't available on this grid. */
            if (isRay) {
                const offsets = rayLineCells(shape, Number(this.document?.x) || 0, Number(this.document?.y) || 0);
                if (offsets) return this._clipLoE(offsets.map(o => grid.getTopLeftPoint(o)));
            }
            const {x: ox, y: oy} = this.document;
            const bounds = shape.getBounds();
            bounds.x += ox;
            bounds.y += oy;
            bounds.fit(canvas.dimensions.rect);
            bounds.pad(1);
            const half = Number(grid.size) / 2;
            const pts = Array.isArray(shape.points) ? shape.points : null;
            const positions = [];
            const [i0, j0, i1, j1] = grid.getOffsetRange(bounds);
            for (let i = i0; i < i1; i++) {
                for (let j = j0; j < j1; j++) {
                    const offset = {i, j};
                    const c = grid.getCenterPoint(offset);
                    const dx = c.x - ox, dy = c.y - oy;
                    /* Template origin cell always highlights (matches
                     * Foundry's own escape hatch). */
                    if (Math.max(Math.abs(dx), Math.abs(dy)) < 1) {
                        positions.push(grid.getTopLeftPoint(offset));
                        continue;
                    }
                    /* 3×3 ±1px centre probe — lights a cell whose centre is in
                     * the shape (the ±1px catches the knife-edge where a
                     * diagonal cell centre sits exactly on the band/arc edge and
                     * PIXI.Polygon.contains misses an exact point). */
                    let covered = false;
                    for (let px = -1; px <= 1 && !covered; px += 1) {
                        for (let py = -1; py <= 1 && !covered; py += 1) {
                            try { if (shape.contains(dx + px, dy + py)) covered = true; }
                            catch (_) {}
                        }
                    }
                    /* Polygon-vertex-in-cell fallback: catches a cone's arc
                     * endpoint landing at a diagonal cell centre. SKIPPED for
                     * LINES — a ray's end-corner vertex sweeping into a
                     * neighbouring cell was lighting one extra adjacent tile on a
                     * diagonal line; the centre probe alone gives the clean
                     * single-cell diagonal staircase. */
                    if (!covered && pts && !isRay) {
                        const x0 = dx - half, x1 = dx + half;
                        const y0 = dy - half, y1 = dy + half;
                        for (let k = 0; k < pts.length; k += 2) {
                            if (pts[k] >= x0 && pts[k] <= x1
                                && pts[k + 1] >= y0 && pts[k + 1] <= y1) {
                                covered = true;
                                break;
                            }
                        }
                    }
                    if (covered) positions.push(grid.getTopLeftPoint(offset));
                }
            }
            return this._clipLoE(positions);
        }

        /* Line of effect — drop highlighted cells whose centre is behind a
         * wall from the template ORIGIN (caster centre for caster-anchored
         * cones, blast centre for free-placed bombs). The origin cell itself is
         * always kept.
         *
         * PERF: a per-cell wall raycast (testCollision) per aim FRAME tanked the
         * framerate. Instead we build ONE 360° sight sweep polygon from the
         * origin and test cells with cheap point-in-polygon `contains`. The
         * polygon is cached by origin, so a caster-anchored cone (fixed origin)
         * sweeps once and every rotation frame is just N contains checks; a
         * free-placed template only re-sweeps when the origin actually moves. */
        _loEPoly(ox, oy) {
            const key = `${Math.round(ox)}:${Math.round(oy)}`;
            if (this._loEKey === key) return this._loEPolyCache ?? null;
            const Backend = CONFIG?.Canvas?.polygonBackends?.sight ?? globalThis?.ClockwiseSweepPolygon;
            let poly = null;
            if (Backend?.create) {
                try {
                    poly = Backend.create({ x: ox, y: oy }, {
                        type: "sight", angle: 360, rotation: 0,
                        radius: Number(canvas.dimensions?.maxR) || 100000
                    });
                } catch (_) { poly = null; }
            }
            this._loEKey = key;
            this._loEPolyCache = poly;
            return poly;
        }
        _clipLoE(positions) {
            const ox = Number(this.document?.x) || 0;
            const oy = Number(this.document?.y) || 0;
            const poly = this._loEPoly(ox, oy);
            if (!poly || typeof poly.contains !== "function") return positions;
            const h = (Number(canvas.grid?.size) || 100) / 2;
            return positions.filter(p => {
                const cx = p.x + h, cy = p.y + h;
                if (Math.max(Math.abs(cx - ox), Math.abs(cy - oy)) < 1) return true;
                try { return poly.contains(cx, cy); } catch (_) { return true; }
            });
        }

        /* ── Shape geometry ─────────────────────────────────────────────────
         * The cell-by-cell polygon for the aimed area, inlined from Foundry's
         * own shape math (client/canvas/placeables/template.mjs) so coverage is
         * identical to a native template, but built here from our plain
         * `this.document` + cached settings — no MeasuredTemplate, no deprecated
         * getXShape calls. `refresh()` assigns the result to `this.shape`. */
        _computeShape() {
            const { t, distance, direction, angle, width } = this.document;
            const { gridTemplates, coneType } = readTemplateShapeSettings();
            const dims = canvas.dimensions;
            const Ray = foundry.canvas.geometry.Ray ?? globalThis.Ray;
            switch (t) {
                case "circle":
                    if (gridTemplates) return new PIXI.Polygon(canvas.grid.getCircle({ x: 0, y: 0 }, distance));
                    return new PIXI.Circle(0, 0, distance * dims.distancePixels);
                case "cone": {
                    if (gridTemplates) return new PIXI.Polygon(canvas.grid.getCone({ x: 0, y: 0 }, distance, direction, angle));
                    if ((distance <= 0) || (angle <= 0)) return new PIXI.Polygon();
                    let dist = distance * dims.distancePixels;
                    let angles;
                    if (coneType === "round") {
                        if (angle >= 360) return new PIXI.Circle(0, 0, dist);
                        const da = Math.min(angle, 3);
                        angles = Array.fromRange(Math.floor(angle / da)).map(a => (angle / -2) + (a * da)).concat([angle / 2]);
                    } else {
                        const flat = Math.min(angle, 179);
                        angles = [(flat / -2), (flat / 2)];
                        dist /= Math.cos(Math.toRadians(flat / 2));
                    }
                    const rays = angles.map(a => Ray.fromAngle(0, 0, Math.toRadians(direction + a), dist));
                    const points = rays.reduce((arr, r) => arr.concat([r.B.x, r.B.y]), [0, 0]).concat([0, 0]);
                    return new PIXI.Polygon(points);
                }
                case "rect": {
                    /* Centred, and square — matching the region built above.
                     * Foundry's own rect template runs a diagonal from the
                     * origin, which is right for "drag out a box" and wrong for
                     * "an Nm cube lands here". */
                    const side = distance * dims.distancePixels;
                    return new PIXI.Rectangle(-side / 2, -side / 2, side, side).normalize();
                }
                case "ray": {
                    const w = width * dims.distancePixels;
                    const p00 = Ray.fromAngle(0, 0, Math.toRadians(direction - 90), w / 2).B;
                    const p01 = Ray.fromAngle(0, 0, Math.toRadians(direction + 90), w / 2).B;
                    let p10, p11;
                    if (gridTemplates) {
                        p10 = canvas.grid.getTranslatedPoint(p00, direction, distance);
                        p11 = canvas.grid.getTranslatedPoint(p01, direction, distance);
                    } else {
                        const dp = distance * dims.distancePixels;
                        const dir = Math.toRadians(direction);
                        p10 = Ray.fromAngle(p00.x, p00.y, dir, dp).B;
                        p11 = Ray.fromAngle(p01.x, p01.y, dir, dp).B;
                    }
                    return new PIXI.Polygon([p00.x, p00.y, p10.x, p10.y, p11.x, p11.y, p01.x, p01.y]);
                }
            }
            return new PIXI.Polygon();
        }

        /**
         * Static factory + placement entry. Builds the plain-container preview
         * from the raw template data (NO MeasuredTemplate document), draws its
         * tiles into the templates preview layer, activates the aim listeners,
         * and resolves to a geometry snapshot once the user clicks. Resolves to
         * AREA_CANCELLED on right-click / Esc.
         */
        static async place({ templateData, itemName, anchor = "caster", casterCenter = null, casterToken = null, maxRangePx = null, extremeRangePx = null, showRangeRing = false }) {
            const previewObj = new WitcherAreaTemplate(templateData);
            previewObj._anchor       = anchor === "free" ? "free" : "caster";
            previewObj._casterCenter = casterCenter && Number.isFinite(casterCenter.x)
                ? { x: Number(casterCenter.x), y: Number(casterCenter.y) }
                : null;
            /* Caster token reference for LoS constraint: the preview
             * clamps aim / placement so the caster can only aim into
             * (caster-anchored) or drop onto (free-placed) points they
             * can actually see. Vision cone + wall occlusion both come
             * from token.los, so a single point-in-polygon test covers
             * both. */
            previewObj._casterToken = casterToken ?? null;
            /* Bomb-throw range constraint. When set, free-placed origin
             * is clamped to `_clampRangePx` from `_casterCenter` (grid-
             * agnostic Euclidean, then re-snapped to the grid). When
             * `showRangeRing` is also true, a translucent circle is
             * drawn on the preview layer for the placer's reference,
             * destroyed on teardown. Null / 0 = no constraint (spell-
             * cast default).
             *
             * `extremeRangePx` — when set, the clamp extends to this
             * outer boundary (2× standard for bombs' extreme range).
             * Both rings are drawn: solid at `_maxRangePx` (standard
             * long range), dashed/fainter at `_extremeRangePx` (extreme,
             * heavier penalty). The clamp uses whichever is larger. */
            previewObj._maxRangePx     = Number.isFinite(Number(maxRangePx))     && Number(maxRangePx)     > 0 ? Number(maxRangePx)     : null;
            previewObj._extremeRangePx = Number.isFinite(Number(extremeRangePx)) && Number(extremeRangePx) > 0 ? Number(extremeRangePx) : null;
            previewObj._clampRangePx   = previewObj._extremeRangePx ?? previewObj._maxRangePx;
            previewObj._showRangeRing  = !!showRangeRing && !!previewObj._clampRangePx && !!previewObj._casterCenter;
            return previewObj._drawPreview({ itemName });
        }

        /** Build a fresh sight polygon for the caster's token, honouring
         *  scene walls + vision-cone angle + rotation + range. Independent
         *  of whether the token is currently controlled AND independent
         *  of `sight.enabled` — a monster token typically has vision
         *  disabled (the GM sees the whole scene as the omniscient
         *  observer), but the spell caster's physical LoS should still
         *  apply. The polygon is built off the token's angle + rotation +
         *  range even when the sight system isn't rendering for the
         *  current user. Returns null on any failure so `_casterCanSee`
         *  falls open. */
        _buildCasterSight() {
            const t = this._casterToken;
            if (!t) return null;
            const doc = t.document ?? t;
            const sight = doc?.sight;
            const origin = t.center ?? this._casterCenter;
            if (!origin || !Number.isFinite(origin.x) || !Number.isFinite(origin.y)) return null;

            /* Convert the sight range (scene distance units — usually
             * metres) into pixels via the scene's grid metadata. Zero
             * / negative range means unlimited: pass the scene's max
             * dimension so the polygon extends to the scene edge (still
             * clipped by walls). */
            const gridSize     = Number(canvas.dimensions?.size) || 100;
            const gridDistance = Number(canvas.dimensions?.distance) || 1;
            const rangeUnits   = Number(sight?.range) || 0;
            const rangePx      = rangeUnits > 0 ? (rangeUnits * gridSize / gridDistance) : (Number(canvas.dimensions?.maxR) || 100000);
            const angle        = Number(sight?.angle) || 360;
            const rotation     = Number(doc?.rotation) || 0;
            const externalRadius = Number(t.externalRadius) || 0;

            /* Foundry v13/v14 API. The polygon backend lives at
             * CONFIG.Canvas.polygonBackends.sight (default is
             * ClockwiseSweepPolygon). Fall back to the global class if
             * the config path isn't populated on some builds. */
            const Backend = CONFIG?.Canvas?.polygonBackends?.sight
                         ?? globalThis?.ClockwiseSweepPolygon
                         ?? null;
            if (!Backend?.create) return null;
            try {
                return Backend.create(origin, {
                    type: "sight",
                    angle,
                    rotation,
                    radius: rangePx,
                    externalRadius
                });
            } catch (err) {
                console.warn(`${SYSTEM_ID} | caster sight polygon build failed`, err);
                return null;
            }
        }

        /** True if the caster's line-of-sight polygon contains the world
         *  point (x, y). Reads the snapshot built at preview-open time
         *  (see `_drawPreview` + `_buildCasterSight`). Falls open (true)
         *  when no snapshot exists — better to allow the shot than to
         *  trap a player with a vision-disabled token. */
        _casterCanSee(x, y) {
            const los = this._losSnapshot;
            if (!los || typeof los.contains !== "function") return true;
            try { return !!los.contains(x, y); } catch (_) { return true; }
        }

        async _drawPreview({ itemName } = {}) {
            const initialLayer = canvas.activeLayer;
            /* Compute a fresh LoS polygon from the caster's token config
             * — do NOT rely on `token.vision.los`, which Foundry only
             * populates for the CURRENTLY controlled token. When a
             * template preview activates, control drops to the templates
             * layer and `vision.los` empties out; even if we snapshot
             * it before the layer swap, it may not have been populated
             * yet (dock-triggered casts don't require token control).
             *
             * ClockwiseSweepPolygon.create() builds the sight polygon
             * from the token's origin + vision-cone angle / rotation /
             * range, honouring scene walls. Independent of selection
             * state, so the constraint stays valid all the way through
             * the preview.
             *
             * Falls back to null (constraint no-ops) when the caster
             * token or its sight config is missing, or when Foundry's
             * sweep API isn't available. */
            this._losSnapshot = this._buildCasterSight();
            try {
                await this.draw();
            } catch (err) {
                console.warn(`${SYSTEM_ID} | area template preview draw failed`, err);
                try { initialLayer?.activate?.(); } catch (_) {}
                return null;
            }
            /* Do NOT activate the templates layer. Switching layers deactivates
             * the tokens layer, and Foundry's PlaceablesLayer._deactivate() calls
             * `releaseAll()` — releasing the GM's controlled token. Since a GM's
             * vision/fog comes ONLY from a CONTROLLED token (Token#_isVisionSource:
             * uncontrolled → not a vision source for a GM), that release made the
             * GM omniscient and their FOV dark zone vanished for the whole aim
             * (then came back when the layer reactivated on commit). The weapon
             * target overlay stays on the tokens layer and never has this bug.
             * We don't need the layer active: the preview renders from the
             * preview container regardless, and the aim is driven by our own
             * canvas.stage pointer listeners, not the layer's interaction. */
            canvas.templates.preview.addChild(this);

            /* Region layer is intentionally LEFT ALONE. We used to blank the
             * whole region layer (renderable / mesh visibility) while aiming to
             * declutter map-authored zone highlights — but regions are
             * GM-visible and, in V14, their rendering carries scene
             * darkness / effect visuals, so hiding them made the GM's FOV dark
             * zone vanish the moment a template preview opened (only the GM,
             * only while aiming — players don't see regions). The weapon target
             * overlay never touches regions; neither should this. */
            this._regionVisSnapshot = null;

            /* Range ring(s) — OUTLINE ONLY circles around the
             * caster's center. Solid ring at `_maxRangePx` (standard
             * long range). If `_extremeRangePx` is also set, a
             * fainter outer ring marks the extreme boundary — throws
             * inside the outer ring but outside the inner take the
             * extreme-range penalty (rangeBandFor returns extreme >
             * max).
             *
             * NO fills — a filled disk at even alpha 0.05 washes the
             * map surface with a huge tinted overlay that reads as a
             * grey haze. The rings are boundary indicators; the
             * outline alone communicates the same information without
             * covering the map. */
            if (this._showRangeRing) {
                try {
                    const ring = new PIXI.Graphics();
                    if (this._extremeRangePx && this._extremeRangePx > (this._maxRangePx ?? 0)) {
                        ring.lineStyle(2, 0xc06060, 0.7);
                        ring.drawCircle(this._casterCenter.x, this._casterCenter.y, this._extremeRangePx);
                    }
                    if (this._maxRangePx) {
                        ring.lineStyle(2, 0xc8a878, 0.9);
                        ring.drawCircle(this._casterCenter.x, this._casterCenter.y, this._maxRangePx);
                    }
                    ring.eventMode = "none";
                    canvas.templates.preview.addChild(ring);
                    this._rangeRing = ring;
                } catch (err) {
                    console.warn(`${SYSTEM_ID} | range ring draw failed`, err);
                }
            }

            /* Valid-tile underlay — a translucent-red mask of the in-reach,
             * in-FOV cells, drawn UNDER the preview so aiming an area spell
             * matches the weapon → tile targeting look (same red). Reach is the
             * range clamp for free-placed templates, or the template's own
             * distance for caster-anchored cones. Cells outside the caster's
             * sight (walls / vision cone, via _casterCanSee) are omitted.
             * Destroyed on teardown. */
            try {
                const grid = canvas.grid;
                const cc   = this._casterCenter;
                const gs   = Number(canvas.dimensions?.size) || 100;
                const gd   = Number(canvas.dimensions?.distance) || 1;
                const reachPx = this._anchor === "free"
                    ? (this._clampRangePx ?? 0)
                    : ((Number(this.document?.distance) || 0) * gs / gd);
                /* Gridless: one outline at the reach boundary instead of a cell
                 * fill. The loop below would run per pixel (see
                 * isGridlessScene) — for a 20 m spell that is a six-figure
                 * count of hairline polygons, which is what washed the map in
                 * flat colour and stalled the bomb throw. */
                if (isGridlessScene()) {
                    if (cc && reachPx > 0) {
                        const edge = new PIXI.Graphics();
                        edge.lineStyle(TILE_STROKE_WIDTH, TILE_COLOR, TILE_STROKE_ALPHA);
                        edge.drawCircle(cc.x, cc.y, reachPx);
                        edge.eventMode = "none";
                        canvas.templates.preview.addChildAt(edge, 0);
                        this._rangeTileMask = edge;
                    }
                    console.log(`${SYSTEM_ID} | castArea preview: gridless scene — reach drawn as an outline, no tile underlay`);
                } else if (grid && cc && reachPx > 0) {
                    const mask = new PIXI.Graphics();
                    let cellCount = 0;
                    const rect = { x: cc.x - reachPx, y: cc.y - reachPx, width: reachPx * 2, height: reachPx * 2 };
                    const range = grid.getOffsetRange?.(rect);
                    if (Array.isArray(range)) {
                        const [i0, j0, i1, j1] = range;
                        for (let i = i0; i < i1; i++) {
                            for (let j = j0; j < j1; j++) {
                                const c = grid.getCenterPoint({ i, j });
                                if (Math.hypot(c.x - cc.x, c.y - cc.y) > reachPx + gs * 0.5) continue;
                                if (!this._casterCanSee(c.x, c.y)) continue;
                                const verts = grid.getVertices?.({ i, j });
                                const pts = (Array.isArray(verts) && verts.length)
                                    ? verts.flatMap(v => [v.x, v.y])
                                    : null;
                                /* In-range placement tiles — the weapon overlay's
                                 * BASE (reachable) cell style: fill only, no stroke. */
                                mask.beginFill(TILE_COLOR, TILE_FILL);
                                if (pts) {
                                    mask.drawPolygon(pts);
                                } else {
                                    const tl = grid.getTopLeftPoint?.({ i, j }) ?? { x: c.x - gs / 2, y: c.y - gs / 2 };
                                    mask.drawRect(tl.x, tl.y, gs, gs);
                                }
                                mask.endFill();
                                cellCount++;
                            }
                        }
                    }
                    mask.eventMode = "none";
                    canvas.templates.preview.addChildAt(mask, 0);   // beneath the preview + ring
                    this._rangeTileMask = mask;
                    /* One-line load marker so a reload can be VERIFIED: if you see
                     * this in the console when aiming a spell, the updated preview
                     * IS running. cellCount 0 = LoS/grid gave no cells (report it). */
                    console.log(`${SYSTEM_ID} | castArea preview (Stage-2 container, no MeasuredTemplate): red tile underlay drawn (${cellCount} cells, anchor=${this._anchor})`);
                }
            } catch (err) {
                console.warn(`${SYSTEM_ID} | range tile mask draw failed`, err);
            }
            /* Vision is intentionally LEFT ALONE. This used to force-control the
             * caster's token (releaseOthers:true) and poke perception so the aim
             * rendered the caster's FOV — but that hijacked the GM's view and
             * WIPED their fog / FOV dark zone the moment a template preview
             * opened (the weapon target overlay never touches vision, which is
             * why it didn't have the bug). We don't need the view to switch: the
             * aim is already clamped to the caster's line of sight via
             * `_losSnapshot` (see _buildCasterSight), so the placer just keeps
             * their normal view while aiming. */
            try {
                const modeHint = this._anchor === "caster"
                    ? t("WITCHER.Mech.CastArea.Hint.Aim",  "aim with mouse, wheel to fine-tune")
                    : t("WITCHER.Mech.CastArea.Hint.Move", "move with mouse, wheel to rotate");
                ui.notifications?.info(
                    tFormat("WITCHER.Mech.CastArea.Notify.Preview", { name: itemName ?? t("WITCHER.Mech.CastArea.Text.AreaSpell", "Area spell"), hint: modeHint }, `${itemName ?? "Area spell"}: ${modeHint}, left-click to place, right-click to cancel.`)
                );
            } catch (_) { /* soft-fail */ }

            return this._activatePreviewListeners(initialLayer);
        }

        _activatePreviewListeners(initialLayer) {
            return new Promise((resolve) => {
                const handlers = {};
                let lastMove = 0;
                let done = false;
                /* Set of token IDs the preview has flagged as targeted.
                 * Tracked so cancel() can un-target only tokens we set
                 * (not stomp any pre-existing targets the user had). */
                const targetedTokenIds = new Set();

                /** Recompute which tokens fall inside the CURRENT preview
                 *  shape and sync Foundry's target reticle. Called on
                 *  mousemove + wheel. Additive: sets targets on tokens
                 *  that entered, unsets on tokens that left. */
                /* Caster's own TOKEN id (not actor uuid), used to skip
                 * self-targeting without leaking exclusion to any other
                 * tokens that happen to share the caster's actor (e.g.
                 * duplicate mook tokens, unlinked casts). The caster's
                 * token sits at the shape's origin (0, 0) in template-
                 * local space, and PIXI polygons return TRUE for vertex
                 * points — a caster-anchored cone would otherwise stick
                 * the target reticle on the caster and hit them with
                 * their own spell. */
                const casterTokenId = this._casterToken?.id ?? "";
                /* In-blast reticle REMOVED by design — aiming an AoE no longer
                 * flashes Foundry target chevrons on caught tokens (consistent
                 * with the "no more chevrons on canvas" rule). The grid-cell
                 * highlight + the red valid-tile underlay convey the covered
                 * area, and the actual targets are still harvested from the
                 * committed shape (pickAreaTargets → harvestTokens), so nothing
                 * downstream depends on the reticle. No-op kept so the existing
                 * mousemove / wheel call sites stay valid. `targetedTokenIds`
                 * therefore stays empty and clearOurTargets is a no-op. */
                const refreshTargeting = () => {};

                /** Clear every target flag WE placed during the preview.
                 *  Called from BOTH cancel() and commit(): a canceled
                 *  placement should leave target state exactly as it
                 *  was, and a committed placement should hand its
                 *  candidates off through the returned actor array
                 *  (not through the target reticle) so a subsequent
                 *  single-target cast doesn't inherit a stale AoE
                 *  target set. The chat card carries the visual audit
                 *  trail (per-target hit/miss blocks) that used to
                 *  justify keeping the reticles. */
                const clearOurTargets = () => {
                    for (const id of targetedTokenIds) {
                        const t = canvas.tokens?.get?.(id);
                        try {
                            t?.setTarget?.(false, {
                                user: game.user, releaseOthers: false, groupSelection: false
                            });
                        } catch (_) {}
                    }
                    targetedTokenIds.clear();
                };

                /* Teardown tears down listeners + PIXI preview but does
                 * NOT touch reticle state — cancel() and commit() decide
                 * whether to preserve or clear the reticles. */
                const teardown = () => {
                    if (done) return;
                    done = true;
                    try { canvas.stage.off("pointermove", handlers.move); } catch (_) {}
                    try { canvas.stage.off("pointerdown", handlers.stageCommit); } catch (_) {}
                    try { document.removeEventListener("mousedown", handlers.commit, { capture: true }); } catch (_) {}
                    try { document.removeEventListener("pointerdown", handlers.swallow, { capture: true }); } catch (_) {}
                    try { canvas.app?.view?.removeEventListener?.("contextmenu", handlers.cancel); } catch (_) {}
                    try { canvas.app?.view?.removeEventListener?.("wheel", handlers.rotate, { capture: true }); } catch (_) {}
                    try { document.removeEventListener("keydown", handlers.key); } catch (_) {}
                    try { this._rangeRing?.destroy?.({ children: true }); } catch (_) {}
                    try { this._rangeTileMask?.destroy?.({ children: true }); } catch (_) {}
                    try { this._wdmAffectedTiles?.destroy?.({ children: true }); } catch (_) {}
                    try { this.destroy({ children: true }); } catch (_) {}
                    try { initialLayer?.activate?.(); } catch (_) {}
                    /* No region-layer state to restore — the preview no longer
                     * hides regions (see the note where that used to happen). */
                    /* Nothing to restore — the preview no longer takes over token
                     * control or the vision/perception state (see the note where
                     * that used to happen), so the placer's view is already intact. */
                };

                const cancel = () => {
                    /* Cancel = spell not cast → un-target everything we
                     * flagged during preview so the canvas returns to
                     * its pre-preview state. */
                    clearOurTargets();
                    teardown();
                    resolve(AREA_CANCELLED);
                };

                const commit = () => {
                    /* Snapshot the preview's shape geometry + origin
                     * BEFORE teardown destroys the placeable. `this.shape`
                     * is populated by draw()/refresh() and remains valid
                     * as a plain PIXI polygon reference even after the
                     * placeable is destroyed — the container gets torn
                     * down but the shape object itself is not owned by
                     * the display tree. Passing it out of this closure
                     * lets harvestTokens hit-test without ever
                     * persisting anything to canvas.scene.
                     *
                     * The snapshot also carries `direction` and the
                     * document's `t` type so a persistent-zone caller
                     * (createZoneTemplate in zoneEffects.mjs) can
                     * reconstruct a scene MeasuredTemplate with the
                     * exact orientation the caster aimed. */
                    const snapshot = {
                        shape:     this.shape,
                        x:         Number(this.document?.x) || 0,
                        y:         Number(this.document?.y) || 0,
                        direction: Number(this.document?.direction) || 0,
                        t:         String(this.document?.t ?? ""),
                        /* Caster elevation so harvestTokens can filter out
                         * tokens on other floors — a Yrden on the ground
                         * floor shouldn't catch someone standing directly
                         * above on a balcony. Read off the placeable's
                         * own `_casterToken` (set in place()) — the
                         * `casterToken` local from place()'s destructured
                         * args is NOT in scope here (this method's a
                         * separate closure), and the previous reference
                         * threw a silent ReferenceError inside every
                         * left-click commit — which is why the template
                         * appeared to "just aim forever" no matter which
                         * mousedown / pointerdown binding actually fired. */
                        elevation: Number(this._casterToken?.document?.elevation ?? this._casterToken?.elevation ?? 0)
                    };
                    /* Clear the preview reticles: the harvested actors
                     * are passed back to castSpellMixin via the snapshot,
                     * not through game.user.targets. Leaving reticles
                     * on after commit would leak the AoE catches into
                     * the caster's next spell (which reads game.user
                     * .targets as its target set). */
                    clearOurTargets();
                    teardown();
                    resolve(snapshot);
                };

                handlers.move = (event) => {
                    const now = Date.now();
                    if (now - lastMove < 20) return;
                    lastMove = now;
                    try {
                        const localPos = event.data?.getLocalPosition
                            ? event.data.getLocalPosition(canvas.stage)
                            : (event.getLocalPosition ? event.getLocalPosition(canvas.stage) : null);
                        if (!localPos) return;

                        if (this._anchor === "caster") {
                            /* Caster-anchored: origin stays pinned at
                             * the caster's token center. The mouse
                             * cursor sets the DIRECTION (aim toward
                             * cursor). Wheel provides fine adjust.
                             * Circles have no meaningful direction —
                             * they still snap to the caster's origin
                             * so the preview never drifts.
                             *
                             * LoS constraint: the AIM DIRECTION has to
                             * point somewhere the caster can see, so
                             * we probe a point one grid cell out along
                             * the proposed direction and test THAT
                             * point against the LoS polygon. Testing
                             * the cursor point directly leaks a bug:
                             * a mouse dragged over the caster's own
                             * token lands inside the polygon (the
                             * caster is trivially at its origin) and
                             * atan2 near (0, 0) produces a garbage
                             * direction that could end up pointing
                             * outside the vision cone. The direction-
                             * probe also naturally rejects mouse
                             * positions too close to the caster
                             * without a special dead-zone. */
                            const origin = this._casterCenter;
                            if (origin) {
                                const dx = localPos.x - origin.x;
                                const dy = localPos.y - origin.y;
                                const dist = Math.hypot(dx, dy);
                                /* Ignore cursor positions right on the
                                 * caster (dist ~0) — direction is
                                 * meaningless and any test point we
                                 * pick is arbitrary. Hold the last
                                 * valid direction. */
                                if (dist < 1) return;
                                const rad = Math.atan2(dy, dx);
                                const probeDist = Number(canvas?.grid?.size) || 100;
                                const px = origin.x + Math.cos(rad) * probeDist;
                                const py = origin.y + Math.sin(rad) * probeDist;
                                if (!this._casterCanSee(px, py)) return;
                                const deg = rad * 180 / Math.PI;
                                const patch = { x: origin.x, y: origin.y };
                                if (this.document.t !== "circle") patch.direction = deg;
                                this.document.updateSource(patch);
                            }
                        } else {
                            /* Free-placed: snap origin to nearest grid
                             * center (matches Foundry's own template
                             * placement UX). Direction is controlled
                             * entirely by wheel.
                             *
                             * Range constraint (bomb throws): if
                             * `_maxRangePx` is set and the snapped
                             * point is farther than that from the
                             * caster, clamp along the caster→cursor
                             * ray to the ring's edge, then re-snap to
                             * a grid center. Works for all grid types
                             * (getSnappedPoint honours hex/square).
                             *
                             * LoS constraint: the snapped (and now
                             * clamped) origin has to be inside the
                             * caster's LoS. If it isn't (behind a
                             * wall, outside the vision cone, or past
                             * the sight range), the preview holds its
                             * last valid position instead of jumping
                             * to a spot the caster couldn't see. */
                            const snapMode = CONST.GRID_SNAPPING_MODES?.CENTER ?? 0x10;
                            let snapped = canvas.grid?.getSnappedPoint
                                ? canvas.grid.getSnappedPoint(localPos, { mode: snapMode })
                                : localPos;
                            /* Clamp uses `_clampRangePx` which is
                             * `_extremeRangePx` when set (bombs) OR
                             * `_maxRangePx` otherwise. Throws inside
                             * the extreme ring but outside the standard
                             * ring still land — the extreme-range
                             * penalty on the roll is the deterrent. */
                            const clampPx = this._clampRangePx ?? this._maxRangePx;
                            if (clampPx && this._casterCenter) {
                                const cx = this._casterCenter.x, cy = this._casterCenter.y;
                                const rdx = snapped.x - cx, rdy = snapped.y - cy;
                                const rdist = Math.hypot(rdx, rdy);
                                if (rdist > clampPx && rdist > 0) {
                                    const scale = clampPx / rdist;
                                    const clamped = { x: cx + rdx * scale, y: cy + rdy * scale };
                                    snapped = canvas.grid?.getSnappedPoint
                                        ? canvas.grid.getSnappedPoint(clamped, { mode: snapMode })
                                        : clamped;
                                }
                            }
                            if (!this._casterCanSee(snapped.x, snapped.y)) return;
                            this.document.updateSource({ x: snapped.x, y: snapped.y });
                        }
                        this.refresh();
                        refreshTargeting();
                    } catch (_) { /* cursor may leave canvas — soft-fail */ }
                };

                /* Stops a placement click from ALSO reaching the token layer.
                 * Shares the commit handler's "is this inside the play area"
                 * test so a click on the sidebar or a dialog is left alone. */
                handlers.swallow = (event) => {
                    if ((event?.button ?? 0) !== 0) return;
                    const canvasEl = canvas.app?.view ?? null;
                    const tgt = event?.target ?? null;
                    if (canvasEl && tgt && tgt !== canvasEl && !canvasEl.contains?.(tgt)) return;
                    /* stopPropagation ONLY.
                     *
                     * `preventDefault()` on a pointerdown suppresses the
                     * compatibility mouse events the browser would otherwise
                     * synthesise from it — including the `mousedown` that
                     * `handlers.commit` listens for. Calling it here stopped
                     * the token being grabbed and stopped the template being
                     * placed at the same time: the aim just hung. */
                    try { event.stopPropagation?.(); } catch (_) {}
                };

                handlers.commit = (event) => {
                    /* DOM `mousedown` fires .button === 0 for left click.
                     * Right / middle / auxiliary clicks are handled by
                     * `contextmenu` (cancel) or ignored. */
                    const btn = event?.button ?? 0;
                    if (btn !== 0) return;
                    /* Only claim clicks that land inside the play area —
                     * document-level capture would otherwise swallow the
                     * left-click on the sidebar / chat log / controls
                     * palette and cancel the aim just for opening a
                     * character sheet. `canvas.app.view` is the play-area
                     * canvas element; if the event target is INSIDE it,
                     * this is a click on the map. Everything else is UI
                     * chrome and we ignore. */
                    const canvasEl = canvas.app?.view ?? null;
                    const tgt = event?.target ?? null;
                    if (canvasEl && tgt && tgt !== canvasEl && !canvasEl.contains?.(tgt)) return;
                    try { event.preventDefault?.(); event.stopPropagation?.(); } catch (_) {}
                    /* commit() is now synchronous — it snapshots geometry
                     * off the preview and tears down; no scene document
                     * write means no async round-trip. */
                    commit();
                };
                /* Separate PIXI-side handler bound to `canvas.stage`. Fires
                 * from PIXI's federated event system, which is the flow
                 * Foundry itself uses for placeable interactions — reaches
                 * the stage listener because the preview is marked
                 * `_previewType = "creation"` above, making `isInteractable
                 * = false` and `eventMode = "none"` (so PIXI doesn't
                 * intercept the click on the preview object). Right-click
                 * (button 2) skipped so contextmenu handles cancel. */
                handlers.stageCommit = (event) => {
                    const btn = event?.data?.button ?? event?.button ?? 0;
                    if (btn !== 0) return;
                    try { event.stopPropagation?.(); } catch (_) {}
                    commit();
                };

                handlers.rotate = (event) => {
                    if (this.document.t === "circle") return;
                    event.preventDefault();
                    event.stopPropagation();
                    const snapDeg = event.shiftKey ? 5 : 15;
                    const dir = Number(this.document.direction) || 0;
                    const next = event.deltaY > 0 ? dir + snapDeg : dir - snapDeg;
                    /* LoS constraint on wheel-rotate (caster-anchored
                     * only): don't accept a direction that would aim
                     * outside the caster's vision cone. Test a point
                     * one grid cell out along the proposed direction —
                     * if that lands inside token.los, the aim is valid;
                     * otherwise the current direction is kept. Free-
                     * placed templates aren't caster-anchored so this
                     * gate is skipped for them (they wheel-rotate the
                     * shape, not an aim from the caster). */
                    if (this._anchor === "caster" && this._casterCenter) {
                        const rad = next * Math.PI / 180;
                        const probeDist = Number(canvas?.grid?.size) || 100;
                        const px = this._casterCenter.x + Math.cos(rad) * probeDist;
                        const py = this._casterCenter.y + Math.sin(rad) * probeDist;
                        if (!this._casterCanSee(px, py)) return;
                    }
                    try {
                        this.document.updateSource({ direction: next });
                        this.refresh();
                        refreshTargeting();
                    } catch (_) { /* soft-fail */ }
                };

                handlers.cancel = (event) => {
                    try { event.preventDefault?.(); event.stopPropagation?.(); } catch (_) {}
                    cancel();
                };

                handlers.key = (event) => {
                    if (event.key === "Escape") cancel();
                };

                canvas.stage.on("pointermove", handlers.move);
                /* PRIMARY commit path: PIXI federated pointerdown on
                 * `canvas.stage`. Reaches here because the preview object
                 * has `_previewType = "creation"` (set in `place()`) which
                 * makes `isInteractable` return false, and Foundry's
                 * `_refreshState` writes `eventMode = "none"` on any
                 * placeable that isn't interactable — so PIXI hit-test
                 * skips the preview and the pointerdown falls through to
                 * the stage. This is exactly the flow Foundry itself
                 * uses for placeable interaction. */
                canvas.stage.on("pointerdown", handlers.stageCommit);
                /* Fallback: document-level DOM mousedown (capture phase).
                 * Fires BEFORE any bubble-phase listener in the tree, so
                 * even if PIXI's InteractionManager consumes the pointer
                 * event, this still runs. The handler skips clicks whose
                 * `event.target` isn't the play-area canvas, so a click
                 * on the sidebar / dialog / chat doesn't accidentally
                 * commit the template. Belt-and-braces — only exists in
                 * case the stage listener silently fails on some scene /
                 * render-config combination. */
                document.addEventListener("mousedown", handlers.commit, { capture: true });
                /* PIXI dispatches placeable interaction from `pointerdown`, not
                 * `mousedown` — they are separate events, so stopping one does
                 * nothing to the other. And a federated event reaches the TOKEN
                 * before it bubbles to the stage, so the token was selected on
                 * the very click that placed the template: aim a cone over
                 * somebody and you also grabbed them.
                 *
                 * Swallowed in the capture phase at `document`, which is above
                 * anything PIXI binds, so the token layer never sees it. The
                 * commit itself is driven by the `mousedown` handler above and
                 * by the stage listener; this one exists purely to stop the
                 * click leaking through to the placeables. */
                document.addEventListener("pointerdown", handlers.swallow, { capture: true });
                canvas.app?.view?.addEventListener?.("contextmenu", handlers.cancel);
                canvas.app?.view?.addEventListener?.("wheel", handlers.rotate, { capture: true, passive: false });
                document.addEventListener("keydown", handlers.key);
            });
        }
    }

    _areaTemplateClass = WitcherAreaTemplate;
    return WitcherAreaTemplate;
}
