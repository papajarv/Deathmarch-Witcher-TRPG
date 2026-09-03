/**
 * Combat Extended — Raise Shield dialog.
 *
 * Opens from the dock's per-shield "Raise Shield" button. Surfaces the
 * shield's Cover Value (CV) and an INTERACTIVE BODY-FIGURE picker:
 *
 *   - Click a body zone to toggle it on/off
 *   - Constraints enforced live, with visual feedback per zone:
 *       selected    — amber-filled (clickable: remove)
 *       eligible    — subtle highlight (clickable: add — adjacent to
 *                     an already-selected zone, or any zone when none
 *                     are selected yet)
 *       capped      — dimmed (CV limit reached; click to deselect to
 *                     free up a slot, or click an existing selection
 *                     to swap)
 *       bridge      — selected but locked (deselecting would break
 *                     adjacency; remove the leaves first)
 *   - Live status: "Covering X of CV" + a "Reset" button
 *
 * Confirm writes `system.guard.shieldRaised` and (if head was covered)
 * applies the `restrictedVision` status. Lower clears the state.
 *
 * Spends a Special Action slot on a fresh raise (movement → action →
 * extra priority). Coverage-only edits on an already-raised shield
 * don't re-spend a slot.
 */

const SYSTEM_ID = "witcher-ttrpg-death-march";

import { HIT_LOCATION_ADJACENCY } from "../data/combatExtended/guards.mjs";
import { pickSpecialActionSlot } from "./specialActionSlotPicker.mjs";
import { ceTuneable } from "../api/homebrew.mjs";

import { t, tFormat } from "../chrome/lib/i18n.js";
const HIT_LOCATIONS = ["head", "torso", "leftArm", "rightArm", "leftLeg", "rightLeg"];
const LOCATION_LABEL = {
    head:     "Head",
    torso:    "Torso",
    leftArm:  "Left Arm",
    rightArm: "Right Arm",
    leftLeg:  "Left Leg",
    rightLeg: "Right Leg"
};

/* SVG path data for each body zone — mirrors the dock's sp-figure paths
 * so the player gets a consistent anatomy across the system. */
const ZONE_PATHS = Object.freeze({
    head:     "M 38 4 Q 32 4 32 18 Q 32 32 36 36 L 36 42 L 64 42 L 64 36 Q 68 32 68 18 Q 68 4 62 4 Z",
    torso:    "M 30 44 L 70 44 L 66 116 L 34 116 Z",
    rightArm: "M 8 46 L 26 46 L 22 116 L 12 116 Z",
    leftArm:  "M 74 46 L 92 46 L 88 116 L 78 116 Z",
    rightLeg: "M 30 120 L 48 120 L 46 210 L 32 210 Z",
    leftLeg:  "M 52 120 L 70 120 L 68 210 L 54 210 Z"
});

const esc = (s) => String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const L = (k) => game.i18n?.localize?.(k) ?? k;

/* Breadth-first contiguity check across the adjacency graph. Empty / one-
 * element sets are trivially contiguous. */
function isContiguous(set) {
    if (set.size <= 1) return true;
    const seed = set.values().next().value;
    const visited = new Set([seed]);
    const queue = [seed];
    while (queue.length) {
        const cur = queue.shift();
        for (const adj of HIT_LOCATION_ADJACENCY[cur] ?? []) {
            if (set.has(adj) && !visited.has(adj)) {
                visited.add(adj);
                queue.push(adj);
            }
        }
    }
    return visited.size === set.size;
}

/* Per-zone state given the current selection + CV cap. Drives the
 * CSS class applied to each <path>. */
function zoneState(loc, selected, cv) {
    if (selected.has(loc)) {
        /* Bridge check: deselecting this zone must leave the remaining
         * set contiguous (or empty). */
        const after = new Set(selected); after.delete(loc);
        return isContiguous(after) ? "selected" : "bridge";
    }
    /* Not selected — eligible only if (a) selection is empty (seed
     * any), OR (b) under cap AND adjacent to an existing selection. */
    if (selected.size >= cv) return "capped";
    if (selected.size === 0) return "eligible";
    for (const s of selected) {
        if ((HIT_LOCATION_ADJACENCY[loc] ?? []).includes(s)) return "eligible";
    }
    return "capped";
}

const SVG_NS = "http://www.w3.org/2000/svg";

/* Build the SVG body PROGRAMMATICALLY in the render callback (called
 * after DialogV2 inserts the content into the DOM). The earlier
 * template-literal approach was stripped by Foundry's content sanitizer
 * — `<svg>` and its children survived parsing but didn't make it into
 * the live DOM, leaving the figwrap as an empty amber column.
 * createElementNS bypasses sanitization entirely. */
function injectBodyFigure(wrap) {
    if (!wrap || wrap.querySelector("svg")) return;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "wdm-rs-figure");
    svg.setAttribute("width", "160");
    svg.setAttribute("height", "320");
    svg.setAttribute("viewBox", "0 0 100 220");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.setAttribute("aria-label", t("WITCHER.App.RaiseShieldDialog.Text.BodyZonesClickToCoverWithShield", "Body zones — click to cover with shield"));
    for (const loc of HIT_LOCATIONS) {
        const path = document.createElementNS(SVG_NS, "path");
        path.setAttribute("class", "wdm-rs-zone");
        path.setAttribute("data-loc", loc);
        path.setAttribute("d", ZONE_PATHS[loc]);
        /* Presentation attributes — these are SVG defaults; CSS classes
         * (.is-selected etc) override them via specificity. */
        path.setAttribute("fill", "#1a1612");
        path.setAttribute("stroke", "#6e5224");
        path.setAttribute("stroke-width", "1.2");
        path.style.cursor = "pointer";
        path.style.pointerEvents = "all";
        const title = document.createElementNS(SVG_NS, "title");
        title.textContent = LOCATION_LABEL[loc];
        path.appendChild(title);
        svg.appendChild(path);
    }
    wrap.appendChild(svg);
}

/* @param {Actor} actor — the shield wielder
 * @param {Item}  shield — the shield item being raised */
export async function openRaiseShieldDialog(actor, shield) {
    if (!actor || !shield || shield.type !== "shield") return null;
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2) { ui.notifications?.warn(t("WITCHER.Notify.RaiseShield.RequiresDialogV2", "Raise Shield requires DialogV2 (Foundry v13+).")); return null; }

    const cv = Math.max(0, Number(shield.system?.coverValue) || 0);
    const sr = actor.system?.guard?.shieldRaised ?? {};
    const alreadyRaised = sr.itemId === shield.id;
    const inCombat = !!actor._inActiveCombat;

    /* CV 0 — shield can't cover anything. Short-circuit with a hint. */
    if (cv <= 0) {
        return await DialogV2.wait({
            window: { title: tFormat("WITCHER.Dialog.RaiseShield.Title", { shield: shield.name }, "Raise Shield — {shield}"), icon: "fa-solid fa-shield" },
            content: `<p>${t("WITCHER.App.RaiseShieldDialog.Text.ThisShieldHasACoverValueOf0SetItsCVOnThe", "This shield has a Cover Value of 0. Set its CV on the shield item sheet (Combat Extended).")}</p>`,
            buttons: [{ action: "ok", label: "OK", default: true }],
            rejectClose: false
        }).catch(() => null);
    }

    /* CV ≥ 6 — full body coverage (Equipment Overhaul). No picker needed;
     * confirm dialog auto-selects all six. */
    const fullCover = cv >= HIT_LOCATIONS.length;

    /* Initial selection: existing coverage if updating; otherwise empty
     * (player seeds from scratch — much more intuitive than a defaulted
     * set chosen by the system). Full-cover shields auto-select all. */
    const initialSet = fullCover
        ? new Set(HIT_LOCATIONS)
        : (alreadyRaised && Array.isArray(sr.coveredLocations))
            ? new Set(sr.coveredLocations.filter(l => HIT_LOCATIONS.includes(l)))
            : new Set();

    const fullCoverNote = fullCover
        ? `<div style="font-size:0.6875rem;opacity:0.85;color:#c8a878;">Full cover (CV ${cv} ≥ 6) — all locations are covered automatically.</div>`
        : "";

    const content = `
        <div class="wdm-rs-wrap">
            <div><strong>${esc(shield.name)}</strong> — Cover Value <code>${cv}</code></div>
            ${fullCoverNote}
            <div class="wdm-rs-body">
                <div class="wdm-rs-figwrap" data-rs-figwrap><!-- SVG injected in render() to bypass DialogV2 content sanitizer --></div>
                <div class="wdm-rs-sidebar">
                    <div class="wdm-rs-status">
                        ${t("WITCHER.App.RaiseShieldDialog.Text.Covering", "Covering")} <span class="wdm-rs-count" data-rs-count>0</span>
                        <span style="font-size:0.6875rem;opacity:0.65;">${tFormat("WITCHER.App.RaiseShieldDialog.Text.OfN", { n: cv }, `of ${cv}`)}</span>
                    </div>
                    <div class="wdm-rs-list" data-rs-list><em>${t("WITCHER.App.RaiseShieldDialog.Text.NoLocationsPicked", "(no locations picked)")}</em></div>
                    <div class="wdm-rs-head-warning" data-rs-headwarn style="display:none;">
                        <i class="fa-solid fa-eye-slash"></i>
                        ${t("WITCHER.App.RaiseShieldDialog.Text.HeadCoveredWarn", "Head covered → applies Restricted Vision (−2 to Block / Parry / Dodge until your next turn).")}
                    </div>
                    <div class="wdm-rs-hint">
                        Click a body zone to cover it. The first pick can be anywhere; each
                        subsequent pick must be adjacent to one you've already chosen.
                        Dashed outline marks a "bridge" zone — removing it would split your
                        coverage, so deselect the outer zones first.
                    </div>
                    ${fullCover ? "" : `<button type="button" class="wdm-rs-reset" data-rs-reset>${t("WITCHER.App.RaiseShieldDialog.Text.Reset", "Reset")}</button>`}
                </div>
            </div>
        </div>`;

    /* Save / lower / cancel buttons. */
    const buttons = [
        {
            action: "raise", label: alreadyRaised ? "Update Coverage" : "Raise Shield",
            default: true, icon: "fa-solid fa-shield",
            callback: async (_event, _button, dlg) => {
                const root = dlg.element;
                /* Read selection straight from the DOM (zones with the
                 * .is-selected class). Honest source-of-truth — no
                 * hidden-input synchronization needed. */
                const set = [...root.querySelectorAll(".wdm-rs-zone.is-selected, .wdm-rs-zone.is-bridge")]
                    .map(p => p.dataset.loc)
                    .filter(l => HIT_LOCATIONS.includes(l));
                if (set.length === 0) {
                    ui.notifications?.warn(t("WITCHER.Notify.RaiseShield.NoLocation", "Pick at least one location to cover."));
                    return "raise";
                }
                const headCovered = set.includes("head");

                /* Coverage-only update on an already-raised shield doesn't
                 * spend a fresh slot. Fresh raise prompts for which slot
                 * to spend (auto-skips when only one is available; out
                 * of combat returns "free" without a prompt). */
                if (inCombat && !alreadyRaised) {
                    const chosenSlot = await pickSpecialActionSlot(actor, `Raise ${shield.name}`);
                    if (!chosenSlot) return "raise";   // cancelled / no slot
                    const slot = (typeof actor.spendSpecialActionSlot === "function")
                        ? await actor.spendSpecialActionSlot(`Raise ${shield.name}`, { slot: chosenSlot === "free" ? null : chosenSlot })
                        : "free";
                    if (!slot) return "raise";
                    if (slot !== "free") {
                        ui.notifications?.info(tFormat("WITCHER.Notify.RaiseShield.Raised", { shield: shield.name, slot: slot }, "Raised {shield} (spent {slot} slot)."));
                    }
                }

                const upd = {
                    "system.guard.shieldRaised.itemId":           shield.id,
                    "system.guard.shieldRaised.coveredLocations": set,
                    "system.guard.shieldRaised.headCovered":      headCovered
                };
                /* Rules1: "If you raise your shield, you automatically
                 * return to a balanced guard immediately." Toggleable via
                 * the raiseShieldAutoBalanced tuneable — when OFF, the
                 * current guard stays whatever it was. */
                if (ceTuneable("raiseShieldAutoBalanced") !== false) {
                    upd["system.guard.current"] = "balanced";
                }
                try { await actor.update(upd); }
                catch (err) { console.warn(`${SYSTEM_ID} | raise shield save failed`, err); }

                /* Head-covered → apply Restricted Vision. Toggleable via
                 * headCoverAppliesRestrictedVision — when OFF, skip the
                 * status (some tables don't want the −2 burden). Cleared
                 * on the actor's next turn start via statusClauses.clearsAt. */
                const applyRV = ceTuneable("headCoverAppliesRestrictedVision") !== false;
                if (headCovered && applyRV) {
                    try { await actor.toggleStatusEffect?.("restrictedVision", { active: true }); }
                    catch (err) { console.warn(`${SYSTEM_ID} | restrictedVision apply failed`, err); }
                } else if (alreadyRaised) {
                    /* If we were head-covered previously and now aren't, lift the status. */
                    if (actor.statuses?.has?.("restrictedVision")) {
                        try { await actor.toggleStatusEffect?.("restrictedVision", { active: false }); }
                        catch (err) { console.warn(`${SYSTEM_ID} | restrictedVision lift failed`, err); }
                    }
                }
                return "raise";
            }
        }
    ];
    if (alreadyRaised) {
        buttons.push({
            action: "lower", label: t("WITCHER.App.RaiseShieldDialog.Dialog.Button.LowerShield", "Lower Shield"), icon: "fa-solid fa-shield-slash",
            callback: async () => {
                const upd = {
                    "system.guard.shieldRaised.itemId":           "",
                    "system.guard.shieldRaised.coveredLocations": [],
                    "system.guard.shieldRaised.headCovered":      false
                };
                try { await actor.update(upd); }
                catch (err) { console.warn(`${SYSTEM_ID} | lower shield save failed`, err); }
                if (actor.statuses?.has?.("restrictedVision")) {
                    try { await actor.toggleStatusEffect?.("restrictedVision", { active: false }); }
                    catch (err) { console.warn(`${SYSTEM_ID} | restrictedVision lift failed`, err); }
                }
                return "lower";
            }
        });
    }
    buttons.push({ action: "cancel", label: t("WITCHER.Common.Cancel", "Cancel"), icon: "fa-solid fa-xmark" });

    return await DialogV2.wait({
        window: { title: tFormat("WITCHER.Dialog.RaiseShield.Title", { shield: shield.name }, "Raise Shield — {shield}"), icon: "fa-solid fa-shield", resizable: true },
        modal: true,
        position: { width: 480 },
        content,
        classes: ["wdm-raiseshield-dialog"],
        buttons,
        rejectClose: false,
        render: (_event, dlg) => {
            const root = dlg.element;
            /* SVG zones are built post-DOM-insertion so they survive
             * DialogV2's content sanitizer (which strips inline <svg>
             * out of the content string). */
            injectBodyFigure(root.querySelector("[data-rs-figwrap]"));
            const selected = new Set(initialSet);

            const repaint = () => {
                /* Apply per-zone class based on current selection. */
                for (const path of root.querySelectorAll(".wdm-rs-zone")) {
                    path.classList.remove("is-selected", "is-eligible", "is-capped", "is-bridge");
                    const loc = path.dataset.loc;
                    const state = zoneState(loc, selected, cv);
                    if (state === "selected") path.classList.add("is-selected");
                    else if (state === "bridge") path.classList.add("is-bridge");
                    else if (state === "eligible") path.classList.add("is-eligible");
                    else /* capped */              path.classList.add("is-capped");
                }
                /* Live readouts. */
                const count = root.querySelector("[data-rs-count]");
                if (count) count.textContent = String(selected.size);
                const list = root.querySelector("[data-rs-list]");
                if (list) {
                    if (selected.size === 0) {
                        list.innerHTML = "<em>(no locations picked)</em>";
                    } else {
                        const labels = [...selected].map(l => LOCATION_LABEL[l] ?? l);
                        list.textContent = labels.join(", ");
                    }
                }
                const headWarn = root.querySelector("[data-rs-headwarn]");
                if (headWarn) headWarn.style.display = selected.has("head") ? "" : "none";
            };

            /* Zone click: toggle, respecting the state rules. */
            for (const path of root.querySelectorAll(".wdm-rs-zone")) {
                path.addEventListener("click", (ev) => {
                    ev.preventDefault();
                    if (fullCover) return;     // full-cover shields are locked
                    const loc = path.dataset.loc;
                    if (selected.has(loc)) {
                        /* Try to deselect — refuse if it'd break contiguity. */
                        const after = new Set(selected); after.delete(loc);
                        if (!isContiguous(after)) {
                            ui.notifications?.warn(tFormat("WITCHER.Notify.RaiseShield.WouldSplit", { loc: LOCATION_LABEL[loc] }, "Removing {loc} would split coverage — remove an outer zone first."));
                            return;
                        }
                        selected.delete(loc);
                    } else {
                        /* Try to add — refuse if capped or non-adjacent (when seeded). */
                        const state = zoneState(loc, selected, cv);
                        if (state === "capped") {
                            if (selected.size >= cv) {
                                ui.notifications?.warn(tFormat("WITCHER.Notify.RaiseShield.CvFull", { cv: cv }, "Cover Value is {cv} — remove a location to add a different one."));
                            } else {
                                ui.notifications?.warn(tFormat("WITCHER.Notify.RaiseShield.NotAdjacent", { loc: LOCATION_LABEL[loc] }, "{loc} must be adjacent to a covered location."));
                            }
                            return;
                        }
                        selected.add(loc);
                    }
                    repaint();
                });
            }
            /* Reset button — clear selection. */
            const resetBtn = root.querySelector("[data-rs-reset]");
            if (resetBtn) {
                resetBtn.addEventListener("click", (ev) => {
                    ev.preventDefault();
                    selected.clear();
                    repaint();
                });
            }
            repaint();
        }
    }).catch(() => null);
}
