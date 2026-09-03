/**
 * Module-scope state must be declared.
 *
 * `stealth-spotter-vision.mjs` assigned and read four module variables that
 * were never declared — `_cachedMetersContainer`, `_cachedPaceContainer`,
 * `_paceDropTimer` and `_lastMovedAt`. In strict-mode ESM every one of those
 * throws `ReferenceError`, and they did: the spotter overlay's refresh failed
 * on every token move, silently caught and logged as a warning. It surfaced
 * only because a spell test moved tokens and read the console.
 *
 * SCOPE: this checks identifiers beginning with `_`, which is this codebase's
 * convention for module-level mutable state. It deliberately does not try to
 * catch every undeclared reference. That was attempted and abandoned: without
 * a real parser the same sweep produced 305 candidates that were almost all
 * class methods called through `this`, `#private` members, and Promise
 * executor parameters. A test nobody believes is a test nobody runs.
 *
 * The gap is real and worth knowing about. `metresSinceLastMark` — called in
 * `stealth-spotter-vision.mjs`, defined and never exported in
 * `stealth-pace-indicator.mjs` — is exactly the bug this cannot see, and it
 * took out that file's whole `updateToken` handler. Catching that class needs
 * scope analysis (acorn or similar), which is a dependency decision rather
 * than a test decision.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/* `vendor` is third-party code we neither wrote nor can fix. */
const SKIP = new Set(["node_modules", ".git", "packs", "vendor"]);

function sources(dir = HERE, out = []) {
    for (const entry of readdirSync(dir)) {
        if (SKIP.has(entry)) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) { sources(full, out); continue; }
        if (/\.(mjs|js)$/.test(entry) && !/\.test\.mjs$/.test(entry)) out.push(full);
    }
    return out;
}

/* Comments and string/template literals removed so their contents can't look
 * like code. Crude, but it only has to be good enough to avoid false alarms. */
function strip(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/^\s*\/\/.*$/gm, " ")
        .replace(/`(?:\\[\s\S]|[^\\`])*`/g, "``")
        .replace(/'(?:\\.|[^\\'])*'/g, "''")
        .replace(/"(?:\\.|[^\\"])*"/g, '""');
}

test("every _-prefixed module variable that is assigned is also declared", () => {
    const problems = [];
    for (const file of sources()) {
        const raw = readFileSync(file, "utf8");
        const body = strip(raw);

        /* `_foo =` but not `x._foo =`, `==`, `=>` or `>=`. */
        const assigned = new Set([...body.matchAll(/(?<![.\w$])(_[A-Za-z]\w*)\s*=(?![=>])/g)].map(m => m[1]));
        if (!assigned.size) continue;

        for (const name of assigned) {
            /* Deliberately searched in the RAW source, not the stripped copy.
             * The stripper is crude — an apostrophe in a trailing comment can
             * swallow the line that declares something — and the two error
             * modes are not equal: a missed bug costs nothing today, while a
             * false alarm gets the whole test switched off. So anything that
             * looks remotely like a declaration counts as one.
             *
             * A class field (`_sortField = "name"` in a class body, read as
             * `this._sortField`) is a declaration too, and looks exactly like
             * a bare assignment — `this.` is what distinguishes it. */
            const declared =
                new RegExp(`\\b(?:let|const|var)\\s+${name}\\b`).test(raw) ||
                new RegExp(`\\bthis\\.${name}\\b`).test(raw) ||
                new RegExp(`\\bstatic\\s+${name}\\b`).test(raw) ||
                new RegExp(`\\bfunction\\s+${name}\\b`).test(raw) ||
                new RegExp(`\\bclass\\s+${name}\\b`).test(raw) ||
                /* Destructuring / params: same LINE only. Allowing \s here let
                 * `if (...) {\n    _x = null;` read as a destructuring pattern,
                 * which made the whole check vacuous — it passed even with the
                 * real declaration deleted. */
                new RegExp(`[{,][ \\t]*${name}[ \\t]*[,}=:]`).test(raw) ||
                new RegExp(`\\([^)\\n]*\\b${name}\\b[^)\\n]*\\)[ \\t]*=>`).test(raw) ||
                /* A parameter with a default — `function f(_worldTime = 0)` —
                 * reads exactly like a bare assignment. */
                new RegExp(`\\bfunction\\s*\\w*\\s*\\([^)]*\\b${name}\\b`).test(raw);

            if (!declared) {
                problems.push(`${relative(HERE, file)}: "${name}" is assigned but never declared — ReferenceError`);
            }
        }
    }
    assert.deepEqual(problems, [], "\n" + problems.join("\n"));
});
