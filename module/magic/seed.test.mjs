// module/magic/seed.test.mjs
//
// EXECUTING test for the seeder's matching.
//
// The Foundry half of seeding is a loop over `item.update`. The half that can
// be wrong is the matching — 103 book names against whatever a world actually
// contains — and it is wrong in ways that are invisible afterwards: a spell
// that silently matched nothing looks exactly like a spell that was skipped
// on purpose.

import test from "node:test";
import assert from "node:assert/strict";

import { registerAll } from "./spells/harness.mjs";
import { normalise, corpusIndex, plan, payloadFor, verify, report } from "./seed.mjs";
import { CORPUS } from "./spells/corpus.mjs";

const item = (name, magic = { frame: {}, on: {} }) => ({ name, system: { magic } });

test.before(registerAll);

/* ── Matching ────────────────────────────────────────────────────────────── */

test("apostrophes match however they were typed", () => {
    // The book prints U+2019. A GM's keyboard gives U+0027. They are different
    // strings, and 14 entries in the corpus have one.
    assert.equal(normalise("Alzur's Thunder"), normalise("Alzur’s Thunder"));
    assert.equal(normalise("Carys' Hail"), normalise("Carys’ Hail"));
});

test("a sign matches with or without its element in brackets", () => {
    // The table of contents prints "Yrden (Mixed)"; every other page says
    // "Yrden". Both are the same sign.
    assert.equal(normalise("Yrden (Mixed)"), normalise("Yrden"));
    assert.equal(normalise("Fire Stream (Fire)"), normalise("Fire Stream"));
});

test("case and stray punctuation do not decide whether a spell is found", () => {
    assert.equal(normalise("  AENYE  "), normalise("Aenye"));
    assert.equal(normalise("Puro Dwr."), normalise("puro dwr"));
});

test("normalising never collapses two DIFFERENT spells together", () => {
    // The failure that would be worst: seeding Aard's trees onto Aard Sweep.
    const keys = CORPUS.map(s => normalise(s.name));
    assert.equal(new Set(keys).size, keys.length, "two entries normalise the same");
});

test("the index covers the whole corpus", () => {
    assert.equal(corpusIndex().size, CORPUS.length);
});

/* ── Planning ────────────────────────────────────────────────────────────── */

test("a plan separates what it will write from what it will not", () => {
    const p = plan([
        item("Aenye"),
        item("Yrden (Mixed)"),
        item("Grandmaster Frostbolt"),                       // homebrew
        item("Quen", { frame: {}, on: { success: [{ b: "core:createShield" }] } })
    ]);
    assert.deepEqual(p.matched.map(m => m.item.name), ["Aenye", "Yrden (Mixed)"]);
    assert.deepEqual(p.unmatched.map(u => u.item.name), ["Grandmaster Frostbolt"]);
    assert.deepEqual(p.already.map(a => a.item.name), ["Quen"]);
});

test("an already-authored spell is left alone unless you say otherwise", () => {
    // Re-running the seeder must not silently discard hand-edited trees.
    const authored = item("Aenye", { frame: {}, on: { hit: [{ b: "core:narrate" }] } });
    assert.equal(plan([authored]).matched.length, 0);
    assert.equal(plan([authored], { overwrite: true }).matched.length, 1);
});

test("the `unused` bucket is the one worth reading", () => {
    // A corpus entry nothing matched means either the world lacks that spell
    // or its name differs — and only a person can tell which.
    const p = plan([item("Aenye")]);
    assert.equal(p.unused.length, CORPUS.length - 1);
    assert.ok(p.unused.some(s => s.name === "Igni"));
});

test("one item cannot consume two corpus entries", () => {
    const p = plan([item("Aenye"), item("Aenye")]);
    assert.equal(p.matched.length, 2, "both items get the same entry");
    assert.equal(p.unused.length, CORPUS.length - 1, "and it is only used up once");
});

test("an empty world plans nothing and reports everything as unused", () => {
    const p = plan([]);
    assert.equal(p.matched.length, 0);
    assert.equal(p.unused.length, CORPUS.length);
});

/* ── Writing ─────────────────────────────────────────────────────────────── */

test("the payload touches `system.magic` and nothing else", () => {
    // This is what makes seeding reversible per spell rather than a migration.
    const payload = payloadFor(CORPUS[0]);
    assert.deepEqual(Object.keys(payload), ["system.magic"]);
    assert.deepEqual(Object.keys(payload["system.magic"]).sort(), ["frame", "on"]);
});

test("the payload is a deep copy, so an edit in one world cannot reach another", () => {
    // A corpus entry is a module-level constant shared by every world on the
    // machine. Handing Foundry the live object would let the canvas mutate the
    // source of truth for all of them.
    const spell = CORPUS.find(s => Object.keys(s.on).length);
    const payload = payloadFor(spell);
    const entry = Object.keys(spell.on)[0];
    payload["system.magic"].on[entry].push({ b: "core:narrate", a: {} });
    assert.notEqual(payload["system.magic"].on[entry].length, spell.on[entry].length);
    assert.notEqual(payload["system.magic"].frame, spell.frame);
});

test("nothing broken can be seeded", () => {
    // The corpus is tested, so this should never fire. It is the difference
    // between "cannot happen" and "does not happen", and being wrong means
    // writing broken trees onto a hundred documents at once.
    assert.deepEqual(verify().map(x => x.spell.name), []);
});

/* ── The report ──────────────────────────────────────────────────────────── */

test("the report says what will happen before anything does", () => {
    const lines = report(plan([item("Aenye"), item("Homebrew Bolt")]));
    assert.match(lines[0], /^1 to seed$/);
    assert.ok(lines.some(l => /1 with no corpus entry/.test(l)));
    assert.ok(lines.some(l => /corpus entries matched nothing/.test(l)));
});

test("a clean report mentions only what it did", () => {
    const lines = report({ matched: [1, 2], already: [], unmatched: [], unused: [] });
    assert.deepEqual(lines, ["2 to seed"]);
});
