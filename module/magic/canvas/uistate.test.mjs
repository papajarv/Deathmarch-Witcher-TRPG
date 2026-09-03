// module/magic/canvas/uistate.test.mjs
//
// EXECUTING test for what survives a re-render.
//
// Every edit writes to the document and rebuilds the DOM. Without this, the
// palette popover you are picking from snaps shut, the panel you opened folds,
// the list jumps to the top, and the select you just changed loses focus — so
// choosing three things in a row means opening the same panel three times.

import test from "node:test";
import assert from "node:assert/strict";

import { captureUI, restoreUI, focusPath } from "./uistate.mjs";

/* A DOM small enough to reason about and real enough to test against. */
function fakeRoot(spec = {}) {
    const nodes = [];
    const make = (cls, extra = {}) => {
        const el = {
            className: cls, open: false, scrollTop: 0, dataset: {}, _attrs: {},
            getAttribute: (k) => el._attrs[k] ?? null,
            querySelector: (s) => el._children?.find(c => matches(c, s)) ?? null,
            focus() { el.focused = true; },
            setSelectionRange(a, b) { el.range = [a, b]; },
            closest: (s) => (matches(el, s) ? el : el._parent && el._parent.closest?.(s)) ?? null,
            ...extra
        };
        nodes.push(el);
        return el;
    };
    const matches = (el, s) => {
        if (s.startsWith("details.")) return el.className === s.slice(8) && el.isDetails;
        if (s.startsWith(".")) return el.className === s.slice(1);
        const m = s.match(/^\[(\w[\w-]*)="(.*)"\]$/);
        return m ? el._attrs[m[1]] === m[2] || el.dataset[camel(m[1])] === m[2] : false;
    };
    const camel = (a) => a.replace(/^data-/, "").replace(/-(\w)/g, (_, c) => c.toUpperCase());

    for (const [cls, open] of Object.entries(spec.details ?? {})) {
        const el = make(cls); el.isDetails = true; el.open = open;
        if (cls === "wdm-cfg-collapse") {
            const title = make("wdm-cfg-collapse-title", { textContent: spec.title ?? "Behaviour" });
            el._children = [title];
        }
    }
    for (const [cls, top] of Object.entries(spec.scroll ?? {})) make(cls).scrollTop = top;
    for (const f of spec.fields ?? []) {
        const el = make("field"); el._attrs.name = f.name;
        el.value = f.value; el.selectionStart = f.start; el.selectionEnd = f.end;
    }

    return {
        nodes,
        contains: () => true,
        querySelectorAll: (s) => nodes.filter(n => matches(n, s)),
        querySelector: (s) => nodes.find(n => matches(n, s)) ?? null
    };
}

/* ── Panels stay as you left them ────────────────────────────────────────── */

test("an open palette is still open after the edit that closed it", () => {
    const before = fakeRoot({ details: { "wm-palette-pop": true, "wm-frame-strip": false } });
    const state = captureUI(before, { activeElement: null });

    const after = fakeRoot({ details: { "wm-palette-pop": false, "wm-frame-strip": false } });
    restoreUI(after, state);
    assert.equal(after.querySelector(".wm-palette-pop").open, true);
});

test("a panel you deliberately closed stays closed", () => {
    const before = fakeRoot({ details: { "wm-frame-strip": false } });
    const after  = fakeRoot({ details: { "wm-frame-strip": true } });
    restoreUI(after, captureUI(before, { activeElement: null }));
    assert.equal(after.querySelector(".wm-frame-strip").open, false);
});

test("config sections are keyed by their heading, not their position", () => {
    // So adding or reordering a section does not shuffle which ones are open.
    const before = fakeRoot({ details: { "wdm-cfg-collapse": true }, title: "Behaviour" });
    const state = captureUI(before, { activeElement: null });
    assert.ok("cfg:Behaviour" in state.open);

    const after = fakeRoot({ details: { "wdm-cfg-collapse": false }, title: "Behaviour" });
    restoreUI(after, state);
    assert.equal(after.querySelector(".wdm-cfg-collapse").open, true);
});

/* ── Scroll ──────────────────────────────────────────────────────────────── */

test("the block list does not jump back to the top", () => {
    const before = fakeRoot({ scroll: { "wm-sheet": 420 } });
    const after  = fakeRoot({ scroll: { "wm-sheet": 0 } });
    restoreUI(after, captureUI(before, { activeElement: null }));
    assert.equal(after.querySelector(".wm-sheet").scrollTop, 420);
});

/* ── Focus and caret ─────────────────────────────────────────────────────── */

test("the control you just changed keeps focus", () => {
    const before = fakeRoot({ fields: [{ name: "system.staminaCost", value: "5", start: 1, end: 1 }] });
    const active = before.nodes.at(-1);
    const state = captureUI(before, { activeElement: active });

    const after = fakeRoot({ fields: [{ name: "system.staminaCost", value: "5" }] });
    restoreUI(after, state);
    assert.equal(after.nodes.at(-1).focused, true);
});

test("the caret goes back where it was", () => {
    // Restoring focus without the cursor drops you at the start of a field you
    // were typing in the middle of — worse than losing focus outright.
    const before = fakeRoot({ fields: [{ name: "system.range", value: "12m", start: 2, end: 2 }] });
    const state = captureUI(before, { activeElement: before.nodes.at(-1) });

    const after = fakeRoot({ fields: [{ name: "system.range", value: "12m" }] });
    restoreUI(after, state);
    assert.deepEqual(after.nodes.at(-1).range, [2, 2]);
});

test("the caret is NOT restored if the value changed underneath", () => {
    // An offset into different text puts the cursor somewhere arbitrary.
    const before = fakeRoot({ fields: [{ name: "system.range", value: "12m", start: 3, end: 3 }] });
    const state = captureUI(before, { activeElement: before.nodes.at(-1) });

    const after = fakeRoot({ fields: [{ name: "system.range", value: "reset by the engine" }] });
    restoreUI(after, state);
    assert.equal(after.nodes.at(-1).range, undefined);
    assert.equal(after.nodes.at(-1).focused, true, "but focus still comes back");
});

test("nothing is captured when focus was outside the sheet", () => {
    const root = fakeRoot({ fields: [{ name: "x", value: "1" }] });
    root.contains = () => false;
    assert.equal(captureUI(root, { activeElement: {} }).focus, null);
});

/* ── Addressing ──────────────────────────────────────────────────────────── */

test("a control is found again by its name", () => {
    assert.equal(focusPath({ getAttribute: (k) => (k === "name" ? "system.school" : null) }),
                 '[name="system.school"]');
});

test("a block's slot is found by address and key, so editing it does not lose it", () => {
    const el = {
        getAttribute: () => null,
        dataset: { key: "formula" },
        closest: () => ({ dataset: { at: "0.body|1" } })
    };
    assert.equal(focusPath(el), '[data-at="0.body|1"] [data-key="formula"]');
});

test("a quote in an address cannot break the selector", () => {
    const el = { getAttribute: (k) => (k === "name" ? 'a"b' : null) };
    assert.equal(focusPath(el), '[name="a\\"b"]');
});

test("an unidentifiable element yields no path rather than a wrong one", () => {
    assert.equal(focusPath({ getAttribute: () => null, dataset: {}, closest: () => null }), null);
});
