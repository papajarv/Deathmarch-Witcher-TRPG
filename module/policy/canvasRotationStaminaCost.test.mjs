// module/policy/canvasRotationStaminaCost.test.mjs
//
// Rotation costs MOVEMENT (not stamina). The earlier STA-spend variant
// was retired by user request — rotation only spends from the per-turn
// movement budget now, with a GM-configurable meters-per-90° rate.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const rotSrc      = readFileSync(new URL("./canvas-rotation.mjs", import.meta.url), "utf8");
const configSrc   = readFileSync(new URL("../setup/config.mjs", import.meta.url), "utf8");
const settingsSrc = readFileSync(new URL("../setup/settings.mjs", import.meta.url), "utf8");

test("rotationMovementPer90 numeric setting is registered (default 1m)", () => {
    assert.match(settingsSrc, /game\.settings\.register\(SYSTEM_ID,\s*"rotationMovementPer90",\s*\{[\s\S]+default:\s*1/);
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

test("metersPerRotationUnit reads the new setting lazily", () => {
    assert.match(rotSrc, /function\s+metersPerRotationUnit\s*\(\s*\)/);
    assert.match(rotSrc, /game\.settings\?\.get\?\.\(SYSTEM_ID,\s*"rotationMovementPer90"\)/);
    // 0 (or unreadable) → free rotation, short-circuit before any charge.
    assert.match(rotSrc, /metersPerUnit\s*<=\s*0\)\s*return/);
});

test("rotation charges meters = units × metersPerUnit (configurable conversion)", () => {
    // chargeMeters is the actual budget cost; the threshold cross still
    // happens at 90° steps.
    assert.match(rotSrc, /DEG_PER_ROTATION_UNIT\s*=\s*90/);
    assert.match(rotSrc, /const\s+chargeMeters\s*=\s*units\s*\*\s*metersPerUnit/);
    // recordMovement is called with the meter charge, not unit count.
    assert.match(rotSrc, /actor\.recordMovement\(chargeMeters\)/);
});

test("tokenFacingOffsetDeg setting is removed (rotation offset retired)", () => {
    assert.doesNotMatch(settingsSrc, /"tokenFacingOffsetDeg"/);
    assert.doesNotMatch(settingsSrc, /"tokenFacingOffsetMigratedV1"/);
});
