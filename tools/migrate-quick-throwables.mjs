/**
 * migrate-quick-throwables.mjs — flip `system.quick = true` on every
 * quick-eligible weapon across the RAW LevelDB packs so they can occupy
 * the off-hand Quick slot.
 *
 * Why a one-shot migration: the RAW packs (equipment, experimentalTech,
 * alchemy, witcherGear, generalGear) ship as compiled LevelDB binaries
 * with no packs-src source. The `quick` boolean was added to the schema
 * after these items were authored, so every entry currently defaults to
 * false — meaning a throwing knife, dagger, or hand crossbow refuses to
 * sit in the Quick slot even though it's meant to.
 *
 * Selection rule (mirrors tools/patch-eo-quick.mjs): any one-handed
 * WEAPON matching any of
 *   - `system.weaponType === "thrown"` (thrown-only weapons, bombs
 *     authored as weapons, nets — 2-handed nets are excluded below)
 *   - `qualities` includes "throwing" (throwable-in-melee-mode weapons)
 *   - `skillKey === "athletics"` (thrown-primary dual-mode weapons)
 *   - `skillKey === "crossbow"` (one-handed crossbows — hand crossbow,
 *     crossbow pistol)
 *   - `skillKey === "smallBlades"` (RAW off-hand staples — daggers,
 *     stilettos, sickles, poniards, jambiyas, etc.)
 * gets `quick: true`. Two-handed items (`hands === "two"`) are skipped
 * — the Quick slot IS the off-hand slot, so 2H items can't sit there.
 *
 * Alchemicals (Zerrikanian Sun, potions, oils) are already treated as
 * quick-eligible by `isQuickItem` in the inventory chrome — no LDB
 * change is needed for those.
 *
 * Idempotent: an item already at `quick: true` is skipped (no LDB
 * write, so re-running is safe).
 *
 * Run:
 *   node tools/migrate-quick-throwables.mjs             # apply
 *   node tools/migrate-quick-throwables.mjs --dry-run   # print only
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ClassicLevel } from "classic-level";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, "..");

const DRY_RUN = process.argv.includes("--dry-run");

/* Packs that could contain quick-eligible weapons. */
const PACKS = ["equipment", "experimentalTech", "alchemy", "witcherGear", "generalGear"];

/* The old data model conflated hands + slot ("right"/"left"/"quick"/
 * "both"/"two-handed"). WeaponData.migrateData rewrites this at load
 * time, but the LDB still contains the legacy strings. Treat any of
 * those as "one-handed" for the quick-slot decision here — only
 * "two"/"both"/"two-handed" gets skipped. */
const isOneHanded = (hands) => {
    const h = String(hands ?? "").toLowerCase();
    return h !== "two" && h !== "both" && h !== "two-handed";
};

function shouldFlip(item) {
    if (item?.type !== "weapon") return null;
    const sys = item.system ?? {};
    if (!isOneHanded(sys.hands)) return null;
    const throwing = Array.isArray(sys.qualities) && sys.qualities.includes("throwing");
    if (sys.weaponType === "thrown") return "thrown-type";
    if (throwing) return "throwing-quality";
    const skill = String(sys.skillKey ?? "").toLowerCase();
    if (skill === "athletics")  return "athletics-thrown";
    if (skill === "crossbow")   return "one-hand-crossbow";
    if (skill === "smallblades") return "smallBlades";
    return null;
}

let totalScanned = 0;
let totalFlipped = 0;
let totalSkipped = 0;

for (const packName of PACKS) {
    const dbPath = resolve(ROOT, "packs", packName);
    const db = new ClassicLevel(dbPath, { valueEncoding: "json" });
    try {
        await db.open();
    } catch (err) {
        console.error(`[${packName}] open failed: ${err.message}`);
        continue;
    }
    console.log(`\n── ${packName} ──`);
    const batch = db.batch();
    let pending = 0;
    for await (const [key, value] of db.iterator()) {
        totalScanned++;
        const reason = shouldFlip(value);
        if (!reason) continue;
        if (value.system?.quick === true) {
            totalSkipped++;
            continue;
        }
        const next = { ...value, system: { ...value.system, quick: true } };
        console.log(`  flip [${reason.padEnd(13)}] ${value.name}`);
        if (!DRY_RUN) {
            batch.put(key, next);
            pending++;
        }
        totalFlipped++;
    }
    if (!DRY_RUN && pending > 0) await batch.write();
    else if (DRY_RUN) batch.clear();
    await db.close();
}

console.log(`\nSummary: scanned=${totalScanned} flipped=${totalFlipped} already-quick=${totalSkipped}${DRY_RUN ? " (dry-run)" : ""}`);
