/**
 * Character journal overlay.
 *
 * Per-character JournalEntry bound by flag on the actor:
 *   actor.flags["witcher-ttrpg-death-march"].journalId  — UUID of the JournalEntry
 *
 * Each notebook entry in the UI maps to one JournalEntryPage.  Tag + pin
 * state live as flags on each page:
 *   page.flags["witcher-ttrpg-death-march"].tag      — "entry" | "quest" | "lore"
 *   page.flags["witcher-ttrpg-death-march"].pinned   — boolean
 *
 * On first open the journal is auto-created and ownership cloned from the
 * actor (so the player who owns the character can read/write the journal
 * without GM hand-holding).
 *
 * Public:
 *   injectJournalPanel()  — mount the panel container (called once at ready)
 *   toggleJournal()       — show/hide; called by topbar.js
 *   setJournalOpen(open)  — explicit open/close
 *   isJournalOpen()
 */

import { getPanelActor, setPanelOverride, VIEWER_OVERRIDE_HOOK, PANEL_OVERRIDE_HOOK } from "../lib/actor.js";
import { renderViewAsPicker, wireViewAsPicker, renderViewPanelAsPicker, wireViewPanelAsPicker } from "../lib/view-as.js";

import { t, tFormat } from "../lib/i18n.js";
const MODULE_ID = "witcher-ttrpg-death-march";
const PANEL_ID  = "wou-journal";

const TAG_ENTRY  = "entry";
const TAG_QUEST  = "quest";
const TAG_LORE   = "lore";

const TAG_META = () => ({
  [TAG_ENTRY]: { label: t("WITCHER.Chrome.Journal.Dialog.Button.Entry", "Entry"), icon: "fa-pen",              badge: "E", thumb: "fa-pen" },
  [TAG_QUEST]: { label: t("WITCHER.Chrome.Journal.Dialog.Button.Quest", "Quest"), icon: "fa-route",            badge: "Q", thumb: "fa-map-location-dot" },
  [TAG_LORE]:  { label: t("WITCHER.Chrome.Journal.Dialog.Button.Lore", "Lore"),  icon: "fa-feather-pointed",  badge: "L", thumb: "fa-feather-pointed" }
});

/* Icon picker — ten themed thumbs the player can assign per entry.  Stored
 * on the page as `flags.witcher-ttrpg-death-march.icon` (FA class string).  Falls
 * back to the tag's default thumb when unset. */
const ICON_CHOICES = [
  "fa-pen",                /* writing / notes */
  "fa-skull-cow",          /* bestiary / monster note */
  "fa-map-location-dot",   /* place / quest */
  "fa-feather-pointed",    /* lore / legend */
  "fa-coins",              /* trade / money */
  "fa-horse",              /* travel / mount */
  "fa-flask",              /* alchemy / potion */
  "fa-scroll",             /* contract / formal doc */
  "fa-wand-sparkles",      /* magic / spell */
  "fa-envelope-open-text", /* letter / correspondence */
];

let panelEl = null;
let hooksWired = false;
let _chromeResizeObs = null;
let _chromeMutationObs = null;
const CHROME_SELECTORS = ["#wou-top-bar", "#wou-dock", "#scene-controls", "#sidebar"];

/* In-memory UI state (per session, not persisted) */
let activeFilter = "all";   // "all" | "pinned" | tag id
let activeSearch = "";      // text in the journal search box (filters by page name)
let _searchTimer = null;    // debounce handle for input → re-render
let activePageId = null;
let activeSection = "personal";  // "personal" | "relationships" | "timeline"
let activeRelId  = null;         // selected relationship in the Relationships pane
/* When non-null, `renderEditor` reveals the date input + Save/Cancel for
 * the matching page id. Cleared on save/cancel or when the panel closes.
 * Survives re-renders (which happen on every doc update), unlike a DOM
 * class toggle would. */
let editingDatePageId = null;
/* Which event sources are visible on the Timeline tab.  Defaults to all on
 * — user toggles chips at the top of the pane to filter. */
const activeTimelineFilters = new Set(["life", "journal", "relationship", "bestiary"]);

/* Horizontal zoom of the timeline track (1 = fit to width). Widening the track
 * spreads the percentage-positioned events out and the wrap scrolls. Per-session. */
let timelineZoom = 1;
const TL_ZOOM_MIN = 1, TL_ZOOM_FACTOR = 1.5;
/* Max zoom is computed per-render from the birth→today span so you can always
 * zoom in far enough to separate day-apart events (~30px/day at the ceiling). */
let timelineZoomMax = 12;
/* Timeline geometry stashed at render so the wheel/zoom handlers can rebuild
 * ticks + reposition without a full re-render. */
let timelineCtx = null;   // { birthOrd, span, birthYear, currentYear }
/* Smooth-zoom animation state — timelineZoom eases toward tlZoomTarget each
 * frame while keeping the anchor point (cursor / view centre) pinned. */
let tlZoomTarget = 1;
let tlZoomAnchorFrac = 0.5;   // timeline fraction to hold under the anchor
let tlZoomAnchorX = 0;        // px from the wrap's left edge to hold it at
let tlZoomRAF = 0;
let tlLastTickSig = "";       // granularity band of the last tick rebuild
let tlPanEase = false;        // ease the scroll too (fly-to-event), vs. hard-anchor (wheel)
/* Lane-layout perf caches — the event-stacking pass is the timeline's hot loop,
 * so we cache the sorted branch list (rebuilt only when the track element is
 * replaced) and throttle the pass so a fast zoom doesn't re-run it every frame. */
let _tlBranches = null;        // cached [{el, pct, lane}] sorted by pct
let _tlBranchTrack = null;     // the .jnl-tl-track the cache belongs to
let _tlLastLaneTrackPx = -1;   // trackPx at the last lane pass (skip if unchanged)
let _tlLastLaneTime = 0;       // performance.now() of the last lane pass (time throttle)
/* Wheel-zoom coalescing — a fast scroll fires many wheel events per frame; we
 * accumulate the factor and apply ONE zoom (one layout read) per frame. */
let _tlWheelAccum = 1;
let _tlWheelX = 0;
let _tlWheelRAF = 0;
/* Cached wrap width. The track scales during a zoom, but the WRAP (the scroll
 * viewport) does not — so reading its clientWidth once per animation instead of
 * every frame removes a forced synchronous reflow of the (potentially 100k-px-
 * wide) track on each frame. Invalidated on render + window resize. */
let _tlWrapPx = 0;
let _tlWrapLeft = 0;   // wrap's viewport-left (for cursor→track-local anchor math)
/* Actual track geometry, measured (NOT assumed from clientWidth×zoom). The wrap
 * has horizontal PADDING, so the track's %-width resolves against a smaller
 * content box — computing trackPx as clientWidth×zoom overshoots by padding×zoom,
 * which at high zoom pushes the visible-window fraction past 1 and renders zero
 * ticks. These are measured once per settle/resize and scale linearly with zoom. */
let _tlBasis = 0;       // track content width PER zoom unit (offsetWidth / zoom)
let _tlTrackLeft = 0;   // track's left offset within the scroll space (wrap's left pad)
let _tlScrollExtra = 0; // scrollWidth − track offsetWidth (left+right padding)
/* Scroll position we last WROTE — tracked so the zoom animation reads its own
 * committed value instead of `wrap.scrollLeft` (another forced layout flush). */
let _tlScrollLeft = 0;
/* Fraction of a viewport painted BEYOND each visible edge, so a pan/zoom doesn't
 * flash a bare gap before the next tick repaint. */
const TL_TICK_WINDOW_MARGIN = 0.6;
/* Pan repaint coalescing — one tick repaint + observed-year update per frame. */
let _tlPanRAF = 0;

/* Full-screen ("focus") editing: hides the entry list + hero chrome so the
 * editor fills the journal window for distraction-free typing. Per-session. */
let editorFocus = false;
/* Per-session edit mode: relationships are read-only by default so a click
 * on a row reliably selects it (instead of dropping into a text input).
 * Press the pencil to flip the row into edit mode (name/type become real
 * inputs and the right pane fields unlock); press the checkmark to commit
 * and exit.  No persistence — edit state resets on reload. */
const editingRelIds = new Set();

/* Relationship types — preset list for the dropdown.  Free-text "Other"
 * isn't in the list; users who need something unusual can type it into
 * the underlying select via browser autocomplete on the option list. */
const RELATIONSHIP_TYPES = [
  "Lover",
  "Family",
  "Friend",
  "Acquaintance",
  "Ally",
  "Mentor",
  "Rival",
  "Enemy",
  "It's Complicated",
  "Stranger",
];
const RELATIONSHIP_KEYS = {
  "Lover":            "WITCHER.Chrome.Journal.Relation.Lover",
  "Family":           "WITCHER.Chrome.Journal.Relation.Family",
  "Friend":           "WITCHER.Chrome.Journal.Relation.Friend",
  "Acquaintance":     "WITCHER.Chrome.Journal.Relation.Acquaintance",
  "Ally":             "WITCHER.Chrome.Journal.Relation.Ally",
  "Mentor":           "WITCHER.Chrome.Journal.Relation.Mentor",
  "Rival":            "WITCHER.Chrome.Journal.Relation.Rival",
  "Enemy":            "WITCHER.Chrome.Journal.Relation.Enemy",
  "It's Complicated": "WITCHER.Chrome.Journal.Relation.ItsComplicated",
  "Stranger":         "WITCHER.Chrome.Journal.Relation.Stranger",
};
const relationLabel = (id) => t(RELATIONSHIP_KEYS[id] ?? "", id);

/* Image extensions accepted by the portrait picker.  Anything else gets
 * rejected with a notification — keeps the actor's data clean and avoids
 * accidentally pointing the portrait at a scene/audio asset. */
const PORTRAIT_EXTS = ["png", "jpg", "jpeg", "webp"];

/* Relationships are stored as a flat array on the actor under
 *   actor.flags["witcher-ttrpg-death-march"].relationships
 *
 * Each entry has grown well beyond the original card shape:
 *   {
 *     id, name, type,
 *     portrait,                    // file path (FilePicker)
 *     fullName, age, gender, homeland,
 *     personalityTags: string[],
 *     bio,
 *     events: [{ id, date, title, body }]
 *   }
 *
 * No `locked` field — read-only-by-default is a UI mode (editingRelIds),
 * not persistent data.  Missing fields default safely; we never write
 * defaults back unless the user actually types into them, so the flag
 * stays lean.  Older records carrying a `locked` field are ignored. */
const REL_FLAG = "relationships";
function getRelationships(actor) {
  const raw = actor?.getFlag?.(MODULE_ID, REL_FLAG);
  return Array.isArray(raw) ? raw : [];
}
function getRelationship(actor, id) {
  return getRelationships(actor).find(r => r.id === id) ?? null;
}
async function setRelationships(actor, list) {
  if (!actor) return;
  await actor.setFlag(MODULE_ID, REL_FLAG, list);
}
async function addRelationship(actor) {
  const list = getRelationships(actor);
  const fresh = {
    id: foundry.utils.randomID(),
    name: "",
    type: "",
    portrait: "",
    fullName: "",
    age: 0,
    gender: "",
    homeland: "",
    personalityTags: [],
    bio: "",
    events: [],
  };
  list.push(fresh);
  await setRelationships(actor, list);
  /* Auto-select + auto-enter edit mode for a freshly-added entry so the
   * user can immediately type the name without needing to click pencil. */
  activeRelId = fresh.id;
  editingRelIds.add(fresh.id);
}

/** Snapshot the "relevant information" from an actor into the flat
 *  relationship record shape. Called by the drag-and-drop importer;
 *  the result becomes a NEW journal entry that lives independently
 *  from the source actor (edits on the actor don't propagate back).
 *
 *  Field mapping per actor type:
 *    character → gender, general.{age,homeland,background}
 *    monster   → descriptors.environment (as homeland — closest
 *                semantic fit), system.notes as bio
 *    merchant  → system.description as bio (no gender / age / homeland
 *                on this actor type)
 *
 *  Unmapped fields default to blank so the user can fill them in.
 *  `type` is left blank so the user picks the relationship type
 *  (friend / ally / rival / etc.) without a default guess. */
function snapshotActorToRelationship(source) {
  if (!source) return null;
  const sys = source.system ?? {};
  let gender = "", age = 0, homeland = "", bio = "";
  switch (source.type) {
    case "character":
      gender   = String(sys.gender ?? "");
      age      = Number(sys.general?.age) || 0;
      homeland = String(sys.general?.homeland ?? "");
      bio      = String(sys.general?.background ?? "");
      break;
    case "monster":
      /* Monsters don't have gender/age fields — those stay blank.
       * `descriptors.environment` is the closest analogue to
       * "homeland" (where the creature lives / hunts). */
      homeland = String(sys.descriptors?.environment ?? "");
      bio      = String(sys.notes ?? "");
      break;
    case "merchant":
      bio = String(sys.description ?? "");
      break;
    default:
      /* Unknown actor type — still take name+portrait+notes if any. */
      bio = String(sys.notes ?? sys.description ?? sys.general?.background ?? "");
  }
  return {
    id: foundry.utils.randomID(),
    name: source.name ?? "",
    type: "",
    portrait: source.img ?? "",
    fullName: source.name ?? "",
    age,
    gender,
    homeland,
    personalityTags: [],
    bio,
    events: []
  };
}

/** Push an actor-derived relationship onto the target actor's flag.
 *  Duplicates are allowed (you might want two "Yennefers" for
 *  different in-fiction timeframes); user can delete extras. Selects
 *  the freshly-imported entry so the detail panel opens on it, but
 *  does NOT auto-enter edit mode — the fields are already populated
 *  from the actor, so the user can review before tweaking. */
async function addRelationshipFromActor(actor, source) {
  if (!actor || !source) return false;
  const snap = snapshotActorToRelationship(source);
  if (!snap) return false;
  const list = getRelationships(actor);
  list.push(snap);
  await setRelationships(actor, list);
  activeRelId = snap.id;
  return true;
}
async function updateRelationship(actor, id, patch) {
  const list = getRelationships(actor);
  const idx = list.findIndex(r => r.id === id);
  if (idx === -1) return;
  const prev = list[idx];
  /* Skip writes where nothing actually changed — avoids hook-driven
   * re-render churn while the user is typing into siblings. */
  const same = Object.entries(patch).every(([k, v]) => {
    const pv = prev[k];
    if (Array.isArray(pv) || Array.isArray(v)) {
      return JSON.stringify(pv ?? []) === JSON.stringify(v ?? []);
    }
    return String(pv ?? "") === String(v ?? "");
  });
  if (same) return;
  list[idx] = { ...prev, ...patch };
  await setRelationships(actor, list);
}
async function deleteRelationship(actor, id) {
  const list = getRelationships(actor).filter(r => r.id !== id);
  await setRelationships(actor, list);
  if (activeRelId === id) activeRelId = null;
  editingRelIds.delete(id);
}

/* Relationship event helpers — same shape as character bio life events
 * but stored INSIDE the relationship object instead of system schema. */
async function addRelationshipEvent(actor, relId) {
  const rel = getRelationship(actor, relId);
  if (!rel) return null;
  const evt = { id: foundry.utils.randomID(), date: "", location: "", title: "", body: "" };
  const events = Array.isArray(rel.events) ? [...rel.events, evt] : [evt];
  await updateRelationship(actor, relId, { events });
  return evt;
}
async function updateRelationshipEvent(actor, relId, eventId, patch) {
  const rel = getRelationship(actor, relId);
  if (!rel) return;
  const events = Array.isArray(rel.events) ? [...rel.events] : [];
  const idx = events.findIndex(e => e.id === eventId);
  if (idx === -1) return;
  const prev = events[idx];
  const same = Object.entries(patch).every(([k, v]) => String(prev[k] ?? "") === String(v ?? ""));
  if (same) return;
  events[idx] = { ...prev, ...patch };
  await updateRelationship(actor, relId, { events });
}
async function deleteRelationshipEvent(actor, relId, eventId) {
  const rel = getRelationship(actor, relId);
  if (!rel) return;
  const events = (rel.events ?? []).filter(e => e.id !== eventId);
  await updateRelationship(actor, relId, { events });
}

/* =========================================================================
   PUBLIC API
   ========================================================================= */

export function injectJournalPanel() {
  if (document.getElementById(PANEL_ID)) return;
  const el = document.createElement("main");
  el.id = PANEL_ID;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", t("WITCHER.Chrome.Journal.Text.Journal", "Journal"));
  document.body.appendChild(el);
  panelEl = el;

  /* Re-render on relevant document mutations.  Wire once. */
  if (!hooksWired) {
    Hooks.on("updateJournalEntry", (j) => { if (isOurs(j))           rerenderIfOpen(); });
    Hooks.on("createJournalEntryPage", (p) => { if (isOurs(p?.parent)) rerenderIfOpen(); });
    Hooks.on("updateJournalEntryPage", (p) => { if (isOurs(p?.parent)) rerenderIfOpen(); });
    Hooks.on("deleteJournalEntryPage", (p) => { if (isOurs(p?.parent)) rerenderIfOpen(); });
    Hooks.on("updateUser",  (u) => { if (u.id === game.user.id)       rerenderIfOpen(); });
    Hooks.on("updateActor", (a) => { if (a.id === getActor()?.id) rerenderIfOpen(); });
    /* GM picked a different "view as" target — swap to that actor's journal. */
    Hooks.on(VIEWER_OVERRIDE_HOOK, () => rerenderIfOpen());
    Hooks.on(PANEL_OVERRIDE_HOOK, (key) => { if (key === "journal") rerenderIfOpen(); });
    window.addEventListener("resize", positionBounds, { passive: true });
    wireChromeObservers();
    hooksWired = true;
  }

  /* Wire the GM "View as" picker.  Idempotent — the helper guards against
   * double-binding via its own flag. */
  wireViewAsPicker(el, () => rerenderIfOpen());
  wireViewPanelAsPicker(el, "journal", () => rerenderIfOpen());
}

/** Position the panel imperatively based on actual chrome edges.  Sits
 *  between the topbar (when open) and the dock; shrinks horizontally when
 *  the left or right side panels open.  When side panels are closed the
 *  panel extends edge-to-edge — matches the inventory panel's behavior. */
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

  panelEl.style.top = `calc(${top}px / var(--wdm-size-journal, var(--wdm-chrome-bars-scale, 1)))`;
  panelEl.style.bottom = `calc(${bottom}px / var(--wdm-size-journal, var(--wdm-chrome-bars-scale, 1)))`;
  panelEl.style.left = `calc(${left}px / var(--wdm-size-journal, var(--wdm-chrome-bars-scale, 1)))`;
  panelEl.style.right = `calc(${right}px / var(--wdm-size-journal, var(--wdm-chrome-bars-scale, 1)))`;

  /* Pin the close-arrow chevron to the center of the topbar Journal tab so it
   * always reads as "this is what closes the panel you just opened". Stored
   * as a CSS variable on panelEl so styles can `left: var(--jnl-close-x)`
   * relative to the panel's own origin (offset by the measured `left`). */
  const tab = document.querySelector('#wou-top-bar [data-tab="journal"]');
  if (tab) {
    const tabRect = tab.getBoundingClientRect();
    const tabCenterX = tabRect.left + tabRect.width / 2;
    /* Panel is inside the scaled container, so its own coord system is
     * shrunk by --wdm-scale. Divide the viewport-pixel offset by scale
     * so the chevron lands under the topbar tab visually regardless of
     * UI scale — mirrors the fix in inventory.js. */
    panelEl.style.setProperty("--jnl-close-x", `calc(${tabCenterX - left}px / var(--wdm-size-journal, var(--wdm-chrome-bars-scale, 1)))`);
  }

  /* The panel just resized → the timeline wrap width changed. Drop the cached
   * width and, if the timeline is showing, repaint ticks/lanes against the new
   * size (refreshTimelineTicks re-measures once). */
  invalidateTlWrapPx();
  if (activeSection === "timeline" && !tlZoomRAF) refreshTimelineTicks();
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
    /* Body class flips (.wou-sidebar-open, .wou-topbar-open, .wou-controls-open) */
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

export async function toggleJournal() {
  if (!panelEl) injectJournalPanel();
  const willOpen = !panelEl.classList.contains("is-open");
  await setJournalOpen(willOpen);
}

export async function setJournalOpen(open) {
  if (!panelEl) injectJournalPanel();
  if (open) {
    /* One drop-down panel open at a time — close siblings if they're open.
     * Mirrors crafting.js' sibling-close pattern; without this both panels
     * can be open at once and stack visually. */
    if (document.body.classList.contains("wou-inventory-open")) {
      import("./inventory.js").then(m => m.setInventoryOpen(false)).catch(() => {});
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
    positionBounds();      /* fresh measure right before paint */
    await render();
    panelEl.classList.add("is-open");
    document.body.classList.add("wou-journal-open");
    syncTopbarTab(true);
  } else {
    panelEl.classList.remove("is-open");
    document.body.classList.remove("wou-journal-open");
    syncTopbarTab(false);
    setPanelOverride("journal", null);
  }
}

export function isJournalOpen() {
  return !!panelEl?.classList.contains("is-open");
}

/* =========================================================================
   JOURNAL BINDING
   ========================================================================= */

function getActor() {
  /* Honor the GM "view as" override; falls back to the user's assigned
   * character for players. */
  return getPanelActor("journal");
}

/** Resolve the bound JournalEntry for the actor.  Auto-create on first
 *  access; store its id back on the actor flag for future opens.  Returns
 *  null if no character is assigned or creation fails. */
async function getOrCreateJournal(actor) {
  if (!actor) return null;
  const id = actor.getFlag(MODULE_ID, "journalId");
  if (id) {
    const existing = game.journal.get(id);
    if (existing) return existing;
    /* Flag points at a stale id (entry deleted).  Fall through and recreate. */
  }
  const name = `${actor.name}'s Journal`;
  try {
    const ownership = foundry.utils.deepClone(actor.ownership ?? {});
    /* Make sure the actor's owners get OWNER on the journal too. */
    const journal = await JournalEntry.create({ name, ownership });
    if (journal) await actor.setFlag(MODULE_ID, "journalId", journal.id);
    return journal;
  } catch (e) {
    console.warn(`${MODULE_ID} | could not create journal for ${actor.name}`, e);
    ui.notifications?.warn(t("WITCHER.Notify.Journal.CreateBlocked", "Could not create journal — ask your GM to enable journal creation for players."));
    return null;
  }
}

/** Append a book's chapter to a reader's Lore journal. One page per book
 *  (matched by title + the "lore" tag); each new chapter is concatenated onto
 *  that page's content, so a novel builds up into a single growing entry.
 *  Used by the book system when a lore-flagged novel is read. Returns the
 *  page document, or null on no-journal / failure (safe no-op). The open
 *  journal panel refreshes itself via the create/update page hooks. */
export async function appendLoreEntry(actor, bookTitle, chapterHtml, { chapterLabel } = {}) {
  if (!actor || !bookTitle) return null;
  const journal = await getOrCreateJournal(actor);
  if (!journal) return null;

  const block = `${chapterLabel ? `<h3>${chapterLabel}</h3>` : ""}${chapterHtml ?? ""}`;

  /* One lore page per book — matched by exact title + the lore tag so a
   * player's other journal pages (or a same-named quest page) never collide. */
  const existing = journal.pages.contents.find(p =>
    p.name === bookTitle && p.getFlag(MODULE_ID, "tag") === TAG_LORE
  );

  try {
    if (existing) {
      const current = existing.text?.content ?? "";
      /* Idempotence guard — if this exact chapter heading is already in the
       * page (a double-fire), don't duplicate it. */
      if (chapterLabel && current.includes(`<h3>${chapterLabel}</h3>`)) return existing;
      await existing.update({ "text.content": `${current}${block}` });
      return existing;
    }
    const [created] = await journal.createEmbeddedDocuments("JournalEntryPage", [{
      name: bookTitle,
      type: "text",
      text: { content: block, format: 1 },
      flags: { [MODULE_ID]: { tag: TAG_LORE, pinned: false, createdWorldTime: Number(game.time?.worldTime) || 0, icon: "fa-feather-pointed" } }
    }]);
    return created ?? null;
  } catch (e) {
    console.warn(`${MODULE_ID} | appendLoreEntry failed`, e);
    return null;
  }
}

/** True if the journal is the one bound to the actor currently in scope
 *  (the GM view-as target or the player's own character). */
function isOurs(journal) {
  if (!journal) return false;
  const id = getActor()?.getFlag(MODULE_ID, "journalId");
  return id && journal.id === id;
}

/* =========================================================================
   RENDER
   ========================================================================= */

async function render() {
  if (!panelEl) return;
  const actor = getActor();
  if (!actor) {
    panelEl.innerHTML = renderEmptyState(t("WITCHER.Chrome.Journal.Text.NoCharacterAssigned", "No character assigned.  Assign a character to your user to use the journal."));
    return;
  }
  const journal = await getOrCreateJournal(actor);
  if (!journal) {
    panelEl.innerHTML = renderEmptyState(t("WITCHER.Chrome.Journal.Text.NoJournalAvailable", "No journal available."));
    return;
  }

  const pages = collectPages(journal);
  const filtered = filterPages(pages, activeFilter, activeSearch);
  const pinned = filtered.filter(p => isPinned(p));
  const rest   = filtered.filter(p => !isPinned(p));

  /* Auto-select first page on open if nothing selected, or the previously
   * selected page is no longer in the filtered set. */
  if (!activePageId || !filtered.some(p => p.id === activePageId)) {
    activePageId = filtered[0]?.id ?? null;
  }
  const selected = activePageId ? journal.pages.get(activePageId) : null;

  /* Tag the panel root with the active section — drives the grid-column
   * width swap so Relationships gets a wider right pane than Personal. */
  panelEl.dataset.section = activeSection;
  panelEl.innerHTML = renderShell({ journal, pages, filtered, pinned, rest, selected });
  /* Focus mode only applies to the personal editor with a page open. */
  panelEl.classList.toggle("is-editor-focus", editorFocus && activeSection === "personal" && !!selected);

  wireListeners(panelEl);

  /* Correct the tick density + lanes against the real (post-layout) track
   * width, and re-apply the persisted zoom to the fresh DOM. */
  if (activeSection === "timeline") {
    if (tlZoomRAF) { cancelAnimationFrame(tlZoomRAF); tlZoomRAF = 0; }
    tlZoomTarget = timelineZoom;
    tlLastTickSig = "";
    const track = panelEl.querySelector(".jnl-tl-track");
    if (track) track.style.width = `${(timelineZoom * 100).toFixed(2)}%`;
    refreshTimelineTicks();
    updateTimelineZoomControls();
    updateObservedYear();
  }
}

function renderShell({ journal, pages, filtered, pinned, rest, selected }) {
  const actor = getActor();
  const relCount = getRelationships(actor).length;

  /* Top-level pivot above the sub-nav — Personal swaps in the journal
   * page list / editor; Relationships swaps in a flag-stored card grid;
   * Timeline swaps in the visual life-line. */
  const tabs = `
    <nav class="jnl-tabs">
      <button class="jnl-tab${activeSection === "personal" ? " is-active" : ""}"
              type="button" data-action="set-journal-section" data-section="personal">
        <i class="fa-solid fa-book"></i>${t("WITCHER.Chrome.Journal.Text.Personal", "Personal")}
        <span class="jnl-tab-count">${pages.length}</span>
      </button>
      <button class="jnl-tab${activeSection === "relationships" ? " is-active" : ""}"
              type="button" data-action="set-journal-section" data-section="relationships">
        <i class="fa-solid fa-people-group"></i>${t("WITCHER.Chrome.Journal.Text.Relationships", "Relationships")}
        ${relCount > 0 ? `<span class="jnl-tab-count">${relCount}</span>` : ""}
      </button>
      <button class="jnl-tab${activeSection === "timeline" ? " is-active" : ""}"
              type="button" data-action="set-journal-section" data-section="timeline">
        <i class="fa-solid fa-timeline"></i>${t("WITCHER.Chrome.Journal.Text.Timeline", "Timeline")}
      </button>
    </nav>
  `;

  let sectionBody;
  if      (activeSection === "relationships") sectionBody = renderRelationshipsView(actor);
  else if (activeSection === "timeline")      sectionBody = renderTimelineView(actor, journal);
  else                                        sectionBody = renderPersonalSection({ pages, filtered, pinned, rest, selected });

  return `
    <button class="jnl-close" type="button" aria-label="${t("WITCHER.Chrome.Journal.Text.Close", "Close")}" title="${t("WITCHER.Chrome.Journal.Text.Collapse", "Collapse")}" data-action="close">
      <i class="fa-solid fa-chevron-up"></i>
    </button>
    ${game.user?.isGM ? `<div class="jnl-viewas-host wou-viewtools">${renderViewPanelAsPicker("journal")}${renderViewAsPicker()}</div>` : ""}
    ${tabs}
    ${sectionBody}
  `;
}

function renderPersonalSection({ pages, filtered, pinned, rest, selected }) {
  const pinnedCount = pages.filter(isPinned).length;
  return `
    <section class="jnl-left">
      <nav class="jnl-subnav">
        ${renderChip("all",    "fa-layer-group",     t("WITCHER.Chrome.Journal.Text.All", "All"),    pages.length)}
        ${renderChip("pinned", "fa-thumbtack",       t("WITCHER.Chrome.Journal.Text.Pinned", "Pinned"), pinnedCount)}
        ${renderChip(TAG_QUEST, TAG_META()[TAG_QUEST].icon, TAG_META()[TAG_QUEST].label, pages.filter(p => getTag(p) === TAG_QUEST).length)}
        ${renderChip(TAG_LORE,  TAG_META()[TAG_LORE].icon,  TAG_META()[TAG_LORE].label,  pages.filter(p => getTag(p) === TAG_LORE).length)}
        ${renderChip(TAG_ENTRY, TAG_META()[TAG_ENTRY].icon, TAG_META()[TAG_ENTRY].label, pages.filter(p => getTag(p) === TAG_ENTRY).length)}
        <div class="jnl-search-row">
          <i class="fa-solid fa-magnifying-glass jnl-search-icon"></i>
          <input class="jnl-search" type="search" autocomplete="off" spellcheck="false"
                 placeholder="${t("WITCHER.Chrome.Journal.Text.Search", "Search...")}"
                 value="${escapeHTML(activeSearch)}" />
          ${activeSearch ? `<button class="jnl-search-clear" type="button" data-action="clear-search" title="${t("WITCHER.Chrome.Journal.Text.Clear", "Clear")}"><i class="fa-solid fa-xmark"></i></button>` : ""}
        </div>
      </nav>

      <div class="jnl-list">
        ${filtered.length === 0
          ? `<div class="jnl-empty">${t("WITCHER.Chrome.Journal.Text.NoPagesMatchThisFilter", "No pages match this filter.")}</div>`
          : `
            ${pinned.length > 0 ? `<div class="jnl-grp">${t("WITCHER.Chrome.Journal.Text.Pinned", "Pinned")}</div>${pinned.map(p => renderCard(p, activePageId)).join("")}` : ""}
            ${rest.length > 0   ? `<div class="jnl-grp">${pinned.length > 0 ? t("WITCHER.Chrome.Journal.Text.AllEntries", "All entries") : t("WITCHER.Chrome.Journal.Text.Entries", "Entries")}</div>${rest.map(p => renderCard(p, activePageId)).join("")}` : ""}
          `}
      </div>
    </section>

    <aside class="jnl-right">
      ${selected ? renderEditor(selected) : renderNoSelection()}
    </aside>
  `;
}

/* =========================================================================
   TIMELINE PANE
   =========================================================================
 * Horizontal life-line from birth (current game year minus actor.age) to
 * today.  Events are sourced from:
 *   - Bio life events                  (life)
 *   - Journal pages flagged in-timeline (journal)
 *   - Relationship events              (relationship)
 *   - Bestiary encounters              (bestiary)
 *
 * Each event normalises to { id, source, ordinal, date, title, body,
 * location, relatedTo }.  Ordinals are approximate "days since year 0"
 * (365d/year, 30d/month — close enough for visual placement; we're not
 * doing exact date math).  Position on the line is a percentage of the
 * birth → today span.
 *
 * Hover any dot for a themed popup.  Filter chips toggle source visibility
 * per-session via the activeTimelineFilters Set. */

const TIMELINE_SOURCES = () => [
  { key: "life",         label: t("WITCHER.Chrome.Journal.Dialog.Button.LifeEvents", "Life Events"),         icon: "fa-feather-pointed" },
  { key: "journal",      label: t("WITCHER.Chrome.Journal.Dialog.Button.JournalEntries", "Journal Entries"),     icon: "fa-book" },
  { key: "relationship", label: t("WITCHER.Chrome.Journal.Dialog.Button.RelationshipEvents", "Relationship Events"), icon: "fa-people-group" },
  { key: "bestiary",     label: t("WITCHER.Chrome.Journal.Dialog.Button.BestiaryEncounters", "Bestiary Encounters"), icon: "fa-paw-claws" },
];

function ordinalFromYmd(year, month, day) {
  /* Approximate "days since year 0" — visual placement only, leap years
   * and per-calendar month lengths don't matter for a 100-year span. */
  return Number(year) * 365 + (Number(month) - 1) * 30 + (Number(day) - 1);
}
function ordinalFromIso(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  if (!m) return null;
  return ordinalFromYmd(m[1], m[2], m[3]);
}
function ordinalFromWorldTime(ts) {
  const cal = game.time?.calendar;
  if (!cal || typeof cal.timeToComponents !== "function") return null;
  try {
    const c = cal.timeToComponents(Number(ts) || 0);
    if (!c) return null;
    return ordinalFromYmd(c.year, (c.month ?? 0) + 1, (c.dayOfMonth ?? 0) + 1);
  } catch (e) { return null; }
}
function worldTimeToIso(ts) {
  const cal = game.time?.calendar;
  if (!cal || typeof cal.timeToComponents !== "function") return "";
  try {
    const c = cal.timeToComponents(Number(ts) || 0);
    if (!c) return "";
    const y  = c.year;
    const mo = String((c.month ?? 0) + 1).padStart(2, "0");
    const d  = String((c.dayOfMonth ?? 0) + 1).padStart(2, "0");
    return `${y}-${mo}-${d}`;
  } catch (e) { return ""; }
}
/* Reverse of worldTimeToIso: "YYYY-MM-DD" → worldTime seconds via the
 * live calendar. Anchors at noon so day boundaries round cleanly. Foundry's
 * componentsToTime reads `day` as day-of-year (0-based), NOT month +
 * dayOfMonth — see calendar.mjs — so convert here. Returns null when the
 * calendar isn't configured or the string doesn't parse. */
function isoToWorldTime(iso) {
  const cal = game.time?.calendar;
  if (!cal || typeof cal.componentsToTime !== "function") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? "").trim());
  if (!m) return null;
  const year = Number(m[1]);
  const monthIdx = Number(m[2]) - 1;
  const dayIdx   = Number(m[3]) - 1;
  const months = cal.months?.values;
  if (!Array.isArray(months) || monthIdx < 0 || monthIdx >= months.length) return null;
  const leap = cal.isLeapYear?.(year) ?? false;
  let doy = 0;
  for (let i = 0; i < monthIdx; i++) {
    doy += (leap ? (months[i].leapDays ?? months[i].days) : months[i].days) || 0;
  }
  doy += dayIdx;
  try {
    return cal.componentsToTime({ year, day: doy, hour: 12 });
  } catch (e) { return null; }
}
function currentGameYearOrdinal() {
  const cal = game.time?.calendar;
  const ts  = Number(game.time?.worldTime ?? 0);
  const c   = cal?.timeToComponents?.(ts);
  if (!c) return { ordinal: null, year: null };
  return {
    ordinal: ordinalFromYmd(c.year, (c.month ?? 0) + 1, (c.dayOfMonth ?? 0) + 1),
    year:    c.year,
  };
}

function collectTimelineEvents(actor, journal) {
  const events = [];

  /* Life events — only ones with a dated flag can be placed. */
  const lifeEvents = actor?.system?.general?.lifeEvents ?? {};
  for (const [key, ev] of Object.entries(lifeEvents)) {
    const dateStr = String(actor.getFlag?.(MODULE_ID, `lifeEventDates.${key}`) ?? "").trim();
    const ordinal = ordinalFromIso(dateStr);
    if (ordinal == null) continue;
    const title = String(ev?.value ?? "").trim();
    const body  = String(ev?.details ?? "").trim();
    if (!title && !body) continue;
    events.push({
      id: `life.${key}`,
      source: "life",
      ordinal,
      date: dateStr,
      title: title || t("WITCHER.Chrome.Journal.Text.UntitledEvent", "Untitled event"),
      body,
      location: String(actor.getFlag?.(MODULE_ID, `lifeEventLocations.${key}`) ?? "").trim(),
      relatedTo: null,
    });
  }

  /* Journal pages — only the ones flagged showInTimeline appear here.
   * createdWorldTime is stamped on every new page in createNewPage. */
  if (journal) {
    for (const page of (journal.pages?.contents ?? [])) {
      const f = page.flags?.[MODULE_ID] ?? {};
      if (!f.showInTimeline) continue;
      const ordinal = ordinalFromWorldTime(f.createdWorldTime ?? 0);
      if (ordinal == null) continue;
      events.push({
        id: `journal.${page.id}`,
        source: "journal",
        ordinal,
        date: worldTimeToIso(f.createdWorldTime ?? 0),
        title: page.name || t("WITCHER.Chrome.Journal.Text.Untitled", "(untitled)"),
        body:  stripPlainText(page.text?.content ?? ""),
        location: "",
        relatedTo: TAG_META()[f.tag]?.label ?? null,
      });
    }
  }

  /* Relationship events. */
  for (const rel of getRelationships(actor)) {
    for (const evt of (rel.events ?? [])) {
      const ordinal = ordinalFromIso(evt.date);
      if (ordinal == null) continue;
      events.push({
        id: `rel.${rel.id}.${evt.id}`,
        source: "relationship",
        ordinal,
        date: evt.date,
        title: evt.title || t("WITCHER.Chrome.Journal.Text.UntitledEvent", "Untitled event"),
        body: evt.body || "",
        location: evt.location || "",
        relatedTo: rel.name || t("WITCHER.Chrome.Journal.Text.Unnamed2", "(unnamed)"),
      });
    }
  }

  /* Bestiary encounters.  Per-monster array, each with a worldTime. */
  const bestiary = actor?.flags?.[MODULE_ID]?.bestiary ?? {};
  for (const [key, entry] of Object.entries(bestiary)) {
    if (!Array.isArray(entry?.encounters)) continue;
    /* Resolve the bestiary key (decoded UUID) to the actual document so we
     * can use its display name. Falls back to the last URL segment, which
     * is a slug for compendium entries but a raw doc id for world actors —
     * the raw id is what was showing up as "an ID on top of the description"
     * for world-actor monsters. */
    const decodedKey   = String(key).replaceAll("·", ".");
    const resolvedDoc  = fromUuidSync(decodedKey, { strict: false });
    const monsterLabel = resolvedDoc?.name
      || decodedKey.split(".").pop()
      || t("WITCHER.Chrome.Journal.Text.Unknown", "Unknown");
    for (const enc of entry.encounters) {
      const ordinal = ordinalFromWorldTime(enc.worldTime ?? 0);
      if (ordinal == null) continue;
      events.push({
        id: `bestiary.${key}.${enc.id ?? enc.combatId ?? Math.random()}`,
        source: "bestiary",
        ordinal,
        date: worldTimeToIso(enc.worldTime ?? 0),
        title: enc.title || tFormat("WITCHER.Chrome.Journal.Text.EncounterTitle", { monster: monsterLabel }, `Encounter · ${monsterLabel}`),
        body:  enc.note || "",
        location: enc.sceneName || "",
        relatedTo: monsterLabel || null,
      });
    }
  }

  return events.sort((a, b) => a.ordinal - b.ordinal);
}

function stripPlainText(html) {
  if (!html) return "";
  const tmp = document.createElement("div");
  tmp.innerHTML = String(html);
  return (tmp.textContent || "").trim();
}

/* Pick year-tick interval that produces 5-10 markers across the span. */
function pickYearStep(spanYears) {
  if (spanYears <= 0) return 1;
  for (const step of [1, 2, 5, 10, 20, 25, 50, 100]) {
    if (spanYears / step <= 10) return step;
  }
  return 200;
}

/* Inverse of ordinalFromYmd (fixed 365-day years / 30-day months). Exact for
 * the visual placement model, so a day-tick and an event on the same date land
 * on the same ordinal. */
function ymdFromOrdinal(ord) {
  const o = Math.round(Number(ord) || 0);
  const year = Math.floor(o / 365);
  let rem = o - year * 365;
  if (rem < 0) rem += 365;
  const month = Math.min(12, Math.floor(rem / 30) + 1);
  const day = (rem % 30) + 1;
  return { year, month, day };
}
/* Short month label from the live calendar, falling back to a number. The
 * calendar stores month names as i18n KEYS ("WITCHER.Calendar.Months.*"), so
 * localize before abbreviating — otherwise every month reads "WIT…". The
 * ordinal model's month index is approximate, so this is a reference label. */
function monthAbbr(month /* 1-based */) {
  const months = game.time?.calendar?.months?.values;
  if (Array.isArray(months) && months.length) {
    const m = months[(month - 1) % months.length];
    const key = m?.abbreviation || m?.name;
    if (key) {
      const label = game.i18n?.localize?.(key) ?? key;
      return String(label).slice(0, 3);
    }
  }
  return `M${month}`;
}

const TL_TICK_TARGET_PX = 60;   // min px between labelled ticks
/* Pick the tick granularity + step for a zoom without touching the DOM.
 * Returns { mode:"year"|"month"|"day", step }. Cheap enough to call per-frame;
 * its signature (`mode:step`) is what gates the actual tick rebuild. */
function timelineTickPlan(zoom, wrapPx) {
  const ctx = timelineCtx;
  if (!ctx) return { mode: "year", step: 1 };
  const trackPx  = Math.max(160, Number(wrapPx) || 880) * Math.max(1, zoom);
  const pxPerDay = trackPx / Math.max(1, ctx.span);
  const pickStep = (pxPerUnit, steps) => {
    for (const s of steps) if (pxPerUnit * s >= TL_TICK_TARGET_PX) return s;
    return steps[steps.length - 1];
  };
  if (pxPerDay * 365 < TL_TICK_TARGET_PX)
    return { mode: "year",  step: pickStep(pxPerDay * 365, [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000]) };
  if (pxPerDay * 30 < TL_TICK_TARGET_PX)
    return { mode: "month", step: pickStep(pxPerDay * 30,  [1, 2, 3, 6]) };
  return   { mode: "day",   step: pickStep(pxPerDay,       [1, 2, 5, 10, 15]) };
}
function tickPlanSig(plan) { return `${plan.mode}:${plan.step}`; }

/* Build the tick array from a plan, optionally bounded to a VISIBLE ordinal
 * window [winStartOrd, winEndOrd]. Windowing is the key to zoom performance:
 * without it, day-granularity at high zoom generates one node per step across
 * the whole birth→today span — tens of thousands of DOM nodes when only ~15 are
 * on screen. With a window, the LOOPS themselves are bounded to the visible
 * range (not just filtered), so tick count is constant regardless of zoom.
 * Passing null/null (initial paint) covers the whole span. */
function buildTicksFromPlan(plan, winStartOrd = null, winEndOrd = null) {
  const ctx = timelineCtx;
  if (!ctx) return [];
  const { birthOrd, span, birthYear, currentYear } = ctx;
  const { mode, step } = plan;
  const loOrd = winStartOrd != null ? Math.max(birthOrd, winStartOrd) : birthOrd;
  const hiOrd = winEndOrd   != null ? Math.min(birthOrd + span, winEndOrd) : birthOrd + span;
  const out = [];
  const add = (ord, label) => {
    if (ord < loOrd - 0.5 || ord > hiOrd + 0.5) return;
    const pct = ((ord - birthOrd) / span) * 100;
    if (pct < -0.05 || pct > 100.05) return;
    out.push({ pct: Math.max(0, Math.min(100, pct)), label });
  };
  if (mode === "year") {
    const loY = ymdFromOrdinal(loOrd).year;
    const hiY = Math.min(currentYear, ymdFromOrdinal(hiOrd).year);
    // Align to the step grid AND clamp to the window's first year.
    let y = Math.max(Math.ceil(birthYear / step) * step, Math.floor(loY / step) * step);
    for (; y <= hiY; y += step) add(ordinalFromYmd(y, 1, 1), String(y));
  } else if (mode === "month") {
    const loY = Math.max(birthYear, ymdFromOrdinal(loOrd).year);
    const hiY = Math.min(currentYear, ymdFromOrdinal(hiOrd).year);
    for (let yr = loY; yr <= hiY; yr++) {
      for (let m = 1; m <= 12; m += step) add(ordinalFromYmd(yr, m, 1), m === 1 ? String(yr) : monthAbbr(m));
    }
  } else {
    // Day mode — start at the step-aligned ordinal just inside the window, not
    // birthOrd, so the loop only iterates the visible days.
    let ord = birthOrd + Math.max(0, Math.floor((loOrd - birthOrd) / step)) * step;
    for (; ord <= hiOrd; ord += step) {
      const { month, day } = ymdFromOrdinal(ord);
      add(ord, `${monthAbbr(month)} ${day}`);
    }
  }
  return out;
}

/* Ordinal window currently visible (+ margin) for a given scroll/zoom. Both
 * fractions are clamped to [0,1] and ordered, so an out-of-range scrollLeft can
 * never produce an inverted/empty window (which showed as a blank flat line). */
function visibleTickWindow(wrapPx, scrollLeft) {
  const trackPx = Math.max(1, tlTrackPx());
  const margin  = wrapPx * TL_TICK_WINDOW_MARGIN;
  // Position within the TRACK (subtract the track's left padding offset).
  const content = scrollLeft - _tlTrackLeft;
  let startFrac = Math.max(0, Math.min(1, (content - margin) / trackPx));
  let endFrac   = Math.max(0, Math.min(1, (content + wrapPx + margin) / trackPx));
  if (endFrac < startFrac) { const t = startFrac; startFrac = endFrac; endFrac = t; }
  return {
    startOrd: timelineCtx.birthOrd + startFrac * timelineCtx.span,
    endOrd:   timelineCtx.birthOrd + endFrac   * timelineCtx.span
  };
}

/* Paint ONLY the ticks in the visible window. Cheap (~a few dozen nodes) so it's
 * safe to call every zoom frame and on every pan. */
function repaintVisibleTicks(wrapPx, scrollLeft, plan) {
  const holder = panelEl?.querySelector(".jnl-tl-ticks");
  if (!holder || !timelineCtx) return;
  const p = plan || timelineTickPlan(timelineZoom, wrapPx);
  const win = visibleTickWindow(wrapPx, scrollLeft);
  holder.innerHTML = ticksToHTML(buildTicksFromPlan(p, win.startOrd, win.endOrd));
}

function ticksToHTML(ticks) {
  return ticks.map(tk =>
    `<div class="jnl-tl-tick" style="left:${tk.pct.toFixed(3)}%"><span class="jnl-tl-tick-label">${escapeHTML(tk.label)}</span></div>`
  ).join("");
}

/* Recompute the dynamic max zoom (so day-resolution is always reachable) and
 * repaint the ticks against the live track width. Called after render and on
 * every zoom change — cheap, touches only the tick container. */
function refreshTimelineTicks() {
  const wrap  = timelineWrapEl();
  const holder = panelEl?.querySelector(".jnl-tl-ticks");
  if (!wrap || !holder || !timelineCtx) return;
  calibrateTimelineGeom();       // post-render / resize / settle → re-measure once
  const wrapPx = tlWrapPx();
  _tlScrollLeft = wrap.scrollLeft || 0;
  // Ceiling zoom = ~30px per day.
  timelineZoomMax = Math.min(8000, Math.max(6, Math.ceil(30 * timelineCtx.span / Math.max(160, wrapPx))));
  const plan = timelineTickPlan(timelineZoom, wrapPx);
  tlLastTickSig = tickPlanSig(plan);
  repaintVisibleTicks(wrapPx, _tlScrollLeft, plan);
  relayoutTimelineLanes(true, wrapPx);   // exact final spacing (post-render / zoom-settle)
}

/* Re-assign event lanes using the CURRENT pixel spacing, so events that were
 * stacked at 1× flatten onto the line as zoom spreads them apart.
 *
 * This is the timeline's hot loop, so it's carefully cheap:
 *   - the sorted branch list is CACHED (rebuilt only when the track is replaced),
 *   - it's THROTTLED during the zoom animation (`force`s past it at settle),
 *   - it bails when the track width hasn't changed (lanes depend only on that),
 *   - and it only writes `--tl-lane` on elements whose lane actually changed
 *     (a redundant write would needlessly invalidate layout).
 */
function relayoutTimelineLanes(force = false, wrapPxArg = null) {
  const track = panelEl?.querySelector(".jnl-tl-track");
  if (!track) return;

  const trackPx = tlTrackPx();   // measured — lane gaps must use the real px/day
  if (!force) {
    // Lanes only depend on trackPx — nothing to do if it hasn't moved.
    if (Math.abs(trackPx - _tlLastLaneTrackPx) < 0.5) return;
    // Cap the pass to ~every 40ms mid-animation; the settle call runs it exactly.
    const now = performance.now();
    if (now - _tlLastLaneTime < 40) return;
    _tlLastLaneTime = now;
  }
  _tlLastLaneTrackPx = trackPx;

  // (Re)build the sorted branch cache only when the track element is swapped out
  // (i.e. a re-render), not every frame.
  if (!_tlBranches || _tlBranchTrack !== track) {
    _tlBranchTrack = track;
    _tlBranches = Array.from(track.querySelectorAll(".jnl-tl-branch"))
      .map(el => ({ el, pct: Number(el.dataset.tlPct) || 0, lane: -1 }))
      .sort((a, b) => a.pct - b.pct);
  }
  if (!_tlBranches.length) { track.style.setProperty("--tl-max-lane", "0"); return; }

  const MIN_PX = 30;   // min horizontal gap for two dots to share a lane
  const laneTailPx = [];
  let maxLane = 0;
  for (const it of _tlBranches) {
    const xPx = (it.pct / 100) * trackPx;
    let i = 0;
    while (laneTailPx[i] != null && (xPx - laneTailPx[i]) < MIN_PX) i++;
    laneTailPx[i] = xPx;
    if (it.lane !== i) { it.el.style.setProperty("--tl-lane", String(i)); it.lane = i; }
    if (i > maxLane) maxLane = i;
  }
  track.style.setProperty("--tl-max-lane", String(maxLane));
}

function updateTimelineZoomControls() {
  const lvl    = panelEl?.querySelector(".jnl-tl-zoom-level");
  const outBtn = panelEl?.querySelector('[data-action="timeline-zoom-out"]');
  const inBtn  = panelEl?.querySelector('[data-action="timeline-zoom-in"]');
  if (lvl)    lvl.textContent = `${Math.round(timelineZoom * 100)}%`;
  if (outBtn) outBtn.disabled = tlZoomTarget <= TL_ZOOM_MIN + 1e-6;
  if (inBtn)  inBtn.disabled  = tlZoomTarget >= timelineZoomMax - 1e-6;
}

function timelineWrapEl() { return panelEl?.querySelector(".jnl-tl-track-wrap"); }

/* Wrap width, cached. Reading `clientWidth` forces a layout flush; on a giant
 * zoomed track that's the single most expensive per-frame op, so we read it once
 * and reuse it until a render/resize invalidates the cache. */
function tlWrapPx() {
  if (_tlWrapPx > 0) return _tlWrapPx;
  const w = timelineWrapEl();
  _tlWrapPx  = (w?.clientWidth) || 880;
  _tlWrapLeft = w ? w.getBoundingClientRect().left : 0;
  return _tlWrapPx;
}
function invalidateTlWrapPx() { _tlWrapPx = 0; _tlBasis = 0; }

/* The track's TRUE scrollable width at the current zoom. Measured basis × zoom,
 * so it accounts for the wrap's padding (which clientWidth×zoom does not). */
function tlTrackPx() { return (_tlBasis > 0 ? _tlBasis : tlWrapPx()) * timelineZoom; }

/* Measure the real geometry once (offsetWidth/offsetLeft/scrollWidth). Called at
 * render/settle/resize — never per frame — since basis/padding are zoom-invariant
 * (the track's %-width scales, the wrap and its padding don't). */
function calibrateTimelineGeom() {
  const wrap  = timelineWrapEl();
  const track = panelEl?.querySelector(".jnl-tl-track");
  if (!wrap || !track) return;
  _tlWrapPx   = wrap.clientWidth || 880;
  _tlWrapLeft = wrap.getBoundingClientRect().left;
  const ow = track.offsetWidth || _tlWrapPx;
  _tlBasis       = ow / Math.max(1e-6, timelineZoom);
  _tlTrackLeft   = track.offsetLeft || 0;
  _tlScrollExtra = Math.max(0, (wrap.scrollWidth || ow) - ow);
}

/* The year sitting at the centre of the viewport right now. Accepts cached
 * wrapPx + scrollLeft so hot callers don't force a layout read. */
function observedYear(wrapPx = null, scrollLeft = null) {
  if (!timelineCtx) return null;
  const wp = wrapPx != null ? wrapPx : tlWrapPx();
  const sl = scrollLeft != null ? scrollLeft : (timelineWrapEl()?.scrollLeft || 0);
  const frac = (sl + wp / 2 - _tlTrackLeft) / Math.max(1, tlTrackPx());
  return ymdFromOrdinal(timelineCtx.birthOrd + frac * timelineCtx.span).year;
}

/* Big faint "observed year" watermark — shown once you've zoomed in enough that
 * a single year dominates the view; tracks pan + zoom. */
function updateObservedYear(wrapPx = null, scrollLeft = null) {
  const el = panelEl?.querySelector(".jnl-tl-yearmark");
  if (!el || !timelineCtx) return;
  const visibleYears = (timelineCtx.span / Math.max(1, timelineZoom)) / 365;
  const show = visibleYears < 6;
  el.classList.toggle("is-visible", show);
  if (show) {
    const y = observedYear(wrapPx, scrollLeft);
    if (y != null) el.textContent = String(y);
  }
}

/* One eased frame of the smooth zoom: nudge timelineZoom toward the target,
 * rescale the track, hold the anchor point fixed, and refresh dependent bits.
 * Tick DOM is only rebuilt when the granularity band changes. */
function stepTimelineZoom() {
  tlZoomRAF = 0;
  const track = panelEl?.querySelector(".jnl-tl-track");
  const wrap  = timelineWrapEl();
  if (!wrap || !track || !timelineCtx) return;
  const wrapPx = tlWrapPx();   // cached — no per-frame clientWidth reflow

  const diff = tlZoomTarget - timelineZoom;
  const zoomSettled = Math.abs(diff) <= Math.max(0.0006, tlZoomTarget * 0.0025);
  if (zoomSettled) timelineZoom = tlZoomTarget;
  else             timelineZoom += diff * 0.28;

  track.style.width = `${(timelineZoom * 100).toFixed(3)}%`;

  /* Where the anchored point wants the scroll to be at this frame. Wheel/button
   * zoom hard-locks it (the anchor is already under the cursor, so no jump);
   * fly-to-event eases the scroll so the dot glides to centre as it zooms.
   * We track the committed scroll (`_tlScrollLeft`) rather than reading
   * `wrap.scrollLeft` — the read would force another layout flush per frame. */
  const trackPx = tlTrackPx();   // measured track width — accounts for wrap padding
  const desired = _tlTrackLeft + tlZoomAnchorFrac * trackPx - tlZoomAnchorX;
  let scrollSettled = true;
  let nextScroll = desired;
  if (tlPanEase) {
    const sdiff = desired - _tlScrollLeft;
    if (Math.abs(sdiff) <= 0.5) nextScroll = desired;
    else { nextScroll = _tlScrollLeft + sdiff * 0.28; scrollSettled = false; }
  }
  /* Clamp to the real scroll range. The anchor math can push `desired` past the
   * track edge (zooming in near today), which the browser clamps on the actual
   * scroll — but if we stored the UNCLAMPED value the visible-tick window would
   * compute a start fraction > 1, invert, and render nothing (flat line). */
  const maxScroll = Math.max(0, trackPx + _tlScrollExtra - wrapPx);
  nextScroll = Math.max(0, Math.min(maxScroll, nextScroll));
  wrap.scrollLeft = nextScroll;
  _tlScrollLeft = nextScroll;

  /* Ticks are VIRTUALIZED (only the visible window is in the DOM), so they must
   * repaint every frame — the visible set changes as the track scales/scrolls.
   * That's ~a few dozen nodes, far cheaper than the old whole-span build (which
   * hit tens of thousands of nodes at high zoom). The plan sig still gates the
   * granularity band; the window handles the rest. */
  const plan = timelineTickPlan(timelineZoom, wrapPx);
  tlLastTickSig = tickPlanSig(plan);
  repaintVisibleTicks(wrapPx, nextScroll, plan);

  relayoutTimelineLanes(false, wrapPx);
  updateTimelineZoomControls();
  updateObservedYear(wrapPx, nextScroll);

  if (!zoomSettled || !scrollSettled) tlZoomRAF = requestAnimationFrame(stepTimelineZoom);
  else { tlPanEase = false; refreshTimelineTicks(); }   // exact final spacing
}

/* Kick a smooth zoom toward `target`, anchored under `anchorClientX` (or the
 * view centre). No re-render, so scroll + branches persist. */
function applyTimelineZoom(target, anchorClientX) {
  const wrap = timelineWrapEl();
  if (!wrap || !timelineCtx) return;
  const wrapPx = tlWrapPx();   // caches wrapPx + wrapLeft
  /* Use the animation's committed scroll when one is already running (mid wheel-
   * spin) so we never read `wrap.scrollLeft` back per frame; only read it fresh
   * when starting from rest. */
  const scroll = tlZoomRAF ? _tlScrollLeft : (wrap.scrollLeft || 0);
  _tlScrollLeft = scroll;
  tlPanEase = false;
  tlZoomTarget = Math.max(TL_ZOOM_MIN, Math.min(timelineZoomMax, target));
  tlZoomAnchorX = anchorClientX != null ? (anchorClientX - _tlWrapLeft) : (wrapPx / 2);
  // Anchor fraction is a position WITHIN the track (offset by its left padding).
  tlZoomAnchorFrac = (scroll + tlZoomAnchorX - _tlTrackLeft) / Math.max(1, tlTrackPx());
  updateTimelineZoomControls();
  if (!tlZoomRAF) tlZoomRAF = requestAnimationFrame(stepTimelineZoom);
}

/* Smoothly fly the view to timeline fraction `frac` (0=birth, 1=today) at a
 * day-focused zoom, landing the point at the viewport centre. Used when a
 * timeline dot is clicked. */
function zoomTimelineToFrac(frac) {
  const wrap = timelineWrapEl();
  if (!wrap || !timelineCtx) return;
  const wrapPx = tlWrapPx();
  _tlScrollLeft = tlZoomRAF ? _tlScrollLeft : (wrap.scrollLeft || 0);
  // ~2 months of context around the date, clamped into the valid range.
  const target = Math.max(3, Math.min(timelineZoomMax, timelineCtx.span / 60));
  tlPanEase = true;
  tlZoomTarget = Math.max(TL_ZOOM_MIN, target);
  tlZoomAnchorFrac = Math.max(0, Math.min(1, frac));
  tlZoomAnchorX = wrapPx / 2;   // centre the clicked date
  updateTimelineZoomControls();
  if (!tlZoomRAF) tlZoomRAF = requestAnimationFrame(stepTimelineZoom);
}

function renderTimelineView(actor, journal) {
  if (!actor) {
    return `<section class="jnl-timeline"><div class="jnl-tl-empty">${t("WITCHER.Chrome.Journal.Text.NoCharacterAssigned", "No character assigned.")}</div></section>`;
  }

  const age = Number(actor.system?.general?.age) || 0;
  const { ordinal: todayOrd, year: currentYear } = currentGameYearOrdinal();

  if (todayOrd == null || currentYear == null) {
    return `<section class="jnl-timeline"><div class="jnl-tl-empty">${t("WITCHER.Chrome.Journal.Text.NoWorldCalendar", "No world calendar configured — can't compute today's date.")}</div></section>`;
  }
  if (age <= 0) {
    return `
      <section class="jnl-timeline">
        <div class="jnl-tl-empty">
          ${t("WITCHER.Chrome.Journal.Text.SetAgeToEnableTimeline", "Set this character's <em>Age</em> on the Biography tab to enable the timeline.")}
        </div>
      </section>
    `;
  }

  const birthYear = currentYear - age;
  /* Birth assumed Jan 1 of birth year; lacks a precise birthday field. */
  const birthOrd  = ordinalFromYmd(birthYear, 1, 1);
  const span      = Math.max(1, todayOrd - birthOrd);

  /* Stash geometry so the wheel/zoom handlers can rebuild ticks + re-lane
   * without a full re-render. */
  timelineCtx = { birthOrd, span, birthYear, currentYear };

  const events = collectTimelineEvents(actor, journal)
    .filter(e => activeTimelineFilters.has(e.source));

  /* Adaptive scale ticks (year / month / day by zoom). First paint uses an
   * estimated width and only builds the FIRST viewport's ticks (windowed) — a
   * re-render at a persisted high zoom must never build the whole span, or day
   * granularity would emit tens of thousands of nodes. refreshTimelineTicks()
   * corrects against the live DOM + real scroll on the next frame. */
  const _initPlan    = timelineTickPlan(timelineZoom, 880);
  const _initTrackPx = Math.max(1, 880 * timelineZoom);
  const _initWinEnd  = birthOrd + Math.min(1, (880 * (1 + TL_TICK_WINDOW_MARGIN)) / _initTrackPx) * span;
  const ticksHTML    = ticksToHTML(buildTicksFromPlan(_initPlan, birthOrd, _initWinEnd));

  /* Group events that land on the exact same ordinal + source so identical
   * stacks merge into one dot with a count chip.  Then assign lanes so
   * groups that are horizontally close get pushed to higher rows. */
  const grouped = new Map();
  for (const ev of events) {
    const pct = ((ev.ordinal - birthOrd) / span) * 100;
    const clamped = Math.max(0, Math.min(100, pct));
    const bucketKey = `${ev.source}:${clamped.toFixed(2)}`;
    if (!grouped.has(bucketKey)) grouped.set(bucketKey, { pct: clamped, source: ev.source, items: [] });
    grouped.get(bucketKey).items.push(ev);
  }
  const dots = Array.from(grouped.values()).sort((a, b) => a.pct - b.pct);
  /* Greedy lane assignment — for each branch, pick the lowest lane (closest
   * to the line) where no other branch lives within the collision
   * threshold.  4% of the bar ≈ 35px at typical viewport widths, which
   * fits a 24px icon box plus breathing room. */
  const LANE_GAP_PCT = 4;
  const laneTails = [];
  for (const d of dots) {
    let i = 0;
    while (laneTails[i] != null && (d.pct - laneTails[i]) < LANE_GAP_PCT) i++;
    laneTails[i] = d.pct;
    d.lane = i;
  }
  const maxLane = laneTails.length > 0 ? laneTails.length - 1 : 0;

  return `
    <section class="jnl-timeline">
      <div class="jnl-tl-yearmark" aria-hidden="true"></div>
      <header class="jnl-tl-head">
        <div class="jnl-tl-summary">
          <span class="jnl-tl-summary-key">${t("WITCHER.Chrome.Journal.Text.Born", "Born")}</span> ${birthYear}
          <span class="jnl-tl-summary-sep">→</span>
          <span class="jnl-tl-summary-key">${t("WITCHER.Chrome.Journal.Text.Now", "Now")}</span> ${currentYear}
          <span class="jnl-tl-summary-sep">·</span>
          <span class="jnl-tl-summary-key">${t("WITCHER.Chrome.Journal.Text.Age", "Age")}</span> ${age}
        </div>
        <div class="jnl-tl-filters">
          ${TIMELINE_SOURCES().map(s => {
            const active = activeTimelineFilters.has(s.key);
            const total  = events.filter(e => e.source === s.key).length;
            return `<button type="button"
                            class="jnl-tl-filter is-${s.key}${active ? " is-active" : ""}"
                            data-action="toggle-timeline-filter" data-tl-source="${s.key}"
                            title="${s.label}">
              <i class="fa-solid ${s.icon}"></i>
              <span>${escapeHTML(s.label)}</span>
              ${total > 0 ? `<span class="jnl-tl-filter-count">${total}</span>` : ""}
            </button>`;
          }).join("")}
        </div>
        <div class="jnl-tl-zoom" role="group" aria-label="${t("WITCHER.Chrome.Journal.Text.Zoom", "Zoom")}">
          <button type="button" class="jnl-tl-zoom-btn" data-action="timeline-zoom-out"
                  title="${t("WITCHER.Chrome.Journal.Text.ZoomOut", "Zoom out")}"
                  ${timelineZoom <= TL_ZOOM_MIN + 1e-6 ? "disabled" : ""}><i class="fa-solid fa-magnifying-glass-minus"></i></button>
          <button type="button" class="jnl-tl-zoom-level" data-action="timeline-zoom-reset"
                  title="${t("WITCHER.Chrome.Journal.Text.ZoomReset", "Reset zoom")}">${Math.round(timelineZoom * 100)}%</button>
          <button type="button" class="jnl-tl-zoom-btn" data-action="timeline-zoom-in"
                  title="${t("WITCHER.Chrome.Journal.Text.ZoomIn", "Zoom in")}"
                  ${timelineZoom >= timelineZoomMax - 1e-6 ? "disabled" : ""}><i class="fa-solid fa-magnifying-glass-plus"></i></button>
        </div>
      </header>

      <div class="jnl-tl-track-wrap" title="${t("WITCHER.Chrome.Journal.Text.ScrollToZoom", "Scroll to zoom")}">
        <div class="jnl-tl-track" role="presentation"
             style="--tl-max-lane: ${maxLane}; width:${(timelineZoom * 100).toFixed(2)}%;">
          <div class="jnl-tl-line"></div>
          <div class="jnl-tl-ticks">${ticksHTML}</div>
          ${dots.map(d => renderTimelineBranch(d)).join("")}
        </div>
      </div>

      ${dots.length === 0 ? `
        <div class="jnl-tl-empty-events">
          ${events.length === 0
            ? t("WITCHER.Chrome.Journal.Text.NoTimelineEvents", "No timeline events yet. Date a life event, flag a journal page <em>shows in timeline</em>, add a dated relationship event, or fight something.")
            : t("WITCHER.Chrome.Journal.Text.AllSourcesFilteredOff", "All sources are filtered off.")}
        </div>` : ""}
    </section>
  `;
}

function renderTimelineBranch(d) {
  /* Single branch at one ordinal — anchor on the line, stem rising
   * vertically to a boxed source icon at lane height.  Hover anywhere on
   * the branch shows the popup.  Lane number drives the --tl-lane CSS
   * var; the stem height + box position are computed from it in CSS. */
  const items = d.items;
  const count = items.length;
  const first = items[0];
  const popupBody = items.map(renderTimelinePopupCard).join("");
  const sourceMeta = TIMELINE_SOURCES().find(s => s.key === d.source);
  const icon = sourceMeta?.icon ?? "fa-circle";

  return `
    <div class="jnl-tl-branch is-${d.source}"
         style="left:${d.pct.toFixed(3)}%; --tl-lane:${d.lane};"
         data-tl-pct="${d.pct.toFixed(4)}"
         tabindex="0"
         aria-label="${escapeHTML(first.title)} on ${escapeHTML(first.date)}">
      <span class="jnl-tl-branch-anchor"></span>
      <span class="jnl-tl-branch-stem"></span>
      <span class="jnl-tl-branch-box" data-action="zoom-timeline-event"
            title="${t("WITCHER.Chrome.Journal.Text.ZoomToThisEntry", "Zoom to this entry")}">
        <i class="fa-solid ${icon}"></i>
        ${count > 1 ? `<span class="jnl-tl-branch-count">${count}</span>` : ""}
      </span>
      <div class="jnl-tl-popup">
        <div class="jnl-tl-popup-stack">${popupBody}</div>
      </div>
    </div>
  `;
}

function renderTimelinePopupCard(e) {
  const metaParts = [];
  if (e.date)      metaParts.push(`<span class="jnl-tl-popup-date">${escapeHTML(e.date)}</span>`);
  if (e.location)  metaParts.push(`<span class="jnl-tl-popup-loc"><i class="fa-solid fa-location-dot"></i>${escapeHTML(e.location)}</span>`);
  if (e.relatedTo) metaParts.push(`<span class="jnl-tl-popup-rel">${escapeHTML(e.relatedTo)}</span>`);
  const meta = metaParts.length ? `<div class="jnl-tl-popup-meta">${metaParts.join("")}</div>` : "";
  /* Truncate long bodies for the popup so the floating panel stays a
   * scannable size; full content lives in the underlying entry. */
  const bodyText = e.body ? (e.body.length > 280 ? e.body.slice(0, 277).trimEnd() + "…" : e.body) : "";
  const body = bodyText ? `<div class="jnl-tl-popup-body">${escapeHTML(bodyText)}</div>` : "";
  return `
    <div class="jnl-tl-popup-card is-${e.source}">
      <div class="jnl-tl-popup-title">${escapeHTML(e.title)}</div>
      ${meta}
      ${body}
    </div>
  `;
}

/* Relationships pane — selection-model layout matching the Personal pane:
 * left list of NPCs (name + relationship-type select + edit-lock), right
 * detail panel for the currently-selected NPC.  All data lives on the
 * actor flag under `relationships`. */
function renderRelationshipsView(actor) {
  const list = getRelationships(actor);

  /* Auto-select first relationship if nothing selected, or the previously
   * selected one was deleted. */
  if (!activeRelId || !list.some(r => r.id === activeRelId)) {
    activeRelId = list[0]?.id ?? null;
  }
  const selected = activeRelId ? getRelationship(actor, activeRelId) : null;

  return `
    <section class="jnl-rel-left">
      <div class="jnl-rel-list">
        ${list.length === 0
          ? `<div class="jnl-rel-empty-left">${t("WITCHER.Chrome.Journal.Text.NoRelationshipsYet", "No relationships yet.")}</div>`
          : list.map(r => renderRelationshipListItem(r, activeRelId)).join("")}
      </div>
      <button type="button" class="jnl-rel-add" data-action="add-relationship">
        <i class="fa-solid fa-plus"></i>Add relationship
      </button>
    </section>
    <div class="jnl-rel-divider" aria-hidden="true">
      <span class="jnl-rel-divider-glyph">◆</span>
    </div>
    <aside class="jnl-rel-right">
      ${selected ? renderRelationshipDetail(selected) : renderRelationshipEmpty(list.length)}
    </aside>
  `;
}

/* Single row in the left list.  Two visual states:
 *   - View mode (default): name + type render as plain text so clicking
 *     anywhere on the row reliably selects it.  Pencil button to enter
 *     edit mode.
 *   - Edit mode: name becomes an input, type becomes a select.  Save
 *     (checkmark) button to commit and exit edit mode.  Delete X stays
 *     visible in both modes. */
function renderRelationshipListItem(rel, currentId) {
  const active  = rel.id === currentId;
  const editing = editingRelIds.has(rel.id);

  let main;
  if (editing) {
    const typeOpts = RELATIONSHIP_TYPES.map(id =>
      `<option value="${escapeHTML(id)}"${rel.type === id ? " selected" : ""}>${escapeHTML(relationLabel(id))}</option>`
    ).join("");
    main = `
      <div class="jnl-rel-row-main">
        <input type="text" class="jnl-rel-row-name"
               value="${escapeHTML(rel.name ?? "")}"
               placeholder="${t("WITCHER.Chrome.Journal.Text.Unnamed", "Unnamed")}"
               data-action="edit-relationship-field"
               data-rel-id="${escapeHTML(rel.id)}" data-field="name"
               aria-label="${t("WITCHER.Chrome.Journal.Text.Name", "Name")}" />
        <select class="jnl-rel-row-type"
                data-action="edit-relationship-field"
                data-rel-id="${escapeHTML(rel.id)}" data-field="type"
                aria-label="${t("WITCHER.Chrome.Journal.Text.RelationshipType", "Relationship type")}">
          <option value=""${!rel.type ? " selected" : ""}>—</option>
          ${typeOpts}
        </select>
      </div>
    `;
  } else {
    main = `
      <div class="jnl-rel-row-main">
        <div class="jnl-rel-row-name-view">${escapeHTML(rel.name || t("WITCHER.Chrome.Journal.Text.Unnamed", "Unnamed"))}</div>
        <div class="jnl-rel-row-type-view">${escapeHTML(rel.type || "—")}</div>
      </div>
    `;
  }

  return `
    <div class="jnl-rel-row${active ? " is-active" : ""}${editing ? " is-editing" : ""}"
         data-rel-id="${escapeHTML(rel.id)}" data-action="select-relationship">
      ${main}
      <div class="jnl-rel-row-actions">
        <button type="button" class="jnl-rel-row-edit"
                data-action="toggle-relationship-edit"
                data-rel-id="${escapeHTML(rel.id)}"
                title="${editing ? t("WITCHER.Chrome.Journal.Text.SaveExitEdit", "Save and exit edit mode") : t("WITCHER.Chrome.Journal.Text.EditRelationship", "Edit this relationship")}">
          <i class="fa-solid ${editing ? "fa-check" : "fa-pen"}"></i>
        </button>
        <button type="button" class="jnl-rel-row-delete"
                data-action="delete-relationship"
                data-rel-id="${escapeHTML(rel.id)}"
                title="${t("WITCHER.Chrome.Journal.Text.RemoveThisRelationship", "Remove this relationship")}">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
    </div>
  `;
}

function renderRelationshipEmpty(total) {
  return `
    <div class="jnl-rel-empty-right">
      <i class="fa-solid fa-people-arrows"></i>
      <div>${total === 0
        ? t("WITCHER.Chrome.Journal.Text.AddRelationshipFromLeftPanel", "Add a relationship from the left panel to start filling in their details.")
        : t("WITCHER.Chrome.Journal.Text.PickRelationshipFromLeftPanel", "Pick a relationship from the left panel.")}</div>
    </div>
  `;
}

/* The big right pane for a selected relationship.  Composed of:
 *   - Portrait (click to upload, png/jpeg/webp only)
 *   - Info grid (full name, age, gender, homeland)
 *   - Personality tag widget (chips + type-to-add input)
 *   - Bio textarea
 *   - Events section with date-picker + title + body, mirrors bio life
 *     events with the same +Add button pattern
 *
 * When the relationship is NOT in edit mode (the default), every input
 * renders readonly/disabled and the +Add buttons are hidden.  Toggling
 * edit mode via the pencil-checkmark button on the left list row flips
 * all of these in one render pass. */
function renderRelationshipDetail(rel) {
  const editing    = editingRelIds.has(rel.id);
  const portrait   = String(rel.portrait ?? "").trim();
  const homelands  = globalThis.CONFIG?.WITCHER?.homelands ?? {};
  const tags       = Array.isArray(rel.personalityTags) ? rel.personalityTags : [];
  const events     = Array.isArray(rel.events) ? rel.events : [];

  const homelandOpts = Object.entries(homelands).map(([k, lbl]) => {
    const text = typeof lbl === "string" && lbl.startsWith("WITCHER.")
      ? game.i18n.localize(lbl) : (lbl || k);
    return `<option value="${escapeHTML(k)}"${rel.homeland === k ? " selected" : ""}>${escapeHTML(text)}</option>`;
  }).join("");

  return `
    <div class="jnl-rel-detail${editing ? " is-editing" : ""}">
      <div class="rel-portrait-wrap">
        <button type="button" class="rel-portrait"
                data-action="upload-rel-portrait" data-rel-id="${escapeHTML(rel.id)}"
                ${editing ? "" : "disabled"}
                title="${editing ? t("WITCHER.Chrome.Journal.Text.ClickChoosePortraitImage", "Click to choose an image (png, jpg, webp)") : t("WITCHER.Chrome.Journal.Text.EnterEditModeChangePortrait", "Enter edit mode to change the portrait")}">
          ${portrait
            ? `<img src="${escapeHTML(portrait)}" alt="${escapeHTML(rel.name || "")}" />`
            : `<i class="fa-solid fa-user"></i><span class="rel-portrait-hint">${editing ? t("WITCHER.Chrome.Journal.Text.ClickToAddPortrait", "Click to add portrait") : t("WITCHER.Chrome.Journal.Text.NoPortrait", "No portrait")}</span>`}
        </button>
      </div>

      <div class="rel-info-grid">
        ${renderRelInput(rel.id, "fullName", t("WITCHER.Chrome.Journal.Text.FullName", "Full name"),  rel.fullName, "text", !editing)}
        ${renderRelInput(rel.id, "age",      t("WITCHER.Chrome.Journal.Text.Age", "Age"),        rel.age,      "number", !editing)}
        ${renderRelInput(rel.id, "gender",   t("WITCHER.Chrome.Journal.Text.Gender", "Gender"),     rel.gender,   "text", !editing)}
        ${renderRelSelect(rel.id, "homeland", t("WITCHER.Chrome.Journal.Text.Homeland", "Homeland"),  rel.homeland, homelandOpts, !editing)}
      </div>

      <div class="rel-section">
        <div class="rel-section-label">${t("WITCHER.Chrome.Journal.Text.Personality", "Personality")}</div>
        ${renderRelTags(rel.id, tags, !editing)}
      </div>

      <div class="rel-section">
        <div class="rel-section-label">${t("WITCHER.Chrome.Journal.Text.Bio", "Bio")}</div>
        <textarea class="rel-bio" rows="3" placeholder="${t("WITCHER.Chrome.Journal.Text.AShortBio", "A short bio…")}"
                  ${editing ? "" : "readonly"}
                  data-action="edit-relationship-field"
                  data-rel-id="${escapeHTML(rel.id)}" data-field="bio">${escapeHTML(rel.bio ?? "")}</textarea>
      </div>

      <div class="rel-section">
        <div class="rel-section-label">
          <span class="rel-section-sub">${t("WITCHER.Chrome.Journal.Text.YourHistoryWithThem", "Your history with them")}</span>
          ${t("WITCHER.Chrome.Journal.Text.Events", "Events")}
        </div>
        <div class="rel-events">
          ${events.length === 0
            ? `<div class="rel-events-empty">${t("WITCHER.Chrome.Journal.Text.NoEventsYet", "No events yet.")}</div>`
            : events.map(e => renderRelationshipEventEditor(rel.id, e, !editing)).join("")}
        </div>
        ${editing ? `
          <button type="button" class="rel-event-add"
                  data-action="add-relationship-event" data-rel-id="${escapeHTML(rel.id)}">
            <i class="fa-solid fa-plus"></i>${t("WITCHER.Chrome.Journal.Text.AddEvent", "Add event")}
          </button>` : ""}
      </div>
    </div>
  `;
}

/* Small input row used for the detail info grid.  Number type for age,
 * text for everything else.  Field is a flat property on the relationship
 * (fullName / age / gender). */
function renderRelInput(relId, field, label, value, type, locked) {
  const v = type === "number" ? (Number(value) || 0) : String(value ?? "");
  return `
    <label class="rel-field">
      <span class="rel-field-label">${escapeHTML(label)}</span>
      <input type="${type}" class="rel-field-input"
             value="${escapeHTML(String(v))}"
             ${type === "number" ? 'min="0" step="1"' : ""}
             ${locked ? "readonly" : ""}
             data-action="edit-relationship-field"
             data-rel-id="${escapeHTML(relId)}" data-field="${field}" data-rel-type="${type}"
             aria-label="${escapeHTML(label)}" />
    </label>
  `;
}

function renderRelSelect(relId, field, label, value, optionsHtml, locked) {
  return `
    <label class="rel-field">
      <span class="rel-field-label">${escapeHTML(label)}</span>
      <select class="rel-field-input rel-field-select"
              ${locked ? "disabled" : ""}
              data-action="edit-relationship-field"
              data-rel-id="${escapeHTML(relId)}" data-field="${field}" data-rel-type="text"
              aria-label="${escapeHTML(label)}">
        <option value=""${!value ? " selected" : ""}>—</option>
        ${optionsHtml}
      </select>
    </label>
  `;
}

/* Personality tags — chips with × removers, plus a tail input that
 * commits on Enter (creates a new chip + clears).  Stored as a string
 * array in personalityTags. */
function renderRelTags(relId, tags, locked) {
  const chips = tags.map((t, i) => `
    <span class="rel-tag">
      <span class="rel-tag-text">${escapeHTML(t)}</span>
      ${locked ? "" : `<button type="button" class="rel-tag-x"
              data-action="remove-personality-tag"
              data-rel-id="${escapeHTML(relId)}" data-tag-index="${i}"
              title="${t("WITCHER.Chrome.Journal.Text.RemoveTag", "Remove tag")}"><i class="fa-solid fa-xmark"></i></button>`}
    </span>
  `).join("");
  const input = locked ? "" : `
    <input type="text" class="rel-tag-input"
           placeholder="${t("WITCHER.Chrome.Journal.Text.AddTagThenEnter", "Add tag, then Enter")}"
           data-action="add-personality-tag" data-rel-id="${escapeHTML(relId)}"
           aria-label="${t("WITCHER.Chrome.Journal.Text.AddPersonalityTag", "Add personality tag")}" />`;
  return `<div class="rel-tags">${chips}${input}</div>`;
}

/* One event card in a relationship's Events section.  Same DOM shape as
 * the bio life-event editor (date + title + body), but stored inside
 * the relationship's events[] array instead of the system schema. */
function renderRelationshipEventEditor(relId, evt, locked) {
  return `
    <div class="rel-event" data-rel-id="${escapeHTML(relId)}" data-event-id="${escapeHTML(evt.id)}">
      <input type="text" class="rel-event-title"
             value="${escapeHTML(evt.title ?? "")}"
             placeholder="${t("WITCHER.Chrome.Journal.Text.EventTitle", "Event title")}"
             ${locked ? "readonly" : ""}
             data-action="edit-relationship-event-field"
             data-rel-id="${escapeHTML(relId)}" data-event-id="${escapeHTML(evt.id)}" data-field="title"
             aria-label="${t("WITCHER.Chrome.Journal.Text.EventTitle", "Event title")}" />
      <div class="rel-event-meta-row">
        <input type="date" class="rel-event-date"
               value="${escapeHTML(evt.date ?? "")}"
               ${locked ? "readonly" : ""}
               data-action="edit-relationship-event-field"
               data-rel-id="${escapeHTML(relId)}" data-event-id="${escapeHTML(evt.id)}" data-field="date"
               aria-label="${t("WITCHER.Chrome.Journal.Text.EventDate", "Event date")}" />
        <input type="text" class="rel-event-location"
               value="${escapeHTML(evt.location ?? "")}"
               placeholder="${t("WITCHER.Chrome.Journal.Text.Location", "Location")}"
               ${locked ? "readonly" : ""}
               data-action="edit-relationship-event-field"
               data-rel-id="${escapeHTML(relId)}" data-event-id="${escapeHTML(evt.id)}" data-field="location"
               aria-label="${t("WITCHER.Chrome.Journal.Text.EventLocation", "Event location")}" />
      </div>
      <textarea class="rel-event-body" rows="2"
                placeholder="${t("WITCHER.Chrome.Journal.Text.WhatHappened", "What happened…")}"
                ${locked ? "readonly" : ""}
                data-action="edit-relationship-event-field"
                data-rel-id="${escapeHTML(relId)}" data-event-id="${escapeHTML(evt.id)}" data-field="body"
                aria-label="${t("WITCHER.Chrome.Journal.Text.EventDetails", "Event details")}">${escapeHTML(evt.body ?? "")}</textarea>
      ${locked ? "" : `<button type="button" class="rel-event-delete"
              data-action="delete-relationship-event"
              data-rel-id="${escapeHTML(relId)}" data-event-id="${escapeHTML(evt.id)}"
              title="${t("WITCHER.Chrome.Journal.Text.RemoveEvent", "Remove event")}"><i class="fa-solid fa-xmark"></i></button>`}
    </div>
  `;
}

function renderChip(filter, icon, label, count) {
  return `<button class="jnl-chip${activeFilter === filter ? " is-active" : ""}" data-filter="${filter}"><i class="fa-solid ${icon}"></i>${escapeHTML(label)}${count > 0 ? `<span class="chip-count">${count}</span>` : ""}</button>`;
}

function renderCard(page, currentId) {
  const tag = getTag(page);
  const meta = TAG_META()[tag] ?? TAG_META()[TAG_ENTRY];
  const pinned = isPinned(page);
  const active = page.id === currentId;
  const modified = page._stats?.modifiedTime ?? 0;
  const icon = getIcon(page);
  const dateLabel = getGameDateLabel(page);
  const dayChip = dateLabel
    ? `<span class="card-day" title="Created on ${escapeHTML(dateLabel)}">${escapeHTML(dateLabel)}</span>`
    : "";
  return `
    <div class="card-row${active ? " is-active" : ""}${pinned ? " is-pinned" : ""}" data-page-id="${page.id}">
      <div class="card-thumb"><i class="fa-solid ${icon}"></i></div>
      <div class="card-text">
        <div class="card-name">${escapeHTML(page.name || t("WITCHER.Chrome.Journal.Text.Untitled", "(untitled)"))}</div>
        <div class="card-meta">${escapeHTML(meta.label)}${dayChip ? ` · ${dayChip}` : ""}${modified ? ` · ${formatRelative(modified)}` : ""}</div>
      </div>
      <button class="pin-btn${pinned ? " is-on" : ""}" data-action="toggle-pin" data-page-id="${page.id}" title="${pinned ? t("WITCHER.Chrome.Journal.Text.Unpin", "Unpin") : t("WITCHER.Chrome.Journal.Text.Pin", "Pin")}"><i class="fa-solid fa-thumbtack"></i></button>
      <div class="card-badge">${meta.badge}</div>
    </div>
  `;
}

function renderEditor(page) {
  const tag = getTag(page);
  const pinned = isPinned(page);
  const modified = page._stats?.modifiedTime ?? 0;
  const content = page.text?.content ?? "";
  const icon = getIcon(page);
  /* Editable in-game date. Defaults to the page's stamped createdWorldTime
   * (or now, for pages predating that flag). Hidden behind a "Change date"
   * button — clicking it swaps in an input + Save/Cancel that commit on
   * explicit Save (not on picker `change`), so a player can browse the
   * calendar without committing until they pick the date they want. */
  const dateSeconds = getCreatedWorldTime(page) ?? Number(game.time?.worldTime) ?? 0;
  const dateIso     = worldTimeToIso(dateSeconds);
  const isEditingDate = editingDatePageId === page.id;

  return `
    <div class="preview-hero">
      <div class="hero-thumb"><i class="fa-solid ${icon}"></i></div>
      <div class="hero-text">
        <div class="preview-name" data-page-id="${page.id}">${escapeHTML(page.name || t("WITCHER.Chrome.Journal.Text.Untitled", "(untitled)"))}</div>
        <div class="preview-meta">${(() => {
          const dateLabel = getGameDateLabel(page);
          const parts = [];
          if (pinned)   parts.push(t("WITCHER.Chrome.Journal.Text.Pinned", "Pinned"));
          if (dateLabel) parts.push(escapeHTML(dateLabel));
          if (modified) parts.push(tFormat("WITCHER.Chrome.Journal.Text.LastEdited", { rel: formatRelative(modified) }, `last edited ${formatRelative(modified)}`));
          return parts.join(" · ");
        })()}</div>
        <div class="preview-date-row">
          ${isEditingDate ? `
            <label class="preview-date-label" for="jnl-date-${escapeHTML(page.id)}">
              <i class="fa-solid fa-calendar-day"></i> ${t("WITCHER.Chrome.Journal.Text.EntryDate", "Entry date")}
            </label>
            <input type="date" class="preview-date-input"
                   id="jnl-date-${escapeHTML(page.id)}"
                   value="${escapeHTML(dateIso)}"
                   data-action="edit-page-date"
                   data-page-id="${page.id}" />
            <button type="button" class="preview-date-btn is-primary"
                    data-action="save-page-date" data-page-id="${page.id}"
                    title="${t("WITCHER.Chrome.Journal.Text.SaveThePickedDate", "Save the picked date")}">
              <i class="fa-solid fa-check"></i> Save
            </button>
            <button type="button" class="preview-date-btn"
                    data-action="cancel-page-date" data-page-id="${page.id}"
                    title="${t("WITCHER.Chrome.Journal.Text.DiscardChanges", "Discard changes")}">
              <i class="fa-solid fa-xmark"></i> ${t("WITCHER.Chrome.Journal.Text.Cancel", "Cancel")}
            </button>
          ` : `
            <button type="button" class="preview-date-btn"
                    data-action="open-page-date" data-page-id="${page.id}"
                    title="${t("WITCHER.Chrome.Journal.Text.ChangeTheInWorldDateOnThisEntryDefaultsT", "Change the in-world date on this entry. Defaults to the day it was created — pick an earlier date to backdate.")}">
              <i class="fa-solid fa-calendar-day"></i> ${t("WITCHER.Chrome.Journal.Text.ChangeDate", "Change date")}
            </button>
          `}
        </div>
        <div class="tag-picker">
          ${[TAG_ENTRY, TAG_QUEST, TAG_LORE].map(t => {
            const m = TAG_META()[t];
            return `<button class="tag-pill${tag === t ? " is-active" : ""}" data-action="set-tag" data-tag="${t}" data-page-id="${page.id}"><i class="fa-solid ${m.icon}"></i>${m.label}</button>`;
          }).join("")}
        </div>
        <div class="icon-picker">
          ${ICON_CHOICES.map(ic => `<button class="icon-choice${icon === ic ? " is-active" : ""}" data-action="set-icon" data-icon="${ic}" data-page-id="${page.id}" title="${ic.replace(/^fa-/, "")}"><i class="fa-solid ${ic}"></i></button>`).join("")}
        </div>
      </div>
    </div>

    <div class="preview-editor">
      <div class="editor-page-title" contenteditable="true" data-action="edit-title" data-page-id="${page.id}">${escapeHTML(page.name || "")}</div>
      <div class="editor-body" contenteditable="true" data-action="edit-body" data-page-id="${page.id}">${content}</div>
      <div class="editor-status">
        <span class="saved" data-bind="save-status"><i class="fa-solid fa-check"></i>Saved${modified ? ` · ${formatRelative(modified)}` : ""}</span>
      </div>
    </div>

    <div class="preview-foot">
      <button class="pf-btn" data-action="toggle-editor-focus" title="${t("WITCHER.Chrome.Journal.Text.TypeInFullScreen", "Type in full screen")}"><i class="fa-solid ${editorFocus ? "fa-compress" : "fa-expand"}"></i>${editorFocus ? t("WITCHER.Chrome.Journal.Text.ExitFullScreen", "Exit full screen") : t("WITCHER.Chrome.Journal.Text.FullScreen", "Full screen")}</button>
      <button class="pf-btn" data-action="new-page" title="${t("WITCHER.Chrome.Journal.Text.AddANewNotebookPage", "Add a new notebook page")}"><i class="fa-solid fa-plus"></i>${t("WITCHER.Chrome.Journal.Text.NewPage", "New page")}</button>
      <button class="pf-btn" data-action="toggle-pin-current" data-page-id="${page.id}" title="${pinned ? t("WITCHER.Chrome.Journal.Text.UnpinThisPage", "Unpin this page") : t("WITCHER.Chrome.Journal.Text.PinThisPage", "Pin this page")}"><i class="fa-solid fa-thumbtack"></i>${pinned ? t("WITCHER.Chrome.Journal.Text.Unpin", "Unpin") : t("WITCHER.Chrome.Journal.Text.Pin", "Pin")}</button>
      <label class="pf-toggle" title="${t("WITCHER.Chrome.Journal.Text.IncludeThisEntryOnTheFutureTimelineView", "Include this entry on the future timeline view")}">
        <input type="checkbox" data-action="toggle-timeline-show" data-page-id="${page.id}"
               ${showsInTimeline(page) ? "checked" : ""} />
        <span>${t("WITCHER.Chrome.Journal.Text.ShowsInTimeline", "Shows in timeline")}</span>
      </label>
      <button class="pf-btn danger" data-action="delete-page" data-page-id="${page.id}" title="${t("WITCHER.Chrome.Journal.Text.DeleteThisPage", "Delete this page")}"><i class="fa-solid fa-trash"></i>${t("WITCHER.Chrome.Journal.Text.Delete", "Delete")}</button>
    </div>
  `;
}

function showsInTimeline(page) {
  return page?.flags?.[MODULE_ID]?.showInTimeline === true;
}

function renderNoSelection() {
  return `
    <div class="preview-empty">
      <div class="empty-icon"><i class="fa-solid fa-book-open"></i></div>
      <div class="empty-title">${t("WITCHER.Chrome.Journal.Text.NoPageSelected", "No page selected")}</div>
      <div class="empty-hint">${t("WITCHER.Chrome.Journal.Text.PickAnEntryOrNew", "Pick an entry on the left, or create a new one.")}</div>
      <button class="pf-btn" data-action="new-page"><i class="fa-solid fa-plus"></i>${t("WITCHER.Chrome.Journal.Text.NewPage", "New page")}</button>
    </div>
  `;
}

function renderEmptyState(msg) {
  return `
    <div class="jnl-noactor">
      <div class="empty-icon"><i class="fa-solid fa-book-open"></i></div>
      <div>${escapeHTML(msg)}</div>
    </div>
  `;
}

/* =========================================================================
   DATA HELPERS
   ========================================================================= */

function collectPages(journal) {
  /* Sort by modifiedTime desc so most recent edits surface first. */
  return [...journal.pages.contents].sort((a, b) =>
    (b._stats?.modifiedTime ?? 0) - (a._stats?.modifiedTime ?? 0)
  );
}

function filterPages(pages, filter, search) {
  let out = pages;
  if (filter === "pinned")  out = out.filter(isPinned);
  else if (filter !== "all") out = out.filter(p => getTag(p) === filter);

  const needle = (search ?? "").trim().toLowerCase();
  if (needle) {
    out = out.filter(p => (p.name ?? "").toLowerCase().includes(needle));
  }
  return out;
}

function getTag(page) {
  return page.getFlag(MODULE_ID, "tag") ?? TAG_ENTRY;
}

function isPinned(page) {
  return !!page.getFlag(MODULE_ID, "pinned");
}

/** Resolve the FA icon class for a page — custom flag if set, else the
 *  tag's default thumb.  Both card list and hero use this. */
function getIcon(page) {
  const custom = page.getFlag(MODULE_ID, "icon");
  if (custom && ICON_CHOICES.includes(custom)) return custom;
  const tag = getTag(page);
  return (TAG_META()[tag] ?? TAG_META()[TAG_ENTRY]).thumb;
}

/* =========================================================================
   EVENT WIRING
   ========================================================================= */

function wireListeners(root) {
  /* Single delegated click handler.  Identify the target by data-action
   * and (where relevant) data-page-id. */
  root.addEventListener("click", onClick);

  /* Editor blur — save title + body when focus leaves. */
  root.querySelectorAll('[data-action="edit-title"]').forEach(el => {
    el.addEventListener("blur", onTitleBlur);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); el.blur(); }
    });
  });
  /* IMPORTANT: only save the body on BLUR, never on input.  An input-time
   * save fires `updateJournalEntryPage`, which triggers our hook, which
   * re-renders the panel — which replaces the contenteditable element the
   * user is typing into.  Net effect: cursor + focus get nuked mid-type,
   * which reads as "the editor doesn't let me write".  Title has the same
   * pattern so we use blur for both. */
  root.querySelectorAll('[data-action="edit-body"]').forEach(el => {
    el.addEventListener("blur", onBodyBlur);
  });

  /* Relationship core fields — name/type/full-name/age/gender/homeland/bio.
   * Inputs + textareas commit on blur; selects commit on change. */
  root.querySelectorAll('[data-action="edit-relationship-field"]').forEach(el => {
    if (el.tagName === "SELECT") {
      el.addEventListener("change", onRelationshipFieldCommit);
    } else {
      el.addEventListener("blur", onRelationshipFieldCommit);
      if (el.tagName === "INPUT") {
        el.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); el.blur(); }
        });
      }
    }
  });

  /* Relationship event fields (date/title/body) — same blur-commit. */
  root.querySelectorAll('[data-action="edit-relationship-event-field"]').forEach(el => {
    el.addEventListener("blur", onRelationshipEventCommit);
    if (el.tagName === "INPUT") {
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); el.blur(); }
      });
    }
  });

  /* Personality tag add — Enter on the tail input commits the typed
   * value as a new chip + clears the input. */
  root.querySelectorAll('[data-action="add-personality-tag"]').forEach(el => {
    el.addEventListener("keydown", onPersonalityTagKeydown);
  });

  /* "Shows in timeline" checkbox — change event is the reliable signal
   * for checkbox state, not click (avoids racing the delegated click
   * handler that fires for the surrounding label). */
  root.querySelectorAll('input[data-action="toggle-timeline-show"]').forEach(el => {
    el.addEventListener("change", onTimelineToggleChange);
  });

  /* Mouse-wheel over the timeline smooth-zooms toward the cursor (down = out,
   * up = in). Accumulates on the target so fast scrolls ease in one motion. */
  root.querySelectorAll(".jnl-tl-track-wrap").forEach(wrap => {
    wrap.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      // Accumulate the factor and coalesce to ONE zoom per frame — a fast wheel
      // otherwise fired a layout-reading applyTimelineZoom per event.
      _tlWheelAccum *= ev.deltaY < 0 ? TL_ZOOM_FACTOR : 1 / TL_ZOOM_FACTOR;
      _tlWheelX = ev.clientX;
      if (!_tlWheelRAF) _tlWheelRAF = requestAnimationFrame(() => {
        _tlWheelRAF = 0;
        applyTimelineZoom(tlZoomTarget * _tlWheelAccum, _tlWheelX);
        _tlWheelAccum = 1;
      });
    }, { passive: false });

    /* Click-drag anywhere on the track pans horizontally (no scrollbars). A
     * small movement threshold keeps taps/hovers on the event dots working. */
    wrap.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      const startX = ev.clientX;
      const startScroll = wrap.scrollLeft;
      let panning = false;
      const onMove = (e) => {
        const dx = e.clientX - startX;
        if (!panning) {
          if (Math.abs(dx) < 4) return;
          panning = true;
          wrap.classList.add("is-panning");
          try { wrap.setPointerCapture(ev.pointerId); } catch (_) {}
        }
        const maxScroll = Math.max(0, tlTrackPx() + _tlScrollExtra - tlWrapPx());
        const sl = Math.max(0, Math.min(maxScroll, startScroll - dx));
        wrap.scrollLeft = sl;
        _tlScrollLeft = sl;
        /* Ticks are virtualized to the visible window, so a pan reveals a new
         * range — repaint them (and the observed-year mark) once per frame. */
        if (!_tlPanRAF) _tlPanRAF = requestAnimationFrame(() => {
          _tlPanRAF = 0;
          const wp = tlWrapPx();
          repaintVisibleTicks(wp, _tlScrollLeft);
          updateObservedYear(wp, _tlScrollLeft);
        });
      };
      const onUp = () => {
        wrap.removeEventListener("pointermove", onMove);
        wrap.removeEventListener("pointerup", onUp);
        wrap.removeEventListener("pointercancel", onUp);
        wrap.classList.remove("is-panning");
        try { wrap.releasePointerCapture(ev.pointerId); } catch (_) {}
      };
      wrap.addEventListener("pointermove", onMove);
      wrap.addEventListener("pointerup", onUp);
      wrap.addEventListener("pointercancel", onUp);
    });
  });

  /* Drag-and-drop: importing an actor as a relationship entry.
   *
   * Users drag any Actor (character / monster / merchant) from the
   * Foundry sidebar onto the Relationships list. The drop parses
   * Foundry's standard drag payload (`{type:"Actor", uuid:"..."}`)
   * and snapshots the actor's identity fields into a fresh entry.
   * Non-Actor drops (Items, Journals, Macros, etc.) are ignored so
   * the panel's other drop targets aren't stepped on.
   *
   * Both `dragover` and `drop` are attached — Foundry (and every
   * browser) requires an explicit `dragover.preventDefault()` for
   * the drop to fire on the target. Scoped to `.jnl-rel-left` (the
   * whole left column) so users have a large forgiving hit area,
   * not just the tight list rows. */
  root.querySelectorAll(".jnl-rel-left").forEach(dropZone => {
    dropZone.addEventListener("dragover", (ev) => {
      /* Cheap early exit: only accept when the payload looks like an
       * Actor. Reading `dataTransfer.types` is safe in `dragover`;
       * reading `getData()` isn't (returns empty until drop). We
       * still allow the drop even without a type hint since some
       * drag sources omit it, and rely on the `drop` handler to
       * validate the actual payload. */
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "copy";
      dropZone.classList.add("is-drop-target");
    });
    dropZone.addEventListener("dragleave", () => {
      dropZone.classList.remove("is-drop-target");
    });
    dropZone.addEventListener("drop", async (ev) => {
      dropZone.classList.remove("is-drop-target");
      let data;
      try { data = JSON.parse(ev.dataTransfer.getData("text/plain")); }
      catch { return; }
      if (data?.type !== "Actor" || !data?.uuid) return;
      ev.preventDefault();
      ev.stopPropagation();
      const actor = getActor();
      if (!actor) return;
      const source = await fromUuid(data.uuid);
      if (!source) return;
      /* Gate on the three supported actor types so a stray Loot /
       * Mystery drop doesn't create a half-populated entry. */
      const supported = new Set(["character", "monster", "merchant"]);
      if (!supported.has(source.type)) {
        ui.notifications?.warn(t(
          "WITCHER.Chrome.Journal.Notify.UnsupportedRelationshipActor",
          "Only characters, monsters, and merchants can be imported as relationships."
        ));
        return;
      }
      /* Don't allow importing yourself — a relationship entry for
       * the bound character is meaningless. */
      if (source.uuid === actor.uuid) {
        ui.notifications?.warn(t(
          "WITCHER.Chrome.Journal.Notify.CannotImportSelf",
          "Can't create a relationship entry pointing at yourself."
        ));
        return;
      }
      await addRelationshipFromActor(actor, source);
      /* Re-render is triggered by the actor-flag update hook. */
    });
  });

  /* Editable in-world date: the input itself just stores the pending
   * pick; commit happens on the Save button below (which routes through
   * the click delegator as `save-page-date`). No `change` listener here
   * — the user can browse the picker without committing. */
  root.querySelectorAll('input[data-action="edit-page-date"]').forEach(el => {
    /* Autofocus + open when the row appears so Change → picker is one
     * step in practice. showPicker() is Chromium/Firefox-native; guarded
     * because Safari lacks it. */
    if (!el.dataset.autofocused) {
      el.dataset.autofocused = "1";
      try { el.focus({ preventScroll: true }); } catch (_) {}
      try { el.showPicker?.(); } catch (_) {}
    }
    /* Enter = save; Esc = cancel. Keeps keyboard flow snappy. */
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter")   { e.preventDefault(); commitPageDate(el); }
      if (e.key === "Escape")  { e.preventDefault(); editingDatePageId = null; render(); }
    });
  });

  /* Search box — debounced re-render so we filter in real time without
   * thrashing on every keystroke. Focus + caret position are restored
   * after the rerender since render() replaces the input element. */
  const searchInput = root.querySelector('.jnl-search');
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      activeSearch = e.target.value;
      const caret = searchInput.selectionStart;
      clearTimeout(_searchTimer);
      _searchTimer = setTimeout(async () => {
        await render();
        const fresh = panelEl?.querySelector('.jnl-search');
        if (fresh) {
          fresh.focus();
          /* Caret end-of-text by default; reuse old caret if applicable. */
          const pos = Math.min(caret ?? fresh.value.length, fresh.value.length);
          fresh.setSelectionRange(pos, pos);
        }
      }, 120);
    });
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && activeSearch) {
        e.preventDefault();
        activeSearch = "";
        render();
      }
    });
  }
}

async function onClick(ev) {
  /* Filter chips first — they don't carry data-action, just data-filter.
   * Handled BEFORE the data-action early-return so they actually fire. */
  const chip = ev.target.closest(".jnl-chip");
  if (chip) {
    ev.preventDefault();
    ev.stopPropagation();
    activeFilter = chip.dataset.filter ?? "all";
    activePageId = null;
    await render();
    return;
  }

  /* Card row → select page.  Skip when the click landed on the inner
   * pin-btn (which has data-action="toggle-pin") so pin clicks don't
   * also re-select the page. */
  const card = ev.target.closest(".card-row");
  if (card && !ev.target.closest("[data-action]")) {
    ev.preventDefault();
    const id = card.dataset.pageId;
    if (id && id !== activePageId) {
      activePageId = id;
      /* Switching pages discards any in-flight date edit — the picked
       * value hasn't been saved, and the new page has its own date. */
      editingDatePageId = null;
      await render();
    }
    return;
  }

  const actionEl = ev.target.closest("[data-action]");
  if (!actionEl) return;
  /* Native form controls need their built-in click → change cycle to fire
   * (preventDefault here would suppress checkbox toggle / select drop-
   * down).  The change-event listener takes over from there. */
  if (actionEl.dataset.action === "toggle-timeline-show") return;
  /* Date input's native click needs to reach the browser so the picker
   * opens. Save/Cancel are real buttons handled below like any other. */
  if (actionEl.dataset.action === "edit-page-date") return;
  ev.preventDefault();
  ev.stopPropagation();
  const action = actionEl.dataset.action;
  const pageId = actionEl.dataset.pageId;
  const actor = getActor();
  const journal = actor ? await getOrCreateJournal(actor) : null;

  switch (action) {
    case "close": {
      await setJournalOpen(false);
      return;
    }
    case "clear-search": {
      activeSearch = "";
      await render();
      return;
    }
    case "open-page-date": {
      if (!pageId) return;
      editingDatePageId = pageId;
      await render();
      return;
    }
    case "save-page-date": {
      const input = panelEl?.querySelector(`input[data-action="edit-page-date"][data-page-id="${pageId}"]`);
      if (input) await commitPageDate(input);
      return;
    }
    case "cancel-page-date": {
      editingDatePageId = null;
      await render();
      return;
    }
    case "toggle-pin":
    case "toggle-pin-current": {
      if (!journal || !pageId) return;
      const page = journal.pages.get(pageId);
      if (!page) return;
      await page.setFlag(MODULE_ID, "pinned", !isPinned(page));
      return;
    }
    case "set-tag": {
      if (!journal || !pageId) return;
      const page = journal.pages.get(pageId);
      if (!page) return;
      const tag = actionEl.dataset.tag;
      if (![TAG_ENTRY, TAG_QUEST, TAG_LORE].includes(tag)) return;
      await page.setFlag(MODULE_ID, "tag", tag);
      return;
    }
    case "set-icon": {
      if (!journal || !pageId) return;
      const page = journal.pages.get(pageId);
      if (!page) return;
      const icon = actionEl.dataset.icon;
      if (!ICON_CHOICES.includes(icon)) return;
      await page.setFlag(MODULE_ID, "icon", icon);
      return;
    }
    case "new-page": {
      if (!journal) return;
      const newPage = await createNewPage(journal);
      if (newPage) activePageId = newPage.id;
      return;
    }
    case "delete-page": {
      if (!journal || !pageId) return;
      await confirmDeletePage(journal, pageId);
      return;
    }
    case "set-journal-section": {
      const next = actionEl.dataset.section;
      if (next && next !== activeSection) {
        activeSection = next;
        await render();
      }
      return;
    }
    case "zoom-timeline-event": {
      /* Click a timeline entry's icon → smoothly fly to it (day-focused). */
      const pct = Number(actionEl.closest(".jnl-tl-branch")?.dataset.tlPct);
      if (Number.isFinite(pct)) zoomTimelineToFrac(pct / 100);
      return;
    }
    case "toggle-timeline-filter": {
      const src = actionEl.dataset.tlSource;
      if (!src) return;
      if (activeTimelineFilters.has(src)) activeTimelineFilters.delete(src);
      else                                activeTimelineFilters.add(src);
      await render();
      return;
    }
    case "timeline-zoom-in":
    case "timeline-zoom-out":
    case "timeline-zoom-reset": {
      /* Zoom around the view centre; DOM-direct so scroll + branches persist. */
      const target = action === "timeline-zoom-reset" ? 1
        : action === "timeline-zoom-in"  ? timelineZoom * TL_ZOOM_FACTOR
        :                                   timelineZoom / TL_ZOOM_FACTOR;
      applyTimelineZoom(target);
      return;
    }
    case "toggle-editor-focus": {
      /* Toggle the class + button DOM-directly rather than re-rendering, so
       * an in-progress edit (caret position, unsaved keystrokes) survives. */
      editorFocus = !editorFocus;
      panelEl?.classList.toggle("is-editor-focus", editorFocus);
      actionEl.innerHTML = `<i class="fa-solid ${editorFocus ? "fa-compress" : "fa-expand"}"></i>${editorFocus ? t("WITCHER.Chrome.Journal.Text.ExitFullScreen", "Exit full screen") : t("WITCHER.Chrome.Journal.Text.FullScreen", "Full screen")}`;
      return;
    }
    case "add-relationship": {
      if (!actor) return;
      await addRelationship(actor);
      /* Focus the new list row's name input after the updateActor hook
       * re-renders.  The new entry is always the most recently added in
       * the left list. */
      requestAnimationFrame(() => {
        const rows = panelEl?.querySelectorAll(".jnl-rel-row");
        const last = rows?.[rows.length - 1];
        last?.querySelector(".jnl-rel-row-name")?.focus?.();
      });
      return;
    }
    case "select-relationship": {
      if (!actor) return;
      const id = actionEl.dataset.relId;
      /* Bail if the click landed on a child control (those have their
       * own data-action and stopPropagation isn't enough on a row-level
       * delegate). */
      if (ev.target.closest("[data-action]") !== actionEl) return;
      if (id && id !== activeRelId) {
        activeRelId = id;
        await render();
      }
      return;
    }
    case "delete-relationship": {
      if (!actor) return;
      const id = actionEl.dataset.relId;
      if (!id) return;
      const rel = getRelationship(actor, id);
      const displayName = (rel?.name ?? "").trim() || "this relationship";
      const DialogV2 = foundry.applications.api.DialogV2;
      let confirmed = false;
      try {
        confirmed = await DialogV2.confirm({
          window: { title: t("WITCHER.Dialog.Journal.DeleteRelationship", "Delete relationship") },
          content: `<p>${tFormat("WITCHER.Chrome.Journal.Text.DeleteRelationshipConfirm", { name: escapeHTML(displayName) }, "Delete <b>{name}</b>?  Their portrait, bio, personality tags, and recorded events will all be lost.  This can't be undone.")}</p>`,
          modal: true,
          rejectClose: false,
        });
      } catch (e) {
        return;
      }
      if (!confirmed) return;
      await deleteRelationship(actor, id);
      return;
    }
    case "toggle-relationship-edit": {
      if (!actor) return;
      const id = actionEl.dataset.relId;
      if (!id) return;
      if (editingRelIds.has(id)) {
        /* Exit edit mode.  Force-blur any focused input first so its
         * in-flight value commits before the editor is removed from
         * the DOM.  Otherwise the user's last keystrokes would be
         * lost when we re-render. */
        const focused = panelEl?.querySelector('[data-action="edit-relationship-field"]:focus, [data-action="edit-relationship-event-field"]:focus, .rel-tag-input:focus');
        if (focused && typeof focused.blur === "function") focused.blur();
        editingRelIds.delete(id);
      } else {
        editingRelIds.add(id);
      }
      await render();
      return;
    }
    case "upload-rel-portrait": {
      if (!actor) return;
      const id = actionEl.dataset.relId;
      if (!id || !editingRelIds.has(id)) return;
      const rel = getRelationship(actor, id);
      if (!rel) return;
      openPortraitPicker(actor, id, rel.portrait);
      return;
    }
    case "add-relationship-event": {
      if (!actor) return;
      const id = actionEl.dataset.relId;
      if (!id || !editingRelIds.has(id)) return;
      const evt = await addRelationshipEvent(actor, id);
      if (evt) {
        requestAnimationFrame(() => {
          const node = panelEl?.querySelector(`.rel-event[data-event-id="${evt.id}"] .rel-event-date`);
          node?.focus?.();
        });
      }
      return;
    }
    case "delete-relationship-event": {
      if (!actor) return;
      const relId   = actionEl.dataset.relId;
      const eventId = actionEl.dataset.eventId;
      if (!relId || !eventId || !editingRelIds.has(relId)) return;
      await deleteRelationshipEvent(actor, relId, eventId);
      return;
    }
    case "remove-personality-tag": {
      if (!actor) return;
      const relId = actionEl.dataset.relId;
      const idx   = Number(actionEl.dataset.tagIndex);
      if (!relId || !editingRelIds.has(relId) || !Number.isFinite(idx)) return;
      const rel = getRelationship(actor, relId);
      if (!rel) return;
      const tags = (rel.personalityTags ?? []).filter((_, i) => i !== idx);
      await updateRelationship(actor, relId, { personalityTags: tags });
      return;
    }
  }
}

/* Open Foundry's FilePicker scoped to image files; on selection, validate
 * the extension against PORTRAIT_EXTS and write the path back to the
 * relationship.  FilePicker handles upload-to-user-data internally when
 * the user has FILES_UPLOAD permission. */
function openPortraitPicker(actor, relId, currentPath) {
  const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
  if (!FP) {
    ui.notifications?.error?.(t("WITCHER.Notify.Journal.NoFilePicker", "FilePicker not available."));
    return;
  }
  const fp = new FP({
    type: "image",
    current: currentPath || "",
    callback: async (path) => {
      const clean = String(path ?? "").trim();
      if (!clean) return;
      const ext = clean.split(".").pop()?.toLowerCase();
      if (!PORTRAIT_EXTS.includes(ext)) {
        ui.notifications?.warn?.(tFormat("WITCHER.Notify.Journal.PortraitFormat", { ext: ext }, "Portrait must be PNG, JPEG, or WebP — got .{ext}."));
        return;
      }
      await updateRelationship(actor, relId, { portrait: clean });
    },
  });
  fp.render(true);
}

/* Title and body autosave.  Title saves on blur or Enter.  Body saves on
 * blur AND debounces a save 1.2s after the last keystroke. */
async function onTitleBlur(ev) {
  const id = ev.currentTarget.dataset.pageId;
  if (!id) return;
  const actor = getActor();
  const journal = actor ? await getOrCreateJournal(actor) : null;
  const page = journal?.pages.get(id);
  if (!page) return;
  const newName = ev.currentTarget.textContent.trim() || "(untitled)";
  if (newName === page.name) return;
  await page.update({ name: newName });
  flashSaved();
}

async function onBodyBlur(ev) {
  await saveBodyFromEl(ev.currentTarget);
}

async function onTimelineToggleChange(ev) {
  const id = ev.currentTarget.dataset.pageId;
  if (!id) return;
  const actor = getActor();
  const journal = actor ? await getOrCreateJournal(actor) : null;
  const page = journal?.pages.get(id);
  if (!page) return;
  await page.setFlag(MODULE_ID, "showInTimeline", !!ev.currentTarget.checked);
}

/* Commit the value from a date input to its page's createdWorldTime
 * flag. Used by both the Save button and the Enter-key shortcut. Clears
 * the in-progress edit state so the row collapses back to the button. */
async function commitPageDate(inputEl) {
  const id = inputEl?.dataset?.pageId;
  if (!id) return;
  const actor = getActor();
  const journal = actor ? await getOrCreateJournal(actor) : null;
  const page = journal?.pages.get(id);
  if (!page) return;
  const iso = String(inputEl.value ?? "").trim();
  if (!iso) {
    try { await page.unsetFlag(MODULE_ID, "createdWorldTime"); }
    catch (e) { console.warn(`${MODULE_ID} | clear entry date failed`, e); }
    editingDatePageId = null;
    await render();
    return;
  }
  const ts = isoToWorldTime(iso);
  if (ts == null) {
    ui.notifications?.warn?.(t("WITCHER.Notify.Journal.DateInvalid",
      "Couldn't parse that date against the world calendar."));
    return;
  }
  try { await page.setFlag(MODULE_ID, "createdWorldTime", ts); }
  catch (e) {
    console.warn(`${MODULE_ID} | set entry date failed`, e);
    ui.notifications?.error?.(t("WITCHER.Notify.Journal.DateSaveFailed",
      "Could not save entry date — see console."));
    return;
  }
  editingDatePageId = null;
  /* setFlag triggers the doc-update hook → render(), so the row will
   * refresh anyway. Explicit render() covers the case where the flag
   * value ends up equal to what was already stored (no-op update, no
   * hook, no re-render). */
  await render();
}

async function onRelationshipFieldCommit(ev) {
  const el    = ev.currentTarget;
  const id    = el.dataset.relId;
  const field = el.dataset.field;
  const type  = el.dataset.relType;
  if (!id || !field) return;
  const actor = getActor();
  if (!actor) return;
  let value;
  if (type === "number") {
    const n = Number(el.value);
    value = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  } else {
    value = String(el.value ?? "");
  }
  await updateRelationship(actor, id, { [field]: value });
}

async function onRelationshipEventCommit(ev) {
  const el      = ev.currentTarget;
  const relId   = el.dataset.relId;
  const eventId = el.dataset.eventId;
  const field   = el.dataset.field;
  if (!relId || !eventId || !field) return;
  const actor = getActor();
  if (!actor) return;
  await updateRelationshipEvent(actor, relId, eventId, { [field]: String(el.value ?? "") });
}

async function onPersonalityTagKeydown(ev) {
  if (ev.key !== "Enter") return;
  ev.preventDefault();
  const el    = ev.currentTarget;
  const relId = el.dataset.relId;
  const raw   = String(el.value ?? "").trim();
  if (!raw || !relId) return;
  const actor = getActor();
  if (!actor) return;
  const rel = getRelationship(actor, relId);
  if (!rel || rel.locked) return;
  /* Dedupe — case-insensitive — so the same tag isn't added twice if
   * the user repeats themselves. */
  const existing = (rel.personalityTags ?? []).map(t => t.toLowerCase());
  if (existing.includes(raw.toLowerCase())) {
    el.value = "";
    return;
  }
  const next = [...(rel.personalityTags ?? []), raw];
  el.value = "";
  await updateRelationship(actor, relId, { personalityTags: next });
}

async function saveBodyFromEl(el) {
  const id = el.dataset.pageId;
  if (!id) return;
  const actor = getActor();
  const journal = actor ? await getOrCreateJournal(actor) : null;
  const page = journal?.pages.get(id);
  if (!page) return;
  const html = el.innerHTML;
  if (html === (page.text?.content ?? "")) return;
  await page.update({ "text.content": html });
  flashSaved();
}

function flashSaved() {
  const status = panelEl?.querySelector('[data-bind="save-status"]');
  if (!status) return;
  status.innerHTML = `<i class="fa-solid fa-check"></i>Saved · just now`;
}

async function createNewPage(journal) {
  /* Default tag = current filter if it's a tag, else "entry" */
  const tag = [TAG_ENTRY, TAG_QUEST, TAG_LORE].includes(activeFilter) ? activeFilter : TAG_ENTRY;
  const meta = TAG_META()[tag];
  /* Stamp the in-game worldTime at creation so the entry can display a
   * stable "Day N" badge for the rest of its life.  worldTime is a
   * Foundry-managed seconds-from-epoch counter that GMs advance via the
   * weather console's Time tab or game.time.advance(). */
  const createdWorldTime = Number(game.time?.worldTime) || 0;
  try {
    const [created] = await journal.createEmbeddedDocuments("JournalEntryPage", [{
      name: `New ${meta.label}`,
      type: "text",
      text: { content: "<p></p>", format: 1 },
      flags: { [MODULE_ID]: { tag, pinned: false, createdWorldTime } }
    }]);
    return created;
  } catch (e) {
    console.warn(`${MODULE_ID} | failed to create page`, e);
    ui.notifications?.warn(t("WITCHER.Notify.Journal.PageCreateFailed", "Could not create page."));
    return null;
  }
}

/* In-game date a page was created on.  Prefers a verbose calendar date
 * ("12th of June, 1270") when Foundry's world calendar is configured,
 * falls back to a simple "Day N" count when it isn't.  Returns null
 * when the page has no createdWorldTime flag (entries that pre-date
 * this feature) so callers can omit the badge entirely. */
const SECONDS_PER_DAY = 86400;

function getCreatedWorldTime(page) {
  const t = page?.flags?.[MODULE_ID]?.createdWorldTime;
  if (t === undefined || t === null) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function getGameDateLabel(page) {
  const t = getCreatedWorldTime(page);
  if (t === null) return null;

  /* Verbose calendar form — same pattern weather.js uses for its date
   * strip, so the two displays read consistently. */
  const cal = game.time?.calendar;
  if (cal && typeof cal.timeToComponents === "function") {
    try {
      const c = cal.timeToComponents(t);
      if (c) {
        const calendarConfig = globalThis.CONFIG?.time?.worldCalendarConfig ?? {};
        const monthRaw  = calendarConfig.months?.values?.[c.month]?.name ?? "";
        const monthName = monthRaw ? game.i18n.localize(monthRaw) : "";
        /* Foundry calendar's dayOfMonth is 0-based — add 1 for display. */
        const humanDay = (c.dayOfMonth ?? 0) + 1;
        if (monthName) return tFormat("WITCHER.Chrome.Journal.Text.DateWithMonth", { day: ordinal(humanDay), month: monthName, year: c.year }, `${ordinal(humanDay)} of ${monthName}, ${c.year}`);
        if (c.year != null) return tFormat("WITCHER.Chrome.Journal.Text.DateShort", { day: ordinal(humanDay), year: c.year }, `${ordinal(humanDay)}, ${c.year}`);
      }
    } catch (e) { /* fall through to simple form */ }
  }

  /* Simple-day fallback when no calendar is configured. */
  const day = Math.max(1, Math.floor(t / SECONDS_PER_DAY) + 1);
  return tFormat("WITCHER.Chrome.Journal.Text.DayN", { day }, `Day ${day}`);
}

function ordinal(n) {
  const s = n % 10, t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  if (s === 1) return `${n}st`;
  if (s === 2) return `${n}nd`;
  if (s === 3) return `${n}rd`;
  return `${n}th`;
}

async function confirmDeletePage(journal, pageId) {
  const page = journal.pages.get(pageId);
  if (!page) return;
  const DialogV2 = foundry.applications.api.DialogV2;
  let confirmed = false;
  try {
    confirmed = await DialogV2.confirm({
      window: { title: t("WITCHER.Dialog.Journal.DeletePage", "Delete page") },
      content: `<p>${tFormat("WITCHER.Chrome.Journal.Dialog.DeletePageConfirm", { name: escapeHTML(page.name) }, `Delete "<b>${escapeHTML(page.name)}</b>"?  This can't be undone.`)}</p>`,
      modal: true,
      rejectClose: false
    });
  } catch (e) {
    return;
  }
  if (!confirmed) return;
  await journal.deleteEmbeddedDocuments("JournalEntryPage", [pageId]);
  if (activePageId === pageId) activePageId = null;
  /* Hook re-renders. */
}

/* =========================================================================
   UTILS
   ========================================================================= */

/* Coalesce: collapse a flurry of hook callbacks into one render per
 * animation frame, and only when the journal panel is open. */
let _journalRenderPending = false;
function rerenderIfOpen() {
  if (_journalRenderPending) return;
  if (!isJournalOpen()) return;
  _journalRenderPending = true;
  requestAnimationFrame(() => {
    _journalRenderPending = false;
    if (!isJournalOpen()) return;
    render();
  });
}

function syncTopbarTab(open) {
  const tab = document.querySelector('#wou-top-bar .tab[data-tab="journal"]');
  if (!tab) return;
  tab.classList.toggle("is-active", open);
}

function escapeHTML(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatRelative(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}
