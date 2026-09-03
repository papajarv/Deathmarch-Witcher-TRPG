/**
 * clinch.mjs — geometry, queries, positioning and break helpers for the
 * CLINCH hold variant.
 *
 * The hold registry (mechanics/holdRegistry.mjs) already stores clinch as a
 * DIRECTIONAL pair `{ holderUuid, targetUuid, kind: "clinched" }`, so clinch
 * is inherently UNILATERAL and multi-party: A can clinch B (A holder, B
 * target); C can add their own pair on B; B moving away breaks EVERY pair B
 * is in. This module layers the positional + movement rules on top of that:
 *
 *   • On clinch, the clincher steps right up to the target's face — their
 *     token centre lands on the grid line separating the two tiles (½ tile
 *     from the target's centre). Gridless → ½ · grid.distance along the
 *     approach vector. See positionClincher().
 *   • The FIRST movement by ANYONE in a clinch (holder or target) breaks
 *     every clinch they're in and is truncated to a single step onto the
 *     grid centre in the move direction (the "break-step"). Then they move
 *     freely. Enforced in policy/canvas-movement.mjs via clinchBreakSnap()
 *     + breakActorClinches(). Works in AND out of combat; the ~1-tile
 *     break-step is budgeted normally when in combat.
 *
 * Kept separate from holdLink.mjs so the movement policy can import the
 * light geometry/query helpers without pulling the whole hold-link module's
 * chat/socket surface into the canvas hot path.
 */

import { normalizedActorUuid, clearHoldLink } from "./holdLink.mjs";
import { getHoldsSync } from "./holdRegistry.mjs";
import { isDeadActor } from "./deadState.mjs";
import { isSpottedBy } from "./stealth.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";

/* ── geometry primitives ─────────────────────────────────────────────── */

/** Grid tile size in px (falls back to 100 when the scene has no grid). */
function gridPx() { return Number(canvas?.scene?.grid?.size) || 100; }

/** True when the scene is gridless (grid type 0). */
function isGridless() { return (Number(canvas?.scene?.grid?.type) || 0) === 0; }

/** An actor's primary token placeable, or null. */
function primaryToken(actor) { return actor?.getActiveTokens?.()?.[0] ?? null; }

/** Centre point {x,y} of a token placeable in canvas px. */
function tokenCenter(tok) {
    if (!tok) return null;
    if (tok.center && Number.isFinite(tok.center.x)) return { x: tok.center.x, y: tok.center.y };
    const gs = gridPx();
    const w = (Number(tok.document?.width) || 1) * gs;
    const h = (Number(tok.document?.height) || 1) * gs;
    return { x: (tok.document?.x ?? 0) + w / 2, y: (tok.document?.y ?? 0) + h / 2 };
}

/** Token-document top-left {x,y} that places the token's CENTRE at `cx,cy`. */
function centerToTopLeft(tokenDoc, cx, cy) {
    const gs = gridPx();
    const w = (Number(tokenDoc?.width) || 1) * gs;
    const h = (Number(tokenDoc?.height) || 1) * gs;
    return { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2) };
}

/* ── queries ─────────────────────────────────────────────────────────── */

/** All clinch pairs an actor is in, either role. `[]` when none / no cache. */
export function clinchPairsFor(actor) {
    const uuid = normalizedActorUuid(actor);
    if (!uuid) return [];
    let pairs = [];
    try { pairs = getHoldsSync(uuid) ?? []; } catch (_) { pairs = []; }
    return pairs.filter(p =>
        p?.kind === "clinched" && (p.holderUuid === uuid || p.targetUuid === uuid));
}

/** True if the actor is currently in any clinch (holder or target). */
export function isClinched(actor) { return clinchPairsFor(actor).length > 0; }

/* ── positioning (establish) ─────────────────────────────────────────── */

/** GM-side: step the clincher's token right up to the target — its centre
 *  lands ½ tile from the target's centre, on the side the clincher
 *  approached from (i.e. sitting on the shared grid line). No-op if either
 *  token is missing (theatre-of-mind) or we aren't the active GM. Issued
 *  with bypass flags so it neither self-breaks the clinch nor charges the
 *  clincher's movement budget (that's handled separately as "spent whole
 *  movement to clinch"). */
export async function positionClincher(holderActor, targetActor) {
    if (!game.user?.isActiveGM) return;
    const hTok = primaryToken(holderActor);
    const tTok = primaryToken(targetActor);
    if (!hTok?.document || !tTok) return;
    const hc = tokenCenter(hTok);
    const tc = tokenCenter(tTok);
    if (!hc || !tc) return;

    const half = gridPx() * 0.5;   // ½ tile in px (gridless uses grid.size too)
    let dx = hc.x - tc.x, dy = hc.y - tc.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) return;           // exactly overlapping — nothing sensible to do
    dx /= len; dy /= len;

    const newCx = tc.x + dx * half;
    const newCy = tc.y + dy * half;
    const dest = centerToTopLeft(hTok.document, newCx, newCy);
    /* Render the clincher UNDER the clinchee so it doesn't obscure the token
     * it's grabbing: drop its sort below the target's. Stash the previous
     * sort in a flag so the clinch clear can restore it (see holdLink
     * _doClearHoldLink). Always issue the update (even if the position is
     * unchanged) so the sort/flag get written. */
    const targetSort = Number(tTok.document.sort) || 0;
    const newSort    = targetSort - 1;
    /* Stash the clincher's EXACT origin (top-left + sort) BEFORE stepping them
     * onto the shared grid line — mirrors positionPinner's `pinPrevPos`. The
     * break recentre restores from this snapshot, so the return-to-tile is
     * deterministic and independent of the clinchee's (by then possibly
     * already-moved) position. Previously only the sort was stashed and the
     * origin cell was reverse-engineered geometrically at break time, which
     * could round back onto the grid-line cell and silently leave the clincher
     * stuck forward.
     *
     * Stamp it FRESH every time (no `already`-preservation like pins use). A
     * clinch has no in-clinch re-position, so the holder's CURRENT tile at
     * establish IS the true origin. And crucially: if the holder had earlier
     * walked out of a clinch on their own (which skips the recentre and can
     * leave a stale `clinchPrevPos` behind), preserving that stale value would
     * teleport them to a tile from a previous clinch on break. Overwriting kills
     * that hazard — the snapshot always reflects THIS clinch. */
    const prevPos = {
        x:    Number(hTok.document.x) || 0,
        y:    Number(hTok.document.y) || 0,
        sort: Number(hTok.document.sort) || 0
    };
    try {
        await hTok.document.update(
            { ...dest, sort: newSort, flags: { [SYSTEM_ID]: { clinchPrevPos: prevPos } } },
            { wdmClinchMove: true, wdmForcedMove: true, animate: true }
        );
    } catch (err) {
        console.warn(`${SYSTEM_ID} | clinch positioning failed`, err);
    }
}

/** GM-side: step the PINNER right onto the pinned foe — like positionClincher,
 *  but the pinner sits ABOVE the pinned token (sort higher) instead of below.
 *  Stashes the pinner's EXACT original top-left + sort in `pinPrevPos` so the
 *  pin clear / reverse can put them back precisely. */
export async function positionPinner(holderActor, targetActor) {
    if (!game.user?.isActiveGM) return;
    const hTok = primaryToken(holderActor);
    const tTok = primaryToken(targetActor);
    if (!hTok?.document || !tTok) return;
    const hc = tokenCenter(hTok);
    const tc = tokenCenter(tTok);
    if (!hc || !tc) return;

    const half = gridPx() * 0.5;
    let dx = hc.x - tc.x, dy = hc.y - tc.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) return;
    dx /= len; dy /= len;

    const dest = centerToTopLeft(hTok.document, tc.x + dx * half, tc.y + dy * half);
    const targetSort = Number(tTok.document.sort) || 0;
    /* Don't clobber a stash from an earlier reposition (e.g. reverse) — keep the
     * FIRST original position so a break restores the true starting tile. */
    const already   = hTok.document.getFlag?.(SYSTEM_ID, "pinPrevPos");
    const prevPos    = already ?? { x: Number(hTok.document.x) || 0, y: Number(hTok.document.y) || 0, sort: Number(hTok.document.sort) || 0 };
    try {
        await hTok.document.update(
            { ...dest, sort: targetSort + 1, flags: { [SYSTEM_ID]: { pinPrevPos: prevPos } } },   // ABOVE the pinned foe
            { wdmClinchMove: true, wdmForcedMove: true, animate: true }
        );
    } catch (err) {
        console.warn(`${SYSTEM_ID} | pin positioning failed`, err);
    }
}

/** GM-side: put a former pinner's token back exactly where positionPinner found
 *  it (from the `pinPrevPos` flag) and clear the marker. No-op if unset. */
export async function restorePinner(holderActor) {
    if (!game.user?.isActiveGM) return;
    const hTok = primaryToken(holderActor);
    if (!hTok?.document) return;
    const prev = hTok.document.getFlag?.(SYSTEM_ID, "pinPrevPos");
    if (!prev) return;
    try {
        await hTok.document.update(
            { x: Number(prev.x) || 0, y: Number(prev.y) || 0, sort: Number(prev.sort) || 0, [`flags.${SYSTEM_ID}.-=pinPrevPos`]: null },
            { wdmClinchMove: true, wdmForcedMove: true, animate: true }
        );
    } catch (err) {
        console.warn(`${SYSTEM_ID} | pin restore failed`, err);
    }
}

/* ── break (movement) ────────────────────────────────────────────────── */

/** The "break-step" destination for a clinched actor's first move: a single
 *  step onto the grid centre in the direction of the intended move.
 *  Returns a token-document {x,y} top-left. On a grid, steps exactly one
 *  cell (8-way) toward the destination and snaps to that cell's centre;
 *  gridless, steps one grid.distance along the move vector. If the move has
 *  no real direction, snaps to the current cell's centre. */
export function clinchBreakSnap(tokenDoc, changes) {
    const grid = canvas?.grid;
    const gs = gridPx();
    const w = Number(tokenDoc?.width) || 1, h = Number(tokenDoc?.height) || 1;
    const fromX = Number(tokenDoc?.x) || 0, fromY = Number(tokenDoc?.y) || 0;
    const toX = (changes?.x !== undefined) ? Number(changes.x) : fromX;
    const toY = (changes?.y !== undefined) ? Number(changes.y) : fromY;
    const fromC = { x: fromX + w * gs / 2, y: fromY + h * gs / 2 };
    const toC   = { x: toX   + w * gs / 2, y: toY   + h * gs / 2 };

    if (!isGridless() && grid?.getOffset && grid?.getCenterPoint) {
        try {
            let vx = toC.x - fromC.x, vy = toC.y - fromC.y;
            const len = Math.hypot(vx, vy);
            if (len < 1) {
                const c = grid.getCenterPoint(grid.getOffset(fromC));
                return centerToTopLeft(tokenDoc, c.x, c.y);
            }
            /* Nudge 0.75 tile in the MOVE direction from the current centre,
             * THEN snap to that cell. Snapping the raw on-the-line position
             * (½ tile toward the target) is ambiguous — getOffset can round
             * to the TARGET's cell, which made the disengage land "forward".
             * From the ½-tile clinch position a move away lands squarely on
             * the ORIGIN tile (0.5 + 0.75 = 1.25 → origin cell); from a
             * centred token it's a clean one-tile step in the move direction. */
            const nudge = gs * 0.75;
            const P = { x: fromC.x + vx / len * nudge, y: fromC.y + vy / len * nudge };
            const c = grid.getCenterPoint(grid.getOffset(P));
            return centerToTopLeft(tokenDoc, c.x, c.y);
        } catch (_) { /* fall through to gridless math */ }
    }

    // Gridless: one grid.distance (= gs px) toward the destination.
    let vx = toC.x - fromC.x, vy = toC.y - fromC.y;
    const len = Math.hypot(vx, vy);
    if (len < 1) return { x: fromX, y: fromY };
    vx = vx / len * gs; vy = vy / len * gs;
    return { x: Math.round(fromX + vx), y: Math.round(fromY + vy) };
}

/* ── clinch target overlay (movement menu) ───────────────────────────── */

/** Show a click-to-clinch overlay: highlight every token within one tile of
 *  the actor (the reach a clinch can be established at) and resolve to the
 *  actor of whichever the user clicks. Resolves:
 *    • the picked target's Actor,
 *    • null if the user cancels (Esc / click empty),
 *    • undefined if there are NO candidates in reach (caller may fall back
 *      to the user's manual target).
 *  Adjacency is re-gated inside applyHoldLink, so a marginal candidate that
 *  slips through the ≤1-tile filter is still refused there. Defensive: any
 *  draw error resolves undefined so the caller falls back gracefully. */
/** The world-actor UUIDs an actor is clinched WITH (its clinch partners, either
 *  role). Empty set when not clinched. */
export function clinchPartnerUuids(actor) {
    const uuid = actor ? normalizedActorUuid(actor) : null;
    if (!uuid) return new Set();
    return new Set(clinchPairsFor(actor).map(p => (p.holderUuid === uuid ? p.targetUuid : p.holderUuid)));
}

/**
 * @param {Actor} actor
 * @param {{allowedUuids?:Set<string>}} [opts]  When `allowedUuids` is a non-empty
 *        set, only tokens whose actor's normalized UUID is in it are pickable —
 *        used to lock a clinched attacker's target to their clinch partner.
 */
export function showClinchOverlay(actor, { allowedUuids = null } = {}) {
    return new Promise((resolve) => {
        try {
            const tok = actor?.getActiveTokens?.()?.[0];
            const controls = canvas?.controls;
            if (!tok || !controls?.addChild) { resolve(undefined); return; }
            const gs = gridPx();
            const tc = tokenCenter(tok);
            if (!tc) { resolve(undefined); return; }

            const candidates = (canvas?.tokens?.placeables ?? []).filter(t => {
                if (!t?.actor || t === tok) return false;
                if (t.document?.hidden && !game.user?.isGM) return false;
                // Secret disposition — a hidden NPC; not clinchable by anyone.
                if (Number(t.document?.disposition) === (CONST?.TOKEN_DISPOSITIONS?.SECRET ?? -2)) return false;
                if (isDeadActor(t.actor)) return false;   // can't clinch a corpse
                if (t.actor?.type === "loot") return false;   // loot piles aren't combatants
                if (!isSpottedBy(t.actor, actor)) return false;   // stealthed & not spotted by the clincher
                if (allowedUuids && allowedUuids.size && !allowedUuids.has(normalizedActorUuid(t.actor))) return false;
                const c = tokenCenter(t);
                if (!c) return false;
                const cheb = Math.max(Math.abs(c.x - tc.x), Math.abs(c.y - tc.y)) / (gs || 1);
                return cheb <= 1.1;   // within a tile's reach (applyHoldLink re-gates)
            });
            if (!candidates.length) { resolve(undefined); return; }

            const layer = new PIXI.Container();
            layer.eventMode = "static";
            let done = false;
            const cleanup = () => {
                document.removeEventListener("keydown", onKey, true);
                document.removeEventListener("pointerdown", onDocPointer, true);
                document.removeEventListener("contextmenu", onCtxMenu, true);
                try { if (!layer.destroyed) layer.destroy({ children: true }); } catch (_) {}
            };
            const finish = (val) => { if (done) return; done = true; cleanup(); resolve(val); };
            const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); finish(null); } };
            /* RIGHT-click anywhere cancels the pick (and suppress the browser
             * context menu while the overlay is up). LEFT-click selects a
             * highlighted token; left-click on empty ground is ignored. */
            const onDocPointer = (e) => {
                if (e.button === 2) { e.preventDefault(); e.stopPropagation(); finish(null); }
            };
            const onCtxMenu = (e) => { e.preventDefault(); e.stopPropagation(); };
            document.addEventListener("keydown", onKey, true);
            document.addEventListener("pointerdown", onDocPointer, true);
            document.addEventListener("contextmenu", onCtxMenu, true);

            for (const t of candidates) {
                const c = tokenCenter(t);
                const rad = Math.max(t.w ?? gs, t.h ?? gs) * 0.6;
                const g = new PIXI.Graphics();
                g.eventMode = "static";
                g.cursor = "pointer";
                const draw = (hover) => {
                    g.clear();
                    g.lineStyle(hover ? 4 : 3, 0xb89464, hover ? 1 : 0.85);
                    g.beginFill(0xb89464, hover ? 0.20 : 0.08);
                    g.drawCircle(c.x, c.y, rad);
                    g.endFill();
                };
                draw(false);
                g.on("pointerover", () => draw(true));
                g.on("pointerout", () => draw(false));
                /* LEFT mouse button only (button === 0) selects this target;
                 * other buttons fall through to the document handler (right =
                 * cancel). */
                g.on("pointerdown", (ev) => {
                    if ((ev?.button ?? 0) !== 0) return;
                    try { ev.stopPropagation?.(); } catch (_) {}
                    finish(t.actor);
                });
                layer.addChild(g);
            }
            controls.addChild(layer);
        } catch (err) {
            console.warn(`${SYSTEM_ID} | clinch overlay failed`, err);
            resolve(undefined);
        }
    });
}

/** Break EVERY clinch the actor is in (both roles). Routed through
 *  clearHoldLink so player clients socket the clear to the GM. Best-effort;
 *  fire-and-forget from the movement hot path. */
export async function breakActorClinches(actor, reason = "movement") {
    const pairs = clinchPairsFor(actor);
    if (!pairs.length) return;
    const uuid = normalizedActorUuid(actor);
    for (const p of pairs) {
        const partnerUuid = (p.holderUuid === uuid) ? p.targetUuid : p.holderUuid;
        try {
            const partner = await fromUuid(partnerUuid);
            await clearHoldLink(actor, reason, partner ?? null);
        } catch (err) {
            console.warn(`${SYSTEM_ID} | clinch break failed`, err);
        }
    }
}
