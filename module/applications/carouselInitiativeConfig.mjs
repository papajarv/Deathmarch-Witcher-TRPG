/**
 * CarouselInitiativeConfigApp — GM-only Carousel Initiative configuration.
 *
 * Edits the single `carouselInitiativeConfig` world Object. Sections:
 *   • General — master enable + audience/context gates.
 *   • Layout — card sizing + scale + spacing.
 *   • Motion — transition duration + snap-on-wrap.
 *   • Disposition colors — border color per disposition, active glow.
 *   • Filtering — SECRET / stealth privacy rules.
 *
 * Save reads the form via `expandObject`, clamps numeric ranges, merges
 * over the current stored config, and writes back via `setCarouselConfig`.
 * Consumers in chrome/carousel-initiative.js read live from
 * `getCarouselConfig()` on every render, so most edits take effect on
 * the next carousel refresh — the master `enabled` toggle prompts a
 * reload because it gates hook registration at load time.
 */

import { CAROUSEL_CONFIG_DEFAULTS, CAROUSEL_CONFIG_KEY,
         setCarouselConfig, getCarouselConfig } from "../mechanics/carousel-initiative-config.mjs";
import { t } from "../chrome/lib/i18n.js";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class CarouselInitiativeConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {

    static DEFAULT_OPTIONS = {
        id: "wdm-carousel-initiative-config",
        classes: ["witcher-ttrpg-death-march", "wdm-carousel-config"],
        tag: "form",
        window: {
            title: "WITCHER.App.CarouselInitiativeConfig.Title",
            icon: "fa-solid fa-people-arrows",
            resizable: true
        },
        position: { width: 620, height: 720 },
        form: {
            handler: CarouselInitiativeConfigApp.#onSubmit,
            submitOnChange: false,
            closeOnSubmit: true
        },
        actions: {
            resetDefaults: CarouselInitiativeConfigApp.#onResetDefaults
        }
    };

    static PARTS = {
        main:   { template: `systems/${SYSTEM_ID}/templates/applications/carousel-initiative-config.hbs`,
                  scrollable: [".wdm-carousel-config-body"] },
        footer: { template: "templates/generic/form-footer.hbs" }
    };

    /* ─────────── context ─────────── */

    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        ctx.values = getCarouselConfig();
        ctx.buttons = [
            { type: "button", action: "resetDefaults", icon: "fa-solid fa-arrow-rotate-left",
              label: t("WITCHER.App.CarouselInitiativeConfig.ResetToDefaults", "Reset to Defaults") },
            { type: "submit", icon: "fa-solid fa-floppy-disk",
              label: t("WITCHER.App.CarouselInitiativeConfig.Save", "Save Configuration") }
        ];
        return ctx;
    }

    /* ─────────── lifecycle ─────────── */

    /* Post-render: live-preview color pickers into their hex-text
     * siblings so both stay in sync (color input → hex; user typing
     * a hex → color input). Also gray out sub-controls whose parent
     * toggle is off (e.g., neutral color when "show neutral frame"
     * is unchecked). */
    _onRender(context, options) {
        super._onRender?.(context, options);
        const root = this.element;
        if (!root) return;
        this.#wireColorPairs(root);
        this.#wireDependentControls(root);
    }

    #wireColorPairs(root) {
        for (const pair of root.querySelectorAll("[data-color-pair]")) {
            const colorEl = pair.querySelector('input[type="color"]');
            const hexEl   = pair.querySelector('input[type="text"]');
            if (!colorEl || !hexEl) continue;
            colorEl.addEventListener("input", () => { hexEl.value = colorEl.value; });
            hexEl.addEventListener("input", () => {
                const v = hexEl.value?.trim();
                if (/^#[0-9a-fA-F]{6}$/.test(v)) colorEl.value = v;
            });
        }
    }

    #wireDependentControls(root) {
        /* Neutral color: disabled unless "show neutral frame" is checked */
        const neutralToggle = root.querySelector('input[name="neutralShowFrame"]');
        const neutralPair   = root.querySelector('[data-depends-on="neutralShowFrame"]');
        if (neutralToggle && neutralPair) {
            const sync = () => {
                const on = neutralToggle.checked;
                for (const el of neutralPair.querySelectorAll("input")) el.disabled = !on;
                neutralPair.style.opacity = on ? "" : "0.5";
            };
            neutralToggle.addEventListener("change", sync);
            sync();
        }
    }

    /* ─────────── actions ─────────── */

    static async #onResetDefaults() {
        const ok = await foundry.applications.api.DialogV2.confirm({
            window: { title: t("WITCHER.App.CarouselInitiativeConfig.ResetConfirmTitle", "Reset carousel config?") },
            content: `<p>${t("WITCHER.App.CarouselInitiativeConfig.ResetConfirmBody",
                "Discard all carousel initiative configuration overrides and restore the defaults? Takes effect when you Save.")}</p>`,
            modal: true,
            rejectClose: false
        }).catch(() => false);
        if (!ok) return;
        /* Repopulate every form input from the defaults object using
         * the input's name as the config key. Booleans (checkboxes)
         * flip .checked; everything else sets .value. */
        for (const el of this.element.querySelectorAll("[name]")) {
            const key = el.name;
            const def = CAROUSEL_CONFIG_DEFAULTS[key];
            if (def === undefined) continue;
            if (el.type === "checkbox") el.checked = !!def;
            else el.value = String(def);
        }
        /* Keep the paired color hex-inputs and color-inputs in sync
         * after a reset. */
        for (const pair of this.element.querySelectorAll("[data-color-pair]")) {
            const colorEl = pair.querySelector('input[type="color"]');
            const hexEl   = pair.querySelector('input[type="text"]');
            if (colorEl && hexEl) hexEl.value = colorEl.value;
        }
    }

    static async #onSubmit(event, form, formData) {
        const raw = foundry.utils.expandObject(formData.object);
        /* Clamps — keep numeric fields in sane ranges so a fat-finger
         * doesn't produce an unusable UI (e.g. cardWidth of 0 would
         * render zero-size cards; transition of 10000 would feel
         * broken). Ranges match the UI slider bounds where present. */
        const clampMin = (v, min, dflt) => Math.max(min, Number(v) || dflt);
        const clampRange = (v, min, max, dflt) => Math.min(max, Math.max(min, Number(v) || dflt));
        /* If any color field still emits a RadioNodeList array (would
         * happen if a duplicate-named input crept back in), take the
         * first element instead of String()-joining with commas. */
        const pickColor = (v, dflt) => {
            const s = Array.isArray(v) ? v[0] : v;
            return typeof s === "string" ? s : dflt;
        };
        const priorEnabled = !!getCarouselConfig().enabled;
        const patch = {
            enabled:              !!raw.enabled,
            showForTokenCombat:   !!raw.showForTokenCombat,
            showForTheaterOfMind: !!raw.showForTheaterOfMind,
            showForGM:            !!raw.showForGM,
            showForPlayers:       !!raw.showForPlayers,

            cardWidth:            clampRange(raw.cardWidth,        2,    12,   CAROUSEL_CONFIG_DEFAULTS.cardWidth),
            cardHeight:           clampRange(raw.cardHeight,       3,    16,   CAROUSEL_CONFIG_DEFAULTS.cardHeight),
            portraitHeight:       clampRange(raw.portraitHeight,   2,    14,   CAROUSEL_CONFIG_DEFAULTS.portraitHeight),
            activeScale:          clampRange(raw.activeScale,      1.0,  2.5,  CAROUSEL_CONFIG_DEFAULTS.activeScale),
            containerMaxWidth:    clampRange(raw.containerMaxWidth,20,   120,  CAROUSEL_CONFIG_DEFAULTS.containerMaxWidth),
            cardGap:              clampRange(raw.cardGap,          0,    3,    CAROUSEL_CONFIG_DEFAULTS.cardGap),

            transitionMs:         clampRange(raw.transitionMs,     0,    2000, CAROUSEL_CONFIG_DEFAULTS.transitionMs),
            snapOnRoundWrap:      !!raw.snapOnRoundWrap,

            hostileColor:         pickColor(raw.hostileColor,    CAROUSEL_CONFIG_DEFAULTS.hostileColor),
            friendlyColor:        pickColor(raw.friendlyColor,   CAROUSEL_CONFIG_DEFAULTS.friendlyColor),
            secretColor:          pickColor(raw.secretColor,     CAROUSEL_CONFIG_DEFAULTS.secretColor),
            neutralShowFrame:     !!raw.neutralShowFrame,
            neutralColor:         pickColor(raw.neutralColor,    CAROUSEL_CONFIG_DEFAULTS.neutralColor),
            activeGlowColor:      pickColor(raw.activeGlowColor, CAROUSEL_CONFIG_DEFAULTS.activeGlowColor),

            hideStealthFromPlayers:   !!raw.hideStealthFromPlayers,
            hideSecretFromPlayers:    !!raw.hideSecretFromPlayers,
            respectSpotterVisibility: !!raw.respectSpotterVisibility
        };
        await setCarouselConfig(patch);
        ui.notifications.info(t("WITCHER.App.CarouselInitiativeConfig.Saved",
            "Carousel initiative configuration saved."));
        /* Only the master enable flip requires a reload — hook
         * registration is one-shot at load time. Every other field
         * is read live on each render, so no reload prompt for them. */
        if (priorEnabled !== patch.enabled) {
            const SettingsConfig = foundry.applications?.settings?.SettingsConfig
                                ?? globalThis.SettingsConfig;
            try { await SettingsConfig?.reloadConfirm?.({ world: true }); }
            catch (err) { console.warn(`${SYSTEM_ID} | carousel config reload prompt failed`, err); }
        }
    }
}
