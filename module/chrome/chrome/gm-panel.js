/**
 * GM Panel — a GM-only tabbed popover anchored to an independent "eye" button
 * (#wou-gm-fab) pinned at the far LEFT of the bottom bar. The button is a
 * position:fixed child of #interface (NOT the dock), vertically aligned to the
 * dock band via alignFab() so it never disturbs the dock's grid. Tabs:
 * Party (live actor console) / Reference (rules cheat-sheets) / Pinboard
 * (GM handouts + notes) / Session (group skill roll + reward distribution).
 *
 * Mirrors the skills-panel.js idioms exactly:
 *   • body-singleton popover appended to <body>
 *   • positionPanel() pins the popover's BOTTOM edge above the trigger button,
 *     reserves the #sidebar footprint in the left clamp, clamps to viewport
 *   • capture-phase document click closes when outside the panel / button
 *   • Esc keydown closes; window resize repositions while open
 *   • a module `_wired` idempotency guard
 *
 * Never shown to players: setupGMPanel() bails (and removes any stray button)
 * when game.user.isGM is false.
 */

import { MODULE_ID } from "../setup/settings.js";

const PANEL_ID = "wou-gm-panel";

/* Tab definitions — order is the strip order. icon = FontAwesome glyph. */
const TABS = [
  { key: "party",     label: "Party",     icon: "fa-users" },
  { key: "reference", label: "Reference", icon: "fa-book-open" },
  { key: "pinboard",  label: "Pinboard",  icon: "fa-thumbtack" },
  { key: "session",   label: "Session",   icon: "fa-hourglass-half" },
];

let _wired = false;
let _activeTab = "party";

/* ─────────── party roster + filter state ─────────── */

const _partyFilter = { pcs: true, npcs: false, combatants: true, scene: false };

/* De-duped union of enabled sources, keyed by actor uuid (so synthetic
   token actors that share a base actor's id stay distinct). */
function collectRosterActors() {
  const out = new Map();
  const EXCLUDE_TYPES = new Set(["loot", "merchant"]);   // not creatures to manage
  const add = (a) => { if (a?.uuid && !EXCLUDE_TYPES.has(a.type)) out.set(a.uuid, a); };
  if (_partyFilter.pcs)        for (const a of game.actors ?? []) if (a.type === "character" && a.hasPlayerOwner) add(a);
  if (_partyFilter.npcs)       for (const a of game.actors ?? []) if (!a.hasPlayerOwner) add(a);   // GM-controlled, not player-assigned
  if (_partyFilter.combatants) for (const c of game.combat?.combatants ?? []) add(c.actor);
  if (_partyFilter.scene)      for (const t of canvas?.tokens?.placeables ?? []) add(t.actor);
  return [...out.values()];
}

/* Vital read model. Stress is a flat field with no max → max:null. */
function readVitals(actor) {
  const s = actor.system ?? {};
  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    hp:  { value: num(s.derivedStats?.hp?.value),  max: num(s.derivedStats?.hp?.max) },
    sta: { value: num(s.derivedStats?.sta?.value), max: num(s.derivedStats?.sta?.max) },
    tox: { value: num(s.stats?.toxicity?.value),   max: num(s.stats?.toxicity?.max, 100) },
    adr: { value: num(s.adrenaline?.value),        max: num(s.stats?.body?.value) },
    str: { value: num(s.stress),                   max: null },   // flat field, no max
  };
}

/* ─────────── helpers ─────────── */

function escapeHTML(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/* ─────────── pinboard image lightbox ─────────── */

function getLightbox() {
  let el = document.getElementById("wou-gm-lightbox");
  if (el) return el;
  el = document.createElement("div");
  el.id = "wou-gm-lightbox";
  el.innerHTML = `<img alt="" />`;
  document.body.appendChild(el);
  return el;
}
function openLightbox(src) {
  const el = getLightbox();
  el.querySelector("img").src = src;
  el.classList.add("is-open");
}
function lightboxOpen() { return document.getElementById("wou-gm-lightbox")?.classList.contains("is-open") === true; }
function closeLightbox() { document.getElementById("wou-gm-lightbox")?.classList.remove("is-open"); }

/* ─────────── pinboard store ─────────── */

const PINBOARD_KEY = "gmPinboard";
function getPinboard() {
  // Deep-clone so callers can mutate freely; changes only persist via setPinboard.
  return foundry.utils.deepClone(
    game.settings.get(MODULE_ID, PINBOARD_KEY) ?? { images: [], links: [], notes: "" }
  );
}
async function setPinboard(data) {
  await game.settings.set(MODULE_ID, PINBOARD_KEY, data);
}

function renderPinboardTab(body) {
  if (!body) return;
  const pin = getPinboard();
  const imgs = (pin.images ?? []).map((src, i) =>
    `<div class="wou-gm-pin-img"><img src="${escapeHTML(src)}" alt="" /><button type="button" class="rm" data-pin-rm-img="${i}" title="Remove">×</button></div>`).join("");
  const links = (pin.links ?? []).map((l, i) =>
    `<div class="wou-gm-pin-link"><a data-pin-open="${escapeHTML(l.uuid)}">${escapeHTML(l.name)}</a><button type="button" class="rm" data-pin-rm-link="${i}" title="Remove">×</button></div>`).join("");
  body.innerHTML = `
    <div class="wou-gm-pin-actions">
      <button type="button" class="wou-gm-pin-addimg"><i class="fa-solid fa-image"></i> Add image</button>
      <span class="hint">…or drop a Journal/Actor/Item here</span>
    </div>
    <div class="wou-gm-pin-grid">${imgs}</div>
    <div class="wou-gm-pin-links">${links}</div>
    <textarea class="wou-gm-pin-notes" placeholder="GM notes…">${escapeHTML(pin.notes ?? "")}</textarea>
  `;
  applyNotesHeight(body);
}

/* ─────────── dock button ─────────── */

let _fabAlignObs = null;

/** Vertically center the GM button on the dock band (the dock height swaps
 *  between peace/combat, so realign whenever it changes). */
function alignFab() {
  const fab = document.getElementById("wou-gm-fab");
  if (!fab) return;
  const dock = document.getElementById("wou-dock");
  if (dock) {
    const r = dock.getBoundingClientRect();
    fab.style.top = `${Math.round(r.top + r.height / 2 - fab.offsetHeight / 2)}px`;
    fab.style.bottom = "auto";
  }
}

/** Independent, fixed GM button at the far left of the bottom bar.  Appended
 *  to #interface (NOT the dock), so it never disturbs the dock's grid. */
function injectGmButton() {
  if (document.getElementById("wou-gm-fab")) { alignFab(); return; }
  const host = document.getElementById("interface") || document.body;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "wou-gm-fab";
  btn.className = "wou-gm-btn";
  btn.title = "GM Panel";
  btn.setAttribute("aria-label", "GM Panel");
  btn.innerHTML = `<i class="fa-solid fa-eye"></i>`;
  host.appendChild(btn);
  alignFab();
  const dock = document.getElementById("wou-dock");
  if (dock && window.ResizeObserver && !_fabAlignObs) {
    _fabAlignObs = new ResizeObserver(() => alignFab());
    _fabAlignObs.observe(dock);
  }
}

/* ─────────── panel DOM ─────────── */

function getPanel() {
  let panel = document.getElementById(PANEL_ID);
  if (panel) return panel;
  panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.className = "wou-gm-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "GM Panel");
  document.body.appendChild(panel);
  return panel;
}

function buildPanelHTML() {
  const tabsHtml = TABS.map(t =>
    `<button type="button" class="wou-gm-tab${t.key === _activeTab ? " is-active" : ""}" data-tab="${t.key}" title="${escapeHTML(t.label)}" aria-label="${escapeHTML(t.label)}">
      <i class="fa-solid ${t.icon}"></i><span class="nm">${escapeHTML(t.label)}</span>
    </button>`
  ).join("");
  return `
    <div class="wou-gm-tabs" role="tablist">${tabsHtml}</div>
    <div class="wou-gm-body"></div>`;
}

/* Single dispatch point — later tasks extend this switch to fill each tab. */
function renderActiveTab(panel) {
  const body = panel.querySelector(".wou-gm-body");
  if (!body) return;
  const tab = TABS.find(t => t.key === _activeTab)?.key ?? _activeTab;
  switch (_activeTab) {
    case "party":
      renderPartyTab(body);
      break;
    case "reference":
      renderReferenceTab(body);
      break;
    case "pinboard":
      renderPinboardTab(body);
      break;
    case "session":
      renderSessionTab(body);
      break;
    default:
      body.innerHTML = `<div class="wou-gm-empty">${escapeHTML(tab)} — coming soon</div>`;
      break;
  }
}

/* ─────────── party tab renderer ─────────── */

const VITAL_DEFS = [
  { key: "hp",  label: "HP"  },
  { key: "sta", label: "STA" },
  { key: "tox", label: "Tox" },
  { key: "adr", label: "Adr" },
  { key: "str", label: "Str" },
];

function renderPartyTab(body) {
  if (!body) return;
  const chips = [["pcs", "PCs"], ["npcs", "NPCs"], ["combatants", "Combatants"], ["scene", "This Scene"]]
    .map(([k, lbl]) => `<button type="button" class="wou-gm-chip${_partyFilter[k] ? " is-on" : ""}" data-filter="${k}">${lbl}</button>`).join("");

  const actors = collectRosterActors();
  const rows = actors.length ? actors.map(a => {
    const v = readVitals(a);
    const cells = VITAL_DEFS.map(d => {
      const mx = v[d.key].max == null ? "" : `<span class="mx">/${v[d.key].max}</span>`;
      return `<label class="wou-gm-vital">
        <span class="lbl">${d.label}</span>
        <input type="number" class="val" data-actor-uuid="${escapeHTML(a.uuid)}" data-stat="${d.key}" value="${v[d.key].value}" />
        ${mx}
      </label>`;
    }).join("");
    return `<div class="wou-gm-row" data-actor-row="${escapeHTML(a.uuid)}">
      <img class="port" src="${escapeHTML(a.img)}" alt="" />
      <div class="who"><span class="nm">${escapeHTML(a.name)}</span></div>
      <div class="vitals">${cells}</div>
      ${statusStrip(a)}
    </div>`;
  }).join("") : `<div class="wou-gm-empty">No actors match the current filters.</div>`;

  body.innerHTML = `<div class="wou-gm-chips">${chips}</div><div class="wou-gm-roster">${rows}</div>`;
}

/* Per-actor open/closed memory for the Status Effects collapsible.
 * Survives the re-render that follows a status click (without this,
 * every click reset the <details> to its default closed state — the
 * user's manual expand disappeared the moment they made any change). */
const _openStatusActors = new Set();

/* Per-actor status block on the GM party panel.
 *
 *   Wrapped in a <details class="wou-gm-statuses-collapse" open> so
 *   the (long) grid of toggle buttons can be folded per actor. Starts
 *   expanded; the GM clicks the chevron to hide.
 *
 *   "Stack logic": status effects with a `-N` suffix in their id are
 *   treated as LEVELS of the same family (e.g. drunk-1 .. drunk-8 →
 *   "Drunk"). The summary shows the active level instead of N separate
 *   on buttons. The full family is still togglable from a small popout
 *   under the chip — click the chip to step through, alt-click to clear.
 *
 *   Non-leveled statuses render as their existing per-id buttons. */
function familyOf(id) {
    const m = String(id ?? "").match(/^(.+)-(\d+)$/);
    return m ? { family: m[1], level: Number(m[2]) } : null;
}

function statusStrip(actor) {
    const active = actor.statuses ?? new Set();
    const all = CONFIG.statusEffects ?? [];

    /* Stack counts: how many ActiveEffects on the actor carry each
     * status id. This mirrors the token-HUD's native stack indicator
     * (e.g. Bleed × 3 when three separate Bleed AEs are applied).
     * Singletons get count 1; absent statuses get 0. */
    const stackById = new Map();
    for (const eff of (actor.effects ?? [])) {
        if (eff.disabled) continue;
        const ids = eff.statuses;
        if (!ids?.size) continue;
        for (const id of ids) stackById.set(id, (stackById.get(id) ?? 0) + 1);
    }

    /* Group leveled statuses (id ends with -N) by family; keep singles
     * as their own bucket. */
    const families = new Map();   // family → { entries: [{id,img,name,level,on,stacks}], maxLevel, activeLevel }
    const singles = [];
    for (const se of all) {
        const id = se.id;
        const img = se.img ?? se.icon;
        const name = game.i18n?.localize?.(se.name ?? se.label) ?? id;
        const fam = familyOf(id);
        const on = active.has(id);
        const stacks = stackById.get(id) ?? 0;
        if (fam) {
            const bucket = families.get(fam.family) ?? { entries: [], maxLevel: 0, activeLevel: 0, family: fam.family };
            bucket.entries.push({ id, img, name, level: fam.level, on, stacks });
            if (fam.level > bucket.maxLevel) bucket.maxLevel = fam.level;
            if (on && fam.level > bucket.activeLevel) bucket.activeLevel = fam.level;
            families.set(fam.family, bucket);
        } else {
            singles.push({ id, img, name, on, stacks });
        }
    }

    /* Render family chips — one chip per family, shows current level
     * via a small badge if active. Click steps to next level (or sets
     * level 1 if clear); alt-click clears the family. */
    const familyHtml = [...families.values()].map(b => {
        const top = b.entries.find(e => e.level === b.activeLevel) ?? b.entries[0];
        const famLabel = top.name.replace(/\s*\d+\s*$/, "");      // strip trailing "1" from "Drunk 1"
        const isOn = b.activeLevel > 0;
        const lvlBadge = isOn ? `<span class="wou-gm-status-lvl">${b.activeLevel}</span>` : "";
        return `<button type="button" class="wou-gm-status wou-gm-status-family${isOn ? " is-on" : ""}" ` +
            `data-actor-uuid="${escapeHTML(actor.uuid)}" ` +
            `data-status-family="${escapeHTML(b.family)}" ` +
            `data-status-max-level="${b.maxLevel}" ` +
            `data-status-level="${b.activeLevel}" ` +
            `title="${escapeHTML(famLabel)}${isOn ? ` (${b.activeLevel}/${b.maxLevel})` : ""} — click to step level, alt-click to clear">` +
                `<img src="${escapeHTML(top.img)}" alt="" />${lvlBadge}` +
            `</button>`;
    }).join("");

    const singleHtml = singles.map(s => {
        /* ×N stack badge — shows for ANY active count (even 1) so the
         * user can see immediately that their click registered. The
         * badge color stays the same; the "is-on" class on the button
         * provides the active-vs-inactive visual. */
        const stackBadge = s.stacks > 0
            ? `<span class="wou-gm-status-stacks">×${s.stacks}</span>`
            : "";
        const title = s.stacks > 0 ? `${s.name} (×${s.stacks})` : s.name;
        return `<button type="button" class="wou-gm-status${s.on ? " is-on" : ""}" ` +
            `data-actor-uuid="${escapeHTML(actor.uuid)}" ` +
            `data-status="${escapeHTML(s.id)}" ` +
            `title="${escapeHTML(title)} — left-click +1 stack, right-click −1, alt-click clear">` +
                `<img src="${escapeHTML(s.img)}" alt="" />${stackBadge}` +
            `</button>`;
    }).join("");

    const activeCount = [...active].length;
    /* Collapsed by default; but if the user previously opened this
     * actor's section, KEEP it open across re-renders so a status
     * click doesn't snap it shut. */
    const wasOpen = _openStatusActors.has(actor.uuid);
    return `
        <details class="wou-gm-statuses-collapse"${wasOpen ? " open" : ""} data-actor-uuid="${escapeHTML(actor.uuid)}">
          <summary class="wou-gm-statuses-summary">
            <span class="lbl">Status Effects</span>
            <span class="cnt">${activeCount > 0 ? activeCount : ""}</span>
          </summary>
          <div class="wou-gm-statuses">${familyHtml}${singleHtml}</div>
        </details>`;
}

/* ─────────── reference tab ─────────── */

const REFERENCE_KEY = "gmReference";

/* Default seed: the Core p.152 combat summary tables + the two kept sections.
 * Built lazily so foundry.utils.randomID() is available. */
function buildReferenceSeed() {
  const cat = (title, rows) => ({
    id: foundry.utils.randomID(),
    title,
    rows: rows.map(([term, value]) => ({ id: foundry.utils.randomID(), term, value })),
  });
  return { categories: [
    cat("Attack modifiers (add to attack roll)", [
      ["Target pinned", "+4"],
      ["Target actively dodging", "−2"],
      ["Moving target (REF >10)", "−3"],
      ["Fast draw", "−3"],
      ["Ambush", "+5"],
      ["Ricochet shot", "−5"],
      ["Blinded by light or dust", "−3"],
      ["Target silhouetted", "+2"],
      ["Aiming (per round)", "+1"],
    ]),
    cat("Ranges & target DC", [
      ["Point blank (≤½m / touching)", "DC 10 · +5"],
      ["Close (¼ listed range)", "DC 15 · +0"],
      ["Medium (½ listed range)", "DC 20 · −2"],
      ["Long (listed range)", "DC 25 · −4"],
      ["Extreme (2× listed range)", "DC 30 · −6"],
    ]),
    cat("Light levels", [
      ["Bright light (desert sun, sun off snow)", "−3 Awareness; −3 attack & defense if facing the sun"],
      ["Daylight", "No penalties"],
      ["Dim light (moonlight)", "−2 Awareness"],
      ["Darkness (new moon, deep cavern)", "−4 Awareness; −2 attack & defense"],
    ]),
    cat("Critical levels (beat defense by)", [
      ["Beat by 7", "Simple · +3 damage"],
      ["Beat by 10", "Complex · +5 damage"],
      ["Beat by 13", "Difficult · +8 damage"],
      ["Beat by 15", "Deadly · +10 damage"],
    ]),
    cat("Human hit location (d10)", [
      ["Head (1)", "−6 to hit · ×3 damage"],
      ["Torso (2–4)", "−1 to hit · ×1 damage"],
      ["Right arm (5)", "−3 to hit · ×½ damage"],
      ["Left arm (6)", "−3 to hit · ×½ damage"],
      ["Right leg (7–8)", "−2 to hit · ×½ damage"],
      ["Left leg (9–10)", "−2 to hit · ×½ damage"],
    ]),
    cat("Monster hit location (d10)", [
      ["Head (1)", "−6 to hit · ×3 damage"],
      ["Torso (2–5)", "−1 to hit · ×1 damage"],
      ["Right limb (6–7)", "−3 to hit · ×½ damage"],
      ["Left limb (8–9)", "−3 to hit · ×½ damage"],
      ["Tail or wing (10)", "−2 to hit · ×½ damage"],
    ]),
    cat("Common cover (SP)", [
      ["Stone wall", "30"], ["Large tree", "30"], ["Brick wall", "25"],
      ["Steel door", "20"], ["Heavy wooden door", "15"], ["Wooden wall", "10"],
      ["Cart", "10"], ["Wooden barrel", "10"], ["Thatch roof", "7"],
      ["Brambles", "7"], ["Tent", "5"],
    ]),
    cat("Defense reactions (STA)", [
      ["1st reaction / round", "Free"],
      ["Each extra reaction", "+1 STA"],
      ["Options", "Reposition, Dodge, Parry, Block"],
    ]),
    cat("Damage resolution order", [
      ["1. Strong-strike ×", "Multiplier applied to the rolled dice, before SP"],
      ["2. Subtract SP", "Armour on the hit location reduces the total"],
      ["3. Location ×", "Location multiplier applied after SP, to the remainder"],
    ]),
  ]};
}

function getReference() {
  const data = foundry.utils.deepClone(game.settings.get(MODULE_ID, REFERENCE_KEY) ?? { categories: [] });
  return data;
}
async function setReference(data) {
  await game.settings.set(MODULE_ID, REFERENCE_KEY, data);
}

/* Per-GM (client-scoped) memory of which reference categories are collapsed. */
const REF_COLLAPSED_KEY = "gmRefCollapsed";
function getRefCollapsed() { return game.settings.get(MODULE_ID, REF_COLLAPSED_KEY) ?? []; }
async function setRefCollapsed(ids) { await game.settings.set(MODULE_ID, REF_COLLAPSED_KEY, ids); }

/* Per-GM (client-scoped) memory of the GM-notes textarea height. */
const NOTES_HEIGHT_KEY = "gmNotesHeight";
function getNotesHeight() { return Number(game.settings.get(MODULE_ID, NOTES_HEIGHT_KEY)) || 0; }
let _notesSaveTimer = null;
function saveNotesHeight(px) {
  clearTimeout(_notesSaveTimer);
  _notesSaveTimer = setTimeout(() => game.settings.set(MODULE_ID, NOTES_HEIGHT_KEY, Math.round(px)), 300);
}
let _notesObs = null;
/* Restore the saved height onto the (re-rendered) notes textarea and observe it
 * so manual resizes persist. The textarea is recreated each pinboard render, so
 * re-point the single observer at the current element. */
function applyNotesHeight(body) {
  const ta = body?.querySelector?.(".wou-gm-pin-notes");
  if (!ta) return;
  const h = getNotesHeight();
  if (h) ta.style.height = `${h}px`;
  if (window.ResizeObserver) {
    _notesObs?.disconnect?.();
    _notesObs = new ResizeObserver(() => saveNotesHeight(ta.offsetHeight));
    _notesObs.observe(ta);
  }
}

let _refEditMode = false;

function renderReferenceTab(body) {
  let data = getReference();
  let dirty = false;
  if (!data.categories?.length) {            // first use → seed
    data = buildReferenceSeed();
    dirty = true;
  }
  // one-time cleanup of the seeded "Opponent size" category (only runs once, so a
  // user who deliberately re-adds a category with that title later keeps it).
  if (!(data._migrations || []).includes("dropOpponentSize")) {
    data.categories = data.categories.filter(c => c.title !== "Opponent size");
    data._migrations = [...(data._migrations || []), "dropOpponentSize"];
    dirty = true;
  }
  if (dirty) setReference(data);            // persist (fire-and-forget)
  const editBtn = `<div class="wou-gm-ref-bar"><button type="button" class="wou-gm-ref-edit">${_refEditMode ? "Done" : "✎ Edit"}</button></div>`;

  if (!_refEditMode) {
    const collapsed = new Set(getRefCollapsed());
    const cats = data.categories.map(c => `
      <details class="wou-gm-ref" data-ref-cat="${c.id}"${collapsed.has(c.id) ? "" : " open"}>
        <summary>${escapeHTML(c.title)}</summary>
        <table>${c.rows.map(r => `<tr><th>${escapeHTML(r.term)}</th><td>${escapeHTML(r.value)}</td></tr>`).join("")}</table>
      </details>`).join("") || `<div class="wou-gm-empty">No reference entries.</div>`;
    body.innerHTML = editBtn + cats;
    return;
  }

  // edit mode
  const cats = data.categories.map(c => `
    <div class="wou-gm-ref-edit-cat" data-ref-cat="${c.id}">
      <div class="wou-gm-ref-cathead">
        <input type="text" class="wou-gm-ref-cat-title" data-ref-cat-title="${c.id}" value="${escapeHTML(c.title)}" />
        <button type="button" class="rm" data-ref-cat-del="${c.id}" title="Remove category">×</button>
      </div>
      ${c.rows.map(r => `
        <div class="wou-gm-ref-editrow">
          <input type="text" class="term" data-ref-row-term="${c.id}:${r.id}" value="${escapeHTML(r.term)}" placeholder="Term" />
          <input type="text" class="val" data-ref-row-val="${c.id}:${r.id}" value="${escapeHTML(r.value)}" placeholder="Value" />
          <button type="button" class="rm" data-ref-row-del="${c.id}:${r.id}" title="Remove field">×</button>
        </div>`).join("")}
      <button type="button" class="wou-gm-ref-addrow" data-ref-row-add="${c.id}">+ Add field</button>
    </div>`).join("");
  body.innerHTML = editBtn + cats + `<button type="button" class="wou-gm-ref-addcat" data-ref-cat-add>+ Add category</button>`;
}

/* ─────────── session tab ─────────── */

/* Localize an i18n key; if no translation registered, return the supplied
 * fallback so the UI never shows a raw "WITCHER.…" key. */
function loc(key, fallback) {
  const out = game.i18n?.localize?.(key);
  return (!out || out === key) ? (fallback ?? key) : out;
}

/* Only player-owned characters (the party) receive group rolls / rewards.
   Enumerates world PCs directly — independent of the Party-tab filter. */
function partyPCs() {
  return (game.actors ?? []).filter(a => a.type === "character" && a.hasPlayerOwner);
}

function renderSessionTab(body) {
  if (!body) return;

  /* 1. Group skill roll — sorted alphabetically by localized label. */
  const skillMap = CONFIG.WITCHER?.skillMap ?? {};
  const skillOpts = Object.keys(skillMap)
    .map(key => ({ key, label: loc(CONFIG.WITCHER.skillLabel(key), key) }))
    .sort((a, b) => a.label.localeCompare(b.label))
    .map(s => `<option value="${escapeHTML(s.key)}">${escapeHTML(s.label)}</option>`)
    .join("");
  const rollHTML = `
    <div class="row">
      <select class="wou-gm-skill">${skillOpts}</select>
      <select class="wou-gm-rollmode" title="Roll mode">
        <option value="publicroll">Public</option>
        <option value="gmroll">Private GM</option>
        <option value="blindroll">Blind GM</option>
        <option value="selfroll">Self</option>
      </select>
      <button type="button" data-roll-skill>Roll for PCs</button>
    </div>`;

  /* 2. Rewards — IP + crowns granted to the whole party. */
  const rewardHTML = `
    <div class="row">
      <label class="lbl">IP <input type="number" data-reward="ip" value="0" min="0" /></label>
      <label class="lbl">Crowns <input type="number" data-reward="crown" value="0" min="0" /></label>
      <button type="button" data-reward-grant>Grant to party</button>
    </div>`;

  body.innerHTML = `
    <section class="wou-gm-sess"><h4>Group skill check</h4>${rollHTML}</section>
    <section class="wou-gm-sess"><h4>Distribute rewards</h4>${rewardHTML}</section>
  `;
}

/* ─────────── party tab: vital commit ─────────── */

async function commitVital(uuid, stat, raw) {
  const actor = fromUuidSync(uuid);
  if (!actor) return;
  const n = Number(raw);
  if (!Number.isFinite(n)) return;
  // GM edits are intentionally NOT clamped; the system re-derives caps where needed.
  const PATHS = {
    hp:  "system.derivedStats.hp.value",
    sta: "system.derivedStats.sta.value",
    tox: "system.stats.toxicity.value",
    adr: "system.adrenaline.value",
    str: "system.stress",
  };
  const path = PATHS[stat];
  if (!path) return;
  await actor.update({ [path]: n }, { render: false });
}

/* ─────────── party tab: focus-safe debounced refresh ─────────── */

let _partyRefreshTimer = null;
function refreshPartyIfOpen() {
  if (!isOpen() || _activeTab !== "party") return;
  clearTimeout(_partyRefreshTimer);
  _partyRefreshTimer = setTimeout(() => {
    if (!isOpen() || _activeTab !== "party") return;
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    if (panel.contains(document.activeElement)) return;  // never clobber a field mid-edit
    renderPartyTab(panel.querySelector(".wou-gm-body"));
  }, 80);
}

function renderPanel() {
  const panel = getPanel();
  panel.innerHTML = buildPanelHTML();
  renderActiveTab(panel);
  return panel;
}

/* ─────────── positioning ─────────── */

/* Mirror of skills-panel.js positionAbove(): pin the panel's BOTTOM edge above
 * the trigger button, reserve the #sidebar footprint in the left clamp, and
 * clamp the whole panel into the viewport. Same gap (14px) and width fallback
 * (panel measures 0 wide on first layout → fall back to 460). */
function positionPanel(panel, anchorBtn) {
  if (!panel || !anchorBtn) return;
  const rect = anchorBtn.getBoundingClientRect();
  // Measure with the panel already shown via the .is-open class (added before
  // this runs). Only hide it visually during the measure — do NOT set an inline
  // display, or it would override the class and keep the panel visible on close.
  panel.style.visibility = "hidden";
  const pr = panel.getBoundingClientRect();
  const w = pr.width || 460;
  const h = pr.height || 320;

  /* Reserve the right band for the #sidebar so the panel never sits under it —
     open or closed. Measure the live #sidebar rect when present; fall back to
     436px (the skills-panel value) when it isn't in the DOM. */
  const sidebarEl = document.getElementById("sidebar");
  let sidebarLeftEdge = window.innerWidth;
  if (sidebarEl) {
    const sr = sidebarEl.getBoundingClientRect();
    if (sr.width > 0) sidebarLeftEdge = Math.min(sidebarLeftEdge, sr.left);
  }
  const reservedRight = Math.max(0, window.innerWidth - sidebarLeftEdge, 436);
  const rightLimit = window.innerWidth - reservedRight - 8;
  const leftLimit = 8;

  /* Center on the button, then clamp into the available canvas band. */
  let left = rect.left + rect.width / 2 - w / 2;
  left = Math.max(leftLimit, Math.min(left, rightLimit - w));
  /* Narrow viewport that can't even fit the panel → pin to leftLimit. */
  if (rightLimit - w < leftLimit) left = leftLimit;
  const bottom = window.innerHeight - rect.top + 14;            /* 14px gap above the button */

  panel.style.left = `${left}px`;
  panel.style.bottom = `${bottom}px`;
  panel.style.visibility = "";
}

/* ─────────── show / hide ─────────── */

function isOpen() {
  const panel = document.getElementById(PANEL_ID);
  return panel?.classList.contains("is-open") === true;
}

function openPanel(btn) {
  const panel = renderPanel();
  panel.classList.add("is-open");
  positionPanel(panel, btn);
  btn?.classList.add("is-active");
}

function closePanel() {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) return;
  panel.classList.remove("is-open");
  panel.style.display = "";   /* clear any inline display so the .is-open class controls visibility */
  document.getElementById("wou-gm-fab")?.classList.remove("is-active");
}

function togglePanel(btn) {
  if (isOpen()) closePanel();
  else openPanel(btn);
}

/* ─────────── event wiring ─────────── */

function onClick(e) {
  // 0. Lightbox is a body-level overlay OUTSIDE the panel; let its own bubble
  //    handler dismiss it without this capture-phase closer tearing down the panel.
  if (lightboxOpen() || e.target.closest?.("#wou-gm-lightbox")) return;

  // 1. GM button → toggle
  const btn = e.target.closest("#wou-gm-fab");
  if (btn) {
    e.preventDefault();
    e.stopPropagation();
    togglePanel(btn);
    return;
  }

  const panel = document.getElementById(PANEL_ID);
  if (!panel || !panel.classList.contains("is-open")) return;

  // 2. Click on the SCENE CANVAS (#board) → close. Clicks on other UI — actor
  //    sheets, journals, popups, the sidebar, the dock, etc. — leave it open.
  if (!panel.contains(e.target)) {
    if (e.target.closest?.("#board")) closePanel();
    return;
  }

  // 3. Tab switch
  const tab = e.target.closest(".wou-gm-tab");
  if (tab && panel.contains(tab)) {
    e.preventDefault();
    _activeTab = tab.dataset.tab;
    panel.querySelectorAll(".wou-gm-tab").forEach(t => t.classList.toggle("is-active", t === tab));
    renderActiveTab(panel);
    return;
  }
}

function onKeydown(e) {
  if (e.key !== "Escape") return;
  if (lightboxOpen()) { closeLightbox(); return; }
  if (isOpen()) closePanel();
}

function onResize() {
  alignFab();
  if (!isOpen()) return;
  const btn = document.getElementById("wou-gm-fab");
  const panel = document.getElementById(PANEL_ID);
  if (btn && panel) positionPanel(panel, btn);
}

/* ─────────── public setup ─────────── */

export function setupGMPanel() {
  // Never show for players: remove any stray button and bail.
  if (!game.user?.isGM) {
    document.getElementById("wou-gm-fab")?.remove();
    return;
  }

  injectGmButton();

  if (_wired) return;
  _wired = true;
  document.addEventListener("click", onClick, true);           /* capture so we beat dock's own listeners */
  document.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", onResize, { passive: true });

  /* ─── party tab: filter chips ─── */
  document.addEventListener("click", (ev) => {
    const chip = ev.target.closest?.(`#${PANEL_ID} .wou-gm-chip`);
    if (!chip) return;
    ev.preventDefault(); ev.stopPropagation();
    _partyFilter[chip.dataset.filter] = !_partyFilter[chip.dataset.filter];
    renderPartyTab(document.getElementById(PANEL_ID).querySelector(".wou-gm-body"));
  });

  /* ─── party tab: vital edit (commit on Enter→blur, and on change) ─── */
  document.addEventListener("keydown", (ev) => {
    const input = ev.target.closest?.(`#${PANEL_ID} .wou-gm-vital .val`);
    if (!input || ev.key !== "Enter") return;
    ev.preventDefault(); input.blur();
  });
  document.addEventListener("change", (ev) => {
    const input = ev.target.closest?.(`#${PANEL_ID} .wou-gm-vital .val`);
    if (!input) return;
    commitVital(input.dataset.actorUuid, input.dataset.stat, input.value);
  });

  /* ─── party tab: status chip interactions ─────────────────────
   * Per user spec:
   *   - Left-click  → ADD a stack / step UP a level (family)
   *   - Right-click → REMOVE a stack / step DOWN a level (family)
   *   - Alt-click   → CLEAR all stacks / clear the family
   * Both left-click and contextmenu handlers route through one
   * helper so the behavior stays in sync. */
  const handleStatusChipInteract = async (ev, direction) => {
    /* direction: "up" (+1 / step up) | "down" (−1 / step down) | "clear" */
    const btn = ev.target.closest?.(`#${PANEL_ID} .wou-gm-status`);
    if (!btn) return;
    ev.preventDefault(); ev.stopPropagation();
    const actor = fromUuidSync(btn.dataset.actorUuid);
    if (!actor) return;

    const family = btn.dataset.statusFamily;
    if (family) {
      const max = Number(btn.dataset.statusMaxLevel) || 0;
      const cur = Number(btn.dataset.statusLevel)    || 0;
      let next;
      if (direction === "clear") next = 0;
      else if (direction === "down") next = Math.max(0, cur - 1);
      else /* up */ next = cur >= max ? 0 : (cur + 1);
      try {
        if (cur > 0) await actor.toggleStatusEffect(`${family}-${cur}`, { active: false });
        if (next > 0) await actor.toggleStatusEffect(`${family}-${next}`, { active: true });
      } catch (err) { console.warn("wou gm-panel | family step failed", err); }
      refreshPartyIfOpen();
      return;
    }

    const statusId = btn.dataset.status;
    try {
      if (direction === "clear") {
        /* Remove ALL AEs carrying this id. */
        const toRemove = (actor.effects ?? []).filter(e => !e.disabled && e.statuses?.has?.(statusId));
        if (toRemove.length) {
          await actor.deleteEmbeddedDocuments("ActiveEffect", toRemove.map(e => e.id));
        }
      } else if (direction === "down") {
        /* Remove one AE carrying this id. */
        const target = (actor.effects ?? []).find(e => !e.disabled && e.statuses?.has?.(statusId));
        if (target) await target.delete();
      } else {
        /* up: create a new AE for the id (stacks). */
        const def = (CONFIG.statusEffects ?? []).find(s => s.id === statusId);
        if (def) {
          await actor.createEmbeddedDocuments("ActiveEffect", [{
            name:     game.i18n?.localize?.(def.name ?? def.label) ?? statusId,
            img:      def.img ?? def.icon,
            statuses: [statusId],
            origin:   actor.uuid
          }]);
        }
      }
    } catch (err) {
      console.warn("wou gm-panel | status interact failed", err);
    }
    /* Blur the clicked chip before refreshing — refreshPartyIfOpen
     * skips when focus is still inside the panel (it's there to
     * protect mid-edit number fields). Without the blur, every status
     * click left the button focused → refresh skipped → UI stayed
     * stale until something else (a hook a few ms later) triggered
     * a second refresh attempt. */
    try { btn.blur(); } catch (_) { /* button may be re-rendered */ }
    refreshPartyIfOpen();
  };

  document.addEventListener("click", (ev) => {
    const btn = ev.target.closest?.(`#${PANEL_ID} .wou-gm-status`);
    if (!btn) return;
    handleStatusChipInteract(ev, ev.altKey ? "clear" : "up");
  });
  document.addEventListener("contextmenu", (ev) => {
    const btn = ev.target.closest?.(`#${PANEL_ID} .wou-gm-status`);
    if (!btn) return;
    /* Suppress the browser's native right-click menu only over our chips. */
    handleStatusChipInteract(ev, ev.altKey ? "clear" : "down");
  });
  /* Track open/closed state of the Status Effects <details> per actor
   * so re-renders triggered by a status click don't collapse the panel
   * the user just opened. Listens on the `toggle` event (fires when
   * the user clicks <summary>) — captured at the panel level. */
  document.addEventListener("toggle", (ev) => {
    const det = ev.target;
    if (!(det instanceof HTMLDetailsElement)) return;
    if (!det.classList.contains("wou-gm-statuses-collapse")) return;
    const uuid = det.dataset.actorUuid;
    if (!uuid) return;
    if (det.open) _openStatusActors.add(uuid);
    else          _openStatusActors.delete(uuid);
  }, true);   // capture phase — `toggle` doesn't bubble

  /* ─── party tab: live refresh hooks (registered once, here inside _wired) ─── */
  Hooks.on("updateActor", () => refreshPartyIfOpen());
  Hooks.on("updateToken", () => refreshPartyIfOpen());
  Hooks.on("createCombatant", () => refreshPartyIfOpen());
  Hooks.on("deleteCombatant", () => refreshPartyIfOpen());
  Hooks.on("deleteCombat", () => refreshPartyIfOpen());
  Hooks.on("createActiveEffect", () => refreshPartyIfOpen());
  Hooks.on("deleteActiveEffect", () => refreshPartyIfOpen());

  /* ─── pinboard: add image via FilePicker (death-march idiom) ─── */
  document.addEventListener("click", async (ev) => {
    if (!ev.target.closest?.(`#${PANEL_ID} .wou-gm-pin-addimg`)) return;
    ev.preventDefault(); ev.stopPropagation();
    const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
    const fp = new FP({ type: "image", callback: async (path) => {
      const pin = getPinboard();
      pin.images = [...(pin.images ?? []), path];
      await setPinboard(pin);
      renderPinboardTab(document.getElementById(PANEL_ID).querySelector(".wou-gm-body"));
    }});
    fp.render(true);
  });

  /* ─── pinboard: remove image / link ─── */
  document.addEventListener("click", async (ev) => {
    const ri = ev.target.closest?.(`#${PANEL_ID} [data-pin-rm-img]`);
    const rl = ev.target.closest?.(`#${PANEL_ID} [data-pin-rm-link]`);
    if (!ri && !rl) return;
    ev.preventDefault(); ev.stopPropagation();
    const pin = getPinboard();
    if (ri) pin.images.splice(Number(ri.dataset.pinRmImg), 1);
    if (rl) pin.links.splice(Number(rl.dataset.pinRmLink), 1);
    await setPinboard(pin);
    renderPinboardTab(document.getElementById(PANEL_ID).querySelector(".wou-gm-body"));
  });

  /* ─── pinboard: open linked doc ─── */
  document.addEventListener("click", async (ev) => {
    const a = ev.target.closest?.(`#${PANEL_ID} [data-pin-open]`);
    if (!a) return;
    ev.preventDefault(); ev.stopPropagation();
    const doc = await fromUuid(a.dataset.pinOpen);
    doc?.sheet?.render(true);
  });

  /* ─── pinboard: notes save on change ─── */
  document.addEventListener("change", async (ev) => {
    const ta = ev.target.closest?.(`#${PANEL_ID} .wou-gm-pin-notes`);
    if (!ta) return;
    const pin = getPinboard();
    pin.notes = ta.value;
    await setPinboard(pin);
  });

  /* ─── pinboard: drop a Journal/Actor/Item → store link ─── */
  document.addEventListener("drop", async (ev) => {
    const panel = ev.target.closest?.(`#${PANEL_ID}`);
    if (!panel || _activeTab !== "pinboard") return;
    let data; try { data = JSON.parse(ev.dataTransfer.getData("text/plain")); } catch { return; }
    if (!data?.uuid) return;
    ev.preventDefault(); ev.stopPropagation();
    const doc = await fromUuid(data.uuid);
    if (!doc) return;
    const pin = getPinboard();
    pin.links = [...(pin.links ?? []), { uuid: data.uuid, name: doc.name ?? data.uuid }];
    await setPinboard(pin);
    renderPinboardTab(document.getElementById(PANEL_ID).querySelector(".wou-gm-body"));
  });
  document.addEventListener("dragover", (ev) => {
    if (ev.target.closest?.(`#${PANEL_ID}`) && _activeTab === "pinboard") ev.preventDefault();
  });

  /* ─── pinboard: image → lightbox (the × remove button is a sibling, so this only fires on the image) ─── */
  document.addEventListener("click", (ev) => {
    const img = ev.target.closest?.(`#${PANEL_ID} .wou-gm-pin-img img`);
    if (!img) return;
    ev.preventDefault(); ev.stopPropagation();
    openLightbox(img.src);
  });
  /* click anywhere in the overlay (including the image) closes it */
  document.addEventListener("click", (ev) => {
    if (ev.target.id === "wou-gm-lightbox" || ev.target.closest?.("#wou-gm-lightbox")) {
      if (lightboxOpen()) { ev.preventDefault(); ev.stopPropagation(); closeLightbox(); }
    }
  });

  /* ─── reference: editable, data-driven cheat-sheets ─── */
  const rerenderRef = () => renderReferenceTab(document.getElementById(PANEL_ID).querySelector(".wou-gm-body"));

  // edit toggle
  document.addEventListener("click", (ev) => {
    if (!ev.target.closest?.(`#${PANEL_ID} .wou-gm-ref-edit`)) return;
    ev.preventDefault(); ev.stopPropagation();
    _refEditMode = !_refEditMode;
    rerenderRef();
  });
  // add category
  document.addEventListener("click", async (ev) => {
    if (!ev.target.closest?.(`#${PANEL_ID} [data-ref-cat-add]`)) return;
    ev.preventDefault(); ev.stopPropagation();
    const data = getReference();
    data.categories.push({ id: foundry.utils.randomID(), title: "New category", rows: [] });
    await setReference(data); rerenderRef();
  });
  // remove category
  document.addEventListener("click", async (ev) => {
    const b = ev.target.closest?.(`#${PANEL_ID} [data-ref-cat-del]`);
    if (!b) return;
    ev.preventDefault(); ev.stopPropagation();
    const data = getReference();
    data.categories = data.categories.filter(c => c.id !== b.dataset.refCatDel);
    await setReference(data); rerenderRef();
  });
  // add field
  document.addEventListener("click", async (ev) => {
    const b = ev.target.closest?.(`#${PANEL_ID} [data-ref-row-add]`);
    if (!b) return;
    ev.preventDefault(); ev.stopPropagation();
    const data = getReference();
    const c = data.categories.find(c => c.id === b.dataset.refRowAdd);
    if (c) { c.rows.push({ id: foundry.utils.randomID(), term: "", value: "" }); await setReference(data); rerenderRef(); }
  });
  // remove field
  document.addEventListener("click", async (ev) => {
    const b = ev.target.closest?.(`#${PANEL_ID} [data-ref-row-del]`);
    if (!b) return;
    ev.preventDefault(); ev.stopPropagation();
    const [catId, rowId] = b.dataset.refRowDel.split(":");
    const data = getReference();
    const c = data.categories.find(c => c.id === catId);
    if (c) { c.rows = c.rows.filter(r => r.id !== rowId); await setReference(data); rerenderRef(); }
  });
  // edit category title / row term / row value — save on change, DO NOT re-render (preserve focus)
  document.addEventListener("change", async (ev) => {
    const t = ev.target.closest?.(`#${PANEL_ID} [data-ref-cat-title]`);
    const rt = ev.target.closest?.(`#${PANEL_ID} [data-ref-row-term]`);
    const rv = ev.target.closest?.(`#${PANEL_ID} [data-ref-row-val]`);
    if (!t && !rt && !rv) return;
    const data = getReference();
    if (t) { const c = data.categories.find(c => c.id === t.dataset.refCatTitle); if (c) c.title = t.value; }
    if (rt) { const [cid, rid] = rt.dataset.refRowTerm.split(":"); const c = data.categories.find(c => c.id === cid); const r = c?.rows.find(r => r.id === rid); if (r) r.term = rt.value; }
    if (rv) { const [cid, rid] = rv.dataset.refRowVal.split(":"); const c = data.categories.find(c => c.id === cid); const r = c?.rows.find(r => r.id === rid); if (r) r.value = rv.value; }
    await setReference(data);
  });
  // remember collapsed/expanded reference categories (per GM). <details> toggle
  // does not bubble, so listen in the capture phase.
  document.addEventListener("toggle", (ev) => {
    const d = ev.target;
    if (!d?.matches?.(`#${PANEL_ID} details.wou-gm-ref[data-ref-cat]`)) return;
    const id = d.dataset.refCat;
    const set = new Set(getRefCollapsed());
    if (d.open) set.delete(id); else set.add(id);
    setRefCollapsed([...set]);
  }, true);

  /* ─── session: group skill roll for the party ─── */
  document.addEventListener("click", async (ev) => {
    const btn = ev.target.closest?.(`#${PANEL_ID} [data-roll-skill]`);
    if (!btn) return;
    ev.preventDefault(); ev.stopPropagation();
    const sel = document.querySelector(`#${PANEL_ID} .wou-gm-skill`);
    const key = sel?.value;
    if (!key) return;
    const pcs = partyPCs();
    if (!pcs.length) { ui.notifications?.warn("No player-owned characters to roll for."); return; }
    /* Roll-mode select uses legacy CONST.DICE_ROLL_MODES values; validate
       against the four valid keys, then map to the v14 messageMode the
       roll threads into ChatMessage.create. */
    const VALID_MODES = ["publicroll", "gmroll", "blindroll", "selfroll"];
    let mode = document.querySelector(`#${PANEL_ID} .wou-gm-rollmode`)?.value || "publicroll";
    if (!VALID_MODES.includes(mode)) mode = "publicroll";
    const messageMode = foundry.dice.Roll._mapLegacyRollMode(mode);
    for (const actor of pcs) await actor.rollSkill(key, { messageMode });
  });

  /* ─── session: grant rewards to the party ─── */
  document.addEventListener("click", async (ev) => {
    const btn = ev.target.closest?.(`#${PANEL_ID} [data-reward-grant]`);
    if (!btn) return;
    ev.preventDefault(); ev.stopPropagation();
    const ipIn    = document.querySelector(`#${PANEL_ID} [data-reward="ip"]`);
    const crownIn = document.querySelector(`#${PANEL_ID} [data-reward="crown"]`);
    const ip    = Math.trunc(Number(ipIn?.value) || 0);
    const crown = Math.trunc(Number(crownIn?.value) || 0);
    const pcs = partyPCs();
    if ((!ip && !crown) || !pcs.length) { ui.notifications?.warn("Nothing to grant."); return; }
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Distribute rewards" },
      content: `<p>Grant <b>${ip} IP</b> and <b>${crown} crowns</b> to <b>${pcs.length}</b> player character(s)?</p>`,
      modal: true,
    });
    if (!ok) return;
    for (const actor of pcs) {
      const sys = actor.system ?? {};
      const update = {
        "system.improvementPoints": (Number(sys.improvementPoints) || 0) + ip,
        "system.currency.crown":    (Number(sys.currency?.crown) || 0) + crown
      };
      if (ip > 0) {
        const log = foundry.utils.deepClone(sys.logs?.ipLog ?? []);
        log.push({ label: "GM grant", value: ip });
        update["system.logs.ipLog"] = log;
      }
      await actor.update(update, { render: false });
    }
    ui.notifications?.info(`Granted ${ip} IP and ${crown} crowns to ${pcs.length} character(s).`);
  });
}
