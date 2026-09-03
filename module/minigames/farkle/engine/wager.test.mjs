import test from "node:test";
import assert from "node:assert/strict";
import { aiSkill, canAfford, pickDice } from "./wager.mjs";

const seq = (xs) => { let i = 0; return () => (i < xs.length ? xs[i++] : 0); };

test("aiSkill folds INT + EMP + Gambling and floors at 2", () => {
    assert.equal(aiSkill(6, 5, 5), 16);   // average
    assert.equal(aiSkill(10, 10, 10), 30); // 30 ⇒ perfect
    assert.equal(aiSkill(0, 0, 0), 2);     // statless actor is merely terrible
    assert.equal(aiSkill(), 2);            // generic / missing
});

test("canAfford compares purse to ante", () => {
    assert.equal(canAfford(50, 50), true);
    assert.equal(canAfford(49, 50), false);
    assert.equal(canAfford(0, 0), true);
});

test("pickDice pads a short bag with fair defaults", () => {
    const owned = [{ weights: [10, 1, 1, 1, 1, 1], faces: { 6: "x.png" } }];
    const hand = pickDice(owned, 6, seq([0]));
    assert.equal(hand.length, 6);
    assert.deepEqual(hand[0], { weights: [10, 1, 1, 1, 1, 1], faces: { 6: "x.png" } });
    for (let i = 1; i < 6; i++) assert.deepEqual(hand[i], { weights: null, faces: null });
});

test("pickDice with an empty bag is six fair dice", () => {
    const hand = pickDice([], 6);
    assert.equal(hand.length, 6);
    assert.ok(hand.every(p => p.weights === null && p.faces === null));
});

test("pickDice keeps every die when the bag exactly fits", () => {
    const owned = Array.from({ length: 6 }, (_, i) => ({ weights: null, faces: { 1: `d${i}.png` } }));
    const hand = pickDice(owned, 6);
    assert.deepEqual(hand.map(p => p.faces[1]).sort(), owned.map(p => p.faces[1]).sort());
});

test("pickDice randomly selects from a surplus bag and drops the rest", () => {
    const owned = Array.from({ length: 8 }, (_, i) => ({ weights: null, faces: { 1: `d${i}.png` } }));
    // rng forces i=0→j=0, i=1→j=1, ... (each pull stays in place) ⇒ first 6 chosen.
    const hand = pickDice(owned, 6, seq([0, 0, 0, 0, 0, 0]));
    assert.equal(hand.length, 6);
    assert.deepEqual(hand.map(p => p.faces[1]), ["d0", "d1", "d2", "d3", "d4", "d5"].map(s => `${s}.png`));
});

test("pickDice normalises missing weights/faces to null", () => {
    const hand = pickDice([{}], 1);
    assert.deepEqual(hand[0], { weights: null, faces: null });
});
