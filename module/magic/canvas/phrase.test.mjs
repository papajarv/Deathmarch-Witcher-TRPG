// module/magic/canvas/phrase.test.mjs
//
// EXECUTING test for expressions rendered in English.
//
// `max(1,8-{index})d6` is exactly right and completely opaque, and it was the
// only thing on the block saying Alzur's Thunder loses a die per target — so
// the most interesting fact about the spell was written in a notation nobody
// reads.
//
// This is a translator, not a decompiler, and the difference matters: a wrong
// plain-English reading is worse than the formula, because the formula at
// least admits it is one.

import test from "node:test";
import assert from "node:assert/strict";

import { phrase, isDynamic } from "./phrase.mjs";
import { registerAll } from "../spells/harness.mjs";
import { CORPUS } from "../spells/corpus.mjs";
import { getBlock } from "../registry.mjs";

test.before(registerAll);

/* ── The shapes the book actually uses ───────────────────────────────────── */

test("Alzur's falloff reads as the sentence the book prints", () => {
    const said = phrase("max(1,8-{index})d6");
    assert.match(said, /^8d6/);
    assert.match(said, /one die less for every target it has already passed through/);
    assert.match(said, /never below 1d6/, "the floor is part of the rule, not a detail");
});

test("a margin-scaled attack says what the margin is", () => {
    // "min(10,{margin})d6" tells you nothing about what {margin} means.
    assert.equal(phrase("min(10,{margin})d6"),
        "1d6 for every point the roll beat the defence by, up to 10");
});

test("the capped step reads as a step, not as arithmetic", () => {
    // Yrden and Axii share this formula; one of them capped. As
    // `-min(4,1+floor(({sta}-1)/2))` neither is legible.
    assert.equal(phrase("-min(4,1+floor(({sta}-1)/2))"),
        "−1, worsening by 1 every 2 Stamina spent, no worse than −4");
    assert.equal(phrase("-(1+floor(({sta}-1)/2))"),
        "−1, worsening by 1 every 2 Stamina spent");
});

test("dice per point spent reads as dice per point spent", () => {
    assert.equal(phrase("{sta}d6"), "1d6 per Stamina spent");
});

test("a multiplier reads as a rate", () => {
    assert.equal(phrase("5*{sta}"), "5 per Stamina spent");
    assert.equal(phrase("2*{skill}"), "2 per point of Spell Casting");
});

test("a halving says which way it rounds", () => {
    assert.equal(phrase("floor({skill}/2)"), "half of Spell Casting, rounded down");
});

/* ── What it deliberately does NOT do ────────────────────────────────────── */

test("a plain literal is left alone", () => {
    // `4d6` is already English. Printing "4d6 (that is, 4d6)" beside it is
    // noise, and noise teaches people to stop reading the annotations that
    // matter.
    for (const literal of ["4d6", "75", "3", "1d10", "2d6", "0", "-2"]) {
        assert.equal(phrase(literal), null, `${literal} was annotated`);
    }
});

test("an empty or missing expression says nothing", () => {
    for (const v of ["", null, undefined, "   "]) assert.equal(phrase(v), null);
});

test("something unrecognised is not guessed at", () => {
    // The fallback names variables and unwraps the two functions that appear
    // in practice. It does not invent a reading of arbitrary arithmetic.
    const said = phrase("{sta}*{skill}+7");
    assert.ok(said.includes("the Stamina spent") && said.includes("Spell Casting"));
    assert.ok(!said.includes("{"), "a variable leaked through untranslated");
});

/* ── Against the whole corpus ────────────────────────────────────────────── */

test("every expression in the corpus is either plain or explained", () => {
    const problems = [];
    const walk = (body) => (body ?? []).forEach(node => {
        const def = getBlock(node.b);
        if (def) {
            for (const [key, spec] of Object.entries(def.inputs ?? {})) {
                if (spec.type !== "expression") continue;
                const raw = node.a?.[key];
                if (raw == null || raw === "") continue;
                const said = phrase(raw);
                if (!isDynamic(raw)) {
                    if (said !== null) problems.push(`${raw} — a literal was annotated`);
                } else if (!said) {
                    problems.push(`${raw} — depends on the cast and says nothing`);
                } else if (said.includes("{")) {
                    problems.push(`${raw} — leaked a raw variable: ${said}`);
                }
            }
        }
        walk(node.body);
    });
    CORPUS.forEach(s => Object.values(s.on).forEach(walk));
    assert.deepEqual([...new Set(problems)], []);
});

test("nothing it says still reads like code", () => {
    const walk = (body, out) => {
        for (const node of body ?? []) {
            const def = getBlock(node.b);
            for (const [key, spec] of Object.entries(def?.inputs ?? {})) {
                if (spec.type !== "expression") continue;
                const said = phrase(node.a?.[key]);
                if (said) out.push(said);
            }
            walk(node.body, out);
        }
        return out;
    };
    const said = CORPUS.flatMap(s => Object.values(s.on).flatMap(t => walk(t, [])));
    assert.ok(said.length >= 10, `only ${said.length} readings to check`);
    for (const line of said) {
        assert.doesNotMatch(line, /floor\(|ceil\(|min\(|max\(|\{|\}|\*/, `still code: ${line}`);
    }
});
