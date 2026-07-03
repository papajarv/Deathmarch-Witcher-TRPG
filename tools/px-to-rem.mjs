#!/usr/bin/env node
/**
 * px-to-rem.mjs — convert fixed px in styles/*.css to rem (base 16px).
 *
 * Why — the system was authored on a small laptop and used fixed px
 * throughout. On a larger external monitor at the same 2K resolution,
 * everything reads too small. Converting to rem lets Foundry's
 * Configure Settings → UI Scale (and browser zoom) globally rescale
 * the whole system UI.
 *
 * Run:
 *   node tools/px-to-rem.mjs                 # in-place rewrite of styles/*.css
 *   node tools/px-to-rem.mjs --dry-run       # report counts, write nothing
 *   node tools/px-to-rem.mjs --diff          # print unified-ish diff per file
 *
 * Preserved as px (intentional — converting these creates rendering bugs):
 *   - Border widths:  border, border-*, border-*-width, outline, outline-width
 *   - Drop shadows:   box-shadow, text-shadow, filter (drop-shadow blur/offset)
 *   - Hairline separators: width/height/min-width/min-height/max-width/max-height
 *     when the entire value is 1px or 2px.
 *   - 0px (stays 0).
 *
 * Everything else (font-size, padding, margin, gap, top/right/bottom/left,
 * border-radius, width, height when not a hairline, etc.) converts at 16px = 1rem.
 *
 * Conversion is precise to 4 decimal places and trailing zeros are dropped:
 *   8px  -> 0.5rem
 *   16px -> 1rem
 *   24px -> 1.5rem
 *   13px -> 0.8125rem
 *   1px  (in non-border ctx) -> 0.0625rem
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const stylesDir = join(repoRoot, "styles");

const PRESERVE_PROPS = new Set([
    "border", "border-top", "border-right", "border-bottom", "border-left",
    "border-block", "border-block-start", "border-block-end",
    "border-inline", "border-inline-start", "border-inline-end",
    "border-width",
    "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
    "border-block-width", "border-inline-width",
    "outline", "outline-width", "outline-offset",
    "box-shadow", "text-shadow", "filter", "backdrop-filter",
    "-webkit-box-shadow", "-webkit-text-shadow", "-webkit-filter",
]);

const HAIRLINE_PROPS = new Set([
    "width", "height",
    "min-width", "min-height",
    "max-width", "max-height",
]);

const PX_TOKEN = /(\d+(?:\.\d+)?)px\b/g;

function pxToRem(px) {
    const n = parseFloat(px);
    if (n === 0) return "0";
    const rem = n / 16;
    // 4-decimal round, drop trailing zeros
    const fixed = rem.toFixed(4).replace(/\.?0+$/, "");
    return `${fixed}rem`;
}

function convertValue(prop, value) {
    if (PRESERVE_PROPS.has(prop)) return value;

    if (HAIRLINE_PROPS.has(prop)) {
        // Entire value is 1px or 2px (with optional whitespace) -> hairline, keep px.
        if (/^\s*[12]px\s*$/.test(value)) return value;
    }

    return value.replace(PX_TOKEN, (_m, num) => pxToRem(num));
}

function transform(css) {
    // 1) Mask comments so declarations inside comments aren't rewritten.
    const comments = [];
    css = css.replace(/\/\*[\s\S]*?\*\//g, (m) => {
        const idx = comments.push(m) - 1;
        return `/*__C${idx}__*/`;
    });

    // 2) Match declarations: property: value(until ; or })
    // Each capture preserves the original surrounding whitespace so multi-line
    // values, indentation, and blank-line gaps all survive intact.
    //   $1 lead       — { or ; that ends the previous decl / opens the block
    //   $2 wsBefore   — whitespace + newline + indent before the property name
    //   $3 prop       — property name (allows --custom-prop)
    //   $4 wsColonL   — whitespace between prop and ':'
    //   $5 wsColonR   — whitespace between ':' and value (may include newlines)
    //   $6 value      — the value content, lazy up to the next ; or }
    css = css.replace(
        /([{;])([\s]*)(-{0,2}[a-zA-Z][\w-]*)(\s*):(\s*)([^;{}]+?)(?=\s*[;}])/g,
        (_full, lead, wsBefore, prop, wsColonL, wsColonR, value) => {
            const lower = prop.toLowerCase();
            const newValue = convertValue(lower, value);
            return `${lead}${wsBefore}${prop}${wsColonL}:${wsColonR}${newValue}`;
        }
    );

    // 3) Restore comments.
    css = css.replace(/\/\*__C(\d+)__\*\//g, (_m, idx) => comments[parseInt(idx, 10)]);

    return css;
}

function countPxOccurrences(css) {
    return (css.match(PX_TOKEN) || []).length;
}

function diffSummary(before, after) {
    const beforeLines = before.split("\n");
    const afterLines = after.split("\n");
    let changed = 0;
    for (let i = 0; i < Math.max(beforeLines.length, afterLines.length); i++) {
        if (beforeLines[i] !== afterLines[i]) changed++;
    }
    return changed;
}

function main() {
    const args = new Set(process.argv.slice(2));
    const dryRun = args.has("--dry-run");
    const showDiff = args.has("--diff");

    const files = readdirSync(stylesDir)
        .filter((f) => f.endsWith(".css"))
        .map((f) => join(stylesDir, f));

    let totalBefore = 0;
    let totalAfter = 0;
    let totalChangedLines = 0;
    let filesTouched = 0;

    for (const file of files) {
        const before = readFileSync(file, "utf8");
        const after = transform(before);
        const beforeCount = countPxOccurrences(before);
        const afterCount = countPxOccurrences(after);
        const changedLines = diffSummary(before, after);

        totalBefore += beforeCount;
        totalAfter += afterCount;
        totalChangedLines += changedLines;

        if (before !== after) {
            filesTouched++;
            const rel = file.replace(repoRoot + "/", "");
            console.log(
                `${rel.padEnd(40)}  px ${String(beforeCount).padStart(4)} -> ${String(afterCount).padStart(4)}   (${changedLines} lines changed)`
            );

            if (showDiff) {
                const beforeLines = before.split("\n");
                const afterLines = after.split("\n");
                for (let i = 0; i < Math.max(beforeLines.length, afterLines.length); i++) {
                    if (beforeLines[i] !== afterLines[i]) {
                        console.log(`  @${i + 1}`);
                        if (beforeLines[i] !== undefined) console.log(`  - ${beforeLines[i]}`);
                        if (afterLines[i] !== undefined) console.log(`  + ${afterLines[i]}`);
                    }
                }
            }

            if (!dryRun) writeFileSync(file, after, "utf8");
        }
    }

    console.log("");
    console.log(`Total px occurrences: ${totalBefore} -> ${totalAfter} (preserved: ${totalAfter})`);
    console.log(`Files touched: ${filesTouched} / ${files.length}`);
    console.log(`Lines changed: ${totalChangedLines}`);
    if (dryRun) console.log("(dry-run — no files written)");
}

main();
