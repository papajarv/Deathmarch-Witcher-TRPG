/**
 * HomebrewContentEditor — the GM-facing toggle list for the bundled
 * homebrew CONTENT subsystems (book system, stress, food & drink, the
 * Farkle / Dice Poker tables, merchant). Opens from Configure Settings →
 * "Manage Homebrew Content".
 *
 * Extended Combat (WIP) is also managed here. The remaining house-rule
 * toggle (splitMovement) stays inline in the main settings list. The split
 * is driven by each `HOMEBREW[key].kind` ("content" vs "rule") in config.mjs.
 *
 * Each row maps to the `homebrew.<key>` world setting (registered in
 * setup/settings.mjs, `requiresReload:true`). Saving sets only the
 * settings that changed, so Foundry's reload prompt fires once if any
 * toggle actually moved.
 */

import { HOMEBREW } from "../setup/config.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/* The content toggles, in enum order. */
const CONTENT_KEYS = Object.entries(HOMEBREW)
    .filter(([, meta]) => meta.kind === "content")
    .map(([key]) => key);

/* Localize an i18n key, falling back to a humanized key if it's missing. */
function loc(i18nKey, fallback) {
    const out = game.i18n.localize(i18nKey);
    return out === i18nKey ? fallback : out;
}

export class HomebrewContentEditor extends HandlebarsApplicationMixin(ApplicationV2) {

    static DEFAULT_OPTIONS = {
        id: "wdm-homebrew-content",
        classes: ["witcher-ttrpg-death-march", "wdm-homebrew-editor"],
        tag: "form",
        window: {
            title: "Homebrew Content",
            icon: "fa-solid fa-flask-vial",
            resizable: true
        },
        position: { width: 560, height: "auto" },
        form: {
            handler: HomebrewContentEditor.#onSubmit,
            submitOnChange: false,
            closeOnSubmit: true
        }
    };

    static PARTS = {
        main:   { template: "systems/witcher-ttrpg-death-march/templates/applications/homebrew-content-editor.hbs", scrollable: [""] },
        footer: { template: "templates/generic/form-footer.hbs" }
    };

    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        ctx.rows = CONTENT_KEYS.map(key => ({
            key,
            name: loc(`WITCHER.Settings.Homebrew.${key}.Name`, key),
            hint: loc(`WITCHER.Settings.Homebrew.${key}.Hint`, ""),
            checked: game.settings.get(SYSTEM_ID, `homebrew.${key}`)
        }));
        ctx.buttons = [{ type: "submit", icon: "fa-solid fa-floppy-disk", label: "Save" }];
        return ctx;
    }

    static async #onSubmit(event, form, formData) {
        const data = foundry.utils.expandObject(formData.object);
        const enabled = data.enabled || {};
        let anyChanged = false;
        for (const key of CONTENT_KEYS) {
            const next = !!enabled[key];
            if (next !== game.settings.get(SYSTEM_ID, `homebrew.${key}`)) {
                await game.settings.set(SYSTEM_ID, `homebrew.${key}`, next);
                anyChanged = true;
            }
        }
        ui.notifications.info("Homebrew content saved.");
        // Each homebrew.<key> setting is `requiresReload: true`, but Foundry's
        // automatic reload prompt only fires from the native Configure Settings
        // panel — custom editors have to call it themselves. Without this the
        // GM would flip a toggle, save, see no immediate effect, and not
        // realize a reload is needed for CONFIG.statusEffects + the
        // homebrew-gated UI surfaces to rebuild.
        if (anyChanged) {
            const SettingsConfig = foundry.applications?.settings?.SettingsConfig
                                ?? globalThis.SettingsConfig;
            try { await SettingsConfig?.reloadConfirm?.({ world: true }); }
            catch (err) { console.warn("witcher-ttrpg-death-march | reload prompt failed", err); }
        }
    }
}
