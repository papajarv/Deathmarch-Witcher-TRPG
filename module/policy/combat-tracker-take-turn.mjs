/**
 * Combat Tracker "Take Turn" — GM affordance on the right-side sidebar tracker.
 *
 * Right-click a combatant → context menu entry "Take Turn": jumps the active
 * turn pointer straight to that combatant, handing them the turn immediately.
 *
 * v14 note: the legacy `getCombatTrackerEntryContext` hook did NOT reliably add
 * this entry on the user's build (Take Control uses it and shows, but a second
 * registration didn't). The robust path — proven to work here — is to wrap the
 * ApplicationV2 CombatTracker's own `_getEntryContextOptions()` method and
 * append our entry to whatever it returns. Core entries (incl. Take Control via
 * its hook, which fires inside the original method) are preserved untouched.
 *
 * GM-only. Moves the "whose turn is it" cursor within the current round
 * (combat.update({ turn })); does NOT advance the round or change initiative.
 */

import { t } from "../chrome/lib/i18n.js";

/** Combatant from a context-menu target row (HTMLElement or jQuery). */
function combatantFromTarget(li) {
    const cid = li?.dataset?.combatantId ?? li?.[0]?.dataset?.combatantId;
    return cid ? game.combat?.combatants?.get(cid) : null;
}

/** Move the active turn to `combatant`. No-op if it's already their turn or the
 *  combatant can't be located in the order.
 *
 *  Smoothness: a bare `combat.update({ turn })` reads to the system's combat
 *  handlers as a generic combat change and takes the heavier refresh path
 *  (visible stutter). Foundry's native next/prev-turn buttons fire the
 *  `combatTurn` hook and pass the `{ direction }` turn-event option — the clean
 *  "turn advanced" signal the debounced handlers are tuned for. Mirror that. */
async function takeTurn(combatant) {
    const combat = combatant?.combat ?? game.combat;
    if (!combat || !combatant) return;
    const idx = combat.turns?.findIndex(c => c.id === combatant.id);
    if (idx == null || idx < 0 || combat.turn === idx) return;
    const updateData = { turn: idx };
    const updateOptions = { direction: idx > (combat.turn ?? -1) ? 1 : -1 };
    try {
        Hooks.callAll("combatTurn", combat, updateData, updateOptions);
        await combat.update(updateData, updateOptions);
    } catch (err) { console.warn("wdm combat-tracker-take-turn | update failed", err); }
}

/** The "Take Turn" ContextMenuEntry (mirrors Take Control's condition shape). */
function takeTurnEntry() {
    return {
        name: t("WITCHER.Policy.CombatTrackerTakeTurn.Text.TakeTurn", "Take Turn"),
        icon: '<i class="fa-solid fa-forward"></i>',
        condition: (li) => game.user?.isGM === true && !!combatantFromTarget(li)?.actor,
        callback: (li) => {
            const combatant = combatantFromTarget(li);
            if (combatant?.actor) takeTurn(combatant);
        }
    };
}

/* ------------------------------------------------------------------ */
/* Install — wrap CombatTracker#_getEntryContextOptions (ApplicationV2). */
/* ------------------------------------------------------------------ */

function installContextEntry() {
    const proto = foundry?.applications?.sidebar?.tabs?.CombatTracker?.prototype;
    if (!proto) return false;
    if (proto._wdmTakeTurnPatched) return true;
    const orig = proto._getEntryContextOptions;
    proto._getEntryContextOptions = function () {
        const entries = (typeof orig === "function" ? orig.call(this) : []) ?? [];
        entries.push(takeTurnEntry());
        return entries;
    };
    proto._wdmTakeTurnPatched = true;
    return true;
}

/* ------------------------------------------------------------------ */
/* Public registration.                                               */
/* ------------------------------------------------------------------ */

export function registerCombatTrackerTakeTurn() {
    /* Class exists by "setup"; install now if available, else defer.
     * Idempotent via the _wdmTakeTurnPatched guard. */
    if (!installContextEntry()) {
        Hooks.once("setup", installContextEntry);
        Hooks.once("ready", installContextEntry);
    }
}
