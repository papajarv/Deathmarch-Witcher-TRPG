// module/chrome/chrome/dockGuardSig.test.mjs
//
// Regression test for the bug where the dock didn't re-render after a
// guard/shield change: the rebind signature didn't include guard state,
// so an actor.update changing system.guard.current got sig-skipped and
// the guard button face stayed stale until the next turn forced a fresh
// sig from some unrelated change.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dockSrc = readFileSync(new URL("./dock.js", import.meta.url), "utf8");

test("Dock rebind signature folds in guard.current / preferred / wardingLocations / shieldRaised", () => {
    // The signature object includes all guard sub-fields the user can
    // change from the dialogs. If any of these aren't in the sig, the
    // dock skips its rebind and the indicator goes stale.
    assert.match(dockSrc, /const\s+guardSig\s*=\s*JSON\.stringify\(\s*\{/);
    assert.match(dockSrc, /cur:\s*guardState\.current/);
    assert.match(dockSrc, /pref:\s*guardState\.preferred/);
    assert.match(dockSrc, /ward:\s*guardState\.wardingLocations/);
    assert.match(dockSrc, /sh:\s*guardState\.shieldRaised\?\.itemId/);
    assert.match(dockSrc, /shLoc:\s*guardState\.shieldRaised\?\.coveredLocations/);
});

test("Dock rebind signature concatenates guardSig into the final sig (used in change detection)", () => {
    // The final sig string includes guardSig — without this, the
    // signature compare would skip guard changes silently.
    assert.match(dockSrc, /const\s+sig\s*=[\s\S]+\+\s*guardSig\b/);
});

test("Dock weapon row renders the Raise Shield indicator (shield-only, gated on subsystem)", () => {
    // Indicator only renders for shield type, only when raiseShield subsystem on,
    // only when THIS shield is the actor's currently raised one.
    assert.match(dockSrc, /if\s*\(w\.type\s*!==\s*"shield"\)\s*return\s*""/);
    assert.match(dockSrc, /if\s*\(!isCESubsystemEnabled\("raiseShield"\)\)\s*return\s*""/);
    assert.match(dockSrc, /if\s*\(sr\.itemId\s*!==\s*w\.id\)\s*return\s*""/);
    // Head-covered → eye-slash icon (Restricted Vision active).
    assert.match(dockSrc, /sr\.headCovered\s*\?\s*`\s*<i class="fa-solid fa-eye-slash"/);
});

test("Dock Warding indicator gated on weapon type + guards subsystem + warding stance + saved location", () => {
    assert.match(dockSrc, /if\s*\(w\.type\s*!==\s*"weapon"\)\s*return\s*""/);
    assert.match(dockSrc, /if\s*\(!isCESubsystemEnabled\("guards"\)\)\s*return\s*""/);
    assert.match(dockSrc, /String\(actor\?\.system\?\.guard\?\.current[\s\S]*?\)\s*!==\s*"warding"\)\s*return\s*""/);
    assert.match(dockSrc, /wardingLocations\?\.\[w\.id\]/);
});

test("Indicator labels are capitalized (Warding ... / Raised: ...)", () => {
    // Per the user's call: indicator text should be capitalized.
    // No lowercase prefix words, no text-transform:lowercase coercion.
    assert.match(dockSrc, /<i class="fa-solid fa-bullseye"><\/i>\s+Warding\s+\$\{escapeHTML\(lbl\)\}/);
    assert.match(dockSrc, /<i class="fa-solid fa-shield"><\/i>\s+Raised:\s+\$\{escapeHTML\(labels\)\}/);
});
