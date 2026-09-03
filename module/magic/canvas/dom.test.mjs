// module/magic/canvas/dom.test.mjs
//
// EXECUTING test for the markup and the stylesheet.
//
// The canvas renders to strings, so its output is checkable here rather than
// by launching a game. The stylesheet is checked too — the theming bug this
// guards against produces a page that renders one theme's text on the other
// theme's background, and it is invisible until somebody with the other
// setting opens it.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { registerAll } from "../spells/harness.mjs";
import { palette } from "./palette.mjs";
import { entrySpec, nodeSpec, frameSummary } from "./render.mjs";
import { entryHTML, blockHTML, railHTML, lawHTML } from "./dom.mjs";
import { entryOptions } from "./legality.mjs";
import { CORPUS } from "../spells/corpus.mjs";
import { QUEN } from "../spells/signs.mjs";
import { STAMMELFORDS_EARTHQUAKE } from "../spells/earth.mjs";
import { TRYFERI_GAEAF } from "../spells/water.mjs";

/* The stylesheet lives in `styles/` because that is where system.json loads it
 * from, and one copy is the whole point — a second in this directory would be
 * the same drift the engine keeps being rebuilt to avoid. */
const CSS = readFileSync(new URL("../../../styles/spell-canvas.css", import.meta.url), "utf8");
const LABELS = Object.fromEntries(entryOptions().map(e => [e.id, e.label]));
const SCOPES = Object.fromEntries(entryOptions().map(e => [e.id, e.scope]));

/**
 * The stylesheet with its comments removed.
 *
 * Every assertion about what the CSS DOES uses this. Four separate tests in
 * this suite have now failed on a comment explaining the very bug they check
 * for — a note about `flex-shrink: 1` reads exactly like a use of it — and a
 * test that fails on its own documentation is a test somebody deletes.
 */
const cssCode = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "");

test.before(registerAll);

const renderEntry = (entry, tree) =>
    entryHTML(entrySpec(entry, tree, { label: LABELS[entry], scope: SCOPES[entry] }));

/* ── Every entry in the corpus renders ───────────────────────────────────── */

test("every authored tree in the corpus renders to markup", () => {
    for (const spell of CORPUS) {
        for (const [entry, tree] of Object.entries(spell.on)) {
            const html = renderEntry(entry, tree);
            assert.ok(html.includes("wm-stack"), `${spell.name}.${entry}`);
            assert.ok(!html.includes("undefined"), `${spell.name}.${entry} leaked undefined`);
            assert.ok(!html.includes("[object Object]"), `${spell.name}.${entry} leaked an object`);
        }
    }
});

test("no authored value escapes unescaped", () => {
    const html = blockHTML(nodeSpec({ b: "core:narrate", a: { what: `<script>x</script> & "q"` } }, {}));
    assert.ok(!html.includes("<script>"));
    assert.ok(html.includes("&lt;script&gt;"));
    assert.ok(html.includes("&amp;"));
});

test("every block carries the address the drag layer needs", () => {
    const html = renderEntry("hit", STAMMELFORDS_EARTHQUAKE.on.hit);
    assert.match(html, /data-at="\|0"/, "top-level block");
    assert.match(html, /data-at="0\.body\|0"/, "and one nested inside a gate");
});

/* ── The shapes read as shapes ───────────────────────────────────────────── */

test("a gate wraps its body between two arms", () => {
    const html = blockHTML(nodeSpec(STAMMELFORDS_EARTHQUAKE.on.hit[0], { index: 0 }));
    assert.ok(html.includes("wm-gate"), "opens as a gate");
    assert.ok(html.includes("wm-body"), "with a body between");
    assert.ok(html.includes("wm-gate-foot"), "and closes underneath");
});

test("a deferred block is marked, because its body does not run here", () => {
    const html = blockHTML(nodeSpec({ b: "core:createZone", a: {}, body: [] }, {}));
    assert.ok(html.includes("wm-gate--deferred"));
    assert.ok(html.includes("later"), "and says so on the block itself");
});

test("an empty gate says something specific to what it is", () => {
    // "Drop blocks here" is true of every gate and therefore tells nobody
    // anything.
    const deferred = blockHTML(nodeSpec({ b: "core:createZone", a: {}, body: [] }, {}));
    const plain    = blockHTML(nodeSpec({ b: "core:ifPercentile", a: {}, body: [] }, {}));
    assert.match(deferred, /run later, for whoever this catches/);
    assert.match(plain,    /run when this holds/);
});

test("a stack block never grows a body", () => {
    const html = blockHTML(nodeSpec({ b: "core:dealDamage", a: {} }, {}));
    assert.ok(!html.includes("wm-body"));
    assert.ok(!html.includes("wm-gate"));
});

/* ── Arguments are visible and reachable ─────────────────────────────────── */

test("an expression slot is typeset as code, because it is code", () => {
    const html = blockHTML(nodeSpec(
        { b: "core:grantModifier", a: { stat: "spd", delta: "-min(4,1+floor(({sta}-1)/2))" } }, {}));
    assert.match(html, /data-control="expression"/);
    assert.ok(html.includes("min(4,1+floor(({sta}-1)/2))"), "shown verbatim, not summarised");
});

test("an argument outside the label is still on screen", () => {
    const html = blockHTML(nodeSpec(
        { b: "core:createObject", a: { what: "rockWall", hp: "60", sp: "30" } }, {}));
    assert.ok(html.includes("wm-extras"), "extras rail exists");
    assert.ok(html.includes("30"), "and the SP is on it");
});

test("an empty slot shows what it wants rather than nothing", () => {
    const html = blockHTML(nodeSpec({ b: "core:applyStatus", a: {} }, {}));
    assert.ok(html.includes("wm-slot--empty"));
});

/* ── Hats ────────────────────────────────────────────────────────────────── */

test("a trigger says WHEN it fires, on the hat itself", () => {
    // "Add a trigger" explained nothing, and neither did a hat reading
    // "you already have targets" — that answers which blocks fit, not the
    // question somebody reading a spell is asking.
    const cast = entryHTML(entrySpec("hit", [], {
        label: "When it hits", scope: ["caster", "targets"], hint: "the target failed to defend" }));
    assert.match(cast, /the target failed to defend/);
    assert.match(cast, /title="you already have targets"/, "the scope survives as a tooltip");
});

test("an empty trigger says what would go in it", () => {
    const html = entryHTML(entrySpec("onExpire", [], {
        label: "When it ends", scope: ["caster"], hint: "it runs out or is dispelled" }));
    assert.match(html, /blocks here run it runs out or is dispelled/);
});

test("an entry says what it hands the blocks under it", () => {
    const cast = renderEntry("hit", []);
    const ward = renderEntry("takeDamage", []);
    assert.match(cast, /you already have targets/);
    assert.match(ward, /an attack is in flight/);
});

test("an item with two entry points renders two hats", () => {
    const html = Object.entries(QUEN.on).map(([e, t]) => renderEntry(e, t)).join("");
    assert.equal((html.match(/wm-hat-title/g) ?? []).length, 2);
});

/* ── The law panel ───────────────────────────────────────────────────────── */

test("the frame panel is the ONE place these settings live", () => {
    // They used to sit here as read-only prose and again as a form below the
    // canvas — cost, range, defence, element, duration, twice each. That is
    // not redundancy with the block engine; it is redundancy with itself, and
    // meeting the same eight settings twice on one sheet is most of why the
    // sheet felt overwhelming.
    const item = { name: "Tryferi Gaeaf", system: { staminaCost: 22, range: "20m" } };
    const html = lawHTML(item, frameSummary(TRYFERI_GAEAF.frame), null, {});
    for (const field of ["system.staminaCost", "system.range", "system.defense",
                         "system.school", "system.duration.unit", "system.targetType"]) {
        assert.ok(html.includes(`name="${field}"`), `${field} is not editable here`);
    }
    assert.ok(html.includes("Tryferi Gaeaf"));
});

test("the frame is still not DRAGGABLE — it is law, not behaviour", () => {
    // Editable and authorable are different. An author sets the cost; they
    // cannot compose it out of blocks, and they cannot delete it.
    const html = lawHTML({ name: "X", system: {} }, [], null, {});
    assert.ok(!html.includes("draggable"));
    assert.ok(!html.includes("wm-blk"));
});

test("defence is a multi-select, because the DEFENDER chooses", () => {
    // `Dodge or Block` is one decision offered to the target, not two rolls.
    const html = lawHTML({ name: "X", system: { defense: ["dodge", "block"] } }, [], null,
        { defences: [{ value: "dodge", label: "Dodge" }, { value: "block", label: "Block" },
                     { value: "resistmagic", label: "Resist Magic" }] });
    assert.equal((html.match(/name="system\.defense"/g) ?? []).length, 3);
    // Counted on the DEFENCE boxes only — the cost mode has a checked radio of
    // its own, and a bare `checked` count silently measured both.
    const boxes = html.match(/<input type="checkbox" name="system\.defense"[\s\S]*?>/g) ?? [];
    assert.equal(boxes.filter(b => b.includes("checked")).length, 2);
});

test("the area row appears only for an area spell", () => {
    const direct = lawHTML({ name: "X", system: { targetType: "direct" } }, [], null, {});
    const area   = lawHTML({ name: "X", system: { targetType: "area" } }, [], null, {});
    assert.ok(!direct.includes("system.areaShape"), "no shape row on a single-target spell");
    assert.ok(area.includes("system.areaShape"));
});

test("what the engine MAKES of the settings is tucked away, not repeated", () => {
    // The facts are the one thing an author cannot work out by reading the
    // boxes — a maintained spell's upkeep, a sign's 7-STA cap. Worth keeping,
    // not worth putting above the controls that produce them.
    const html = lawHTML({ name: "X", system: {} }, frameSummary({}), null, {});
    assert.ok(html.includes("wm-law-reads"));
    assert.ok(html.indexOf("wm-law-fields") < html.indexOf("wm-facts"));
});

/* ── The look, where it carries meaning ──────────────────────────────────── */

test("the canvas paints no background of its own", () => {
    // A grid pattern was meant to read as a surface you place things on. Over
    // the sheet's own ground it read as a green mesh, and the blocks already
    // look like objects without help from the background.
    const CSS = readFileSync(new URL("../../../styles/spell-canvas.css", import.meta.url), "utf8");
    assert.equal((CSS.match(/background-image/g) ?? []).length, 0, "a pattern is back");
    const lean = CSS.slice(CSS.indexOf(".wm-canvas.is-lean {"));
    assert.match(lean.slice(0, 600), /background: transparent/);
});

test("defence is ONE control with several states, not four checkboxes", () => {
    // A spell can offer more than one and the DEFENDER chooses between them.
    // A wrapping list of checkboxes reads as four independent settings, wraps
    // raggedly, and hides that picking none is the commonest case.
    const html = lawHTML({ name: "X", system: { defense: ["dodge", "block"] } }, [], null, {});
    assert.match(html, /wm-toggle-row/);
    assert.equal((html.match(/class="wm-toggle is-on"/g) ?? []).length, 2);
    assert.equal((html.match(/type="checkbox" name="system\.defense"/g) ?? []).length, 4,
        "still real checkboxes underneath, so the form submits normally");
});

test("an undefended spell says what that MEANS", () => {
    // 52 of the 103 core entries are `Defense: None`, and the rules define
    // them as still answerable by Dispel or Heliotrope. It is a choice with a
    // consequence, not an omission.
    const none = lawHTML({ name: "X", system: { defense: [] } }, [], null, {});
    const some = lawHTML({ name: "X", system: { defense: ["dodge"] } }, [], null, {});
    assert.match(none, /Dispel and Heliotrope are always offered/);
    assert.ok(!some.includes("wm-toggle-note"), "and stays quiet once something is picked");
});

test("the multi-part rows get the full width, marked explicitly", () => {
    // Cost (a number and a mode), targeting (a mode, a shape and a size),
    // defence (four toggles) and duration (a value and a unit) each hold more
    // than one control, and a column break through the middle of any of them
    // reads as two settings.
    //
    // Marked, not inferred with `:has()` — this codebase already carries a
    // note about Chromium's `:has()` invalidation being unreliable, and a
    // layout that silently stops spanning is not worth the cleverness.
    const html = lawHTML({ name: "X", system: {} }, [], null, {});
    assert.equal((html.match(/wm-law-row is-wide/g) ?? []).length, 4);
});

test("the shape lives beside the control that reveals it", () => {
    // "How do I make Aard a 2m cone" had no findable answer: shape and size
    // only existed once Targeting was set to "an area", in a separate row
    // further down that nobody had reason to look for.
    const direct = lawHTML({ name: "X", system: { targetType: "direct" } }, [], null, {});
    const area   = lawHTML({ name: "X", system: { targetType: "area", areaShape: "cone", areaSize: 2 } }, [], null, {});

    assert.ok(!direct.includes("system.areaShape"), "no shape on a single-target spell");

    /* Same row, not a new one — the count of rows does not change. */
    assert.equal((area.match(/wm-law-key/g) ?? []).length,
                 (direct.match(/wm-law-key/g) ?? []).length,
                 "the shape opened a whole new row instead of appearing inline");
    const row = area.slice(area.indexOf("system.targetType"));
    assert.ok(row.indexOf("system.areaShape") < row.indexOf("system.defense"),
        "the shape is in the targeting row, not somewhere below");
    assert.match(area, /wm-law-suffix">m</, "and the size says what unit it is in");
});

test("a trigger's label can wrap instead of running out of its box", () => {
    // `minmax(14em, 1fr)` was the bug: "When an attack comes at you" does not
    // fit on one line at 14em, and nowrap sent it straight through the border.
    const CSS = readFileSync(new URL("../../../styles/spell-canvas.css", import.meta.url), "utf8");
    const list = CSS.slice(CSS.indexOf(".wm-trigger-list"), CSS.indexOf("}", CSS.indexOf(".wm-trigger-list")));
    assert.match(list, /minmax\(min\(100%, 1[6-9]em\), 1fr\)/, "wide enough, and never wider than the row");
    for (const cls of [".wm-trigger-name", ".wm-trigger-when"]) {
        const rule = CSS.slice(CSS.indexOf(cls), CSS.indexOf("}", CSS.indexOf(cls)));
        assert.match(rule, /overflow-wrap: anywhere/, `${cls} can still overflow`);
    }
});

test("a long spell name cannot run out of the picker", () => {
    // The name and the tier used to sit side by side, competing for one line
    // in a 360px dialog, and "Stammelford's Earthquake" simply left the box.
    // Truncating is not an answer either: the name is the entire reason the
    // row exists, and an ellipsis in a list of similar names is unreadable.
    const CSS = readFileSync(new URL("../../../styles/spell-canvas.css", import.meta.url), "utf8");
    const row = CSS.slice(CSS.indexOf("body.witcher-ttrpg-death-march .wm-book-row {"));
    const rule = row.slice(0, row.indexOf("}"));
    assert.match(rule, /flex-direction: column/, "the name and tier still compete for a line");
    assert.match(rule, /min-width: 0/, "a flex item's automatic minimum lets it grow past its parent");

    const name = CSS.slice(CSS.indexOf(".wm-book-name {"));
    assert.match(name.slice(0, name.indexOf("}")), /overflow-wrap: anywhere/);
    assert.doesNotMatch(name.slice(0, name.indexOf("}")), /text-overflow: ellipsis/,
        "a picker that hides which spell this is has no purpose");
});

test("a row in a scrolling list can never be squashed", () => {
    // THE bug in the screenshot: `.wm-book-list` is a flex column with a
    // bounded height, and a flex item defaults to `flex-shrink: 1`. With a
    // hundred rows in it every row was compressed below its own content, and
    // its two lines drew on top of the next row. The list is what scrolls.
    const CSS = readFileSync(new URL("../../../styles/spell-canvas.css", import.meta.url), "utf8");
    for (const sel of [".wm-book-row", ".wm-chip", ".wm-trigger-option"]) {
        const at = CSS.indexOf(`body.witcher-ttrpg-death-march ${sel} {`);
        assert.ok(at > 0, `${sel} has no scoped rule`);
        const rule = CSS.slice(at, CSS.indexOf("}", at));
        assert.match(rule, /flex: 0 0 auto/, `${sel} will squash inside a bounded list`);
    }
    assert.doesNotMatch(cssCode(CSS), /flex-shrink: 1/,
        "a reset telling controls they may shrink is an instruction to squash");
});

test("no rule was folded into its neighbour's selector list", () => {
    // An earlier edit removed one selector from a group and left `.wm-chip`
    // attached to the rule below it — so chips silently took the trigger
    // option's styles and lost their own truncation.
    const CSS = readFileSync(new URL("../../../styles/spell-canvas.css", import.meta.url), "utf8");
    const stripped = cssCode(CSS);
    for (const m of stripped.matchAll(/([^{}]*)\{[^{}]*\}/g)) {
        assert.doesNotMatch(m[1].trim(), /,$/, `selector ends in a comma: ${m[1].trim().slice(-60)}`);
    }
});

test("min-width: 0 is set the whole way down the picker", () => {
    // A flex item defaults to `min-width: auto`, which means "never shrink
    // below your content" — so one long row widens the list, the list widens
    // the dialog, and every child that asked to truncate was overruled from
    // above.
    const CSS = readFileSync(new URL("../../../styles/spell-canvas.css", import.meta.url), "utf8");
    for (const sel of [".wm-book-dialog .window-content", ".wm-book {", ".wm-book-list {", ".wm-book-row {"]) {
        const at = CSS.indexOf(sel);
        assert.ok(at > 0, `${sel} is missing`);
        assert.match(CSS.slice(at, CSS.indexOf("}", at)), /min-width: 0/, `${sel} breaks the chain`);
    }
});

/* ── Contrast ────────────────────────────────────────────────────────────
 * A selected defence toggle came out grey on amber and was barely readable,
 * for two independent reasons: the `<span>` inside the label never inherited
 * the colour, and the colour itself was hard-coded near-black — fine on the
 * dark theme's light brass, and near-black-on-near-black once the light theme
 * darkens brass to hold on parchment.
 *
 * Both are the sort of thing you only notice on the theme you do not use. */

const relLuminance = (hex) => {
    const ch = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
};
const contrast = (a, b) => {
    const [hi, lo] = [relLuminance(a), relLuminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
};

/** A token's value in a given theme block. */
function token(css, name, theme) {
    const block = theme === "light"
        ? css.slice(css.indexOf(":root {"), css.indexOf("@media (prefers-color-scheme"))
        : css.slice(css.indexOf(':root[data-theme="dark"]'));
    const m = block.match(new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`));
    return m?.[1] ?? null;
}

test("text on a brass fill is readable in BOTH themes", () => {
    const CSS = readFileSync(new URL("../../../styles/spell-canvas.css", import.meta.url), "utf8");
    for (const theme of ["light", "dark"]) {
        const brass = token(CSS, "--wm-brass", theme);
        const ink = token(CSS, "--wm-on-brass", theme);
        assert.ok(brass && ink, `${theme}: tokens missing`);
        const ratio = contrast(brass, ink);
        assert.ok(ratio >= 4.5,
            `${theme}: ${ink} on ${brass} is ${ratio.toFixed(2)}:1 — WCAG AA wants 4.5`);
    }
});

test("nothing hard-codes the on-brass colour any more", () => {
    // It was written into five rules, which is five places to get one of the
    // themes wrong.
    const CSS = readFileSync(new URL("../../../styles/spell-canvas.css", import.meta.url), "utf8");
    const rules = CSS.slice(CSS.indexOf(":root[data-theme=\"dark\"]"));
    assert.ok(!/color:\s*#1B1509/.test(rules), "a literal on-brass colour survives");
});

test("a selected toggle passes its colour to the text inside it", () => {
    // The label set a colour; the span inside inherited from the surrounding
    // chrome instead, which is what made it grey.
    const CSS = readFileSync(new URL("../../../styles/spell-canvas.css", import.meta.url), "utf8");
    assert.match(CSS, /\.wm-toggle\.is-on > span \{ color: var\(--wm-on-brass\); \}/);
    assert.match(CSS, /\.wm-toggle > span \{ color: inherit; \}/);
});

/* ── The rail is the registry ────────────────────────────────────────────── */

test("the rail offers every registered block, dimming rather than hiding", () => {
    const groups = palette();
    const all = groups.flatMap(g => g.blocks);
    const html = railHTML(groups, new Set(["core:deflect"]));
    for (const b of all) assert.ok(html.includes(`data-block="${b.id}"`), b.id);
    assert.match(html, /data-block="core:deflect"\s+data-dim="true"/);
});

test("a block that wraps says so in the rail, before it is dragged", () => {
    const html = railHTML(palette(), new Set());
    assert.ok(html.includes("wraps"));
});

/* ── The stylesheet ──────────────────────────────────────────────────────── */

test("every theme token is defined on bare :root first", () => {
    // A colour whose only definition sits behind a media query or a [data-theme]
    // stamp never applies in the default "system" state, and the page renders
    // one theme's text on the other theme's ground.
    const base = CSS.slice(CSS.indexOf(":root {"), CSS.indexOf("@media (prefers-color-scheme"));
    const declared = new Set([...base.matchAll(/--wm-[\w-]+/g)].map(m => m[0]));
    const used = new Set([...CSS.matchAll(/var\((--wm-[\w-]+)/g)].map(m => m[1]));
    for (const token of used) assert.ok(declared.has(token), `${token} has no light-mode definition`);
});

test("all three theme states are handled", () => {
    assert.ok(CSS.includes("@media (prefers-color-scheme: dark)"), "system default");
    assert.ok(CSS.includes(':root:not([data-theme="light"])'), "an explicit light choice beats a dark OS");
    assert.ok(CSS.includes(':root[data-theme="dark"]'), "and the toggle wins the other way too");
});

test("the body paints its own ground rather than borrowing the host's", () => {
    assert.match(CSS, /\.wm-canvas\s*\{[^}]*background:\s*var\(--wm-ground\)/);
});

test("motion is optional", () => {
    assert.ok(CSS.includes("prefers-reduced-motion"));
});

test("wide content scrolls inside itself, not the page", () => {
    assert.match(CSS, /\.wm-sheet\s*\{[^}]*overflow-x:\s*auto/);
});
