// module/applications/defensePromptDialog.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./defensePromptDialog.mjs", import.meta.url), "utf8");

test("openDefensePrompt accepts attackKind / shotIndex / totalShots / disallowedItemIds", () => {
  assert.match(src, /attackKind\s*=\s*"normal",\s*shotIndex\s*=\s*1,\s*totalShots\s*=\s*1,\s*disallowedItemIds\s*=\s*\[\]/);
});

test("Parry / block search filters out items in the disallowedItemIds list", () => {
  assert.match(src, /const blocked = new Set\(disallowedItemIds \?\? \[\]\)/);
  // Per-item .filter (was .find — switched so multi-weapon defenders get a
  // button per eligible item, not just the first one).
  assert.match(src, /\.filter\(it => parryEligible\(it\) && !blocked\.has\(it\.id\)\)/);
  assert.match(src, /\.filter\(it => blockEligible\(it\) && !blocked\.has\(it\.id\)\)/);
});

test("Multiple eligible parry/block items emit one button each (action carries itemId)", () => {
  assert.match(src, /parryItems\.length <= 1/);
  assert.match(src, /blockItems\.length <= 1/);
  assert.match(src, /action:\s*`parry:\$\{it\.id\}`/);
  assert.match(src, /action:\s*`block:\$\{it\.id\}`/);
  // Result handler decodes `action:itemId`
  assert.match(src, /const colon = raw\.indexOf\(":"\)/);
});

test("Dialog header surfaces the strike label and the shot tag when multi-shot", () => {
  assert.match(src, /STRIKE_LABELS\s*=\s*\{[\s\S]*?fast:\s*"Fast strike"[\s\S]*?joint:\s*"Joint attack"/);
  assert.match(src, /shotTag\s*=\s*totalShots > 1 \? `\s*\(\$\{shotIndex\}\/\$\{totalShots\}\)`/);
});

test("Dialog warns the defender when items were disallowed (joint-attack note)", () => {
  assert.match(src, /joint-attack rule/);
  assert.match(src, /blocked\.size > 0/);
});
