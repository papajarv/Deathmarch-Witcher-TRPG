/**
 * migrate-zerrikanian-sun.mjs — convert Zerrikanian Sun from `alchemical`
 * to `weapon`, matching the way every other bomb in the RAW compendiums
 * is authored (Dimeritium Bomb, Devil's Puffball, Moon Dust, etc.).
 *
 * Zerrikanian Sun was authored as an alchemical/bomb — a mistake, since
 * bombs in this system are stored as weapon items with weaponType="thrown"
 * so the weapon-attack pipeline (Athletics roll, range brackets, throw
 * arc, damage / status card) drives the throw. Alchemicals just get
 * consumed, which is not what a bomb should do.
 *
 * Preserves:
 *   _id, name, folder, sort, ownership, description, book/page flags,
 *   weight, cost, quantity, availability, conceal, source
 *
 * Transforms (interpretation):
 *   alchemical.range "4m" → weapon.system.radius 4 (AoE)
 *   weapon.system.range   → "BODYx4"  (standard bomb throw range)
 *   damageTypes           → ["elemental"] (matches Dimeritium Bomb)
 *   skillKey              → "athletics"
 *   weaponType            → "thrown"
 *   quick                 → true
 *   appliesMeleeBonus     → false (a thrown bomb doesn't add melee dmg)
 *
 * Idempotent: if the item is already a weapon, the script does nothing.
 *
 * Run:
 *   node tools/migrate-zerrikanian-sun.mjs
 *   node tools/migrate-zerrikanian-sun.mjs --dry-run
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ClassicLevel } from "classic-level";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, "..");
const DRY_RUN   = process.argv.includes("--dry-run");

const PACK_DIR  = resolve(ROOT, "packs/alchemy");
const TARGET_ID = "KTgsAfnvpZBrrrrr";
const TARGET_NAME = "Zerrikanian Sun";

const db = new ClassicLevel(PACK_DIR, { valueEncoding: "json" });
await db.open();

let foundKey = null;
let existing = null;
for await (const [key, value] of db.iterator()) {
    if (value?._id === TARGET_ID || value?.name === TARGET_NAME) {
        foundKey = key;
        existing = value;
        break;
    }
}

if (!existing) {
    console.log("Zerrikanian Sun not found — nothing to do.");
    await db.close();
    process.exit(0);
}

if (existing.type === "weapon") {
    console.log("Already a weapon — nothing to do.");
    await db.close();
    process.exit(0);
}

const oldSys = existing.system ?? {};
const converted = {
    ...existing,
    type: "weapon",
    /* Move to the same bomb icon set the other RAW bombs use so it
     * doesn't look like a potion in inventory lists. */
    img: "icons/weapons/thrown/bomb-detonator.webp",
    system: {
        description:       oldSys.description ?? "",
        weight:            oldSys.weight ?? 1,
        cost:              oldSys.cost ?? 0,
        quantity:          oldSys.quantity ?? 1,
        damage:            "",
        damageTypes:       ["elemental"],
        range:             "BODYx4",
        radius:            Number(String(oldSys.range ?? "").replace(/[^\d.]/g, "")) || 4,
        accuracy:          0,
        reliability:       { value: 0, max: 0 },
        requiresAmmo:      false,
        effects:           "",
        qualities:         [],
        qualityValues:     {},
        availability:      oldSys.availability ?? "poor",
        conceal:           oldSys.conceal ?? "S",
        weaponEnhancement: 0,
        skillKey:          "athletics",
        weaponType:        "thrown",
        hands:             "right",
        source:            oldSys.source ?? "",
        appliesMeleeBonus: false,
        quick:             true
    }
};

console.log("Converting Zerrikanian Sun:");
console.log("  before: type=alchemical, system.type=bomb, range=", oldSys.range, "damage=", oldSys.damage);
console.log("  after:  type=weapon, weaponType=thrown, range=BODYx4, radius=", converted.system.radius, "quick=true");

if (DRY_RUN) {
    console.log("(dry-run — no write)");
} else {
    await db.put(foundKey, converted);
    console.log("Written.");
}
await db.close();
