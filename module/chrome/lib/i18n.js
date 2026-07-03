/**
 * Tiny i18n helper used across chrome modules.
 *
 *   t("WITCHER.X.Y", "Fallback") → game.i18n.localize("WITCHER.X.Y")
 *
 * Why the fallback parameter — Foundry's `game.i18n.localize` returns the
 * KEY itself when the key isn't registered, which means a missing key
 * shows the user a raw `WITCHER.Notify.Bestiary.NoTarget` string. The
 * fallback gives the same readable text we used before the migration so
 * a partial / in-progress en.json never degrades the UI.
 *
 * The translator's contract: provide every WITCHER.* key referenced
 * anywhere in the code, and the fallback is never seen. Tooling that
 * verifies this lives in tools/audit-i18n.mjs (and its CI-strict mode).
 *
 * format(key, data, fallback) handles {placeholders} the same way.
 */

export function t(key, fallback) {
    const v = globalThis.game?.i18n?.localize?.(key);
    if (v && v !== key) return v;
    return fallback ?? key;
}

export function tFormat(key, data, fallback) {
    const v = globalThis.game?.i18n?.format?.(key, data);
    if (v && v !== key) return v;
    /* Format the fallback with the same {placeholder} substitution rules
     * so a missing key still produces a readable, interpolated string. */
    if (fallback) {
        return fallback.replace(/\{(\w+)\}/g, (_, k) => data?.[k] ?? `{${k}}`);
    }
    return key;
}
