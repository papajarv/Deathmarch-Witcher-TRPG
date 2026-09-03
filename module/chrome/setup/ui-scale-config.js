/**
 * UI Scaling configuration dialog.
 *
 * Opened from the "Configure UI Scaling" button in Configure Settings.
 *
 * Modes:
 *   - Auto     : --wdm-scale from viewport × UI Scale. Overall Scaling for bars.
 *   - Manual   : --wdm-scale from the UI Scale slider. Overall Scaling for bars.
 *   - Detailed : per-element size sliders (UI text, Top Bar, Dock, Sidebar,
 *                Scene Controls, Popups).
 *   - Per Section (persection): the DECOUPLED per-surface model — each surface
 *                gets Size (layout) + Text (font) sliders; Text is also scaled
 *                by UI Text Scaling, and Size never touches text. Native Foundry
 *                bars (left controls, right sidebar) are Size-only.
 *
 * All sliders preview live as you drag (write CSS vars on <html>); nothing is
 * persisted until Apply. Cancel / close re-applies the persisted values.
 */

import { applyUIScale } from "./ui-scale.js";

const SYS = "witcher-ttrpg-death-march";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/* Detailed-mode per-element keys (order = slider order). */
const DETAILED_KEYS = Object.freeze(["ui", "topbar", "dock", "sidebar", "scenecontrols", "popups"]);

/* Per-Section surfaces (order = display order). `native` → Size-only. Keys
 * match ui.sizeScales / ui.fontScales and the --wdm-size-<key>/--wdm-fs-<key>
 * CSS vars. */
const SURFACES = Object.freeze([
    { key: "topbar",        label: "Top Bar" },
    { key: "dock",          label: "Bottom Dock" },
    { key: "scenecontrols", label: "Left Controls", native: true },
    { key: "sidebar",       label: "Right Sidebar", native: true },
    { key: "character",     label: "Character" },
    { key: "inventory",     label: "Inventory" },
    { key: "bestiary",      label: "Bestiary" },
    { key: "journal",       label: "Journal" },
    { key: "crafting",      label: "Crafting" },
    { key: "map",           label: "Map" }
]);

function readDetailed() {
    const raw = game.settings.get(SYS, "ui.detailedScales") ?? {};
    const out = {};
    for (const k of DETAILED_KEYS) out[k] = Number(raw[k] ?? 1.0) || 1.0;
    return out;
}
function readScales(settingKey) {
    const raw = game.settings.get(SYS, settingKey) ?? {};
    const out = {};
    for (const s of SURFACES) out[s.key] = Number(raw[s.key] ?? 1.0) || 1.0;
    return out;
}

/* Per-mode scale/bars memory. `ui.modeValues[mode]` holds each mode's own
 * last-applied { scale, bars }. When a mode has no stored value yet, the
 * ACTIVE mode (the one the flat `ui.scale`/`ui.chromeBarsScale` currently
 * represent) inherits those flat values for a clean migration; every other
 * mode defaults to 1.0 so nothing bleeds across modes. */
function readModeValues() {
    return game.settings.get(SYS, "ui.modeValues") ?? {};
}
function modeScale(mode, modeValues, activeMode) {
    const mv = modeValues?.[mode];
    if (mv && mv.scale != null) return Number(mv.scale) || 1.0;
    if (mode === activeMode) return Number(game.settings.get(SYS, "ui.scale") ?? 1.0) || 1.0;
    return 1.0;
}
function modeBars(mode, modeValues, activeMode) {
    const mv = modeValues?.[mode];
    if (mv && mv.bars != null) return Number(mv.bars) || 1.0;
    if (mode === activeMode) return Number(game.settings.get(SYS, "ui.chromeBarsScale") ?? 1.0) || 1.0;
    return 1.0;
}

export class UIScaleConfig extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: "wou-ui-scale-config",
        tag: "form",
        classes: ["witcher-ttrpg-death-march", "wou-dialog", "wou-ui-scale-config"],
        window: {
            title: "WOU.Settings.UIScaleConfig.Title",
            icon: "fa-solid fa-up-right-and-down-left-from-center",
            resizable: true
        },
        position: { width: 560, height: "auto" },
        actions: {
            apply:  UIScaleConfig.#onApply,
            cancel: UIScaleConfig.#onCancel,
            reset:  UIScaleConfig.#onReset
        }
    };

    static PARTS = {
        body: { template: "systems/witcher-ttrpg-death-march/templates/ui-scale-config.hbs" }
    };

    #snapshot = null;
    #applied = false;
    #modeValues = null;

    async _prepareContext(_options) {
        const mode     = game.settings.get(SYS, "ui.scaleMode") ?? "manual";
        const modeValues = readModeValues();
        /* Scale/bars come from THIS mode's own memory, not the shared flat
         * values — so switching modes doesn't carry values across. */
        const scale    = modeScale(mode, modeValues, mode);
        const bars     = modeBars(mode, modeValues, mode);
        const detailed = readDetailed();
        const sizes    = readScales("ui.sizeScales");
        const fonts    = readScales("ui.fontScales");
        this.#snapshot ??= { mode, scale, bars, detailed, sizes, fonts };
        const surfaces = SURFACES.map(s => ({
            key: s.key, label: s.label, native: !!s.native,
            size: sizes[s.key].toFixed(2), font: fonts[s.key].toFixed(2)
        }));
        return {
            mode,
            scale: scale.toFixed(2),
            bars: bars.toFixed(2),
            detailed,
            surfaces
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
        const detailedBlock   = root.querySelector('[data-detailed-block]');
        const persectionBlock = root.querySelector('[data-persection-block]');
        const scaleVal = root.querySelector('[data-display="scale"]');
        const barsVal  = root.querySelector('[data-display="chromeBarsScale"]');

        const detailedInputs = new Map();
        const detailedDisplays = new Map();
        for (const k of DETAILED_KEYS) {
            detailedInputs.set(k, root.querySelector(`[name="detailed.${k}"]`));
            detailedDisplays.set(k, root.querySelector(`[data-display="detailed.${k}"]`));
        }

        /* Readout + visibility only — NO CSS writes. Nothing changes on screen
         * until Apply (so dragging doesn't "apply" live). */
        const refresh = () => {
            const mode = modeSel.value;
            if (scaleRow) scaleRow.style.display = (mode === "manual" || mode === "persection") ? "" : "none";
            if (barsRow)  barsRow.style.display  = (mode === "auto"   || mode === "manual")     ? "" : "none";
            if (detailedBlock)   detailedBlock.style.display   = (mode === "detailed")   ? "" : "none";
            if (persectionBlock) persectionBlock.style.display = (mode === "persection") ? "" : "none";

            if (scaleVal) scaleVal.textContent = (Number(scaleEl?.value) || 1).toFixed(2);
            if (barsVal)  barsVal.textContent  = (Number(barsEl?.value) || 1).toFixed(2);
            for (const k of DETAILED_KEYS) {
                const d = detailedDisplays.get(k);
                if (d) d.textContent = (Number(detailedInputs.get(k)?.value ?? 1) || 1).toFixed(2);
            }
            for (const s of SURFACES) {
                const ds = root.querySelector(`[data-display="size.${s.key}"]`);
                if (ds) ds.textContent = (Number(root.querySelector(`[name="size.${s.key}"]`)?.value ?? 1) || 1).toFixed(2);
                const df = root.querySelector(`[data-display="font.${s.key}"]`);
                if (df) df.textContent = (Number(root.querySelector(`[name="font.${s.key}"]`)?.value ?? 1) || 1).toFixed(2);
            }
        };
        const preview = refresh;

        /* When the user switches mode, load THAT mode's own remembered scale /
         * bars into the sliders so values never bleed across modes. The active
         * (saved) mode inherits the flat runtime value on first use; others
         * default to 1.0. */
        const activeMode = game.settings.get(SYS, "ui.scaleMode") ?? "manual";
        this.#modeValues ??= readModeValues();
        /* One-time migration: seed the active mode's memory from the current
         * flat values so they can't be lost if the user applies a different
         * mode first. Runs once per mode (skipped after it's stored). */
        if (this.#modeValues[activeMode] == null) {
            this.#modeValues = { ...this.#modeValues, [activeMode]: {
                scale: Number(game.settings.get(SYS, "ui.scale") ?? 1) || 1,
                bars:  Number(game.settings.get(SYS, "ui.chromeBarsScale") ?? 1) || 1
            }};
            game.settings.set(SYS, "ui.modeValues", this.#modeValues);
        }
        const onModeSwitch = () => {
            const nm = modeSel.value;
            if (scaleEl) scaleEl.value = String(modeScale(nm, this.#modeValues, activeMode));
            if (barsEl)  barsEl.value  = String(modeBars(nm, this.#modeValues, activeMode));
            refresh();
        };
        modeSel?.addEventListener("change", onModeSwitch);

        const inputs = [modeSel, scaleEl, barsEl, ...detailedInputs.values()];
        for (const s of SURFACES) {
            inputs.push(root.querySelector(`[name="size.${s.key}"]`));
            inputs.push(root.querySelector(`[name="font.${s.key}"]`));
        }
        for (const el of inputs) {
            el?.addEventListener("input",  preview);
            el?.addEventListener("change", preview);
        }
        try { preview(); }
        catch (err) { console.warn(`${SYS} | UIScaleConfig preview failed`, err); }
    }

    /* Restore persisted values if closed via X without Apply. */
    async _preClose(options) {
        await super._preClose?.(options);
        if (this.#snapshot && !this.#applied) applyUIScale();
    }

    static async #onApply(_event, _target) {
        const root = this.element;
        const mode  = root.querySelector('[name="scaleMode"]')?.value ?? "manual";
        const scale = Number(root.querySelector('[name="scale"]')?.value) || 1;
        const bars  = Number(root.querySelector('[name="chromeBarsScale"]')?.value) || 1;
        const detailed = {};
        for (const k of DETAILED_KEYS) {
            detailed[k] = Number(root.querySelector(`[name="detailed.${k}"]`)?.value ?? 1) || 1;
        }
        const sizes = {};
        const fonts = {};
        for (const s of SURFACES) {
            sizes[s.key] = Number(root.querySelector(`[name="size.${s.key}"]`)?.value ?? 1) || 1;
            const fontEl = root.querySelector(`[name="font.${s.key}"]`);
            fonts[s.key] = fontEl ? (Number(fontEl.value) || 1) : 1;
        }
        /* Remember this mode's own scale/bars so switching away and back
         * restores them (no cross-mode bleed). The flat ui.scale /
         * ui.chromeBarsScale below stay the ACTIVE runtime values. */
        const modeValues = { ...(game.settings.get(SYS, "ui.modeValues") ?? {}) };
        modeValues[mode] = { scale, bars };
        await game.settings.set(SYS, "ui.modeValues",      modeValues);
        await game.settings.set(SYS, "ui.scaleMode",       mode);
        await game.settings.set(SYS, "ui.scale",           scale);
        await game.settings.set(SYS, "ui.chromeBarsScale", bars);
        await game.settings.set(SYS, "ui.detailedScales",  detailed);
        await game.settings.set(SYS, "ui.sizeScales",      sizes);
        await game.settings.set(SYS, "ui.fontScales",      fonts);
        applyUIScale();
        this.#modeValues = modeValues;
        this.#snapshot = { mode, scale, bars, detailed, sizes, fonts };
        this.#applied = true;
    }

    static async #onCancel(_event, _target) {
        this.close();  // _preClose re-applies persisted values (#applied still false)
    }

    /* Reset every slider to 1.00× and live-preview. Mode untouched. */
    static async #onReset(_event, _target) {
        const root = this.element;
        const set = (sel, v) => { const el = root.querySelector(sel); if (el) el.value = String(v); };
        set('[name="scale"]', 1.0);
        set('[name="chromeBarsScale"]', 1.0);
        for (const k of DETAILED_KEYS) set(`[name="detailed.${k}"]`, 1.0);
        for (const s of SURFACES) {
            set(`[name="size.${s.key}"]`, 1.0);
            set(`[name="font.${s.key}"]`, 1.0);
        }
        /* Fire `input` (not `change`) so the readouts refresh WITHOUT triggering
         * the mode-switch handler, which would reload this mode's stored
         * scale/bars and undo the reset. */
        root.querySelector('[name="scaleMode"]')?.dispatchEvent(new Event("input", { bubbles: true }));
    }
}
