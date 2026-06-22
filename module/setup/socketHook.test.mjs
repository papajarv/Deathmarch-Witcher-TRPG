// module/setup/socketHook.test.mjs
// Surface tests: verify the buildTargetShape helpers thread monster data
// the calculator expects. Runtime behavior is covered by damageCalculator.test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./socketHook.mjs", import.meta.url), "utf8");

test("buildMonsterFlags reads weaponWeakness for resistNonSilver / resistNonMeteorite", () => {
  assert.match(src, /resistNonSilver:\s*weakness === "silver"/);
  assert.match(src, /resistNonMeteorite:\s*weakness === "meteorite"/);
});

test("buildMonsterFlags reads damageProfile per-type into vulnerable / resist / immune lists", () => {
  assert.match(src, /if \(reaction === "vulnerable"\) flags\.vulnerableTo\.push/);
  assert.match(src, /else if \(reaction === "resistant"\) flags\.resistTypes\.push/);
  assert.match(src, /else if \(reaction === "immune"\)\s*flags\.immuneToTypes\.push/);
});

test("immuneToOrganCrits derived from category in {elementa, specter}", () => {
  assert.match(src, /immuneToOrganCrits:\s*sys\.category === "elementa" \|\| sys\.category === "specter"/);
});

test("buildNaturalArmorShape uses combat.armor as SP across every location", () => {
  assert.match(src, /function buildNaturalArmorShape\(actor\)/);
  assert.match(src, /actor\.type !== "monster"/);
  assert.match(src, /Number\(actor\.system\?\.combat\?\.armor\)/);
  // Every location gets the same flat SP — RAW monsters carry one number.
  assert.match(src, /for \(const loc of ARMOR_LOCS\) natural\[loc\] = \{ sp/);
});

/* ── Crit bonus ladder ─────────────────────────────────────────────── */

test("critBonusFor maps severity to RAW p.158 values (normal ladder)", () => {
  assert.match(src, /CRIT_BONUS_NORMAL\s*=\s*\{\s*simple:\s*3,\s*complex:\s*5,\s*difficult:\s*8,\s*deadly:\s*10\s*\}/);
});

test("critBonusFor maps severity to elementa/specter ladder when immuneToOrganCrits", () => {
  assert.match(src, /CRIT_BONUS_NO_ORGANS\s*=\s*\{\s*simple:\s*5,\s*complex:\s*10,\s*difficult:\s*15,\s*deadly:\s*20\s*\}/);
  assert.match(src, /immuneToOrganCrits \? CRIT_BONUS_NO_ORGANS : CRIT_BONUS_NORMAL/);
});

test("handleApplyDamage derives critBonus from severity using the target's flag", () => {
  assert.match(src, /critBonusFor\(payload\.critSeverity,\s*targetShape\.monsterFlags\.immuneToOrganCrits\)/);
});

/* ── Active Shield AE detection + write-back ───────────────────────── */

test("buildActiveShield scans target.effects for an activeShieldHp flag", () => {
  assert.match(src, /function buildActiveShield\(actor\)/);
  assert.match(src, /ae\.getFlag\?\.\(SYSTEM_ID,\s*"activeShieldHp"\)/);
});

test("handleApplyDamage writes the drained HP back to the AE (or deletes when collapsed)", () => {
  assert.match(src, /if \(activeShield && result\.patches\.activeShield\?\.hpDelta\)/);
  assert.match(src, /ae\.setFlag\(SYSTEM_ID,\s*"activeShieldHp",\s*nextHp\)/);
  assert.match(src, /if \(nextHp <= 0\)[\s\S]*?ae\.delete\(\)/);
});
