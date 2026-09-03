/**
 * UiCustomizerConfigApp — the "UI Customizer" dialog.
 *
 * Edits two themes (see mechanics/ui-customizer.mjs):
 *   • World  — GM-only base theme everyone inherits.
 *   • Personal — this client's per-user override, layered on top of world.
 *
 * A scope toggle at the top switches which theme you're editing; each scope
 * keeps its own in-memory working buffer so switching back and forth doesn't
 * lose unsaved edits. Every input change repaints a LIVE, non-persisted
 * preview; Save writes the current scope's buffer to its setting and the
 * onChange re-applies the persisted theme for real.
 *
 * Three tabs: Colours (curated swatches), Fonts (assign any Foundry-loaded
 * family to the display / body / mono roles), Custom CSS (raw override).
 */

import {
    UI_CUSTOMIZER_WORLD_KEY, UI_CUSTOMIZER_CLIENT_KEY, UI_CUSTOMIZER_DEFAULTS,
    UI_FONT_ROLES, UI_SECTIONS, UI_SECTION_DEFAULTS, IMG_FITS, PANEL_TARGETS,
    getWorldTheme, getClientTheme, computeEffectiveTheme,
    previewUiCustomizer, clearUiCustomizerPreview, availableFontChoices,
    isSafeColor, isSafeFontFamily, isSafeImageUrl
} from "../mechanics/ui-customizer.mjs";

import {
    RARITY_COLORS_KEY, RARITY_COLOR_TOKENS,
    getRarityColors, previewRarityColors, clearRarityPreview
} from "../mechanics/rarity-colors.mjs";

import { t } from "../chrome/lib/i18n.js";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class UiCustomizerConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {

    static DEFAULT_OPTIONS = {
        id: "wdm-ui-customizer",
        classes: ["witcher-ttrpg-death-march", "wdm-ui-customizer"],
        tag: "form",
        window: {
            title: "WITCHER.App.UiCustomizer.Title",
            icon: "fa-solid fa-palette",
            resizable: true
        },
        position: { width: 700, height: 740 },
        form: {
            handler: UiCustomizerConfigApp.#onSubmit,
            submitOnChange: false,
            closeOnSubmit: false
        },
        actions: {
            setScope:       UiCustomizerConfigApp.#onSetScope,
            resetScope:     UiCustomizerConfigApp.#onResetScope,
            pickImage:      UiCustomizerConfigApp.#onPickImage,
            clearImage:     UiCustomizerConfigApp.#onClearImage,
            setPanelTarget: UiCustomizerConfigApp.#onSetPanelTarget,
            exportTheme:    UiCustomizerConfigApp.#onExportTheme,
            importTheme:    UiCustomizerConfigApp.#onImportTheme
        }
    };

    /* Each section tab is its own PART but shares one template; the per-part
     * context (built in _preparePartContext) supplies the section-specific data. */
    static SECTION_PART = `systems/${SYSTEM_ID}/templates/applications/ui-customizer-section.hbs`;

    static PARTS = {
        head:      { template: `systems/${SYSTEM_ID}/templates/applications/ui-customizer-head.hbs` },
        tabs:      { template: "templates/generic/tab-navigation.hbs" },
        leftbar:   { template: UiCustomizerConfigApp.SECTION_PART, scrollable: [""] },
        rightbar:  { template: UiCustomizerConfigApp.SECTION_PART, scrollable: [""] },
        topbar:    { template: UiCustomizerConfigApp.SECTION_PART, scrollable: [""] },
        bottombar: { template: UiCustomizerConfigApp.SECTION_PART, scrollable: [""] },
        panels:    { template: UiCustomizerConfigApp.SECTION_PART, scrollable: [""] },
        foundry:   { template: UiCustomizerConfigApp.SECTION_PART, scrollable: [""] },
        fonts:     { template: `systems/${SYSTEM_ID}/templates/applications/ui-customizer-fonts.hbs`,     scrollable: [""] },
        inventory: { template: `systems/${SYSTEM_ID}/templates/applications/ui-customizer-inventory.hbs`, scrollable: [""] },
        css:       { template: `systems/${SYSTEM_ID}/templates/applications/ui-customizer-css.hbs`,       scrollable: [""] },
        footer:    { template: "templates/generic/form-footer.hbs" }
    };

    static TABS = {
        primary: {
            tabs: [
                { id: "leftbar",   icon: "fa-solid fa-table-columns" },
                { id: "rightbar",  icon: "fa-solid fa-table-columns fa-flip-horizontal" },
                { id: "topbar",    icon: "fa-solid fa-window-maximize" },
                { id: "bottombar", icon: "fa-solid fa-window-minimize" },
                { id: "panels",    icon: "fa-solid fa-layer-group" },
                { id: "foundry",   icon: "fa-solid fa-dice-d20"  },
                { id: "fonts",     icon: "fa-solid fa-font"    },
                { id: "inventory", icon: "fa-solid fa-gem"     },
                { id: "css",       icon: "fa-solid fa-code"    }
            ],
            initial: "leftbar",
            labelPrefix: "WITCHER.App.UiCustomizer.Tab"
        }
    };

    /* Which theme is being edited: "world" | "client". */
    #scope = game.user?.isGM ? "world" : "client";

    /* Per-scope working buffers, seeded lazily from stored settings so
     * switching scope preserves unsaved edits in both. */
    #working = { world: null, client: null };

    /* Global rarity palette working buffer (single-scope, GM-owned; edited in
     * the Inventory & Items tab, independent of the world/client theme scope). */
    #rarityWorking = null;

    /* Which middle-panel target the Panels tab is editing: "panels" (global) or
     * a per-panel section id (panelInventory, panelJournal, …). */
    #panelTarget = "panels";

    constructor(options = {}) {
        super(options);
        this.#working.world  = getWorldTheme();
        this.#working.client = getClientTheme();
        this.#rarityWorking  = getRarityColors();
        if (!game.user?.isGM) this.#scope = "client";
    }

    /* ─────────── helpers ─────────── */

    #cloneDefaults() { return foundry.utils.deepClone(UI_CUSTOMIZER_DEFAULTS); }

    /** Read the live form into the active scope's working buffer. */
    #captureForm() {
        const el = this.element;
        if (!el) return this.#working[this.#scope];
        const fd  = new foundry.applications.ux.FormDataExtended(el);
        const raw = foundry.utils.expandObject(fd.object ?? {});
        // Preserve any stored global colour overrides (the old flat-token
        // Colours tab is retired, but previously-saved values keep working).
        const prevColors = this.#working[this.#scope]?.colors ?? {};
        const theme = {
            // Master gate removed — a theme applies whenever it has overrides.
            // Kept as `true` in the stored shape for backward compatibility.
            enabled: true,
            colors:  { ...prevColors },
            fonts:   {},
            sections: {},
            css:     typeof raw.css === "string" ? raw.css : ""
        };
        const font = raw.font ?? {};
        for (const { role } of UI_FONT_ROLES) {
            const fam = font[role];
            if (fam && isSafeFontFamily(fam)) theme.fonts[role] = String(fam).trim();
        }
        theme.sections = this.#captureSections(raw.sec ?? {});
        this.#working[this.#scope] = theme;
        return theme;
    }

    /** Build the validated per-section map from the expanded `sec.*` form data.
     *  A section is only stored if it carries at least one active override, so
     *  untouched sections emit nothing and the shipped look stands.
     *
     *  Merge-preserving: sections NOT present in this form pass (e.g. per-panel
     *  targets not currently selected in the Panels tab) keep their stored value,
     *  so switching panel target doesn't wipe the others. */
    #captureSections(raw) {
        const out = { ...(this.#working[this.#scope]?.sections ?? {}) };
        const clampPct = n => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
        for (const meta of UI_SECTIONS) {
            const r = raw[meta.id];
            if (!r || typeof r !== "object") continue;   // not rendered → keep stored
            const s = {};
            const col = (onKey, valKey, dst) => {
                if (r[onKey]) { s[dst + "On"] = true; if (isSafeColor(r[valKey])) s[dst] = String(r[valKey]).trim(); }
            };
            col("textOn",     "text",     "text");
            col("textHiOn",   "textHi",   "textHi");
            col("accentOn",   "accent",   "accent");
            col("accentHiOn", "accentHi", "accentHi");
            col("dividerOn",  "divider",  "divider");
            col("ornamentOn", "ornament", "ornament");

            const mode = (r.bgMode === "solid" || r.bgMode === "gradient") ? r.bgMode : "none";
            if (mode !== "none") s.bgMode = mode;
            if (isSafeColor(r.bgSolid)) s.bgSolid = String(r.bgSolid).trim();
            if (isSafeColor(r.gradA)) s.gradA = String(r.gradA).trim();
            if (isSafeColor(r.gradB)) s.gradB = String(r.gradB).trim();
            if (isSafeColor(r.gradC)) s.gradC = String(r.gradC).trim();
            if (r.gradAngle != null) s.gradAngle = Math.max(0, Math.min(360, Math.round(Number(r.gradAngle) || 0)));
            if (r.gradOpacity != null) s.gradOpacity = clampPct(r.gradOpacity);
            if (r.opacity != null) s.opacity = clampPct(r.opacity);

            const url = typeof r.imgUrl === "string" ? r.imgUrl.trim() : "";
            if (url && isSafeImageUrl(url)) s.imgUrl = url;
            if (r.imgOpacity != null) s.imgOpacity = clampPct(r.imgOpacity);
            if (IMG_FITS.includes(r.imgFit)) s.imgFit = r.imgFit;

            const active = s.textOn || s.textHiOn || s.accentOn || s.accentHiOn
                || s.dividerOn || s.ornamentOn
                || (s.bgMode && s.bgMode !== "none") || !!s.imgUrl;
            if (active) out[meta.id] = s;
            else delete out[meta.id];   // cleared → drop (was preserved by the spread)
        }
        return out;
    }

    /** Repaint the live preview from the current form + the other scope's
     *  stored theme. */
    #paintPreview() {
        const cur    = this.#captureForm();
        const world  = this.#scope === "world"  ? cur : getWorldTheme();
        const client = this.#scope === "client" ? cur : getClientTheme();
        previewUiCustomizer(computeEffectiveTheme({ world, client }));
    }

    /** Read the Inventory & Items tab into the rarity working buffer. Only the
     *  ticked tiers with a valid hex become overrides; everything else inherits
     *  the shipped colour. GM-only — players see a read-only view. */
    #captureRarityForm() {
        const el = this.element;
        if (!el) return this.#rarityWorking ?? {};
        const fd  = new foundry.applications.ux.FormDataExtended(el);
        const raw = foundry.utils.expandObject(fd.object ?? {});
        const on  = raw.rarityOn  ?? {};
        const val = raw.rarityVal ?? {};
        const palette = {};
        for (const { tier } of RARITY_COLOR_TOKENS) {
            if (on[tier] && isSafeColor(val[tier])) palette[tier] = String(val[tier]).trim();
        }
        this.#rarityWorking = palette;
        return palette;
    }

    /** Live preview of the global rarity palette (GM only). */
    #paintRarityPreview() {
        previewRarityColors(this.#captureRarityForm());
    }

    /** Build the template context for one section tab from its stored (working)
     *  overrides, falling back to the section/shipped defaults for display. */
    #sectionContext(meta, cur) {
        const d = UI_SECTION_DEFAULTS;
        const mode = (cur.bgMode === "solid" || cur.bgMode === "gradient") ? cur.bgMode : "none";
        return {
            id:        meta.id,
            isFull:    meta.bg === "full",
            isFoundry: !!meta.foundry,
            label: t(`WITCHER.App.UiCustomizer.Section.${meta.key}`, meta.id),
            desc:  t(`WITCHER.App.UiCustomizer.SectionDesc.${meta.key}`, ""),

            textOn:     !!cur.textOn,     text:     cur.text     ?? d.text,
            textHiOn:   !!cur.textHiOn,   textHi:   cur.textHi   ?? d.textHi,
            accentOn:   !!cur.accentOn,   accent:   cur.accent   ?? d.accent,
            accentHiOn: !!cur.accentHiOn, accentHi: cur.accentHi ?? d.accentHi,
            dividerOn:  !!cur.dividerOn,  divider:  cur.divider  ?? d.divider,
            ornamentOn: !!cur.ornamentOn, ornament: cur.ornament ?? d.ornament,

            bgMode: mode,
            bgModeNone:     mode === "none",
            bgModeSolid:    mode === "solid",
            bgModeGradient: mode === "gradient",
            bgSolid: cur.bgSolid ?? meta.defBg ?? d.bgSolid,
            gradA: cur.gradA ?? d.gradA, gradB: cur.gradB ?? d.gradB, gradC: cur.gradC ?? d.gradC,
            gradAngle: cur.gradAngle ?? d.gradAngle,
            gradOpacity: cur.gradOpacity ?? d.gradOpacity,
            opacity: cur.opacity ?? d.opacity,

            imgUrl: cur.imgUrl ?? "",
            hasImg: !!cur.imgUrl,
            imgOpacity: cur.imgOpacity ?? d.imgOpacity,
            fitOptions: IMG_FITS.map(f => ({
                v: f, selected: (cur.imgFit ?? d.imgFit) === f,
                label: t(`WITCHER.App.UiCustomizer.Fit.${f}`, f)
            }))
        };
    }

    /* ─────────── context ─────────── */

    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        ctx.isGM  = !!game.user?.isGM;
        ctx.scope = this.#scope;
        ctx.buttons = [
            { type: "button", action: "importTheme", icon: "fa-solid fa-file-import",
              label: t("WITCHER.App.UiCustomizer.Import", "Import") },
            { type: "button", action: "exportTheme", icon: "fa-solid fa-file-export",
              label: t("WITCHER.App.UiCustomizer.Export", "Export") },
            { type: "button", action: "resetScope", icon: "fa-solid fa-arrow-rotate-left",
              label: t("WITCHER.App.UiCustomizer.Reset", "Reset this scope") },
            // Apply persists the current scope but keeps the window open (the
            // form's closeOnSubmit is false), so it doubles as Save-without-close.
            { type: "submit", icon: "fa-solid fa-check",
              label: t("WITCHER.App.UiCustomizer.Apply", "Apply") }
        ];
        return ctx;
    }

    async _preparePartContext(partId, context) {
        const ctx = await super._preparePartContext(partId, context);
        if (ctx.tabs && partId in ctx.tabs) ctx.tab = ctx.tabs[partId];
        const work = this.#working[this.#scope] ?? this.#cloneDefaults();

        if (partId === "head") {
            ctx.isGM  = !!game.user?.isGM;
            ctx.scope = this.#scope;
            ctx.scopeIsWorld  = this.#scope === "world";
            ctx.scopeIsClient = this.#scope === "client";
            ctx.enabled = !!work.enabled;
            ctx.scopeLabel = this.#scope === "world"
                ? t("WITCHER.App.UiCustomizer.Scope.World", "World default (everyone)")
                : t("WITCHER.App.UiCustomizer.Scope.Personal", "Personal (just me)");
        }

        if (partId === "panels") {
            // The Panels tab edits one target at a time: the global "panels" or a
            // per-panel override. Build the section context for the active target
            // and add the target selector.
            const targetMeta = UI_SECTIONS.find(m => m.id === this.#panelTarget)
                ?? UI_SECTIONS.find(m => m.id === "panels");
            ctx.section = this.#sectionContext(targetMeta, work.sections?.[targetMeta.id] ?? {});
            ctx.section.isPanelHost = true;
            ctx.section.panelTargets = PANEL_TARGETS.map(id => ({
                id,
                selected:   id === this.#panelTarget,
                overridden: id !== "panels" && !!work.sections?.[id],
                label: t(`WITCHER.App.UiCustomizer.PanelTarget.${id}`, id)
            }));
        } else {
            const sectionMeta = UI_SECTIONS.find(m => m.id === partId);
            if (sectionMeta) {
                ctx.section = this.#sectionContext(sectionMeta, work.sections?.[partId] ?? {});
            }
        }

        if (partId === "fonts") {
            const choices = availableFontChoices();
            ctx.fontChoices = choices;
            ctx.hasFonts = choices.length > 0;
            ctx.fonts = UI_FONT_ROLES.map(r => ({
                role: r.role,
                label: t(`WITCHER.App.UiCustomizer.Font.${r.key}`, r.label ?? r.role),
                desc:  t(`WITCHER.App.UiCustomizer.FontDesc.${r.key}`, r.desc ?? ""),
                current: work.fonts?.[r.role] ?? "",
                options: choices.map(fam => ({ fam, selected: work.fonts?.[r.role] === fam }))
            }));
        }

        if (partId === "css") {
            ctx.css = work.css ?? "";
        }

        if (partId === "inventory") {
            ctx.isGM = !!game.user?.isGM;
            const cur = this.#rarityWorking ?? getRarityColors();
            ctx.rarities = RARITY_COLOR_TOKENS.map(rc => {
                const override = isSafeColor(cur[rc.tier]) ? cur[rc.tier] : null;
                return {
                    tier:  rc.tier,
                    token: rc.token,
                    label: t(`WITCHER.App.UiCustomizer.Rarity.${rc.key}`, rc.tier),
                    on:    override !== null,
                    value: override ?? rc.def,
                    def:   rc.def
                };
            });
        }
        return ctx;
    }

    /* ─────────── live preview wiring ─────────── */

    async _onRender(context, options) {
        await super._onRender(context, options);
        const el = this.element;
        if (!el) return;
        /* ApplicationV2 reuses the root form element across re-renders (scope
         * switch / reset), so bind the delegated listeners once to avoid them
         * stacking up and firing N times. */
        if (!el.dataset.uicBound) {
            el.dataset.uicBound = "1";
            const repaint = () => {
                try {
                    this.#syncSectionUI();
                    this.#paintPreview();
                    this.#syncFontPreviews();
                    // Rarity palette is global/GM-only; players can't preview it
                    // (an empty buffer would wipe the applied colours).
                    if (game.user?.isGM) this.#paintRarityPreview();
                } catch (_) {}
            };
            el.addEventListener("input",  repaint);
            el.addEventListener("change", repaint);
        }
        this.#syncFontPreviews();
        this.#syncSectionUI();
    }

    /** Keep the section tabs' live DOM in sync with their inputs (not persisted):
     *  the opacity/image range read-outs and the background-mode class that
     *  shows the solid vs gradient controls. */
    #syncSectionUI() {
        const el = this.element;
        if (!el) return;
        for (const r of el.querySelectorAll("input.wdm-uic-range")) {
            const out = el.querySelector(`.wdm-uic-range-val[data-for="${CSS.escape(r.name)}"]`);
            if (out) out.textContent = out.classList.contains("wdm-uic-range-deg") ? `${r.value}°` : `${r.value}%`;
        }
        for (const sel of el.querySelectorAll("select.wdm-uic-bgmode")) {
            const wrap = sel.closest(".wdm-uic-sec");
            if (wrap) wrap.dataset.bgmode = sel.value;
        }
        for (const inp of el.querySelectorAll("input.wdm-uic-imgurl")) {
            const wrap = inp.closest(".wdm-uic-sec");
            if (wrap) wrap.dataset.hasimg = inp.value.trim() ? "1" : "";
        }
    }

    /** Update the per-role sample text to render in the currently selected
     *  family (purely cosmetic, live). */
    #syncFontPreviews() {
        const el = this.element;
        if (!el) return;
        for (const r of UI_FONT_ROLES) {
            const sel = el.querySelector(`select[name="font.${r.role}"]`);
            const sample = el.querySelector(`.wdm-uic-font-sample[data-role="${r.role}"]`);
            if (!sel || !sample) continue;
            sample.style.fontFamily = sel.value ? `'${sel.value}', ${r.generic ?? "inherit"}` : "";
        }
    }

    async close(options) {
        // A dialog closed without saving must not leave its preview behind.
        clearUiCustomizerPreview();
        clearRarityPreview();
        return super.close(options);
    }

    /* ─────────── actions ─────────── */

    static async #onSetScope(event, target) {
        const next = target?.dataset?.scopeTarget;
        if (next !== "world" && next !== "client") return;
        if (next === "world" && !game.user?.isGM) {
            ui.notifications?.warn(t("WITCHER.App.UiCustomizer.GmOnly",
                "Only the GM can edit the world-wide theme."));
            return;
        }
        if (next === this.#scope) return;
        this.#captureForm();          // stash current scope's edits
        this.#scope = next;
        await this.render();
        this.#paintPreview();
    }

    /** Open Foundry's FilePicker to choose a background image for a section;
     *  the chosen path is written into the section's hidden imgUrl input and a
     *  preview repaint is triggered. */
    static async #onPickImage(event, target) {
        const name  = target?.dataset?.target;
        const input = name ? this.element?.querySelector(`input[name="${CSS.escape(name)}"]`) : null;
        if (!input) return;
        const FP = foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
        try {
            const fp = new FP({
                type: "image",
                current: input.value || "",
                callback: (path) => {
                    input.value = path ?? "";
                    input.dispatchEvent(new Event("change", { bubbles: true }));
                }
            });
            fp.render(true);
        } catch (err) {
            console.warn(`${SYSTEM_ID} | ui-customizer file picker failed`, err);
        }
    }

    /** Switch which middle-panel target the Panels tab edits (global vs a single
     *  panel). Stash the current target's edits first so nothing is lost. */
    static async #onSetPanelTarget(event, target) {
        const next = target?.dataset?.panel;
        if (!next || next === this.#panelTarget) return;
        this.#captureForm();          // preserve the current target's edits
        this.#panelTarget = next;
        await this.render();
        this.#paintPreview();
    }

    /** Download the current scope's theme as a JSON file. */
    static async #onExportTheme() {
        this.#captureForm();
        const theme = this.#working[this.#scope] ?? this.#cloneDefaults();
        const payload = {
            _type: "wdm-ui-customizer-theme",
            _version: 1,
            scope: this.#scope,
            theme,
            // Bundle the GM rarity palette when a GM exports, so a full look
            // travels in one file. Import applies it only if the importer is GM.
            rarity: game.user?.isGM ? this.#captureRarityForm() : undefined
        };
        const name = `wdm-ui-theme-${this.#scope}.json`;
        try {
            const save = foundry.utils?.saveDataToFile ?? globalThis.saveDataToFile;
            save(JSON.stringify(payload, null, 2), "application/json", name);
        } catch (err) {
            console.warn(`${SYSTEM_ID} | ui-customizer export failed`, err);
            ui.notifications?.error(t("WITCHER.App.UiCustomizer.ExportFailed", "Could not export the theme."));
        }
    }

    /** Import a theme JSON file into the current scope (replaces this scope's
     *  working buffer, then re-renders; Apply/Save still needed to persist). */
    static async #onImportTheme() {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "application/json,.json";
        input.addEventListener("change", async () => {
            const file = input.files?.[0];
            if (!file) return;
            try {
                const text = await file.text();
                const data = JSON.parse(text);
                const raw  = (data && data._type === "wdm-ui-customizer-theme" && data.theme) ? data.theme : data;
                if (!raw || typeof raw !== "object") throw new Error("not a theme object");
                // Re-read through the setting sanitiser shape: keep only known keys.
                this.#working[this.#scope] = {
                    enabled: true,
                    colors:  (raw.colors && typeof raw.colors === "object") ? { ...raw.colors } : {},
                    fonts:   (raw.fonts  && typeof raw.fonts  === "object") ? { ...raw.fonts  } : {},
                    sections:(raw.sections && typeof raw.sections === "object") ? foundry.utils.deepClone(raw.sections) : {},
                    css:     typeof raw.css === "string" ? raw.css : ""
                };
                if (game.user?.isGM && data.rarity && typeof data.rarity === "object") {
                    this.#rarityWorking = { ...data.rarity };
                }
                await this.render();
                this.#paintPreview();
                if (game.user?.isGM) this.#paintRarityPreview();
                ui.notifications?.info(t("WITCHER.App.UiCustomizer.Imported",
                    "Theme imported — Apply to save it."));
            } catch (err) {
                console.warn(`${SYSTEM_ID} | ui-customizer import failed`, err);
                ui.notifications?.error(t("WITCHER.App.UiCustomizer.ImportFailed",
                    "That file isn't a valid UI Customizer theme."));
            }
        });
        input.click();
    }

    /** Clear a section's chosen background image. */
    static async #onClearImage(event, target) {
        const name  = target?.dataset?.target;
        const input = name ? this.element?.querySelector(`input[name="${CSS.escape(name)}"]`) : null;
        if (!input) return;
        input.value = "";
        input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    static async #onResetScope() {
        /* Instant reset: clear this scope's overrides, PERSIST immediately
         * (the setting's onChange re-applies the effective theme live) and
         * re-render — no separate Save step, no confirm modal. Guard the
         * world scope so a non-GM can't wipe the shared base. */
        if (this.#scope === "world" && !game.user?.isGM) {
            ui.notifications?.warn(t("WITCHER.App.UiCustomizer.GmOnly",
                "Only the GM can edit the world-wide theme."));
            return;
        }
        const defaults = this.#cloneDefaults();
        this.#working[this.#scope] = defaults;
        const key = this.#scope === "world" ? UI_CUSTOMIZER_WORLD_KEY : UI_CUSTOMIZER_CLIENT_KEY;
        try {
            await game.settings.set(SYSTEM_ID, key, defaults);   // onChange → applyUiCustomizer()
        } catch (err) {
            console.warn(`${SYSTEM_ID} | ui-customizer reset failed`, err);
        }
        clearUiCustomizerPreview();   // drop any stale preview overlay
        await this.render();
        ui.notifications?.info(t("WITCHER.App.UiCustomizer.ResetDone", "Theme reset to default."));
    }

    static async #onSubmit(event, form, formData) {
        this.#captureForm();
        const theme = this.#working[this.#scope];
        const key = this.#scope === "world" ? UI_CUSTOMIZER_WORLD_KEY : UI_CUSTOMIZER_CLIENT_KEY;
        if (this.#scope === "world" && !game.user?.isGM) {
            ui.notifications?.error(t("WITCHER.App.UiCustomizer.GmOnly",
                "Only the GM can edit the world-wide theme."));
            return;
        }
        await game.settings.set(SYSTEM_ID, key, theme);   // onChange → applyUiCustomizer()

        // Global rarity palette (Inventory & Items tab) — GM-owned, saved
        // alongside whichever theme scope is active. onChange → applyRarityColors().
        if (game.user?.isGM) {
            const palette = this.#captureRarityForm();
            await game.settings.set(SYSTEM_ID, RARITY_COLORS_KEY, palette);
        }

        ui.notifications?.info(t("WITCHER.App.UiCustomizer.Saved", "UI theme saved."));
    }
}
