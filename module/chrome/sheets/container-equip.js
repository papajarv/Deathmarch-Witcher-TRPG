/**
 * Container storage editor (card-based).
 *
 * Injected into the container sheet's CONFIG view (`.wdm-config-view
 * .wdm-cfg-form`). Three plain-language sections:
 *
 *   Storage       — capacity mode (General / Slots / Hybrid) + "allow stacks".
 *   General space — filter rows the loose pool accepts (type / kind / size /
 *                   weight). Empty = everything. Shown for general / hybrid.
 *   Compartments  — dedicated slots as cards: what they fit (type / kind /
 *                   count / size / weight) and combat perks — Quick-Draw
 *                   (weapons) and Free-Use. Shown for slots / hybrid.
 *
 * Persistence: one structured flag (see `lib/container.js`), written with
 * render:false so this injected editor isn't torn down mid-edit by the
 * sheet's submitOnChange. All enforcement lives in `lib/container.js`.
 */

import { t } from "../lib/i18n.js";
import {
  SLOT_TYPES, SUBTYPES_BY_TYPE, slotTypeLabel,
  CONCEAL_CODES, CONCEAL_LABELS, getContainerCfg, CAPACITY_MODES,
} from "../lib/container.js";

const MODULE_ID = "witcher-ttrpg-death-march";
const FLAG_KEY  = "containerCfg";
const FLAG_PATH = `flags.${MODULE_ID}.${FLAG_KEY}`;

const CONCEAL_TYPES = new Set(["any", "weapon", "ammo", "alchemical"]);
function typeHasConceal(type) { return CONCEAL_TYPES.has(type); }

function capModeLabel(mode) {
  const fb = { general: "General", slots: "Slots", hybrid: "Hybrid" }[mode] ?? mode;
  return t(`WITCHER.Sheet.ContainerEquip.CapMode.${mode}`, fb);
}
function capModeDesc(mode) {
  const fb = {
    general: "Holds anything the list below allows, up to its weight filters.",
    slots:   "Holds only what fits one of its compartments.",
    hybrid:  "Loose space for allowed items, plus special compartments.",
  }[mode] ?? "";
  return t(`WITCHER.Sheet.ContainerEquip.CapModeDesc.${mode}`, fb);
}

function typeIcon(type, subtype) {
  if (type === "weapon") {
    return ({ swordsmanship: "fa-sword", smallblades: "fa-dagger", staffspear: "fa-staff-aesculapius",
      melee: "fa-hammer", brawling: "fa-hand-fist", archery: "fa-bow-arrow", crossbow: "fa-crosshairs",
      athletics: "fa-person-running", bomb: "fa-bomb" }[subtype]) || "fa-swords";
  }
  if (type === "ammo") {
    return ({ arrow: "fa-bow-arrow", bolt: "fa-arrow-right-long", slingBullet: "fa-circle", siege: "fa-bomb" }[subtype]) || "fa-location-arrow";
  }
  return ({ any: "fa-asterisk", armor: "fa-shield-halved", alchemical: "fa-flask", component: "fa-leaf",
    mutagen: "fa-vial", valuable: "fa-coins", map: "fa-map", remains: "fa-skull", enhancement: "fa-gem",
    diagrams: "fa-scroll", note: "fa-feather", container: "fa-box" }[type]) || "fa-cube";
}

function injectStyles() {
  if (document.getElementById(`${MODULE_ID}-container-cfg-styles`)) return;
  const style = document.createElement("style");
  style.id = `${MODULE_ID}-container-cfg-styles`;
  style.textContent = `
    .wou-cc { display: flex; flex-direction: column; gap: 0.6rem; margin: 0.4rem 0; font-size: 0.9em; }
    .wou-cc [hidden] { display: none !important; }
    .wou-cc-section { display: flex; flex-direction: column; gap: 0.3rem; }
    .wou-cc-section-title { font-weight: 700; font-size: 1.02em; letter-spacing: 0.6px; text-transform: uppercase; opacity: 0.85; }
    .wou-cc-modes { display: inline-flex; align-self: flex-start; border: 1px solid rgba(0,0,0,0.25); border-radius: 0.35rem; overflow: hidden; }
    .wou-cc-mode { background: rgba(0,0,0,0.04); border: 0; border-right: 1px solid rgba(0,0,0,0.15); padding: 0.22rem 0.85rem; cursor: pointer; font-size: 0.92em; }
    .wou-cc-mode:last-child { border-right: 0; }
    .wou-cc-mode.is-active { background: var(--wdm-accent, #c8a878); color: #1a1206; font-weight: 700; }
    .wou-cc-modedesc { font-size: 0.85em; font-style: italic; opacity: 0.7; }
    .wou-cc-options { display: flex; align-items: center; gap: 0.85rem; flex-wrap: wrap; }
    .wou-cc-options label { display: inline-flex; align-items: center; gap: 0.3rem; white-space: nowrap; }
    .wou-cc-hint { font-size: 0.8em; font-style: italic; opacity: 0.55; }
    .wou-cc-add { align-self: flex-start; background: rgba(0,0,0,0.05); border: 1px dashed rgba(0,0,0,0.3); border-radius: 0.3rem; padding: 0.1rem 0.42rem; cursor: pointer; font-size: 0.72em; opacity: 0.9; }
    .wou-cc-lbl { font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.4px; opacity: 0.5; }
    /* general-space filter rows — priority rail visualises "read bottom → top",
       higher rules override lower ones (topmost match wins). */
    .wou-cc-prio-wrap { display: flex; align-items: stretch; gap: 0.4rem; }
    .wou-cc-prio-rail { flex: 0 0 auto; width: 2.1rem; min-height: 3.2rem; display: flex; flex-direction: column; align-items: center; justify-content: space-between; padding: 0.05rem 0; }
    .wou-cc-prio-cap { font-size: 0.56em; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; text-align: center; line-height: 1.05; white-space: nowrap; }
    .wou-cc-prio-win  { color: rgba(90,150,80,0.95); }
    .wou-cc-prio-win i { font-size: 1.1em; }
    .wou-cc-prio-base { opacity: 0.4; }
    .wou-cc-prio-track { flex: 1 1 auto; width: 2px; margin: 0.2rem 0; border-radius: 1px; background: linear-gradient(to top, rgba(140,133,121,0.12), rgba(90,150,80,0.6)); }
    .wou-cc-grows { flex: 1 1 auto; display: flex; flex-direction: column; gap: 0.3rem; }
    .wou-cc-grow { display: flex; align-items: center; gap: 0.35rem; flex-wrap: wrap; border: 1px solid rgba(0,0,0,0.15); border-radius: 0.35rem; background: rgba(0,0,0,0.03); padding: 0.25rem 0.4rem; }
    .wou-cc-grow[data-mode="deny"] { border-left: 3px solid rgba(170,60,50,0.7); }
    .wou-cc-grow[data-mode="allow"] { border-left: 3px solid rgba(90,150,80,0.6); }
    .wou-cc-gmode { flex: 0 0 auto; border: 1px solid rgba(0,0,0,0.25); border-radius: 0.3rem; padding: 0.1rem 0.45rem; cursor: pointer; font-size: 0.72em; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; min-width: 3rem; text-align: center; }
    .wou-cc-gmode.is-allow { background: rgba(90,150,80,0.18); color: #2f6b28; border-color: rgba(90,150,80,0.5); }
    .wou-cc-gmode.is-deny  { background: rgba(170,60,50,0.18); color: #8a2b22; border-color: rgba(170,60,50,0.5); }
    .wou-cc-cmp { background: rgba(0,0,0,0.06); border: 1px solid rgba(0,0,0,0.25); border-radius: 0.25rem; cursor: pointer; font-size: 0.95em; font-weight: 700; line-height: 1; padding: 0.05rem 0.32rem; min-width: 1.35rem; text-align: center; color: inherit; }
    .wou-cc-cmp:hover { background: rgba(0,0,0,0.13); border-color: rgba(0,0,0,0.45); }
    .wou-cc-greorder { display: inline-flex; flex-direction: column; margin-left: auto; }
    .wou-cc-grow .wou-cc-gdel { margin-left: 0.15rem; }
    .wou-cc-gup, .wou-cc-gdown { background: none; border: 0; cursor: pointer; opacity: 0.5; padding: 0 0.15rem; line-height: 0.9; font-size: 0.7em; }
    .wou-cc-gup:hover, .wou-cc-gdown:hover { opacity: 1; }
    .wou-cc-grow-icon { width: 1.1rem; text-align: center; opacity: 0.8; }
    .wou-cc-grow select { min-width: 0; }
    .wou-cc-grow .wou-cc-gtype, .wou-cc-grow .wou-cc-gsub { flex: 1 1 5rem; }
    .wou-cc-grow label { display: inline-flex; align-items: center; gap: 0.25rem; white-space: nowrap; }
    .wou-cc-grow label.is-na { display: none; }
    .wou-cc-gmaxw { width: 3rem; text-align: center; }
    .wou-cc-gdel, .wou-cc-del, .wou-cc-chip-del { background: none; border: 0; cursor: pointer; opacity: 0.55; padding: 0 0.15rem; font-size: 0.95em; margin-left: auto; }
    .wou-cc-gdel:hover, .wou-cc-del:hover { opacity: 1; }
    /* compartment cards */
    .wou-cc-cards { display: flex; flex-direction: column; gap: 0.4rem; }
    .wou-cc-card { border: 1px solid rgba(0,0,0,0.2); border-radius: 0.45rem; background: rgba(0,0,0,0.03); padding: 0.4rem 0.5rem; display: flex; flex-direction: column; gap: 0.35rem; }
    .wou-cc-card-head { display: flex; align-items: center; gap: 0.35rem; }
    .wou-cc-card-icon { width: 1.15rem; text-align: center; opacity: 0.8; }
    .wou-cc-card-head select { flex: 1 1 6rem; min-width: 0; }
    .wou-cc-card-head .wou-cc-lbl { font-weight: 600; opacity: 0.85; }
    .wou-cc-accepts { display: flex; flex-direction: column; gap: 0.25rem; padding-left: 1.5rem; }
    .wou-cc-accept { display: flex; align-items: center; gap: 0.35rem; }
    .wou-cc-accept select { flex: 1 1 6rem; min-width: 0; }
    .wou-cc-accept-icon { width: 1.15rem; text-align: center; opacity: 0.8; }
    .wou-cc-accept-del { border: 1px solid rgba(0,0,0,0.2); border-radius: 0.2rem; width: 1.3rem; height: 1.3rem; opacity: 0.6; }
    .wou-cc-accept-del:hover { opacity: 1; }
    .wou-cc-accept-add { align-self: flex-start; font-size: 0.85em; opacity: 0.8; background: none; border: 1px dashed rgba(0,0,0,0.25); border-radius: 0.25rem; padding: 0.1rem 0.45rem; cursor: pointer; }
    .wou-cc-accept-add:hover { opacity: 1; }
    .wou-cc-count { display: inline-flex; align-items: center; gap: 0.25rem; white-space: nowrap; opacity: 0.85; }
    .wou-cc-count-in { width: 2.6rem; text-align: center; }
    .wou-cc-del { border: 1px solid rgba(0,0,0,0.2); border-radius: 0.2rem; width: 1.45rem; height: 1.45rem; opacity: 0.7; margin-left: 0.1rem; }
    .wou-cc-card-limits, .wou-cc-card-combat { display: flex; align-items: center; gap: 0.7rem; flex-wrap: wrap; padding-left: 1.5rem; }
    .wou-cc-card-limits label, .wou-cc-card-combat label { display: inline-flex; align-items: center; gap: 0.3rem; }
    .wou-cc-card-limits label.is-na, .wou-cc-card-combat label.is-na { display: none; }
    .wou-cc-card-limits .wou-cc-maxw { width: 3rem; text-align: center; }
    .wou-cc-card-limits .wou-cc-lbl, .wou-cc-card-combat .wou-cc-lbl { min-width: 3.75rem; }
    .wou-cc-empty { font-style: italic; opacity: 0.55; font-size: 0.88em; }
  `;
  document.head.appendChild(style);
}

/* ── select builders ── */

function typeSelect(cls, current) {
  const opts = SLOT_TYPES.map(ty => `<option value="${ty}" ${ty === current ? "selected" : ""}>${slotTypeLabel(ty)}</option>`);
  return `<select class="${cls}">${opts.join("")}</select>`;
}
function subtypeSelect(cls, type, current) {
  const enumObj = SUBTYPES_BY_TYPE[type];
  if (!enumObj) return `<select class="${cls}" disabled><option value="">—</option></select>`;
  const opts = [`<option value="" ${!current ? "selected" : ""}>${t("WITCHER.Sheet.ContainerEquip.Text.AnyKind", "Any kind")}</option>`];
  for (const [k, label] of Object.entries(enumObj)) opts.push(`<option value="${k}" ${k === current ? "selected" : ""}>${label}</option>`);
  return `<select class="${cls}">${opts.join("")}</select>`;
}
function concealSelect(cls, current) {
  const opts = [`<option value="" ${!current ? "selected" : ""}>${t("WITCHER.Sheet.ContainerEquip.Text.AnySize", "Any")}</option>`];
  for (const c of CONCEAL_CODES) opts.push(`<option value="${c}" ${c === current ? "selected" : ""}>${CONCEAL_LABELS[c]}</option>`);
  return `<select class="${cls}">${opts.join("")}</select>`;
}

/* ── general-space filter rows ── */

function growHTML(rule) {
  const r = rule || {};
  const type = r.type || "weapon";
  const applicable = typeHasConceal(type);
  const maxw = Number(r.maxWeight) || 0;
  const mode = r.mode === "deny" ? "deny" : "allow";
  const modeLabel = mode === "deny"
    ? t("WITCHER.Sheet.ContainerEquip.Text.Deny", "Deny")
    : t("WITCHER.Sheet.ContainerEquip.Text.Allow", "Allow");
  // Each condition (size, weight) carries its OWN comparator, independent of the
  // mode. Defaults to the mode's natural direction (allow ≤, deny ≥); click the
  // button to flip it. `le` = ≤, `ge` = ≥.
  const dir = mode === "deny" ? "ge" : "le";
  const cmpOf = v => (v === "le" || v === "ge") ? v : dir;
  const concealCmp = cmpOf(r.concealCmp);
  const weightCmp  = cmpOf(r.weightCmp);
  const sym = c => c === "ge" ? "≥" : "≤";
  const cmpTip = t("WITCHER.Sheet.ContainerEquip.Text.FlipComparator", "Click to flip ≤ / ≥");
  return `<div class="wou-cc-grow" data-mode="${mode}">
    <button type="button" class="wou-cc-gmode is-${mode}" title="${t("WITCHER.Sheet.ContainerEquip.Text.ToggleAllowDeny", "Toggle allow / deny")}">${modeLabel}</button>
    <i class="wou-cc-grow-icon fa-solid ${typeIcon(type, r.subtype)}"></i>
    ${typeSelect("wou-cc-gtype", type)}
    ${subtypeSelect("wou-cc-gsub", type, r.subtype || "")}
    <label class="wou-cc-glim-size ${applicable ? "" : "is-na"}"><span class="wou-cc-lbl">${t("WITCHER.Sheet.ContainerEquip.Text.Size", "size")}</span> <button type="button" class="wou-cc-cmp wou-cc-gcmp-size" data-cmp="${concealCmp}" title="${cmpTip}">${sym(concealCmp)}</button> ${concealSelect("wou-cc-gconceal", r.maxConceal || "")}</label>
    <label><span class="wou-cc-lbl">${t("WITCHER.Sheet.ContainerEquip.Text.Weight", "wt")}</span> <button type="button" class="wou-cc-cmp wou-cc-gcmp-wt" data-cmp="${weightCmp}" title="${cmpTip}">${sym(weightCmp)}</button> <input type="number" min="0" step="0.1" class="wou-cc-gmaxw" value="${maxw > 0 ? maxw : ""}" placeholder="∞" /> ${t("WITCHER.Sheet.ContainerEquip.Text.Kg", "kg")}</label>
    <span class="wou-cc-greorder">
      <button type="button" class="wou-cc-gup" title="${t("WITCHER.Sheet.ContainerEquip.Text.MoveUp", "Move up (higher priority)")}"><i class="fa-solid fa-chevron-up"></i></button>
      <button type="button" class="wou-cc-gdown" title="${t("WITCHER.Sheet.ContainerEquip.Text.MoveDown", "Move down (lower priority)")}"><i class="fa-solid fa-chevron-down"></i></button>
    </span>
    <button type="button" class="wou-cc-gdel" title="${t("WITCHER.Sheet.ContainerEquip.Text.RemoveThisType", "Remove")}"><i class="fa-solid fa-xmark"></i></button>
  </div>`;
}
function growsBodyHTML(rules) {
  return (Array.isArray(rules) && rules.length) ? rules.map(growHTML).join("") : "";
}

/* ── compartment cards ── */

/** One accepted-type chip inside a compartment card: type + subtype + remove. */
function acceptRowHTML(entry) {
  const e = entry || {};
  const type = SLOT_TYPES.includes(e.type) ? e.type : "weapon";
  return `<div class="wou-cc-accept">
      <i class="wou-cc-accept-icon fa-solid ${typeIcon(type, e.subtype)}"></i>
      ${typeSelect("wou-cc-type", type)}
      ${subtypeSelect("wou-cc-sub", type, e.subtype || "")}
      <button type="button" class="wou-cc-accept-del" title="${t("WITCHER.Sheet.ContainerEquip.Text.RemoveThisType", "Remove type")}"><i class="fa-solid fa-xmark"></i></button>
    </div>`;
}
function cardHTML(slot) {
  const s = slot || {};
  // A compartment accepts a LIST of types. Back-compat: fall back to the old
  // single {type, subtype}.
  const accepts = (Array.isArray(s.accepts) && s.accepts.length)
    ? s.accepts
    : [{ type: s.type || "weapon", subtype: s.subtype || "" }];
  const applicable = accepts.some(a => typeHasConceal(a.type));  // size cap shown if ANY accepted type has conceal
  const isWeapon   = accepts.some(a => a.type === "weapon");      // combat draw shown if ANY accepted type is a weapon
  const maxw = Number(s.maxWeight) || 0;
  const count = Math.max(1, Math.floor(Number(s.count) || 1));
  const stackMax = Math.max(1, Math.floor(Number(s.stackMax) || 1));
  return `<div class="wou-cc-card">
    <div class="wou-cc-card-head">
      <span class="wou-cc-lbl">${t("WITCHER.Sheet.ContainerEquip.Text.Accepts", "Accepts")}</span>
      <span class="wou-cc-count">${t("WITCHER.Sheet.ContainerEquip.Text.CountLabel", "count")}<input type="number" min="1" step="1" class="wou-cc-count-in" value="${count}" /></span>
      <button type="button" class="wou-cc-del" title="${t("WITCHER.Sheet.ContainerEquip.Text.RemoveThisSlotRow", "Remove compartment")}"><i class="fa-solid fa-xmark"></i></button>
    </div>
    <div class="wou-cc-accepts">
      ${accepts.map(acceptRowHTML).join("")}
      <button type="button" class="wou-cc-accept-add" title="${t("WITCHER.Sheet.ContainerEquip.Tip.AddType", "Let this slot also accept another item type")}"><i class="fa-solid fa-plus"></i> ${t("WITCHER.Sheet.ContainerEquip.Text.AddType", "add type")}</button>
    </div>
    <div class="wou-cc-card-limits">
      <span class="wou-cc-lbl">${t("WITCHER.Sheet.ContainerEquip.Text.OnlyFits", "Only fits")}</span>
      <label class="wou-cc-limit-size ${applicable ? "" : "is-na"}">${t("WITCHER.Sheet.ContainerEquip.Text.SizeUpTo", "size ≤")} ${concealSelect("wou-cc-conceal", s.maxConceal || "")}</label>
      <label>${t("WITCHER.Sheet.ContainerEquip.Text.WeightUpTo", "wt ≤")} <input type="number" min="0" step="0.1" class="wou-cc-maxw" value="${maxw > 0 ? maxw : ""}" placeholder="∞" /> ${t("WITCHER.Sheet.ContainerEquip.Text.Kg", "kg")}</label>
    </div>
    <div class="wou-cc-card-limits">
      <span class="wou-cc-lbl">${t("WITCHER.Sheet.ContainerEquip.Text.Stacks", "Stacks")}</span>
      <label title="${t("WITCHER.Sheet.ContainerEquip.Tip.SlotStacks", "Each slot in this compartment may hold a stack (up to the max per slot). Off = one item per slot; a bigger stack spreads across slots.")}"><input type="checkbox" class="wou-cc-stack" ${s.stack ? "checked" : ""} /> ${t("WITCHER.Sheet.ContainerEquip.Text.AllowStack", "allow")}</label>
      <label class="wou-cc-stackmax-l ${s.stack ? "" : "is-na"}">${t("WITCHER.Sheet.ContainerEquip.Text.MaxPerSlot", "max")} <input type="number" min="1" step="1" class="wou-cc-stackmax" value="${stackMax}" /> ${t("WITCHER.Sheet.ContainerEquip.Text.PerSlot", "/ slot")}</label>
    </div>
    <div class="wou-cc-card-combat">
      <span class="wou-cc-lbl">${t("WITCHER.Sheet.ContainerEquip.Text.InCombat", "In combat")}</span>
      <label class="wou-cc-combat-qd ${isWeapon ? "" : "is-na"}" title="${t("WITCHER.Sheet.ContainerEquip.Tip.QuickDraw", "Draw a weapon here and attack the same turn (Fast Draw: +3 initiative, −3 to hit). Weapons only.")}"><input type="checkbox" class="wou-cc-qdraw" ${s.quickDraw ? "checked" : ""} /> ${t("WITCHER.Sheet.ContainerEquip.Text.QuickDraw", "Quick-Draw")}</label>
      <label title="${t("WITCHER.Sheet.ContainerEquip.Tip.FreeUse", "Using the item in combat (draw / drink / eat / consume) costs no action.")}"><input type="checkbox" class="wou-cc-fuse" ${s.freeUse ? "checked" : ""} /> ${t("WITCHER.Sheet.ContainerEquip.Text.FreeUse", "Free-Use")}</label>
    </div>
  </div>`;
}
function cardsBodyHTML(slots) {
  return (Array.isArray(slots) && slots.length) ? slots.map(cardHTML).join("") : "";
}

Hooks.on("renderWitcherContainerSheet", (app, _html, _ctx, _opts) => {
  const root = app?.element;
  const item = app?.item;
  if (!root || !item || item.type !== "container") return;

  injectStyles();
  const form = root.querySelector("form") || root;
  if (form.querySelector(".wou-cc")) return;

  const anchor = form.querySelector(".wdm-config-view .wdm-cfg-form")
              || form.querySelector(".wdm-config-view")
              || form.querySelector(".wdm-cfg-form")
              || form;
  if (!anchor) return;

  const cfg = getContainerCfg(item);

  const block = document.createElement("div");
  block.className = "wou-cc";
  block.innerHTML = `
    <div class="wou-cc-section">
      <div class="wou-cc-section-title">${t("WITCHER.Sheet.ContainerEquip.Text.Storage", "Storage")}</div>
      <div class="wou-cc-modes">
        ${CAPACITY_MODES.map(m => `<button type="button" class="wou-cc-mode ${m === cfg.capacityMode ? "is-active" : ""}" data-mode="${m}">${capModeLabel(m)}</button>`).join("")}
      </div>
      <div class="wou-cc-modedesc">${capModeDesc(cfg.capacityMode)}</div>
    </div>

    <div class="wou-cc-section wou-cc-general">
      <div class="wou-cc-section-title">${t("WITCHER.Sheet.ContainerEquip.Text.GeneralAccepts", "General space accepts")}</div>
      <div class="wou-cc-prio-wrap">
        <div class="wou-cc-prio-rail" aria-hidden="true">
          <span class="wou-cc-prio-cap wou-cc-prio-win"><i class="fa-solid fa-caret-up"></i> ${t("WITCHER.Sheet.ContainerEquip.Text.PrioWins", "wins")}</span>
          <span class="wou-cc-prio-track"></span>
          <span class="wou-cc-prio-cap wou-cc-prio-base">${t("WITCHER.Sheet.ContainerEquip.Text.PrioBase", "base")}</span>
        </div>
        <div class="wou-cc-grows">${growsBodyHTML(cfg.generalAccept)}</div>
      </div>
      <button type="button" class="wou-cc-add wou-cc-grow-add">+ ${t("WITCHER.Sheet.ContainerEquip.Text.AddFilter", "Add filter")}</button>
      <div class="wou-cc-hint">${t("WITCHER.Sheet.ContainerEquip.Text.GeneralHierarchyHint", "Read bottom → top; the topmost matching rule wins. A rule's scope is its type/kind. On an ALLOW rule the size/weight are limits — a matching item OVER them is rejected (allow weapons up to small = bigger weapons refused). A DENY rule blocks matching items AT OR ABOVE its size/weight (deny weapons ≥ large). e.g. bottom: allow anything · top: allow weapons size ≤ small = everything, but weapons only if small. Empty = accept everything.")}</div>
    </div>

    <div class="wou-cc-section wou-cc-compartments">
      <div class="wou-cc-section-title">${t("WITCHER.Sheet.ContainerEquip.Text.Compartments", "Compartments")}</div>
      <div class="wou-cc-cards">${cardsBodyHTML(cfg.slots)}</div>
      <button type="button" class="wou-cc-add wou-cc-card-add">+ ${t("WITCHER.Sheet.ContainerEquip.Text.AddCompartment", "Add compartment")}</button>
    </div>
  `;
  anchor.appendChild(block);

  const modesWrap   = block.querySelector(".wou-cc-modes");
  const modeDesc    = block.querySelector(".wou-cc-modedesc");
  const growsWrap   = block.querySelector(".wou-cc-grows");
  const growAdd     = block.querySelector(".wou-cc-grow-add");
  const cardsWrap   = block.querySelector(".wou-cc-cards");
  const cardAdd     = block.querySelector(".wou-cc-card-add");
  const genSection  = block.querySelector(".wou-cc-general");
  const compSection = block.querySelector(".wou-cc-compartments");
  const prioRail    = block.querySelector(".wou-cc-prio-rail");

  // The priority rail is only meaningful once there's at least one rule — hide
  // it while the filter list is empty.
  const updatePrioRail = () => { if (prioRail) prioRail.hidden = growsWrap.querySelectorAll(".wou-cc-grow").length === 0; };

  const activeMode = () => modesWrap.querySelector(".wou-cc-mode.is-active")?.dataset.mode || "general";

  const applyModeVisibility = () => {
    const mode = activeMode();
    genSection.hidden  = !(mode === "general" || mode === "hybrid");
    compSection.hidden = !(mode === "slots"   || mode === "hybrid");
    modeDesc.textContent = capModeDesc(mode);
  };

  const persist = async () => {
    const capacityMode = CAPACITY_MODES.includes(activeMode()) ? activeMode() : "general";

    const generalAccept = [];
    growsWrap.querySelectorAll(".wou-cc-grow").forEach(row => {
      const gtype = String(row.querySelector(".wou-cc-gtype")?.value || "");
      const gsub  = String(row.querySelector(".wou-cc-gsub")?.value || "");
      const mc    = String(row.querySelector(".wou-cc-gconceal")?.value || "");
      // Only keep a size bound for types that carry a conceal size; otherwise a
      // stale value (left over from switching type) would make a DENY rule
      // silently never match (its ≥ size threshold can't be met).
      const maxConceal = (typeHasConceal(gtype) && CONCEAL_CODES.includes(mc)) ? mc : "";
      const wRaw  = Number(row.querySelector(".wou-cc-gmaxw")?.value);
      const maxWeight = Number.isFinite(wRaw) && wRaw > 0 ? wRaw : 0;
      const mode  = row.getAttribute("data-mode") === "deny" ? "deny" : "allow";
      const concealCmp = row.querySelector(".wou-cc-gcmp-size")?.dataset.cmp === "ge" ? "ge" : "le";
      const weightCmp  = row.querySelector(".wou-cc-gcmp-wt")?.dataset.cmp   === "ge" ? "ge" : "le";
      // DOM order = priority order (top row = index 0 = highest priority).
      if (gtype) generalAccept.push({ type: gtype, subtype: gsub, mode, maxConceal, concealCmp, maxWeight, weightCmp });
    });

    const slots = [];
    cardsWrap.querySelectorAll(".wou-cc-card").forEach(card => {
      // Each compartment accepts a LIST of {type, subtype} chips.
      const accepts = [];
      card.querySelectorAll(".wou-cc-accept").forEach(row => {
        const ty  = String(row.querySelector(".wou-cc-type")?.value || "");
        const sub = String(row.querySelector(".wou-cc-sub")?.value || "");
        if (ty) accepts.push({ type: ty, subtype: sub });
      });
      if (!accepts.length) return;   // a compartment with no types is dropped
      const cRaw = Number(card.querySelector(".wou-cc-count-in")?.value);
      const count = Number.isFinite(cRaw) && cRaw >= 1 ? Math.floor(cRaw) : 1;
      const mc = String(card.querySelector(".wou-cc-conceal")?.value || "");
      const maxConceal = CONCEAL_CODES.includes(mc) ? mc : "";
      const wRaw = Number(card.querySelector(".wou-cc-maxw")?.value);
      const maxWeight = Number.isFinite(wRaw) && wRaw > 0 ? wRaw : 0;
      const quickDraw = !!card.querySelector(".wou-cc-qdraw")?.checked;
      const freeUse   = !!card.querySelector(".wou-cc-fuse")?.checked;
      const stack     = !!card.querySelector(".wou-cc-stack")?.checked;
      const smRaw     = Number(card.querySelector(".wou-cc-stackmax")?.value);
      const stackMax  = Number.isFinite(smRaw) && smRaw >= 1 ? Math.floor(smRaw) : 1;
      // Keep type/subtype = first accept for back-compat with legacy readers.
      slots.push({ type: accepts[0].type, subtype: accepts[0].subtype, accepts, count, maxConceal, maxWeight, quickDraw, freeUse, stack, stackMax });
    });

    // weightLimitPerItem retired in favour of per-rule / per-slot weight —
    // write 0 so any stale global cap is cleared.
    try { await item.update({ [FLAG_PATH]: { capacityMode, slots, generalAccept, weightLimitPerItem: 0 } }, { render: false }); }
    catch (err) { console.warn(`${MODULE_ID} | could not persist containerCfg`, err); }
  };

  block.addEventListener("change", (ev) => ev.stopPropagation());
  block.addEventListener("input",  (ev) => ev.stopPropagation());

  applyModeVisibility();
  updatePrioRail();

  modesWrap.addEventListener("click", async (ev) => {
    const btn = ev.target.closest(".wou-cc-mode");
    if (!btn) return;
    modesWrap.querySelectorAll(".wou-cc-mode").forEach(b => b.classList.toggle("is-active", b === btn));
    applyModeVisibility();
    await persist();
  });

  const clampWeight = (input) => { const raw = Number(input.value); input.value = Number.isFinite(raw) && raw > 0 ? raw : ""; };

  // General-space filter rows.
  growAdd.addEventListener("click", async () => {
    growsWrap.insertAdjacentHTML("beforeend", growHTML({ type: "weapon", subtype: "" }));
    updatePrioRail();
    await persist();
  });
  growsWrap.addEventListener("change", async (ev) => {
    const row = ev.target.closest(".wou-cc-grow");
    if (ev.target.matches(".wou-cc-gtype") && row) {
      const newType = String(ev.target.value);
      row.querySelector(".wou-cc-gsub").outerHTML = subtypeSelect("wou-cc-gsub", newType, "");
      row.querySelector(".wou-cc-glim-size")?.classList.toggle("is-na", !typeHasConceal(newType));
      const ic = row.querySelector(".wou-cc-grow-icon"); if (ic) ic.className = `wou-cc-grow-icon fa-solid ${typeIcon(newType, "")}`;
    } else if (ev.target.matches(".wou-cc-gsub") && row) {
      const ty = row.querySelector(".wou-cc-gtype")?.value || "";
      const ic = row.querySelector(".wou-cc-grow-icon"); if (ic) ic.className = `wou-cc-grow-icon fa-solid ${typeIcon(ty, ev.target.value)}`;
    } else if (ev.target.matches(".wou-cc-gmaxw")) {
      clampWeight(ev.target);
    }
    await persist();
  });
  growsWrap.addEventListener("click", async (ev) => {
    const row = ev.target.closest(".wou-cc-grow");
    if (!row) return;
    // Remove.
    if (ev.target.closest(".wou-cc-gdel")) { row.remove(); updatePrioRail(); await persist(); return; }
    // Toggle allow / deny.
    if (ev.target.closest(".wou-cc-gmode")) {
      const next = row.getAttribute("data-mode") === "deny" ? "allow" : "deny";
      row.setAttribute("data-mode", next);
      const btn = row.querySelector(".wou-cc-gmode");
      if (btn) {
        btn.classList.toggle("is-deny",  next === "deny");
        btn.classList.toggle("is-allow", next === "allow");
        btn.textContent = next === "deny"
          ? t("WITCHER.Sheet.ContainerEquip.Text.Deny", "Deny")
          : t("WITCHER.Sheet.ContainerEquip.Text.Allow", "Allow");
      }
      // Reset the size/weight comparators to the mode's natural direction
      // (allow ≤, deny ≥). They stay independently clickable afterward.
      const def = next === "deny" ? "ge" : "le";
      row.querySelectorAll(".wou-cc-cmp").forEach(c => { c.dataset.cmp = def; c.textContent = def === "ge" ? "≥" : "≤"; });
      await persist();
      return;
    }
    // Flip an individual size/weight comparator (≤ ↔ ≥), independent of mode.
    if (ev.target.closest(".wou-cc-cmp")) {
      const c = ev.target.closest(".wou-cc-cmp");
      const nextCmp = c.dataset.cmp === "ge" ? "le" : "ge";
      c.dataset.cmp = nextCmp;
      c.textContent = nextCmp === "ge" ? "≥" : "≤";
      await persist();
      return;
    }
    // Reorder (DOM order = priority; up = higher priority / evaluated first).
    if (ev.target.closest(".wou-cc-gup")) {
      const prev = row.previousElementSibling;
      if (prev) { growsWrap.insertBefore(row, prev); await persist(); }
      return;
    }
    if (ev.target.closest(".wou-cc-gdown")) {
      const next = row.nextElementSibling;
      if (next) { growsWrap.insertBefore(next, row); await persist(); }
      return;
    }
  });

  // Recompute a compartment's size/combat applicability from its CURRENT set of
  // accepted types (size cap applies if any type conceals; Quick-Draw if any is
  // a weapon).
  const refreshCardApplicability = (card) => {
    if (!card) return;
    const types = [...card.querySelectorAll(".wou-cc-accept .wou-cc-type")].map(el => el.value);
    card.querySelector(".wou-cc-limit-size")?.classList.toggle("is-na", !types.some(typeHasConceal));
    const anyWeapon = types.includes("weapon");
    const qd = card.querySelector(".wou-cc-combat-qd");
    if (qd) { qd.classList.toggle("is-na", !anyWeapon); if (!anyWeapon) { const cb = qd.querySelector(".wou-cc-qdraw"); if (cb) cb.checked = false; } }
  };

  // Compartment cards.
  cardAdd.addEventListener("click", async () => {
    cardsWrap.insertAdjacentHTML("beforeend", cardHTML({ accepts: [{ type: "weapon", subtype: "swordsmanship" }], count: 1 }));
    await persist();
  });
  cardsWrap.addEventListener("change", async (ev) => {
    const card = ev.target.closest(".wou-cc-card");
    const acc  = ev.target.closest(".wou-cc-accept");
    if (ev.target.matches(".wou-cc-type") && acc) {
      const newType = String(ev.target.value);
      acc.querySelector(".wou-cc-sub").outerHTML = subtypeSelect("wou-cc-sub", newType, "");
      const ic = acc.querySelector(".wou-cc-accept-icon"); if (ic) ic.className = `wou-cc-accept-icon fa-solid ${typeIcon(newType, "")}`;
      refreshCardApplicability(card);
    } else if (ev.target.matches(".wou-cc-sub") && acc) {
      const ty = acc.querySelector(".wou-cc-type")?.value || "";
      const ic = acc.querySelector(".wou-cc-accept-icon"); if (ic) ic.className = `wou-cc-accept-icon fa-solid ${typeIcon(ty, ev.target.value)}`;
    } else if (ev.target.matches(".wou-cc-count-in") || ev.target.matches(".wou-cc-stackmax")) {
      const raw = Number(ev.target.value); ev.target.value = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
    } else if (ev.target.matches(".wou-cc-maxw")) {
      clampWeight(ev.target);
    } else if (ev.target.matches(".wou-cc-stack") && card) {
      card.querySelector(".wou-cc-stackmax-l")?.classList.toggle("is-na", !ev.target.checked);
    }
    await persist();
  });
  cardsWrap.addEventListener("click", async (ev) => {
    // Add an accepted-type chip to this compartment.
    const addType = ev.target.closest(".wou-cc-accept-add");
    if (addType) {
      addType.insertAdjacentHTML("beforebegin", acceptRowHTML({ type: "weapon", subtype: "" }));
      refreshCardApplicability(addType.closest(".wou-cc-card"));
      await persist();
      return;
    }
    // Remove an accepted-type chip (keep at least one).
    const delType = ev.target.closest(".wou-cc-accept-del");
    if (delType) {
      const card = delType.closest(".wou-cc-card");
      if (card.querySelectorAll(".wou-cc-accept").length > 1) delType.closest(".wou-cc-accept")?.remove();
      refreshCardApplicability(card);
      await persist();
      return;
    }
    // Remove the whole compartment.
    const del = ev.target.closest(".wou-cc-del");
    if (!del) return;
    del.closest(".wou-cc-card")?.remove();
    await persist();
  });
});
