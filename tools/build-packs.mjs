/**
 * build-packs.mjs — compile JSON-authored compendium items into Foundry
 * LevelDB packs.
 *
 * Reads `packs-src/<pack-name>/*.json` and writes a LevelDB at
 * `packs/<pack-name>/` using the same key shape Foundry expects:
 *     !items!<_id>            → the item document
 *     !folders!<_id>          → folder docs (none authored here)
 *
 * The compendium name comes from the directory name. Each JSON file is
 * one item. Pre-existing pack data is replaced (this is a deterministic
 * build, not a merge).
 *
 * Usage:
 *     node tools/build-packs.mjs                 # build every pack
 *     node tools/build-packs.mjs eo-armor        # build just one pack
 *
 * Foundry pack key format (v14): `!items!<_id>` for Item documents.
 * Keys are sorted ascendingly inside the LevelDB.
 */

import { readdirSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClassicLevel } from "classic-level";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, "..");
const SRC_ROOT  = resolve(ROOT, "packs-src");
const OUT_ROOT  = resolve(ROOT, "packs");

/** Read all JSON entries in a single packs-src directory. Filenames
 *  prefixed with `_folder_` are emitted as Folder docs (`!folders!<id>`)
 *  rather than items. */
function loadEntries(packDir) {
    const files = readdirSync(packDir).filter(f => f.endsWith(".json"));
    const entries = [];
    for (const f of files) {
        const raw = readFileSync(resolve(packDir, f), "utf8");
        let doc;
        try { doc = JSON.parse(raw); }
        catch (err) { throw new Error(`Invalid JSON in ${f}: ${err.message}`); }
        if (!doc._id || typeof doc._id !== "string" || doc._id.length !== 16) {
            throw new Error(`${f}: _id must be a 16-char string (got ${JSON.stringify(doc._id)})`);
        }
        entries.push({ file: f, doc, isFolder: f.startsWith("_folder_") });
    }
    return entries;
}

async function buildPack(packName) {
    const srcDir = resolve(SRC_ROOT, packName);
    const outDir = resolve(OUT_ROOT, packName);
    if (!existsSync(srcDir)) {
        throw new Error(`No source directory at ${srcDir}`);
    }
    const entries = loadEntries(srcDir);
    console.log(`→ ${packName}: ${entries.length} item(s)`);

    /* Clear the output dir for a deterministic build. */
    if (existsSync(outDir)) {
        rmSync(outDir, { recursive: true, force: true });
    }

    const db = new ClassicLevel(outDir, { valueEncoding: "json" });
    let itemCount = 0, folderCount = 0, effectCount = 0;
    try {
        for (const { doc, isFolder } of entries) {
            const key = isFolder ? `!folders!${doc._id}` : `!items!${doc._id}`;
            /* Foundry v14 LevelDB layout: ActiveEffect docs that live on
             * an item are stored as SEPARATE keys (`!items.effects!<itemId>.<aeId>`),
             * and the item document's `effects` array carries only the
             * AE IDs — not the embedded full AE objects. JSON authoring
             * here embeds the full AE; split it on write so the
             * compiled pack matches Foundry's expected shape. Without
             * this, an item with `effects: [{...}]` lands in LevelDB
             * unchanged and Foundry never loads the AE — the item is
             * mechanically inert when consumed. */
            if (!isFolder && Array.isArray(doc.effects) && doc.effects.length
                && typeof doc.effects[0] === "object") {
                const embedded = doc.effects;
                const ids = [];
                for (const ae of embedded) {
                    if (!ae?._id || typeof ae._id !== "string") {
                        throw new Error(`${doc.name ?? "(unnamed)"}: embedded effect missing string _id`);
                    }
                    ids.push(ae._id);
                    await db.put(`!items.effects!${doc._id}.${ae._id}`, ae);
                    effectCount++;
                }
                /* Replace the embedded array with the id-only one expected
                 * by Foundry's pack reader. Clone the doc so we don't
                 * mutate the in-memory source. */
                doc.effects = ids;
            }
            await db.put(key, doc);
            if (isFolder) folderCount++; else itemCount++;
        }
    } finally {
        await db.close();
    }
    const effectsNote = effectCount ? `, ${effectCount} effects` : "";
    console.log(`  ✓ wrote ${outDir} (${itemCount} items, ${folderCount} folders${effectsNote})`);
}

async function main() {
    const arg = process.argv[2];
    let packs;
    if (arg) {
        packs = [arg];
    } else {
        if (!existsSync(SRC_ROOT)) {
            console.log(`No packs-src/ directory — nothing to build.`);
            return;
        }
        packs = readdirSync(SRC_ROOT).filter(d => {
            try { return statSync(join(SRC_ROOT, d)).isDirectory(); }
            catch (_) { return false; }
        });
    }
    if (!packs.length) {
        console.log(`No packs to build.`);
        return;
    }
    for (const p of packs) await buildPack(p);
    console.log(`\nDone — ${packs.length} pack(s) built.`);
}

main().catch(err => {
    console.error("build-packs failed:", err);
    process.exit(1);
});
