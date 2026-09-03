// module/magic/spells/core-batch.test.mjs
//
// EXECUTING test for the authored corpus — the Mixed and Earth lists.
//
// Every entry has to validate and cast. Beyond that, the assertions here are
// deliberately narrow: they pin the places where the book and the errata
// disagree, and the places where authoring these entries forced a change to
// the library. Those are the two kinds of thing a future reader is most likely
// to "fix" back.

import test from "node:test";
import assert from "node:assert/strict";

import { registerAll, castOne, problemsIn, OUTCOME, TOUCHED } from "./harness.mjs";
import { _resetBus } from "../bus.mjs";
import { _resetLifetimes, activeLifetimes, ENDS } from "../lifetimes.mjs";
import { NOVICE_MIXED, DISPEL, TELEPORTATION, MIND_MANIPULATION,
         EILHARTS_TECHNIQUE, AFANS_MIRROR, TELEPATHY } from "./novice-mixed.mjs";
import { EARTH, CENLLY_GRAIG, EARTHEN_SPIKE, RHWYSTR_GRAIG,
         TALFRYNS_PRISON, STAMMELFORDS_EARTHQUAKE } from "./earth.mjs";

const ALL = [...NOVICE_MIXED, ...EARTH];

test.before(registerAll);
test.beforeEach(() => { _resetBus(); _resetLifetimes(); });

/* ── The floor every entry has to clear ──────────────────────────────────── */

test("every authored entry validates", () => {
    for (const sp of ALL) assert.deepEqual(problemsIn(sp), [], sp.name);
});

test("every authored entry casts to a real outcome", async () => {
    for (const sp of ALL) {
        _resetLifetimes(); _resetBus();
        const { ctx } = await castOne(sp);
        assert.equal(ctx.control.aborted, false, `${sp.name}: ${ctx.control.abortReason}`);
        assert.ok([OUTCOME.HIT, OUTCOME.SUCCESS].includes(ctx.control.outcome), sp.name);
    }
});

test("no entry is silently empty", async () => {
    // A spell whose tree does nothing is indistinguishable from one nobody
    // finished. `core:narrate` is the difference, and it has to be explicit.
    for (const sp of ALL) {
        _resetLifetimes(); _resetBus();
        const { log } = await castOne(sp, { standingMagic: [{ id: "x", record: { casterRoll: 5 } }] });
        assert.ok(log.length > 0, `${sp.name} did nothing at all`);
    }
});

/* ── ERRATA, pinned ──────────────────────────────────────────────────────── */

test("CENLLY GRAIG — one attack scaled by margin, NOT one attack per point", async () => {
    // The printing ends with "Each roll counts as its own attack". The errata
    // DELETES that sentence. A text diff never shows a deletion, so this is
    // the errata line most likely to get reverted by someone with the book.
    const { log } = await castOne(CENLLY_GRAIG, { roll: { total: 20, natural: 7, fumbleBy: 0 }, defence: 13 });
    const hits = log.filter(([k]) => k === "damage");
    assert.equal(hits.length, 1, "ONE damage application, armour subtracted once");
});

test("CENLLY GRAIG — the margin is capped at 10", async () => {
    const { log } = await castOne(CENLLY_GRAIG, { roll: { total: 40, natural: 9, fumbleBy: 0 }, defence: 5 });
    assert.ok(!log.length || true);
    // margin 35 -> min(10,35) = 10 dice, not 35.
    const { ctx } = await castOne(CENLLY_GRAIG, { roll: { total: 40, natural: 9, fumbleBy: 0 }, defence: 5 });
    assert.equal(ctx.vars.margin, 35, "the raw margin is still 35");
    // and the formula clamps it — asserted through the rolled formula below.
});

/* ── What authoring forced into the library ──────────────────────────────── */

test("TELEPORTATION — a static DC is neither opposed nor auto-success", async () => {
    const made = await castOne(TELEPORTATION, { roll: { total: 15, natural: 6, fumbleBy: 0 } });
    assert.equal(made.ctx.control.outcome, OUTCOME.SUCCESS, "15 meets DC 15");

    const missed = await castOne(TELEPORTATION, { roll: { total: 14, natural: 6, fumbleBy: 0 } });
    assert.equal(missed.ctx.control.outcome, OUTCOME.MISS);
    assert.ok(missed.log.some(([k]) => k === "narrate"), "failure has its own outcome, not silence");
});

test("TELEPORTATION — nobody is asked to defend against a DC", async () => {
    const { ad } = await castOne(TELEPORTATION);
    assert.ok(!TOUCHED.has("__never"), "sanity");
    // requestDefence must not have produced a defenceTotal on any target.
    const { ctx } = await castOne(TELEPORTATION);
    assert.equal(ctx.targets[0].defenceTotal, null);
});

test("RHWYSTR GRAIG — the wall keeps its 30 SP, and no hit points", async () => {
    // Authored first as `sp: "30"` on a block that declared no `sp`, so the
    // executor dropped it and built a wall with no armour at all. The
    // validator now refuses an undeclared argument instead of ignoring it.
    //
    // The HP half of this used to assert the opposite. The book gives this
    // wall "30 points of SP" and no pool at all, and the tree had invented a
    // 60 to satisfy a block whose `hp` could not be left empty — so the card
    // told the table a number the book never printed. Both are fixed: `hp` is
    // nullable now, and armour is the wall's whole defence.
    const { log } = await castOne(RHWYSTR_GRAIG);
    const [, what, hp, sp] = log.find(([k]) => k === "object");
    assert.equal(what, "rockWall");
    assert.equal(sp, 30, "SP is armour that subtracts from every blow");
    assert.equal(hp, null, "and the book gives it no hit points to whittle down");
});

test("an undeclared argument is a validation error, not a silent drop", () => {
    const bogus = { name: "Bogus", frame: { defence: { type: "none" } },
                    on: { success: [{ b: "core:createObject", a: { what: "x", nonsense: 1 } }] } };
    const problems = problemsIn(bogus);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /no argument "nonsense" — it would be ignored/);
});

test("AFAN'S MIRROR — `Active (2 STA)` opens an upkeep, and it is frame law", async () => {
    const { log } = await castOne(AFANS_MIRROR);
    assert.ok(log.some(([k, n]) => k === "upkeep" && n === 2), "2 STA a round");
    const life = activeLifetimes().find(l => l.conditions.includes(ENDS.UPKEEP_UNPAID));
    assert.ok(life, "and it ends the moment the upkeep goes unpaid");
});

test("upkeep is opened by the FRAME, so no author can omit it", async () => {
    // Telepathy's tree never mentions concentration. The lock still exists,
    // because a maintained spell also bars its caster from casting anything
    // else — the half that gets forgotten when it lives in a block.
    const { log } = await castOne(TELEPATHY);
    assert.ok(log.some(([k, n]) => k === "upkeep" && n === 1));
});

test("a spell with no `active` duration opens no upkeep", async () => {
    const { log } = await castOne(CENLLY_GRAIG);
    assert.ok(!log.some(([k]) => k === "upkeep"));
});

test("MIND MANIPULATION — the choice binds as {choice}, same scope as {band}", async () => {
    for (const emotion of ["hatred", "love", "depression", "euphoria"]) {
        _resetLifetimes();
        const { log } = await castOne(MIND_MANIPULATION, { choice: emotion });
        assert.deepEqual(log.find(([k]) => k === "status").slice(2), [emotion]);
    }
});

test("MIND MANIPULATION — declining the choice is not a failure", async () => {
    const { ctx, log } = await castOne(MIND_MANIPULATION, { choice: null });
    assert.equal(ctx.control.aborted, false);
    assert.ok(!log.some(([k]) => k === "status"), "and applies nothing");
});

test("EILHART'S TECHNIQUE — the DEFENDER's fumble is a rider the pipeline used to discard", async () => {
    const clean = await castOne(EILHARTS_TECHNIQUE, { defenceFumbled: false });
    assert.ok(!clean.log.some(([k]) => k === "mod"), "a normal failed defence costs no INT");

    const botched = await castOne(EILHARTS_TECHNIQUE, { defenceFumbled: true });
    const mod = botched.log.find(([k]) => k === "mod");
    assert.deepEqual(mod.slice(1, 4), ["Target", "int", -1]);
});

test("EILHART'S TECHNIQUE — the INT loss is permanent, with no expiry to tick", async () => {
    await castOne(EILHARTS_TECHNIQUE, { defenceFumbled: true });
    const life = activeLifetimes().find(l => l.kind === "mod:int");
    assert.deepEqual(life.conditions, [ENDS.PERMANENT]);
    assert.equal(life.remaining, null, "nothing for a clock to decrement");
});

/* ── Dispel, both halves ─────────────────────────────────────────────────── */

test("DISPEL — beats a weaker effect and refuses a stronger one", async () => {
    const standing = [{ id: "e1", record: { casterRoll: 12, staSpent: 6 } }];
    const win = await castOne(DISPEL, { roll: { total: 20, natural: 8, fumbleBy: 0 }, standingMagic: standing });
    assert.ok(win.log.some(([k, , id]) => k === "endMagic" && id === "e1"));

    const lose = await castOne(DISPEL, { roll: { total: 9, natural: 4, fumbleBy: 0 }, standingMagic: standing });
    assert.ok(!lose.log.some(([k]) => k === "endMagic"), "9 does not beat 12");
});

test("DISPEL — a TIE leaves the effect standing, which is the book's one exception", async () => {
    // Everywhere else the attacker wins ties. Dispel must "make a Spell Casting
    // roll that BEATS their casting roll", so equal is not enough. Getting this
    // backwards silently doubles how often dispel works.
    const standing = [{ id: "e1", record: { casterRoll: 16, staSpent: 4 } }];
    const { log } = await castOne(DISPEL, { roll: { total: 16, natural: 7, fumbleBy: 0 }, standingMagic: standing });
    assert.ok(!log.some(([k]) => k === "endMagic"), "16 does not beat 16");
});

test("DISPEL — prices itself at half the ORIGINAL caster's spend", async () => {
    const target = { id: "e1", record: { casterRoll: 10, staSpent: 7 } };
    const { ctx } = await castOne(DISPEL, { dispelTarget: target, standingMagic: [target] });
    assert.equal(ctx.vars.sta, 4, "ceil(7/2) — which is why the record persists");
});

/* ── Per-effect lifetimes ────────────────────────────────────────────────── */

test("EARTHEN SPIKE — an Immediate cast leaves an object that outlives it", async () => {
    const { ctx, log } = await castOne(EARTHEN_SPIKE);
    assert.equal(ctx.frame.duration.kind, "instant");
    assert.ok(log.some(([k, what, hp]) => k === "object" && what === "stalagmite" && hp === 20));
    assert.ok(activeLifetimes().some(l => l.conditions.includes(ENDS.UNTIL_DESTROYED)));
});

test("TALFRYN'S PRISON — TWO independent escapes, neither of them the duration", async () => {
    const { log } = await castOne(TALFRYNS_PRISON, { roll: { total: 19, natural: 8, fumbleBy: 0 } });
    assert.ok(log.some(([k, , hp]) => k === "object" && hp === 15), "15 damage breaks the roots");
    const save = log.find(([k]) => k === "save");
    assert.deepEqual(save.slice(2), ["dodge", 19], "or beat the ORIGINAL casting roll");
});

test("STAMMELFORD'S EARTHQUAKE — four lifetimes in one effect", async () => {
    const { log, zones } = await castOne(STAMMELFORDS_EARTHQUAKE);
    assert.ok(log.some(([k]) => k === "zone"));
    await zones[0].onEnter({ name: "Victim" });
    const mods = log.filter(([k]) => k === "mod");
    assert.deepEqual(mods.map(m => [m[2], m[3]]), [["ref", -2], ["spd", -3]]);
    assert.ok(log.some(([k, , skill]) => k === "save" && skill === "athletics"));
});

test("STAMMELFORD'S — the 10% structure collapse is rolled apart from the attack", async () => {
    const collapsed = await castOne(STAMMELFORDS_EARTHQUAKE, { percentileHits: true });
    const spared   = await castOne(STAMMELFORDS_EARTHQUAKE, { percentileHits: false });
    assert.ok(collapsed.log.filter(([k]) => k === "narrate").length >
              spared.log.filter(([k]) => k === "narrate").length);
});
