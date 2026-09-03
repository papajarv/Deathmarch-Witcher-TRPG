// module/magic/adapter.test.mjs
//
// EXECUTING test for the Foundry adapter's CONTRACT.
//
// The adapter itself cannot be imported here — it pulls in the socket layer,
// which pulls in Foundry. That is the point of the seam, not a gap in it.
//
// What can be checked, and what actually matters, is whether the adapter
// covers what the spells reach for. The corpus is cast through a recording
// proxy; whatever it touches is the contract; the adapter's source is read and
// compared against it. A spell needing a method nobody wrote fails here rather
// than at the table, silently, mid-fight.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

import { registerAll, castOne, TOUCHED, _resetTouched } from "./spells/harness.mjs";
import { CORPUS } from "./spells/corpus.mjs";
import { _resetBus } from "./bus.mjs";
import { _resetLifetimes } from "./lifetimes.mjs";
import { registerClock, advanceMagicClocks, cancelClock, cancelClocksFor,
         _clockCount, _resetClocks } from "./adapter.clocks.mjs";

const HERE = new URL("./adapter.mjs", import.meta.url);
const SRC = readFileSync(HERE, "utf8");

/** Method names on the object `foundryAdapter` returns. */
function adapterMethods(src) {
    const body = src.slice(src.indexOf("return {"), src.indexOf("/* ── Helpers ─"));
    const names = new Set();
    /* `async name(...)`, `name: (...)`, `name: async (...)` — the three forms
     * the file actually uses. */
    for (const m of body.matchAll(/^\s{8}(?:async\s+)?([a-zA-Z]\w*)\s*[(:]/gm)) names.add(m[1]);
    return names;
}

/** What the whole corpus reaches for. */
async function contractFromCorpus() {
    registerAll();
    _resetTouched();
    for (const spell of CORPUS) {
        _resetBus(); _resetLifetimes();
        await castOne(spell, { sta: 3, band: 4, standingMagic: [{ id: "x", record: { casterRoll: 1 } }] });
    }
    return new Set([...TOUCHED].filter(n => !n.startsWith("_") && n !== "log" && n !== "zones"));
}

test("the adapter implements everything the corpus asks for", async () => {
    const needed = await contractFromCorpus();
    const have = adapterMethods(SRC);
    const missing = [...needed].filter(n => !have.has(n)).sort();
    assert.deepEqual(missing, [], `${missing.length} methods the spells need and nobody wrote`);
});

test("the adapter carries nothing the corpus never reaches for", async () => {
    // The previous interface was written in advance and half of it was never
    // called. Anything here that no spell touches is that starting again.
    const needed = await contractFromCorpus();
    const have = adapterMethods(SRC);
    /* Live, but on paths a corpus cast cannot take. Listed with the reason so
     * the exemption stays honest rather than becoming a place to hide things. */
    /* Not a method — state the adapter carries for one cast. It is on the
     * returned object because `createZone` has to read what `pickTargets`
     * aimed, and an adapter is built per cast so it cannot leak into the next
     * one. */
    const NOT_A_METHOD = new Set(["lastPlacement"]);

    const OFF_THE_CAST_PATH = new Map([
        ["pickTargets",          "only runs when the caster hasn't already targeted"],
        ["removeStatus",         "fires when a lifetime expires, rounds later"],
        ["removeModifier",       "fires when a lifetime expires"],
        ["removeZone",           "fires when a lifetime expires"],
        ["removeObject",         "fires when a lifetime expires"],
        ["removeSummon",         "fires when a lifetime expires"],
        ["removePool",           "fires when a lifetime expires"],
        ["removeCounteract",     "fires when a lifetime expires"],
        ["releaseConcentration", "fires when the upkeep goes unpaid"],
        ["onDeflect",            "reached through the interception bus"],
        /* Asked of the DEFENDER, not the caster, and only while assembling the
         * defences on offer. A corpus cast resolves against a stub defender who
         * is nobody's witcher, so the contributed path is never entered here.
         * Both are covered directly by heliotrope.test.mjs. */
        ["isWitcher",            "asked of a defender when gathering contributed defences"],
        ["knowsSpell",           "asked of a defender when gathering contributed defences"],
        /* Called by frame.declare when the CAST DIALOG hands back a random
         * location. The corpus harness has no declareCast at all, so declare
         * returns before it — covered directly in aiming.test.mjs. */
        ["rollLocation",         "runs on the declaration the cast dialog returns"],
        /* The shield pool moved onto the actor so the damage calculator can
         * see it. A corpus cast raises a ward; nothing in a corpus cast then
         * ATTACKS the warded actor, so the drain path is exercised by the
         * live ward scenarios (chainmatrix) rather than here. */
        ["shieldPool",           "read when a ward absorbs an incoming hit"],
        ["setShieldPool",        "written when a ward absorbs an incoming hit"],
        /* Same shape, for a ward counted in BLOCKS rather than hit points.
         * A corpus cast raises Demetia's Crest; nothing in a corpus cast then
         * throws a water spell at the warded actor, so the spend path belongs
         * to the live ward scenarios like the pool above. */
        ["wardCharges",          "read when a charge ward turns something aside"],
        ["setWardCharges",       "written when a charge ward turns something aside"],
        /* Fires when a maintained spell lapses, which is a round tick away
         * from any cast — covered by the upkeep tests in frame.test.mjs. */
        ["cancelClocks",         "runs when the upkeep goes unpaid, rounds later"],
        /* Published into every cast's variable scope by the frame, so a spell
         * that scales off "points of Spell Casting" reads the rank rather than
         * the roll total. The corpus reaches it as `{rank}`, not by name. */
        ["skillRank",            "published into the expression scope as {rank}"]
    ]);
    const unused = [...have]
        .filter(n => !needed.has(n) && !OFF_THE_CAST_PATH.has(n) && !NOT_A_METHOD.has(n))
        .sort();
    assert.deepEqual(unused, [], `${unused.length} methods nothing calls`);
});

/* ── Its own dependencies ────────────────────────────────────────────────
 * The hole this suite had. It checked that every method the corpus needs
 * EXISTS, and never that those methods' own imports resolve — so the first
 * version of the adapter reached for `promptVariableCost`, `promptBandedCost`
 * and a `rolls/fumble.mjs` that were not there, and would have thrown on every
 * sign, every banded invocation, and every fumble in the game.
 *
 * Three hard failures the contract test waved through, because a contract
 * about the outside of a thing says nothing about the inside. */

test("every module the adapter lazily imports exists", () => {
    for (const [, spec] of SRC.matchAll(/await import\("([^"]+)"\)/g)) {
        assert.ok(existsSync(new URL(spec, HERE)), `${spec} does not exist`);
    }
});

test("every name the adapter destructures from an import is actually exported", () => {
    /* `const { a } = await import("x")` is the only form the file uses, and the
     * one where a missing export fails SILENTLY as `undefined` rather than
     * loudly at link time. That silence is exactly why this needs checking. */
    for (const [, names, spec] of SRC.matchAll(/const\s*\{([^}]+)\}\s*=\s*await import\("([^"]+)"\)/g)) {
        const target = new URL(spec, HERE);
        assert.ok(existsSync(target), `${spec} does not exist`);
        const source = readFileSync(target, "utf8");
        for (const name of destructured(names)) {
            assert.ok(exportsName(source, name), `${spec} does not export ${name}`);
        }
    }
});

test("every statically imported name resolves too", () => {
    for (const [, names, spec] of SRC.matchAll(/^import\s*\{([^}]+)\}\s*from\s*"([^"]+)";/gm)) {
        const target = new URL(spec, HERE);
        assert.ok(existsSync(target), `${spec} does not exist`);
        const source = readFileSync(target, "utf8");
        for (const name of destructured(names)) {
            assert.ok(exportsName(source, name), `${spec} does not export ${name}`);
        }
    }
});

test("nothing is imported and then never used", () => {
    // `buildActiveShield` was imported by `createShield` and never called —
    // harmless, but it is a claim about a dependency that isn't one.
    //
    // USED, not CALLED. The first version asked for `name(` and failed on
    // `AREA_CANCELLED`, which is a constant — a check that only understands
    // functions reports honest code as dead.
    for (const m of SRC.matchAll(/const\s*\{([^}]+)\}\s*=\s*await import\("[^"]+"\)/g)) {
        const after = SRC.slice(m.index + m[0].length);
        for (const name of destructured(m[1])) {
            assert.ok(new RegExp(String.raw`\b${name}\b`).test(after),
                `${name} is imported but never used`);
        }
    }
});

/* ── Permissions ─────────────────────────────────────────────────────────
 * The constraint that governs this whole file: applying anything to an actor
 * the caster does not own fails outright on a player client. A spell that
 * works for the GM and silently does nothing for a player is the commonest
 * shape of bug in a Foundry system, and it is invisible in single-player
 * testing — which is how it ships. */

test("nothing writes to a foreign actor directly", () => {
    const body = SRC.slice(SRC.indexOf("return {"), SRC.indexOf("/* ── Helpers ─"));
    /* `actor.update` and `actor.setFlag` on the CASTER are fine — the caster is
     * always owned by whoever is casting. Writes to a `target` are not. */
    for (const forbidden of [/target\?\.update\(/, /target\.update\(/,
                             /target\?\.createEmbeddedDocuments\(/,
                             /target\.createEmbeddedDocuments\(/,
                             /target\?\.setFlag\(/, /target\.setFlag\(/]) {
        assert.doesNotMatch(body, forbidden, `direct write to a target: ${forbidden}`);
    }
});

test("every write that can touch a foreign actor goes through the GM socket", () => {
    const body = SRC.slice(SRC.indexOf("return {"), SRC.indexOf("/* ── Helpers ─"));
    const outward = {
        applyDamage:    /emitApplyDamage\(/,
        applyStatus:    /emitApplyStatus\(/,
        removeStatus:   /emitApplyStatus\(/,
        /* NOT emitApplyDamage — healing as negative damage was clamped away by
         * the damage calculator, so it had its own GM route added. */
        heal:           /emitHealActor\(/,
        /* A drain is a SUBTRACTION off a pool, not an ActiveEffect modifier
         * sitting on one — see the note in the adapter. It has its own GM
         * route for the same reason healing does. */
        drainResource:  /emitDrainPool\(|emitApplyDamage\(/,
        grantModifier:  /emitApplyAuthoredEffects\(/,
        grantPool:      /emitApplyAuthoredEffects\(/,
        registerSave:   /emitApplyAuthoredEffects\(/,
        /* Removal is the other half of application, and it used to be gated on
         * `effect.isOwner` — so an effect placed on somebody else's actor
         * applied through the GM and then never lifted. */
        removeModifier: /emitRemoveAuthoredEffects\(/,
        endMagic:       /emitRemoveAuthoredEffects\(/,
        knockback:      /emitPushToken\(/
    };
    for (const [method, route] of Object.entries(outward)) {
        const impl = methodBody(body, method);
        assert.ok(impl, `${method} exists`);
        assert.match(impl, route, `${method} must route through the GM`);
    }
});

test("the defender's own client answers the defence prompt", () => {
    // Deciding a contributed defence FOR someone is deciding whether they
    // spend their stamina. Heliotrope and Dispel both cost the defender.
    const impl = methodBody(SRC, "requestDefence");
    assert.match(impl, /requestDefenseFromOwner\(/);
});

/* ── The record ──────────────────────────────────────────────────────────── */

test("the cast record is stamped onto every effect that persists", () => {
    // Dispel, Heliotrope, Holy Fortification and Puppet all contest the
    // ORIGINAL caster's roll, possibly hours later. An effect that does not
    // carry it cannot be contested at all.
    assert.match(SRC, /const magicFlags = \(record, item\) =>/);
    const payload = SRC.slice(SRC.indexOf("function effectPayload"), SRC.indexOf("const CLOCKS"));
    assert.match(payload, /magicFlags\(record, item\)/);
});

test("private knowledge is whispered rather than posted", () => {
    // A diagnostic that posts a monster's exact remaining HP to the whole
    // table hands everyone information one character paid five Stamina for.
    const impl = methodBody(SRC, "revealInfo");
    assert.match(impl, /whisper:/);
    assert.match(impl, /to === "table" \? \[\] : \[game\.user\.id\]/);
});

/* ── Cancelling is an answer ─────────────────────────────────────────────── */

test("dismissing a choice is a real answer, not a thrown failure", () => {
    const impl = methodBody(SRC, "chooseOption");
    assert.match(impl, /catch\(\(\) => null\)/);
});

test("declining to pick targets aborts rather than casting at nobody", () => {
    const impl = methodBody(SRC, "pickTargets");
    assert.match(impl, /return null;/);
});

/* ── Clocks ──────────────────────────────────────────────────────────────── */

test("a repeating clock fires every round until it is spent", async () => {
    _resetClocks();
    let fired = 0;
    registerClock({ actor: {}, rounds: 3, run: () => { fired++; } });
    for (let i = 0; i < 5; i++) await advanceMagicClocks();
    assert.equal(fired, 3, "three rounds, then it stops");
    assert.equal(_clockCount(), 0, "and takes itself off the clock");
});

test("a delayed clock waits, then fires once", async () => {
    // Magic Trap "takes one round to prepare", and nothing else in the core
    // book has a wind-up — which is why it had to be sayable rather than
    // assumed. A trap that is live the instant it lands is a different spell.
    _resetClocks();
    const seen = [];
    registerClock({ actor: {}, rounds: 2, once: true, run: () => seen.push("boom") });
    await advanceMagicClocks();
    assert.deepEqual(seen, [], "still arming");
    await advanceMagicClocks();
    assert.deepEqual(seen, ["boom"]);
    await advanceMagicClocks();
    assert.deepEqual(seen, ["boom"], "once means once");
});

test("an unbounded clock runs until something cancels it", async () => {
    _resetClocks();
    let fired = 0;
    const clock = registerClock({ actor: {}, rounds: null, run: () => { fired++; } });
    for (let i = 0; i < 4; i++) await advanceMagicClocks();
    assert.equal(fired, 4);
    assert.equal(cancelClock(clock), true);
    await advanceMagicClocks();
    assert.equal(fired, 4, "cancelled means cancelled");
});

test("a clock that throws is removed, not left to throw every round forever", async () => {
    // One broken spell must not make the round button useless for the session.
    _resetClocks();
    let good = 0;
    registerClock({ actor: {}, rounds: null, run: () => { throw new Error("bad spell"); } });
    registerClock({ actor: {}, rounds: null, run: () => { good++; } });
    await advanceMagicClocks();
    await advanceMagicClocks();
    assert.equal(_clockCount(), 1, "the broken one is gone");
    assert.equal(good, 2, "the working one carried on");
});

test("ending a caster's concentration stops everything they had running", async () => {
    _resetClocks();
    const mage = { name: "Yennefer" }, other = { name: "Triss" };
    registerClock({ actor: mage,  rounds: null, run: () => {} });
    registerClock({ actor: mage,  rounds: null, run: () => {} });
    registerClock({ actor: other, rounds: null, run: () => {} });
    assert.equal(cancelClocksFor(mage), 2);
    assert.equal(_clockCount(), 1);
});

/** Names out of an import clause, `a, b as c` alike. */
function destructured(clause) {
    return clause.split(",")
        .map(x => x.trim().split(/\s+as\s+|:/)[0].trim())
        .filter(Boolean);
}

/**
 * Does `source` export `name`?
 *
 * `String.raw` because these patterns are backslash-dense, and inside a plain
 * template literal every escape is eaten silently — which is how the first
 * version of this test reported that a file did not export something it
 * plainly did.
 */
function exportsName(source, name) {
    const declared = new RegExp(String.raw`export\s+(?:async\s+)?(?:function|const|let|class)\s+${name}\b`);
    const listed   = new RegExp(String.raw`export\s*\{[^}]*\b${name}\b[^}]*\}`);
    return declared.test(source) || listed.test(source);
}

function methodBody(src, name) {
    const start = src.search(new RegExp(`^\\s{8}(?:async\\s+)?${name}\\s*[(:]`, "m"));
    if (start < 0) return "";
    const from = src.slice(start);
    /* Up to the next sibling method at the same indent — good enough to assert
     * on, and it fails loudly rather than silently if the shape changes. */
    const next = from.slice(1).search(/^\s{8}(?:async\s+)?[a-zA-Z]\w*\s*[(:]/m);
    return next < 0 ? from : from.slice(0, next + 1);
}
