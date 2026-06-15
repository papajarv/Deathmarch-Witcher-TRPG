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
