/**
 * Combat tracker — guard-stance indicator.
 *
 * Injects a small chip under each combatant's name showing their active
 * guard (Balanced / Warding / Closed / Fool's), and — when Warding — the
 * hit locations they've picked per equipped weapon. Only visible when
 * Combat Extended's guards subsystem is enabled; the chip is skipped
 * silently otherwise.
 *
 * Update triggers:
 *   - renderCombatTracker     (initial paint + Foundry re-render)
 *   - updateActor             (guard.current / preferred / wardingLocations changed)
 *   - updateCombat            (turn advances)
 *   - updateItem              (a weapon was equipped / unequipped, or its
 *                              name changed — Warding shows names)
 */

import { isCESubsystemEnabled } from "../api/homebrew.mjs";
import { GUARDS } from "../data/combatExtended/guards.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";

/* Escape HTML at the same level the rest of the chrome does — the label
 * strings come from actor/item names and localized i18n values, which
 * users can edit freely. */
const esc = (s) => String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const LOCATION_LABEL = {
    head: "head", torso: "torso",
    leftArm: "L. arm", rightArm: "R. arm",
    leftLeg: "L. leg", rightLeg: "R. leg"
};

/* Build the inner HTML for the guard chip. Returns "" when the combatant
 * lacks a guard schema (non-character/monster, CE off, or actor missing). */
function guardChipHtml(actor) {
    if (!actor?.system?.guard) return "";
    const inCombat = !!actor._inActiveCombat;
    /* In-combat: show `current` (the active stance). Out of combat the
     * dock reads `preferred`, but the combat tracker only paints
     * combatants — who are by definition IN combat — so `current` is
     * the honest source here. */
    const curKey  = String(actor.system.guard.current ?? "balanced");
    const g       = GUARDS[curKey] ?? GUARDS.balanced;
    const label   = game.i18n?.localize?.(g.labelKey) ?? curKey;
    const iconCls = g.icon || "fa-solid fa-shield";
    let wardTail  = "";
    if (curKey === "warding") {
        /* Show every equipped weapon's warded location — user can see
         * at a glance which locations are covered. Weapons without a
         * pick are omitted (no zero-info clutter). */
        const wardMap = actor.system.guard.wardingLocations ?? {};
        const equipped = (actor.items?.contents ?? actor.items ?? [])
            .filter(i => i.type === "weapon" && i.system?.equipped);
        const parts = [];
        for (const item of equipped) {
            const loc = wardMap[item.id];
            if (!loc) continue;
            parts.push(`${esc(item.name)}: <b>${esc(LOCATION_LABEL[loc] ?? loc)}</b>`);
        }
        if (parts.length) {
            wardTail = ` <span class="wdm-ct-guard-ward" style="opacity:0.85;">— ${parts.join(", ")}</span>`;
        }
    }
    return `<div class="wdm-ct-guard" data-guard-key="${esc(curKey)}"
                 style="display:flex;align-items:center;gap:4px;font-size:0.6875rem;letter-spacing:0.08em;text-transform:uppercase;color:#c8a878;opacity:0.9;margin-top:2px;">
        <i class="${esc(iconCls)}" style="font-size:0.75rem;"></i>
        <span>${esc(label)}</span>${wardTail}
    </div>`;
}

/* Paint every combatant row that hasn't already been marked. The chip
 * sits INSIDE the row's `.combatant-name` block so it inherits the same
 * hover / active styling Foundry already applies to that region. */
function paintTrackerRows(html) {
    if (!isCESubsystemEnabled("guards")) return;
    const root = (html instanceof HTMLElement) ? html : html?.[0] ?? document;
    const rows = root.querySelectorAll?.("[data-combatant-id]") ?? [];
    for (const li of rows) {
        const cid = li.dataset.combatantId;
        const cb  = cid ? game.combat?.combatants?.get(cid) : null;
        const actor = cb?.actor;
        if (!actor) continue;
        /* Strip any prior chip (guard changed → we re-paint). */
        const prior = li.querySelector(".wdm-ct-guard");
        if (prior) prior.remove();
        const chip = guardChipHtml(actor);
        if (!chip) continue;
        /* Anchor: the actor-name block. Foundry v13 uses `.combatant-name`;
         * fall back to `.token-name` (older layouts) or the row itself so
         * the chip always lands somewhere visible. */
        const anchor = li.querySelector(".combatant-name")
                    ?? li.querySelector(".token-name")
                    ?? li.querySelector("h4")
                    ?? li;
        anchor.insertAdjacentHTML("beforeend", chip);
    }
}

function refreshAllTrackers() {
    paintTrackerRows(document);
}

export function registerCombatTrackerGuards() {
    Hooks.on("renderCombatTracker", (_app, html) => paintTrackerRows(html));

    /* Live re-paint when a combatant's guard state changes. Cheap filter:
     * only re-paint on updates that TOUCH the guard schema. */
    Hooks.on("updateActor", (_actor, changes) => {
        if (!changes?.system?.guard) return;
        refreshAllTrackers();
    });

    /* Weapon equip/unequip or rename affects the warded-location list. */
    Hooks.on("updateItem", (item, changes) => {
        if (item?.type !== "weapon") return;
        if (changes?.system?.equipped === undefined && changes?.name === undefined) return;
        refreshAllTrackers();
    });
    Hooks.on("createItem", (item) => {
        if (item?.type === "weapon") refreshAllTrackers();
    });
    Hooks.on("deleteItem", (item) => {
        if (item?.type === "weapon") refreshAllTrackers();
    });

    /* Turn changes fire updateCombat — re-paint so a Special Action
     * guard change on the previous turn is reflected. */
    Hooks.on("updateCombat", () => refreshAllTrackers());

    /* ActiveEffect create / update / delete — Foundry's combat tracker
     * doesn't repaint its status-icon column on effect changes by
     * default, so a prone applied via emitApplyStatus doesn't show up
     * until the tracker re-renders on some other event. Force a
     * re-render on every effect lifecycle event that affects an actor
     * currently in the combat tracker. */
    const rerenderCombat = () => {
        try { ui.combat?.render?.(true); } catch (_) { /* not open */ }
    };
    Hooks.on("createActiveEffect", (effect) => {
        if (effect?.parent?.documentName === "Actor") rerenderCombat();
    });
    Hooks.on("updateActiveEffect", (effect) => {
        if (effect?.parent?.documentName === "Actor") rerenderCombat();
    });
    Hooks.on("deleteActiveEffect", (effect) => {
        if (effect?.parent?.documentName === "Actor") rerenderCombat();
    });
    /* Also cover the "statuses" set on actors — some Foundry paths
     * write to `actor.statuses` directly without spawning a full
     * ActiveEffect (rare, but worth catching). */
    Hooks.on("updateActor", (_actor, changes) => {
        if (changes?.statuses !== undefined) rerenderCombat();
    });
}
