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
const SIDEBAR_VAR = "--wdm-sidebar-w";   // live expanded-sidebar panel width
const FALLBACK_DOCK_H = 96;   // sensible default if the dock isn't mounted yet

let _lastPublished = -1;
let _rafId = null;
let _dirty = true;          // publish on the next tick when set
let _dockRO = null;         // ResizeObserver on the dock (attached lazily once it mounts)
let _frame = 0;
function _markLayoutDirty() { _dirty = true; }

/** Publish the expanded right-sidebar panel width (0 when collapsed) so the
 *  chat-preview column can shift LEFT of it, and toggle a body class while any
 *  preview cards are on-screen so Foundry's warning strip can shrink its right
 *  edge to clear the card lane. Both are cheap per-frame DOM reads. */
function publishLayout() {
  const root = document.documentElement;
  const open = document.body?.classList?.contains("wou-sidebar-open");
  const panel = document.getElementById("ui-right") || document.getElementById("sidebar");
  const w = (open && panel) ? Math.max(0, Math.round(panel.getBoundingClientRect().width)) : 0;
  const ws = `${w}px`;
  if (root.style.getPropertyValue(SIDEBAR_VAR) !== ws) root.style.setProperty(SIDEBAR_VAR, ws);

  const strip = document.getElementById("wdm-chat-previews");
  document.body?.classList?.toggle("wdm-has-chat-previews", !!(strip && strip.children.length));
}

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

/** Publish the dock-height / sidebar-width CSS vars, driven by events instead
 *  of a per-frame layout poll.
 *
 *  The old loop called `getBoundingClientRect()` EVERY frame. That's ~free when
 *  the layout is clean (idle), but during ANY interaction that dirties layout
 *  (selecting tokens, dock rebind, combat state swap) the per-frame read forces
 *  a SYNCHRONOUS full-page reflow every frame AND flushes everyone else's
 *  pending writes with it — the "notifications rAF took 100ms+" thrash that made
 *  even a 6-token box-select stutter. It was a fixed per-interaction cost, not
 *  token-count scaling.
 *
 *  Now we only read layout when a repositioning source actually fires:
 *    - ResizeObserver on the dock  → height/content changes (combat swap, rebind)
 *    - window resize               → viewport changes
 *    - a low-frequency safety re-read (every ~30 frames) → catches anything the
 *      observers miss (UI-scale transform, sidebar toggle) within ~0.5s, at
 *      ≈2 cheap reflows/sec instead of 60 forced ones.
 *  The rAF still ticks every frame, but a clean frame now costs one boolean
 *  check — no layout read, no forced reflow. */
function startTrackingLoop() {
  if (_rafId != null) return;

  try { window.addEventListener("resize", _markLayoutDirty, { passive: true }); } catch (_) {}

  const ensureDockObserver = () => {
    if (_dockRO || !window.ResizeObserver) return;
    const dock = document.getElementById("wou-dock");
    if (!dock) return;                        // dock not mounted yet — retry next tick
    _dockRO = new ResizeObserver(_markLayoutDirty);
    _dockRO.observe(dock);
    _markLayoutDirty();                        // publish once now that we can measure it
  };

  const tick = () => {
    _frame++;
    ensureDockObserver();
    if (_dirty || (_frame % 30 === 0)) {       // dirty signal, or the periodic safety re-read
      _dirty = false;
      publishDockHeight();
      publishLayout();
    }
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
  try { window.removeEventListener("resize", _markLayoutDirty); } catch (_) {}
  try { _dockRO?.disconnect(); } catch (_) {}
  _dockRO = null;
  _lastPublished = -1;
  _dirty = true;
}
