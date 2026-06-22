// module/combat/damageBreakdown.test.mjs
// Real unit tests — renderDamageBreakdown is a pure HTML helper, no
// Foundry deps. Exercise each stage handler + the summary line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDamageBreakdown } from "./damageBreakdown.mjs";
import { resolveDamage, makeDamageSource, makeTarget } from "./damageCalculator.mjs";

const dmg = (over) => makeDamageSource({ kind: "weapon", ...over });

test("Renders a <details> block wrapping a <summary> + <ul> of stages", () => {
  const result = resolveDamage({
    damageSource: dmg({ weaponDamage: 10, location: { key: "torso", mult: 1 } }),
    target:       makeTarget({ armor: { torso: { sp: 4, dr: [], itemIds: ["a1"] } } })
  });
  const html = renderDamageBreakdown({ targetName: "Ghoul A", result });
  assert.match(html, /^<details[\s\S]*<\/details>$/);
  assert.match(html, /<summary>/);
  assert.match(html, /<ul[\s\S]*<\/ul>/);
});

test("Summary reflects final damage + HP delta", () => {
  const result = resolveDamage({
    damageSource: dmg({ weaponDamage: 10, location: { key: "torso", mult: 1 } }),
    target:       makeTarget({ armor: { torso: { sp: 4, dr: [], itemIds: ["a1"] } } })
  });
  // 10 - 4 SP = 6 to HP
  const html = renderDamageBreakdown({ targetName: "Ghoul A", result });
  assert.match(html, /Ghoul A.*takes <b>6<\/b> damage \(HP -6\)/);
});

test("Fully-soaked attack reports 'no damage' summary", () => {
  const result = resolveDamage({
    damageSource: dmg({ weaponDamage: 5, location: { key: "torso", mult: 1 } }),
    target:       makeTarget({ armor: { torso: { sp: 10, dr: [], itemIds: ["a1"] } } })
  });
  const html = renderDamageBreakdown({ targetName: "Knight", result });
  assert.match(html, /Knight<\/b> takes no damage/);
  // SP-soaked stage still appears in the body so the GM can see WHY.
  assert.match(html, /fully soaked/);
});

test("Renders each pipeline stage that fires", () => {
  const result = resolveDamage({
    damageSource: dmg({
      weaponDamage: 20, critBonus: 5, damageTypes: ["fire"],
      location: { key: "head", mult: 3, label: "Head" }
    }),
    target: makeTarget({
      shield: 3,
      armor: { head: { sp: 4, dr: ["fire"], itemIds: ["h1"] } },
      monsterFlags: { vulnerableTo: ["fire"] }
    })
  });
  const html = renderDamageBreakdown({ targetName: "Fiend", result });
  for (const re of [
    /Quen shield drained/,
    /Armor SP/,
    /Damage Resistance halved/,
    /vulnerable/,
    /Crit bonus/,
    /Location ×<b>3<\/b>/
  ]) assert.match(html, re, `missing stage: ${re}`);
});

test("Escapes HTML in target name (XSS safety)", () => {
  const result = { stages: [], finalDamage: 0, patches: { hp: { delta: 0 } } };
  const html = renderDamageBreakdown({ targetName: "<img onerror=alert(1)>", result });
  assert.doesNotMatch(html, /<img onerror=/);
  assert.match(html, /&lt;img/);
});

test("Unknown stage keys are skipped silently (forward-compat)", () => {
  const result = {
    stages: [
      { stage: "futureStage", before: 99, after: 1 },
      { stage: "location",    before: 6, mult: 3, label: "Head", after: 18 }
    ],
    finalDamage: 18,
    patches: { hp: { delta: -18 } }
  };
  const html = renderDamageBreakdown({ targetName: "X", result });
  // futureStage isn't in RENDER so it produces no <li>; the known one does.
  assert.match(html, /Location ×<b>3<\/b>/);
  assert.doesNotMatch(html, /futureStage/);
});

test("Empty stages array still renders the summary line", () => {
  const result = { stages: [], finalDamage: 0, patches: { hp: { delta: 0 } } };
  const html = renderDamageBreakdown({ targetName: "Empty", result });
  assert.match(html, /No pipeline stages fired/);
  assert.match(html, /takes no damage/);
});

test("Active Shield collapse rider surfaces as its own line", () => {
  // Run the real pipeline to get the activeShieldCollapse effect.
  const result = resolveDamage({
    damageSource: dmg({ weaponDamage: 15, location: { key: "torso", mult: 1 } }),
    target:       makeTarget({
      activeEffects: { activeShield: { hp: 10 } },
      armor:         { torso: { sp: 0, dr: [] } }
    })
  });
  const html = renderDamageBreakdown({ targetName: "Mage", result });
  assert.match(html, /Active Shield drained/);
  assert.match(html, /Active Shield collapsed/);
  assert.match(html, /push 2m/);
});
