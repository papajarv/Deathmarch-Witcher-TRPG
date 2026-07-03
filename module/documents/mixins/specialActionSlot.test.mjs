// module/documents/mixins/specialActionSlot.test.mjs
//
// Source-pattern tests for L5 — Special Action slot economy. Mixin
// instantiation needs Foundry globals, so we assert the wiring shape is
// correct (movement → action → extra priority; multi-use per round capped
// by the action-economy slots — no lockedThisRound any more).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const mixinSrc = readFileSync(new URL("./combatRoundMixin.mjs", import.meta.url), "utf8");
const guardDlg = readFileSync(new URL("../../applications/guardConfig.mjs", import.meta.url), "utf8");
const raiseDlg = readFileSync(new URL("../../applications/raiseShieldDialog.mjs", import.meta.url), "utf8");

test("spendSpecialActionSlot is defined on the mixin", () => {
    /* Signature now accepts an optional { slot } override. The picker
     * dialog passes the chosen slot through this param; callers without
     * a picker pass nothing and get auto-pick. */
    assert.match(mixinSrc, /async\s+spendSpecialActionSlot\s*\(\s*label\s*=\s*"Special Action"\s*,\s*\{\s*slot\s*=\s*null\s*\}\s*=\s*\{\}\s*\)/);
});

test("spendSpecialActionSlot returns 'free' out of combat", () => {
    assert.match(mixinSrc, /if\s*\(!this\._inActiveCombat\)\s*return\s*"free"/);
});

test("spendSpecialActionSlot is multi-use within a round (no separate per-round lock)", () => {
    // Multi-use semantics: the helper exhausts slots in priority order
    // and ONLY refuses when all three (movement / action / extra) are
    // gone. There should be no `lockedThisRound` early-refuse any more.
    assert.doesNotMatch(mixinSrc, /system\?\.guard\?\.lockedThisRound[\s\S]+notify\(/);
    // Final refusal when nothing's left.
    assert.match(mixinSrc, /No slot left for a Special Action/);
});

test("spendSpecialActionSlot tries movement → action → extra in order", () => {
    // Order check: movement branch precedes action which precedes extra.
    // The extra-action call passes `{ requirePriorAction: false }` now,
    // so match the method name only (not the full arg list).
    const sssIdx = mixinSrc.indexOf("async spendSpecialActionSlot");
    const moveInSss = mixinSrc.indexOf("system.combatRound.movementUsed", sssIdx);
    const actInSss  = mixinSrc.indexOf("await this.recordAction(label)", sssIdx);
    const extInSss  = mixinSrc.indexOf("await this.recordExtraAction(label", sssIdx);
    assert.ok(moveInSss !== -1 && actInSss !== -1 && extInSss !== -1);
    assert.ok(moveInSss < actInSss);
    assert.ok(actInSss  < extInSss);
});

test("Special-Action extra bypasses the 'use action first' RAW gate (passes requirePriorAction: false)", () => {
    // recordExtraAction signature now accepts { requirePriorAction } —
    // default true (RAW), Special Actions pass false.
    assert.match(mixinSrc, /async\s+recordExtraAction\s*\(\s*label\s*=\s*"Extra Action"\s*,\s*\{\s*requirePriorAction\s*=\s*true,\s*escapeAttempt\s*=\s*false\s*\}\s*=\s*\{\}\s*\)/);
    // spendSpecialActionSlot's extra branch passes requirePriorAction: false.
    assert.match(mixinSrc, /recordExtraAction\(label,\s*\{\s*requirePriorAction:\s*false\s*\}\)/);
});

test("spendSpecialActionSlot no longer writes the deprecated lockedThisRound flag", () => {
    // Multi-use redesign — the per-round lock is gone. The action-
    // economy slots themselves cap the count (max three Special Actions
    // per turn, since there are three slots).
    assert.doesNotMatch(mixinSrc, /spendSpecialActionSlot[\s\S]*?"system\.guard\.lockedThisRound":\s*true/);
});

test("Guard config dialog routes a current-guard change through spendSpecialActionSlot", () => {
    // The picker chooses the slot; spendSpecialActionSlot is then called
    // with the explicit slot via the { slot } option.
    assert.match(guardDlg, /spendSpecialActionSlot\(`Change Guard → \$\{nextCur\}`,\s*\{\s*slot:/);
});

test("Raise Shield dialog routes a fresh raise through spendSpecialActionSlot", () => {
    assert.match(raiseDlg, /spendSpecialActionSlot\(`Raise \$\{shield\.name\}`,\s*\{\s*slot:/);
});

test("Both dialogs preserve preferred / warding edits when the slot is unavailable", () => {
    // Guard dialog: even when slot is null, the preferred + warding upd lands.
    assert.match(guardDlg, /if\s*\(!slot\)\s*\{[\s\S]+actor\.update\(upd\)/);
    // Raise dialog: when slot is null, early-return without writing shieldRaised state.
    assert.match(raiseDlg, /if\s*\(!slot\)\s*return\s*"raise"/);
});

test("spendSpecialActionSlot accepts an explicit { slot } option", () => {
    // Signature now takes a slot pick from the picker; auto-pick stays
    // as the fallback when slot is null/omitted.
    assert.match(mixinSrc, /async\s+spendSpecialActionSlot\s*\(\s*label\s*=\s*"Special Action"\s*,\s*\{\s*slot\s*=\s*null\s*\}\s*=\s*\{\}\s*\)/);
    // Explicit-slot branches per kind.
    assert.match(mixinSrc, /if\s*\(slot\s*===\s*"movement"\)/);
    assert.match(mixinSrc, /if\s*\(slot\s*===\s*"action"\)/);
    assert.match(mixinSrc, /if\s*\(slot\s*===\s*"extra"\)/);
});

test("Both dialogs prompt the player for the slot via pickSpecialActionSlot", () => {
    assert.match(guardDlg, /import\s*\{\s*pickSpecialActionSlot\s*\}\s*from\s*"\.\/specialActionSlotPicker\.mjs"/);
    assert.match(raiseDlg, /import\s*\{\s*pickSpecialActionSlot\s*\}\s*from\s*"\.\/specialActionSlotPicker\.mjs"/);
    assert.match(guardDlg, /await\s+pickSpecialActionSlot\(actor,/);
    assert.match(raiseDlg, /await\s+pickSpecialActionSlot\(actor,/);
});
