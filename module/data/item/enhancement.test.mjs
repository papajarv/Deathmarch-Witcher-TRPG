// module/data/item/enhancement.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// No Foundry runtime here; assert the source declares the field with default 1.
const src = readFileSync(new URL("./enhancement.mjs", import.meta.url), "utf8");

test("enhancement schema declares slotCost with default 1", () => {
  assert.match(src, /slotCost\s*:\s*new fields\.NumberField\(\{[^}]*initial:\s*1/);
});
