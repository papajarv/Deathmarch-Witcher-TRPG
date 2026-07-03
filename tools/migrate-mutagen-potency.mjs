/**
 * migrate-mutagen-potency.mjs — assign Alchemy Reborn `system.potency`
 * values to every mutagen in the compiled `packs/witcherGear` LevelDB.
 *
 * Why a one-shot migration: the `witcherGear` pack ships as a LevelDB
 * binary — there's no `packs-src/witcherGear/` to regenerate. Each mutagen
 * has the `potency` field defined in the data model (mutagen.mjs, ADR 0003)
 * but the stored data was authored before potency mattered, so every value
 * is the schema default (0). That makes every Alchemy Reborn brew of a
 * monster decoction tier Normal forever — the wheel never tips up to
 * Enhanced or Superior.
 *
 * What this does: opens packs/witcherGear in-place, walks all `!items!`
 * keys that are mutagens, patches `system.potency` to the curated value
 * from MUTAGEN_POTENCY below, and writes back. Re-running is idempotent —
 * a mutagen with the target value is skipped (no LevelDB write).
 *
 * Calibration ladder (CR / source-book tier):
 *   2-3 Low-tier monsters (Drowner, Nekker, Wolf-class)
 *   4-5 Mid-tier (Wraith, Werewolf, Bruxa)
 *   6-7 Higher (Leshen, Fiend, Phoenix, Manticore)
 *   8-10 Apex / boss-tier (Toad Prince, Eredin) — none in the current pack
 *
 * Run:
 *   node tools/migrate-mutagen-potency.mjs            # apply
 *   node tools/migrate-mutagen-potency.mjs --dry-run  # print would-write
 */

import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClassicLevel } from "classic-level";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, "..");
const PACK_DIR  = resolve(ROOT, "packs/witcherGear");

/* Mutagen → potency map. Every mutagen currently in packs/witcherGear
 * is listed; new mutagens default to 0 and the migration logs a warning.
 *
 * Tiering rationale per monster:
 *   ── Low (2-3) ──────────────────────────────────────────────────────
 *   Nekker, Arachas, Grave Hag    : Core p.243 low-cr necrophages
 *   Foglet, Drowner-tier          : EO baseline necrophage
 *   ── Mid (4-5) ──────────────────────────────────────────────────────
 *   Noonwraith, Katakan, Werewolf,
 *   Bruxa, Werecat, Garkain        : Core p.243 mid-tier specters/vampires
 *   Glustyworp, Botchling, Pesta  : EO mid-tier hybrids
 *   Wyvern, Cockatrice            : Core p.243 mid-tier dragons/ornithos
 *   ── High (6-7) ─────────────────────────────────────────────────────
 *   Griffin, Bullvore, Frightener,
 *   Shaelmaar, Vendigo, Penitent,
 *   Manticore, Alp, Siren          : EO high-tier monsters / Core p.243
 *   Troll, Rock Troll              : Core p.243 high-tier ogroids
 *   ── Apex (8-9) ─────────────────────────────────────────────────────
 *   Fiend, Leshen, Phoenix,
 *   Succubus, Elemental, Golem     : Core p.243 elder / arch monsters
 */
const MUTAGEN_POTENCY = Object.freeze({
    /* Low (2-3) — necrophages, common beasts */
    "Nekker Mutagen":        2,
    "Arachas Mutagen":       3,
    "Grave Hag Mutagen":     3,
    "Foglet Mutagen":        3,

    /* Mid (4-5) — specters, vampires, hybrids */
    "Noonwraith Mutagen":    4,
    "Katakan Mutagen":       4,
    "Werewolf Mutagen":      4,
    "Bruxa Mutagen":         5,
    "Werecat Mutagen":       4,
    "Garkain Mutagen":       5,
    "Glustyworp Mutagen":    4,
    "Botchling Mutagen":     4,
    "Pesta Mutagen":         5,
    "Wyvern Mutagen":        5,
    "Cockatrice Mutagen":    4,

    /* High (6-7) — apex monsters */
    "Griffin Mutagen":       6,
    "Bullvore Mutagen":      6,
    "Frightener Mutagen":    6,
    "Shaelmaar Mutagen":     6,
    "Vendigo Mutagen":       6,
    "Penitent Mutagen":      7,
    "Manticore Mutagen":     7,
    "Alp Mutagen":           6,
    "Siren Mutagen":         5,
    "Troll Mutagen":         6,
    "Rock Troll Mutagen":    7,
    "Bear Mutagen":          5,

    /* Apex (8-9) — elder/arch monsters */
    "Fiend Mutagen":         8,
    "Leshen Mutagen":        8,
    "Phoenix Mutagen":       9,
    "Succubus Mutagen":      7,
    "Elemental Mutagen":     8,
    "Golem Mutagen":         8
});

async function main() {
    const dryRun = process.argv.includes("--dry-run");
    if (dryRun) console.log("DRY RUN — no writes will be performed.");

    const db = new ClassicLevel(PACK_DIR, { valueEncoding: "json" });
    let touched = 0, skipped = 0, unknown = 0;
    const unknownNames = [];

    try {
        // Collect first; rewriting during an iteration is fragile.
        const toUpdate = [];
        for await (const [key, doc] of db.iterator()) {
            if (!key.startsWith("!items!")) continue;
            if (doc?.type !== "mutagen") continue;

            const target = MUTAGEN_POTENCY[doc.name];
            if (target === undefined) {
                unknown++;
                unknownNames.push(doc.name);
                continue;
            }
            const current = doc.system?.potency ?? 0;
            if (current === target) {
                skipped++;
                continue;
            }
            toUpdate.push({ key, doc, target, current });
        }

        for (const { key, doc, target, current } of toUpdate) {
            doc.system = { ...(doc.system ?? {}), potency: target };
            console.log(`  ${doc.name.padEnd(28)} potency ${current} → ${target}`);
            if (!dryRun) await db.put(key, doc);
            touched++;
        }

        if (unknownNames.length) {
            console.log("\nUnmapped mutagens (left untouched):");
            for (const n of unknownNames) console.log(`  - ${n}`);
        }
        console.log(`\n${dryRun ? "[dry-run] would update" : "updated"} ${touched} mutagen(s); ${skipped} already at target; ${unknown} unmapped.`);
    } finally {
        await db.close();
    }
}

main().catch(err => {
    console.error("migrate-mutagen-potency failed:", err);
    process.exit(1);
});
