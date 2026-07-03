#!/usr/bin/env node
/**
 * Generates an i18n manifest for HBS attribute substitution.
 *
 * Why a generator — 322 HBS title/placeholder/aria-label attributes
 * spread across ~50 sheet templates. Each follows a predictable shape:
 *
 *   <element attr="Literal Text"> → <element attr="{{localize 'KEY'}}">
 *
 * The key name is derived from <sheet>.Attr.<slug>:
 *
 *   templates/item/weapon.hbs, title="Weapon Accuracy"
 *     → key: WITCHER.Sheet.Weapon.Attr.WeaponAccuracy
 *
 * Collision handling — if two attrs land on the same key, the second
 * gets a numeric suffix (.2, .3, …) so each callsite resolves to a
 * unique English string.
 *
 * Run:
 *   node tools/i18n-gen-hbs-attr-manifest.mjs > tools/i18n-manifest-hbs-attrs.mjs
 *
 * Then apply via:
 *   node tools/i18n-migrate.mjs tools/i18n-manifest-hbs-attrs.mjs
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const auditJson = execSync("node tools/audit-i18n.mjs --json", { encoding: "utf8" });
const audit = JSON.parse(auditJson);

/* Derive a key prefix from the file path.
 *   templates/item/weapon.hbs        → Sheet.Weapon
 *   templates/actor/character/main.hbs → Sheet.Character
 *   templates/actor/loot/main.hbs    → Sheet.Loot
 *   templates/applications/foo.hbs   → App.Foo
 *   templates/inspection/item-card.hbs → Inspect.ItemCard
 *   templates/active-effect/change.hbs → Effect.Change
 *   templates/chat/...               → Chat.X
 */
function keyPrefixFor(file) {
    const parts = file.split("/").slice(1); // drop "templates/"
    if (parts[0] === "actor") {
        const sheet = parts[1]; // "character" | "loot" | "monster" | "merchant" | "mystery"
        return `Sheet.${toPascal(sheet)}`;
    }
    if (parts[0] === "item") {
        const sheet = parts[1].replace(/\.hbs$/, "");
        return `Sheet.${toPascal(sheet)}`;
    }
    if (parts[0] === "applications") {
        const sheet = parts[1].replace(/\.hbs$/, "");
        return `App.${toPascal(sheet)}`;
    }
    if (parts[0] === "inspection") {
        return `Inspect.${toPascal(parts[1].replace(/\.hbs$/, ""))}`;
    }
    if (parts[0] === "active-effect") {
        return `Effect.${toPascal(parts[1].replace(/\.hbs$/, ""))}`;
    }
    if (parts[0] === "chat") {
        return `Chat.${toPascal(parts[1].replace(/\.hbs$/, ""))}`;
    }
    if (parts[0] === "investigation") {
        return `Invest.${toPascal(parts[1].replace(/\.hbs$/, ""))}`;
    }
    /* Fallback — join everything PascalCased. */
    return parts.map(p => toPascal(p.replace(/\.hbs$/, ""))).join(".");
}

function toPascal(s) {
    return s.split(/[-_/]/g).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join("");
}

function slugify(text) {
    /* Drop HTML entities and punctuation, keep word chars + space, then
     * PascalCase. Caps at 40 chars to keep key names readable. */
    return text
        .replace(/&[a-z]+;/g, " ")
        .replace(/[^A-Za-z0-9 ]+/g, " ")
        .trim()
        .split(/\s+/)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join("")
        .slice(0, 40) || "Text";
}

const ATTR_KINDS = {
    "hbs-title":        "title",
    "hbs-placeholder":  "placeholder",
    "hbs-aria-label":   "aria-label",
    "hbs-alt":          "alt",
    "hbs-data-tooltip": "data-tooltip",
};

/* Group by file, build entries. */
const manifest = [];
const seenKeys = new Set();

for (const [file, items] of Object.entries(audit.byFile).sort()) {
    if (!file.startsWith("templates/")) continue;
    const attrItems = items.filter(i => ATTR_KINDS[i.kind]);
    if (!attrItems.length) continue;

    const prefix = keyPrefixFor(file);
    const replacements = [];
    /* De-dupe identical (attr,text) pairs within the same file. */
    const seenInFile = new Set();
    for (const it of attrItems) {
        const attr = ATTR_KINDS[it.kind];
        const dedup = `${attr}=${it.text}`;
        if (seenInFile.has(dedup)) continue;
        seenInFile.add(dedup);

        const slug = slugify(it.text);
        const attrPart = attr === "placeholder"  ? "Hint"
                       : attr === "title"        ? "Tooltip"
                       : attr === "data-tooltip" ? "Tooltip"
                       : attr === "aria-label"   ? "Aria"
                       : "Alt";
        let key = `WITCHER.${prefix}.${attrPart}.${slug}`;
        let n = 2;
        while (seenKeys.has(key)) {
            key = `WITCHER.${prefix}.${attrPart}.${slug}${n++}`;
        }
        seenKeys.add(key);

        replacements.push({
            kind: "hbs-attr",
            attr,
            text: it.text,
            key,
        });
    }
    if (replacements.length) {
        manifest.push({ file, replacements });
    }
}

/* Emit as a JS module. */
let out = `/**
 * AUTO-GENERATED — do not hand-edit. Re-run:
 *   node tools/i18n-gen-hbs-attr-manifest.mjs > tools/i18n-manifest-hbs-attrs.mjs
 *
 * Phase 3 of the i18n migration: every HBS attribute (title="...",
 * placeholder="...", aria-label="...", alt="...") moves into a
 * lang/en.json key. Key shape:
 *
 *   WITCHER.<area>.<attrKind>.<pascalSlug>
 *
 * where <attrKind> is Tooltip / Hint / Aria / Alt.
 */

export default ${JSON.stringify(manifest, null, 4)};
`;
console.log(out);
