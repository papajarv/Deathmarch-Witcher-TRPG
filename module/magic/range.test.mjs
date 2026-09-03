// module/magic/range.test.mjs
//
// EXECUTING test for range, and for the ORDER the stages run in.
//
// Range was declared on every frame, shown in the casting-rules panel, and
// enforced by nothing. `validate` looped over `ctx.targets` looking for anyone
// too far away — at L1, three stages before targets were acquired. The loop ran
// over an empty array and passed everything, every time.
//
// A check against a list nothing has filled in yet is a check that always
// passes, and that is a bug no assertion about the check itself would catch.
// So these test the ORDER as well as the rule.

import test from "node:test";
import assert from "node:assert/strict";

import { STAGES } from "./frame.mjs";
import { castOne, registerAll } from "./spells/harness.mjs";
import { AENYE } from "./spells/fire.mjs";
import { QUEN } from "./spells/signs.mjs";
import { _resetBus } from "./bus.mjs";
import { _resetLifetimes } from "./lifetimes.mjs";

test.before(registerAll);
test.beforeEach(() => { _resetBus(); _resetLifetimes(); });


test("a target beyond the spell's range refuses the cast", async () => {
    const { ctx } = await castOne(AENYE, { distance: 25 }, [{ name: "Far" }]);
    assert.equal(ctx.control.aborted, true);
    assert.match(ctx.control.abortReason, /reaches 12m; that target is 25m away/);
});

test("a target at exactly the limit is in range", async () => {
    const { ctx } = await castOne(AENYE, { distance: 12 }, [{ name: "Edge" }]);
    assert.equal(ctx.control.aborted, false);
});

test("being out of range costs NOTHING", async () => {
    // The reason validate runs before price. Charging for a cast that never
    // happened is worse than not checking at all.
    const { ctx, log } = await castOne(AENYE, { distance: 40 }, [{ name: "Far" }]);
    assert.equal(ctx.control.aborted, true);
    assert.ok(!log.some(([k]) => k === "damage"), "it resolved anyway");
    assert.equal(ctx.record.staSpent, 0, "stamina was charged for a refused cast");
});

test("the range gate runs AFTER the targets are known", () => {
    // Ordering is the whole bug: a check against a list nothing has filled in
    // yet is a check that always passes.
    const order = STAGES.map(([label]) => label.replace(/^L\d+ /, ""));
    assert.ok(order.indexOf("targets") < order.indexOf("validate"),
        `targets must come first — order is ${order.join(" → ")}`);
    assert.ok(order.indexOf("validate") < order.indexOf("price"),
        "and validation must come before anything is spent");
});

test("a self-targeted spell is never out of range", async () => {
    const { ctx } = await castOne(QUEN, { sta: 3, distance: 999 });
    assert.equal(ctx.control.aborted, false);
});
