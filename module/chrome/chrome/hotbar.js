/**
 * Hotbar — per-actor hotbar rendered in the dock's prompts row. Slot
 * count is per-user (client setting `hotbar.slotCount`, 1-10, default 5).
 *
 * Slots hold either an Item (any source: owned, world, compendium) or a
 * Foundry Macro. Persistence is per-actor in
 * `actor.flags["witcher-ttrpg-death-march"].hotbar.{N}` with shape:
 *   { kind: "item" | "macro", uuid: string, name: string }
 *
 * Interactions: Drop = bind. Click = activate. Right-click = clear.
 * Keys 1-9 = activate slots 1-9; Key 0 = activate slot 10. Suppressed
 * when an input/textarea/contenteditable has focus, or when no
 * character is assigned. Only slots within the current slot count
 * respond to the keybind — a key press for a slot number above the
 * user's configured count is ignored.
 *
 * Lowering slot count doesn't delete out-of-range slot data — it just
 * hides those slots visually. Raising the count back reveals them.
 */

import { MODULE_ID, getSetting } from "../setup/settings.js";
import { getAssignedActor } from "../lib/actor.js";
import { drawWeapon, sheathWeapon, findContainerHoldingItem } from "./inventory.js";
import { isConsumable, consumeItem } from "../policy/consume-item.js";
import { runPrimaryItemAction, fastDrawWeapon } from "./context-menu-item.js";

import { t, tFormat } from "../lib/i18n.js";
const FLAG_BASE = "hotbar";
const SLOT_MIN = 1;
const SLOT_MAX = 10;
const SLOT_COUNT_DEFAULT = 5;

/* Read the per-user configured slot count, clamped to [1, 10]. Any bad
 * value (undefined, non-numeric) falls back to the default. Called on
 * every render + every keydown so a setting change takes effect on
 * the next paint / keypress without a reload. */
function getSlotCount() {
    const raw = Number(getSetting("hotbar.slotCount"));
    if (!Number.isFinite(raw)) return SLOT_COUNT_DEFAULT;
    return Math.max(SLOT_MIN, Math.min(SLOT_MAX, Math.round(raw)));
}

/* [1, 2, …, N] where N is the current slot count. */
function getSlotIndices() {
    const n = getSlotCount();
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = i + 1;
    return out;
}

function getSlots(actor) {
  if (!actor) return {};
  return actor.getFlag(MODULE_ID, FLAG_BASE) ?? {};
}

function getSlot(actor, n) {
  return getSlots(actor)[String(n)] ?? null;
}

async function writeSlot(actor, n, payload) {
  await actor.setFlag(MODULE_ID, `${FLAG_BASE}.${n}`, payload);
}

// `setFlag` deep-merges and cannot drop sub-keys; use the ForcedDeletion
// operator (v14) to drop the leaf explicitly.
async function clearSlot(actor, n) {
  await actor.update({ [`flags.${MODULE_ID}.${FLAG_BASE}.${n}`]: new foundry.data.operators.ForcedDeletion() });
}

/* ---------- render -------------------------------------------------------- */

export function injectHotbar(host, actor) {
  if (!host) return;
  host.innerHTML = "";
  const slots = getSlots(actor);
  for (const n of getSlotIndices()) {
    const slot = slots[String(n)] ?? null;
    const el = document.createElement("span");
    el.dataset.slot = String(n);
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    paintSlot(el, n, slot);
    bindSlotEvents(el, n, actor);
    host.appendChild(el);
  }
}

/* Render a slot's visual state (empty/filled class, label, tooltip) in place.
 * Shared by the initial render and the drop handler so a newly-bound item
 * updates instantly.
 *
 * When the slot holds a weapon that is currently EQUIPPED (drawn), the label
 * is greyed out via `is-drawn` — a quick visual cue that a hotbar-bound weapon
 * is already in-hand (so a shortcut press would draw it a second time or
 * conflict). Sheathed weapons render normally. Non-weapon slots ignore this. */
function paintSlot(el, n, slot) {
  if (!el) return;
  el.classList.toggle("is-empty", !slot);
  if (!el.classList.contains("prompt")) el.classList.add("prompt");
  let isDrawnWeapon = false;
  if (slot?.kind === "item" && slot.uuid) {
    try {
      const doc = fromUuidSync(slot.uuid);
      if (doc?.documentName === "Item" && doc?.type === "weapon" && doc?.system?.equipped) {
        isDrawnWeapon = true;
      }
    } catch (_) { /* uuid unresolvable / cross-realm — treat as sheathed */ }
  }
  el.classList.toggle("is-drawn", isDrawnWeapon);
  if (slot) {
    const kindLabel = slot.kind === "macro"
      ? t("WITCHER.Chrome.Hotbar.Text.Macro", "Macro")
      : t("WITCHER.Chrome.Hotbar.Text.Item", "Item");
    el.title = tFormat("WITCHER.Chrome.Hotbar.Tip.Slot", { kindLabel, name: slot.name }, `${kindLabel} · ${slot.name}\nRight-click to clear`);
  } else {
    el.removeAttribute("title");
  }
  /* Slot 10 is triggered by the "0" key — show the physical key
   * label, not the slot index. Everything else (dataset.slot, flag
   * storage, activateSlot lookup) still uses the real slot number
   * so persistence and interactions are unaffected. */
  const keyLabel = n === 10 ? "0" : String(n);
  el.innerHTML = `<span class="key">${keyLabel}</span><span class="lbl">${escapeHTML(slot?.name ?? "—")}</span>`;
}

function bindSlotEvents(el, n, actor) {
  el.addEventListener("dragenter", (e) => { e.preventDefault(); el.classList.add("is-drag-target"); });
  el.addEventListener("dragover",  (e) => { e.preventDefault(); });
  el.addEventListener("dragleave", () => el.classList.remove("is-drag-target"));

  el.addEventListener("drop", async (e) => {
    e.preventDefault();
    el.classList.remove("is-drag-target");
    if (!actor) {
      ui.notifications?.warn(t("WITCHER.Notify.Hotbar.NoCharacter", "Witcher Overhaul UI: assign a character before using the hotbar."));
      return;
    }
    const data = parseDropData(e);
    if (!data) return;
    const resolved = await resolveDrop(data);
    if (!resolved) return;
    await writeSlot(actor, n, resolved);
    // Reflect the new binding immediately — the actor flag-update doesn't
    // reliably trigger a dock rebind, so the label would otherwise stay stale
    // until the next full render.
    paintSlot(el, n, resolved);
  });

  el.addEventListener("click", async (e) => {
    e.preventDefault(); e.stopPropagation();
    await activateSlot(actor, n, el, { shift: e.shiftKey });
  });

  // Right-click clears the slot directly — no context menu.
  el.addEventListener("contextmenu", async (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!actor) return;
    await clearSlot(actor, n);
    paintSlot(el, n, null);
  });
}

function parseDropData(event) {
  try {
    const raw = event.dataTransfer?.getData("text/plain");
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data?.type !== "Item" && data?.type !== "Macro") return null;
    return data;
  } catch { return null; }
}

async function resolveDrop(data) {
  try {
    if (data.type === "Item") {
      const item = await Item.implementation.fromDropData(data);
      if (!item) return null;
      return { kind: "item", uuid: item.uuid, name: item.name };
    }
    if (data.type === "Macro") {
      const macro = await Macro.implementation.fromDropData(data);
      if (!macro) return null;
      return { kind: "macro", uuid: macro.uuid, name: macro.name };
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | resolveDrop failed`, err);
  }
  return null;
}

/* ---------- activation ---------------------------------------------------- */

async function activateSlot(actor, n, slotEl = null, { shift = false } = {}) {
  if (!actor) return;
  const slot = getSlot(actor, n);
  if (!slot) return;
  try {
    const doc = await fromUuid(slot.uuid);
    if (!doc) {
      ui.notifications?.warn(tFormat("WITCHER.Notify.Hotbar.SlotMissing", { n: n }, "Witcher Overhaul UI: slot {n} target no longer exists. Clearing."));
      await clearSlot(actor, n);
      return;
    }
    if (slot.kind === "macro") {
      doc.execute?.();
      return;
    }
    // Containers — open as a floating popup over the hotbar slot, NOT
    // inside the inventory overlay.  Keeps the user's focus on the dock.
    if (doc.type === "container") {
      const api = game.system?.api?.containers;
      const anchor = slotEl ?? document.querySelector(`#wou-dock [data-slot="${n}"]`);
      if (api?.openContainerFloating) { api.openContainerFloating(doc.id, anchor); return; }
    }
    const isOwned = doc.parent?.id === actor.id;

    // Weapons and shields on the hotbar are draw/sheath toggles, NOT attack
    // triggers. Attack rolls happen from the dock's combat-state weapon list
    // (and the system's character sheet). Three cases:
    //   1. Equipped (drawn) → sheath it back.
    //   2. Currently inside a container on this actor → draw it.
    //   3. Loose on the grid (not equipped, not in a container) → refuse;
    //      weapons/shields need to live in a sheath to be drawn via the hotbar.
    // Fast Draw (Shift) is weapon-only per Core p.151 — shields fall through
    // to a plain draw regardless of the modifier.
    if (isOwned && (doc.type === "weapon" || doc.type === "shield")) {
      if (shift && doc.type === "weapon") {
        await fastDrawWeapon(doc, actor);
        return;
      }
      if (doc.system?.equipped) {
        await sheathWeapon(actor, doc);
      } else {
        const containerId = findContainerHoldingItem(actor, doc.id);
        if (containerId) {
          await drawWeapon(actor, doc);
        } else {
          ui.notifications?.warn?.(
            `Can't draw ${doc.name} from the hotbar — it isn't sheathed. Put it in a container first.`
          );
        }
      }
      return;
    }

    // Flagged consumables: spend a dose and apply effects to the holder.
    if (isOwned && isConsumable(doc)) {
      await consumeItem(doc, actor);
      return;
    }

    // Owned items with a context-use action run their primary action:
    // oils → Apply to Weapon, remains → Harvest, books → Study/Read,
    // food/drink → Pour/Serve, etc. Anything with no applicable action
    // (and all foreign items) just opens its sheet.
    if (isOwned && runPrimaryItemAction(doc, actor)) return;
    doc.sheet?.render(true);
  } catch (err) {
    console.warn(`${MODULE_ID} | activateSlot ${n} failed`, err);
  }
}

/* ---------- one-time install (keybinds + cleanup) ------------------------- */

let _hotkeysBound = false;
export function bindHotkeys() {
  if (_hotkeysBound) return;
  _hotkeysBound = true;

  // Capture-phase listener so we win against Foundry's native macro hotbar.
  const EDITING_SEL = "input, textarea, select, [contenteditable=''], [contenteditable='true']";
  const isEditingContext = (el) => !!(el && el !== document.body && el.closest?.(EDITING_SEL));
  document.addEventListener("keydown", (e) => {
    if (!getSetting("feature.hotbar")) return;
    // Guard against firing while the user is typing in a form control.
    // Check BOTH the event target AND document.activeElement — a stray
    // keydown after a focused input is blurred can arrive on document.body
    // while the user is still mid-edit (e.g. a re-rendered field), and we
    // must not activate a hotbar slot in that case.
    if (isEditingContext(e.target) || isEditingContext(document.activeElement)) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    /* 1-9 map to slots 1-9; 0 maps to slot 10. Gated on the user's
     * current slotCount so a keypress for a hidden slot no-ops. */
    const m = /^(?:Digit|Numpad)([0-9])$/.exec(e.code);
    if (!m) return;
    const digit = Number(m[1]);
    const slot = digit === 0 ? 10 : digit;
    if (slot > getSlotCount()) return;
    const actor = getAssignedActor();
    if (!actor) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    activateSlot(actor, slot, null, { shift: e.shiftKey });
  }, true);
}

/* Repaint the hotbar into the currently-visible dock, using the current
 * assigned actor. Called from the `hotbar.slotCount` setting's onChange
 * so a slider drag reflows the slot count without a page reload. */
export function refreshHotbar() {
  const host = document.querySelector('#wou-dock [data-bind="prompts"]');
  if (!host) return;
  injectHotbar(host, getAssignedActor());
}

let _cleanupBound = false;
export function installItemCleanup() {
  if (_cleanupBound) return;
  _cleanupBound = true;

  const clearMatches = async (actor, uuid) => {
    const slots = getSlots(actor);
    // The actor flag-update doesn't reliably trigger a dock rebind (same
    // reason drop/right-click repaint by hand), so repaint the emptied slot
    // directly when it belongs to the actor currently shown in the dock.
    const isShown = actor.id === getAssignedActor()?.id;
    /* Sweep every possible slot (1..SLOT_MAX), not just the currently
     * visible count — an item bound to slot 8 while the user's count
     * was 10 still needs cleanup even if they've since lowered the
     * count to 5 and the slot is hidden. */
    for (let n = SLOT_MIN; n <= SLOT_MAX; n++) {
      if (slots[String(n)]?.uuid !== uuid) continue;
      await clearSlot(actor, n);
      if (isShown) {
        const el = document.querySelector(`#wou-dock [data-slot="${n}"]`);
        if (el) paintSlot(el, n, null);
      }
    }
  };

  Hooks.on("deleteItem", async (item) => {
    const uuid = item?.uuid;
    if (!uuid) return;
    if (item.parent?.documentName === "Actor") {
      await clearMatches(item.parent, uuid);
    } else {
      for (const a of game.actors ?? []) await clearMatches(a, uuid);
    }
  });

  Hooks.on("deleteMacro", async (macro) => {
    const uuid = macro?.uuid;
    if (!uuid) return;
    for (const a of game.actors ?? []) await clearMatches(a, uuid);
  });
}

/* ---------- util ---------------------------------------------------------- */

function escapeHTML(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
