/**
 * A matching armour glyph may be spent two ways at cast time: +3 to the roll,
 * or +1d6 to the effect. Only the first reached an authored spell.
 *
 * Two independent breaks, both rooted in the engine keeping its magnitude in a
 * BLOCK while the surrounding system keeps it in `system.damageFormula`:
 *
 *   1. `spellHasMagnitude` was computed from `system.damageFormula`, which is
 *      empty for every spell built in the canvas or loaded from the book. It
 *      was therefore false for all of them, so the "+1d6 to the effect" radio
 *      was never rendered — the glyph could only ever be spent on the roll.
 *
 *   2. Nothing under magic/ had ever read `glyphMagnitudeDice`. A player who
 *      picked the +1d6 anyway (on a legacy spell that offered it) got nothing
 *      from it once the cast routed through the authored engine.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerAll } from "./spells/harness.mjs";
import { getBlock } from "./registry.mjs";
import { CORPUS } from "./spells/corpus.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const MIXIN = code(readFileSync(join(HERE, "..", "documents", "mixins", "castSpellMixin.mjs"), "utf8"));

registerAll();

const MAGNITUDE = ["core:dealDamage", "core:healHealth", "core:createShield", "core:drainResource"];
const hasMagnitude = (spell) => {
    const walk = (body) => (body ?? []).some(n => MAGNITUDE.includes(n?.b) || walk(n?.body));
    return Object.values(spell.on ?? {}).some(walk);
};

test("the dialog offers the +1d6 option to authored spells", () => {
    /* The inline walk moved into `dialogFacts`, which is now the one thing that
     * reads a tree to decide what the dialog shows. */
    assert.match(MIXIN, /dialogFactsFor/,
        "spellHasMagnitude still reads only the legacy damageFormula field");
    assert.match(MIXIN, /\|\| treeFacts\.hasMagnitude/);
});

test("most of the corpus has a magnitude to spend a glyph on", () => {
    /* If this ever drops to zero the detection above has broken. */
    const withMagnitude = CORPUS.filter(hasMagnitude);
    assert.ok(withMagnitude.length > 20,
        `only ${withMagnitude.length} corpus spells expose a magnitude — detection is probably broken`);
});

async function runDamage(declaration, args = {}) {
    const rolled = [];
    const ctx = {
        actor: { name: "C" }, item: { name: "S" },
        targets: [{ actor: { name: "T" }, hit: true }],
        record: { castId: "x" }, vars: { sta: 1 }, created: [], control: {}, frame: {},
        declaration,
        adapter: { rollFormula: async (f) => { rolled.push(f); return 5; },
                   applyDamage: async () => ({ penetrated: true, finalDamage: 5 }) }
    };
    const a = { formula: "3d6", damageType: "fire", location: "random",
                bypassArmour: false, channel: null, nonLethal: false, ...args };
    await getBlock("core:dealDamage").run(ctx, a, {});
    return { rolled, ctx };
}

test("glyph dice reach the damage formula", async () => {
    const { rolled } = await runDamage({ glyphMagnitudeDice: 2 });
    assert.equal(rolled[0], "3d6+2d6");
});

test("no glyph means the formula is untouched", async () => {
    assert.equal((await runDamage({})).rolled[0], "3d6");
    assert.equal((await runDamage(null)).rolled[0], "3d6");
    assert.equal((await runDamage({ glyphMagnitudeDice: 0 })).rolled[0], "3d6");
});

test("one glyph is spent once, not once per damage block", async () => {
    /* A glyph is a single choice made once in the dialog. A tree with three
     * damage blocks in it must not collect +1d6 three times. */
    const { rolled, ctx } = await runDamage({ glyphMagnitudeDice: 2 });
    assert.equal(rolled[0], "3d6+2d6");
    assert.equal(ctx.control.glyphSpent, true);

    rolled.length = 0;
    await getBlock("core:dealDamage").run(ctx,
        { formula: "3d6", damageType: "fire", location: "random",
          bypassArmour: false, channel: null, nonLethal: false }, {});
    assert.equal(rolled[0], "3d6", "the second block took the glyph a second time");
});

test("healing counts as a magnitude too", () => {
    const SRC = code(readFileSync(join(HERE, "blocks", "core.mjs"), "utf8"));
    assert.match(SRC, /const glyph = takeGlyphDice\(ctx\);/, "healHealth ignores the glyph");
});
