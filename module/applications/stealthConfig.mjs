/**
 * StealthConfigApp — GM-only Token Stealth configuration.
 *
 * Edits the single `stealthConfig` world Object payload. Sections:
 *   • Master enable + core behavior toggles.
 *   • Base sight distance.
 *   • Range band table (mod + fraction of max sight per band).
 *   • Vision-zone modifiers.
 *   • Body-coverage modifier table.
 *   • Debug / diagnostic output preferences.
 *   • Cone rendering (hide-when-spotted, alpha scaling).
 *
 * Save reads the form, merges over the current stored config, and
 * writes back. Consumers pull LIVE from the setting on every check,
 * so mid-session edits take effect on the next detection dispatch
 * without a world reload for most fields.
 */

import { STEALTH_CONFIG_DEFAULTS, STEALTH_CONFIG_KEY,
         setStealthConfig, invalidateStealthConfigCache } from "../mechanics/stealth-config.mjs";

import { t } from "../chrome/lib/i18n.js";
const SYSTEM_ID = "witcher-ttrpg-death-march";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class StealthConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {

    static DEFAULT_OPTIONS = {
        id: "wdm-stealth-config",
        classes: ["witcher-ttrpg-death-march", "wdm-stealth-config"],
        tag: "form",
        window: {
            /* Foundry's ApplicationV2 auto-localizes the title from an
             * i18n key; this key IS present in lang/en.json (added with
             * the App.StealthConfig.* block). Using an App-side key here
             * — the Settings.StealthConfig.* keys are for the "Configure
             * Settings" menu entry, not the window title. */
            title: "WITCHER.App.StealthConfig.Title",
            icon: "fa-solid fa-user-ninja",
            resizable: true
        },
        /* Cap the window at ~85vh so a small screen or a scaled UI still
         * lets every section be reached. The form body's own overflow
         * (see stealth-config.css) turns on the scroll bar when content
         * overflows this height. */
        position: { width: 640, height: 720 },
        form: {
            handler: StealthConfigApp.#onSubmit,
            submitOnChange: false,
            closeOnSubmit: true
        },
        actions: {
            resetDefaults: StealthConfigApp.#onResetDefaults
        }
    };

    static PARTS = {
        main:   { template: `systems/${SYSTEM_ID}/templates/applications/stealth-config.hbs` },
        footer: { template: "templates/generic/form-footer.hbs" }
    };

    /* ─────────── context ─────────── */

    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        let stored = {};
        try { stored = game.settings.get(SYSTEM_ID, STEALTH_CONFIG_KEY) ?? {}; }
        catch (_) { stored = {}; }
        const v = foundry.utils.mergeObject(
            foundry.utils.deepClone(STEALTH_CONFIG_DEFAULTS),
            stored,
            { inplace: true, overwrite: true }
        );

        ctx.values = {
            enabled:              !!v.enabled,
            crossLevelDetection:  !!v.crossLevelDetection,
            debug:                !!v.debug,
            hideConeWhenSpotted:  !!v.hideConeWhenSpotted,
            fullCircleIsUnset:    !!v.fullCircleIsUnset,
            clipOverlayToOwnFov:  !!v.clipOverlayToOwnFov,
            pointBlankAutoSpot:   !!v.pointBlankAutoSpot,
            rollChatCard:         !!v.rollChatCard,
            spottedChatCard:      !!v.spottedChatCard,

            dBaseMetres:           Number(v.dBaseMetres)           || 80,
            lightStep:             Number(v.lightStep)             || 0.2,
            skillBase:             Number(v.skillBase)             || 1.12,
            nightCeilingMetres:    Number(v.nightCeilingMetres)    || 40,
            defaultVisionAngleDeg: Number(v.defaultVisionAngleDeg) || 120,
            threshold:             Number(v.threshold)             || 10,
            exposureDecayPerTick:  Number(v.exposureDecayPerTick)  || 2,
            pointBlankMetres:      Number(v.pointBlankMetres)      || 1,

            tierModifiers: {
                outer: Number(v.tierModifiers?.outer) || 0,
                mid:   Number(v.tierModifiers?.mid)   || 0,
                inner: Number(v.tierModifiers?.inner) || 0,
                core:  Number(v.tierModifiers?.core)  || 0
            },
            coverBonuses: {
                exposed:      Number(v.coverBonuses?.exposed)      || 0,
                threeQuarter: Number(v.coverBonuses?.threeQuarter) || 0,
                half:         Number(v.coverBonuses?.half)         || 0,
                quarter:      Number(v.coverBonuses?.quarter)      || 0,
                sliver:       Number(v.coverBonuses?.sliver)       || 0
            },
            paceBonuses: {
                still: Number(v.paceBonuses?.still) || 0,
                creep: Number(v.paceBonuses?.creep) || 0,
                walk:  Number(v.paceBonuses?.walk)  || 0,
                run:   Number(v.paceBonuses?.run)   || 0
            },
            postureProne: Number(v.postureBonuses?.prone) || 0,

        };
        ctx.buttons = [
            { type: "button", action: "resetDefaults", icon: "fa-solid fa-arrow-rotate-left",
              label: t("WITCHER.App.StealthConfig.ResetToDefaults", "Reset to Defaults") },
            { type: "submit", icon: "fa-solid fa-floppy-disk",
              label: t("WITCHER.App.StealthConfig.Save", "Save") }
        ];
        return ctx;
    }

    /* ─────────── lifecycle ─────────── */

    /* ─────────── actions ─────────── */

    static async #onResetDefaults() {
        const ok = await foundry.applications.api.DialogV2.confirm({
            window: { title: t("WITCHER.App.StealthConfig.ResetConfirmTitle", "Reset stealth config?") },
            content: `<p>${t("WITCHER.App.StealthConfig.ResetConfirmBody",
                "Discard all stealth configuration overrides and restore the defaults? Takes effect when you Save.")}</p>`,
            modal: true,
            rejectClose: false
        }).catch(() => false);
        if (!ok) return;
        for (const el of this.element.querySelectorAll("[data-config-key]")) {
            const key = el.dataset.configKey;
            const def = _readDefault(key);
            if (def === undefined) continue;
            if (el.type === "checkbox") el.checked = !!def;
            else el.value = String(def);
        }
    }

    static async #onSubmit(event, form, formData) {
        const raw = foundry.utils.expandObject(formData.object);
        const clampFrac = v => Math.max(0.01, Number(v) || 0);
        /* Snapshot the pre-save state of the ONLY setting that
         * genuinely requires a reload — the master `enabled`
         * toggle. Every other setting is read live by its
         * consumers, so flipping them just takes effect on the
         * next detection dispatch / overlay refresh without a
         * world reload. */
        const priorEnabled = !!(game.settings.get(SYSTEM_ID, STEALTH_CONFIG_KEY)?.enabled);
        const patch = {
            enabled:              !!raw.enabled,
            crossLevelDetection:  !!raw.crossLevelDetection,
            debug:                !!raw.debug,
            hideConeWhenSpotted:  !!raw.hideConeWhenSpotted,
            fullCircleIsUnset:    !!raw.fullCircleIsUnset,
            clipOverlayToOwnFov:  !!raw.clipOverlayToOwnFov,
            pointBlankAutoSpot:   !!raw.pointBlankAutoSpot,
            rollChatCard:         !!raw.rollChatCard,
            spottedChatCard:      !!raw.spottedChatCard,

            dBaseMetres:          Math.max(1, Number(raw.dBaseMetres) || 80),
            /* Inside (0, 0.5]: at 0 darkness stops mattering; past 0.5 two tiers
             * of gloom would zero out sight entirely. */
            lightStep:            Math.min(0.5, Math.max(0.01, Number(raw.lightStep) || 0.2)),
            skillBase:            Math.max(1.001, Number(raw.skillBase) || 1.12),
            nightCeilingMetres:   Math.max(1, Number(raw.nightCeilingMetres) || 40),
            defaultVisionAngleDeg: Math.min(360, Math.max(1, Number(raw.defaultVisionAngleDeg) || 120)),
            threshold:            Math.max(1, Number(raw.threshold) || 10),
            exposureDecayPerTick: Math.max(0, Number(raw.exposureDecayPerTick) || 2),
            pointBlankMetres:     Math.max(0, Number(raw.pointBlankMetres) || 1),

            tierModifiers: {
                outer: Number(raw.tierModifiers?.outer) || 0,
                mid:   Number(raw.tierModifiers?.mid)   || 0,
                inner: Number(raw.tierModifiers?.inner) || 0,
                core:  Number(raw.tierModifiers?.core)  || 0
            },
            coverBonuses: {
                exposed:      Number(raw.coverBonuses?.exposed)      || 0,
                threeQuarter: Number(raw.coverBonuses?.threeQuarter) || 0,
                half:         Number(raw.coverBonuses?.half)         || 0,
                quarter:      Number(raw.coverBonuses?.quarter)      || 0,
                sliver:       Number(raw.coverBonuses?.sliver)       || 0
            },
            paceBonuses: {
                still: Number(raw.paceBonuses?.still) || 0,
                creep: Number(raw.paceBonuses?.creep) || 0,
                walk:  Number(raw.paceBonuses?.walk)  || 0,
                run:   Number(raw.paceBonuses?.run)   || 0
            },
            postureBonuses: { standing: 0, prone: Number(raw.postureProne) || 0 },

        };
        await setStealthConfig(patch);
        invalidateStealthConfigCache();   /* edits apply on the next check, not in 250 ms */
        ui.notifications.info(t("WITCHER.App.StealthConfig.Saved", "Stealth configuration saved."));
        /* Reload prompt is gated: it fires ONLY when the master
         * `enabled` toggle actually flipped. All other settings
         * are consumed live via `getStealthConfig()` and take
         * effect on the next detection dispatch / overlay refresh
         * without a reload. The `enabled` toggle needs a reload
         * because the sneak HUD button's mount decision reads it
         * once at render time — currently-open HUDs won't re-
         * evaluate on their own. */
        if (priorEnabled !== patch.enabled) {
            const SettingsConfig = foundry.applications?.settings?.SettingsConfig
                                ?? globalThis.SettingsConfig;
            try { await SettingsConfig?.reloadConfirm?.({ world: true }); }
            catch (err) { console.warn(`${SYSTEM_ID} | stealth config reload prompt failed`, err); }
        }
    }
}

/** Read a default value by nested key path (e.g. "rangeBandMods.close"). */
function _readDefault(path) {
    return path.split(".").reduce(
        (o, k) => (o == null ? undefined : o[k]),
        STEALTH_CONFIG_DEFAULTS
    );
}
