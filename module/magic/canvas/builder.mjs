/**
 * Configuring a value without writing a formula.
 *
 * The engine stores expressions like `max(1,8-{index})d6`, and that is the
 * right thing for it to store — it is exact, and one string covers every case.
 * It is also not something to ask a person to type. Nobody should have to know
 * that `{index}` exists, let alone that it counts from zero, in order to say
 * "it loses a die for each target it passes through".
 *
 * So: an expression is one of a small number of SHAPES. You pick the shape in
 * plain words, fill in the numbers, and the formula is built for you. The whole
 * corpus — 103 spells — uses six.
 *
 * Every shape can also PARSE its own output, which is what lets the editor open
 * an existing spell and show it as choices rather than as a string. A shape
 * that could build but not parse would make the first edit of any authored
 * spell a retype.
 */

/**
 * `id`      what gets stored alongside, so re-opening skips the guesswork
 * `label`   the sentence, with {slots} for the numbers
 * `fields`  the numbers, in the order they appear in the label
 * `build`   values → the formula the engine runs
 * `parse`   a formula → values, or null if it is a different shape
 */
export const SHAPES = Object.freeze([
    {
        id: "flat",
        label: "exactly {n}",
        /* No floor. `flat` is the ONLY shape that can express a penalty, and
         * `setValue` clamps to `min ?? 0` — so with min 0 a GM could not author
         * any negative modifier at all. Yrden's -2 SPD, Stammelford's -3 and
         * Eilhart's -1 INT could be opened and read, but touching the number
         * destroyed them and there was no way to type one back. */
        fields: [{ key: "n", min: null, default: 1 }],
        build: (v) => String(num(v.n, 1)),
        parse: (f) => /^-?\d+$/.test(f) ? { n: Number(f) } : null
    },
    {
        id: "dice",
        label: "{count}d{die}",
        fields: [{ key: "count", min: 1, default: 1 }, { key: "die", min: 2, default: 6, step: 2 }],
        build: (v) => `${num(v.count, 1)}d${num(v.die, 6)}`,
        parse: (f) => match(f, /^(\d+)d(\d+)$/, (m) => ({ count: +m[1], die: +m[2] }))
    },
    {
        id: "perStamina",
        label: "{count}d{die} for every Stamina spent",
        fields: [{ key: "count", min: 1, default: 1 }, { key: "die", min: 2, default: 6, step: 2 }],
        /* `{sta}d6` is the common case; anything else needs the multiplier. */
        build: (v) => num(v.count, 1) === 1
            ? `{sta}d${num(v.die, 6)}`
            : `${num(v.count, 1)}*{sta}d${num(v.die, 6)}`,
        parse: (f) => match(f, /^\{sta\}d(\d+)$/, (m) => ({ count: 1, die: +m[1] }))
                   ?? match(f, /^(\d+)\*\{sta\}d(\d+)$/, (m) => ({ count: +m[1], die: +m[2] }))
    },
    {
        id: "perStaminaFlat",
        label: "{n} for every Stamina spent",
        fields: [{ key: "n", min: 1, default: 5 }],
        build: (v) => `${num(v.n, 5)}*{sta}`,
        parse: (f) => match(f, /^(\d+)\*\{sta\}$/, (m) => ({ n: +m[1] }))
    },
    {
        id: "perMargin",
        label: "{count}d{die} for every point the roll beat the defence by, up to {cap}",
        fields: [{ key: "count", min: 1, default: 1 }, { key: "die", min: 2, default: 6, step: 2 },
                 { key: "cap", min: 1, default: 10 }],
        /* `count` was in the sentence and not in the formula: changing it from
         * 1 to 2 rewrote what the block SAID and left what it DID alone.
         * One die per point keeps the bare form so every corpus formula stays
         * byte-identical; more than one wraps the multiplier. */
        build: (v) => {
            const c = num(v.count, 1), cap = num(v.cap, 10), die = num(v.die, 6);
            return c === 1 ? `min(${cap},{margin})d${die}`
                           : `(${c}*min(${cap},{margin}))d${die}`;
        },
        parse: (f) => match(f, /^min\((\d+),\{margin\}\)d(\d+)$/,
                            (m) => ({ count: 1, cap: +m[1], die: +m[2] }))
            ?? match(f, /^\((\d+)\*min\((\d+),\{margin\}\)\)d(\d+)$/,
                     (m) => ({ count: +m[1], cap: +m[2], die: +m[3] }))
    },
    {
        id: "falloff",
        label: "{count}d{die}, losing a die for every target it has already passed through, never below {floor}d{die}",
        fields: [{ key: "count", min: 1, default: 8 }, { key: "die", min: 2, default: 6, step: 2 },
                 { key: "floor", min: 0, default: 1 }],
        build: (v) => `max(${num(v.floor, 1)},${num(v.count, 8)}-{index})d${num(v.die, 6)}`,
        parse: (f) => match(f, /^max\((\d+),(\d+)-\{index\}\)d(\d+)$/,
                            (m) => ({ floor: +m[1], count: +m[2], die: +m[3] }))
    },
    {
        /* Bronwyn's Gust throws them back as many metres as the roll beat the
         * defence by — the margin used as a plain number, not as dice. */
        id: "marginItself",
        label: "however far the roll beat the defence",
        fields: [],
        build: () => "{margin}",
        parse: (f) => f === "{margin}" ? {} : null
    },
    {
        /* Nature's Gift feeds as many people as the Stamina spent. */
        id: "staminaItself",
        label: "however much Stamina was spent",
        fields: [],
        build: () => "{sta}",
        parse: (f) => f === "{sta}" ? {} : null
    },
    {
        /* Blessing of Fortune: half the margin, capped. */
        id: "halfMargin",
        label: "half of how far the roll beat the defence, rounded down, up to {cap}",
        fields: [{ key: "cap", min: 1, default: 5 }],
        build: (v) => `min(${num(v.cap, 5)},floor({margin}/2))`,
        parse: (f) => match(f, /^min\((\d+),floor\(\{margin\}\/2\)\)$/, (m) => ({ cap: +m[1] }))
    },
    /* TWO DIFFERENT NUMBERS, and the book uses both.
     *
     * `{skill}` is what you ROLL with — rank plus the governing stat plus
     * modifiers. `{rank}` is the value printed on the sheet. "A bonus equal to
     * your Spell Casting" is the first; "5 ENC per 1 point of Spell Casting"
     * and "LUCK equal to your Spell Casting skill value times 3" are the
     * second, and every one of those quietly used the first until `{rank}`
     * existed — Luck of the Father handed out 48 points where the book gives
     * 12.
     *
     * Offered as separate shapes rather than one with a toggle, because the
     * label is the only thing an author reads and "points of Spell Casting"
     * is not the same phrase as "your Spell Casting roll". */
    {
        id: "perSkillPoint",
        label: "{n} for every point of Spell Casting (the value on the sheet)",
        fields: [{ key: "n", min: 1, default: 2 }],
        build: (v) => `${num(v.n, 2)}*{rank}`,
        parse: (f) => match(f, /^(\d+)\*\{rank\}$/, (m) => ({ n: +m[1] }))
    },
    {
        id: "shareOfSkillPoints",
        label: "Spell Casting (the value on the sheet) divided by {by}, rounded down",
        fields: [{ key: "by", min: 2, default: 2 }],
        build: (v) => `floor({rank}/${num(v.by, 2)})`,
        parse: (f) => match(f, /^floor\(\{rank\}\/(\d+)\)$/, (m) => ({ by: +m[1] }))
    },
    {
        id: "perSkill",
        label: "{n} for every point of your Spell Casting roll",
        fields: [{ key: "n", min: 1, default: 2 }],
        build: (v) => `${num(v.n, 2)}*{skill}`,
        parse: (f) => match(f, /^(\d+)\*\{skill\}$/, (m) => ({ n: +m[1] }))
    },
    {
        id: "shareOfSkill",
        label: "your Spell Casting roll divided by {by}, rounded down",
        fields: [{ key: "by", min: 2, default: 2 }],
        build: (v) => `floor({skill}/${num(v.by, 2)})`,
        parse: (f) => match(f, /^floor\(\{skill\}\/(\d+)\)$/, (m) => ({ by: +m[1] }))
    },
    {
        id: "step",
        label: "−1, worsening by 1 every 2 Stamina spent, no worse than −{cap}",
        fields: [{ key: "cap", min: 1, default: 4 }],
        build: (v) => `-min(${num(v.cap, 4)},1+floor(({sta}-1)/2))`,
        parse: (f) => match(f, /^-min\((\d+),1\+floor\(\(\{sta\}-1\)\/2\)\)$/, (m) => ({ cap: +m[1] }))
    },
    {
        id: "stepUncapped",
        label: "−1, worsening by 1 every 2 Stamina spent",
        fields: [],
        build: () => "-(1+floor(({sta}-1)/2))",
        parse: (f) => f === "-(1+floor(({sta}-1)/2))" ? {} : null
    }
]);

const num = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
};

const match = (f, re, take) => {
    const m = String(f ?? "").replace(/\s+/g, "").match(re);
    return m ? take(m) : null;
};

/** A shape by id. */
export function shapeById(id) {
    return SHAPES.find(s => s.id === id) ?? null;
}

/**
 * Read an existing formula back into a shape and its numbers.
 *
 * Returns `null` for anything no shape recognises — a GM who has hand-written
 * something exotic keeps it, and the editor falls back to the raw box rather
 * than mangling it into the nearest shape it half-matches.
 */
export function parseExpression(formula) {
    const src = String(formula ?? "").trim();
    if (!src) return null;
    for (const shape of SHAPES) {
        const values = shape.parse(src);
        if (values) return { id: shape.id, values };
    }
    return null;
}

/** Build the formula a shape and its numbers describe. */
export function buildExpression(id, values = {}) {
    const shape = shapeById(id);
    return shape ? shape.build(values) : null;
}

/**
 * The label with its numbers filled in — the sentence shown while choosing.
 *
 * Reads as the finished thing rather than as a form: "8d6, losing a die for
 * every target it has already passed through" is the setting AND its own
 * explanation.
 */
export function describeShape(id, values = {}) {
    const shape = shapeById(id);
    if (!shape) return "";
    return shape.label.replace(/\{(\w+)\}/g, (whole, key) => {
        const field = shape.fields.find(f => f.key === key);
        const v = values[key] ?? field?.default;
        return v == null ? whole : String(v);
    });
}


/* ── The picker's state, as data ───────────────────────────────────────────
 * Extracted so the thing a person actually operates can be tested. The dialog
 * around it is a shell: it renders what these return and calls back in.
 *
 * The first version rebuilt the dialog's HTML by hand whenever the shape
 * changed and re-fired a synthetic render event to re-attach listeners. That
 * is the kind of code that works until it doesn't, silently, in a dialog
 * somebody is halfway through using. */

/** Everything the picker needs to draw itself, for a given choice. */
export function builderView(chosen, values = {}) {
    return {
        chosen,
        /* EVERY shape's fields, not just the chosen one's. The dialog renders
         * them all once and hides the rest — so changing the dropdown shows a
         * different set with no re-render, no re-binding, and nothing to lose
         * mid-edit. */
        panels: SHAPES.map(shape => ({
            id: shape.id,
            active: shape.id === chosen,
            label: describeShape(shape.id, shape.id === chosen ? values : {}),
            fields: shape.fields.map(f => ({
                key: f.key,
                label: prettyKey(f.key),
                value: values[f.key] ?? f.default,
                min: f.min ?? 0,
                step: f.step ?? 1
            }))
        })),
        reads: describeShape(chosen, values),
        formula: buildExpression(chosen, values)
    };
}

/** Choosing a different shape. Its numbers start at that shape's defaults. */
export function chooseShape(id) {
    const shape = shapeById(id);
    if (!shape) return null;
    const values = Object.fromEntries(shape.fields.map(f => [f.key, f.default]));
    return { chosen: id, values };
}

/** Changing one number, clamped to what the field allows. */
export function setValue(chosen, values, key, raw) {
    const shape = shapeById(chosen);
    const field = shape?.fields.find(f => f.key === key);
    if (!field) return values;
    const n = Number(raw);
    /* `min: null` means "no floor", which is not the same as "unset". Using
     * `?? 0` for both is what made negative values unreachable. */
    const floor = field.min === null ? -Infinity : (field.min ?? 0);
    const safe = Number.isFinite(n) ? Math.max(floor, Math.round(n)) : field.default;
    return { ...values, [key]: safe };
}

/** Open on an existing value, or on a sensible default if there is none. */
export function openOn(formula) {
    const known = parseExpression(formula);
    if (known) return { ...known, custom: null };
    /* Unrecognised means hand-written. Kept verbatim and reported, rather than
     * approximated into whichever shape half-matches it. */
    return { ...chooseShape("dice"), custom: formula || null };
}

const prettyKey = (k) => ({
    n: "amount", count: "dice", die: "sides", cap: "limit",
    floor: "never below", by: "divided by"
}[k] ?? k);
