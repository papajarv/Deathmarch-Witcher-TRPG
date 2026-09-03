// module/documents/mixins/defenseEconomy.test.mjs
//
// Source-pattern tests for the Combat Extended defense-economy plumbing
// (L2). The mixin chain is too deep to instantiate in a node test without
// stubbing half of Foundry — instead we assert the wiring is present
// where it has to be, so a regression that drops one of the threads
// (recordDefense argument, defenseMixin call-site key, CE base-cost
// lookup) trips the suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const combatRoundSrc = readFileSync(new URL("./combatRoundMixin.mjs", import.meta.url), "utf8");
const defenseSrc     = readFileSync(new URL("./defenseMixin.mjs",     import.meta.url), "utf8");

test("recordDefense accepts an actionKey argument", () => {
    assert.match(combatRoundSrc, /async\s+recordDefense\s*\(\s*actionKey\s*=\s*null/);
});

test("recordDefense routes through getActiveCombatActions when CE is on", () => {
    // Gate now via per-subsystem `defenseCosts` toggle (which itself
    // requires the master extendedCombat on — see isCESubsystemEnabled).
    assert.match(combatRoundSrc, /isCESubsystemEnabled\("defenseCosts"\)/);
    assert.match(combatRoundSrc, /getActiveCombatActions\b/);
    // Imports happen lazily inside the method so the RAW path stays
    // unaffected by the CE module.
    assert.match(combatRoundSrc, /await import\([^)]*homebrew\.mjs[^)]*\)/);
    assert.match(combatRoundSrc, /await import\([^)]*combatExtended\/actions\.mjs[^)]*\)/);
});

test("recordDefense honors Active Dodge (zeroes both rulesets)", () => {
    // The early-return on activelyDodging is shared between RAW and CE.
    assert.match(combatRoundSrc, /if\s*\(\s*r\.activelyDodging\s*\)\s*return\s+next\s*;/);
});

test("recordDefense applies the additive +1 recurrence under CE (gated by tuneable)", () => {
    // CE branch: `recur = (recurOn && next > (1 + freeDef)) ? recurStep : 0`
    // where recurStep is the House-Rules "Extra Defense STA cost" (RAW
    // default 1); total = base + recur. recurOn comes from the
    // additiveDefenseRecurrence tuneable (default true).
    assert.match(combatRoundSrc, /ceTuneable\("additiveDefenseRecurrence"\)/);
    assert.match(combatRoundSrc, /const\s+recurStep\s*=\s*hrExtraDefenseStaCost\(\)/);
    assert.match(combatRoundSrc, /const\s+recur\s*=\s*\(recurOn\s*&&\s*next\s*>\s*\(1\s*\+\s*freeDef\)\)\s*\?\s*recurStep\s*:\s*0/);
    assert.match(combatRoundSrc, /const\s+total\s*=\s*ceBase\s*\+\s*recur/);
});

test("recordDefense preserves the RAW legacy path", () => {
    // RAW: 1st free, +N each extra (N = House-Rules "Extra Defense STA
    // cost", RAW default 1) — must still execute when actionKey is null.
    assert.match(combatRoundSrc, /\/\*\s*RAW.*legacy.*path/i);
    assert.match(combatRoundSrc, /const\s+cost\s*=\s*hrExtraDefenseStaCost\(\)/);
    assert.match(combatRoundSrc, /spendStamina\s*\(\s*cost\s*,/);
});

test("defendWith threads the parry / block key into recordDefense", () => {
    assert.match(defenseSrc, /recordDefense\s*\(\s*mode\s*===\s*"block"\s*\?\s*"block"\s*:\s*"parry"\s*\)/);
});

test("defendBySkill threads the dodge / reposition key into recordDefense", () => {
    assert.match(defenseSrc, /const\s+defenseKey\s*=\s*reposition\s*\?\s*"reposition"\s*:\s*\(skillKey\s*===\s*"dodge"\s*\?\s*"dodge"\s*:\s*null\s*\)/);
    assert.match(defenseSrc, /recordDefense\s*\(\s*defenseKey\s*\)/);
});
