/**
 * What an item's authored behaviour looks like on the sheet.
 *
 * Foundry-free, because it is the only part of the sheet integration with real
 * logic — counting, naming, and validating — and the rest is markup. Sheets
 * are the hardest thing in a Foundry system to test and the easiest place for
 * a silent wrong answer to live.
 *
 * The question it answers is the one a GM opening a spell actually has: WHICH
 * ENGINE runs when this is cast? Without that on screen the two paths are
 * indistinguishable, and a spell that quietly does nothing looks exactly like
 * a spell that quietly works.
 */

import { validateSpell, ENTRY_SCOPE, getBlock } from "./registry.mjs";

/** Human names for the entry points, shared with the canvas. */
export const ENTRY_LABELS = Object.freeze({
    hit:            "When it hits",
    miss:           "When it misses",
    success:        "When it works",
    fumble:         "When you fumble",
    aborted:        "When it's called off",
    incomingMagic:  "When magic comes at you",
    incomingAttack: "When an attack comes at you",
    beforeDefence:  "Before you defend",
    takeDamage:     "When damage reaches you",
    afterApply:     "After it lands",
    onExpire:       "When it ends"
});

/**
 * Summarise `item.system.magic` for the sheet.
 *
 * `any` is deliberately false for an empty tree as well as a missing one. The
 * schema initialises `on` to `{}` for every spell in the world, and a trigger
 * with nothing under it is a trigger somebody started and abandoned — neither
 * is behaviour, and both would otherwise light the badge.
 */
export function authoredSummary(magic, name = "spell") {
    const on = magic?.on ?? {};
    const entries = Object.entries(on)
        .filter(([, tree]) => Array.isArray(tree) && tree.length)
        .map(([entry, tree]) => ({
            entry,
            label: ENTRY_LABELS[entry] ?? entry,
            blocks: countBlocks(tree),
            summary: describe(tree)
        }));

    if (!entries.length) return { any: false, entries: [], problems: [], badge: "" };

    /* Validated on every render. It is cheap, and a spell that has drifted —
     * an add-on uninstalled, an engine downgraded — should say so where the
     * author is looking rather than the first time somebody casts it. */
    const problems = validateSpell({ name, on: pruneEmpty(on) });

    const total = entries.reduce((n, e) => n + e.blocks, 0);
    return {
        any: true,
        entries,
        problems,
        badge: problems.length
            ? `${problems.length} problem${problems.length === 1 ? "" : "s"}`
            : `${total} block${total === 1 ? "" : "s"} · ${entries.length} trigger${entries.length === 1 ? "" : "s"}`
    };
}

/** Blocks in a tree, counting the ones nested inside gates. */
export function countBlocks(tree) {
    let n = 0;
    for (const node of tree ?? []) { n++; n += countBlocks(node.body); }
    return n;
}

/**
 * One line describing a tree, in the author's words rather than block ids.
 *
 * Named after what the tree DOES, not what it contains: "deals damage, applies
 * a status" tells a GM whether this is the spell they meant; "3 blocks" does
 * not.
 */
export function describe(tree, limit = 3) {
    const verbs = [];
    const walk = (body) => {
        for (const node of body ?? []) {
            const def = getBlock(node.b);
            if (def && def.category === "effect") verbs.push(verbFor(node.b));
            walk(node.body);
        }
    };
    walk(tree);

    const unique = [...new Set(verbs)];
    if (!unique.length) return `${countBlocks(tree)} block${countBlocks(tree) === 1 ? "" : "s"}`;
    if (unique.length <= limit) return unique.join(", ");
    return `${unique.slice(0, limit).join(", ")} +${unique.length - limit} more`;
}

const VERBS = Object.freeze({
    "core:dealDamage":    "deals damage",
    "core:applyStatus":   "applies a status",
    "core:removeStatus":  "removes a status",
    "core:healHealth":    "heals",
    "core:drainResource": "drains a resource",
    "core:grantModifier": "grants a modifier",
    "core:grantPool":     "grants points",
    "core:createZone":    "makes a zone",
    "core:createObject":  "conjures a thing",
    "core:createShield":  "raises a shield",
    "core:summonCopies":  "summons",
    "core:knockback":     "throws them back",
    "core:counteract":    "suppresses magic",
    "core:absorbDamage":  "absorbs damage",
    "core:negateMagic":   "negates magic"
});

const verbFor = (id) => VERBS[id] ?? id.split(":")[1].replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();

/** Drop triggers with nothing under them before validating. */
function pruneEmpty(on) {
    return Object.fromEntries(Object.entries(on).filter(([, t]) => Array.isArray(t) && t.length));
}

/**
 * One line answering the only question that matters: what happens when I cast
 * this?
 *
 * There are three states and the middle one is a trap. A spell with no
 * triggers casts the old way — fine, and deliberate. A spell with triggers but
 * no blocks under them ALSO casts the old way, because an empty tree is not
 * behaviour — and that one looks finished. Somebody adds "When it hits",
 * closes the sheet, and finds out at the table.
 */
export function castStatus(magic, name = "spell") {
    const on = magic?.on ?? {};
    const declared = Object.keys(on);
    const withBlocks = declared.filter(e => Array.isArray(on[e]) && on[e].length);

    if (!declared.length) return { state: "legacy", key: "StatusLegacy", data: {} };

    if (!withBlocks.length) {
        return {
            state: "empty",
            key: declared.length === 1 ? "StatusTriggerEmpty" : "StatusTriggersEmpty",
            data: { n: declared.length }
        };
    }

    const blocks = withBlocks.reduce((n, e) => n + countBlocks(on[e]), 0);
    const problems = validateSpell({ name, on: pruneEmpty(on) });
    if (problems.length) return { state: "broken", key: "StatusBroken", data: { problem: problems[0] } };

    return {
        state: "live",
        key: "StatusLive",
        data: { blocks, triggers: withBlocks.length, empty: declared.length - withBlocks.length }
    };
}

/** Does this item carry behaviour the new engine should run? */
export function hasAuthoredTrees(system) {
    const on = system?.magic?.on;
    return !!on && Object.values(on).some(tree => Array.isArray(tree) && tree.length);
}

export { ENTRY_SCOPE };
