/**
 * Re-anchor Foundry's notifications strip to sit just above our dock.
 *
 * Foundry's Notifications class owns the queue, lifetime, click-to-dismiss
 * and console mirror.  We don't intercept any of that — we only:
 *
 *   1) Mark the body so CSS can take over positioning + styling.
 *   2) Publish `--wdm-dock-h` on <html>, updated via ResizeObserver, so the
 *      strip's `bottom` follows the dock through resizes / state swaps
 *      (peace ↔ war) without flicker.
 *
 * All visual changes live in styles/chrome.css under the matching selectors.
 */

const ROOT_VAR = "--wdm-dock-h";
const FALLBACK_DOCK_H = 96;   // sensible default if the dock isn't mounted yet

let _ro = null;

function publishDockHeight() {
  const dock = document.getElementById("wou-dock");
  const root = document.documentElement;
  if (!dock) {
    root.style.setProperty(ROOT_VAR, `${FALLBACK_DOCK_H}px`);
    return;
  }
  const h = Math.round(dock.getBoundingClientRect().height) || FALLBACK_DOCK_H;
  root.style.setProperty(ROOT_VAR, `${h}px`);
}

export function installNotificationsAboveDock() {
  document.body.classList.add("wou-notifications-styled");

  publishDockHeight();

  /* The dock height changes when entering/leaving combat (extra ember strip,
   * combat-only addendum, etc.) and when the viewport resizes.  A single
   * ResizeObserver on the dock node covers both: any reflow that changes
   * its bounding-box height re-publishes the var so the notifications strip
   * tracks. */
  const dock = document.getElementById("wou-dock");
  if (dock && typeof ResizeObserver !== "undefined") {
    if (_ro) _ro.disconnect();
    _ro = new ResizeObserver(() => publishDockHeight());
    _ro.observe(dock);
  } else {
    window.addEventListener("resize", publishDockHeight, { passive: true });
  }
}
