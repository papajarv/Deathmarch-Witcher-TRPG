// module/magic/sheetRender.test.mjs
//
// EXECUTING test for the spell sheet's context — without importing the sheet.
//
// The bug this exists to catch: I removed `ctx.statusRiderRows = …` and left
// the loop that walked it three lines below, so every spell sheet threw
// `statusRiderRows is not iterable` before the window could open. Greps for
// the assignment came back clean, because I had removed the assignment.
//
// The obvious way to catch that is to RUN `_prepareContext`. I tried, and it
// works — until it doesn't: `sheets/item/base.mjs` sits between two
// pre-existing import cycles (`config` ↔ `statusEffects`, `light-level` ↔
// `stealth-hooks`), and importing it outside Foundry resolves or throws
// depending on which module the loader reached first. That made this suite
// pass or fail on the order node happened to walk the directory in, which is a
// safety net that works on some days. Neither cycle is mine and neither fires
// under Foundry, whose entry point is main.mjs.
//
// So the same bug is caught statically instead: every `ctx.<key>` the method
// READS must be one it wrote, or one the base sheet supplies. That is exactly
// the invariant `statusRiderRows` broke, and it holds whatever order anything
// loads in.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { registerAll } from "./spells/harness.mjs";
import { canvasContext } from "./canvas/sheet.mjs";
import { authoredSummary, castStatus } from "./summary.mjs";

const SHEET = readFileSync(new URL("../sheets/item/base.mjs", import.meta.url), "utf8");

/** Source with comments removed. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * The spell sheet's `_prepareContext`, as source, WITHOUT its comments.
 *
 * This is the third test in this suite to fail on a comment that explains the
 * very bug it is checking for. A comment about `ctx.statusRiderRows` reads
 * exactly like a use of `ctx.statusRiderRows`, and a test that fails on its own
 * documentation is a test somebody deletes.
 */
function prepareBody() {
    const cls = code(SHEET).slice(code(SHEET).indexOf("class WitcherSpellSheet"),
                                 code(SHEET).indexOf("class WitcherHexSheet"));
    const at = cls.indexOf("async _prepareContext(options)");
    assert.ok(at > 0, "the spell sheet has no _prepareContext");
    let depth = 0, i = cls.indexOf("{", at);
    for (let j = i; j < cls.length; j++) {
        if (cls[j] === "{") depth++;
        else if (cls[j] === "}" && --depth === 0) return cls.slice(i, j + 1);
    }
    throw new Error("unbalanced _prepareContext");
}

/** What the BASE sheet puts on the context before the spell sheet sees it. */
const FROM_BASE = new Set([
    "source", "fields", "item", "document", "canEdit", "isEditable", "mode",
    "effects", "componentLinks", "enhancementSlots", "tabs", "buttons", "config"
]);

test.before(() => {
    /* `canvasContext` localises its empty state and its labels. Nothing else
     * here needs Foundry. */
    globalThis.game ??= { i18n: { localize: (k) => k.split(".").pop(), format: (k) => k } };
    globalThis.CONFIG ??= { statusEffects: [], WITCHER: { magic: {} } };
    registerAll();
});

/* ── The bug that shipped ────────────────────────────────────────────────── */

test("_prepareContext never reads a context key nothing sets", () => {
    const body = prepareBody();
    const written = new Set([...body.matchAll(/ctx\.(\w+)\s*=/g)].map(m => m[1]));
    const assigned = new Set([...body.matchAll(/Object\.assign\(ctx,\s*(\w+)/g)].map(m => m[1]));

    /* `\b` after the name, then check what follows separately — a lookahead
     * inside the capture ate the last letter of every key it found. */
    const read = [...body.matchAll(/ctx\.(\w+)\b(\s*=(?!=))?/g)]
        .filter(m => !m[2]).map(m => m[1]);
    const unset = [...new Set(read)]
        .filter(k => !written.has(k) && !FROM_BASE.has(k));

    assert.deepEqual(unset, [],
        `read but never set: ${unset.join(", ")} — this is how ` +
        `\`statusRiderRows is not iterable\` closed every spell sheet in the world`);
    assert.ok(assigned.size > 0, "the canvas context is merged in");
});

test("it sets the keys the template reads", () => {
    const body = prepareBody();
    const written = new Set([...body.matchAll(/ctx\.(\w+)\s*=/g)].map(m => m[1]));
    for (const key of ["authored", "schoolLabel", "formLabel", "tierLabel", "spellCfg"]) {
        assert.ok(written.has(key), `${key} never reaches the template`);
    }
});

/* ── The parts that CAN run, run ─────────────────────────────────────────── */

const legacy = (over = {}) => ({
    name: "Aenye",
    system: {
        staminaCost: 5, variableCost: false, castingTime: 1,
        defense: ["dodge", "block"], range: "12m",
        duration: { value: "", unit: "instant" },
        school: "fire", spellForm: "spell", spellType: "novice", targetType: "direct",
        effect: "<p>A ball of fire.</p>", magic: { frame: {}, on: {} },
        ...over
    }
});

test("every spell shape in the book builds a canvas", () => {
    const shapes = {
        "a legacy spell":  {},
        "a sign":          { spellForm: "sign", variableCost: true, staminaCost: 7 },
        "an invocation":   { spellForm: "invocation", school: "earth" },
        "an area spell":   { targetType: "area", areaShape: "cone", areaSize: 3 },
        "a self spell":    { targetType: "self", range: "Self" },
        "a maintained":    { duration: { unit: "rounds", value: "Active (2 STA)" } },
        "undefended":      { defense: [] },
        "no duration":     { duration: undefined },
        "no defence":      { defense: undefined },
        "no magic block":  { magic: undefined }
    };
    for (const [label, over] of Object.entries(shapes)) {
        const ctx = canvasContext(legacy(over), {});
        assert.ok(ctx.canvasHTML?.includes("wm-canvas"), `${label} produced no canvas`);
        assert.ok(Array.isArray(ctx.entryChoices), `${label} offered no triggers`);
    }
});

test("an unprogrammed spell reports no behaviour and still offers a way in", () => {
    const item = legacy();
    assert.equal(authoredSummary(item.system.magic, item.name).any, false);
    assert.equal(castStatus(item.system.magic, item.name).state, "legacy");
    assert.ok(canvasContext(item, {}).entryChoices.length > 0);
});

test("a programmed spell reports its blocks", () => {
    const item = legacy({ magic: { frame: {}, on: { hit: [{ b: "core:dealDamage", a: { formula: "4d6" } }] } } });
    const sum = authoredSummary(item.system.magic, item.name);
    assert.equal(sum.any, true);
    assert.match(sum.badge, /1 block · 1 trigger/);
    assert.equal(castStatus(item.system.magic, item.name).state, "live");
});

test("the frame shown is derived from the spell's own fields", () => {
    const html = canvasContext(legacy({ staminaCost: 12, range: "30m" }), {}).canvasHTML;
    assert.match(html, /12/);
    assert.match(html, /30m/);
});

test("`Dodge or Block` reaches the panel as two toggles, both lit", () => {
    const html = canvasContext(legacy({ defense: ["dodge", "block"] }), {}).canvasHTML;
    assert.equal((html.match(/wm-toggle is-on/g) ?? []).length, 2);
});
