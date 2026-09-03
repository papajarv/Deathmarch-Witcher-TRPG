// module/magic/spells/sample.test.mjs
//
// EXECUTING test for stage 6 — authoring real entries against the real
// library.
//
// The point is not that these eight cast. It is to find out what the library
// still cannot say, while that is cheap to fix. Each entry was chosen because
// it stresses an axis no other one does.

import test from "node:test";
import assert from "node:assert/strict";

import { registerAll, castOne, problemsIn, OUTCOME } from "./harness.mjs";
import { getBlock } from "../registry.mjs";
import { _resetBus } from "../bus.mjs";
import { _resetContributors } from "../contributors.mjs";
import { _resetServices } from "../services.mjs";
import { _resetLifetimes, activeLifetimes, ENDS } from "../lifetimes.mjs";
/* These eight were authored first, chosen to stress DIFFERENT axes rather than
 * to work alphabetically. They now live in their element files with the rest
 * of the corpus — one authoring per spell, so the two cannot drift — and this
 * file keeps the assertions that found what the library could not say. */
import { IGNI, YRDEN } from "./signs.mjs";
import { ALZURS_THUNDER } from "./air.mjs";
import { CURSED_ILLNESS } from "./invocations.mjs";
import { ANIALWCH, MENTAL_COMMAND, TRYFERI_GAEAF } from "./water.mjs";
import { MAGIC_HEALING } from "./earth.mjs";

const SAMPLE = [IGNI, ALZURS_THUNDER, CURSED_ILLNESS, YRDEN,
                ANIALWCH, MAGIC_HEALING, MENTAL_COMMAND, TRYFERI_GAEAF];

const A = { name: "Foe A" }, B = { name: "Foe B" }, C = { name: "Foe C" };

/* The harness is shared with the rest of the corpus deliberately. A test file
 * with its own private adapter drifts from the real contract silently — this
 * one did, and stopped registering two whole block sets the moment they
 * existed. */
async function cast(spell, over = {}, targets = [A]) {
    const { ctx, log, zones } = await castOne(spell, over, targets);
    return { ctx, ad: { log, zones }, zones };
}

test.before(registerAll);
test.beforeEach(() => { _resetBus(); _resetContributors(); _resetServices(); _resetLifetimes(); });

/* ── Every authored entry must validate ──────────────────────────────────── */

test("all eight authored entries pass the validator", () => {
    for (const spell of SAMPLE) assert.deepEqual(problemsIn(spell), [], spell.name);
});

test("every block the entries reference is registered", () => {
    const seen = new Set();
    const walk = (body) => (body ?? []).forEach(n => { seen.add(n.b); walk(n.body); });
    SAMPLE.forEach(s => Object.values(s.on).forEach(walk));
    for (const id of seen) assert.ok(getBlock(id), `${id} exists`);
    assert.ok(seen.size >= 12, `${seen.size} distinct blocks exercised`);
});

/* ── IGNI — variable cost drives the damage dice ─────────────────────────── */

test("IGNI — 1 STA yields 1d6, 7 STA yields 7d6", async () => {
    const one = await cast(IGNI, { sta: 1 });
    assert.ok(one.ad.log.some(([k, f]) => k === "formula" && f === "1d6"));

    const seven = await cast(IGNI, { sta: 7 });
    assert.ok(seven.ad.log.some(([k, f]) => k === "formula" && f === "7d6"));
});

test("IGNI — the 50% ignite is independent of the hit", async () => {
    const { ad } = await cast(IGNI, { sta: 3, percentileHits: false });
    assert.ok(ad.log.some(([k]) => k === "damage"), "damage landed");
    assert.ok(!ad.log.some(([k]) => k === "status"), "but the burn did not");
});

/* ── ALZUR'S THUNDER — {index} falloff ───────────────────────────────────── */

test("ALZUR'S THUNDER — damage decays by 1d6 per target pierced", async () => {
    const { ad } = await cast(ALZURS_THUNDER, {}, [A, B, C]);
    const formulas = ad.log.filter(([k]) => k === "formula").map(e => e[1]);
    assert.deepEqual(formulas.slice(0, 3), ["8d6", "7d6", "6d6"],
        "the third body down the line takes 6d6");
});

test("ALZUR'S THUNDER — the falloff floors at 1d6, it never goes negative", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ name: `T${i}` }));
    const { ad } = await cast(ALZURS_THUNDER, {}, many);
    const formulas = ad.log.filter(([k]) => k === "formula").map(e => e[1]);
    assert.equal(formulas.at(-1), "1d6", "max(1,...) holds the floor");
});

/* ── CURSED ILLNESS — banded cost selects the effect ─────────────────────── */

test("CURSED ILLNESS — the band chosen at cost time is the cost paid", async () => {
    const low  = await cast(CURSED_ILLNESS, { band: 2 });
    assert.equal(low.ctx.vars.sta, 2);
    const high = await cast(CURSED_ILLNESS, { band: 6 });
    assert.equal(high.ctx.vars.sta, 6);
});

test("CURSED ILLNESS — the caster's roll becomes the target's escape DC", async () => {
    const { ad } = await cast(CURSED_ILLNESS, { band: 4, roll: { total: 23, natural: 9, fumbleBy: 0 } });
    assert.ok(ad.log.some(([k, , skill, dc]) => k === "save" && skill === "endurance" && dc === 23),
        "not a fixed DC — the roll itself");
});

test("CURSED ILLNESS — a priest's element resolves Mixed from the caster", async () => {
    const { ctx } = await cast(CURSED_ILLNESS, { band: 2, casterElement: "mixed" });
    assert.equal(ctx.record.element, "mixed", "the invocation itself has no element");
});

test("CURSED ILLNESS — the band's NAME reaches the status, not the literal {band}", () => {
    // Found by authoring it: the expression language is numeric-only, so
    // `status: "{band}"` shipped five literal characters to Foundry.
    return Promise.all([2, 4, 6].map(async (band, i) => {
        const { ad } = await cast(CURSED_ILLNESS, { band });
        const s = ad.log.find(([k]) => k === "status")[2];
        assert.equal(s, ["staggered", "stunned", "poisoned"][i]);
        assert.ok(!s.includes("{"), "no unresolved slot survived");
    }));
});

test("a FIXED enum is a closed list — {band} in one is left alone", async () => {
    // grantModifier's `op` has three hard-coded options. Interpolating into it
    // would let an author invent a fourth by accident.
    const { ad } = await cast(YRDEN, { sta: 3 });
    await ad.zones[0].onEnter(A);
    assert.ok(ad.log.some(([k]) => k === "mod"));
});

/* ── YRDEN — capped step scaling, and a zone that outlives nothing ───────── */

test("YRDEN — the circle is empty at cast time and penalises nobody", async () => {
    // The finding that forced SHAPE.DEFERRED. A zone body is not the caster's
    // to run: it belongs to whoever walks in, possibly rounds later.
    const { ad } = await cast(YRDEN, { sta: 7 });
    assert.ok(ad.log.some(([k]) => k === "zone"), "the circle exists");
    assert.ok(!ad.log.some(([k]) => k === "mod"), "but it has caught nobody yet");
});

test("YRDEN — the penalty is the ERRATA formula, not the stamina spent", async () => {
    // The printing still says "equal to the number of STA you spent". At the
    // 7-STA cap that would be -7; the errata caps it at -4.
    const { ad } = await cast(YRDEN, { sta: 7 });
    await ad.zones[0].onEnter(A);
    const mods = ad.log.filter(([k]) => k === "mod");
    assert.deepEqual(mods.map(m => m[3]), [-4, -4], "SPD and REF, both capped at 4");
    assert.deepEqual(mods.map(m => m[2]), ["spd", "ref"]);
});

test("YRDEN — the step is shared with Axii and rises every 2 STA", async () => {
    for (const [sta, expected] of [[1, -1], [2, -1], [3, -2], [5, -3], [7, -4]]) {
        _resetLifetimes();
        const { ad } = await cast(YRDEN, { sta });
        await ad.zones[0].onEnter(A);
        assert.equal(ad.log.find(([k]) => k === "mod")[3], expected, `${sta} STA`);
    }
});

test("YRDEN — the zone body carries the SEALED record, cast or not", async () => {
    // A penalty applied in round nine still has to name the roll and the spend
    // that created it, or Dispel has nothing to contest.
    const { ctx, ad } = await cast(YRDEN, { sta: 5, roll: { total: 21, natural: 7, fumbleBy: 0 } });
    await ad.zones[0].onEnter(B);
    const seen = ad.log.find(([k]) => k === "mod")[4];
    assert.equal(seen.casterRoll, 21);
    assert.equal(seen.staSpent, 5);
    assert.equal(seen, ctx.record, "the same frozen object, not a copy");
});

test("YRDEN — each entrant gets their own penalty, and the caster's is untouched", async () => {
    const { ad } = await cast(YRDEN, { sta: 3 });
    await ad.zones[0].onEnter(A);
    await ad.zones[0].onEnter(B);
    const names = ad.log.filter(([k]) => k === "mod").map(m => m[1]);
    assert.deepEqual(names, ["Foe A", "Foe A", "Foe B", "Foe B"]);
});

test("YRDEN — creates a zone whose modifiers lift on exit", async () => {
    const { ad } = await cast(YRDEN, { sta: 3 });
    assert.ok(ad.log.some(([k, shape, size]) => k === "zone" && shape === "radius" && size === 3));
    const life = activeLifetimes().find(l => l.kind === "zone:radius");
    assert.ok(life, "the zone is tracked");
});

/* ── ANIALWCH — armour bypass plus a second resource ─────────────────────── */

test("ANIALWCH — ignores armour AND drains stamina", async () => {
    const { ad } = await cast(ANIALWCH);
    assert.ok(ad.log.some(([k, , , , bypass]) => k === "damage" && bypass === true),
        "cannot be blocked by armor or shields");
    assert.ok(ad.log.some(([k, , res]) => k === "drain" && res === "stamina"),
        "the only core spell that damages stamina");
});

/* ── MAGIC HEALING — no defence dispatches SUCCESS, and heals per round ──── */

test("MAGIC HEALING — dispatches SUCCESS, not HIT, and heals 3 (errata)", async () => {
    const { ctx, ad } = await cast(MAGIC_HEALING);
    assert.equal(ctx.control.outcome, OUTCOME.SUCCESS);
    assert.ok(ad.log.some(([k]) => k === "schedule"), "scheduled on the round clock");
    assert.ok(ad.log.some(([k, f]) => k === "formula" && f === 3), "3 a round, not 5");
    assert.ok(ad.log.some(([k, , n]) => k === "heal" && n === 3));
});

/* ── MENTAL COMMAND — untilTaskDone and a periodic re-save ───────────────── */

test("MENTAL COMMAND — the compulsion lasts until the task is done", async () => {
    const { ad } = await cast(MENTAL_COMMAND);
    assert.ok(ad.log.some(([k, , s]) => k === "status" && s === "compelled"));
    const life = activeLifetimes(A).find(l => l.kind === "status:compelled");
    assert.deepEqual(life.conditions, [ENDS.UNTIL_TASK_DONE]);
    assert.ok(ad.log.some(([k, , skill]) => k === "save" && skill === "resistmagic"));
});

test("MENTAL COMMAND — the +5 is OFFERED, and declined by default", async () => {
    // The frame was accepting targetBonusWhen/targetBonus and reading neither.
    const { ad } = await cast(MENTAL_COMMAND);
    assert.ok(ad.log.some(([k, c]) => k === "condition" && c === "againstNature"),
        "the adjudicator was asked");
    assert.ok(ad.log.some(([k, b]) => k === "defence" && b === 0), "and said no");
});

test("MENTAL COMMAND — a confirmed +5 can turn a hit into a miss", async () => {
    const roll = { total: 12, natural: 6, fumbleBy: 0 };
    const plain = await cast(MENTAL_COMMAND, { roll, defence: 9 });
    assert.equal(plain.ctx.control.outcome, OUTCOME.HIT, "12 beats 9");

    const refused = await cast(MENTAL_COMMAND, { roll, defence: 9, conditionHolds: true });
    assert.equal(refused.ctx.control.outcome, OUTCOME.MISS, "12 does not beat 9+5");
    assert.equal(refused.ctx.targets[0].defenceTotal, 14, "the bonus is IN the total");
});

test("a spell with no conditional bonus never asks the question", async () => {
    const { ad } = await cast(IGNI, { sta: 2 });
    assert.ok(!ad.log.some(([k]) => k === "condition"));
});

/* ── TRYFERI GAEAF — the only true multi-attack ──────────────────────────── */

test("TRYFERI GAEAF — fires floor(skill/2) SEPARATE attacks", async () => {
    const { ad } = await cast(TRYFERI_GAEAF, { skills: { spellcast: 9 } });
    /* `ice` is not one of the seven damage types this system registers, so an
     * ice-typed hit matched no resistance at all. Tryferi Gaeaf's spikes are
     * `cold` now — the same change that fixed `water`, `force` and the block's
     * own `physical` default. */
    const hits = ad.log.filter(([k, , , type]) => k === "damage" && type === "cold");
    assert.equal(hits.length, 4, "floor(9/2) = 4 spikes, each resolving separately");
});

test("TRYFERI GAEAF — the freeze rider needs armour penetration, not just a hit", async () => {
    // The adapter never reports penetration, so the rider must not fire.
    const { ad } = await cast(TRYFERI_GAEAF, { skills: { spellcast: 6 } });
    assert.ok(ad.log.some(([k]) => k === "damage"), "the spikes hit");
    assert.ok(!ad.log.some(([k, , s]) => k === "status" && s === "frozen"),
        "but nothing froze without penetrating armour");
});

/* ── The whole sample ────────────────────────────────────────────────────── */

test("all eight cast without aborting", async () => {
    for (const spell of SAMPLE) {
        _resetLifetimes(); _resetBus();
        const { ctx } = await cast(spell, { sta: 3, band: 2, skills: { spellcast: 6 } });
        assert.equal(ctx.control.aborted, false, `${spell.name} aborted: ${ctx.control.abortReason}`);
        assert.ok([OUTCOME.HIT, OUTCOME.SUCCESS].includes(ctx.control.outcome),
            `${spell.name} resolved as ${ctx.control.outcome}`);
    }
});
