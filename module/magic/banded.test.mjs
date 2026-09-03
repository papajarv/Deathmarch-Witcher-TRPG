/**
 * A banded cost buys the highest band the spend reaches — and a placeholder
 * that fails to resolve must never travel on as if it were a value.
 *
 * Cursed Illness is why. Its cost bands ARE its effect (`{2:"staggered",
 * 4:"stunned", 6:"poisoned"}`) and its body applies `status: "{band}"`. The
 * lookup was an exact key match, so any spend that was not exactly 2, 4 or 6
 * produced `null`, `{band}` stayed literal, and `applyStatus` dropped an
 * unrecognised id without a word. The stamina was spent and nothing happened.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { bandFor } from "./frame.mjs";
import { resolveText } from "./expression.mjs";

test("a banded cost buys the highest band the spend reaches", () => {
    const bands = { 2: "staggered", 4: "stunned", 6: "poisoned" };
    assert.equal(bandFor(bands, 1), null,        "below the first band buys nothing");
    assert.equal(bandFor(bands, 2), "staggered");
    assert.equal(bandFor(bands, 3), "staggered", "an in-between spend must not fall through to null");
    assert.equal(bandFor(bands, 4), "stunned");
    assert.equal(bandFor(bands, 5), "stunned");
    assert.equal(bandFor(bands, 6), "poisoned");
    assert.equal(bandFor(bands, 99), "poisoned", "over the top band still buys the top band");
    assert.equal(bandFor({}, 5), null);
});

test("an unresolved placeholder stays visible rather than becoming a literal value", () => {
    /* This is the property that mattered: with nothing to substitute, the text
     * comes back UNCHANGED — still recognisably a placeholder — so the guard in
     * resolveArgs can spot it. If it silently became "" the failure would be
     * invisible again, just differently. */
    assert.equal(resolveText("{band}", {}), "{band}");
    assert.equal(resolveText("{band}", { band: null }), "{band}");
    assert.equal(resolveText("{band}", { band: "stunned" }), "stunned");
});

test("every banded spell's bands are a ladder of numbers", () => {
    /* A non-numeric key can never be reached by bandFor. */
    return import("./spells/corpus.mjs").then(({ CORPUS }) => {
        for (const s of CORPUS) {
            if (s.frame?.cost?.mode !== "banded") continue;
            const keys = Object.keys(s.frame.cost.bands ?? {});
            assert.ok(keys.length, `${s.name} is banded but names no bands`);
            for (const k of keys) {
                assert.ok(Number.isFinite(Number(k)),
                    `${s.name} has band "${k}", which no spend can reach`);
            }
        }
    });
});

test("the band is resolved on the DIALOG path, not only the prompt path", async () => {
    /* `price` returns early when the cast dialog already supplied a cost —
     * which it always does in play — and that early return used to skip the
     * banded branch entirely. So `ctx.text.band` was never set, `{band}` stayed
     * literal, and the status was dropped as unknown. Every banded spell cast
     * the normal way did nothing.
     *
     * Asserted on the source because reaching `price` needs a whole context;
     * the behaviour it guards is covered live. */
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "frame.mjs"), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "");

    const early = src.indexOf("return ctx;\n    }\n\n    let cost;");
    assert.ok(early > 0, "price no longer has the declaration early-return — update this test");
    const beforeEarly = src.slice(0, early);
    assert.match(beforeEarly, /frame\.cost\.mode === "banded"/,
        "the declaration path must resolve the band before it returns");
    assert.match(beforeEarly, /ctx\.text\.band = bandFor\(/);
});
