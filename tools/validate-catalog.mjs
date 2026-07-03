/**
 * validate-catalog.mjs — sanity-check every quality key referenced by the
 * generated EO catalog against the live ARMOR_QUALITIES + WEAPON_QUALITIES
 * tables in module/setup/config.mjs.
 *
 * Reports:
 *   - keys referenced by items that aren't in the matching catalog
 *   - inconsistent terminology in item description text (e.g. "Concealable"
 *     when the catalog label is "Concealment")
 *   - shield items using weapon-only keys
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const cfgSrc = readFileSync(resolve(ROOT, "module/setup/config.mjs"), "utf8");

/* Pull keys + labels out of WEAPON_QUALITIES and ARMOR_QUALITIES. */
function extractCatalog(src, marker) {
    const start = src.indexOf(`${marker} = Object.freeze({`);
    if (start < 0) throw new Error(`${marker} not found`);
    /* Find the matching closing brace by depth-counting. */
    let depth = 0, i = start + marker.length;
    while (i < src.length) {
        const c = src[i];
        if (c === "{") depth++;
        else if (c === "}") { depth--; if (depth === 0) break; }
        i++;
    }
    const block = src.slice(start, i + 1);
    /* Crude but reliable: each entry is `<key>: wq("<Label>", ...` or
     * `aq("<Label>", ...`. Capture the key + label. */
    const entries = {};
    /* Match both `wq(` and any future `aq(` helper — defensive against a
     * helper rename in config.mjs. */
    const re = /^\s{2,8}([a-zA-Z][a-zA-Z0-9]*)\s*:\s*[wa]q\("([^"]+)"/gm;
    let m;
    while ((m = re.exec(block)) !== null) {
        entries[m[1]] = m[2];
    }
    return entries;
}

const WQ = extractCatalog(cfgSrc, "export const WEAPON_QUALITIES");
const AQ = extractCatalog(cfgSrc, "export const ARMOR_QUALITIES");
const ALL = { ...WQ, ...AQ };

console.log(`Catalog: ${Object.keys(WQ).length} weapon, ${Object.keys(AQ).length} armor qualities`);

const issues = [];
const noteWarn = (file, msg) => issues.push({ kind: "warn", file, msg });
const noteErr  = (file, msg) => issues.push({ kind: "error", file, msg });

/* Walk packs-src and inspect every item. Folder docs (filename starts
 * with `_folder_`) are skipped — they carry no qualities/descriptions. */
const packDirs = ["eo-weapons", "eo-armor", "eo-armor-enhancements"];
for (const pd of packDirs) {
    const dir = resolve(ROOT, "packs-src", pd);
    if (!readdirSync(dir, { withFileTypes: false })) continue;
    const files = readdirSync(dir).filter(f => f.endsWith(".json") && !f.startsWith("_folder_"));
    for (const f of files) {
        const doc = JSON.parse(readFileSync(resolve(dir, f), "utf8"));
        const sys = doc.system ?? {};

        /* 1. Verify referenced quality keys exist in the catalog. */
        for (const key of sys.qualities ?? []) {
            if (!(key in ALL)) {
                noteErr(`${pd}/${f}`, `unknown quality key: "${key}" (catalog has no entry — chip will render as raw text)`);
            }
        }

        /* 2. Shield-specific keys: a shield using weapon-only keys is a bug. */
        if (doc.type === "shield") {
            const swaps = {
                sturdy:        "sturdyShield",
                parrying:      "parryingShield",
                bladeCatcher:  "bladeCatcherArmor"
            };
            for (const key of sys.qualities ?? []) {
                if (swaps[key]) {
                    noteErr(`${pd}/${f}`, `shield uses weapon-only key "${key}" — should be "${swaps[key]}"`);
                }
            }
        }

        /* 3. Description text consistency: scan for known catalog-label drift.
         *    The chip uses the catalog `label`; descriptions should mirror it
         *    so a user reading the body text and the chip see the same term. */
        const desc = sys.description ?? "";
        const labelDrift = [
            { wrong: /\bConcealable\b/i,                    right: "Concealment"             },
            { wrong: /\bForage \(/i,                        right: "Foraging"                },
            { wrong: /\bClose[- ]Quarters Combat\b/i,       right: "Close Quarters"          },
            { wrong: /\bImproved AP\b/i,                    right: "Improved Armor Piercing" },
            { wrong: /\bArmor Piercing\b\s*\([^)]*Improved/i, right: "Improved Armor Piercing" },
            { wrong: /\bClose Combat\b/,                    right: "Close Quarters"          },
            { wrong: /\bForaging \(legacy/i,                right: "Foraging"                },
            { wrong: /\bRange Improved\b/i,                 right: "Improved Range"          }
        ];
        for (const d of labelDrift) {
            if (d.wrong.test(desc)) {
                noteWarn(`${pd}/${f}`, `description uses "${d.wrong.toString().slice(2, -3)}" — catalog label is "${d.right}"`);
            }
        }

        /* 4. Cross-check: every quality KEY on the item must have a
         *    description that mentions the matching LABEL (or doesn't
         *    mention it at all — narrative is fine). The case we flag is
         *    when the description references a DIFFERENT label than what
         *    the chip will show. */
        for (const key of sys.qualities ?? []) {
            const label = ALL[key];
            if (!label) continue;
            const re = new RegExp(`\\b${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
            /* Soft check: if the key implies a specific catalog label
             * but the description uses a known alias, flag it. */
            const aliases = {
                concealment:       /\bConcealable\b/i,
                foraging:          /\bForage\b/,
                improvedArmorPiercing: /\bImproved AP\b/,
                bleeding:          null,   /* "Bleed N%" is canonical PDF wording — accepted */
                stun:              null,
                fire:              null,
                disease:           null,
                poison:            null
            };
            const alias = aliases[key];
            if (alias && alias.test(desc) && !re.test(desc)) {
                noteWarn(`${pd}/${f}`, `quality "${key}" present but description uses alias instead of catalog label "${label}"`);
            }
        }
    }
}

/* Report. */
const errors = issues.filter(i => i.kind === "error");
const warns  = issues.filter(i => i.kind === "warn");

if (errors.length === 0 && warns.length === 0) {
    console.log("\n✓ All quality references and label terminology are consistent.");
    process.exit(0);
}

if (errors.length) {
    console.log(`\n${errors.length} ERROR(s) — these will display incorrectly at runtime:`);
    for (const e of errors) console.log(`  ✗ ${e.file}: ${e.msg}`);
}
if (warns.length) {
    console.log(`\n${warns.length} WARNING(s) — text drift vs catalog labels:`);
    for (const w of warns) console.log(`  ! ${w.file}: ${w.msg}`);
}
process.exit(errors.length > 0 ? 1 : 0);
