/**
 * weather-conditions.mjs — grabbable environmental conditions (heat & cold).
 *
 * The weather engine produces a temperature; extreme temperatures let the GM
 * (or a player, on their own actor) "grab" a matching condition from the
 * weather panel. These are ordinary ActiveEffects flagged for identification,
 * NOT CONFIG.statusEffects, because their magnitude is per-actor:
 *
 *   - Heat exhaustion (Core p.165): STA.max × an armor-aware factor — a third
 *     off normally, halved in medium/heavy armor.
 *   - Cold (lightly clothed / naked): a survival countdown of hours equal to
 *     the bearer's Stun stat (half that when Freezing), plus DEX/REF penalties.
 *     Chilly is the mild tier — a DEX nick, no survival timer.
 *
 * Application is manual on purpose: a player decides their character is exposed
 * (or the GM applies it to selected tokens). Nothing here auto-writes to actors
 * on worldTime advance.
 */

import { getActiveWeather } from "./manual-weather.mjs";
import { HEAT_EXHAUSTION_C, staminaHeatFactor } from "./weather-modifiers.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const CONDITION_FLAG = "weatherCondition";  // flags.<sys>.weatherCondition = id

/* Temperature ceilings (°C) for the cold tiers. The most severe tier whose
 * ceiling the temperature is at or below is the one offered for grabbing.
 * Heat uses HEAT_EXHAUSTION_C from weather-modifiers. */
export const COLD_CHILLY_C   = 5;
export const COLD_COLD_C     = 0;
export const COLD_FREEZING_C = -10;

/* AE change in this system's native v14 shape ({key,type,value,phase}). The
 * sta.max multiply must run in the "final" phase to survive prepareDerivedData;
 * stat adds run "initial" so they propagate into derived formulas. */
const change = (key, value, type, phase) =>
    ({ key, value: String(value), type, phase, priority: 0 });

/** Equipped body armour weight class (light/medium/heavy), shields excluded —
 *  the same scan character.prepareDerivedData uses for SP. null if unarmoured. */
function equippedArmorType(actor) {
    const worn = actor?.items?.find?.(i =>
        i.type === "armor" && i.system?.equipped
        && i.system?.location !== "Shield" && i.system?.armorType !== "shield");
    return worn?.system?.armorType ?? null;
}

/** Bearer's Stun derived stat (1–10), the survival-hours figure for cold. */
function stunValue(actor) {
    const n = Number(actor?.system?.derivedStats?.stun);
    return Number.isFinite(n) && n > 0 ? n : 1;
}

/** AE duration counting down `hours` of world time from now. */
function coldDuration(hours) {
    const spd = game.time?.calendar?.secondsPerDay || 86400;
    const seconds = Math.max(1, Math.round(hours)) * (spd / 24);
    return { seconds, startTime: game.time?.worldTime ?? 0 };
}

/* Condition registry. `build(actor)` returns the per-actor AE payload (changes,
 * optional duration, localized description). */
export const WEATHER_CONDITIONS = Object.freeze({
    heatExhaustion: {
        id: "heatExhaustion",
        kind: "heat",
        name: "WITCHER.Weather.Condition.HeatExhaustion",
        img: "icons/svg/sun.svg",
        build(actor) {
            let weather = null;
            try { weather = getActiveWeather(); } catch (_) { /* not ready */ }
            const factor = staminaHeatFactor(weather, { armorType: equippedArmorType(actor) });
            return {
                description: game.i18n.localize("WITCHER.Weather.Condition.HeatExhaustionDesc"),
                changes: [change("system.derivedStats.sta.max", factor, "multiply", "final")]
            };
        }
    },
    chilly: {
        id: "chilly",
        kind: "cold",
        name: "WITCHER.Weather.Condition.Chilly",
        img: "icons/svg/frozen.svg",
        build() {
            return {
                description: game.i18n.localize("WITCHER.Weather.Condition.ChillyDesc"),
                changes: [change("system.stats.dex.value", -1, "add", "initial")]
            };
        }
    },
    cold: {
        id: "cold",
        kind: "cold",
        name: "WITCHER.Weather.Condition.Cold",
        img: "icons/svg/frozen.svg",
        build(actor) {
            const hours = stunValue(actor);
            return {
                description: game.i18n.format("WITCHER.Weather.Condition.ColdDesc", { hours }),
                duration: coldDuration(hours),
                changes: [
                    change("system.stats.dex.value", -1, "add", "initial"),
                    change("system.stats.ref.value", -1, "add", "initial")
                ]
            };
        }
    },
    freezing: {
        id: "freezing",
        kind: "cold",
        name: "WITCHER.Weather.Condition.Freezing",
        img: "icons/svg/frozen.svg",
        build(actor) {
            const hours = Math.max(1, Math.floor(stunValue(actor) / 2));
            return {
                description: game.i18n.format("WITCHER.Weather.Condition.FreezingDesc", { hours }),
                duration: coldDuration(hours),
                changes: [
                    change("system.stats.dex.value", -2, "add", "initial"),
                    change("system.stats.ref.value", -1, "add", "initial")
                ]
            };
        }
    }
});

/** The condition id(s) the current weather makes available to grab — the single
 *  tier matching the active temperature (heat above the threshold, else the
 *  most severe applicable cold tier). Empty in temperate weather. */
export function availableWeatherConditions(worldTime = game.time?.worldTime ?? 0) {
    let weather = null;
    try { weather = getActiveWeather(worldTime); } catch (_) { return []; }
    const temp = Number(weather?.temp);
    if (!Number.isFinite(temp)) return [];
    if (temp >= HEAT_EXHAUSTION_C) return ["heatExhaustion"];
    if (temp <= COLD_FREEZING_C)   return ["freezing"];
    if (temp <= COLD_COLD_C)       return ["cold"];
    if (temp <= COLD_CHILLY_C)     return ["chilly"];
    return [];
}

export function hasWeatherCondition(actor, id) {
    return !!actor?.effects?.find?.(e => e.getFlag?.(SYSTEM_ID, CONDITION_FLAG) === id);
}

export async function applyWeatherCondition(actor, id) {
    const spec = WEATHER_CONDITIONS[id];
    if (!actor || !spec) return;
    if (!actor.isOwner && !game.user?.isGM) return;
    if (hasWeatherCondition(actor, id)) return;
    const built = spec.build(actor) ?? {};
    await actor.createEmbeddedDocuments("ActiveEffect", [{
        name: game.i18n.localize(spec.name),
        img: spec.img,
        description: built.description ?? "",
        disabled: false,
        duration: built.duration ?? {},
        changes: built.changes ?? [],
        flags: { [SYSTEM_ID]: { [CONDITION_FLAG]: id } }
    }]);
}

export async function removeWeatherCondition(actor, id) {
    const ours = actor?.effects?.filter?.(e => e.getFlag?.(SYSTEM_ID, CONDITION_FLAG) === id) ?? [];
    if (!ours.length) return;
    await actor.deleteEmbeddedDocuments("ActiveEffect", ours.map(e => e.id));
}

export async function toggleWeatherCondition(actor, id) {
    return hasWeatherCondition(actor, id)
        ? removeWeatherCondition(actor, id)
        : applyWeatherCondition(actor, id);
}

/** Actors a "grab" click targets: selected token actors if any, else the
 *  user's assigned character. (GMs select tokens; players grab onto their own.) */
function grabTargets() {
    const controlled = canvas?.tokens?.controlled?.map(t => t.actor).filter(Boolean) ?? [];
    if (controlled.length) return controlled;
    const ch = game.user?.character;
    return ch ? [ch] : [];
}

/** Toggle a condition on the grab targets (selected tokens or own character).
 *  Used by the weather panel "grab" buttons. */
export async function grabWeatherCondition(id) {
    if (!WEATHER_CONDITIONS[id]) return;
    const targets = grabTargets();
    if (!targets.length) {
        ui.notifications?.warn(game.i18n.localize("WITCHER.Weather.Condition.NoTarget"));
        return;
    }
    for (const actor of targets) await toggleWeatherCondition(actor, id);
}

export const weatherConditionApi = Object.freeze({
    WEATHER_CONDITIONS,
    availableWeatherConditions,
    hasWeatherCondition,
    applyWeatherCondition,
    removeWeatherCondition,
    toggleWeatherCondition,
    grabWeatherCondition
});
