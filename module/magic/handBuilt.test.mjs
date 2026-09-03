/**
 * A spell built by hand in the canvas must behave like one loaded from the book.
 *
 * It did not. `targetingFrom` tested `system.areaShape` for truthiness, but the
 * field's unset value is the STRING "none" — so every spell became an area
 * spell. A corpus spell never showed it, because each one carries an authored
 * `system.magic.frame` that overrides the derivation. A spell somebody built
 * themselves has no such frame, so the derivation stands:
 *
 *     mode: "area", shape: "none"
 *
 * The template layer cannot place a "none", `pickTargets` returns nothing, and
 * the cast resolves as an unopposed SUCCESS against no one. The spell charged
 * its stamina, rolled its dice, printed "It works." and did nothing — with the
 * `hit` tree the author had just built sitting there unused.
 *
 * Found by building one through the UI instead of writing `magic.on` directly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { frameFor, derive } from "./legacyFrame.mjs";

/* What a freshly created spell item actually looks like: the schema's defaults,
 * with no authored frame. */
const BLANK = { areaShape: "none", areaSize: 0, targetType: "direct",
                staminaCost: 2, defense: ["dodge"], range: "10m" };

test("a hand-built direct spell is direct, not an area of shape 'none'", () => {
    const t = frameFor(BLANK).targeting;
    assert.equal(t.mode, "direct", 'areaShape "none" must not make a spell an area');
    assert.notEqual(t.shape, "none");
});

test("a spell that really is an area still is one", () => {
    assert.equal(frameFor({ ...BLANK, targetType: "area", areaShape: "cone", areaSize: 2 }).targeting.mode, "area");
    /* and a shape alone is enough, which is how legacy spells were authored */
    assert.equal(frameFor({ ...BLANK, areaShape: "radius", areaSize: 3 }).targeting.mode, "area");
});

test("self and point are untouched", () => {
    assert.equal(frameFor({ ...BLANK, targetType: "self" }).targeting.mode, "self");
    assert.equal(frameFor({ ...BLANK, ignoreTargets: true }).targeting.mode, "point");
});

test("a direct spell keeps a defence, so its hit tree can be reached", () => {
    /* The knock-on: with no targets there is nothing to oppose, so the outcome
     * is SUCCESS and any tree authored under `hit` is unreachable. */
    const f = frameFor(BLANK);
    assert.equal(f.defence.type, "dodge");
    assert.equal(f.targeting.mode, "direct");
});

test("the derivation alone is enough — no authored frame required", () => {
    /* The bug hid because every corpus spell overrides the derivation. */
    const d = derive(BLANK);
    assert.equal(d.targeting.mode, "direct");
});
