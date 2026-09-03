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

import { t, tFormat } from "../lib/i18n.js";
import { CURRENCY_KEYS } from "../../data/actor/templates/currency.mjs";
import { weatherAdjustedMoveCap } from "../../mechanics/weather-modifiers.mjs";
const PANEL_ID = "wou-gm-panel";

/* Currency <option> block; used by the reward selectors so the GM can pick
 * which denomination the coin amount lands in (defaults to `crown`, the
 * legacy behaviour). */
function currencyOptsHTML(selected = "crown") {
  return CURRENCY_KEYS.map(k =>
    `<option value="${k}"${k === selected ? " selected" : ""}>${escapeHTML(t(`WITCHER.Currency.${k}`, k))}</option>`
  ).join("");
}

/* Tab definitions — order is the strip order. icon = FontAwesome glyph. */
const TABS = () => [
  { key: "party",     label: t("WITCHER.Chrome.GmPanel.Dialog.Button.Party", "Party"),     icon: "fa-users" },
  { key: "reference", label: t("WITCHER.Chrome.GmPanel.Dialog.Button.Reference", "Reference"), icon: "fa-book-open" },
  { key: "pinboard",  label: t("WITCHER.Chrome.GmPanel.Dialog.Button.Pinboard", "Pinboard"),  icon: "fa-thumbtack" },
  { key: "session",   label: t("WITCHER.Chrome.GmPanel.Dialog.Button.Session", "Session"),   icon: "fa-hourglass-half" },
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
    `<div class="wou-gm-pin-img"><img src="${escapeHTML(src)}" alt="" /><button type="button" class="rm" data-pin-rm-img="${i}" title="${t("WITCHER.Chrome.GmPanel.Text.Remove", "Remove")}">×</button></div>`).join("");
  const links = (pin.links ?? []).map((l, i) =>
    `<div class="wou-gm-pin-link"><a data-pin-open="${escapeHTML(l.uuid)}">${escapeHTML(l.name)}</a><button type="button" class="rm" data-pin-rm-link="${i}" title="${t("WITCHER.Chrome.GmPanel.Text.Remove", "Remove")}">×</button></div>`).join("");
  body.innerHTML = `
    <div class="wou-gm-pin-actions">
      <button type="button" class="wou-gm-pin-addimg"><i class="fa-solid fa-image"></i> Add image</button>
      <span class="hint">…or drop a Journal/Actor/Item here</span>
    </div>
    <div class="wou-gm-pin-grid">${imgs}</div>
    <div class="wou-gm-pin-links">${links}</div>
    <textarea class="wou-gm-pin-notes" placeholder="${t("WITCHER.Chrome.GmPanel.Text.GMNotes", "GM notes…")}">${escapeHTML(pin.notes ?? "")}</textarea>
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
  btn.title = t("WITCHER.Tooltip.GMPanel", "GM Panel");
  btn.setAttribute("aria-label", t("WITCHER.Tooltip.GMPanel", "GM Panel"));
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
  panel.setAttribute("aria-label", t("WITCHER.Tooltip.GMPanel", "GM Panel"));
  document.body.appendChild(panel);
  return panel;
}

function buildPanelHTML() {
  const tabsHtml = TABS().map(t =>
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
  const tab = TABS().find(t => t.key === _activeTab)?.key ?? _activeTab;
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

const VITAL_DEFS = () => [
  { key: "hp",  label: "HP"  },
  { key: "sta", label: "STA" },
  { key: "tox", label: t("WITCHER.Chrome.GmPanel.Dialog.Button.Tox", "Tox") },
  { key: "adr", label: t("WITCHER.Chrome.GmPanel.Dialog.Button.Adr", "Adr") },
  { key: "str", label: t("WITCHER.Chrome.GmPanel.Dialog.Button.Str", "Str") },
];

function renderPartyTab(body) {
  if (!body) return;
  const chips = [
    ["pcs",        t("WITCHER.Chrome.GmPanel.Text.PCs", "PCs")],
    ["npcs",       t("WITCHER.Chrome.GmPanel.Text.NPCs", "NPCs")],
    ["combatants", t("WITCHER.Chrome.GmPanel.Text.Combatants", "Combatants")],
    ["scene",      t("WITCHER.Chrome.GmPanel.Text.ThisScene", "This Scene")]
  ]
    .map(([k, lbl]) => `<button type="button" class="wou-gm-chip${_partyFilter[k] ? " is-on" : ""}" data-filter="${k}">${lbl}</button>`).join("");

  const actors = collectRosterActors();
  const rows = actors.length ? actors.map(a => {
    const v = readVitals(a);
    const cells = VITAL_DEFS().map(d => {
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
      ${combatBudgetStrip(a)}
    </div>`;
  }).join("") : `<div class="wou-gm-empty">${t("WITCHER.Chrome.GmPanel.Text.NoActorsMatchTheCurrentFilters", "No actors match the current filters.")}</div>`;

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
            <span class="lbl">${t("WITCHER.Chrome.GmPanel.Text.StatusEffects", "Status Effects")}</span>
            <span class="cnt">${activeCount > 0 ? activeCount : ""}</span>
          </summary>
          <div class="wou-gm-statuses">${familyHtml}${singleHtml}</div>
        </details>`;
}

/* ─────────── combat budget strip (per-actor action economy override) ───
 * Compact row of toggles the GM uses to refund / spend action-economy
 * slots on any actor without having to open their sheet or wait for the
 * turn to end. Also carries the `freeActions` toggle — a per-actor flag
 * that makes nextActionSlot always return "action" and short-circuits
 * every record* helper, so an NPC (or a PC in a narrative sequence)
 * can act without draining the round budget. */
function combatBudgetStrip(actor) {
    const r = actor.system?.combatRound ?? {};
    const spd = Number(actor.system?.stats?.spd?.value) || 0;
    const runMul = r.runUsed ? 3 : 1;
    // Weather footing trims the NORMAL speed (min 1); Run is 3× the penalised speed.
    const cap = spd ? weatherAdjustedMoveCap(spd, runMul, 0, actor) : 0;
    const usedM = Number(r.movementMeters) || 0;
    const free = !!actor.getFlag?.("witcher-ttrpg-death-march", "freeActions");

    /* Vigor / Chaos: display the running Chaos spent this combat round
     * against the actor's Vigor cap. Chaos lives on a flag (not
     * combatRound) because it's per-combat-round-index, not per-turn.
     * If we're between combats or vigor is 0, show 0. */
    const vigor = Number(actor.system?.derivedStats?.vigor) || 0;
    const chaosFlag = actor.getFlag?.("witcher-ttrpg-death-march", "chaosRound") ?? {};
    const combatRoundNo = (game.combat?.started && game.combat?.id) ? `${game.combat.id}:${game.combat.round}` : null;
    const chaosSpent = (combatRoundNo != null && chaosFlag.round === combatRoundNo)
        ? (Number(chaosFlag.spent) || 0)
        : 0;

    /* Defenses taken this round — increments on each defense roll and
     * resets on turn start. */
    const defenses = Number(r.defenseCount) || 0;

    /* Reposition meters banked this round — only meaningful under Combat
     * Extended (RAW mode has no per-round cap). Cheap to compute
     * either way; the strip HTML gates on ceOn for display. */
    const priorReposition = Number(r.repositionMeters) || 0;
    const ceOn = (() => {
        try { return game.settings.get("witcher-ttrpg-death-march", "homebrew.extendedCombat"); }
        catch (_) { return false; }
    })();

    /* Each slot pill: `is-used` when the actor has already spent it this
     * turn. Click flips the underlying boolean (refund / spend). */
    const slot = (key, label, used, tip) =>
        `<button type="button" class="wou-gm-slot${used ? " is-used" : ""}" ` +
            `data-actor-uuid="${escapeHTML(actor.uuid)}" ` +
            `data-slot="${key}" ` +
            `title="${escapeHTML(tip)}">${escapeHTML(label)}</button>`;

    /* Free-actions override wins over any slot state — mark A/E/FR/Move
     * as "shadowed" so the GM knows those clicks still write the round
     * fields but the mixin is ignoring them until Free is turned off. */
    const shadow = free ? " is-shadowed" : "";
    return `
      <div class="wou-gm-budget${free ? " is-free-on" : ""}" data-actor-uuid="${escapeHTML(actor.uuid)}">
        <span class="wou-gm-budget-lbl">${t("WITCHER.Chrome.GmPanel.Text.Actions", "Actions")}</span>
        <button type="button" class="wou-gm-slot${r.actionUsed ? " is-used" : ""}${shadow}"
                data-actor-uuid="${escapeHTML(actor.uuid)}" data-slot="action"
                title="${escapeHTML(r.actionUsed
                    ? tFormat("WITCHER.Chrome.GmPanel.Tip.SlotUsed",     { label: r.actionLabel || t("WITCHER.Chrome.GmPanel.Text.Action",  "Action")  }, "Used: {label} — click to refund")
                    : t("WITCHER.Chrome.GmPanel.Tip.ActionFree", "Action free — click to mark spent"))}${free ? t("WITCHER.Chrome.GmPanel.Tip.ShadowedFree", " (shadowed while Free is on)") : ""}">A</button>
        <button type="button" class="wou-gm-slot${r.extraUsed ? " is-used" : ""}${shadow}"
                data-actor-uuid="${escapeHTML(actor.uuid)}" data-slot="extra"
                title="${escapeHTML(r.extraUsed
                    ? tFormat("WITCHER.Chrome.GmPanel.Tip.SlotUsed",     { label: r.extraLabel  || t("WITCHER.Chrome.GmPanel.Text.Extra",   "Extra")   }, "Used: {label} — click to refund")
                    : t("WITCHER.Chrome.GmPanel.Tip.ExtraFree",  "Extra free — click to mark spent"))}${free ? t("WITCHER.Chrome.GmPanel.Tip.ShadowedFree", " (shadowed while Free is on)") : ""}">E</button>
        <button type="button" class="wou-gm-slot${r.fullRound ? " is-used" : ""}${shadow}"
                data-actor-uuid="${escapeHTML(actor.uuid)}" data-slot="fullRound"
                title="${escapeHTML(r.fullRound
                    ? tFormat("WITCHER.Chrome.GmPanel.Tip.FullRoundUsed", { label: r.fullRoundLabel || t("WITCHER.Chrome.GmPanel.Text.Committed", "committed") }, "Full round: {label} — click to refund")
                    : t("WITCHER.Chrome.GmPanel.Tip.NoFullRound", "No full-round action — click to mark committed"))}${free ? t("WITCHER.Chrome.GmPanel.Tip.ShadowedFree", " (shadowed while Free is on)") : ""}">FR</button>
        <span class="wou-gm-budget-sep"></span>
        <span class="wou-gm-budget-lbl">${t("WITCHER.Chrome.GmPanel.Text.Move", "Move")}</span>
        <button type="button" class="wou-gm-slot${r.movementUsed || usedM > 0 ? " is-used" : ""}${shadow}"
                data-actor-uuid="${escapeHTML(actor.uuid)}" data-slot="movement"
                title="${escapeHTML(r.movementUsed || usedM > 0
                    ? tFormat("WITCHER.Chrome.GmPanel.Tip.MoveUsed",   { used: usedM, cap: cap ? "/" + cap : "", run: runMul > 1 ? t("WITCHER.Chrome.GmPanel.Tip.RunTag", " (Run)") : "" }, "{used}{cap} m used{run} — click to refund")
                    : tFormat("WITCHER.Chrome.GmPanel.Tip.MoveFree",   { cap: cap ? "/" + cap : "" }, "0{cap} m — click to mark all movement spent"))}${free ? t("WITCHER.Chrome.GmPanel.Tip.ShadowedFree", " (shadowed while Free is on)") : ""}">
          ${usedM}${cap ? "/" + cap : ""}m
        </button>
        <span class="wou-gm-budget-sep"></span>
        <span class="wou-gm-budget-lbl">${t("WITCHER.Chrome.GmPanel.Text.Vigor", "Vigor")}</span>
        <button type="button" class="wou-gm-slot${chaosSpent > 0 ? " is-used" : ""}${shadow}"
                data-actor-uuid="${escapeHTML(actor.uuid)}" data-slot="vigor"
                title="${escapeHTML(chaosSpent > 0
                    ? tFormat("WITCHER.Chrome.GmPanel.Tip.ChaosUsed", { chaos: chaosSpent, vigor: vigor ? "/" + vigor : "" }, "Chaos {chaos}{vigor} spent this combat round — click to refund")
                    : tFormat("WITCHER.Chrome.GmPanel.Tip.ChaosFree", { vigor: vigor ? "/" + vigor : "" }, "Chaos 0{vigor} — click to mark all Chaos spent"))}${free ? t("WITCHER.Chrome.GmPanel.Tip.ShadowedFree", " (shadowed while Free is on)") : ""}">
          ${chaosSpent}${vigor ? "/" + vigor : ""}
        </button>
        <span class="wou-gm-budget-sep"></span>
        <span class="wou-gm-budget-lbl">${t("WITCHER.Chrome.GmPanel.Text.Def", "Def")}</span>
        <button type="button" class="wou-gm-slot${defenses > 0 ? " is-used" : ""}${shadow}"
                data-actor-uuid="${escapeHTML(actor.uuid)}" data-slot="defenses"
                title="${escapeHTML(defenses > 0
                    ? tFormat("WITCHER.Chrome.GmPanel.Tip.DefUsed", { n: defenses, plural: defenses === 1 ? "" : t("WITCHER.Chrome.GmPanel.Tip.PluralS", "s") }, "{n} defense{plural} taken this round — click to refund")
                    : t("WITCHER.Chrome.GmPanel.Tip.DefFree", "No defenses yet this round — click to mark one taken"))}${free ? t("WITCHER.Chrome.GmPanel.Tip.ShadowedFree", " (shadowed while Free is on)") : ""}">
          ${defenses}
        </button>
        ${ceOn ? `
        <span class="wou-gm-budget-sep"></span>
        <span class="wou-gm-budget-lbl">${t("WITCHER.Chrome.GmPanel.Text.Relocate", "Relocate")}</span>
        <button type="button" class="wou-gm-slot${priorReposition > 0 ? " is-used" : ""}${shadow}"
                data-actor-uuid="${escapeHTML(actor.uuid)}" data-slot="relocate"
                title="${escapeHTML(priorReposition > 0
                    ? `${priorReposition}${spd ? "/" + spd : ""}m repositioned this round — click to refund`
                    : `0${spd ? "/" + spd : ""}m — click to mark all reposition budget spent`)}${free ? " (shadowed while Free is on)" : ""}">
          ${priorReposition}${spd ? "/" + spd : ""}m
        </button>
        ` : ""}
        <span class="wou-gm-budget-sep"></span>
        <button type="button" class="wou-gm-free${free ? " is-on" : ""}"
                data-actor-uuid="${escapeHTML(actor.uuid)}" data-slot="free"
                title="${escapeHTML(free
                    ? t("WITCHER.Chrome.GmPanel.Tip.FreeOn",  "Free-actions override ON — nextActionSlot always returns \"action\", every record* helper no-ops. Click to turn off.")
                    : t("WITCHER.Chrome.GmPanel.Tip.FreeOff", "Free-actions override OFF — click to give unlimited actions (skips stun / status / full-round locks too)."))}">
          <i class="fa-solid fa-infinity"></i> ${free ? t("WITCHER.Chrome.GmPanel.Text.FreeOn", "Free ON") : t("WITCHER.Chrome.GmPanel.Text.Free", "Free")}
        </button>
        <button type="button" class="wou-gm-slot wou-gm-reset"
                data-actor-uuid="${escapeHTML(actor.uuid)}" data-slot="reset"
                title="${t("WITCHER.Chrome.GmPanel.Text.ClearEveryCombatRoundMarkerActionExtraFu", "Clear every combat-round marker (action / extra / full-round / movement / defenses / reload / reposition) as if the turn just started.")}">
          <i class="fa-solid fa-rotate-left"></i>
        </button>
      </div>`;
}

/* ─────────── reference tab ─────────── */

const REFERENCE_KEY = "gmReference";

/* Default seed: the Core p.152 combat summary tables + the two kept sections.
 * Built lazily so foundry.utils.randomID() is available. */
function buildReferenceSeed() {
  const cat = (titleKey, titleFallback, rows) => ({
    id: foundry.utils.randomID(),
    title: t(titleKey, titleFallback),
    rows: rows.map(([keyTerm, fbTerm, keyVal, fbVal]) => ({
      id: foundry.utils.randomID(),
      term:  t(keyTerm, fbTerm),
      value: t(keyVal, fbVal)
    })),
  });
  const K = "WITCHER.Chrome.GmPanel.Ref";
  return { categories: [
    cat(`${K}.AttackMods.Title`, "Attack modifiers (add to attack roll)", [
      [`${K}.AttackMods.TargetPinned`,    "Target pinned",           `${K}.AttackMods.TargetPinnedV`,    "+4"],
      [`${K}.AttackMods.ActiveDodge`,     "Target actively dodging", `${K}.AttackMods.ActiveDodgeV`,     "−2"],
      [`${K}.AttackMods.MovingTarget`,    "Moving target (REF >10)", `${K}.AttackMods.MovingTargetV`,    "−3"],
      [`${K}.AttackMods.FastDraw`,        "Fast draw",               `${K}.AttackMods.FastDrawV`,        "−3"],
      [`${K}.AttackMods.Ambush`,          "Ambush",                  `${K}.AttackMods.AmbushV`,          "+5"],
      [`${K}.AttackMods.Ricochet`,        "Ricochet shot",           `${K}.AttackMods.RicochetV`,        "−5"],
      [`${K}.AttackMods.Blinded`,         "Blinded by light or dust",`${K}.AttackMods.BlindedV`,         "−3"],
      [`${K}.AttackMods.Silhouetted`,     "Target silhouetted",      `${K}.AttackMods.SilhouettedV`,     "+2"],
      [`${K}.AttackMods.Aiming`,          "Aiming (per round)",      `${K}.AttackMods.AimingV`,          "+1"],
    ]),
    cat(`${K}.Ranges.Title`, "Ranges & target DC", [
      [`${K}.Ranges.PointBlank`,          "Point blank (≤½m / touching)", `${K}.Ranges.PointBlankV`,     "DC 10 · +5"],
      [`${K}.Ranges.Close`,               "Close (¼ listed range)",       `${K}.Ranges.CloseV`,          "DC 15 · +0"],
      [`${K}.Ranges.Medium`,              "Medium (½ listed range)",      `${K}.Ranges.MediumV`,         "DC 20 · −2"],
      [`${K}.Ranges.Long`,                "Long (listed range)",          `${K}.Ranges.LongV`,           "DC 25 · −4"],
      [`${K}.Ranges.Extreme`,             "Extreme (2× listed range)",    `${K}.Ranges.ExtremeV`,        "DC 30 · −6"],
    ]),
    cat(`${K}.Light.Title`, "Light levels", [
      [`${K}.Light.Bright`,  "Bright light (desert sun, sun off snow)", `${K}.Light.BrightV`,  "−3 Awareness; −3 attack & defense if facing the sun"],
      [`${K}.Light.Day`,     "Daylight",                                 `${K}.Light.DayV`,     "No penalties"],
      [`${K}.Light.Dim`,     "Dim light (moonlight)",                    `${K}.Light.DimV`,     "−2 Awareness"],
      [`${K}.Light.Dark`,    "Darkness (new moon, deep cavern)",         `${K}.Light.DarkV`,    "−4 Awareness; −2 attack & defense"],
    ]),
    cat(`${K}.Crit.Title`, "Critical levels (beat defense by)", [
      [`${K}.Crit.Beat7`,  "Beat by 7",  `${K}.Crit.Beat7V`,  "Simple · +3 damage"],
      [`${K}.Crit.Beat10`, "Beat by 10", `${K}.Crit.Beat10V`, "Complex · +5 damage"],
      [`${K}.Crit.Beat13`, "Beat by 13", `${K}.Crit.Beat13V`, "Difficult · +8 damage"],
      [`${K}.Crit.Beat15`, "Beat by 15", `${K}.Crit.Beat15V`, "Deadly · +10 damage"],
    ]),
    cat(`${K}.HitHuman.Title`, "Human hit location (d10)", [
      [`${K}.HitHuman.Head`,  "Head (1)",       `${K}.HitHuman.HeadV`,  "−6 to hit · ×3 damage"],
      [`${K}.HitHuman.Torso`, "Torso (2–4)",    `${K}.HitHuman.TorsoV`, "−1 to hit · ×1 damage"],
      [`${K}.HitHuman.RArm`,  "Right arm (5)",  `${K}.HitHuman.RArmV`,  "−3 to hit · ×½ damage"],
      [`${K}.HitHuman.LArm`,  "Left arm (6)",   `${K}.HitHuman.LArmV`,  "−3 to hit · ×½ damage"],
      [`${K}.HitHuman.RLeg`,  "Right leg (7–8)",`${K}.HitHuman.RLegV`,  "−2 to hit · ×½ damage"],
      [`${K}.HitHuman.LLeg`,  "Left leg (9–10)",`${K}.HitHuman.LLegV`,  "−2 to hit · ×½ damage"],
    ]),
    cat(`${K}.HitMonster.Title`, "Monster hit location (d10)", [
      [`${K}.HitMonster.Head`,   "Head (1)",           `${K}.HitMonster.HeadV`,   "−6 to hit · ×3 damage"],
      [`${K}.HitMonster.Torso`,  "Torso (2–5)",        `${K}.HitMonster.TorsoV`,  "−1 to hit · ×1 damage"],
      [`${K}.HitMonster.RLimb`,  "Right limb (6–7)",   `${K}.HitMonster.RLimbV`,  "−3 to hit · ×½ damage"],
      [`${K}.HitMonster.LLimb`,  "Left limb (8–9)",    `${K}.HitMonster.LLimbV`,  "−3 to hit · ×½ damage"],
      [`${K}.HitMonster.TailWing`, "Tail or wing (10)",  `${K}.HitMonster.TailWingV`,"−2 to hit · ×½ damage"],
    ]),
    cat(`${K}.Cover.Title`, "Common cover (SP)", [
      [`${K}.Cover.Stone`,      "Stone wall",         `${K}.Cover.StoneV`,       "30"],
      [`${K}.Cover.Tree`,       "Large tree",         `${K}.Cover.TreeV`,        "30"],
      [`${K}.Cover.Brick`,      "Brick wall",         `${K}.Cover.BrickV`,       "25"],
      [`${K}.Cover.SteelDoor`,  "Steel door",         `${K}.Cover.SteelDoorV`,   "20"],
      [`${K}.Cover.HeavyDoor`,  "Heavy wooden door",  `${K}.Cover.HeavyDoorV`,   "15"],
      [`${K}.Cover.WoodWall`,   "Wooden wall",        `${K}.Cover.WoodWallV`,    "10"],
      [`${K}.Cover.Cart`,       "Cart",               `${K}.Cover.CartV`,        "10"],
      [`${K}.Cover.Barrel`,     "Wooden barrel",      `${K}.Cover.BarrelV`,      "10"],
      [`${K}.Cover.Thatch`,     "Thatch roof",        `${K}.Cover.ThatchV`,      "7"],
      [`${K}.Cover.Brambles`,   "Brambles",           `${K}.Cover.BramblesV`,    "7"],
      [`${K}.Cover.Tent`,       "Tent",               `${K}.Cover.TentV`,        "5"],
    ]),
    cat(`${K}.DefReact.Title`, "Defense reactions (STA)", [
      [`${K}.DefReact.First`,   "1st reaction / round", `${K}.DefReact.FirstV`,   "Free"],
      [`${K}.DefReact.Extra`,   "Each extra reaction",  `${K}.DefReact.ExtraV`,   "+1 STA"],
      [`${K}.DefReact.Options`, "Options",              `${K}.DefReact.OptionsV`, "Reposition, Dodge, Parry, Block"],
    ]),
    cat(`${K}.Resolve.Title`, "Damage resolution order", [
      [`${K}.Resolve.Strong`,   "1. Strong-strike ×", `${K}.Resolve.StrongV`,   "Multiplier applied to the rolled dice, before SP"],
      [`${K}.Resolve.SP`,       "2. Subtract SP",     `${K}.Resolve.SPV`,       "Armour on the hit location reduces the total"],
      [`${K}.Resolve.Location`, "3. Location ×",      `${K}.Resolve.LocationV`, "Location multiplier applied after SP, to the remainder"],
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
      </details>`).join("") || `<div class="wou-gm-empty">${t("WITCHER.Chrome.GmPanel.Text.NoReferenceEntries", "No reference entries.")}</div>`;
    body.innerHTML = editBtn + cats;
    return;
  }

  // edit mode
  const cats = data.categories.map(c => `
    <div class="wou-gm-ref-edit-cat" data-ref-cat="${c.id}">
      <div class="wou-gm-ref-cathead">
        <input type="text" class="wou-gm-ref-cat-title" data-ref-cat-title="${c.id}" value="${escapeHTML(c.title)}" />
        <button type="button" class="rm" data-ref-cat-del="${c.id}" title="${t("WITCHER.Chrome.GmPanel.Text.RemoveCategory", "Remove category")}">×</button>
      </div>
      ${c.rows.map(r => `
        <div class="wou-gm-ref-editrow">
          <input type="text" class="term" data-ref-row-term="${c.id}:${r.id}" value="${escapeHTML(r.term)}" placeholder="${t("WITCHER.Chrome.GmPanel.Text.Term", "Term")}" />
          <input type="text" class="val" data-ref-row-val="${c.id}:${r.id}" value="${escapeHTML(r.value)}" placeholder="${t("WITCHER.Chrome.GmPanel.Text.Value", "Value")}" />
          <button type="button" class="rm" data-ref-row-del="${c.id}:${r.id}" title="${t("WITCHER.Chrome.GmPanel.Text.RemoveField", "Remove field")}">×</button>
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
      <select class="wou-gm-rollmode" title="${t("WITCHER.Chrome.GmPanel.Text.RollMode", "Roll mode")}">
        <option value="publicroll">${t("WITCHER.Chrome.GmPanel.Text.Public", "Public")}</option>
        <option value="gmroll">${t("WITCHER.Chrome.GmPanel.Text.PrivateGM", "Private GM")}</option>
        <option value="blindroll">${t("WITCHER.Chrome.GmPanel.Text.BlindGM", "Blind GM")}</option>
        <option value="selfroll">${t("WITCHER.Chrome.GmPanel.Text.SelfRoll", "Self")}</option>
      </select>
      <button type="button" data-roll-skill>${t("WITCHER.Chrome.GmPanel.Text.RollForPCs", "Roll for PCs")}</button>
    </div>`;

  /* 2. Rewards — IP / Magic IP / crowns granted to the whole party.
   *    Magic IP accepts negative values so the GM can also REMOVE magic IP
   *    (a mid-campaign correction, revoked training, etc.). Regular IP and
   *    crowns stay grant-only (min=0) to preserve the "grant" affordance;
   *    a negative correction there is uncommon and would need a per-actor
   *    UI to be safe. */
  const rewardHTML = `
    <div class="row">
      <label class="lbl">${t("WITCHER.Chrome.GmPanel.Text.IP", "IP")} <input type="number" data-reward="ip" value="0" min="0" /></label>
      <label class="lbl" title="${t("WITCHER.Chrome.GmPanel.Text.MagicDedicatedImprovementPointsAcceptsNe", "Magic-dedicated Improvement Points. Accepts negative values to remove magic IP.")}">${t("WITCHER.Chrome.GmPanel.Text.MagicIP", "Magic IP")} <input type="number" data-reward="magicIp" value="0" step="1" /></label>
      <label class="lbl">${t("WITCHER.Chrome.GmPanel.Text.Coin", "Coin")}
        <select data-reward-currency>${currencyOptsHTML("crown")}</select>
        <input type="number" data-reward="coin" value="0" min="0" />
      </label>
      <button type="button" data-reward-grant>${t("WITCHER.Chrome.GmPanel.Text.GrantToParty", "Grant to party")}</button>
    </div>`;

  /* 3. Per-player rewards — one input triplet per player-owned character so
   *    the GM can grant different amounts per PC in a single sweep. Values
   *    default to 0; rows with all-zero inputs are skipped on grant. */
  const perPlayerHTML = renderPerPlayerRewardsHTML();

  body.innerHTML = `
    <section class="wou-gm-sess"><h4>${t("WITCHER.Chrome.GmPanel.Text.GroupSkillCheck", "Group skill check")}</h4>${rollHTML}</section>
    <section class="wou-gm-sess"><h4>${t("WITCHER.Chrome.GmPanel.Text.DistributeRewards", "Distribute rewards")}</h4>${rewardHTML}${perPlayerHTML}</section>
  `;
}

/* Build the per-player rewards table. One row per player-owned character;
 * the player-name column lists the non-GM user(s) with OWNER access on the
 * actor. Empty state when the world has no player-owned characters. */
function renderPerPlayerRewardsHTML() {
  const pcs = partyPCs();
  if (!pcs.length) {
    return `<div class="wou-gm-per-player is-empty">${t("WITCHER.Chrome.GmPanel.Text.NoPlayerCharacters", "No player-owned characters.")}</div>`;
  }
  const headers = `
    <div class="wou-gm-pp-head">
      <span class="wou-gm-pp-name">${t("WITCHER.Chrome.GmPanel.Text.Character", "Character")}</span>
      <span class="wou-gm-pp-player">${t("WITCHER.Chrome.GmPanel.Text.Player", "Player")}</span>
      <span class="wou-gm-pp-h">${t("WITCHER.Chrome.GmPanel.Text.IP", "IP")}</span>
      <span class="wou-gm-pp-h">${t("WITCHER.Chrome.GmPanel.Text.MagicIP", "Magic IP")}</span>
      <span class="wou-gm-pp-h">${t("WITCHER.Chrome.GmPanel.Text.Coin", "Coin")}</span>
    </div>`;
  const rows = pcs.map(actor => {
    const owners = (actor.playerOwners ?? []).map(u => escapeHTML(u.name)).join(", ")
      || `<span class="wou-gm-pp-noplayer">—</span>`;
    return `
      <div class="wou-gm-pp-row" data-actor-id="${escapeHTML(actor.id)}">
        <span class="wou-gm-pp-name">${escapeHTML(actor.name)}</span>
        <span class="wou-gm-pp-player">${owners}</span>
        <input type="number" data-pp-reward="ip"      value="0" min="0" />
        <input type="number" data-pp-reward="magicIp" value="0" step="1" />
        <input type="number" data-pp-reward="coin"    value="0" min="0" />
      </div>`;
  }).join("");
  /* Shared denomination selector for the per-player table — every row's coin
   * amount lands in the same denomination. Simpler than a per-row selector
   * and matches the typical use case (one currency across the party). */
  const currencyRow = `
    <div class="wou-gm-pp-currency">
      <label class="lbl">${t("WITCHER.Chrome.GmPanel.Text.Coin", "Coin")}
        <select data-pp-currency>${currencyOptsHTML("crown")}</select>
      </label>
    </div>`;
  return `
    <div class="wou-gm-per-player">
      <div class="wou-gm-pp-title">${t("WITCHER.Chrome.GmPanel.Text.PerPlayerRewards", "Per-player rewards")}</div>
      ${currencyRow}
      ${headers}
      ${rows}
      <div class="row">
        <button type="button" data-reward-grant-per-player>${t("WITCHER.Chrome.GmPanel.Text.GrantPerPlayer", "Grant per player")}</button>
      </div>
    </div>`;
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
  // A manual INCREASE here counts as a real gain of that resource — adrenaline
  // fires the on-gain effect scaled by the amount, HP fires Regenerating, etc.
  // A decrease fires nothing. The pool-current ledger fix keeps these one-time
  // (no snowball).
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

  panel.style.left = `calc(${left}px / var(--wdm-scale, 1))`;
  panel.style.bottom = `calc(${bottom}px / var(--wdm-scale, 1))`;
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
  /* ─── party tab: combat budget interactions ─────────────────
   * Click any slot pill (A / E / FR / Move) to flip its underlying
   * combatRound boolean. Movement clears both `movementUsed` and
   * `movementMeters`. The `free` pill toggles the per-actor
   * `flags.<sys>.freeActions` override; `reset` clears every marker
   * as if the round just started. */
  document.addEventListener("click", async (ev) => {
    const btn = ev.target.closest?.(`#${PANEL_ID} .wou-gm-budget [data-slot]`);
    if (!btn) return;
    ev.preventDefault(); ev.stopPropagation();
    const actor = fromUuidSync(btn.dataset.actorUuid);
    if (!actor) return;
    const slot = btn.dataset.slot;
    const r = actor.system?.combatRound ?? {};
    try {
      switch (slot) {
        case "action":
          await actor.update({
            "system.combatRound.actionUsed": !r.actionUsed,
            "system.combatRound.actionLabel": r.actionUsed ? "" : t("WITCHER.Chrome.GmPanel.Text.GMOverride", "GM override")
          });
          break;
        case "extra":
          await actor.update({
            "system.combatRound.extraUsed": !r.extraUsed,
            "system.combatRound.extraLabel": r.extraUsed ? "" : t("WITCHER.Chrome.GmPanel.Text.GMOverride", "GM override")
          });
          break;
        case "fullRound":
          await actor.update({
            "system.combatRound.fullRound": !r.fullRound,
            "system.combatRound.fullRoundLabel": r.fullRound ? "" : t("WITCHER.Chrome.GmPanel.Text.GMOverride", "GM override"),
            /* When clearing FR, also clear runUsed so the movement cap
             * drops back from SPD×3 to plain SPD. */
            "system.combatRound.runUsed": r.fullRound ? false : !!r.runUsed
          });
          break;
        case "movement": {
          const spent = !!r.movementUsed || (Number(r.movementMeters) || 0) > 0;
          if (spent) {
            /* Refund — start turn as if untouched. */
            await actor.update({
              "system.combatRound.movementUsed":   false,
              "system.combatRound.movementMeters": 0
            });
            /* Also clear each token's movement history via the Foundry
             * API. The canvas policy (canvas-movement.mjs:325) re-derives
             * the authoritative meters from Foundry's history and writes
             * `Math.max(newTotal, priorMeters)` back to the actor, so
             * without this the next canvas drag re-sums the still-intact
             * waypoint list and overwrites the refund. `_movementHistory`
             * is a private field on the token document — the public API
             * `clearMovementHistory()` is what combatRoundMixin uses on
             * turn transitions, and it clears both the DB waypoints AND
             * the visual "moved this turn" trail. `getActiveTokens(false,
             * true)` returns all tokens (linked + unlinked), as
             * TokenDocuments. */
            try {
              const tokens = (typeof actor.getActiveTokens === "function")
                ? (actor.getActiveTokens(false, true) ?? [])
                : [];
              for (const td of tokens) {
                if (typeof td?.clearMovementHistory !== "function") continue;
                try { await td.clearMovementHistory(); }
                catch (_) { /* soft-fail per token */ }
              }
            } catch (err) {
              console.warn("witcher-ttrpg-death-march | movement refund: history clear failed", err);
            }
          } else {
            /* Mark ALL movement spent. */
            await actor.update({
              "system.combatRound.movementUsed":   true,
              "system.combatRound.movementMeters": Number(actor.system?.stats?.spd?.value) || 0
            });
          }
          break;
        }
        case "free": {
          const now = !!actor.getFlag?.("witcher-ttrpg-death-march", "freeActions");
          await actor.setFlag("witcher-ttrpg-death-march", "freeActions", !now);
          break;
        }
        case "vigor": {
          /* Chaos is stored on `flags.<sys>.chaosRound` = { round, spent }.
           * Refund clears it entirely; "mark all spent" sets spent to the
           * actor's Vigor for the current combat round (or a nominal 1
           * when we're out of combat / vigor is 0). */
          const flag = actor.getFlag?.("witcher-ttrpg-death-march", "chaosRound") ?? {};
          const combatKey = (game.combat?.started && game.combat?.id)
            ? `${game.combat.id}:${game.combat.round}` : null;
          const alreadySpent = (combatKey != null && flag.round === combatKey)
            ? (Number(flag.spent) || 0) : 0;
          if (alreadySpent > 0) {
            await actor.setFlag("witcher-ttrpg-death-march", "chaosRound", { round: combatKey, spent: 0 });
          } else {
            const vig = Math.max(1, Number(actor.system?.derivedStats?.vigor) || 0);
            await actor.setFlag("witcher-ttrpg-death-march", "chaosRound", { round: combatKey ?? "manual", spent: vig });
          }
          break;
        }
        case "defenses": {
          const cur = Number(r.defenseCount) || 0;
          /* Toggle: 0 → 1 (mark one taken), non-zero → 0 (refund all). */
          await actor.update({ "system.combatRound.defenseCount": cur > 0 ? 0 : 1 });
          break;
        }
        case "relocate": {
          const cur = Number(r.repositionMeters) || 0;
          const spdVal = Number(actor.system?.stats?.spd?.value) || 0;
          /* Toggle: any meters → 0 (refund); 0 → spd (mark all spent).
           * Under CE-on this cap-fills the per-round budget so the next
           * reposition attempt shows the button disabled; under CE-off
           * the pill isn't visible at all so we never hit this branch. */
          await actor.update({
            "system.combatRound.repositionMeters": cur > 0 ? 0 : Math.max(1, spdVal)
          });
          break;
        }
        case "reset":
          /* Clear EVERY round-scoped field so the turn is truly reset —
           * defenseCount / activelyDodging / reloadedThisTurn / repositionMeters
           * live on the same combatRound schema and, if left set, would carry
           * "already reacted / already reloaded / already repositioned" state
           * into what the UI just labeled a fresh turn. */
          await actor.update({
            "system.combatRound.actionUsed":       false,
            "system.combatRound.actionLabel":      "",
            "system.combatRound.extraUsed":        false,
            "system.combatRound.extraLabel":       "",
            "system.combatRound.fullRound":        false,
            "system.combatRound.fullRoundLabel":   "",
            "system.combatRound.runUsed":          false,
            "system.combatRound.movementUsed":     false,
            "system.combatRound.movementMeters":   0,
            "system.combatRound.defenseCount":     0,
            "system.combatRound.activelyDodging":  false,
            "system.combatRound.reloadedThisTurn": false,
            "system.combatRound.repositionMeters": 0
          });
          /* Also clear the token's movement history — see the "movement"
           * case for the reasoning + API details. Reset means "turn is
           * fresh"; leaving waypoints in place would let the next canvas
           * drag re-derive the pre-reset total and bank it back onto the
           * actor. `clearMovementHistory()` also clears the visual
           * "moved this turn" trail on the canvas. */
          try {
            const tokens = (typeof actor.getActiveTokens === "function")
              ? (actor.getActiveTokens(false, true) ?? [])
              : [];
            for (const td of tokens) {
              if (typeof td?.clearMovementHistory !== "function") continue;
              try { await td.clearMovementHistory(); }
              catch (_) { /* soft-fail per token */ }
            }
          } catch (err) {
            console.warn("witcher-ttrpg-death-march | round reset: history clear failed", err);
          }
          break;
      }
    } catch (err) {
      console.warn("wou gm-panel | combat budget toggle failed", err);
    }
    try { btn.blur(); } catch (_) { /* button may be re-rendered */ }
    refreshPartyIfOpen();
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
    data.categories.push({ id: foundry.utils.randomID(), title: t("WITCHER.Dialog.GM.NewCategory", "New category"), rows: [] });
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
    if (!pcs.length) { ui.notifications?.warn(t("WITCHER.Notify.GM.NoPCs", "No player-owned characters to roll for.")); return; }
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
    const ipIn      = document.querySelector(`#${PANEL_ID} [data-reward="ip"]`);
    const magicIpIn = document.querySelector(`#${PANEL_ID} [data-reward="magicIp"]`);
    const coinIn    = document.querySelector(`#${PANEL_ID} [data-reward="coin"]`);
    const denomSel  = document.querySelector(`#${PANEL_ID} [data-reward-currency]`);
    const ip      = Math.trunc(Number(ipIn?.value) || 0);
    const magicIp = Math.trunc(Number(magicIpIn?.value) || 0);
    const coin    = Math.trunc(Number(coinIn?.value) || 0);
    const denom   = CURRENCY_KEYS.includes(denomSel?.value) ? denomSel.value : "crown";
    const denomLabel = t(`WITCHER.Currency.${denom}`, denom);
    const pcs = partyPCs();
    if ((!ip && !magicIp && !coin) || !pcs.length) { ui.notifications?.warn(t("WITCHER.Notify.GM.NothingToGrant", "Nothing to grant.")); return; }
    const magicSummary = magicIp === 0 ? ""
      : magicIp > 0 ? ` and <b>${magicIp} Magic IP</b>`
      : ` and <b>remove ${Math.abs(magicIp)} Magic IP</b>`;
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: t("WITCHER.Dialog.GM.DistributeRewards", "Distribute rewards") },
      content: `<p>${t("WITCHER.Chrome.GmPanel.Text.Grant", "Grant")} <b>${ip} IP</b>${magicSummary} and <b>${coin} ${escapeHTML(denomLabel)}</b> to <b>${pcs.length}</b> player character(s)?</p>`,
      modal: true,
    });
    if (!ok) return;
    for (const actor of pcs) {
      const sys = actor.system ?? {};
      // Clamp magic IP >= 0 — the schema's NumberField min:0 would reject a
      // negative write anyway, but clamping here also handles the "remove
      // more than the actor has" case gracefully (drop to 0 instead of a
      // per-actor validation error that stalls the grant loop).
      const nextMagic = Math.max(0, (Number(sys.magic?.magicImprovementPoints) || 0) + magicIp);
      const update = {
        "system.improvementPoints":               (Number(sys.improvementPoints) || 0) + ip,
        "system.magic.magicImprovementPoints":    nextMagic,
        [`system.currency.${denom}`]:             (Number(sys.currency?.[denom]) || 0) + coin
      };
      if (ip > 0 || magicIp !== 0) {
        const log = foundry.utils.deepClone(sys.logs?.ipLog ?? []);
        if (ip > 0) log.push({ label: t("WITCHER.Chrome.GmPanel.Dialog.Button.GMGrant", "GM grant"), value: ip });
        if (magicIp !== 0) log.push({ label: magicIp > 0 ? "GM grant (Magic)" : "GM remove (Magic)", value: magicIp });
        update["system.logs.ipLog"] = log;
      }
      await actor.update(update, { render: false });
    }
    ui.notifications?.info(tFormat("WITCHER.Notify.GM.Granted", { ip: ip, coin: coin, denom: denomLabel, n: pcs.length }, "Granted {ip} IP and {coin} {denom} to {n} character(s)."));
  });

  /* ─── session: grant per-player rewards ─── */
  document.addEventListener("click", async (ev) => {
    const btn = ev.target.closest?.(`#${PANEL_ID} [data-reward-grant-per-player]`);
    if (!btn) return;
    ev.preventDefault(); ev.stopPropagation();

    /* Collect every non-zero row into a grant plan. Rows with all-zero inputs
     * are skipped silently so the GM can leave a row blank to mean "nothing
     * for this PC" without having to zero out other rows. */
    const denomSel = document.querySelector(`#${PANEL_ID} [data-pp-currency]`);
    const denom    = CURRENCY_KEYS.includes(denomSel?.value) ? denomSel.value : "crown";
    const denomLabel = t(`WITCHER.Currency.${denom}`, denom);
    const rows = document.querySelectorAll(`#${PANEL_ID} .wou-gm-pp-row`);
    const plan = [];
    for (const row of rows) {
      const actor = game.actors?.get(row.dataset.actorId);
      if (!actor) continue;
      const ip      = Math.trunc(Number(row.querySelector('[data-pp-reward="ip"]')?.value)      || 0);
      const magicIp = Math.trunc(Number(row.querySelector('[data-pp-reward="magicIp"]')?.value) || 0);
      const coin    = Math.trunc(Number(row.querySelector('[data-pp-reward="coin"]')?.value)    || 0);
      if (!ip && !magicIp && !coin) continue;
      plan.push({ actor, ip, magicIp, coin });
    }
    if (!plan.length) { ui.notifications?.warn(t("WITCHER.Notify.GM.NothingToGrant", "Nothing to grant.")); return; }

    /* Confirmation lists every recipient with their per-line breakdown so
     * the GM can eyeball the plan before it commits. Uses the same
     * "GM grant" IP-log labels as the party grant for a coherent history. */
    const lines = plan.map(({ actor, ip, magicIp, coin }) => {
      const bits = [];
      if (ip)                bits.push(`<b>${ip} IP</b>`);
      if (magicIp > 0)       bits.push(`<b>${magicIp} Magic IP</b>`);
      else if (magicIp < 0)  bits.push(`<b>remove ${Math.abs(magicIp)} Magic IP</b>`);
      if (coin)              bits.push(`<b>${coin} ${escapeHTML(denomLabel)}</b>`);
      return `<li>${escapeHTML(actor.name)}: ${bits.join(" · ")}</li>`;
    }).join("");
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: t("WITCHER.Dialog.GM.DistributeRewards", "Distribute rewards") },
      content: `<p>${t("WITCHER.Chrome.GmPanel.Text.GrantPerPlayerConfirm", "Grant the following per-player rewards?")}</p><ul>${lines}</ul>`,
      modal: true,
    });
    if (!ok) return;

    for (const { actor, ip, magicIp, coin } of plan) {
      const sys = actor.system ?? {};
      const nextMagic = Math.max(0, (Number(sys.magic?.magicImprovementPoints) || 0) + magicIp);
      const update = {
        "system.improvementPoints":            (Number(sys.improvementPoints) || 0) + ip,
        "system.magic.magicImprovementPoints": nextMagic,
        [`system.currency.${denom}`]:          (Number(sys.currency?.[denom]) || 0) + coin
      };
      if (ip > 0 || magicIp !== 0) {
        const log = foundry.utils.deepClone(sys.logs?.ipLog ?? []);
        if (ip > 0)         log.push({ label: t("WITCHER.Chrome.GmPanel.Dialog.Button.GMGrant", "GM grant"), value: ip });
        if (magicIp !== 0)  log.push({ label: magicIp > 0 ? "GM grant (Magic)" : "GM remove (Magic)", value: magicIp });
        update["system.logs.ipLog"] = log;
      }
      await actor.update(update, { render: false });
    }
    ui.notifications?.info(tFormat("WITCHER.Notify.GM.GrantedPerPlayer", { n: plan.length }, "Granted per-player rewards to {n} character(s)."));
  });
}
