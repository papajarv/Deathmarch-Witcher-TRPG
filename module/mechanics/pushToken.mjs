/**
 * pushToken — knockback movement primitive.
 *
 * Moves a token directly AWAY from a source point by a given distance in
 * scene metres. If a wall (or other movement blocker) intercepts the
 * straight-line path, the move is truncated to the collision point so
 * the token lands flush against the obstacle instead of clipping through.
 *
 * Used today by the Push Kick brawl action; designed as a general
 * primitive so future rider effects (Aard shockwave, charge slam, etc.)
 * can plug in without reinventing the maths.
 *
 * Distance conversion:
 *   pixels = metres × scene.grid.size / scene.grid.distance
 * so a 3 m push on a 100 px / 1.5 m scene is 200 px of straight-line
 * travel from the token's centre.
 *
 * Wall test uses the Foundry v13 polygon backend
 * (`CONFIG.Canvas.polygonBackends.move`) with `type: "move"` so the same
 * walls that block token drag also stop a push. If the backend isn't
 * available (older Foundry / test harness), we fall back to the full
 * distance — better a clean move than an aborted rider.
 *
 * Ownership: this file assumes the caller can write to `token.document`.
 * The socket-routed sender in setup/socketHook.mjs proxies through the
 * GM when the pusher lacks owner permission on the target token — call
 * `emitPushToken(...)` there rather than importing this directly if the
 * caller might be a player pushing an NPC.
 */

/** Small padding (in pixels) between the token's leading edge and the
 *  wall it collided with — keeps the token from visually overlapping
 *  the wall line. One pixel is enough on any grid the system supports. */
const WALL_STANDOFF_PX = 1;

/**
 * @param {object}  opts
 * @param {Token}   opts.token          the target Token PlaceableObject
 * @param {{x:number,y:number}} opts.sourcePoint  the point the force is
 *                                                coming FROM (usually
 *                                                the pusher's centre)
 * @param {number}  opts.distanceMeters positive metres to push
 * @returns {Promise<{moved:number, hitWall:boolean}|null>}
 */
export async function pushToken({ token, sourcePoint, distanceMeters }) {
    if (!token || !sourcePoint) return null;
    const dist = Number(distanceMeters);
    if (!Number.isFinite(dist) || dist <= 0) return null;

    const scene = canvas?.scene;
    const grid  = scene?.grid;
    if (!grid) return null;

    const gridSize = Number(grid.size) || 100;
    const gridDist = Number(grid.distance) || 1.5;
    if (!(gridSize > 0) || !(gridDist > 0)) return null;

    /* Origin: the token's on-canvas centre. Fall back to (x + w/2, y +
     * h/2) for cases where `center` isn't populated (headless / test). */
    const cx = Number(token.center?.x ?? (token.x + (token.w ?? 0) / 2));
    const cy = Number(token.center?.y ?? (token.y + (token.h ?? 0) / 2));
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;

    /* Direction: unit vector pointing away from the source. When the
     * source and the token share the same point we can't derive a
     * direction — bail rather than pick an arbitrary axis. */
    const vx = cx - Number(sourcePoint.x);
    const vy = cy - Number(sourcePoint.y);
    const mag = Math.hypot(vx, vy);
    if (mag === 0) return null;
    const ux = vx / mag;
    const uy = vy / mag;

    const distPx = dist * gridSize / gridDist;
    let endX = cx + ux * distPx;
    let endY = cy + uy * distPx;
    let hitWall = false;

    /* Wall test — take the closest collision along the straight line
     * from the token's centre to the intended endpoint. Restricted to
     * walls that block MOVEMENT (`wall.document.move !== NONE`);
     * light-only, sight-only, and sound-only walls DO NOT stop the
     * push. This is what `CONFIG.Canvas.polygonBackends.move` combined
     * with `type: "move"` guarantees — the backend's wall filter
     * excludes any wall whose move restriction is NONE, and the
     * `type` narrows the sweep to that same channel.
     *
     * Falls back to the raw endpoint if the backend isn't reachable
     * (older Foundry builds / test harness); wall clipping is a
     * "nice to have", not a correctness gate on the push itself. */
    try {
        const backend = CONFIG?.Canvas?.polygonBackends?.move;
        const collision = backend?.testCollision?.(
            { x: cx, y: cy },
            { x: endX, y: endY },
            { type: "move", mode: "closest" }
        );
        if (collision && Number.isFinite(collision.x) && Number.isFinite(collision.y)) {
            /* Step the endpoint back a hair so the token doesn't render
             * ON the wall line — matches how Foundry's token drag
             * behaves when a move ends flush against a wall. */
            endX = collision.x - ux * WALL_STANDOFF_PX;
            endY = collision.y - uy * WALL_STANDOFF_PX;
            hitWall = true;
        }
    } catch (err) {
        console.warn("witcher-ttrpg-death-march | pushToken wall test failed", err);
    }

    /* Convert the target CENTRE back to a token-document top-left
     * corner. Token width/height are declared in grid cells (1 = one
     * cell), so the pixel half-extents come from grid.size. */
    const doc   = token.document ?? token;
    const wCells = Number(doc.width)  || 1;
    const hCells = Number(doc.height) || 1;
    const halfW  = (wCells * gridSize) / 2;
    const halfH  = (hCells * gridSize) / 2;
    const newX = Math.round(endX - halfW);
    const newY = Math.round(endY - halfH);

    try {
        /* Bypass the movement policy — a push is an EXTERNAL force, not
         * the target's own action, so the target's turn / action-locked /
         * budget-used gates in canvas-movement.mjs shouldn't cancel it
         * or charge it against the target's SPD. Mirrors the
         * `wdmFreeReposition` pattern used for the Reposition defense. */
        await doc.update({ x: newX, y: newY }, { wdmForcedMove: true, animate: true });
    } catch (err) {
        console.warn("witcher-ttrpg-death-march | pushToken update failed", err);
        return null;
    }

    const movedPx = Math.hypot(endX - cx, endY - cy);
    const movedM  = movedPx * gridDist / gridSize;
    return { moved: movedM, hitWall };
}
