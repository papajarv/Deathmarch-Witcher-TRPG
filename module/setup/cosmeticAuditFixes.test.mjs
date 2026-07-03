// Cosmetic fixes from the UX audit (#99):
//   • Clinched/Chokeheld i18n keys exist (no raw "WITCHER.Status.Clinched")
//   • EO packs reference only icons that ship with Foundry
//   • Optional qualities-journal lookup defaults to empty pack id so a
//     fresh world doesn't print a "Journal not found" warning every boot
//   • World-journal-missing case downgraded from console.warn to no-op

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname  = dirname(fileURLToPath(import.meta.url));
const repoRoot   = join(__dirname, "..", "..");

const en        = JSON.parse(readFileSync(join(repoRoot, "lang", "en.json"), "utf8"));
const qolSrc    = readFileSync(join(repoRoot, "module", "chrome", "sheets", "inventory-qol.js"), "utf8");
const invSrc    = readFileSync(join(repoRoot, "module", "chrome", "chrome", "inventory.js"),    "utf8");
const statusSrc = readFileSync(join(repoRoot, "module", "setup", "statusEffects.mjs"),          "utf8");
const catalogSrc= readFileSync(join(repoRoot, "tools", "gen-eo-catalog.mjs"),                   "utf8");
const compsSrc  = readFileSync(join(repoRoot, "tools", "gen-eo-components.mjs"),                "utf8");

test("Every status id declared in statusEffects.mjs has an i18n key in en.json", () => {
    /* Status names render via game.i18n.localize(name) — a missing key
     * leaks the raw "WITCHER.Status.Clinched" string into chat/HUD. */
    const re = /name:\s*"(WITCHER\.Status\.[A-Za-z]+)"/g;
    const keys = new Set();
    let m;
    while ((m = re.exec(statusSrc)) !== null) keys.add(m[1]);
    assert.ok(keys.size > 5, "statusEffects must declare several status names");
    const missing = [...keys].filter(k => !(k in en));
    assert.deepEqual(missing, [], `Missing i18n keys: ${missing.join(", ")}`);
});

test("Clinched + Chokeheld i18n keys are present (UX audit regression)", () => {
    /* The two grapple-states the audit found leaking. */
    assert.equal(en["WITCHER.Status.Clinched"],  "Clinched");
    assert.equal(en["WITCHER.Status.Chokeheld"], "Chokeheld");
});

test("Qualities-journal pack id defaults to empty (no boot-time warning)", () => {
    /* The lookup runs once at ready. A non-empty default referenced a
     * world pack that doesn't exist in a fresh install — that printed a
     * warning every boot. Empty default = silent fallback. */
    assert.match(qolSrc, /const QUALITIES_COMPENDIUM_PACK\s*=\s*""\s*;/);
    assert.match(invSrc, /const QUALITIES_COMPENDIUM_PACK\s*=\s*""\s*;/);
});

test("World-journal-missing case in inventory-qol no longer warns", () => {
    /* Inline quality descriptions now ship with the open-category
     * config dialog, so the journal lookup is purely optional. Silent
     * fallback is the right behavior — a warning is noise, not signal. */
    assert.doesNotMatch(qolSrc, /console\.warn\([^)]*Quality tags will appear/);
});

test("No EO pack source references a Foundry icon that doesn't ship", () => {
    /* Scans every JSON under packs-src/ for icon references and asserts
     * the file exists in Foundry v14's bundled icon set. Catches typos
     * like `glove-leather-brown` (real name: `glove-tooled-leather-brown`)
     * that produce 404 spam in the console on every sheet render. */
    const FVTT_ICONS_ROOT = "/home/coder/shared/witcher_foundry_knowledge_base/foundry_copy/resources/app/public/icons";
    /* The bundled icon dir is dev-environment-specific — skip the test
     * gracefully on a CI box that doesn't have Foundry installed. */
    try { statSync(FVTT_ICONS_ROOT); }
    catch { return; /* skip — no foundry icons available here */ }

    const seen = new Set();
    function scan(dir) {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, e.name);
            if (e.isDirectory()) scan(p);
            else if (e.name.endsWith(".json")) {
                const src = readFileSync(p, "utf8");
                for (const m of src.matchAll(/"img"\s*:\s*"(icons\/[^"]+)"/g)) {
                    seen.add(m[1]);
                }
            }
        }
    }
    scan(join(repoRoot, "packs-src"));
    const missing = [];
    for (const p of seen) {
        const rel = p.replace(/^icons\//, "");
        try { statSync(join(FVTT_ICONS_ROOT, rel)); }
        catch { missing.push(p); }
    }
    assert.deepEqual(missing, [], `Broken icon refs: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}`);
});

test("Catalog generator uses only verified-shipping icon paths", () => {
    /* The bug was the generator HARDCODED `glove-leather-brown.webp` and
     * friends — so every regen reintroduced the 404s. Pin the verified
     * substitutes so a future regen can't silently revive them. */
    assert.match(catalogSrc, /glove-tooled-leather-brown\.webp/);
    assert.match(catalogSrc, /fist-knuckles-spiked-brown\.webp/);
    assert.match(catalogSrc, /arrows-bodkin-yellow-red\.webp/);
    assert.match(catalogSrc, /arrow-broadhead\.webp/);
    assert.match(catalogSrc, /sling-leather\.webp/);
    assert.match(catalogSrc, /rune-sigil-horned-blue\.webp/);
    /* And explicitly NOT the broken originals. */
    assert.doesNotMatch(catalogSrc, /glove-leather-brown\.webp/);
    assert.doesNotMatch(catalogSrc, /helm-barbute-gold\.webp/);
    assert.doesNotMatch(catalogSrc, /sword-guard-engraved-gold\.webp/);
});

test("Components generator uses a real bag icon, not material-bag-yellow", () => {
    assert.match(compsSrc, /sack-cloth-brown\.webp/);
    assert.doesNotMatch(compsSrc, /material-bag-yellow\.webp/);
});
