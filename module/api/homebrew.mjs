/**
 * Homebrew toggle API (ADR 0003).
 *
 * Single canonical check for any homebrew code path. Exposed on
 * `game.system.api.homebrew` for cross-module reads.
 *
 * Usage:
 *   import { isHomebrewEnabled } from "../api/homebrew.mjs";
 *   if (!isHomebrewEnabled("bookSystem")) return;
 *
 * Reading a key that doesn't exist in WITCHER.HOMEBREW returns `false`
 * with a console warning — easier to debug than silently treating it as on.
 */

import { HOMEBREW } from "../setup/config.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";

export function isHomebrewEnabled(key) {
    if (!Object.hasOwn(HOMEBREW, key)) {
        console.warn(`${SYSTEM_ID} | unknown homebrew key '${key}'`);
        return false;
    }
    return game.settings.get(SYSTEM_ID, `homebrew.${key}`);
}

/* Convenience wrapper for the Combat Extended subsystem (guard stances,
 * raise shield, revised attack/defense costs, GM-tunable action editor).
 * Every CE-aware call site reads through this so toggle semantics live
 * in one place — flipping the underlying setting key never requires
 * touching dozens of call sites. */
export function isCombatExtendedEnabled() {
    return isHomebrewEnabled("extendedCombat");
}

/* Per-subsystem toggle within Combat Extended. The GM can switch off any
 * one element (guards / raiseShield / actionCosts / defenseCosts) without
 * disabling the whole CE suite. All subsystems default to ON when the
 * master toggle is on — opting OUT is the explicit action.
 *
 * Returns:
 *   - false when the master extendedCombat toggle is off (CE subsystems
 *     are conceptually meaningless then)
 *   - the subsystem flag (default true) otherwise
 *
 * Known subsystem keys:
 *   guards         — guard stances (mods + dock button + config dialog)
 *   raiseShield    — Raise Shield button + dialog + damage routing
 *   actionCosts    — CE strike costs + new actions (vs RAW STRIKE_TYPES)
 *   defenseCosts   — CE defense costs + additive recurrence
 *
 * Adding a new subsystem: register its default in CE_SUBSYSTEM_DEFAULTS
 * below; consumers don't need to enumerate the keys themselves. */
export const CE_SUBSYSTEM_DEFAULTS = Object.freeze({
    guards:       true,
    raiseShield:  true,
    actionCosts:  true,
    defenseCosts: true,
    /* EO armor framework: per-location AE slots + En glyph pool, arming
     * jacks, Difficult-armor gate, and the new EV math (max STA / RUN
     * penalty + half-EV skill penalty instead of REF/DEX subtraction).
     * Defaults ON when CE is on — keeping the toggle so a table that
     * wants ONLY guards + raise shield can leave the armor model RAW. */
    eoArmorModel: true
});
/* Combat Extended tuneables (secondary knobs configured via the
 * Combat Extended editor's Tuneables section). The map is keyed by
 * the same names as CE_TUNEABLE_DEFAULTS (re-exported here so the
 * editor and the consumers stay in sync — single source of truth lives
 * in combatActionsEditor.mjs, mirrored here defensively). */
export const CE_TUNEABLE_DEFAULTS = Object.freeze({
    additiveDefenseRecurrence:         true,
    raiseShieldAutoBalanced:           true,
    headCoverAppliesRestrictedVision:  true,
    heftyBlocksFastStrike:             true
});
/* Read one tuneable. Returns the stored value when present, else the
 * baked-in default. Safe in node test envs (catches missing game
 * settings) — returns the default. */
export function ceTuneable(key) {
    const def = CE_TUNEABLE_DEFAULTS[key];
    try {
        const ov = game.settings?.get?.(SYSTEM_ID, "combatExtendedTuneables") ?? {};
        const v = ov[key];
        if (v === undefined) return def;
        return typeof def === "boolean" ? !!v : Number(v) || 0;
    } catch (_) {
        return def;
    }
}

export function isCESubsystemEnabled(key) {
    /* Master toggle read can throw in a node test env (no `game` global).
     * Swallow it so callers don't need to wrap — safe-by-default returns
     * false. The same defensive pattern lives in guards.mjs via ceOn(). */
    let masterOn = false;
    try { masterOn = isCombatExtendedEnabled(); }
    catch (_) { return false; }
    if (!masterOn) return false;
    if (!Object.hasOwn(CE_SUBSYSTEM_DEFAULTS, key)) {
        console.warn(`${SYSTEM_ID} | unknown CE subsystem key '${key}'`);
        return false;
    }
    let overrides = {};
    try { overrides = game.settings.get(SYSTEM_ID, "combatExtendedSubsystems") ?? {}; }
    catch (_) { overrides = {}; }
    const v = overrides[key];
    return v === undefined ? CE_SUBSYSTEM_DEFAULTS[key] : !!v;
}
