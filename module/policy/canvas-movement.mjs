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
import { gmOffTurnMoveActive } from "./gm-offturn-move.mjs";
import { cannotMove } from "../mechanics/statusEngine.mjs";
import { isClinched, breakActorClinches } from "../mechanics/clinch.mjs";

import { t, tFormat } from "../chrome/lib/i18n.js";
import { weatherAdjustedMoveCap } from "../mechanics/weather-modifiers.mjs";
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
    /* Forced movement (Push Kick knockback, future Aard shockwave,
     * charge slam, etc.) — the target didn't choose to move, an
     * external force did. Skip the not-your-turn / stunned / budget-
     * used gates so the push actually lands. mechanics/pushToken.mjs
     * sets this flag when it issues the tokenDocument update. */
    if (options?.wdmForcedMove) return;
    if (!isMoveChange(changes)) return;
    const actor = tokenActor(tokenDoc);
    if (!actor) return;

    /* CLINCH — the FIRST movement by anyone in a clinch (holder OR target)
     * breaks every clinch they're in. The move then proceeds NORMALLY to its
     * chosen destination (the selected overlay tile / dragged / WASD cell) —
     * we do NOT truncate it: rewriting changes.x/y here fights the overlay's
     * `move(waypoints)` path and left the token stuck in place. The clincher
     * was sitting on the grid line; moving to a real grid cell re-centres them
     * naturally, and the clinchee (who didn't move) has their holder recentred
     * by the clear path. Runs BEFORE the in-combat gate so it also works out
     * of combat (WASD / drag). Skipped for our own bypass moves so clinch
     * positioning / knockback / reposition / snap-back don't self-break. */
    if (!options?.wdmClinchMove && !options?.wdmClinchBreak
        && !options?.wdmForcedMove && !options?.wdmFreeReposition && !options?.wdmRollback) {
        try {
            if (isClinched(actor)) {
                options.wdmClinchBreak = true;
                breakActorClinches(actor, "movement");   // async GM/socket, fire-and-forget
                // Fall through: the move runs the budget gates below normally.
            }
        } catch (_) { /* never let clinch handling block a move */ }
    }

    if (typeof actor.recordMovement !== "function") return; // not a witcher actor

    /* MOVE-LOCK (grappled / pinned / etc.) is enforced in the `preMoveToken`
     * hook (onPreMoveTokenLock below), NOT here: in Foundry v14 all token
     * movement — drag, native/immersive WASD, tactical overlay, ruler, macro —
     * routes through the movement pipeline and is cancellable ONLY by returning
     * false from `preMoveToken`. Returning false from `preUpdateToken` fires
     * but does NOT cancel a v14 move(), which is why the lock leaked here. */

    if (!actor._inActiveCombat) return;                     // free out of combat

    /* GM Free-Actions override: skip every canvas-side movement gate
     * (turn, budget, action-lock, pinned/grappled, cap, Run prompt).
     * The dock-side action mixins already respect the flag (see
     * combatRoundMixin recordMovement/recordRun); mirroring it here
     * means dragging the token also goes through without any pre-
     * check bouncing the move. Post-update writer is still skipped
     * because recordMovement will early-return true under the same
     * flag, so no budget bookkeeping happens either — matches the
     * "no slot, no state change" invariant of Free Actions. */
    if (actor._freeActionsMode) return;

    /* GM Off-Turn Move override: when the GM has the combat-tracker toggle on,
     * an off-turn combatant's token may be dragged freely — skip ALL budget
     * gates (like Free-Actions) so the reposition lands, and record no budget
     * (recordMovement early-returns true under the same check). Only bypasses
     * when it genuinely ISN'T the actor's turn; on-turn moves gate normally. */
    if (!actor._isMyTurn && gmOffTurnMoveActive()) return;

    /* Hard-stop conditions, mirroring the same checks recordMovement uses
     * but applied BEFORE the canvas update so the token doesn't visually
     * commit a move that the budget would refuse. */
    if (!actor._isMyTurn) {
        ui.notifications?.warn(t("WITCHER.Policy.CanvasMovement.Notify.NotYourTurn", "Not your turn — can't move this token."));
        return false;
    }
    if (actor._actionLocked || actor._recoveryLocked) {
        ui.notifications?.warn(actor._actionLockMsg ?? "Can't move right now.");
        return false;
    }
    /* Full-round action lock — but Run IS a full-round action whose entire
     * point is to move, so it must be allowed through. */
    if (actor._locked && !actor._round?.runUsed) {
        ui.notifications?.warn(t("WITCHER.Policy.CanvasMovement.Notify.TurnIsCommittedToAFull", "Turn is committed to a full-round action."));
        return false;
    }
    /* Movement already spent this turn (clinch consumed full move, or
     * a prior full-SPD walk in RAW mode). Refuse further token drags —
     * otherwise the post-write below would overwrite movementMeters
     * with the path-only measurement of THIS drag and downgrade
     * movementUsed to false, giving the player a free "1 tile refresh"
     * of their budget.
     *
     * EXCEPTION: if the actor could still upgrade to Run (has both
     * action + extra available, isn't already running, isn't action-
     * locked), let the drag through. The downstream cap check will
     * detect the over-normal-cap projection and fire promptRunUpgrade,
     * which is what the player is trying to reach — refusing here
     * would just be misleading ("used all movement" when Run is
     * still available). recordRun then clears movementUsed so the
     * tripled cap is spendable. */
    if (actor._round?.movementUsed) {
        const runAvailable =
               !actor._round?.runUsed
            && !actor._round?.actionUsed
            && !actor._round?.extraUsed
            && !actor._locked
            && !actor._actionLocked;
        if (!runAvailable) {
            ui.notifications?.warn(t("WITCHER.Policy.CanvasMovement.Notify.UsedAllMovement", "You've used all your movement this turn."));
            return false;
        }
    }
    /* (Move-lock for grappled/pinned is enforced above, before the in-combat
     * gate, so it applies out of combat too.) */
    /* Clinched actors can still walk — the first meter of movement
     * breaks the clinch (movement-hook cascade), and the remainder
     * costs the rest of their SPD normally. Break clinch as an
     * explicit dialog option is the low-cost "step out and stop"
     * shortcut (1 metre). */

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
        /* Witchers Reborn — Viper · Lightning Fast bonus: the actor rolled
         * Nd6 (N adrenaline dice) when they invoked the heroic action; the
         * total was stamped on flags.wr.lightningFastBonus by
         * wrHeroic.lightningFast. Cleared on turn end by
         * combatRoundMixin.resetCombatRound. Added AFTER the run multiplier
         * so it stacks additively (the rolled meters, not tripled on a
         * Run). */
        const wrBonus = Number(actor.getFlag?.("witcher-ttrpg-death-march", "wr.lightningFastBonus")) || 0;
        const cap = weatherAdjustedMoveCap(spd, actor._round?.runUsed ? 3 : 1, wrBonus, actor);
        if (cap && projectedMeters > cap) {
            const runCap = weatherAdjustedMoveCap(spd, 3, 0, actor);
            const segMeters = Math.round(segment / unitsPerSpd);
            const currentMeters = Math.round(currentTotal / unitsPerSpd);

            /* Already Running and STILL over → no upgrade path, refuse. */
            if (actor._round?.runUsed) {
                ui.notifications?.warn(tFormat("WITCHER.Policy.CanvasMovement.Notify.WouldExceedRun", { segMeters, runCap, currentMeters }, `Can't move ${segMeters}m — would exceed Run cap of ${runCap}m (currently ${currentMeters}m).`));
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
            ui.notifications?.warn(tFormat("WITCHER.Policy.CanvasMovement.Notify.ExceedsFullRun", { segMeters, runCap }, `Can't move ${segMeters}m — exceeds Run cap of ${runCap}m even with full-round Run.`));
            return false;
        }
    }
}

/* The dialog part of the Run-upgrade prompt — resolves boolean. Split
 * out so tactical-grid.mjs can reuse the EXACT same dialog for its
 * run-tier commits (users expect one visual language for "spend the
 * turn on a Run"; two dialogs in the same session would feel like
 * two different features). Kept as a module-scoped helper here rather
 * than exported because the tactical grid also imports it below. */
async function confirmRunUpgradeDialog(projectedMeters, runCap) {
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2) return false;
    try {
        /* DialogV2.confirm in Foundry v14 doesn't accept `yes`/`no`
         * option objects — the button config lives inside the `buttons`
         * array or defaults to plain Yes/No. Passing yes/no options
         * silently broke the OK click here (labels never applied and
         * the callback wiring got confused). Reverting to the default
         * confirm shape used elsewhere in the codebase (character.mjs,
         * enhancementSlots.mjs). Buttons read as "Yes"/"No" now — the
         * question copy makes the intent clear enough. */
        return await DialogV2.confirm({
            window: { title: t("WITCHER.Policy.CanvasMovement.Dialog.Title.Run", "Run?"), icon: "fa-solid fa-person-running" },
            content: tFormat(
                "WITCHER.Policy.CanvasMovement.Dialog.RunConfirm",
                { projected: projectedMeters, cap: runCap },
                "<div style=\"padding:8px 2px;\"><p>That move would put you at <strong>{projected}m</strong>, past your normal cap.</p><p>Spend your full turn on a <strong>Run</strong> (SPD × 3 = <strong>{cap}m</strong>) to keep moving?</p><p style=\"opacity:0.7;font-size:0.6875rem;margin-bottom:0;\">Run locks your normal and extra action this turn.</p></div>"
            ),
            rejectClose: false
        });
    } catch (_) { return false; }
}

/* Public re-export so other policies (tactical-grid) can present the
 * same dialog before committing a run-tier movement, avoiding two
 * different-looking "Run?" prompts in the same session. */
export { confirmRunUpgradeDialog };

/* Open the Run-upgrade prompt and (on accept) commit the Run action and
 * re-trigger the cancelled drag. Run is the full-round action of moving
 * SPD × 3 metres — it locks normal/extra action slots for the rest of
 * the turn. */
async function promptRunUpgrade(actor, tokenDoc, destination, projectedMeters, runCap) {
    const confirmed = await confirmRunUpgradeDialog(projectedMeters, runCap);
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
    /* Forced movement (push, knockback) — an external force moved the
     * target, so it doesn't come out of their SPD budget. Update the
     * baseline cache so the target's NEXT voluntary move measures from
     * where they actually stand now. */
    if (options?.wdmForcedMove) { rememberPos(tokenDoc); return; }
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
    /* GM Free-Actions override: don't write the budget on the way out
     * either. Matches the preUpdate bypass. Without this, the actor
     * would still accumulate movementMeters as the token drags, because
     * Math.max(newTotal, priorMeters) below never lets the recorded
     * value decrease. Cache the position so any future non-free drag
     * has a proper baseline. */
    if (actor._freeActionsMode) {
        rememberPos(tokenDoc);
        return;
    }
    /* GM Off-Turn Move override: a GM repositioning an off-turn combatant
     * doesn't spend that actor's movement budget. Just re-baseline and bail,
     * mirroring the preUpdate bypass and Free-Actions above. */
    if (!actor._isMyTurn && gmOffTurnMoveActive()) {
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
    /* Viper heroic — Lightning Fast: rolled Nd6 bonus meters ride on top
     * of the SPD/Run cap. Must be folded in on the post-write cap too;
     * otherwise a drag the pre-update accepted (with the bonus) is
     * refused here as "over cap" and gets rolled back — the display
     * inflates but the actual budget doesn't. */
    const wrBonus = Number(actor.getFlag?.(SYSTEM_ID, "wr.lightningFastBonus")) || 0;
    const cap = weatherAdjustedMoveCap(spd, actor._round?.runUsed ? 3 : 1, wrBonus, actor);
    console.log(`${SYSTEM_ID} | canvas-move ${actor.name}: path ${pathMeters}m + rotation ${rotationMeters}m = ${newTotalMeters}m (cap ${cap}m${wrBonus ? `; +${wrBonus} LF` : ""})`);

    /* Over cap — snap back. This is the safety net for cases the preUpdate
     * pre-check missed (e.g. Foundry's history measurement disagreeing
     * with the segment estimate). */
    let ok = true;
    if (cap && newTotalMeters > cap) {
        ok = false;
        ui.notifications?.warn(tFormat("WITCHER.Policy.CanvasMovement.Notify.MovementWouldTotalXmExceedsCap", { newTotalMeters: newTotalMeters, cap: cap }, "Movement would total {newTotalMeters}m — exceeds cap of {cap}m."));
    } else {
        try {
            /* Belt-and-suspenders vs. the "1 tile drag resets budget"
             * bug: never DOWNGRADE `movementUsed` here. Clinch and
             * break-clinch commit the whole movement action via
             * recordMovement — a small path-only drag afterwards
             * should not flip movementUsed back to false or shrink
             * the recorded meters. Max the meters, OR the used flag. */
            const priorMeters = Number(actor._round?.movementMeters) || 0;
            const priorUsed   = !!actor._round?.movementUsed;
            const nextMeters  = Math.max(newTotalMeters, priorMeters);
            const nextUsed    = priorUsed || (cap > 0 && nextMeters >= cap);
            await actor.update({
                "system.combatRound.movementMeters": nextMeters,
                "system.combatRound.movementUsed":   nextUsed
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

/* v14 MOVE-LOCK. In Foundry v14 ALL token movement — drag, native/immersive
 * WASD, the tactical overlay, ruler-drive, macro `.update({x,y})` — routes
 * through the movement pipeline and is cancellable ONLY by returning false
 * from `preMoveToken`; returning false from `preUpdateToken` fires but does NOT
 * cancel a move(). So the grappled/pinned/grappler/pinner/mounted move-lock
 * (any restrict.move status) lives here, refused IN AND OUT OF COMBAT.
 * `operation` carries the update options, so our own bypass moves (clinch
 * positioning, knockback, reposition, self snap-back) pass through untouched.
 * HARD lock — no GM override: the grappler drops it with the free Break pill,
 * the grapplee runs the Escape action. */
function onPreMoveTokenLock(document, _movement, operation) {
    const opts = operation ?? {};
    if (opts.wdmForcedMove || opts.wdmFreeReposition || opts.wdmClinchMove || opts.wdmRollback) return;
    const actor = tokenActor(document);
    if (!actor || typeof actor.recordMovement !== "function") return;
    if (!cannotMove(actor)) return;
    const label = actor.statuses?.has?.("pinned")
        ? t("WITCHER.Policy.CanvasMovement.Text.Pinned", "pinned")
        : t("WITCHER.Policy.CanvasMovement.Text.Grappled", "grappled");
    ui.notifications?.warn(tFormat("WITCHER.Policy.CanvasMovement.Notify.CantMoveWhile", { label }, `Can't move while ${label} — try the Escape action.`));
    return false;   // cancels the v14 movement pipeline
}

export function registerCanvasMovement() {
    /* Move-lock (grappled / pinned / …) — v14 cancels movement here. */
    Hooks.on("preMoveToken", onPreMoveTokenLock);
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

    /* Combat turn transition — every client zeros out its LOCAL copy of
     * `_movementHistory` for the actor whose turn just started. Foundry
     * / our `resetCombatRound` also clears history from the GM side and
     * broadcasts, but there is a lag window before that write reaches
     * other clients. Without this local clear, the next canvas drag on
     * a fresh turn measures its path against the PRIOR turn's waypoint
     * list (30m of Run, etc.) and either over-caps the projected move
     * or writes an inflated total. Local mutation only touches this
     * client's in-memory doc — Foundry's authoritative server write
     * arrives later and is idempotent with this local clear. */
    Hooks.on("combatTurnChange", (combat) => {
        try {
            const upcoming = combat?.combatant;
            const actor = upcoming?.actor;
            if (!actor) return;
            const tokens = (typeof actor.getActiveTokens === "function")
                ? (actor.getActiveTokens(false, true) ?? [])
                : [];
            for (const td of tokens) {
                if (Array.isArray(td?._source?._movementHistory)) {
                    td._source._movementHistory.length = 0;
                }
                if (Array.isArray(td?._movementHistory)) {
                    td._movementHistory.length = 0;
                }
                /* Also refresh the cached prev-pos so the next drag
                 * measures from the token's CURRENT resting position
                 * rather than a stale mid-drag baseline. */
                rememberPos(td);
            }
        } catch (err) {
            console.warn(`${SYSTEM_ID} | combatTurnChange local history clear failed`, err);
        }
    });

    /* Single startup confirmation so the console shows the module loaded.
     * No per-event spam: those caused the bootup hitch you reported. */
    console.log(`${SYSTEM_ID} | canvas-movement registered`);
}
