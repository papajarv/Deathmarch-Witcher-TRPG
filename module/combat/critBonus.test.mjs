// module/combat/critBonus.test.mjs
// Unit tests for critBonusFor — pure function that maps a severity +
// target-flag pair to the flat bonus damage added on top of the weapon
// roll. Covers RAW ladders, no-organs branch, custom ladders (from
// hrCritBonusLadders), and null/edge-case behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    critBonusFor,
    RAW_CRIT_BONUS_NORMAL,
    RAW_CRIT_BONUS_NO_ORGANS
} from "./critBonus.mjs";

test("RAW ladders match Core p.158/159", () => {
    assert.deepEqual({ ...RAW_CRIT_BONUS_NORMAL },
        { simple: 3, complex: 5, difficult: 8, deadly: 10 });
    assert.deepEqual({ ...RAW_CRIT_BONUS_NO_ORGANS },
        { simple: 5, complex: 10, difficult: 15, deadly: 20 });
});

test("normal target uses the normal ladder", () => {
    assert.equal(critBonusFor("simple",    false), 3);
    assert.equal(critBonusFor("complex",   false), 5);
    assert.equal(critBonusFor("difficult", false), 8);
    assert.equal(critBonusFor("deadly",    false), 10);
});

test("organ-immune target (elementa/specter) uses the noOrgans ladder", () => {
    assert.equal(critBonusFor("simple",    true), 5);
    assert.equal(critBonusFor("complex",   true), 10);
    assert.equal(critBonusFor("difficult", true), 15);
    assert.equal(critBonusFor("deadly",    true), 20);
});

test("null / undefined / empty severity → 0 (no bonus)", () => {
    assert.equal(critBonusFor(null,      false), 0);
    assert.equal(critBonusFor(undefined, true),  0);
    assert.equal(critBonusFor("",        false), 0);
    assert.equal(critBonusFor(0,         true),  0);
});

test("unknown severity key → 0", () => {
    assert.equal(critBonusFor("catastrophic", false), 0);
    assert.equal(critBonusFor("mild",         true),  0);
});

test("custom ladders — house-rule high-lethality tuning", () => {
    const ladders = {
        normal:   { simple: 10, complex: 15, difficult: 20, deadly: 30 },
        noOrgans: { simple: 15, complex: 20, difficult: 30, deadly: 40 }
    };
    assert.equal(critBonusFor("simple",  false, ladders), 10);
    assert.equal(critBonusFor("deadly",  false, ladders), 30);
    assert.equal(critBonusFor("simple",  true,  ladders), 15);
    assert.equal(critBonusFor("deadly",  true,  ladders), 40);
});

test("custom ladders — zero disables a tier's bonus", () => {
    const ladders = {
        normal:   { simple: 0, complex: 5, difficult: 8, deadly: 10 },
        noOrgans: { simple: 5, complex: 10, difficult: 15, deadly: 20 }
    };
    assert.equal(critBonusFor("simple",  false, ladders), 0);
    assert.equal(critBonusFor("complex", false, ladders), 5);
});

test("bad ladders arg (null / missing keys) → falls back to RAW", () => {
    assert.equal(critBonusFor("simple", false, null), 3);
    assert.equal(critBonusFor("deadly", true,  undefined), 20);
    /* Partial ladders object — missing 'normal' key falls back to
     * RAW normal ladder rather than crashing. */
    assert.equal(critBonusFor("simple", false, { noOrgans: { simple: 99 } }), 3);
    assert.equal(critBonusFor("simple", true,  { normal:   { simple: 99 } }), 5);
});
