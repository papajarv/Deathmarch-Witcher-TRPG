/**
 * A deferred body must be handed somebody to act on.
 *
 * `core:afterRounds` declared `provides: ["targets"]` — which is what tells the
 * validator that effect blocks are legal inside it — and then deferred its body
 * with `targets: []`. Every block in that body loops over `ctx.targets`, so a
 * delayed effect was accepted by the canvas, saved, scheduled, fired on time,
 * and touched no one. `core:repeatEachRound`, written the same week, carries
 * the cast's targets forward correctly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { registerAll } from "./spells/harness.mjs";
import { allBlocks, SHAPE } from "./registry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
registerAll();

test("no deferred block hands its body an empty target list", () => {
    /* Literally `targets: []` inside a block file — the shape of the bug. */
    const bad = [];
    for (const f of readdirSync(join(HERE, "blocks"))) {
        if (!f.endsWith(".mjs")) continue;
        const src = code(readFileSync(join(HERE, "blocks", f), "utf8"));
        if (/targets:\s*\[\s*\]/.test(src)) bad.push(`blocks/${f}`);
    }
    assert.deepEqual(bad, [], "\n" + bad.join("\n") +
        "\na deferred body with no targets can never affect anyone");
});

test("every block that promises targets to its body actually passes some", () => {
    const src = readdirSync(join(HERE, "blocks"))
        .filter(f => f.endsWith(".mjs"))
        .map(f => code(readFileSync(join(HERE, "blocks", f), "utf8"))).join("\n");
    for (const b of allBlocks()) {
        if (b.shape !== SHAPE.DEFERRED) continue;
        if (!(b.provides ?? []).includes("targets")) continue;
        const name = b.id.split(":")[1];
        const at = src.indexOf(`id: "${b.id}"`);
        assert.ok(at >= 0, `${b.id} not found in source`);
        const body = src.slice(at, at + 2000);
        assert.match(body, /targets/,
            `${b.id} promises targets to its body and never mentions them in run()`);
        assert.doesNotMatch(body, /targets:\s*\[\s*\]/,
            `${b.id} promises targets and hands over an empty list — ${name} can never affect anyone`);
    }
});
