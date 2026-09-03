/**
 * Token disposition visual — a soft colored halo around the token silhouette,
 * hue-keyed to Foundry's disposition (FRIENDLY / HOSTILE), plus a hard
 * visibility gate for SECRET.
 *
 *   FRIENDLY → green halo
 *   HOSTILE  → red halo
 *   NEUTRAL  → nothing (deliberately no marking so the ambient scene reads
 *              as "neither ally nor threat")
 *   SECRET   → GM sees the token with NO halo AND NO facing arrow — every
 *              tell that "this is a token" is stripped, leaving only the
 *              raw portrait for right-click access. Non-GMs see nothing
 *              at all — visible / mesh.visible / alpha triple-handled off,
 *              selection + target released, so the token is unhittable
 *              for click, hover, drag, target, and control on the client.
 *
 * ── Performance: baked texture, NOT a live filter ──────────────────────
 * This used to attach a `GlowOverlayFilter` to `token.mesh.filters`. That
 * filter is a live GPU shader: PIXI re-runs the whole glow convolution
 * (distance 52, padding 72) EVERY FRAME the mesh renders, for every
 * friendly / hostile token, each pass allocating its own filter render
 * target. `filter.animated = false` does NOT stop that — it only freezes
 * the shader's time uniform; the convolution still executes per frame. On
 * a busy combat scene that's N full-screen-ish filter passes at 60fps.
 *
 * Instead we now bake the halo ONCE into a shared radial-gradient texture
 * (generated on first use, cached module-level) and draw it as a plain
 * `PIXI.Sprite` — a single textured quad, ≈ free per frame. One texture is
 * reused across every frame AND every token; per-token colour is just
 * `sprite.tint` (red / green) and per-disposition intensity is
 * `sprite.alpha`. This is the exact pattern `health-state-visuals.mjs`
 * uses for the wound glow (`getInnerGlowTexture`).
 *
 * The gradient is transparent through the centre and only blooms near /
 * just outside the silhouette edge, so the sprite (sized larger than the
 * token) never paints over the portrait — only the outer halo shows.
 *
 * The sprite is parented into the token-style occlusion BACKDROP — a
 * primary-group container synced one z-step BELOW the token mesh — so the
 * whole halo renders BEHIND the portrait + dynamic ring instead of over
 * them. It still inherits — for free, via the per-frame `syncOcclusionBackdrop`:
 *   - position / rotation / elevation tracking of the mesh
 *   - z-order occlusion by higher-elevation surfaces (roofs)
 *   - mesh alpha (stealth fade, occlusion fade) and mesh visibility
 *     (level cutout, region hide, GM hidden flag) — the carrier mirrors
 *     `mesh.alpha` / `mesh.visible` every frame, and PIXI multiplies alpha
 *     down the tree, so the halo fades / hides exactly when the mesh does.
 * That reproduces everything the old mesh-filter got "for free" from
 * living on the mesh, without the per-frame shader cost.
 *
 * Registration order: this module MUST register AFTER both
 * `registerWitcherTokenStyle()` (so my SECRET-hide of `_wdmFacingArrow`
 * lands after that module's `refreshFacingArrow` hook writes visible=true)
 * AND `registerStealthTokenVisibility()` (so my SECRET hide of the whole
 * token wins the last write on refreshToken). Composition:
 *   final visible = stealthGate.visible AND (disposition ≠ SECRET or isGM)
 * i.e., both gates can hide but neither reveals what the other hides.
 */

import { getOrCreateOcclusionBackdrop, tokenTextureScale } from "./witcher-token-style.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";

/* Marks our halo sprite so we can find it wherever it currently lives
 * (wrapper preferred, carrier / placeable fallback) — same lookup shape
 * as health-state-visuals / stealth-token-visual so container migration
 * never leaks orphan sprites. */
const VISUAL_MARK = "_wdmDispositionGlow";

/* Per-disposition look. `tint` multiplies the white gradient texture;
 * `alpha` scales the whole sprite so HOSTILE reads punchier than FRIENDLY
 * (mirrors the old filter tuning: hostile 0.85 / friendly 0.55). Colours
 * chosen traffic-light red / green so a new player reads them at a glance
 * without a legend. NEUTRAL (0) and SECRET (-2) intentionally absent — no
 * halo. */
const DISPOSITION_STYLE = {
    [-1]: { tint: 0xfa1a1a, alpha: 0.90 },   // HOSTILE  — punchy red
    [ 1]: { tint: 0x4ac25a, alpha: 0.60 }    // FRIENDLY — green
};

/* Halo diameter as a multiple of the token's VISIBLE RING diameter — NOT
 * the raw grid footprint. The dynamic token ring scales with the token's
 * texture scale (`texture.scaleX/scaleY`): a werewolf at texture scale 1.4
 * draws its ring 1.4× larger than its 1-grid footprint, while a human at
 * scale 1.0 draws it flush to the footprint. Sizing the halo off the
 * footprint alone (the old `max(w,h) * 1.7`) therefore hugged the big
 * tokens but left a fat gap around the scale-1.0 ones — their halo peak
 * sat ~20% outside the ring. `applyDispositionGlow` now multiplies the
 * footprint by the texture scale so the halo tracks the ring at ANY scale,
 * and this multiplier is kept just above 1 so — with the gradient peaking
 * at ~0.72 of the halo radius — the glow begins right at the ring edge and
 * blooms tightly outward.
 *
 * The ring sits at `1.0 × ringRadius` and the sprite's outer edge at
 * `OVERLAY_SCALE × ringRadius`, so the glow visible BEYOND the ring — the
 * "spread" — is the `(OVERLAY_SCALE − 1)` excess. 1.1 gives a 0.1×
 * spread (half the earlier 1.2 / 0.2× bloom). */
const OVERLAY_SCALE = 1.1;

/* Track tokens whose whole visibility we've clamped for SECRET so we
 * can cleanly restore on disposition change / GM promotion. */
const _secretHiddenByUs = new WeakSet();

/* ─────────── shared baked glow texture ─────────── */

/* Generated once on first use, cached for the lifetime of the client and
 * reused (tinted) by every token. Canvas radial gradient → PIXI texture,
 * exactly like health-state-visuals' wound glow.
 *
 * Painted white so `sprite.tint` can recolour it per disposition. Stops:
 *   0.00 transparent   (portrait centre stays clear)
 *   0.50 transparent   (quiet inner zone — under the portrait)
 *   0.62 fade in
 *   0.72 PEAK          (bright ring, sits just outside the silhouette)
 *   0.86 trailing down
 *   1.00 transparent   (soft outer edge, no hard rim) */
let _glowTex = null;
function getDispositionGlowTexture() {
    if (_glowTex && !_glowTex.destroyed) return _glowTex;
    const size = 256;
    const cvs = document.createElement("canvas");
    cvs.width = cvs.height = size;
    const ctx = cvs.getContext("2d");
    const c = size / 2;
    const outerR = size / 2;
    const grad = ctx.createRadialGradient(c, c, 0, c, c, outerR);
    grad.addColorStop(0.00, "rgba(255,255,255,0)");
    grad.addColorStop(0.50, "rgba(255,255,255,0)");
    grad.addColorStop(0.62, "rgba(255,255,255,0.35)");
    grad.addColorStop(0.72, "rgba(255,255,255,1)");
    grad.addColorStop(0.86, "rgba(255,255,255,0.35)");
    grad.addColorStop(1.00, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(c, c, outerR, 0, Math.PI * 2);
    ctx.fill();
    _glowTex = PIXI.Texture.from(cvs);
    return _glowTex;
}

/* ─────────── halo sprite lifecycle ─────────── */

function findGlowSprite(token) {
    if (!token) return null;
    const backdrop = token._wdmOcclusionBackdrop;
    const inBackdrop = backdrop?.children?.find?.(ch => ch?.[VISUAL_MARK]);
    if (inBackdrop) return inBackdrop;
    /* Legacy above-mesh homes (wrapper / carrier / placeable) — find any
     * stray from an earlier build so getOrCreate can re-home it behind the
     * token. */
    const wrapper = token._wdmCounterRotWrapper;
    const inWrapper = wrapper?.children?.find?.(ch => ch?.[VISUAL_MARK]);
    if (inWrapper) return inWrapper;
    const carrier = token._wdmOcclusionCarrier;
    const inCarrier = carrier?.children?.find?.(ch => ch?.[VISUAL_MARK]);
    if (inCarrier) return inCarrier;
    return token.children?.find?.(ch => ch?.[VISUAL_MARK]) ?? null;
}

/* Return the token's halo sprite, creating it if needed and keeping it
 * parented into the preferred container (counter-rot wrapper → carrier →
 * placeable fallback for the early-draw race). Added at index 0 so it
 * renders UNDER the other decorations (bars / nameplate) in the wrapper.
 * Re-homes an existing sprite if the wrapper has since been created. */
function getOrCreateGlowSprite(token) {
    /* The halo lives in the occlusion BACKDROP — a primary-group container
     * synced one z-step BELOW the token mesh — so the whole glow renders
     * BEHIND the portrait + dynamic ring instead of over them, while still
     * inheriting the mesh's position, occlusion, alpha and visibility. */
    const backdrop = getOrCreateOcclusionBackdrop(token);
    const preferred = (backdrop && !backdrop.destroyed) ? backdrop : token;

    let s = findGlowSprite(token);
    if (s && !s.destroyed) {
        /* Re-home a stray sprite left in a legacy (above-mesh) parent by an
         * earlier build so it drops behind the token. */
        if (preferred && s.parent !== preferred) {
            try { s.parent?.removeChild?.(s); preferred.addChild(s); }
            catch (_) { /* teardown race */ }
        }
        token._wdmDispGlow = s;
        return s;
    }
    if (!preferred || preferred.destroyed) return null;
    s = new PIXI.Sprite(getDispositionGlowTexture());
    s[VISUAL_MARK] = true;
    s.anchor.set(0.5, 0.5);
    s.eventMode = "none";
    preferred.addChild(s);
    token._wdmDispGlow = s;
    return s;
}

function removeGlowSprite(token) {
    if (token) token._wdmDispGlow = null;
    const s = findGlowSprite(token);
    if (!s || s.destroyed) return;
    try { s.parent?.removeChild?.(s); s.destroy(); }
    catch (_) { /* already gone */ }
}

/* Idempotent per-refresh sync: pick the disposition, size / colour the
 * shared-texture sprite (cheap property writes — no allocation, no
 * shader), or remove it for NEUTRAL / SECRET. Safe to call every
 * refreshToken. */
function applyDispositionGlow(token) {
    const mesh = token?.mesh;
    if (!mesh) return;
    const disposition = Number(token.document?.disposition ?? 0);
    const style = DISPOSITION_STYLE[disposition];
    /* NEUTRAL / SECRET / degenerate size → no halo. Gate the teardown on a
     * "none" signature so a neutral token (the majority) doesn't re-run the
     * parent-chain search on every one of its refreshToken fires. */
    if (!style) {
        if (token._wdmDispSig === "none") return;
        token._wdmDispSig = "none";
        removeGlowSprite(token);
        return;
    }

    const tw = Number(token.w) || 0;
    const th = Number(token.h) || 0;
    if (tw <= 0 || th <= 0) {
        if (token._wdmDispSig === "none") return;
        token._wdmDispSig = "none";
        removeGlowSprite(token);
        return;
    }

    /* Signature gate — fires on every refreshToken. The halo is a pure function
     * of (disposition, footprint, texture scale). When those are unchanged and
     * the sprite is still alive and parented, skip the parent-chain search +
     * size math entirely. Falls through whenever the sprite was torn down or
     * re-homed (early-draw race), so recreation / re-parenting still happens. */
    const texScale = tokenTextureScale(token);
    /* Selected tokens hide their disposition halo (see below) — fold `controlled`
     * into the signature so selecting / deselecting re-evaluates visibility. */
    const controlled = !!token.controlled;
    const sig = `${disposition}:${controlled ? "c" : "u"}:${Math.round(tw)}:${Math.round(th)}:${texScale.toFixed(3)}`;
    const cached = token._wdmDispGlow;
    if (token._wdmDispSig === sig && cached && !cached.destroyed && cached.parent) return;
    token._wdmDispSig = sig;

    const s = getOrCreateGlowSprite(token);
    if (!s || s.destroyed) return;

    /* Size off the VISIBLE ring, which scales with the token's texture
     * scale — otherwise the halo hugs high-scale tokens (werewolves) but
     * leaves a gap around scale-1.0 ones (humans). Shared helper so this
     * tracks the same factor the decoration wrapper / facing arrow use. */
    const size = Math.max(tw, th) * texScale * OVERLAY_SCALE;
    if (s.width !== size)  s.width  = size;
    if (s.height !== size) s.height = size;
    const cx = tw / 2;
    const cy = th / 2;
    if (s.position.x !== cx || s.position.y !== cy) s.position.set(cx, cy);
    if (s.tint !== style.tint)   s.tint  = style.tint;
    if (s.alpha !== style.alpha) s.alpha = style.alpha;
    /* Hide the disposition halo while the token is SELECTED, so the amber
     * selection glow reads unambiguously instead of blending with the red/green
     * disposition wash. Restored the moment the token is deselected. */
    const wantVisible = !controlled;
    if (s.visible !== wantVisible) s.visible = wantVisible;
}

/* SECRET gate. Portrait stays visible for everyone — the goal is that a
 * SECRET token reads as ambient map art, not as an interactive game
 * element. For all users, strip the "chrome" decorations that would
 * signal "this is a token" (border, bars, nameplate, tooltip, level
 * indicator, facing arrow). For non-GMs, additionally block all mouse
 * interaction (no click, no right-click, no hover, no target, no drag)
 * and release any selection / target the client currently holds. GMs
 * keep full interactivity so right-click / control / target still work
 * on their end. */
function applySecretGate(token) {
    if (!token || token.destroyed) return;
    const disposition = Number(token.document?.disposition ?? 0);
    const isSecret = disposition === -2;
    const isGM = !!game.user?.isGM;

    if (isSecret) {
        /* Chrome strip — every decoration that says "token" gets hidden.
         * Foundry's own `_refreshState` may reassert these on the next
         * state change; because this function runs from the refreshToken
         * hook AFTER `_refreshState` finishes, our hides land last and
         * stick. `witcher-token-style`'s cascade already hides these
         * when `token.visible` is false, but SECRET keeps the mesh
         * visible so the cascade won't fire — we do it explicitly. */
        const hide = (child) => { if (child && !child.destroyed) child.visible = false; };
        hide(token.border);
        hide(token.bars);
        hide(token.nameplate);
        hide(token.tooltip);
        hide(token.levelIndicator);
        hide(token._wdmFacingArrow);

        if (!isGM) {
            /* Block all mouse events at the PIXI layer. `interactive =
             * false` is the compat shortcut for `eventMode = "none"`,
             * which drops the token out of the hit-test tree entirely
             * — click / right-click / hover / drag / target all miss.
             * The portrait keeps rendering because visibility isn't
             * touched. Also release any prior hold so a player who had
             * this token selected before it turned SECRET doesn't
             * silently retain "phantom" control. */
            token.interactive = false;
            _secretHiddenByUs.add(token);
            try {
                if (token.controlled) token.release?.();
                if (token.isTargeted) token.setTarget?.(false, { releaseOthers: false, groupSelection: false });
            } catch (_) { /* teardown race */ }
        }
        return;
    }

    /* Not SECRET. If we previously disabled interactivity, restore.
     * Foundry's own draw sets `interactive = true` on placeables so
     * flipping back to true matches the default. */
    if (_secretHiddenByUs.has(token)) {
        _secretHiddenByUs.delete(token);
        token.interactive = true;
    }
}

function refreshDispositionVisual(token) {
    if (!token || token.destroyed) return;
    applyDispositionGlow(token);
    applySecretGate(token);
}

/* Patch `Token.prototype._refreshState` so the SECRET chrome-hide lands
 * inside the same call frame Foundry uses to WRITE the chrome visibility.
 * The refreshToken hook fires after `_refreshState` completes in the
 * normal refresh cycle, so a hook-only approach mostly works — but hover
 * / control / highlight events flip the `refreshState` render-flag on
 * paths where a subsequent full refreshToken hook doesn't always fire
 * before Foundry's own write is visible. Wrapping `_refreshState`
 * closes that window: whenever Foundry writes chrome-visible-true for
 * SECRET-for-observers, we immediately overwrite to false. Idempotent
 * guard via `__wdmDispositionPatched` so double-registration (or an
 * over-eager reload) doesn't stack wrappers. */
function patchTokenRefreshState() {
    const TokenCls = CONFIG?.Token?.objectClass;
    if (!TokenCls || TokenCls.prototype.__wdmDispositionPatched) return;
    const baseRefreshState = TokenCls.prototype._refreshState;
    TokenCls.prototype._refreshState = function _refreshStateWdmDisposition() {
        const ret = baseRefreshState?.call(this);
        try {
            const disposition = Number(this.document?.disposition ?? 0);
            if (disposition === -2) {
                const hide = (child) => { if (child && !child.destroyed) child.visible = false; };
                hide(this.border);
                hide(this.bars);
                hide(this.nameplate);
                hide(this.tooltip);
                hide(this.levelIndicator);
                hide(this.effects);
                hide(this.targetArrows);
                hide(this.targetPips);
                hide(this._wdmFacingArrow);
            }
        } catch (err) {
            console.warn(`${SYSTEM_ID} | disposition _refreshState wrap failed`, err);
        }
        return ret;
    };
    TokenCls.prototype.__wdmDispositionPatched = true;
}

export function registerTokenDispositionVisual() {
    /* Class-level patch. Must run before any token is drawn, so we hook
     * `setup` — which fires after Foundry has defined the token classes
     * but before the world's tokens are created. The hook handlers below
     * cover the runtime paths (draw / refresh / update / user connect). */
    Hooks.once("setup", () => {
        try { patchTokenRefreshState(); }
        catch (err) { console.warn(`${SYSTEM_ID} | disposition _refreshState patch failed`, err); }
    });
    /* Belt-and-braces: also try at ready in case setup fires before
     * CONFIG.Token.objectClass is finalized (some load orders do). */
    Hooks.once("ready", () => {
        try { patchTokenRefreshState(); }
        catch (_) { /* idempotent — no-op if already patched */ }
    });
    Hooks.on("drawToken", (token) => {
        try { refreshDispositionVisual(token); }
        catch (err) { console.warn(`${SYSTEM_ID} | disposition visual draw failed`, err); }
    });
    Hooks.on("refreshToken", (token) => {
        try { refreshDispositionVisual(token); }
        catch (err) { console.warn(`${SYSTEM_ID} | disposition visual refresh failed`, err); }
    });
    /* Selecting / deselecting a token toggles whether its disposition halo hides
     * (so the amber selection glow isn't muddied by the red/green wash).
     * refreshToken fires on control, but hook controlToken too for an immediate,
     * reliable swap. */
    Hooks.on("controlToken", (token) => {
        try { refreshDispositionVisual(token); }
        catch (_) { /* teardown race */ }
    });
    Hooks.on("updateToken", (tokenDoc, changes) => {
        if (!("disposition" in changes) && !("hidden" in changes) && !("alpha" in changes)) return;
        const token = tokenDoc.object;
        if (token) refreshDispositionVisual(token);
    });
    /* Multi-GM tables: a GM logging in / out flips whether SECRET tokens
     * should be hidden for THIS client. Cheap sweep across the current
     * scene's tokens (idempotent per token). */
    Hooks.on("userConnected", () => {
        for (const t of (canvas?.tokens?.placeables ?? [])) {
            try { refreshDispositionVisual(t); }
            catch (_) { /* teardown race */ }
        }
    });
    Hooks.on("destroyToken", (token) => {
        removeGlowSprite(token);
        _secretHiddenByUs.delete(token);
    });
}
