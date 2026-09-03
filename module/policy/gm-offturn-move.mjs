/**
 * GM Off-Turn Move — standalone GM-only combat override.
 *
 * During a started combat the system gates token movement on whose turn it
 * is: an actor that isn't the current combatant can't be dragged on the
 * canvas (see policy/canvas-movement.mjs) and its dock/budget writer refuses
 * (see documents/mixins/combatRoundMixin.mjs recordMovement). That's correct
 * for players, but a GM often needs to reposition an off-turn token mid-fight
 * (staging, knockback the automation missed, fixing a misplace).
 *
 * This toggle lets a GM lift ONLY the "not your turn" gate for movement:
 *
 *   Off-Turn Move: Off (default) → normal turn-gating; off-turn tokens locked.
 *   Off-Turn Move: On            → GM may drag any combatant's token freely.
 *
 * When on, an off-turn drag skips every movement budget gate (like the
 * per-actor Free-Actions override) and records NO budget against the moved
 * actor — the GM is repositioning, not spending that actor's turn. It only
 * relaxes the turn gate; on-turn actors and players are entirely unaffected,
 * and it never touches action/attack/cast economy.
 *
 * Client scope — a GM preference on their own client. Surfaced as a GM-only
 * button in the combat-tracker header alongside the other encounter toggles.
 */

import { ensureGmToggleBar, styleGmToggleButton, paintGmToggleState } from "./gm-tracker-toggles.mjs";

const SYSTEM_ID     = "witcher-ttrpg-death-march";
const OFFTURN_KEY   = "gmOffTurnMove";

/** Off-Turn Move toggle (client scope). Default FALSE = normal turn-gating. */
export function isGmOffTurnMoveEnabled() {
    try { return game.settings.get(SYSTEM_ID, OFFTURN_KEY) === true; }
    catch (_) { return false; }
}

/** True only on a GM client that has turned Off-Turn Move ON — the one state
 *  in which the movement turn-gate should be bypassed. Movement gates call
 *  this so the override is centralized and can't drift out of sync. */
export function gmOffTurnMoveActive() {
    return !!game.user?.isGM && isGmOffTurnMoveEnabled();
}

/** GM-only "Off-Turn Move" button in the shared tracker toggle bar. Toggles the
 *  client setting; the next drag reads it live, so no canvas refresh needed. */
function renderGmOffTurnMoveToggle(_app, html) {
    if (!game.user?.isGM) return;
    const bar = ensureGmToggleBar(html);
    if (!bar) return;
    /* Idempotent — remove any previous button before injecting. */
    bar.querySelectorAll(".wdm-offturn-move-toggle").forEach(n => n.remove());

    const btn = document.createElement("button");
    btn.type = "button";
    btn.classList.add("wdm-offturn-move-toggle");
    styleGmToggleButton(btn);
    const paint = () => {
        const on = isGmOffTurnMoveEnabled();
        btn.innerHTML = `<i class="fa-solid fa-arrows-up-down-left-right"></i><span>Off-Turn Move: ${on ? "On" : "Off"}</span>`;
        paintGmToggleState(btn, on);
        btn.title = "ON = GM can drag any combatant's token regardless of whose turn it is (no budget spent)";
    };
    btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        try { await game.settings.set(SYSTEM_ID, OFFTURN_KEY, !isGmOffTurnMoveEnabled()); }
        catch (_) {}
        paint();
    });
    paint();
    bar.appendChild(btn);
}

export function registerGmOffTurnMove() {
    Hooks.on("renderCombatTracker", renderGmOffTurnMoveToggle);
}
