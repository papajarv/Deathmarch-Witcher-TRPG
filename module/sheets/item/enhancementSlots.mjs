import { t, tFormat } from "../../chrome/lib/i18n.js";
import { ARMOR_LOCATION_COVERAGE } from "../../setup/config.mjs";
import { ZONES, ZONE_LOCATIONS, LOCATION_ZONE, coveredZones } from "../../mechanics/eoArmorModel.mjs";
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
    const totalCap  = Number(item.system?.aeSlots) || 0;
    const glyphCap  = Number(item.system?.enhancementSlots) || 0;
    /* EO body zones — 4 groups (head / torso / arms / legs). An "arms"
     * enhancement covers BOTH arms, "legs" covers both legs. Under the
     * single-budget model, each covered zone shows attached enhancements
     * only; empty drop targets accumulate on the piece's total budget,
     * distributed as one drop slot per covered zone (author picks where
     * to drop; total budget gates the accept). */
    const LABEL = { head: "Head", torso: "Torso", arms: "Arms", legs: "Legs" };
    const LOCATIONS = ZONES;

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

    /* Total-budget model: count enhancements already attached across all
     * zones (excluding glyphs, which are location-agnostic). */
    let totalUsed = 0;
    for (const r of applied) if (r?.location) totalUsed++;
    const budgetLeft = Math.max(0, totalCap - totalUsed);

    /* Per-zone AE groups — one per PHYSICALLY COVERED body zone (SP > 0
     * on at least one underlying limb; see coveredZones() in
     * mechanics/eoArmorModel.mjs). A Steel Breastplate authored as
     * `location: "torso"` has 0 SP on arms → arms zone doesn't render,
     * so the picker never lets the player waste an AE on a place the
     * armor doesn't actually protect.
     *
     * Under the single-total-budget model each zone group shows only
     * what's ATTACHED there (no per-zone denominator — that was
     * misleading; a "0/2" on torso next to "2/2" on arms falsely read
     * as "still room on torso"). The GLOBAL budget indicator is
     * surfaced separately by the template (see spellCfg-adjacent
     * meta / group.budget below). */
    const zones = coveredZones(item);
    /* Per-zone resistance chips — surface ONLY enhancement-added
     * resistances, not the base piece-wide ones. Base resistances are
     * already displayed at the top of the panel and apply to every
     * covered limb; repeating them on each zone chip would falsely
     * imply "this zone was enhanced" when it's actually the whole piece.
     *
     * "Enhancement-added on this zone" = derived resistancesByLoc has
     * the resistance on one of the zone's limbs AND the base item does
     * NOT carry that resistance piece-wide. */
    const resByLoc = item.system?.effective?.resistancesByLoc ?? {};
    const baseRes = {
        slashing:    !!item.system?.slashing,
        piercing:    !!item.system?.piercing,
        bludgeoning: !!item.system?.bludgeoning
    };
    const zoneRes = zone => {
        const limbs = ZONE_LOCATIONS[zone] ?? [];
        const enhanced = key => !baseRes[key] && limbs.some(l => resByLoc[l]?.[key]);
        return {
            slashing:    enhanced("slashing"),
            piercing:    enhanced("piercing"),
            bludgeoning: enhanced("bludgeoning")
        };
    };
    for (const zone of zones) {
        const tagged = [];
        for (let i = 0; i < applied.length; i++) {
            if (applied[i]?.location === zone) tagged.push(renderRef(applied[i], i));
        }
        const slots = [...tagged];
        if (budgetLeft > 0) slots.push({ index: -1, filled: false });
        groups.push({
            kind: "ae",
            location: zone,
            label: LABEL[zone] ?? zone,
            /* `used` = enhancements ATTACHED to this zone; `cap` = -1
             * signals "no per-zone denominator, don't render used/cap"
             * so the template shows just "Torso" without "0/2". Total
             * budget lives on `budget: {used, total}` at group scope
             * (redundantly on each entry so the template's #each block
             * can pull it from group[0] without extra plumbing). */
            cap: -1, used: tagged.length, slots,
            resistances: zoneRes(zone),
            budget: { used: totalUsed, total: totalCap },
            budgetLeft
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
            label: t("WITCHER.Sheet.Item.EnhancementSlots.Dialog.Button.GlyphsEn", `Glyphs (En.)`),
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
    /* Duplicate guard — a WORLD/compendium source is a reusable template, so
     * block re-socketing the same one twice. An ACTOR-embedded source is a
     * physical stack: each drop consumes one copy (see consumeSourceEnhancement),
     * so socketing multiple copies of the same rune/glyph from a stack is
     * allowed and each counts independently (3 Fire runes → Fire ×3, 3 glyphs →
     * three stacking cast bonuses). Consumption bounds it to the stack size. */
    const isActorSource = enh?.parent?.documentName === "Actor";
    if (!isActorSource && applied.some(r => r.uuid === enh.uuid)) {
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
                    /* Armor mod (EO single-budget model): the piece has a
                     * total AE budget; the player picks which body zone
                     * this enhancement lands in at attach time. Refuse
                     * once the total is spent, regardless of zone. */
                    const totalCap  = eo.aeSlotCapTotal(parent);
                    const totalUsed = eo.aeSlotsUsed(parent);
                    if (totalUsed >= totalCap) {
                        ui.notifications?.warn(tFormat(
                            "WITCHER.Notify.Enhance.AeBudgetFull",
                            { used: totalUsed, cap: totalCap },
                            "No AE budget remaining on this piece — {used}/{cap} used."
                        ));
                        return;
                    }
                    /* Zone source priority: strip override > only-covered
                     * (single zone) > picker among covered zones. */
                    if (opts.location) {
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
                /* Bake the stopping bonus FIRST so the slot ref can record
                 * whether the base fields were modified. Order matters: the
                 * ref carries `baked: true` iff bakeEnhancementSP actually
                 * wrote fields, which drives whether detach later unbakes.
                 * Zone-scoped: only limbs of the applied zone get the SP,
                 * per EO p.4 ("only added to the specific body zone"). */
                const baked = await bakeEnhancementSP(parent, enh, location);
                /* EO branch persists the slot ref and skips the RAW total-bucket cap. */
                applied.push(buildSlotRef(enh, location, { baked }));
                await parent.update({ "system.appliedEnhancements": applied });
                await consumeSourceEnhancement(enh, parent);
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
    /* Same bake-then-ref order as the EO branch above — see there. */
    const baked = await bakeEnhancementSP(parent, enh);
    applied.push(buildSlotRef(enh, "", { baked }));
    await parent.update({ "system.appliedEnhancements": applied });
    await consumeSourceEnhancement(enh, parent);
}

/** Build the slot-ref payload written into `parent.system.appliedEnhancements`.
 *  Snapshots the enhancement's `type` + `system` so effective-stats derivation
 *  survives deletion of the source item (attach consumes it) and so detach
 *  can rebuild the item without a fromUuid round-trip.
 *
 *  `baked` records whether this attach path baked the enhancement's stopping
 *  bonus into the parent's base <loc>${t("WITCHER.Sheet.Item.EnhancementSlots.Text.Stopping", "Stopping /")} <loc>MaxStopping fields —
 *  see bakeEnhancementSP below. Detach uses the same flag to know whether
 *  to unbake on removal. */
function buildSlotRef(enh, location, { baked = false } = {}) {
    /* toObject on the system data hands back a plain JSON-safe copy that
     * fits the ObjectField initial. */
    let systemSnap = {};
    try { systemSnap = enh.system?.toObject?.() ?? foundry.utils.deepClone(enh.system ?? {}); }
    catch (_) { systemSnap = {}; }
    /* Exactly ONE enhancement is socketed even when the source was a stack —
     * normalize the snapshot so detach later recreates a single copy, not the
     * whole stack. (consumeSourceEnhancement decrements the source stack.) */
    if (systemSnap && typeof systemSnap === "object") systemSnap.quantity = 1;
    return {
        uuid:     enh.uuid,
        name:     enh.name,
        img:      enh.img,
        location,
        type:     String(enh.system?.type ?? enh.type ?? ""),
        system:   systemSnap,
        baked
    };
}

/** Bake the enhancement's `stopping` bonus into the parent armor/shield's
 *  base per-location Stopping + MaxStopping fields, so the combined pool is
 *  what drains under damage. When the armor hits 0 base SP, it truly has 0
 *  SP (the derived-modifier model this replaces would still show enhancement
 *  bonus on top of a fully-ablated piece). Weapons don't have current-vs-
 *  max SP semantics, so this is a no-op there.
 *
 *  Applies to every covered location where MaxStopping > 0 — matching the
 *  guard `deriveArmorEffective` uses to decide "is this a real SP slot on
 *  this piece". Returns true iff any field was written (drives the `baked`
 *  flag on the slot ref). */
async function bakeEnhancementSP(parent, enh, zoneKey = null) {
    if (parent?.type !== "armor" && parent?.type !== "shield") return false;
    const bonus = Number(enh.system?.stopping) || 0;
    if (bonus <= 0) return false;
    const coverage = ARMOR_LOCATION_COVERAGE[parent.system?.location] ?? [];
    if (!coverage.length) return false;
    /* EO zone-scoping: SP flows only to the limbs of the applied zone.
     * Null zoneKey (RAW single-bucket path OR shield) preserves the
     * legacy "add to every covered location" behavior. Zone-scoped
     * bake intersects the zone's limbs with the parent's coverage —
     * e.g. baking a zone="arms" enhancement onto a hauberk (torso +
     * arms) writes only to leftArm/rightArm, not torso. */
    const applyLocs = zoneKey
        ? (ZONE_LOCATIONS[zoneKey] ?? []).filter(l => coverage.includes(l))
        : coverage;
    const updates = {};
    for (const loc of applyLocs) {
        const maxField = `${loc}MaxStopping`;
        const valField = `${loc}Stopping`;
        const curMax = Number(parent.system?.[maxField]) || 0;
        if (curMax <= 0) continue;
        const curVal = Number(parent.system?.[valField]) || 0;
        updates[`system.${maxField}`] = curMax + bonus;
        updates[`system.${valField}`] = curVal + bonus;
    }
    if (!Object.keys(updates).length) return false;
    await parent.update(updates);
    return true;
}

/** Reverse of bakeEnhancementSP — subtracts the stored bonus off each covered
 *  location's current + max. Clamped at 0: if the armor was drained past the
 *  enhancement's contribution before detach, current can't go negative. Only
 *  called for slots that have `baked: true` on their ref. */
async function unbakeEnhancementSP(parent, snapshot, zoneKey = null) {
    if (parent?.type !== "armor" && parent?.type !== "shield") return;
    const bonus = Number(snapshot?.stopping) || 0;
    if (bonus <= 0) return;
    const coverage = ARMOR_LOCATION_COVERAGE[parent.system?.location] ?? [];
    if (!coverage.length) return;
    /* Mirror bakeEnhancementSP's zone-scoping. Detach passes the ref's
     * stored zone (its `location` tag) so the SP unbakes from the same
     * limbs it was originally added to. Null zoneKey preserves the
     * legacy piece-wide behavior for RAW single-bucket entries. */
    const applyLocs = zoneKey
        ? (ZONE_LOCATIONS[zoneKey] ?? []).filter(l => coverage.includes(l))
        : coverage;
    const updates = {};
    for (const loc of applyLocs) {
        const maxField = `${loc}MaxStopping`;
        const valField = `${loc}Stopping`;
        const curMax = Number(parent.system?.[maxField]) || 0;
        if (curMax <= 0) continue;
        const curVal = Number(parent.system?.[valField]) || 0;
        updates[`system.${maxField}`] = Math.max(0, curMax - bonus);
        updates[`system.${valField}`] = Math.max(0, curVal - bonus);
    }
    if (Object.keys(updates).length) await parent.update(updates);
}

/** Post-attach cleanup: if the dropped enhancement was embedded on an
 *  actor, delete it — the enhancement is now materially part of the
 *  parent item (per RAW: runes/glyphs fuse in, craftsman mods are worked
 *  into the piece). Compendium and world sources are left alone (they're
 *  the template, not the dropped instance). Best-effort applied/attachedTo
 *  bump for non-embedded sources so the enhancement's own sheet still
 *  shows "attached to X". */
async function consumeSourceEnhancement(enh, parent) {
    const parentDoc = enh?.parent;
    /* Embedded on an actor → the actor's inventory copy is what the
     * player dragged; consume ONE. A stack (quantity > 1) is decremented so
     * the remaining copies stay in inventory (only one socketed per drop);
     * the last copy is deleted. */
    if (parentDoc && parentDoc.documentName === "Actor") {
        const qty = Number(enh.system?.quantity) || 1;
        try {
            if (qty > 1) await enh.update({ "system.quantity": qty - 1 });
            else         await enh.delete();
        } catch (err) { console.warn("witcher-ttrpg-death-march | enhancement consume failed", err); }
        return;
    }
    /* World / compendium source — leave it in place, just mark it. */
    try { await enh.update({ "system.applied": true, "system.attachedTo": parent.uuid }); }
    catch (_) { /* not editable */ }
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
    const html = `<p>${t("WITCHER.Sheet.Item.EnhancementSlots.Text.Socket", "Socket")} <strong>${enhName}</strong> on which body location of <strong>${armorName}</strong>?</p>
                  <p style="opacity:.7;font-size:0.6875rem;margin:4px 0 8px 0;">
                  Each armor piece tracks AE slots per covered body location (EO p.4). The chosen location's slot will be charged.</p>
                  <select name="loc" autofocus>${opts}</select>`;
    try {
        const choice = await DialogV2.prompt({
            window: { title: t("WITCHER.Dialog.Enhance.PickLocation", "Pick AE Location") },
            content: html,
            ok: {
                label: t("WITCHER.Sheet.Item.EnhancementSlots.Dialog.Button.Socket", "Socket"),
                callback: (_event, button) => button.form.elements.loc?.value || ""
            },
            rejectClose: false
        });
        return choice ?? "";
    } catch (_) {
        return "";
    }
}

/** Detach the slot at `index`.
 *
 *  Runes/glyphs are RAW-permanent — a warn-and-destroy flow.
 *  Craftsman mods (`type: "weapon"` / `"armor"`) can be worked back out; if
 *  the parent item lives on an actor, recreate the enhancement in the
 *  actor's inventory from the snapshot so nothing is lost.
 *  Returns true if a detach happened. */
export async function detachEnhancement(parent, index) {
    const applied = foundry.utils.deepClone(parent.system?.appliedEnhancements ?? []);
    if (!Number.isInteger(index) || index < 0 || index >= applied.length) return false;
    const ref = applied[index];

    /* Kind resolution: snapshot type is authoritative (source may be gone
     * because attach consumed it); fall back to uuid resolve for legacy
     * slots that lack a snapshot. */
    let kind = String(ref?.type ?? "");
    let live = null;
    if (!kind && ref?.uuid) {
        try { live = await fromUuid(ref.uuid); } catch (_) { live = null; }
        kind = String(live?.system?.type ?? "");
    }

    if (kind === "rune" || kind === "glyph") {
        const ok = await foundry.applications.api.DialogV2.confirm({
            window: { title: t("WITCHER.Dialog.Enhance.Remove", "Remove Enhancement") },
            content: `<p>${t("WITCHER.Sheet.Item.EnhancementSlots.Text.RemovingA", "Removing a")} <strong>${kind}</strong> destroys it (Rune/Glyph bonding is permanent per the rules). Continue?</p>`
        });
        if (!ok) return false;
    }

    applied.splice(index, 1);
    await parent.update({ "system.appliedEnhancements": applied });

    /* Unbake the stopping bonus off the parent's base fields — only for
     * slots that carry `baked: true`. Legacy slots (pre-bake schema) never
     * had their bonus baked into base, so subtracting here would be a
     * double-decrement. Runs after the appliedEnhancements write so a
     * mid-flight prep can't see the ref removed while the base still
     * carries its contribution. */
    if (ref?.baked) {
        try { await unbakeEnhancementSP(parent, ref.system, ref.location || null); }
        catch (err) { console.warn("witcher-ttrpg-death-march | enhancement unbake failed", err); }
    }

    /* Craftsman mods are recoverable — recreate on the parent item's actor
     * (if any). Prefer the snapshot; fall back to the live source's data
     * for legacy slots that pre-date the snapshot schema. Runes/glyphs are
     * destroyed above and SHOULD NOT be recreated. If the parent is a
     * world/compendium item with no actor, there's nowhere to give the
     * mod back to — drop it. */
    if ((kind === "weapon" || kind === "armor") && parent?.actor) {
        let systemSrc = ref?.system;
        if ((!systemSrc || Object.keys(systemSrc).length === 0) && live) {
            try { systemSrc = live.system?.toObject?.() ?? foundry.utils.deepClone(live.system ?? {}); }
            catch (_) { systemSrc = null; }
        }
        if (systemSrc && Object.keys(systemSrc).length > 0) {
            try {
                await parent.actor.createEmbeddedDocuments("Item", [{
                    name:   ref.name || live?.name || "Enhancement",
                    type:   "enhancement",
                    img:    ref.img  || live?.img  || "icons/svg/upgrade.svg",
                    system: { ...systemSrc, applied: false, attachedTo: "" }
                }]);
            } catch (err) {
                console.warn("witcher-ttrpg-death-march | enhancement recreate on detach failed", err);
            }
        }
    }

    /* Legacy path: back-reference bump on a still-resident source item
     * (world enhancement without a snapshot). No-op after the schema
     * migration has taken. */
    if (live) {
        try { await live.update({ "system.applied": false, "system.attachedTo": "" }); }
        catch (_) { /* not editable */ }
    }
    return true;
}
