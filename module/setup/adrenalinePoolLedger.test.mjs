// module/setup/adrenalinePoolLedger.test.mjs
//
// EXECUTING test (not source-string matching) for the pool-current fix:
// neither prep-time re-applier — applyEventLedger (event-mode) nor
// applyConditionActions (condition-mode) — may re-write a spendable pool value
// (adrenaline/hp/sta/...) at prepareDerivedData. Re-applying there is the
// "tick it down and it pops back up / snowballs" bug. A NON-pool target
// (a stat modifier) must still be applied, proving the functions aren't just
// no-oping everything.

import test from "node:test";
import assert from "node:assert/strict";

// Minimal Foundry global surface these two functions touch. Installed BEFORE
// importing config.mjs so the module sees them.
function getProperty(obj, path) {
    return String(path).split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setProperty(obj, path, value) {
    const ks = String(path).split(".");
    let o = obj;
    for (let i = 0; i < ks.length - 1; i++) { if (o[ks[i]] == null) o[ks[i]] = {}; o = o[ks[i]]; }
    o[ks[ks.length - 1]] = value;
    return true;
}
globalThis.foundry = { utils: { getProperty, setProperty } };

const { applyEventLedger, applyConditionActions, isPoolCurrentTarget, SYSTEM_ID } =
    await import("./config.mjs");

const POOL   = "system.adrenaline.value";
const NONPOOL = "system.stats.will.modifier";

function actorWith(actions, { ledger = null } = {}) {
    const effect = { id: "eff1", active: true, flags: { [SYSTEM_ID]: { actions } } };
    return {
        system: { adrenaline: { value: 0 }, stats: { will: { modifier: 0 } } },
        flags: { [SYSTEM_ID]: ledger ? { fx: { eff1: ledger } } : {} },
        allApplicableEffects() { return [effect]; },
    };
}

test("isPoolCurrentTarget flags the spendable pools and not stat modifiers", () => {
    assert.equal(isPoolCurrentTarget("system.adrenaline.value"), true);
    assert.equal(isPoolCurrentTarget("system.derivedStats.hp.value"), true);
    assert.equal(isPoolCurrentTarget("system.stats.will.modifier"), false);
    assert.equal(isPoolCurrentTarget("system.derivedStats.hp.max"), false);
});

test("applyEventLedger: pool target is NOT re-applied at prep; non-pool IS", () => {
    const actor = actorWith(
        [
            { type: "modify", target: POOL,    op: "add", value: "3", when: "adrenalineGain", lasts: "untilEffectEnds" },
            { type: "modify", target: NONPOOL, op: "add", value: "2", when: "adrenalineGain", lasts: "untilEffectEnds" },
        ],
        { ledger: { "0": { fires: 5 }, "1": { fires: 5 } } }   // 5 accumulated fires each
    );
    applyEventLedger(actor);
    // Pool: skipped — stays at the stored 0 no matter how many fires banked.
    assert.equal(actor.system.adrenaline.value, 0, "adrenaline must NOT be re-added at prep");
    // Non-pool control: +2 per fire × 5 = +10, proving the ledger still works.
    assert.equal(actor.system.stats.will.modifier, 10, "non-pool ledger must still apply");
});

test("applyConditionActions: pool target is NOT re-applied at prep; non-pool IS", () => {
    const actor = actorWith([
        { type: "modify", target: POOL,    op: "add", value: "3", when: "condition", condition: "1" },
        { type: "modify", target: NONPOOL, op: "add", value: "2", when: "condition", condition: "1" },
    ]);
    applyConditionActions(actor);
    assert.equal(actor.system.adrenaline.value, 0, "adrenaline must NOT be buffed at prep");
    assert.equal(actor.system.stats.will.modifier, 2, "non-pool condition buff must still apply");
});
