/**
 * Drag — a grappler-only action resolved by an OPPOSED PHYSIQUE test (auto-
 * rolled, no defender combat-skill defense). On a win the grappler opens a
 * reachable-tile overlay (wall-respecting, sight-limited — "a location you can
 * see") whose radius is the drag distance:
 *
 *   distance = |physique-base difference|, minimum 2m, capped by free movement
 *
 * Picking a tile drags BOTH the grappler and the still-held target there. The
 * moves pass `preserveHolds` (wdmClinchMove) so the hold stack does NOT snap —
 * a drag deliberately moves the pair together (otherwise the first tile of
 * movement instantly breaks the clinch/grapple).
 */

import { emitMoveToken } from "../setup/socketHook.mjs";
import { computeReachableCells } from "../policy/immersive-tactical-grid.mjs";
import { pickPushDirection, PICK_DIRECTION_BACK } from "../applications/pushDirectionDialog.mjs";
import { rollWitcherD10 } from "../rolls/extendedRoll.mjs";
import { t, tFormat } from "../chrome/lib/i18n.js";

const esc = (s) => Handlebars.escapeExpression(String(s ?? ""));
const AMBER = 0xc8a878;
const EDGE  = 0x6e5224;

/* Foundry token-facing: rotation 0 = looking SOUTH (down) for the marketplace/
 * portrait tokens this system targets — same −90 offset canvas-auto-face uses.
 * Returns the rotation (deg) for a token at `from` centre to face `to` centre. */
function facingDeg(from, to) {
    const deg = Math.atan2(Number(to.y) - Number(from.y), Number(to.x) - Number(from.x)) * 180 / Math.PI;
    return Math.round((deg - 90 + 360) % 360);
}

/* True while a Drag destination/facing pick is open — the immersive movement
 * grid checks this so a right-click during the pick cancels IT (not open the
 * movement overlay). Mirrors weapon-target-overlay's isTargetingActive. */
let _dragActive = false;
export function isDragActive() { return _dragActive; }

/** Physique base = BODY stat + Physique skill. */
export function physiqueBase(actor) {
    return (Number(actor?.system?.stats?.body?.value) || 0)
         + (Number(actor?.system?.skills?.body?.physique?.value) || 0);
}

/** Overlay: highlight every tile the token can reach within `meters` (Dijkstra,
 *  wall + sight respecting) and resolve the clicked tile. Returns
 *  { x, y, cost } (world cell centre + path cost) or null if cancelled. */
export async function pickDragDestination(token, meters) {
    if (!canvas?.ready || !canvas.stage || !token) return null;
    const grid = canvas.grid;
    const cells = computeReachableCells(token, meters);
    const reach = [...cells.values()].filter(c => c.cost > 0);
    if (!reach.length) return null;
    const byKey = new Map(reach.map(c => [`${c.i},${c.j}`, c]));

    const host  = canvas.controls ?? canvas.interface ?? canvas.stage;
    const layer = new PIXI.Container();
    layer.eventMode = "none";
    layer.zIndex = 210;
    const baseG  = layer.addChild(new PIXI.Graphics());
    const hoverG = layer.addChild(new PIXI.Graphics());
    try { host.addChild(layer); } catch (_) {}

    const polyOf = (c) => {
        const verts = grid.getVertices?.({ i: c.i, j: c.j });
        if (!Array.isArray(verts) || verts.length < 3) return null;
        const flat = [];
        for (const v of verts) flat.push(v.x, v.y);
        return flat;
    };
    baseG.lineStyle(1, EDGE, 0.4);
    baseG.beginFill(AMBER, 0.14);
    for (const c of reach) { const p = polyOf(c); if (p) baseG.drawPolygon(p); }
    baseG.endFill();

    return new Promise((resolve) => {
        let done = false, hoverKey = null;
        const onMove = (event) => {
            let world; try { world = event.getLocalPosition(canvas.stage); } catch (_) { return; }
            const off = grid.getOffset?.(world);
            if (!off) return;
            const key = `${off.i},${off.j}`;
            if (key === hoverKey) return;
            hoverKey = key;
            hoverG.clear();
            const c = byKey.get(key);
            if (c) {
                const p = polyOf(c);
                if (p) { hoverG.lineStyle(2, 0xffe6cf, 0.9); hoverG.beginFill(AMBER, 0.42); hoverG.drawPolygon(p); hoverG.endFill(); }
            }
        };
        const onDown = (event) => {
            if (event.button !== 0) return;
            const view = canvas?.app?.view ?? null;
            const tgt  = event?.target;
            const onCanvas = (view && tgt === view) || tgt?.tagName === "CANVAS" || tgt?.id === "board";
            if (!onCanvas) return;
            event.preventDefault();
            try { event.stopImmediatePropagation(); } catch (_) {}
            event.stopPropagation();
            const c = byKey.get(hoverKey);
            finish(c ? { x: c.centerX, y: c.centerY, cost: c.cost } : null);
        };
        const onCtx = (event) => { event.preventDefault(); event.stopPropagation(); finish(null); };
        const onKey = (event) => { if (event.key === "Escape") { event.preventDefault(); finish(null); } };
        const cleanup = () => {
            try { canvas.stage.off("pointermove", onMove); } catch (_) {}
            try { document.removeEventListener("pointerdown", onDown, { capture: true }); } catch (_) {}
            try { document.removeEventListener("contextmenu", onCtx, { capture: true }); } catch (_) {}
            try { window.removeEventListener("keydown", onKey, { capture: true }); } catch (_) {}
            try { if (!layer.destroyed) layer.destroy({ children: true }); } catch (_) {}
        };
        const finish = (val) => { if (done) return; done = true; cleanup(); resolve(val); };

        canvas.stage.on("pointermove", onMove);
        document.addEventListener("pointerdown", onDown, { capture: true, passive: false });
        document.addEventListener("contextmenu", onCtx, { capture: true });
        window.addEventListener("keydown", onKey, { capture: true });
        try { ui.notifications?.info(t("WITCHER.Brawl.DragPickDest", "Click a highlighted tile to drag there — right-click or Esc to cancel.")); } catch (_) {}
    });
}

/**
 * Run the whole Drag flow for `grappler` dragging `target`. Returns
 * `{ dragged: metres }` (0 on resist / cancel / no movement).
 */
export async function performDrag(grappler, target) {
    const aTok = grappler?.getActiveTokens?.()?.[0] ?? null;
    const tTok = target?.getActiveTokens?.()?.[0] ?? null;
    if (!target || !aTok?.document?.uuid || !tTok?.document?.uuid) {
        ui.notifications?.warn(t("WITCHER.Brawl.DragNeedsTokens", "Drag needs both you and the target on the canvas."));
        return { dragged: 0 };
    }
    /* A pin locks BOTH parties in place — you can't drag while pinned or pinning. */
    try {
        const { isInPin } = await import("./holdModifiers.mjs");
        if (isInPin(grappler)) {
            ui.notifications?.warn(t("WITCHER.Brawl.DragWhilePinned", "You can't drag while a pin locks you in place — break the pin first."));
            return { dragged: 0 };
        }
    } catch (_) { /* registry unreachable — allow */ }
    const speaker = ChatMessage.getSpeaker({ actor: grappler });
    const myBase = physiqueBase(grappler), theirBase = physiqueBase(target);
    /* Opposed Physique — exploding d10 + base, auto for both, no defender prompt. */
    const myTotal    = myBase    + (Number((await rollWitcherD10())?.total) || 0);
    const theirTotal = theirBase + (Number((await rollWitcherD10())?.total) || 0);
    if (!(myTotal > theirTotal)) {
        await ChatMessage.create({ speaker, content: `<div class="wdm-attack-card"><div class="wdm-attack-rider"><i class="fa-solid fa-hand-back-fist"></i> ${tFormat("WITCHER.Doc.BrawlMixin.Text.DragResisted", { name: esc(target.name), a: myTotal, d: theirTotal }, `<strong>${esc(grappler.name)}</strong> tries to drag <strong>${esc(target.name)}</strong> — Physique <strong>${myTotal}</strong> vs <strong>${theirTotal}</strong>: resisted.`)}</div></div>` });
        return { dragged: 0, resisted: true };
    }
    /* Distance = |base diff|, min 2m, capped by free movement. */
    let dist = Math.max(2, Math.abs(myBase - theirBase));
    const inCombat = !!grappler._inActiveCombat;
    const spd  = Number(grappler.system?.stats?.spd?.value) || 0;
    const used = Number(grappler.system?.combatRound?.movementMeters) || 0;
    const free = inCombat ? Math.max(0, spd - used) : dist;
    dist = Math.min(dist, free);
    if (dist <= 0) {
        ui.notifications?.warn(t("WITCHER.Brawl.DragNoMovement", "No movement left this turn to drag anyone."));
        return { dragged: 0 };
    }
    const gs = canvas?.dimensions?.size ?? 100;
    const half = gs * 0.5;
    /* Where the pair stands BEFORE the drag. A grapple can be held at reach
     * (whip / grappling weapon with Long/Extreme reach, CE), in which case the
     * two are NOT adjacent — dragging must PRESERVE that gap rather than reel
     * the foe into a clinch. `> 1.5` tiles ≡ not adjacent (matches the attack
     * gates' Chebyshev + half-tile grace). */
    const aCenterStart = { x: Number(aTok.center?.x ?? aTok.x), y: Number(aTok.center?.y ?? aTok.y) };
    const tCenterStart = { x: Number(tTok.center?.x ?? tTok.x), y: Number(tTok.center?.y ?? tTok.y) };
    const rangedGrapple = Math.max(Math.abs(aCenterStart.x - tCenterStart.x), Math.abs(aCenterStart.y - tCenterStart.y)) / gs > 1.5;

    /* The drag is anchored on the FOE — the tile you select is where THEY end
     * up (reachable overlay flooded from their token, within the drag distance).
     * Then FACING = which way YOU'LL be looking at them once they're in that tile
     * (you two face each other, so it's the direction from you toward them).
     * `_dragActive` makes a right-click cancel the pick, not pop the grid. */
    _dragActive = true;
    let dest = null, facing = null;
    try {
        /* Two-step pick with a back-step: right-click while aiming the facing
         * returns to the tile picker (PICK_DIRECTION_BACK); Esc there keeps your
         * side; right-click on the tile picker cancels the whole drag. */
        while (true) {
            dest = await pickDragDestination(tTok, dist);
            if (!dest) break;
            /* Ranged grapple: you stay at reach, so there's no clinch side to
             * pick — the foe alone relocates. Skip the facing step. */
            if (rangedGrapple) break;
            facing = await pickPushDirection({ x: dest.x, y: dest.y }, {
                lengthPx: gs,
                backOnRightClick: true,
                promptText: t("WITCHER.Brawl.DragPickFacing", "Pick which way you'll face them — e.g. shove them against the wall you're facing (right-click to re-pick the tile, Esc to keep your side).")
            });
            if (facing === PICK_DIRECTION_BACK) { facing = null; continue; }
            break;
        }
    } finally { _dragActive = false; }
    if (!dest) return { dragged: 0, cancelled: true };

    /* The FOE lands on the picked cell, grid-aligned — clean, never clipping. */
    const tW = (Number(tTok.document.width)  || 1) * gs;
    const tH = (Number(tTok.document.height) || 1) * gs;
    const tNewX = dest.x - tW / 2, tNewY = dest.y - tH / 2;

    if (rangedGrapple) {
        /* Ranged grapple (mancatcher / polearm / whip): the reach is a RIGID
         * link. A drag translates the WHOLE rig by the same vector — pull the
         * foe back one tile and YOU step back one tile too, so the gap is kept
         * exactly (never closed into a clinch, never stretched). Move both by
         * (dest − foeStart); the relative facing is unchanged, so you keep
         * looking at each other. */
        const dx = dest.x - tCenterStart.x, dy = dest.y - tCenterStart.y;
        const aNewCX = aCenterStart.x + dx, aNewCY = aCenterStart.y + dy;
        const aW = (Number(aTok.document.width)  || 1) * gs;
        const aH = (Number(aTok.document.height) || 1) * gs;
        const draggeeRot = facingDeg({ x: dest.x, y: dest.y }, { x: aNewCX, y: aNewCY });
        const draggerRot = facingDeg({ x: aNewCX, y: aNewCY }, { x: dest.x, y: dest.y });
        await emitMoveToken({ tokenUuid: tTok.document.uuid, x: tNewX,             y: tNewY,             rotation: draggeeRot, preserveHolds: true });
        await emitMoveToken({ tokenUuid: aTok.document.uuid, x: aNewCX - aW / 2,   y: aNewCY - aH / 2,   rotation: draggerRot, preserveHolds: true });
    } else {
        /* YOU stand at CLINCH DISTANCE (½ tile) beside them, on the side OPPOSITE the
         * facing you picked, so you end up looking along that direction toward them;
         * cancel keeps your current side relative to them. */
        let aCenter;
        if (facing) {
            aCenter = { x: dest.x - facing.x * half, y: dest.y - facing.y * half };
        } else {
            const ac0 = aCenterStart;
            const tc0 = tCenterStart;
            let ux = ac0.x - tc0.x, uy = ac0.y - tc0.y;
            const ul = Math.hypot(ux, uy) || 1;
            aCenter = { x: dest.x + (ux / ul) * half, y: dest.y + (uy / ul) * half };
        }
        /* No clip/squish: if a wall sits between you and the foe's cell (you tried to
         * stand where a wall is, or the space is tight), drop YOU into the nearest
         * PASSABLE full cell adjacent to them, toward your side — flush, grid-aligned,
         * never through the wall or stacked on them. */
        try {
            const grid    = canvas.grid;
            const backend = CONFIG?.Canvas?.polygonBackends?.move;
            const wallBetween = (to) => !!backend?.testCollision?.({ x: dest.x, y: dest.y }, to, { type: "move", mode: "any" });
            if (backend?.testCollision && wallBetween(aCenter)) {
                const dvx = aCenter.x - dest.x, dvy = aCenter.y - dest.y;
                const dl  = Math.hypot(dvx, dvy) || 1;
                const dir = { x: dvx / dl, y: dvy / dl };
                const destOff   = grid.getOffset({ x: dest.x, y: dest.y });
                const neighbors = grid.getAdjacentOffsets?.(destOff) ?? [];
                let best = null, bestDot = -Infinity;
                for (const off of neighbors) {
                    const c = grid.getCenterPoint(off);
                    if (wallBetween(c)) continue;                       // walled off from the foe
                    const vx = c.x - dest.x, vy = c.y - dest.y, vl = Math.hypot(vx, vy) || 1;
                    const dot = (vx / vl) * dir.x + (vy / vl) * dir.y;   // closest to your side
                    if (dot > bestDot) { bestDot = dot; best = c; }
                }
                aCenter = best ?? { x: dest.x, y: dest.y };
            }
        } catch (_) { /* no backend — leave the ½-tile placement */ }
        const aW = (Number(aTok.document.width)  || 1) * gs;
        const aH = (Number(aTok.document.height) || 1) * gs;

        /* Face each other: you look at the foe, the foe looks back at you. */
        const draggerRot = facingDeg(aCenter, dest);
        const draggeeRot = facingDeg(dest, aCenter);
        await emitMoveToken({ tokenUuid: tTok.document.uuid, x: tNewX,               y: tNewY,               rotation: draggeeRot, preserveHolds: true });
        await emitMoveToken({ tokenUuid: aTok.document.uuid, x: aCenter.x - aW / 2,  y: aCenter.y - aH / 2,  rotation: draggerRot, preserveHolds: true });
    }

    const movedM = Number(dest.cost) || dist;
    if (inCombat) { try { await grappler.recordMovement(movedM); } catch (_) {} }
    await ChatMessage.create({ speaker, content: `<div class="wdm-attack-card"><div class="wdm-attack-rider"><i class="fa-solid fa-people-pulling"></i> ${tFormat("WITCHER.Doc.BrawlMixin.Text.Dragged", { name: esc(target.name), m: movedM.toFixed(1), a: myTotal, d: theirTotal }, `<strong>${esc(grappler.name)}</strong> wins the Physique contest (<strong>${myTotal}</strong> vs <strong>${theirTotal}</strong>) and drags <strong>${esc(target.name)}</strong> <strong>${movedM.toFixed(1)}m</strong>.`)}</div></div>` });
    return { dragged: movedM };
}
