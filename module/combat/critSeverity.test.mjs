// module/combat/critSeverity.test.mjs
// Unit tests for critSeverityFromDelta — pure function, hits every branch
// of the RAW Core p.158 severity ladder. Other parts of the crit-detection
// wiring (flag plumbing, socket bonus lookup) are covered by source-shape
// tests in their own files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { critSeverityFromDelta } from "./critSeverity.mjs";

test("delta < 7 → no crit (tie goes to defense per errata)", () => {
  for (const d of [-5, 0, 1, 6]) {
    assert.equal(critSeverityFromDelta(d), null, `delta=${d} should not crit`);
  }
});

test("delta 7-9 → simple", () => {
  for (const d of [7, 8, 9]) {
    assert.equal(critSeverityFromDelta(d), "simple", `delta=${d}`);
  }
});

test("delta 10-12 → complex", () => {
  for (const d of [10, 11, 12]) {
    assert.equal(critSeverityFromDelta(d), "complex", `delta=${d}`);
  }
});

test("delta 13-14 → difficult", () => {
  for (const d of [13, 14]) {
    assert.equal(critSeverityFromDelta(d), "difficult", `delta=${d}`);
  }
});

test("delta 15+ → deadly", () => {
  for (const d of [15, 20, 100]) {
    assert.equal(critSeverityFromDelta(d), "deadly", `delta=${d}`);
  }
});

test("non-finite / nullish inputs → no crit (defensive against bad lookups)", () => {
  assert.equal(critSeverityFromDelta(null), null);
  assert.equal(critSeverityFromDelta(undefined), null);
  assert.equal(critSeverityFromDelta(NaN), null);
  assert.equal(critSeverityFromDelta(Infinity), null);
});
