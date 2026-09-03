// module/magic/quen.test.mjs
//
// EXECUTING test for the interception path — the architecture's stress test.
//
// Aenye proves the happy path: pay, roll, oppose, apply. Quen proves the
// design, because it needs three things Aenye never touches:
//
//   1. TWO entry points on ONE item — a cast tree and an interception tree.
//   2. Damage intercepted AHEAD of armour, with overflow continuing normally.
//   3. A filter over the INCOMING ITEM'S OWN DEFENCE ENTRY — "any spell which
//      can be Blocked" — which is a dependency running backwards through the
//      pipeline, from the attacker's rules text into the defender's damage
//      step. It only works because the cast record is public and persisted.
//
// If the architecture were wrong, this file would not be writable.

import test from "node:test";
import assert from "node:assert/strict";

import { makeContext, OUTCOME } from "./context.mjs";
import { _resetRegistry, getBlock } from "./registry.mjs";
import { registerCoreBlocks } from "./blocks/core.mjs";
import { registerDefensiveBlocks } from "./blocks/defensive.mjs";
import { castFrame } from "./frame.mjs";
import { _resetBus, subscriptionCount, subscribe, publish, ENTRY, MAX_DEPTH } from "./bus.mjs";
import { applyDamageWithInterception, makeInterceptContext } from "./intercept.mjs";

const WITCHER = { name: "Geralt" };

function adapter(over = {}) {
    const log = [];
    return {
        log,
        sta: over.sta ?? 30, hp: over.hp ?? 50,
        currentStamina() { return this.sta; },
        currentHealth()  { return this.hp; },
        vigorThreshold() { return over.vigor ?? 7; },
        chaosSpentThisRound() { return 0; },
        skillValue() { return 6; },
        casterElement() { return "earth"; },
        async distanceBetween() { return 0; },
        async hasActiveInstance() { return !!over.activeInstance; },
        async promptStamina(_a, c) { return over.staminaPrompt ?? c.max ?? 1; },
        async applyFocusDiscount(_a, c) { return c; },        // witchers never get one
        async spendStamina(_a, n) { this.sta -= n; log.push(["spendStamina", n]); },
        async spendHealth(_a, n) { this.hp -= n; },
        async commitChaos() {},
        async pickTargets() { return []; },
        async rollCast() { return over.roll ?? { total: 16, natural: 6, fumbleBy: 0 }; },
        async requestDefence() { return { total: 10 }; },
        async rollPercentile() { return true; },
        async rollFormula(f) { return typeof f === "number" ? f : 10; },
        async applyFumble() {},
        async createShield(_a, o) { log.push(["createShield", o.hp]); },
        async applyDamage(t, n) { log.push(["damage", t.name, n]); },
        async applyStatus(t, s) { log.push(["status", t.name, s]); },
        async heal() {},
        onAbsorb(_o, d) { log.push(["absorb", d.absorbed, d.remaining]); },
        onNegate() { log.push(["negate"]); }
    };
}

/* ── QUEN, as authored ────────────────────────────────────────────────────
 * Six lines of frame, and two small trees. Everything the frame owns — the
 * variable 1-7 cost, self-targeting, the recast lock, the 10-round duration —
 * is declared, not assembled. */
const QUEN = {
    frame: {
        cost:      { mode: "variable", min: 1, max: 7 },
        targeting: { mode: "self" },
        defence:   { type: "none" },
        element:   "earth",
        duration:  { kind: "rounds", value: 10, alsoEndsOn: "poolEmpty" },
        recastLock: true
    },
    on: {
        /* Defence is "none", so the frame dispatches SUCCESS, not HIT. */
        success: [
            { b: "core:createShield", a: { pool: "5*{sta}", absorbs: "blockable" } }
        ],
        /* The second entry point. This is the whole test. */
        takeDamage: [
            { b: "core:ifIncomingDefenceAllows", a: { defence: "block" }, body: [
                { b: "core:ifDamageChannelNotIn", a: { channels: ["poison", "disease", "suffocation"] }, body: [
                    { b: "core:absorbDamage", a: { order: "beforeArmour", parity: "lethalAndNonLethal" } }
                ]}
            ]}
        ]
    }
};

function castQuen(over = {}) {
    const ad = adapter(over);
    const ctx = makeContext({
        actor: WITCHER, item: { name: "Quen" }, frame: QUEN.frame, adapter: ad, trees: QUEN.on
    });
    return castFrame(ctx, QUEN.on).then(c => ({ ctx: c, ad }));
}

test.before(() => {
    _resetRegistry();
    registerCoreBlocks();
    registerDefensiveBlocks();
});
test.beforeEach(() => _resetBus());

test("both block sets register without collision", () => {
    // The defensive set must not shadow a core id — an addon that could would
    // silently change every spell using the original.
    for (const id of ["core:dealDamage", "core:createShield",
                      "core:absorbDamage", "core:ifIncomingDefenceAllows",
                      "core:negateMagic", "core:consumeCharge"]) {
        assert.ok(getBlock(id), `${id} is registered`);
    }
});

/* ── Casting it ──────────────────────────────────────────────────────────── */

test("QUEN — casting yields SUCCESS and a pool scaled off the stamina spent", async () => {
    const { ctx, ad } = await castQuen({ staminaPrompt: 5 });
    assert.equal(ctx.control.outcome, OUTCOME.SUCCESS, "defence 'none' never produces HIT");
    assert.ok(ad.log.some(([k, hp]) => k === "createShield" && hp === 25), "5 STA -> 5x5 = 25 HP");
});

test("QUEN — casting registers a SECOND entry point on the same item", async () => {
    await castQuen({ staminaPrompt: 3 });
    assert.equal(subscriptionCount(), 1, "the cast tree created an interception subscription");
});

test("QUEN — the recast lock refuses a second shield", async () => {
    const { ctx } = await castQuen({ activeInstance: true });
    assert.equal(ctx.control.aborted, true);
    assert.match(ctx.control.abortReason, /already active/);
});

/* ── Intercepting ────────────────────────────────────────────────────────── */

/** An incoming attack, described the way the frame's sealed record describes it. */
const from = (defenceSet, channel = "attack") => ({
    record: { defenceSet, damageChannel: channel, casterRoll: 18, staSpent: 5 }
});

test("QUEN — absorbs a blockable spell ahead of armour", async () => {
    const { ad } = await castQuen({ staminaPrompt: 4 });   // 20 HP pool
    const out = await applyDamageWithInterception(WITCHER, 12, from(["blockOrDodge"]), ad);

    assert.equal(out.absorbed, 12);
    assert.equal(out.amount, 0, "nothing reached the actor");
    assert.ok(!ad.log.some(([k]) => k === "damage"), "applyDamage was never called");
    assert.ok(ad.log.some(([k, a, rem]) => k === "absorb" && a === 12 && rem === 8));
});

test("QUEN — overflow continues to armour once the pool is exhausted", async () => {
    const { ad } = await castQuen({ staminaPrompt: 2 });   // 10 HP pool
    const out = await applyDamageWithInterception(WITCHER, 18, from(["block"]), ad);

    assert.equal(out.absorbed, 10);
    assert.equal(out.amount, 8, "the remainder must still penetrate armour");
    assert.ok(ad.log.some(([k, , n]) => k === "damage" && n === 8));
    assert.equal(out.shieldBroke, true);
});

test("QUEN — an emptied pool tears its own subscription down", async () => {
    const { ad } = await castQuen({ staminaPrompt: 1 });   // 5 HP pool
    assert.equal(subscriptionCount(), 1);
    await applyDamageWithInterception(WITCHER, 9, from(["block"]), ad);
    assert.equal(subscriptionCount(), 0, "duration 'alsoEndsOn: poolEmpty' is real, not decorative");
});

test("QUEN — is INERT against magic that cannot be blocked", async () => {
    // This is the predicate that matters: 52 of 103 core entries declare
    // `Defense: None`, and Quen does nothing at all against any of them.
    const { ad } = await castQuen({ staminaPrompt: 5 });
    const out = await applyDamageWithInterception(WITCHER, 12, from([]), ad);

    assert.equal(out.absorbed, 0);
    assert.equal(out.amount, 12, "all of it reached the actor");
    assert.ok(ad.log.some(([k, , n]) => k === "damage" && n === 12));
});

test("QUEN — is inert against Resist Magic spells too", async () => {
    const { ad } = await castQuen({ staminaPrompt: 5 });
    const out = await applyDamageWithInterception(WITCHER, 9, from(["resistMagic"]), ad);
    assert.equal(out.absorbed, 0, "Suffocate and Puppet go straight through");
});

test("QUEN — is inert against poison, disease and suffocation", async () => {
    for (const channel of ["poison", "disease", "suffocation"]) {
        _resetBus();
        const { ad } = await castQuen({ staminaPrompt: 5 });
        const out = await applyDamageWithInterception(WITCHER, 6, from(["block"], channel), ad);
        assert.equal(out.absorbed, 0, `${channel} bypasses the shield`);
        assert.equal(out.amount, 6);
    }
});

test("QUEN — lethal and non-lethal deplete the pool equally", async () => {
    const { ad } = await castQuen({ staminaPrompt: 3 });   // 15 HP
    await applyDamageWithInterception(WITCHER, 5, { ...from(["block"]), nonLethal: true }, ad);
    const out = await applyDamageWithInterception(WITCHER, 5, from(["block"]), ad);
    assert.equal(out.absorbed, 5);
    assert.ok(ad.log.filter(([k]) => k === "absorb").at(-1)[2] === 5, "15 - 5 - 5 = 5 remaining");
});

/* ── The reaction stack ──────────────────────────────────────────────────── */

test("the interception stack is depth-capped", async () => {
    // Mirror Effect turns a successful parry into a fresh attack that can meet
    // a second mirror; Dispel's own defence is spellCasting, so a dispel can
    // be dispelled. Both are reachable from the printed rules.
    let entered = 0;
    const ad = adapter();

    const recurse = {
        owner: WITCHER, entry: ENTRY.INCOMING_MAGIC, tree: [], state: {},
    };
    subscribe(recurse);

    const runTree = async () => {
        entered++;
        await publish(ENTRY.INCOMING_MAGIC, {
            owner: WITCHER, payload: { record: {} }, runTree
        });
    };
    const payload = { record: {} };
    await publish(ENTRY.INCOMING_MAGIC, { owner: WITCHER, payload, runTree });

    assert.ok(entered <= MAX_DEPTH + 1, `stopped at ${entered}, cap is ${MAX_DEPTH}`);
    assert.ok(entered > 1, "it did recurse before stopping");
});

/* ── The shape it proves ─────────────────────────────────────────────────── */

test("an interception context carries `incoming` and `state`, not targets-from-a-cast", async () => {
    const sub = subscribe({ owner: WITCHER, entry: ENTRY.TAKE_DAMAGE, tree: [], state: { pool: 20 } });
    const ctx = makeInterceptContext(sub, { amount: 7, record: { defenceSet: [] } }, adapter());

    assert.equal(ctx.state.pool, 20, "the effect's own data");
    assert.equal(ctx.incoming.amount, 7, "the payload passing through");
    assert.equal(ctx.targets[0].actor, WITCHER, "shared blocks still see a target list");
    assert.equal(typeof ctx.expire, "function", "and it can end itself");
});
