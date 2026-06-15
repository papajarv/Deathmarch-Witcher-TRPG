/**
 * Enhancement-slot UI helpers — shared by the weapon and armor sheets.
 *
 * A weapon/armor exposes N enhancement slots (`weaponEnhancement` /
 * `armorEnhancement`). Players socket Rune/Glyph/mod items by dragging
 * them onto a slot; the slot stores a `{uuid, name, img}` reference in the
 * parent's `appliedEnhancements`, and the parent recomputes its effective
 * stats from the live enhancement in prepareDerivedData.
 *
 * Detaching a Rune or Glyph is permanent per RAW (they're fused into the
 * gear), so detach prompts a confirmation for those two kinds; craftsman
 * weapon/armor mods detach freely.
 */

/** Build the fixed-length slot list for a parent item. The first
 *  `appliedEnhancements.length` slots are filled; the rest render empty
 *  drop targets up to `slotCount`. */
export function buildEnhancementSlots(item, slotCount) {
    const applied = item.system?.appliedEnhancements ?? [];
    const count   = Math.max(Number(slotCount) || 0, applied.length);
    const slots = [];
    for (let i = 0; i < count; i++) {
        const ref = applied[i];
        if (ref?.uuid) {
            // Prefer the live item's current name/img; fall back to the cache.
            let name = ref.name, img = ref.img;
            if (typeof fromUuidSync === "function") {
                try { const d = fromUuidSync(ref.uuid); if (d) { name = d.name; img = d.img; } } catch (_) { /* unresolved */ }
            }
            slots.push({ index: i, filled: true, uuid: ref.uuid, name: name || ref.name || "?", img: img || ref.img || "icons/svg/upgrade.svg" });
        } else {
            slots.push({ index: i, filled: false });
        }
    }
    return slots;
}

/** Wire dragover/drop on the slot strip and detach buttons. Call from the
 *  sheet's `_onRender`. `targetType` is "weapon" or "armor". */
export function wireEnhancementSlots(sheet, targetType) {
    if (!sheet.isEditable) return;
    const root = sheet.element;
    root.querySelectorAll("[data-enh-slots]").forEach(strip => {
        strip.addEventListener("dragover", ev => { ev.preventDefault(); strip.classList.add("is-drop-target"); });
        strip.addEventListener("dragleave", () => strip.classList.remove("is-drop-target"));
        strip.addEventListener("drop", async ev => {
            ev.preventDefault();
            strip.classList.remove("is-drop-target");
            await handleEnhancementDrop(sheet.item, ev, targetType);
        });
    });
}

/** Resolve a drop event to an enhancement item, validate it, and socket it. */
export async function handleEnhancementDrop(parent, event, targetType) {
    let data;
    try { data = JSON.parse(event.dataTransfer.getData("text/plain")); } catch (_) { return; }
    if (data?.type !== "Item" || !data.uuid) return;
    const enh = await fromUuid(data.uuid);
    if (!enh || enh.type !== "enhancement") {
        ui.notifications?.warn("Only enhancement items (runes, glyphs, mods) can be socketed.");
        return;
    }
    if (enh.system.target !== targetType) {
        ui.notifications?.warn(`That ${enh.system.target === "weapon" ? "weapon" : "armor"} enhancement can't go on ${targetType === "weapon" ? "a weapon" : "armor"}.`);
        return;
    }
    const slotCount = Number(parent.system?.[targetType === "weapon" ? "weaponEnhancement" : "armorEnhancement"]) || 0;
    const applied   = foundry.utils.deepClone(parent.system?.appliedEnhancements ?? []);
    if (applied.length >= slotCount) {
        ui.notifications?.warn("No free enhancement slots.");
        return;
    }
    if (applied.some(r => r.uuid === enh.uuid)) {
        ui.notifications?.warn("That enhancement is already socketed here.");
        return;
    }
    applied.push({ uuid: enh.uuid, name: enh.name, img: enh.img });
    await parent.update({ "system.appliedEnhancements": applied });
    // Best-effort back-reference on the enhancement (skip if not editable,
    // e.g. a compendium source).
    try { await enh.update({ "system.applied": true, "system.attachedTo": parent.uuid }); } catch (_) { /* not editable */ }
}

/** Detach the slot at `index`. Runes/glyphs warn (RAW-permanent) before
 *  removal. Returns true if a detach happened. */
export async function detachEnhancement(parent, index) {
    const applied = foundry.utils.deepClone(parent.system?.appliedEnhancements ?? []);
    if (!Number.isInteger(index) || index < 0 || index >= applied.length) return false;
    const ref = applied[index];

    let enh = null;
    try { enh = ref?.uuid ? await fromUuid(ref.uuid) : null; } catch (_) { enh = null; }
    const kind = enh?.system?.type ?? "";
    if (kind === "rune" || kind === "glyph") {
        const ok = await foundry.applications.api.DialogV2.confirm({
            window: { title: "Remove Enhancement" },
            content: `<p>Removing a <strong>${kind}</strong> destroys it (Rune/Glyph bonding is permanent per the rules). Continue?</p>`
        });
        if (!ok) return false;
    }

    applied.splice(index, 1);
    await parent.update({ "system.appliedEnhancements": applied });
    if (enh) {
        try { await enh.update({ "system.applied": false, "system.attachedTo": "" }); } catch (_) { /* not editable */ }
    }
    return true;
}
