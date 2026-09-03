// module/magic/spells/corpus.test.mjs
//
// EXECUTING test over the WHOLE authored corpus.
//
// The per-element files assert specific rules. This one asserts properties that
// have to hold for every entry at once — the kind of thing that only breaks
// when someone adds the ninety-first spell, which is exactly when nobody is
// looking at the ninetieth.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { registerAll, castOne, problemsIn, OUTCOME, TOUCHED } from "./harness.mjs";
import { CORPUS, spellNamed } from "./corpus.mjs";
import { allBlocks, getBlock, ENTRY_SCOPE } from "../registry.mjs";
import { _resetBus } from "../bus.mjs";
import { _resetLifetimes } from "../lifetimes.mjs";
import { FRAME_DEFAULTS } from "../context.mjs";

const BOOK = JSON.parse(readFileSync(new URL("./book-index.json", import.meta.url)));

test.before(registerAll);
test.beforeEach(() => { _resetBus(); _resetLifetimes(); });

/* ── Coverage against the book itself ────────────────────────────────────── */

test("every in-scope entry in the core rulebook is authored", () => {
    // BOOK is extracted from the PDF, not hand-written, so this catches a spell
    // being forgotten rather than a list being forgotten.
    const authored = new Set(CORPUS.map(s => s.name));
    const missing = BOOK.filter(n => !authored.has(n));
    assert.deepEqual(missing, [], `${missing.length} unauthored`);
});

test("nothing is authored that is not in the book", () => {
    const known = new Set(BOOK);
    const invented = CORPUS.map(s => s.name).filter(n => !known.has(n));
    assert.deepEqual(invented, []);
});

test("no spell is authored twice", () => {
    const seen = new Map();
    for (const s of CORPUS) {
        assert.ok(!seen.has(s.name), `${s.name} authored twice — two copies drift`);
        seen.set(s.name, s);
    }
});

/* ── Properties that must hold for all of them ───────────────────────────── */

test("every entry validates", () => {
    for (const s of CORPUS) assert.deepEqual(problemsIn(s), [], s.name);
});

test("every entry declares only known entry points", () => {
    for (const s of CORPUS) {
        for (const entry of Object.keys(s.on)) {
            assert.ok(ENTRY_SCOPE[entry], `${s.name} declares "${entry}"`);
        }
    }
});

test("every entry casts without aborting, to a real outcome", async () => {
    for (const s of CORPUS) {
        _resetBus(); _resetLifetimes();
        const { ctx } = await castOne(s, { sta: 3, band: 4 });
        assert.equal(ctx.control.aborted, false, `${s.name}: ${ctx.control.abortReason}`);
        assert.ok([OUTCOME.HIT, OUTCOME.SUCCESS, OUTCOME.MISS].includes(ctx.control.outcome),
            `${s.name} resolved as ${ctx.control.outcome}`);
    }
});

test("every entry does something — none is silently empty", async () => {
    // A spell whose tree does nothing is indistinguishable from one nobody
    // finished. `core:narrate` is what makes "there is nothing to compute" an
    // assertion rather than an absence.
    for (const s of CORPUS) {
        _resetBus(); _resetLifetimes();
        const { log } = await castOne(s, {
            sta: 3, band: 4, standingMagic: [{ id: "x", record: { casterRoll: 1 } }]
        });
        assert.ok(log.length > 0, `${s.name} did nothing at all`);
    }
});

test("every frame parameter is one the frame knows", () => {
    // Frame keys are LAW — enforced, not authorable. A typo'd one is silently
    // ignored, which is how a spell ends up with a duration nobody applies.
    const known = new Set([...Object.keys(FRAME_DEFAULTS), "recastLock", "alsoEndsOn"]);
    for (const s of CORPUS) {
        for (const key of Object.keys(s.frame)) {
            assert.ok(known.has(key), `${s.name}.frame.${key} is not a frame parameter`);
        }
    }
});

test("no entry declares a defence the frame cannot resolve", () => {
    /* The DEFENCE vocabulary, which is camelCase and is NOT the actor's skill
     * keys — those are lower-case (`resistmagic`) and are what a block's
     * `skill:` argument takes. Conflating the two is how a bulk rename once
     * turned eighteen spells' defences into something the frame cannot map. */
    const resolvable = new Set(["none", "dc", "stat", "dodge", "block", "blockOrDodge",
                                "resistMagic", "spellCasting", "swimming", "athletics"]);
    for (const s of CORPUS) {
        assert.ok(resolvable.has(s.frame.defence.type),
            `${s.name} defends with "${s.frame.defence.type}"`);
    }
});

test("a variable cost is always bounded, and never above the sign cap of 7", () => {
    for (const s of CORPUS) {
        if (s.frame.cost.mode !== "variable") continue;
        const { min, max } = s.frame.cost;
        assert.ok(Number.isFinite(min) && Number.isFinite(max), `${s.name} is unbounded`);
        assert.ok(max <= 7, `${s.name} allows ${max} — above the printed cap`);
    }
});

/* ── The library, judged by what the corpus actually uses ────────────────── */

test("no block in the library is dead", async () => {
    // The previous engine grew ~20 schema fields nobody ever read, because they
    // were specified ahead of any spell needing them. A block the whole corpus
    // never reaches for is that same failure starting again.
    const used = new Set();
    const walk = (body) => (body ?? []).forEach(n => { used.add(n.b); walk(n.body); });
    CORPUS.forEach(s => Object.values(s.on).forEach(walk));

    /* Interception-only blocks are reached through the bus rather than named
     * in a cast tree, so they are exercised by their own test files. */
    const viaBus = new Set(["core:absorbDamage", "core:negateMagic"]);
    const dead = allBlocks().map(b => b.id).filter(id => !used.has(id) && !viaBus.has(id));
    assert.deepEqual(dead, [], `${dead.length} blocks nothing uses`);
});

test("every block the corpus names is registered", () => {
    const used = new Set();
    const walk = (body) => (body ?? []).forEach(n => { used.add(n.b); walk(n.body); });
    CORPUS.forEach(s => Object.values(s.on).forEach(walk));
    for (const id of used) assert.ok(getBlock(id), id);
});

test("the corpus is broad enough to be worth trusting", () => {
    assert.ok(CORPUS.length >= 100, `${CORPUS.length} entries`);
    const used = new Set();
    const walk = (body) => (body ?? []).forEach(n => { used.add(n.b); walk(n.body); });
    CORPUS.forEach(s => Object.values(s.on).forEach(walk));
    assert.ok(used.size >= 25, `${used.size} distinct blocks exercised`);
});

/* ── The two kinds of area ───────────────────────────────────────────────
 * Frame targeting is WHO THE CAST LANDS ON NOW. A zone's shape is the
 * FOOTPRINT OF A THING LEFT BEHIND. They are different concepts that both
 * happen to be an area, and merging them makes a spell claim to hit people it
 * does not touch. */

test("a spell that only leaves a zone hits nobody when cast", () => {
    // Yrden's circle catches whoever walks in afterwards. Giving it area
    // targeting would make the frame aim a template, harvest whoever was
    // standing there, and hand them to blocks that never touch them.
    const yrden = spellNamed("Yrden");
    assert.equal(yrden.frame.targeting.mode, "self");
    const zone = yrden.on.success.find(n => n.b === "core:createZone");
    assert.equal(zone.a.shape, "radius", "so the footprint has to be stated here");
    assert.equal(zone.a.size, "3");
});

test("a spell that hits an area AND persists it states the size once", () => {
    // Static Storm's 5m radius hits the room and then keeps hurting it.
    // Stating the size in both places is how the two drift apart.
    const storm = spellNamed("Static Storm");
    assert.equal(storm.frame.targeting.size, 5);
    const zone = storm.on.success.find(n => n.b === "core:createZone");
    assert.equal(zone.a.shape, undefined, "the block should inherit, not repeat");
    assert.equal(zone.a.size, undefined);
});

test("a zone with no shape of its own inherits the cast's", async () => {
    const { castOne } = await import("./harness.mjs");
    const storm = spellNamed("Static Storm");
    const { log } = await castOne(storm, { sta: 5 });
    const zone = log.find(l => l[0] === "zone");
    assert.deepEqual([zone[1], zone[2]], ["radius", 5], "it did not follow the frame");
});

test("every shape in the corpus is one the template layer can place", () => {
    // `rect` and `sphere` were engine inventions the system had never heard
    // of, so four spells carried a shape the aiming overlay could not map and
    // silently landed on NOBODY — no error, no warning.
    const PLACEABLE = new Set(["cone", "radius", "cube", "line"]);
    const bad = [];
    for (const spell of CORPUS) {
        const t = spell.frame.targeting;
        if (t?.mode === "area" && t.shape && !PLACEABLE.has(t.shape)) {
            bad.push(`${spell.name} frame:${t.shape}`);
        }
        const walk = (body) => (body ?? []).forEach(n => {
            if (n.b === "core:createZone" && n.a?.shape && !PLACEABLE.has(n.a.shape)) {
                bad.push(`${spell.name} zone:${n.a.shape}`);
            }
            walk(n.body);
        });
        Object.values(spell.on).forEach(walk);
    }
    assert.deepEqual(bad, [], `${bad.length} spells would target nobody`);
});

/* ── The adapter contract, derived rather than guessed ───────────────────── */

test("the adapter surface the corpus needs is recorded, and it is not enormous", async () => {
    for (const s of CORPUS) {
        _resetBus(); _resetLifetimes();
        await castOne(s, { sta: 3, band: 4 });
    }
    // Whatever this set holds IS the Foundry adapter's contract. It is derived
    // from the spells rather than written in advance, which is the opposite of
    // how the previous interface was produced — and half of that one was never
    // called by anything.
    const surface = [...TOUCHED].filter(n => !n.startsWith("_")).sort();
    assert.ok(surface.length > 25, `${surface.length} methods`);
    assert.ok(surface.length < 60, `${surface.length} methods is too many to implement honestly`);
    for (const required of ["rollCast", "requestDefence", "applyDamage", "applyStatus",
                            "spendStamina", "createZone", "narrate"]) {
        assert.ok(surface.includes(required), `${required} is reached`);
    }
});

/* ── Spot checks that the index and the corpus agree ─────────────────────── */

test("spellNamed finds entries by their PRINTED name", () => {
    assert.ok(spellNamed("Alzur's Thunder"));
    assert.ok(spellNamed("Tryferi Gaeaf"));
    assert.ok(spellNamed("Quen"), "signs are indexed without their element suffix");
    assert.equal(spellNamed("Fireball"), null);
});
