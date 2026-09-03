// module/data/item/race.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("./race.mjs", import.meta.url), "utf8");

test("race schema declares magic-restriction flags", () => {
  for (const f of ["noMagicProfession", "potionImmune", "blueMutagenImmune"]) {
    assert.match(src, new RegExp(`${f}\\s*:\\s*new fields\\.BooleanField`), `missing ${f}`);
  }
});
