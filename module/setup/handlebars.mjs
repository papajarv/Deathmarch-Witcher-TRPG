/**
 * registerHandlebars — registers Handlebars helpers and preloads templates
 * during the `init` hook.
 *
 * Helpers we expose:
 *   - `concat`  — string concatenation (used to build i18n keys dynamically
 *                 inside templates: `(concat "WITCHER.skills." key ".label")`)
 *
 * Templates are preloaded so they're cached for sheet renders.
 */

const SYSTEM_ID = "witcher-ttrpg-death-march";

export function registerHandlebars() {
    Handlebars.registerHelper("concat", (...args) =>
        args.slice(0, -1).join("")
    );

    /* json — pretty-print a value as a JSON string. Used for editable
     * ArrayField / ObjectField inputs on the item sheets where the
     * underlying schema wants real arrays/objects but the player edits
     * them as text. `data-dtype="JSON"` on the input tells
     * FormDataExtended to JSON.parse it back on submit. */
    Handlebars.registerHelper("json", (value) => {
        try { return JSON.stringify(value ?? null, null, 2); }
        catch { return ""; }
    });

    /* eq — equality check for `{{#if (eq a b)}}` branches in templates.
     * Foundry v14 ships this as a built-in but registering it explicitly
     * keeps the system self-contained and lets the templates not depend
     * on Foundry's helper-registration timing. */
    if (!Handlebars.helpers.eq) {
        Handlebars.registerHelper("eq", (a, b) => a === b);
    }
    if (!Handlebars.helpers.gte) {
        Handlebars.registerHelper("gte", (a, b) => Number(a) >= Number(b));
    }
    /* `includes arr item` — true if `arr` is an Array and contains
     * `item` (loose equality). Used by multi-checkbox templates to
     * decide the `checked` state of each option against a backing
     * array on the document (e.g. weapon.system.qualities). */
    if (!Handlebars.helpers.includes) {
        Handlebars.registerHelper("includes", (arr, item) =>
            Array.isArray(arr) && arr.includes(item));
    }
    /* `range n` — emit a 0..n-1 array. Useful for repeating a UI
     * element N times (e.g. enhancement-slot boxes equal to a weapon's
     * slot count). Clamped to 0..50 so a runaway value can't lock up
     * the renderer. */
    if (!Handlebars.helpers.range) {
        Handlebars.registerHelper("range", (n) => {
            const count = Math.max(0, Math.min(50, Number(n) | 0));
            return Array.from({ length: count }, (_, i) => i);
        });
    }
    /* `or a b [c ...]` — truthy if any argument is truthy. The last
     * arg is Handlebars' options hash, which we strip. */
    if (!Handlebars.helpers.or) {
        Handlebars.registerHelper("or", function (...args) {
            args.pop();
            return args.some(Boolean);
        });
    }
    /* `and a b [c ...]` — truthy only when every argument is truthy. Same
     * options-hash strip as `or`. */
    if (!Handlebars.helpers.and) {
        Handlebars.registerHelper("and", function (...args) {
            args.pop();
            return args.every(Boolean);
        });
    }
    /* `homebrew "key"` — true if the named homebrew toggle is on (ADR
     * 0003). Subexpression form `{{#if (homebrew "stress")}}` needs a
     * real registered helper (a context-only function isn't resolved as
     * a subexpression callee). Reads through the same API as code paths. */
    if (!Handlebars.helpers.homebrew) {
        Handlebars.registerHelper("homebrew", (key) =>
            game.system?.api?.homebrew?.isEnabled?.(key) ?? false);
    }

    foundry.applications.handlebars.loadTemplates([
        // Actor sheets
        `systems/${SYSTEM_ID}/templates/actor/character/main.hbs`,
        `systems/${SYSTEM_ID}/templates/actor/monster/main.hbs`,
        `systems/${SYSTEM_ID}/templates/actor/loot/main.hbs`,

        // Per-type item sheets — preloaded so first-open of an item
        // is snappy (Foundry caches after first fetch but the initial
        // hit feels laggy on a fresh session).
        `systems/${SYSTEM_ID}/templates/item/main.hbs`,
        `systems/${SYSTEM_ID}/templates/item/weapon.hbs`,
        `systems/${SYSTEM_ID}/templates/item/ammo.hbs`,
        `systems/${SYSTEM_ID}/templates/item/armor.hbs`,
        `systems/${SYSTEM_ID}/templates/item/shield.hbs`,
        `systems/${SYSTEM_ID}/templates/item/alchemical.hbs`,
        `systems/${SYSTEM_ID}/templates/item/spell.hbs`,
        `systems/${SYSTEM_ID}/templates/item/hex.hbs`,
        `systems/${SYSTEM_ID}/templates/item/ritual.hbs`,
        `systems/${SYSTEM_ID}/templates/item/mutagen.hbs`,
        `systems/${SYSTEM_ID}/templates/item/profession.hbs`,
        `systems/${SYSTEM_ID}/templates/item/race.hbs`,
        `systems/${SYSTEM_ID}/templates/item/homeland.hbs`,
        `systems/${SYSTEM_ID}/templates/item/component.hbs`,
        `systems/${SYSTEM_ID}/templates/item/enhancement.hbs`,
        `systems/${SYSTEM_ID}/templates/item/container.hbs`,
        `systems/${SYSTEM_ID}/templates/item/valuable.hbs`,
        `systems/${SYSTEM_ID}/templates/item/food.hbs`,
        `systems/${SYSTEM_ID}/templates/item/note.hbs`,
        `systems/${SYSTEM_ID}/templates/item/criticalWound.hbs`,
        `systems/${SYSTEM_ID}/templates/item/diagrams.hbs`,

        // Shared item-sheet partials
        `systems/${SYSTEM_ID}/templates/item/partials/source-field.hbs`,

        // Dialogs
        `systems/${SYSTEM_ID}/templates/dialog/heal-rest.hbs`,

        // Applications (settings menus, etc.)
        `systems/${SYSTEM_ID}/templates/applications/qualities-editor.hbs`,
        `systems/${SYSTEM_ID}/templates/applications/status-effects-editor.hbs`,
        `systems/${SYSTEM_ID}/templates/applications/homebrew-content-editor.hbs`,
        `systems/${SYSTEM_ID}/templates/applications/weather-config-field.hbs`,
        `systems/${SYSTEM_ID}/templates/applications/weather-config-general.hbs`,
        `systems/${SYSTEM_ID}/templates/applications/weather-config-climate.hbs`,
        `systems/${SYSTEM_ID}/templates/applications/weather-config-terrain.hbs`,
        `systems/${SYSTEM_ID}/templates/applications/weather-config-modifiers.hbs`,
        `systems/${SYSTEM_ID}/templates/applications/weather-config-calendar.hbs`,

        // Chrome inventory inspection panel
        `systems/${SYSTEM_ID}/templates/inspection/item-card.hbs`,

        // Friendly ActiveEffect editor (unified Effects tab)
        `systems/${SYSTEM_ID}/templates/active-effect/effects.hbs`,
        `systems/${SYSTEM_ID}/templates/active-effect/effect-action.hbs`,

        // Minigames
        `systems/${SYSTEM_ID}/templates/minigames/farkle/status.hbs`,
        `systems/${SYSTEM_ID}/templates/minigames/farkle/stage.hbs`,
        `systems/${SYSTEM_ID}/templates/minigames/farkle/controls.hbs`,
        `systems/${SYSTEM_ID}/templates/minigames/dicepoker/status.hbs`,
        `systems/${SYSTEM_ID}/templates/minigames/dicepoker/stage.hbs`,
        `systems/${SYSTEM_ID}/templates/minigames/dicepoker/controls.hbs`
    ]);
}
