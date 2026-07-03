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

async function promptEndChecks(combat, upcoming, upcomingRound) {
    const actor = upcoming?.actor;
    if (!actor?.statuses?.size) return;
    if (!iShouldPrompt(actor)) return;
    const key = `${combat.id}:${upcomingRound}:${upcoming.id}`;
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
    // Actors that carry the combatRound schema + mixin (characters AND
    // monsters — monster.mjs added combatRoundSchema for action-economy
    // parity on the chrome dock).
    if (!actor.system?.combatRound || typeof actor.resetCombatRound !== "function") return;
    if (!iShouldWrite(actor)) return;
    try { await actor.resetCombatRound(); }
    catch (err) { console.warn("witcher-ttrpg-death-march | combat round reset failed", err); }
    /* Per-attack ROF tally (monsters only) — flagged on the actor so the
     * dock can grey-out spent swings. UnsetFlag fully removes the key so
     * the next round starts with full ROF on every attack (setFlag({}) is
     * a MERGE and leaves the existing counts intact). */
    if (actor.type === "monster") {
        try { await actor.unsetFlag(SYSTEM_ID, "monsterAttackUsed"); }
        catch (err) { console.warn("witcher-ttrpg-death-march | monster ROF reset failed", err); }
    }
}

/* `combatTurnChange` fires from `Combat#_onUpdate → _manageTurnEvents`,
 * which runs AFTER the combat document has been updated. By the time we
 * see it, `combat.combatant` and `combat.round` are the NEW values — no
 * need to compute the upcoming combatant from updateData. This avoids the
 * pre-update subtlety in combatTurn/combatRound (which fire BEFORE the
 * update and leave combat.combatant pointing at the OUTGOING combatant). */
async function resetUpcoming(combat) {
    const upcoming = combat?.combatant;
    if (!upcoming) return;
    await resetActor(upcoming.actor);
    await promptEndChecks(combat, upcoming, combat.round);
    /* Fast Draw enforcement (Core p.165): "You may draw a weapon as a free
     * action, but you MUST attack with that weapon this turn." If the
     * outgoing combatant still has the `fastDraw` status, they fast-drew
     * but never made the attack — clear the status and post a chat warning
     * so the table notices. (Real attacks clear fastDraw inside
     * weaponAttack; only an unused fast-draw survives to this point.) */
    try { await checkFastDrawOnTurnEnd(combat); }
    catch (err) { console.warn("witcher-ttrpg-death-march | fast-draw check failed", err); }
}

async function checkFastDrawOnTurnEnd(combat) {
    const prevId = combat?.previous?.combatantId;
    if (!prevId) return;
    const prev = combat.combatants?.get?.(prevId);
    const actor = prev?.actor;
    if (!actor?.statuses?.has?.("fastDraw")) return;
    if (!iShouldWrite(actor)) return;     // only one client should clean + post
    try { await actor.toggleStatusEffect?.("fastDraw", { active: false }); }
    catch (err) { console.warn("witcher-ttrpg-death-march | clear stale fastDraw failed", err); }
    try {
        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            content: `<em><strong>${actor.name}</strong> ended their turn without attacking after a Fast Draw — RAW (Core p.165) requires the snap-draw to be followed by an attack with the drawn weapon. The Fast Draw status has been cleared; rule the move as the GM sees fit.</em>`,
            flags: { "witcher-ttrpg-death-march": { category: "combat" } }
        });
    } catch (err) { console.warn("witcher-ttrpg-death-march | fast-draw warning post failed", err); }
}

/* Lightweight refund: just the per-turn budget. Used when a SINGLE combatant
 * is removed from the tracker (typically because their token was deleted —
 * deleteToken auto-deletes the combatant, which fires deleteCombatant on
 * us). Status effects on the actor are LEFT ALONE: stunned/fastDraw are
 * real player-managed states and shouldn't evaporate just because the
 * token vanished from the canvas. */
async function refundBudgetForActor(actor) {
    await resetActor(actor);
}

/* Full combat-end teardown for a single actor. Used by `endCombatForAll`
 * when the whole combat ends (deleteCombat). Refunds budget, clears the
 * two combat-only statuses (Stunned, Fast Draw — they have no meaning
 * outside a fight), and drains adrenaline + the temp HP it bought.
 * NOT used for single-combatant removal — see refundBudgetForActor. */
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
    await Promise.all(actors.map(async (actor) => {
        await endCombatForActor(actor);
        await resetGuardForActor(actor);
    }));
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

/* Combat Extended — copy each combatant's preferred guard to current at
 * combat start (rules1.png: actors enter combat in their chosen guard).
 * No-op when CE is off, when the actor has no guard schema, or when this
 * client doesn't own the actor write. Falls back to "balanced" when the
 * preferred value is unset / invalid. */
/* Apply an actor's preferred guard to their current. No-op when CE is
 * off / actor lacks the guard schema / nothing would change. Shared
 * between the combatStart path (whole combat) and the createCombatant
 * path (single late-joining combatant). */
async function applyPreferredGuardForActor(actor) {
    let ceOn = false;
    try {
        const { isCombatExtendedEnabled } = await import("../api/homebrew.mjs");
        ceOn = isCombatExtendedEnabled();
    } catch (_) { return; }
    if (!ceOn) return;
    if (!actor?.system?.guard || !iShouldWrite(actor)) return;
    const { GUARD_KEYS } = await import("../data/actor/templates/guard.mjs");
    const pref = String(actor.system.guard.preferred ?? "balanced");
    const next = GUARD_KEYS.includes(pref) ? pref : "balanced";
    if (actor.system.guard.current === next) return;
    try {
        await actor.update({ "system.guard.current": next });
    } catch (err) {
        console.warn("witcher-ttrpg-death-march | preferred guard apply failed", err);
    }
}

async function applyPreferredGuards(combat) {
    for (const cb of combat?.combatants ?? []) {
        await applyPreferredGuardForActor(cb.actor);
    }
}

/* (Removed in the multi-use Special Action redesign.) The old single-use
 * `lockedThisRound` lock-clear hook is unnecessary now — Special Actions
 * are capped naturally by the existing action economy (movement / action /
 * extra), which resets per turn via resetActor. The field still exists in
 * the schema for backward compat but is no longer read or written. */

/* Combat Extended — reset guard to balanced + clear the slot lock + drop
 * any raised shield when a combat ends. Persisted preferred guard is left
 * alone (it's the actor's default stance, not combat-only). Also clears
 * the Restricted Vision status if it was applied by Raise Shield (the
 * armor-quality path keeps the status as long as the visor is down). */
async function resetGuardForActor(actor) {
    let ceOn = false;
    try {
        const { isCombatExtendedEnabled } = await import("../api/homebrew.mjs");
        ceOn = isCombatExtendedEnabled();
    } catch (_) { return; }
    if (!ceOn) return;
    if (!actor?.system?.guard || !iShouldWrite(actor)) return;
    const g = actor.system.guard;
    const sr = g.shieldRaised ?? {};
    const needsReset =
        g.current !== "balanced" ||
        !!sr.itemId ||
        sr.coveredLocations?.length;
    if (!needsReset) return;
    try {
        await actor.update({
            "system.guard.current":                       "balanced",
            "system.guard.shieldRaised.itemId":           "",
            "system.guard.shieldRaised.coveredLocations": [],
            "system.guard.shieldRaised.headCovered":      false
        });
    } catch (err) {
        console.warn("witcher-ttrpg-death-march | guard end-of-combat reset failed", err);
    }
    /* If Raise Shield's head-cover applied Restricted Vision, lift it now.
     * The status normally clears on `ownTurnStart`, but combat ending
     * means the actor never gets another own turn — without this, the
     * status sticks around out of combat.
     *
     * Caveat: the armor-quality (visor-down) path will also apply this
     * status persistently. We can't reliably tell which path applied it
     * from the status alone — the practical compromise is: if head was
     * covered (i.e. Raise Shield is the most recent applier on THIS
     * actor), clear the status. Visor-down GMs can re-apply if needed. */
    if (sr.headCovered && actor.statuses?.has?.("restrictedVision")) {
        try { await actor.toggleStatusEffect?.("restrictedVision", { active: false }); }
        catch (err) { console.warn("witcher-ttrpg-death-march | restrictedVision lift at combat end failed", err); }
    }
}

export function registerCombatRoundReset() {
    // Adrenaline bootstrap fires once at combat start (combatants are stable
    // at that point; we don't need the post-update state).
    Hooks.on("combatStart", (combat) => {
        applyStartingAdrenaline(combat);
        // Combat Extended — copy preferred guard to current for every
        // combatant. No-op when CE is off; see policy/combat-round-reset.
        applyPreferredGuards(combat);
    });
    // combatTurnChange covers every turn transition (start, mid-round turn
    // advance, round rollover, manual jumps) and fires AFTER the combat
    // update is applied — so combat.combatant is already the new combatant.
    Hooks.on("combatTurnChange", (combat) => resetUpcoming(combat));
    /* Target reset between rounds — RAW: a new round means new tactical
     * focus, so the user's current targets shouldn't silently carry over.
     * `combatRound` fires once per round transition (not per turn), so this
     * doesn't churn target state mid-round. Each client clears its OWN
     * targets only (a player can't release another player's targets). */
    Hooks.on("combatRound", (combat) => {
        try {
            for (const t of [...(game.user?.targets ?? [])]) {
                t.setTarget(false, { user: game.user, releaseOthers: false, groupSelection: false });
            }
        } catch (err) {
            console.warn("witcher-ttrpg-death-march | round target reset failed", err);
        }
        /* The old per-round Special Action lock-clear used to live here;
         * removed when Special Actions became multi-use (capped by the
         * existing action economy). resetActor on each turn change handles
         * per-turn slot reset already. */
    });
    // Combat ends → refund everyone's budget and clear combat-only statuses.
    Hooks.on("deleteCombat", (combat) => endCombatForAll(combat));
    /* Combat Extended — a fighter added MID-combat should also enter in
     * their preferred guard. combatStart already handles the at-the-start
     * case; this picks up late joiners. Gated on combat.started so the
     * combatStart pass doesn't double-apply (createCombatant also fires
     * for the initial pre-start additions). */
    Hooks.on("createCombatant", async (combatant) => {
        try {
            if (!combatant?.combat?.started) return;
            await applyPreferredGuardForActor(combatant.actor);
        } catch (err) {
            console.warn("witcher-ttrpg-death-march | late-joiner guard apply failed", err);
        }
    });
    /* A single fighter removed from the tracker (or whose token was just
     * deleted) → ONLY refund their budget. We deliberately don't strip
     * stunned/fastDraw here: when Foundry auto-deletes a combatant
     * because its token went away, the actor's status effects shouldn't
     * silently disappear with it. */
    Hooks.on("deleteCombatant", (combatant) => refundBudgetForActor(combatant?.actor));
}
