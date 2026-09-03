/**
 * Loading a spell from the book has to leave the item CASTABLE.
 *
 * `startFromBook` wrote `system.magic.frame` and `system.magic.on` and nothing
 * else — but the cast dialog is shared with the original engine and reads
 * `system.staminaCost` / `system.variableCost`, not the frame. So a spell
 * loaded from the book arrived with the right cone, the right defence, the
 * right blocks, and a cost of ZERO: Aard was free, and the panel read "no
 * area" beside a 2m cone.
 *
 * Caught by doing it through the UI rather than writing `magic.on` directly,
 * which is how every earlier test had built its spells.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sheetFieldsFor, frameFor } from "./legacyFrame.mjs";
import { CORPUS, spellNamed } from "./spells/corpus.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("a frame written to the sheet reads back as the same frame", () => {
    /* The real property: sheetFieldsFor is the inverse of frameFor for
     * everything the sheet can hold. Anything that fails to round-trip is a
     * field the author will see one value for and the engine another. */
    const drift = [];
    for (const spell of CORPUS) {
        const fields = sheetFieldsFor(spell.frame);
        /* fields arrive as "system.x.y" paths — rebuild a system object */
        const sys = {};
        for (const [path, v] of Object.entries(fields)) {
            const parts = path.replace(/^system\./, "").split(".");
            let at = sys;
            while (parts.length > 1) at = (at[parts.shift()] ??= {});
            at[parts[0]] = v;
        }
        const back = frameFor(sys);
        const want = spell.frame;
        if (want.targeting?.mode === "area") {
            if (back.targeting.shape !== want.targeting.shape)
                drift.push(`${spell.name}: shape ${want.targeting.shape} -> ${back.targeting.shape}`);
            if (Number(back.targeting.size) !== Number(want.targeting.size))
                drift.push(`${spell.name}: size ${want.targeting.size} -> ${back.targeting.size}`);
        }
        if (want.cost?.mode === "fixed" && back.cost.amount !== want.cost.amount)
            drift.push(`${spell.name}: cost ${want.cost.amount} -> ${back.cost.amount}`);
        /* `stat` — "the creature's WILL x3" — has no field on the sheet at all.
         * It survives because `frameFor` spreads `system.magic.frame` LAST and
         * so the authored value wins; there is simply nothing to write. The
         * two spells that use it (Boiling Blood, Friend to Wild Kind) cast
         * correctly, they just cannot be described by the sheet alone. */
        if (want.defence?.type && want.defence.type !== "stat"
            && back.defence.type !== want.defence.type)
            drift.push(`${spell.name}: defence ${want.defence.type} -> ${back.defence.type}`);
    }
    assert.deepEqual(drift, [], "\n" + drift.join("\n"));
});

test("a variable-cost spell never writes a zero cost to the sheet", () => {
    /* Zero is what the dialog defaults to, and zero is what made Aard free. */
    for (const spell of CORPUS) {
        if (spell.frame?.cost?.mode !== "variable") continue;
        const f = sheetFieldsFor(spell.frame);
        assert.ok(f["system.staminaCost"] >= 1, `${spell.name} would load with a 0 cost`);
        assert.equal(f["system.variableCost"], true, `${spell.name} loses its variable cost`);
    }
});

test("Aard specifically loads as a 2m cone that costs something", () => {
    const f = sheetFieldsFor(spellNamed("Aard").frame);
    assert.equal(f["system.areaShape"], "cone");
    assert.equal(f["system.areaSize"], 2);
    assert.equal(f["system.variableCost"], true);
    assert.ok(f["system.staminaCost"] >= 1);
    assert.deepEqual(f["system.defense"], ["dodge"]);
});

test("startFromBook actually writes those fields", () => {
    const SRC = code(readFileSync(join(HERE, "canvas", "sheet.mjs"), "utf8"));
    assert.match(SRC, /sheetFields: sheetFieldsFor\(spell\.frame, spell\.on\)/,
        "the book load must pass the TREE too, or the damage fields stay blank");
});

test("the declared spend is clamped to the frame's band", () => {
    /* The shared dialog offers min="0" and no max, so both ends have to be
     * enforced where the law lives rather than where the input is drawn. */
    const SRC = code(readFileSync(join(HERE, "frame.mjs"), "utf8"));
    assert.match(SRC, /band\?\.mode === "variable"/);
    assert.match(SRC, /Math\.min\(Math\.max\(spend, min\), max\)/,
        "a variable cost must be clamped at BOTH ends — signs cap at 7");
    assert.match(SRC, /ctx\.vars\.sta = spend/, "the clamped value must be the one spent");
});

test("the authored frame outranks the sheet, so what it cannot express is not lost", () => {
    /* The guarantee that makes the exclusion above safe. */
    const sys = { defense: ["dodge"], staminaCost: 3,
                  magic: { frame: { defence: { type: "stat", stat: "will", multiplier: 3 } } } };
    assert.equal(frameFor(sys).defence.type, "stat",
        "system.magic.frame must win, or a stat defence written by the book load is lost");
});
