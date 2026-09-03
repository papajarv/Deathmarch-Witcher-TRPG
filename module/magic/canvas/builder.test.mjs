// module/magic/canvas/builder.test.mjs
//
// EXECUTING test for configuring a value without writing a formula.
//
// The engine stores `max(1,8-{index})d6`, which is right for it to store and
// wrong to ask anybody to type. Nobody should need to know `{index}` exists,
// let alone that it counts from zero, in order to say "it loses a die for each
// target it passes through".
//
// The property that matters is the ROUND TRIP. A shape that can build but not
// parse makes the first edit of any authored spell a retype, and one that
// parses to different numbers than it built silently changes the spell.

import test from "node:test";
import assert from "node:assert/strict";

import { SHAPES, shapeById, parseExpression, buildExpression, describeShape,
         builderView, chooseShape, setValue, openOn } from "./builder.mjs";
import { registerAll } from "../spells/harness.mjs";
import { CORPUS } from "../spells/corpus.mjs";
import { getBlock } from "../registry.mjs";
import { evaluate } from "../expression.mjs";

test.before(registerAll);

/** Every expression the authored corpus actually uses. */
function corpusExpressions() {
    const out = new Set();
    const walk = (body) => (body ?? []).forEach(n => {
        const def = getBlock(n.b);
        for (const [k, spec] of Object.entries(def?.inputs ?? {})) {
            if (spec.type !== "expression") continue;
            const v = n.a?.[k];
            if (v != null && v !== "") out.add(String(v));
        }
        walk(n.body);
    });
    CORPUS.forEach(s => Object.values(s.on).forEach(walk));
    return [...out];
}

/* ── The round trip ──────────────────────────────────────────────────────── */

test("every expression in the corpus can be configured by choosing", () => {
    // If a shape cannot express something the book needs, that spell is one
    // nobody can edit without typing — which is the thing being removed.
    const orphans = corpusExpressions().filter(f => !parseExpression(f));
    assert.deepEqual(orphans, [], `${orphans.length} would still need the raw box`);
});

test("reading a formula and rebuilding it gives the same formula back", () => {
    // Otherwise opening a spell and pressing OK changes it.
    for (const f of corpusExpressions()) {
        const parsed = parseExpression(f);
        assert.equal(buildExpression(parsed.id, parsed.values), f, `${f} → ${parsed.id}`);
    }
});

test("every shape parses what it builds, at its defaults and beyond", () => {
    for (const shape of SHAPES) {
        for (const values of [{}, Object.fromEntries(shape.fields.map(f => [f.key, (f.min ?? 1) + 2]))]) {
            const built = shape.build(values);
            const back = shape.parse(built);
            assert.ok(back, `${shape.id} cannot read its own output: ${built}`);
            assert.equal(shape.build(back), built, `${shape.id} is lossy`);
        }
    }
});

test("no two shapes claim the same formula", () => {
    // `parseExpression` takes the first match, so an overlap would make which
    // shape you see depend on declaration order.
    for (const shape of SHAPES) {
        const built = shape.build({});
        const claimants = SHAPES.filter(s => s.parse(built));
        assert.deepEqual(claimants.map(s => s.id), [shape.id],
            `${built} is claimed by ${claimants.map(s => s.id).join(", ")}`);
    }
});

/* ── What it produces has to actually run ────────────────────────────────── */

test("everything a shape builds is something the engine can evaluate", () => {
    // A builder that emits a formula the expression layer rejects would turn a
    // configuration step into a broken spell.
    const scope = { sta: 5, margin: 7, index: 2, skill: 8, vigor: 10 };
    for (const shape of SHAPES) {
        const built = shape.build({});
        /* Dice are resolved by Foundry at cast time; strip them to check the
         * arithmetic around them. */
        const arith = built.replace(/d\d+$/, "");
        assert.doesNotThrow(() => evaluate(arith, scope), `${shape.id} built ${built}`);
    }
});

/* ── It reads as a sentence ──────────────────────────────────────────────── */

test("a shape describes itself with its numbers in it", () => {
    assert.equal(describeShape("falloff", { count: 8, die: 6, floor: 1 }),
        "8d6, losing a die for every target it has already passed through, never below 1d6");
    assert.equal(describeShape("perMargin", { cap: 10, die: 6, count: 1 }),
        "1d6 for every point the roll beat the defence by, up to 10");
});

test("no shape's label leaks a variable or a function", () => {
    // The whole point is that nobody has to meet `{index}` or `floor`.
    for (const shape of SHAPES) {
        const said = describeShape(shape.id, {});
        assert.doesNotMatch(said, /\{(sta|margin|index|skill|vigor)\}|floor\(|min\(|max\(/,
            `${shape.id} reads as: ${said}`);
    }
});

test("every slot in a label has a field behind it", () => {
    for (const shape of SHAPES) {
        const slots = [...shape.label.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
        for (const slot of slots) {
            assert.ok(shape.fields.some(f => f.key === slot),
                `${shape.id} shows {${slot}} with nothing to set it`);
        }
    }
});

/* ── The escape hatch ────────────────────────────────────────────────────── */

test("an expression no shape recognises is left alone, not approximated", () => {
    // A GM who hand-wrote something exotic keeps it. Mangling it into the
    // nearest half-matching shape would silently change their spell.
    assert.equal(parseExpression("{sta}*{skill}+7"), null);
    assert.equal(parseExpression("2d6+{vigor}"), null);
});

test("an empty value is not a shape", () => {
    for (const v of ["", null, undefined, "   "]) assert.equal(parseExpression(v), null);
});


/* ── Operating it ────────────────────────────────────────────────────────
 * The picker's state, tested without a dialog. What a person does is: open on
 * whatever is there, maybe pick a different sentence, change some numbers,
 * accept. Each of those is a function here. */

test("it opens showing what the spell already says", () => {
    // Not a blank box you have to re-derive. Alzur's opens ON the falloff,
    // with its numbers in the fields.
    const st = openOn("max(1,8-{index})d6");
    assert.equal(st.chosen ?? st.id, "falloff");
    assert.deepEqual(st.values, { floor: 1, count: 8, die: 6 });
    assert.equal(builderView("falloff", st.values).reads,
        "8d6, losing a die for every target it has already passed through, never below 1d6");
});

test("changing a number changes the sentence and the formula together", () => {
    let v = { floor: 1, count: 8, die: 6 };
    v = setValue("falloff", v, "count", 10);
    v = setValue("falloff", v, "floor", 2);
    const view = builderView("falloff", v);
    assert.match(view.reads, /^10d6/);
    assert.match(view.reads, /never below 2d6/);
    assert.equal(view.formula, "max(2,10-{index})d6");
});

test("picking a different sentence brings its own numbers", () => {
    // Carrying the previous shape's values over would produce nonsense — a
    // "sides" of 6 has no meaning on a shape with no dice.
    const next = chooseShape("step");
    assert.deepEqual(next.values, { cap: 4 });
    assert.equal(builderView(next.chosen, next.values).formula,
        "-min(4,1+floor(({sta}-1)/2))");
});

test("every option is offered, every time", () => {
    // The dialog renders all panels and hides the inactive ones, so switching
    // never has to rebuild anything.
    const view = builderView("dice", { count: 4, die: 6 });
    assert.equal(view.panels.length, SHAPES.length);
    assert.equal(view.panels.filter(p => p.active).length, 1);
    for (const panel of view.panels) {
        assert.ok(panel.label, `${panel.id} has no sentence`);
        for (const f of panel.fields) {
            assert.ok(f.value != null, `${panel.id}.${f.key} opens empty`);
            assert.ok(f.label && f.label !== f.key || f.key === f.label,
                `${panel.id}.${f.key} shows its internal name`);
        }
    }
});

test("a number cannot be set below what the field allows", () => {
    // A die with two sides is a coin; a die with zero is a crash.
    const v = setValue("dice", { count: 4, die: 6 }, "die", -3);
    assert.ok(v.die >= 2, `die became ${v.die}`);
    const c = setValue("dice", { count: 4, die: 6 }, "count", 0);
    assert.ok(c.count >= 1, `count became ${c.count}`);
});

test("a hand-written expression opens as itself, and says so", () => {
    const st = openOn("{sta}*{skill}+7");
    assert.equal(st.custom, "{sta}*{skill}+7");
    assert.ok(st.chosen, "and still offers a shape to replace it with");
});

test("field labels are words, not variable names", () => {
    for (const shape of SHAPES) {
        for (const f of builderView(shape.id, {}).panels.find(p => p.active).fields) {
            assert.doesNotMatch(f.label, /^(n|by|cap)$/, `${shape.id} shows "${f.label}"`);
        }
    }
});
