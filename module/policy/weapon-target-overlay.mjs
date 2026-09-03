/**
 * Weapon target overlay — canvas tile-targeting for token combat.
 *
 * Flow: the player clicks a weapon in the combat dock. Instead of attacking
 * immediately, this paints the tiles that weapon can reach onto the canvas in
 * faint red. Hovering a tile that holds a valid target highlights it; clicking
 * it launches the attack against the token on that tile
 * (`weaponAttack(weapon, { forceDefender })`). For ranged / thrown weapons the
 * tiles are tinted by range band and a floating label shows the band + the
 * to-hit modifier as you hover. Right-click, click-away, or Escape cancels.
 *
 * This is purely a TARGET PICKER — it resolves WHICH token the attack lands on
 * and hands off to the existing `weaponAttack` pipeline unchanged (dialog,
 * defense, damage all downstream). This is MANDATORY — there is no toggle.
 * Bombs are excluded — they keep their own AoE template flow (`throwBomb`).
 * GRIDLESS scenes are supported too, by measuring instead of counting: the
 * reach (or each range band) is drawn as a boundary ring around the attacker
 * and the tokens inside it are marked and clicked directly. See the gridless
 * branch of `computeCells`.
 *
 * Modeled on module/policy/immersive-tactical-grid.mjs for the PIXI overlay
 * (container on canvas.controls), grid-cell drawing (getVertices/drawPolygon),
 * and teardown patterns.
 */

import { RANGE_BRACKETS, getActiveWeaponQualities, WEAPON_QUALITIES } from "../setup/config.mjs";
import { hideMovementOverlay } from "./immersive-tactical-grid.mjs";
import { isDeadToken } from "../mechanics/deadState.mjs";
import { isSpottedBy } from "../mechanics/stealth.mjs";
import { isGridless, metresToPx, separationMetres, meleeReachMetres,
         graceMetres, gridMetres } from "../mechanics/gridDistance.mjs";
import { t } from "../chrome/lib/i18n.js";

const SYSTEM_ID = "witcher-ttrpg-death-march";

/* ── visual constants ─────────────────────────────────────────────── */
/* Colours drawn from the system's red palette (tokens.css --wdm-red*) so the
 * overlay reads as part of the theme. Reach red for melee; range bands warm →
 * deep red as distance grows. */
const COLOR_MELEE = 0xa25050;          // --wdm-red-bright
const BAND_COLOR = Object.freeze({
    pointBlank: 0xb87a5a,
    close:      0xa25050,              // --wdm-red-bright
    medium:     0x8c3c3c,              // --wdm-red
    long:       0x74302f,
    extreme:    0x5e2626
});
const FILL_ALPHA        = 0.16;
const FILL_ALPHA_TARGET = 0.34;
const STROKE_ALPHA      = 0.55;
const STROKE_WIDTH      = 2;
const HOVER_ALPHA       = 0.50;

/** The system display-font stack, read live from the CSS custom property so
 *  the overlay label matches the rest of the UI's typography (falls back to
 *  Signika if the token isn't resolvable). */
function resolveDisplayFont() {
    try {
        const v = getComputedStyle(document.body).getPropertyValue("--wdm-font-display").trim();
        return v || "Signika, sans-serif";
    } catch (_) { return "Signika, sans-serif"; }
}

/** Keep the range label upright (counter the immersive camera's stage
 *  rotation) AND a constant on-screen size (counter the zoom scale) so a
 *  distant target's band/range stays readable when zoomed out. */
function updateLabelTransform() {
    const label = _s?.labelText;
    if (!label || label.destroyed) return;
    const scale = Number(canvas?.stage?.scale?.x) || 1;
    label.scale.set(scale ? 1 / scale : 1);
    label.angle = -Math.toDegrees(canvas?.stage?.rotation ?? 0);
}

/* Single active session (only one weapon targets at a time). */
let _s = null;

/** Canvas tile-targeting is MANDATORY — there is no toggle. Clicking a weapon
 *  always paints its range on the canvas for a tile pick. Kept as a function so
 *  the existing call sites don't need rewriting. */
export function isTileTargetingEnabled() {
    return true;
}

/* ── range / reach math ───────────────────────────────────────────── */

/** Melee reach for a weapon, honouring the reach qualities (Long / Superior /
 *  Extreme Reach). Returns:
 *    reachTiles  — max reach in whole tiles, mirroring weaponAttackMixin's gate
 *                  `1 + floor(maxReachExtendMeters / gridMeters)` (Long → 2,
 *                  Superior → 3, Extreme → 5 at 1.5 m/tile).
 *    noAdjacent  — Extreme Reach: can't attack an adjacent (≤1 tile) target at
 *                  all (the attack flow refuses it), so those tiles are excluded
 *                  from the overlay.
 *    pommelOnly  — Superior Reach: adjacent attacks are pommel-only (still
 *                  allowed, so still highlighted — the attack card notes it). */
function meleeReach(weapon, gridMeters) {
    const cat = getActiveWeaponQualities() ?? WEAPON_QUALITIES;
    const keys = weapon?.system?.effective?.qualities ?? weapon?.system?.qualities ?? [];
    let ext = 0, noAdjacent = false, pommelOnly = false;
    for (const k of keys) {
        const e = cat[k] ?? WEAPON_QUALITIES[k];
        if (!e) continue;
        const v = Number(e.reachExtendMeters) || 0;
        if (v > ext) ext = v;
        if (e.reachAdjacentNoAttack)   noAdjacent = true;
        if (e.reachAdjacentPommelOnly) pommelOnly = true;
    }
    return {
        reachTiles:  1 + Math.floor(ext / (gridMeters || 1.5)),
        /* The same reach as a DISTANCE, for scenes with no tiles to count.
         * Identical to reachTiles * gridMeters on a gridded scene. */
        reachMetres: meleeReachMetres(ext),
        noAdjacent, pommelOnly
    };
}

const _bracketByValue = Object.fromEntries(RANGE_BRACKETS.map(b => [b.value, b]));

/** Which range band a distance (metres) falls in for a weapon whose listed
 *  range is `baseRange` metres. Returns the RANGE_BRACKETS entry or null when
 *  past Extreme (2× listed). Point Blank is a fixed ≤0.5 m band; the rest are
 *  fractions of the listed range. Matches bombs.mjs / the attack dialog. */
function bandFor(distM, baseRange) {
    if (distM <= 0.5) return _bracketByValue.pointBlank;
    const b = baseRange > 0 ? baseRange : 30;
    if (distM <= b * 0.25) return _bracketByValue.close;
    if (distM <= b * 0.5)  return _bracketByValue.medium;
    if (distM <= b)        return _bracketByValue.long;
    if (distM <= b * 2)    return _bracketByValue.extreme;
    return null;
}

/** Which overlay a weapon shows: range bands vs melee tile-reach. Ranged
 *  weapons always use bands; a plain melee weapon always uses reach. A
 *  throwable melee weapon (melee + a `range`) is dual-mode — it honors the
 *  requested mode ("thrown" → bands, else melee reach), driven by the dock's
 *  Melee/Throw toggle. Bombs never reach here (own flow). */
function usesRangeBands(weapon, requestedMode) {
    if (weapon?.system?.weaponType === "ranged") return true;
    const throwable = String(weapon?.system?.range ?? "").trim().length > 0;
    if (!throwable) return false;
    return requestedMode === "thrown";
}

/* ── cell computation ─────────────────────────────────────────────── */

const cellKey = (i, j) => `${i}:${j}`;

/** Every grid cell a token's footprint covers, as "i:j" keys. */
function tokenCellKeys(token) {
    const grid = canvas.grid;
    const keys = [];
    try {
        const b = token.bounds;
        const range = grid.getOffsetRange?.({ x: b.x, y: b.y, width: b.width, height: b.height });
        if (Array.isArray(range)) {
            const [i0, j0, i1, j1] = range;
            for (let i = i0; i < i1; i++) for (let j = j0; j < j1; j++) keys.push(cellKey(i, j));
        }
    } catch (_) { /* fall through to center */ }
    if (!keys.length) {
        try { const o = grid.getOffset(token.center); keys.push(cellKey(o.i, o.j)); } catch (_) {}
    }
    return keys;
}

/** Build the attacker's sight (line-of-sight) polygon from its CURRENT DOCUMENT
 *  origin + rotation, replicating Foundry's own vision config (point-effect-
 *  source `_getPolygonConfiguration`). Built ourselves — NOT read from the
 *  cached `token.vision.los` — because that cache tracks the ANIMATED token
 *  state and lags a tile/turn behind across every movement mode (drag, WASD,
 *  click-to-move); and because refreshing it (`initializeVisionSource`) fires a
 *  global perception refresh (flicker). Returns a polygon with `.contains`, or
 *  null when the token has no limited vision to filter by. */
function buildDocSightPoly(token) {
    try {
        const backend = CONFIG?.Canvas?.polygonBackends?.sight;
        const doc = token?.document;
        if (!backend?.create || !doc) return null;
        const o = (typeof doc.getVisionOrigin === "function") ? doc.getVisionOrigin() : token.center;
        const sight = doc.sight ?? {};
        return backend.create({ x: o.x, y: o.y }, {
            type: "sight",
            radius: Number(canvas.dimensions?.maxR) || 1e5,   // full radius; walls do the limiting
            // externalRadius: 0 — Foundry's vision source insets a near-field disc
            // (~the token's own radius) around the origin that is ALWAYS "inside"
            // the polygon regardless of facing. For a directional targeting cone
            // that disc leaks the tile directly BEHIND the token in (its front
            // edge midpoint lands within the disc). We want a pure cone that comes
            // to a point at the origin, so "behind" is strictly excluded.
            externalRadius: 0,
            angle: Number(sight.angle) || 360,
            rotation: Number(doc.rotation) || 0,
            edgeTypes: { wall: sight.walls !== false }
        });
    } catch (_) { return null; }
}

/**
 * Build the reachable-cell map for a weapon fired from an attacker token.
 * Returns { cells: Map<key,{i,j,center,color,band?,mod?}>, bandMode }.
 */
async function computeCells(attackerToken, weapon, attackerActor, requestedMode, capAtRange = false) {
    const grid = canvas.grid;
    const gridSize   = Number(canvas.scene?.grid?.size)     || 100;
    const gridMeters = Number(canvas.scene?.grid?.distance) || 1.5;
    // Origin from the token's DOCUMENT vision origin (its committed position),
    // NOT the animated display center — so range + FOV reflect where the token
    // IS the instant it moves/turns, across every movement mode (drag, WASD,
    // click-to-move), instead of lagging one tile / one turn behind the
    // animation.
    const _vo = (typeof attackerToken.document?.getVisionOrigin === "function")
        ? attackerToken.document.getVisionOrigin()
        : attackerToken.center;
    const ac = { x: _vo.x, y: _vo.y };
    const bandMode = usesRangeBands(weapon, requestedMode);

    /* Field of view: our own document-based sight polygon (see buildDocSightPoly
     * for why not token.vision.los). No filtering when the scene doesn't use
     * token vision or the token has no limited-vision polygon. */
    const _fovPoly = canvas.scene?.tokenVision ? buildDocSightPoly(attackerToken) : null;
    const _hasFov  = !!(_fovPoly && typeof _fovPoly.contains === "function");
    const inFov = (pt) => {
        if (!_hasFov) return true;
        try { return _fovPoly.contains(pt.x, pt.y); } catch (_) { return true; }
    };

    /* Line-of-effect sweep polygon from the attacker origin — a single 360°
     * sight sweep (walls only), built ONCE here. Cells behind a wall fail
     * `contains`. This replaces a per-cell wall raycast (which tanked FPS when
     * the overlay rebuilt on rotation) with one sweep + cheap point tests, and
     * it applies regardless of the scene's token-vision setting. */
    const _loeBackend = CONFIG?.Canvas?.polygonBackends?.sight ?? globalThis?.ClockwiseSweepPolygon;
    let _loePoly = null;
    if (_loeBackend?.create) {
        try {
            _loePoly = _loeBackend.create({ x: ac.x, y: ac.y }, {
                type: "sight", angle: 360, rotation: 0,
                radius: Number(canvas.dimensions?.maxR) || 100000
            });
        } catch (_) { _loePoly = null; }
    }
    const _loeHas = (_loePoly && typeof _loePoly.contains === "function");
    const inLoE = (x, y) => {
        if (!_loeHas) return true;
        try { return _loePoly.contains(x, y); } catch (_) { return true; }
    };

    let maxMeters, reachTiles = 0, baseRange = 0, reachNoAdjacent = false;
    if (bandMode) {
        try {
            const { resolveWeaponRange } = await import("../applications/attackDialog.mjs");
            baseRange = Number(await resolveWeaponRange(weapon, attackerActor, null)) || 0;
        } catch (_) { baseRange = 0; }
        if (baseRange <= 0) return null;               // unparseable range → bail to normal attack
        // Weapons reach Extreme at 2× listed range; a spell's range is a hard
        // max, so capAtRange caps the highlight at 1× (up to Long).
        maxMeters = baseRange * (capAtRange ? 1 : 2);
    } else {
        const rInfo = meleeReach(weapon, gridMeters);
        reachTiles      = rInfo.reachTiles;
        reachNoAdjacent = rInfo.noAdjacent;              // Extreme Reach: skip adjacent
        /* `reachMetres` IS `reachTiles * gridMeters` on a gridded scene, and
         * the straight-line equivalent where there are no tiles. */
        maxMeters       = rInfo.reachMetres;
    }

    /* ── No grid: measure, don't count ──────────────────────────────────
     *
     * A gridless scene has no cells to paint or to walk, and Foundry's offset
     * APIs degrade to one offset per PIXEL — the cell scan below would run
     * hundreds of thousands of iterations and paint the map flat. So the
     * overlay changes shape rather than resolution: the reach (or each range
     * band) is drawn as a boundary ring, and the pickable things are the
     * TOKENS inside it, marked individually. Every gate that applies to a cell
     * still applies here — line of effect, the vision cone, Extreme Reach's
     * refusal to strike an adjacent foe — just measured in metres.
     *
     * The list is returned even when it is empty: an overlay showing a reach
     * ring with nothing in it tells the player they are out of range, which is
     * the honest answer. Returning null would silently fall through to an
     * untargeted attack instead. */
    if (isGridless()) {
        const grace = graceMetres();
        const targets = [];
        for (const token of (canvas.tokens?.placeables ?? [])) {
            if (!isTargetableToken(token, attackerToken)) continue;
            const c = token.center;
            if (!c) continue;
            if (!inLoE(c.x, c.y)) continue;
            if (_hasFov && !inFov(c)) continue;
            const distM = separationMetres(attackerToken, token);
            if (distM == null || distM > maxMeters + grace) continue;
            /* Extreme Reach cannot strike something already on top of you —
             * the attack flow refuses it, so don't offer it. "Adjacent" with no
             * tiles is "within one square's worth of distance". */
            if (!bandMode && reachNoAdjacent && distM <= gridMetres()) continue;
            let color = COLOR_MELEE, band = null, mod = null;
            if (bandMode && !capAtRange) {
                const br = bandFor(distM, baseRange) ?? _bracketByValue.extreme;
                color = BAND_COLOR[br.value]; band = br.value; mod = br.mod;
            }
            targets.push({ token, distM, color, band, mod });
        }
        return { cells: null, gridless: true, bandMode, targets, maxMeters, baseRange, capAtRange };
    }

    // Scan the bounding box of cells within max range (+1 tile margin).
    const radiusPx = (maxMeters / gridMeters) * gridSize + gridSize;
    const rect = { x: ac.x - radiusPx, y: ac.y - radiusPx, width: radiusPx * 2, height: radiusPx * 2 };
    const range = grid.getOffsetRange?.(rect);
    if (!Array.isArray(range)) return null;
    const [i0, j0, i1, j1] = range;

    // Never paint the attacker's own footprint — excluded by cell key so it's
    // correct for multi-cell (large) attacker tokens, not just 1×1.
    const selfKeys = new Set(tokenCellKeys(attackerToken));
    const cells = new Map();
    for (let i = i0; i < i1; i++) {
        for (let j = j0; j < j1; j++) {
            const key = cellKey(i, j);
            if (selfKeys.has(key)) continue;
            const center = grid.getCenterPoint({ i, j });
            /* Line of effect — never offer a cell behind a wall, even on a scene
             * with token vision off (where the FOV cone below is skipped). This
             * is what stops melee / ranged / touch from targeting through walls. */
            if (!inLoE(center.x, center.y)) continue;
            if (_hasFov && !inFov(center)) {
                // Count a tile only when it's about HALF in the cone: test edge
                // MIDPOINTS, not corners. Corners over-count by a full tile on
                // the cone's cusp (a tile only touching the cone at one corner
                // is <half in and shouldn't fill).
                const verts = grid.getVertices?.({ i, j });
                let anyIn = false;
                if (Array.isArray(verts) && verts.length) {
                    for (let k = 0; k < verts.length; k++) {
                        const a = verts[k], b = verts[(k + 1) % verts.length];
                        if (inFov({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })) { anyIn = true; break; }
                    }
                }
                if (!anyIn) continue;
            }
            const dx = center.x - ac.x;
            const dy = center.y - ac.y;
            if (bandMode) {
                // Extent: Euclidean vs 2×range, plus a HALF-TILE grace so a tile
                // that's half within range still counts ("half tiles are still
                // tiles"). The throw gate gets the same grace.
                const euclidM = (Math.hypot(dx, dy) / gridSize) * gridMeters;
                if (euclidM > maxMeters + gridMeters * 0.5) continue;
                if (capAtRange) {
                    // Spell range: flat "in range" — spells DON'T take weapon
                    // range-band to-hit penalties, so no band / modifier. The
                    // hover label still shows the distance.
                    cells.set(key, { i, j, center, color: COLOR_MELEE });
                } else {
                    // Band: Chebyshev metres — matches the attack card's canonical
                    // range bracket (max(|dx|,|dy|)). A boundary tile pulled in by
                    // the grace can exceed the Extreme band; clamp it to Extreme.
                    const chebM = (Math.max(Math.abs(dx), Math.abs(dy)) / gridSize) * gridMeters;
                    const band = bandFor(chebM, baseRange) ?? _bracketByValue.extreme;
                    cells.set(key, { i, j, center, color: BAND_COLOR[band.value], band: band.value, mod: band.mod });
                }
            } else {
                const tiles = Math.max(Math.abs(dx), Math.abs(dy)) / gridSize;
                if (tiles > reachTiles + 0.5) continue;         // half-tile grace: half a tile in reach counts
                // Extreme Reach can't strike an adjacent (≤1 tile) target — the
                // attack flow refuses it, so don't offer those tiles.
                if (reachNoAdjacent && tiles <= 1.001) continue;
                cells.set(key, { i, j, center, color: COLOR_MELEE });
            }
        }
    }
    return cells.size ? { cells, bandMode } : null;
}

/** Whether a token is a legal pick at all, before distance is considered.
 *  Shared by the gridded cell path and the gridless distance path so the two
 *  cannot drift on who counts as a target. */
function isTargetableToken(token, attackerToken) {
    if (!token || token === attackerToken || !token.actor) return false;
    if (token.document?.hidden && !game.user?.isGM) return false;
    // Secret disposition — a hidden NPC. Players never see it (FOV hides it);
    // the GM does, so exclude it for EVERYONE or the GM could still pick it.
    if (Number(token.document?.disposition) === (CONST?.TOKEN_DISPOSITIONS?.SECRET ?? -2)) return false;
    if (isDeadToken(token)) return false;   // can't target a corpse (weapon / ranged / brawl / magic)
    if (token.actor?.type === "loot") return false;   // loot piles aren't combatants — never targetable
    // Stealthed and not yet spotted by THIS attacker → the attacker doesn't
    // know where they are, so can't single-target them. (Area templates
    // still catch them — a template doesn't reveal who's inside.)
    if (!isSpottedBy(token.actor, attackerToken?.actor)) return false;
    return true;
}

/** Map of cell-key → array of target Tokens whose footprint overlaps a
 *  reachable cell. An ARRAY (not a single token) so two tokens stacked on the
 *  same tile both stay clickable — the click resolves to a chooser. Every
 *  in-range cell a target covers points at it (handles big tokens). Players
 *  skip GM-hidden tokens. */
function computeTargetCells(attackerToken, cells) {
    const targets = new Map();
    for (const token of (canvas.tokens?.placeables ?? [])) {
        if (!isTargetableToken(token, attackerToken)) continue;
        const occ = tokenCellKeys(token);
        const inRange = occ.filter(k => cells.has(k));
        if (!inRange.length) continue;
        for (const k of inRange) {
            let arr = targets.get(k);
            if (!arr) { arr = []; targets.set(k, arr); }
            if (!arr.includes(token)) arr.push(token);
        }
    }
    return targets;
}

/* ── drawing ──────────────────────────────────────────────────────── */

function cellPolygon(cell) {
    const verts = canvas.grid?.getVertices?.({ i: cell.i, j: cell.j });
    if (!Array.isArray(verts) || verts.length < 3) return null;
    const flat = [];
    for (const v of verts) flat.push(v.x, v.y);
    return flat;
}

/** Static base layer: reach fills (grouped by band colour) + a stronger fill
 *  and outline on cells that hold a valid target. Drawn once per session. */
/** The circle to draw around a token to mark it pickable, in world space. */
function tokenMarker(token) {
    const b = token.bounds;
    const r = (b && b.width > 0) ? Math.min(b.width, b.height) / 2 : gridPxFallback() / 2;
    const c = token.center;
    return { x: c.x, y: c.y, r: r + 4 };
}
function gridPxFallback() { return Number(canvas?.scene?.grid?.size) || 100; }

/** Gridless base layer: the reach (or each range band) as a boundary ring
 *  around the attacker, and a marked circle on every token inside it. No
 *  fills across the map — the ring says where you can reach, the markers say
 *  what is actually pickable, and nothing paints over the scene. */
function drawBaseGridless() {
    const { targets, fillG, attackerToken, bandMode, baseRange, maxMeters, capAtRange } = _s;
    fillG.clear();
    const ac = attackerToken?.center;
    if (!ac) return;

    if (bandMode && !capAtRange && baseRange > 0) {
        /* One ring per band boundary, in that band's colour, so the bands read
         * outward exactly as the tinted cells do on a gridded scene. */
        for (const b of RANGE_BRACKETS) {
            if (b.frac == null) continue;
            fillG.lineStyle(STROKE_WIDTH, BAND_COLOR[b.value] ?? COLOR_MELEE, STROKE_ALPHA);
            fillG.drawCircle(ac.x, ac.y, metresToPx(baseRange * b.frac));
        }
        fillG.lineStyle(STROKE_WIDTH, BAND_COLOR.extreme, STROKE_ALPHA * 0.8);
        fillG.drawCircle(ac.x, ac.y, metresToPx(baseRange * 2));
    } else {
        fillG.lineStyle(STROKE_WIDTH, COLOR_MELEE, STROKE_ALPHA);
        fillG.drawCircle(ac.x, ac.y, metresToPx(maxMeters));
    }
    fillG.lineStyle(0);

    for (const entry of (targets ?? [])) {
        const m = tokenMarker(entry.token);
        fillG.beginFill(entry.color, FILL_ALPHA_TARGET);
        fillG.lineStyle(STROKE_WIDTH, entry.color, STROKE_ALPHA);
        fillG.drawCircle(m.x, m.y, m.r);
        fillG.endFill();
        fillG.lineStyle(0);
    }
}

function drawBase() {
    if (_s.gridless) return drawBaseGridless();
    const { cells, targetCells, fillG } = _s;
    fillG.clear();

    // Group cells by colour so the whole set is a handful of fill states.
    const byColor = new Map();
    for (const c of cells.values()) {
        if (!byColor.has(c.color)) byColor.set(c.color, []);
        byColor.get(c.color).push(c);
    }
    for (const [color, list] of byColor) {
        fillG.beginFill(color, FILL_ALPHA);
        for (const c of list) {
            const poly = cellPolygon(c);
            if (poly) fillG.drawPolygon(poly);
        }
        fillG.endFill();
    }

    // Target-occupied cells: brighter fill + outline so they read as clickable.
    for (const key of targetCells.keys()) {
        const c = cells.get(key);
        if (!c) continue;
        const poly = cellPolygon(c);
        if (!poly) continue;
        fillG.beginFill(c.color, FILL_ALPHA_TARGET);
        fillG.lineStyle(STROKE_WIDTH, c.color, STROKE_ALPHA);
        fillG.drawPolygon(poly);
        fillG.endFill();
        fillG.lineStyle(0);
    }
}

/** Dynamic hover layer: brightens the footprint(s) of the token(s) on the
 *  hovered cell and, for ranged/thrown, shows a themed label above it with the
 *  range band, the distance in metres, and the to-hit modifier. Cleared when
 *  not over a target. */
/** Gridless hover: brighten the marker on the token under the cursor and
 *  label it with its distance (plus band and to-hit modifier when the weapon
 *  uses range bands). */
function drawHoverGridless(tokens) {
    const { hoverG, labelText, targets } = _s;
    hoverG.clear();
    labelText.visible = false;
    if (!tokens?.length) return;

    const entry = (targets ?? []).find(e => e.token === tokens[0]);
    if (!entry) return;
    const m = tokenMarker(entry.token);
    hoverG.beginFill(entry.color, HOVER_ALPHA);
    hoverG.lineStyle(STROKE_WIDTH + 1, 0xffe6cf, 0.9);
    hoverG.drawCircle(m.x, m.y, m.r);
    hoverG.endFill();
    hoverG.lineStyle(0);

    const distM = Math.round(entry.distM);
    let text = `${distM}m`;
    if (entry.band) {
        const modStr = `${entry.mod >= 0 ? "+" : ""}${entry.mod}`;
        text = `${t(_bracketByValue[entry.band].labelKey, entry.band)} · ${distM}m (${modStr})`;
    }
    labelText.text = text;
    labelText.position.set(m.x, m.y - m.r - 12);
    updateLabelTransform();
    labelText.visible = true;
}

function drawHover(tokens, hoverKey) {
    if (_s.gridless) return drawHoverGridless(tokens);
    const { cells, hoverG, labelText } = _s;
    hoverG.clear();
    labelText.visible = false;
    if (!tokens || !tokens.length) return;

    // Union of every in-range cell of every token stacked on the hovered cell.
    const drawn = new Set();
    for (const token of tokens) {
        for (const k of tokenCellKeys(token)) {
            if (!cells.has(k) || drawn.has(k)) continue;
            drawn.add(k);
            const c = cells.get(k);
            const poly = cellPolygon(c);
            if (!poly) continue;
            hoverG.beginFill(c.color, HOVER_ALPHA);
            hoverG.lineStyle(STROKE_WIDTH + 1, 0xffe6cf, 0.9);
            hoverG.drawPolygon(poly);
            hoverG.endFill();
            hoverG.lineStyle(0);
        }
    }

    const labelCell = cells.get(hoverKey);
    if (_s.bandMode && labelCell) {
        const ac = _s.attackerToken?.center;
        const tc = tokens[0]?.center ?? labelCell.center;
        const gridSize   = Number(canvas.scene?.grid?.size)     || 100;
        const gridMeters = Number(canvas.scene?.grid?.distance) || 1.5;
        // Chebyshev metres — the system's canonical grid distance, matching
        // the attack card's distance + bracket.
        const distM = ac ? Math.round((Math.max(Math.abs(tc.x - ac.x), Math.abs(tc.y - ac.y)) / gridSize) * gridMeters) : null;
        // Band + modifier for weapons; plain distance for spells (no band,
        // no range-band penalty).
        let text;
        if (labelCell.band) {
            const modStr = `${labelCell.mod >= 0 ? "+" : ""}${labelCell.mod}`;
            const bandLbl = t(_bracketByValue[labelCell.band].labelKey, labelCell.band);
            text = distM != null ? `${bandLbl} · ${distM}m (${modStr})` : `${bandLbl} (${modStr})`;
        } else {
            text = distM != null ? `${distM}m` : "";
        }
        if (text) {
            labelText.text = text;
            labelText.position.set(labelCell.center.x, labelCell.center.y - gridSize * 0.7);
            updateLabelTransform();          // upright + constant on-screen size
            labelText.visible = true;
        }
    }
}

/** Keep the range label upright while the immersive token camera rotates the
 *  stage. Called from immersive-token-camera.mjs's applyCounterRotation
 *  (mirrors counterRotateScrollingText). Also re-applies the zoom counter-
 *  scale. No-op when no session / no label. */
export function counterRotateWeaponTargetLabel(negRotRad) {
    const label = _s?.labelText;
    if (!label || label.destroyed) return;
    label.angle = Math.toDegrees(negRotRad);
    const scale = Number(canvas?.stage?.scale?.x) || 1;
    label.scale.set(scale ? 1 / scale : 1);
}

/** Ask which token to attack when two or more are stacked on the clicked
 *  tile. Returns the chosen Token, or null if cancelled. */
async function chooseTargetToken(tokens) {
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2) return tokens[0] ?? null;
    const esc = (s) => Handlebars.escapeExpression(String(s ?? ""));
    const buttons = tokens.map((tok, idx) => ({
        action:  `t${idx}`,
        label:   esc(tok?.name ?? `Target ${idx + 1}`),
        default: idx === 0,
        callback: () => idx
    }));
    let idx = null;
    try {
        idx = await DialogV2.wait({
            window: { title: t("WITCHER.Combat.TileTargeting.ChooseTitle", "Choose target") },
            content: `<p>${t("WITCHER.Combat.TileTargeting.ChooseBody", "More than one target on that tile — pick one:")}</p>`,
            buttons,
            rejectClose: false
        });
    } catch (_) { idx = null; }
    if (idx == null) return null;                  // dismissed
    const i = Number(idx);
    return Number.isInteger(i) && tokens[i] ? tokens[i] : null;
}

/* ── session lifecycle ────────────────────────────────────────────── */

/** Recompute the reachable cells + valid targets from the attacker's CURRENT
 *  position and vision, then repaint. Called when a token moves so the range,
 *  FOV and valid targets follow. Coalesced via scheduleRebuild(). */
async function rebuildTargeting() {
    const s = _s;
    if (!s) return;
    let computed;
    try { computed = await computeCells(s.attackerToken, s.weapon, s.attackerActor, s.mode, s.capAtRange); }
    catch (_) { computed = null; }
    if (_s !== s) return;                          // torn down / restarted mid-async
    if (!computed) { cancelWeaponTargeting(); return; }   // nothing reachable now
    s.cells       = computed.cells;
    s.bandMode    = computed.bandMode;
    s.gridless    = !!computed.gridless;
    s.targets     = computed.targets ?? null;
    s.maxMeters   = computed.maxMeters ?? 0;
    s.baseRange   = computed.baseRange ?? 0;
    s.targetCells = s.gridless ? new Map() : computeTargetCells(s.attackerToken, s.cells);
    s.hoverKey    = null;
    s.hoverTokens = [];
    try { drawBase(); drawHover([], null); } catch (_) {}
}

let _rebuildScheduled = false;
/** Coalesce a burst of token updates (several tokens moving at once, or an
 *  animation's updates) into a single rebuild on the next frame — which also
 *  gives Foundry a tick to refresh the attacker's vision before we re-test
 *  the field of view. */
function scheduleRebuild() {
    if (_rebuildScheduled || !_s) return;
    _rebuildScheduled = true;
    requestAnimationFrame(() => {
        _rebuildScheduled = false;
        rebuildTargeting().catch(() => {});
    });
}

/**
 * Enter tile-targeting for a weapon. Resolves the reachable cells + targets,
 * paints the overlay, and wires hover/click/cancel. On a valid tile click,
 * `onPick(targetActor)` fires; on cancel, `onCancel()`. Returns true if the
 * overlay engaged, false if it couldn't (no token / gridless / no range) so
 * the caller can fall back to a normal attack.
 */
export async function beginWeaponTargeting(attackerActor, attackerToken, weapon, { onPick, onCancel, mode, capAtRange = false, ignoreClinchLock = false } = {}) {
    cancelWeaponTargeting();                       // never stack sessions
    /* Gridless scenes are NOT refused any more. They used to be — the overlay
     * is built out of grid cells and there are none — and the cost was that
     * melee on such a scene silently fell through to an untargeted attack, so
     * the player got "you didn't target anyone" and a dialog. `computeCells`
     * now answers in metres instead of cells when there is no grid. */
    if (!canvas?.ready) return false;
    if (!attackerToken || !attackerActor || !weapon) return false;

    /* Hold lock — a CLINCHED attacker, or a PINNER, can only attack the foe
     * they're locked with. Both clinch and pin reposition the tokens to ½-tile
     * (they overlap), so the normal cell overlay — which excludes the attacker's
     * own cell — can't offer the foe. Delegate to the clinch overlay instead
     * (token-click, restricted to that foe): easy to click AND target-locked.
     * The grappler is NOT locked (they may act on others); only pin/clinch.
     * A RIDER is deliberately NOT locked here — they get the NORMAL reach overlay
     * (to strike bystanders) PLUS an easy click on the mount injected below.
     * Magic (touch spells) passes `ignoreClinchLock` so casting is unrestricted. */
    if (!ignoreClinchLock) {
        try {
            const { clinchPartnerUuids, showClinchOverlay } = await import("../mechanics/clinch.mjs");
            const { getHoldsSync }        = await import("../mechanics/holdRegistry.mjs");
            const { normalizedActorUuid } = await import("../mechanics/holdLink.mjs");
            const allowed = clinchPartnerUuids(attackerActor);   // clinch partners (either role)
            const selfU   = normalizedActorUuid(attackerActor);
            if (selfU) {
                for (const p of getHoldsSync(selfU)) {
                    if (p.kind === "pinned"  && p.holderUuid === selfU) allowed.add(p.targetUuid);
                }
            }
            if (allowed.size) {
                const picked = await showClinchOverlay(attackerActor, { allowedUuids: allowed });
                if (picked) { try { await onPick?.(picked); } catch (_) {} }
                else        { try { await onCancel?.(); } catch (_) {} }
                return true;
            }
        } catch (err) {
            console.warn(`${SYSTEM_ID} | hold-lock targeting failed`, err);
        }
    }

    let computed;
    try { computed = await computeCells(attackerToken, weapon, attackerActor, mode, capAtRange); }
    catch (err) { console.warn(`${SYSTEM_ID} | weapon-target compute failed`, err); return false; }
    if (!computed) return false;
    const { cells, bandMode, gridless = false, targets = null,
            maxMeters = 0, baseRange = 0 } = computed;

    /* Gridless sessions carry a token list instead of a cell map; the cell map
     * stays an empty Map so every `targetCells.get(...)` call site is still
     * safe without a branch. */
    const targetCells = gridless ? new Map() : computeTargetCells(attackerToken, cells);

    const parent = canvas.controls ?? canvas.interface ?? canvas.stage;
    if (!parent) return false;
    const layer = new PIXI.Container();
    layer.name = "WDMWeaponTarget";
    layer.eventMode = "none";
    layer.zIndex = 210;
    const fillG  = layer.addChild(new PIXI.Graphics());
    const hoverG = layer.addChild(new PIXI.Graphics());
    // Themed label — the system display font + parchment ink on a dark stroke,
    // so it reads like the rest of the UI. Kept upright + constant on-screen
    // size via updateLabelTransform().
    const labelText = layer.addChild(new PIXI.Text("", {
        fontFamily: resolveDisplayFont(), fontSize: 15, fontWeight: "700",
        fill: 0xe6dcc4, stroke: 0x1a1206, strokeThickness: 4, letterSpacing: 1.5,
        align: "center", dropShadow: true, dropShadowColor: 0x000000,
        dropShadowBlur: 3, dropShadowDistance: 1
    }));
    labelText.anchor.set(0.5, 0.5);
    labelText.visible = false;
    parent.addChild(layer);

    _s = {
        attackerActor, attackerToken, weapon, onPick, onCancel, bandMode, mode, capAtRange,
        cells, targetCells, layer, fillG, hoverG, labelText,
        gridless, targets, maxMeters, baseRange,
        hoverTokens: [], hoverKey: null, hookIds: {}, view: null
    };

    drawBase();

    // Pointer move (PIXI on stage) → hover. The move handler stashes the
    // token(s) on the hovered cell for the click.
    _s.onMove = (event) => {
        if (!_s) return;
        let world;
        try { world = event.getLocalPosition?.(canvas.stage); } catch (_) { return; }
        if (!world) return;
        /* Gridless: there is no cell under the cursor, so hit-test the target
         * markers themselves — nearest marker whose circle contains the point.
         * Nearest, not first, so overlapping tokens resolve to the one you are
         * actually pointing at rather than to scene order. */
        if (_s.gridless) {
            let best = null, bestD = Infinity;
            for (const entry of (_s.targets ?? [])) {
                const m = tokenMarker(entry.token);
                const d = Math.hypot(world.x - m.x, world.y - m.y);
                if (d <= m.r && d < bestD) { best = entry.token; bestD = d; }
            }
            const key = best?.id ?? null;
            if (key === _s.hoverKey) return;
            _s.hoverKey = key;
            _s.hoverTokens = best ? [best] : [];
            try { drawHover(_s.hoverTokens, key); } catch (_) {}
            return;
        }
        const off = canvas.grid?.getOffset?.(world);
        if (!off) return;
        const key = cellKey(off.i, off.j);
        if (key === _s.hoverKey) return;
        _s.hoverKey = key;
        _s.hoverTokens = _s.targetCells.get(key) ?? [];
        try { drawHover(_s.hoverTokens, key); } catch (_) {}
    };
    canvas.stage.on("pointermove", _s.onMove);

    _s.view = canvas.app?.view ?? null;
    // Click pick — a DOCUMENT-level capture pointerdown, NOT on the canvas
    // view. Foundry/PIXI attach their pointer listener on the view element in
    // the capture phase; a document-capture listener runs FIRST (ancestor
    // before descendant), so stopImmediatePropagation here starves PIXI of the
    // event entirely — the clicked token is never selected/controlled. Only
    // acts on canvas-targeted left-clicks; middle/right pass through (pan /
    // the contextmenu cancel).
    _s.onDown = async (event) => {
        if (!_s) return;
        const view = canvas?.app?.view ?? null;
        const target = event?.target;
        const onCanvas = (view && target === view) || target?.tagName === "CANVAS" || target?.id === "board";
        if (!onCanvas) return;
        if (event.button !== 0) return;
        event.preventDefault();
        try { event.stopImmediatePropagation?.(); } catch (_) {}
        event.stopPropagation();
        const tokens = (_s.hoverTokens ?? []).slice();
        if (!tokens.length) { cancelWeaponTargeting(); return; }   // clicked empty → abort
        const onPick = _s.onPick;
        let chosen = tokens[0];
        if (tokens.length > 1) {
            // Two+ tokens stacked on the tile — ask which. Overlay stays up
            // during the chooser, torn down after a pick/cancel.
            chosen = await chooseTargetToken(tokens);
            if (!_s) return;                      // torn down while choosing
            if (!chosen) { cancelWeaponTargeting(); return; }
        }
        const targetActor = chosen?.actor;
        _s.onCancel = null;                        // a pick is not a cancel
        cancelWeaponTargeting();
        if (targetActor) { try { onPick?.(targetActor); } catch (err) { console.warn(`${SYSTEM_ID} | onPick failed`, err); } }
    };
    document.addEventListener("pointerdown", _s.onDown, { capture: true, passive: false });
    // Zoom → keep the label a constant on-screen size (canvasPan fires on zoom).
    _s.hookIds.canvasPan = Hooks.on("canvasPan", () => updateLabelTransform());

    /* Right-click cancel — a document-level `contextmenu` capture listener,
     * NOT a pointerdown branch. Foundry's canvas input manager swallows the
     * right-click pointerdown for non-GM clients before it reaches the view;
     * `contextmenu` capture still runs first on every client (same reason
     * immersive-tactical-grid.mjs uses this channel). Only acts on canvas-
     * targeted events, and yields to an active AoE template preview. */
    _s.onContext = (event) => {
        if (!_s) return;
        const view = canvas?.app?.view ?? null;
        const target = event?.target;
        const onCanvas = (view && target === view) || target?.tagName === "CANVAS" || target?.id === "board";
        if (!onCanvas) return;
        if ((canvas?.templates?.preview?.children?.length ?? 0) > 0) return;
        /* Fully consume the right-click: cancel the pick and stop it here. The
         * immersive tactical grid's own document-capture contextmenu handler
         * defers when a target overlay is active (isTargetingActive check), so
         * the movement overlay does NOT accidentally open on this right-click. */
        try { event.stopImmediatePropagation?.(); } catch (_) {}
        try { event.stopPropagation?.(); } catch (_) {}
        try { event.preventDefault?.(); } catch (_) {}
        cancelWeaponTargeting();
    };
    document.addEventListener("contextmenu", _s.onContext, { capture: true });

    _s.onKey = (e) => { if (_s && e.key === "Escape") { e.preventDefault(); cancelWeaponTargeting(); } };
    window.addEventListener("keydown", _s.onKey, { capture: true });

    // Bail on scene teardown / combat end / the attacker token vanishing.
    _s.hookIds.canvasTearDown = Hooks.on("canvasTearDown", () => cancelWeaponTargeting());
    _s.hookIds.deleteCombat   = Hooks.on("deleteCombat",   () => cancelWeaponTargeting());
    _s.hookIds.deleteToken    = Hooks.on("deleteToken", (doc) => {
        if (doc?.id && _s?.attackerToken?.id === doc.id) cancelWeaponTargeting();
    });
    /* Token updates while targeting:
     *   - The ATTACKER *moving* (x/y) closes the overlay outright — you've
     *     repositioned, so re-open to target from the new spot (avoids the
     *     lag of chasing a live move).
     *   - The attacker *rotating* → recompute so the FOV cone follows facing.
     *   - Any other token moving/resizing/hiding → recompute valid targets. */
    _s.hookIds.updateToken    = Hooks.on("updateToken", (doc, changes) => {
        if (!_s) return;
        const isAttacker = doc?.id === _s.attackerToken?.id;
        if (isAttacker && ("x" in changes || "y" in changes)) { cancelWeaponTargeting(); return; }
        if ("x" in changes || "y" in changes || "width" in changes || "height" in changes
            || "rotation" in changes || "hidden" in changes || "elevation" in changes) {
            scheduleRebuild();
        }
    });
    /* Rotation is ANIMATED: Foundry's _animate writes intermediate
     * document.rotation each frame and fires refreshToken (see immersive-token-
     * camera.mjs). Rebuilding only on updateToken reads an early-animation
     * rotation, so the FOV cone freezes ~one turn behind. Rebuild every
     * refreshToken frame FOR THE ATTACKER so the cone tracks the turn to its
     * final facing. (Moves already close the overlay, so this is rotation.) */
    _s.hookIds.refreshToken   = Hooks.on("refreshToken", (tok) => {
        if (_s && tok?.id === _s.attackerToken?.id) scheduleRebuild();
    });

    // Opening a target pick supersedes the movement overlay — close it so the
    // two overlays don't stack on the canvas.
    try { hideMovementOverlay(); } catch (_) {}

    ui.notifications?.info(t("WITCHER.Combat.TileTargeting.Prompt",
        "Click a highlighted target to attack — right-click or Esc to cancel."));
    return true;
}

/** Tear the session down: detach every listener + hook, destroy the layer,
 *  fire onCancel unless a pick already consumed it. Safe to call when idle. */
export function cancelWeaponTargeting() {
    const s = _s;
    if (!s) return;
    _s = null;                                     // null first so re-entrant hooks no-op
    try { canvas?.stage?.off?.("pointermove", s.onMove); } catch (_) {}
    try { document.removeEventListener("pointerdown", s.onDown, { capture: true }); } catch (_) {}
    try { document.removeEventListener("contextmenu", s.onContext, { capture: true }); } catch (_) {}
    try { window.removeEventListener("keydown", s.onKey, { capture: true }); } catch (_) {}
    try { if (s.hookIds?.canvasPan)      Hooks.off("canvasPan",      s.hookIds.canvasPan); } catch (_) {}
    try { if (s.hookIds?.canvasTearDown) Hooks.off("canvasTearDown", s.hookIds.canvasTearDown); } catch (_) {}
    try { if (s.hookIds?.deleteCombat)   Hooks.off("deleteCombat",   s.hookIds.deleteCombat); } catch (_) {}
    try { if (s.hookIds?.deleteToken)    Hooks.off("deleteToken",    s.hookIds.deleteToken); } catch (_) {}
    try { if (s.hookIds?.updateToken)    Hooks.off("updateToken",    s.hookIds.updateToken); } catch (_) {}
    try { if (s.hookIds?.refreshToken)   Hooks.off("refreshToken",   s.hookIds.refreshToken); } catch (_) {}
    try { if (s.layer && !s.layer.destroyed) s.layer.destroy({ children: true }); } catch (_) {}
    try { s.onCancel?.(); } catch (_) {}
}

/** True while a targeting session is live (used to suppress conflicting UI). */
export function isTargetingActive() { return !!_s; }
