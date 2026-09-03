// module/magic/canvas/persist.test.mjs
//
// EXECUTING test for the update payloads.
//
// The bug these exist to prevent: an ObjectField update MERGES. Writing
// `{ on: {} }` clears nothing, so Clear did nothing and Start-from-the-book
// left the old triggers beside the new ones. Both actions "succeeded", the
// sheet re-rendered, and the screen showed exactly what it showed before —
// which is the hardest kind of failure to notice and the easiest to report as
// "the UI doesn't update".

import test from "node:test";
import assert from "node:assert/strict";

import { treeUpdate, frameUpdate } from "./persist.mjs";

const hit = [{ b: "core:dealDamage", a: { formula: "4d6" } }];
const success = [{ b: "core:createShield", a: {} }];

test("a removed trigger is named explicitly, or the merge keeps it", () => {
    const update = treeUpdate({ hit, success }, { hit });
    assert.equal(update["system.magic.on.-=success"], null);
    assert.deepEqual(update["system.magic.on.hit"], hit);
});

test("clearing everything names every trigger it drops", () => {
    const update = treeUpdate({ hit, success, takeDamage: [] }, {});
    assert.deepEqual(Object.keys(update).sort(), [
        "system.magic.on.-=hit", "system.magic.on.-=success", "system.magic.on.-=takeDamage"
    ]);
});

test("clearing an item that had nothing produces an empty update", () => {
    assert.deepEqual(treeUpdate({}, {}), {});
});

test("loading a different spell REPLACES rather than accumulating", () => {
    // Start-from-the-book on a spell that already had trees used to leave both
    // sets on the item, so a spell fired its old behaviour and its new one.
    const update = treeUpdate({ hit, takeDamage: success }, { success });
    assert.equal(update["system.magic.on.-=hit"], null);
    assert.equal(update["system.magic.on.-=takeDamage"], null);
    assert.deepEqual(update["system.magic.on.success"], success);
});

test("an unchanged trigger is still written, because its ARRAY replaces", () => {
    // Arrays replace wholesale; only the parent object merges. Writing the
    // per-entry path is what makes an edit stick.
    const update = treeUpdate({ hit }, { hit: [] });
    assert.deepEqual(update["system.magic.on.hit"], []);
    assert.ok(!("system.magic.on.-=hit" in update), "emptied, not removed");
});

test("the frame follows the same rule", () => {
    const update = frameUpdate({ element: "fire", tier: "novice" }, { element: "water" });
    assert.equal(update["system.magic.frame.-=tier"], null);
    assert.equal(update["system.magic.frame.element"], "water");
});

test("nothing writes outside system.magic", () => {
    // The whole reason this is reversible per spell.
    const update = { ...treeUpdate({ hit }, { success }), ...frameUpdate({ a: 1 }, { b: 2 }) };
    for (const key of Object.keys(update)) {
        assert.match(key, /^system\.magic\./, `${key} escapes the magic block`);
    }
});
