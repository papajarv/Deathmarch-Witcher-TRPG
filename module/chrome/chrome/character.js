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

import { getAssignedActor, getDockData, VIEWER_OVERRIDE_HOOK } from "../lib/actor.js";
import { isVariablePortraitEnabled, openVariablePortraitConfig } from "../integrations/portrait-toxicity.js";
import { renderViewAsPicker, wireViewAsPicker } from "../lib/view-as.js";
import { formatSecondsLabel } from "./dock-statuses.js";
import {
  SP_LOCATIONS,
  RES_TYPES,
  getLocationSP,
  getResistancesForLocation,
  decrementArmorSP,
} from "./dock.js";
import { drainHp } from "../../setup/config.mjs";

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
const SUB_TABS = [
  { key: "stats",      label: "Stats & Skills",  icon: "fa-chart-simple" },
  { key: "profession", label: "Profession",      icon: "fa-shield-halved" },
  { key: "magic",      label: "Magic",           icon: "fa-wand-sparkles" },
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
  el.setAttribute("aria-label", "Character");
  document.body.appendChild(el);
  panelEl = el;

  /* CRITICAL: register the click delegate ONCE on the persistent panelEl.
   * It used to be added inside wireListeners() which runs every render — so
   * after N actor updates the panel had N click listeners, each firing on
   * every click, which compounded into the lag the user noticed.  The
   * delegate dispatches on data-action and looks up the actor lazily, so we
   * don't need to re-bind when the actor changes. */
  el.addEventListener("click", (ev) => {
    const actor = getAssignedActor();
    if (!actor) return;
    onClick(ev, actor);
  });

  /* Right-click delegate — same one-time pattern as the click handler.
   * Currently only spell cards opt in (data-context-action="open-sheet"),
   * but the dispatch is generic so other cards can opt in later. */
  el.addEventListener("contextmenu", (ev) => {
    const actor = getAssignedActor();
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

  if (!hooksWired) {
    /* Hook filters use the live-resolved viewer (override-aware) so updates
     * to whichever actor the GM is currently impersonating still trigger
     * a re-render. */
    const ownsItem = (i) => i?.parent?.id === getAssignedActor()?.id;
    const ownsEffect = (ae) => {
      const cid = getAssignedActor()?.id;
      if (!cid) return false;
      const p = ae?.parent;
      return p?.id === cid || p?.parent?.id === cid;
    };
    Hooks.on("updateUser",         (u) => { if (u.id === game.user.id)               rerenderIfOpen(); });
    Hooks.on("updateActor",        (a) => { if (a.id === getAssignedActor()?.id)     rerenderIfOpen(); });
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

  panelEl.style.top    = `${top}px`;
  panelEl.style.bottom = `${bottom}px`;
  panelEl.style.left   = `${left}px`;
  panelEl.style.right  = `${right}px`;

  const tab = document.querySelector('#wou-top-bar [data-tab="character"]');
  if (tab) {
    const tabRect = tab.getBoundingClientRect();
    const tabCenterX = tabRect.left + tabRect.width / 2;
    panelEl.style.setProperty("--chr-close-x", `${tabCenterX - left}px`);
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
function rerenderIfOpen() {
  if (_suppressNextRender) { _suppressNextRender = false; return; }
  if (_charRenderPending) return;
  if (!isCharacterOpen()) return;
  _charRenderPending = true;
  requestAnimationFrame(() => {
    _charRenderPending = false;
    if (!isCharacterOpen()) return;
    render();
  });
}

/** World-time tick: refresh only the seconds-based effect-duration chips in
 *  place, leaving the rest of the DOM (and hover/focus state) untouched.  A
 *  chip whose effect has vanished is left as-is — the delete hook will have
 *  fired a real render to remove its row. */
function tickEffectDurations() {
  if (!panelEl || !isCharacterOpen()) return;
  const actor = getAssignedActor();
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
  const actor = getAssignedActor();
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

  const actor = getAssignedActor();
  const html  = actor
    ? renderShell(actor, getDockData(actor))
    : renderEmptyState("No character assigned.");

  /* Skip the rewrite when the output is unchanged — see _lastShellHtml. */
  if (html === _lastShellHtml) return;
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
  /* Never touch the element the user is actively editing — preserves caret,
   * selection, and any uncommitted typed value. */
  if (oldNode === document.activeElement) return;

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
    <button class="wou-chr-close" type="button" data-action="close" title="Collapse">
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
    <button class="wou-chr-close" type="button" data-action="close" title="Collapse">
      <i class="fa-solid fa-chevron-up"></i>
    </button>

    <header class="wou-chr-header">
      <div class="wou-chr-title">Character</div>
      <div class="wou-chr-header-ctrls">
        ${(isVariablePortraitEnabled(actor) && (game.user?.isGM || actor.isOwner))
          ? `<button class="wou-chr-vp-btn" type="button" data-action="variable-portrait" title="Variable portrait"><i class="fa-solid fa-flask-vial"></i></button>`
          : ""}
        ${game.user?.isGM ? renderViewAsPicker() : ""}
      </div>
    </header>

    <nav class="wou-chr-maintabs">
      ${renderMainTab("abilities", "fa-shield-halved", "Abilities")}
      ${renderMainTab("wounds",    "fa-heart-crack",   "Wounds")}
      ${renderMainTab("biography", "fa-book-bookmark", "Biography")}
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
      ${SUB_TABS.map(t => `<button class="wou-chr-subtab${activeSub === t.key ? " is-active" : ""}" type="button" data-action="set-sub" data-sub="${t.key}"><i class="fa-solid ${t.icon}"></i>${escapeText(t.label)}</button>`).join("")}
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
      <div class="wou-chr-portrait-frame">${portraitInner}</div>
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
      ${renderBar("hp",  "Vitality", "fa-heart",      data.hp)}
      ${renderBar("sta", "Stamina",  "fa-wind",       data.sta)}
      ${renderBar("tox", "Toxicity", "fa-flask-vial", data.tox)}
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
        ${data.stress ? renderTracker("stress", "Stress", "fa-brain", data.stress) : ""}
        ${data.adrenaline ? renderTracker("adrenaline", "Adrenaline", "fa-bolt", data.adrenaline) : ""}
        ${renderTracker("shield",     "Shield",      "fa-shield-halved",  data.shield)}
        ${data.focus?.max ? renderTracker("focus", "Focus", "fa-magnifying-glass", data.focus) : ""}
        ${renderTracker("deathSaves", "Death Saves", "fa-skull",          { cur: deathCount, max: 10 }, deathState)}
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
    { key: "mel",  label: "Melee", value: num(ds.meleeBonus),     signed: true,  tip: "Melee damage bonus (system.derivedStats.meleeBonus)" },
    { key: "rec",  label: "REC",   value: num(ds.rec),            tip: "Recovery — HP regained per stabilization cycle" },
    { key: "run",  label: "Run",   value: num(ds.run),            tip: "Run distance per action (SPD × 3)" },
    { key: "leap", label: "Leap",  value: num(ds.leap),           tip: "Leap distance per action (Run ÷ 5)" },
    { key: "enc",  label: "ENC",   value: num(ds.enc),            tip: "Max carrying weight (BODY × 10)" },
    { key: "stun", label: "Stun",  value: num(ds.stun),           tip: "Stun save target (clamped 1–10)" },
    { key: "wt",   label: "WT",    value: num(ds.woundThreshold), tip: "Wound Threshold — HP at which Seriously Wounded penalties kick in" },
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

function renderTracker(kind, label, icon, pool, extraClass = "") {
  /* Prefer the in-flight optimistic value so a mid-burst re-render doesn't
   * snap the visible number back to the actor's last-committed value. */
  const shown = pendingValue(`tracker.${kind}`) ?? pool.cur;
  const maxAttr = pool.max > 0 ? `max="${pool.max}"` : "";
  return `
    <div class="wou-chr-tracker${extraClass ? ` ${extraClass}` : ""}" data-kind="${kind}">
      <span class="wou-chr-tracker-lbl"><i class="fa-solid ${icon}" aria-hidden="true"></i>${escapeText(label)}</span>
      <button class="wou-chr-tracker-step" type="button"
              data-action="bump-tracker" data-tracker="${kind}" data-delta="-1"
              aria-label="Decrease ${escapeAttr(label)}">${"−"}</button>
      <input class="wou-chr-tracker-val"
             type="number"
             min="0" ${maxAttr}
             value="${shown}"
             data-tracker="${kind}"
             aria-label="${escapeAttr(label)}" />
      <button class="wou-chr-tracker-step" type="button"
              data-action="bump-tracker" data-tracker="${kind}" data-delta="+1"
              aria-label="Increase ${escapeAttr(label)}">+</button>
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
const ARMOR_LOC_LABELS = {
  head:     "Head",
  torso:    "Torso",
  leftArm:  "L. Arm",
  rightArm: "R. Arm",
  leftLeg:  "L. Leg",
  rightLeg: "R. Leg",
};

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
              title="Damage ${escapeAttr(ARMOR_LOC_LABELS[loc])} SP by 1"
              aria-label="Damage ${escapeAttr(ARMOR_LOC_LABELS[loc])} SP">-</button>
    </div>`;
  }).join("");
  return `
    <div class="wou-chr-armor">
      <div class="wou-chr-armor-head">Armor</div>
      ${rows}
      ${renderArmorEVFooter(actor)}
    </div>
  `;
}

/* Total encumbrance from equipped armor + equipped weapon-shields, minus
 * any lifepath EV reduction. Mirrors witcher-armor-rules' calcEV (which
 * owns the AE penalties); we compute here so the chip is correct even if
 * that module isn't loaded. */
function calcTotalEV(actor) {
  if (!actor) return 0;
  if (actor.system?.lifepathModifiers?.ignoredArmorEncumbrance) return 0;
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
  return Math.max(0, raw);
}

function renderArmorEVFooter(actor) {
  const ev = calcTotalEV(actor);
  if (ev <= 0) {
    return `<div class="wou-chr-armor-ev is-zero" title="No encumbrance from equipped gear.">
      <span class="wou-chr-armor-ev-lbl">EV</span>
      <span class="wou-chr-armor-ev-val">0</span>
    </div>`;
  }
  const tip  = `Total encumbrance from equipped armor and shields. `
             + `−${ev} to REF and DEX (each floored at 1). `
             + `Per the EV & Magic rule it is also −${ev} to Spell Casting, `
             + `Hex Weaving, and Ritual Crafting rolls.`;
  return `<div class="wou-chr-armor-ev" title="${escapeAttr(tip)}">
    <span class="wou-chr-armor-ev-lbl">EV</span>
    <span class="wou-chr-armor-ev-val">${ev}</span>
    <span class="wou-chr-armor-ev-pen">−${ev} REF · −${ev} DEX · −${ev} magic</span>
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
function statLevelUpCost(currentBase) {
  return Number(currentBase) * 10;
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
               title="Spend ${cost} IP to raise ${escapeAttr(s.label)} ${base} → ${base + 1}"
               aria-label="Level up ${escapeAttr(s.label)}">
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
               title="Spend ${cost} IP to raise Luck max ${base} → ${base + 1}"
               aria-label="Level up Luck">
         <i class="fa-solid fa-arrow-up-from-bracket"></i>
       </button>`
    : "";
  const tip = `Luck pool: ${cur} / ${max}${base !== max ? ` (base ${base})` : ""}.`;
  return `<div class="wou-chr-stat-row is-luck is-luck-pool">
    <span class="wou-chr-stat-abbr">LUCK</span>
    <span class="wou-chr-stat-luck" title="${escapeAttr(tip)}">
      <button class="wou-chr-luck-step" type="button"
              data-action="bump-luck" data-delta="-1"
              aria-label="Spend a point of Luck">−</button>
      <span class="wou-chr-luck-cur">${cur}</span>
      <span class="wou-chr-luck-sep">/</span>
      <span class="wou-chr-luck-max">${max}</span>
      <button class="wou-chr-luck-step" type="button"
              data-action="bump-luck" data-delta="+1"
              aria-label="Restore a point of Luck">+</button>
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
      .map(([skKey, sk]) => {
        const lvl = Number(sk.value) || 0;
        const isProf = sk.category === "profession";
        const labelKey = globalThis.CONFIG?.WITCHER?.skillLabel?.(skKey);
        const name = labelKey ? game.i18n.localize(labelKey) : skKey;
        const isMagic = magicSkillList.includes(skKey);
        const costMul = Number(skillMap[skKey]?.costMultiplier) || 1;
        const cost = Math.max(lvl, 1) * costMul;
        const availableIp = isMagic ? (ip + magicIp) : ip;
        const canLevel = lvl < 10 && availableIp >= cost;
        /* Effective skill rank = base + the per-skill `modifier` (temporary
         * adjustment from items/conditions). The input shows this directly;
         * commit subtracts the same delta before writing so "what you type
         * is what you see". */
        const skillDelta = Number(sk.modifier) || 0;
        const effective  = lvl + skillDelta;
        /* Right-side total = the full roll modifier: effective stat
         * (already includes stat modifiers via .value) + effective skill.
         * The diamond track tracks the BASE skill level — IP progression
         * is tied to purchased levels, not temporary buffs. */
        const total = effective + statVal;
        const inputCls = ["wou-chr-skill-input"];
        if (skillDelta > 0) inputCls.push("is-positive");
        else if (skillDelta < 0) inputCls.push("is-negative");
        const inputTip = skillDelta === 0
          ? `${name}: ${effective}.`
          : `Effective ${name} = ${effective} (base ${lvl}${skillDelta > 0 ? ` + ${skillDelta}` : ` − ${Math.abs(skillDelta)}`}).`;
        const totalTip = `Roll total ${total} = effective stat ${statVal} + effective skill ${effective}.`;
        return `<div class="wou-chr-skill${lvl === 0 ? " is-zero" : ""}${isProf ? " is-prof" : ""}">
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
 * Stats & Skills sub-pane because that's where level-ups happen.  Hides the
 * magic IP chip when the character has none accumulated (non-casters). */
function renderIpBanner(actor) {
  const ip = Number(actor.system?.improvementPoints) || 0;
  const magicIp = Number(actor.system?.magic?.magicImprovementPoints) || 0;
  const magicChip = magicIp > 0
    ? `<span class="wou-chr-ip-chip is-magic"><i class="fa-solid fa-wand-sparkles"></i><span class="wou-chr-ip-lbl">Magic IP</span><span class="wou-chr-ip-val">${magicIp}</span></span>`
    : "";
  return `
    <div class="wou-chr-ip-banner">
      <span class="wou-chr-ip-chip">
        <i class="fa-solid fa-arrow-up-from-bracket"></i>
        <span class="wou-chr-ip-lbl">IP</span>
        <span class="wou-chr-ip-val">${ip}</span>
      </span>
      ${magicChip}
      <span class="wou-chr-ip-hint">Click an empty diamond on a skill to spend</span>
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
                 aria-label="Level up — spend ${cost} IP"
                 title="Spend ${cost} IP to raise to ${lvl + 1}">◇</button>`
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
  if (!prof) return `<div class="wou-chr-empty-tab">No profession item on this character.</div>`;
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
    const isMagic = magicSkillList.includes(skKey);
    const availableIp = isMagic ? (ip + magicIp) : ip;
    const canLevel = !locked && lvl < 10 && availableIp >= cost;
    /* The head wrapper is a div (not a button) because the diamond track
     * inside contains its own <button>s for level-up — nested <button>
     * elements are invalid HTML and the browser auto-closes the outer,
     * detaching the diamond from the header and breaking the grid. */
    return `<div class="wou-chr-prof-box ${accent}${expanded ? " is-expanded" : ""}${lvl === 0 ? " is-zero" : ""}${locked ? " is-locked" : ""}"
                 ${locked ? `title="Unlock by raising the previous skill in this path to level 5"` : ""}>
      <div class="wou-chr-prof-box-head"
           role="button" tabindex="0"
           data-action="toggle-prof-skill" data-skill-key="${escapeAttr(skillKey)}"
           aria-expanded="${expanded ? "true" : "false"}">
        <span class="wou-chr-prof-caret"><i class="fa-solid fa-chevron-${expanded ? "down" : "right"}"></i></span>
        <span class="wou-chr-prof-name">${escapeText(slot.skillName)}</span>
        ${stat && stat !== "NONE" ? `<span class="wou-chr-prof-stat">${escapeText(stat)}</span>` : ""}
        ${locked ? `<span class="wou-chr-prof-lock" title="Locked"><i class="fa-solid fa-lock"></i></span>` : ""}
        ${renderProfDiamonds(lvl, canLevel, skillKey, cost)}
        <span class="wou-chr-prof-lvl">${lvl}</span>
        ${stat && stat !== "NONE"
          ? `<button type="button" class="wou-chr-prof-roll" data-action="roll-prof-skill"
                data-skill-key="${escapeAttr(skillKey)}" title="Roll ${escapeAttr(slot.skillName)}"><i class="fa-solid fa-dice-d10"></i></button>`
          : ""}
      </div>
      ${expanded ? `<div class="wou-chr-prof-def">${def || "<em>No description.</em>"}</div>` : ""}
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
        ${pathCol("1", "Path 1", sys.skillPath1, "path-1")}
        ${pathCol("2", "Path 2", sys.skillPath2, "path-2")}
        ${pathCol("3", "Path 3", sys.skillPath3, "path-3")}
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
                          title="Level up — spend ${cost} IP"
                          aria-label="Level up — spend ${cost} IP">◇</button>`);
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
const MAGIC_SECTIONS = [
  { key: "sign",       label: "Signs",          defaultAccent: "var(--wdm-frost)" },
  { key: "spell",      label: "Spells",         defaultAccent: "#b29ad0" },
  { key: "invocation", label: "Invocations",    defaultAccent: "var(--wdm-gilt-hi, #d8a448)" },
  { key: "gift",       label: "Magical Gifts",  defaultAccent: "var(--wdm-amber)" },
  { key: "hex",        label: "Hexes",          defaultAccent: "#8a4a5a" },
  { key: "ritual",     label: "Rituals",        defaultAccent: "var(--wdm-amber-dim)" },
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
const ELEMENT_LABELS = {
  earth:         "Earth",
  air:           "Air",
  fire:          "Fire",
  water:         "Water",
  mixedelements: "Mixed",
  mixed:         "Mixed",
};

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
const SPELL_LEVEL_LABELS = {
  novice:     "Novice",
  journeyman: "Journ.",
  master:     "Master",
};

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
  const focuses = [1,2,3,4].map(n => actor.system?.[`focus${n}`] ?? { name: "", value: 0 });

  /* Group items by category. */
  const buckets = Object.fromEntries(MAGIC_SECTIONS.map(s => [s.key, []]));
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

  const visibleSections = MAGIC_SECTIONS.filter(sec => {
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
    ${renderMagicHeader(vigor, focuses)}
    ${renderMagicFilterTabs(buckets)}
    <div class="wou-chr-magic-scroll">
      ${sections || `<div class="wou-chr-empty-tab">No spells, hexes, or rituals learned.</div>`}
    </div>
  `;
}

/* Filter tab strip — "All" + every category that has at least one item on
 * this actor.  Empty categories are hidden entirely (no point in a Hexes tab
 * for a character who knows no hexes).  Counts shown next to each label. */
function renderMagicFilterTabs(buckets) {
  const total = Object.values(buckets).reduce((s, list) => s + list.length, 0);
  if (total === 0) return "";

  const tabs = [{ key: "all", label: "All", count: total }];
  for (const sec of MAGIC_SECTIONS) {
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

/* Top strip — Vigor (left) and the 4 focus slots, anchored immediately to
 * the right of vigor.  Mirrors the bars row aesthetic: flat, no card
 * chrome, accent-coloured labels.  Both the focus NAME and VALUE are
 * editable; commits on blur / Enter via onFocusCommit. */
function renderMagicHeader(vigor, focuses) {
  const focusChips = focuses.map((f, i) => {
    const idx   = i + 1;
    const name  = String(f.name ?? "");
    const val   = Number(f.value) || 0;
    const empty = !name.trim() && val === 0;
    return `<span class="wou-chr-focus${empty ? " is-empty" : ""}">
      <input class="wou-chr-focus-name" type="text" value="${escapeAttr(name)}"
             placeholder="Focus ${idx}"
             data-action="set-focus" data-focus-index="${idx}" data-focus-field="name"
             aria-label="Focus ${idx} name" />
      <input class="wou-chr-focus-val" type="number" min="0" step="1" value="${val}"
             data-action="set-focus" data-focus-index="${idx}" data-focus-field="value"
             aria-label="Focus ${idx} value" />
    </span>`;
  }).join("");
  return `
    <div class="wou-chr-magic-header">
      <span class="wou-chr-vigor" data-tooltip="Per-round Vigor threshold — max magic STA cost per round (Core p.38).">
        <span class="wou-chr-vigor-lbl">Vigor</span>
        <span class="wou-chr-vigor-val">${Number(vigor) || 0}</span>
      </span>
      <span class="wou-chr-focuses">${focusChips}</span>
    </div>
    <div class="wou-chr-magic-pin-hint">
      <i class="fa-solid fa-thumbtack"></i>
      <span>Pin a spell to add it to your bottom bar during combat.
            Leave nothing pinned to show every spell.</span>
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
      `<span><b>STA</b> ${escapeText(String(sta))}</span>`,
      (castTime || castTime === 0) ? `<span><b>Cast</b> ${escapeText(String(castTime))}</span>` : "",
      hexRange ? `<span><b>Range</b> ${escapeText(hexRange)}</span>` : "",
      `<span><b>Dur</b> ${escapeText(durLabel)}</span>`,
      defLabel ? `<span class="wou-chr-spell-def"><b>Def</b> ${escapeText(defLabel)}</span>` : "",
      dngLabel ? `<span><b>Danger</b> ${escapeText(dngLabel)}</span>` : "",
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
      ? (sys.variableDC ? `${escapeText(dc)}<span class="wou-chr-spell-var" title="Variable DC">×</span>` : escapeText(dc))
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
      ? `<span class="wou-chr-spell-elem"><b>School</b> ${escapeText(schoolLbl)}</span>` : "";

    meta = [
      `<span><b>STA</b> ${escapeText(String(sta))}</span>`,
      dcStr    ? `<span><b>DC</b> ${dcStr}</span>` : "",
      `<span><b>Prep</b> ${escapeText(prepLbl)}</span>`,
      ritRange ? `<span><b>Range</b> ${escapeText(ritRange)}</span>` : "",
      `<span><b>Dur</b> ${escapeText(durLabel)}</span>`,
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
      ? `${escapeText(String(sta))}<span class="wou-chr-spell-var" title="Variable cost">×</span>`
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
      : "None";

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
      ? `<span class="wou-chr-spell-elem"><b>School</b> ${escapeText(schoolLbl)}</span>` : "";

    meta = [
      `<span><b>STA</b> ${costStr}</span>`,
      (castTime || castTime === 0) ? `<span><b>Cast</b> ${escapeText(String(castTime))}</span>` : "",
      range    ? `<span><b>Range</b> ${escapeText(range)}</span>` : "",
      `<span><b>Dur</b> ${escapeText(durLabel)}</span>`,
      `<span class="wou-chr-spell-def"><b>Def</b> ${escapeText(defLabel)}</span>`,
      schoolChip,
    ].filter(Boolean).join("");

    body = stripHTML(sys.effect ?? "") || stripHTML(sys.description ?? "") || "—";
    levelBadge = levelLbl
      ? `<span class="wou-chr-spell-lvl is-${level}">${escapeText(levelLbl)}</span>`
      : "";
  }

  const pinTitle = pinned
    ? "Pinned — appears in the bottom bar during combat. Click to unpin."
    : "Pin to bottom-bar war mode";

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
  const secondLbl = isHex ? "Requirements to Lift" : "Description";
  const second    = String((isHex ? sys.liftRequirement : sys.description) ?? "").trim();
  if (!effect && !second) return;

  const accent = card.style.getPropertyValue("--spell-accent") || "var(--wdm-amber)";
  const pop = ensureSpellPopup();
  pop.style.setProperty("--spell-accent", accent);

  /* Effect = mechanical text; second block = lore / lift requirements.  Show
   * both when present, effect first since mid-play that's what gets read. */
  const sections = [];
  if (effect) sections.push(`<div class="wou-spell-popup-sec"><div class="wou-spell-popup-sec-lbl">Effect</div><div class="wou-spell-popup-sec-body">${effect}</div></div>`);
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

  pop.style.left = `${left}px`;
  pop.style.top  = `${top}px`;
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
      const actor = getAssignedActor();
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
    { key: "active",   label: "Active Effects",    list: buckets.active   },
    { key: "passive",  label: "Passives",          list: buckets.passive  },
    { key: "temp",     label: "Item Improvements", list: buckets.temp     },
    { key: "inactive", label: "Inactive",          list: buckets.inactive },
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
        <div class="wou-chr-effects-head">Effects</div>
        <div class="wou-chr-eff-empty">No effects.</div>
      </div>
    `;
  }

  return `<div class="wou-chr-effects">${renderedSections}</div>`;
}

/* =========================================================================
   WOUNDS PANE — dedicated top-level tab listing critical wounds in full
   ========================================================================= */

const LEVEL_LABELS = {
  simple:    "Simple",
  complex:   "Complex",
  difficult: "Difficult",
  deadly:    "Deadly",
};
const STATE_LABELS = {
  unstabilized: "Unstabilized",
  stabilized:   "Stabilized",
  treated:      "Treated",
};

const WOUNDS_TIP =
  '<div class="wcu-tip">' +
    '<strong>Critical Wounds</strong>' +
    'A critical hit leaves a lasting wound on top of the damage. Each has a severity and a care state you advance on its card.' +
    '<div class="wcu-tip-row"><span>Unstabilized</span><span>Full penalty, can worsen</span></div>' +
    '<div class="wcu-tip-row"><span>Stabilized</span><span>First Aid halts it</span></div>' +
    '<div class="wcu-tip-row"><span>Treated</span><span>Proper care starts healing</span></div>' +
    '<div class="wcu-tip-flavor">Treated wounds heal over their listed time on their own; Deadly wounds need a Doctor. Severity runs Simple → Complex → Difficult → Deadly.</div>' +
  '</div>';

function woundsHeader() {
  return `<div class="wou-chr-wounds-head">
    <span class="wou-chr-wounds-head-title">Critical Wounds</span>
    <span class="wdm-help-tip" data-tooltip="${escapeAttr(WOUNDS_TIP)}" data-tooltip-direction="DOWN" data-tooltip-class="wou-craft-tip"><i class="fa-solid fa-circle-info"></i></span>
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
        <div>No critical wounds.</div>
        <div class="wou-chr-wounds-empty-sub">The character is whole and intact.</div>
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
  const name        = String(item.name ?? "Critical Wound");
  const level       = String(sys.criticalLevel ?? "simple");
  const state       = String(sys.state ?? "unstabilized");
  const location    = String(sys.location ?? "");
  const days        = Number(sys.healDaysElapsed) || 0;
  const time        = Number(sys.healingTime) || 0;
  const lesser      = !!sys.lesserEffect;
  const effect      = String(sys.activeEffect ?? sys.description ?? "").trim();

  /* Healing chip — only treated, non-deadly wounds run a clock. */
  const healingChip = (state === "treated" && time > 0 && level !== "deadly")
    ? `<span class="wou-chr-wound-healing" title="Days healed / required days for the wound to clear">
         <i class="fa-solid fa-clock-rotate-left"></i>${days}/${time} d
       </span>`
    : "";

  const levelLabel = LEVEL_LABELS[level] ?? level;
  const stateLabel = STATE_LABELS[state] ?? state;
  const locLabel   = location ? location.charAt(0).toUpperCase() + location.slice(1) : "";

  const removeBtn = game.user?.isGM
    ? `<button type="button" class="wou-chr-wound-remove" data-action="remove-crit-wound"
               data-wound-id="${escapeAttr(item.id)}"
               title="Remove critical wound (GM only)" aria-label="Remove critical wound">
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
    <span class="wou-chr-wound-switch" role="group" aria-label="Wound state">
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
    : `<div class="wou-chr-wound-desc is-empty"><em>No effect description recorded for this state.</em></div>`;

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
        ${lesser   ? `<span class="wou-chr-wound-tag is-lesser" title="Lesser-effect variant — halved penalties">Lesser</span>` : ""}
      </span>
      ${removeBtn}
    </header>
    <div class="wou-chr-wound-status">
      ${stateSwitch}
      ${healingChip}
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
  const name = String(item.name ?? "Critical Wound");
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
               title="Remove critical wound (GM only)" aria-label="Remove critical wound">
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
  const name = String(eff.name ?? "Effect");
  /* Disabled (Inactive section) effects get a per-row activate button that
   * flips THIS effect's `disabled` to false — no longer a bulk action. */
  const activateBtn = eff.disabled
    ? `<button type="button" class="wou-chr-eff-activate" data-action="activate-effect" title="Activate">
         <i class="fa-solid fa-bolt"></i>
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
               title="Remove effect (GM only)" aria-label="Remove effect">
         <i class="fa-solid fa-xmark"></i>
       </button>`
    : "";
  return `<div class="wou-chr-eff-row" data-effect-id="${escapeAttr(eff.id)}" data-parent-uuid="${escapeAttr(parentUuid)}" title="${escapeAttr(name)}">
    <img class="wou-chr-eff-icon" src="${escapeAttr(img)}" alt="" />
    <span class="wou-chr-eff-name">${escapeText(name)}</span>
    ${dur ? `<span class="wou-chr-eff-dur">${escapeText(dur)}</span>` : ""}
    ${activateBtn}
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
    age > 0 ? `${age} yrs` : null,
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
    <div class="wou-chr-bio-divider">Race &amp; Profession</div>
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
        : `<div class="wou-chr-race-perk">No racial sections recorded.</div>`);

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
    ? `<div class="wou-chr-race-section-name">Defining Skill</div>
       <div class="wou-chr-race-section-desc">${escapeText(sys.definingSkill.skillName)}</div>` : "";
  const body = (desc + defining) || `<div class="wou-chr-race-perk">No profession details recorded.</div>`;

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
      : `<div class="wou-chr-race-perk">No description recorded.</div>`;
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
    <div class="wou-chr-bio-divider">Perks</div>
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
    bioTextRow ("Gender",             "system.gender",                       String(actor.system?.gender ?? "")),
    bioNumberRow("Age",               "system.general.age",                  Number(general.age) || 0),
    bioHomelandRow(homelandItem, general),
    bioTextRow ("Social standing",    "system.general.socialStanding",       String(general.socialStanding ?? "")),
    bioTextRow ("Reputation",         "system.general.reputation.value",     String(general.reputation?.value ?? "")),
    bioTextRow ("Personality",        "system.general.personality",          String(general.personality ?? "")),
    bioTextRow ("Feelings on people", "system.general.feelingsOnPeople",     String(general.feelingsOnPeople ?? "")),
  ];

  return `
    <div class="wou-chr-bio-divider">Identity &amp; Standing</div>
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
      <div class="wou-chr-bg-key">Homeland</div>
      <div class="wou-chr-bg-val">
        <a class="wou-chr-bg-link" data-action="open-item" data-item-id="${escapeAttr(homelandItem.id)}"
           title="Linked to homeland item — open to edit">
          <i class="fa-solid fa-link"></i>${escapeText(homelandItem.name)}
        </a>
      </div>
    </div>
  `;
  }
  return bioTextRow("Homeland", "system.general.homeland", String(general.homeland ?? ""));
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
         <i class="fa-solid fa-plus"></i> Add event
       </button>`
    : "";

  const body = itemsHtml
    ? `<div class="wou-chr-bg-timeline">${itemsHtml}</div>`
    : `<div class="wou-chr-bg-empty">No life events recorded yet.</div>`;

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
      <span>Defining moments</span>
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
            title="Drag to reorder" aria-label="Drag to reorder this event"></span>
      <input type="text" class="wou-chr-bg-event-title-input"
             placeholder="Event title"
             value="${escapeAttr(e.value)}"
             data-action="edit-life-event-field"
             data-field="value"
             data-life-key="${escapeAttr(e.key)}"
             aria-label="Event title" />
      <div class="wou-chr-bg-event-meta-row">
        <input type="date" class="wou-chr-bg-event-date-input"
               value="${escapeAttr(isIsoDate(e.date) ? e.date : "")}"
               data-action="edit-life-event-field"
               data-field="date"
               data-life-key="${escapeAttr(e.key)}"
               aria-label="Event date" />
        <input type="text" class="wou-chr-bg-event-location-input"
               placeholder="Location"
               value="${escapeAttr(e.location ?? "")}"
               data-action="edit-life-event-field"
               data-field="location"
               data-life-key="${escapeAttr(e.key)}"
               aria-label="Event location" />
      </div>
      <textarea class="wou-chr-bg-event-body-input" rows="2"
                placeholder="What happened…"
                data-action="edit-life-event-field"
                data-field="details"
                data-life-key="${escapeAttr(e.key)}"
                aria-label="Event details">${escapeText(e.details)}</textarea>
    </div>
  `;
}

/* Backstory — system.general.background (HTML).  Editable inline; the
 * commit goes back to the system field, not a module flag. */
function renderBioBackstory(general) {
  const html = String(general.background ?? "").trim();
  return `
    <div class="wou-chr-bio-divider">Backstory</div>
    <div class="wou-chr-bio-editor" contenteditable="true" data-action="edit-bio">${html || "<p>Click here to start writing your character's backstory.</p>"}</div>
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

  /* Stats are read-only displays now — raising a stat goes through the
   * level-up button (data-action="level-up-stat") wired in onClick.  No
   * blur/commit listener needed. */

  /* Skill rank inputs — commit base skill level on blur / Enter. */
  wireOnce('input[data-action="set-skill"]', el => {
    el.addEventListener("blur",    (ev) => onSkillCommit(ev, actor));
    el.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); ev.target.blur(); } });
  });

  /* Bar current-value inputs — commit on blur or Enter (matches journal). */
  wireOnce('input[data-action="set-bar"]', el => {
    el.addEventListener("blur",   (ev) => onBarCommit(ev, actor));
    el.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); ev.target.blur(); } });
  });

  /* Focus name + value inputs (magic header) — same commit pattern as
   * the bar inputs. */
  wireOnce('input[data-action="set-focus"]', el => {
    el.addEventListener("blur",   (ev) => onFocusCommit(ev, actor));
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
    el.addEventListener("wheel", (ev) => onTrackerWheel(ev, actor), { passive: false });
    el.addEventListener("input", onTrackerTyping);
    el.addEventListener("blur",  (ev) => onTrackerBlur(ev, actor));
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); ev.target.blur(); }
    });
  });

  /* Biography editor — save on blur only.  Same reasoning as the journal
   * body: any input-time save triggers a re-render that nukes the cursor. */
  wireOnce('[data-action="edit-bio"]', el => {
    el.addEventListener("blur", (ev) => onBioBlur(ev, actor));
  });

  /* Life event field inputs — commit on blur (or Enter for the
   * single-line inputs; textarea allows Enter as a newline). */
  wireOnce('[data-action="edit-life-event-field"]', el => {
    el.addEventListener("blur", (ev) => onLifeEventCommit(ev, actor));
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
      el.addEventListener("change", (ev) => onBioFieldCommit(ev, actor));
    } else {
      el.addEventListener("blur", (ev) => onBioFieldCommit(ev, actor));
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
      await reorderLifeEvents(actor, fromKey, toKey, dropAbove);
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

function onTrackerTyping(ev) {
  /* Track the in-flight typed value so a re-render mid-type doesn't blow it
   * away.  Crucially does NOT schedule a write — we wait for blur. */
  const kind = ev.currentTarget.dataset.tracker;
  const v = Number(ev.currentTarget.value);
  if (!Number.isFinite(v)) return;
  setPendingValueOnly(`tracker.${kind}`, Math.max(0, Math.floor(v)));
}

function onTrackerBlur(ev, actor) {
  const kind = ev.currentTarget.dataset.tracker;
  const v = Number(ev.currentTarget.value);
  if (!Number.isFinite(v)) return;
  setTrackerAbsolute(actor, kind, Math.max(0, Math.floor(v)));
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
        const res = await actor.castSpell(spell);
        if (!res) return;
        if (res.fullRound) {
          if (typeof actor.recordFullRound === "function") await actor.recordFullRound(`Cast: ${spell.name}`);
        } else if (typeof actor.spendActionSlot === "function") {
          await actor.spendActionSlot(`Cast: ${spell.name}`);
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
    ui.notifications?.warn?.(`${slot?.skillName ?? "This skill"} has no associated stat and can't be rolled.`);
    return;
  }
  if (typeof actor.rollProfessionSkill !== "function") {
    ui.notifications?.error("System's rollProfessionSkill helper missing.");
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
  const isMagic = magicSkillList.includes(skKey);

  const ip      = Number(actor.system?.improvementPoints) || 0;
  const magicIp = Number(actor.system?.magic?.magicImprovementPoints) || 0;

  /* Debit magic IP first for magic skills, then regular IP.  Mirrors
   * WitcherActor.levelUpSkill's policy. */
  const actorUpdate = {};
  let fromMagic = 0;
  if (isMagic && magicIp > 0) {
    fromMagic = Math.min(magicIp, cost);
    actorUpdate["system.magic.magicImprovementPoints"] = magicIp - fromMagic;
    const remaining = cost - fromMagic;
    if (remaining > 0) {
      if (ip < remaining) {
        ui.notifications?.warn?.(`Need ${cost} IP to level — have ${ip + magicIp}.`);
        return;
      }
      actorUpdate["system.improvementPoints"] = ip - remaining;
    }
  } else {
    if (ip < cost) {
      ui.notifications?.warn?.(`Need ${cost} IP to level — have ${ip}.`);
      return;
    }
    actorUpdate["system.improvementPoints"] = ip - cost;
  }

  const skillName = slot.skillName || skKey;
  const label = `${skillName} ${lvl} → ${lvl + 1}${fromMagic > 0 ? " (Magic IP)" : ""}`;
  actorUpdate["system.logs.ipLog"] = appendIpLog(actor, label, -cost);
  await prof.update({ [updatePath]: lvl + 1 });
  await actor.update(actorUpdate);
}

async function enableEffect(actor, effectId) {
  const eff = actor?.effects?.get?.(effectId);
  if (!eff || !eff.disabled) return;
  try {
    await eff.update({ disabled: false });
  } catch (err) {
    console.warn(`${MODULE_ID} | failed to enable effect ${effectId}`, err);
    ui.notifications?.error?.("Couldn't enable effect — see console.");
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
    ui.notifications?.error?.("Couldn't advance wound state — see console.");
  }
}

/* GM-only: remove a critical-wound item from the actor.  Crit wounds are
 * embedded items of type `criticalWound` (not ActiveEffect docs, not
 * entries in system.critWounds), so deletion is a normal item delete. */
async function removeCritWound(actor, woundId) {
  try {
    const item = actor?.items?.get?.(woundId);
    if (!item || item.type !== "criticalWound") {
      ui.notifications?.warn?.("Critical wound not found on this actor.");
      return;
    }
    await item.delete();
  } catch (err) {
    console.warn(`${MODULE_ID} | failed to remove crit wound ${woundId}`, err);
    ui.notifications?.error?.("Couldn't remove critical wound — see console.");
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
      ui.notifications?.warn?.("Effect parent missing — already removed?");
      return;
    }
    await parent.deleteEmbeddedDocuments("ActiveEffect", [effectId]);
  } catch (err) {
    console.warn(`${MODULE_ID} | failed to remove effect ${effectId}`, err);
    ui.notifications?.error?.("Couldn't remove effect — see console.");
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
    ui.notifications?.info?.("That's a lot of defining moments — clear one before adding more.");
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

    /* Debit magic IP first for magic skills, then regular IP. */
    const actorUpdate = {};
    let fromMagic = 0;
    if (isMagic && magicIp > 0) {
      fromMagic = Math.min(magicIp, cost);
      actorUpdate["system.magic.magicImprovementPoints"] = magicIp - fromMagic;
      const remaining = cost - fromMagic;
      if (remaining > 0) {
        if (ip < remaining) {
          ui.notifications?.warn?.(`Need ${cost} IP to level — have ${ip + magicIp}.`);
          return;
        }
        actorUpdate["system.improvementPoints"] = ip - remaining;
      }
    } else {
      if (ip < cost) {
        ui.notifications?.warn?.(`Need ${cost} IP to level — have ${ip}.`);
        return;
      }
      actorUpdate["system.improvementPoints"] = ip - cost;
    }

    const labelKey = globalThis.CONFIG?.WITCHER?.skillLabel?.(key);
    const skillName = labelKey ? game.i18n.localize(labelKey) : key;
    const label = `${skillName} ${lvl} → ${lvl + 1}${fromMagic > 0 ? " (Magic IP)" : ""}`;
    actorUpdate[`system.skills.${statKey}.${key}.value`] = lvl + 1;
    actorUpdate["system.logs.ipLog"] = appendIpLog(actor, label, -cost);
    await actor.update(actorUpdate);
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
      ui.notifications?.warn?.(`Need ${cost} IP to raise ${statKey.toUpperCase()} ${base} → ${base + 1} — have ${ip}.`);
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
  return p ? p.value : undefined;
}

function scheduleBump({ key, delta, currentValue, write, clamp }) {
  const existing = pendingBumps.get(key);
  const cur  = existing ? existing.value : currentValue;
  const next = (clamp ?? ((v) => Math.max(0, v)))(cur + delta);
  if (existing?.timer) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    const final = pendingBumps.get(key)?.value;
    pendingBumps.delete(key);
    if (typeof final === "number") {
      Promise.resolve(write(final)).catch((err) =>
        console.warn(`${MODULE_ID} | bump commit failed for ${key}`, err)
      );
    }
  }, BUMP_DEBOUNCE_MS);
  pendingBumps.set(key, { value: next, timer });
  return next;
}

function trackerConfig(actor, kind) {
  /* All tracker writes (stress/adrenaline/shield/deathSaves) live behind this
   * single config map so wheel, keystroke, and (future) shortcut paths share
   * one source of truth.  Death saves cap at 10 — past 10 the save would auto-
   * fail by Witcher RAW, so we treat 10 as the floor. */
  switch (kind) {
    case "stress":     return {
      currentValue: Number(actor.system?.stress) || 0,
      write: (v) => actor.update({ "system.stress": v }),
      clamp: (v) => Math.max(0, v),
    };
    case "adrenaline": return {
      currentValue: Number(actor.system?.adrenaline?.value) || 0,
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
    default: return null;
  }
}

function bumpTracker(actor, kind, delta) {
  if (!actor || !kind || !delta) return;
  const cfg = trackerConfig(actor, kind);
  if (!cfg) return;
  const next = scheduleBump({ key: `tracker.${kind}`, delta, ...cfg });
  patchInputValue(`.wou-chr-tracker[data-kind="${kind}"] .wou-chr-tracker-val`, next);
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
  const delta   = Number(sk.modifier) || 0;
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

async function onFocusCommit(ev, actor) {
  const idx   = parseInt(ev.currentTarget.dataset.focusIndex, 10);
  const field = ev.currentTarget.dataset.focusField; /* "name" | "value" */
  if (!idx || !field) return;
  const path = `system.focus${idx}.${field}`;
  const prev = foundry.utils.getProperty(actor, path);
  let next;
  if (field === "value") {
    const v = Number(ev.currentTarget.value);
    if (!Number.isFinite(v)) return;
    next = Math.max(0, Math.floor(v));
  } else {
    next = String(ev.currentTarget.value ?? "");
  }
  if (next === prev) return; /* no-op writes thrash the panel */
  await actor.update({ [path]: next });
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
