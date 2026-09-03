/**
 * Putting the authored corpus onto the item documents.
 *
 * The gap this closes: the 103 entries are SOURCE. The spells your players
 * cast are documents in `packs/magic`, and one named "Aenye" has
 * `system.magic.on = {}` — so casting it goes down the original path, and
 * every piece of this engine sits there working perfectly on nothing.
 *
 * There is no build step to close the gap offline. `package.json` declares
 * `build:packs → node tools/build-packs.mjs` and `tools/` does not exist; the
 * LevelDB packs are the only copy, edited live. So the seeding happens inside
 * Foundry, where the documents are.
 *
 * Two rules the whole thing is built around:
 *
 *   IT ONLY EVER WRITES `system.magic`. Nothing else on the item is touched,
 *   which is what makes seeding reversible per spell — clearing the trees puts
 *   that one spell back on the old engine without reverting anything.
 *
 *   IT REPORTS BEFORE IT WRITES. A dry run is the default. Matching 103 book
 *   names against whatever a world actually contains is guesswork, and
 *   guesswork that has already written is not guesswork you can inspect.
 */

import { CORPUS } from "./spells/corpus.mjs";
import { validateSpell } from "./registry.mjs";
import { hasAuthoredTrees } from "./summary.mjs";

/**
 * Normalise a name for matching.
 *
 * Apostrophes are the whole problem: "Alzur's Thunder" is typed with U+2019
 * in one place and U+0027 in another, and the two are different strings. The
 * book's own printing uses the curly one; a GM typing into a sheet gets
 * whichever their keyboard gives them.
 *
 * The parenthetical is the other: signs are printed "Yrden (Mixed)" in the
 * table of contents and "Yrden" everywhere else.
 */
export function normalise(name) {
    return String(name ?? "")
        .replace(/[‘’ʼ`´]/g, "'")
        .replace(/\s*\([^)]*\)\s*/g, " ")
        .replace(/[^a-z0-9' ]/gi, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

/** The corpus, indexed by normalised name. */
export function corpusIndex(corpus = CORPUS) {
    const index = new Map();
    for (const spell of corpus) index.set(normalise(spell.name), spell);
    return index;
}

/**
 * Match a list of items against the corpus.
 *
 * Returns four buckets, and the last two are the interesting ones:
 *
 *   matched   — a corpus entry for this item, and it has no trees yet
 *   already   — it already carries trees; left alone unless `overwrite`
 *   unmatched — an item the corpus has nothing for (a homebrew spell, a hex,
 *               a ritual — all expected, none an error)
 *   unused    — a corpus entry NO item matched, which is the bucket worth
 *               reading: it means either the world is missing that spell or
 *               its name differs, and only a person can tell which
 */
export function plan(items, { corpus = CORPUS, overwrite = false } = {}) {
    const index = corpusIndex(corpus);
    const matched = [], already = [], unmatched = [];
    const used = new Set();

    for (const item of items) {
        const key = normalise(item.name);
        const spell = index.get(key);
        if (!spell) { unmatched.push({ item, key }); continue; }
        used.add(key);
        if (hasAuthoredTrees(item.system) && !overwrite) { already.push({ item, spell }); continue; }
        matched.push({ item, spell });
    }

    const unused = [...index.entries()]
        .filter(([key]) => !used.has(key))
        .map(([, spell]) => spell);

    return { matched, already, unmatched, unused };
}

/**
 * The update payload for one match.
 *
 * Deep-cloned because a corpus entry is a module-level constant shared by every
 * world on the machine — handing Foundry the live object would let a later
 * edit through the canvas mutate the source of truth for everything else.
 */
export function payloadFor(spell) {
    return {
        "system.magic": {
            frame: structuredClone(spell.frame),
            on: structuredClone(spell.on)
        }
    };
}

/**
 * Refuse to seed a corpus entry that does not validate.
 *
 * The corpus is tested, so this should never fire — but it is the difference
 * between "cannot happen" and "does not happen", and the cost of being wrong
 * is writing broken trees onto a hundred documents at once.
 */
export function verify(corpus = CORPUS) {
    return corpus
        .map(spell => ({ spell, problems: validateSpell(spell) }))
        .filter(x => x.problems.length);
}

/** A readable report of a plan. Used by the dry run and by the summary after. */
export function report(p) {
    const lines = [];
    lines.push(`${p.matched.length} to seed`);
    if (p.already.length)   lines.push(`${p.already.length} already authored, left alone`);
    if (p.unmatched.length) lines.push(`${p.unmatched.length} with no corpus entry`);
    if (p.unused.length)    lines.push(`${p.unused.length} corpus entries matched nothing`);
    return lines;
}
