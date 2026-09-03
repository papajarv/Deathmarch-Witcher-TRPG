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
    assert.match(src, /specialOpts\s*=\s*\(\s*melee\s*&&\s*!isThrownMode\s*&&\s*!_isCharging\s*&&\s*!_isTackling\s*\)/);
});

test("Throw is excluded from melee specialOpts (UI lacks range brackets in melee)", () => {
    /* A throw picked from the melee specials would fire without range/
     * weather applied because the melee dialog UI doesn't render the
     * range bracket controls. Players must flip the mode toggle to throw. */
    assert.match(src, /specialOpts[\s\S]+?key\s*!==\s*"throw"/);
});

test("Quick-slot weapon forces thrown-only mode", () => {
    /* A quick-slot weapon is drawn only to throw (quickThrowOnly), UNLESS
     * Combat Extended lets a melee weapon in the quick slot still be swung.
     * dualMode is suppressed by quickThrowOnly, not by inQuickSlot alone. */
    assert.match(src, /inQuickSlot\s*=\s*weapon\?\.system\?\.slot\s*===\s*"quick"/);
    assert.match(src, /quickThrowOnly\s*=\s*inQuickSlot\s*&&\s*!\(setupCeOn\s*&&\s*wType\s*===\s*"melee"\)/);
    assert.match(src, /dualMode\s*=\s*monsterMode\s*\?\s*false\s*:\s*\(rawDualMode\s*&&\s*!quickThrowOnly\)/);
});

test("Dual-mode activates on a melee weapon that carries a range value", () => {
    /* Schema collapse: the legacy weaponType="thrown" is gone — throwables
     * are now weaponType="melee" whose Range field marks throwability
     * (setupCanThrow). So an Iron Sword (range BODY×2) gets dual-mode, a
     * Dagger gets dual-mode + throw bonus, a Dart is a melee weapon with a
     * range. Bows/crossbows are weaponType="ranged" so they don't qualify. */
    assert.match(src, /rawDualMode\s*=\s*setupCanThrow\s*&&\s*wType\s*===\s*"melee"/);
});

test("Default mode picks the weapon's primary use", () => {
    /* quickThrowOnly → thrown (hands busy with the main weapon). Otherwise
     * the caller (dock toggle) may preselect "melee"/"thrown"; absent that,
     * a dual-mode weapon opens to melee. Every melee weapon opens to melee
     * even if it CAN be thrown — the toggle flips to throw at will. */
    assert.match(src, /mode\s*=\s*quickThrowOnly\s*\?\s*"thrown"[\s\S]+?opts\.mode[\s\S]+?dualMode\s*\?\s*"melee"[\s\S]+?"melee"/);
});
