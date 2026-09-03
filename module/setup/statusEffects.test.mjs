// module/setup/statusEffects.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const effects = readFileSync(new URL("./statusEffects.mjs", import.meta.url), "utf8");
const clauses = readFileSync(new URL("./statusClauses.mjs", import.meta.url), "utf8");

test("entangled status is registered in BASELINE (for the entangling weapon quality)", () => {
  assert.match(effects, /id:\s*"entangled"[\s\S]*?name:\s*"WITCHER\.Status\.Entangled"/);
});

test("entangled clause encodes RAW mechanics: -5 SPD, -2 attack/defense, DC 18 break free", () => {
  assert.match(clauses, /entangled:\s*\{[\s\S]*?mods:\s*\{\s*stats:\s*\{\s*spd:\s*-5\s*\}[\s\S]*?roll:\s*\{[\s\S]*?attack:\s*-2[\s\S]*?defense:\s*-2/);
  assert.match(clauses, /entangled:[\s\S]*?endCheck:\s*\{[\s\S]*?dc:\s*18/);
});
