// Source-level guards on the notifications RAF loop that publishes
// `--wdm-dock-h`. The loop lost a race with sideedges.js: sideedges
// synchronously writes a 10rem fallback to --wdm-dock-h at chrome-boot
// time, AFTER notifications' first RAF tick. A JS-side memo (_lastPublished)
// then made subsequent ticks skip the write because the "value" hadn't
// changed from the loop's perspective — so the fallback quietly won for
// the rest of the session, and any live dock-size change (combat mode
// growing the dock from 10rem to ~14rem) never reached the CSS var.
//
// The fix reads the live inline style back and rewrites when it doesn't
// match the desired px value, catching any external override on the
// very next frame.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./notifications.js", import.meta.url), "utf8");

test("publishDockHeight compares against live inline style, not a JS-side memo", () => {
    // The check is `root.style.getPropertyValue(ROOT_VAR) !== nextStr` —
    // reading back from the DOM every tick, so we spot a foreign write.
    assert.match(src, /root\.style\.getPropertyValue\(ROOT_VAR\)\s*!==\s*nextStr/);
    // The desired value is stored as a `${next}px` string.
    assert.match(src, /const nextStr = `\$\{next\}px`;/);
});

test("Fallback branch also uses the live-inline-style compare", () => {
    // When the dock isn't mounted yet we still want to publish the
    // fallback, but we should only do so when the CSS var currently
    // holds something different — avoids stomping a later publish.
    assert.match(src, /const desiredFallback = `\$\{FALLBACK_DOCK_H\}px`;/);
    assert.match(src, /root\.style\.getPropertyValue\(ROOT_VAR\)\s*!==\s*desiredFallback/);
});

test("Test-seam _stopTrackingLoop still exists so hot-reload doesn't double-tick", () => {
    // Present in the module so re-installs can restart the loop cleanly.
    assert.match(src, /export function _stopTrackingLoop\(\)/);
});
