/**
 * Combat Tracker "Take Control" — GM affordance on the right-side tracker.
 *
 * Right-click a combatant → context menu entry "Take Control": calls
 * setActorOverride(combatant.actor) so the chrome dock, inventory, hotbar and
 * every view-as-aware surface re-renders against that actor. A companion
 * "Release Control (reset to assigned)" entry clears it. Players see no menu
 * entry (gated isGM).
 *
 * Reuses the existing view-as override pipeline (chrome/lib/actor.js) so the
 * dock/inventory/etc. already react via VIEWER_OVERRIDE_HOOK — no new render
 * plumbing here.
 *
 * NOTE: the former automatic "Take control on turn" toggle (a tracker-header
 * checkbox that auto-swapped the dock to each combatant as initiative advanced)
 * was removed — in practice it added confusion without pulling its weight. Only
 * the on-demand right-click entries remain.
 */

import { setActorOverride } from "../chrome/lib/actor.js";
import { t } from "../chrome/lib/i18n.js";

function takeControl(actor) {
    if (!actor) return;
    /* Pass the actor INSTANCE (not just the id) so setActorOverride can
     * capture the token reference. Without this, unlinked-token combatants
     * resolve back to the shared world actor on every dock interaction —
     * three unlinked wolves would share one action budget, ROF, statuses,
     * etc. The override now stores tokenId for synthetic actors, so each
     * unlinked token keeps its own combat state. */
    setActorOverride(actor);
}

/* ------------------------------------------------------------------ */
/* Context menu — "Take Control" entry on each combatant row.         */
/* ------------------------------------------------------------------ */

function registerContextMenu() {
    Hooks.on("getCombatTrackerEntryContext", (_html, entries) => {
        if (!game.user?.isGM) return;
        entries.push({
            name: t("WITCHER.Policy.CombatTrackerTakeControl.Text.TakeControl", "Take Control"),
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
            name: t("WITCHER.Policy.CombatTrackerTakeControl.Text.ReleaseControlResetToAssigned", "Release Control (reset to assigned)"),
            icon: '<i class="fa-solid fa-user-xmark"></i>',
            condition: () => true,
            callback: () => setActorOverride(null)
        });
    });
}

/* ------------------------------------------------------------------ */
/* Public registration.                                               */
/* ------------------------------------------------------------------ */

export function registerCombatTrackerTakeControl() {
    registerContextMenu();
}
