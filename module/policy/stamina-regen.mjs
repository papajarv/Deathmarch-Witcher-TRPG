/**
 * Out-of-combat stamina regen — while no combat is running and the world
 * clock advances, every actor below max STA recovers its Recovery (REC) in
 * STA per turn-length (3s) of world time elapsed, as if taking the Recovery
 * action each turn.
 *
 * In combat the explicit Recovery action owns regen, and the running clock is
 * frozen anyway (time-flow.mjs bails on a started combat), so this only does
 * anything OUT of combat. Active-GM-only so connected clients don't each apply
 * the same regen.
 *
 * Optimization: the heavy `updateWorldTime` listener is only ATTACHED while at
 * least one actor needs topping off. Once every actor is at max STA it detaches
 * itself; a lightweight `updateActor` watcher re-attaches it the moment any
 * actor's STA drops below max. So a fully-rested party costs nothing per clock
 * tick.
 */

let worldTimeHookId = null;

/** This actor's Recovery (REC) — STA regained per turn out of combat. */
function recOf(actor) {
    return Number(actor?.system?.derivedStats?.rec) || 0;
}

/** True if this actor would gain anything from a regen tick right now. */
function needsRegen(actor) {
    if (!actor || typeof actor.recoverStamina !== "function") return false;
    if (actor.statuses?.has?.("dead")) return false;   // the dead don't rest
    const sta = actor.system?.derivedStats?.sta;
    const max = Number(sta?.max) || 0;
    const value = Number(sta?.value) || 0;
    return max > 0 && value < max && recOf(actor) > 0;
}

function anyNeedsRegen() {
    for (const actor of game.actors) if (needsRegen(actor)) return true;
    return false;
}

function arm() {
    if (worldTimeHookId != null) return;
    worldTimeHookId = Hooks.on("updateWorldTime", onWorldTime);
}

function disarm() {
    if (worldTimeHookId == null) return;
    Hooks.off("updateWorldTime", worldTimeHookId);
    worldTimeHookId = null;
}

async function onWorldTime(worldTime, delta) {
    if (!game.user?.isActiveGM) return;
    if (game.combat?.started) return;           // combat owns its own pacing
    if (!(Number(delta) > 0)) {                 // not a forward advance
        if (!anyNeedsRegen()) disarm();
        return;
    }
    const turnTime = Number(CONFIG.time?.turnTime) || 3;

    /* Count how many turnTime (3s) boundaries the advance crossed, using
     * ABSOLUTE worldTime. A naive floor(delta / turnTime) would discard the
     * sub-3s remainder on every call — and the running clock advances ~1s at a
     * time, so floor(1/3) = 0 forever and nothing would ever regen. */
    const now    = Number(worldTime);
    const before = now - Number(delta);
    const ticks  = Math.floor(now / turnTime) - Math.floor(before / turnTime);
    if (ticks <= 0) return;

    for (const actor of game.actors) {
        if (!needsRegen(actor)) continue;
        // recoverStamina clamps at max, so a long advance just tops the pool off.
        await actor.recoverStamina(recOf(actor) * ticks);
    }

    // Everyone topped off → stop listening until STA drops again.
    if (!anyNeedsRegen()) disarm();
}

export function registerStaminaRegen() {
    // Re-arm the moment any actor falls below max STA. updateActor fires on
    // every actor mutation (incl. our own recoverStamina writes, which is fine —
    // arm() is idempotent), so a drained pool always re-attaches the clock hook.
    Hooks.on("updateActor", (actor) => {
        if (game.user?.isActiveGM && needsRegen(actor)) arm();
    });
    // A freshly created/imported actor below max should regen too.
    Hooks.on("createActor", (actor) => {
        if (game.user?.isActiveGM && needsRegen(actor)) arm();
    });
    // Arm at startup if anyone already needs topping off.
    Hooks.on("ready", () => { if (game.user?.isActiveGM && anyNeedsRegen()) arm(); });
}
