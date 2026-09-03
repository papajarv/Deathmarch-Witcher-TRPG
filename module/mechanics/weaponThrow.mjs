import { isCombatExtendedEnabled } from "../api/homebrew.mjs";

/**
 * Single source of truth for "can this weapon be thrown right now" — shared by
 * the dock's Melee/Throw toggle + tile-targeting overlay and the attack dialog's
 * throw strike, so the toggle can never offer a throw the attack then refuses.
 *
 * Rules (mirror attackDialog's `canThrow`):
 *   - Melee weapons only. Bows / crossbows / bombs are never "thrown"; the
 *     legacy `weaponType: "thrown"` was migrated to `"melee"` (WeaponData.migrateData).
 *   - Needs a REAL range value: non-empty and not the `N/A` · `-` · `--` pack
 *     sentinels, which mean the field is carried for display but the weapon
 *     isn't throwable (a bullwhip, bagh nakh, medical syringe…).
 *   - Combat Extended ON  → any hand count may be thrown.
 *   - Combat Extended OFF → RAW: one-handed weapons only. A two-handed
 *     polehammer therefore can't be thrown (and now can't be toggled to thrown).
 */
export function canThrowWeapon(weapon) {
    const sys = weapon?.system ?? {};
    if (sys.weaponType !== "melee") return false;
    const range = String(sys.range ?? "").trim();
    if (!range || /^n\/?a$/i.test(range) || range === "-" || range === "--") return false;
    let ceOn = false;
    try { ceOn = isCombatExtendedEnabled(); } catch (_) { /* settings not ready */ }
    return ceOn ? true : (sys.hands ?? "one") === "one";
}
