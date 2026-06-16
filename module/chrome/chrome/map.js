/**
 * Map overlay — displays an image from a first-class Map item.
 *
 * Map items are now their own Foundry Item type (`item.type === "map"`).
 * The image lives on the schema field system.mapImage, configured from the
 * item sheet's Map panel (cog → config → Choose image). getMapImage() in
 * sheets/valuable-map.js reads it, with legacy flag namespaces as fallback.
 *
 * Layout:
 *   ┌─ Header ─────────────────────────────────────────────────┐
 *   │  MAP                              [icon][icon][icon] …   │  ← toolbar (top-right)
 *   ├──────────────────────────────────────────────────────────┤
 *   │                                                          │
 *   │                  selected map image                      │
 *   │                  (object-fit: contain)                   │
 *   │                                                          │
 *   └──────────────────────────────────────────────────────────┘
 */

import { isMapItem, getMapImage } from "../sheets/valuable-map.js";

const MODULE_ID = "witcher-ttrpg-death-march";
const PANEL_ID  = "wou-map";

let panelEl = null;
let hooksWired = false;
let activeMapId = null;
let _chromeResizeObs   = null;
let _chromeMutationObs = null;
const CHROME_SELECTORS = ["#wou-top-bar", "#wou-dock", "#scene-controls", "#sidebar"];

/* Pan/zoom state — preserved across renders so a data refresh (item update,
   etc.) doesn't blow away the user's viewport.  Reset only when activeMapId
   changes (i.e., user picks a different map). */
let mapView = { scale: 1, tx: 0, ty: 0 };
/* Min zoom = 1 (starting scale, which is `object-fit: contain` size).  The
   user can zoom IN (>1) to inspect, but not OUT below the fit — there's no
   visual benefit and it'd float a tiny image in a dark void. */
const ZOOM_MIN = 1, ZOOM_MAX = 10, ZOOM_STEP = 1.15;
let _dragState = null;        // {startX, startY, baseTx, baseTy} during drag

/* =========================================================================
   PUBLIC API
   ========================================================================= */

export function injectMapPanel() {
  if (document.getElementById(PANEL_ID)) return;
  const el = document.createElement("main");
  el.id = PANEL_ID;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "Map");
  document.body.appendChild(el);
  panelEl = el;

  if (!hooksWired) {
    const ownsItem = (it) => it?.parent?.id === game.user.character?.id;
    Hooks.on("updateUser",  (u) => { if (u.id === game.user.id)               rerenderIfOpen(); });
    Hooks.on("updateActor", (a) => { if (a.id === game.user.character?.id)    rerenderIfOpen(); });
    Hooks.on("createItem",  (i) => { if (ownsItem(i) && isMapItem(i))         rerenderIfOpen(); });
    Hooks.on("updateItem",  (i) => { if (ownsItem(i) && isMapItem(i))         rerenderIfOpen(); });
    Hooks.on("deleteItem",  (i) => { if (ownsItem(i) && isMapItem(i)) {
      if (activeMapId === i.id) activeMapId = null;
      rerenderIfOpen();
    }});
    window.addEventListener("resize", positionBounds, { passive: true });
    wireChromeObservers();
    hooksWired = true;
  }
}

export function toggleMap() {
  if (!panelEl) injectMapPanel();
  const willOpen = !panelEl.classList.contains("is-open");
  setMapOpen(willOpen);
}

export function setMapOpen(open) {
  if (!panelEl) injectMapPanel();
  if (open) {
    // Sibling-close pattern — only one drop-down panel open at a time.
    if (document.body.classList.contains("wou-inventory-open")) {
      import("./inventory.js").then(m => m.setInventoryOpen(false)).catch(() => {});
    }
    if (document.body.classList.contains("wou-journal-open")) {
      import("./journal.js").then(m => m.setJournalOpen(false)).catch(() => {});
    }
    if (document.body.classList.contains("wou-crafting-open")) {
      import("./crafting.js").then(m => m.setCraftingOpen(false)).catch(() => {});
    }
    if (document.body.classList.contains("wou-character-open")) {
      import("./character.js").then(m => m.setCharacterOpen(false)).catch(() => {});
    }
    if (document.body.classList.contains("wou-bestiary-open")) {
      import("./bestiary.js").then(m => m.setBestiaryOpen(false)).catch(() => {});
    }
    positionBounds();
    render();
    panelEl.classList.add("is-open");
    document.body.classList.add("wou-map-open");
    syncTopbarTab(true);
  } else {
    panelEl.classList.remove("is-open");
    document.body.classList.remove("wou-map-open");
    syncTopbarTab(false);
  }
}

export function isMapOpen() {
  return !!panelEl?.classList.contains("is-open");
}

function rerenderIfOpen() {
  if (isMapOpen()) render();
}

/* =========================================================================
   POSITIONING
   ========================================================================= */

function positionBounds() {
  if (!panelEl) return;
  const W = window.innerWidth, H = window.innerHeight;
  const body = document.body;
  const topbarOpen = body.classList.contains("wou-topbar-open");
  const leftOpen   = body.classList.contains("wou-controls-open");
  const rightOpen  = body.classList.contains("wou-sidebar-open");

  const topbar  = document.getElementById("wou-top-bar");
  const dock    = document.getElementById("wou-dock");
  const leftbar = document.getElementById("scene-controls");
  const sidebar = document.getElementById("sidebar");

  const top    = (topbarOpen && topbar) ? Math.max(0, topbar.getBoundingClientRect().bottom) : 0;
  /* Map intentionally extends all the way to the viewport bottom — it
     overlays the dock instead of sitting above it.  Big maps need every
     pixel; the dock is fine being covered while the map is open. */
  const bottom =  0;
  const left   = (leftOpen   && leftbar)? Math.max(0, leftbar.getBoundingClientRect().right) : 0;
  const right  = (rightOpen  && sidebar)? Math.max(0, W - sidebar.getBoundingClientRect().left) : 0;

  panelEl.style.top    = `${top}px`;
  panelEl.style.bottom = `${bottom}px`;
  panelEl.style.left   = `${left}px`;
  panelEl.style.right  = `${right}px`;

  const tab = document.querySelector('#wou-top-bar [data-tab="map"]');
  if (tab) {
    const tabRect = tab.getBoundingClientRect();
    const tabCenterX = tabRect.left + tabRect.width / 2;
    panelEl.style.setProperty("--map-close-x", `${tabCenterX - left}px`);
  }
}

function wireChromeObservers() {
  const reposition = () => requestAnimationFrame(positionBounds);
  if ("ResizeObserver" in window) {
    _chromeResizeObs = new ResizeObserver(reposition);
    for (const sel of CHROME_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) _chromeResizeObs.observe(el);
    }
  }
  if ("MutationObserver" in window) {
    _chromeMutationObs = new MutationObserver(reposition);
    for (const sel of CHROME_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) _chromeMutationObs.observe(el, { attributes: true, attributeFilter: ["class", "style"] });
    }
    _chromeMutationObs.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  }
  for (const sel of CHROME_SELECTORS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    el.addEventListener("transitionend", reposition);
    el.addEventListener("animationend",  reposition);
  }
}

/* =========================================================================
   RENDER
   ========================================================================= */

function collectMapItems(actor) {
  if (!actor) return [];
  return (actor.items?.contents ?? actor.items ?? []).filter(isMapItem);
}

function render() {
  if (!panelEl) return;
  const actor = game?.user?.character ?? null;
  const maps  = collectMapItems(actor);

  // Drop a stale activeMapId if the item is gone; default to first map item.
  if (activeMapId && !maps.find(m => m.id === activeMapId)) activeMapId = null;
  if (!activeMapId && maps.length) activeMapId = maps[0].id;

  const active = maps.find(m => m.id === activeMapId) ?? null;
  const imgUrl = active ? getMapImage(active) : "";

  panelEl.innerHTML = `
    <button id="wou-map-close" type="button" aria-label="Close map" title="Close">
      <i class="fa-solid fa-chevron-up"></i>
    </button>

    <header class="wou-map-header">
      ${active ? `<span class="wou-map-title">${escapeText(active.name)}</span>` : ""}
    </header>

    <nav class="wou-map-toolbar">
      ${maps.length === 0
        ? `<div class="wou-map-toolbar-empty">— no map items —</div>`
        : maps.map(m => renderToolbarButton(m)).join("")}
    </nav>

    <section class="wou-map-canvas">
      ${active
        ? (imgUrl
            ? `<img class="wou-map-image" src="${escapeAttr(imgUrl)}" alt="${escapeAttr(active.name)}" draggable="false" />`
            : `<div class="wou-map-empty">${escapeText(active.name)} has no map image configured.<br><span class="dim">Set one via the item's cogwheel.</span></div>`)
        : `<div class="wou-map-empty">Select a map item from the toolbar.</div>`}
    </section>
  `;

  wireCloseButton();
  wireToolbar();
  wirePanZoom();
}

function renderToolbarButton(item) {
  const hasImg = item.img && !item.img.includes("mystery-man");
  const iconHTML = hasImg
    ? `<img src="${escapeAttr(item.img)}" alt="" draggable="false" />`
    : `<i class="fa-solid fa-map"></i>`;
  const active = item.id === activeMapId ? " is-active" : "";
  return `
    <button class="wou-map-tool${active}" data-map-id="${escapeAttr(item.id)}" title="${escapeAttr(item.name)}">
      ${iconHTML}
    </button>
  `;
}

function wireCloseButton() {
  panelEl.querySelector("#wou-map-close")?.addEventListener("click", () => setMapOpen(false));
}

function wireToolbar() {
  const bar = panelEl.querySelector(".wou-map-toolbar");
  if (!bar) return;
  bar.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".wou-map-tool");
    if (!btn) return;
    const id = btn.dataset.mapId;
    if (!id || id === activeMapId) return;
    activeMapId = id;
    resetView();          // fresh viewport per map
    render();
  });
}

/* =========================================================================
   PAN + ZOOM
   ========================================================================= */

function resetView() {
  mapView = { scale: 1, tx: 0, ty: 0 };
}

/** Clamp tx/ty so the transformed image always covers the canvas (no dark
 *  background showing).  When the scaled image is smaller than the canvas
 *  along an axis, that axis is recentered. */
function clampView() {
  const canvas = panelEl?.querySelector(".wou-map-canvas");
  const img    = panelEl?.querySelector(".wou-map-image");
  if (!canvas || !img) return;
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  const w  = img.offsetWidth;
  const h  = img.offsetHeight;
  if (!w || !h || !cw || !ch) return;

  /* The image is flex-centered in the canvas before transform.  Its un-
     transformed top-left is therefore offset by ((canvas - image) / 2).
     Transform origin is (0,0) of the image element, so after `translate +
     scale` the on-canvas top-left becomes (offset + t) and bottom-right
     (offset + t + size * scale). */
  const offX = (cw - w) / 2;
  const offY = (ch - h) / 2;
  const s    = mapView.scale;
  const imgW = w * s;
  const imgH = h * s;

  if (imgW <= cw) {
    /* Image narrower than canvas: lock to horizontal center. */
    mapView.tx = (cw - imgW) / 2 - offX;
  } else {
    const maxTx = -offX;
    const minTx = cw - imgW - offX;
    mapView.tx = Math.max(minTx, Math.min(maxTx, mapView.tx));
  }
  if (imgH <= ch) {
    mapView.ty = (ch - imgH) / 2 - offY;
  } else {
    const maxTy = -offY;
    const minTy = ch - imgH - offY;
    mapView.ty = Math.max(minTy, Math.min(maxTy, mapView.ty));
  }
}

function applyTransform() {
  const img = panelEl?.querySelector(".wou-map-image");
  if (!img) return;
  clampView();
  img.style.transformOrigin = "0 0";
  img.style.transform = `translate(${mapView.tx}px, ${mapView.ty}px) scale(${mapView.scale})`;
}

function wirePanZoom() {
  const canvas = panelEl.querySelector(".wou-map-canvas");
  const img    = panelEl.querySelector(".wou-map-image");
  if (!canvas || !img) return;

  applyTransform();
  /* The image may not be loaded yet — offsetWidth/Height are 0 until then,
     so clampView() early-returns and the transform stays uncentered.  Once
     the image's dimensions are available, re-apply to lock the centered
     starting position. */
  if (!img.complete) img.addEventListener("load", applyTransform, { once: true });

  // Wheel — zoom anchored on cursor.  Math: pick new scale, then adjust
  // translation so the world-point under the cursor stays under the cursor.
  canvas.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    const factor   = ev.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    const newScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, mapView.scale * factor));
    const ratio    = newScale / mapView.scale;
    mapView.tx = mx - (mx - mapView.tx) * ratio;
    mapView.ty = my - (my - mapView.ty) * ratio;
    mapView.scale = newScale;
    applyTransform();
  }, { passive: false });

  /* Drag — attach window mousemove ONLY while dragging.  Previously the
   * listener was always-on, so every cursor motion across the page fired
   * a handler that early-returned.  Now it's mounted on mousedown and
   * removed on mouseup, costing zero when no drag is in progress. */
  const onMouseMove = (ev) => {
    if (!_dragState) return;
    mapView.tx = _dragState.baseTx + (ev.clientX - _dragState.startX);
    mapView.ty = _dragState.baseTy + (ev.clientY - _dragState.startY);
    applyTransform();
  };
  const onMouseUp = () => {
    if (!_dragState) return;
    _dragState = null;
    panelEl?.querySelector(".wou-map-canvas")?.classList.remove("is-dragging");
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup",   onMouseUp);
  };

  canvas.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) return;             // left button only
    if (ev.target.closest(".wou-map-tool")) return; // clicks on tool buttons
    ev.preventDefault();
    _dragState = {
      startX: ev.clientX, startY: ev.clientY,
      baseTx: mapView.tx, baseTy: mapView.ty
    };
    canvas.classList.add("is-dragging");
    window.addEventListener("mousemove", onMouseMove, { passive: true });
    window.addEventListener("mouseup",   onMouseUp);
  });

  // Double-click resets the view.
  canvas.addEventListener("dblclick", (ev) => {
    ev.preventDefault();
    resetView();
    applyTransform();
  });
}

function syncTopbarTab(isOpen) {
  const tab = document.querySelector('#wou-top-bar [data-tab="map"]');
  if (!tab) return;
  if (isOpen) tab.classList.add("is-active");
  else        tab.classList.remove("is-active");
}

/* =========================================================================
   UTIL
   ========================================================================= */

function escapeAttr(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function escapeText(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
