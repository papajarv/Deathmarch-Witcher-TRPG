// Loot actors are piles/containers, not combatants — they must never be a
// valid combat target. This is enforced by a `type === "loot"` guard alongside
// the existing dead-corpse exclusion in every target-gathering flow:
//   - weapon / ranged / brawl / magic single-target overlay
//   - clinch target selection
//   - spell-area effect harvesting
//   - combat-tracker middle-click (tokenless / theatre-of-the-mind target)
// Source-match tests so a refactor that drops a guard fails loudly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const overlaySrc = readFileSync(new URL("./weapon-target-overlay.mjs", import.meta.url), "utf8");
const clinchSrc  = readFileSync(new URL("../mechanics/clinch.mjs", import.meta.url), "utf8");
const areaSrc    = readFileSync(new URL("../mechanics/castArea.mjs", import.meta.url), "utf8");
const trackerSrc = readFileSync(new URL("./combat-tracker-targets.mjs", import.meta.url), "utf8");

test("weapon/ranged/brawl/magic overlay skips loot tokens", () => {
    /* The check lives in `isTargetableToken`, the predicate shared by the
     * gridded cell path and the gridless distance path — so it reads
     * `return false` rather than `continue`, like the clinch one below. */
    assert.match(overlaySrc, /token\.actor\?\.type === "loot"\)\s*return false;/);
});

test("clinch target selection rejects loot actors", () => {
    assert.match(clinchSrc, /t\.actor\?\.type === "loot"\)\s*return false;/);
});

test("spell-area harvest skips loot actors", () => {
    assert.match(areaSrc, /token\.actor\.type === "loot"\)\s*continue;/);
});

test("combat-tracker middle-click won't target a loot actor", () => {
    assert.match(trackerSrc, /actor\?\.type === "loot"\)\s*return;/);
});
