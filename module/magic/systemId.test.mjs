/**
 * The id this engine writes flags under must be the id Foundry knows.
 *
 * Foundry validates a flag scope against installed packages and throws on a
 * miss. Three files here carried the upstream system's id, so ~30 flag
 * operations raised at runtime — invisible to every other test in this suite,
 * because they all stub `getFlag` and a stub accepts any scope.
 *
 * So this test does not ask the engine what the id is. It reads system.json.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(readFileSync(join(HERE, "..", "..", "system.json"), "utf8"));
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function sources(dir = HERE, out = []) {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) { sources(full, out); continue; }
        if (entry.endsWith(".mjs") && !entry.endsWith(".test.mjs")) out.push(full);
    }
    return out;
}

test("the engine's SYSTEM_ID is the id in system.json", async () => {
    const { SYSTEM_ID } = await import("./systemId.mjs");
    assert.equal(SYSTEM_ID, MANIFEST.id,
        `flags would be written under "${SYSTEM_ID}" but Foundry knows this system as "${MANIFEST.id}"`);
});

test("no file under magic/ hardcodes a system id", () => {
    /* Any bare string that looks like a package id and is NOT the real one is
     * how the original bug got in — a fork renamed the system and three files
     * kept the old name. Everything must route through systemId.mjs. */
    const offenders = [];
    for (const file of sources()) {
        if (file.endsWith("systemId.mjs")) continue;
        const body = code(readFileSync(file, "utf8"));
        for (const m of body.matchAll(/["'`]([A-Za-z][A-Za-z0-9._-]{6,})["'`]/g)) {
            const s = m[1];
            if (s === MANIFEST.id) offenders.push(`${file}: literal "${s}" — import SYSTEM_ID instead`);
            if (/^TheWitcher/i.test(s)) offenders.push(`${file}: stale system id "${s}"`);
        }
    }
    assert.deepEqual(offenders, [], offenders.join("\n"));
});
