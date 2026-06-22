/**
 * Canvas-movement integration.
 *
 * Bridges Foundry canvas token drags / nudges to the actor's combat-round
 * movement budget (combatRoundMixin.recordMovement). Out of combat, token
 * movement is free and untracked — same as the sheet / dock buttons. In
 * combat, the budget is charged using meters derived from the grid:
 *   meters = Euclidean(pixels) / grid.size × scene.grid.distance
 *
 * Two hooks, both gated by `userId === game.user.id` so only the client
 * that initiated the drag writes the budget:
 *
 *   preUpdateToken — hard-cancel the move if the actor is stunned / lock-
 *     ed (Paralyzed, Unconscious, full-round-action committed). Without
 *     this gate the visual canvas drag would commit but the budget couldn't
 *     legally charge, leaving the player believing they moved while their
 *     character can't act.
 *
 *   updateToken — once the move has committed, call recordMovement on the
 *     token's actor. recordMovement self-gates on `_inActiveCombat` (free
 *     out of combat), validates against `splitMovement` / RAW rules,
 *     records the meters, and notifies if over SPD or already-acted.
 *
 * "Token's actor" means whatever `tokenDoc.actor` returns: a linked actor
 * for linked tokens, a synthetic per-token actor for unlinked. Foundry V13
 * routes the actor.update writes through the appropriate doc automatically,
 * so unlinked tokens of the same base have independent budgets.
 */

import { rotationMetersChargedThisTurn } from "./canvas-rotation.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";

/* Total scene-distance moved this turn, read from Foundry's own
 * `_movementHistory` waypoint list. Foundry clears this on combat turn
 * transitions, so its sum IS the per-turn movement total the on-canvas
 * ruler displays. Returns 0 if the history is empty / shorter than a
 * single segment, or if the measurement fails. */
function movementHistoryTotal(tokenDoc) {
    const history = tokenDoc?._source?._movementHistory ?? tokenDoc?._movementHistory ?? [];
    if (!Array.isArray(history) || history.length < 2) return 0;
    try {
        const r = tokenDoc.measureMovementPath?.(history)
               ?? canvas?.grid?.measurePath?.(history);
        const d = r?.distance ?? r?.cost ?? 0;
        return Number.isFinite(d) ? d : 0;
    } catch (_) { return 0; }
}

/* Measure a single proposed move (cached prev → proposed destination)
 * along the grid. Path-aware via Foundry's measure functions; falls
 * through to Euclidean. Used by the preUpdate cap-pre-check, where we
 * don't yet have the post-update history. */
function measureProposedSegment(tokenDoc, fromPt, toPt) {
    const path = [fromPt, toPt];
    try {
        const r = tokenDoc.measureMovementPath?.(path)
               ?? canvas?.grid?.measurePath?.(path);
        const d = r?.distance ?? r?.cost ?? null;
        if (Number.isFinite(d) && d >= 0) return d;
    } catch (_) { /* fall through */ }
    const dx = (toPt?.x ?? 0) - (fromPt?.x ?? 0);
    const dy = (toPt?.y ?? 0) - (fromPt?.y ?? 0);
    const px = Math.hypot(dx, dy);
    const gridSize = Number(canvas?.grid?.size) || 100;
    const sceneDist = Number(canvas?.scene?.grid?.distance) || 1;
    return (px / gridSize) * sceneDist;
}

/* True if x/y are in the changes payload — Foundry omits unchanged fields. */
function isMoveChange(changes) {
    return ("x" in changes) || ("y" in changes);
}

/* Resolve the actor whose budget the token movement should charge. Falls
 * back to null when the token has no actor (drawing tokens, etc.). */
function tokenActor(tokenDoc) {
    return tokenDoc?.actor ?? null;
}

/* Pre-update gate: block canvas drags that the actor can't legally make
 * because it's not their turn, they're stunned, or they're committed to a
 * full-round action other than Run. Returning `false` from a preUpdate
 * hook cancels the database update — Foundry then snaps the token back
 * to its previous position automatically. */
function onPreUpdateToken(tokenDoc, changes, options, userId) {
    if (userId !== game.user?.id) return;
    if (options?.wdmRollback) return;   // self-issued snap-back; let it through
    /* Reposition defensive reaction overrides the not-your-turn and
     * budget gates — it's a free positional adjustment that fires on
     * someone else's turn (defenseMixin.showRepositionOverlay sets
     * this flag when committing the click-to-destination move). */
    if (options?.wdmFreeReposition) return;
    if (!isMoveChange(changes)) return;
    const actor = tokenActor(tokenDoc);
    if (!actor) return;
    if (typeof actor.recordMovement !== "function") return; // not a witcher actor
    if (!actor._inActiveCombat) return;                     // free out of combat

    /* Hard-stop conditions, mirroring the same checks recordMovement uses
     * but applied BEFORE the canvas update so the token doesn't visually
     * commit a move that the budget would refuse. */
    if (!actor._isMyTurn) {
        ui.notifications?.warn("Not your turn — can't move this token.");
        return false;
    }
    if (actor._actionLocked || actor._recoveryLocked) {
        ui.notifications?.warn(actor._actionLockMsg ?? "Can't move right now.");
        return false;
    }
    /* Full-round action lock — but Run IS a full-round action whose entire
     * point is to move, so it must be allowed through. */
    if (actor._locked && !actor._round?.runUsed) {
        ui.notifications?.warn("Turn is committed to a full-round action.");
        return false;
    }

    /* Pre-check the budget cap to cancel over-cap drags BEFORE the visual
     * lands. Predict the new history total: current history + the proposed
     * segment, both measured by Foundry's path-aware functions so the
     * numbers match the on-canvas ruler and the post-update writer.
     * Cap check is on the PROJECTED total, not the delta — a 1m drag that
     * brings 7/8 to 8/8 is allowed; a 2m drag bringing 7/8 to 9/8 isn't.
     *
     * If the move would exceed the normal cap but FITS within a Run
     * cap (SPD × 3), prompt the user to spend the full turn on a Run.
     * Accepting commits the Run action and re-triggers the canvas update
     * with the now-tripled cap. */
    const prev = getRememberedPos(tokenDoc);
    if (prev) {
        const toX = (changes.x !== undefined) ? changes.x : tokenDoc.x;
        const toY = (changes.y !== undefined) ? changes.y : tokenDoc.y;
        const unitsPerSpd = Number(game.settings?.get?.(SYSTEM_ID, "spdUnitsPerPoint")) || 1;
        /* Project the post-update total by simulating: take current history,
         * append the new waypoint, measure with the SAME function the post-
         * update writer uses. Round once at the end. This eliminates the
         * round-and-add drift that was rejecting moves like 22→24 (raw
         * 21.8+2.4=24.2 rounded as 24 but ">cap" because the comparison
         * happened pre-round). */
        const history = tokenDoc?._source?._movementHistory ?? tokenDoc?._movementHistory ?? [];
        const simulatedPath = (Array.isArray(history) && history.length)
            ? [...history, { x: toX, y: toY }]
            : [{ x: prev.x, y: prev.y }, { x: toX, y: toY }];
        let projectedScene = 0;
        try {
            const r = tokenDoc.measureMovementPath?.(simulatedPath)
                   ?? canvas?.grid?.measurePath?.(simulatedPath);
            projectedScene = Number(r?.distance ?? r?.cost ?? 0) || 0;
        } catch (_) {
            // Fallback: treat as current total + raw segment
            projectedScene = movementHistoryTotal(tokenDoc)
                + measureProposedSegment(tokenDoc, { x: prev.x, y: prev.y }, { x: toX, y: toY });
        }
        /* Fold rotation cost into the projected total (same reason the
         * post-update writer does below — rotation isn't in _movementHistory). */
        const rotationMeters = rotationMetersChargedThisTurn(actor.id);
        const projectedMeters = Math.round(projectedScene / unitsPerSpd) + rotationMeters;
        const currentTotal = movementHistoryTotal(tokenDoc);
        const segment = projectedScene - currentTotal;
        const spd = Number(actor.system?.stats?.spd?.value) || 0;
        const cap = spd * (actor._round?.runUsed ? 3 : 1);
        if (cap && projectedMeters > cap) {
            const runCap = spd * 3;
            const segMeters = Math.round(segment / unitsPerSpd);
            const currentMeters = Math.round(currentTotal / unitsPerSpd);

            /* Already Running and STILL over → no upgrade path, refuse. */
            if (actor._round?.runUsed) {
                ui.notifications?.warn(`Can't move ${segMeters}m — would exceed Run cap of ${runCap}m (currently ${currentMeters}m).`);
                return false;
            }
            /* Move would fit if they Ran — prompt. Defer the dialog with
             * a microtask so this preUpdate hook can return cleanly first. */
            if (projectedMeters <= runCap) {
                Promise.resolve().then(() => promptRunUpgrade(actor, tokenDoc,
                    { x: toX, y: toY }, projectedMeters, runCap));
                return false;
            }
            /* Wouldn't fit even with Run — refuse outright. */
            ui.notifications?.warn(`Can't move ${segMeters}m — exceeds Run cap of ${runCap}m even with full-round Run.`);
            return false;
        }
    }
}

/* Open the Run-upgrade prompt and (on accept) commit the Run action and
 * re-trigger the cancelled drag. Run is the full-round action of moving
 * SPD × 3 metres — it locks normal/extra action slots for the rest of
 * the turn. */
async function promptRunUpgrade(actor, tokenDoc, destination, projectedMeters, runCap) {
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2) return;
    let confirmed = false;
    try {
        confirmed = await DialogV2.confirm({
            window: { title: "Run?", icon: "fa-solid fa-person-running" },
            content: `<div style="padding:8px 2px;">
                <p>That move would put you at <strong>${projectedMeters}m</strong>, past your normal cap.</p>
                <p>Spend your full turn on a <strong>Run</strong> (SPD × 3 = <strong>${runCap}m</strong>) to keep moving?</p>
                <p style="opacity:0.7;font-size:11px;margin-bottom:0;">Run locks your normal and extra action this turn.</p>
            </div>`,
            yes: { label: "Run", icon: "fa-solid fa-person-running" },
            no:  { label: "Cancel" },
            rejectClose: false
        });
    } catch (_) { confirmed = false; }
    if (!confirmed) return;

    try {
        const ok = await actor.recordRun();
        if (ok === false) return;
    } catch (err) {
        console.warn(`${SYSTEM_ID} | recordRun failed`, err);
        return;
    }
    /* Re-issue the canvas update now that the Run cap is in effect. */
    try {
        await tokenDoc.update({ x: destination.x, y: destination.y });
    } catch (err) {
        console.warn(`${SYSTEM_ID} | canvas-move: Run-upgrade re-trigger failed`, err);
    }
}

/* Post-update writer: the move has committed; charge the budget. If
 * recordMovement returns false (over budget / split-movement-disabled
 * and already moved / etc.), snap the token back to its prior position
 * so the visual and the budget agree.
 *
 * Distance is computed from the position we stashed in preUpdateToken
 * (`options.wdmPrevPos`) — by the time updateToken runs, `tokenDoc.x/y`
 * is already the NEW value, so we can't read the old one off the doc. */
async function onUpdateToken(tokenDoc, changes, options, userId) {
    if (userId !== game.user?.id) return;
    if (options?.wdmRollback) return;   // self-issued snap-back; don't re-cache or re-charge
    /* Reposition reaction — already gated by preUpdate; don't charge
     * movement budget on the way out either. */
    if (options?.wdmFreeReposition) { rememberPos(tokenDoc); return; }
    if (!isMoveChange(changes)) return;
    const actor = tokenActor(tokenDoc);

    /* For non-witcher actors, non-combat actors, or tokens without an
     * actor at all: just update the cache so future drags have a baseline.
     * No budget charge — out-of-combat / non-witcher movement is free. */
    if (!actor
        || typeof actor.recordMovement !== "function"
        || !actor._inActiveCombat) {
        rememberPos(tokenDoc);
        return;
    }

    const fromX = options?.wdmPrevPos?.x;
    const fromY = options?.wdmPrevPos?.y;
    if (fromX == null || fromY == null) {
        /* No baseline (drag arrived without our stash) — cache the new
         * pos so the NEXT drag has one, but skip charging this one. */
        rememberPos(tokenDoc);
        return;
    }

    /* Authoritative per-turn total = sum of Foundry's _movementHistory,
     * measured path-aware (same numbers the on-canvas ruler shows). We
     * SET movementMeters to this total each time rather than incrementing
     * by a per-drag delta — the latter would drift as rounding errors
     * accumulated across many small drags, and over time the budget would
     * report a different number than the ruler. */
    const unitsPerSpd = Number(game.settings?.get?.(SYSTEM_ID, "spdUnitsPerPoint")) || 1;
    const totalSceneUnits = movementHistoryTotal(tokenDoc);
    const pathMeters = Math.max(0, Math.round(totalSceneUnits / unitsPerSpd));
    /* Rotation cost spent this turn (banked in canvas-rotation.mjs) is
     * NOT visible in Foundry's _movementHistory — rotation isn't a
     * position waypoint. Sum it in so the running total accounts for
     * both canvas drags AND turn-in-place charges. Without this, a
     * canvas drag after rotating would overwrite movementMeters with
     * the path-only total and erase the rotation cost. */
    const rotationMeters = rotationMetersChargedThisTurn(actor.id);
    const newTotalMeters = pathMeters + rotationMeters;
    const spd = Number(actor.system?.stats?.spd?.value) || 0;
    const cap = spd * (actor._round?.runUsed ? 3 : 1);
    console.log(`${SYSTEM_ID} | canvas-move ${actor.name}: path ${pathMeters}m + rotation ${rotationMeters}m = ${newTotalMeters}m (cap ${cap}m)`);

    /* Over cap — snap back. This is the safety net for cases the preUpdate
     * pre-check missed (e.g. Foundry's history measurement disagreeing
     * with the segment estimate). */
    let ok = true;
    if (cap && newTotalMeters > cap) {
        ok = false;
        ui.notifications?.warn(`Movement would total ${newTotalMeters}m — exceeds cap of ${cap}m.`);
    } else {
        try {
            await actor.update({
                "system.combatRound.movementMeters": newTotalMeters,
                "system.combatRound.movementUsed": cap > 0 && newTotalMeters >= cap
            });
        } catch (err) {
            console.warn(`${SYSTEM_ID} | canvas-move: write failed`, err);
            ok = false;
        }
    }

    if (ok !== false) {
        rememberPos(tokenDoc);
    } else {
        /* Refused → snap back. Pass `wdmRollback:true` so our preUpdate
         * gate skips re-validating this rollback, AND the secondary cache
         * hook below skips re-caching the rolled-back position (we want
         * the cache to keep the pre-rollback position so the user's NEXT
         * drag measures from where they actually are after the snap). */
        try {
            await tokenDoc.update(
                { x: fromX, y: fromY },
                { wdmRollback: true, animate: false }
            );
            /* After rollback, the doc is at (fromX, fromY) — same as cache.
             * Explicit rememberPos here is a no-op but documents intent. */
            rememberPos(tokenDoc);
        } catch (err) {
            console.warn(`${SYSTEM_ID} | canvas movement rollback failed`, err);
        }
    }
}

/* Per-token position cache — our own source of truth for "where was the
 * token before this drag". Necessary because in Foundry V13 both `doc.x/y`
 * and `doc._source.x/y` are already the NEW value by the time our
 * preUpdate hook runs (the canvas drag path mutates the source eagerly,
 * before the hook chain dispatches). Without this cache, `from === to`
 * every drag and the budget always reads 0m moved.
 *
 * Keyed by TokenDocument so each unlinked token has independent tracking;
 * GC'd naturally when the document is destroyed. */
const _lastKnownPos = new WeakMap();

function rememberPos(tokenDoc) {
    if (!tokenDoc) return;
    _lastKnownPos.set(tokenDoc, { x: tokenDoc.x, y: tokenDoc.y });
}
function getRememberedPos(tokenDoc) { return _lastKnownPos.get(tokenDoc); }

/* Stash a snapshot of the cached prev-pos onto the options bag so the
 * update handler can read it without a second WeakMap lookup. Falls back
 * to nothing if we haven't seen this token before — first-drag-after-
 * canvas-load case, where seedRememberedPositions normally beats us. */
function stashPrevPos(tokenDoc, changes, options /*, userId */) {
    if (!isMoveChange(changes)) return;
    const prev = getRememberedPos(tokenDoc);
    if (prev) options.wdmPrevPos = { x: prev.x, y: prev.y };
}

/* Seed the cache for every token on the active scene. Runs on canvasReady
 * and on drawToken so freshly-created tokens or scene switches start with
 * a valid baseline. */
function seedRememberedPositions() {
    for (const t of canvas.tokens?.placeables ?? []) rememberPos(t.document);
}

export function registerCanvasMovement() {
    /* Two preUpdate handlers: the first stashes the prev position so the
     * post-update writer can measure delta; the second applies the lock
     * checks and may cancel. Stash MUST run regardless of cancellation so
     * an interrupted move still records correctly on a later retry. */
    Hooks.on("preUpdateToken", stashPrevPos);
    Hooks.on("preUpdateToken", onPreUpdateToken);
    Hooks.on("updateToken",    onUpdateToken);

    /* Position-cache seeding for the cases the main updateToken handler
     * doesn't cover (and to provide initial values):
     *   - canvasReady: every token already on the scene
     *   - drawToken:   freshly spawned tokens
     *
     * The MAIN updateToken handler (onUpdateToken above) is now the sole
     * cache writer for movement-event updates. The earlier "secondary
     * unconditional rememberPos" hook was racing with the main handler's
     * async recordMovement — it would cache the over-cap NEW position
     * BEFORE the rollback fired, then on the next drag the user got an
     * error mentioning the PRIOR drag's distance (because the cached
     * "prev" was actually mid-drag, not where the token came to rest). */
    Hooks.on("canvasReady", seedRememberedPositions);
    Hooks.on("drawToken", (token) => rememberPos(token?.document));

    /* Single startup confirmation so the console shows the module loaded.
     * No per-event spam: those caused the bootup hitch you reported. */
    console.log(`${SYSTEM_ID} | canvas-movement registered`);
}
