// module/policy/canvasRotationStaminaCost.test.mjs
//
// Rotation is FREE. Earlier variants charged STAMINA, then a GM-configurable
// MOVEMENT cost per 90°; both were retired by user request. canvas-rotation.mjs
// now hard-locks the per-90° cost to 0, and the `rotationMovementPer90` world
// setting has been removed from the config UI.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const rotSrc      = readFileSync(new URL("./canvas-rotation.mjs", import.meta.url), "utf8");
const configSrc   = readFileSync(new URL("../setup/config.mjs", import.meta.url), "utf8");
const settingsSrc = readFileSync(new URL("../setup/settings.mjs", import.meta.url), "utf8");

test("rotationMovementPer90 setting is no longer registered", () => {
    assert.doesNotMatch(settingsSrc, /"rotationMovementPer90"/);
});

test("rotationStaCost homebrew toggle is removed from the catalog", () => {
    assert.doesNotMatch(configSrc, /rotationStaCost:/);
});

test("rotationStaPer90 setting is no longer registered", () => {
    assert.doesNotMatch(settingsSrc, /"rotationStaPer90"/);
});

test("canvas-rotation no longer imports the homebrew helpers (no STA path)", () => {
    assert.doesNotMatch(rotSrc, /isHomebrewEnabled/);
    assert.doesNotMatch(rotSrc, /ceTuneable/);
    assert.doesNotMatch(rotSrc, /spendStamina/);
});

test("rotation is free — metersPerRotationUnit is hard-locked to 0", () => {
    assert.match(rotSrc, /function\s+metersPerRotationUnit\s*\(\s*\)\s*\{\s*return\s+0\s*;?\s*\}/);
    // The removed setting is not consulted anywhere anymore.
    assert.doesNotMatch(rotSrc, /rotationMovementPer90/);
});

test("tokenFacingOffsetDeg setting is removed (rotation offset retired)", () => {
    assert.doesNotMatch(settingsSrc, /"tokenFacingOffsetDeg"/);
    assert.doesNotMatch(settingsSrc, /"tokenFacingOffsetMigratedV1"/);
});
