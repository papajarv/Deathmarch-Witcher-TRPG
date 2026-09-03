/**
 * The canvas must not offer a trigger nothing can fire.
 *
 * All eleven ENTRY_SCOPE keys were in the dropdown. Five of them were never
 * published anywhere, so a GM could pick one, build a body, save it, and watch
 * it do nothing with no way to find out why. Two of those are now wired
 * (`aborted`, `incomingMagic`); three still need the weapon pipeline.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { entryOptions, UNFIRED_ENTRIES } from "./canvas/legality.mjs";
import { ENTRY_SCOPE } from "./registry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function sources(dir = HERE, out = []) {
    for (const e of readdirSync(dir)) {
        const f = join(dir, e);
        if (statSync(f).isDirectory()) { sources(f, out); continue; }
        if (e.endsWith(".mjs") && !e.endsWith(".test.mjs")) out.push(f);
    }
    return out;
}
const ALL = sources().map(f => code(readFileSync(f, "utf8"))).join("\n");

test("every offered trigger has something that fires it", () => {
    for (const { id } of entryOptions()) {
        /* Cast outcomes are dispatched by name off the outcome; the rest have
         * to be published onto the bus by somebody. */
        const dispatched = ["hit", "miss", "success", "fumble"].includes(id)
            || new RegExp(`OUTCOME\\.${id.toUpperCase()}`).test(ALL)
            || new RegExp(`ENTRY\\.[A-Z_]*\\b`).test(ALL) && publishes(id)
            || id === "onExpire" && /runExpiryTree/.test(ALL);
        assert.ok(dispatched, `the canvas offers "${id}" and nothing fires it`);
    }
});

function publishes(entry) {
    /* publish(ENTRY.X, ...) with X being the SCREAMING_SNAKE of the entry. */
    const snake = entry.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
    return new RegExp(`publish\\(\\s*ENTRY\\.${snake}\\b`).test(ALL);
}

test("the unfired triggers are declared, not silently dropped", () => {
    for (const id of UNFIRED_ENTRIES) {
        assert.ok(id in ENTRY_SCOPE, `${id} must stay valid so authored trees still load`);
        assert.ok(!entryOptions().some(e => e.id === id), `${id} is still offered`);
        assert.ok(entryOptions({ includeUnfired: true }).some(e => e.id === id),
            `${id} must still be renderable for a tree already authored under it`);
    }
});

test("aborted and incomingMagic are actually wired now", () => {
    assert.match(ALL, /OUTCOME\.ABORTED\]/, "nothing looks up an aborted tree");
    assert.match(ALL, /offerMagicInterception\(/, "incomingMagic's publisher still has no caller");
    assert.ok(entryOptions().some(e => e.id === "aborted"));
    assert.ok(entryOptions().some(e => e.id === "incomingMagic"));
});
