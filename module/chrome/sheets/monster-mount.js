/**
 * Monster sheet · Mount slot.
 *
 * Adds a top-right "Mount" checkbox to the monster HUD.  When checked,
 * the checkbox expands into a drop zone that accepts mount-type items.
 * Dropping a mount embeds it on the monster (so the system's normal item
 * lifecycle handles persistence) and the rider's control modifier is
 * read live from `embedded-mount.system.control`.  Delete the embedded
 * mount and the modifier is gone — that's the "as long as the item is
 * present" guarantee.
 *
 * Flag schema (only the checkbox state is persisted on the actor; the
 * linked mount itself is just the first embedded item of type "mount"):
 *
 *   actor.flags["witcher-ttrpg-death-march"].mount.enabled = boolean
 *
 * Read the modifier from anywhere:
 *
 *   const mount = monster.items.find(i => i.type === "mount");
 *   const mod   = mount ? Number(mount.system.control) || 0 : 0;
 */

const MODULE_ID = "witcher-ttrpg-death-march";
const FLAG_PATH = "mount.enabled";

Hooks.on("renderWitcherMonsterSheet", (app, element /*, context */) => {
  const actor = app.actor ?? app.document;
  if (!actor || actor.type !== "monster") return;

  /* Skip if already injected for this render */
  const root = element instanceof HTMLElement ? element : element[0];
  if (!root) return;
  if (root.querySelector(".wou-mount-slot")) return;

  const enabled    = !!actor.getFlag(MODULE_ID, FLAG_PATH);
  const mountItem  = actor.items.find(i => i.type === "mount") ?? null;
  const controlMod = mountItem ? (Number(mountItem.system?.control) || 0) : 0;
  const editable   = actor.isOwner;

  /* Find an anchor in the HUD's tag row — drop the pill in front of the
   * action-buttons cluster so it sits at the right end of the tag pills.
   * Note: `.configure-actor` lives inside `.hud-tag-actions`, so we anchor
   * on the actions wrapper (a direct child of `.hud-tags`) — anchoring on
   * the cog directly throws NotFoundError from insertBefore. */
  const tagRow = root.querySelector(".monster-hud .hud-tags");
  if (!tagRow) return;
  const anchor = tagRow.querySelector(":scope > .hud-tag-actions")
              ?? tagRow.querySelector(":scope > .configure-actor")
              ?? null;

  const slot = document.createElement("label");
  slot.className = `tag wou-mount-slot${enabled ? " is-on" : ""}${mountItem ? " is-linked" : ""}`;
  slot.dataset.tooltip = mountItem
    ? `Linked: ${mountItem.name}  ·  Control mod ${formatMod(controlMod)}`
    : "Mountable beast — check to drop a mount item";
  slot.innerHTML = renderInnerHTML({ enabled, mountItem, controlMod });

  if (anchor) tagRow.insertBefore(slot, anchor);
  else tagRow.appendChild(slot);

  if (!editable) {
    slot.querySelectorAll("input, a, [data-action]").forEach(el => { el.setAttribute("disabled", ""); el.tabIndex = -1; });
  }

  wireSlot(slot, actor);
});

function formatMod(n) {
  if (!Number.isFinite(n)) return "+0";
  return (n >= 0 ? `+${n}` : `${n}`);
}

function renderInnerHTML({ enabled, mountItem, controlMod }) {
  const checkbox = `
    <input type="checkbox" class="wou-mount-toggle" ${enabled ? "checked" : ""} />
    <i class="fa-solid fa-horse"></i><span class="lbl">Mount</span>
  `;
  if (!enabled) return checkbox;

  if (mountItem) {
    return `
      ${checkbox}
      <span class="wou-mount-sep">·</span>
      <a class="wou-mount-name" data-action="open-mount" title="${escapeAttr(mountItem.name)}">${escapeText(mountItem.name)}</a>
      <span class="wou-mount-mod">Ctrl ${escapeText(formatMod(controlMod))}</span>
      <a class="wou-mount-unlink" data-action="unlink-mount" data-tooltip="Unlink mount"><i class="fa-solid fa-xmark"></i></a>
    `;
  }
  /* Enabled but no mount yet — show a small drop hint */
  return `
    ${checkbox}
    <span class="wou-mount-sep">·</span>
    <span class="wou-mount-drop"><i class="fa-solid fa-arrow-down-to-bracket"></i> drop mount</span>
  `;
}

function wireSlot(slot, actor) {
  /* Checkbox: toggle enabled state.  If un-checking with a linked mount,
   * remove the embedded item too so the bookkeeping stays consistent. */
  const toggle = slot.querySelector(".wou-mount-toggle");
  toggle?.addEventListener("change", async () => {
    const next = !!toggle.checked;
    if (!next) {
      /* unchecking: delete any embedded mount as part of the same action */
      const existing = actor.items.find(i => i.type === "mount");
      if (existing) await existing.delete();
    }
    await actor.setFlag(MODULE_ID, FLAG_PATH, next);
  });

  /* Open mount sheet on name click */
  slot.querySelector('[data-action="open-mount"]')?.addEventListener("click", (e) => {
    e.preventDefault();
    const mount = actor.items.find(i => i.type === "mount");
    mount?.sheet?.render(true);
  });

  /* Unlink — delete the embedded mount; checkbox stays checked */
  slot.querySelector('[data-action="unlink-mount"]')?.addEventListener("click", async (e) => {
    e.preventDefault();
    const mount = actor.items.find(i => i.type === "mount");
    if (mount) await mount.delete();
  });

  /* Drop zone behavior on the whole slot when enabled but no mount yet */
  if (!slot.classList.contains("is-on") || slot.classList.contains("is-linked")) return;

  slot.addEventListener("dragover", (e) => {
    e.preventDefault();
    slot.classList.add("is-drop-target");
  });
  slot.addEventListener("dragleave", () => slot.classList.remove("is-drop-target"));
  slot.addEventListener("drop", async (e) => {
    e.preventDefault();
    slot.classList.remove("is-drop-target");
    const raw = e.dataTransfer?.getData("text/plain");
    if (!raw) return;
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    if (data?.type !== "Item" || !data?.uuid) return;

    const dropped = await fromUuid(data.uuid);
    if (!dropped || dropped.type !== "mount") {
      ui.notifications?.warn("Drop a mount-type item here.");
      return;
    }

    /* Embed a copy on the monster.  If one already exists for some
     * reason, replace it so the slot semantics stay 1:1. */
    const existing = actor.items.find(i => i.type === "mount");
    if (existing) await existing.delete();
    await actor.createEmbeddedDocuments("Item", [dropped.toObject()]);
  });
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
