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
  deleteEncounterAnyPC,
  canAttemptKnowledge,
  recordKnowledgeAttempt,
  setViewerOverride,
  getViewerOverride
} from "../lib/bestiary.js";
import { setPanelOverride, VIEWER_OVERRIDE_HOOK, PANEL_OVERRIDE_HOOK } from "../lib/actor.js";
import { summarizeEffectModifiers } from "../../sheets/item/base.mjs";
import { t, tFormat } from "../lib/i18n.js";
import {
  renderViewAsPicker as renderSharedViewAsPicker,
  wireViewAsPicker,
  renderViewPanelAsPicker,
  wireViewPanelAsPicker
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

/* Session-local collapse state for the Autopsy notes section in the left
 * column. One flag for the whole panel rather than one per entry: a player
 * who collapses it is asking to stop seeing dissection findings generally, so
 * it stays shut while they browse from creature to creature. Starts expanded —
 * the findings are the payoff of an autopsy and shouldn't need a click. */
let _autopsyCollapsed = false;

/* =========================================================================
   PUBLIC API
   ========================================================================= */

export function injectBestiaryPanel() {
  if (document.getElementById(PANEL_ID)) return;
  const el = document.createElement("main");
  el.id = PANEL_ID;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", t("WITCHER.Chrome.Bestiary.Text.Bestiary", "Bestiary"));
  document.body.appendChild(el);
  panelEl = el;

  /* Single click delegate — handles filter chips, card clicks, GM controls.
   * Mirrors the pattern from character.js (one delegate set up at inject
   * time, not per render, so renders can't leak listeners). */
  el.addEventListener("click", onClick);
  /* Shared "View as" picker change + clear-X handling.  Idempotent; flag
   * on the element ensures we don't double-wire across module reloads. */
  wireViewAsPicker(el, () => render());
  wireViewPanelAsPicker(el, "bestiary", () => render());

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
    Hooks.on(PANEL_OVERRIDE_HOOK, (key) => { if (key === "bestiary") rerenderIfOpen(); });
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
    setPanelOverride("bestiary", null);
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

  panelEl.style.top = `calc(${top}px / var(--wdm-size-bestiary, var(--wdm-chrome-bars-scale, 1)))`;
  panelEl.style.bottom = `calc(${bottom}px / var(--wdm-size-bestiary, var(--wdm-chrome-bars-scale, 1)))`;
  panelEl.style.left = `calc(${left}px / var(--wdm-size-bestiary, var(--wdm-chrome-bars-scale, 1)))`;
  panelEl.style.right = `calc(${right}px / var(--wdm-size-bestiary, var(--wdm-chrome-bars-scale, 1)))`;

  const tab = document.querySelector('#wou-top-bar [data-tab="bestiary"]');
  if (tab) {
    const tabRect = tab.getBoundingClientRect();
    const tabCenterX = tabRect.left + tabRect.width / 2;
    /* Divide by --wdm-scale — the panel's own coord system is scaled,
     * so a raw viewport-pixel offset lands off-center under UI scaling.
     * Mirrors the fix in inventory.js. */
    panelEl.style.setProperty("--bst-close-x", `calc(${tabCenterX - left}px / var(--wdm-size-bestiary, var(--wdm-chrome-bars-scale, 1)))`);
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

  /* GM exclusions (system settings): hide whole monster categories from the
   * bestiary. `entry.type` is the Witcher `system.category`. */
  let list = [...map.values()];
  if (getSetting("bestiary.hideBeasts"))    list = list.filter(e => e.type !== "beast");
  if (getSetting("bestiary.hideHumanoids")) list = list.filter(e => e.type !== "humanoid");
  /* Per-monster opt-out: a monster flagged "hide from bestiary" (its Notes tab)
   * is dropped regardless of category. Works for world actors AND compendium
   * docs — both carry `system.hideFromBestiary`. */
  list = list.filter(e => !e.doc?.system?.hideFromBestiary);

  _entries = list;
  return _entries;
}

/** Invalidate the cached entry list + re-render if the panel is open. Called by
 *  the bestiary source/exclusion settings' onChange so a toggle takes effect
 *  immediately. */
export function invalidateBestiaryEntries() {
  _entries = null;
  rerenderIfOpen();
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
    /* If this entry has a REVEALED signature mutagen, pre-load both the monster
     * doc (carries system.mutagen.uuid) AND the mutagen doc. renderKnownMutagen
     * resolves them with fromUuidSync, which returns only a compendium INDEX
     * (no ActiveEffects → "No effect recorded") until the doc is loaded once via
     * fromUuid. Loading here populates the cache fromUuidSync reads, so the
     * mutagen's effect modifiers show. */
    try {
      const viewer = getViewerCharacter();
      const fe = viewer?.flags?.[MODULE_ID]?.bestiary?.[encKey(activeKey)];
      if (entry && fe?.dissection?.mutagenRevealed) {
        await ensureFullDoc(entry);
        const monster = entry.doc ?? fromUuidSync(entry.uuid, { strict: false });
        const mUuid = monster?.system?.mutagen?.uuid;
        if (mUuid) await fromUuid(mUuid);
      }
    } catch (_) { /* best-effort preload — renderKnownMutagen degrades gracefully */ }
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
/* Lazy so t() resolves after Foundry lang is loaded — evaluated at
 * render time, not at module import. Prior version had literal
 * `${t(...)}` strings inside a single-quoted concatenation, which
 * rendered the placeholder text raw. */
function researchTip() {
  return '<div class="wcu-tip">' +
    `<strong>${t("WITCHER.Chrome.Bestiary.Text.ResearchingMonsters", "Researching Monsters")}</strong>` +
    t("WITCHER.Chrome.Bestiary.Text.ResearchIntro", "Study a beast to unlock its entry tier by tier. Earn Research Points by encountering, observing and dissecting it, then spend RP to unlock the next tier.") +
    `<div class="wcu-tip-row"><span>${t("WITCHER.Chrome.Bestiary.Text.Tier1", "Tier 1")}</span><span>${t("WITCHER.Chrome.Bestiary.Text.RevealsItsPortrait", "Reveals its portrait")}</span></div>` +
    `<div class="wcu-tip-row"><span>${t("WITCHER.Chrome.Bestiary.Text.Tier2", "Tier 2")}</span><span>${t("WITCHER.Chrome.Bestiary.Text.NameAmpMonsterType", "Name &amp; monster type")}</span></div>` +
    `<div class="wcu-tip-row"><span>${t("WITCHER.Chrome.Bestiary.Text.HigherTiers", "Higher tiers")}</span><span>${t("WITCHER.Chrome.Bestiary.Text.LoreCombatAmpWeaknesses", "Lore, combat &amp; weaknesses")}</span></div>` +
    `<div class="wcu-tip-flavor">${t("WITCHER.Chrome.Bestiary.Text.EachCharacterKeepsTheirOwnResearchWhatOn", "Each character keeps their own research — what one witcher knows, another may not.")}</div>` +
  '</div>';
}

function renderShell(visible, all) {
  /* Close button rendered LAST so it doesn't disrupt grid auto-flow on the
   * panel (even though it's absolute-positioned and shouldn't participate,
   * putting it last is defensive belt-and-braces — character.html mockup
   * does this too). */
  const isGM = game.user?.isGM;
  return `
    <header class="wou-bst-header">
      <div class="wou-bst-title-stack">
        <h2 class="wou-bst-title">${t("WITCHER.Chrome.Bestiary.Text.Bestiary", "Bestiary")}
          <span class="wdm-help-tip" data-tooltip="${escapeAttr(researchTip())}" data-tooltip-direction="DOWN" data-tooltip-class="wou-craft-tip"><i class="fa-solid fa-circle-info"></i></span>
        </h2>
        <span class="wou-bst-count">${tFormat("WITCHER.Chrome.Bestiary.Text.NEntries", { n: all.length }, `${all.length} entries`)}</span>
      </div>
      <div class="wou-bst-meta">
        ${isGM ? `<button class="wou-bst-bypass${gmReveal ? " is-on" : ""}" type="button" data-action="toggle-reveal" title="${t("WITCHER.Chrome.Bestiary.Text.BypassTierGatingSeeAllInfoRegardlessOfRe", "Bypass tier gating — see all info regardless of research level. Session-only, GM-only.")}"><i class="fa-solid ${gmReveal ? "fa-eye" : "fa-eye-slash"}"></i><span>${t("WITCHER.Chrome.Bestiary.Text.GMOverlay", "GM Overlay")}</span><span class="wou-bst-bypass-state">${gmReveal ? t("WITCHER.Chrome.Bestiary.Text.OnState", "ON") : t("WITCHER.Chrome.Bestiary.Text.OffState", "OFF")}</span></button>` : ""}
        ${isGM ? `<button class="wou-bst-populate" type="button" data-action="populate" title="${t("WITCHER.Chrome.Bestiary.Text.ChooseWhichCompendiumPacksFeedTheBestiar", "Choose which compendium packs feed the bestiary")}">${t("WITCHER.Chrome.Bestiary.Text.Populate", "Populate")}</button>` : ""}
        ${isGM && gmReveal ? renderBestiaryViewAsPicker() : ""}
        ${isGM && gmReveal ? `<button class="wou-bst-gm-destructive" type="button" data-action="wipe-research" title="${t("WITCHER.Chrome.Bestiary.Text.WipeAllPCsResearchProgressResearchTierRP", "Wipe all PCs' research progress (research tier + RP) for every entry")}"><i class="fa-solid fa-flask"></i><span>${t("WITCHER.Chrome.Bestiary.Text.WipeResearch", "Wipe Research")}</span></button>` : ""}
        ${isGM && gmReveal ? `<button class="wou-bst-gm-destructive" type="button" data-action="wipe-encounters" title="${t("WITCHER.Chrome.Bestiary.Text.WipeAllPCsEncounterLogsForEveryEntry", "Wipe all PCs' encounter logs for every entry")}"><i class="fa-solid fa-paw"></i><span>${t("WITCHER.Chrome.Bestiary.Text.WipeEncounters", "Wipe Encounters")}</span></button>` : ""}
      </div>
    </header>

    <div class="wou-bst-body">
      <section class="wou-bst-left">
        ${renderFilterChips(all)}
        <div class="wou-bst-list">
          ${visible.length
            ? visible.map(renderCard).join("")
            : `<div class="wou-bst-empty">${t("WITCHER.Chrome.Bestiary.Text.NoEntriesMatchThisFilter", "No entries match this filter.")}</div>`}
        </div>
      </section>

      <div class="wou-bst-divider"></div>

      <section class="wou-bst-detail" data-bind="detail">
        ${activeKey ? renderDetail(activeKey, all) : `<div class="wou-bst-detail-empty">${t("WITCHER.Chrome.Bestiary.Text.SelectAnEntryToViewDetails", "Select an entry to view details.")}</div>`}
      </section>
    </div>

    <button class="wou-bst-close" type="button" data-action="close" title="${t("WITCHER.Chrome.Bestiary.Text.Collapse", "Collapse")}">
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
  const agg = t("WITCHER.Chrome.Bestiary.Text.Aggregated", "Aggregated");
  return `<div class="wou-viewtools">${renderViewPanelAsPicker("bestiary", { defaultLabel: agg })}${renderSharedViewAsPicker({ defaultLabel: agg })}</div>`;
}

/* Filter chip row — All / Pinned / Researched / monster types present in
 * the entry list (we don't show empty type chips). */
/* Keyed by the CANONICAL category value stored on system.category
 * (lowercase camelCase — see MONSTER_TYPES in config.mjs), NOT the PascalCase
 * i18n suffix. monsterCategory() and applyFilter() both compare against this
 * stored value, so the keys must match it exactly or no type chips appear. */
const MONSTER_TYPE_META = () => ({
  humanoid:   { icon: "fa-user",     label: t("WITCHER.Chrome.Bestiary.Dialog.Button.Humanoid", "Humanoid") },
  necrophage: { icon: "fa-skull",    label: t("WITCHER.Chrome.Bestiary.Dialog.Button.Necrophage", "Necrophage") },
  specter:    { icon: "fa-ghost",    label: t("WITCHER.Chrome.Bestiary.Dialog.Button.Specter", "Specter") },
  beast:      { icon: "fa-paw",      label: t("WITCHER.Chrome.Bestiary.Dialog.Button.Beast", "Beast") },
  cursedOne:  { icon: "fa-moon",     label: t("WITCHER.Chrome.Bestiary.Dialog.Button.CursedOne", "Cursed One") },
  hybrid:     { icon: "fa-crow",     label: t("WITCHER.Chrome.Bestiary.Dialog.Button.Hybrid", "Hybrid") },
  insectoid:  { icon: "fa-spider",   label: t("WITCHER.Chrome.Bestiary.Dialog.Button.Insectoid", "Insectoid") },
  elementa:   { icon: "fa-cube",     label: t("WITCHER.Chrome.Bestiary.Dialog.Button.Elementa", "Elementa") },
  relict:     { icon: "fa-tree",     label: t("WITCHER.Chrome.Bestiary.Dialog.Button.Relict", "Relict") },
  ogroid:     { icon: "fa-mountain", label: t("WITCHER.Chrome.Bestiary.Dialog.Button.Ogroid", "Ogroid") },
  draconid:   { icon: "fa-dragon",   label: t("WITCHER.Chrome.Bestiary.Dialog.Button.Draconid", "Draconid") },
  vampire:    { icon: "fa-droplet",  label: t("WITCHER.Chrome.Bestiary.Dialog.Button.Vampire", "Vampire") }
});

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
    { id: "all",        label: t("WITCHER.Common.All", "All"),        icon: "fa-layer-group" },
    { id: "pinned",     label: t("WITCHER.Chrome.Bestiary.Dialog.Button.Pinned", "Pinned"),     icon: "fa-thumbtack" },
    { id: "researched", label: t("WITCHER.Chrome.Bestiary.Dialog.Button.Researched", "Researched"), icon: "fa-book-skull" },
  ];
  const monsterTypeMeta = MONSTER_TYPE_META();
  const typeChips = Object.keys(monsterTypeMeta)
    .filter(t => revealedTypes.has(t))
    .map(t => ({ id: t, label: monsterTypeMeta[t].label, icon: monsterTypeMeta[t].icon }));
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
  /* Route the raw canonical category (lowercase camelCase — "necrophage",
   * "cursedOne") through MONSTER_TYPE_META so the card subtitle matches
   * the filter-chip casing (t("WITCHER.Chrome.Bestiary.Dialog.Button.Necrophage", "Necrophage"), t("WITCHER.Chrome.Bestiary.Dialog.Button.CursedOne", "Cursed One")). Falls back to
   * the raw value if a monster ships an unrecognized category. */
  const typeLabel = entry.type ? (MONSTER_TYPE_META()[entry.type]?.label ?? entry.type) : "—";
  const typePart = showName
    ? escapeText(showType ? typeLabel : "")
    : (encCount > 0 ? `<em>???</em>` : `<em>${t("WITCHER.Chrome.Bestiary.Text.Unresearched", "Unresearched")}</em>`);
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
  if (!entry) return `<div class="wou-bst-detail-empty">${t("WITCHER.Chrome.Bestiary.Text.EntryNotFound", "Entry not found.")}</div>`;
  const s = getViewerEntryState(key);
  const peek = game.user?.isGM && gmReveal;
  const showImage = peek || s.research >= 1;
  const showName  = peek || s.research >= 2;
  const showType  = peek || s.research >= 2;
  const encCount  = getEncounterCount(key);
  const killCount = getKillCount(key);
  /* Vertical stack (top → bottom): well-sized portrait, then the identity
   * (name/type) + research controls (RP level, progress bar, level-up, pin),
   * then the encounter + confirmed-kill counters, then the tier body (Field
   * Notes render horizontally; see renderQuickStats + bestiary.css). */
  const body = renderDetailTierBody(entry, peek ? { ...s, research: MAX_RESEARCH } : s);
  /* Two columns. LEFT = big, frameless portrait with the reference stats stacked
   * under it (Field Notes, Resistances, Immunities, Vulnerabilities, Autopsy). RIGHT =
   * everything else — name/type, controls (pin / level-up / RP), counters, then
   * the long-form content (Common Knowledge, Special Abilities, the rest). */
  return `
    <div class="wou-bst-detail-top">
      <div class="wou-bst-detail-left">
        <div class="wou-bst-detail-portrait">${entry.img && showImage ? `<img src="${escapeAttr(entry.img)}" alt="" />` : `<i class="fa-solid fa-question"></i>`}</div>
        <div class="wou-bst-detail-side">${body.side}</div>
      </div>
      <div class="wou-bst-detail-right">
        <div class="wou-bst-detail-id">
          <div class="wou-bst-detail-name">${escapeText(showName ? entry.name : "???")}</div>
          <div class="wou-bst-detail-type">${escapeText(showType ? (entry.type ? (MONSTER_TYPE_META()[entry.type]?.label ?? entry.type) : "") : "")}</div>
          ${renderDetailControls(key, s)}
        </div>
        <div class="wou-bst-detail-counters">
          <div class="wou-bst-counter">
            <span class="wou-bst-counter-k">${t("WITCHER.Chrome.Bestiary.Text.Encounters", "Encounters")}</span>
            <span class="wou-bst-counter-v">${encCount}</span>
          </div>
          <div class="wou-bst-counter">
            <span class="wou-bst-counter-k">${t("WITCHER.Chrome.Bestiary.Text.ConfirmedKills", "Confirmed Kills")}</span>
            <span class="wou-bst-counter-v">${killCount}</span>
          </div>
        </div>
        <div class="wou-bst-detail-body">${body.main}${renderEncounterTimeline(key)}</div>
      </div>
    </div>
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

  /* Resolve the monster doc to turn fact ids into actual values. Prefer the
   * already-loaded `entry.doc` (populated by ensureFullDoc via async fromUuid) —
   * `fromUuidSync` returns null for an unindexed COMPENDIUM monster, which used
   * to make the whole Autopsy section silently vanish for compendium creatures. */
  const monster = entry.doc ?? fromUuidSync(entry.uuid, { strict: false });
  if (!monster) return "";

  const set = new Set(facts);
  const weaponBlock  = renderKnownWeapons(monster, set);
  const statsBlock   = renderKnownStats(monster, set);
  const skillsBlock  = renderKnownSkills(monster, set);
  const mutagenBlock = mutagenRevealed ? renderKnownMutagen(monster) : "";

  if (!weaponBlock && !statsBlock && !skillsBlock && !mutagenBlock) return "";

  /* Header doubles as the collapse toggle (see the "toggle-autopsy" case in
   * onClick); the body is hidden by the `is-collapsed` class, not inline
   * styles, so the click handler can flip it without re-rendering. */
  const collapsed = _autopsyCollapsed;
  const title = collapsed
    ? t("WITCHER.Chrome.Bestiary.Text.ExpandNote", "Expand note")
    : t("WITCHER.Chrome.Bestiary.Text.CollapseNote", "Collapse note");
  return `
    <section class="wou-bst-tier-block wou-bst-dissect-block${collapsed ? " is-collapsed" : ""}">
      <h3 class="wou-bst-tier-head wou-bst-dissect-head">
        <button type="button" class="wou-bst-dissect-toggle" data-action="toggle-autopsy"
                title="${escapeAttr(title)}" aria-expanded="${collapsed ? "false" : "true"}">
          <i class="fa-solid ${collapsed ? "fa-chevron-right" : "fa-chevron-down"}"></i>
          <span>${t("WITCHER.Chrome.Bestiary.Text.AutopsyNotes", "Autopsy notes")}</span>
        </button>
      </h3>
      <div class="wou-bst-dissect-body">${mutagenBlock}${weaponBlock}${statsBlock}${skillsBlock}</div>
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
    : `<div class="wou-bst-mutagen-effect" style="opacity:0.6;font-style:italic;">${t("WITCHER.Chrome.Bestiary.Text.NoEffectRecorded", "No effect recorded.")}</div>`;
  return `<div class="wou-bst-dissect-group">
    <div class="wou-bst-dissect-group-head"><i class="fa-solid fa-flask-vial"></i> ${t("WITCHER.Chrome.Bestiary.Text.Mutagen", "Mutagen")}</div>
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
  const desc = autopsyDescriptive();
  const attacks = rows
    .map((atk, idx) => {
      const know = {
        name:      knownSet.has(`attack:${idx}:name`),
        damage:    knownSet.has(`attack:${idx}:damage`),
        flatBonus: knownSet.has(`attack:${idx}:flatBonus`),
        rof:       knownSet.has(`attack:${idx}:rof`),
        qualities: (Array.isArray(atk?.qualities) ? atk.qualities : [])
          .map((key, qidx) => ({ qidx, key, known: knownSet.has(`attack:${idx}:quality:${qidx}`) }))
          .filter(x => x.known)
      };
      const anyKnown = know.name || know.damage || know.flatBonus || know.rof || know.qualities.length > 0;
      if (!anyKnown) return null;
      return { atk, know };
    })
    .filter(Boolean);

  /* Natural armor (Stopping Power) — a combat characteristic, shown at the top
   * of the combat block when the autopsy has revealed it. */
  const spKnown = knownSet.has("combat:armor");
  const spVal   = Number(monster.system?.combat?.armor) || 0;
  const spRow   = spKnown
    ? `<li><span class="wou-bst-dissect-name">${t("WITCHER.Chrome.Bestiary.Text.Armor", "Armor")}</span><span class="wou-bst-dissect-tag">${desc ? escapeText(describeSP(spVal)) : `SP ${spVal}`}</span></li>`
    : "";

  if (!attacks.length && !spKnown) return "";

  return `<div class="wou-bst-dissect-group">
    <div class="wou-bst-dissect-group-head"><i class="fa-solid fa-khanda"></i> ${t("WITCHER.Chrome.Bestiary.Text.Attacks", "Attacks")}</div>
    <ul class="wou-bst-dissect-list">
      ${spRow}
      ${attacks.map(({ atk, know }) => {
        const name   = know.name   ? escapeText(atk.name || t("WITCHER.Chrome.Bestiary.Text.Attack", "Attack")) : `<em>${t("WITCHER.Chrome.Bestiary.Text.UnknownAttack", "unknown attack")}</em>`;
        /* BASE is the legacy flat to-hit number — hidden in immersive mode
         * (it's a raw number) and only ever present on legacy flat-bonus data. */
        const base   = (() => {
          if (!know.flatBonus || desc) return "";
          const v = Number(atk.flatBonus) || 0;
          return `<span class="wou-bst-dissect-tag">BASE ${v >= 0 ? "+" : ""}${escapeText(String(v))}</span>`;
        })();
        const dmg    = know.damage ? `<span class="wou-bst-dissect-tag">${desc ? escapeText(describeDamage(atk.damage)) : `DMG ${escapeText(String(atk.damage ?? "?"))}`}</span>` : "";
        const rof    = know.rof    ? `<span class="wou-bst-dissect-tag">${desc ? escapeText(describeRof(atk.rof)) : `ROF ${escapeText(String(atk.rof ?? "?"))}`}</span>` : "";
        const quals  = know.qualities.map(x =>
          `<span class="wou-bst-dissect-tag is-quality">${escapeText(qualityLabelFor(x.key, atk.qualityValues, desc))}</span>`
        ).join("");
        return `<li><span class="wou-bst-dissect-name">${name}</span>${base}${dmg}${rof}${quals}</li>`;
      }).join("")}
    </ul>
  </div>`;
}

function qualityLabelFor(key, qualityValues, descriptive = false) {
  if (!key) return "?";
  const catalog = CONFIG.WITCHER?.weapon?.qualities ?? {};
  const entry = catalog[key];
  const label = entry?.label ? game.i18n.localize(entry.label) : String(key);
  const val = qualityValues?.[key];
  const suffix = entry?.param?.suffix ?? "";
  if (descriptive) {
    /* Immersive mode keeps the quality's NAME. A % param (Bleeding 50%) becomes
     * a 25%-bracket likelihood word ("Bleeding (Likely)"); any other numeric
     * param is dropped entirely. */
    if (suffix === "%" && val != null && String(val).trim() !== "") {
      const word = describeChance(val);
      return word ? `${label} (${word})` : label;
    }
    return label;
  }
  if (val != null && String(val).trim()) {
    return `${label} ${val}${suffix}`;
  }
  return label;
}

/* Immersive autopsy (bestiary.autopsyDescriptive): render a revealed VALUE as a
 * descriptive adjective instead of a raw number, so the entry reads like lore
 * ("Masterful") rather than a metagame stat block ("10"). The player still
 * learns the fact — just not the literal number. Toggle in the bestiary config. */
function autopsyDescriptive() {
  try { return getSetting("bestiary.autopsyDescriptive") !== false; } catch (_) { return true; }
}
/* ── Descriptive-value brackets ─────────────────────────────────────────────
 * One central table: fixed numeric thresholds + DEFAULT band words. The words
 * are renamable per-world via the `bestiary.autopsyBrackets` setting (edit them
 * in Bestiary config → "Configure bracket names…"). words.length ===
 * thresholds.length + 1 — the last word is the open-ended TOP band (anything
 * above the final threshold). `Rof` is a special exact match (1 / 2 / 3 / else). */
const BRACKET_DEFS = {
  Stat:      { label: "Stats",           thresholds: [0, 2, 4, 6, 8, 10, 13],       words: ["None", "Poor", "Below Average", "Capable", "Skilled", "Masterful", "Superhuman", "Inconceivable"] },
  SkillRank: { label: "Skill ranks",     thresholds: [2, 4, 6, 8], clamp: [1, 10],  words: ["Novice", "Journeyman", "Advanced", "Expert", "Master"] },
  Hp:        { label: "HP",              thresholds: [15, 30, 45, 60, 75, 90, 105], words: ["Frail", "Hardy", "Tough", "Rugged", "Formidable", "Mighty", "Monstrous", "Titanic"] },
  Sta:       { label: "Stamina",         thresholds: [15, 30, 45, 60, 75, 90, 105], words: ["Fleeting", "Steady", "Enduring", "Vigorous", "Relentless", "Stalwart", "Prodigious", "Inexhaustible"] },
  Wound:     { label: "Wound Threshold", thresholds: [3, 6, 9, 12],                 words: ["Fragile", "Sturdy", "Tough", "Formidable", "Immense"] },
  Stun:      { label: "Stun",            thresholds: [2, 4, 6, 8],                  words: ["Fragile", "Shakable", "Steady", "Resolute", "Unshakable"] },
  SP:        { label: "Armor (SP)",      thresholds: [5, 10, 15, 20, 25, 30],       words: ["Negligible", "Light", "Moderate", "Heavy", "Reinforced", "Formidable", "Impenetrable"] },
  Damage:    { label: "Damage",          thresholds: [5, 10, 15, 22, 30],           words: ["Feeble", "Modest", "Dangerous", "Brutal", "Devastating", "Unspeakable"] },
  Rof:       { label: "Rate of fire",    exact: [1, 2, 3],                          words: ["Strikes once", "Strikes twice", "Strikes thrice", "Strikes repeatedly"] },
  Chance:    { label: "Quality chance",  thresholds: [25, 50, 75],                  words: ["Unlikely", "Likely", "Very likely", "Certain"] }
};

/* GM-edited word overrides (blank/missing → default word). */
function customBrackets() {
  try { const v = getSetting("bestiary.autopsyBrackets"); return (v && typeof v === "object") ? v : {}; }
  catch (_) { return {}; }
}
/* Effective (custom-or-default) word list for a namespace. */
function bracketWords(ns) {
  const def = BRACKET_DEFS[ns];
  if (!def) return [];
  const custom = customBrackets()[ns];
  return def.words.map((w, i) => {
    const c = Array.isArray(custom) ? custom[i] : undefined;
    return (typeof c === "string" && c.trim()) ? c.trim() : w;
  });
}
/* Threshold pick — first band whose ceiling ≥ value, else the open top band. */
function bandFor(ns, n) {
  const def = BRACKET_DEFS[ns];
  const v = Number(n);
  if (!def || !Number.isFinite(v)) return String(n ?? "?");
  const words = bracketWords(ns);
  const idx = def.thresholds.findIndex(th => v <= th);
  return idx === -1 ? words[words.length - 1] : words[idx];
}

/* STATS — 9 core stats (0–10, monsters can exceed). */
function describeStat(n) { return bandFor("Stat", n); }
/* SKILLS — rank only, clamped 1–10, in pairs. */
function describeSkillRank(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n ?? "?");
  const [lo, hi] = BRACKET_DEFS.SkillRank.clamp;
  return bandFor("SkillRank", Math.max(lo, Math.min(hi, Math.round(v))));
}
/* DERIVED — only the four combat-relevant stats, each on its own scale. */
const DERIVED_NS = { hp: "Hp", sta: "Sta", woundThreshold: "Wound", stun: "Stun" };
function describeDerived(statKey, n) {
  const ns = DERIVED_NS[statKey];
  if (!ns) return null;                        // not a shown derived stat → drop
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return bandFor(ns, v);
}
/* SP (Stopping Power / natural armor). */
function describeSP(n) { return bandFor("SP", n); }
/* QUALITY chance % (Bleeding 50% → "Likely"), in 25% brackets. */
function describeChance(pct) {
  const v = Number(pct);
  return Number.isFinite(v) ? bandFor("Chance", v) : null;
}
/* Average of a dice string ("3d6+2" → 12.5), summing every NdM term + flat
 * modifiers. Returns NaN for anything unparseable. */
function avgDice(expr) {
  const s = String(expr ?? "").toLowerCase().replace(/\s+/g, "");
  if (!s) return NaN;
  let total = 0, matched = false;
  for (const m of s.matchAll(/([+-]?)(\d*)d(\d+)/g)) {
    matched = true;
    const sign = m[1] === "-" ? -1 : 1;
    const count = m[2] === "" ? 1 : Number(m[2]);
    total += sign * count * (Number(m[3]) + 1) / 2;
  }
  for (const m of s.replace(/[+-]?\d*d\d+/g, "").matchAll(/([+-]?)(\d+)/g)) {
    matched = true;
    total += (m[1] === "-" ? -1 : 1) * Number(m[2]);
  }
  return matched ? total : NaN;
}
/* Damage severity band, from a dice string's average. */
function describeDamage(expr) {
  const avg = avgDice(expr);
  return Number.isFinite(avg) ? bandFor("Damage", avg) : String(expr ?? "?");
}
/* Rate-of-fire as a frequency word (exact match 1 / 2 / 3, else the open top). */
function describeRof(n) {
  const v = Number(n);
  const words = bracketWords("Rof");
  const idx = BRACKET_DEFS.Rof.exact.indexOf(v);
  return idx === -1 ? words[words.length - 1] : words[idx];
}

/* The range label shown beside each editable band in the config dialog. */
function bracketRangeLabel(def, i) {
  if (def.exact) return i < def.exact.length ? String(def.exact[i]) : `${def.exact[def.exact.length - 1] + 1}+`;
  return i < def.thresholds.length ? `≤ ${def.thresholds[i]}` : `> ${def.thresholds[def.thresholds.length - 1]}`;
}

/** GM menu: rename any descriptive-value bracket. Blank field = keep the default
 *  (shown as placeholder). Persists to the `bestiary.autopsyBrackets` world
 *  setting; its onChange re-renders the open bestiary. */
export async function openBracketConfig() {
  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (!DialogV2) return;
  const custom = customBrackets();
  const sections = Object.entries(BRACKET_DEFS).map(([ns, def]) => {
    const rows = def.words.map((w, i) => {
      const cur = Array.isArray(custom[ns]) ? (custom[ns][i] ?? "") : "";
      return `<label style="display:grid;grid-template-columns:60px 1fr;gap:8px;align-items:center;margin:2px 0;">
          <span style="opacity:0.55;font-size:0.72rem;text-align:right;">${escapeText(bracketRangeLabel(def, i))}</span>
          <input type="text" name="${ns}.${i}" value="${escapeAttr(cur)}" placeholder="${escapeAttr(w)}" style="width:100%;" />
        </label>`;
    }).join("");
    return `<details style="margin:4px 0;border:1px solid var(--color-border-light-tertiary,#8884);border-radius:3px;padding:4px 8px;">
        <summary style="cursor:pointer;font-weight:bold;">${escapeText(def.label)}</summary>${rows}</details>`;
  }).join("");
  const content = `<div style="max-height:60vh;overflow:auto;font-size:0.8rem;">
      <p style="opacity:0.7;font-size:0.72rem;margin:0 0 6px;">${t("WITCHER.Chrome.Bestiary.BracketConfig.Hint", "Rename any bracket. Leave a field blank to keep the default (shown greyed). The bottom row of each group is the open-ended top band.")}</p>
      ${sections}
    </div>`;
  const collect = (form) => {
    const next = {};
    for (const [ns, def] of Object.entries(BRACKET_DEFS)) {
      const arr = def.words.map((_, i) => {
        const el = form?.elements?.[`${ns}.${i}`];
        return el ? String(el.value ?? "").trim() : "";
      });
      if (arr.some(s => s !== "")) next[ns] = arr;   // only store groups the GM actually edited
    }
    return next;
  };
  const choice = await DialogV2.wait({
    window: { title: t("WITCHER.Chrome.Bestiary.BracketConfig.Title", "Autopsy bracket names"), resizable: true },
    position: { width: 540 },
    content,
    buttons: [
      { action: "save",   label: t("WITCHER.Common.Save", "Save"), default: true, callback: (_e, btn) => ({ save: collect(btn.form) }) },
      { action: "reset",  label: t("WITCHER.Chrome.Bestiary.BracketConfig.Reset", "Reset all to defaults"), callback: () => ({ reset: true }) },
      { action: "cancel", label: t("WITCHER.Common.Cancel", "Cancel"), callback: () => null }
    ],
    rejectClose: false
  }).catch(() => null);
  if (!choice) return;
  try {
    await game.settings.set(MODULE_ID, "bestiary.autopsyBrackets", choice.reset ? {} : (choice.save ?? {}));
  } catch (err) { console.warn("[witcher-ttrpg-death-march] bracket config save failed", err); }
  rerenderIfOpen();
}

function renderKnownStats(monster, knownSet) {
  const out = [];
  const desc = autopsyDescriptive();
  for (const [k, det] of Object.entries(monster.system?.stats ?? {})) {
    /* Luck and Toxicity are never autopsy material (see dissect.js) — also skip
     * them here so any legacy dissected data doesn't surface them. */
    if (k === "luck" || k === "toxicity") continue;
    if (!knownSet.has(`stat:${k}`)) continue;
    const raw = det?.value ?? "?";
    out.push({ label: `${k.toUpperCase()}`, val: desc ? describeStat(raw) : raw });
  }
  /* Only the four combat-relevant derived stats are lifted by the autopsy; each
   * has its OWN scale (see DERIVED_NS + BRACKET_DEFS). hp/sta are pools → reveal the MAX
   * (the creature's capacity), not its current value. */
  const DERIVED_LABELS = { hp: "HP", sta: "STA", stun: "Stun", woundThreshold: "Wound Threshold" };
  for (const k of Object.keys(DERIVED_NS)) {
    const det = monster.system?.derivedStats?.[k];
    if (det == null || !knownSet.has(`derived:${k}`)) continue;
    const raw = (typeof det === "object") ? (det.max ?? det.value ?? "?") : det;
    out.push({ label: DERIVED_LABELS[k] ?? k, val: desc ? (describeDerived(k, raw) ?? String(raw)) : raw });
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
  const desc = autopsyDescriptive();
  for (const factId of knownSet) {
    if (!factId.startsWith("skill:")) continue;
    const [statKey, skillKey] = factId.slice("skill:".length).split(".");
    const sk = monster.system?.skills?.[statKey]?.[skillKey];
    if (!sk) continue;
    /* Use the localized skill label — the regex fallback can't space all-lowercase
     * keys (resistmagic → "Resist Magic", firstaid → "First Aid", …). */
    const locKey = CONFIG.WITCHER?.skillLabel?.(skillKey);
    const loc = locKey ? game.i18n.localize(locKey) : "";
    const lbl = (loc && loc !== locKey)
      ? loc
      : String(skillKey).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\b\w/g, c => c.toUpperCase());
    const raw = sk?.value ?? "?";
    out.push({ label: lbl, val: desc ? describeSkillRank(raw) : raw, stat: statKey.toUpperCase() });
  }
  if (!out.length) return "";
  return `<div class="wou-bst-dissect-group">
    <div class="wou-bst-dissect-group-head"><i class="fa-solid fa-graduation-cap"></i> ${t("WITCHER.Chrome.Bestiary.Text.SkillRanks", "Skill ranks")}</div>
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
  const isGM = !!game.user?.isGM;
  const canEdit = !!viewer || isGM;
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
    const title = escapeText(ev.title || ev.sceneName || t("WITCHER.Chrome.Bestiary.Text.Encounter", "Encounter"));
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
                 title="${collapsed ? t("WITCHER.Chrome.Bestiary.Text.ExpandNote", "Expand note") : t("WITCHER.Chrome.Bestiary.Text.CollapseNote", "Collapse note")}">
           <i class="fa-solid ${collapsed ? "fa-chevron-right" : "fa-chevron-down"}"></i>
         </button>`
      : "";
    const editBtn = canEdit
      ? `<button class="wou-bst-event-edit-btn" type="button"
                 data-action="edit-encounter"
                 data-event-id="${escapeAttr(ev.id)}"
                 data-key="${escapeAttr(key)}"
                 title="${t("WITCHER.Chrome.Bestiary.Text.EditTitleAndNote", "Edit title and note")}">
           <i class="fa-solid fa-pen"></i>
         </button>`
      : "";
    /* GM-only per-encounter delete. Removes just this event from whichever
     * PC's log owns it (see deleteEncounterAnyPC) — unlike the header's
     * "Wipe Encounters", which clears every log. */
    const deleteBtn = isGM
      ? `<button class="wou-bst-event-edit-btn wou-bst-event-delete-btn" type="button"
                 data-action="delete-encounter"
                 data-event-id="${escapeAttr(ev.id)}"
                 data-key="${escapeAttr(key)}"
                 title="${t("WITCHER.Chrome.Bestiary.Text.DeleteEncounter", "Delete this encounter")}">
           <i class="fa-solid fa-trash"></i>
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
            ${deleteBtn}
          </div>
        </div>
        ${showBody ? `<div class="wou-bst-event-body">${body}</div>` : ""}
      </div>`;
  }).join("");
  return `
    <section class="wou-bst-tier-block wou-bst-timeline-block">
      <h3 class="wou-bst-tier-head">${t("WITCHER.Chrome.Bestiary.Text.WitcherPathEncounters", "The Witcher&apos;s Path · encounters")}</h3>
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
               value="${title}" placeholder="${t("WITCHER.Chrome.Bestiary.Text.TitleEGCrookbackBog", "Title (e.g. Crookback Bog)")}" />
      </div>
      <textarea class="wou-bst-event-input-note"
                placeholder="${t("WITCHER.Chrome.Bestiary.Text.WhatHappenedAddFluffLessonsLearnedAnythi", "What happened? Add fluff, lessons learned, anything…")}">${note}</textarea>
      <div class="wou-bst-event-edit-actions">
        <button class="wou-bst-event-save" type="button"
                data-action="save-encounter"
                data-event-id="${escapeAttr(ev.id)}"
                data-key="${escapeAttr(key)}">
          <i class="fa-solid fa-check"></i>${t("WITCHER.Common.Save", "Save")}
        </button>
        <button class="wou-bst-event-cancel" type="button" data-action="cancel-encounter">
          <i class="fa-solid fa-xmark"></i>${t("WITCHER.Common.Cancel", "Cancel")}
        </button>
      </div>
    </div>`;
}

function renderOutcomeChip(outcome) {
  if (outcome === "won")  return `<span class="wou-bst-outcome wou-bst-outcome-win">${t("WITCHER.Chrome.Bestiary.Text.Cleared", "Cleared")}</span>`;
  if (outcome === "fled") return `<span class="wou-bst-outcome wou-bst-outcome-flee">${t("WITCHER.Chrome.Bestiary.Text.Fled", "Fled")}</span>`;
  if (outcome === "lost") return `<span class="wou-bst-outcome wou-bst-outcome-loss">${t("WITCHER.Chrome.Bestiary.Text.Lost", "Lost")}</span>`;
  return "";
}

function formatRelative(ts) {
  const now = game.time?.worldTime ?? 0;
  const dt  = Math.max(0, now - (ts ?? 0));
  if (dt < 60)     return t("WITCHER.Chrome.Bestiary.Text.JustNow", "just now");
  if (dt < 3600)   return tFormat("WITCHER.Chrome.Bestiary.Text.MinutesAgo", { n: Math.floor(dt / 60)    }, "{n}m ago");
  if (dt < 86400)  return tFormat("WITCHER.Chrome.Bestiary.Text.HoursAgo",   { n: Math.floor(dt / 3600)  }, "{n}h ago");
  if (dt < 604800) return tFormat("WITCHER.Chrome.Bestiary.Text.DaysAgo",    { n: Math.floor(dt / 86400) }, "{n}d ago");
  return tFormat("WITCHER.Chrome.Bestiary.Text.WeeksAgo", { n: Math.floor(dt / 604800) }, "{n}w ago");
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
               title="${(s.pinned ? t("WITCHER.Chrome.Bestiary.Text.Unpin", "Unpin") : t("WITCHER.Chrome.Bestiary.Text.Pin", "Pin"))} ${t("WITCHER.Chrome.Bestiary.Text.ThisEntry", "this entry")}">
         <i class="fa-solid fa-thumbtack"></i>${s.pinned ? t("WITCHER.Chrome.Bestiary.Dialog.Button.Pinned", "Pinned") : t("WITCHER.Chrome.Bestiary.Text.Pin", "Pin")}
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
      : t("WITCHER.Chrome.Bestiary.Text.ProgressNextTier", "Progress toward the next tier");
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
    ? `<span class="wou-bst-stars wou-bst-stars-edit" title="${t("WITCHER.Chrome.Bestiary.Text.GMOverrideClicksHereBypassTheRPCostBypas", "GM override — clicks here bypass the RP cost (Bypass-only)")}">
         ${Array.from({ length: MAX_RESEARCH }, (_, i) => i + 1).map(n =>
           `<button class="wou-bst-star-btn${n <= s.research ? " is-on" : ""}" type="button"
                    data-action="set-research" data-key="${escapeAttr(key)}" data-level="${n}"
                    title="${tFormat("WITCHER.Chrome.Bestiary.Text.SetResearchToNStars", { n, plural: n>1 ? t("WITCHER.Chrome.Bestiary.Text.PluralS","s") : "" }, "Set research to {n} star{plural}")}">★</button>`
         ).join("")}
       </span>`
    : "";

  const resetBtn = isGM
    ? `<button class="wou-bst-reset" type="button"
               data-action="reset-entry" data-key="${escapeAttr(key)}"
               title="${t("WITCHER.Chrome.Bestiary.Text.DEBUGResetThisEntrySResearchEncountersPi", "DEBUG — Reset this entry's research, encounters, pin, and RP")}">
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
 *        + Special Abilities (system.combat.specialAbilities[] + system.notes)
 *   5: + Resistances (damageProfile "resistant" + statusResistances[]) +
 *        Immunities (damageProfile "immune" + statusImmunities[])
 *   6: + RESEARCH BONUSES (expert) — "+4 to track it" and a HARDWIRED
 *        "+4 damage vs. this creature" applied in the attack pipeline
 *
 * Doc may be null for compendium entries that haven't been loaded yet — we
 * fall back to a "Loading…" placeholder; render() re-renders once it lands. */
/* Returns { side, main }:
 *   side — the compact reference (Field Notes, Resistances, Immunities,
 *          Vulnerabilities) that sits to the RIGHT of the portrait column.
 *   main — the long-form content (Common Knowledge tiers, Special Abilities,
 *          research bonuses) that sits FULL-WIDTH below both columns. */
/* A section you don't yet have access to: same header as the real one, but a
 * quiet, lore-flavoured placeholder telling you which research tier reveals it. */
function lockedSection(title, tier, icon = "fa-lock") {
  return `
    <section class="wou-bst-tier-block wou-bst-locked">
      <h3 class="wou-bst-tier-head">${escapeText(title)}</h3>
      <div class="wou-bst-locked-body">
        <i class="fa-solid ${icon}"></i>
        <span class="wou-bst-locked-note">${tFormat("WITCHER.Chrome.Bestiary.Text.LockedRevealsTier", { n: tier }, "Deeper study is needed — revealed at research tier {n}.")}</span>
      </div>
    </section>`;
}

function renderDetailTierBody(entry, s) {
  const doc = entry.doc;
  const sys = doc?.system ?? {};
  const R   = s.research;                       // viewer's research tier
  const has = (tier) => !!doc && R >= tier;     // unlocked AND the doc is loaded

  /* Every section ALWAYS renders — an unlocked one shows its content, a locked
   * one shows a quiet "revealed at tier N" card in its place. */
  const side = [];
  side.push(has(2) ? renderQuickStats(sys)           : lockedSection(t("WITCHER.Chrome.Bestiary.Text.FieldNotes", "Field Notes"),        2, "fa-scroll"));
  side.push(has(5) ? renderResistancesBlock(sys)     : lockedSection(t("WITCHER.Chrome.Bestiary.Text.Resistances", "Resistances"),      5, "fa-shield-halved"));
  side.push(has(5) ? renderImmunitiesBlock(sys)      : lockedSection(t("WITCHER.Chrome.Bestiary.Text.Immunities", "Immunities"),        5, "fa-shield"));
  side.push(has(4) ? renderSusceptibilitiesBlock(sys): lockedSection(t("WITCHER.Chrome.Bestiary.Text.Vulnerabilities", "Vulnerabilities"), 4, "fa-heart-crack"));
  /* Autopsy notes — findings from a dissection / mutagen extraction, so NOT
   * tier-gated (the knowledge comes off a table, not out of a book) and no
   * locked placeholder: it renders only once something has been revealed.
   * Last in the reference column, as a collapsible chevron section. */
  side.push(renderDissectionFacts(entry));

  const main = [];

  /* Common Knowledge — render whatever tiers are revealed / rollable, else a
   * single locked card. (A book-revealed tier can surface below tier 3.) */
  const tiers = Array.isArray(sys.knowledge) ? sys.knowledge : [];
  const knowBlocks = [];
  if (doc) tiers.forEach((tier, idx) => {
    const tierRevealed = s.knowledge?.[String(idx)]?.revealed || R >= MAX_RESEARCH;
    if (tierRevealed || R >= 3) {
      const html = renderKnowledgeBlock(tier, idx, sys, s, entry.key);
      if (html) knowBlocks.push(html);
    }
  });
  main.push(knowBlocks.length
    ? knowBlocks.join("")
    : lockedSection(t("WITCHER.Chrome.Bestiary.Text.CommonKnowledge", "Common Knowledge"), 3, "fa-book"));

  /* Special Abilities. */
  main.push(has(4) ? renderSpecialAbilitiesBlock(sys)
                   : lockedSection(t("WITCHER.Chrome.Bestiary.Text.SpecialAbilities", "Special Abilities"), 4, "fa-wand-sparkles"));

  /* Research Mastery — the two tier-6 combat bonuses. */
  main.push(has(6)
    ? renderResearchBonus({
        label:  t("WITCHER.Chrome.Bestiary.Text.4ToTrack", "+4 to Track"),
        detail: t("WITCHER.Chrome.Bestiary.Text.4ToTrackDetail", "You've mastered this creature's habits and read its every sign. Add +4 to checks made to track it."),
        icon:   "fa-paw"
      }) +
      renderResearchBonus({
        label:  t("WITCHER.Chrome.Bestiary.Text.4DamageVsThisCreature", "+4 damage vs. this Creature"),
        detail: t("WITCHER.Chrome.Bestiary.Text.4DamageDetail", "As an expert on this creature you know exactly where to strike — a flat +4 damage is added automatically on every attack against it, before any armor or resistance."),
        icon:   "fa-khanda"
      })
    : lockedSection(t("WITCHER.Chrome.Bestiary.Text.ResearchMastery", "Research Mastery"), 6, "fa-award"));

  return { side: side.filter(Boolean).join(""), main: main.filter(Boolean).join("") };
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

  const label = String(tier?.label ?? "").trim() || t("WITCHER.Chrome.Bestiary.Text.Knowledge", "Knowledge");
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
    cta = `<span class="wou-bst-knowledge-locked"><i class="fa-solid fa-lock"></i>${t("WITCHER.Chrome.Bestiary.Text.NeedsACharacterToAttempt", "Needs a character to attempt")}</span>`;
  } else if (failedHere) {
    cta = `<span class="wou-bst-knowledge-locked"><i class="fa-solid fa-lock"></i>${t("WITCHER.Chrome.Bestiary.Text.FailedAdvanceResearchToRetry", "Failed — advance research to retry")}</span>`;
  } else {
    const resolved = resolveLoreRoll(tier);
    const skillLabel = resolved?.label ?? label;
    const dc = knowledgeDcFor(tier);
    if (!resolved) {
      cta = `<span class="wou-bst-knowledge-locked"><i class="fa-solid fa-lock"></i>${t("WITCHER.Chrome.Bestiary.Text.GMNoSkillForLore", "GM hasn't set the skill for this lore")}</span>`;
    } else if (dc == null) {
      cta = `<span class="wou-bst-knowledge-locked"><i class="fa-solid fa-lock"></i>${t("WITCHER.Chrome.Bestiary.Text.GMNoDCForLore", "GM hasn't set the DC for this lore")}</span>`;
    } else {
      cta = `<button class="wou-bst-knowledge-roll" type="button"
                     data-action="attempt-knowledge"
                     data-key="${escapeAttr(key)}"
                     data-tier="${idx}"
                     title="${tFormat("WITCHER.Chrome.Bestiary.Tip.RollForLore", { skill: escapeText(skillLabel), dc }, `Roll ${escapeText(skillLabel)} (DC ${dc}) — fail and you wait for the next research tier`)}">
               <i class="fa-solid fa-dice-d10"></i>${tFormat("WITCHER.Chrome.Bestiary.Text.RollSkill", { skill: escapeText(skillLabel) }, `Roll ${escapeText(skillLabel)}`)} <span class="wou-bst-dc">${tFormat("WITCHER.Chrome.Bestiary.Text.DCN", { dc }, `DC ${dc}`)}</span>
             </button>`;
      /* Witcher Training substitutes for Monster Lore tiers. Offer it as a
       * second button so the player can pick whichever is stronger. */
      if (tier?.skill === "monster") {
        const wt = witcherTrainingSlot(viewer);
        if (wt) {
          const wtLabel = String(wt.skillName).trim() || t("WITCHER.Chrome.Bestiary.Text.WitcherTraining", "Witcher Training");
          cta += `<button class="wou-bst-knowledge-roll wou-bst-knowledge-roll-alt" type="button"
                         data-action="attempt-knowledge"
                         data-key="${escapeAttr(key)}"
                         data-tier="${idx}"
                         data-roll="witchertraining"
                         title="${tFormat("WITCHER.Chrome.Bestiary.Tip.RollWitcherTrainingForLore", { skill: escapeText(wtLabel), dc }, `Roll ${escapeText(wtLabel)} (DC ${dc}) — your Witcher training stands in for Monster Lore`)}">
                   <i class="fa-solid fa-dice-d10"></i>${tFormat("WITCHER.Chrome.Bestiary.Text.RollSkill", { skill: escapeText(wtLabel) }, `Roll ${escapeText(wtLabel)}`)} <span class="wou-bst-dc">${tFormat("WITCHER.Chrome.Bestiary.Text.DCN", { dc }, `DC ${dc}`)}</span>
                 </button>`;
        }
      }
    }
  }

  return `
    <section class="wou-bst-tier-block wou-bst-knowledge-block is-locked">
      <h3 class="wou-bst-tier-head">${escapeText(label)}</h3>
      <div class="wou-bst-knowledge-hidden">
        <p class="wou-bst-knowledge-tease"><em>${t("WITCHER.Chrome.Bestiary.Text.HeardWhispers", "You've heard whispers, but the details elude you.")}</em></p>
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
    [t("WITCHER.Chrome.Bestiary.FieldNotes.Type",        "Type"),        loc(W.types,      sys.category)],
    [t("WITCHER.Chrome.Bestiary.FieldNotes.Difficulty",  "Difficulty"),  loc(W.threat,     sys.threat?.difficulty)],
    [t("WITCHER.Chrome.Bestiary.FieldNotes.Complexity",  "Complexity"),  loc(W.complexity, sys.threat?.complexity)],
    [t("WITCHER.Chrome.Bestiary.FieldNotes.Bounty",      "Bounty"),      sys.bounty],
    [t("WITCHER.Chrome.Bestiary.FieldNotes.Environment", "Environment"), sys.descriptors?.environment],
  ].filter(([, v]) => v != null && v !== "" && v !== 0);
  if (!rows.length) return "";
  return `
    <section class="wou-bst-tier-block wou-bst-fieldnotes">
      <h3 class="wou-bst-tier-head">${t("WITCHER.Chrome.Bestiary.Text.FieldNotes", "Field Notes")}</h3>
      <div class="wou-bst-kv wou-bst-kv-horizontal">
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
        <h3 class="wou-bst-tier-head">${t("WITCHER.Chrome.Bestiary.Text.Vulnerabilities", "Vulnerabilities")}</h3>
        <p class="wou-bst-tier-empty"><em>${t("WITCHER.Chrome.Bestiary.Text.NoKnownVulnerabilities", "No known vulnerabilities.")}</em></p>
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
      <h3 class="wou-bst-tier-head">${t("WITCHER.Chrome.Bestiary.Text.Vulnerabilities", "Vulnerabilities")}</h3>
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
      <h3 class="wou-bst-tier-head">${t("WITCHER.Chrome.Bestiary.Text.Resistances", "Resistances")}</h3>
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
      <h3 class="wou-bst-tier-head">${t("WITCHER.Chrome.Bestiary.Text.Immunities", "Immunities")}</h3>
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
      <h3 class="wou-bst-tier-head">${t("WITCHER.Chrome.Bestiary.Text.SpecialAbilities", "Special Abilities")}</h3>
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
        ui.notifications?.warn(t("WITCHER.Notify.Bestiary.PinNeedsViewer", "No viewer character — pin requires an assigned character."));
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
        ui.notifications?.warn(t("WITCHER.Notify.Bestiary.SpendNeedsViewer", "No viewer character — RP is per-character, you need one to spend."));
        return;
      }
      const ok = await spendRpToAdvance(viewer, key);
      if (!ok) {
        ui.notifications?.warn(t("WITCHER.Notify.Bestiary.SpendBlocked", "Not enough research points, or already at the top tier."));
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
        ui.notifications?.warn(t("WITCHER.Notify.Bestiary.NoteNeedsViewer", "Need a viewer character to edit encounter notes."));
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
      if (!ok) ui.notifications?.warn(t("WITCHER.Notify.Bestiary.NoteSaveFailed", "Couldn't save the encounter note."));
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
    case "delete-encounter": {
      ev.preventDefault();
      if (!game.user?.isGM) return;
      const key = actionEl.dataset.key;
      const eventId = actionEl.dataset.eventId;
      if (!key || !eventId) return;
      const confirmed = await foundry.applications.api.DialogV2.confirm({
        window: { title: t("WITCHER.Dialog.Bestiary.DeleteEncounter", "Delete Encounter"), icon: "fa-solid fa-trash" },
        content: `<p>${t("WITCHER.Chrome.Bestiary.Text.DeleteThisEncounterConfirm", "Delete this encounter log entry? This can't be undone.")}</p>`,
        rejectClose: false,
        modal: true
      }).catch(() => false);
      if (!confirmed) return;
      const removed = await deleteEncounterAnyPC(key, eventId);
      if (!removed) ui.notifications?.warn(t("WITCHER.Notify.Bestiary.DeleteFailed", "Couldn't delete that encounter."));
      if (_editingEventId === eventId) _editingEventId = null;
      await render();
      return;
    }
    case "attempt-knowledge": {
      ev.preventDefault();
      const viewer = getViewerCharacter();
      if (!viewer) {
        ui.notifications?.warn(t("WITCHER.Notify.Bestiary.KnowledgeNeedsViewer", "Need a viewer character to attempt a knowledge roll."));
        return;
      }
      const key = actionEl.dataset.key;
      const tierIndex = Number(actionEl.dataset.tier);
      if (!Number.isInteger(tierIndex) || tierIndex < 0) return;
      if (!canAttemptKnowledge(viewer, key, tierIndex)) {
        ui.notifications?.warn(t("WITCHER.Notify.Bestiary.KnowledgeBlocked", "Already revealed, or waiting on the next research tier."));
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
        ui.notifications?.warn(tFormat("WITCHER.Notify.Bestiary.NoDcForTier", { monster: monsterDoc?.name ?? "This monster", tier: tierLabel }, "{monster} has no DC set for {tier}."));
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
          ui.notifications?.warn(t("WITCHER.Notify.Bestiary.NoWitcherTraining", "You no longer have Witcher Training to roll."));
          return;
        }
        if (typeof viewer.rollProfessionSkill !== "function") {
          ui.notifications?.error(t("WITCHER.Notify.Bestiary.HelperMissingProf", "System's rollProfessionSkill helper missing."));
          return;
        }
        roll = await viewer.rollProfessionSkill(wt, { dc });
      } else {
        const resolved = resolveLoreRoll(tier);
        if (!resolved) {
          ui.notifications?.error(tFormat("WITCHER.Notify.Bestiary.NoSkillFor", { tier: tierLabel }, "No way to roll for \"{tier}\" — skill not found."));
          return;
        }
        if (typeof viewer.rollSkillCheck !== "function") {
          ui.notifications?.error(t("WITCHER.Notify.Bestiary.HelperMissingSkill", "System's rollSkillCheck helper missing."));
          return;
        }
        roll = await viewer.rollSkillCheck(resolved.mapKey, dc);
      }

      const pass = Number(roll?.total ?? 0) >= dc;
      await recordKnowledgeAttempt(viewer, key, tierIndex, pass);
      return;
    }
    case "toggle-autopsy": {
      ev.preventDefault();
      _autopsyCollapsed = !_autopsyCollapsed;
      const section = actionEl.closest(".wou-bst-dissect-block");
      if (section) {
        section.classList.toggle("is-collapsed", _autopsyCollapsed);
        const icon = actionEl.querySelector("i");
        if (icon) {
          icon.classList.toggle("fa-chevron-right", _autopsyCollapsed);
          icon.classList.toggle("fa-chevron-down",  !_autopsyCollapsed);
        }
        actionEl.title = _autopsyCollapsed
          ? t("WITCHER.Chrome.Bestiary.Text.ExpandNote", "Expand note")
          : t("WITCHER.Chrome.Bestiary.Text.CollapseNote", "Collapse note");
        actionEl.setAttribute("aria-expanded", _autopsyCollapsed ? "false" : "true");
      }
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
        actionEl.title = nowCollapsed ? t("WITCHER.Chrome.Bestiary.Text.ExpandNote", "Expand note") : t("WITCHER.Chrome.Bestiary.Text.CollapseNote", "Collapse note");
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
      ui.notifications?.warn(t("WITCHER.Notify.Bestiary.ViewAsMissing", "View-as actor missing — clearing the override."));
      setViewerOverride(null);
      await render();
      return;
    }
    await updateActorEntryState(actor, key, { research: tier });
    return;
  }

  const pcs = (game.actors?.contents ?? []).filter(a => a.type === "character");
  if (!pcs.length) {
    ui.notifications?.warn(t("WITCHER.Notify.Bestiary.NoPCsToUpdate", "No player characters in the world — bestiary state is per-character, so there's nothing to update."));
    return;
  }
  for (const pc of pcs) {
    await updateActorEntryState(pc, key, { research: tier });
  }
}

/* Wipe a single entry's state on one or all PCs.  The actual delete uses the
 * ForcedDeletion operator (v14) because Foundry's setFlag deep-merges into the
 * existing flag object — setFlag("bestiary", mapMinusKey) reinstates the
 * "removed" key from the persisted value, which is why the previous version
 * of this function silently did nothing. */
async function resetEntryState(key) {
  if (!key || !game.user?.isGM) return;
  const pcs = (game.actors?.contents ?? []).filter(a => a.type === "character");
  const hits = pcs.filter(pc => getActorBestiary_(pc)[encKey(key)]);
  if (!hits.length) {
    ui.notifications?.info(t("WITCHER.Notify.Bestiary.NoStateForEntry", "No PC has state for this entry."));
    return;
  }
  const currentActor = getCurrentActor();
  const currentHasState = !!(currentActor && getActorBestiary_(currentActor)[encKey(key)]);

  const scope = await confirmWithCode({
    title: t("WITCHER.Dialog.Bestiary.ResetEntry", "Reset entry"),
    icon:  "fa-solid fa-arrow-rotate-left",
    body:  `<p>${t("WITCHER.Chrome.Bestiary.Text.WipeResearchEncounterLogPinAndKnowledgeR", "Wipe research, encounter log, pin, and knowledge-roll history for this entry.")}</p>
            <p class="wou-bst-confirm-keep">${t("WITCHER.Chrome.Bestiary.Text.Affects", "Affects")} <b>${hits.length}</b> PC${hits.length === 1 ? "" : "s"} that currently track this entry.</p>`,
    currentActor: currentHasState ? currentActor : null,
    requireCode: false,
  });
  if (!scope) return;

  const targets = scope === "current" ? [currentActor] : hits;
  for (const pc of targets) {
    if (!pc) continue;
    await pc.update({ [`flags.${MODULE_ID}.bestiary.${encKey(key)}`]: new foundry.data.operators.ForcedDeletion() });
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
    ui.notifications?.warn(t("WITCHER.Notify.Bestiary.NoActorPacks", "No Actor compendium packs are available in this world."));
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
    window: { title: t("WITCHER.Dialog.Bestiary.Populate", "Populate Bestiary"), icon: "fa-solid fa-book-skull" },
    content,
    classes: ["wou-bst-pop-dialog"],
    buttons: [
      {
        action: "save",
        label: t("WITCHER.Common.Save", "Save"),
        icon: "fa-solid fa-check",
        default: true,
        callback: (_ev, _btn, dialog) => {
          const root = dialog.element ?? dialog;
          const picked = [...root.querySelectorAll('input[name="pack"]:checked')].map(i => i.value);
          return picked;
        }
      },
      { action: "cancel", label: t("WITCHER.Common.Cancel", "Cancel"), icon: "fa-solid fa-xmark" }
    ],
    rejectClose: false
  });

  if (!Array.isArray(result)) return;  /* cancelled */
  await game.settings.set(MODULE_ID, "bestiary.sourcePacks", result);
  ui.notifications?.info(tFormat("WITCHER.Notify.Bestiary.Populated", { count: result.length, plural: result.length === 1 ? "" : "s" }, "Bestiary populated from {count} pack{plural}."));
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
    ui.notifications?.info(t("WITCHER.Notify.Bestiary.NoStateToWipe", "No PC has any bestiary state to wipe."));
    return;
  }
  const currentActor = getCurrentActor();
  const scope = await confirmWithCode({
    title: t("WITCHER.Dialog.Bestiary.WipeResearch", "Wipe Research Progress"),
    icon:  "fa-solid fa-flask",
    body:  `<p>${t("WITCHER.Chrome.Bestiary.Text.ThisWillClear", "This will clear")} <strong>research tier</strong> and <strong>research points</strong> for every entry on the selected target.</p>
            <ul class="wou-bst-confirm-ul">
              <li>Player characters in world: <b>${pcs.length}</b></li>
              <li>Tracked entries to clear (all PCs): <b>${counts}</b></li>
            </ul>
            <p class="wou-bst-confirm-keep">${t("WITCHER.Chrome.Bestiary.Text.KeptIntactPinsEncounterLogsKnowledgeRoll", "Kept intact: pins, encounter logs, knowledge-roll history.")}</p>`,
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
    ui.notifications?.info(t("WITCHER.Notify.Bestiary.NoLogsToWipe", "No encounter logs to wipe."));
    return;
  }
  const currentActor = getCurrentActor();
  const scope = await confirmWithCode({
    title: t("WITCHER.Dialog.Bestiary.WipeEncounters", "Wipe Encounter Data"),
    icon:  "fa-solid fa-paw",
    body:  `<p>${t("WITCHER.Chrome.Bestiary.Text.ThisWillClearEvery", "This will clear every")} <strong>encounter log entry</strong> on the selected target.</p>
            <ul class="wou-bst-confirm-ul">
              <li>${t("WITCHER.Chrome.Bestiary.Text.PlayerCharactersInWorld", "Player characters in world:")} <b>${pcs.length}</b></li>
              <li>${t("WITCHER.Chrome.Bestiary.Text.EncounterEventsOnAllPCs", "Encounter events on all PCs:")} <b>${encounterTotal}</b></li>
            </ul>
            <p class="wou-bst-confirm-keep">${t("WITCHER.Chrome.Bestiary.Text.KeptIntactResearchTierRPPinsKnowledgeRol", "Kept intact: research tier, RP, pins, knowledge-roll history.")}</p>`,
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
 *                   button alongside the t("WITCHER.Chrome.Bestiary.Dialog.Button.AllPCs", "All PCs") button.  When null,
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
      label: t("WITCHER.Chrome.Bestiary.Dialog.Button.AllPCs", "All PCs"),
      icon: "fa-solid fa-users",
      callback: (_ev, btn) => ({ scope: "all", code: readCode(btn) })
    });
  } else {
    buttons.push({
      action: "all",
      label: t("WITCHER.Common.Confirm", "Confirm"),
      icon: "fa-solid fa-check",
      default: true,
      callback: (_ev, btn) => ({ scope: "all", code: readCode(btn) })
    });
  }
  buttons.push({ action: "cancel", label: t("WITCHER.Common.Cancel", "Cancel"), icon: "fa-solid fa-xmark" });

  const result = await foundry.applications.api.DialogV2.wait({
    window: { title, icon: icon ?? "fa-solid fa-triangle-exclamation" },
    classes: ["wou-bst-confirm-dialog"],
    content,
    buttons,
    rejectClose: false
  }).catch(() => null);

  if (!result || result === "cancel" || !result.scope) return null;
  if (requireCode && String(result.code) !== code) {
    ui.notifications?.warn(t("WITCHER.Notify.Bestiary.WrongCode", "Wrong code — action cancelled."));
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
