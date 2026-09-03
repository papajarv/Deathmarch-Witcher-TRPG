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
 *                        note, mount); t("WITCHER.Common.All", "All") shows every physical item
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
import { isHomebrewEnabled, isCESubsystemEnabled } from "../../api/homebrew.mjs";
import { hrNewSilverRules, hrContainerEquipEV, containerEquipLimit } from "../../mechanics/house-rules-config.mjs";
import { layeringEquipBlock, layeringReadout } from "../../mechanics/armorLayering.mjs";
import { hasVisorQuality, isVisorRaised } from "../../mechanics/helmetVision.mjs";
import { registerItemAction, buildItemActionEntries, installSheetContextMenuExtra, installSheetContextMenuOverride } from "./context-menu-item.js";
import { isBookCompleted } from "../sheets/valuable-study.js";
import { ARMOR_LOCATION_COVERAGE, WEAPON_QUALITIES, ARMOR_QUALITIES, getActiveWeaponQualities, getActiveArmorQualities } from "../../setup/config.mjs";
import { ENHANCEMENT_TARGET } from "../../data/item/enhancement.mjs";
import {
  getFreshnessState,
  getFreshnessDaysRemaining,
  FRESHNESS_STALE_THRESHOLD
} from "../../mechanics/foodAndDrink.mjs";

/* Used by the transition detector below so the worldTime listener can
 * compare "state at the start of the window" vs "state now" without two
 * full getFreshnessState calls. Reuses the single source-of-truth threshold
 * imported above so the local detector can't drift from the mechanic. */
function ratioToState(ratio) {
  if (ratio >= 1)                         return "spoiled";
  if (ratio >= FRESHNESS_STALE_THRESHOLD) return "stale";
  return "fresh";
}
import { getPanelActor, setPanelOverride, VIEWER_OVERRIDE_HOOK, PANEL_OVERRIDE_HOOK, isActorInActiveCombat } from "../lib/actor.js";
import { renderViewAsPicker, wireViewAsPicker, renderViewPanelAsPicker, wireViewPanelAsPicker } from "../lib/view-as.js";
import { isVariablePortraitEnabled, openVariablePortraitConfig } from "../integrations/portrait-toxicity.js";
import { describeDuration } from "./dock-statuses.js";
import { t, tFormat } from "../lib/i18n.js";
import {
  fitsInContainer, fitsGeneralPool, overflowWarning, getCapacityDisplay, getContainerCfg,
  hasSlotRows, buildSlotLayout, tilePlaceholderIcon, tilePlaceholderIcons, rowTooltip, rowShortLabel,
  containerHasRoomForOne, unitsToTopNextSlot,
  describeSlot, slotOccupant, slotAcceptsItem,
  totalSlots, itemInFreeUseSlot,
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

/** "Parchment-flavored" items — letters/notes, diagrams/recipes, the new
 *  first-class `map` item type, and the `book` valuable subtype. Maps used
 *  to be a valuable subtype (system.type === "map") but were promoted to
 *  their own item type; the categorizer matches the document type now. */
function isParchmentLike(item) {
  if (!item) return false;
  if (item.type === "note" || item.type === "diagrams") return true;
  if (item.type === "map")  return true;
  if (item.type === "book") return true;   // first-class book item type
  // Legacy valuable-with-book-subtype — still matches until migration v5
  // rewrites the document to type:"book".
  if (item.type === "valuable") {
    const sub = String(item.system?.type ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
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

/** Items that land in the Valuables tab: generic `valuable` items PLUS the
 *  new first-class `remains` item type (monster carcasses sort here per
 *  spec). Food-drink and parchment-flavored items (maps, books) are claimed
 *  by their own tabs and carved out here so they don't appear twice. */
function isPlainValuable(item) {
  if (!item) return false;
  if (item.type === "remains") return true;
  // Spellcasting foci are equippable (armor slots) but sort into Valuables
  // in the grid alongside other gear-with-no-dedicated-tab.
  if (item.type === "focus") return true;
  if (item.type !== "valuable") return false;
  if (isFoodOrDrink(item)) return false;
  if (isParchmentLike(item)) return false;
  return true;
}

/** Tabs in display order.  `null` types = "All physical items".  Tabs
 *  may instead provide a `matches(item)` predicate for filters that
 *  don't map cleanly to item.type — e.g. Food and Drink is keyed off
 *  the witcher-food-and-drink charges flag rather than a base type, and
 *  Notes also pulls in map / book valuables. */
/** Categories (top tabs) → ordered sub-grids (labeled panels). Item→panel
 *  routing is centralized in `categorizeItem` (single source of truth for both
 *  bucketing and auto-placement), so panels here declare only id + label. */
export const INV_CATEGORIES = () => [
  { id: "gear", label: t("WITCHER.Chrome.Inventory.Cat.Gear", "Gear"), icon: "fa-swords", img: "Gear.png",
    subgrids: [
      { id: "weapons", label: t("WITCHER.Common.Weapons", "Weapons") },
      { id: "armor",   label: t("WITCHER.Common.Armor", "Armor") }
    ] },
  { id: "food", label: t("WITCHER.Chrome.Inventory.Cat.FoodShort", "Food"), icon: "fa-utensils", img: "Food.png",
    subgrids: [
      { id: "food",  label: t("WITCHER.Chrome.Inventory.Cat.Food", "Food") },
      { id: "drink", label: t("WITCHER.Chrome.Inventory.Cat.Drink", "Drink") }
    ] },
  { id: "alchemy", label: t("WITCHER.Common.Alchemy", "Alchemy"), icon: "fa-flask", img: "Alchemy.png",
    subgrids: [
      { id: "potions",         label: t("WITCHER.Chrome.Inventory.Cat.Potions", "Potions") },
      { id: "decoctions",      label: t("WITCHER.Chrome.Inventory.Cat.Decoctions", "Decoctions") },
      { id: "oils",            label: t("WITCHER.Chrome.Inventory.Cat.Oils", "Oils") },
      { id: "alchemicalItems", label: t("WITCHER.Chrome.Inventory.Cat.AlchemicalItems", "Alchemical Items") }
    ] },
  { id: "crafting", label: t("WITCHER.Chrome.Inventory.Cat.Crafting", "Crafting"), icon: "fa-hammer",
    subgrids: [
      { id: "ingredients", label: t("WITCHER.Chrome.Inventory.Cat.Ingredients", "Ingredients") },
      { id: "substances",  label: t("WITCHER.Chrome.Inventory.Cat.Substances", "Substances") }
    ] },
  { id: "misc", label: t("WITCHER.Chrome.Inventory.Cat.Misc", "Misc"), icon: "fa-bag-shopping", img: "Valuables.png",
    subgrids: [
      { id: "valuables", label: t("WITCHER.Chrome.Inventory.Dialog.Button.Valuables", "Valuables") },
      { id: "special",   label: t("WITCHER.Chrome.Inventory.Cat.Special", "Special") }
    ] },
  { id: "books", label: t("WITCHER.Chrome.Inventory.Cat.Notes", "Notes"), icon: "fa-book", img: "Notes.png",
    subgrids: [
      { id: "booksNotes", label: t("WITCHER.Chrome.Inventory.Cat.BooksAndNotes", "Books & Notes") },
      { id: "schematics", label: t("WITCHER.Chrome.Inventory.Cat.Schematics", "Schematics & Formulae") },
      { id: "maps",       label: t("WITCHER.Chrome.Inventory.Cat.Maps", "Maps") }
    ] }
  /* NB: Containers are NOT a category tab — they render in an always-open
   * dedicated grid (renderContainersGridHTML) between the item grids and the
   * equipped-container rail. categorizeItem routes them to
   * cat:"containers"/sub:"containers" for layout + bucketing. */
];

/** Fixed column count per sub-grid (drives the pre-rendered lattice width so
 *  drop targets + the empty-cell background align). Tuned to the W3 reference
 *  shots; adjust freely. */
const SUBGRID_COLS = {
  ingredients: 5, substances: 5,
  potions: 3, decoctions: 3, oils: 3, alchemicalItems: 3,
  weapons: 5, armor: 5,
  food: 4, drink: 4,
  valuables: 5, special: 5,
  booksNotes: 3, schematics: 3, maps: 3,
  containers: 2   // its own narrow column — a small count keeps the cells full-size
};

const _lc = (v) => String(v ?? "").trim().toLowerCase();

/** Is this food/food-drink item a drink (vs a meal/ingredient)? Reads the
 *  native food `kind` first, then the legacy witcher-food-and-drink category. */
function foodIsDrink(item) {
  if (item?.type === "food") return _lc(item.system?.kind) === "drink";
  return _lc(item?.flags?.["witcher-food-and-drink"]?.category) === "drink";
}

/** Route a physical inventory item to its { cat, sub } panel — the single
 *  source of truth for bucketing AND auto-placement. Returns null for
 *  character-only types (spell/hex/ritual/profession/race/homeland/perk/
 *  criticalWound/…) which never appear in the grid. */
export function categorizeItem(item) {
  if (!item) return null;
  const sys = item.system ?? {};
  switch (item.type) {
    case "component": return { cat: "crafting", sub: sys.isSubstance ? "substances" : "ingredients" };
    case "mutagen":   return { cat: "crafting", sub: "substances" };

    case "alchemical": {
      const at = _lc(sys.type);
      if (at === "bomb")      return { cat: "gear",    sub: "weapons" };      // bombs are weapons
      if (at === "potion")    return { cat: "alchemy", sub: "potions" };
      if (at === "decoction") return { cat: "alchemy", sub: "decoctions" };
      if (at === "oil")       return { cat: "alchemy", sub: "oils" };
      return { cat: "alchemy", sub: "alchemicalItems" };                     // item / other
    }

    case "weapon": return { cat: "gear", sub: "weapons" };
    case "ammo":   return { cat: "gear", sub: "weapons" };
    case "enhancement": {
      const et = _lc(sys.type);
      return { cat: "gear", sub: (et === "armor" || et === "glyph") ? "armor" : "weapons" };
    }
    case "armor":  return { cat: "gear", sub: "armor" };
    case "shield": return { cat: "gear", sub: "armor" };

    case "food": return { cat: "food", sub: foodIsDrink(item) ? "drink" : "food" };

    case "focus":
    case "remains":
    case "die":  return { cat: "misc", sub: "special" };

    case "valuable":
      if (isFoodOrDrink(item))       return { cat: "food", sub: foodIsDrink(item) ? "drink" : "food" };
      if (isParchmentLike(item))     return { cat: "books", sub: "booksNotes" };   // legacy book valuable
      if (_lc(sys.type) === "trophy") return { cat: "misc", sub: "special" };
      return { cat: "misc", sub: "valuables" };

    case "book":
    case "note":     return { cat: "books", sub: "booksNotes" };
    case "diagrams": return { cat: "books", sub: "schematics" };
    case "map":      return { cat: "books", sub: "maps" };

    case "container": return { cat: "containers", sub: "containers" };

    default: return null;   // character-only / non-inventory types
  }
}

/** True for any item that belongs in the inventory grid (i.e. routes to some
 *  category/sub-grid). Character-only types return null from categorizeItem. */
function isPhysicalItem(item) {
    return categorizeItem(item) !== null;
}

const DEFAULT_EQUIP_SLOTS = { weapons: 4, armor: 4 };

/* Per-tab sort preference, persisted on the character actor as
   flags.witcher-ttrpg-death-march.inventorySorts.{tabId} = sortKey. */
export const INV_SORTS = () => [
  { id: "name",   label: t("WITCHER.Chrome.Inventory.Dialog.Button.Name", "Name"),     icon: "fa-arrow-down-a-z" },
  { id: "type",   label: t("WITCHER.Chrome.Inventory.Dialog.Button.Type", "Type"),     icon: "fa-shapes" },
  { id: "qty",    label: t("WITCHER.Chrome.Inventory.Dialog.Button.Quantity", "Quantity"), icon: "fa-layer-group" },
  { id: "weight", label: t("WITCHER.Chrome.Inventory.Dialog.Button.Weight", "Weight"),   icon: "fa-weight-hanging" },
  { id: "value",  label: t("WITCHER.Chrome.Inventory.Dialog.Button.Value", "Value"),    icon: "fa-coins" },
  { id: "rarity", label: t("WITCHER.Chrome.Inventory.Dialog.Button.Rarity", "Rarity"),   icon: "fa-gem" }
];
const SORT_FLAG_PATH = "inventorySorts";
const DEFAULT_SORT   = "name";

/* Homebrew premium tiers > Witcher (homebrew) > Rare > Poor > Common >
   Everywhere > (unset, last). */
export const RARITY_ORDER = ["relic", "goetia", "elderfolk", "experimental", "witcher", "rare", "poor", "common", "everywhere"];
function rarityRank(item) {
  const r = String(item?.system?.availability ?? "").toLowerCase();
  const idx = RARITY_ORDER.indexOf(r);
  return idx === -1 ? RARITY_ORDER.length : idx;
}

/** Per-item flair-colour override → `{ cls, attr }` for slot renderers. A
 *  valid `#hex` on system.flairColor yields the `has-flair` opt-in class plus
 *  an inline `--wdm-rar` custom property; empty when there's no override. Shared
 *  by the grid, equip and weapon-hand slots so a custom flair colour follows an
 *  item everywhere it is shown. */
/** Whether an item renders as a tall (vertical 2:1) tile: weapons & armor &
 *  medium/heavy shields — EXCLUDING small blades, bombs, and light shields. */
export function isTallItem(item) {
  const sys = item?.system ?? {};
  // Small blades and bombs are excluded (wrong shape for a 2:1 tile). Everything
  // else — swords, spears, staves, bows, crossbows — stays tall; the tall-crop
  // measurement handles wide subjects by scaling to CONTAIN rather than cover.
  return item?.type === "armor"
    || (item?.type === "weapon" && sys.skillKey !== "smallblades" && sys.weaponType !== "bomb")
    || (item?.type === "shield" && sys.category !== "light");
}

/** A real per-item flair override → a valid 6-digit hex that isn't the
 *  "#000000" sentinel (ColorField's coerced-null default = OFF). */
function flairHex(item) {
  const s = String(item?.system?.flairColor ?? "").trim().toLowerCase();
  // "#000000" (old coerced-null) and "#b0a894" (picker off-default that older
  // builds silently persisted) both read as OFF — see hasFlair in handlebars.
  return (/^#[0-9a-f]{6}$/.test(s) && s !== "#000000" && s !== "#b0a894") ? s : "";
}

/* Lift a dragged tile onto the cursor: use the tile itself as the drag image so
 * the icon visibly follows the pointer, and dislodge the source (hide it,
 * leaving its gap) a tick later so the snapshot still captures the visible tile.
 * Call at dragstart. `slot` is the `.wou-slot` being dragged. */
function setTileDragImage(ev, slot) {
  try {
    const w = slot.offsetWidth  || 58;
    const h = slot.offsetHeight || 58;
    ev.dataTransfer.setDragImage(slot, w / 2, h / 2);
  } catch (_) { /* setDragImage unsupported — native ghost is fine */ }
  // Defer the hide so setDragImage's snapshot is taken while the tile is still
  // fully painted (hiding it in the same tick would blank the drag image).
  setTimeout(() => slot.classList.add("is-dragging"), 0);
}

/* End-of-drag un-hide. Removing `is-dragging` SYNCHRONOUSLY in dragend repainted
 * the tile at its OLD position for one frame before the post-drop render moved
 * or removed it — the drop "teleport/flicker". Deferring to the next animation
 * frame lands the un-hide in the SAME frame as the render (both run before
 * paint), so a moved item is simply gone and only a genuinely un-moved item
 * reappears — with no intermediate flash. On a detached node (the render
 * replaced it) the class removal is a harmless no-op. */
function releaseDragTile(ev) {
  const slot = ev.target?.closest?.(".wou-slot");
  if (slot) requestAnimationFrame(() => slot.classList.remove("is-dragging"));
}

function flairSlotBits(item) {
  const hex = flairHex(item);
  return hex
    ? { cls: "has-flair", attr: ` style="--wdm-rar: ${escapeAttr(hex)}"` }
    : { cls: "", attr: "" };
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

/* ---------- persisted grid layout (drag order) ---------- */

/* One actor flag holds the manual drag order per sub-grid:
 *   flags[MODULE].inventoryLayout = { [subgridId]: [itemId, …] }
 * and one flag holds the global applied sort:
 *   flags[MODULE].inventorySort = <sortKey>
 * Single read per render, single (debounced) write on drag / Sort. */
const LAYOUT_FLAG      = "inventoryLayout";
const GLOBAL_SORT_FLAG = "inventorySort";

function getLayout(actor) {
  const l = actor?.flags?.[MODULE_ID]?.[LAYOUT_FLAG];
  return (l && typeof l === "object") ? l : {};
}

function getGlobalSort(actor) {
  return actor?.flags?.[MODULE_ID]?.[GLOBAL_SORT_FLAG] || DEFAULT_SORT;
}

/** AUTO-SORT: items in a sub-grid are simply sorted by the active sort key and
 *  packed into slots 0..N-1 (no gaps, no manual placement — dragging to reorder
 *  is gone). Auto-flow (CSS) lays them out and packs the tall tiles. Returns a
 *  Map<slotIndex, item>. `layout` is ignored (kept for signature compatibility). */
function assignSlots(items, subId, layout, sortKey) {
  const bySlot = new Map();
  applySort(items, sortKey).forEach((it, i) => bySlot.set(i, it));
  return bySlot;
}

/** Build a fresh full layout (every sub-grid packed + sorted, slot 0..N-1, no
 *  gaps) — used by the Sort button to overwrite manual placements. */
function rebuildLayoutSorted(items, sortKey) {
  const bySub = {};
  for (const it of items) {
    const c = categorizeItem(it);
    if (!c) continue;
    (bySub[c.sub] ??= []).push(it);
  }
  const layout = {};
  for (const [sub, arr] of Object.entries(bySub)) {
    const cols = colsFor(sub);
    const map = {}; const used = new Set(); const covered = new Set();
    const free = (s, it) =>
      !used.has(s) && !covered.has(s) &&
      (!isTallItem(it) || (!used.has(s + cols) && !covered.has(s + cols)));
    let probe = 0;
    for (const it of applySort(arr, sortKey)) {
      while (!free(probe, it)) probe++;
      map[it.id] = probe; used.add(probe);
      if (isTallItem(it)) covered.add(probe + cols);
    }
    layout[sub] = map;
  }
  return layout;
}

/* ---------- runtime state ---------- */

let invEl = null;
let _invResizeObs = null;   // ResizeObserver that re-fills the lattice when the overlay settles
const _obsWidths = new WeakMap();   // last observed width per element (width-only guard)
let _seedObserverWidths = false;    // true right after reobserve → swallow the baseline delivery
/* Last MEASURED column count per sub-grid (auto-fill fits N small cells to the
 * width). Placement math (assignSlots/drops) must use the SAME N the display
 * uses, so padGridFillers records it here after measuring. Falls back to
 * SUBGRID_COLS until the first measured pass populates it. */
const _measuredCols = {};
const colsFor = (subId) => _measuredCols[subId] ?? subCols(subId);

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
let activeCategory      = "gear";
let pendingSort         = null;    // sort mode chosen in the dropdown, applied by the Sort button
let openContainerPopupId = null;   // null = no popup | container itemId = popup open
let openContainerActorId = null;   // null = character | else mount/linked actor id (for the open popup)
let popupAnchorId       = null;    // remember which rail slot to anchor the popup against
let mountPopupOpen      = false;   // true = the linked mount's inventory popup is open
let hooksWired          = false;
let currentDragSource   = null;    // "grid" | "container:<id>" | "equip:<kind>" during a drag
let currentDragActorId  = null;    // id of the actor that *owned* the currently dragged item
let currentDragItemId   = null;    // id of the item currently being dragged (for drop pre-validation)
let _lastDropCell       = null;    // last cell the drop-placement preview highlighted (throttle guard)

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
  el.setAttribute("aria-label", t("WITCHER.Chrome.Inventory.Text.Inventory", "Inventory"));
  document.body.appendChild(el);
  invEl = el;

  // Initial structure (re-rendered on every open + on data changes).
  render();

  // Wire the Witcher item context menu once.  ContextMenu uses event
  // delegation on invEl, so it survives innerHTML rebuilds inside.
  wireWitcherContextMenu();

  // Wire the 1.5s-hover item card once (document-delegated so it also covers
  // the body-appended container/mount popups).
  wireHoverCard();

  // Click the window background → clear the tile selection. Delegated on invEl
  // (persists across innerHTML rebuilds). Only fires when the click lands
  // DIRECTLY on a background surface, so clicking items/controls never clears.
  invEl.addEventListener("click", (ev) => {
    const t = ev.target;
    const isBackground = t === invEl || (typeof t.matches === "function" && t.matches(
      ".wou-inv-left, .wou-inv-right, .wou-inv-containers, .wou-inv-grid-wrap, .wou-inv-categories, .wou-inv-subgrid, .wou-inv-subgrid-body, .wou-inv-subgrid-grid, .wou-inv-header"
    ));
    if (!isBackground) return;
    invEl.querySelectorAll(".wou-slot.is-selected").forEach(s => s.classList.remove("is-selected"));
  });

  /* Variable-portrait corner button on the inventory portrait. Delegated (the
   * panel re-renders via innerHTML, so a directly-bound listener wouldn't
   * survive) and wired once here. Acts on the currently-viewed actor. */
  invEl.addEventListener("click", async (ev) => {
    const btn = ev.target?.closest?.('[data-action="variable-portrait"]');
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    const actor = getPanelActor("inventory");
    if (!actor) return;
    try { await openVariablePortraitConfig(actor); }
    catch (err) { console.error(`${MODULE_ID} | open variable portrait config failed`, err); }
  });

  // While an internal drag is in flight, treat the WHOLE page as a valid drop
  // surface so the cursor never flips to the red "forbidden" (no-drop) badge —
  // over inventory gaps, labels, padding, OR the body-appended container/mount
  // popups (which live outside invEl). Real drop zones still handle the actual
  // drop; this only keeps the cursor a "move". Document-level + capture so it
  // wins before anything downstream can reset the effect to none.
  document.addEventListener("dragover", (ev) => {
    if (!currentDragSource) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
  }, true);

  // Re-fill the lattice + re-measure the brackets whenever ANYTHING that affects
  // grid size changes: the open transition, a Foundry window resize, a late font
  // load, or the left/right chrome bars expanding (which reflow the columns
  // WITHOUT resizing invEl). We observe the overlay AND every grid-wrap directly
  // (re-observed each render via reobserveInventoryLayout), plus window resize,
  // so cols/rows/brackets always adjust. Adding fillers doesn't change any
  // observed element's flex-fixed box, so this can't feed back into a loop.
  if (window.ResizeObserver && !_invResizeObs) {
    // Re-fill on any WIDTH change of the overlay or a grid (a wider/narrower grid
    // means a different column count → cells must be re-positioned). We ignore
    // pure HEIGHT changes so alignContainersColumn (which sets a grid's height)
    // can't feed back into an infinite loop.
    _invResizeObs = new ResizeObserver((entries) => {
      let widthChanged = false;
      for (const e of entries) {
        const w = e.contentRect.width;
        const prev = _obsWidths.get(e.target);
        if (prev === undefined || Math.abs(prev - w) > 0.5) { _obsWidths.set(e.target, w); widthChanged = true; }
        /* IMMEDIATELY re-sync this sub-section's frame bracket to the grid's
         * ACTUAL rendered column count. The frame width is `--wou-cols × cell`;
         * the grid auto-fills its own count off the live width. When a bar
         * expands and the panel shrinks, the grid re-flows to fewer columns
         * right away, but --wou-cols was only updated by the deferred 90ms
         * padGridFillers — so the frame and the icons drift apart and the icons
         * spill past the border. Reading the grid's computed column count here
         * (a pure READ — no write to the grid, so no scrollbar/filler feedback)
         * keeps the frame glued to the columns on the very same frame. */
        const gridEl = e.target.querySelector?.(".wou-inv-subgrid-grid");
        if (gridEl) {
          const n = getComputedStyle(gridEl).gridTemplateColumns.split(" ").filter(Boolean).length;
          if (n) e.target.style.setProperty("--wou-cols", String(n));
        }
      }
      /* reobserveInventoryLayout runs every render on freshly-built DOM, and
       * ResizeObserver always delivers a baseline callback for newly-observed
       * elements. That first delivery isn't a real resize — the render already
       * scheduled its own layout pass — so record the widths but DON'T schedule
       * another (redundant) reflow-heavy pass. Real later resizes still fire. */
      if (_seedObserverWidths) { _seedObserverWidths = false; return; }
      // Settle-debounced: a chrome panel expand resizes the overlay every frame,
      // and re-flowing the grid per frame is the FPS killer. Coalesce to ONE
      // re-flow after the resize stops. (positionBounds already routes through
      // the same debounce — this closes the direct-observer bypass path.)
      if (widthChanged) scheduleGridReflowSettled();
    });
    reobserveInventoryLayout();
    window.addEventListener("resize", scheduleGridReflowSettled);
  }

  // GM view pickers — re-render on selection change, and on any viewer-override
  // change fired by another tab (global "Lock as") or this panel ("View as").
  wireViewAsPicker(invEl, render);
  wireViewPanelAsPicker(invEl, "inventory", render);

  // Re-render on actor / item changes — listens for the player's character
  // AND for any linked mount actor (items moved on the mount affect our rail).
  if (!hooksWired) {
    const isRelevantActor = (a) => {
      const c = getPanelActor("inventory");
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
    Hooks.on("createItem",  (i) => { if (ownsItem(i)) { _unseenIds.add(i.id); scheduleRender(); } });
    Hooks.on("updateItem",  (i) => { if (ownsItem(i)) scheduleRender(); });
    Hooks.on("deleteItem",  (i) => { if (ownsItem(i)) scheduleRender(); });
    Hooks.on("createActiveEffect", (ae) => { if (ownsEffect(ae)) { invalidateRenderSig(); scheduleRender(); } });
    Hooks.on("updateActiveEffect", (ae) => { if (ownsEffect(ae)) { invalidateRenderSig(); scheduleRender(); } });
    Hooks.on("deleteActiveEffect", (ae) => { if (ownsEffect(ae)) { invalidateRenderSig(); scheduleRender(); } });
    Hooks.on(VIEWER_OVERRIDE_HOOK, scheduleRender);
    Hooks.on(PANEL_OVERRIDE_HOOK, (key) => { if (key === "inventory") scheduleRender(); });
    /* Oil timers read wall-clock out of combat and rounds in combat, and tick
     * down as time passes.  The real-time clock fires updateWorldTime ~once a
     * second; full-rebuilding then flickered the grid + inspect frame, so the
     * per-second countdown is patched in place (tickOilLabels) instead.  Combat
     * transitions flip the label wall-clock⇄rounds and are rare, so those still
     * do a real rebuild to re-derive every tile. */
    Hooks.on("updateWorldTime", tickOilLabels);
    // Freshness is derived from worldTime, so a time advance can change the
    // displayed state without any document update. Only re-render when a
    // transition actually fires (state crossing OR the integer "days left"
    // count drops) — not on every clock tick.
    Hooks.on("updateWorldTime", (worldTime, delta) => {
      if (!isHomebrewEnabled("foodAndDrink")) return;
      if (!(Number(delta) > 0)) return;
      const actor = getPanelActor("inventory");
      if (!actor) return;
      const SPD = Number(CONFIG.time?.calendar?.secondsPerDay) || 86400;
      const before = Number(worldTime) - Number(delta);
      let transition = false;
      for (const item of actor.items) {
        if (item.type !== "food") continue;
        const days = Number(item.system?.freshness?.shelfLifeDays) || 0;
        if (days <= 0) continue;
        const anchorRaw = item.system?.freshness?.anchorTime;
        if (anchorRaw == null) continue;
        const anchor = Number(anchorRaw);
        if (!Number.isFinite(anchor)) continue;
        const wasRatio = (before - anchor) / SPD / days;
        const nowRatio = (Number(worldTime) - anchor) / SPD / days;
        const wasState = ratioToState(wasRatio);
        const nowState = ratioToState(nowRatio);
        if (wasState !== nowState) { transition = true; break; }
        // Integer-day drop on the displayed countdown.
        const wasLeft = Math.max(0, Math.ceil(days - Math.max(0, before        - anchor) / SPD));
        const nowLeft = Math.max(0, Math.ceil(days - Math.max(0, Number(worldTime) - anchor) / SPD));
        if (wasLeft !== nowLeft) { transition = true; break; }
      }
      if (!transition) return;
      invalidateRenderSig();
      scheduleRender();
    });
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
    render();   // fresh data each open — built while hidden
    document.body.classList.add("wou-inventory-open");
    syncTopbarTab(true);
    // MEASURE-THEN-REVEAL: the labels use the fallback font (and the layout is
    // font-dependent) until the display font loads, so we finalise the layout
    // FIRST and only then fade in — the panel appears already-correct, with no
    // visible reorganising. The wait is capped so a slow/never-loading font can't
    // block the open.
    let revealed = false;
    const reveal = () => {
      if (revealed || !invEl) return;
      revealed = true;
      alignContainersColumn();
      padGridFillers();
      requestAnimationFrame(() => {
        beginOverlayTransition();
        invEl.classList.add("is-open");
      });
    };
    if (document.fonts?.load) {
      // Resolves ~immediately if the font is already cached (the common case →
      // effectively instant), or when it finishes loading otherwise.
      Promise.all([
        document.fonts.load('600 1rem "PF DIN Text Cond Pro"').catch(() => {}),
        document.fonts.load('600 1rem "Barlow Condensed"').catch(() => {})
      ]).then(reveal).catch(reveal);
      setTimeout(reveal, 150);       // hard cap so a slow font never blocks the open
    } else {
      requestAnimationFrame(reveal);
    }
  } else {
    // Tear down any open container popup FIRST — the body-level floating popup
    // lives outside invEl and keeps live update/create/delete Item hooks, so a
    // quick "drop into a bag then close" would otherwise let that hook re-show
    // the popup after the inventory is gone (and it wouldn't dismiss). Clearing
    // it + its hooks here makes the popup always close with the inventory.
    closeFloatingContainer();
    cancelHoverCard();   // kill any pending/shown 1.5s hover card so it can't linger
    openContainerPopupId = null;
    openContainerActorId = null;
    popupAnchorId = null;
    beginOverlayTransition();
    invEl.classList.remove("is-open");
    document.body.classList.remove("wou-inventory-open");
    syncTopbarTab(false);
    // "View as" is a transient per-panel lens — drop it on close so the panel
    // reopens as the default character. (The global "Lock as" persists.)
    setPanelOverride("inventory", null);
  }
}

/** Wrap an open/close fade: promote to a compositor layer (will-change) and add
 *  `wou-inv-animating` (which freezes inner animations) for the duration, then
 *  clean both up on transitionend — so the fade is a cheap, stable layer blend
 *  instead of re-rasterizing a live subtree every frame. */
function beginOverlayTransition() {
  if (!invEl) return;
  invEl.style.willChange = "transform, opacity";
  invEl.classList.add("wou-inv-animating");
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    invEl.style.willChange = "";
    invEl.classList.remove("wou-inv-animating");
    invEl.removeEventListener("transitionend", onEnd);
  };
  // transform is the longest (.22s) — finish when IT ends so the layer isn't torn
  // down while it's still moving.
  const onEnd = (ev) => { if (ev.target === invEl && ev.propertyName === "transform") finish(); };
  invEl.addEventListener("transitionend", onEnd);
  setTimeout(finish, 400);   // fallback if transitionend doesn't fire
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
  const character = getPanelActor("inventory");
  const mount     = getMountActor(character);
  let ownerId = null;
  if (character?.items?.get(containerId))   ownerId = null;            /* character */
  else if (mount?.items?.get(containerId))  ownerId = mount.id;        /* mount */
  openContainerPopupId = containerId;
  openContainerActorId = ownerId;
  popupAnchorId        = containerId;
  hideHoverCard();
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
let _floatHookIds = null;    // Foundry hook ids for update/create/delete Item

/* Rebuild JUST the .wou-popup-body of the currently-open floating popup
 * from the container's live contents. Called from update/create/delete
 * Item hooks so dragging an item out of an inventory-side container
 * refreshes the popup without needing to close/reopen it. */
let _floatRefreshRAF = 0;
/** Coalesce popup-body refreshes to once per frame — a batched write fires the
 *  update hook once per changed document, but the popup only needs one rebuild. */
function scheduleFloatingRefresh() {
    if (_floatRefreshRAF) return;
    _floatRefreshRAF = requestAnimationFrame(() => { _floatRefreshRAF = 0; refreshFloatingContainerBody(); });
}
function refreshFloatingContainerBody() {
    if (!_floatPopupEl || !_floatContainerId) return;
    const character = getPanelActor("inventory");
    const mount     = getMountActor(character);
    let owner = null;
    if (character?.items?.get(_floatContainerId))   owner = character;
    else if (mount?.items?.get(_floatContainerId))  owner = mount;
    if (!owner) { closeFloatingContainer(); return; }
    const container = owner.items.get(_floatContainerId);
    if (!container) { closeFloatingContainer(); return; }
    const items   = resolveContainerContents(owner, container);
    const isMount = owner.id !== character?.id;
    const slotRenderer = isMount ? mountItemSlotHTML : itemSlotHTML;
    const bodyHost = _floatPopupEl.querySelector(".wou-popup-body");
    if (!bodyHost) return;
    let bodyHtml;
    if (hasSlotRows(container)) {
        const tiles = buildSlotLayout(container);
        // Hybrid containers take the full 5-column width so the loose-space grid
    // below wraps normally (like a loose-only container) instead of being
    // squeezed to the compartment count. Slots-only containers stay compact.
    const cols  = (getContainerCfg(container).capacityMode === "hybrid")
      ? 5
      : Math.min(5, Math.max(1, Math.ceil(Math.sqrt(totalSlots(container)))));
        bodyHtml = `<div class="wou-popup-grid is-slots" style="grid-template-columns: repeat(${cols}, 50px)">${tiles.map(slotTileHTML).join("")}</div>`;
    } else {
        bodyHtml = items.length === 0
            ? `<div class="wou-empty-state">${t("WITCHER.Chrome.Inventory.Text.EmptySlot", "— Empty —")}</div>`
            : `<div class="wou-popup-grid">${items.map(slotRenderer).join("")}</div>`;
    }
    bodyHost.innerHTML = bodyHtml;
    /* Also refresh the header capacity chips — takes stored weight aggregation
     * into account so a take-out visibly shrinks the load. Replace the WHOLE
     * `.wou-popup-caps` wrapper (not a single chip inside it) — the old code
     * swapped one `.wou-popup-weight` chip for the entire wrapper, nesting a
     * fresh copy on every refresh (chips duplicated by item count). */
    try {
        const cap = getCapacityDisplay(container);
        const headerHost = _floatPopupEl.querySelector(".wou-popup-header");
        if (headerHost) {
            const newCaps = buildCapacityChipsHTML(cap);
            const oldCaps = headerHost.querySelector(".wou-popup-caps");
            if (oldCaps) {
                if (newCaps) oldCaps.outerHTML = newCaps;
                else oldCaps.remove();
            } else if (newCaps) {
                const closeBtn = headerHost.querySelector(".wou-popup-close");
                if (closeBtn) closeBtn.insertAdjacentHTML("beforebegin", newCaps);
                else headerHost.insertAdjacentHTML("beforeend", newCaps);
            }
        }
    } catch (_) { /* non-fatal — layout only */ }
}

export function openContainerFloating(containerId, anchorEl) {
  hideHoverCard();   // opening a container closes any hover display card
  /* Toggle: clicking the same hotbar slot while its popup is already
   * showing closes the popup instead of re-opening fresh.  Compare BEFORE
   * tearing down so the id is still set. */
  if (_floatPopupEl && _floatContainerId === containerId) {
    closeFloatingContainer();
    return;
  }
  closeFloatingContainer();
  _floatContainerId = containerId;
  const character = getPanelActor("inventory");
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
    // Hybrid containers take the full 5-column width so the loose-space grid
    // below wraps normally (like a loose-only container) instead of being
    // squeezed to the compartment count. Slots-only containers stay compact.
    const cols  = (getContainerCfg(container).capacityMode === "hybrid")
      ? 5
      : Math.min(5, Math.max(1, Math.ceil(Math.sqrt(totalSlots(container)))));
    body = `<div class="wou-popup-grid is-slots" style="grid-template-columns: repeat(${cols}, 50px)">${tiles.map(slotTileHTML).join("")}</div>`;
  } else {
    body = items.length === 0
      ? `<div class="wou-empty-state">${t("WITCHER.Chrome.Inventory.Text.EmptySlot", "— Empty —")}</div>`
      : `<div class="wou-popup-grid">${items.map(slotRenderer).join("")}</div>`;
  }

  const wrap = document.createElement("div");
  wrap.id = "wou-floating-container";
  wrap.className = "wou-container-popup" + (isMount ? " is-mount" : "");
  wrap.innerHTML = `
    <div class="wou-popup-header">
      <span class="wou-popup-title">${escapeText(container.name)}</span>
      ${weightHTML}
      <button type="button" class="wou-popup-close" aria-label="${t("WITCHER.Chrome.Inventory.Text.CloseContainer", "Close container")}">
        <i class="fa-solid fa-xmark"></i>
      </button>
    </div>
    ${containerCapacityBarHTML(cap)}
    <div class="wou-popup-body">${body}</div>
    ${slotBehaviorLegendHTML(container)}
  `;
  document.body.appendChild(wrap);
  _floatPopupEl = wrap;
  /* Stamp the popup-scale attribute BEFORE positioning so the CSS
   * `transform: scale()` is already applied when getBoundingClientRect
   * runs — dimensions come back scaled, and the clamp math uses the
   * real visual footprint. Without this the position code sees the
   * intrinsic (280×320) size and lets the popup drift off-screen at
   * higher UI scales. The popup-scale hook's MutationObserver would
   * also stamp it, but on a later microtask — too late for the sync
   * measurement here. */
  wrap.setAttribute("data-wdm-scaled", "1");
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
    setTileDragImage(ev, slot);
  });
  wrap.addEventListener("dragend", (ev) => {
    releaseDragTile(ev);
    _lastDropCell = null;
    currentDragSource = null;
    currentDragActorId = null;
    currentDragItemId = null;
  });

  /* Drop items INTO this floating container. Reads the compartment tile under
   * the cursor (data-slot-key) so a drop lands in the SPECIFIC slot the user
   * aimed at, filling it to its per-slot max. Skip when the drag started in
   * THIS popup so an out-going drag (back to the inventory) isn't eaten. */
  wrap.addEventListener("dragover", (ev) => {
    const overSlot  = !!ev.target?.closest?.("[data-slot-key]");
    const overLoose = !!ev.target?.closest?.(".wou-loose-zone");
    // Same-container drag: capture while hovering a compartment tile (RE-SLOT)
    // or the loose zone (move to loose). Elsewhere, let it pass so the item can
    // be dragged out to the inventory.
    if (currentDragSource === `container:${containerId}` && !overSlot && !overLoose) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    wrap.classList.add("is-drop-target");
    const zone = overSlot ? null : ev.target?.closest?.(".wou-loose-zone");
    wrap.querySelectorAll?.(".wou-loose-zone").forEach?.(z => z.classList.toggle("is-drop-target", z === zone));
    // Highlight the exact compartment tile under the cursor (like the loose zone).
    const slotEl = overSlot ? ev.target.closest("[data-slot-key]") : null;
    wrap.querySelectorAll?.(".wou-slot-drop-hot").forEach?.(s => { if (s !== slotEl) s.classList.remove("wou-slot-drop-hot"); });
    if (slotEl) slotEl.classList.add("wou-slot-drop-hot");
  });
  wrap.addEventListener("dragleave", (ev) => {
    if (ev.target === wrap) {
      wrap.classList.remove("is-drop-target");
      wrap.querySelectorAll?.(".wou-loose-zone.is-drop-target").forEach?.(z => z.classList.remove("is-drop-target"));
      wrap.querySelectorAll?.(".wou-slot-drop-hot").forEach?.(s => s.classList.remove("wou-slot-drop-hot"));
    }
  });
  wrap.addEventListener("drop", async (ev) => {
    const dropSlotKey = ev.target?.closest?.("[data-slot-key]")?.dataset?.slotKey || null;
    const clearZones = () => { wrap.classList.remove("is-drop-target"); wrap.querySelectorAll?.(".wou-loose-zone.is-drop-target").forEach?.(z => z.classList.remove("is-drop-target")); wrap.querySelectorAll?.(".wou-slot-drop-hot").forEach?.(s => s.classList.remove("wou-slot-drop-hot")); };
    // Same-container drag: RE-SLOT onto a compartment tile, or move to LOOSE
    // when dropped on the loose zone. Ignore drops elsewhere so drag-out works.
    if (currentDragSource === `container:${containerId}`) {
      const rid = ev.dataTransfer.getData("application/x-wou-item");
      const overLoose = !!ev.target?.closest?.(".wou-loose-zone");
      if (!dropSlotKey && !overLoose) return;
      ev.preventDefault();
      clearZones();
      if (rid) await moveItemToContainer(owner, rid, containerId, currentDragSource, dropSlotKey ? { slotKey: dropSlotKey } : { loose: true });
      // A slot↔loose move changes only the item's containerSlot flag, not the
      // container's content array — the updateItem refresh hook can miss that,
      // leaving the popup showing the item in its old spot. Force the repaint.
      scheduleFloatingRefresh();
      return;
    }
    ev.preventDefault();
    clearZones();

    // Foreign drag (compendium / sidebar) — create on the owner, then place.
    if (!ev.dataTransfer.getData("application/x-wou-source")) {
      const created = await tryForeignItemDrop(ev, owner);
      if (!created) return;
      const cont = owner.items.get(containerId);
      if (!cont) return;
      if (!fitsInContainer(cont, created)) { ui?.notifications?.warn?.(overflowWarning(cont, created)); return; }
      await moveItemToContainer(owner, created.id, containerId, "grid", { slotKey: dropSlotKey, loose: !dropSlotKey });
      return;
    }

    const source     = ev.dataTransfer.getData("application/x-wou-source");
    const srcActorId = ev.dataTransfer.getData("application/x-wou-source-actor") || owner.id;
    const id = await maybeSplitForDrop(ev);
    if (!id) return;

    /* Cross-actor drops fall back to the generic transfer (no slot targeting
     * across actors — the item is recreated on the owner, then auto-placed). */
    if (srcActorId !== owner.id) {
      const srcActor = game.actors?.get?.(srcActorId);
      const srcItem  = srcActor?.items?.get(id);
      if (!srcActor || !srcItem) return;
      if (srcItem.type === "container") await transferContainerAcrossActors(srcActor, srcItem, owner);
      else await transferAcrossActors(srcActor, srcItem, source, owner, containerId);
      return;
    }

    if (source === `container:${containerId}`) return;   // already here
    await moveItemToContainer(owner, id, containerId, source, { spendAction: true, slotKey: dropSlotKey, loose: !dropSlotKey });
  });

  /* Close on outside click (next tick so the click that opened us doesn't
   * immediately close it). */
  _floatOutsideHandler = (ev) => {
    if (!_floatPopupEl) return;
    if (_floatPopupEl.contains(ev.target)) return;
    if (anchorEl?.contains?.(ev.target)) return;
    /* Clicks anywhere in the inventory overlay (grabbing an item to drag into
     * the bag, switching tabs, using the rail) must NOT close the popup — you
     * work between the two. Only a click truly outside both closes it. */
    if (invEl?.contains?.(ev.target)) return;
    /* The item right-click ContextMenu is built with `fixed: true`, so Foundry
     * appends it to the BODY — outside our popup. A mousedown on one of its
     * entries would otherwise read as an outside-click and close the container
     * before the entry fires. Treat the context menu as "inside". */
    if (ev.target?.closest?.("#context-menu, .context-menu, menu.context-menu")) return;
    closeFloatingContainer();
  };
  setTimeout(() => document.addEventListener("mousedown", _floatOutsideHandler), 0);

  /* Live-refresh: when items on the same owner as this popup are
   * created / updated / deleted, re-render the popup body. Covers the
   * take-out-of-container flow (item.system.isStored flips + container
   * content array shrinks → both events fire), the drop-in flow (new
   * item lands in the container), and quantity edits (badge refresh).
   * Hooks are torn down in closeFloatingContainer so they don't fire
   * against a stale _floatContainerId after the popup is gone. */
  if (!_floatHookIds) {
    const owner = (() => {
      const c = getPanelActor("inventory");
      const m = getMountActor(c);
      if (c?.items?.get(containerId))  return c;
      if (m?.items?.get(containerId))  return m;
      return null;
    })();
    const relevant = (it) => it?.parent?.id === owner?.id;
    _floatHookIds = [
      { name: "updateItem", id: Hooks.on("updateItem", (it) => { if (relevant(it)) scheduleFloatingRefresh(); }) },
      { name: "createItem", id: Hooks.on("createItem", (it) => { if (relevant(it)) scheduleFloatingRefresh(); }) },
      { name: "deleteItem", id: Hooks.on("deleteItem", (it) => { if (relevant(it)) scheduleFloatingRefresh(); }) }
    ];
  }
}

function closeFloatingContainer() {
  if (_floatOutsideHandler) {
    document.removeEventListener("mousedown", _floatOutsideHandler);
    _floatOutsideHandler = null;
  }
  if (_floatHookIds) {
    for (const h of _floatHookIds) Hooks.off(h.name, h.id);
    _floatHookIds = null;
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
  /* getBoundingClientRect on a `transform: scale(N)` element returns the
   * SCALED footprint, so once `data-wdm-scaled="1"` is stamped this
   * gives us the true visual size the popup will occupy on-screen.
   * That's what the viewport clamp math needs — the intrinsic 280×320
   * would let a 1.5× scaled popup overflow the right / top edge. */
  const rect = _floatPopupEl.getBoundingClientRect();
  const popupW = rect.width  || 280;
  const popupH = rect.height || 320;

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
  /* The popup carries `data-wdm-scaled="1"` (stamped at line 602). The
   * shared CSS rule (`styles/tokens.css`) turns that into
   *   zoom: var(--wdm-popup-scale, var(--wdm-chrome-bars-scale, 1));
   * CSS `zoom` scales BOTH layout AND positioning:
   *   visual_left = css_left × zoom
   * The viewport-pixel math above (from getBoundingClientRect +
   * window.inner*) is in VISUAL pixels — divide by the popup's own zoom
   * to convert to CSS pixels for style.left / style.top. Uses the same
   * variable fallback chain as the CSS rule and readPopupZoom in
   * chrome/setup/popup-scale.js. NOT `--wdm-scale` — that drives rem
   * font-sizing and can diverge in Detailed mode. */
  _floatPopupEl.style.position = "fixed";
  _floatPopupEl.style.zIndex   = "9070";   /* above dock (9050) */
  _floatPopupEl.style.left = `calc(${left}px / var(--wdm-popup-scale, var(--wdm-chrome-bars-scale, 1)))`;
  _floatPopupEl.style.top  = `calc(${top}px / var(--wdm-popup-scale, var(--wdm-chrome-bars-scale, 1)))`;
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
/* The grid column re-flow (measure + filler DOM) is EXPENSIVE. During a panel
 * expand/collapse the overlay resizes every animation frame, so re-flowing the
 * grid on every positionBounds was the FPS killer (50–117 ms forced reflows per
 * frame). Debounce it so a burst of resize frames triggers ONE re-flow after the
 * animation settles instead of one per frame. */
let _gridReflowSettleTimer = null;
/* Last horizontal insets we applied. The grid only needs to RE-COLUMN when the
 * overlay's WIDTH changes (left/right insets); a top-bar expand (top/bottom) or
 * a redundant reposition must NOT pay the ~70 ms grid re-flow. */
let _lastInsetL = null, _lastInsetR = null;
function scheduleGridReflowSettled() {
  if (_gridReflowSettleTimer) clearTimeout(_gridReflowSettleTimer);
  _gridReflowSettleTimer = setTimeout(() => {
    _gridReflowSettleTimer = null;
    if (isInventoryOpen()) schedulePadFillers();
  }, 90);
}

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
  const tab     = document.querySelector('#wou-top-bar [data-tab="inventory"]');

  /* READ PHASE — batch EVERY layout read (including the topbar tab, which used
   * to be read AFTER the style writes and forced a second reflow) before any
   * write, so the write phase costs at most one reflow instead of two. */
  const top    = (topbarOpen && topbar) ? Math.max(0, topbar.getBoundingClientRect().bottom) : 0;
  const bottom =  dock                  ? Math.max(0, H - dock.getBoundingClientRect().top)  : 0;
  const left   = (leftOpen   && leftbar)? Math.max(0, leftbar.getBoundingClientRect().right) : 0;
  const right  = (rightOpen  && sidebar)? Math.max(0, W - sidebar.getBoundingClientRect().left) : 0;
  let tabCenterX = null;
  if (tab) { const r = tab.getBoundingClientRect(); tabCenterX = r.left + r.width / 2; }

  /* A collapsed bar gives an offset of 0, which pins the overlay flush to the
   * screen edge — the last column of items then sits right on the edge and is a
   * pixel-hunt to click. Keep a minimum inset on each side so the panel is
   * fully usable with a bar collapsed. When a bar is OPEN its real (larger)
   * offset is used unchanged, so this only affects the collapsed case. */
  const MIN_EDGE = 16;
  /* LEFT goes flush to the screen edge (or the open left bar) — the panel's own
   * 1.375rem internal padding already keeps items off the edge, so no panel-
   * level inset is needed and a MIN_EDGE here just leaves an uncovered sliver.
   * RIGHT keeps the MIN_EDGE (the collapsed-sidebar pixel-hunt fix). */
  const leftPx  = left;
  const rightPx = right || MIN_EDGE;

  /* WRITE PHASE. */
  invEl.style.top = `calc(${top}px / var(--wdm-size-inventory, var(--wdm-chrome-bars-scale, 1)))`;
  invEl.style.bottom = `calc(${bottom}px / var(--wdm-size-inventory, var(--wdm-chrome-bars-scale, 1)))`;
  invEl.style.left = `calc(${leftPx}px / var(--wdm-size-inventory, var(--wdm-chrome-bars-scale, 1)))`;
  invEl.style.right = `calc(${rightPx}px / var(--wdm-size-inventory, var(--wdm-chrome-bars-scale, 1)))`;
  // Pin the close-arrow X to the center of the topbar Inventory tab, relative
  // to the overlay's own (left-offset) origin.
  if (tabCenterX != null) {
    invEl.style.setProperty("--inv-close-x", `calc(${tabCenterX - leftPx}px / var(--wdm-size-inventory, var(--wdm-chrome-bars-scale, 1)))`);
  }

  // Re-column the grid ONLY when the overlay's WIDTH actually changed (a
  // left/right bar slide). Top-bar (vertical) changes and redundant repositions
  // must not pay the grid re-flow — that redundancy was firing the ~70 ms reflow
  // multiple times per gesture. Deferred (settle-debounced) on top of that so a
  // burst still collapses to one.
  const widthChanged = left !== _lastInsetL || right !== _lastInsetR;
  _lastInsetL = left; _lastInsetR = right;
  if (isInventoryOpen() && widthChanged) {
    scheduleGridReflowSettled();
    /* A left/right bar slide changes the panel width, which would strand an
     * open container / mount popup away from its in-panel anchor. Rather than
     * chase the moving anchor, just close the popup. Guard on one being open so
     * a width change with nothing open costs no render. _lastInset was already
     * updated above, so the render() this triggers re-enters positionBounds with
     * widthChanged=false and cannot recurse. */
    if (openContainerPopupId || mountPopupOpen) {
      openContainerPopupId = null;
      openContainerActorId = null;
      popupAnchorId        = null;
      mountPopupOpen       = false;
      render();
    }
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
    `cat:${activeCategory}:${getGlobalSort(actor)}`,
    `lay:${JSON.stringify(getLayout(actor))}`,
    `pop:${openContainerPopupId ?? ""}:${openContainerActorId ?? ""}`,
    `mpop:${mountPopupOpen ? 1 : 0}`,
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
      `:${s.hands ?? ""}:${s.slot ?? ""}:${s.quick ? 1 : 0}:${s.availability ?? ""}:${s.flairColor ?? ""}` +
      // Chambered-round count + loaded bolt name/oil — so the "loaded" corner
      // pill and the loaded-bolt oil badge appear/update the moment a crossbow
      // is reloaded, fired, or unloaded.
      `:${s.loaded?.count ?? ""}:${s.loaded?.name ?? ""}:${s.loaded?.appliedOil?.name ?? ""}` +
      `:${s.substanceType ?? ""}` +
      // Food-kind + portion counters — without these the tile's charge
      // badge goes stale after a consume tick (it's read straight off
      // system.charges in renderItemSlot, but the surrounding rebuild is
      // gated by this sig).
      `:${s.kind ?? ""}:${s.charges?.current ?? ""}/${s.charges?.max ?? ""}` +
      // Food tier + bland flag — surfaced on the inspect card (Poor/Bland
      // meal subtitle + bland-diet chip). Without these in the sig, flipping
      // blandFood or the tier on the sheet leaves the inspect panel stale.
      `:${s.tier ?? ""}:${s.blandFood === false ? 0 : 1}` +
      // Applied-oil PRESENCE only (empty vs non-empty name). Flips on
      // apply / cleanse / expiry-clear — which is exactly when the tile's
      // droplet badge needs to appear or disappear. The duration countdown
      // is DELIBERATELY NOT folded in here; that ticks every second and
      // would force a full grid rebuild per tick. Countdown text is
      // patched in place by tickOilLabels on updateWorldTime.
      `:${s.appliedOil?.name ? 1 : 0}` +
      // Container content-array length. Without this, a container that
      // gains or loses a stored item (unloading a coated bolt back into
      // a quiver, dropping something INTO a pack) doesn't move the sig
      // and the grid keeps showing stale contents until the overlay is
      // reopened. Only meaningful for type=container; every other item
      // reports 0 and contributes nothing to sig thrash.
      `:${(it.type === "container" ? (s.content?.length ?? 0) : 0)}` +
      `:${(it.effects?.size ?? it.effects?.length ?? 0)}`
    );
    /* Armor per-location SP (current + max) — drives the layering readout and
     * combined-SP recompute under the armor slots. Both matter: current SP
     * feeds the combined value, max SP feeds layer membership / count / EV
     * surcharge. Without these in the sig, editing an armor's stopping values
     * wouldn't move the sig, so the panel stayed stale until a re-equip. */
    if (it.type === "armor") {
      const sp = ["head", "torso", "leftArm", "rightArm", "leftLeg", "rightLeg"]
        .map(l => `${s[`${l}Stopping`] ?? ""}/${s[`${l}MaxStopping`] ?? ""}`).join(",");
      parts.push(`asp:${it.id}:${sp}`);
      // Visor state drives the corner pip + (when worn) mechanics — re-render on toggle.
      parts.push(`vis:${it.id}:${s.visorRaised ? 1 : 0}`);
    }
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
  const actor = getPanelActor("inventory");

  const sig = computeRenderSig(actor);
  if (sig === _lastRenderSig) return;
  _lastRenderSig = sig;

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
  reobserveInventoryLayout();   // grid-wraps were just rebuilt — watch the fresh ones
  fitTallIcons();               // zoom each 2:1 icon to its subject (cache hit → no reflow)
  /* Popup anchoring stays SYNCHRONOUS (before paint) — the popup DOM was just
   * rebuilt by the innerHTML swap and, unpositioned, sits at the overlay's
   * top-left; deferring this to the rAF painted one frame there first (the
   * "flicker to the far left"). The rail geometry it measures doesn't depend on
   * alignContainersColumn (which only pads the containers COLUMN, not the rail),
   * so positioning here is already correct. */
  if (openContainerPopupId) positionContainerPopup();
  if (mountPopupOpen) positionMountPopup();
  /* Run the containers-column align + filler padding SYNCHRONOUSLY (before paint)
   * so the very FIRST frame is already at the correct height. Deferring it to a
   * rAF painted one unpadded/uncapped frame first — and a drop that triggers two
   * renders (item update + combat-action charge) then oscillated
   * capped→unpadded→capped: the "container subcategory spasming up and back
   * down". `contain: layout` on the overlay scopes this reflow to the panel, so
   * it's cheap. schedulePadFillers still covers later width/resize/font triggers
   * (idempotent — same result, no extra jump). */
  alignContainersColumn();
  padGridFillers();
  document.fonts?.ready?.then?.(schedulePadFillers);
}

/** Push the always-open Containers column down so its grid lines up with the
 *  category grids (which sit below the tab bar). Measured, since the tab row's
 *  height isn't fixed. */
function alignContainersColumn() {
  if (!invEl) return;
  const col     = invEl.querySelector(".wou-inv-containers-col");
  const leftLbl = invEl.querySelector(".wou-inv-left .wou-inv-subgrid-label");
  const colLbl  = col?.querySelector(".wou-inv-subgrid-label");
  if (!col || !leftLbl || !colLbl) return;
  const leftBody = invEl.querySelector(".wou-inv-left .wou-inv-subgrid-body");
  const colBody  = col.querySelector(".wou-inv-subgrid-body");

  /* Strict WRITE (resets) → READ (one batch) → WRITE (results) so the browser
   * reflows ONCE for this function instead of twice. Interleaving a write between
   * the two getBoundingClientRect reads forced a second full-page reflow. */
  col.style.paddingTop = "0px";                  // reset before measuring
  if (colBody) colBody.style.maxHeight = "";     // reset before measuring

  // #wou-inventory carries `zoom: var(--wdm-scale)`, which scales
  // getBoundingClientRect coords but NOT the padding we write — divide it back
  // out (read the COMPUTED zoom, robust to whichever var drives it) so the
  // top-padding lands the containers label on the category labels.
  const zoom = parseFloat(getComputedStyle(invEl).zoom) || 1;
  const pad  = (leftLbl.getBoundingClientRect().top - colLbl.getBoundingClientRect().top) / zoom;
  // The containers column runs the full section height (no tab row above it), so
  // its cell viewport is a touch taller than the category grids' and padGridFillers
  // gives it one extra filler row. Cap the containers grid body to the category
  // body height so both show the SAME number of rows. Measured here (before
  // padGridFillers runs in the same pass) so visRows is measured against the cap.
  const h = (leftBody && colBody) ? leftBody.getBoundingClientRect().height / zoom : 0;

  col.style.paddingTop = pad > 0 ? `${pad}px` : "0px";
  if (colBody && h > 0) colBody.style.maxHeight = `${h}px`;
}

/** Top each sub-grid up with WHOLE empty cells so the faint lattice fills the
 *  VISIBLE viewport only — never more (so no premature scrollbar). If the real
 *  items already exceed the viewport, no fillers are added and the wrap scrolls.
 *  Filler cells carry a continuing `data-slot` so they're valid drop targets
 *  ("drag N cells down into empty space and it sticks"). */
/* Geometry of a subgrid's visible viewport — how many whole cell-rows fit
 * without a scrollbar, plus the track metrics. Shared by the filler padding and
 * the tall-item drop guard so both agree on where the grid actually ends.
 * The grid is now its OWN vertical scroll container, so its clientHeight IS the
 * visible viewport — no wrap-offset math (which was fragile for the containers
 * column and over-filled it). */
function subgridGeometry(grid) {
  if (!grid) return null;
  const cs   = getComputedStyle(grid);
  const cols = cs.gridTemplateColumns.split(" ").filter(Boolean).length;
  if (!cols) return null;
  const cell = parseFloat(cs.gridTemplateColumns) || 58;   // px width of a track
  const gap  = parseFloat(cs.rowGap) || 0;
  const avail = grid.clientHeight;   // the scroll viewport height
  const visRows = Math.max(1, Math.floor((avail + gap) / (cell + gap)));
  return { cols, cell, gap, visRows };
}

let _padScheduled = false;
/** rAF-coalesced re-fill: follows a resize/bar-expand smoothly (once per frame,
 *  post-layout) so the grid columns AND the dividers track the new width right
 *  away. The open fade is transform/opacity only (no size change) so this never
 *  fires during it — no animation cost. */
function schedulePadFillers() {
  if (_padScheduled) return;
  _padScheduled = true;
  requestAnimationFrame(() => {
    _padScheduled = false;
    if (!isInventoryOpen()) return;
    alignContainersColumn();
    padGridFillers();
  });
}

/** (Re)point the ResizeObserver at the overlay AND the current grid-wraps — they
 *  are rebuilt on every render, so their width changes (bar expansion, resize)
 *  only get seen if we re-observe the fresh elements. */
function reobserveInventoryLayout() {
  if (!_invResizeObs || !invEl) return;
  _seedObserverWidths = true;   // the imminent baseline delivery is not a real resize
  _invResizeObs.disconnect();
  _invResizeObs.observe(invEl);
  // Observe each sub-grid's BODY (the non-scrolling parent), NOT the grid itself.
  // The body's content-box tracks the available layout width (what determines the
  // column count) but does NOT shrink when the inner grid toggles its own vertical
  // scrollbar. Observing the scroll container directly caused a feedback loop:
  // padGridFillers adds fillers → grid overflows → scrollbar appears → grid
  // content-box narrows ~15px → observer fires (width changed) → repad → scrollbar
  // toggles → repeat (~10 forced-reflow passes). The body is immune to that.
  for (const b of invEl.querySelectorAll(".wou-inv-subgrid-body")) _invResizeObs.observe(b);
}

/* Dynamic tall-icon fitting: item art has wildly different subject sizes and lots
 * of transparent margin, so a flat object-fit either shrinks the subject (contain)
 * or crops it (cover). Instead, measure the subject's non-transparent bounding box
 * ONCE per image path, then scale + position the <img> so JUST that box fills the
 * tile, clipped by the .wou-tall-fit wrapper. This reproduces (in EVERY browser)
 * what Chromium's object-view-box did — Firefox has no object-view-box, which is
 * why fitting used to work only in Chrome.
 * The result is keyed by image path and PERSISTED to localStorage, so it survives
 * reloads and is baked straight into the tile HTML (itemSlotHTML) → correct on the
 * first paint, no visible resize. An image is only ever measured the first time it
 * is seen on this client, ever. */
/* v3: browser-agnostic subject crop. The 2:1 "biggify" isolates the item art's
 * subject and scales it to fill the tall tile. Chromium did this via the
 * Chromium-ONLY `object-view-box` (Firefox has no equivalent), so it only worked
 * in Chrome. We now reproduce the IDENTICAL result in every browser by absolutely
 * positioning the <img> (scaled so its subject box fills the tile) inside a
 * clipping wrapper. Cache holds a crop {w,h,x,y} (percent box for the <img>) or
 * "" (subject already fills → CSS `cover` baseline). v1/v2 stored inset strings
 * (a different shape), so bump the key to discard them. */
const _ICON_FIT_LS_KEY = "wou-inv-icon-fit-v4";
const _iconFitCache = {};
try { Object.assign(_iconFitCache, JSON.parse(localStorage.getItem(_ICON_FIT_LS_KEY) || "{}")); } catch (_) {}
let _iconFitSaveTimer = null;
function _saveIconFitCache() {
  if (_iconFitSaveTimer) return;
  _iconFitSaveTimer = setTimeout(() => {
    _iconFitSaveTimer = null;
    try { localStorage.setItem(_ICON_FIT_LS_KEY, JSON.stringify(_iconFitCache)); } catch (_) {}
  }, 500);
}
/* Inline style that scales a tall <img> so its subject box fills the tile.
 * Absolute-positioned; the .wou-tall-fit wrapper clips the overflow. All values
 * are % of the tile → zoom/size independent, identical across browsers. */
function _tallCropCss(c) {
  return `position:absolute;left:${c.x}%;top:${c.y}%;width:${c.w}%;height:${c.h}%;max-width:none;max-height:none;object-fit:fill`;
}
/** Inline crop style baked into the HTML for an already-classified tall <img> so
 *  it paints correct immediately. "" (unmeasured, or subject-fills) → the CSS
 *  `cover` baseline applies and fitTallIcon() measures/upgrades it in idle. */
function iconFitStyle(imgPath) {
  const c = _iconFitCache[imgPath];
  return (c && typeof c === "object") ? ` style="${_tallCropCss(c)}"` : "";
}
/** Same cached crop as iconFitStyle, but as bare CSS declarations for callers
 *  that bind it through a template attribute rather than splicing raw HTML
 *  (the merchant shop grid). "" → the `cover` baseline paints until a
 *  measurement lands. */
export function tallCropStyleFor(imgPath) {
  const c = _iconFitCache[imgPath];
  return (c && typeof c === "object") ? _tallCropCss(c) : "";
}
/* Apply or clear the crop on one tall <img>. */
function _setTallCrop(el, c) {
  const s = el.style;
  if (c && typeof c === "object") {
    s.position = "absolute";
    s.left = c.x + "%"; s.top = c.y + "%";
    s.width = c.w + "%"; s.height = c.h + "%";
    s.maxWidth = "none"; s.maxHeight = "none";
    s.objectFit = "fill";
  } else {
    // "" → clear inline crop; fall back to the CSS `cover` baseline.
    s.position = ""; s.left = ""; s.top = "";
    s.width = ""; s.height = ""; s.maxWidth = ""; s.maxHeight = ""; s.objectFit = "";
  }
}
function fitTallIcons() {
  if (!invEl) return;
  fitTallIconsIn(invEl);
}
/** Measure + apply the 2:1 subject crop to every tall tile under `root`. The
 *  inventory calls this for its own grid; the merchant shop calls it for the
 *  shop grid after each render. Cache hits apply synchronously, misses are
 *  measured off the render path. */
export function fitTallIconsIn(root) {
  if (!root) return;
  for (const img of root.querySelectorAll(".wou-slot--tall img.icon")) fitTallIcon(img);
}
const _idle = window.requestIdleCallback || ((f) => setTimeout(() => f({ timeRemaining: () => 8 }), 0));
function fitTallIcon(img) {
  const src = img.getAttribute("src");   // == item.img, the cache key baked into HTML
  if (!src) return;
  // Cached → apply instantly (common path; also inlined into the HTML).
  if (src in _iconFitCache) { _setTallCrop(img, _iconFitCache[src]); return; }
  // First sight → measure the subject box OFF the render path (idle).
  _idle(() => {
    if (src in _iconFitCache) { _applyTallCrop(src); return; }
    _measureTallCrop(src).then(c => {
      // null = pixels unreadable (cross-origin without CORS headers, or load
      // error). Do NOT cache — leave uncached so it retries next open rather
      // than being stuck on the plain `cover` baseline forever.
      if (c === null) return;
      _iconFitCache[src] = c;   // {w,h,x,y} or ""
      _saveIconFitCache();
      _applyTallCrop(src);
    });
  });
}

/** Apply the cached crop for `src` to every currently-shown tall tile with that
 *  image (the original <img> may have been re-rendered before idle fired). */
function _applyTallCrop(src) {
  const c = _iconFitCache[src];
  // Document-wide, not invEl-scoped: tall tiles also live in the merchant shop
  // grid, and a crop measured for one must land on every tile showing that art.
  for (const el of document.querySelectorAll(".wou-slot--tall img.icon")) {
    if (el.getAttribute("src") === src) _setTallCrop(el, c);
  }
}

/** Load `src` CROSS-ORIGIN and compute the crop that scales its subject box to
 *  fill a 2:1 (portrait) tile — the browser-agnostic replacement for Chromium's
 *  `object-view-box`. Resolves to {w,h,x,y} (percent box for the <img>), ""
 *  (subject already fills → cover baseline), or null when the pixels can't be
 *  read. The crossOrigin probe keeps the canvas untainted when art is served
 *  from a separate CORS-enabled origin (cloud hosts). */
function _measureTallCrop(src) {
  return new Promise((resolve) => {
    const probe = new Image();
    probe.crossOrigin = "anonymous";
    probe.decoding = "async";
    probe.onerror = () => resolve(null);
    probe.onload = () => {
      try {
        const W = probe.naturalWidth, H = probe.naturalHeight;
        if (!W || !H) return resolve(null);
        const sc = Math.min(64 / W, 64 / H, 1);   // scan a downscaled copy — fast, precise enough
        const dw = Math.max(1, Math.round(W * sc)), dh = Math.max(1, Math.round(H * sc));
        const cv = document.createElement("canvas");
        cv.width = dw; cv.height = dh;
        const ctx = cv.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(probe, 0, 0, dw, dh);
        const d = ctx.getImageData(0, 0, dw, dh).data;   // throws if tainted → catch → null
        let minX = dw, minY = dh, maxX = -1, maxY = -1;
        for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
          if (d[(y * dw + x) * 4 + 3] > 16) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
        if (!(maxX >= minX && maxY >= minY)) return resolve("");   // fully transparent → nothing to crop
        // Padded subject box in image px (3% breathing room, like the old fit).
        const pad = Math.min(W, H) * 0.03;
        const L  = Math.max(0, (minX / dw) * W - pad);
        const T  = Math.max(0, (minY / dh) * H - pad);
        const Rt = Math.min(W, ((maxX + 1) / dw) * W + pad);
        const Bt = Math.min(H, ((maxY + 1) / dh) * H + pad);
        const sw = Rt - L, sh = Bt - T;
        if (sw <= 0 || sh <= 0) return resolve("");
        // Is the subject WIDER than the 2:1 tile (aspect > 1/2)? A wide subject
        // (bow, crossbow) under CSS `cover` would be scaled to fill height and
        // have its left/right cropped off — the "cut-off bow". For those we must
        // always CONTAIN (below), never fall back to cover.
        const wide = (sw / sh) > 0.5;
        // Subject already ~fills the art AND is tall/narrow → the `cover` baseline
        // fills the tile edge-to-edge with no meaningful loss. Wide subjects skip
        // this and take the contain path so nothing is clipped.
        if (!wide && sw >= W * 0.94 && sh >= H * 0.94) return resolve("");
        // Contain the subject box in a 2:1 tile (tile height = 2 × width). a = k/TW,
        // where k = the scale that fits the subject box (contain).
        const a = Math.min(1 / sw, 2 / sh);
        resolve({
          w: +(W * a * 100).toFixed(3),                        // <img> width  as % of tile width
          h: +(H * (a / 2) * 100).toFixed(3),                  // <img> height as % of tile height
          x: +((0.5 - a * (sw / 2 + L)) * 100).toFixed(3),     // <img> left   as % of tile width
          y: +((0.5 - (a / 2) * (sh / 2 + T)) * 100).toFixed(3) // <img> top    as % of tile height
        });
      } catch (_) {
        resolve(null);
      }
    };
    probe.src = src;
  });
}

/* Fillers are laid out by CSS auto-flow (grid-auto-flow: row) — no JS positioning —
 * so tall tiles pack without overlap. Fill the visible area a little generously,
 * then trim any that overflow so the fillers never spawn a scrollbar. A tall tile
 * occupies a 2nd cell, so each one means one FEWER filler for the same row count.
 *
 * Structured as strict READ → WRITE → READ → WRITE phases across ALL grids rather
 * than read/write interleaved per grid. Every geometry read (getComputedStyle,
 * clientHeight, scrollHeight) after a style/DOM write forces a full-page reflow;
 * interleaving made that ~2 reflows PER grid (dozens total → 60-124ms). Batching
 * collapses it to two reflow points regardless of how many grids are on screen. */
function padGridFillers() {
  if (!invEl) return;
  const grids = invEl.querySelectorAll(".wou-inv-subgrid-grid");

  // ── PHASE 1 — READ: geometry + current fill for every grid (one reflow batch).
  //    maxSlot excludes existing pads (we haven't removed them yet) so the target
  //    math matches the post-remove state.
  const plans = [];
  for (const grid of grids) {
    const geo = subgridGeometry(grid);
    if (!geo) continue;
    let maxSlot = -1;
    for (const c of grid.querySelectorAll("[data-slot]:not(.is-pad)")) {
      const s = Number(c.dataset.slot);
      if (Number.isInteger(s) && s > maxSlot) maxSlot = s;
    }
    const tallCount = grid.querySelectorAll(".wou-slot--tall").length;
    const target = Math.max(maxSlot + 1, (geo.visRows + 1) * geo.cols - tallCount);
    plans.push({ grid, geo, maxSlot, target });
  }

  // ── PHASE 2 — WRITE: drop stale pads + append fresh fillers for every grid.
  for (const p of plans) {
    /* Publish the ACTUAL rendered column count onto the body so the frame
       bracket (.wou-inv-subgrid-body::before) can size itself to the tiled
       columns rather than the full panel width (the fixed subCols estimate in
       the HTML can differ from what auto-fill actually renders). */
    p.grid.parentElement?.style.setProperty("--wou-cols", String(p.geo.cols));
    p.grid.querySelectorAll(".wou-slot.is-empty.is-pad").forEach(e => e.remove());
    const frag = document.createDocumentFragment();
    for (let slot = p.maxSlot + 1; slot < p.target; slot++) {
      const d = document.createElement("div");
      d.className = "wou-slot is-empty is-pad";
      d.dataset.slot = String(slot);
      frag.appendChild(d);
    }
    if (frag.childElementCount) p.grid.appendChild(frag);
  }

  // ── PHASE 3 — READ: measure overflow for every grid (one reflow batch).
  for (const p of plans) {
    p.overflow = p.grid.scrollHeight - p.grid.clientHeight;
  }

  // ── PHASE 4 — WRITE: trim whole overflowing rows in one shot per grid.
  for (const p of plans) {
    if (p.overflow <= 1) continue;
    const rowH = p.geo.cell + p.geo.gap;
    const removeCount = Math.ceil(p.overflow / rowH) * p.geo.cols;
    const pads = p.grid.querySelectorAll(".wou-slot.is-empty.is-pad");
    for (let i = pads.length - 1, n = 0; i >= 0 && n < removeCount; i--, n++) pads[i].remove();
  }
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
export async function renderItemCardInto(panel, item) {
  if (!panel) return;
  if (!item) { panel.innerHTML = ""; return; }
  panel.dataset.rarity = String(item.system?.availability ?? "").toLowerCase();
  // Per-item flair override mirrors the grid slot: a custom colour wins over
  // the availability tier wash on the card.
  const inspFlair = flairHex(item);
  if (inspFlair) { panel.classList.add("has-flair"); panel.style.setProperty("--wdm-rar", inspFlair); }
  else { panel.classList.remove("has-flair"); panel.style.removeProperty("--wdm-rar"); }
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
    let shieldMeta        = null;
    let shieldQualityList = [];
    let alchemyMeta       = null;
    let ammoMeta          = null;
    let rangedMeta        = null;
    let componentMeta     = null;
    let containerMeta     = null;
    let mutagenMeta       = null;
    let diagramMeta       = null;
    let bookMeta          = null;
    let bookDisplayMeta   = null;
    let foodMeta          = null;
    let enhancementMeta   = null;
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

      /* Ranged-weapon loadout — the full chamber STACK in fire order (FILO:
       * next-to-fire first), each round with its own type + oil. Chamber weapons
       * (crossbows) only; bows nock at fire time and have no chamber. */
      if (item.type === "weapon" && item.hasChamber) {
        const chamberRounds = item.getChamberRounds?.() ?? [];
        const capacity = Math.max(1, Number(item.system?.loaded?.capacity) || 1);
        rangedMeta = {
          hasChamber:  true,
          isLoaded:    chamberRounds.length > 0,
          loadedCount: chamberRounds.length,
          capacity,
          chamber:     chamberRounds.slice().reverse().map((r, i) => ({
            pos:     i + 1,
            name:    String(r.name || ""),
            img:     String(r.img  || ""),
            oilName: (r.appliedOil?.name && String(r.appliedOil.name).trim())
                         ? String(r.appliedOil.name).trim() : "",
            next:    i === 0
          }))
        };
      }

      if (item.type === "ammo") {
        // Ammo inspect card: mirrors the depth of the weapon / armor cards.
        // Hero = ammo class label (Arrow / Bolt); subline = localized damage
        // types. Stats row surfaces quantity, availability, concealment.
        // Applied oil (if the projectile is coated) gets its own subsection
        // with name + charges remaining, matching the weapon oil badge.
        const sys = rawItem.system ?? {};
        const dmgTypes = cfgMod.DAMAGE_TYPES ?? CONFIG?.WITCHER?.damageTypes ?? {};
        const ammoTypeMap = cfgMod.AMMO_TYPES
                         ?? CONFIG?.WITCHER?.weapon?.ammoTypes
                         ?? { arrow: "WITCHER.Ammo.Arrow", bolt: "WITCHER.Ammo.Bolt" };
        const loc = (k, fb) => (k && game.i18n?.localize ? game.i18n.localize(k) : (fb ?? k));
        const ammoTypeKey = String(sys.ammoType ?? "arrow");
        const ammoTypeLabel = loc(ammoTypeMap[ammoTypeKey], ammoTypeKey);
        const damageTypeLabels = (sys.damageTypes ?? [])
          .map(k => loc(dmgTypes[k], k))
          .filter(Boolean);
        const availabilityKey = String(sys.availability ?? "");
        const availabilityLabel = availabilityKey
          ? loc(CONFIG?.WITCHER?.availability?.[availabilityKey], availabilityKey)
          : "";
        const concealKey = String(sys.conceal ?? "");
        const concealLabel = concealKey
          ? loc(CONFIG?.WITCHER?.conceal?.[concealKey], concealKey)
          : "";
        const oil = sys.appliedOil ?? {};
        const hasOil = !!(oil?.name && String(oil.name).trim());
        ammoMeta = {
          ammoTypeKey,
          ammoTypeLabel,
          damageTypeLabels,
          quantity:        Number(sys.quantity) || 0,
          availabilityLabel,
          concealLabel,
          hasOil,
          oilName:         hasOil ? String(oil.name)      : "",
          oilImg:          hasOil ? String(oil.img ?? "") : "",
          oilCharges:      hasOil ? (Number(oil.charges) || 0) : 0,
          oilMaxCharges:   hasOil ? (Number(oil.maxCharges) || 0) : 0,
          oilBonusDamage:  hasOil ? (Number(oil.oilBonusDamage) || 0) : 0
        };
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
          head:     t("WITCHER.Chrome.HitLocation.Full.head",     "Head"),
          torso:    t("WITCHER.Chrome.HitLocation.Full.torso",    "Torso"),
          leftArm:  t("WITCHER.Chrome.HitLocation.Full.leftArm",  "Left Arm"),
          rightArm: t("WITCHER.Chrome.HitLocation.Full.rightArm", "Right Arm"),
          leftLeg:  t("WITCHER.Chrome.HitLocation.Full.leftLeg",  "Left Leg"),
          rightLeg: t("WITCHER.Chrome.HitLocation.Full.rightLeg", "Right Leg")
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
            primaryStatLabel: t("WITCHER.Chrome.Inventory.HeroLabel.Blocks", "BLOCKS"),
            coverageLabel:    t("WITCHER.Chrome.Inventory.Text.Shield", "Shield"),
            isShield:         true
          };
        } else {
          /* Per-location SP rows, gated by the `location` enum so a
           * Torso piece never shows arm rows even if a stale value sits
           * in the document. Hero number is the highest current SP
           * across covered slots. */
          // Shared coverage map (config.mjs) so the inventory display
          // always agrees with the sheet form and the combat derivation.
          const loc = rawItem.system?.location;
          const coveredKeys = ARMOR_LOCATION_COVERAGE[loc]
            ?? [loc].filter(k => LOC_KEYS.includes(k));
          const coveredRows = coveredKeys.map(buildRow);
          const sorted = [...coveredRows].sort((a, b) => b.value - a.value);
          armorMeta = {
            primarySP:        sorted[0]?.value ?? 0,
            primarySPMax:     sorted[0]?.max   ?? 0,
            primaryStatLabel: t("WITCHER.Chrome.Inventory.HeroLabel.StoppingPower", "STOPPING POWER"),
            coverageLabel:    coveredRows.map(r => r.label).join(" · "),
            multiLocation:    coveredRows.length > 1,
            spLocations:      coveredRows.map(r => ({ label: r.label, value: r.value, max: r.max })),
            isShield:         false
          };
          /* EO armor model on → attach the zone-group breakdown so the
           * inspect card can render per-zone slots + resistance chips
           * matching the item sheet's display view. Reuse the SAME
           * builder the sheet uses (buildEnhancementSlotGroups) so the
           * two surfaces never drift. */
          try {
            const eo = await import("/systems/witcher-ttrpg-death-march/module/mechanics/eoArmorModel.mjs");
            if (eo.isEoArmorModelOn?.()) {
              armorMeta.eoArmorModelOn = true;
              const slotsMod = await import("/systems/witcher-ttrpg-death-march/module/sheets/item/enhancementSlots.mjs");
              armorMeta.enhancementSlotGroups = slotsMod.buildEnhancementSlotGroups?.(item) ?? [];
              /* Pull the aeBudget off the first AE group (they all
               * carry the same budget object) so the template can show
               * "N/M · AE budget" once at the top of the AE section. */
              const firstAe = (armorMeta.enhancementSlotGroups || []).find(g => g.kind === "ae");
              armorMeta.aeBudget = firstAe?.budget ?? null;
            } else {
              armorMeta.eoArmorModelOn = false;
            }
          } catch (_) { armorMeta.eoArmorModelOn = false; }
        }
      }

      if (item.type === "shield") {
        // Shield inspection card: Reliability (blocks) as the hero
        // number, Cover Value (CV) subline, category chip, EV, and
        // the same enhancement-slot + quality-tag row layout the
        // armor card uses. Mirrors WitcherShieldSheet's display —
        // catalog is the ARMOR quality catalog filtered to shield-
        // only entries via filterShieldQualities (same helper the
        // item sheet uses).
        const sys = rawItem.system ?? {};
        const rel = sys.reliability ?? {};
        const relCur = Number(rel.value) || 0;
        const relMax = Number(rel.max)   || 0;
        const cv     = Number(sys.coverValue) || 0;
        const catLabel = ({
          light:  t("WITCHER.Chrome.Inventory.Text.Light",  "Light"),
          medium: t("WITCHER.Chrome.Inventory.Text.Medium", "Medium"),
          heavy:  t("WITCHER.Chrome.Inventory.Text.Heavy",  "Heavy")
        })[sys.category] ?? t("WITCHER.Chrome.Inventory.Text.Medium", "Medium");
        const subParts = [];
        if (cv > 0) subParts.push(`CV ${cv}`);
        subParts.push(catLabel);
        shieldMeta = {
          primarySP:        relCur,
          primarySPMax:     relMax,
          primaryStatLabel: t("WITCHER.Chrome.Inventory.HeroLabel.Blocks", "BLOCKS"),
          coverageLabel:    subParts.join(" · "),
          coverValue:       cv,
          category:         catLabel,
          isFullCover:      cv >= 6,
          effectHtml:       String(sys.effect ?? "")
        };
        /* Shield qualities live in the ARMOR quality catalog under a
         * SHIELD-only filter (Sturdy shield, Parrying shield, Deployable,
         * Blade Catcher, Archery Shield, Very Sturdy, deprecated Full
         * Cover). Same helper the item sheet uses. */
        const fullCatalog = cfgMod.getActiveArmorQualities?.() ?? cfgMod.ARMOR_QUALITIES ?? {};
        const catalog     = cfgMod.filterShieldQualities?.(fullCatalog) ?? fullCatalog;
        const defaults    = cfgMod.ARMOR_QUALITIES ?? {};
        const values      = sys.qualityValues ?? {};
        shieldQualityList = buildQualityList(sys.qualities ?? [], catalog, defaults, values);
        // Enhancement slots (glyphs / armor mods) — shields host the
        // same AE pool armor does.
        effectiveMeta = item.system?.effective ?? null;
        const applied = item.system?.appliedEnhancements ?? [];
        const count   = Math.max(Number(item.system?.armorEnhancement) || 0, applied.length);
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
        const baseQ    = new Set(sys.qualities ?? []);
        const effVals  = effectiveMeta?.qualityValues ?? values;
        socketedQualityList = buildQualityList(
          (effectiveMeta?.qualities ?? []).filter(k => !baseQ.has(k)),
          catalog, defaults, effVals
        );
      }

      if (item.type === "weapon" || item.type === "armor") {
        // Socketed enhancements + effective (enhanced) stats. The live
        // `item` carries `system.effective` (derived); `rawItem` (source)
        // does not, so the meta is computed here from the live document.
        const isW = item.type === "weapon";
        effectiveMeta = item.system?.effective ?? null;
        // Slot count source: weapons always use RAW `weaponEnhancement`.
        // Armor: under EO the piece has a single-total `aeSlots` budget
        // authored per RAW EO p.4; fall back to the RAW `armorEnhancement`
        // when EO is off. Reads the toggle live so a mid-session flip
        // updates the displayed count on next render.
        const applied   = item.system?.appliedEnhancements ?? [];
        let slotBudget = 0;
        if (isW) {
            slotBudget = Number(item.system?.weaponEnhancement) || 0;
        } else {
            try {
                const eo = await import("/systems/witcher-ttrpg-death-march/module/mechanics/eoArmorModel.mjs");
                slotBudget = eo.isEoArmorModelOn?.()
                    ? Number(item.system?.aeSlots) || 0
                    : Number(item.system?.armorEnhancement) || 0;
            } catch (_) {
                slotBudget = Number(item.system?.armorEnhancement) || 0;
            }
        }
        const count = Math.max(slotBudget, applied.length);
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
          if (effectiveMeta.slashing    && !rawItem.system?.slashing)    addedRes.push(t("WITCHER.Sheet.Item.Base.Text.Slashing",   "Slashing"));
          if (effectiveMeta.piercing    && !rawItem.system?.piercing)    addedRes.push(t("WITCHER.Sheet.Item.Base.Text.Piercing",   "Piercing"));
          if (effectiveMeta.bludgeoning && !rawItem.system?.bludgeoning) addedRes.push(t("WITCHER.Sheet.Item.Base.Text.Bludgeoning","Bludgeoning"));
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
        const isOil       = type === "oil";
        const hasToxicity = type === "potion" || type === "decoction";
        const typeLabel   = loc(types[type], type);
        const rebornOn = isHomebrewEnabled?.("alchemyPotency");
        let heroValue, heroLabel, heroSub = "";
        if (isBomb) {
          heroValue = sys.damage || "—";
          heroLabel = t("WITCHER.Chrome.Inventory.HeroLabel.Damage", "DAMAGE");
          heroSub   = sys.damageType ? loc(dmgTypes[sys.damageType], sys.damageType) : "";
        } else if (hasToxicity) {
          heroValue = sys.toxicity ?? 0;
          heroLabel = t("WITCHER.Chrome.Inventory.HeroLabel.Toxicity", "TOXICITY");
          heroSub   = sys.duration || "";
        } else if (isOil) {
          /* Oils: Reborn swaps the duration hero for a CHARGES hero so
           * the inspect card reads the same as the item sheet display
           * (which already has the toggle-aware swap). The free-text
           * `sys.duration` is ignored for oils — structured fields
           * (oilDuration / oilCharges) are the authoritative source.
           * Prefer `currentCharges` (running count on a partially-spent
           * bottle from the ammo-coat flow) over `oilCharges` (authored
           * total) so a bottle used to coat 2 arrows reads "3" instead
           * of "5". Fresh bottles have currentCharges=0 and fall back
           * to oilCharges. */
          if (rebornOn) {
            const cur = Number(sys.currentCharges) || 0;
            const max = Number(sys.oilCharges) || 0;
            const charges = cur > 0 ? cur : max;
            heroValue = charges > 0 ? charges : "—";
            heroLabel = t("WITCHER.Chrome.Inventory.HeroLabel.Charges", "CHARGES");
          } else {
            const dv = Number(sys.oilDuration?.value) || 0;
            const du = String(sys.oilDuration?.units || "");
            heroValue = dv > 0 ? `${dv} ${du}` : typeLabel;
            heroLabel = dv > 0
              ? t("WITCHER.Chrome.Inventory.HeroLabel.Duration", "DURATION")
              : t("WITCHER.Chrome.Inventory.HeroLabel.Type", "TYPE");
          }
        } else {
          heroValue = sys.duration || typeLabel;
          heroLabel = sys.duration
            ? t("WITCHER.Chrome.Inventory.HeroLabel.Duration", "DURATION")
            : t("WITCHER.Chrome.Inventory.HeroLabel.Type", "TYPE");
        }
        /* Alchemy Reborn base summary — shown on the inspect card when the
         * item is configured as a brew base. Resolved via the shared
         * baseSummaryFor so the inspect line matches the item-sheet
         * display line one-for-one ("Potion / Decoction · -2 DC"). Null
         * when the toggle is off or no base is configured. */
        let baseSummary = null;
        if (rebornOn) {
          try {
            const api = game?.system?.api?.alchemy?.baseSummaryFor;
            baseSummary = typeof api === "function" ? api(item) : null;
          } catch (_) { /* api not wired yet — leave null */ }
        }
        alchemyMeta = { isBomb, hasToxicity, typeLabel, heroValue, heroLabel, heroSub, baseSummary };
      }

      if (item.type === "component") {
        // Mirror WitcherComponentSheet._prepareContext — substance hero when
        // the component yields one of the nine substances, else availability.
        // Under Alchemy Reborn the hero block also surfaces the potency value
        // so a player inspecting an Archespore Juice sees "+4 Potency" without
        // opening the full sheet.
        const sys  = rawItem.system ?? {};
        const subs  = cfgMod.SUBSTANCES ?? CONFIG?.WITCHER?.alchemical?.substances ?? {};
        const art   = cfgMod.SUBSTANCE_ART ?? CONFIG?.WITCHER?.alchemical?.substanceArt ?? {};
        const loc = (k, fb) => (k && game.i18n?.localize ? game.i18n.localize(k) : (fb ?? k));
        const subKey   = (sys.substanceType ?? "").trim();
        const isSubstance = !!sys.isSubstance;
        const hasHero = isSubstance && !!subKey;
        const rebornOn = isHomebrewEnabled?.("alchemyPotency");
        const potency = Number(sys.potency) || 0;
        /* Alchemy Reborn brew-base summary — components can be bases too
         * (Saltpetre → bomb, dry-substance vodka → potion, etc.; see
         * alchemy.mjs:readBase). Same shape as alchemyMeta.baseSummary /
         * foodMeta.baseSummary so the template row reads identically. */
        let baseSummaryComp = null;
        if (rebornOn) {
          try {
            const api = game?.system?.api?.alchemy?.baseSummaryFor;
            baseSummaryComp = typeof api === "function" ? api(item) : null;
          } catch (_) { /* api not wired yet */ }
        }
        componentMeta = {
          isSubstance,
          hasHero,
          substanceKey:  hasHero ? subKey : "",
          substanceName: hasHero ? loc(subs[subKey], subKey) : "",
          substanceArt:  hasHero ? (art[subKey] ?? "") : "",
          showPotency:   rebornOn && hasHero && potency > 0,
          potency,
          baseSummary:   baseSummaryComp
        };
      }

      if (item.type === "mutagen") {
        // Mirror WitcherMutagenSheet — the "Effect" is the mutagen's Active-
        // Effect modifiers (e.g. "+3 Melee"), the same list its sheet shows.
        // Alchemy Reborn additions: substance hero (mutagens carry a
        // substance type just like components under Reborn) + a Potency
        // badge so the inspect card matches the substance-component layout.
        let mods = [];
        try {
          const sheetMod = await import("/systems/witcher-ttrpg-death-march/module/sheets/item/base.mjs");
          mods = sheetMod.summarizeEffectModifiers?.(item) ?? [];
        } catch (_) { /* helper unavailable — skip the effect rows */ }
        const t = String(rawItem.system?.type ?? "");
        const sys = rawItem.system ?? {};
        const subs = cfgMod.SUBSTANCES ?? CONFIG?.WITCHER?.alchemical?.substances ?? {};
        const art  = cfgMod.SUBSTANCE_ART ?? CONFIG?.WITCHER?.alchemical?.substanceArt ?? {};
        const loc  = (k, fb) => (k && game.i18n?.localize ? game.i18n.localize(k) : (fb ?? k));
        const subKey = String(sys.substanceType
                           || sys.substance
                           || item.flags?.["witcher-alchemy-craft"]?.substance
                           || "").trim().toLowerCase();
        const rebornOn = isHomebrewEnabled?.("alchemyPotency");
        const hasSub = rebornOn && !!subKey;
        const potency = Number(sys.potency) || 0;
        mutagenMeta = {
          typeLabel: t ? t.charAt(0).toUpperCase() + t.slice(1) : "",
          modifiers: mods,
          hasSubstance:  hasSub,
          substanceKey:  hasSub ? subKey : "",
          substanceName: hasSub ? loc(subs[subKey], subKey) : "",
          substanceArt:  hasSub ? (art[subKey] ?? "") : "",
          showPotency:   rebornOn && potency > 0,
          potency
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
        // Only general / hybrid containers have a weight pool — a compartment-only
        // (slots) container never shows the capacity bar, even if it has a carry
        // number set.
        const capMode = getContainerCfg(item)?.capacityMode;
        const hasWeightPool = (capMode === "general" || capMode === "hybrid") && capacity > 0;
        containerMeta = {
          capacity,
          storedWeight: Math.round(stored * 100) / 100,
          contentCount: content.length,
          hasCapacity: hasWeightPool,
          isOver: hasWeightPool && stored > capacity,
          fillPct: hasWeightPool ? Math.min(100, Math.round((stored / capacity) * 100)) : 0
        };
      }

      if (item.type === "diagrams") {
        // Mirror WitcherDiagramsSheet._prepareContext — the hero is the
        // single craft DC (Alchemy for formulae, Crafting for diagrams,
        // Cooking for recipes), plus a produced-item preview, ingredient
        // list, and (formulae) required substances.
        const sys = rawItem.system ?? {};
        const loc = (k, fb) => (k && game.i18n?.localize ? game.i18n.localize(k) : (fb ?? k));
        // Tolerant kind lookup so worlds mid-migration still render: prefer
        // explicit `kind`, fall back to the legacy isFormulae boolean.
        const rawKind = sys.kind;
        const kind = (rawKind === "diagram" || rawKind === "formula" || rawKind === "recipe")
          ? rawKind
          : (sys.isFormulae ? "formula" : "diagram");
        const isFormula = kind === "formula";
        const isRecipe  = kind === "recipe";
        const isDiagram = kind === "diagram";
        const isFormulae = isFormula;   // back-compat field surfaced in meta

        const levels = cfgMod.DIAGRAM_LEVELS ?? CONFIG?.WITCHER?.crafting?.levels ?? {};
        const subMap = isFormula
          ? (cfgMod.FORMULA_SUBTYPES ?? CONFIG?.WITCHER?.crafting?.formulaSubtypes ?? {})
          : isRecipe
            ? (cfgMod.RECIPE_SUBTYPES ?? CONFIG?.WITCHER?.crafting?.recipeSubtypes ?? {})
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
          kind, isFormulae,
          dc:      isDiagram ? (Number(sys.craftingDC) || 0) : (Number(sys.alchemyDC) || 0),
          dcLabel: isRecipe  ? t("WITCHER.Chrome.Inventory.Text.CookingDC", "Cooking DC") : isFormula ? t("WITCHER.Chrome.Inventory.Text.AlchemyDC", "Alchemy DC") : t("WITCHER.Chrome.Inventory.Text.CraftingDC", "Crafting DC"),
          kindLabel: isRecipe ? t("WITCHER.Chrome.Inventory.Text.Recipe", "Recipe") : isFormula ? t("WITCHER.Chrome.Inventory.Text.Formula", "Formula") : t("WITCHER.Chrome.Inventory.Text.Diagram", "Diagram"),
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

      // Books: per-reader progress, shown above the description. Covers
      // both the first-class `book` item type AND the legacy valuable
      // subtype that pre-dates the type promotion.
      const isBookLike = item.type === "book"
        || (item.type === "valuable" && item.system?.type === "book");
      if (isBookLike && actor) {
        try {
          const studyMod = await import("/systems/witcher-ttrpg-death-march/module/chrome/sheets/valuable-study.js");
          bookMeta = studyMod.getBookProgress?.(item, actor) ?? null;
        } catch (_) { /* chrome book module unavailable — skip */ }
      }
      // Book category label (display subtitle) — mirrors the book sheet.
      if (item.type === "book") {
        const bt = rawItem.system?.bookConfig?.bookType ?? "monster";
        const BOOK_LBL = { monster: "Monster Lore", skill: "Skill", stress: "Novel / Lore" };
        bookDisplayMeta = { bookType: bt, bookTypeLabel: BOOK_LBL[bt] ?? "Monster Lore" };
      }

      // Enhancements (rune / glyph / weapon-mod / armor-mod): build the same display
      // view-model the item sheet renders — hero figure, mod rows, added damage
      // types / granted resistances, granted qualities, effects — so the inspect
      // card matches the sheet.
      if (item.type === "enhancement") {
        try {
          const s = rawItem.system ?? {};
          const eType = s.type ?? "rune";
          const isWeaponSide = (ENHANCEMENT_TARGET[eType] ?? "weapon") === "weapon";
          const ENH_LBL = {
            rune:   t("WITCHER.Sheet.Item.Base.EnhType.Rune",     "Rune"),
            glyph:  t("WITCHER.Sheet.Item.Base.EnhType.Glyph",    "Glyph"),
            weapon: t("WITCHER.Sheet.Item.Base.EnhType.WeaponMod","Weapon Mod"),
            armor:  t("WITCHER.Sheet.Item.Base.EnhType.ArmorMod", "Armor Mod")
          };
          const typeLabel = ENH_LBL[eType] ?? eType;
          const catalog  = isWeaponSide ? (getActiveWeaponQualities?.() ?? WEAPON_QUALITIES ?? {}) : (getActiveArmorQualities?.() ?? ARMOR_QUALITIES ?? {});
          const defaults = isWeaponSide ? (WEAPON_QUALITIES ?? {}) : (ARMOR_QUALITIES ?? {});
          const qValues  = s.qualityValues ?? {};
          const grantedQualityList = (s.grantedQualities ?? []).map(key => {
            const entry = catalog[key] ?? defaults[key];
            if (!entry) return null;
            const param = entry.param ?? defaults[key]?.param ?? null;
            let label = entry.label;
            if (param) { const raw = qValues[key]; const v = raw == null ? "" : String(raw).trim(); if (v.length) label = `${entry.label}(${v}${param.suffix ?? ""})`; }
            return { key, label, description: entry.description };
          }).filter(Boolean);
          const modRows = [];
          if (isWeaponSide) {
            const acc = Number(s.accuracyBonus) || 0, rel = Number(s.reliabilityBonus) || 0, dmg = (s.damageBonus ?? "").toString().trim();
            if (acc) modRows.push({ val: (acc > 0 ? "+" : "") + acc, lbl: t("WITCHER.Sheet.Item.Base.ModRow.WeaponAccuracy","Weapon Accuracy"), positive: acc > 0 });
            if (dmg) modRows.push({ val: (dmg.startsWith("-") ? "" : "+") + dmg, lbl: t("WITCHER.Sheet.Item.Base.ModRow.Damage","Damage"), positive: !dmg.startsWith("-") });
            if (rel) modRows.push({ val: (rel > 0 ? "+" : "") + rel, lbl: t("WITCHER.Sheet.Item.Base.ModRow.Reliability","Reliability"), positive: rel > 0 });
          } else {
            const sp = Number(s.stopping) || 0, ev = Number(s.encumbranceMod) || 0;
            if (sp) modRows.push({ val: "+" + sp, lbl: t("WITCHER.Sheet.Item.Base.ModRow.StoppingPower","Stopping Power"), positive: true });
            if (ev) modRows.push({ val: (ev > 0 ? "+" : "") + ev, lbl: t("WITCHER.Sheet.Item.Base.ModRow.Encumbrance","Encumbrance"), positive: ev < 0 });
          }
          const W = CONFIG.WITCHER ?? {};
          let addedTypeTags = [], resistTags = [];
          if (isWeaponSide) addedTypeTags = (s.addedDamageTypes ?? []).map(k => game.i18n.localize(W.damageTypes?.[k] ?? k));
          else { if (s.slashing) resistTags.push(t("WITCHER.Sheet.Item.Base.Text.Slashing","Slashing")); if (s.piercing) resistTags.push(t("WITCHER.Sheet.Item.Base.Text.Piercing","Piercing")); if (s.bludgeoning) resistTags.push(t("WITCHER.Sheet.Item.Base.Text.Bludgeoning","Bludgeoning")); if (s.fire) resistTags.push(t("WITCHER.Damage.Fire","Fire")); if (s.lightning) resistTags.push(t("WITCHER.Damage.Lightning","Lightning")); if (s.cold) resistTags.push(t("WITCHER.Damage.Cold","Cold")); if (s.acid) resistTags.push(t("WITCHER.Damage.Acid","Acid")); }
          let heroValue, heroLabel;
          if (isWeaponSide) {
            const dmg = (s.damageBonus ?? "").toString().trim(), acc = Number(s.accuracyBonus) || 0;
            if (dmg)      { heroValue = (dmg.startsWith("-") ? "" : "+") + dmg; heroLabel = "DAMAGE"; }
            else if (acc) { heroValue = (acc > 0 ? "+" : "") + acc; heroLabel = "ACCURACY"; }
            else          { heroValue = typeLabel; heroLabel = "FOR WEAPON"; }
          } else {
            const sp = Number(s.stopping) || 0;
            if (sp) { heroValue = "+" + sp; heroLabel = "STOPPING POWER"; } else { heroValue = typeLabel; heroLabel = "FOR ARMOR"; }
          }
          let attachedName = "";
          if (s.attachedTo && typeof fromUuidSync === "function") { try { const p = fromUuidSync(s.attachedTo); if (p) attachedName = p.name; } catch (_) { /* unresolved */ } }
          enhancementMeta = { typeLabel, heroValue, heroLabel, modRows, addedTypeTags, resistTags, grantedQualityList, attachedName, effects: s.effects ?? "" };
        } catch (e) { console.warn(`${MODULE_ID} | enhancement inspect meta failed`, e); }
      }

      // Remains items: surface what's been DONE to the carcass
      // (harvested / mutagen extracted / charges left), not the identity —
      // the name + icon already say what it is.
      if (item.type === "remains") {
        const f = item.flags?.[MODULE_ID] ?? {};
        // Hide the "Mutagen extracted" line when the source monster never had a
        // mutagen: prefer the stamped flag, else a sync resolve, else show.
        let hasMutagen;
        if (typeof f.mutagenLinked === "boolean") {
          hasMutagen = f.mutagenLinked;
        } else {
          const mUuid = item.system?.monsterUuid || f.monsterUuid;
          hasMutagen = true;
          if (mUuid && typeof fromUuidSync === "function") {
            try { const m = fromUuidSync(mUuid); if (m?.system) hasMutagen = !!m.system?.mutagen?.uuid; } catch (_) {}
          } else if (!mUuid) { hasMutagen = false; }
        }
        remainsState = {
          harvested:  !!f.harvested,
          extracted:  !!f.mutagenExtracted,
          hasMutagen,
          charges:    f.remainsCharges ?? 3,
          chargesMax: 3
        };
      }

      // Food (homebrew foodAndDrink) — kind label + portion ticker + the
      // satiety / alcohol stats from the schema, plus pre-computed
      // portion-scaled weight / cost so the footer matches what the
      // carry-weight tally actually counts (FoodData.calcWeight scales by
      // the same ratio). Gated on the toggle so a pure-RAW world sees a
      // plain item card with no portion/satiety/alcohol UI.
      if (item.type === "food" && isHomebrewEnabled("foodAndDrink")) {
        const sys = rawItem.system ?? {};
        const kind = sys.kind || "meal";
        const KIND_LABELS = {
            meal:       t("WITCHER.Chrome.Inventory.Text.Meal",       "Meal"),
            drink:      t("WITCHER.Chrome.Inventory.Text.Drink",      "Drink"),
            ingredient: t("WITCHER.Chrome.Inventory.Text.Ingredient", "Ingredient")
        };
        const max = Number(sys.charges?.max) || 0;
        const cur = Math.max(0, Math.min(max, Number(sys.charges?.current) || 0));
        const qty = Math.max(0, Number(sys.quantity) || 0);
        const unitMul = max > 0 ? (qty - 1) + (cur / max) : qty;
        const w = Number(sys.weight) || 0;
        const c = Number(sys.cost) || 0;
        // Round to 2dp for display; values like 0.75kg are common with portions.
        const round2 = (n) => Math.round(n * 100) / 100;
        // Freshness chip: same shape the food sheet builds so the
        // inspection card can render the chip with one template branch
        // (foodMeta.freshness.tracked). Untracked items collapse to
        // `tracked: false`, hiding the chip.
        const freshState = getFreshnessState(item);
        const freshRemaining = getFreshnessDaysRemaining(item);
        const FRESH_LABELS = {
            fresh:   t("WITCHER.Chrome.Inventory.Text.Fresh",   "Fresh"),
            stale:   t("WITCHER.Chrome.Inventory.Text.Stale",   "Stale"),
            spoiled: t("WITCHER.Chrome.Inventory.Text.Spoiled", "Spoiled")
        };
        const FRESH_ICONS  = { fresh: "fa-leaf", stale: "fa-leaf", spoiled: "fa-skull" };
        const freshness = {
          tracked: freshState !== "untracked",
          state: freshState,
          stateLabel: FRESH_LABELS[freshState] ?? t("WITCHER.Chrome.Inventory.Text.Fresh", "Fresh"),
          icon: FRESH_ICONS[freshState] ?? "fa-leaf",
          remaining: freshRemaining != null ? freshRemaining.toFixed(1) : ""
        };
        /* Alchemy Reborn base summary — same shape as alchemyMeta.baseSummary
         * so a single template branch renders it identically on either
         * item type. Resolved via the shared API helper to keep the inspect
         * line in lockstep with the food sheet display. */
        const rebornOnFood = isHomebrewEnabled?.("alchemyPotency");
        let baseSummaryFood = null;
        if (rebornOnFood) {
          try {
            const api = game?.system?.api?.alchemy?.baseSummaryFor;
            baseSummaryFood = typeof api === "function" ? api(item) : null;
          } catch (_) { /* api not wired yet */ }
        }
        // Tier label for the inspect subtitle. Poor tier splits on the
        // bland-eating flag to match the runtime rule in foodAndDrink.mjs
        // applyDietTierMechanics: only tier=poor + blandFood on + non-drink
        // actually feeds the bland stack, so only that combo reads as
        // "Bland meal". Otherwise poor items read as "Poor meal" and the
        // subtitle doesn't lie about whether eating this ticks the stack.
        const tier = String(sys.tier || "medium").toLowerCase();
        const blandFood = sys.blandFood !== false;   // default true
        const isDrinkKind = kind === "drink";
        const isBland = tier === "poor" && blandFood && !isDrinkKind;
        const tierLabel = tier === "poor"
          ? (isBland ? t("WITCHER.Chrome.Inventory.Text.BlandMeal", "Bleak meal")
                     : t("WITCHER.Chrome.Inventory.Text.PoorMeal",  "Poor meal"))
          : ({
              medium: t("WITCHER.Chrome.Inventory.Text.ModestMeal", "Modest meal"),
              good:   t("WITCHER.Chrome.Inventory.Text.GoodMeal",   "Good meal"),
              lavish: t("WITCHER.Chrome.Inventory.Text.LavishMeal", "Lavish meal")
            }[tier] ?? "");
        foodMeta = {
          kind,
          kindLabel: KIND_LABELS[kind] ?? kind,
          isDrink:   isDrinkKind,
          tier,
          tierLabel,
          hasCharges: max > 0,
          chargesCurrent: cur,
          chargesMax:     max,
          satietyRestore: Number(sys.satietyRestore) || 0,
          isAlcohol: isDrinkKind && !!sys.drunk?.isAlcohol,
          drunkDC:   Number(sys.drunk?.dc) || 0,
          // Portion-scaled totals — what the carry tally actually counts.
          effectiveWeight: round2(w * unitMul),
          effectiveCost:   round2(c * unitMul),
          freshness,
          baseSummary: baseSummaryFood
        };
      }

      // Enrich the description HTML (resolves @UUID links + inline rolls).
      // Remains have no description/value/availability — skip enrichment.
      const desc = item.type === "remains" ? null : item.system?.description;
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
        shieldMeta,
        shieldQualityList,
        alchemyMeta,
        ammoMeta,
        rangedMeta,
        componentMeta,
        containerMeta,
        mutagenMeta,
        diagramMeta,
        bookMeta,
        bookDisplayMeta,
        foodMeta,
        enhancementMeta,
        remainsState,
        descriptionHtml,
        effective: effectiveMeta,
        enhancementSlots,
        socketedQualityList
      }
    );
    /* Tag the inspection body with the item id so the broken-weapon
     * decorator (policy/broken-weapon-indicator.mjs) greys the icon
     * + appends (BROKEN) to the name when this item is broken. */
    panel.innerHTML = `<div class="wou-inspection-body" data-item-id="${escapeAttr(item.id)}">${html}</div>`;

    // Legacy post-process hooks — they look for selectors in the
    // old-system template that don't exist in our new partial. Wrap
    // each in try/catch so a missing element can't blank the panel.
    const safe = fn => { try { fn(); } catch (e) { console.warn(`${MODULE_ID} | inspection post-process`, e); } };
    safe(() => appendWeaponCombatTags(panel, item));
    safe(() => appendComponentSubstanceTag(panel, item));
    safe(() => appendComponentPotencyTag(panel, item));
    try { await appendQualityTags(panel, item); } catch (e) { console.warn(`${MODULE_ID} | inspection qualities`, e); }
    safe(() => appendAppliedOilSection(panel, item));
    safe(() => appendContainerContentsPreview(panel, item));
  } catch (err) {
    console.warn(`${MODULE_ID} | item card render failed`, err);
    panel.innerHTML = `<div class="wou-inspection-empty">${t("WITCHER.Chrome.Inventory.Text.InspectionUnavailable", "Inspection unavailable")}</div>`;
  }
}

/* Container contents preview — a strip of tiny item icons appended to the
 * hover/inspect card so you can see WHAT is inside a bag at a glance without
 * opening it. Resolves content UUIDs → items (same as the popup) and shows a
 * per-item quantity badge. */
function appendContainerContentsPreview(panel, item) {
  if (!panel || item?.type !== "container") return;
  const body = panel.querySelector(".wou-inspection-body");
  if (!body) return;
  const content = item.system?.content ?? [];
  const items = [];
  for (const ref of content) {
    let inner = null;
    try { inner = (typeof fromUuidSync === "function") ? fromUuidSync(ref) : null; } catch (_) { inner = null; }
    if (inner) items.push(inner);
  }
  const tiles = items.map(it => {
    const qty = Number(it.system?.quantity) || 1;
    const badge = qty > 1 ? `<span class="wou-cprev-qty">${qty}</span>` : "";
    const icon = (it.img && !it.img.includes("mystery-man"))
      ? `<img src="${escapeAttr(it.img)}" alt="" draggable="false" />`
      : `<i class="fa-solid ${fallbackIconFor(it.type)}"></i>`;
    return `<span class="wou-cprev-tile" title="${escapeAttr(it.name + (qty > 1 ? ` ×${qty}` : ""))}">${icon}${badge}</span>`;
  }).join("");
  const label = items.length
    ? `${t("WITCHER.Chrome.Inventory.Text.Contents", "Contents")} (${items.length})`
    : t("WITCHER.Chrome.Inventory.Text.ContainerEmpty", "Empty");
  const inner = tiles || `<span class="wou-cprev-empty">${t("WITCHER.Chrome.Inventory.Text.NothingStored", "Nothing stored")}</span>`;
  body.insertAdjacentHTML("beforeend", `
    <div class="wou-cprev">
      <div class="wou-cprev-label">${label}</div>
      <div class="wou-cprev-grid">${inner}</div>
    </div>`);
}

/* ---------- hover item card (replaces the old inspection panel) ---------- */

const HOVER_DELAY_MS = 500;
let _hoverCardEl  = null;
let _hoverTimer   = null;
let _hoverArmedId = null;   // slot the pending timer / shown card is for
let _hoverToken   = 0;      // guards against a stale async render painting late
/* True from a dragstart until the user next MOVES the cursor after the drop.
 * Suppresses the hover timer so dragging an item into a container never arms a
 * card — and, critically, so the synthetic mouseover the drop's DOM-replacement
 * fires under the stationary cursor can't pop a stray card (the top-left flash). */
let _dragActive   = false;

/** Resolve a tile's item across the assigned character and its linked mount
 *  (covers grid, equip, container-popup and mount-popup tiles). */
function resolveTileItem(id) {
  if (!id) return null;
  const assigned = getPanelActor("inventory");
  let item = assigned?.items?.get(id);
  if (item) return item;
  const mount = assigned ? getMountActor(assigned) : null;
  return mount?.items?.get(id) ?? null;
}

function ensureHoverCardEl() {
  if (_hoverCardEl && document.body.contains(_hoverCardEl)) return _hoverCardEl;
  _hoverCardEl = document.createElement("div");
  _hoverCardEl.id = "wou-inv-hover-card";
  // Scope class so the item-card `.wdm-*` styles resolve on this body-appended
  // float, plus a data-inspection hook for the broken-weapon decorator.
  _hoverCardEl.className = "witcher-ttrpg-death-march wou-inv-hover-card";
  _hoverCardEl.setAttribute("data-inspection", "");
  _hoverCardEl.style.display = "none";
  document.body.appendChild(_hoverCardEl);
  return _hoverCardEl;
}

function positionHoverCard(el, anchorEl) {
  const a = anchorEl.getBoundingClientRect();
  // Degenerate rect (0,0,0,0) = the anchor was detached by a re-render between
  // arming and showing — don't paint the card at the top-left corner; hide it.
  if (a.width === 0 && a.height === 0 && a.top === 0 && a.left === 0) { hideHoverCard(); return; }
  // The card carries a `zoom` (Popups scale). getBoundingClientRect returns its
  // POST-zoom size (correct for clamping against the viewport), but left/top we
  // set are in the card's own zoomed coord system — divide by the zoom so the
  // painted position lands at the intended viewport pixel.
  const z = parseFloat(getComputedStyle(el).zoom) || 1;
  const r = el.getBoundingClientRect();
  const cw = r.width || el.offsetWidth, ch = r.height || el.offsetHeight;
  const M = 8;
  let x = a.right + M;
  if (x + cw > window.innerWidth - M) x = a.left - cw - M;      // flip to the left
  x = Math.max(M, Math.min(x, window.innerWidth  - cw - M));
  let y = Math.max(M, Math.min(a.top, window.innerHeight - ch - M));
  el.style.left = `${x / z}px`;
  el.style.top  = `${y / z}px`;
}

async function showHoverCard(item, anchorEl, { footerHTML = "" } = {}) {
  // Anchor already gone (a re-render replaced the tile) → nothing to anchor to.
  if (!anchorEl?.isConnected) return;
  const el = ensureHoverCardEl();
  const token = ++_hoverToken;
  await renderItemCardInto(el, item);
  if (token !== _hoverToken) return;   // a newer hover superseded us mid-render
  if (!anchorEl.isConnected) { hideHoverCard(); return; }   // tile removed during the async render
  // Caller-supplied footer (the merchant shop appends its appraised fair price
  // here). Rendered INSIDE the card, below the item body, so it moves with it.
  if (footerHTML) el.insertAdjacentHTML("beforeend", footerHTML);
  el.style.display = "";
  positionHoverCard(el, anchorEl);
}

function hideHoverCard() {
  _hoverToken++;   // invalidate any in-flight render
  if (_hoverCardEl) { _hoverCardEl.style.display = "none"; _hoverCardEl.innerHTML = ""; }
}

/* Public hover-card API for other windows that want the SAME item card the
 * inventory grid shows (currently the merchant shop grid). One card element is
 * shared across all callers — only one can ever be visible at a time, which is
 * what we want: moving from a shop tile to an inventory tile swaps the card
 * rather than stacking two.
 *
 * `footerHTML` is appended inside the card, below the item body — the shop uses
 * it for the appraised fair-price line. */
export async function showItemHoverCard(item, anchorEl, opts = {}) {
  return showHoverCard(item, anchorEl, opts);
}
export function hideItemHoverCard() {
  hideHoverCard();
}

/* Full teardown: hide the card AND cancel any pending (armed) hover timer.
 * Needed when the inventory closes — otherwise a hover armed while dropping into
 * a bag fires its delayed showHoverCard AFTER the panel is gone, leaving a
 * stray card floating over the screen. */
function cancelHoverCard() {
  clearTimeout(_hoverTimer);
  _hoverTimer = null;
  _hoverArmedId = null;
  hideHoverCard();
}

/** Single-select highlight (the W3 selection frame + drag anchor). Selection is
 *  mutually exclusive across the grid and any open popup. */
function selectTile(slot) {
  if (!slot || !slot.dataset.itemId) return;   // ignore empty filler cells
  document.querySelectorAll(".wou-slot.is-selected").forEach(s => s.classList.remove("is-selected"));
  slot.classList.add("is-selected");
  markSeen(slot.dataset.itemId);
}

/* Freshly-acquired items glow until first seen (hovered or clicked). Session-
 * level — a reload clears the glows (you've had a look). */
const _unseenIds = new Set();
function markSeen(id) {
  if (!id || !_unseenIds.has(id)) return;
  _unseenIds.delete(id);
  // Remove the glow immediately wherever the tile is shown (no full re-render).
  invEl?.querySelectorAll(`.wou-slot[data-item-id="${CSS.escape(id)}"].is-new`)
       .forEach(el => el.classList.remove("is-new"));
}

/* Our listeners are document-level (they have to be — the container and mount
 * popups are body-appended, outside #wou-inventory). But `.wou-slot` is no
 * longer ours alone: the merchant shop grid renders real .wou-slot tiles so it
 * inherits the inventory's tile look, and it raises its own hover card with an
 * extra price footer. Without this guard both handlers would arm on the same
 * shop tile and race over the SHARED card element — this one resolving the id
 * against the wrong actor and hiding what the shop just painted.
 *
 * So: only claim tiles on our own surfaces. */
const OWN_TILE_ROOTS = "#wou-inventory, #wou-floating-container";
function ownTile(ev) {
  const slot = ev.target?.closest?.(".wou-slot[data-item-id], .wou-equip[data-item-id]");
  return slot?.closest(OWN_TILE_ROOTS) ? slot : null;
}

/** Delegated, document-level so it covers grid tiles AND the body-appended
 *  container/mount popups. A tile must be hovered for HOVER_DELAY_MS before its
 *  card appears; leaving the tile, dragging, or scrolling cancels/hides it. */
function wireHoverCard() {
  document.addEventListener("mouseover", (ev) => {
    if (_dragActive) return;   // dragging / just-dropped → don't arm a hover card
    const slot = ownTile(ev);
    const id = slot?.dataset?.itemId;
    if (!id || id === _hoverArmedId) return;
    markSeen(id);   // hovering clears the new-item glow immediately (not after the delay)
    _hoverArmedId = id;
    clearTimeout(_hoverTimer);
    hideHoverCard();
    _hoverTimer = setTimeout(() => {
      const item = resolveTileItem(id);
      if (!item) return;
      // No hover card when this item's own window is already open: its floating
      // container popup, or its item sheet (opened via double-click).
      if (item.type === "container" && openContainerPopupId === item.id) return;
      if (item.sheet?.rendered) return;
      showHoverCard(item, slot);
    }, HOVER_DELAY_MS);
  });
  document.addEventListener("mouseout", (ev) => {
    const slot = ownTile(ev);
    if (!slot || slot.contains(ev.relatedTarget)) return;   // still inside the tile
    if (slot.dataset.itemId === _hoverArmedId) {
      clearTimeout(_hoverTimer);
      _hoverArmedId = null;
      hideHoverCard();
    }
  });
  const cancel = () => { clearTimeout(_hoverTimer); _hoverArmedId = null; hideHoverCard(); };
  document.addEventListener("dragstart", () => { _dragActive = true; cancel(); }, true);
  /* Re-enable hovering only when the user genuinely MOVES the cursor again after
   * a drop — the DOM-replacement fires a synthetic mouseover under the stationary
   * cursor that must NOT arm the timer. A real mousemove means intentional hover. */
  document.addEventListener("dragend", () => {
    document.addEventListener("mousemove", () => { _dragActive = false; }, { once: true, capture: true });
  }, true);
  document.addEventListener("scroll", cancel, true);
}

/* =========================================================================
   QUALITY TAGS  —  parse the item description for weapon/armor/enhancement
   qualities, look them up in the homebrew "Weapon and Armor Qualities"
   journal, and render them as hover-tooltipped tags next to the item name.
   Mirrors witcher-inventory-qol's logic so the lookup hits the same source.
   ========================================================================= */

const QUALITIES_JOURNAL_NAME    = "Weapon and Armor Qualities";
/* Empty by default. The open-category quality config dialog renders
 * descriptions inline; this journal lookup is just the legacy hover-popup
 * fallback. Set to a pack id like "world.<my-pack>" if you ship one. */
const QUALITIES_COMPENDIUM_PACK = "";
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

/* EO un-equip gate: refuse to unequip the LAST worn arming-jack-class
 * armor piece while the actor still has any Difficult piece equipped.
 * Symmetric to the equip gate in splitOneAndEquip — that gate stops you
 * donning Difficult armor without a jack; this one stops you stripping
 * the jack while Difficult is still on (which would leave you "naked
 * Difficult", a state EO p.4 doesn't allow). Only fires under the CE
 * eoArmorModel toggle. */
Hooks.on?.("preUpdateItem", (item, change, _options, userId) => {
  try {
    if (userId !== game.user?.id) return;
    if (item?.type !== "armor") return;
    const goingOff = change?.system && Object.prototype.hasOwnProperty.call(change.system, "equipped")
                  && change.system.equipped === false;
    if (!goingOff) return;
    const actor = item.parent;
    if (!actor?.items) return;
    /* Lazy-load — keep this hook module loadable in tests without
     * pulling in the mechanics chain. */
    const eo = globalThis.WITCHER_EO ?? null;
    const isJackLocal  = (a) => {
      const k = String(a?.system?.armingJackKind ?? "none");
      const u = String(a?.system?.armoredArmingJackUpgrade ?? "none");
      return k === "jack" || k === "superiorSuit" || u === "jack" || u === "superiorSuit";
    };
    if (!isJackLocal(item)) return;
    /* Only enforce when the toggle is on. The CE_SUBSYSTEM helper isn't
     * accessible here without an import; do the read inline. */
    let on = false;
    try {
      const sub = game.settings?.get?.("witcher-ttrpg-death-march", "combatExtendedSubsystems") ?? {};
      const masterRaw = game.settings?.get?.("witcher-ttrpg-death-march", "homebrew.extendedCombat");
      const master = masterRaw === true || masterRaw === "true" || masterRaw === 1;
      const sysOn  = sub.eoArmorModel === undefined ? true : !!sub.eoArmorModel;
      on = master && sysOn;
    } catch (_) { /* settings unavailable — fail closed (don't block) */ }
    if (!on) return;
    const worn = (actor.items?.contents ?? actor.items ?? [])
      .filter(i => i.type === "armor" && i.system?.equipped
                && i.system?.location !== "Shield" && i.system?.armorType !== "shield");
    /* Either the canonical boolean OR the `difficult` chip in the
     * qualities array marks a piece as Difficult — keep the un-equip
     * gate consistent with isDifficultArmor in mechanics/eoArmorModel. */
    const hasDifficult = worn.some(p => {
        if (p.system?.difficult) return true;
        const qs = p.system?.effective?.qualities ?? p.system?.qualities ?? [];
        return Array.isArray(qs) && qs.includes("difficult");
    });
    if (!hasDifficult) return;
    /* Count OTHER worn jacks — the piece being unequipped is still in `worn`
     * because the change hasn't applied yet. */
    const otherJacks = worn.filter(p => p !== item && isJackLocal(p));
    if (otherJacks.length === 0) {
      ui?.notifications?.warn?.(
        `Can't remove ${item.name} — you're still wearing Difficult armor that needs an arming jack. Take off the Difficult piece first.`
      );
      /* Veto the change: deleting equipped from the change object keeps
       * the rest of the update (any other fields the caller wanted to
       * change land); returning false would cancel the whole update,
       * which is more aggressive than we need. */
      delete change.system.equipped;
    }
  } catch (err) {
    console.warn("witcher-ttrpg-death-march | EO un-equip gate failed", err);
  }
});

/* EO equip gate (symmetric to the un-equip gate above): refuse to
 * equip a Difficult armor piece unless the actor is wearing at least
 * one arming jack OR superior arming suit. Covers every path that
 * isn't the chrome's `splitOneAndEquip` (macros, system item-sheet
 * checkbox, compendium drag-drop, Item.create with equipped:true,
 * REST API calls). The chrome's own equip checks already reject
 * before this hook fires; this is the catch-all.
 *
 * Only fires when the EO armor model toggle is on. */
Hooks.on?.("preUpdateItem", (item, change, _options, userId) => {
  try {
    if (userId !== game.user?.id) return;
    if (item?.type !== "armor") return;
    const goingOn = change?.system && Object.prototype.hasOwnProperty.call(change.system, "equipped")
                 && change.system.equipped === true;
    if (!goingOn) return;
    const actor = item.parent;
    if (!actor?.items) return;
    /* Same dual-read as isDifficultArmor — boolean OR chip. */
    const isDifficult = (a) => {
      if (a?.system?.difficult) return true;
      const qs = a?.system?.effective?.qualities ?? a?.system?.qualities ?? [];
      return Array.isArray(qs) && qs.includes("difficult");
    };
    if (!isDifficult(item)) return;
    /* CE master + EO subsystem must both be on, same as the un-equip gate. */
    let on = false;
    try {
      const sub = game.settings?.get?.("witcher-ttrpg-death-march", "combatExtendedSubsystems") ?? {};
      const masterRaw = game.settings?.get?.("witcher-ttrpg-death-march", "homebrew.extendedCombat");
      const master = masterRaw === true || masterRaw === "true" || masterRaw === 1;
      const sysOn  = sub.eoArmorModel === undefined ? true : !!sub.eoArmorModel;
      on = master && sysOn;
    } catch (_) { /* fail open */ }
    if (!on) return;
    const isJack = (a) => {
      const k = String(a?.system?.armingJackKind ?? "none");
      const u = String(a?.system?.armoredArmingJackUpgrade ?? "none");
      return k === "jack" || k === "superiorSuit" || u === "jack" || u === "superiorSuit";
    };
    const worn = (actor.items?.contents ?? actor.items ?? [])
      .filter(i => i.type === "armor" && i.system?.equipped && i !== item);
    const hasJack = worn.some(isJack);
    if (!hasJack) {
      ui?.notifications?.warn?.(
        tFormat("WITCHER.Chrome.Inventory.Notify.DifficultArmorNeedsJack", { name: item.name }, `Can't equip ${item.name} — Difficult armor requires an Arming Jack worn underneath. Equip a jack first.`)
      );
      /* Veto only the equipped flip; let the rest of the update through. */
      delete change.system.equipped;
    }
  } catch (err) {
    console.warn("witcher-ttrpg-death-march | EO equip gate failed", err);
  }
});

/* Same catch-all for items being CREATED on an actor with `equipped:true`
 * — Item.create / compendium drag / macros. Mirrors the equip-gate
 * decision above; on a violation, force equipped=false so the item still
 * lands (the user can deal with it) but isn't worn. */
Hooks.on?.("preCreateItem", (item, createData, _options, userId) => {
  try {
    if (userId !== game.user?.id) return;
    if (item?.type !== "armor") return;
    const willEquip = createData?.system?.equipped === true;
    if (!willEquip) return;
    const actor = item.parent;
    if (!actor?.items) return;
    const isDifficult = createData?.system?.difficult
      || (Array.isArray(createData?.system?.qualities) && createData.system.qualities.includes("difficult"));
    if (!isDifficult) return;
    let on = false;
    try {
      const sub = game.settings?.get?.("witcher-ttrpg-death-march", "combatExtendedSubsystems") ?? {};
      const masterRaw = game.settings?.get?.("witcher-ttrpg-death-march", "homebrew.extendedCombat");
      const master = masterRaw === true || masterRaw === "true" || masterRaw === 1;
      const sysOn  = sub.eoArmorModel === undefined ? true : !!sub.eoArmorModel;
      on = master && sysOn;
    } catch (_) { /* fail open */ }
    if (!on) return;
    const isJack = (a) => {
      const k = String(a?.system?.armingJackKind ?? "none");
      const u = String(a?.system?.armoredArmingJackUpgrade ?? "none");
      return k === "jack" || k === "superiorSuit" || u === "jack" || u === "superiorSuit";
    };
    const worn = (actor.items?.contents ?? actor.items ?? [])
      .filter(i => i.type === "armor" && i.system?.equipped);
    const hasJack = worn.some(isJack);
    if (!hasJack) {
      ui?.notifications?.warn?.(
        tFormat("WITCHER.Chrome.Inventory.Notify.CantAutoEquipDifficult", { name: item.name }, `${item.name} can't auto-equip — Difficult armor requires an Arming Jack worn underneath.`)
      );
      item.updateSource({ "system.equipped": false });
    }
  } catch (err) {
    console.warn("witcher-ttrpg-death-march | EO preCreate equip gate failed", err);
  }
});

/* Pickup action gate — refuse the "world item → my inventory" create
 * when the actor is in combat and has no free action slot.
 *
 * Two existing paths already refuse in this case (chrome inventory drop
 * at tryForeignItemDrop L4745, base actor sheet drop at base.mjs L153),
 * but Foundry's core canvas drop-on-token flow (Token._onDropData)
 * calls `actor.createEmbeddedDocuments("Item", …)` directly with no
 * chrome-side gate. Without this hook the item lands in the actor's
 * inventory anyway even though they had no action to spend picking it
 * up — the world item bar row is only deleted when a pickup succeeds,
 * so returning false here keeps the world item visible AND keeps the
 * actor's inventory clean.
 *
 * Refuse conditions:
 *   1. User-initiated (userId === current user, not GM).
 *   2. Item is being created on an actor (has parent + parent.items).
 *   3. Actor is in ACTIVE combat.
 *   4. Actor has no free action slot.
 *   5. Item type is a physical pickup — skips profession/perk/race/
 *      homeland/spell/hex/ritual (learned/character-build items, not
 *      "picked up off the ground"). Same non-pickup list base.mjs L149. */
Hooks.on?.("preCreateItem", (item, _createData, _options, userId) => {
  try {
    if (userId !== game.user?.id) return;
    if (game.user?.isGM) return;                    /* GM adds bypass the gate */
    const actor = item?.parent;
    if (!actor?.items) return;                      /* world-level create — not a pickup */
    const NON_PICKUP = new Set(["profession", "perk", "race", "homeland", "spell", "hex", "ritual"]);
    if (NON_PICKUP.has(item.type)) return;
    if (!isActorInActiveCombat(actor)) return;
    if (actor.hasActionSlot) return;
    /* canSpendCombatAction returns false AND surfaces the "No actions
     * left this turn" toast — reuse it so the user sees the same
     * warning every other refused-pickup path shows. */
    canSpendCombatAction(actor);
    return false;
  } catch (err) {
    console.warn(`${MODULE_ID} | pickup-action-gate preCreateItem failed`, err);
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

/** Append an "Applied Oil" panel to the inspection view for any weapon OR
 *  ammo with an active oil coating. Shows the oil's icon + name, the
 *  remaining time + a depleting bar, the effect description, and a Cleanse
 *  button that wipes the coating.
 *
 *  Ammo cleanse leaves the arrow/bolt itself in inventory (uncoated); it
 *  doesn't try to auto-merge the now-plain 1-qty stack back into the
 *  master plain stack — Foundry's default stacking doesn't reunite manually
 *  split documents, and the player can drop the extra stack manually if
 *  they care. */
function appendAppliedOilSection(panel, item) {
  if (item.type !== "weapon" && item.type !== "ammo") return;
  const oil = readOilCoating(item);
  if (!oil) return;
  const { total, remaining, label } = describeDuration(oil.dur ?? {});
  const timed = total > 0;
  const pct   = timed ? Math.max(0, Math.min(100, Math.round((remaining / total) * 100))) : 100;
  /* Chip: timed coatings show the remaining duration label ("12 min", "3 r"),
   * Reborn charge coatings show `oil.dur.label` ("5/10 charges"), "until
   * cleansed" coatings get a blank chip. */
  const chip  = timed ? label : (oil.dur?.label || "");
  const body = panel.querySelector(".wou-inspection-body");
  if (!body) return;
  /* DISPLAY only — the card is a passive hover popup (pointer-events:none), so
   * cleansing lives on the right-click menu (registerCleanseOilActions) now. */
  body.insertAdjacentHTML("beforeend", `
    <div class="wou-applied-oil">
      <div class="wou-applied-oil-header">
        <img src="${escapeAttr(oil.img)}" class="wou-applied-oil-img" alt="" />
        <div class="wou-applied-oil-meta">
          <div class="wou-applied-oil-label">${t("WITCHER.Chrome.Inventory.Text.AppliedOil", "Applied Oil")}</div>
          <div class="wou-applied-oil-name">${escapeText(oil.name)}</div>
        </div>
        <div class="wou-applied-oil-charges">${escapeText(chip)}</div>
      </div>
      <div class="wou-applied-oil-bar"><div class="fill" style="width:${pct}%"></div></div>
      ${oil.effect ? `<div class="wou-applied-oil-effect">${escapeText(oil.effect)}</div>` : ""}
    </div>
  `);
}

/** World-time tick: patch the oil-coating countdown labels in place —
 *  inspect panel's Applied-Oil chip + the equip droplet's hover state —
 *  leaving the rest of the inventory DOM (and its scroll/hover state) alone.
 *  Applied / expired / cleansed coatings are structural and rebuild via the
 *  appliedOil create/delete hooks instead.
 *
 *  Chip text mirrors readOilCoating / appendAppliedOilSection: timed
 *  coatings show their duration label, Reborn charge coatings show
 *  `oil.dur.label` ("5/10 charges"), "until cleansed" coatings show
 *  blank. The old `"active"` literal is gone — it's the chip's job to
 *  show DATA, and the "active" word is already implied by the section's
 *  "Applied Oil" header. */
function tickOilLabels() {
  if (!invEl || !isInventoryOpen()) return;
  const actor = getPanelActor("inventory");
  if (!actor) return;
  for (const it of actor.items) {
    if (it.type !== "weapon") continue;
    const coat = readOilCoating(it);
    if (!coat) continue;
    const { total, remaining, label } = describeDuration(coat.dur ?? {});
    const timed = total > 0;
    const chip  = timed ? (label || "") : (coat.dur?.label || "");
    const sel   = `[data-item-id="${CSS.escape(it.id)}"]`;

    /* The equip droplet badge no longer carries an inline label (we
     * dropped the "∞" / minutes pair in favour of just the dollop —
     * the hover tooltip carries the full detail). Any legacy span that
     * survived a hot-reload gets cleared so it doesn't render stale text. */
    for (const span of invEl.querySelectorAll(`${sel} .oil-badge .oil-badge-label`)) {
      if (span.textContent !== "") span.textContent = "";
    }

    /* Inspect panel Applied-Oil block (scoped by the cleanse button's id). */
    const block = invEl.querySelector(`.wou-applied-oil [data-action="cleanse-oil"]${sel}`)
                       ?.closest(".wou-applied-oil");
    if (block) {
      const charges = block.querySelector(".wou-applied-oil-charges");
      if (charges && charges.textContent !== chip) charges.textContent = chip;
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

  /* Damage-property fields are spread top-level onto system (see
   * damagePropertiesSchema) — there is no nested `system.damageProperties`
   * object, so read them off `sys` directly. (The old `sys.damageProperties`
   * was always undefined, which silently hid every chip below — incl. the
   * silver-trait indicator.) */
  const dp = sys;
  const tags = [];

  tags.push(`<span class="item-tag" data-tooltip="${t("WITCHER.Chrome.Inventory.Text.Damage", "Damage")}"><i class="fa-solid fa-burst"></i>${escapeText(damage)}</span>`);

  /* Silver-damage chip belongs to the legacy silver-quality mechanic —
   * hide it when the new-rules house-toggle is on (the trait replaces it). */
  const newSilverOn = hrNewSilverRules();
  const silverDmg = String(dp.silverDamage ?? "").trim();
  if (silverDmg && !newSilverOn) {
    tags.push(`<span class="item-tag" data-tooltip="${t("WITCHER.Chrome.Inventory.Text.SilverDamage", "Silver damage")}"><i class="fa-solid fa-moon"></i>${escapeText(silverDmg)}</span>`);
  }

  const rel = Number(sys.reliable);
  const maxRel = Number(sys.maxReliability);
  if (Number.isFinite(maxRel) && maxRel > 0) {
    tags.push(`<span class="item-tag" data-tooltip="${t("WITCHER.Chrome.Inventory.Text.Reliability", "Reliability")}"><i class="fa-solid fa-shield-halved"></i>${rel}/${maxRel}</span>`);
  }

  /* Damage-property mini-icons — one tag per active property.  Tooltip
   * carries the meaning; the icon itself is the only visible content so
   * the row stays compact. */
  const props = [
    [dp.armorPiercing,         "fa-solid fa-arrow-up-right-from-square", t("WITCHER.Chrome.Inventory.Prop.ArmorPiercing",         "Armor piercing")],
    [dp.improvedArmorPiercing, "fa-solid fa-angles-up",                  t("WITCHER.Chrome.Inventory.Prop.ImprovedArmorPiercing", "Improved armor piercing")],
    [dp.bypassesWornArmor,     "fa-solid fa-shirt",                      t("WITCHER.Chrome.Inventory.Prop.BypassesWornArmor",     "Bypasses worn armor")],
    [dp.bypassesNaturalArmor,  "fa-solid fa-paw",                        t("WITCHER.Chrome.Inventory.Prop.BypassesNaturalArmor",  "Bypasses natural armor")],
    [dp.ablating,              "fa-solid fa-hammer",                     t("WITCHER.Chrome.Inventory.Prop.Ablating",              "Ablating")],
    [dp.crushingForce,         "fa-solid fa-weight-scale",               t("WITCHER.Chrome.Inventory.Prop.CrushingForce",         "Crushing force")],
    [dp.isNonLethal,           "fa-solid fa-heart-pulse",                t("WITCHER.Chrome.Inventory.Prop.NonLethal",             "Non-lethal")],
    [dp.damageToAllLocations,  "fa-solid fa-explosion",                  t("WITCHER.Chrome.Inventory.Prop.DamageToAllLocations",  "Damage to all locations")],
    /* Silver-trait chip only rendered when the new rules are active. */
    [dp.silverTrait && newSilverOn, "fa-solid fa-moon",                  t("WITCHER.Chrome.Inventory.Prop.SilverTrait",           "Silver trait")],
    [dp.isMeteorite,           "fa-solid fa-meteor",                     t("WITCHER.Chrome.Inventory.Prop.Meteorite",             "Meteorite")],
  ];
  for (const [on, icon, tip] of props) {
    if (on) tags.push(`<span class="item-tag" data-tooltip="${escapeAttr(tip)}"><i class="${icon}"></i></span>`);
  }

  const cost = Number(sys.cost ?? 0);
  tags.push(`<span class="item-tag" data-tooltip="${t("WITCHER.Chrome.Inventory.Text.Cost", "Cost")}"><i class="fa-solid fa-coins"></i>${cost}</span>`);

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
    `<span class="item-tag" data-tooltip="${t("WITCHER.Chrome.Inventory.Text.SubstanceType", "Substance Type")}"><i class="fa-solid fa-droplet"></i>${escapeText(capitalize(sub))}</span>`
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
    `<span class="item-tag" data-tooltip="${t("WITCHER.Chrome.Inventory.Text.Potency", "Potency")}"><i class="fa-solid fa-bolt"></i>${potency}</span>`
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
  // Mount popup can't stand open if the mount was unlinked.
  if (mountPopupOpen && !getMountActor(actor)) {
    mountPopupOpen = false;
  }

  return `
    <button id="wou-inv-close" type="button" aria-label="${t("WITCHER.Chrome.Inventory.Text.CloseInventory", "Close inventory")}" title="${t("WITCHER.Chrome.Inventory.Text.Close", "Close")}">
      <i class="fa-solid fa-chevron-up"></i>
    </button>

    <div class="wou-inv-header">
      <div class="wou-inv-title">${t("WITCHER.Chrome.Inventory.Text.Inventory", "Inventory")}</div>
      ${game.user?.isGM ? `<div class="wou-viewtools">${renderViewPanelAsPicker("inventory")}${renderViewAsPicker()}</div>` : ""}
    </div>

    <section class="wou-inv-left">
      ${renderTabsHTML(actor)}
      ${renderCategoryHTML(actor, gridItems)}
    </section>

    <section class="wou-inv-containers-col">
      ${renderContainersGridHTML(actor, gridItems)}
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
        label: t("WITCHER.Chrome.Inventory.Dialog.Button.Empty", "Empty"),
        kind: "empty",
        ownerActorId: actor.id,
        ownerKind,
        slotIdx: i,
      };
      continue;
    }
    const c = actor.items.get(id);
    if (!c) {
      out[i] = { id: null, label: t("WITCHER.Chrome.Inventory.Dialog.Button.Empty", "Empty"), kind: "empty", ownerActorId: actor.id, ownerKind, slotIdx: i };
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
    /* data-item-id lets the broken-weapon decorator find these clips
     * (it scans [data-item-id] universally). Without this, a broken
     * weapon inside a container would NEVER show as broken on the
     * container's weapon-clip overlay. */
    return `<span class="wou-cw-clip" data-item-id="${escapeAttr(wpn.id)}"${rarAttr} title="${escapeAttr(wpn.name)}">${art}</span>`;
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
/* Lazy so t() resolves after Foundry lang is loaded. */
function combatRailTooltip() {
  const oneAction = t("WITCHER.Chrome.Inventory.CombatRail.OneAction", "1 Action");
  return '<div class="wcu-tip">' +
    `<strong>${t("WITCHER.Chrome.Inventory.CombatRail.Title", "Combat: Handling Gear")}</strong>` +
    t("WITCHER.Chrome.Inventory.CombatRail.Intro", "In combat you can only reach gear stowed in a bag equipped on this rail. Each hands-on action spends one action (normal first, then extra):") +
    `<div class="wcu-tip-row"><span>${t("WITCHER.Chrome.Inventory.CombatRail.RowDraw",     "Draw or sheathe a weapon")}</span><span>${oneAction}</span></div>` +
    `<div class="wcu-tip-row"><span>${t("WITCHER.Chrome.Inventory.CombatRail.RowSwitch",   "Switch a weapon between hands")}</span><span>${oneAction}</span></div>` +
    `<div class="wcu-tip-row"><span>${t("WITCHER.Chrome.Inventory.CombatRail.RowDrink",    "Drink or use a consumable")}</span><span>${oneAction}</span></div>` +
    `<div class="wcu-tip-row"><span>${t("WITCHER.Chrome.Inventory.CombatRail.RowShuffle",  "Shuffle an item into or out of a bag")}</span><span>${oneAction}</span></div>` +
    `<div class="wcu-tip-row"><span>${t("WITCHER.Chrome.Inventory.CombatRail.RowPickUp",   "Pick an item up off the ground")}</span><span>${oneAction}</span></div>` +
    `<div class="wcu-tip-row"><span><i class="fa-solid fa-bolt"></i> ${t("WITCHER.Chrome.Inventory.CombatRail.RowQuickDraw", "Quick-Draw slot (weapons)")}</span><span>${t("WITCHER.Chrome.Inventory.CombatRail.FastDraw", "Fast-Draw")}</span></div>` +
    `<div class="wcu-tip-row"><span><i class="fa-solid fa-hand"></i> ${t("WITCHER.Chrome.Inventory.CombatRail.RowFreeUse", "Free-Use slot")}</span><span>${t("WITCHER.Chrome.Inventory.CombatRail.NoAction", "No Action")}</span></div>` +
    `<div class="wcu-tip-flavor">${t("WITCHER.Chrome.Inventory.CombatRail.BehaviorFlavor", "A weapon in a Quick-Draw slot can be Fast-Drawn (+3 initiative, −3 to hit, must attack that turn). Anything in a Free-Use slot is drawn / drunk / eaten / consumed with No Action.")}</div>` +
    `<div class="wcu-tip-flavor">${t("WITCHER.Chrome.Inventory.CombatRail.Flavor", "Loose gear can't be equipped mid-combat — draw it from a bag first. Out of combat, all of this is free.")}</div>` +
  '</div>';
}

/** Container carry-limit indicator for the rail (house rule only). Shows
 *  equipped-vs-free and the EV penalty when over the 1 + ⌈BODY/3⌉ limit. */
function containerEvIndicatorHTML(character) {
  if (!hrContainerEquipEV() || !character) return "";
  // Metric is the equipped containers' total EMPTY WEIGHT (system.weight — the
  // "Empty Weight" field), not their count — matches the EV mechanic in
  // character.mjs.
  const equipped = Math.round((character.items ?? [])
    .filter(i => i.type === "container" && i.system?.equipped)
    .reduce((sum, c) => sum + (Number(c.system?.weight) || 0) * (Number(c.system?.quantity) || 1), 0) * 10) / 10;
  const limit = containerEquipLimit(character.system?.stats?.body?.value);
  const over  = Math.round(Math.max(0, equipped - limit) * 10) / 10;
  // EV penalty is a whole number, rounding any fractional overload UP.
  const ev    = Math.ceil(over);
  const tip = over > 0
    ? tFormat("WITCHER.Chrome.Inventory.Tip.ContainerEvOver",
        { equipped, limit, over, ev },
        `Container carry limit — ${equipped} ENC of containers, limit ${limit} (1 + ⌈BODY ÷ 3⌉). ${over} over → +${ev} EV (penalizes REF / DEX & magic rolls).`)
    : tFormat("WITCHER.Chrome.Inventory.Tip.ContainerEvOk",
        { equipped, limit },
        `Container carry limit — ${equipped} / ${limit} container ENC (up to 1 + ⌈BODY ÷ 3⌉ carried free).`);
  const overStyle = over > 0 ? "color:#e08a6a;font-weight:700;opacity:1;" : "opacity:0.75;";
  return `<div class="wou-container-ev" data-tooltip="${escapeAttr(tip)}" data-tooltip-direction="UP" style="display:inline-flex;align-self:center;align-items:center;justify-content:center;gap:3px;font-size:0.72em;padding:1px 4px;${overStyle}">
    <i class="fa-solid fa-weight-hanging"></i>${equipped}/${limit}${over > 0 ? ` <span>+${ev} EV</span>` : ""}
  </div>`;
}

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
          <button type="button" data-action="add"    title="${t("WITCHER.Chrome.Inventory.Text.AddEquipSlot", "Add equip slot")}">+</button>
          <button type="button" data-action="remove" title="${t("WITCHER.Chrome.Inventory.Text.RemoveLastEmptySlot", "Remove last empty slot")}">−</button>
        </div>
        <div class="wou-containers-track" data-track="containers" data-rail-owner="${escapeAttr(character?.id ?? "")}">
          ${own.map(railSlotHTML).join("")}
        </div>
        ${containerEvIndicatorHTML(character)}
        <div class="wou-containers-help" data-tooltip="${escapeAttr(combatRailTooltip())}" data-tooltip-direction="UP" data-tooltip-class="wou-craft-tip">
          <i class="fa-solid fa-circle-info"></i> ${t("WITCHER.Chrome.Inventory.Text.HandlingGear", "Handling Gear")}
        </div>
      </div>
      ${mount ? `
      <div class="wou-containers-stack wou-containers-mount">
        <div class="wou-containers-mount-label" title="${escapeAttr(tFormat("WITCHER.Chrome.Inventory.Text.MountContainers", { name: mount.name }, `${mount.name}'s containers`))}">
          <i class="fa-solid fa-horse"></i>
        </div>
        <div class="wou-containers-track" data-track="containers" data-rail-owner="${escapeAttr(mount.id)}">
          ${ext.length ? ext.map(railSlotHTML).join("") : `<div class="wou-rail-empty-hint">${t("WITCHER.Chrome.Inventory.Text.NoBags", "No bags")}</div>`}
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
    return `<div class="${cls}"${ownerAttr}${slotAttr} title="${t("WITCHER.Chrome.Inventory.Text.DropAContainerHereToEquip", "Drop a container here to equip")}">
      <i class="icon fa-solid fa-box"></i>
    </div>`;
  }

  const isOpen = openContainerPopupId === c.id
              && (openContainerActorId ?? getPanelActor("inventory")?.id) === c.ownerActorId;
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
    // Hybrid containers take the full 5-column width so the loose-space grid
    // below wraps normally (like a loose-only container) instead of being
    // squeezed to the compartment count. Slots-only containers stay compact.
    const cols  = (getContainerCfg(container).capacityMode === "hybrid")
      ? 5
      : Math.min(5, Math.max(1, Math.ceil(Math.sqrt(totalSlots(container)))));
    body = `<div class="wou-popup-grid is-slots" style="grid-template-columns: repeat(${cols}, 50px)">${tiles.map(slotTileHTML).join("")}</div>`;
  } else {
    body = items.length === 0
      ? `<div class="wou-empty-state">${t("WITCHER.Chrome.Inventory.Text.EmptySlot", "— Empty —")}</div>`
      : `<div class="wou-popup-grid">${items.map(slotRenderer).join("")}</div>`;
  }
  const popupCls = ["wou-container-popup", isMount ? "is-mount" : ""].filter(Boolean).join(" ");
  return `
    <div class="${popupCls}" data-popup-container-id="${escapeAttr(container.id)}"${isMount ? ` data-owner-actor-id="${escapeAttr(openContainerActorId)}"` : ""}>
      <div class="wou-popup-header">
        <span class="wou-popup-title">${escapeText(container.name)}</span>
        ${weightHTML}
        <button type="button" class="wou-popup-close" aria-label="${t("WITCHER.Chrome.Inventory.Text.CloseContainer", "Close container")}">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
      ${containerCapacityBarHTML(cap)}
      <div class="wou-popup-body">${body}</div>
      ${slotBehaviorLegendHTML(container)}
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
  // Reads via substanceElementOf so mutagens with a substance pick up the
  // overlay too (Alchemy Reborn — mutagens act as ingredient picks).
  const element = substanceElementOf(item);
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
 *  remains (first-class `remains` item type). Everything else a character
 *  tries to load onto the mount is refused. */
function mountAcceptsItem(item) {
  if (!item) return false;
  if (item.type === "container") return true;
  return item.type === "remains";
}

/** The item currently under the cursor mid-drag, resolved from the drag
 *  globals (only items dragged from our own UI set these). Returns null for
 *  external/compendium drags, which can't be pre-validated on dragover. */
function draggedItem() {
  if (!currentDragItemId) return null;
  const a = currentDragActorId ? game.actors?.get?.(currentDragActorId) : getPanelActor("inventory");
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
    if (s.isCarried === false) continue;
    /* Stored items are aggregated by their container's calcWeight
       (data/item/container.mjs). Routing top-level items through
       calcWeight() folds each container's storedWeight into the total,
       so contents inside the mount's pack land in the enc readout. */
    if (s.isStored === true) continue;
    totalWeight += typeof s.calcWeight === "function"
      ? Number(s.calcWeight()) || 0
      : (Number(s.quantity) || 0) * (Number(s.weight) || 0);
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
    body = `<div class="wou-empty-state">${t("WITCHER.Chrome.Inventory.Text.EmptySlot", "— Empty —")}</div>`;
  } else if (containers.length === 0) {
    body = `<div class="wou-popup-grid">${loose.map(mountItemSlotHTML).join("")}</div>`;
  } else {
    const looseGrid = loose.length
      ? `<div class="wou-popup-grid">${loose.map(mountItemSlotHTML).join("")}</div>`
      : `<div class="wou-empty-state">${t("WITCHER.Chrome.Inventory.Text.NoLooseItems", "— No loose items —")}</div>`;
    body = `
      <div class="wou-popup-section-label">${t("WITCHER.Chrome.Inventory.Text.Containers", "Containers")}</div>
      <div class="wou-popup-grid">${containers.map(mountItemSlotHTML).join("")}</div>
      <div class="wou-popup-section-label">${t("WITCHER.Chrome.Inventory.Text.Loose", "Loose")}</div>
      ${looseGrid}
    `;
  }

  return `
    <div class="wou-container-popup is-mount wou-mount-popup" data-owner-actor-id="${escapeAttr(mount.id)}">
      <div class="wou-popup-header">
        <span class="wou-popup-title"><i class="fa-solid fa-horse"></i> ${escapeText(mount.name)}</span>
        ${weightHTML}
        <button type="button" class="wou-popup-close" aria-label="${t("WITCHER.Chrome.Inventory.Text.CloseMountInventory", "Close mount inventory")}">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
      <div class="wou-popup-body">${body}</div>
      <div class="wou-popup-hint"><i class="fa-solid fa-circle-info"></i> ${t("WITCHER.Chrome.Inventory.Text.CarriesOnlyRemainsAmpContainers", "Carries only remains &amp; containers")}</div>
    </div>
  `;
}


/* ---------- tabs ---------- */

function renderTabsHTML(actor) {
  const currentSort = pendingSort ?? getGlobalSort(actor);
  const invSorts = INV_SORTS();
  const currentIcon = (invSorts.find(s => s.id === currentSort) ?? invSorts[0]).icon;
  return `
    <nav class="wou-inv-tabs">
      <div class="wou-inv-tabgroup">
        ${INV_CATEGORIES().map(c => `
          <button class="wou-inv-tab wou-inv-tab--icon ${c.id === activeCategory ? "is-active" : ""}" data-tab="${c.id}" title="${c.label}" aria-label="${c.label}">
            <i class="fa-solid ${c.icon}"></i>
          </button>
        `).join("")}
      </div>
      <label class="wou-inv-sort" title="${t("WITCHER.Chrome.Inventory.Text.SortItems", "Sort items")}">
        <i class="fa-solid ${currentIcon}"></i>
        <select data-bind="sort">
          ${INV_SORTS().map(s => `<option value="${s.id}" ${s.id === currentSort ? "selected" : ""}>${s.label}</option>`).join("")}
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
    if ((i.type === "weapon" || i.type === "shield" || i.type === "armor" || i.type === "focus") && sys.equipped) return false;
    if (inContainerIds.has(i.uuid)) return false;
    if (inContainerIds.has(i.id))   return false;
    // Memorized clones (system.memorizedFrom set) are crafting-screen-only
    // shadow copies — never shown in the inventory grid.
    if (i.type === "diagrams" && i.system?.memorizedFrom) return false;
    return true;
  });

  // Keep only physical, grid-eligible items (character-only types excluded).
  // Category/sub-grid bucketing + ordering happens at render time.
  return items.filter(isPhysicalItem);
}

/** Items resolved from a container's `system.content` array. */
function resolveContainerContents(actor, container) {
  if (!actor || !container) return [];
  const content = container.system?.content ?? [];
  const byUuid = new Map(actor.items.map(i => [i.uuid, i]));
  const byId   = new Map(actor.items.map(i => [i.id,   i]));
  return content.map(ref => byUuid.get(ref) ?? byId.get(ref)).filter(Boolean);
}

/** Bucket the kept items belonging to `categoryId` into `{ subId: item[] }`.
 *  A single pass; items in other categories are skipped. */
function bucketForCategory(items, categoryId) {
  const buckets = {};
  for (const it of items) {
    const c = categorizeItem(it);
    if (!c || c.cat !== categoryId) continue;
    (buckets[c.sub] ??= []).push(it);
  }
  return buckets;
}

/** One labeled sub-grid panel: caps header + the slot lattice. Items sit at
 *  their assigned slot index; empty slots (gaps) render as inert filler cells
 *  carrying a `data-slot` so they're valid drop targets. padGridFillers tops it
 *  up with extra empty slots to fill the visible viewport. */
/** Fixed column count for a sub-grid — deterministic (NOT measured), so the
 *  slot→(row,col) map never shifts with window width. That's what keeps tall
 *  tiles from ever overlapping a 1-tile item when the panel resizes. */
function subCols(subId) {
  return SUBGRID_COLS[subId] || 5;
}

function renderSubgridHTML(subgrid, items, layout, sortKey) {
  const bySlot  = assignSlots(items, subgrid.id, layout, sortKey);
  const maxSlot = bySlot.size ? Math.max(...bySlot.keys()) : -1;
  const cols    = subCols(subgrid.id);
  let cells = "";
  for (let i = 0; i <= maxSlot; i++) {
    const it = bySlot.get(i);
    cells += it ? itemSlotHTML(it, i, null, null, null, true) : `<div class="wou-slot is-empty" data-slot="${i}"></div>`;
  }
  return `
    <section class="wou-inv-subgrid" data-subgrid="${subgrid.id}">
      <div class="wou-inv-subgrid-label">${subgrid.label}</div>
      <div class="wou-inv-subgrid-body" style="--wou-cols:${cols}">
        <div class="wou-inv-subgrid-grid" data-subgrid="${subgrid.id}" style="--wou-cols:${cols}">
          ${cells}
        </div>
      </div>
    </section>
  `;
}

/** The active category's side-by-side sub-grid panels. */
function renderCategoryHTML(actor, items) {
  const cats = INV_CATEGORIES();
  const category = cats.find(c => c.id === activeCategory) ?? cats[0];
  const buckets = bucketForCategory(items, category.id);
  const layout  = getLayout(actor);
  const sortKey = getGlobalSort(actor);
  const panels = category.subgrids
    .map(sg => renderSubgridHTML(sg, buckets[sg.id] ?? [], layout, sortKey))
    .join("");
  return `
    <div class="wou-inv-grid-wrap">
      <div class="wou-inv-categories" data-cols="${category.subgrids.length}">
        ${panels}
      </div>
    </div>
  `;
}

/** The always-open Containers grid (its own column between the item grids and
 *  the equipped-container rail). Same slot placement, sort and open behaviour
 *  as a category sub-grid. */
function renderContainersGridHTML(actor, items) {
  const layout     = getLayout(actor);
  const sortKey    = getGlobalSort(actor);
  const containers = items.filter(i => categorizeItem(i)?.cat === "containers");
  const sg = { id: "containers", label: t("WITCHER.Chrome.Inventory.Dialog.Button.Containers", "Containers") };
  return `
    <div class="wou-inv-grid-wrap wou-inv-containers-grid">
      <div class="wou-inv-categories" data-cols="1">
        ${renderSubgridHTML(sg, containers, layout, sortKey)}
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

/* Substance key for the slot's frame-color + corner-overlay. Components have
 * always carried this; under Alchemy Reborn mutagens may also carry a
 * substanceType (so they act as ingredient picks in the brew wheel) and the
 * inventory should signal that the same way as substance components. Falls
 * through to the legacy alchemy-craft flag so stock-pack mutagens authored
 * before our schema field reach the wheel via the same fallback chain the
 * brew wheel uses. */
function substanceElementOf(item) {
  const sys = item?.system;
  if (item?.type === "component" && sys?.substanceType) return String(sys.substanceType).toLowerCase();
  if (item?.type === "mutagen") {
    const sub = sys?.substanceType
             || sys?.substance
             || item.flags?.["witcher-alchemy-craft"]?.substance
             || "";
    return String(sub).toLowerCase();
  }
  return "";
}

/** Tiny glyph pinned to a slot's top-left corner that tells the player what
 *  flavor of item it is at a glance:
 *    - Book valuables (`valuable` with system.type === "book") get the book glyph
 *      because they share the Valuables tab with generic valuables.
 *    - Maps are their own item type and live under the Notes tab next to
 *      diagrams; a glyph in the Notes tab helps distinguish them from
 *      letters / recipes.
 *  Remains already carry a charge badge so no glyph there; generic valuables
 *  get no glyph. */
function valuableSubtypeCornerHTML(item) {
  if (!item) return "";
  if (item.type === "map") {
    return `<span class="wou-slot-subtype" data-subtype="map" title="${t("WITCHER.Chrome.Inventory.Text.Map", "Map")}"><i class="fa-solid fa-map"></i></span>`;
  }
  // Books — first-class type OR legacy valuable subtype (pre-migration).
  if (item.type === "book"
      || (item.type === "valuable" && item.system?.type === "book")) {
    return `<span class="wou-slot-subtype" data-subtype="book" title="${t("WITCHER.Chrome.Inventory.Text.Book", "Book")}"><i class="fa-solid fa-book"></i></span>`;
  }
  return "";
}

/** Corner badge for food items showing their freshness state: nothing if the
 *  GM didn't author a shelf life or the item hasn't been acquired, a yellow
 *  warning leaf for stale food, a red skull for spoiled. Gated on the
 *  foodAndDrink toggle so a RAW world never paints the glyph. The tooltip
 *  carries a remaining-days readout so the player can plan their pantry. */
function freshnessCornerHTML(item) {
  if (!item || item.type !== "food") return "";
  if (!isHomebrewEnabled("foodAndDrink")) return "";
  const state = getFreshnessState(item);
  if (state === "fresh" || state === "untracked") return "";
  const remaining = getFreshnessDaysRemaining(item);
  const days = remaining != null ? remaining.toFixed(1) : "";
  if (state === "stale") {
    const title = days
      ? tFormat("WITCHER.Chrome.Inventory.Tip.StaleDays", { days, plural: days === "1.0" ? "" : t("WITCHER.Chrome.Inventory.Tip.PluralS", "s") }, "Stale — about {days} day{plural} until spoiled")
      : t("WITCHER.Chrome.Inventory.Tip.StaleEatSoon", "Stale — eat soon");
    return `<span class="wou-slot-freshness is-stale" title="${title}"><i class="fa-solid fa-leaf"></i></span>`;
  }
  if (state === "spoiled") {
    return `<span class="wou-slot-freshness is-spoiled" title="${t("WITCHER.Chrome.Inventory.Text.SpoiledRiskyToEat", "Spoiled — risky to eat")}"><i class="fa-solid fa-skull"></i></span>`;
  }
  return "";
}

function itemSlotHTML(item, slot = null, slotRow = null, qtyOverride = null, slotKey = null, allowTall = false, stackMaxOverride = null) {
  const slotAttr = slot != null ? ` data-slot="${slot}"` : "";
  const slotKeyAttr = slotKey != null ? ` data-slot-key="${escapeAttr(slotKey)}"` : "";
  const sys = item.system ?? {};
  // qtyOverride lets a slot render a single UNIT of a stack (a stack of 5
  // spread across 5 slots shows one item per tile, not "5" on every tile).
  const qty = qtyOverride != null ? qtyOverride : (Number(sys.quantity) || 0);
  // Tall (2:1) tiles are OPT-IN: only the main category grid passes allowTall.
  // Container popups and loose-zone grids use square (1:1) slots, where the
  // 2:1 crop box would distort the icon — so they render normal square tiles.
  const isTall = allowTall && isTallItem(item);
  const iconHTML = item.img && !item.img.includes("mystery-man")
    // Tall tiles: wrap the <img> in a clipping .wou-tall-fit and bake the cached
    // subject crop straight into the tag so it paints at the right zoom
    // immediately (no visible resize on open). The wrapper (not the slot) does
    // the clipping so slot badges / drag indicators are unaffected.
    ? (isTall
        ? `<span class="wou-tall-fit"><img class="icon" src="${escapeAttr(item.img)}" alt="" draggable="false"${iconFitStyle(item.img)} /></span>`
        : `<img class="icon" src="${escapeAttr(item.img)}" alt="" draggable="false" />`)
    : `<i class="icon fa-solid ${fallbackIconFor(item.type)}"></i>`;
  const equipped = (item.type === "weapon" || item.type === "shield" || item.type === "armor" || item.type === "focus") && sys.equipped;
  // Per-item flair-colour override: a hex on system.flairColor replaces the
  // availability-tier wash. `has-flair` opts the tile into the gradient (see
  // inventory.css) even when its tier has none (everywhere/na); the colour
  // itself rides in on the inline --wdm-rar custom property.
  const { cls: flairCls, attr: flairAttr } = flairSlotBits(item);
  // `item` class lets Foundry's ContextMenu (selector `.item`) catch
  // right-clicks here.  `draggable="true"` enables HTML5 drag-to-equip.
  const cls = ["wou-slot", "item", equipped ? "is-active" : "", isTall ? "wou-slot--tall" : "", flairCls, _unseenIds.has(item.id) ? "is-new" : ""].filter(Boolean).join(" ");

  // Charge counters — three sources, in order of preference:
  //   1. Native food-type schema: `system.charges.{current,max}` (the new
  //      foodAndDrink homebrew). Category from `system.kind` (drink|meal|snack).
  //   2. Legacy witcher-food-and-drink module flag (pre-port data).
  //   3. (handled below) plain quantity.
  // We prefer the charge badge over plain quantity for chargeable items so
  // users can see how full a bottle / wheel / bowl is. ENTIRELY GATED on the
  // foodAndDrink toggle — a pure-RAW world should never see portion badges
  // even on items that happen to have charges configured on their schema.
  const foodAndDrinkOn = isHomebrewEnabled("foodAndDrink");
  let fdCharges = null;          // { current, max, cat }
  if (foodAndDrinkOn && item.type === "food") {
    const sc = item.system?.charges;
    if (sc && Number(sc.max) > 0) {
      fdCharges = {
        current: Number(sc.current ?? 0),
        max:     Number(sc.max),
        cat:     item.system?.kind === "drink" ? "drink" : "food"
      };
    }
  }
  if (foodAndDrinkOn && !fdCharges) {
    const wfd = item.flags?.["witcher-food-and-drink"]?.charges;
    if (wfd && Number(wfd.max) > 0) {
      fdCharges = {
        current: Number(wfd.current ?? 0),
        max:     Number(wfd.max),
        cat:     wfd.category || "drink"
      };
    }
  }
  const isCharged = !!fdCharges;
  const isRemains = item.type === "remains";
  const REMAINS_MAX = 3;
  let badgeHTML = "";
  if (isRemains) {
    const cur = item.flags?.[MODULE_ID]?.remainsCharges ?? REMAINS_MAX;
    badgeHTML = `<span class="count charges is-remains" title="${cur}/${REMAINS_MAX} charges remaining">${cur}/${REMAINS_MAX}</span>`;
  } else if (isCharged) {
    const { current, max, cat } = fdCharges;
    // Food with both partial portions AND a stack of multiple units → show
    // each value separately: the portion ticker lives in the top-right
    // corner via .count.charges, and a plain `.count` chip rides in the
    // bottom-right (same styling every other stackable item uses for its
    // quantity badge — just the number, no "×" prefix).
    const portionChip = `<span class="count charges ${cat === "food" ? "is-food" : "is-drink"}" title="${current}/${max} portions">${current}/${max}</span>`;
    const stackChip   = qty > 1 ? `<span class="count" title="${qty} in stack">${qty}</span>` : "";
    badgeHTML = portionChip + stackChip;
  } else if (Number(stackMaxOverride) > 1) {
    // Stacking container slot — show how full THIS slot's stack is, not just the
    // raw count: a stack of 2 in a slot that holds 5 reads "2/5".
    badgeHTML = `<span class="count" title="${qty} of ${stackMaxOverride} in this slot">${qty}/${stackMaxOverride}</span>`;
  } else if (qty > 1) {
    badgeHTML = `<span class="count">${qty}</span>`;
  }

  // Substance-bearing items (components + Alchemy Reborn mutagens) get a
  // data-element hook so CSS can colour the slot's frame in the substance
  // colour. Resolved via the shared helper so the legacy alchemy-craft flag
  // also feeds the overlay for stock-pack items.
  const element = substanceElementOf(item);
  const elAttr  = element ? ` data-element="${escapeAttr(element)}"` : "";

  // Rarity hook drives the slot background gradient. Every item type stores
  // this as `system.availability` (the shared availability scale: everywhere /
  // common / poor / rare / witcher / elderfolk / relic / goetia / experimental
  // / na).
  const rarity = String(sys.availability ?? "").toLowerCase();
  const rarAttr = rarity ? ` data-rarity="${escapeAttr(rarity)}"` : "";

  return `
    <div class="${cls}" draggable="true" data-item-id="${escapeAttr(item.id)}" data-item-type="${escapeAttr(item.type)}"${slotAttr}${slotKeyAttr}${elAttr}${rarAttr}${flairAttr}>
      ${iconHTML}
      ${substanceCornerHTML(element)}
      ${valuableSubtypeCornerHTML(item)}
      ${freshnessCornerHTML(item)}
      ${weaponQuickCornerHTML(item)}
      ${loadedCrossbowCornerHTML(item)}
      ${visorCornerHTML(item)}
      ${oilBadgeHTML(item)}
      ${badgeHTML}
      ${slotRow ? slotBehaviorCornerHTML(slotRow) : ""}
    </div>
  `;
}

/** Corner badge marking a weapon as a Quick item — it may occupy the
 *  off-hand / Quick slot. Shown on the inventory tile so the player sees a
 *  weapon's quick eligibility before drawing it. */
function weaponQuickCornerHTML(item) {
  if (item?.type !== "weapon" || !item.system?.quick) return "";
  return `<span class="wou-slot-quick" title="${t("WITCHER.Chrome.Inventory.Text.QuickItemCanOccupyTheOffHandQuickSlot", "Quick item — can occupy the off-hand / Quick slot")}"><i class="fa-solid fa-bolt"></i></span>`;
}

/** Corner pill marking a chambered weapon (crossbow / scorpio) that is currently
 *  LOADED, so a glance at the icon tells you it's ready to fire vs. needs a
 *  reload. Only chambered weapons show it (bows draw ammo at fire time); shows
 *  the chambered-round count when more than one. Reads the reloadMixin getters
 *  on WitcherItem (hasChamber / isLoaded), which fall through to "" safely for
 *  non-weapon / plain-object items. */
function loadedCrossbowCornerHTML(item) {
  if (item?.type !== "weapon" || !item.hasChamber || !item.isLoaded) return "";
  const n = Number(item.system?.loaded?.count) || 0;
  const tip = n > 1
    ? tFormat("WITCHER.Chrome.Inventory.Text.LoadedN", { n }, `Loaded — ${n} rounds chambered`)
    : t("WITCHER.Chrome.Inventory.Text.Loaded", "Loaded — ready to fire");
  return `<span class="wou-slot-loaded" title="${escapeAttr(tip)}"><i class="fa-solid fa-bullseye-pointer"></i>${n > 1 ? `<span class="loaded-n">${n}</span>` : ""}</span>`;
}

/** CE Visor pip — a helm carrying the `visor` quality shows a small corner
 *  indicator for whether the visor is raised (open eye, restrictions lifted) or
 *  lowered (shield/mask, restrictions active). Only rendered for armor with the
 *  quality; other items get nothing. */
function visorCornerHTML(item) {
  if (item?.type !== "armor" || !hasVisorQuality(item)) return "";
  const up = isVisorRaised(item);
  const tip = up
    ? t("WITCHER.Chrome.Inventory.Text.VisorUp", "Visor raised — vision restriction lifted")
    : t("WITCHER.Chrome.Inventory.Text.VisorDown", "Visor lowered — vision restricted");
  const icon = up ? "fa-eye" : "fa-mask";
  return `<span class="wou-slot-visor ${up ? "is-up" : "is-down"}" title="${escapeAttr(tip)}"><i class="fa-solid ${icon}"></i></span>`;
}

/** Top-left "oil applied" badge for weapons AND ammo that carry a live oil
 *  coating. Just the droplet — no inline duration / charge count next to
 *  it on the equip tile (was an icon + "∞" pair that read awkwardly when
 *  the oil had no timed duration). The tooltip still carries the oil name
 *  + effect text + duration so the player can hover for detail.
 *
 *  Ammo picked up the coating in the arrow-oil flow (see applyOilToAmmo);
 *  the badge shape matches so a coated arrow reads visually the same as
 *  a coated blade. Other item types don't carry appliedOil. */
function oilBadgeHTML(item) {
  if (item.type !== "weapon" && item.type !== "ammo") return "";
  let oil = readOilCoating(item);
  let boltOil = false;
  /* A loaded crossbow surfaces the CHAMBERED bolt's oil (snapshotted into
   * system.loaded.appliedOil by reload()) when the weapon itself isn't coated
   * — so the icon tells you the pipe holds an oiled bolt. */
  if (!oil && item.type === "weapon") {
    const lo = item.system?.loaded;
    const ao = lo?.appliedOil;
    if ((Number(lo?.count) || 0) > 0 && ao?.name && String(ao.name).trim()) {
      const eff = ao.oilTarget
        ? `+${Number(ao.oilBonusDamage) || 0} vs ${ao.oilTarget}`
        : `+${Number(ao.oilBonusDamage) || 0} damage`;
      oil = { name: String(ao.name), effect: eff, dur: {} };
      boltOil = true;
    }
  }
  if (!oil) return "";
  const d = describeDuration(oil.dur ?? {});
  const timed = d.total > 0;
  const durLine = timed ? (d.label || "") : (oil.dur?.label || "");
  const tipBits = [boltOil ? `${t("WITCHER.Chrome.Inventory.Text.LoadedBolt", "Loaded bolt")}: ${oil.name}` : oil.name];
  if (oil.effect) tipBits.push(oil.effect);
  if (durLine) tipBits.push(durLine);
  const tip = tipBits.join(" — ");
  return `<span class="oil-badge${boltOil ? " is-bolt" : ""}" title="${escapeAttr(tip)}"><i class="fa-solid fa-droplet"></i></span>`;
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
    chips.push(`<span class="wou-popup-weight ${cap.over ? "is-over" : ""}" title="${t("WITCHER.Chrome.Inventory.Text.FilledTotalSlots", "Filled / Total slots")}">
      <i class="fa-solid fa-grip"></i>
      <span class="cur-w">${cap.cur}</span>
      <span class="sep">/</span>
      <span class="max-w">${cap.max}</span>
    </span>`);
  }
  if (cap.storedWeight > 0 || cap.totalWeightCap > 0) {
    const overW = cap.totalWeightCap > 0 && cap.storedWeight > cap.totalWeightCap;
    chips.push(`<span class="wou-popup-weight ${overW ? "is-over" : ""}" title="${escapeAttr(cap.totalWeightCap > 0 ? t("WITCHER.Chrome.Inventory.Tip.TotalWeightStoredCap", "Total weight stored / cap") : t("WITCHER.Chrome.Inventory.Tip.TotalWeightStored", "Total weight stored"))}">
      <i class="fa-solid fa-weight-hanging"></i>
      <span class="cur-w">${fmt(cap.storedWeight)}</span>
      ${cap.totalWeightCap > 0
        ? `<span class="sep">/</span><span class="max-w">${cap.totalWeightCap}</span>`
        : ""}
      <span class="unit">kg</span>
    </span>`);
  }
  if (cap.perItemWeightCap > 0) {
    chips.push(`<span class="wou-popup-weight" title="${t("WITCHER.Chrome.Inventory.Text.PerItemWeightCap", "Per-item weight cap")}">
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
/** Corner badge marking a slot's per-slot behavior toggles (QD/FD/QU), shown
 *  on both the item occupying a slot and the empty placeholder so the player
 *  can see which slots snap-draw / free-draw / quick-use at a glance. */
function slotBehaviorCornerHTML(row) {
  if (!row) return "";
  const icons = [];
  if (row.quickDraw) icons.push(`<i class="fa-solid fa-bolt" title="${escapeAttr(t("WITCHER.Sheet.ContainerEquip.Text.QuickDraw", "Quick-Draw"))}"></i>`);
  if (row.freeUse)   icons.push(`<i class="fa-solid fa-hand" title="${escapeAttr(t("WITCHER.Sheet.ContainerEquip.Text.FreeUse", "Free-Use"))}"></i>`);
  if (!icons.length) return "";
  return `<span class="wou-slot-behbadge" style="position:absolute;bottom:1px;left:2px;display:flex;gap:2px;font-size:0.55em;line-height:1;color:#e6dcc4;text-shadow:0 0 2px #000,0 1px 2px #000;pointer-events:none;z-index:3;">${icons.join("")}</span>`;
}

/** Weight/encumbrance fill bar for the container popup — stored load vs the
 *  container's carry capacity. Only shown when the container HAS a weight
 *  capacity (general / hybrid); slots-only containers have no kg cap so it's
 *  omitted. `cap` is the getCapacityDisplay result. */
function containerCapacityBarHTML(cap) {
  const total = Number(cap?.totalWeightCap) || 0;
  if (total <= 0) return "";
  const stored = Number(cap?.storedWeight) || 0;
  const pct  = Math.max(0, Math.min(100, (stored / total) * 100));
  const over = stored > total;
  const fill = over ? "#c8553d" : "#6e9d5a";
  return `<div class="wou-popup-capbar" title="${stored} / ${total} kg" style="height:5px;margin:2px 8px 5px;border-radius:3px;background:rgba(0,0,0,0.35);overflow:hidden;">
    <div style="height:100%;width:${pct}%;background:${fill};transition:width 0.15s;"></div>
  </div>`;
}

/** Legend strip for the bottom of a container popup, explaining the per-slot
 *  behavior icons. Only rendered when the container actually has a Quick-Draw
 *  or Free-Use slot, so plain containers stay uncluttered. */
function slotBehaviorLegendHTML(container) {
  const slots = getContainerCfg(container)?.slots ?? [];
  const hasQuick = slots.some(s => s.quickDraw);
  const hasFree  = slots.some(s => s.freeUse);
  if (!hasQuick && !hasFree) return "";
  const item = (icon, txt) =>
    `<span style="display:inline-flex;gap:4px;align-items:center;"><i class="fa-solid ${icon}" style="color:#e6dcc4;"></i> ${txt}</span>`;
  const parts = [];
  if (hasQuick) parts.push(item("fa-bolt", t("WITCHER.Chrome.Inventory.Legend.QuickDraw", "Can Fast-Draw")));
  if (hasFree)  parts.push(item("fa-hand", t("WITCHER.Chrome.Inventory.Legend.FreeUse", "No combat action")));
  return `<div class="wou-popup-legend" style="display:flex;flex-wrap:wrap;gap:4px 14px;justify-content:center;padding:5px 6px;font-size:0.62em;line-height:1.2;color:#c9bfa5;border-top:1px solid rgba(0,0,0,0.28);">${parts.join("")}</div>`;
}

function slotTileHTML(tile) {
  // Full-width section divider (hybrid "Compartments" / "Loose space").
  if (tile.divider) {
    return `<div class="wou-slot-divider" style="grid-column:1/-1;font-size:0.62em;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;opacity:0.55;padding:4px 2px 1px;border-bottom:1px solid rgba(255,255,255,0.14);margin-top:2px;">${escapeText(tile.label || "")}</div>`;
  }
  // Loose-space drop zone (hybrid): a full-width dashed frame around the loose
  // items so it's obvious where to drop for general storage. Rendered even when
  // empty (a labelled "drag here" target). Its inner tiles carry NO slot-key,
  // so a drop inside routes to the loose branch of moveItemToContainer.
  if (tile.looseZone) {
    const items = Array.isArray(tile.items) ? tile.items : [];
    // Empty → the hint renders as a full-width flex child of the zone (NOT a
    // grid cell), so it centers across the whole loose area regardless of how
    // many item columns the grid would form.
    const inner = items.length
      ? `<div class="wou-loose-grid">${items.map(l => itemSlotHTML(l.item, null, null, l.qty ?? null)).join("")}</div>`
      : `<div class="wou-loose-hint">${t("WITCHER.Chrome.Inventory.Text.DragItemsHereLoose", "Drag items here")}</div>`;
    return `<div class="wou-loose-zone" data-loose-zone="1" style="grid-column:1/-1;">
      <div class="wou-loose-zone-label">${escapeText(tile.label || "")}</div>
      ${inner}
    </div>`;
  }
  // Filled slot → the item tile, passed the slot row so it can paint the
  // QD/FD/QU behavior corner.
  // Each slot renders its own per-slot quantity (slotQty): a stacking slot
  // shows its count (e.g. "5"); a spread stack shows 1 per tile.
  if (tile.item) return itemSlotHTML(tile.item, null, tile.row, tile.slotQty ?? null, tile.slotKey ?? null, false, tile.slotMax ?? null);
  const icons = tilePlaceholderIcons(tile.row);
  const multi = icons.length > 1;
  const label = rowTooltip(tile.row);
  const short = rowShortLabel(tile.row);
  const slotKeyAttr = tile.slotKey != null ? ` data-slot-key="${escapeAttr(tile.slotKey)}"` : "";
  // Empty placeholder shows its slot's thematic icon(s) — a multi-type slot
  // renders one glyph per accepted type — plus a short caption of what it
  // accepts and the same QD/FD/QU behavior corner. Inline layout keeps it
  // self-contained without touching the shared .wou-slot rules.
  const iconsHTML = multi
    ? `<span class="wou-slot-icons" style="display:flex;align-items:center;justify-content:center;gap:2px;flex-wrap:wrap;max-width:100%;opacity:0.65;font-size:0.82em;">${icons.map(ic => `<i class="fa-solid ${ic}"></i>`).join("")}</span>`
    : `<i class="icon fa-solid ${icons[0]}" style="opacity:0.65;"></i>`;
  return `
    <div class="wou-slot is-equip-empty is-typed-slot${multi ? " is-multi-type" : ""}" title="${escapeAttr(label + " (empty)")}"${slotKeyAttr}
         style="position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;">
      ${iconsHTML}
      <span class="wou-slot-typelabel" style="font-size:0.58em;line-height:1;opacity:0.7;max-width:100%;padding:0 2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center;">${escapeAttr(short)}</span>
      ${slotBehaviorCornerHTML(tile.row)}
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
    case "focus":       return "fa-wand-sparkles";
    case "book":        return "fa-book";
    case "map":         return "fa-map";
    case "remains":     return "fa-skull";
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
      name: t("WITCHER.Chrome.Inventory.Text.NoCharacter", "— no character —"),
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
      if (s.isCarried === false) continue;
      /* Skip items stored in a container — their weight enters the total
         via that container's calcWeight (ContainerData sums storedWeight).
         Without the skip, contents would double-count once we route
         top-level items through calcWeight below. */
      if (s.isStored === true) continue;
      /* Prefer calcWeight() so containers report weight + storedWeight
         (data/item/container.mjs). Raw quantity × weight was ignoring
         the aggregate — items inside containers landed nowhere. */
      const w = typeof s.calcWeight === "function"
        ? Number(s.calcWeight()) || 0
        : (Number(s.quantity) || 0) * (Number(s.weight) || 0);
      totalWeight += w;
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
        <div class="wou-stat-key">${t("WITCHER.Common.Encumbrance", "Encumbrance")}</div>
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

/* Natural Weapons (claws/bite/…) replace the character's core unarmed
 * punch/kick damage. Resolve the display strings + quality pips the same way
 * brawlDamage does (core code + MeleeBonus; kick still +4) so the chrome's
 * unarmed cells mirror what the brawl action actually rolls. Returns null when
 * no owned race enables natural weapons — the caller then falls back to the
 * plain derivedStats punch/kick. */
function naturalWeaponChromeInfo(actor) {
  const race = (actor?.items ?? []).find(i => i.type === "race" && i.system?.naturalWeapons);
  if (!race) return null;
  const s = race.system ?? {};
  const core = String(s.naturalWeaponDamage ?? "").trim() || "1d6";
  const mb = Number(actor?.system?.derivedStats?.meleeBonus) || 0;
  const withFlat = (flat) => flat ? `${core}${flat > 0 ? "+" : ""}${flat}` : core;
  const punch = withFlat(mb);
  const kick  = withFlat(mb + 4);

  const catalog = getActiveWeaponQualities?.() ?? WEAPON_QUALITIES ?? {};
  const vals = s.naturalWeaponQualityValues ?? {};
  const pips = (Array.isArray(s.naturalWeaponQualities) ? s.naturalWeaponQualities : [])
    .map(key => {
      const entry = catalog[key];
      if (!entry) return null;
      let label = entry.label;
      if (entry.param) {
        const v = vals[key];
        if (v != null && String(v).trim().length) label = `${entry.label}(${String(v).trim()}${entry.param.suffix ?? ""})`;
      }
      return { label, description: entry.description ?? "" };
    })
    .filter(Boolean);

  const dmgTypes = CONFIG?.WITCHER?.damageTypes ?? {};
  const typeLabels = (Array.isArray(s.naturalWeaponTypes) ? s.naturalWeaponTypes : [])
    .map(k => t(dmgTypes[k] ?? k, k)).filter(Boolean);
  const lethalTxt = s.naturalWeaponLethal
    ? t("WITCHER.Sheet.Race.Text.Lethal", "Lethal")
    : t("WITCHER.Brawl.NonLethal", "Non-lethal");

  return { punch, kick, pips, typeLabels, lethalTxt };
}

function renderWeaponsAndPortraitHTML(actor, stats) {
  const armorTarget  = getEquipSlotCount(actor, "armor");
  const equippedArmor   = actor ? actor.items.filter(i => isArmorSlotEquippable(i) && i.system?.equipped) : [];
  const armorSlots  = padSlots(equippedArmor,   armorTarget);

  /* Natural Weapons override the plain punch/kick when an owned race enables
   * them; otherwise fall back to the derived stats. */
  const nw = naturalWeaponChromeInfo(actor);
  const punch = nw ? nw.punch : (actor?.system?.derivedStats?.punch ?? "1d6");
  const kick  = nw ? nw.kick  : (actor?.system?.derivedStats?.kick  ?? "1d6");
  const nwTitle = nw
    ? `${t("WITCHER.Sheet.Race.Text.NaturalWeapons", "Natural weapons")} — ${[nw.typeLabels.join(" / "), nw.lethalTxt].filter(Boolean).join(" · ")}`
    : t("WITCHER.Chrome.Inventory.Text.BrawlingUnarmedStrikeDamage", "Brawling — unarmed strike damage");
  const nwPipsHTML = (nw && nw.pips.length)
    ? `<div class="wou-unarmed-pips">${nw.pips.map(p =>
        `<span class="wou-unarmed-pip" title="${escapeAttr(p.description || p.label)}">${escapeText(p.label)}</span>`).join("")}</div>`
    : "";

  return `
    <div class="wou-weap-port">
      <div class="wou-weapons">
        <div class="wou-section-label">${t("WITCHER.Chrome.Inventory.Text.Weapons", "Weapons")}${renderSwitchHandsButtonHTML(actor)}</div>
        <div class="wou-weapons-grid wou-hand-grid">
          ${renderWeaponHandSlotsHTML(actor)}
        </div>
        <div class="wou-unarmed${nw ? " wou-unarmed-natural" : ""}" title="${escapeAttr(nwTitle)}">
          <span class="wou-unarmed-cell"><i class="fa-solid fa-hand-fist"></i> ${escapeText(String(punch))}</span>
          <span class="wou-unarmed-cell"><i class="fa-solid fa-shoe-prints"></i> ${escapeText(String(kick))}</span>
        </div>
        ${nwPipsHTML}
      </div>

      <div class="wou-portrait">
        ${stats.portrait ? `<img class="portrait-img" src="${escapeAttr(stats.portrait)}" alt="" />` : ""}
        ${(isVariablePortraitEnabled(actor) && (game.user?.isGM || actor.isOwner))
          ? `<button class="wdm-vp-corner" type="button" data-action="variable-portrait" title="${t("WITCHER.Chrome.Character.Text.VariablePortrait", "Variable portrait")}"><i class="fa-solid fa-flask-vial"></i></button>`
          : ""}
        <div class="nameplate">
          <div class="name">${escapeText(stats.name)}</div>
          <div class="epithet">${escapeText(stats.epithet)}</div>
        </div>
      </div>

      <div class="wou-mount-attach">
        <div class="wou-section-label wou-mount-label">${escapeText(getMountActor(actor)?.name ?? t("WITCHER.Chrome.Inventory.Text.Mount", "Mount"))}</div>
        <div class="wou-mount-row">
          ${renderMountSlotHTML(actor)}
        </div>
        ${renderMountStatsHTML(actor)}
      </div>

      <div class="wou-armor">
        <div class="wou-section-label">${t("WITCHER.Common.Armor", "Armor")}</div>
        <div class="wou-armor-grid">
          ${armorSlots.map(item => equipSlotHTML(item, "armor")).join("")}
        </div>
        <div class="wou-equip-controls" data-equip-controls="armor">
          <button type="button" data-action="add"    title="${t("WITCHER.Chrome.Inventory.Text.AddArmorSlot", "Add armor slot")}">+</button>
          <button type="button" data-action="remove" title="${t("WITCHER.Chrome.Inventory.Text.RemoveArmorSlot", "Remove armor slot")}">−</button>
        </div>
        ${renderArmorLayeringHTML(actor)}
      </div>
    </div>
  `;
}

/* Armor-layering readout under the equip slots (Core p.154–155). Shows the
 * standing rule ("how many layers you can have") plus, per actually-layered
 * body zone, the layer count, the combined SP and the bonus that layering
 * contributed, and the total EV surcharge. Over-limit zones (4th layer, 2nd
 * heavy/medium) are flagged. Pure data comes from layeringReadout(). */
function renderArmorLayeringHTML(actor) {
  if (!actor || actor.type !== "character") return "";
  const worn = actor.items.filter(i =>
    i.type === "armor" && i.system?.equipped
    && String(i.system?.armorType).toLowerCase() !== "shield"
    && String(i.system?.location) !== "Shield");
  const ce = isCESubsystemEnabled?.("eoArmorModel");
  const { zones, evSurcharge } = layeringReadout(worn, { ceModel: ce });

  const zoneLabel = (z) => ({
    head:  t("WITCHER.Location.Head",  "Head"),
    torso: t("WITCHER.Location.Torso", "Torso"),
    arms:  t("WITCHER.Location.Arms",  "Arms"),
    legs:  t("WITCHER.Location.Legs",  "Legs")
  }[z] ?? z);

  const chip = (z) => {
    const bad = z.overCap || z.secondHeavy || z.secondMedium || z.twoStifling;
    const reasons = [];
    if (z.twoStifling)  reasons.push(t("WITCHER.Chrome.Inventory.Layering.TwoStifling", "two stifling layers (not allowed)"));
    if (z.overCap)      reasons.push(t("WITCHER.Chrome.Inventory.Layering.OverCap",   "more than 3 layers"));
    if (z.secondHeavy)  reasons.push(t("WITCHER.Chrome.Inventory.Layering.TwoHeavy",  "more than one heavy layer"));
    if (z.secondMedium) reasons.push(t("WITCHER.Chrome.Inventory.Layering.TwoMedium", "more than one medium layer"));
    const warnIco = bad
      ? ` <i class="fa-solid fa-triangle-exclamation" style="color:#d9822b" title="${escapeAttr(reasons.join(", "))}"></i>`
      : "";
    // Show ONLY the layering bonus (the SP the layering itself adds) — the
    // paperdoll already shows the combined total, so repeating "value-with-
    // bonus + bonus" here was redundant. combined = strongest layer + this bonus.
    const bonus = `<span style="color:#7ec8e3">+${z.bonusSP}</span>`;
    // No layer cap under the CE model, so show just the count there.
    const count = ce ? `${z.count}` : `${z.count}/${z.max}`;
    const layersWord = t("WITCHER.Chrome.Inventory.Layering.LayersWord", "Layers");
    return `<span style="display:inline-flex;align-items:center;gap:2px;padding:1px 6px;border-radius:8px;background:${bad ? "rgba(217,130,43,0.18)" : "rgba(126,200,227,0.12)"}">`
      + `${escapeText(zoneLabel(z.zone))} <b>${count}</b> ${layersWord} · SP ${bonus}${warnIco}</span>`;
  };

  const rows = zones.map(chip).join("");
  // layeringReadout only emits a zone once it has 2+ layers, so an empty `zones`
  // means no location is actually layered. In BOTH RAW and Combat Extended,
  // hide the whole readout (the italic rule tip included) until that happens —
  // the standing-rule blurb shouldn't sit there when nothing is layered.
  if (!rows) return "";
  const evBadge = evSurcharge > 0
    ? `<span style="padding:1px 6px;border-radius:8px;background:rgba(212,175,55,0.15);color:#d4af37">${tFormat("WITCHER.Chrome.Inventory.Layering.Ev", { n: evSurcharge }, `EV +${evSurcharge}`)}</span>`
    : "";

  return `
    <div class="wou-armor-layering" style="margin-top:4px;font-size:0.7rem;line-height:1.6">
      <div style="opacity:0.55;font-style:italic">${ce
        ? t("WITCHER.Chrome.Inventory.Layering.RuleCE", "Layering (Combat Extended) — SP: strongest layer + ¼ of each weaker layer.")
        : t("WITCHER.Chrome.Inventory.Layering.Rule", "Layering — max 3 layers per location, 1 heavy + 1 medium.")}</div>
      <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:3px;align-items:center">${rows}${evBadge}</div>
    </div>`;
}

function renderMountSlotHTML(actor) {
  const linked = getMountActor(actor);
  if (!linked) {
    return `<div class="wou-equip wou-equip-add" data-action="mount-attach" title="${t("WITCHER.Chrome.Inventory.Text.ClickToPickOrDropAnActorHere", "Click to pick · or drop an actor here")}">
      <i class="fa-solid fa-horse"></i>
    </div>`;
  }
  const img = linked.img && !linked.img.includes("mystery-man")
    ? `<img class="icon" src="${escapeAttr(linked.img)}" alt="" draggable="false" />`
    : `<i class="fa-solid fa-horse"></i>`;
  return `<div class="wou-equip wou-mount-linked" data-action="mount-attach" title="${escapeAttr(linked.name)} — click to open inventory">
    ${img}
    <button type="button" class="wou-mount-unlink" data-action="mount-unlink" aria-label="${t("WITCHER.Chrome.Inventory.Text.UnlinkMount", "Unlink mount")}" title="${t("WITCHER.Chrome.Inventory.Text.Unlink", "Unlink")}">
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
        <div class="wms-label">${t("WITCHER.Chrome.Inventory.MountStats.Ath", "Ath")}</div>
        <div class="wms-value">${fmt(dexAth)}</div>
      </div>
      <div class="wms-cell">
        <div class="wms-label">${t("WITCHER.Chrome.Inventory.MountStats.SPD", "SPD")}</div>
        <div class="wms-value">${escapeText(String(speed))}</div>
      </div>
      <div class="wms-cell">
        <div class="wms-label">${t("WITCHER.Chrome.Inventory.MountStats.Ctrl", "Ctrl")}</div>
        <div class="wms-value ${ctrl >= 0 ? 'is-pos' : 'is-neg'}">${fmt(ctrl)}</div>
      </div>
      <div class="wms-cell wms-cell-hp">
        <div class="wms-label">${t("WITCHER.Chrome.Inventory.MountStats.HP", "HP")}</div>
        <div class="wms-value">${hpCur}</div>
      </div>
    </div>
  `;
}

function equipSlotHTML(item, kind /* "armor" */) {
  if (!item) {
    return `<div class="wou-equip" data-equip-type="${kind}" data-item-id="" title="${escapeAttr(t("WITCHER.Chrome.Inventory.Dialog.Button.Empty", "Empty"))}"></div>`;
  }
  const iconHTML = item.img && !item.img.includes("mystery-man")
    ? `<img class="icon" src="${escapeAttr(item.img)}" alt="" draggable="false" />`
    : `<i class="fa-solid ${fallbackIconFor(item.type)}"></i>`;
  const rarity = String(item.system?.availability ?? "").toLowerCase();
  const rarAttr = rarity ? ` data-rarity="${escapeAttr(rarity)}"` : "";
  const { cls: flairCls, attr: flairAttr } = flairSlotBits(item);
  return `<div class="wou-equip has-item item${flairCls ? " " + flairCls : ""}" data-equip-type="${kind}" data-item-id="${escapeAttr(item.id)}"${rarAttr}${flairAttr} title="${escapeAttr(item.name)}">${iconHTML}${visorCornerHTML(item)}${oilBadgeHTML(item)}</div>`;
}

/* The three fixed weapon hand-slots: Main, Off-hand, Quick. Each is a drop
 * target tagged with `data-equip-slot`. The internal keys stay right/left/quick
 * (stored in system.slot); only the labels read Main / Off-hand. A two-handed
 * weapon occupies both Main and Off-hand (it appears in both, tagged "2H"); the
 * Quick slot shows a quick weapon or an equipped shield. */
const HAND_SLOT_DEFS = () => [
  { key: "right", short: "M", title: t("WITCHER.Inv.Slot.MainHand", "Main hand — drag a one-handed weapon here") },
  { key: "left",  short: "O", title: t("WITCHER.Inv.Slot.OffHand", "Off-hand — drag a one-handed weapon here") },
  { key: "quick", short: "Q", title: t("WITCHER.Inv.Slot.Quick", "Quick / off-hand — quick weapons & shields only") }
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
  return HAND_SLOT_DEFS()
    .filter(({ key }) => key !== "quick" || showQuick)
    .map(({ key, short, title }) =>
      weaponHandSlotHTML(byKey[key], key, short, title)).join("");
}

/* Switch-hands button next to the equip rail. Three potential actions:
 *   • swap        — exchange Main and Off-hand weapons (legacy)
 *   • grip-to-2h  — re-grip a hybrid 1H weapon two-handed (EO Two-Hand)
 *   • grip-to-1h  — re-grip a 2H-moded weapon back into one hand
 *
 * The button is shown if any of these are available. Multiple options
 * are presented in a DialogV2 picker; a single option fires directly. */
function _switchHandsOptions(actor) {
  if (!actor) return [];
  const eq = (actor.items?.contents ?? actor.items ?? []).filter(i => i.system?.equipped);

  const opts = [];

  const nativeTwoH = eq.find(i =>
    (i.type === "weapon" || i.type === "shield") && i.system?.hands === "two");
  const hybridInTwoH = eq.find(i =>
    i.type === "weapon"
    && i.system?.twoHandMode === true
    && Array.isArray(i.system?.qualities)
    && i.system.qualities.includes("twoHand"));

  // Swap available iff no item claims both hands (native 2H or hybrid 2H mode)
  // and at least one of Main/Off has something.
  if (!nativeTwoH && !hybridInTwoH) {
    const hasMain = eq.some(i => occupancyOf(i) === "right");
    const hasOff  = eq.some(i => occupancyOf(i) === "left");
    if (hasMain || hasOff) opts.push({ kind: "swap" });
  }

  // 1H → 2H: any equipped hybrid 1H weapon not already in 2H mode.
  if (!nativeTwoH) {
    for (const w of eq) {
      if (w.type !== "weapon") continue;
      if (w.system?.hands !== "one") continue;
      if (!Array.isArray(w.system?.qualities) || !w.system.qualities.includes("twoHand")) continue;
      if (w.system?.twoHandMode === true) continue;
      opts.push({ kind: "grip-to-2h", item: w });
    }
  }

  // 2H → 1H: the hybrid weapon currently in 2H mode (at most one).
  if (hybridInTwoH) opts.push({ kind: "grip-to-1h", item: hybridInTwoH });

  return opts;
}

function renderSwitchHandsButtonHTML(actor) {
  const opts = _switchHandsOptions(actor);
  if (!opts.length) return "";
  const title = opts.length === 1
    ? (opts[0].kind === "swap"
        ? t("WITCHER.Chrome.Inventory.Tip.SwitchHandsSwap", "Switch hands — swap Main and Off-hand (costs an action)")
        : opts[0].kind === "grip-to-2h"
          ? tFormat("WITCHER.Chrome.Inventory.Tip.SwitchGripTwoHanded", { name: opts[0].item.name }, "Switch grip — wield {name} two-handed (costs an action)")
          : tFormat("WITCHER.Chrome.Inventory.Tip.SwitchGripOneHanded", { name: opts[0].item.name }, "Switch grip — wield {name} one-handed (costs an action)"))
    : t("WITCHER.Chrome.Inventory.Tip.SwitchHandsChoose", "Switch hands — choose swap or grip change (costs an action)");
  return `<button type="button" class="wou-switch-hands" data-action="switch-hands" title="${escapeAttr(title)}"><i class="fa-solid fa-right-left"></i></button>`;
}

async function _doSwap(actor) {
  const eq = (actor.items?.contents ?? actor.items ?? []).filter(i => i.system?.equipped);
  const main = eq.find(i => occupancyOf(i) === "right");
  const off  = eq.find(i => occupancyOf(i) === "left");
  if (!main && !off) return;
  if (!canSpendCombatAction(actor)) return;
  const updates = [];
  if (main) updates.push({ _id: main.id, "system.slot": "left"  });
  if (off)  updates.push({ _id: off.id,  "system.slot": "right" });
  await actor.updateEmbeddedDocuments("Item", updates, { wouSwapHands: true });
  await chargeCombatAction(actor, t("WITCHER.Inv.SwitchHands", "Switch hands"));
}

async function _doGripChange(actor, weapon, goingTwo) {
  if (!actor || !weapon) return;
  if (goingTwo) {
    /* Off-hand-free precondition: only the OFF-HAND ("left") blocks
     * switching to 2H grip. The Quick slot is the "rested while two-
     * handed" carve-out that already coexists with natively 2H weapons
     * (an equipped Quick alchemical or quick weapon stays in Quick when
     * you draw a greatsword), so allow it here too. */
    const eq = (actor.items?.contents ?? actor.items ?? []).filter(i => i.system?.equipped);
    const blocker = eq.find(i => i !== weapon && occupancyOf(i) === "left");
    if (blocker) {
      ui?.notifications?.warn?.(`Can't wield ${weapon.name} two-handed — ${blocker.name} occupies the off-hand.`);
      return;
    }
  }
  if (!canSpendCombatAction(actor)) return;
  await weapon.update({ "system.twoHandMode": goingTwo });
  await chargeCombatAction(actor, goingTwo
    ? tFormat("WITCHER.Chrome.Inventory.Text.SwitchGripTwoHanded", { name: weapon.name }, `Switch grip: ${weapon.name} → two-handed`)
    : tFormat("WITCHER.Chrome.Inventory.Text.SwitchGripOneHanded", { name: weapon.name }, `Switch grip: ${weapon.name} → one-handed`));
}

async function switchWeaponHands(actor) {
  if (!actor) return;
  const opts = _switchHandsOptions(actor);
  if (!opts.length) return;

  // Single option — fire directly, no dialog.
  if (opts.length === 1) {
    const o = opts[0];
    if (o.kind === "swap") return _doSwap(actor);
    if (o.kind === "grip-to-2h") return _doGripChange(actor, o.item, true);
    if (o.kind === "grip-to-1h") return _doGripChange(actor, o.item, false);
    return;
  }

  // Multiple options — ask the user which action.
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2) {
    // No DialogV2 fallback: take the swap if present, else the first grip op.
    const fallback = opts.find(o => o.kind === "swap") ?? opts[0];
    if (fallback.kind === "swap") return _doSwap(actor);
    return _doGripChange(actor, fallback.item, fallback.kind === "grip-to-2h");
  }

  const labelFor = (o) => o.kind === "swap"
    ? t("WITCHER.Chrome.Inventory.Text.SwapMainOffHand", "Swap Main and Off-hand")
    : o.kind === "grip-to-2h"
      ? tFormat("WITCHER.Chrome.Inventory.Text.WieldTwoHanded", { name: o.item.name }, "Wield {name} two-handed")
      : tFormat("WITCHER.Chrome.Inventory.Text.WieldOneHanded", { name: o.item.name }, "Wield {name} one-handed");

  const rows = opts.map((o, i) =>
    `<label style="display:flex;align-items:center;gap:.5rem;padding:.25rem 0;">
       <input type="radio" name="wou-switch-pick" value="${i}"${i === 0 ? " checked" : ""}>
       <span>${escapeAttr(labelFor(o))}</span>
     </label>`
  ).join("");

  const content = `<div style="display:flex;flex-direction:column;gap:.15rem;">${rows}</div>`;

  const picked = await DialogV2.wait({
    window: { title: t("WITCHER.Inv.SwitchHands", "Switch hands") },
    content,
    buttons: [
      {
        action: "go",
        label: t("WITCHER.Common.Confirm", "Confirm"),
        default: true,
        callback: (event, button) => {
          const root = button.form ?? button.closest?.("form") ?? document;
          const r = root.querySelector?.('input[name="wou-switch-pick"]:checked');
          return r?.value ?? null;
        }
      },
      { action: "cancel", label: t("WITCHER.Common.Cancel", "Cancel") }
    ],
    rejectClose: false
  }).catch(() => null);

  if (picked == null || picked === "cancel") return;
  const idx = Number(picked);
  if (!Number.isInteger(idx) || idx < 0 || idx >= opts.length) return;
  const o = opts[idx];
  if (o.kind === "swap") return _doSwap(actor);
  return _doGripChange(actor, o.item, o.kind === "grip-to-2h");
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
  const { cls: flairCls, attr: flairAttr } = flairSlotBits(item);
  return `<div class="wou-equip wou-equip-hand has-item item${twoH ? " is-two-handed" : ""}${flairCls ? " " + flairCls : ""}" data-equip-type="weapon" data-equip-slot="${slotKey}" data-item-id="${escapeAttr(item.id)}"${rarAttr}${flairAttr} title="${escapeAttr(item.name)}">${iconHTML}<span class="wou-slot-tag">${tag}</span>${sheath}${loadedCrossbowCornerHTML(item)}${oilBadgeHTML(item)}</div>`;
}

/* Sheath chip in the corner of an equipped weapon slot. Click returns the
 * weapon to the container it was drawn from, or any container the actor
 * has, or just unequips it. */
function sheathBadgeHTML() {
  return `<span class="wou-sheath-badge" title="${t("WITCHER.Chrome.Inventory.Text.SheatheReturnToContainer", "Sheathe (return to container)")}"><i class="fa-solid fa-box-archive"></i></span>`;
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
    /* Runtime two-hand wielding (EO Two-Hand quality on a 1H weapon).
     * When the player toggles into 2H mode, the weapon claims BOTH
     * hands the same way a baseline 2H weapon does — so the off-hand
     * is gated and Quick items conflict the same way. */
    if (item.type === "weapon" && item.system?.twoHandMode === true
        && Array.isArray(item.system?.qualities)
        && item.system.qualities.includes("twoHand")) {
      return "both";
    }
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

/* Pick the slot to equip an item into — placement is by PRIORITY, not by any
 * remembered last-hand:
 *   • Two-handed weapon → the main-hand slot (it occupies both hands, i.e. the
 *     "two-hand slot").
 *   • One-hander → Main hand (Right) if free, else Off hand (Left) if free,
 *     else the Quick slot for quick-flagged weapons. Main hand is always the
 *     preference over off hand.
 * When nothing is free, falls back to Quick (quick items) or the main hand;
 * assignSlot's conflict check then surfaces a useful "hands full" message. */
/* Items that occupy an ARMOR equip slot: real armor + Focus items. A focus is
 * worn in an armor slot but is NOT an SP layer, so it's deliberately excluded
 * from the layering / SP math (those checks stay `type === "armor"`). */
function isArmorSlotEquippable(item) {
  return item?.type === "armor" || item?.type === "focus";
}

function autoEquipSlot(actor, item) {
  if ((item?.type === "weapon" || item?.type === "shield") && item?.system?.hands === "two") {
    return "right";
  }
  const quick = isQuickItem(item);
  const order = ["right", "left"];        // main → off, main always preferred
  if (quick) order.push("quick");         // quick slot only for quick-flagged items
  for (const s of order) {
    const occ = occupancyForSlot(item, s);
    if (!occ) continue;
    if (checkEquipConflicts(actor, item.id, occ, getPendingEquips(actor.id)).ok) return s;
  }
  return quick ? "quick" : "right";
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
    const synthetic = { id: p.itemId, name: t("WITCHER.Chrome.Inventory.Text.Pending", "(pending)") };
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
    /* Manticore · Shield Mastery: a shield may still occupy a hand slot
     * while a quick item is in the off-hand. Same relaxation as the
     * quick-into-shield case above, but for the reverse ordering
     * (weapon + quick already equipped, THEN equipping the shield).
     * Read the target item; if it's a shield and combatMods.quickItemWithShield
     * is >0, the guard passes and pairwise-conflict logic below still
     * enforces genuine conflicts (e.g. same hand already busy). */
    const targetItem = actor?.items?.get?.(itemId);
    const targetIsShield = targetItem && isShieldItem(targetItem);
    const quickWithShield = (Number(actor?.system?.combatMods?.quickItemWithShield) || 0) > 0;
    if (!(targetIsShield && quickWithShield)) {
      return { ok: false, reason: "quick-blocks-offhand", conflicts: [quickBusy] };
    }
  }
  if (conflicts.length > 0) {
    return { ok: false, reason: "pairwise-conflict", conflicts };
  }
  return { ok: true };
}

function describeEquipFailure(itemName, result) {
  const names = (result.conflicts ?? []).map(c => c.name ?? t("WITCHER.Chrome.Inventory.Text.Pending", "(pending)")).join(", ");
  switch (result.reason) {
    case "quick-only":
      return tFormat("WITCHER.Chrome.Inventory.EquipFail.QuickOnly", { item: itemName }, `Can't put ${itemName} in the Quick slot — it only holds quick items (throwing knives, daggers, shields).`);
    case "invalid-slot":
      return tFormat("WITCHER.Chrome.Inventory.EquipFail.InvalidSlot", { item: itemName }, `Can't equip ${itemName} there.`);
    case "no-free-hand-for-quick":
      return tFormat("WITCHER.Chrome.Inventory.EquipFail.NoFreeHand", { item: itemName }, `Can't equip ${itemName} as Quick — no free hand. Sheath or drop a weapon first.`);
    case "quick-blocks-offhand":
      return tFormat("WITCHER.Chrome.Inventory.EquipFail.QuickBlocksOffhand", { item: itemName, names }, `Can't equip ${itemName} — your off-hand (${names}) is already taken. Sheath or drop it first.`);
    case "pairwise-conflict":
      return tFormat("WITCHER.Chrome.Inventory.EquipFail.PairwiseConflict", { item: itemName, names }, `Can't equip ${itemName} — already wielding ${names}. Sheath or drop first.`);
    default:
      return tFormat("WITCHER.Chrome.Inventory.EquipFail.Default", { item: itemName }, `Can't equip ${itemName}.`);
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
    if (!sameAsOpen) hideHoverCard();   // opening a rail bag closes any open hover card
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
      // Route through the canonical placement path instead of a raw content
      // append: it STACK-MERGES into the existing stored stack, so dropping the
      // same compendium item repeatedly grows that stack rather than minting a
      // new slot-eating doc each time (which used to exhaust the slots and spill
      // to inventory). No compartment target on the rail → loose by default for
      // hybrids. tryForeignItemDrop already handled any action cost.
      await moveItemToContainer(owner, created.id, containerId, "grid", {});
      return;
    }

    // Internal drag from this overlay (grid / equip / another container).
    const id         = ev.dataTransfer.getData("application/x-wou-item");
    const source     = ev.dataTransfer.getData("application/x-wou-source");
    const srcActorId = ev.dataTransfer.getData("application/x-wou-source-actor") || owner.id;
    if (!id) return;
    if (id === containerId) return;
    /* Cross-actor rail drop (character grid → mount container, or vice
     * versa). The `owner` above is the container's owner; the item lives on
     * `srcActor`. Route through transferAcrossActors — which detaches from
     * the source container/equip, capacity-checks the destination, creates
     * a fresh copy on the dest inside the target container, and deletes
     * the source stack — instead of moveItemToContainer, which would
     * silently no-op because owner.items.get(id) is undefined. */
    if (srcActorId !== owner.id) {
      const srcActor = game.actors?.get?.(srcActorId);
      const srcItem  = srcActor?.items?.get(id);
      if (!srcActor || !srcItem) return;
      await transferAcrossActors(srcActor, srcItem, source, owner, containerId);
      return;
    }
    /* Dragging a CONTAINER onto an occupied slot equips it there (the
     * previously-occupying container falls back to the grid). */
    const dragged = owner.items.get(id);
    if (!dragged) return;
    if (dragged.type === "container") {
      const slotIdx = Number(slot.dataset.railSlot);
      if (Number.isFinite(slotIdx)) {
        if (!canSpendCombatAction(owner)) return;
        await setRailAssignment(owner, slotIdx, id);
        await chargeCombatAction(owner, `Equip: ${dragged.name}`);
      }
      return;
    }
    /* Rail drop = container CLOSED, no specific slot aimed at. For a hybrid
     * container that means "into the loose pool" (whole stack, obeying the
     * general rules) rather than auto-packing compartments — matches dropping
     * on the open loose space. `loose` only engages for hybrid; slots-only and
     * general containers ignore it and place as before. */
    await moveItemToContainer(owner, id, containerId, source, { spendAction: true, loose: true });
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
      ui?.notifications?.warn?.(t("WITCHER.Chrome.Inventory.Notify.CantLinkSelf", "Can't link the character to itself."));
      return;
    }
    /* Only Monster actors flagged as mounts can be linked — `isMount` is set
     * on the monster sheet's Mount section (system.mount.isMount). */
    if (dropped.type !== "monster") {
      ui?.notifications?.warn?.(tFormat("WITCHER.Chrome.Inventory.Notify.MountOnlyMonster", { type: dropped.type }, `Only Monster actors can be linked as a mount (got "${dropped.type}").`));
      return;
    }
    if (!dropped.system?.mount?.isMount) {
      ui?.notifications?.warn?.(tFormat("WITCHER.Chrome.Inventory.Notify.NotAMount", { name: dropped.name }, `"${dropped.name}" isn't a mount — check "Mount" on its sheet first.`));
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
    ui?.notifications?.error?.(t("WITCHER.Chrome.Inventory.Notify.NoOwnerPerm", "You don't have OWNER permission on your character — can't assign a mount."));
    return;
  }
  const owned = (game.actors?.contents ?? [])
    .filter(a => a.id !== character.id && a.isOwner && a.type === "monster" && a.system?.mount?.isMount)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!owned.length) {
    ui?.notifications?.warn?.(t("WITCHER.Chrome.Inventory.Notify.NoOwnedMounts", "You don't own any mounts. Check \"Mount\" on a monster's sheet to make it rideable."));
    return;
  }

  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2) return;

  const options = owned.map(a =>
    `<option value="${escapeAttr(a.id)}">${escapeText(a.name)} (${escapeText(a.type)})</option>`
  ).join("");

  const content = `
    <div class="form-group">
      <label for="wou-mount-pick">${t("WITCHER.Chrome.Inventory.Text.ActorLabel", "Actor:")}</label>
      <select id="wou-mount-pick" name="mountActorId" style="width:100%;">
        ${options}
      </select>
    </div>
  `;

  const chosen = await DialogV2.wait({
    window: { title: t("WITCHER.Dialog.LinkMount", "Link Mount / Companion") },
    content,
    buttons: [
      {
        action: "link",
        label: t("WITCHER.Chrome.Inventory.Dialog.Button.Link", "Link"),
        default: true,
        callback: (event, button) => {
          const root = button.form ?? button.closest?.("form") ?? document;
          return root.querySelector?.('select[name="mountActorId"]')?.value ?? null;
        }
      },
      { action: "cancel", label: t("WITCHER.Common.Cancel", "Cancel") }
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
  popup.style.left = `calc(${left}px / var(--wdm-size-inventory, var(--wdm-chrome-bars-scale, 1)))`;
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
    setTileDragImage(ev, slot);
  });
  popup.addEventListener("dragend", (ev) => {
    releaseDragTile(ev);
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
      ui?.notifications?.warn?.(t("WITCHER.Chrome.Inventory.Notify.MountOnlyCarriesRemainsContainers", "A mount can only carry remains and containers."));
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
    selectTile(slot);
  });
  // Double-click an item inside the container opens its sheet (same as the grid).
  popup.addEventListener("dblclick", (ev) => {
    const slot = ev.target.closest(".wou-slot[data-item-id]");
    if (!slot) return;
    const item = resolveTileItem(slot.dataset.itemId);
    if (!item || item.type === "container") return;
    ev.preventDefault();
    ev.stopPropagation();
    hideHoverCard();
    item.sheet?.render(true);
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
  popup.style.left = `calc(${left}px / var(--wdm-size-inventory, var(--wdm-chrome-bars-scale, 1)))`;
  popup.style.top = `calc(${top}px / var(--wdm-size-inventory, var(--wdm-chrome-bars-scale, 1)))`;
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
    setTileDragImage(ev, slot);
  });
  popup.addEventListener("dragend", (ev) => {
    releaseDragTile(ev);
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
    const overSlot  = !!ev.target?.closest?.("[data-slot-key]");
    const overLoose = !!ev.target?.closest?.(".wou-loose-zone");
    // Same-container drag: capture over a compartment tile (re-slot) or the
    // loose zone (move to loose); otherwise let it pass for drag-out.
    if (currentDragSource === `container:${openContainerPopupId}` && !overSlot && !overLoose) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    popup.classList.add("is-drop-target");
    const zone = overSlot ? null : ev.target?.closest?.(".wou-loose-zone");
    popup.querySelectorAll?.(".wou-loose-zone").forEach?.(z => z.classList.toggle("is-drop-target", z === zone));
    // Highlight the exact compartment tile under the cursor (like the loose zone).
    const slotEl = overSlot ? ev.target.closest("[data-slot-key]") : null;
    popup.querySelectorAll?.(".wou-slot-drop-hot").forEach?.(s => { if (s !== slotEl) s.classList.remove("wou-slot-drop-hot"); });
    if (slotEl) slotEl.classList.add("wou-slot-drop-hot");
  });
  popup.addEventListener("dragleave", (ev) => {
    if (ev.target === popup) {
      popup.classList.remove("is-drop-target");
      popup.querySelectorAll?.(".wou-loose-zone.is-drop-target").forEach?.(z => z.classList.remove("is-drop-target"));
      popup.querySelectorAll?.(".wou-slot-drop-hot").forEach?.(s => s.classList.remove("wou-slot-drop-hot"));
    }
  });
  popup.addEventListener("drop", async (ev) => {
    /* Which compartment tile did this land on? "row:slot" → fill that exact
     * slot; null → auto-placement (next available slot). Captured before any
     * await so ev.target is still the tile under the cursor. */
    const dropSlotKey = ev.target?.closest?.("[data-slot-key]")?.dataset?.slotKey || null;
    const clearZones = () => { popup.classList.remove("is-drop-target"); popup.querySelectorAll?.(".wou-loose-zone.is-drop-target").forEach?.(z => z.classList.remove("is-drop-target")); popup.querySelectorAll?.(".wou-slot-drop-hot").forEach?.(s => s.classList.remove("wou-slot-drop-hot")); };

    // Same-container drag: RE-SLOT onto a compartment tile, or move to LOOSE
    // when dropped on the loose zone. Ignore elsewhere so drag-out still works.
    if (currentDragSource === `container:${openContainerPopupId}`) {
      const rid = ev.dataTransfer.getData("application/x-wou-item");
      const overLoose = !!ev.target?.closest?.(".wou-loose-zone");
      if (!dropSlotKey && !overLoose) return;
      ev.preventDefault();
      clearZones();
      if (rid) await moveItemToContainer(popupActor, rid, openContainerPopupId, currentDragSource, dropSlotKey ? { slotKey: dropSlotKey } : { loose: true });
      // A slot↔loose move changes only the item's containerSlot flag, NOT the
      // container's content array — which the render SIGNATURE doesn't cover, so
      // a plain render() would sig-skip and the popup keeps the item in its old
      // spot. Invalidate the sig first so the repaint actually happens.
      invalidateRenderSig();
      render();
      return;
    }
    ev.preventDefault();
    clearZones();

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
      // Route through the canonical placement path (mirrors the internal-drag
      // branch above) so repeat compendium drops STACK-MERGE instead of minting
      // new slot-eating docs that eventually overflow to inventory. Honour a
      // targeted compartment (dropSlotKey); otherwise loose by default (hybrid).
      await moveItemToContainer(popupActor, created.id, openContainerPopupId, "grid",
                                dropSlotKey ? { slotKey: dropSlotKey } : {});
      return;
    }

    // Internal drag.
    const source      = ev.dataTransfer.getData("application/x-wou-source");
    /* Fall back to popupActor.id (the container's owner), NOT the visiting
     * character.id — those diverge when the popup is a mount's container
     * being viewed by a character. A missing source-actor tag would
     * otherwise route through the same-actor branch and silently no-op
     * because popupActor.items.get(id) returns undefined. */
    const srcActorId  = ev.dataTransfer.getData("application/x-wou-source-actor") || popupActor.id;
    const id          = await maybeSplitForDrop(ev);
    if (!id) return;

    /* Cross-actor: source lives on a different actor than this popup. */
    if (srcActorId !== popupActor.id) {
      const srcActor = game.actors?.get?.(srcActorId);
      const srcItem  = srcActor?.items?.get(id);
      if (!srcActor || !srcItem) return;
      /* A container carries its own contents — the plain transfer only copies
       * `system.content` UUID strings, which still point at the SOURCE actor's
       * items and become dangling refs on the destination. Route through the
       * container-aware transfer so the stored items travel too. */
      if (srcItem.type === "container") {
        await transferContainerAcrossActors(srcActor, srcItem, popupActor);
      } else {
        await transferAcrossActors(srcActor, srcItem, source, popupActor, openContainerPopupId);
      }
      return;
    }

    /* Same-actor: existing stack-merge / move-into-container path.
     * A slot-targeted drop must go through moveItemToContainer's slot path so
     * the per-slot max is respected — skip the unbounded tryMergeStacks (which
     * would dump the whole stack onto one tile's item). */
    const embContainer = popupActor.items.get(openContainerPopupId);
    const slotDrop = dropSlotKey && embContainer && hasSlotRows(embContainer);
    if (!slotDrop && await tryMergeStacks(popupActor, ev, id, source)) return;
    if (source === `container:${openContainerPopupId}`) return;
    await moveItemToContainer(popupActor, id, openContainerPopupId, source, { spendAction: true, slotKey: dropSlotKey, loose: !dropSlotKey });
    invalidateRenderSig();   // flag-only placement changes aren't in the render sig — force the repaint
    render();
  });

  // Left-click inspects.
  popup.addEventListener("click", (ev) => {
    if (ev.target.closest(".wou-popup-close")) return;
    const slot = ev.target.closest(".wou-slot");
    if (!slot) return;
    selectTile(slot);
  });
  popup.addEventListener("dblclick", (ev) => {
    const slot = ev.target.closest(".wou-slot[data-item-id]");
    if (!slot) return;
    const item = resolveTileItem(slot.dataset.itemId);
    if (!item || item.type === "container") return;
    ev.preventDefault();
    ev.stopPropagation();
    hideHoverCard();
    item.sheet?.render(true);
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
  ui?.notifications?.warn?.(t("WITCHER.Chrome.Inventory.Notify.NoActionsLeft", "No actions left this turn."));
  return false;
}

export async function chargeCombatAction(actor, label) {
  if (!isActorInActiveCombat(actor)) return;
  if (typeof actor?.spendActionSlot !== "function") return;
  try { await actor.spendActionSlot(label); }
  catch (err) { console.warn("witcher-ttrpg-death-march | inventory action-spend failed", err); }
}

export async function moveItemToContainer(actor, itemId, containerId, source, { spendAction = false, slotKey = null, loose = false } = {}) {
  const container = actor.items.get(containerId);
  const item      = actor.items.get(itemId);
  if (!container || !item) return;
  // Refuse dropping a container into itself (or into any container it's
  // an ancestor of) — that would create a UUID cycle and orphan its
  // contents. Cheap depth-1 guard: item === container is the common case.
  if (item.id === container.id) return;
  // Stowing is a combat action — block (and abort) when no slot is left.
  if (spendAction && !canSpendCombatAction(actor)) return;

  const stackQty0 = Number(item.system?.quantity) || 1;

  /* Aimed at a specific compartment that WON'T take this item → reject outright
   * instead of silently auto-placing it elsewhere. Enforces the compartment's
   * type/subtype/size/weight rule at the exact tile the user targeted. */
  if (slotKey && hasSlotRows(container) && !slotAcceptsItem(container, slotKey, item)) {
    ui?.notifications?.warn?.(t("WITCHER.Chrome.Inventory.Notify.SlotRejectsItem", "That compartment doesn't accept this item."));
    return;
  }

  /* Slot-targeted drop: the user dropped onto a SPECIFIC compartment tile
   * (data-slot-key = "row:slot"). Fill THAT exact tile to its per-slot max,
   * pinning the placed units there with a `containerSlot` flag so assignToRows
   * keeps them in the tile the user chose. */
  if (slotKey && hasSlotRows(container) && slotAcceptsItem(container, slotKey, item)) {
    const info    = describeSlot(container, slotKey);
    const occ     = slotOccupant(container, slotKey);
    const perSlot = Math.max(1, info?.stackMax || 1);
    const sameItem = occ && occ.item?.type === item.type && occ.item?.name === item.name;
    if (occ && !sameItem) {
      ui?.notifications?.warn?.(t("WITCHER.Chrome.Inventory.Notify.SlotOccupied", "That slot already holds a different item."));
      return;
    }
    const room = perSlot - (occ ? occ.qty : 0);
    if (room <= 0) {
      ui?.notifications?.warn?.(t("WITCHER.Chrome.Inventory.Notify.SlotFull", "That slot is full."));
      return;
    }
    const addN = Math.min(room, stackQty0);
    // Top up the doc already pinned to THIS exact slot; otherwise mint a new
    // doc pinned to the slot (don't merge into an auto item elsewhere).
    let target = null;
    if (sameItem && occ.item?.id !== item.id
        && occ.item?.flags?.[MODULE_ID]?.containerSlot === slotKey) {
      target = occ.item;
    }
    const content = container.system?.content ?? [];
    if (target) {
      await target.update({ "system.quantity": (Number(target.system?.quantity) || 0) + addN });
    } else {
      const data = item.toObject(false);
      delete data._id;
      /* Effects are CARRIED, not dropped. This is a relocation: the source doc
       * is drawn down and deleted below once the whole stack is placed, so
       * anything stripped here is destroyed outright (an applied oil's
       * temporaryItemImprovement effect, a consumable's own effects).
       * Contrast the peel-off sites (maybeSplitForDrop, the oil/ammo/armor
       * spinoffs) — those mint an ADDITIONAL plain unit while the source
       * survives, so stripping there is correct. */
      data.system  = { ...(data.system ?? {}), quantity: addN, isStored: true, equipped: false };
      if (!data.flags) data.flags = {};
      data.flags[MODULE_ID] = { ...(data.flags[MODULE_ID] ?? {}), containerSlot: slotKey };
      const [created] = await actor.createEmbeddedDocuments("Item", [data]);
      if (created) await container.update({ "system.content": [...content, created.uuid] });
    }
    // Draw down the source; delete it when the whole stack was placed so no
    // 0-qty ghost lingers on the grid.
    if (stackQty0 - addN > 0) await item.update({ "system.quantity": stackQty0 - addN });
    else {
      for (const c of actor.items) {
        if (c.type !== "container") continue;
        const refs = c.system?.content ?? [];
        if (refs.includes(item.uuid) || refs.includes(item.id)) {
          await c.update({ "system.content": refs.filter(u => u !== item.uuid && u !== item.id) });
        }
      }
      await item.delete();
    }
    if (spendAction) await chargeCombatAction(actor, `Stow: ${item.name}`);
    return;
  }

  /* Loose is the DEFAULT destination for a HYBRID container: unless the user
   * dropped onto a specific compartment tile (slotKey), the stack goes to the
   * general pool, pinned "loose" so assignToRows never pulls it into a
   * compartment. Compartments are only filled by an explicit slot-targeted drop.
   * Enter here when the item fits the loose pool (auto default) OR when a loose
   * drop was explicitly requested; an explicit loose drop that DOESN'T fit is
   * rejected below, while an auto drop that doesn't fit loose falls through to
   * compartment auto-fill so nothing is stranded. Slots-only containers have no
   * loose pool (never hybrid), so they always fall through to auto-fill. */
  const _alreadyInThisContainer = (container.system?.content ?? []).some(r => r === item.uuid || r === item.id);
  if (!slotKey && getContainerCfg(container).capacityMode === "hybrid" && (loose || _alreadyInThisContainer || fitsGeneralPool(container, item))) {
    // The loose pool obeys the general-space rules (accept whitelist, per-rule
    // size/weight caps, weight capacity) — a loose drop is NOT a free-for-all.
    // BUT an item already inside THIS container (a compartment→loose relocation)
    // isn't a new addition, so it's never capacity-rejected — it already counts.
    if (!_alreadyInThisContainer && !fitsGeneralPool(container, item)) {
      ui?.notifications?.warn?.(t("WITCHER.Chrome.Inventory.Notify.LooseRejectsItem", "The loose space won't accept this item (size, weight, or type rule)."));
      return;
    }
    if (spendAction && !canSpendCombatAction(actor)) return;
    const content = container.system?.content ?? [];
    // NO force-merge: items placed in loose stay their OWN documents, exactly
    // like the Inventory Chrome (potions/food/etc. don't stack into one
    // another). Each drop or compartment→loose move lands as a separate item.
    const batch = [];
    for (const c of actor.items) {
      if (c.type !== "container" || c.id === container.id) continue;
      const refs = c.system?.content ?? [];
      if (refs.includes(item.uuid) || refs.includes(item.id))
        batch.push({ _id: c.id, "system.content": refs.filter(u => u !== item.uuid && u !== item.id) });
    }
    if (!content.includes(item.uuid)) batch.push({ _id: container.id, "system.content": [...content, item.uuid] });
    const itemPatch = { _id: item.id, [`flags.${MODULE_ID}.containerSlot`]: "loose" };
    if (!item.system?.isStored) itemPatch["system.isStored"] = true;
    if (item.system?.equipped)  itemPatch["system.equipped"] = false;
    batch.push(itemPatch);
    await actor.updateEmbeddedDocuments("Item", batch);
    if (spendAction) await chargeCombatAction(actor, `Stow: ${item.name}`);
    return;
  }

  /* Drop into a compartmented container: one drop fills the NEXT slot to its
   * max (tops a partial same-item slot, else fills a fresh slot to the per-slot
   * max). The rest of the dragged stack stays at the source, so you drop again
   * for the next slot. Units merge into the container's existing stack of that
   * item (keep-one-stack); the display spreads it across slots. Only taken when
   * a compartment has room — otherwise fall through (hybrid routes the whole
   * stack to loose space). */
  const stackQty = Number(item.system?.quantity) || 1;
  const topN = (hasSlotRows(container) && stackQty > 1) ? unitsToTopNextSlot(container, item) : 0;
  if (topN > 0) {
    const addN = Math.min(topN, stackQty);
    const content = container.system?.content ?? [];
    let target = null;
    for (const ref of content) {
      // content refs are UUIDs — actor.items.get() needs an id, so resolve
      // via fromUuidSync (fall back to a bare-id get for legacy refs).
      let inner = null;
      try { inner = (typeof fromUuidSync === "function") ? fromUuidSync(ref) : null; } catch (_) { inner = null; }
      if (!inner) inner = actor.items.get(ref);
      // Only merge into an AUTO (unpinned) doc. Merging into a slot-pinned doc
      // would inflate it past its single slot's cap and hide the overflow.
      if (inner && inner.id !== item.id && inner.type === item.type && inner.name === item.name
          && !inner.flags?.[MODULE_ID]?.containerSlot) { target = inner; break; }
    }
    // Place the units into the container FIRST (source still intact for the
    // toObject copy), then draw the source down.
    if (target) {
      await target.update({ "system.quantity": (Number(target.system?.quantity) || 0) + addN });
    } else {
      const data = item.toObject(false);
      delete data._id;
      /* Relocation — carry the effects. See the note in the slot-targeted
       * branch above: the source doc is deleted once the stack has moved. */
      data.system = { ...(data.system ?? {}), quantity: addN, isStored: true, equipped: false };
      const [created] = await actor.createEmbeddedDocuments("Item", [data]);
      if (created) await container.update({ "system.content": [...content, created.uuid] });
    }
    // Draw down the source; when the whole stack moved, detach it from every
    // other container and delete it — otherwise a 0-qty ghost lingers (and
    // Number(qty)||1 would render it as a phantom unit).
    if (stackQty - addN > 0) {
      await item.update({ "system.quantity": stackQty - addN });
    } else {
      for (const c of actor.items) {
        if (c.type !== "container") continue;
        const refs = c.system?.content ?? [];
        if (refs.includes(item.uuid) || refs.includes(item.id))
          await c.update({ "system.content": refs.filter(u => u !== item.uuid && u !== item.id) });
      }
      await item.delete();
    }
    if (spendAction) await chargeCombatAction(actor, `Stow: ${item.name}`);
    return;
  }

  /* Reject if the container would overflow its capacity — leaves the item where
   * it started (still equipped / in its previous container / in the grid). */
  if (!fitsInContainer(container, item)) {
    ui?.notifications?.warn?.(overflowWarning(container, item));
    return;
  }
  /* Collect EVERY change into ONE updateEmbeddedDocuments call — including the
   * removal from the SOURCE (equip slot or old container). Doing a separate
   * `removeItemFromSource` write first meant the item briefly rendered LOOSE
   * (unstored) between the two writes — the "teleport out then back" flicker,
   * and the same glitch when re-dropping an item into the bag it's already in.
   * The prune loop below already detaches the item from its source container,
   * and the item patch clears `equipped`, so one atomic write covers it all. */
  const batch = [];

  /* Detach from EVERY other container that lists this item — this is what
   * removes it from its source bag, and also cleans up any stale duplicate refs
   * (legacy drop / sheet edit / import out-of-sync). */
  for (const c of actor.items) {
    if (c.type !== "container" || c.id === container.id) continue;
    const refs = c.system?.content ?? [];
    if (!refs.length) continue;
    if (refs.includes(item.uuid) || refs.includes(item.id)) {
      batch.push({ _id: c.id, "system.content": refs.filter(u => u !== item.uuid && u !== item.id) });
    }
  }

  const content = container.system?.content ?? [];
  if (!content.includes(item.uuid)) {   // UUID — the format ContainerData stores
    batch.push({ _id: container.id, "system.content": [...content, item.uuid] });
  }

  const itemPatch = { _id: item.id };
  if (!item.system?.isStored) itemPatch["system.isStored"] = true;
  if (item.system?.equipped)  itemPatch["system.equipped"] = false;
  if (Object.keys(itemPatch).length > 1) batch.push(itemPatch);

  if (batch.length) await actor.updateEmbeddedDocuments("Item", batch);
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
      // Capture the document addItem actually created/merged — returning it is
      // what lets a container drop route THE RIGHT item. The old code ignored
      // this and fell through to a find-by-name below, which returned the first
      // same-name item (often one already stored), so the freshly-added copy
      // was left orphaned in inventory.
      created = await actor.addItem(item, 1);
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

  /* EO armor model gate: a Difficult armor piece can't be donned without
   * a worn arming jack (or a piece with the +100/+750-crown armored
   * upgrade). The check is no-op under RAW (toggle off). Done BEFORE the
   * stack-split so we don't peel a copy onto the actor only to refuse.
   * Imported lazily to keep the inventory module loadable in tests. */
  if (sourceItem.type === "armor"
      && sourceItem.system?.location !== "Shield"
      && sourceItem.system?.armorType !== "shield") {
    /* Shields (legacy armor-modeled OR dedicated shield type) skip the
     * EO gate — Difficult is an armor-piece concept, not a shield one. */
    try {
      const eo = await import("../../mechanics/eoArmorModel.mjs");
      const wornArmor = (actor.items?.contents ?? actor.items ?? [])
        .filter(i => i.type === "armor" && i.system?.equipped
                     && i.system?.location !== "Shield" && i.system?.armorType !== "shield");
      if (!eo.canEquipUnderEoModel(sourceItem, wornArmor)) {
        ui?.notifications?.warn?.(
          `${sourceItem.name} is Difficult armor — you need a worn arming jack (or an armor piece with the arming-jack upgrade) before you can equip it.`
        );
        return null;
      }
    } catch (err) {
      console.warn("witcher-ttrpg-death-march | EO equip gate failed", err);
    }
  }

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

  /* Weapons pick a slot by priority (Main/Right → Off/Left → Quick; two-handers
   * → the two-hand slot) unless the caller passed an explicit preferredSlot,
   * and equip atomically via assignSlot, which runs the conflict check and
   * writes equipped + slot together — so a second one-handed weapon auto-lands
   * on the free hand instead of being rejected. */
  if (sourceItem.type === "weapon" || sourceItem.type === "shield") {
    if (sourceItem.system?.isStored) await sourceItem.update({ "system.isStored": false });
    const slot = (preferredSlot && VALID_SLOTS.includes(preferredSlot))
      ? preferredSlot
      : autoEquipSlot(actor, sourceItem);
    await assignSlot(actor, sourceItem.id, slot);
    return sourceItem;
  }

  /* Armor layering gate — refuse an equip that would break a layering limit
   * (checked BEFORE the write, so nothing to revert). CE enforces the stifling
   * constraint only; RAW enforces the count/type caps too. */
  if (sourceItem.type === "armor" && !sourceItem.system?.equipped
      && layeringEquipBlock(actor, sourceItem, { ceModel: isCESubsystemEnabled?.("eoArmorModel") }).length) {
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

/** True when the item carries an applied oil coating — read off the
 *  formalised `system.appliedOil.name` field (a non-empty name = a live
 *  coating). Used for stack-merge gating: a coated weapon shouldn't
 *  merge with an uncoated stack of the same item. Legacy AE-tagged
 *  coatings (flags.<MODULE_ID>.oilCoating) are also tolerated for
 *  pre-migration items — covered by the second pass below. */
function itemHasOilCoating(item) {
  if (item?.system?.appliedOil?.name) return true;
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
  // Food & drink track freshness/spoilage per-item, so each stays its own
  // document and must never auto-merge into a single stack.
  if (isFoodOrDrink(a) || isFoodOrDrink(b)) return false;
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
  const srcActor = srcActorId ? game.actors?.get?.(srcActorId) : getPanelActor("inventory");
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
  /* Bump target quantity BEFORE deleting source — if target.update rejects
   * (validation, permission, etc.) source.delete never runs and the stack
   * survives. removeItemFromSource still runs first so a rejected merge
   * doesn't leave stale container refs. */
  await removeItemFromSource(actor, source, sourceTag, { spendAction: fromContainer });
  try {
    await target.update({ "system.quantity": tQty + sQty });
  } catch (err) {
    console.warn("witcher-ttrpg-death-march | stack merge target update failed", err);
    return false;
  }
  await source.delete();
  return true;
}

export async function removeItemFromSource(actor, item, source, { spendAction = false } = {}) {
  if (!source || source === "grid") return;
  if (source.startsWith("container:")) {
    const srcId = source.slice("container:".length);
    const src = actor.items.get(srcId);
    if (!src) return;
    // Free when the item sits in a Free-Use slot — checked BEFORE the slot
    // gate so a free take-out isn't blocked when the actor is out of actions.
    if (spendAction && itemInFreeUseSlot(src, item)) spendAction = false;
    // Taking an item out of a container is a combat action — block if no slot.
    if (spendAction && !canSpendCombatAction(actor)) return;
    const content = (src.system?.content ?? []).filter(u => u !== item.uuid && u !== item.id);
    await src.update({ "system.content": content });
    /* Clear BOTH flags in one update. A stored item shouldn't be equipped,
     * but corrupted state (dual-flagged) can happen via legacy imports or
     * sheet edits — leaving equipped=true after take-out lets a container
     * item render as worn on the sheet. */
    const updates = {};
    if (item.system?.isStored) updates["system.isStored"] = false;
    if (item.system?.equipped) updates["system.equipped"] = false;
    if (Object.keys(updates).length) await item.update(updates);
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
  if (tabs) {
    tabs.addEventListener("click", (ev) => {
      const btn = ev.target.closest(".wou-inv-tab");
      if (!btn) return;
      const id = btn.dataset.tab;
      if (!id || id === activeCategory) return;
      activeCategory = id;
      switchCategoryFast();   // swap only the grid area — full render() is too slow
    });
  }
}

/** Fast tab switch: only the category (only the item grids change between tabs),
 *  the rest of the overlay — tabs, container rail, stats/currency/equipped/
 *  portrait/mount — is identical, so rebuilding all of it (full render) is what
 *  made switching laggy. Swap just the .wou-inv-grid-wrap in .wou-inv-left and
 *  re-wire that. Falls back to a full render if the structure isn't as expected. */
function switchCategoryFast() {
  const actor = getPanelActor("inventory");
  const left  = invEl?.querySelector(".wou-inv-left");
  const wrap  = left?.querySelector(".wou-inv-grid-wrap");
  if (!actor || !left || !wrap) { render(); return; }

  // Active-tab chip.
  invEl.querySelectorAll(".wou-inv-tab").forEach(b =>
    b.classList.toggle("is-active", b.dataset.tab === activeCategory));

  // Replace only the category grid area.
  const tmp = document.createElement("div");
  tmp.innerHTML = renderCategoryHTML(actor, collectGridItems(actor));
  const fresh = tmp.firstElementChild;
  if (!fresh) { render(); return; }
  wrap.replaceWith(fresh);

  // Re-wire only the left category grids; the containers rail/grid are untouched.
  for (const w of left.querySelectorAll(".wou-inv-grid-wrap")) wireGridWrap(w, actor);
  alignContainersColumn();
  padGridFillers();
  requestAnimationFrame(() => { if (isInventoryOpen()) { alignContainersColumn(); padGridFillers(); } });
  reobserveInventoryLayout();   // the left grid-wrap was just replaced
  fitTallIcons();               // zoom each 2:1 icon to its subject
  // Keep the render sig in step so a later data-driven render doesn't needlessly
  // rebuild everything (activeCategory is part of the sig).
  _lastRenderSig = computeRenderSig(actor);
}

function wireSortControl(actor) {
  /* Items auto-sort, so the dropdown just picks the sort MODE and applies it
   * immediately (no separate Sort button, no manual layout to overwrite). */
  const select = invEl.querySelector('.wou-inv-sort select[data-bind="sort"]');
  if (select && actor) {
    select.addEventListener("change", async (ev) => {
      const sortKey = ev.target.value;
      pendingSort = sortKey;
      try {
        await actor.setFlag(MODULE_ID, GLOBAL_SORT_FLAG, sortKey);   // updateActor hook re-renders
      } catch (err) {
        console.warn(`${MODULE_ID} | could not apply inventory sort`, err);
      }
    });
  }
  // Legacy "Sort" button (if still rendered) just forces a re-render — everything
  // is already sorted, so there's nothing to recompute.
  invEl.querySelector('.wou-inv-sort-btn[data-action="apply-sort"]')
    ?.addEventListener("click", () => { invalidateRenderSig(); render(); });
}

/** Drag-place a tile at the grid ADDRESS it's dropped on — absolute, nothing else
 *  moves. A 1:1 takes the target address (or the next free one after it). A 2:1
 *  needs BOTH the target address AND the one directly below free, else the drop is
 *  rejected (snap back). Only the dragged item's address changes; cells are
 *  positioned explicitly in padGridFillers so nothing repacks. Persists a
 *  { itemId: slot } map. Cross-sub-grid drops are a no-op. */
async function placeInSlot(actor, ev, draggedId) {
  const dragged = actor?.items?.get(draggedId);
  const sub = categorizeItem(dragged)?.sub;
  if (!sub) return false;
  const gridEl = ev.target?.closest?.(".wou-inv-subgrid-grid");
  if (!gridEl || gridEl.dataset.subgrid !== sub) return false;   // foreign panel → not a placement
  const targetCell = ev.target?.closest?.("[data-slot]");
  const targetSlot = targetCell ? Number(targetCell.dataset.slot) : NaN;
  if (!Number.isInteger(targetSlot)) return false;

  const cols = subgridGeometry(gridEl)?.cols ?? colsFor(sub);

  // OTHER items' addresses + the cells COVERED by a tall tile's lower half.
  const slotOf  = {};
  const taken   = new Set();
  const covered = new Set();
  let maxSlot   = -1;
  for (const tile of gridEl.querySelectorAll(".wou-slot[data-item-id][data-slot]")) {
    const id = tile.dataset.itemId;
    const s  = Number(tile.dataset.slot);
    if (tile.classList.contains("wou-slot--tall") && id !== draggedId) covered.add(s + cols);
    if (id === draggedId) continue;              // dragged item's own cell frees up
    slotOf[id] = s;
    taken.add(s);
  }
  for (const cell of gridEl.querySelectorAll("[data-slot]")) {
    const s = Number(cell.dataset.slot);
    if (Number.isInteger(s) && s > maxSlot) maxSlot = s;
  }
  const blocked = (s) => taken.has(s) || covered.has(s);
  const tall    = isTallItem(dragged);
  // A 2:1 needs BOTH its address AND the one below clear (and the below one must
  // be a rendered cell, not the last row). A 1:1 needs just its own address.
  const fits = (s) => !blocked(s) && (!tall || (s + cols <= maxSlot && !blocked(s + cols)));

  // Absolute: drop only where it fits. A 2:1 whose two cells aren't both free is
  // rejected outright (snap back) — no reordering. A 1:1 falls to the next free
  // cell after its target only when the exact target is taken.
  let dest = targetSlot;
  if (!fits(dest)) {
    if (tall) return true;                        // 2:1: both cells must be clear
    dest = -1;
    for (let s = targetSlot + 1; s <= maxSlot; s++) { if (fits(s)) { dest = s; break; } }
    if (dest < 0) return true;                     // no free cell → snap back
  }
  slotOf[draggedId] = dest;

  // OPTIMISTIC MOVE — the whole point of responsiveness. Re-address the tile in
  // the DOM RIGHT NOW (swap it with the filler that was at the destination) and
  // re-flow this grid locally, so the drop lands instantly instead of waiting on
  // the async persist + full re-render.
  const movedTile = gridEl.querySelector(`.wou-slot[data-item-id="${CSS.escape(draggedId)}"]`);
  const oldSlot   = movedTile ? Number(movedTile.dataset.slot) : NaN;
  if (movedTile) {
    movedTile.classList.remove("is-dragging");
    if (Number.isInteger(oldSlot) && oldSlot !== dest) {
      movedTile.dataset.slot = String(dest);
      const destFiller = gridEl.querySelector(`.wou-slot.is-empty[data-slot="${dest}"]`);
      if (destFiller) {
        destFiller.dataset.slot = String(oldSlot);   // the filler takes the vacated address
      } else {
        const f = document.createElement("div");     // no filler there → make one for the old cell
        f.className = "wou-slot is-empty is-pad";
        f.dataset.slot = String(oldSlot);
        gridEl.appendChild(f);
      }
    }
    padGridFillers();   // re-position both from their new addresses (fast, one grid pass)
  }

  // Persist in the BACKGROUND — the DOM already shows the result. When the write
  // lands, suppress the redundant full re-render: pin _lastRenderSig to the new
  // state so the updateActor hook's render() short-circuits (the DOM already
  // matches). Any OTHER change bumps the sig and still renders normally.
  actor.setFlag(MODULE_ID, LAYOUT_FLAG, { ...getLayout(actor), [sub]: slotOf })
    .then(() => { const a = getPanelActor("inventory"); if (a) _lastRenderSig = computeRenderSig(a); })
    .catch((err) => { console.warn(`${MODULE_ID} | could not persist slot placement`, err); invalidateRenderSig(); });
  return true;
}

function wireItemGrid(actor) {
  if (!actor) return;
  // Wire EVERY grid wrap — the category grids AND the always-open Containers
  // grid — so drag-reorder / select / dbl-click work uniformly in both.
  for (const wrap of invEl.querySelectorAll(".wou-inv-grid-wrap")) {
    wireGridWrap(wrap, actor);
  }
}

function wireGridWrap(wrap, actor) {
  if (!wrap || !actor) return;

  // Left-click sets the inspected item (drives the panel below the grid).
  // The item sheet is reachable via the right-click "Edit" entry.
  wrap.addEventListener("click", (ev) => {
    const slot = ev.target.closest(".wou-slot[data-item-id]");
    if (!slot) return;
    const item = actor?.items?.get(slot.dataset.itemId);
    // Single-click opens a container as a floating popup (same as the equipped
    // rail containers); any other item just gets selected.
    if (item?.type === "container") { hideHoverCard(); openContainerFloating(slot.dataset.itemId, slot); return; }
    selectTile(slot);
  });

  // Double-left-click opens the item's sheet (its "display window"). Containers
  // open on single-click, so their sheet stays on the right-click "Edit" entry.
  wrap.addEventListener("dblclick", (ev) => {
    const slot = ev.target.closest(".wou-slot[data-item-id]");
    if (!slot) return;
    const item = actor?.items?.get(slot.dataset.itemId);
    if (!item || item.type === "container") return;
    ev.preventDefault();
    ev.stopPropagation();
    hideHoverCard();
    item.sheet?.render(true);
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
    setTileDragImage(ev, slot);
  });
  wrap.addEventListener("dragend", (ev) => {
    releaseDragTile(ev);
    _lastDropCell = null;
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
    // preventDefault on every dragover is what registers the whole grid as a
    // valid drop zone — without it the cursor shows the "forbidden" (no-drop)
    // badge. Always resolve to a move/copy effect so the pointer never reads as
    // rejected while a tile is in hand.
    ev.preventDefault();
    ev.dataTransfer.dropEffect = currentDragSource ? "move" : "copy";

    /* Container-in-grid drop-target visual feedback. The wrap's drop
     * handler at line 5285+ already stows an item into a container
     * dropped on in the grid (works for containers whether they're
     * on the rail or loose), but nothing was decorating the target
     * slot on dragover — users reported "dragging into a grid
     * container doesn't work" because they couldn't see it as a
     * valid target and thought the interaction was disabled. Add
     * the same `is-drop-target` class the rail already uses so the
     * cursor gets the same visual affordance whether the container
     * is railed or loose. */
    const slot = ev.target?.closest?.(".wou-slot[data-item-id]");
    const targetId = slot?.dataset?.itemId;
    if (!targetId || targetId === currentDragItemId) return;
    const targetItem = actor?.items?.get(targetId);
    if (targetItem?.type !== "container") return;
    /* Clear any stale is-drop-target from other slots so only the
     * currently-hovered one glows. */
    for (const s of wrap.querySelectorAll(".wou-slot.is-drop-target")) {
        if (s !== slot) s.classList.remove("is-drop-target");
    }
    slot.classList.add("is-drop-target");
  });
  wrap.addEventListener("dragleave", (ev) => {
    /* Only clear when the pointer actually left the slot — dragleave
     * fires as the pointer moves between the slot and its children,
     * and we don't want the highlight to flicker in that gap. */
    const slot = ev.target?.closest?.(".wou-slot");
    if (!slot) return;
    const related = ev.relatedTarget;
    if (related && slot.contains(related)) return;
    slot.classList.remove("is-drop-target");
  });
  wrap.addEventListener("drop", async (ev) => {
    ev.preventDefault();
    /* Clear any drop-target / placement-preview highlight from the dragover
     * feedback above — otherwise a completed drop leaves it stuck on the slot. */
    for (const s of wrap.querySelectorAll(".wou-slot.is-drop-target, .wou-slot.is-drop-here")) {
        s.classList.remove("is-drop-target", "is-drop-here");
    }

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
      ui?.notifications?.info?.(t("WITCHER.Chrome.Inventory.Notify.OpenMountInventory", "Open the mount's inventory (click its portrait) to take a container out."));
      return;
    }

    if (!ev.dataTransfer.getData("application/x-wou-source")) {
      /* Early action-slot gate — refuse foreign drops OUTRIGHT when the
       * actor can't spend a combat action, before tryForeignItemDrop
       * even runs. tryForeignItemDrop enforces the same gate, but
       * doing it here means the user sees a single "No actions left"
       * toast with zero item-creation flicker. */
      if (!canSpendCombatAction(actor)) return;
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

    /* NOTE: intra-grid drag-to-reorder is GONE — items auto-sort within their
     * sub-grid (see assignSlots). Dropping a grid item onto another grid item in
     * the SAME sub-grid is a no-op (swallow it so it doesn't fall through to
     * container-nesting), unless it's a stack merge (handled above). */
    if (source === "grid" && !ev.dataTransfer.getData("application/x-wou-split")) {
      const overSlot = ev.target.closest?.(".wou-slot");
      const overGrid = overSlot?.closest?.(".wou-inv-subgrid-grid");
      const draggedItem = actor.items.get(id);
      const overItem = overSlot?.dataset?.itemId ? actor.items.get(overSlot.dataset.itemId) : null;
      // Same sub-grid (and not dropping onto a container) → nothing to do.
      if (overGrid && overGrid.dataset.subgrid === categorizeItem(draggedItem)?.sub
          && overItem?.type !== "container") return;
    }

    /* Drop onto a CONTAINER item — stow the source item into that container.
     * Reached for CROSS-sub-grid drops (e.g. a potion dropped on a container
     * tile), since a same-grid reorder already returned above. */
    const dropSlot = ev.target.closest?.(".wou-slot[data-item-id]");
    const dropTargetId = dropSlot?.dataset?.itemId;
    const dropTarget = dropTargetId ? actor.items.get(dropTargetId) : null;
    if (dropTarget && dropTarget.type === "container" && dropTargetId !== id) {
        // Dropping onto the container's grid tile = container CLOSED, no slot
        // aimed at → route hybrids to loose (matches the rail drop and the
        // "closed drop = loose for hybrid" rule). `loose` is ignored by slots-
        // only / general containers.
        await moveItemToContainer(actor, id, dropTargetId, source, { spendAction: source === "grid" || source.startsWith("equip:"), loose: true });
        return;
    }

    if (source === "grid") return;   // a grid drop that wasn't a reorder → no-op
    const item = actor.items.get(id);
    if (!item) return;
    const fromContainer = source.startsWith("container:");
    const fromEquip     = source.startsWith("equip:");
    // A drawn weapon can't be set loose in hand mid-combat — it must be
    // sheathed/stowed into a container (drag it onto a container) or dropped.
    if (fromEquip && item.type === "weapon" && isActorInActiveCombat(actor)) {
      ui?.notifications?.warn?.(t("WITCHER.Chrome.Inventory.Notify.CantUnequipInCombat", "Can't unequip a weapon mid-combat — sheathe it into a container or drop it."));
      return;
    }
    // Pulling an item out of a container (Take out) and unequipping an equipped
    // item by dragging it to the grid both cost a combat action — UNLESS the
    // item is in a free-draw container (bandolier) or a Quick-Use slot, which
    // make the take-out free.
    let takeOutFree = false;
    if (fromContainer) {
      const src = actor.items.get(source.slice("container:".length));
      takeOutFree = !!src && itemInFreeUseSlot(src, item);
    }
    if ((fromContainer || fromEquip) && !takeOutFree && !canSpendCombatAction(actor)) return;
    await removeItemFromSource(actor, item, source);
    if (fromContainer && !takeOutFree) await chargeCombatAction(actor, `Take out: ${item.name}`);
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
      selectTile(slot);
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
    expected === "weapon" ? (type === "weapon" || type === "shield")
  : expected === "armor"  ? (type === "armor" || type === "focus")   // foci occupy armor slots
  : type === expected;
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
            ui?.notifications?.warn?.(t("WITCHER.Chrome.Inventory.Notify.CantEquipLooseInCombat", "Can't equip a loose weapon or shield in combat — draw it from a container."));
            return;
          }
        }
        /* Early action-slot gate — reject the drop OUTRIGHT if the actor
         * can't spend a combat action right now, BEFORE the item is
         * created. Without this, tryForeignItemDrop still refuses (its
         * own canSpendCombatAction check catches the same case), but
         * user-visible timing was "item briefly appears / then refused"
         * on some UI rebuild orders. Doing the gate here makes the drop
         * a pure no-op with a single "No actions left" toast. */
        if (!canSpendCombatAction(actor)) return;
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
        ui?.notifications?.warn?.(t("WITCHER.Chrome.Inventory.Notify.CantEquipLooseInCombatMsg", "Can't equip a loose weapon or shield in combat — draw it from a container."));
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
      const costsAction = !fromEquip && (fromContainer || item.type === "armor" || item.type === "focus") && !freeShield;
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
/* Returns true when the weapon was actually drawn/equipped, false on any refusal
 * (out of actions, equip conflict). Sidebar world-item callers rely on this to
 * roll back the clone they made so a refused draw can't leave a free copy in
 * the actor's inventory. */
export async function drawWeapon(actor, item, { spendAction = true } = {}) {
  if (!actor || !item || (item.type !== "weapon" && item.type !== "shield")) return false;

  // Resolve the holding container up front. A free-draw container (bandolier)
  // draws at no action cost, so we must know this BEFORE the action-slot gate
  // — otherwise a free draw would be wrongly refused when the actor is out of
  // actions.
  const containerId = findContainerHoldingItem(actor, item.id);
  const srcContainer = containerId ? actor.items.get(containerId) : null;
  // Free when the weapon sits in a Free-Use slot.
  if (spendAction && srcContainer && itemInFreeUseSlot(srcContainer, item)) spendAction = false;

  // Drawing in combat is an action — refuse the draw outright with no slot left.
  if (spendAction && !canSpendCombatAction(actor)) return false;

  const slot = autoEquipSlot(actor, item);
  const occ  = occupancyForSlot(item, slot) ?? "right";

  // Pre-check BEFORE touching the container or equip state. If the equip
  // would conflict, abort early so the weapon stays inside its container
  // instead of being yanked out and left dangling on the grid.
  const check = checkEquipConflicts(actor, item.id, occ);
  if (!check.ok) {
    ui?.notifications?.warn?.(describeEquipFailure(item.name, check));
    return false;
  }

  if (containerId) {
    try { await item.setFlag(MODULE_ID, LAST_CONTAINER_FLAG, containerId); } catch {}
    await removeItemFromSource(actor, item, `container:${containerId}`);
  }
  await assignSlot(actor, item.id, slot);
  // "Drew" only fits pulling from a sheath/container; a loose item is "Equipped".
  ui?.notifications?.info?.(containerId ? `Drew ${item.name}.` : `Equipped ${item.name}.`);

  // Drawing a weapon is a single action (Core p.151). Spend a slot only
  // inside an active combat the actor is part of. Fast Draw is the exception
  // — it folds the draw into the attack and passes spendAction:false. Bandolier
  // free-draw already zeroed spendAction above.
  // Manticore: drawing/equipping a shield-type item is free.
  const freeShield = isShieldItem(item) && (Number(actor?.system?.combatMods?.freeShieldEquip) || 0) > 0;
  if (spendAction && !freeShield) await chargeCombatAction(actor, `Draw: ${item.name}`);
  return true;
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
    name: t("WITCHER.Chrome.Inventory.Text.Equip", "Equip"),
    icon: '<i class="fa-solid fa-hand-fist"></i>',
    condition: (li) => {
      const item = resolveSidebarItem(li);
      if (!item || item.type !== "weapon") return false;
      const actor = getPanelActor("inventory");
      return !!(actor && actor.isOwner);
    },
    callback: async (li) => {
      const item = resolveSidebarItem(li);
      const actor = getPanelActor("inventory");
      if (!item || !actor) return;
      // Pre-check using a synthetic id (the world item's id won't match
      // anything on the actor — checkEquipConflicts simply excludes the
      // supplied id from its iteration). Try EVERY slot the item could
      // legitimately occupy: 2H → "both"; 1H → right/left, plus quick
      // for a quick weapon. Only refuse when every candidate conflicts —
      // otherwise autoEquipSlot inside drawWeapon will pick the winner
      // once the clone exists. Fixes the case where a right-hand-busy
      // actor couldn't equip a quick weapon off the floor even though
      // the quick slot was free.
      const candidateSlots = item.system?.hands === "two"
        ? ["both"]
        : (isQuickItem(item) ? ["right", "left", "quick"] : ["right", "left"]);
      let firstCheck = null;
      let anyOk = false;
      for (const slot of candidateSlots) {
        const check = checkEquipConflicts(actor, "__pre_clone__", slot);
        if (!firstCheck) firstCheck = check;
        if (check.ok) { anyOk = true; break; }
      }
      if (!anyOk) {
        ui?.notifications?.warn?.(describeEquipFailure(item.name, firstCheck));
        return;
      }
      const cloned = await cloneItemToActor(actor, item);
      if (cloned) {
        const ok = await drawWeapon(actor, cloned);
        // Refused (no free hand / out of actions) → roll back the clone so the
        // world item isn't silently dumped into inventory for free.
        if (ok) await claimWorldItem(item);
        else { try { await cloned.delete(); } catch (_) {} }
      }
    }
  };
}

/** Right-click → Stow. Clones the world item onto the assigned actor's
 *  general inventory (no container, not equipped). */
function buildSidebarStowEntry() {
  return {
    name: t("WITCHER.Chrome.Inventory.Text.Stow", "Stow"),
    icon: '<i class="fa-solid fa-box"></i>',
    condition: (li) => {
      const item = resolveSidebarItem(li);
      if (!item) return false;
      const actor = getPanelActor("inventory");
      return !!(actor && actor.isOwner);
    },
    callback: async (li) => {
      const item = resolveSidebarItem(li);
      const actor = getPanelActor("inventory");
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
    name: t("WITCHER.Chrome.Inventory.Text.Sheathe", "Sheathe"),
    icon: '<i class="fa-solid fa-box-archive"></i>',
    condition: (li) => {
      const item = resolveSidebarItem(li);
      if (!item || item.type !== "weapon") return false;
      const actor = getPanelActor("inventory");
      if (!actor || !actor.isOwner) return false;
      // Need at least one container equipped on the rail; off-rail
      // containers are unreachable for draw, so we don't sheath into them.
      const railed = new Set(getRail(actor).assignments.filter(Boolean));
      if (railed.size === 0) return false;
      return !!actor.items.find(i => i.type === "container" && railed.has(i.id));
    },
    callback: async (li) => {
      const item = resolveSidebarItem(li);
      const actor = getPanelActor("inventory");
      if (!item || !actor) return;
      const cloned = await cloneItemToActor(actor, item);
      if (cloned) {
        const ok = await sheathWeapon(actor, cloned);
        // Refused (destination container full / out of actions) → roll back the
        // clone so the world item isn't silently dumped into inventory for free.
        if (ok) await claimWorldItem(item);
        else { try { await cloned.delete(); } catch (_) {} }
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
 *  Items collection. World items require GM permission to create — players
 *  can't hit `Item.create()` against the world collection directly — so
 *  the request is routed through the GM socket (`emitDropItemToWorld`),
 *  which snapshots the item, creates the world copy with default-OWNER
 *  ownership (any player can pick it up), and removes the original from
 *  the source actor (including from any container's content list).
 *
 *  GM callers short-circuit past the socket via `isActiveGM` inside the
 *  emitter, so this stays synchronous-ish for the common case. */
export async function dropWeaponToWorld(actor, item) {
  if (!actor || !item) return;
  const { emitDropItemToWorld } = await import("../../setup/socketHook.mjs");
  /* Fire-and-forget: emitter returns void whether it goes direct-GM or
   * over the socket, so we can't await the created id here. Notify
   * optimistically — the GM handler's soft failures log a warning. */
  emitDropItemToWorld({ sourceActorUuid: actor.uuid, itemId: item.id });
  ui?.notifications?.info?.(`Dropped ${item.name} to the world.`);
}

/** Sheathe a weapon. Restore it to whichever container makes sense:
 *  1) the container it was drawn FROM (if that container still exists on
 *     this actor) — tracked via the lastContainer flag set in drawWeapon;
 *  2) otherwise, the first container the actor has;
 *  3) otherwise, just unequip the weapon. */
/* Returns true when the weapon was actually sheathed (into a container, or left
 * loose when the actor has no railed container), false on any refusal (Fast
 * Draw active, out of actions, destination container full). Sidebar world-item
 * callers use this to roll back the clone they made so a refused sheathe can't
 * leave a free copy in the actor's inventory. */
export async function sheathWeapon(actor, item) {
  if (!actor || !item || (item.type !== "weapon" && item.type !== "shield")) return false;

  // Fast Draw means you snap-drew a weapon and must attack with it this turn —
  // you can't sheathe until the status clears (start of your next turn).
  if (actor.statuses?.has?.("fastDraw")) {
    ui?.notifications?.warn?.(t("WITCHER.Chrome.Inventory.Notify.CantSheatheFastDraw", "Can't sheathe while Fast Draw is active — you must attack with the drawn weapon this turn."));
    return false;
  }

  // Sheathing in combat is an action — refuse the sheathe outright with no slot.
  if (!canSpendCombatAction(actor)) return false;

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
    return false;
  }

  /* Single item update for both equipped/isStored — splitting them caused
   * two update broadcasts (and two re-render passes on inventory listeners)
   * with brief inconsistent state between them, which made it look like the
   * weapon "disappeared" mid-flight. Keep `hands` alone so the weapon
   * remembers its preferred hand for the next Draw. */
  if (target) {
    const content = target.system?.content ?? [];
    if (!content.includes(item.uuid) && !content.includes(item.id)) {
      await target.update({ "system.content": [...content, item.uuid] });
    }
    await item.update({ "system.equipped": false, "system.isStored": true });
    /* Surface the destination visibly — the previous toast was easy to miss
     * and the weapon disappearing from the inventory grid (because stored
     * items are nested inside their container) reads as "lost". */
    ui?.notifications?.info?.(`Sheathed ${item.name} in ${target.name}. Open ${target.name} to find it.`);
  } else {
    if (item.system?.equipped) {
      await item.update({ "system.equipped": false });
    }
    ui?.notifications?.info?.(`Sheathed ${item.name}. (No railed container — it's loose in your inventory.)`);
  }

  // Sheathing a weapon is a single action (Core p.151), same as drawing. Note
  // that *dropping* a weapon (dropWeaponToWorld) is free — it costs no action.
  await chargeCombatAction(actor, `Sheathe: ${item.name}`);
  return true;
}

/** Right-click → Draw menu entry. Only appears on weapons that currently
 *  live inside one of the actor's own containers — you can't Draw a
 *  weapon that's just lying loose on your grid or already equipped. */
function buildDrawEntry(owner) {
  const ctx = owner ?? this;
  return {
    name: t("WITCHER.Chrome.Inventory.Text.Draw", "Draw"),
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
    name: t("WITCHER.Chrome.Inventory.Text.Equip", "Equip"),
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
    name: t("WITCHER.Chrome.Inventory.Text.Sheathe", "Sheathe"),
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
    name: t("WITCHER.Chrome.Inventory.Text.Open", "Open"),
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
    name: t("WITCHER.Chrome.Inventory.Text.DropOnScene", "Drop on Scene"),
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
    ui?.notifications?.warn?.(t("WITCHER.Chrome.Inventory.Notify.NoActiveScene", "No active scene to drop into."));
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
   * re-invokes `getPanelActor("inventory")` — a frozen value would break right-click
   * the moment the GM switched view-as actors (condition callbacks would look
   * up items on the wrong/null actor and every condition would return false). */
  const helper = Object.create(proto);
  Object.defineProperty(helper, "actor", {
    get: () => getPanelActor("inventory"),
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
    (itemHtml) => getPanelActor("inventory")?.items?.get(itemHtml?.dataset?.itemId),
    () => getPanelActor("inventory"),
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

/* Convert an oil item's structured oilDuration ({value, units}) into
 * seconds. Returns Infinity when units is empty / unrecognised so the
 * applyOilToWeapon flow can treat it as a "until cleansed" coating
 * (no auto-expiry). Used by both RAW oil application and the source-info
 * dialog summary. */
function oilDurationSeconds(oil) {
  const dur = oil?.system?.oilDuration ?? {};
  const v = Number(dur.value) || 0;
  if (v <= 0) return Infinity;
  const u = String(dur.units || "").toLowerCase();
  if (u === "seconds" || u === "second" || u === "s")  return v;
  if (u === "minutes" || u === "minute" || u === "min" || u === "m") return v * 60;
  if (u === "hours"   || u === "hour"   || u === "hr"  || u === "h") return v * 3600;
  if (u === "days"    || u === "day"    || u === "d")  return v * 86400;
  return Infinity;
}

/* Live coating on a weapon, read off the formalised system.appliedOil
 * SchemaField. Returns null when no oil is applied. Computes a synthesised
 * `dur` object compatible with describeDuration so the existing potion-style
 * display chip ("rounds in combat, wall clock out of it") works unchanged. */
function readOilCoating(weapon) {
  const ao = weapon?.system?.appliedOil;
  if (!ao || !ao.name) return null;
  const now    = game.time?.worldTime ?? 0;
  const exp    = Number(ao.expireAt) || 0;
  const start  = Number(ao.appliedAt) || 0;
  const charges = Number(ao.charges) || 0;
  const effect = ao.oilTarget
    ? `+${ao.oilBonusDamage || 0} vs ${ao.oilTarget}`
    : `+${ao.oilBonusDamage || 0} damage`;
  // Under Alchemy Reborn charges drive expiry; the duration chip shows
  // the charge count instead of seconds-remaining.
  if (charges > 0) {
    const max = Number(ao.maxCharges) || charges;
    return { name: ao.name, img: ao.img || "", effect, dur: { label: `${charges}/${max} charges` } };
  }
  // RAW: time-based. exp = 0 → "until cleansed" (no auto-expiry).
  if (exp > 0 && exp <= now) return null;  // worn off
  if (exp <= 0) return { name: ao.name, img: ao.img || "", effect, dur: { label: t("WITCHER.Chrome.Inventory.Dialog.Button.UntilCleansed", "Until cleansed") } };
  const total     = Math.max(1, exp - start);
  const remaining = Math.max(0, exp - now);
  return { name: ao.name, img: ao.img || "", effect, dur: { seconds: total, secondsRemaining: remaining } };
}

/* Source-side summary of an oil for the apply dialog. Reads the new
 * structured authoring fields directly off the oil item — no AEs to
 * walk anymore. */
function oilSourceInfo(oil) {
  const sys = oil?.system ?? {};
  const totalSecs = oilDurationSeconds(oil);
  const target = String(sys.oilTarget || "").trim();
  const bonus  = Number(sys.oilBonusDamage) || 0;
  const parts = [];
  if (bonus > 0) parts.push(target ? `+${bonus} vs ${target}` : `+${bonus} damage`);
  return {
    // RAW always has an "effect" — the bonus damage. Under Reborn the
    // charges drive applicability, not authored AEs. So an oil is
    // applyable as long as it's an oil-type alchemical, regardless of
    // any AE configuration.
    hasEffect:  true,
    dur:        Number.isFinite(totalSecs) ? { seconds: totalSecs } : null,
    effectText: parts.join(" · ")
  };
}

/* Apply to Weapon — a unified item action, so it shows on the actor sheet,
 * the chrome inventory overlay, AND the Items sidebar. Coating a weapon copies
 * the oil's effect onto a chosen weapon without spending the oil, so running it
 * against a world template (sidebar) is non-destructive. */
function registerApplyOilAction() {
  registerItemAction({
    name: t("WITCHER.Chrome.Inventory.Text.ApplyToWeapon", "Apply to Weapon"),
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

/* Cleanse an applied oil coating. Previously a button in the inspect panel;
 * with the panel replaced by a passive hover card (pointer-events:none) the
 * action moves to the right-click menu. Two entries (weapon vs ammo) so each
 * gets its own verb. */
function registerCleanseOilActions() {
  const cleanse = async (item) => {
    try { await clearOilAndReStack(item); }
    catch (err) { console.warn(`${MODULE_ID} | failed to cleanse oil`, err); }
  };
  registerItemAction({
    name: t("WITCHER.Chrome.Inventory.Text.CleanseBlade", "Cleanse blade"),
    icon: '<i class="fa-solid fa-broom"></i>',
    surfaces: { sidebar: false },
    condition: (item) => item?.type === "weapon" && !!item.system?.appliedOil?.name,
    callback: cleanse
  });
  registerItemAction({
    name: t("WITCHER.Chrome.Inventory.Text.WipeCoating", "Wipe coating"),
    icon: '<i class="fa-solid fa-broom"></i>',
    surfaces: { sidebar: false },
    condition: (item) => item?.type === "ammo" && !!item.system?.appliedOil?.name,
    callback: cleanse
  });
}
registerCleanseOilActions();

async function openCoatWeaponDialog(actor, oil) {
  const info = oilSourceInfo(oil);
  if (!info.hasEffect) {
    ui?.notifications?.warn?.(`${oil.name} has no effect configured — add one (with a duration) on the oil's Effects tab.`);
    return;
  }
  /* Ranged weapons (requiresAmmo) can't be oiled directly — the coating
   * lives on the projectile per Core p.166 ("apply an oil ... to a
   * weapon or arrows"). Filter them out of the weapon list; ammo items
   * take their place as coating targets below, one arrow/bolt at a time. */
  const weapons = actor.items
    .filter(i => i.type === "weapon" && !i.system?.requiresAmmo)
    .sort((a, b) => a.name.localeCompare(b.name));
  const ammoItems = actor.items
    .filter(i => i.type === "ammo" && (Number(i.system?.quantity) || 0) > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!weapons.length && !ammoItems.length) {
    ui?.notifications?.warn?.(t("WITCHER.Chrome.Inventory.Notify.NoWeaponsToCoat", "No weapons or ammunition to coat."));
    return;
  }
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2) return;

  const weaponOptions = weapons.map(w => {
    const existing = readOilCoating(w);
    const label = existing ? `${w.name}  [coated: ${existing.name}]` : w.name;
    return `<option value="w:${escapeAttr(w.id)}">${escapeText(label)}</option>`;
  }).join("");
  /* Ammo options: one line per stack. Coated stacks (a 1-qty spinoff
   * created by a prior coating) surface the oil in the label so the
   * player can tell them apart from plain arrows at a glance. */
  const ammoOptions = ammoItems.map(a => {
    const qty      = Number(a.system?.quantity) || 0;
    const existing = readOilCoating(a);
    const suffix   = existing ? ` (${existing.name})` : "";
    const qtyStr   = qty > 1 ? ` ×${qty}` : "";
    return `<option value="a:${escapeAttr(a.id)}">${escapeText(`${a.name}${suffix}${qtyStr}`)}</option>`;
  }).join("");
  const options = [
    weaponOptions ? `<optgroup label="${escapeAttr(t("WITCHER.Common.Weapons", "Weapons"))}">${weaponOptions}</optgroup>` : "",
    ammoOptions   ? `<optgroup label="${escapeAttr(t("WITCHER.Chrome.Inventory.Text.AmmoCoatsOne", "Ammunition (coats one)"))}">${ammoOptions}</optgroup>` : ""
  ].join("");

  /* Header line describing the oil's remaining capacity.
   *
   *   Alchemy Reborn: duration is meaningless — coatings expire on
   *   `charges`, not clock. Show the running charge count so the player
   *   can tell how many arrows / weapon-hits they've got left. Bottles
   *   partially spent on ammo already carry `currentCharges`; fresh
   *   bottles fall back to the authored `oilCharges` max.
   *
   *   RAW: duration drives expiry; keep the "Lasts N rounds" line. */
  const alchemyRebornOn = isHomebrewEnabled?.("alchemyPotency");
  let lasts;
  if (alchemyRebornOn) {
    const cur = Number(oil.system?.currentCharges) || 0;
    const max = Math.max(1, Number(oil.system?.oilCharges) || OIL_DEFAULT_CHARGES_REBORN);
    const remaining = cur > 0 ? cur : max;
    lasts = `${remaining} charge${remaining === 1 ? "" : "s"} — 1 per arrow, whole bottle per weapon`;
  } else {
    const lastsDur = info.dur ? describeDuration(info.dur) : null;
    lasts = lastsDur && lastsDur.total > 0 ? `Lasts ${lastsDur.label}` : "No duration set — applies until cleansed";
  }
  const content = `
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:10px; padding-bottom:8px; border-bottom:1px solid rgba(140,133,121,0.18);">
      <img src="${escapeAttr(oil.img)}" style="width:32px; height:32px; border-radius:4px;" />
      <div>
        <b>${escapeText(oil.name)}</b>
        <div>${escapeText(lasts)}</div>
        ${info.effectText ? `<div><i>${escapeText(info.effectText)}</i></div>` : ""}
      </div>
    </div>
    <label>Select target to coat:</label>
    <select name="targetId" style="width:100%;">${options}</select>
  `;

  const targetKey = await DialogV2.wait({
    window: { title: tFormat("WITCHER.Dialog.ApplyOil.Weapon", { oil: oil.name }, "Apply Oil: {oil}") },
    content,
    buttons: [
      {
        action: "apply",
        label: t("WITCHER.Chrome.Inventory.Dialog.Button.Coat", "Coat"),
        default: true,
        callback: (event, button) => button.form?.elements?.targetId?.value || null
      },
      { action: "cancel", label: t("WITCHER.Common.Cancel", "Cancel") }
    ],
    rejectClose: false
  }).catch(() => null);

  if (!targetKey || targetKey === "cancel") return;
  /* Route by prefix: "w:<id>" → melee/thrown weapon path;
   *                  "a:<id>" → ammo path (splits a 1-qty spinoff). */
  if (targetKey.startsWith("a:")) {
    const ammo = actor.items.get(targetKey.slice(2));
    if (!ammo) return;
    await applyOilToAmmo(ammo, oil);
    return;
  }
  const weaponId = targetKey.startsWith("w:") ? targetKey.slice(2) : targetKey;
  const weapon = actor.items.get(weaponId);
  if (!weapon) return;
  await applyOilToWeapon(weapon, oil);
  /* Alchemy Reborn: applying an oil costs 1 action (per alch1 "Oil
   * Rework" box: "They can be applied using a combat action"). The
   * spendActionSlot helper short-circuits when no combat is active, so
   * the action only consumes outside-combat → no-op, in-combat → ticks
   * the budget. Skipped when the toggle is off so RAW worlds keep
   * applying oil as a free narrative beat. */
  if (isHomebrewEnabled?.("alchemyPotency")) {
    const actionLabel = game.i18n.format("WITCHER.AlchemyReborn.Oil.ApplyAction", { oil: oil.name });
    try { await actor.spendActionSlot?.(actionLabel); }
    catch (err) { console.warn(`${MODULE_ID} | apply-oil action spend failed`, err); }
  }
}

/* Alchemy Reborn — charges per coating come from the oil item's
 * `system.oilCharges` field (authored per oil, install macro pre-fills
 * Normal=5 / Enhanced=10 / Superior=15 per the source-sheet table).
 * Default to 5 when the field is unset / zero so a freshly-authored oil
 * doesn't deplete on the first hit. */
const OIL_DEFAULT_CHARGES_REBORN = 5;

async function applyOilToWeapon(weapon, oil) {
  /* No more AE-copy. The oil's authoring fields (oilTarget, oilBonusDamage,
   * oilDuration) are stamped onto weapon.system.appliedOil as a snapshot;
   * the combat damage flow reads them directly when resolving a hit and
   * the inventory chip / dock display reads them for the badge. The
   * source oil item still gets consumed (qty -1).
   *
   * Mode split:
   *   Alchemy Reborn (alchemyPotency ON): charges authored on the oil
   *   item itself (`system.oilCharges`) drive expiry. Deducted per
   *   damaging hit by the socketHook handler. No time-based expiry;
   *   expireAt = 0.
   *
   *   RAW (toggle off): time-based expiry only. expireAt = worldTime +
   *   oilDuration seconds. Charges = 0 / maxCharges = 0 (charge path
   *   skipped in handleApplyDamage). */
  const now = game.time?.worldTime ?? 0;
  const alchemyRebornOn = isHomebrewEnabled?.("alchemyPotency");
  const sys = oil.system ?? {};
  /* Reborn: charges authored on the oil item (per source-sheet table).
   * If the bottle has been partially spent on ammo (currentCharges > 0),
   * stamp only what's LEFT onto the weapon — so a 5-charge bottle used
   * to coat 3 arrows can still give a weapon the remaining 2 hits, but
   * can't magically produce 5 fresh hits on top of the arrow uses.
   * RAW: no charges, duration drives expiry instead. */
  const oilChargesAuthored = Math.max(1, Number(sys.oilCharges) || OIL_DEFAULT_CHARGES_REBORN);
  const oilChargesRemaining = Number(sys.currentCharges) || 0;
  const oilMaxCharges = alchemyRebornOn
    ? (oilChargesRemaining > 0 ? oilChargesRemaining : oilChargesAuthored)
    : 0;
  const oilTarget      = String(sys.oilTarget ?? "");
  const oilBonusDamage = Number(sys.oilBonusDamage) || 0;
  const durationSecs   = alchemyRebornOn ? 0 : oilDurationSeconds(oil);
  const expireAt       = (durationSecs > 0 && Number.isFinite(durationSecs)) ? (now + durationSecs) : 0;

  /* Oiling makes a weapon one-of-a-kind. If it's part of a stack, peel ONE
   * unit off to receive the coating so the rest stay a plain (uncoated)
   * stack. Peeled spinoff joins the same container as the source (usually
   * where the plain stack was) so it lands where the player expects. */
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
    await addToSourceContainer(owner, weapon, target);
  }

  /* Write the appliedOil snapshot. One coating at a time — overwriting
   * the field replaces any prior oil (no second "wipe" pass needed).
   * `appliedAt` records the worldTime second the coating started so the
   * dock can render `(expireAt - now) / (expireAt - appliedAt)` for the
   * progress bar. */
  /* Snapshot the oil's non-disabled AEs so they can be applied to any
   * target damaged by this coated weapon. Kept as raw AE data (toObject) so
   * the coating remains applicable even after the source oil is consumed. */
  const onHitStatuses = (oil.effects?.contents ?? [])
    .filter(e => !e.disabled)
    .map(e => e.toObject());
  await target.update({
    "system.appliedOil": {
      id:             oil.id,
      name:           oil.name,
      img:            oil.img ?? "",
      oilTarget,
      oilBonusDamage,
      appliedAt:      now,
      expireAt,
      charges:        oilMaxCharges,
      maxCharges:     oilMaxCharges,
      onHitStatuses
    }
  });

  const qty = parseInt(oil.system.quantity) || 1;
  if (qty <= 1) await oil.delete();
  else await oil.update({ "system.quantity": qty - 1 });
}

/* If `source` lives inside a container on `owner`, place the peeled
 * spinoff into the same container so it inherits the same combat-time
 * eligibility (getEligibleAmmo's pass 1 only lists items whose UUID
 * appears in an equipped container's content array).
 *
 * Loose sources (never stored) leave the spinoff loose too. Idempotent:
 * the same uuid is only appended once per container.
 *
 * Ref matching accepts either `source.uuid` OR `source.id`: container
 * content stores UUIDs in new writes but legacy world data may still
 * carry raw item ids (resolveContainerContents supports both, so the
 * match here does too — otherwise a legacy-id source would silently
 * fail to find its container and the coated spinoff would land loose,
 * invisible in combat). */
export async function addToSourceContainer(owner, source, spinoff) {
    if (!owner || !source || !spinoff) return;
    for (const c of owner.items ?? []) {
        if (c.type !== "container") continue;
        const content = c.system?.content ?? [];
        if (!content.includes(source.uuid) && !content.includes(source.id)) continue;
        const nextContent = content.includes(spinoff.uuid) ? content : [...content, spinoff.uuid];
        try {
            await c.update({ "system.content": nextContent });
            if (!spinoff.system?.isStored) await spinoff.update({ "system.isStored": true });
        } catch (err) {
            console.warn(`${MODULE_ID} | addToSourceContainer failed`, err);
        }
        return;
    }
}

/* Coat a single arrow/bolt from an ammo stack.
 *
 * Mirrors applyOilToWeapon on shape (same appliedOil snapshot fields, same
 * mode split between Alchemy Reborn charges and RAW time-based expiry) but
 * always peels a 1-qty spinoff off the ammo stack — one coating action
 * coats one arrow. The plain remainder keeps its own line in the inventory
 * and in the ammo picker; the coated spinoff surfaces as its own line
 * labeled with the oil (e.g. "Regular Arrow (Hanged Man's Venom)").
 *
 * On fire, spendShot decrements the coated stack's qty from 1 to 0; the
 * consume path deletes the empty ammo document, and the appliedOil goes
 * with it — no separate reclaim needed. */
/* Default coating batch size under RAW ammo application (Core p.166: one
 * bottle coats a batch of arrows, all sharing the same expireAt duration).
 * Ten matches the "arrow bundle" convention the source implies. */
const RAW_AMMO_COAT_BATCH = 10;

/* Find an existing coated ammo stack on the actor that shares this ammo's
 * type / name / ammoType and carries the SAME oil name — the target we'd
 * bump on a merge instead of spawning another 1-qty spinoff.
 *
 * Match by oil NAME (not bottle id) so two different Beast Oil vials
 * produce the same coating and their coated arrows stack. Prefer a
 * candidate in the same container as the source arrow so quiver-local
 * merges win over pack-stashed alternates. */
function findMatchingCoatedAmmoStack(owner, sourceAmmo, oil) {
  if (!owner || !sourceAmmo || !oil) return null;
  const targetName = sourceAmmo.name;
  const targetAmmoType = sourceAmmo.system?.ammoType ?? "";
  const oilName = oil.name;
  const candidates = (owner.items?.contents ?? owner.items ?? [])
    .filter(other =>
         other.id !== sourceAmmo.id
      && other.type === "ammo"
      && other.name === targetName
      && (other.system?.ammoType ?? "") === targetAmmoType
      && (other.system?.appliedOil?.name ?? "") === oilName);
  if (!candidates.length) return null;
  const containerOf = (it) => {
    for (const c of owner.items ?? []) {
      if (c.type !== "container") continue;
      const content = c.system?.content ?? [];
      if (content.includes(it.uuid) || content.includes(it.id)) return c;
    }
    return null;
  };
  const sourceContainer = containerOf(sourceAmmo);
  if (sourceContainer) {
    const inSame = candidates.find(c => containerOf(c)?.id === sourceContainer.id);
    if (inSame) return inSame;
  }
  return candidates[0];
}

/* Ask the player how many arrows/bolts to coat in the RAW batch. Default
 * AND max are min(RAW_AMMO_COAT_BATCH, stackQty) — one bottle can only
 * cover a bundle of RAW_AMMO_COAT_BATCH pieces, so a stack of 30 arrows
 * still needs three separate applications to fully coat. Min is 1.
 * Returns the chosen count or null on cancel. */
async function promptRawAmmoCoatCount(ammo, oil, stackQty) {
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  const cap = Math.max(1, Math.min(RAW_AMMO_COAT_BATCH, stackQty));
  const preset = cap;
  /* If the stack is <= 1 arrow, there's nothing to choose — just coat it. */
  if (!DialogV2 || cap <= 1) return cap;
  const content = `
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px;">
      <img src="${escapeAttr(oil.img)}" style="width:32px; height:32px; border-radius:4px;" />
      <div>
        <b>${escapeText(oil.name)}</b>
        <div style="opacity:0.75; font-size:0.75rem;">${tFormat("WITCHER.Chrome.Inventory.Text.CoatingAmmoInfo", { ammo: escapeText(ammo.name), batch: RAW_AMMO_COAT_BATCH, cap }, `Coating ${escapeText(ammo.name)} — one bottle covers up to ${RAW_AMMO_COAT_BATCH} pieces (${cap} available).`)}</div>
      </div>
    </div>
    <label style="display:flex; align-items:center; gap:8px;">
      <span>${t("WITCHER.Chrome.Inventory.Text.HowManyToCoat", "How many to coat?")}</span>
      <input type="number" name="count" min="1" max="${cap}" step="1" value="${preset}" style="flex:1; min-width:60px;" />
    </label>
  `;
  try {
    const chosen = await DialogV2.wait({
      window: { title: tFormat("WITCHER.Dialog.ApplyOil.Ammo", { oil: oil.name }, "Coat Ammo: {oil}") },
      content,
      buttons: [
        {
          action: "apply",
          label: t("WITCHER.Chrome.Inventory.Dialog.Button.Coat", "Coat"),
          default: true,
          callback: (_event, button) => {
            const raw = Number(button.form?.elements?.count?.value);
            return Number.isFinite(raw) ? Math.max(1, Math.min(cap, Math.floor(raw))) : preset;
          }
        },
        { action: "cancel", label: t("WITCHER.Common.Cancel", "Cancel") }
      ],
      rejectClose: false
    });
    if (chosen == null || chosen === "cancel") return null;
    return Number(chosen);
  } catch (_) {
    return null;
  }
}

async function applyOilToAmmo(ammo, oil) {
  const now = game.time?.worldTime ?? 0;
  const alchemyRebornOn = isHomebrewEnabled?.("alchemyPotency");
  const sys = oil.system ?? {};
  const oilTarget      = String(sys.oilTarget ?? "");
  const oilBonusDamage = Number(sys.oilBonusDamage) || 0;
  const durationSecs   = alchemyRebornOn ? 0 : oilDurationSeconds(oil);
  const expireAt       = (durationSecs > 0 && Number.isFinite(durationSecs)) ? (now + durationSecs) : 0;

  /* Under RAW (no charges — expireAt drives expiry), one bottle coats a
   * batch of ammo at once (default 10, capped by stack qty). Prompt the
   * player for how many to coat so a small quiver isn't over-coated and a
   * generous archer can bump the count. Under Alchemy Reborn, each coat
   * spends 1 bottle charge and coats exactly 1 arrow — no prompt, just
   * peel one. */
  const aQty = Number(ammo.system?.quantity) || 1;
  let coatCount = 1;
  if (!alchemyRebornOn) {
    const askedCount = await promptRawAmmoCoatCount(ammo, oil, aQty);
    if (askedCount == null) return;   // user cancelled
    coatCount = Math.max(1, Math.min(askedCount, aQty));
  }

  /* Merge target: if the actor already carries a coated stack of THIS
   * ammo with the SAME oil name, add the new coating count to that
   * existing stack instead of spawning yet another 1-qty spinoff. Keeps
   * inventory tidy (three arrows coated one-by-one show as one "Regular
   * Arrow (Beast Oil) ×3" line, not three separate entries). RAW batches
   * behave the same way — a second application from a fresh bottle bumps
   * the existing coated stack's quantity and extends the expireAt to the
   * later of the two.
   *
   * Skipped for weapons — the "weapon oil" flow is one weapon at a time,
   * and weapons rarely stack in the first place. */
  const owner = ammo.actor ?? ammo.parent;
  const mergeTarget = (ammo.type === "ammo" && owner)
    ? findMatchingCoatedAmmoStack(owner, ammo, oil)
    : null;

  let target;
  if (mergeTarget) {
    /* Peel coatCount from source into the existing coated stack. */
    if (coatCount >= aQty) {
      /* Fully consumed — drop the source entirely, cleaning its
       * container ref so the array doesn't hang on to a dead uuid. */
      for (const c of owner.items ?? []) {
        if (c.type !== "container") continue;
        const content = c.system?.content ?? [];
        if (!content.includes(ammo.uuid) && !content.includes(ammo.id)) continue;
        try {
          await c.update({
            "system.content": content.filter(ref => ref !== ammo.uuid && ref !== ammo.id)
          });
        } catch (_) { /* soft-fail */ }
      }
      try { await ammo.delete(); } catch (_) {}
    } else {
      await ammo.update({ "system.quantity": aQty - coatCount });
    }
    const bumpedQty = (Number(mergeTarget.system?.quantity) || 0) + coatCount;
    /* Extend the coating's expiry to the later of the two under RAW.
     * Under Reborn (charges-based, expireAt=0) this is a no-op. */
    const patch = { "system.quantity": bumpedQty };
    if (!alchemyRebornOn && expireAt > 0) {
      const existingExp = Number(mergeTarget.system?.appliedOil?.expireAt) || 0;
      if (expireAt > existingExp) patch["system.appliedOil.expireAt"] = expireAt;
    }
    await mergeTarget.update(patch);
    target = mergeTarget;
  } else {
    /* No stackable match — peel a new spinoff and stamp the coating on
     * it. If the source ammo lives inside a container (a quiver / belt
     * / pack), the peeled spinoff joins the SAME container so it stays
     * combat-eligible. Loose ammo stays loose. */
    target = ammo;
    if (coatCount < aQty) {
      await ammo.update({ "system.quantity": aQty - coatCount });
      const data = ammo.toObject(false);
      delete data._id;
      data.effects = [];
      data.system  = { ...(data.system ?? {}), quantity: coatCount };
      const [created] = await owner.createEmbeddedDocuments("Item", [data]);
      target = created;
      await addToSourceContainer(owner, ammo, target);
    }
    await target.update({
      "system.appliedOil": {
        id:             oil.id,
        name:           oil.name,
        img:            oil.img ?? "",
        oilTarget,
        oilBonusDamage,
        appliedAt:      now,
        expireAt,
        charges:        alchemyRebornOn ? 1 : 0,
        maxCharges:     alchemyRebornOn ? 1 : 0
      }
    });
  }

  /* Bottle consumption.
   *
   *   RAW: each application spends 1 unit of the bottle stack (same as
   *   the weapon path). No charge tracking — the whole bottle is a
   *   single application.
   *
   *   Alchemy Reborn: the bottle carries `oilCharges` uses. One coating
   *   spends 1 charge from the SAME bottle, so a 5-charge Beast Oil
   *   coats 5 arrows total. `currentCharges` tracks the running count
   *   on the specific bottle in use; it lazy-initializes from
   *   `oilCharges` on first application. When the stack has multiple
   *   units, we peel one off first so partial-use state doesn't leak
   *   across all vials in the stack. */
  if (alchemyRebornOn) {
    let bottle = oil;
    const bQty = Number(oil.system?.quantity) || 1;
    if (bQty > 1) {
      const owner = oil.actor ?? oil.parent;
      await oil.update({ "system.quantity": bQty - 1 });
      const data = oil.toObject(false);
      delete data._id;
      data.effects = [];
      data.system  = { ...(data.system ?? {}), quantity: 1 };
      const [created] = await owner.createEmbeddedDocuments("Item", [data]);
      bottle = created;
      /* Keep the peeled bottle in the same container the source was in
       * (usually the alchemy pouch / potion belt) so the player doesn't
       * suddenly have a loose oil floating in inventory next to their
       * quiver. */
      await addToSourceContainer(owner, oil, bottle);
    }
    const oilChargesMax = Math.max(1, Number(oil.system?.oilCharges) || OIL_DEFAULT_CHARGES_REBORN);
    const cur = Number(bottle.system?.currentCharges) || 0;
    const remaining = cur > 0 ? cur : oilChargesMax;
    const next = remaining - 1;
    if (next <= 0) await bottle.delete();
    else await bottle.update({ "system.currentCharges": next });
  } else {
    const qty = parseInt(oil.system.quantity) || 1;
    if (qty <= 1) await oil.delete();
    else await oil.update({ "system.quantity": qty - 1 });
  }

  /* Same action-cost as the weapon path — coating counts as a combat
   * action under Alchemy Reborn. Applied by the caller in openCoatWeapon-
   * Dialog for weapons; we do it here for ammo so the callsite doesn't
   * have to branch. */
  if (alchemyRebornOn) {
    const actor = ammo.actor ?? ammo.parent;
    const actionLabel = game.i18n.format("WITCHER.AlchemyReborn.Oil.ApplyAction", { oil: oil.name });
    try { await actor?.spendActionSlot?.(actionLabel); }
    catch (err) { console.warn(`${MODULE_ID} | apply-oil-to-ammo action spend failed`, err); }
  }
}

/* GM-only world-time sweep: clear expired oil coatings off weapons and
 * ammo. The coating lives on `<item>.system.appliedOil`; expireAt is the
 * worldTime second the coating ends. expireAt of 0 means no time-based
 * expiry (Alchemy Reborn charges-mode, or RAW "until cleansed" with no
 * duration authored), and is left alone. Ammo is swept alongside weapons
 * since coated 1-qty ammo stacks can hang around for hours before firing. */
export async function sweepExpiredOilCoatings() {
  if (!game.user?.isActiveGM) return;
  const now = game.time?.worldTime ?? 0;
  for (const actor of game.actors ?? []) {
    for (const item of actor.items ?? []) {
      if (item.type !== "weapon" && item.type !== "ammo") continue;
      const ao = item.system?.appliedOil;
      if (!ao || !ao.name) continue;
      const exp = Number(ao.expireAt) || 0;
      if (exp <= 0 || exp > now) continue;
      try {
        await clearOilAndReStack(item);
      } catch (err) { console.warn(`${MODULE_ID} | oil sweep clear failed`, err); }
    }
  }
}

/* Blank appliedOil snapshot — shared by every clear path (sweep, cleanse,
 * re-stack) so a coating clear reads the same regardless of who triggered
 * it. */
const BLANK_APPLIED_OIL = Object.freeze({
  id: "", name: "", img: "", oilTarget: "", oilBonusDamage: 0,
  appliedAt: 0, expireAt: 0, charges: 0, maxCharges: 0
});

/* Clear the coating on a weapon/ammo item, then try to merge the now-plain
 * item back into a matching plain stack on the same actor. Preserves the
 * original document if no plain match is found (leaves it as a standalone
 * stack). Called from both the RAW expiry sweep and the cleanse button.
 *
 * Match criteria: same actor, same type, same name, same ammoType (for
 * ammo), no active coating on the candidate. Prefers a candidate in the
 * same container as the uncoated item; falls back to any actor-level
 * match. Merging bumps the plain stack's `quantity` by the uncoated
 * item's quantity and then deletes the uncoated document. */
async function clearOilAndReStack(item) {
  await item.update({ "system.appliedOil": { ...BLANK_APPLIED_OIL } });
  const actor = item.actor ?? item.parent;
  if (!actor) return;
  const type = item.type;
  const name = item.name;
  const ammoType = item.system?.ammoType ?? "";
  const qty = Math.max(0, Number(item.system?.quantity) || 0);
  if (qty <= 0) { try { await item.delete(); } catch (_) {} return; }
  /* Find a merge target — another item with the same shape and no
   * coating. Prefer one already sharing the same container. */
  const candidates = (actor.items?.contents ?? actor.items ?? [])
    .filter(other =>
         other.id !== item.id
      && other.type === type
      && other.name === name
      && (type !== "ammo" || (other.system?.ammoType ?? "") === ammoType)
      && !other.system?.appliedOil?.name);
  if (!candidates.length) return;
  const containerOf = (it) => {
    for (const c of actor.items ?? []) {
      if (c.type !== "container") continue;
      const content = c.system?.content ?? [];
      if (content.includes(it.uuid) || content.includes(it.id)) return c;
    }
    return null;
  };
  const myContainer = containerOf(item);
  const preferred = myContainer
    ? candidates.find(other => containerOf(other)?.id === myContainer.id)
    : null;
  const target = preferred ?? candidates[0];
  try {
    const existingQty = Math.max(0, Number(target.system?.quantity) || 0);
    await target.update({ "system.quantity": existingQty + qty });
    /* If the uncoated item was referenced in a container, drop that ref
     * before deleting so the container's content array doesn't hang on
     * to a dead uuid. resolveContainerContents filters dead refs on
     * read, but keeping content tidy avoids indefinite bloat over a
     * long-running world. */
    if (myContainer) {
      const nextContent = (myContainer.system?.content ?? [])
        .filter(ref => ref !== item.uuid && ref !== item.id);
      try { await myContainer.update({ "system.content": nextContent }); }
      catch (_) { /* soft-fail */ }
    }
    await item.delete();
  } catch (err) {
    console.warn(`${MODULE_ID} | oil re-stack merge failed`, err);
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
        <p>${t("WITCHER.Chrome.Inventory.Text.Gift", "Gift")} <b>${escapeText(item.name)}</b>${hasStack ? ` (stack of ${qty})` : ""}.</p>
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
        label: t("WITCHER.Chrome.Inventory.Dialog.Button.Gift", "Gift"),
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
          label: tFormat("WITCHER.Chrome.Inventory.Dialog.Button.GiftAllX", { qty: qty }, "Gift all (×{qty})"),
          callback: (event, button) => ({
            receiver: button.form?.elements?.actor?.value || "",
            count: qty
          })
        });
      }

      const result = await DialogV2.wait({
        window: { title: tFormat("WITCHER.Dialog.GiftItem", { item: item.name }, "Gift {item}") },
        content, buttons,
        rejectClose: false
      }).catch(() => null);
      if (!result || !result.receiver || !result.count) return;
      const { receiver, count } = result;

      /* Containers carry their contents by UUID reference — a naive
       * addItem/removeItem pair would clone only the container itself
       * and orphan every item inside it on the source. Route through
       * the death-march GM proxy which recursively transfers the
       * whole subtree and rewrites the new container's content refs.
       * Same helper the overhaul-ui context menu (context-menu-item.js)
       * uses, so both entry points behave identically. */
      if (item.type === "container") {
        try {
          const { emitGiftItem } = await import("../../setup/socketHook.mjs");
          await emitGiftItem({
            sourceActorUuid: actor.uuid,
            targetActorUuid: receiver,
            itemId:          item.id,
            quantity:        1,
            fromUserId:      game.user?.id ?? null
          });
        } catch (err) { console.warn(`${MODULE_ID} | container gift failed`, err); }
        return;
      }

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
    name: t("WITCHER.Chrome.Inventory.Text.SplitStack", "Split Stack"),
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
        <p>${tFormat("WITCHER.Chrome.Inventory.Text.StackOfN", { qty, name: escapeText(item.name) }, `Stack of <b>${qty}</b>× <b>${escapeText(item.name)}</b>.`)}</p>
        <div style="display:flex; align-items:center; gap:8px; margin:8px 0;">
          <label for="wou-split-n">${t("WITCHER.Chrome.Inventory.Text.SplitOffHowMany", "Split off how many:")}</label>
          <input id="wou-split-n" name="count" type="number" value="${half}" min="1" max="${qty - 1}" style="width:80px;" />
        </div>
      `;
      const result = await DialogV2.wait({
        window: { title: tFormat("WITCHER.Dialog.SplitItem", { item: item.name }, "Split {item}") },
        content,
        buttons: [
          {
            action: "split",
            label: t("WITCHER.Chrome.Inventory.Dialog.Button.Split", "Split"),
            default: true,
            callback: (event, button) => {
              const raw = Number(button.form?.elements?.count?.value) || 1;
              return Math.max(1, Math.min(qty - 1, Math.floor(raw)));
            }
          },
          { action: "cancel", label: t("WITCHER.Common.Cancel", "Cancel") }
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
        <p>${tFormat("WITCHER.Chrome.Inventory.Text.StackOfN", { qty, name: escapeText(item.name) }, `Stack of <b>${qty}</b>× <b>${escapeText(item.name)}</b>.`)}</p>
        <div style="display:flex; align-items:center; gap:8px; margin:8px 0;">
          <label for="wou-del-n">${t("WITCHER.Chrome.Inventory.Text.DeleteHowMany", "Delete how many:")}</label>
          <input id="wou-del-n" name="count" type="number" value="1" min="1" max="${qty}" style="width:80px;" />
        </div>
      `;
      const result = await DialogV2.wait({
        window: { title: tFormat("WITCHER.Dialog.DeleteNamedItem", { item: item.name }, "Delete {item}") },
        content,
        buttons: [
          {
            action: "some",
            label: t("WITCHER.Chrome.Inventory.Dialog.Button.Delete", "Delete"),
            default: true,
            callback: (event, button) => {
              const raw = Number(button.form?.elements?.count?.value) || 1;
              return Math.max(1, Math.min(qty, Math.floor(raw)));
            }
          },
          { action: "all", label: tFormat("WITCHER.Chrome.Inventory.Dialog.Button.DeleteAllX", { qty: qty }, "Delete all (×{qty})") }
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
    badge.dataset.tooltip = t("WITCHER.Chrome.Inventory.Tip.Finished", "Finished");
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
    name: t("WITCHER.Chrome.Inventory.Text.PourGlass", "Pour Glass"),
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
    name: t("WITCHER.Chrome.Inventory.Text.ServePiece", "Serve Piece"),
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
  /* Properly rAF-coalesced. `requestAnimationFrame(positionBounds)`
   * queues a NEW callback every time it's called — so 4 back-to-back
   * observer fires in one frame produce 4 positionBounds calls in the
   * next frame, each doing 4 getBoundingClientRect reads. That's 16
   * reads per frame during any transition and was the primary source
   * of the "Forced reflow" spam when the left bar opened/closed.
   * Guard so only ONE positionBounds fires per frame regardless of
   * how many triggers land in the same tick. */
  let _pending = 0;
  const reposition = (records) => {
    /* A mutation on <html>'s inline style means a UI-scaling var changed, which
     * can change the panel's local width (and the grid's auto-filled column
     * count) even when the bars didn't move. Force a grid re-measure so the
     * sub-section frame bracket tracks the actual columns. */
    const scaleChanged = Array.isArray(records)
      && records.some(r => r && r.target === document.documentElement);
    if (scaleChanged && isInventoryOpen()) scheduleGridReflowSettled();
    if (_pending) return;
    _pending = requestAnimationFrame(() => {
      _pending = 0;
      positionBounds();
    });
  };

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
    // AND observe <html>'s inline style: the UI-scaling knobs (Overall Scaling /
    // per-section Size) write --wdm-* CSS vars onto documentElement.style, which
    // changes the bars' `zoom` — growing their on-screen footprint — WITHOUT
    // changing the bars' own class/style or firing their ResizeObserver. Without
    // this, positionBounds never re-runs on a scale change, so the expanded bars
    // overlap the overlay and items get clipped out of bounds.
    _chromeMutationObs.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
  }

  for (const sel of CHROME_SELECTORS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    /* The panels slide via `transform`; `.wou-collapse` also transitions
     * `filter` and `opacity` on a SHORTER duration, so those two fire
     * `transitionend` MID-slide and used to trigger premature re-fits (each
     * paying a grid re-flow at a transient width). Only the `transform`
     * transition ending means "the bar reached its final position" — react to
     * that alone. `e.target === el` ignores transitionends that bubble up from
     * descendants (e.g. a button's own transform on hover). */
    el.addEventListener("transitionend", (e) => { if (e.target === el && e.propertyName === "transform") reposition(); });
    el.addEventListener("animationend",  reposition);
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
