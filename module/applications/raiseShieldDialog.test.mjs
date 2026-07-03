// module/applications/raiseShieldDialog.test.mjs
//
// Source-pattern tests for the Raise Shield dialog + its data wiring (L4).
// The dialog itself depends on DialogV2 globals — out of scope for node
// tests. We assert the integration surface instead: status registration,
// data model fields, lifecycle reset, dock wiring.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dlgSrc       = readFileSync(new URL("./raiseShieldDialog.mjs", import.meta.url), "utf8");
const statusSrc    = readFileSync(new URL("../setup/statusEffects.mjs", import.meta.url), "utf8");
const clauseSrc    = readFileSync(new URL("../setup/statusClauses.mjs", import.meta.url), "utf8");
const guardSchema  = readFileSync(new URL("../data/actor/templates/guard.mjs", import.meta.url), "utf8");
const shieldSchema = readFileSync(new URL("../data/item/shield.mjs", import.meta.url), "utf8");
const resetSrc     = readFileSync(new URL("../policy/combat-round-reset.mjs", import.meta.url), "utf8");
const dockSrc      = readFileSync(new URL("../chrome/chrome/dock.js", import.meta.url), "utf8");

test("restrictedVision is registered as a baseline status", () => {
    assert.match(statusSrc, /id:\s*"restrictedVision"\s*,\s*name:\s*"WITCHER\.Status\.RestrictedVision"/);
});

test("restrictedVision clause applies -2 to defense rolls and clears on own-turn start", () => {
    assert.match(clauseSrc, /restrictedVision\s*:\s*\{[\s\S]+?defense:\s*-2/);
    assert.match(clauseSrc, /restrictedVision\s*:\s*\{[\s\S]+?clearsAt:\s*"ownTurnStart"/);
});

test("guard schema carries the shieldRaised sub-schema", () => {
    assert.match(guardSchema, /shieldRaised:\s*new\s+fields\.SchemaField\(\s*\{/);
    assert.match(guardSchema, /itemId:\s+new\s+fields\.StringField/);
    assert.match(guardSchema, /coveredLocations:\s*new\s+fields\.ArrayField/);
    assert.match(guardSchema, /headCovered:\s+new\s+fields\.BooleanField/);
});

test("shield data model carries the Equipment Overhaul coverValue field", () => {
    assert.match(shieldSchema, /coverValue:\s*num\(\)/);
});

test("combat-end reset clears shieldRaised state too", () => {
    assert.match(resetSrc, /system\.guard\.shieldRaised\.itemId/);
    assert.match(resetSrc, /system\.guard\.shieldRaised\.coveredLocations/);
});

test("Raise Shield dialog applies / lifts the restrictedVision status based on head coverage", () => {
    assert.match(dlgSrc, /toggleStatusEffect\?\.\("restrictedVision",\s*\{\s*active:\s*true\s*\}/);
    assert.match(dlgSrc, /toggleStatusEffect\?\.\("restrictedVision",\s*\{\s*active:\s*false\s*\}/);
});

test("Raise Shield prompts for a slot, spends it, and auto-resets guard to balanced when tuneable is on", () => {
    // Slot picker prompt before the spend.
    assert.match(dlgSrc, /pickSpecialActionSlot\(actor,\s*`Raise \$\{shield\.name\}`\)/);
    // spendSpecialActionSlot is then called with the chosen slot.
    assert.match(dlgSrc, /spendSpecialActionSlot\(`Raise \$\{shield\.name\}`,\s*\{\s*slot:/);
    // Per rules1: raising restores Balanced guard — gated by the
    // raiseShieldAutoBalanced tuneable (default true).
    assert.match(dlgSrc, /ceTuneable\("raiseShieldAutoBalanced"\)/);
    assert.match(dlgSrc, /"system\.guard\.current"\]?\s*=\s*"balanced"/);
});

test("Dock renders a Raise Shield button on shield rows when CE is on", () => {
    // Gate on the per-subsystem `raiseShield` toggle (which itself requires
    // the master extendedCombat toggle on — see isCESubsystemEnabled).
    assert.match(dockSrc, /w\.type\s*===\s*"shield"\s*&&\s*isCESubsystemEnabled\("raiseShield"\)/);
    // Click handler imports the dialog lazily
    assert.match(dockSrc, /openRaiseShieldDialog\(actor,\s*w\)/);
});

test("Raise Shield picker rules: CV 0 short-circuits; CV ≥ 6 = full cover", () => {
    // CV 0 early-exit: dialog shows the CV-zero hint and returns.
    assert.match(dlgSrc, /if\s*\(cv\s*<=\s*0\)/);
    assert.match(dlgSrc, /Cover Value of 0/);
    // CV ≥ 6 = full cover (auto-select all six locations, no picker).
    assert.match(dlgSrc, /const\s+fullCover\s*=\s*cv\s*>=\s*HIT_LOCATIONS\.length/);
    assert.match(dlgSrc, /fullCover\s*\n?\s*\?\s*new\s+Set\(HIT_LOCATIONS\)/);
});

test("Raise Shield picker uses an interactive SVG body figure (replaced the dropdown)", () => {
    // The old <select id="rs-set"> dropdown is gone.
    assert.doesNotMatch(dlgSrc, /<select id="rs-set"/);
    // The SVG is built PROGRAMMATICALLY (createElementNS) to bypass the
    // DialogV2 content sanitizer that was stripping the inline <svg>.
    assert.match(dlgSrc, /document\.createElementNS\(SVG_NS,\s*"svg"\)/);
    assert.match(dlgSrc, /document\.createElementNS\(SVG_NS,\s*"path"\)/);
    // CSS class for the figure + per-zone class set programmatically.
    assert.match(dlgSrc, /setAttribute\("class",\s*"wdm-rs-figure"\)/);
    assert.match(dlgSrc, /setAttribute\("class",\s*"wdm-rs-zone"\)/);
    // Zone state classes drive the visual feedback (selected/eligible/capped/bridge).
    for (const cls of ["is-selected", "is-eligible", "is-capped", "is-bridge"]) {
        assert.match(dlgSrc, new RegExp(cls));
    }
});

test("Raise Shield picker enforces contiguity AND CV cap on each click", () => {
    // Adjacency / contiguity check via isContiguous BFS.
    assert.match(dlgSrc, /function\s+isContiguous\s*\(\s*set\s*\)/);
    // CV cap: zoneState returns "capped" when selection >= cv.
    assert.match(dlgSrc, /if\s*\(selected\.size\s*>=\s*cv\)\s*return\s*"capped"/);
    // Bridge detection: a selected zone is "bridge" when removing it
    // would split the remaining selection.
    assert.match(dlgSrc, /isContiguous\(after\)\s*\?\s*"selected"\s*:\s*"bridge"/);
});
