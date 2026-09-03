/**
 * stealth-token-visibility — per-user rendering gate.
 *
 * A stealthed token is HIDDEN from the local user's rendered scene
 * unless one of these is true:
 *   - The local user is the GM.
 *   - The local user owns the stealthed actor (you always see yourself).
 *   - One of the local user's owned actors is in the stealther's
 *     `spottedBy` list (someone on your side has spotted them).
 *
 * Applied every time Foundry redraws / refreshes / updates a token,
 * or when a stealth flag changes. The hide is per-client — the same
 * scene renders normally for spotters and hidden for non-spotters
 * without any shared-state writes.
 *
 * Hides via three parallel handles (belt-and-suspenders because
 * Foundry may reset any one of them on its own refresh pass):
 *   - `token.visible = false`
 *   - `token.mesh.visible = false` (mesh drawn under primary group)
 *   - `token.alpha = 0`
 * On reveal, all three are restored to true / 1.
 *
 * Does NOT touch `token.document.hidden` — that's the GM-set "hide
 * from all players" flag; we shouldn't stomp it. This system is a
 * client-side render gate on top of it.
 */

import { isStealthed, getStealthState } from "../mechanics/stealth.mjs";
import { getStealthConfig } from "../mechanics/stealth-config.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";

/** All actor uuids the given user owns (OWNER permission level).
 *  Cached per-refresh via the arg — call sites reuse. */
/* Cached owned-actor-uuid set for the LOCAL user. Rebuilt only when actor
 * ownership actually changes (create / delete / ownership update) — see the
 * invalidation hooks in registerStealthTokenVisibility. Without this, the
 * full `game.actors` scan + per-actor permission test ran on every stealthed
 * token's refreshToken (many times per animation frame), a big movement cost
 * on populated worlds. */
let _ownedUuidCache = null;
let _ownedUuidCacheUser = null;
export function invalidateOwnedUuidCache() { _ownedUuidCache = null; _ownedUuidCacheUser = null; }

function userOwnedActorUuids(user) {
    const local = user && user === game.user;
    if (local && _ownedUuidCache && _ownedUuidCacheUser === user.id) return _ownedUuidCache;
    const out = new Set();
    for (const actor of (game.actors?.values?.() ?? [])) {
        if (!actor) continue;
        if (actor.testUserPermission?.(user, "OWNER")) out.add(actor.uuid);
    }
    if (local) { _ownedUuidCache = out; _ownedUuidCacheUser = user.id; }
    return out;
}

/** Should `token` be visible on the current user's client?
 *
 *  GM behavior forks on selection:
 *    - No token selected → sees everything (GM overview).
 *    - Token(s) selected → treated as VIEWING through them: token
 *      renders only if the controlled token's actor is in the
 *      stealther's spottedBy. Lets the GM inspect what an NPC can
 *      actually see by clicking that NPC's token. */
function isStealthedTokenVisibleToCurrentUser(token) {
    const actor = token?.actor;
    if (!actor) return true;
    if (!isStealthed(actor)) return true;

    const user = game.user;
    const state = getStealthState(actor);

    /* GM branch checked FIRST — GM owns every token by default, so
     * the ownership-always-sees rule below would trivially match
     * for GM and defeat the "view through selected" logic.
     *
     * The "view through" perspective set = every currently-selected
     * token, disposition-agnostic. With no selection, fall back to
     * GM overview (see everything). Previously friendly-disposition
     * tokens were filtered out of this set, which meant selecting
     * a friendly NPC gave the GM the overview fallback and appeared
     * to grant them omniscient stealth-piercing sight — the wrong
     * default for "check what this specific friendly can see." */
    if (user?.isGM) {
        const controlled = canvas?.tokens?.controlled ?? [];
        if (controlled.length === 0) return true;
        for (const ct of controlled) {
            if (ct?.id === token.id) return true;
            const uuid = ct?.actor?.uuid;
            if (uuid && state.spottedBy?.includes(uuid)) return true;
        }
        return false;
    }

    /* Non-GM: owner of the stealthed actor always sees themselves. */
    if (actor.testUserPermission?.(user, "OWNER")) return true;

    /* Non-GM: check every owned actor's uuid against spottedBy. */
    if (!state.spottedBy?.length) return false;
    const owned = userOwnedActorUuids(user);
    for (const uuid of state.spottedBy) {
        if (owned.has(uuid)) return true;
    }
    return false;
}

/** Tokens WE have hidden via the stealth gate. Only these get
 *  visibility overrides. Foundry's own visibility decisions
 *  (level occlusion, roof reveals, disposition, GM hidden flag,
 *  etc.) are left alone for every other token — critical because
 *  our refreshToken hook fires on EVERY token pass; if we force-
 *  wrote visibility state on all of them we'd fight Foundry's
 *  own perception system every frame. */
const _hiddenByUs = new WeakSet();

/** Apply the stealth visibility rule to a single token. Only
 *  touches tokens we've hidden or need to hide — non-stealthed
 *  tokens and tokens we haven't hidden go untouched so Foundry's
 *  level / region / occlusion decisions are preserved. */
function applyStealthVisibility(token) {
    if (!token || token.destroyed) return;
    /* FAST PATH — if the token isn't stealthed AND we haven't
     * hidden it, there's nothing to do. This gate covers 100% of
     * calls for non-stealthed tokens in the scene, which is the
     * vast majority: this hook fires on EVERY `refreshToken` event
     * (potentially many times per animation frame per rotating /
     * moving / hovered token), so the early exit is critical.
     * Only when a token is potentially subject to our hiding logic
     * do we pay the config-read + visibility-check cost. */
    const actor = token.actor;
    const isStealthedTok = actor && isStealthed(actor);
    const wasHidden = _hiddenByUs.has(token);
    if (!isStealthedTok && !wasHidden) return;

    /* Master enable — when the stealth system is turned off, we must
     * NOT hide any tokens (and must restore anything we previously
     * hid). The rest of the function's usual "hidden?" logic still
     * runs so `_hiddenByUs` gets cleared and Foundry regains
     * authority over visibility. */
    const featureOn = !!getStealthConfig().enabled;
    const needsHiding = featureOn && isStealthedTok
                        && !isStealthedTokenVisibleToCurrentUser(token);

    if (needsHiding) {
        /* ENFORCE hidden state every pass. Foundry's own refresh
         * loop can un-hide the token between our fires (visibility
         * pipeline resets `token.visible = true` on refreshToken),
         * so we can't just early-out when the WeakSet remembers
         * having hidden it — must re-apply idempotently. */
        token.visible = false;
        if (token.mesh) token.mesh.visible = false;
        token.alpha = 0;
        _hiddenByUs.add(token);
        return;
    }

    /* Not-needing-hiding path. If WE hid this token before, restore
     * it (spotter now spotted us, or stealth ended, or selection
     * changed). Never touch tokens we didn't hide — those are
     * Foundry's business (level occlusion, roof reveals, GM-hidden
     * flag, etc.). */
    if (_hiddenByUs.has(token)) {
        token.visible = true;
        if (token.mesh) token.mesh.visible = true;
        token.alpha = 1;
        _hiddenByUs.delete(token);
    }
}

/** Walk every token on the scene and re-apply the rule. Called on
 *  events where the visibility answer could change for MANY tokens
 *  at once (a stealth flag flip; a controlToken / spot event). */
function applyStealthVisibilityAll() {
    const tokens = canvas?.tokens?.placeables ?? [];
    for (const t of tokens) {
        try { applyStealthVisibility(t); }
        catch (err) { console.warn(`${SYSTEM_ID} | stealth visibility refresh failed`, err); }
    }
}

/* rAF-coalesced full scan — collapses a burst of selection changes (box-select,
 * ESC-deselect of many tokens) into ONE scan per frame instead of one per token
 * (which was O(N²)). */
let _stealthAllQueued = false;
function scheduleStealthVisibilityAll() {
    if (_stealthAllQueued) return;
    _stealthAllQueued = true;
    requestAnimationFrame(() => { _stealthAllQueued = false; applyStealthVisibilityAll(); });
}

export function registerStealthTokenVisibility() {
    /* Per-token refresh triggers. `refreshToken` fires on almost
     * everything Foundry does to a token; keep the applyStealth
     * call cheap and idempotent so re-running it is free. */
    Hooks.on("drawToken",    (token) => { applyStealthVisibility(token); });
    Hooks.on("refreshToken", (token) => { applyStealthVisibility(token); });

    /* Stealth-state changes on ANY actor could flip visibility of
     * that actor's tokens on this client. Re-apply just those. */
    Hooks.on("updateActor", (actor, changes) => {
        const stealthChanged = changes?.flags?.[SYSTEM_ID]?.stealth !== undefined
                            || changes?.flags?.[`-=${SYSTEM_ID}`] !== undefined
                            || changes?.flags?.[SYSTEM_ID]?.[`-=stealth`] !== undefined;
        if (!stealthChanged) return;
        const tokens = actor?.getActiveTokens?.() ?? [];
        for (const t of tokens) applyStealthVisibility(t);
    });

    /* Invalidate the owned-actor-uuid cache whenever actor ownership could
     * have changed. Cheap events, and they keep the hot-path cache correct
     * without re-scanning game.actors on every stealthed token refresh. */
    Hooks.on("createActor",     invalidateOwnedUuidCache);
    Hooks.on("deleteActor",     invalidateOwnedUuidCache);
    Hooks.on("updateActor",     (_actor, changes) => { if (changes?.ownership) invalidateOwnedUuidCache(); });

    /* Scene load — walk all tokens once so anything stealthed
     * before this user connected gets hidden immediately. */
    Hooks.on("canvasReady", () => { invalidateOwnedUuidCache(); applyStealthVisibilityAll(); });

    /* Selection change — GM's "viewing through selected" rule
     * makes visibility of every stealthed token potentially flip
     * when a token is selected or deselected. Also relevant for
     * players if they control multiple tokens across sessions.
     *
     * COALESCED: `controlToken` fires once PER token, and each call scans
     * EVERY token (applyStealthVisibilityAll) — so a box-select / ESC-deselect
     * of N tokens was N × N = N² scans, a prime cause of the multi-select lag.
     * The visibility answer depends only on the FINAL selection, so batch all
     * of a frame's control changes into a single scan on the next frame. */
    Hooks.on("controlToken", () => { scheduleStealthVisibilityAll(); });

    /* GM edited the stealth config (e.g. flipped the master enable
     * toggle) — re-evaluate every token so anything we'd hidden
     * gets restored when the feature is turned off. */
    Hooks.on("wdmStealthConfigChanged", () => { applyStealthVisibilityAll(); });
}
