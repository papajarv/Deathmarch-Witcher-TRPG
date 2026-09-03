/**
 * Carrying the editor's UI state across a re-render.
 *
 * Every edit writes to the document and re-renders the sheet, which builds a
 * fresh DOM. Without this, that means: the palette popover you were picking
 * from snaps shut, the frame strip you opened folds, the block list jumps back
 * to the top, and the select you just changed loses focus — so choosing three
 * things in a row means opening the same panel three times.
 *
 * Foundry gives `_preSyncPartState` / `_syncPartState` for exactly this: read
 * from the outgoing DOM, write to the incoming one. The functions here are the
 * pure half, so what gets carried and what gets dropped is testable without a
 * browser.
 *
 * What is NOT carried is as deliberate as what is. Refusal messages clear on
 * the next successful action, and a stale one shown after a fix is worse than
 * none.
 */

/** Elements whose open/closed state matters, keyed by something stable. */
const REMEMBERED = [
    { selector: "details.wm-palette-pop",  key: () => "palette" },
    { selector: "details.wm-frame-strip",  key: () => "frame" },
    { selector: "details.wm-trigger-add",  key: () => "triggers" },
    { selector: "details.wm-law-reads",    key: () => "reads" },
    /* Config sections are keyed by their own heading, so adding or reordering
     * a section does not shuffle which ones are open. */
    { selector: "details.wdm-cfg-collapse", key: (el) =>
        `cfg:${el.querySelector(".wdm-cfg-collapse-title")?.textContent?.trim() ?? ""}` }
];

/** Containers whose scroll position matters. */
const SCROLLED = [".wm-sheet", ".wm-rail", ".wm-palette-panel"];

/** Read the state worth keeping out of the DOM that is about to be replaced. */
export function captureUI(root, doc = document) {
    if (!root) return null;
    const open = {};
    for (const { selector, key } of REMEMBERED) {
        for (const el of root.querySelectorAll(selector)) open[key(el)] = el.open;
    }

    const scroll = {};
    for (const sel of SCROLLED) {
        const el = root.querySelector(sel);
        if (el) scroll[sel] = el.scrollTop;
    }

    /* Focus, and the caret with it. Restoring focus but not the cursor
     * position drops you at the start of a field you were typing in the
     * middle of, which is worse than losing focus outright. */
    const active = doc.activeElement;
    const focus = active && root.contains?.(active) ? {
        name: active.getAttribute?.("name") ?? null,
        selector: focusPath(active),
        start: active.selectionStart ?? null,
        end: active.selectionEnd ?? null,
        value: typeof active.value === "string" ? active.value : null
    } : null;

    return { open, scroll, focus };
}

/** Put it back on the DOM that just replaced it. */
export function restoreUI(root, state) {
    if (!root || !state) return;

    for (const { selector, key } of REMEMBERED) {
        for (const el of root.querySelectorAll(selector)) {
            const wanted = state.open[key(el)];
            if (wanted !== undefined) el.open = wanted;
        }
    }

    for (const [sel, top] of Object.entries(state.scroll ?? {})) {
        const el = root.querySelector(sel);
        if (el) el.scrollTop = top;
    }

    const f = state.focus;
    if (!f?.selector) return;
    const el = root.querySelector(f.selector);
    if (!el) return;
    el.focus?.({ preventScroll: true });
    /* Only for fields where a caret means anything, and only if the value did
     * not change underneath — restoring an offset into different text puts the
     * cursor somewhere arbitrary. */
    if (f.start != null && typeof el.value === "string" && el.value === f.value) {
        try { el.setSelectionRange(f.start, f.end); } catch { /* not a text field */ }
    }
}

/**
 * A selector that finds the same control in the next DOM.
 *
 * `name` first, because every control in the frame panel has one and it is the
 * most stable thing about it. Then the block address, which survives an edit
 * to the block's own arguments.
 */
export function focusPath(el) {
    if (!el?.getAttribute) return null;
    const name = el.getAttribute("name");
    if (name) return `[name="${cssEscape(name)}"]`;

    const at = el.closest?.("[data-at]")?.dataset?.at;
    const key = el.dataset?.key;
    if (at && key) return `[data-at="${cssEscape(at)}"] [data-key="${cssEscape(key)}"]`;
    if (at) return `[data-at="${cssEscape(at)}"]`;

    const block = el.dataset?.block;
    if (block) return `[data-block="${cssEscape(block)}"]`;
    return null;
}

/* `CSS.escape` is not available in a bare node test, and these values are
 * quoted attribute selectors — the only characters that can break one are the
 * quote and the backslash. */
const cssEscape = (v) => String(v).replace(/(["\\])/g, "\\$1");
