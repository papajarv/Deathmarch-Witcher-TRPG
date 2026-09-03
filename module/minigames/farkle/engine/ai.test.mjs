import test from "node:test";
import assert from "node:assert/strict";
import { chooseSetAside, decideContinue, competence } from "./ai.mjs";
import { scoreSelection } from "./scoring.mjs";

const sorted = (a) => [...a].sort();
// Deterministic RNG that yields a fixed sequence, then 0.
const seq = (xs) => { let i = 0; return () => (i < xs.length ? xs[i++] : 0); };

test("keeps all six on a special combo (hot dice)", () => {
    assert.deepEqual(sorted(chooseSetAside([2, 2, 3, 3, 4, 4])), sorted([2, 2, 3, 3, 4, 4]));
    assert.deepEqual(sorted(chooseSetAside([1, 2, 3, 4, 5, 6])), sorted([1, 2, 3, 4, 5, 6]));
});

test("takes whole triples", () => {
    assert.deepEqual(sorted(chooseSetAside([4, 4, 4, 2, 3, 6])), sorted([4, 4, 4]));
});

test("always keeps single 1s", () => {
    const keep = chooseSetAside([1, 2, 3, 4, 6, 2]);
    assert.deepEqual(keep, [1]);
});

test("takes a triple AND loose 5s alongside it", () => {
    // The reported failure: three 3s + two 5s — the 5s are guaranteed points,
    // never forfeit them just to reroll more dice.
    assert.deepEqual(sorted(chooseSetAside([3, 3, 3, 5, 5, 2])), sorted([3, 3, 3, 5, 5]));
});

test("always takes every loose scoring single", () => {
    assert.deepEqual(sorted(chooseSetAside([1, 5, 2, 2, 3, 4])), sorted([1, 5]));
});

test("keeps a 5 when it is the only score", () => {
    assert.deepEqual(chooseSetAside([5, 2, 3, 4, 6, 6]), [5]);
    assert.deepEqual(chooseSetAside([5]), [5]);
});

test("keeps both the 1 and the 5 in a thin hand", () => {
    assert.deepEqual(sorted(chooseSetAside([1, 5])), sorted([1, 5]));
});

test("every chooseSetAside result is a valid scoring selection", () => {
    const rolls = [[1, 5, 2, 3, 4, 6], [4, 4, 4, 2, 3, 6], [5, 2, 3, 4, 6, 6], [1, 1, 5, 2], [6, 6, 6, 1, 5]];
    for (const r of rolls) {
        const keep = chooseSetAside(r);
        const { valid, points } = scoreSelection(keep);
        assert.ok(valid && points > 0, `invalid keep for ${r}: ${keep}`);
    }
});

test("banks when the total would win", () => {
    assert.equal(decideContinue({ turnTotal: 500, diceLeft: 4, banked: 3600, target: 4000 }), false);
});

test("banks a big total on a thin hand", () => {
    assert.equal(decideContinue({ turnTotal: 800, diceLeft: 2, banked: 0, target: 4000 }), false);
});

test("rolls again with a small total and many dice", () => {
    assert.equal(decideContinue({ turnTotal: 150, diceLeft: 5, banked: 0, target: 4000 }), true);
});

test("presses harder when the opponent is near the target", () => {
    const ctx = { turnTotal: 600, diceLeft: 3, banked: 0, target: 4000 };
    assert.equal(decideContinue({ ...ctx }), false);                  // 600 > 519 → bank
    assert.equal(decideContinue({ ...ctx, oppBanked: 3200 }), true);  // 519×1.4=727 > 600 → press on
});

test("competence maps skill 2→0, 16→~average, 30→1", () => {
    assert.equal(competence(2), 0);
    assert.equal(competence(1), 0);   // below floor still clamps to 0
    assert.equal(competence(30), 1);
    assert.equal(competence(40), 1);
    assert.ok(competence(16) > 0.45 && competence(16) < 0.55);
});

test("a low-skill AI leaves guaranteed points on the table", () => {
    // skill 1 → competence 0 → always blunders. The gate consumes one draw;
    // then each loose die is a coin flip (kept on ≥0.5). Here the 1 is dropped.
    const keep = chooseSetAside([1, 5, 2, 3, 4, 6], { skill: 1, rng: seq([0.9, 0.2, 0.9]) });
    assert.deepEqual(sorted(keep), [5]);
    const { valid, points } = scoreSelection(keep);
    assert.ok(valid && points > 0);
});

test("a blunder never splits an n-of-a-kind block", () => {
    const keep = chooseSetAside([4, 4, 4, 2, 3, 6], { skill: 1, rng: seq([0.9]) });
    assert.deepEqual(sorted(keep), sorted([4, 4, 4]));
});

test("a blunder never returns an empty/invalid selection", () => {
    const keep = chooseSetAside([1, 5], { skill: 1, rng: seq([0.9, 0.1, 0.1]) });
    assert.ok(keep.length >= 1);
    const { valid, points } = scoreSelection(keep);
    assert.ok(valid && points > 0);
});

test("perfect skill (default) plays optimally and ignores rng", () => {
    const rng = () => { throw new Error("rng should not be consulted at perfect skill"); };
    assert.deepEqual(sorted(chooseSetAside([1, 5, 2, 2, 3, 4], { rng })), sorted([1, 5]));
    assert.equal(decideContinue({ turnTotal: 600, diceLeft: 3, banked: 0, target: 4000, rng }), false);
});

test("a reckless low-skill AI presses past the optimal bank point", () => {
    const ctx = { turnTotal: 600, diceLeft: 3, banked: 0, target: 4000 };
    assert.equal(decideContinue({ ...ctx }), false);                       // optimal banks
    // skill 1, rng=1 → threshold 519×1.8=934 > 600 → presses on (reckless)
    assert.equal(decideContinue({ ...ctx, skill: 1, rng: seq([1]) }), true);
});

test("even a fool banks a winning total", () => {
    const rng = () => { throw new Error("rng should not be consulted on a winning bank"); };
    assert.equal(decideContinue({ turnTotal: 500, diceLeft: 4, banked: 3600, target: 4000, skill: 1, rng }), false);
});
