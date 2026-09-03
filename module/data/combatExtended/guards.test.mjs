// module/data/combatExtended/guards.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
    GUARD_KEYS, GUARDS, HIT_LOCATION_ADJACENCY, contiguousSets,
    guardOf, guardAttackMod, guardDefenseMod, canSwitchGuardThisRound
} from "./guards.mjs";

const guardsSrc = readFileSync(new URL("./guards.mjs", import.meta.url), "utf8");
const hooksSrc  = readFileSync(new URL("../../policy/combat-round-reset.mjs", import.meta.url), "utf8");

test("GUARD_KEYS lists all four stances from rules1", () => {
    assert.deepEqual([...GUARD_KEYS], ["balanced", "warding", "closed", "fools"]);
});

test("GUARDS mod table matches rules1 (Closed -2 atk / +2 def, Fool's +2 atk / -2 def)", () => {
    assert.equal(GUARDS.balanced.attackMod, 0);
    assert.equal(GUARDS.balanced.defenseMod, 0);
    assert.equal(GUARDS.closed.attackMod,   -2);
    assert.equal(GUARDS.closed.defenseMod,   2);
    assert.equal(GUARDS.fools.attackMod,     2);
    assert.equal(GUARDS.fools.defenseMod,   -2);
    assert.equal(GUARDS.warding.wardedBonus,    2);
    assert.equal(GUARDS.warding.unwardedPenalty, -1);
});

test("HIT_LOCATION_ADJACENCY: head ↔ torso; torso ↔ all four limbs; limbs ↔ torso only", () => {
    assert.deepEqual([...HIT_LOCATION_ADJACENCY.head],     ["torso"]);
    assert.deepEqual([...HIT_LOCATION_ADJACENCY.leftArm],  ["torso"]);
    assert.deepEqual([...HIT_LOCATION_ADJACENCY.rightArm], ["torso"]);
    assert.deepEqual([...HIT_LOCATION_ADJACENCY.leftLeg],  ["torso"]);
    assert.deepEqual([...HIT_LOCATION_ADJACENCY.rightLeg], ["torso"]);
    const torso = new Set(HIT_LOCATION_ADJACENCY.torso);
    for (const k of ["head", "leftArm", "rightArm", "leftLeg", "rightLeg"]) {
        assert.ok(torso.has(k), `torso should be adjacent to ${k}`);
    }
});

test("contiguousSets returns size-N contiguous coverage seeded from a location", () => {
    // Size 1 from any seed = just the seed.
    assert.deepEqual(contiguousSets("head", 1), [["head"]]);
    // Size 2 from head = [head, torso] (only neighbor).
    const s2 = contiguousSets("head", 2);
    assert.equal(s2.length, 1);
    assert.deepEqual([...s2[0]].sort(), ["head", "torso"]);
    // Size 3 from head must include head + torso + one neighbor of torso.
    const s3 = contiguousSets("head", 3).map(s => [...s].sort().join("|"));
    assert.ok(s3.includes(["head", "torso", "leftArm"].sort().join("|")));
    assert.ok(s3.includes(["head", "torso", "rightArm"].sort().join("|")));
    // Size > 6 = no valid set (only 6 anatomy slots).
    assert.deepEqual(contiguousSets("torso", 7), []);
});

test("guardOf returns Balanced when CE is off (no game globals in node)", () => {
    // In a node env, isCombatExtendedEnabled returns false because
    // game.settings doesn't exist — so guardOf must short-circuit to Balanced.
    const stub = { system: { guard: { current: "closed" } } };
    assert.equal(guardOf(stub).key, "balanced");
});

test("guardAttackMod returns 0 in a node env (CE off → no mod)", () => {
    assert.equal(guardAttackMod({ system: { guard: { current: "fools" } } }), 0);
});

test("guardDefenseMod with Warding and a known weapon returns 0 in node (CE off short-circuits)", () => {
    const actor = {
        system: { guard: { current: "warding", wardingLocations: { abc: "head" } } }
    };
    const weapon = { id: "abc" };
    assert.equal(guardDefenseMod(actor, weapon, "head"), 0);
});

test("canSwitchGuardThisRound returns false in node (CE off)", () => {
    assert.equal(canSwitchGuardThisRound({ system: { guard: {} } }), false);
});

test("combat-round-reset hooks: guard end-of-combat reset + preferred apply are wired", () => {
    // Hook handlers registered. The old per-round Special Action
    // lock-clear was removed when Special Actions became multi-use (capped
    // by the existing action economy) — no clearGuardLocks needed.
    assert.match(hooksSrc, /Hooks\.on\("combatStart"[\s\S]+applyPreferredGuards/);
    assert.match(hooksSrc, /resetGuardForActor\s*\(\s*actor\s*\)/);
    // Each lifecycle path still gates on isCombatExtendedEnabled (the
    // master toggle); the per-subsystem `guards` gate lives in guards.mjs
    // for the runtime call sites (guardOf / mods).
    assert.match(hooksSrc, /isCombatExtendedEnabled/);
    // guards.mjs now gates on the per-subsystem `guards` toggle.
    assert.match(guardsSrc, /isCESubsystemEnabled\("guards"\)/);
});

test("Late-joining combatants get their preferred guard via createCombatant", () => {
    // Hook registration
    assert.match(hooksSrc, /Hooks\.on\("createCombatant"/);
    // Gated on combat.started so combatStart's bulk pass doesn't double-apply
    assert.match(hooksSrc, /combatant\?\.combat\?\.started/);
    // Shared helper used by both paths
    assert.match(hooksSrc, /async function applyPreferredGuardForActor\(actor\)/);
    assert.match(hooksSrc, /applyPreferredGuardForActor\(combatant\.actor\)/);
});

test("defenseMixin and attackDialog both import and apply guard mods", () => {
    const defSrc = readFileSync(new URL("../../documents/mixins/defenseMixin.mjs", import.meta.url), "utf8");
    // The guard-ATTACK contribution moved out of weaponAttackMixin into
    // attackDialog.mjs so it surfaces as a labeled modifier chip in the
    // dialog (weaponAttackMixin just reads decl.modTotal now).
    const atkSrc = readFileSync(new URL("../../applications/attackDialog.mjs", import.meta.url), "utf8");
    assert.match(defSrc, /from\s+"[^"]*combatExtended\/guards\.mjs"/);
    assert.match(atkSrc, /from\s+"[^"]*combatExtended\/guards\.mjs"/);
    // defendWith folds guardDefenseMod (at the attacker's hit location) into the total
    assert.match(defSrc, /guardDefenseMod\s*\(\s*this\s*,\s*item\s*,\s*attackHitLocation\s*\)/);
    // attackDialog folds guardAttackMod into the chip total as guardAtk
    assert.match(atkSrc, /const\s+guardAtk\s*=\s*guardAttackMod\(/);
});
