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
    const mode = getSetting("ui.scaleMode") ?? "manual";
    applyUIScaleValues({
        mode,
        scale: Number(getSetting("ui.scale") ?? 1.0),
        bars: Number(getSetting("ui.chromeBarsScale") ?? 1.0),
        detailed: getSetting("ui.detailedScales") ?? null
    });
    applyPerSurfaceScales(mode);
    scheduleAutoFit();
}

/* ── Per-surface text AUTO-FIT (option B) ────────────────────────────────────
 * A surface's LAYOUT is fixed by its size knob; scaled text must never grow it.
 * For each fixed-size surface we measure its height with text neutralized to
 * base (the "don't grow past this" target), then at the full text scale; if the
 * full scale overflows, we binary-search a fit factor (--wdm-fit-<key>, folded
 * into that surface's text factor) so text scales up only as far as fits. Runs
 * on scale change / resize, coalesced via rAF. Bars first; panels to follow. */
const FIT_SURFACES = Object.freeze([
    { sel: "#wou-top-bar", fitVar: "--wdm-fit-topbar", fsKey: "topbar" },
    { sel: "#wou-dock",    fitVar: "--wdm-fit-dock",   fsKey: "dock" }
]);
let _fitRaf = 0;
export function scheduleAutoFit() {
    if (_fitRaf) return;
    _fitRaf = requestAnimationFrame(() => { _fitRaf = 0; try { autoFitSurfaces(); } catch (_) {} });
}
function autoFitSurfaces() {
    const rootStyle = document.documentElement.style;
    const cs = getComputedStyle(document.documentElement);
    const scale = parseFloat(cs.getPropertyValue("--wdm-scale")) || 1;
    for (const s of FIT_SURFACES) {
        const el = document.querySelector(s.sel);
        if (!el || !el.offsetParent) continue;             // absent / hidden
        const fs = parseFloat(cs.getPropertyValue(`--wdm-fs-${s.fsKey}`)) || 1;
        const textKnob = scale * fs;                        // text scale beyond base
        if (textKnob <= 1.001) { rootStyle.setProperty(s.fitVar, "1"); continue; }
        /* Target: height with text at base (fit cancels the text knob). */
        rootStyle.setProperty(s.fitVar, String(1 / textKnob));
        const target = el.getBoundingClientRect().height;
        /* Full text scale. */
        rootStyle.setProperty(s.fitVar, "1");
        if (el.getBoundingClientRect().height <= target + 0.5) continue;   // already fits
        /* Largest fit in [1/textKnob, 1] that stays within target. */
        let lo = 1 / textKnob, hi = 1;
        for (let i = 0; i < 8; i++) {
            const mid = (lo + hi) / 2;
            rootStyle.setProperty(s.fitVar, String(mid));
            if (el.getBoundingClientRect().height <= target + 0.5) lo = mid; else hi = mid;
        }
        rootStyle.setProperty(s.fitVar, String(lo));
    }
}

/* Per-surface DECOUPLED scaling. Writes two CSS vars per surface:
 *   --wdm-size-<key> : LAYOUT zoom (frame/spacing) — drives the surface's zoom.
 *   --wdm-fs-<key>   : TEXT multiplier — folded into the surface's text factor
 *                      so text = base × UI-Scale × fs, independent of the size
 *                      zoom (the factor divides the size back out; see the CSS).
 * Both default 1.0 (identical to today). Clamped to a comfortable range. */
const PER_SURFACE_KEYS = Object.freeze([
    "topbar", "dock", "sidebar", "scenecontrols",
    "character", "inventory", "bestiary", "journal", "crafting", "map"
]);
function clampSurface(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v <= 0) return 1;
    return Math.max(0.5, Math.min(2.5, v));
}
export function applyPerSurfaceScales(mode = getSetting("ui.scaleMode")) {
    const root = document.documentElement;
    /* Per-surface Size/Text ONLY apply in "persection" mode. In every other
     * mode we REMOVE these vars so the CSS falls back to the legacy scaling
     * (--wdm-scale for panels, --wdm-scale × bar-scale for bars) — that's how
     * Auto / Manual / Detailed keep behaving exactly as before. */
    if (mode !== "persection") {
        for (const k of PER_SURFACE_KEYS) {
            root.style.removeProperty(`--wdm-size-${k}`);
            root.style.removeProperty(`--wdm-fs-${k}`);
        }
        return;
    }
    const sizes = getSetting("ui.sizeScales") ?? {};
    const fonts = getSetting("ui.fontScales") ?? {};
    for (const k of PER_SURFACE_KEYS) {
        root.style.setProperty(`--wdm-size-${k}`, String(clampSurface(sizes[k])));
        root.style.setProperty(`--wdm-fs-${k}`,   String(clampSurface(fonts[k])));
    }
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

    if (mode === "persection") {
        /* Per-section: --wdm-scale is the global UI Text Scaling (used inside
         * every surface's text factor). Per-surface Size/Text vars are written
         * separately by applyPerSurfaceScales(). Clear the legacy per-element /
         * aggregate vars so they can't leak into the CSS fallbacks (which are
         * overridden by the per-surface vars in this mode anyway). */
        root.style.setProperty("--wdm-scale", String(clampScale(s)));
        root.style.setProperty("--wdm-chrome-bars-scale", "1");
        for (const cssVar of ["--wdm-topbar-scale", "--wdm-dock-scale",
                              "--wdm-sidebar-scale", "--wdm-scenecontrols-scale",
                              "--wdm-popup-scale"]) {
            root.style.removeProperty(cssVar);
        }
    } else if (mode === "detailed") {
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
         * fall back to the aggregate `--wdm-chrome-bars-scale`.
         *
         * Popups: we DON'T write `--wdm-popup-scale` in these modes
         * anymore. The old code wrote `--wdm-popup-scale = --wdm-scale`,
         * which double-scaled popup text: the html `font-size: calc(16px
         * * var(--wdm-scale))` rule already inflates every rem-based
         * dimension by `--wdm-scale`, and then popup zoom multiplied on
         * top. Chrome bars sidestepped the double because THEIR zoom
         * uses `--wdm-chrome-bars-scale` (default 1.0), so their text
         * scaled once via the html rule. Popups now inherit the same
         * single-scale behaviour: with `--wdm-popup-scale` removed here,
         * the CSS rule in tokens.css falls through to
         * `--wdm-chrome-bars-scale`, matching chrome exactly.
         *
         * The scaleMode toggle still has its intended effect via the
         * html `font-size` rule, which continues to read `--wdm-scale`
         * — so Auto mode still makes text bigger on tall viewports;
         * popup CONTENT just doesn't get a second multiplier. */
        for (const cssVar of ["--wdm-topbar-scale", "--wdm-dock-scale",
                              "--wdm-sidebar-scale", "--wdm-scenecontrols-scale",
                              "--wdm-popup-scale"]) {
            root.style.removeProperty(cssVar);
        }
        const final = clampScale(mode === "auto" ? pickAutoScale() * s : s);
        root.style.setProperty("--wdm-scale",         String(final));
        root.style.setProperty("--wdm-chrome-bars-scale", String(clampScale(bars)));
    }

    /* Body class drives CSS-based visibility of the UI Scale + Chrome Bars
     * Scale form-groups in the settings dialog. CSS rule lives in
     * styles/chrome.css. */
    document.body.classList.toggle("wou-ui-scale-auto",       mode === "auto");
    document.body.classList.toggle("wou-ui-scale-detailed",   mode === "detailed");
    document.body.classList.toggle("wou-ui-scale-persection", mode === "persection");
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
    /* Auto-fit re-measures on resize (bar width change → wrapping → height),
     * regardless of scale mode. Coalesced via rAF, so it's cheap. */
    window.addEventListener("resize", scheduleAutoFit, { passive: true });
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
