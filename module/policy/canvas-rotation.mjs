import { t, tFormat } from "../chrome/lib/i18n.js";
/**
 * Canvas-rotation movement charge.
 *
 * Rotation is FREE: rotating a token in place never costs movement. We
 * determined long ago that turning during your turn doesn't spend budget, so
 * `metersPerRotationUnit()` is hard-locked to 0 and the old per-90° cost
 * setting has been removed. The charge machinery below is kept dormant (behind
 * the 0-rate short-circuit) only so the feature could be revived behind a
 * proper new toggle without reshaping the caller.
 */

const SYSTEM_ID = "witcher-ttrpg-death-march";
const DEG_PER_ROTATION_UNIT = 90;   // 90° of rotation = 1 charging unit

/* Movement meters charged per 90° of rotation. Hard-locked to 0 — rotation is
 * free. Kept as a function so the caller shape doesn't change if the feature is
 * ever brought back behind a proper new toggle. */
function metersPerRotationUnit() {
    return 0;
}

/** Shortest signed angular distance between two angles (degrees), wrapped
 *  to (-180, 180]. Magnitude is what we charge. */
function shortestAngleDelta(fromDeg, toDeg) {
    let d = ((Number(toDeg) || 0) - (Number(fromDeg) || 0)) % 360;
    if (d > 180) d -= 360;
    else if (d < -180) d += 360;
    return d;
}

/** Per-actor accumulator (degrees). Cleared on combat turn change. */
const rotationAccum = new Map();
/** Per-actor running total of rotation METERS spent this turn (the
 *  charged units, not the residue). canvas-movement.mjs reads this so
 *  it can ADD the rotation cost on top of the path-history total when
 *  it sets `system.combatRound.movementMeters` — otherwise a subsequent
 *  canvas drag would overwrite movementMeters with path-only and erase
 *  the prior rotation charge. */
const rotationMetersSpent = new Map();
function resetAccumFor(actorId) {
    rotationAccum.delete(actorId);
    rotationMetersSpent.delete(actorId);
}
function clearAllAccum() {
    rotationAccum.clear();
    rotationMetersSpent.clear();
}
/** Read the rotation meters charged so far this turn. Public so
 *  canvas-movement can fold them into the path-history total. */
export function rotationMetersChargedThisTurn(actorId) {
    return Number(rotationMetersSpent.get(actorId)) || 0;
}

/** Read the residual rotation for an actor (degrees), default 0. */
function readAccum(actorId) { return rotationAccum.get(actorId) || 0; }
function writeAccum(actorId, deg) {
    if (!deg) rotationAccum.delete(actorId);
    else rotationAccum.set(actorId, deg);
}

function onPreUpdateToken(tokenDoc, changes, options, userId) {
    if (userId !== game.user?.id) return;
    if (options?.wdmRollback) return;             // self-issued snap-back
    /* Auto-facing rotations from the target-tracking hook are free —
     * facing your target costs no movement (the user explicitly asked
     * for this; matches the common houserule that "free-facing" is the
     * baseline and only deliberate spinning eats budget). */
    if (options?.wdmFreeFacing) return;
    if (changes?.rotation === undefined) return;  // not a rotation update
    /* Rotations that come bundled with a position change are part of a
     * drag-and-face — let canvas-movement.mjs handle the cost from the
     * x/y delta and don't double-charge. */
    if ("x" in changes || "y" in changes) return;

    const actor = tokenDoc?.actor ?? null;
    if (!actor) return;
    if (typeof actor.recordMovement !== "function") return;
    if (!actor._inActiveCombat) return;            // free out of combat

    const fromDeg = Number(tokenDoc.rotation) || 0;
    const toDeg   = Number(changes.rotation)   || 0;
    const delta   = Math.abs(shortestAngleDelta(fromDeg, toDeg));
    if (delta <= 0) return;

    /* Turn-order gate — apply BEFORE the free-rotation early-return.
     * Rotating a token off-turn is disallowed in combat regardless of
     * whether spinning costs SPD: even a free rotation reveals a facing
     * change to the table, and the actor whose turn it isn't shouldn't
     * be adjusting stance. GM Free-Actions override still bypasses this
     * (dock-side action mixins already respect that flag; mirroring
     * here). */
    if (!actor._freeActionsMode) {
        if (!actor._isMyTurn) {
            ui.notifications?.warn(t("WITCHER.Policy.CanvasRotation.Notify.NotYourTurn", "Not your turn — can't rotate this token."));
            return false;
        }
        if (actor._actionLocked || actor._recoveryLocked) {
            ui.notifications?.warn(actor._actionLockMsg ?? t("WITCHER.Policy.CanvasRotation.Notify.CantRotate", "Can't rotate right now."));
            return false;
        }
    }

    /* GM-configured meters per 90° unit. 0 = rotation is free. */
    const metersPerUnit = metersPerRotationUnit();
    if (metersPerUnit <= 0) return;   // free rotation — skip the charge

    /* Accumulate + see if we crossed 90° thresholds. */
    const prior = readAccum(actor.id);
    const total = prior + delta;
    const units = Math.floor(total / DEG_PER_ROTATION_UNIT);
    if (units <= 0) {
        // Below threshold — bank the rotation, allow the update.
        writeAccum(actor.id, total);
        return;
    }

    /* Meters of movement to charge for the units crossed. */
    const chargeMeters = units * metersPerUnit;
    const residue = total - units * DEG_PER_ROTATION_UNIT;
    /* recordMovement is async; preUpdate hooks can't await. We optimistically
     * commit the accumulator + dispatch the recordMovement; if it fails the
     * snap-back hook will run via the rollback flag. Synchronously check the
     * pre-conditions that recordMovement also checks so the common refusals
     * are caught here without a flicker. */
    if (!actor._isMyTurn || actor._actionLocked || actor._recoveryLocked) {
        ui.notifications?.warn(t("WITCHER.Policy.CanvasRotation.Notify.CantRotateLocked", "Can't rotate — not your turn or you're locked."));
        return false;
    }
    if (actor._locked && !actor._round?.runUsed) {
        ui.notifications?.warn(t("WITCHER.Policy.CanvasRotation.Notify.TurnIsCommittedToAFull", "Turn is committed to a full-round action — rotation costs movement and is blocked."));
        return false;
    }
    const spd = Number(actor.system?.stats?.spd?.value) || 0;
    const prior_m = Number(actor._round?.movementMeters) || 0;
    const runMul = actor._round?.runUsed ? 3 : 1;
    const cap = spd ? spd * runMul : 0;
    const remaining = cap ? Math.max(0, cap - prior_m) : Infinity;
    if (cap && chargeMeters > remaining) {
        ui.notifications?.warn(tFormat("WITCHER.Policy.CanvasRotation.Notify.CantRotateBudget", { delta, chargeMeters, remaining }, `Can't rotate ${delta}° — would cost ${chargeMeters}m of movement but only ${remaining}m left this turn.`));
        return false;
    }

    /* All pre-checks passed — bank the residue + record the meters spent
     * in the per-actor running total (so a subsequent canvas drag's
     * post-update writer can ADD them on top of path-history meters and
     * not erase the rotation cost), then ASYNC charge the movement. */
    writeAccum(actor.id, residue);
    rotationMetersSpent.set(
        actor.id,
        (Number(rotationMetersSpent.get(actor.id)) || 0) + chargeMeters
    );
    Promise.resolve().then(async () => {
        try {
            const ok = await actor.recordMovement(chargeMeters);
            if (!ok) {
                /* Edge case: budget refused at the actor level even though our
                 * pre-check passed (race with another concurrent move). Revert
                 * the rotation and restore both accumulators. */
                writeAccum(actor.id, prior + delta);
                rotationMetersSpent.set(
                    actor.id,
                    Math.max(0, (Number(rotationMetersSpent.get(actor.id)) || 0) - chargeMeters)
                );
                try {
                    await tokenDoc.update({ rotation: fromDeg }, { wdmRollback: true });
                    ui.notifications?.warn(t("WITCHER.Policy.CanvasRotation.Notify.RotationRolledBackMovementBudgetRefused", "Rotation rolled back — movement budget refused."));
                } catch (err) {
                    console.warn(`${SYSTEM_ID} | rotation rollback failed`, err);
                }
            }
        } catch (err) {
            console.warn(`${SYSTEM_ID} | rotation charge failed`, err);
        }
    });
}

export function registerCanvasRotation() {
    Hooks.on("preUpdateToken", onPreUpdateToken);
    /* Reset accumulators when turns change (each combatant's accumulator
     * is per-turn). Belt-and-braces: clear all on combat end too. */
    Hooks.on("combatTurnChange", (combat) => {
        /* Clear the previous combatant's accumulator (they're done). */
        const prev = combat?.previous?.combatantId
            ? combat.combatants?.get?.(combat.previous.combatantId)?.actor
            : null;
        if (prev) resetAccumFor(prev.id);
    });
    Hooks.on("deleteCombat", () => clearAllAccum());
    Hooks.on("combatStart", () => clearAllAccum());
}
