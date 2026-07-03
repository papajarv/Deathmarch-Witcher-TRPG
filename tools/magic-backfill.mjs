/**
 * magic-backfill.mjs — one-shot migration that populates the new
 * damage/element/type/area/statusRiders fields on the magic pack's
 * damaging castables. Data source: `tools/magic-backfill-map.json`,
 * keyed on item.name.
 *
 * Reads/writes the LevelDB at `packs/magic/` directly. Safe to run
 * multiple times — the migration is idempotent (fields are set to
 * their mapped values; unmatched items are untouched).
 *
 * Usage:
 *     node tools/magic-backfill.mjs           # apply the migration
 *     node tools/magic-backfill.mjs --dry     # report only, no writes
 *
 * Report shape:
 *   ✓ N mapped items updated
 *   ! M items had matching entries but no field changes (already applied)
 *   … K unmatched entries in the map (items missing from the pack)
 */

import { ClassicLevel } from "classic-level";
import { readFileSync }  from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath }  from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, "..");
const PACK      = resolve(ROOT, "packs/magic");
const MAP_FILE  = resolve(__dirname, "magic-backfill-map.json");

const DRY = process.argv.includes("--dry");

const rawMap = JSON.parse(readFileSync(MAP_FILE, "utf8"));
const nameMap = {};
for (const [k, v] of Object.entries(rawMap)) {
    if (k.startsWith("_")) continue;
    nameMap[k] = v;
}

const db = new ClassicLevel(PACK, { valueEncoding: "json" });
await db.open();

let touchedCount = 0;
let alreadyMatchesCount = 0;
const unmatched = new Set(Object.keys(nameMap));
const writes = [];

for await (const [key, value] of db.iterator()) {
    if (!key.startsWith("!items!")) continue;
    if (!["spell", "hex", "ritual"].includes(value.type)) continue;
    const entry = nameMap[value.name];
    if (!entry) continue;
    unmatched.delete(value.name);

    /* Only apply the fields defined in the map entry. Fields not
     * present in the entry stay at their current stored value. */
    const nextSystem = { ...(value.system ?? {}) };
    const changes = [];

    const setIfDifferent = (key, newVal, oldVal) => {
        const cur = oldVal;
        const eq = (typeof newVal === "object")
            ? JSON.stringify(newVal) === JSON.stringify(cur)
            : cur === newVal;
        if (!eq) { changes.push(`${key}: ${JSON.stringify(cur)} → ${JSON.stringify(newVal)}`); return true; }
        return false;
    };

    if (entry.damageFormula !== undefined && setIfDifferent("damageFormula", entry.damageFormula, nextSystem.damageFormula ?? "")) {
        nextSystem.damageFormula = entry.damageFormula;
    }
    if (entry.damageElement !== undefined && setIfDifferent("damageElement", entry.damageElement, nextSystem.damageElement ?? "none")) {
        nextSystem.damageElement = entry.damageElement;
    }
    if (entry.damageType !== undefined && setIfDifferent("damageType", entry.damageType, nextSystem.damageType ?? "none")) {
        nextSystem.damageType = entry.damageType;
    }
    if (entry.areaShape !== undefined && setIfDifferent("areaShape", entry.areaShape, nextSystem.areaShape ?? "none")) {
        nextSystem.areaShape = entry.areaShape;
    }
    if (entry.areaSize !== undefined && setIfDifferent("areaSize", entry.areaSize, nextSystem.areaSize ?? 0)) {
        nextSystem.areaSize = entry.areaSize;
    }
    if (entry.areaAnchor !== undefined && setIfDifferent("areaAnchor", entry.areaAnchor, nextSystem.areaAnchor ?? "caster")) {
        nextSystem.areaAnchor = entry.areaAnchor;
    }
    if (entry.tangible !== undefined) {
        /* tangible defaults TRUE for spells, FALSE for hexes (see the
         * schema initial values). Compare against the item's own current
         * value; the migration flips only when the mapping disagrees. */
        const defaultTangible = (value.type === "hex") ? false : true;
        const cur = (typeof nextSystem.tangible === "boolean") ? nextSystem.tangible : defaultTangible;
        if (setIfDifferent("tangible", entry.tangible, cur)) {
            nextSystem.tangible = entry.tangible;
        }
    }
    if (Array.isArray(entry.statusRiders)) {
        /* Normalize the map's status riders to the schema shape so the
         * comparison is apples-to-apples. Extension fields (mode,
         * stripOnExit, staScale) are optional in the map; missing =
         * "onHit" default so a plain rider entry still round-trips. */
        const normalized = entry.statusRiders.map(r => ({
            statusId: String(r.statusId ?? ""),
            chance:   Number(r.chance ?? 100) || 0,
            duration: {
                value: String(r.duration?.value ?? ""),
                unit:  String(r.duration?.unit  ?? "instant")
            },
            mode:        String(r.mode ?? "onHit"),
            stripOnExit: r.stripOnExit !== false,
            staScale: {
                offset:  Number(r.staScale?.offset)  || 0,
                divisor: Math.max(1, Number(r.staScale?.divisor) || 1),
                cap:     Number(r.staScale?.cap)     || 0
            }
        }));
        if (setIfDifferent("statusRiders", normalized, nextSystem.statusRiders ?? [])) {
            nextSystem.statusRiders = normalized;
        }
    }
    if (entry.areaPersist !== undefined && setIfDifferent("areaPersist", entry.areaPersist, nextSystem.areaPersist ?? false)) {
        nextSystem.areaPersist = entry.areaPersist;
    }
    if (entry.areaExcludeCaster !== undefined && setIfDifferent("areaExcludeCaster", entry.areaExcludeCaster, nextSystem.areaExcludeCaster ?? true)) {
        nextSystem.areaExcludeCaster = entry.areaExcludeCaster;
    }
    if (entry.damagePer !== undefined && setIfDifferent("damagePer", entry.damagePer, nextSystem.damagePer ?? "cast")) {
        nextSystem.damagePer = entry.damagePer;
    }
    if (entry.hitChance !== undefined && setIfDifferent("hitChance", entry.hitChance, nextSystem.hitChance ?? 100)) {
        nextSystem.hitChance = entry.hitChance;
    }
    if (entry.bypassArmor !== undefined && setIfDifferent("bypassArmor", entry.bypassArmor, nextSystem.bypassArmor ?? false)) {
        nextSystem.bypassArmor = entry.bypassArmor;
    }
    if (entry.narrative !== undefined && setIfDifferent("narrative", entry.narrative, nextSystem.narrative ?? false)) {
        nextSystem.narrative = entry.narrative;
    }
    if (entry.mechanicHandler !== undefined && setIfDifferent("mechanicHandler", entry.mechanicHandler, nextSystem.mechanicHandler ?? "")) {
        nextSystem.mechanicHandler = entry.mechanicHandler;
    }
    if (entry.castsAuthoredAE !== undefined && setIfDifferent("castsAuthoredAE", entry.castsAuthoredAE, nextSystem.castsAuthoredAE ?? false)) {
        nextSystem.castsAuthoredAE = entry.castsAuthoredAE;
    }
    /* Object-typed schemas — shield / heal / escapeCheck / escalationPerRound /
     * summon / transform / illusion / triggerCondition / pierce. Each merges as
     * a whole object comparison so a partial override still round-trips. */
    for (const key of ["shield", "heal", "escapeCheck", "escalationPerRound",
                       "summon", "transform", "illusion", "triggerCondition", "pierce"]) {
        if (entry[key] && typeof entry[key] === "object") {
            const cur = nextSystem[key] ?? {};
            if (setIfDifferent(key, entry[key], cur)) {
                nextSystem[key] = entry[key];
            }
        }
    }
    if (Array.isArray(entry.modes) && setIfDifferent("modes", entry.modes, nextSystem.modes ?? [])) {
        nextSystem.modes = entry.modes;
    }
    if (Array.isArray(entry.variableTiers) && setIfDifferent("variableTiers", entry.variableTiers, nextSystem.variableTiers ?? [])) {
        nextSystem.variableTiers = entry.variableTiers;
    }
    if (Array.isArray(entry.grants) && setIfDifferent("grants", entry.grants, nextSystem.grants ?? [])) {
        nextSystem.grants = entry.grants;
    }
    if (entry.grantsTempHp !== undefined && setIfDifferent("grantsTempHp", entry.grantsTempHp, nextSystem.grantsTempHp ?? "")) {
        nextSystem.grantsTempHp = entry.grantsTempHp;
    }
    if (entry.attackCount !== undefined && setIfDifferent("attackCount", entry.attackCount, nextSystem.attackCount ?? "")) {
        nextSystem.attackCount = entry.attackCount;
    }
    if (entry.ablationScope !== undefined && setIfDifferent("ablationScope", entry.ablationScope, nextSystem.ablationScope ?? "armor")) {
        nextSystem.ablationScope = entry.ablationScope;
    }
    if (Array.isArray(entry.defense) && setIfDifferent("defense", entry.defense, nextSystem.defense ?? [])) {
        nextSystem.defense = entry.defense;
    }
    if (entry.variableCost !== undefined && setIfDifferent("variableCost", entry.variableCost, nextSystem.variableCost ?? false)) {
        nextSystem.variableCost = entry.variableCost;
    }
    if (entry.duration && typeof entry.duration === "object") {
        const dur = { value: String(entry.duration.value ?? ""), unit: String(entry.duration.unit ?? "instant") };
        if (setIfDifferent("duration", dur, nextSystem.duration ?? { value: "", unit: "instant" })) {
            nextSystem.duration = dur;
        }
    }

    if (changes.length === 0) {
        alreadyMatchesCount++;
        continue;
    }
    touchedCount++;
    console.log(`— ${value.name} (${value.type})`);
    for (const c of changes) console.log(`    ${c}`);
    writes.push({ key, value: { ...value, system: nextSystem } });
}

if (!DRY && writes.length) {
    for (const { key, value } of writes) {
        await db.put(key, value);
    }
}

await db.close();

console.log(``);
console.log(`✓ ${touchedCount} item(s) ${DRY ? "would be" : ""} updated`);
console.log(`! ${alreadyMatchesCount} item(s) already match the map`);
if (unmatched.size) {
    console.log(`… ${unmatched.size} map entries had no matching item in the pack:`);
    for (const n of unmatched) console.log(`    ${n}`);
}
