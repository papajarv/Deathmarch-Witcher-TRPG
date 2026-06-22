/**
 * StressConfigApp — GM-only stress homebrew configuration.
 *
 * Edits the `stressConfig` world setting (one Object payload) covering:
 *   • System-wide toggles (recovery penalty, wound-stress).
 *   • Numeric tunables on the WILL save flow (threshold multiplier,
 *     post-save clear offset, breakdown cap).
 *   • Critical-wound stress amounts per severity.
 *
 * Defaults match the homebrew baseline so an untouched world plays as before.
 * Save flushes the merged payload to settings and reloads the world so
 * every consumer (`getStressConfig` callers across the codebase) re-reads
 * from a clean init.
 */

import { STRESS_CONFIG_DEFAULTS } from "../mechanics/stress.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const SETTING_KEY = "stressConfig";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class StressConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {

    static DEFAULT_OPTIONS = {
        id: "wdm-stress-config",
        classes: ["witcher-ttrpg-death-march", "wdm-stress-config"],
        tag: "form",
        window: {
            title: "Stress Configuration",
            icon: "fa-solid fa-brain",
            resizable: true
        },
        position: { width: 600, height: "auto" },
        form: {
            handler: StressConfigApp.#onSubmit,
            submitOnChange: false,
            closeOnSubmit: true
        },
        actions: {
            resetDefaults: StressConfigApp.#onResetDefaults
        }
    };

    static PARTS = {
        main:   { template: `systems/${SYSTEM_ID}/templates/applications/stress-config.hbs` },
        footer: { template: "templates/generic/form-footer.hbs" }
    };

    /* ─────────── context ─────────── */

    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        let stored = {};
        try { stored = game.settings.get(SYSTEM_ID, SETTING_KEY) ?? {}; }
        catch (_) { stored = {}; }
        const v = { ...STRESS_CONFIG_DEFAULTS, ...stored };
        ctx.values = {
            recoveryPenaltyEnabled:     !!v.recoveryPenaltyEnabled,
            thresholdPenaltyMultiplier: Number(v.thresholdPenaltyMultiplier) || 1,
            postSaveClearOffset:        Number(v.postSaveClearOffset) || -1,
            breakdownCap:               Math.max(1, Math.min(8, Number(v.breakdownCap) || 8)),
            woundStressEnabled:         !!v.woundStressEnabled,
            woundStressSimple:          Number(v.woundStressSimple)    || 0,
            woundStressComplex:         Number(v.woundStressComplex)   || 0,
            woundStressDifficult:       Number(v.woundStressDifficult) || 0,
            woundStressDeadly:          Number(v.woundStressDeadly)    || 0
        };
        ctx.buttons = [
            { type: "button", action: "resetDefaults", icon: "fa-solid fa-arrow-rotate-left", label: "Reset to Defaults" },
            { type: "submit", icon: "fa-solid fa-floppy-disk", label: "Save & Reload" }
        ];
        return ctx;
    }

    /* ─────────── actions ─────────── */

    static async #onResetDefaults() {
        const ok = await foundry.applications.api.DialogV2.confirm({
            window: { title: "Reset stress config?" },
            content: "<p>Discard all stress configuration overrides and restore the homebrew defaults? This takes effect when you Save.</p>",
            modal: true,
            rejectClose: false
        }).catch(() => false);
        if (!ok) return;
        for (const [k, v] of Object.entries(STRESS_CONFIG_DEFAULTS)) {
            const el = this.element.querySelector(`[name="${k}"]`);
            if (!el) continue;
            if (el.type === "checkbox") el.checked = !!v;
            else el.value = String(v);
        }
    }

    static async #onSubmit(event, form, formData) {
        const raw = foundry.utils.expandObject(formData.object);
        const merged = {
            recoveryPenaltyEnabled:     !!raw.recoveryPenaltyEnabled,
            thresholdPenaltyMultiplier: Number(raw.thresholdPenaltyMultiplier) || 1,
            postSaveClearOffset:        Number.isFinite(Number(raw.postSaveClearOffset))
                                          ? Number(raw.postSaveClearOffset) : -1,
            breakdownCap:               Math.max(1, Math.min(8, Number(raw.breakdownCap) || 8)),
            woundStressEnabled:         !!raw.woundStressEnabled,
            woundStressSimple:          Math.max(0, Number(raw.woundStressSimple)    || 0),
            woundStressComplex:         Math.max(0, Number(raw.woundStressComplex)   || 0),
            woundStressDifficult:       Math.max(0, Number(raw.woundStressDifficult) || 0),
            woundStressDeadly:          Math.max(0, Number(raw.woundStressDeadly)    || 0)
        };
        await game.settings.set(SYSTEM_ID, SETTING_KEY, merged);
        ui.notifications.info("Stress configuration saved.");
        const SettingsConfig = foundry.applications?.settings?.SettingsConfig
                            ?? globalThis.SettingsConfig;
        try { await SettingsConfig?.reloadConfirm?.({ world: true }); }
        catch (err) { console.warn(`${SYSTEM_ID} | stress config reload prompt failed`, err); }
    }
}
