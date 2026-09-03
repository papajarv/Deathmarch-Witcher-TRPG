/**
 * Character overlay — drops from the top bar's "Character" tab.
 *
 * Two top-level tabs:
 *   - Abilities  (portrait + sawtooth bars + trackers + 4 sub-tabs:
 *                 Stats & Skills / Profession / Magic / Active Effects)
 *   - Biography  (identity, race+school perks, backstory editor)
 *
 * Data is read live from the actor:
 *   - Pools/trackers come from getDockData() (single source of truth shared
 *     with the bottom dock so the panel never drifts from what's visible
 *     below).
 *   - Stats live at system.stats.<key>.value
 *   - Skills at system.skills.<stat>.<skill>.{value, modifiedValue}
 *   - Profession item is the first item of type "profession"
 *   - Race item is the first item of type "race"
 *   - Spells/hexes/rituals are items of those types
 *   - Active effects are actor.effects.contents
 */

import { getPanelActor, setPanelOverride, getDockData, VIEWER_OVERRIDE_HOOK, PANEL_OVERRIDE_HOOK } from "../lib/actor.js";
import { isVariablePortraitEnabled, openVariablePortraitConfig } from "../integrations/portrait-toxicity.js";
import { renderViewAsPicker, wireViewAsPicker, renderViewPanelAsPicker, wireViewPanelAsPicker } from "../lib/view-as.js";
import { formatSecondsLabel } from "./dock-statuses.js";
import {
  SP_LOCATIONS,
  RES_TYPES,
  getLocationSP,
  getResistancesForLocation,
  decrementArmorSP,
} from "./dock.js";
import { drainHp } from "../../setup/config.mjs";
import { isHomebrewEnabled } from "../../api/homebrew.mjs";

import { t, tFormat } from "../lib/i18n.js";
const MODULE_ID = "witcher-ttrpg-death-march";
const PANEL_ID  = "wou-character";

const STATS = [
  { key: "int",  label: "INT" },
  { key: "ref",  label: "REF" },
  { key: "dex",  label: "DEX" },
  { key: "body", label: "BOD" },
  { key: "spd",  label: "SPD" },
  { key: "emp",  label: "EMP" },
  { key: "cra",  label: "CRA" },
  { key: "will", label: "WIL" },
];

/* Sub-tabs inside Abilities.  Active Effects used to live here — now it's
 * an always-visible column in char-top to the right of Armor, so the tab
 * was removed to avoid duplicate displays. */
const SUB_TABS = () => [
  { key: "stats",      label: t("WITCHER.Chrome.Character.Dialog.Button.StatsSkills", "Stats & Skills"),  icon: "fa-chart-simple" },
  { key: "profession", label: t("WITCHER.Chrome.Character.Dialog.Button.Profession", "Profession"),      icon: "fa-shield-halved" },
  { key: "magic",      label: t("WITCHER.Chrome.Character.Dialog.Button.Magic", "Magic"),           icon: "fa-wand-sparkles" },
];

let panelEl = null;
let hooksWired = false;

/* Per-session UI state */
let activeMain  = "abilities";   // "abilities" | "biography"
let activeSub   = "stats";       // SUB_TABS key
let activeMagicFilter = "all";   // MAGIC_SECTIONS key | "all"
const collapsedMagicSections = new Set(); // MAGIC_SECTIONS keys currently collapsed
const expandedPaths = new Set(); // profession path keys currently expanded
const expandedProfSkills = new Set(); // per-skill expansion keys for the profession pane
                                 // ("defining", "1", "2", "3")
const editingLifeEvents = new Set(); // life-event slot keys ("10"..."200") that
                                     // were just added via the bio tab — keeps
                                     // their editor visible even when all three
                                     // fields are still empty
let lifeEventsCollapsed = false;     // Defining-moments section collapsed?

/* Which IP pool the level-up UI is currently spending from. "any" = regular
 * IP (the default; magic-tagged skills may still confirm-spend Magic IP
 * if regular runs short). "magic" = Magic IP only, and only magic-tagged
 * skills (base magicSkills OR profession slots with `isMagical: true`)
 * show a level-up diamond; the rest render as inactive. Toggled by
 * clicking either chip in the IP banner. */
let _ipMode = "any";  // "any" | "magic"

/* Chrome panels the overlay shrinks/expands around — same set inventory uses */
const CHROME_SELECTORS = ["#wou-top-bar", "#wou-dock", "#scene-controls", "#sidebar"];
let _chromeResizeObs   = null;
let _chromeMutationObs = null;

/* =========================================================================
   PUBLIC API
   ========================================================================= */

export function injectCharacterPanel() {
  if (document.getElementById(PANEL_ID)) return;
  const el = document.createElement("main");
  el.id = PANEL_ID;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", t("WITCHER.Chrome.Character.Text.Character", "Character"));
  document.body.appendChild(el);
  panelEl = el;

  /* CRITICAL: register the click delegate ONCE on the persistent panelEl.
   * It used to be added inside wireListeners() which runs every render — so
   * after N actor updates the panel had N click listeners, each firing on
   * every click, which compounded into the lag the user noticed.  The
   * delegate dispatches on data-action and looks up the actor lazily, so we
   * don't need to re-bind when the actor changes. */
  el.addEventListener("click", (ev) => {
    const actor = getPanelActor("character");
    if (!actor) return;
    onClick(ev, actor);
  });

  /* Right-click delegate — same one-time pattern as the click handler.
   * Currently only spell cards opt in (data-context-action="open-sheet"),
   * but the dispatch is generic so other cards can opt in later. */
  el.addEventListener("contextmenu", (ev) => {
    const actor = getPanelActor("character");
    if (!actor) return;
    onContextMenu(ev, actor);
  });

  /* Hover delegate for spell cards — show a portal popover with the full
   * effect + description.  The card body itself only shows a truncated
   * preview, so this lets players read the rules without opening the
   * spell sheet. */
  bindSpellHover(el);

  /* GM "View as" picker — re-renders this overlay on selection. */
  wireViewAsPicker(el, () => rerenderIfOpen());
  wireViewPanelAsPicker(el, "character", () => rerenderIfOpen());

  if (!hooksWired) {
    /* Hook filters use the live-resolved viewer (override-aware) so updates
     * to whichever actor the GM is currently impersonating still trigger
     * a re-render. */
    const ownsItem = (i) => i?.parent?.id === getPanelActor("character")?.id;
    const ownsEffect = (ae) => {
      const cid = getPanelActor("character")?.id;
      if (!cid) return false;
      const p = ae?.parent;
      return p?.id === cid || p?.parent?.id === cid;
    };
    Hooks.on("updateUser",         (u) => { if (u.id === game.user.id)               rerenderIfOpen(); });
    Hooks.on("updateActor",        (a) => { if (a.id === getPanelActor("character")?.id)     rerenderIfOpen(); });
    Hooks.on("createItem",         (i) => { if (ownsItem(i))                         rerenderIfOpen(); });
    Hooks.on("updateItem",         (i) => { if (ownsItem(i))                         rerenderIfOpen(); });
    Hooks.on("deleteItem",         (i) => { if (ownsItem(i))                         rerenderIfOpen(); });
    Hooks.on("createActiveEffect", (e) => { if (ownsEffect(e))                       rerenderIfOpen(); });
    Hooks.on("updateActiveEffect", (e) => { if (ownsEffect(e))                       rerenderIfOpen(); });
    Hooks.on("deleteActiveEffect", (e) => { if (ownsEffect(e))                       rerenderIfOpen(); });
    /* World-time ticks make seconds-based effect durations count down.  The
     * real-time clock fires this ~once a second, so we DON'T full-rebuild here
     * — that flickered the whole panel.  Instead patch just the duration chips
     * in place.  Structural changes (an effect created/expired/deleted) come
     * through the create/delete ActiveEffect hooks above and do a real render. */
    Hooks.on("updateWorldTime", () => { tickEffectDurations(); tickWoundHealing(); });
    /* GM picked a different "view as" target in another tab — re-render
     * so the character overlay swaps to that PC's data. */
    Hooks.on(VIEWER_OVERRIDE_HOOK, () => { rerenderIfOpen(); });
    Hooks.on(PANEL_OVERRIDE_HOOK, (key) => { if (key === "character") rerenderIfOpen(); });
    /* Re-fit when the viewport resizes or any chrome panel opens/closes —
     * same pattern inventory.js / journal.js use. */
    window.addEventListener("resize", positionBounds, { passive: true });
    wireChromeObservers();
    hooksWired = true;
  }
}

/* =========================================================================
   POSITIONING — measure chrome edges and pin overlay between them
   ========================================================================= */

/** Position the overlay between the four chrome edges using body-class state
 *  as truth (transform-based collapses make mid-animation rect reads jitter).
 *  Also publishes `--chr-close-x` so the chevron-up close button is pinned
 *  directly under the topbar's Character tab — mirrors `--inv-close-x` and
 *  `--jnl-close-x`. */
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
  /* Extends to the viewport bottom — overlays the dock. */
  const bottom = 0;
  const left   = (leftOpen   && leftbar)? Math.max(0, leftbar.getBoundingClientRect().right) : 0;
  const right  = (rightOpen  && sidebar)? Math.max(0, W - sidebar.getBoundingClientRect().left) : 0;

  panelEl.style.top = `calc(${top}px / var(--wdm-size-character, var(--wdm-chrome-bars-scale, 1)))`;
  panelEl.style.bottom = `calc(${bottom}px / var(--wdm-size-character, var(--wdm-chrome-bars-scale, 1)))`;
  panelEl.style.left = `calc(${left}px / var(--wdm-size-character, var(--wdm-chrome-bars-scale, 1)))`;
  panelEl.style.right = `calc(${right}px / var(--wdm-size-character, var(--wdm-chrome-bars-scale, 1)))`;

  const tab = document.querySelector('#wou-top-bar [data-tab="character"]');
  if (tab) {
    const tabRect = tab.getBoundingClientRect();
    const tabCenterX = tabRect.left + tabRect.width / 2;
    /* Divide by --wdm-scale — the panel's own coord system is scaled,
     * so a raw viewport-pixel offset lands off-center under UI scaling.
     * Mirrors the fix in inventory.js. */
    panelEl.style.setProperty("--chr-close-x", `calc(${tabCenterX - left}px / var(--wdm-size-character, var(--wdm-chrome-bars-scale, 1)))`);
  }
}

function wireChromeObservers() {
  /* Coalesced: one positionBounds per frame regardless of trigger count. */
  let _pending = 0;
  const reposition = () => {
    if (_pending) return;
    _pending = requestAnimationFrame(() => { _pending = 0; positionBounds(); });
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
    _chromeMutationObs.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    // Also re-fit when the UI-scaling knobs change: they write --wdm-* CSS vars
    // onto <html>, changing the bars' `zoom` (their on-screen footprint) without
    // touching the bars' own class/style or firing their ResizeObserver.
    _chromeMutationObs.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
  }
  for (const sel of CHROME_SELECTORS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    el.addEventListener("transitionend",  reposition);
    el.addEventListener("animationend",   reposition);
  }
}

export async function toggleCharacter() {
  if (!panelEl) injectCharacterPanel();
  const willOpen = !panelEl.classList.contains("is-open");
  await setCharacterOpen(willOpen);
}

export async function setCharacterOpen(open) {
  if (!panelEl) injectCharacterPanel();
  if (open) {
    /* One drop-down panel open at a time — same pattern crafting / journal use. */
    if (document.body.classList.contains("wou-inventory-open")) {
      import("./inventory.js").then(m => m.setInventoryOpen(false)).catch(() => {});
    }
    if (document.body.classList.contains("wou-journal-open")) {
      import("./journal.js").then(m => m.setJournalOpen(false)).catch(() => {});
    }
    if (document.body.classList.contains("wou-crafting-open")) {
      import("./crafting.js").then(m => m.setCraftingOpen(false)).catch(() => {});
    }
    if (document.body.classList.contains("wou-map-open")) {
      import("./map.js").then(m => m.setMapOpen(false)).catch(() => {});
    }
    if (document.body.classList.contains("wou-bestiary-open")) {
      import("./bestiary.js").then(m => m.setBestiaryOpen(false)).catch(() => {});
    }
    positionBounds();       /* fresh measure right before paint */
    _lastShellHtml = null;  /* force a clean rebuild on every open */
    await render();
    panelEl.classList.add("is-open");
    document.body.classList.add("wou-character-open");
    syncTopbarTab(true);
  } else {
    panelEl.classList.remove("is-open");
    document.body.classList.remove("wou-character-open");
    // Transient "View as" clears on close; global "Lock as" persists.
    setPanelOverride("character", null);
    syncTopbarTab(false);
  }
}

export function isCharacterOpen() {
  return !!panelEl?.classList.contains("is-open");
}

/** Coalesce: many hooks in the same tick → at most one render per
 *  animation frame, and only when the overlay is open. */
let _charRenderPending = false;

/** Fingerprint of the last innerHTML we wrote.  When a hook fires but the
 *  rendered output is byte-identical (e.g. an `updateWorldTime` tick from the
 *  real-time clock when nothing on this panel actually changed), we skip the
 *  innerHTML rewrite + listener re-wire entirely.  Without this the panel
 *  rebuilt ~once a second while the clock ran, flickering hover/focus state.
 *  `renderShell` is deterministic from actor state (no Date/random), so an
 *  identical string means an identical DOM. */
let _lastShellHtml = null;

/** Set true immediately before an actor.update whose only visible effect is
 *  already reflected in the live DOM (a bio text field the user just typed
 *  into).  Swallows the single self-triggered re-render that update fires, so
 *  committing a field doesn't flash the whole tab.  Any other (external)
 *  update still re-renders normally. */
let _suppressNextRender = false;
/* When `patchInputValue` writes directly to a DOM input (optimistic +/- or
 * typing display) the panel's cached shell HTML no longer matches what's
 * actually on screen. If the next render produces identical HTML to the
 * cached version (e.g. the write got fully absorbed by a stress shield, so
 * actor data is unchanged), `render()` short-circuits via `html === _lastShellHtml`
 * and the out-of-band patched input is never reconciled. This flag forces
 * the next render to bypass the equality short-circuit so the morph step
 * can sync the input's `.value` property back to the new HTML attribute. */
let _forceNextRender = false;
/* Coalesce burst re-render requests into a single render.
 *
 * A rAF window (~16ms) is too tight for multi-await flows like
 * onConsume: the food-item update, satiety update, tier-AE
 * create/delete, hunger-stress update, STA clamp update, and
 * item-AE copy all fire sequentially over 200-400ms. Each async
 * awaits lands on a new animation frame, which under rAF would
 * spawn a fresh full re-render (each ~50-100ms on a heavy actor).
 *
 * A short setTimeout (~120ms) is long enough to absorb the whole
 * burst into one render at the tail, and still short enough that
 * a single manual +/- click doesn't feel laggy — the +/- clicker
 * already writes optimistically to the DOM via patchInputValue,
 * so the true render just needs to eventually reconcile. */
const RENDER_DEBOUNCE_MS = 200;
let _renderDebounceTimer = 0;
function rerenderIfOpen() {
  if (_suppressNextRender) { _suppressNextRender = false; return; }
  if (!isCharacterOpen()) return;
  if (_renderDebounceTimer) return;
  _renderDebounceTimer = setTimeout(() => {
    _renderDebounceTimer = 0;
    if (!isCharacterOpen()) return;
    render();
  }, RENDER_DEBOUNCE_MS);
}

/** World-time tick: refresh only the seconds-based effect-duration chips in
 *  place, leaving the rest of the DOM (and hover/focus state) untouched.  A
 *  chip whose effect has vanished is left as-is — the delete hook will have
 *  fired a real render to remove its row. */
function tickEffectDurations() {
  if (!panelEl || !isCharacterOpen()) return;
  const actor = getPanelActor("character");
  if (!actor) return;
  for (const chip of panelEl.querySelectorAll(".wou-chr-eff-row[data-effect-id] .wou-chr-eff-dur")) {
    const id  = chip.closest(".wou-chr-eff-row")?.dataset.effectId;
    const eff = id ? actor.effects.get(id) : null;
    if (!eff) continue;
    const label = describeEffectDuration(eff.duration);
    if (chip.textContent !== label) chip.textContent = label;
  }
}

/** World-time tick: advance each treated wound's healing clock in place so
 *  the "days healed / required" chip ticks over each in-game day even while
 *  the panel sits open.  Mirrors tickEffectDurations — patch only the chip
 *  text, leaving the rest of the DOM (and hover/focus) untouched.  A wound
 *  that finishes healing is deleted by the autoheal sweep, whose delete hook
 *  fires a real render to drop the card. */
function tickWoundHealing() {
  if (!panelEl || !isCharacterOpen()) return;
  const actor = getPanelActor("character");
  if (!actor) return;
  for (const card of panelEl.querySelectorAll(".wou-chr-wound-card[data-wound-id]")) {
    const item = actor.items.get(card.dataset.woundId);
    const chip = card.querySelector(".wou-chr-wound-healing");
    if (!item || !chip) continue;
    const days  = Number(item.system?.healDaysElapsed) || 0;
    const time  = Number(item.system?.healingTime) || 0;
    const label = `${days}/${time} d`;
    if (chip.textContent.trim() !== label) {
      chip.innerHTML = `<i class="fa-solid fa-clock-rotate-left"></i>${label}`;
    }
  }
}

function syncTopbarTab(on) {
  const tab = document.querySelector('#wou-top-bar [data-tab="character"]');
  tab?.classList.toggle("is-active", on);
}

/* =========================================================================
   RENDER
   ========================================================================= */

async function render() {
  if (!panelEl) return;

  const actor = getPanelActor("character");
  const html  = actor
    ? renderShell(actor, getDockData(actor))
    : renderEmptyState(t("WITCHER.Chrome.Character.Text.NoCharacterAssigned", "No character assigned."));

  /* Skip the rewrite when the output is unchanged — see _lastShellHtml.
   * `_forceNextRender` bypasses the equality short-circuit when the DOM
   * has been patched out-of-band (optimistic tracker +/-) — without this,
   * a fully-absorbed stress raise leaves the input visually stuck on the
   * patched value because the morph step never runs to reconcile it. */
  if (!_forceNextRender && html === _lastShellHtml) return;
  _forceNextRender = false;
  const firstPaint = _lastShellHtml === null;
  _lastShellHtml = html;

  /* Capture scroll positions of every known scrollable container BEFORE
   * we touch the DOM — a wholesale-replaced container would otherwise reset
   * to 0.  Restored after.  (The morph preserves most containers in place, so
   * for those this is a no-op, but it covers the replace case.) */
  const scrollCaptures = captureScrollPositions();

  if (firstPaint) {
    /* No prior DOM to diff against — do the cheap one-shot innerHTML write. */
    panelEl.innerHTML = html;
  } else {
    /* Subsequent renders patch the existing DOM in place rather than tearing
     * it down.  External updates (actor-sheet edits, other UI touching the
     * actor) only change a value or two; morphing touches just those nodes so
     * the rest of the panel — focus, hover, in-flight transitions, loaded
     * images — survives untouched.  This is what kills the "messy re-render"
     * flicker the wholesale innerHTML swap produced. */
    morphChildren(panelEl, html);
  }

  /* wireListeners is idempotent (it skips nodes already in _wired), so after a
   * morph it only attaches handlers to the freshly-inserted nodes. */
  if (actor) wireListeners(actor);

  restoreScrollPositions(scrollCaptures);
}

/* ── In-place DOM morph ────────────────────────────────────────────────
 * A compact morphdom-style reconciler.  Parses `newHtml` into a detached
 * tree and patches `parent`'s children to match, reusing existing nodes
 * wherever the new node is structurally identical so live state (focus,
 * scroll, hover, listeners, decoded images) is preserved.
 *
 * Deliberately simple: children are matched by index, not by key.  Most
 * external updates mutate values rather than reorder structure, so index
 * matching preserves the overwhelming majority of nodes; the worst case for
 * an insert/remove mid-list is some extra node churn below the change, which
 * is still correct.  Click/contextmenu delegation lives on the persistent
 * panelEl, so it is never disturbed. */
function morphChildren(parent, newHtml) {
  const tpl = document.createElement("template");
  tpl.innerHTML = newHtml;
  reconcileChildren(parent, tpl.content);
}

function reconcileChildren(oldParent, newParent) {
  const oldNodes = Array.from(oldParent.childNodes);
  const newNodes = Array.from(newParent.childNodes);
  const max = Math.max(oldNodes.length, newNodes.length);
  for (let i = 0; i < max; i++) {
    const o = oldNodes[i];
    const n = newNodes[i];
    if (!n) { o.remove(); continue; }
    if (!o) { oldParent.appendChild(n); continue; }
    morphNode(o, n);
  }
}

function morphNode(oldNode, newNode) {
  /* Never touch the element the user is actively EDITING — preserves caret,
   * selection, and any uncommitted typed value. But a button/link that just
   * got clicked (and now holds focus) must NOT be preserved: after a level-up
   * click the button becomes a filled diamond span in the next render, and
   * skipping the swap left the button in place — so the diamond appeared to
   * lag until the panel reopened. Only guard editable controls. */
  if (oldNode === document.activeElement && isEditableControl(oldNode)) return;

  /* Different node type or tag → wholesale replace. */
  if (oldNode.nodeType !== newNode.nodeType || oldNode.nodeName !== newNode.nodeName) {
    oldNode.replaceWith(newNode);
    return;
  }

  if (oldNode.nodeType === Node.TEXT_NODE || oldNode.nodeType === Node.COMMENT_NODE) {
    if (oldNode.nodeValue !== newNode.nodeValue) oldNode.nodeValue = newNode.nodeValue;
    return;
  }

  if (oldNode.nodeType !== Node.ELEMENT_NODE) return;

  /* Identical subtree → leave the live nodes entirely alone (the whole point:
   * unchanged regions keep their focus/hover/listeners/images). */
  if (oldNode.isEqualNode(newNode)) return;

  syncAttributes(oldNode, newNode);

  /* Keep form-control display in sync with the new attribute state when the
   * control is NOT being edited (the activeElement guard above protects the
   * one the user is in). */
  const tag = oldNode.nodeName;
  if (tag === "INPUT" || tag === "TEXTAREA") {
    const nv = newNode.getAttribute("value") ?? "";
    if (oldNode.value !== nv && newNode.hasAttribute("value")) oldNode.value = nv;
    if ("checked" in oldNode) oldNode.checked = newNode.hasAttribute("checked");
  }

  reconcileChildren(oldNode, newNode);
}

/* True for text inputs, textareas, contenteditable elements, and selects —
 * the controls whose live state (caret, in-flight text) would be lost by a
 * DOM replacement. Buttons / anchors / other focus-holders are excluded so
 * the morph can freely swap them (e.g. a clicked level-up button becoming a
 * filled diamond span). */
function isEditableControl(node) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
  const tag = node.nodeName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = String(node.getAttribute("type") ?? "").toLowerCase();
    // Non-editable input types (button, submit, checkbox, radio) don't lose
    // state on replace; skip the guard for them so their live handlers can
    // be re-wired freely.
    return !["button", "submit", "reset", "checkbox", "radio", "file", "image"].includes(type);
  }
  if (node.isContentEditable) return true;
  return false;
}

function syncAttributes(oldEl, newEl) {
  const newAttrs = newEl.attributes;
  for (let i = 0; i < newAttrs.length; i++) {
    const { name, value } = newAttrs[i];
    if (oldEl.getAttribute(name) !== value) oldEl.setAttribute(name, value);
  }
  /* Remove attributes that vanished from the new node. */
  const oldAttrs = oldEl.attributes;
  for (let i = oldAttrs.length - 1; i >= 0; i--) {
    const name = oldAttrs[i].name;
    if (!newEl.hasAttribute(name)) oldEl.removeAttribute(name);
  }
}

/* Scroll containers we care about — pane bodies that overflow.  These must
 * match the elements that ACTUALLY have `overflow-y: auto` in character.css,
 * not their parent wrappers (setting scrollTop on a non-scrolling node is a
 * no-op).  Add to this list when introducing new scrollable regions inside
 * the character panel. */
const SCROLL_SELECTORS = [
  ".wou-chr-bio-scroll",
  ".wou-chr-magic-scroll",
  ".wou-chr-prof-scroll",      /* profession pane scroller */
  ".wou-chr-skills-scroll",    /* stats & skills pane scroller — leveling a
                                  skill rewrites innerHTML, so this must be
                                  preserved or the right-hand columns snap
                                  back to the top on every IP spend. */
  ".wou-chr-effects-body",     /* always-visible active effects column */
  ".wou-chr-wounds-scroll",    /* wounds tab scroll */
];

function captureScrollPositions() {
  if (!panelEl) return null;
  const out = new Map();
  for (const sel of SCROLL_SELECTORS) {
    const el = panelEl.querySelector(sel);
    if (!el) continue;
    const top  = el.scrollTop;
    const left = el.scrollLeft;
    /* The skills grid uses CSS multi-column layout — widen the panel and
     * extra sections flow horizontally, which can produce a horizontal
     * scrollbar.  Capture BOTH axes so leveling a skill doesn't snap right-
     * side columns back to the start. */
    if (top > 0 || left > 0) out.set(sel, { top, left });
  }
  return out;
}

function restoreScrollPositions(captures) {
  if (!captures || !captures.size) return;
  /* Wait one frame so the freshly-rendered DOM has computed layout — setting
   * scrollTop/scrollLeft on a node before layout is a no-op. */
  requestAnimationFrame(() => {
    for (const [sel, pos] of captures) {
      const el = panelEl?.querySelector(sel);
      if (!el) continue;
      if (pos.top  > 0) el.scrollTop  = pos.top;
      if (pos.left > 0) el.scrollLeft = pos.left;
    }
  });
}

function renderEmptyState(msg) {
  return `
    <button class="wou-chr-close" type="button" data-action="close" title="${t("WITCHER.Chrome.Character.Text.Collapse", "Collapse")}">
      <i class="fa-solid fa-chevron-up"></i>
    </button>
    <div class="wou-chr-empty">
      <i class="fa-solid fa-user-shield"></i>
      <div>${escapeText(msg)}</div>
    </div>
  `;
}

function renderShell(actor, data) {
  return `
    <button class="wou-chr-close" type="button" data-action="close" title="${t("WITCHER.Chrome.Character.Text.Collapse", "Collapse")}">
      <i class="fa-solid fa-chevron-up"></i>
    </button>

    <header class="wou-chr-header">
      <div class="wou-chr-title">${t("WITCHER.Chrome.Character.Text.Character", "Character")}</div>
      <div class="wou-chr-header-ctrls">
        ${game.user?.isGM ? `<div class="wou-viewtools">${renderViewPanelAsPicker("character")}${renderViewAsPicker()}</div>` : ""}
      </div>
    </header>

    <nav class="wou-chr-maintabs">
      ${renderMainTab("abilities", "fa-shield-halved", t("WITCHER.Chrome.Character.Text.Abilities", "Abilities"))}
      ${renderMainTab("wounds",    "fa-heart-crack",   t("WITCHER.Chrome.Character.Text.Wounds", "Wounds"))}
      ${renderMainTab("biography", "fa-book-bookmark", t("WITCHER.Chrome.Character.Text.Biography", "Biography"))}
    </nav>

    <div class="wou-chr-pane wou-chr-pane-abilities${activeMain === "abilities" ? " is-active" : ""}">
      ${renderAbilities(actor, data)}
    </div>

    <div class="wou-chr-pane wou-chr-pane-wounds${activeMain === "wounds" ? " is-active" : ""}">
      ${renderWounds(actor)}
    </div>

    <div class="wou-chr-pane wou-chr-pane-biography${activeMain === "biography" ? " is-active" : ""}">
      ${renderBiography(actor)}
    </div>
  `;
}

function renderMainTab(key, icon, label) {
  return `<button class="wou-chr-maintab${activeMain === key ? " is-active" : ""}" type="button" data-action="set-main" data-main="${key}"><i class="fa-solid ${icon}"></i>${escapeText(label)}</button>`;
}

/* =========================================================================
   ABILITIES PANE — portrait + bars + trackers + sub-tabs
   ========================================================================= */

function renderAbilities(actor, data) {
  return `
    <div class="wou-chr-top">
      ${renderPortrait(actor)}
      ${renderStatsList(actor)}
      <div class="wou-chr-divider" data-divider="1"></div>
      ${renderBarsStack(data)}
      <div class="wou-chr-divider" data-divider="h"></div>
      ${renderTrackersColumn(actor, data)}
      <div class="wou-chr-divider" data-divider="2"></div>
      ${renderArmorColumn(actor)}
      <div class="wou-chr-divider" data-divider="3"></div>
      ${renderActiveEffectsColumn(actor)}
    </div>

    <nav class="wou-chr-subtabs">
      ${SUB_TABS().map(t => `<button class="wou-chr-subtab${activeSub === t.key ? " is-active" : ""}" type="button" data-action="set-sub" data-sub="${t.key}"><i class="fa-solid ${t.icon}"></i>${escapeText(t.label)}</button>`).join("")}
    </nav>

    <div class="wou-chr-sub wou-chr-sub-${activeSub}">
      ${renderSubPane(actor)}
    </div>
  `;
}

function renderPortrait(actor) {
  const img = actor.img && !actor.img.includes("mystery-man") ? actor.img : null;
  const portraitInner = img
    ? `<img src="${escapeAttr(img)}" alt="" />`
    : `<i class="fa-solid fa-user"></i>`;
  const profession = actor.items.find(i => i.type === "profession")?.name ?? "";
  const race       = actor.items.find(i => i.type === "race")?.name ?? "";
  return `
    <div class="wou-chr-portrait">
      <div class="wou-chr-portrait-frame">${portraitInner}${(isVariablePortraitEnabled(actor) && (game.user?.isGM || actor.isOwner))
        ? `<button class="wdm-vp-corner" type="button" data-action="variable-portrait" title="${t("WITCHER.Chrome.Character.Text.VariablePortrait", "Variable portrait")}"><i class="fa-solid fa-flask-vial"></i></button>`
        : ""}</div>
      <div class="wou-chr-portrait-overlay">${escapeText(actor.name)}${race ? ` · ${escapeText(race)}` : ""}</div>
      ${profession ? `<div class="wou-chr-portrait-prof">${escapeText(profession)}</div>` : ""}
    </div>
  `;
}

/* Sawtooth bars — 3 pools, label + editable cur + bar
 * Matches the mockup's "label | numbers | bar" pattern. */
function renderBarsStack(data) {
  return `
    <div class="wou-chr-bars">
      ${renderBar("hp",  t("WITCHER.Chrome.Character.Text.Vitality", "Vitality"), "fa-heart",      data.hp)}
      ${renderBar("sta", t("WITCHER.Chrome.Character.Text.Stamina", "Stamina"),  "fa-wind",       data.sta)}
      ${renderBar("tox", t("WITCHER.Chrome.Character.Text.Toxicity", "Toxicity"), "fa-flask-vial", data.tox)}
    </div>
  `;
}

function renderBar(kind, label, icon, pool) {
  const frac = pool.max > 0 ? Math.max(0, Math.min(1, pool.cur / pool.max)) : 0;
  return `
    <div class="wou-chr-bar-row" data-kind="${kind}">
      <span class="wou-chr-bar-lbl"><i class="fa-solid ${icon}" aria-hidden="true"></i>${escapeText(label)}</span>
      <input class="wou-chr-bar-cur" type="number" value="${pool.cur}" data-action="set-bar" data-kind="${kind}" aria-label="${escapeAttr(label)} current" />
      <span class="wou-chr-bar-svg" style="--frac: ${(frac * 100).toFixed(0)}%;">
        <span class="wou-chr-bar-fill">
          <svg viewBox="0 0 200 12" preserveAspectRatio="none">${SAWTOOTH_FILL_PATH}</svg>
        </span>
        <svg viewBox="0 0 200 12" preserveAspectRatio="none" class="wou-chr-bar-stroke">${SAWTOOTH_STROKE_PATH}</svg>
      </span>
      <span class="wou-chr-bar-max">${pool.max}</span>
    </div>
  `;
}

/* Reusable SVG paths for the sawtooth bar (same shape as dock's pools). */
const SAWTOOTH_STROKE_PATH = `<path d="M0 1.5 L6.25 10 L12.5 1.5 L18.75 10 L25 1.5 L31.25 10 L37.5 1.5 L43.75 10 L50 1.5 L56.25 10 L62.5 1.5 L68.75 10 L75 1.5 L81.25 10 L87.5 1.5 L93.75 10 L100 1.5 L106.25 10 L112.5 1.5 L118.75 10 L125 1.5 L131.25 10 L137.5 1.5 L143.75 10 L150 1.5 L156.25 10 L162.5 1.5 L168.75 10 L175 1.5 L181.25 10 L187.5 1.5 L193.75 10 L200 1.5" fill="none" stroke="currentColor" stroke-width="1.1"/>`;
const SAWTOOTH_FILL_PATH = `<path d="M0 1.5 L6.25 10 L12.5 1.5 L18.75 10 L25 1.5 L31.25 10 L37.5 1.5 L43.75 10 L50 1.5 L56.25 10 L62.5 1.5 L68.75 10 L75 1.5 L81.25 10 L87.5 1.5 L93.75 10 L100 1.5 L106.25 10 L112.5 1.5 L118.75 10 L125 1.5 L131.25 10 L137.5 1.5 L143.75 10 L150 1.5 L156.25 10 L162.5 1.5 L168.75 10 L175 1.5 L181.25 10 L187.5 1.5 L193.75 10 L200 1.5 L200 0 L0 0 Z" fill="currentColor"/>`;

/* Trackers row — 4 cards (Stress / Adrenaline / Magic Shield / Death Saves).
 *
 * Each tracker is a single click-to-edit number — no +/- buttons.  In-play
 * interaction model:
 *   - Click the number → caret lands in the field, type a value
 *   - Mouse-wheel over the number → ±1 per tick (same UX as the bar inputs)
 *   - ↑/↓ keys while focused → ±1
 *   - Enter or blur commits the value
 * Commits flow through the same debounced `scheduleBump`/`scheduleWrite`
 * pipeline so a burst of wheel scrolls doesn't slam the actor with N
 * round-trips. */
function renderTrackersColumn(actor, data) {
  const deathCount = Number(actor.system?.deathSaves) || 0;
  const deathState = data.hp.cur <= 0 ? "is-active" : "";
  return `
    <div class="wou-chr-counters">
      <div class="wou-chr-trackers">
        ${data.stress ? renderTracker("stress", t("WITCHER.Chrome.Character.Text.Stress", "Stress"), "fa-brain", data.stress) : ""}
        ${data.adrenaline ? renderTracker("adrenaline", t("WITCHER.Chrome.Character.Text.Adrenaline", "Adrenaline"), "fa-bolt", data.adrenaline) : ""}
        ${renderTracker("shield",     t("WITCHER.Chrome.Character.Text.Shield", "Barrier"),      "fa-shield-halved",  data.shield)}
        ${data.focus?.max ? renderTracker("focus", t("WITCHER.Chrome.Character.Text.Focus", "Focus"), "fa-magnifying-glass", data.focus) : ""}
        ${data.satiety ? renderSatietyStomach(data.satiety, !!game.user?.isGM) : ""}
        ${renderTracker("deathSaves", t("WITCHER.Chrome.Character.Text.DeathSave", "Death Save"), "fa-skull",          { cur: deathCount, max: 10 }, deathState)}
      </div>
      ${renderDerivedStatsRow(actor)}
    </div>
  `;
}

/* Derived-stats strip — read-only, sits beneath the counter trackers.
 * Sourced from the system's calculated values (all plain numbers on
 * system.derivedStats — see derivedStats.mjs schema):
 *   - melee bonus    : system.derivedStats.meleeBonus   (signed, can be -)
 *   - REC            : system.derivedStats.rec
 *   - Run            : system.derivedStats.run
 *   - Leap           : system.derivedStats.leap
 *   - Max ENC        : system.derivedStats.enc
 *   - Stun           : system.derivedStats.stun
 *   - WT             : system.derivedStats.woundThreshold
 * All values come from WitcherActor's prepareDerivedData pipeline, so they
 * already reflect modifiers / wounds / encumbrance penalties. */
function renderDerivedStatsRow(actor) {
  const ds  = actor.system?.derivedStats ?? {};
  const num = (path, fallback = 0) => {
    const v = Number(path);
    return Number.isFinite(v) ? v : fallback;
  };
  const items = [
    { key: "mel",  label: t("WITCHER.Chrome.Character.Dialog.Button.Melee", "Melee"), value: num(ds.meleeBonus), signed: true, tip: t("WITCHER.Chrome.Character.Tip.Melee", "Melee damage bonus (system.derivedStats.meleeBonus)") },
    { key: "rec",  label: t("WITCHER.Chrome.Character.Text.REC", "REC"),               value: num(ds.rec),                       tip: t("WITCHER.Chrome.Character.Tip.Recovery", "Recovery — HP regained per stabilization cycle") },
    { key: "run",  label: t("WITCHER.Chrome.Character.Dialog.Button.Run",  "Run"),     value: num(ds.run),                       tip: t("WITCHER.Chrome.Character.Tip.Run",      "Run distance per action (SPD × 3)") },
    { key: "leap", label: t("WITCHER.Chrome.Character.Dialog.Button.Leap", "Leap"),    value: num(ds.leap),                      tip: t("WITCHER.Chrome.Character.Tip.Leap",     "Leap distance per action (Run ÷ 5)") },
    { key: "enc",  label: t("WITCHER.Chrome.Character.Text.ENC", "ENC"),               value: num(ds.enc),                       tip: t("WITCHER.Chrome.Character.Tip.Enc",      "Max carrying weight (BODY × 10)") },
    { key: "stun", label: t("WITCHER.Chrome.Character.Dialog.Button.Stun", "Stun"),    value: num(ds.stun),                      tip: t("WITCHER.Chrome.Character.Tip.Stun",     "Stun save target (clamped 1–10)") },
    { key: "wt",   label: t("WITCHER.Chrome.Character.Text.WT", "WT"),                 value: num(ds.woundThreshold),            tip: t("WITCHER.Chrome.Character.Tip.WT",       "Wound Threshold — HP at which Seriously Wounded penalties kick in") },
  ];
  const cells = items.map(it => {
    const display = it.signed && it.value > 0 ? `+${it.value}` : `${it.value}`;
    return `<div class="wou-chr-derived-cell" title="${escapeAttr(it.tip)}">
      <span class="wou-chr-derived-lbl">${escapeText(it.label)}</span>
      <span class="wou-chr-derived-val">${escapeText(display)}</span>
    </div>`;
  }).join("");
  return `<div class="wou-chr-derived">${cells}</div>`;
}

/* Satiety pill — clickable, opens the SatietyDialog for the full readout.
 * DOM structure mirrors renderTracker's ─/val/+ shape so col 3 (the value
 * column) lands at the same X across every row and the tier name's centre
 * aligns with the numeric values on Stress / Shield / Focus / etc.
 * Invisible −/+ placeholders hold cols 2 and 4 at button widths; a
 * width-preserving hidden "0" inside the val slot anchors the baseline
 * and the numeric column width so an absolutely-positioned tier label
 * can centre-overflow past the col edges without pushing anything wider.
 * The stomach glyph uses currentColor + a single unified amber (all tiers
 * share the same color; only the fill LEVEL inside the glyph moves). */
function renderSatietyStomach(sat, isGM) {
  const tierLabel = t("WITCHER.Chrome.Character.Text.Satiety", "Satiety");
  const valueLabel = String(sat.tierLabel || "");
  const pct = Math.max(0, Math.min(100, Number(sat.fillPct) || 0));
  const fillHeight = (192 * pct) / 100;
  const fillTop    = 192 - fillHeight;
  const clipId = `wou-satiety-clip-chrome`;
  const stomachPath = "M189.037,74.668c-7.97-32.176-34.188-32.853-48.274-33.216c-2.92-0.075-5.442-0.14-7.13-0.438c-8.423-1.487-13.116-7.29-14.345-17.741l-1.306-11.096c-0.23-1.956-1.849-3.453-3.816-3.53L97.522,7.994c-1.102-0.05-2.163,0.366-2.949,1.133c-0.786,0.766-1.223,1.822-1.208,2.919c0.014,1.013,0.457,25.028,10.605,43.634c5.42,9.936,15.738,34.799-5.449,51.042c-9.796,7.51-18.104,10.859-26.936,10.86c-5.97,0-12.088-1.415-20.025-3.697c-3.727-1.072-7.666-1.615-11.705-1.615c-15.869,0-29.768,8.159-34.586,20.302c-5.796,14.609-5.345,20.325-5.196,21.322c0.293,1.958,1.976,3.408,3.956,3.408H21c2.209,0,4-1.791,4-4c0-0.41,0.17-10.033,14.928-10.033c6.74,0,8.533,3.229,11.946,10.532c3.37,7.212,7.564,16.188,20.119,21.465c10.001,4.204,22.022,8.5,35.35,8.501c0.001,0,0.001,0,0.002,0c15.681,0,30.543-5.967,45.435-18.24C186.073,138.086,197.594,109.215,189.037,74.668z";
  /* DOM structure mirrors renderTracker's ─/val/+ shape EXACTLY so the
   * value column (col 3 of the tracker's 4-col grid) lines up with the
   * numeric values on Stress / Shield / Adrenaline / Focus / Death Save.
   * Without matching col 2 and col 4 widths, the tier text spans and
   * self-centers over the whole ─/val/+ area — visually drifting to the
   * right of where the numeric values sit. Invisible −/+ placeholders
   * hold the col 2 / col 4 widths so col 3 lands at the same X across
   * every row.
   *
   * viewBox is expanded past the anatomical bounds (0–191.756) by ~12
   * units on every side so the stroke — drawn OUTSIDE the path centreline
   * — doesn't get clipped by the SVG's own viewport (default overflow
   * hidden). Without this padding the top of the fundus + the pyloric
   * outlet on the right visibly chop off at the pill scale. */
  return `
    <div class="wou-chr-tracker wou-chr-satiety is-readonly" data-kind="satiety"
         data-action="openSatietyDialog" style="cursor:pointer;align-items:center;">
      <span class="wou-chr-tracker-lbl">
        <svg viewBox="-5 -1 211 184" aria-hidden="true"
             style="width:11px;height:10px;flex-shrink:0;display:block;pointer-events:none;color:currentColor;opacity:0.85;overflow:visible;align-self:center;">
          <defs>
            <clipPath id="${clipId}"><path d="${stomachPath}"/></clipPath>
          </defs>
          <rect x="0" y="${fillTop}" width="192" height="${fillHeight}"
                fill="currentColor" opacity="0.55" clip-path="url(#${clipId})"/>
          <path fill="none" stroke="currentColor" stroke-width="18" stroke-linejoin="round" d="${stomachPath}"/>
        </svg>${escapeText(tierLabel)}
      </span>
      <button class="wou-chr-tracker-step" type="button" tabindex="-1" aria-hidden="true"
              style="visibility:hidden;pointer-events:none;">−</button>
      <span class="wou-chr-tracker-val wou-chr-satiety-tier"
            style="display:inline-flex;align-items:center;justify-content:center;overflow:visible;cursor:pointer;pointer-events:none;">
        <span style="white-space:nowrap;flex-shrink:0;">${escapeText(valueLabel)}</span>
      </span>
      <button class="wou-chr-tracker-step" type="button" tabindex="-1" aria-hidden="true"
              style="visibility:hidden;pointer-events:none;">+</button>
    </div>
  `;
}

function renderTracker(kind, label, icon, pool, extraClass = "", opts = {}) {
  /* Prefer the in-flight optimistic value so a mid-burst re-render doesn't
   * snap the visible number back to the actor's last-committed value. */
  const shown = pendingValue(`tracker.${kind}`) ?? pool.cur;
  // Numeric bounds — when min is unspecified, default to 0 to preserve the
  // existing tracker contract. Satiety passes min=-100 to allow Famished.
  const minAttr = `min="${Number.isFinite(opts.min) ? opts.min : 0}"`;
  const maxAttr = pool.max > 0 ? `max="${pool.max}"` : "";
  const subLabel = opts.subLabel
    ? `<span class="wou-chr-tracker-sub" title="${escapeAttr(opts.subTooltip || "")}">${escapeText(opts.subLabel)}</span>`
    : "";
  // readonly: hide the +/- buttons and lock the input. The bump handler also
  // gates on this server-side (preUpdateActor in foodAndDrink.mjs); the UI
  // gate is cosmetic but matters so players don't see writable-looking
  // controls they can't actually commit. Used by satiety (GM-only edit).
  if (opts.readonly) {
    return `
      <div class="wou-chr-tracker is-readonly${extraClass ? ` ${extraClass}` : ""}" data-kind="${kind}">
        <span class="wou-chr-tracker-lbl"><i class="fa-solid ${icon}" aria-hidden="true"></i>${escapeText(label)}</span>
        <input class="wou-chr-tracker-val"
               type="number"
               readonly
               value="${shown}"
               aria-label="${escapeAttr(label)}" />
        ${subLabel}
      </div>
    `;
  }
  return `
    <div class="wou-chr-tracker${extraClass ? ` ${extraClass}` : ""}" data-kind="${kind}">
      <span class="wou-chr-tracker-lbl"><i class="fa-solid ${icon}" aria-hidden="true"></i>${escapeText(label)}</span>
      <button class="wou-chr-tracker-step" type="button"
              data-action="bump-tracker" data-tracker="${kind}" data-delta="-1"
              aria-label="${escapeAttr(tFormat("WITCHER.Chrome.Character.Aria.Decrease", { label }, `Decrease ${label}`))}">${"−"}</button>
      <input class="wou-chr-tracker-val"
             type="number"
             ${minAttr} ${maxAttr}
             value="${shown}"
             data-tracker="${kind}"
             aria-label="${escapeAttr(label)}" />
      <button class="wou-chr-tracker-step" type="button"
              data-action="bump-tracker" data-tracker="${kind}" data-delta="+1"
              aria-label="${escapeAttr(tFormat("WITCHER.Chrome.Character.Aria.Increase", { label }, `Increase ${label}`))}">+</button>
      ${subLabel}
    </div>
  `;
}

/* Armor column — mirrors the dock's combat-state SP readout.
 *
 * Each row:   [B|S|P resistances]  Location  [SP]  [-]
 *
 * Data + decrement come from the dock's helpers (getLocationSP,
 * getResistancesForLocation, decrementArmorSP) so the character sheet and
 * the dock stay in sync.  Resistance letters sit IN FRONT of the location
 * name (the dock has them in a separate left column; here they're inline
 * to keep the row compact). */
const ARMOR_LOC_FALLBACKS = {
  head: "Head", torso: "Torso",
  leftArm: "L. Arm", rightArm: "R. Arm",
  leftLeg: "L. Leg", rightLeg: "R. Leg",
};
const ARMOR_LOC_LABELS = new Proxy(ARMOR_LOC_FALLBACKS, {
  get(target, prop) {
    if (!(prop in target)) return undefined;
    return t(`WITCHER.Chrome.HitLocation.Short.${String(prop)}`, target[prop]);
  }
});

function renderArmorColumn(actor) {
  const sp = getLocationSP(actor);
  const rows = SP_LOCATIONS.map(loc => {
    const cur = Number(sp[loc]) || 0;
    const res = getResistancesForLocation(actor, loc);
    const letters = RES_TYPES
      .filter(rt => res.has(rt.key))
      .map(rt => `<span class="wou-chr-armor-res-ltr" title="${escapeAttr(rt.tip)}">${rt.letter}</span>`)
      .join("");
    const zeroClass = cur <= 0 ? " is-zero" : "";
    return `<div class="wou-chr-armor-row${zeroClass}" data-loc="${loc}">
      <span class="wou-chr-armor-loc">${escapeText(ARMOR_LOC_LABELS[loc])}</span>
      <span class="wou-chr-armor-res">${letters}</span>
      <span class="wou-chr-armor-sp">${cur}</span>
      <button class="wou-chr-armor-dec${zeroClass}" type="button"
              data-action="dec-armor" data-loc="${loc}"
              title="${escapeAttr(tFormat("WITCHER.Chrome.Character.Tip.DamageLocSPByOne", { loc: ARMOR_LOC_LABELS[loc] }, `Damage ${ARMOR_LOC_LABELS[loc]} SP by 1`))}"
              aria-label="${escapeAttr(tFormat("WITCHER.Chrome.Character.Aria.DamageLocSP", { loc: ARMOR_LOC_LABELS[loc] }, `Damage ${ARMOR_LOC_LABELS[loc]} SP`))}">-</button>
    </div>`;
  }).join("");
  return `
    <div class="wou-chr-armor">
      <div class="wou-chr-armor-head">${t("WITCHER.Chrome.Character.Text.Armor", "Armor")}</div>
      ${rows}
      ${renderArmorEVFooter(actor)}
    </div>
  `;
}

/* Total encumbrance from equipped armor + equipped weapon-shields, minus
 * any lifepath EV reduction. Prefer the actor's already-computed
 * `system.armorEV` (character.mjs prepareDerivedData folds in worn armor,
 * EO reductions, evTolerance, and the lifepathModifiers.ignoredArmorEncumbrance
 * partial-ignore). Falls back to a re-sum when armorEV isn't populated
 * (unlinked actor prototypes, non-character types).
 *
 * `ignoredArmorEncumbrance` is a NUMBER post-Witchers-Reborn (0 = none,
 * 6 = Bear Juggernaut, 99 = full ignore); the pre-WR legacy boolean is
 * coerced by the data model's migrateData. Reading it as a raw truthy
 * value the way this used to would treat +6 as "ignore everything." */
function calcTotalEV(actor) {
  if (!actor) return 0;
  const derived = Number(actor.system?.armorEV);
  if (Number.isFinite(derived)) return Math.max(0, derived);
  /* Fallback path for actors without the character data model. */
  const ignoreEV = Number(actor.system?.lifepathModifiers?.ignoredArmorEncumbrance) || 0;
  if (ignoreEV >= 99) return 0;
  const items = actor.items?.contents ?? actor.items ?? [];
  let raw = 0;
  for (const i of items) {
    if (!i.system?.equipped) continue;
    if (i.type === "armor") {
      raw += Number(i.system.effective?.encumbranceValue ?? i.system.encumbranceValue) || 0;
    } else if (i.type === "weapon" && i.flags?.["witcher-ttrpg-death-march"]?.isShield) {
      raw += Number(i.flags["witcher-ttrpg-death-march"].ev) || 0;
    }
  }
  return Math.max(0, raw - ignoreEV);
}

function renderArmorEVFooter(actor) {
  const ev = calcTotalEV(actor);
  if (ev <= 0) {
    return `<div class="wou-chr-armor-ev is-zero" title="${t("WITCHER.Chrome.Character.Text.NoEncumbranceFromEquippedGear", "No encumbrance from equipped gear.")}">
      <span class="wou-chr-armor-ev-lbl">EV</span>
      <span class="wou-chr-armor-ev-val">0</span>
    </div>`;
  }
  /* The EO armor model rewrites EV's mechanical effect: instead of
   * subtracting from REF/DEX (and the magic-only EV penalty), it
   * reduces max STA + RUN and applies half-EV to a wider skill set.
   * Pick the tooltip + the pen-label text accordingly so the chip
   * never lies. The toggle read is best-effort — outside Foundry
   * the helper isn't available; we fall back to RAW text. */
  let eoOn = false;
  try {
    const sub = game.settings?.get?.("witcher-ttrpg-death-march", "combatExtendedSubsystems") ?? {};
    const masterRaw = game.settings?.get?.("witcher-ttrpg-death-march", "homebrew.extendedCombat");
    const master = masterRaw === true || masterRaw === "true" || masterRaw === 1;
    const sysOn  = sub.eoArmorModel === undefined ? true : !!sub.eoArmorModel;
    eoOn = master && sysOn;
  } catch (_) { /* fall back to RAW text */ }
  const halfEv = Math.floor(ev / 2);
  const tip = eoOn
    ? tFormat("WITCHER.Chrome.Character.Tip.EvEo", { ev }, "Total encumbrance from equipped armor and shields. EO model: −{ev} max Stamina · −{ev} RUN (floor 2×SPD)")
      + (halfEv > 0
          ? tFormat("WITCHER.Chrome.Character.Tip.EvEoHalf", { half: halfEv }, " · −{half} on Dodge/Athletics/Stealth/Sleight/Endurance/Hexweave/Ritcraft/Spellcast.")
          : `.`)
    : tFormat("WITCHER.Chrome.Character.Tip.EvRaw", { ev }, "Total encumbrance from equipped armor and shields. −{ev} to REF and DEX (each floored at 1). Per the EV & Magic rule it is also −{ev} to Spell Casting, Hex Weaving, and Ritual Crafting rolls.");
  const pen = eoOn
    ? (halfEv > 0
        ? tFormat("WITCHER.Chrome.Character.EvPen.EoHalf",  { ev, half: halfEv }, "−{ev} STA max · −{ev} RUN · −{half} skills")
        : tFormat("WITCHER.Chrome.Character.EvPen.Eo",      { ev },               "−{ev} STA max · −{ev} RUN"))
    : tFormat("WITCHER.Chrome.Character.EvPen.Raw",         { ev },               "−{ev} REF · −{ev} DEX · −{ev} magic");
  return `<div class="wou-chr-armor-ev" title="${escapeAttr(tip)}">
    <span class="wou-chr-armor-ev-lbl">EV</span>
    <span class="wou-chr-armor-ev-val">${ev}</span>
    <span class="wou-chr-armor-ev-pen">${pen}</span>
  </div>`;
}

/* =========================================================================
   SUB-PANES
   ========================================================================= */

function renderSubPane(actor) {
  switch (activeSub) {
    case "stats":      return renderStatsAndSkills(actor);
    case "profession": return renderProfessionPane(actor);
    case "magic":      return renderMagicPane(actor);
    default:           return "";
  }
}

/* Stats list — sits in char-top, immediately right of the portrait.
 * Read-only display of the EFFECTIVE stat (`system.stats[key].value` —
 * what rolls use).  Stats can only be raised via the level-up pip, which
 * appears when the BASE is under 10 and the actor has enough IP banked.
 *
 * IP cost per Witcher TRPG core p.59 ("Raising Stats"): spend I.P. equal to
 * the LEVEL of the Statistic times 10 — i.e. the CURRENT value × 10. So
 * raising N → N+1 costs N × 10 (e.g. INT 7 → 8 costs 70), mirroring the
 * skill rule (cost = current level). */
const STAT_MAX = 10;
/* RAW Core p.59: raising a stat from N to N+1 costs N × 10 IP. RAW
 * assumes stats start at ≥1, so the formula returns 0 for a stat sitting
 * at 0 (default luck.max on a fresh character). That let a player level
 * luck 0 → 1 for free. Floor at 1 so the initial raise costs the same
 * 10 IP a 1→2 raise does. */
function statLevelUpCost(currentBase) {
  return Math.max(1, Number(currentBase) || 0) * 10;
}

/* The IP-purchased rank is the SOURCE value — `system.stats.<key>.value` for
 * core stats, `system.stats.luck.max` for LUCK. We read `_source` (not the
 * prepared model) so AE / wound / EV modifiers folded in by prepareDerivedData
 * don't corrupt the base we level off of. */
function statBaseValue(actor, statKey) {
  const src = actor.system?._source?.stats?.[statKey] ?? {};
  return Number(statKey === "luck" ? src.max : src.value) || 0;
}
function renderStatsList(actor) {
  const ip = Number(actor.system?.improvementPoints) || 0;
  const primaryRows = STATS.map(s => renderPrimaryStatRow(actor, s, ip)).join("");
  return `<div class="wou-chr-stats">${primaryRows}${renderLuckRow(actor, ip)}</div>`;
}

function renderPrimaryStatRow(actor, s, ip) {
  const statBlock = actor.system?.stats?.[s.key] ?? {};
  const base      = statBaseValue(actor, s.key);
  const effective = Number(statBlock.value) || 0;
  const delta     = effective - base;
  const cls = ["wou-chr-stat-val"];
  if (delta > 0) cls.push("is-positive");
  else if (delta < 0) cls.push("is-negative");
  const tip = delta === 0
    ? `${s.label}: ${effective} (base ${base}).`
    : `Effective ${s.label} = ${effective} (base ${base}${delta > 0 ? ` + ${delta}` : ` − ${Math.abs(delta)}`}).`;
  const cost = statLevelUpCost(base);
  const canLevel = base < STAT_MAX && ip >= cost;
  const levelBtn = canLevel
    ? `<button class="wou-chr-stat-levelup" type="button"
               data-action="level-up-stat" data-stat="${escapeAttr(s.key)}"
               title="${escapeAttr(tFormat("WITCHER.Chrome.Character.Tip.SpendIPRaiseStat", { cost, label: s.label, base, next: base + 1 }, `Spend ${cost} IP to raise ${s.label} ${base} → ${base + 1}`))}"
               aria-label="${escapeAttr(tFormat("WITCHER.Chrome.Character.Aria.LevelUpStat", { label: s.label }, `Level up ${s.label}`))}">
         <i class="fa-solid fa-arrow-up-from-bracket"></i>
       </button>`
    : "";
  return `<div class="wou-chr-stat-row">
    <span class="wou-chr-stat-abbr">${escapeText(s.label)}</span>
    <span class="${cls.join(" ")}" title="${escapeAttr(tip)}">${effective}</span>
    ${levelBtn}
  </div>`;
}

/* LUCK gets bespoke handling: per the system data model, `system.stats.luck`
 * tracks BOTH a maximum (`max` — the IP-allocated rank that level-ups push
 * up) AND a separate current pool (`value`).  Unlike the primary stats,
 * players spend and refill the pool manually.  So the row shows `cur / max`
 * with −/+ buttons that adjust the current pool, and the level-up pip still
 * raises the max.
 *
 * `base` is the SOURCE max (the rank we level off of); the prepared `max`
 * adds any AE modifiers on top. */
function renderLuckRow(actor, ip) {
  const block = actor.system?.stats?.luck ?? {};
  const base  = statBaseValue(actor, "luck");
  const max   = Number(block.max) || 0;
  const cur   = Number(block.value) || 0;
  const cost  = statLevelUpCost(base);
  const canLevel = base < STAT_MAX && ip >= cost;
  const levelBtn = canLevel
    ? `<button class="wou-chr-stat-levelup" type="button"
               data-action="level-up-stat" data-stat="luck"
               title="${escapeAttr(tFormat("WITCHER.Chrome.Character.Tip.SpendIPRaiseLuck", { cost, base, next: base + 1 }, `Spend ${cost} IP to raise Luck max ${base} → ${base + 1}`))}"
               aria-label="${t("WITCHER.Chrome.Character.Text.LevelUpLuck", "Level up Luck")}">
         <i class="fa-solid fa-arrow-up-from-bracket"></i>
       </button>`
    : "";
  const tip = tFormat("WITCHER.Chrome.Character.Tip.LuckPool", { cur, max, baseSuffix: base !== max ? ` (base ${base})` : "" }, `Luck pool: ${cur} / ${max}${base !== max ? ` (base ${base})` : ""}.`);
  return `<div class="wou-chr-stat-row is-luck is-luck-pool">
    <span class="wou-chr-stat-abbr">LUCK</span>
    <span class="wou-chr-stat-luck" title="${escapeAttr(tip)}">
      <button class="wou-chr-luck-step" type="button"
              data-action="bump-luck" data-delta="-1"
              aria-label="${t("WITCHER.Chrome.Character.Text.SpendAPointOfLuck", "Spend a point of Luck")}">−</button>
      <span class="wou-chr-luck-cur">${cur}</span>
      <span class="wou-chr-luck-sep">/</span>
      <span class="wou-chr-luck-max">${max}</span>
      <button class="wou-chr-luck-step" type="button"
              data-action="bump-luck" data-delta="+1"
              aria-label="${t("WITCHER.Chrome.Character.Text.RestoreAPointOfLuck", "Restore a point of Luck")}">+</button>
    </span>
    ${levelBtn}
  </div>`;
}

/* ---- Stats & Skills ---------------------------------------------------- */
function renderStatsAndSkills(actor) {

  /* Skills — iterate each stat's skill block and only keep entries that
   * actually look like a Skill data model (numeric .value).  Foundry exposes
   * extra DataModel internals (schema, parent, _source, plus the per-skill
   * `modifiers` array and `activeEffectModifiers` number) which earlier
   * versions of this code surfaced as bogus rows.
   *
   * Row shape: [rank input] [name] [10-diamond track] [total = skill + stat].
   * The rank input edits the BASE skill value directly (commits on blur/Enter).
   * Diamonds visualise progression and let you spend IP (next empty one is a
   * level-up button when IP is available).  Total is the roll modifier. */
  const ip      = Number(actor.system?.improvementPoints) || 0;
  const magicIp = Number(actor.system?.magic?.magicImprovementPoints) || 0;
  const skillMap   = globalThis.CONFIG?.WITCHER?.skillMap   ?? {};
  const magicSkillList = globalThis.CONFIG?.WITCHER?.magicSkills ?? [];

  const skills = actor.system?.skills ?? {};
  const skillSections = STATS.map(s => {
    const block = skills[s.key];
    if (!block || typeof block !== "object") return "";
    const statVal = Number(actor.system?.stats?.[s.key]?.value) || 0;
    const rows = Object.entries(block)
      .filter(([, sk]) => sk && typeof sk === "object" && typeof sk.value === "number")
      // Skip homebrew-tagged skills whose subsystem is currently off (e.g.
      // `cooking` is hidden when foodAndDrink is disabled). Schema field still
      // exists per ADR 0003 — the row is just not rendered.
      .filter(([skKey]) => {
        const tag = skillMap[skKey]?.homebrew;
        return !tag || isHomebrewEnabled(tag);
      })
      .map(([skKey, sk]) => {
        const lvl = Number(sk.value) || 0;
        const isProf = sk.category === "profession";
        const labelKey = globalThis.CONFIG?.WITCHER?.skillLabel?.(skKey);
        const baseName = labelKey ? game.i18n.localize(labelKey) : skKey;
        /* Difficult skills (SKILL_MAP.costMultiplier === 2) prefix "(2) "
         * onto the display name so the ×2 IP cost is visible in the
         * skill list at a glance. Mirrors the base character sheet
         * template's rule (templates/actor/character/main.hbs:413). */
        const skIsDifficult = (Number(skillMap[skKey]?.costMultiplier) || 1) === 2;
        const name = skIsDifficult ? `(2) ${baseName}` : baseName;
        const isMagic = magicSkillList.includes(skKey);
        const costMul = Number(skillMap[skKey]?.costMultiplier) || 1;
        const cost = Math.max(lvl, 1) * costMul;
        /* Mode-aware level-up eligibility:
         *  - "magic" mode: only magic skills can be leveled; check Magic IP alone.
         *  - "any" mode:   regular IP first, plus Magic IP fallback for magic
         *                  skills (the fallback triggers a confirm dialog in
         *                  onLevelUpSkill — the diamond just needs to know the
         *                  combined pool can cover it). */
        const canLevel = _ipMode === "magic"
          ? (isMagic && lvl < 10 && magicIp >= cost)
          : (lvl < 10 && (ip >= cost || (isMagic && (ip + magicIp) >= cost)));
        /* Effective skill rank = base + the per-skill `effectiveModifier`
         * (temporary adjustment from items / conditions PLUS the
         * armor EV penalty that character.mjs bakes in). Falls back
         * to raw `modifier` when effectiveModifier hasn't been
         * derived yet (older actors mid-migration). */
        const skillDelta = Number(sk.effectiveModifier ?? sk.modifier) || 0;
        const rawMod     = Number(sk.modifier) || 0;
        const evPen      = Number(sk.evPenalty) || 0;
        const effective  = lvl + skillDelta;
        /* Right-side total = the full roll modifier: effective stat
         * (already includes stat modifiers via .value) + effective skill.
         * The diamond track tracks the BASE skill level — IP progression
         * is tied to purchased levels, not temporary buffs. */
        const total = effective + statVal;
        const inputCls = ["wou-chr-skill-input"];
        if (skillDelta > 0) inputCls.push("is-positive");
        else if (skillDelta < 0) inputCls.push("is-negative");
        /* Tooltip explains the modifier composition. If EV is applied,
         * break it out separately so the source of the negative is
         * obvious. */
        let inputTip;
        if (skillDelta === 0) {
          inputTip = `${name}: ${effective}.`;
        } else {
          const parts = [];
          if (rawMod !== 0) parts.push(`mod ${rawMod > 0 ? `+${rawMod}` : rawMod}`);
          if (evPen > 0)    parts.push(`EV −${evPen}`);
          const composition = parts.length ? ` (${parts.join(", ")})` : "";
          inputTip = `Effective ${name} = ${effective} (base ${lvl}${skillDelta > 0 ? ` + ${skillDelta}` : ` − ${Math.abs(skillDelta)}`})${composition}.`;
        }
        const totalTip = `Roll total ${total} = effective stat ${statVal} + effective skill ${effective}.`;
        /* `is-mode-inactive` marks non-magic rows in magic mode so CSS can
         * dim the entire row — matches "greyed out" per the design. */
        const inactive = _ipMode === "magic" && !isMagic;
        return `<div class="wou-chr-skill${lvl === 0 ? " is-zero" : ""}${isProf ? " is-prof" : ""}${inactive ? " is-mode-inactive" : ""}">
          <input class="${inputCls.join(" ")}" type="number" min="0" max="10" step="1"
                 data-action="set-skill" data-stat="${escapeAttr(s.key)}" data-skill="${escapeAttr(skKey)}"
                 value="${effective}" title="${escapeAttr(inputTip)}" aria-label="${escapeAttr(name)}" />
          <span class="wou-chr-skill-name" title="${escapeAttr(name)}">${escapeText(name)}</span>
          ${renderDiamondTrack(lvl, isProf, canLevel, skKey, cost)}
          <span class="wou-chr-skill-total" title="${escapeAttr(totalTip)}">${total}</span>
        </div>`;
      }).join("");
    if (!rows) return "";
    return `<div class="wou-chr-skill-section stat-${s.key}">
      <div class="wou-chr-skill-head"><span>${escapeText(s.label === "BOD" ? "Body" : titleCase(s.key))}</span><span class="wou-chr-skill-statval">${statVal}</span></div>
      ${rows}
    </div>`;
  }).join("");

  return `
    ${renderIpBanner(actor)}
    <div class="wou-chr-skills-scroll"><div class="wou-chr-skills-grid">${skillSections}</div></div>
  `;
}

/* IP banner — shows unspent improvement points.  Sits at the top of the
 * Stats & Skills sub-pane because that's where level-ups happen.
 *
 * Both chips are toggle buttons for the current spend mode:
 *   - IP chip active     → mode "any" (all skills level-uppable, Magic IP
 *                          is spent for magical skills only after a
 *                          confirm dialog when regular IP runs short).
 *   - Magic IP chip act. → mode "magic" (only magical skills show a
 *                          level-up diamond; spends Magic IP only).
 * The Magic IP chip is always visible so casters can flip modes even
 * when they've drained their Magic IP to 0 (useful for reading the
 * greyed-out state or planning the next reward). */
function renderIpBanner(actor) {
  const ip = Number(actor.system?.improvementPoints) || 0;
  const magicIp = Number(actor.system?.magic?.magicImprovementPoints) || 0;
  const isMagicMode = _ipMode === "magic";
  const anyActive   = isMagicMode ? "" : " is-active";
  const magicActive = isMagicMode ? " is-active" : "";
  const anyTip    = t("WITCHER.Chrome.Character.Text.IPModeAnyTip",   "Regular IP mode — level up any skill. Click Magic IP to switch modes.");
  const magicTip  = t("WITCHER.Chrome.Character.Text.IPModeMagicTip", "Magic IP mode — only magical skills can be leveled, using Magic IP. Click IP to switch modes.");
  const hint = isMagicMode
    ? t("WITCHER.Chrome.Character.Text.IPBannerHintMagic", "Click an empty diamond on a magical skill to spend Magic IP")
    : t("WITCHER.Chrome.Character.Text.ClickAnEmptyDiamondOnASkillToSpend", "Click an empty diamond on a skill to spend");
  return `
    <div class="wou-chr-ip-banner">
      <button type="button" class="wou-chr-ip-chip${anyActive}"
              data-action="set-ip-mode" data-ip-mode="any"
              title="${escapeAttr(anyTip)}"
              aria-pressed="${isMagicMode ? "false" : "true"}">
        <i class="fa-solid fa-arrow-up-from-bracket"></i>
        <span class="wou-chr-ip-lbl">IP</span>
        <span class="wou-chr-ip-val">${ip}</span>
      </button>
      <button type="button" class="wou-chr-ip-chip is-magic${magicActive}"
              data-action="set-ip-mode" data-ip-mode="magic"
              title="${escapeAttr(magicTip)}"
              aria-pressed="${isMagicMode ? "true" : "false"}">
        <i class="fa-solid fa-wand-sparkles"></i>
        <span class="wou-chr-ip-lbl">${t("WITCHER.Chrome.Character.Text.MagicIP", "Magic IP")}</span>
        <span class="wou-chr-ip-val">${magicIp}</span>
      </button>
      <span class="wou-chr-ip-hint">${escapeText(hint)}</span>
    </div>
  `;
}

function titleCase(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/* 10-diamond skill track.
 *
 *   ◆◆◆◇◇◇◇◇◇◇         level 3 of 10
 *   ◆◆◆[◆]◇◇◇◇◇◇       level 3, IP available → diamond 4 is a button
 *
 * When `canLevel` is true the next-empty diamond renders as a button that
 * fires `level-up-skill`; everything else is a non-interactive span.
 * Profession skills use the gilt-ish accent so the "this counts toward IP
 * efficiency" cue from the old ◆-prefix is preserved without occupying a
 * separate column. */
function renderDiamondTrack(lvl, isProfession, canLevel, skKey, cost) {
  const profClass = isProfession ? " is-prof" : "";
  const cells = [];
  for (let i = 1; i <= 10; i++) {
    if (i <= lvl) {
      cells.push(`<span class="wou-chr-dia is-filled${profClass}">◆</span>`);
    } else if (i === lvl + 1 && canLevel) {
      /* Level-up button uses the HOLLOW diamond so it visually matches
       * the standard "empty" cell (just brighter / clickable) — same
       * convention as the profession diamond track. */
      cells.push(
        `<button class="wou-chr-dia is-levelup${profClass}" type="button"
                 data-action="level-up-skill" data-skill="${escapeAttr(skKey)}"
                 aria-label="${escapeAttr(tFormat("WITCHER.Chrome.Character.Aria.LevelUpSpendIP", { cost }, `Level up — spend ${cost} IP`))}"
                 title="${escapeAttr(tFormat("WITCHER.Chrome.Character.Tip.SpendIPRaiseTo", { cost, next: lvl + 1 }, `Spend ${cost} IP to raise to ${lvl + 1}`))}">◇</button>`
      );
    } else {
      cells.push(`<span class="wou-chr-dia is-empty">◇</span>`);
    }
  }
  return `<span class="wou-chr-skill-track">${cells.join("")}</span>`;
}

/* ---- Profession -------------------------------------------------------- */
/* Layout:
 *   [Defining Skill — full-width box]
 *   [Path 1 col]  [Path 2 col]  [Path 3 col]   ← 3 boxes per path stacked
 *
 * Every box is a single skill: header with name + 10-diamond track + level
 * total; body is the skill description.  Clicking the header toggles the
 * body open/closed.  Clicking an empty diamond spends IP to raise the
 * skill level on the profession item.  `definition` is HTMLField so we
 * pass it through verbatim. */
function renderProfessionPane(actor) {
  const prof = actor.items.find(i => i.type === "profession");
  if (!prof) return `<div class="wou-chr-empty-tab">${t("WITCHER.Chrome.Character.Text.NoProfessionItemOnThisCharacter", "No profession item on this character.")}</div>`;
  const sys = prof.system ?? {};
  const ip      = Number(actor.system?.improvementPoints) || 0;
  const magicIp = Number(actor.system?.magic?.magicImprovementPoints) || 0;
  const magicSkillList = globalThis.CONFIG?.WITCHER?.magicSkills ?? [];
  const skillMap = globalThis.CONFIG?.WITCHER?.skillMap ?? {};

  /* skillKey is unique per slot ("defining" / "path1.skill1" / etc.) and
   * drives both the expand-toggle and the level-up dispatch.
   * `locked` is true when the skill above in the same path hasn't hit
   * level 5 yet — the skill greys out, diamonds aren't level-up buttons,
   * and the level-up handler refuses to act on it. */
  const renderProfBox = (slot, skillKey, accent, locked = false) => {
    if (!slot?.skillName) return "";
    const lvl   = Number(slot.level) || 0;
    const stat  = String(slot.stat ?? "").toUpperCase();
    const def   = String(slot.definition ?? "").trim();
    const expanded = expandedProfSkills.has(skillKey);
    /* IP cost mirrors the regular skill formula: max(lvl, 1) × costMul. */
    const skKey  = slot.skillKey ?? slot.skillName?.toLowerCase().replace(/\s+/g, "");
    const costMul = Number(skillMap[skKey]?.costMultiplier) || 1;
    const cost = Math.max(lvl, 1) * costMul;
    /* A profession slot is magic-eligible if either (a) the underlying skill
     * key is in the base magic list, or (b) the slot itself is flagged
     * `isMagical` in the profession item's config. Homebrew / custom
     * profession skills opt in via (b). */
    const isMagic = magicSkillList.includes(skKey) || !!slot.isMagical;
    const canLevel = !locked && lvl < 10 && (_ipMode === "magic"
      ? (isMagic && magicIp >= cost)
      : (ip >= cost || (isMagic && (ip + magicIp) >= cost)));
    const inactive = _ipMode === "magic" && !isMagic;
    /* The head wrapper is a div (not a button) because the diamond track
     * inside contains its own <button>s for level-up — nested <button>
     * elements are invalid HTML and the browser auto-closes the outer,
     * detaching the diamond from the header and breaking the grid. */
    return `<div class="wou-chr-prof-box ${accent}${expanded ? " is-expanded" : ""}${lvl === 0 ? " is-zero" : ""}${locked ? " is-locked" : ""}${inactive ? " is-mode-inactive" : ""}"
                 ${locked ? `title="${t("WITCHER.Chrome.Character.Text.UnlockByRaisingThePreviousSkillInThisPat", "Unlock by raising the previous skill in this path to level 5")}"` : ""}>
      <div class="wou-chr-prof-box-head"
           role="button" tabindex="0"
           data-action="toggle-prof-skill" data-skill-key="${escapeAttr(skillKey)}"
           aria-expanded="${expanded ? "true" : "false"}">
        <span class="wou-chr-prof-caret"><i class="fa-solid fa-chevron-${expanded ? "down" : "right"}"></i></span>
        <span class="wou-chr-prof-name">${costMul === 2 ? "(2) " : ""}${escapeText(slot.skillName)}</span>
        ${stat && stat !== "NONE" ? `<span class="wou-chr-prof-stat">${escapeText(stat)}</span>` : ""}
        ${locked ? `<span class="wou-chr-prof-lock" title="${t("WITCHER.Chrome.Character.Text.Locked", "Locked")}"><i class="fa-solid fa-lock"></i></span>` : ""}
        ${renderProfDiamonds(lvl, canLevel, skillKey, cost)}
        <span class="wou-chr-prof-lvl">${lvl}</span>
        ${stat && stat !== "NONE"
          ? `<button type="button" class="wou-chr-prof-roll" data-action="roll-prof-skill"
                data-skill-key="${escapeAttr(skillKey)}" title="Roll ${escapeAttr(slot.skillName)}"><i class="fa-solid fa-dice-d10"></i></button>`
          : ""}
      </div>
      ${expanded ? `<div class="wou-chr-prof-def">${def || `<em>${t("WITCHER.Chrome.Character.Text.NoDescription", "No description.")}</em>`}</div>` : ""}
    </div>`;
  };

  /* Defining skill has no prereq — always unlocked. */
  const defining = renderProfBox(sys.definingSkill, "defining", "defining");

  /* Defining skill gates the first slot of every path — you can't start a
   * path until the defining skill is at level 5.  Then within a path the
   * usual rule applies (each skill below requires the one above ≥ 5). */
  const definingLevel = Number(sys.definingSkill?.level) || 0;

  const pathCol = (pathKey, fallback, p, accent) => {
    if (!p) return `<div class="wou-chr-prof-path-col"></div>`;
    const pathName = p.pathName?.trim() || fallback;
    const slots = ["skill1", "skill2", "skill3"];
    let prevLevel = definingLevel; /* skill1 unlocked once defining ≥ 5 */
    const boxes = slots.map(k => {
      const slot = p[k];
      const locked = prevLevel < 5;
      const html = renderProfBox(slot, `path${pathKey}.${k}`, accent, locked);
      prevLevel = Number(slot?.level) || 0;
      return html;
    }).join("");
    return `<div class="wou-chr-prof-path-col ${accent}">
      <div class="wou-chr-prof-path-name">${escapeText(pathName)}</div>
      ${boxes}
    </div>`;
  };

  return `
    <div class="wou-chr-prof-strip">
      <div class="wou-chr-prof-title">${escapeText(prof.name)}</div>
    </div>
    ${renderIpBanner(actor)}
    <div class="wou-chr-prof-scroll">
      ${defining ? `<div class="wou-chr-prof-defining-row">${defining}</div>` : ""}
      <div class="wou-chr-prof-paths">
        ${pathCol("1", t("WITCHER.Chrome.Character.Text.Path1", "Path 1"), sys.skillPath1, "path-1")}
        ${pathCol("2", t("WITCHER.Chrome.Character.Text.Path2", "Path 2"), sys.skillPath2, "path-2")}
        ${pathCol("3", t("WITCHER.Chrome.Character.Text.Path3", "Path 3"), sys.skillPath3, "path-3")}
      </div>
    </div>
  `;
}

/* 10-diamond track for profession skills.  Uses the exact same classes
 * as `renderDiamondTrack` (no `is-prof` modifier) so the visuals match
 * the regular skill section one-for-one. */
function renderProfDiamonds(lvl, canLevel, skillKey, cost) {
  const cells = [];
  for (let i = 0; i < 10; i++) {
    if (i < lvl) {
      cells.push(`<span class="wou-chr-dia is-filled">◆</span>`);
    } else if (i === lvl && canLevel) {
      cells.push(`<button type="button"
                          class="wou-chr-dia is-levelup"
                          data-action="level-up-prof-skill"
                          data-skill-key="${escapeAttr(skillKey)}"
                          title="${escapeAttr(tFormat("WITCHER.Chrome.Character.Aria.LevelUpSpendIP", { cost }, `Level up — spend ${cost} IP`))}"
                          aria-label="${escapeAttr(tFormat("WITCHER.Chrome.Character.Aria.LevelUpSpendIP", { cost }, `Level up — spend ${cost} IP`))}">◇</button>`);
    } else {
      cells.push(`<span class="wou-chr-dia is-empty">◇</span>`);
    }
  }
  return `<span class="wou-chr-skill-track">${cells.join("")}</span>`;
}

/* ---- Magic ------------------------------------------------------------- */
/* Magic pane layout:
 *   [Vigor indicator]  [Focus 1] [Focus 2] [Focus 3] [Focus 4]
 *   [Filter tabs: All / Signs / Spells / Invocations / Gifts / Hexes / Rituals]
 *   [Section: Signs]            (only if non-empty AND not filtered out)
 *   [Section: Spells]
 *   [Section: Invocations]
 *   [Section: Magical Gifts]
 *   [Section: Hexes]
 *   [Section: Rituals]
 *
 * Cards are grouped by (item.type, item.system.class) — see `magicCategory`.
 * The left-border accent is the spell's element when it has one (damageType),
 * otherwise the category's default colour.  Clicking a card opens the item
 * sheet (no cast flow yet); right-click does the same.
 */
const MAGIC_SECTIONS = () => [
  { key: "sign",       label: t("WITCHER.Chrome.Character.Dialog.Button.Signs", "Signs"),          defaultAccent: "var(--wdm-frost)" },
  { key: "spell",      label: t("WITCHER.Chrome.Character.Dialog.Button.Spells", "Spells"),         defaultAccent: "#b29ad0" },
  { key: "invocation", label: t("WITCHER.Chrome.Character.Dialog.Button.Invocations", "Invocations"),    defaultAccent: "var(--wdm-gilt-hi, #d8a448)" },
  { key: "gift",       label: t("WITCHER.Chrome.Character.Dialog.Button.MagicalGifts", "Magical Gifts"),  defaultAccent: "var(--wdm-amber)" },
  { key: "hex",        label: t("WITCHER.Chrome.Character.Dialog.Button.Hexes", "Hexes"),          defaultAccent: "#8a4a5a" },
  { key: "ritual",     label: t("WITCHER.Chrome.Character.Dialog.Button.Rituals", "Rituals"),        defaultAccent: "var(--wdm-amber-dim)" },
];

/* Two sources of accent on a spell card:
 *
 *   1. `system.source` is the "Element" UI field on Spells + Witcher signs
 *      (earth/air/fire/water/mixedElements).  This is the primary tint —
 *      a Witcher casting Igni reads as fire; an Aedirnian water mage reads
 *      as blue across their whole spell list.
 *
 *   2. `system.damageType` is a damage axis (ice/electricity/slashing/...)
 *      that hexes and damage-causing spells use when they don't have a
 *      cosmological Element.  It's the secondary fallback so a hex still
 *      gets a meaningful colour.
 *
 * Keys lowercased on lookup — the system stores `Water` with a capital W
 * (schema quirk), but we don't want a different colour for water vs Water.
 */
/* Palette sampled from A Tome of Chaos p.81 — the "Mage Spells" illustration
 * is the canonical depiction of the four elements (moss-green earth golem,
 * chartreuse magical aura for air, deep cold sea-blue water, ember orange
 * fire) and the book's wine-burgundy chapter banner is its "Mixed" colour.
 * Keys are lowercased so the schema's capitalised "Water" still resolves. */
const ELEMENT_ACCENTS = {
  /* From system.source — the "Element" field */
  earth:         "#7a9a3a",
  air:           "#e8eef2",
  fire:          "#c8654a",
  water:         "#3a6aa0",
  mixedelements: "#8a1d3c",
  mixed:         "#8a1d3c",
  /* From system.damageType — damage-typed spells/hexes without an Element */
  ice:         "#7ab4d4",
  cold:        "#7ab4d4",
  electricity: "#d8c060",
  lightning:   "#d8c060",
  acid:        "#7ea63a",
  elemental:   "var(--wdm-amber)",
  bludgeoning: "#a09080",
  slashing:    "var(--wdm-red-bright)",
  piercing:    "#c8a878",
};

/* Pretty labels for the Element chip — source values use a couple of awkward
 * forms (mixedElements is camelCased, Water is capitalized) that don't
 * print well via titleCase. */
const ELEMENT_FALLBACKS = {
  earth:         "Earth",
  air:           "Air",
  fire:          "Fire",
  water:         "Water",
  mixedelements: "Mixed",
  mixed:         "Mixed",
};
const ELEMENT_LABELS = new Proxy(ELEMENT_FALLBACKS, {
  get(target, prop) {
    if (!(prop in target)) return undefined;
    return t(`WITCHER.Chrome.Character.Element.${String(prop)}`, target[prop]);
  }
});

/* Sign-specific palette — overrides the element tint when a Witcher-class
 * spell's name matches one of the five canonical signs.  Sampled from the
 * user's canonical reference (the painted-mandala sign sigils).  Keyed by
 * lowercase name; falls back to element/damageType for renamed or
 * non-canonical signs. */
const SIGN_ACCENTS = {
  aard:  "#28c0c0",   // cyan-teal
  igni:  "#c84030",   // ember red
  yrden: "#b04898",   // magenta-purple
  quen:  "#d8843a",   // amber-gold
  axii:  "#3ab048",   // emerald green
};

/* Casting-tier short labels (system uses lowercase strings on spell.level). */
const SPELL_LEVEL_FALLBACKS = {
  novice:     "Novice",
  journeyman: "Journ.",
  master:     "Master",
};
const SPELL_LEVEL_LABELS = new Proxy(SPELL_LEVEL_FALLBACKS, {
  get(target, prop) {
    if (!(prop in target)) return undefined;
    return t(`WITCHER.Chrome.Character.SpellLevel.${String(prop)}`, target[prop]);
  }
});

/* Map an item to one of MAGIC_SECTIONS' keys.  Spell items carry a
 * `system.spellForm` enum (spell | sign | invocation) — signs are the five
 * Witcher signs (Aard/Igni/Yrden/Quen/Axii), invocations are priestly.
 * Hexes and rituals are their own item types.  Anything else falls through
 * to the bare spell bucket. */
function magicCategory(item) {
  const t = item.type;
  if (t === "hex")    return "hex";
  if (t === "ritual") return "ritual";
  if (t === "spell") {
    const form = String(item.system?.spellForm ?? "").trim();
    if (form === "sign")       return "sign";
    if (form === "invocation") return "invocation";
    return "spell";
  }
  return "spell";
}

function renderMagicPane(actor) {
  const items  = actor.items?.filter(i => ["spell","hex","ritual"].includes(i.type)) ?? [];
  // Vigor is a single static threshold number (Core p.38/48) — the per-round
  // ceiling on magic STA cost, NOT a value/max pool. STA is the spent resource.
  const vigor  = Number(actor.system?.derivedStats?.vigor) || 0;
  // Equipped spellcasting foci the caster may cast through (gated on a
  // profession with "Can use Foci"). Read-only readout — the source of truth
  // is the equipped Focus / weapon / armor items, not editable header fields.
  const foci = actor._availableFoci?.() ?? [];

  /* Group items by category. */
  const buckets = Object.fromEntries(MAGIC_SECTIONS().map(s => [s.key, []]));
  for (const it of items) {
    const k = magicCategory(it);
    if (buckets[k]) buckets[k].push(it);
  }

  /* If the active filter no longer exists on this actor (e.g. user filtered
   * to Signs then deleted every sign), fall back to "all" so the pane never
   * shows a blank state from a stale tab selection. */
  if (activeMagicFilter !== "all" && !buckets[activeMagicFilter]?.length) {
    activeMagicFilter = "all";
  }

  const visibleSections = MAGIC_SECTIONS().filter(sec => {
    if (activeMagicFilter !== "all" && sec.key !== activeMagicFilter) return false;
    return (buckets[sec.key]?.length ?? 0) > 0;
  });

  const sections = visibleSections.map(sec => {
    const list      = buckets[sec.key];
    const collapsed = collapsedMagicSections.has(sec.key);
    const cards     = collapsed ? "" : list.map(sp => renderSpellCard(sp, sec)).join("");
    return `<div class="wou-chr-magic-section${collapsed ? " is-collapsed" : ""}">
      <button type="button" class="wou-chr-magic-section-head"
              data-action="toggle-magic-section" data-section-key="${escapeAttr(sec.key)}"
              aria-expanded="${collapsed ? "false" : "true"}">
        <i class="fa-solid fa-chevron-down wou-chr-magic-chev"></i>
        <span class="wou-chr-magic-section-label">${escapeText(sec.label)}</span>
        <span class="wou-chr-magic-count">${list.length}</span>
      </button>
      ${collapsed ? "" : `<div class="wou-chr-magic-grid">${cards}</div>`}
    </div>`;
  }).join("");

  return `
    ${renderMagicHeader(vigor, foci)}
    ${renderMagicFilterTabs(buckets)}
    <div class="wou-chr-magic-scroll">
      ${sections || `<div class="wou-chr-empty-tab">${t("WITCHER.Chrome.Character.Text.NoSpellsHexesOrRitualsLearned", "No spells, hexes, or rituals learned.")}</div>`}
    </div>
  `;
}

/* Filter tab strip — t("WITCHER.Common.All", "All") + every category that has at least one item on
 * this actor.  Empty categories are hidden entirely (no point in a Hexes tab
 * for a character who knows no hexes).  Counts shown next to each label. */
function renderMagicFilterTabs(buckets) {
  const total = Object.values(buckets).reduce((s, list) => s + list.length, 0);
  if (total === 0) return "";

  const tabs = [{ key: "all", label: t("WITCHER.Common.All", "All"), count: total }];
  for (const sec of MAGIC_SECTIONS()) {
    const n = buckets[sec.key]?.length ?? 0;
    if (n > 0) tabs.push({ key: sec.key, label: sec.label, count: n });
  }

  const html = tabs.map(t => {
    const cls = activeMagicFilter === t.key ? " is-active" : "";
    return `<button type="button" class="wou-chr-magic-tab${cls}"
                    data-action="set-magic-filter" data-filter="${escapeAttr(t.key)}">
      ${escapeText(t.label)}<span class="wou-chr-magic-tab-count">${t.count}</span>
    </button>`;
  }).join("");

  return `<div class="wou-chr-magic-tabs">${html}</div>`;
}

/* Top strip — Vigor (left) and the equipped-foci readout, anchored immediately
 * to the right of vigor.  Mirrors the bars row aesthetic: flat, no card
 * chrome, accent-coloured labels.  The foci are READ-ONLY here: their source
 * of truth is the equipped Focus / weapon / armor items carrying the Focus and
 * Greater Focus qualities.  Each chip shows the STA reduction (−N) and Greater
 * Focus roll bonus (+N).  Empty when the caster has no usable foci equipped. */
function renderMagicHeader(vigor, foci) {
  const focusChips = (foci ?? []).map(f => {
    const bits = [];
    if (Number(f.focus) > 0)        bits.push(`−${Number(f.focus)} STA`);
    if (Number(f.greaterFocus) > 0) bits.push(`+${Number(f.greaterFocus)}`);
    const tip = tFormat(
      "WITCHER.Chrome.Character.Text.EquippedFocusTip",
      { name: f.name }, "{name} — equipped spellcasting focus."
    );
    return `<span class="wou-chr-focus" data-tooltip="${escapeAttr(tip)}">
      <span class="wou-chr-focus-name">${escapeText(f.name)}</span>
      ${bits.length ? `<span class="wou-chr-focus-val">${escapeText(bits.join(" · "))}</span>` : ""}
    </span>`;
  }).join("");
  return `
    <div class="wou-chr-magic-header">
      <span class="wou-chr-vigor" data-tooltip="${t("WITCHER.Chrome.Character.Text.PerRoundVigorThresholdMaxMagicSTACostPer", "Per-round Vigor threshold — max magic STA cost per round (Core p.38).")}">
        <span class="wou-chr-vigor-lbl">${t("WITCHER.Chrome.Character.Text.Vigor", "Vigor")}</span>
        <span class="wou-chr-vigor-val">${Number(vigor) || 0}</span>
      </span>
      ${foci?.length ? `<span class="wou-chr-focuses">
        <span class="wou-chr-foci-lbl"><i class="fa-solid fa-wand-sparkles"></i>${escapeText(t("WITCHER.Chrome.Character.Text.Foci", "Foci"))}</span>
        ${focusChips}
      </span>` : ""}
    </div>
    <div class="wou-chr-magic-pin-hint">
      <i class="fa-solid fa-thumbtack"></i>
      <span>${t("WITCHER.Chrome.Character.Text.PinSpellHint", "Pin a spell to add it to your bottom bar during combat. Leave nothing pinned to show every spell.")}</span>
    </div>
  `;
}

function renderSpellCard(sp, section) {
  const sys      = sp.system ?? {};
  const actor    = sp.parent;
  const pinned   = isSpellPinned(actor, sp.id);
  let meta, body, levelBadge = "";
  let accent = section.defaultAccent;

  if (sp.type === "hex") {
    /* Hexes carry the structured combat schema (numeric STA + cast actions,
     * enum defense/danger, {value,unit} duration) rather than the legacy
     * free-string spell fields, so read those instead. No element/damage axis
     * — the accent stays the section default (the chrome Hexes wine-rose). */
    const W        = CONFIG.WITCHER?.hex ?? {};
    const sta      = sys.staminaCost ?? "—";
    const castTime = sys.castingTime;
    const hexRange = String(sys.range ?? "").trim();
    const defLabel = sys.defense ? game.i18n.localize(W.defenses?.[sys.defense] ?? sys.defense) : "";
    const dngLabel = sys.danger  ? game.i18n.localize(W.danger?.[sys.danger]   ?? sys.danger)   : "";
    const unit     = sys.duration?.unit ?? "instant";
    const durVal   = Number(sys.duration?.value) || 0;
    const unitLbl  = game.i18n.localize(W.durationUnits?.[unit] ?? unit);
    const durLabel = (unit === "instant" || unit === "lifted" || !durVal) ? unitLbl : `${durVal} ${unitLbl}`;

    meta = [
      `<span><b>${t("WITCHER.Chrome.Character.Text.STA", "STA")}</b> ${escapeText(String(sta))}</span>`,
      (castTime || castTime === 0) ? `<span><b>${t("WITCHER.Chrome.Character.Text.Cast", "Cast")}</b> ${escapeText(String(castTime))}</span>` : "",
      hexRange ? `<span><b>${t("WITCHER.Chrome.Character.Text.Range", "Range")}</b> ${escapeText(hexRange)}</span>` : "",
      `<span><b>${t("WITCHER.Chrome.Character.Text.Dur", "Dur")}</b> ${escapeText(durLabel)}</span>`,
      defLabel ? `<span class="wou-chr-spell-def"><b>${t("WITCHER.Chrome.Character.Text.Def", "Def")}</b> ${escapeText(defLabel)}</span>` : "",
      dngLabel ? `<span><b>${t("WITCHER.Chrome.Character.Text.Danger", "Danger")}</b> ${escapeText(dngLabel)}</span>` : "",
    ].filter(Boolean).join("");

    body = stripHTML(sys.effect ?? "") || "—";
  } else if (sp.type === "ritual") {
    /* Rituals carry the structured schema: numeric STA, a Ritual Crafting
     * DC (flagged variableDC), {value,unit} prep time + duration, and a
     * tier/school graded by Ritual Crafting rank.  School drives the accent
     * (earth/air/fire/water/mixed) like a spell; there are no Witcher-sign
     * ritual overrides. */
    const W        = CONFIG.WITCHER?.ritual ?? {};
    const M        = CONFIG.WITCHER?.magic  ?? {};
    const sta      = sys.staminaCost ?? "—";
    const dc       = (sys.difficulty || sys.difficulty === 0) ? String(sys.difficulty) : "";
    const dcStr    = dc
      ? (sys.variableDC ? `${escapeText(dc)}<span class="wou-chr-spell-var" title="${t("WITCHER.Chrome.Character.Text.VariableDC", "Variable DC")}">×</span>` : escapeText(dc))
      : "";
    const prepUnit = sys.castingTime?.unit ?? "rounds";
    const prepVal  = Number(sys.castingTime?.value) || 0;
    const prepLbl  = `${prepVal} ${game.i18n.localize(W.timeUnits?.[prepUnit] ?? prepUnit)}`;
    const durUnit  = sys.duration?.unit ?? "instant";
    const durVal   = Number(sys.duration?.value) || 0;
    const durUnitL = game.i18n.localize(W.durationUnits?.[durUnit] ?? durUnit);
    const durLabel = (durUnit === "instant" || durUnit === "permanent" || !durVal) ? durUnitL : `${durVal} ${durUnitL}`;
    const ritRange = String(sys.range ?? "").trim();
    const tier     = String(sys.tier ?? "").trim().toLowerCase();
    const tierLbl  = SPELL_LEVEL_LABELS[tier];

    const schoolKey = String(sys.school ?? "").trim().toLowerCase();
    const schoolLbl = ELEMENT_LABELS[schoolKey];
    accent          = ELEMENT_ACCENTS[schoolKey] ?? section.defaultAccent;
    const schoolChip = schoolLbl
      ? `<span class="wou-chr-spell-elem"><b>${t("WITCHER.Chrome.Character.Text.School", "School")}</b> ${escapeText(schoolLbl)}</span>` : "";

    meta = [
      `<span><b>${t("WITCHER.Chrome.Character.Text.STA", "STA")}</b> ${escapeText(String(sta))}</span>`,
      dcStr    ? `<span><b>${t("WITCHER.Chrome.Character.Text.DC", "DC")}</b> ${dcStr}</span>` : "",
      `<span><b>${t("WITCHER.Chrome.Character.Text.Prep", "Prep")}</b> ${escapeText(prepLbl)}</span>`,
      ritRange ? `<span><b>${t("WITCHER.Chrome.Character.Text.Range", "Range")}</b> ${escapeText(ritRange)}</span>` : "",
      `<span><b>${t("WITCHER.Chrome.Character.Text.Dur", "Dur")}</b> ${escapeText(durLabel)}</span>`,
      schoolChip,
    ].filter(Boolean).join("");

    body = stripHTML(sys.effect ?? "") || "—";
    levelBadge = tierLbl ? `<span class="wou-chr-spell-lvl is-${tier}">${escapeText(tierLbl)}</span>` : "";
  } else {
    /* Spells / signs / invocations — the structured castable schema:
     * numeric STA (variableCost flag), cast actions, free-text range,
     * {value:string,unit} duration (string so dice formulas survive), a
     * multi-select defense array, a tier and a school (the accent axis). */
    const M        = CONFIG.WITCHER?.magic ?? {};
    const sta      = sys.staminaCost ?? "—";
    const costStr  = sys.variableCost
      ? `${escapeText(String(sta))}<span class="wou-chr-spell-var" title="${t("WITCHER.Chrome.Character.Text.VariableCost", "Variable cost")}">×</span>`
      : escapeText(String(sta));
    const castTime = sys.castingTime;
    const range    = String(sys.range ?? "").trim();
    const durUnit  = sys.duration?.unit ?? "instant";
    const durVal   = String(sys.duration?.value ?? "").trim();
    const hasDur   = durVal && durVal !== "0";
    const durUnitL = game.i18n.localize(M.durationUnits?.[durUnit] ?? durUnit);
    const durLabel = (durUnit === "instant" || durUnit === "permanent" || !hasDur) ? durUnitL : `${durVal} ${durUnitL}`;

    /* Defense is a multi-select array — RAW joins them with "or"
     * ("Dodge or Block"); an empty array means the spell auto-hits. */
    const defs     = Array.isArray(sys.defense) ? sys.defense : (sys.defense ? [sys.defense] : []);
    const defLabel = defs.length
      ? defs.map(d => game.i18n.localize(M.defenses?.[d] ?? d)).join(" or ")
      : t("WITCHER.Chrome.Character.Text.None", "None");

    const level    = String(sys.spellType ?? "").trim().toLowerCase();
    const levelLbl = SPELL_LEVEL_LABELS[level];

    /* School (earth/air/fire/water/mixed) is the primary tint axis.  Signs
     * override it: each canonical sign (Aard/Igni/Yrden/Quen/Axii) has its
     * own iconic colour keyed by name. */
    const schoolKey  = String(sys.school ?? "").trim().toLowerCase();
    const schoolLbl  = ELEMENT_LABELS[schoolKey];
    const isSign     = section.key === "sign";
    const signAccent = isSign ? SIGN_ACCENTS[String(sp.name ?? "").trim().toLowerCase()] : undefined;
    accent           = signAccent ?? ELEMENT_ACCENTS[schoolKey] ?? section.defaultAccent;

    const schoolChip = schoolLbl
      ? `<span class="wou-chr-spell-elem"><b>${t("WITCHER.Chrome.Character.Text.School", "School")}</b> ${escapeText(schoolLbl)}</span>` : "";

    meta = [
      `<span><b>STA</b> ${costStr}</span>`,
      (castTime || castTime === 0) ? `<span><b>${t("WITCHER.Chrome.Character.Text.Cast", "Cast")}</b> ${escapeText(String(castTime))}</span>` : "",
      range    ? `<span><b>${t("WITCHER.Chrome.Character.Text.Range", "Range")}</b> ${escapeText(range)}</span>` : "",
      `<span><b>${t("WITCHER.Chrome.Character.Text.Dur", "Dur")}</b> ${escapeText(durLabel)}</span>`,
      `<span class="wou-chr-spell-def"><b>${t("WITCHER.Chrome.Character.Text.Def", "Def")}</b> ${escapeText(defLabel)}</span>`,
      schoolChip,
    ].filter(Boolean).join("");

    body = stripHTML(sys.effect ?? "") || stripHTML(sys.description ?? "") || "—";
    levelBadge = levelLbl
      ? `<span class="wou-chr-spell-lvl is-${level}">${escapeText(levelLbl)}</span>`
      : "";
  }

  const pinTitle = pinned
    ? t("WITCHER.Chrome.Character.Tip.SpellPinned", "Pinned — appears in the bottom bar during combat. Click to unpin.")
    : t("WITCHER.Chrome.Character.Tip.SpellPin", "Pin to bottom-bar war mode");

  return `<div class="wou-chr-spell-card kind-${section.key}${pinned ? " is-pinned" : ""}"
               style="--spell-accent: ${accent};"
               data-spell-id="${escapeAttr(sp.id)}"
               data-action="cast-spell">
    <div class="wou-chr-spell-head">
      <button type="button" class="wou-chr-spell-pin${pinned ? " is-pinned" : ""}"
              data-action="toggle-spell-pin" data-spell-id="${escapeAttr(sp.id)}"
              title="${escapeAttr(pinTitle)}"
              aria-pressed="${pinned ? "true" : "false"}">
        <i class="fa-solid fa-thumbtack"></i>
      </button>
      <div class="wou-chr-spell-name">${escapeText(sp.name)}</div>
      ${levelBadge}
    </div>
    <div class="wou-chr-spell-meta">${meta}</div>
    <div class="wou-chr-spell-desc">${escapeText(body)}</div>
  </div>`;
}

/* ---- Pinned spells: persist on actor flag, read by dock's war-mode row ---
 * Storage: actor.flags["witcher-ttrpg-death-march"].pinnedSpells = string[] of
 * spell item ids.  The dock filters its combat-state spells row to this
 * list (falling back to all spells when nothing is pinned, so new
 * characters see something until they curate their list). */
const PIN_MODULE_ID = "witcher-ttrpg-death-march";
const PIN_FLAG_KEY  = "pinnedSpells";

function getPinnedSpellIds(actor) {
  const v = actor?.flags?.[PIN_MODULE_ID]?.[PIN_FLAG_KEY];
  return Array.isArray(v) ? v : [];
}
function isSpellPinned(actor, spellId) {
  return !!spellId && getPinnedSpellIds(actor).includes(spellId);
}
async function toggleSpellPin(actor, spellId) {
  if (!actor || !spellId) return;
  const current = new Set(getPinnedSpellIds(actor));
  if (current.has(spellId)) current.delete(spellId);
  else                       current.add(spellId);
  await actor.setFlag(PIN_MODULE_ID, PIN_FLAG_KEY, [...current]);
}

/* ---- Spell hover popover ------------------------------------------------
 * Singleton portal element appended to <body> so it escapes the panel's
 * overflow clipping.  Show on pointerenter of a spell card after a brief
 * dwell, hide on pointerleave (with a small grace window so passing the
 * cursor through neighboring cards doesn't flicker the popup). */

const SPELL_POPUP_ID = "wou-spell-hover-popup";
let _spellPopup     = null;
let _spellShowTimer = null;
let _spellHideTimer = null;

function ensureSpellPopup() {
  if (_spellPopup) return _spellPopup;
  let el = document.getElementById(SPELL_POPUP_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = SPELL_POPUP_ID;
    el.className = "wou-spell-popup";
    document.body.appendChild(el);
  }
  _spellPopup = el;
  return el;
}

function hideSpellPopup(delay = 120) {
  clearTimeout(_spellHideTimer);
  _spellHideTimer = setTimeout(() => {
    if (_spellPopup) _spellPopup.classList.remove("is-visible");
  }, delay);
}

function showSpellPopup(card, actor) {
  const spellId = card.dataset.spellId;
  if (!spellId || !actor) return;
  const sp = actor.items?.get?.(spellId);
  if (!sp) return;

  const sys = sp.system ?? {};
  const effect = String(sys.effect ?? "").trim();
  /* Hexes have no lore "description" — their second block is the RAW
   * "Requirements to Lift" field. Other castables use description for lore. */
  const isHex     = sp.type === "hex";
  const secondLbl = isHex ? t("WITCHER.Chrome.Character.Text.RequirementsToLift", "Requirements to Lift") : t("WITCHER.Chrome.Character.Text.Description", "Description");
  const second    = String((isHex ? sys.liftRequirement : sys.description) ?? "").trim();
  if (!effect && !second) return;

  const accent = card.style.getPropertyValue("--spell-accent") || "var(--wdm-amber)";
  const pop = ensureSpellPopup();
  pop.style.setProperty("--spell-accent", accent);

  /* Effect = mechanical text; second block = lore / lift requirements.  Show
   * both when present, effect first since mid-play that's what gets read. */
  const sections = [];
  if (effect) sections.push(`<div class="wou-spell-popup-sec"><div class="wou-spell-popup-sec-lbl">${t("WITCHER.Chrome.Character.Text.Effect", "Effect")}</div><div class="wou-spell-popup-sec-body">${effect}</div></div>`);
  if (second) sections.push(`<div class="wou-spell-popup-sec"><div class="wou-spell-popup-sec-lbl">${escapeText(secondLbl)}</div><div class="wou-spell-popup-sec-body">${second}</div></div>`);

  pop.innerHTML = `
    <div class="wou-spell-popup-title">${escapeText(sp.name)}</div>
    <div class="wou-spell-popup-body">${sections.join("")}</div>
  `;

  /* Reset position to measure size, then anchor to the right of the card
   * (or left/below if there's no room).  Viewport-clamped both axes. */
  pop.style.left = "0px";
  pop.style.top  = "0px";
  pop.classList.add("is-visible");

  const rect = card.getBoundingClientRect();
  const pw   = pop.offsetWidth;
  const ph   = pop.offsetHeight;
  const vw   = window.innerWidth;
  const vh   = window.innerHeight;
  const pad  = 8;

  let left = rect.right + pad;
  if (left + pw > vw - pad) left = rect.left - pw - pad;  // flip to the left
  if (left < pad)            left = pad;
  let top = rect.top;
  if (top + ph > vh - pad)   top = vh - ph - pad;
  if (top < pad)             top = pad;

  pop.style.left = `calc(${left}px / var(--wdm-size-character, var(--wdm-chrome-bars-scale, 1)))`;
  pop.style.top = `calc(${top}px / var(--wdm-size-character, var(--wdm-chrome-bars-scale, 1)))`;
}

function bindSpellHover(panel) {
  ensureSpellPopup();

  panel.addEventListener("pointerover", (ev) => {
    const card = ev.target.closest?.(".wou-chr-spell-card");
    if (!card || !panel.contains(card)) return;
    /* pointerover bubbles and re-fires for every child the cursor crosses
     * (.spell-name, .spell-meta, …).  Only (re)arm the dwell timer when the
     * pointer ENTERS the card from outside — moving between its own children
     * must not reset the timer, or it never completes and the card flickers. */
    if (card.contains(ev.relatedTarget)) return;
    clearTimeout(_spellHideTimer);
    clearTimeout(_spellShowTimer);
    _spellShowTimer = setTimeout(() => {
      const actor = getPanelActor("character");
      if (actor) showSpellPopup(card, actor);
    }, 350);             /* brief hover dwell before the full description popup */
  });

  panel.addEventListener("pointerout", (ev) => {
    const card = ev.target.closest?.(".wou-chr-spell-card");
    if (!card) return;
    /* Only hide when leaving the card entirely — moving between children
     * (.spell-name, .spell-meta, etc.) shouldn't dismiss. */
    if (card.contains(ev.relatedTarget)) return;
    clearTimeout(_spellShowTimer);
    hideSpellPopup();
  });

  /* Hide on panel-level scroll too — a stale popup pinned over moved
   * content reads as broken. */
  panel.addEventListener("scroll", () => {
    clearTimeout(_spellShowTimer);
    if (_spellPopup) _spellPopup.classList.remove("is-visible");
  }, { capture: true, passive: true });
}

/* ---- Active Effects column --------------------------------------------
 * Permanent display in char-top, right of armor.  Four stacked sections:
 *   - Active        — non-disabled, has a duration timer
 *   - Passives      — non-disabled, no duration (always-on effects)
 *   - Temp Improv.  — type === "temporaryItemImprovement" (Witcher system)
 *   - Inactive      — disabled
 * Each section uses the same compact row (icon + name + duration) and the
 * same 4-row-per-column wrap layout.  Sections with no entries collapse
 * automatically so the column doesn't show empty headers. */
function renderActiveEffectsColumn(actor) {
  const buckets = categorizeEffects(actor);
  /* Critical wounds moved to their own top-level "Wounds" tab — kept out
   * of the Active Effects column so a busy combat round (passives + temp
   * improvements + a fresh potion) doesn't bury the wound list. */

  const sections = [
    { key: "active",   label: t("WITCHER.Chrome.Character.Dialog.Button.ActiveEffects", "Active Effects"),    list: buckets.active   },
    { key: "passive",  label: t("WITCHER.Chrome.Character.Dialog.Button.Passives", "Passives"),          list: buckets.passive  },
    { key: "temp",     label: t("WITCHER.Chrome.Character.Dialog.Button.ItemImprovements", "Item Improvements"), list: buckets.temp     },
    { key: "inactive", label: t("WITCHER.Chrome.Character.Dialog.Button.Inactive", "Inactive"),          list: buckets.inactive },
  ];

  const renderedSections = sections.map(s => {
    if (!s.list.length) return "";
    const renderer = s.renderRow ?? renderEffectRow;
    const rows = s.list.map(renderer).join("");
    return `<div class="wou-chr-effects-section is-${s.key}">
      <div class="wou-chr-effects-head">${escapeText(s.label)}</div>
      <div class="wou-chr-effects-body">${rows}</div>
    </div>`;
  }).join("");

  if (!renderedSections) {
    return `
      <div class="wou-chr-effects">
        <div class="wou-chr-effects-head">${t("WITCHER.Chrome.Character.Text.Effects", "Effects")}</div>
        <div class="wou-chr-eff-empty">${t("WITCHER.Chrome.Character.Text.NoEffects", "No effects.")}</div>
      </div>
    `;
  }

  return `<div class="wou-chr-effects">${renderedSections}</div>`;
}

/* =========================================================================
   WOUNDS PANE — dedicated top-level tab listing critical wounds in full
   ========================================================================= */

const LEVEL_FALLBACKS = {
  simple:    "Simple",
  complex:   "Complex",
  difficult: "Difficult",
  deadly:    "Deadly",
};
const LEVEL_LABELS = new Proxy(LEVEL_FALLBACKS, {
  get(target, prop) {
    if (!(prop in target)) return undefined;
    return t(`WITCHER.Chrome.Character.WoundLevel.${String(prop)}`, target[prop]);
  }
});
const STATE_FALLBACKS = {
  unstabilized: "Unstabilized",
  stabilized:   "Stabilized",
  treated:      "Treated",
};
const STATE_LABELS = new Proxy(STATE_FALLBACKS, {
  get(target, prop) {
    if (!(prop in target)) return undefined;
    return t(`WITCHER.Chrome.Character.WoundState.${String(prop)}`, target[prop]);
  }
});

const WOUNDS_TIP = () =>
  '<div class="wcu-tip">' +
    `<strong>${t("WITCHER.Chrome.Character.Tip.CriticalWounds", "Critical Wounds")}</strong>` +
    t("WITCHER.Chrome.Character.Tip.CriticalWoundsBody", "A critical hit leaves a lasting wound on top of the damage. Each has a severity and a care state you advance on its card.") +
    `<div class="wcu-tip-row"><span>${t("WITCHER.Chrome.Character.Tip.Unstabilized", "Unstabilized")}</span><span>${t("WITCHER.Chrome.Character.Tip.UnstabilizedDesc", "Full penalty, can worsen")}</span></div>` +
    `<div class="wcu-tip-row"><span>${t("WITCHER.Chrome.Character.Tip.Stabilized", "Stabilized")}</span><span>${t("WITCHER.Chrome.Character.Tip.StabilizedDesc", "First Aid halts it")}</span></div>` +
    `<div class="wcu-tip-row"><span>${t("WITCHER.Chrome.Character.Tip.Treated", "Treated")}</span><span>${t("WITCHER.Chrome.Character.Tip.TreatedDesc", "Proper care starts healing")}</span></div>` +
    `<div class="wcu-tip-flavor">${t("WITCHER.Chrome.Character.Tip.WoundsFlavor", "Treated wounds heal over their listed time on their own; Deadly wounds need a Doctor. Severity runs Simple → Complex → Difficult → Deadly.")}</div>` +
  '</div>';

function woundsHeader() {
  return `<div class="wou-chr-wounds-head">
    <span class="wou-chr-wounds-head-title">${t("WITCHER.Chrome.Character.Text.CriticalWounds", "Critical Wounds")}</span>
    <span class="wdm-help-tip" data-tooltip="${escapeAttr(WOUNDS_TIP())}" data-tooltip-direction="DOWN" data-tooltip-class="wou-craft-tip"><i class="fa-solid fa-circle-info"></i></span>
  </div>`;
}

function renderWounds(actor) {
  const wounds = (actor.items?.contents ?? actor.items ?? [])
    .filter(i => i?.type === "criticalWound");

  if (!wounds.length) {
    return `
      ${woundsHeader()}
      <div class="wou-chr-wounds-empty">
        <i class="fa-solid fa-heart-circle-check"></i>
        <div>${t("WITCHER.Chrome.Character.Text.NoCriticalWounds", "No critical wounds.")}</div>
        <div class="wou-chr-wounds-empty-sub">${t("WITCHER.Chrome.Character.Text.TheCharacterIsWholeAndIntact", "The character is whole and intact.")}</div>
      </div>`;
  }

  /* Order: most severe first (deadly → difficult → complex → simple).
   *
   * Within a severity tier the order MUST be stable across re-renders and must
   * NOT depend on wound state. The morph reconciler (morphChildren) matches
   * cards by INDEX, so if a card changed position between renders the node
   * under the user's cursor would silently swap identity. A state-based
   * sub-sort did exactly that: advancing one wound (unstabilized→stabilized)
   * pushed a still-unstabilized sibling above it, sliding a different wound
   * under the cursor — so a second click, or a delete, hit the wrong wound.
   * (Only bit same-tier wounds; cross-tier never reorders.) Tie-break on the
   * stable item id instead so a wound keeps its slot when its state changes. */
  const levelOrder = { deadly: 0, difficult: 1, complex: 2, simple: 3 };
  const sorted = [...wounds].sort((a, b) => {
    const la = levelOrder[a.system?.criticalLevel] ?? 99;
    const lb = levelOrder[b.system?.criticalLevel] ?? 99;
    if (la !== lb) return la - lb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return `${woundsHeader()}<div class="wou-chr-wounds-scroll">${sorted.map(renderWoundCard).join("")}</div>`;
}

function renderWoundCard(item) {
  const sys         = item.system ?? {};
  const name        = String(item.name ?? t("WITCHER.Chrome.Character.Text.CriticalWoundFallback", "Critical Wound"));
  const level       = String(sys.criticalLevel ?? "simple");
  const state       = String(sys.state ?? "unstabilized");
  const location    = String(sys.location ?? "");
  const days        = Number(sys.healDaysElapsed) || 0;
  const time        = Number(sys.healingTime) || 0;
  const lesser      = !!sys.lesserEffect;
  const effect      = String(sys.activeEffect ?? sys.description ?? "").trim();
  const runsClock   = state === "treated" && time > 0 && level !== "deadly";

  /* Healing chip — only treated, non-deadly wounds run a clock. Shows days
   * already elapsed out of the max (the Critical Healing table value). */
  const healingChip = runsClock
    ? `<span class="wou-chr-wound-healing" title="${t("WITCHER.Chrome.Character.Text.DaysHealedRequiredDaysForTheWoundToClear", "Days healed / required days for the wound to clear")}">
         <i class="fa-solid fa-clock-rotate-left"></i>${days}/${time} d
       </span>`
    : "";

  /* GM-only manual nudge of the days-elapsed counter — flanks the chip with
   * − / N-of-max / +. "-" sets healing back a day (min 0); "+" advances it
   * (max = fully healed, then the autoheal sweep clears the wound). Mirrors
   * the Luck-pool stepper idiom. */
  const healAdjust = (game.user?.isGM && runsClock)
    ? `<span class="wou-chr-wound-healadj" role="group" aria-label="${t("WITCHER.Chrome.Character.Text.AdjustDaysElapsed", "Adjust days elapsed")}">
         <button class="wou-chr-luck-step" type="button" data-action="adjust-wound-heal-days" data-wound-id="${escapeAttr(item.id)}" data-delta="-1" title="${t("WITCHER.Chrome.Character.Text.SetHealingBackOneDay", "Set healing back one day")}">−</button>
         ${healingChip}
         <button class="wou-chr-luck-step" type="button" data-action="adjust-wound-heal-days" data-wound-id="${escapeAttr(item.id)}" data-delta="+1" title="${t("WITCHER.Chrome.Character.Text.AdvanceHealingOneDay", "Advance healing one day")}">+</button>
       </span>`
    : healingChip;

  const levelLabel = LEVEL_LABELS[level] ?? level;
  const stateLabel = STATE_LABELS[state] ?? state;
  const locLabel   = location ? location.charAt(0).toUpperCase() + location.slice(1) : "";

  const removeBtn = game.user?.isGM
    ? `<button type="button" class="wou-chr-wound-remove" data-action="remove-crit-wound"
               data-wound-id="${escapeAttr(item.id)}"
               title="${t("WITCHER.Chrome.Character.Text.RemoveCriticalWoundGMOnly", "Remove critical wound (GM only)")}" aria-label="${t("WITCHER.Chrome.Character.Text.RemoveCriticalWound", "Remove critical wound")}">
         <i class="fa-solid fa-xmark"></i>
       </button>`
    : "";

  /* State switcher — 3-way segmented control that advances ONE wound item
   * through its care chain (Unstabilized → Stabilized → Treated).  The same
   * item carries all three effect columns; advancing flips `system.state`
   * via the data model (stabilize() / treat()).  Treating anchors the
   * natural-healing clock; the autoheal policy then clears the wound once
   * the clock runs out.  Only the immediate-next state is clickable;
   * skipping or back-stepping is disabled. */
  const NEXT = { unstabilized: "stabilized", stabilized: "treated" };
  const nextState = NEXT[state] ?? null;
  const stateSwitch = `
    <span class="wou-chr-wound-switch" role="group" aria-label="${t("WITCHER.Chrome.Character.Text.WoundState", "Wound state")}">
      ${["unstabilized","stabilized","treated"].map(s => {
        const isActive   = state === s;
        const isNext     = s === nextState;
        const clickable  = isNext && !isActive;
        const cls        = `wou-chr-wound-switch-btn is-${s}${isActive ? " is-active" : ""}${clickable ? " is-next" : ""}${!isActive && !clickable ? " is-disabled" : ""}`;
        const dataAttrs  = clickable
          ? `data-action="advance-wound-treatment" data-wound-id="${escapeAttr(item.id)}"`
          : "";
        const title = isActive
          ? `Current state: ${STATE_LABELS[s] ?? s}`
          : (clickable
              ? `Advance to ${STATE_LABELS[s] ?? s}`
              : "Skipping or back-stepping isn't supported — advance one step at a time.");
        return `<button type="button" class="${cls}" ${dataAttrs}${clickable ? "" : " disabled"} title="${escapeAttr(title)}">
          ${escapeText(STATE_LABELS[s] ?? s)}
        </button>`;
      }).join("")}
    </span>`;

  /* activeEffect is the HTML for the current state's column (derived on the
   * data model) — render the user-authored markup directly. */
  const descBlock = effect
    ? `<div class="wou-chr-wound-desc">${effect}</div>`
    : `<div class="wou-chr-wound-desc is-empty"><em>${t("WITCHER.Chrome.Character.Text.NoEffectDescriptionRecordedForThisState", "No effect description recorded for this state.")}</em></div>`;

  /* Three stacked zones rather than one overloaded header row:
   *   1. identity  — icon + name + severity/location tags + remove
   *   2. status    — full-width state switcher and the healing clock
   *   3. effect    — a state-labelled block of the active effect text
   * so the actionable control (the switcher) gets its own line and the
   * effect reads as a captioned section instead of loose body text. */
  return `<article class="wou-chr-wound-card is-level-${escapeAttr(level)} is-state-${escapeAttr(state)}"
                  data-wound-id="${escapeAttr(item.id)}">
    <header class="wou-chr-wound-head">
      <span class="wou-chr-wound-icon"><i class="fa-solid fa-heart-crack"></i></span>
      <span class="wou-chr-wound-name">${escapeText(name)}</span>
      <span class="wou-chr-wound-tags">
        <span class="wou-chr-wound-tag is-level">${escapeText(levelLabel)}</span>
        ${locLabel ? `<span class="wou-chr-wound-tag is-loc">${escapeText(locLabel)}</span>` : ""}
        ${lesser   ? `<span class="wou-chr-wound-tag is-lesser" title="${t("WITCHER.Chrome.Character.Text.LesserEffectVariantHalvedPenalties", "Lesser-effect variant — halved penalties")}">${t("WITCHER.Chrome.Character.Text.Lesser", "Lesser")}</span>` : ""}
      </span>
      ${removeBtn}
    </header>
    <div class="wou-chr-wound-status">
      ${stateSwitch}
      ${healAdjust}
    </div>
    <div class="wou-chr-wound-effect">
      <div class="wou-chr-wound-effect-label">Effect — ${escapeText(stateLabel)}</div>
      ${descBlock}
    </div>
  </article>`;
}

/* Critical wounds are embedded items of type `criticalWound` (see
 * criticalWoundData.js).  Name = item.name; treatment state drives the
 * icon tint; healing counter (daysHealed/healingTime) shows as the
 * duration chip. */
function renderCritWoundRow(item) {
  if (!item || item.type !== "criticalWound") return "";
  const name = String(item.name ?? t("WITCHER.Chrome.Character.Text.CriticalWoundFallback", "Critical Wound"));
  const sys  = item.system ?? {};
  const state = String(sys.state ?? "unstabilized");
  const stateLabel = STATE_LABELS[state] ?? state;
  const level = String(sys.criticalLevel ?? "");
  const days  = Number(sys.healDaysElapsed) || 0;
  const time  = Number(sys.healingTime) || 0;
  /* Only treated, non-deadly wounds run a clock — show it then; otherwise
   * the state label reads at a glance. */
  const healing = (state === "treated" && time > 0 && level !== "deadly") ? `${days}/${time} d` : "";
  const tip = [name, level, stateLabel, healing].filter(Boolean).join(" · ");
  const removeBtn = game.user?.isGM
    ? `<button type="button" class="wou-chr-eff-remove" data-action="remove-crit-wound"
               data-wound-id="${escapeAttr(item.id)}"
               title="${t("WITCHER.Chrome.Character.Text.RemoveCriticalWoundGMOnly", "Remove critical wound (GM only)")}" aria-label="${t("WITCHER.Chrome.Character.Text.RemoveCriticalWound", "Remove critical wound")}">
         <i class="fa-solid fa-xmark"></i>
       </button>`
    : "";
  return `<div class="wou-chr-eff-row is-critwound is-state-${escapeAttr(state)} is-level-${escapeAttr(level)}"
              data-wound-id="${escapeAttr(item.id)}"
              title="${escapeAttr(tip)}">
    <span class="wou-chr-eff-icon wou-chr-eff-icon-fa"><i class="fa-solid fa-heart-crack"></i></span>
    <span class="wou-chr-eff-name">${escapeText(name)}</span>
    ${healing ? `<span class="wou-chr-eff-dur">${escapeText(healing)}</span>` : ""}
    ${removeBtn}
  </div>`;
}

function renderEffectRow(eff) {
  const dur = describeEffectDuration(eff.duration);
  const img = eff.img || eff.icon || "icons/svg/aura.svg";
  const name = String(eff.name ?? t("WITCHER.Chrome.Character.Text.EffectFallback", "Effect"));
  /* Disabled (Inactive section) effects get a per-row activate button that
   * flips THIS effect's `disabled` to false — no longer a bulk action. */
  const activateBtn = eff.disabled
    ? `<button type="button" class="wou-chr-eff-activate" data-action="activate-effect" title="${t("WITCHER.Chrome.Character.Text.Activate", "Activate")}">
         <i class="fa-solid fa-bolt"></i>
       </button>`
    : "";
  /* Manual pause — freezes the AE's remaining time until clicked again.
   * Only meaningful for time-based durations, so skip when the effect has
   * no seconds/minutes/hours/days timer. Any user can toggle their own
   * effects' pause state (GM can toggle anyone's). */
  const canPause = !eff.disabled && dur && !/[rt]$/.test(dur);   // seconds-based label ends with s/m/h/d
  const isPaused = eff.getFlag?.("witcher-ttrpg-death-march", "pausedRemainingSecs") != null;
  const pauseBtn = canPause
    ? `<button type="button" class="wou-chr-eff-pause${isPaused ? " is-paused" : ""}" data-action="pause-effect"
               title="${escapeAttr(isPaused ? t("WITCHER.Chrome.Character.Tip.ResumeEffectLong", "Resume — restart the clock from the frozen remaining") : t("WITCHER.Chrome.Character.Tip.PauseEffectLong", "Pause — freeze the remaining duration"))}"
               aria-label="${escapeAttr(isPaused ? t("WITCHER.Chrome.Character.Aria.ResumeEffect", "Resume effect") : t("WITCHER.Chrome.Character.Aria.PauseEffect", "Pause effect"))}">
         <i class="fa-solid ${isPaused ? "fa-play" : "fa-pause"}"></i>
       </button>`
    : "";
  /* GM-only remove cross — deletes the effect from whatever parent owns
   * it (the actor for actor-level AEs, or the item that carries it for
   * transferred item effects).  We attach the parent UUID to the row
   * so the click handler doesn't need to walk the actor's items to find
   * which item the AE belongs to. */
  const parentUuid = eff.parent?.uuid ?? "";
  const removeBtn = game.user?.isGM
    ? `<button type="button" class="wou-chr-eff-remove" data-action="remove-effect"
               title="${t("WITCHER.Chrome.Character.Text.RemoveEffectGMOnly", "Remove effect (GM only)")}" aria-label="${t("WITCHER.Chrome.Character.Text.RemoveEffect", "Remove effect")}">
         <i class="fa-solid fa-xmark"></i>
       </button>`
    : "";
  return `<div class="wou-chr-eff-row${isPaused ? " is-paused" : ""}" data-effect-id="${escapeAttr(eff.id)}" data-parent-uuid="${escapeAttr(parentUuid)}" title="${escapeAttr(name)}">
    <img class="wou-chr-eff-icon" src="${escapeAttr(img)}" alt="" />
    <span class="wou-chr-eff-name">${escapeText(name)}</span>
    ${dur ? `<span class="wou-chr-eff-dur">${escapeText(dur)}</span>` : ""}
    ${activateBtn}
    ${pauseBtn}
    ${removeBtn}
  </div>`;
}

function categorizeEffects(actor) {
  const all = (actor.effects?.contents ?? []).filter(e => !e.isSuppressed);
  const out = { active: [], passive: [], inactive: [], temp: [] };
  for (const e of all) {
    if (e.type === "temporaryItemImprovement") { out.temp.push(e); continue; }
    if (e.disabled)                            { out.inactive.push(e); continue; }
    const d = e.duration ?? {};
    const hasTimer = (Number(d.seconds) > 0) || (Number(d.rounds) > 0) || (Number(d.turns) > 0);
    (hasTimer ? out.active : out.passive).push(e);
  }
  return out;
}

/* Returns a short duration label for an ActiveEffect's duration object.
 * Matches the dock's status-badge logic so the two displays don't drift:
 *   - seconds-based:   "12s", "3m", "1:45h"  (counts down with world time)
 *     …but IN COMBAT, converts to whole rounds ("N r") using
 *     CONFIG.time.roundTime — matches dock-statuses' rendering AND
 *     covers the "cast a rounds spell, AE is now stored in seconds"
 *     path we take in castSpellMixin.durationToEffect to sidestep
 *     Foundry v14's combat-based-duration off-by-one bug.
 *   - round/turn-based: "3 rds"
 *   - no duration:     "" (caller hides the chip)
 */
function describeEffectDuration(dur) {
  if (!dur) return "";
  // Combat-pacing units ride the tracker, not the wall clock: "20 r" / "20 t".
  if (dur.units === "rounds" || dur.units === "turns") {
    const total = Number(dur.value) || 0;
    if (total <= 0) return "";
    const r = Number(dur.remaining);
    const remaining = Number.isFinite(r) ? Math.max(0, Math.ceil(r)) : total;
    return `${remaining} ${dur.units === "rounds" ? "r" : "t"}`;
  }
  const totalSecs = Number(dur.seconds);
  if (Number.isFinite(totalSecs) && totalSecs > 0) {
    // v14 computes secondsRemaining from start.time + value/units.
    const rem = Number(dur.secondsRemaining);
    const remaining = Number.isFinite(rem) ? Math.max(0, rem) : totalSecs;
    const roundSecs = Number(CONFIG?.time?.roundTime) || 0;
    if (game.combat?.started && roundSecs > 0) {
      const remR = Math.max(0, Math.ceil(remaining / roundSecs));
      return remR > 0 ? `${remR} r` : "";
    }
    return formatSecondsLabel(remaining);
  }
  return "";
}


/* =========================================================================
   BIOGRAPHY
   ========================================================================= */

/* Biography pane — all data read from the actor's existing system fields:
 *   actor.name, actor.img
 *   profession / race / homeland items     (items)
 *   system.gender, system.general.age, general.socialStanding, general.reputation
 *   system.general.personality, system.general.feelingsOnPeople   (free text)
 *   system.general.homeland
 *   system.general.lifeEvents (per decade, capped by system.lifeEventCounter)
 *   system.general.background              (HTML backstory, editable)
 *   Race item's effects → "perks" on the Race & School card.
 *
 * The backstory editor is the only thing that writes; everything else is a
 * read-only view of the system data.  Editing lives in the system sheet. */
function renderBiography(actor) {
  const sys     = actor.system ?? {};
  const general = sys.general ?? {};

  return `
    <div class="wou-chr-bio-scroll">
      ${renderBioIdentity(actor, general)}
      ${renderBioRaceCard(actor)}
      ${renderBioPerks(actor)}
      ${renderBioDetails(actor, general)}
      ${renderBioLifeEvents(actor, general, Number(sys.lifeEventCounter) || 20)}
      ${renderBioBackstory(general)}
    </div>
  `;
}

/* Identity — portrait + name + tag chips drawn from items and system fields. */
function renderBioIdentity(actor, general) {
  const race = actor.items.find(i => i.type === "race");
  const prof = actor.items.find(i => i.type === "profession");
  const home = actor.items.find(i => i.type === "homeland");
  const age  = Number(general.age) || 0;
  const tags = [
    prof?.name,
    race?.name,
    actor.system?.gender,
    age > 0 ? tFormat("WITCHER.Chrome.Character.Text.AgeYrs", { age }, `${age} yrs`) : null,
    home?.name?.trim() || homelandLabel(general.homeland),
  ].filter(Boolean).map(t => `<span class="wou-chr-bio-tag">${escapeText(t)}</span>`).join("");

  return `
    <section class="wou-chr-bio-id">
      ${renderBioPortrait(actor)}
      <div>
        <div class="wou-chr-bio-name">${escapeText(actor.name)}</div>
        <div class="wou-chr-bio-tags">${tags}</div>
      </div>
    </section>
  `;
}

/* general.homeland is a free-text string in the schema; the homeland item
 * (when present) is preferred by callers. */
function homelandLabel(homeland) {
  const v = String(homeland ?? "").trim();
  return v || null;
}

function renderBioPortrait(actor) {
  const img = actor.img && !actor.img.includes("mystery-man") ? actor.img : null;
  return `<div class="wou-chr-bio-portrait">${img ? `<img src="${escapeAttr(img)}" alt="" />` : `<i class="fa-solid fa-user-shield"></i>`}</div>`;
}

/* Race & Profession — two SEPARATE cards under one divider. Race shows the
 * race item's name + its four readable "quality" sections; Profession shows
 * the profession item's name, art and defining skill. */
function renderBioRaceCard(actor) {
  const race = actor.items.find(i => i.type === "race");
  const prof = actor.items.find(i => i.type === "profession");
  if (!race && !prof) return "";

  return `
    <div class="wou-chr-bio-divider">${t("WITCHER.Chrome.Character.Text.RaceProfession", "Race &amp; Profession")}</div>
    ${race ? renderBioRaceBlock(race) : ""}
    ${prof ? renderBioProfessionBlock(prof) : ""}
  `;
}

/* Race block — the race's name plus its four "quality" sections
 * (system.qualities.box1..box4: a title + an HTML description each). These
 * are the human-readable racial passives, now readable straight from the
 * Biography tab. Falls back to the race item's description when no boxes
 * are filled. */
function renderBioRaceBlock(race) {
  const sections = collectRaceSections(race);
  const body = sections.length
    ? sections.map(s => `
        ${s.name ? `<div class="wou-chr-race-section-name">${escapeText(s.name)}</div>` : ""}
        ${s.description ? `<div class="wou-chr-race-section-desc">${s.description}</div>` : ""}
      `).join("")
    : (race.system?.description
        ? `<div class="wou-chr-race-section-desc">${race.system.description}</div>`
        : `<div class="wou-chr-race-perk">${t("WITCHER.Chrome.Character.Text.NoRacialSectionsRecorded", "No racial sections recorded.")}</div>`);

  /* Prefer the race item's own image when it has one (the Witcher core
   * book ships racy artwork that's better than a generic dragon glyph).
   * Falls back to the dragon icon for races without custom imagery. */
  const emblemHtml = isCustomImg(race.img)
    ? `<img class="wou-chr-race-emblem-img" src="${escapeAttr(race.img)}" alt="" />`
    : `<i class="fa-solid fa-dragon"></i>`;

  return `
    <div class="wou-chr-race-card">
      <div class="wou-chr-race-emblem">${emblemHtml}</div>
      <div>
        <div class="wou-chr-race-name">${escapeText(race.name || "—")}</div>
        <div class="wou-chr-race-perks">${body}</div>
      </div>
    </div>
  `;
}

/* Profession block — name, art (medallion icon → item img → shield glyph),
 * the defining skill and the profession's own description. */
function renderBioProfessionBlock(prof) {
  const sys = prof.system ?? {};
  const desc = sys.description
    ? `<div class="wou-chr-race-section-desc">${sys.description}</div>` : "";
  const defining = sys.definingSkill?.skillName
    ? `<div class="wou-chr-race-section-name">${t("WITCHER.Chrome.Character.Text.DefiningSkill", "Defining Skill")}</div>
       <div class="wou-chr-race-section-desc">${escapeText(sys.definingSkill.skillName)}</div>` : "";
  const body = (desc + defining) || `<div class="wou-chr-race-perk">${t("WITCHER.Chrome.Character.Text.NoProfessionDetailsRecorded", "No profession details recorded.")}</div>`;

  const art = isCustomImg(sys.medallionIcon) ? sys.medallionIcon
            : isCustomImg(prof.img)          ? prof.img
            : null;
  const emblemHtml = art
    ? `<img class="wou-chr-race-emblem-img" src="${escapeAttr(art)}" alt="" />`
    : `<i class="fa-solid fa-shield-halved"></i>`;

  return `
    <div class="wou-chr-race-card">
      <div class="wou-chr-race-emblem">${emblemHtml}</div>
      <div>
        <div class="wou-chr-race-name">${escapeText(prof.name || "—")}</div>
        <div class="wou-chr-race-perks">${body}</div>
      </div>
    </div>
  `;
}

/* Perks — the actor's perk items (icon + name + description), shown as cards
 * under the Race & Profession block. Read-only here; edit via the item sheet. */
function renderBioPerks(actor) {
  const perks = actor.items.filter(i => i.type === "perk");
  if (!perks.length) return "";

  const cards = perks.map(p => {
    const emblem = isCustomImg(p.img)
      ? `<img class="wou-chr-race-emblem-img" src="${escapeAttr(p.img)}" alt="" />`
      : `<i class="fa-solid fa-star"></i>`;
    const desc = p.system?.description
      ? `<div class="wou-chr-race-section-desc">${p.system.description}</div>`
      : `<div class="wou-chr-race-perk">${t("WITCHER.Chrome.Character.Text.NoDescriptionRecorded", "No description recorded.")}</div>`;
    return `
      <div class="wou-chr-race-card">
        <div class="wou-chr-race-emblem">${emblem}</div>
        <div>
          <div class="wou-chr-race-name">${escapeText(p.name || "—")}</div>
          <div class="wou-chr-race-perks">${desc}</div>
        </div>
      </div>`;
  }).join("");

  return `
    <div class="wou-chr-bio-divider">${t("WITCHER.Chrome.Character.Text.Perks", "Perks")}</div>
    ${cards}
  `;
}

/* True if the image path looks like real custom artwork rather than one of
 * Foundry's default placeholders.  We avoid showing the generic mystery-man
 * silhouette because the dragon icon reads better than a default thumbnail. */
function isCustomImg(img) {
  if (!img) return false;
  const s = String(img).toLowerCase();
  if (!s.trim()) return false;
  if (s.includes("mystery-man")) return false;
  if (s.endsWith("/icons/svg/item-bag.svg")) return false;
  if (s.endsWith("/icons/svg/aura.svg")) return false;
  return true;
}

/* Read the race's four quality boxes (system.qualities.box1..box4), each a
 * {name, description}. Empty boxes are skipped so only authored sections show. */
function collectRaceSections(raceItem) {
  const q = raceItem?.system?.qualities ?? {};
  return ["box1", "box2", "box3", "box4"]
    .map(k => q[k])
    .filter(Boolean)
    .map(box => ({
      name: String(box.name ?? "").trim(),
      description: String(box.description ?? "").trim(),
    }))
    .filter(e => e.name || e.description);
}

/* Family & Home — every general field surfaced as an inline-editable row.
 * Top group is the structured vitals (gender / age / homeland / reputation
 * / social standing); bottom group is the seven free-text details fields
 * the system stores as valueLabel pairs.  Every input commits on blur
 * (or change, for selects) via the edit-bio-field action.  All rows
 * always render — these are common things to fill in, so the section
 * shows up even on a brand-new character. */
function renderBioDetails(actor, general) {
  const homelandItem = actor.items.find(i => i.type === "homeland");

  const rows = [
    bioTextRow (t("WITCHER.Chrome.Character.Text.Gender",           "Gender"),             "system.gender",                       String(actor.system?.gender ?? "")),
    bioNumberRow(t("WITCHER.Chrome.Character.Text.Age",             "Age"),                "system.general.age",                  Number(general.age) || 0),
    bioHomelandRow(homelandItem, general),
    bioTextRow (t("WITCHER.Chrome.Character.Text.SocialStanding",   "Social standing"),    "system.general.socialStanding",       String(general.socialStanding ?? "")),
    bioTextRow (t("WITCHER.Chrome.Character.Text.Reputation",       "Reputation"),         "system.general.reputation.value",     String(general.reputation?.value ?? "")),
    bioTextRow (t("WITCHER.Chrome.Character.Text.Personality",      "Personality"),        "system.general.personality",          String(general.personality ?? "")),
    bioTextRow (t("WITCHER.Chrome.Character.Text.FeelingsOnPeople", "Feelings on people"), "system.general.feelingsOnPeople",     String(general.feelingsOnPeople ?? "")),
  ];

  return `
    <div class="wou-chr-bio-divider">${t("WITCHER.Chrome.Character.Text.IdentityAmpStanding", "Identity &amp; Standing")}</div>
    <div class="wou-chr-bg-rows">${rows.join("")}</div>
  `;
}

/* Row builders.  Each returns a complete .wou-chr-bg-row with an editable
 * input/select on the right.  Keep them small + similar so the rendering
 * data table above reads cleanly. */
function bioTextRow(label, path, value) {
  return `
    <div class="wou-chr-bg-row">
      <div class="wou-chr-bg-key">${escapeText(label)}</div>
      <div class="wou-chr-bg-val">
        <input type="text" class="wou-chr-bg-val-input"
               value="${escapeAttr(value)}"
               placeholder="—"
               data-action="edit-bio-field" data-bio-path="${escapeAttr(path)}" data-bio-type="text"
               aria-label="${escapeAttr(label)}" />
      </div>
    </div>
  `;
}

function bioNumberRow(label, path, value) {
  const v = Number(value) || 0;
  return `
    <div class="wou-chr-bg-row">
      <div class="wou-chr-bg-key">${escapeText(label)}</div>
      <div class="wou-chr-bg-val">
        <input type="number" min="0" step="1" class="wou-chr-bg-val-input wou-chr-bg-val-num"
               value="${v}"
               data-action="edit-bio-field" data-bio-path="${escapeAttr(path)}" data-bio-type="number"
               aria-label="${escapeAttr(label)}" />
      </div>
    </div>
  `;
}

/* Homeland — a dropped homeland item (e.g. "Cidaris") drives the origin and
 * renders as a link to its sheet; otherwise the schema's free-text string is
 * editable inline. */
function bioHomelandRow(homelandItem, general) {
  if (homelandItem) {
    return `
    <div class="wou-chr-bg-row">
      <div class="wou-chr-bg-key">${t("WITCHER.Chrome.Character.Text.Homeland", "Homeland")}</div>
      <div class="wou-chr-bg-val">
        <a class="wou-chr-bg-link" data-action="open-item" data-item-id="${escapeAttr(homelandItem.id)}"
           title="${t("WITCHER.Chrome.Character.Text.LinkedToHomelandItemOpenToEdit", "Linked to homeland item — open to edit")}">
          <i class="fa-solid fa-link"></i>${escapeText(homelandItem.name)}
        </a>
      </div>
    </div>
  `;
  }
  return bioTextRow(t("WITCHER.Chrome.Character.Text.Homeland", "Homeland"), "system.general.homeland", String(general.homeland ?? ""));
}

function localizeIfKey(value, map) {
  const v = String(value ?? "").trim();
  if (!v) return "";
  const label = map?.[v];
  if (label && typeof label === "string" && label.startsWith("WITCHER.")) {
    return game.i18n.localize(label);
  }
  return label || v;
}

/* Defining moments — system.general.lifeEvents keyed by decade ("10".."200"),
 * each with a `value` (title) and `details` (body) string in the schema.
 * Capped by system.lifeEventCounter (default 20 = full 20-decade lifepath).
 *
 * The system sheet exposes these on its Background tab; we mirror that here
 * with inline editors so the player can fill in their lifepath without
 * leaving the overlay.  An optional free-text DATE field lives on a module
 * flag (the schema has no date slot — only the decade timestamp), letting
 * the player pin events to a specific year, season, or place description. */
function renderBioLifeEvents(actor, general, counter) {
  const events = general.lifeEvents ?? {};
  const cap    = Math.max(1, Math.min(20, counter || 20));

  /* Resolve every schema slot.  Slots with no content stay hidden unless
   * the user just added them via the +Add button (tracked in
   * editingLifeEvents).  Date + location live on module flags since the
   * Witcher system's lifeEvent schema has neither. */
  const allSlots = Object.entries(events).map(([key, ev]) => {
    const decade = Number(ev?.decade) || Math.round(Number(key) / 10);
    return {
      key,
      decade,
      value:    String(ev?.value ?? "").trim(),
      details:  String(ev?.details ?? "").trim(),
      date:     String(actor.getFlag?.(MODULE_ID, `lifeEventDates.${key}`) ?? "").trim(),
      location: String(actor.getFlag?.(MODULE_ID, `lifeEventLocations.${key}`) ?? "").trim(),
    };
  });

  /* Saved drag-order from a module flag.  When the user has reordered events
   * via the bio tab, that order takes precedence over decade-based sorting.
   * Stale keys (events the user cleared) are ignored.  Visible events not
   * present in the saved order fall through in decade order at the end. */
  const savedOrder = Array.isArray(actor.getFlag?.(MODULE_ID, "lifeEventOrder"))
    ? actor.getFlag(MODULE_ID, "lifeEventOrder")
    : [];

  /* Events are free-form (no fixed decade slots): any entry with content —
   * or one the user just added and is editing — shows.  Keys may be numeric
   * (legacy decade keys) or `evt-<id>` (minted here or by the actor sheet);
   * the filter is content-based so both round-trip. */
  const visibleUnsorted = allSlots
    .filter(s => s.value || s.details || s.date || s.location || editingLifeEvents.has(s.key));

  const visible = sortLifeEventsByOrder(visibleUnsorted, savedOrder).slice(0, cap);

  const itemsHtml = visible.map(renderLifeEventEditor).join("");

  /* The add button mints a fresh key on demand (addLifeEventSlot), so it
   * shows whenever the timeline is under the cap. */
  const addBtn = visibleUnsorted.length < cap
    ? `<button type="button" class="wou-chr-bg-add-event" data-action="add-life-event">
         <i class="fa-solid fa-plus"></i> ${t("WITCHER.Chrome.Character.Text.AddEvent", "Add event")}
       </button>`
    : "";

  const body = itemsHtml
    ? `<div class="wou-chr-bg-timeline">${itemsHtml}</div>`
    : `<div class="wou-chr-bg-empty">${t("WITCHER.Chrome.Character.Text.NoLifeEventsRecordedYet", "No life events recorded yet.")}</div>`;

  const totalShown = visible.length;
  const countChip  = totalShown > 0 ? `<span class="wou-chr-bio-divider-count">${totalShown}</span>` : "";

  /* Header is a button so the whole strip is the collapse hitbox.  When
   * collapsed, body + add button are hidden but the section header (and
   * count) remain visible so the user can re-expand. */
  const headerHtml = `
    <button type="button" class="wou-chr-bio-divider wou-chr-bio-divider-btn${lifeEventsCollapsed ? " is-collapsed" : ""}"
            data-action="toggle-life-events"
            aria-expanded="${lifeEventsCollapsed ? "false" : "true"}">
      <i class="fa-solid fa-chevron-down wou-chr-bio-divider-chev"></i>
      <span>${t("WITCHER.Chrome.Character.Text.DefiningMoments", "Defining moments")}</span>
      ${countChip}
    </button>
  `;

  if (lifeEventsCollapsed) return headerHtml;

  return `
    ${headerHtml}
    ${body}
    ${addBtn}
  `;
}

/* Single inline-editable event card: title input + date/meta line + details
 * textarea.  All three commit on blur via the same edit-life-event-field
 * handler.  Title and details write to actor.system.general.lifeEvents.{key},
 * date writes to a module flag (schema has no date field). */
function renderLifeEventEditor(e) {
  /* The marker is a real DOM element (not a ::before pseudo) so it can
   * carry `draggable="true"`.  Drag fires from the marker only — the rest
   * of the card stays click-through for normal text-input behaviour.
   * The card itself is the drop target. */
  return `
    <div class="wou-chr-bg-event is-editable" data-life-key="${escapeAttr(e.key)}">
      <span class="wou-chr-bg-event-marker" draggable="true"
            title="${t("WITCHER.Chrome.Character.Text.DragToReorder", "Drag to reorder")}" aria-label="${t("WITCHER.Chrome.Character.Text.DragToReorderThisEvent", "Drag to reorder this event")}"></span>
      <input type="text" class="wou-chr-bg-event-title-input"
             placeholder="${t("WITCHER.Chrome.Character.Text.EventTitle", "Event title")}"
             value="${escapeAttr(e.value)}"
             data-action="edit-life-event-field"
             data-field="value"
             data-life-key="${escapeAttr(e.key)}"
             aria-label="${t("WITCHER.Chrome.Character.Text.EventTitle", "Event title")}" />
      <div class="wou-chr-bg-event-meta-row">
        <input type="date" class="wou-chr-bg-event-date-input"
               value="${escapeAttr(isIsoDate(e.date) ? e.date : "")}"
               data-action="edit-life-event-field"
               data-field="date"
               data-life-key="${escapeAttr(e.key)}"
               aria-label="${t("WITCHER.Chrome.Character.Text.EventDate", "Event date")}" />
        <input type="text" class="wou-chr-bg-event-location-input"
               placeholder="${t("WITCHER.Chrome.Character.Text.Location", "Location")}"
               value="${escapeAttr(e.location ?? "")}"
               data-action="edit-life-event-field"
               data-field="location"
               data-life-key="${escapeAttr(e.key)}"
               aria-label="${t("WITCHER.Chrome.Character.Text.EventLocation", "Event location")}" />
      </div>
      <textarea class="wou-chr-bg-event-body-input" rows="2"
                placeholder="${t("WITCHER.Chrome.Character.Text.WhatHappened", "What happened…")}"
                data-action="edit-life-event-field"
                data-field="details"
                data-life-key="${escapeAttr(e.key)}"
                aria-label="${t("WITCHER.Chrome.Character.Text.EventDetails", "Event details")}">${escapeText(e.details)}</textarea>
    </div>
  `;
}

/* Backstory — system.general.background (HTML).  Editable inline; the
 * commit goes back to the system field, not a module flag. */
function renderBioBackstory(general) {
  const html = String(general.background ?? "").trim();
  return `
    <div class="wou-chr-bio-divider">${t("WITCHER.Chrome.Character.Text.Backstory", "Backstory")}</div>
    <div class="wou-chr-bio-editor" contenteditable="true" data-action="edit-bio">${html || `<p>${t("WITCHER.Chrome.Character.Text.BackstoryPlaceholder", "Click here to start writing your character's backstory.")}</p>`}</div>
  `;
}

/* =========================================================================
   EVENT WIRING
   ========================================================================= */

/* Per-element listeners are attached at most once per live node.  Because
 * render() now morphs the DOM in place (reusing nodes across renders), a
 * blanket re-wire would stack duplicate blur/input handlers on surviving
 * nodes — so we track wired nodes in a WeakSet and skip them on subsequent
 * passes.  The set auto-prunes as morph discards replaced nodes (GC).  Fresh
 * nodes inserted by a morph are the only ones wireOnce actually wires. */
const _wired = new WeakSet();
function wireOnce(selector, fn) {
  panelEl.querySelectorAll(selector).forEach(el => {
    if (_wired.has(el)) return;
    _wired.add(el);
    fn(el);
  });
}

function wireListeners(actor) {
  /* Click/contextmenu delegation is set up ONCE in injectCharacterPanel on the
   * persistent panelEl — not here.  This wires per-element listeners
   * (blur/input/wheel/drag) idempotently via wireOnce. */

  /* Every handler resolves the actor LIVE via getPanelActor("character") at event
     time, mirroring the click delegate (line ~100). `wireOnce` guards each
     input with a WeakSet so we only wire it once ever, and `morphChildren`
     preserves the same input node across renders — capturing the `actor`
     param in the closure would freeze commits against the FIRST actor the
     node ever saw, and any View-As swap / controlled-token change would
     silently route writes to the wrong character (that was the observed
     "typed tox goes nowhere" bug). */

  /* Stats are read-only displays now — raising a stat goes through the
   * level-up button (data-action="level-up-stat") wired in onClick.  No
   * blur/commit listener needed. */

  /* Skill rank inputs — commit base skill level on blur / Enter. */
  wireOnce('input[data-action="set-skill"]', el => {
    el.addEventListener("blur",    (ev) => { const a = getPanelActor("character"); if (a) onSkillCommit(ev, a); });
    el.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); ev.target.blur(); } });
  });

  /* Bar current-value inputs — commit on blur or Enter (matches journal). */
  wireOnce('input[data-action="set-bar"]', el => {
    el.addEventListener("blur",   (ev) => { const a = getPanelActor("character"); if (a) onBarCommit(ev, a); });
    el.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); ev.target.blur(); } });
  });

  /* Tracker inputs — wheel, arrow keys, click-to-edit.
   *
   *   - Wheel:   commits immediately via the debounced pipeline (snappy +/-).
   *   - Typing:  updates the optimistic pending value so the digit survives
   *              re-renders, but DOES NOT trigger a write until blur/Enter.
   *              Otherwise a 220ms idle pause mid-type would commit, fire
   *              updateActor, re-render the panel and steal focus.
   *   - Blur:    commits whatever the user typed. */
  wireOnce('input[data-tracker]', el => {
    el.addEventListener("wheel", (ev) => { const a = getPanelActor("character"); if (a) onTrackerWheel(ev, a); }, { passive: false });
    el.addEventListener("input", (ev) => { const a = getPanelActor("character"); if (a) onTrackerTyping(ev, a); });
    el.addEventListener("blur",  (ev) => { const a = getPanelActor("character"); if (a) onTrackerBlur(ev, a); });
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); ev.target.blur(); }
    });
  });

  /* Biography editor — save on blur only.  Same reasoning as the journal
   * body: any input-time save triggers a re-render that nukes the cursor. */
  wireOnce('[data-action="edit-bio"]', el => {
    el.addEventListener("blur", (ev) => { const a = getPanelActor("character"); if (a) onBioBlur(ev, a); });
  });

  /* Life event field inputs — commit on blur (or Enter for the
   * single-line inputs; textarea allows Enter as a newline). */
  wireOnce('[data-action="edit-life-event-field"]', el => {
    el.addEventListener("blur", (ev) => { const a = getPanelActor("character"); if (a) onLifeEventCommit(ev, a); });
    if (el.tagName === "INPUT") {
      el.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); ev.target.blur(); }
      });
    }
  });

  /* Bio detail / vitals inputs — text/number commit on blur; selects
   * commit on change (no blur UX for native <select>). */
  wireOnce('[data-action="edit-bio-field"]', el => {
    if (el.tagName === "SELECT") {
      el.addEventListener("change", (ev) => { const a = getPanelActor("character"); if (a) onBioFieldCommit(ev, a); });
    } else {
      el.addEventListener("blur", (ev) => { const a = getPanelActor("character"); if (a) onBioFieldCommit(ev, a); });
      el.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); ev.target.blur(); }
      });
    }
  });

  /* Drag-reorder for life events.  Two-element split:
   *   - dragstart fires on the marker (the only draggable element), which
   *     looks up its parent card to read the data-life-key.
   *   - dragover / dragleave / drop fire on the cards (the drop targets).
   * Text inputs inside the card never trigger drag because draggable=true
   * is scoped to the marker, not the card body. */
  wireOnce('.wou-chr-bg-event-marker', marker => {
    marker.addEventListener("dragstart", (ev) => {
      const card = marker.closest(".wou-chr-bg-event");
      const key  = card?.dataset.lifeKey;
      if (!key) { ev.preventDefault(); return; }
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData("text/plain", key);
      /* Default drag image is the tiny marker dot — substitute the whole
       * card so the user sees what they're moving. */
      try { ev.dataTransfer.setDragImage(card, 12, 12); } catch (_) {}
      card.classList.add("is-dragging");
    });
    marker.addEventListener("dragend", () => {
      const card = marker.closest(".wou-chr-bg-event");
      card?.classList.remove("is-dragging");
      panelEl.querySelectorAll(".wou-chr-bg-event").forEach(e =>
        e.classList.remove("is-drop-above", "is-drop-below"));
    });
  });

  wireOnce('.wou-chr-bg-event[data-life-key]', card => {
    card.addEventListener("dragover", (ev) => {
      if (!ev.dataTransfer?.types?.includes("text/plain")) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
      const rect = card.getBoundingClientRect();
      const isAbove = (ev.clientY - rect.top) < rect.height / 2;
      card.classList.toggle("is-drop-above", isAbove);
      card.classList.toggle("is-drop-below", !isAbove);
    });
    card.addEventListener("dragleave", (ev) => {
      /* Only clear if the cursor actually left the card (not a child). */
      if (card.contains(ev.relatedTarget)) return;
      card.classList.remove("is-drop-above", "is-drop-below");
    });
    card.addEventListener("drop", async (ev) => {
      ev.preventDefault();
      const fromKey = ev.dataTransfer.getData("text/plain");
      const toKey = card.dataset.lifeKey;
      const dropAbove = card.classList.contains("is-drop-above");
      card.classList.remove("is-drop-above", "is-drop-below");
      if (!fromKey || fromKey === toKey) return;
      const a = getPanelActor("character");
      if (a) await reorderLifeEvents(a, fromKey, toKey, dropAbove);
    });
  });
}

function onTrackerWheel(ev, actor) {
  /* Only consume the wheel when the input is focused — otherwise scrolling
   * past the panel would also nudge the value. */
  if (document.activeElement !== ev.currentTarget) return;
  ev.preventDefault();
  const delta = ev.deltaY < 0 ? +1 : -1;
  bumpTracker(actor, ev.currentTarget.dataset.tracker, delta);
}

function onTrackerTyping(ev, actor) {
  /* Track the in-flight typed value so a re-render mid-type doesn't blow it
   * away.  Crucially does NOT schedule a write — we wait for blur. Uses the
   * tracker's own clamp so negative-valued trackers (satiety lives at
   * [−100, 125]) accept what the GM is typing instead of snapping to 0. */
  const kind = ev.currentTarget.dataset.tracker;
  const v = Number(ev.currentTarget.value);
  if (!Number.isFinite(v)) return;
  const cfg = trackerConfig(actor, kind);
  const clamp = cfg?.clamp ?? ((x) => Math.max(0, x));
  setPendingValueOnly(`tracker.${kind}`, clamp(Math.floor(v)));
}

function onTrackerBlur(ev, actor) {
  /* Same clamp story as onTrackerTyping — defer to the tracker's own clamp
   * so the typed value commits as authored when the field allows negatives. */
  const kind = ev.currentTarget.dataset.tracker;
  const v = Number(ev.currentTarget.value);
  if (!Number.isFinite(v)) return;
  const cfg = trackerConfig(actor, kind);
  const clamp = cfg?.clamp ?? ((x) => Math.max(0, x));
  setTrackerAbsolute(actor, kind, clamp(Math.floor(v)));
}

function setPendingValueOnly(key, value) {
  /* Update the optimistic value but leave any in-flight commit timer alone
   * (and don't create a new one).  Used while the user is actively typing. */
  const existing = pendingBumps.get(key);
  pendingBumps.set(key, { value, timer: existing?.timer ?? null });
}

async function onClick(ev, actor) {
  const actionEl = ev.target.closest("[data-action]");
  if (!actionEl) return;
  const action = actionEl.dataset.action;
  switch (action) {
    case "close":          ev.preventDefault(); await setCharacterOpen(false); return;
    case "variable-portrait": ev.preventDefault(); await openVariablePortraitConfig(actor); return;
    case "set-main":       ev.preventDefault(); activeMain = actionEl.dataset.main ?? "abilities"; await render(); return;
    case "set-sub":        ev.preventDefault(); activeSub  = actionEl.dataset.sub  ?? "stats";     await render(); return;
    case "level-up-skill": ev.preventDefault(); await onLevelUpSkill(actor, actionEl); return;
    case "set-ip-mode": {
      ev.preventDefault();
      const next = actionEl.dataset.ipMode === "magic" ? "magic" : "any";
      if (_ipMode !== next) { _ipMode = next; await render(); }
      return;
    }
    case "level-up-stat":  ev.preventDefault(); await onLevelUpStat(actor, actionEl);  return;
    case "bump-luck": {
      ev.preventDefault();
      const delta = Number(actionEl.dataset.delta) || 0;
      await onBumpLuck(actor, delta);
      return;
    }
    case "toggle-path":    ev.preventDefault(); togglePath(actionEl.dataset.path); return;
    case "bump-tracker": {
      ev.preventDefault();
      const kind  = actionEl.dataset.tracker;
      const delta = Number(actionEl.dataset.delta) || 0;
      bumpTracker(actor, kind, delta);
      return;
    }
    case "openSatietyDialog": {
      ev.preventDefault();
      try {
        const { openSatietyDialog } = await import("../../applications/satietyDialog.mjs");
        await openSatietyDialog(actor);
      } catch (err) {
        console.error("[wdm] failed to open SatietyDialog from chrome:", err);
        ui.notifications?.error(tFormat("WITCHER.Mech.FoodAndDrink.Notify.SatietyDialogFailed", { reason: err?.message ?? err }, `Satiety dialog failed to open: ${err?.message ?? err}`));
      }
      return;
    }
    case "dec-armor": {
      ev.preventDefault();
      if (actionEl.classList.contains("is-zero")) return;
      const loc = actionEl.dataset.loc;
      if (loc) await decrementArmorSP(actor, loc);
      return;
    }
    case "activate-effect": {
      ev.preventDefault();
      ev.stopPropagation();
      const effectId = actionEl.closest(".wou-chr-eff-row")?.dataset.effectId;
      if (effectId) await enableEffect(actor, effectId);
      return;
    }
    case "pause-effect": {
      ev.preventDefault();
      ev.stopPropagation();
      /* Toggle the per-effect manual pause. Backing helper in
       * chrome/policy/tick-effects.js snapshots current remaining seconds
       * into a flag on pause and restores start.time on resume. */
      const row      = actionEl.closest(".wou-chr-eff-row");
      const effectId = row?.dataset.effectId;
      const parentUuid = row?.dataset.parentUuid;
      if (!effectId) return;
      let effect = actor.effects.get(effectId) ?? null;
      /* Item-transferred AEs live on the item, not the actor — resolve via
       * the row's stored parent UUID. */
      if (!effect && parentUuid) {
        try {
          const parent = await fromUuid(parentUuid);
          effect = parent?.effects?.get?.(effectId) ?? null;
        } catch (_) { /* stale uuid */ }
      }
      if (!effect) return;
      const { toggleEffectPause } = await import("../policy/tick-effects.js");
      await toggleEffectPause(effect);
      return;
    }
    case "remove-effect": {
      ev.preventDefault();
      ev.stopPropagation();
      if (!game.user?.isGM) return;
      const row        = actionEl.closest(".wou-chr-eff-row");
      const effectId   = row?.dataset.effectId;
      const parentUuid = row?.dataset.parentUuid;
      if (effectId && parentUuid) await removeEffect(effectId, parentUuid);
      return;
    }
    case "remove-crit-wound": {
      ev.preventDefault();
      ev.stopPropagation();
      if (!game.user?.isGM) return;
      const woundId = woundIdFromEvent(actionEl);
      if (woundId) await removeCritWound(actor, woundId);
      return;
    }
    case "advance-wound-treatment": {
      ev.preventDefault();
      ev.stopPropagation();
      const woundId = woundIdFromEvent(actionEl);
      if (woundId) await advanceWoundTreatment(actor, woundId);
      return;
    }
    case "adjust-wound-heal-days": {
      ev.preventDefault();
      ev.stopPropagation();
      if (!game.user?.isGM) return;
      const woundId = woundIdFromEvent(actionEl);
      const delta = Number(actionEl.dataset.delta) || 0;
      if (woundId && delta) await adjustWoundHealDays(actor, woundId, delta);
      return;
    }
    case "toggle-prof-skill": {
      ev.preventDefault();
      const key = actionEl.dataset.skillKey;
      if (key) toggleProfSkill(key);
      return;
    }
    case "set-magic-filter": {
      ev.preventDefault();
      const next = actionEl.dataset.filter;
      if (next && next !== activeMagicFilter) {
        activeMagicFilter = next;
        await render();
      }
      return;
    }
    case "toggle-magic-section": {
      ev.preventDefault();
      const key = actionEl.dataset.sectionKey;
      if (!key) return;
      if (collapsedMagicSections.has(key)) collapsedMagicSections.delete(key);
      else                                 collapsedMagicSections.add(key);
      await render();
      return;
    }
    case "add-life-event": {
      ev.preventDefault();
      await addLifeEventSlot(actor);
      return;
    }
    case "toggle-life-events": {
      ev.preventDefault();
      lifeEventsCollapsed = !lifeEventsCollapsed;
      await render();
      return;
    }
    case "cast-spell": {
      /* Left-click a magic card → the cast dialog (castSpellMixin). Routes the
       * action economy off the result exactly like the dock's pinned-spell row:
       * cancel spends nothing; a ritual / multi-action cast locks the turn;
       * else it takes a normal action slot. Right-click still opens the sheet. */
      ev.preventDefault();
      ev.stopPropagation();
      const spellId = actionEl.dataset.spellId;
      if (!spellId) return;
      const spell = actor.items.get(spellId);
      if (!spell) return;
      if (typeof actor.castSpell !== "function") { openSpellSheet(actor, spellId); return; }
      try {
        /* Snapshot combat state before the cast — an area spell's async
         * template placement transiently nulls game.combat, which would make
         * the post-cast spend think we're out of combat. Force it through if
         * the actor was in combat and on turn at cast time. */
        const forceSpend = !!(actor?._inActiveCombat && actor?._isMyTurn);
        const res = await actor.castSpell(spell);
        if (!res) return;
        if (res.fullRound) {
          if (typeof actor.recordFullRound === "function") await actor.recordFullRound(`Cast: ${spell.name}`, { force: forceSpend });
        } else if (typeof actor.spendActionSlot === "function") {
          await actor.spendActionSlot(`Cast: ${spell.name}`, { force: forceSpend });
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | castSpell failed`, err);
      }
      return;
    }
    case "toggle-spell-pin": {
      /* Pin / unpin a spell.  stopPropagation prevents the click from
       * bubbling up to the surrounding `cast-spell` card. The flag toggles
       * fine, but morphChildren SKIPS document.activeElement — and clicking
       * the pin button focuses it — so its `is-pinned` class would never
       * repaint. Blur it first so the morph updates the new state. */
      ev.preventDefault();
      ev.stopPropagation();
      const spellId = actionEl.dataset.spellId;
      if (!spellId) return;
      await toggleSpellPin(actor, spellId);
      actionEl.blur();
      await render();
      return;
    }
    case "level-up-prof-skill": {
      ev.preventDefault();
      ev.stopPropagation();
      const key = actionEl.dataset.skillKey;
      if (!key) return;
      if (actionEl.dataset.busy) return;
      actionEl.dataset.busy = "1";
      try {
        await onLevelUpProfessionSkill(actor, key);
      } finally {
        delete actionEl.dataset.busy;
      }
      return;
    }
    case "roll-prof-skill": {
      ev.preventDefault();
      ev.stopPropagation();
      const key = actionEl.dataset.skillKey;
      if (key) await rollProfessionSkill(actor, key);
      return;
    }
    case "open-item": {
      ev.preventDefault();
      const item = actor.items?.get?.(actionEl.dataset.itemId);
      item?.sheet?.render(true);
      return;
    }
  }
}

/* Resolve a profession-pane skillKey ("defining" / "pathN.skillM") to its
 * live slot and roll it via the system (1d10 + stat + level). */
async function rollProfessionSkill(actor, key) {
  if (!actor || !key) return;
  const prof = actor.items.find(i => i.type === "profession");
  if (!prof) return;
  let slot;
  if (key === "defining") {
    slot = prof.system?.definingSkill;
  } else {
    const m = /^path([123])\.(skill[123])$/.exec(key);
    if (!m) return;
    slot = prof.system?.[`skillPath${m[1]}`]?.[m[2]];
  }
  /* A slot with no governing stat (N/A) isn't rollable — there's no
   * 1d10 + stat + level check to make. */
  const statKey = String(slot?.stat ?? "").toLowerCase();
  if (!statKey || statKey === "none") {
    ui.notifications?.warn?.(tFormat("WITCHER.Notify.Character.SkillNoStat", { skill: slot?.skillName ?? "This skill" }, "{skill} has no associated stat and can't be rolled."));
    return;
  }
  if (typeof actor.rollProfessionSkill !== "function") {
    ui.notifications?.error(t("WITCHER.Notify.Character.HelperMissingProf", "System's rollProfessionSkill helper missing."));
    return;
  }
  await actor.rollProfessionSkill(slot);
}

function toggleProfSkill(key) {
  if (!key) return;
  if (expandedProfSkills.has(key)) expandedProfSkills.delete(key);
  else                              expandedProfSkills.add(key);
  render();
}

/* Append an IP-spend entry to the actor's ledger, returning the NEW array so
 * the caller can fold it into a single actor.update.  The schema is
 * { label, value } (lifepath.mjs) — `value` is NEGATIVE for a spend.  This is
 * the same shape `socketHook.mjs`'s handleGrantIP writes and the actor sheet's
 * ipLogEntries reads, so chrome spends now show up in that log correctly. */
function appendIpLog(actor, label, value) {
  const existing = Array.isArray(actor.system?.logs?.ipLog) ? actor.system.logs.ipLog : [];
  return [...existing, { label, value }];
}

/* Resolve how a skill level-up's IP cost is split between the regular
 * and Magic IP pools, given the current `_ipMode`. Returns
 * `{ fromRegular, fromMagic }` on success, or `null` if the spend
 * can't be completed (user cancelled the confirm dialog, or neither
 * pool has enough).
 *
 * Modes:
 *  - "magic": only magic-eligible skills can be leveled, and only
 *    from Magic IP. Non-magic → notify + null. Insufficient Magic IP
 *    → notify + null.
 *  - "any": regular IP is preferred. If regular is enough → spend
 *    from regular. If regular is short AND the skill is magic AND
 *    the combined pool covers it → CONFIRM DIALOG asking the user
 *    to top up from Magic IP; on confirm split the spend, on cancel
 *    return null. Otherwise notify + null. */
async function resolveIpSpend({ cost, ip, magicIp, isMagic, skillName }) {
  if (_ipMode === "magic") {
    if (!isMagic) {
      ui.notifications?.warn?.(tFormat(
        "WITCHER.Notify.Character.NotEligibleForMagicIp",
        { skill: skillName },
        `{skill} isn't marked as magical — switch to regular IP mode to level it.`));
      return null;
    }
    if (magicIp < cost) {
      ui.notifications?.warn?.(tFormat(
        "WITCHER.Notify.Character.NotEnoughIpMagic",
        { cost, have: magicIp },
        `Need {cost} IP to level — have {have}.`));
      return null;
    }
    return { fromRegular: 0, fromMagic: cost };
  }
  /* "any" mode */
  if (ip >= cost) return { fromRegular: cost, fromMagic: 0 };
  if (!isMagic || (ip + magicIp) < cost) {
    ui.notifications?.warn?.(tFormat(
      "WITCHER.Notify.Character.NotEnoughIp",
      { cost, have: ip },
      `Need {cost} IP to level — have {have}.`));
    return null;
  }
  /* Regular is short but combined covers it — confirm with the user
   * before pulling from Magic IP, per Q1's "must ask, must be
   * localized" ruling. */
  const fromRegular = ip;
  const fromMagic   = cost - ip;
  const confirmed = await confirmMagicIpTopUp({
    skill: skillName, cost, ip, magicHave: magicIp, fromMagic
  });
  if (!confirmed) return null;
  return { fromRegular, fromMagic };
}

async function confirmMagicIpTopUp({ skill, cost, ip, magicHave, fromMagic }) {
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  const title = t("WITCHER.Chrome.Character.Dialog.UseMagicIpTitle", "Use Magic IP?");
  const body  = tFormat("WITCHER.Chrome.Character.Dialog.UseMagicIpBody",
    { ip, cost, skill, fromMagic, magicHave },
    `You only have {ip} IP but {cost} IP is needed to raise {skill}. Spend {fromMagic} Magic IP to cover the shortfall? ({magicHave} available)`);
  const confirmLabel = t("WITCHER.Chrome.Character.Dialog.UseMagicIpConfirm", "Spend Magic IP");
  const cancelLabel  = t("WITCHER.Chrome.Character.Dialog.UseMagicIpCancel",  "Cancel");
  if (!DialogV2?.confirm) return false;
  try {
    return await DialogV2.confirm({
      window: { title },
      content: `<p style="padding:6px 0;">${escapeText(body)}</p>`,
      yes: { label: confirmLabel, default: true },
      no:  { label: cancelLabel },
      modal: true,
      rejectClose: false
    });
  } catch (_) { return false; }
}

async function onLevelUpProfessionSkill(actor, key) {
  if (!actor || !key) return;
  const prof = actor.items.find(i => i.type === "profession");
  if (!prof) return;
  /* key is "defining" or "pathN.skillM" — resolve to the slot + update path. */
  let slot, updatePath;
  if (key === "defining") {
    slot = prof.system?.definingSkill;
    updatePath = "system.definingSkill.level";
  } else {
    const m = /^path([123])\.(skill[123])$/.exec(key);
    if (!m) return;
    const [, pathN, slotK] = m;
    slot = prof.system?.[`skillPath${pathN}`]?.[slotK];
    updatePath = `system.skillPath${pathN}.${slotK}.level`;
    /* Prereq: skill1 of any path requires the DEFINING skill at level 5;
     * skill2/skill3 require the skill above them in the same path ≥ 5. */
    let prevLvl;
    let prereqMsg;
    if (slotK === "skill1") {
      prevLvl   = Number(prof.system?.definingSkill?.level) || 0;
      prereqMsg = "Raise the defining skill to level 5 to start a path.";
    } else {
      const prevK = slotK === "skill2" ? "skill1" : "skill2";
      prevLvl   = Number(prof.system?.[`skillPath${pathN}`]?.[prevK]?.level) || 0;
      prereqMsg = "Raise the previous skill in this path to level 5 to unlock this one.";
    }
    if (prevLvl < 5) {
      ui.notifications?.warn?.(prereqMsg);
      return;
    }
  }
  if (!slot) return;
  const lvl = Number(slot.level) || 0;
  if (lvl >= 10) return;

  const skKey   = slot.skillKey ?? slot.skillName?.toLowerCase().replace(/\s+/g, "");
  const skillMap = globalThis.CONFIG?.WITCHER?.skillMap ?? {};
  const magicSkillList = globalThis.CONFIG?.WITCHER?.magicSkills ?? [];
  const costMul = Number(skillMap[skKey]?.costMultiplier) || 1;
  const cost    = Math.max(lvl, 1) * costMul;
  /* A profession slot is magic-eligible if either the underlying skill
   * key is base-magic OR the slot's `isMagical` flag is set. */
  const isMagic = magicSkillList.includes(skKey) || !!slot.isMagical;

  const ip      = Number(actor.system?.improvementPoints) || 0;
  const magicIp = Number(actor.system?.magic?.magicImprovementPoints) || 0;
  const skillName = slot.skillName || skKey;

  const spend = await resolveIpSpend({ cost, ip, magicIp, isMagic, skillName });
  if (!spend) return;

  const actorUpdate = {};
  if (spend.fromMagic > 0) actorUpdate["system.magic.magicImprovementPoints"] = magicIp - spend.fromMagic;
  if (spend.fromRegular > 0) actorUpdate["system.improvementPoints"]           = ip - spend.fromRegular;
  const label = `${skillName} ${lvl} → ${lvl + 1}${spend.fromMagic > 0 ? " (Magic IP)" : ""}`;
  actorUpdate["system.logs.ipLog"] = appendIpLog(actor, label, -cost);
  await prof.update({ [updatePath]: lvl + 1 });
  await actor.update(actorUpdate);
  /* Two sequential updates → two rerenderIfOpen queued via rAF; the second
   * may coalesce with the first and paint against a snapshot where only one
   * of the writes has landed. Force a synchronous render here to guarantee
   * the diamond track picks up the new profession-item level immediately. */
  _forceNextRender = true;
  await render();
}

async function enableEffect(actor, effectId) {
  const eff = actor?.effects?.get?.(effectId);
  if (!eff || !eff.disabled) return;
  try {
    await eff.update({ disabled: false });
  } catch (err) {
    console.warn(`${MODULE_ID} | failed to enable effect ${effectId}`, err);
    ui.notifications?.error?.(t("WITCHER.Notify.Character.EnableEffectFailed", "Couldn't enable effect — see console."));
  }
}

/* Advance a wound's state one step (Unstabilized → Stabilized → Treated)
 * via the data model.  The same item carries all three effect columns;
 * stabilize()/treat() flip `system.state` (and treat() anchors the
 * natural-healing clock).  The autoheal policy then clears the wound once
 * the clock runs out.
 *
 * Foundry's permission system gates this to actor owners (PC owner + GM). */
/* Resolve a wound id from a clicked control. Prefer the card/row WRAPPER's
 * data-wound-id over the button's own. The in-place morph (morphChildren)
 * skips document.activeElement, so a button the user just clicked can retain a
 * STALE data-wound-id after its card node is reused to display a different
 * wound — the cause of the "item doesn't exist" error when deleting the second
 * of two same-tier wounds. The wrapper is never the focused element, so its id
 * is always current. */
function woundIdFromEvent(el) {
  return el?.closest?.(".wou-chr-wound-card, .wou-chr-eff-row")?.dataset?.woundId
      ?? el?.dataset?.woundId
      ?? null;
}

async function advanceWoundTreatment(actor, woundId) {
  if (!actor || !woundId) return;
  const item = actor.items?.get?.(woundId);
  if (!item || item.type !== "criticalWound") return;
  const state = String(item.system?.state ?? "unstabilized");
  try {
    if (state === "unstabilized") await item.system.stabilize();
    else if (state === "stabilized") await item.system.treat();
  } catch (err) {
    console.warn(`${MODULE_ID} | failed to advance wound state for ${woundId}`, err);
    ui.notifications?.error?.(t("WITCHER.Notify.Character.WoundAdvanceFailed", "Couldn't advance wound state — see console."));
  }
}

/* GM-only: nudge a treated wound's days-elapsed counter by ±days. Delegates
 * to the data model's adjustHealElapsed, which shifts the treatedAt anchor;
 * the item update re-renders the card via the panel's updateItem refresh. */
async function adjustWoundHealDays(actor, woundId, delta) {
  try {
    const item = actor?.items?.get?.(woundId);
    if (!item || item.type !== "criticalWound") return;
    await item.system.adjustHealElapsed(delta);
  } catch (err) {
    console.warn(`${MODULE_ID} | failed to adjust wound heal days ${woundId}`, err);
    ui.notifications?.error?.(t("WITCHER.Notify.Character.WoundHealAdjustFailed", "Couldn't adjust healing days — see console."));
  }
}

/* GM-only: remove a critical-wound item from the actor.  Crit wounds are
 * embedded items of type `criticalWound` (not ActiveEffect docs, not
 * entries in system.critWounds), so deletion is a normal item delete. */
async function removeCritWound(actor, woundId) {
  try {
    const item = actor?.items?.get?.(woundId);
    if (!item || item.type !== "criticalWound") {
      ui.notifications?.warn?.(t("WITCHER.Notify.Character.WoundNotFound", "Critical wound not found on this actor."));
      return;
    }
    await item.delete();
  } catch (err) {
    console.warn(`${MODULE_ID} | failed to remove crit wound ${woundId}`, err);
    ui.notifications?.error?.(t("WITCHER.Notify.Character.WoundRemoveFailed", "Couldn't remove critical wound — see console."));
  }
}

/* GM-only: delete an active effect from whichever document owns it.
 * `parentUuid` is captured into the row's dataset at render time so we
 * don't have to walk the actor's items to find the owner — works
 * uniformly for actor-level AEs and for transferred item AEs. */
async function removeEffect(effectId, parentUuid) {
  try {
    const parent = await fromUuid(parentUuid);
    if (!parent) {
      ui.notifications?.warn?.(t("WITCHER.Notify.Character.EffectParentMissing", "Effect parent missing — already removed?"));
      return;
    }
    await parent.deleteEmbeddedDocuments("ActiveEffect", [effectId]);
  } catch (err) {
    console.warn(`${MODULE_ID} | failed to remove effect ${effectId}`, err);
    ui.notifications?.error?.(t("WITCHER.Notify.Character.EffectRemoveFailed", "Couldn't remove effect — see console."));
  }
}

/* Find the first life-event schema slot with no content, mark it as being
 * edited so the next render shows its (empty) card, and re-render.  The
 * editingLifeEvents Set keeps the card visible across renders even with
 * blank fields — without it the visibility filter would hide the new card
 * the moment we re-render. */
async function addLifeEventSlot(actor) {
  if (!actor || actor.type !== "character") return;
  const events = actor.system?.general?.lifeEvents ?? {};

  const focusCard = (key) => requestAnimationFrame(() => {
    const sel = `.wou-chr-bg-event[data-life-key="${key}"] .wou-chr-bg-event-title-input`;
    panelEl?.querySelector(sel)?.focus?.();
  });

  /* Reuse an existing empty slot if one's already lying around so repeated
   * +Add clicks don't spawn a pile of blank cards. */
  for (const [key, ev] of Object.entries(events)) {
    const value   = String(ev?.value ?? "").trim();
    const details = String(ev?.details ?? "").trim();
    const date    = String(actor.getFlag?.(MODULE_ID, `lifeEventDates.${key}`) ?? "").trim();
    if (!value && !details && !date && !editingLifeEvents.has(key)) {
      editingLifeEvents.add(key);
      await render();
      focusCard(key);
      return;
    }
  }

  /* Otherwise mint a fresh free-form key.  The `evt-<id>` scheme matches the
   * actor sheet's so an event created in either editor shows in both.  The
   * empty entry must be persisted (not just held in editingLifeEvents) or it
   * won't appear in system.general.lifeEvents on the next render. */
  if (Object.keys(events).length >= 40) {
    ui.notifications?.info?.(t("WITCHER.Notify.Character.TooManyDefiningMoments", "That's a lot of defining moments — clear one before adding more."));
    return;
  }
  const key = `evt-${foundry.utils.randomID(8)}`;
  editingLifeEvents.add(key);
  await actor.update({ [`system.general.lifeEvents.${key}`]: { value: "", details: "" } });
  await render();
  focusCard(key);
}

/* Commit a bio field edit.  Path is a dotted accessor on the actor
 * (e.g. "system.general.age", "system.gender", "system.general.homeland").
 * Type coerces the input value before writing: number → integer, the rest
 * round-trip as strings.  No-op when the value didn't actually change so
 * the actor doesn't get a phantom update + re-render. */
async function onBioFieldCommit(ev, actor) {
  const el   = ev.currentTarget;
  const path = el.dataset.bioPath;
  const type = el.dataset.bioType;
  if (!path || !type) return;

  let next;
  if (type === "number") {
    const n = Number(el.value);
    next = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  } else {
    next = String(el.value ?? "");
  }

  const prev = foundry.utils.getProperty(actor, path);
  /* Loose compare so "0" === 0 and "" === undefined don't trigger writes. */
  if (String(prev ?? "") === String(next ?? "")) return;
  /* The input already shows `next`; skip the self-triggered full re-render. */
  _suppressNextRender = true;
  await actor.update({ [path]: next });
}

/* Order events by the user's saved drag-order, then any leftover events
 * (newly added, never reordered) in decade order at the end. */
function sortLifeEventsByOrder(events, savedOrder) {
  const indexOf = new Map(savedOrder.map((k, i) => [k, i]));
  return [...events].sort((a, b) => {
    const ai = indexOf.has(a.key) ? indexOf.get(a.key) : Number.POSITIVE_INFINITY;
    const bi = indexOf.has(b.key) ? indexOf.get(b.key) : Number.POSITIVE_INFINITY;
    if (ai !== bi) return ai - bi;
    /* Decade is a fallback only; free-form `evt-<id>` keys have no decade
     * (NaN), so they sort to the end and tie-break stably by key. */
    const ad = Number.isFinite(a.decade) ? a.decade : Number.POSITIVE_INFINITY;
    const bd = Number.isFinite(b.decade) ? b.decade : Number.POSITIVE_INFINITY;
    if (ad !== bd) return ad - bd;
    return String(a.key).localeCompare(String(b.key));
  });
}

/* Drop fromKey above-or-below toKey in the visible event list, then persist
 * the resulting full key order back to the actor flag.  Rebuilds the flag
 * from the current visible list so stale keys get scrubbed automatically. */
async function reorderLifeEvents(actor, fromKey, toKey, dropAbove) {
  if (!actor || !fromKey || !toKey || fromKey === toKey) return;
  const events = actor.system?.general?.lifeEvents ?? {};
  const savedOrder = Array.isArray(actor.getFlag?.(MODULE_ID, "lifeEventOrder"))
    ? actor.getFlag(MODULE_ID, "lifeEventOrder")
    : [];
  const visible = Object.entries(events)
    .map(([key, ev]) => ({
      key,
      decade: Number(ev?.decade) || Math.round(Number(key) / 10),
      hasContent: !!(String(ev?.value ?? "").trim()
                  || String(ev?.details ?? "").trim()
                  || String(actor.getFlag?.(MODULE_ID, `lifeEventDates.${key}`) ?? "").trim()
                  || String(actor.getFlag?.(MODULE_ID, `lifeEventLocations.${key}`) ?? "").trim()
                  || editingLifeEvents.has(key)),
    }))
    .filter(s => s.hasContent);

  const currentOrder = sortLifeEventsByOrder(visible, savedOrder).map(s => s.key);

  const fromIdx = currentOrder.indexOf(fromKey);
  if (fromIdx === -1) return;
  currentOrder.splice(fromIdx, 1);
  let toIdx = currentOrder.indexOf(toKey);
  if (toIdx === -1) toIdx = currentOrder.length;
  if (!dropAbove) toIdx += 1;
  currentOrder.splice(toIdx, 0, fromKey);

  await actor.setFlag(MODULE_ID, "lifeEventOrder", currentOrder);
}

/* Commit handler for the three life-event editor fields.  value+details
 * write to system; date writes to a module flag (no schema field for it).
 * Clearing all three fields removes the slot from the editing-set so it
 * naturally drops out of the timeline on the next render. */
async function onLifeEventCommit(ev, actor) {
  const el    = ev.currentTarget;
  const key   = el.dataset.lifeKey;
  const field = el.dataset.field;
  if (!key || !field) return;
  const next = String(el.value ?? "");

  if (field === "value" || field === "details") {
    const prev = String(foundry.utils.getProperty(actor, `system.general.lifeEvents.${key}.${field}`) ?? "");
    if (next === prev) return;
    await actor.update({ [`system.general.lifeEvents.${key}.${field}`]: next });
  } else if (field === "date" || field === "location") {
    /* Both live as module flags since the system schema has neither.
     * `lifeEventDates.${key}` and `lifeEventLocations.${key}` are sibling
     * sub-keys; clear via unsetFlag rather than empty-string set to avoid
     * leaving phantom keys behind. */
    const flagPath = field === "date" ? "lifeEventDates" : "lifeEventLocations";
    const prev = String(actor.getFlag?.(MODULE_ID, `${flagPath}.${key}`) ?? "");
    if (next === prev) return;
    if (next.trim()) {
      await actor.setFlag(MODULE_ID, `${flagPath}.${key}`, next);
    } else {
      await actor.unsetFlag(MODULE_ID, `${flagPath}.${key}`);
    }
  }

  /* If the slot is now entirely empty, drop it from the editing set so it
   * stops rendering.  Read freshly because we just wrote. */
  const sys = actor.system?.general?.lifeEvents?.[key] ?? {};
  const v  = String(sys.value ?? "").trim();
  const d  = String(sys.details ?? "").trim();
  const dt = String(actor.getFlag?.(MODULE_ID, `lifeEventDates.${key}`) ?? "").trim();
  const lo = String(actor.getFlag?.(MODULE_ID, `lifeEventLocations.${key}`) ?? "").trim();
  if (!v && !d && !dt && !lo) editingLifeEvents.delete(key);
}

function openSpellSheet(actor, spellId) {
  const item = actor?.items?.get?.(spellId);
  if (!item) return;
  try { item.sheet?.render(true); }
  catch (err) { console.warn(`${MODULE_ID} | failed to open spell sheet`, err); }
}

function onContextMenu(ev, actor) {
  /* Spell cards: right-click opens the item sheet.  Other right-clicks fall
   * through to the browser / Foundry default. */
  const spellEl = ev.target.closest('[data-action="cast-spell"]');
  if (spellEl) {
    ev.preventDefault();
    ev.stopPropagation();
    const spellId = spellEl.dataset.spellId;
    if (spellId) openSpellSheet(actor, spellId);
  }
}

async function togglePath(key) {
  if (!key) return;
  if (expandedPaths.has(key)) expandedPaths.delete(key);
  else                        expandedPaths.add(key);
  await render();
}

/* Spend IP to raise a regular skill one level.  Writes directly (mirrors
 * onLevelUpProfessionSkill):
 *   - cost = max(skill.value, 1) × (costMultiplier ?? 1)
 *   - magic IP debit first for magic skills, regular IP for the rest
 *   - skill value +1 at system.skills.<statKey>.<skillKey>.value
 * The eventual updateActor hook re-renders this panel with the new diamond. */
async function onLevelUpSkill(actor, btnEl) {
  const key = btnEl?.dataset?.skill;
  if (!actor || !key) return;
  if (btnEl.dataset.busy) return;       /* swallow rapid double-clicks */
  btnEl.dataset.busy = "1";
  try {
    const skillMap = globalThis.CONFIG?.WITCHER?.skillMap ?? {};
    const statKey  = skillMap[key]?.statKey;
    if (!statKey) {
      console.warn(`${MODULE_ID} | level-up failed — unknown skill '${key}'`);
      return;
    }
    const lvl = Number(actor.system?.skills?.[statKey]?.[key]?.value) || 0;
    if (lvl >= 10) return;

    const magicSkillList = globalThis.CONFIG?.WITCHER?.magicSkills ?? [];
    const costMul = Number(skillMap[key]?.costMultiplier) || 1;
    const cost    = Math.max(lvl, 1) * costMul;
    const isMagic = magicSkillList.includes(key);

    const ip      = Number(actor.system?.improvementPoints) || 0;
    const magicIp = Number(actor.system?.magic?.magicImprovementPoints) || 0;

    const labelKey = globalThis.CONFIG?.WITCHER?.skillLabel?.(key);
    const skillName = labelKey ? game.i18n.localize(labelKey) : key;

    const spend = await resolveIpSpend({ cost, ip, magicIp, isMagic, skillName });
    if (!spend) return;

    const actorUpdate = {};
    if (spend.fromMagic > 0) actorUpdate["system.magic.magicImprovementPoints"] = magicIp - spend.fromMagic;
    if (spend.fromRegular > 0) actorUpdate["system.improvementPoints"]           = ip - spend.fromRegular;
    const label = `${skillName} ${lvl} → ${lvl + 1}${spend.fromMagic > 0 ? " (Magic IP)" : ""}`;
    actorUpdate[`system.skills.${statKey}.${key}.value`] = lvl + 1;
    actorUpdate["system.logs.ipLog"] = appendIpLog(actor, label, -cost);
    await actor.update(actorUpdate);
    /* The IP number gets re-rendered by the updateActor hook, but reports
     * of the diamond track lagging until the panel reopens suggest either
     * a morph short-circuit OR that the queued rAF render fires against a
     * stale actor snapshot. Force a synchronous re-render here so the row's
     * `sk.value` read reflects the freshly-committed skill level. */
    _forceNextRender = true;
    await render();
  } catch (err) {
    console.warn(`${MODULE_ID} | level-up failed for ${key}`, err);
  } finally {
    delete btnEl.dataset.busy;
  }
}

/* Spend or restore a point of Luck.  Clamped to [0, max] — the system
 * stores the current pool at `system.stats.luck.value`, separate from
 * `max` which the level-up button raises.  Skips the write if the value
 * wouldn't change (already at the floor/ceiling). */
async function onBumpLuck(actor, delta) {
  if (!actor || !delta) return;
  const block = actor.system?.stats?.luck ?? {};
  const cur = Number(block.value) || 0;
  const max = Number(block.max) || 0;
  const next = Math.max(0, Math.min(max, cur + delta));
  if (next === cur) return;
  await actor.update({ "system.stats.luck.value": next });
}

/* Stat level-up — capped at STAT_MAX (10).  IP cost per Witcher core p.59:
 * current level × 10.  The rank IS the source stat value (the system sheet
 * edits the same path), so we write it directly: bump the SOURCE rank
 * (`stats.<key>.value`, or `stats.luck.max` for LUCK), debit IP, AND append
 * the log entry — all in ONE update so there's no race or double-write.
 *
 * Earlier this also called `actor.system.logs.addIpReward`, but that
 * method internally fires its OWN actor.update against improvementPoints
 * (logData.js:17), so combined with the explicit deduction in our update
 * the cost was being subtracted twice (e.g. 60 IP - 40 - 40 = -20 after
 * a single 3 → 4 luck level-up).  We write the log entry directly via
 * the same update to avoid that path entirely. */
async function onLevelUpStat(actor, btnEl) {
  const statKey = btnEl?.dataset?.stat;
  if (!actor || !statKey) return;
  if (btnEl.dataset.busy) return;
  btnEl.dataset.busy = "1";
  try {
    const base = statBaseValue(actor, statKey);
    const ip   = Number(actor.system?.improvementPoints) || 0;
    if (base >= STAT_MAX) return;
    const cost = statLevelUpCost(base);
    if (ip < cost) {
      ui.notifications?.warn?.(tFormat("WITCHER.Notify.Character.NotEnoughIpStat", { cost: cost, stat: statKey.toUpperCase(), base: base, next: base + 1, have: ip }, "Need {cost} IP to raise {stat} {base} → {next} — have {have}."));
      return;
    }
    const label = `${statKey.toUpperCase()} ${base} → ${base + 1}`;
    const rankPath = statKey === "luck"
      ? "system.stats.luck.max"
      : `system.stats.${statKey}.value`;
    await actor.update({
      [rankPath]: base + 1,
      "system.improvementPoints": ip - cost,
      "system.logs.ipLog": appendIpLog(actor, label, -cost),
    });
    // Same synchronous re-render guard as the skill level-up path — makes
    // the stat pip's post-spend state visible without waiting for the queued
    // rAF render (which can no-op via the html-equality short-circuit if
    // upstream data prep hasn't observed the write yet).
    _forceNextRender = true;
    await render();
  } catch (err) {
    console.warn(`${MODULE_ID} | stat level-up failed for ${statKey}`, err);
  } finally {
    delete btnEl.dataset.busy;
  }
}

/* ------------------------------------------------------------------------
 * Debounced bumps.
 *
 * Each ± click used to do an awaited `actor.update`, which:
 *   - blocks on a server round-trip per click,
 *   - triggers an `updateActor` hook → full panel re-render per click,
 *   - so 10 rapid clicks = 10 round-trips + 10 re-renders.
 *
 * Now we keep an in-memory "pending value" per field, optimistically patch
 * the visible number in the DOM, and only commit the write after the user
 * has stopped clicking for `BUMP_DEBOUNCE_MS`.  The eventual hook re-render
 * reads the same committed value back from the actor, so the DOM stays put
 * with no flicker.  Renderers also consult `pendingBumps` so that an
 * unrelated re-render (item update etc.) mid-burst doesn't snap stale.
 * ------------------------------------------------------------------------ */
const BUMP_DEBOUNCE_MS = 220;
const pendingBumps = new Map();   // key → { value, timer }

function pendingValue(key) {
  const p = pendingBumps.get(key);
  if (!p) return undefined;
  // Display value wins over commit value so a stress bump that the shield
  // will eat shows the post-absorb number (e.g. stay at 0) during the
  // debounce window, not the raw +1 that's about to commit-and-vanish.
  return p.displayValue ?? p.value;
}

function scheduleBump({ key, delta, currentValue, write, clamp, displayMap }) {
  const existing = pendingBumps.get(key);
  const cur  = existing ? existing.value : currentValue;
  const next = (clamp ?? ((v) => Math.max(0, v)))(cur + delta);
  // displayMap (optional) transforms the commit value into what the user
  // should see optimistically — used for stress to subtract the shield's
  // predicted absorb. Defaults to the identity map for everything else.
  const displayNext = (typeof displayMap === "function") ? displayMap(next) : next;
  if (existing?.timer) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    const final = pendingBumps.get(key)?.value;
    pendingBumps.delete(key);
    // Force the next render to bypass the html-equality short-circuit so
    // the morph step reconciles `patchInputValue`'s out-of-band write. If
    // the write was absorbed (stress shield) the actor data is unchanged
    // and the new HTML matches the cached version — without the force, the
    // optimistic display stays stuck on the patched value.
    _forceNextRender = true;
    if (typeof final === "number") {
      Promise.resolve(write(final)).catch((err) =>
        console.warn(`${MODULE_ID} | bump commit failed for ${key}`, err)
      );
    }
  }, BUMP_DEBOUNCE_MS);
  pendingBumps.set(key, { value: next, displayValue: displayNext, timer });
  return displayNext;
}

function trackerConfig(actor, kind) {
  /* All tracker writes (stress/adrenaline/shield/deathSaves) live behind this
   * single config map so wheel, keystroke, and (future) shortcut paths share
   * one source of truth.  Death saves cap at 10 — past 10 the save would auto-
   * fail by Witcher RAW, so we treat 10 as the floor. */
  switch (kind) {
    case "stress":     return {
      currentValue: Number(actor.system?.stress) || 0,
      /* Route through setStress so the Hunger Stress floor is enforced.
       * Hunger Stress (system.hungerStress) is the LOCKED portion granted
       * by the hunger cascade — sheet tick-down must not drop total stress
       * below it. setStress in stress.mjs enforces the floor unless called
       * with opts.wdmHungerRefund (the hunger cascade's own refund path).
       * Fall back to a direct update if stress module isn't loaded (e.g.
       * homebrew disabled) — the module import stays lazy so we don't pay
       * for it on unrelated chrome renders. */
      write: async (v) => {
        try {
          const { setStress } = await import("../../mechanics/stress.mjs");
          return setStress(actor, v);
        } catch {
          return actor.update({ "system.stress": v });
        }
      },
      clamp: (v) => {
        const hungerLocked = Number(actor.system?.hungerStress) || 0;
        return Math.max(hungerLocked, Math.max(0, v));
      },
    };
    case "adrenaline": return {
      currentValue: Number(actor.system?.adrenaline?.value) || 0,
      /* A manual +/- (or typed set) counts as a REAL adrenaline gain: an increase
       * fires the "on adrenaline gain" effect scaled by the amount (tick-effects
       * detects newAdr > oldAdr and fires that many times). The pool-current
       * ledger fix keeps that a single, non-snowballing write. A decrease fires
       * nothing (it isn't a gain). */
      write: (v) => actor.update({ "system.adrenaline.value": v }),
      clamp: (v) => Math.max(0, Math.min(v, Number(actor.system?.stats?.body?.value) || 0)),
    };
    case "shield":     return {
      // Shield is a single number (was { value, max } pool pre-Phase-13).
      currentValue: Number(actor.system?.derivedStats?.shield) || 0,
      write: (v) => actor.update({ "system.derivedStats.shield": v }),
      clamp: (v) => Math.max(0, v),
    };
    case "deathSaves": return {
      currentValue: Number(actor.system?.deathSaves) || 0,
      write: (v) => actor.update({ "system.deathSaves": v }),
      clamp: (v) => Math.max(0, Math.min(v, 10)),
    };
    case "focus":      return {
      // Investigation Focus pool (A Witcher's Journal p.145): value is
      // player-set, capped at the derived max ⌊(WILL+INT)/2⌋×3.
      currentValue: Number(actor.system?.derivedStats?.focus?.value) || 0,
      write: (v) => actor.update({ "system.derivedStats.focus.value": v }),
      clamp: (v) => Math.max(0, Math.min(v, Number(actor.system?.derivedStats?.focus?.max) || 0)),
    };
    case "satiety":    return {
      // Homebrew food & drink — GM-only writes (foodAndDrink.mjs's
      // preUpdateActor hook strips player writes server-side). The +/- buttons
      // and editable input are already hidden for non-GMs by renderTracker's
      // readonly path, so the bump handler shouldn't be reachable; this clamp
      // / write pair is here for GM interactions only.
      currentValue: Number(actor.system?.satiety) || 0,
      write: (v) => actor.update({ "system.satiety": v }),
      clamp: (v) => Math.max(-100, Math.min(125, v)),
    };
    default: return null;
  }
}

function bumpTracker(actor, kind, delta) {
  if (!actor || !kind || !delta) return;
  const cfg = trackerConfig(actor, kind);
  if (!cfg) return;
  // For stress + positive cumulative delta, peek at the same `planAbsorb`
  // the preUpdateActor gate will run on commit, so the optimistic display
  // already reflects what's actually going to land. Without this, clicking
  // "+" on a Stoic-buffered actor would flash stress = 1 (then snap back to
  // 0 once the write fires and gets absorbed) — which reads as a buggy
  // dance even though it's just optimistic UI lying about the outcome.
  //
  // The commit value (`next`) stays as-is so the write still triggers the
  // absorb gate and the shield buffer decrements; only the rendered value
  // is mapped down. Cumulative delta accounts for rapid multi-click bursts
  // — clicking + four times on a 4-point buffer keeps the display at 0
  // throughout because preview(actor, 4) reports the buffer covers it.
  let displayMap;
  if (kind === "stress" && delta > 0) {
    const existing = pendingBumps.get(`tracker.${kind}`);
    const cur  = existing ? existing.value : cfg.currentValue;
    const next = cfg.clamp(cur + delta);
    const cumulativeDelta = next - cfg.currentValue;
    if (cumulativeDelta > 0) {
      let plan = null;
      try { plan = game.system?.api?.mechanics?.stress?.previewAbsorb?.(actor, cumulativeDelta) ?? null; }
      catch (_) { plan = null; }
      if (plan?.absorbed > 0) {
        const absorbed = Number(plan.absorbed) || 0;
        const curValue = cfg.currentValue;
        displayMap = (committed) => Math.max(curValue, committed - absorbed);
      }
    }
  }
  const shown = scheduleBump({ key: `tracker.${kind}`, delta, ...cfg, displayMap });
  patchInputValue(`.wou-chr-tracker[data-kind="${kind}"] .wou-chr-tracker-val`, shown);
}

function setTrackerAbsolute(actor, kind, value) {
  if (!actor || !kind) return;
  const cfg = trackerConfig(actor, kind);
  if (!cfg) return;
  const next = cfg.clamp(Number(value) || 0);
  /* Commit the typed value as an ABSOLUTE — not through the delta-based
   * scheduleBump.  Typing already parked the value in pendingBumps via
   * setPendingValueOnly, so a delta path would re-add it on top of itself
   * (type 5 → commit 10).  scheduleAbsolute overwrites it cleanly. */
  scheduleAbsolute({ key: `tracker.${kind}`, value: next, write: cfg.write });
}

/* Commit a known absolute value after the debounce window, replacing any
 * in-flight bump/typed pending value rather than accumulating onto it. */
function scheduleAbsolute({ key, value, write }) {
  const existing = pendingBumps.get(key);
  if (existing?.timer) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    const final = pendingBumps.get(key)?.value;
    pendingBumps.delete(key);
    // Same force-render contract as scheduleBump — see comment there.
    _forceNextRender = true;
    if (typeof final === "number") {
      Promise.resolve(write(final)).catch((err) =>
        console.warn(`${MODULE_ID} | tracker commit failed for ${key}`, err)
      );
    }
  }, BUMP_DEBOUNCE_MS);
  pendingBumps.set(key, { value, timer });
  return value;
}

function patchInputValue(selector, value) {
  const el = panelEl?.querySelector(selector);
  if (!el) return;
  if ("value" in el) el.value = String(value);
  else el.textContent = String(value);
}

/* Stats are no longer directly editable in the character tab — see
 * `onLevelUpStat` for the IP-gated bump path.  The skill input below
 * still uses an inline-edit + delta-subtract round-trip. */
async function onSkillCommit(ev, actor) {
  const statKey  = ev.currentTarget.dataset.stat;
  const skillKey = ev.currentTarget.dataset.skill;
  const v = Number(ev.currentTarget.value);
  if (!statKey || !skillKey || !Number.isFinite(v) || v < 0) return;
  const sk = actor.system?.skills?.[statKey]?.[skillKey] ?? {};
  const baseNow = Number(sk.value) || 0;
  /* The input displays effective = base + (modifier − EV penalty).
   * Commit must subtract the SAME delta to recover the correct base
   * rank, otherwise blurring an unchanged input would rewrite base
   * to the effective value (armor EV would eat the base rank). */
  const rawMod = Number(sk.modifier) || 0;
  const evPen  = Number(sk.evPenalty) || 0;
  const delta  = rawMod - evPen;
  const newBase = Math.max(0, Math.min(10, Math.round(v - delta)));
  if (newBase === baseNow) return;
  await actor.update({ [`system.skills.${statKey}.${skillKey}.value`]: newBase });
}

async function onBarCommit(ev, actor) {
  const kind = ev.currentTarget.dataset.kind;
  const v = Number(ev.currentTarget.value);
  if (!Number.isFinite(v)) return;
  const next = Math.max(0, Math.floor(v));
  switch (kind) {
    // The HP bar input shows the BLENDED total (real + temp), so editing it is a
    // damage/heal gesture — same as the actor sheet's folded HP field. A lower
    // number drains the temp shield first (drainHp); a higher number heals real
    // HP only, capped at real max (temp never refills).
    case "hp": {
      const hp    = actor.system?.derivedStats?.hp ?? {};
      const value = Math.max(0, Number(hp.value) || 0);
      const temp  = Math.max(0, Number(hp.temp)  || 0);
      const max   = Math.max(0, Number(hp.max)   || 0);
      const total = value + temp;
      if (next === total) return;
      if (next < total) {
        const drained = drainHp(hp, total - next);
        await actor.update({
          "system.derivedStats.hp.value": drained.value,
          "system.derivedStats.hp.temp":  drained.temp
        });
      } else {
        const healed = Math.min(next - total, Math.max(0, max - value));
        if (healed > 0) await actor.update({ "system.derivedStats.hp.value": value + healed });
      }
      return;
    }
    case "sta": await actor.update({ "system.derivedStats.sta.value": next }); return;
    case "tox": await actor.update({ "system.stats.toxicity.value":   next }); return;
  }
}


async function onBioBlur(ev, actor) {
  /* Backstory prose lives in `system.general.background` (HTML). */
  const html = ev.currentTarget.innerHTML;
  const prev = String(actor.system?.general?.background ?? "");
  if (html === prev) return;
  _suppressNextRender = true;
  await actor.update({ "system.general.background": html });
}

/* =========================================================================
   UTILS
   ========================================================================= */

/* True if the string looks like an ISO YYYY-MM-DD date — used to filter
 * out legacy free-text values when populating an <input type="date">,
 * which silently shows blank if the value can't be parsed. */
function isIsoDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function stripHTML(html) {
  if (!html) return "";
  const tmp = document.createElement("div");
  tmp.innerHTML = String(html);
  return (tmp.textContent || "").trim();
}

function escapeText(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttr(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
