/**
 * Inventory overlay.
 *
 * Drops from the top bar to fill the space between top/left/right/bottom
 * chrome.  Wired to the topbar's `Inventory` tab — clicking it toggles the
 * overlay.
 *
 * Layout (matches /home/coder/shared/vladimir_mockup/inventory.html):
 *
 *   ┌─ Header ──────────────────────────────────────────────────────┐
 *   │  Containers rail (6 cols, scrolls down when overflowed)       │
 *   │  Tabs row (item categories)                                   │
 *   │  Item grid                                  · Right column ·  │
 *   │                                                Stats          │
 *   │                                                Weapons + Port │
 *   │                                                Armor          │
 *   └───────────────────────────────────────────────────────────────┘
 *
 * Data bindings:
 *   - actor = game.user.character
 *   - container rail   = "On Person" + actor.items of type "container"
 *                        + a dashed "Attach Mount" placeholder slot
 *   - "On Person" grid = items where isCarried && !isStored && !in any
 *                        container's `content` array
 *   - container grid   = items whose UUID appears in the active container's
 *                        `system.content` array
 *   - tab categories   = physical item types only (weapon, armor, enhancement,
 *                        alchemical, component, mutagen, diagrams, valuable,
 *                        note, mount); "All" shows every physical item
 *   - currency         = 7 editable fields bound to system.currency.*
 *   - encumbrance      = computed carried weight / derivedStats.enc (flat max)
 *   - weapons grid     = actor.items of type "weapon" where system.equipped
 *   - armor grid       = actor.items of type "armor"  where system.equipped
 *   - equip slot count = flag witcher-ttrpg-death-march:equipSlots.{weapons,armor}
 *                        (default 4 each)
 *
 * Click handlers:
 *   - container slot   → switch active container, re-render grid
 *   - tab              → switch active category, re-render grid
 *   - grid item        → equip if weapon/armor, else open item sheet
 *   - equipped slot    → unequip (toggle system.equipped=false)
 *   - empty equip slot → no-op for v1 (drag-drop is future work)
 *   - +/- buttons      → adjust slot count flag
 */

import { MODULE_ID } from "../setup/settings.js";
import { postNoteToScene } from "./parchments.js";
import { registerItemAction, buildItemActionEntries, installSheetContextMenuExtra, installSheetContextMenuOverride } from "./context-menu-item.js";
import { isBookCompleted } from "../sheets/valuable-study.js";
import { getAssignedActor, VIEWER_OVERRIDE_HOOK, isActorInActiveCombat } from "../lib/actor.js";
import { renderViewAsPicker, wireViewAsPicker } from "../lib/view-as.js";
import { describeDuration } from "./dock-statuses.js";
import {
  fitsInContainer, overflowWarning, getCapacityDisplay,
  hasSlotRows, buildSlotLayout, tilePlaceholderIcon, rowTooltip,
  totalSlots,
  getRail, setRailCount, setRailAssignment, isContainerRailed, railSlotOf,
} from "../lib/container.js";

/**
 * The actor sheet's own item context-menu builder methods (editItem,
 * equipMenuEntries, deleteItem, …) live on the WitcherActorSheet prototype.
 * The overlay reuses them so right-click in the chrome inventory opens the
 * same menu the actor sheet shows, with identical labels and conditions.
 *
 * Returns the sheet PROTOTYPE (the object carrying those methods) so the
 * caller can `Object.create` a lightweight helper that inherits them and
 * supplies its own `actor` accessor. Returns null before sheet classes are
 * registered.
 */
function getWitcherSheetProto() {
  const buckets = CONFIG.Actor?.sheetClasses ?? {};
  for (const subtype of Object.keys(buckets)) {
    for (const entry of Object.values(buckets[subtype] ?? {})) {
      let cls = entry?.cls;
      while (cls && cls.prototype) {
        if (typeof cls.prototype.equipMenuEntries === "function"
            || typeof cls.prototype.editItem === "function") {
          return cls.prototype;
        }
        cls = Object.getPrototypeOf(cls);
        if (!cls || cls === Function.prototype) break;
      }
    }
  }
  return null;
}

/**
 * Pull the `itemContextMenu` method from the patched actor sheet class.
 * Modules like witcher-food-and-drink monkey-patch this method on the sheet
 * prototype to inject extra entries (Pour Glass, Serve Piece).  Using the
 * patched version gets us the full menu the actor sheet shows.
 *
 * Falls back to null — caller should then use the base mixin import.
 */
function getPatchedItemContextMenu() {
  const buckets = CONFIG.Actor?.sheetClasses ?? {};
  for (const subtype of Object.keys(buckets)) {
    for (const entry of Object.values(buckets[subtype] ?? {})) {
      let cls = entry?.cls;
      while (cls && cls.prototype) {
        if (typeof cls.prototype.itemContextMenu === "function") {
          return cls.prototype.itemContextMenu;
        }
        cls = Object.getPrototypeOf(cls);
        if (!cls || cls === Function.prototype) break;
      }
    }
  }
  return null;
}

/* ---------- constants ---------- */

const CURRENCY_KEYS  = ["bizant", "ducat", "lintar", "floren", "crown", "oren"];
const CURRENCY_LABEL = { bizant: "B", ducat: "D", lintar: "L", floren: "F", crown: "C", oren: "O" };

/** "Parchment-flavored" items — letters/notes, diagrams/recipes, and the
 *  map / book valuable subtypes.  Maps and books are stored as `valuable`
 *  with `system.type === "map"` / `"book"` (see scripts/sheets/valuable-map.js).
 *  Match case-insensitively + ignore separator just in case different worlds
 *  have variants. */
function isParchmentLike(item) {
  if (!item) return false;
  if (item.type === "note" || item.type === "diagrams") return true;
  if (item.type === "valuable") {
    const sub = String(item.system?.type ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
    if (sub === "map")  return true;
    if (sub === "book") return true;
  }
  return false;
}

/** Food / drink — either a valuable whose system.type is the canonical
 *  "food-drink" slug (what witcher-food-and-drink uses), OR an item that
 *  has already been given charges by that module (back-compat for items
 *  configured before the slug check existed). Match the slug case-/
 *  separator-insensitively in case different worlds have stored variants. */
function isFoodOrDrink(item) {
  if (!item) return false;
  if (item.type === "food") return true;
  if (Number(item.flags?.["witcher-food-and-drink"]?.charges?.max) > 0) return true;
  if (item.type === "valuable") {
    const sub = String(item.system?.type ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
    if (sub === "food-drink") return true;
  }
  return false;
}

/** Valuables that AREN'T claimed by a more specific tab. Food-drink goes to
 *  the Food and Drink tab; map / book valuables go to Notes (via
 *  isParchmentLike). Without this carve-out those would show twice — once in
 *  their dedicated tab, once under Valuables. */
function isPlainValuable(item) {
  if (item?.type !== "valuable") return false;
  if (isFoodOrDrink(item)) return false;
  if (isParchmentLike(item)) return false;
  return true;
}

/** Tabs in display order.  `null` types = "All physical items".  Tabs
 *  may instead provide a `matches(item)` predicate for filters that
 *  don't map cleanly to item.type — e.g. Food and Drink is keyed off
 *  the witcher-food-and-drink charges flag rather than a base type, and
 *  Notes also pulls in map / book valuables. */
const INV_TABS = [
  { id: "all",         label: "All",            icon: "fa-asterisk",       types: null },
  { id: "weapon",      label: "Weapons",        icon: "fa-swords",         types: ["weapon", "ammo", "shield"] },
  { id: "armor",       label: "Armor",          icon: "fa-shield-halved",  types: ["armor"] },
  { id: "alchemical",  label: "Alchemy",        icon: "fa-flask",          types: ["alchemical"] },
  { id: "component",   label: "Components",     icon: "fa-leaf",           types: ["component"] },
  { id: "mutagen",     label: "Mutagens",       icon: "fa-vial",           types: ["mutagen"] },
  { id: "enhancement", label: "Enhancements",   icon: "fa-gem",            types: ["enhancement"] },
  { id: "die",         label: "Dice",           icon: "fa-dice",           types: ["die"] },
  { id: "valuable",    label: "Valuables",      icon: "fa-coins",          matches: isPlainValuable },
  { id: "notes",       label: "Notes",          icon: "fa-scroll",         matches: isParchmentLike },
  { id: "fooddrink",   label: "Food and Drink", icon: "fa-utensils",       matches: isFoodOrDrink },
  /* Bulk-storage containers (chests, sacks, etc.) — Equipment-Carry
   * containers are excluded; they live on the inventory rail instead.
   * See `collectGridItems` for the per-tab predicate. */
  { id: "container",   label: "Containers",     icon: "fa-box-archive",    types: ["container"] }
];

/** Predicate driving the "All" tab — true for any item that at least one
 *  other tab would surface. Robust to tabs that use `matches` predicates
 *  (Notes, Food and Drink) instead of plain `types` arrays, so notes /
 *  diagrams / flagged food items all appear under All. */
function isPhysicalItem(item) {
    for (const t of INV_TABS) {
        if (t.id === "all") continue;
        if (typeof t.matches === "function" && t.matches(item)) return true;
        if (t.types?.includes(item.type)) return true;
    }
    return false;
}

const DEFAULT_EQUIP_SLOTS = { weapons: 4, armor: 4 };

/* Per-tab sort preference, persisted on the character actor as
   flags.witcher-ttrpg-death-march.inventorySorts.{tabId} = sortKey. */
const INV_SORTS = [
  { id: "name",   label: "Name",     icon: "fa-arrow-down-a-z" },
  { id: "type",   label: "Type",     icon: "fa-shapes" },
  { id: "qty",    label: "Quantity", icon: "fa-layer-group" },
  { id: "weight", label: "Weight",   icon: "fa-weight-hanging" },
  { id: "value",  label: "Value",    icon: "fa-coins" },
  { id: "rarity", label: "Rarity",   icon: "fa-gem" }
];
const SORT_FLAG_PATH = "inventorySorts";
const DEFAULT_SORT   = "name";

/* Witcher (homebrew) > Rare > Poor > Common > Everywhere > (unset, last). */
const RARITY_ORDER = ["witcher", "rare", "poor", "common", "everywhere"];
function rarityRank(item) {
  const r = String(item?.system?.availability ?? "").toLowerCase();
  const idx = RARITY_ORDER.indexOf(r);
  return idx === -1 ? RARITY_ORDER.length : idx;
}

function getSortKey(actor, tabId) {
  const sorts = actor?.flags?.[MODULE_ID]?.[SORT_FLAG_PATH];
  return sorts?.[tabId] || DEFAULT_SORT;
}

function applySort(items, sortKey) {
  const arr = items.slice();
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" });
  switch (sortKey) {
    case "qty":
      arr.sort((a, b) => (Number(b.system?.quantity) || 0) - (Number(a.system?.quantity) || 0));
      break;
    case "weight":
      arr.sort((a, b) => (Number(b.system?.weight) || 0) - (Number(a.system?.weight) || 0));
      break;
    case "value":
      arr.sort((a, b) => (Number(b.system?.cost) || 0) - (Number(a.system?.cost) || 0));
      break;
    case "rarity":
      arr.sort((a, b) => rarityRank(a) - rarityRank(b));
      break;
    case "type":
      arr.sort((a, b) => {
        const ta = String(a.type || "").toLowerCase();
        const tb = String(b.type || "").toLowerCase();
        if (ta !== tb) return ta.localeCompare(tb);
        return byName(a, b);
      });
      break;
    case "name":
    default:
      arr.sort(byName);
      break;
  }
  return arr;
}

/* ---------- runtime state ---------- */

let invEl = null;

/** Coalesce render requests: many hook callbacks in the same tick collapse
 *  to a single render at the next animation frame.  Short-circuits when
 *  the overlay is collapsed — a closed inventory needn't rebuild. */
let _renderPending = false;
function scheduleRender() {
  if (_renderPending) return;
  if (!isInventoryOpen()) return;
  _renderPending = true;
  requestAnimationFrame(() => {
    _renderPending = false;
    if (!isInventoryOpen()) return;
    render();
  });
}
let activeTab           = "all";
let openContainerPopupId = null;   // null = no popup | container itemId = popup open
let openContainerActorId = null;   // null = character | else mount/linked actor id (for the open popup)
let inspectedItemId     = null;    // currently inspected item, drives the inspection panel
let popupAnchorId       = null;    // remember which rail slot to anchor the popup against
let mountPopupOpen      = false;   // true = the linked mount's inventory popup is open
let inspectionScrollTop = 0;       // scroll offset of the inspect panel, captured before re-render
let inspectionRenderedId = null;   // item id the inspect panel last rendered (restore scroll only if unchanged)
let hooksWired          = false;
let currentDragSource   = null;    // "grid" | "container:<id>" | "equip:<kind>" during a drag
let currentDragActorId  = null;    // id of the actor that *owned* the currently dragged item
let currentDragItemId   = null;    // id of the item currently being dragged (for drop pre-validation)

/* Flag key on the player character that stores the linked mount actor's id. */
const MOUNT_FLAG = "mountActorId";

/** Resolve the mount actor linked to a character (or null). */
function getMountActor(character) {
  if (!character) return null;
  const id = character.getFlag?.(MODULE_ID, MOUNT_FLAG);
  if (!id) return null;
  return game.actors?.get?.(id) ?? null;
}

const CHROME_SELECTORS = ["#wou-top-bar", "#wou-dock", "#scene-controls", "#sidebar"];
let _chromeResizeObs   = null;
let _chromeMutationObs = null;

/* =========================================================================
   PUBLIC API
   ========================================================================= */

export function injectInventoryOverlay() {
  if (document.getElementById("wou-inventory")) return;
  // Mount at body level (NOT inside #interface).  Foundry's #interface
  // forms a high z-index stacking context, which means anything inside
  // it — including this overlay — paints above body-level chrome triggers
  // and glows.  Body-level mount + z-index 9 gives the correct flat order:
  // canvas < inventory < chrome triggers/glow < chrome panels.
  const el = document.createElement("main");
  el.id = "wou-inventory";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "Inventory");
  document.body.appendChild(el);
  invEl = el;

  // Initial structure (re-rendered on every open + on data changes).
  render();

  // Wire the Witcher item context menu once.  ContextMenu uses event
  // delegation on invEl, so it survives innerHTML rebuilds inside.
  wireWitcherContextMenu();

  // Click the window background → deselect and return the inspect panel to
  // neutral.  Delegated on invEl (persists across innerHTML rebuilds).  Only
  // fires when the click lands DIRECTLY on a background surface — the panel
  // root, a section, or the grid backing — so clicking items, controls,
  // empty slot tiles, or the inspect panel never deselects.
  invEl.addEventListener("click", (ev) => {
    const t = ev.target;
    const isBackground = t === invEl || (typeof t.matches === "function" && t.matches(
      ".wou-inv-left, .wou-inv-right, .wou-inv-containers, .wou-inv-grid-wrap, .wou-inv-grid, .wou-inv-header"
    ));
    if (!isBackground) return;
    if (!inspectedItemId) return;
    inspectedItemId = null;
    refreshInspectionPanel();
  });

  // GM "View as" picker — re-render on selection change, and on any
  // viewer-override change fired by another tab.
  wireViewAsPicker(invEl, render);

  // Re-render on actor / item changes — listens for the player's character
  // AND for any linked mount actor (items moved on the mount affect our rail).
  if (!hooksWired) {
    const isRelevantActor = (a) => {
      const c = getAssignedActor();
      if (!c) return false;
      if (a?.id === c.id) return true;
      const m = getMountActor(c);
      return !!m && a?.id === m.id;
    };
    const ownsItem = (it) => isRelevantActor(it?.parent);
    // An effect on one of our items (e.g. an oil coating on a weapon) or on
    // the actor — drives the oil indicator + inspection panel refresh.
    const ownsEffect = (ae) => {
      const p = ae?.parent;
      return isRelevantActor(p) || isRelevantActor(p?.parent);
    };
    /* Coalesced re-render: every hook below requests a render via
     * `scheduleRender`, which dedupes multiple requests in the same
     * animation frame AND short-circuits when the overlay is collapsed
     * (no point rebuilding DOM the user can't see).  A flurry of N
     * item updates → at most 1 actual render per frame. */
    Hooks.on("updateUser",  (u) => { if (u.id  === game.user.id)         scheduleRender(); });
    Hooks.on("updateActor", (a) => { if (isRelevantActor(a))             scheduleRender(); });
    Hooks.on("createItem",  (i) => { if (ownsItem(i)) scheduleRender(); });
    Hooks.on("updateItem",  (i) => { if (ownsItem(i)) scheduleRender(); });
    Hooks.on("deleteItem",  (i) => { if (ownsItem(i)) scheduleRender(); });
    Hooks.on("createActiveEffect", (ae) => { if (ownsEffect(ae)) { invalidateRenderSig(); scheduleRender(); } });
    Hooks.on("updateActiveEffect", (ae) => { if (ownsEffect(ae)) { invalidateRenderSig(); scheduleRender(); } });
    Hooks.on("deleteActiveEffect", (ae) => { if (ownsEffect(ae)) { invalidateRenderSig(); scheduleRender(); } });
    Hooks.on(VIEWER_OVERRIDE_HOOK, scheduleRender);
    /* Oil timers read wall-clock out of combat and rounds in combat, and tick
     * down as time passes.  The real-time clock fires updateWorldTime ~once a
     * second; full-rebuilding then flickered the grid + inspect frame, so the
     * per-second countdown is patched in place (tickOilLabels) instead.  Combat
     * transitions flip the label wall-clock⇄rounds and are rare, so those still
     * do a real rebuild to re-derive every tile. */
    Hooks.on("updateWorldTime", tickOilLabels);
    Hooks.on("createCombat",    scheduleRender);
    Hooks.on("deleteCombat",    scheduleRender);
    Hooks.on("updateCombat",    scheduleRender);
    Hooks.on("combatStart",     scheduleRender);
    Hooks.on("combatTurn",      scheduleRender);
    Hooks.on("combatRound",     scheduleRender);
    window.addEventListener("resize", positionBounds, { passive: true });
    wireChromeObservers();
    hooksWired = true;
  }

  // Close is via the chevron-up button at top center only — no Esc, no
  // click-outside.  The overlay stays open until the user explicitly
  // collapses it (or toggles the topbar Inventory tab).
}

/** Toggle the overlay on/off.  Called by topbar.js when the "Inventory" tab
 *  is clicked. */
export function toggleInventory() {
  if (!invEl) injectInventoryOverlay();
  const willOpen = !invEl.classList.contains("is-open");
  setInventoryOpen(willOpen);
}

export function setInventoryOpen(open) {
  if (!invEl) injectInventoryOverlay();
  if (open) {
    /* One drop-down panel open at a time — close siblings if they're open.
     * Mirrors crafting.js / journal.js sibling-close pattern; without this
     * inventory opening would stack on top of an already-open journal or
     * crafting panel. */
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
    positionBounds();
    render();   // fresh data each open
    invEl.classList.add("is-open");
    document.body.classList.add("wou-inventory-open");
    syncTopbarTab(true);
  } else {
    invEl.classList.remove("is-open");
    document.body.classList.remove("wou-inventory-open");
    syncTopbarTab(false);
  }
}

export function isInventoryOpen() {
  return !!invEl?.classList.contains("is-open");
}

/**
 * Public API entry: open the inventory (if closed) and pop open the
 * container with the given item id, anchored to its rail slot.
 *
 * Used by hotbar macros generated for container items — clicking the
 * macro should land the popup at the container's rail position, not as a
 * floating item sheet near the hotbar.
 */
export async function openContainer(containerId) {
  if (!invEl) injectInventoryOverlay();
  if (!isInventoryOpen()) setInventoryOpen(true);
  /* Resolve which actor owns this container — falls back to the character
   * if the id isn't found on the linked mount.  Macros generated by the
   * hotbar drop hook always belong to the character, but it doesn't hurt
   * to check the mount too. */
  const character = getAssignedActor();
  const mount     = getMountActor(character);
  let ownerId = null;
  if (character?.items?.get(containerId))   ownerId = null;            /* character */
  else if (mount?.items?.get(containerId))  ownerId = mount.id;        /* mount */
  openContainerPopupId = containerId;
  openContainerActorId = ownerId;
  popupAnchorId        = containerId;
  render();
  // Wait one frame so the rail slot exists in the new DOM, then anchor.
  requestAnimationFrame(() => positionContainerPopup());
}

/* =========================================================================
   FLOATING CONTAINER POPUP — when triggered from our hotbar (or anywhere
   else that's not the inventory rail), open the container as a standalone
   body-level popup pinned over the calling element instead of opening the
   whole inventory overlay.
   ========================================================================= */

let _floatPopupEl = null;
let _floatOutsideHandler = null;
let _floatContainerId = null;

export function openContainerFloating(containerId, anchorEl) {
  /* Toggle: clicking the same hotbar slot while its popup is already
   * showing closes the popup instead of re-opening fresh.  Compare BEFORE
   * tearing down so the id is still set. */
  if (_floatPopupEl && _floatContainerId === containerId) {
    closeFloatingContainer();
    return;
  }
  closeFloatingContainer();
  _floatContainerId = containerId;
  const character = getAssignedActor();
  const mount     = getMountActor(character);
  let owner = null;
  if (character?.items?.get(containerId))      owner = character;
  else if (mount?.items?.get(containerId))     owner = mount;
  if (!owner) return;
  const container = owner.items.get(containerId);
  if (!container) return;

  const items = resolveContainerContents(owner, container);
  const isMount = owner.id !== character?.id;
  const cap = getCapacityDisplay(container);
  const weightHTML = buildCapacityChipsHTML(cap);
  const slotRenderer = isMount ? mountItemSlotHTML : itemSlotHTML;
  let body;
  if (hasSlotRows(container)) {
    const tiles = buildSlotLayout(container);
    const cols  = Math.min(5, Math.max(1, Math.ceil(Math.sqrt(totalSlots(container)))));
    body = `<div class="wou-popup-grid is-slots" style="grid-template-columns: repeat(${cols}, 50px)">${tiles.map(slotTileHTML).join("")}</div>`;
  } else {
    body = items.length === 0
      ? `<div class="wou-empty-state">— Empty —</div>`
      : `<div class="wou-popup-grid">${items.map(slotRenderer).join("")}</div>`;
  }

  const wrap = document.createElement("div");
  wrap.id = "wou-floating-container";
  wrap.className = "wou-container-popup" + (isMount ? " is-mount" : "");
  wrap.innerHTML = `
    <div class="wou-popup-header">
      <span class="wou-popup-title">${escapeText(container.name)}</span>
      ${weightHTML}
      <button type="button" class="wou-popup-close" aria-label="Close container">
        <i class="fa-solid fa-xmark"></i>
      </button>
    </div>
    <div class="wou-popup-body">${body}</div>
  `;
  document.body.appendChild(wrap);
  _floatPopupEl = wrap;
  positionFloatingContainer(anchorEl);

  // Mount popups omit the `.item` class on their slots (drag-only), so the
  // ContextMenu selector won't match — skip wiring there. For normal
  // containers, items use `.item` (see itemSlotHTML) and need the full
  // right-click menu (Consume, Pour Glass, Apply Oil, Delete, …).
  if (!isMount) wireFloatingPopupContextMenu(wrap);

  wrap.querySelector(".wou-popup-close")?.addEventListener("click", closeFloatingContainer);

  /* Click an item → open its sheet (no grid to drag to in floating mode). */
  wrap.addEventListener("click", (ev) => {
    if (ev.target.closest(".wou-popup-close")) return;
    const slot = ev.target.closest(".wou-slot");
    if (!slot) return;
    const it = owner.items.get(slot.dataset.itemId);
    it?.sheet?.render?.(true);
  });

  /* Items in the floating popup are draggable into the inventory UI
   * (grid, equip slots, or any container rail slot). Source tag is
   * `container:<id>` so the receiving drop handler removes the item
   * from this container's content array via removeItemFromSource. */
  wrap.addEventListener("dragstart", (ev) => {
    const slot = ev.target.closest(".wou-slot");
    if (!slot) return;
    const id = slot.dataset.itemId;
    if (!id) return;
    const it = owner.items.get(id);
    if (!it) return;
    currentDragSource  = `container:${containerId}`;
    currentDragActorId = owner.id;
    currentDragItemId  = id;
    ev.dataTransfer.setData("application/x-wou-item", id);
    ev.dataTransfer.setData("application/x-wou-source", currentDragSource);
    ev.dataTransfer.setData("application/x-wou-source-actor", owner.id);
    if (ev.ctrlKey || ev.metaKey) ev.dataTransfer.setData("application/x-wou-split", "one");
    else if (ev.shiftKey) ev.dataTransfer.setData("application/x-wou-split", "half");
    ev.dataTransfer.setData("text/plain", JSON.stringify({ type: "Item", uuid: it.uuid }));
    ev.dataTransfer.effectAllowed = "copyMove";
    slot.classList.add("is-dragging");
  });
  wrap.addEventListener("dragend", (ev) => {
    ev.target.closest(".wou-slot")?.classList.remove("is-dragging");
    currentDragSource = null;
    currentDragActorId = null;
    currentDragItemId = null;
  });

  /* Close on outside click (next tick so the click that opened us doesn't
   * immediately close it). */
  _floatOutsideHandler = (ev) => {
    if (!_floatPopupEl) return;
    if (_floatPopupEl.contains(ev.target)) return;
    if (anchorEl?.contains?.(ev.target)) return;
    closeFloatingContainer();
  };
  setTimeout(() => document.addEventListener("mousedown", _floatOutsideHandler), 0);
}

function closeFloatingContainer() {
  if (_floatOutsideHandler) {
    document.removeEventListener("mousedown", _floatOutsideHandler);
    _floatOutsideHandler = null;
  }
  if (_floatPopupEl) {
    _floatPopupEl.remove();
    _floatPopupEl = null;
  }
  _floatContainerId = null;
}

function positionFloatingContainer(anchorEl) {
  if (!_floatPopupEl) return;
  const W = window.innerWidth;
  const H = window.innerHeight;
  const popupW = 280;
  /* Force a layout read to get the real height — the rendered popup may be
   * taller than the 320px fallback when many items are inside. */
  const popupH = _floatPopupEl.getBoundingClientRect().height || 320;

  let left, top;
  if (anchorEl?.getBoundingClientRect) {
    const r = anchorEl.getBoundingClientRect();
    /* Center horizontally over the anchor (hotbar slot), clamp to viewport. */
    left = Math.max(8, Math.min(W - popupW - 8, r.left + r.width / 2 - popupW / 2));
    /* Float ABOVE the anchor (hotbar lives at the bottom of the screen).
     * Fall back to below if there isn't enough room above. */
    top = r.top - popupH - 8;
    if (top < 8) top = Math.min(H - popupH - 8, r.bottom + 8);
  } else {
    /* No anchor — center on the lower half of the screen. */
    left = (W - popupW) / 2;
    top  = (H - popupH) - 160;
  }
  _floatPopupEl.style.position = "fixed";
  _floatPopupEl.style.zIndex   = "9070";   /* above dock (9050) */
  _floatPopupEl.style.left     = `${left}px`;
  _floatPopupEl.style.top      = `${top}px`;
}

/* =========================================================================
   POSITIONING — measure chrome edges and pin overlay between them
   ========================================================================= */

/**
 * Position the overlay between the four chrome edges.
 *
 * We use body classes (`wou-topbar-open`, `wou-controls-open`,
 * `wou-sidebar-open`) as the source of truth for whether each collapsible
 * panel is OPEN — these flip atomically when the user toggles a bar.
 * Measuring rects during the transform-based collapse transition was
 * fragile (intermediate values, Foundry re-renders mid-transition causing
 * the leftbar to look temporarily expanded again), causing the inventory
 * to snap then snap back.  Body-class truth bypasses that entirely.
 *
 * Also publishes `--inv-close-x` so the chevron-up close button can be
 * pinned directly under the topbar's Inventory tab.
 */
function positionBounds() {
  if (!invEl) return;
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
  const bottom =  dock                  ? Math.max(0, H - dock.getBoundingClientRect().top)  : 0;
  const left   = (leftOpen   && leftbar)? Math.max(0, leftbar.getBoundingClientRect().right) : 0;
  const right  = (rightOpen  && sidebar)? Math.max(0, W - sidebar.getBoundingClientRect().left) : 0;

  invEl.style.top    = `${top}px`;
  invEl.style.bottom = `${bottom}px`;
  invEl.style.left   = `${left}px`;
  invEl.style.right  = `${right}px`;

  // Pin the close-arrow X to the center of the topbar Inventory tab.
  // Stored as a CSS variable on invEl so styles can `left: var(--inv-close-x)`
  // relative to the overlay's own origin (which is offset by `left`).
  const tab = document.querySelector('#wou-top-bar [data-tab="inventory"]');
  if (tab) {
    const tabRect = tab.getBoundingClientRect();
    const tabCenterX = tabRect.left + tabRect.width / 2;
    invEl.style.setProperty("--inv-close-x", `${tabCenterX - left}px`);
  }
}

/* =========================================================================
   RENDER
   ========================================================================= */

/** Cheap fingerprint of every datum the render reads.  If two calls in
 *  a row yield the same sig the entire innerHTML rewrite + listener
 *  re-wire is skipped — the visible DOM already reflects this state.
 *
 *  Keep this in sync with what renderHTML actually consumes: actor
 *  identity, currency, derived stats, equip slots, rail, all item
 *  fields the tiles read, plus the live UI state (tab, sort, popup,
 *  inspected item, viewer override). */
function computeRenderSig(actor) {
  if (!actor) return "no-actor";
  const parts = [
    `a:${actor.id}:${actor.name}:${actor.img}`,
    `tab:${activeTab}:${getSortKey(actor, activeTab)}`,
    `pop:${openContainerPopupId ?? ""}:${openContainerActorId ?? ""}`,
    `mpop:${mountPopupOpen ? 1 : 0}`,
    `insp:${inspectedItemId ?? ""}`,
  ];
  const c = actor.system?.currency ?? {};
  parts.push(`cur:${Object.keys(c).sort().map(k => `${k}=${c[k]}`).join(",")}`);
  const ds = actor.system?.derivedStats ?? {};
  parts.push(`d:${ds.enc?.value}/${ds.enc?.max};${ds.hp?.value}/${ds.hp?.max};${ds.sta?.value}/${ds.sta?.max}`);
  parts.push(`eq:${getEquipSlotCount(actor, "armor")}`);
  const rail = getRail(actor);
  parts.push(`rail:${rail.count}:${rail.assignments.join(",")}`);

  for (const it of actor.items) {
    const s = it.system ?? {};
    /* Only the fields the inventory tiles actually display.  Adding a
     * field here is the cost of avoiding a stale-render bug; missing
     * one means the UI won't refresh after that field changes. */
    parts.push(
      `i:${it.id}:${it.name}:${it.type}:${it.img}` +
      `:${s.quantity ?? 0}:${s.weight ?? 0}:${s.equipped ? 1 : 0}` +
      `:${s.isStored ? 1 : 0}:${s.isCarried === false ? 0 : 1}` +
      `:${s.hands ?? ""}:${s.slot ?? ""}:${s.quick ? 1 : 0}:${s.availability ?? ""}` +
      `:${s.substanceType ?? ""}` +
      `:${(it.effects?.size ?? it.effects?.length ?? 0)}`
    );
    /* NOTE: the applied-oil duration label is deliberately NOT folded into the
     * sig.  It ticks every second, and folding it in forced a full rebuild per
     * tick (grid + inspect-frame flicker).  The countdown is now patched in
     * place by tickOilLabels on updateWorldTime; structural oil changes
     * (applied / expired / cleansed) move through the effect create/delete
     * hooks and the `effects.size` term above, which DO rebuild. */
  }

  const mount = getMountActor(actor);
  if (mount) {
    parts.push(`m:${mount.id}:${mount.name}`);
    for (const it of mount.items) {
      const s = it.system ?? {};
      parts.push(`mi:${it.id}:${it.name}:${it.type}:${s.quantity ?? 0}:${s.isStored ? 1 : 0}`);
    }
  }
  return parts.join("|");
}

let _lastRenderSig = null;
/** Force the next render to bypass the sig-skip — call after any
 *  mutation outside the sig's coverage (drag-drop side effects, etc.). */
function invalidateRenderSig() { _lastRenderSig = null; }

function render() {
  if (!invEl) return;
  /* Honor the GM view-as override (lib/actor.js); falls back to the user's
   * own assigned character for players. */
  const actor = getAssignedActor();

  const sig = computeRenderSig(actor);
  if (sig === _lastRenderSig) return;
  _lastRenderSig = sig;

  /* Capture the inspect panel's scroll before the rewrite destroys it, so
   * refreshInspectionPanel can restore it (drag/drop re-renders shouldn't
   * jump the reader back to the top of the same item). */
  const oldInsp = invEl.querySelector("[data-inspection]");
  inspectionScrollTop = oldInsp ? oldInsp.scrollTop : 0;

  invEl.innerHTML = renderHTML(actor);
  injectBookCompletionBadges(actor);

  // Wire interactions (delegated handlers wired here so a fresh innerHTML
  // doesn't strand listeners).  Context menu is wired ONCE in
  // injectInventoryOverlay because Foundry's ContextMenu attaches its
  // listener to invEl and uses event delegation.
  wireCloseButton();
  wireContainerRail(actor);
  wireContainerPopup(actor);
  wireMountPopup(actor);
  wireTabs();
  wireSortControl(actor);
  wireItemGrid(actor);
  wireCurrencyInputs(actor);
  wireEquipSlots(actor);
  wireEquipDrops(actor);
  wireEquipControls(actor);
  wireSwitchHands(actor);
  refreshInspectionPanel();   // async, fire and forget
  // The popup's DOM is rebuilt on every render — re-anchor it to its
  // original rail slot so it doesn't snap to {top:0, left:0}.
  if (openContainerPopupId) positionContainerPopup();
  if (mountPopupOpen) positionMountPopup();
}

function wireCloseButton() {
  invEl.querySelector("#wou-inv-close")?.addEventListener("click", () => {
    setInventoryOpen(false);
  });
}

/**
 * Render the system's item-description partial into the inspection panel.
 * This is the same Handlebars template the system uses for chat cards, so
 * the rendered content matches whatever the actor sheet shows for an item
 * (description, type-specific tags, crafting components, etc.).
 *
 * Async because renderTemplate is async — fired-and-forget from render().
 */
async function refreshInspectionPanel() {
  const panel = invEl?.querySelector("[data-inspection]");
  if (!panel) return;
  const actor = getAssignedActor();
  const item  = inspectedItemId ? actor?.items?.get(inspectedItemId) : null;
  if (!item) {
    panel.innerHTML = `<div class="wou-inspection-empty">Select an item to inspect</div>`;
    panel.removeAttribute("data-rarity");
    inspectionRenderedId = null;
    return;
  }
  panel.dataset.rarity = String(item.system?.availability ?? "").toLowerCase();
  /* Same item still showing → keep the reader's scroll position across the
   * re-render; a different item resets to the top. */
  const keepScroll = item.id === inspectionRenderedId;
  try {
    const renderTemplate = foundry?.applications?.handlebars?.renderTemplate
                        ?? window.renderTemplate;
    const rawItem = item.toObject?.() ?? item;
    // The template renders {{component.img}} but craftingComponents only stores
    // { id, name, quantity, uuid } — no img.  Resolve each UUID so the template
    // gets the actual image, mirroring what WitcherDiagramSheet does.
    if (rawItem.system?.craftingComponents?.length) {
      rawItem.system.craftingComponents = rawItem.system.craftingComponents.map(c => {
        if (!c.uuid || c.img) return c;
        try {
          const resolved = fromUuidSync?.(c.uuid);
          return resolved ? { ...c, img: resolved.img ?? c.img } : c;
        } catch { return c; }
      });
    }
    // Build the weapon / armor quality lists (label + description) so
    // the template can render hover-tooltipped tag chips that match the
    // item sheets' display views.
    let weaponQualityList = [];
    let armorQualityList  = [];
    let armorMeta         = null;
    let alchemyMeta       = null;
    let componentMeta     = null;
    let containerMeta     = null;
    let mutagenMeta       = null;
    let diagramMeta       = null;
    let bookMeta          = null;
    let remainsState      = null;
    let descriptionHtml   = "";
    let effectiveMeta       = null;
    let enhancementSlots    = [];
    let socketedQualityList = [];
    try {
      const cfgMod = await import("/systems/witcher-ttrpg-death-march/module/setup/config.mjs");

      // Generic catalog-driven label folder — shared by weapon + armor.
      const buildQualityList = (entries, catalog, defaults, values) => entries
        .map(key => {
          const entry = catalog[key] ?? defaults[key];
          if (!entry) return null;
          const param = entry.param ?? defaults[key]?.param ?? null;
          let label = entry.label;
          if (param) {
            const v = values[key];
            if (v != null && String(v).trim().length) {
              label = `${entry.label}(${String(v).trim()}${param.suffix ?? ""})`;
            }
          }
          return { key, label, description: entry.description };
        })
        .filter(Boolean);

      if ((item.type === "weapon" || item.type === "ammo") && Array.isArray(rawItem.system?.qualities)) {
        const catalog  = cfgMod.getActiveWeaponQualities?.() ?? cfgMod.WEAPON_QUALITIES ?? {};
        const defaults = cfgMod.WEAPON_QUALITIES ?? {};
        const values   = rawItem.system?.qualityValues ?? {};
        weaponQualityList = buildQualityList(rawItem.system.qualities, catalog, defaults, values);
      }

      if (item.type === "armor") {
        const catalog  = cfgMod.getActiveArmorQualities?.() ?? cfgMod.ARMOR_QUALITIES ?? {};
        const defaults = cfgMod.ARMOR_QUALITIES ?? {};
        const values   = rawItem.system?.qualityValues ?? {};
        armorQualityList = buildQualityList(rawItem.system?.qualities ?? [], catalog, defaults, values);

        // Compute the armor hero / coverage subline using the same
        // logic as WitcherArmorSheet._prepareContext. Duplicated here
        // because the chrome doesn't go through the sheet pipeline.
        const LOC_LABELS = {
          head: "Head", torso: "Torso",
          leftArm: "Left Arm", rightArm: "Right Arm",
          leftLeg: "Left Leg", rightLeg: "Right Leg"
        };
        const LOC_KEYS = Object.keys(LOC_LABELS);
        const buildRow = (k) => ({
          key:   k,
          label: LOC_LABELS[k],
          value: Number(rawItem.system?.[`${k}Stopping`])    || 0,
          max:   Number(rawItem.system?.[`${k}MaxStopping`]) || 0
        });
        const isShield = rawItem.system?.armorType === "shield";
        if (isShield) {
          armorMeta = {
            primarySP:        Number(rawItem.system?.reliability?.value) || 0,
            primarySPMax:     Number(rawItem.system?.reliability?.max)   || 0,
            primaryStatLabel: "BLOCKS",
            coverageLabel:    "Shield",
            isShield:         true
          };
        } else {
          const allRows = LOC_KEYS.map(buildRow).filter(r => r.max > 0);
          const sorted  = [...allRows].sort((a, b) => b.value - a.value);
          const chosen  = sorted[0];
          armorMeta = {
            primarySP:        chosen?.value ?? 0,
            primarySPMax:     chosen?.max   ?? 0,
            primaryStatLabel: "STOPPING POWER",
            coverageLabel:    allRows.map(r => r.label).join(" · "),
            isShield:         false
          };
        }
      }

      if (item.type === "weapon" || item.type === "armor") {
        // Socketed enhancements + effective (enhanced) stats. The live
        // `item` carries `system.effective` (derived); `rawItem` (source)
        // does not, so the meta is computed here from the live document.
        const isW = item.type === "weapon";
        effectiveMeta = item.system?.effective ?? null;
        const slotField = isW ? "weaponEnhancement" : "armorEnhancement";
        const applied   = item.system?.appliedEnhancements ?? [];
        const count = Math.max(Number(item.system?.[slotField]) || 0, applied.length);
        for (let i = 0; i < count; i++) {
          const ref = applied[i];
          if (ref?.uuid) {
            let name = ref.name, img = ref.img;
            try { const d = fromUuidSync(ref.uuid); if (d) { name = d.name; img = d.img; } } catch (_) { /* unresolved */ }
            enhancementSlots.push({ filled: true, name: name || ref.name || "?", img: img || ref.img || "icons/svg/upgrade.svg" });
          } else {
            enhancementSlots.push({ filled: false });
          }
        }
        const catalog  = isW ? (cfgMod.getActiveWeaponQualities?.() ?? cfgMod.WEAPON_QUALITIES ?? {})
                             : (cfgMod.getActiveArmorQualities?.()  ?? cfgMod.ARMOR_QUALITIES  ?? {});
        const defaults = isW ? (cfgMod.WEAPON_QUALITIES ?? {}) : (cfgMod.ARMOR_QUALITIES ?? {});
        const baseQ    = new Set(rawItem.system?.qualities ?? []);
        const effVals  = effectiveMeta?.qualityValues ?? rawItem.system?.qualityValues ?? {};
        socketedQualityList = buildQualityList(
          (effectiveMeta?.qualities ?? []).filter(k => !baseQ.has(k)),
          catalog, defaults, effVals
        );
        if (!isW && effectiveMeta) {
          const addedRes = [];
          if (effectiveMeta.slashing    && !rawItem.system?.slashing)    addedRes.push("Slashing");
          if (effectiveMeta.piercing    && !rawItem.system?.piercing)    addedRes.push("Piercing");
          if (effectiveMeta.bludgeoning && !rawItem.system?.bludgeoning) addedRes.push("Bludgeoning");
          effectiveMeta.addedResistances = addedRes;
        }
      }

      if (item.type === "alchemical") {
        // Mirror WitcherAlchemicalSheet._prepareContext — type-driven hero.
        const sys  = rawItem.system ?? {};
        const type = sys.type ?? "potion";
        const types = cfgMod.ALCHEMICAL_TYPES ?? CONFIG?.WITCHER?.alchemical?.types ?? {};
        const dmgTypes = cfgMod.DAMAGE_TYPES ?? CONFIG?.WITCHER?.damageTypes ?? {};
        const loc = (k, fb) => (k && game.i18n?.localize ? game.i18n.localize(k) : (fb ?? k));
        const isBomb      = type === "bomb";
        const hasToxicity = type === "potion" || type === "decoction";
        const typeLabel   = loc(types[type], type);
        let heroValue, heroLabel, heroSub = "";
        if (isBomb) {
          heroValue = sys.damage || "—";
          heroLabel = "DAMAGE";
          heroSub   = sys.damageType ? loc(dmgTypes[sys.damageType], sys.damageType) : "";
        } else if (hasToxicity) {
          heroValue = sys.toxicity ?? 0;
          heroLabel = "TOXICITY";
          heroSub   = sys.duration || "";
        } else {
          heroValue = sys.duration || typeLabel;
          heroLabel = sys.duration ? "DURATION" : "TYPE";
        }
        alchemyMeta = { isBomb, hasToxicity, typeLabel, heroValue, heroLabel, heroSub };
      }

      if (item.type === "component") {
        // Mirror WitcherComponentSheet._prepareContext — substance hero when
        // the component yields one of the nine substances, else availability.
        const sys  = rawItem.system ?? {};
        const subs  = cfgMod.SUBSTANCES ?? CONFIG?.WITCHER?.alchemical?.substances ?? {};
        const art   = cfgMod.SUBSTANCE_ART ?? CONFIG?.WITCHER?.alchemical?.substanceArt ?? {};
        const loc = (k, fb) => (k && game.i18n?.localize ? game.i18n.localize(k) : (fb ?? k));
        const subKey   = (sys.substanceType ?? "").trim();
        const isSubstance = !!sys.isSubstance;
        const hasHero = isSubstance && !!subKey;
        componentMeta = {
          isSubstance,
          hasHero,
          substanceKey:  hasHero ? subKey : "",
          substanceName: hasHero ? loc(subs[subKey], subKey) : "",
          substanceArt:  hasHero ? (art[subKey] ?? "") : ""
        };
      }

      if (item.type === "mutagen") {
        // Mirror WitcherMutagenSheet — the "Effect" is the mutagen's Active-
        // Effect modifiers (e.g. "+3 Melee"), the same list its sheet shows.
        let mods = [];
        try {
          const sheetMod = await import("/systems/witcher-ttrpg-death-march/module/sheets/item/base.mjs");
          mods = sheetMod.summarizeEffectModifiers?.(item) ?? [];
        } catch (_) { /* helper unavailable — skip the effect rows */ }
        const t = String(rawItem.system?.type ?? "");
        mutagenMeta = {
          typeLabel: t ? t.charAt(0).toUpperCase() + t.slice(1) : "",
          modifiers: mods
        };
      }

      if (item.type === "container") {
        // Mirror WitcherContainerSheet._prepareContext — stored / capacity
        // (kg) hero with a fill bar, computed live from the resolved contents.
        const sys = rawItem.system ?? {};
        const content = item.system?.content ?? [];
        let stored = 0;
        if (typeof fromUuidSync === "function") {
          for (const ref of content) {
            const inner = fromUuidSync(ref);
            if (!inner) continue;
            stored += (Number(inner.system?.weight) || 0) * (Number(inner.system?.quantity) || 1);
          }
        } else {
          stored = Number(sys.storedWeight) || 0;
        }
        const capacity = Number(sys.carry) || 0;
        containerMeta = {
          capacity,
          storedWeight: Math.round(stored * 100) / 100,
          contentCount: content.length,
          hasCapacity: capacity > 0,
          isOver: capacity > 0 && stored > capacity,
          fillPct: capacity > 0 ? Math.min(100, Math.round((stored / capacity) * 100)) : 0
        };
      }

      if (item.type === "diagrams") {
        // Mirror WitcherDiagramsSheet._prepareContext — the hero is the
        // single craft DC (Alchemy for formulae, Crafting for diagrams),
        // plus a produced-item preview, ingredient list, and (formulae)
        // required substances.
        const sys = rawItem.system ?? {};
        const loc = (k, fb) => (k && game.i18n?.localize ? game.i18n.localize(k) : (fb ?? k));
        const isFormulae = !!sys.isFormulae;

        const levels = cfgMod.DIAGRAM_LEVELS ?? CONFIG?.WITCHER?.crafting?.levels ?? {};
        const subMap = isFormulae
          ? (cfgMod.FORMULA_SUBTYPES ?? CONFIG?.WITCHER?.crafting?.formulaSubtypes ?? {})
          : (cfgMod.DIAGRAM_SUBTYPES ?? CONFIG?.WITCHER?.crafting?.diagramSubtypes ?? {});

        // Produced item — prefer the live document image over the cache.
        const assoc = sys.associatedItem ?? {};
        let outImg = assoc.img || "";
        if (assoc.uuid && typeof fromUuidSync === "function") {
          try { const d = fromUuidSync(assoc.uuid); if (d?.img) outImg = d.img; } catch (_) { /* unresolved */ }
        }

        const ingredients = (sys.craftingComponents ?? []).map(c => {
          let img = "icons/svg/item-bag.svg";
          let name = c.name || "";
          if (c.uuid && typeof fromUuidSync === "function") {
            try { const d = fromUuidSync(c.uuid); if (d) { img = d.img ?? img; if (!name) name = d.name; } } catch (_) { /* unresolved */ }
          }
          return { uuid: c.uuid || "", name, img, quantity: Number(c.quantity) || 0 };
        });

        const subs  = cfgMod.SUBSTANCES ?? CONFIG?.WITCHER?.alchemical?.substances ?? {};
        const art   = cfgMod.SUBSTANCE_ART ?? CONFIG?.WITCHER?.alchemical?.substanceArt ?? {};
        const reqMap = sys.alchemyComponents ?? {};
        const substancesRequired = Object.keys(subs)
          .map(key => ({ key, label: loc(subs[key], key), art: art[key] ?? "", qty: Number(reqMap[key]) || 0 }))
          .filter(s => s.qty > 0);

        diagramMeta = {
          isFormulae,
          dc:      isFormulae ? (Number(sys.alchemyDC) || 0) : (Number(sys.craftingDC) || 0),
          dcLabel: isFormulae ? "Alchemy DC" : "Crafting DC",
          kindLabel:    isFormulae ? "Formula" : "Diagram",
          levelLabel:   sys.level ? loc(levels[sys.level], sys.level) : "",
          subtypeLabel: sys.type  ? loc(subMap[sys.type], sys.type)   : "",
          craftingTime: sys.craftingTime || "",
          investment:   Number(sys.investment) || 0,
          learned:      !!sys.learned,
          output: {
            linked: !!(assoc.name || assoc.uuid),
            name:   assoc.name || "",
            img:    outImg || "icons/svg/item-bag.svg"
          },
          ingredients,
          hasIngredients: ingredients.length > 0,
          substancesRequired,
          hasSubstances: substancesRequired.length > 0
        };
      }

      // Book valuables: per-reader progress, shown above the description.
      if (item.type === "valuable" && item.system?.type === "book" && actor) {
        try {
          const studyMod = await import("/systems/witcher-ttrpg-death-march/module/chrome/sheets/valuable-study.js");
          bookMeta = studyMod.getBookProgress?.(item, actor) ?? null;
        } catch (_) { /* chrome book module unavailable — skip */ }
      }

      // Remains valuables: surface what's been DONE to the carcass
      // (harvested / mutagen extracted / charges left), not the identity —
      // the name + icon already say what it is.
      if (item.type === "valuable" && item.system?.type === "remains") {
        const f = item.flags?.[MODULE_ID] ?? {};
        remainsState = {
          harvested:  !!f.harvested,
          extracted:  !!f.mutagenExtracted,
          charges:    f.remainsCharges ?? 3,
          chargesMax: 3
        };
      }

      // Enrich the description HTML (resolves @UUID links + inline rolls).
      // Remains have no description/value/availability — skip enrichment.
      const desc = item.system?.type === "remains" ? null : item.system?.description;
      if (desc) descriptionHtml = await enrichHtml(desc);
    } catch (e) {
      console.warn(`${MODULE_ID} | inspection ctx prep failed`, e);
    }
    const html = await renderTemplate(
      "systems/witcher-ttrpg-death-march/templates/inspection/item-card.hbs",
      {
        item: rawItem,
        type: item.type,
        config: CONFIG?.WITCHER ?? {},
        weaponQualityList,
        armorQualityList,
        armorMeta,
        alchemyMeta,
        componentMeta,
        containerMeta,
        mutagenMeta,
        diagramMeta,
        bookMeta,
        remainsState,
        descriptionHtml,
        effective: effectiveMeta,
        enhancementSlots,
        socketedQualityList
      }
    );
    panel.innerHTML = `<div class="wou-inspection-body">${html}</div>`;

    // Legacy post-process hooks — they look for selectors in the
    // old-system template that don't exist in our new partial. Wrap
    // each in try/catch so a missing element can't blank the panel.
    const safe = fn => { try { fn(); } catch (e) { console.warn(`${MODULE_ID} | inspection post-process`, e); } };
    safe(() => appendWeaponCombatTags(panel, item));
    safe(() => appendComponentSubstanceTag(panel, item));
    safe(() => appendComponentPotencyTag(panel, item));
    try { await appendQualityTags(panel, item); } catch (e) { console.warn(`${MODULE_ID} | inspection qualities`, e); }
    safe(() => appendAppliedOilSection(panel, item));
    if (keepScroll) panel.scrollTop = inspectionScrollTop;
    inspectionRenderedId = item.id;
  } catch (err) {
    console.warn(`${MODULE_ID} | inspection render failed`, err);
    panel.innerHTML = `<div class="wou-inspection-empty">Inspection unavailable</div>`;
    inspectionRenderedId = null;
  }
}

/* =========================================================================
   QUALITY TAGS  —  parse the item description for weapon/armor/enhancement
   qualities, look them up in the homebrew "Weapon and Armor Qualities"
   journal, and render them as hover-tooltipped tags next to the item name.
   Mirrors witcher-inventory-qol's logic so the lookup hits the same source.
   ========================================================================= */

const QUALITIES_JOURNAL_NAME    = "Weapon and Armor Qualities";
const QUALITIES_COMPENDIUM_PACK = "world.new-armor-and-weapons-rules";
const QUALITY_TYPES             = ["weapon", "armor", "enhancement"];

let _qualityCache = null;     // lowercase quality name → {name, description}

async function loadQualityCache() {
  if (_qualityCache) return _qualityCache;
  _qualityCache = new Map();
  let journal = null;
  if (QUALITIES_COMPENDIUM_PACK) {
    const pack = game?.packs?.get?.(QUALITIES_COMPENDIUM_PACK);
    if (pack) {
      try {
        const index = await pack.getIndex();
        const entry = index.find(e => e.name?.trim().toLowerCase() === QUALITIES_JOURNAL_NAME.trim().toLowerCase());
        if (entry) journal = await pack.getDocument(entry._id);
      } catch { /* fall through to world lookup */ }
    }
  }
  if (!journal) {
    journal = game?.journal?.find?.(j => j.name?.trim().toLowerCase() === QUALITIES_JOURNAL_NAME.trim().toLowerCase());
  }
  if (!journal) return _qualityCache;
  for (const page of (journal.pages?.contents ?? journal.pages ?? [])) {
    const key = normalizeQualityName(page.name);
    _qualityCache.set(key, { name: page.name.trim(), description: page.text?.content ?? "" });
  }
  return _qualityCache;
}

// Drop the cache when journal pages change so live edits show up.
Hooks.on?.("updateJournalEntryPage", () => { _qualityCache = null; });
Hooks.on?.("createJournalEntryPage", () => { _qualityCache = null; });
Hooks.on?.("deleteJournalEntryPage", () => { _qualityCache = null; });

/* =========================================================================
 * Weapon-hand exclusivity enforcement
 *
 * Whenever a weapon's `equipped` or `hands` field changes — from our badge,
 * from a drop, from the system's weapon-item sheet dropdown, from a macro,
 * anywhere — re-validate the rule and unequip any conflicts.
 *
 *   - 'both' conflicts with any other weapon on left, right, or both.
 *   - 'left' conflicts with any other weapon on left or both.
 *   - 'right' conflicts with any other weapon on right or both.
 *
 * Only the user who triggered the update applies the cascade, so a GM-owned
 * actor + a player-owned actor don't both fight to write the same updates.
 * The hook is recursion-safe: unequipping a conflict sets equipped=false,
 * which falls through the gate at the top.
 * ========================================================================= */
/* Cancel any update that would equip a weapon onto a hand which already
 * has a conflict. This is the "no overwrites" rule — the user has to
 * sheath/drop the conflicting weapon themselves. Catches all paths the
 * UI doesn't cover (system item sheet hands dropdown, system character
 * sheet equip toggle, macros, etc.). Returning false from a preUpdate
 * hook cancels the update. */
Hooks.on?.("preUpdateItem", (item, change, _options, userId) => {
  if (userId !== game.user?.id) return;
  if (item?.type !== "weapon") return;
  // The Switch-Hands button swaps two equipped weapons in one batched update;
  // each would see the other still in its old slot and be wrongly rejected, so
  // it pre-validates itself and bypasses the per-item conflict check here.
  if (_options?.wouSwapHands) return;
  const sysChange = change?.system;
  if (!sysChange) return;
  if (!("equipped" in sysChange) && !("slot" in sysChange)
      && !("hands" in sysChange) && !("quick" in sysChange)) return;

  const willBeEquipped = ("equipped" in sysChange) ? sysChange.equipped : item.system?.equipped;
  if (!willBeEquipped) return;

  const trait = ("hands" in sysChange) ? sysChange.hands : item.system?.hands;
  const quick = ("quick" in sysChange) ? sysChange.quick : item.system?.quick;
  let   slot  = ("slot"  in sysChange) ? sysChange.slot  : item.system?.slot;

  // Garbage-slot normalization: a non-quick one-handed weapon can't sit in
  // Quick, and an unrecognized slot falls back to Right, so the exclusivity
  // machinery always has a defined hand to reason about.
  if (!VALID_SLOTS.includes(slot) || (slot === "quick" && !quick)) {
    if (!("system" in change)) change.system = {};
    change.system.slot = "right";
    slot = "right";
  }
  const occ = trait === "two" ? "both" : slot;

  const actor = item.parent;
  if (!actor?.items) return;

  const pending = getPendingEquips(actor.id);
  const check = checkEquipConflicts(actor, item.id, occ, pending);
  if (!check.ok) {
    ui?.notifications?.warn?.(describeEquipFailure(item.name, check));
    return false;
  }
  recordPendingEquip(actor.id, item.id, occ);
});

/* The Quick slot only exists to rest a two-handed weapon one-handed (so you
 * can throw/drink with the off-hand). Once that 2H weapon leaves both hands,
 * the Quick slot is gone — a quick WEAPON that was resting there becomes a
 * normally-wielded weapon, so move it into the main hand (then off-hand if the
 * main is taken). Shields stay put: they're genuine off-hand items. Fires
 * after a 2H weapon is unequipped via any path (sheathe, drag-to-inventory,
 * sheet toggle). */
function relocateRestingQuickToHand(actor) {
  if (!actor?.items) return;
  const eq = actor.items.filter(i => i.system?.equipped);
  if (eq.some(i => occupancyOf(i) === "both")) return;   // another 2H still equipped
  let mainFree = !eq.some(i => occupancyOf(i) === "right");
  let offFree  = !eq.some(i => occupancyOf(i) === "left");
  for (const i of eq) {
    if (i.type !== "weapon" || !i.system?.quick || i.system?.slot !== "quick") continue;
    if (mainFree)      { i.update({ "system.slot": "right" }); mainFree = false; }
    else if (offFree)  { i.update({ "system.slot": "left"  }); offFree  = false; }
  }
}

Hooks.on?.("updateItem", (item, change, _options, userId) => {
  if (userId !== game.user?.id) return;
  if (item?.type !== "weapon" || item.system?.hands !== "two") return;
  if (change?.system?.equipped !== false) return;
  relocateRestingQuickToHand(item.parent);
});

/* Containers must never stack: each one carries its own contents, so two
 * "Backpack" items on the actor are NOT interchangeable instances. The
 * system's actor.addItem merges any same-name/same-type item by bumping
 * quantity — these two hooks cap container quantity at 1 (preCreate on
 * import, preUpdate on the merge path).
 *
 * Cancelling the merge update via `return false` would leave the second
 * container's drop silent — so we instead clamp the quantity and let
 * the second container exist as a separate document elsewhere. */
Hooks.on?.("preCreateItem", (item, createData, _options, userId) => {
  if (userId !== game.user?.id) return;
  if (item?.type !== "container") return;
  /* A new container always starts empty. Without this, dragging the same
   * compendium template twice and filling the first one made the system
   * compute the second one's storedWeight from a carried-over content
   * array (since `item.toObject()` ships the source's `system.content`
   * verbatim). The cap check then thought the empty bag was full of the
   * first bag's contents. */
  const patch = {};
  if (Number(createData?.system?.quantity ?? 1) > 1) {
    patch["system.quantity"] = 1;
  }
  if (Array.isArray(createData?.system?.content) && createData.system.content.length) {
    patch["system.content"] = [];
  }
  if (Number(createData?.system?.storedWeight) > 0) {
    patch["system.storedWeight"] = 0;
  }
  if (Object.keys(patch).length) item.updateSource(patch);
});
Hooks.on?.("preUpdateItem", (item, change, _options, userId) => {
  if (userId !== game.user?.id) return;
  if (item?.type !== "container") return;
  const newQty = change?.system?.quantity;
  if (newQty !== undefined && Number(newQty) > 1) {
    if (!("system" in change)) change.system = {};
    change.system.quantity = 1;
  }
});

/* Symmetry with preUpdateItem: catch items being CREATED on an actor with
 * `equipped: true` (compendium imports, monster auto-equip in the system's
 * _onDropItem, drag-from-sidebar onto a sheet, etc.). On conflict, force
 * `equipped: false` rather than refusing the create — the item still
 * lands so the user can deal with it manually. Also normalizes garbage
 * `hands` values to 'right' if the item is being created equipped. */
Hooks.on?.("preCreateItem", (item, createData, _options, userId) => {
  if (userId !== game.user?.id) return;
  if (item?.type !== "weapon") return;
  const actor = item.parent;
  if (!actor?.items) return; // world-level item

  const willBeEquipped = createData?.system?.equipped ?? false;
  if (!willBeEquipped) return;

  const trait = createData?.system?.hands;
  const quick = createData?.system?.quick;
  let   slot  = createData?.system?.slot;
  const patch = {};
  if (!VALID_SLOTS.includes(slot) || (slot === "quick" && !quick)) {
    slot = "right";
    patch["system.slot"] = "right";
  }
  const occ = trait === "two" ? "both" : slot;

  const pending = getPendingEquips(actor.id);
  const check = checkEquipConflicts(actor, item.id, occ, pending);
  if (!check.ok) {
    // Don't cancel the create — just land it un-equipped.
    patch["system.equipped"] = false;
    ui?.notifications?.warn?.(
      `${item.name} imported un-equipped — ${describeEquipFailure(item.name, check).replace(/^Can't equip [^—]+— /, "")}`
    );
  } else {
    recordPendingEquip(actor.id, item.id, occ);
  }
  if (Object.keys(patch).length) item.updateSource(patch);
});

// Mirror the overlay's added context-menu entries onto the legacy actor
// sheets via the shared shim, so they're reachable even when the inventory
// overlay isn't open (or its feature flag is off).  Builders are called by
// the shim with `this` bound to the sheet, which exposes `.actor` — the
// same surface as the overlay's helper — so the builders are reused
// unchanged.  Remains entries (Harvest / Extract / Dissect) are wired by
// context-menu-item.js itself.  Food & drink (Pour Glass / Serve Piece) is
// owned by the witcher-food-and-drink module, which uses the same shared
// shim and so installs its own entries on these sheets.
Hooks.once?.("ready", () => {
  installSheetContextMenuExtra(buildDrawEntry);
  installSheetContextMenuExtra(buildEquipEntry);
  installSheetContextMenuExtra(buildDropOnSceneEntry);
  installSheetContextMenuExtra(buildSplitStackEntry);
  // Replace the system's stock Gift / Delete with the stack-aware versions
  // (prompts for quantity when stack > 1).  Overrides keep the original
  // entry's name + icon + condition; only the callback is swapped.
  installSheetContextMenuOverride("giftableItem", function (base) {
    return buildStackAwareGift(base, this);
  });
  installSheetContextMenuOverride("deleteItem", function (base) {
    return buildStackAwareDelete(base, this);
  });
});

function normalizeQualityName(name) {
  return String(name ?? "").replace(/\s*\(.*?\)/g, "").trim().toLowerCase();
}

/** Split on commas at parenthesis depth 0 — so `Close Quarters (+1 WA,
 *  Nigga), test` parses as `["Close Quarters (+1 WA, Nigga)", "test"]`. */
function splitTopLevelCommas(text) {
  const out = [];
  let buf = "";
  let depth = 0;
  for (const ch of text) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** Extract plain text from item-description HTML, but only up to the first
 *  paragraph break.  We treat literal `\n\n`, `</p>`, and consecutive
 *  `<br>` as paragraph boundaries — anything after the qualities line is
 *  prose we don't want to scan. */
function firstParagraphText(html) {
  if (!html) return "";
  const withBreaks = String(html)
    .replace(/<\/p\s*>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n");
  const tmp = document.createElement("div");
  tmp.innerHTML = withBreaks;
  const text = tmp.textContent || tmp.innerText || "";
  return text.split(/\n\s*\n/)[0].trim();
}

/** Scan a description's leading comma-separated tokens for quality names.
 *  Commas inside parentheses are NOT splits — that keeps multi-word
 *  parentheticals (e.g. "Close Quarters (+1 WA, ...)") attached.  Stops at
 *  the first prose-like token (sentence-ending punctuation, >8 words). */
function parseQualities(descriptionHtml) {
  if (!descriptionHtml) return [];
  const text = firstParagraphText(descriptionHtml);
  const tokens = splitTopLevelCommas(text)
    .map(t => t.trim())
    .filter(t => t.length >= 2 && t.length <= 80 && !/^\d+$/.test(t));
  const seen = new Set();
  const out = [];
  for (const tok of tokens) {
    if (/[.!?;]/.test(tok)) break;
    if (tok.split(" ").length > 8) break;
    const key = normalizeQualityName(tok);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tok);
  }
  return out;
}

async function appendQualityTags(panel, item) {
  if (!QUALITY_TYPES.includes(item.type)) return;
  const qualities = parseQualities(item.system?.description);
  if (qualities.length === 0) return;
  const cache = await loadQualityCache();
  const enrich = async (html) => enrichHtml(html);

  const tagsHTML = await Promise.all(qualities.map(async (name) => {
    const entry = cache.get(normalizeQualityName(name));
    if (!entry) {
      return `<span class="wou-quality-tag wou-quality-unknown" title="Quality '${escapeAttr(name)}' not found in journal">${escapeText(name)}</span>`;
    }
    const enriched = await enrich(entry.description);
    // Foundry's data-tooltip accepts rich HTML when paired with data-tooltip-direction or class "html"; the attribute itself takes a serialized HTML string.
    return `<span class="wou-quality-tag" data-tooltip="${escapeAttr(enriched)}" data-tooltip-direction="UP" data-tooltip-class="wou-quality-tip">${escapeText(entry.name)}</span>`;
  }));

  const header = panel.querySelector(".chat-item-header");
  if (header) {
    header.insertAdjacentHTML(
      "beforeend",
      `<div class="wou-quality-tags">${tagsHTML.join("")}</div>`
    );
  }
}

/** Append an "Applied Oil" panel to the inspection view for any weapon
 *  with an active oil coating.  Shows the oil's icon + name, the remaining
 *  time + a depleting bar, the effect description, and a Cleanse button that
 *  deletes the coating effect(s) from the weapon. */
function appendAppliedOilSection(panel, item) {
  if (item.type !== "weapon") return;
  const oil = readOilCoating(item);
  if (!oil) return;
  const { total, remaining, label } = describeDuration(oil.dur ?? {});
  const timed = total > 0;
  const pct   = timed ? Math.max(0, Math.min(100, Math.round((remaining / total) * 100))) : 100;
  const mins  = timed ? label : "active";
  const body = panel.querySelector(".wou-inspection-body");
  if (!body) return;
  body.insertAdjacentHTML("beforeend", `
    <div class="wou-applied-oil">
      <div class="wou-applied-oil-header">
        <img src="${escapeAttr(oil.img)}" class="wou-applied-oil-img" alt="" />
        <div class="wou-applied-oil-meta">
          <div class="wou-applied-oil-label">Applied Oil</div>
          <div class="wou-applied-oil-name">${escapeText(oil.name)}</div>
        </div>
        <div class="wou-applied-oil-charges">${mins}</div>
      </div>
      <div class="wou-applied-oil-bar"><div class="fill" style="width:${pct}%"></div></div>
      ${oil.effect ? `<div class="wou-applied-oil-effect">${escapeText(oil.effect)}</div>` : ""}
      <button type="button" class="wou-applied-oil-cleanse" data-action="cleanse-oil"
              data-item-id="${escapeAttr(item.id)}" title="Wipe the oil from this weapon">
        <i class="fa-solid fa-broom"></i>Cleanse blade
      </button>
    </div>
  `);
  const btn = body.querySelector('[data-action="cleanse-oil"]');
  btn?.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const actor = getAssignedActor();
    const weapon = actor?.items?.get(btn.dataset.itemId);
    if (!weapon) return;
    try {
      const ids = oilCoatingEffects(weapon).map(fx => fx.id);
      if (ids.length) await weapon.deleteEmbeddedDocuments("ActiveEffect", ids);
    } catch (err) {
      console.warn(`${MODULE_ID} | failed to cleanse oil`, err);
    }
  });
}

/** World-time tick: patch only the oil-coating countdown labels in place —
 *  the grid/equip droplet badges and the inspect panel's Applied-Oil block —
 *  leaving the rest of the inventory DOM (and its scroll/hover state) alone.
 *  Applied / expired / cleansed coatings are structural and rebuild via the
 *  ActiveEffect create/delete hooks instead. */
function tickOilLabels() {
  if (!invEl || !isInventoryOpen()) return;
  const actor = getAssignedActor();
  if (!actor) return;
  for (const it of actor.items) {
    if (it.type !== "weapon") continue;
    const coat = readOilCoating(it);
    if (!coat) continue;
    const { total, remaining, label } = describeDuration(coat.dur ?? {});
    const timed     = total > 0;
    const badgeText = timed ? (label || "0") : "∞";
    const sel       = `[data-item-id="${CSS.escape(it.id)}"]`;

    /* Grid + equip droplet badges. */
    for (const span of invEl.querySelectorAll(`${sel} .oil-badge .oil-badge-label`)) {
      if (span.textContent !== badgeText) span.textContent = badgeText;
    }

    /* Inspect panel Applied-Oil block (scoped by the cleanse button's id). */
    const block = invEl.querySelector(`.wou-applied-oil [data-action="cleanse-oil"]${sel}`)
                       ?.closest(".wou-applied-oil");
    if (block) {
      const charges = block.querySelector(".wou-applied-oil-charges");
      const mins    = timed ? label : "active";
      if (charges && charges.textContent !== mins) charges.textContent = mins;
      const fill = block.querySelector(".wou-applied-oil-bar .fill");
      if (fill && timed) {
        const pct = Math.max(0, Math.min(100, Math.round((remaining / total) * 100)));
        fill.style.width = `${pct}%`;
      }
    }
  }
}

/** For component items, the system tags partial shows `system.type` (e.g.
 *  "Substance") but not the actual `system.substanceType` (Vermilion,
 *  Vitriol, Fulgur, etc).  Append a tag for that. */
/** Weapon combat tags — damage, silver-damage variant, reliability,
 *  rate-of-fire, and a row of damage-property mini-icons (armor piercing,
 *  bypasses worn/natural armor, non-lethal, etc.).  Inserted at the FRONT
 *  of the system's weapon tags row so damage leads the line and stays
 *  visible without scrolling. */
function appendWeaponCombatTags(panel, item) {
  if (item.type !== "weapon") return;
  const sys = item.system ?? {};
  const damage = String(sys.damage ?? "").trim();
  if (!damage) return;
  const all = panel.querySelectorAll(".item-tags");
  const tagsDiv = all[all.length - 1];
  if (!tagsDiv) return;

  const dp = sys.damageProperties ?? {};
  const tags = [];

  tags.push(`<span class="item-tag" data-tooltip="Damage"><i class="fa-solid fa-burst"></i>${escapeText(damage)}</span>`);

  const silverDmg = String(dp.silverDamage ?? "").trim();
  if (silverDmg) {
    tags.push(`<span class="item-tag" data-tooltip="Silver damage"><i class="fa-solid fa-moon"></i>${escapeText(silverDmg)}</span>`);
  }

  const rel = Number(sys.reliable);
  const maxRel = Number(sys.maxReliability);
  if (Number.isFinite(maxRel) && maxRel > 0) {
    tags.push(`<span class="item-tag" data-tooltip="Reliability"><i class="fa-solid fa-shield-halved"></i>${rel}/${maxRel}</span>`);
  }

  /* Damage-property mini-icons — one tag per active property.  Tooltip
   * carries the meaning; the icon itself is the only visible content so
   * the row stays compact. */
  const props = [
    [dp.armorPiercing,         "fa-solid fa-arrow-up-right-from-square", "Armor piercing"],
    [dp.improvedArmorPiercing, "fa-solid fa-angles-up",                  "Improved armor piercing"],
    [dp.bypassesWornArmor,     "fa-solid fa-shirt",                      "Bypasses worn armor"],
    [dp.bypassesNaturalArmor,  "fa-solid fa-paw",                        "Bypasses natural armor"],
    [dp.ablating,              "fa-solid fa-hammer",                     "Ablating"],
    [dp.crushingForce,         "fa-solid fa-weight-scale",               "Crushing force"],
    [dp.isNonLethal,           "fa-solid fa-heart-pulse",                "Non-lethal"],
    [dp.damageToAllLocations,  "fa-solid fa-explosion",                  "Damage to all locations"],
    [dp.silverTrait,           "fa-solid fa-moon",                       "Silver trait"],
    [dp.isMeteorite,           "fa-solid fa-meteor",                     "Meteorite"],
  ];
  for (const [on, icon, tip] of props) {
    if (on) tags.push(`<span class="item-tag" data-tooltip="${escapeAttr(tip)}"><i class="${icon}"></i></span>`);
  }

  const cost = Number(sys.cost ?? 0);
  tags.push(`<span class="item-tag" data-tooltip="Cost"><i class="fa-solid fa-coins"></i>${cost}</span>`);

  /* Insert at the start of the existing tags row so damage reads first.
   * `afterbegin` preserves the order of the joined tags. */
  tagsDiv.insertAdjacentHTML("afterbegin", tags.join(""));
}

function appendComponentSubstanceTag(panel, item) {
  if (item.type !== "component") return;
  const sub = item.system?.substanceType;
  if (!sub) return;
  // The chat template wraps tags in a <footer class="chat-item-tags item-tags">
  // and the type-specific partial puts an inner <div class="item-tags"> for
  // the actual tag row.  Querying for `.item-tags` matches the footer first;
  // we want the innermost one so the new tag becomes a sibling of the
  // existing tags (same flex layout, same height).
  const all = panel.querySelectorAll(".item-tags");
  const tagsDiv = all[all.length - 1];
  if (!tagsDiv) return;
  tagsDiv.insertAdjacentHTML(
    "beforeend",
    `<span class="item-tag" data-tooltip="Substance Type"><i class="fa-solid fa-droplet"></i>${escapeText(capitalize(sub))}</span>`
  );
}

/** Potency tag for substance components.  Same flag convention as the
 *  crafting panel (witcher-alchemy-craft `potency`), missing flag = 0. */
function appendComponentPotencyTag(panel, item) {
  if (item.type !== "component") return;
  if (!item.system?.substanceType) return;
  const potency = Number(item.flags?.["witcher-alchemy-craft"]?.potency) || 0;
  const all = panel.querySelectorAll(".item-tags");
  const tagsDiv = all[all.length - 1];
  if (!tagsDiv) return;
  tagsDiv.insertAdjacentHTML(
    "beforeend",
    `<span class="item-tag" data-tooltip="Potency"><i class="fa-solid fa-bolt"></i>${potency}</span>`
  );
}

/** Foundry's TextEditor enrichment: turns `<p>` etc. into real HTML and
 *  resolves @UUID / @Roll / @Compendium tokens. */
async function enrichHtml(text) {
  if (!text) return "";
  const TE = foundry?.applications?.ux?.TextEditor?.implementation
          ?? foundry?.applications?.ux?.TextEditor
          ?? window?.TextEditor;
  try {
    if (TE?.enrichHTML) return await TE.enrichHTML(text, { async: true });
  } catch { /* fall through */ }
  return text;
}

function renderHTML(actor) {
  const gridItems  = collectGridItems(actor);
  const stats      = collectStats(actor);

  // If the popup was open for a container that's gone (deleted), close it.
  const popupOwner = openContainerActorId
    ? game.actors?.get?.(openContainerActorId)
    : actor;
  if (openContainerPopupId && !popupOwner?.items?.get(openContainerPopupId)) {
    openContainerPopupId = null;
    openContainerActorId = null;
  }
  // A character-owned popup is anchored to a rail slot. If the container was
  // moved back into the inventory (off the rail), the anchor is gone, so close
  // the popup rather than leaving it floating/relocated.
  if (openContainerPopupId && !openContainerActorId) {
    const railed = getRail(actor)?.assignments ?? [];
    if (!railed.includes(openContainerPopupId)) {
      openContainerPopupId = null;
    }
  }
  // Same for the inspected item.
  if (inspectedItemId && !actor?.items?.get(inspectedItemId)) {
    inspectedItemId = null;
  }
  // Mount popup can't stand open if the mount was unlinked.
  if (mountPopupOpen && !getMountActor(actor)) {
    mountPopupOpen = false;
  }

  return `
    <button id="wou-inv-close" type="button" aria-label="Close inventory" title="Close">
      <i class="fa-solid fa-chevron-up"></i>
    </button>

    <div class="wou-inv-header">
      <div class="wou-inv-title">Inventory</div>
      ${game.user?.isGM ? renderViewAsPicker() : ""}
    </div>

    <section class="wou-inv-left">
      ${renderTabsHTML(actor)}
      ${renderGridHTML(gridItems)}
      ${renderInspectionPlaceholderHTML()}
    </section>

    <section class="wou-inv-containers">
      ${renderContainersHTML(actor)}
    </section>

    <section class="wou-inv-right">
      ${renderStatsHTML(stats)}
      ${renderCurrencyHTML(stats.currency)}
      ${renderWeaponsAndPortraitHTML(actor, stats)}
    </section>

    ${openContainerPopupId ? renderContainerPopupHTML(popupOwner) : ""}
    ${mountPopupOpen ? renderMountPopupHTML(actor) : ""}
  `;
}

/* ---------- containers ---------- */

function containersFor(actor, ownerKind /* "character" | "mount" */) {
  if (!actor) return [];

  /* Mount rail keeps the legacy "show every container on the mount"
   * behavior — the rail-equip mechanic is character-only.  Saddle bags
   * and similar mount-owned containers all render as plain tiles. */
  if (ownerKind === "mount") {
    return actor.items
      .filter(i => i.type === "container")
      .map(c => {
        const contents = resolveContainerContents(actor, c);
        return {
          id: c.id,
          label: c.name,
          icon: c.system?.isStored ? "fa-warehouse" : "fa-box",
          img: c.img && !c.img.includes("mystery-man") ? c.img : null,
          kind: "container",
          item: c,
          ownerActorId: actor.id,
          ownerKind,
          weapons: contents.filter(it => it.type === "weapon")
        };
      });
  }

  /* Character rail = fixed-length array of equip slots.  Each slot is
   * either an assigned container (renders as a normal tile) or null
   * (renders as a faded placeholder drop target). */
  const rail = getRail(actor);
  const out = new Array(rail.count);
  for (let i = 0; i < rail.count; i++) {
    const id = rail.assignments[i];
    if (!id) {
      out[i] = {
        id: null,
        label: "Empty",
        kind: "empty",
        ownerActorId: actor.id,
        ownerKind,
        slotIdx: i,
      };
      continue;
    }
    const c = actor.items.get(id);
    if (!c) {
      out[i] = { id: null, label: "Empty", kind: "empty", ownerActorId: actor.id, ownerKind, slotIdx: i };
      continue;
    }
    const contents = resolveContainerContents(actor, c);
    out[i] = {
      id: c.id,
      label: c.name,
      icon: c.system?.isStored ? "fa-warehouse" : "fa-box",
      img: c.img && !c.img.includes("mystery-man") ? c.img : null,
      kind: "container",
      item: c,
      ownerActorId: actor.id,
      ownerKind,
      slotIdx: i,
      weapons: contents.filter(it => it.type === "weapon")
    };
  }
  return out;
}

/** Locate which of an actor's containers, if any, holds a given item.
 *  Only RAILED containers (those equipped on the inventory rail) are
 *  considered — a weapon stashed in a bulk-storage container is not
 *  drawable until that container is dragged onto a rail slot. */
export function findContainerHoldingItem(actor, itemId) {
  if (!actor || !itemId) return null;
  const item = actor.items?.get(itemId);
  if (!item) return null;
  const railed = new Set(getRail(actor).assignments.filter(Boolean));
  for (const c of actor.items) {
    if (c.type !== "container") continue;
    if (!railed.has(c.id)) continue;
    const content = c.system?.content ?? [];
    if (content.includes(item.uuid) || content.includes(item.id)) return c.id;
  }
  return null;
}

/** Weapons carried inside a container, each shown as a teal "rail clip"
 *  bracket branching off the slot's right edge with a tiny art thumbnail at
 *  its mouth. The clips DIVIDE the slot's full height (CSS flex: 1), so more
 *  weapons = shorter clips. No cap — every weapon gets its own clip. */
function renderContainerWeaponOverlay(weapons) {
  if (!weapons || weapons.length === 0) return "";
  const clips = weapons.map((wpn) => {
    const art = wpn.img && !wpn.img.includes("mystery-man")
      ? `<img class="wou-cw-art" src="${escapeAttr(wpn.img)}" alt="" draggable="false" />`
      : `<i class="wou-cw-art fa-solid ${fallbackIconFor(wpn.type)}"></i>`;
    const rarity  = String(wpn.system?.availability ?? "").toLowerCase();
    const rarAttr = rarity ? ` data-rarity="${escapeAttr(rarity)}"` : "";
    return `<span class="wou-cw-clip"${rarAttr} title="${escapeAttr(wpn.name)}">${art}</span>`;
  }).join("");
  return `<div class="wou-container-weapons">${clips}</div>`;
}

/** Combined container list for the rail — character first, then mount. */
function collectContainers(character) {
  const own  = containersFor(character, "character");
  const mount = getMountActor(character);
  const ext  = mount ? containersFor(mount, "mount") : [];
  return [...own, ...ext];
}

/* Hover help shown under the rail — the action cost of handling gear in combat.
 * Themed via Foundry's #tooltip with our base hover-tip style (wou-craft-tip):
 * a serialized HTML string read back (and un-escaped) by the tooltip system,
 * same pattern as the quality tags. */
const COMBAT_RAIL_TOOLTIP =
  '<div class="wcu-tip">' +
    '<strong>Combat: Handling Gear</strong>' +
    'In combat you can only reach gear stowed in a bag equipped on this rail. Each hands-on action spends one action (normal first, then extra):' +
    '<div class="wcu-tip-row"><span>Draw or sheathe a weapon</span><span>1 action</span></div>' +
    '<div class="wcu-tip-row"><span>Switch a weapon between hands</span><span>1 action</span></div>' +
    '<div class="wcu-tip-row"><span>Drink or use a consumable</span><span>1 action</span></div>' +
    '<div class="wcu-tip-row"><span>Shuffle an item into or out of a bag</span><span>1 action</span></div>' +
    '<div class="wcu-tip-row"><span>Pick an item up off the ground</span><span>1 action</span></div>' +
    "<div class=\"wcu-tip-flavor\">Loose gear can't be equipped mid-combat — draw it from a bag first. Out of combat, all of this is free.</div>" +
  '</div>';

function renderContainersHTML(character) {
  /* Player container rail in the middle column.  A FIXED-LENGTH array of
   * equip slots — assigned and empty slots both render; +/− under the
   * track adjusts the count.  Slots bottom-anchor via `align-content: end`
   * so new bags grow upward.
   *
   * When a mount is linked, its containers dock as a SECOND rail pinned to
   * the bottom of the same column (below the player rail, to the left of the
   * mount icon in the right column).  The mount rail isn't slot-based — it
   * just lists every container on the mount.  Each tile carries
   * data-owner-actor-id so the shared rail listener opens the popup against
   * the mount actor. */
  const own   = containersFor(character, "character");
  const mount = getMountActor(character);
  const ext   = mount ? containersFor(mount, "mount") : [];
  return `
    <div class="wou-containers">
      <div class="wou-containers-stack wou-containers-player">
        <div class="wou-equip-controls wou-containers-controls" data-equip-controls="containers" data-rail-owner="${escapeAttr(character?.id ?? "")}">
          <button type="button" data-action="add"    title="Add equip slot">+</button>
          <button type="button" data-action="remove" title="Remove last empty slot">−</button>
        </div>
        <div class="wou-containers-track" data-track="containers" data-rail-owner="${escapeAttr(character?.id ?? "")}">
          ${own.map(railSlotHTML).join("")}
        </div>
        <div class="wou-containers-help" data-tooltip="${escapeAttr(COMBAT_RAIL_TOOLTIP)}" data-tooltip-direction="UP" data-tooltip-class="wou-craft-tip">
          <i class="fa-solid fa-circle-info"></i> Handling Gear
        </div>
      </div>
      ${mount ? `
      <div class="wou-containers-stack wou-containers-mount">
        <div class="wou-containers-mount-label" title="${escapeAttr(mount.name)}'s containers">
          <i class="fa-solid fa-horse"></i>
        </div>
        <div class="wou-containers-track" data-track="containers" data-rail-owner="${escapeAttr(mount.id)}">
          ${ext.length ? ext.map(railSlotHTML).join("") : `<div class="wou-rail-empty-hint">No bags</div>`}
        </div>
      </div>` : ""}
    </div>
  `;
}

/** Container slot — clicking opens/closes a popup with that container's
 *  contents.  Active state mirrors which popup is currently open.
 *  The slot also doubles as a generic `.item` (with `data-item-id`) so the
 *  Witcher ContextMenu picks up right-clicks here, and it's `draggable`
 *  with Foundry's native Item payload so users can drag it onto the
 *  macro hotbar to create a quick-access macro.
 *
 *  Empty rail slots (kind === "empty") render a faded placeholder that
 *  acts as a drop target — drag any container item onto it to equip. */
function railSlotHTML(c) {
  const isMount = c.ownerKind === "mount";
  const ownerAttr = isMount ? ` data-owner-actor-id="${escapeAttr(c.ownerActorId)}"` : "";
  const slotAttr  = c.slotIdx != null ? ` data-rail-slot="${c.slotIdx}"` : "";

  if (c.kind === "empty") {
    const cls = ["wou-slot", "wou-rail-empty", isMount ? "is-mount" : ""].filter(Boolean).join(" ");
    // Use the same fa-box icon containers normally render — empty
    // slots inherit the .wou-rail-empty .icon styling (opacity 0.55,
    // amber-dim), so it reads as a faded "container goes here" hint.
    return `<div class="${cls}"${ownerAttr}${slotAttr} title="Drop a container here to equip">
      <i class="icon fa-solid fa-box"></i>
    </div>`;
  }

  const isOpen = openContainerPopupId === c.id
              && (openContainerActorId ?? getAssignedActor()?.id) === c.ownerActorId;
  const cls = ["wou-slot", "item", isOpen ? "is-active" : "", isMount ? "is-mount" : ""].filter(Boolean).join(" ");
  const inner = c.img
    ? `<img class="icon" src="${escapeAttr(c.img)}" alt="" draggable="false" />`
    : `<i class="icon fa-solid ${c.icon}"></i>`;
  const weaponOverlay = renderContainerWeaponOverlay(c.weapons);
  return `<div class="${cls}" draggable="true" data-container-id="${escapeAttr(c.id)}" data-item-id="${escapeAttr(c.id)}"${ownerAttr}${slotAttr} title="${escapeAttr(c.label)}">${inner}${weaponOverlay}</div>`;
}

function renderContainerPopupHTML(actor) {
  const container = actor?.items?.get(openContainerPopupId);
  if (!container) return "";
  const items = resolveContainerContents(actor, container);
  const isMount = !!openContainerActorId;          /* popup owner is the linked mount */
  const cap = getCapacityDisplay(container);
  const weightHTML = buildCapacityChipsHTML(cap);
  /* Mount popup slots intentionally OMIT the `.item` class so Foundry's
   * ContextMenu (selector `.item`) doesn't fire — items are drag-only. */
  const slotRenderer = isMount ? mountItemSlotHTML : itemSlotHTML;
  let body;
  if (hasSlotRows(container)) {
    const tiles = buildSlotLayout(container);
    const cols  = Math.min(5, Math.max(1, Math.ceil(Math.sqrt(totalSlots(container)))));
    body = `<div class="wou-popup-grid is-slots" style="grid-template-columns: repeat(${cols}, 50px)">${tiles.map(slotTileHTML).join("")}</div>`;
  } else {
    body = items.length === 0
      ? `<div class="wou-empty-state">— Empty —</div>`
      : `<div class="wou-popup-grid">${items.map(slotRenderer).join("")}</div>`;
  }
  const popupCls = ["wou-container-popup", isMount ? "is-mount" : ""].filter(Boolean).join(" ");
  return `
    <div class="${popupCls}" data-popup-container-id="${escapeAttr(container.id)}"${isMount ? ` data-owner-actor-id="${escapeAttr(openContainerActorId)}"` : ""}>
      <div class="wou-popup-header">
        <span class="wou-popup-title">${escapeText(container.name)}</span>
        ${weightHTML}
        <button type="button" class="wou-popup-close" aria-label="Close container">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
      <div class="wou-popup-body">${body}</div>
    </div>
  `;
}

/** Same visual as itemSlotHTML but no `.item` class (skips right-click menu). */
function mountItemSlotHTML(item) {
  const sys = item.system ?? {};
  const qty = Number(sys.quantity) || 0;
  const iconHTML = item.img && !item.img.includes("mystery-man")
    ? `<img class="icon" src="${escapeAttr(item.img)}" alt="" draggable="false" />`
    : `<i class="icon fa-solid ${fallbackIconFor(item.type)}"></i>`;
  const badgeHTML = qty > 1 ? `<span class="count">${qty}</span>` : "";
  // Same substance (frame) + rarity (background) hooks as itemSlotHTML so the
  // mount interaction popup matches the main grid and container popups.
  const element = (item.type === "component" && sys.substanceType) ? sys.substanceType : "";
  const elAttr  = element ? ` data-element="${escapeAttr(element)}"` : "";
  const rarity  = String(sys.availability ?? "").toLowerCase();
  const rarAttr = rarity ? ` data-rarity="${escapeAttr(rarity)}"` : "";
  return `<div class="wou-slot is-mount-item" draggable="true" data-item-id="${escapeAttr(item.id)}"${elAttr}${rarAttr} title="${escapeAttr(item.name)}">${iconHTML}${substanceCornerHTML(element)}${badgeHTML}</div>`;
}

/** Container-style popup for the linked mount, opened by clicking the
 *  mount circle.  Shows the items the mount carries directly (loose — not
 *  inside one of its rail containers); the mount's containers stay on the
 *  rail. Header carries a weight-vs-capacity chip (mount carry = BODY×10,
 *  scalar system.derivedStats.enc).  Drop-target for items & containers. */
/** A mount only carries pack goods: bulk-storage containers and butchered
 *  remains (valuables whose system.type === "remains"). Everything else a
 *  character tries to load onto the mount is refused. */
function mountAcceptsItem(item) {
  if (!item) return false;
  if (item.type === "container") return true;
  return item.type === "valuable"
      && String(item.system?.type ?? "").trim().toLowerCase() === "remains";
}

/** The item currently under the cursor mid-drag, resolved from the drag
 *  globals (only items dragged from our own UI set these). Returns null for
 *  external/compendium drags, which can't be pre-validated on dragover. */
function draggedItem() {
  if (!currentDragItemId) return null;
  const a = currentDragActorId ? game.actors?.get?.(currentDragActorId) : getAssignedActor();
  return a?.items?.get(currentDragItemId) ?? null;
}

function renderMountPopupHTML(character) {
  const mount = getMountActor(character);
  if (!mount) return "";

  /* Items carried directly on the mount: drop containers (they live on the
   * rail) and anything stored inside a container. */
  const inContainer = new Set();
  for (const it of mount.items) {
    if (it.type === "container") {
      for (const uuid of it.system?.content ?? []) inContainer.add(uuid);
    }
  }
  const containers = mount.items.filter(i =>
    i.type === "container" && !i.system?.isStored
  );
  const loose = mount.items.filter(i =>
    i.type !== "container" &&
    !i.system?.isStored &&
    !inContainer.has(i.uuid) &&
    !inContainer.has(i.id)
  );

  let totalWeight = 0;
  for (const it of mount.items) {
    const s = it?.system ?? {};
    if (s.isCarried === false || s.isStored === true) continue;
    totalWeight += (Number(s.quantity) || 0) * (Number(s.weight) || 0);
  }
  if (typeof mount.system?.calcCurrencyWeight === "function") {
    totalWeight += Number(mount.system.calcCurrencyWeight()) || 0;
  }
  totalWeight = Math.round(totalWeight * 100) / 100;
  const encMax = Number(mount.system?.derivedStats?.enc) || 0;
  const weightHTML = buildCapacityChipsHTML({
    storedWeight:   totalWeight,
    totalWeightCap: encMax
  });

  let body;
  if (containers.length === 0 && loose.length === 0) {
    body = `<div class="wou-empty-state">— Empty —</div>`;
  } else if (containers.length === 0) {
    body = `<div class="wou-popup-grid">${loose.map(mountItemSlotHTML).join("")}</div>`;
  } else {
    const looseGrid = loose.length
      ? `<div class="wou-popup-grid">${loose.map(mountItemSlotHTML).join("")}</div>`
      : `<div class="wou-empty-state">— No loose items —</div>`;
    body = `
      <div class="wou-popup-section-label">Containers</div>
      <div class="wou-popup-grid">${containers.map(mountItemSlotHTML).join("")}</div>
      <div class="wou-popup-section-label">Loose</div>
      ${looseGrid}
    `;
  }

  return `
    <div class="wou-container-popup is-mount wou-mount-popup" data-owner-actor-id="${escapeAttr(mount.id)}">
      <div class="wou-popup-header">
        <span class="wou-popup-title"><i class="fa-solid fa-horse"></i> ${escapeText(mount.name)}</span>
        ${weightHTML}
        <button type="button" class="wou-popup-close" aria-label="Close mount inventory">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
      <div class="wou-popup-body">${body}</div>
      <div class="wou-popup-hint"><i class="fa-solid fa-circle-info"></i> Carries only remains &amp; containers</div>
    </div>
  `;
}

function renderInspectionPlaceholderHTML() {
  return `<div class="wou-inv-inspection" data-inspection><div class="wou-inspection-empty">Select an item to inspect</div></div>`;
}

/* ---------- tabs ---------- */

function renderTabsHTML(actor) {
  const currentSort = getSortKey(actor, activeTab);
  const currentIcon = (INV_SORTS.find(s => s.id === currentSort) ?? INV_SORTS[0]).icon;
  return `
    <nav class="wou-inv-tabs">
      ${INV_TABS.map(t => `
        <button class="wou-inv-tab ${t.id === activeTab ? "is-active" : ""}" data-tab="${t.id}">
          <i class="fa-solid ${t.icon}"></i>${t.label}
        </button>
      `).join("")}
      <label class="wou-inv-sort" title="Sort items">
        <i class="fa-solid ${currentIcon}"></i>
        <select data-bind="sort">
          ${INV_SORTS.map(s => `<option value="${s.id}" ${s.id === currentSort ? "selected" : ""}>${s.label}</option>`).join("")}
        </select>
      </label>
    </nav>
  `;
}

/* ---------- grid ---------- */

/** Main grid: items carried directly on the character (not inside any
 *  container) — every container has its own popup now. */
function collectGridItems(actor) {
  if (!actor) return [];
  /* Single walk of actor.items to build (1) the "inside a container"
   * set and (2) the kept-items list.  Previously we walked twice — once
   * via `.filter(type==='container')` then again in the main filter.
   * On actors with many items, halving the iteration count is a clean win.
   *
   * The set is populated from EVERY container as we encounter them, so
   * later items in the same pass can check it.  This works because
   * Foundry serializes containers' content as UUIDs, and what we filter
   * against is the contained ITEM's uuid — there's no ordering dependency. */
  const inContainerIds = new Set();
  const candidates = [];
  for (const i of actor.items) {
    if (i.type === "container") {
      for (const uuid of i.system?.content ?? []) inContainerIds.add(uuid);
    }
    candidates.push(i);
  }
  /* Containers equipped on the rail live exclusively in their rail
   * slot — they don't show in the inventory grid (no duplication). */
  const railed = new Set(getRail(actor).assignments.filter(Boolean));
  let items = candidates.filter(i => {
    if (i.type === "container" && railed.has(i.id)) return false;
    const sys = i.system ?? {};
    if (sys.isStored)            return false;
    if (sys.isCarried === false) return false;
    if ((i.type === "weapon" || i.type === "shield" || i.type === "armor") && sys.equipped) return false;
    if (inContainerIds.has(i.uuid)) return false;
    if (inContainerIds.has(i.id))   return false;
    // Memorized clones (system.memorizedFrom set) are crafting-screen-only
    // shadow copies — never shown in the inventory grid.
    if (i.type === "diagrams" && i.system?.memorizedFrom) return false;
    return true;
  });

  // Tab filter.  `matches` (a predicate) takes precedence; otherwise the
  // tab declares a list of item.type values, or — for the "All" tab —
  // falls back to the union of every other tab's filter.
  const tab = INV_TABS.find(t => t.id === activeTab) ?? INV_TABS[0];
  if (typeof tab.matches === "function") items = items.filter(tab.matches);
  else if (tab.types)                    items = items.filter(i => tab.types.includes(i.type));
  else                                   items = items.filter(isPhysicalItem);

  return applySort(items, getSortKey(actor, activeTab));
}

/** Items resolved from a container's `system.content` array. */
function resolveContainerContents(actor, container) {
  if (!actor || !container) return [];
  const content = container.system?.content ?? [];
  const byUuid = new Map(actor.items.map(i => [i.uuid, i]));
  const byId   = new Map(actor.items.map(i => [i.id,   i]));
  return content.map(ref => byUuid.get(ref) ?? byId.get(ref)).filter(Boolean);
}

function renderGridHTML(items) {
  if (items.length === 0) {
    return `
      <div class="wou-inv-grid-wrap">
        <div class="wou-empty-state">— Empty —</div>
      </div>
    `;
  }
  return `
    <div class="wou-inv-grid-wrap">
      <div class="wou-inv-grid">
        ${items.map(itemSlotHTML).join("")}
      </div>
    </div>
  `;
}

/** Tiny substance-symbol badge pinned to the slot's bottom-right corner, so a
 *  component reads as its element even at the smallest icon size (the frame
 *  line colour alone is hard to tell apart when slots are small). */
function substanceCornerHTML(element) {
  if (!element) return "";
  const src = `systems/${MODULE_ID}/assets/icons/substances/${element}.svg`;
  return `<img class="wou-slot-sub" src="${escapeAttr(src)}" alt="" draggable="false" />`;
}

/** Tiny glyph pinned to a valuable slot's top-left corner that tells the
 *  player what kind of valuable it is. Books and maps share the single
 *  "Valuables" tab (they're not split into their own categories), so the
 *  glyph is the only at-a-glance subtype cue. Remains already carry a charge
 *  badge, and generic valuables get no glyph. */
function valuableSubtypeCornerHTML(item) {
  if (item?.type !== "valuable") return "";
  const meta = {
    book: { icon: "fa-book",       title: "Book" },
    map:  { icon: "fa-map",        title: "Map"  }
  }[String(item.system?.type ?? "")];
  if (!meta) return "";
  return `<span class="wou-slot-subtype" data-subtype="${escapeAttr(item.system.type)}" title="${escapeAttr(meta.title)}"><i class="fa-solid ${meta.icon}"></i></span>`;
}

function itemSlotHTML(item) {
  const sys = item.system ?? {};
  const qty = Number(sys.quantity) || 0;
  const iconHTML = item.img && !item.img.includes("mystery-man")
    ? `<img class="icon" src="${escapeAttr(item.img)}" alt="" draggable="false" />`
    : `<i class="icon fa-solid ${fallbackIconFor(item.type)}"></i>`;
  const equipped = (item.type === "weapon" || item.type === "shield" || item.type === "armor") && sys.equipped;
  // `item` class lets Foundry's ContextMenu (selector `.item`) catch
  // right-clicks here.  `draggable="true"` enables HTML5 drag-to-equip.
  const cls = ["wou-slot", "item", equipped ? "is-active" : ""].filter(Boolean).join(" ");

  // witcher-food-and-drink stores per-bottle charge counters in a flag
  // (current/max sips/servings).  Prefer that badge over plain quantity
  // for chargeable items so users can see how full a bottle is.
  const wfd = item.flags?.["witcher-food-and-drink"]?.charges;
  const isCharged = wfd && Number(wfd.max) > 0;
  const isRemains = item.type === "valuable" && item.system?.type === "remains";
  const REMAINS_MAX = 3;
  let badgeHTML = "";
  if (isRemains) {
    const cur = item.flags?.[MODULE_ID]?.remainsCharges ?? REMAINS_MAX;
    badgeHTML = `<span class="count charges is-remains" title="${cur}/${REMAINS_MAX} charges remaining">${cur}/${REMAINS_MAX}</span>`;
  } else if (isCharged) {
    const cur = Number(wfd.current ?? 0);
    const max = Number(wfd.max);
    const cat = wfd.category || "drink";
    badgeHTML = `<span class="count charges ${cat === "food" ? "is-food" : "is-drink"}" title="${cur}/${max} charges">${cur}/${max}</span>`;
  } else if (qty > 1) {
    badgeHTML = `<span class="count">${qty}</span>`;
  }

  // Component substances get a data-element hook so CSS can color the slot's
  // frame line (border) in the element's color — substance is shown purely by
  // frame line color now.
  const element = (item.type === "component" && sys.substanceType) ? sys.substanceType : "";
  const elAttr  = element ? ` data-element="${escapeAttr(element)}"` : "";

  // Rarity hook drives the slot background gradient. Every item type stores
  // this as `system.availability` (the shared RAW availability scale:
  // everywhere / common / poor / rare / witcher / na).
  const rarity = String(sys.availability ?? "").toLowerCase();
  const rarAttr = rarity ? ` data-rarity="${escapeAttr(rarity)}"` : "";

  return `
    <div class="${cls}" draggable="true" data-item-id="${escapeAttr(item.id)}"${elAttr}${rarAttr} title="${escapeAttr(item.name)}">
      ${iconHTML}
      ${substanceCornerHTML(element)}
      ${valuableSubtypeCornerHTML(item)}
      ${weaponQuickCornerHTML(item)}
      ${oilBadgeHTML(item)}
      ${badgeHTML}
    </div>
  `;
}

/** Corner badge marking a weapon as a Quick item — it may occupy the
 *  off-hand / Quick slot. Shown on the inventory tile so the player sees a
 *  weapon's quick eligibility before drawing it. */
function weaponQuickCornerHTML(item) {
  if (item?.type !== "weapon" || !item.system?.quick) return "";
  return `<span class="wou-slot-quick" title="Quick item — can occupy the off-hand / Quick slot"><i class="fa-solid fa-bolt"></i></span>`;
}

/** Top-left "oil applied" badge for weapons that carry a live oil coating.
 *  A droplet icon plus remaining minutes (or "∞" for a coating with no timed
 *  duration); the title carries the oil name + effect text. */
function oilBadgeHTML(item) {
  if (item.type !== "weapon") return "";
  const oil = readOilCoating(item);
  if (!oil) return "";
  const d = describeDuration(oil.dur ?? {});
  const timed = d.total > 0;
  const label = timed ? (d.label || "0") : "∞";
  const tip   = oil.effect ? `${oil.name} — ${oil.effect}` : oil.name;
  return `<span class="oil-badge" title="${escapeAttr(tip)}"><i class="fa-solid fa-droplet"></i><span class="oil-badge-label">${label}</span></span>`;
}

/** Compose the chip row in the popup header: slot count, total stored
 *  weight (optionally vs. cap), and per-item weight cap.  Each chip
 *  is suppressed when its data isn't relevant.  Chips ship inside a
 *  `.wou-popup-caps` flex group so the header's `space-between` keeps
 *  the title on the left and the close button on the right, with the
 *  group as one self-spaced unit in between. */
function buildCapacityChipsHTML(cap) {
  if (!cap) return "";
  const chips = [];
  const fmt = (n) => Number(n).toFixed(2).replace(/\.?0+$/, "");
  if (cap.hasSlots) {
    chips.push(`<span class="wou-popup-weight ${cap.over ? "is-over" : ""}" title="Filled / Total slots">
      <i class="fa-solid fa-grip"></i>
      <span class="cur-w">${cap.cur}</span>
      <span class="sep">/</span>
      <span class="max-w">${cap.max}</span>
    </span>`);
  }
  if (cap.storedWeight > 0 || cap.totalWeightCap > 0) {
    const overW = cap.totalWeightCap > 0 && cap.storedWeight > cap.totalWeightCap;
    chips.push(`<span class="wou-popup-weight ${overW ? "is-over" : ""}" title="Total weight stored${cap.totalWeightCap > 0 ? " / cap" : ""}">
      <i class="fa-solid fa-weight-hanging"></i>
      <span class="cur-w">${fmt(cap.storedWeight)}</span>
      ${cap.totalWeightCap > 0
        ? `<span class="sep">/</span><span class="max-w">${cap.totalWeightCap}</span>`
        : ""}
      <span class="unit">kg</span>
    </span>`);
  }
  if (cap.perItemWeightCap > 0) {
    chips.push(`<span class="wou-popup-weight" title="Per-item weight cap">
      <i class="fa-solid fa-scale-balanced"></i>
      <span class="cur-w">&le; ${cap.perItemWeightCap}</span>
      <span class="unit">kg/item</span>
    </span>`);
  }
  if (chips.length === 0) return "";
  return `<span class="wou-popup-caps">${chips.join("")}</span>`;
}

/** Render one slot-rows tile: either the stored item (via the regular
 *  itemSlotHTML), or a faded placeholder showing the row's icon as a
 *  drop target. */
function slotTileHTML(tile) {
  if (tile.item) return itemSlotHTML(tile.item);
  const icon = tilePlaceholderIcon(tile.row);
  const label = rowTooltip(tile.row);
  return `
    <div class="wou-slot is-equip-empty" title="${escapeAttr(label + " (empty)")}">
      <i class="icon fa-solid ${icon}"></i>
    </div>
  `;
}

function fallbackIconFor(type) {
  switch (type) {
    case "weapon":      return "fa-khanda";
    case "shield":      return "fa-shield";
    case "armor":       return "fa-shield-halved";
    case "alchemical":  return "fa-flask";
    case "component":   return "fa-leaf";
    case "mutagen":     return "fa-vial";
    case "diagrams":    return "fa-scroll";
    case "enhancement": return "fa-gem";
    case "die":         return "fa-dice";
    case "valuable":    return "fa-coins";
    case "food":        return "fa-utensils";
    case "note":        return "fa-feather";
    case "container":   return "fa-box";
    default:            return "fa-cube";
  }
}

/* ---------- stats ---------- */

function collectStats(actor) {
  if (!actor) {
    return {
      encCur: 0, encMax: 0, encFrac: 0, over: false,
      currency: Object.fromEntries(CURRENCY_KEYS.map(k => [k, 0])),
      name: "— no character —",
      epithet: "",
      portrait: null
    };
  }

  const sys = actor.system ?? {};

  // Carried weight — use the actor's own total (sums each item's
  // system.calcWeight() and adds coin weight via system.calcCurrencyWeight
  // (each coin = 0.001 kg)).  Fall back to a manual sum if the methods
  // aren't present on this actor flavor.
  let totalWeight;
  if (typeof actor.getTotalWeight === "function") {
    totalWeight = Number(actor.getTotalWeight()) || 0;
  } else {
    totalWeight = 0;
    for (const it of actor.items) {
      const s = it?.system ?? {};
      if (s.isCarried === false || s.isStored === true) continue;
      totalWeight += (Number(s.quantity) || 0) * (Number(s.weight) || 0);
    }
    if (typeof sys.calcCurrencyWeight === "function") {
      totalWeight += Number(sys.calcCurrencyWeight()) || 0;
    }
    totalWeight = Math.round(totalWeight * 100) / 100;
  }

  const encMax = Number(sys.derivedStats?.enc) || 0;
  const encFrac = encMax > 0 ? Math.min(1.4, totalWeight / encMax) : 0;

  const currency = Object.fromEntries(
    CURRENCY_KEYS.map(k => [k, Number(sys.currency?.[k]) || 0])
  );

  const raceItem = actor.items.find(i => i.type === "race");
  return {
    encCur: totalWeight,
    encMax,
    encFrac,
    over: totalWeight > encMax,
    currency,
    name: actor.name,
    epithet: raceItem?.name ?? "",
    portrait: actor.img && !actor.img.includes("mystery-man") ? actor.img : null
  };
}

function renderStatsHTML(stats) {
  const fillPct = Math.min(100, Math.round(stats.encFrac * 100));
  return `
    <div class="wou-stats-row">
      <div class="wou-stat-block ${stats.over ? "is-over" : ""}">
        <div class="wou-stat-key">Encumbrance</div>
        <div class="wou-stat-val">
          <i class="fa-solid fa-weight-hanging"></i>
          ${stats.encCur}<span class="max">/ ${stats.encMax}</span>
        </div>
        <div class="wou-enc-bar"><div class="fill" style="width:${fillPct}%"></div></div>
      </div>
    </div>
  `;
}

function renderCurrencyHTML(currency) {
  return `
    <div class="wou-currency">
      <div class="wou-section-label">
        <i class="fa-solid fa-coins"></i>&nbsp;Coins
      </div>
      <div class="wou-currency-grid">
        ${CURRENCY_KEYS.map(k => `
          <div class="wou-cur-cell" title="${capitalize(k)}">
            <span class="cur-coin">${CURRENCY_LABEL[k]}</span>
            <input type="number" min="0" step="1" data-currency-key="${k}" value="${currency[k]}" />
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function capitalize(s) {
  return String(s).charAt(0).toUpperCase() + String(s).slice(1);
}

/* ---------- weapons + portrait + armor ---------- */

function renderWeaponsAndPortraitHTML(actor, stats) {
  const armorTarget  = getEquipSlotCount(actor, "armor");
  const equippedArmor   = actor ? actor.items.filter(i => i.type === "armor"  && i.system?.equipped) : [];
  const armorSlots  = padSlots(equippedArmor,   armorTarget);

  const punch = actor?.system?.derivedStats?.punch ?? "1d6";
  const kick  = actor?.system?.derivedStats?.kick  ?? "1d6";

  return `
    <div class="wou-weap-port">
      <div class="wou-weapons">
        <div class="wou-section-label">Weapons${renderSwitchHandsButtonHTML(actor)}</div>
        <div class="wou-weapons-grid wou-hand-grid">
          ${renderWeaponHandSlotsHTML(actor)}
        </div>
        <div class="wou-unarmed" title="Brawling — unarmed strike damage">
          <span class="wou-unarmed-cell"><i class="fa-solid fa-hand-fist"></i> ${escapeText(String(punch))}</span>
          <span class="wou-unarmed-cell"><i class="fa-solid fa-shoe-prints"></i> ${escapeText(String(kick))}</span>
        </div>
      </div>

      <div class="wou-portrait">
        ${stats.portrait ? `<img class="portrait-img" src="${escapeAttr(stats.portrait)}" alt="" />` : ""}
        <div class="nameplate">
          <div class="name">${escapeText(stats.name)}</div>
          <div class="epithet">${escapeText(stats.epithet)}</div>
        </div>
      </div>

      <div class="wou-mount-attach">
        <div class="wou-section-label wou-mount-label">${escapeText(getMountActor(actor)?.name ?? "Mount")}</div>
        <div class="wou-mount-row">
          ${renderMountSlotHTML(actor)}
        </div>
        ${renderMountStatsHTML(actor)}
      </div>

      <div class="wou-armor">
        <div class="wou-section-label">Armor</div>
        <div class="wou-armor-grid">
          ${armorSlots.map(item => equipSlotHTML(item, "armor")).join("")}
        </div>
        <div class="wou-equip-controls" data-equip-controls="armor">
          <button type="button" data-action="add"    title="Add armor slot">+</button>
          <button type="button" data-action="remove" title="Remove armor slot">−</button>
        </div>
      </div>
    </div>
  `;
}

function renderMountSlotHTML(actor) {
  const linked = getMountActor(actor);
  if (!linked) {
    return `<div class="wou-equip wou-equip-add" data-action="mount-attach" title="Click to pick · or drop an actor here">
      <i class="fa-solid fa-horse"></i>
    </div>`;
  }
  const img = linked.img && !linked.img.includes("mystery-man")
    ? `<img class="icon" src="${escapeAttr(linked.img)}" alt="" draggable="false" />`
    : `<i class="fa-solid fa-horse"></i>`;
  return `<div class="wou-equip wou-mount-linked" data-action="mount-attach" title="${escapeAttr(linked.name)} — click to open inventory">
    ${img}
    <button type="button" class="wou-mount-unlink" data-action="mount-unlink" aria-label="Unlink mount" title="Unlink">
      <i class="fa-solid fa-xmark"></i>
    </button>
  </div>`;
}

/**
 * Stats panel that sits below the mount slot once a mount actor is linked.
 * Four cells, in order:
 *   - Dex + Ath: character's Dex + Athletics dice-pool sum
 *   - SPD       : linked monster's own `system.stats.spd.value`
 *   - Ctrl Mod  : linked monster's `system.mount.controlBonus`
 *                 (also applied to the character's Riding skill via a
 *                  managed Active Effect — see sheets/character-mount.js)
 *   - HP        : linked actor's derivedStats.hp current / max, with a
 *                 thin progress bar.
 */
function renderMountStatsHTML(actor) {
  if (!actor) return "";
  const linked = getMountActor(actor);
  if (!linked) return "";

  const dexStat   = Number(actor.system?.stats?.dex?.value) || 0;
  const athletics = Number(
    actor.system?.skills?.dex?.athletics?.modifiedValue
    ?? actor.system?.skills?.dex?.athletics?.value
  ) || 0;
  const dexAth = dexStat + athletics;

  /* SPD is the linked monster's own Speed stat; Ctrl is the control bonus
   * from its `system.mount.controlBonus` field (the same value applied to
   * the rider's Riding skill — see sheets/character-mount.js). */
  const speed = Number(linked.system?.stats?.spd?.value) || 0;
  const ctrl  = Number(linked.system?.mount?.controlBonus) || 0;

  const hpCur = Number(linked.system?.derivedStats?.hp?.value) || 0;
  const hpMax = Number(linked.system?.derivedStats?.hp?.unmodifiedMax)
             || Number(linked.system?.derivedStats?.hp?.max)
             || 0;
  const safeMax = hpMax > 0 ? hpMax : Math.max(hpCur, 1);

  const fmt = (n) => (n >= 0 ? `+${n}` : `${n}`);

  return `
    <div class="wou-mount-stats" data-mount-actor-id="${escapeAttr(linked.id)}">
      <div class="wms-cell">
        <div class="wms-label">Ath</div>
        <div class="wms-value">${fmt(dexAth)}</div>
      </div>
      <div class="wms-cell">
        <div class="wms-label">SPD</div>
        <div class="wms-value">${escapeText(String(speed))}</div>
      </div>
      <div class="wms-cell">
        <div class="wms-label">Ctrl</div>
        <div class="wms-value ${ctrl >= 0 ? 'is-pos' : 'is-neg'}">${fmt(ctrl)}</div>
      </div>
      <div class="wms-cell wms-cell-hp">
        <div class="wms-label">HP</div>
        <div class="wms-value">${hpCur}</div>
      </div>
    </div>
  `;
}

function equipSlotHTML(item, kind /* "armor" */) {
  if (!item) {
    return `<div class="wou-equip" data-equip-type="${kind}" data-item-id="" title="Empty"></div>`;
  }
  const iconHTML = item.img && !item.img.includes("mystery-man")
    ? `<img class="icon" src="${escapeAttr(item.img)}" alt="" draggable="false" />`
    : `<i class="fa-solid ${fallbackIconFor(item.type)}"></i>`;
  const rarity = String(item.system?.availability ?? "").toLowerCase();
  const rarAttr = rarity ? ` data-rarity="${escapeAttr(rarity)}"` : "";
  return `<div class="wou-equip has-item item" data-equip-type="${kind}" data-item-id="${escapeAttr(item.id)}"${rarAttr} title="${escapeAttr(item.name)}">${iconHTML}${oilBadgeHTML(item)}</div>`;
}

/* The three fixed weapon hand-slots: Main, Off-hand, Quick. Each is a drop
 * target tagged with `data-equip-slot`. The internal keys stay right/left/quick
 * (stored in system.slot); only the labels read Main / Off-hand. A two-handed
 * weapon occupies both Main and Off-hand (it appears in both, tagged "2H"); the
 * Quick slot shows a quick weapon or an equipped shield. */
const HAND_SLOT_DEFS = [
  { key: "right", short: "M", title: "Main hand — drag a one-handed weapon here" },
  { key: "left",  short: "O", title: "Off-hand — drag a one-handed weapon here" },
  { key: "quick", short: "Q", title: "Quick / off-hand — quick weapons & shields only" }
];

function renderWeaponHandSlotsHTML(actor) {
  const eq = actor ? actor.items.filter(i => i.system?.equipped) : [];
  const pick = (...occs) => eq.find(i => occs.includes(occupancyOf(i)));
  const byKey = {
    right: pick("right", "both"),
    left:  pick("left",  "both"),
    quick: pick("quick")
  };
  // The Quick slot represents resting a two-handed weapon one-handed to throw —
  // so only surface it when a 2H weapon is equipped. Keep it visible if it's
  // already holding something (e.g. a shield) so we never hide an occupied slot.
  const hasTwoHanded = eq.some(i => occupancyOf(i) === "both");
  const showQuick = hasTwoHanded || !!byKey.quick;
  return HAND_SLOT_DEFS
    .filter(({ key }) => key !== "quick" || showQuick)
    .map(({ key, short, title }) =>
      weaponHandSlotHTML(byKey[key], key, short, title)).join("");
}

/* Switch-Hands toggle: swaps the Main and Off-hand weapons. Hidden when a
 * two-handed weapon is equipped (it fills both hands, nothing to swap) and
 * when neither Main nor Off-hand holds anything. Costs a combat action. */
function renderSwitchHandsButtonHTML(actor) {
  if (!actor) return "";
  const eq = actor.items.filter(i => i.system?.equipped);
  if (eq.some(i => occupancyOf(i) === "both")) return "";
  const hasMain = eq.some(i => occupancyOf(i) === "right");
  const hasOff  = eq.some(i => occupancyOf(i) === "left");
  if (!hasMain && !hasOff) return "";
  return `<button type="button" class="wou-switch-hands" data-action="switch-hands" title="Switch hands — swap Main and Off-hand (costs an action)"><i class="fa-solid fa-right-left"></i></button>`;
}

/* Swap the Main-hand (right) and Off-hand (left) weapons. No-op with a
 * two-handed weapon equipped or with nothing in either hand. Costs one combat
 * action; both slot moves go in a single bypassed update (see preUpdateItem). */
async function switchWeaponHands(actor) {
  if (!actor) return;
  const eq = actor.items.filter(i => i.system?.equipped);
  if (eq.some(i => occupancyOf(i) === "both")) return;
  const main = eq.find(i => occupancyOf(i) === "right");
  const off  = eq.find(i => occupancyOf(i) === "left");
  if (!main && !off) return;
  if (!canSpendCombatAction(actor)) return;

  const updates = [];
  if (main) updates.push({ _id: main.id, "system.slot": "left"  });
  if (off)  updates.push({ _id: off.id,  "system.slot": "right" });
  await actor.updateEmbeddedDocuments("Item", updates, { wouSwapHands: true });
  await chargeCombatAction(actor, "Switch hands");
}

function weaponHandSlotHTML(item, slotKey, short, title) {
  if (!item) {
    return `<div class="wou-equip wou-equip-hand" data-equip-type="weapon" data-equip-slot="${slotKey}" data-item-id="" title="${escapeAttr(title)}"><span class="wou-slot-tag is-empty">${short}</span></div>`;
  }
  const iconHTML = item.img && !item.img.includes("mystery-man")
    ? `<img class="icon" src="${escapeAttr(item.img)}" alt="" draggable="false" />`
    : `<i class="fa-solid ${fallbackIconFor(item.type)}"></i>`;
  const twoH = item.system?.hands === "two";
  const tag  = twoH ? "2H" : short;
  const sheath = item.type === "weapon" ? sheathBadgeHTML() : "";
  const rarity = String(item.system?.availability ?? "").toLowerCase();
  const rarAttr = rarity ? ` data-rarity="${escapeAttr(rarity)}"` : "";
  return `<div class="wou-equip wou-equip-hand has-item item${twoH ? " is-two-handed" : ""}" data-equip-type="weapon" data-equip-slot="${slotKey}" data-item-id="${escapeAttr(item.id)}"${rarAttr} title="${escapeAttr(item.name)}">${iconHTML}<span class="wou-slot-tag">${tag}</span>${sheath}${oilBadgeHTML(item)}</div>`;
}

/* Sheath chip in the corner of an equipped weapon slot. Click returns the
 * weapon to the container it was drawn from, or any container the actor
 * has, or just unequips it. */
function sheathBadgeHTML() {
  return `<span class="wou-sheath-badge" title="Sheathe (return to container)"><i class="fa-solid fa-box-archive"></i></span>`;
}

/* Occupancy = which hand-slot(s) an equipped item takes up, for exclusivity,
 * dock display, and the equip rail. Derived (not stored): a two-handed
 * weapon occupies BOTH hands; a one-handed weapon sits in its `slot`;
 * shields are off-hand (quick). Returns "right" | "left" | "both" | "quick"
 * (or null for items that don't hold a hand). */
export function occupancyOf(item) {
  if (!item) return null;
  if (item.type === "weapon" || item.type === "shield") {
    if (item.system?.hands === "two") return "both";
    const s = item.system?.slot;
    return ["right", "left", "quick"].includes(s) ? s : "right";
  }
  if (item.type === "armor" && item.system?.location === "Shield") return "quick";
  return null;
}

/* A quick item may occupy the off-hand Quick slot: quick-flagged weapons
 * (throwing knives, daggers) and equipped alchemicals. Shields are NOT quick —
 * they take a full hand slot. (Legacy armor-modeled shields stay quick.) */
export function isQuickItem(item) {
  if (!item) return false;
  if (item.type === "weapon")     return !!item.system?.quick;
  if (item.type === "armor")      return item.system?.location === "Shield";
  if (item.type === "alchemical") return true;
  return false;
}

/* A shield-type item: the dedicated "shield" type, or a legacy armor-modeled
 * shield (location "Shield"). */
export function isShieldItem(item) {
  return item?.type === "shield"
    || (item?.type === "armor" && item?.system?.location === "Shield");
}

/* The occupancy an item WOULD take if dropped into `slot` (right/left/quick),
 * or null if that slot is illegal for the item (e.g. a non-quick weapon into
 * Quick). Two-handed weapons ignore the slot and always occupy both hands. */
function occupancyForSlot(item, slot) {
  if (item?.type === "weapon" || item?.type === "shield") {
    if (item.system?.hands === "two") return "both";
    if (!["right", "left", "quick"].includes(slot)) return null;
    if (slot === "quick" && !item.system?.quick) return null;
    return slot;
  }
  // Legacy armor-shields / alchemicals are off-hand only.
  if (isQuickItem(item)) return "quick";
  return null;
}

/* Pick the slot to equip an item into: prefer its remembered `slot` (so
 * drawing returns it to its last hand), else Right, then Left, then Quick
 * (quick items only). Falls back to the first conflicting candidate so the
 * caller's conflict check can surface a useful message. */
function autoEquipSlot(actor, item) {
  const quick = isQuickItem(item);
  const remembered = item?.system?.slot;
  const order = [];
  if (["right", "left", "quick"].includes(remembered)) order.push(remembered);
  order.push("right", "left");
  if (quick) order.push("quick");
  const seen = new Set();
  for (const s of order) {
    if (seen.has(s)) continue;
    seen.add(s);
    const occ = occupancyForSlot(item, s);
    if (!occ) continue;
    if (checkEquipConflicts(actor, item.id, occ, getPendingEquips(actor.id)).ok) return s;
  }
  return ["right", "left", "quick"].includes(remembered) ? remembered : "right";
}

/**
 * Set a weapon's drawn hand, enforcing the equip-exclusivity rule:
 *   - 'both' conflicts with any other weapon currently on left, right, or both.
 *   - 'left' conflicts with any other weapon currently on left or both.
 *   - 'right' conflicts with any other weapon currently on right or both.
 * Conflicting weapons are unequipped and their hand is reset to 'none'.
 *
 * Also marks the target weapon as equipped (a click on the badge implies
 * the player wants this weapon drawn).
 */
/* Evaluate whether `targetHand` is a legal equip for an item. Returns
 * `{ ok: true }` on success, or `{ ok: false, reason, conflicts }` with
 * either the rule code or the conflicting weapon docs. The caller turns
 * the failure into a user-facing notification via describeEquipFailure. */
const VALID_HANDS = ["left", "right", "both", "quick"];   // occupancy values
const VALID_SLOTS = ["right", "left", "quick"];           // equip-slot values

/* Per-tick map of pending equips so cross-document batched updates don't
 * race past the conflict check. preUpdate/preCreate fire one-by-one with
 * stale doc state; without this, two equips in the same `updateEmbedded
 * Documents` batch could both see "no conflict" and both commit.
 *
 * Entries are cleared on the next microtask — long enough for all hooks
 * in the same batch to see siblings, short enough not to leak. */
const _pendingEquips = new Map(); // actorId -> Array<{ itemId, hand }>
function recordPendingEquip(actorId, itemId, hand) {
  if (!actorId || !VALID_HANDS.includes(hand)) return;
  let list = _pendingEquips.get(actorId);
  if (!list) {
    list = [];
    _pendingEquips.set(actorId, list);
    Promise.resolve().then(() => _pendingEquips.delete(actorId));
  }
  // Replace any existing pending entry for the same item.
  const idx = list.findIndex(p => p.itemId === itemId);
  if (idx >= 0) list[idx] = { itemId, hand };
  else list.push({ itemId, hand });
}
function getPendingEquips(actorId) {
  return _pendingEquips.get(actorId) ?? [];
}

/* Yield every item on the actor that occupies a hand slot for exclusivity
 * purposes: weapons (with their `hands` value) and shields (treated as a
 * Quick-equivalent — they're off-hand items and coexist with 2H per the
 * same "briefly rested" rule the user gave for Quick). */
function* iterateHandedItems(actor) {
  if (!actor?.items) return;
  for (const item of actor.items) {
    if (!item.system?.equipped) continue;
    const hand = occupancyOf(item);   // "right"|"left"|"both"|"quick"|null
    if (hand) yield { item, hand };
  }
}

function checkEquipConflicts(actor, itemId, targetHand, pending = [], ignoreIds = []) {
  const skip = new Set([itemId, ...ignoreIds]);
  const conflictMap = {
    both:  new Set(["left", "right", "both"]),
    left:  new Set(["left", "both"]),
    right: new Set(["right", "both"]),
    // Quick is the off-hand slot. Pairwise it only conflicts with another
    // off-hand item (Quick weapon OR Shield — see iterateHandedItems).
    // The "no free hand" rule is enforced below.
    quick: new Set(["quick"]),
  };
  const conflictsWith = conflictMap[targetHand];
  if (!conflictsWith) return { ok: false, reason: "invalid-hand", conflicts: [] };

  const conflicts = [];
  let leftBusy = false, rightBusy = false, quickBusy = null, shieldInHand = false;

  // Committed state on the actor (weapons + shields).
  for (const { item, hand } of iterateHandedItems(actor)) {
    if (skip.has(item.id)) continue;
    if (conflictsWith.has(hand)) conflicts.push(item);
    if (hand === "left")  leftBusy = true;
    if (hand === "right") rightBusy = true;
    if (hand === "quick") quickBusy = item;
    if ((hand === "left" || hand === "right" || hand === "both") && isShieldItem(item)) shieldInHand = true;
  }

  // Pending equips from the same tick (batched updates).
  for (const p of pending) {
    if (p.itemId === itemId) continue;
    const synthetic = { id: p.itemId, name: "(pending)" };
    if (conflictsWith.has(p.hand)) conflicts.push(synthetic);
    if (p.hand === "left")  leftBusy = true;
    if (p.hand === "right") rightBusy = true;
    if (p.hand === "quick") quickBusy = quickBusy ?? synthetic;
  }

  if (targetHand === "quick" && leftBusy && rightBusy) {
    // Manticore: a quick item may still take the off-hand slot while a shield
    // is held — even with both hands otherwise occupied.
    const quickWithShield = (Number(actor?.system?.combatMods?.quickItemWithShield) || 0) > 0;
    if (!(shieldInHand && quickWithShield)) {
      return { ok: false, reason: "no-free-hand-for-quick", conflicts };
    }
  }
  if ((targetHand === "left"  && rightBusy && quickBusy) ||
      (targetHand === "right" && leftBusy  && quickBusy)) {
    return { ok: false, reason: "quick-blocks-offhand", conflicts: [quickBusy] };
  }
  if (conflicts.length > 0) {
    return { ok: false, reason: "pairwise-conflict", conflicts };
  }
  return { ok: true };
}

function describeEquipFailure(itemName, result) {
  const names = (result.conflicts ?? []).map(c => c.name ?? "(pending)").join(", ");
  switch (result.reason) {
    case "quick-only":
      return `Can't put ${itemName} in the Quick slot — it only holds quick items (throwing knives, daggers, shields).`;
    case "invalid-slot":
      return `Can't equip ${itemName} there.`;
    case "no-free-hand-for-quick":
      return `Can't equip ${itemName} as Quick — no free hand. Sheath or drop a weapon first.`;
    case "quick-blocks-offhand":
      return `Can't equip ${itemName} — your off-hand (${names}) is already taken. Sheath or drop it first.`;
    case "pairwise-conflict":
      return `Can't equip ${itemName} — already wielding ${names}. Sheath or drop first.`;
    default:
      return `Can't equip ${itemName}.`;
  }
}

/* Equip an item into `slot` (right/left/quick). The occupancy it actually
 * takes is derived (two-handed → both). Writes `system.slot` on weapons so
 * the choice is remembered for the next draw. Refuses on conflict or an
 * illegal slot — the user must sheath/drop the blocker themselves. */
async function assignSlot(actor, itemId, slot) {
  const target = actor?.items?.get(itemId);
  if (!target) return false;

  const occ = occupancyForSlot(target, slot);
  if (!occ) {
    const reason = (slot === "quick" && (target.type === "weapon" || target.type === "shield") && !target.system?.quick)
      ? "quick-only" : "invalid-slot";
    ui?.notifications?.warn?.(describeEquipFailure(target.name, { reason, conflicts: [] }));
    return false;
  }

  // Consult pending equips so two rapid calls in the same tick see each other.
  const check = checkEquipConflicts(actor, itemId, occ, getPendingEquips(actor.id));
  if (!check.ok) {
    ui?.notifications?.warn?.(describeEquipFailure(target.name, check));
    return false;
  }

  recordPendingEquip(actor.id, itemId, occ);
  const update = { "system.equipped": true };
  // Remember the slot on weapons/shields (two-handed keeps its prior memory).
  if ((target.type === "weapon" || target.type === "shield") && target.system?.hands !== "two") {
    update["system.slot"] = slot;
  }
  await target.update(update);
  return true;
}

function padSlots(items, target) {
  const n = Math.max(target, items.length);
  const out = items.slice();
  while (out.length < n) out.push(null);
  return out;
}

function getEquipSlotCount(actor, kind) {
  if (!actor) return DEFAULT_EQUIP_SLOTS[kind];
  try {
    const raw = actor.getFlag(MODULE_ID, `equipSlots.${kind}`);
    if (typeof raw === "number" && raw >= 0) return raw;
  } catch { /* ignore */ }
  return DEFAULT_EQUIP_SLOTS[kind];
}

async function setEquipSlotCount(actor, kind, value) {
  if (!actor) return;
  const equipped = actor.items.filter(i => i.type === (kind === "weapons" ? "weapon" : "armor") && i.system?.equipped).length;
  const clamped = Math.max(equipped, Math.min(20, value));
  await actor.setFlag(MODULE_ID, `equipSlots.${kind}`, clamped);
}

/* =========================================================================
   WIRING — delegated event handlers for the freshly-rendered DOM
   ========================================================================= */

function wireContainerRail(actor) {
  /* Multiple `[data-track="containers"]` tracks exist now (one for the
   * player stack, one for the mount stack).  Delegate from the shared
   * `.wou-containers` parent so a single listener covers both. */
  const rail = invEl.querySelector(".wou-containers");
  if (!rail) return;
  rail.addEventListener("click", (ev) => {
    const slot = ev.target.closest(".wou-slot");
    if (!slot || !rail.contains(slot)) return;
    const id = slot.dataset.containerId;
    if (!id) return;
    const ownerId = slot.dataset.ownerActorId || actor?.id || null;
    /* Toggle: clicking the already-open container's slot closes it. */
    const sameAsOpen = openContainerPopupId === id
                    && (openContainerActorId ?? actor?.id) === ownerId;
    openContainerPopupId = sameAsOpen ? null : id;
    openContainerActorId = sameAsOpen ? null : (ownerId === actor?.id ? null : ownerId);
    popupAnchorId = openContainerPopupId;
    render();
    positionContainerPopup();
  });

  // Container slots are draggable using Foundry's native Item payload
  // (drop on hotbar → make a macro), plus a private payload that we use
  // to detect intra-rail reorder drops below.
  rail.addEventListener("dragstart", (ev) => {
    const slot = ev.target.closest(".wou-slot");
    if (!slot || !rail.contains(slot)) return;
    const id = slot.dataset.itemId;
    if (!id) return;
    const ownerId = slot.dataset.ownerActorId || actor?.id;
    const owner = game.actors?.get?.(ownerId) ?? actor;
    const item = owner?.items?.get(id);
    if (!item) return;
    ev.dataTransfer.setData("text/plain", JSON.stringify({
      type: "Item",
      uuid: item.uuid
    }));
    /* Reorder signal — paired with the source owner id so we only treat
     * the drop as a reorder when it's the same actor's rail.  Mounts and
     * player stacks reorder independently. */
    ev.dataTransfer.setData("application/x-wou-reorder-container", id);
    ev.dataTransfer.setData("application/x-wou-reorder-owner", ownerId);
    ev.dataTransfer.effectAllowed = "copyMove";
    slot.classList.add("is-reorder-source");
  });
  rail.addEventListener("dragend", (ev) => {
    rail.querySelectorAll(".is-reorder-source, .is-reorder-target-before, .is-reorder-target-after")
        .forEach(el => el.classList.remove("is-reorder-source", "is-reorder-target-before", "is-reorder-target-after"));
  });

  /* Helper — does the in-flight drag come from a container slot on the
   * SAME owner's rail?  If yes, treat the drop as a reorder. */
  const isReorderDrag = (ev, ownerId) => {
    const reorderId = ev.dataTransfer?.getData?.("application/x-wou-reorder-container");
    const reorderOwner = ev.dataTransfer?.getData?.("application/x-wou-reorder-owner");
    return !!reorderId && reorderOwner === ownerId;
  };

  // Drop items directly onto a closed container slot — adds the item to
  // that container without having to open it first.  When the drag came
  // from another container in the same rail, the drop is a REORDER
  // (decided by mouse position: top half = "place before", bottom half
  // = "place after") instead of a stash-into-container.
  rail.addEventListener("dragover", (ev) => {
    const slot = ev.target.closest(".wou-slot");
    if (!slot || !rail.contains(slot)) return;
    /* Empty rail slot — accept drops to equip a container here. */
    if (slot.classList.contains("wou-rail-empty")) {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
      slot.classList.add("is-drop-target");
      return;
    }
    if (!slot.dataset.containerId) return;
    const ownerId = slot.dataset.ownerActorId || actor?.id;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";

    /* Don't show ANY hint on the slot being dragged itself. */
    if (slot.classList.contains("is-reorder-source")) return;

    if (isReorderDrag(ev, ownerId)) {
      const rect = slot.getBoundingClientRect();
      const placeBefore = (ev.clientY - rect.top) < rect.height / 2;
      slot.classList.toggle("is-reorder-target-before", placeBefore);
      slot.classList.toggle("is-reorder-target-after", !placeBefore);
      slot.classList.remove("is-drop-target");
    } else {
      slot.classList.add("is-drop-target");
    }
  });
  rail.addEventListener("dragleave", (ev) => {
    const slot = ev.target.closest(".wou-slot");
    slot?.classList?.remove("is-drop-target", "is-reorder-target-before", "is-reorder-target-after");
  });
  rail.addEventListener("drop", async (ev) => {
    const slot = ev.target.closest(".wou-slot");
    if (!slot || !rail.contains(slot)) return;
    ev.preventDefault();
    slot.classList.remove("is-drop-target", "is-reorder-target-before", "is-reorder-target-after");

    const ownerId = slot.dataset.ownerActorId || actor?.id;
    const owner = game.actors?.get?.(ownerId) ?? actor;
    if (!owner) return;

    /* EQUIP-TO-RAIL path — drop on an empty rail slot.  We only accept
     * an internal drag of a container item; everything else is ignored. */
    if (slot.classList.contains("wou-rail-empty")) {
      const slotIdx = Number(slot.dataset.railSlot);
      if (!Number.isFinite(slotIdx)) return;

      const id = ev.dataTransfer.getData("application/x-wou-item");
      if (id) {
        const it = owner.items.get(id);
        if (it?.type === "container") {
          if (!canSpendCombatAction(owner)) return;
          await setRailAssignment(owner, slotIdx, id);
          await chargeCombatAction(owner, `Equip: ${it.name}`);
        }
        return;
      }

      // Foreign drag (compendium / sidebar) — only proceed if the source
      // resolves to a container item that already lives on this actor.
      const raw = ev.dataTransfer.getData("text/plain");
      if (!raw) return;
      try {
        const data = JSON.parse(raw);
        if (data?.type !== "Item" || !data.uuid) return;
        const doc = await fromUuid(data.uuid);
        if (doc?.type === "container" && doc?.parent?.id === owner.id) {
          if (!canSpendCombatAction(owner)) return;
          await setRailAssignment(owner, slotIdx, doc.id);
          await chargeCombatAction(owner, `Equip: ${doc.name}`);
        }
      } catch { /* ignore parse errors */ }
      return;
    }

    const containerId = slot.dataset.containerId;
    if (!containerId) return;

    /* REORDER path — drag came from a sibling container on the same rail.
     * Reorder = swap slot assignments so each side keeps its index. */
    const reorderId = ev.dataTransfer.getData("application/x-wou-reorder-container");
    if (reorderId && isReorderDrag(ev, ownerId) && reorderId !== containerId) {
      const r = getRail(owner);
      const a = r.assignments.indexOf(reorderId);
      const b = r.assignments.indexOf(containerId);
      if (a >= 0 && b >= 0) {
        await setRailAssignment(owner, a, containerId);
        await setRailAssignment(owner, b, reorderId);
      }
      return;
    }

    // Foreign drag — validate capacity BEFORE creating the item so a full
    // container doesn't strand a freshly-created copy on the grid.
    if (!ev.dataTransfer.getData("application/x-wou-source")) {
      const container = owner.items.get(containerId);
      if (!container) return;
      const peek = await peekForeignItem(ev);
      if (peek && !fitsInContainer(container, peek)) {
        ui?.notifications?.warn?.(overflowWarning(container, peek));
        return;
      }
      const created = await tryForeignItemDrop(ev, owner);
      if (!created) return;
      if (!fitsInContainer(container, created)) {
        ui?.notifications?.warn?.(overflowWarning(container, created));
        return;
      }
      const content = container.system?.content ?? [];
      if (!content.includes(created.uuid)) {
        await container.update({ "system.content": [...content, created.uuid] });
      }
      if (!created.system?.isStored) await created.update({ "system.isStored": true });
      return;
    }

    // Internal drag from this overlay (grid / equip / another container).
    const id     = ev.dataTransfer.getData("application/x-wou-item");
    const source = ev.dataTransfer.getData("application/x-wou-source");
    if (!id) return;
    if (id === containerId) return;
    /* Dragging a CONTAINER onto an occupied slot equips it there (the
     * previously-occupying container falls back to the grid). */
    const dragged = owner.items.get(id);
    if (dragged?.type === "container") {
      const slotIdx = Number(slot.dataset.railSlot);
      if (Number.isFinite(slotIdx)) {
        if (!canSpendCombatAction(owner)) return;
        await setRailAssignment(owner, slotIdx, id);
        await chargeCombatAction(owner, `Equip: ${dragged.name}`);
      }
      return;
    }
    await moveItemToContainer(owner, id, containerId, source, { spendAction: true });
  });

  // Mount-attach slot (portrait column): drop an Actor to link, right-click
  // to unlink, click to open the actor sheet.
  wireMountAttach(actor);
}

/* ---------- mount link ---------- */

function wireMountAttach(actor) {
  const mountEl = invEl.querySelector('[data-action="mount-attach"]');
  if (!mountEl || !actor) return;
  const linked = getMountActor(actor);

  mountEl.addEventListener("click", async (ev) => {
    /* Unlink × button — short-circuit the link/open click. */
    if (ev.target.closest('[data-action="mount-unlink"]')) {
      ev.stopPropagation();
      if (!linked) return;
      await actor.unsetFlag(MODULE_ID, MOUNT_FLAG);
      if (openContainerActorId === linked.id) {
        openContainerPopupId = null;
        openContainerActorId = null;
      }
      mountPopupOpen = false;
      render();
      return;
    }
    /* Linked → toggle the mount's inventory popup (container-style). */
    if (linked) {
      mountPopupOpen = !mountPopupOpen;
      /* One popup at a time — close any open container popup so the two
       * don't fight over the shared `.wou-container-popup` selector. */
      if (mountPopupOpen) {
        openContainerPopupId = null;
        openContainerActorId = null;
        popupAnchorId = null;
      }
      render();
      if (mountPopupOpen) positionMountPopup();
      return;
    }
    /* Empty → owned-actor picker. */
    await openMountPicker(actor);
  });

  mountEl.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "link";
    mountEl.classList.add("is-drop-target");
  });
  mountEl.addEventListener("dragleave", () => mountEl.classList.remove("is-drop-target"));
  mountEl.addEventListener("drop", async (ev) => {
    ev.preventDefault();
    mountEl.classList.remove("is-drop-target");
    const raw = ev.dataTransfer.getData("text/plain")
             || ev.dataTransfer.getData("application/json");
    if (!raw) return;
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    if (data?.type !== "Actor" || !data.uuid) return;
    let dropped;
    try { dropped = await fromUuid(data.uuid); } catch { return; }
    if (!dropped) return;
    if (dropped.id === actor.id) {
      ui?.notifications?.warn?.("Can't link the character to itself.");
      return;
    }
    /* Only Monster actors flagged as mounts can be linked — `isMount` is set
     * on the monster sheet's Mount section (system.mount.isMount). */
    if (dropped.type !== "monster") {
      ui?.notifications?.warn?.(`Only Monster actors can be linked as a mount (got "${dropped.type}").`);
      return;
    }
    if (!dropped.system?.mount?.isMount) {
      ui?.notifications?.warn?.(`"${dropped.name}" isn't a mount — check "Mount" on its sheet first.`);
      return;
    }
    await actor.setFlag(MODULE_ID, MOUNT_FLAG, dropped.id);
    render();
  });
}

/* ---------- mount linking ---------- */

/** Modal picker — lists every actor the current user owns (excluding the
 *  player's own character) so they can attach one as a mount/companion. */
async function openMountPicker(character) {
  if (!character?.isOwner) {
    ui?.notifications?.error?.("You don't have OWNER permission on your character — can't assign a mount.");
    return;
  }
  const owned = (game.actors?.contents ?? [])
    .filter(a => a.id !== character.id && a.isOwner && a.type === "monster" && a.system?.mount?.isMount)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!owned.length) {
    ui?.notifications?.warn?.("You don't own any mounts. Check \"Mount\" on a monster's sheet to make it rideable.");
    return;
  }

  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2) return;

  const options = owned.map(a =>
    `<option value="${escapeAttr(a.id)}">${escapeText(a.name)} (${escapeText(a.type)})</option>`
  ).join("");

  const content = `
    <div class="form-group">
      <label for="wou-mount-pick">Actor:</label>
      <select id="wou-mount-pick" name="mountActorId" style="width:100%;">
        ${options}
      </select>
    </div>
  `;

  const chosen = await DialogV2.wait({
    window: { title: "Link Mount / Companion" },
    content,
    buttons: [
      {
        action: "link",
        label: "Link",
        default: true,
        callback: (event, button) => {
          const root = button.form ?? button.closest?.("form") ?? document;
          return root.querySelector?.('select[name="mountActorId"]')?.value ?? null;
        }
      },
      { action: "cancel", label: "Cancel" }
    ],
    rejectClose: false
  }).catch(() => null);

  if (!chosen || chosen === "cancel" || typeof chosen !== "string") return;
  /* setFlag updates the CHARACTER doc — needs OWNER on the player's own
   * character (not the mount). Wrap so we surface the actual permission
   * error instead of failing silently on the next render. */
  try {
    await character.setFlag(MODULE_ID, MOUNT_FLAG, chosen);
  } catch (err) {
    console.error(`${MODULE_ID} | failed to link mount`, err, { characterId: character.id, mountId: chosen });
    ui?.notifications?.error?.(`Couldn't link mount: ${err?.message ?? err}`);
    return;
  }
  render();
}

/* Anchor the mount popup to the mount circle, opening leftward over the
 * grid (same orientation logic as positionContainerPopup). */
function positionMountPopup() {
  const popup  = invEl?.querySelector(".wou-mount-popup");
  const anchor = invEl?.querySelector(".wou-mount-linked");
  if (!popup || !anchor) return;
  const slotRect = anchor.getBoundingClientRect();
  const invRect  = invEl.getBoundingClientRect();
  const popupW = 280;
  let left = (slotRect.left - invRect.left) - popupW - 8;
  left = Math.max(8, left);

  const popupH = popup.getBoundingClientRect().height || 320;
  const SAFE   = 8;
  const vh     = window.innerHeight;
  const upTopVP   = slotRect.bottom - popupH;
  const downTopVP = slotRect.top;
  const upFits    = upTopVP   >= SAFE && upTopVP   + popupH <= vh - SAFE;
  const downFits  = downTopVP >= SAFE && downTopVP + popupH <= vh - SAFE;

  let topVP;
  if (upFits) {
    topVP = upTopVP;
  } else if (downFits) {
    topVP = downTopVP;
  } else {
    const upVisible   = Math.max(0, Math.min(vh - SAFE, upTopVP   + popupH) - Math.max(SAFE, upTopVP));
    const downVisible = Math.max(0, Math.min(vh - SAFE, downTopVP + popupH) - Math.max(SAFE, downTopVP));
    topVP = (downVisible >= upVisible) ? downTopVP : upTopVP;
    topVP = Math.max(SAFE, Math.min(vh - popupH - SAFE, topVP));
  }

  popup.style.right = "";
  popup.style.left  = `${left}px`;
  popup.style.top   = `${topVP - invRect.top}px`;
}

/* Close / drag-out / drop-in / inspect wiring for the mount popup.  Items
 * dragged out tag source "grid" + the mount as source-actor (so the normal
 * cross-actor handlers move them onto the character); drops land loose on
 * the mount. */
function wireMountPopup(character) {
  if (!character || !mountPopupOpen) return;
  const popup = invEl.querySelector(".wou-mount-popup");
  if (!popup) return;
  const mount = getMountActor(character);
  if (!mount) return;

  popup.querySelector(".wou-popup-close")?.addEventListener("click", () => {
    mountPopupOpen = false;
    render();
  });

  popup.addEventListener("dragstart", (ev) => {
    const slot = ev.target.closest(".wou-slot");
    if (!slot) return;
    const id = slot.dataset.itemId;
    if (!id) return;
    const item = mount.items.get(id);
    if (!item) return;
    currentDragSource  = "grid";
    currentDragActorId = mount.id;
    currentDragItemId  = id;
    ev.dataTransfer.setData("application/x-wou-item", id);
    ev.dataTransfer.setData("application/x-wou-source", "grid");
    ev.dataTransfer.setData("application/x-wou-source-actor", mount.id);
    if (ev.ctrlKey || ev.metaKey) ev.dataTransfer.setData("application/x-wou-split", "one");
    else if (ev.shiftKey) ev.dataTransfer.setData("application/x-wou-split", "half");
    ev.dataTransfer.setData("text/plain", JSON.stringify({ type: "Item", uuid: item.uuid }));
    ev.dataTransfer.effectAllowed = "copyMove";
    slot.classList.add("is-dragging");
  });
  popup.addEventListener("dragend", (ev) => {
    ev.target.closest(".wou-slot")?.classList.remove("is-dragging");
    currentDragSource  = null;
    currentDragActorId = null;
    currentDragItemId  = null;
  });

  popup.addEventListener("dragover", (ev) => {
    /* Don't eat a drag that started in this popup — let it land on the grid. */
    if (currentDragSource === "grid" && currentDragActorId === mount.id) return;
    ev.preventDefault();
    /* Pre-validate items dragged from our own UI; external drags (null) are
     * accepted optimistically here and re-checked on drop. */
    const dragged = draggedItem();
    const ok = !dragged || mountAcceptsItem(dragged);
    ev.dataTransfer.dropEffect = ok ? "move" : "none";
    popup.classList.toggle("is-drop-target", ok);
    popup.classList.toggle("is-drop-reject", !ok);
  });
  popup.addEventListener("dragleave", (ev) => {
    if (ev.target === popup) {
      popup.classList.remove("is-drop-target");
      popup.classList.remove("is-drop-reject");
    }
  });
  popup.addEventListener("drop", async (ev) => {
    ev.preventDefault();
    popup.classList.remove("is-drop-target");
    popup.classList.remove("is-drop-reject");

    /* Foreign drop — create the item (or container) on the mount, loose.
     * tryForeignItemDrop enforces the remains/container rule via the filter. */
    if (!ev.dataTransfer.getData("application/x-wou-source")) {
      await tryForeignItemDrop(ev, mount, mountAcceptsItem);
      return;
    }

    const source     = ev.dataTransfer.getData("application/x-wou-source");
    const srcActorId = ev.dataTransfer.getData("application/x-wou-source-actor") || character.id;

    /* Already on the mount — detach from whatever container it sat in,
     * leaving it loose, then fold into an identical loose stack. Internal
     * reorganization isn't subject to the intake rule. */
    if (srcActorId === mount.id) {
      const id = await maybeSplitForDrop(ev);
      if (!id) return;
      const item = mount.items.get(id);
      if (item) {
        await removeItemFromSource(mount, item, source);
        await mergeLooseDuplicate(mount, item);
      }
      return;
    }

    /* From the character (or elsewhere) — only remains & containers may load
     * onto the mount. Reject anything else before splitting/transferring. */
    const probeActor = game.actors?.get?.(srcActorId);
    const probeItem  = probeActor?.items?.get(ev.dataTransfer.getData("application/x-wou-item"));
    if (!mountAcceptsItem(probeItem)) {
      ui?.notifications?.warn?.("A mount can only carry remains and containers.");
      return;
    }
    const id       = await maybeSplitForDrop(ev);
    if (!id) return;
    const srcActor = game.actors?.get?.(srcActorId);
    const srcItem  = srcActor?.items?.get(id);
    if (!srcActor || !srcItem) return;
    // Containers carry stored items in `system.content` (UUIDs into the source
    // actor). A plain transfer would copy those stale UUIDs and the container
    // would read empty on the mount — recreate the contents and remap instead.
    if (srcItem.type === "container") {
      await transferContainerAcrossActors(srcActor, srcItem, mount);
    } else {
      await transferAcrossActors(srcActor, srcItem, source, mount, null);
    }
  });

  popup.addEventListener("click", (ev) => {
    if (ev.target.closest(".wou-popup-close")) return;
    const slot = ev.target.closest(".wou-slot");
    if (!slot) return;
    inspectedItemId = slot.dataset.itemId;
    refreshInspectionPanel();
  });
}

function positionContainerPopup() {
  const popup = invEl?.querySelector(".wou-container-popup");
  if (!popup || !popupAnchorId) return;
  const anchor = invEl.querySelector(`[data-track="containers"] [data-container-id="${CSS.escape(popupAnchorId)}"]`);
  if (!anchor) return;
  const slotRect = anchor.getBoundingClientRect();
  const invRect  = invEl.getBoundingClientRect();
  const popupW = 280;
  /* The container column sits to the right of the inventory grid; open
   * leftward so the popup lands over the grid area, not under the stats
   * column on the far right. */
  let left = (slotRect.left - invRect.left) - popupW - 8;
  left = Math.max(8, left);

  /* Decide vertical orientation by viewport fit, not just inventory fit.
   * Default: align popup BOTTOM with slot bottom (extends UPWARD).
   * If the upward extension would cross the viewport's top edge (8px
   * safety margin), flip to align popup TOP with slot top (extends
   * DOWNWARD).  Same rule applies in reverse if down doesn't fit.  If
   * neither fits, pick whichever leaves more of the popup visible. */
  const popupH = popup.getBoundingClientRect().height || 320;
  const SAFE   = 8;
  const vh     = window.innerHeight;

  const upTopVP   = slotRect.bottom - popupH;             /* viewport y of popup-top when going UP */
  const downTopVP = slotRect.top;                          /* viewport y of popup-top when going DOWN */
  const upFits    = upTopVP   >= SAFE && upTopVP   + popupH <= vh - SAFE;
  const downFits  = downTopVP >= SAFE && downTopVP + popupH <= vh - SAFE;

  let topVP;
  if (upFits) {
    topVP = upTopVP;
  } else if (downFits) {
    topVP = downTopVP;
  } else {
    /* Pick whichever orientation keeps more of the popup inside the
     * viewport, then clamp.  Tie-breaker: prefer DOWN since the user's
     * gaze tends to follow the click downward. */
    const upVisible   = Math.max(0, Math.min(vh - SAFE, upTopVP   + popupH) - Math.max(SAFE, upTopVP));
    const downVisible = Math.max(0, Math.min(vh - SAFE, downTopVP + popupH) - Math.max(SAFE, downTopVP));
    topVP = (downVisible >= upVisible) ? downTopVP : upTopVP;
    topVP = Math.max(SAFE, Math.min(vh - popupH - SAFE, topVP));
  }

  /* Convert viewport y → inventory-local y for the absolutely-positioned
   * popup (which is inside invEl). */
  const top = topVP - invRect.top;

  popup.style.right = "";
  popup.style.left  = `${left}px`;
  popup.style.top   = `${top}px`;
}

function wireContainerPopup(character) {
  if (!character || !openContainerPopupId) return;
  const popup = invEl.querySelector(".wou-container-popup");
  if (!popup) return;
  const popupActor = openContainerActorId
    ? game.actors?.get?.(openContainerActorId)
    : character;
  if (!popupActor) return;

  popup.querySelector(".wou-popup-close")?.addEventListener("click", () => {
    openContainerPopupId = null;
    openContainerActorId = null;
    popupAnchorId = null;
    render();
  });

  // Drag items OUT of the popup — source tags as "container:<id>" so any
  // drop handler can remove them from this container.
  popup.addEventListener("dragstart", (ev) => {
    const slot = ev.target.closest(".wou-slot");
    if (!slot) return;
    const id = slot.dataset.itemId;
    if (!id) return;
    const item = popupActor?.items?.get(id);
    if (!item) return;
    currentDragSource  = `container:${openContainerPopupId}`;
    currentDragActorId = popupActor.id;
    currentDragItemId  = id;
    ev.dataTransfer.setData("application/x-wou-item", id);
    ev.dataTransfer.setData("application/x-wou-source", currentDragSource);
    ev.dataTransfer.setData("application/x-wou-source-actor", popupActor.id);
    if (ev.ctrlKey || ev.metaKey) ev.dataTransfer.setData("application/x-wou-split", "one");
    else if (ev.shiftKey) ev.dataTransfer.setData("application/x-wou-split", "half");
    /* text/plain = Foundry's native item drop payload (see grid dragstart). */
    ev.dataTransfer.setData("text/plain", JSON.stringify({ type: "Item", uuid: item.uuid }));
    ev.dataTransfer.effectAllowed = "copyMove";
    slot.classList.add("is-dragging");
  });
  popup.addEventListener("dragend", (ev) => {
    ev.target.closest(".wou-slot")?.classList.remove("is-dragging");
    currentDragSource = null;
    currentDragActorId = null;
    currentDragItemId = null;
  });

  // Drop items INTO the popup — add to this container, remove from source.
  // Skip preventDefault when the drag *started* in this popup, otherwise
  // the popup eats its own out-going drag and the user can't move items
  // back to the grid.  (dataTransfer.getData isn't allowed during
  // dragover — hence the module-level `currentDragSource` flag.)
  popup.addEventListener("dragover", (ev) => {
    if (currentDragSource === `container:${openContainerPopupId}`) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    popup.classList.add("is-drop-target");
  });
  popup.addEventListener("dragleave", (ev) => {
    if (ev.target === popup) popup.classList.remove("is-drop-target");
  });
  popup.addEventListener("drop", async (ev) => {
    ev.preventDefault();
    popup.classList.remove("is-drop-target");

    // Foreign drag — create the item, then add it to this container.
    if (!ev.dataTransfer.getData("application/x-wou-source")) {
      const created = await tryForeignItemDrop(ev, popupActor);
      if (!created || !openContainerPopupId) return;
      const container = popupActor.items.get(openContainerPopupId);
      if (!container) return;
      /* Capacity check.  Foreign drop already CREATED the item on the
       * actor (via tryForeignItemDrop), so if it can't fit we still let
       * it land on the actor's grid — just don't add it to the
       * container.  That's a softer rejection than discarding the new
       * item entirely. */
      if (!fitsInContainer(container, created)) {
        ui?.notifications?.warn?.(overflowWarning(container, created));
        return;
      }
      const content = container.system?.content ?? [];
      if (!content.includes(created.uuid)) {
        await container.update({ "system.content": [...content, created.uuid] });
      }
      if (!created.system?.isStored) {
        await created.update({ "system.isStored": true });
      }
      return;
    }

    // Internal drag.
    const source      = ev.dataTransfer.getData("application/x-wou-source");
    const srcActorId  = ev.dataTransfer.getData("application/x-wou-source-actor") || character.id;
    const id          = await maybeSplitForDrop(ev);
    if (!id) return;

    /* Cross-actor: source lives on a different actor than this popup. */
    if (srcActorId !== popupActor.id) {
      const srcActor = game.actors?.get?.(srcActorId);
      const srcItem  = srcActor?.items?.get(id);
      if (!srcActor || !srcItem) return;
      await transferAcrossActors(srcActor, srcItem, source, popupActor, openContainerPopupId);
      return;
    }

    /* Same-actor: existing stack-merge / move-into-container path. */
    if (await tryMergeStacks(popupActor, ev, id, source)) return;
    if (source === `container:${openContainerPopupId}`) return;
    await moveItemToContainer(popupActor, id, openContainerPopupId, source, { spendAction: true });
  });

  // Left-click inspects.
  popup.addEventListener("click", (ev) => {
    if (ev.target.closest(".wou-popup-close")) return;
    const slot = ev.target.closest(".wou-slot");
    if (!slot) return;
    inspectedItemId = slot.dataset.itemId;
    refreshInspectionPanel();
  });
}

/* ── Action economy for hands-on gear handling (Core p.151) ────────────────
 * In a combat the actor is part of, physically handling gear costs an action:
 * drawing a weapon, stowing/moving an item into a container, taking one out,
 * and picking an item up off the world each spend one slot (normal first, then
 * the extra action). With no slots left the operation is refused outright —
 * the caller must abort. Out of combat all of this is free and unlimited. */
export function canSpendCombatAction(actor) {
  if (!isActorInActiveCombat(actor)) return true;
  if (actor?.hasActionSlot) return true;
  ui?.notifications?.warn?.("No actions left this turn.");
  return false;
}

export async function chargeCombatAction(actor, label) {
  if (!isActorInActiveCombat(actor)) return;
  if (typeof actor?.spendActionSlot !== "function") return;
  try { await actor.spendActionSlot(label); }
  catch (err) { console.warn("witcher-ttrpg-death-march | inventory action-spend failed", err); }
}

export async function moveItemToContainer(actor, itemId, containerId, source, { spendAction = false } = {}) {
  const container = actor.items.get(containerId);
  const item      = actor.items.get(itemId);
  if (!container || !item) return;
  // Stowing is a combat action — block (and abort) when no slot is left.
  if (spendAction && !canSpendCombatAction(actor)) return;
  /* Reject if the container would overflow its capacity.  Done BEFORE
   * removeItemFromSource so a rejected drop leaves the item where it
   * started (still equipped / in its previous container / in the grid). */
  if (!fitsInContainer(container, item)) {
    ui?.notifications?.warn?.(overflowWarning(container, item));
    return;
  }
  await removeItemFromSource(actor, item, source);
  const content = container.system?.content ?? [];
  // Use UUID since that's the format ContainerData stores.
  if (!content.includes(item.uuid)) {
    await container.update({ "system.content": [...content, item.uuid] });
  }
  if (!item.system?.isStored) {
    await item.update({ "system.isStored": true });
  }
  if (spendAction) await chargeCombatAction(actor, `Stow: ${item.name}`);
}

/**
 * Detect and handle a Foundry-style item drag (from compendium, items
 * sidebar, or another actor sheet).  Foundry sets a JSON payload on
 * `text/plain` like `{"type":"Item","uuid":"Compendium.pack.Item.id"}`.
 *
 * Internal drags within our overlay set `application/x-wou-source` — we
 * use that as the discriminator and bail before parsing.
 *
 * Returns the item that ended up on the actor (either newly created or the
 * existing stack that the dropped item merged into), or null if this wasn't
 * a foreign item drop.
 */
/** Resolve the item a foreign (Foundry) drag references WITHOUT creating a
 *  copy on any actor. Used to pre-validate a drop (slot type, combat rules,
 *  container capacity) so a rejected drop never strands a freshly-created
 *  item on the grid with the pick-up action already spent. */
async function peekForeignItem(ev) {
  if (ev.dataTransfer.getData("application/x-wou-source")) return null;
  if (ev.dataTransfer.getData("application/x-wou-reorder-container")) return null;
  const raw = ev.dataTransfer.getData("text/plain")
           || ev.dataTransfer.getData("application/json");
  if (!raw) return null;
  let data;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!data || data.type !== "Item") return null;
  try {
    if (data.uuid)                 return await fromUuid(data.uuid);
    if (data.pack && data.id)      return await game.packs.get(data.pack)?.getDocument(data.id);
    if (data.id)                   return game.items.get(data.id);
  } catch { return null; }
  return null;
}

async function tryForeignItemDrop(ev, actor, accept = null) {
  if (!actor) return null;
  if (ev.dataTransfer.getData("application/x-wou-source")) return null;
  /* Chrome rail drags carry a reorder marker + Foundry's native payload but
   * no x-wou-source. They are internal MOVES handled by dedicated drop paths
   * (e.g. cross-actor container move on the grid), NOT foreign imports —
   * copying them here would let the user spawn endless duplicate containers. */
  if (ev.dataTransfer.getData("application/x-wou-reorder-container")) return null;
  const raw = ev.dataTransfer.getData("text/plain")
           || ev.dataTransfer.getData("application/json");
  if (!raw) return null;
  let data;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!data || data.type !== "Item") return null;
  let item;
  try {
    if (data.uuid)                  item = await fromUuid(data.uuid);
    else if (data.pack && data.id)  item = await game.packs.get(data.pack)?.getDocument(data.id);
    else if (data.id)               item = game.items.get(data.id);
  } catch (err) {
    console.warn(`${MODULE_ID} | could not resolve dragged item`, err);
    return null;
  }
  if (!item) return null;
  // Caller-supplied intake filter (e.g. a mount only accepts remains &
  // containers). Refuse anything that doesn't pass.
  if (accept && !accept(item)) {
    ui?.notifications?.warn?.("A mount can only carry remains and containers.");
    return null;
  }
  // Skip if the item is already on this actor — prevents duplicating a
  // container (or any item) that the user drags back into our own UI from
  // the rail / equip slots / etc.
  if (item.parent?.id === actor.id) return null;
  // Picking an item up off the world is a combat action — refuse if no slot.
  if (!canSpendCombatAction(actor)) return null;
  /* Containers, weapons and armor are unique per-instance entities — they
   * must NEVER be merged into an existing same-name item.  Skip the system's
   * addItem (which merges by name+type) and create a fresh embedded doc.
   * Everything else still goes through addItem so stackables (alchemicals,
   * components, etc.) stack as expected. */
  const isUnique = item.type === "container" || item.type === "weapon" || item.type === "shield" || item.type === "armor";
  let created = null;
  try {
    if (isUnique || typeof actor.addItem !== "function") {
      const [doc] = await actor.createEmbeddedDocuments("Item", [item.toObject?.() ?? item]);
      created = doc;
    } else {
      await actor.addItem(item, 1);
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | failed to add item to actor`, err);
    return null;
  }
  await chargeCombatAction(actor, `Pick up: ${item.name}`);
  if (created) return created;
  // Resolve to the actor-side item document (existing stack or new copy).
  return actor.items.find(i => i.name === item.name && i.type === item.type) ?? null;
}

/**
 * Equip an item — flips `system.equipped = true` on the WHOLE stack.
 *
 * Previously this split a stack into a qty-1 equipped clone + remaining
 * unequipped stack so e.g. a stack of 7 throwing knives stayed grouped in
 * the grid while one was "equipped".  That diverged from the Witcher
 * system actor sheet — its own equip toggle just flips the boolean on the
 * whole stack — and produced confusing duplicate rows on the sheet (an
 * "equipped" qty-1 entry alongside the larger "not equipped" stack).
 *
 * For weapons this matches the actor sheet's behavior exactly: equip = set
 * the boolean true on the same document.  No splitting, no cloning, no
 * duplicate rows — so a stack of throwing knives stays grouped.
 *
 * Armor is the exception: you never wear two suits at once, so equipping
 * from a stack of >1 peels a single qty-1 copy off (equipped) and leaves
 * the remainder loose.  Function name kept to minimize churn on call sites.
 *
 * Also clears `isStored` defensively — an equipped item can't simultaneously
 * be tucked inside a container.
 *
 * Returns the equipped item document.
 */
async function splitOneAndEquip(actor, sourceItem, preferredSlot = null) {
  if (!actor || !sourceItem) return null;

  /* Armor stacks: peel one piece off rather than equipping the whole stack. */
  const qty = Number(sourceItem.system?.quantity) || 1;
  if (sourceItem.type === "armor" && qty > 1) {
    await sourceItem.update({ "system.quantity": qty - 1, "system.equipped": false });
    const data = sourceItem.toObject(false);
    delete data._id;
    data.effects = [];
    data.system = { ...(data.system ?? {}), quantity: 1, isStored: false, equipped: true };
    const [created] = await actor.createEmbeddedDocuments("Item", [data]);
    invalidateRenderSig();
    return created ?? null;
  }

  /* Weapons pick a slot (remembered → Right → Left → Quick) and equip
   * atomically via assignSlot, which runs the conflict check and writes
   * equipped + slot together — so a second one-handed weapon auto-lands on
   * the free hand instead of being rejected. */
  if (sourceItem.type === "weapon" || sourceItem.type === "shield") {
    if (sourceItem.system?.isStored) await sourceItem.update({ "system.isStored": false });
    const slot = (preferredSlot && VALID_SLOTS.includes(preferredSlot))
      ? preferredSlot
      : autoEquipSlot(actor, sourceItem);
    await assignSlot(actor, sourceItem.id, slot);
    return sourceItem;
  }

  const updates = {};
  if (!sourceItem.system?.equipped) updates["system.equipped"] = true;
  if (sourceItem.system?.isStored)  updates["system.isStored"] = false;
  if (Object.keys(updates).length) await sourceItem.update(updates);
  return sourceItem;
}

/**
 * Cross-actor item transfer.  Removes the item from `srcActor` (cleaning up
 * the source container's content array if applicable) and places it on
 * `dstActor` — merging into an existing same-name+type stack on the dst
 * when no destination container is specified, otherwise creating a fresh
 * embedded item inside `dstContainerId`.
 *
 * Returns the destination item document (newly created or merged-into).
 */
async function transferAcrossActors(srcActor, srcItem, srcTag, dstActor, dstContainerId = null) {
  if (!srcActor || !srcItem || !dstActor) return null;
  const qty = Number(srcItem.system?.quantity) || 1;

  /* Capacity check on dst container BEFORE detaching from src.  A rejected
   * cross-actor transfer should leave the item where it started — same
   * principle as moveItemToContainer. */
  if (dstContainerId) {
    const dst = dstActor.items.get(dstContainerId);
    if (dst && !fitsInContainer(dst, srcItem)) {
      ui?.notifications?.warn?.(overflowWarning(dst, srcItem));
      return null;
    }
  }

  /* Detach source from its container, if any. */
  if (srcTag?.startsWith?.("container:")) {
    const cid = srcTag.slice("container:".length);
    const c = srcActor.items.get(cid);
    if (c) {
      const content = (c.system?.content ?? []).filter(u => u !== srcItem.uuid);
      await c.update({ "system.content": content });
    }
  }

  /* Build the destination item data. */
  const data = srcItem.toObject(false);
  delete data._id;
  data.system = { ...(data.system ?? {}), equipped: false, isStored: !!dstContainerId, quantity: qty };

  let dstItem;
  if (dstContainerId) {
    /* Container drops always create a fresh doc so the container's content
     * array can reference its UUID uniquely. */
    const [created] = await dstActor.createEmbeddedDocuments("Item", [data]);
    dstItem = created;
    const dc = dstActor.items.get(dstContainerId);
    if (dc) {
      const content = dc.system?.content ?? [];
      if (!content.includes(dstItem.uuid)) {
        await dc.update({ "system.content": [...content, dstItem.uuid] });
      }
    }
  } else {
    /* On-person drop — merge into an existing on-person stack of the same
     * name+type if one exists, else create.  Containers are unique
     * entities and must NEVER merge (each bag has its own contents). */
    const existing = !itemIsStackable(srcItem) ? null : dstActor.items.find(i =>
      !i.system?.isStored && !i.system?.equipped && itemsStackTogether(srcItem, i)
    );
    if (existing) {
      const eQty = Number(existing.system?.quantity) || 1;
      await existing.update({ "system.quantity": eQty + qty });
      dstItem = existing;
    } else {
      const [created] = await dstActor.createEmbeddedDocuments("Item", [data]);
      dstItem = created;
    }
  }

  await srcItem.delete();
  return dstItem;
}

/** Move a container — AND everything stored inside it — from one actor to
 *  another.  `transferAcrossActors` alone would copy the container's
 *  `system.content` UUIDs verbatim, but those still point at the SOURCE
 *  actor's items; this recreates each stored item on the destination and
 *  rebuilds the content array against the new UUIDs, then deletes the
 *  originals.  Returns the new container doc. */
async function transferContainerAcrossActors(srcActor, container, dstActor) {
  if (!srcActor || !container || !dstActor) return null;
  const contentRefs = container.system?.content ?? [];
  const stored = srcActor.items.filter(i =>
    contentRefs.includes(i.uuid) || contentRefs.includes(i.id));

  /* Destination container shell — empty content, refilled below. */
  const cData = container.toObject(false);
  delete cData._id;
  cData.system = { ...(cData.system ?? {}), equipped: false, isStored: false, content: [] };
  const [newContainer] = await dstActor.createEmbeddedDocuments("Item", [cData]);

  /* Recreate each stored item on the destination, collecting new UUIDs. */
  const newContent = [];
  for (const it of stored) {
    const d = it.toObject(false);
    delete d._id;
    d.system = { ...(d.system ?? {}), isStored: true, equipped: false };
    const [created] = await dstActor.createEmbeddedDocuments("Item", [d]);
    newContent.push(created.uuid);
  }
  if (newContent.length) await newContainer.update({ "system.content": newContent });

  /* Delete the originals (contents + the container) from the source. */
  const delIds = [...stored.map(i => i.id), container.id].filter(Boolean);
  if (delIds.length) await srcActor.deleteEmbeddedDocuments("Item", delIds);

  return newContainer;
}

/** True when the item carries an applied oil coating — a transient,
 *  per-copy effect (tagged flags.<MODULE_ID>.oilCoating) that makes that one
 *  instance unique.  Handles both live documents (effects = Collection of
 *  ActiveEffect) and raw data (effects = array of plain objects). Inherent
 *  item effects (a mutagen's mutation, a potion's buff — transfer:false,
 *  applied on use) are NOT coatings and don't block stacking. */
function itemHasOilCoating(item) {
  const effects = item?.effects;
  if (!effects) return false;
  for (const e of effects) {
    if (e?.getFlag?.(MODULE_ID, OIL_FLAG) ?? e?.flags?.[MODULE_ID]?.[OIL_FLAG]) return true;
  }
  return false;
}

/** An item may stack only if it isn't a container, isn't a weapon or armor
 *  (each piece of gear is tracked individually — equip state, oils, hands and
 *  enhancements are per-instance), and carries no applied oil coating (an oiled
 *  weapon is one-of-a-kind; identical potions/mutagens that merely carry their
 *  own inherent effect still stack). */
function itemIsStackable(item) {
  if (!item) return false;
  if (item.type === "container" || item.type === "weapon" || item.type === "shield" || item.type === "armor") return false;
  return !itemHasOilCoating(item);
}

/** Per-instance fingerprint used to decide whether two items may merge into
 *  one stack.  Covers name, type, img, source system data (minus the volatile
 *  quantity / placement fields) and effects (minus per-copy ids).  Two copies
 *  merge ONLY when these match — so an item the player has modified (edited a
 *  field, added an effect) never silently re-merges into the base stack and
 *  loses that change. */
function stackSignature(item) {
  if (!item) return "";
  const o = item.toObject ? item.toObject() : foundry.utils.deepClone(item);
  const sys = o.system ?? {};
  delete sys.quantity;
  delete sys.isStored;
  delete sys.equipped;
  const effects = (o.effects ?? []).map(e => {
    const c = { ...e };
    delete c._id;
    delete c.origin;
    return c;
  });
  return JSON.stringify({ name: o.name, type: o.type, img: o.img, system: sys, effects });
}

/** Whether two items may merge into a single stack: both stackable (not a
 *  container, no oil coating) AND identical per stackSignature. */
function itemsStackTogether(a, b) {
  if (!itemIsStackable(a) || !itemIsStackable(b)) return false;
  return stackSignature(a) === stackSignature(b);
}

/** If the drag was split-initiated, peel part of the stack off the source
 *  item into a new loose stack on the source actor and return THAT new item's
 *  id for the drop handler to route.  Otherwise return the dragged id
 *  unchanged.  Split amount depends on the modifier: ctrl/cmd ("one") peels a
 *  single unit; shift ("half") peels floor(qty/2).
 *  Containers and unique-effect / single items can't be split. */
async function maybeSplitForDrop(ev) {
  const id = ev.dataTransfer.getData("application/x-wou-item");
  const splitMode = ev.dataTransfer.getData("application/x-wou-split");
  if (!splitMode) return id;
  const srcActorId = ev.dataTransfer.getData("application/x-wou-source-actor");
  const srcActor = srcActorId ? game.actors?.get?.(srcActorId) : getAssignedActor();
  const item = srcActor?.items?.get(id);
  if (!item || !itemIsStackable(item)) return id;
  const qty = Number(item.system?.quantity) || 0;
  if (qty <= 1) return id;
  const splitQty = splitMode === "one" ? 1 : Math.floor(qty / 2);
  await item.update({ "system.quantity": qty - splitQty });
  const data = item.toObject(false);
  delete data._id;
  data.effects = [];   // a split-off copy is a plain stack — never inherits oils
  data.system = { ...(data.system ?? {}), quantity: splitQty, isStored: false, equipped: false };
  const [created] = await srcActor.createEmbeddedDocuments("Item", [data]);
  invalidateRenderSig();
  return created?.id ?? id;
}

/** After an item lands loose on the grid, fold it into an existing identical
 *  loose stack if one exists (so pulling stackables out of containers / off
 *  equip slots doesn't leave duplicate rows).  Returns true if merged. */
async function mergeLooseDuplicate(actor, item) {
  if (!actor || !itemIsStackable(item)) return false;
  const target = actor.items.find(i =>
    i.id !== item.id &&
    !i.system?.isStored && !i.system?.equipped && itemsStackTogether(item, i)
  );
  if (!target) return false;
  const tQty = Number(target.system?.quantity) || 1;
  const sQty = Number(item.system?.quantity) || 1;
  await target.update({ "system.quantity": tQty + sQty });
  await item.delete();
  return true;
}

/**
 * Stack merge — if the user drops an item onto another slot that holds the
 * SAME item (matching name + type), absorb the dragged stack into the
 * target's quantity and delete the source. Returns true if a merge happened.
 *
 * The source is detached from its origin (container/equip slot) first via
 * `removeItemFromSource` so container content arrays stay clean.
 */
async function tryMergeStacks(actor, ev, sourceId, sourceTag) {
  const targetSlot = ev.target.closest?.(".wou-slot[data-item-id]");
  if (!targetSlot) return false;
  const targetId = targetSlot.dataset.itemId;
  if (!targetId || targetId === sourceId) return false;
  const source = actor.items.get(sourceId);
  const target = actor.items.get(targetId);
  if (!source || !target) return false;
  /* Only merge truly identical copies.  Different name/type, containers (each
   * carries its own contents), oil-coated one-offs, AND copies the player has
   * modified (different system data / effects) all fail this and fall through
   * to a plain move / place. */
  if (!itemsStackTogether(source, target)) return false;
  // Merging a stack OUT of a container is a Take-out combat action — gate and
  // charge it, same as a plain drag-out. (Grid/equip merges stay free.)
  const fromContainer = sourceTag?.startsWith("container:");
  if (fromContainer && !canSpendCombatAction(actor)) return false;
  const sQty = Number(source.system?.quantity) || 1;
  const tQty = Number(target.system?.quantity) || 1;
  await removeItemFromSource(actor, source, sourceTag, { spendAction: fromContainer });
  await target.update({ "system.quantity": tQty + sQty });
  await source.delete();
  return true;
}

export async function removeItemFromSource(actor, item, source, { spendAction = false } = {}) {
  if (!source || source === "grid") return;
  if (source.startsWith("container:")) {
    const srcId = source.slice("container:".length);
    const src = actor.items.get(srcId);
    if (!src) return;
    // Taking an item out of a container is a combat action — block if no slot.
    if (spendAction && !canSpendCombatAction(actor)) return;
    const content = (src.system?.content ?? []).filter(u => u !== item.uuid && u !== item.id);
    await src.update({ "system.content": content });
    await item.update({ "system.isStored": false });
    if (spendAction) await chargeCombatAction(actor, `Take out: ${item.name}`);
    return;
  }
  if (source.startsWith("equip:")) {
    if (item.system?.equipped) await item.update({ "system.equipped": false });
    return;
  }
}

function wireTabs() {
  const tabs = invEl.querySelector(".wou-inv-tabs");
  if (!tabs) return;
  tabs.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".wou-inv-tab");
    if (!btn) return;
    const id = btn.dataset.tab;
    if (!id || id === activeTab) return;
    activeTab = id;
    render();
  });
}

function wireSortControl(actor) {
  const select = invEl.querySelector('.wou-inv-sort select[data-bind="sort"]');
  if (!select) return;
  select.addEventListener("change", async (ev) => {
    const value = ev.target.value;
    if (!actor) {
      // No character — just re-render with in-memory state via direct rerender.
      // Without a flag write, the next render will fall back to DEFAULT_SORT.
      return;
    }
    try {
      await actor.setFlag(MODULE_ID, `${SORT_FLAG_PATH}.${activeTab}`, value);
      // updateActor hook will re-render automatically.
    } catch (err) {
      console.warn(`${MODULE_ID} | could not persist inventory sort`, err);
    }
  });
}

function wireItemGrid(actor) {
  const wrap = invEl.querySelector(".wou-inv-grid-wrap");
  if (!wrap || !actor) return;

  // Left-click sets the inspected item (drives the panel below the grid).
  // The item sheet is reachable via the right-click "Edit" entry.
  wrap.addEventListener("click", (ev) => {
    const slot = ev.target.closest(".wou-slot");
    if (!slot) return;
    inspectedItemId = slot.dataset.itemId;
    refreshInspectionPanel();
  });

  // Drag from grid — source tagged "grid".
  wrap.addEventListener("dragstart", (ev) => {
    const slot = ev.target.closest(".wou-slot");
    if (!slot) return;
    const id = slot.dataset.itemId;
    if (!id) return;
    const item = actor?.items?.get(id);
    if (!item) return;
    currentDragSource  = "grid";
    currentDragActorId = actor.id;
    currentDragItemId  = id;
    ev.dataTransfer.setData("application/x-wou-item", id);
    ev.dataTransfer.setData("application/x-wou-source", currentDragSource);
    ev.dataTransfer.setData("application/x-wou-source-actor", actor.id);
    if (ev.ctrlKey || ev.metaKey) ev.dataTransfer.setData("application/x-wou-split", "one");
    else if (ev.shiftKey) ev.dataTransfer.setData("application/x-wou-split", "half");
    /* text/plain holds Foundry's native item drop payload so our hotbar
     * (and Foundry's macro hotbar) accept the drop.  Internal drag routing
     * still keys off the application/x-wou-source headers above. */
    ev.dataTransfer.setData("text/plain", JSON.stringify({ type: "Item", uuid: item.uuid }));
    ev.dataTransfer.effectAllowed = "copyMove";
    slot.classList.add("is-dragging");
  });
  wrap.addEventListener("dragend", (ev) => {
    ev.target.closest(".wou-slot")?.classList.remove("is-dragging");
    currentDragSource = null;
    currentDragActorId = null;
    currentDragItemId = null;
  });

  // Drop onto the grid — three cases:
  //   - Foreign (Foundry) drag from compendium / items sidebar → add to actor.
  //   - Internal drag with source=equip:* → unequip.
  //   - Internal drag with source=container:* → pull out of container.
  //   - Internal drag with source=grid → no-op.
  wrap.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = currentDragSource ? "move" : "copy";
  });
  wrap.addEventListener("drop", async (ev) => {
    ev.preventDefault();

    /* Rail → grid unequip: dragged container was in a rail equip slot
     * and the user dropped it on the inventory grid.  Clear the rail
     * assignment, leave the item where it is (still in inventory). */
    const reorderId    = ev.dataTransfer.getData("application/x-wou-reorder-container");
    const reorderOwner = ev.dataTransfer.getData("application/x-wou-reorder-owner");
    if (reorderId && reorderOwner === actor.id) {
      const idx = railSlotOf(actor, reorderId);
      if (idx >= 0) {
        if (!canSpendCombatAction(actor)) return;
        await setRailAssignment(actor, idx, null);
        await chargeCombatAction(actor, `Unequip: ${actor.items.get(reorderId)?.name ?? "container"}`);
      }
      return;
    }
    /* Cross-actor rail drag (e.g. from the linked mount's rail): mount
     * containers are stowed on the mount and may NOT be dragged straight onto
     * the character — they're not readily accessible, so they must be taken
     * out through the mount inventory popup.  Swallow the drop so it can't
     * fall through to tryForeignItemDrop (which would COPY and duplicate it). */
    if (reorderId && reorderOwner && reorderOwner !== actor.id) {
      ui?.notifications?.info?.("Open the mount's inventory (click its portrait) to take a container out.");
      return;
    }

    if (!ev.dataTransfer.getData("application/x-wou-source")) {
      await tryForeignItemDrop(ev, actor);
      return;
    }
    const source     = ev.dataTransfer.getData("application/x-wou-source");
    const srcActorId = ev.dataTransfer.getData("application/x-wou-source-actor") || actor.id;
    const id         = await maybeSplitForDrop(ev);
    if (!id) return;

    /* Cross-actor: pulling an item from a linked mount onto the character's
     * on-person grid. */
    if (srcActorId !== actor.id) {
      const srcActor = game.actors?.get?.(srcActorId);
      const srcItem  = srcActor?.items?.get(id);
      if (!srcActor || !srcItem) return;
      // A loose container dragged off the mount must carry its stored contents
      // (see transferContainerAcrossActors); the generic path copies stale UUIDs.
      if (srcItem.type === "container") {
        await transferContainerAcrossActors(srcActor, srcItem, actor);
      } else {
        await transferAcrossActors(srcActor, srcItem, source, actor, null);
      }
      return;
    }

    /* Drop onto a slot holding the SAME item → merge stacks. Handles grid,
     * container, and equip sources uniformly. */
    if (await tryMergeStacks(actor, ev, id, source)) return;
    if (source === "grid") return;
    const item = actor.items.get(id);
    if (!item) return;
    const fromContainer = source.startsWith("container:");
    const fromEquip     = source.startsWith("equip:");
    // A drawn weapon can't be set loose in hand mid-combat — it must be
    // sheathed/stowed into a container (drag it onto a container) or dropped.
    if (fromEquip && item.type === "weapon" && isActorInActiveCombat(actor)) {
      ui?.notifications?.warn?.("Can't unequip a weapon mid-combat — sheathe it into a container or drop it.");
      return;
    }
    // Pulling an item out of a container (Take out) and unequipping an equipped
    // item by dragging it to the grid both cost a combat action.
    if ((fromContainer || fromEquip) && !canSpendCombatAction(actor)) return;
    await removeItemFromSource(actor, item, source);
    if (fromContainer) await chargeCombatAction(actor, `Take out: ${item.name}`);
    else if (fromEquip) await chargeCombatAction(actor, `Unequip: ${item.name}`);
    /* Fold the now-loose item into an existing identical loose stack so
     * pulling stackables out of a container doesn't leave a duplicate row. */
    await mergeLooseDuplicate(actor, item);
  });
}

function wireCurrencyInputs(actor) {
  if (!actor) return;
  for (const input of invEl.querySelectorAll('input[data-currency-key]')) {
    const commit = async () => {
      const key = input.dataset.currencyKey;
      const v = Math.max(0, Math.floor(Number(input.value) || 0));
      const cur = Number(actor.system?.currency?.[key]) || 0;
      if (v === cur) return;
      await actor.update({ [`system.currency.${key}`]: v });
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); input.blur(); }
    });
  }
}

function wireEquipSlots(actor) {
  if (!actor) return;
  // Filled equip slots: left-click inspects (drag elsewhere to unequip, or
  // drag onto another hand-slot to re-assign). Right-click is the Witcher
  // ContextMenu. The sheath badge intercepts the click first.
  for (const slot of invEl.querySelectorAll(".wou-equip.has-item")) {
    slot.addEventListener("click", async (ev) => {
      const sheathBadge = ev.target.closest?.(".wou-sheath-badge");
      if (sheathBadge) {
        ev.stopPropagation();
        const id = slot.dataset.itemId;
        const item = actor?.items?.get(id);
        if (item) await sheathWeapon(actor, item);
        return;
      }
      inspectedItemId = slot.dataset.itemId;
      refreshInspectionPanel();
    });
    slot.setAttribute("draggable", "true");
    slot.addEventListener("dragstart", (ev) => {
      const id = slot.dataset.itemId;
      if (!id) return;
      const item = actor?.items?.get(id);
      if (!item) return;
      const kind = slot.dataset.equipType || "weapon";
      currentDragSource = `equip:${kind}`;
      currentDragActorId = actor.id;
      currentDragItemId  = id;
      ev.dataTransfer.setData("application/x-wou-item", id);
      ev.dataTransfer.setData("application/x-wou-source", currentDragSource);
      /* text/plain = Foundry's native item drop payload, so dropping an
       * equipped weapon/armor onto our hotbar or Foundry's macro hotbar
       * binds it correctly (see grid dragstart for rationale). */
      ev.dataTransfer.setData("text/plain", JSON.stringify({ type: "Item", uuid: item.uuid }));
      ev.dataTransfer.effectAllowed = "copyMove";
    });
    slot.addEventListener("dragend", () => {
      currentDragSource = null;
      currentDragActorId = null;
      currentDragItemId = null;
    });
  }
}

/** Drop handlers on every equip slot (filled or empty).  A weapon dropped
 *  on a weapon slot equips it; same for armor.  Type mismatch shows a
 *  notification and is rejected. */
function wireEquipDrops(actor) {
  if (!actor) return;
  // A hand slot (data-equip-type "weapon") holds weapons AND shields — a shield
  // is wielded in a hand, never in an armor slot. Armor slots stay armor-only.
  const slotAccepts = (expected, type) =>
    expected === "weapon" ? (type === "weapon" || type === "shield") : type === expected;
  const handLike = (type) => type === "weapon" || type === "shield";
  for (const slot of invEl.querySelectorAll(".wou-equip[data-equip-type]")) {
    slot.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
      slot.classList.add("is-drop-target");
    });
    slot.addEventListener("dragleave", () => {
      slot.classList.remove("is-drop-target");
    });
    slot.addEventListener("drop", async (ev) => {
      ev.preventDefault();
      slot.classList.remove("is-drop-target");
      const expected = slot.dataset.equipType;
      // Hand-slot drops (Right/Left/Quick) carry an explicit target slot;
      // armor slots have none and fall back to auto-assignment.
      const handSlot = slot.dataset.equipSlot || null;

      // Foreign drag — create the item on the actor, then equip ONE
      // copy (splitting the stack if quantity > 1).
      if (!ev.dataTransfer.getData("application/x-wou-source")) {
        // Pre-validate BEFORE creating the item so a rejected drop doesn't
        // leave a stranded copy on the grid (pick-up already charged).
        const peek = await peekForeignItem(ev);
        if (peek) {
          if (!slotAccepts(expected, peek.type)) {
            ui?.notifications?.warn?.(`Only ${expected}s can equip here.`);
            return;
          }
          // Equipping a loose weapon/shield is blocked mid-combat — draw from a container.
          if (handLike(peek.type) && isActorInActiveCombat(actor)) {
            ui?.notifications?.warn?.("Can't equip a loose weapon or shield in combat — draw it from a container.");
            return;
          }
        }
        const created = await tryForeignItemDrop(ev, actor);
        if (!created) return;
        if (!slotAccepts(expected, created.type)) {
          ui?.notifications?.warn?.(`Only ${expected}s can equip here.`);
          return;
        }
        const occupantId = slot.dataset.itemId;
        if (occupantId && occupantId !== created.id) {
          const occupant = actor.items.get(occupantId);
          if (occupant) await occupant.update({ "system.equipped": false });
        }
        await splitOneAndEquip(actor, created, handSlot);
        return;
      }

      // Internal drag.
      const id     = ev.dataTransfer.getData("application/x-wou-item");
      const source = ev.dataTransfer.getData("application/x-wou-source");
      if (!id) return;
      const item = actor.items.get(id);
      if (!item) return;
      if (!slotAccepts(expected, item.type)) {
        ui?.notifications?.warn?.(`Only ${expected}s can equip here.`);
        return;
      }
      const fromContainer = source.startsWith("container:");
      const fromEquip     = source.startsWith("equip:");
      // Equipping a LOOSE weapon/shield (grid source) is not a combat action and is
      // disallowed mid-combat — a readied weapon must be Drawn from a container.
      if (handLike(item.type) && !fromContainer && !fromEquip && isActorInActiveCombat(actor)) {
        ui?.notifications?.warn?.("Can't equip a loose weapon or shield in combat — draw it from a container.");
        return;
      }
      // Pre-flight the equip BEFORE detaching from a container, so a rejected
      // equip (e.g. a two-hander while the other hand is full) leaves the weapon
      // where it was instead of stranding it loose on the grid. The occupant of
      // the slot we're dropping ONTO is excluded — it's evicted on drop.
      const occupantId = slot.dataset.itemId || null;
      if (handLike(item.type)) {
        const targetHand = occupancyForSlot(item, handSlot || item.system?.slot || "right");
        if (!targetHand) {
          ui?.notifications?.warn?.(`Can't equip ${item.name} there.`);
          return;
        }
        const ignore = (occupantId && occupantId !== id) ? [occupantId] : [];
        const check = checkEquipConflicts(actor, id, targetHand, getPendingEquips(actor.id), ignore);
        if (!check.ok) {
          ui?.notifications?.warn?.(describeEquipFailure(item.name, check));
          return;
        }
      }
      // Draw (weapon from container) and armor equip both cost a combat action;
      // re-assigning between equip slots is free. Block when no slot remains.
      // Manticore: equipping a shield-type item is free.
      const freeShield = isShieldItem(item) && (Number(actor?.system?.combatMods?.freeShieldEquip) || 0) > 0;
      const costsAction = !fromEquip && (fromContainer || item.type === "armor") && !freeShield;
      if (costsAction && !canSpendCombatAction(actor)) return;
      await removeItemFromSource(actor, item, source);
      if (occupantId && occupantId !== id) {
        const occupant = actor.items.get(occupantId);
        if (occupant) await occupant.update({ "system.equipped": false });
      }
      // Split a single copy out of a stack on equip — keeps a stack of
      // 7 throwing knives intact while equipping one of them.
      await splitOneAndEquip(actor, item, handSlot);
      if (costsAction) {
        await chargeCombatAction(actor, fromContainer ? `Draw: ${item.name}` : `Equip: ${item.name}`);
      }
    });
  }
}

function wireSwitchHands(actor) {
  if (!actor) return;
  invEl.querySelector(".wou-switch-hands")?.addEventListener("click", async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    await switchWeaponHands(actor);
  });
}

function wireEquipControls(actor) {
  if (!actor) return;
  for (const group of invEl.querySelectorAll("[data-equip-controls]")) {
    const kind = group.dataset.equipControls;     // "weapons" | "armor" | "containers"
    group.addEventListener("click", async (ev) => {
      const btn = ev.target.closest("button[data-action]");
      if (!btn) return;

      /* Container rail uses its own per-actor flag (not equipSlots.*).
       * The rail-owner attr lets the same handler service both the
       * player's rail and the mount's rail. */
      if (kind === "containers") {
        const ownerId = group.dataset.railOwner || actor.id;
        const owner   = game.actors?.get?.(ownerId) ?? actor;
        const cur     = getRail(owner).count;
        const next    = btn.dataset.action === "add" ? cur + 1 : cur - 1;
        await setRailCount(owner, next);
        return;
      }

      const current = getEquipSlotCount(actor, kind);
      const next = btn.dataset.action === "add" ? current + 1 : current - 1;
      await setEquipSlotCount(actor, kind, next);
    });
  }
}

// `owner` provides `.actor`.  Each builder accepts it either as a positional
// arg (overlay site passes `helper`) or via `this`-binding (the sheet shim
// calls builders with `this` bound to the sheet, which already has `.actor`).
// One builder serves both contexts.
const LAST_CONTAINER_FLAG = "lastContainer";

/** Draw a weapon: pull it out of any container that holds it (remembering
 *  the container's id on the weapon so Sheathe can put it back later), then
 *  equip it back into its last slot — `system.slot` (Right/Left/Quick),
 *  defaulting to Right, or the free hand if its last slot is taken. A
 *  two-handed weapon occupies both hands. The conflict check is run before
 *  anything is touched. */
export async function drawWeapon(actor, item, { spendAction = true } = {}) {
  if (!actor || !item || (item.type !== "weapon" && item.type !== "shield")) return;

  // Drawing in combat is an action — refuse the draw outright with no slot left.
  if (spendAction && !canSpendCombatAction(actor)) return;

  const slot = autoEquipSlot(actor, item);
  const occ  = occupancyForSlot(item, slot) ?? "right";

  // Pre-check BEFORE touching the container or equip state. If the equip
  // would conflict, abort early so the weapon stays inside its container
  // instead of being yanked out and left dangling on the grid.
  const check = checkEquipConflicts(actor, item.id, occ);
  if (!check.ok) {
    ui?.notifications?.warn?.(describeEquipFailure(item.name, check));
    return;
  }

  const containerId = findContainerHoldingItem(actor, item.id);
  if (containerId) {
    try { await item.setFlag(MODULE_ID, LAST_CONTAINER_FLAG, containerId); } catch {}
    await removeItemFromSource(actor, item, `container:${containerId}`);
  }
  await assignSlot(actor, item.id, slot);
  // "Drew" only fits pulling from a sheath/container; a loose item is "Equipped".
  ui?.notifications?.info?.(containerId ? `Drew ${item.name}.` : `Equipped ${item.name}.`);

  // Drawing a weapon is a single action (Core p.151). Spend a slot only
  // inside an active combat the actor is part of. Fast Draw is the exception
  // — it folds the draw into the attack and passes spendAction:false.
  // Manticore: drawing/equipping a shield-type item is free.
  const freeShield = isShieldItem(item) && (Number(actor?.system?.combatMods?.freeShieldEquip) || 0) > 0;
  if (spendAction && !freeShield) await chargeCombatAction(actor, `Draw: ${item.name}`);
}

/** Copy a world-level Item document onto the assigned actor and return the
 *  new embedded Item.
 *
 *  Strips every identity + provenance field that could make Foundry think
 *  this is a "move" of the source (which would delete the world copy):
 *    _id, _stats.duplicateSource, _stats.compendiumSource, ownership,
 *    folder, sort, flags.core.sourceId. Also resets equipped/isStored. */
async function cloneItemToActor(actor, sourceItem) {
  if (!actor || !sourceItem) return null;
  const data = foundry.utils.duplicate(sourceItem.toObject(false));
  delete data._id;
  delete data.folder;
  delete data.sort;
  delete data.ownership;
  if (data._stats) {
    delete data._stats.duplicateSource;
    delete data._stats.compendiumSource;
  }
  if (data.flags?.core) {
    delete data.flags.core.sourceId;
  }
  if (data.system) {
    if ("equipped" in data.system) data.system.equipped = false;
    if ("isStored" in data.system) data.system.isStored = false;
  }
  const created = await actor.createEmbeddedDocuments("Item", [data]);
  return created?.[0] ?? null;
}

/** Resolve the world Item referenced by a sidebar `<li>` element. */
function resolveSidebarItem(li) {
  const id = li?.dataset?.documentId ?? li?.dataset?.entryId;
  return id ? game.items?.get(id) : null;
}

/** Delete the world Item once it's been successfully claimed by a player.
 *  Without this, Equip/Stow/Sheathe would leave the world copy behind and
 *  the same item could be claimed an unlimited number of times. */
async function claimWorldItem(item) {
  if (!item) return;
  try {
    if (item.canUserModify?.(game.user, "delete")) {
      await item.delete();
    } else {
      console.warn(`${MODULE_ID} | no delete permission on claimed world item ${item.name}`);
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | failed to delete claimed world item`, err);
  }
}

/** Right-click → Equip. Clones the world weapon onto the assigned actor and
 *  draws it (sets equipped + native hand via drawWeapon). */
function buildSidebarEquipEntry() {
  return {
    name: "Equip",
    icon: '<i class="fa-solid fa-hand-fist"></i>',
    condition: (li) => {
      const item = resolveSidebarItem(li);
      if (!item || item.type !== "weapon") return false;
      const actor = getAssignedActor();
      return !!(actor && actor.isOwner);
    },
    callback: async (li) => {
      const item = resolveSidebarItem(li);
      const actor = getAssignedActor();
      if (!item || !actor) return;
      // Pre-check using a synthetic id (the world item's id won't match
      // anything on the actor — checkEquipConflicts simply excludes the
      // supplied id from its iteration). If we'd conflict, warn now and
      // don't create the clone in the first place. Two-handed weapons take
      // both hands; one-handed default to Right (auto-fallback happens after
      // the clone exists, via drawWeapon → autoEquipSlot).
      const targetHand = item.system?.hands === "two" ? "both" : "right";
      const check = checkEquipConflicts(actor, "__pre_clone__", targetHand);
      if (!check.ok) {
        ui?.notifications?.warn?.(describeEquipFailure(item.name, check));
        return;
      }
      const cloned = await cloneItemToActor(actor, item);
      if (cloned) {
        await drawWeapon(actor, cloned);
        await claimWorldItem(item);
      }
    }
  };
}

/** Right-click → Stow. Clones the world item onto the assigned actor's
 *  general inventory (no container, not equipped). */
function buildSidebarStowEntry() {
  return {
    name: "Stow",
    icon: '<i class="fa-solid fa-box"></i>',
    condition: (li) => {
      const item = resolveSidebarItem(li);
      if (!item) return false;
      const actor = getAssignedActor();
      return !!(actor && actor.isOwner);
    },
    callback: async (li) => {
      const item = resolveSidebarItem(li);
      const actor = getAssignedActor();
      if (!item || !actor) return;
      // Stowing a world item is a combat action — block when no slot remains.
      if (!canSpendCombatAction(actor)) return;
      const cloned = await cloneItemToActor(actor, item);
      if (cloned) {
        ui?.notifications?.info?.(`Stowed ${item.name}.`);
        await chargeCombatAction(actor, `Stow: ${item.name}`);
        await claimWorldItem(item);
      }
    }
  };
}

/** Right-click → Sheathe. Clones the world weapon onto the assigned actor
 *  and pushes it into a container the actor owns (via sheathWeapon, which
 *  picks the first container). Hidden when the actor has no container. */
function buildSidebarSheatheEntry() {
  return {
    name: "Sheathe",
    icon: '<i class="fa-solid fa-box-archive"></i>',
    condition: (li) => {
      const item = resolveSidebarItem(li);
      if (!item || item.type !== "weapon") return false;
      const actor = getAssignedActor();
      if (!actor || !actor.isOwner) return false;
      // Need at least one container equipped on the rail; off-rail
      // containers are unreachable for draw, so we don't sheath into them.
      const railed = new Set(getRail(actor).assignments.filter(Boolean));
      if (railed.size === 0) return false;
      return !!actor.items.find(i => i.type === "container" && railed.has(i.id));
    },
    callback: async (li) => {
      const item = resolveSidebarItem(li);
      const actor = getAssignedActor();
      if (!item || !actor) return;
      const cloned = await cloneItemToActor(actor, item);
      if (cloned) {
        await sheathWeapon(actor, cloned);
        await claimWorldItem(item);
      }
    }
  };
}

Hooks.on?.("getItemContextOptions", (_app, entries) => {
  entries.push(
    buildSidebarEquipEntry(),
    buildSidebarSheatheEntry(),
    buildSidebarStowEntry()
  );
});

/** Drop an item out of the actor's inventory entirely and into the world's
 *  Items collection. The world copy gets default OWNER ownership so any
 *  player can pick it up. The original is removed from the actor (including
 *  its container content array if it lived inside one). */
export async function dropWeaponToWorld(actor, item) {
  if (!actor || !item) return;
  const itemData = item.toObject(false);
  const OWNER = (globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER) ?? 3;
  itemData.ownership = { default: OWNER };
  let created;
  try {
    created = await Item.implementation.create(itemData);
  } catch (err) {
    console.warn(`${MODULE_ID} | dropWeaponToWorld create failed`, err);
    ui?.notifications?.error?.(`Failed to drop ${item.name}.`);
    return;
  }
  if (!created) return;
  const containerId = findContainerHoldingItem(actor, item.id);
  if (containerId) {
    const c = actor.items.get(containerId);
    if (c) {
      const content = (c.system?.content ?? []).filter(u => u !== item.uuid && u !== item.id);
      await c.update({ "system.content": content });
    }
  }
  await item.delete();
  ui?.notifications?.info?.(`Dropped ${item.name} to the world.`);
}

/** Sheathe a weapon. Restore it to whichever container makes sense:
 *  1) the container it was drawn FROM (if that container still exists on
 *     this actor) — tracked via the lastContainer flag set in drawWeapon;
 *  2) otherwise, the first container the actor has;
 *  3) otherwise, just unequip the weapon. */
export async function sheathWeapon(actor, item) {
  if (!actor || !item || (item.type !== "weapon" && item.type !== "shield")) return;

  // Fast Draw means you snap-drew a weapon and must attack with it this turn —
  // you can't sheathe until the status clears (start of your next turn).
  if (actor.statuses?.has?.("fastDraw")) {
    ui?.notifications?.warn?.("Can't sheathe while Fast Draw is active — you must attack with the drawn weapon this turn.");
    return;
  }

  // Sheathing in combat is an action — refuse the sheathe outright with no slot.
  if (!canSpendCombatAction(actor)) return;

  /* Sheathe target must be a railed container — anything off-rail is
   * unreachable for the next Draw, so we don't allow it as a sheath
   * destination either.  Prefer the last container the weapon was
   * drawn from (if still railed), otherwise the first railed container,
   * otherwise just unequip. */
  const lastId = item.getFlag?.(MODULE_ID, LAST_CONTAINER_FLAG);
  const railed = new Set(getRail(actor).assignments.filter(Boolean));
  let target = (lastId && railed.has(lastId)) ? actor.items.get(lastId) : null;
  if (!target || target.type !== "container") {
    for (const c of actor.items) {
      if (c.type !== "container" || !railed.has(c.id)) continue;
      target = c;
      break;
    }
  }

  // Refuse the sheathe if the destination container can't fit the weapon —
  // done BEFORE unequipping/charging so a rejected sheathe leaves the weapon
  // equipped and costs no action.
  if (target && !fitsInContainer(target, item)) {
    ui?.notifications?.warn?.(overflowWarning(target, item));
    return;
  }

  // Just clear the equipped flag — leave `hands` alone so the weapon
  // remembers its preferred hand for the next Draw.
  if (item.system?.equipped) {
    await item.update({ "system.equipped": false });
  }

  if (target) {
    const content = target.system?.content ?? [];
    if (!content.includes(item.uuid) && !content.includes(item.id)) {
      await target.update({ "system.content": [...content, item.uuid] });
    }
    await item.update({ "system.isStored": true });
    ui?.notifications?.info?.(`Sheathed ${item.name} in ${target.name}.`);
  } else {
    ui?.notifications?.info?.(`Sheathed ${item.name}.`);
  }

  // Sheathing a weapon is a single action (Core p.151), same as drawing. Note
  // that *dropping* a weapon (dropWeaponToWorld) is free — it costs no action.
  await chargeCombatAction(actor, `Sheathe: ${item.name}`);
}

/** Right-click → Draw menu entry. Only appears on weapons that currently
 *  live inside one of the actor's own containers — you can't Draw a
 *  weapon that's just lying loose on your grid or already equipped. */
function buildDrawEntry(owner) {
  const ctx = owner ?? this;
  return {
    name: "Draw",
    icon: '<i class="fa-solid fa-hand-fist"></i>',
    condition: (itemHtml) => {
      const actor = ctx?.actor;
      const item = actor?.items?.get(itemHtml.dataset.itemId);
      if (!item || (item.type !== "weapon" && item.type !== "shield")) return false;
      if (item.system?.equipped) return false;
      // Drawing is a combat action that pulls the item out of a container.
      // A loose item can't be drawn — it's Equipped instead (see Equip entry).
      return !!findContainerHoldingItem(actor, item.id);
    },
    callback: async (itemHtml) => {
      const item = ctx?.actor?.items?.get(itemHtml.dataset.itemId);
      await drawWeapon(ctx?.actor, item);
    }
  };
}

/** Right-click → Equip menu entry. The out-of-combat counterpart to Draw:
 *  appears on a LOOSE (uncontained) unequipped weapon. Equipping is not a
 *  combat action and can't be done during combat — in combat a weapon must be
 *  Drawn from a container instead. Passes spendAction:false so no action slot
 *  is consumed. */
function buildEquipEntry(owner) {
  const ctx = owner ?? this;
  return {
    name: "Equip",
    icon: '<i class="fa-solid fa-hand"></i>',
    condition: (itemHtml) => {
      const actor = ctx?.actor;
      const item = actor?.items?.get(itemHtml.dataset.itemId);
      if (!item || (item.type !== "weapon" && item.type !== "shield")) return false;
      if (item.system?.equipped) return false;
      if (findContainerHoldingItem(actor, item.id)) return false;   // containered → Draw
      return !isActorInActiveCombat(actor);                          // can't equip in combat
    },
    callback: async (itemHtml) => {
      const item = ctx?.actor?.items?.get(itemHtml.dataset.itemId);
      await drawWeapon(ctx?.actor, item, { spendAction: false });
    }
  };
}

/** Right-click → Sheathe menu entry. The inverse of Draw: appears on equipped
 *  weapons and returns them to the container they were drawn from (sheathWeapon
 *  prefers the lastContainer flag, falling back to the first railed container).
 *  Hidden when the actor has no railed container to sheathe into. */
function buildSheatheEntry(owner) {
  const ctx = owner ?? this;
  return {
    name: "Sheathe",
    icon: '<i class="fa-solid fa-box-archive"></i>',
    condition: (itemHtml) => {
      const actor = ctx?.actor;
      const item = actor?.items?.get(itemHtml.dataset.itemId);
      if (!item || (item.type !== "weapon" && item.type !== "shield")) return false;
      if (!item.system?.equipped) return false;
      // Need a railed container to return the item to.
      const railed = new Set(getRail(actor).assignments.filter(Boolean));
      if (railed.size === 0) return false;
      return !!actor.items.find(c => c.type === "container" && railed.has(c.id));
    },
    callback: async (itemHtml) => {
      const item = ctx?.actor?.items?.get(itemHtml.dataset.itemId);
      await sheathWeapon(ctx?.actor, item);
    }
  };
}

/** Right-click → Open menu entry. Opens a container as a floating popup
 *  anchored over its tile, WITHOUT assigning it to the rail. */
function buildOpenContainerEntry(owner) {
  const ctx = owner ?? this;
  return {
    name: "Open",
    icon: '<i class="fa-solid fa-box-open"></i>',
    condition: (itemHtml) => {
      const item = ctx?.actor?.items?.get(itemHtml.dataset.itemId);
      return item?.type === "container";
    },
    callback: (itemHtml) => {
      const item = ctx?.actor?.items?.get(itemHtml.dataset.itemId);
      if (item) openContainerFloating(item.id, itemHtml);
    }
  };
}

function buildDropOnSceneEntry(owner) {
  const ctx = owner ?? this;
  return {
    name: "Drop on Scene",
    icon: '<i class="fa-solid fa-scroll"></i>',
    condition: (itemHtml) => {
      const item = ctx?.actor?.items?.get(itemHtml.dataset.itemId);
      // Notes are the droppable parchment — drag one onto the scene to post
      // it as a readable/swipeable parchment (handled by the parchment layer;
      // Tile fallback otherwise). Replaces the old quest-item valuable path.
      return item?.type === "note";
    },
    callback: async (itemHtml) => {
      const item = ctx?.actor?.items?.get(itemHtml.dataset.itemId);
      if (!item) return;
      await dropItemOnScene(ctx.actor, item);
    }
  };
}

async function dropItemOnScene(actor, item) {
  const scene = game?.scenes?.viewed;
  if (!scene) {
    ui?.notifications?.warn?.("No active scene to drop into.");
    return;
  }
  // Place at the actor's token if present, else scene center.
  const token = actor?.getActiveTokens?.()[0] ?? null;
  const grid  = scene.grid?.size ?? 100;
  const dims  = scene.dimensions ?? { width: scene.width ?? grid * 10, height: scene.height ?? grid * 10 };
  const cx    = token?.center?.x ?? dims.width  / 2;
  const cy    = token?.center?.y ?? dims.height / 2;

  // Pin the note as a native notice-board parchment posting (click-to-read,
  // swipe-to-inventory, GM-mediated scene-flag writes, source cleanup).
  await postNoteToScene(scene, item, { x: cx, y: cy });
}

/* Build the inventory-style right-click entries.  Shared by the main
 * inventory overlay (invEl) and the floating container popup that the
 * hotbar opens — without this both would render the same items but only
 * the overlay would respond to right-click. */
async function buildInventoryContextEntries() {
  const proto = getWitcherSheetProto();
  if (!proto) return null;

  /* The helper INHERITS the sheet prototype's entry builders (editItem,
   * equipMenuEntries, deleteItem, …) so each call runs with the sheet's own
   * logic but resolves `this.actor` to whichever PC the GM is currently
   * impersonating.  The `actor` accessor is defined explicitly so each read
   * re-invokes `getAssignedActor()` — a frozen value would break right-click
   * the moment the GM switched view-as actors (condition callbacks would look
   * up items on the wrong/null actor and every condition would return false). */
  const helper = Object.create(proto);
  Object.defineProperty(helper, "actor", {
    get: () => getAssignedActor(),
    configurable: true,
    enumerable: true,
  });

  // Build the menu entries DIRECTLY by calling the base mixin's methods.
  // Earlier attempts captured them via a stub-ContextMenu trick; that
  // proved brittle and broke right-click entirely.  Direct construction is
  // both simpler and reliable.
  const baseGift = helper.giftableItem?.();
  const entries = [
    helper.editItem?.(),
    helper.consumableItem?.(),
    helper.removableEnhancement?.(),
    baseGift ? buildStackAwareGift(baseGift, helper) : null
  ].filter(Boolean);

  // Append witcher-food-and-drink entries (Pour Glass / Serve Piece) if
  // the module is active.  We import its exported helpers and replicate
  // the small inline entry objects from its buildFoodAndDrinkEntries.
  await appendFoodAndDrinkEntries(helper, entries);

  // Owned-stack-only additions (no meaning for a world template, so these
  // stay off the sidebar): Draw, Split Stack, Drop on Scene.
  entries.push(buildDrawEntry(helper));
  entries.push(buildEquipEntry(helper));
  entries.push(buildSheatheEntry(helper));
  entries.push(buildOpenContainerEntry(helper));
  entries.push(buildSplitStackEntry(helper));
  entries.push(buildDropOnSceneEntry(helper));

  // Unified item actions — Consume, Apply to Weapon, plus the remains
  // (Harvest/Extract/Dissect/Open Carcass) and book (Study/Read/Review)
  // actions. Registered once (context-menu-item.js / consume-item.js /
  // registerApplyOilAction); shared with the actor sheet and the Items
  // sidebar so a new action only has to be declared in one place.
  entries.push(...buildItemActionEntries(
    (itemHtml) => getAssignedActor()?.items?.get(itemHtml?.dataset?.itemId),
    () => getAssignedActor(),
    "overlay"
  ));

  // Stack-aware delete goes last — replaces the system's blunt delete with
  // one that prompts when quantity > 1 (delete whole stack vs. just one).
  const baseDelete = helper.deleteItem?.();
  if (baseDelete) entries.push(buildStackAwareDelete(baseDelete, helper));

  return entries;
}

async function wireWitcherContextMenu() {
  if (!invEl) return;
  const entries = await buildInventoryContextEntries();
  if (!entries) return;
  try {
    // `fixed: true` opts into the HTML5 popover top-layer rendering, so the
    // menu always paints above everything regardless of grid stacking.
    // Without it, ContextMenu injects the <nav> INSIDE the right-clicked
    // element, where later-in-DOM-order siblings paint over it (which made
    // the menu appear behind alchemical icons in the row below).
    new foundry.applications.ux.ContextMenu(invEl, ".item", entries, {
      jQuery: false,
      fixed: true
    });
  } catch (err) {
    console.warn(`${MODULE_ID} | failed to construct ContextMenu`, err);
  }
}

/* Wire the same right-click menu on a floating container popup. The popup
 * is appended to <body> (so it can float over the hotbar/dock), which puts
 * it outside the invEl ContextMenu scope — without this its items would
 * silently swallow right-clicks. */
async function wireFloatingPopupContextMenu(popupEl) {
  if (!popupEl) return;
  const entries = await buildInventoryContextEntries();
  if (!entries) return;
  // Bail if the popup was closed while entries were being built.
  if (!popupEl.isConnected) return;
  try {
    new foundry.applications.ux.ContextMenu(popupEl, ".item", entries, {
      jQuery: false,
      fixed: true
    });
  } catch (err) {
    console.warn(`${MODULE_ID} | failed to construct floating-popup ContextMenu`, err);
  }
}

/* =========================================================================
   APPLY OIL TO WEAPON  (from witcher-alchemy-craft)
   Replicated here because the module doesn't export its helpers.  Flag
   and storage shape match the original so the alchemy-craft module's own
   weapon-row UI / charge deduction logic continues to work seamlessly.
   ========================================================================= */

/* Oil coating is effect-based: the oil item carries its own ActiveEffect(s)
 * (the user sets the duration — e.g. 30 min, Core p.248 — and writes the
 * bonus/monster-type in the effect's description). Applying the oil COPIES
 * those effects onto the WEAPON (transfer:false → display-only, no automation),
 * re-anchoring each duration to the moment of application. They expire on their
 * own Foundry duration (world time) and self-delete via sweepExpiredOilCoatings.
 * Each copied effect is tagged flags.<MODULE_ID>.oilCoating so we can find,
 * render, and sweep them. */
const OIL_FLAG = "oilCoating";

function stripHtml(s) {
  return String(s ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/* Every oil-coating effect on a weapon (incl. disabled), for find/wipe. */
function oilCoatingEffects(weapon) {
  return [...(weapon?.effects ?? [])].filter(e => !!e.getFlag?.(MODULE_ID, OIL_FLAG));
}

/* Remaining/total seconds for a time-bounded effect; Infinity when the effect
 * has no seconds duration (treated as "never auto-expires"). */
function effectRemaining(effect) {
  const total = Number(effect?.duration?.seconds);
  if (!(total > 0)) return { remaining: Infinity, total: Infinity };
  // v14 computes secondsRemaining from start.time + value/units at prepare
  // time; prefer it and fall back to total only if it isn't populated yet.
  const rem = Number(effect?.duration?.secondsRemaining);
  return { remaining: Number.isFinite(rem) ? rem : total, total };
}

/* Live coating on a weapon, or null when uncoated/expired. The representative
 * is the soonest-expiring active oil effect (drives the bar + worn-off check).
 * We carry that effect's live `duration` object out so the display can run it
 * through describeDuration — the SAME path potion badges use — instead of a
 * pre-reduced seconds value, so oils and potions read identically (rounds in
 * combat, wall clock out of it). Effect text is every description joined. */
function readOilCoating(weapon) {
  let repRem = Infinity, repDur = null, name = null, img = "";
  const texts = [];
  for (const e of oilCoatingEffects(weapon)) {
    if (e.disabled) continue;
    const { remaining } = effectRemaining(e);
    if (Number.isFinite(remaining) && remaining <= 0) continue;   // worn off
    const desc = stripHtml(e.description);
    if (desc) texts.push(desc);
    if (name == null || remaining < repRem) {
      repRem = remaining; repDur = e.duration;
      const flag = e.getFlag(MODULE_ID, OIL_FLAG) || {};
      name = flag.oilName ?? e.name ?? "Oil";
      img  = flag.oilImg ?? e.img ?? "";
    }
  }
  if (name == null) return null;
  return { name, img, effect: texts.join(" · "), dur: repDur };
}

/* Source-side summary of an oil's configured effects (for the apply dialog):
 * whether it has any enabled effect, the longest-lasting effect's live duration
 * object (fed through describeDuration so the dialog reads the same as the
 * applied coating), and the joined description text. */
function oilSourceInfo(oil) {
  const effects = [...(oil?.effects ?? [])].filter(e => !e.disabled);
  let best = -1, dur = null;
  const texts = [];
  for (const e of effects) {
    const s = Number(e.duration?.seconds);
    if (Number.isFinite(s) && s > best) { best = s; dur = e.duration; }
    const d = stripHtml(e.description);
    if (d) texts.push(d);
  }
  return {
    hasEffect: effects.length > 0,
    dur,
    effectText: texts.join(" · ")
  };
}

/* Apply to Weapon — a unified item action, so it shows on the actor sheet,
 * the chrome inventory overlay, AND the Items sidebar. Coating a weapon copies
 * the oil's effect onto a chosen weapon without spending the oil, so running it
 * against a world template (sidebar) is non-destructive. */
function registerApplyOilAction() {
  registerItemAction({
    name: "Apply to Weapon",
    icon: '<i class="fa-solid fa-sword"></i>',
    /* Owned-dose action: only on the actor sheet and inventory overlay, never
     * the world Items sidebar (a coating is applied to a carried weapon). */
    surfaces: { sidebar: false },
    condition: (item) =>
      item?.type === "alchemical" &&
      item.system?.type === "oil" &&
      (parseInt(item.system?.quantity) || 0) > 0,
    callback: (item, actor) => {
      if (!actor) {
        ui?.notifications?.warn?.(`Assign a character (in your User Configuration) to apply ${item.name}.`);
        return;
      }
      openCoatWeaponDialog(actor, item);
    }
  });
}

/* Register at module-import time (init), NOT in a ready hook: the Items
 * sidebar builds its context menu ONCE when the directory first renders, and
 * entries registered after that point never appear. Importing this module
 * happens during init (via index.mjs), so this runs before any render —
 * matching how carcass/book/consume actions register early. */
registerApplyOilAction();

async function openCoatWeaponDialog(actor, oil) {
  const info = oilSourceInfo(oil);
  if (!info.hasEffect) {
    ui?.notifications?.warn?.(`${oil.name} has no effect configured — add one (with a duration) on the oil's Effects tab.`);
    return;
  }
  const weapons = actor.items
    .filter(i => i.type === "weapon")
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!weapons.length) {
    ui?.notifications?.warn?.("No weapons in inventory.");
    return;
  }
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2) return;

  const options = weapons.map(w => {
    const existing = readOilCoating(w);
    const label = existing ? `${w.name}  [coated: ${existing.name}]` : w.name;
    return `<option value="${escapeAttr(w.id)}">${escapeText(label)}</option>`;
  }).join("");

  const lastsDur = info.dur ? describeDuration(info.dur) : null;
  const lasts = lastsDur && lastsDur.total > 0 ? `Lasts ${lastsDur.label}` : "No duration set — applies until cleansed";
  const content = `
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:10px; padding-bottom:8px; border-bottom:1px solid rgba(140,133,121,0.18);">
      <img src="${escapeAttr(oil.img)}" style="width:32px; height:32px; border-radius:4px;" />
      <div>
        <b>${escapeText(oil.name)}</b>
        <div>${escapeText(lasts)}</div>
        ${info.effectText ? `<div><i>${escapeText(info.effectText)}</i></div>` : ""}
      </div>
    </div>
    <label>Select weapon to coat:</label>
    <select name="weaponId" style="width:100%;">${options}</select>
  `;

  const weaponId = await DialogV2.wait({
    window: { title: `Apply Oil: ${oil.name}` },
    content,
    buttons: [
      {
        action: "apply",
        label: "Coat Weapon",
        default: true,
        callback: (event, button) => button.form?.elements?.weaponId?.value || null
      },
      { action: "cancel", label: "Cancel" }
    ],
    rejectClose: false
  }).catch(() => null);

  if (!weaponId || weaponId === "cancel") return;
  const weapon = actor.items.get(weaponId);
  if (!weapon) return;
  await applyOilToWeapon(weapon, oil);
}

async function applyOilToWeapon(weapon, oil) {
  /* Copy the oil's enabled effects onto the weapon: display-only
   * (transfer:false), duration re-anchored to now, tagged as an oil coating. */
  const now = game.time?.worldTime ?? 0;
  const sources = [...(oil.effects ?? [])]
    .filter(e => !e.disabled)
    .map(e => {
      const data = e.toObject();
      delete data._id;
      data.transfer = false;
      data.disabled = false;
      data.origin   = weapon.uuid;
      data.duration = { ...(data.duration ?? {}) };
      // v14: an effect's start time lives at `start.time`, NOT
      // `duration.startTime`. Re-anchor the coating to begin now so its
      // remaining time counts from application (the oil item's template
      // effect carries no/old start). `e.duration.seconds` is the prepared
      // value derived from the source's {value, units}.
      const durSecs = Number(e.duration?.seconds);
      if (Number.isFinite(durSecs) && durSecs > 0) data.start = { time: now };
      foundry.utils.setProperty(data, `flags.${MODULE_ID}.${OIL_FLAG}`, {
        oilId: oil.id, oilName: oil.name, oilImg: oil.img
      });
      return data;
    });
  if (!sources.length) {
    ui?.notifications?.warn?.(`${oil.name} has no effect configured — add one on the oil's Effects tab.`);
    return;
  }

  /* Oiling makes a weapon one-of-a-kind. If it's part of a stack, peel ONE
   * unit off to receive the coating so the rest stay a plain (uncoated)
   * stack. */
  let target = weapon;
  const wQty = Number(weapon.system?.quantity) || 1;
  if (wQty > 1) {
    const owner = weapon.actor ?? weapon.parent;
    await weapon.update({ "system.quantity": wQty - 1 });
    const data = weapon.toObject(false);
    delete data._id;
    data.effects = [];
    data.system  = { ...(data.system ?? {}), quantity: 1 };
    const [created] = await owner.createEmbeddedDocuments("Item", [data]);
    target = created;
  }

  /* One coating at a time: wipe any prior oil before laying the new one on. */
  const prior = oilCoatingEffects(target).map(e => e.id);
  if (prior.length) await target.deleteEmbeddedDocuments("ActiveEffect", prior);
  await target.createEmbeddedDocuments("ActiveEffect", sources);

  const qty = parseInt(oil.system.quantity) || 1;
  if (qty <= 1) await oil.delete();
  else await oil.update({ "system.quantity": qty - 1 });
}

/* GM-only world-time sweep: delete oil coatings whose duration has run out.
 * Oils expire on real (world) time — 30 game-minutes — not combat rounds, so
 * the round-based tick engine never sees them; this runs on updateWorldTime. */
export async function sweepExpiredOilCoatings() {
  if (!game.user?.isActiveGM) return;
  for (const actor of game.actors ?? []) {
    for (const weapon of actor.items ?? []) {
      if (weapon.type !== "weapon") continue;
      const expired = [];
      for (const e of weapon.effects ?? []) {
        if (!e.getFlag?.(MODULE_ID, OIL_FLAG)) continue;
        const secs = Number(e.duration?.seconds);
        if (!(secs > 0)) continue;   // no time duration → never auto-expires
        // v14 computes `duration.expired`/`secondsRemaining` from start.time.
        if (e.duration?.expired === true) { expired.push(e.id); continue; }
        const rem = Number(e.duration?.secondsRemaining);
        if (Number.isFinite(rem) && rem <= 0) expired.push(e.id);
      }
      if (expired.length) {
        try { await weapon.deleteEmbeddedDocuments("ActiveEffect", expired); }
        catch (err) { console.warn(`${MODULE_ID} | oil sweep delete failed`, err); }
      }
    }
  }
}

function buildStackAwareGift(baseGift, owner) {
  const ctx = owner ?? this;
  return {
    ...baseGift,
    callback: async (itemHtml) => {
      const actor = ctx?.actor;
      const item  = actor?.items?.get(itemHtml.dataset.itemId);
      if (!item) return;
      const qty = Number(item.system?.quantity) || 1;
      const DialogV2 = foundry?.applications?.api?.DialogV2;
      // Fall back to the system's single-item gift if the dialog API
      // isn't available.
      if (!DialogV2) {
        if (typeof baseGift.callback === "function") return baseGift.callback(itemHtml);
        return;
      }

      const players = game.actors?.filter?.(a => a.hasPlayerOwner) ?? [];
      if (players.length === 0) {
        ui?.notifications?.warn?.("No player-owned actors to gift to.");
        return;
      }
      const options = players
        .map(t => `<option value="${escapeAttr(t.uuid)}">${escapeText(t.name)}</option>`)
        .join("");

      const hasStack = qty > 1;
      const content = `
        <p>Gift <b>${escapeText(item.name)}</b>${hasStack ? ` (stack of ${qty})` : ""}.</p>
        <div style="display:flex; align-items:center; gap:8px; margin:8px 0;">
          <label>To:</label>
          <select name="actor" style="flex:1;">${options}</select>
        </div>
        ${hasStack ? `
          <div style="display:flex; align-items:center; gap:8px; margin:8px 0;">
            <label>How many:</label>
            <input name="count" type="number" value="1" min="1" max="${qty}" style="width:80px;" />
          </div>
        ` : ""}
      `;

      const buttons = [{
        action: "give",
        label: "Gift",
        default: true,
        callback: (event, button) => ({
          receiver: button.form?.elements?.actor?.value || "",
          count: hasStack
            ? Math.max(1, Math.min(qty, Math.floor(Number(button.form?.elements?.count?.value) || 1)))
            : 1
        })
      }];
      if (hasStack) {
        buttons.push({
          action: "all",
          label: `Gift all (×${qty})`,
          callback: (event, button) => ({
            receiver: button.form?.elements?.actor?.value || "",
            count: qty
          })
        });
      }

      const result = await DialogV2.wait({
        window: { title: `Gift ${item.name}` },
        content, buttons,
        rejectClose: false
      }).catch(() => null);
      if (!result || !result.receiver || !result.count) return;
      const { receiver, count } = result;

      try {
        if (game.user.isGM) {
          const receiverActor = fromUuidSync(receiver);
          if (typeof receiverActor?.addItem === "function") {
            await receiverActor.addItem(item, count);
          }
        } else {
          // Use the system's GM-proxy socket (same path the base gift uses)
          // so non-GM players can still gift through the active GM.
          const sock = await import("/systems/TheWitcherTRPG/module/scripts/socket/socketMessage.js");
          if (typeof sock?.emitForGM === "function") {
            await sock.emitForGM("addItem", [receiver, item, count]);
          }
        }
        if (typeof actor.removeItem === "function") {
          await actor.removeItem(item.id, count);
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | gift failed`, err);
      }
    }
  };
}

/**
 * Split N off a stack — opens a number-input dialog (defaulting to half),
 * decrements the source, and creates a sibling item with the split quantity.
 * Hidden when quantity == 1.
 */
function buildSplitStackEntry(owner) {
  const ctx = owner ?? this;
  return {
    name: "Split Stack",
    icon: '<i class="fa-solid fa-arrows-split-up-and-left"></i>',
    condition: (itemHtml) => {
      const actor = ctx?.actor;
      const item  = actor?.items?.get(itemHtml.dataset.itemId);
      if (!item) return false;
      return (Number(item.system?.quantity) || 1) > 1;
    },
    callback: async (itemHtml) => {
      const actor = ctx?.actor;
      const item  = actor?.items?.get(itemHtml.dataset.itemId);
      if (!actor || !item) return;
      const qty = Number(item.system?.quantity) || 1;
      if (qty <= 1) return;

      const DialogV2 = foundry?.applications?.api?.DialogV2;
      if (!DialogV2) return;

      const half = Math.max(1, Math.floor(qty / 2));
      const content = `
        <p>Stack of <b>${qty}</b>× <b>${escapeText(item.name)}</b>.</p>
        <div style="display:flex; align-items:center; gap:8px; margin:8px 0;">
          <label for="wou-split-n">Split off how many:</label>
          <input id="wou-split-n" name="count" type="number" value="${half}" min="1" max="${qty - 1}" style="width:80px;" />
        </div>
      `;
      const result = await DialogV2.wait({
        window: { title: `Split ${item.name}` },
        content,
        buttons: [
          {
            action: "split",
            label: "Split",
            default: true,
            callback: (event, button) => {
              const raw = Number(button.form?.elements?.count?.value) || 1;
              return Math.max(1, Math.min(qty - 1, Math.floor(raw)));
            }
          },
          { action: "cancel", label: "Cancel" }
        ],
        rejectClose: false
      }).catch(() => null);

      if (result == null || result === "cancel") return;
      const n = Number(result);
      if (!Number.isFinite(n) || n <= 0 || n >= qty) return;

      /* Decrement source, then create a sibling stack with qty=N.
       * Sibling is unequipped + not stored so it lands in the on-person grid. */
      await item.update({ "system.quantity": qty - n });
      const data = item.toObject(false);
      delete data._id;
      data.system = { ...(data.system ?? {}), quantity: n, equipped: false, isStored: false };
      await actor.createEmbeddedDocuments("Item", [data]);
    }
  };
}

function buildStackAwareDelete(baseDelete, owner) {
  const ctx = owner ?? this;
  return {
    ...baseDelete,
    callback: async (itemHtml) => {
      const actor = ctx?.actor;
      const item  = actor?.items?.get(itemHtml.dataset.itemId);
      if (!item) return;
      const qty = Number(item.system?.quantity) || 1;
      if (qty <= 1) return item.delete();

      const DialogV2 = foundry?.applications?.api?.DialogV2;
      if (!DialogV2) return item.delete();

      const content = `
        <p>Stack of <b>${qty}</b>× <b>${escapeText(item.name)}</b>.</p>
        <div style="display:flex; align-items:center; gap:8px; margin:8px 0;">
          <label for="wou-del-n">Delete how many:</label>
          <input id="wou-del-n" name="count" type="number" value="1" min="1" max="${qty}" style="width:80px;" />
        </div>
      `;
      const result = await DialogV2.wait({
        window: { title: `Delete ${item.name}` },
        content,
        buttons: [
          {
            action: "some",
            label: "Delete",
            default: true,
            callback: (event, button) => {
              const raw = Number(button.form?.elements?.count?.value) || 1;
              return Math.max(1, Math.min(qty, Math.floor(raw)));
            }
          },
          { action: "all", label: `Delete all (×${qty})` }
        ],
        rejectClose: false
      }).catch(() => null);

      if (result == null) return;
      if (result === "all" || result === qty) return item.delete();
      const n = Number(result);
      if (!Number.isFinite(n) || n <= 0) return;
      if (typeof actor.removeItem === "function") return actor.removeItem(item.id, n);
      const newQty = qty - n;
      if (newQty <= 0) return item.delete();
      return item.update({ "system.quantity": newQty });
    }
  };
}

function injectBookCompletionBadges(actor) {
  if (!invEl || !actor) return;
  for (const slot of invEl.querySelectorAll(".wou-slot[data-item-id]")) {
    const item = actor.items?.get(slot.dataset.itemId);
    if (!isBookCompleted(item, actor)) continue;
    if (slot.querySelector(".wou-book-completed-badge")) continue;
    slot.querySelector(".icon")?.classList.add("wou-book-completed-img");
    const badge = document.createElement("div");
    badge.className = "wou-book-completed-badge";
    badge.innerHTML = `<i class="fa-solid fa-bookmark"></i>`;
    badge.dataset.tooltip = "Finished";
    slot.appendChild(badge);
  }
}

async function appendFoodAndDrinkEntries(helper, entries) {
  if (!game.modules?.get?.("witcher-food-and-drink")?.active) return;
  let charges;
  try {
    charges = await import("/modules/witcher-food-and-drink/scripts/charges.mjs");
  } catch (err) {
    console.warn(`${MODULE_ID} | failed to load witcher-food-and-drink for context menu`, err);
    return;
  }
  if (typeof charges?.isCharged !== "function" || typeof charges?.pourGlass !== "function") return;

  const flagsOf = (item) => item?.flags?.["witcher-food-and-drink"]?.charges ?? {};

  entries.push({
    name: "Pour Glass",
    icon: '<i class="fa-solid fa-wine-glass"></i>',
    callback: (itemHtml) => {
      const item = helper.actor?.items?.get(itemHtml.dataset.itemId);
      if (item) charges.pourGlass(item, 1);
    },
    condition: (itemHtml) => {
      const item = helper.actor?.items?.get(itemHtml.dataset.itemId);
      if (!item || !charges.isCharged(item)) return false;
      const f = flagsOf(item);
      return (f.category || "drink") === "drink" && Number(f.current ?? 0) > 0;
    }
  });
  entries.push({
    name: "Serve Piece",
    icon: '<i class="fa-solid fa-utensils"></i>',
    callback: (itemHtml) => {
      const item = helper.actor?.items?.get(itemHtml.dataset.itemId);
      if (item) charges.pourGlass(item, 1);
    },
    condition: (itemHtml) => {
      const item = helper.actor?.items?.get(itemHtml.dataset.itemId);
      if (!item || !charges.isCharged(item)) return false;
      const f = flagsOf(item);
      return (f.category || "drink") === "food" && Number(f.current ?? 0) > 0;
    }
  });
}

/* =========================================================================
   GLOBAL HANDLERS — Esc / click-outside / topbar tab sync
   ========================================================================= */

/**
 * Watch each chrome panel so the overlay re-fits the moment a bar
 * collapses, expands, or resizes:
 *   - ResizeObserver fires on actual width/height changes (sidebar drag,
 *     dock content changes, font load reflow).
 *   - MutationObserver on the chrome panel's class attribute catches
 *     collapsible state flips (.is-open / .is-peeking) — those transition
 *     via transform so they don't trigger ResizeObserver.
 *   - transitionend on the panels themselves catches the moment the
 *     collapse animation finishes so the final position settles correctly.
 */
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
    // Also observe body class so global collapsible state flags re-fit.
    _chromeMutationObs.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  }

  for (const sel of CHROME_SELECTORS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    el.addEventListener("transitionend",  reposition);
    el.addEventListener("animationend",   reposition);
  }
}

function syncTopbarTab(isOpen) {
  const tab = document.querySelector('#wou-top-bar [data-tab="inventory"]');
  if (!tab) return;
  tab.classList.toggle("is-active", isOpen);
}

/* =========================================================================
   UTILS
   ========================================================================= */

function escapeAttr(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
function escapeText(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
