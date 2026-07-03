// module/applications/attackDialog.throwMode.test.mjs
//
// Regression-lock the player-perspective combat flow for throwables.
// Bugs caught by this file:
//
//   1. Throw is `meleeOnly: true` so it lives in `specialOpts`. The dialog
//      hides specialOpts when `melee === false` — which is exactly the
//      thrown-mode case. Without the isThrownMode override, Throw was
//      unreachable in: (a) dual-mode weapon toggled to Thrown, (b) any
//      weapon in the Quick slot.
//
//   2. The default-strike auto-selects Normal. In thrown mode that quietly
//      skips the Throwing open-category bonus because Normal doesn't carry
//      `strikeMeta.thrown: true`. Default must be `throw` when thrown mode.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./attackDialog.mjs", import.meta.url), "utf8");

test("isThrownMode override exists and gates basicOpts", () => {
    /* When isThrownMode is true, basicOpts is the lone Throw entry. */
    assert.match(src, /isThrownMode\s*=\s*canThrow/);
    assert.match(src, /if\s*\(\s*isThrownMode\s*\)\s*\{[\s\S]+?key\s*===\s*"throw"/);
});

test("defaultStrike flips to 'throw' in thrown mode", () => {
    assert.match(src, /if\s*\(\s*isThrownMode\s*\)\s*defaultStrike\s*=\s*"throw"/);
});

test("specialOpts no longer fires in thrown mode (no duplicate throw entry)", () => {
    /* The melee-strikes block is gated by (melee && !isThrownMode), so
     * Throw doesn't show twice when the user toggles modes. */
    assert.match(src, /specialOpts\s*=\s*\(\s*melee\s*&&\s*!isThrownMode\s*\)/);
});

test("Throw is excluded from melee specialOpts (UI lacks range brackets in melee)", () => {
    /* A throw picked from the melee specials would fire without range/
     * weather applied because the melee dialog UI doesn't render the
     * range bracket controls. Players must flip the mode toggle to throw. */
    assert.match(src, /specialOpts[\s\S]+?key\s*!==\s*"throw"/);
});

test("Quick-slot weapon forces thrown-only mode", () => {
    assert.match(src, /inQuickSlot\s*=\s*weapon\?\.system\?\.slot\s*===\s*"quick"/);
    assert.match(src, /dualMode\s*=\s*monsterMode\s*\?\s*false\s*:\s*\(rawDualMode\s*&&\s*!inQuickSlot\)/);
});

test("Dual-mode now activates on any one-handed weapon with range + a skill", () => {
    /* RAW: any hand weapon can be thrown. The `throwing` quality just adds
     * the per-weapon bonus on top. So an Iron Sword (range BODY×2) gets
     * dual-mode (no bonus on throw), a Dagger gets dual-mode + bonus,
     * a Dart defaults to thrown side. Bows/crossbows don't qualify
     * because their wType isn't "melee" or "thrown". */
    assert.match(src, /rawDualMode\s*=\s*setupCanThrow\s*&&\s*hasAnySkill/);
    assert.match(src, /\(wType\s*===\s*"melee"\s*\|\|\s*wType\s*===\s*"thrown"\)/);
});

test("Default mode picks the weapon's primary use", () => {
    /* Quick slot → thrown. weaponType==="thrown" → thrown. Else → melee.
     * Every melee weapon opens to melee even if it CAN be thrown — the
     * toggle lets the player flip to throw mode at will. */
    assert.match(src, /mode\s*=\s*inQuickSlot[\s\S]+?"thrown"[\s\S]+?wType\s*===\s*"thrown"[\s\S]+?"thrown"[\s\S]+?"melee"/);
});
