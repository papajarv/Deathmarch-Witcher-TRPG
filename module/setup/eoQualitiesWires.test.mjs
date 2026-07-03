// module/setup/eoQualitiesWires.test.mjs
//
// Regression-lock the Equipment Overhaul weapon + armor quality wires.
// These tests confirm: (a) each EO quality has its canonical EO description
// text, (b) its mechanical hooks are present, (c) the engine consumers
// that read those hooks are wired (source-pattern checks).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WEAPON_QUALITIES, ARMOR_QUALITIES } from "./config.mjs";

const defenseMixinSrc = readFileSync(new URL("../documents/mixins/defenseMixin.mjs", import.meta.url), "utf8");
const combatMixinSrc  = readFileSync(new URL("../documents/mixins/combatRoundMixin.mjs", import.meta.url), "utf8");
const attackMixinSrc  = readFileSync(new URL("../documents/mixins/weaponAttackMixin.mjs", import.meta.url), "utf8");
const promptSrc       = readFileSync(new URL("../applications/defensePromptDialog.mjs", import.meta.url), "utf8");
const socketSrc       = readFileSync(new URL("./socketHook.mjs", import.meta.url), "utf8");

/* ──────────── Weapon quality canonical schemas ──────────── */

test("Brawling description matches EO p.7 wording", () => {
    assert.match(WEAPON_QUALITIES.brawling.description, /punch or kick damage.*changes your punch or kick damage to the type shown/);
});

test("Long Reach: 2m reach + -1 adjacent penalty", () => {
    assert.equal(WEAPON_QUALITIES.longReach.reachExtendMeters, 2);
    assert.equal(WEAPON_QUALITIES.longReach.reachAdjacentPenalty, -1);
    assert.match(WEAPON_QUALITIES.longReach.description, /2 meters beyond your normal melee Reach/);
});

test("Superior Reach: 4m reach + -3 adjacent + pommel-only", () => {
    assert.equal(WEAPON_QUALITIES.superiorReach.reachExtendMeters, 4);
    assert.equal(WEAPON_QUALITIES.superiorReach.reachAdjacentPenalty, -3);
    assert.equal(WEAPON_QUALITIES.superiorReach.reachAdjacentPommelOnly, true);
});

test("Extreme Reach: 6m reach + -5 adjacent + no-attack flag", () => {
    assert.equal(WEAPON_QUALITIES.extremeReach.reachExtendMeters, 6);
    assert.equal(WEAPON_QUALITIES.extremeReach.reachAdjacentPenalty, -5);
    assert.equal(WEAPON_QUALITIES.extremeReach.reachAdjacentNoAttack, true);
});

test("Guard + Superior Guard set defenseBonus to 1 and 2", () => {
    assert.equal(WEAPON_QUALITIES.guard.defenseBonus, 1);
    assert.equal(WEAPON_QUALITIES.superiorGuard.defenseBonus, 2);
});

test("Feeble carries the three EO restriction flags", () => {
    assert.equal(WEAPON_QUALITIES.feeble.feebleParryRestrictedToFeeble, true);
    assert.equal(WEAPON_QUALITIES.feeble.feebleBlockHalfDamage, true);
    assert.equal(WEAPON_QUALITIES.feeble.feebleBlockHalfNonlethalVsHefty, true);
});

test("Hefty carries the house-variant flags (blocks Fast Strike entirely)", () => {
    assert.equal(WEAPON_QUALITIES.hefty.heftyBlocksFastStrike, true);
    assert.equal(WEAPON_QUALITIES.hefty.heftyDeniesNonSturdy, true);
    assert.equal(WEAPON_QUALITIES.hefty.heftyBlockHalfNonlethal, true);
    assert.equal(WEAPON_QUALITIES.hefty.damageFlags?.deniesParry, true);
});

test("Sturdy counter-Hefty flag is set", () => {
    assert.equal(WEAPON_QUALITIES.sturdy.counterHefty, true);
});

test("Indirect: defense penalty both sides + damageFlags.indirect for attacker-side", () => {
    assert.equal(WEAPON_QUALITIES.indirect.defensePenaltyBothSides, 2);
    assert.equal(WEAPON_QUALITIES.indirect.damageFlags?.indirect, true);
});

test("Nimble reduces both draw + attack extra-action STA by 2", () => {
    assert.equal(WEAPON_QUALITIES.nimble.drawStaReduction, 2);
    assert.equal(WEAPON_QUALITIES.nimble.nimbleAttackStaReduction, 2);
});

test("Cavalry: mounted charging mode, 1d6 per metre", () => {
    assert.equal(WEAPON_QUALITIES.cavalry.chargingMode, "mounted");
    assert.equal(WEAPON_QUALITIES.cavalry.chargeBonusPerMeter, 1);
});

test("footCharging (EO Charging): on-foot mode, 1d6 per 2 metres", () => {
    assert.equal(WEAPON_QUALITIES.footCharging.chargingMode, "onfoot");
    assert.equal(WEAPON_QUALITIES.footCharging.chargeBonusPerMeter, 0.5);
});

test("Non-Lethal + Full Cover are marked deprecated per EO", () => {
    assert.equal(WEAPON_QUALITIES.nonLethal.deprecated, true);
    assert.match(WEAPON_QUALITIES.nonLethal.deprecationNote, /Non-lethal damage type/);
    assert.equal(ARMOR_QUALITIES.fullCover.deprecated, true);
});

/* ──────────── Armor quality canonical schemas ──────────── */

test("Restricted Vision: HALVES combat STA recovery (house variant)", () => {
    assert.equal(ARMOR_QUALITIES.restrictedVision.armorHalvesCombatStaRecovery, true);
    assert.match(ARMOR_QUALITIES.restrictedVision.description, /only recover HALF your normal Stamina/);
});

test("Poor Vision: HALVES combat STA recovery + canonical description", () => {
    assert.equal(ARMOR_QUALITIES.poorVision.armorHalvesCombatStaRecovery, true);
    assert.match(ARMOR_QUALITIES.poorVision.description, /−2 to Awareness and ranged attacks/);
    assert.match(ARMOR_QUALITIES.poorVision.description, /only recover HALF your normal Stamina/);
});

test("Sturdy/Very Sturdy (shield) counter Hefty / Crushing Force", () => {
    assert.equal(ARMOR_QUALITIES.sturdyShield.counterHefty, true);
    assert.equal(ARMOR_QUALITIES.verySturdy.counterHefty, true);
    assert.equal(ARMOR_QUALITIES.verySturdy.counterCrushingForce, true);
});

test("Parrying (shield) carries parryPenaltyDelta to negate the -3", () => {
    assert.equal(ARMOR_QUALITIES.parryingShield.parryPenaltyDelta, 3);
});

/* ──────────── Engine consumer wiring ──────────── */

test("defenseMixin reads weaponGuardBonus + weaponIndirectSelfPenalty", () => {
    assert.match(defenseMixinSrc, /function weaponGuardBonus\(item\)/);
    assert.match(defenseMixinSrc, /function weaponIndirectSelfPenalty\(item\)/);
    assert.match(defenseMixinSrc, /const guardEoBonus\s*=\s*weaponGuardBonus\(item\)/);
    assert.match(defenseMixinSrc, /const indirectSelfPen\s*=\s*weaponIndirectSelfPenalty\(item\)/);
    /* Total folds both in */
    assert.match(defenseMixinSrc, /\+\s*guardEoBonus\s*\+\s*indirectSelfPen/);
});

test("defenseMixin applies the Feeble-parry warning note", () => {
    assert.match(defenseMixinSrc, /function weaponIsFeeble\(item\)/);
    assert.match(defenseMixinSrc, /Feeble \(EO p\.7\): this weapon can only Parry other Feeble weapons/);
});

test("defenseMixin applies attacker-side Indirect (-2 to defender)", () => {
    assert.match(defenseMixinSrc, /attackerDamageFlags\?\.indirect/);
    assert.match(defenseMixinSrc, /indirectVsAtk\s*=\s*\(attackerDamageFlags\?\.indirect\)\s*\?\s*-2\s*:\s*0/);
});

test("defenseMixin signatures accept attackerDamageFlags", () => {
    assert.match(defenseMixinSrc, /async\s+defendWith\([\s\S]+attackerDamageFlags\s*=\s*null/);
    assert.match(defenseMixinSrc, /async\s+defendBySkill\([\s\S]+attackerDamageFlags\s*=\s*null/);
});

test("socketHook.runDefenseChoice threads attackerDamageFlags into defendWith/defendBySkill", () => {
    /* Signature now also carries `attackHitLocation` (CE Warding auto-apply) — the
     * defender needs the attacker's hit location so guardDefenseMod can branch
     * warded vs unwarded. Both parameters must survive the socket relay. */
    assert.match(socketSrc, /async function runDefenseChoice\([\s\S]+attackerDamageFlags\s*=\s*null[\s\S]*attackHitLocation\s*=\s*null\s*\)/);
    assert.match(socketSrc, /defendWith\([^)]+attackerDamageFlags[^)]*\}\)/);
    assert.match(socketSrc, /defendBySkill\([^)]+attackerDamageFlags\s*\}\)/);
});

test("qualitiesToDamageFlags exposes the `indirect` flag for downstream defense math", () => {
    assert.match(socketSrc, /indirect:\s*false/);
});

test("defensePromptDialog allows parry by counterHefty items even when deniesParry is set", () => {
    assert.match(promptSrc, /import\s*\{\s*WEAPON_QUALITIES,\s*ARMOR_QUALITIES\s*\}/);
    /* The counterer filter runs when deniesParry is set, restricts parryItems to counter-Hefty,
     * and re-enables the gate. */
    assert.match(promptSrc, /counterHefty\s*\|\|\s*allCat\[q\]\?\.counterCrushingForce/);
    assert.match(promptSrc, /gate\.parry\s*=\s*true/);
});

test("combatRoundMixin halves STA recovery when armorHalvesCombatStaRecovery is set", () => {
    assert.match(combatMixinSrc, /#armorHalvesStaRecovery\(\)/);
    assert.match(combatMixinSrc, /armorHalvesCombatStaRecovery/);
    /* Recovery action floors REC to half when the flag fires */
    assert.match(combatMixinSrc, /rec\s*=\s*Math\.floor\(rec\s*\/\s*2\)/);
});

test("attackDialog filters Fast Strike out of the picker for a Hefty weapon", () => {
    const adSrc = readFileSync(new URL("../applications/attackDialog.mjs", import.meta.url), "utf8");
    assert.match(adSrc, /heftyBlocksFastStrike/);
    assert.match(adSrc, /passesHefty/);
    /* Both option lists run the filter */
    const occurrences = (adSrc.match(/passesHefty\(key\)/g) || []).length;
    assert.ok(occurrences >= 2);
});

test("weaponAttackMixin defensively downgrades Fast Strike on a Hefty weapon", () => {
    /* The dialog hides the option; this is the belt-and-braces fallback. */
    assert.match(attackMixinSrc, /heftyBlocksFastStrike/);
    assert.match(attackMixinSrc, /isFastStrike\s*&&\s*hasHefty/);
});
