/**
 * Witcher Token Style — chrome-themed restyle of Foundry's PIXI canvas
 * overlays that decorate tokens. Everything below shares the dock / HUD /
 * character-panel visual language (muted amber, hairline strokes, dark
 * underlay for contrast):
 *
 *   1. Selection           (controlled tokens)
 *      - The default colored rectangle border is suppressed. Instead a
 *        golden GlowOverlayFilter is added to the token's mesh while
 *        controlled, removed on deselect.
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

/* No rectangle — selection is communicated by the golden glow filter applied
 * to the token mesh (see registerSelectionGlow). _refreshBorder still needs
 * to exist (Foundry sets border.visible / border.tint elsewhere) but we just
 * clear it. Hover-only border drawing was intentionally dropped along with
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

/* PIXI.Graphics-based replacement for TokenTurnMarker. A static amber
 * hairline ring sits just outside the token, with a single short
 * highlight arc that orbits the ring once every couple of seconds. The
 * single-arc indicator deliberately avoids any multi-fold rotational
 * symmetry. Sized off the token's width so it scales with token size
 * and zoom; centered on the token via `_centerOnToken()`. */
class WitcherTurnMarker extends PIXI.Container {
    constructor(token) {
        super();
        this.token = token;
        this.zIndex = -Infinity;
        this.staticRing   = this.addChild(new PIXI.Graphics());
        this.orbiterArc   = this.addChild(new PIXI.Graphics());
        this._drawn = false;
    }

    /* Foundry's Token uses top-left as its local origin (Token.position is
     * the document x/y); the turn marker is added as a child, so to center
     * it on the token we offset by half the token's width/height. Re-applied
     * on each draw() to track size changes. */
    _centerOnToken() {
        const t = this.token;
        if (!t) return;
        this.position.set((t.w ?? 0) / 2, (t.h ?? 0) / 2);
    }

    /** Build the static ring once; sized to the token. */
    async draw() {
        if (!this.token?.w) return;
        this._centerOnToken();
        const sz = this.token.w;
        const r = sz * 0.58;
        this.staticRing.clear();
        // Dark underlay for contrast
        this.staticRing.lineStyle({ width: 4, color: COLOR.void, alpha: 0.55 });
        this.staticRing.drawCircle(0, 0, r);
        // Amber hairline
        this.staticRing.lineStyle({ width: 2, color: COLOR.amberDim, alpha: 0.85 });
        this.staticRing.drawCircle(0, 0, r);
        this._drawn = true;
    }

    /** Per-tick animation: one short bright arc orbiting the ring. */
    animate(/* deltaTime */) {
        if (!this._drawn || !this.visible || !this.token?.w) return;
        const t = canvas.app.ticker.lastTime;
        const sz = this.token.w;
        const r = sz * 0.58;

        // One full revolution every ~2.8s, a single ~36° arc — no rotational
        // symmetry, so it just reads as a moving highlight on the ring.
        const spin = (t * 0.00055) % (Math.PI * 2);
        const arcSpan = Math.PI / 5;

        this.orbiterArc.clear();
        this.orbiterArc.lineStyle({
            width: 3, color: COLOR.amberBright, alpha: 1,
            cap: PIXI.LINE_CAP.ROUND
        });
        this.orbiterArc.arc(0, 0, r, spin, spin + arcSpan);

        // Gentle alpha pulse on the whole container.
        this.alpha = 0.75 + 0.20 * (0.5 + 0.5 * Math.sin(t * 0.0024));
    }

    /** Mirror Foundry's destroy() so child graphics tear down cleanly. */
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
            this.turnMarker = this.addChildAt(new WitcherTurnMarker(this), 0);
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
    "gorged", "full", "fed", "peckish", "hungry", "famished",
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
        return (actor?.appliedEffects ?? []).filter(e => {
            if (e.showIcon === SHOW_ICON.NEVER) return false;
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
        const cell = 20 * s;
        const rows = Math.max(1, Math.floor(((this.document?.getSize?.().height ?? this.h) / cell) + 1e-6));
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

        // Overlay — preserve Foundry's centered, large rendering.
        if (child === this.effects.overlay) {
            const { width, height } = this.document.getSize();
            const overlaySize = Math.min(width * 0.6, height * 0.6);
            child.width = child.height = overlaySize;
            child.position = this.document.getCenterPoint({ x: 0, y: 0 });
            child.anchor.set(0.5, 0.5);
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

/* ─────────── selection dropglow ─────────── */

/* Golden glow via Foundry's built-in GlowOverlayFilter — applied directly
 * to `token.mesh.filters`. The filter reads the mesh's alpha and paints a
 * soft amber halo around the silhouette, so it follows the token shape
 * rather than a bounding rectangle. No canvas-layer children are added
 * (the previous sprite-in-canvas.primary approach corrupted the primary
 * group's sort pipeline and broke canvas interaction).
 *
 * Filters live on the sprite/mesh itself, which renders in `canvas.primary`
 * — so the glow naturally sits in the same Z-band as the token, under
 * lighting + effects layers above. */

const _selectionFilters = new WeakMap();

const GLOW_COLOR    = [168/255, 132/255,  80/255, 0.5]; // amber (#a88450) at 50% — darker than amber-hi, warmer orange tone
/* outerStrength is multiplied by `canvas.stage.worldTransform.d` (zoom) in
 * the filter's apply() before being sent to the shader, so a "1" here is
 * already a real, visible halo at default zoom. Going much above ~1.5
 * saturates the alpha curve and the glow stops looking like a drop-shadow
 * halo — it turns into a solid amber slab around the silhouette. */
const GLOW_OUTER    = 1.2;
const GLOW_INNER    = 0;     // 0 keeps the sprite interior fully untouched
/* Larger distance spreads the halo over more pixels — the alpha curve has
 * the same shape but is stretched, so the falloff reads softer (the eye
 * sees a gentler gradient). Shader cost is O(distance × angleSteps), so
 * we also raise quality slightly to keep the gradient smooth at the new
 * spread without exploding sample count. */
const GLOW_DISTANCE = 38;
const GLOW_QUALITY  = 0.4;   // smoothness; lower=fewer rays, higher=smoother
const GLOW_PADDING  = 56;    // room for the wider halo to render past the mesh bounds (≥ distance + buffer)

function buildSelectionGlow() {
    const FilterCls = foundry?.canvas?.rendering?.filters?.GlowOverlayFilter;
    if (!FilterCls) return null;
    // GlowOverlayFilter compiles its fragment shader at construction time
    // baking `quality` + `distance` in as GLSL constants — `new FilterCls()`
    // skips that and leaves the shader without a working glow loop. The
    // static `.create({...})` factory is the only correct way to build it.
    const f = FilterCls.create({
        glowColor: GLOW_COLOR,
        distance: GLOW_DISTANCE,
        quality:  GLOW_QUALITY,
        knockout: false,   // keep the sprite visible inside the halo
        alpha:    0.5
    });
    f.outerStrength = GLOW_OUTER;
    f.innerStrength = GLOW_INNER;
    f.padding       = GLOW_PADDING;
    f.animated      = false;
    return f;
}

/* Ensure the filter is in the mesh's filters array. Only mutates the array
 * if the filter isn't already present, so we never reassign mesh.filters
 * mid-frame and never trigger PIXI to rebuild its filter render targets
 * for a no-op. */
function ensureFilterAttached(mesh, f) {
    if (!mesh || !f) return;
    if (mesh.filters?.includes(f)) return;
    mesh.filters = mesh.filters ? [...mesh.filters, f] : [f];
}

function applySelectionGlow(token) {
    const mesh = token?.mesh;
    if (!mesh) return;
    let f = _selectionFilters.get(token);
    if (!f) {
        f = buildSelectionGlow();
        if (!f) return;
        _selectionFilters.set(token, f);
    }
    ensureFilterAttached(mesh, f);
    f.enabled = true;
}

function removeSelectionGlow(token) {
    const f = _selectionFilters.get(token);
    if (!f) return;
    // Don't mutate the filters array — just disable the filter. Avoids
    // racing PIXI's render loop, which is what was breaking canvas
    // interaction on scale changes.
    f.enabled = false;
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
    /* No refreshToken handler. A scale change fires refreshToken many
     * times per second; re-applying / re-assigning mesh.filters during
     * those frames was corrupting PIXI's render state and locking the
     * canvas (no pan, no click). The filter is attached once when the
     * token becomes controlled and stays attached (just toggled via
     * `enabled`) for the rest of the token's lifetime. */
}

/* ─────────── prototype patching ─────────── */

function patchTokenPrototype() {
    const TokenCls = foundry?.canvas?.placeables?.Token;
    if (!TokenCls || TokenCls.prototype.__wdmStylePatched) return;

    TokenCls.prototype._refreshBorder     = refreshBorderWitcher;
    TokenCls.prototype._drawTargetArrows  = drawTargetArrowsWitcher;
    TokenCls.prototype._refreshTurnMarker = refreshTurnMarkerWitcher;
    TokenCls.prototype._drawEffects       = drawEffectsWitcher;
    TokenCls.prototype._refreshEffects    = refreshEffectsWitcher;
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
    const g = new PIXI.Graphics();
    g.eventMode = "none";
    // Add as a child of the Token container so it transforms with the token
    // (visibility, hidden, etc. are inherited) and renders in the interface
    // layer alongside the border / nameplate.
    token.addChild(g);
    token._wdmFacingArrow = g;
    return g;
}

function refreshFacingArrow(token) {
    if (!token || token.destroyed) return;
    try {
    const doc = token.document;
    if (!doc) return;
    const w = token.w ?? 0;
    const h = token.h ?? 0;
    if (!w || !h) return;

    const arrow = ensureFacingArrow(token);
    if (!arrow || arrow.destroyed) return;   // ensureFacingArrow ran during teardown
    arrow.clear();
    arrow.position.set(w / 2, h / 2);
    /* Foundry's rotation maps to the BACK of the token in this system
     * (the user-perceived facing is the opposite). Add 90° instead of
     * subtracting so a chevron drawn along +x in local space ends up
     * pointing TOWARD the facing direction the user sees. */
    arrow.rotation = ((Number(doc.rotation) || 0) + 90) * (Math.PI / 180);

    // Place the tip at radius = (max side)/2 + small overshoot so it sits
    // ON the rim. Bigger tokens get a slightly bigger chevron to keep
    // legibility consistent — but cap so it doesn't dominate huge tokens.
    const r       = Math.max(w, h) / 2;
    const scale   = Math.min(1.4, Math.max(0.85, r / 60));
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
    try { registerTargetPulse(); }   catch (err) { console.warn(`${SYSTEM_ID} | target pulse failed`, err); }
    try { registerSelectionGlow(); } catch (err) { console.warn(`${SYSTEM_ID} | selection glow failed`, err); }
    try { registerFacingArrow(); }   catch (err) { console.warn(`${SYSTEM_ID} | facing arrow failed`, err); }
    try { registerCanvasRulerStyle(); } catch (err) { console.warn(`${SYSTEM_ID} | canvas ruler style failed`, err); }
}
