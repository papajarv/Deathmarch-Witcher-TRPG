import test from "node:test";
import assert from "node:assert/strict";
import { drawFace, rollDice } from "./dice.mjs";

const seq = (xs) => { let i = 0; return () => (i < xs.length ? xs[i++] : 0); };

test("a fair die maps the unit interval evenly across 1–6", () => {
    // total = 6; r = rng()*6 lands in band [v-1, v) → value v.
    assert.equal(drawFace([1, 1, 1, 1, 1, 1], seq([0.0])), 1);
    assert.equal(drawFace([1, 1, 1, 1, 1, 1], seq([0.99])), 6);
    assert.equal(drawFace([1, 1, 1, 1, 1, 1], seq([0.5])), 4); // 0.5*6=3.0 → band [3,4) → 4
});

test("a loaded die favours its heavy face", () => {
    // Heavy 6: weights total 15, face 6 occupies [10,15) → 1/3 of the interval.
    const loaded = [1, 1, 1, 1, 1, 10];
    assert.equal(drawFace(loaded, seq([0.99])), 6); // r=14.85 → face 6
    assert.equal(drawFace(loaded, seq([0.0])), 1);  // r=0 → face 1
});

test("a zero-weight face never appears", () => {
    const noFives = [1, 1, 1, 1, 0, 1];
    for (let i = 0; i <= 20; i++) {
        const v = drawFace(noFives, seq([i / 21]));
        assert.notEqual(v, 5);
    }
});

test("a degenerate (all-zero) profile falls back to uniform", () => {
    assert.equal(drawFace([0, 0, 0, 0, 0, 0], seq([0.0])), 1);
    assert.equal(drawFace([0, 0, 0, 0, 0, 0], seq([0.999])), 6);
});

test("missing/invalid weights are treated as fair", () => {
    assert.equal(drawFace(undefined, seq([0.0])), 1);
    assert.equal(drawFace([NaN, -3, "x", null, undefined, 0], seq([0.0])), 1); // all invalid → uniform
});

test("rollDice(count) rolls that many fair dice", () => {
    const hand = rollDice(4, seq([0.0, 0.99, 0.5, 0.0]));
    assert.equal(hand.length, 4);
    assert.deepEqual(hand, [1, 6, 4, 1]);
});

test("rollDice(per-die profiles) draws each die from its own profile", () => {
    const fair = [1, 1, 1, 1, 1, 1];
    const heavySix = [0, 0, 0, 0, 0, 1];
    const hand = rollDice([fair, heavySix, fair], seq([0.0, 0.0, 0.99]));
    assert.equal(hand[1], 6);              // forced by the heavy-6 profile
    assert.deepEqual(hand, [1, 6, 6]);
});
