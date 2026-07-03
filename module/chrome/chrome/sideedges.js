/**
 * Side edges — left scene-controls + right sidebar.
 *
 * Both sides share the SAME interaction pattern:
 *   - target panel is fully hidden by default (translateX off-screen)
 *   - a slim trigger strip on the viewport edge catches hover/click
 *   - hovering the trigger lights an adjacent glow element (CSS :hover ~)
 *   - clicking the trigger expands the panel
 *   - trigger + glow hide while the panel is open
 *
 * Close mechanism differs because of what Foundry exposes:
 *   - RIGHT (#sidebar): Foundry's own arrow toggle.  Our `collapseSidebar`
 *                       hook listener mirrors the state both directions.
 *   - LEFT  (#scene-controls): Foundry has no native collapse arrow, so we
 *                       use Esc to close.  Outside-click is intentionally
 *                       NOT a close trigger — the user works on the canvas
 *                       with tools selected and shouldn't lose the panel.
 */

import { registerCollapsible, setEntryOpen } from "./collapsibles.js";

/* Cache of last-written values. Guards against writing IDENTICAL CSS
 * var values that would trigger downstream observers for no reason
 * (the writes still fire MutationRecords even when the value doesn't
 * change), and against redundant getComputedStyle calls which force
 * layout reflow. */
let _lastRaw = null;
let _lastCompensated = null;
let _lastScZoom = null;

function publishChromeHeights() {
  // Top strip is measured dynamically — its rendered height varies by
  // viewport, subnav state, AND the UI Scale slider (the top bar
  // carries a `zoom` that scales its rendered height).
  //
  // Two variables published:
  //   --wdm-topstrip-h    raw viewport-space bottom pixel. Consumers
  //                       on non-zoomed elements (like #ui-right)
  //                       read this directly.
  //   --wdm-topstrip-h-sc  compensated for #scene-controls' own zoom.
  //                       Chromium multiplies inline `top` values by
  //                       the element's zoom, so a raw bottom pixel
  //                       written to #scene-controls would render at
  //                       (bottom * zoom) — a visible gap at scale >1.
  //                       Dividing by scene-controls' zoom here means
  //                       the container's zoom multiplies back up and
  //                       visual top exactly equals the top bar's
  //                       rendered bottom.
  const root = document.documentElement;
  const topbar = document.getElementById("wou-top-bar");
  const scenecontrols = document.getElementById("scene-controls");
  const bottomPx = topbar ? topbar.getBoundingClientRect().bottom : 130;
  /* getComputedStyle forces a sync reflow — read it ONCE per publish
   * and cache. */
  const scZoom = scenecontrols
    ? (parseFloat(getComputedStyle(scenecontrols).zoom) || 1)
    : 1;
  const raw = Math.round(bottomPx);
  const compensated = Math.round(bottomPx / scZoom);
  /* Skip identical writes to keep MutationObservers on <html>.style
   * (chrome + Foundry) quiet, and to avoid repeated forced reflows. */
  if (raw === _lastRaw && compensated === _lastCompensated && scZoom === _lastScZoom) {
    return;
  }
  _lastRaw = raw;
  _lastCompensated = compensated;
  _lastScZoom = scZoom;
  root.style.setProperty("--wdm-topstrip-h",    `${raw}px`);
  root.style.setProperty("--wdm-topstrip-h-sc", `${compensated}px`);
  /* Static fallback rem values — notifications.js measures the dock with
   * getBoundingClientRect (which reflects zoom + UI Scale) and overrides
   * --wdm-dock-h shortly after. Only set the first time to avoid
   * clobbering later live measurements. */
  if (_lastRaw !== null && root.style.getPropertyValue("--wdm-dock-h") === "") {
    root.style.setProperty("--wdm-dock-h", "10rem");
    root.style.setProperty("--wdm-dock-combat-h", "14.375rem");
  }
}

const LEFT_TRIGGER_HTML  = `<div id="wou-left-trigger"></div><div id="wou-left-glow" aria-hidden="true"></div>`;
const RIGHT_TRIGGER_HTML = `<div id="wou-right-trigger"></div><div id="wou-right-glow" aria-hidden="true"></div>`;
/* The collapse button sits at the very TOP of #scene-controls as a fixed,
   full-width control — NOT inside the per-category tools menu (where it used
   to scroll with the tool list and read as just another tool).  It borrows the
   tool-button classes for styling but carries no data-action, so Foundry's
   tool dispatcher ignores it. */
const LEFT_CLOSE_HTML = `<button type="button" id="wou-controls-close" class="control ui-control tool icon fa-solid fa-caret-left" aria-label="Collapse Tools" data-tooltip="Collapse Tools"></button>`;

let sidebarEl = null;
let leftEl    = null;

/* rAF-throttled wrapper so bursty triggers (mutations + resizes firing
 * back-to-back) coalesce into one measure per frame. Cheap enough that
 * we can attach it to a lot of listeners without paying compound cost. */
let _publishScheduled = 0;
function schedulePublish() {
  if (_publishScheduled) return;
  _publishScheduled = requestAnimationFrame(() => {
    _publishScheduled = 0;
    publishChromeHeights();
  });
}
/* External call site — used by ui-scale.js applyUIScaleValues after
 * writing the scale vars, so publishChromeHeights re-runs with the
 * new zoom values without needing a broad body-class observer. */
export function schedulePublishChromeHeights() {
  schedulePublish();
}

export function wireSideEdges() {
  publishChromeHeights();
  /* Every layer we can watch for changes that could shift the top bar's
   * bottom edge OR scene-controls' own zoom. Each fires schedulePublish
   * which coalesces into one measurement per rAF. Belt AND suspenders
   * because getting this wrong leaves a visible gap on the left bar,
   * and CSS var propagation timing has been unreliable across the
   * class-flip → computed-style boundary. */

  // 1) Viewport resize (subnav wrapping, browser zoom, monitor swap).
  window.addEventListener("resize", schedulePublish, { passive: true });

  // 2) Body class flips are handled by DIRECT calls at the sites that
  //    matter (registerCollapsible onOpen/onClose for scene-controls
  //    below, ui-scale.js applyUIScaleValues). The old MutationObserver
  //    approach fired on EVERY body class change — and Foundry chrome
  //    toggles dozens of them (wou-inventory-open, wou-journal-open,
  //    wou-crafting-open, wou-map-open, wou-topbar-open, in-encounter,
  //    etc.). Each fire triggered a getBoundingClientRect +
  //    getComputedStyle read, forcing a synchronous reflow even when
  //    the write was skipped by the value guard. That was the source
  //    of the sustained "Forced reflow" violation spam. See
  //    `schedulePublishExternal` below — exported for the specific
  //    call sites that need to poke us.

  // 3) ResizeObserver on the top bar — height changes (font load,
  //    scene-name update, encounter-mode animations, zoom var change
  //    that expands padding).
  const topbar = document.getElementById("wou-top-bar");
  if (topbar && typeof ResizeObserver !== "undefined") {
    new ResizeObserver(schedulePublish).observe(topbar);
  }

  // 4) ResizeObserver on scene-controls REMOVED — it created a
  //    self-feedback loop. `leftbar.css` computes scene-controls'
  //    HEIGHT from `--wdm-topstrip-h-sc` via calc(). Writing that
  //    var here changes scene-controls' height → ResizeObserver
  //    fires → publishChromeHeights runs → writes var → loop.
  //    The body class MutationObserver (2) already catches every
  //    state that flips scene-controls' zoom (which is the only
  //    thing that could shift the top-bar-relative measurement);
  //    tools-panel content changes don't affect top bar height.

  // 5) UI-scale changes fire a synthetic window resize (via
  //    applyUIScaleValues in chrome/setup/ui-scale.js), which trigger
  //    #1 above. We used to also MutationObserve `<html>`'s style
  //    attribute to catch CSS var writes directly, but that created
  //    an infinite loop: publishChromeHeights writes CSS vars → style
  //    observer fires → publishChromeHeights runs → writes again.
  //    The synthetic resize is enough.

  // 6) Foundry hooks — renderSceneControls fires when the tool panel
  //    rebuilds (different scene, layer switch); ready catches the
  //    initial full render past any deferred layout work.
  try { Hooks.on("renderSceneControls", schedulePublish); } catch (_) {}

  // 7) Low-cadence backup poll for the first 5 seconds. Font loads
  //    and lazy asset fetches can shift the top bar's rendered height
  //    after we've stopped listening. Cheap belt against the tail of
  //    the load sequence.
  let ticks = 0;
  const poll = setInterval(() => {
    schedulePublish();
    if (++ticks >= 25) clearInterval(poll);  // 25 × 200ms = 5s
  }, 200);

  wireLeft();
  wireRight();
}

/* -------------------------------------------------------------------------- */
function wireLeft() {
  leftEl = document.getElementById("scene-controls");
  if (!leftEl) return;

  registerCollapsible(leftEl, "left", {
    skipPeek: true,
    closeOnOutsideClick: false,
    closeOnEsc: true,
    onOpen:  () => {
      document.body.classList.add("wou-controls-open");
      /* Direct trigger — the class flip changes scene-controls' zoom
       * rule state, which shifts the compensated top value. */
      schedulePublish();
    },
    onClose: () => {
      document.body.classList.remove("wou-controls-open");
      schedulePublish();
    }
  });

  if (!document.getElementById("wou-left-trigger")) {
    document.body.insertAdjacentHTML("beforeend", LEFT_TRIGGER_HTML);
    const trigger = document.getElementById("wou-left-trigger");
    trigger.addEventListener("click", () => setEntryOpen(leftEl, true));
  }

  // Pin the close button to the TOP of #scene-controls, above the tool menus.
  // Foundry re-renders the controls when the user switches categories, so we
  // re-inject on every renderSceneControls.
  ensureControlsCloseButton();
  Hooks.on("renderSceneControls", ensureControlsCloseButton);
}

function ensureControlsCloseButton() {
  const sc = document.getElementById("scene-controls");
  if (!sc || sc.querySelector("#wou-controls-close")) return;
  sc.insertAdjacentHTML("afterbegin", LEFT_CLOSE_HTML);
  sc.querySelector("#wou-controls-close")
    .addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); setEntryOpen(leftEl, false); });
}

/* -------------------------------------------------------------------------- */
function wireRight() {
  sidebarEl = document.getElementById("sidebar");
  if (!sidebarEl) return;

  registerCollapsible(sidebarEl, "right", {
    skipPeek: true,
    closeOnOutsideClick: false,
    closeOnEsc: false,
    onOpen:  () => ui.sidebar?.expand?.(),
    onClose: () => ui.sidebar?.collapse?.()
  });

  if (!document.getElementById("wou-right-trigger")) {
    document.body.insertAdjacentHTML("beforeend", RIGHT_TRIGGER_HTML);
    const trigger = document.getElementById("wou-right-trigger");
    trigger.addEventListener("click", () => ui.sidebar?.expand?.());
  }

  // Mirror Foundry's expand/collapse state silently.
  Hooks.on("collapseSidebar", (_sidebar, isCollapsed) => {
    setEntryOpen(sidebarEl, !isCollapsed, { silent: true });
    document.body.classList.toggle("wou-sidebar-open", !isCollapsed);
  });

  if (ui.sidebar?.expanded) {
    setEntryOpen(sidebarEl, true, { silent: true });
    document.body.classList.add("wou-sidebar-open");
  }
}
