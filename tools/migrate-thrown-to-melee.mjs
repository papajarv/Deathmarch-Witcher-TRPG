/**
 * migrate-thrown-to-melee.mjs — flip every `system.weaponType === "thrown"`
 * weapon to `"melee"` across the RAW LevelDB packs, and normalise the
 * skill fields so the new schema holds:
 *
 *     skillKey       = the weapon's MELEE attack skill
 *     range          = distance string (BODY×N or meters — unchanged)
 *
 * After this migration, throwability is derived from the `range` field
 * alone (any melee weapon with a non-empty range can be thrown). The
 * throw itself always rolls Athletics (hard-coded in the strike table).
 * The legacy `meleeSkillKey` field is dropped (was only meaningful when
 * a "thrown" weaponType also carried a melee skill).
 *
 * Skill-field rewrite rule per item:
 *   - If the item had a non-empty `meleeSkillKey` (the melee skill it
 *     was previously carrying as a secondary), promote it to `skillKey`
 *     — that's what the melee mode now rolls.
 *   - If it only had `skillKey === "athletics"` and no `meleeSkillKey`
 *     (bombs, nets — items with no natural melee application), leave
 *     skillKey as-is. The player CAN use them in melee (rolling
 *     Athletics) but that's the intent — a bomb bonk is edge-case, and
 *     RAW doesn't have a dedicated "bomb melee skill".
 *
 * Idempotent: an item already at weaponType="melee" is skipped.
 *
 * Run:
 *   node tools/migrate-thrown-to-melee.mjs             # apply
 *   node tools/migrate-thrown-to-melee.mjs --dry-run   # print only
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ClassicLevel } from "classic-level";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, "..");

const DRY_RUN = process.argv.includes("--dry-run");

const PACKS = ["equipment", "experimentalTech", "alchemy", "witcherGear", "generalGear"];

let totalScanned = 0;
let totalFlipped = 0;
let totalAlready = 0;

for (const packName of PACKS) {
    const dbPath = resolve(ROOT, "packs", packName);
    const db = new ClassicLevel(dbPath, { valueEncoding: "json" });
    try { await db.open(); }
    catch (err) { console.error(`[${packName}] open failed: ${err.message}`); continue; }

    console.log(`\n── ${packName} ──`);
    const batch = db.batch();
    let pending = 0;

    for await (const [key, value] of db.iterator()) {
        if (value?.type !== "weapon") continue;
        totalScanned++;
        const wt = value.system?.weaponType;
        if (wt !== "thrown") {
            if (wt === "melee") totalAlready++;
            continue;
        }

        /* Rewrite: weaponType → melee, skillKey ← meleeSkillKey (if
         * that's a real melee skill, not "athletics"). Preserve range
         * and every other field. Nuke meleeSkillKey — it's now dead. */
        const oldMelee = String(value.system?.meleeSkillKey ?? "").trim();
        const oldSkill = String(value.system?.skillKey ?? "").trim();
        let newSkill = oldSkill || "athletics";
        if (oldMelee && oldMelee.toLowerCase() !== "athletics") {
            newSkill = oldMelee;
        }

        const nextSys = { ...value.system, weaponType: "melee", skillKey: newSkill };
        delete nextSys.meleeSkillKey;
        const next = { ...value, system: nextSys };

        console.log(`  flip ${value.name.padEnd(30)} skill: ${oldSkill.padEnd(12)} → ${newSkill}`);
        if (!DRY_RUN) { batch.put(key, next); pending++; }
        totalFlipped++;
    }

    if (!DRY_RUN && pending > 0) await batch.write();
    else if (DRY_RUN) batch.clear();
    await db.close();
}

console.log(`\nSummary: scanned=${totalScanned} flipped=${totalFlipped} already-melee=${totalAlready}${DRY_RUN ? " (dry-run)" : ""}`);
