/**
 * Re-anchor Foundry's notifications strip to sit just above our dock.
 *
 * Foundry's Notifications class owns the queue, lifetime, click-to-dismiss
 * and console mirror.  We don't intercept any of that — we only:
 *
 *   1) Mark the body so CSS can take over positioning + styling.
 *   2) Continuously publish `--wdm-dock-h` on <html> — the pixel distance
 *      from the viewport bottom to the dock's on-screen top edge. That
 *      value stays correct whether Foundry applies UI-scaling via CSS
 *      transform, zoom, or root font-size, because it's read from the
 *      dock's post-transform bounding-client rect on every animation
 *      frame.
 *
 * All visual changes live in styles/chrome.css under the matching selectors.
 */

const ROOT_VAR = "--wdm-dock-h";
const FALLBACK_DOCK_H = 96;   // sensible default if the dock isn't mounted yet

let _lastPublished = -1;
let _rafId = null;

/** Read the dock's current viewport-space top edge and publish the
 *  distance from the viewport bottom. The rectangle IS post-transform:
 *  MDN — "The returned value is the smallest rectangle which contains
 *  the entire element and its descendants ... in viewport coordinates,
 *  which include any transforms applied to the element or its ancestors."
 *
 *  Idempotent — the value is only written when it differs from the
 *  previous publish, so a static dock doesn't churn the CSS var. */
function publishDockHeight() {
  const dock = document.getElementById("wou-dock");
  const root = document.documentElement;
  const desiredFallback = `${FALLBACK_DOCK_H}px`;
  if (!dock) {
    if (root.style.getPropertyValue(ROOT_VAR) !== desiredFallback) {
      root.style.setProperty(ROOT_VAR, desiredFallback);
      _lastPublished = FALLBACK_DOCK_H;
    }
    return;
  }
  const rect = dock.getBoundingClientRect();
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;
  const clearance = Math.max(0, Math.round(vh - rect.top));
  const next = clearance || FALLBACK_DOCK_H;
  const nextStr = `${next}px`;
  /* Compare against the LIVE inline-style value, not a JS-side memo.
   * sideedges.js publishes a `--wdm-dock-h: 10rem` fallback on init +
   * on window resize, which lands AFTER the first RAF tick; a memo-
   * based gate ("same value as last write? skip.") then never re-
   * asserts the correct px value and the fallback wins forever.
   * Reading the inline style back per tick is a cheap DOM read that
   * catches any external override on the very next frame. */
  if (root.style.getPropertyValue(ROOT_VAR) !== nextStr) {
    root.style.setProperty(ROOT_VAR, nextStr);
    _lastPublished = next;
  }
}

/** Start the RAF poll loop. The overhead is a single bounding-rect
 *  read per frame — that's cheap, and it catches EVERY source of
 *  dock repositioning (UI scale changes, combat state swaps,
 *  viewport resizes, sidebar open/close, dev-tools flyout, etc.)
 *  without having to know which specific mechanism Foundry used. */
function startTrackingLoop() {
  if (_rafId != null) return;
  const tick = () => {
    publishDockHeight();
    _rafId = requestAnimationFrame(tick);
  };
  _rafId = requestAnimationFrame(tick);
}

export function installNotificationsAboveDock() {
  document.body.classList.add("wou-notifications-styled");
  publishDockHeight();
  startTrackingLoop();
}

/** Test-seam: stop the RAF loop and clear caches. Only used from
 *  integration tests / hot-reload scenarios so a re-install lands
 *  a fresh loop rather than doubling up. */
export function _stopTrackingLoop() {
  if (_rafId != null) {
    cancelAnimationFrame(_rafId);
    _rafId = null;
  }
  _lastPublished = -1;
}
