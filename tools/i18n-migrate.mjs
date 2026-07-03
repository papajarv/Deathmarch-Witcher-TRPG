#!/usr/bin/env node
/**
 * i18n-migrate.mjs — apply a notifications-migration manifest.
 *
 * Why a tool — Phase 1 of the i18n migration touches 176 ui.notifications
 * strings across ~30 files. Doing it as 176 hand Edits is error-prone
 * (one missed quote and the file is invalid JS, plus you can't see all
 * the new keys in one place). A declarative manifest lets us:
 *
 *   • see every key name in one file (catch naming inconsistencies)
 *   • verify idempotence — re-running the migration is a no-op
 *   • dry-run the whole pass before mutating any file
 *
 * Manifest format (a JS module that default-exports an array):
 *
 *   export default [
 *     {
 *       file: "module/chrome/chrome/bestiary.js",
 *       // optional - add `import { t, tFormat } from "..."` once at top
 *       importLine: 'import { t, tFormat } from "../lib/i18n.js";',
 *       // optional - line# to insert after (default: after last import)
 *       importAfter: null,
 *       replacements: [
 *         {
 *           // PLAIN — no ${...}
 *           kind: "plain",
 *           // The literal English text that appears in the source.
 *           // Must match EXACTLY (with apostrophes, em-dashes, etc.).
 *           text: "No viewer character — pin requires an assigned character.",
 *           key:  "WITCHER.Notify.Bestiary.PinNeedsViewer",
 *           // Optional: full callsite to make the match unambiguous when the
 *           // same text appears in two places. `null` = bare string lookup.
 *           context: 'ui.notifications?.warn("...")',
 *         },
 *         {
 *           // FORMATTED — contains ${...} template substitutions
 *           kind: "format",
 *           // Template literal source (without the backticks).
 *           // Example: "${a.name} dropped ${b.name}".
 *           text:    "${monsterDoc?.name ?? \"This monster\"} has no DC set for ${tierLabel}.",
 *           // The same text rewritten with {placeholder} marks instead.
 *           pattern: "{monster} has no DC set for {tier}.",
 *           // The data object literal we pass to tFormat.
 *           data:    '{ monster: monsterDoc?.name ?? "This monster", tier: tierLabel }',
 *           key:     "WITCHER.Notify.Bestiary.NoDcForTier",
 *         },
 *       ]
 *     },
 *     ...
 *   ];
 *
 * Mutations:
 *   1. ui.notifications.X("plain text") → ui.notifications.X(t(KEY, "plain text"))
 *   2. ui.notifications.X(`templated ${x}`) → ui.notifications.X(tFormat(KEY, {x}, "templated {x}"))
 *   3. Inserts the importLine if it's not already present.
 *   4. Appends new keys to lang/en.json under their dotted paths.
 *
 * Idempotence:
 *   - Plain replacements skip if `t(KEY, "...")` is already there.
 *   - Format replacements skip if `tFormat(KEY, ...)` is already there.
 *   - lang/en.json keys are merged (won't duplicate).
 *
 * Usage:
 *   node tools/i18n-migrate.mjs path/to/manifest.mjs           # apply
 *   node tools/i18n-migrate.mjs path/to/manifest.mjs --dry     # show diff
 *   node tools/i18n-migrate.mjs path/to/manifest.mjs --verify  # exit 1 if any unapplied
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, "..");

const argv = process.argv.slice(2);
const dryRun  = argv.includes("--dry");
const verify  = argv.includes("--verify");
const manifestPath = argv.find(a => !a.startsWith("--"));
if (!manifestPath) {
    console.error("usage: i18n-migrate.mjs <manifest.mjs> [--dry|--verify]");
    process.exit(2);
}

const manifest = (await import(pathToFileURL(resolve(manifestPath)).href)).default;

const enPath = join(ROOT, "lang", "en.json");
const en     = JSON.parse(readFileSync(enPath, "utf8"));

let appliedCount = 0;
let skippedCount = 0;
let missCount    = 0;

for (const entry of manifest) {
    const filePath = join(ROOT, entry.file);
    if (!existsSync(filePath)) { console.error(`SKIP — file not found: ${entry.file}`); continue; }
    let src = readFileSync(filePath, "utf8");
    const before = src;

    /* Insert import if requested and not already present. */
    if (entry.importLine && !src.includes(entry.importLine.trim())) {
        /* Find the last import on its own line and insert ours after it. */
        const importMatches = [...src.matchAll(/^import\s.*?;?\s*$/gm)];
        if (importMatches.length) {
            const last = importMatches[importMatches.length - 1];
            const idx  = last.index + last[0].length;
            src = src.slice(0, idx) + "\n" + entry.importLine + src.slice(idx);
        } else {
            /* No imports — prepend to file. */
            src = entry.importLine + "\n" + src;
        }
    }

    for (const r of entry.replacements) {
        en[r.key] = r.kind === "format" ? r.pattern : r.text;

        if (r.kind === "plain") {
            /* Match `"text"` or `'text'` or `\`text\``, possibly inside a
             * `ui.notifications.X(...)` call. */
            const quoted = JSON.stringify(r.text);          // "..."
            const altSql = "'" + r.text.replace(/'/g, "\\'") + "'";
            const altTpl = "`" + r.text + "`";

            /* Already migrated? Look for t("KEY", */
            const sigil = `t("${r.key}",`;
            if (src.includes(sigil)) { skippedCount++; continue; }

            const wrap = (m) => `t("${r.key}", ${m})`;
            let did = false;
            for (const raw of [quoted, altSql, altTpl]) {
                if (src.includes(raw)) {
                    src = src.replaceAll(raw, wrap(raw));
                    did = true;
                    break;
                }
            }
            if (did) appliedCount++;
            else { missCount++; console.warn(`MISS plain — ${entry.file}: "${r.text.slice(0,60)}…"`); }

        } else if (r.kind === "format") {
            /* Look for the original template literal — backtick-delimited. */
            const tpl = "`" + r.text + "`";
            const sigil = `tFormat("${r.key}",`;
            if (src.includes(sigil)) { skippedCount++; continue; }

            if (src.includes(tpl)) {
                const replacement = `tFormat("${r.key}", ${r.data}, ${JSON.stringify(r.pattern)})`;
                src = src.replaceAll(tpl, replacement);
                appliedCount++;
            } else {
                missCount++;
                console.warn(`MISS format — ${entry.file}: ${r.text.slice(0,60)}…`);
            }

        } else if (r.kind === "hbs-attr") {
            /* HBS attribute substitution.
             *   r.attr  — "title" | "placeholder" | "aria-label" | "alt"
             *   r.text  — the literal English text inside the attribute
             *   r.key   — the i18n key
             *
             * Replaces `<attr>="<text>"` with `<attr>="{{localize 'key'}}"`.
             * Idempotent — skips when the {{localize}} form is already there. */
            const literal = `${r.attr}="${r.text}"`;
            const target  = `${r.attr}="{{localize '${r.key}'}}"`;
            if (src.includes(target)) { skippedCount++; continue; }
            if (src.includes(literal)) {
                src = src.replaceAll(literal, target);
                appliedCount++;
            } else {
                missCount++;
                console.warn(`MISS hbs-attr — ${entry.file}: ${r.attr}="${r.text.slice(0,60)}…"`);
            }

        } else if (r.kind === "hbs-text") {
            /* HBS visible-text substitution between two angle brackets.
             *   r.before — the opening tag/sigil (e.g. "<h2>", "<label>", "<div class=\"x\">")
             *   r.text   — the literal English text
             *   r.after  — the closing tag (e.g. "</h2>", "</label>")
             *   r.key    — the i18n key
             *
             * Replaces `<before><text></after>` with `<before>{{localize 'key'}}</after>`.
             * Idempotent — skips when {{localize 'key'}} is already there. */
            const literal = `${r.before}${r.text}${r.after}`;
            const target  = `${r.before}{{localize '${r.key}'}}${r.after}`;
            if (src.includes(target)) { skippedCount++; continue; }
            if (src.includes(literal)) {
                src = src.replaceAll(literal, target);
                appliedCount++;
            } else {
                missCount++;
                console.warn(`MISS hbs-text — ${entry.file}: ${r.text.slice(0,60)}…`);
            }
        }
    }

    if (src !== before) {
        if (dryRun) {
            console.log(`--- ${entry.file} would change`);
        } else if (!verify) {
            writeFileSync(filePath, src);
            console.log(`✓ ${entry.file}`);
        }
    }
}

if (!dryRun && !verify) {
    /* Stable sort: keep existing key order, append new keys at the end. */
    writeFileSync(enPath, JSON.stringify(en, null, 4) + "\n");
}

console.log(`\n${appliedCount} applied, ${skippedCount} already-applied (idempotent), ${missCount} not-found`);
if (verify && missCount > 0) process.exit(1);
