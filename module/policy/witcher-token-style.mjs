/**
 * Witcher Token Style — chrome-themed restyle of Foundry's PIXI canvas
 * overlays that decorate tokens. Everything below shares the dock / HUD /
 * character-panel visual language (muted amber, hairline strokes, dark
 * underlay for contrast):
 *
 *   1. Selection           (controlled tokens)
 *      - The default colored rectangle border is suppressed. Instead a
 *        pre-rendered golden glow SPRITE is placed behind the token while
 *        controlled, hidden on deselect (one shared texture, no live filter).
 *
 *   2. Target reticle      (tokens you've targeted)
 *      - Replaced with short L-shaped corner brackets in amber-bright,
 *        sitting just outside the token bounds with a dark underlay.
 *        A global canvas ticker breathes the container alpha gently.
 *
 *   3. Turn marker         (active combatant in the current round)
 *      - Foundry's sprite + spin/pulse animation is replaced by a PIXI
 *        Graphics container: a static double-stroke amber ring with a
 *        single short bright arc that orbits once every ~2.8s. Centered
 *        on the token (Foundry's local origin is top-left).
 *
 *   4. On-token status icons
 *      - Each effect icon gets a circular chrome rim: void well behind
 *        the icon + a 1.5px ring stroked in the status's family color
 *        (stress-break rust red, stress-boon sage green, food-drink
 *        burnt orange, sickness sickly green, aim amber-bright, default
 *        amber-hi). GM-set per-status `rimColor` overrides win.
 *
 *   5. Disposition palette
 *      - CONFIG.Canvas.dispositionColors redirected to the chrome
 *        amber/red palette so any Foundry component that pulls disposition
 *        colors gets the same look.
 *
 * Implementation:
 *   - Overlays 2-4 patch Token prototype methods (_drawTargetArrows,
 *     _refreshTurnMarker, _drawEffects, _refreshEffects) during `setup`,
 *     before any token instance exists. Signatures preserved so Foundry's
 *     render-flag plumbing fires them as normal.
 *   - Selection uses two hooks (controlToken to add/remove the filter,
 *     refreshToken to re-apply if the mesh is rebuilt under a controlled
 *     token).
 *   - Palette values inlined as hex literals so the canvas layer never
 *     pays a CSS-variable round-trip per refresh.
 */

const SYSTEM_ID = "witcher-ttrpg-death-march";

/* Witcher chrome palette mirrored from styles/tokens.css. PIXI takes RGB
 * ints; alpha is passed separately to lineStyle/fill calls. */
const COLOR = {
    amberBright: 0xc8a878,   // --wdm-amber-bright — controlled / active
    amberHi:     0xb89464,   // --wdm-amber-hi      — friendly party
    amber:       0xa88450,   // --wdm-amber         — friendly NPC
    amberDim:    0x6e5224,   // --wdm-amber-dim     — idle / inactive hover
    red:         0x8c3c3c,   // --wdm-red           — hostile
    inkDim:      0x8a857a,   // --wdm-ink-dim       — neutral
    inkFaint:    0x5a574e,   // --wdm-ink-faint     — inactive
    void:        0x050402    // --wdm-void          — dark underlay / secret
};

/* ─────────── occlusion carrier ─────────── */

/* All of the Token placeable's decoration children — Foundry's
 * `border` / `bars` / `nameplate` / `tooltip` / `levelIndicator` /
 * `effects` / `targetArrows` / `targetPips` and OUR `_wdmFacingArrow`,
 * `_wdmHealthVisuals`, `turnMarker` — live in `canvas.tokens`, the
 * INTERFACE layer, which renders as one big overlay ON TOP OF the
 * entire primary canvas group. The mesh (portrait + dynamic ring)
 * lives in `canvas.primary`, gets sorted per-child by
 * `elevation → sortLayer → sort → zIndex`, and therefore ends up
 * BELOW higher-elevation surfaces / level textures / roof tiles in
 * z-order. That's the whole reason the portrait can be visually
 * "obscured" by a roof: it's just a lower-elevation object in the
 * primary group with a higher-elevation opaque texture painted over
 * it. Nothing in the interface layer ever gets covered by anything
 * in the primary group — no matter how tall — because the interface
 * layer is drawn on top of the whole group after the fact.
 *
 * This is a structural issue, not a state issue. No amount of
 * cascading `.visible = false` in refresh handlers fixes it, because
 * the mesh isn't set invisible by the roof either — it's just
 * covered by a later draw. To make our decorations follow, they
 * have to live in the same layer with the same sort keys.
 *
 * The occlusion carrier is a `PIXI.Container` we add directly to
 * `canvas.primary` and continuously sync to the token's mesh:
 *
 *   - Its position matches the mesh (the anchor point in world
 *     coordinates, which is the token's center for anchor 0.5,0.5).
 *   - Its rotation and scale mirror the mesh.
 *   - Its `pivot` is set to (token.w/2, token.h/2), so decoration
 *     coordinates that used to be relative to the token placeable's
 *     top-left origin STILL render correctly — pivot + position
 *     recreates the same local frame as the placeable had.
 *   - Its `elevation`, `sortLayer`, and `sort` mirror the mesh's so
 *     Foundry's own `_compareObjects` sort (see primary.mjs:481)
 *     places the carrier at the mesh's z-position. Higher-elevation
 *     roofs / floors will paint over both the mesh AND the carrier,
 *     and every decoration inside it, together.
 *   - Its `visible` and `alpha` mirror the mesh, so hiding /
 *     dimming the mesh through any Foundry path also hides /
 *     dims the whole set of decorations.
 *
 * The carrier is created on `drawToken`, synced every frame by the
 * existing per-token ticker, and destroyed on `destroyToken`. All
 * the decoration containers (Foundry's + ours) are moved into it
 * once, on `drawToken`, right after Foundry finishes building them. */

const OCCLUSION_CARRIER_MARK = "_wdmOcclusionCarrier";
const COUNTER_ROT_WRAPPER_MARK = "_wdmCounterRotWrapper";
/* Companion to the carrier, but synced one z-step BELOW the mesh instead
 * of above it — for decorations that must render BEHIND the portrait +
 * dynamic ring (currently the disposition glow). Same elevation/sort as
 * the mesh so roofs still occlude it; only the zIndex tiebreaker differs.
 * Created lazily (only tokens that need a behind-mesh decoration get one)
 * and synced by the same per-frame ticker as the carrier. */
const OCCLUSION_BACKDROP_MARK = "_wdmOcclusionBackdrop";

function getOrCreateOcclusionCarrier(token) {
    if (!token || token.destroyed) return null;
    const existing = token[OCCLUSION_CARRIER_MARK];
    if (existing && !existing.destroyed) return existing;
    if (!canvas?.primary) return null;
    const c = new PIXI.Container();
    c.name = `WDMOcclusionCarrier:${token.id}`;
    c[OCCLUSION_CARRIER_MARK] = true;
    /* Prime the primary-group sort keys so `_compareObjects` has
     * defined values on the first draw before the ticker runs. */
    c.elevation = Number(token.mesh?.elevation ?? token.document?.elevation) || 0;
    c.sortLayer = Number(token.mesh?.sortLayer) || 0;
    c.sort      = Number(token.mesh?.sort) || 0;
    c.zIndex    = Number(token.mesh?.zIndex) || 0;
    c.eventMode = "none";
    canvas.primary.addChild(c);
    token[OCCLUSION_CARRIER_MARK] = c;
    /* One-time sort so the freshly-added carrier lands at its z-position on the
     * first frame. The per-frame sync only dirties on a sort-key CHANGE, so the
     * initial placement is flagged explicitly here rather than relying on it. */
    if (canvas.primary) canvas.primary.sortDirty = true;
    syncOcclusionCarrier(token);
    return c;
}

/** Counter-rotation wrapper. Child of the occlusion carrier, rotates
 *  around the TOKEN CENTER (pivot + position both set to (w/2, h/2))
 *  so all decorations parented into it stay screen-upright and glued
 *  to the token when the stage is rotated by the immersive camera.
 *
 *  Why a separate wrapper instead of rotating the occlusion carrier
 *  itself: the facing arrow MUST rotate with the world (it's how the
 *  player sees which way the character is looking). It stays in the
 *  occlusion carrier directly. Everything else — Foundry's own bars,
 *  nameplate, tooltip, level indicator, effects, target arrows,
 *  target pips, our turn marker and health visuals — goes into this
 *  wrapper so a single `wrapper.rotation = -stageRot` per frame
 *  keeps the whole set glued together without per-child position
 *  math for every rotate-only decoration whose canonical local
 *  position depends on token size / offset (see immersive-token-
 *  camera.mjs's earlier per-child counter-rotation which dislodged
 *  nameplate + bars because a child rotation set to -θ keeps
 *  glyphs upright but doesn't compensate for the parent's position
 *  offset getting rotated by θ). */
function getOrCreateCounterRotWrapper(token) {
    if (!token || token.destroyed) return null;
    const existing = token[COUNTER_ROT_WRAPPER_MARK];
    if (existing && !existing.destroyed) return existing;
    const carrier = getOrCreateOcclusionCarrier(token);
    if (!carrier || carrier.destroyed) return null;
    const w = new PIXI.Container();
    w.name = `WDMCounterRotWrapper:${token.id}`;
    w[COUNTER_ROT_WRAPPER_MARK] = true;
    w.eventMode = "none";
    carrier.addChild(w);
    token[COUNTER_ROT_WRAPPER_MARK] = w;
    syncCounterRotWrapper(token);
    return w;
}

/** The token's uniform texture scale — the factor Foundry multiplies the
 *  mesh (portrait + dynamic ring) by, so the VISIBLE token extent is the
 *  grid footprint × this. Decorations sized off the footprint must
 *  multiply by it to sit on the visible ring rather than the footprint
 *  edge. `abs` guards mirrored (negative) scales; `max` picks the larger
 *  of a non-uniform X/Y so round decorations stay outside the token. */
export function tokenTextureScale(token) {
    const tex = token?.document?.texture;
    const sx = Math.abs(Number(tex?.scaleX)) || 1;
    const sy = Math.abs(Number(tex?.scaleY)) || 1;
    return Math.max(sx, sy) || 1;
}

/** Sync the CRW's position, pivot, rotation, and scale to keep decorations
 *  screen-upright, pinned to the token, and SIZED to the visible token.
 *  Position + pivot are both the token center (in the carrier's local
 *  frame — since carrier is at token top-left, the center is (w/2, h/2)).
 *  Rotation counters the stage's rotation so parented children render at
 *  the same screen offset regardless of how the world is turned. Scale is
 *  the token's texture scale so every decoration parented here — Foundry's
 *  bars / nameplate / tooltip / level indicator / effects (status rings) /
 *  target arrows, plus our turn marker and health visuals — grows and
 *  shrinks with the token art around the token center, matching the mesh.
 *  (The facing arrow lives in the carrier, not here, so it applies the
 *  same factor itself; the disposition halo does likewise in its own
 *  module.) */
function syncCounterRotWrapper(token) {
    const w = token?.[COUNTER_ROT_WRAPPER_MARK];
    if (!w || w.destroyed) return;
    const tw = Number(token.w) || 0;
    const th = Number(token.h) || 0;
    const cx = tw / 2;
    const cy = th / 2;
    if (w.position.x !== cx || w.position.y !== cy) w.position.set(cx, cy);
    if (w.pivot.x !== cx || w.pivot.y !== cy) w.pivot.set(cx, cy);
    const stageRot = Number(canvas?.stage?.rotation) || 0;
    const target = -stageRot;
    if (w.rotation !== target) w.rotation = target;
    const s = tokenTextureScale(token);
    if (w.scale.x !== s || w.scale.y !== s) w.scale.set(s);
}

function syncOcclusionCarrier(token) {
    const c = token?.[OCCLUSION_CARRIER_MARK];
    const mesh = token?.mesh;
    if (!c || c.destroyed || !mesh || mesh.destroyed) return;
    /* Position: match the TOKEN placeable's position (top-left of
     * bounding box in world coords) so decorations that were
     * positioned relative to the placeable's local origin (which is
     * the top-left) render at the same world spot. Don't use
     * `mesh.position` — that's the token's CENTER because the mesh
     * anchor is (0.5, 0.5), and it would require every decoration
     * child to translate its own coordinate frame. */
    if (c.position.x !== token.position.x || c.position.y !== token.position.y)
        c.position.set(token.position.x, token.position.y);
    /* No rotation / scale sync. Foundry's decorations (nameplate,
     * bars, level indicator, effects grid, etc.) are drawn upright
     * regardless of token facing, and the facing arrow does its own
     * `doc.rotation`-based rotation math. Rotating the carrier
     * would spin the whole set including things that should stay
     * upright. These are constants — write only if something knocked
     * them off, so the per-frame path doesn't dirty the transform. */
    if (c.rotation !== 0) c.rotation = 0;
    if (c.scale.x !== 1 || c.scale.y !== 1) c.scale.set(1, 1);
    if (c.pivot.x !== 0 || c.pivot.y !== 0) c.pivot.set(0, 0);
    /* Sort keys — must match mesh so the carrier ends up at the
     * mesh's z-position in the primary group. Same-elevation ties
     * with the mesh are resolved by zIndex/_lastSortedIndex so
     * decorations render AFTER the mesh (correct: on top of the
     * portrait, under higher-elevation surfaces).
     *
     * CRITICAL: only flag `canvas.primary.sortDirty` when a sort key
     * ACTUALLY changed. This runs every frame for every token; the sort
     * keys only move on an elevation / z / sort-layer change (never on
     * ordinary x/y movement), yet unconditionally setting sortDirty forced
     * a full re-sort of the ENTIRE primary group (every mesh, carrier, tile,
     * template) on every frame — a major movement-time stutter. Gating it
     * matches Foundry's own "dirty only on real change" contract. */
    const _nZ = (Number(mesh.zIndex) || 0) + 1;
    let _sortChanged = false;
    if (c.elevation !== mesh.elevation) { c.elevation = mesh.elevation; _sortChanged = true; }
    if (c.sortLayer !== mesh.sortLayer) { c.sortLayer = mesh.sortLayer; _sortChanged = true; }
    if (c.sort      !== mesh.sort)      { c.sort      = mesh.sort;      _sortChanged = true; }
    if (c.zIndex    !== _nZ)            { c.zIndex    = _nZ;            _sortChanged = true; }
    /* Mirror mesh visibility + alpha so any Foundry path that
     * hides / dims the mesh also hides / dims the whole decoration
     * set. Higher-elevation surfaces still occlude both via z-order
     * regardless of alpha. */
    const _vis = mesh.visible !== false;
    if (c.visible !== _vis) c.visible = _vis;
    const _al = Number(mesh.alpha ?? 1);
    if (c.alpha !== _al) c.alpha = _al;
    if (_sortChanged && canvas.primary) canvas.primary.sortDirty = true;
}

function destroyOcclusionCarrier(token) {
    const c = token?.[OCCLUSION_CARRIER_MARK];
    if (!c) return;
    try { if (!c.destroyed) c.destroy({ children: true }); } catch (_) { /* already gone */ }
    if (token) {
        token[OCCLUSION_CARRIER_MARK]   = null;
        token[COUNTER_ROT_WRAPPER_MARK] = null;   // wrapper was a child of the carrier
    }
}

/* ─────────── behind-mesh backdrop ─────────── */

/* Like the occlusion carrier, but its zIndex is synced to ONE BELOW the
 * mesh's so everything parented into it renders BEHIND the portrait +
 * dynamic ring. Shares the mesh's elevation / sortLayer / sort, so
 * higher-elevation surfaces (roofs) occlude it exactly like the mesh, and
 * it mirrors mesh alpha + visibility so a behind-mesh decoration fades /
 * hides together with the token. Lazily created — a token only gets a
 * backdrop once something (the disposition glow) asks for one. */
function getOrCreateOcclusionBackdrop(token) {
    if (!token || token.destroyed) return null;
    const existing = token[OCCLUSION_BACKDROP_MARK];
    if (existing && !existing.destroyed) return existing;
    if (!canvas?.primary) return null;
    const c = new PIXI.Container();
    c.name = `WDMOcclusionBackdrop:${token.id}`;
    c[OCCLUSION_BACKDROP_MARK] = true;
    c.elevation = Number(token.mesh?.elevation ?? token.document?.elevation) || 0;
    c.sortLayer = Number(token.mesh?.sortLayer) || 0;
    c.sort      = Number(token.mesh?.sort) || 0;
    c.zIndex    = (Number(token.mesh?.zIndex) || 0) - 1;
    c.eventMode = "none";
    canvas.primary.addChild(c);
    token[OCCLUSION_BACKDROP_MARK] = c;
    /* One-time sort so the freshly-added backdrop lands one z below the mesh on
     * the first frame (its primed keys match the synced ones, so the gated
     * per-frame sync won't flag a sort on its own). */
    if (canvas.primary) canvas.primary.sortDirty = true;
    syncOcclusionBackdrop(token);
    return c;
}

/* Sync the backdrop's transform + sort keys to the mesh every frame.
 * Cheap early-return when the token has no backdrop (most tokens), so the
 * per-frame ticker pays almost nothing for tokens that never needed one.
 * Position matches the token placeable's top-left (same framing as the
 * carrier) so a child drawn at (w/2, h/2) lands on the token centre. */
function syncOcclusionBackdrop(token) {
    const c = token?.[OCCLUSION_BACKDROP_MARK];
    const mesh = token?.mesh;
    if (!c || c.destroyed || !mesh || mesh.destroyed) return;
    if (c.position.x !== token.position.x || c.position.y !== token.position.y)
        c.position.set(token.position.x, token.position.y);
    if (c.rotation !== 0) c.rotation = 0;
    if (c.scale.x !== 1 || c.scale.y !== 1) c.scale.set(1, 1);
    if (c.pivot.x !== 0 || c.pivot.y !== 0) c.pivot.set(0, 0);
    /* Sort-key writes gated on real change (see syncOcclusionCarrier) — a
     * per-frame sortDirty here re-sorts the whole primary group every frame
     * during movement for nothing. */
    const _nZ = (Number(mesh.zIndex) || 0) - 1;   // ONE BELOW the mesh
    let _sortChanged = false;
    if (c.elevation !== mesh.elevation) { c.elevation = mesh.elevation; _sortChanged = true; }
    if (c.sortLayer !== mesh.sortLayer) { c.sortLayer = mesh.sortLayer; _sortChanged = true; }
    if (c.sort      !== mesh.sort)      { c.sort      = mesh.sort;      _sortChanged = true; }
    if (c.zIndex    !== _nZ)            { c.zIndex    = _nZ;            _sortChanged = true; }
    const _vis = mesh.visible !== false;
    if (c.visible !== _vis) c.visible = _vis;
    const _al = Number(mesh.alpha ?? 1);
    if (c.alpha !== _al) c.alpha = _al;
    if (_sortChanged && canvas.primary) canvas.primary.sortDirty = true;
}

function destroyOcclusionBackdrop(token) {
    const c = token?.[OCCLUSION_BACKDROP_MARK];
    if (!c) return;
    try { if (!c.destroyed) c.destroy({ children: true }); } catch (_) { /* already gone */ }
    if (token) token[OCCLUSION_BACKDROP_MARK] = null;
}

/* Move a token's existing decoration children into the carrier.
 * Idempotent — skips anything already parented to the carrier. Called
 * on `drawToken` (once Foundry has finished building them) and after
 * `refreshEffects` in case Foundry rebuilt a container. Setting
 * `child.parent === carrier` is the whole fix — once inside, the
 * carrier's primary-group z-position governs visibility. */
function reparentDecorationsToCarrier(token) {
    if (!token || token.destroyed) return;
    const carrier = getOrCreateOcclusionCarrier(token);
    if (!carrier || carrier.destroyed) return;
    const wrapper = getOrCreateCounterRotWrapper(token);
    if (!wrapper || wrapper.destroyed) return;
    /* moveInto(target, child): idempotent reparent — skips already-in-place. */
    const moveInto = (target, child) => {
        if (!child || child.destroyed) return;
        if (child.parent === target) return;
        try {
            child.parent?.removeChild?.(child);
            target.addChild(child);
        } catch (_) { /* soft-fail — teardown race */ }
    };
    /* Decorations that must stay SCREEN-UPRIGHT and screen-glued to
     * the token — Foundry's own bars / nameplate / tooltip / border /
     * level indicator / effects / target arrows / target pips, plus
     * our turn marker and health visuals — all go into the counter-
     * rotation wrapper. The wrapper rotates around token center by
     * `-canvas.stage.rotation` every frame, so their local positions
     * (which Foundry authors relative to token top-left) end up at
     * the same screen offset from the token regardless of how the
     * immersive camera has turned the world. */
    const toWrap = wrapper;
    moveInto(toWrap, token.border);
    moveInto(toWrap, token.bars);
    moveInto(toWrap, token.nameplate);
    moveInto(toWrap, token.tooltip);
    moveInto(toWrap, token.levelIndicator);
    moveInto(toWrap, token.effects);
    moveInto(toWrap, token.targetArrows);
    moveInto(toWrap, token.targetPips);
    moveInto(toWrap, token.turnMarker);
    /* Health-state visuals may live on the placeable, on the carrier
     * (legacy), or the wrapper (post-refactor). Find the container
     * marked with `_wdmHealthVisuals` wherever it currently sits and
     * make sure it's in the wrapper. */
    const health = token.children?.find?.(ch => ch?._wdmHealthVisuals)
        ?? carrier.children?.find?.(ch => ch?._wdmHealthVisuals)
        ?? wrapper.children?.find?.(ch => ch?._wdmHealthVisuals);
    if (health) moveInto(toWrap, health);
    /* Facing arrow — MUST rotate with the world (it's how the player
     * reads the character's facing). Stays in the occlusion carrier
     * directly so the stage rotation carries it along. Still gets
     * the elevation-based occlusion because the carrier owns that. */
    moveInto(carrier, token._wdmFacingArrow);
}

export { getOrCreateOcclusionCarrier, syncOcclusionCarrier, destroyOcclusionCarrier,
         getOrCreateCounterRotWrapper, syncCounterRotWrapper, reparentDecorationsToCarrier,
         getOrCreateOcclusionBackdrop, syncOcclusionBackdrop, destroyOcclusionBackdrop };

/* ─────────── disposition palette ─────────── */

/* Redirect Foundry's disposition colors to the chrome palette. Foundry tints
 * `Token#border` by this map (see Token#_refreshState), and several other
 * canvas components also pull from it, so swapping it once gives us a chrome
 * look everywhere disposition is visualized. Patched at `setup` so any later
 * lookups see the new values. */
function applyDispositionColors() {
    const colors = CONFIG?.Canvas?.dispositionColors;
    if (!colors) return;
    colors.CONTROLLED = COLOR.amberBright;
    colors.PARTY      = COLOR.amberHi;
    colors.FRIENDLY   = COLOR.amber;
    colors.HOSTILE    = COLOR.red;
    colors.NEUTRAL    = COLOR.inkDim;
    colors.INACTIVE   = COLOR.inkFaint;
    colors.SECRET     = COLOR.void;
}

/* ─────────── selection border ─────────── */

/* No rectangle — selection is communicated by the pre-rendered golden glow
 * SPRITE behind the token (see registerSelectionGlow). _refreshBorder still
 * needs to exist (Foundry sets border.visible / border.tint elsewhere) but we
 * just clear it. Hover-only border drawing was intentionally dropped along with
 * the selection rectangle to keep the canvas un-cluttered; the glow is the
 * single visual cue. */
function refreshBorderWitcher() {
    const g = this.border;
    if (!g) return;
    g.clear();
}

/* ─────────── target reticle ─────────── */

/* Replace Foundry's triangular arrows with smaller L-shaped corner brackets
 * in amber-bright. Underlay in void for contrast on bright terrain. A global
 * ticker (see `registerTargetPulse`) lightly alpha-pulses the container so
 * targeted tokens read as "active". */
function drawTargetArrowsWitcher() {
    const g = this.targetArrows;
    if (!g) return;
    g.clear();

    if (!this.targeted?.size || !this.targeted.has(game.user)) return;

    const ui = canvas.dimensions?.uiScale ?? 1;
    const w = this.w, h = this.h;
    const arm   = Math.min(w, h) * 0.13;   // shorter than Foundry's; reads as accent, not frame
    const inset = 3 * ui;
    const innerW = 2 * ui;
    const underlayW = 3.5 * ui;

    const corners = [
        // [originX, originY, dirX, dirY]
        [-inset,      -inset,      -1, -1], // TL
        [w + inset,   -inset,       1, -1], // TR
        [-inset,       h + inset,  -1,  1], // BL
        [w + inset,    h + inset,   1,  1]  // BR
    ];

    // Underlay pass.
    g.lineStyle({
        width: underlayW, color: COLOR.void, alpha: 0.85,
        cap: PIXI.LINE_CAP.SQUARE, join: PIXI.LINE_JOIN.MITER
    });
    for (const [ox, oy, dx, dy] of corners) {
        g.moveTo(ox + dx * arm, oy).lineTo(ox, oy).lineTo(ox, oy + dy * arm);
    }
    // Amber overstroke.
    g.lineStyle({
        width: innerW, color: COLOR.amberBright, alpha: 1,
        cap: PIXI.LINE_CAP.SQUARE, join: PIXI.LINE_JOIN.MITER
    });
    for (const [ox, oy, dx, dy] of corners) {
        g.moveTo(ox + dx * arm, oy).lineTo(ox, oy).lineTo(ox, oy + dy * arm);
    }
}

/* Per-frame pulse for target arrows. Iterates the current user's targets and
 * sets a sin-driven alpha so the brackets gently breathe — same idea as
 * Foundry's default reticule animation, but cheap (just alpha, no redraw).
 * Registered once on the canvas ticker. */
function tickTargetPulse() {
    const targets = game.user?.targets;
    if (!targets?.size) return;
    const t = canvas.app?.ticker?.lastTime ?? performance.now();
    const a = 0.7 + 0.3 * (0.5 + 0.5 * Math.sin(t * 0.004));
    for (const tok of targets) {
        const arrows = tok?.targetArrows;
        if (arrows && arrows.visible) arrows.alpha = a;
    }
}

/* ─────────── turn marker ─────────── */

/* Pre-rendered replacement for TokenTurnMarker — an arcane amber sigil around
 * the active combatant. THREE textures are baked ONCE (canvas 2D → GPU) and
 * reused by every marker:
 *   - outer: a double ring with rune-glyph diamonds
 *   - inner: a dashed runic band
 *   - accent: a single short bright arc
 * The marker just holds three Sprites of those textures and ANIMATES BY
 * TRANSFORM ONLY (rotate outer + inner opposite ways = "magic circle", orbit
 * the accent, breathe the alpha). No per-frame Graphics redraw / re-tessellation
 * — it's a cheap textured-quad composite, same optimisation principle as the
 * selection + disposition glows. Sized off the token so it scales with the
 * token; centered via `_centerOnToken()`. */
const TURN_TEX_SIZE  = 512;
const TURN_RING_FRAC = 0.30;   // ring radius as a fraction of the texture size
let _turnOuterTex = null, _turnInnerTex = null, _turnAccentTex = null;

function _rgba(hex, a) {
    const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
    return `rgba(${r},${g},${b},${a})`;
}
function _newTurnCanvas() {
    const cv = document.createElement("canvas");
    cv.width = cv.height = TURN_TEX_SIZE;
    const x = cv.getContext("2d");
    x.translate(TURN_TEX_SIZE / 2, TURN_TEX_SIZE / 2);   // origin at centre
    return { cv, x };
}
function bakeTurnMarkerTextures() {
    if (_turnOuterTex && !_turnOuterTex.destroyed) return;
    try {
        const S = TURN_TEX_SIZE, r = S * TURN_RING_FRAC;
        // ── outer: double ring + rune-glyph diamonds ──
        {
            const { cv, x } = _newTurnCanvas();
            x.lineWidth = 6; x.strokeStyle = _rgba(COLOR.void, 0.42);
            x.beginPath(); x.arc(0, 0, r, 0, Math.PI * 2); x.stroke();
            x.lineWidth = 3; x.strokeStyle = _rgba(COLOR.amberDim, 0.9);
            x.beginPath(); x.arc(0, 0, r, 0, Math.PI * 2); x.stroke();
            x.lineWidth = 1.5; x.strokeStyle = _rgba(COLOR.amberDim, 0.35);
            x.beginPath(); x.arc(0, 0, r * 1.08, 0, Math.PI * 2); x.stroke();
            // Radial dash ticks around the ring — every 3rd a longer, brighter
            // "cardinal" dash. Reads as a rune dial without any solid glyphs.
            x.lineCap = "round";
            const RN = 12, tIn = r + S * 0.012;
            for (let i = 0; i < RN; i++) {
                const a = (i / RN) * Math.PI * 2, major = i % 3 === 0;
                const tOut = r + S * (major ? 0.05 : 0.03);
                x.lineWidth   = major ? 2.5 : 1.5;
                x.strokeStyle = _rgba(major ? COLOR.amberBright : COLOR.amberDim, major ? 0.8 : 0.45);
                x.beginPath();
                x.moveTo(Math.cos(a) * tIn, Math.sin(a) * tIn);
                x.lineTo(Math.cos(a) * tOut, Math.sin(a) * tOut);
                x.stroke();
            }
            _turnOuterTex = PIXI.Texture.from(cv);
        }
        // ── inner: dashed runic band ──
        {
            const { cv, x } = _newTurnCanvas();
            const rin = r * 0.8, SEG = 18, step = (Math.PI * 2) / SEG;
            x.lineWidth = 2; x.strokeStyle = _rgba(COLOR.amberDim, 0.55);
            for (let i = 0; i < SEG; i++) { const a0 = i * step; x.beginPath(); x.arc(0, 0, rin, a0, a0 + step * 0.5); x.stroke(); }
            _turnInnerTex = PIXI.Texture.from(cv);
        }
        // ── accent: one short bright arc (orbits by rotating the sprite) ──
        {
            const { cv, x } = _newTurnCanvas();
            x.lineCap = "round"; x.lineWidth = 4; x.strokeStyle = _rgba(COLOR.amberBright, 0.95);
            const mid = -Math.PI / 2, span = Math.PI / 4.5;
            x.beginPath(); x.arc(0, 0, r, mid - span / 2, mid + span / 2); x.stroke();
            _turnAccentTex = PIXI.Texture.from(cv);
        }
    } catch (err) {
        console.warn(`${SYSTEM_ID} | turn-marker texture bake failed`, err);
    }
}

class WitcherTurnMarker extends PIXI.Container {
    constructor(token) {
        super();
        this.token = token;
        this.zIndex = -Infinity;
        bakeTurnMarkerTextures();
        this.inner  = _turnInnerTex  ? this.addChild(new PIXI.Sprite(_turnInnerTex))  : null;
        this.outer  = _turnOuterTex  ? this.addChild(new PIXI.Sprite(_turnOuterTex))  : null;
        this.accent = _turnAccentTex ? this.addChild(new PIXI.Sprite(_turnAccentTex)) : null;
        for (const s of [this.inner, this.outer, this.accent]) {
            if (!s) continue;
            s.anchor.set(0.5);
            s.eventMode = "none";
        }
        this._drawn = false;
    }

    /* Token render size in pixels. Prefers the document's `getSize()` (grid
     * width/height × grid size) — the canonical, always-current size — over
     * `token.w/h`, which can be stale during a refresh cycle. */
    _size() {
        const t = this.token;
        const s = t?.document?.getSize?.();
        const grid = canvas?.grid?.size ?? 0;
        const w = Number(s?.width)  || Number(t?.w) || grid;
        const h = Number(s?.height) || Number(t?.h) || grid;
        return { w, h };
    }

    /* Center the marker on the token (its local origin is the token top-left). */
    _centerOnToken() {
        if (!this.token) return;
        const { w, h } = this._size();
        this.position.set(w / 2, h / 2);
    }

    /** Size + centre the pre-baked sprites to the token. No per-frame redraw. */
    async draw() {
        const { w: sz } = this._size();
        if (!sz) return;
        this._centerOnToken();
        // Scale the texture so its baked ring (TURN_RING_FRAC of the texture)
        // lands at ~0.56× the token size on screen.
        const target = sz * (0.56 / TURN_RING_FRAC);
        for (const s of [this.inner, this.outer, this.accent]) {
            if (!s || s.destroyed) continue;
            s.width = target; s.height = target;
            s.position.set(0, 0);
        }
        this._drawn = true;
    }

    /** Per-tick animation: TRANSFORM-only. Rotate the two rings opposite ways,
     *  orbit the accent, breathe the alpha — no Graphics redraw. */
    animate(/* deltaTime */) {
        if (!this._drawn || !this.visible) return;
        const t = canvas.app?.ticker?.lastTime ?? performance.now();
        if (this.outer)  this.outer.rotation  =  (t * 0.00012) % (Math.PI * 2);   // glyph dial CW
        if (this.inner)  this.inner.rotation  = -(t * 0.00009) % (Math.PI * 2);   // dashed band CCW
        if (this.accent) this.accent.rotation =  (t * 0.00045) % (Math.PI * 2);   // accent orbit
        this.alpha = 0.72 + 0.16 * (0.5 + 0.5 * Math.sin(t * 0.0022));
    }

    /** Mirror Foundry's destroy() — tear down the child sprites (their shared
     *  textures are module-level and deliberately NOT destroyed, so the next
     *  marker reuses them). */
    destroy(options) {
        super.destroy({ children: true, ...(options || {}) });
    }
}

/* Patch Token#_refreshTurnMarker to instantiate WitcherTurnMarker instead of
 * Foundry's TokenTurnMarker. Same activation/destroy logic — we only swap the
 * class. */
function refreshTurnMarkerWitcher() {
    if (this.destroyed) return;
    try {
    const turnMarkerDoc = this.document?.turnMarker;
    const cfg = CONFIG?.Combat?.settings?.turnMarker;
    const TOKEN_MODES = CONST?.TOKEN_TURN_MARKER_MODES ?? {};
    const enabled = !!cfg?.enabled && (turnMarkerDoc?.mode !== TOKEN_MODES.DISABLED);
    const isTurn  = game.combat?.combatant?.tokenId === this.id;
    const active  = enabled && isTurn;

    if (active) {
        if (!this.turnMarker) {
            /* Attach to the occlusion carrier in canvas.primary so the
             * ring gets z-order occluded by higher-elevation surfaces
             * just like the mesh does. Falls back to the token
             * placeable if the carrier isn't ready yet (very early
             * draw race — will look correct once the ticker moves it
             * into position). */
            const carrier = getOrCreateOcclusionCarrier(this);
            const marker  = new WitcherTurnMarker(this);
            this.turnMarker = carrier
                ? carrier.addChildAt(marker, 0)
                : this.addChildAt(marker, 0);
        }
        canvas.tokens.turnMarkers?.add?.(this);
        this.turnMarker.draw();
    } else if (this.turnMarker) {
        canvas.tokens.turnMarkers?.delete?.(this);
        try { this.turnMarker.destroy(); } catch (_) { /* already destroyed */ }
        this.turnMarker = null;
    }
    } catch (err) {
        console.warn(`${SYSTEM_ID} | _refreshTurnMarker swallowed (token teardown race)`, err);
    }
}

/* ─────────── on-token effect icons ─────────── */

/* Family → rim color. EXACTLY matches the dock CSS palette in
 * styles/statuses.css (data-family="stress-break|stress-boon|food-drink")
 * so on-token rims and dock badge rings read as one chrome system. */
const FAMILY_RIM = {
    "stress-break": 0xd13838,   // vivid blood-rust (matches styles/statuses.css)
    "stress-boon":  0x89cff0,   // baby blue       (matches styles/statuses.css)
    "food-drink":   0xcc6b1c    // burnt orange    (matches styles/statuses.css)
};

/* Status ids that belong to the food-drink family despite not starting with
 * the `drunk-` prefix. Kept in sync with FOOD_DRINK_STATUS_IDS in
 * module/chrome/chrome/dock-statuses.js so the two taxonomies don't drift. */
const FOOD_DRINK_STATUS_IDS = new Set([
    "gorged", "full", "fed", "peckish", "hungry",
    /* Legacy single-tier famished retained for orphan AEs from the
     * pre-migration model; the current mechanic uses the four depths below. */
    "famished",
    "famished-1", "famished-2", "famished-3", "famished-4",
    "hangover", "food-sickness"
]);

function parseHexColor(v) {
    if (typeof v === "number") return v;
    if (typeof v !== "string") return null;
    const m = v.match(/^#?([0-9a-fA-F]{6})$/);
    return m ? parseInt(m[1], 16) : null;
}

/* Mirror of `effectFamily()` in dock-statuses.js — same precedence so the
 * two surfaces tag the same effect the same way:
 *   1. System flags (`stressBreakdown`, `stressBreakdownCombatEffect`,
 *      `stressBoon`) — boons / breakdowns can be flag-only AEs with no
 *      status id (Indulgent, Paranoid, Selfish, every instant-clear boon).
 *   2. Status-id prefix / membership — break-* / boon-* / drunk-* / the
 *      explicit food-drink ladder. */
function familyForEffect(effect) {
    const flags = effect?.flags?.[SYSTEM_ID];
    if (flags?.stressBreakdown || flags?.stressBreakdownCombatEffect) return "stress-break";
    if (flags?.stressBoon) return "stress-boon";
    const statuses = effect?.statuses;
    if (!statuses?.size) return null;
    for (const id of statuses) {
        if (id.startsWith("break-")) return "stress-break";
        if (id.startsWith("boon-"))  return "stress-boon";
        if (id.startsWith("drunk-")) return "food-drink";
        if (FOOD_DRINK_STATUS_IDS.has(id)) return "food-drink";
    }
    return null;
}

/* Per-status GM-set override (Status Effects editor `rimColor`) wins over
 * everything else, mirroring the dock's `effectRimColor()` precedence. */
function statusRimOverride(effect) {
    const statuses = effect?.statuses;
    if (!statuses?.size) return null;
    const reg = CONFIG.statusEffects ?? [];
    for (const id of statuses) {
        const entry = reg.find?.(s => s?.id === id);
        const c = parseHexColor(entry?.rimColor);
        if (c != null) return c;
    }
    return null;
}

/* Resolution order (matches the dock):
 *   1. GM rimColor override on any of the AE's status ids
 *   2. Family-derived color (flags first, then status ids)
 *   3. Default amber-hi for everything else (RAW statuses, custom AEs) */
function rimColorForEffect(effect) {
    const override = statusRimOverride(effect);
    if (override != null) return override;
    const family = familyForEffect(effect);
    if (family && FAMILY_RIM[family] != null) return FAMILY_RIM[family];
    return COLOR.amberHi;
}

/* Centralized filter — used by both _drawEffects (which sprites to create)
 * and _refreshEffects (recover the per-icon source effect by index when
 * `__wdmEffect` isn't attached). Foundry's default filter only catches
 * `showIcon: ALWAYS` plus `CONDITIONAL + isTemporary` — but the default
 * showIcon is CONDITIONAL, so non-temporary status AEs (status applied
 * without a duration) get filtered out. We additionally include ANY AE
 * that carries a status, unless it's explicitly NEVER, so every system
 * status is represented on the token. */
function filterDisplayedEffects(actor) {
    try {
        const SHOW_ICON = CONST.ACTIVE_EFFECT_SHOW_ICON;
        /* Author-hidden statuses: the status registry (built by
         * setup/statusEffects.mjs `buildStatusEffects`) may carry
         * `showOnToken: false` on any entry — set through the GM's
         * status effects editor. When ALL of an AE's statuses are
         * marked that way, the icon strip skips the AE entirely so
         * the token portrait ring stays clean. If the AE has NO
         * statuses at all (a plain buff / debuff AE with no status
         * id), the check falls through to the standard `showIcon`
         * pipeline below. */
        const allStatusesHidden = (e) => {
            if (!e.statuses?.size) return false;
            for (const statusId of e.statuses) {
                const entry = (CONFIG.statusEffects ?? []).find(s => s?.id === statusId);
                if (entry?.showOnToken !== false) return false;
            }
            return true;
        };
        return (actor?.appliedEffects ?? []).filter(e => {
            if (e.showIcon === SHOW_ICON.NEVER) return false;
            if (allStatusesHidden(e)) return false;
            if (e.showIcon === SHOW_ICON.ALWAYS) return true;
            if (e.showIcon === SHOW_ICON.CONDITIONAL && e.isTemporary) return true;
            if (e.statuses?.size > 0) return true;  // any status AE, even non-temporary
            return false;
        });
    } catch (_) {
        // appliedEffects can throw on a synthetic actor mid-teardown
        // (token deletion invalidates the actorData delta before the
        // last render pass completes). Return empty so the caller paints
        // an empty effect strip rather than crashing the canvas.
        return [];
    }
}

/* Stash the source effect on each icon sprite during _drawEffects so the
 * later _refreshEffects layout pass can recover the family/rim color for
 * the ring around the icon.
 *
 * IMPORTANT: this is `_drawEffects`, not the public `drawEffects`. Foundry's
 * public wrapper already runs us inside `_partialDraw` — calling
 * `_partialDraw` again here would nest promise chains and deadlock the
 * draw pipeline. Body only; no `_partialDraw` here. */
async function drawEffectsWitcher() {
    /* Destruction guard + top-level try/catch — Foundry may run a final
     * partial-draw on a token mid-teardown (e.g. an unlinked token being
     * deleted while it has inherited effects). `this.effects` is destroyed
     * first; accessing it throws inside the PIXI render loop and locks
     * the canvas (same failure shape as the old glow regression).
     * No exception from this function should ever escape to the renderer. */
    if (this.destroyed || !this.effects || this.effects.destroyed) return;
    try {
        this.effects.renderable = false;
        this.effects.removeChildren().forEach(c => { try { c.destroy(); } catch (_) {} });
        this.effects.bg = this.effects.addChild(new PIXI.Graphics());
        this.effects.bg.zIndex = -1;
        this.effects.overlay = null;

        const activeEffects = filterDisplayedEffects(this.actor);
        const overlayEffect = activeEffects.findLast(e => e.flags?.core?.overlay);

        const promises = [];
        for (const [i, effect] of activeEffects.entries()) {
            const promise = effect === overlayEffect
                ? this._drawOverlay(effect.img, effect.tint)
                : this._drawEffect(effect.img, effect.tint);
            promises.push(promise.then(icon => {
                /* The icon resolves asynchronously after texture load. By
                 * the time this resolves, the parent token may have been
                 * destroyed. Skip the attach if so. */
                if (!icon || this.destroyed || !this.effects || this.effects.destroyed) return;
                icon.zIndex = i;
                icon.__wdmEffect = effect;
                icon.__wdmEffectIndex = i;
            }).catch(() => null));
        }
        await Promise.allSettled(promises);

        if (this.destroyed || !this.effects || this.effects.destroyed) return;
        this.effects.sortChildren();
        this.effects.renderable = true;
        this.renderFlags.set({ refreshEffects: true });
    } catch (err) {
        console.warn(`${SYSTEM_ID} | _drawEffects swallowed (token teardown race)`, err);
    }
}

/* Lay out the icons + draw the circular chrome rim per cell. Three notable
 * differences from Foundry's default:
 *   1. Background per cell is a CIRCLE (void well + family-colored ring)
 *      rather than a rounded rectangle.
 *   2. Icons are anchor-centered and scaled INSIDE the rim so the sprite's
 *      square corners never poke past the circular frame.
 *   3. Rim color is recovered from `__wdmEffect` if attached, else from the
 *      same `filterDisplayedEffects(this.actor)` list by index — so an
 *      icon created through any path that bypasses our _drawEffects (mesh
 *      transitions, partial redraws) still gets the right family color. */
function refreshEffectsWitcher() {
    /* Same teardown guard as drawEffectsWitcher — bail if the container
     * (or any of its children) is already in destroy. Whole-body try/catch
     * so any unforeseen mid-teardown access can't propagate to PIXI. */
    if (this.destroyed || !this.effects || this.effects.destroyed) return;
    try {
        const s = canvas.dimensions?.uiScale ?? 1;
        /* Cell size derives from the token's rendered size (not a fixed
         * 20 * uiScale as before) so a 4-square token doesn't end up with
         * pip-sized status rings while a 1-square token gets normally-
         * sized ones. Target ~5 rings per column at the token's height,
         * clamped so tiny tokens don't disappear into single pixels and
         * huge tokens don't paint fist-sized rings. Grid size is also
         * factored in so a scene with a small grid gets proportionally
         * smaller icons. */
        const gridSize = canvas.grid?.size ?? 100;
        const tokenH   = this.document?.getSize?.().height ?? this.h ?? gridSize;
        const targetRowsPerToken = 5;
        const MIN_CELL = 18 * s;
        const MAX_CELL = 44 * s;
        const cell = Math.max(MIN_CELL, Math.min(MAX_CELL, tokenH / targetRowsPerToken));
        const rows = Math.max(1, Math.floor((tokenH / cell) + 1e-6));
        const bg = this.effects.bg?.clear?.();
        if (!bg) return;

    const filtered = filterDisplayedEffects(this.actor);
    const nonOverlayEffects = filtered.filter(e => !e.flags?.core?.overlay);


    /* Ring geometry — outer at the cell edge, stroke INWARD so the ring
     * itself doesn't push outside the cell. Inner clearance defines the
     * region the icon must fit inside. */
    const ringW    = 1.5 * s;
    const rOuter   = (cell / 2) - (0.5 * s);
    const rInner   = rOuter - ringW;
    /* Icon: scale to fit inside a circle of radius rInner. For a square of
     * side N to fit, N ≤ rInner × √2. We add a small extra inset so the
     * sprite content sits comfortably inside the rim, not flush against it. */
    const iconSide = Math.max(4, rInner * 1.414 * 0.92);

    let nonOverlayIdx = 0;
    let layoutSlot   = 0;
    for (const child of this.effects.children) {
        if (child === bg) continue;

        // Overlay — center on the token via getCenterPoint (matches Foundry
        // core). This is Foundry's own effects.overlay sprite, not the
        // health-state visuals (wound glow / dying skull) which live in a
        // separate `_wdmHealthVisuals` container — see health-state-visuals.mjs.
        if (child === this.effects.overlay) {
            const { width, height } = this.document.getSize();
            const overlaySize = Math.min(width * 0.6, height * 0.6);
            const center = this.document.getCenterPoint({ x: 0, y: 0 });
            child.anchor?.set?.(0.5, 0.5);
            child.width = child.height = overlaySize;
            child.position.set(Number(center?.x) || 0, Number(center?.y) || 0);
            continue;
        }

        // Place the icon centered in its cell, scaled inside the rim.
        const col = Math.floor(layoutSlot / rows);
        const row = layoutSlot % rows;
        const cellX = col * cell;
        const cellY = row * cell;
        const cx = cellX + cell / 2;
        const cy = cellY + cell / 2;

        child.anchor?.set?.(0.5, 0.5);
        child.width = child.height = iconSide;
        child.position?.set?.(cx, cy);

        // Recover the source effect for this cell.
        const sourceEffect = child.__wdmEffect
            ?? nonOverlayEffects[child.__wdmEffectIndex ?? nonOverlayIdx]
            ?? nonOverlayEffects[nonOverlayIdx];
        const rim = rimColorForEffect(sourceEffect);

        // Void well behind the icon.
        bg.beginFill(COLOR.void, 0.85).drawCircle(cx, cy, rOuter).endFill();
        // Family-colored ring, stroked inward.
        bg.lineStyle({ width: ringW, color: rim, alpha: 1, alignment: 1 })
          .drawCircle(cx, cy, rOuter)
          .lineStyle(0);

        nonOverlayIdx++;
        layoutSlot++;
    }
    } catch (err) {
        console.warn(`${SYSTEM_ID} | _refreshEffects swallowed (token teardown race)`, err);
    }
}

/* ─────────── selection glow (pre-rendered radial sprite, UNDER token) ─────────── */

/* PERFORMANCE: the selection indicator used to be a live GlowOverlayFilter on
 * every controlled token's mesh — a per-token, per-frame GPU glow shader that
 * tanked the framerate when box-selecting a group. Instead we bake ONE soft
 * radial amber texture (once, cached) and draw it as a plain PIXI.Sprite — a
 * single textured quad, ≈ free per frame. Same pattern as the disposition glow
 * and the wound glow.
 *
 * PLACEMENT: the sprite is parented into the occlusion BACKDROP — a primary-
 * group container synced one z-step BELOW the token mesh (see tickOcclusion-
 * Cascade → syncOcclusionBackdrop) — so the amber reads as a soft glow radiating
 * from UNDER the token, and inherits for free the mesh's position, occlusion,
 * alpha and visibility. It's a FILLED radial disc (not a ring): the centre is
 * hidden behind the portrait, so only the gentle outer spill shows — an
 * understated warm pool that says "selected" at a glance without distracting. */

/* TWO stacked sprites, each with its OWN scale so they tune independently:
 *   1. POOL — a soft FILLED radial pool at SELECTION_OVERLAY_SCALE. Reads as
 *      light radiating from UNDER the token (dense centre behind the portrait,
 *      fading well past the base). This is the wide, ambient part.
 *   2. RIM  — a thin BRIGHT gold ring at a SEPARATE, tighter SELECTION_RIM_SCALE
 *      so it hugs the token ring closely regardless of how wide the pool spills.
 * Lowering SELECTION_RIM_SCALE pulls the ring in toward the silhouette; the pool
 * stays put. */
const SELECTION_MARK     = "_wdmSelectionGlow";
const SELECTION_RIM_MARK = "_wdmSelectionRim";
const SELECTION_OVERLAY_SCALE = 1.5;    // POOL — wide soft under-glow
const SELECTION_RIM_SCALE     = 0.95;   // RIM  — hug close; lower = tighter to the token

let _selGlowTex = null;
function getSelectionGlowTexture() {
    if (_selGlowTex && !_selGlowTex.destroyed) return _selGlowTex;
    const size = 256;
    const cvs = document.createElement("canvas");
    cvs.width = cvs.height = size;
    const ctx = cvs.getContext("2d");
    const c = size / 2, outerR = size / 2;
    const grad = ctx.createRadialGradient(c, c, 0, c, c, outerR);
    /* Soft filled under-pool: warm, densest in the middle (behind the portrait),
     * gentle downslope by the token ring (~0.667 = 1/1.5), fading out past the
     * base. No rim here — the RIM sprite owns the edge. */
    grad.addColorStop(0.00,  "rgba(255, 200, 112, 0.42)");
    grad.addColorStop(0.45,  "rgba(255, 199, 110, 0.32)");
    grad.addColorStop(0.667, "rgba(255, 198, 108, 0.20)");
    grad.addColorStop(0.84,  "rgba(255, 197, 106, 0.07)");
    grad.addColorStop(1.00,  "rgba(255, 197, 106, 0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(c, c, outerR, 0, Math.PI * 2);
    ctx.fill();
    _selGlowTex = PIXI.Texture.from(cvs);
    return _selGlowTex;
}

let _selRimTex = null;
function getSelectionRimTexture() {
    if (_selRimTex && !_selRimTex.destroyed) return _selRimTex;
    const size = 256;
    const cvs = document.createElement("canvas");
    cvs.width = cvs.height = size;
    const ctx = cvs.getContext("2d");
    const c = size / 2, outerR = size / 2;
    /* A bright-gold ring FEATHERED on both sides (a radial gradient, not a hard
     * stroke) so the edge melts smoothly into the under-pool instead of ending
     * abruptly. Peaks at f ≈ 0.88 of the texture radius; on screen its radius =
     * f × SELECTION_RIM_SCALE × tokenRingRadius. The wide inner+outer falloff is
     * what gives the smooth rim→glow blend. */
    const grad = ctx.createRadialGradient(c, c, 0, c, c, outerR);
    grad.addColorStop(0.00, "rgba(255, 226, 158, 0)");
    grad.addColorStop(0.66, "rgba(255, 224, 152, 0)");
    grad.addColorStop(0.79, "rgba(255, 222, 148, 0.30)");   // inner feather
    grad.addColorStop(0.88, "rgba(255, 230, 166, 0.90)");   // ring peak
    grad.addColorStop(0.96, "rgba(255, 214, 140, 0.24)");   // outer feather
    grad.addColorStop(1.00, "rgba(255, 210, 130, 0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(c, c, outerR, 0, Math.PI * 2);
    ctx.fill();
    _selRimTex = PIXI.Texture.from(cvs);
    return _selRimTex;
}

/* Find a marked selection child wherever it lives (backdrop preferred). */
function _findSelChild(token, mark) {
    if (!token) return null;
    const backdrop = token[OCCLUSION_BACKDROP_MARK];
    const inB = backdrop?.children?.find?.(ch => ch?.[mark]);
    if (inB) return inB;
    return token.children?.find?.(ch => ch?.[mark]) ?? null;
}

/* Create (or re-home) a marked selection sprite in `parent`. */
function _ensureSelSprite(token, parent, mark, tex, name) {
    let s = _findSelChild(token, mark);
    if (!s || s.destroyed) {
        s = new PIXI.Sprite(tex);
        s[mark] = true;
        s.anchor.set(0.5);
        s.eventMode = "none";           // never intercept canvas interaction
        s.name = name;
    }
    if (s.parent !== parent) { try { s.parent?.removeChild?.(s); parent.addChild(s); } catch (_) {} }
    return s;
}

function applySelectionGlow(token) {
    if (!token || token.destroyed) return;
    /* SECRET disposition — no selection halo (reads as ambient art even to the
     * GM who selects it). */
    if (Number(token?.document?.disposition ?? 0) === -2) {
        const p = _findSelChild(token, SELECTION_MARK);     if (p) p.visible = false;
        const r = _findSelChild(token, SELECTION_RIM_MARK); if (r) r.visible = false;
        return;
    }
    const tw = Number(token.w) || 0, th = Number(token.h) || 0;
    if (tw <= 0 || th <= 0) return;

    /* Signature gate — this may fire every refreshToken. Both sprites are a pure
     * function of (footprint, texture scale); skip the work when unchanged and
     * both sprites are still alive + parented. */
    const texScale = tokenTextureScale(token);
    const sig = `${Math.round(tw)}:${Math.round(th)}:${texScale.toFixed(3)}`;
    const cp = token._wdmSelGlow, cr = token._wdmSelRim;
    if (token._wdmSelSig === sig
        && cp && !cp.destroyed && cp.parent
        && cr && !cr.destroyed && cr.parent) {
        cp.visible = true; cr.visible = true;
        return;
    }

    const backdrop = getOrCreateOcclusionBackdrop(token);
    const parent   = (backdrop && !backdrop.destroyed) ? backdrop : token;
    const ringDia  = Math.max(tw, th) * texScale;
    const cx = tw / 2, cy = th / 2;

    // Pool (wide, under the token) — added first so the rim renders over it.
    const pool = _ensureSelSprite(token, parent, SELECTION_MARK, getSelectionGlowTexture(), "wdm-selection-glow");
    const psize = ringDia * SELECTION_OVERLAY_SCALE;
    pool.width = pool.height = psize; pool.position.set(cx, cy); pool.visible = true;

    // Rim (thin bright ring) — its own tighter scale so it hugs the ring.
    const rim = _ensureSelSprite(token, parent, SELECTION_RIM_MARK, getSelectionRimTexture(), "wdm-selection-rim");
    const rsize = ringDia * SELECTION_RIM_SCALE;
    rim.width = rim.height = rsize; rim.position.set(cx, cy); rim.visible = true;

    token._wdmSelGlow = pool;
    token._wdmSelRim  = rim;
    token._wdmSelSig  = sig;
}

function removeSelectionGlow(token) {
    const p = _findSelChild(token, SELECTION_MARK);     if (p) p.visible = false;
    const r = _findSelChild(token, SELECTION_RIM_MARK); if (r) r.visible = false;
}

function registerSelectionGlow() {
    Hooks.on("controlToken", (token, controlled) => {
        try {
            if (controlled) applySelectionGlow(token);
            else removeSelectionGlow(token);
        } catch (err) {
            console.warn(`${SYSTEM_ID} | selection glow toggle failed`, err);
        }
    });
    /* Keep it sized + re-homed through refreshes / redraws for controlled tokens
     * (the backdrop can be rebuilt). Cheap: a boolean gate for the many
     * uncontrolled tokens; the signature gate skips redundant work for the few
     * controlled ones. */
    const reapply = (token) => { if (token?.controlled) { try { applySelectionGlow(token); } catch (_) {} } };
    Hooks.on("refreshToken", reapply);
    Hooks.on("drawToken",    reapply);
}

/* ─────────── surface culling helper ─────────── */

/* True when the token is currently being visually obscured by a Region
 * surface as far as Foundry's primary-group shader is concerned.
 *
 * The right ground-truth source is `canvas.masks.occlusion
 * .occludedSurfaces`: the LIVE set of surfaces that Foundry is drawing
 * to the occlusion mask alpha channel this frame (see
 * layers/masks/occlusion.mjs:69 for the getter and :195-225 for the
 * draw pass — surfaces here directly cause the shader to fade any
 * mesh whose pixel lies inside them). That's exactly what dims the
 * portrait + ring, so mirroring against the same set guarantees
 * decorations track the mesh: hidden when the mesh visibly fades,
 * shown when Foundry's shader isn't fading it.
 *
 * Uses the token's `getOcclusionTestPoints()` footprint — the same
 * one Foundry uses everywhere else for surface coverage — and counts
 * the token as obscured when EVERY test point is inside at least one
 * occluded surface's polygon tree. That matches "shader is fading
 * the whole silhouette" without kicking in on partial overlaps where
 * the mesh is still mostly bright.
 *
 * No level / elevation strip math required: the mask has already
 * filtered surfaces by (a) the currently viewed level, (b) the
 * `occlusion: true` flag, and (c) elevation-vs-viewer geometry per
 * `_updateOccludedSurfaces` (occlusion.mjs:277-331). If a surface is
 * in the set, it IS actively fading pixels through the shader — no
 * further gating needed. */
/* Matches Foundry's own `Token#testCulled` semantic (token.mjs:633):
 * only `culling: true` surfaces count as "hides the token entirely".
 * A `culling: false, occlusion: true` surface (fade-mode roof) fades
 * the mesh to `occludedAlpha` but leaves it visible — decorations
 * should stay visible with it. Using `occludedSurfaces` (which
 * contains ALL `occlusion: true` surfaces regardless of culling)
 * conflates the two and force-hides decorations during every fade-
 * reveal, which is the exact bug the user reported. */
/* Culling-surface list cache. `scene.getSurfaces({culling:true})` was called
 * once per token PER FRAME (from the occlusion ticker AND refreshFacingArrow),
 * i.e. up to 2·N calls/frame — pure redundancy, since the surface set only
 * changes when regions / tiles / the scene / the viewed level change. Cache it,
 * keyed on the viewed level so a level switch auto-misses, and invalidate on
 * the structural hooks below. The common case (no culling roofs on the scene)
 * then costs a single cached null-check per token instead of a fresh lookup. */
let _cullSurfaces = undefined;      // undefined = not yet computed this generation
let _cullSurfacesLevel = null;
export function invalidateCullSurfaceCache() { _cullSurfaces = undefined; _cullSurfacesLevel = null; }
function getCullingSurfaces() {
    const scene = canvas?.scene;
    const levelId = canvas?.level?.id;
    if (!scene?.getSurfaces || !levelId) return null;
    if (_cullSurfaces !== undefined && _cullSurfacesLevel === levelId) return _cullSurfaces;
    let s = null;
    try { s = scene.getSurfaces({level: levelId, culling: true}) ?? null; }
    catch (_) { s = null; }
    _cullSurfaces = s;
    _cullSurfacesLevel = levelId;
    return s;
}

export function isTokenObscuredBySurface(token) {
    const doc = token?.document;
    if (!doc) return false;

    const surfaces = getCullingSurfaces();
    if (!surfaces?.length) return false;

    let testPoints = null;
    try { testPoints = doc.getOcclusionTestPoints?.() ?? null; } catch (_) { return false; }
    if (!testPoints?.length) return false;

    const polyTrees = [];
    for (const surface of surfaces) {
        const tree = surface?.region?.polygonTree;
        if (tree?.testPoint) polyTrees.push(tree);
    }
    if (!polyTrees.length) return false;

    /* Every test point must be covered — matches `#testCulled`'s
     * "the token's whole footprint is inside a culling surface". */
    for (const point of testPoints) {
        if (!polyTrees.some(t => t.testPoint(point))) return false;
    }
    return true;
}

export const isTokenCulledBySurface = isTokenObscuredBySurface;

/* ─────────── prototype patching ─────────── */

function patchTokenPrototype() {
    const TokenCls = foundry?.canvas?.placeables?.Token;
    if (!TokenCls || TokenCls.prototype.__wdmStylePatched) return;

    TokenCls.prototype._refreshBorder     = refreshBorderWitcher;
    TokenCls.prototype._drawTargetArrows  = drawTargetArrowsWitcher;
    TokenCls.prototype._refreshTurnMarker = refreshTurnMarkerWitcher;
    TokenCls.prototype._drawEffects       = drawEffectsWitcher;
    TokenCls.prototype._refreshEffects    = refreshEffectsWitcher;

    /* Cascade `token.visible` to every decoration container the mesh
     * doesn't own. Foundry v14's `_refreshVisibility` only writes
     * `this.mesh.visible = this.visible && this.renderable`; the dead/
     * wounded overlay, the turn-marker orbit, target arrows, target
     * pips and the facing chevron are separate children whose
     * visibility isn't gated by `this.visible` — so a Levels-hidden
     * token (or a token behind a hidden region) still shows those
     * pieces poking through. Wrap the base _refreshVisibility and
     * mirror visibility onto every extra child. */
    const baseRefreshVisibility = TokenCls.prototype._refreshVisibility;
    TokenCls.prototype._refreshVisibility = function _refreshVisibilityWitcher() {
        const ret = baseRefreshVisibility?.call(this);
        /* Signals that hide decorations:
         *
         *   1. `!token.visible || !token.renderable` — Foundry's own
         *      visibility decision. `#testCulled` (token.mjs:633) sets
         *      `this.visible = false` when the token is fully hidden
         *      by a `culling: true` surface. LOS / wall culling / secret
         *      flag also lands here.
         *
         *   2. `isTokenCulledBySurface` — same `culling: true` test as
         *      #testCulled, catches the case where our reparented
         *      decorations (health visuals on the primary-group carrier)
         *      would otherwise miss Foundry's own visibility cascade
         *      because they're not children of the Token placeable.
         *
         * Explicitly NOT gated on `this.mesh.occluded`. A fade-reveal
         * (`occlusion: true, culling: false` surface — mesh renders at
         * `occludedAlpha` 0.5 while `mesh.occluded` is true) keeps the
         * mesh visible, so decorations must also stay visible per user
         * report: "when it fades to reveal the tokens under it, it does
         * not reveal those aswell, essentially hiding it when it
         * shouldnt be". */
        const on = this.visible && this.renderable;
        const surfaceCulled = isTokenCulledBySurface(this);
        const forceOff = !on || surfaceCulled;
        /* Cascade the visibility bit to every child that Foundry keeps
         * on the Token placeable. Foundry only writes `this.mesh.visible`
         * out of `_refreshVisibility`, but all the other decorations
         * (border, bars, nameplate, tooltip, levelIndicator, effects,
         * turnMarker, targetArrows, targetPips) are Token PIXI children
         * whose `.visible` is controlled independently — mostly by
         * `_refreshState` which only checks the `isSecret` flag. That
         * leaves them bleeding through when a wall, region, or the Levels
         * module hides the token itself.
         *
         * We flip them all in one pass. Each decoration keeps its own
         * secondary visibility gate (e.g. `border.visible` still respects
         * the hover/controlled logic in `_refreshState`) by ANDing rather
         * than overwriting — turning ON here doesn't force them on if
         * their own state said off; turning OFF here always wins. */
        const cascade = (child) => {
            if (!child) return;
            if (!forceOff) return;        /* leave the child's own state alone when the token is visible AND on the current level */
            child.visible = false;
        };
        cascade(this.border);
        cascade(this.bars);
        cascade(this.nameplate);
        cascade(this.tooltip);
        cascade(this.levelIndicator);
        cascade(this.effects);
        cascade(this.turnMarker);
        cascade(this.targetArrows);
        cascade(this.targetPips);
        cascade(this._wdmFacingArrow);
        /* Health-state visuals (wound glow / dying skull) — separate
         * container marked with `_wdmHealthVisuals`. May live on
         * either this token placeable (historical) or the primary-
         * group occlusion carrier (new). Search both. */
        const carrier = this[OCCLUSION_CARRIER_MARK];
        const healthVisuals = (carrier?.children?.find?.(ch => ch?._wdmHealthVisuals))
            ?? this.children?.find?.(ch => ch?._wdmHealthVisuals);
        cascade(healthVisuals);
        return ret;
    };

    /* `_refreshState` is where Foundry writes the individual `.visible`
     * flags for border / bars / nameplate / tooltip / levelIndicator /
     * effects / targetArrows / targetPips — always based on isSecret /
     * hover / controlled, never on `this.visible`. When it fires AFTER
     * `_refreshVisibility` (e.g. hover state changes on a cross-level
     * token, or Foundry pushes a state-only refresh), our cascade above
     * gets overwritten. Wrap it to re-run the same cascade so the
     * decorations stay hidden. */
    const baseRefreshState = TokenCls.prototype._refreshState;
    TokenCls.prototype._refreshState = function _refreshStateWitcher() {
        const ret = baseRefreshState?.call(this);
        const on = this.visible && this.renderable;
        const surfaceCulled = isTokenCulledBySurface(this);
        if (!on || surfaceCulled) {
            const hide = (child) => { if (child) child.visible = false; };
            hide(this.border);
            hide(this.bars);
            hide(this.nameplate);
            hide(this.tooltip);
            hide(this.levelIndicator);
            hide(this.effects);
            hide(this.turnMarker);
            hide(this.targetArrows);
            hide(this.targetPips);
            hide(this._wdmFacingArrow);
            const carrier = this[OCCLUSION_CARRIER_MARK];
            const healthVisuals = (carrier?.children?.find?.(ch => ch?._wdmHealthVisuals))
                ?? this.children?.find?.(ch => ch?._wdmHealthVisuals);
            hide(healthVisuals);
        }
        return ret;
    };

    TokenCls.prototype.__wdmStylePatched  = true;
}

/* ─────────── facing arrow ─────────── */

/* A small amber chevron pinned to the token's outer rim, pointing in the
 * direction of `token.document.rotation`. Always visible (not gated on
 * selection) so a quick glance reads any combatant's facing.
 *
 * Coordinate-system notes:
 *   - Token PIXI container's local origin is the top-left of the token's
 *     bounding box; the center is (w/2, h/2). We anchor the arrow there
 *     and rotate around it.
 *   - Foundry rotation: 0° = north (up), positive = clockwise.
 *   - PIXI rotation:    0° = east (right), positive = clockwise.
 *   - So `arrow.rotation = (doc.rotation - 90)` in radians lines a chevron
 *     drawn along the local +x axis up with Foundry's facing convention.
 */
const FACING_AMBER     = 0xc8a878; // amber-bright
const FACING_VOID      = 0x050402;
const FACING_INSET     = 1;        // pixels — tip sits just OUTSIDE the rim by this much
const FACING_TIP_LEN   = 8;        // chevron arm length (tip → base)
const FACING_HALF_WIDE = 5;        // chevron half-width at the base

function ensureFacingArrow(token) {
    if (token._wdmFacingArrow && !token._wdmFacingArrow.destroyed) {
        return token._wdmFacingArrow;
    }
    if (token.destroyed) return null;        // mid-teardown — don't create new children
    /* Add to the primary-group occlusion carrier instead of directly to
     * the token placeable. Carrier lives in `canvas.primary` at the
     * mesh's elevation / sort, so the facing arrow gets z-order
     * occluded by any higher-elevation surface (roof, ceiling) the
     * same way the mesh does — the whole point of the reparent. */
    const carrier = getOrCreateOcclusionCarrier(token);
    if (!carrier || carrier.destroyed) return null;
    const g = new PIXI.Graphics();
    g.eventMode = "none";
    carrier.addChild(g);
    token._wdmFacingArrow = g;
    return g;
}

function refreshFacingArrow(token) {
    if (!token || token.destroyed) return;
    try {
    const doc = token.document;
    if (!doc) return;
    /* SECRET disposition — bail immediately without drawing. The whole
     * point of SECRET is that the token should read as ambient scenery,
     * with zero "this is a token" cues (chevron, ring, chrome). Cheap
     * early-out so the occlusion-cascade ticker doesn't spend any work
     * on SECRET tokens frame-over-frame; also flips any existing arrow
     * to invisible so a disposition change from HOSTILE → SECRET clears
     * the last-frame arrow. */
    if (Number(doc.disposition ?? 0) === -2) {
        if (token._wdmFacingArrow && !token._wdmFacingArrow.destroyed) {
            token._wdmFacingArrow.visible = false;
        }
        return;
    }

    /* Per-token toggle from the TokenConfig Appearance tab (policy/
     * token-appearance-config.mjs). `flags.<sys>.facingArrow === false` hides
     * the chevron; default (undefined) shows it. */
    if (doc.getFlag?.(SYSTEM_ID, "facingArrow") === false) {
        if (token._wdmFacingArrow && !token._wdmFacingArrow.destroyed) {
            token._wdmFacingArrow.visible = false;
        }
        return;
    }
    /* Token footprint in pixels. Prefer the document's getSize() — it reflects
     * a multi-grid token's true size, so the arrow's center anchor AND rim
     * radius scale with the token. token.w/token.h don't reliably track a
     * resized token here, which left the arrow anchored + sized as if the token
     * were 1×1 (chevron stuck near the top-left cell of a big token). Same
     * authoritative size source the effects-grid layout uses. */
    const _sz = token.document?.getSize?.();
    const w = Number(_sz?.width)  || token.w || 0;
    const h = Number(_sz?.height) || token.h || 0;
    if (!w || !h) return;

    /* Visibility + occlusion gate — same rule as the general
     * decoration cascade in patchTokenPrototype. Skip drawing (and
     * flip existing arrow to invisible) when either Foundry has
     * decided the token isn't visible, OR the token's mesh is
     * currently faded out by a surface / roof / level (mesh.occluded
     * — the shader-level fade the cascade needs to mirror). The
     * cascade in _refreshVisibility / _refreshState already hides
     * an existing arrow when those flags flip; this gate stops the
     * refreshToken pass from re-showing it before the next
     * visibility cycle. */
    const hidden = !token.visible || !token.renderable
        || !!token.mesh?.occluded
        || isTokenCulledBySurface(token);
    if (hidden) {
        if (token._wdmFacingArrow && !token._wdmFacingArrow.destroyed) {
            token._wdmFacingArrow.visible = false;
        }
        return;
    }

    const arrow = ensureFacingArrow(token);
    if (!arrow || arrow.destroyed) return;   // ensureFacingArrow ran during teardown
    arrow.visible = true;

    /* Geometry gate. The chevron's shape/position/rotation is a pure function
     * of (rotation, footprint, texture scale). This runs every frame from the
     * occlusion ticker, but the geometry only actually changes while the token
     * is ROTATING or being resized — panning, hovering, and idle frames leave
     * it identical. Skip the clear()+drawPolygon rebuild (the real cost) when
     * the signature is unchanged; the already-drawn arrow stays correct. On the
     * hidden path we only flip `visible=false` (never clearing the sig), so a
     * re-show with the same geometry reuses the existing graphics. */
    const texScale = tokenTextureScale(token);
    const _rotDeg = Number(doc.rotation) || 0;
    const _sig = `${_rotDeg}:${Math.round(w)}:${Math.round(h)}:${texScale.toFixed(3)}`;
    if (token._wdmArrowSig === _sig) return;
    token._wdmArrowSig = _sig;

    arrow.clear();
    arrow.position.set(w / 2, h / 2);
    /* Foundry's rotation maps to the BACK of the token in this system
     * (the user-perceived facing is the opposite). Add 90° instead of
     * subtracting so a chevron drawn along +x in local space ends up
     * pointing TOWARD the facing direction the user sees. */
    arrow.rotation = (_rotDeg + 90) * (Math.PI / 180);

    // Place the tip at radius = (max side)/2 + small overshoot so it sits
    // ON the rim. Bigger tokens get a slightly bigger chevron to keep
    // legibility consistent — but cap so it doesn't dominate huge tokens.
    // The arrow lives in the occlusion carrier (scale 1, so it rotates
    // with the world) — unlike the counter-rot wrapper it is NOT scaled
    // for us, so fold the token's texture scale in here: the radius sits
    // on the VISIBLE ring and the chevron grows with the art.
    const r       = (Math.max(w, h) / 2) * texScale;
    const scale   = Math.min(1.4, Math.max(0.85, r / 60)) * texScale;
    const tipLen  = FACING_TIP_LEN   * scale;
    const halfW   = FACING_HALF_WIDE * scale;
    const tipX    = r + FACING_INSET;
    const baseX   = tipX - tipLen;

    // Dark underlay for legibility against bright maps.
    arrow.beginFill(FACING_VOID, 0.85)
         .drawPolygon([
             tipX + 1, 0,
             baseX - 1,  halfW + 1,
             baseX - 1, -(halfW + 1)
         ])
         .endFill();

    // Amber chevron on top.
    arrow.beginFill(FACING_AMBER, 1)
         .drawPolygon([
             tipX, 0,
             baseX,  halfW,
             baseX, -halfW
         ])
         .endFill();
    } catch (err) {
        console.warn(`${SYSTEM_ID} | refreshFacingArrow swallowed (token teardown race)`, err);
    }
}

function destroyFacingArrow(token) {
    const g = token?._wdmFacingArrow;
    if (!g) return;
    try { g.destroy({ children: true }); } catch (_) { /* already gone */ }
    token._wdmFacingArrow = null;
}

function registerFacingArrow() {
    Hooks.on("drawToken", (token) => {
        try { refreshFacingArrow(token); }
        catch (err) { console.warn(`${SYSTEM_ID} | facing arrow draw failed`, err); }
    });
    Hooks.on("refreshToken", (token) => {
        try { refreshFacingArrow(token); }
        catch (err) { console.warn(`${SYSTEM_ID} | facing arrow refresh failed`, err); }
    });
    Hooks.on("destroyToken", (token) => {
        try { destroyFacingArrow(token); }
        catch (_) { /* already destroyed */ }
    });
}

/* ─────────── carrier lifecycle ─────────── */

/* Wire the primary-group occlusion carrier into the token lifecycle.
 * On draw: create the carrier and move every decoration container
 * (Foundry's + ours) into it, so from now on they render at the
 * mesh's elevation/sort in canvas.primary — z-order occluded by any
 * higher-elevation surface. On refresh: nothing to do here; the
 * per-frame ticker (registerOcclusionCascade) syncs the carrier's
 * transform every tick. On destroy: tear the carrier down cleanly. */
function registerOcclusionCarrier() {
    Hooks.on("drawToken", (token) => {
        try {
            getOrCreateOcclusionCarrier(token);
            reparentDecorationsToCarrier(token);
            syncOcclusionCarrier(token);
        } catch (err) { console.warn(`${SYSTEM_ID} | occlusion carrier draw failed`, err); }
    });
    Hooks.on("refreshToken", (token) => {
        /* Foundry may rebuild `token.effects` mid-flight (our
         * _drawEffects override tears down and rebuilds children on
         * every full redraw). The container reference on Token stays
         * the same but if some path re-parented it back to the
         * placeable, reparent it. Idempotent — no-op when nothing
         * moved. */
        try {
            reparentDecorationsToCarrier(token);
            syncOcclusionCarrier(token);
        } catch (err) { console.warn(`${SYSTEM_ID} | occlusion carrier refresh failed`, err); }
    });
    Hooks.on("destroyToken", (token) => {
        try { destroyOcclusionCarrier(token); }
        catch (_) { /* already destroyed */ }
        try { destroyOcclusionBackdrop(token); }
        catch (_) { /* already destroyed */ }
    });
}

/* ─────────── ticker for target pulse ─────────── */

let _targetTickerHooked = false;
function registerTargetPulse() {
    if (_targetTickerHooked) return;
    // canvasReady fires per scene — register once when the canvas exists, then
    // never again. canvas.app.ticker persists across scene changes.
    Hooks.once("canvasReady", () => {
        try {
            canvas.app?.ticker?.add(tickTargetPulse);
            _targetTickerHooked = true;
        } catch (err) {
            console.warn(`${SYSTEM_ID} | target pulse ticker failed`, err);
        }
    });
}

/* ─────────── occlusion→refresh bridge ─────────── */

/* Foundry sets `token.mesh.occluded` via `debounceSetOcclusion` in
 * canvas/layers/masks/occlusion.mjs when a surface / roof / level fades
 * the mesh. That path assigns the flag directly and does NOT set any
 * Token render flag, so `_refreshVisibility` / `_refreshState` never
 * fire on occlusion transitions and the cascade in `patchTokenPrototype`
 * doesn't re-run — the status rings / wound overlay / facing arrow
 * stay bright even as the portrait fades out through a roof.
 *
 * A cheap ticker watches each token's `mesh.occluded` state and, when
 * it flips, fires refreshState + refreshVisibility flags on the Token
 * placeable. That re-runs the cascade with the new occlusion signal
 * and every decoration follows the same visibility pipeline as the
 * mesh itself. Runs every frame, but the body is just a boolean
 * compare per token — cheap in the same order as the target-arrow
 * pulse loop that already ticks per-frame here.  */
let _occlusionTickerHooked = false;

/* ─────────── viewport culling ───────────────────────────────────────────
 * The per-frame token pass below does real work per token — transform syncs
 * and an actual redraw of the facing chevron. None of it is observable for a
 * token nobody can see, so tokens outside the view are skipped.
 *
 * The margin is deliberately generous (one viewport-eighth plus two grid
 * squares). Culling exactly at the screen edge means a token is first synced
 * on the frame it becomes visible, and our ticker can run AFTER the render for
 * that frame — which shows one stale frame as it slides in. Padding the test
 * means it has been syncing for many frames before it is ever on screen.
 *
 * Re-entry is self-healing: the bounds test runs every frame, so the frame a
 * token comes back inside the padded box it resumes full syncing, and the
 * occlusion-state compare below notices any transition it slept through.
 */
function _wdmViewBounds() {
    const stage = canvas?.stage, renderer = canvas?.app?.renderer;
    if (!stage || !renderer) return null;
    try {
        const wt = stage.worldTransform;
        const tl = wt.applyInverse(new PIXI.Point(0, 0));
        const br = wt.applyInverse(new PIXI.Point(renderer.screen.width, renderer.screen.height));
        const tr = wt.applyInverse(new PIXI.Point(renderer.screen.width, 0));
        const bl = wt.applyInverse(new PIXI.Point(0, renderer.screen.height));
        /* All four corners: under a rotated stage the axis-aligned box of the
         * two opposite corners is NOT the visible region. */
        let left = Math.min(tl.x, br.x, tr.x, bl.x), right = Math.max(tl.x, br.x, tr.x, bl.x);
        let top  = Math.min(tl.y, br.y, tr.y, bl.y), bottom = Math.max(tl.y, br.y, tr.y, bl.y);
        const grid = Number(canvas?.grid?.size) || 100;
        const padX = (right - left) / 8 + grid * 2;
        const padY = (bottom - top) / 8 + grid * 2;
        return { left: left - padX, right: right + padX, top: top - padY, bottom: bottom + padY };
    } catch (_) { return null; }
}

function _wdmTokenInView(token, b) {
    if (!b) return true;                       /* no bounds -> never cull */
    const cx = token.center?.x, cy = token.center?.y;
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return true;
    const rx = (Number(token.w) || 0) / 2, ry = (Number(token.h) || 0) / 2;
    return (cx + rx) >= b.left && (cx - rx) <= b.right
        && (cy + ry) >= b.top  && (cy - ry) <= b.bottom;
}

function tickOcclusionCascade() {
    const tokens = canvas.tokens?.placeables;
    if (!tokens?.length) return;
    /* Computed ONCE per tick — it is the same box for every token. */
    const view = _wdmViewBounds();
    for (const token of tokens) {
        if (!token || token.destroyed) continue;
        if (!_wdmTokenInView(token, view)) continue;
        /* Sync the primary-group carrier's transform + sort keys to
         * the mesh EVERY frame. This is the core of the reparent
         * fix — the carrier lives in canvas.primary at the same
         * elevation/sortLayer/sort as the mesh, so higher-elevation
         * surfaces cover it (and every decoration inside it) in the
         * same z-order pass that covers the mesh. */
        syncOcclusionCarrier(token);
        /* Behind-the-mesh backdrop (the disposition glow lives here so it
         * renders under the portrait + ring). Cheap early-return when the
         * token has no backdrop, which is most of them. */
        syncOcclusionBackdrop(token);
        /* Sync the counter-rotation wrapper's transform every frame:
         * pivot + position at token center, rotation at
         * `-canvas.stage.rotation`. Cheap (a few writes) but
         * essential — without it, bars / nameplate / tooltip stay
         * pinned to their pre-rotation local positions and drift
         * away from the token as the immersive camera turns. */
        syncCounterRotWrapper(token);
        /* Per-frame facing-arrow refresh. Foundry's rotation animation
         * (`token.animate` / `_onAnimationUpdate`) interpolates
         * `doc.rotation` per frame and fires `refreshRotation`, but the
         * `refreshToken` hook that our `refreshFacingArrow` listens on
         * lands one render pass behind — the arrow visibly lags the
         * portrait. Calling `refreshFacingArrow` directly here — same
         * cadence as the mesh — keeps the chevron glued to the sprite
         * through the whole rotation animation. Cheap: draws a few
         * lines. */
        try { refreshFacingArrow(token); }
        catch (_) { /* teardown race — nothing to draw */ }
        /* Legacy visibility-signal ticker kept as a defence-in-depth
         * cascade — if for any reason a decoration didn't end up in
         * the carrier (mid-teardown races, third-party module adding
         * its own child, etc.), the state cascade still hides it. */
        const curOccluded = !!token.mesh?.occluded;
        const curCulled   = isTokenCulledBySurface(token);
        const changed = (curOccluded !== !!token._wdmLastOccluded)
                     || (curCulled   !== !!token._wdmLastCulled);
        if (changed) {
            token._wdmLastOccluded = curOccluded;
            token._wdmLastCulled   = curCulled;
            try { token.renderFlags?.set?.({refreshState: true, refreshVisibility: true}); }
            catch (_) { /* teardown race — nothing to refresh */ }
        }
    }
}
function registerOcclusionCascade() {
    if (_occlusionTickerHooked) return;
    Hooks.once("canvasReady", () => {
        try {
            canvas.app?.ticker?.add(tickOcclusionCascade);
            _occlusionTickerHooked = true;
        } catch (err) {
            console.warn(`${SYSTEM_ID} | occlusion cascade ticker failed`, err);
        }
    });
    /* Invalidate the cached culling-surface list on any structural change that
     * could add / move / remove a culling surface. Surfaces derive from regions
     * and overhead tiles; the scene doc carries level/environment. Level switches
     * are handled by the level-keyed cache miss inside getCullingSurfaces(). */
    for (const h of ["canvasReady", "updateScene",
                     "createRegion", "updateRegion", "deleteRegion",
                     "createTile",   "updateTile",   "deleteTile"]) {
        Hooks.on(h, invalidateCullSurfaceCache);
    }
}

/* ─────────── entry point ─────────── */

/* ─────────── canvas-ruler outline color (drag path) ─────────── */

/* Subclass Foundry's TokenRuler to recolor the dashed-line OUTLINE from
 * black to amber-dim. The inner dash colour is set per-action by Foundry
 * (and we don't touch that), but the outline is what reads as "the line
 * is dark" — switching it to amber pulls the whole path into the chrome
 * palette without disturbing Foundry's per-action semantics. */
function registerCanvasRulerStyle() {
    const TokenRulerCls = foundry?.canvas?.placeables?.tokens?.TokenRuler
        ?? CONFIG?.Token?.rulerClass;
    if (!TokenRulerCls) return;

    class WitcherTokenRuler extends TokenRulerCls {
        /** @override */
        _configureOutline() {
            const scale = canvas.dimensions?.uiScale ?? 1;
            return { thickness: 1.5 * scale, color: COLOR.amberDim };
        }
    }

    if (CONFIG?.Token) CONFIG.Token.rulerClass = WitcherTokenRuler;
}

export function registerWitcherTokenStyle() {
    try { applyDispositionColors(); } catch (err) { console.warn(`${SYSTEM_ID} | dispositionColors failed`, err); }
    try { patchTokenPrototype(); }   catch (err) { console.warn(`${SYSTEM_ID} | prototype patch failed`, err); }
    try { registerOcclusionCarrier(); } catch (err) { console.warn(`${SYSTEM_ID} | occlusion carrier failed`, err); }
    try { registerTargetPulse(); }   catch (err) { console.warn(`${SYSTEM_ID} | target pulse failed`, err); }
    try { registerOcclusionCascade(); } catch (err) { console.warn(`${SYSTEM_ID} | occlusion cascade failed`, err); }
    try { registerSelectionGlow(); } catch (err) { console.warn(`${SYSTEM_ID} | selection glow failed`, err); }
    try { registerFacingArrow(); }   catch (err) { console.warn(`${SYSTEM_ID} | facing arrow failed`, err); }
    try { registerCanvasRulerStyle(); } catch (err) { console.warn(`${SYSTEM_ID} | canvas ruler style failed`, err); }
}
