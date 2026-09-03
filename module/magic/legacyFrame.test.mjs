// module/magic/legacyFrame.test.mjs
//
// EXECUTING test for the derivation that makes this a replacement.
//
// Every spell in the world already declares its cost, range, defence, school,
// tier and duration. Those ARE the frame, spelled differently. If the
// derivation is wrong, the engine silently casts a different spell than the
// sheet describes — which is worse than not running at all, because it looks
// like it worked.

import test from "node:test";
import assert from "node:assert/strict";

import { frameFor, derive, parseRange, frameIsDerived } from "./legacyFrame.mjs";
import { FRAME_DEFAULTS } from "./context.mjs";
import { CORPUS } from "./spells/corpus.mjs";

/* ── The author always wins ──────────────────────────────────────────────── */

test("a frame edited in the canvas is never overwritten by a legacy field", () => {
    const system = { staminaCost: 5, magic: { frame: { cost: { mode: "fixed", amount: 99 } } } };
    assert.equal(frameFor(system).cost.amount, 99);
});

test("an untouched frame is derived, and says so", () => {
    assert.equal(frameIsDerived({ staminaCost: 5 }), true);
    assert.equal(frameIsDerived({ magic: { frame: { element: "fire" } } }), false);
});

test("a derived frame is complete — every law the engine reads is present", () => {
    const frame = frameFor({ staminaCost: 3 });
    for (const key of Object.keys(FRAME_DEFAULTS)) {
        assert.ok(key in frame, `${key} is missing, so the frame stage would use a default silently`);
    }
});

/* ── Cost ────────────────────────────────────────────────────────────────── */

test("a variable cost becomes a range, not a fixed price", () => {
    const f = derive({ variableCost: true, staminaCost: 7 });
    assert.equal(f.cost.mode, "variable");
});

test("a sign's variable cost caps at 7 whatever the field says", () => {
    // Core p.115, and it is law rather than a suggestion.
    const f = derive({ variableCost: true, staminaCost: 40, spellForm: "sign" });
    assert.equal(f.cost.max, 7);
});

/* ── Defence ─────────────────────────────────────────────────────────────── */

test("`Dodge or Block` is ONE defence the defender chooses, not two", () => {
    // Flattening them apart is how a spell ends up rolling defence twice.
    const f = derive({ defense: ["dodge", "block"] });
    assert.equal(f.defence.type, "blockOrDodge");
});

test("the sheet's lowercase keys map onto the engine's", () => {
    assert.equal(derive({ defense: ["resistmagic"] }).defence.type, "resistMagic");
});

test("no defence declared means none — and the defender is still offered Dispel", () => {
    // 52 of the 103 core entries read `Defense: None`, and the rules define
    // them as defendable by Dispel or Heliotrope. That is the frame's job, not
    // the derivation's; here it just has to say `none` rather than guess.
    assert.equal(derive({ defense: [] }).defence.type, "none");
    assert.equal(derive({ defense: ["none"] }).defence.type, "none");
});

test("the attacker must roll strictly higher", () => {
    // Errata p.164. Dispel is the one documented exception and declares its own.
    assert.equal(derive({ defense: ["dodge"] }).defence.ties, "defender");
});

/* ── Targeting ───────────────────────────────────────────────────────────── */

test("an area spell keeps its shape, its size and its exclusion", () => {
    const f = derive({ targetType: "area", areaShape: "cone", areaSize: 3, areaExcludeCaster: true });
    assert.deepEqual(f.targeting, { mode: "area", shape: "cone", size: 3, excludeCaster: true });
});

test("`ignoreTargets` means a place, not a person", () => {
    // Ice Slick freezes the floor. Letting it carry creature targets makes it
    // resolve as an attack against whoever is standing nearby.
    assert.equal(derive({ ignoreTargets: true }).targeting.mode, "point");
});

test("a self spell targets the caster and nobody else", () => {
    assert.deepEqual(derive({ targetType: "self" }).targeting, { mode: "self" });
});

/* ── Range ───────────────────────────────────────────────────────────────── */

test("range is read out of whatever the field says", () => {
    assert.equal(parseRange("12m"), 12);
    assert.equal(parseRange("3m Cone"), 3);
    assert.equal(parseRange("Self"), null);
    assert.equal(parseRange("N/A"), null);
    assert.equal(parseRange(""), null);
});

/* ── Duration ────────────────────────────────────────────────────────────── */

test("`Active (2 STA)` becomes a maintained spell, upkeep and all", () => {
    const f = derive({ duration: { unit: "rounds", value: "Active (2 STA)" } });
    assert.deepEqual(f.duration, { kind: "active", upkeep: 2 });
});

test("the other two upkeep phrasings survive too", () => {
    // Fire Stream pays half the initial cost; Active Shield pays all of it.
    assert.equal(derive({ duration: { unit: "rounds", value: "Active (1/2 Initial STA)" } }).duration.upkeep, "half");
    assert.equal(derive({ duration: { unit: "rounds", value: "Active (Initial STA)" } }).duration.upkeep, "initial");
});

test("a dice duration is kept as dice, not rounded at derivation time", () => {
    // "1d10 rounds" is rolled when the spell is cast, not when the sheet opens.
    assert.deepEqual(derive({ duration: { unit: "rounds", value: "1d10" } }).duration,
                     { kind: "rounds", value: "1d10" });
});

test("`immediate` and `instant` are the same thing", () => {
    assert.equal(derive({ duration: { unit: "immediate" } }).duration.kind, "instant");
});

/* ── Identity ────────────────────────────────────────────────────────────── */

test("an invocation inherits its element from the caster", () => {
    // Priests and druids have no school of their own; they resolve Mixed.
    assert.equal(derive({ spellForm: "invocation", school: "earth" }).element, "inherit");
    assert.equal(derive({ spellForm: "spell", school: "earth" }).element, "earth");
});

test("a sign is a sign, and that decides its cost cap and its fumble table", () => {
    assert.equal(derive({ spellForm: "sign" }).kind, "sign");
});

/* ── Against the corpus ──────────────────────────────────────────────────── */

test("a derived frame is shaped like an authored one", () => {
    // Not identical — the corpus knows things a sheet field cannot, like
    // Quen's recast lock. But the same keys, so the frame stage reads both.
    const derived = frameFor({ staminaCost: 5, defense: ["dodge"], duration: { unit: "rounds", value: "5" } });
    const authored = CORPUS[0].frame;
    for (const key of ["kind", "cost", "targeting", "defence", "element", "duration"]) {
        assert.equal(typeof derived[key], typeof { ...FRAME_DEFAULTS, ...authored }[key], key);
    }
});

test("an empty system derives something castable rather than throwing", () => {
    const f = frameFor({});
    assert.equal(f.cost.mode, "fixed");
    assert.equal(f.defence.type, "none");
    assert.equal(f.duration.kind, "instant");
});
