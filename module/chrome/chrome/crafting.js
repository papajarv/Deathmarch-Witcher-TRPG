/**
 * Crafting overlay — drops from the top bar's "Crafting" tab.
 *
 * Three sub-tabs:
 *   - Alchemy     (this v1: fully built, reads real diagram items)
 *   - Crafting    (placeholder, "forthcoming")
 *   - Cooking     (placeholder, "forthcoming")
 *
 * Data model:
 *   - Formulae          = actor.items of type "diagrams" (Witcher TRPG system).
 *                         system.type ∈ "potion" | "oil" | "bomb" | "decoction" | …
 *                         system.alchemyDC, system.alchemyComponents (substance reqs),
 *                         system.craftingComponents (named ingredient list)
 *   - Components        = actor.items of type "component" with system.substanceType
 *   - Mutagens          = actor.items of type "mutagen" (substance via flag/field)
 *   - Memorized state   = a hidden clone diagram tagged
 *                         `system.memorizedFrom = <original id>` (+ learned).
 *                         The clone is a real, brewable item, so memorizing
 *                         survives deleting the original paper. Bounded by
 *                         the actor's INT stat. See memorizedFromOf / toggleMemorize.
 *   - "Book" indicator  = an original (non-clone) diagram is on the actor.
 *                         Orphan clones (paper deleted) are "memory only".
 *
 * Memorize cap = actor.system.stats.int.value.  Clicking memorize when at the
 * cap warns + blocks (the user's choice from the spec).
 *
 * Brew button is a v1 stub — points at the existing brew button on the
 * character sheet for the actual craft execution.  Phase 2 will inline it.
 */

import { getAssignedActor, VIEWER_OVERRIDE_HOOK } from "../lib/actor.js";
import { renderViewAsPicker, wireViewAsPicker } from "../lib/view-as.js";

const MODULE_ID = "witcher-ttrpg-death-march";
const PANEL_ID  = "wou-crafting";

/* Nine Witcher TRPG substances (Core p.143).  `art` = book-faithful SVG badge;
 * `color` = the badge's disc colour, reused for the node name + hover glow. */
const subArt = (key) => `systems/${MODULE_ID}/assets/icons/substances/${key}.svg`;
const SUBSTANCES = [
  { key: "vitriol",    label: "Vitriol",    art: subArt("vitriol"),    color: "#8a4f80" },
  { key: "sol",        label: "Sol",        art: subArt("sol"),        color: "#c39a4a" },
  { key: "rebis",      label: "Rebis",      art: subArt("rebis"),      color: "#c25a44" },
  { key: "caelum",     label: "Caelum",     art: subArt("caelum"),     color: "#9aae54" },
  { key: "aether",     label: "Aether",     art: subArt("aether"),     color: "#7a9e9c" },
  { key: "fulgur",     label: "Fulgur",     art: subArt("fulgur"),     color: "#9a4540" },
  { key: "quebrith",   label: "Quebrith",   art: subArt("quebrith"),   color: "#b0a544" },
  { key: "hydragenum", label: "Hydragenum", art: subArt("hydragenum"), color: "#5e72a4" },
  { key: "vermilion",  label: "Vermilion",  art: subArt("vermilion"),  color: "#5f8a62" }
];

/* Static node placement.  Two rings on the (square) hex-wrap: inner ring
 * at radius 26%, outer ring at radius 35% (~50% farther from centre).
 * Sol, Rebis, Fulgur, Quebrith are pushed to the outer ring; the rest
 * stay inner.  Outer picks chosen on sides where the labels don't clip
 * the wrap edge.  Anchored — percentages never change when the wheel
 * resizes; only sizes scale (via cqw in CSS). */
const NODE_POSITIONS = {
  vitriol:    { left: 50, top: 24 },   /* angle  -90°  inner */
  sol:        { left: 72, top: 23 },   /* angle  -50°  OUTER */
  rebis:      { left: 84, top: 44 },   /* angle  -10°  OUTER */
  caelum:     { left: 73, top: 63 },   /* angle   30°  inner */
  aether:     { left: 59, top: 74 },   /* angle   70°  inner */
  fulgur:     { left: 38, top: 83 },   /* angle  110°  OUTER */
  quebrith:   { left: 20, top: 68 },   /* angle  150°  OUTER */
  hydragenum: { left: 24, top: 46 },   /* angle  190°  inner */
  vermilion:  { left: 28, top: 23 }    /* angle  230°  OUTER */
};

const FORMULA_GROUPS = [
  { key: "potion",    label: "Potions",    icon: "fa-flask",             match: (t) => t === "potion" },
  { key: "oil",       label: "Oils",       icon: "fa-droplet",           match: (t) => t === "oil" },
  { key: "bomb",      label: "Bombs",      icon: "fa-bomb",              match: (t) => t === "bomb" },
  { key: "decoction", label: "Decoctions", icon: "fa-vial-circle-check", match: (t) => t === "decoction" },
  { key: "other",     label: "Other",      icon: "fa-scroll",            match: (t) => !["potion","oil","bomb","decoction"].includes(t) }
];

const CRAFTING_GROUPS = [
  { key: "weapon",            label: "Weapons",           icon: "fa-gavel",                match: (t) => t === "weapon" },
  { key: "elderfolk-weapon",  label: "Elder Weapons",     icon: "fa-wand-sparkles",        match: (t) => t === "elderfolk-weapon" },
  { key: "armor",             label: "Armor",             icon: "fa-shield-halved",        match: (t) => t === "armor" },
  { key: "elderfolk-armor",   label: "Elder Armor",       icon: "fa-shield",               match: (t) => t === "elderfolk-armor" },
  { key: "armor-enhancement", label: "Enhancements",      icon: "fa-gem",                  match: (t) => t === "armor-enhancement" },
  { key: "ammunition",        label: "Ammunition",        icon: "fa-circle-dot",           match: (t) => t === "ammunition" },
  { key: "traps",             label: "Traps",             icon: "fa-triangle-exclamation", match: (t) => t === "traps" },
  { key: "ingredients",       label: "Ingredients",       icon: "fa-mortar-pestle",        match: (t) => t === "ingredients" },
  { key: "other",             label: "Other",             icon: "fa-scroll",
    match: (t) => !["weapon","elderfolk-weapon","armor","elderfolk-armor","armor-enhancement","ammunition","traps","ingredients"].includes(t) },
];

let panelEl = null;
let hooksWired = false;

/* Per-session UI state (not persisted) */
let activeView = "alchemy";              // "alchemy" | "crafting" | "cooking"
let activeFormulaId = null;              // id of the diagram in the formula list
let activeSubstance = null;             // selected substance node on the compass
let activeBaseId = null;                 // id of the selected base item
let selectedIngredients = new Map();     // itemId -> qty selected for the brew
let activeCraftingDiagramId = null;      // id of the selected crafting diagram
/* RAW: crafting without the proper tools is at −4 (we model it as +4 to the
 * craft DC). The tool depends on the job: Alchemy set for formulae, a Forge for
 * flagged metalwork, a Crafting kit otherwise — AUTO-DETECTED from the actor's
 * inventory. Read-only: you either carry the tool or you take the penalty. */
const TOOL_PENALTY = 4;

/* Human label for the required tool. */
function craftToolLabel(diagram) {
  if (diagram?.system?.isFormulae)    return "Alchemy set";
  if (diagram?.system?.requiresForge) return "Forge";
  return "Crafting tools";
}
/* The inventory ITEM name that satisfies the requirement. */
function craftToolItemName(diagram) {
  if (diagram?.system?.isFormulae)    return "Alchemy Set";
  if (diagram?.system?.requiresForge) return "Tinker's Forge";
  return "Crafting Tools";
}
function actorHasToolItem(name) {
  const a = getActor();
  return !!a?.items?.some(i => i?.name === name);
}
function hasToolsFor(diagram) { return actorHasToolItem(craftToolItemName(diagram)); }
function craftToolPenalty(diagram) { return hasToolsFor(diagram) ? 0 : TOOL_PENALTY; }

/* The tools requirement + a read-only, inventory-driven status indicator. */
function toolsToggleHTML(diagram) {
  const label    = craftToolLabel(diagram);
  const itemName = craftToolItemName(diagram);
  const has      = hasToolsFor(diagram);
  return `<div class="wou-crf-tools-block">
    <div class="wou-crf-tools-req">Required Tools: <strong>${label}</strong></div>
    <div class="wou-crf-tools-status ${has ? "is-on" : "is-off"}"
         title="Auto-detected from your inventory (${itemName}). Carry it to avoid the +${TOOL_PENALTY} DC penalty.">
      ${has
        ? `<i class="fa-solid fa-screwdriver-wrench"></i> ${itemName} in pack`
        : `<i class="fa-solid fa-ban"></i> No ${itemName} · +${TOOL_PENALTY} DC`}
    </div>
  </div>`;
}

/* Chrome panels the overlay shrinks/expands around — same set inventory uses */
const CHROME_SELECTORS = ["#wou-top-bar", "#wou-dock", "#scene-controls", "#sidebar"];
let _chromeResizeObs   = null;
let _chromeMutationObs = null;

/* =========================================================================
   PUBLIC API
   ========================================================================= */

export function injectCraftingPanel() {
  if (document.getElementById(PANEL_ID)) return;
  const el = document.createElement("main");
  el.id = PANEL_ID;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "Crafting");
  document.body.appendChild(el);
  panelEl = el;

  if (!hooksWired) {
    /* Rebuild on actor + item mutations that affect any of the surfaces.
     * Hook filters use the live-resolved actor (override-aware) so changes
     * on whichever PC the GM is impersonating still trigger re-renders. */
    Hooks.on("updateUser",  (u) => { if (u.id === game.user.id)            rerenderIfOpen(); });
    Hooks.on("updateActor", (a) => { if (a.id === getActor()?.id)          rerenderIfOpen(); });
    Hooks.on("createItem",  (i) => { if (i.parent?.id === getActor()?.id)  rerenderIfOpen(); });
    Hooks.on("updateItem",  (i) => { if (i.parent?.id === getActor()?.id)  rerenderIfOpen(); });
    Hooks.on("deleteItem",  (i) => { if (i.parent?.id === getActor()?.id)  rerenderIfOpen(); });
    /* GM picked a different "view as" target in another tab — re-render
     * to swap the formulae list, memorized state, and INT cap. */
    Hooks.on(VIEWER_OVERRIDE_HOOK, () => rerenderIfOpen());
    /* Re-fit when the viewport resizes or any chrome panel opens/closes */
    window.addEventListener("resize", positionBounds, { passive: true });
    wireChromeObservers();
    hooksWired = true;
  }

  /* GM "View as" picker — change + clear-X delegated by the shared helper. */
  wireViewAsPicker(el, () => rerenderIfOpen());
}

export async function toggleCrafting() {
  if (!panelEl) injectCraftingPanel();
  const willOpen = !panelEl.classList.contains("is-open");
  await setCraftingOpen(willOpen);
}

export async function setCraftingOpen(open) {
  if (!panelEl) injectCraftingPanel();
  if (open) {
    /* One drop-down panel open at a time — close siblings if they're open */
    if (document.body.classList.contains("wou-inventory-open")) {
      import("./inventory.js").then(m => m.setInventoryOpen(false)).catch(() => {});
    }
    if (document.body.classList.contains("wou-journal-open")) {
      import("./journal.js").then(m => m.setJournalOpen(false)).catch(() => {});
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
    await render();
    panelEl.classList.add("is-open");
    document.body.classList.add("wou-crafting-open");
    syncTopbarTab(true);
  } else {
    panelEl.classList.remove("is-open");
    document.body.classList.remove("wou-crafting-open");
    syncTopbarTab(false);
  }
}

export function isCraftingOpen() {
  return !!panelEl?.classList.contains("is-open");
}

function rerenderIfOpen() {
  if (isCraftingOpen()) render();
}

function syncTopbarTab(on) {
  const tab = document.querySelector('#wou-top-bar [data-tab="crafting"]');
  tab?.classList.toggle("is-active", on);
}

/* =========================================================================
   POSITIONING — same shrink/expand behaviour as inventory.js / journal.js
   ========================================================================= */

/**
 * Re-fit the overlay between the four chrome panels.  Reads the open state
 * from body classes (the source of truth for collapsibles) rather than the
 * panels' actual sizes, because mid-transition the panels still occupy their
 * pre-collapse bounding rect for ~200ms and would jitter the overlay.
 *
 * Publishes `--crf-close-x` so the chevron-up close button can be pinned
 * directly under the topbar's Crafting tab (mirror of `--inv-close-x`).
 */
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

  const top    = (topbarOpen && topbar)  ? Math.max(0, topbar.getBoundingClientRect().bottom) : 0;
  const bottom =  dock                   ? Math.max(0, H - dock.getBoundingClientRect().top)  : 0;
  const left   = (leftOpen   && leftbar) ? Math.max(0, leftbar.getBoundingClientRect().right) : 0;
  const right  = (rightOpen  && sidebar) ? Math.max(0, W - sidebar.getBoundingClientRect().left) : 0;

  panelEl.style.top    = `${top}px`;
  panelEl.style.bottom = `${bottom}px`;
  panelEl.style.left   = `${left}px`;
  panelEl.style.right  = `${right}px`;

  /* Pin the close-X to the centre of the topbar Crafting tab. */
  const tab = document.querySelector('#wou-top-bar [data-tab="crafting"]');
  if (tab) {
    const tabRect = tab.getBoundingClientRect();
    const tabCenterX = tabRect.left + tabRect.width / 2;
    panelEl.style.setProperty("--crf-close-x", `${tabCenterX - left}px`);
  }
}

/**
 * Observe each chrome panel so the overlay re-fits the moment a bar
 * collapses, expands, or resizes.
 *   - ResizeObserver: width/height changes (sidebar drag, font load reflow)
 *   - MutationObserver on class/style: catches collapsible state flips
 *     (.is-open / .is-peeking) that transition via transform and don't fire
 *     ResizeObserver.
 *   - transitionend / animationend: settles the final position after the
 *     collapse animation finishes.
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
    /* Body class watch — global collapsible state flags drive the re-fit. */
    _chromeMutationObs.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  }

  for (const sel of CHROME_SELECTORS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    el.addEventListener("transitionend", reposition);
    el.addEventListener("animationend",  reposition);
  }
}

/* =========================================================================
   DATA HELPERS
   ========================================================================= */

function getActor() {
  /* Honor the shared GM "view as" override so the crafting tab's
   * formulae list, memorized clones, INT-gated memory cap, and write
   * paths (memorize / forget / craft) all target whichever PC the GM
   * has selected.  Players fall through to their own character. */
  return getAssignedActor();
}

function getInt() {
  const actor = getActor();
  return Number(actor?.system?.stats?.int?.value) || 0;
}

/* Memorization model — clone-based so it survives deleting the paper.
 *
 * Memorizing a diagram makes a hidden duplicate tagged
 * `system.memorizedFrom = <original id>` and `system.learned = true`.
 * The clone is a real, brewable diagram, so it persists after the
 * original is deleted (it becomes an "orphan" — memory-only, no book).
 * Inventory hides items with a non-empty `system.memorizedFrom`.
 *
 * Legacy tolerance: an older build flipped `system.learned` on the
 * original in place (no clone). We still treat that as memorized and
 * let "forget" clear it, so worlds touched by that build keep working. */
function memorizedFromOf(item) {
  const src = item?.system?.memorizedFrom;
  return src ? String(src) : null;
}

/** The clone (if any) that memorizes a given original diagram id. */
function findMemorizedCopy(diagramId) {
  const actor = getActor();
  if (!actor || !diagramId) return null;
  return [...actor.items].find(
    i => i.type === "diagrams" && memorizedFromOf(i) === String(diagramId)
  ) ?? null;
}

/** One item per memorized recipe — clones first, then legacy in-place
 *  learned originals that don't already have a clone. Drives the memory
 *  bar and the INT cap count. */
function getMemorizedList() {
  const actor = getActor();
  if (!actor) return [];
  const diagrams = [...actor.items].filter(i => i.type === "diagrams");
  const out = [];
  const clonedSources = new Set();
  for (const i of diagrams) {
    const src = memorizedFromOf(i);
    if (src) { out.push(i); clonedSources.add(src); }
  }
  for (const i of diagrams) {
    if (memorizedFromOf(i)) continue;
    if (i.system?.learned && !clonedSources.has(i.id)) out.push(i);
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** Recipe keys (original id for clones/legacy) that are held in memory. */
function getMemorizedIds() {
  const ids = new Set();
  for (const i of getMemorizedList()) ids.add(memorizedFromOf(i) || i.id);
  return ids;
}

/** Collapse a diagram pool to one row per recipe: every original, plus any
 *  orphan clones whose source original is gone (memory-only recipes). */
function dedupeMemorizedRows(items) {
  const originals = items.filter(i => !memorizedFromOf(i));
  const originalIds = new Set(originals.map(o => o.id));
  const seenOrphan = new Set();
  const orphans = [];
  for (const i of items) {
    const src = memorizedFromOf(i);
    if (!src || originalIds.has(src) || seenOrphan.has(src)) continue;
    seenOrphan.add(src);
    orphans.push(i);
  }
  return [...originals, ...orphans].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** All formula diagrams available to the brewing UI — true formulae plus
 *  bomb-type diagrams (crafted with an Alchemy roll despite being diagrams). */
function getFormulae() {
  const actor = getActor();
  if (!actor) return [];
  const pool = [...actor.items].filter(
    i => i.type === "diagrams" && (i.system?.isFormulae === true || i.system?.type === "bomb")
  );
  return dedupeMemorizedRows(pool);
}

/** All crafting diagrams (non-formulae, non-bomb) available on the actor. */
function getCraftingDiagrams() {
  const actor = getActor();
  if (!actor) return [];
  const pool = [...actor.items].filter(
    i => i.type === "diagrams" && !i.system?.isFormulae && i.system?.type !== "bomb"
  );
  return dedupeMemorizedRows(pool);
}

/** Which skill to roll for a crafting diagram. */
function craftingSkillFor(diagram) {
  return diagram.system?.type === "traps" ? "trapcraft" : "crafting";
}

/** Readiness check for crafting: only named components, no base or substances. */
function craftReadinessCrafting(diagram) {
  if (!diagram) return { ready: false, reason: "no diagram selected" };
  for (const c of resolveCraftingComponents(diagram)) {
    if (!c.met) return { ready: false, reason: `missing ${c.name}` };
  }
  return { ready: true, reason: "" };
}

/** Synchronously resolve the output item for a diagram (preview thumbnail).
 *  For alchemy formulae, prefers outputNormal (world pack, sync-accessible)
 *  over associatedItem.uuid which may point to a module compendium pack. */
function resolveOutputItem(diagram) {
  const candidates = [];
  if (diagram.system?.isFormulae) {
    const n = diagram.flags?.["witcher-alchemy-craft"]?.outputNormal;
    if (n) candidates.push(n);
  }
  const assoc = diagram.system?.associatedItem?.uuid;
  if (assoc) candidates.push(assoc);
  for (const uuid of candidates) {
    try { const item = fromUuidSync?.(uuid); if (item) return item; } catch {}
  }
  return null;
}

/** Small thumbnail + name for the output item, or "" if unresolvable. */
function renderOutputPreview(diagram) {
  const item = resolveOutputItem(diagram);
  if (!item) return "";
  const img = item.img ?? "";
  if (!img || img.includes("mystery-man")) return "";
  return `
    <div class="wou-crf-output-preview">
      <img src="${escapeAttr(img)}" alt="${escapeAttr(item.name ?? "")}" class="wou-crf-output-img" />
      <span class="wou-crf-output-name">${escapeText(item.name ?? "")}</span>
    </div>
  `;
}

/** Sub-type of a diagram (lowercased).  Falls back to "other" so non-canonical
 *  types still get rendered. */
function formulaSubtype(f) {
  return String(f.system?.type ?? "").toLowerCase();
}

/** Substance requirement object on a diagram, normalized to lower-cased keys. */
function formulaSubstances(f) {
  const raw = f?.system?.alchemyComponents ?? {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const n = Number(v) || 0;
    if (n > 0) out[String(k).toLowerCase()] = n;
  }
  return out;
}

/** Compendium-style substance type for a component / mutagen item, lower-case. */
function ingredientSubstance(item) {
  if (!item) return "";
  /* Components store the substance type in a system field */
  if (item.type === "component") {
    return String(item.system?.substanceType ?? "").toLowerCase();
  }
  /* Mutagens — alchemy-craft module stores substance as a flag */
  if (item.type === "mutagen") {
    const flagSub = item.flags?.["witcher-alchemy-craft"]?.substance
                 ?? item.system?.substance
                 ?? "";
    return String(flagSub).toLowerCase();
  }
  return "";
}

/** Potency value for a component or mutagen.  Same convention as the
 *  witcher-alchemy-craft module (flag `potency`, may be 0). */
function ingredientPotency(item) {
  return Number(item?.flags?.["witcher-alchemy-craft"]?.potency) || 0;
}

/** Inventory items that contribute the given substance.  Potency is NOT a
 *  gate here — it belongs to the deferred potency system (see craftReadiness),
 *  and new-system components carry their substance on `system.substanceType`
 *  rather than a `witcher-alchemy-craft` potency flag.  Requiring potency > 0
 *  hid every substance component from the formula picker. */
function ingredientsForSubstance(substance) {
  const actor = getActor();
  if (!actor || !substance) return [];
  return [...actor.items]
    .filter(i => (i.type === "component" || i.type === "mutagen")
              && ingredientSubstance(i) === substance)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/* =========================================================================
   CRAFT-STATE HELPERS — mirror alchemy-craft's dialog math, so the chrome
   tab gives the same feedback density without delegating to its popup.
   Prefer the alchemy-craft module's exported helpers when present; fall back
   to local reimplementations so the UI degrades gracefully if alchemy-craft
   isn't active.
   ========================================================================= */

function isBaseOfType(item, type) {
  if (!item) return false;
  const ext = game?.witcherAlchemy?.isBaseOfType;
  if (typeof ext === "function") return ext(item, type);
  const f = item.flags?.["witcher-alchemy-craft"] ?? {};
  if (f.baseType === type) return true;
  if (type === "oil"    && f.oilBaseMod    !== undefined) return true;
  if (type === "potion" && f.potionBaseMod !== undefined) return true;
  return false;
}

function baseModFor(item) {
  if (!item) return 0;
  const ext = game?.witcherAlchemy?.getBaseMod;
  if (typeof ext === "function") return Number(ext(item)) || 0;
  const f = item.flags?.["witcher-alchemy-craft"] ?? {};
  const m = Number(f.baseMod);
  if (Number.isFinite(m)) return m;
  return Number(f.oilBaseMod ?? f.potionBaseMod ?? 0) || 0;
}

/* Charges live on the witcher-food-and-drink module's flag namespace.
 * Delegate to alchemy-craft's canonical reader so the panel and the
 * craft engine can't disagree about what "has charges" means. Local
 * fallback only fires if alchemy-craft isn't loaded. */
function getBaseChargeInfo(b) {
  const ext = game?.witcherAlchemy?.getBaseChargeInfo;
  if (typeof ext === "function") return ext(b);
  const primary = b?.flags?.["witcher-food-and-drink"]?.charges;
  if (primary && Number.isFinite(Number(primary.max)) && Number(primary.max) > 0) {
    return { current: Number(primary.current ?? 0), max: Number(primary.max) };
  }
  const legacy = b?.flags?.["witcher-item-charges"];
  if (legacy && Number.isFinite(Number(legacy.max)) && Number(legacy.max) > 0) {
    return { current: Number(legacy.current ?? 0), max: Number(legacy.max) };
  }
  return null;
}

/** Inventory bases legal for the given formula.
 *
 * Delegates to alchemy-craft's canonical picker
 * (`game.witcherAlchemy.getAvailableBases`) so this panel and the dialog
 * always agree on what qualifies as a base. The local fallback only fires
 * if alchemy-craft isn't installed/active, so we degrade gracefully without
 * carrying a second filter that can drift out of sync (we already had a
 * `system.type !== "food-drink"` divergence here that silently hid every
 * component/alchemical base the GM had configured). */
function getAvailableBases(formula) {
  const actor = getActor();
  if (!actor || !formula) return [];

  const canonical = game?.witcherAlchemy?.getAvailableBases;
  if (typeof canonical === "function") {
    try { return canonical(actor, formula) ?? []; }
    catch (err) { console.warn("[witcher-ttrpg-death-march] alchemy-craft picker threw, falling back:", err); }
  }

  /* Fallback: mirror the canonical filter so the panel still works
   * without alchemy-craft. Keep this in lockstep with craft.mjs's
   * getAvailableBases. */
  const type = formulaSubtype(formula);
  if (type === "oil") {
    return [...actor.items]
      .filter(i =>
        isBaseOfType(i, "oil") ||
        ((i.name.toLowerCase().includes("dog tallow") || i.name.toLowerCase().includes("bear fat"))
          && i.type === "component")
      )
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }
  if (type === "bomb") {
    return [...actor.items]
      .filter(i => isBaseOfType(i, "bomb"))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }
  return [...actor.items]
    .filter(i => {
      if (!isBaseOfType(i, "potion")) return false;
      const ci = getBaseChargeInfo(i);
      if (!ci) return true;          // no charge tracking → always available
      return ci.current / ci.max >= 0.5;
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** Diagram's named crafting components with availability resolved against
 *  the actor's inventory, deducting qty already selected as ingredients.
 *  Returns [{ name, needed, available, met }]. */
function resolveCraftingComponents(diagram) {
  if (!diagram) return [];
  const actor = getActor();
  if (!actor) return [];
  const reqs = (diagram.system?.craftingComponents ?? []).filter(c => Number(c.quantity) > 0);
  return reqs.map(comp => {
    const matches = [...actor.items].filter(i => {
      if (comp.uuid) {
        const src = i._stats?.compendiumSource ?? i.flags?.core?.sourceId ?? "";
        if (src === comp.uuid) return true;
      }
      return i.name.toLowerCase() === (comp.name || "").toLowerCase();
    });
    let available = 0;
    for (const m of matches) {
      const invQty    = Number(m.system?.quantity) || 1;
      const usedAsIng = selectedIngredients.get(m.id) || 0;
      available += Math.max(0, invQty - usedAsIng);
    }
    const needed = Number(comp.quantity);
    return { name: comp.name || "Unknown", needed, available, met: available >= needed };
  });
}

/** How many units of `item` are reserved by the diagram's named crafting
 *  components, AFTER deducting what's already selected as an ingredient. */
function reservedAsComponent(item, diagram) {
  if (!item || !diagram) return 0;
  const reqs = (diagram.system?.craftingComponents ?? []).filter(c => Number(c.quantity) > 0);
  if (!reqs.length) return 0;
  const actor = getActor();
  if (!actor) return 0;
  let reserved = 0;
  for (const comp of reqs) {
    let remaining = Number(comp.quantity);
    const matches = [...actor.items].filter(i => {
      if (comp.uuid) {
        const src = i._stats?.compendiumSource ?? i.flags?.core?.sourceId ?? "";
        if (src === comp.uuid) return true;
      }
      return i.name.toLowerCase() === (comp.name || "").toLowerCase();
    });
    for (const m of matches) {
      const invQty    = Number(m.system?.quantity) || 1;
      const usedAsIng = selectedIngredients.get(m.id) || 0;
      const avail     = Math.max(0, invQty - usedAsIng);
      const take      = Math.min(avail, remaining);
      if (m.id === item.id) reserved += take;
      remaining -= take;
      if (remaining <= 0) break;
    }
  }
  return reserved;
}

/** Available qty for `item` given the current base + component reservations. */
function availQty(item, diagram) {
  if (!item) return 0;
  const rawQty = Number(item.system?.quantity) || (item.type === "mutagen" ? 1 : 0);
  const baseReserve = activeBaseId === item.id ? 1 : 0;
  const compReserve = reservedAsComponent(item, diagram);
  return Math.max(0, rawQty - baseReserve - compReserve);
}

function substanceUsed(sub) {
  const actor = getActor();
  if (!actor || !sub) return 0;
  let n = 0;
  for (const [id, qty] of selectedIngredients) {
    const it = actor.items.get(id);
    if (!it) continue;
    if (ingredientSubstance(it) === sub) n += qty;
  }
  return n;
}

function totalPotency() {
  const actor = getActor();
  if (!actor) return 0;
  let t = 0;
  for (const [id, qty] of selectedIngredients) {
    const it = actor.items.get(id);
    if (!it) continue;
    t += ingredientPotency(it) * qty;
  }
  return t;
}

function predictedQuality(diagram) {
  if (!diagram) return null;
  const ext = game?.witcherAlchemy?.qualityFromPotency;
  if (typeof ext === "function") {
    const flags = game?.witcherAlchemy?.getDiagramFlags?.(diagram)
               ?? diagram.flags?.["witcher-alchemy-craft"] ?? {};
    return ext(totalPotency(), flags);
  }
  const f = diagram.flags?.["witcher-alchemy-craft"] ?? {};
  const pn = Number(f.potencyNormal) || 0;
  const pe = Number(f.potencyEnhanced ?? f.potencyEnchanted) || 0;
  const ps = Number(f.potencySuperior) || 0;
  const t = totalPotency();
  if (ps > 0 && t >= ps) return "Superior";
  if (pe > 0 && t >= pe) return "Enhanced";
  if (pn > 0 && t >= pn) return "Normal";
  return null;
}

function qualityColor(q) {
  const ext = game?.witcherAlchemy?.qualityColour;
  if (typeof ext === "function") return ext(q);
  return q === "Superior" ? "#7ec8e3"
       : q === "Enhanced" ? "#d4af37"
       : q === "Normal"   ? "#a8d5a2"
       : "#c0392b";
}

function isMemorizedDiagram(diagram) {
  if (!diagram) return false;
  if (memorizedFromOf(diagram)) return true;       // the row IS a clone
  if (diagram.system?.learned) return true;         // legacy in-place flag
  return !!findMemorizedCopy(diagram.id);           // original has a clone
}

/** A memory-only row (orphan clone): memorized but no physical book. */
function isMemoryOnly(diagram) {
  return !!memorizedFromOf(diagram);
}

/** Effective DC for the displayed formula + currently-selected base.
 *
 *  Delegates to alchemy-craft's canonical computeEffectiveDC so the panel
 *  cannot show a number different from what the actual craft uses. We
 *  pass `memorized` explicitly because the overhaul-ui treats memorization
 *  as a per-actor flag (separate from alchemy-craft's diagram flag), and
 *  the canonical helper accepts an override for exactly this case.
 *
 *  Local fallback only fires if alchemy-craft isn't loaded. Keep it in
 *  lockstep with craft.mjs's computeEffectiveDC. */
function effectiveDC(diagram) {
  if (!diagram) return 0;
  const actor    = getActor();
  const base     = activeBaseId ? actor?.items?.get(activeBaseId) : null;
  const memorized = isMemorizedDiagram(diagram);

  const canonical = game?.witcherAlchemy?.computeEffectiveDC;
  if (typeof canonical === "function") {
    try { return Number(canonical(diagram, base, { memorized })) || 0; }
    catch (err) { console.warn("[witcher-ttrpg-death-march] alchemy-craft computeEffectiveDC threw, falling back:", err); }
  }
  const raw    = Number(diagram.system?.alchemyDC) || Number(diagram.system?.craftingDC) || 0;
  const baseDC = memorized ? raw : raw - 2;
  return baseDC + (base ? baseModFor(base) : 0);
}

/** Signed "+2" / "-6" display string for a base mod. Delegates to alchemy-craft
 *  so the panel can't drift from the dialog's sign convention. */
function formatBaseMod(modOrItem) {
  const ext = game?.witcherAlchemy?.formatBaseModForDisplay;
  if (typeof ext === "function") {
    try { return String(ext(modOrItem)); }
    catch { /* fall through */ }
  }
  const n = typeof modOrItem === "number" ? modOrItem : (baseModFor(modOrItem) || 0);
  return n > 0 ? `+${n}` : String(n);
}

/** Readiness summary for the Prepare button.  Returns { ready, reason }.
 *  RAW alchemy: every formula (potion/oil/decoction/bomb) is crafted like a
 *  diagram — roll Alchemy vs its DC and consume its named components. The
 *  base / substance / potency gating belongs to the deferred potency system
 *  and no longer blocks brewing. */
function craftReadiness(diagram) {
  if (!diagram) return { ready: false, reason: "no formula selected" };
  for (const c of resolveCraftingComponents(diagram)) {
    if (!c.met) return { ready: false, reason: `missing ${c.name}` };
  }
  return { ready: true, reason: "" };
}

/* =========================================================================
   RENDER
   ========================================================================= */

async function render() {
  if (!panelEl) return;

  /* Alchemy: ensure activeFormulaId points to a real diagram. */
  const formulae = getFormulae();
  if (!formulae.length) {
    activeFormulaId = null;
  } else if (!formulae.find(f => f.id === activeFormulaId)) {
    activeFormulaId = formulae[0].id;
  }
  const active = formulae.find(f => f.id === activeFormulaId) ?? null;

  /* If no substance is selected (or selected isn't required by the active
   * formula), default to the first required substance, or the first overall. */
  if (active) {
    const subs = formulaSubstances(active);
    const requiredSubs = Object.keys(subs);
    if (!activeSubstance || (requiredSubs.length && !requiredSubs.includes(activeSubstance))) {
      activeSubstance = requiredSubs[0] ?? SUBSTANCES[0].key;
    }
  } else {
    activeSubstance = activeSubstance ?? SUBSTANCES[0].key;
  }

  /* Crafting: ensure activeCraftingDiagramId points to a real diagram. */
  const craftingDiagrams = getCraftingDiagrams();
  if (!craftingDiagrams.find(d => d.id === activeCraftingDiagramId)) {
    activeCraftingDiagramId = craftingDiagrams[0]?.id ?? null;
  }
  const craftingActive = craftingDiagrams.find(d => d.id === activeCraftingDiagramId) ?? null;

  const savedScroll = panelEl.querySelector(".wou-crf-formulae-list")?.scrollTop ?? 0;

  panelEl.innerHTML = renderShellHTML(active, craftingActive);

  const listEl = panelEl.querySelector(".wou-crf-formulae-list");
  if (listEl && savedScroll) listEl.scrollTop = savedScroll;

  wireShell();
  fitIngredientNames();
}

function renderShellHTML(active, craftingActive) {
  const actor = getActor();
  const memCount = getMemorizedIds().size;
  const intStat  = getInt();

  return `
    <button class="wou-crf-close" type="button" aria-label="Close" title="Collapse">
      <i class="fa-solid fa-chevron-up"></i>
    </button>

    <header class="wou-crf-head">
      <nav class="wou-crf-maintabs">
        ${renderMaintab("alchemy",  "fa-flask",    "Alchemy")}
        ${renderMaintab("crafting", "fa-hammer",   "Crafting")}
        ${renderMaintab("cooking",  "fa-utensils", "Cooking")}
      </nav>
      ${game.user?.isGM ? renderViewAsPicker() : ""}
    </header>

    <!-- Memory strip — slot count gated by INT.  Shows the formulae the
         player has chosen to keep "in their head". -->
    ${renderMemoryBar(memCount, intStat)}

    <div class="wou-crf-body">
      ${activeView === "alchemy"
        ? renderAlchemyView(active)
        : activeView === "crafting"
        ? renderCraftingView(craftingActive)
        : renderPlaceholderView(activeView)}
    </div>
  `;
}

function renderMaintab(key, icon, label) {
  const on = activeView === key;
  return `
    <button class="wou-crf-maintab${on ? " is-active" : ""}" type="button"
            data-maintab="${key}">
      <i class="fa-solid ${icon}"></i>${escapeText(label)}
    </button>
  `;
}

function viewTitle(view) {
  return view === "alchemy" ? "Alchemy"
       : view === "crafting" ? "Crafting"
       : view === "cooking" ? "Cooking"
       : "Crafting";
}

/* ---- Memory bar ---- */

function renderMemoryBar(used, intStat) {
  const cap = intStat;
  /* One slot per memorized recipe (clone or legacy in-place learned).
   * Clicking a filled slot forgets it (deletes the clone / clears the flag). */
  const memorized = getMemorizedList();

  const slots = [];
  for (let i = 0; i < Math.max(cap, memorized.length); i++) {
    const m = memorized[i];
    if (m) {
      slots.push(`
        <button class="wou-crf-mem-slot" type="button" data-forget="${m.id}"
                title="${escapeAttr(m.name)} — click to forget">
          <i class="fa-solid ${iconForType(formulaSubtype(m))} ms-icon"></i>
          ${escapeText(m.name.replace(/^Formula:\s*/i, ""))}
          <span class="ms-x"><i class="fa-solid fa-xmark"></i></span>
        </button>
      `);
    } else if (i < cap) {
      slots.push(`
        <div class="wou-crf-mem-slot empty" title="Empty memory slot">
          <i class="fa-solid fa-plus ms-icon"></i>
          empty slot
        </div>
      `);
    }
  }

  return `
    <div class="wou-crf-memory-bar">
      <div class="wou-crf-mem-label">
        <div class="label"><i class="fa-solid fa-brain"></i>Memory</div>
        <div class="count">
          <span class="used">${used}</span> / <span class="total">${cap}</span>
          &nbsp;<span class="int">INT ${cap}</span>
        </div>
      </div>
      <div class="wou-crf-mem-slots">${slots.join("")}</div>
      <div class="wou-crf-mem-help">
        <i class="fa-solid fa-book" style="color: var(--wdm-amber-hi); margin-right: 4px;"></i>book +
        <i class="fa-solid fa-brain" style="color: var(--wdm-amber-bright); margin: 0 4px 0 6px;"></i>memorized
        can both be true.<br/>
        Book = brew with the manual open <span class="key">(DC −2)</span>. Memorized = brew from head, no book needed.
      </div>
    </div>
  `;
}

function iconForType(t) {
  const g = FORMULA_GROUPS.find(x => x.key === t);
  return g?.icon ?? "fa-scroll";
}

/* ---- Alchemy view ---- */

function renderAlchemyView(active) {
  const formulae = getFormulae();
  if (!formulae.length) {
    return `<div class="wou-crf-empty">— no formulae in your inventory —</div>`;
  }
  return `
    <div class="wou-crf-view is-active">
      <section class="wou-crf-formulae">
        <div class="wou-crf-formulae-header">
          <i class="fa-solid fa-scroll"></i>Formulae
        </div>
        <div class="wou-crf-formulae-list">
          ${renderFormulaeList(formulae)}
        </div>
        ${renderStatsCard(active)}
      </section>

      <section class="wou-crf-compass">
        ${renderCompass(active)}
      </section>

      <aside class="wou-crf-detail">
        ${renderDetail(active)}
      </aside>
    </div>
  `;
}

/* ---- Crafting view ---- */

function renderCraftingView(active) {
  const diagrams = getCraftingDiagrams();
  if (!diagrams.length) {
    return `<div class="wou-crf-empty">— no crafting diagrams in your inventory —</div>`;
  }
  return `
    <div class="wou-crf-view is-active">
      <section class="wou-crf-formulae">
        <div class="wou-crf-formulae-header">
          <i class="fa-solid fa-hammer"></i>Diagrams
        </div>
        <div class="wou-crf-formulae-list">
          ${renderCraftingList(diagrams)}
        </div>
      </section>

      <section class="wou-crf-compass">
        ${renderCraftingCenter(active)}
      </section>

      <aside class="wou-crf-detail">
        ${renderCraftingDetail(active)}
      </aside>
    </div>
  `;
}

function renderCraftingList(diagrams) {
  const sections = [];
  for (const grp of CRAFTING_GROUPS) {
    const items = diagrams.filter(d => grp.match(d.system?.type ?? ""));
    if (!items.length) continue;
    const rows = items.map(d =>
      renderDiagramRow(d, isMemorizedDiagram(d), d.id === activeCraftingDiagramId, "data-crafting-diagram-id")
    ).join("");
    sections.push(`
      <div class="wou-crf-formulae-section">
        <div class="wou-crf-formulae-section-head">
          <i class="fa-solid ${grp.icon}"></i>${escapeText(grp.label)}
        </div>
        ${rows}
      </div>
    `);
  }
  return sections.join("");
}

function renderCraftingCenter(diagram) {
  if (!diagram) {
    return `<div class="wou-crf-compass-empty">— select a diagram —</div>`;
  }
  const baseDC     = Number(diagram.system?.craftingDC) || 0;
  const dc         = baseDC + craftToolPenalty(diagram);
  const skillLabel = craftingSkillFor(diagram) === "trapcraft" ? "Trapcraft" : "Crafting";
  const ready      = craftReadinessCrafting(diagram);
  return `
    <div class="wou-crf-compass-head">
      ${renderOutputPreview(diagram)}
    </div>
    <div class="wou-crf-hex-wrap" style="display:flex;align-items:center;justify-content:center;">
      <button class="wou-crf-hex-center${ready.ready ? "" : " is-disabled"}"
              type="button" data-action="craft-diagram"
              ${ready.ready ? "" : "disabled"}
              title="${escapeAttr(ready.ready ? "Craft this item" : `Cannot craft: ${ready.reason}`)}">
        <span class="hex-label">
          <i class="fa-solid fa-hammer"></i>
          Craft
        </span>
      </button>
    </div>
    <div class="wou-crf-compass-foot">
      <span>DC <span class="key">${dc}</span> <span class="dim">${escapeText(skillLabel)}${dc !== baseDC ? ` · raw ${baseDC}` : ""}</span></span>
    </div>
    ${toolsToggleHTML(diagram)}
  `;
}

function renderCraftingDetail(diagram) {
  if (!diagram) {
    return `<div class="wou-crf-detail-empty">— select a diagram —</div>`;
  }
  const components = resolveCraftingComponents(diagram);
  const skillLabel = craftingSkillFor(diagram) === "trapcraft" ? "Trapcraft" : "Crafting";
  const dc         = Number(diagram.system?.craftingDC) || 0;
  const desc       = stripHtml(diagram.system?.description ?? "");
  return `
    <div class="wou-crf-detail-head">
      <div class="wou-crf-sub-kicker">Crafting diagram</div>
      <div class="wou-crf-sub-title">
        <span class="glyph"><i class="fa-solid fa-hammer"></i></span>
        ${escapeText(diagram.name.replace(/^Diagram:\s*/i, ""))}
      </div>
      <div class="wou-crf-sub-kicker" style="margin-top:4px;">
        ${escapeText(skillLabel)} · DC ${dc}
      </div>
    </div>
    ${renderComponentStrip(components)}
    ${desc ? `<div class="wou-crf-stats-flavor" style="margin-top:8px;font-style:italic;opacity:0.7;">${escapeText(desc)}</div>` : ""}
  `;
}

function renderFormulaeList(formulae) {
  const sections = [];

  for (const grp of FORMULA_GROUPS) {
    const items = formulae.filter(f => grp.match(formulaSubtype(f)));
    if (!items.length) continue;
    const rows = items.map(f => renderFormulaRow(f, isMemorizedDiagram(f))).join("");
    sections.push(`
      <div class="wou-crf-formulae-section">
        <div class="wou-crf-formulae-section-head">
          <i class="fa-solid ${grp.icon}"></i>${escapeText(grp.label)}
        </div>
        ${rows}
      </div>
    `);
  }
  return sections.join("");
}

function renderFormulaRow(f, memorized) {
  return renderDiagramRow(f, memorized, f.id === activeFormulaId, "data-formula-id");
}

/* Shared row markup for both the Alchemy formulae list and the Crafting
 * diagrams list: name + book indicator + memorize toggle. `bookOn` is false
 * for memory-only rows (orphan clones whose paper was deleted). */
function renderDiagramRow(f, memorized, isActive, idAttr) {
  const bookOn   = !isMemoryOnly(f);
  const memTitle = memorized ? "Memorized — click to forget" : "Memorize";
  return `
    <div class="wou-crf-formula-row${isActive ? " is-active" : ""}"
         ${idAttr}="${escapeAttr(f.id)}"
         data-mem="${memorized ? 1 : 0}"
         data-book="${bookOn ? 1 : 0}">
      <span class="name">${escapeText(f.name.replace(/^(Formulae?|Diagram):\s*/i, ""))}</span>
      <div class="row-inds">
        ${bookOn ? `<span class="row-ind book on" title="Diagram in inventory">
          <i class="fa-solid fa-book"></i>
        </span>` : `<span class="row-ind book off" title="Memory only — the paper is gone">
          <i class="fa-solid fa-book-skull"></i>
        </span>`}
        <button class="row-ind brain${memorized ? " on" : ""}"
                type="button"
                data-mem-toggle="${escapeAttr(f.id)}"
                title="${escapeAttr(memTitle)}">
          <i class="fa-solid fa-brain"></i>
        </button>
      </div>
    </div>
  `;
}

/* ---- Compass (substance wheel) ---- */

function renderCompass(active) {
  if (!active) {
    return `<div class="wou-crf-compass-empty">— select a formula —</div>`;
  }

  /* Bombs use named components only — no substance wheel needed. */
  if (formulaSubtype(active) === "bomb") {
    const dc    = Number(active.system?.craftingDC) || Number(active.system?.alchemyDC) || 0;
    const ready = craftReadiness(active);
    return `
      <div class="wou-crf-compass-head">
        ${renderBaseGrid(active)}
        ${renderOutputPreview(active)}
      </div>
      <div class="wou-crf-hex-wrap" style="display:flex;align-items:center;justify-content:center;">
        <button class="wou-crf-hex-center${ready.ready ? "" : " is-disabled"}"
                type="button" data-action="brew"
                ${ready.ready ? "" : "disabled"}
                title="${escapeAttr(ready.ready ? "Craft this bomb" : `Cannot craft: ${ready.reason}`)}">
          <span class="hex-label">
            <i class="fa-solid fa-bomb"></i>
            Craft
          </span>
        </button>
      </div>
      <div class="wou-crf-compass-foot">
        <span>DC <span class="key">${dc}</span> <span class="dim">Alchemy</span></span>
      </div>
    `;
  }

  const substances = formulaSubstances(active);

  /* Static scatter — pick the hand-tuned position for each substance.
   * Falls back to centre if a new key shows up without a position. */
  const nodes = SUBSTANCES.map((s) => {
    const pos  = NODE_POSITIONS[s.key] ?? { left: 50, top: 50 };
    const left = pos.left;
    const top  = pos.top;
    const need = substances[s.key] || 0;
    const have = substanceUsed(s.key);
    const isReq = need > 0;
    const isSel = activeSubstance === s.key;
    const met   = isReq && have >= need;
    const over  = have > need;
    const cls = [
      "wou-crf-hex-node",
      isReq ? "required" : "dim",
      isSel ? "is-active" : "",
      met   ? "is-met"   : "",
      isReq && have > 0 && have < need ? "is-partial" : ""
    ].filter(Boolean).join(" ");
    const tally = isReq
      ? `<span class="node-tally ${met ? "met" : have > 0 ? "partial" : "unmet"}">${have}/${need}</span>`
      : (have > 0 ? `<span class="node-tally over">${have}</span>` : "");
    return `
      <div class="${cls}"
           style="top: ${top.toFixed(2)}%; left: ${left.toFixed(2)}%;"
           data-substance="${s.key}"
           title="${escapeAttr(s.label)}${isReq ? ` — ${have}/${need}` : (have > 0 ? ` — ${have} selected` : "")}">
        <div class="node-disc" style="--sub-c: ${s.color};">
          <img class="node-svg" src="${s.art}" alt="" />
          ${isReq ? `<span class="node-req">${need}</span>` : ""}
        </div>
        ${tally}
        <div class="node-name" style="--sub-c: ${s.color};">${escapeText(s.label)}</div>
      </div>
    `;
  }).join("");

  const dc       = effectiveDC(active) + craftToolPenalty(active);
  const rawDC    = Number(active.system?.alchemyDC) || Number(active.system?.craftingDC) || 0;
  const memorized = isMemorizedDiagram(active);
  const dcOrigin = memorized ? "from memory" : "from book (−2)";
  const totalPot = totalPotency();
  const quality  = predictedQuality(active);
  const qColor   = qualityColor(quality);
  const typeLbl  = (FORMULA_GROUPS.find(g => g.match(formulaSubtype(active)))?.label ?? "Formula");

  const ready    = craftReadiness(active);

  return `
    <div class="wou-crf-compass-head">
      ${renderBaseGrid(active)}
    </div>

    <div class="wou-crf-hex-wrap">
      <svg class="wou-crf-hex-bg" viewBox="0 0 200 200" preserveAspectRatio="xMidYMid meet">
        <circle class="ring" cx="100" cy="100" r="80"/>
        <circle class="ring" cx="100" cy="100" r="60"/>
        <circle class="ring" cx="100" cy="100" r="40"/>
        <line class="spoke" x1="100" y1="20" x2="100" y2="180"/>
        <line class="spoke" x1="30.7" y1="60" x2="169.3" y2="140"/>
        <line class="spoke" x1="30.7" y1="140" x2="169.3" y2="60"/>
      </svg>
      ${renderBaseDropSlot(active)}
      ${nodes}
      <button class="wou-crf-hex-center${ready.ready ? "" : " is-disabled"}"
              type="button" data-action="brew"
              ${ready.ready ? "" : "disabled"}
              title="${escapeAttr(ready.ready ? "Prepare this formula" : `Cannot brew: ${ready.reason}`)}">
        <span class="hex-label">
          <i class="fa-solid fa-mortar-pestle"></i>
          Prepare
          ${totalPot > 0 ? `<span class="hex-sub">Pot ${totalPot}${quality ? ` · ${quality}` : ""}</span>` : ""}
        </span>
      </button>
    </div>

    <div class="wou-crf-compass-foot">
      <span>DC <span class="key">${dc}</span> <span class="dim">${escapeText(dcOrigin)}${rawDC !== dc ? ` · raw ${rawDC}` : ""}</span></span>
      <span>Potency <span class="key">${totalPot}</span></span>
      <span>Quality <span class="key" style="color:${qColor}">${escapeText(quality ?? "Below min")}</span></span>
    </div>
    ${toolsToggleHTML(active)}
  `;
}

/** Horizontal grid of valid bases for the formula, just below the head.
 *  Tiles are drag sources (and click-to-select fallbacks).  Empty / "not
 *  supported" states render as compact one-liners. */
function renderBaseGrid(diagram) {
  const type = formulaSubtype(diagram);
  if (type === "bomb") {
    return `<div class="wou-crf-base-note">Bombs require no base — gather the components and craft directly.</div>`;
  }
  if (!["potion", "oil", "decoction"].includes(type)) {
    return `<div class="wou-crf-base-note">No base required for ${escapeText(type || "this type")}.</div>`;
  }
  const bases = getAvailableBases(diagram);
  /* Drop stale selection if base was used up between renders. */
  if (activeBaseId && !bases.find(b => b.id === activeBaseId)) {
    activeBaseId = null;
  }
  const baseNoun = type === "oil" ? "oil" : (type === "bomb" ? "bomb" : "potion");
  const baseNounCap = baseNoun.charAt(0).toUpperCase() + baseNoun.slice(1);
  /* The ≥50% charge eligibility only applies to potion/decoction bases —
   * oil and bomb bases have no charge gate. Surface the rule in the
   * shelf header for the categories where it matters. */
  const chargeRuleHint = (type === "potion" || type === "decoction")
    ? `<span class="shelf-hint" style="font-style:italic;opacity:0.45;font-weight:400;font-size:0.85em"><i class="fa-solid fa-circle-info" style="margin-right:4px"></i>Only bases with ≥50% charges qualify.</span>`
    : "";

  if (!bases.length) {
    return `
      <div class="wou-crf-base-shelf is-empty">
        <div class="wou-crf-base-shelf-head">
          <span class="shelf-title"><i class="fa-solid fa-flask-vial"></i>Choose a ${baseNoun} base</span>
          <span class="shelf-hint">drag into the slot above Vitriol</span>
        </div>
        <div class="wou-crf-base-note empty">No ${baseNoun} base in inventory yet.</div>
        ${chargeRuleHint ? `<div class="wou-crf-base-note">${chargeRuleHint}</div>` : ""}
      </div>
    `;
  }

  const tiles = bases.map(b => {
    /* Display string comes from alchemy-craft's canonical formatter so the
     * tile cannot drift from the Configure Base dialog's sign convention. */
    const modLabel   = formatBaseMod(b);
    const ci         = type === "potion" || type === "decoction" ? getBaseChargeInfo(b) : null;
    const selected   = activeBaseId === b.id;
    const qty        = Number(b.system?.quantity) || 1;
    const badge = ci
      ? `<span class="tile-charges">${ci.current}/${ci.max}</span>`
      : (qty > 1 ? `<span class="tile-qty">${qty}</span>` : "");
    return `
      <div class="wou-crf-base-tile${selected ? " is-selected" : ""}"
           draggable="true"
           data-role="base-tile"
           data-base-id="${escapeAttr(b.id)}"
           data-wou-tip="${escapeAttr(buildBaseTooltip(b, type))}">
        <img class="tile-img" src="${escapeAttr(b.img || "icons/svg/mystery-man.svg")}" alt=""
             onerror="this.onerror=null;this.src='icons/svg/mystery-man.svg';">
        <span class="tile-mod">${modLabel}</span>
        ${badge}
      </div>
    `;
  }).join("");

  return `
    <div class="wou-crf-base-shelf">
      <div class="wou-crf-base-shelf-head">
        <span class="shelf-title"><i class="fa-solid fa-flask-vial"></i>${baseNounCap} bases</span>
        <span class="shelf-hint">drag one into the slot above Vitriol</span>
      </div>
      ${chargeRuleHint ? `<div class="wou-crf-base-shelf-subhint">${chargeRuleHint}</div>` : ""}
      <div class="wou-crf-base-grid" data-role="base-grid">${tiles}</div>
    </div>
  `;
}

/** Build the HTML tooltip body for a base tile.  Foundry's game.tooltip renders
 *  this as a small popover on hover — name, DC mod, charges, item description. */
function buildBaseTooltip(base, formulaType) {
  const modLabel   = formatBaseMod(base);
  const ci         = (formulaType === "potion" || formulaType === "decoction") ? getBaseChargeInfo(base) : null;
  const qty        = Number(base.system?.quantity) || 1;
  const desc       = stripHtml(base.system?.description ?? "").slice(0, 220);

  const typeLabel = formulaType ? formulaType.charAt(0).toUpperCase() + formulaType.slice(1) : "";

  const rows = [];
  rows.push(`<div class="wcu-tip-row"><span>Type</span><span>${escapeText(typeLabel)} base</span></div>`);
  rows.push(`<div class="wcu-tip-row"><span>DC modifier</span><span>${modLabel}</span></div>`);
  if (ci)        rows.push(`<div class="wcu-tip-row"><span>Charges</span><span>${ci.current} / ${ci.max}</span></div>`);
  else if (qty)  rows.push(`<div class="wcu-tip-row"><span>In stock</span><span>${qty}</span></div>`);

  return `<div class="wcu-tip"><strong>${escapeText(base.name)}</strong>${rows.join("")}${desc ? `<div class="wcu-tip-flavor" style="margin-top:6px;font-style:italic;opacity:0.85">${escapeText(desc)}${desc.length === 220 ? "…" : ""}</div>` : ""}</div>`;
}

/** Circular drop slot pinned to the top of the wheel, just above Vitriol. */
function renderBaseDropSlot(diagram) {
  const type = formulaSubtype(diagram);
  if (!["potion", "oil", "decoction"].includes(type)) return "";

  const actor = getActor();
  const base  = activeBaseId ? actor?.items?.get(activeBaseId) : null;

  if (!base) {
    return `
      <div class="wou-crf-base-drop is-empty" data-role="base-drop"
           title="Drop a base here, or click a tile below">
        <i class="fa-regular fa-circle-dot"></i>
        <span class="drop-label">base</span>
      </div>
    `;
  }

  const modLabel = formatBaseMod(base);
  return `
    <div class="wou-crf-base-drop is-filled" data-role="base-drop"
         title="${escapeAttr(base.name)} · DC ${modLabel} — click × to clear">
      <img class="drop-img" src="${escapeAttr(base.img || "icons/svg/mystery-man.svg")}" alt=""
           onerror="this.onerror=null;this.src='icons/svg/mystery-man.svg';">
      <button type="button" class="drop-clear" data-action="base-clear" title="Clear base">
        <i class="fa-solid fa-xmark"></i>
      </button>
    </div>
  `;
}

/* ---- Right detail panel ---- */

function renderDetail(active) {
  if (!active) {
    return `<div class="wou-crf-detail-empty">— select a formula —</div>`;
  }

  /* Non-bomb formulae: show output item preview at top of detail panel
   * (to the right of the compass wheel). */
  const previewHtml = formulaSubtype(active) !== "bomb" ? renderOutputPreview(active) : "";

  /* Bombs use only named craftingComponents — no substances, no ingredient list. */
  if (formulaSubtype(active) === "bomb") {
    const components = resolveCraftingComponents(active);
    return `
      <div class="wou-crf-detail-head">
        <div class="wou-crf-sub-kicker">Bomb formula</div>
        <div class="wou-crf-sub-title">
          <span class="glyph"><i class="fa-solid fa-bomb"></i></span>
          ${escapeText(active.name.replace(/^(Formulae?|Diagram):\s*/i, ""))}
        </div>
        <div class="wou-crf-sub-kicker" style="margin-top:4px;">
          Crafted with Alchemy · no substances required
        </div>
      </div>
      ${renderComponentStrip(components)}
    `;
  }

  const sub = SUBSTANCES.find(s => s.key === activeSubstance) ?? SUBSTANCES[0];
  const substances = formulaSubstances(active);
  const required = substances[sub.key] || 0;

  const memorized = isMemorizedDiagram(active);
  const inBook    = !isMemoryOnly(active);

  const ingredients = ingredientsForSubstance(sub.key);
  const dc          = effectiveDC(active);
  const rawDC       = Number(active.system?.alchemyDC) || Number(active.system?.craftingDC) || 0;
  const dcSuffix    = memorized ? "from memory" : (inBook ? "from book (−2)" : "unknown");
  const components  = resolveCraftingComponents(active);

  return `
    ${previewHtml}
    <div class="wou-crf-detail-head">
      <div class="wou-crf-sub-kicker">Selected substance</div>
      <div class="wou-crf-sub-title">
        <span class="glyph" style="color: ${sub.color}; border-color: ${sub.color};">
          <img class="glyph-svg" src="${escapeAttr(sub.art)}" alt="" />
        </span>
        ${escapeText(sub.label)}
        ${required > 0 ? `<span class="wou-crf-sub-tally ${substanceUsed(sub.key) >= required ? "met" : substanceUsed(sub.key) > 0 ? "partial" : "unmet"}">${substanceUsed(sub.key)}/${required}</span>` : ""}
      </div>
      <div class="wou-crf-sub-kicker" style="margin-top: 4px;">
        Alchemy ingredient · ${required > 0 ? `${required} required` : "not used by this formula"}
      </div>
    </div>

    ${renderComponentStrip(components)}

    <div class="wou-crf-ing-list">
      ${renderIngredientGroups(ingredients, active, required)}
    </div>
  `;
}

/** Recipe inspect card — name, source pills, DC/type/thresholds/substance reqs,
 *  flavor.  Lives under the formulae list (left column). */
function renderStatsCard(active) {
  if (!active) return "";
  const substances = formulaSubstances(active);
  const dc         = effectiveDC(active);
  const rawDC      = Number(active.system?.alchemyDC) || Number(active.system?.craftingDC) || 0;
  const memorized  = isMemorizedDiagram(active);
  const inBook     = !isMemoryOnly(active);
  const dcSuffix   = memorized ? "from memory" : (inBook ? "from book (−2)" : "from memory");

  return `
    <div class="wou-crf-stats-card">
      <h4>${escapeText(active.name.replace(/^Formula:\s*/i, ""))}</h4>
      <div class="wou-crf-stats-source">
        ${memorized ? `<span class="src-pill src-brain on" title="In memory">
          <i class="fa-solid fa-brain"></i> Memorized
        </span>` : ""}
        ${inBook ? `<span class="src-pill src-book on" title="Book carried">
          <i class="fa-solid fa-book"></i> Book in hand
        </span>` : ""}
      </div>
      <div class="wou-crf-stats-grid">
        <div class="k">DC</div>
        <div class="v">${dc} <span class="stats-dim">· ${escapeText(dcSuffix)}${rawDC !== dc ? ` (raw ${rawDC})` : ""}</span></div>
        <div class="k">Type</div>
        <div class="v">${escapeText(FORMULA_GROUPS.find(g => g.match(formulaSubtype(active)))?.label ?? "Formula")}</div>
        ${renderQualityThresholdRows(active)}
        ${renderSubstanceReqRows(substances)}
      </div>
      ${active.system?.description ? `
        <div class="wou-crf-stats-flavor">${stripHtml(active.system.description)}</div>
      ` : ""}
    </div>
  `;
}

/** Compact strip listing the diagram's named crafting components (Wolfsbane,
 *  Beggartick, …) with met/unmet color.  Hidden when the diagram has none. */
function renderComponentStrip(components) {
  if (!components.length) return "";
  const rows = components.map(c => `
    <span class="wou-crf-comp-pill ${c.met ? "met" : "unmet"}" title="${escapeAttr(c.name)} — have ${c.available}, need ${c.needed}">
      <i class="fa-solid ${c.met ? "fa-check" : "fa-xmark"}"></i>
      ${escapeText(c.name)}
      <span class="comp-count">${c.available}/${c.needed}</span>
    </span>`).join("");
  return `
    <div class="wou-crf-comp-strip">
      <span class="wou-crf-comp-strip-label"><i class="fa-solid fa-mortar-pestle"></i>Components</span>
      <div class="wou-crf-comp-strip-pills">${rows}</div>
    </div>
  `;
}

/** All three quality threshold rows (Normal/Enhanced/Superior) — colored by
 *  whether current totalPotency clears each, so the player can see
 *  "i'm one stride short of Enhanced". */
function renderQualityThresholdRows(diagram) {
  const f = diagram.flags?.["witcher-alchemy-craft"] ?? {};
  const total = totalPotency();
  const rows = [
    { label: "Normal",    threshold: Number(f.potencyNormal)    || 0, color: "#a8d5a2" },
    { label: "Enhanced",  threshold: Number(f.potencyEnhanced ?? f.potencyEnchanted) || 0, color: "#d4af37" },
    { label: "Superior",  threshold: Number(f.potencySuperior)  || 0, color: "#7ec8e3" }
  ].filter(r => r.threshold > 0);
  if (!rows.length) return "";
  return rows.map(r => {
    const reached = total >= r.threshold;
    return `<div class="k">${r.label}</div><div class="v" style="color:${reached ? r.color : "var(--wdm-ink-faint)"}">≥ ${r.threshold} ${reached ? "✓" : ""}</div>`;
  }).join("");
}

function renderSubstanceReqRows(substances) {
  const keys = Object.keys(substances);
  if (!keys.length) return "";
  return keys.map(k => {
    const sub = SUBSTANCES.find(s => s.key === k);
    const label = sub?.label ?? k;
    return `<div class="k">${escapeText(label)}</div><div class="v">×${substances[k]}</div>`;
  }).join("");
}

function renderIngredientGroups(ingredients, diagram, required) {
  if (!ingredients.length) {
    return `<div class="wou-crf-ing-empty">— no matching ingredients in inventory —</div>`;
  }
  const components = ingredients.filter(i => i.type === "component");
  const mutagens   = ingredients.filter(i => i.type === "mutagen");
  const ctx = { diagram, required };
  const columnHead = `
    <div class="wou-crf-ing-cols">
      <span class="col-icon"></span>
      <span class="col-name">Name</span>
      <span class="col-pot">Potency</span>
      <span class="col-stock">In stock</span>
      <span class="col-use">Use</span>
    </div>`;
  return `
    ${components.length ? `
      <div class="wou-crf-ing-sub-head"><i class="fa-solid fa-flask-vial"></i>Components</div>
      ${columnHead}
      ${components.map(it => renderIngredientRow(it, ctx)).join("")}
    ` : ""}
    ${mutagens.length ? `
      <div class="wou-crf-ing-sub-head" style="margin-top: 10px;"><i class="fa-solid fa-vial"></i>Mutagens</div>
      ${columnHead}
      ${mutagens.map(it => renderIngredientRow(it, ctx)).join("")}
    ` : ""}
  `;
}

function renderIngredientRow(item, ctx) {
  const sub      = ingredientSubstance(item);
  const subColor = SUBSTANCES.find(s => s.key === sub)?.color || "transparent";
  const pot      = ingredientPotency(item);
  const selected = selectedIngredients.get(item.id) || 0;
  const avail    = availQty(item, ctx.diagram);
  const subUsed  = substanceUsed(sub);
  const subCap   = ctx.required > 0 ? ctx.required : Infinity;
  const canInc   = selected < avail && subUsed < subCap;
  const canDec   = selected > 0;
  const isUsed   = selected > 0;

  return `
    <div class="wou-crf-ing-row${isUsed ? " is-used" : ""}"
         data-ing-id="${escapeAttr(item.id)}"
         style="--ing-tint: ${subColor};">
      <img class="ing-icon" src="${escapeAttr(item.img || "icons/svg/item-bag.svg")}" alt=""
           onerror="this.onerror=null;this.src='icons/svg/item-bag.svg';" />
      <span class="ing-name">${escapeText(item.name)}</span>
      <span class="ing-pot" title="Potency per unit">${pot}</span>
      <span class="ing-avail" title="Available in inventory (minus base + components reserved)">${avail}</span>
      <div class="ing-stepper">
        <button type="button" class="ing-dec" data-action="ing-dec" data-ing-id="${escapeAttr(item.id)}"
                ${canDec ? "" : "disabled"} title="Use one less">−</button>
        <span class="ing-qty">${selected}</span>
        <button type="button" class="ing-inc" data-action="ing-inc" data-ing-id="${escapeAttr(item.id)}"
                ${canInc ? "" : "disabled"} title="${canInc ? "Use one more" : (subUsed >= subCap ? "Substance need already met" : "No more available")}">+</button>
      </div>
    </div>
  `;
}

function renderPlaceholderView(view) {
  const icon = view === "crafting" ? "fa-hammer" : "fa-utensils";
  const label = view === "crafting" ? "Crafting" : "Cooking";
  const blurb = view === "crafting"
    ? "Weapons, armor, and tools. Diagrams on the left, forge-temperature dial in the middle, material requirements + smith's labor cost on the right.  Will share the Memory strip above."
    : "Meals, drinks, and provisions. Recipe list on the left, cookfire / stewpot diagram in the middle, ingredient pantry on the right.  Cooked meals don't burn memory slots — the Memory strip stays alchemy-exclusive.";
  return `
    <div class="wou-crf-view is-active wou-crf-placeholder">
      <div class="ph-icon"><i class="fa-solid ${icon}"></i></div>
      <h3>${escapeText(label)} · forthcoming</h3>
      <p>${escapeText(blurb)}</p>
    </div>
  `;
}

/** Shrink an ingredient name's font only when a single word is too wide for
 *  its (fixed) column. Multi-word names wrap at spaces at full size and never
 *  trigger this; words are never split mid-character. Font is scaled in
 *  proportion to the overflow so the widest word just fits, down to a floor. */
function fitIngredientNames() {
  const names = panelEl?.querySelectorAll(".wou-crf-ing-row .ing-name");
  if (!names?.length) return;
  const BASE = 12;   // matches .wou-crf-ing-row font-size
  const MIN  = 8;
  for (const el of names) {
    el.style.fontSize = "";                       // measure at base size
    if (el.scrollWidth <= el.clientWidth) continue;  // fits / wraps cleanly
    const ratio = el.clientWidth / el.scrollWidth;
    const size  = Math.max(MIN, Math.floor(BASE * ratio * 10) / 10);
    el.style.fontSize = `${size}px`;
  }
}

/* =========================================================================
   WIRING
   ========================================================================= */

function wireShell() {
  panelEl.querySelector(".wou-crf-close")
    ?.addEventListener("click", () => setCraftingOpen(false));

  /* Maintab — switch view */
  panelEl.querySelectorAll(".wou-crf-maintab").forEach(btn => {
    btn.addEventListener("click", () => {
      activeView = btn.dataset.maintab || "alchemy";
      render();
    });
  });

  /* Memory-bar: click a filled slot to forget (flips system.learned off). */
  panelEl.querySelectorAll(".wou-crf-mem-slot[data-forget]").forEach(btn => {
    btn.addEventListener("click", () => toggleMemorize(btn.dataset.forget));
  });

  /* Formula row click → set active.  Reset craft state when changing formula. */
  panelEl.querySelectorAll(".wou-crf-formula-row").forEach(row => {
    row.addEventListener("click", (e) => {
      if (e.target.closest("[data-mem-toggle]")) return; /* brain has own handler */
      const newId = row.dataset.formulaId;
      if (newId !== activeFormulaId) {
        selectedIngredients = new Map();
        activeBaseId = null;
      }
      activeFormulaId = newId;
      /* Reset substance so the compass+detail pick the first required one */
      activeSubstance = null;
      render();
    });
  });

  /* Memorize/forget toggle on formula row */
  panelEl.querySelectorAll("[data-mem-toggle]").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await toggleMemorize(btn.dataset.memToggle);
    });
  });

  /* Substance node click → re-render detail with that substance */
  panelEl.querySelectorAll(".wou-crf-hex-node").forEach(node => {
    node.addEventListener("click", () => {
      activeSubstance = node.dataset.substance;
      render();
    });
  });

  /* Base tiles — click to select (fallback), dragstart (preferred), hover
   * tooltip (Foundry's game.tooltip with HTML body). */
  panelEl.querySelectorAll('[data-role="base-tile"]').forEach(tile => {
    tile.addEventListener("click", () => setActiveBase(tile.dataset.baseId));
    tile.addEventListener("dragstart", (e) => {
      tile.classList.add("is-dragging");
      e.dataTransfer.effectAllowed = "copy";
      e.dataTransfer.setData("text/wou-base-id", tile.dataset.baseId);
      /* dataTransfer.setData has poor cross-handler visibility on some
       * platforms (dragover can't read it).  Mirror via a panel-scope ref. */
      panelEl.dataset.wouDraggingBase = tile.dataset.baseId;
    });
    tile.addEventListener("dragend", () => {
      tile.classList.remove("is-dragging");
      delete panelEl.dataset.wouDraggingBase;
    });
    tile.addEventListener("pointerenter", () => {
      const html = tile.dataset.wouTip;
      if (html && game?.tooltip) game.tooltip.activate(tile, { direction: "DOWN", html, cssClass: "wou-craft-tip" });
    });
    tile.addEventListener("pointerleave", () => game?.tooltip?.deactivate?.());
  });

  /* Drop slot — dragover/drop + clear button. */
  const drop = panelEl.querySelector('[data-role="base-drop"]');
  if (drop) {
    drop.addEventListener("dragover", (e) => {
      const id = panelEl.dataset.wouDraggingBase
              || e.dataTransfer.getData("text/wou-base-id");
      if (!id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      drop.classList.add("is-dragover");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("is-dragover"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("is-dragover");
      const id = panelEl.dataset.wouDraggingBase
              || e.dataTransfer.getData("text/wou-base-id");
      if (id) setActiveBase(id);
    });
    drop.querySelector('[data-action="base-clear"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      activeBaseId = null;
      render();
    });
  }

  /* Ingredient steppers */
  panelEl.querySelectorAll('[data-action="ing-inc"]').forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.ingId;
      const actor = getActor();
      const it    = actor?.items?.get(id);
      const formula = actor?.items?.get(activeFormulaId);
      if (!it || !formula) return;
      const sub      = ingredientSubstance(it);
      const need     = formulaSubstances(formula)[sub] || Infinity;
      const cur      = selectedIngredients.get(id) || 0;
      const avail    = availQty(it, formula);
      const subUsed  = substanceUsed(sub);
      if (cur >= avail || subUsed >= need) return;
      selectedIngredients.set(id, cur + 1);
      render();
    });
  });
  panelEl.querySelectorAll('[data-action="ing-dec"]').forEach(btn => {
    btn.addEventListener("click", () => {
      const id  = btn.dataset.ingId;
      const cur = selectedIngredients.get(id) || 0;
      if (cur <= 0) return;
      if (cur - 1 <= 0) selectedIngredients.delete(id);
      else selectedIngredients.set(id, cur - 1);
      render();
    });
  });

  /* Prepare button → delegate to alchemy-craft engine */
  panelEl.querySelector('[data-action="brew"]')?.addEventListener("click", onBrewClick);


  /* Crafting diagram row click → select diagram */
  panelEl.querySelectorAll("[data-crafting-diagram-id]").forEach(row => {
    row.addEventListener("click", (e) => {
      if (e.target.closest("[data-mem-toggle]")) return; /* brain has own handler */
      activeCraftingDiagramId = row.dataset.craftingDiagramId;
      render();
    });
  });

  /* Craft button → roll skill + consume components + produce output */
  panelEl.querySelector('[data-action="craft-diagram"]')?.addEventListener("click", async () => {
    const actor   = getActor();
    const diagrams = getCraftingDiagrams();
    const active  = diagrams.find(d => d.id === activeCraftingDiagramId);
    if (!actor || !active) { ui.notifications?.warn("Pick a diagram first."); return; }
    const ready = craftReadinessCrafting(active);
    if (!ready.ready) { ui.notifications?.warn(`Cannot craft: ${ready.reason}.`); return; }
    await craftDiagram(actor, active);
  });
}

/* =========================================================================
   BASE SELECTION
   ========================================================================= */

function setActiveBase(id) {
  if (!id || id === activeBaseId) {
    if (!id) activeBaseId = null;
    render();
    return;
  }
  activeBaseId = id;
  /* If the same item was selected as an ingredient AND just became base, the
   * base reserves 1 unit of itself — trim the ingredient qty so we don't show
   * counts that exceed availability. */
  const cur = selectedIngredients.get(activeBaseId) || 0;
  if (cur > 0) {
    const actor   = getActor();
    const it      = actor?.items?.get(activeBaseId);
    const formula = actor?.items?.get(activeFormulaId);
    if (it && formula) {
      const max = availQty(it, formula);
      if (cur > max) {
        if (max > 0) selectedIngredients.set(activeBaseId, max);
        else selectedIngredients.delete(activeBaseId);
      }
    }
  }
  render();
}

/* =========================================================================
   MEMORIZE / FORGET
   ========================================================================= */

async function toggleMemorize(diagramId) {
  if (!diagramId) return;
  const actor = getActor();
  if (!actor) return;
  const diagram = actor.items.get(diagramId);
  if (!diagram || diagram.type !== "diagrams") return;

  /* Forget: the row is itself the memorized clone → delete it. */
  if (memorizedFromOf(diagram)) {
    await diagram.delete();
    return;
  }

  /* Forget: original whose clone exists → delete the clone (keep the book). */
  const clone = findMemorizedCopy(diagram.id);
  if (clone) {
    await clone.delete();
    return;
  }

  /* Forget: legacy in-place learned original → flip the flag off. */
  if (diagram.system?.learned) {
    await diagram.update({ "system.learned": false });
    return;
  }

  /* Memorize: gate by the INT memory cap, then clone the diagram so the
   * recipe survives deleting the paper. */
  const cap = getInt();
  if (getMemorizedIds().size >= cap) {
    ui.notifications?.warn(
      cap > 0
        ? `Memory full (${cap}/${cap}). Forget a recipe first.`
        : `Memory empty: this character's Intelligence grants 0 memory slots.`
    );
    return;
  }
  const data = diagram.toObject();
  delete data._id;
  data.system = data.system ?? {};
  data.system.learned = true;
  data.system.memorizedFrom = diagram.id;
  await actor.createEmbeddedDocuments("Item", [data]);
}

/* =========================================================================
   BREW — RAW Alchemy roll for every formula (bomb, potion, oil, decoction)
   via craftAlchemy: roll Alchemy vs DC, consume the named craftingComponents,
   grant the diagram's associatedItem on success, recovery roll on failure.
   ========================================================================= */

/** Consume `qty` of a named crafting component from the actor's inventory.
 *  UUID match is tried first; falls back to case-insensitive name match. */
async function _consumeComponent(actor, comp) {
  const uuid = comp.uuid ?? "";
  const matchingItems = actor.items.filter(i => {
    const src = i._stats?.compendiumSource ?? i.flags?.core?.sourceId ?? "";
    return (uuid && src === uuid) || i.name.toLowerCase() === (comp.name ?? "").toLowerCase();
  });
  let remaining = Number(comp.quantity);
  for (const item of matchingItems) {
    if (remaining <= 0) break;
    const qty = Number(item.system?.quantity) || 1;
    const use = Math.min(qty, remaining);
    if (qty - use <= 0) await item.delete();
    else await item.update({ "system.quantity": qty - use });
    remaining -= use;
  }
}

/** Return `qty` units of a named component to the actor's inventory.
 *  Stacks with existing items of the same source; creates a fresh copy
 *  from the compendium if none remain. */
async function _returnComponent(actor, comp, qty) {
  const uuid = comp.uuid ?? "";
  const existing = actor.items.find(i => {
    const src = i._stats?.compendiumSource ?? i.flags?.core?.sourceId ?? "";
    return (uuid && src === uuid) || i.name.toLowerCase() === (comp.name ?? "").toLowerCase();
  });
  if (existing) {
    await existing.update({ "system.quantity": (Number(existing.system?.quantity) || 1) + qty });
    return;
  }
  if (uuid) {
    try {
      const source = await fromUuid(uuid);
      if (source) {
        const data = source.toObject();
        data.system = { ...data.system, quantity: qty };
        await actor.createEmbeddedDocuments("Item", [data]);
        return;
      }
    } catch {}
  }
  ui.notifications?.warn(`Could not return ${comp.name ?? "component"} — add it manually.`);
}

/** Show a yes/no confirm dialog using DialogV2.wait (Foundry v13).
 *  Returns true (Yes), false (No), or null (closed). */
async function askConfirm(title, content) {
  const html = `<p style="margin:0 0 8px">${content}</p>`;
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (DialogV2) {
    return DialogV2.wait({
      window: { title },
      content: html,
      modal: true,
      rejectClose: false,
      buttons: [
        { action: "yes", label: "Yes", icon: "fa-solid fa-check", default: true, callback: () => true },
        { action: "no",  label: "No",  icon: "fa-solid fa-xmark",                callback: () => false }
      ]
    });
  }
  /* Legacy Dialog fallback */
  return new Promise(resolve => {
    new Dialog({
      title, content: html,
      buttons: {
        yes: { label: "Yes", callback: () => resolve(true) },
        no:  { label: "No",  callback: () => resolve(false) }
      },
      default: "yes",
      close: () => resolve(false)
    }).render(true);
  });
}

/** Prompt for a flat situational modifier before a craft/brew check, mirroring
 *  the dock's Awareness modifier prompt. Returns `{ situational, situationalParts }`
 *  to fold into rollSkillCheck, or null if the player cancelled. Degrades to a
 *  zero modifier (no prompt) when DialogV2 is unavailable. */
async function promptCraftModifier(skillLabel, actor) {
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2) return { situational: 0, situationalParts: [] };
  const content = `
    <div class="wou-skillmod-prompt">
      <div class="wou-skillmod-head">${escapeText(skillLabel)} check — ${escapeText(actor.name)}</div>
      <label class="wou-skillmod-manual">
        <span>Situational modifier</span>
        <input type="number" name="manual" step="1" value="0" autofocus />
      </label>
    </div>`;
  const parts = await DialogV2.prompt({
    window: { title: `${skillLabel} — ${actor.name}` },
    content,
    ok: {
      label: "Roll",
      callback: (_e, btn) => {
        const manual = Number(btn.form.elements.manual?.value) || 0;
        return manual ? [{ label: "Situational", value: manual }] : [];
      }
    },
    rejectClose: false
  }).catch(() => null);
  if (parts == null) return null;   // cancelled
  const situational = parts.reduce((s, p) => s + (Number(p.value) || 0), 0);
  return { situational, situationalParts: parts };
}

/** Post a clear pass/fail result card to chat after a craft/brew attempt. */
function postCraftResult({ actor, label, pass, dc, total, itemName, itemImg }) {
  const tone = pass ? "#7fae5a" : "#b5503f";
  const head = `<b>${escapeText(actor.name)}</b> ${pass ? "succeeds at" : "fails"} the `
             + `${escapeText(label)} check &mdash; rolled <b>${total}</b> vs DC ${dc}.`;
  let body;
  if (pass && itemName) {
    body = `<div style="display:flex;align-items:center;gap:6px;margin-top:4px;">`
         + (itemImg ? `<img src="${escapeAttr(itemImg)}" width="28" height="28" style="border:none;border-radius:4px;flex:0 0 auto;">` : "")
         + `<span>Crafted <b>${escapeText(itemName)}</b>.</span></div>`;
  } else if (pass) {
    body = `<div style="margin-top:4px;">Crafted successfully.</div>`;
  } else {
    body = `<div style="margin-top:4px;">No item produced.</div>`;
  }
  ChatMessage.create({
    content: `<div class="witcher-craft-result" style="border-left:3px solid ${tone};padding-left:8px;">${head}${body}</div>`,
    speaker: ChatMessage.getSpeaker({ actor })
  });
}

/** Craft any alchemy formula (bomb, potion, oil, decoction) via an Alchemy roll.
 *  RAW: no base or substance ingredients are required — only the named
 *  craftingComponents on the diagram. On success the diagram's associatedItem
 *  is added to inventory; on failure the player may attempt a recovery roll
 *  (Alchemy vs DC) to reclaim one of the components used. */
async function craftAlchemy(actor, diagram) {
  const dc           = (Number(diagram.system?.alchemyDC) || Number(diagram.system?.craftingDC) || 0) + craftToolPenalty(diagram);
  const requiredComps = (diagram.system?.craftingComponents ?? []).filter(c => Number(c.quantity) > 0);

  const mods = await promptCraftModifier("Alchemy", actor);
  if (mods == null) return;   // cancelled at the modifier prompt

  let roll;
  try { roll = await actor.rollSkillCheck?.("alchemy", dc, mods); } catch { return; }
  if (!roll) return;
  const pass = roll.total >= dc;

  for (const comp of requiredComps) await _consumeComponent(actor, comp);

  let itemName = "", itemImg = "";
  if (pass) {
    const outputUuid = diagram.system?.associatedItem?.uuid;
    if (outputUuid) {
      try {
        const output = await fromUuid(outputUuid);
        if (output) {
          await actor.addItem(output, 1);
          itemName = output.name;
          itemImg  = output.img;
        }
      } catch (err) {
        console.warn("[witcher-ttrpg-death-march] craftAlchemy: could not resolve output item", err);
      }
    }
  }

  postCraftResult({ actor, label: "Alchemy", pass, dc, total: roll.total, itemName, itemImg });

  if (!pass && requiredComps.length) {
    const attempt = await askConfirm(
      "Recovery Roll",
      `Brewing failed. Attempt a recovery roll (Alchemy DC ${dc}) to reclaim one component?`
    );
    if (attempt) {
      let recovery;
      try { recovery = await actor.rollSkillCheck?.("alchemy", dc, mods); } catch { /* dismissed */ }
      if (recovery && recovery.total >= dc) {
        const comp = requiredComps[Math.floor(Math.random() * requiredComps.length)];
        await _returnComponent(actor, comp, 1);
        ChatMessage.create({
          content: `<b>${escapeText(actor.name)}</b> recovered <b>${escapeText(comp.name)}</b> from the failed brew.`,
          speaker: ChatMessage.getSpeaker({ actor })
        });
      } else if (recovery) {
        ui.notifications?.warn("Recovery failed — all materials lost.");
      }
    }
  }

  selectedIngredients = new Map();
  activeBaseId = null;
  render();
}

/** Craft a non-alchemy diagram: roll Crafting (or Trapcraft), consume
 *  components, and add the output item to inventory on success.
 *  On failure the player may attempt a salvage roll (same skill, same DC)
 *  to recover ceil(qty / 2) of each component. */
async function craftDiagram(actor, diagram) {
  const skill         = craftingSkillFor(diagram);
  const skillLabel    = skill === "trapcraft" ? "Trapcraft" : "Crafting";
  const dc            = (Number(diagram.system?.craftingDC) || 0) + craftToolPenalty(diagram);
  const requiredComps = (diagram.system?.craftingComponents ?? []).filter(c => Number(c.quantity) > 0);

  const mods = await promptCraftModifier(skillLabel, actor);
  if (mods == null) return;   // cancelled at the modifier prompt

  let roll;
  try { roll = await actor.rollSkillCheck?.(skill, dc, mods); } catch { return; }
  if (!roll) return;
  const pass = roll.total >= dc;

  for (const comp of requiredComps) await _consumeComponent(actor, comp);

  let itemName = "", itemImg = "";
  if (pass) {
    const outputUuid = diagram.system?.associatedItem?.uuid;
    if (outputUuid) {
      try {
        const output = await fromUuid(outputUuid);
        if (output) {
          await actor.addItem(output, 1);
          itemName = output.name;
          itemImg  = output.img;
        }
      } catch (err) {
        console.warn("[witcher-ttrpg-death-march] craftDiagram: could not resolve output item", err);
      }
    }
  }

  postCraftResult({ actor, label: skillLabel, pass, dc, total: roll.total, itemName, itemImg });

  if (!pass) {
    if (requiredComps.length) {
      const attempt = await askConfirm(
        "Salvage Materials?",
        `Crafting failed. Attempt a salvage roll (${skillLabel} DC ${dc}) to recover half your materials?`
      );
      if (attempt) {
        let salvage;
        try { salvage = await actor.rollSkillCheck?.(skill, dc, mods); } catch { /* dismissed */ }
        if (salvage && salvage.total >= dc) {
          const recovered = [];
          for (const comp of requiredComps) {
            const returnQty = Math.ceil(Number(comp.quantity) / 2);
            await _returnComponent(actor, comp, returnQty);
            recovered.push(`${comp.name} ×${returnQty}`);
          }
          ChatMessage.create({
            content: `<b>${actor.name}</b> salvaged half their materials: ${recovered.join(", ")}.`,
            speaker: ChatMessage.getSpeaker({ actor })
          });
        } else {
          ui.notifications?.warn("Salvage failed — all materials lost.");
        }
      }
    }
  }

  render();
}

async function onBrewClick() {
  const actor    = getActor();
  const formulae = getFormulae();
  const active   = formulae.find(f => f.id === activeFormulaId);
  if (!actor || !active) {
    ui.notifications?.warn("Pick a formula first.");
    return;
  }
  const ready = craftReadiness(active);
  if (!ready.ready) {
    ui.notifications?.warn(`Cannot brew: ${ready.reason}.`);
    return;
  }

  await craftAlchemy(actor, active);
}

/* =========================================================================
   UTILS
   ========================================================================= */

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
function stripHtml(s) {
  if (!s) return "";
  const tmp = document.createElement("div");
  tmp.innerHTML = String(s);
  return (tmp.textContent || "").trim();
}
