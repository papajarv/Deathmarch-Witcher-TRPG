/**
 * Bestiary overlay — drops from the top bar's "Bestiary" tab.
 *
 * Layout (per docs/superpowers/specs/2026-05-23-bestiary-design.md):
 *   - Header with title + close chevron
 *   - Left rail: filter chips (All / Pinned / Researched / 12 monster types)
 *                + scrollable entry-card list
 *   - Right pane: detail view, tier-gated content reveal
 *
 * State (pin / research / encounters) is keyed by bestiary-key, resolved by
 * lib/bestiary.js per the design's UUID rules.  GM-only writes; players see
 * the same view minus the edit controls.
 */

import { MODULE_ID, getSetting } from "../setup/settings.js";
import {
  MAX_RESEARCH,
  getViewerCharacter,
  getViewerEntryState,
  getActorEntryState,
  updateActorEntryState,
  bestiaryKeyFor,
  isBestiaryVariant,
  encKey,
  getViewerEncounters,
  getEncounterCount,
  getLastEncounterTime,
  getKillCount,
  getResearchPoints,
  getViewerResearchPoints,
  nextTierCost,
  spendRpToAdvance,
  updateEncounter,
  canAttemptKnowledge,
  recordKnowledgeAttempt,
  setViewerOverride,
  getViewerOverride
} from "../lib/bestiary.js";
import { VIEWER_OVERRIDE_HOOK } from "../lib/actor.js";
import { summarizeEffectModifiers } from "../../sheets/item/base.mjs";
import {
  renderViewAsPicker as renderSharedViewAsPicker,
  wireViewAsPicker
} from "../lib/view-as.js";

const PANEL_ID = "wou-bestiary";

/* Chrome panels the overlay shrinks/expands around — same set inventory uses */
const CHROME_SELECTORS = ["#wou-top-bar", "#wou-dock", "#scene-controls", "#sidebar"];

let panelEl = null;
let hooksWired = false;
let _chromeResizeObs   = null;
let _chromeMutationObs = null;

/* UI state — per session */
let activeFilter = "all";         // "all" | "pinned" | "researched" | <MonsterType>
let activeKey    = null;          // currently-selected entry's bestiary key
let gmReveal     = false;         // GM-only "peek through tier gates" toggle

/* Cached entry list — { key, name, img, type, doc | uuid, isWorld } objects.
 * Refreshed on render; compendium docs loaded lazily once per session. */
let _entries = null;
const _compendiumDocsByPack = new Map(); // packId → Document[] (bulk per-pack cache)
const _compendiumDocCache   = new Map(); // uuid → full doc (per-entry lookup cache)

/* When a player clicks the pencil on an encounter event, we store its id
 * here and re-render so that event renders an inline edit form instead
 * of the normal row. */
let _editingEventId = null;

/* Session-local set of encounter event ids whose note body is collapsed.
 * Only relevant for events with a non-empty note (others have no body to
 * hide).  Default state is expanded; user clicks chevron to hide. */
const _collapsedEvents = new Set();

/* =========================================================================
   PUBLIC API
   ========================================================================= */

export function injectBestiaryPanel() {
  if (document.getElementById(PANEL_ID)) return;
  const el = document.createElement("main");
  el.id = PANEL_ID;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "Bestiary");
  document.body.appendChild(el);
  panelEl = el;

  /* Single click delegate — handles filter chips, card clicks, GM controls.
   * Mirrors the pattern from character.js (one delegate set up at inject
   * time, not per render, so renders can't leak listeners). */
  el.addEventListener("click", onClick);
  /* Shared "View as" picker change + clear-X handling.  Idempotent; flag
   * on the element ensures we don't double-wire across module reloads. */
  wireViewAsPicker(el, () => render());

  if (!hooksWired) {
    /* Re-render when bestiary state, settings, or relevant world data changes.
     * `updateSetting` in V13 passes the Setting document; its `.key` is the
     * full namespaced key ("module.subkey"), so we match either the short
     * subkey or the namespaced form depending on the Foundry version. */
    Hooks.on("updateSetting", (s) => {
      const k = s?.key ?? "";
      if (k.endsWith("bestiary.sourcePacks")) refreshEntriesIfOpen();
    });
    Hooks.on("createActor", (a) => { if (a.type === "monster") refreshEntriesIfOpen(); });
    Hooks.on("updateActor", (a, changes) => {
      if (a.type === "monster") return refreshEntriesIfOpen();
      /* PC actors — re-render when their bestiary flag changes (research
       * points, knowledge reveals, kills, etc.).  Cheap path: just check
       * for any flag write under our module. */
      if (a.type === "character" && changes?.flags?.[MODULE_ID]) rerenderIfOpen();
    });
    Hooks.on("deleteActor", (a) => { if (a.type === "monster") refreshEntriesIfOpen(); });

    /* Encounter auto-tracking is currently OFF — research tier is
     * GM-set via the star buttons only. */

    window.addEventListener("resize", positionBounds, { passive: true });
    /* Foundry's collapseSidebar hook fires immediately when the right
     * sidebar expands/collapses — gives us a deterministic reposition
     * even if the chrome MutationObserver misfires.  rAF defers so the
     * sidebar's width has settled. */
    Hooks.on("collapseSidebar", () => requestAnimationFrame(positionBounds));
    /* GM picked a different "view as" target in another tab — re-render
     * so the bestiary swaps to that PC's research/encounter view. */
    Hooks.on(VIEWER_OVERRIDE_HOOK, () => rerenderIfOpen());
    wireChromeObservers();
    hooksWired = true;
  }
}

export async function toggleBestiary() {
  if (!panelEl) injectBestiaryPanel();
  const willOpen = !panelEl.classList.contains("is-open");
  await setBestiaryOpen(willOpen);
}

export async function setBestiaryOpen(open) {
  if (!panelEl) injectBestiaryPanel();
  if (open) {
    /* Single drop-down at a time — mirror the cooperation pattern other
     * panels use. */
    closeOtherOverlays();
    positionBounds();
    await render();
    panelEl.classList.add("is-open");
    document.body.classList.add("wou-bestiary-open");
    syncTopbarTab(true);
  } else {
    panelEl.classList.remove("is-open");
    document.body.classList.remove("wou-bestiary-open");
    syncTopbarTab(false);
  }
}

export function isBestiaryOpen() {
  return !!panelEl?.classList.contains("is-open");
}

/* =========================================================================
   POSITIONING + CHROME COOP
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
  const bottom =  dock                  ? Math.max(0, H - dock.getBoundingClientRect().top)  : 0;
  const left   = (leftOpen   && leftbar)? Math.max(0, leftbar.getBoundingClientRect().right) : 0;
  const right  = (rightOpen  && sidebar)? Math.max(0, W - sidebar.getBoundingClientRect().left) : 0;

  panelEl.style.top    = `${top}px`;
  panelEl.style.bottom = `${bottom}px`;
  panelEl.style.left   = `${left}px`;
  panelEl.style.right  = `${right}px`;

  const tab = document.querySelector('#wou-top-bar [data-tab="bestiary"]');
  if (tab) {
    const tabRect = tab.getBoundingClientRect();
    const tabCenterX = tabRect.left + tabRect.width / 2;
    panelEl.style.setProperty("--bst-close-x", `${tabCenterX - left}px`);
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
  /* transitionend + animationend on chrome elements — without these,
   * positionBounds gets called WHILE the sidebar is mid-slide and reads
   * an intermediate sidebar.left, then never re-fires once it settles.
   * Mirror of inventory.js's wireChromeObservers. */
  for (const sel of CHROME_SELECTORS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    el.addEventListener("transitionend", reposition);
    el.addEventListener("animationend",  reposition);
  }
}

function closeOtherOverlays() {
  /* Each panel checks its own body class so we only call the toggle for
   * the ones currently open. */
  const close = async (cls, modPath, exportName) => {
    if (!document.body.classList.contains(cls)) return;
    try {
      const mod = await import(modPath);
      mod[exportName]?.(false);
    } catch {}
  };
  close("wou-inventory-open", "./inventory.js", "setInventoryOpen");
  close("wou-journal-open",   "./journal.js",   "setJournalOpen");
  close("wou-crafting-open",  "./crafting.js",  "setCraftingOpen");
  close("wou-character-open", "./character.js", "setCharacterOpen");
  close("wou-map-open",       "./map.js",       "setMapOpen");
}

function syncTopbarTab(on) {
  const tab = document.querySelector('#wou-top-bar [data-tab="bestiary"]');
  tab?.classList.toggle("is-active", on);
}

/* Coalesce: many hooks per tick → 1 render per animation frame, and
 * only when the bestiary panel is open. */
let _bestiaryRenderPending = false;
function rerenderIfOpen() {
  if (_bestiaryRenderPending) return;
  if (!isBestiaryOpen()) return;
  _bestiaryRenderPending = true;
  requestAnimationFrame(() => {
    _bestiaryRenderPending = false;
    if (!isBestiaryOpen()) return;
    render();
  });
}
function refreshEntriesIfOpen() { _entries = null; rerenderIfOpen(); }

/* =========================================================================
   ENTRY LIST — merge world monsters + configured compendium packs
   ========================================================================= */

export async function loadEntries() {
  if (_entries) return _entries;
  const map = new Map(); // key → entry

  /* World monsters — only those the GM has explicitly opted into the
   * bestiary via the "Bestiary variant" pill.  Imported + tweaked actors
   * still show their COMPENDIUM card (canonical reference data); homebrew
   * world monsters don't appear unless you opt them in.  This keeps the
   * Actors tab from spilling into the bestiary. */
  for (const actor of (game.actors?.contents ?? [])) {
    if (actor.type !== "monster") continue;
    if (!isBestiaryVariant(actor)) continue;
    const key = bestiaryKeyFor(actor);
    if (!key) continue;
    map.set(key, {
      key,
      name: actor.name,
      img:  actor.img,
      type: monsterCategory(actor),
      uuid: actor.uuid,
      isWorld: true,
      doc: actor
    });
  }

  /* Compendium packs configured via setting.  We use pack.getDocuments()
   * (one bulk fetch per pack, cached for the session) instead of getIndex
   * because V13's index projection wasn't reliably surfacing
   * `_stats.compendiumSource` — and we NEED that to collapse derivative
   * packs (e.g. a world.monstrum cloned from wtrpg-complete-compendium.bestiary)
   * onto the same card as their upstream lineage, since bestiaryKeyFor()
   * resolves dragged-in world actors to that same upstream uuid. */
  const packIds = getSetting("bestiary.sourcePacks") ?? [];
  for (const packId of packIds) {
    const pack = game.packs?.get(packId);
    if (!pack) continue;
    let docs = _compendiumDocsByPack.get(packId);
    if (!docs) {
      try {
        docs = await pack.getDocuments();
        _compendiumDocsByPack.set(packId, docs);
      } catch (err) {
        console.warn(`[witcher-ttrpg-death-march] bestiary: failed to load pack ${packId}`, err);
        continue;
      }
    }
    for (const doc of docs) {
      if (doc.type !== "monster") continue;
      const uuid = doc.uuid;
      const upstream = doc._stats?.compendiumSource;
      const key = upstream || uuid;
      if (map.has(key)) continue; // shadowed by world actor or earlier pack
      /* Pre-populate the per-uuid doc cache so ensureFullDoc skips its
       * fromUuid round-trip later. */
      _compendiumDocCache.set(uuid, doc);
      map.set(key, {
        key,
        name: doc.name,
        img:  doc.img,
        type: String(doc.system?.category ?? ""),
        uuid,
        isWorld: false,
        doc
      });
    }
  }

  _entries = [...map.values()];
  return _entries;
}

/** Witcher monster category lives on `system.category` (Necrophage / Vampire
 *  / Beast / etc.).  Foundry's `actor.type` is the document subtype
 *  ("monster") and is the same for every entry. */
function monsterCategory(actor) {
  const c = actor?.system?.category;
  return typeof c === "string" ? c : "";
}

/** Lazy-load the full document for an entry.  World actors already have
 *  `doc`; compendium entries get loaded once + cached.  Returns null on
 *  failure (missing pack, bad uuid, etc). */
async function ensureFullDoc(entry) {
  if (entry?.doc) return entry.doc;
  if (!entry?.uuid) return null;
  /* Cache hit: assign to entry.doc so the render path (which reads
   * entry.doc, not the return value) actually sees the doc. Forgetting
   * this is what caused detail panes to stick on "Loading…" forever
   * after the first refresh. */
  if (_compendiumDocCache.has(entry.uuid)) {
    entry.doc = _compendiumDocCache.get(entry.uuid);
    return entry.doc;
  }
  try {
    const doc = await fromUuid(entry.uuid);
    if (doc) _compendiumDocCache.set(entry.uuid, doc);
    entry.doc = doc ?? entry.doc;
    return doc ?? null;
  } catch (err) {
    console.warn("[witcher-ttrpg-death-march] bestiary: fromUuid failed", entry.uuid, err);
    return null;
  }
}

/* =========================================================================
   RENDER  (skeleton — filled out by next tasks)
   ========================================================================= */

async function render() {
  if (!panelEl) return;
  /* Capture scroll so editing / RP-spending / pin-toggling doesn't snap
   * the detail pane (or the left list) back to the top.  Restored after
   * the innerHTML swap below. */
  const prevDetailScroll = panelEl.querySelector(".wou-bst-detail")?.scrollTop ?? 0;
  const prevListScroll   = panelEl.querySelector(".wou-bst-list")?.scrollTop   ?? 0;

  const entries = await loadEntries();
  const visible = applyFilter(entries, activeFilter);
  /* If selection got dropped (entry removed, key changed), clear it. */
  if (activeKey && !entries.some(e => e.key === activeKey)) activeKey = null;

  /* If an entry is selected, ensure its full doc is loaded before rendering
   * the detail body — either because research has unlocked body content, or
   * because the GM has Bypass on and expects to see everything. */
  if (activeKey) {
    const entry = entries.find(e => e.key === activeKey);
    const s = getViewerEntryState(activeKey);
    const peek = game.user?.isGM && gmReveal;
    if (entry && !entry.doc && (s.research > 0 || peek)) {
      await ensureFullDoc(entry);
    }
  }

  panelEl.innerHTML = renderShell(visible, entries);

  /* Restore scroll positions after the DOM swap. */
  const detailEl = panelEl.querySelector(".wou-bst-detail");
  if (detailEl) detailEl.scrollTop = prevDetailScroll;
  const listEl   = panelEl.querySelector(".wou-bst-list");
  if (listEl)   listEl.scrollTop   = prevListScroll;
}

/* Hover help on the bestiary header — roughly how monster research works.
 * Themed via Foundry's #tooltip (wou-craft-tip), same pattern as the inventory
 * combat-reach tip. */
const RESEARCH_TIP =
  '<div class="wcu-tip">' +
    '<strong>Researching Monsters</strong>' +
    'Study a beast to unlock its entry tier by tier. Earn Research Points by encountering, observing and dissecting it, then spend RP to unlock the next tier.' +
    '<div class="wcu-tip-row"><span>Tier 1</span><span>Reveals its portrait</span></div>' +
    '<div class="wcu-tip-row"><span>Tier 2</span><span>Name &amp; monster type</span></div>' +
    '<div class="wcu-tip-row"><span>Higher tiers</span><span>Lore, combat &amp; weaknesses</span></div>' +
    '<div class="wcu-tip-flavor">Each character keeps their own research — what one witcher knows, another may not.</div>' +
  '</div>';

function renderShell(visible, all) {
  /* Close button rendered LAST so it doesn't disrupt grid auto-flow on the
   * panel (even though it's absolute-positioned and shouldn't participate,
   * putting it last is defensive belt-and-braces — character.html mockup
   * does this too). */
  const isGM = game.user?.isGM;
  return `
    <header class="wou-bst-header">
      <div class="wou-bst-title-stack">
        <h2 class="wou-bst-title">Bestiary
          <span class="wdm-help-tip" data-tooltip="${escapeAttr(RESEARCH_TIP)}" data-tooltip-direction="DOWN" data-tooltip-class="wou-craft-tip"><i class="fa-solid fa-circle-info"></i></span>
        </h2>
        <span class="wou-bst-count">${all.length} entries</span>
      </div>
      <div class="wou-bst-meta">
        ${isGM ? `<button class="wou-bst-bypass${gmReveal ? " is-on" : ""}" type="button" data-action="toggle-reveal" title="Bypass tier gating — see all info regardless of research level. Session-only, GM-only."><i class="fa-solid ${gmReveal ? "fa-eye" : "fa-eye-slash"}"></i><span>GM Overlay</span><span class="wou-bst-bypass-state">${gmReveal ? "ON" : "OFF"}</span></button>` : ""}
        ${isGM ? `<button class="wou-bst-populate" type="button" data-action="populate" title="Choose which compendium packs feed the bestiary">Populate</button>` : ""}
        ${isGM && gmReveal ? renderBestiaryViewAsPicker() : ""}
        ${isGM && gmReveal ? `<button class="wou-bst-gm-destructive" type="button" data-action="wipe-research" title="Wipe all PCs' research progress (research tier + RP) for every entry"><i class="fa-solid fa-flask"></i><span>Wipe Research</span></button>` : ""}
        ${isGM && gmReveal ? `<button class="wou-bst-gm-destructive" type="button" data-action="wipe-encounters" title="Wipe all PCs' encounter logs for every entry"><i class="fa-solid fa-paw"></i><span>Wipe Encounters</span></button>` : ""}
      </div>
    </header>

    <div class="wou-bst-body">
      <section class="wou-bst-left">
        ${renderFilterChips(all)}
        <div class="wou-bst-list">
          ${visible.length
            ? visible.map(renderCard).join("")
            : `<div class="wou-bst-empty">No entries match this filter.</div>`}
        </div>
      </section>

      <div class="wou-bst-divider"></div>

      <section class="wou-bst-detail" data-bind="detail">
        ${activeKey ? renderDetail(activeKey, all) : `<div class="wou-bst-detail-empty">Select an entry to view details.</div>`}
      </section>
    </div>

    <button class="wou-bst-close" type="button" data-action="close" title="Collapse">
      <i class="fa-solid fa-chevron-up"></i>
    </button>
  `;
}

/* GM "View as" picker — shown only when GM Overlay is ON.  Delegates to
 * the shared lib helper so the bestiary's picker shares chrome (and the
 * one-click clear-X) with the inventory / character / journal pickers.
 * The shared state lives in lib/actor.js, so picking a target here flows
 * into every other tab. */
function renderBestiaryViewAsPicker() {
  return renderSharedViewAsPicker({ defaultLabel: "Aggregated" });
}

/* Filter chip row — All / Pinned / Researched / monster types present in
 * the entry list (we don't show empty type chips). */
/* Keyed by the CANONICAL category value stored on system.category
 * (lowercase camelCase — see MONSTER_TYPES in config.mjs), NOT the PascalCase
 * i18n suffix. monsterCategory() and applyFilter() both compare against this
 * stored value, so the keys must match it exactly or no type chips appear. */
const MONSTER_TYPE_META = {
  humanoid:   { icon: "fa-user",     label: "Humanoid" },
  necrophage: { icon: "fa-skull",    label: "Necrophage" },
  specter:    { icon: "fa-ghost",    label: "Specter" },
  beast:      { icon: "fa-paw",      label: "Beast" },
  cursedOne:  { icon: "fa-moon",     label: "Cursed One" },
  hybrid:     { icon: "fa-crow",     label: "Hybrid" },
  insectoid:  { icon: "fa-spider",   label: "Insectoid" },
  elementa:   { icon: "fa-cube",     label: "Elementa" },
  relict:     { icon: "fa-tree",     label: "Relict" },
  ogroid:     { icon: "fa-mountain", label: "Ogroid" },
  draconid:   { icon: "fa-dragon",   label: "Draconid" },
  vampire:    { icon: "fa-droplet",  label: "Vampire" }
};

function renderFilterChips(all) {
  /* GMs see chips for every type present in the data — they know what's
   * out there.  Players only see chips for types their viewer-character
   * has actually researched (at least one entry of that type with research
   * > 0); else the chip itself would tell them "there's a Vampire in this
   * campaign". */
  const isGM = game.user?.isGM;
  const revealedTypes = new Set();
  for (const e of all) {
    if (!e.type) continue;
    if (isGM || (getViewerEntryState(e.key).research ?? 0) > 0) revealedTypes.add(e.type);
  }

  const fixed = [
    { id: "all",        label: "All",        icon: "fa-layer-group" },
    { id: "pinned",     label: "Pinned",     icon: "fa-thumbtack" },
    { id: "researched", label: "Researched", icon: "fa-book-skull" },
  ];
  const typeChips = Object.keys(MONSTER_TYPE_META)
    .filter(t => revealedTypes.has(t))
    .map(t => ({ id: t, label: MONSTER_TYPE_META[t].label, icon: MONSTER_TYPE_META[t].icon }));
  return `
    <nav class="wou-bst-subnav">
      ${[...fixed, ...typeChips].map(c =>
        `<button class="wou-bst-chip${activeFilter === c.id ? " is-active" : ""}"
                 type="button" data-action="set-filter" data-filter="${c.id}">
           <i class="fa-solid ${c.icon}"></i>${escapeText(c.label)}
         </button>`
      ).join("")}
    </nav>
  `;
}

function applyFilter(entries, filter) {
  /* Per-character: filter + sort use the viewer's bestiary state. */
  const stateFor = (key) => getViewerEntryState(key);
  let list = entries;
  if (filter === "pinned")          list = list.filter(e => stateFor(e.key).pinned);
  else if (filter === "researched") list = list.filter(e => stateFor(e.key).research > 0);
  else if (filter !== "all")        list = list.filter(e => e.type === filter);

  return list.slice().sort((a, b) => {
    const pa = stateFor(a.key).pinned ? 0 : 1;
    const pb = stateFor(b.key).pinned ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return a.name.localeCompare(b.name);
  });
}

function renderCard(entry) {
  const s = getViewerEntryState(entry.key);
  /* Tier-gated reveal:
   *   0 → silhouette + ??? name + no meta
   *   1 → image only (still ??? name + no meta)
   *   2 → image + name + category
   *   3+ → same card (additional tiers show in the detail pane, not here)
   * GM only sees through this when gmReveal (the header "Reveal" peek toggle)
   * is on — otherwise the GM sees the same blackout players see. */
  const peek = game.user?.isGM && gmReveal;
  const showImage = peek || s.research >= 1;
  const showName  = peek || s.research >= 2;
  const showType  = peek || s.research >= 2;

  const thumb = (showImage && entry.img)
    ? `<img src="${escapeAttr(entry.img)}" alt="" />`
    : `<i class="fa-solid fa-question"></i>`;
  const stars = renderStars(s.research);
  const isActive = entry.key === activeKey;
  const isPinned = s.pinned;
  const encCount = getEncounterCount(entry.key);
  const lastSeen = getLastEncounterTime(entry.key);
  const encMeta = encCount > 0
    ? ` · ${encCount} encounter${encCount === 1 ? "" : "s"}${lastSeen ? ` · last ${escapeText(formatWorldTime(lastSeen))}` : ""}`
    : "";
  const typePart = showName
    ? escapeText(showType ? (entry.type || "—") : "")
    : (encCount > 0 ? `<em>???</em>` : `<em>Unresearched</em>`);
  const subline = `${typePart}${encMeta}`;
  return `
    <button class="wou-bst-card${isActive ? " is-active" : ""}${isPinned ? " is-pinned" : ""}"
            type="button" data-action="select-entry" data-key="${escapeAttr(entry.key)}">
      <span class="wou-bst-thumb">${thumb}</span>
      <span class="wou-bst-text">
        <span class="wou-bst-name">${escapeText(showName ? entry.name : "???")}</span>
        <span class="wou-bst-card-meta">${subline}</span>
      </span>
      <span class="wou-bst-stars">${stars}</span>
    </button>
  `;
}

function renderStars(level) {
  let html = "";
  for (let i = 1; i <= MAX_RESEARCH; i++) {
    html += `<span class="wou-bst-star${i <= level ? " is-on" : ""}">★</span>`;
  }
  return html;
}

function renderDetail(key, all) {
  const entry = all.find(e => e.key === key);
  if (!entry) return `<div class="wou-bst-detail-empty">Entry not found.</div>`;
  const s = getViewerEntryState(key);
  const peek = game.user?.isGM && gmReveal;
  const showImage = peek || s.research >= 1;
  const showName  = peek || s.research >= 2;
  const showType  = peek || s.research >= 2;
  const encCount  = getEncounterCount(key);
  const killCount = getKillCount(key);
  return `
    <div class="wou-bst-detail-head">
      <div class="wou-bst-detail-portrait-col">
        <div class="wou-bst-detail-portrait">${entry.img && showImage ? `<img src="${escapeAttr(entry.img)}" alt="" />` : `<i class="fa-solid fa-question"></i>`}</div>
        <div class="wou-bst-detail-counters">
          <div class="wou-bst-counter">
            <span class="wou-bst-counter-v">${encCount}</span>
            <span class="wou-bst-counter-k">Encounters</span>
          </div>
          <div class="wou-bst-counter">
            <span class="wou-bst-counter-v">${killCount}</span>
            <span class="wou-bst-counter-k">Confirmed Kills</span>
          </div>
        </div>
      </div>
      <div class="wou-bst-detail-id">
        <div class="wou-bst-detail-name">${escapeText(showName ? entry.name : "???")}</div>
        <div class="wou-bst-detail-type">${escapeText(showType ? (entry.type || "") : "")}</div>
        ${renderDetailControls(key, s)}
      </div>
    </div>
    <div class="wou-bst-detail-body">${renderDetailTierBody(entry, peek ? { ...s, research: MAX_RESEARCH } : s)}${renderDissectionFacts(entry)}${renderEncounterTimeline(key)}</div>
  `;
}

/* Dissection facts — combat / stats / skills learned from autopsies. Reads
 * the viewer's bestiary flag (knowledge written by chrome/dissect.js). */
function renderDissectionFacts(entry) {
  const viewer = getViewerCharacter();
  if (!viewer) return "";
  /* Flag storage encodes dots in the key (UUIDs are dot-heavy → would be
   * expanded by Foundry's expandObject). Match the encoded form here. */
  const flagEntry = viewer.flags?.[MODULE_ID]?.bestiary?.[encKey(entry.key)] ?? {};
  const facts = Array.isArray(flagEntry?.dissection?.facts) ? flagEntry.dissection.facts : [];
  const mutagenRevealed = !!flagEntry?.dissection?.mutagenRevealed;
  // The Autopsy section also carries the extracted mutagen — which is revealed
  // by extraction, NOT dissection — so it must render even with zero dissection
  // facts. Only bail when there's nothing on either track.
  if (!facts.length && !mutagenRevealed) return "";

  /* Look up the monster doc so we can resolve fact ids to actual values.
   * The entry.uuid is the canonical doc UUID. */
  const monster = fromUuidSync(entry.uuid, { strict: false });
  if (!monster) return "";

  const set = new Set(facts);
  const weaponBlock  = renderKnownWeapons(monster, set);
  const statsBlock   = renderKnownStats(monster, set);
  const skillsBlock  = renderKnownSkills(monster, set);
  const mutagenBlock = mutagenRevealed ? renderKnownMutagen(monster) : "";

  if (!weaponBlock && !statsBlock && !skillsBlock && !mutagenBlock) return "";

  return `
    <section class="wou-bst-tier-block wou-bst-dissect-block">
      <h3 class="wou-bst-tier-head">Autopsy notes</h3>
      ${mutagenBlock}${weaponBlock}${statsBlock}${skillsBlock}
    </section>
  `;
}

function renderKnownMutagen(monster) {
  const uuid = monster?.system?.mutagen?.uuid;
  if (!uuid) return "";
  const mut = fromUuidSync(uuid, { strict: false });
  if (!mut) return "";
  /* The mechanical effect is the mutagen's Active-Effect modifiers (e.g.
   * "+3 Melee") — the same list the mutagen sheet's display view shows. The
   * item's `system.description` is its flavour text. Show both. */
  const mods = summarizeEffectModifiers(mut);
  const desc = String(mut.system?.description ?? "").trim();
  const descHtml = desc ? `<div class="wou-bst-mutagen-desc">${escapeText(desc)}</div>` : "";
  const effectHtml = mods.length
    ? `<ul class="wou-bst-mutagen-mods">${mods.map(m =>
        `<li><span class="val">${escapeText(m.value)}</span> <span class="lbl">${escapeText(m.label)}</span></li>`).join("")}</ul>`
    : "";
  const bodyHtml = (descHtml || effectHtml)
    ? `${descHtml}${effectHtml}`
    : `<div class="wou-bst-mutagen-effect" style="opacity:0.6;font-style:italic;">No effect recorded.</div>`;
  return `<div class="wou-bst-dissect-group">
    <div class="wou-bst-dissect-group-head"><i class="fa-solid fa-flask-vial"></i> Mutagen</div>
    <div class="wou-bst-mutagen-card">
      <img class="wou-bst-mutagen-img" src="${escapeAttr(mut.img || "icons/svg/aura.svg")}" alt="" />
      <div class="wou-bst-mutagen-text">
        <div class="wou-bst-mutagen-name">${escapeText(mut.name)}</div>
        ${mut.system?.type ? `<div class="wou-bst-mutagen-type">${escapeText(mut.system.type)}</div>` : ""}
        ${bodyHtml}
      </div>
    </div>
  </div>`;
}

function renderKnownWeapons(monster, knownSet) {
  const rows = Array.isArray(monster.system?.combat?.attacks) ? monster.system.combat.attacks : [];
  const attacks = rows
    .map((atk, idx) => {
      const know = {
        name:    knownSet.has(`attack:${idx}:name`),
        damage:  knownSet.has(`attack:${idx}:damage`),
        effect:  knownSet.has(`attack:${idx}:effect`),
        rof:     knownSet.has(`attack:${idx}:rof`),
        qualities: (Array.isArray(atk?.qualities) ? atk.qualities : [])
          .map((key, qidx) => ({ qidx, key, known: knownSet.has(`attack:${idx}:quality:${qidx}`) }))
          .filter(x => x.known)
      };
      const anyKnown = know.name || know.damage || know.effect || know.rof || know.qualities.length > 0;
      if (!anyKnown) return null;
      return { atk, know };
    })
    .filter(Boolean);

  if (!attacks.length) return "";

  return `<div class="wou-bst-dissect-group">
    <div class="wou-bst-dissect-group-head"><i class="fa-solid fa-khanda"></i> Attacks</div>
    <ul class="wou-bst-dissect-list">
      ${attacks.map(({ atk, know }) => {
        const name   = know.name   ? escapeText(atk.name || "Attack") : `<em>unknown attack</em>`;
        const dmg    = know.damage ? `<span class="wou-bst-dissect-tag">DMG ${escapeText(String(atk.damage ?? "?"))}</span>` : "";
        const effect = know.effect ? `<span class="wou-bst-dissect-tag">${escapeText(String(atk.effect ?? "?"))}</span>` : "";
        const rof    = know.rof    ? `<span class="wou-bst-dissect-tag">ROF ${escapeText(String(atk.rof ?? "?"))}</span>` : "";
        const quals  = know.qualities.map(x =>
          `<span class="wou-bst-dissect-tag is-quality">${escapeText(qualityLabelFor(x.key, atk.qualityValues))}</span>`
        ).join("");
        return `<li><span class="wou-bst-dissect-name">${name}</span>${dmg}${effect}${rof}${quals}</li>`;
      }).join("")}
    </ul>
  </div>`;
}

function qualityLabelFor(key, qualityValues) {
  if (!key) return "?";
  const catalog = CONFIG.WITCHER?.weapon?.qualities ?? {};
  const entry = catalog[key];
  const label = entry?.label ? game.i18n.localize(entry.label) : String(key);
  const val = qualityValues?.[key];
  if (val != null && String(val).trim()) {
    const suffix = entry?.param?.suffix ?? "";
    return `${label} ${val}${suffix}`;
  }
  return label;
}

function renderKnownStats(monster, knownSet) {
  const out = [];
  for (const [k, det] of Object.entries(monster.system?.stats ?? {})) {
    if (!knownSet.has(`stat:${k}`)) continue;
    out.push({ label: `${k.toUpperCase()}`, val: det?.value ?? "?" });
  }
  for (const [k, det] of Object.entries(monster.system?.derivedStats ?? {})) {
    if (!knownSet.has(`derived:${k}`)) continue;
    const lbl = String(k).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\b\w/g, c => c.toUpperCase());
    /* hp/sta are pools ({value,max}); the rest are bare numbers/strings. */
    const val = (det !== null && typeof det === "object") ? (det.value ?? "?") : (det ?? "?");
    out.push({ label: lbl, val });
  }
  if (!out.length) return "";
  return `<div class="wou-bst-dissect-group">
    <div class="wou-bst-dissect-group-head"><i class="fa-solid fa-chart-simple"></i> Stats</div>
    <ul class="wou-bst-dissect-list wou-bst-dissect-grid">
      ${out.map(s => `<li><span class="wou-bst-dissect-name">${escapeText(s.label)}</span><span class="wou-bst-dissect-tag">${escapeText(String(s.val))}</span></li>`).join("")}
    </ul>
  </div>`;
}

function renderKnownSkills(monster, knownSet) {
  const out = [];
  for (const factId of knownSet) {
    if (!factId.startsWith("skill:")) continue;
    const [statKey, skillKey] = factId.slice("skill:".length).split(".");
    const sk = monster.system?.skills?.[statKey]?.[skillKey];
    if (!sk) continue;
    const lbl = String(skillKey).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\b\w/g, c => c.toUpperCase());
    out.push({ label: lbl, val: sk?.value ?? "?", stat: statKey.toUpperCase() });
  }
  if (!out.length) return "";
  return `<div class="wou-bst-dissect-group">
    <div class="wou-bst-dissect-group-head"><i class="fa-solid fa-graduation-cap"></i> Skill ranks</div>
    <ul class="wou-bst-dissect-list">
      ${out.map(s => `<li><span class="wou-bst-dissect-name">${escapeText(s.label)} <span style="opacity:0.55;font-size:0.85em;">(${escapeText(s.stat)})</span></span><span class="wou-bst-dissect-tag">${escapeText(String(s.val))}</span></li>`).join("")}
    </ul>
  </div>`;
}

/* Encounter timeline — "The Witcher's Path".  Always visible from T0:
 * even an anonymous entry shows what fights you've been in (you remember
 * the fight, you just don't yet know what the creature was). */
function renderEncounterTimeline(key) {
  const events = getViewerEncounters(key);
  if (!events.length) return "";
  const viewer = getViewerCharacter();
  const canEdit = !!viewer || !!game.user?.isGM;
  /* Most-recent first.  Primary key worldTime DESC; tiebreak by createdAt
   * (wall-clock at insert) so fights that share a worldTime — e.g. the
   * calendar didn't advance between combats — still order newest-on-top. */
  const sorted = events.slice().sort((a, b) => {
    const dt = (b.worldTime ?? 0) - (a.worldTime ?? 0);
    if (dt !== 0) return dt;
    return (b.createdAt ?? 0) - (a.createdAt ?? 0);
  });
  const rows = sorted.map(ev => {
    if (canEdit && ev.id === _editingEventId) return renderEncounterEditForm(ev, key);
    const title = escapeText(ev.title || ev.sceneName || "Encounter");
    const date  = `${escapeText(formatWorldTime(ev.worldTime))} · ${escapeText(formatRelative(ev.worldTime))}`;
    const hasNote = !!String(ev.note ?? "").trim();
    const collapsed = hasNote && _collapsedEvents.has(ev.id);
    const noteHtml = hasNote ? `<span>${escapeText(ev.note)}</span>` : "";
    const outcomeHtml = renderOutcomeChip(ev.outcome);
    /* When there's no note text, outcome is the only body content — always
     * keep it visible.  When a note IS present and the user collapsed it,
     * the whole body row hides. */
    const body = [outcomeHtml, noteHtml].filter(Boolean).join(" ");
    const showBody = body && (!hasNote || !collapsed);
    /* Chevron — only rendered when the event actually has a note to hide. */
    const chevronBtn = hasNote
      ? `<button class="wou-bst-event-toggle" type="button"
                 data-action="toggle-event-collapse"
                 data-event-id="${escapeAttr(ev.id)}"
                 title="${collapsed ? "Expand note" : "Collapse note"}">
           <i class="fa-solid ${collapsed ? "fa-chevron-right" : "fa-chevron-down"}"></i>
         </button>`
      : "";
    const editBtn = canEdit
      ? `<button class="wou-bst-event-edit-btn" type="button"
                 data-action="edit-encounter"
                 data-event-id="${escapeAttr(ev.id)}"
                 data-key="${escapeAttr(key)}"
                 title="Edit title and note">
           <i class="fa-solid fa-pen"></i>
         </button>`
      : "";
    return `
      <div class="wou-bst-event${collapsed ? " is-collapsed" : ""}">
        <div class="wou-bst-event-head">
          <div class="wou-bst-event-title">
            ${chevronBtn}
            <span>${title}</span>
          </div>
          <div class="wou-bst-event-meta">
            <span class="wou-bst-event-date">${date}</span>
            ${editBtn}
          </div>
        </div>
        ${showBody ? `<div class="wou-bst-event-body">${body}</div>` : ""}
      </div>`;
  }).join("");
  return `
    <section class="wou-bst-tier-block wou-bst-timeline-block">
      <h3 class="wou-bst-tier-head">The Witcher&apos;s Path · encounters</h3>
      <div class="wou-bst-timeline">${rows}</div>
    </section>`;
}

/* Inline edit form — replaces the event row.  Only title + note are
 * editable; date/outcome/kills/combatId stay tracked metadata. */
function renderEncounterEditForm(ev, key) {
  const title = escapeAttr(ev.title || "");
  const note  = escapeText(ev.note || "");
  return `
    <div class="wou-bst-event wou-bst-event-editing" data-event-id="${escapeAttr(ev.id)}">
      <div class="wou-bst-event-head">
        <input type="text" class="wou-bst-event-input-title"
               value="${title}" placeholder="Title (e.g. Crookback Bog)" />
      </div>
      <textarea class="wou-bst-event-input-note"
                placeholder="What happened? Add fluff, lessons learned, anything…">${note}</textarea>
      <div class="wou-bst-event-edit-actions">
        <button class="wou-bst-event-save" type="button"
                data-action="save-encounter"
                data-event-id="${escapeAttr(ev.id)}"
                data-key="${escapeAttr(key)}">
          <i class="fa-solid fa-check"></i>Save
        </button>
        <button class="wou-bst-event-cancel" type="button" data-action="cancel-encounter">
          <i class="fa-solid fa-xmark"></i>Cancel
        </button>
      </div>
    </div>`;
}

function renderOutcomeChip(outcome) {
  if (outcome === "won")  return `<span class="wou-bst-outcome wou-bst-outcome-win">Cleared</span>`;
  if (outcome === "fled") return `<span class="wou-bst-outcome wou-bst-outcome-flee">Fled</span>`;
  if (outcome === "lost") return `<span class="wou-bst-outcome wou-bst-outcome-loss">Lost</span>`;
  return "";
}

function formatRelative(t) {
  const now = game.time?.worldTime ?? 0;
  const dt  = Math.max(0, now - (t ?? 0));
  if (dt < 60)     return "just now";
  if (dt < 3600)   return `${Math.floor(dt / 60)}m ago`;
  if (dt < 86400)  return `${Math.floor(dt / 3600)}h ago`;
  if (dt < 604800) return `${Math.floor(dt / 86400)}d ago`;
  return `${Math.floor(dt / 604800)}w ago`;
}

function renderDetailControls(key, s) {
  const isGM   = !!game.user?.isGM;
  const viewer = getViewerCharacter();
  const cost   = nextTierCost(s.research);
  /* RP figures: GM uses aggregated viewer RP (max across PCs); a player
   * with an owned character reads their own pool.  No viewer character →
   * 0 RP and disabled UI. */
  const rp = viewer
    ? getResearchPoints(viewer, key)
    : (isGM ? getViewerResearchPoints(key) : 0);
  const canSpend = !!viewer && cost > 0 && rp >= cost;

  /* Pin — visible to anyone with a viewer character (the toggle-pin
   * handler already requires one). */
  const pinBtn = viewer
    ? `<button class="wou-bst-pin${s.pinned ? " is-on" : ""}" type="button"
               data-action="toggle-pin" data-key="${escapeAttr(key)}"
               title="${s.pinned ? "Unpin" : "Pin"} this entry">
         <i class="fa-solid fa-thumbtack"></i>${s.pinned ? "Pinned" : "Pin"}
       </button>`
    : "";

  /* Unlock — everyone with a viewer character; disabled until affordable.
   * GM additionally sees the cost number in the label. */
  const unlockBtn = (viewer && cost > 0)
    ? `<button class="wou-bst-unlock${canSpend ? " is-affordable" : ""}" type="button"
               data-action="spend-rp" data-key="${escapeAttr(key)}"
               ${canSpend ? "" : "disabled"}
               title="${canSpend
                 ? `Spend ${cost} RP to unlock the next tier`
                 : `Need ${cost} RP to unlock the next tier`}">
         <i class="fa-solid fa-lock-open"></i>
         Unlock L${s.research + 1}${isGM ? ` <span class="wou-bst-unlock-cost">(${cost} RP)</span>` : ""}
       </button>`
    : "";

  /* Universal fuzzy pip for anyone with a viewer character.  GM sees the
   * same thing a player would by default; flipping the GM Bypass toggle
   * (gmReveal) overlays exact numbers on top of the bar, matching the
   * "see what the player sees / see everything" mode pattern. */
  let rpDisplay = "";
  if (viewer || isGM) {
    /* Cap the visual fill at 100% even if RP > cost (rare overflow). */
    const pct = cost > 0
      ? Math.max(0, Math.min(100, Math.round((rp / cost) * 100)))
      : 100;
    const reveal = isGM && gmReveal;
    const numbersHtml = reveal
      ? `<span class="wou-bst-rp-numbers">${rp}${cost > 0 ? `&nbsp;/&nbsp;${cost}` : " maxed"}</span>`
      : "";
    const tooltip = reveal
      ? `${rp} RP${cost > 0 ? ` · next tier costs ${cost}` : " · maxed"}`
      : "Progress toward the next tier";
    rpDisplay = `
      <span class="wou-bst-rp wou-bst-rp-fuzzy${reveal ? " is-revealed" : ""}" title="${tooltip}">
        <span class="wou-bst-rp-bar">
          <span class="wou-bst-rp-fill" style="width:${pct}%"></span>
          ${numbersHtml}
        </span>
      </span>`;
  }

  /* GM override stars — bypass RP entirely, set any tier directly.  Gated
   * behind GM Bypass so a stray click on the player-view doesn't dump a
   * monster up to L6 by mistake.  Flip Bypass to access them. */
  const gmStars = (isGM && gmReveal)
    ? `<span class="wou-bst-stars wou-bst-stars-edit" title="GM override — clicks here bypass the RP cost (Bypass-only)">
         ${Array.from({ length: MAX_RESEARCH }, (_, i) => i + 1).map(n =>
           `<button class="wou-bst-star-btn${n <= s.research ? " is-on" : ""}" type="button"
                    data-action="set-research" data-key="${escapeAttr(key)}" data-level="${n}"
                    title="Set research to ${n} star${n>1?"s":""}">★</button>`
         ).join("")}
       </span>`
    : "";

  const resetBtn = isGM
    ? `<button class="wou-bst-reset" type="button"
               data-action="reset-entry" data-key="${escapeAttr(key)}"
               title="DEBUG — Reset this entry's research, encounters, pin, and RP">
         <i class="fa-solid fa-arrow-rotate-left"></i>Reset
       </button>`
    : "";

  return `
    <div class="wou-bst-detail-controls">
      ${pinBtn}
      ${unlockBtn}
      ${rpDisplay}
      ${gmStars}
      ${resetBtn}
    </div>
  `;
}

/* Tier-gated body — 7-step progression (L0–L6).
 *
 *   0: nothing — `???`
 *   1: image only (rendered in card/header; body shows a hint string)
 *   2: + name + category + Field Notes
 *        (threat / difficulty / bounty / environment)
 *   3: + Knowledge tiers (system.knowledge[]) — each tier renders only if
 *        its `shown` flag isn't false and `text` is non-empty; gated behind
 *        a per-tier skill check at the tier's DC
 *   4: + Vulnerabilities (system.combat.vulnerabilities[] + damageProfile
 *        types flagged "vulnerable")
 *   5: + Resistances (damageProfile "resistant" + statusResistances[]) +
 *        Immunities (damageProfile "immune" + statusImmunities[]) +
 *        RESEARCH BONUSES —
 *        "+1 damage vs. this creature" and "+2 to track it"
 *   6: + Special Abilities — system.combat.specialAbilities[]
 *        + system.notes free-text
 *
 * Doc may be null for compendium entries that haven't been loaded yet — we
 * fall back to a "Loading…" placeholder; render() re-renders once it lands. */
function renderDetailTierBody(entry, s) {
  if (s.research === 0) {
    return `
      <p class="wou-bst-tier-note">
        <em>Unknown.</em>
      </p>`;
  }

  if (s.research === 1) {
    return `
      <p class="wou-bst-tier-note">
        <em>You've glimpsed this creature, but know nothing about it.</em>
      </p>`;
  }

  const doc = entry.doc;
  if (!doc) {
    return `<p class="wou-bst-tier-note"><em>Loading…</em></p>`;
  }
  const sys = doc.system ?? {};

  const blocks = [];

  /* Tier 2: Field Notes — threat / difficulty / bounty / environment. */
  if (s.research >= 2) {
    blocks.push(renderQuickStats(sys));
  }

  /* Knowledge tiers: a book-revealed tier shows immediately at any research
   * level. The locked roll-state (and unrevealed tiers) only appear at
   * research ≥ 3. Each tier is a row in system.knowledge[], keyed by index. */
  const tiers = Array.isArray(sys.knowledge) ? sys.knowledge : [];
  tiers.forEach((tier, idx) => {
    const tierRevealed = s.knowledge?.[String(idx)]?.revealed || s.research >= MAX_RESEARCH;
    if (tierRevealed || s.research >= 3) {
      const html = renderKnowledgeBlock(tier, idx, sys, s, entry.key);
      if (html) blocks.push(html);
    }
  });

  /* Tier 4: Vulnerabilities (free-text box + damage-type weaknesses). */
  if (s.research >= 4) {
    blocks.push(renderSusceptibilitiesBlock(sys));
  }

  /* Tier 5: Resistances + combined Immunities + research bonuses. */
  if (s.research >= 5) {
    blocks.push(renderResistancesBlock(sys));
    blocks.push(renderImmunitiesBlock(sys));
    blocks.push(renderResearchBonus({
      label:  "+1 damage vs. this Creature",
      detail: "Knowing exactly where to strike, you deal +1 damage on every successful attack against this creature.",
      icon:   "fa-khanda"
    }));
    blocks.push(renderResearchBonus({
      label:  "+2 to Track",
      detail: "Your research lets you read the signs this creature leaves. Add +2 to checks made to track it.",
      icon:   "fa-paw"
    }));
  }

  /* Tier 6: Special abilities — inline combat.specialAbilities[] + system.notes. */
  if (s.research >= 6) {
    blocks.push(renderSpecialAbilitiesBlock(sys));
  }

  return blocks.filter(Boolean).join("");
}

/* DC comes from the tier's own `dc` field on system.knowledge[]. Coerce to a
 * number; treat anything non-positive or missing as "unset". */
function knowledgeDcFor(tier) {
  if (!tier) return null;
  const n = Number(tier.dc);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/* Pick the actual skill we'll roll for this tier. `tier.skill` is a
 * CONFIG.WITCHER.skillMap key (the INT stat-skill rolled via
 * actor.rollSkillCheck(mapKey, DC)). Returns { label, mapKey } or null. */
function resolveLoreRoll(tier) {
  const mapKey = tier?.skill;
  if (!CONFIG.WITCHER?.skillMap?.[mapKey]) return null;
  /* Label the button by the SKILL being rolled (e.g. "Monster Lore"), not the
   * tier's category name (e.g. "Witcher Knowledge"). skillMap entries are just
   * {statKey, costMultiplier}; the display name comes from skillLabel(). */
  const i18nKey = CONFIG.WITCHER.skillLabel?.(mapKey);
  const label = (i18nKey && game.i18n?.localize?.(i18nKey)) || mapKey;
  return { label, mapKey };
}

/* Witcher Training (the Witcher profession's defining skill) "can also be used
 * in any situation that would normally call for Monster Lore" (Core p.47). If
 * the viewer has a profession slot named "Witcher Training" — or, failing an
 * exact name match, a Witcher profession whose defining skill governs — return
 * that rollable slot `{ skillName, stat, level }`, else null. Only relevant for
 * Monster Lore tiers (tier.skill === "monster"). */
function witcherTrainingSlot(actor) {
  if (!actor) return null;
  const usable = (s) => s?.skillName && s.stat && String(s.stat).toLowerCase() !== "none";
  const named = actor.findProfessionSlot?.("Witcher Training");
  if (usable(named)) return named;
  const prof = actor.items?.find?.(i => i.type === "profession" && /witcher/i.test(i.name ?? ""));
  const def = prof?.system?.definingSkill;
  return usable(def) ? def : null;
}

/* Render one knowledge tier (system.knowledge[idx]). `idx` is the array index
 * — it's the key the per-PC reveal state is stored under. */
function renderKnowledgeBlock(tier, idx, sys, s, key) {
  /* Skip the block only if the tier has no prose. Visibility is governed by
   * research level + per-PC reveal state (handled by the caller), not by the
   * `shown` flag — like attacks/vulnerabilities, knowledge ignores `shown`
   * (which defaults false on freshly-added rows and would hide everything). */
  const body = String(tier?.text ?? "").trim();
  if (!body) return "";

  const label = String(tier?.label ?? "").trim() || "Knowledge";
  const viewer = getViewerCharacter();
  const isGM   = !!game.user?.isGM;
  const peek   = isGM && gmReveal;
  const tierState = s.knowledge?.[String(idx)] ?? { revealed: false, lastFailedTier: null };
  /* Reaching the top tier reveals every knowledge tier for free — whatever
   * you couldn't recall before, comprehensive research makes obvious now.
   * Roll history (revealed/lastFailedTier) is still preserved on the actor
   * so a research reset wouldn't lose it. */
  const revealed = tierState.revealed || peek || s.research >= MAX_RESEARCH;

  if (revealed) {
    return `
      <section class="wou-bst-tier-block">
        <h3 class="wou-bst-tier-head">${escapeText(label)}</h3>
        <div class="wou-bst-tier-body">${body}</div>
      </section>`;
  }

  /* Locked — show CTA button or "wait until next tier" message. */
  const lastFailed = tierState.lastFailedTier;
  const failedHere = lastFailed != null && lastFailed >= s.research;
  let cta;
  if (!viewer) {
    cta = `<span class="wou-bst-knowledge-locked"><i class="fa-solid fa-lock"></i>Needs a character to attempt</span>`;
  } else if (failedHere) {
    cta = `<span class="wou-bst-knowledge-locked"><i class="fa-solid fa-lock"></i>Failed — advance research to retry</span>`;
  } else {
    const resolved = resolveLoreRoll(tier);
    const skillLabel = resolved?.label ?? label;
    const dc = knowledgeDcFor(tier);
    if (!resolved) {
      cta = `<span class="wou-bst-knowledge-locked"><i class="fa-solid fa-lock"></i>GM hasn't set the skill for this lore</span>`;
    } else if (dc == null) {
      cta = `<span class="wou-bst-knowledge-locked"><i class="fa-solid fa-lock"></i>GM hasn't set the DC for this lore</span>`;
    } else {
      cta = `<button class="wou-bst-knowledge-roll" type="button"
                     data-action="attempt-knowledge"
                     data-key="${escapeAttr(key)}"
                     data-tier="${idx}"
                     title="Roll ${escapeText(skillLabel)} (DC ${dc}) — fail and you wait for the next research tier">
               <i class="fa-solid fa-dice-d10"></i>Roll ${escapeText(skillLabel)} <span class="wou-bst-dc">DC ${dc}</span>
             </button>`;
      /* Witcher Training substitutes for Monster Lore tiers. Offer it as a
       * second button so the player can pick whichever is stronger. */
      if (tier?.skill === "monster") {
        const wt = witcherTrainingSlot(viewer);
        if (wt) {
          const wtLabel = String(wt.skillName).trim() || "Witcher Training";
          cta += `<button class="wou-bst-knowledge-roll wou-bst-knowledge-roll-alt" type="button"
                         data-action="attempt-knowledge"
                         data-key="${escapeAttr(key)}"
                         data-tier="${idx}"
                         data-roll="witchertraining"
                         title="Roll ${escapeText(wtLabel)} (DC ${dc}) — your Witcher training stands in for Monster Lore">
                   <i class="fa-solid fa-dice-d10"></i>Roll ${escapeText(wtLabel)} <span class="wou-bst-dc">DC ${dc}</span>
                 </button>`;
        }
      }
    }
  }

  return `
    <section class="wou-bst-tier-block wou-bst-knowledge-block is-locked">
      <h3 class="wou-bst-tier-head">${escapeText(label)}</h3>
      <div class="wou-bst-knowledge-hidden">
        <p class="wou-bst-knowledge-tease"><em>You've heard whispers, but the details elude you.</em></p>
        ${cta}
      </div>
    </section>`;
}

function renderQuickStats(sys) {
  /* Field notes — taxonomy / danger rating / bounty / environment.  All
   * read from the new inline monster schema (threat.{difficulty,complexity},
   * descriptors.environment, category) and localized via CONFIG.WITCHER. */
  const W = CONFIG.WITCHER?.monster ?? {};
  const loc = (map, k) => (map?.[k] ? (game.i18n?.localize?.(map[k]) ?? k) : "");
  const rows = [
    ["Type",       loc(W.types,      sys.category)],
    ["Difficulty", loc(W.threat,     sys.threat?.difficulty)],
    ["Complexity", loc(W.complexity, sys.threat?.complexity)],
    ["Bounty",     sys.bounty],
    ["Environment", sys.descriptors?.environment],
  ].filter(([, v]) => v != null && v !== "" && v !== 0);
  if (!rows.length) return "";
  return `
    <section class="wou-bst-tier-block">
      <h3 class="wou-bst-tier-head">Field Notes</h3>
      <div class="wou-bst-kv">
        ${rows.map(([k, v]) =>
          `<div class="wou-bst-kv-row"><span class="wou-bst-kv-k">${escapeText(k)}</span><span class="wou-bst-kv-v">${escapeText(String(v))}</span></div>`
        ).join("")}
      </div>
    </section>`;
}

/* Localized damage-type names whose per-type reaction in combat.damageProfile
 * matches `reaction` ("resistant" | "vulnerable" | "immune"). */
function damageTypesWithReaction(sys, reaction) {
  const prof = sys.combat?.damageProfile ?? {};
  const map  = CONFIG.WITCHER?.damageTypes ?? {};
  return Object.entries(prof)
    .filter(([, v]) => v === reaction)
    .map(([k]) => (map[k] ? (game.i18n?.localize?.(map[k]) ?? k) : k));
}

/* Render a list of localized labels as chips. */
function chipsHtmlFor(labels) {
  if (!labels.length) return "";
  return `
    <div class="wou-bst-status-chips">
      ${labels.map(l => `<span class="wou-bst-status-chip">${escapeText(l)}</span>`).join("")}
    </div>`;
}

/* Tier 4 — Vulnerabilities: the free-text combat.vulnerabilities[] box
 * (oils, silver, tactics) plus any damage types flagged "vulnerable" in the
 * damage profile. */
function renderSusceptibilitiesBlock(sys) {
  const rows = (Array.isArray(sys.combat?.vulnerabilities) ? sys.combat.vulnerabilities : [])
    .filter(r => String(r?.name ?? "").trim() || String(r?.note ?? "").trim());
  const dmgLabels = damageTypesWithReaction(sys, "vulnerable");

  if (!rows.length && !dmgLabels.length) {
    return `
      <section class="wou-bst-tier-block">
        <h3 class="wou-bst-tier-head">Vulnerabilities</h3>
        <p class="wou-bst-tier-empty"><em>No known vulnerabilities.</em></p>
      </section>`;
  }

  const listHtml = rows.length
    ? `<div class="wou-bst-notes-list">
         ${rows.map(r => {
           const name = String(r.name ?? "").trim();
           const note = String(r.note ?? "").trim();
           return `
             <div class="wou-bst-note">
               ${name ? `<div class="wou-bst-note-name">${escapeText(name)}</div>` : ""}
               ${note ? `<div class="wou-bst-note-desc">${escapeProse(note)}</div>` : ""}
             </div>`;
         }).join("")}
       </div>`
    : "";

  return `
    <section class="wou-bst-tier-block">
      <h3 class="wou-bst-tier-head">Vulnerabilities</h3>
      ${listHtml}
      ${chipsHtmlFor(dmgLabels)}
    </section>`;
}

/* Localized display labels for a list of status-effect ids, via the
 * registered CONFIG.statusEffects. Used by the Resistances + Immunities
 * tiers (both lump status ids in with damage-type reactions). */
function statusEffectLabels(ids) {
  const all = Array.isArray(CONFIG?.statusEffects) ? CONFIG.statusEffects : [];
  return (ids ?? []).map((id) => {
    const found = all.find(e => e?.id === id);
    const name  = found?.name ?? found?.label ?? id;
    return game.i18n?.localize?.(name) ?? name;
  });
}

/* Tier 5 — Resistances: damage types flagged "resistant" in the damage
 * profile, plus status-effect ids in combat.statusResistances[] (the middle
 * tier between none and immune). */
function renderResistancesBlock(sys) {
  const dmgLabels = damageTypesWithReaction(sys, "resistant");
  const ids = Array.isArray(sys.combat?.statusResistances)
    ? sys.combat.statusResistances.filter(Boolean)
    : [];
  const labels = [...dmgLabels, ...statusEffectLabels(ids)];
  if (!labels.length) return "";
  return `
    <section class="wou-bst-tier-block">
      <h3 class="wou-bst-tier-head">Resistances</h3>
      ${chipsHtmlFor(labels)}
    </section>`;
}

/* Tier 5 — Immunities: damage types flagged "immune" in the damage profile
 * plus status-effect ids in combat.statusImmunities[]. */
function renderImmunitiesBlock(sys) {
  const dmgLabels = damageTypesWithReaction(sys, "immune");
  const ids = Array.isArray(sys.combat?.statusImmunities)
    ? sys.combat.statusImmunities.filter(Boolean)
    : [];
  if (!dmgLabels.length && !ids.length) return "";

  return `
    <section class="wou-bst-tier-block">
      <h3 class="wou-bst-tier-head">Immunities</h3>
      ${chipsHtmlFor([...dmgLabels, ...statusEffectLabels(ids)])}
    </section>`;
}

/* Tier 6 — Special Abilities.  Two sources:
 *   1. system.combat.specialAbilities[] — inline rows {name, description}
 *      (Amphibious, Feral, …).
 *   2. system.notes — GM-authored free-form notes block.
 * Renders nothing if both are empty. */
function renderSpecialAbilitiesBlock(sys) {
  const abilities = (Array.isArray(sys.combat?.specialAbilities) ? sys.combat.specialAbilities : [])
    .filter(a => String(a?.name ?? "").trim() || String(a?.description ?? "").trim());
  const notesHtml = String(sys.notes ?? "").trim();
  if (!abilities.length && !notesHtml) return "";

  const noteList = abilities.length
    ? `<div class="wou-bst-notes-list">
         ${abilities.map(a => {
           const name = String(a.name ?? "").trim();
           const desc = String(a.description ?? "").trim();
           return `
             <div class="wou-bst-note">
               ${name ? `<div class="wou-bst-note-name">${escapeText(name)}</div>` : ""}
               ${desc ? `<div class="wou-bst-note-desc">${desc}</div>` : ""}
             </div>`;
         }).join("")}
       </div>`
    : "";

  return `
    <section class="wou-bst-tier-block">
      <h3 class="wou-bst-tier-head">Special Abilities</h3>
      ${noteList}
      ${notesHtml ? `<div class="wou-bst-tier-body">${notesHtml}</div>` : ""}
    </section>`;
}

/* Research-bonus callout — display-only callouts shown at L5.  Players
 * apply the modifier manually on the roll.  Wiring as automatic system
 * modifiers is deferred (would need hooks into the actor roll pipeline
 * and "rolling against this monster" detection). */
function renderResearchBonus({ label, detail, icon }) {
  return `
    <section class="wou-bst-tier-block wou-bst-bonus">
      <div class="wou-bst-bonus-badge"><i class="fa-solid ${icon}"></i><span>${escapeText(label)}</span></div>
      <p class="wou-bst-bonus-detail">${escapeText(detail)}</p>
    </section>`;
}

function formatWorldTime(t) {
  /* Foundry V13's game.time.calendar exposes timeToComponents + a months
   * array (with .name on each).  Prefer month-name formatting; fall back
   * to "Day N, Yr Y" if the active calendar didn't supply month names. */
  try {
    const cal = game.time?.calendar;
    if (cal?.timeToComponents) {
      const c = cal.timeToComponents(t);
      const day = (c.dayOfMonth ?? 0) + 1;
      const y   = c.year ?? 0;
      const monthName = cal.months?.[c.month]?.name ?? "";
      return monthName ? `${day} ${monthName}` : `Day ${day}, Yr ${y}`;
    }
  } catch {}
  return `t=${t}`;
}

/* =========================================================================
   EVENT HANDLERS
   ========================================================================= */

async function onClick(ev) {
  const actionEl = ev.target.closest("[data-action]");
  if (!actionEl) return;
  const action = actionEl.dataset.action;
  switch (action) {
    case "close":         ev.preventDefault(); await setBestiaryOpen(false); return;
    case "set-filter":    ev.preventDefault(); activeFilter = actionEl.dataset.filter; await render(); return;
    case "select-entry":  ev.preventDefault(); activeKey   = actionEl.dataset.key; await render(); return;
    case "toggle-pin": {
      ev.preventDefault();
      /* Pin is per-character — writes to the viewer's actor.  Players pin
       * their own progression; GMs need a viewer character to pin. */
      const key = actionEl.dataset.key;
      const viewer = getViewerCharacter();
      if (!viewer) {
        ui.notifications?.warn("No viewer character — pin requires an assigned character.");
        return;
      }
      const cur = getActorEntryState(viewer, key);
      await updateActorEntryState(viewer, key, { pinned: !cur.pinned });
      return;
    }
    case "set-research": {
      ev.preventDefault();
      if (!game.user?.isGM) return;
      /* Belt-and-braces: even if the button somehow rendered without
       * bypass on, refuse the override.  The render gate is the primary
       * defense — this just catches edge cases (stale DOM, etc.). */
      if (!gmReveal) return;
      const key = actionEl.dataset.key;
      const level = Math.max(0, Math.min(MAX_RESEARCH, Number(actionEl.dataset.level) || 0));
      /* Read the CURRENT viewer's state so click-to-demote reflects what
       * the GM is looking at — when View-As is set, that's that specific
       * actor's tier; when unset, the aggregated read across all PCs. */
      const cur = getViewerEntryState(key);
      const next = cur.research === level ? level - 1 : level;
      const nextTier = Math.max(0, next);
      await applyGMTierOverride(key, nextTier);
      return;
    }
    case "spend-rp": {
      ev.preventDefault();
      const key = actionEl.dataset.key;
      const viewer = getViewerCharacter();
      if (!viewer) {
        ui.notifications?.warn("No viewer character — RP is per-character, you need one to spend.");
        return;
      }
      const ok = await spendRpToAdvance(viewer, key);
      if (!ok) {
        ui.notifications?.warn("Not enough research points, or already at the top tier.");
      }
      return;
    }
    case "edit-encounter": {
      ev.preventDefault();
      _editingEventId = actionEl.dataset.eventId;
      await render();
      /* Focus the title input so the keyboard goes right to it. */
      const input = panelEl?.querySelector(".wou-bst-event-editing .wou-bst-event-input-title");
      input?.focus();
      input?.select();
      return;
    }
    case "save-encounter": {
      ev.preventDefault();
      const viewer = getViewerCharacter();
      if (!viewer) {
        ui.notifications?.warn("Need a viewer character to edit encounter notes.");
        return;
      }
      const key = actionEl.dataset.key;
      const eventId = actionEl.dataset.eventId;
      const formEl = actionEl.closest(".wou-bst-event-editing");
      const titleInput = formEl?.querySelector(".wou-bst-event-input-title");
      const noteInput  = formEl?.querySelector(".wou-bst-event-input-note");
      const newTitle = String(titleInput?.value ?? "").trim();
      const newNote  = String(noteInput?.value  ?? "");
      const ok = await updateEncounter(viewer, key, eventId, { title: newTitle, note: newNote });
      if (!ok) ui.notifications?.warn("Couldn't save the encounter note.");
      _editingEventId = null;
      await render();
      return;
    }
    case "cancel-encounter": {
      ev.preventDefault();
      _editingEventId = null;
      await render();
      return;
    }
    case "attempt-knowledge": {
      ev.preventDefault();
      const viewer = getViewerCharacter();
      if (!viewer) {
        ui.notifications?.warn("Need a viewer character to attempt a knowledge roll.");
        return;
      }
      const key = actionEl.dataset.key;
      const tierIndex = Number(actionEl.dataset.tier);
      if (!Number.isInteger(tierIndex) || tierIndex < 0) return;
      if (!canAttemptKnowledge(viewer, key, tierIndex)) {
        ui.notifications?.warn("Already revealed, or waiting on the next research tier.");
        return;
      }

      /* Pull the actual monster doc so we can read this tier's skill + DC
       * out of its system.knowledge[] row. */
      const allEntries = await loadEntries();
      const entry = allEntries.find(e => e.key === key);
      const monsterDoc = entry ? await ensureFullDoc(entry) : null;
      const tier = monsterDoc?.system?.knowledge?.[tierIndex];
      if (!tier) return;
      const tierLabel = String(tier.label ?? "").trim() || "this lore";
      const dc = knowledgeDcFor(tier);
      if (dc == null) {
        ui.notifications?.warn(`${monsterDoc?.name ?? "This monster"} has no DC set for ${tierLabel}.`);
        return;
      }
      /* Route through the system's own roll helpers so the chat card,
       * threshold display, and modifier handling all match every other
       * skill check in the game (including dissect/extract-mutagen). The
       * player may opt to substitute Witcher Training for a Monster Lore
       * tier (Core p.47) via the alternate button. */
      let roll;
      if (actionEl.dataset.roll === "witchertraining" && tier.skill === "monster") {
        const wt = witcherTrainingSlot(viewer);
        if (!wt) {
          ui.notifications?.warn("You no longer have Witcher Training to roll.");
          return;
        }
        if (typeof viewer.rollProfessionSkill !== "function") {
          ui.notifications?.error("System's rollProfessionSkill helper missing.");
          return;
        }
        roll = await viewer.rollProfessionSkill(wt, { dc });
      } else {
        const resolved = resolveLoreRoll(tier);
        if (!resolved) {
          ui.notifications?.error(`No way to roll for "${tierLabel}" — skill not found.`);
          return;
        }
        if (typeof viewer.rollSkillCheck !== "function") {
          ui.notifications?.error("System's rollSkillCheck helper missing.");
          return;
        }
        roll = await viewer.rollSkillCheck(resolved.mapKey, dc);
      }

      const pass = Number(roll?.total ?? 0) >= dc;
      await recordKnowledgeAttempt(viewer, key, tierIndex, pass);
      return;
    }
    case "toggle-event-collapse": {
      ev.preventDefault();
      const id = actionEl.dataset.eventId;
      if (!id) return;
      /* Mutate session state + flip the DOM in place — avoids a full
       * re-render so the click feels instant.  Re-render correctness is
       * still preserved because _collapsedEvents drives the next render. */
      const nowCollapsed = !_collapsedEvents.has(id);
      if (nowCollapsed) _collapsedEvents.add(id);
      else              _collapsedEvents.delete(id);
      const eventEl = actionEl.closest(".wou-bst-event");
      if (eventEl) {
        eventEl.classList.toggle("is-collapsed", nowCollapsed);
        const body = eventEl.querySelector(".wou-bst-event-body");
        if (body) body.style.display = nowCollapsed ? "none" : "";
        const icon = actionEl.querySelector("i");
        if (icon) {
          icon.classList.toggle("fa-chevron-right", nowCollapsed);
          icon.classList.toggle("fa-chevron-down",  !nowCollapsed);
        }
        actionEl.title = nowCollapsed ? "Expand note" : "Collapse note";
      }
      return;
    }
    case "populate": {
      ev.preventDefault();
      if (!game.user?.isGM) return;
      await openPopulateDialog();
      return;
    }
    case "toggle-reveal": {
      ev.preventDefault();
      if (!game.user?.isGM) return;
      gmReveal = !gmReveal;
      await render();
      return;
    }
    case "wipe-research": {
      ev.preventDefault();
      if (!game.user?.isGM || !gmReveal) return;
      await wipeAllResearch();
      return;
    }
    case "wipe-encounters": {
      ev.preventDefault();
      if (!game.user?.isGM || !gmReveal) return;
      await wipeAllEncounters();
      return;
    }
    case "reset-entry": {
      ev.preventDefault();
      if (!game.user?.isGM) return;
      const key = actionEl.dataset.key;
      await resetEntryState(key);
      return;
    }
  }
}

/* GM tier override — applies a target research tier.  Scope follows the
 * GM's View-As selection: when an override actor is set, only that actor
 * is updated; when viewing the aggregated state, the tier is applied to
 * every PC (the previous behavior, preserved as the "aggregated" mode).
 * If no PCs exist, nothing to write — notify so the GM doesn't think the
 * button is broken. */
async function applyGMTierOverride(key, targetTier) {
  if (!game.user?.isGM || !key) return;
  const tier = Math.max(0, Math.min(MAX_RESEARCH, targetTier));

  const overrideId = getViewerOverride();
  if (overrideId) {
    const actor = game.actors?.get?.(overrideId);
    if (!actor || actor.type !== "character") {
      ui.notifications?.warn("View-as actor missing — clearing the override.");
      setViewerOverride(null);
      await render();
      return;
    }
    await updateActorEntryState(actor, key, { research: tier });
    return;
  }

  const pcs = (game.actors?.contents ?? []).filter(a => a.type === "character");
  if (!pcs.length) {
    ui.notifications?.warn("No player characters in the world — bestiary state is per-character, so there's nothing to update.");
    return;
  }
  for (const pc of pcs) {
    await updateActorEntryState(pc, key, { research: tier });
  }
}

/* Wipe a single entry's state on one or all PCs.  The actual delete uses
 * the `-=` update prefix because Foundry's setFlag deep-merges into the
 * existing flag object — setFlag("bestiary", mapMinusKey) reinstates the
 * "removed" key from the persisted value, which is why the previous
 * version of this function silently did nothing. */
async function resetEntryState(key) {
  if (!key || !game.user?.isGM) return;
  const pcs = (game.actors?.contents ?? []).filter(a => a.type === "character");
  const hits = pcs.filter(pc => getActorBestiary_(pc)[encKey(key)]);
  if (!hits.length) {
    ui.notifications?.info("No PC has state for this entry.");
    return;
  }
  const currentActor = getCurrentActor();
  const currentHasState = !!(currentActor && getActorBestiary_(currentActor)[encKey(key)]);

  const scope = await confirmWithCode({
    title: "Reset entry",
    icon:  "fa-solid fa-arrow-rotate-left",
    body:  `<p>Wipe research, encounter log, pin, and knowledge-roll history for this entry.</p>
            <p class="wou-bst-confirm-keep">Affects <b>${hits.length}</b> PC${hits.length === 1 ? "" : "s"} that currently track this entry.</p>`,
    currentActor: currentHasState ? currentActor : null,
    requireCode: false,
  });
  if (!scope) return;

  const targets = scope === "current" ? [currentActor] : hits;
  for (const pc of targets) {
    if (!pc) continue;
    await pc.update({ [`flags.${MODULE_ID}.bestiary.-=${encKey(key)}`]: null });
  }
}

/* Resolves the "current actor" for scoped destructive actions:
 *   1. View-as override (GM picks from the header dropdown), if set.
 *   2. game.user.character, if the GM has one bound.
 *   3. null — caller suppresses the "Current actor only" option entirely.
 */
function getCurrentActor() {
  const overrideId = getViewerOverride();
  if (overrideId) {
    const a = game.actors?.get?.(overrideId);
    if (a?.type === "character") return a;
  }
  const bound = game.user?.character;
  if (bound?.type === "character") return bound;
  return null;
}

/* Local helper — read raw bestiary flag map for one actor (no decoration). */
function getActorBestiary_(actor) {
  return actor?.flags?.[MODULE_ID]?.bestiary ?? {};
}

/* =========================================================================
   POPULATE DIALOG — GM picks which compendium packs feed the bestiary
   ========================================================================= */

async function openPopulateDialog() {
  /* All Actor packs available in the world.  Pre-checked = currently in
   * the `bestiary.sourcePacks` setting. */
  const actorPacks = (game.packs?.contents ?? []).filter(p => p.metadata?.type === "Actor");
  if (!actorPacks.length) {
    ui.notifications?.warn("No Actor compendium packs are available in this world.");
    return;
  }
  const current = new Set(getSetting("bestiary.sourcePacks") ?? []);

  const rows = actorPacks.map(p => {
    const id = p.metadata.id;
    const checked = current.has(id) ? "checked" : "";
    return `
      <label class="wou-bst-pop-row">
        <input type="checkbox" name="pack" value="${escapeAttr(id)}" ${checked} />
        <span class="wou-bst-pop-label">${escapeText(p.metadata.label)}</span>
        <span class="wou-bst-pop-id">${escapeText(id)}</span>
      </label>`;
  }).join("");

  const content = `
    <div class="wou-bst-pop">
      <p class="wou-bst-pop-hint">Select the compendium packs whose monsters should appear in the bestiary. World monsters flagged as a "Bestiary variant" are always included.</p>
      <div class="wou-bst-pop-list">${rows}</div>
    </div>`;

  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: "Populate Bestiary", icon: "fa-solid fa-book-skull" },
    content,
    classes: ["wou-bst-pop-dialog"],
    buttons: [
      {
        action: "save",
        label: "Save",
        icon: "fa-solid fa-check",
        default: true,
        callback: (_ev, _btn, dialog) => {
          const root = dialog.element ?? dialog;
          const picked = [...root.querySelectorAll('input[name="pack"]:checked')].map(i => i.value);
          return picked;
        }
      },
      { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark" }
    ],
    rejectClose: false
  });

  if (!Array.isArray(result)) return;  /* cancelled */
  await game.settings.set(MODULE_ID, "bestiary.sourcePacks", result);
  ui.notifications?.info(`Bestiary populated from ${result.length} pack${result.length === 1 ? "" : "s"}.`);
}

/* =========================================================================
   DESTRUCTIVE GM ACTIONS — code-confirmed
   ========================================================================= */

/* Wipe research progress (research tier + accumulated RP) on every entry on
 * every PC.  Knowledge-roll history, pins, and encounter logs are preserved
 * — those have their own wipe action (or per-entry reset). */
async function wipeAllResearch() {
  if (!game.user?.isGM) return;
  const pcs = (game.actors?.contents ?? []).filter(a => a.type === "character");
  const counts = pcs.map(pc => Object.keys(getActorBestiary_(pc)).length).reduce((a, b) => a + b, 0);
  if (!counts) {
    ui.notifications?.info("No PC has any bestiary state to wipe.");
    return;
  }
  const currentActor = getCurrentActor();
  const scope = await confirmWithCode({
    title: "Wipe Research Progress",
    icon:  "fa-solid fa-flask",
    body:  `<p>This will clear <strong>research tier</strong> and <strong>research points</strong> for every entry on the selected target.</p>
            <ul class="wou-bst-confirm-ul">
              <li>Player characters in world: <b>${pcs.length}</b></li>
              <li>Tracked entries to clear (all PCs): <b>${counts}</b></li>
            </ul>
            <p class="wou-bst-confirm-keep">Kept intact: pins, encounter logs, knowledge-roll history.</p>`,
    currentActor,
  });
  if (!scope) return;

  const targets = scope === "current" && currentActor ? [currentActor] : pcs;
  for (const pc of targets) {
    const map = { ...(pc.flags?.[MODULE_ID]?.bestiary ?? {}) };
    let changed = false;
    for (const k of Object.keys(map)) {
      const entry = map[k] ?? {};
      if (entry.research || entry.rp) {
        map[k] = { ...entry, research: 0, rp: 0 };
        changed = true;
      }
    }
    if (changed) await pc.setFlag(MODULE_ID, "bestiary", map);
  }
  ui.notifications?.info(
    scope === "current"
      ? `Research wiped for ${currentActor.name}.`
      : `Research wiped across ${targets.length} PC${targets.length === 1 ? "" : "s"}.`
  );
}

/* Wipe encounter logs on every entry on every PC.  Research progress
 * (tier + RP) and pins are preserved. */
async function wipeAllEncounters() {
  if (!game.user?.isGM) return;
  const pcs = (game.actors?.contents ?? []).filter(a => a.type === "character");
  let encounterTotal = 0;
  for (const pc of pcs) {
    for (const v of Object.values(getActorBestiary_(pc))) {
      encounterTotal += Array.isArray(v?.encounters) ? v.encounters.length : 0;
    }
  }
  if (!encounterTotal) {
    ui.notifications?.info("No encounter logs to wipe.");
    return;
  }
  const currentActor = getCurrentActor();
  const scope = await confirmWithCode({
    title: "Wipe Encounter Data",
    icon:  "fa-solid fa-paw",
    body:  `<p>This will clear every <strong>encounter log entry</strong> on the selected target.</p>
            <ul class="wou-bst-confirm-ul">
              <li>Player characters in world: <b>${pcs.length}</b></li>
              <li>Encounter events on all PCs: <b>${encounterTotal}</b></li>
            </ul>
            <p class="wou-bst-confirm-keep">Kept intact: research tier, RP, pins, knowledge-roll history.</p>`,
    currentActor,
  });
  if (!scope) return;

  const targets = scope === "current" && currentActor ? [currentActor] : pcs;
  for (const pc of targets) {
    const map = { ...(pc.flags?.[MODULE_ID]?.bestiary ?? {}) };
    let changed = false;
    for (const k of Object.keys(map)) {
      const entry = map[k] ?? {};
      if (Array.isArray(entry.encounters) && entry.encounters.length) {
        map[k] = { ...entry, encounters: [] };
        changed = true;
      }
    }
    if (changed) await pc.setFlag(MODULE_ID, "bestiary", map);
  }
  ui.notifications?.info(
    scope === "current"
      ? `Encounter logs wiped for ${currentActor.name}.`
      : `Encounter logs wiped across ${targets.length} PC${targets.length === 1 ? "" : "s"}.`
  );
}

/* Confirmation dialog with optional 4-digit code requirement and optional
 * scope selection (current actor vs all PCs).  Returns the selected scope
 * ("all" or "current"), or null when cancelled or on a wrong code.
 *
 * Param shape:
 *   title         — window title
 *   icon          — fa-solid icon class
 *   body          — HTML body
 *   currentActor  — Actor | null.  When non-null, adds a "<name> only"
 *                   button alongside the "All PCs" button.  When null,
 *                   only the all-PCs button is shown.
 *   requireCode   — boolean (default true).  When true, the dialog
 *                   includes a 4-digit code box that must be typed
 *                   correctly before the action confirms.  When false,
 *                   the buttons themselves are the only gate. */
async function confirmWithCode({ title, icon, body, currentActor = null, requireCode = true }) {
  const code = requireCode ? String(Math.floor(1000 + Math.random() * 9000)) : null;
  const content = `
    <div class="wou-bst-confirm">
      ${body}
      ${requireCode ? `
        <div class="wou-bst-confirm-code-row">
          <span class="wou-bst-confirm-code-lbl">Type to confirm:</span>
          <span class="wou-bst-confirm-code">${code}</span>
        </div>
        <input class="wou-bst-confirm-input" type="text" name="code"
               maxlength="4" inputmode="numeric" autocomplete="off"
               pattern="[0-9]{4}" placeholder="• • • •" autofocus />
      ` : ""}
    </div>
  `;
  const readCode = (btn) => requireCode ? (btn.form?.elements?.code?.value?.trim() ?? "") : null;
  const buttons = [];
  if (currentActor) {
    buttons.push({
      action: "current",
      label: `${escapeText(currentActor.name)} only`,
      icon: "fa-solid fa-user",
      default: true,
      callback: (_ev, btn) => ({ scope: "current", code: readCode(btn) })
    });
    buttons.push({
      action: "all",
      label: "All PCs",
      icon: "fa-solid fa-users",
      callback: (_ev, btn) => ({ scope: "all", code: readCode(btn) })
    });
  } else {
    buttons.push({
      action: "all",
      label: "Confirm",
      icon: "fa-solid fa-check",
      default: true,
      callback: (_ev, btn) => ({ scope: "all", code: readCode(btn) })
    });
  }
  buttons.push({ action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark" });

  const result = await foundry.applications.api.DialogV2.wait({
    window: { title, icon: icon ?? "fa-solid fa-triangle-exclamation" },
    classes: ["wou-bst-confirm-dialog"],
    content,
    buttons,
    rejectClose: false
  }).catch(() => null);

  if (!result || result === "cancel" || !result.scope) return null;
  if (requireCode && String(result.code) !== code) {
    ui.notifications?.warn("Wrong code — action cancelled.");
    return null;
  }
  return result.scope;
}

/* The view-as picker is now wired via lib/view-as.js's shared
 * `wireViewAsPicker`, which delegates change + clear-X events.  No local
 * change-event handler is needed. */

/* =========================================================================
   UTILS
   ========================================================================= */

function escapeText(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
/* Escape HTML, then restore a small safe whitelist of formatting tags the GM
 * may type into plain-text fields (e.g. vulnerability notes): <p> and <em>
 * (with their closing tags). Attributes can't survive — only the bare tags
 * match — so there's no injection surface. */
function escapeProse(s) {
  return escapeText(s).replace(/&lt;(\/?(?:p|em))&gt;/gi, "<$1>");
}
function escapeAttr(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
