/**
 * UI Scaling configuration dialog.
 *
 * Opened from the "Configure UI Scaling" button in Configure Settings.
 *
 * UX:
 *   - Mode select: Auto / Manual / Detailed.
 *   - UI Scale slider: hidden when Mode is Auto OR Detailed.
 *   - Chrome Bars Scale slider: hidden when Mode is Detailed.
 *   - Detailed block: only visible when Mode is Detailed. Contains six
 *     sliders — one per chrome region (UI text, Top Bar, Dock, Sidebar,
 *     Scene Controls, Popups).
 *   - Dragging sliders / changing mode previews live by writing the CSS
 *     vars on <html>. Persisted setting values aren't touched until Apply.
 *   - Apply writes all settings. Cancel / close re-applies the
 *     persisted values so the preview doesn't leak.
 */

import { applyUIScale, applyUIScaleValues } from "./ui-scale.js";

const SYS = "witcher-ttrpg-death-march";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/* Keys inside `ui.detailedScales`. Order here drives slider order in the
 * template AND the read/write loop in the dialog handlers. */
const DETAILED_KEYS = Object.freeze(["ui", "topbar", "dock", "sidebar", "scenecontrols", "popups"]);

/* Read the persisted detailed scales, filling missing keys with 1.0.
 * Also serves as the default for new users (setting default in
 * settings.js seeds the same shape). */
function readDetailed() {
    const raw = game.settings.get(SYS, "ui.detailedScales") ?? {};
    const out = {};
    for (const k of DETAILED_KEYS) out[k] = Number(raw[k] ?? 1.0) || 1.0;
    return out;
}

export class UIScaleConfig extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: "wou-ui-scale-config",
        tag: "form",
        classes: ["witcher-ttrpg-death-march", "wou-dialog", "wou-ui-scale-config"],
        window: {
            title: "WOU.Settings.UIScaleConfig.Title",
            icon: "fa-solid fa-up-right-and-down-left-from-center"
        },
        position: { width: 520, height: "auto" },
        actions: {
            apply:  UIScaleConfig.#onApply,
            cancel: UIScaleConfig.#onCancel,
            reset:  UIScaleConfig.#onReset
        }
    };

    static PARTS = {
        body: {
            template: "systems/witcher-ttrpg-death-march/templates/ui-scale-config.hbs"
        }
    };

    /* Snapshot of persisted values at open time. Used to restore on cancel
     * so we don't leak a live-preview that the user backed out of. */
    #snapshot = null;

    async _prepareContext(_options) {
        const mode     = game.settings.get(SYS, "ui.scaleMode") ?? "manual";
        const scale    = Number(game.settings.get(SYS, "ui.scale") ?? 1.0);
        const bars     = Number(game.settings.get(SYS, "ui.chromeBarsScale") ?? 1.0);
        const detailed = readDetailed();
        this.#snapshot ??= { mode, scale, bars, detailed };
        return {
            mode, scale, bars, detailed,
            isAuto:     mode === "auto",
            isDetailed: mode === "detailed"
        };
    }

    _onRender(context, options) {
        super._onRender(context, options);
        const root = this.element;
        const modeSel = root.querySelector('[name="scaleMode"]');
        const scaleEl = root.querySelector('[name="scale"]');
        const barsEl  = root.querySelector('[name="chromeBarsScale"]');
        const scaleRow = root.querySelector('[data-row="scale"]');
        const barsRow  = root.querySelector('[data-row="bars"]');
        const detailedBlock = root.querySelector('[data-detailed-block]');
        const scaleVal = root.querySelector('[data-display="scale"]');
        const barsVal  = root.querySelector('[data-display="chromeBarsScale"]');

        /* Per-detailed slider handles + display spans. Cached once so
         * the refresh loop stays cheap. */
        const detailedInputs = new Map();
        const detailedDisplays = new Map();
        for (const k of DETAILED_KEYS) {
            detailedInputs.set(k, root.querySelector(`[name="detailed.${k}"]`));
            detailedDisplays.set(k, root.querySelector(`[data-display="detailed.${k}"]`));
        }

        const refresh = () => {
            const mode = modeSel.value;
            const scale = Number(scaleEl?.value);
            const bars  = Number(barsEl?.value);
            const detailed = {};
            for (const k of DETAILED_KEYS) {
                detailed[k] = Number(detailedInputs.get(k)?.value ?? 1.0) || 1.0;
            }
            /* Row visibility toggles. */
            if (scaleRow)    scaleRow.style.display    = (mode === "auto" || mode === "detailed") ? "none" : "";
            if (barsRow)     barsRow.style.display     = (mode === "detailed") ? "none" : "";
            if (detailedBlock) detailedBlock.style.display = (mode === "detailed") ? "" : "none";
            /* Live value readouts. */
            if (scaleVal) scaleVal.textContent = Number(scale).toFixed(2);
            if (barsVal)  barsVal.textContent  = Number(bars).toFixed(2);
            for (const k of DETAILED_KEYS) {
                const disp = detailedDisplays.get(k);
                if (disp) disp.textContent = Number(detailed[k]).toFixed(2);
            }
            /* Push the draft to the CSS vars for live preview. */
            applyUIScaleValues({ mode, scale, bars, detailed });
        };

        for (const el of [modeSel, scaleEl, barsEl, ...detailedInputs.values()]) {
            el?.addEventListener("input",  refresh);
            el?.addEventListener("change", refresh);
        }
        try { refresh(); }
        catch (err) { console.warn("witcher-ttrpg-death-march | UIScaleConfig initial refresh failed", err); }
    }

    /* Restore persisted values if the user closes via the X without Apply. */
    async _preClose(options) {
        await super._preClose?.(options);
        if (this.#snapshot && !this.#applied) {
            applyUIScale();
        }
    }

    #applied = false;

    static async #onApply(_event, _target) {
        const root = this.element;
        const mode  = root.querySelector('[name="scaleMode"]').value;
        const scale = Number(root.querySelector('[name="scale"]')?.value);
        const bars  = Number(root.querySelector('[name="chromeBarsScale"]')?.value);
        const detailed = {};
        for (const k of DETAILED_KEYS) {
            const el = root.querySelector(`[name="detailed.${k}"]`);
            detailed[k] = Number(el?.value ?? 1.0) || 1.0;
        }
        await game.settings.set(SYS, "ui.scaleMode",       mode);
        await game.settings.set(SYS, "ui.scale",           scale);
        await game.settings.set(SYS, "ui.chromeBarsScale", bars);
        await game.settings.set(SYS, "ui.detailedScales",  detailed);
        applyUIScale();
        this.#applied = true;
        this.close();
    }

    static async #onCancel(_event, _target) {
        /* _preClose will re-apply persisted values since #applied is still false. */
        this.close();
    }

    /* Reset all sliders (UI Scale, Chrome Bars, and every Detailed slider)
     * to 1.00×. Mode selection is NOT touched — user can be in Detailed
     * mode with everything at 1.0 as a clean starting point. Live-preview
     * fires immediately; nothing persists until Apply. */
    static async #onReset(_event, _target) {
        const root = this.element;
        const set = (sel, v) => {
            const el = root.querySelector(sel);
            if (el) el.value = String(v);
        };
        set('[name="scale"]', 1.0);
        set('[name="chromeBarsScale"]', 1.0);
        for (const k of DETAILED_KEYS) set(`[name="detailed.${k}"]`, 1.0);
        /* Fire input+change on the mode select to trigger the shared
         * `refresh` handler wired in `_onRender`. That recomputes every
         * live-preview display AND writes the reset values into the CSS
         * vars so the user SEES the reset before hitting Apply. */
        const modeSel = root.querySelector('[name="scaleMode"]');
        modeSel?.dispatchEvent(new Event("change", { bubbles: true }));
    }
}
