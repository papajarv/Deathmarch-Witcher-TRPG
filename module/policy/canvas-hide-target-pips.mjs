/**
 * Custom target pip rendering.
 *
 * Replaces Foundry's default cross-user target pip (a small colored dot
 * above the token, one per other user targeting it) with a CROSSHAIR
 * shape tinted in each player's user color — outer ring, plus marks,
 * center dot. Conveys the "targeting" semantics visually instead of
 * "some colored dot is here" while still preserving who-targets-whom
 * information.
 *
 * Implementation: monkey-patch `Token.prototype._drawTargetPips`
 * immediately when registerHideTargetPips() is called. This runs from
 * registerHooks() during the Foundry `setup` lifecycle, well after the
 * Token class is defined — wrapping in `Hooks.once("init")` was a bug
 * (init has already fired by setup) and that's why the original patch
 * never landed and the default colored dot stayed visible.
 *
 * Positioning: pips sit above the token, evenly spaced. Each pip is
 * `PIP_RADIUS` wide; spacing is `PIP_GAP` between centers.
 */

const PIP_RADIUS = 10;
const PIP_GAP    = 4;
const PIP_OFFSET_Y = 14;   // gap between token top edge and pip ring center

/* Convert a user's color hex string ("#a93232") to a PIXI tint number. */
function parseUserColor(user) {
    let raw = user?.color;
    if (raw && typeof raw === "object" && "css" in raw) raw = raw.css;       // Foundry v13+ Color obj
    if (raw && typeof raw === "object" && "toString" in raw) raw = raw.toString();
    const hex = String(raw ?? "#ff3030").replace("#", "").slice(0, 6).padStart(6, "0");
    return parseInt(hex, 16) || 0xff3030;
}

export function registerHideTargetPips() {
    const TokenCls =
          foundry.canvas?.placeables?.Token
       ?? CONFIG.Token?.objectClass;
    if (!TokenCls?.prototype) return;
    TokenCls.prototype._drawTargetPips = function() {
        const g = this.targetPips;
        if (!g) return;
        try { g.clear(); } catch (_) { return; }
        if (!this.targeted?.size) return;
        const otherUsers = Array.from(this.targeted).filter(u => u !== game.user);
        if (!otherUsers.length) return;

        const w = Number(this.w) || Number(this.document?.width) * (canvas?.scene?.grid?.size ?? 100);
        const r = PIP_RADIUS;
        const stride = (r * 2) + PIP_GAP;
        const rowWidth = otherUsers.length * stride - PIP_GAP;
        const startCx = (w - rowWidth) / 2 + r;
        const cy = -PIP_OFFSET_Y;

        for (let i = 0; i < otherUsers.length; i++) {
            const u = otherUsers[i];
            const color = parseUserColor(u);
            const cx = startCx + i * stride;
            /* Outer ring underlay (dark, slightly larger) for legibility
             * against bright maps. */
            g.lineStyle(1.5, 0x000000, 0.55);
            g.beginFill(0x000000, 0.30);
            g.drawCircle(cx, cy, r + 1);
            g.endFill();
            /* Ring in the targeting user's color. */
            g.lineStyle(2, color, 1);
            g.beginFill(color, 0.10);
            g.drawCircle(cx, cy, r);
            g.endFill();
            /* Crosshair cross marks (4 short ticks from the ring inward). */
            g.lineStyle(2, color, 1);
            const inner = r * 0.45;
            const outer = r * 0.95;
            g.moveTo(cx, cy - inner).lineTo(cx, cy - outer);     // N
            g.moveTo(cx, cy + inner).lineTo(cx, cy + outer);     // S
            g.moveTo(cx + inner, cy).lineTo(cx + outer, cy);     // E
            g.moveTo(cx - inner, cy).lineTo(cx - outer, cy);     // W
            /* Center dot. */
            g.lineStyle(0);
            g.beginFill(color, 1);
            g.drawCircle(cx, cy, 1.8);
            g.endFill();
        }
    };
}
