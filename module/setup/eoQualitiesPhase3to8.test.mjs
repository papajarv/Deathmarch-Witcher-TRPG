// module/setup/eoQualitiesPhase3to8.test.mjs
//
// Regression-lock the Phase 3-8 EO quality wires:
//   3. Reach extension + adjacent penalty
//   4. STA reductions + Physique gating
//   5. Throwing first-class strike
//   6. Charge family (mounted vs on-foot)
//   7. Misc combat (Grounded, Stable Aim, Concealment, Blade Catcher,
//      Magical Anchoring, Injector)
//   8. Armor effects (Critical Decimation/Flurry/Spellcasting/Block/
//      Riposte/Momentum, Silver/Meteorite Contact, Stifling, Bleed
//      Resistance, Ranged/SPD Penalty, Set Bonus)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { STRIKE_TYPES, WEAPON_QUALITIES, ARMOR_QUALITIES } from "./config.mjs";

const attackMixinSrc  = readFileSync(new URL("../documents/mixins/weaponAttackMixin.mjs", import.meta.url), "utf8");
const attackDialogSrc = readFileSync(new URL("../applications/attackDialog.mjs",          import.meta.url), "utf8");
const critRollSrc     = readFileSync(new URL("../chrome/chrome/critical-roll.js",         import.meta.url), "utf8");
const characterSrc    = readFileSync(new URL("../data/actor/character.mjs",               import.meta.url), "utf8");
const sheetBaseSrc    = readFileSync(new URL("../sheets/actor/base.mjs",                  import.meta.url), "utf8");

/* ── Phase 3: Reach helpers + adjacent penalty ──────────────────────── */

test("Phase 3 — weaponReachInfo helper exists and reads reachExtendMeters / reachAdjacentPenalty", () => {
    assert.match(attackMixinSrc, /function weaponReachInfo\(weapon\)/);
    assert.match(attackMixinSrc, /reachExtendMeters/);
    assert.match(attackMixinSrc, /reachAdjacentPenalty/);
    assert.match(attackMixinSrc, /reachAdjacentPommelOnly/);
    assert.match(attackMixinSrc, /reachAdjacentNoAttack/);
});

test("Phase 3 — adjacencyDistanceMeters helper uses Chebyshev pixel-max with token fallback", () => {
    assert.match(attackMixinSrc, /function adjacencyDistanceMeters/);
    /* Chebyshev (max of |dx|, |dy|) matches the Witcher grid model —
     * diagonal-adjacent stays at 2 m at 1.5 m/tile. Foundry's own
     * canvas.grid.measureDistance respects the scene's diagonal-cost
     * setting and would misreport diagonals, so we don't call it. */
    assert.match(attackMixinSrc, /Math\.max\(Math\.abs\(ax - dx\), Math\.abs\(ay - dy\)\)/);
});

test("Phase 3 — adjacent attacks with Extreme Reach refuse + abort", () => {
    assert.match(attackMixinSrc, /reachAdjacentNoAttack/);
    assert.match(attackMixinSrc, /ui\.notifications\?\.warn\(`\$\{weapon\.name\} \(Extreme Reach\)/);
});

test("Phase 3 — adjacent attack chip + reachAdjacentNote folded into composedNote", () => {
    assert.match(attackMixinSrc, /reachAdjacentChip/);
    assert.match(attackMixinSrc, /reachAdjacentNote/);
    assert.match(attackMixinSrc, /pommel strike only \(Superior Reach\)/);
    /* composedNote now also carries a targetStatusLine (informational
     * summary of the target's defense penalties from status effects),
     * added in the RAW grapple rework so the attacker can see WHY the
     * DC is what it is. Assert the full array shape. */
    assert.match(attackMixinSrc, /\[strikeNote, defenseLine, reachAdjacentNote, targetStatusLine\]/);
});

/* ── Phase 4: Physique gating + STA reductions ──────────────────────── */

test("Phase 4 — Physique penalty reads system.skills.body.physique.value", () => {
    assert.match(attackMixinSrc, /system\?\.skills\?\.body\?\.physique\?\.value/);
    assert.match(attackMixinSrc, /requiresMinPhysique/);
});

test("Phase 4 — Nimble STA refund is calculated and applied after the loop", () => {
    assert.match(attackMixinSrc, /nimbleAttackStaReduction/);
    assert.match(attackMixinSrc, /drawStaReduction/);
    assert.match(attackMixinSrc, /nimbleStaRefund/);
    /* Refund call after the shot loop */
    assert.match(attackMixinSrc, /nimbleStaRefund > 0[\s\S]*?system\.derivedStats\.sta\.value/);
});

/* ── Phase 5: Throwing first-class strike ───────────────────────────── */

test("Phase 5 — STRIKE_TYPES has a `throw` entry with thrown: true", () => {
    assert.equal(STRIKE_TYPES.throw?.thrown, true);
    assert.equal(STRIKE_TYPES.throw?.meleeOnly, true);
});

test("Phase 5 — attackDialog gates Throw on the weapon's range field (post-migration schema)", () => {
    assert.match(attackDialogSrc, /const canThrow = /);
    /* Post-migration: throwability derives from the Range field alone.
     * Throw is the basic strike in isThrownMode (dialog mode="thrown" or
     * slot="quick"). Outside thrown mode it's omitted from the melee
     * specials so a player who'd pick it from there wouldn't fire
     * without range/weather brackets. */
    assert.match(attackDialogSrc, /isThrownMode\s*=\s*canThrow/);
    assert.match(attackDialogSrc, /key === "throw"/);
});

test("Phase 5 — thrown-strike drop fires _dropThrownWeapon on the throw strike itself", () => {
    /* Drop signal is the strike, not the weapon type — a hurled sword
     * drops the same way a dedicated dart used to. */
    assert.match(attackMixinSrc, /decl\?\.strikeMeta\?\.thrown/);
});

/* ── Phase 6: Charge family ─────────────────────────────────────────── */

test("Phase 6 — Charge strike prompts for meters and adds Nd6 damage", () => {
    assert.match(attackMixinSrc, /decl\.strike === "charge"/);
    assert.match(attackMixinSrc, /Meters moved/);
    assert.match(attackMixinSrc, /chargeBonusPerMeter/);
    assert.match(attackMixinSrc, /chargingMode/);
});

test("Phase 6 — Charge tail appended to damage formula + chip", () => {
    assert.match(attackMixinSrc, /chargeBonusDice > 0 && mainDamage\.display/);
    assert.match(attackMixinSrc, /label:\s*`Charge \(\$\{chargeBonusSrc\}\)`/);
});

/* ── Phase 7: Misc combat ───────────────────────────────────────────── */

test("Phase 7 — Grounded refuses ranged shot while mounted", () => {
    assert.match(attackMixinSrc, /isGrounded/);
    assert.match(attackMixinSrc, /actorMounted/);
    assert.match(attackMixinSrc, /Can't fire while mounted or in a vehicle/i);
});

test("Phase 7 — Stable Aim folds Aim bonus into the crit-severity roll", () => {
    assert.match(critRollSrc, /function detectStableAimBonus/);
    assert.match(critRollSrc, /stableAim/);
    assert.match(critRollSrc, /aimAdd/);
});

test("Phase 7 — Magically Anchoring strips intangible/invisible/teleporting on hit", () => {
    assert.match(attackMixinSrc, /magicalAnchoring/);
    assert.match(attackMixinSrc, /\["intangible", "invisible", "teleporting"\]/);
});

test("Phase 7 — Blade Catcher block rider surfaces a Small Blades vs Physique note", () => {
    assert.match(attackMixinSrc, /bladeCatcher/);
    assert.match(attackMixinSrc, /Opposed Small Blades vs Physique \/ Sleight of Hand/);
});

test("Phase 7 — Injector rider surfaces a chat-card note on hit", () => {
    assert.match(attackMixinSrc, /Injector/);
    assert.match(attackMixinSrc, /if charged, the poison is \+3 harder to resist/);
});

/* ── Phase 8: Armor effects ────────────────────────────────────────── */

test("Phase 8 — Critical Decimation bumps severity by one tier", () => {
    assert.match(critRollSrc, /function detectCriticalDecimation/);
    assert.match(critRollSrc, /SEVERITY_ORDER/);
    assert.match(critRollSrc, /decimation/);
});

test("Phase 8 — Critical Flurry / Spellcasting / Momentum riders on the attacker's crit", () => {
    assert.match(attackMixinSrc, /criticalFlurry/);
    assert.match(attackMixinSrc, /criticalSpellcasting/);
    assert.match(attackMixinSrc, /criticalMomentum/);
});

test("Phase 8 — Critical Block / Critical Riposte fire on >4 parry/block beat", () => {
    assert.match(attackMixinSrc, /criticalBlock/);
    assert.match(attackMixinSrc, /criticalRiposte/);
    assert.match(attackMixinSrc, /delta < -4/);
});

test("Phase 8 — Silver / Meteorite Contact staggers a monster attacker on natural / brawling hit", () => {
    assert.match(attackMixinSrc, /silverContact/);
    assert.match(attackMixinSrc, /meteoriteContact/);
    assert.match(attackMixinSrc, /isNaturalOrBrawl/);
    assert.match(attackMixinSrc, /statusId:\s*"staggered"/);
});

test("Phase 8 — Stifling armor refuses the Take a Breath rest action", () => {
    assert.match(sheetBaseSrc, /stifling/);
    assert.match(sheetBaseSrc, /can't rest in/i);
});

test("Phase 8 — Bleed Resistance reduces the bleed-rider percent chance", () => {
    assert.match(attackMixinSrc, /bleedResistance/);
    assert.match(attackMixinSrc, /rider\.statusId === "bleed"/);
});

test("Phase 8 — Ranged Penalty armor chip applied on ranged shots", () => {
    assert.match(attackMixinSrc, /rangedPenaltyChip/);
    assert.match(attackMixinSrc, /Armor Ranged Penalty/);
});

test("Phase 8 — SPD Penalty armor reduces stats.spd.value in character.mjs", () => {
    assert.match(characterSrc, /spdPenalty/);
    assert.match(characterSrc, /this\.stats\.spd\.value = Math\.max\(1/);
});

test("Phase 8 — Set Bonus rider fires when all worn pieces share the same setBonus parameter", () => {
    assert.match(attackMixinSrc, /setBonus/);
    assert.match(attackMixinSrc, /allWithSet && setNames\.size === 1/);
});

/* ── Catalog schemas (sanity) ─────────────────────────────────────── */

test("Catalog — Nimble carries draw + attack STA reductions of 2", () => {
    assert.equal(WEAPON_QUALITIES.nimble.drawStaReduction, 2);
    assert.equal(WEAPON_QUALITIES.nimble.nimbleAttackStaReduction, 2);
});

test("Catalog — Physique quality carries requiresMinPhysique placeholder", () => {
    assert.ok(WEAPON_QUALITIES.physique.requiresMinPhysique > 0);
});

test("Catalog — Grounded weapon quality flags groundedOnly", () => {
    assert.equal(WEAPON_QUALITIES.grounded.groundedOnly, true);
});

test("Catalog — Stable Aim quality flags aimAppliesToCrit", () => {
    assert.equal(WEAPON_QUALITIES.stableAim.aimAppliesToCrit, true);
});

test("Catalog — Armor: stifling / lanceRest / superiorLanceRest entries exist", () => {
    assert.ok(ARMOR_QUALITIES.stifling);
    assert.ok(ARMOR_QUALITIES.lanceRest);
    assert.ok(ARMOR_QUALITIES.superiorLanceRest);
});

test("Catalog — Armor: bleedResistance / rangedPenalty / spdPenalty / hidden parameterized entries exist", () => {
    assert.ok(ARMOR_QUALITIES.bleedResistance);
    assert.ok(ARMOR_QUALITIES.rangedPenalty);
    assert.ok(ARMOR_QUALITIES.spdPenalty);
    assert.ok(ARMOR_QUALITIES.hidden);
});

test("Catalog — Witcher-school armor critical triggers exist", () => {
    assert.ok(ARMOR_QUALITIES.criticalDecimation);
    assert.ok(ARMOR_QUALITIES.criticalFlurry);
    assert.ok(ARMOR_QUALITIES.criticalSpellcasting);
    assert.ok(ARMOR_QUALITIES.criticalBlock);
    assert.ok(ARMOR_QUALITIES.criticalRiposte);
    assert.ok(ARMOR_QUALITIES.criticalMomentum);
});
