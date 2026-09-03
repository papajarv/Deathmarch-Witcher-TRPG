import test from "node:test";
import assert from "node:assert/strict";
import { scoreSelection, bestScoreFull, hasAnyScore } from "./scoring.mjs";

test("single 1 and 5", () => {
  assert.deepEqual(scoreSelection([1]), { valid: true, points: 100 });
  assert.deepEqual(scoreSelection([5]), { valid: true, points: 50 });
  assert.deepEqual(scoreSelection([1, 5]), { valid: true, points: 150 });
});

test("non-scoring singles are invalid", () => {
  assert.equal(scoreSelection([2]).valid, false);
  assert.equal(scoreSelection([3, 4]).valid, false);
  assert.equal(scoreSelection([1, 2]).valid, false); // the 2 is unconsumed
  assert.equal(scoreSelection([2, 2]).valid, false); // pair of 2s alone
});

test("three of a kind", () => {
  assert.deepEqual(scoreSelection([1, 1, 1]), { valid: true, points: 1000 });
  assert.deepEqual(scoreSelection([2, 2, 2]), { valid: true, points: 200 });
  assert.deepEqual(scoreSelection([3, 3, 3]), { valid: true, points: 300 });
  assert.deepEqual(scoreSelection([4, 4, 4]), { valid: true, points: 400 });
  assert.deepEqual(scoreSelection([5, 5, 5]), { valid: true, points: 500 });
  assert.deepEqual(scoreSelection([6, 6, 6]), { valid: true, points: 600 });
});

test("four/five/six of a kind multipliers", () => {
  assert.equal(scoreSelection([2, 2, 2, 2]).points, 400); // 200×2
  assert.equal(scoreSelection([2, 2, 2, 2, 2]).points, 600); // 200×3
  assert.equal(scoreSelection([2, 2, 2, 2, 2, 2]).points, 800); // 200×4
  assert.equal(scoreSelection([1, 1, 1, 1]).points, 2000); // 1000×2
  assert.equal(scoreSelection([1, 1, 1, 1, 1, 1]).points, 4000); // 1000×4
});

test("singles combined with triples", () => {
  assert.equal(scoreSelection([1, 1, 1, 5]).points, 1050);
  assert.equal(scoreSelection([5, 5, 5, 1, 1]).points, 700);
});

test("straight 1-6", () => {
  assert.deepEqual(scoreSelection([1, 2, 3, 4, 5, 6]), { valid: true, points: 1500 });
});

test("three pairs", () => {
  assert.deepEqual(scoreSelection([2, 2, 3, 3, 4, 4]), { valid: true, points: 1500 });
  assert.deepEqual(scoreSelection([1, 1, 5, 5, 6, 6]), { valid: true, points: 1500 });
});

test("four of a kind plus a pair", () => {
  // 4×3 + pair of 6: general invalid (6s unconsumed), special = 1500
  assert.deepEqual(scoreSelection([3, 3, 3, 3, 6, 6]), { valid: true, points: 1500 });
});

test("four of a kind + pair never scores below the four alone", () => {
  // four 1s + pair of 4s: general invalid (4s unconsumed), but the four+pair
  // special must not undercut four 1s (2000) — keeping the pair shouldn't drop
  // the score from 2000 to 1500.
  assert.deepEqual(scoreSelection([1, 1, 1, 1, 4, 4]), { valid: true, points: 2000 });
  // four 3s + pair: 3s-of-a-kind (600) < 1500, so the combo's 1500 still wins.
  assert.deepEqual(scoreSelection([3, 3, 3, 3, 6, 6]), { valid: true, points: 1500 });
});

test("two triplets", () => {
  assert.deepEqual(scoreSelection([2, 2, 2, 3, 3, 3]), { valid: true, points: 2500 });
});

test("general beats special when it scores higher and is valid", () => {
  // four 1s + pair of 5s: general = 2000 + 100 = 2100 (all consumed) beats four+pair 1500
  assert.deepEqual(scoreSelection([1, 1, 1, 1, 5, 5]), { valid: true, points: 2100 });
});

test("bestScoreFull picks optimal subset", () => {
  assert.equal(bestScoreFull([1, 2, 3, 4, 5, 6]), 1500);
  assert.equal(bestScoreFull([2, 2, 3, 3, 4, 4]), 1500);
  assert.equal(bestScoreFull([1, 2, 2, 3, 4, 5]), 150); // only 1 and 5 score
  assert.equal(bestScoreFull([2, 3, 4, 6]), 0);
  assert.equal(bestScoreFull([5, 5, 5]), 500);
});

test("hasAnyScore / farkle detection", () => {
  assert.equal(hasAnyScore([2, 3, 4, 6]), false);
  assert.equal(hasAnyScore([2, 2, 3, 4]), false);
  assert.equal(hasAnyScore([2, 3, 4]), false);
  assert.equal(hasAnyScore([1]), true);
  assert.equal(hasAnyScore([2, 2, 2]), true);
  assert.equal(hasAnyScore([3, 3, 4, 6, 6]), false); // no 1/5, no triple
});
