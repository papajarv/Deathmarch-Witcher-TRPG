// module/data/item/spell.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("./spell.mjs", import.meta.url), "utf8");

test("spell schema declares a sideEffect field", () => {
  assert.match(src, /sideEffect\s*:\s*new fields\.HTMLField/);
});
