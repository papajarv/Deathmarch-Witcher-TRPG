/**
 * Expressions, in English.
 *
 * `max(1,8-{index})d6` is exactly right and completely opaque. It is also the
 * only thing on the block that says Alzur's Thunder loses a die per target,
 * which means the most interesting fact about the spell was written in a
 * notation nobody reads.
 *
 * This is NOT a decompiler. The whole corpus — 103 spells — uses 46 distinct
 * expressions, and 33 of them are plain literals like `4d6` that need no help.
 * Thirteen carry a variable. So this recognises SHAPES, most specific first,
 * and falls back to naming the variables in words rather than guessing at
 * arbitrary arithmetic.
 *
 * The formula stays the truth. This is a reading of it, shown beside it — an
 * author edits the expression, never the prose, because prose that could be
 * edited would be a second source of truth for the same thing.
 */

/** What each variable is, when it has to be named on its own. */
const NOUN = Object.freeze({
    sta:    "the Stamina spent",
    margin: "how far the roll beat the defence",
    index:  "targets already hit",
    skill:  "Spell Casting",
    vigor:  "the Vigor threshold"
});

/** Per-unit phrasing — "N per X" reads better than "N × the X". */
const PER = Object.freeze({
    sta:    "Stamina spent",
    skill:  "point of Spell Casting",
    margin: "point over the defence",
    vigor:  "point of Vigor"
});

/**
 * Ordered patterns. First match wins, so the specific ones come first — a
 * general "N × {var}" rule would swallow the capped-step formula and report it
 * as multiplication.
 */
const SHAPES = [
    /* Yrden and Axii: the same escalating step, one of them capped. Written as
     * `-min(4,1+floor(({sta}-1)/2))`, which is unreadable and correct. */
    { re: /^-min\((\d+),\s*1\+floor\(\(\{(\w+)\}-1\)\/2\)\)$/,
      say: (m) => `−1, worsening by 1 every 2 ${PER[m[2]] ?? m[2]}, no worse than −${m[1]}` },
    { re: /^-\(1\+floor\(\(\{(\w+)\}-1\)\/2\)\)$/,
      say: (m) => `−1, worsening by 1 every 2 ${PER[m[1]] ?? m[1]}` },

    /* Alzur's Thunder. The falloff, and the reason this file exists. */
    { re: /^max\((\d+),\s*(\d+)-\{index\}\)d(\d+)$/,
      say: (m) => `${m[2]}d${m[3]}, one die less for every target it has already passed through` +
                  (m[1] === "1" ? ` (never below ${m[1]}d${m[3]})` : "") },

    /* Cenlly Graig and Carys' Hail: margin-scaled, capped. */
    { re: /^min\((\d+),\s*\{margin\}\)d(\d+)$/,
      say: (m) => `1d${m[2]} for every point the roll beat the defence by, up to ${m[1]}` },
    { re: /^min\((\d+),\s*floor\(\{margin\}\/2\)\)$/,
      say: (m) => `half of how far the roll beat the defence, rounded down, up to ${m[1]}` },

    /* Tryferi Gaeaf's spike count. */
    { re: /^floor\(\{(\w+)\}\/(\d+)\)$/,
      say: (m) => `${m[2] === "2" ? "half" : `a ${ordinal(m[2])}`} of ${NOUN[m[1]] ?? m[1]}, rounded down` },

    /* Igni, Fire Stream: dice per point spent. */
    { re: /^\{(\w+)\}d(\d+)$/,
      say: (m) => `1d${m[2]} per ${PER[m[1]] ?? m[1]}` },

    /* Quen's pool, Active Shield's, Demetia's charge count. */
    { re: /^(\d+)\*\{(\w+)\}$/,
      say: (m) => `${m[1]} per ${PER[m[2]] ?? m[2]}` },
    { re: /^\{(\w+)\}\*(\d+)$/,
      say: (m) => `${m[2]} per ${PER[m[1]] ?? m[1]}` },

    /* A bare variable. */
    { re: /^\{(\w+)\}$/, say: (m) => NOUN[m[1]] ?? m[1] }
];

const ordinal = (n) => ({ 3: "third", 4: "quarter", 5: "fifth" }[n] ?? `1/${n}`);

/**
 * An expression in English, or `null` when it needs no translation.
 *
 * `null` for plain literals on purpose: `4d6` is already English, and printing
 * "4d6 damage (that is, 4d6)" beside it is noise that teaches people to stop
 * reading the annotations that matter.
 */
export function phrase(expr) {
    const src = String(expr ?? "").trim();
    if (!src || !src.includes("{")) return null;

    for (const { re, say } of SHAPES) {
        const m = src.match(re);
        if (m) return say(m);
    }
    return fallback(src);
}

/**
 * Anything unrecognised, made as readable as it can be without pretending to
 * understand it.
 *
 * Names the variables and unwraps the two functions that appear in practice.
 * Deliberately conservative — a wrong plain-English reading of a formula is
 * worse than the formula, because the formula at least admits it is one.
 */
function fallback(src) {
    let out = src.replace(/\{(\w+)\}/g, (_, v) => NOUN[v] ?? v);
    out = out.replace(/floor\(([^()]*)\)/g, "$1 rounded down");
    out = out.replace(/ceil\(([^()]*)\)/g, "$1 rounded up");
    out = out.replace(/min\(([^,()]*),\s*([^()]*)\)/g, "$2, at most $1");
    out = out.replace(/max\(([^,()]*),\s*([^()]*)\)/g, "$2, at least $1");
    return out === src ? null : out;
}

/** Does this expression depend on anything worked out at cast time? */
export function isDynamic(expr) {
    return String(expr ?? "").includes("{");
}
