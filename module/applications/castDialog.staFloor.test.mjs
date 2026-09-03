/**
 * The Stamina box in the cast dialog must never open on 0 for a spell that
 * costs something.
 *
 * The floor was `isSign ? 1 : 0`, so an ordinary VARIABLE-cost spell opened at
 * 0 and permitted 0. That is not a cosmetic default — the number the box holds
 * is the number that gets spent:
 *
 *   - Aard loaded from the book cast for free.
 *   - A banded cost (Cursed Illness) bought no band at all, because 0 reaches
 *     no rung, so `{band}` never resolved and the status was dropped as an
 *     unknown id. The spell rolled, charged nothing, and did nothing.
 *
 * A FIXED cost keeps a floor of 0, because a spell whose printed cost really is
 * 0 should show 0.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const SRC = code(readFileSync(join(HERE, "castDialog.mjs"), "utf8"));

/* The dialog builds its markup as a string, so the floor is asserted at its
 * source. The rendered result is covered live in spell-engine/live/stafloor.mjs,
 * which reads the actual input's `value` and `min` out of a running world. */

test("a variable cost floors at 1, not 0", () => {
    assert.match(SRC, /const staFloor = \(isSign \|\| sys\.variableCost\) \? 1 : 0;/,
        "a variable-cost spell must not open on 0 — that is a free cast");
});

test("the floor is applied to the input's bounds and its value", () => {
    assert.match(SRC, /min="\$\{staFloor\}"/, "the input must not accept below the floor");
    assert.match(SRC, /const staDefault = sys\.variableCost \? staFloor : baseSta;/,
        "a variable cost must default to its floor");
});

test("the same floor is applied when the value is read back", () => {
    /* The box can be cleared or typed over, and an empty box reads as 0. */
    assert.match(SRC, /const spendFloor = \(isSign \|\| item\.system\?\.variableCost\) \? 1 : 0;/);
    assert.match(SRC, /staSpend = Math\.max\(spendFloor,/);
});

test("a genuinely free spell still shows 0", () => {
    /* `baseSta` is 0 only when the item's printed cost is 0 — the floor never
     * raises a FIXED cost. */
    assert.match(SRC, /let baseSta = rawCost > 0 \? Math\.max\(1, rawCost - defFocus\) : 0;/);
});

test("signs keep their 7-Stamina cap", () => {
    assert.match(SRC, /max="\$\{SIGN_STA_CAP\}"/);
});
