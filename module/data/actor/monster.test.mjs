// module/data/actor/monster.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src    = readFileSync(new URL("./monster.mjs", import.meta.url), "utf8");
const config = readFileSync(new URL("../../setup/config.mjs", import.meta.url), "utf8");

test("monster.combat.weaponWeakness declared as a StringField (default 'none')", () => {
  assert.match(src, /weaponWeakness:\s*new fields\.StringField\(\{\s*initial:\s*"none"\s*\}\)/);
});

test("monster migrateData seeds weaponWeakness from category for legacy data", () => {
  assert.match(src, /static migrateData\(data\)/);
  // Guarded by `data?.category !== undefined`, so the call itself reads
  // `data.category` (no optional chaining needed).
  assert.match(src, /defaultWeaponWeaknessFor\(data\.category\)/);
});

test("defaultWeaponWeaknessFor: every non-humanoid category defaults to silver (Death March house rule)", () => {
  // House rule: meteorite column is folded into silver so all non-humanoid
  // monsters halve any damage that isn't silver-weapon or fire.
  for (const cat of ["cursedOne", "elementa", "necrophage", "relict", "specter", "vampire",
                     "beast", "hybrid", "draconid", "insectoid", "ogroid"]) {
    assert.match(config, new RegExp(`case "${cat}":[\\s\\S]*?return "silver"`),
      `${cat} should default to silver under the Death March house rule`);
  }
  // Humanoid (and anything unknown) → none.
  assert.match(config, /default:\s*return "none"/);
});

test("meteorite weapon quality carries isMeteorite damage flag", () => {
  assert.match(config, /meteorite:\s*wq\([\s\S]*?damageFlags:\s*\{\s*isMeteorite:\s*true\s*\}/);
});
