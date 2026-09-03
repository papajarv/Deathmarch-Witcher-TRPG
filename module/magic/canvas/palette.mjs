/**
 * The palette — the block library, arranged for a human rather than a machine.
 *
 * Every field here is already in the registry; nothing is invented for the
 * canvas. That is the whole point of `defineBlock` carrying `shape`, `label`
 * and `inputs` alongside `run`: the previous engine had a mechanic dropdown
 * built from a live registry that NO template rendered, because the render
 * metadata and the behaviour lived in different files and drifted apart.
 *
 * If a block appears here, it runs. If it runs, it appears here.
 */

import { allBlocks, SHAPE } from "../registry.mjs";

/**
 * Categories, in the order they should be offered.
 *
 * Ordered by how often an author reaches for them while building a spell, not
 * alphabetically and not by internal similarity — `effect` first because every
 * spell needs one, `defence` last because most spells never have one.
 */
export const CATEGORIES = Object.freeze([
    { id: "effect",      label: "Effects",     hue: 14,  blurb: "What the spell does to the world." },
    { id: "gate",        label: "Conditions",  hue: 45,  blurb: "When the blocks inside them run." },
    { id: "persistence", label: "Over time",   hue: 265, blurb: "Things that keep happening, or keep being true." },
    { id: "knowledge",   label: "Knowledge",   hue: 200, blurb: "What the table learns, and what it is simply told." },
    { id: "defence",     label: "Defence",     hue: 150, blurb: "Reactions to somebody else's attack." }
]);

const CATEGORY_OF = new Map(CATEGORIES.map(c => [c.id, c]));

/** Shape → how it connects. Used for the tooltip and for the drop hint. */
export const SHAPE_BLURB = Object.freeze({
    [SHAPE.STACK]:    "Runs once, then passes on.",
    [SHAPE.GATE]:     "Wraps blocks and decides how often they run.",
    [SHAPE.DEFERRED]: "Hands the blocks inside it to something that runs later.",
    [SHAPE.REPORTER]: "Fits into a slot and reports a value."
});

/** Slots in a label, in order. `deal [formula] [damageType] damage`. */
const SLOT_RE = /\[(\w+)\]/g;

/**
 * Split a label into the pieces a renderer lays out: literal text and slots.
 * Pure, so the layout can be tested without a DOM.
 */
export function labelParts(label) {
    const parts = [];
    let last = 0;
    for (const m of label.matchAll(SLOT_RE)) {
        if (m.index > last) parts.push({ kind: "text", text: label.slice(last, m.index) });
        parts.push({ kind: "slot", key: m[1] });
        last = m.index + m[0].length;
    }
    if (last < label.length) parts.push({ kind: "text", text: label.slice(last) });
    return parts;
}

/** One palette entry, everything a renderer needs and nothing more. */
export function paletteEntry(def) {
    const cat = CATEGORY_OF.get(def.category) ?? CATEGORIES[0];
    return {
        id: def.id,
        shape: def.shape,
        category: cat.id,
        hue: cat.hue,
        label: def.label,
        parts: labelParts(def.label),
        inputs: def.inputs,
        requires: def.requires,
        emits: def.emits,
        provides: def.provides ?? [],
        holdsBody: def.shape === SHAPE.GATE || def.shape === SHAPE.DEFERRED
    };
}

/** The whole palette, grouped and ordered. Empty categories are dropped. */
export function palette() {
    const byCat = new Map(CATEGORIES.map(c => [c.id, []]));
    for (const def of allBlocks()) {
        const entry = paletteEntry(def);
        (byCat.get(entry.category) ?? byCat.get("effect")).push(entry);
    }
    return CATEGORIES
        .map(c => ({ ...c, blocks: (byCat.get(c.id) ?? []).sort(byId) }))
        .filter(c => c.blocks.length);
}

const byId = (a, b) => a.id.localeCompare(b.id);

/**
 * Default arguments for a freshly dragged block.
 *
 * Taken from the input declarations, so a block dropped on the canvas is
 * immediately valid rather than immediately broken — an editor that hands you
 * a red block the instant you use it teaches you to ignore red.
 */
export function defaultArgs(def) {
    const a = {};
    for (const [key, spec] of Object.entries(def.inputs ?? {})) {
        if (spec.default !== undefined && spec.default !== null) a[key] = spec.default;
        /* An EXPLICIT `default: null` is a documented meaning, not an absence.
         * `createZone.size` blank means "the same area the cast used";
         * `repeatEachRound.rounds` blank means "for the whole duration";
         * `createShield.charges` blank means "uncharged". Seeding those with
         * "1" quietly replaced every one of those meanings with the number one
         * — a freshly dropped zone became 1m across and a fresh Quen gained a
         * charge nobody asked for — and no editor could put the blank back. */
        else if ("default" in spec && spec.default === null) a[key] = null;
        else if (spec.type === "enum" && Array.isArray(spec.options)) a[key] = spec.options[0];
        else if (spec.type === "list") a[key] = [];
        else if (spec.type === "expression") a[key] = "1";
        else a[key] = "";
    }
    return a;
}
