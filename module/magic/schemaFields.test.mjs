/**
 * The adapter may only read fields that exist on the item/actor schema.
 *
 * `system.isEquipped` is not a field on anything in this system — the base item
 * model declares `equipped`, and thirty-eight other places read that. The magic
 * adapter read `isEquipped` in two places, and neither was ever true:
 *
 *   - the FOCUS discount never came off a single cast, and
 *   - `ifTargetHas: "metalGear"` could never fire, so every spell gated on the
 *     target wearing metal quietly did nothing.
 *
 * Nothing threw. An absent field is `undefined`, `undefined` is falsy, and a
 * condition that is always false looks exactly like a condition that is simply
 * not met.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

function sources(dir = HERE, out = []) {
    for (const e of readdirSync(dir)) {
        const f = join(dir, e);
        if (statSync(f).isDirectory()) { sources(f, out); continue; }
        if (e.endsWith(".mjs") && !e.endsWith(".test.mjs")) out.push(f);
    }
    return out;
}

/* Names that look like item/actor fields but are not. Each one cost a real
 * behaviour; the list is the scar tissue. */
const NOT_FIELDS = Object.freeze({
    isEquipped:  "equipped",
    skillModifiers: "system.skills.<stat>.<skill>.modifier",
    pools:       "no pool store exists on the actor",
    modifiers:   "modifier (singular) on a stat"
});

test("magic/ reads no field the schema does not have", () => {
    const bad = [];
    for (const file of sources()) {
        const body = code(readFileSync(file, "utf8"));
        for (const [wrong, right] of Object.entries(NOT_FIELDS)) {
            const re = new RegExp(`system\\??\\.\\??${wrong}\\b`);
            if (re.test(body)) {
                bad.push(`${relative(HERE, file)}: system.${wrong} does not exist — use ${right}`);
            }
        }
    }
    assert.deepEqual(bad, [], "\n" + bad.join("\n"));
});

test("the item base model really does declare `equipped`", () => {
    /* If this ever moves, the check above is asserting against a memory. */
    const base = readFileSync(join(HERE, "..", "data", "item", "templates", "base.mjs"), "utf8");
    assert.match(base, /equipped:\s*new fields\.BooleanField/,
        "the field this test is named for has moved — re-derive NOT_FIELDS");
});
