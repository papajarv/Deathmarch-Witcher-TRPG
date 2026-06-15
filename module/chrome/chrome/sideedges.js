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

function publishChromeHeights() {
  // Hybrid sizing.  Top strip is measured dynamically because its rendered
  // height is stable per session but varies by viewport / subnav state, and
  // the bar needs to butt cleanly against the topbar's bottom edge.  Dock
  // sizes stay static — measuring them dynamically broke peace-mode last
  // time because of overflow content tricking the descendant walk.
  const root = document.documentElement;
  const topbar = document.getElementById("wou-top-bar");
  const topH = topbar ? Math.round(topbar.getBoundingClientRect().bottom) : 130;
  root.style.setProperty("--wdm-topstrip-h", `${topH}px`);
  root.style.setProperty("--wdm-dock-h", "160px");
  root.style.setProperty("--wdm-dock-combat-h", "230px");
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

export function wireSideEdges() {
  publishChromeHeights();
  // Top strip can change height on viewport resize (subnav wrapping etc.).
  // Cheap, fires rarely.  Dock vars are static — see publishChromeHeights().
  window.addEventListener("resize", publishChromeHeights, { passive: true });
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
    onOpen:  () => document.body.classList.add("wou-controls-open"),
    onClose: () => document.body.classList.remove("wou-controls-open")
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
