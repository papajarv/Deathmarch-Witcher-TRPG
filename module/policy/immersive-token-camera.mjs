import { t, tFormat } from "../chrome/lib/i18n.js";
import { registerImmersiveTacticalGrid, isCommittingTacticalMove } from "./immersive-tactical-grid.mjs";
import { counterRotateWeaponTargetLabel } from "./weapon-target-overlay.mjs";
import { getFacingLockId, getFacingLockerId } from "./canvas-facing-lock.mjs";
/**
 * Immersive Token Camera.
 *
 * GM-only WORLD-scope toggle (settings.mjs registers it as scope:"world";
 * the config-panel row is hidden from non-GMs via hideImmersiveSetting
 * ForNonGM). When ON, every client locks its view to its own single
 * controlled token — token parked below screen center, its facing
 * always up, zoom preserved, click-drag disabled, WASD strafes, Shift+
 * A/D turns 90°, right-mouse-drag temporarily unlocks and animates back
 * to the token on release, and Escape releases the controlled token
 * (immersive apply() reacts by unlocking the camera).
 *
 * ─── Design notes ────────────────────────────────────────────────────
 *
 * 1. Rotation sync (smoothness).
 *    Foundry's Token#_animate updates `document.rotation` / `document.x`
 *    / `document.y` on every animation frame (foundry_copy .../
 *    placeables/token.mjs:2378 mergeObject into this.document). Each
 *    frame fires `refreshToken`. We piggy-back: whenever the locked
 *    token refreshes, read the doc's currently-interpolated values and
 *    re-apply the camera. Result: the world glides smoothly around the
 *    token instead of the token spinning while the world snaps.
 *
 * 2. Foundry rotation convention (token.mjs:4196):
 *      rotation = toDegrees(atan2(dy,dx)) - 90
 *    yields rotation=0 for movement direction south. So doc.rotation=0
 *    means the token faces the bottom of the screen. For that facing
 *    to point up on screen, the stage rotates by (180° − rotation).
 *    Derivation: the token's forward world vector is (-sin r, cos r);
 *    PIXI R(θ)=[cos,-sin; sin,cos]; solving R(θ)·forward = (0,-1) gives
 *    θ = π − r_rad.
 *
 * 3. Token below screen center.
 *    Shifting the stage pivot FORWARD of the token center (in world) by
 *    (off_pixels/scale) puts the token BEHIND screen center in the
 *    rotated view — i.e. lower on screen, more forward view. See
 *    computePivotForOffset for the algebra.
 *
 * 4. Counter-rotation of lock-rotation tokens.
 *    Foundry sets mesh.angle = lockRotation ? 0 : document.rotation
 *    (token.mjs:1555). On a rotated stage that composes to screen angle
 *    = 0 + stageDeg, so lockRotation portraits render upside-down. We
 *    counter-rotate: mesh.angle = -stageDeg. Foundry re-applies its
 *    assignment on every refresh, so `refreshToken` re-installs our
 *    counter per-token.
 *
 * 5. Pan intercept — pan-out on explicit right-mouse-drag only.
 *    A right-mouse-down on the canvas (onRightPointerDown) sets
 *    _panOutActive = true; while it's true, canvasPan fires are
 *    ignored and the user can drag freely. Right-mouse-up
 *    (onRightPointerUp) clears the flag and animates the camera back
 *    to the token over RE_LOCK_ANIMATION_MS via CanvasAnimation
 *    (interpolates pivot x/y AND stage rotation together for smooth
 *    return). Every OTHER canvasPan (perception refresh, region
 *    transition, animation follow, jump-to-token) is treated as a
 *    false positive and its pivot deviation snaps straight back —
 *    that's how "first move after selection" stays glued to the
 *    token. Mouse-wheel zoom is detected as scaleChanged and re-
 *    anchors the pivot silently at the token's screen position.
 *
 * 6. WASD keybindings + Shift modifier.
 *    Registered at init (Foundry rejects post-init registrations) with
 *    PRIORITY precedence so the WASD keydown is consumed before
 *    Foundry's own panUp/Left/Down/Right handlers fire. `reservedModi
 *    fiers: ["Shift"]` makes the binding match with OR without Shift
 *    held (per keyboard-manager.mjs:361 — a non-reserved modifier fails
 *    the match). Screen-cardinal delta rotates by the inverse stage
 *    rotation to produce a world-grid delta for `moveMany`.
 *
 * 7. Facing stays put on WASD.
 *    Foundry's default movement.autoRotate = true makes the token turn
 *    to face its motion direction. `preMoveToken` (hooks.mjs:712 —
 *    autoRotate + showRuler are the only writable fields on `movement`)
 *    lets us flip that off for the locked token. Facing changes only
 *    via Shift+A/D or manual rotation.
 *
 * 8. Shift+A/D relative rotation.
 *    Shift+A turns 90° left, Shift+D turns 90° right, Shift+W/S are
 *    swallowed (nothing). Rotation is authored as a direct doc.update
 *    with the +90 / -90 delta wrapped to [0,360); Foundry animates the
 *    change through its normal update pipeline, and the refreshToken
 *    hook syncs the stage per frame so the world visually pivots.
 *
 * 9. Escape behaviour.
 *    Escape defers to Foundry's default TokenLayer#_onDismissKey, which
 *    for a GM releases the controlled placeables. Immersive apply()
 *    reacts to that release by unlocking the camera (returning to a
 *    vanilla free view), so the GM has a working escape hatch off the
 *    locked token whenever they need one.
 *
 * 10. Drag disable.
 *     Token#_canDrag returns false when immersive is on AND `this` is
 *     the locked token — other tokens (NPCs the GM is arranging) still
 *     drag normally.
 *
 * 11. HUD alignment on a rotated stage.
 *     Foundry's HeadsUpDisplayContainer#align (foundry_copy .../hud/
 *     container.mjs:87) positions the DOM overlay via transform:
 *     scale(s) — no rotation. Waypoint labels use world-coord left /
 *     top values, so on a rotated stage each label lands at the wrong
 *     screen position (world coords projected as if the stage weren't
 *     rotated). That's why the movement-drag ruler distances "aren't
 *     displaying the actual distance" — the numbers themselves are
 *     right (measurePath is world-space and rotation-invariant), but
 *     the label is drawn nowhere near the token so the user reads the
 *     wrong waypoint. We wrap align() to append the stage rotation to
 *     the transform, and stamp --wdm-immersive-neg-rot on the HUD so
 *     each .waypoint-label can counter-rotate its own text and stay
 *     upright / readable.
 */

const SYSTEM_ID   = "witcher-ttrpg-death-march";
const SETTING_KEY = "immersiveTokenCamera";
/* GM-local temporary unlock (client scope) — see settings.mjs. Only meaningful
 * on a GM client; players never read it. */
const GM_UNLOCK_KEY = "immersiveGmUnlock";

/* Re-entry guard for our own canvas.pan() so the canvasPan hook's own
 * snap-back doesn't loop. */
let _selfPan = false;

/* Throttle keyboard-driven moves to Foundry's own cadence (100ms). */
let _lastMoveAt = 0;
const MOVE_THROTTLE_MS = 100;

/* Pan-out state. `_panOutActive` = true means the user is currently
 * holding right-mouse-down to drag the canvas around; while it's true,
 * apply() early-returns so the manual pan isn't fought, and the
 * onRightPointerUp handler animates the camera back to the token.
 * All other pan-fire sources (perception refresh, region transitions,
 * jump-to, animation follow) are treated as false positives — the
 * pivot deviation just snaps straight back inside onCanvasPan. */
let _panOutActive          = false;
const RE_LOCK_ANIMATION_MS = 600;   // duration of the animated return

/* Previous stage scale, tracked so we can distinguish mouse-wheel zoom
 * (scale changed, pivot unchanged) from a genuine pan drag (pivot moved)
 * inside the canvasPan hook. Zoom should re-anchor the pivot silently
 * so the token stays at the same screen position regardless of scale;
 * pan-drag should enter pan-out mode. */
let _prevScale = null;

/* Timestamp until which we suppress the pan-out detector. Whenever
 * doImmersiveMove issues a token movement, downstream Foundry code can
 * fire a canvas.pan (movement follow, ruler auto-pan on some scenes,
 * region-transition camera nudges) that our canvasPan hook would
 * misread as an external pan and enter pan-out mode. Result: the
 * camera stops tracking the token, then the fallback timer catches
 * up "a few seconds later." Suppressing detection for the ~800ms it
 * takes the movement animation to finish keeps the camera glued to
 * the token during and immediately after the strafe. */
let _movementSuppressUntil = 0;
const MOVEMENT_SUPPRESS_MS = 800;

/* Fraction of the viewport height the token sits BELOW center. 0.20
 * puts the token ~70 % down from the top — third-person over-the-
 * shoulder feel without shoving the character into a corner. */
const TOKEN_SCREEN_OFFSET_FRAC = 0.20;

/** Local user's currently-locked token.
 *
 *  Standard case: the single controlled token. Special case: when an
 *  AoE spell template preview is active (castArea.mjs's _drawPreview
 *  adds a WitcherAreaTemplate to canvas.templates.preview), lock to
 *  the caster token stashed on the preview object as `_casterToken`.
 *
 *  The special case exists because Foundry's PlaceableObject#control
 *  (foundry_copy .../placeable-object.mjs:687) returns false silently
 *  when its layer isn't active. When _drawPreview calls canvas.
 *  templates.activate() and THEN attempts casterT.control(), the
 *  tokens layer is no longer active and the control call is a no-op.
 *  If the caster wasn't already controlled at that instant, my
 *  standard findLockTarget would return null throughout the entire
 *  aim, apply() would call release(), and the camera would "uncenter"
 *  and behave as if immersive were toggled off — which is exactly
 *  what the player reported. Falling through to _casterToken during
 *  preview keeps the lock anchored to the actual caster regardless
 *  of Foundry's layer-gated control state. */
export function findLockTarget() {
    const previews = canvas?.templates?.preview?.children;
    if (previews?.length) {
        for (const p of previews) {
            const casterToken = p?._casterToken;
            if (casterToken && !casterToken.destroyed) return casterToken;
        }
    }
    const controlled = canvas?.tokens?.controlled ?? [];
    if (controlled.length !== 1) return null;
    const t = controlled[0];
    /* A destroyed placeable can still linger in the controlled list for
     * one render frame after Foundry tears down a token (scene change,
     * combat cleanup). Reading its .center / .document there yields
     * undefined and apply() would snap the camera to world (0,0). */
    if (!t || t.destroyed) return null;
    return t;
}

/* Memoized enable flag. isEnabled() is read up to twice PER FRAME from the
 * ticker (onImmersiveTicker + the apply() it calls) and once from ~18 event
 * handlers — each read was a live game.settings.get (Map lookup + parse). The
 * value only changes when one of two settings changes, so cache it and
 * invalidate on `updateSetting` (see registerImmersiveTokenCamera). This drops
 * the always-on per-frame settings cost to a single boolean read. */
let _enabledCache = undefined;
export function isEnabled() {
    if (_enabledCache !== undefined) return _enabledCache;
    _enabledCache = _computeEnabled();
    return _enabledCache;
}
function _computeEnabled() {
    try {
        // Global (world) enable — governs everyone, players included.
        if (game.settings.get(SYSTEM_ID, SETTING_KEY) !== true) return false;
        // GM-local temporary unlock (combat-tracker button): steps THIS GM out
        // of the immersive clamps without touching the world setting, so players
        // stay immersive. Client-scope + isGM-gated, so it never affects players.
        if (game.user?.isGM && game.settings.get(SYSTEM_ID, GM_UNLOCK_KEY) === true) return false;
        return true;
    } catch (_) { return false; }
}
/** Drop the memoized enable flag so the next isEnabled() recomputes. */
export function invalidateEnabledCache() { _enabledCache = undefined; }

/** Radians the stage must rotate for `token.document.rotation` (deg) to
 *  point at the top of the screen. See file header § 2 for derivation.
 *
 *  We used to snap the stage rotation to 45° here to make the camera
 *  view direction match the movement basis. That backfired: doc.rotation
 *  animates smoothly (400 ms per Shift+A/D), but a snapped-stage jumped
 *  in 45° chunks every 22.5° of doc-rotation progress — the world
 *  visibly SPAZZED through the rotation instead of turning smoothly.
 *  The fix now lives at the source: `snapRotationInPreUpdate` clamps
 *  every doc.rotation change to a 45° multiple before the update
 *  commits, so doc.rotation is ALWAYS at a 45° angle at rest. The
 *  stage rotation can therefore just track doc.rotation directly and
 *  end up naturally aligned with the movement basis every time. */
function stageRotationForRotationDeg(rotDeg) {
    return Math.toRadians(180 - (Number(rotDeg) || 0));
}

/** Counter-rotate every lockRotation-true token's art so it renders
 *  upright on screen despite the stage being rotated. Also counter-
 *  rotate each token's overlay children (status effects, nameplate,
 *  tooltip, HP bars, target reticles) so those UI badges always face
 *  the viewer regardless of camera rotation. Overlays are children of
 *  the Token placeable (not the mesh), and Token placeables inherit
 *  the stage rotation, so without this fix status icons end up
 *  sideways / upside-down and unreadable on a 180° camera. */
/* Padded world-space view box, recomputed once per rotation frame. Under a
 * rotated stage the axis-aligned box of two opposite corners is not the visible
 * region, so all four corners are inverted. Returns null when the canvas isn't
 * ready, and a null box means "cull nothing" — the safe direction. */
function _viewBoundsForCulling() {
    const stage = canvas?.stage, renderer = canvas?.app?.renderer;
    if (!stage || !renderer) return null;
    try {
        const wt = stage.worldTransform;
        const pts = [[0,0], [renderer.screen.width,0], [0,renderer.screen.height],
                     [renderer.screen.width, renderer.screen.height]]
            .map(([x,y]) => wt.applyInverse(new PIXI.Point(x,y)));
        const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
        const grid = Number(canvas?.grid?.size) || 100;
        const padX = (Math.max(...xs) - Math.min(...xs)) / 8 + grid * 2;
        const padY = (Math.max(...ys) - Math.min(...ys)) / 8 + grid * 2;
        return { left: Math.min(...xs) - padX, right:  Math.max(...xs) + padX,
                 top:  Math.min(...ys) - padY, bottom: Math.max(...ys) + padY };
    } catch (_) { return null; }
}

function applyCounterRotation(stageRotRad) {
    const stageDeg = Math.toDegrees(stageRotRad);
    const negRot = -stageRotRad;
    const tokens = canvas?.tokens?.placeables ?? [];
    /* Off-screen tokens are skipped: their overlays are not observable, and
     * `fixupOneToken` (from refreshToken) plus the next in-view rotation frame
     * both repair them. The box is padded, so a token is corrected well before
     * it slides into view. */
    const view = _viewBoundsForCulling();
    for (const t of tokens) {
        if (!t?.mesh) continue;
        if (view) {
            const cx = t.center?.x, cy = t.center?.y;
            const rx = (Number(t.w) || 0) / 2, ry = (Number(t.h) || 0) / 2;
            if (Number.isFinite(cx) && Number.isFinite(cy)
             && ((cx + rx) < view.left || (cx - rx) > view.right
              || (cy + ry) < view.top  || (cy - ry) > view.bottom)) continue;
        }
        if (t.document?.lockRotation) t.mesh.angle = -stageDeg;
        counterRotateTokenOverlays(t, negRot);
    }
    counterRotateScrollingText(negRot);
    counterRotateWeaponTargetLabel(negRot);
}

/* Foundry's floating status / damage "scrolling text" (core:
 * active-effect.mjs → canvas.interface.createScrollingText) is added to a
 * PRIVATE `#scrollingText` container that lives directly on canvas.interface,
 * which inherits the stage rotation — so on a rotated (e.g. southward) POV it
 * renders upside-down. We can't reach the private field, but the container is
 * the child of canvas.interface carrying the core `zIndexScrollingText` z-index;
 * counter-rotate every PreciseText inside it. The text's anchor is CENTER, so
 * setting `.angle` spins it in place and it reads upright.
 *
 * Runs from the per-frame counter-rotation pass, so text that pops mid-combat is
 * corrected the frame it's drawn — and, being purely a local `.angle` write on
 * THIS client's canvas objects, it never affects what any other user sees. */
let _scrollTextCache = null;
function counterRotateScrollingText(negRotRad) {
    const iface = canvas?.interface;
    const zText = CONFIG?.Canvas?.groups?.interface?.zIndexScrollingText;
    if (!iface || zText == null) return;
    /* Cache the scrolling-text container so we don't walk canvas.interface's
     * children every call just to (usually) find nothing. The container
     * persists once Foundry creates it; re-search only if the cache went
     * stale (destroyed / reparented / z-index changed). */
    let container = _scrollTextCache;
    if (!container || container.destroyed || container.parent !== iface || container.zIndex !== zText) {
        container = null;
        for (const child of (iface.children ?? [])) {
            if (child?.zIndex === zText) { container = child; break; }
        }
        _scrollTextCache = container;
    }
    const kids = container?.children;
    if (!kids?.length) return;   // no active scrolling text → nothing to rotate
    const negDeg = Math.toDegrees(negRotRad);
    for (const text of kids) { if (text) text.angle = negDeg; }
}

/** Every Token PIXI child gets counter-rotated so status icons, name-
 *  plates, HP bars, health-visual overlays, turn markers, targeting
 *  pips, ALL of it renders upright on screen despite the stage
 *  rotation. Two exceptions: the death-march facing arrow (which must
 *  keep indicating world facing — that's its whole job) and the token
 *  mesh (which lives in canvas.primary, not on the Token placeable
 *  anyway). We iterate the children list rather than naming individual
 *  containers because different scenes / modules add different Token
 *  children (health visuals, selection glow, turn marker, target pips
 *  from the death-march overlay layer), and any of them left un-
 *  rotated would render sideways / upside-down on a 180° camera. */
function counterRotateTokenOverlays(token, negRotRad) {
    if (!token) return;
    /* Facing arrow needs to keep showing world facing. Stashed on the
     * token by policy/witcher-token-style.mjs. */
    const facingArrow = token._wdmFacingArrow;

    /* Pivot for the counter-rotation must be the TOKEN CENTER, not the
     * placeable's top-left. Default PIXI container pivot is (0,0) which
     * is Token local origin = Token TOP-LEFT in world; a rotation
     * around that pivot moves the effects grid across the screen as
     * the camera rotates (that's the wtf.png symptom — status rings
     * and facing arrows flung off their tokens during rotation). By
     * setting pivot AND position to the token's center offset, the
     * rotation happens around the character's center, so overlays at
     * layout position (cx, cy) always land at the same screen offset
     * from the character regardless of stage rotation. */
    const w = Number(token.w) || 0;
    const h = Number(token.h) || 0;
    const cx = w / 2;
    const cy = h / 2;

    /* Two counter-rotation modes:
     *
     * PIVOT-SHIFT (rotate around TOKEN CENTER) — for containers whose
     * children are drawn at Token-top-left-relative coords. Without the
     * pivot shift, rotation around (0,0) sends those children flying
     * across the screen. Containers that qualify:
     *   - `token.effects`      — status-icon grid at (col*cell, row*cell)
     *   - `token.targetArrows` — reticle drawn at all four token corners
     *                            (0,0), (w,0), (0,h), (w,h) per Foundry
     *                            v14 token.mjs:1691-1695. Rotating around
     *                            pivot (0,0) flings three of the four
     *                            arrows off-token; only one stays near
     *                            the token and appears offset ("reticle
     *                            one tile off in immersive mode").
     *   - `token.targetPips`   — pips drawn at (w/2, 0) top-edge with
     *                            offset x per user — also token-relative.
     *
     * ROTATE-ONLY (no pivot change) — for containers already positioned
     * at deliberate token-center-relative places whose content rotates
     * around their own origin:
     *   - turnMarker.position = (w/2, h/2)   (Token center)
     *   - nameplate.position  = (w/2, h+off) (below Token)
     *   - tooltip.position    = (w/2, -off)  (above Token)
     * Overwriting their pivot with (w/2, h/2) rotates the CONTENT around
     * the wrong point and flings the marker / label off across the
     * screen. Just set `rotation` and their text/meshes stay upright.
     *
     * The facing arrow is skipped entirely — its whole job is to
     * indicate world-facing, so it should rotate with the world. */
    /* Bail out early on decorations whose parent is the counter-
     * rotation wrapper (`_wdmCounterRotWrapper`). The wrapper rotates
     * around token center by `-canvas.stage.rotation` every frame
     * from `witcher-token-style.mjs`'s ticker, so the child ends up
     * counter-rotated for free — layering a per-child rotation on top
     * would double-apply and put decorations back on their pre-fix
     * drift trajectory. We only need to make sure our own prior writes
     * to `rotation` / `pivot` / `position` from earlier frames don't
     * linger. */
    const isWrapped = (c) => {
        const p = c?.parent;
        return !!(p && p._wdmCounterRotWrapper);
    };
    const rotateWithCenterPivot = (c) => {
        if (!c || c === facingArrow) return;
        if (typeof c.rotation !== "number") return;
        if (isWrapped(c)) {
            /* Reset any stale per-child rotation/pivot from a previous
             * codepath so the wrapper's rotation is the sole source of
             * truth for this child. */
            if (c.rotation !== 0) c.rotation = 0;
            if (c.pivot?.set && (c.pivot.x !== 0 || c.pivot.y !== 0)) c.pivot.set(0, 0);
            return;
        }
        c.rotation = negRotRad;
        if (c.pivot?.set && c.position?.set) {
            if (c.pivot.x !== cx || c.pivot.y !== cy) c.pivot.set(cx, cy);
            if (c.position.x !== cx || c.position.y !== cy) c.position.set(cx, cy);
        }
    };
    const rotateOnly = (c) => {
        if (!c) return;
        if (c === facingArrow) return;
        if (typeof c.rotation !== "number") return;
        if (isWrapped(c)) {
            if (c.rotation !== 0) c.rotation = 0;
            return;
        }
        c.rotation = negRotRad;
    };

    /* Set of containers that need the center-pivot treatment. Keep the
     * membership test cheap (identity comparison). health-state-visuals
     * attaches its own container (wound glow, dying grayscale + skull)
     * directly to Token with `_wdmHealthVisuals=true` — those graphics
     * draw at Token-local (cx, cy) and MUST rotate around the token
     * center too, else they swing off to the side as immersive rotates
     * the world. Detect that container by mark rather than by identity
     * so we don't tightly couple the two policies. */
    /* Center-pivot membership WITHOUT a per-frame Set allocation or the two
     * `.find()` scans that used to hunt for the health-visuals container every
     * frame. The effects / target containers are compared by identity; the
     * health-visual container self-identifies via its `_wdmHealthVisuals` mark
     * (O(1) per child). health-state-visuals may live on the placeable (legacy)
     * OR on the primary-group occlusion carrier (post-reparent) — either way
     * the mark rides on the container, so the identity walk below catches it in
     * whichever child list it sits in. */
    const eff = token.effects, tArr = token.targetArrows, tPip = token.targetPips;
    const walk = (child) => {
        if (child === eff || child === tArr || child === tPip || child?._wdmHealthVisuals === true) {
            rotateWithCenterPivot(child);
        } else {
            rotateOnly(child);
        }
    };

    const children = token.children;
    if (children?.length) for (const child of children) walk(child);
    /* Also walk the primary-group occlusion carrier's children — the
     * token-style reparent (witcher-token-style.mjs) moved Foundry's own
     * bars / nameplate / tooltip / levelIndicator / effects / targetArrows /
     * targetPips plus our facing arrow, health visuals, and turn marker into
     * `token._wdmOcclusionCarrier`, so `token.children` alone misses them. */
    const carrier = token._wdmOcclusionCarrier;
    if (carrier && !carrier.destroyed && carrier.children?.length) {
        for (const child of carrier.children) walk(child);
    }
    /* Explicit rotation for named Foundry containers in case any of
     * them ever route through a path that doesn't put them in the
     * placeable's `children` list at the top level. Property refs
     * on Token stay valid across the reparent — `token.bars` still
     * points to the bars container even after it was moved into the
     * carrier. */
    rotateOnly(token.bars);
    rotateOnly(token.nameplate);
    rotateOnly(token.tooltip);
    rotateOnly(token.levelIndicator);
    rotateWithCenterPivot(token.targetArrows);
    rotateWithCenterPivot(token.targetPips);
    rotateWithCenterPivot(token.effects);
    /* Ours — turn marker, facing arrow, health visuals. Facing arrow
     * gets skipped inside the rotate helpers (it MUST rotate with
     * the world to indicate facing) via the `c === facingArrow`
     * check. Health visuals get the center-pivot treatment because
     * their content is drawn at token-local (cx, cy). */
    rotateOnly(token.turnMarker);
    if (facingArrow) { /* explicit no-op — arrow always rotates with the world */ }
}

/** Per-token version of applyCounterRotation used from `refreshToken`.
 *  Handles both the mesh angle (for lockRotation tokens) and every UI
 *  overlay container. */
function fixupOneToken(token, stageRotRad) {
    if (!token?.mesh) return;
    if (token.document?.lockRotation) {
        token.mesh.angle = -Math.toDegrees(stageRotRad);
    }
    counterRotateTokenOverlays(token, -stageRotRad);
}

/** World-space pivot that places the token at (screen_center_x,
 *  screen_center_y + off) on screen. Derivation:
 *    S = position + R(θ) * scale * (W - pivot)
 *  with position = screen center; we want S(token) = center + (0, off);
 *    pivot = token − R(-θ) * (0, off) / scale
 *  θ = π − r_rad ⇒ cos θ = −cos r, sin θ = sin r; after algebra:
 *    pivot = token + (off/scale) · (−sin r, cos r)
 *  which is the token's forward unit vector scaled by (off/scale). */
function computePivotForOffset(cx, cy, tokenRotDeg) {
    const off = (window.innerHeight || 800) * TOKEN_SCREEN_OFFSET_FRAC;
    const scale = canvas?.stage?.scale?.x || 1;
    const rRad = Math.toRadians(Number(tokenRotDeg) || 0);
    const forwardX = -Math.sin(rRad);
    const forwardY =  Math.cos(rRad);
    const shift = off / scale;
    return { x: cx + forwardX * shift, y: cy + forwardY * shift };
}

/** Apply / refresh the lock. Reads token.document (which reflects the
 *  currently-interpolated animation value), so calling this from every
 *  refreshToken frame yields smooth stage motion. Skipped while the
 *  user is actively pan-out — see onCanvasPan. */
function apply() {
    if (!canvas?.ready || !canvas.stage) return;
    if (!isEnabled()) return release();
    const token = findLockTarget();
    if (!token) return release();
    if (_panOutActive) return;   // user is looking around; don't fight them

    const cx     = token.center?.x ?? token.x ?? 0;
    const cy     = token.center?.y ?? token.y ?? 0;
    const rotDeg = Number(token.document?.rotation) || 0;
    const rot    = stageRotationForRotationDeg(rotDeg);
    const pivot  = computePivotForOffset(cx, cy, rotDeg);

    /* Idle / straight-line skip. This runs EVERY FRAME from the ticker, so
     * short-circuiting when nothing changed is the single biggest movement
     * win: an idle POV writes no stage transform, issues no canvas.pan, and
     * runs no counter-rotation. Per-token overlay resets are handled
     * independently by onRefreshToken → fixupOneToken. */
    const rotSame = (_lastApplyRot !== null) && Math.abs(rot - _lastApplyRot) < 1e-4;
    const pivSame = (_lastApplyPivX !== null)
        && Math.abs(pivot.x - _lastApplyPivX) < 0.5
        && Math.abs(pivot.y - _lastApplyPivY) < 0.5;
    if (rotSame && pivSame) {
        /* Settled on a spot. During motion we moved the view with a bare pivot
         * write and only nudged the fog/lighting, so the heavy pipeline —
         * _constrainView, canvasPan hooks, hud.align, hover hit-test,
         * scene._viewPosition — is stale. Run ONE authoritative canvas.pan now
         * so the resting frame is fully reconciled. */
        if (_needsCatchupPan) {
            _needsCatchupPan = false;
            _selfPan = true;
            try { canvas.pan({ x: _lastApplyPivX, y: _lastApplyPivY }); }
            finally { _selfPan = false; }
        }
        return;
    }
    _lastApplyRot = rot; _lastApplyPivX = pivot.x; _lastApplyPivY = pivot.y;

    _selfPan = true;
    try {
        if (canvas.stage.rotation !== rot) canvas.stage.rotation = rot;
        /* THE FOLLOW: write the stage pivot DIRECTLY every frame. This is the
         * entire visual follow and it costs one Point write, so the camera rides
         * the token's animated position exactly — every frame, zero jitter.
         *
         * (The prior version alternated canvas.pan() with a raw pivot set to
         * throttle cost; but canvas.pan()'s _constrainView clamps the pivot near
         * a scene edge, so alternating frames landed on slightly different
         * positions and the token shimmered. A bare pivot write is consistent
         * frame-to-frame — no clamp, no shimmer.)
         *
         * canvas.pan() ALSO runs a heavy pipeline (hook fan-out, hud.align,
         * hover hit-test, mask + darkness/lighting invalidation) that made the
         * follow stutter when run every frame. We don't call it during motion at
         * all: the only visually-important part while gliding is keeping the roof
         * masks + fog/darkness from dragging behind the view, so we invalidate
         * just those at HALF rate (30fps — the re-lock's proven cadence). The
         * settle-frame canvas.pan above reconciles everything else once stopped. */
        canvas.stage.pivot.set(pivot.x, pivot.y);
        _needsCatchupPan = true;
        _panFrame ^= 1;
        if (_panFrame === 0) _nudgeViewportFx();
    } finally {
        _selfPan = false;
    }

    /* Full counter-rotation pass ONLY when the world actually turned. A pure
     * pan (token moving without rotating) leaves every token's counter-
     * rotation angle unchanged, so re-writing it for all N tokens each frame
     * was pure waste — the moved token's own reset is caught by refreshToken. */
    if (!rotSame) applyCounterRotation(rot);
    ensureGridUnmasked();
}

/* Cache of the last-applied stage transform so apply() can skip no-op frames.
 * Invalidated (set to null) on release / control change / re-lock so a genuine
 * state change always re-applies. */
let _lastApplyRot = null;
let _lastApplyPivX = null;
let _lastApplyPivY = null;
/* Follow-pan throttle state (see apply()). `_panFrame` alternates full pan vs.
 * cheap pivot-only; `_needsCatchupPan` flags that the last motion frame was
 * cheap, so the settle branch owes one authoritative pan. Reset on any cache
 * invalidation so a fresh lock / re-lock always begins with a full pan. */
let _panFrame = 1;            // first motion frame → ^=1 → 0 → full pan
let _needsCatchupPan = false;
function invalidateApplyCache() {
    _lastApplyRot = null; _lastApplyPivX = null; _lastApplyPivY = null;
    _panFrame = 1; _needsCatchupPan = false;
}

/* The visually-important subset of what canvas.pan() invalidates as the view
 * moves: the roof/occlusion masks and the darkness/lighting container (so fog
 * and dynamic lighting reposition with the viewport instead of dragging a frame
 * behind). These are the same two calls board.mjs#pan makes; invoking them
 * directly lets the follow reposition fog/lighting at half rate without paying
 * for pan()'s hook fan-out, hud.align and hover hit-test every frame. Both are
 * cheap dirty-flag invalidations — the actual re-render happens at PIXI render. */
function _nudgeViewportFx() {
    try { canvas.hidden?.invalidateMasks?.(); } catch (_) {}
    try { canvas.effects?.illumination?.invalidateDarknessLevelContainer?.(); } catch (_) {}
}

/** Grid visibility enforcement.
 *
 *  The real culprit for "grid only shows when facing up" is in
 *  foundry_copy .../shaders/grid/grid.mjs:535-537, where GridShader
 *  #_preRender computes:
 *
 *      let scale = resolution * mesh.worldTransform.a / data.width;
 *      ...
 *      uniforms.resolution = scale * size;
 *
 *  `worldTransform.a` is `sx * cos(θ)` — the [0][0] element of the
 *  scale-then-rotate matrix. Under our stage rotation:
 *
 *      θ = 0     → a = +W (grid renders normally — "facing up")
 *      θ = ±90°  → a = 0  (line thickness = 0, grid invisible)
 *      θ = 180°  → a = -W (negative resolution, artefacts / invisible)
 *
 *  Foundry's shader assumed the stage was never rotated. We monkey-
 *  patch _preRender to recompute the resolution factor using the
 *  rotation-invariant uniform scale sqrt(a² + b²) instead of raw `a`,
 *  which restores the correct line thickness at every rotation.
 *
 *  Also drops the world-rect mask on the grid layer / mesh (avoids
 *  masking artefacts at extreme pivots) and forces visible + alpha.
 *  All idempotent — restored in release(). */
function ensureGridUnmasked() {
    try {
        const grid = canvas?.interface?.grid;
        if (!grid) return;
        if (grid.mask) grid.mask = null;
        if (grid.visible === false) grid.visible = true;
        const mesh = grid.mesh;
        if (mesh) {
            if (mesh.visible === false) mesh.visible = true;
            if (mesh.mask) mesh.mask = null;
            patchGridShaderForRotation(mesh);
        }
    } catch (_) {}
}

/** Wrap the grid shader's #_preRender so it computes `resolution` from
 *  the rotation-invariant uniform scale, keeping the grid line
 *  thickness correct at every stage rotation. Idempotent per shader
 *  instance. */
function patchGridShaderForRotation(mesh) {
    const shader = mesh?.shader;
    if (!shader || shader.__wdmImmersivePreRenderPatched) return;
    const orig = shader._preRender;
    if (typeof orig !== "function") return;
    shader._preRender = function(m, renderer) {
        orig.call(this, m, renderer);
        /* Recompute uniforms.resolution using sqrt(a² + b²) instead of
         * bare `a`, so rotation angles that zero-out or invert `a`
         * (±90°, 180°) still produce the correct pixel-scale factor. */
        try {
            const wt = m.worldTransform;
            const uniformScale = Math.sqrt(wt.a * wt.a + wt.b * wt.b);
            const dataWidth = m.data?.width;
            if (!dataWidth) return;
            const rt = renderer?.renderTexture?.current;
            const resolution = (rt?.resolution) ?? renderer?.resolution ?? 1;
            let scale = resolution * uniformScale / dataWidth;
            const projection = renderer?.projection?.transform;
            if (projection) {
                const {a: pa, b: pb} = projection;
                scale *= Math.sqrt((pa * pa) + (pb * pb));
            }
            const size = m.data?.size ?? 1;
            this.uniforms.resolution = scale * size;
        } catch (_) {}
    };
    shader.__wdmImmersivePreRenderPatched = true;
}

/** Restore the vanilla camera. Also unwinds all counter-rotated meshes
 *  so lockRotation tokens land back at mesh.angle = 0, resets overlay
 *  rotations, and reattaches the grid mask. Idempotent. */
function release() {
    invalidateApplyCache();
    if (!canvas?.stage) return;
    const wasRotated = canvas.stage.rotation !== 0;
    if (wasRotated) canvas.stage.rotation = 0;
    const tokens = canvas?.tokens?.placeables ?? [];
    for (const t of tokens) {
        if (!t?.mesh) continue;
        if (t.document?.lockRotation) t.mesh.angle = 0;
        counterRotateTokenOverlays(t, 0);
    }
    /* Reattach the grid mask if we unhooked it. canvas.masks.canvas is
     * shared by primary/effects/grid; restoring the reference just
     * puts the culling back where Foundry expects it. */
    try {
        const grid = canvas?.interface?.grid;
        const mask = canvas?.masks?.canvas;
        if (grid && mask && !grid.mask) grid.mask = mask;
    } catch (_) {}
}

/** Animated return to the lock after a pan-out. Interpolates pivot x,
 *  pivot y, AND stage.rotation together via CanvasAnimation so both the
 *  pan and any facing change ease back smoothly in the same envelope.
 *  canvas.animatePan on its own only animates x/y/scale, so it would
 *  leave a rotation gap the user would see as a snap at the end. */
let _reLockTick = 0;
function animateReLock() {
    const token = findLockTarget();
    if (!token) { _panOutActive = false; return; }
    if (!isEnabled()) { _panOutActive = false; return; }
    const cx     = token.center?.x ?? token.x ?? 0;
    const cy     = token.center?.y ?? token.y ?? 0;
    const rotDeg = Number(token.document?.rotation) || 0;
    const targetRot = stageRotationForRotationDeg(rotDeg);
    const targetPivot = computePivotForOffset(cx, cy, rotDeg);

    /* Shortest-arc rotation target — avoid the world spinning the long
     * way around because the raw doc-rotation delta crossed the ±180°
     * seam. Adjust `to` to be within π of the current rotation. */
    let toRot = targetRot;
    const curRot = canvas.stage.rotation;
    while (toRot - curRot >  Math.PI) toRot -= 2 * Math.PI;
    while (toRot - curRot < -Math.PI) toRot += 2 * Math.PI;

    const CanvasAnim = foundry?.canvas?.animation?.CanvasAnimation ?? globalThis.CanvasAnimation;
    const attributes = [
        { parent: canvas.stage.pivot, attribute: "x",        to: targetPivot.x },
        { parent: canvas.stage.pivot, attribute: "y",        to: targetPivot.y },
        { parent: canvas.stage,       attribute: "rotation", to: toRot         }
    ];

    _selfPan = true;
    const opts = {
        name: "witcher-immersive-relock",
        duration: RE_LOCK_ANIMATION_MS,
        /* Re-apply counter-rotation each tick so lockRotation portraits
         * stay upright as the world rotates back — otherwise they'd
         * appear to spin during the ease. Also nudge perception each
         * tick: without this, wall LOS shadows and fog-of-war textures
         * stay pinned to their pre-animation position and visually
         * "drag" across the screen as the pivot moves, then snap when
         * the animation ends. Foundry's perception layer only redraws
         * on canvas.pan or explicit invalidation; since we mutate
         * stage.pivot / stage.rotation directly (fewer allocations and
         * no per-tick constraint clamp), we have to poke the invalida-
         * tion ourselves. */
        ontick: () => {
            applyCounterRotation(canvas.stage.rotation);
            /* Perception rebuild is expensive (wall LOS + vision polys + fog
             * texture). Only nudge it every OTHER tick during the ease — the
             * fog/LOS textures reposition often enough to avoid the visible
             * "drag", at half the perception cost of a per-tick rebuild. The
             * final apply() in done() does the authoritative snap. */
            _reLockTick = (_reLockTick + 1) & 1;
            if (_reLockTick === 0) {
                try {
                    canvas.perception?.update?.({
                        refreshLighting: true,
                        refreshVision:   true,
                        refreshOcclusion: true
                    });
                } catch (_) {}
            }
        }
    };
    const done = () => {
        _selfPan = false;
        _panOutActive = false;
        invalidateApplyCache();   // animation moved the stage; force apply() to re-sync
        /* One clean snap-to-truth at the end. Handles any easing
         * rounding + brings scene._viewPosition back in sync via a
         * proper canvas.pan call. */
        apply();
    };
    try {
        const p = CanvasAnim?.animate?.(attributes, opts);
        if (p?.finally) p.finally(done); else done();
    } catch (_) { done(); }
}

/* --- drag-select deselect guard ------------------------------------- */

/* Foundry's board MouseInteractionManager uses `permissions.dragLeftStart`
 * to gate the empty-canvas rubber-band select rectangle (board.mjs). With the
 * "select" tool that gate unconditionally allows drag-start; on drop the
 * rectangle RELEASES every controlled token it doesn't cover — so a stray
 * left-drag on empty canvas deselects the user's token and drops the immersive
 * camera lock. Blocking dragLeftStart while the camera is on + a token is
 * controlled kills that path. Legitimate deselection stays available:
 *   - clicking another owned token (its control() releases the previous one),
 *   - Escape (the keybind releaseAll).
 * The board mim gate is ONLY the canvas rubber-band; per-placeable drag (moving
 * a token) uses each token's own mim, so token dragging is unaffected. This
 * mirrors immersive-tactical-grid's wrap, but is gated on the camera being on
 * (not on being in combat / on your turn), so it also covers out-of-combat and
 * other players' turns. Tagged + idempotent so it wraps once per mim; a deferred
 * re-assert on deleteCombat recovers if the tactical-grid wrap (which restores a
 * pre-camera snapshot on detach) clobbered us. */
function installCameraDragBlock() {
    const mim = canvas?.mouseInteractionManager;
    if (!mim?.permissions) return;
    const cur = mim.permissions.dragLeftStart;
    if (cur && cur.__wdmCamDragBlock) return;   // our wrap already on top
    const orig = cur;
    const wrapped = function (...args) {
        try {
            /* This guard exists for ONE reason: on the token layer the "select"
             * tool's empty-canvas left-drag draws a rubber-band that, on drop,
             * RELEASES every controlled token it doesn't cover — deselecting the
             * immersive-locked token and dropping the camera. So block a left-
             * drag-start ONLY in that exact situation. Deliberately allowed
             * through (they never deselect the token, so blocking them was just
             * collateral damage from the original blanket block):
             *   - the measurement RULER — `game.activeTool === "ruler"`; Foundry
             *     starts the ruler from this same dragLeftStart gate (board.mjs
             *     #onDragLeftStart), so returning false here is exactly what was
             *     killing it; and
             *   - drags while a DIFFERENT interaction layer is active (e.g.
             *     drawing a Region) — `canvas.tokens.active` is false then, so
             *     it isn't the token rubber-band at all. The region-switch
             *     deselect is handled separately by the _deactivate guard.
             * This NARROWS the block to its true target; it does not remove the
             * protection against the rubber-band deselect. */
            if (isEnabled()
                && canvas?.tokens?.active
                && (canvas?.tokens?.controlled?.length ?? 0) > 0
                && game.activeTool !== "ruler") {
                return false;
            }
        } catch (_) { /* fall through to original */ }
        return orig?.apply(this, args) ?? true;
    };
    wrapped.__wdmCamDragBlock = true;
    mim.permissions.dragLeftStart = wrapped;
}

/* Re-assert after other consumers (tactical grid) may have restored a
 * pre-camera dragLeftStart on their own detach. Deferred so it runs after all
 * synchronous handlers of the triggering hook. */
function reassertCameraDragBlock() {
    try { queueMicrotask(installCameraDragBlock); } catch (_) { installCameraDragBlock(); }
}

/* --- region-draw token-release guard -------------------------------- */

/* Switching to the Region layer runs InteractionLayer.activate(), which sets
 * the region layer #active FIRST and THEN deactivates the token layer —
 * TokenLayer._deactivate() (inherited from PlaceablesLayer) calls releaseAll(),
 * dropping the controlled token and, with it, the immersive camera lock. So
 * "draw a region" kicks you out of immersive. We wrap TokenLayer._deactivate to
 * skip JUST the releaseAll — and ONLY when (a) immersive is on and (b) the layer
 * that just became active is the Region layer — so ordinary layer switches still
 * deselect as before. We stub `releaseAll` to a no-op for the single call rather
 * than reimplementing _deactivate's body, so it stays correct if Foundry changes
 * that method. Prototype-level + idempotent (tagged), so it wraps once. */
function installTokenReleaseGuard() {
    const TokenLayerClass = canvas?.tokens?.constructor;
    const proto = TokenLayerClass?.prototype;
    if (!proto) return;
    /* Only treat an OWN _deactivate as ours; an inherited one is Foundry's. */
    if (Object.prototype.hasOwnProperty.call(proto, "_deactivate")
        && proto._deactivate?.__wdmReleaseGuard) return;
    const orig = proto._deactivate;   // inherited from PlaceablesLayer
    if (typeof orig !== "function") return;
    const wrapped = function (...args) {
        /* Decide once, defensively — never let this test double-run _deactivate. */
        let keepControl = false;
        try { keepControl = isEnabled() && canvas?.regions?.active && (this.controlled?.length ?? 0) > 0; }
        catch (_) { keepControl = false; }
        if (!keepControl) return orig.apply(this, args);
        const hadOwn = Object.prototype.hasOwnProperty.call(this, "releaseAll");
        const prev   = this.releaseAll;
        this.releaseAll = function () { return this; };   // no-op for THIS call only
        try { return orig.apply(this, args); }
        finally { if (hadOwn) this.releaseAll = prev; else delete this.releaseAll; }
    };
    wrapped.__wdmReleaseGuard = true;
    proto._deactivate = wrapped;
}

/* --- Hook handlers --------------------------------------------------- */

function onCanvasReady() {
    apply();
    try { installCameraDragBlock(); } catch (_) { /* mim not ready */ }
    try { installTokenReleaseGuard(); } catch (_) { /* layer class not ready */ }
}

/** targetToken(user, token, targeted) fires whenever a user's target set
 *  changes. The freshly-targeted token's arrows are drawn by Foundry
 *  right after — a bare `refreshToken` also fires on the same object, so
 *  our `onRefreshToken` handler catches it — BUT for the case where a
 *  target is added/removed via the wheel-click keybind while the camera
 *  is mid-rotation-animation, the arrow container ends up with a stale
 *  transform if we rely solely on `refreshToken`. Belt-and-braces:
 *  reapply full counter-rotation on target-set changes as well. Cheap
 *  (a full pass over placeables is O(tokens_on_scene), inside the loop
 *  it's a few identity checks and a couple of scalar writes). */
function onTargetToken(_user, _token, _targeted) {
    if (!isEnabled()) return;
    if (!canvas?.ready) return;
    applyCounterRotation(canvas.stage?.rotation ?? 0);
}

function onControlToken() {
    /* Selecting a token resets pan-out — a right-drag that ended off-
     * canvas (mouseup didn't fire on our listener) could leave the flag
     * stuck true, and the first WASD move would then find apply()
     * early-returning. Also seed the movement-suppress window so any
     * canvas.pan Foundry fires during the ~500ms after selection
     * (auto-pan-if-off-screen, region transition, ruler follow) can't
     * be misread as an external pan-drag before the user's first
     * keystroke lands. */
    _panOutActive = false;
    _movementSuppressUntil = Date.now() + 500;
    invalidateApplyCache();   // new selection / lock target → force a re-apply
    apply();
}

function onRefreshToken(token) {
    if (!isEnabled()) return;
    const locked = findLockTarget();
    if (!locked) return;
    if (token === locked) {
        apply();
        /* apply() may skip its full counter-rotation on a pure pan (no world
         * turn), so correct the locked token's OWN overlays — Foundry just
         * reset them on this refresh — regardless of that skip. Cheap: one token. */
        fixupOneToken(token, canvas.stage.rotation);
        return;
    }
    /* Any other token just refreshed — Foundry has reset its mesh.angle
     * (for lockRotation tokens) and overlay children rotations back to
     * their defaults. Re-apply our counter-rotation for this one token
     * against the CURRENT stage rotation. */
    fixupOneToken(token, canvas.stage.rotation);
}

/** Render an inline "Immersive Token" toggle in the combat tracker
 *  header (GM only). This is a GM-LOCAL convenience for running battles:
 *  clicking flips the client-scope `immersiveGmUnlock` setting, which
 *  steps THIS GM in/out of the immersive clamps (free camera to survey
 *  the whole field) WITHOUT touching the world `immersiveTokenCamera`
 *  setting — players stay immersive per the global toggle. The label
 *  shows this GM's effective state via isEnabled(). The global on/off
 *  lives in Configure Settings. Uses the death-march amber palette so
 *  the button reads as native chrome. */
function renderImmersiveTrackerToggle(_app, html) {
    if (!game.user?.isGM) return;
    const root = (html instanceof HTMLElement) ? html : html?.[0] ?? null;
    if (!root) return;
    /* Idempotent — remove any previous toggle before injecting. */
    root.querySelectorAll(".wdm-immersive-toggle").forEach(n => n.remove());
    /* Prefer the tracker's own header row; fall back to the app root
     * so we never fail to inject on a Foundry markup shuffle. */
    const header = root.querySelector("header.combat-tracker-header, .combat-tracker-header, header") ?? root;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.classList.add("wdm-immersive-toggle");
    const paint = () => {
        const on = isEnabled();
        btn.textContent = `Immersive Token: ${on ? "On" : "Off"}`;
        btn.dataset.state = on ? "on" : "off";
    };
    btn.style.cssText = [
        "display:inline-flex",
        "align-items:center",
        "gap:0.35rem",
        "margin:0.25rem 0.5rem",
        "padding:0.25rem 0.6rem",
        "font-family:var(--wdm-font-display,\"Bebas Neue\",sans-serif)",
        "font-size:0.72rem",
        "letter-spacing:0.08em",
        "text-transform:uppercase",
        "color:var(--wdm-ink-hi,#cac4b0)",
        "background:linear-gradient(180deg,rgba(22,18,13,0.96),rgba(10,9,8,0.96))",
        "border:1px solid var(--wdm-amber-dim,#6e5224)",
        "border-radius:2px",
        "cursor:pointer"
    ].join(";");
    btn.title = "Temporarily unlock YOUR camera from the immersive clamps to run the battle. GM-only — players stay immersive.";
    btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        /* Toggle the GM-LOCAL unlock, not the world setting — only this GM
         * leaves the clamps; players are unaffected. Its onChange re-applies the
         * camera; paint() then reflects the new effective state. */
        const unlocked = game.settings.get(SYSTEM_ID, GM_UNLOCK_KEY) === true;
        try { await game.settings.set(SYSTEM_ID, GM_UNLOCK_KEY, !unlocked); }
        catch (_) {}
        /* onChange invalidates the enable cache too, but it does so on an async
         * dynamic-import microtask that may resolve AFTER this synchronous
         * paint(). Invalidate directly here so the button label reflects the new
         * state immediately regardless of that race. */
        invalidateEnabledCache();
        paint();
    });
    paint();
    header.prepend(btn);
}

/** Remove the Immersive Token Camera row from Configure Settings for
 *  non-GM users. The row's DOM anchor is
 *      form input[name="witcher-ttrpg-death-march.immersiveTokenCamera"]
 *  We walk up to the enclosing .form-group and drop the whole entry
 *  (label + control + hint) so the panel just doesn't show it at all. */
function hideImmersiveSettingForNonGM(app, html) {
    if (game.user?.isGM) return;
    const root = (html instanceof HTMLElement) ? html : html?.[0] ?? null;
    if (!root) return;
    const input = root.querySelector(`[name="${SYSTEM_ID}.${SETTING_KEY}"]`);
    if (!input) return;
    const row = input.closest(".form-group") ?? input.closest(".form-fields") ?? input.parentElement;
    row?.remove();
}

/** Combat turn change: when the newly-active combatant is a token this
 *  client OWNS (isOwner check, so GM sees NPC turns and players see
 *  their own), center the camera on that token. Uses the standard
 *  Foundry control() path so our controlToken hook re-runs and the
 *  lock re-anchors. */
function onCombatTurnChange(combat) {
    if (!isEnabled()) return;
    const combatant = combat?.combatant;
    const token = combatant?.token?.object ?? canvas?.tokens?.get?.(combatant?.tokenId);
    if (!token) return;
    /* Ownership gate — GM drives NPC turns, players get their own. Mirror
     * Foundry's Token#_canControl (GM || actor.isOwner) rather than keying
     * solely on `token.actor.isOwner`: an UNLINKED token whose base actor was
     * DELETED has no resolvable `token.actor` (or a synthetic one with no real
     * ownership), so `token.actor?.isOwner` was `undefined` and the camera
     * silently skipped that combatant's turn. Such actor-less tokens are
     * controllable only by the GM — exactly what this fallback allows. */
    const canControl = !!game.user?.isGM || !!token.actor?.isOwner;
    if (!canControl) return;
    /* Skip if already controlled — avoids a spurious re-control that
     * would flash the selection border. */
    if (token.controlled) {
        apply();
        return;
    }
    try { token.control({ releaseOthers: true }); } catch (_) {}
}

function onPreMoveToken(doc, movement) {
    if (!isEnabled()) return;
    const locked = findLockTarget();
    if (!locked || locked.document !== doc) return;
    /* Belt-and-suspenders block on any movement while a template
     * preview is aiming. `doImmersiveMove` already refuses WASD
     * strafe/rotate during aiming, but this catches every other
     * movement path Foundry has (ruler-drive, waypoint commit, macro
     * `.update({x,y})`, a third-party module that pushes updates
     * directly). Returning false from a `preMoveToken` hook cancels
     * the movement pipeline before the update commits. */
    if (isTemplatePreviewActive()) return false;
    /* Tactical-grid commit — let Foundry's own `core.tokenAutoRotate`
     * setting decide rotation behavior. Without this exception the
     * unconditional `autoRotate = false` below would strip the auto-
     * facing behavior even when the GM has "Automatic Token Rotation"
     * enabled. */
    if (isCommittingTacticalMove()) return;
    /* In combat, drop the auto-rotate override entirely so movement
     * (whether tactical grid commit, drag, ruler-drive, or WASD)
     * respects Foundry's own "Automatic Token Rotation" setting.
     * The immersive camera's WASD strafe semantics prefer LOCKED
     * facing (Shift+A/D owns rotation), which is why the override
     * exists at all — but that preference only makes sense out of
     * combat. In combat the token is expected to face the direction
     * it's walking. */
    if (game.combat?.started) return;
    movement.autoRotate = false;
}

/** Clamp every rotation change on the locked token to a multiple of
 *  45°. Firing at preUpdate means the doc.rotation that eventually
 *  animates always lands on a snap-boundary — which in turn means the
 *  camera view (which tracks doc.rotation directly) and the WASD
 *  movement basis (which snaps to 45° internally as a safety) are
 *  IDENTICAL every time the player tries to move. No between-snap
 *  angles, no per-keystroke drift residual (which was what caused the
 *  right-strafe camera-drop even after the 45° movement snap alone),
 *  and no stage-rotation spaz during rotation animations. */
function snapRotationInPreUpdate(doc, changes, options) {
    if (!isEnabled()) return;
    /* Facing-lock writes an EXACT angle to point at the locked token (option
     * `wdmFreeFacing`). Never snap those to 45° — the whole point is to face
     * the target precisely at any angle. Movement/manual rotations still snap. */
    if (options?.wdmFreeFacing) return;
    const locked = findLockTarget();
    if (!locked || locked.document !== doc) return;
    if (!("rotation" in changes)) return;
    const raw = Number(changes.rotation);
    if (!Number.isFinite(raw)) return;
    const snapped = ((Math.round(raw / 45) * 45) % 360 + 360) % 360;
    if (snapped !== raw) changes.rotation = snapped;
}

/** True while the death-march AoE template placement preview is live —
 *  a right-click during that time is a template CANCEL, not a pan-out
 *  request, so we mustn't enter pan-out mode or the camera will jerk
 *  around while the caster is aiming. Detected off the templates layer's
 *  preview container, populated by mechanics/castArea.mjs #_drawPreview
 *  when it calls canvas.templates.preview.addChild(this). */
function isTemplatePreviewActive() {
    return (canvas?.templates?.preview?.children?.length ?? 0) > 0;
}

/** Right-mouse-down inside the canvas turns on pan-out mode — user is
 *  starting a canvas-drag pan. Pan-out stays on for the duration of
 *  the drag. */
function onRightPointerDown(event) {
    if (event.button !== 2) return;
    if (!isEnabled()) return;
    if (!findLockTarget()) return;
    /* Only arm if the drag started on the CANVAS. Right-clicks in HUDs,
     * sidebars, chat get filtered by target check. */
    const target = event.target;
    const isCanvas = target === canvas?.app?.view || target?.tagName === "CANVAS";
    if (!isCanvas) return;
    /* Skip when a spell / AoE template preview is aiming — that right-
     * click is Foundry's template-cancel action (castArea.mjs handlers
     * .cancel listens on contextmenu). Entering pan-out here would
     * make the camera swing out from under the caster while they're
     * trying to abort the aim. */
    if (isTemplatePreviewActive()) return;
    _panOutActive = true;
    _prevScale = null;   // don't misread the resulting pan as a zoom
}

/** Right-mouse-up ends the drag — animate the camera back to the token. */
function onRightPointerUp(event) {
    if (event.button !== 2) return;
    if (!_panOutActive) return;
    _panOutActive = false;
    animateReLock();
}

function onCanvasPan(_c, pos) {
    if (_selfPan) return;
    if (!isEnabled()) return;
    const token = findLockTarget();
    if (!token) return;

    const scale = canvas?.stage?.scale?.x || 1;
    const cx = token.center?.x ?? token.x ?? 0;
    const cy = token.center?.y ?? token.y ?? 0;
    const rotDeg = Number(token.document?.rotation) || 0;
    const target = computePivotForOffset(cx, cy, rotDeg);

    /* Zoom detection. canvas._onMouseWheel calls pan({scale}) without
     *  x/y (board.mjs:2471), so on zoom the pivot Foundry sends is the
     *  OLD one — but our target now depends on the NEW scale (pivot
     *  offset from token = off/scale forward). Detect via `_prevScale`
     *  changing across the fire; silently re-pan to the new target,
     *  which anchors the zoom at the token's screen position (token
     *  stays put, world zooms around it) instead of drifting outward
     *  as scale grows. Do NOT enter pan-out for a zoom event. */
    const scaleChanged = (_prevScale != null) && Math.abs(_prevScale - scale) > 1e-6;
    _prevScale = scale;
    if (scaleChanged) {
        /* Pan + zoom at the same time. If the user is currently panned out
         * (right-drag held), a wheel-zoom must NOT snap the camera back to
         * the token — that's what prevented panning and zooming together.
         * Let the zoom stand around their free-look view; onRightPointerUp
         * → animateReLock() recomputes the pivot with the NEW scale, so the
         * return eases back correctly at whatever zoom they settled on. */
        if (_panOutActive) return;
        _selfPan = true;
        try { canvas.pan({ x: target.x, y: target.y }); } finally { _selfPan = false; }
        return;
    }

    /* Pan-out is entered ONLY by an explicit right-mouse-drag (see
     *  onRightPointerDown). Every other canvasPan fire — perception
     *  refresh, region transition, jump-to-token, animation follow —
     *  is a false positive that used to break the "first move after
     *  selection" case (camera doesn't catch up until seconds later)
     *  because canvasPan is fired liberally by Foundry during the
     *  moments right after a controlToken. If pan-out isn't active,
     *  any pivot deviation snaps straight back — instant, invisible. */
    if (!_panOutActive) {
        const dx = pos.x - target.x;
        const dy = pos.y - target.y;
        if ((dx * dx + dy * dy) < 0.25) return;
        _selfPan = true;
        try { canvas.pan({ x: target.x, y: target.y }); } finally { _selfPan = false; }
    }
    /* If pan-out IS active, let the user roam — no-op here. The
     *  release watcher (onRightPointerUp) triggers the animated return
     *  when they let go of the mouse button. */
}

/* --- WASD movement --------------------------------------------------- */

/** The token this mover should ORBIT around — the facing-lock target — or null
 *  when there's no lock (free strafe). Only returns a centre when `movingTok`
 *  is the locker itself, so an unrelated token's WASD never orbits. */
function orbitCenterToken(movingTok) {
    try {
        const id = getFacingLockId?.();
        if (!id) return null;
        const lockerId = getFacingLockerId?.();
        if (lockerId && movingTok?.id && lockerId !== movingTok.id) return null;
        return canvas?.tokens?.get?.(id) ?? null;
    } catch (_) { return null; }
}

function doImmersiveMove(screenDx, screenDy, isShift) {
    if (!isEnabled()) return false;
    const token = findLockTarget();
    if (!token) return false;

    /* Block movement while aiming a spell / AoE template preview.
     * You aim, THEN you move — not both at once. Also blocks the
     * Shift+A/D rotate since rotating the token while the template
     * preview is anchored to the caster would swing the preview off
     * the intended target. Consume the key (return true) so Foundry's
     * default pan doesn't kick in either. */
    if (isTemplatePreviewActive()) return true;

    /* Rotation lock while a tactical-grid commit's waypoint
     * animation is in flight. The token is walking a plotted route —
     * a rotate mid-animation would tear the visual and could confuse
     * the auto-face pipeline. WASD strafe is also blocked as a side
     * effect (both branches consume the key). */
    if (isCommittingTacticalMove()) return true;

    /* Any WASD input while a pan-out drag is somehow still active
     * cancels it and forces the camera back onto the token
     * immediately — the user is playing again. */
    if (_panOutActive) {
        _panOutActive = false;
        apply();
    }

    /* Shift branch: A/D rotate 90° left/right relative to current
     * facing; W/S do nothing (swallow to keep Foundry's default pan
     * from firing). */
    if (isShift) {
        if (screenDx === 0) return true;
        const now = Date.now();
        if (now - _lastMoveAt < MOVE_THROTTLE_MS) return true;
        _lastMoveAt = now;
        const cur = Number(token.document?.rotation) || 0;
        /* Snap to the NEXT 90° boundary in the direction of the press,
         * not "nearest 90° then add ±90". User semantic per bug report:
         * at 32° pressing D snaps to 90 (next boundary up), pressing A
         * snaps to 0 (next boundary down). At 88° D still goes to 90
         * — you can't "skip over" the nearest boundary just because
         * you started close to it. At an exact boundary (say 90°), the
         * press advances to the ADJACENT boundary (D → 180, A → 0).
         *
         *   Up   (D):  floor(cur/90) * 90 + 90
         *   Down (A):   ceil(cur/90) * 90 − 90
         *
         * The floor/ceil trick handles the on-boundary case cleanly:
         * cur=90, floor(1)*90+90 = 180 ✓; cur=32, ceil(0.36)*90−90 = 0
         * ✓. Wrap into [0, 360). */
        const next = screenDx > 0
            ? Math.floor(cur / 90) * 90 + 90
            : Math.ceil(cur / 90) * 90 - 90;
        const wrapped = ((next % 360) + 360) % 360;
        /* Smooth 400ms rotation animation — motion-sick friendly so
         * the world's swing around the character reads as a
         * deliberate camera move instead of a snap. The facing arrow
         * refresh runs per-frame from the token-style ticker (see
         * `tickOcclusionCascade` in policy/witcher-token-style.mjs)
         * so it tracks the mesh's interpolated angle rather than the
         * document target — that's the "arrow was too slow" fix.
         * `document.update`'s `animation.duration` option DOES route
         * through `token.animate` in v14 (see core token.mjs:4362-4368
         * — `options.animation` is destructured and forwarded to
         * `this.animate`). */
        try {
            token.document.update({ rotation: wrapped }, {
                animation: { duration: 400 }
            });
        } catch (_) {}
        return true;
    }

    /* Block the STRAFE branch during combat — but ONLY when the
     * controlled token is actually IN the combat. Tokens outside the
     * combat (NPCs off-scene, unlinked observers, out-of-encounter
     * allies) can still be strafed with WASD; movement in combat is
     * committed via the tactical-grid click-plot flow, not WASD
     * strafe. Rotation (Shift+A/D) still passes through above so the
     * player can face different directions before / after committing
     * a plotted move. Consume the key so Foundry's default pan
     * doesn't fire on the swallowed W/A/S/D press. */
    if (game.combat?.started && token.inCombat) return true;

    /* Move branch — CONTINUOUS strafe. Foundry's moveMany quantizes
     * dx/dy to {-1,0,+1} and multiplies by grid.size; at non-cardinal
     * facings the rounding rotates the true intent (e.g. facing 20°,
     * strafe D wants direction (-.94, -.34) but rounds to (-1, 0),
     * leaving a .34-grid forward drift on every keystroke). We compute
     * the exact world vector from the token's forward / right basis
     * and write x/y directly, so the strafe is exactly perpendicular
     * to the facing regardless of angle. autoRotate is stripped by
     * preMoveToken so the facing itself doesn't change.
     *
     *   forward_world = (-sin r,  cos r)
     *   right_world   = ( 90° CCW of forward in y-down screen frame)
     *                 = (-forward.y, forward.x) = (-cos r, -sin r)
     *   world_delta   = screenDx * right + (-screenDy) * forward
     * because screen y-down inverts the W-key intent. */
    const now = Date.now();
    if (now - _lastMoveAt < MOVE_THROTTLE_MS) return true;
    _lastMoveAt = now;

    const gridSize = canvas?.scene?.grid?.size ?? 100;
    let newX, newY;

    const orbitTarget = orbitCenterToken(token);
    if (orbitTarget) {
        /* LOCK-ON ORBIT. With a facing-lock target set, A/D travel the ARC of a
         * circle centred on that target (constant radius) and W/S step the
         * radius in / out. The motion is defined relative to the target, so it
         * can never spiral off the ring — which is what made "keep walking
         * right" curve around and eventually reverse: the old strafe hopped
         * along a straight tangent taken from the 45°-SNAPPED facing while the
         * camera orbited on the EXACT facing, and the two drifted apart. */
        const ctr = orbitTarget.center ?? { x: orbitTarget.x ?? 0, y: orbitTarget.y ?? 0 };
        const tc  = token.center ?? { x: Number(token.document.x) || 0, y: Number(token.document.y) || 0 };
        const vx  = (tc.x ?? 0) - (ctr.x ?? 0);
        const vy  = (tc.y ?? 0) - (ctr.y ?? 0);
        const R   = Math.hypot(vx, vy) || gridSize;
        const th  = Math.atan2(vy, vx);
        const fwd = -screenDy;   // W (+1) = toward target (radius −), S (−1) = away (radius +)

        // Radius step: one tile in/out, floored at one tile so you never land on the target.
        let nR = R;
        if (fwd !== 0) nR = Math.max(gridSize, R - fwd * gridSize);

        // Angle step: A/D advance ~one tile of ARC (chord = 1 tile) along the ring;
        // capped at 90° so orbiting a point-blank target doesn't whip around. Sign
        // chosen so D reads as screen-right / clockwise — flip the `- screenDx` to
        // swap the strafe hand if it feels reversed at the table.
        let nth = th;
        if (screenDx !== 0) {
            let dth = 2 * Math.asin(Math.min(1, gridSize / (2 * Math.max(nR, gridSize * 0.5))));
            dth = Math.min(dth, Math.PI / 2);
            nth = th - screenDx * dth;
        }

        const ncx = (ctr.x ?? 0) + nR * Math.cos(nth);
        const ncy = (ctr.y ?? 0) + nR * Math.sin(nth);
        // token.document.x/y is the footprint top-left; convert from centre + grid-snap.
        const halfW = (token.w ?? gridSize) / 2;
        const halfH = (token.h ?? gridSize) / 2;
        newX = Math.round((ncx - halfW) / gridSize) * gridSize;
        newY = Math.round((ncy - halfH) / gridSize) * gridSize;
    } else {
        /* FREE STRAFE (no lock target). Movement DIRECTION uses the token's
         * rotation SNAPPED to the nearest 45° — one of eight cardinal / diagonal
         * world axes. Every one of those eight directions lands cleanly on a grid
         * tile, so grid-snap rounding introduces zero forward-axis drift AND a
         * character facing a diagonal tile who presses W actually walks onto that
         * diagonal tile. The token's visual facing is unchanged — the snap only
         * picks which of the 8 grid axes W / A / S / D translates along. */
        const rot        = Number(token.document?.rotation) || 0;
        const rotForMove = ((Math.round(rot / 45) * 45) % 360 + 360) % 360;
        const rRad     = Math.toRadians(rotForMove);
        const forwardX = -Math.sin(rRad);
        const forwardY =  Math.cos(rRad);
        const rightX   = -forwardY;
        const rightY   =  forwardX;
        const fwd      = -screenDy;
        const worldFX  = screenDx * rightX + fwd * forwardX;
        const worldFY  = screenDx * rightY + fwd * forwardY;
        const rawX = (Number(token.document.x) || 0) + worldFX * gridSize;
        const rawY = (Number(token.document.y) || 0) + worldFY * gridSize;
        newX = Math.round(rawX / gridSize) * gridSize;
        newY = Math.round(rawY / gridSize) * gridSize;
    }
    /* If the snap collapsed the move to zero (facing so close to a
     * cardinal that the perpendicular round to 0), don't spend a
     * document update. */
    if (newX === Number(token.document.x) && newY === Number(token.document.y)) return true;
    /* Prefer TokenDocument#move (documents/token.mjs:701): it runs the
     * full waypoint pipeline — records movement history, updates the
     * drag-distance HUD (the "our ruler" restyled label from styles/
     * canvas-ruler.css), routes through preMoveToken so our autoRotate
     * strip fires, and returns a proper animation. Plain document.update
     * skipped all of that, which is why the ruler read the wrong
     * distance (the segment wasn't being appended to the history it
     * measures against). */
    /* Suppress pan-out detection during Foundry's move animation. See
     * _movementSuppressUntil header comment for the why — without this,
     * downstream Foundry code fires a canvas.pan (perception update,
     * region transition, movement follow) that our canvasPan hook mis-
     * reads as an external pan, the camera drops into pan-out mode,
     * and the token appears to shift out of its lock until the fallback
     * timer catches up "a few seconds later." */
    _movementSuppressUntil = Date.now() + MOVEMENT_SUPPRESS_MS;

    /* Cancel any in-flight movement animation before we queue the next
     * one. Foundry's #animate uses chain:true for movement (token.mjs:
     * 4237), which appends new segments to the queue rather than
     * replacing them; on rapid key-spam that queue accumulates and the
     * camera has to walk it end-to-end before catching up ("insanely
     * buggy right strafe" when the user machine-guns D). Cancelling
     * before each new move keeps the animation length bounded to a
     * single hop no matter how fast the player presses. */
    try {
        if (typeof token.stopAnimation === "function") {
            token.stopAnimation(token.movementAnimationName);
        }
    } catch (_) {}

    try {
        if (typeof token.document.move === "function") {
            /* Short animation duration for smooth per-hop motion.
             * 90ms is fast enough that spam-mashing doesn't stack up
             * a perceptible queue, but long enough to look like a
             * glide rather than a teleport. refreshToken fires per
             * animation frame so the camera is always in sync. */
            token.document.move({ x: newX, y: newY }, {
                animation: { duration: 90 }
            });
        } else {
            token.document.update({ x: newX, y: newY });
        }
    } catch (_) {}
    return true;
}

/** Called by the setting's onChange callback. Public so settings.mjs
 *  can toggle live without a reload. */
export function refreshImmersiveTokenCamera() {
    /* Drop the memoized enable flag FIRST — this is the single choke point both
     * settings' onChange call (the world `immersiveTokenCamera` AND the client
     * `immersiveGmUnlock` combat-tracker button). Client-scoped settings do NOT
     * fire the `updateSetting` hook, so this onChange path is the ONLY reliable
     * invalidation for the GM unlock toggle. Without it, apply()/isEnabled below
     * read the stale cached value and the button appears dead. */
    invalidateEnabledCache();
    _panOutActive = false;
    _prevScale = null;
    _movementSuppressUntil = 0;
    apply();
    refreshImmersiveHintTooltip();
}

/** Bottom-left hint tooltip listing the immersive-camera token
 *  keybindings — Esc (deselect) and Shift+A/D (rotate token). Small
 *  75%-opacity impact-style block that scales with the system's chrome
 *  UI knob (`--wdm-immersive-hint-scale` overrides
 *  `--wdm-chrome-bars-scale` as the default). Persistent — always in
 *  DOM but visibility gates on `body.wdm-immersive-on` (added below in
 *  `refreshImmersiveHintTooltip`) so switching the setting off hides
 *  it immediately with no re-render.
 *
 *  The tooltip lives directly under `<body>` at fixed positioning so
 *  neither the sidebar / scene-controls nor the dock's `zoom`
 *  transform affects it. Scale mimics the chrome pattern from
 *  styles/chrome.css so any UI-scale slider a GM adjusts flows in. */
const HINT_TOOLTIP_ID = "wdm-immersive-hint-tooltip";
function _isHintEnabled() {
    try { return game.settings.get(SYSTEM_ID, "immersiveTokenCameraShowHint") !== false; }
    catch (_) { return true; }
}
function refreshImmersiveHintTooltip() {
    const body = document.body;
    if (!body) return;
    const on = isEnabled();
    body.classList.toggle("wdm-immersive-on", on);
    /* Independent sub-toggle so a GM can turn the hint block off
     * without disabling the whole immersive camera. Body class picked
     * up by the CSS rule alongside `wdm-immersive-on` +
     * `wdm-token-selected`. Client-scope setting means each player
     * chooses for themselves. */
    body.classList.toggle("wdm-immersive-hint-on", _isHintEnabled());
    /* Idempotent DOM insert: build once, then only toggle visibility
     * on subsequent refreshes. Contents are localized on every rebuild
     * so a game.i18n locale change picks up. */
    let el = document.getElementById(HINT_TOOLTIP_ID);
    if (!el) {
        el = document.createElement("div");
        el.id = HINT_TOOLTIP_ID;
        /* Two rows, Esc first per user spec, Shift+A/D below it. Marked
         * `aria-hidden` because this is redundant with the keybinding
         * dialog under Configure Controls — visual reminder only, not
         * an accessibility-critical piece of info. */
        el.setAttribute("aria-hidden", "true");
        /* Wrap the row content in an inner scaling container. The outer
         * `#wdm-immersive-hint-tooltip` handles the anchoring (fixed
         * position, bottom-of-dock offset, horizontal centering) and
         * the inner `.wdm-immersive-hint-scale` handles the sizing via
         * CSS `zoom`. Splitting these two responsibilities is what fixes
         * "Overall Scaling doesn't affect the tooltip": zoom on a
         * fixed-position element in Chrome multiplies the `bottom`
         * coordinate itself, which is why previous `zoom`-on-outer
         * attempts pushed the tooltip into the dock. With zoom on
         * inner, the outer's anchor stays put and the inner's content
         * simply grows upward from the anchor (the outer wraps content,
         * so its top edge follows). */
        el.innerHTML = `
          <div class="wdm-immersive-hint-scale">
            <div class="wdm-immersive-hint-row">
              <kbd class="wdm-immersive-hint-key">Esc</kbd>
              <span class="wdm-immersive-hint-label" data-i18n="WITCHER.Policy.ImmersiveTokenCamera.Hint.DeselectToken">Deselect Token</span>
            </div>
            <div class="wdm-immersive-hint-row">
              <kbd class="wdm-immersive-hint-key">Shift+A/D</kbd>
              <span class="wdm-immersive-hint-label" data-i18n="WITCHER.Policy.ImmersiveTokenCamera.Hint.RotateToken">Rotate Token</span>
            </div>
            <div class="wdm-immersive-hint-row">
              <kbd class="wdm-immersive-hint-key">Right-Click</kbd>
              <span class="wdm-immersive-hint-label" data-i18n="WITCHER.Policy.ImmersiveTokenCamera.Hint.ToggleMovementOverlay">Toggle Movement Overlay</span>
            </div>
          </div>`;
        body.appendChild(el);
    }
    /* Localize each label — `data-i18n` marks them so a locale swap
     * refreshes cleanly by re-running the tooltip refresh. */
    for (const span of el.querySelectorAll("[data-i18n]")) {
        const key = span.getAttribute("data-i18n");
        try {
            const loc = game.i18n?.localize?.(key);
            if (loc && loc !== key) span.textContent = loc;
        } catch (_) { /* i18n not ready yet at very-early boot */ }
    }
}

/** Register the WASD keybindings. Must run during `init` — Foundry
 *  rejects `game.keybindings.register` after init closes. */
export function registerImmersiveKeybindings() {
    const prec = CONST?.KEYBINDING_PRECEDENCE?.PRIORITY ?? 0;

    const bindings = [
        { id: "immersiveMoveForward",  key: "KeyW", dx:  0, dy: -1, label: t("WITCHER.Policy.ImmersiveTokenCamera.Dialog.Button.MoveForward", "Move Forward")       },
        { id: "immersiveMoveBackward", key: "KeyS", dx:  0, dy:  1, label: t("WITCHER.Policy.ImmersiveTokenCamera.Dialog.Button.MoveBackward", "Move Backward")      },
        { id: "immersiveMoveLeft",     key: "KeyA", dx: -1, dy:  0, label: t("WITCHER.Policy.ImmersiveTokenCamera.Dialog.Button.StrafeLeftTurnLeft", "Strafe Left / Turn Left")  },
        { id: "immersiveMoveRight",    key: "KeyD", dx:  1, dy:  0, label: t("WITCHER.Policy.ImmersiveTokenCamera.Dialog.Button.StrafeRightTurnRight", "Strafe Right / Turn Right") }
    ];
    for (const b of bindings) {
        game.keybindings.register(SYSTEM_ID, b.id, {
            name: `Immersive Camera — ${b.label}`,
            hint: "Active only while the Immersive Token Camera setting is on. WASD strafes the selected token; Shift+A / Shift+D turn 90°; Shift+W / Shift+S do nothing.",
            editable: [{ key: b.key }],
            /* reservedModifiers: Shift can be held or not — same binding
             * fires. Without this, keyboard-manager.mjs:361 would reject
             * the match whenever Shift is down since Shift isn't in
             * requiredModifiers. */
            reservedModifiers: ["Shift"],
            onDown: ctx => doImmersiveMove(b.dx, b.dy, !!ctx?.isShift),
            repeat: true,
            precedence: prec
        });
    }

    /* Immersive INTERACT key — loot the faced carcass / loot pile, or open /
     * close the faced door, while the Immersive Token Camera is on. The handler
     * lives in canvas/mapLoot.mjs (a document keydown listener that also owns
     * the on-screen "[key] Loot / Open" prompt); it READS this binding so both
     * the key match and the prompt label follow whatever the user rebinds here.
     * Registered without an onDown — it's purely the user-configurable source of
     * truth for the key, so there's no double handling. Default F. */
    game.keybindings.register(SYSTEM_ID, "immersiveInteract", {
        name: t("WITCHER.Policy.ImmersiveTokenCamera.Interact.Name", "Immersive Camera — Interact (Loot / Open Door)"),
        hint: t("WITCHER.Policy.ImmersiveTokenCamera.Interact.Hint", "While the Immersive Token Camera is on, interact with the cell your token faces: loot an adjacent carcass or loot pile, or open / close a door. The on-screen prompt shows this key."),
        editable: [{ key: "KeyF" }]
    });

    /* Robust Escape → deselect keybinding.
     *
     * Symptom that motivated this: after some minutes of use with
     * immersive on (right-drag pan-outs, layer switches, template
     * placements etc.), Foundry's own Escape flow (client-keybindings.
     * mjs #onDismiss) sometimes gets stuck at Case 1 (canvas.current
     * MouseManager.cancel()) because a right-drag or template listener
     * left `canvas.currentMouseManager` un-torn-down. The dismiss
     * handler returns true out of that case and never reaches Case 5,
     * so pressing Escape stops deselecting the token — the GM ends up
     * "stuck" on the currently-selected token with no exit.
     *
     * A PRIORITY-precedence keybinding on Escape lets us run BEFORE
     * Foundry's core.dismiss action. When immersive is on, we tear
     * down any stuck mouse-manager state, clear our own pan-out flags,
     * then delegate to canvas.tokens.releaseAll() ourselves. Returning
     * true consumes the event so Foundry's cascading dismiss chain
     * doesn't re-run on top of us. When immersive is off, we return
     * false and Foundry's default flow handles the Escape unchanged. */
    game.keybindings.register(SYSTEM_ID, "immersiveEscape", {
        name: t("WITCHER.Policy.ImmersiveTokenCamera.Text.ImmersiveCameraEscapeDeselect", "Immersive Camera — Escape / Deselect"),
        hint: "Robust deselect while Immersive Token Camera is on. Also clears any stuck right-drag pan state so the GM can always step off the currently-locked token.",
        editable: [{ key: "Escape" }],
        onDown: () => {
            if (!isEnabled()) return false;
            /* Template preview owns Escape: castArea.mjs's handlers.key
             * cancels the aim on Escape (a document-level keydown
             * listener). If we short-circuit here by releasing the
             * caster token, we'd tear down the preview via controlToken
             * side-effects out from under that handler and leave the
             * caster in a half-cancelled state. Return false so
             * Foundry's default dismiss flow, and the template's own
             * key listener, get to run naturally. */
            if (isTemplatePreviewActive()) return false;
            /* Clean up our own state first. */
            _panOutActive = false;
            /* If Foundry has a stuck mouse manager (right-drag that
             * didn't fully tear down), cancel it so Foundry doesn't
             * spend this Escape on that instead of the release. */
            const mm = canvas?.currentMouseManager;
            if (mm?.cancel) {
                try { mm.cancel(); } catch (_) {}
            }
            /* If any placement / movement-planning context is live on
             * the tokens layer, cancel those the way Foundry's default
             * would — the GM still gets those Escape behaviours. */
            const layer = canvas?.tokens;
            if (layer?._placementContext) {
                try { layer._cancelPlacement(); return true; } catch (_) {}
            }
            if (layer?._movementPlanningContext) {
                try { layer._cancelMovementPlanning(); return true; } catch (_) {}
            }
            /* Nothing else pending — release controlled tokens. Only
             * do the actual release for a GM (Foundry's own dismiss
             * flow is also GM-gated at PlaceablesLayer._onDismissKey
             * line 1308). Consume the event so the main menu doesn't
             * pop open on top of the release. */
            if (game.user?.isGM && layer?.controlled?.length) {
                try { layer.releaseAll(); } catch (_) {}
                return true;
            }
            return false;
        },
        precedence: prec
    });
}

/** Per-frame camera enforcement, run from PIXI's ticker. Two reasons:
 *   1. `refreshToken` doesn't fire for STAGE-only changes — if the user
 *      is stopped, the stage rotation from the last apply is stable,
 *      but the status-effect ring COUNTER-rotation on every token's
 *      overlay containers can be silently overwritten by Foundry's
 *      redraw pipeline (drawEffectsWitcher wipes and re-adds children,
 *      _refresh flags reprocess). A ticker guarantees the counter-
 *      rotation is re-applied every frame so status icons never drift
 *      out of their screen-fixed dock.
 *   2. On the FIRST move after selection, there's a brief window
 *      (server round-trip on remote, animation kickoff on local) where
 *      Foundry can push a pan the refreshToken hook hasn't caught yet,
 *      leaving the camera one square behind the token. Ticker-driven
 *      apply pans on every frame, so the camera can never fall out of
 *      sync — it's re-locked before each render. */
function onImmersiveTicker() {
    if (!canvas?.ready) return;
    /* Third-party "immersive token vision" modules can rotate the
     * canvas.stage without going through our own toggle — a
     * different toggle they own drives the rotation. Foundry
     * decorations (`token.bars` / `token.nameplate` / `token.tooltip`
     * / `token.effects`) will then rotate with the stage and dislodge
     * from their glued positions on the token. Applying our
     * counter-rotation ANY TIME the stage is non-zero (regardless of
     * whether our own immersive toggle is on) keeps bars / nameplate
     * screen-upright and locked to the token, matching what the
     * third-party module presumably intends but never wires up
     * itself. Cheap: a single stage.rotation read + a walk over
     * canvas.tokens.placeables. */
    const stageRot = Number(canvas.stage?.rotation) || 0;
    const ourEnabled = isEnabled();
    if (!ourEnabled) {
        if (stageRot !== 0) {
            try { applyCounterRotation(stageRot); } catch (_) {}
        }
        return;
    }
    if (_panOutActive) {
        /* During pan-out, apply() would early-return and skip the
         * counter-rotation pass — the status dock would then rotate
         * with the world as the user drags the view around. Run
         * counter-rotation against the CURRENT (user-set) stage
         * rotation directly so overlays stay screen-fixed even while
         * the camera is unlocked. */
        if (findLockTarget()) {
            try { applyCounterRotation(stageRot); } catch (_) {}
        }
        return;
    }
    apply();   // already runs applyCounterRotation internally

    /* Screen-fixed floating labels — Foundry's scrolling status/damage text and
     * our weapon-target label — live on `canvas.interface`, NOT inside a token's
     * counter-rotation wrapper, so nothing keeps them upright on their own. They
     * used to be corrected only inside applyCounterRotation, which apply() runs
     * ONLY when the stage rotation changes. That meant a status text popping
     * while the camera sits at a fixed non-north facing (e.g. strafing east) was
     * never counter-rotated and rendered sideways. Re-apply their counter-
     * rotation EVERY frame here, outside apply()'s idle-skip. Cheap: both
     * helpers early-return when there is no active label to rotate. */
    const negRot = -stageRot;
    try { counterRotateScrollingText(negRot); } catch (_) {}
    try { counterRotateWeaponTargetLabel(negRot); } catch (_) {}
}

let _installed = false;
let _tickerAttached = false;
export function registerImmersiveTokenCamera() {
    if (_installed) return;
    _installed = true;

    Hooks.on("canvasReady",     onCanvasReady);
    /* The tactical grid wraps the same board `dragLeftStart` gate during combat
     * and restores a pre-camera snapshot when combat ends — which can drop our
     * deselect guard. Re-assert (deferred) after combat teardown so the guard
     * survives. Harmless no-op when our wrap is already on top. */
    Hooks.on("deleteCombat",    reassertCameraDragBlock);
    Hooks.on("controlToken",    onControlToken);
    Hooks.on("refreshToken",    onRefreshToken);
    /* Foundry v14 fires `targetToken(user, token, targeted)` whenever a
     * user's target set changes AND `refreshToken` on the same token —
     * BUT the target-arrows draw path runs AFTER our refreshToken
     * handler in the Foundry pipeline for the newly-targeted token, so
     * our pre-draw counter-rotation pivot gets clobbered by the fresh
     * .clear() + redraw. Reapply after the target-set event settles,
     * so the second (post-draw) pivot write wins. */
    Hooks.on("targetToken",     onTargetToken);
    Hooks.on("canvasPan",       onCanvasPan);
    Hooks.on("preMoveToken",    onPreMoveToken);
    Hooks.on("preUpdateToken",  snapRotationInPreUpdate);
    /* Combat turn change: if the newly-active combatant is a token this
     * client owns, center the camera on them. Uses the standard control
     * flow so all our lock / counter-rotation logic re-applies. */
    Hooks.on("combatTurnChange", onCombatTurnChange);
    /* GM-only "Immersive Token" toggle injected at the top of the
     * combat tracker each time it renders. See renderImmersiveTrackerToggle. */
    Hooks.on("renderCombatTracker", renderImmersiveTrackerToggle);
    /* Hide the Configure Settings entry for non-GM users. The setting
     * is scope:"world" so Foundry already forbids non-GM writes, but
     * the row would still be visible (read-only) in the config panel;
     * scrub it out so only the GM sees the entry at all. */
    Hooks.on("renderSettingsConfig", hideImmersiveSettingForNonGM);

    /* Explicit right-mouse-drag pan-out arm/disarm — see the two
     * handlers' docstrings. Attaching with capture so we run before
     * Foundry's own drag machinery. */
    document.addEventListener("pointerdown", onRightPointerDown, true);
    document.addEventListener("pointerup",   onRightPointerUp,   true);

    /* Ticker enforcement — see onImmersiveTicker docstring. Registered
     * once via the first canvasReady; the handler itself checks
     * isEnabled() so we don't pay any cost when the user hasn't opted
     * in. canvas.app is the singleton PIXI Application so we don't
     * need to re-attach across scene changes. */
    Hooks.once("canvasReady", () => {
        if (_tickerAttached) return;
        try {
            canvas.app?.ticker?.add(onImmersiveTicker);
            _tickerAttached = true;
        } catch (_) {}
    });

    /* Tactical grid sub-feature — XCOM-style in-combat reachability
     * overlay + waypoint movement. Registered here so it inherits the
     * same one-shot install semantics as the rest of immersive-token-
     * camera and lives / dies with the base immersive toggle. See
     * policy/immersive-tactical-grid.mjs for the full feature; that
     * file owns all its own hooks + PIXI layer and never mutates
     * combatRoundMixin / canvas-movement state. */
    registerImmersiveTacticalGrid();

    /* Bottom-left hint tooltip — spawn on ready so it's in the DOM the
     * moment the game world finishes booting, then let
     * `refreshImmersiveTokenCamera` (fired by the setting's onChange)
     * flip visibility on subsequent toggles. */
    Hooks.once("ready", refreshImmersiveHintTooltip);

    /* Token-selection gate for the hint tooltip. The two keybindings it
     * documents (Esc = deselect, Shift+A/D = rotate) only mean anything
     * when a token is under control, so the tooltip only shows in that
     * state. Toggled via a body class picked up by the CSS rule; JS
     * updates the class from the `controlToken` hook (fires on both
     * select and release). */
    Hooks.on("controlToken", () => {
        const anyControlled = (canvas?.tokens?.controlled?.length ?? 0) > 0;
        document.body?.classList.toggle("wdm-token-selected", anyControlled);
    });

    /* Block click-drag on the locked token. Other tokens still drag. */
    const TokenCls = foundry?.canvas?.placeables?.Token ?? CONFIG.Token?.objectClass;
    const tokenProto = TokenCls?.prototype;
    if (tokenProto && !tokenProto.__immersiveCanDragPatched) {
        const orig = tokenProto._canDrag;
        tokenProto._canDrag = function(user, event) {
            if (isEnabled() && this === findLockTarget()) return false;
            return orig?.call(this, user, event) ?? false;
        };
        tokenProto.__immersiveCanDragPatched = true;
    }

    /* HUD alignment patch. See file header § 11 for the diagnosis. We
     * wrap the align method rather than rewriting it so any future
     * Foundry change to the base positioning still runs; we only
     * append the rotation and stamp a CSS variable the label styles
     * read for counter-rotation. */
    const HUDCls = foundry?.applications?.hud?.HeadsUpDisplayContainer;
    const hudProto = HUDCls?.prototype;
    if (hudProto && !hudProto.__immersiveAlignPatched) {
        const origAlign = hudProto.align;
        hudProto.align = function() {
            origAlign?.call(this);
            if (!isEnabled() || !findLockTarget()) {
                /* Restore vanilla state when immersive is off. Left
                 * over rotation from a prior lock would drift with
                 * every pan. */
                if (this.element) {
                    this.element.style.removeProperty("--wdm-immersive-neg-rot");
                    /* The base align just set transform: scale(s).
                     * Leave it alone. */
                }
                return;
            }
            if (!this.element) return;
            const theta = canvas?.stage?.rotation || 0;
            const scale = canvas?.stage?.scale?.x || 1;
            /* CSS's rotate() runs AFTER scale in this write order (left
             * → right composition), which is what we want: scale the
             * world-coord positions first, then rotate around the HUD's
             * origin. That composition puts a world point (x, y)
             * exactly where the same world point lands on the rotated
             * PIXI stage. */
            this.element.style.transform = `scale(${scale}) rotate(${theta}rad)`;
            this.element.style.setProperty("--wdm-immersive-neg-rot", `${-theta}rad`);
        };
        hudProto.__immersiveAlignPatched = true;
    }

    /* Selection box hidden while immersive is on. ControlsLayer's
     * drawSelect (foundry_copy .../layers/controls.mjs:218) draws a
     * screen-axis-aligned rect in WORLD coords, so on our rotated
     * stage it renders crooked. Making it render axis-aligned in
     * screen would require re-projecting the four corners each frame;
     * hiding is simpler and drag-select still WORKS — Foundry uses
     * the same world rect to test which tokens fall inside, so the
     * selection commits normally on mouseup even though the box is
     * invisible during the drag. */
    const ControlsCls = foundry?.canvas?.layers?.ControlsLayer;
    const controlsProto = ControlsCls?.prototype;
    if (controlsProto && !controlsProto.__immersiveDrawSelectPatched) {
        const origDrawSelect = controlsProto.drawSelect;
        controlsProto.drawSelect = function(coords) {
            if (isEnabled() && findLockTarget()) {
                try { this.select?.clear?.(); } catch (_) {}
                return;
            }
            return origDrawSelect?.call(this, coords);
        };
        controlsProto.__immersiveDrawSelectPatched = true;
    }

    /* NOTE: Escape now delegates to Foundry's default TokenLayer#_on
     * DismissKey behavior (release-controlled for GMs). Previous
     * versions of this module swallowed Escape to keep the immersive
     * lock from breaking, but that left the GM stuck on the currently-
     * selected token with no way to step out — they'd have to click
     * a different token every time. Ceding Escape lets the GM
     * deselect at will; the immersive apply() then sees zero locked
     * targets and releases the camera (returning it to a vanilla free
     * view), and the next selection re-engages the lock. */
}
