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

const SYSTEM_ID = "witcher-ttrpg-death-march";
const VISUAL_MARK = "_wdmHealthVisuals";
const FILTER_MARK = "_wdmHealthFilter";

function readHealthState(token) {
    return token?.actor?.system?.healthState ?? { dying: false, wounded: false };
}

/* The token PIXI tree we draw into. We stash a single container on the
 * token so all our graphics are easy to find + dispose. */
function getOrCreateOverlayContainer(token) {
    let c = token.children?.find?.(ch => ch?.[VISUAL_MARK]);
    if (c && !c.destroyed) return c;
    c = new PIXI.Container();
    c[VISUAL_MARK] = true;
    c.zIndex = 100;
    c.sortableChildren = true;
    token.addChild(c);
    return c;
}

/* Strip any prior health visuals + remove our color filter. Foundry calls
 * refreshToken often (selection, HUD, animations) — every call ends with
 * a clean slate so a state change (wounded → healed) leaves no residue. */
function clearVisuals(token) {
    const c = token?.children?.find?.(ch => ch?.[VISUAL_MARK]);
    if (c && !c.destroyed) {
        try { token.removeChild(c); c.destroy({ children: true }); } catch (_) { /* token tearing down */ }
    }
    const mesh = token?.mesh;
    if (mesh?.filters?.length) {
        mesh.filters = mesh.filters.filter(f => !f?.[FILTER_MARK]);
        if (mesh.filters.length === 0) mesh.filters = null;
    }
}

function applyMeshFilter(token, filter) {
    const mesh = token?.mesh;
    if (!mesh) return;
    filter[FILTER_MARK] = true;
    const prior = (mesh.filters ?? []).filter(f => !f?.[FILTER_MARK]);
    mesh.filters = [...prior, filter];
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
    const baseRadius = Math.min(w, h) / 2;

    const c = getOrCreateOverlayContainer(token);
    c.removeChildren();

    /* Grayscale portrait clone — same texture as the live mesh, with
     * a luminance ColorMatrixFilter. Sized + positioned to overlay the
     * portrait exactly. */
    const tex = token.mesh?.texture;
    if (tex) {
        const gray = new PIXI.Sprite(tex);
        gray.width  = w;
        gray.height = h;
        gray.anchor.set(0, 0);
        const f = new PIXI.ColorMatrixFilter();
        f.matrix = [
            0.299, 0.587, 0.114, 0, 0,
            0.299, 0.587, 0.114, 0, 0,
            0.299, 0.587, 0.114, 0, 0,
            0,     0,     0,     1, 0
        ];
        gray.filters = [f];
        /* Circular mask = the portrait disk. Ring sits OUTSIDE this disk
         * so it stays untouched. */
        const mask = new PIXI.Graphics();
        mask.beginFill(0xffffff, 1);
        /* Slightly INSET so the ring isn't even brushed by the mask edge. */
        mask.drawCircle(cx, cy, baseRadius - 2);
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
    const baseRadius = Math.min(w, h) / 2;

    const glow = new PIXI.Sprite(getInnerGlowTexture());
    glow.width  = w;
    glow.height = h;
    glow.zIndex = 5;
    c.addChild(glow);

    /* Circular mask matching the token's disk — clips any pixels that
     * fall outside the actual sprite silhouette. Inset a few pixels so
     * the glow stays inside the dynamic ring frame (the metallic ring
     * takes a small annulus of inner padding; without the inset, the
     * gradient's edge pixels paint over the inside of the ring and look
     * like a red lining around the portrait). */
    const mask = new PIXI.Graphics();
    mask.beginFill(0xffffff, 1);
    mask.drawCircle(cx, cy, baseRadius - 8);
    mask.endFill();
    c.addChild(mask);
    glow.mask = mask;
}

function refreshTokenHealth(token) {
    if (!token || token.destroyed) return;
    clearVisuals(token);
    const state = readHealthState(token);
    if (state?.dying)        applyDyingVisual(token);
    else if (state?.wounded) applyWoundedVisual(token);
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
}
