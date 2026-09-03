/**
 * The expression language.
 *
 * Any numeric block input accepts an expression instead of a literal. This is
 * the decision that keeps trees flat enough to read on a canvas: if scaling
 * were a block, every scaled effect would need wrapping, and six of the ten
 * witcher signs plus most damage spells would nest a level deeper for nothing.
 *
 * It also made a real pattern visible. Yrden and Axii turn out to be the SAME
 * formula — `1+floor(({sta}-1)/2)`, Yrden merely capped at 4 — which is
 * invisible while they are two hand-written special cases.
 *
 * Deliberately tiny: five variables, four functions, arithmetic, and dice
 * passed through untouched. No user-defined functions, no loops, no property
 * access. Small enough to parse safely, validate at author time, and render
 * on a block face without a scrollbar.
 */

/* `skill` is the number you ROLL with (rank + stat + modifiers); `rank` is the
 * number printed on the sheet. The book uses both — "a bonus equal to your
 * Spell Casting" is the first, "5 ENC per point of Spell Casting" is the
 * second — and until `rank` existed every spell in the second group silently
 * used the first and inflated itself. */
const VARS = ["sta", "margin", "skill", "rank", "index", "vigor"];
const FUNCS = { min: Math.min, max: Math.max, floor: Math.floor, ceil: Math.ceil };

/* Anything that still looks like dice after substitution is handed to the
 * roller rather than evaluated here — "4d6", "{sta}d6", "min({margin},10)d6". */
const DICE_RE = /\d*d\d+/i;

/** Which variables an expression references — the validator uses this to
 *  reject `{margin}` on a spell whose defence is `none`, since no opposed
 *  step ever publishes it. */
export function referencedVars(expr) {
    return [...new Set([...String(expr ?? "").matchAll(/\{(\w+)\}/g)].map(m => m[1]))];
}

export function validateExpression(expr, available = VARS) {
    const problems = [];
    for (const v of referencedVars(expr)) {
        if (!VARS.includes(v)) problems.push(`"{${v}}" isn't a known value.`);
        else if (!available.includes(v)) problems.push(`"{${v}}" isn't available here yet.`);
    }
    const body = substitute(expr, Object.fromEntries(VARS.map(v => [v, 0])));
    if (/[^0-9+\-*/(),.\sdD]|[a-ce-zA-CE-Z]/.test(body.replace(/\b(min|max|floor|ceil)\b/g, ""))) {
        problems.push(`"${expr}" contains something the expression language doesn't allow.`);
    }
    return problems;
}

function substitute(expr, vars) {
    return String(expr ?? "").replace(/\{(\w+)\}/g, (_, k) => String(Number(vars?.[k]) || 0));
}

/**
 * Resolve an expression against the current scope.
 *
 * Returns a NUMBER when the expression is pure arithmetic, or a dice STRING
 * when dice survive substitution — the caller hands the latter to the roller.
 * Both are legitimate: `5*{sta}` is a shield pool, `{sta}d6` is damage.
 */
export function evaluate(expr, vars = {}) {
    if (typeof expr === "number") return expr;
    const body = substitute(expr, vars);

    if (DICE_RE.test(body)) {
        /* Fold any arithmetic wrapping the dice — "min(3,10)d6" → "3d6" —
         * so the roller only ever sees a clean formula. */
        return body.replace(/(min|max|floor|ceil)\(([^()]*)\)/g, (m, fn, args) => {
            const nums = args.split(",").map(s => safeArith(s));
            return nums.every(Number.isFinite) ? String(FUNCS[fn](...nums)) : m;
        });
    }
    const n = safeArith(body);
    return Number.isFinite(n) ? n : 0;
}

/**
 * Evaluate arithmetic without `eval`. Shunting-yard to RPN, then reduce.
 * Refuses anything that is not a number, operator, bracket, comma or one of
 * the four whitelisted functions — so a malformed or hostile expression
 * yields NaN rather than executing.
 */
function safeArith(src) {
    const s = String(src);
    /* Reject the whole string up front rather than tokenising what we can
     * salvage from it. Without this, "process.exit(1)" tokenised down to
     * "(", "1", ")" and quietly evaluated to 1 — it never executed, but
     * manufacturing a number out of garbage is its own bug. */
    if (/[^0-9+\-*/(),.\s]/.test(s.replace(/\b(min|max|floor|ceil)\b/g, ""))) return NaN;

    const tokens = s.match(/\d+\.?\d*|[-+*/(),]|min|max|floor|ceil/g);
    if (!tokens) return NaN;

    const prec = { "+": 1, "-": 1, "*": 2, "/": 2 };
    const out = [], ops = [];

    for (const [i, tk] of tokens.entries()) {
        if (/^\d/.test(tk)) out.push(Number(tk));
        else if (tk in FUNCS) ops.push(tk);
        else if (tk === ",") { while (ops.length && ops.at(-1) !== "(") out.push(ops.pop()); }
        else if (tk === "(") ops.push(tk);
        else if (tk === ")") {
            while (ops.length && ops.at(-1) !== "(") out.push(ops.pop());
            if (ops.at(-1) === "(") ops.pop();
            if (ops.at(-1) in FUNCS) out.push(ops.pop());
        } else if (tk in prec) {
            /* Unary minus: a leading "-", or one following another operator
             * or an opening bracket. */
            const prev = tokens[i - 1];
            if (tk === "-" && (i === 0 || prev === "(" || prev === "," || prev in prec)) { out.push(0); }
            while (ops.length && prec[ops.at(-1)] >= prec[tk]) out.push(ops.pop());
            ops.push(tk);
        } else return NaN;
    }
    while (ops.length) out.push(ops.pop());

    const st = [];
    for (const tk of out) {
        if (typeof tk === "number") { st.push(tk); continue; }
        if (tk in FUNCS) {
            /* min/max take two arguments here; floor/ceil take one. */
            const arity = (tk === "floor" || tk === "ceil") ? 1 : 2;
            const args = st.splice(-arity);
            if (args.length !== arity) return NaN;
            st.push(FUNCS[tk](...args));
            continue;
        }
        const b = st.pop(), a = st.pop();
        if (a === undefined || b === undefined) return NaN;
        st.push(tk === "+" ? a + b : tk === "-" ? a - b : tk === "*" ? a * b : a / b);
    }
    return st.length === 1 ? st[0] : NaN;
}


/**
 * Substitute `{name}` into a STRING argument.
 *
 * Found by authoring Cursed Illness, which pays 2/4/6 STA for staggered /
 * stunned / poisoned. The band chosen at cost time IS the effect, so the
 * status block's argument has to name it — and `evaluate()` cannot help,
 * because it only ever produces a number. Without this, `status: "{band}"`
 * reaches Foundry as the literal five characters, and the spell silently
 * applies a condition that does not exist.
 *
 * Deliberately NOT arithmetic. A string slot interpolates names and nothing
 * else; anything that needs a number uses a numeric slot and `evaluate`.
 */
export function resolveText(text, scope = {}) {
    if (typeof text !== "string") return text;
    return text.replace(/\{(\w+)\}/g, (whole, key) =>
        key in scope && scope[key] != null ? String(scope[key]) : whole);
}

/** Does this string reference anything the scope would have to supply? */
export function referencedNames(text) {
    return typeof text === "string" ? [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]) : [];
}
