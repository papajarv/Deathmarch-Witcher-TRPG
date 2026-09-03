// module/data/item/valuable.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("./valuable.mjs", import.meta.url), "utf8");

test("valuable schema declares a trophyConfig subtype block", () => {
  assert.match(src, /trophyConfig\s*:\s*new fields\.SchemaField/);
  assert.match(src, /monsterCategory\s*:\s*new fields\.StringField/);
});

test("trophyConfig no longer carries bespoke effect/active/reputation fields", () => {
  // The trophy benefit is now authored as transfer Active Effects on the item.
  assert.doesNotMatch(src, /reputationBonus\s*:\s*new fields\./);
  assert.doesNotMatch(src, /effect\s*:\s*new fields\.HTMLField/);
  assert.doesNotMatch(src, /active\s*:\s*new fields\.BooleanField/);
});
