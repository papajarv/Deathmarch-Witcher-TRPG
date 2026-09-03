/**
 * Weight string → kilograms parser.
 *
 * Handles the full range of formats that appear in Witcher TRPG monster data:
 *
 *   Numeric    "150 kg"  "800kg"  "90kg"  "950"  "1.5 tons"  "300 lbs"
 *   Ranges     "150-200 kg"  (returns midpoint)
 *   Approx     "~150 kg"  "about 150 kg"  "around 150 kg"
 *   Word nums  "one ton"  "two tons"  "three hundred kg"
 *   Fractions  "half a ton"  "a quarter ton"  "a third of a ton"
 *   Compound   "three quarters of a ton"  "two thirds of a ton"
 *   Mixed      "one and a half tons"  "two and a half tons"
 *   Article    "a ton"  (= 1 ton)
 *
 * All outputs are in kg (metric). Conversion factors:
 *   1 ton / tonne  = 1 000 kg
 *   1 lb / pound   = 0.453592 kg
 *
 * Returns 0 when the input cannot be resolved.
 */

/* ── Vocabulary ──────────────────────────────────────────────────────────── */

const ONES = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
    sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS = {
    twenty: 20, thirty: 30, forty: 40, fifty: 50,
    sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const MAGNITUDES = { hundred: 100, thousand: 1000 };

// English simple fractions → decimal
const SIMPLE_FRACS = {
    half: 0.5,
    quarter: 0.25,
    third: 1 / 3,
    eighth: 0.125,
};
// Numerator words used in compound fractions ("two thirds", "three quarters")
const FRAC_NUMERATORS = { two: 2, three: 3, four: 4, five: 5 };
const FRAC_DENOMINATORS = {
    halves: 2, thirds: 3, quarters: 4, fifths: 5, eighths: 8,
    // also accept singular forms in context
    half: 2, third: 3, quarter: 4, fifth: 5, eighth: 8,
};

/* ── Unit detection ──────────────────────────────────────────────────────── */

function unitFactor(text) {
    if (/\b(?:metric\s+)?(?:ton|tonne)s?\b/.test(text)) return 1000;
    if (/\b(?:lb|lbs|pound|pounds)\b/.test(text)) return 0.453592;
    return 1; // default: kg (or bare number treated as kg)
}

/* ── Word-number parser ───────────────────────────────────────────────────
   Converts an English cardinal like "three hundred and fifty" → 350.
   Handles ones, teens, tens, hundreds, thousands.
   Returns null if nothing is found.
   ───────────────────────────────────────────────────────────────────────── */

function parseWordNumber(text) {
    // Build a running total with a simple accumulator approach
    const tokens = text.replace(/\band\b/g, "").split(/[\s,\-]+/).filter(Boolean);
    let total = 0;
    let current = 0;
    let found = false;

    for (const tok of tokens) {
        if (tok in ONES)       { current += ONES[tok]; found = true; }
        else if (tok in TENS)  { current += TENS[tok]; found = true; }
        else if (tok === "hundred") {
            if (current === 0) current = 1;
            current *= 100;
            found = true;
        } else if (tok === "thousand") {
            if (current === 0) current = 1;
            total += current * 1000;
            current = 0;
            found = true;
        }
    }
    return found ? total + current : null;
}

/* ── Fraction parsers ────────────────────────────────────────────────────── */

// "two thirds", "three quarters", "four fifths" etc.
function resolveCompoundFraction(text) {
    for (const [numWord, num] of Object.entries(FRAC_NUMERATORS)) {
        for (const [denWord, den] of Object.entries(FRAC_DENOMINATORS)) {
            const re = new RegExp(`\\b${numWord}\\s+${denWord}\\b`);
            if (re.test(text)) return num / den;
        }
    }
    return null;
}

// "half", "a quarter", "a third", "one quarter" etc.
function resolveSimpleFraction(text) {
    // Lone "a" or "one" + fraction word
    for (const [word, val] of Object.entries(SIMPLE_FRACS)) {
        const re = new RegExp(`(?:^|\\b(?:a|an|one)\\s+)${word}\\b`);
        if (re.test(text)) return val;
        // Bare fraction word as the only token
        if (new RegExp(`^\\s*${word}\\s*$`).test(text.replace(/\b(a|an|one|of|the|ton|tonne|kg|kilogram|kilogramme)s?\b/g, "").trim())) return val;
    }
    return null;
}

// "one and a half", "two and a half", "three and a quarter" etc.
function resolveWholeAndFraction(text) {
    for (const [fracWord, fracVal] of Object.entries(SIMPLE_FRACS)) {
        // e.g. "two and a half" → /\btwo\s+and\s+(a\s+)?half\b/
        const re = new RegExp(`\\b(\\w+)\\s+and\\s+(?:a\\s+)?${fracWord}\\b`);
        const m = text.match(re);
        if (!m) continue;
        const wholePart = ONES[m[1]] ?? TENS[m[1]] ?? null;
        if (wholePart !== null) return wholePart + fracVal;
    }
    return null;
}

/* ── Core resolver ───────────────────────────────────────────────────────── */

function resolveValue(text) {
    // 1. Compound fraction  ("three quarters of a ton")
    const comp = resolveCompoundFraction(text);
    if (comp !== null) return comp;

    // 2. Whole + fraction  ("one and a half tons")
    const whf = resolveWholeAndFraction(text);
    if (whf !== null) return whf;

    // 3. Simple fraction   ("half a ton", "a quarter ton")
    const sf = resolveSimpleFraction(text);
    if (sf !== null) return sf;

    // 4. Numeric range     "150-200 kg" → midpoint
    const rangeMatch = text.match(/(\d+(?:[.,]\d+)?)\s*[-–—]\s*(\d+(?:[.,]\d+)?)/);
    if (rangeMatch) {
        const a = parseFloat(rangeMatch[1].replace(",", "."));
        const b = parseFloat(rangeMatch[2].replace(",", "."));
        return (a + b) / 2;
    }

    // 5. Plain numeric     "150 kg", "800kg", "~950"
    const numMatch = text.match(/[\d]+(?:[.,]\d+)?/);
    if (numMatch) return parseFloat(numMatch[0].replace(",", "."));

    // 6. Word number       "one ton", "two hundred kg"
    // Only if no digit was found above — prevents double-counting
    const wn = parseWordNumber(text);
    if (wn !== null && wn > 0) return wn;

    // 7. Bare "a/an" + unit means 1  ("a ton")
    if (/\b(a|an)\s+(ton|tonne|kg|pound|lb)/.test(text)) return 1;

    return null;
}

/* ── Public API ──────────────────────────────────────────────────────────── */

/**
 * Parse a weight string and return kilograms as a number.
 * Returns 0 if the input cannot be resolved.
 *
 * @param {string|number} raw
 * @returns {number}
 */
export function parseWeightKg(raw) {
    if (typeof raw === "number") return raw;

    const text = String(raw ?? "")
        .replace(/<[^>]+>/g, " ")  // strip any HTML tags
        .toLowerCase()
        .replace(/[()[\]]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    if (!text) return 0;

    const factor = unitFactor(text);
    const value  = resolveValue(text);

    if (value === null) return 0;
    return parseFloat((value * factor).toFixed(2));
}
