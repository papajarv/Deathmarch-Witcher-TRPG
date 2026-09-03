/**
 * Movement-pace badge on a stealthed token.
 *
 * Chevrons showing how fast the sneak moved during the current window — the
 * value that feeds their Stealth check (+2 still … −2 running).
 *
 * WHY THIS IS A TOKEN CHILD, not part of the spotter-vision overlay:
 *
 * It began life drawn into the overlay's own layer at the token's document
 * coordinates. During a move Foundry animates the token mesh toward its
 * destination while `document.x/y` is already AT the destination, so the badge
 * teleported ahead and the token slid to catch up — the indicator visibly came
 * apart from the thing it describes. Parenting it to the token, exactly as the
 * light-tier badge does, makes it move with the mesh for free: no positioning
 * maths, no animation handling, no drift.
 *
 * It also gets cheaper. The overlay redraws on its own cadence, whereas this
 * only redraws on `refreshToken` — the same hook Foundry already fires while a
 * token moves.
 */

import { tokenTextureScale } from "./witcher-token-style.mjs";
import { isStealthed } from "../mechanics/stealth.mjs";
import { getStealthConfig } from "../mechanics/stealth-config.mjs";

const BADGE_MARK = Symbol("wdmPaceBadge");
/* Last-drawn signature, so an unchanged badge is left alone entirely. */
const SIG_MARK = Symbol("wdmPaceSig");

/* Chevron count per pace. Symbols only — no numbers: the modifier is already
 * in the roll card, and a bare glyph is what a HUD element glanced at a hundred
 * times a session should be. */
const CHEVRONS = { still: 0, creep: 1, walk: 2, run: 3 };
const TINT     = { still: 0x7fd4a0, creep: 0xbfe08a, walk: 0xd8a24c, run: 0xff4a3a };

/* ── pre-rendered chevron textures ────────────────────────────────────────
 * Each pace is drawn ONCE into a texture and reused as a Sprite thereafter.
 * Rebuilding Graphics means re-tessellating strokes; a sprite swap is one quad.
 * Keyed by pace and rounded scale, so tokens of the same size share a texture.
 *
 * Cleared on canvasReady — textures belong to the renderer of the scene that
 * created them, and holding them across a scene change leaks GPU memory. */
const _texCache = new Map();

function chevronTexture(pace, S) {
    const key = `${pace}:${S.toFixed(1)}`;
    const hit = _texCache.get(key);
    if (hit && !hit.destroyed) return hit;

    const n    = CHEVRONS[pace] ?? 2;
    const tint = TINT[pace] ?? TINT.walk;
    const step = 4.5 * S;
    const pad  = 3 * S;

    const g = new PIXI.Graphics();
    /* Chevrons march forward, brightest at the leading edge, so speed reads
     * from the shape without having to count them. Drawn into a local box; the
     * sprite's centre anchor does the placing, so callers do no arithmetic. */
    for (let i = 0; i < n; i++) {
        const x = pad + i * step;
        g.lineStyle(2.2 * S, tint, 0.95 - (n - 1 - i) * 0.18);
        g.moveTo(x, pad);
        g.lineTo(x + 3.5 * S, pad + 4 * S);
        g.lineTo(x, pad + 8 * S);
    }
    let tex = null;
    try { tex = canvas?.app?.renderer?.generateTexture(g, { resolution: 2 }); }
    catch (_) { tex = null; }
    try { g.destroy(); } catch (_) {}
    if (tex) _texCache.set(key, tex);
    return tex;
}

function clearTextureCache() {
    for (const t of _texCache.values()) { try { t.destroy(true); } catch (_) {} }
    _texCache.clear();
}

/* ── movement accumulation ────────────────────────────────────────────────
 * Ground covered inside the CURRENT window, measured live so the badge crosses
 * a threshold the moment the player does rather than at the end of a tick.
 *
 * Window is 3 s out of combat and the token's own turn in combat — the same
 * definition the mechanics use, so the badge and the check can never disagree.
 *
 * `_lastPos` is required because `updateToken` fires AFTER the document is
 * written: the placeable's `.x` already holds the NEW position, so diffing it
 * against `changes.x` always yields 0. Foundry does not hand the previous
 * position to the hook, so we keep our own mark. */
const _moveAccum = new Map();
const _lastPos   = new Map();
const MOVE_WINDOW_MS = 3000;

function combatTurnKey() {
    const c = game?.combat;
    if (!c?.started) return null;
    return `${c.id}:${c.round}:${c.turn}`;
}

function metresSinceLastMark(tokenDoc) {
    const dim = canvas?.dimensions;
    const pxPerUnit = (dim?.size || 100) / (dim?.distance || 1);
    const nowX = Number(tokenDoc?.x) || 0;
    const nowY = Number(tokenDoc?.y) || 0;
    const prev = _lastPos.get(tokenDoc?.id);
    _lastPos.set(tokenDoc?.id, { x: nowX, y: nowY });
    if (!prev) return 0;                       /* first sighting sets the mark */
    return Math.hypot(nowX - prev.x, nowY - prev.y) / (pxPerUnit || 1);
}

function bankMove(tokenId, metres, inCombat, turnKey) {
    const now = performance.now();
    const rec = _moveAccum.get(tokenId);
    const stale = !rec
        || (inCombat ? rec.turn !== turnKey : (now - rec.windowStart) >= MOVE_WINDOW_MS);
    if (stale) _moveAccum.set(tokenId, { metres, windowStart: now, turn: turnKey });
    else rec.metres += metres;
}

function coveredNow(tokenId, inCombat, turnKey) {
    const rec = _moveAccum.get(tokenId);
    if (!rec) return 0;
    if (inCombat) return rec.turn === turnKey ? rec.metres : 0;
    return (performance.now() - rec.windowStart) < MOVE_WINDOW_MS ? rec.metres : 0;
}

/* ── The pace API the overlay reads ───────────────────────────────────────
 * `stealth-spotter-vision.mjs` was written against `accumulatedMove()`,
 * `combatTurnKey()` and `PACE_HOLD_MS`, and none of the three was ever
 * exported — so every reference to them threw `ReferenceError`. That took out
 * the whole `updateToken` handler over there (nothing after the first
 * reference ran) and the overlay's cache-key computation with it.
 *
 * These are the same functions under the names that module already expects,
 * rather than a rewrite of the caller: the intent was clear, only the wiring
 * was missing. */
export { combatTurnKey };
export const PACE_HOLD_MS = MOVE_WINDOW_MS;
/** Metres banked inside the current window / combat turn. */
export function accumulatedMove(tokenId, inCombat, turnKey) {
    return coveredNow(tokenId, inCombat, turnKey);
}

export function clearPaceCovered(tokenId) {
    _moveAccum.delete(tokenId);
    _lastPos.delete(tokenId);
}

function paceFor(token) {
    const inC = !!token?.combatant?.combat?.started;
    const metres = coveredNow(token?.id, inC, combatTurnKey());
    const spd = Number(token?.actor?.system?.stats?.spd?.value) || 0;
    if (metres <= 0)        return "still";
    if (spd <= 0)           return "walk";
    if (metres <= spd / 2)  return "creep";
    if (metres <= spd)      return "walk";
    return "run";
}

/**
 * The badge, if it already exists.
 *
 * Held as a direct reference ON the token rather than searched for by walking
 * children — which is how the counter-rotation wrapper tracks itself, and for
 * the same reason. The wrapper is parented to the OCCLUSION CARRIER, not to the
 * token, so a search one level down from the token never found the badge: every
 * refresh built a new one and left the old in place. They stacked up, each pace
 * from the whole session drawn on top of the last, with only the newest visible.
 */
function findBadge(token) {
    const c = token?.[BADGE_MARK];
    if (!c || c.destroyed || !c.parent) return null;
    return c;
}

function getOrCreateBadge(token) {
    let c = findBadge(token);
    if (c && !c.destroyed) return c;
    c = new PIXI.Container();
    c.eventMode = "none";
    c.zIndex = 102;   /* above the light badge (101) so they stack predictably */
    /* Remember it on the token, so the next refresh reuses this instance
     * wherever it ended up parented. */
    token[BADGE_MARK] = c;

    /* Parented DIRECTLY to the token placeable — NOT to the occlusion carrier
     * or counter-rotation wrapper those other badges use.
     *
     * Both of those sit in the primary canvas group alongside the token's mesh,
     * which is what the darkness filter dims. The badge therefore went dark
     * along with the token in exactly the low-light scenes stealth happens in.
     * The placeable itself lives in the interface group with borders and bars,
     * which lighting never touches. Counter-rotation is done by hand below —
     * a cheaper price than an indicator you cannot read in the dark. */
    token.addChild?.(c);
    return c;
}

export function clearPaceBadge(token) {
    const c = token?.[BADGE_MARK];
    if (token) token[BADGE_MARK] = null;
    if (!c || c.destroyed) return;
    try { c.destroy({ children: true }); } catch (_) { /* already gone */ }
}

/**
 * Keep the badge upright and correctly scaled, mirroring what
 * `syncCounterRotWrapper` does for the other token decorations.
 *
 * Three things matter and all three were missing from the hand-rolled version:
 *
 *  - PIVOT at the token's centre. Rotating without one turns the badge about
 *    the token's top-left corner, so it swings out on an arc instead of
 *    spinning in place — the "not clamped to the token" symptom.
 *  - The token's TEXTURE SCALE, so the badge tracks the visible token rather
 *    than the grid footprint.
 *  - Cancelling the STAGE rotation, which is what the immersive camera turns.
 *
 * Position and pivot are both the centre, so local coordinates stay
 * token-local (0,0 = top-left) and the sprite placement is unaffected.
 */
function syncBadgeTransform(token, container) {
    if (!token || !container || container.destroyed) return;
    const cx = (Number(token.w) || 0) / 2;
    const cy = (Number(token.h) || 0) / 2;
    if (container.position.x !== cx || container.position.y !== cy) container.position.set(cx, cy);
    if (container.pivot.x !== cx || container.pivot.y !== cy) container.pivot.set(cx, cy);
    const target = -(Number(canvas?.stage?.rotation) || 0);
    if (container.rotation !== target) container.rotation = target;
    const sc = tokenTextureScale(token);
    if (container.scale.x !== sc || container.scale.y !== sc) container.scale.set(sc);
}

/** Redraw the badge for one token, or remove it when it doesn't apply. */
export function refreshPaceBadge(token) {
    /* HOT PATH: `refreshToken` fires once per token per animation frame, so
     * everything here runs for every token on the canvas at 60 fps. Order the
     * gates cheapest-first and bail before touching config or flags. */
    if (!token?.actor) return;

    /* SELECTED ONLY, and checked FIRST because it is a bare boolean and almost
     * every token on the canvas fails it. This gate used to sit last, behind a
     * config read, a flag lookup and a permission check — all of which ran for
     * every token, every frame, to reach a `false` that a single property read
     * could have given. The badge is feedback about the token you are driving;
     * a party of sneaks each carrying one is just clutter. */
    if (!token.controlled) {
        if (token[BADGE_MARK]) clearPaceBadge(token);
        return;
    }

    const cfg = getStealthConfig();
    if (!cfg.enabled || cfg.detectionModel !== "exposure" || !isStealthed(token.actor)) {
        if (token[BADGE_MARK]) clearPaceBadge(token);
        return;
    }
    /* Only the sneak's own side needs this — it is feedback about your own
     * movement, not intelligence about someone else's. */
    if (!token.actor.isOwner && !game.user?.isGM) { clearPaceBadge(token); return; }

    const pace = paceFor(token);

    /* STILL draws nothing. Standing motionless is the default state of a
     * sneaking token, so a permanent marker for it is noise — the badge should
     * appear because something is happening, not sit there reporting that
     * nothing is. The absence of chevrons now carries the meaning the ring used
     * to, and the map stays quiet until you move. */
    if (pace === "still") { clearPaceBadge(token); return; }

    /* Nothing to redraw unless the pace CATEGORY or the token's size changed.
     * Without this the Graphics was torn down and rebuilt sixty times a second
     * to draw the identical three chevrons — by far the most wasteful thing in
     * the stealth code, and invisible because it looked correct. */
    const sig = `${pace}:${Math.round(token.w || 0)}`;
    const existing = findBadge(token);
    if (existing && existing[SIG_MARK] === sig) {
        /* Transform is synced even when the artwork is unchanged. It sat AFTER
         * this early-out, so rotating the camera never reached a badge whose
         * pace had not changed — it stayed locked at whatever angle it was
         * drawn at and skewed away under the immersive camera. */
        syncBadgeTransform(token, existing);
        return;
    }

    const container = existing ?? getOrCreateBadge(token);
    if (!container || container.destroyed) return;
    syncBadgeTransform(token, container);
    container[SIG_MARK] = sig;
    container.removeChildren().forEach(ch => { try { ch.destroy(); } catch (_) {} });

    /* Scaled off token size so it stays proportionate on a mount or a halfling
     * rather than being correct at exactly one token scale. */
    const S = Math.max(1.6, (token.w || 100) / 100 * 1.9);

    /* Badge space is token-LOCAL with origin at the top-left corner — the same
     * convention the light-tier badge uses. Centre on the footprint, and sit
     * BELOW the token: above competes with the light badge, nameplates and
     * elevation markers, which all live along the top edge. */
    const tw = Number(token.w) || 100;
    const th = Number(token.h) || 100;

    const tex = chevronTexture(pace, S);
    if (!tex) return;
    const sprite = new PIXI.Sprite(tex);
    sprite.eventMode = "none";
    sprite.anchor.set(0.5, 0.5);
    sprite.position.set(tw / 2, th + 10 * S);
    container.addChild(sprite);
}

export function registerStealthPaceIndicator() {
    /* Bank movement as it lands, then redraw. A one-shot timer covers the
     * window expiring while standing still, so the badge falls back to STILL on
     * time instead of waiting for the next unrelated refresh. */
    let dropTimer = null;
    Hooks.on("updateToken", (tokenDoc, changes) => {
        if (changes?.x === undefined && changes?.y === undefined) return;
        const tok = canvas?.tokens?.get?.(tokenDoc?.id);
        const metres = metresSinceLastMark(tokenDoc);
        if (!tok?.actor || !isStealthed(tok.actor) || metres <= 0) return;
        bankMove(tokenDoc.id, metres, !!tok.combatant?.combat?.started, combatTurnKey());
        try { refreshPaceBadge(tok); } catch (_) {}
        if (dropTimer) clearTimeout(dropTimer);
        dropTimer = setTimeout(() => {
            dropTimer = null;
            try { refreshPaceBadge(tok); } catch (_) {}
        }, MOVE_WINDOW_MS + 60);
    });

    /* Selecting or deselecting flips whether the badge shows at all. */
    Hooks.on("controlToken",  (t) => { try { refreshPaceBadge(t); } catch (_) {} });
    Hooks.on("canvasReady",  () => clearTextureCache());
    Hooks.on("drawToken",    (t) => { try { refreshPaceBadge(t); } catch (_) {} });
    Hooks.on("refreshToken", (t) => { try { refreshPaceBadge(t); } catch (_) {} });
    Hooks.on("destroyToken", (t) => { try { clearPaceBadge(t); clearPaceCovered(t?.id); } catch (_) {} });
    /* Entering or leaving stealth flips whether the badge exists at all. */
    Hooks.on("updateActor", (actor, changes) => {
        const SYSTEM_ID = "witcher-ttrpg-death-march";
        if (changes?.flags?.[SYSTEM_ID]?.stealth === undefined) return;
        for (const t of (actor?.getActiveTokens?.() ?? [])) {
            try { refreshPaceBadge(t); } catch (_) {}
        }
    });
}
