/**
 * Lifetimes — the countdown that outlives the cast that started it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { track, tick, duringTick, rollDuration, ENDS, _resetLifetimes, _resetTicks } from "./lifetimes.mjs";


/* ── A delayed effect gets its full duration ─────────────────────────────
 *
 * `core:afterRounds` fires its body from inside the `combatRound` hook, and
 * the hook then ticks every lifetime — including the one the body had just
 * created, a few microseconds earlier. "After one round, blind them for two
 * rounds" produced a blindness that lasted one, and a one-round rider applied
 * this way expired the instant it was created.
 *
 * Anything a clock applies was affected: repeatEachRound's riders, saveEnds
 * re-applications, a zone body's statuses.
 */
test("an effect created during a round tick is not aged by that same tick", async () => {
    _resetLifetimes();
    _resetTicks();

    const early = track({ owner: "A", kind: "status", endsOn: ENDS.ROUNDS, remaining: 2 });

    /* Round one ends. The clock fires and, mid-tick, applies a second effect —
     * exactly what a deferred body does — and THEN the round is counted off,
     * which is the order `combatRound` runs in. */
    let born = null;
    await duringTick("round", async () => {
        born = track({ owner: "A", kind: "status", endsOn: ENDS.ROUNDS, remaining: 2 });
    });
    const ended1 = tick("round");
    assert.deepEqual(ended1, [], "nothing ends on the round it was created into");
    assert.equal(early.remaining, 1, "the effect that was already standing ages normally");
    assert.equal(born.remaining, 2, "the one just created keeps its full duration");

    tick("round");
    assert.equal(born.remaining, 1);
    assert.equal(early.ended, true, "and the older one runs out first, as it should");

    tick("round");
    assert.equal(born.ended, true, "two rounds means two rounds");
});

test("an effect created in ordinary play still ages at the end of that round", () => {
    /* The other half of the rule, and the reason this is a marker rather than
     * a reordering: a status applied by a cast in round one HAS been standing
     * for round one, and must lose it. */
    _resetLifetimes();
    _resetTicks();
    const cast = track({ owner: "A", kind: "status", endsOn: ENDS.ROUNDS, remaining: 2 });
    tick("round");
    assert.equal(cast.remaining, 1);
    tick("round");
    assert.equal(cast.ended, true, "two rounds, ending with the second");
});

test("the marker is spent once — a delayed effect is not immortal", async () => {
    _resetLifetimes();
    _resetTicks();
    let born = null;
    await duringTick("round", async () => {
        born = track({ owner: "A", kind: "status", endsOn: ENDS.ROUNDS, remaining: 1 });
    });
    tick("round");
    assert.equal(born.ended, false, "its one round has not been served yet");
    tick("round");
    assert.equal(born.ended, true, "and then it ends, on time");
});

/* ── A duration written in dice actually expires ─────────────────────────
 *
 * "Blinds them for 1d10 rounds" is the commonest duration in the book, and
 * every single one of them was permanent. `evaluate` returns a dice expression
 * UNROLLED by design — the roll belongs to the adapter — so the string "1d10"
 * became `remaining`, `remaining -= 1` produced NaN, and `NaN <= 0` is false
 * forever. Nothing warned; the status simply never came off.
 */
test("a dice duration is rolled once, at the start, and then counts down", async () => {
    _resetLifetimes();
    _resetTicks();
    const rolled = [];
    const ctx = { vars: {}, adapter: { rollFormula: async (f) => { rolled.push(f); return 3; } } };

    const value = await rollDuration("1d10", ctx);
    assert.deepEqual(rolled, ["1d10"], "the adapter rolls it — expression.mjs deliberately does not");
    assert.equal(value, 3);

    const life = track({ owner: "A", kind: "status:blinded", endsOn: ENDS.ROUNDS, remaining: value });
    tick("round"); tick("round");
    assert.equal(life.ended, false, "two of its three rounds served");
    tick("round");
    assert.equal(life.ended, true, "and then it ends, which it never used to");
});

test("a flat duration still needs no dice", async () => {
    const rolled = [];
    const ctx = { vars: {}, adapter: { rollFormula: async (f) => { rolled.push(f); return 99; } } };
    assert.equal(await rollDuration("3", ctx), 3);
    assert.equal(await rollDuration(2, ctx), 2);
    assert.deepEqual(rolled, [], "a number is not sent to the dice roller");
    assert.equal(await rollDuration(null, ctx), null, "no duration means no countdown");
});

test("a duration that is not a number is refused loudly, not counted silently", () => {
    /* The guard that would have caught the bug above the moment it appeared. */
    _resetLifetimes();
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...a) => warnings.push(a.join(" "));
    try {
        const life = track({ owner: "A", kind: "status:cursed", endsOn: ENDS.ROUNDS, remaining: "2d6" });
        assert.equal(typeof life.remaining, "number", "it must not be left holding a string");
        assert.match(warnings.join("\n"), /not a number/, "and it must say so");
    } finally { console.warn = realWarn; }
});

/* ── The end conditions that nothing used to fire ────────────────────────
 *
 * Eight of the twenty were declared, offered in the authoring dropdown, and
 * produced by no code anywhere. An effect wearing one sat in the live list
 * forever while looking correct in the tree — Sigil of the Hidden immobilised
 * its own caster with no way out in the whole system.
 */
test("every end condition has something that can fire it", async () => {
    const { readFileSync } = await import("node:fs");
    const here = new URL("./", import.meta.url);
    const read = (f) => readFileSync(new URL(f, here), "utf8");
    const all = read("lifetimes.mjs") + read("register.mjs") + read("standing.mjs")
              + read("adapter.mjs") + read("cast.mjs") + read("frame.mjs")
              + read("blocks/core.mjs") + read("blocks/defensive.mjs")
              + read("blocks/effects.mjs") + read("blocks/knowledge.mjs")
              + read("blocks/contest.mjs") + read("../mechanics/zoneEffects.mjs");

    /* Each condition paired with the thing that fires it. A condition with no
     * producer is an effect that never ends. */
    const producers = {
        [ENDS.ROUNDS]:          /tick\("round"/,
        [ENDS.MINUTES]:         /tick\("minute"/,
        [ENDS.HOURS]:           /tick\("hour"/,
        [ENDS.DAYS]:            /tick\("day"/,
        [ENDS.IMMEDIATE]:       /ENDS\.IMMEDIATE\)\) \{ expire/,
        [ENDS.POOL_EMPTY]:      /fireCondition\([^)]*ENDS\.POOL_EMPTY/,
        [ENDS.UPKEEP_UNPAID]:   /upkeepUnpaid/,
        [ENDS.SAVE_ENDS]:       /saveEnds|registerSave/,
        [ENDS.UNTIL_EXIT_ZONE]: /untilExitZone|UNTIL_EXIT_ZONE/,
        [ENDS.UNTIL_RECAST]:    /endOnRecast\(/,
        [ENDS.UNTIL_DISPELLED]: /endOnDispel\(/,
        [ENDS.UNTIL_PUT_OUT]:   /ENDS\.UNTIL_PUT_OUT\)/,
        [ENDS.CASTER_STRUCK]:   /ENDS\.CASTER_STRUCK\)/,
        [ENDS.UNTIL_EXPENDED]:  /ENDS\.UNTIL_EXPENDED\)/,
        [ENDS.UNTIL_DESTROYED]: /endDestroyed\(/,
        [ENDS.UNTIL_TASK_DONE]: /endTaskDone\(/,
        [ENDS.WORLD_EVENT]:     /endWorldEvent\(/,
        [ENDS.PERMANENT]:       /PERMANENT/
    };
    const orphans = Object.entries(ENDS)
        .map(([, v]) => v)
        .filter(v => !(v in producers) || !producers[v].test(all));
    assert.deepEqual(orphans, [], `${orphans.length} end conditions nothing can fire`);
});
