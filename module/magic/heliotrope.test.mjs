// module/magic/heliotrope.test.mjs
//
// EXECUTING test for CONTRIBUTED defences — options the DEFENDER owns.
//
// Quen proved a defender can intercept damage. Heliotrope proves something
// harder: that a defender can contribute an option into the defence gate for
// magic that declares no defence at all.
//
// This is the case that breaks a conventional design, because:
//
//   1. It fires against `Defense: None` — 52 of 103 core entries — which the
//      rules define as "cannot be defended against UNLESS the Dispel spell or
//      Heliotrope sign is used". A gate built only from the attacker's clause
//      can never offer it.
//   2. Its cost is HALF THE ATTACKER'S SPEND, so the caster's expenditure has
//      to survive into the defence step. A pipeline that consumes and discards
//      it before targeting cannot price this.
//   3. It lives on book page 70, in the SKILLS chapter — not a spell, not in
//      the Magic chapter, and not in any spell's defence clause.

import test from "node:test";
import assert from "node:assert/strict";

import { makeContext, OUTCOME } from "./context.mjs";
import { _resetRegistry } from "./registry.mjs";
import { registerCoreBlocks } from "./blocks/core.mjs";
import { registerDefensiveBlocks } from "./blocks/defensive.mjs";
import { castFrame, attackerWins, gatherDefenceOptions } from "./frame.mjs";
import { _resetBus } from "./bus.mjs";
import {
    registerCoreContributors, _resetContributors, contributorsFor, contributorCount
} from "./contributors.mjs";

const MAGE    = { name: "Yennefer" };
/* Heliotrope is a SIGN the witcher KNOWS, not a skill they have ranks in —
 * the system has no `heliotrope` skill key, so the old rank test could only
 * ever read 0 and the contributor could never be offered. */
const GERALT  = { name: "Geralt",  _witcher: true, _knows: ["Heliotrope"],
                  _skills: { spellcast: 6 } };
const PEASANT = { name: "Peasant", _witcher: false, _skills: {} };
const TRISS   = { name: "Triss",   _witcher: false, _knows: ["Dispel"], _skills: { spellcast: 8 } };

function adapter(over = {}) {
    const log = [];
    return {
        log,
        _sta: new Map(),
        currentStamina(a) { return this._sta.get(a) ?? over.defenderSta ?? 30; },
        currentHealth() { return 50; },
        vigorThreshold() { return 10; },
        chaosSpentThisRound() { return 0; },
        skillValue(a, k) { return a?._skills?.[k] ?? 6; },
        isWitcher(a) { return !!a?._witcher; },
        knowsSpell(a, s) { return (a?._knows ?? []).includes(s); },
        casterElement() { return "fire"; },

        async distanceBetween() { return 0; },
        async hasActiveInstance() { return false; },
        async promptStamina(_a, c) { return c.max ?? 1; },
        async applyFocusDiscount(_a, c) { return c; },
        async spendStamina(a, n) {
            this._sta.set(a, this.currentStamina(a) - n);
            log.push(["spendStamina", a.name, n]);
        },
        async spendHealth() {}, async commitChaos() {},
        async pickTargets() { return []; },
        async rollCast() { return over.roll ?? { total: 16, natural: 7, fumbleBy: 0 }; },
        async rollDefenceSkill(a, skill) { log.push(["defenceRoll", a.name, skill]); return over.defenceRoll ?? 14; },
        async requestDefence(a, opts) {
            log.push(["offered", a.name, opts.options.join("|")]);
            return over.choose ? over.choose(opts) : { option: null, total: over.plainDefence ?? 10 };
        },
        async rollPercentile() { return true; },
        async rollFormula(f) { return typeof f === "number" ? f : 10; },
        async applyFumble() {},
        async applyDamage(t, n) { log.push(["damage", t.name, n]); },
        async applyStatus(t, s) { log.push(["status", t.name, s]); },
        async heal() {}, async createShield() {},
        onNegate(o) { log.push(["negate", o.name]); }
    };
}

/* An undefendable spell: Brand of Fire is `Defense: None` at 8m for 4 STA. */
const BRAND_OF_FIRE = {
    frame: {
        kind: "spell",
        cost:      { mode: "fixed", amount: 4 },
        targeting: { mode: "direct", count: 1 },
        range:     8,
        defence:   { type: "none" },
        element:   "fire"
    },
    on: { hit:     [{ b: "core:dealDamage", a: { formula: "1d6", damageType: "fire" } }],
          success: [{ b: "core:dealDamage", a: { formula: "1d6", damageType: "fire" } }] }
};

function cast(target, over = {}, spell = BRAND_OF_FIRE) {
    const ad = adapter(over);
    const ctx = makeContext({
        actor: MAGE, item: { name: "Brand of Fire" }, frame: spell.frame,
        adapter: ad, targets: [target], trees: spell.on
    });
    return castFrame(ctx, spell.on).then(c => ({ ctx: c, ad }));
}

test.before(() => {
    _resetRegistry(); registerCoreBlocks(); registerDefensiveBlocks();
});
test.beforeEach(() => { _resetBus(); _resetContributors(); registerCoreContributors(); });

test("the two RAW contributors register", () => {
    assert.equal(contributorCount(), 2);
});

/* ── Tie direction ───────────────────────────────────────────────────────── */

test("ties: who wins one is not the same question as who rolled higher", () => {
    // Ordinary attacks and Heliotrope: the attacker must roll STRICTLY higher
    // (errata p.164, "not equal to or higher"), so a tie is a miss.
    assert.equal(attackerWins(15, 15, "defender"), false, "a tie defends");
    assert.equal(attackerWins(16, 15, "defender"), true);
    // Dispel: the dispeller must "beat" the casting roll, so a tie leaves the
    // original cast standing — the exception, not the rule.
    assert.equal(attackerWins(15, 15, "attacker"), true, "a tie fails to dispel");
});

/* ── Eligibility ─────────────────────────────────────────────────────────── */

test("Heliotrope is offered to a witcher", () => {
    const ad = adapter();
    const found = contributorsFor(GERALT, { kind: "spell", staSpent: 6 }, ad);
    assert.deepEqual(found.map(c => c.id), ["heliotrope"]);
});

test("Heliotrope is NOT offered to a non-witcher", () => {
    const ad = adapter();
    assert.deepEqual(contributorsFor(PEASANT, { kind: "spell", staSpent: 6 }, ad).map(c => c.id), []);
});

test("Dispel is offered to someone who knows it, and stacks with nothing else", () => {
    const ad = adapter();
    const found = contributorsFor(TRISS, { kind: "spell", staSpent: 6 }, ad);
    assert.deepEqual(found.map(c => c.id), ["dispel"]);
});

test("a witcher who cannot pay half the caster's spend is not offered it", () => {
    const ad = adapter({ defenderSta: 2 });
    // 10 STA cast -> costs 5 to resist; Geralt has 2.
    assert.deepEqual(contributorsFor(GERALT, { kind: "spell", staSpent: 10 }, ad).map(c => c.id), []);
});

test("Heliotrope's scope is spell, invocation and hex — as printed", () => {
    const ad = adapter();
    for (const kind of ["spell", "invocation", "hex"]) {
        assert.equal(contributorsFor(GERALT, { kind, staSpent: 4 }, ad).length, 1, kind);
    }
    for (const kind of ["sign", "ritual"]) {
        assert.equal(contributorsFor(GERALT, { kind, staSpent: 4 }, ad).length, 0,
            `${kind} is not in the printed list`);
    }
});

/* ── The gate ────────────────────────────────────────────────────────────── */

test("HELIOTROPE — is offered against magic that declares NO defence", async () => {
    // The whole point. A gate built only from the attacker's clause would
    // offer nothing here, and 52 of 103 core entries look exactly like this.
    let offered = null;
    await cast(GERALT, { choose: (o) => { offered = o; return { option: null, total: 10 }; } });
    assert.deepEqual(offered.options, ["heliotrope"], "declared nothing, contributed one");
    assert.deepEqual(offered.declared, []);
});

test("HELIOTROPE — a non-witcher gets no prompt at all, and is simply hit", async () => {
    const { ctx, ad } = await cast(PEASANT);
    assert.equal(ctx.control.outcome, OUTCOME.SUCCESS);
    assert.equal(ctx.targets[0].hit, true);
    assert.ok(!ad.log.some(([k]) => k === "offered"), "nothing to offer");
    assert.ok(ad.log.some(([k, n]) => k === "damage" && n === "Peasant"));
});

test("HELIOTROPE — the offered cost is half the ATTACKER's spend", async () => {
    let offered = null;
    await cast(GERALT, {
        choose: (o) => { offered = o; return { option: null, total: 10 }; }
    }, { ...BRAND_OF_FIRE, frame: { ...BRAND_OF_FIRE.frame, cost: { mode: "fixed", amount: 7 } } });

    assert.equal(offered.contributed[0].cost, 3, "floor(7/2)");
});

/* ── Using it ────────────────────────────────────────────────────────────── */

test("HELIOTROPE — negates the spell when it equals or beats the caster's roll", async () => {
    const { ctx, ad } = await cast(GERALT, {
        roll: { total: 14, natural: 6, fumbleBy: 0 },
        choose: () => ({ option: "heliotrope" }),
        defenceRoll: 14                                   // EQUALS — and that is enough
    });

    assert.equal(ctx.targets[0].hit, false, "'equals or beats' means a tie defends");
    assert.equal(ctx.targets[0].negated, true);
    assert.equal(ctx.control.outcome, OUTCOME.MISS);
    assert.ok(ad.log.some(([k, n]) => k === "negate" && n === "Geralt"));
    assert.ok(!ad.log.some(([k]) => k === "damage"), "the brand never lands");
});

test("HELIOTROPE — charges the witcher half the caster's spend when used", async () => {
    const { ad } = await cast(GERALT, {
        choose: () => ({ option: "heliotrope" }), defenceRoll: 20
    });
    // Brand of Fire costs 4 -> the witcher pays 2.
    assert.ok(ad.log.some(([k, who, n]) => k === "spendStamina" && who === "Geralt" && n === 2));
    assert.ok(ad.log.some(([k, who, n]) => k === "spendStamina" && who === "Yennefer" && n === 4));
});

test("HELIOTROPE — failing to beat the roll leaves the spell landing", async () => {
    const { ctx, ad } = await cast(GERALT, {
        roll: { total: 19, natural: 8, fumbleBy: 0 },
        choose: () => ({ option: "heliotrope" }),
        defenceRoll: 11
    });
    assert.equal(ctx.targets[0].hit, true);
    assert.equal(ctx.control.outcome, OUTCOME.HIT);
    assert.ok(ad.log.some(([k]) => k === "damage"), "the brand lands anyway");
    assert.ok(ad.log.some(([k, who, n]) => k === "spendStamina" && who === "Geralt" && n === 2),
        "and the stamina is spent regardless");
});

test("DISPEL — a tie FAILS, unlike Heliotrope", async () => {
    const { ctx } = await cast(TRISS, {
        roll: { total: 15, natural: 6, fumbleBy: 0 },
        choose: () => ({ option: "dispel" }),
        defenceRoll: 15                                   // exactly equal
    });
    assert.equal(ctx.targets[0].hit, true, "the dispeller must BEAT the casting roll");
    assert.equal(ctx.targets[0].negated, undefined);
});

/* ── Interaction with declared defences ──────────────────────────────────── */

const AENYE = {
    frame: {
        kind: "spell",
        cost: { mode: "fixed", amount: 5 },
        targeting: { mode: "direct", count: 1 }, range: 12,
        defence: { type: "blockOrDodge", ties: "defender" }, element: "fire"
    },
    on: { hit: [{ b: "core:dealDamage", a: { formula: "4d6", damageType: "fire" } }] }
};

test("a declared defence and a contributed one are offered together", async () => {
    let offered = null;
    await cast(GERALT, { choose: (o) => { offered = o; return { option: null, total: 9 }; } }, AENYE);
    assert.deepEqual(offered.options, ["blockOrDodge", "heliotrope"]);
});

test("choosing the ordinary defence uses the SPELL's tie direction", async () => {
    const { ctx } = await cast(GERALT, {
        roll: { total: 12, natural: 5, fumbleBy: 0 },
        choose: () => ({ option: null, total: 12 })       // tie
    }, AENYE);
    assert.equal(ctx.targets[0].hit, false, "ties defend on an ordinary attack too");
});

test("gatherDefenceOptions separates the two sources", () => {
    const ad = adapter();
    const ctx = makeContext({ actor: MAGE, item: {}, frame: AENYE.frame, adapter: ad });
    ctx.record.kind = "spell"; ctx.record.staSpent = 5;
    const { declared, contributed, all } = gatherDefenceOptions(ctx, GERALT);
    assert.deepEqual(declared, ["blockOrDodge"]);
    assert.deepEqual(contributed.map(c => c.id), ["heliotrope"]);
    assert.deepEqual(all, ["blockOrDodge", "heliotrope"]);
});
