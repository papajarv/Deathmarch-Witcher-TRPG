/**
 * Every module under magic/ must parse.
 *
 * This exists because a syntax error in adapter.mjs once passed the entire
 * 451-test suite. Nothing imports the adapter at test time — it reaches for
 * Foundry globals at module scope, so the tests deliberately avoid it and
 * assert against its SOURCE TEXT instead. Source-text assertions are happy to
 * match a file that could never load.
 *
 * `node --check` is the cheapest thing that would have caught it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function sources(dir = HERE, out = []) {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) { sources(full, out); continue; }
        if (entry.endsWith(".mjs")) out.push(full);
    }
    return out;
}

test("every .mjs under magic/ is syntactically valid", () => {
    const broken = [];
    for (const file of sources()) {
        try {
            execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
        } catch (e) {
            const msg = String(e.stderr ?? e.message).split("\n").find(l => /Error/.test(l)) ?? "parse failed";
            broken.push(`${relative(HERE, file)}: ${msg.trim()}`);
        }
    }
    assert.deepEqual(broken, [], "\n" + broken.join("\n"));
});

/* ── A choice reads as words, and branches on identity ───────────────────
 *
 * `localize` returns the KEY when there is no translation, so the old
 * `?? c` fallback never fired and a dropdown could offer
 * "WITCHER.Magic.Choice.searTheHolder". The bound value was the raw id either
 * way, so cards announced "The weather turns to lightningStorm".
 *
 * An author inventing a choice — the whole point of a block library — must not
 * have to add a lang key before the table can read it.
 */
test("a choice id is turned back into the words it was made from", async () => {
    const { localiseChoice } = await import("./choiceLabel.mjs");
    const none = { has: () => false, localize: (k) => k };
    /* Lower case: these are read mid-sentence ("the shape of a {shape}") far
     * more often than alone, and capitalising gave "a A serpent". */
    assert.equal(localiseChoice("searTheHolder", none), "sear the holder");
    assert.equal(localiseChoice("lightningStorm", none), "lightning storm");
    assert.equal(localiseChoice("dropIt", none), "drop it");
    const { forDisplay } = await import("./choiceLabel.mjs");
    assert.equal(forDisplay("lightning storm"), "Lightning storm", "a dropdown entry stands alone");
});

test("a translation wins over the fallback", async () => {
    const { localiseChoice } = await import("./choiceLabel.mjs");
    assert.equal(localiseChoice("dropIt",
        { has: (k) => k.endsWith("dropIt"), localize: () => "Let it fall" }), "Let it fall");
});

test("ifChoice branches on the id, not on how it is spelled for a reader", async () => {
    const { registerAll } = await import("./spells/harness.mjs");
    const { getBlock } = await import("./registry.mjs");
    registerAll();
    const ran = [];
    const ctx = {
        text: { mode: "Sear the holder" },          // the label a card would print
        control: { choices: { mode: "searTheHolder" } },  // the id it came from
        targets: [], vars: {}, created: [], adapter: {}
    };
    await getBlock("core:ifChoice").run(ctx, { bind: "mode", is: "searTheHolder", negate: false },
        { body: [], runBody: async () => ran.push("matched") });
    assert.deepEqual(ran, ["matched"], "the id matches even though the bound text is the label");

    await getBlock("core:ifChoice").run(ctx, { bind: "mode", is: "Sear the holder", negate: false },
        { body: [], runBody: async () => ran.push("label") });
    assert.deepEqual(ran, ["matched"], "and the label does NOT match — that would break on translation");
});

test("a choice label reads correctly wherever it appears", async () => {
    const { forDisplay, inSentence } = await import("./choiceLabel.mjs");
    /* The shipped translations are dropdown entries, and read wrong inside a
     * sentence: "You take the shape of a A serpent". */
    assert.equal(forDisplay("a serpent"), "A serpent", "alone, in a list");
    assert.equal(inSentence("A serpent"), "a serpent", "inside a sentence");
    assert.equal(inSentence("Make them drop it"), "make them drop it");
    /* And a name stays a name. */
    assert.equal(inSentence("DEX"), "DEX");
    assert.equal(inSentence("McGregor"), "McGregor");
});
