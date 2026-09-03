// module/magic/canvas/render.test.mjs
//
// EXECUTING test for the canvas layout.
//
// Layout is data here, so it can be asserted without a browser. That is the
// whole reason `render.mjs` returns objects rather than DOM.

import test from "node:test";
import assert from "node:assert/strict";

import { registerAll } from "../spells/harness.mjs";
import { palette, labelParts, defaultArgs, paletteEntry } from "./palette.mjs";
import { nodeSpec, spellSpec, frameSummary, INDENT } from "./render.mjs";
import { canDrop, canMove, insertAt, removeAt, moveTo, unreachableIn, entryOptions } from "./legality.mjs";
import { getBlock, allBlocks } from "../registry.mjs";
import { AENYE } from "../spells/fire.mjs";
import { QUEN, ACTIVE_SHIELD } from "../spells/signs.mjs";
import { STAMMELFORDS_EARTHQUAKE } from "../spells/earth.mjs";

test.before(registerAll);

/* ── The palette is the registry, not a copy of it ───────────────────────── */

test("every registered block reaches the palette", () => {
    const shown = new Set(palette().flatMap(c => c.blocks.map(b => b.id)));
    for (const def of allBlocks()) assert.ok(shown.has(def.id), `${def.id} is offered`);
});

test("a label's slots all name real inputs, so no socket is ever empty", () => {
    for (const def of allBlocks()) {
        for (const p of labelParts(def.label)) {
            if (p.kind === "slot") assert.ok(p.key in def.inputs, `${def.id} [${p.key}]`);
        }
    }
});

test("a freshly dragged block is valid immediately, not broken on arrival", () => {
    // An editor that hands you a red block the instant you use it teaches you
    // to ignore red.
    for (const def of allBlocks()) {
        const args = defaultArgs(def);
        for (const key of Object.keys(args)) assert.ok(key in def.inputs, `${def.id}.${key}`);
    }
});

/* ── Nesting ─────────────────────────────────────────────────────────────── */

test("a gate's children carry the path that addresses them", () => {
    const spec = nodeSpec(AENYE.on.hit[1], { path: [], index: 1, depth: 0 });
    assert.equal(spec.holdsBody, true);
    assert.deepEqual(spec.body[0].path, [1, "body"]);
    assert.equal(spec.body[0].depth, 1);
});

test("nesting deepens, and the indent is per level rather than per block", () => {
    const spec = nodeSpec(STAMMELFORDS_EARTHQUAKE.on.hit[0], { index: 0 });
    const inner = spec.body[0];
    assert.equal(inner.depth, 1);
    assert.ok(INDENT > 0);
});

test("an empty gate keeps a landing strip instead of collapsing", () => {
    const spec = nodeSpec({ b: "core:ifPercentile", a: { chance: 50 }, body: [] }, {});
    assert.equal(spec.emptyBody, true);
});

test("a deferred block says so, because its body runs somewhere else", () => {
    const spec = nodeSpec({ b: "core:createZone", a: {}, body: [] }, {});
    assert.equal(spec.deferred, true);
    assert.equal(spec.holdsBody, true);
});

/* ── Arguments ───────────────────────────────────────────────────────────── */

test("the label reads as a sentence, with the slots inline", () => {
    const spec = nodeSpec({ b: "core:dealDamage", a: { formula: "4d6" } }, {});
    const shape = spec.parts.map(p => p.kind === "slot" ? `<${p.key}>` : p.text.trim())
        .filter(Boolean).join(" ");
    assert.equal(shape, "deal <formula> <damageType> damage to <location>");
});

test("an argument the label never mentions still gets somewhere to live", () => {
    // Otherwise a spell can carry a value nobody can see or change — which is
    // how a 30-SP rock wall ended up with no armour.
    const spec = nodeSpec({ b: "core:createObject", a: { sp: "30" } }, {});
    const keys = spec.extras.map(e => e.key);
    assert.ok(keys.includes("blocksMovement"), "not in the label, still editable");
    assert.ok(spec.parts.some(p => p.key === "sp"), "sp IS in the label");
});

test("a dynamic vocabulary is named rather than inlined", () => {
    const spec = nodeSpec({ b: "core:applyStatus", a: {} }, {});
    const status = spec.parts.find(p => p.key === "status");
    assert.equal(status.control, "choice");
    assert.equal(status.vocabulary, "statuses", "filled from the world, not hardcoded");
    assert.equal(status.options, null);
});

/* ── A missing block explains itself ─────────────────────────────────────── */

test("an unknown block names the add-on it came from", () => {
    const spec = nodeSpec({ b: "coven:hexBolt", a: {} }, {});
    assert.equal(spec.kind, "unknown");
    assert.match(spec.hint, /“coven” add-on/);
});

test("an unknown CORE block blames the engine version, not a missing add-on", () => {
    const spec = nodeSpec({ b: "core:notARealBlock", a: {} }, {});
    assert.match(spec.hint, /version of the engine/);
});

/* ── Drop legality is the runtime's own opinion ──────────────────────────── */

test("the canvas cannot disagree with the engine, because it asks the engine", () => {
    assert.equal(canDrop(AENYE.on.hit, "hit", [], 0, "core:dealDamage").ok, true);
    const no = canDrop(AENYE.on.hit, "hit", [], 0, "core:deflect");
    assert.equal(no.ok, false);
    assert.match(no.reason, /already in flight/);
});

test("a refusal is written for the author, not for a log", () => {
    const no = canDrop([], "onExpire", [], 0, "core:dealDamage");
    assert.doesNotMatch(no.reason, /core:/, "no namespaces");
    assert.doesNotMatch(no.reason, /\[\d+\]/, "no indices");
    assert.match(no.reason, /somebody to affect/);
});

test("a tree that is already broken elsewhere does not veto an unrelated drop", () => {
    // Otherwise one bad block anywhere freezes the entire canvas.
    const broken = [{ b: "core:ifPenetratedArmour", body: [] }];
    assert.equal(canDrop(broken, "hit", [], 1, "core:applyStatus").ok, true);
});

test("dropping into a gate's body is judged inside that body", () => {
    assert.equal(canDrop(AENYE.on.hit, "hit", [1, "body"], 0, "core:healHealth").ok, true);
});

/* ── Moving ──────────────────────────────────────────────────────────────── */

test("insert and remove never mutate the tree they are given", () => {
    const before = structuredClone(AENYE.on.hit);
    insertAt(AENYE.on.hit, [], 0, { b: "core:narrate", a: {} });
    removeAt(AENYE.on.hit, [], 0);
    assert.deepEqual(AENYE.on.hit, before);
});

test("moving a block down accounts for the hole it left behind", () => {
    const tree = [{ b: "core:narrate", a: { what: "a" } },
                  { b: "core:narrate", a: { what: "b" } },
                  { b: "core:narrate", a: { what: "c" } }];
    const moved = moveTo(tree, { path: [], index: 0 }, { path: [], index: 2 });
    assert.deepEqual(moved.map(n => n.a.what), ["b", "a", "c"]);
});

test("a block cannot be dropped inside itself", () => {
    const tree = [{ b: "core:ifPercentile", a: { chance: 50 }, body: [] }];
    const no = canMove(tree, "hit", { path: [], index: 0 }, { path: [0, "body"], index: 0 });
    assert.equal(no.ok, false);
    assert.match(no.reason, /inside itself/);
});

/* ── Dimming, not forbidding ─────────────────────────────────────────────── */

test("interception blocks are dim in a cast tree, and lit in an interception one", () => {
    const blocks = palette().flatMap(c => c.blocks);
    const inCast = unreachableIn("hit", blocks);
    const inWard = unreachableIn("takeDamage", blocks);
    assert.ok(inCast.has("core:deflect"), "no cast tree will ever have an incoming attack");
    assert.ok(!inWard.has("core:deflect"));
});

test("a block needing something another block can produce is never dimmed", () => {
    // `dealDamage` needs targets, which `targetNearest` produces mid-tree, so
    // its absence right now proves nothing.
    const blocks = palette().flatMap(c => c.blocks);
    assert.ok(!unreachableIn("onExpire", blocks).has("core:dealDamage"));
});

/* ── The frame is shown as law, not as blocks ────────────────────────────── */

test("the frame reads as enforced facts", () => {
    const facts = Object.fromEntries(frameSummary(QUEN.frame).map(f => [f.key, f.value]));
    assert.match(facts.Costs, /1–7 STA, your choice/);
    assert.equal(facts.Reaches, "yourself");
    assert.match(facts["Opposed by"], /Dispel and Heliotrope are always offered/);
    assert.match(facts.Also, /can't be cast again/);
});

test("an EMPTY frame summarises rather than throwing", () => {
    // `{}` is the frame every unprogrammed spell in the world has, so this
    // threw on the first spell anyone opened — the config layer was dead for
    // all of them and perfect for none.
    const facts = frameSummary({});
    assert.ok(facts.length >= 5);
    for (const f of facts) assert.equal(typeof f.value, "string", `${f.key} is not a string`);
    assert.doesNotMatch(JSON.stringify(facts), /undefined|NaN|\[object/);
});

test("a partial frame fills in from the law, not from guesswork", () => {
    // The summary must describe what the ENGINE will do. `castFrame` runs
    // `{...FRAME_DEFAULTS, ...frame}`, so a summary of the raw authored object
    // would show one thing and do another.
    const facts = Object.fromEntries(frameSummary({ cost: { mode: "fixed", amount: 4 } })
        .map(f => [f.key, f.value]));
    assert.match(facts.Costs, /4 STA/, "what was authored");
    assert.equal(facts.Reaches, "yourself", "and the default for what was not");
    assert.match(facts.Lasts, /no time at all/);
});

test("a defence by target stat survives a half-written frame", () => {
    const facts = Object.fromEntries(frameSummary({ defence: { type: "stat" } }).map(f => [f.key, f.value]));
    assert.match(facts["Opposed by"], /the target's/);
    assert.doesNotMatch(facts["Opposed by"], /undefined/);
});

test("an upkeep is spelled out rather than printed as a keyword", () => {
    const facts = Object.fromEntries(frameSummary(ACTIVE_SHIELD.frame).map(f => [f.key, f.value]));
    assert.match(facts.Lasts, /as long as you pay the initial cost a round/);
});

test("a GM-set DC says so", () => {
    const facts = Object.fromEntries(frameSummary({
        cost: { mode: "fixed", amount: 5 }, targeting: { mode: "point" },
        defence: { type: "dc", dc: "gm" }, duration: { kind: "instant" }
    }).map(f => [f.key, f.value]));
    assert.match(facts["Opposed by"], /the GM sets/);
});

/* ── The whole item ──────────────────────────────────────────────────────── */

test("an item with two entry points renders two hats", () => {
    const spec = spellSpec(QUEN);
    assert.equal(spec.entries.length, 2);
    assert.deepEqual(spec.entries.map(e => e.entry), ["success", "takeDamage"]);
});

test("every entry point offered has a human name", () => {
    for (const e of entryOptions()) {
        assert.notEqual(e.label, e.id, `${e.id} is shown raw`);
        assert.ok(e.scope.length, `${e.id} declares what it provides`);
    }
});
