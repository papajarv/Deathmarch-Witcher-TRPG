/**
 * Combat Tracker "Take Control" — GM affordances on the right-side tracker.
 *
 *   1. Right-click a combatant → context menu entry "Take Control"
 *      Calls setActorOverride(combatant.actorId) so the chrome dock,
 *      inventory, hotbar and every view-as-aware surface re-renders
 *      against that actor. Players see no menu entry (gated isGM).
 *
 *   2. Footer checkbox "Take control on turn" (GM-only). Persisted as
 *      a per-user flag so it survives reloads. When ON, on every turn
 *      boundary we call setActorOverride for the active combatant IF:
 *        - GM owns the actor
 *        - The actor is not owned by an active non-GM player (so we
 *          don't steal view-as from a PC who's online)
 *
 * Reuses the existing view-as override pipeline (chrome/lib/actor.js)
 * so the dock/inventory/etc. already react via VIEWER_OVERRIDE_HOOK
 * — no new render plumbing here.
 */

import { setActorOverride, VIEWER_OVERRIDE_HOOK } from "../chrome/lib/actor.js";

const SYSTEM_ID  = "witcher-ttrpg-death-march";
const AUTO_FLAG  = "takeControlOnTurn";

function isAutoOn() {
    return !!(game.user?.getFlag?.(SYSTEM_ID, AUTO_FLAG));
}
async function setAuto(on) {
    return game.user?.setFlag?.(SYSTEM_ID, AUTO_FLAG, !!on);
}

/* True when a non-GM player who isn't us is online and owns this actor.
 * Used to skip auto-take-control for PC combatants (the player whose
 * turn just started should keep their own view, not have the GM swap
 * everyone's chrome to their character). */
function playerOwnsActor(actor) {
    if (!actor) return false;
    return !!game.users?.contents?.some(u =>
        u.active && !u.isGM && u !== game.user && actor.testUserPermission?.(u, "OWNER")
    );
}

function takeControl(actor) {
    if (!actor) return;
    setActorOverride(actor.id);
}

/* ------------------------------------------------------------------ */
/* Context menu — "Take Control" entry on each combatant row.         */
/* ------------------------------------------------------------------ */

function registerContextMenu() {
    Hooks.on("getCombatTrackerEntryContext", (_html, entries) => {
        if (!game.user?.isGM) return;
        entries.push({
            name: "Take Control",
            icon: '<i class="fa-solid fa-user-gear"></i>',
            condition: (li) => {
                const cid = li?.dataset?.combatantId ?? li?.[0]?.dataset?.combatantId;
                const combatant = cid ? game.combat?.combatants?.get(cid) : null;
                return !!combatant?.actor;
            },
            callback: (li) => {
                const cid = li?.dataset?.combatantId ?? li?.[0]?.dataset?.combatantId;
                const combatant = cid ? game.combat?.combatants?.get(cid) : null;
                if (combatant?.actor) takeControl(combatant.actor);
            }
        });
        entries.push({
            name: "Release Control (reset to assigned)",
            icon: '<i class="fa-solid fa-user-xmark"></i>',
            condition: () => true,
            callback: () => setActorOverride(null)
        });
    });
}

/* ------------------------------------------------------------------ */
/* Footer checkbox — "Take control on turn" toggle, GM-only.          */
/* ------------------------------------------------------------------ */

function injectTopCheckbox(html) {
    if (!game.user?.isGM) return;
    const root = (html instanceof HTMLElement) ? html : html?.[0];
    if (!root) return;
    if (root.querySelector(".wdm-tc-on-turn")) return;        // already injected
    /* Place the toggle at the TOP of the tracker header, above the
     * round/encounter-controls block. The header has two children
     * (encounters nav + encounter-controls); we insert BEFORE the
     * encounter-controls so the toggle sits between the encounter
     * tabs and the round counter. Footer placement was clipped by
     * the tracker's footer CSS (which is tight). */
    const header = root.querySelector("header.combat-tracker-header")
                ?? root.querySelector(".combat-tracker-header")
                ?? root;
    const before = header.querySelector(".encounter-controls")
                ?? header.querySelector("nav.encounters")?.nextElementSibling
                ?? null;
    const wrap = document.createElement("label");
    wrap.className = "wdm-tc-on-turn";
    wrap.title = "When ON, the chrome view auto-swaps to whichever NPC's turn it is (skips player-owned actors).";
    wrap.innerHTML = `
        <input type="checkbox" ${isAutoOn() ? "checked" : ""} />
        <span>Take control on turn</span>
    `;
    const cb = wrap.querySelector("input");
    cb.addEventListener("change", async () => {
        await setAuto(cb.checked);
        if (cb.checked) {
            /* Just turned ON — immediately take control of the current
             * combatant so the GM doesn't have to wait for the next
             * turn change to see anything happen. */
            if (game.combat?.combatant?.actor) {
                const a = game.combat.combatant.actor;
                if (!playerOwnsActor(a)) takeControl(a);
            }
        } else {
            /* Just turned OFF — release the view-as override so the
             * GM goes back to their assigned character. Without this,
             * unchecking left whichever NPC was last taken still in
             * the dock until something else cleared it. */
            setActorOverride(null);
        }
    });
    if (before) header.insertBefore(wrap, before);
    else header.appendChild(wrap);
}

function registerTopCheckbox() {
    Hooks.on("renderCombatTracker", (_app, html) => {
        try { injectTopCheckbox(html); }
        catch (err) { console.warn(`${SYSTEM_ID} | take-control checkbox inject failed`, err); }
    });
}

/* ------------------------------------------------------------------ */
/* Auto take-control on turn change (gated by the checkbox).          */
/* ------------------------------------------------------------------ */

function onTurnChange(combat) {
    if (!game.user?.isGM) return;
    if (!isAutoOn()) return;
    const actor = combat?.combatant?.actor;
    if (!actor) return;
    if (!actor.isOwner) return;
    if (playerOwnsActor(actor)) return;     // don't yank view from an online PC
    takeControl(actor);
}

function registerAutoTurnHook() {
    Hooks.on("combatTurnChange", onTurnChange);
    Hooks.on("combatStart",      onTurnChange);
}

/* ------------------------------------------------------------------ */
/* Public registration.                                               */
/* ------------------------------------------------------------------ */

export function registerCombatTrackerTakeControl() {
    registerContextMenu();
    registerTopCheckbox();
    registerAutoTurnHook();
    /* Re-render the tracker when the override changes so the checkbox
     * state stays in sync if it was toggled elsewhere. */
    Hooks.on(VIEWER_OVERRIDE_HOOK, () => {
        try { ui.combat?.render?.(true); } catch (_) { /* no tracker */ }
    });
}
