/**
 * BookConfigApp — GM-only book-system configuration.
 *
 * Edits the `bookSystemConfig` world setting (one Object payload) covering the
 * in-world time that must pass between reading sessions:
 *   • studyCooldownHours     — monster/skill books (once per this many hours).
 *   • novelStepCooldownHours — novel/lore books (one chapter per this many hours).
 *
 * Mirrors StressConfigApp's shape + DOM (the shared `.wdm-se-*` classes) so the
 * two menus feel identical. Only registered when the bookSystem homebrew is on.
 * Defaults reproduce the previous hard-coded 4-hour cooldowns, so an untouched
 * world plays exactly as before.
 */

import { t } from "../chrome/lib/i18n.js";
const SYSTEM_ID = "witcher-ttrpg-death-march";
const SETTING_KEY = "bookSystemConfig";

export const BOOK_SYSTEM_CONFIG_DEFAULTS = Object.freeze({
    studyCooldownHours: 4,        // monster/skill: one study session per N in-world hours
    novelStepCooldownHours: 4,    // novel/lore: one chapter per N in-world hours
    languageEnabled: true,        // master toggle for the book-language subsystem
    languagePenaltyPerRanks: 2    // −1 Education per N language-ranks below the book's required rank
});

export function getBookSystemConfig() {
    let stored = {};
    try { stored = game.settings?.get?.(SYSTEM_ID, SETTING_KEY) ?? {}; }
    catch (_) { stored = {}; }
    return { ...BOOK_SYSTEM_CONFIG_DEFAULTS, ...(stored ?? {}) };
}

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class BookConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {

    static DEFAULT_OPTIONS = {
        id: "wdm-book-config",
        classes: ["witcher-ttrpg-death-march", "wdm-book-config"],
        tag: "form",
        window: {
            title: t("WITCHER.Dialog.BookConfig.Title", "Book System Configuration"),
            icon: "fa-solid fa-book",
            resizable: true
        },
        position: { width: 600, height: "auto" },
        form: {
            handler: BookConfigApp.#onSubmit,
            submitOnChange: false,
            closeOnSubmit: true
        },
        actions: {
            resetDefaults: BookConfigApp.#onResetDefaults
        }
    };

    static PARTS = {
        main:   { template: `systems/${SYSTEM_ID}/templates/applications/book-config.hbs` },
        footer: { template: "templates/generic/form-footer.hbs" }
    };

    /* ─────────── context ─────────── */

    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        let stored = {};
        try { stored = game.settings.get(SYSTEM_ID, SETTING_KEY) ?? {}; }
        catch (_) { stored = {}; }
        const v = { ...BOOK_SYSTEM_CONFIG_DEFAULTS, ...stored };
        ctx.values = {
            studyCooldownHours:      Math.max(0, Number(v.studyCooldownHours)     || 0),
            novelStepCooldownHours:  Math.max(0, Number(v.novelStepCooldownHours) || 0),
            languageEnabled:         !!v.languageEnabled,
            languagePenaltyPerRanks: Math.max(1, Number(v.languagePenaltyPerRanks) || 2)
        };
        ctx.buttons = [
            { type: "button", action: "resetDefaults", icon: "fa-solid fa-arrow-rotate-left", label: t("WITCHER.App.BookConfig.Dialog.Button.ResetToDefaults", "Reset to Defaults") },
            { type: "submit", icon: "fa-solid fa-floppy-disk", label: t("WITCHER.Common.SaveReload", "Save & Reload") }
        ];
        return ctx;
    }

    /* ─────────── actions ─────────── */

    static async #onResetDefaults() {
        const ok = await foundry.applications.api.DialogV2.confirm({
            window: { title: t("WITCHER.Dialog.BookConfig.Reset", "Reset book config?") },
            content: `<p>${t("WITCHER.App.BookConfig.Text.DiscardOverrides", "Discard all book-system overrides and restore the defaults? This takes effect when you Save.")}</p>`,
            modal: true,
            rejectClose: false
        }).catch(() => false);
        if (!ok) return;
        for (const [k, v] of Object.entries(BOOK_SYSTEM_CONFIG_DEFAULTS)) {
            const el = this.element.querySelector(`[name="${k}"]`);
            if (!el) continue;
            if (el.type === "checkbox") el.checked = !!v;
            else el.value = String(v);
        }
    }

    static async #onSubmit(event, form, formData) {
        const raw = foundry.utils.expandObject(formData.object);
        const merged = {
            studyCooldownHours:      Math.max(0, Number(raw.studyCooldownHours)     || 0),
            novelStepCooldownHours:  Math.max(0, Number(raw.novelStepCooldownHours) || 0),
            languageEnabled:         !!raw.languageEnabled,
            languagePenaltyPerRanks: Math.max(1, Number(raw.languagePenaltyPerRanks) || 2)
        };
        await game.settings.set(SYSTEM_ID, SETTING_KEY, merged);
        ui.notifications.info(t("WITCHER.Notify.BookConfig.Saved", "Book system configuration saved."));
        const SettingsConfig = foundry.applications?.settings?.SettingsConfig
                            ?? globalThis.SettingsConfig;
        try { await SettingsConfig?.reloadConfirm?.({ world: true }); }
        catch (err) { console.warn(`${SYSTEM_ID} | book config reload prompt failed`, err); }
    }
}
