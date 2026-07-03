// module/data/item/weaponGripMode.test.mjs
//
// 1H ↔ 2H wielding-mode toggle for weapons that list the EO Two-Hand
// quality. The flag (system.twoHandMode) drives:
//   1. occupancyOf() → "both" hands (so off-hand / quick items conflict
//      the same way a baseline 2H weapon does)
//   2. The Two-Hand open-category bonus context predicate in the attack
//      pipeline (weaponAttackMixin folds wa+dice when isTwoHandedWield).
//   3. The dock grip-mode button visibility and label.
//
// Source-pattern (no live import of inventory.js — it transitively pulls
// in Foundry globals via setup/calendar.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getActiveOpenCategoryBonuses } from "../../mechanics/openCategoryBonuses.mjs";

const weaponSchemaSrc = readFileSync(new URL("./weapon.mjs", import.meta.url), "utf8");
const dockSrc         = readFileSync(new URL("../../chrome/chrome/dock.js", import.meta.url), "utf8");
const mixinSrc        = readFileSync(new URL("../../documents/mixins/weaponAttackMixin.mjs", import.meta.url), "utf8");
const invSrc          = readFileSync(new URL("../../chrome/chrome/inventory.js", import.meta.url), "utf8");

test("WeaponData schema carries the twoHandMode boolean (default false)", () => {
    assert.match(weaponSchemaSrc, /twoHandMode:\s*new\s+fields\.BooleanField\(\s*\{\s*initial:\s*false\s*\}\s*\)/);
});

test("occupancyOf promotes 1H weapon to 'both' when twoHandMode is set AND Two-Hand quality is listed", () => {
    // Source-pattern: assert the branch exists in inventory.js. Three
    // conditions all required (type, twoHandMode, quality includes).
    assert.match(invSrc, /item\.system\?\.twoHandMode\s*===\s*true/);
    assert.match(invSrc, /item\.system\.qualities\.includes\("twoHand"\)/);
    assert.match(invSrc, /return\s+"both"\s*;\s*\}/);
});

test("getActiveOpenCategoryBonuses fires Two-Hand when isTwoHandedWield is set", () => {
    const w = { system: { qualities: ["twoHand"], qualityValues: { twoHand: "+1 WA, +1d6 Dmg" } } };
    const fired = getActiveOpenCategoryBonuses(w, { isTwoHandedWield: true });
    assert.equal(fired.length, 1);
    assert.equal(fired[0].key, "twoHand");
    assert.equal(fired[0].wa, 1);
    assert.equal(fired[0].dmgDice, "1d6");
});

test("weaponAttackMixin derives isTwoHandedWield from twoHandMode OR baseline hands==='two'", () => {
    // The mixin reads BOTH fields so a baseline 2H weapon also fires the
    // Two-Hand bonus (the quality lists 'when wielded two-handed' — a
    // baseline 2H weapon always is).
    assert.match(mixinSrc, /isTwoHandedWield\s*:\s*[^,]*twoHandMode/);
    assert.match(mixinSrc, /isTwoHandedWield\s*:\s*[^,]*hands\s*===\s*"two"/);
});

test("Dock renders a grip-mode button only for 1H weapons that list Two-Hand", () => {
    assert.match(dockSrc, /canSwitchGrip\s*=\s*w\.type\s*===\s*"weapon"[\s\S]+?hands\s*===\s*"one"[\s\S]+?\.includes\("twoHand"\)/);
    assert.match(dockSrc, /class="weapon-grip-mode/);
});

test("Dock grip-mode click flips system.twoHandMode and gates on a free off-hand", () => {
    /* Switching INTO 2H requires off-hand free (only "left" — Quick is
     * the rested-while-2H carve-out and coexists with both native and
     * hybrid 2H, so it does NOT block the flip). Switching OUT is
     * unconditional. */
    assert.match(dockSrc, /const\s+goingTwo\s*=\s*!inTwoHandMode/);
    assert.match(dockSrc, /goingTwo\s*\)\s*\{[\s\S]+occupancyOf\(i\)\s*===\s*"left"/);
    assert.doesNotMatch(dockSrc.match(/const goingTwo[\s\S]+?await w\.update\([^)]+\)/)?.[0] ?? "",
        /occupancyOf\(i\)\s*===\s*"quick"/);
    assert.match(dockSrc, /w\.update\(\{\s*"system\.twoHandMode":\s*goingTwo\s*\}\)/);
});
