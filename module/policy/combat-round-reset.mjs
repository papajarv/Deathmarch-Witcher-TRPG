/**
 * Combat round reset — refreshes a character's action-economy budget
 * (system.combatRound) at the start of THEIR turn in a Foundry combat.
 *
 * RAW (Core p.151): each round a participant gets a fresh movement + action.
 * We reset the new current combatant's actor when the turn advances to them
 * (combatStart / combatTurn / combatRound).
 *
 * To avoid every connected client writing the same update, only the active
 * GM resets (GMs can update any actor); if no GM is online, the actor's
 * owner does it. See combatRoundMixin for resetCombatRound().
 */

import { promptStatusEndChecks } from "../mechanics/statusEngine.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";

function iShouldWrite(actor) {
    const gm = game.users?.activeGM;
    if (gm) return gm.isSelf;
    return !!actor?.isOwner;
}

/* Who shows the status end-check dialogs: the controlling player if one is
 * connected, otherwise the active GM. Unlike the budget reset (a silent write
 * any GM can make), these are modal prompts that belong to whoever drives the
 * bearer. */
function iShouldPrompt(actor) {
    if (!actor) return false;
    const owner = game.users?.players?.find(u => u.active && actor.testUserPermission(u, "OWNER"));
    if (owner) return owner.isSelf;
    return !!game.users?.activeGM?.isSelf;
}

/* Client-local guard: combatTurn and combatRound can both fire on a round
 * boundary, and we only want one prompt sweep per combatant per round. */
const promptedThisRound = new Set();

async function promptEndChecks(combat) {
    const actor = combat?.combatant?.actor;
    if (!actor?.statuses?.size) return;
    if (!iShouldPrompt(actor)) return;
    const key = `${combat.id}:${combat.round}:${combat.combatant.id}`;
    if (promptedThisRound.has(key)) return;
    promptedThisRound.add(key);
    if (promptedThisRound.size > 64) {
        // Keep the guard set from growing without bound over a long session.
        promptedThisRound.clear();
        promptedThisRound.add(key);
    }
    try { await promptStatusEndChecks(actor); }
    catch (err) { console.warn("witcher-ttrpg-death-march | status end-check prompt failed", err); }
}

async function resetActor(actor) {
    if (!actor) return;
    // Only actors that carry the combatRound schema + mixin (characters).
    if (!actor.system?.combatRound || typeof actor.resetCombatRound !== "function") return;
    if (!iShouldWrite(actor)) return;
    try { await actor.resetCombatRound(); }
    catch (err) { console.warn("witcher-ttrpg-death-march | combat round reset failed", err); }
}

async function resetCurrentCombatant(combat) {
    await resetActor(combat?.combatant?.actor);
    await promptEndChecks(combat);
}

// Leaving combat refunds the budget AND clears combat-only statuses — Stunned
// and Fast Draw only mean anything inside a fight, so neither a stale "spent"
// state nor a lingering status should carry past it.
async function endCombatForActor(actor) {
    await resetActor(actor);
    if (!actor || !iShouldWrite(actor)) return;
    for (const id of ["stunned", "fastDraw"]) {
        if (!actor.statuses?.has?.(id)) continue;
        try { await actor.toggleStatusEffect?.(id, { active: false }); }
        catch (err) { console.warn(`witcher-ttrpg-death-march | end-of-combat ${id} clear failed`, err); }
    }
    // Adrenaline is a combat-only resource: it drains to 0 when the fight ends,
    // and any temp HP it bought (tracked on the actor flag — see dock.js
    // promptAdrenalineTempHp) evaporates with it. Temp HP from other sources
    // (potions, effects) is left untouched.
    try {
        const upd = {};
        if ((Number(actor.system?.adrenaline?.value) || 0) > 0) {
            upd["system.adrenaline.value"] = 0;
        }
        const adrTemp = Math.max(0, Number(actor.getFlag?.(SYSTEM_ID, "adrenalineTempHp")) || 0);
        if (adrTemp > 0) {
            const curTemp = Math.max(0, Number(actor.system?.derivedStats?.hp?.temp) || 0);
            upd["system.derivedStats.hp.temp"] = Math.max(0, curTemp - adrTemp);
            upd[`flags.${SYSTEM_ID}.adrenalineTempHp`] = 0;
        }
        if (Object.keys(upd).length) await actor.update(upd);
    } catch (err) {
        console.warn("witcher-ttrpg-death-march | end-of-combat adrenaline reset failed", err);
    }
}

async function endCombatForAll(combat) {
    const actors = combat?.combatants?.map(cb => cb.actor) ?? [];
    await Promise.all(actors.map(endCombatForActor));
}

/* combatMods.startingAdrenaline — schools that open a fight with adrenaline
 * already banked. Set once at combat start for every combatant that has it. */
async function applyStartingAdrenaline(combat) {
    for (const cb of combat?.combatants ?? []) {
        const actor = cb.actor;
        const start = Number(actor?.system?.combatMods?.startingAdrenaline) || 0;
        if (start <= 0 || !actor.system?.adrenaline || !iShouldWrite(actor)) continue;
        if ((Number(actor.system.adrenaline.value) || 0) < start) {
            try { await actor.update({ "system.adrenaline.value": start }); }
            catch (err) { console.warn("witcher-ttrpg-death-march | starting adrenaline failed", err); }
        }
    }
}

export function registerCombatRoundReset() {
    Hooks.on("combatStart", (combat) => { resetCurrentCombatant(combat); applyStartingAdrenaline(combat); });
    Hooks.on("combatTurn",  (combat) => resetCurrentCombatant(combat));
    Hooks.on("combatRound", (combat) => resetCurrentCombatant(combat));
    // Combat ends → refund everyone's budget and clear Stunned.
    Hooks.on("deleteCombat", (combat) => endCombatForAll(combat));
    // A single fighter removed from the tracker → refund + unstun just them.
    Hooks.on("deleteCombatant", (combatant) => endCombatForActor(combatant?.actor));
}
