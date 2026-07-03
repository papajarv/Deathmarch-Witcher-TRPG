// module/setup/raisedShieldDamageRouting.test.mjs
//
// L4b — covered-location hits drain shield reliability. buildArmorShape
// is internal to socketHook.mjs (not exported) so this is a source-
// pattern test confirming the wiring exists; full integration testing
// happens in Foundry against a live actor.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./socketHook.mjs", import.meta.url), "utf8");

test("buildArmorShape overlays raised shield reliability as SP on covered locations", () => {
    assert.match(src, /system\?\.guard\?\.shieldRaised\b/);
    assert.match(src, /Array\.isArray\(sr\.coveredLocations\)/);
    assert.match(src, /armor\[loc\]\.sp\s*\+=\s*rel/);
    assert.match(src, /armor\[loc\]\.itemIds\.includes\(shield\.id\)/);
});

test("Overlay is skipped when the shield has zero reliability", () => {
    // The if-gate requires rel > 0 before pushing onto sp/itemIds, so a
    // broken (reliability 0) shield contributes 0 and the overlay no-ops.
    assert.match(src, /const\s+rel\s*=\s*Number\(shield\?\.system\?\.reliability\?\.value\)\s*\|\|\s*0/);
    assert.match(src, /shield\.type\s*===\s*"shield"\s*&&\s*rel\s*>\s*0/);
});

test("Overlay only fires for valid hit-location keys", () => {
    assert.match(src, /if\s*\(!ARMOR_LOCS\.includes\(loc\)\)\s*continue/);
});

test("Ablation patch handler branches on item.type === 'shield' to drain reliability", () => {
    assert.match(src, /if\s*\(item\.type\s*===\s*"shield"\)\s*\{[\s\S]+system\.reliability\.value/);
});

test("Ablation patch handler still drains worn-armor stopping per location for non-shield items", () => {
    // After the shield branch returns, the original armor path runs.
    assert.match(src, /const\s+field\s*=\s*`\$\{locKey\}Stopping`/);
    assert.match(src, /item\.update\(\{\s*\[`system\.\$\{field\}`\]:\s*next\s*\}\)/);
});
