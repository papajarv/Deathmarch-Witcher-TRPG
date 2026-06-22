/**
 * Auto-select the current combatant's token on the local client IFF the
 * local user owns its actor. Lets the GM running multiple NPCs jump
 * straight to controlling whoever's turn it is without hunting on the
 * canvas — and skips player-owned tokens so it never steals selection
 * from the player whose turn it is.
 *
 * Fires on `combatTurnChange` (Foundry v13+) which dispatches for every
 * turn boundary (round start, turn advance, turn rewind, combat start).
 * Uses `releaseOthers: true` so the previously-controlled NPC drops
 * selection — keeps the GM's view clean.
 */

const SYSTEM_ID = "witcher-ttrpg-death-march";

function tokenForCombatant(combat, combatant) {
    if (!combat || !combatant) return null;
    const sceneId = combat.scene?.id ?? combat.sceneId;
    const scene   = sceneId ? game.scenes?.get(sceneId) : canvas?.scene;
    const tokDoc  = scene?.tokens?.get?.(combatant.tokenId);
    return tokDoc?.object ?? null;
}

function autoSelectForTurn(combat) {
    if (!combat || combat.scene?.id !== canvas?.scene?.id) return;
    const combatant = combat.combatant;
    if (!combatant) return;
    const actor = combatant.actor;
    if (!actor?.isOwner) return;
    /* If you own the active combatant's actor, select its token —
     * always. The earlier "skip when another player owns it too"
     * guard was preventing player-side auto-select for shared actors
     * (and in general was too conservative — the user explicitly
     * wants the token selected whenever it's THEIR character's turn). */
    const tok = tokenForCombatant(combat, combatant);
    if (!tok) return;
    try { tok.control({ releaseOthers: true }); }
    catch (err) { console.warn(`${SYSTEM_ID} | auto-select on turn failed`, err); }
}

export function registerCanvasAutoSelectTurn() {
    Hooks.on("combatTurnChange", (combat) => autoSelectForTurn(combat));
    /* `combatStart` also routes through combatTurnChange in v13+, but
     * we listen explicitly for safety against future Foundry refactors. */
    Hooks.on("combatStart",      (combat) => autoSelectForTurn(combat));
}
