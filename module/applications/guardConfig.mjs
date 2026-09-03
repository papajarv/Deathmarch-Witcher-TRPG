/**
 * Combat Extended — Guard configuration dialog.
 *
 * Opens from the dock's guard-btn (in CE worlds only). UX shape:
 *
 *   In combat:
 *     Current guard     — card picker (Balanced / Warding / Closed / Fool's).
 *                         Switching consumes one of the actor's three
 *                         action-economy slots (movement / action / extra).
 *                         Refused only when all three slots are spent.
 *     Preferred guard   — card picker. Auto-applied at the start of every
 *                         combat (also fires for late-joining combatants).
 *     Warding locations — per-equipped-weapon location pick. Only rendered
 *                         when current OR preferred is "warding" (live JS
 *                         toggle on picker change).
 *
 *   Out of combat:
 *     Preferred guard   — card picker (the only thing you can configure).
 *     Warding locations — same conditional render.
 *     Current is intentionally not editable out of combat — it gets
 *     overwritten to preferred (or balanced) the moment combat starts.
 *
 * Persisted to `system.guard`. When CE is off the dock button is hidden,
 * so this dialog should never open.
 */

const SYSTEM_ID = "witcher-ttrpg-death-march";

import { GUARDS, GUARD_KEYS } from "../data/combatExtended/guards.mjs";
import { pickSpecialActionSlot } from "./specialActionSlotPicker.mjs";

import { t, tFormat } from "../chrome/lib/i18n.js";
const HIT_LOCATIONS = ["head", "torso", "leftArm", "rightArm", "leftLeg", "rightLeg"];
const LOCATION_LABEL = {
    head: "Head", torso: "Torso",
    leftArm: "Left Arm", rightArm: "Right Arm",
    leftLeg: "Left Leg", rightLeg: "Right Leg"
};

/* One-line mod summary per guard, shown under the name on each card. */
const GUARD_SUMMARY = {
    balanced: "No bonus, no penalty",
    warding:  "+2 Parry/Block warded loc · −1 elsewhere",
    closed:   "+2 all Parry/Block · −2 all Attacks",
    fools:    "+2 all Attacks · −2 all Defenses"
};

const esc = (s) => String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const L = (k) => game.i18n?.localize?.(k) ?? k;

/* Render the four-card picker for one role (current OR preferred). The
 * selected card carries `.is-selected`; click handlers (wired in the
 * render callback) toggle the selection and the hidden input. */
function guardPickerHtml(role, valueKey) {
    const cardsHtml = GUARD_KEYS.map(k => {
        const g = GUARDS[k];
        const sel = k === valueKey ? " is-selected" : "";
        const summary = GUARD_SUMMARY[k] ?? "";
        return `
            <button type="button" class="wdm-guard-card${sel}" data-role="${esc(role)}" data-key="${esc(k)}">
                <i class="${esc(g.icon)} wdm-guard-card-icon"></i>
                <span class="wdm-guard-card-name">${esc(L(g.labelKey))}</span>
                <span class="wdm-guard-card-mods">${esc(summary)}</span>
            </button>`;
    }).join("");
    return `
        <div class="wdm-guard-picker" data-role="${esc(role)}">
            ${cardsHtml}
        </div>
        <input type="hidden" name="${esc(role)}" value="${esc(valueKey)}" />`;
}

/* Per-equipped-WEAPON warding picker. Hidden when neither current nor
 * preferred is Warding (toggled live in the render JS). Shields are
 * intentionally excluded — Warding is a weapon stance, not a shield
 * stance (rules1: "pick a hit location PER WEAPON wielded"). */
function wardingBlockHtml(actor) {
    const equipped = (actor.items?.contents ?? actor.items ?? [])
        .filter(i => i.type === "weapon" && i.system?.equipped);
    const stored = actor.system?.guard?.wardingLocations ?? {};

    let body;
    if (!equipped.length) {
        body = `<div class="wdm-guard-warden-empty"><em>No equipped weapons — Warding has no effect until you equip one. (Shields don't ward a location; only weapons do.)</em></div>`;
    } else {
        const rowsHtml = equipped.map(item => {
            const sel = String(stored[item.id] ?? "");
            const opts = [
                `<option value=""${sel === "" ? " selected" : ""}>— none —</option>`,
                ...HIT_LOCATIONS.map(loc =>
                    `<option value="${esc(loc)}"${sel === loc ? " selected" : ""}>${esc(LOCATION_LABEL[loc])}</option>`)
            ].join("");
            return `
                <div class="wdm-guard-warden-row">
                    <span class="wdm-guard-warden-name">${esc(item.name)}</span>
                    <select name="ward.${esc(item.id)}">${opts}</select>
                </div>`;
        }).join("");
        body = `<div class="wdm-guard-warden-list">${rowsHtml}</div>`;
    }

    return `
        <div class="wdm-guard-warden-block" data-warden-block style="display:none;">
            <div class="wdm-guard-section-label">${t("WITCHER.App.GuardConfig.Text.WardingLocations", "Warding locations (per equipped weapon)")}</div>
            ${body}
        </div>`;
}

export async function openGuardConfig(actor) {
    if (!actor) return null;
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2) {
        ui.notifications?.warn(t("WITCHER.Notify.Guard.RequiresDialogV2", "Guard config requires DialogV2 (Foundry v13+)."));
        return null;
    }

    const cur      = String(actor.system?.guard?.current   ?? "balanced");
    const pref     = String(actor.system?.guard?.preferred ?? "balanced");
    const inCombat = !!actor._inActiveCombat;

    /* Out-of-combat block: only Preferred (current is meaningless — gets
     * overwritten the moment combat starts). In-combat block: both. */
    const currentBlock = inCombat ? `
        <div class="wdm-guard-row">
            <div class="wdm-guard-section-label">${esc(L("WITCHER.CombatExtended.Guard.CurrentLabel"))}</div>
            ${guardPickerHtml("current", cur)}
            <div class="wdm-guard-hint" style="font-size:0.6875rem;opacity:0.7;">Spends a Special Action slot (movement → action → extra). Multi-use; capped by the slots you have left.</div>
        </div>` : `
        <div class="wdm-guard-hint" style="font-size:0.6875rem;opacity:0.7;padding:4px 0;">
            <i class="fa-solid fa-circle-info"></i>
            ${t("WITCHER.App.GuardConfig.Text.CurrentGuardCanOnlyBeChangedInCombatOutO", "Current guard can only be changed in combat — out of combat it resets to your preferred when the next fight starts.")}
        </div>`;

    /* Preferred section is COMPACT by default — a one-line "Preferred:
     * <Name>" plus a Change button. Click expands the 4-card picker;
     * the JS in render() wires the toggle + collapses again after a pick. */
    const prefGuardEntry = GUARDS[pref] ?? GUARDS.balanced;
    const prefLabel = L(prefGuardEntry.labelKey);
    const preferredBlock = `
        <div class="wdm-guard-row wdm-guard-pref-row">
            <div class="wdm-guard-pref-summary">
                <span class="wdm-guard-section-label">${esc(L("WITCHER.CombatExtended.Guard.PreferredLabel"))}:</span>
                <i class="${esc(prefGuardEntry.icon)} wdm-guard-card-icon" style="margin:0 4px;"></i>
                <strong class="wdm-guard-pref-current" data-pref-label>${esc(prefLabel)}</strong>
                <button type="button" class="wdm-guard-change-pref" data-pref-toggle
                        style="margin-left:auto;padding:4px 10px;background:#0a0907;border:1px solid #6e5224;color:#e5d6b6;font-family:inherit;font-size:0.6875rem;letter-spacing:0.10em;text-transform:uppercase;border-radius:2px;cursor:pointer;">
                    ${t("WITCHER.App.GuardConfig.Text.ChangePreferredGuard", "Change Preferred Guard")}
                </button>
            </div>
            <div data-pref-picker style="display:none;margin-top:6px;">
                ${guardPickerHtml("preferred", pref)}
                <div class="wdm-guard-hint" style="font-size:0.6875rem;opacity:0.7;margin-top:4px;">${t("WITCHER.App.GuardConfig.Text.AutoAppliedAtTheStartOfEveryCombat", "Auto-applied at the start of every combat.")}</div>
            </div>
            <!-- Mirror hidden input outside the collapsible so reading 'preferred' on save always works even when collapsed. The visible picker writes to the same name; both stay in sync via the click handler. -->
        </div>`;

    const content = `
        <div class="wdm-guard-config" style="padding:6px 2px;display:flex;flex-direction:column;gap:12px;">
            <style>
                .wdm-guard-picker {
                    display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px;
                }
                .wdm-guard-card {
                    flex: 1 1 0; min-width: 110px;
                    display: flex; flex-direction: column; align-items: center; gap: 4px;
                    padding: 8px 6px;
                    border: 1px solid #6e5224; background: #0a0907; color: #e5d6b6;
                    border-radius: 3px; cursor: pointer;
                    font-family: inherit; line-height: 1.15;
                    text-align: center;
                }
                .wdm-guard-card:hover { border-color: #c8a878; }
                .wdm-guard-card.is-selected {
                    border-color: #c8a878; background: rgba(184, 148, 100, 0.12);
                    box-shadow: inset 0 0 0 1px #c8a878;
                }
                .wdm-guard-card-icon { font-size: 1rem; color: #c8a878; }
                .wdm-guard-card-name {
                    font-size: 0.6875rem; letter-spacing: 0.1em; text-transform: uppercase;
                    color: #e5d6b6;
                }
                .wdm-guard-card-mods { font-size: 0.625rem; opacity: 0.75; }
                .wdm-guard-section-label {
                    font-size: 0.6875rem; letter-spacing: 0.12em;
                    text-transform: uppercase; color: #c8a878;
                }
                .wdm-guard-pref-summary {
                    display: flex; align-items: center; gap: 4px;
                    padding: 6px 0;
                }
                .wdm-guard-change-pref:hover {
                    border-color: #c8a878 !important; color: #f5e7c3 !important;
                }
                .wdm-guard-warden-list {
                    display: flex; flex-direction: column; gap: 4px; margin-top: 4px;
                }
                .wdm-guard-warden-row {
                    display: flex; align-items: center; gap: 8px;
                }
                .wdm-guard-warden-name { flex: 1 1 auto; font-size: 0.75rem; }
                .wdm-guard-warden-row select {
                    flex: 0 0 120px;
                    background: #0a0907; border: 1px solid #6e5224; color: #e5d6b6;
                }
            </style>
            ${currentBlock}
            ${preferredBlock}
            ${wardingBlockHtml(actor)}
        </div>`;

    let dialog = null;
    return await new Promise((resolve) => {
        DialogV2.wait({
            window: { title: tFormat("WITCHER.Dialog.Guard.Title", { actor: actor.name }, "Guard — {actor}"), icon: "fa-solid fa-shield-halved" },
            modal: true,
            content,
            classes: ["wdm-guard-config-dialog"],
            buttons: [
                {
                    action: "save", label: t("WITCHER.Common.Save", "Save"), default: true, icon: "fa-solid fa-floppy-disk",
                    callback: async (_event, _button, dlg) => {
                        const root = dlg.element;
                        const readPick = (role) =>
                            String(root.querySelector(`input[name="${role}"]`)?.value ?? "");
                        const nextCurRaw  = readPick("current");
                        const nextPrefRaw = readPick("preferred");
                        const nextCur  = (inCombat && GUARD_KEYS.includes(nextCurRaw))  ? nextCurRaw  : cur;
                        const nextPref = GUARD_KEYS.includes(nextPrefRaw)              ? nextPrefRaw : pref;

                        // Warding-location map: read every ward.<itemId> field.
                        const wardingLocations = {};
                        for (const el of root.querySelectorAll('[name^="ward."]')) {
                            const id = String(el.name).slice("ward.".length);
                            const v = String(el.value ?? "");
                            if (v && HIT_LOCATIONS.includes(v)) wardingLocations[id] = v;
                        }

                        const currentChanged = inCombat && nextCur !== cur;
                        const upd = {
                            "system.guard.preferred":        nextPref,
                            "system.guard.wardingLocations": wardingLocations
                        };

                        /* Pref + warding only: no slot spent. */
                        if (!currentChanged) {
                            try { await actor.update(upd); }
                            catch (err) { console.warn(`${SYSTEM_ID} | guard pref save failed`, err); }
                            return "save";
                        }

                        /* Current changed → prompt for which slot to spend.
                         * Picker auto-skips when only one slot is available;
                         * out of combat it returns "free" with no prompt.
                         * Pref + warding still save regardless. */
                        const chosenSlot = await pickSpecialActionSlot(actor, `Change Guard → ${nextCur}`);
                        if (!chosenSlot) {
                            try { await actor.update(upd); }
                            catch (err) { console.warn(`${SYSTEM_ID} | guard pref save failed`, err); }
                            ui.notifications?.warn(t("WITCHER.Notify.Guard.NoSlot", "No slot picked / available — saved preferred + warding only."));
                            return "save";
                        }
                        const slot = (typeof actor.spendSpecialActionSlot === "function")
                            ? await actor.spendSpecialActionSlot(`Change Guard → ${nextCur}`, { slot: chosenSlot === "free" ? null : chosenSlot })
                            : "free";
                        if (!slot) {
                            try { await actor.update(upd); }
                            catch (err) { console.warn(`${SYSTEM_ID} | guard pref save failed`, err); }
                            ui.notifications?.warn(t("WITCHER.Notify.Guard.SlotRefused", "Slot spend refused — saved preferred + warding only."));
                            return "save";
                        }
                        upd["system.guard.current"] = nextCur;
                        try {
                            await actor.update(upd);
                            if (slot !== "free") {
                                ui.notifications?.info(tFormat("WITCHER.Notify.Guard.Changed", { next: nextCur, slot: slot }, "Change Guard → {next} (spent {slot} slot)."));
                            }
                        } catch (err) {
                            console.warn(`${SYSTEM_ID} | guard save failed`, err);
                            ui.notifications?.error(t("WITCHER.Notify.Guard.SaveFailed", "Failed to save guard."));
                        }
                        return "save";
                    }
                },
                { action: "cancel", label: t("WITCHER.Common.Cancel", "Cancel"), icon: "fa-solid fa-xmark" }
            ],
            rejectClose: false,
            render: (_event, dlg) => {
                dialog = dlg;
                const root = dlg.element;
                /* Picker click: highlight the clicked card + update the
                 * hidden input + refresh the warding-block visibility +
                 * (preferred only) refresh the compact summary label. */
                const updateWardingVisibility = () => {
                    const block = root.querySelector("[data-warden-block]");
                    if (!block) return;
                    const curVal  = root.querySelector('input[name="current"]')?.value
                                  ?? cur;
                    const prefVal = root.querySelector('input[name="preferred"]')?.value
                                  ?? pref;
                    const show = curVal === "warding" || prefVal === "warding";
                    block.style.display = show ? "" : "none";
                };
                /* Compact-summary label syncing: when the user picks a new
                 * preferred from the expanded picker, update the line
                 * above ("Preferred: <Name>") so the summary stays truthful
                 * even before they hit Save. */
                const updatePrefSummary = (key) => {
                    const lbl = root.querySelector("[data-pref-label]");
                    if (!lbl) return;
                    const g = GUARDS[key] ?? GUARDS.balanced;
                    lbl.textContent = L(g.labelKey);
                    /* Also refresh the icon next to the summary label. */
                    const icon = lbl.parentElement?.querySelector("i");
                    if (icon) icon.className = `${g.icon} wdm-guard-card-icon`;
                };
                root.querySelectorAll(".wdm-guard-card").forEach(btn => {
                    btn.addEventListener("click", (ev) => {
                        ev.preventDefault();
                        const role = btn.dataset.role;
                        const key  = btn.dataset.key;
                        /* Highlight one card per picker. */
                        const picker = btn.closest(".wdm-guard-picker");
                        picker?.querySelectorAll(".wdm-guard-card").forEach(c => c.classList.remove("is-selected"));
                        btn.classList.add("is-selected");
                        /* Sync the hidden input that lives next to the picker. */
                        const hidden = picker?.parentElement?.querySelector(`input[name="${role}"]`)
                                    ?? root.querySelector(`input[name="${role}"]`);
                        if (hidden) hidden.value = key;
                        if (role === "preferred") updatePrefSummary(key);
                        updateWardingVisibility();
                    });
                });
                /* "Change Preferred Guard" button: toggle the picker's
                 * visibility. Button label also flips so the user can
                 * collapse it again. */
                const toggleBtn = root.querySelector("[data-pref-toggle]");
                const picker    = root.querySelector("[data-pref-picker]");
                if (toggleBtn && picker) {
                    toggleBtn.addEventListener("click", (ev) => {
                        ev.preventDefault();
                        const open = picker.style.display !== "none";
                        picker.style.display = open ? "none" : "";
                        toggleBtn.textContent = open ? "Change Preferred Guard" : "Done";
                    });
                }
                updateWardingVisibility();
            }
        }).then(resolve).catch(() => resolve(null));
    });
}
