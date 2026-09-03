/**
 * Writing authored trees back to the item.
 *
 * There is one trap here and it swallows the two most visible actions in the
 * editor: **an ObjectField update MERGES.**
 *
 * `item.update({ "system.magic": { frame: {}, on: {} } })` does not clear
 * anything. Foundry recursively merges the new object into the stored one, so
 * an empty object is a no-op — Clear appeared to do nothing, and loading a
 * spell from the book left the old triggers sitting alongside the new ones.
 * Neither failed. Neither said anything. The sheet re-rendered showing exactly
 * what it showed before.
 *
 * Removing a key needs Foundry's explicit deletion syntax (`-=key`), so every
 * write that can REMOVE a trigger has to name the ones it is dropping. That is
 * what `treeUpdate` works out.
 */

/**
 * The update payload that makes an item's trees exactly `next`.
 *
 * Pure, so the diff is testable without a document: it takes the current trees
 * and the wanted trees, and returns the flat update object.
 */
export function treeUpdate(current = {}, next = {}) {
    const update = {};

    /* Deletions first, and explicitly. Anything the old set had that the new
     * one does not must be named, or the merge quietly keeps it. */
    for (const entry of Object.keys(current)) {
        if (!(entry in next)) update[`system.magic.on.-=${entry}`] = null;
    }

    /* Then the writes. An ARRAY replaces wholesale rather than merging, which
     * is why per-entry paths are safe while the parent object is not. */
    for (const [entry, tree] of Object.entries(next)) {
        update[`system.magic.on.${entry}`] = tree;
    }
    return update;
}

/** The same, for the frame — which is written whole or not at all. */
export function frameUpdate(current = {}, next = {}) {
    const update = {};
    for (const key of Object.keys(current)) {
        if (!(key in next)) update[`system.magic.frame.-=${key}`] = null;
    }
    for (const [key, value] of Object.entries(next)) {
        update[`system.magic.frame.${key}`] = value;
    }
    return update;
}

/** Replace everything an item carries, frame and trees together. */
export function replaceAll(item, { frame = {}, on = {}, sheetFields = {} } = {}) {
    const magic = item.system?.magic ?? {};
    return item.update({
        ...frameUpdate(magic.frame ?? {}, frame),
        ...treeUpdate(magic.on ?? {}, on),
        /* The sheet's own fields, where the caller wants them kept in step.
         * The CAST DIALOG reads `system.staminaCost`, not the frame — so a
         * spell whose frame says "1 to 7 Stamina" but whose sheet still says 0
         * is cast for nothing. */
        ...sheetFields
    });
}

/** Put the item back on the original engine. */
export function clearAll(item) {
    return replaceAll(item, { frame: {}, on: {} });
}

/** Write one entry's tree, leaving the others alone. */
export function writeTree(item, entry, tree) {
    return item.update({ [`system.magic.on.${entry}`]: tree });
}

/** Drop one trigger entirely. */
export function removeEntry(item, entry) {
    return item.update({ [`system.magic.on.-=${entry}`]: null });
}
