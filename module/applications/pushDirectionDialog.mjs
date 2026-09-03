/**
 * Canvas RAY overlay for a chosen shove (CE Slam). Draws a live line + arrowhead
 * from the target toward the mouse — the length of the actual knockback, like a
 * spell line template — and resolves when the player clicks. Returns a unit
 * vector {x, y} (CANVAS space, +y down) from `origin` toward the aim point, or
 * null if cancelled (right-click / Escape / no canvas).
 *
 * Pointer handling mirrors weapon-target-overlay: track the world position via
 * `pointermove` on the stage, resolve on a document-level capture `pointerdown`
 * so the click doesn't also select a token.
 *
 * @param {{x:number,y:number}} origin  World coords of the token being slammed.
 * @param {{lengthPx?:number}} [opts]   Ray length in pixels (the knockback reach).
 * @returns {Promise<{x:number,y:number}|null>}
 */
/** Sentinel resolved by pickPushDirection when `backOnRightClick` is set and the
 *  player right-clicks — lets a caller treat right-click as "go back a step"
 *  distinct from Escape (which still resolves null = cancel). */
export const PICK_DIRECTION_BACK = Symbol("pick-direction-back");

export async function pickPushDirection(origin, { lengthPx = 0, promptText = null, backOnRightClick = false } = {}) {
    if (!canvas?.ready || !canvas.stage || !origin) return null;

    /* Draw on the template preview layer — the same layer the spell line
     * template uses, so the arrow renders UNDER tokens. */
    const host = canvas.templates?.preview ?? canvas.templates ?? canvas.interface ?? canvas.stage;
    const gfx  = new PIXI.Graphics();
    try { gfx.eventMode = "none"; } catch (_) {}
    try { host.addChild(gfx); } catch (_) { /* fall through — no visual, still pick */ }

    /* Theme palette (matches the tile overlay + spell templates). */
    const AMBER = 0xc8a878;   // --wdm-ink accent
    const EDGE  = 0x6e5224;   // dark border

    return new Promise((resolve) => {
        let world = null;
        let done  = false;

        const gs = canvas?.dimensions?.size ?? 100;
        const draw = () => {
            if (!gfx || gfx.destroyed) return;
            gfx.clear();
            if (!world) return;
            const dx = Number(world.x) - Number(origin.x);
            const dy = Number(world.y) - Number(origin.y);
            const len = Math.hypot(dx, dy);
            if (len < 1) return;
            const ux = dx / len, uy = dy / len;      // direction
            const px = -uy, py = ux;                  // perpendicular
            const L  = lengthPx > 0 ? lengthPx : len; // reach in px
            /* Tapered filled arrow: a narrow shaft flaring to a wide head. */
            const w   = Math.max(3, gs * 0.09);       // shaft half-width
            const hw  = Math.max(9, gs * 0.22);       // head half-width
            const hl  = Math.min(L * 0.5, gs * 0.55); // head length
            const se  = Math.max(0, L - hl);          // shaft end distance
            const P = (d, o) => [origin.x + ux * d + px * o, origin.y + uy * d + py * o];
            const pts = [
                ...P(0,   w), ...P(se,  w), ...P(se,  hw),
                ...P(L,   0),
                ...P(se, -hw), ...P(se, -w), ...P(0,  -w)
            ];
            gfx.lineStyle(2, EDGE, 0.9);
            gfx.beginFill(AMBER, 0.34);
            gfx.drawPolygon(pts);
            gfx.endFill();
            /* Origin ring — "shoved from here". */
            gfx.lineStyle(2, AMBER, 0.9);
            gfx.beginFill(EDGE, 0.25);
            gfx.drawCircle(origin.x, origin.y, Math.max(5, gs * 0.09));
            gfx.endFill();
        };

        const onMove = (event) => {
            try { world = event.getLocalPosition(canvas.stage); } catch (_) { /* ignore */ }
            draw();
        };
        const cleanup = () => {
            try { canvas.stage.off("pointermove", onMove); } catch (_) {}
            try { document.removeEventListener("pointerdown", onDown, { capture: true }); } catch (_) {}
            try { document.removeEventListener("contextmenu", onCtx, { capture: true }); } catch (_) {}
            try { window.removeEventListener("keydown", onKey, { capture: true }); } catch (_) {}
            try { if (canvas.app?.view) canvas.app.view.style.cursor = ""; } catch (_) {}
            try { gfx?.parent?.removeChild(gfx); gfx?.destroy(); } catch (_) {}
        };
        const finish = (val) => {
            if (done) return;
            done = true;
            cleanup();
            resolve(val);
        };
        const dirTo = (p) => {
            if (!p) return null;
            const dx = Number(p.x) - Number(origin.x);
            const dy = Number(p.y) - Number(origin.y);
            const len = Math.hypot(dx, dy);
            return len > 0 ? { x: dx / len, y: dy / len } : null;
        };
        const onDown = (event) => {
            if (event.button !== 0) return;   // left-click picks; right cancels below
            event.preventDefault();
            event.stopPropagation();
            finish(dirTo(world ?? canvas.mousePosition ?? null));
        };
        const onCtx = (event) => {
            event.preventDefault();
            event.stopPropagation();
            finish(backOnRightClick ? PICK_DIRECTION_BACK : null);
        };
        const onKey = (event) => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                finish(null);
            }
        };

        canvas.stage.on("pointermove", onMove);
        document.addEventListener("pointerdown", onDown, { capture: true, passive: false });
        document.addEventListener("contextmenu", onCtx, { capture: true });
        window.addEventListener("keydown", onKey, { capture: true });
        try { if (canvas.app?.view) canvas.app.view.style.cursor = "crosshair"; } catch (_) {}

        try {
            ui.notifications?.info(promptText
                ?? game.i18n?.localize?.("WITCHER.Brawl.SlamPickDirection")
                ?? "Click where to slam the target (right-click or Esc to cancel).");
        } catch (_) { /* best-effort */ }
    });
}
