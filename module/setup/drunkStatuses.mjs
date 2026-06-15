/**
 * Drunk status effect definitions — 8 levels, registered onto
 * `CONFIG.statusEffects` when the `foodAndDrink` homebrew is on.
 *
 * Ported from witcher-food-and-drink/scripts/drunk.mjs. The `changes`
 * arrays are concrete v14 EffectChangeData entries (key/type/value/
 * priority/phase) — the standard CONST.ACTIVE_EFFECT_MODES.ADD becomes
 * `type: "add"`.
 *
 * Levels VI–VIII flag `unconsciousDC` (GM rolls endurance), VII–VIII
 * flag `deathChance` (% on unconsciousness). Level IV has `blackout: true`
 * (50% blackout on apply). The mechanic handler uses these flags; the
 * status registration itself just attaches the effect.
 */

const change = (key, value, type = "add") =>
    ({ key, value: String(value), type, phase: "initial", priority: 0 });

export const DRUNK_STATUSES = Object.freeze([
    {
        id: "witcher-drunk-1", level: 1,
        name: "Drunk I", img: "icons/svg/tankard.svg",
        summary: "+1 EMP, +1 Crafting, +2 Melee Dmg",
        changes: [
            change("system.stats.emp.value", 1),
            change("system.skills.cra.crafting.modifier", 1),
            change("system.attackStats.meleeBonus", 2)
        ]
    },
    {
        id: "witcher-drunk-2", level: 2,
        name: "Drunk II", img: "icons/svg/tankard.svg",
        summary: "-1 REF/DEX/INT, +2 EMP",
        changes: [
            change("system.stats.ref.value", -1),
            change("system.stats.dex.value", -1),
            change("system.stats.int.value", -1),
            change("system.stats.emp.value",  2)
        ]
    },
    {
        id: "witcher-drunk-3", level: 3,
        name: "Drunk III", img: "icons/svg/tankard.svg",
        summary: "-2 REF/DEX/INT, +3 EMP",
        changes: [
            change("system.stats.ref.value", -2),
            change("system.stats.dex.value", -2),
            change("system.stats.int.value", -2),
            change("system.stats.emp.value",  3)
        ]
    },
    {
        id: "witcher-drunk-4", level: 4, blackout: true,
        name: "Drunk IV", img: "icons/svg/tankard.svg",
        summary: "-3 REF/DEX/SPD/INT, -2 Resist Coerc/Magic, 50% blackout",
        changes: [
            change("system.stats.ref.value",  -3),
            change("system.stats.dex.value",  -3),
            change("system.stats.spd.value",  -3),
            change("system.stats.int.value",  -3),
            change("system.skills.will.resistcoerc.modifier", -2),
            change("system.skills.will.resistmagic.modifier", -2)
        ]
    },
    {
        id: "witcher-drunk-5", level: 5,
        name: "Drunk V", img: "icons/svg/tankard.svg",
        summary: "-4 REF/DEX/SPD/INT, -4 Resist Coerc/Magic",
        changes: [
            change("system.stats.ref.value",  -4),
            change("system.stats.dex.value",  -4),
            change("system.stats.spd.value",  -4),
            change("system.stats.int.value",  -4),
            change("system.skills.will.resistcoerc.modifier", -4),
            change("system.skills.will.resistmagic.modifier", -4)
        ]
    },
    {
        id: "witcher-drunk-6", level: 6, unconsciousDC: 20,
        name: "Drunk VI", img: "icons/svg/tankard.svg",
        summary: "Endurance DC 20 or unconscious 2d6 hrs",
        changes: [
            change("system.stats.ref.value",  -4),
            change("system.stats.dex.value",  -4),
            change("system.stats.spd.value",  -4),
            change("system.stats.int.value",  -4)
        ]
    },
    {
        id: "witcher-drunk-7", level: 7, unconsciousDC: 24, deathChance: 25,
        name: "Drunk VII", img: "icons/svg/skull.svg",
        summary: "Endurance DC 24, 25% death on KO",
        changes: [
            change("system.stats.ref.value",  -4),
            change("system.stats.dex.value",  -4),
            change("system.stats.spd.value",  -4),
            change("system.stats.int.value",  -4)
        ]
    },
    {
        id: "witcher-drunk-8", level: 8, unconsciousDC: 30, deathChance: 50,
        name: "Drunk VIII", img: "icons/svg/skull.svg",
        summary: "Endurance DC 30, 50% death on KO",
        changes: [
            change("system.stats.ref.value",  -4),
            change("system.stats.dex.value",  -4),
            change("system.stats.spd.value",  -4),
            change("system.stats.int.value",  -4)
        ]
    }
]);
