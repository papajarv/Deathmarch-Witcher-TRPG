/**
 * Popup scale hook.
 *
 * Stamps `data-wdm-scaled="1"` on floating popups after they render.
 * The CSS rule keyed on that attribute applies `zoom:` (see
 * styles/tokens.css). Zoom does not compose with Foundry's transform-
 * based close animation, so the earlier "strip the attribute before
 * close" contract this file used to rely on is no longer load-bearing
 * for correctness (the previous `transform: scale()` implementation
 * needed it — but `closeApplicationV2` fires AFTER `_animate("out")`
 * in current Foundry V2, and the unstamp was consistently too late,
 * producing a ~2-second black frame while the two transforms fought).
 * The close hook is still called to keep the DOM clean if the same
 * node is later reused.
 *
 * Only stamps FLOATING popouts (`body > .application` and legacy
 * `.window-app`), plus `.dialog`. Sidebar-nested apps (chat log,
 * combat tracker) don't match — they scale via the sidebar rule.
 */

const SCALE_ATTR = "data-wdm-scaled";

/* True when the element is a floating popup we want to scale. */
function isFloatingPopup(el) {
    if (!el || el.nodeType !== 1) return false;
    /* Sidebar-nested apps live inside #sidebar and shouldn't scale. */
    if (el.closest?.("#sidebar")) return false;
    if (el.matches?.(".window-app, .dialog")) return true;
    if (el.parentElement === document.body && el.classList?.contains?.("application")) return true;
    /* Our own floating container popup (hotbar / mount container) —
     * body-level absolute-positioned float. Needs the same
     * transform-scale treatment as Foundry's application popups.
     * The INLINE version of this class (rendered inside #wou-inventory)
     * already scales via its parent's zoom, so gate on direct
     * body-child to avoid double-scaling those. */
    if (el.parentElement === document.body && el.classList?.contains?.("wou-container-popup")) return true;
    /* Custom Witcher token HUD — replaces Foundry's default token HUD,
     * body-level fixed-positioned. Same transform-scale treatment as
     * popups so it tracks --wdm-popup-scale (Auto/Manual keep this in
     * sync with the UI slider; Detailed lets it move independently). */
    if (el.id === "wdm-token-hud") return true;
    return false;
}

function stamp(el) {
    if (!isFloatingPopup(el)) return;
    if (el.getAttribute(SCALE_ATTR) === "1") return;
    el.setAttribute(SCALE_ATTR, "1");
}

function unstamp(el) {
    if (!el?.nodeType || el.nodeType !== 1) return;
    el.removeAttribute(SCALE_ATTR);
}

/* Read the effective popup zoom factor from the CSS custom property
 * that drives the `zoom:` rule. Fallback chain matches the CSS:
 * --wdm-popup-scale → --wdm-scale → 1. */
function readPopupZoom() {
    const cs = getComputedStyle(document.documentElement);
    return parseFloat(cs.getPropertyValue("--wdm-popup-scale"))
        || parseFloat(cs.getPropertyValue("--wdm-scale"))
        || 1;
}

/* Foundry's chat-log flush confirm ("Clean chat log") ships with a
 * hard-coded position anchored to the bottom-right of the viewport:
 *
 *     position: { top: window.innerHeight - 150, left: window.innerWidth - 720 }
 *
 * (see foundry.mjs ChatLog#flush). Under our popup `zoom`, those raw
 * pixel offsets multiply by the scale factor, which shoves the dialog
 * off-screen once the UI scale rises above ~1.05 on typical viewports.
 * The dialog is a small yes/no confirm — no anchoring semantics — so
 * recenter it after render. Identified by its unlocalized window title
 * key which is what DialogV2.confirm receives ("CHAT.FlushTitle").
 *
 * The math accounts for the zoom transform: getBoundingClientRect
 * returns POST-zoom visual pixels, and `window.inner*` is also visual;
 * setPosition writes PRE-zoom CSS pixels, so we divide by zoom at the
 * end to convert. */
function recenterFlushDialog(app, el) {
    if (app?.options?.window?.title !== "CHAT.FlushTitle") return;
    requestAnimationFrame(() => {
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const zoom = readPopupZoom();
        const visualLeft = Math.max(0, (window.innerWidth  - rect.width)  / 2);
        const visualTop  = Math.max(0, (window.innerHeight - rect.height) / 2);
        try { app.setPosition({ left: visualLeft / zoom, top: visualTop / zoom }); }
        catch (_) { /* app closed between render + rAF — nothing to do */ }
    });
}

/* Teach Foundry's ApplicationV2 clamp math about our CSS `zoom`.
 *
 * ROOT CAUSE this addresses:
 *   User drag-resizes and drag-moves route through
 *   `ApplicationV2#_updatePosition` (foundry.mjs ~30971). Its clamps read
 *   the raw viewport (`documentElement.clientWidth/clientHeight`) but
 *   compute `maxLeft = clientWidth - width` in Foundry's own CSS-pixel
 *   space — so under our `zoom: 1.2` a user can drag `left` to 1570 on a
 *   1920 viewport, painting the visual right edge at (1570+350)×1.2 =
 *   2304 which is 384px off-screen.
 *
 *   Foundry's own `position.scale` field, when non-1, IS folded into the
 *   clamp math (line 30996: `maxWidth = clientWidth / scale`, line 31026:
 *   `maxLeft = clientWidth - width*scale`). But Foundry also applies
 *   `transform: scale()` when scale ≠ 1 (line 31052) — and the whole
 *   reason we picked CSS `zoom` was that `transform: scale()` fights
 *   Foundry's close animation (see file docstring above + memory
 *   `project-deathmarch-ui-perf`).
 *
 * FIX:
 *   Wrap `_updatePosition`. Before calling Foundry's version, inject our
 *   zoom into `position.scale` so the clamp math accounts for it. After
 *   the returned result, reset `scale: 1` so Foundry doesn't apply
 *   `transform: scale()` on top of our `zoom` CSS. Foundry's own clamp
 *   respects the visual size; our `zoom` still handles the scaling.
 *
 *   Gated on `isFloatingPopup(#element)` so sidebar-nested apps and
 *   anything we don't scale doesn't get a spurious clamp change. */
function installPositionZoomClamp() {
    const AppV2 = foundry?.applications?.api?.ApplicationV2;
    const proto = AppV2?.prototype;
    if (!proto || typeof proto._updatePosition !== "function") return;
    if (proto.__wdmZoomClampInstalled) return;
    const original = proto._updatePosition;
    proto._updatePosition = function _updatePositionZoomAware(position) {
        const el = this.element;
        if (!isFloatingPopup(el)) return original.call(this, position);
        const zoom = readPopupZoom();
        if (zoom === 1) return original.call(this, position);
        /* Preserve the caller-supplied scale (usually undefined) so we
         * restore it exactly, and only fold zoom in FOR THE CLAMP PASS. */
        const callerScale = position.scale;
        position.scale = zoom;
        const result = original.call(this, position);
        position.scale = callerScale;
        if (!result) return result;
        /* Reset scale on the RESULT so Foundry's #applyPosition doesn't
         * emit `transform: scale(zoom)` on top of our CSS `zoom`. */
        result.scale = 1;
        /* Correct the left/top clamp math for `zoom` semantics.
         *
         * Foundry's original computes `maxLeft = clientWidth - scaledWidth`
         * (line 31026). That's right for `transform: scale()` because
         * transform leaves the CSS positioning origin untouched — only the
         * visual paint scales. But CSS `zoom` scales BOTH layout AND
         * positioning: `visual_left = css_left × zoom`. So the correct
         * clamp under zoom is `maxLeft = (clientWidth / zoom) - css_width`,
         * not `clientWidth - css_width × zoom`. Without this correction
         * the user can drag a small popup far enough right that its
         * VISUAL right edge escapes the viewport even though Foundry
         * thought it clamped. Redo the clamp with the right formula. */
        const doc = this.element.ownerDocument.documentElement;
        const clientWidth  = doc.clientWidth;
        const clientHeight = doc.clientHeight;
        if (typeof result.width === "number") {
            const maxLeft = Math.max((clientWidth / zoom) - result.width, 0);
            result.left = Math.min(Math.max(result.left, 0), maxLeft);
        }
        if (typeof result.height === "number") {
            const maxTop = Math.max((clientHeight / zoom) - result.height, 0);
            result.top = Math.min(Math.max(result.top, 0), maxTop);
        }
        return result;
    };
    proto.__wdmZoomClampInstalled = true;
}

/* Teach Foundry's `Draggable` about our CSS `zoom` so user drag-moves
 * and drag-resizes don't overshoot.
 *
 * ROOT CAUSE this addresses:
 *   `_onDragMouseMove` (foundry.mjs ~41851) applies raw pointer deltas
 *   directly to position.left/top — no scale compensation at all.
 *   `_onResizeMouseMove` (foundry.mjs ~41912) divides by
 *   `this.app.position.scale ?? 1` — but our `_updatePosition` patch
 *   forces `position.scale = 1` (to prevent Foundry's transform:scale
 *   from double-scaling our CSS zoom), so this divisor is always 1.
 *
 *   Net effect under zoom 1.2: the user grabs the resize handle, the
 *   pointer moves 100 visual pixels right, Foundry adds 100 to CSS
 *   width, our zoom multiplies to a 120-visual-pixel resize. Dragging
 *   compounds — the popup can drift and grow off-screen.
 *
 * FIX:
 *   Wrap both handlers. Divide the pointer deltas by `readPopupZoom()`
 *   so `deltaCSS × zoom = deltaVisual` matches the user's actual pointer
 *   movement. The `_updatePosition` patch above still clamps the result
 *   to the visual viewport, so escaping the edge is caught either way,
 *   but this stops the popup from tracking the pointer at the wrong
 *   ratio in the first place. */
function installDraggableZoom() {
    const Draggable = foundry?.appv1?.ui?.Draggable ?? globalThis.Draggable;
    const proto = Draggable?.prototype;
    if (!proto || typeof proto._onDragMouseMove !== "function") return;
    if (proto.__wdmZoomDragInstalled) return;

    const origDrag = proto._onDragMouseMove;
    proto._onDragMouseMove = function _onDragMouseMoveZoomAware(event) {
        const el = this.app?.element;
        if (!isFloatingPopup(el)) return origDrag.call(this, event);
        const zoom = readPopupZoom();
        if (zoom === 1) return origDrag.call(this, event);
        event.preventDefault();
        const now = Date.now();
        if ((now - (this._wdmMoveTime ?? 0)) < (1000 / 60)) return;
        this._wdmMoveTime = now;
        this.app.setPosition({
            left: this.position.left + (event.clientX - this._initial.x) / zoom,
            top:  this.position.top  + (event.clientY - this._initial.y) / zoom
        });
    };

    const origResize = proto._onResizeMouseMove;
    proto._onResizeMouseMove = function _onResizeMouseMoveZoomAware(event) {
        const el = this.app?.element;
        if (!isFloatingPopup(el)) return origResize.call(this, event);
        const zoom = readPopupZoom();
        if (zoom === 1) return origResize.call(this, event);
        event.preventDefault();
        /* Foundry stores `position.scale` — we've reset it to 1. Divide
         * by zoom instead. Keeps the RTL sign flip. */
        let deltaX = (event.clientX - this._initial.x) / zoom;
        const deltaY = (event.clientY - this._initial.y) / zoom;
        if (this.resizable?.rtl === true) deltaX *= -1;
        const newPosition = {
            width:  this.position.width  + deltaX,
            height: this.position.height + deltaY
        };
        if (this.resizable?.resizeX === false) delete newPosition.width;
        if (this.resizable?.resizeY === false) delete newPosition.height;
        this.app.setPosition(newPosition);
    };
    proto.__wdmZoomDragInstalled = true;
}

export function installPopupScale() {
    installPositionZoomClamp();
    installDraggableZoom();
    /* Foundry v13: renderApplication hook fires for both new
     * ApplicationV2 and legacy Application instances after their
     * initial render. The second arg is a jQuery-like object in
     * legacy paths and an HTMLElement in v13; unwrap defensively. */
    Hooks.on("renderApplication", (_app, html) => {
        const el = (html instanceof HTMLElement) ? html : html?.[0] ?? null;
        stamp(el);
    });
    Hooks.on("renderApplicationV2", (app, el) => {
        stamp(el);
        recenterFlushDialog(app, el);
    });

    /* DOM hygiene only — with the `zoom` scaling path the animation-
     * composition problem this used to guard against is gone. Keep the
     * unstamp so the attribute doesn't linger on nodes Foundry may
     * reuse. */
    Hooks.on("closeApplication",   (_app, html) => {
        const el = (html instanceof HTMLElement) ? html : html?.[0] ?? null;
        unstamp(el);
    });
    Hooks.on("closeApplicationV2", (_app, el) => unstamp(el));

    /* Backup catch-all: a MutationObserver on <body> watches for
     * `.application` elements added as direct children of body
     * (Foundry's late-render or lazy-init paths sometimes miss the
     * hooks above). Stamps once on insertion. */
    const bodyObs = new MutationObserver(records => {
        for (const rec of records) {
            for (const n of rec.addedNodes) stamp(n);
        }
    });
    bodyObs.observe(document.body, { childList: true });
}
