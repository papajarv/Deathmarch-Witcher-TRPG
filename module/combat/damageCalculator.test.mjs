// module/combat/damageCalculator.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDamage, makeDamageSource, makeTarget } from "./damageCalculator.mjs";

/* Helpers — concise factories for the common test cases. */
const dmgWeapon = (over = {}) => makeDamageSource({ kind: "weapon", ...over });
const tgtArmor  = (locKey, sp, dr = [], itemIds = ["a1"]) =>
  makeTarget({ armor: { [locKey]: { sp, dr, itemIds } } });

/* -------------------------------------------------------------------------- */
/* SP subtraction + ablation                                                  */
/* -------------------------------------------------------------------------- */

test("SP fully soaks weapon damage → no HP change, no ablation, early exit", () => {
  const r = resolveDamage({
    damageSource: dmgWeapon({ weaponDamage: 5, location: { key: "torso", mult: 1 } }),
    target:       tgtArmor("torso", 10)
  });
  assert.equal(r.finalDamage, 0);
  assert.equal(r.patches.hp.delta, 0);
  assert.deepEqual(r.patches.armorAblation, []);
  assert.ok(r.stages.some(s => s.stage === "sp" && s.soakedAll));
});

test("Partial SP penetration on a plain weapon → damage flows, -1 SP base chip per contributing armor (RAW: default ablation)", () => {
  const r = resolveDamage({
    damageSource: dmgWeapon({ weaponDamage: 12, location: { key: "torso", mult: 1 } }),
    target:       tgtArmor("torso", 5)
  });
  assert.equal(r.finalDamage, 7);
  assert.equal(r.patches.hp.delta, -7);
  assert.deepEqual(r.patches.armorAblation, [{ itemId: "a1", spDelta: -1 }]);
});

test("Partial SP penetration with Ablating weapon → -1 base + rolled 1d6/2 bonus (pre-rolled at apply time)", () => {
  // ablatingChipBonus is rolled by handleApplyDamage; the calculator just
  // adds it to the base chip. Force a deterministic value of 2 here.
  const r = resolveDamage({
    damageSource: dmgWeapon({ weaponDamage: 12, ablating: true, ablatingChipBonus: 2, location: { key: "torso", mult: 1 } }),
    target:       tgtArmor("torso", 5)
  });
  assert.equal(r.finalDamage, 7);
  assert.deepEqual(r.patches.armorAblation, [{ itemId: "a1", spDelta: -3 }]);
});

test("Partial SP penetration with Crushing Force (doubleAblation) → -2 SP per contributing armor", () => {
  const r = resolveDamage({
    damageSource: dmgWeapon({ weaponDamage: 12, doubleAblation: true, location: { key: "torso", mult: 1 } }),
    target:       tgtArmor("torso", 5)
  });
  assert.equal(r.finalDamage, 7);
  assert.deepEqual(r.patches.armorAblation, [{ itemId: "a1", spDelta: -2 }]);
});

test("Crushing Force + Ablating compose: doubled base chip plus rolled Ablating bonus", () => {
  const r = resolveDamage({
    damageSource: dmgWeapon({ weaponDamage: 12, doubleAblation: true, ablating: true, ablatingChipBonus: 3, location: { key: "torso", mult: 1 } }),
    target:       tgtArmor("torso", 5)
  });
  // base chip = 2 (Crushing Force), ablating roll = 3, total = 5
  assert.deepEqual(r.patches.armorAblation, [{ itemId: "a1", spDelta: -5 }]);
});

test("Improved AP halves SP before subtraction", () => {
  const r = resolveDamage({
    damageSource: dmgWeapon({ weaponDamage: 10, improvedArmorPiercing: true, location: { key: "torso", mult: 1 } }),
    target:       tgtArmor("torso", 12)
  });
  // SP 12 → halved to 6 → 10 - 6 = 4
  assert.equal(r.finalDamage, 4);
});

test("bypassesWornArmor skips worn SP entirely", () => {
  const r = resolveDamage({
    damageSource: dmgWeapon({ weaponDamage: 10, bypassesWornArmor: true, location: { key: "torso", mult: 1 } }),
    target:       tgtArmor("torso", 30)
  });
  assert.equal(r.finalDamage, 10);
});

/* -------------------------------------------------------------------------- */
/* DR halve                                                                   */
/* -------------------------------------------------------------------------- */

test("DR halves damage when armor resists the type", () => {
  const r = resolveDamage({
    damageSource: dmgWeapon({ weaponDamage: 10, damageTypes: ["fire"], location: { key: "torso", mult: 1 } }),
    target:       tgtArmor("torso", 0, ["fire"])
  });
  assert.equal(r.finalDamage, 5);
});

test("AP negates DR (no halving)", () => {
  const r = resolveDamage({
    damageSource: dmgWeapon({ weaponDamage: 10, damageTypes: ["fire"], armorPiercing: true, location: { key: "torso", mult: 1 } }),
    target:       tgtArmor("torso", 0, ["fire"])
  });
  assert.equal(r.finalDamage, 10);
});

test("Improved AP also negates DR", () => {
  const r = resolveDamage({
    damageSource: dmgWeapon({ weaponDamage: 10, damageTypes: ["fire"], improvedArmorPiercing: true, location: { key: "torso", mult: 1 } }),
    target:       tgtArmor("torso", 0, ["fire"])
  });
  assert.equal(r.finalDamage, 10);
});

/* -------------------------------------------------------------------------- */
/* Location multiplier                                                        */
/* -------------------------------------------------------------------------- */

test("Head shot (×3) multiplies AFTER SP/DR", () => {
  const r = resolveDamage({
    damageSource: dmgWeapon({ weaponDamage: 10, location: { key: "head", mult: 3, label: "Head" } }),
    target:       tgtArmor("head", 4)
  });
  // 10 - 4 = 6 → ×3 = 18
  assert.equal(r.finalDamage, 18);
});

test("Leg shot (×½) halves AFTER SP", () => {
  const r = resolveDamage({
    damageSource: dmgWeapon({ weaponDamage: 10, location: { key: "rightLeg", mult: 0.5, label: "R Leg" } }),
    target:       tgtArmor("rightLeg", 4)
  });
  // 10 - 4 = 6 → ×0.5 = 3
  assert.equal(r.finalDamage, 3);
});

/* -------------------------------------------------------------------------- */
/* Monster resists                                                            */
/* -------------------------------------------------------------------------- */

test("Monster non-silver resist halves non-silver damage", () => {
  const r = resolveDamage({
    damageSource: dmgWeapon({ weaponDamage: 10, location: { key: "torso", mult: 1 } }),
    target:       makeTarget({ monsterFlags: { resistNonSilver: true } })
  });
  assert.equal(r.finalDamage, 5);
});

test("Silver weapon bypasses non-silver resist", () => {
  const r = resolveDamage({
    damageSource: dmgWeapon({ weaponDamage: 10, isSilver: true, location: { key: "torso", mult: 1 } }),
    target:       makeTarget({ monsterFlags: { resistNonSilver: true } })
  });
  assert.equal(r.finalDamage, 10);
});

test("Hybrid Silver-quality weapon vs resistNonSilver: base halves, silver portion added on top", () => {
  // 1d6+1 rolled = 5, 3d6 silver rolled = 12. Against a silver-resistant
  // target: floor(5/2) + 12 = 14.
  const r = resolveDamage({
    damageSource: dmgWeapon({ weaponDamage: 5, silverDamage: 12, location: { key: "torso", mult: 1 } }),
    target:       makeTarget({ monsterFlags: { resistNonSilver: true } })
  });
  assert.equal(r.finalDamage, 14);
});

test("Hybrid Silver-quality weapon vs non-silver-resistant target: silver portion ignored", () => {
  // Same roll, but the target doesn't care about silver. Only the base
  // applies; the silver portion is dropped.
  const r = resolveDamage({
    damageSource: dmgWeapon({ weaponDamage: 5, silverDamage: 12, location: { key: "torso", mult: 1 } }),
    target:       makeTarget()    // no monsterFlags
  });
  assert.equal(r.finalDamage, 5);
});

test("Fire bypasses non-silver resist (errata sidebar)", () => {
  const r = resolveDamage({
    damageSource: dmgWeapon({ weaponDamage: 10, damageTypes: ["fire"], location: { key: "torso", mult: 1 } }),
    target:       makeTarget({ monsterFlags: { resistNonSilver: true } })
  });
  assert.equal(r.finalDamage, 10);
});

test("Vulnerability doubles damage", () => {
  const r = resolveDamage({
    damageSource: dmgWeapon({ weaponDamage: 10, damageTypes: ["fire"], location: { key: "torso", mult: 1 } }),
    target:       makeTarget({ monsterFlags: { vulnerableTo: ["fire"] } })
  });
  assert.equal(r.finalDamage, 20);
});

test("Per-type immunity zeroes weapon damage AND crit bonus (crit is same-type)", () => {
  const r = resolveDamage({
    damageSource: dmgWeapon({ weaponDamage: 10, critBonus: 5, damageTypes: ["fire"], location: { key: "torso", mult: 1 } }),
    target:       makeTarget({ monsterFlags: { immuneToTypes: ["fire"] } })
  });
  // Natural resistances shape ALL incoming damage under the rework —
  // fire crit bonus lands on a fire-immune target as 0. Untyped crits
  // (no damageTypes match) still ride past the immunity gate.
  assert.equal(r.finalDamage, 0);
});

test("Improved AP bypasses per-type immunity (weapon damage lands at full)", () => {
  const r = resolveDamage({
    damageSource: dmgWeapon({ weaponDamage: 10, improvedArmorPiercing: true, damageTypes: ["fire"], location: { key: "torso", mult: 1 } }),
    target:       makeTarget({ monsterFlags: { immuneToTypes: ["fire"] } })
  });
  assert.equal(r.finalDamage, 10);
});

test("Improved AP bypasses per-type resist (no halve)", () => {
  const r = resolveDamage({
    damageSource: dmgWeapon({ weaponDamage: 10, improvedArmorPiercing: true, damageTypes: ["slashing"], location: { key: "torso", mult: 1 } }),
    target:       makeTarget({ monsterFlags: { resistTypes: ["slashing"] } })
  });
  assert.equal(r.finalDamage, 10);
});

test("Improved AP does NOT bypass resistNonSilver (silver weakness gate still applies)", () => {
  const r = resolveDamage({
    damageSource: dmgWeapon({ weaponDamage: 10, improvedArmorPiercing: true, location: { key: "torso", mult: 1 } }),
    target:       makeTarget({ monsterFlags: { resistNonSilver: true } })
  });
  // resistNonSilver gate fires regardless of IAP → halved
  assert.equal(r.finalDamage, 5);
});

test("Improved AP does NOT bypass resistNonMeteorite (meteorite weakness gate still applies)", () => {
  const r = resolveDamage({
    damageSource: dmgWeapon({ weaponDamage: 10, improvedArmorPiercing: true, location: { key: "torso", mult: 1 } }),
    target:       makeTarget({ monsterFlags: { resistNonMeteorite: true } })
  });
  assert.equal(r.finalDamage, 5);
});

test("Per-type resist halves damage independently of non-silver resist", () => {
  const r = resolveDamage({
    damageSource: dmgWeapon({ weaponDamage: 12, damageTypes: ["slashing"], location: { key: "torso", mult: 1 } }),
    target:       makeTarget({ monsterFlags: { resistTypes: ["slashing"], resistNonSilver: true } })
  });
  // 12 → type resist halve = 6 → non-silver halve = 3
  assert.equal(r.finalDamage, 3);
});

test("Silver weapon vs typed-resist + non-silver monster: only typed DR applies", () => {
  const r = resolveDamage({
    damageSource: dmgWeapon({ weaponDamage: 12, isSilver: true, damageTypes: ["slashing"], location: { key: "torso", mult: 1 } }),
    target:       makeTarget({ monsterFlags: { resistTypes: ["slashing"], resistNonSilver: true } })
  });
  // 12 → type resist halve = 6 → silver bypasses non-silver stage → 6
  assert.equal(r.finalDamage, 6);
});

test("Non-meteorite resist halves damage from non-meteorite weapons", () => {
  const r = resolveDamage({
    damageSource: dmgWeapon({ weaponDamage: 10, location: { key: "torso", mult: 1 } }),
    target:       makeTarget({ monsterFlags: { resistNonMeteorite: true } })
  });
  assert.equal(r.finalDamage, 5);
});

test("Meteorite weapon bypasses non-meteorite resist", () => {
  const r = resolveDamage({
    damageSource: dmgWeapon({ weaponDamage: 10, isMeteorite: true, location: { key: "torso", mult: 1 } }),
    target:       makeTarget({ monsterFlags: { resistNonMeteorite: true } })
  });
  assert.equal(r.finalDamage, 10);
});

/* -------------------------------------------------------------------------- */
/* Crit bonus                                                                 */
/* -------------------------------------------------------------------------- */

test("Crit bonus joins after armor/DR, gets multiplied by location", () => {
  const r = resolveDamage({
    damageSource: dmgWeapon({
      weaponDamage: 10, critBonus: 5, location: { key: "head", mult: 3, label: "Head" }
    }),
    target: tgtArmor("head", 4)
  });
  // 10 - 4 = 6 → +5 crit = 11 → ×3 = 33
  assert.equal(r.finalDamage, 33);
});

test("Crit bonus still applies even when SP fully soaks weapon damage", () => {
  const r = resolveDamage({
    damageSource: dmgWeapon({
      weaponDamage: 5, critBonus: 10, location: { key: "head", mult: 3, label: "Head" }
    }),
    target: tgtArmor("head", 20)
  });
  // weapon: 5 - 20 → 0 soaked. crit bonus: 10 → ×3 = 30
  assert.equal(r.finalDamage, 30);
});

/* -------------------------------------------------------------------------- */
/* Shield (basic Quen)                                                        */
/* -------------------------------------------------------------------------- */

test("Quen drains incoming weapon damage before SP and location", () => {
  const r = resolveDamage({
    damageSource: dmgWeapon({ weaponDamage: 8, location: { key: "torso", mult: 1 } }),
    target:       makeTarget({ shield: 5, armor: { torso: { sp: 0, dr: [] } } })
  });
  // shield drains 5 → 3 left → SP 0 → location ×1 → 3
  assert.equal(r.finalDamage, 3);
  assert.equal(r.patches.shield.delta, -5);
});

test("Quen does NOT drain a spell that can't be Blocked (Aard / Resist Magic / None)", () => {
  // Spell-source with defense=["dodge"] (Aard): shield gate fails because
  // defense doesn't include "block".
  const r = resolveDamage({
    damageSource: makeDamageSource({
      kind: "sign", weaponDamage: 8, damageTypes: [],
      defense: ["dodge"], location: { key: "torso", mult: 1 }
    }),
    target: makeTarget({ shield: 5, armor: { torso: { sp: 0, dr: [] } } })
  });
  assert.equal(r.finalDamage, 8);
  assert.equal(r.patches.shield.delta, 0);
});

test("Quen DOES drain a spell whose defense includes Block (Igni)", () => {
  const r = resolveDamage({
    damageSource: makeDamageSource({
      kind: "sign", weaponDamage: 6, damageTypes: ["fire"],
      defense: ["dodge", "block"], location: { key: "torso", mult: 1 }
    }),
    target: makeTarget({ shield: 4, armor: { torso: { sp: 0, dr: [] } } })
  });
  assert.equal(r.finalDamage, 2);
  assert.equal(r.patches.shield.delta, -4);
});

test("Ongoing tick (poison/disease/suffocation) bypasses the shield", () => {
  const r = resolveDamage({
    damageSource: makeDamageSource({
      kind: "effect", weaponDamage: 3, damageTypes: [],
      defense: ["block"], isOngoingTick: true, location: { key: "torso", mult: 1 }
    }),
    target: makeTarget({ shield: 10, armor: { torso: { sp: 0, dr: [] } } })
  });
  assert.equal(r.finalDamage, 3);
  assert.equal(r.patches.shield.delta, 0);
});

test("bypassesShield flag skips the shield even for blockable damage", () => {
  const r = resolveDamage({
    damageSource: dmgWeapon({ weaponDamage: 6, bypassesShield: true, location: { key: "torso", mult: 1 } }),
    target:       makeTarget({ shield: 5, armor: { torso: { sp: 0, dr: [] } } })
  });
  assert.equal(r.finalDamage, 6);
  assert.equal(r.patches.shield.delta, 0);
});

/* -------------------------------------------------------------------------- */
/* Active Shield                                                              */
/* -------------------------------------------------------------------------- */

test("Active Shield drains tangible damage; collapse rider fires when depleted", () => {
  const r = resolveDamage({
    damageSource: dmgWeapon({ weaponDamage: 15, location: { key: "torso", mult: 1 } }),
    target:       makeTarget({
      activeEffects: { activeShield: { hp: 10 } },
      armor: { torso: { sp: 0, dr: [] } }
    })
  });
  // active shield absorbs 10 → 5 left → SP 0 → 5
  assert.equal(r.finalDamage, 5);
  assert.equal(r.patches.activeShield.hpDelta, -10);
  assert.ok(r.effects.some(e => e.kind === "activeShieldCollapse"));
});

test("Active Shield ignores incorporeal (tangible=false) damage", () => {
  const r = resolveDamage({
    damageSource: dmgWeapon({ weaponDamage: 6, tangible: false, location: { key: "torso", mult: 1 } }),
    target:       makeTarget({
      activeEffects: { activeShield: { hp: 10 } },
      armor: { torso: { sp: 0, dr: [] } }
    })
  });
  assert.equal(r.finalDamage, 6);
  assert.equal(r.patches.activeShield, null);   // wasn't touched
});

/* -------------------------------------------------------------------------- */
/* On-penetrate rider signal                                                  */
/* -------------------------------------------------------------------------- */

test("onPenetrate effect signal fires when weapon damage breaches SP", () => {
  const r = resolveDamage({
    damageSource: dmgWeapon({ weaponDamage: 10, location: { key: "torso", mult: 1 } }),
    target:       tgtArmor("torso", 4)
  });
  assert.ok(r.effects.some(e => e.kind === "onPenetrate"));
});

test("onPenetrate does NOT fire when SP fully soaks the hit", () => {
  const r = resolveDamage({
    damageSource: dmgWeapon({ weaponDamage: 5, location: { key: "torso", mult: 1 } }),
    target:       tgtArmor("torso", 10)
  });
  assert.ok(!r.effects.some(e => e.kind === "onPenetrate"));
});

/* -------------------------------------------------------------------------- */
/* Tie everything together — a head crit with shield + DR                     */
/* -------------------------------------------------------------------------- */

test("Full pipeline: shield(3) → vulnerability → DR(fire) → SP(4) → crit(+5, resist-scaled) → head×3", () => {
  const r = resolveDamage({
    damageSource: dmgWeapon({
      weaponDamage: 20,
      critBonus:    5,
      damageTypes:  ["fire"],
      // Plain weapon now: base -1 SP chip lands by default on a penetrating
      // hit (no `ablating: true` needed for the chip itself).
      location:     { key: "head", mult: 3, label: "Head" }
    }),
    target: makeTarget({
      shield: 3,
      armor:  { head: { sp: 4, dr: ["fire"], itemIds: ["h1"] } },
      monsterFlags: { vulnerableTo: ["fire"] }
    })
  });
  // 20 → shield 3 = 17 → vulnerability ×2 = 34 → DR halve = 17 → SP 4 = 13
  // → crit 5 (also ×2 vulnerable) = 10 → 13 + 10 = 23 → head ×3 = 69.
  assert.equal(r.finalDamage, 69);
  assert.equal(r.patches.shield.delta, -3);
  assert.deepEqual(r.patches.armorAblation, [{ itemId: "h1", spDelta: -1 }]);
});
