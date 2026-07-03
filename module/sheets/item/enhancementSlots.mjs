import { t, tFormat } from "../../chrome/lib/i18n.js";
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

/** Build the EO-split slot-group list for an armor piece. Returns one
 *  group per covered location with `aeSlots > 0`, plus one group for
 *  the total glyph (En.) pool when `enhancementSlots > 0`. Each group
 *  carries:
 *
 *    { kind: "ae" | "glyph", location?: string, label: string,
 *      cap: number, used: number, slots: [{ index, filled, ... }] }
 *
 *  The `slots[i].index` references the GLOBAL applied-enhancement array
 *  index — the detach button keeps working with the existing
 *  `detachEnhancement(item, idx)` call. Empty (drop-target) slots have
 *  no index (they're not yet in the array); the drop handler matches
 *  the dropped enhancement against the group's pool. */
export function buildEnhancementSlotGroups(item) {
    const applied = item.system?.appliedEnhancements ?? [];
    const aeSlots  = item.system?.aeSlots ?? {};
    const glyphCap = Number(item.system?.enhancementSlots) || 0;
    const LABEL = { head: "Head", torso: "Torso",
                    leftArm: "Left Arm", rightArm: "Right Arm",
                    leftLeg: "Left Leg", rightLeg: "Right Leg" };
    const LOCATIONS = ["head", "torso", "leftArm", "rightArm", "leftLeg", "rightLeg"];

    /* Resolve a slot ref to its rendered fields (live name/img > cached). */
    const renderRef = (ref, index) => {
        if (!ref?.uuid) return { index, filled: false };
        let name = ref.name, img = ref.img;
        if (typeof fromUuidSync === "function") {
            try { const d = fromUuidSync(ref.uuid); if (d) { name = d.name; img = d.img; } } catch (_) { /* unresolved */ }
        }
        return { index, filled: true, uuid: ref.uuid, name: name || ref.name || "?", img: img || ref.img || "icons/svg/upgrade.svg" };
    };

    const groups = [];

    /* Per-location AE groups, in body-order so the strip reads top-to-bottom. */
    for (const loc of LOCATIONS) {
        const cap = Number(aeSlots[loc]) || 0;
        if (cap <= 0) continue;
        /* Find applied entries tagged to this location. */
        const tagged = [];
        for (let i = 0; i < applied.length; i++) {
            if (applied[i]?.location === loc) tagged.push(renderRef(applied[i], i));
        }
        const slots = [...tagged];
        while (slots.length < cap) slots.push({ index: -1, filled: false });
        groups.push({
            kind: "ae",
            location: loc,
            label: `AE: ${LABEL[loc] ?? loc}`,
            cap, used: tagged.length, slots
        });
    }

    /* Glyph pool — one group, location-agnostic. */
    if (glyphCap > 0) {
        const tagged = [];
        for (let i = 0; i < applied.length; i++) {
            const ref = applied[i];
            /* Glyph entries are those WITHOUT a location tag. */
            if (ref && !ref.location) tagged.push(renderRef(ref, i));
        }
        const slots = [...tagged];
        while (slots.length < glyphCap) slots.push({ index: -1, filled: false });
        groups.push({
            kind: "glyph",
            location: "",
            label: `Glyphs (En.)`,
            cap: glyphCap, used: tagged.length, slots
        });
    }

    return groups;
}

/** Wire dragover/drop on the slot strip and detach buttons. Call from the
 *  sheet's `_onRender`. `targetType` is "weapon" or "armor". The drop
 *  reads an optional `data-enh-pool` / `data-enh-location` from the
 *  strip element so an EO-split sheet can route the drop to a specific
 *  pool without the picker firing. */
export function wireEnhancementSlots(sheet, targetType) {
    if (!sheet.isEditable) return;
    const root = sheet.element;
    root.querySelectorAll("[data-enh-slots]").forEach(strip => {
        strip.addEventListener("dragover", ev => { ev.preventDefault(); strip.classList.add("is-drop-target"); });
        strip.addEventListener("dragleave", () => strip.classList.remove("is-drop-target"));
        strip.addEventListener("drop", async ev => {
            ev.preventDefault();
            strip.classList.remove("is-drop-target");
            const pool     = strip.dataset?.enhPool ?? "";       // "ae" | "glyph" | ""
            const location = strip.dataset?.enhLocation ?? "";   // body-loc key when ae
            await handleEnhancementDrop(sheet.item, ev, targetType, { pool, location });
        });
    });
}

/** Resolve a drop event to an enhancement item, validate it, and socket it.
 *  `opts.pool` ("ae" | "glyph" | "") and `opts.location` (body-loc key)
 *  let the caller indicate which slot strip the drop landed on, which
 *  pins the routing instead of asking the picker. */
export async function handleEnhancementDrop(parent, event, targetType, opts = {}) {
    let data;
    try { data = JSON.parse(event.dataTransfer.getData("text/plain")); } catch (_) { return; }
    if (data?.type !== "Item" || !data.uuid) return;
    const enh = await fromUuid(data.uuid);
    if (!enh || enh.type !== "enhancement") {
        ui.notifications?.warn(t("WITCHER.Notify.Enhance.NotEnhancement", "Only enhancement items (runes, glyphs, mods) can be socketed."));
        return;
    }
    if (enh.system.target !== targetType) {
        ui.notifications?.warn(tFormat("WITCHER.Notify.Enhance.WrongTarget", { src: enh.system.target === "weapon" ? "weapon" : "armor", dst: targetType === "weapon" ? "a weapon" : "armor" }, "That {src} enhancement can't go on {dst}."));
        return;
    }
    const applied = foundry.utils.deepClone(parent.system?.appliedEnhancements ?? []);
    if (applied.some(r => r.uuid === enh.uuid)) {
        ui.notifications?.warn(t("WITCHER.Notify.Enhance.AlreadySocketed", "That enhancement is already socketed here."));
        return;
    }

    /* EO armor model: split into the glyph pool (En. slots) and the
     * per-location AE pool. Weapons keep the legacy single-bucket flow
     * regardless of the EO toggle — EO only restructures ARMOR slot
     * accounting. Lazy-load the helpers so this module stays loadable
     * in pure-node test contexts (the EO module depends on game). */
    let location = "";
    if (targetType === "armor") {
        try {
            const eo = await import("../../mechanics/eoArmorModel.mjs");
            if (eo.isEoArmorModelOn()) {
                /* Pre-flight: when the strip declares a pool, the dropped
                 * enhancement must match it. A glyph dropped on an AE strip
                 * (or vice-versa) is rejected with a clear message. */
                if (opts.pool === "glyph" && !eo.isGlyph(enh)) {
                    ui.notifications?.warn(t("WITCHER.Notify.Enhance.GlyphOnly", `Glyph slots only accept glyph-type enhancements.`));
                    return;
                }
                if (opts.pool === "ae" && !eo.isPerLocationAe(enh)) {
                    ui.notifications?.warn(t("WITCHER.Notify.Enhance.AeOnly", `AE slots only accept armor-mod-type enhancements.`));
                    return;
                }
                if (eo.isGlyph(enh)) {
                    /* Glyph: check the total En. pool. */
                    const cap  = eo.glyphSlotCap(parent);
                    const used = eo.glyphSlotsUsed(parent);
                    if (used >= cap) {
                        ui.notifications?.warn(tFormat("WITCHER.Notify.Enhance.EnFull", { used: used, cap: cap }, "No free Enchantment (En.) slots — {used}/{cap} used."));
                        return;
                    }
                    /* Location stays "" — glyphs are location-agnostic. */
                } else if (eo.isPerLocationAe(enh)) {
                    /* Armor mod: location source priority — strip override
                     * > only-free > picker. */
                    if (opts.location) {
                        /* Verify the strip's location actually has a free slot.
                         * Defensive — the user may have stale UI. */
                        const cap  = eo.aeSlotCap(parent, opts.location);
                        const used = eo.aeSlotsUsed(parent, opts.location);
                        if (used >= cap) {
                            ui.notifications?.warn(tFormat("WITCHER.Notify.Enhance.AeFull", { loc: opts.location, used: used, cap: cap }, "No free AE slots at {loc} — {used}/{cap} used."));
                            return;
                        }
                        location = opts.location;
                    } else {
                        const free = eo.locationsWithFreeAeSlots(parent);
                        if (free.length === 0) {
                            ui.notifications?.warn(t("WITCHER.Notify.Enhance.AeFullAny", `No free AE slots on any covered location.`));
                            return;
                        }
                        if (free.length === 1) {
                            location = free[0].key;
                        } else {
                            location = await promptLocation(parent.name, enh.name, free);
                            if (!location) return;   /* user cancelled */
                        }
                    }
                } else {
                    /* Future enhancement types — fall back to a no-cap attach
                     * with a warning, so unknown enhancement kinds still socket
                     * (RAW behavior) but the GM sees the unrecognized type. */
                    console.warn("witcher-ttrpg-death-march | unknown enhancement type for EO accounting:", enh.system?.type);
                }
                /* EO branch persists the slot ref and skips the RAW total-bucket cap. */
                applied.push({ uuid: enh.uuid, name: enh.name, img: enh.img, location });
                await parent.update({ "system.appliedEnhancements": applied });
                try { await enh.update({ "system.applied": true, "system.attachedTo": parent.uuid }); } catch (_) { /* not editable */ }
                return;
            }
        } catch (err) {
            console.warn("witcher-ttrpg-death-march | EO slot enforcement skipped", err);
            /* Fall through to the RAW single-bucket path. */
        }
    }

    /* RAW (or EO disabled): single `armorEnhancement` / `weaponEnhancement`
     * bucket. */
    const slotCount = Number(parent.system?.[targetType === "weapon" ? "weaponEnhancement" : "armorEnhancement"]) || 0;
    if (applied.length >= slotCount) {
        ui.notifications?.warn(t("WITCHER.Notify.Enhance.NoSlots", "No free enhancement slots."));
        return;
    }
    applied.push({ uuid: enh.uuid, name: enh.name, img: enh.img, location: "" });
    await parent.update({ "system.appliedEnhancements": applied });
    // Best-effort back-reference on the enhancement (skip if not editable,
    // e.g. a compendium source).
    try { await enh.update({ "system.applied": true, "system.attachedTo": parent.uuid }); } catch (_) { /* not editable */ }
}

/** Show a DialogV2 picker listing covered locations with free AE slots.
 *  Returns the chosen location key, or "" if the user cancels. */
async function promptLocation(armorName, enhName, freeList) {
    const LABEL = { head: "Head", torso: "Torso",
                    leftArm: "Left Arm", rightArm: "Right Arm",
                    leftLeg: "Left Leg", rightLeg: "Right Leg" };
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2) return freeList[0]?.key ?? "";
    const opts = freeList.map(({ key, used, cap }) =>
        `<option value="${key}">${LABEL[key] ?? key} (${used}/${cap} used)</option>`
    ).join("");
    const html = `<p>Socket <strong>${enhName}</strong> on which body location of <strong>${armorName}</strong>?</p>
                  <p style="opacity:.7;font-size:0.6875rem;margin:4px 0 8px 0;">
                  Each armor piece tracks AE slots per covered body location (EO p.4). The chosen location's slot will be charged.</p>
                  <select name="loc" autofocus>${opts}</select>`;
    try {
        const choice = await DialogV2.prompt({
            window: { title: t("WITCHER.Dialog.Enhance.PickLocation", "Pick AE Location") },
            content: html,
            ok: {
                label: "Socket",
                callback: (_event, button) => button.form.elements.loc?.value || ""
            },
            rejectClose: false
        });
        return choice ?? "";
    } catch (_) {
        return "";
    }
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
            window: { title: t("WITCHER.Dialog.Enhance.Remove", "Remove Enhancement") },
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
