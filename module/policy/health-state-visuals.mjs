/**
 * Health-state token visual treatment.
 *
 * Reads the actor's prepared `system.healthState` and draws PIXI
 * overlays into a per-token container. Never replaces or filters the
 * token mesh itself — the dynamic ring / selection border / health
 * bars all keep their native colors.
 *
 *   Wounded (HP < woundThreshold, Core p.156)
 *     - Inner red glow: a cached radial-gradient sprite (transparent
 *       center → dark red at edge) clipped to the token disk by a
 *       circular mask. No mesh filter.
 *
 *   Dying (HP ≤ 0, Core p.162)  — supersedes wounded
 *     - Inner-disc grayscale: a clone of the portrait sprite with a
 *       pure-luminance ColorMatrixFilter, masked to the token disk
 *       (insets a couple pixels so the ring isn't touched).
 *     - Semi-transparent 💀 centered at 19% alpha.
 *
 * Wired on drawToken / refreshToken / updateActor (so remote HP
 * changes on other clients still refresh the local visual).
 */

import { isTokenCulledBySurface, getOrCreateOcclusionCarrier, getOrCreateCounterRotWrapper } from "./witcher-token-style.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const VISUAL_MARK = "_wdmHealthVisuals";
const FILTER_MARK = "_wdmHealthFilter";

/* Portrait-disk radius as a fraction of the grid footprint radius.
 *
 * The health overlays live in the counter-rotation wrapper, which is already
 * scaled by the token's texture scale, so radii here are in raw FOOTPRINT
 * units. Foundry's dynamic-ring frame occupies the outer band of the
 * footprint — the actual portrait ("subject") is drawn scaled DOWN to fit
 * inside the ring. Masking an overlay out to (footprint − a few px) therefore
 * paints it across the ring band, so the wound haze / dying grayscale spill
 * onto and past the metal ring.
 *
 * Clip both overlays to this inner portrait disk instead. 0.80 keeps them
 * comfortably inside the ring for the default ring styles (frame ≈ outer 20%);
 * the glow gradient already fades to 0 at the sprite edge so there's no hard
 * rim where the disk ends. */
const RING_INNER_FRAC = 0.80;

/* Rec.601 luminance weights — pure desaturation (saturation 0) with no
 * midtone lift. Used to BAKE the dying grayscale portrait ONCE into a
 * RenderTexture (see bakeGrayscaleTexture); the displayed sprite then carries
 * no live filter. */
const LUMINANCE_MATRIX = [
    0.299, 0.587, 0.114, 0, 0,
    0.299, 0.587, 0.114, 0, 0,
    0.299, 0.587, 0.114, 0, 0,
    0,     0,     0,     1, 0
];

function readHealthState(token) {
    return token?.actor?.system?.healthState ?? { dying: false, wounded: false };
}

/* Locate our overlay container across ALL possible parents. The
 * container has migrated across three homes over time:
 *   1. Original — direct child of the Token placeable (token.children)
 *   2. Post-occlusion-carrier reparent — direct child of the primary-
 *      group occlusion carrier (`_wdmOcclusionCarrier`)
 *   3. Post-counter-rotation refactor — child of the counter-rotation
 *      wrapper (`_wdmCounterRotWrapper`), which itself lives inside
 *      the occlusion carrier so the health visuals stay
 *      screen-upright when the immersive camera rotates the world.
 *
 * BUG this fixes: `findOverlayContainer` only checked (1) and (2)
 * after the (3) refactor moved containers into the wrapper. Miss:
 * `clearVisuals` couldn't find the old container to destroy it, so a
 * new one got created and stacked on top each refresh — the "wound
 * glow keeps getting thicker" symptom, and never went away on heal
 * because clear was a no-op. Search the wrapper FIRST since that's
 * the current home. */
function findOverlayContainer(token) {
    if (!token) return null;
    const wrapper = token._wdmCounterRotWrapper;
    const inWrapper = wrapper?.children?.find?.(ch => ch?.[VISUAL_MARK]);
    if (inWrapper) return inWrapper;
    const carrier = token._wdmOcclusionCarrier;
    const inCarrier = carrier?.children?.find?.(ch => ch?.[VISUAL_MARK]);
    if (inCarrier) return inCarrier;
    return token.children?.find?.(ch => ch?.[VISUAL_MARK]) ?? null;
}

/* The primary-group PIXI tree we draw into. We stash a single container
 * so all our graphics are easy to find + dispose. Adding to the
 * counter-rotation wrapper (child of the occlusion carrier, which
 * itself is a canvas.primary child) means the wound glow / dying skull
 * get BOTH z-order occluded by higher-elevation surfaces AND
 * counter-rotated to stay screen-upright during immersive camera
 * rotation. Falls back to the carrier — then to the placeable — if
 * the wrapper isn't ready yet (early draw race). */
function getOrCreateOverlayContainer(token) {
    let c = findOverlayContainer(token);
    if (c && !c.destroyed) return c;
    c = new PIXI.Container();
    c[VISUAL_MARK] = true;
    c.zIndex = 100;
    c.sortableChildren = true;
    const wrapper = getOrCreateCounterRotWrapper(token);
    if (wrapper && !wrapper.destroyed) { wrapper.addChild(c); return c; }
    const carrier = getOrCreateOcclusionCarrier(token);
    if (carrier && !carrier.destroyed) { carrier.addChild(c); return c; }
    token.addChild(c);
    return c;
}

/* Strip any prior health visuals + remove our color filter. Foundry calls
 * refreshToken often (selection, HUD, animations) — every call ends with
 * a clean slate so a state change (wounded → healed) leaves no residue. */
function clearVisuals(token) {
    const c = findOverlayContainer(token);
    if (c && !c.destroyed) {
        try { c.parent?.removeChild?.(c); c.destroy({ children: true }); } catch (_) { /* token tearing down */ }
    }
    const mesh = token?.mesh;
    if (mesh?.filters?.length) {
        mesh.filters = mesh.filters.filter(f => !f?.[FILTER_MARK]);
        if (mesh.filters.length === 0) mesh.filters = null;
    }
    /* Release the baked dying grayscale texture (destroying the container
     * above frees the sprite, but the RenderTexture is owned on the token). */
    freeDyingBake(token);
}

function applyMeshFilter(token, filter) {
    const mesh = token?.mesh;
    if (!mesh) return;
    filter[FILTER_MARK] = true;
    const prior = (mesh.filters ?? []).filter(f => !f?.[FILTER_MARK]);
    mesh.filters = [...prior, filter];
}

/* Free a token's baked dying texture (the grayscale RenderTexture). Safe to
 * call when there is none. */
function freeDyingBake(token) {
    const rt = token?._wdmDyingBake;
    if (rt && !rt.destroyed) {
        try { rt.destroy(true); } catch (_) { /* already released */ }
    }
    if (token) token._wdmDyingBake = null;
}

/* Bake a desaturated copy of `tex` into a RenderTexture ONCE. We render a
 * throwaway sprite (portrait through the luminance ColorMatrixFilter) into an
 * offscreen RenderTexture, then return that texture. The displayed dying
 * sprite uses it with NO filter, so there's zero per-frame shader cost — the
 * grayscale is resolved a single time, at the moment the token enters (or
 * changes footprint/portrait while in) the dying state. Returns null if the
 * renderer or source texture isn't ready (caller falls back to a live filter). */
function bakeGrayscaleTexture(tex) {
    const renderer = canvas?.app?.renderer;
    if (!renderer || !tex || tex.valid === false) return null;
    const bw = Math.max(1, Math.round(Number(tex.width)  || 0));
    const bh = Math.max(1, Math.round(Number(tex.height) || 0));
    if (bw <= 1 && bh <= 1) return null;
    const res = tex.baseTexture?.resolution || 1;
    let rt = null, src = null;
    try {
        rt = PIXI.RenderTexture.create({ width: bw, height: bh, resolution: res });
        src = new PIXI.Sprite(tex);
        src.anchor.set(0, 0);
        src.width  = bw;
        src.height = bh;
        const f = new PIXI.ColorMatrixFilter();
        f.matrix = LUMINANCE_MATRIX;
        src.filters = [f];
        renderer.render(src, { renderTexture: rt, clear: true });
        return rt;
    } catch (err) {
        console.warn(`${SYSTEM_ID} | dying grayscale bake failed`, err);
        if (rt && !rt.destroyed) { try { rt.destroy(true); } catch (_) {} }
        return null;
    } finally {
        // Destroy the throwaway sprite ONLY — never the shared base portrait texture.
        if (src && !src.destroyed) { try { src.destroy({ children: true, texture: false, baseTexture: false }); } catch (_) {} }
    }
}

function applyDyingVisual(token) {
    if (!token?.mesh) return;
    /* INNER-CIRCLE GRAYSCALE — do NOT filter the token mesh directly:
     * that would also desaturate the dynamic ring + any other token-
     * level decoration (selection border, bars). Instead, draw a clone
     * of the portrait sprite ON TOP of the mesh with the grayscale
     * filter applied, masked to the token's inner disk. The original
     * mesh keeps its colors (so the ring stays in its native palette);
     * we just overpaint the portrait area with a grayscale copy.
     *
     * Manual luminance matrix — pure saturation = 0 with no brightness
     * boost. (`ColorMatrixFilter.greyscale(amount, multiply=true)` in
     * PIXI 7 multiplies into the prior matrix and can lift midtones —
     * the literal Rec.601 weights below don't.) */
    const w = token.w ?? (token.document?.width  ?? 1) * (canvas?.scene?.grid?.size ?? 100);
    const h = token.h ?? (token.document?.height ?? 1) * (canvas?.scene?.grid?.size ?? 100);
    const cx = w / 2;
    const cy = h / 2;
    /* Inner portrait disk (inside the ring frame) — see RING_INNER_FRAC. The
     * raw-footprint clone used to bleed grayscale onto the ring band. */
    const diskR = (Math.min(w, h) / 2) * RING_INNER_FRAC;

    const c = getOrCreateOverlayContainer(token);
    c.removeChildren();

    /* Grayscale portrait — the desaturation is BAKED into a RenderTexture
     * once (bakeGrayscaleTexture) so the displayed sprite carries no live
     * filter. Sized to the portrait disk and centred so it overlays the
     * displayed (ring-inset) portrait, not the footprint. Falls back to a
     * live ColorMatrixFilter only if the bake can't run (texture not ready). */
    const tex = token.mesh?.texture;
    if (tex) {
        freeDyingBake(token);                       // release any earlier bake before re-baking
        const baked = bakeGrayscaleTexture(tex);
        let gray;
        if (baked) {
            token._wdmDyingBake = baked;
            gray = new PIXI.Sprite(baked);          // pre-rendered — NO filter
        } else {
            gray = new PIXI.Sprite(tex);            // fallback: live filter (rare)
            const f = new PIXI.ColorMatrixFilter();
            f.matrix = LUMINANCE_MATRIX;
            gray.filters = [f];
        }
        gray.anchor.set(0.5);
        gray.width  = gray.height = diskR * 2;
        gray.position.set(cx, cy);
        /* Circular mask = the portrait disk. Ring sits OUTSIDE this disk
         * so it stays untouched. */
        const mask = new PIXI.Graphics();
        mask.beginFill(0xffffff, 1);
        mask.drawCircle(cx, cy, diskR);
        mask.endFill();
        c.addChild(mask);
        gray.mask = mask;
        c.addChild(gray);
    }

    /* Skull glyph centered, ~19% alpha (user halved it from 38%). */
    const skull = new PIXI.Text("\u{1F480}", {     // 💀
        fontSize:   Math.floor(Math.min(w, h) * 0.65),
        fontFamily: '"Segoe UI Emoji","Noto Color Emoji","Apple Color Emoji",sans-serif',
        fill:       0xffffff
    });
    skull.alpha = 0.19;
    skull.anchor.set(0.5, 0.5);
    skull.x = cx;
    skull.y = cy;
    skull.zIndex = 10;
    c.addChild(skull);
}

/* Cached radial-gradient texture — generated once, reused for every
 * wounded token's glow sprite. True INNER GLOW: transparent at the
 * center, peak red somewhere inside the disk, tapering back to
 * transparent at the very edge so there's no hard red rim against the
 * token's dynamic ring (user's complaint: previous gradient had 90%
 * alpha at radius=1.0, which read as a thick red ring framing the
 * portrait instead of a soft haze inside it). */
let _wdmGlowTex = null;
function getInnerGlowTexture() {
    if (_wdmGlowTex && !_wdmGlowTex.destroyed) return _wdmGlowTex;
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    const cx = size / 2;
    const cy = size / 2;
    const outerR = size / 2;
    /* Gradient stops (radial 0 → outerR):
     *   0.00  transparent      (center stays clear; portrait readable)
     *   0.45  transparent      (quiet inner zone)
     *   0.62  fade in starts
     *   0.78  PEAK red          (40% alpha — visible but not solid)
     *   0.92  trailing back down
     *   1.00  transparent      (no hard edge against the dynamic ring)
     * Peak pulled inward to 78% so an 8px mask inset on a standard
     * 50px-radius token still keeps the peak (78% of 50 = 39px ≤ 42).
     * Net effect: a soft ring-shaped haze of red INSIDE the portrait
     * silhouette, not touching the rim. */
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, outerR);
    grad.addColorStop(0.00, "rgba(139, 0, 0, 0)");
    grad.addColorStop(0.45, "rgba(139, 0, 0, 0)");
    grad.addColorStop(0.62, "rgba(139, 0, 0, 0.10)");
    grad.addColorStop(0.78, "rgba(139, 0, 0, 0.40)");
    grad.addColorStop(0.92, "rgba(139, 0, 0, 0.18)");
    grad.addColorStop(1.00, "rgba(139, 0, 0, 0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
    ctx.fill();
    _wdmGlowTex = PIXI.Texture.from(canvas);
    return _wdmGlowTex;
}

function applyWoundedVisual(token) {
    if (!token?.mesh) return;
    /* Wounded = INNER GLOW ONLY. No ColorMatrixFilter on the mesh — the
     * portrait keeps its natural colors so the player can still read who
     * they are at a glance. The "bloodied" cue is a smooth radial
     * gradient sprite (transparent center → dark red at the edge),
     * clipped to the token disk by a circular PIXI mask. Drawn from a
     * cached canvas-generated texture so there are no visible ring
     * boundaries (the earlier stacked-stroke approach drew distinct
     * concentric lines which read as rings, not a glow). */
    const c = getOrCreateOverlayContainer(token);
    c.removeChildren();
    const w = token.w ?? (token.document?.width  ?? 1) * (canvas?.scene?.grid?.size ?? 100);
    const h = token.h ?? (token.document?.height ?? 1) * (canvas?.scene?.grid?.size ?? 100);

    const cx = w / 2;
    const cy = h / 2;
    /* Clip to the inner PORTRAIT disk, not the footprint — the dynamic-ring
     * frame owns the outer band, so a footprint-sized glow spills onto the
     * ring (see RING_INNER_FRAC). */
    const diskR = (Math.min(w, h) / 2) * RING_INNER_FRAC;

    const glow = new PIXI.Sprite(getInnerGlowTexture());
    /* Size the sprite to the portrait disk and anchor it at centre. The
     * gradient fades to 0 at the sprite edge, so at this size the haze dies
     * out exactly at the portrait boundary — no hard rim against the ring. */
    glow.anchor.set(0.5);
    glow.width  = glow.height = diskR * 2;
    glow.position.set(cx, cy);
    glow.zIndex = 5;
    c.addChild(glow);

    /* Circular mask matching the portrait disk — belt-and-braces clip so no
     * edge pixel can land on the ring band even if the gradient is retuned. */
    const mask = new PIXI.Graphics();
    mask.beginFill(0xffffff, 1);
    mask.drawCircle(cx, cy, diskR);
    mask.endFill();
    c.addChild(mask);
    glow.mask = mask;
}

function refreshTokenHealth(token) {
    if (!token || token.destroyed) return;
    /* Signature gate. This fires on EVERY refreshToken (many times per frame
     * while a token animates), and previously tore down + rebuilt the whole
     * overlay — a ColorMatrixFilter, sprites, masks and a Text glyph — every
     * single time, even when nothing about the rendered result changed. The
     * visible outcome is a pure function of (desired visual, footprint, portrait
     * texture); gate on that so a stable token costs one string compare. */
    const _visible = !!token.visible && !!token.renderable
        && !token.mesh?.occluded && !isTokenCulledBySurface(token);
    const _state = _visible ? readHealthState(token) : null;
    const _desired = !_visible ? "none"
        : (_state?.dying ? "dying" : (_state?.wounded ? "wounded" : "none"));
    const _sig = `${_desired}:${Math.round(Number(token.w) || 0)}:${Math.round(Number(token.h) || 0)}:${token.document?.texture?.src || ""}`;
    if (token._wdmHealthSig === _sig) return;
    token._wdmHealthSig = _sig;

    /* The visibility / mesh-occlusion / surface-cull signals above were
     * previously re-checked here inline; they're now folded into `_visible`
     * so the desired-visual computation and the teardown/rebuild agree. When
     * not visible, `_desired` is "none" → clearVisuals with nothing re-added,
     * exactly as the old early-returns did (they relied on the unconditional
     * clearVisuals at the top). */
    clearVisuals(token);
    if (_desired === "dying")        applyDyingVisual(token);
    else if (_desired === "wounded") applyWoundedVisual(token);
}

function refreshActorTokens(actor) {
    if (!actor) return;
    const tokens = (typeof actor.getActiveTokens === "function")
        ? actor.getActiveTokens()
        : [];
    for (const t of tokens) refreshTokenHealth(t);
}

export function registerHealthStateVisuals() {
    Hooks.on("drawToken",    (token) => refreshTokenHealth(token));
    Hooks.on("refreshToken", (token) => refreshTokenHealth(token));
    /* Remote actor updates don't fire refreshToken on this client by
     * default — we re-apply explicitly so a player's HP loss on another
     * client lights up the wounded glow here too. */
    Hooks.on("updateActor",  (actor, changes) => {
        if (!changes?.system?.derivedStats && !changes?.system?.stats && !changes?.system?.healthState) return;
        refreshActorTokens(actor);
    });
    /* Free the baked dying grayscale RenderTexture when the token is torn
     * down (scene change / deletion) — refreshToken won't fire to clear it. */
    Hooks.on("destroyToken", (token) => freeDyingBake(token));
}
