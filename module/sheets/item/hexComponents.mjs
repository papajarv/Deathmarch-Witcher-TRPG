/**
 * Castable-component link helpers — a hex / ritual lists the materials it
 * needs as links to real items of any type, each with a quantity. Stored on
 * the item as `system.components` = [{ uuid, name, img, qty }]. Players drag
 * any item onto the drop zone (dropping the same item again bumps its qty);
 * the qty input edits the count and the × removes the row. There's no fixed
 * count and no type restriction.
 */

/** Resolve the stored component refs to a render-ready list, preferring the
 *  live item's current name/img and falling back to the cached copy. */
export function buildComponentLinks(item) {
    const refs = item.system?.components ?? [];
    return refs.map((ref, index) => {
        let name = ref.name, img = ref.img;
        if (ref?.uuid && typeof fromUuidSync === "function") {
            try { const d = fromUuidSync(ref.uuid); if (d) { name = d.name; img = d.img; } } catch (_) { /* unresolved */ }
        }
        return {
            index,
            uuid: ref.uuid,
            name: name || ref.name || "?",
            img:  img  || ref.img  || "icons/svg/item-bag.svg",
            qty:  Math.max(1, Math.floor(Number(ref.qty) || 1))
        };
    });
}

/** Wire dragover/drop on the component zone. Call from the sheet's `_onRender`. */
export function wireComponentDrop(sheet) {
    if (!sheet.isEditable) return;
    const root = sheet.element;
    root.querySelectorAll("[data-component-drop]").forEach(zone => {
        zone.addEventListener("dragover", ev => { ev.preventDefault(); zone.classList.add("is-drop-target"); });
        zone.addEventListener("dragleave", () => zone.classList.remove("is-drop-target"));
        zone.addEventListener("drop", async ev => {
            ev.preventDefault();
            zone.classList.remove("is-drop-target");
            await handleComponentDrop(sheet.item, ev);
            sheet.render({ force: false });
        });
    });
    // Editable per-row quantity (no form `name=` — managed here so the
    // wholesale array rewrite preserves uuid/name/img).
    root.querySelectorAll("[data-component-qty]").forEach(input => {
        input.addEventListener("change", async ev => {
            const idx = Number(ev.target.closest("[data-component-index]")?.dataset.componentIndex);
            if (await setComponentQty(sheet.item, idx, ev.target.value)) sheet.render({ force: false });
        });
    });
}

/** Resolve a drop event to any Item and link it as a component. Dropping an
 *  item that's already listed bumps its quantity instead of duplicating. */
export async function handleComponentDrop(host, event) {
    let data;
    try { data = JSON.parse(event.dataTransfer.getData("text/plain")); } catch (_) { return; }
    if (data?.type !== "Item" || !data.uuid) return;
    const item = await fromUuid(data.uuid);
    if (!item) return;
    const links = foundry.utils.deepClone(host.system?.components ?? []);
    const existing = links.find(r => r.uuid === item.uuid);
    if (existing) {
        existing.qty = (Math.max(1, Math.floor(Number(existing.qty) || 1))) + 1;
    } else {
        links.push({ uuid: item.uuid, name: item.name, img: item.img, qty: 1 });
    }
    await host.update({ "system.components": links });
}

/** Set the quantity of the component at `index`. Returns true if it changed. */
export async function setComponentQty(host, index, qty) {
    const links = foundry.utils.deepClone(host.system?.components ?? []);
    if (!Number.isInteger(index) || index < 0 || index >= links.length) return false;
    const n = Math.max(1, Math.floor(Number(qty) || 1));
    if (links[index].qty === n) return false;
    links[index].qty = n;
    await host.update({ "system.components": links });
    return true;
}

/** Remove the component link at `index`. Returns true if one was removed. */
export async function removeComponent(host, index) {
    const links = foundry.utils.deepClone(host.system?.components ?? []);
    if (!Number.isInteger(index) || index < 0 || index >= links.length) return false;
    links.splice(index, 1);
    await host.update({ "system.components": links });
    return true;
}
