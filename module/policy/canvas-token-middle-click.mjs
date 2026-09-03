/**
 * Canvas token middle-click → target.
 *
 * Mirrors the middle-click behavior wired on the combat tracker rows
 * (policy/combat-tracker-targets.mjs) for tokens directly on the
 * canvas. Toggles the token in `game.user.targets` with
 * `releaseOthers: false` so successive middle-clicks stack additional
 * targets — same semantics as the T-key override.
 *
 * Targeting is per-user client state (Foundry stores it on `game.user`
 * — the server never sees it as a game action), so this fires
 * regardless of whose turn it is. A player scoping out threats before
 * their own turn is a normal use case.
 *
 * Implementation: a DOM `mousedown` listener on `canvas.app.view` (the
 * canvas <canvas> element). Foundry's own middle-mouse pan is bound
 * separately and doesn't prevent the DOM event from firing. We check
 * `canvas.tokens.hover` — the currently hovered Token placeable — and
 * toggle its target when the middle button (button === 1) is pressed.
 *
 * Why DOM-level instead of PIXI `on("pointerdown")` on each Token:
 * PIXI federated middle-button events on Token placeables were not
 * firing reliably in Foundry v13 (core's own middle-pan appears to
 * intercept the pointer chain before it reaches the placeable's
 * listeners). Listening on the raw canvas <canvas> element is
 * robust and doesn't depend on per-token wiring or the PIXI event
 * routing.
 */

import { isTileTargetingEnabled } from "./weapon-target-overlay.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";

/** DOM event handler on the raw canvas element. Fires for ALL middle-
 *  mouse presses on the canvas; bails when no token is under the cursor
 *  so canvas panning (Foundry's own middle-mouse behavior) still runs
 *  when the user drops the click on empty ground. */
function onCanvasMouseDown(event) {
    if (event.button !== 1) return;
    /* When canvas tile-targeting is on, middle-click token targeting is
     * disabled by design — targeting happens via the weapon → tile flow.
     * The combat-tracker rightbar keeps middle-click target/untarget as the
     * fallback. Returning here also lets Foundry's own middle-mouse pan run
     * normally. */
    if (isTileTargetingEnabled()) return;
    const token = canvas?.tokens?.hover;
    if (!token?.setTarget) return;
    /* Prevent Foundry's middle-mouse canvas pan from also kicking in
     * when the click actually landed on a token — the user's intent
     * was to target, not to grab the map. */
    event.preventDefault();
    event.stopPropagation();
    const wasTargeted = !!game.user?.targets?.has?.(token);
    try {
        token.setTarget(!wasTargeted, {
            user:            game.user,
            releaseOthers:   false,
            groupSelection:  false
        });
    } catch (err) {
        console.warn(`${SYSTEM_ID} | canvas token middle-click target failed`, err);
    }
}

export function registerCanvasTokenMiddleClick() {
    /* Wire on every canvas-ready — the canvas <canvas> element is
     * recreated on scene switches, so listeners bound to a prior view
     * become stale. `canvasReady` fires after the DOM element exists
     * and the tokens layer is populated. Idempotent per view via the
     * `_wdmMiddleClickWired` marker. */
    Hooks.on("canvasReady", () => {
        const view = canvas?.app?.view;
        if (!view || view._wdmMiddleClickWired) return;
        /* `capture: true` fires this listener BEFORE Foundry's own
         * canvas middle-mouse handlers (which run in the bubble phase),
         * giving us the chance to preventDefault the pan when a token
         * is under the cursor. `passive: false` is required because
         * we call preventDefault(). */
        view.addEventListener("mousedown", onCanvasMouseDown, { capture: true, passive: false });
        view._wdmMiddleClickWired = true;
    });
}
