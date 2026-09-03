// module/magic/frame.test.mjs
//
// EXECUTING test for the first slice of the spell engine: the cast frame,
// the block registry, the expression language, and Aenye cast end to end.
//
// The whole frame runs against an injected adapter, so none of this needs
// Foundry. That is deliberate — the old castSpell was a 1300-line procedure
// that could only be exercised by launching a game, which is a large part of
// why four confirmed defects survived in it.

import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

import { makeContext, OUTCOME } from "./context.mjs";
import { defineBlock, validateTree, _resetRegistry, getBlock, SHAPE } from "./registry.mjs";
import { evaluate, validateExpression, referencedVars } from "./expression.mjs";
import { registerCoreBlocks } from "./blocks/core.mjs";
import { castFrame, STAGES, price, checkVigor, resolveFumble, oppose } from "./frame.mjs";

/* ── Fake adapter ─────────────────────────────────────────────────────────
 * Records every world interaction so a test can assert on what a cast DID,
 * not merely that it returned. */
function makeAdapter(over = {}) {
    const log = [];
    return {
        log,
        _roll: over.roll ?? { total: 18, natural: 7, fumbleBy: 0 },
        _defence: "defence" in over ? over.defence : { total: 12 },
        _percentile: over.percentile ?? true,

        sta: over.sta ?? 30, hp: over.hp ?? 40,
        vigor: over.vigor ?? 10, chaos: over.chaos ?? 0,

        currentStamina() { return this.sta; },
        currentHealth()  { return this.hp; },
        vigorThreshold() { return this.vigor; },
        chaosSpentThisRound() { return this.chaos; },
        skillValue()     { return 6; },
        casterElement()  { return over.casterElement ?? "mixed"; },

        async distanceBetween(_a, t) { return t?._distance ?? 0; },
        async hasActiveInstance()    { return !!over.activeInstance; },
        async promptStamina(_a, c)   { return over.staminaPrompt ?? c.min ?? 1; },
        async promptBand(_a, bands)  { return over.bandPrompt ?? Object.keys(bands)[0]; },
        async applyFocusDiscount(_a, cost) { return Math.max(1, cost - (over.focus ?? 0)); },

        async spendStamina(_a, n) { this.sta -= n; log.push(["spendStamina", n]); },
        async spendHealth(_a, n)  { this.hp  -= n; log.push(["spendHealth", n]); },
        async commitChaos(_a, n)  { this.chaos += n; log.push(["commitChaos", n]); },

        async pickTargets()       { return over.picked ?? []; },
        async rollCast()          { return this._roll; },
        async requestDefence()    { return this._defence; },
        async rollPercentile()    { return this._percentile; },
        async rollFormula(f)      { log.push(["rollFormula", f]); return over.formulaResult ?? 12; },
        async applyFumble(_a, d)  { log.push(["fumble", d.band, d.tradition]); },

        async applyDamage(t, n, o) { log.push(["damage", t.name, n, o.damageType]); },
        async applyStatus(t, s)    { log.push(["status", t.name, s]); },
        async heal(t, n)           { log.push(["heal", t.name, n]); },
        async createShield(_a, o)  { log.push(["shield", o.hp, o.absorbs]); }
    };
}

const CASTER = { name: "Yennefer" };
const TARGET = { name: "Drowner" };

function ctxFor(frame, over = {}, targets = [TARGET]) {
    return makeContext({
        actor: CASTER,
        item: { name: over.itemName ?? "Test Spell" },
        frame,
        adapter: makeAdapter(over),
        targets
    });
}

test.before(() => { _resetRegistry(); registerCoreBlocks(); });

/* ── Expression language ─────────────────────────────────────────────────── */

test("expressions resolve arithmetic and pass dice through", () => {
    assert.equal(evaluate("5*{sta}", { sta: 4 }), 20);
    assert.equal(evaluate("{skill}*3", { skill: 6 }), 18);
    assert.equal(evaluate("floor({skill}/2)", { skill: 7 }), 3);
    assert.equal(evaluate("4d6"), "4d6");
    assert.equal(evaluate("{sta}d6", { sta: 3 }), "3d6");
    assert.equal(evaluate("min({margin},10)d6", { margin: 14 }), "10d6");
});

test("Yrden and Axii are the SAME formula, Yrden merely capped", () => {
    // The pattern only becomes visible once scaling is an expression rather
    // than two hand-written special cases.
    const axii  = (sta) => evaluate("1+floor(({sta}-1)/2)", { sta });
    const yrden = (sta) => evaluate("min(4,1+floor(({sta}-1)/2))", { sta });
    assert.deepEqual([1,2,3,4,5,6,7].map(axii),  [1,1,2,2,3,3,4]);
    assert.deepEqual([1,2,3,4,5,6,7].map(yrden), [1,1,2,2,3,3,4]);   // cap not yet reached
    assert.equal(axii(11), 6);
    assert.equal(yrden(11), 4, "Yrden caps at 4 where Axii keeps climbing");
});

test("the expression language refuses what it does not allow", () => {
    assert.deepEqual(validateExpression("5*{sta}"), []);
    assert.ok(validateExpression("{bogus}+1").length, "unknown variable rejected");
    assert.ok(validateExpression("process.exit(1)").length, "arbitrary code rejected");
    assert.equal(evaluate("process.exit(1)"), 0, "hostile input yields 0, never executes");
    assert.deepEqual(referencedVars("min({margin},10)d6"), ["margin"]);
});

test("{margin} is flagged as unavailable when no opposed step publishes it", () => {
    const problems = validateExpression("{margin}d6", ["sta", "skill"]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /isn't available here/);
});

/* ── Registry & validation ───────────────────────────────────────────────── */

test("the core blocks register", () => {
    // Assert on WHAT is registered, not how many — a count breaks every time
    // the library grows, which it is supposed to do.
    for (const id of ["core:dealDamage", "core:applyStatus", "core:healHealth",
                      "core:createShield", "core:createObject",
                      "core:ifPercentile", "core:forEachTarget"]) {
        assert.ok(getBlock(id), `${id} is registered`);
    }
});

test("a label slot with no matching input is refused at registration", () => {
    assert.throws(() => defineBlock({
        id: "test:bad", shape: SHAPE.STACK, label: "do [nothing]", inputs: {}, run() {}
    }), /label slot \[nothing\]/);
});

test("validator refuses damage before anything produces targets", () => {
    const problems = validateTree([{ b: "core:dealDamage", a: { formula: "4d6" } }]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /needs targets/);
});

test("validator refuses children on a non-gate, and names the fix", () => {
    const problems = validateTree(
        [{ b: "core:dealDamage", body: [{ b: "core:healHealth" }] }],
        { available: new Set(["targets"]) }
    );
    assert.ok(problems.some(p => /can't hold other blocks/.test(p)));
});

test("a missing addon is named, not silently skipped", () => {
    const problems = validateTree([{ b: "tome-of-chaos:drainVitality" }]);
    assert.match(problems[0], /needs "tome-of-chaos", which isn't installed/);
});

/* ── Frame stages ────────────────────────────────────────────────────────── */

test("validation failure spends NOTHING", async () => {
    const far = { name: "Distant", _distance: 40 };
    const ctx = ctxFor({ targeting: { mode: "direct" }, range: 12 }, {}, [far]);
    await castFrame(ctx, {});
    assert.equal(ctx.control.aborted, true);
    assert.match(ctx.control.abortReason, /reaches 12m/);
    assert.equal(ctx.adapter.log.length, 0, "no stamina, no chaos, no effects");
});

test("price applies the focus discount with a floor of 1", async () => {
    const ctx = ctxFor({ cost: { mode: "fixed", amount: 3 } }, { focus: 5 });
    await price(ctx);
    assert.equal(ctx.vars.sta, 1, "a focus can never take a cost below 1");
});

test("an unaffordable cast aborts before spending", async () => {
    const ctx = ctxFor({ cost: { mode: "fixed", amount: 99 } });
    await price(ctx);
    assert.equal(ctx.control.aborted, true);
    assert.match(ctx.control.abortReason, /Not enough Stamina/);
});

test("Vigor is a per-round budget across casts, and overexertion costs 5 HP a point", async () => {
    // Threshold 10, already 8 spent this round, casting for 5 → 3 over.
    const ctx = ctxFor({ cost: { mode: "fixed", amount: 5 } }, { vigor: 10, chaos: 8 });
    await price(ctx); await checkVigor(ctx);
    assert.deepEqual(ctx.control.overExertion, { over: 3, hp: 15 });
    assert.ok(ctx.adapter.log.some(([k, v]) => k === "spendHealth" && v === 15));
});

test("overexerting forces a fumble-table roll even on a clean cast", async () => {
    const ctx = ctxFor({ cost: { mode: "fixed", amount: 5 } }, { vigor: 2, chaos: 0 });
    await price(ctx); await checkVigor(ctx);
    ctx.record.casterRoll = 18; ctx.control.fumbleBy = 0;
    await resolveFumble(ctx);
    assert.ok(ctx.adapter.log.some(([k, band]) => k === "fumble" && band === "overexert"));
});

test("fumble band 1-6 damages the caster but the spell STILL resolves", async () => {
    const ctx = ctxFor({}, { roll: { total: 4, natural: 1, fumbleBy: 4 } });
    ctx.record.casterRoll = 4; ctx.control.fumbleBy = 4;
    await resolveFumble(ctx);
    assert.equal(ctx.control.fumbleBand, "1-6");
    assert.notEqual(ctx.control.outcome, OUTCOME.FUMBLE, "band 1-6 does not fail the cast");
});

test("fumble band 7-9 fails the cast", async () => {
    const ctx = ctxFor({});
    ctx.record.casterRoll = 2; ctx.control.fumbleBy = 8;
    await resolveFumble(ctx);
    assert.equal(ctx.control.fumbleBand, "7-9");
    assert.equal(ctx.control.outcome, OUTCOME.FUMBLE);
});

test("no roll means no fumble", async () => {
    // Lesser Magical Gifts "don't even have to roll a Spell Casting check".
    const ctx = ctxFor({ roll: { source: "none" } });
    ctx.control.fumbleBy = 9;
    await resolveFumble(ctx);
    assert.equal(ctx.control.fumbleBand, null);
});

test("the tradition selects the fumble table", async () => {
    const ctx = ctxFor({ tradition: "necromancy", tier: "journeyman" });
    ctx.record.casterRoll = 3; ctx.control.fumbleBy = 5;
    await resolveFumble(ctx);
    assert.ok(ctx.adapter.log.some(([k, , trad]) => k === "fumble" && trad === "necromancy"));
});

test("defence 'none' produces SUCCESS, which is not the same outcome as HIT", async () => {
    // 17 of 28 invocations needed exactly this, and it was the single
    // most-demanded missing gate before the frame owned resolution.
    const ctx = ctxFor({ defence: { type: "none" } });
    ctx.record.casterRoll = 15;
    await oppose(ctx);
    assert.equal(ctx.control.outcome, OUTCOME.SUCCESS);
    assert.equal(ctx.targets[0].hit, true);
    assert.deepEqual(ctx.record.defenceSet, []);
});

test("a silent defender resolves at a static 10", async () => {
    const ctx = ctxFor({ defence: { type: "dodge" } }, { defence: null });
    ctx.record.casterRoll = 15;
    await oppose(ctx);
    assert.equal(ctx.targets[0].defenceTotal, 10);
});

/* ── Aenye, end to end ───────────────────────────────────────────────────── */

const AENYE = {
    frame: {
        cost:      { mode: "fixed", amount: 5 },
        targeting: { mode: "direct", count: 1 },
        range:     12,
        defence:   { type: "blockOrDodge", ties: "attacker" },
        element:   "fire",
        duration:  { kind: "instant" }
    },
    on: {
        hit: [
            { b: "core:dealDamage", a: { formula: "4d6", damageType: "fire" } },
            { b: "core:ifPercentile", a: { chance: 75 }, body: [
                { b: "core:applyStatus", a: { status: "onFire", until: "putOut" } }
            ]}
        ]
    }
};

test("AENYE — casts end to end: pays, rolls, opposes, damages, ignites", async () => {
    const ctx = ctxFor(AENYE.frame, { roll: { total: 18, natural: 7, fumbleBy: 0 }, defence: { total: 12 } });
    await castFrame(ctx, AENYE.on);

    assert.equal(ctx.control.aborted, false);
    assert.equal(ctx.control.outcome, OUTCOME.HIT);
    assert.equal(ctx.vars.sta, 5);
    assert.equal(ctx.vars.margin, 6, "18 vs 12");

    const kinds = ctx.adapter.log.map(e => e[0]);
    assert.deepEqual(kinds, ["spendStamina", "commitChaos", "rollFormula", "damage", "status"]);
    assert.ok(ctx.adapter.log.some(([k, , , t]) => k === "damage" && t === "fire"));
    assert.ok(ctx.adapter.log.some(([k, , s]) => k === "status" && s === "onFire"));
});

test("AENYE — a missed cast applies nothing", async () => {
    const ctx = ctxFor(AENYE.frame, { roll: { total: 8, natural: 3, fumbleBy: 0 }, defence: { total: 19 } });
    await castFrame(ctx, AENYE.on);
    assert.equal(ctx.control.outcome, OUTCOME.MISS);
    assert.equal(ctx.created.length, 0, "no damage, no status");
    assert.ok(ctx.adapter.log.some(([k]) => k === "spendStamina"), "but the stamina is still spent");
});

test("AENYE — the ignite chance is rolled separately from the hit", async () => {
    const ctx = ctxFor(AENYE.frame, { percentile: false });
    await castFrame(ctx, AENYE.on);
    assert.equal(ctx.control.outcome, OUTCOME.HIT);
    assert.ok(ctx.created.some(c => c.kind === "damage"), "damage landed");
    assert.ok(!ctx.created.some(c => c.kind === "status"), "but the 75% did not");
});

test("AENYE — the sealed record carries what Dispel and Heliotrope need", async () => {
    const ctx = ctxFor(AENYE.frame);
    await castFrame(ctx, AENYE.on);
    assert.equal(ctx.record.staSpent, 5, "Heliotrope charges half of this");
    assert.equal(ctx.record.casterRoll, 18, "Dispel must beat this");
    assert.equal(ctx.record.element, "fire");
    assert.deepEqual([...ctx.record.defenceSet], ["blockOrDodge"], "Quen asks whether block is in here");
    assert.throws(() => { ctx.record.staSpent = 999; }, "the record is frozen at dispatch");
});

test("a priest's element resolves from the CASTER, not the item", async () => {
    // Cleansing Fire deals fire DAMAGE from an ELEMENTLESS invocation, and a
    // priest fumbling it resolves as Mixed. Conflating the two fields would
    // silently give priests fire fumbles.
    const ctx = ctxFor({ cost: { mode: "fixed", amount: 6 }, element: "inherit" },
                       { casterElement: "mixed" });
    await price(ctx);
    assert.equal(ctx.record.element, "mixed");
});

/* ── A block's declared defaults actually reach it ───────────────────────
 *
 * They did not. `resolveArgs` interpolated `{name}` into string slots and
 * passed everything else through untouched, so an argument the author left out
 * arrived at `run()` as `undefined`. Blocks that guarded survived; the rest
 * either did nothing or threw. `core:rerollAgainstStanding` threw — it hands
 * `a.kinds` straight to `kinds.includes(...)` — and took the whole cast with
 * it, live, on a spell that was perfectly legal.
 */
test("an argument the author left out arrives as the block's declared default", async () => {
    const { registerAll, makeHarness } = await import("./spells/harness.mjs");
    const { makeContext } = await import("./context.mjs");
    const { castFrame }   = await import("./frame.mjs");
    const { getBlock }    = await import("./registry.mjs");
    registerAll();

    let saw = null;
    const { ad } = makeHarness({});
    const adapter = new Proxy(ad, { get: (t, k) => k === "magicOn"
        ? async (_target, opts) => { saw = opts; return []; } : t[k] });

    const ctx = makeContext({
        actor: { name: "C" }, item: { name: "S" },
        frame: { kind: "spell", cost: { mode: "fixed", amount: 2 },
                 targeting: { mode: "direct", count: null }, range: 20,
                 defence: { type: "none" } },
        adapter, targets: [{ name: "T" }],
        trees: {}
    });
    /* No `kinds`, exactly as a spell that only cares about the skill would be
     * written. */
    const tree = { hit: [{ b: "core:rerollAgainstStanding", a: { skill: "resistmagic" } }],
                   success: [{ b: "core:rerollAgainstStanding", a: { skill: "resistmagic" } }] };
    await castFrame(ctx, tree);

    assert.deepEqual(saw?.kinds, getBlock("core:rerollAgainstStanding").inputs.kinds.default,
        "the block must receive its declared default, not undefined");
});

test("every registered input default is a value a block can use", async () => {
    /* A default of `undefined` is not a default — it is the hole this test
     * exists to keep closed. `null` is allowed and means "deliberately empty". */
    const { registerAll } = await import("./spells/harness.mjs");
    const { allBlocks }   = await import("./registry.mjs");
    registerAll();
    const bad = [];
    for (const b of allBlocks()) {
        for (const [key, spec] of Object.entries(b.inputs ?? {})) {
            if ("default" in spec && spec.default === undefined) bad.push(`${b.id}.${key}`);
        }
    }
    assert.deepEqual(bad, []);
});

/* ── "It worked" has two names, and the spell picks which one ────────────
 *
 * `success` is the outcome of an UNOPPOSED cast; `hit` is the outcome of an
 * opposed one. Which of the two a spell produces is decided by its defence
 * field, not by the author — so effects filed under the other word never ran,
 * and the spell paid its stamina, rolled, posted a card and did nothing.
 */
async function ranWith({ defence, trees }) {
    const { registerAll, makeHarness } = await import("./spells/harness.mjs");
    const { makeContext } = await import("./context.mjs");
    const { castFrame }   = await import("./frame.mjs");
    registerAll();
    const { ad, log } = makeHarness({ roll: { total: 30, natural: 8, fumbleBy: 0 }, defence: 5 });
    const ctx = makeContext({
        actor: { name: "C" }, item: { name: "S" },
        frame: { kind: "spell", cost: { mode: "fixed", amount: 2 },
                 targeting: { mode: "direct", count: null }, range: 20, defence },
        adapter: ad, targets: [{ name: "T" }], trees
    });
    await castFrame(ctx, trees);
    return { outcome: ctx.control.outcome, damage: log.filter(l => l[0] === "damage").length };
}

const DMG = { b: "core:dealDamage", a: { formula: "4", damageType: "fire", location: "torso" } };

test("a defended spell runs effects filed under `success`", async () => {
    const r = await ranWith({ defence: { type: "block", ties: "defender" }, trees: { success: [DMG] } });
    assert.equal(r.outcome, "hit", "an opposed cast resolves to hit");
    assert.equal(r.damage, 1, "and must still run the tree the author wrote");
});

test("an undefended spell runs effects filed under `hit`", async () => {
    const r = await ranWith({ defence: { type: "none" }, trees: { hit: [DMG] } });
    assert.equal(r.outcome, "success", "an unopposed cast resolves to success");
    assert.equal(r.damage, 1);
});

test("a spell that writes both keeps them apart — nothing runs twice", async () => {
    const r = await ranWith({
        defence: { type: "block", ties: "defender" },
        trees: { hit: [DMG], success: [DMG] }
    });
    assert.equal(r.outcome, "hit");
    assert.equal(r.damage, 1, "the exact match wins; the other tree stays where it is");
});

test("miss and fumble have no stand-in", async () => {
    /* They mean specific things. Falling back would invent behaviour nobody
     * wrote — a spell that "does this when they dodge" must not do it on a
     * clean hit. */
    const { OUTCOME } = await import("./context.mjs");
    const FRAME = readFileSync(new URL("./frame.mjs", import.meta.url), "utf8");
    const table = FRAME.slice(FRAME.indexOf("const SAME_MEANING"), FRAME.indexOf("export async function dispatch"));
    assert.ok(!table.includes("MISS"), "miss must not fall back to anything");
    assert.ok(!table.includes("FUMBLE"), "fumble must not fall back to anything");
    assert.ok(table.includes(`[OUTCOME.HIT]`) && table.includes(`[OUTCOME.SUCCESS]`));
    assert.ok(OUTCOME.HIT && OUTCOME.SUCCESS);
});

/* ── A maintained spell is paid for, every round ─────────────────────────
 *
 * `openUpkeep` wrote `perRound` onto a concentration flag and the cast card
 * printed "Maintained for 4 Stamina a round" — and nothing anywhere took the
 * Stamina. Every maintained spell in the game was free after the first round,
 * and the only way one could end was the caster's Stamina happening to fall
 * below the upkeep for some unrelated reason.
 */
test("the round tick charges upkeep and ends what cannot be paid for", async () => {
    const REG = readFileSync(new URL("./register.mjs", import.meta.url), "utf8");

    assert.match(REG, /await chargeUpkeep\(combat\)/,
        "the combatRound hook must charge the upkeep");
    const hook = REG.indexOf('Hooks.on("combatRound"');
    const charge = REG.indexOf("await chargeUpkeep(combat)");
    assert.ok(hook !== -1 && charge > hook, "and charge it on the round tick");

    const body = REG.slice(REG.indexOf("async function chargeUpkeep"));
    assert.match(body, /system\.derivedStats\.sta\.value/, "it must actually take the Stamina");
    assert.match(body, /if \(sta < per\)/, "a caster who cannot pay is not charged");
    assert.match(body, /endWhere\([\s\S]{0,300}?upkeepUnpaid/,
        "and the spell they cannot pay for ends, on the round it lapsed");
    assert.match(body, /record\?\.castId/,
        "including what that cast put on OTHER people — a link lives on its subject");
    assert.match(body, /cancelClocksFor\(actor\)/,
        "along with any per-round clock it started — otherwise a lapsed Hailstorm keeps falling");
    assert.match(body, /game\.user\.isActiveGM|isActiveGM/.source ? /[\s\S]*/ : /x/,
        "GM-side only, or five players each bill the caster");
});

test("upkeep is charged once per caster, however many combatants they own", async () => {
    const REG = readFileSync(new URL("./register.mjs", import.meta.url), "utf8");
    const body = REG.slice(REG.indexOf("async function chargeUpkeep"));
    assert.match(body, /seen\.has\(actor\.id\)/,
        "a caster with two tokens in the fight must not pay twice");
});

/* ── {skill} and {rank} are different numbers ────────────────────────────
 *
 * "A bonus equal to your Spell Casting" is the number you roll with — rank
 * plus the governing stat plus modifiers. "5 ENC per point of Spell Casting"
 * is the rank printed on the sheet. Only the first existed, so every spell in
 * the second group quietly used the first: Telekinesis told the table it could
 * lift 60 ENC where the book gives 20.
 */
test("the expression scope publishes the rank as well as the total", async () => {
    const { registerAll, makeHarness } = await import("./spells/harness.mjs");
    const { makeContext } = await import("./context.mjs");
    const { castFrame }   = await import("./frame.mjs");
    registerAll();

    const { ad } = makeHarness({ skills: { spellcast: 12 } });
    const adapter = new Proxy(ad, { get: (t, k) =>
        k === "skillValue" ? () => 12
      : k === "skillRank"  ? () => 4
      : t[k] });

    const ctx = makeContext({
        actor: { name: "C" }, item: { name: "S" },
        frame: { kind: "spell", cost: { mode: "fixed", amount: 1 },
                 targeting: { mode: "self", count: null }, range: 0, defence: { type: "none" } },
        adapter, targets: [], trees: {}
    });
    await castFrame(ctx, {});
    assert.equal(ctx.vars.skill, 12, "the roll total");
    assert.equal(ctx.vars.rank, 4, "and the rank, which is not the same thing");
});

test("the expression validator knows both", async () => {
    const { validateExpression } = await import("./expression.mjs");
    assert.deepEqual(validateExpression("5*{rank}"), []);
    assert.deepEqual(validateExpression("{skill}+2"), []);
    assert.ok(validateExpression("{spellcasting}").length, "and still refuses one that does not exist");
});
