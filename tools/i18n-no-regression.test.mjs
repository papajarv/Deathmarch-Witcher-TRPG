/**
 * Regression guard: zero hardcoded UI strings.
 *
 * The full chrome surface was migrated in 4 phases (1317 strings → 0).
 * This test re-runs the audit and fails the suite if any new hardcoded
 * literal sneaks back in — so a translator can still drop a new lang/XX.json
 * and ship a complete translation without source edits.
 *
 * Audit script: tools/audit-i18n.mjs.
 * Migration script: tools/i18n-migrate.mjs + tools/i18n-manifest-*.mjs.
 *
 * If a finding fires here, the right answer is almost always:
 *   1. Add a key to lang/en.json.
 *   2. Wrap the JS call in t() / tFormat() (import from chrome/lib/i18n.js).
 *      Or in HBS, wrap in {{localize 'KEY'}}.
 * Re-running the gen-hbs-*-manifest.mjs scripts + i18n-migrate.mjs will
 * handle the bulk-add case automatically.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

test("zero hardcoded UI strings — every chrome string lives in lang/en.json", () => {
    /* Run the audit in JSON mode and parse it. The audit walks
     * templates/ + module/chrome/ + module/applications/ + module/sheets/
     * looking for any string literal that looks like visible UI text and
     * isn't already wrapped in {{localize}} / game.i18n.* / our t() helper. */
    const out = execSync(`node ${join(__dirname, "audit-i18n.mjs")} --json`, {
        cwd: repoRoot,
        encoding: "utf8"
    });
    const audit = JSON.parse(out);
    if (audit.total !== 0) {
        /* Build a readable summary of the first few violations. */
        const samples = [];
        for (const [file, items] of Object.entries(audit.byFile)) {
            for (const it of items.slice(0, 3)) {
                samples.push(`  ${file}:${it.line} [${it.kind}] ${JSON.stringify(it.text).slice(0, 80)}`);
            }
            if (samples.length >= 20) break;
        }
        assert.fail(`Found ${audit.total} hardcoded UI string(s) across ${audit.files} file(s). Samples:\n${samples.join("\n")}\n\nFix: add a key to lang/en.json and wrap the literal with t() / tFormat() (JS) or {{localize}} (HBS). Re-run tools/i18n-gen-hbs-*-manifest.mjs + tools/i18n-migrate.mjs to bulk-apply for HBS attributes/text.`);
    }
});
