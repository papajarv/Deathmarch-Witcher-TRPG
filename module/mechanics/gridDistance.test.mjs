/**
 * gridDistance — the distance rule, with and without a grid.
 *
 * These are arithmetic, so a stub is honest here: there is no Foundry
 * behaviour being assumed, only `canvas.scene.grid` read as data. The point
 * the suite is defending is that turning the grid off must not change any
 * answer a gridded scene already gives — the tile model has to survive
 * intact, or every reach and range call in the system quietly shifts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { isGridless, gridPx, gridMetres, metresToPx, pxToMetres,
         oversizeMetres, separationMetres, meleeReachMetres,
         graceMetres } from "./gridDistance.mjs";

/* 100 px squares worth 2 m each — the scene the bug was found on. */
function scene({ type }) {
    globalThis.canvas = { scene: { grid: { type, size: 100, distance: 2 } } };
}
const SQUARE = 1, GRIDLESS = 0;

/** A token stub: centre in px, footprint in whole squares. */
function tok(x, y, squares = 1) {
    const side = squares * 100;
    return { center: { x, y }, bounds: { width: side, height: side } };
}

test("scene readers report the grid they are given", () => {
    scene({ type: SQUARE });
    assert.equal(isGridless(), false);
    assert.equal(gridPx(), 100);
    assert.equal(gridMetres(), 2);
    assert.equal(metresToPx(6), 300);
    assert.equal(pxToMetres(300), 6);
    assert.equal(graceMetres(), 1);

    scene({ type: GRIDLESS });
    assert.equal(isGridless(), true);
    assert.equal(gridPx(), 100, "gridless scenes still size tokens in squares");
});

test("on a grid, distance stays Chebyshev — a diagonal neighbour is one tile", () => {
    scene({ type: SQUARE });
    assert.equal(separationMetres(tok(0, 0), tok(100, 0)), 2, "orthogonal neighbour");
    assert.equal(separationMetres(tok(0, 0), tok(100, 100)), 2, "diagonal neighbour is ALSO one tile");
    assert.equal(separationMetres(tok(0, 0), tok(300, 0)), 6, "three tiles out");
});

test("without a grid, distance is the straight line", () => {
    scene({ type: GRIDLESS });
    assert.equal(separationMetres(tok(0, 0), tok(100, 0)), 2);
    const diag = separationMetres(tok(0, 0), tok(100, 100));
    assert.ok(Math.abs(diag - 2.828) < 0.01, `diagonal measures ${diag}, expected ~2.83`);
});

test("a big token is reached at its flank, not its middle", () => {
    scene({ type: GRIDLESS });
    assert.equal(oversizeMetres(tok(0, 0, 1)), 0, "a medium token has no oversize");
    assert.equal(oversizeMetres(tok(0, 0, 2)), 1, "a 2x2 reaches a square further out");
    assert.equal(oversizeMetres(tok(0, 0, 3)), 2);
    /* Centre-to-centre 6 m, but three of those metres are the ogre. */
    assert.equal(separationMetres(tok(0, 0, 1), tok(300, 0, 2)), 5);
});

test("oversize is a GRIDLESS correction only — the tile model already had it", () => {
    scene({ type: SQUARE });
    assert.equal(separationMetres(tok(0, 0, 1), tok(300, 0, 2)), 6,
        "on a grid the cell footprint does this job; subtracting again would double-count");
});

test("melee reach in metres matches the tile count it replaces", () => {
    scene({ type: SQUARE });
    assert.equal(meleeReachMetres(0), 2, "a plain weapon reaches one square");
    assert.equal(meleeReachMetres(2), 4, "Long Reach: 1 + floor(2/2) = 2 tiles");
    assert.equal(meleeReachMetres(3), 4, "3 m does not buy a second whole tile at 2 m/tile");
    assert.equal(meleeReachMetres(6), 8, "Extreme Reach");
});

test("without a grid, reach is the weapon's actual metres — no rounding to tiles", () => {
    scene({ type: GRIDLESS });
    assert.equal(meleeReachMetres(0), 2);
    assert.equal(meleeReachMetres(3), 5, "the 3 m a tile count would have thrown away is kept");
    assert.equal(meleeReachMetres(6), 8);
});

test("a missing position is null, not zero — out of reach beats falsely adjacent", () => {
    scene({ type: SQUARE });
    assert.equal(separationMetres(null, tok(0, 0)), null);
    assert.equal(separationMetres(tok(0, 0), { center: { x: NaN, y: 0 } }), null);
});
