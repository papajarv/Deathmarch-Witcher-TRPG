/**
 * Two things the builder could show but never produce.
 *
 * 1. A negative flat. `flat` is the only shape that can express a penalty, and
 *    its field had `min: 0` while `setValue` clamps to `min ?? 0`. So Yrden's
 *    -2 SPD opened correctly, and the moment you touched the number it became
 *    0 — with no way to type it back. No GM could author any penalty at all.
 *
 * 2. A blank. An input declaring `default: null` documents a meaning for the
 *    empty value ("the same area the cast used", "for the whole duration").
 *    The dialog could return a formula or "cancelled", and cancelled means no
 *    change — so once a value was set it could never be unset, and the palette
 *    seeded "1" into those inputs on drop, replacing the documented meaning
 *    with the number one before the author ever saw it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openOn, setValue, buildExpression, parseExpression } from "./canvas/builder.mjs";
import { defaultArgs } from "./canvas/palette.mjs";
import { registerAll } from "./spells/harness.mjs";
import { getBlock } from "./registry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
registerAll();

test("a negative flat survives being edited", () => {
    for (const n of [-1, -2, -3]) {
        const opened = openOn(String(n));
        assert.equal(opened.id ?? opened.chosen, "flat", `${n} should open as a flat`);
        assert.equal(opened.values.n, n, `${n} must open with its own value`);
        const edited = setValue("flat", opened.values, "n", n);
        assert.equal(edited.n, n, `${n} must survive setValue — it used to clamp to 0`);
        assert.equal(buildExpression("flat", edited), String(n));
    }
});

test("a penalty can be authored from scratch", () => {
    const fresh = setValue("flat", { n: 1 }, "n", -2);
    assert.equal(buildExpression("flat", fresh), "-2");
});

test("perMargin's count reaches the formula", () => {
    assert.equal(buildExpression("perMargin", { count: 1, cap: 10, die: 6 }), "min(10,{margin})d6",
        "one die per point must keep the exact original form");
    const two = buildExpression("perMargin", { count: 2, cap: 5, die: 6 });
    assert.notEqual(two, "min(5,{margin})d6", "count changed the label but not the formula");
    assert.deepEqual(parseExpression(two).values, { count: 2, cap: 5, die: 6 }, "and it must round-trip");
});

test("an input whose blank is meaningful is not seeded with a number", () => {
    /* These five document a behaviour for the empty value. */
    const CASES = [
        ["core:createZone",      "size"],
        ["core:targetNearest",   "within"],
        ["core:repeatEachRound", "rounds"],
        ["core:createObject",    "sp"],
        ["core:createShield",    "charges"]
    ];
    for (const [id, key] of CASES) {
        const def = getBlock(id);
        assert.ok(def, `${id} is gone — update this test`);
        assert.equal(def.inputs[key]?.default, null, `${id}.${key} no longer documents a blank`);
        assert.equal(defaultArgs(def)[key], null,
            `dropping ${id} seeds ${key}, replacing "blank means inherit" with a number`);
    }
});

test("the expression dialog can return a blank where one is meaningful", () => {
    const SRC = code(readFileSync(join(HERE, "canvas/sheet.mjs"), "utf8"));
    assert.match(SRC, /action === "blank" \? null/, "no path returns a cleared value");
    assert.match(SRC, /const canBlank = "default" in spec && spec\.default === null/,
        "the blank option must be offered only where blank means something");
});
