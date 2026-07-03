#!/usr/bin/env node
/**
 * Generates the Phase 4 manifest — visible HBS text between angle brackets.
 *
 * The audit-i18n.mjs tool found 689 such strings; doing them by hand is
 * untenable. This script re-scans each .hbs file and emits a manifest
 * entry per `>VisibleText<` occurrence, with EXACT surrounding bytes so
 * the migration tool can do a precise replaceAll.
 *
 * Key shape — same `WITCHER.<area>.Text.<slug>` style as Phase 3.
 *
 * Skip rules — text that:
 *   • contains a Handlebars expression  (it isn't a pure literal)
 *   • is already wrapped in {{localize}} (idempotent re-runs)
 *   • is part of an attribute (`>` inside `attr="..."` is impossible
 *     because we anchor on closing `>`)
 *   • is less than 3 chars (CSS hooks, unit suffixes)
 *
 * Match: />(\s*)([Visible text])(\s*)</  — only when text begins with
 * a capital letter or non-CSS-class-looking character.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, "..");
const TEMPLATES = join(ROOT, "templates");

function* walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) yield* walk(p);
        else if (e.name.endsWith(".hbs")) yield p;
    }
}

function keyPrefixFor(file) {
    const parts = file.split("/").slice(1);
    if (parts[0] === "actor") return `Sheet.${toPascal(parts[1])}`;
    if (parts[0] === "item") return `Sheet.${toPascal(parts[1].replace(/\.hbs$/, ""))}`;
    if (parts[0] === "applications") return `App.${toPascal(parts[1].replace(/\.hbs$/, ""))}`;
    if (parts[0] === "inspection") return `Inspect.${toPascal(parts[1].replace(/\.hbs$/, ""))}`;
    if (parts[0] === "active-effect") return `Effect.${toPascal(parts[1].replace(/\.hbs$/, ""))}`;
    if (parts[0] === "chat") return `Chat.${toPascal(parts[1].replace(/\.hbs$/, ""))}`;
    if (parts[0] === "investigation") return `Invest.${toPascal(parts[1].replace(/\.hbs$/, ""))}`;
    return parts.map(p => toPascal(p.replace(/\.hbs$/, ""))).join(".");
}
function toPascal(s) {
    return s.split(/[-_/]/g).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join("");
}
function slugify(text) {
    return text
        .replace(/&[a-z]+;/g, " ")
        .replace(/[^A-Za-z0-9 ]+/g, " ")
        .trim()
        .split(/\s+/)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join("")
        .slice(0, 40) || "Text";
}

const manifest = [];
const seenKeys = new Set();
let totalFindings = 0;

for (const file of walk(TEMPLATES)) {
    const rel = relative(ROOT, file);
    const src = readFileSync(file, "utf8");
    const prefix = keyPrefixFor(rel);

    const seenInFile = new Map(); // text → key (so duplicates in one file share a key)
    const replacements = [];

    /* Iterate line-by-line; per line, find every >ws TEXT ws< match.
     * Skip the line if it contains {{localize}} or {{ ... }} interpolation. */
    const lines = src.split("\n");
    for (const line of lines) {
        if (/\{\{\s*localize\s/.test(line)) continue;
        /* The regex below captures: (>)(ws)(text)(ws)(<).
         * We require text to START with a letter (filters whitespace-only) and
         * not look like a CSS class (which would be all-lowercase no-spaces). */
        /* Broad char class — matches anything that isn't an angle
         * bracket, brace, or quote terminator. Picks up unicode chars
         * (… — · » “ ” ’ ×) that a whitelisted class would miss. */
        const re = />(\s*)([A-Z][^<>{}"]{1,}?)(\s*)</g;
        let m;
        while ((m = re.exec(line)) !== null) {
            const before = ">" + m[1];
            const after  = m[3] + "<";
            const text   = m[2];
            /* Same skip filters as the audit. */
            if (text.length < 3) continue;
            if (/^[A-Z][A-Z0-9_]+$/.test(text)) continue;
            if (/^WITCHER\./.test(text)) continue;
            /* The line could ALSO have a {{handlebars}} expression in the
             * SAME tag — if so the captured "text" might include a `{{`.
             * Reject any text with handlebars syntax. */
            if (/[{}]/.test(text)) continue;

            totalFindings++;

            let key = seenInFile.get(text);
            if (!key) {
                key = `WITCHER.${prefix}.Text.${slugify(text)}`;
                let n = 2;
                while (seenKeys.has(key)) {
                    key = `WITCHER.${prefix}.Text.${slugify(text)}${n++}`;
                }
                seenInFile.set(text, key);
                seenKeys.add(key);
            }
            /* Don't duplicate identical literal triples within the file. */
            const dedup = JSON.stringify({ before, text, after, key });
            if (replacements.some(r => JSON.stringify(r) === dedup)) continue;
            replacements.push({ kind: "hbs-text", before, text, after, key });
        }
    }
    if (replacements.length) manifest.push({ file: rel, replacements });
}

const out = `/**
 * AUTO-GENERATED — do not hand-edit. Re-run:
 *   node tools/i18n-gen-hbs-text-manifest.mjs > tools/i18n-manifest-hbs-text.mjs
 *
 * Phase 4 of the i18n migration: every literal text between two HBS tag
 * boundaries moves into a lang/en.json key (WITCHER.<area>.Text.<slug>).
 * Total: ${totalFindings} findings across ${manifest.length} files.
 */
export default ${JSON.stringify(manifest, null, 4)};
`;
console.log(out);
