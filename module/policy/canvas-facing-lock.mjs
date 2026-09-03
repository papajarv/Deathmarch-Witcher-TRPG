/**
 * Canvas facing lock — middle-click a token to LOCK your facing onto it.
 *
 * Independent of targeting (no Foundry target, no chevron). Middle-click a
 * token to lock; middle-click it again / your own token / empty ground to
 * unlock. While locked:
 *
 *   • Whenever YOUR controlled token moves, its facing is folded into the
 *     move's own animation so it keeps facing the locked token (no snap-back).
 *   • Whenever the LOCKED token moves, your controlled tokens re-face it
 *     (instant, non-animated — no spin).
 *   • The lock BREAKS the instant a wall cuts your line of sight to it, or it
 *     leaves the scene.
 *
 * A soft ring is drawn around the locked token as the only feedback (no chat /
 * toast notifications).
 *
 * PERFORMANCE: the facing rotation is written EXACTLY (no 45° snap — the
 * immersive camera's snapRotationInPreUpdate skips our `wdmFreeFacing` writes)
 * and NON-ANIMATED, so it doesn't spawn a rotation tween that would make the
 * immersive camera counter-rotate every frame. The line-of-sight test is
 * throttled, and a token's own move refaces it exactly once (via preUpdate),
 * not twice.
 *
 * Facing convention: Foundry rotation 0 = asset looking south, so
 * foundryDeg = atan2(dy,dx) − 90.
 */

import { isTargetingActive } from "./weapon-target-overlay.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const FACING_OFFSET_DEG = -90;
const LOS_THROTTLE_MS = 120;   // don't re-run the wall test more than ~8×/s
const RING_COLOR = 0xc8a878;   // --wdm-amber

/* ── facing math ── */

function tokDoc(t) { return t?.document ?? t; }

function foundryFacingDeg(fromTok, toTok, { fromXY = null, toXY = null } = {}) {
    const fd = tokDoc(fromTok);
    const td = tokDoc(toTok);
    const gridSize = Number(canvas?.scene?.grid?.size) || 100;
    const fx = fromXY ? Number(fromXY[0]) : Number(fd?.x);
    const fy = fromXY ? Number(fromXY[1]) : Number(fd?.y);
    const tx = toXY   ? Number(toXY[0])   : Number(td?.x);
    const ty = toXY   ? Number(toXY[1])   : Number(td?.y);
    const fromCx = (fx || 0) + (Number(fd?.width)  || 1) * gridSize / 2;
    const fromCy = (fy || 0) + (Number(fd?.height) || 1) * gridSize / 2;
    const toCx   = (tx || 0) + (Number(td?.width)  || 1) * gridSize / 2;
    const toCy   = (ty || 0) + (Number(td?.height) || 1) * gridSize / 2;
    const atan2Deg = Math.atan2(toCy - fromCy, toCx - fromCx) * 180 / Math.PI;
    return Math.round((atan2Deg + FACING_OFFSET_DEG + 360) % 360);
}

/** Instant, non-animated reface. `wdmFreeFacing` skips the movement charge AND
 *  the immersive camera's 45° snap (exact angle). */
function refaceTowardDoc(controlledDoc, targetDoc, opts = {}) {
    if (!controlledDoc || !targetDoc || controlledDoc === targetDoc) return;
    const curRot  = Number(controlledDoc.rotation) || 0;
    const wantRot = foundryFacingDeg(controlledDoc, targetDoc, opts);
    const delta   = Math.abs(((wantRot - curRot + 540) % 360) - 180);
    if (delta <= 1) return;
    try { controlledDoc.update({ rotation: wantRot }, { wdmFreeFacing: true, animation: { duration: 0 } }); }
    catch (err) { console.warn(`${SYSTEM_ID} | facing-lock reface failed`, err); }
}

/* ── line-of-sight (break condition), throttled ── */

function centerFrom(tokenDoc, xy = null) {
    const d = tokDoc(tokenDoc);
    const gs = Number(canvas?.scene?.grid?.size) || 100;
    const x = xy ? Number(xy[0]) : Number(d?.x) || 0;
    const y = xy ? Number(xy[1]) : Number(d?.y) || 0;
    return { x: x + (Number(d?.width) || 1) * gs / 2, y: y + (Number(d?.height) || 1) * gs / 2 };
}

function pointsCanSee(a, b) {
    try {
        const Backend = CONFIG?.Canvas?.polygonBackends?.sight;
        if (!Backend?.testCollision) return true;
        return !Backend.testCollision(a, b, { type: "sight", mode: "any" });
    } catch (_) { return true; }
}

/* ── lock state (per client) ── */

let _lockId = null;      // target token being faced
let _lockerId = null;    // the token that OWNS the lock and does the facing. Tracked by ID
                         //   (NOT current selection) so moving the target — which requires
                         //   selecting it, deselecting the locker — still refaces the locker.
let _lastLos = 0;

/** The currently-controlled token, used only to decide the locker at click
 *  time (middle-click). Facing/break logic uses `lockerToken()` by id. */
function primaryControlled() {
    const c = canvas?.tokens?.controlled ?? [];
    if (c.length) return c[0];
    return game.user?.character?.getActiveTokens?.()?.[0] ?? null;
}

function lockTargetToken() {
    return _lockId ? (canvas?.tokens?.get?.(_lockId) ?? null) : null;
}

function lockerToken() {
    return _lockerId ? (canvas?.tokens?.get?.(_lockerId) ?? null) : null;
}

/** Whether the immersive token camera is active — only it snaps rotation to a
 *  45° basis, so only it produces the "wiggle" when a lock ends on an off-grid
 *  facing angle. */
function immersiveActive() {
    try { return game.settings?.get?.(SYSTEM_ID, "immersiveTokenCamera") === true; }
    catch (_) { return false; }
}

/** When a lock ends, the locker is left facing an EXACT (often non-45°) angle —
 *  that's intended while locked. Under the immersive camera, leaving it off the
 *  45° basis makes the camera snap it a moment later, which reads as a one-off
 *  wiggle / grid-snap jump. Do that snap cleanly + immediately (one short
 *  animated turn) instead, so the transition is smooth. No-op when immersive is
 *  off (exact facing is fine to keep there) or already on-grid. */
function snapLockerToGrid(lockerId) {
    if (!lockerId || !immersiveActive()) return;
    const tok = canvas?.tokens?.get?.(lockerId);
    const cur = Number(tok?.document?.rotation);
    if (!tok?.document || !Number.isFinite(cur)) return;
    const snapped = ((Math.round(cur / 45) * 45) % 360 + 360) % 360;
    if (snapped === cur) return;
    /* Defer one frame so we don't re-enter the update that triggered the clear.
     * wdmFreeFacing: no turn-gate + no re-snap (value is already a 45° multiple). */
    requestAnimationFrame(() => {
        try { tok.document.update({ rotation: snapped }, { wdmFreeFacing: true, animation: { duration: 120 } }); }
        catch (_) {}
    });
}

function clearFacingLock() {
    if (!_lockId && !_lockerId) return;
    const lockerId = _lockerId;
    _lockId = null;
    _lockerId = null;
    removeRing();
    snapLockerToGrid(lockerId);
}

function setFacingLock(tokenId, myTok) {
    _lockId = tokenId;
    _lockerId = myTok?.id ?? null;
    _lastLos = 0;
    const target = canvas?.tokens?.get?.(tokenId);
    if (myTok && target) refaceTowardDoc(tokDoc(myTok), tokDoc(target));
    drawRing();
    startSpin();
}

/** Throttled break check. `force` runs it regardless of the throttle window.
 *  Returns true if the lock was broken. */
function breakIfBlocked({ fromXY = null, toXY = null, force = false } = {}) {
    if (!_lockId) return false;
    const now = Date.now();
    if (!force && (now - _lastLos) < LOS_THROTTLE_MS) return false;
    _lastLos = now;
    const me = lockerToken();
    const target = lockTargetToken();
    if (!me || !target) { clearFacingLock(); return true; }
    if (targetVisibleFrom(centerFrom(me.document, fromXY), target, toXY)) return false;  // still visible → keep
    clearFacingLock();
    return true;
}

/** True if ANY of the target's sample points (centre + the four bounding-box
 *  corners) is unobstructed from `a`. Matches Foundry's own "is this token
 *  visible" model, so the lock only breaks when the target is FULLY behind
 *  cover — not when its centre alone briefly clips a wall corner while the
 *  token is plainly still visible. */
function targetVisibleFrom(a, target, toXY) {
    const c  = centerFrom(target.document, toXY);
    const gs = Number(canvas?.scene?.grid?.size) || 100;
    const hw = ((Number(target.w) || gs) / 2) - 2;
    const hh = ((Number(target.h) || gs) / 2) - 2;
    if (pointsCanSee(a, c)) return true;
    if (pointsCanSee(a, { x: c.x - hw, y: c.y - hh })) return true;
    if (pointsCanSee(a, { x: c.x + hw, y: c.y - hh })) return true;
    if (pointsCanSee(a, { x: c.x + hw, y: c.y + hh })) return true;
    if (pointsCanSee(a, { x: c.x - hw, y: c.y + hh })) return true;
    return false;
}

/* ── lock ring (the only visual) ── */

let _ring = null;
let _ringSize = 0;   // last token size the reticle was drawn for (resize detection)

/** The ring is shown ONLY while the locker token is currently selected — the
 *  lock itself persists regardless of selection, but its ring is a per-token
 *  affordance, so it appears only when you have the owning token controlled. */
function isLockerSelected() {
    if (!_lockerId) return false;
    return (canvas?.tokens?.controlled ?? []).some(t => t?.id === _lockerId);
}

/** The target token's on-screen size in pixels — the larger of its width/height
 *  footprint (document grid-units × grid size) times any texture scale. Uses
 *  the DOCUMENT (not `token.w`/`token.h`, which weren't scaling reliably here),
 *  so a 2×2 "large" token gets a ring twice the size of a 1×1. */
function targetPixelSize(tok) {
    const gs  = Number(canvas?.dimensions?.size) || Number(canvas?.scene?.grid?.size) || 100;
    const doc = tok?.document;
    const tsx = Math.abs(Number(doc?.texture?.scaleX)) || 1;
    const tsy = Math.abs(Number(doc?.texture?.scaleY)) || 1;
    const tw  = (Number(doc?.width)  || 1) * gs * tsx;
    const th  = (Number(doc?.height) || 1) * gs * tsy;
    return Math.max(tw, th);
}

function ensureRing() {
    if (_ring && !_ring._destroyed) return _ring;
    _ring = new PIXI.Graphics();
    _ring.eventMode = "none";
    /* Parent into the PRIMARY canvas group and sync its sort keys to ONE z-step
     * below the target's mesh (see syncRing) so it renders BEHIND the token
     * portrait — the "under the token graphics" look — and is roof-occluded like
     * the mesh. (canvas.tokens would always draw it on top of the portrait.) */
    canvas?.primary?.addChild?.(_ring);
    return _ring;
}

/** (Re)draw the lock reticle, sized proportionally to the locked token. All
 *  geometry derives from `base` (half the token's larger dimension) so it
 *  scales cleanly from tiny to huge tokens: a soft glow ring + four quadrant
 *  arcs (gaps on the diagonals) + node dots. Drawn at local (0,0); syncRing
 *  positions it at the token centre and the spin ticker rotates the graphic. */
function drawRing() {
    const tok = lockTargetToken();
    if (!tok) { removeRing(); return; }
    const g = ensureRing();
    const px   = targetPixelSize(tok);
    _ringSize  = px;                     // for resize detection (same metric)
    const base = px / 2;
    const r    = base + Math.max(6, base * 0.14);   // proportional padding, min 6px
    g.clear();

    const arcSeg = (radius, a0, a1) => {
        g.moveTo(Math.cos(a0) * radius, Math.sin(a0) * radius);
        g.arc(0, 0, radius, a0, a1);
    };

    // Soft outer glow — a thick, near-transparent full ring behind the reticle.
    g.lineStyle(Math.max(4, base * 0.10), RING_COLOR, 0.12);
    g.drawCircle(0, 0, r + Math.max(3, base * 0.05));

    // Reticle body — four quadrant arcs with gaps on the diagonals.
    const GAP = 0.30;   // radians of gap on each side of a diagonal
    g.lineStyle(Math.max(2, base * 0.05), RING_COLOR, 0.95);
    for (let k = 0; k < 4; k++) {
        const c = k * Math.PI / 2;                 // cardinal center
        arcSeg(r, c - Math.PI / 4 + GAP, c + Math.PI / 4 - GAP);
    }

    // Node dots sitting in the diagonal gaps.
    g.lineStyle(0);
    g.beginFill(RING_COLOR, 0.9);
    const dot = Math.max(1.5, base * 0.03);
    for (let k = 0; k < 4; k++) {
        const a = (k * Math.PI / 2) + Math.PI / 4;  // diagonal
        g.drawCircle(Math.cos(a) * r, Math.sin(a) * r, dot);
    }
    g.endFill();

    syncRing();
}

/** Follow the target + gate visibility (locker selected AND target visible) +
 *  keep the ring one z-step below the token mesh. Position is set every call
 *  (cheap); the primary re-sort is flagged only when the sort keys actually
 *  change (rare), so we don't force a full primary sort every frame. The spin
 *  (`_ring.rotation`) is left untouched here. */
function syncRing() {
    if (!_ring || _ring._destroyed) return;
    const tok = lockTargetToken();
    if (!tok || !isLockerSelected() || tok.visible === false) { _ring.visible = false; return; }
    _ring.visible = true;
    const c = tok.center;
    _ring.position.set(c.x, c.y);
    const mesh = tok.mesh;
    if (mesh) {
        const el = Number(mesh.elevation) || 0;
        const sl = Number(mesh.sortLayer) || 0;
        const so = Number(mesh.sort) || 0;
        const zi = (Number(mesh.zIndex) || 0) - 1;   // one below the portrait
        if (_ring.elevation !== el || _ring.sortLayer !== sl || _ring.sort !== so || _ring.zIndex !== zi) {
            _ring.elevation = el; _ring.sortLayer = sl; _ring.sort = so; _ring.zIndex = zi;
            if (canvas.primary) canvas.primary.sortDirty = true;
        }
    }
}

function removeRing() {
    stopSpin();
    try { _ring?.destroy?.(); } catch (_) {}
    _ring = null;
}

/* Gentle spin while a lock is active. Runs on the canvas ticker only between
 * lock/unlock (removed on unlock), advances the angle only when the reticle is
 * visible, and drives the per-frame follow so it tracks the target smoothly.
 * One graphic → negligible per-frame cost. */
let _spinTicker = null;
const SPIN_SPEED = 0.012;   // radians per frame (~40°/s at 60fps)
function startSpin() {
    if (_spinTicker) return;
    _spinTicker = () => {
        if (!_ring || _ring._destroyed || !_lockId) return;
        syncRing();
        if (_ring.visible) _ring.rotation += SPIN_SPEED;
    };
    canvas?.app?.ticker?.add?.(_spinTicker);
}
function stopSpin() {
    if (!_spinTicker) return;
    try { canvas?.app?.ticker?.remove?.(_spinTicker); } catch (_) {}
    _spinTicker = null;
}

/* ── hooks ── */

/** Fold the lock-facing rotation into the SAME batch as the locker's x/y move
 *  so the motion animation tweens to the locked facing (no snap-back). Also the
 *  break point for "the LOCKER moved behind cover." Only the locker's own move
 *  is handled here; the target moving is handled in onUpdateToken. */
function onPreUpdateToken(tokenDoc, changes, options, _userId) {
    if (options?.wdmFreeFacing) return;
    if (!_lockId) return;
    if (!("x" in changes) && !("y" in changes)) return;
    if (tokenDoc.id !== _lockerId) return;   // only the LOCKER's own move folds facing
    const target = lockTargetToken();
    if (!target) { clearFacingLock(); return; }

    const movedXY = [
        ("x" in changes ? Number(changes.x) : Number(tokenDoc.x)),
        ("y" in changes ? Number(changes.y) : Number(tokenDoc.y))
    ];
    if (breakIfBlocked({ fromXY: movedXY, force: true })) return;

    const wantRot = foundryFacingDeg(tokenDoc, target, { fromXY: movedXY });
    const curRot  = Number(tokenDoc.rotation) || 0;
    const delta   = Math.abs(((wantRot - curRot + 540) % 360) - 180);
    if (delta <= 1 && !("rotation" in changes)) return;
    changes.rotation = wantRot;
    if (options && typeof options === "object") options.wdmFreeFacing = true;
}

/** The LOCKED target moved → re-face the locker toward its new position. The
 *  locker's OWN move is handled in preUpdate. */
function onUpdateToken(tokenDoc, changes, _options, _userId) {
    if (!_lockId || tokenDoc.id !== _lockId) return;
    if (!("x" in changes) && !("y" in changes)) return;

    const movedXY = [
        ("x" in changes ? Number(changes.x) : Number(tokenDoc.x)),
        ("y" in changes ? Number(changes.y) : Number(tokenDoc.y))
    ];
    if (breakIfBlocked({ toXY: movedXY, force: true })) return;

    /* Re-face the LOCKER (by id) — it works even though the currently-selected
     * token is the target being moved, not the locker. */
    const locker = lockerToken();
    if (locker && locker.id !== _lockId) {
        refaceTowardDoc(locker.document, tokenDoc, { toXY: movedXY });
    }
}

/** The locked token refreshed — keep the reticle synced, and re-draw it if the
 *  token was resized so the reticle rescales. */
function onRefreshToken(tok) {
    if (!_lockId || tok?.id !== _lockId) return;
    if (targetPixelSize(tok) !== _ringSize) drawRing();   // token resized → rescale reticle
    else syncRing();
}

/** Selection changed → re-evaluate ring visibility (shown only while the
 *  locker is selected). The lock itself is unaffected. */
function onControlToken() {
    syncRing();
}

function onDeleteToken(tokenDoc) {
    if (tokenDoc?.id === _lockId || tokenDoc?.id === _lockerId) clearFacingLock();
}

/* ── middle-click toggle ── */

function onCanvasMiddleDown(event) {
    if (event.button !== 1) return;
    const token = canvas?.tokens?.hover;
    if (!token) return;                 // empty ground → let Foundry pan
    if (isTargetingActive?.()) return;  // don't fight a tile-target pick
    event.preventDefault();
    event.stopPropagation();

    const me = primaryControlled();
    if (!me || token.id === me.id) { clearFacingLock(); return; }
    if (_lockId === token.id) { clearFacingLock(); return; }   // toggle off
    setFacingLock(token.id, me);
}

export function registerCanvasFacingLock() {
    Hooks.on("controlToken",   onControlToken);
    Hooks.on("preUpdateToken", onPreUpdateToken);
    Hooks.on("updateToken",    onUpdateToken);
    Hooks.on("refreshToken",   onRefreshToken);
    Hooks.on("deleteToken",    onDeleteToken);
    Hooks.on("canvasReady", () => {
        _lockId = null;
        _lockerId = null;
        removeRing();
        const view = canvas?.app?.view;
        if (!view || view._wdmFacingLockWired) return;
        view.addEventListener("mousedown", onCanvasMiddleDown, { capture: true, passive: false });
        view._wdmFacingLockWired = true;
    });
}

export function getFacingLockId() { return _lockId; }
export function clearFacingLockExternal() { clearFacingLock(); }
/** Token id that OWNS the facing lock (does the facing), or null. */
export function getFacingLockerId() { return _lockerId; }
/** True when `tokenId` is the current facing-locker AND a lock target is set —
 *  i.e. that token's moves should STRAFE (keep facing the locked target, no
 *  auto-rotate to the movement direction). Consumed by the tactical grid /
 *  camera to suppress autoRotate for the duration of the move. */
export function isFacingLockerMoving(tokenId) {
    return !!_lockId && !!_lockerId && tokenId === _lockerId;
}
