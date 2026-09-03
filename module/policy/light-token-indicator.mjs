/**
 * Light-level token indicator — a small "fullness" badge on the CONTROLLED token
 * showing the light tier it stands in (mechanics/light-level.mjs). Symbol-based,
 * not colour-coded: a circle whose fill shows how much light there is —
 *   full disk        → Bright / Daylight
 *   3/4 filled       → Dim −1
 *   2/4 (half)       → Dim −2
 *   1/4 filled       → Dim −3
 *   empty ring       → Darkness
 *   empty ring + ✕   → Pitch Black
 *
 * Only the token you control carries the badge (one badge, your own light).
 *
 * Modelled on stealth-token-visual.mjs: parented into the token's counter-
 * rotation wrapper (screen-upright, occludes like the mesh), rebuilt on
 * drawToken/refreshToken/controlToken, and refreshed on lighting/weather change.
 * A per-token (tier + size) signature gates redraws so a stable tier costs
 * nothing — no per-frame repaint during pans, animation, or env fades.
 */

import { lightLevelAt, LIGHT_TIER_FULLNESS } from "../mechanics/light-level.mjs";
import { getOrCreateCounterRotWrapper, getOrCreateOcclusionCarrier } from "./witcher-token-style.mjs";
import { isStealthed } from "../mechanics/stealth.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const BADGE_MARK = "_wdmLightBadge";

const BASE_DARK  = 0x14120C;   // unlit portion of the disk
const LIGHT_FILL = 0xF3E8C8;   // warm light (the "how much light" fill)
const RING_COLOR = 0xC9A24A;   // amber frame
const CROSS_COLOR = 0xD86A5A;  // pitch-black ✕

function findBadge(token) {
    if (!token) return null;
    const wrapper = token._wdmCounterRotWrapper;
    const inWrapper = wrapper?.children?.find?.(ch => ch?.[BADGE_MARK]);
    if (inWrapper) return inWrapper;
    const carrier = token._wdmOcclusionCarrier;
    const inCarrier = carrier?.children?.find?.(ch => ch?.[BADGE_MARK]);
    if (inCarrier) return inCarrier;
    return token.children?.find?.(ch => ch?.[BADGE_MARK]) ?? null;
}

function getOrCreateBadge(token) {
    let c = findBadge(token);
    if (c && !c.destroyed) return c;
    c = new PIXI.Container();
    c[BADGE_MARK] = true;
    c.eventMode = "none";
    c.zIndex = 101;   /* above the stealth overlay (99) + health visuals (100) */
    const wrapper = getOrCreateCounterRotWrapper(token);
    if (wrapper && !wrapper.destroyed) { wrapper.addChild(c); return c; }
    const carrier = getOrCreateOcclusionCarrier(token);
    if (carrier && !carrier.destroyed) { carrier.addChild(c); return c; }
    token.addChild?.(c);
    return c;
}

function clearBadge(token) {
    const c = findBadge(token);
    if (!c || c.destroyed) return;
    try { c.destroy({ children: true }); } catch (_) { /* already gone */ }
}

/* Draw the fullness symbol for a tier at the token's top-right corner. */
function drawBadge(token, tier) {
    const fullness = LIGHT_TIER_FULLNESS[tier];
    if (fullness == null) { clearBadge(token); return; }
    const container = getOrCreateBadge(token);
    if (!container || container.destroyed) return;
    container.removeChildren().forEach(ch => { try { ch.destroy(); } catch (_) {} });

    const tw = Number(token.w) || 0;
    const th = Number(token.h) || 0;
    if (tw <= 0 || th <= 0) return;
    const r = Math.max(6, Math.min(12, Math.min(tw, th) * 0.16));
    const cx = tw - r - 2;
    const cy = r + 2;

    const g = new PIXI.Graphics();
    g.eventMode = "none";
    // Soft drop shadow so the badge reads on any art.
    g.beginFill(0x000000, 0.35); g.drawCircle(cx + 0.5, cy + 1, r + 1.5); g.endFill();
    // Dark base disk = the "unlit" background the fill is measured against.
    g.beginFill(BASE_DARK, 0.92); g.drawCircle(cx, cy, r); g.endFill();

    // Light fill shaped like a MOON PHASE — the terminator sweeps across the disk
    // (full → gibbous → half → crescent → empty) rather than a clockwise pie.
    // The lit region is bounded by the right disk edge and the terminator ellipse
    // (horizontal radius r·(1−2f), so f=1 → left edge = full, f=0.5 → centre =
    // half, f→0 → right edge = new).
    if (fullness >= 4) {
        g.beginFill(LIGHT_FILL, 0.96); g.drawCircle(cx, cy, r); g.endFill();
    } else if (fullness >= 1) {
        const f = fullness / 4;                 // lit fraction: 0.75 / 0.5 / 0.25
        const N = 24;
        const pts = [];
        for (let i = 0; i <= N; i++) {          // right disk edge, top → bottom
            const th = -Math.PI / 2 + Math.PI * (i / N);
            pts.push(cx + r * Math.cos(th), cy + r * Math.sin(th));
        }
        const k = r * (1 - 2 * f);              // terminator horizontal radius (signed)
        for (let i = N; i >= 0; i--) {          // terminator arc, bottom → top
            const th = -Math.PI / 2 + Math.PI * (i / N);
            pts.push(cx + k * Math.cos(th), cy + r * Math.sin(th));
        }
        g.beginFill(LIGHT_FILL, 0.96);
        g.drawPolygon(pts);
        g.endFill();
    }

    // Amber frame ring.
    g.lineStyle(1.5, RING_COLOR, 0.95);
    g.drawCircle(cx, cy, r);
    g.lineStyle(0);

    // Pitch Black → an ✕ through the empty ring.
    if (fullness < 0) {
        const d = r * 0.55;
        g.lineStyle(1.6, CROSS_COLOR, 0.95);
        g.moveTo(cx - d, cy - d); g.lineTo(cx + d, cy + d);
        g.moveTo(cx + d, cy - d); g.lineTo(cx - d, cy + d);
        g.lineStyle(0);
    }

    container.addChild(g);
}

/* Sync the badge to the token's light tier. Shown ONLY on a token you control
 * that is currently SNEAKING (the light level is what matters while hiding);
 * cleared otherwise. Gated on a (tier + size) signature so unchanged conditions
 * no-op. */
function refreshBadge(token) {
    if (!token || token.destroyed) return;
    if (!token.controlled || !isStealthed(token.actor)) {
        if (token._wdmLightBadgeSig) { clearBadge(token); token._wdmLightBadgeSig = ""; }
        return;
    }
    let tier = null;
    try { tier = lightLevelAt(token); } catch (_) { tier = null; }
    const sig = tier ? `${tier}:${Math.round(Number(token.w) || 0)}:${Math.round(Number(token.h) || 0)}` : "";
    if (token._wdmLightBadgeSig === sig) return;
    token._wdmLightBadgeSig = sig;
    if (tier) drawBadge(token, tier);
    else      clearBadge(token);
}

/* Re-sync the controlled token(s) on scene-wide lighting / weather changes. */
function refreshControlled() {
    const tokens = canvas?.tokens?.controlled ?? [];
    for (const t of tokens) {
        try { refreshBadge(t); } catch (_) { /* skip a bad token */ }
    }
}

export function registerLightTokenIndicator() {
    Hooks.on("drawToken",    (t) => { try { refreshBadge(t); } catch (_) {} });
    Hooks.on("refreshToken", (t) => { try { refreshBadge(t); } catch (_) {} });
    Hooks.on("destroyToken", (t) => { try { clearBadge(t); } catch (_) {} });
    Hooks.on("controlToken", (t, controlled) => {
        try { controlled ? refreshBadge(t) : clearBadge(t); } catch (_) {}
    });
    /* Entering / leaving stealth flips whether the badge shows — refresh the
     * actor's tokens when their stealth flag changes. */
    Hooks.on("updateActor", (actor, changes) => {
        const flagsChanged = changes?.flags?.[SYSTEM_ID]?.stealth !== undefined
                          || changes?.flags?.["==" + SYSTEM_ID]?.stealth !== undefined;
        if (!flagsChanged) return;
        for (const t of (actor?.getActiveTokens?.() ?? [])) {
            try { refreshBadge(t); } catch (_) {}
        }
    });

    /* Scene-wide light/weather changes → re-sync the controlled token. The
     * per-token signature gate means it repaints only when its tier flips, so a
     * flurry of lightingRefresh (env fades, flashes) is cheap. */
    Hooks.on("lightingRefresh", refreshControlled);
    Hooks.on("updateWorldTime", refreshControlled);
    Hooks.on("updateScene",     refreshControlled);
    Hooks.on("wdm:weatherModifiersChanged", refreshControlled);
    Hooks.on("updateSetting", (setting) => {
        const k = setting?.key ?? "";
        if (k.startsWith(`${SYSTEM_ID}.weather`) || k === `${SYSTEM_ID}.manualWeather`) refreshControlled();
    });
    Hooks.on("createAmbientLight", refreshControlled);
    Hooks.on("updateAmbientLight", refreshControlled);
    Hooks.on("deleteAmbientLight", refreshControlled);
}
