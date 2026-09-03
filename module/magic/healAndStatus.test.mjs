/**
 * Two things the engine reported doing and did not do.
 *
 * HEALING. `adapter.heal` routed healing as NEGATIVE damage through
 * `emitApplyDamage`, on the reasoning that hurting and healing are one pipeline
 * pointed opposite ways. They are not: neither the damage calculator nor the GM
 * handler understands a "healing" type or a negative amount, so every point was
 * clamped away. `core:healHealth` had never restored a hit point — and the chat
 * card said "recovers 2" every time.
 *
 * STATUSES. The GM handler DROPS an id the world does not register, with a
 * console warning nobody reads, and the block pushed to `ctx.created` anyway —
 * so the card announced a status that was never applied, and a lifetime was
 * left waiting to remove an effect that had never existed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerAll } from "./spells/harness.mjs";
import { getBlock } from "./registry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const ADAPTER = code(readFileSync(join(HERE, "adapter.mjs"), "utf8"));
const SOCKET  = code(readFileSync(join(HERE, "..", "setup", "socketHook.mjs"), "utf8"));

registerAll();

test("healing does not travel as negative damage", () => {
    assert.doesNotMatch(ADAPTER, /amount: -Math\.abs\(amount\)/,
        "healing is being sent through the damage pipeline again");
    assert.match(ADAPTER, /emitHealActor\(\{ targetUuid: target\?\.uuid, amount: Math\.abs\(amount\) \}\)/);
});

test("the heal handler exists, goes through the GM, and clamps to max", () => {
    assert.match(SOCKET, /export function emitHealActor/);
    assert.match(SOCKET, /case "healActor": return handleHealActor\(data\);/,
        "the socket message has no handler, so a player's heal goes nowhere");
    assert.match(SOCKET, /Math\.min\(\(Number\(hp\.value\) \|\| 0\) \+ Math\.max\(0, Math\.floor\(amount\)\),\s*Number\(hp\.max\) \|\| 0\)/,
        "a heal must clamp to max rather than overshoot it");
});

test("a status that did not apply is not reported as applied", async () => {
    const seen = [];
    const ctx = {
        actor: { name: "C" }, item: { name: "S" },
        targets: [{ actor: { name: "T" }, hit: true }],
        record: { castId: "x" }, vars: {}, created: [], control: {}, frame: {},
        adapter: {
            applyStatus: async (_t, id) => { seen.push(id); return id !== "notAStatus"; },
            removeStatus: async () => {}
        }
    };
    const blk = getBlock("core:applyStatus");

    await blk.run(ctx, { status: "notAStatus", until: "rounds", value: "1" }, {});
    assert.equal(seen.at(-1), "notAStatus", "the adapter should still be asked");
    assert.deepEqual(ctx.created, [], "a dropped status must not be reported on the card");

    await blk.run(ctx, { status: "prone", until: "rounds", value: "1" }, {});
    assert.equal(ctx.created.length, 1, "a status that DID apply must still be recorded");
    assert.equal(ctx.created[0].status, "prone");
});

test("an adapter that answers nothing is taken at its word", () => {
    /* Existing stubs return undefined; only an explicit `false` means dropped. */
    assert.match(code(readFileSync(join(HERE, "blocks", "core.mjs"), "utf8")),
        /if \(applied === false\) continue;/);
});

test("applyStatus checks the id against what the world registers", () => {
    assert.match(ADAPTER, /const known = \(CONFIG\.statusEffects \?\? \[\]\)\.some\(s => s\.id === id\);/);
    assert.match(ADAPTER, /if \(!known\) \{/);
});
