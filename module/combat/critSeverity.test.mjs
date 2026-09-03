// module/combat/critSeverity.test.mjs
// Unit tests for critSeverityFromDelta — pure function, hits every branch
// of the RAW Core p.158 severity ladder. Other parts of the crit-detection
// wiring (flag plumbing, socket bonus lookup) are covered by source-shape
// tests in their own files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { critSeverityFromDelta, RAW_CRIT_BRACKETS } from "./critSeverity.mjs";

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

test("RAW_CRIT_BRACKETS constant matches Core p.152 sidebar", () => {
  assert.deepEqual({ ...RAW_CRIT_BRACKETS },
    { simple: 7, complex: 10, difficult: 13, deadly: 15 });
});

test("custom brackets ladder — house-ruled tighter thresholds", () => {
  const b = { simple: 5, complex: 8, difficult: 11, deadly: 14 };
  assert.equal(critSeverityFromDelta(4,  b), null);
  assert.equal(critSeverityFromDelta(5,  b), "simple");
  assert.equal(critSeverityFromDelta(7,  b), "simple");
  assert.equal(critSeverityFromDelta(8,  b), "complex");
  assert.equal(critSeverityFromDelta(10, b), "complex");
  assert.equal(critSeverityFromDelta(11, b), "difficult");
  assert.equal(critSeverityFromDelta(13, b), "difficult");
  assert.equal(critSeverityFromDelta(14, b), "deadly");
  assert.equal(critSeverityFromDelta(100, b), "deadly");
});

test("custom brackets ladder — house-ruled swingier / crit-shy thresholds", () => {
  const b = { simple: 10, complex: 14, difficult: 18, deadly: 22 };
  assert.equal(critSeverityFromDelta(9,   b), null);
  assert.equal(critSeverityFromDelta(10,  b), "simple");
  assert.equal(critSeverityFromDelta(14,  b), "complex");
  assert.equal(critSeverityFromDelta(18,  b), "difficult");
  assert.equal(critSeverityFromDelta(22,  b), "deadly");
});

test("bad brackets arg (null/undefined/empty) → falls back to RAW", () => {
  assert.equal(critSeverityFromDelta(7,  null),      "simple");
  assert.equal(critSeverityFromDelta(15, undefined), "deadly");
});
