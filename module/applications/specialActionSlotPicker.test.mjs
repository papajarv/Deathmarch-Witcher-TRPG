// module/applications/specialActionSlotPicker.test.mjs
//
// pickSpecialActionSlot — small shared dialog used by guardConfig and
// raiseShieldDialog to let the player choose WHICH of their three
// action-economy slots to spend on a Special Action. Most logic lives
// inside the DialogV2 wait callback; node tests assert the source-
// pattern guarantees (auto-skip / out-of-combat / cancel semantics).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pickSpecialActionSlot } from "./specialActionSlotPicker.mjs";

const src = readFileSync(new URL("./specialActionSlotPicker.mjs", import.meta.url), "utf8");

test("Returns null when no actor is provided", async () => {
    assert.equal(await pickSpecialActionSlot(null), null);
});

test("Out of combat returns 'free' with no prompt", async () => {
    const actor = { _inActiveCombat: false, system: { combatRound: {} } };
    assert.equal(await pickSpecialActionSlot(actor, "Test"), "free");
});

test("Zero spendable slots returns null (caller refuses)", async () => {
    // All three slots already used.
    const actor = {
        _inActiveCombat: true,
        system: { combatRound: { movementUsed: true, actionUsed: true, extraUsed: true } }
    };
    assert.equal(await pickSpecialActionSlot(actor, "Test"), null);
});

test("Exactly one spendable slot auto-skips the prompt", async () => {
    // Only movement available.
    const actor = {
        _inActiveCombat: true,
        system: { combatRound: { movementUsed: false, actionUsed: true, extraUsed: true } }
    };
    assert.equal(await pickSpecialActionSlot(actor, "Test"), "movement");
});

test("Picker source advertises the three slot kinds + extra-action STA surcharge", () => {
    assert.match(src, /SLOT_BUTTON\s*=\s*\{[\s\S]+movement\s*:[\s\S]+action\s*:[\s\S]+extra\s*:/);
    // Extra-action button label includes the STA cost (reads from combatMods.extraActionStaReduction).
    assert.match(src, /extraStaCost\s*=\s*Math\.max\(0,\s*3\s*-\s*\(Number\(actor\.system\?\.combatMods\?\.extraActionStaReduction\)\s*\|\|\s*0\)\)/);
    assert.match(src, /Extra Action[^"]*\$\{extraStaCost\}\s+STA/);
});

test("availableSlots mirrors spendSpecialActionSlot's gate checks", () => {
    // Movement: !movementUsed AND !(movementMeters > 0)
    assert.match(src, /movement:\s*!r\.movementUsed\s*&&\s*!\(\(Number\(r\.movementMeters\)\s*\|\|\s*0\)\s*>\s*0\)/);
    // Action: !actionUsed (recordAction's own gate enforces is-my-turn etc).
    assert.match(src, /action:\s*!r\.actionUsed/);
    // Extra: !extraUsed
    assert.match(src, /extra:\s*!r\.extraUsed/);
});
