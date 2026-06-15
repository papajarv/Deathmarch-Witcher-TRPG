/**
 * Hotbar — 5-slot per-actor hotbar rendered in the dock's prompts row.
 *
 * Slots hold either an Item (any source: owned, world, compendium) or a
 * Foundry Macro. Persistence is per-actor in
 * `actor.flags["witcher-ttrpg-death-march"].hotbar.{1..5}` with shape:
 *   { kind: "item" | "macro", uuid: string, name: string }
 *
 * Interactions: Drop = bind. Click = activate. Right-click = clear.
 * Keys 1-5 = activate (suppressed when an input/textarea/contenteditable
 * has focus, or when no character is assigned).
 */

import { MODULE_ID, getSetting } from "../setup/settings.js";
import { getAssignedActor } from "../lib/actor.js";
import { drawWeapon, sheathWeapon, findContainerHoldingItem } from "./inventory.js";
import { isConsumable, consumeItem } from "../policy/consume-item.js";
import { runPrimaryItemAction, fastDrawWeapon } from "./context-menu-item.js";

const SLOTS = [1, 2, 3, 4, 5];
const FLAG_BASE = "hotbar";

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

// `setFlag` deep-merges and cannot drop sub-keys; `-=` is the only way out.
async function clearSlot(actor, n) {
  await actor.update({ [`flags.${MODULE_ID}.${FLAG_BASE}.-=${n}`]: null });
}

/* ---------- render -------------------------------------------------------- */

export function injectHotbar(host, actor) {
  if (!host) return;
  host.innerHTML = "";
  const slots = getSlots(actor);
  for (const n of SLOTS) {
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
 * updates instantly. */
function paintSlot(el, n, slot) {
  if (!el) return;
  el.classList.toggle("is-empty", !slot);
  if (!el.classList.contains("prompt")) el.classList.add("prompt");
  if (slot) {
    const kindLabel = slot.kind === "macro" ? "Macro" : "Item";
    el.title = `${kindLabel} · ${slot.name}\nRight-click to clear`;
  } else {
    el.removeAttribute("title");
  }
  el.innerHTML = `<span class="key">${n}</span><span class="lbl">${escapeHTML(slot?.name ?? "—")}</span>`;
}

function bindSlotEvents(el, n, actor) {
  el.addEventListener("dragenter", (e) => { e.preventDefault(); el.classList.add("is-drag-target"); });
  el.addEventListener("dragover",  (e) => { e.preventDefault(); });
  el.addEventListener("dragleave", () => el.classList.remove("is-drag-target"));

  el.addEventListener("drop", async (e) => {
    e.preventDefault();
    el.classList.remove("is-drag-target");
    if (!actor) {
      ui.notifications?.warn("Witcher Overhaul UI: assign a character before using the hotbar.");
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
      ui.notifications?.warn(`Witcher Overhaul UI: slot ${n} target no longer exists. Clearing.`);
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

    // Weapons on the hotbar are draw/sheath toggles, NOT attack triggers.
    // Attack rolls happen from the dock's combat-state weapon list (and
    // the system's character sheet). Three cases:
    //   1. Equipped (drawn) → sheath it back.
    //   2. Currently inside a container on this actor → draw it.
    //   3. Loose on the grid (not equipped, not in a container) → refuse;
    //      weapons need to live in a sheath to be drawn via the hotbar.
    if (isOwned && doc.type === "weapon") {
      // Shift = quick draw (Fast Draw): snap-draw + roll into initiative at +3
      // instead of a plain draw. If a fast draw isn't possible right now
      // (already drawn this turn, or past round 1), it does nothing.
      if (shift) {
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
  document.addEventListener("keydown", (e) => {
    if (!getSetting("feature.hotbar")) return;
    const t = e.target;
    if (t?.matches?.("input, textarea, select, [contenteditable=''], [contenteditable='true']")) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const m = /^(?:Digit|Numpad)([1-5])$/.exec(e.code);
    if (!m) return;
    const actor = getAssignedActor();
    if (!actor) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    activateSlot(actor, Number(m[1]), null, { shift: e.shiftKey });
  }, true);
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
    for (const n of SLOTS) {
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
