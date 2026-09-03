// module/magic/services.test.mjs
//
// EXECUTING test for LAW SERVICES and PER-EFFECT LIFETIMES — the two changes
// the Tome of Chaos pass forced.
//
// Services: three independent analyses of the supplement each concluded, under
// different names, that the frame's law stages must be observable and
// modifiable rather than hard-coded. Empower is the proof: it is the ONE spell
// in either book that outright broke the previous model, and it is expressed
// here purely as service modifiers with no bespoke engine support.
//
// Lifetimes: the frame's duration governs the CAST. What a cast leaves behind
// carries its own end condition. Ten entries stop being errata once that is
// true — Earthen Pillar is the canonical one.

import test from "node:test";
import assert from "node:assert/strict";

import { makeContext, OUTCOME } from "./context.mjs";
import { _resetRegistry } from "./registry.mjs";
import { registerCoreBlocks } from "./blocks/core.mjs";
import { registerDefensiveBlocks } from "./blocks/defensive.mjs";
import { castFrame } from "./frame.mjs";
import { _resetBus } from "./bus.mjs";
import { _resetContributors } from "./contributors.mjs";
import {
    registerModifier, unregisterModifier, applyService, empower,
    SERVICE, _resetServices, modifierCount
} from "./services.mjs";
import {
    track, tick, endWhere, fireCondition, activeLifetimes,
    lifetimeCount, _resetLifetimes, ENDS
} from "./lifetimes.mjs";

const MAGE = { name: "Yennefer" };
const FOE  = { name: "Drowner" };

function adapter(over = {}) {
    const log = [];
    return {
        log,
        currentStamina() { return 40; }, currentHealth() { return 50; },
        vigorThreshold() { return 12; }, chaosSpentThisRound() { return 0; },
        skillValue() { return 6; }, casterElement() { return "fire"; },
        isWitcher() { return false; }, knowsSpell() { return false; },
        async distanceBetween() { return 0; },
        async hasActiveInstance() { return false; },
        async promptStamina(_a, c) { return c.max ?? 1; },
        async applyFocusDiscount(_a, c) { return c; },
        async spendStamina(_a, n) { log.push(["sta", n]); },
        async spendHealth() {}, async commitChaos() {},
        async pickTargets() { return []; },
        async rollCast() { return over.roll ?? { total: 15, natural: 5, fumbleBy: 0 }; },
        async requestDefence() { return { option: null, total: over.defence ?? 8 }; },
        async rollPercentile(c) { log.push(["percentile", c]); return over.percentileHits ?? false; },
        async rollFormula(f) { log.push(["formula", f]); return 10; },
        async applyFumble(_a, d) { log.push(["fumble", d.band, d.tradition, d.die]); },
        async applyDamage(t, n) { log.push(["damage", t.name, n]); },
        async applyStatus(t, s) { log.push(["status", t.name, s]); },
        async removeStatus(t, s) { log.push(["removeStatus", t.name, s]); },
        async createObject(_a, o) { log.push(["object", o.what, o.hp]); return { id: "obj1", ...o }; },
        async removeObject(o) { log.push(["removeObject", o?.what]); },
        async heal() {}, async createShield() {}
    };
}

const SIMPLE = {
    frame: { kind: "spell", cost: { mode: "fixed", amount: 4 },
             targeting: { mode: "direct" }, defence: { type: "dodge" }, element: "fire" },
    on: { hit: [
        { b: "core:dealDamage", a: { formula: "2d6", damageType: "fire" } },
        { b: "core:ifPercentile", a: { chance: 50 }, body: [
            { b: "core:applyStatus", a: { status: "onFire", until: "untilPutOut" } }
        ]}
    ]}
};

function cast(over = {}, spell = SIMPLE) {
    const ad = adapter(over);
    const ctx = makeContext({
        actor: MAGE, item: { name: "Test" }, frame: spell.frame,
        adapter: ad, targets: [FOE], trees: spell.on
    });
    return castFrame(ctx, spell.on).then(c => ({ ctx: c, ad }));
}

test.before(() => { _resetRegistry(); registerCoreBlocks(); registerDefensiveBlocks(); });
test.beforeEach(() => { _resetBus(); _resetContributors(); _resetServices(); _resetLifetimes(); });

/* ── Services, mechanically ──────────────────────────────────────────────── */

test("a modifier only fires for its own service and owner", () => {
    registerModifier({ owner: MAGE, service: SERVICE.PRICE, apply: p => { p.cost -= 2; } });
    assert.equal(applyService(SERVICE.PRICE, MAGE, { cost: 5 }).cost, 3);
    assert.equal(applyService(SERVICE.PRICE, FOE,  { cost: 5 }).cost, 5, "not this owner");
    assert.equal(applyService(SERVICE.ROLL,  MAGE, { total: 5 }).total, 5, "not this service");
});

test("order decides who wins, so absolute overrides can run last", () => {
    registerModifier({ owner: MAGE, service: SERVICE.PERCENTILE, order: 0,   apply: p => { p.chance += 10; } });
    registerModifier({ owner: MAGE, service: SERVICE.PERCENTILE, order: 100, apply: p => { p.chance = 100; } });
    assert.equal(applyService(SERVICE.PERCENTILE, MAGE, { chance: 50 }).chance, 100);
});

test("a throwing modifier is contained, not fatal", () => {
    registerModifier({ owner: MAGE, service: SERVICE.PRICE, apply: () => { throw new Error("boom"); } });
    registerModifier({ owner: MAGE, service: SERVICE.PRICE, apply: p => { p.cost = 1; } });
    assert.equal(applyService(SERVICE.PRICE, MAGE, { cost: 9 }).cost, 1, "the good one still ran");
});

/* ── Services against the real stages ────────────────────────────────────── */

test("PRICE — a modifier changes what the cast actually costs", async () => {
    registerModifier({ owner: MAGE, service: SERVICE.PRICE, apply: p => { p.cost -= 3; } });
    const { ctx, ad } = await cast();
    assert.equal(ctx.vars.sta, 1, "4 - 3");
    assert.ok(ad.log.some(([k, n]) => k === "sta" && n === 1));
});

test("ROLL — a modifier changes the roll the record reports", async () => {
    registerModifier({ owner: MAGE, service: SERVICE.ROLL, apply: p => { p.total += 2; } });
    const { ctx } = await cast();
    assert.equal(ctx.record.casterRoll, 17, "15 + 2");
});

test("FUMBLE — a tradition substitutes the whole table", async () => {
    // Necromancy replaces the elemental table with Restless Spirits, and so do
    // hexes in the CORE book (p.168). This is not a supplement special case.
    const { ad } = await cast({ roll: { total: 3, natural: 1, fumbleBy: 5 } },
        { ...SIMPLE, frame: { ...SIMPLE.frame, tradition: "necromancy" } });
    assert.ok(ad.log.some(([k, , trad]) => k === "fumble" && trad === "necromancy"));
});

test("FUMBLE — an object modifies the law-stage DIE", async () => {
    // Soul Beacon: "you roll 1d10-2 instead of 1d10 when rolling on the
    // Restless Spirits table". Unreachable from any block.
    registerModifier({ owner: MAGE, service: SERVICE.FUMBLE, apply: p => { p.die = "1d10-2"; } });
    const { ad } = await cast({ roll: { total: 3, natural: 2, fumbleBy: 4 } });
    assert.ok(ad.log.some(([k, , , die]) => k === "fumble" && die === "1d10-2"));
});

test("PERCENTILE — a modifier reaches into another spell's gate", async () => {
    // Tempest elixir: "+10% to any Fire, Freeze or Prone chance".
    registerModifier({ owner: MAGE, service: SERVICE.PERCENTILE, apply: p => { p.chance += 10; } });
    const { ad } = await cast();
    assert.ok(ad.log.some(([k, c]) => k === "percentile" && c === 60), "50 + 10");
});

/* ── Empower — the spell that broke v2 ───────────────────────────────────── */

test("EMPOWER — certainty forces every percentage in the next spell to 100%", async () => {
    empower(MAGE, "certainty");
    const { ad } = await cast({ percentileHits: true });
    assert.ok(ad.log.some(([k, c]) => k === "percentile" && c === 100));
    assert.ok(ad.log.some(([k, , s]) => k === "status" && s === "onFire"));
});

test("EMPOWER — force adds 2d6 to a damaging spell it never authored", async () => {
    empower(MAGE, "force");
    const { ad } = await cast();
    assert.ok(ad.log.some(([k, f]) => k === "formula" && f === "2d6+2d6"));
});

test("EMPOWER — accuracy adds +2 to the casting roll", async () => {
    empower(MAGE, "accuracy");
    const { ctx } = await cast();
    assert.equal(ctx.record.casterRoll, 17);
});

test("EMPOWER — a natural 1 fumbles as though it were a 10", async () => {
    // The drawback rides along whichever mode was chosen, and it rewrites the
    // fumble BAND — a stage v2 declared law and unauthorable.
    empower(MAGE, "accuracy");
    const { ctx, ad } = await cast({ roll: { total: 4, natural: 1, fumbleBy: 1 } });
    assert.equal(ctx.control.fumbleBand, ">9", "forced to the worst band");
    assert.equal(ctx.control.outcome, OUTCOME.FUMBLE);
    assert.ok(ad.log.some(([k, band]) => k === "fumble" && band === ">9"));
});

test("EMPOWER — is spent on the NEXT spell, not every spell", async () => {
    empower(MAGE, "accuracy");
    const before = modifierCount();
    await cast();
    await cast();
    assert.ok(modifierCount() < before, "the modifiers released after the first cast");
});

/* ── Per-effect lifetimes ────────────────────────────────────────────────── */

test("an effect's lifetime is independent of the cast's duration", () => {
    const life = track({ owner: FOE, kind: "object:pillar", endsOn: ENDS.UNTIL_DESTROYED });
    assert.equal(lifetimeCount(), 1);
    tick("round", 50);
    assert.equal(lifetimeCount(), 1, "rounds passing do not touch it");
    endWhere(e => e === life, "destroyed");
    assert.equal(lifetimeCount(), 0);
});

test("round-scaled lifetimes expire on the clock", () => {
    track({ owner: FOE, kind: "status:blinded", endsOn: ENDS.ROUNDS, remaining: 3 });
    tick("round"); tick("round");
    assert.equal(lifetimeCount(), 1);
    const ended = tick("round");
    assert.equal(ended.length, 1);
    assert.equal(lifetimeCount(), 0);
});

test("a clock only advances the lifetimes that use it", () => {
    track({ owner: FOE, kind: "a", endsOn: ENDS.ROUNDS, remaining: 1 });
    track({ owner: FOE, kind: "b", endsOn: ENDS.HOURS,  remaining: 1 });
    tick("round");
    assert.equal(lifetimeCount(), 1, "the hour-scaled one is untouched");
});

test("several end conditions can hold at once", () => {
    // Sigil of the Hidden ends on dispel, on re-cast, OR on 10 damage to the
    // brush — which is exactly why a single `setDuration` kind was not enough.
    const life = track({
        owner: FOE, kind: "zone:sigil",
        endsOn: [ENDS.UNTIL_DISPELLED, ENDS.UNTIL_RECAST, ENDS.UNTIL_DESTROYED]
    });
    assert.equal(fireCondition(life, ENDS.SAVE_ENDS), null, "not one of its conditions");
    assert.ok(fireCondition(life, ENDS.UNTIL_RECAST), "but this one is");
    assert.equal(lifetimeCount(), 0);
});

test("onExpire fires exactly once", () => {
    let calls = 0;
    const life = track({ owner: FOE, kind: "x", endsOn: ENDS.ROUNDS, remaining: 1, onExpire: () => calls++ });
    tick("round");
    fireCondition(life, ENDS.ROUNDS);
    endWhere(e => e === life);
    assert.equal(calls, 1);
});

/* ── EARTHEN PILLAR — the canonical case ─────────────────────────────────── */

const EARTHEN_PILLAR = {
    frame: {
        kind: "spell", cost: { mode: "fixed", amount: 4 },
        targeting: { mode: "self" }, defence: { type: "none" },
        element: "earth",
        duration: { kind: "instant" }              // the CAST is immediate
    },
    on: { success: [
        { b: "core:createObject", a: { what: "pillar", hp: "10", until: "untilDestroyed" } }
    ]}
};

test("EARTHEN PILLAR — an Immediate cast leaves an object that outlives it", async () => {
    const { ctx, ad } = await cast({}, EARTHEN_PILLAR);

    assert.equal(ctx.control.outcome, OUTCOME.SUCCESS);
    assert.equal(ctx.frame.duration.kind, "instant", "the CAST is immediate");
    assert.ok(ad.log.some(([k, w, hp]) => k === "object" && w === "pillar" && hp === 10));

    assert.equal(lifetimeCount(), 1, "and the pillar persists");
    tick("round", 100);
    assert.equal(lifetimeCount(), 1, "a hundred rounds later it is still standing");

    endWhere(e => e.kind === "object:pillar", "destroyed");
    assert.ok(ad.log.some(([k]) => k === "removeObject"), "until something destroys it");
});

test("a status carries its own end condition too", async () => {
    const { ad } = await cast({ percentileHits: true });
    const burning = activeLifetimes(FOE).find(l => l.kind === "status:onFire");
    assert.ok(burning, "onFire was tracked");
    assert.deepEqual(burning.conditions, ["untilPutOut"]);
    tick("round", 20);
    assert.ok(!burning.ended, "rounds do not put a fire out");
    fireCondition(burning, ENDS.UNTIL_PUT_OUT);
    assert.ok(ad.log.some(([k, , s]) => k === "removeStatus" && s === "onFire"));
});
