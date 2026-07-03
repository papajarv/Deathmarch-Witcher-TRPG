/**
 * UI scale.
 *
 * Drives `--wdm-scale` on <html> from a per-client setting. The CSS in
 * `styles/tokens.css` reads it for `html:has(body.witcher-ttrpg-death-march)
 * { font-size: calc(1rem * var(--wdm-scale, 1)); }`, so every rem-based size
 * in the chrome scales off this one value.
 *
 * Modes:
 *   manual — `ui.scale` is used verbatim.
 *   auto   — picked from viewport + devicePixelRatio. The user's manual value
 *            multiplies the auto pick, so a 4K user who likes things slightly
 *            larger can leave the slider at 1.1 and still get auto-fit.
 *
 * Auto-detect responsiveness:
 *   Browsers don't reliably emit events when the user drags the window to a
 *   different monitor. We layer four detectors:
 *     - resize (catches manual window resizes)
 *     - matchMedia(resolution) change (catches DPR shifts between monitors)
 *     - visibilitychange + focus (catches tab/window refocus after a switch)
 *     - 1.5s screen-signature poll (catches monitor swap with matching DPR)
 *
 * Bounds: clamped to [0.6, 1.6]. Outside that, layouts that were not built to
 * scale at all get unreadable in one direction and clip in the other.
 */

import { getSetting } from "./settings.js";

const SCALE_MIN = 0.6;
const SCALE_MAX = 1.6;

/* Auto mode picks a scale proportional to the viewport height. Anchored
 * at 1067px CSS-pixel height (a common laptop viewport); anything taller
 * scales up, anything shorter scales down. The user's manual slider
 * value is applied ON TOP as a multiplier so a 4K user who prefers
 * slightly bigger text can leave the slider at 1.1 and still get
 * auto-fit. Clamped inside applyUIScaleValues. */
function pickAutoScale() {
    const h = Number(window.innerHeight) || 1067;
    return h / 1067;
}

function clampScale(n) {
    if (!Number.isFinite(n)) return 1.0;
    return Math.max(SCALE_MIN, Math.min(SCALE_MAX, n));
}

/* Per-element vars written in Detailed mode. Cleared (removeProperty) in
 * Auto / Manual so the CSS fallback chain (var(--wdm-X-scale, var(
 * --wdm-chrome-bars-scale, 1))) kicks in and the aggregate slider wins.
 * Keep in sync with the `ui.detailedScales` default in
 * chrome/setup/settings.js. */
const DETAILED_VARS = Object.freeze({
    ui:            "--wdm-scale",           // main UI scale (font-size chain + fallback for popups)
    topbar:        "--wdm-topbar-scale",
    dock:          "--wdm-dock-scale",
    sidebar:       "--wdm-sidebar-scale",
    scenecontrols: "--wdm-scenecontrols-scale",
    popups:        "--wdm-popup-scale"
});

/* Apply the persisted setting values. Called once at ready and on each
 * onChange (which Foundry fires only on Save). Live drags during the
 * settings dialog are handled by installSettingsLivePreview() below. */
export function applyUIScale() {
    applyUIScaleValues({
        mode: getSetting("ui.scaleMode") ?? "manual",
        scale: Number(getSetting("ui.scale") ?? 1.0),
        bars: Number(getSetting("ui.chromeBarsScale") ?? 1.0),
        detailed: getSetting("ui.detailedScales") ?? null
    });
}

/* Pure write — no setting reads. Used by both applyUIScale (after reading
 * settings) and the live-preview input handler (which passes draft values
 * before the user saves).
 *
 * Modes:
 *   auto     — viewport-picked scale × ui.scale, aggregate bars, per-
 *              element vars cleared.
 *   manual   — ui.scale, aggregate bars, per-element vars cleared.
 *   detailed — main --wdm-scale = detailed.ui, aggregate bars fallback
 *              stays for safety, per-element vars WRITTEN so CSS uses
 *              them ahead of the aggregate. */
function applyUIScaleValues({ mode, scale, bars, detailed = null }) {
    const s = Number(scale) || 1.0;
    const root = document.documentElement;

    if (mode === "detailed") {
        /* Detailed mode: write every per-element var from the
         * detailedScales object; missing keys default to 1.0. Also
         * write the aggregate --wdm-scale from detailed.ui so any CSS
         * that uses --wdm-scale directly (font-size chain, chrome
         * overlays) gets the intended value. */
        const d = detailed ?? {};
        for (const [key, cssVar] of Object.entries(DETAILED_VARS)) {
            const v = clampScale(Number(d[key] ?? 1.0) || 1.0);
            root.style.setProperty(cssVar, String(v));
        }
        /* Aggregate --wdm-chrome-bars-scale isn't really used in
         * detailed mode (per-element vars win) but set it to 1.0 so
         * any late-fallback path doesn't reuse a stale value from a
         * previous Manual mode. */
        root.style.setProperty("--wdm-chrome-bars-scale", "1");
    } else {
        /* Auto / Manual: clear the per-element CHROME vars so those
         * fall back to the aggregate `--wdm-chrome-bars-scale`. Popups
         * are handled EXPLICITLY below — we write `--wdm-popup-scale`
         * = `--wdm-scale` so Auto's viewport+DPI factor reaches popup
         * windows deterministically (any CSS fallback chain is fragile
         * against Foundry / module rules setting the var elsewhere). */
        for (const cssVar of ["--wdm-topbar-scale", "--wdm-dock-scale",
                              "--wdm-sidebar-scale", "--wdm-scenecontrols-scale"]) {
            root.style.removeProperty(cssVar);
        }
        const final = clampScale(mode === "auto" ? pickAutoScale() * s : s);
        root.style.setProperty("--wdm-scale",         String(final));
        root.style.setProperty("--wdm-popup-scale",   String(final));
        root.style.setProperty("--wdm-chrome-bars-scale", String(clampScale(bars)));
    }

    /* Body class drives CSS-based visibility of the UI Scale + Chrome Bars
     * Scale form-groups in the settings dialog. CSS rule lives in
     * styles/chrome.css. */
    document.body.classList.toggle("wou-ui-scale-auto",     mode === "auto");
    document.body.classList.toggle("wou-ui-scale-detailed", mode === "detailed");
    /* Direct notify — sideedges.js exports a schedule hook so this
     * function can trigger publishChromeHeights (which re-measures the
     * top bar's bottom edge + writes the compensated var scene-controls
     * reads for its top position). Direct call replaces the broad body-
     * class MutationObserver that used to catch this indirectly and
     * cost a forced reflow on every unrelated body class change. Async-
     * imported so ui-scale.js stays independently loadable in tests. */
    try {
        import("../chrome/sideedges.js")
            .then(m => m.schedulePublishChromeHeights?.())
            .catch(() => {});
    } catch (_) { /* no-op */ }
}

/* Re-apply on viewport / display change.
 *  - resize handles intra-display window resizes.
 *  - visibilitychange + focus catch the case where the user drags Foundry
 *    between monitors (resize often doesn't fire on Electron windows).
 *  - the poll covers monitor swaps when both monitors share a DPR. */
let resizeTimer = 0;
function onScheduleApply() {
    if (getSetting("ui.scaleMode") !== "auto") return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(applyUIScale, 120);
}

/* Lightweight screen-signature poll: a string of dimensions + dpr that
 * changes whenever the user moves between displays. Polling at 1.5s is
 * imperceptible runtime-wise and catches what events miss. */
let lastSig = "";
function screenSig() {
    return `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio}`
        + `:${screen.width}x${screen.height}`;
}
function pollScreen() {
    if (getSetting("ui.scaleMode") !== "auto") return;
    const sig = screenSig();
    if (sig !== lastSig) {
        lastSig = sig;
        applyUIScale();
    }
}

/* ──────────────────────────────────────────────────────────────────────── */

/* Live preview + persistence is handled by the UIScaleConfig dialog in
 * ./ui-scale-config.js. It calls applyUIScaleValues() on every input event,
 * and applyUIScale() on Apply / Cancel / Close. */
export { applyUIScaleValues };

let installed = false;
export function installUIScaleWatcher() {
    if (installed) return;
    installed = true;
    lastSig = screenSig();
    window.addEventListener("resize", onScheduleApply, { passive: true });
    window.addEventListener("focus", onScheduleApply, { passive: true });
    document.addEventListener("visibilitychange", onScheduleApply, { passive: true });
    /* Note: a `(resolution: Ndppx)` query matches only when DPR equals N.
     * When the user moves to a monitor with a different DPR, the query stops
     * matching and fires `change`. Rebuilt below after each fire so the next
     * query is anchored to the new DPR. */
    function attachDprListener() {
        try {
            const q = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
            const handler = () => {
                onScheduleApply();
                q.removeEventListener?.("change", handler);
                attachDprListener();
            };
            q.addEventListener?.("change", handler);
        } catch { /* old browsers — other detectors carry it */ }
    }
    attachDprListener();
    setInterval(pollScreen, 1500);
}
