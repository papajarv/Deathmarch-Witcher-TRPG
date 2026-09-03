// Hold-status chain: the CE Clinch/Chokehold/Grapple/Pin actions must
// tag their TARGET AND HOLDER with the matching status so Close Quarters
// fires on follow-up strikes against either party. Escape is not an
// action — the movement-break hook in holdLink.mjs clears the pair when
// either token moves out of reach. The wiring sits in
// data/combatExtended/actions.mjs (action defs) + weaponAttackMixin
// (apply at hit-resolution time). statusEffects.mjs must register
// `clinched` and `chokeheld` so Foundry has icons + labels for them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const actionsSrc = readFileSync(new URL("./actions.mjs", import.meta.url), "utf8");
const mixinSrc = readFileSync(new URL("../../documents/mixins/weaponAttackMixin.mjs", import.meta.url), "utf8");
const statusSrc = readFileSync(new URL("../../setup/statusEffects.mjs", import.meta.url), "utf8");

test("clinch action declares appliesStatus: 'clinched'", () => {
    assert.match(actionsSrc, /clinch:\s*Object\.freeze\(\{[\s\S]+?appliesStatus:\s*"clinched"/);
});

test("chokehold action declares appliesStatus: 'chokeheld'", () => {
    assert.match(actionsSrc, /chokehold:\s*Object\.freeze\(\{[\s\S]+?appliesStatus:\s*"chokeheld"/);
});

test("grapple action declares appliesStatus: 'grappled' (CE weapon path mirrors brawl)", () => {
    assert.match(actionsSrc, /grapple:\s*Object\.freeze\(\{[\s\S]+?appliesStatus:\s*"grappled"/);
});

test("pin action declares appliesStatus: 'pinned'", () => {
    assert.match(actionsSrc, /pin:\s*Object\.freeze\(\{[\s\S]+?appliesStatus:\s*"pinned"/);
});

test("escape action is removed — movement handles clearing", () => {
    /* Escape used to be an action with clearsStatuses. Under the
     * bidirectional / multi-clinch model, escape is pure movement:
     * the movement-break hook clears the pair whose partner distance
     * exceeded reach. See holdLink.mjs onUpdateTokenForHold. */
    assert.doesNotMatch(actionsSrc, /escape:\s*Object\.freeze/);
});

test("clinched + chokeheld statuses are registered in statusEffects.mjs", () => {
    assert.match(statusSrc, /id:\s*"clinched"/);
    assert.match(statusSrc, /id:\s*"chokeheld"/);
});

test("weaponAttackMixin imports getActiveCombatActions for the hit-time table lookup", () => {
    assert.match(mixinSrc, /import\s*\{[^}]*getActiveCombatActions[^}]*\}\s*from\s*"\.\.\/\.\.\/data\/combatExtended\/actions\.mjs"/);
});

test("weaponAttackMixin applies appliesStatus on a HIT (delta > 0)", () => {
    // Block reads the strike's appliesStatus (strikeMeta first, CE actionDef
    // fallback), gates on delta > 0, and calls emitApplyStatus / applyHoldLink.
    assert.match(mixinSrc, /actionDef\?\.appliesStatus[\s\S]+?emitApplyStatus\(\s*\{[^}]+?action:\s*"apply"/);
    // Gate resolves the strike status then requires a hit: `delta > 0 && strikeStatus`.
    assert.match(mixinSrc, /const\s+strikeStatus\s*=\s*decl\.strikeMeta\?\.appliesStatus\s*\?\?\s*actionDef\?\.appliesStatus/);
    assert.match(mixinSrc, /delta\s*>\s*0\s*&&\s*strikeStatus/);
});

test("weaponAttackMixin has no clearsStatuses branch (Escape action removed)", () => {
    /* The Escape action's clearsStatuses code path is gone. The only
     * clear paths remaining are movement-break + incapacitation, both
     * driven by the hooks in holdLink.mjs. */
    assert.doesNotMatch(mixinSrc, /Array\.isArray\(actionDef\?\.clearsStatuses\)/);
});

test("Close Quarters context is registry-based over all four hold kinds, either role", () => {
    /* CQ now reads the hold REGISTRY (getHoldsSync) rather than the target's
     * statuses — so it fires for unlinked-token holds AND when the grapplee
     * attacks the grappler (only the grappled/pinned SIDE carries the status). */
    assert.match(mixinSrc, /_isCloseQ\s*=\s*getHoldsSync\(attackerUuid\)\.some/);
    assert.match(mixinSrc, /\["grappled",\s*"pinned",\s*"clinched",\s*"chokeheld"\]\.includes\(p\.kind\)/);
});
