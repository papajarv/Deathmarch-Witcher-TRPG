// module/applications/defensePromptDialog.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./defensePromptDialog.mjs", import.meta.url), "utf8");

test("openDefensePrompt accepts attackKind / shotIndex / totalShots / disallowedItemIds", () => {
  assert.match(src, /attackKind\s*=\s*"normal",\s*shotIndex\s*=\s*1,\s*totalShots\s*=\s*1,\s*disallowedItemIds\s*=\s*\[\]/);
});

test("Parry / block search filters out items in the disallowedItemIds list", () => {
  // Item-set built from disallowedItemIds — the jointExempt short-circuit
  // (Blade Dance perk) bypasses the set, but the shape is preserved.
  assert.match(src, /const blocked = new Set\(jointExempt \? \[\] : \(disallowedItemIds \?\? \[\]\)\)/);
  // Per-item .filter for parry (multi-weapon defenders get a button per
  // eligible item). Block's filter is now multi-line (cover / bomb /
  // shield gates), so just assert that the blocked-set check appears
  // alongside blockEligible somewhere.
  // requireEquipped is passed as !isMonster so a monster's held (un-equipped)
  // weapons still count for parry/block.
  assert.match(src, /\.filter\(it => parryEligible\(it, !isMonster\) && !blocked\.has\(it\.id\)\)/);
  assert.match(src, /blockEligible\(it, !isMonster\)[\s\S]{0,80}blocked\.has\(it\.id\)/);
});

test("Item-less defense lockout — dodge / reposition / brawlBlock / resistMagic disable when the same action was used earlier in a joint attack", () => {
  // Second Set (parallel to `blocked`) drives the action-level lockout.
  assert.match(src, /const blockedActions = new Set\(jointExempt \? \[\] : \(disallowedActions \?\? \[\]\)\)/);
  // Each item-less action's push includes a `disabled: blockedActions.has(...)` check.
  assert.match(src, /action:\s*"dodge"[\s\S]{0,140}disabled:\s*blockedActions\.has\("dodge"\)/);
  assert.match(src, /action:\s*"brawlBlock"[\s\S]{0,140}disabled:\s*blockedActions\.has\("brawlBlock"\)/);
  assert.match(src, /action:\s*"reposition"[\s\S]{0,600}blockedActions\.has\("reposition"\)/);
  assert.match(src, /action:\s*"resistMagic"[\s\S]{0,300}disabled:\s*blockedActions\.has\("resistMagic"\)/);
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
  // The labels live in STRIKE_LABEL_FALLBACKS now (wrapped by a Proxy
  // named STRIKE_LABELS that i18n-localizes on read).
  assert.match(src, /STRIKE_LABEL_FALLBACKS\s*=\s*\{[\s\S]*?fast:\s*"Fast strike"[\s\S]*?joint:\s*"Joint attack"/);
  assert.match(src, /shotTag\s*=\s*totalShots > 1 \? `\s*\(\$\{shotIndex\}\/\$\{totalShots\}\)`/);
});

test("Dialog warns the defender when items were disallowed (joint-attack note)", () => {
  assert.match(src, /joint-attack rule/);
  assert.match(src, /blocked\.size > 0/);
});
