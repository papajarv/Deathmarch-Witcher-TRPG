/**
 * Top bar — collapses from the top edge.  Mirrors the left/right pattern:
 *   - hidden by default (translateY off-screen)
 *   - hover the top-edge trigger zone → glow lights up
 *   - click the trigger → bar cascades down
 *   - integrated close button at the bottom edge collapses it back
 *
 * Brand icon shows a town glyph; the title binds to the current scene name
 * (updates on canvasReady and updateScene).
 */

import { registerCollapsible, setEntryOpen } from "./collapsibles.js";
import { toggleInventory } from "./inventory.js";
import { toggleJournal } from "./journal.js";
import { toggleCrafting } from "./crafting.js";
import { toggleCharacter } from "./character.js";
import { toggleMap } from "./map.js";
import { toggleBestiary } from "./bestiary.js";
import { wireSceneMenu } from "./scene-menu.js";
import { injectClinchBreakButton } from "./clinch-break.js";
import { getAssignedActor, VIEWER_OVERRIDE_HOOK } from "../lib/actor.js";
import { t, tFormat } from "../lib/i18n.js";

/* Inline SVG of a medieval town silhouette — a couple of pitched-roof
   houses flanking a central tower.  Currentcolor so it inherits .brand i. */
const TOWN_SVG = `
<svg class="brand-mark" viewBox="0 0 32 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M 2 23 L 2 14 L 7 9 L 12 14 L 12 23 Z" fill="currentColor"/>
  <rect x="5" y="17" width="2" height="3" fill="#0a0908"/>
  <path d="M 13 23 L 13 5 L 16 2 L 19 5 L 19 23 Z" fill="currentColor"/>
  <rect x="14.5" y="9" width="3" height="4" fill="#0a0908"/>
  <line x1="16" y1="2" x2="16" y2="0" stroke="currentColor" stroke-width="0.8"/>
  <path d="M 14.5 0 L 17.5 0 L 16 2 Z" fill="currentColor"/>
  <path d="M 20 23 L 20 13 L 25 9 L 30 13 L 30 23 Z" fill="currentColor"/>
  <rect x="23" y="16" width="2" height="3" fill="#0a0908"/>
</svg>`;

const HTML = () => `
<header id="wou-top-bar">
  <div class="wou-tb-row">
    <div class="brand">
      ${TOWN_SVG}
      <div class="brand-text">
        <span class="title" data-bind="scene-name">${t("WITCHER.Chrome.Topbar.Text.Witcher", "Witcher")}</span>
        <!-- Weather strip injected here by scripts/chrome/weather.js -->
      </div>
      <button type="button" id="wou-topbar-close" aria-label="${t("WITCHER.Chrome.Topbar.Text.Collapse", "Collapse")}" data-tooltip>
        <i class="fa-solid fa-chevron-up"></i>
      </button>
    </div>

    <nav class="tabnav">
      <button class="tab" data-tab="inventory"><i class="fa-solid fa-sack-dollar"></i><span>${t("WITCHER.Chrome.Topbar.Text.Inventory", "Inventory")}</span></button>
      <button class="tab" data-tab="journal"><i class="fa-solid fa-book-open"></i><span>${t("WITCHER.Chrome.Topbar.Text.Journal", "Journal")}</span></button>
      <button class="tab" data-tab="character"><i class="fa-solid fa-user-shield"></i><span>${t("WITCHER.Chrome.Topbar.Text.Character", "Character")}</span></button>
      <button class="tab" data-tab="bestiary"><i class="fa-solid fa-dragon"></i><span>${t("WITCHER.Chrome.Topbar.Text.Bestiary", "Bestiary")}</span></button>
      <button class="tab" data-tab="crafting"><i class="fa-solid fa-hammer"></i><span>${t("WITCHER.Chrome.Topbar.Text.Crafting", "Crafting")}</span></button>
      <button class="tab" data-tab="map"><i class="fa-solid fa-compass"></i><span>${t("WITCHER.Chrome.Topbar.Text.Map", "Map")}</span></button>
    </nav>

    <div class="hud">
      <!-- All seven Witcher TRPG currencies in a compact chip row.
           Single-letter labels (B/D/L/F/C/O/X) keep the footprint tight. -->
      <div class="coin">
        <i class="fa-solid fa-coins"></i>
        <span class="cur" data-currency="bizant"    title="${t("WITCHER.Chrome.Topbar.Text.Bizant", "Bizant")}"><em>B</em><span data-bind="cur-bizant">0</span></span>
        <span class="cur" data-currency="ducat"     title="${t("WITCHER.Chrome.Topbar.Text.Ducat", "Ducat")}"><em>D</em><span data-bind="cur-ducat">0</span></span>
        <span class="cur" data-currency="lintar"    title="${t("WITCHER.Chrome.Topbar.Text.Lintar", "Lintar")}"><em>L</em><span data-bind="cur-lintar">0</span></span>
        <span class="cur" data-currency="floren"    title="${t("WITCHER.Chrome.Topbar.Text.Floren", "Floren")}"><em>F</em><span data-bind="cur-floren">0</span></span>
        <span class="cur" data-currency="crown"     title="${t("WITCHER.Chrome.Topbar.Text.Crown", "Crown")}"><em>C</em><span data-bind="cur-crown">0</span></span>
        <span class="cur" data-currency="oren"      title="${t("WITCHER.Chrome.Topbar.Text.Oren", "Oren")}"><em>O</em><span data-bind="cur-oren">0</span></span>
      </div>
      <div class="weight" title="${t("WITCHER.Chrome.Topbar.Text.Encumbrance", "Encumbrance")}">
        <i class="fa-solid fa-weight-hanging"></i>
        <span data-bind="enc-cur">0</span><span class="enc-sep">/</span><span data-bind="enc-max">0</span>
      </div>
    </div>
  </div>
</header>
`;

const TRIGGER_HTML = `<div id="wou-top-trigger"></div><div id="wou-top-glow" aria-hidden="true"></div>`;

let topbarEl = null;

export function injectTopBar() {
  if (document.getElementById("wou-top-bar")) return;
  const host = document.getElementById("interface") || document.body;
  host.insertAdjacentHTML("afterbegin", HTML());
  topbarEl = document.getElementById("wou-top-bar");

  registerCollapsible(topbarEl, "top", {
    skipPeek: true,
    closeOnOutsideClick: false,   // stays open until the close button is clicked
    closeOnEsc: false,            // Esc is for closing dialogs/sheets, not the bar
    onOpen:  () => document.body.classList.add("wou-topbar-open"),
    onClose: () => {
      document.body.classList.remove("wou-topbar-open");
      /* Drop-down panels (inventory / journal / crafting) are conceptually
       * anchored to the top bar's tabs — when the bar collapses, the panels
       * shouldn't linger detached. Close any that are open. Dynamic imports
       * keep this from re-entering its sibling modules at load. */
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
      if (document.body.classList.contains("wou-map-open")) {
        import("./map.js").then(m => m.setMapOpen(false)).catch(() => {});
      }
      if (document.body.classList.contains("wou-bestiary-open")) {
        import("./bestiary.js").then(m => m.setBestiaryOpen(false)).catch(() => {});
      }
    }
  });

  // Top-edge trigger + glow (mirror of left/right pattern, rotated 90°).
  if (!document.getElementById("wou-top-trigger")) {
    document.body.insertAdjacentHTML("beforeend", TRIGGER_HTML);
    document.getElementById("wou-top-trigger")
      .addEventListener("click", () => setEntryOpen(topbarEl, true));
  }

  // Start expanded so the bar is visible by default; user collapses with
  // the chevron beside the scene name.
  setEntryOpen(topbarEl, true);

  // Bottom-center collapse hint.
  document.getElementById("wou-topbar-close")
    ?.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      setEntryOpen(topbarEl, false);
    });

  // Wire tab buttons.  Inventory toggles the inventory overlay; other tabs
  // are placeholders for future panels.
  topbarEl.querySelector('[data-tab="inventory"]')
    ?.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      toggleInventory();
    });

  topbarEl.querySelector('[data-tab="journal"]')
    ?.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      toggleJournal();
    });

  topbarEl.querySelector('[data-tab="crafting"]')
    ?.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      toggleCrafting();
    });

  topbarEl.querySelector('[data-tab="character"]')
    ?.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      toggleCharacter();
    });

  topbarEl.querySelector('[data-tab="bestiary"]')
    ?.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      toggleBestiary();
    });

  topbarEl.querySelector('[data-tab="map"]')
    ?.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      toggleMap();
    });

  // Initial bind + hook actor / scene changes.
  refreshSceneName();
  refreshActorBindings();
  /* GM scene menu — chevron next to the scene name. `wireSceneMenu`
   * self-gates on `game.user.isGM`, so no need to guard here. */
  wireSceneMenu();
  Hooks.on("canvasReady", () => { refreshSceneName(); scheduleRefreshActorBindings(); });
  Hooks.on("updateScene", refreshSceneName);
  /* Bind to the CURRENTLY VIEWED actor — for a player this equals
   * game.user.character, but for a GM using "View As" it's the
   * impersonated character. Old code gated on game.user.character
   * directly, so a GM viewing PlayerA's sheet never got a topbar
   * refresh when PlayerA edited themselves. VIEWER_OVERRIDE_HOOK
   * fires when the GM swaps the view target — refresh then too. */
  const viewedId = () => getAssignedActor()?.id;
  Hooks.on("updateUser",  (user)  => { if (user.id  === game.user.id)         scheduleRefreshActorBindings(); });
  Hooks.on("updateActor", (actor) => { if (actor.id === viewedId())           scheduleRefreshActorBindings(); });
  Hooks.on("updateItem",  (item)  => { if (item.parent?.id === viewedId())   scheduleRefreshActorBindings(); });
  Hooks.on("createItem",  (item)  => { if (item.parent?.id === viewedId())   scheduleRefreshActorBindings(); });
  Hooks.on("deleteItem",  (item)  => { if (item.parent?.id === viewedId())   scheduleRefreshActorBindings(); });
  Hooks.on(VIEWER_OVERRIDE_HOOK, () => scheduleRefreshActorBindings());

  /* Clinch "Break" control — floats just above the bar when the viewed
   * actor is in a clinch. Self-wires its own refresh hooks. */
  injectClinchBreakButton();

  return topbarEl;
}

function refreshSceneName() {
  const el = document.querySelector('#wou-top-bar [data-bind="scene-name"]');
  if (!el) return;
  const name = game?.scenes?.viewed?.name
            ?? game?.scenes?.current?.name
            ?? game?.world?.title
            ?? "Witcher";
  el.textContent = name;
}

const CURRENCY_KEYS = ["bizant", "ducat", "lintar", "floren", "crown", "oren"];

/**
 * Total carried weight using the same path the Witcher actor sheet uses
 * — sums each item's `system.calcWeight()` and adds coin weight via
 * `system.calcCurrencyWeight()` (each coin = 0.001 kg).  Falls back to a
 * manual sum for actor flavors that don't expose `getTotalWeight`.
 */
function computeCarriedWeight(actor) {
  if (!actor) return 0;
  if (typeof actor.getTotalWeight === "function") {
    return Number(actor.getTotalWeight()) || 0;
  }
  let total = 0;
  const items = actor.items?.contents ?? actor.items ?? [];
  for (const item of items) {
    const sys = item?.system ?? {};
    if (sys.isCarried === false) continue;
    /* Skip isStored items — their weight enters via the container's
       calcWeight (data/item/container.mjs). Routing top-level items
       through calcWeight() lets the container fold in its storedWeight
       aggregate. Raw quantity × weight was leaving contents out. */
    if (sys.isStored === true) continue;
    total += typeof sys.calcWeight === "function"
      ? Number(sys.calcWeight()) || 0
      : (Number(sys.quantity) || 0) * (Number(sys.weight) || 0);
  }
  if (typeof actor.system?.calcCurrencyWeight === "function") {
    total += Number(actor.system.calcCurrencyWeight()) || 0;
  }
  return Math.round(total * 100) / 100;
}

/** Coalesce: N hooks per tick → 1 refresh per animation frame. */
let _topbarRefreshPending = false;
function scheduleRefreshActorBindings() {
  if (_topbarRefreshPending) return;
  _topbarRefreshPending = true;
  requestAnimationFrame(() => {
    _topbarRefreshPending = false;
    refreshActorBindings();
  });
}

function refreshActorBindings() {
  const topbar = document.getElementById("wou-top-bar");
  if (!topbar) return;
  const actor = game?.user?.character ?? null;
  const setText = (sel, v) => {
    const el = topbar.querySelector(sel);
    if (el) el.textContent = String(v ?? 0);
  };

  // Currency — every key always rendered, defaults to 0 when no actor.
  const c = actor?.system?.currency ?? {};
  for (const k of CURRENCY_KEYS) setText(`[data-bind="cur-${k}"]`, Number(c[k]) || 0);

  // Encumbrance — `derivedStats.enc` is a flat number: the MAX carry
  // capacity (BODY × 10, p.47). It is NOT a {value, max} pool. Compute the
  // current carried weight ourselves by summing quantity*weight for items
  // that are marked `isCarried && !isStored`.
  const encMax = Number(actor?.system?.derivedStats?.enc) || 0;
  setText('[data-bind="enc-cur"]', computeCarriedWeight(actor));
  setText('[data-bind="enc-max"]', encMax);

  // Dim individual currency chips that are zero so the row reads as a
  // hierarchy (held → ink-bright, empty → ink-faint).
  const coinEl = topbar.querySelector('.coin');
  if (coinEl) {
    for (const k of CURRENCY_KEYS) {
      const chip = coinEl.querySelector(`[data-currency="${k}"]`);
      if (!chip) continue;
      const val = Number(c[k]) || 0;
      chip.classList.toggle("is-empty", val === 0);
    }
  }
}
