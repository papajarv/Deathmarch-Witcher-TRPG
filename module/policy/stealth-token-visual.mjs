/**
 * Stealth token visual — dashed ring + subtle dimming overlay for any
 * token whose actor has `flags[SYSTEM_ID].stealth.active === true`.
 *
 * Piggybacks on the token-style occlusion carrier so:
 *   - the overlay follows the token position + elevation naturally
 *   - it's z-order occluded by higher-elevation surfaces (roof tiles)
 *     the same way the token mesh is
 *   - it stays screen-upright when the immersive camera rotates the
 *     world (parented into the counter-rotation wrapper)
 *
 * Draws:
 *   - A translucent gray fill over the token's bounding disk (~20%
 *     alpha) so stealthed tokens visibly desaturate on the map.
 *   - A dashed silver ring at the token perimeter — the "sneaking
 *     circle" visual indicator.
 *
 * Wired to:
 *   - `drawToken`             → build if actor is stealthed
 *   - `refreshToken`          → resize dashed ring when token size
 *                                / footprint changes
 *   - `updateActor` (stealth flag) → build / tear down on toggle
 *   - `destroyToken`          → tear down cleanly
 *
 * Non-goals for this file:
 *   - Hiding the overlay from non-spotter players (Phase 6 tracker
 *     filter + a per-user visibility gate on the whole token — this
 *     file draws the overlay on ALL clients that can already see the
 *     token; the visibility gate is applied elsewhere).
 *   - Spotter-vision red overlay (that's a separate module, applied
 *     for the stealther's OWN view of the map).
 */

import { isStealthed } from "../mechanics/stealth.mjs";
import { getOrCreateCounterRotWrapper, getOrCreateOcclusionCarrier } from "./witcher-token-style.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const VISUAL_MARK = "_wdmStealthVisual";

/* Visual tuning. Kept modest so the overlay reads as "hidden" without
 * making the token unreadable. */
const RING_COLOR      = 0xc0c0c0;   // silver
const RING_ALPHA      = 0.85;
const RING_WIDTH      = 2.5;
const DASH_LENGTH     = 8;
const DASH_GAP        = 6;
const FILL_COLOR      = 0x101018;   // near-black cool tint
const FILL_ALPHA      = 0.44;

/* Locate the overlay container across the possible parent chains
 * (counter-rot wrapper preferred, carrier fallback). Same lookup
 * shape as health-state-visuals so wrapper-migration doesn't leak
 * orphan containers. */
function findOverlayContainer(token) {
    if (!token) return null;
    const wrapper = token._wdmCounterRotWrapper;
    const inWrapper = wrapper?.children?.find?.(ch => ch?.[VISUAL_MARK]);
    if (inWrapper) return inWrapper;
    const carrier = token._wdmOcclusionCarrier;
    const inCarrier = carrier?.children?.find?.(ch => ch?.[VISUAL_MARK]);
    if (inCarrier) return inCarrier;
    return token.children?.find?.(ch => ch?.[VISUAL_MARK]) ?? null;
}

function getOrCreateOverlayContainer(token) {
    let c = findOverlayContainer(token);
    if (c && !c.destroyed) return c;
    c = new PIXI.Container();
    c[VISUAL_MARK] = true;
    c.eventMode = "none";
    c.zIndex = 99;  /* below health visuals (100) so wound glow paints on top */
    c.sortableChildren = true;
    const wrapper = getOrCreateCounterRotWrapper(token);
    if (wrapper && !wrapper.destroyed) { wrapper.addChild(c); return c; }
    const carrier = getOrCreateOcclusionCarrier(token);
    if (carrier && !carrier.destroyed) { carrier.addChild(c); return c; }
    token.addChild?.(c);
    return c;
}

function clearOverlay(token) {
    const c = findOverlayContainer(token);
    if (!c || c.destroyed) return;
    try { c.destroy({ children: true }); }
    catch (_) { /* already gone */ }
}

/** Draw a dashed circle at (cx, cy) of `radius` into `g`. Dash geometry
 *  is fixed pixel-space (not scaled by radius) so all token sizes end
 *  up with the same dash spacing on screen. */
function drawDashedCircle(g, cx, cy, radius) {
    const circumference = 2 * Math.PI * radius;
    const dashCount = Math.max(4, Math.floor(circumference / (DASH_LENGTH + DASH_GAP)));
    const step = (Math.PI * 2) / dashCount;
    const halfDashAngle = (DASH_LENGTH / radius) / 2;
    g.lineStyle(RING_WIDTH, RING_COLOR, RING_ALPHA);
    for (let i = 0; i < dashCount; i++) {
        const centerAngle = i * step;
        const a0 = centerAngle - halfDashAngle;
        const a1 = centerAngle + halfDashAngle;
        g.moveTo(cx + Math.cos(a0) * radius, cy + Math.sin(a0) * radius);
        g.arc(cx, cy, radius, a0, a1);
    }
    g.lineStyle(0);
}

/** Paint the stealth overlay for the current token size. Idempotent —
 *  clears + redraws every call so a token resize on refreshToken
 *  reflows the ring / fill without leaking children. */
function drawOverlay(token) {
    const container = getOrCreateOverlayContainer(token);
    if (!container || container.destroyed) return;
    /* Wipe prior children — a resize would leave the old ring painted
     * behind if we didn't. */
    container.removeChildren().forEach(ch => { try { ch.destroy(); } catch (_) {} });

    const tw = Number(token.w) || 0;
    const th = Number(token.h) || 0;
    if (tw <= 0 || th <= 0) return;
    const cx = tw / 2;
    const cy = th / 2;
    /* Ring radius — inset ONE pixel from the token bounding box so
     * it doesn't get clipped by the mesh edge on non-round tokens. */
    const radius = Math.max(6, Math.min(tw, th) / 2 - 1);

    /* Fill disk — subtle darkening to signal "in shadow". */
    const fill = new PIXI.Graphics();
    fill.beginFill(FILL_COLOR, FILL_ALPHA);
    fill.drawCircle(cx, cy, radius);
    fill.endFill();
    fill.eventMode = "none";
    container.addChild(fill);

    /* Dashed silver ring — the "sneaking" indicator. */
    const ring = new PIXI.Graphics();
    drawDashedCircle(ring, cx, cy, radius);
    ring.eventMode = "none";
    container.addChild(ring);
}

/** Sync the overlay against the actor's current stealth state. Adds
 *  the visual when stealthed, removes it otherwise. Safe to call on
 *  every draw/refresh — no-op when state matches DOM. */
function refreshStealthVisual(token) {
    if (!token || token.destroyed) return;
    const actor = token.actor;
    /* Signature gate — this fires on every refreshToken. The overlay is a pure
     * function of (stealthed?, footprint); `drawOverlay` rebuilds two Graphics
     * and re-runs the dashed-circle trig each call, so gate it to only redraw
     * when the state or size actually changes (toggle stealth, resize token). */
    const on = !!actor && isStealthed(actor);
    const sig = on
        ? `on:${Math.round(Number(token.w) || 0)}:${Math.round(Number(token.h) || 0)}`
        : "off";
    if (token._wdmStealthVisSig === sig) return;
    token._wdmStealthVisSig = sig;
    if (on) drawOverlay(token);
    else    clearOverlay(token);
}

export function registerStealthTokenVisual() {
    Hooks.on("drawToken", (token) => {
        try { refreshStealthVisual(token); }
        catch (err) { console.warn(`${SYSTEM_ID} | stealth visual draw failed`, err); }
    });
    Hooks.on("refreshToken", (token) => {
        try { refreshStealthVisual(token); }
        catch (err) { console.warn(`${SYSTEM_ID} | stealth visual refresh failed`, err); }
    });
    Hooks.on("destroyToken", (token) => {
        try { clearOverlay(token); }
        catch (_) { /* already gone */ }
    });
    /* Toggle-triggered refresh — the flag update fires updateActor
     * on all clients. Walk the actor's active tokens on the current
     * scene and refresh their visuals. Only fires when the stealth
     * flag itself changed to keep incidental HP / status updates
     * from re-painting the overlay. */
    Hooks.on("updateActor", (actor, changes) => {
        const flagsChanged = changes?.flags?.[SYSTEM_ID]?.stealth !== undefined
                          || changes?.flags?.["==" + SYSTEM_ID]?.stealth !== undefined;
        if (!flagsChanged) return;
        const tokens = actor?.getActiveTokens?.() ?? [];
        for (const t of tokens) {
            try { refreshStealthVisual(t); }
            catch (err) { console.warn(`${SYSTEM_ID} | stealth visual actor-update refresh failed`, err); }
        }
    });
}
