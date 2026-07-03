/**
 * patch-eo-quick.mjs — edit `packs-src/eo-weapons/*.json` in-place to
 * set `system.quick = true` on the items that should be quick-slot
 * eligible but weren't authored that way.
 *
 * Source-side edit (not an LDB migration) because the EO pack IS built
 * from packs-src via `npm run build:packs`. Editing the compiled LDB
 * directly would be lost the next time someone rebuilds the pack.
 *
 * Selection rule mirrors the RAW pass:
 *   - all thrown-type / throwing-quality weapons
 *   - all one-handed crossbows (hands: "one" AND crossbow skill)
 *   - all one-handed smallBlades
 * Two-handed items (nets, greatswords) are skipped — the Quick slot is
 * the off-hand slot, so two-handed items can't sit there.
 *
 * After running: `npm run build:packs` (or the specific EO build step)
 * to recompile the LDB.
 *
 * Idempotent: an item already at quick:true is skipped.
 *
 * Run:
 *   node tools/patch-eo-quick.mjs             # apply
 *   node tools/patch-eo-quick.mjs --dry-run   # print, no write
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, "..");
const SRC_DIR   = resolve(ROOT, "packs-src/eo-weapons");
const DRY_RUN   = process.argv.includes("--dry-run");

function shouldFlip(item) {
    if (item?.type !== "weapon") return null;
    const s = item.system ?? {};
    if (s.hands === "two") return null;                       // off-hand only
    const throwing = Array.isArray(s.qualities) && s.qualities.includes("throwing");
    if (s.weaponType === "thrown") return "thrown-type";
    if (throwing) return "throwing-quality";
    /* athletics as the primary skill = ranged-thrown weapon (chakram,
     * werebubb harpoon, halfling weighted dart etc.). Some are authored
     * as `weaponType: "melee"` with `meleeSkillKey: "athletics"` (dual-
     * mode primary-throw) but should still be quick. */
    if (s.hands === "one" && /^athletics$/i.test(s.skillKey || "")) return "athletics-thrown";
    /* crossbow skill key on a one-handed weapon = a hand crossbow /
     * crossbow pistol style piece — quick-slot eligible. */
    if (s.hands === "one" && /^crossbow$/i.test(s.skillKey || "")) return "one-hand-crossbow";
    /* Small blades — daggers, knives, stilettos etc. — RAW off-hand /
     * quick-slot staples. */
    if (s.hands === "one" && /^smallBlades$/i.test(s.skillKey || "")) return "smallBlades";
    return null;
}

const files = readdirSync(SRC_DIR).filter(f => f.endsWith(".json") && !f.startsWith("_folder_"));
let scanned = 0, flipped = 0, alreadyQuick = 0;
for (const file of files) {
    const path = join(SRC_DIR, file);
    let json;
    try { json = JSON.parse(readFileSync(path, "utf8")); }
    catch (err) { console.error(`skip ${file}: ${err.message}`); continue; }
    scanned++;
    const reason = shouldFlip(json);
    if (!reason) continue;
    if (json.system?.quick === true) { alreadyQuick++; continue; }
    console.log(`  flip [${reason.padEnd(17)}] ${json.name} (${file})`);
    json.system.quick = true;
    if (!DRY_RUN) writeFileSync(path, JSON.stringify(json, null, 4) + "\n", "utf8");
    flipped++;
}
console.log(`\nSummary: scanned=${scanned} flipped=${flipped} already-quick=${alreadyQuick}${DRY_RUN ? " (dry-run)" : ""}`);
if (!DRY_RUN && flipped > 0) {
    console.log("Next: run `npm run build:packs` to recompile the EO LDB.");
}
