#!/usr/bin/env node
/**
 * audit-i18n.mjs — find hardcoded UI strings that should be in lang/en.json.
 *
 * Scans templates/ and module/chrome/ for visible text that bypasses i18n.
 * Outputs a markdown report grouped by file, plus a `--strict` mode that
 * exits non-zero if any new strings appear (regression guard).
 *
 * Run:
 *   node tools/audit-i18n.mjs              # human-readable report
 *   node tools/audit-i18n.mjs --json       # machine-readable
 *   node tools/audit-i18n.mjs --strict     # CI gate — exits 1 on any finding
 *
 * Heuristics — what counts as a UI string:
 *
 *   • Handlebars templates (.hbs):
 *       - >Text Like This< between tags, NOT a {{handlebars expr}}
 *       - title="...", placeholder="...", aria-label="..." literal values
 *       - <option value="...">Text</option>
 *
 *   • Chrome JS (.js/.mjs):
 *       - ui.notifications.warn/error/info("string literal")
 *       - element.title = "string literal"
 *       - element.textContent = "string literal"
 *       - element.placeholder = "string literal"
 *       - Element creation with literal innerText
 *
 *   • Filters out:
 *       - Strings already wrapped in game.i18n.localize / format
 *       - Strings inside the lang/en.json file's values (we WANT them there)
 *       - CSS class names, data-* attributes, DOM selectors
 *       - Test files (*.test.*)
 *       - Vendor bundles (minigames/vendor/*)
 *       - Code-comment-style strings (start with "//", "/*")
 *       - Single-token strings ≤2 chars (unit suffixes, etc.)
 *       - Numeric-only / regex-pattern-looking strings
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, "..");
const TEMPLATES = join(ROOT, "templates");
const CHROME    = join(ROOT, "module", "chrome");
const EXTRA_JS  = [
    join(ROOT, "module", "applications"),
    join(ROOT, "module", "sheets")
];

const argv = process.argv.slice(2);
const wantJson   = argv.includes("--json");
const wantStrict = argv.includes("--strict");

/* ── scanner: collect every .hbs / .js / .mjs in our scope ────────────── */

function* walk(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
            /* Skip vendor + test dirs. */
            if (/\b(vendor|node_modules)\b/.test(p)) continue;
            yield* walk(p);
        } else if (/\.(hbs|js|mjs)$/.test(e.name)) {
            if (/\.test\.(m?js)$/.test(e.name)) continue;
            yield p;
        }
    }
}

/* ── HBS scanner ─────────────────────────────────────────────────────── */

/* Character class is "everything that isn't a Handlebars expression,
 * angle bracket, or quote terminator." The bare `[^<>{}"]` catches text
 * that includes unicode (… — · » “ ” ’ ×) which an earlier whitelist
 * regex missed and that the audit/migration pipeline must see. */
const HBS_VISIBLE_TEXT = />\s*([A-Z][^<>{}"]{2,}?)\s*</g;
const HBS_ATTR_TEXT    = /\b(title|placeholder|aria-label|alt|data-tooltip)="([A-Z][^<>{}"]{2,}?)"/g;

function scanHbs(file, src) {
    const out = [];
    /* Skip lines that already have {{localize ...}} in the same tag. */
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/\{\{\s*localize\s/.test(line)) continue;
        let m;
        const seen = new Set();
        HBS_VISIBLE_TEXT.lastIndex = 0;
        while ((m = HBS_VISIBLE_TEXT.exec(line)) !== null) {
            const text = m[1].trim();
            if (skipText(text) || seen.has(text)) continue;
            seen.add(text);
            out.push({ file, line: i + 1, kind: "hbs-text", text });
        }
        HBS_ATTR_TEXT.lastIndex = 0;
        while ((m = HBS_ATTR_TEXT.exec(line)) !== null) {
            const attr = m[1];
            const text = m[2].trim();
            if (skipText(text) || seen.has(`${attr}=${text}`)) continue;
            seen.add(`${attr}=${text}`);
            out.push({ file, line: i + 1, kind: `hbs-${attr}`, text });
        }
    }
    return out;
}

/* ── JS scanner ──────────────────────────────────────────────────────── */

const JS_NOTIFICATION = /ui\.notifications\??\.\s*(warn|error|info|notify)\s*\(\s*["'`]([^"'`]+)["'`]/g;
const JS_TITLE_PROP   = /\.title\s*=\s*["'`]([A-Z][^"'`]{2,})["'`]/g;
const JS_TEXT_PROP    = /\.(textContent|innerText|placeholder)\s*=\s*["'`]([A-Z][^"'`]{2,})["'`]/g;
const JS_DIALOG_TITLE = /\btitle:\s*["'`]([A-Z][^"'`]{2,})["'`]/g;

function scanJs(file, src) {
    const out = [];
    const lines = src.split("\n");

    function emit(line0, kind, text) {
        if (skipText(text)) return;
        out.push({ file, line: line0 + 1, kind, text });
    }
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        /* Already wrapped in game.i18n.* → skip the whole line. */
        if (/game\.i18n\.(localize|format)/.test(line)) continue;
        /* Already wrapped in our t() / tFormat() helper → skip the whole
         * line. The fallback string parameter is allowed to be a literal
         * since the translator's contract guarantees the key is the
         * source of truth when present. */
        if (/\b(t|tFormat)\s*\(\s*["'`]WITCHER\./.test(line)) continue;
        /* Common code-comment lines — skip. */
        if (/^\s*(\/\/|\*)/.test(line)) continue;
        let m;
        JS_NOTIFICATION.lastIndex = 0;
        while ((m = JS_NOTIFICATION.exec(line)) !== null) emit(i, "js-notif", m[2]);
        JS_TITLE_PROP.lastIndex = 0;
        while ((m = JS_TITLE_PROP.exec(line)) !== null) emit(i, "js-title", m[1]);
        JS_TEXT_PROP.lastIndex = 0;
        while ((m = JS_TEXT_PROP.exec(line)) !== null) emit(i, `js-${m[1]}`, m[2]);
        JS_DIALOG_TITLE.lastIndex = 0;
        while ((m = JS_DIALOG_TITLE.exec(line)) !== null) emit(i, "js-dialog-title", m[1]);
    }
    return out;
}

/* ── filter ──────────────────────────────────────────────────────────── */

function skipText(t) {
    if (!t || t.length < 3) return true;
    /* Single uppercase token = likely abbreviation / enum value. */
    if (/^[A-Z][A-Z0-9_]+$/.test(t)) return true;
    /* CSS class / kebab-case attribute. */
    if (/^[a-z][a-z0-9-]+$/.test(t)) return true;
    /* Looks like a path / selector / URL. */
    if (/^[A-Za-z]+\.[A-Za-z]+/.test(t) && !/ /.test(t)) return true;
    if (/^(https?|file|data):/.test(t)) return true;
    /* Numeric-only or unit-only. */
    if (/^[-+0-9.,%× ]+$/.test(t)) return true;
    /* HTML entity / pseudo. */
    if (/^&[a-z]+;$/.test(t)) return true;
    /* Single word that's already a key fragment. */
    if (/^WITCHER\./.test(t)) return true;
    /* Looks like a regex or replace pattern. */
    if (/\\[a-z]/.test(t)) return true;
    return false;
}

/* ── run ─────────────────────────────────────────────────────────────── */

const findings = [];
for (const file of walk(TEMPLATES))    findings.push(...scanHbs(file, readFileSync(file, "utf8")));
for (const file of walk(CHROME))       findings.push(...scanJs(file,  readFileSync(file, "utf8")));
for (const dir of EXTRA_JS)
    for (const file of walk(dir))      findings.push(...scanJs(file,  readFileSync(file, "utf8")));

/* Group by file. */
const byFile = new Map();
for (const f of findings) {
    const rel = relative(ROOT, f.file);
    if (!byFile.has(rel)) byFile.set(rel, []);
    byFile.get(rel).push(f);
}

if (wantJson) {
    console.log(JSON.stringify({
        total: findings.length,
        files: byFile.size,
        byFile: Object.fromEntries(byFile)
    }, null, 2));
} else {
    /* Compact human report — sorted by file finding count desc. */
    const sorted = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length);
    console.log(`# i18n audit — ${findings.length} hardcoded UI strings in ${byFile.size} files\n`);
    for (const [rel, items] of sorted) {
        console.log(`\n## ${rel} (${items.length})`);
        for (const it of items.slice(0, 30)) {
            console.log(`  ${it.line.toString().padStart(4)}  [${it.kind}]  ${JSON.stringify(it.text)}`);
        }
        if (items.length > 30) console.log(`  … (+${items.length - 30} more)`);
    }
}

if (wantStrict && findings.length > 0) process.exit(1);
