/**
 * GM FOV Token Hide — standalone GM view toggle.
 *
 * Self-contained: NOT tied to immersive camera mode, combat, or any other
 * feature. Foundry core hides tokens that fall outside a controlled vision
 * token's field of view (core `Token#isVisible` →
 * `canvas.visibility.testVisibility`) whenever token vision is on and the
 * GM has a single token selected. This module lets the GM switch that FOV
 * culling OFF for their own client, so they see every token regardless of
 * the selected token's field of view.
 *
 *   FOV Token Hide: On  (default) → native Foundry FOV culling stands.
 *   FOV Token Hide: Off           → GM sees all non-hidden tokens.
 *
 * Client scope — only changes THIS GM's view, never world state or a
 * player's view. Surfaced as a GM-only button in the combat-tracker
 * header; the Combat sidebar tab is always present, so the toggle is
 * reachable whether or not an encounter is running.
 */

import { ensureGmToggleBar, styleGmToggleButton, paintGmToggleState } from "./gm-tracker-toggles.mjs";

const SYSTEM_ID    = "witcher-ttrpg-death-march";
const FOV_HIDE_KEY = "fovTokenHide";

/** FOV Token Hide toggle (client scope). Default TRUE = keep Foundry's
 *  native FOV culling. FALSE = GM sees all tokens regardless of FOV. */
export function isFovTokenHideEnabled() {
    try { return game.settings.get(SYSTEM_ID, FOV_HIDE_KEY) !== false; }
    catch (_) { return true; }   // default: hide (native Foundry behavior)
}

/** True only on a GM client that has turned FOV Token Hide OFF — i.e. the
 *  GM has asked to see through the selected token's field of view. */
function shouldGmSeeAllTokens() {
    return !!game.user?.isGM && !isFovTokenHideEnabled();
}

/* Wrap core `Token#isVisible` so that, for a GM who has turned FOV Token
 * Hide OFF, every non-hidden token reports visible regardless of any
 * controlled token's vision polygon. Foundry's own getter restricts
 * uncontrolled tokens to `canvas.visibility.testVisibility(...)` once a
 * vision token is controlled — that's the core FOV culling this toggle
 * switches off.
 *
 *   - Only overrides when `shouldGmSeeAllTokens()` (GM + toggle off). In
 *     every other state it defers to the base getter, so players and the
 *     default (hide-on) case behave exactly as stock Foundry.
 *   - Skips `document.hidden` tokens so the GM-set "hide from players"
 *     flag still governs those (the base getter shows them to the GM at
 *     reduced alpha; we don't want to override that path).
 *   - SECRET-disposition and stealth hides live in separate refreshToken
 *     hooks that write `token.visible = false` AFTER visibility is
 *     computed, so those still win — this toggle is strictly about FOV. */
function patchTokenVisibility() {
    const TokenCls = CONFIG?.Token?.objectClass;
    if (!TokenCls || TokenCls.prototype.__wdmFovVisibilityPatched) return;
    const desc = Object.getOwnPropertyDescriptor(TokenCls.prototype, "isVisible");
    if (!desc?.get) return;
    const baseGet = desc.get;
    Object.defineProperty(TokenCls.prototype, "isVisible", {
        configurable: true,
        get() {
            if (!this.document?.hidden && shouldGmSeeAllTokens()) return true;
            return baseGet.call(this);
        }
    });
    TokenCls.prototype.__wdmFovVisibilityPatched = true;
}

/** Re-evaluate token visibility after the toggle flips. `isVisible` is
 *  only read during a visibility refresh, so poke the perception layer to
 *  recompute it for every token now. */
export function refreshFovTokenHide() {
    try { patchTokenVisibility(); } catch (_) { /* class not ready */ }
    try {
        /* Only VISIBILITY needs recomputing — the toggle changes the
         * "GM sees all tokens" override read by the visibility getter, not any
         * token's vision cone or the wall LOS. Dropping `refreshVision` (the
         * expensive vision-polygon rebuild for every sighted token) is why
         * turning FOV-hide OFF used to stall for a beat before tokens popped
         * back in; `refreshVisibility` alone re-tests each token cheaply. */
        canvas?.perception?.update?.({ refreshVisibility: true });
    } catch (_) { /* no canvas yet */ }
}

/** GM-only "FOV Hide" button in the shared tracker toggle bar. Toggles the
 *  client setting; its onChange recomputes visibility. */
function renderFovTokenHideToggle(_app, html) {
    if (!game.user?.isGM) return;
    const bar = ensureGmToggleBar(html);
    if (!bar) return;
    /* Idempotent — remove any previous button before injecting. */
    bar.querySelectorAll(".wdm-fov-hide-toggle").forEach(n => n.remove());

    const btn = document.createElement("button");
    btn.type = "button";
    btn.classList.add("wdm-fov-hide-toggle");
    styleGmToggleButton(btn);
    const paint = () => {
        const hide = isFovTokenHideEnabled();
        /* Icon + state text: eye-slash while native FOV culling hides tokens,
         * eye when the GM has switched it off to see everything. Amber-lit when
         * the override is engaged (Hide OFF → seeing all). */
        btn.innerHTML = `<i class="fa-solid ${hide ? "fa-eye-slash" : "fa-eye"}"></i><span>FOV Hide: ${hide ? "On" : "Off"}</span>`;
        paintGmToggleState(btn, !hide);
        btn.title = "OFF = see all tokens regardless of the selected token's field of view";
    };
    btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        /* onChange → refreshFovTokenHide recomputes visibility; just repaint. */
        try { await game.settings.set(SYSTEM_ID, FOV_HIDE_KEY, !isFovTokenHideEnabled()); }
        catch (_) {}
        paint();
    });
    paint();
    bar.appendChild(btn);
}

export function registerGmFovTokenHide() {
    /* Patch the core getter up front — idempotent and inert unless the GM
     * turns the toggle off. Also re-ensured by refreshFovTokenHide. */
    try { patchTokenVisibility(); } catch (_) { /* class not ready */ }
    Hooks.on("renderCombatTracker", renderFovTokenHideToggle);
}
