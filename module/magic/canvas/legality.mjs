/**
 * Whether a block may be dropped where the author is trying to drop it.
 *
 * The answer comes from `validateTree` — the SAME function the runtime uses
 * before it will cast anything. Not a parallel implementation, not a lookup
 * table of "these fit inside those": the editor speculatively inserts the block,
 * asks the validator, and reports the first thing it objected to.
 *
 * That equivalence is the point. An editor with its own idea of legality is an
 * editor that eventually disagrees with the engine, and when it does, the
 * author is the one who finds out — at the table, mid-fight. Here it cannot
 * disagree, because there is only one opinion.
 *
 * It also means every new block gets editor support for free. Nobody has to
 * remember to teach the canvas about it.
 */

import { validateTree, validateEntry, getBlock, ENTRY_SCOPE, SHAPE } from "../registry.mjs";
import { defaultArgs } from "./palette.mjs";

/** A position in a tree: `[2, "body", 0]` means node 2's body, index 0. */
export function atPath(tree, path) {
    let node = { body: tree };
    for (let i = 0; i < path.length; i += 2) node = node.body[path[i]];
    return node;
}

/** Insert a node at `[...path, index]`, returning a NEW tree. Never mutates. */
export function insertAt(tree, path, index, node) {
    const clone = structuredClone(tree);
    const body = path.length ? atPath(clone, path).body ??= [] : clone;
    body.splice(index, 0, node);
    return clone;
}

/** Remove the node at `[...path, index]`, returning a NEW tree and the node. */
export function removeAt(tree, path, index) {
    const clone = structuredClone(tree);
    const body = path.length ? atPath(clone, path).body : clone;
    const [node] = body.splice(index, 1);
    return { tree: clone, node };
}

/** Move a node from one position to another in one step. */
export function moveTo(tree, from, to) {
    const { tree: without, node } = removeAt(tree, from.path, from.index);
    /* Removing a node above the destination shifts the destination up by one. */
    const shift = samePath(from.path, to.path) && from.index < to.index ? 1 : 0;
    return insertAt(without, to.path, to.index - shift, node);
}

const samePath = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * May `blockId` be dropped into `entry`'s tree at this position?
 *
 * Returns `{ ok }` or `{ ok: false, reason }`, where the reason is the
 * validator's own message — which is written for the author, not for a log.
 */
export function canDrop(tree, entry, path, index, blockId) {
    const def = getBlock(blockId);
    if (!def) return { ok: false, reason: `"${blockId}" isn't installed.` };

    const speculative = insertAt(tree, path, index, { b: blockId, a: defaultArgs(def) });
    const problems = validateEntry(entry, speculative, "spell");

    /* Only problems the drop CAUSED count. A tree that was already broken
     * elsewhere must not veto an unrelated, correct drop — otherwise one bad
     * block anywhere freezes the whole canvas. */
    const before = new Set(validateEntry(entry, tree, "spell"));
    const caused = problems.filter(p => !before.has(p));

    return caused.length ? { ok: false, reason: firstUseful(caused) } : { ok: true };
}

/** Where a moved node may land, using the same speculative check. */
export function canMove(tree, entry, from, to) {
    const node = atPath(tree, from.path).body?.[from.index] ?? tree[from.index];
    if (!node) return { ok: false, reason: "Nothing there to move." };
    if (isInsideItself(from, to)) return { ok: false, reason: "A block can't be put inside itself." };

    const moved = moveTo(tree, from, to);
    const before = new Set(validateEntry(entry, tree, "spell"));
    const caused = validateEntry(entry, moved, "spell").filter(p => !before.has(p));
    return caused.length ? { ok: false, reason: firstUseful(caused) } : { ok: true };
}

function isInsideItself(from, to) {
    if (to.path.length < from.path.length + 2) return false;
    for (let i = 0; i < from.path.length; i++) if (to.path[i] !== from.path[i]) return false;
    return to.path[from.path.length] === from.index;
}

/**
 * Turn a validator message into something worth reading.
 *
 * `spell.hit[0].body[1]: "core:dealDamage" needs targets, and nothing above it
 * has produced any.` is precise and unreadable. The author is looking straight
 * at the block they just dragged; they do not need to be told its index, its
 * namespace, or the internal name of the thing it wanted.
 *
 * The rewriting happens HERE rather than in the validator on purpose. The
 * engine's messages go to logs and to whoever is debugging a spell pack, where
 * the index and the full id are the useful parts. Two audiences, one source of
 * truth about what is actually wrong.
 */
function firstUseful(problems) {
    const raw = problems[0] ?? "That doesn't fit here.";
    const cut = raw.indexOf(": ");
    let msg = cut >= 0 ? raw.slice(cut + 2) : raw;

    /* The commonest failure by far, and the one worth phrasing properly:
     * something needs a thing nothing above it produced. */
    const needs = msg.match(/^"core:(\w+)" needs (\w+)/);
    if (needs) {
        const [, block, want] = needs;
        const noun = NEEDS[want];
        return noun
            ? `${sentence(block)} ${noun.verb} ${noun.what}. ${noun.fix}`
            : `${sentence(block)} needs ${want} first.`;
    }

    const noArg = msg.match(/^"core:(\w+)" has no argument "(\w+)"/);
    if (noArg) return `${sentence(noArg[1])} has no "${noArg[2]}" to set.`;

    const cantHold = msg.match(/^"core:(\w+)" can't hold other blocks/);
    if (cantHold) return `${sentence(cantHold[1])} doesn't wrap anything — put blocks after it instead.`;

    return msg.replace(/"core:(\w+)"/g, (_, n) => sentence(n));
}

/** What each requirement means, said the way an author would say it. */
const NEEDS = Object.freeze({
    targets:      { verb: "needs", what: "somebody to affect",
                    fix: "Put it under a trigger that picks targets, or inside a block that finds some." },
    incoming:     { verb: "only works on", what: "an attack already in flight",
                    fix: "It belongs under one of the “when something comes at you” triggers." },
    damageDealt:  { verb: "checks", what: "damage that already happened",
                    fix: "Put it after a block that deals some." },
    caster:       { verb: "needs", what: "a caster", fix: "" }
});

/** "dealDamage" -> "Deal damage". Used wherever a block is named to a human. */
function sentence(name) {
    const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
}

export { sentence as blockTitle };

/**
 * Which entry points this item can offer, and what each one hands its tree.
 *
 * The canvas needs this to grey out an interception-only block while the
 * author is editing a cast tree — `deflect` requires `incoming`, and no cast
 * tree will ever have one.
 */
/**
 * Triggers nothing in the system can currently fire.
 *
 * These three need the WEAPON attack pipeline to publish into the magic bus,
 * and it does not: `ENTRY.INCOMING_ATTACK`, `BEFORE_DEFENCE` and `AFTER_APPLY`
 * are never passed to `publish()` anywhere. They were offered in the dropdown
 * anyway, so a GM could pick one, build a body under it, save, and watch it do
 * nothing forever with no way to tell why.
 *
 * They stay in `ENTRY_SCOPE` — a tree already authored under one still
 * validates and still loads — but they are not offered until something fires
 * them. Deleting an author's work would be worse than hiding a choice.
 */
export const UNFIRED_ENTRIES = Object.freeze(["incomingAttack", "beforeDefence", "afterApply"]);

export function entryOptions({ includeUnfired = false } = {}) {
    return Object.entries(ENTRY_SCOPE)
        .filter(([id]) => includeUnfired || !UNFIRED_ENTRIES.includes(id))
        .map(([id, scope]) => ({
            id, scope, label: ENTRY_LABELS[id] ?? id, hint: ENTRY_HINTS[id] ?? ""
        }));
}

/**
 * When each trigger actually fires, in plain words.
 *
 * A trigger is the concept the engine turns on — the same blocks under "when
 * it hits" and under "when damage reaches you" are two different spells — and
 * a dropdown of eleven names explains none of it. Each of these says WHEN, not
 * what it is called.
 */
const ENTRY_HINTS = Object.freeze({
    hit:            "the target failed to defend",
    miss:           "they defended successfully",
    success:        "nothing could be rolled against it",
    fumble:         "the casting went wrong",
    aborted:        "the cast was called off before it landed",
    incomingMagic:  "someone casts at whoever has this up",
    incomingAttack: "a weapon or arrow comes at them",
    beforeDefence:  "just before they roll to defend",
    takeDamage:     "damage is about to reach them",
    afterApply:     "immediately after it resolves",
    onExpire:       "it runs out, is dispelled, or is used up"
});

const ENTRY_LABELS = Object.freeze({
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
 * Blocks that could NEVER fit in this entry, whatever is above them.
 *
 * Used to dim the palette rather than to refuse a drop — refusing is
 * `canDrop`'s job. A block that is dim can still be dragged, and dropping it
 * gives the real reason.
 */
export function unreachableIn(entry, blocks) {
    const scope = new Set(ENTRY_SCOPE[entry] ?? []);
    return new Set(blocks
        .filter(b => b.requires.some(r => !scope.has(r) && !PRODUCIBLE.has(r)))
        .map(b => b.id));
}

/** Things some other block can produce mid-tree, so absence now proves nothing. */
const PRODUCIBLE = new Set(["targets", "damageDealt", "shield", "zone", "object"]);

export { SHAPE, validateTree };
