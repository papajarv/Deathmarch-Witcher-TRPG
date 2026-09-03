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

test("immuneToOrganCrits derived from category in {elementa, specter}, with GM override", () => {
  // Category fallback: elementa / specter monsters are immune by default.
  assert.match(src, /sys\.category === "elementa" \|\| sys\.category === "specter"/);
  // Per-monster override on combat.immuneToOrganCrits wins over the category
  // default when set to "true" or "false"; "auto" / unset falls back to the
  // category check.
  assert.match(src, /sys\.combat\?\.immuneToOrganCrits/);
  assert.match(src, /overrideOrgan === "true"\s*\?\s*true/);
  assert.match(src, /overrideOrgan === "false"\s*\?\s*false/);
});

test("buildNaturalArmorShape uses combat.armor as SP across every location", () => {
  assert.match(src, /function buildNaturalArmorShape\(actor\)/);
  assert.match(src, /actor\.type !== "monster"/);
  assert.match(src, /Number\(actor\.system\?\.combat\?\.armor\)/);
  // Every location gets the same flat SP — RAW monsters carry one number.
  assert.match(src, /for \(const loc of ARMOR_LOCS\) natural\[loc\] = \{ sp/);
});

/* ── Crit bonus ladder ─────────────────────────────────────────────── */

test("crit bonus ladder is imported from the shared pure helper (RAW values)", () => {
  /* The RAW constants + the pure critBonusFor helper now live in
   * combat/critBonus.mjs — socketHook imports them so the file's
   * literal values aren't duplicated here. Ladder-value unit tests
   * live alongside the helper in combat/critBonus.test.mjs. */
  assert.match(src, /import \{ critBonusFor \} from "\.\.\/combat\/critBonus\.mjs"/);
});

test("crit bonus ladder is house-rule editable via hrCritBonusLadders", () => {
  assert.match(src, /import \{ hrCritBonusLadders(?:, \w+)* \} from "\.\.\/mechanics\/house-rules-config\.mjs"/);
});

test("handleApplyDamage derives critBonus from severity using the target's flag AND the live ladders", () => {
  assert.match(src, /critBonusFor\(payload\.critSeverity,\s*targetShape\.monsterFlags\.immuneToOrganCrits,\s*hrCritBonusLadders\(\)\)/);
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
