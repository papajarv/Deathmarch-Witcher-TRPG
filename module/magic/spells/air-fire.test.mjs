// module/magic/spells/air-fire.test.mjs
//
// EXECUTING test for the Air and Fire lists.
//
// These two elements are where the frame's "one opposed roll per cast" law
// stops being sufficient, and where displacement and deflection appear — three
// mechanics that have to be distinguished from damage or they collapse into it.

import test from "node:test";
import assert from "node:assert/strict";

import { registerAll, castOne, problemsIn, OUTCOME } from "./harness.mjs";
import { _resetBus, subscriptionCount, ENTRY } from "../bus.mjs";
import { _resetLifetimes, activeLifetimes, ENDS } from "../lifetimes.mjs";
import { validateEntry } from "../registry.mjs";
import { AIR, BRONWYNS_GUST, ZEPHYR, STATIC_STORM, TELEKINESIS,
         GWYNT_TROELLI, LIGHTNING_STORM, DERVISH } from "./air.mjs";
import { FIRE, AENYE, TANIO_ILCHAR, DEMETIAS_CREST_SURGE, FLAMING_VORTEX,
         MELGARS_FIRE, SEIRFF_HAUL, MIRROR_EFFECT, CADFANS_GRASP } from "./fire.mjs";

const ALL = [...AIR, ...FIRE];

test.before(registerAll);
test.beforeEach(() => { _resetBus(); _resetLifetimes(); });

/* ── The floor ───────────────────────────────────────────────────────────── */

test("every Air and Fire entry validates against its own entry scope", () => {
    for (const sp of ALL) assert.deepEqual(problemsIn(sp), [], sp.name);
});

test("every Air and Fire entry casts to a real outcome", async () => {
    for (const sp of ALL) {
        _resetLifetimes(); _resetBus();
        const { ctx } = await castOne(sp);
        assert.equal(ctx.control.aborted, false, `${sp.name}: ${ctx.control.abortReason}`);
        assert.ok([OUTCOME.HIT, OUTCOME.SUCCESS].includes(ctx.control.outcome), sp.name);
    }
});

/* ── Entry scopes ────────────────────────────────────────────────────────── */

test("an interception tree is validated with `incoming`, not with cast targets", () => {
    // Gwynt Troelli surfaced this: its interception tree is shaped exactly like
    // Quen's, and the hardcoded scope every caller had been passing rejected
    // both. Quen's tree had simply never been validated.
    const tree = GWYNT_TROELLI.on.incomingAttack;
    assert.deepEqual(validateEntry("incomingAttack", tree, "Gwynt Troelli"), []);
    // The same tree under a CAST scope is nonsense, and now says so.
    assert.ok(validateEntry("hit", tree, "Gwynt Troelli").length > 0);
});

test("an unknown entry point is refused rather than ignored", () => {
    assert.match(validateEntry("onTuesday", [], "X")[0], /no such entry point/);
});

/* ── Displacement is not damage ──────────────────────────────────────────── */

test("BRONWYN'S GUST — the throw distance is the MARGIN, in metres", async () => {
    const { log } = await castOne(BRONWYNS_GUST, { roll: { total: 20, natural: 8, fumbleBy: 0 }, defence: 13 });
    const [, , metres, onImpact] = log.find(([k]) => k === "knockback");
    assert.equal(metres, 7, "20 - 13 = 7m");
    assert.equal(onImpact, "ramming");
});

test("BRONWYN'S GUST — the 1d6 is deliberately trivial; the wall does the work", async () => {
    const { log } = await castOne(BRONWYNS_GUST);
    const dmg = log.find(([k]) => k === "damage");
    assert.equal(dmg[3], "bludgeoning");
    assert.ok(log.some(([k]) => k === "knockback"), "and the displacement is separate from it");
});

test("ZEPHYR — the same block at a flat distance, which is the test of its shape", async () => {
    const { log } = await castOne(ZEPHYR, { roll: { total: 30, natural: 9, fumbleBy: 0 } });
    assert.equal(log.find(([k]) => k === "knockback")[2], 6, "6m regardless of the roll");
});

/* ── Deflection is not absorption ────────────────────────────────────────── */

test("GWYNT TROELLI — the ward is a threshold with no pool to deplete", async () => {
    const { log, ctx } = await castOne(GWYNT_TROELLI);
    assert.ok(!log.some(([k]) => k === "shield"), "no hit points anywhere in it");
    assert.ok(log.some(([k, n]) => k === "upkeep" && n === 4));
    assert.equal(ctx.control.outcome, OUTCOME.SUCCESS);
});

test("DERVISH — composed from the same blocks as the spells it cites, not from their trees", async () => {
    // The book says Dervish "redirects ranged attacks as per Gwynt Troelli and
    // acts as a Zephyr spell". That is shorthand for a reader. A tree that
    // imported another entry's tree would break the moment either was edited.
    const { log } = await castOne(DERVISH);
    assert.ok(log.some(([k]) => k === "knockback"), "the Zephyr half");
    assert.deepEqual(DERVISH.on.incomingAttack, GWYNT_TROELLI.on.incomingAttack,
        "structurally identical, and independently authored");
    assert.notEqual(DERVISH.on.incomingAttack, GWYNT_TROELLI.on.incomingAttack,
        "not the same object — editing one must not edit the other");
});

/* ── The second contest ──────────────────────────────────────────────────── */

test("FLAMING VORTEX — a NEW roll each round, on top of the cast's own", async () => {
    const { log } = await castOne(FLAMING_VORTEX);
    assert.ok(log.some(([k]) => k === "schedule"), "it runs on the clock");
    assert.ok(log.some(([k]) => k === "defenceRoll"), "and contests again inside it");
});

test("FLAMING VORTEX — losing the inner contest spares the target entirely", async () => {
    const dodged = await castOne(FLAMING_VORTEX, { defence: 99 });
    assert.ok(!dodged.log.some(([k]) => k === "damage"), "the cast hit; the tornado did not");
    const caught = await castOne(FLAMING_VORTEX, { defence: 2 });
    assert.ok(caught.log.some(([k]) => k === "damage"));
});

test("MELGAR'S FIRE — `castRoll` is a STANDING DC, not a fresh roll", async () => {
    // Two different sentences in one book. Flaming Vortex says "make a Spell
    // Casting roll versus their Dodge/Escape"; Melgar's says "defend at a DC
    // equal to your Spell Casting check". Treating them alike would either
    // freeze a rolling contest or re-roll a fixed one.
    const { ctx, log } = await castOne(MELGARS_FIRE, { roll: { total: 24, natural: 9, fumbleBy: 0 }, defence: 20 });
    assert.equal(ctx.record.casterRoll, 24);
    assert.ok(log.some(([k]) => k === "damage"), "24 stands against a 20 defence");

    const survived = await castOne(MELGARS_FIRE, { roll: { total: 24, natural: 9, fumbleBy: 0 }, defence: 30 });
    assert.ok(!survived.log.some(([k]) => k === "damage"));
});

test("a contest restores the cast's own margin afterwards", async () => {
    // A per-round contest must not permanently overwrite the margin the cast
    // resolved with — anything downstream scaling off {margin} would drift.
    //
    // Its own fixture rather than a corpus spell. This used to ride on Flaming
    // Vortex, which was the only entry that happened to carry BOTH a frame
    // defence and an inner contest — and it carried both because it was
    // authored wrongly: the book gives that spell exactly one check. Correcting
    // the spell would have broken a test that was never about the spell, so the
    // invariant now owns a tree that exists to state it.
    const spell = {
        name: "Margin Fixture",
        frame: {
            kind: "spell", cost: { mode: "fixed", amount: 2 },
            targeting: { mode: "direct", count: 1 }, range: 10,
            defence: { type: "dodge", ties: "defender" },
            element: "fire", duration: { kind: "instant" }
        },
        on: { hit: [
            { b: "core:contest", a: { against: "dodge", use: "newRoll" }, body: [
                { b: "core:dealDamage", a: { formula: "1", damageType: "fire", location: "torso" } }
            ]}
        ]}
    };
    const { ctx } = await castOne(spell, { roll: { total: 25, natural: 8, fumbleBy: 0 }, defence: 10 });
    assert.equal(ctx.vars.margin, 15, "25 - 10, the CAST's margin");
});

test("LIGHTNING STORM — percentile and contest are independent gates", async () => {
    const struck = await castOne(LIGHTNING_STORM, { percentileHits: true, defence: 2 });
    assert.ok(struck.log.some(([k]) => k === "damage"));

    const missed = await castOne(LIGHTNING_STORM, { percentileHits: false, defence: 2 });
    assert.ok(!missed.log.some(([k]) => k === "damage"), "the 35% failed, so no contest happened");
});

/* ── Predicates over the target and the world ────────────────────────────── */

test("STATIC STORM — only those in metal take the 2 a round", async () => {
    const { zones, log } = await castOne(STATIC_STORM);
    await zones[0].onEnter({ name: "Knight" });
    assert.ok(log.some(([k, , trait]) => k === "has" && trait === "metalGear"));

    _resetLifetimes();
    const bare = await castOne(STATIC_STORM, { targetHas: false });
    await bare.zones[0].onEnter({ name: "Peasant" });
    assert.ok(!bare.log.some(([k]) => k === "damage"), "linen is not conductive");
});

test("MIRROR EFFECT — three environmental states, and the middle one halves", async () => {
    const sun = await castOne(MIRROR_EFFECT, { environmentIs: true });
    assert.ok(sun.log.some(([k]) => k === "damage"), "10d6 in direct sunlight");

    const dark = await castOne(MIRROR_EFFECT, { environmentIs: false });
    assert.ok(!dark.log.some(([k]) => k === "damage"),
        "where the sun's rays cannot penetrate it does nothing at all");
});

/* ── The charge ward ─────────────────────────────────────────────────────── */

test("DEMETIA'S CREST SURGE — a charge count, not a hit-point pool", async () => {
    // `consumeCharge` was written for this spell and read `state.charges`,
    // which nothing in the library could set. The ward was unbuildable until
    // an entry demanded it.
    const { log } = await castOne(DEMETIAS_CREST_SURGE, { skills: { spellcast: 8 } });
    const shield = log.find(([k]) => k === "shield");
    assert.ok(shield, "a ward exists");
    assert.ok(log.some(([k]) => k === "narrate"));
});

test("DEMETIA'S CREST SURGE — subscribes at the MAGIC stage, not the damage stage", async () => {
    // Hardcoding `takeDamage` was wrong: this ward negates a whole spell and
    // never sees the damage step. A ward firing one step earlier is the same
    // mechanism pointed elsewhere, not an exception.
    await castOne(DEMETIAS_CREST_SURGE);
    assert.equal(subscriptionCount(), 1);
});

/* ── Fire's percentages stay separate from its hits ──────────────────────── */

test("AENYE — the 75% ignite is rolled apart from the attack", async () => {
    const lit  = await castOne(AENYE, { percentileHits: true });
    const cold = await castOne(AENYE, { percentileHits: false });
    assert.ok(lit.log.some(([k, , s]) => k === "status" && s === "onFire"));
    assert.ok(cold.log.some(([k]) => k === "damage"), "it still hit");
    assert.ok(!cold.log.some(([k]) => k === "status"), "it just did not catch");
});

test("TANIO ILCHAR — 100% is still a percentile, so modifiers have something to bite", async () => {
    const { log } = await castOne(TANIO_ILCHAR);
    assert.ok(log.some(([k, , s]) => k === "status" && s === "onFire"));
    assert.ok(!log.some(([k]) => k === "damage"), "it is ignition only — no damage of its own");
});

test("SEIRFF HAUL — the escape DC climbs by 1 each failed round", async () => {
    const { log } = await castOne(SEIRFF_HAUL, { roll: { total: 18, natural: 7, fumbleBy: 0 } });
    const save = log.find(([k]) => k === "save");
    assert.deepEqual(save.slice(2), ["dodge", 18]);
    const statuses = log.filter(([k]) => k === "status").map(l => l[2]);
    assert.deepEqual(statuses, ["grappled", "onFire"], "both end on the same check");
});

/* ── Narration that has to do arithmetic ─────────────────────────────────── */

test("TELEKINESIS — the ENC cap is computed, not left to the player", async () => {
    // "up to 5 ENC per 1 point of Spell Casting" is a number only the engine
    // can work out, inside a slot that by design does no arithmetic.
    const { ctx } = await castOne(TELEKINESIS, { skills: { spellcast: 9 } });
    const line = ctx.created.find(c => c.kind === "narrated").what;
    assert.match(line, /up to 45 ENC/);
    assert.ok(!line.includes("{"), "no unresolved slot survived");
});

test("CADFAN'S GRASP — the caster picks the mode, the TARGET picks the response", async () => {
    const { log } = await castOne(CADFANS_GRASP);
    assert.equal(log.filter(([k]) => k === "choose").length, 2, "two separate decisions");
});
