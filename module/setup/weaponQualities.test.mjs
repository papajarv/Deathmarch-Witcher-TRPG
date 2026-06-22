// module/setup/weaponQualities.test.mjs
// Verifies the WEAPON_QUALITIES catalog carries the right damageFlags + rider
// config — these are read at runtime by the damage calculator (via the socket
// handler) and the post-hit rider in weaponAttackMixin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./config.mjs", import.meta.url), "utf8");

test("wq() accepts a 4th `extra` arg that carries damageFlags + rider", () => {
  assert.match(src, /const wq = \(label, description, param = null, extra = null\)/);
  assert.match(src, /damageFlags:\s*Object\.freeze\(extra\?\.damageFlags \?\? \{\}\)/);
  assert.match(src, /rider:\s*extra\?\.rider/);
});

test("Damage-flag qualities (AP, Improved AP, Ablating) carry the correct flags", () => {
  assert.match(src, /armorPiercing:\s*wq\([\s\S]*?damageFlags:\s*\{\s*armorPiercing:\s*true\s*\}/);
  assert.match(src, /improvedArmorPiercing:\s*wq\([\s\S]*?damageFlags:\s*\{\s*improvedArmorPiercing:\s*true\s*\}/);
  assert.match(src, /ablating:\s*wq\([\s\S]*?damageFlags:\s*\{\s*ablating:\s*true\s*\}/);
});

test("Silver quality carries isSilver damage flag", () => {
  assert.match(src, /silver:\s*wq\([\s\S]*?damageFlags:\s*\{\s*isSilver:\s*true\s*\}/);
});

test("Percent-rider qualities carry rider config keyed to the right status", () => {
  for (const [key, status] of Object.entries({
    bleeding:  "bleed",
    knockdown: "prone",
    disease:   "diseased",
    fire:      "burning",
    freeze:    "freeze",
    poison:    "poisoned",
    stagger:   "staggered",
  })) {
    assert.match(src, new RegExp(`${key}:\\s*wq\\([\\s\\S]*?rider:\\s*\\{\\s*kind:\\s*"percent",\\s*statusId:\\s*"${status}"\\s*\\}`),
      `${key} → ${status} rider missing or wrong`);
  }
});

test("Entangling quality carries an auto rider for the entangled status", () => {
  assert.match(src, /entangling:\s*wq\([\s\S]*?rider:\s*\{\s*kind:\s*"auto",\s*statusId:\s*"entangled"\s*\}/);
});

test("Stun quality carries a stunSave rider with explicit head/torso locations", () => {
  assert.match(src, /stun:\s*wq\([\s\S]*?rider:\s*\{\s*kind:\s*"stunSave",\s*statusId:\s*"stunned",\s*locations:\s*\["head",\s*"torso"\]\s*\}/);
});
