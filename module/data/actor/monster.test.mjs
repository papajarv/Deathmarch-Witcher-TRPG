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
  assert.match(src, /defaultWeaponWeaknessFor\(data\?\.category\)/);
});

test("defaultWeaponWeaknessFor maps each RAW p.175 category correctly", () => {
  // Silver-vulnerable categories.
  for (const cat of ["cursedOne", "elementa", "necrophage", "relict", "specter", "vampire"]) {
    assert.match(config, new RegExp(`case "${cat}":[\\s\\S]*?return "silver"`),
      `${cat} should default to silver`);
  }
  // Meteorite-vulnerable categories.
  for (const cat of ["beast", "hybrid", "draconid", "insectoid", "ogroid"]) {
    assert.match(config, new RegExp(`case "${cat}":[\\s\\S]*?return "meteorite"`),
      `${cat} should default to meteorite`);
  }
  // Humanoid (and anything unknown) → none.
  assert.match(config, /default:\s*return "none"/);
});

test("meteorite weapon quality carries isMeteorite damage flag", () => {
  assert.match(config, /meteorite:\s*wq\([\s\S]*?damageFlags:\s*\{\s*isMeteorite:\s*true\s*\}/);
});
