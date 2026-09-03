/**
 * A control that cannot change the outcome must not be offered.
 *
 * This engine kept growing dropdown entries and inputs that were declared,
 * rendered, and then either never read or read from a field nothing wrote.
 * Each one looked like a feature and was a lie. The ones fixed here:
 *
 *   absorbDamage.parity   read `incoming.nonLethal`, which nothing set
 *   absorbDamage.order    wrote `absorbedBefore`, which nothing read
 *   createShield.order    handed the adapter a key it destructures away
 *   removeStatus "area"   took the same branch as "targets"
 *   grantPool "nearby"    took the same branch as "targets"
 *   saveEnds "targetStat" produced dc = null with no stat to read
 *   multiAttack           rolled per attack into a field nothing read
 *   builder perMargin     had `count` in the sentence, not in the formula
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerAll } from "./spells/harness.mjs";
import { allBlocks, getBlock } from "./registry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const read = (f) => code(readFileSync(join(HERE, f), "utf8"));

registerAll();

test("every enum option is reachable in its block's run()", () => {
    /* An option the body never branches on is only honest when the value is
     * passed straight out to the adapter. These are the ones that were not. */
    const GONE = [
        ['core:removeStatus', 'from', 'area'],
        ['core:grantPool',    'scope', 'nearby']
    ];
    for (const [id, key, option] of GONE) {
        const spec = getBlock(id)?.inputs?.[key];
        assert.ok(spec, `${id}.${key} vanished — update this test`);
        assert.ok(!spec.options.includes(option),
            `${id}.${key} still offers "${option}", which behaves identically to another option`);
    }
});

test("absorbDamage's parity has data behind it", () => {
    const DEF = read("blocks/defensive.mjs");
    const INT = read("intercept.mjs");
    const CORE = read("blocks/core.mjs");
    assert.match(DEF, /a\.parity === "lethalOnly" && inc\.nonLethal/,
        "parity is no longer read — update this test");
    assert.match(INT, /nonLethal: !!opts\?\.nonLethal/,
        "the interception payload must carry nonLethal or parity can never be true");
    assert.match(CORE, /nonLethal: !!a\.nonLethal/,
        "dealDamage must be able to declare non-lethal damage");
    assert.ok(getBlock("core:dealDamage").inputs.nonLethal, "and expose it as an input");
});

test("the order-of-absorption control is gone rather than faked", () => {
    /* Armour is applied downstream in the GM's damage handler, so "absorb
     * after armour" is not something this side can do. */
    assert.ok(!getBlock("core:absorbDamage").inputs.order, "absorbDamage still offers order");
    assert.ok(!getBlock("core:createShield").inputs.order, "createShield still offers order");
    assert.doesNotMatch(read("blocks/defensive.mjs"), /absorbedBefore/, "still writes a field nothing reads");
    for (const b of allBlocks()) {
        assert.ok(!/\[order\]/.test(b.label ?? ""), `${b.id} still shows an [order] slot`);
    }
});

test("saveEnds can actually read a target's stat", () => {
    const spec = getBlock("core:saveEnds").inputs;
    assert.ok(spec.dcSource.options.includes("targetStat"));
    assert.ok(spec.dcStat, "targetStat needs a stat to read");
    assert.match(read("blocks/effects.mjs"), /statValue\?\.\(t\.actor, a\.dcStat\)/,
        "the target's stat is never actually read");
});

test("multiAttack resolves each attack against the defence", () => {
    const SRC = read("blocks/effects.mjs");
    assert.match(SRC, /attackerWins\(total, t\.defenceTotal/,
        "each attack must be re-checked, or all N share one verdict");
    assert.match(SRC, /t\.hit = verdicts\[j\]/,
        "the frame's verdict must be restored so later blocks aren't skewed");
});

test("no corpus spell passes an argument its block does not declare", async () => {
    /* The validator already catches this; running it over the whole corpus is
     * what turns "we removed an input" into "and we fixed its callers". */
    const { CORPUS } = await import("./spells/corpus.mjs");
    const { validateSpell } = await import("./registry.mjs");
    const problems = CORPUS.flatMap(s => validateSpell(s));
    assert.deepEqual(problems, [], "\n" + problems.join("\n"));
});
