/**
 * Making a rendered canvas draggable.
 *
 * Deliberately not an Application. It takes a root element and a HOST — an
 * object that knows how to read and write the trees — and wires the two
 * together. That is what lets the canvas live INSIDE the spell sheet's config
 * layer rather than in a window beside it.
 *
 * The distinction matters more than it sounds. A separate window is a place
 * you go to configure a thing; a config layer is the thing. When the answer to
 * "how do I change what Igni does" is "open a different window", people stop
 * asking and go edit the source instead — which is the failure mode this
 * engine exists to end.
 *
 * The host contract is four methods:
 *   trees()            → the authored trees, as stored
 *   commit(entry, tree) → persist one entry's tree
 *   refuse(reason)     → show why a drop was turned away
 *   ask(spec, current) → get one argument value from a person
 */

import { canDrop, canMove, insertAt, removeAt, moveTo, atPath } from "./legality.mjs";
import { getBlock } from "../registry.mjs";
import { defaultArgs } from "./palette.mjs";

/** Wire a rendered canvas. Returns a teardown function. */
export function attachCanvas(root, host) {
    if (!root) return () => {};
    const off = [];
    const on = (el, type, fn, opts) => { el.addEventListener(type, fn, opts); off.push(() => el.removeEventListener(type, fn, opts)); };

    /* The payload has to live somewhere the dragover handler can read it.
     * `dataTransfer` is write-protected during dragover in every browser — a
     * detail that costs an afternoon if you learn it the hard way. */
    let dragging = null;

    for (const chip of root.querySelectorAll(".wm-chip[data-block]")) {
        on(chip, "dragstart", (ev) => {
            dragging = { from: "palette", id: chip.dataset.block };
            ev.dataTransfer.effectAllowed = "copy";
            ev.dataTransfer.setData("text/plain", JSON.stringify(dragging));
        });
        on(chip, "dragend", () => { dragging = null; clearHints(root); });
        /* Click as well as drag: a palette with no click path is unusable on a
         * touchscreen and awkward with a trackpad. Appends to the focused
         * entry, which is where a click most plausibly means "add this". */
        on(chip, "click", (ev) => { ev.preventDefault(); host.append?.(chip.dataset.block); });
    }

    for (const blk of root.querySelectorAll(".wm-blk[data-at]")) {
        on(blk, "dragstart", (ev) => {
            ev.stopPropagation();                   // a block inside a gate is not the gate
            dragging = { from: "canvas", at: blk.dataset.at, entry: entryOf(blk) };
            ev.dataTransfer.effectAllowed = "move";
            ev.dataTransfer.setData("text/plain", JSON.stringify(dragging));
            blk.classList.add("is-dragging");
        });
        on(blk, "dragend", () => { dragging = null; blk.classList.remove("is-dragging"); clearHints(root); });
        on(blk, "keydown", (ev) => onKey(ev, blk, host));
    }

    for (const zone of root.querySelectorAll("[data-entry] , .wm-body")) {
        on(zone, "dragover", (ev) => {
            if (!dragging) return;
            const target = targetOf(zone, ev, host);
            const verdict = judge(dragging, target, host);
            clearHints(root);
            if (!verdict.ok) return;                // no preventDefault → "no drop" cursor
            ev.preventDefault();
            ev.stopPropagation();
            zone.classList.add("is-over");
            markGap(zone, target.index);
        });
        on(zone, "dragleave", () => zone.classList.remove("is-over"));
        on(zone, "drop", async (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            clearHints(root);
            const payload = dragging ?? safeParse(ev.dataTransfer.getData("text/plain"));
            dragging = null;
            if (!payload) return;
            await drop(payload, targetOf(zone, ev, host), host);
        });
    }

    /* The palette holds 38 blocks in a popover. Without a filter, finding
     * `ifPenetratedArmour` means reading all of them. */
    const filter = root.querySelector(".wm-palette-filter");
    if (filter) {
        const chips = [...root.querySelectorAll(".wm-chip[data-block]")];
        const cats  = [...root.querySelectorAll(".wm-palette-panel .wm-cat")];
        on(filter, "input", () => {
            const q = filter.value.trim().toLowerCase();
            for (const chip of chips) {
                chip.hidden = !!q && !chip.textContent.toLowerCase().includes(q)
                                  && !chip.dataset.block.toLowerCase().includes(q);
            }
            /* Hide a heading whose whole group filtered away, or the popover
             * fills with categories that contain nothing. */
            for (const cat of cats) {
                const list = cat.nextElementSibling;
                cat.hidden = !!q && ![...(list?.children ?? [])].some(c => !c.hidden);
                if (list) list.hidden = cat.hidden;
            }
        });
        /* Close on pick, so the popover is not left covering the blocks the
         * click just added to. */
        for (const chip of chips) {
            on(chip, "click", () => root.querySelector(".wm-palette-pop")?.removeAttribute("open"));
        }
    }

    for (const slot of root.querySelectorAll(".wm-slot[data-key]")) {
        on(slot, "click", (ev) => { ev.stopPropagation(); editSlot(slot, host); });
        on(slot, "keydown", (ev) => {
            if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); editSlot(slot, host); }
        });
    }

    return () => off.forEach(fn => fn());
}

/* ── The decision ────────────────────────────────────────────────────────── */

function judge(payload, target, host) {
    const tree = host.trees()[target.entry] ?? [];
    return payload.from === "palette"
        ? canDrop(tree, target.entry, target.path, target.index, payload.id)
        : canMove(tree, target.entry, parseAddr(payload.at), target);
}

async function drop(payload, target, host) {
    const tree = host.trees()[target.entry] ?? [];
    const verdict = judge(payload, target, host);
    if (!verdict.ok) return host.refuse(verdict.reason);

    if (payload.from === "palette") {
        return host.commit(target.entry, insertAt(tree, target.path, target.index, newNode(payload.id)));
    }
    /* A move ACROSS entries is a remove and an insert, not a move — the two
     * trees are different arrays and `moveTo` only understands one. */
    if (payload.entry && payload.entry !== target.entry) {
        const from = parseAddr(payload.at);
        const { tree: without, node } = removeAt(host.trees()[payload.entry] ?? [], from.path, from.index);
        await host.commit(payload.entry, without);
        return host.commit(target.entry, insertAt(tree, target.path, target.index, node));
    }
    return host.commit(target.entry, moveTo(tree, parseAddr(payload.at), target));
}

/** A fresh node, valid on arrival rather than red the instant you use it. */
export function newNode(id) {
    const def = getBlock(id);
    const node = { b: id, a: defaultArgs(def) };
    if (def?.shape === "gate" || def?.shape === "deferred") node.body = [];
    return node;
}

/* ── Where the pointer is ────────────────────────────────────────────────── */

/**
 * Which body, and which slot in it, the cursor is over.
 *
 * Insert above the first sibling whose midpoint is below the cursor, so
 * dropping near a block's top edge puts it BEFORE that block. Dropping "on" a
 * block and having it land after is the single most disorienting thing a
 * block editor can do.
 */
export function targetOf(zone, ev, host) {
    const entry = zone.closest("[data-entry]")?.dataset.entry ?? host.focus?.() ?? "hit";
    const addr = zone.dataset.body;
    const path = addr ? [...parseAddr(addr).path, parseAddr(addr).index, "body"] : [];

    const kids = [...zone.children].filter(c => c.matches(".wm-blk, .wm-gate"));
    let index = kids.length;
    for (const [i, kid] of kids.entries()) {
        const r = kid.getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) { index = i; break; }
    }
    return { entry, path, index };
}

export function parseAddr(addr) {
    const [rawPath, rawIndex] = String(addr ?? "").split("|");
    const path = rawPath ? rawPath.split(".").map(p => (/^\d+$/.test(p) ? Number(p) : p)) : [];
    return { path, index: Number(rawIndex) };
}

const entryOf = (el) => el.closest("[data-entry]")?.dataset.entry ?? null;
const safeParse = (s) => { try { return JSON.parse(s); } catch { return null; } };

/* ── Keyboard ────────────────────────────────────────────────────────────
 * Drag-and-drop with no keyboard path is an editor a third of people cannot
 * use, and it is the half that never gets built because the mouse version
 * looks finished. */

async function onKey(ev, blk, host) {
    const at = parseAddr(blk.dataset.at);
    const entry = entryOf(blk) ?? host.focus?.() ?? "hit";
    const tree = host.trees()[entry] ?? [];

    if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
        ev.preventDefault();
        const to = { path: at.path, index: at.index + (ev.key === "ArrowDown" ? 2 : -1) };
        if (to.index < 0) return;
        const verdict = canMove(tree, entry, at, to);
        if (!verdict.ok) return host.refuse(verdict.reason);
        return host.commit(entry, moveTo(tree, at, to));
    }
    if (ev.key === "Delete" || ev.key === "Backspace") {
        ev.preventDefault();
        return host.commit(entry, removeAt(tree, at.path, at.index).tree);
    }
}

/* ── Editing one argument ────────────────────────────────────────────────── */

async function editSlot(slot, host) {
    const blk = slot.closest(".wm-blk");
    if (!blk) return;
    const at = parseAddr(blk.dataset.at);
    const entry = entryOf(blk) ?? host.focus?.() ?? "hit";
    const tree = structuredClone(host.trees()[entry] ?? []);
    const node = nodeAt(tree, at);
    const def = getBlock(node?.b);
    const spec = def?.inputs?.[slot.dataset.key];
    if (!spec) return;

    const next = await host.ask(spec, node.a?.[slot.dataset.key], slot.dataset.key);
    if (next === undefined) return;             // dismissed; not the same as cleared
    (node.a ??= {})[slot.dataset.key] = next;
    return host.commit(entry, tree);
}

export function nodeAt(tree, { path, index }) {
    return path.length ? atPath(tree, path).body[index] : tree[index];
}

/* ── Drop hints ──────────────────────────────────────────────────────────── */

function markGap(zone, index) {
    const kids = [...zone.children].filter(c => c.matches(".wm-blk, .wm-gate"));
    const at = kids[index];
    if (at) at.classList.add("is-gap-before");
    else zone.classList.add("is-gap-end");
}

function clearHints(root) {
    for (const el of root.querySelectorAll(".is-over, .is-gap-before, .is-gap-end")) {
        el.classList.remove("is-over", "is-gap-before", "is-gap-end");
    }
}
