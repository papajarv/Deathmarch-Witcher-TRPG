/**
 * Auto-face on target.
 *
 * When the user targets another token, automatically rotate the user's
 * controlled token(s) to face that target. The rotation is FREE (does
 * not consume movement budget) — facing your target is a free positional
 * adjustment (RAW pragmatic ruling; the user explicitly asked for this).
 *
 * Bypasses canvas-rotation.mjs's movement charge via the `wdmFreeFacing`
 * update option.
 *
 * Convention: Foundry maps token.document.rotation straight to PIXI's
 * `mesh.angle` (see Token#_refreshRotation). PIXI rotation is degrees
 * clockwise from "no rotation". Which compass direction "no rotation"
 * corresponds to depends on how the token asset itself was drawn — and
 * different art packs disagree:
 *
 *   asset-natural facing → required offset (`facingOffsetDeg`)
 *   NORTH (head-up portrait)         +90
 *   EAST  (sideways, facing right)     0
 *   SOUTH (looking at the viewer)    -90
 *   WEST  (sideways, facing left)   +180
 *
 * The system setting `tokenFacingOffsetDeg` lets the table pick what
 * matches their token art. Default -90 (asset faces south at rotation 0
 * = looking at viewer — the convention the Witcher portrait packs and
 * most VTT-marketplace tokens use).
 *
 * PIXI's atan2(dy, dx) returns angle from east (positive y is south).
 *   foundryDeg = (atan2Deg + offset + 360) % 360
 *
 * Rotation updates are committed with `animate: false` — auto-face is
 * a UI affordance, not a tactical reveal: animating each chained
 * rotation looked like the token was spinning / oscillating when the
 * player swept the mouse around. */

const SYSTEM_ID = "witcher-ttrpg-death-march";

function facingOffsetDeg() {
    try { return Number(game.settings?.get?.(SYSTEM_ID, "tokenFacingOffsetDeg")) || 0; }
    catch (_) { return 0; }
}

/** Compute the Foundry rotation needed for `from` to face `to`.
 *
 *  IMPORTANT (Foundry v14): inside the `updateToken` hook, the document
 *  hasn't yet swapped in the new field values — `tokenDoc.x/y` still
 *  return the PRE-update coords; the new ones live in the `changes`
 *  payload. Callers operating during that window pass the relevant
 *  positions explicitly via `fromXY` / `toXY` overrides so this helper
 *  computes facing from the POST-update geometry.
 *
 *  When no override is supplied the helper falls back to whatever the
 *  document currently exposes (correct during steady-state targeting). */
function tokDoc(t) { return t?.document ?? t; }
function foundryFacingDeg(fromTok, toTok, { fromXY = null, toXY = null } = {}) {
    const fd = tokDoc(fromTok);
    const td = tokDoc(toTok);
    const gridSize = Number(canvas?.scene?.grid?.size) || 100;
    const fx = fromXY ? Number(fromXY[0]) : Number(fd?.x);
    const fy = fromXY ? Number(fromXY[1]) : Number(fd?.y);
    const tx = toXY   ? Number(toXY[0])   : Number(td?.x);
    const ty = toXY   ? Number(toXY[1])   : Number(td?.y);
    const fromCx = (fx || 0) + (Number(fd?.width)  || 1) * gridSize / 2;
    const fromCy = (fy || 0) + (Number(fd?.height) || 1) * gridSize / 2;
    const toCx   = (tx || 0) + (Number(td?.width)  || 1) * gridSize / 2;
    const toCy   = (ty || 0) + (Number(td?.height) || 1) * gridSize / 2;
    const atan2Deg = Math.atan2(toCy - fromCy, toCx - fromCx) * 180 / Math.PI;
    return Math.round((atan2Deg + facingOffsetDeg() + 360) % 360);
}

/** Re-orient `controlled` (Token) to face `target` (Token) if not already
 *  facing it. Convenience wrapper around the doc-based path. */
function refaceToward(controlled, target) {
    return refaceTowardDoc(tokDoc(controlled), tokDoc(target));
}

/** Doc-based reface — used by the updateToken path where the freshly-
 *  updated TokenDocument is the source-of-truth (the live Token's
 *  .document reference can briefly be stale). */
/** Doc-based reface. `opts.fromXY` / `opts.toXY` override the position
 *  values read from the docs (used during `updateToken` where the doc
 *  hasn't swapped in the new coords yet — see foundryFacingDeg notes). */
function refaceTowardDoc(controlledDoc, targetDoc, opts = {}) {
    if (!controlledDoc || !targetDoc || controlledDoc === targetDoc) return;
    const curRot   = Number(controlledDoc.rotation) || 0;
    const wantRot  = foundryFacingDeg(controlledDoc, targetDoc, opts);
    const delta    = Math.abs(((wantRot - curRot + 540) % 360) - 180);
    if (delta <= 1) return;
    try {
        controlledDoc.update(
            { rotation: wantRot },
            { wdmFreeFacing: true }
        );
    } catch (err) {
        console.warn(`${SYSTEM_ID} | reface failed`, err);
    }
}

/** Return the first targeted Token (PIXI placeable) for the current user,
 *  or null if no token target. */
function currentTargetToken() {
    return [...(game.user?.targets ?? [])][0] ?? null;
}

/* Cached state — survives the brief window during token-move updates
 * where Foundry recreates Token PIXI placeables and `canvas.tokens
 * .controlled` / `game.user.targets` both transiently empty out. The
 * caches are kept in sync via the targetToken / controlToken hooks, so
 * the updateToken handler can lean on them when the live state is gone. */
let _lastTargetId = null;
let _lastControlledIds = new Set();

function onTargetToken(user, token, targeted) {
    if (user !== game.user) return;
    if (targeted) {
        _lastTargetId = token?.id ?? null;
        const controlled = canvas?.tokens?.controlled ?? [];
        for (const ctrl of controlled) refaceToward(ctrl, token);
        /* And a delayed pass — any module that fires its own rotation
         * write in response to targetToken (e.g. dynamic-ring frame
         * orientation) will be overwritten by the time this resolves. */
        scheduleDelayedReface();
    } else if (_lastTargetId === token?.id) {
        _lastTargetId = null;
    }
}

function onControlToken(token, controlled) {
    if (!token?.id) return;
    if (controlled) _lastControlledIds.add(token.id);
    else            _lastControlledIds.delete(token.id);
}

/** Brute-force re-reface: for every currently-controlled-by-me token,
 *  reface it toward the cached target. Reads live state — robust to
 *  cache drift, transient PIXI recreation, and external rotation
 *  overwrites. Called both immediately and on a short timer. */
function refaceAllControlledTowardTarget() {
    const targetId = _lastTargetId
                  ?? [...(game.user?.targets ?? [])][0]?.id
                  ?? null;
    if (!targetId) return;
    const targetDoc = canvas?.scene?.tokens?.get?.(targetId);
    if (!targetDoc) return;
    /* Source the controlled set from the live canvas. Fall back to the
     * cached id set if the canvas list is empty (the recreation window). */
    const liveControlled = canvas?.tokens?.controlled ?? [];
    const docs = liveControlled.length
        ? liveControlled.map(t => t.document).filter(Boolean)
        : [..._lastControlledIds]
            .map(id => canvas?.scene?.tokens?.get?.(id))
            .filter(Boolean);
    for (const ctrlDoc of docs) {
        if (!ctrlDoc || ctrlDoc.id === targetId) continue;
        refaceTowardDoc(ctrlDoc, targetDoc);
    }
}

/* Delayed-reface scheduler. Foundry's path-movement animation, dynamic
 * ring rotation hooks, and some popular modules ("Token Drag Rotate",
 * "Token Auto Facing", etc.) write rotation AFTER our updateToken
 * handler returns — that overwrite is what the user was seeing as
 * "stays facing the direction it moved to". A short timer after the
 * move re-applies the target-facing rotation, winning the race. */
let _delayedRefaceTimer = null;
function scheduleDelayedReface(delayMs = 350) {
    if (_delayedRefaceTimer) clearTimeout(_delayedRefaceTimer);
    _delayedRefaceTimer = setTimeout(() => {
        _delayedRefaceTimer = null;
        try { refaceAllControlledTowardTarget(); }
        catch (err) { console.warn(`${SYSTEM_ID} | delayed reface failed`, err); }
    }, delayMs);
}

/** Persistent facing: whenever ANY token moves (x or y change), keep
 *  the user's controlled tokens facing whichever token they're targeting.
 *
 *  Two cases fire:
 *    1. My controlled token moved → reface IT toward the target.
 *    2. My target moved           → reface every controlled token toward it.
 *
 *  Rotation-only updates are ignored — the rotation we WRITE here would
 *  otherwise feed back into this hook and loop.
 *
 *  After both immediate cases we also schedule a delayed re-reface to
 *  win against any other code that writes rotation in response to a
 *  move (Foundry's path-movement rotation, dynamic-ring orientation
 *  hooks, drag-rotate modules — all observed to clobber our update). */
/** preUpdateToken: inject target-facing rotation into the SAME update
 *  batch that carries the x/y move.
 *
 *  WHY this exists in addition to onUpdateToken:
 *
 *  Foundry v14 builds a movement animation in `Token._prepareAnimation`,
 *  which calls `Token.#handleRotationChanges(from, changes)`. The animation
 *  tween then interpolates rotation from `from.rotation` (the PRE-update
 *  value) to whatever ends up in `changes.rotation`. If we issue our
 *  target-facing rotation as a SEPARATE update right after, our value
 *  briefly flashes — then the in-flight animation completes and snaps the
 *  PIXI rotation BACK to `from.rotation`. That is exactly the bug the user
 *  described: "I see it face the target, then it snaps back."
 *
 *  Folding rotation into the same `changes` payload makes the animation
 *  tween FROM old rotation TO our target-facing one, so the final state
 *  matches and no snap-back happens.
 *
 *  Only fires when:
 *    - The update is a position move (x or y in changes)
 *    - The mover is us OR an owned token (otherwise leave alone)
 *    - We have an active target
 *    - The destination's facing differs from current
 *
 *  Skipped for our own free-facing updates (we don't want to overwrite our
 *  own writes), and for rotation-only updates (the motion-rotation path
 *  doesn't apply there). */
function onPreUpdateToken(tokenDoc, changes, options, _userId) {
    if (options?.wdmFreeFacing) return;
    if (!("x" in changes) && !("y" in changes)) return;
    const targetId = _lastTargetId
                  ?? [...(game.user?.targets ?? [])][0]?.id
                  ?? null;
    if (!targetId) return;
    const targetDoc = canvas?.scene?.tokens?.get?.(targetId);
    if (!targetDoc) return;
    if (tokenDoc.id === targetId) return;
    const movedTokObj = tokenDoc.object;
    const isMine = !!movedTokObj?.isOwner || _lastControlledIds.has(tokenDoc.id);
    if (!isMine) return;
    /* Compute facing FROM the destination position to the target's
     * current position. */
    const movedXY = [
        ("x" in changes ? Number(changes.x) : Number(tokenDoc.x)),
        ("y" in changes ? Number(changes.y) : Number(tokenDoc.y))
    ];
    const wantRot = foundryFacingDeg(tokenDoc, targetDoc, { fromXY: movedXY });
    /* OVERWRITE rotation unconditionally when target-locked. Foundry's
     * TokenDocument#move() pipeline runs its own auto-rotate-in-motion-
     * direction step BEFORE this hook fires (see the v14 source for
     * `#rotateInMovementDirection`, called from `_preUpdateMovement`
     * when `move.autoRotate` is true — which is the default for any
     * token without explicit `lockRotation`). That injects
     * `changes.rotation = motion_angle + offset` and was the actual
     * cause of "after I move, foundry changes it to face the direction
     * you moved towards". Bailing on `if ("rotation" in changes)` let
     * that motion-direction rotation through; overwriting with our
     * target-facing rotation reclaims the field. */
    const curRot = Number(tokenDoc.rotation) || 0;
    const delta  = Math.abs(((wantRot - curRot + 540) % 360) - 180);
    if (delta <= 1 && !("rotation" in changes)) return;   // already facing right way
    changes.rotation = wantRot;
    /* Tag the options so onUpdateToken's "external rotation" detector
     * doesn't treat THIS rotation change as a foreign overwrite. */
    if (options && typeof options === "object") options.wdmFreeFacing = true;
}

function onUpdateToken(tokenDoc, changes, options, _userId) {
    /* External rotation write detection. If rotation changed and it was
     * NOT our own free-facing update, something else (Foundry path
     * movement, dynamic-ring orientation hook, a community "drag-to-
     * rotate" module) is rotating the token. Schedule a delayed re-
     * reface so we WIN the race and the target lock holds. We don't
     * fire immediately because that would deadlock against the
     * external write (they're already overwriting; another immediate
     * write would just be overwritten again). The delay lets the
     * other code finish, then we snap back to target-facing. */
    if ("rotation" in changes && !options?.wdmFreeFacing) {
        scheduleDelayedReface();
    }

    if (!("x" in changes) && !("y" in changes)) return;
    const movedTokenId = tokenDoc.id;
    const targetId = _lastTargetId
                  ?? [...(game.user?.targets ?? [])][0]?.id
                  ?? null;
    if (!targetId) return;
    const targetDoc = canvas?.scene?.tokens?.get?.(targetId);
    if (!targetDoc) return;

    /* The moved doc still exposes the PRE-update x/y inside this hook in
     * Foundry v14 — merge `changes` to get the freshly-applied position. */
    const movedXY = [
        ("x" in changes ? Number(changes.x) : Number(tokenDoc.x)),
        ("y" in changes ? Number(changes.y) : Number(tokenDoc.y))
    ];

    /* Case 1: my controlled / owned token moved → reface IT.
     * Check ownership directly (not just the controlled cache) so a
     * drag-then-immediate-deselect, or a move issued via the GM's
     * "Show Token" / token HUD path, still triggers reface. We accept
     * moves from any user — the GM may move a player's token; if the
     * resulting token is one of MY currently-controlled, I still want
     * the target lock. */
    const movedTokObj = tokenDoc.object;
    const movedIsMine = !!movedTokObj?.isOwner || _lastControlledIds.has(movedTokenId);
    if (movedIsMine) {
        if (movedTokenId !== targetId) refaceTowardDoc(tokenDoc, targetDoc, { fromXY: movedXY });
        scheduleDelayedReface();
        return;
    }
    /* Case 2: my target moved → reface every controlled token toward
     * the target's new position. */
    if (movedTokenId === targetId) {
        const liveControlled = canvas?.tokens?.controlled ?? [];
        const ctrlDocs = liveControlled.length
            ? liveControlled.map(t => t.document).filter(Boolean)
            : [..._lastControlledIds]
                .map(id => canvas?.scene?.tokens?.get?.(id))
                .filter(Boolean);
        for (const ctrlDoc of ctrlDocs) {
            if (!ctrlDoc || ctrlDoc.id === targetId) continue;
            refaceTowardDoc(ctrlDoc, tokenDoc, { toXY: movedXY });
        }
        scheduleDelayedReface();
    }
}

export function registerCanvasAutoFace() {
    Hooks.on("targetToken",     onTargetToken);
    Hooks.on("controlToken",    onControlToken);
    Hooks.on("preUpdateToken",  onPreUpdateToken);
    Hooks.on("updateToken",     onUpdateToken);

    /* One-shot migration: prior versions of this system shipped with
     * default facing offsets of 0 then +90 before settling on -90 (the
     * convention the Witcher portrait packs use). Worlds that upgraded
     * still have the stale cached value. On first `ready` after this
     * version installs, bump to -90 ONCE — then set a flag so the
     * migration never re-runs, preserving any later GM choice. */
    Hooks.once("ready", async () => {
        if (!game.user?.isGM) return;
        try {
            const migrated = game.settings.get(SYSTEM_ID, "tokenFacingOffsetMigratedV1");
            if (migrated) return;
            const cur = Number(game.settings.get(SYSTEM_ID, "tokenFacingOffsetDeg"));
            if (cur !== -90) {
                await game.settings.set(SYSTEM_ID, "tokenFacingOffsetDeg", -90);
                ui.notifications?.info?.(
                    `Witcher (Death March): token facing offset migrated to -90° ` +
                    `(asset faces SOUTH at rotation 0 — the Witcher portrait pack convention). ` +
                    `Change in Game Settings → System Settings if your token art differs.`,
                    { permanent: false }
                );
            }
            await game.settings.set(SYSTEM_ID, "tokenFacingOffsetMigratedV1", true);
        } catch (err) {
            console.warn(`${SYSTEM_ID} | facing-offset migration failed`, err);
        }
    });
}
