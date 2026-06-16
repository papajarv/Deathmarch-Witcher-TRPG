/**
 * WitcherItemSheet — base ApplicationV2 sheet for all item types.
 *
 * Phase 4a: generic sheet that handles most item types via one template.
 * Item types with substantially different forms (criticalWound, valuable
 * book subtype, container with content rail) override `PARTS` to point at
 * a type-specific template; Phase 4b will introduce per-type sheets where
 * needed.
 *
 * Hook name: `renderWitcherItemSheet`. For type-specific hooks (e.g.,
 * `renderWitcherWeaponSheet`, `renderWitcherValuableSheet`,
 * `renderWitcherContainerSheet` — required by the overhaul-ui contract),
 * use the type-specific subclasses defined in this directory.
 */

import { buildEnhancementSlots, wireEnhancementSlots, detachEnhancement } from "./enhancementSlots.mjs";
import { buildComponentLinks, wireComponentDrop, removeComponent } from "./hexComponents.mjs";
import { effectStatTargets, statusImmunityOptions } from "../../setup/config.mjs";
import { isHomebrewEnabled } from "../../api/homebrew.mjs";

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ItemSheetV2 } = foundry.applications.sheets;

export class WitcherItemSheet extends HandlebarsApplicationMixin(ItemSheetV2) {

    static DEFAULT_OPTIONS = {
        classes: ["witcher-ttrpg-death-march", "sheet", "item"],
        /* height: "auto" lets the window measure its content on render
         * so the display-mode tooltip (short) and the config form (tall)
         * both get a snug window. The toggle triggers a re-render which
         * recomputes the height. */
        position: { width: 540, height: "auto" },
        window: { resizable: true },
        form: { submitOnChange: true, closeOnSubmit: false },
        actions: {
            toggleItemMode: WitcherItemSheet._onToggleItemMode,
            editImage:      WitcherItemSheet._onEditImage,
            createEffect:   WitcherItemSheet._onCreateEffect,
            editEffect:     WitcherItemSheet._onEditEffect,
            deleteEffect:   WitcherItemSheet._onDeleteEffect,
            toggleEffect:   WitcherItemSheet._onToggleEffect
        }
    };

    static PARTS = {
        main: {
            template: "systems/witcher-ttrpg-death-march/templates/item/main.hbs",
            scrollable: [""]
        }
    };

    /* Whether a newly-created embedded effect transfers to (applies to) the
     * actor that owns this item. Default true (the effect acts on the holder).
     * Castables override to false: a hex/spell/ritual effect is a reference
     * template the combat flow applies to the TARGET, never to the caster.
     * NOTE: alchemical transfer (oils don't transfer; consumables stay dormant
     * until used) is owned separately by the consume-item policy hook — it is
     * NOT expressed here, so this getter stays true for alchemicals. */
    get effectsTransfer() { return true; }

    /* Two-layer sheet: `display` shows the Witcher-3-style tooltip
     * readout (what players see when they open an item); `config` is
     * the editable form (cog button toggle, owners only). State is
     * per-sheet-instance — closing and reopening defaults to display. */
    #mode = "display";

    /* Window title: just the item's name. Foundry's default for
     * DocumentSheetV2 prepends "TYPES.Item.<type>:" which renders as
     * raw i18n key text when the key isn't registered. The tooltip
     * already shows the type as a subtitle, so the chrome title doesn't
     * need to duplicate it. */
    get title() {
        return this.document?.name ?? super.title;
    }

    /** Inherits `document`, `editable`, `fields`, `source` from
     *  DocumentSheetV2; we override `source` to the system-level source
     *  so templates can bind editable inputs to `source.X` (the value
     *  the player typed) instead of round-tripping through post-AE
     *  prepared values. Same pattern as the actor base sheet. */
    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        ctx.item     = this.item;
        ctx.system   = this.item.system;
        ctx.source   = this.item.toObject().system;
        ctx.WITCHER  = CONFIG.WITCHER;
        ctx.homebrew = (key) => game.system.api.homebrew.isEnabled(key);
        // Display/config mode. Non-owners are pinned to display (no cog
        // shown). Owners default to display and can toggle to config.
        ctx.mode = this.#mode;
        ctx.canEdit = this.isEditable;
        // Item-embedded ActiveEffects — surfaced so per-type templates
        // (e.g. alchemical) can list and manage real Foundry effects in
        // place of a free-form effect text field.
        ctx.effects = this.item.effects.map(e => ({
            id:          e.id,
            name:        e.name,
            img:         e.img,
            disabled:    e.disabled,
            description: e.description ?? "",
            duration:    { label: e.duration?.label ?? "" }
        }));
        return ctx;
    }

    /* ── ActiveEffect handlers (item-embedded) ─────────────────────── */
    static async _onCreateEffect(event, target) {
        if (!this.isEditable) return;
        // New effects inherit the parent item's name + icon + description so
        // they read as "this item's effect" out of the box rather than a
        // generic "New Effect"; the user can rename/re-icon/re-describe in the
        // effect sheet. Description is seeded once at creation only.
        const [effect] = await this.item.createEmbeddedDocuments("ActiveEffect", [{
            name: this.item.name,
            img:  this.item.img,
            description: this.item.system?.description ?? "",
            disabled: false,
            transfer: this.effectsTransfer
        }]);
        effect?.sheet?.render(true);
    }
    static async _onEditEffect(event, target) {
        const id = target.closest("[data-effect-id]")?.dataset.effectId;
        this.item.effects.get(id)?.sheet?.render(true);
    }
    static async _onDeleteEffect(event, target) {
        if (!this.isEditable) return;
        const id = target.closest("[data-effect-id]")?.dataset.effectId;
        const effect = this.item.effects.get(id);
        if (!effect) return;
        const ok = await foundry.applications.api.DialogV2.confirm({
            window: { title: "Delete Effect" },
            content: `<p>Remove <strong>${effect.name}</strong>?</p>`
        });
        if (ok) await effect.delete();
    }
    static async _onToggleEffect(event, target) {
        if (!this.isEditable) return;
        const id = target.closest("[data-effect-id]")?.dataset.effectId;
        const effect = this.item.effects.get(id);
        await effect?.update({ disabled: !effect.disabled });
    }

    static async _onToggleItemMode(event, target) {
        if (!this.isEditable) return;
        // Flush any in-flight form change before flipping modes — when
        // the user clicks the cog while a param input still has focus,
        // the input's blur/change fires concurrently with the click,
        // and submitOnChange's async document.update can race the
        // render. Blur the active element to commit, then await submit
        // so the new render reads the freshly-saved values.
        if (document.activeElement?.tagName &&
            ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) {
            document.activeElement.blur();
        }
        try {
            await this.submit({ preventClose: true, preventRender: true });
        } catch (_) { /* validation failure — already surfaced to user */ }
        this.#mode = this.#mode === "config" ? "display" : "config";
        this.render({ force: false });
    }

    /** Open Foundry's FilePicker on the portrait/img click. Triggered
     *  by `data-action="editImage"` on the img element in the config
     *  view (paired with `data-edit="<field>"`; defaults to "img"). */
    static async _onEditImage(event, target) {
        if (!this.isEditable) return;
        const field   = target.dataset.edit || "img";
        const current = foundry.utils.getProperty(this.item, field);
        const FP      = foundry.applications.apps.FilePicker.implementation;
        const fp      = new FP({
            type: "image",
            current,
            callback: path => this.item.update({ [field]: path }),
            top:  (this.position?.top  ?? 0) + 40,
            left: (this.position?.left ?? 0) + 10
        });
        fp.render(true);
    }

    /** Multi-checkbox fields submit as the array of CHECKED values via
     *  FormDataExtended.getAll(). But when the user unchecks all boxes,
     *  the name disappears from the form payload entirely — so the
     *  document's existing array is never overwritten. Walk the rendered
     *  form, find every `[name][type=checkbox]` whose name is shared by
     *  multiple inputs, and explicitly set the value (array of checked
     *  values, or empty array) on the submit data.
     *
     *  Also re-assemble `system.qualityValues` as a complete object
     *  from every `system.qualityValues.*` input. ObjectField under
     *  Foundry's path-expansion can silently drop sibling keys when
     *  one input fires submitOnChange in isolation — we route around
     *  by always writing the whole map.
     */
    _prepareSubmitData(event, form, formData) {
        const data = super._prepareSubmitData(event, form, formData);
        if (!form) return data;
        const boxes = form.querySelectorAll('input[type="checkbox"][name]');
        const byName = {};
        boxes.forEach(b => {
            // Detect "multi" by finding ≥ 2 checkboxes sharing a name.
            if (!byName[b.name]) byName[b.name] = [];
            byName[b.name].push(b);
        });
        for (const [name, group] of Object.entries(byName)) {
            if (group.length < 2) continue;  // single checkbox = boolean
            const checked = group.filter(b => b.checked).map(b => b.value);
            foundry.utils.setProperty(data, name, checked);
        }
        // Quality parameter values — always written as a complete object
        // replacement to avoid partial-write issues with ObjectField.
        const QV_PREFIX = "system.qualityValues.";
        const paramInputs = form.querySelectorAll(`input[name^="${QV_PREFIX}"]`);
        if (paramInputs.length) {
            const params = {};
            paramInputs.forEach(input => {
                const key = input.name.slice(QV_PREFIX.length);
                const v = (input.value ?? "").toString().trim();
                if (v.length) params[key] = v;
            });
            foundry.utils.setProperty(data, "system.qualityValues", params);
        }
        return data;
    }
}

/**
 * Named subclasses so the overhaul-ui contract's per-type render hooks
 * fire (`renderWitcherWeaponSheet`, `renderWitcherContainerSheet`,
 * `renderWitcherValuableSheet`). Per-type PARTS override the generic
 * main.hbs with a template that surfaces type-specific RAW fields.
 */
const partsFor = (templateName) => ({
    main: {
        template: `systems/witcher-ttrpg-death-march/templates/item/${templateName}.hbs`,
        scrollable: [""]
    }
});

/* key → friendly label for every stat/skill an effect can target. Built
 * once per call from the shared catalog (localized), keyed by data path. */
const effectTargetLabelMap = () =>
    new Map(effectStatTargets().map(o => [o.key, o.label]));

/* Render a compiled AE change ({key, type, value}) as a short display
 * string: additive bonuses are signed, the rest carry an operator glyph. */
function formatChangeValue(ch) {
    const v = ch.value;
    switch (ch.type) {
        case "override":  return `=${v}`;
        case "multiply":  return `×${v}`;
        case "upgrade":   return `≥${v}`;
        case "downgrade": return `≤${v}`;
        case "add":
        default:          return Number(v) >= 0 ? `+${v}` : `${v}`;
    }
}

/* Friendly summary of an item's enabled ActiveEffect modifiers, for the W3
 * display view: one {label, value} row per compiled change. Used by item
 * types whose payload is a transferred/installed stat bonus (homeland,
 * mutagen). */
export function summarizeEffectModifiers(item) {
    const labels = effectTargetLabelMap();
    const rows = [];
    for (const eff of (item?.effects ?? [])) {
        if (eff.disabled) continue;
        for (const ch of (eff.system?.changes ?? [])) {
            rows.push({ label: labels.get(ch.key) ?? ch.key, value: formatChangeValue(ch) });
        }
    }
    return rows;
}

export class WitcherWeaponSheet extends WitcherItemSheet {
    static PARTS = partsFor("weapon");

    static DEFAULT_OPTIONS = {
        actions: {
            detachEnhancement: WitcherWeaponSheet._onDetachEnhancement,
            reload:            WitcherWeaponSheet._onReload
        }
    };

    static async _onDetachEnhancement(event, target) {
        if (!this.isEditable) return;
        const idx = Number(target.closest("[data-enh-index]")?.dataset.enhIndex);
        if (await detachEnhancement(this.item, idx)) this.render({ force: false });
    }

    /* Chamber a slow-reload weapon from the selected eligible ammo. The
     * mixin's reload() decrements the ammo stack and fills system.loaded;
     * the document update re-renders this sheet automatically. */
    static async _onReload(event, target) {
        await this.item.reload();
    }

    /* Build the display-view quality list and config-view catalog. The
     * runtime catalog comes from getActiveWeaponQualities() — that's
     * the GM-edited override if present, otherwise the seed defaults.
     * Both the display tag chips and the config-view checkbox grid
     * iterate this catalog so any custom additions show up everywhere
     * the moment the GM saves the settings menu. */
    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        // Lazy-import: keeps the WeaponSheet decoupled from the
        // settings-menu module that itself imports config.mjs.
        const cfg = await import("../../setup/config.mjs");
        const catalog  = cfg.getActiveWeaponQualities() ?? {};
        const defaults = cfg.WEAPON_QUALITIES;
        // Cross-source the values: prepared (post-defaults) usually wins;
        // toObject() source is the belt-and-suspenders when the prepared
        // path has been stripped or hasn't been initialized yet.
        const values  = this.item.system?.qualityValues
                     ?? this.item.toObject?.().system?.qualityValues
                     ?? {};
        ctx.weaponQualitiesCatalog = catalog;
        ctx.weaponQualityList = (this.item.system?.qualities ?? [])
            .map(key => {
                // Resolve entry from catalog; fall back to canonical
                // defaults for both the entry and its `param` shape so a
                // saved override that predates parameterization can't
                // suppress the value fold.
                const entry = catalog[key] ?? defaults[key];
                if (!entry) return null;
                const param = entry.param ?? defaults[key]?.param ?? null;
                let label = entry.label;
                if (param) {
                    const raw = values[key];
                    const v   = raw == null ? "" : String(raw).trim();
                    if (v.length) {
                        label = `${entry.label}(${v}${param.suffix ?? ""})`;
                    }
                }
                return { key, label, description: entry.description };
            })
            .filter(Boolean);

        // Socketed enhancements + effective (enhanced) stats.
        const slotCount = Number(this.item.system?.weaponEnhancement) || 0;
        ctx.enhancementSlots = buildEnhancementSlots(this.item, slotCount);
        ctx.effective = this.item.system?.effective ?? null;
        ctx.isEnhanced = !!ctx.effective?.modified;
        // Qualities the enhancements add on top of the weapon's own — shown
        // as a separate chip row so base vs. socketed reads clearly.
        const baseQ = new Set(this.item.system?.qualities ?? []);
        const effVals = ctx.effective?.qualityValues ?? values;
        ctx.socketedQualityList = (ctx.effective?.qualities ?? [])
            .filter(k => !baseQ.has(k))
            .map(key => {
                const entry = catalog[key] ?? defaults[key];
                if (!entry) return null;
                const param = entry.param ?? defaults[key]?.param ?? null;
                let label = entry.label;
                if (param) {
                    const raw = effVals[key];
                    const v = raw == null ? "" : String(raw).trim();
                    if (v.length) label = `${entry.label}(${v}${param.suffix ?? ""})`;
                }
                return { key, label, description: entry.description };
            })
            .filter(Boolean);
        // Effective damage types not declared on the base weapon.
        ctx.addedDamageTypes = (ctx.effective?.damageTypes ?? [])
            .filter(t => !(this.item.system?.damageTypes ?? []).includes(t));

        // Operational reload state — only an owned ammo-firing weapon shows
        // the display-view readiness panel + equipped-container ammo picker.
        // (getEligibleAmmo walks this.actor's equipped containers; an
        // unowned world/compendium weapon returns [] and the panel hides.)
        if (this.item.usesAmmo && this.item.actor) {
            const eligible = this.item.getEligibleAmmo();
            const selected = this.item.getSelectedAmmo();
            const loadedCount    = Number(this.item.system?.loaded?.count) || 0;
            const loadedCapacity = Math.max(1, Number(this.item.system?.loaded?.capacity) || 1);
            ctx.reload = {
                owned:          true,
                hasChamber:     this.item.hasChamber,
                reloadActions:  this.item.reloadActions,
                multiAction:    this.item.reloadActions > 1,
                isLoaded:       this.item.isLoaded,
                loadedCount,
                loadedCapacity,
                canReload:      loadedCount < loadedCapacity,
                loadedName:     loadedCount > 0 ? (this.item.system?.loaded?.name ?? "") : "",
                ammoTypeLabel:  game.i18n.localize(cfg.AMMO_TYPES?.[this.item.ammoType] ?? ""),
                hasAmmo:        eligible.length > 0,
                eligible:       eligible.map(e => ({
                    id:        e.item.id,
                    name:      e.item.name,
                    qty:       e.qty,
                    container: e.container.name,
                    selected:  selected ? e.item.id === selected.id : false
                }))
            };
        }
        return ctx;
    }

    async _onRender(context, options) {
        await super._onRender(context, options);
        wireEnhancementSlots(this, "weapon");
        // ApplicationV2 data-action wiring is click-only; the ammo picker is
        // a <select>, so wire its change manually. selectAmmo() updates the
        // weapon doc, which re-renders this sheet.
        const sel = this.element.querySelector("[data-ammo-select]");
        if (sel) sel.addEventListener("change", ev => this.item.selectAmmo(ev.target.value));
    }

    /* When "Requires Ammo" is checked the weapon's own damage types are
     * dictated by the loaded ammunition, so drop them — otherwise a stale
     * array lingers (the picker is no longer rendered to clear it from). */
    _prepareSubmitData(event, form, formData) {
        const data = super._prepareSubmitData(event, form, formData);
        if (!form) return data;
        const requiresAmmo = !!form.querySelector('input[name="system.requiresAmmo"]')?.checked;
        if (requiresAmmo) foundry.utils.setProperty(data, "system.damageTypes", []);
        return data;
    }
}
export class WitcherAmmoSheet extends WitcherItemSheet {
    static PARTS = partsFor("ammo");

    /* Ammo shares the weapon quality catalog (Armor-Piercing, etc.) but
     * has no enhancement slots and no effective-stat derivation. */
    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        const cfg = await import("../../setup/config.mjs");
        const catalog  = cfg.getActiveWeaponQualities() ?? {};
        const defaults = cfg.WEAPON_QUALITIES;
        const values   = this.item.system?.qualityValues
                      ?? this.item.toObject?.().system?.qualityValues
                      ?? {};
        ctx.weaponQualitiesCatalog = catalog;
        ctx.weaponQualityList = (this.item.system?.qualities ?? [])
            .map(key => {
                const entry = catalog[key] ?? defaults[key];
                if (!entry) return null;
                const param = entry.param ?? defaults[key]?.param ?? null;
                let label = entry.label;
                if (param) {
                    const raw = values[key];
                    const v   = raw == null ? "" : String(raw).trim();
                    if (v.length) label = `${entry.label}(${v}${param.suffix ?? ""})`;
                }
                return { key, label, description: entry.description };
            })
            .filter(Boolean);
        return ctx;
    }
}
export class WitcherArmorSheet extends WitcherItemSheet {
    static PARTS = partsFor("armor");

    static DEFAULT_OPTIONS = {
        actions: { detachEnhancement: WitcherArmorSheet._onDetachEnhancement }
    };

    static async _onDetachEnhancement(event, target) {
        if (!this.isEditable) return;
        const idx = Number(target.closest("[data-enh-index]")?.dataset.enhIndex);
        if (await detachEnhancement(this.item, idx)) this.render({ force: false });
    }

    async _onRender(context, options) {
        await super._onRender(context, options);
        wireEnhancementSlots(this, "armor");
    }

    /* Armor prep: armorQualityList for the display chips, spList for
     * the per-location SP rows (only non-zero), spInputs for the config
     * 6-location grid, plus localized labels and the hero number. */
    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        const cfg = await import("../../setup/config.mjs");
        const catalog  = cfg.getActiveArmorQualities?.() ?? cfg.ARMOR_QUALITIES ?? {};
        const defaults = cfg.ARMOR_QUALITIES ?? {};
        const values   = this.item.system?.qualityValues
                      ?? this.item.toObject?.().system?.qualityValues
                      ?? {};
        ctx.armorQualitiesCatalog = catalog;
        ctx.armorQualityList = (this.item.system?.qualities ?? [])
            .map(key => {
                const entry = catalog[key] ?? defaults[key];
                if (!entry) return null;
                const param = entry.param ?? defaults[key]?.param ?? null;
                let label = entry.label;
                if (param) {
                    const raw = values[key];
                    const v = raw == null ? "" : String(raw).trim();
                    if (v.length) label = `${entry.label}(${v}${param.suffix ?? ""})`;
                }
                return { key, label, description: entry.description };
            })
            .filter(Boolean);

        // Per-location SP — six locations, each has value/max. For display
        // we omit any location where max is 0 (the piece doesn't cover
        // it). For config we always show all six so the user can fill in
        // any combination — head-only helmets through full plate.
        const src = ctx.source ?? this.item.toObject().system;
        const LOC_LABELS = {
            head: "Head", torso: "Torso",
            leftArm: "Left Arm", rightArm: "Right Arm",
            leftLeg: "Left Leg", rightLeg: "Right Leg"
        };
        const LOC_KEYS = Object.keys(LOC_LABELS);
        const buildRow = (k) => ({
            key:   k,
            label: LOC_LABELS[k],
            value: Number(src?.[`${k}Stopping`])    || 0,
            max:   Number(src?.[`${k}MaxStopping`]) || 0
        });
        ctx.spList = LOC_KEYS.map(buildRow).filter(r => r.max > 0);
        // Config view only shows SP inputs for locations the armor
        // ACTUALLY covers — derived from the `location` field. Shields
        // get no SP inputs; helmets only head; full coverage gets all
        // six. Keeps the form focused so the GM doesn't have to scroll
        // past slots that don't apply to the piece.
        const LOC_TO_SP = {
            head:   ["head"],
            torso:  ["torso"],
            arms:   ["leftArm", "rightArm"],
            legs:   ["leftLeg", "rightLeg"],
            full:   LOC_KEYS,
            Shield: []
        };
        const activeKeys = LOC_TO_SP[src?.location] ?? [src?.location].filter(k => LOC_KEYS.includes(k));
        ctx.spInputs = activeKeys.map(buildRow);

        // Hero number — shields show reliability.value (blocks
        // remaining); other armor shows the SP at the chosen primary
        // `location`. "full" coverage shows the highest-SP location so
        // the hero reflects "best protection". Falls back to torso when
        // the primary location has no SP.
        const isShield = src?.armorType === "shield";
        if (isShield) {
            ctx.primarySP    = Number(src?.reliability?.value) || 0;
            ctx.primarySPMax = Number(src?.reliability?.max)   || 0;
            ctx.primaryStatLabel = "BLOCKS";
            ctx.coverageLabel    = "Shield";
        } else {
            // Build the SP rows for every location the armor covers, so
            // we can pick the hero from them AND derive a coverage
            // label. Uses the full LOC_KEYS list (not the location-
            // filtered spInputs) so multi-location armor shows all sides.
            const allRows = LOC_KEYS.map(buildRow).filter(r => r.max > 0);
            const sorted  = [...allRows].sort((a, b) => b.value - a.value);
            const chosen  = sorted[0];
            ctx.primarySP        = chosen?.value ?? 0;
            ctx.primarySPMax     = chosen?.max   ?? 0;
            ctx.primaryStatLabel = "STOPPING POWER";
            // Coverage subline: locations with non-zero max, joined.
            // Falls back to the declared primary location label when no
            // SP has been entered yet (so a brand-new armor still
            // displays meaningfully).
            const locsLabel = allRows.length
                ? allRows.map(r => r.label).join(" · ")
                : (src?.location
                    ? game.i18n.localize(CONFIG.WITCHER.armor.locations[src.location] ?? src.location)
                    : "");
            ctx.coverageLabel = locsLabel;
        }
        ctx.isShield = isShield;

        // Socketed enhancements + effective (enhanced) stats.
        const slotCount = Number(src?.armorEnhancement) || 0;
        ctx.enhancementSlots = buildEnhancementSlots(this.item, slotCount);
        const eff = this.item.system?.effective ?? null;
        ctx.effective  = eff;
        ctx.isEnhanced = !!eff?.modified;
        ctx.bonusSP    = Number(eff?.bonusSP) || 0;
        // Resistances added by enhancements (not already on the base armor).
        const addedRes = [];
        if (eff?.slashing    && !src?.slashing)    addedRes.push("Slashing");
        if (eff?.piercing    && !src?.piercing)    addedRes.push("Piercing");
        if (eff?.bludgeoning && !src?.bludgeoning) addedRes.push("Bludgeoning");
        ctx.addedResistances = addedRes;
        // Qualities the enhancements add on top of the armor's own.
        const baseQ = new Set(this.item.system?.qualities ?? []);
        const effVals = eff?.qualityValues ?? values;
        ctx.socketedQualityList = (eff?.qualities ?? [])
            .filter(k => !baseQ.has(k))
            .map(key => {
                const entry = catalog[key] ?? defaults[key];
                if (!entry) return null;
                const param = entry.param ?? defaults[key]?.param ?? null;
                let label = entry.label;
                if (param) {
                    const raw = effVals[key];
                    const v = raw == null ? "" : String(raw).trim();
                    if (v.length) label = `${entry.label}(${v}${param.suffix ?? ""})`;
                }
                return { key, label, description: entry.description };
            })
            .filter(Boolean);
        return ctx;
    }
}
export class WitcherShieldSheet extends WitcherItemSheet {
    static PARTS = partsFor("shield");

    static DEFAULT_OPTIONS = {
        actions: { detachEnhancement: WitcherShieldSheet._onDetachEnhancement }
    };

    static async _onDetachEnhancement(event, target) {
        if (!this.isEditable) return;
        const idx = Number(target.closest("[data-enh-index]")?.dataset.enhIndex);
        if (await detachEnhancement(this.item, idx)) this.render({ force: false });
    }

    async _onRender(context, options) {
        await super._onRender(context, options);
        // Shields host the same glyph / armor-mod enhancements as armor.
        wireEnhancementSlots(this, "armor");
    }

    /* Shield prep: the Reliability pool is the hero number; quality chips
     * and AE slots reuse the armor catalog + slot helpers. */
    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        const cfg = await import("../../setup/config.mjs");
        const catalog  = cfg.getActiveArmorQualities?.() ?? cfg.ARMOR_QUALITIES ?? {};
        const defaults = cfg.ARMOR_QUALITIES ?? {};
        const src = ctx.source ?? this.item.toObject().system;
        const values = this.item.system?.qualityValues
                    ?? this.item.toObject?.().system?.qualityValues
                    ?? {};
        ctx.shieldQualitiesCatalog = catalog;
        ctx.shieldQualityList = (this.item.system?.qualities ?? [])
            .map(key => {
                const entry = catalog[key] ?? defaults[key];
                if (!entry) return null;
                const param = entry.param ?? defaults[key]?.param ?? null;
                let label = entry.label;
                if (param) {
                    const raw = values[key];
                    const v = raw == null ? "" : String(raw).trim();
                    if (v.length) label = `${entry.label}(${v}${param.suffix ?? ""})`;
                }
                return { key, label, description: entry.description };
            })
            .filter(Boolean);

        // Hero number — blocks remaining / total before the shield breaks.
        ctx.blocks    = Number(src?.reliability?.value) || 0;
        ctx.blocksMax = Number(src?.reliability?.max)   || 0;

        // Shield bash (Core p.164) — wielder-derived offensive profile. The
        // damage equals the wielder's Punch shifted up by shield size, so it's
        // a live formula when owned and a size-relative descriptor in the
        // compendium (no wielder to read Punch from).
        const cat = src?.category || "medium";
        ctx.bash = {
            onActor: !!this.item.actor,
            levels:  cfg.SHIELD_BASH_LEVELS?.[cat] ?? cfg.SHIELD_BASH_LEVELS?.medium ?? 0,
            formula: this.item.actor ? cfg.shieldBashDamage(this.item.actor, this.item) : null
        };

        // AE socketing — same slot UI armor uses (host type "armor").
        const slotCount = Number(src?.armorEnhancement) || 0;
        ctx.enhancementSlots = buildEnhancementSlots(this.item, slotCount);
        return ctx;
    }
}
export class WitcherAlchemicalSheet extends WitcherItemSheet {
    static PARTS = partsFor("alchemical");

    // Effect-transfer for alchemicals (oils don't transfer to the holder,
    // consumables stay dormant until used) is owned by the consume-item
    // policy (module/chrome/policy/consume-item.js): a preCreateActiveEffect
    // hook + reconciler keep the invariant on create, on consumable-toggle,
    // and across existing worlds. So no per-sheet override here.

    /* Alchemical prep: the Witcher-3 hero is type-driven (Core p.83-95).
     *   bomb                    → damage formula
     *   potion/decoction        → toxicity (the pool-gating number, p.84)
     *   item / oil / other      → duration (or the type label as fallback)
     * Bomb-only fields (range/area/damageType) and the toxicity field are
     * gated in the template so an oil doesn't show empty bomb rows. Bombs
     * have no duration. */
    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        const src = ctx.source ?? this.item.toObject().system;
        const type = src?.type ?? "potion";
        ctx.isBomb       = type === "bomb";
        // Toxicity is only meaningful for potions and decoctions (they add
        // to the Toxicity pool when consumed, Core p.84). Poisons, oils,
        // bombs, etc. don't carry a toxicity figure.
        ctx.hasToxicity  = type === "potion" || type === "decoction";
        // Potions, decoctions and alchemical items can be marked
        // consumable (used = spend a dose + apply effects). Other alchemical
        // categories (oils, bombs) are applied differently, so no toggle.
        ctx.isConsumableType = type === "potion" || type === "decoction" || type === "item";
        ctx.typeLabel    = game.i18n.localize(CONFIG.WITCHER.alchemical.types[type] ?? type);

        if (ctx.isBomb) {
            ctx.heroValue = src?.damage || "—";
            ctx.heroLabel = "DAMAGE";
            ctx.heroSub   = src?.damageType
                ? game.i18n.localize(CONFIG.WITCHER.damageTypes[src.damageType] ?? src.damageType)
                : "";
        } else if (ctx.hasToxicity) {
            ctx.heroValue = src?.toxicity ?? 0;
            ctx.heroLabel = "TOXICITY";
            ctx.heroSub   = src?.duration || "";
        } else {
            ctx.heroValue = src?.duration || ctx.typeLabel;
            ctx.heroLabel = src?.duration ? "DURATION" : "TYPE";
            ctx.heroSub   = "";
        }
        return ctx;
    }
}
export class WitcherSpellSheet extends WitcherItemSheet {
    static PARTS = partsFor("spell");

    // A spell effect is a reference template applied on a successful cast —
    // it must not auto-apply to the caster who owns the spell item.
    get effectsTransfer() { return false; }

    static DEFAULT_OPTIONS = {
        actions: {
            removeComponent: WitcherSpellSheet._onRemoveComponent,
            openComponent:   WitcherSpellSheet._onOpenComponent
        }
    };

    static async _onRemoveComponent(event, target) {
        if (!this.isEditable) return;
        const idx = Number(target.closest("[data-component-index]")?.dataset.componentIndex);
        if (await removeComponent(this.item, idx)) this.render({ force: false });
    }

    static async _onOpenComponent(event, target) {
        const uuid = target.closest("[data-component-index]")?.dataset.uuid;
        if (!uuid) return;
        const doc = await fromUuid(uuid);
        doc?.sheet?.render(true);
    }

    /* Resolve enum labels + the live component links for display. The config
     * selects iterate CONFIG.WITCHER.magic.* directly. */
    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        const src = ctx.source ?? this.item.toObject().system;
        const M   = CONFIG.WITCHER?.magic ?? {};
        ctx.schoolLabel  = game.i18n.localize(M.schools?.[src?.school]      ?? src?.school     ?? "");
        ctx.formLabel    = game.i18n.localize(M.forms?.[src?.spellForm]     ?? src?.spellForm  ?? "");
        ctx.tierLabel    = game.i18n.localize(M.tiers?.[src?.spellType]     ?? src?.spellType  ?? "");
        ctx.targetLabel  = game.i18n.localize(M.targets?.[src?.targetType]  ?? src?.targetType ?? "");
        // Defense is a multi-select — join the picked labels the RAW way
        // ("Dodge or Block"); an empty selection means no defense ("None").
        const defs = Array.isArray(src?.defense) ? src.defense
                   : (src?.defense ? [src.defense] : []);
        ctx.defenseLabel = defs.length
            ? defs.map(d => game.i18n.localize(M.defenses?.[d] ?? d)).join(" or ")
            : game.i18n.localize("WITCHER.Magic.DefenseNone");
        // STA hero: "Variable" when the cost scales (e.g. Dispel).
        ctx.staLabel = src?.variableCost ? "Variable" : String(Number(src?.staminaCost) || 0);
        // Duration: "Immediate" / "Permanent" carry no count; the rest read
        // "<value> <unit>" where value may be a dice formula ("1d10").
        const unit = src?.duration?.unit ?? "instant";
        const val  = String(src?.duration?.value ?? "").trim();
        const hasVal = val && val !== "0";
        const unitLabel = game.i18n.localize(M.durationUnits?.[unit] ?? unit);
        ctx.durationLabel = (unit === "instant" || unit === "permanent" || !hasVal)
            ? unitLabel
            : `${val} ${unitLabel}`;
        ctx.componentLinks = buildComponentLinks(this.item);
        return ctx;
    }

    async _onRender(context, options) {
        await super._onRender(context, options);
        wireComponentDrop(this);
    }
}
export class WitcherHexSheet extends WitcherItemSheet {
    static PARTS = partsFor("hex");

    // A hex effect is a reference template for the TARGET — it must not
    // apply to the caster who owns the hex item.
    get effectsTransfer() { return false; }

    static DEFAULT_OPTIONS = {
        actions: {
            removeComponent: WitcherHexSheet._onRemoveComponent,
            openComponent:   WitcherHexSheet._onOpenComponent
        }
    };

    static async _onRemoveComponent(event, target) {
        if (!this.isEditable) return;
        const idx = Number(target.closest("[data-component-index]")?.dataset.componentIndex);
        if (await removeComponent(this.item, idx)) this.render({ force: false });
    }

    static async _onOpenComponent(event, target) {
        const uuid = target.closest("[data-component-index]")?.dataset.uuid;
        if (!uuid) return;
        const doc = await fromUuid(uuid);
        doc?.sheet?.render(true);
    }

    /* Resolve enum labels + the live component links for display. The
     * config selects iterate CONFIG.WITCHER.hex.* directly (already on
     * ctx.WITCHER), so prep only needs the display-side resolutions. */
    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        const src = ctx.source ?? this.item.toObject().system;
        const W   = CONFIG.WITCHER?.hex ?? {};
        ctx.defenseLabel = game.i18n.localize(W.defenses?.[src?.defense] ?? src?.defense ?? "");
        ctx.dangerLabel  = game.i18n.localize(W.danger?.[src?.danger] ?? src?.danger ?? "");
        // Duration: "Instant" / "Until Lifted" carry no count; the rest
        // read "<n> <unit>".
        const unit = src?.duration?.unit ?? "instant";
        const val  = Number(src?.duration?.value) || 0;
        const unitLabel = game.i18n.localize(W.durationUnits?.[unit] ?? unit);
        ctx.durationLabel = (unit === "instant" || unit === "lifted" || !val)
            ? unitLabel
            : `${val} ${unitLabel}`;
        ctx.componentLinks = buildComponentLinks(this.item);
        return ctx;
    }

    async _onRender(context, options) {
        await super._onRender(context, options);
        wireComponentDrop(this);
    }
}
export class WitcherRitualSheet extends WitcherItemSheet {
    static PARTS = partsFor("ritual");

    // A ritual effect is a reference template applied on a successful cast —
    // it must not auto-apply to the caster who owns the ritual item.
    get effectsTransfer() { return false; }

    static DEFAULT_OPTIONS = {
        actions: {
            removeComponent: WitcherRitualSheet._onRemoveComponent,
            openComponent:   WitcherRitualSheet._onOpenComponent
        }
    };

    static async _onRemoveComponent(event, target) {
        if (!this.isEditable) return;
        const idx = Number(target.closest("[data-component-index]")?.dataset.componentIndex);
        if (await removeComponent(this.item, idx)) this.render({ force: false });
    }

    static async _onOpenComponent(event, target) {
        const uuid = target.closest("[data-component-index]")?.dataset.uuid;
        if (!uuid) return;
        const doc = await fromUuid(uuid);
        doc?.sheet?.render(true);
    }

    /* Resolve enum labels + the live component links for display. The config
     * selects iterate CONFIG.WITCHER.ritual.* / magic.* directly. */
    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        const src = ctx.source ?? this.item.toObject().system;
        const W   = CONFIG.WITCHER?.ritual ?? {};
        const M   = CONFIG.WITCHER?.magic  ?? {};
        ctx.tierLabel   = game.i18n.localize(W.tiers?.[src?.tier]     ?? src?.tier   ?? "");
        ctx.schoolLabel = game.i18n.localize(M.schools?.[src?.school] ?? src?.school ?? "");
        // Prep time: "<n> <unit>".
        const ct     = src?.castingTime ?? {};
        const ctUnit = game.i18n.localize(W.timeUnits?.[ct.unit] ?? ct.unit ?? "");
        ctx.castingTimeLabel = `${Number(ct.value) || 0} ${ctUnit}`.trim();
        // Duration: "Immediate" / "Permanent" carry no count; the rest read
        // "<n> <unit>".
        const unit = src?.duration?.unit ?? "instant";
        const val  = Number(src?.duration?.value) || 0;
        const unitLabel = game.i18n.localize(W.durationUnits?.[unit] ?? unit);
        ctx.durationLabel = (unit === "instant" || unit === "permanent" || !val)
            ? unitLabel
            : `${val} ${unitLabel}`;
        // DC: variable rituals scale the DC to the task.
        ctx.dcLabel = src?.variableDC ? "Variable" : String(Number(src?.difficulty) || 0);
        ctx.componentLinks = buildComponentLinks(this.item);
        return ctx;
    }

    async _onRender(context, options) {
        await super._onRender(context, options);
        wireComponentDrop(this);
    }
}
export class WitcherMutagenSheet extends WitcherItemSheet {
    static PARTS = partsFor("mutagen");

    // The mutation bonus is granted by the install flow, not by holding the
    // mutagen — so its ActiveEffect must not auto-transfer to the owner.
    get effectsTransfer() { return false; }

    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        const type = ctx.source?.type ?? "red";
        ctx.typeLabel = type.charAt(0).toUpperCase() + type.slice(1);
        ctx.modifiers = summarizeEffectModifiers(this.item);
        return ctx;
    }
}
export class WitcherProfessionSheet extends WitcherItemSheet {
    static PARTS = partsFor("profession");

    // Wider than the default item sheet: the three skill trees read side
    // by side as columns, and each needs room for its skill definitions.
    static DEFAULT_OPTIONS = {
        position: { width: 780 },
        actions: {
            addSkillPackage:    WitcherProfessionSheet._onAddSkillPackage,
            removeSkillPackage: WitcherProfessionSheet._onRemoveSkillPackage,
            addPackageOption:   WitcherProfessionSheet._onAddPackageOption,
            removePackageOption: WitcherProfessionSheet._onRemovePackageOption,
            stepPackageChoose:  WitcherProfessionSheet._onStepPackageChoose
        }
    };

    /* Read the skillChoices array as a fresh plain-object copy we can mutate
     * and write back wholesale (SetField → array on the way out). */
    _choicesCopy() {
        const src = this.item.system?.skillChoices ?? [];
        return src.map(p => ({
            choose:  Number(p?.choose) || 1,
            options: Array.from(p?.options ?? [])
        }));
    }

    static async _onAddSkillPackage(event, target) {
        if (!this.isEditable) return;
        const choices = this._choicesCopy();
        choices.push({ choose: 1, options: [] });
        await this.item.update({ "system.skillChoices": choices });
    }

    static async _onRemoveSkillPackage(event, target) {
        if (!this.isEditable) return;
        const idx = Number(target.dataset.index);
        const choices = this._choicesCopy();
        if (idx < 0 || idx >= choices.length) return;
        choices.splice(idx, 1);
        await this.item.update({ "system.skillChoices": choices });
    }

    static async _onAddPackageOption(event, target) {
        if (!this.isEditable) return;
        const idx = Number(target.dataset.index);
        const key = target.value;   // fired from a <select>
        if (!key) return;
        const choices = this._choicesCopy();
        if (!choices[idx]) return;
        if (!choices[idx].options.includes(key)) choices[idx].options.push(key);
        await this.item.update({ "system.skillChoices": choices });
    }

    static async _onRemovePackageOption(event, target) {
        if (!this.isEditable) return;
        const idx = Number(target.dataset.index);
        const key = target.dataset.skill;
        const choices = this._choicesCopy();
        if (!choices[idx]) return;
        choices[idx].options = choices[idx].options.filter(k => k !== key);
        await this.item.update({ "system.skillChoices": choices });
    }

    static async _onStepPackageChoose(event, target) {
        if (!this.isEditable) return;
        const idx = Number(target.dataset.index);
        const delta = Number(target.dataset.delta) || 0;
        const choices = this._choicesCopy();
        if (!choices[idx]) return;
        const max = Math.max(1, choices[idx].options.length);
        choices[idx].choose = Math.min(max, Math.max(1, (Number(choices[idx].choose) || 1) + delta));
        await this.item.update({ "system.skillChoices": choices });
    }

    /* ApplicationV2 actions are click-only, so the package "+ add skill" <select>
     * needs manual change-wiring. Reuses the static add-option handler. */
    async _onRender(context, options) {
        await super._onRender(context, options);
        const root = this.element;
        if (!root) return;
        root.querySelectorAll("select.wdm-prof-pkg-add").forEach(sel => {
            if (sel.dataset.addBound) return;
            sel.dataset.addBound = "1";
            sel.addEventListener("change", (event) => {
                event.stopPropagation();
                WitcherProfessionSheet._onAddPackageOption.call(this, event, sel);
                sel.value = "";
            });
        });
    }

    /* Profession prep. The defining skill and the nine tree slots carry a
     * free-text name + a governing stat the GM picks, so the config form
     * needs the stat list. The "profession skills" package is keyed on the
     * 39 SKILL_MAP skills, so resolve those to labels + governing stat for
     * both the picker and the display view (the latter shows which stat
     * each granted skill rolls off). */
    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        const W = CONFIG.WITCHER;
        const src = ctx.source;

        // Stat dropdown options, with a precomputed `selected` flag per
        // chosen value so the template stays flat (no nested ../../ depth).
        // Some profession skills don't roll off a stat — an empty stat is
        // "N/A" (and the chrome treats it as non-rollable).
        const statOpts = (chosen) => [
            { key: "", label: "N/A", selected: !chosen },
            ...W.stats.map(k => ({
                key:      k,
                label:    game.i18n.localize(W.statLabel(k)),
                selected: k === chosen
            }))
        ];
        // Key→label map so the display view can name a slot's governing stat
        // (empty key → "N/A").
        ctx.statLabels = {
            "": "N/A",
            ...Object.fromEntries(
                W.stats.map(k => [k, game.i18n.localize(W.statLabel(k))])
            )
        };

        // Defining skill — config stat options + display label.
        ctx.definingStatOptions = statOpts(src.definingSkill?.stat ?? "");

        // The three trees, both as flat config rows and a display list.
        const TREE_KEYS  = ["skillPath1", "skillPath2", "skillPath3"];
        const SLOT_KEYS  = ["skill1", "skill2", "skill3"];
        ctx.treesConfig  = [];
        ctx.treesDisplay = [];
        TREE_KEYS.forEach((prefix, ti) => {
            const path = src[prefix] ?? {};
            ctx.treesConfig.push({
                label:    `Skill Tree ${ti + 1}`,
                prefix,
                pathName: path.pathName ?? "",
                skills:   SLOT_KEYS.map((slot, si) => {
                    const s = path[slot] ?? {};
                    return {
                        prefix, slot, n: si + 1,
                        skillName:  s.skillName ?? "",
                        definition: s.definition ?? "",
                        statOptions: statOpts(s.stat ?? "")
                    };
                })
            });
            const shown = SLOT_KEYS
                .map(slot => path[slot] ?? {})
                .filter(s => s.skillName)
                .map(s => ({
                    skillName:  s.skillName,
                    definition: s.definition ?? "",
                    statLabel:  ctx.statLabels[s.stat] ?? "N/A",
                    statNA:     !s.stat
                }));
            if (path.pathName || shown.length) {
                ctx.treesDisplay.push({
                    name:   path.pathName?.trim() || `Path ${ti + 1}`,
                    tone:   ["blue", "green", "red"][ti],
                    skills: shown
                });
            }
        });

        // Profession-skill package — the 39 base skills grouped by their
        // governing stat (config picker = checkbox grid; display = only the
        // granted ones). Stat order follows W.stats; empty groups dropped.
        const granted = new Set(Array.from(src.professionSkills ?? []));
        const groups = new Map();   // statKey → { statKey, statLabel, skills:[] }
        for (const [key, meta] of Object.entries(W.skillMap)) {
            if (!groups.has(meta.statKey)) {
                groups.set(meta.statKey, {
                    statKey:   meta.statKey,
                    statLabel: game.i18n.localize(W.statLabel(meta.statKey)),
                    skills:    []
                });
            }
            groups.get(meta.statKey).skills.push({
                key,
                label:    game.i18n.localize(W.skillLabel(key)),
                selected: granted.has(key)
            });
        }
        const ordered = W.stats
            .map(s => groups.get(s))
            .filter(Boolean)
            .map(g => ({
                ...g,
                skills: g.skills.sort((a, b) => a.label.localeCompare(b.label))
            }));
        // Picker shows every group; display shows only groups with picks.
        ctx.skillGroups = ordered;
        ctx.packageGroups = ordered
            .map(g => ({ ...g, skills: g.skills.filter(s => s.selected) }))
            .filter(g => g.skills.length);

        // Flat, alphabetized skill list for the "choose X of Y" option pickers.
        const allSkills = Object.keys(W.skillMap)
            .map(key => ({ key, label: game.i18n.localize(W.skillLabel(key)) }))
            .sort((a, b) => a.label.localeCompare(b.label));
        const labelOf = Object.fromEntries(allSkills.map(s => [s.key, s.label]));

        // "Choose X of Y" packages, resolved for both the config editor and the
        // display view.
        const choices = Array.isArray(src.skillChoices) ? src.skillChoices : [];
        ctx.skillPackages = choices.map((pkg, index) => {
            const opts = Array.from(pkg?.options ?? []);
            return {
                index,
                choose:  Number(pkg?.choose) || 1,
                options: opts.map(key => ({ key, label: labelOf[key] ?? key })),
                // Skills not yet in this package — the add-option dropdown.
                addable: allSkills.filter(s => !opts.includes(s.key))
            };
        });
        ctx.skillPackagesDisplay = ctx.skillPackages
            .filter(p => p.options.length)
            .map(p => ({ choose: p.choose, options: p.options }));

        return ctx;
    }

    /* The profession-skills package is a SetField rendered as a group of
     * same-name checkboxes. Foundry's path-expansion only sees the last
     * checked box (or drops the field entirely when none are checked), so
     * gather the whole group and write the complete array — including an
     * empty array, so deselecting all clears the set. */
    _prepareSubmitData(event, form, formData) {
        const data = super._prepareSubmitData(event, form, formData);
        if (!form) return data;
        const boxes = form.querySelectorAll(
            'input[type="checkbox"][name="system.professionSkills"]'
        );
        if (boxes.length) {
            const checked = Array.from(boxes).filter(b => b.checked).map(b => b.value);
            foundry.utils.setProperty(data, "system.professionSkills", checked);
        }
        return data;
    }
}
export class WitcherRaceSheet extends WitcherItemSheet {
    static PARTS = partsFor("race");

    /* Flatten the four quality boxes into an ordered list (config form
     * binds each box's inputs by its key; display shows only filled ones).
     * Effects are surfaced by the base `_prepareContext` (ctx.effects) and
     * transfer to the actor by default (effectsTransfer === true). */
    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        const q = ctx.source.qualities ?? {};
        ctx.qualityBoxes = ["box1", "box2", "box3", "box4"].map((key, i) => ({
            key,
            n:           i + 1,
            name:        q[key]?.name ?? "",
            description: q[key]?.description ?? ""
        }));
        ctx.filledQualities = ctx.qualityBoxes.filter(b => b.name || b.description);
        return ctx;
    }
}
export class WitcherHomelandSheet extends WitcherItemSheet {
    static PARTS = partsFor("homeland");

    /* A homeland's mechanical payload is a small fixed bonus (RAW: +1 to a
     * stat or skill, by region) carried as transferred ActiveEffects. The
     * W3 display view needs a human-readable summary of those bonuses, so
     * resolve each enabled effect's compiled `modify` changes into
     * "<label> <signed value>" rows. Keys map to friendly labels via the
     * shared effect-target catalog. */
    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        ctx.modifiers = summarizeEffectModifiers(this.item);
        return ctx;
    }
}
export class WitcherComponentSheet extends WitcherItemSheet {
    static PARTS = partsFor("component");

    /* Component prep (Core p.83, p.143). The hero renders only when the
     * component yields one of the nine alchemical substances — rarity isn't
     * repeated here (it already sits in the footer). Plain crafting
     * materials (Ashes, Coal, Timber) show no hero; their forage details
     * carry the tooltip via the stat list. The substance key lives in
     * `substanceType` — that's the field the crafting wheel matches. */
    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        const src = ctx.source ?? this.item.toObject().system;
        const subs  = CONFIG.WITCHER.alchemical.substances ?? {};
        const art   = CONFIG.WITCHER.alchemical.substanceArt ?? {};
        const subKey = (src?.substanceType ?? "").trim();

        ctx.isSubstance  = !!src?.isSubstance;
        ctx.hasHero      = ctx.isSubstance && !!subKey;
        if (ctx.hasHero) {
            ctx.substanceKey  = subKey;
            ctx.substanceName = game.i18n.localize(subs[subKey] ?? subKey);
            ctx.substanceArt  = art[subKey] ?? "";
        }
        return ctx;
    }

    /* Unchecking "Yields a Substance" must actually clear the substance,
     * not just hide the picker. The dropdown is removed from the DOM when
     * isSubstance is false, so it never submits and the saved substanceType
     * would otherwise persist — leaving the crafting wheel (which reads
     * substanceType directly) still matching it. Force it empty here. */
    _prepareSubmitData(event, form, formData) {
        const data = super._prepareSubmitData(event, form, formData);
        if (foundry.utils.getProperty(data, "system.isSubstance") === false) {
            foundry.utils.setProperty(data, "system.substanceType", "");
        }
        return data;
    }
}
export class WitcherEnhancementSheet extends WitcherItemSheet {
    static PARTS = partsFor("enhancement");

    /* Enhancement prep. `type` decides the target item class (weapon vs
     * armor) and therefore which modifier fields + quality catalog the
     * config form shows. The display view lists the concrete contributions
     * so a player reading the rune/glyph knows exactly what it grants. */
    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        const cfg = await import("../../setup/config.mjs");
        const src = ctx.source ?? this.item.toObject().system;

        const { ENHANCEMENT_TARGET } = await import("../../data/item/enhancement.mjs");
        const type   = src?.type ?? "rune";
        const target = ENHANCEMENT_TARGET[type] ?? "weapon";
        const isWeaponSide = target === "weapon";
        ctx.target       = target;
        ctx.isWeaponSide = isWeaponSide;
        ctx.isArmorSide  = !isWeaponSide;

        const TYPE_LABELS = { rune: "Rune", glyph: "Glyph", weapon: "Weapon Mod", armor: "Armor Mod" };
        ctx.typeLabel   = TYPE_LABELS[type] ?? type;

        // Quality catalog for the matching target.
        const catalog  = isWeaponSide
            ? (cfg.getActiveWeaponQualities?.() ?? cfg.WEAPON_QUALITIES ?? {})
            : (cfg.getActiveArmorQualities?.()  ?? cfg.ARMOR_QUALITIES  ?? {});
        const defaults = isWeaponSide ? (cfg.WEAPON_QUALITIES ?? {}) : (cfg.ARMOR_QUALITIES ?? {});
        ctx.qualitiesCatalog = catalog;
        const values = src?.qualityValues ?? {};
        ctx.grantedQualityList = (src?.grantedQualities ?? [])
            .map(key => {
                const entry = catalog[key] ?? defaults[key];
                if (!entry) return null;
                const param = entry.param ?? defaults[key]?.param ?? null;
                let label = entry.label;
                if (param) {
                    const raw = values[key];
                    const v   = raw == null ? "" : String(raw).trim();
                    if (v.length) label = `${entry.label}(${v}${param.suffix ?? ""})`;
                }
                return { key, label, description: entry.description };
            })
            .filter(Boolean);

        // Damage-type picker options (weapon-side only).
        ctx.damageTypes = cfg.DAMAGE_TYPES ?? CONFIG.WITCHER?.damageTypes ?? {};

        // Display modifier rows — only the non-zero contributions, so a
        // plain narrative enhancement shows none and a stat rune shows just
        // its numbers. Mirrors the weapon/armor w3-stats list.
        const rows = [];
        if (isWeaponSide) {
            const acc = Number(src?.accuracyBonus) || 0;
            const rel = Number(src?.reliabilityBonus) || 0;
            const dmg = (src?.damageBonus ?? "").toString().trim();
            if (acc) rows.push({ val: (acc > 0 ? "+" : "") + acc, lbl: "Weapon Accuracy", positive: acc > 0 });
            if (dmg) rows.push({ val: (dmg.startsWith("-") ? "" : "+") + dmg, lbl: "Damage", positive: !dmg.startsWith("-") });
            if (rel) rows.push({ val: (rel > 0 ? "+" : "") + rel, lbl: "Reliability", positive: rel > 0 });
        } else {
            const sp = Number(src?.stopping) || 0;
            const ev = Number(src?.encumbranceMod) || 0;
            if (sp) rows.push({ val: "+" + sp, lbl: "Stopping Power", positive: true });
            if (ev) rows.push({ val: (ev > 0 ? "+" : "") + ev, lbl: "Encumbrance", positive: ev < 0 });
        }
        ctx.modRows = rows;

        // Added/granted resistance + damage-type tags for the display view.
        const W = CONFIG.WITCHER ?? {};
        if (isWeaponSide) {
            ctx.addedTypeTags = (src?.addedDamageTypes ?? [])
                .map(k => game.i18n.localize(W.damageTypes?.[k] ?? k));
        } else {
            const res = [];
            if (src?.slashing)    res.push("Slashing");
            if (src?.piercing)    res.push("Piercing");
            if (src?.bludgeoning) res.push("Bludgeoning");
            ctx.resistTags = res;
        }

        // Hero — the dominant figure, type-driven.
        if (isWeaponSide) {
            const dmg = (src?.damageBonus ?? "").toString().trim();
            const acc = Number(src?.accuracyBonus) || 0;
            if (dmg)      { ctx.heroValue = (dmg.startsWith("-") ? "" : "+") + dmg; ctx.heroLabel = "DAMAGE"; }
            else if (acc) { ctx.heroValue = (acc > 0 ? "+" : "") + acc; ctx.heroLabel = "ACCURACY"; }
            else          { ctx.heroValue = ctx.typeLabel; ctx.heroLabel = "FOR WEAPON"; }
        } else {
            const sp = Number(src?.stopping) || 0;
            if (sp) { ctx.heroValue = "+" + sp; ctx.heroLabel = "STOPPING POWER"; }
            else    { ctx.heroValue = ctx.typeLabel; ctx.heroLabel = "FOR ARMOR"; }
        }

        // Where it's currently socketed (if applied).
        ctx.attachedName = "";
        if (src?.attachedTo && typeof fromUuidSync === "function") {
            try { const p = fromUuidSync(src.attachedTo); if (p) ctx.attachedName = p.name; } catch (_) { /* unresolved */ }
        }
        return ctx;
    }

    /* Clear modifier fields that don't belong to the current target side so
     * switching a rune (weapon) into a glyph (armor) doesn't leave orphan
     * weapon stats lingering. The hidden side's inputs aren't rendered, so
     * they wouldn't otherwise submit. Granted qualities are catalog-specific
     * to the side, so they're dropped too — otherwise a weapon quality key
     * would fold into the armor host's effective qualities. */
    _prepareSubmitData(event, form, formData) {
        const data = super._prepareSubmitData(event, form, formData);
        if (!form) return data;
        const type = form.querySelector('select[name="system.type"]')?.value
                  ?? foundry.utils.getProperty(data, "system.type");
        const isWeaponSide = (type === "rune" || type === "weapon");
        const prevWeaponSide = (this.item.system?.type === "rune" || this.item.system?.type === "weapon");
        const set = (k, v) => foundry.utils.setProperty(data, k, v);
        if (isWeaponSide) {
            set("system.stopping", 0);
            set("system.slashing", false);
            set("system.piercing", false);
            set("system.bludgeoning", false);
            set("system.encumbranceMod", 0);
        } else {
            set("system.accuracyBonus", 0);
            set("system.reliabilityBonus", 0);
            set("system.damageBonus", "");
            set("system.addedDamageTypes", []);
        }
        // Side changed → the granted-quality keys belong to the old catalog.
        if (isWeaponSide !== prevWeaponSide) {
            set("system.grantedQualities", []);
            set("system.qualityValues", {});
        }
        return data;
    }
}
export class WitcherContainerSheet extends WitcherItemSheet {
    static PARTS = partsFor("container");

    /* Container prep: the hero is the load read — stored / capacity (kg).
     * storedWeight is computed live by resolving the `content` UUIDs and
     * summing weight×quantity (mirrors chrome/lib/container.js
     * liveStoredWeight), because the persisted storedWeight is only a cache
     * the chrome maintains. Contents themselves are managed by the
     * inventory rail, not this sheet. */
    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        const src = ctx.source ?? this.item.toObject().system;
        const content = this.item.system?.content ?? [];

        let stored = 0;
        if (typeof fromUuidSync === "function") {
            for (const ref of content) {
                const inner = fromUuidSync(ref);
                if (!inner) continue;
                stored += (Number(inner.system?.weight) || 0) * (Number(inner.system?.quantity) || 1);
            }
        } else {
            stored = Number(src?.storedWeight) || 0;
        }

        const capacity = Number(src?.carry) || 0;
        ctx.capacity     = capacity;
        ctx.storedWeight = Math.round(stored * 100) / 100;
        ctx.contentCount = content.length;
        ctx.hasCapacity  = capacity > 0;
        ctx.isOver       = capacity > 0 && stored > capacity;
        ctx.fillPct      = capacity > 0 ? Math.min(100, Math.round((stored / capacity) * 100)) : 0;
        return ctx;
    }
}
export class WitcherNoteSheet          extends WitcherItemSheet { static PARTS = partsFor("note"); }
// Perk — icon + description + a transfer:true AE (stack multiple effects on one
// item). effectsTransfer defaults to true on WitcherItemSheet, so a perk's
// passives land on whoever carries it.
export class WitcherPerkSheet          extends WitcherItemSheet { static PARTS = partsFor("perk"); }
/* RAW critical-wound reference data (Core p.159-161, p.174), keyed by
 * criticalLevel. bonusDmg = Critical Wounds Table bonus damage (armor cannot
 * stop it); healDC / healTurns = Healing Hands table (a doctor treating the
 * wound); spellDC / spellUses = Healing Spell table (a mage). Surfaced
 * read-only in the display view so the wound card "reads" the rules. */
const CRIT_WOUND_INFO = {
    simple:    { label: "Simple",    bonusDmg: 3,  healDC: 12, healTurns: 2,  spellDC: 14, spellUses: 4  },
    complex:   { label: "Complex",   bonusDmg: 5,  healDC: 14, healTurns: 4,  spellDC: 16, spellUses: 6  },
    difficult: { label: "Difficult", bonusDmg: 8,  healDC: 16, healTurns: 6,  spellDC: 18, spellUses: 8  },
    deadly:    { label: "Deadly",    bonusDmg: 10, healDC: 18, healTurns: 8,  spellDC: 20, spellUses: 10 }
};

const CRIT_LOCATIONS = [
    { key: "head",     label: "Head" },
    { key: "torso",    label: "Torso" },
    { key: "rightArm", label: "Right Arm" },
    { key: "leftArm",  label: "Left Arm" },
    { key: "rightLeg", label: "Right Leg" },
    { key: "leftLeg",  label: "Left Leg" }
];

const CRIT_STATES = [
    { key: "unstabilized", label: "Unstabilized" },
    { key: "stabilized",   label: "Stabilized" },
    { key: "treated",      label: "Treated" }
];

const CRIT_EFFECT_SYS = "witcher-ttrpg-death-march";

export class WitcherCriticalWoundSheet extends WitcherItemSheet {
    static PARTS = partsFor("criticalWound");

    /* `createStateEffect` adds an effect pre-tagged to one care state; the
     * base create/edit/delete/toggle effect actions are inherited (merged). */
    static DEFAULT_OPTIONS = {
        actions: {
            createStateEffect: WitcherCriticalWoundSheet._onCreateStateEffect,
            toggleWoundStatus: WitcherCriticalWoundSheet._onToggleWoundStatus
        }
    };

    /* Toggle a status id in/out of system.statuses (the wound's inflicted
     * statuses, e.g. bleed). */
    static async _onToggleWoundStatus(event, target) {
        if (!this.isEditable) return;
        const id = target.dataset.status;
        if (!id) return;
        const set = new Set(this.item.system.statuses ?? []);
        set.has(id) ? set.delete(id) : set.add(id);
        await this.item.update({ "system.statuses": [...set] });
    }

    /* Two-layer prep. DISPLAY reads the wound — severity, location, variant,
     * the state's on-going effect, the RAW bonus-damage / treatment DCs, and
     * (once treated) the natural-healing clock. CONFIG edits the schema
     * fields. Option lists carry a precomputed `selected` flag so the
     * template stays flat. */
    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        const src = ctx.source;

        const level = CRIT_WOUND_INFO[src.criticalLevel] ? src.criticalLevel : "simple";
        const info  = CRIT_WOUND_INFO[level];
        const state = CRIT_STATES.some(s => s.key === src.state) ? src.state : "unstabilized";

        ctx.levelOptions = Object.entries(CRIT_WOUND_INFO).map(([key, v]) => ({
            key, label: v.label, selected: key === src.criticalLevel
        }));
        ctx.locationOptions = CRIT_LOCATIONS.map(o => ({ ...o, selected: o.key === src.location }));
        ctx.stateOptions    = CRIT_STATES.map(o => ({ ...o, selected: o.key === state }));

        // Status effects this wound inflicts while unstabilized — chip picker
        // in the config view (same status registry as monster immunities).
        // policy/wound-statuses.mjs reconciles these onto the bearer.
        const woundStatuses = new Set(src.statuses ?? []);
        ctx.woundStatusOptions = statusImmunityOptions().map(o => ({
            ...o, active: woundStatuses.has(o.value)
        }));

        ctx.levelLabel    = info.label;
        ctx.locationLabel = CRIT_LOCATIONS.find(o => o.key === src.location)?.label ?? src.location;
        ctx.stateLabel    = CRIT_STATES.find(o => o.key === state)?.label ?? state;
        ctx.variantLabel  = src.lesserEffect ? "Lesser" : "Greater";
        ctx.isStabilized  = state === "stabilized" || state === "treated";
        ctx.isTreated     = state === "treated";

        // The effect text for the current state (derived on the data model).
        ctx.activeEffect = this.item.system.activeEffect ?? src.description;

        // RAW reference numbers (display-only). Only the bonus damage from the
        // original strike bypasses armor (p.158); the DCs are for the doctor /
        // mage healing the wound (p.174).
        ctx.crit = {
            bonusDmg:  info.bonusDmg,
            healDC:    info.healDC,
            healTurns: info.healTurns,
            spellDC:   info.spellDC,
            spellUses: info.spellUses
        };

        // Natural-healing clock. Days / pct are derived getters on the data
        // model (read worldTime since `treatedAt` live); only a treated,
        // non-deadly wound counts down. Deadly (healingTime 0) never heals
        // here — prosthesis only.
        //
        // Healing time scales with the bearer's BODY (Critical Healing table),
        // so it has no meaningful value in the compendium (no bearer). The
        // config view shows the live number when on an actor, and the BODY
        // scale otherwise. SCALE = days at BODY 3 (hi) → the BODY where it
        // bottoms out at 1 day (loBody), per the table.
        const SCALE = {
            simple:    { hi: 5,  loBody: 7  },
            complex:   { hi: 9,  loBody: 11 },
            difficult: { hi: 12, loBody: 14 }
        };
        const time = Number(this.item.system.healingTime) || 0;
        ctx.heal = {
            onActor:     !!this.item.actor,
            body:        Number(this.item.actor?.system?.stats?.body?.max) || 0,
            isDeadly:    level === "deadly",
            days:        Number(this.item.system.healDaysElapsed) || 0,
            time,
            naturalHeal: time > 0,
            pct:         Number(this.item.system.healPct) || 0,
            scaleHi:     SCALE[level]?.hi ?? 0,
            scaleLoBody: SCALE[level]?.loBody ?? 0
        };

        // Effects grouped by the care state they apply in (flag `woundState`,
        // default unstabilized). Each state's effects only transfer to the
        // bearer while the wound is in that state (WitcherActiveEffect
        // .isSuppressed gates them), mirroring the per-state effect text.
        ctx.effectGroups = CRIT_STATES.map(s => ({
            state: s.key,
            label: s.label,
            effects: this.item.effects
                .filter(e => (e.getFlag(CRIT_EFFECT_SYS, "woundState") || "unstabilized") === s.key)
                .map(e => ({
                    id:       e.id,
                    name:     e.name,
                    img:      e.img,
                    disabled: e.disabled,
                    duration: { label: e.duration?.label ?? "" }
                }))
        }));

        return ctx;
    }

    /** Create an embedded effect tagged to the clicked state's group. Mirrors
     *  the base _onCreateEffect (inherit name/icon/transfer) and stamps the
     *  `woundState` flag so it lists in — and only applies during — that state. */
    static async _onCreateStateEffect(event, target) {
        if (!this.isEditable) return;
        const state = target?.dataset?.state || "unstabilized";
        const label = CRIT_STATES.find(s => s.key === state)?.label ?? state;
        const [effect] = await this.item.createEmbeddedDocuments("ActiveEffect", [{
            name: `${this.item.name} — ${label}`,
            img:  this.item.img,
            disabled: false,
            transfer: this.effectsTransfer,
            flags: { [CRIT_EFFECT_SYS]: { woundState: state } }
        }]);
        effect?.sheet?.render(true);
    }
}
export class WitcherDiagramsSheet extends WitcherItemSheet {
    static PARTS = partsFor("diagrams");

    /* Drag-drop linking: drop an Item on the output slot to set the
     * produced item; drop on the ingredient zone to add a crafting
     * component. Removal goes through these actions (merged with the
     * base's). */
    static DEFAULT_OPTIONS = {
        actions: {
            removeOutput:     WitcherDiagramsSheet._onRemoveOutput,
            removeIngredient: WitcherDiagramsSheet._onRemoveIngredient
        }
    };

    /* Diagram prep (Core p.127-146). The hero is the single craft DC —
     * formulae roll Alchemy (alchemyDC), diagrams roll Crafting
     * (craftingDC). Output item + ingredients resolve their live images
     * via UUID; the nine substances render as a fixed grid (config) and a
     * required-only list (display). */
    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        const src = ctx.source ?? this.item.toObject().system;
        const W   = CONFIG.WITCHER;

        // Three-way kind dropdown (diagram | formula | recipe). The DC field
        // routing splits formula+recipe (alchemyDC, also reused as the
        // Cooking DC) from diagram (craftingDC) so a recipe and a formula can
        // share storage and the UI just relabels.
        const kind = src?.kind || (src?.isFormulae ? "formula" : "diagram");
        ctx.kind = kind;
        const isFormula = kind === "formula";
        const isRecipe  = kind === "recipe";
        const isDiagram = kind === "diagram";
        ctx.isFormula = isFormula;
        ctx.isRecipe  = isRecipe;
        ctx.isDiagram = isDiagram;
        // Back-compat for partials still reading isFormulae; remove once every
        // template uses kind.
        ctx.isFormulae = isFormula;
        // Recipe is the homebrew-food-and-drink branch; it's hidden from the
        // dropdown when foodAndDrink is off — UNLESS the current item is
        // already authored as a recipe (we always keep the active value
        // selectable so toggling the homebrew off doesn't silently rewrite
        // existing data on save). Every other kind is RAW and always shown.
        const kindCatalog = {
            diagram: "WITCHER.Crafting.KindDiagram",
            formula: "WITCHER.Crafting.KindFormula",
            recipe:  "WITCHER.Crafting.KindRecipe"
        };
        const recipeAllowed = isRecipe || isHomebrewEnabled("foodAndDrink");
        ctx.kindOptions = Object.fromEntries(
            Object.entries(kindCatalog)
                .filter(([k]) => k !== "recipe" || recipeAllowed)
                .map(([k, v]) => [k, game.i18n.localize(v)])
        );
        ctx.kindLabel = ctx.kindOptions[kind] ?? kind;

        // One DC, bound to whichever roll this recipe drives. Recipes piggy-
        // back on alchemyDC storage (renamed in the UI to "Cooking DC") so the
        // schema doesn't need a third number field; if a GM later wants to
        // separate them, both fields are still in place.
        const dcField = isDiagram ? "system.craftingDC" : "system.alchemyDC";
        const dc      = isDiagram ? (Number(src?.craftingDC) || 0) : (Number(src?.alchemyDC) || 0);
        const dcLabel = isRecipe  ? "Cooking DC"
                      : isFormula ? "Alchemy DC"
                                  : "Crafting DC";
        ctx.dc = dc; ctx.dcField = dcField; ctx.dcLabel = dcLabel;

        // Classification labels + the subtype option set for config.
        const levels = W.crafting?.levels ?? {};
        ctx.levels      = levels;
        ctx.levelLabel  = src?.level ? game.i18n.localize(levels[src.level] ?? src.level) : "";
        const subMap    = isFormula ? (W.crafting?.formulaSubtypes ?? {})
                        : isRecipe  ? (W.crafting?.recipeSubtypes  ?? {})
                                    : (W.crafting?.diagramSubtypes ?? {});
        ctx.subtypeOptions = subMap;
        ctx.subtypeLabel   = src?.type ? game.i18n.localize(subMap[src.type] ?? src.type) : "";

        // Produced item — prefer the live document image over the cache.
        const assoc = src?.associatedItem ?? {};
        let outImg = assoc.img || "";
        if (assoc.uuid && typeof fromUuidSync === "function") {
            try { const d = fromUuidSync(assoc.uuid); if (d?.img) outImg = d.img; } catch (_) { /* unresolved */ }
        }
        ctx.output = {
            linked: !!(assoc.name || assoc.uuid),
            name:   assoc.name || "",
            uuid:   assoc.uuid || "",
            img:    outImg || "icons/svg/item-bag.svg"
        };

        // Ingredient links — resolve each to {name, img, quantity}.
        ctx.ingredients = (src?.craftingComponents ?? []).map((c, index) => {
            let img  = "icons/svg/item-bag.svg";
            let name = c.name || "";
            if (c.uuid && typeof fromUuidSync === "function") {
                try { const d = fromUuidSync(c.uuid); if (d) { img = d.img ?? img; if (!name) name = d.name; } } catch (_) { /* unresolved */ }
            }
            return { index, uuid: c.uuid || "", name, img, quantity: Number(c.quantity) || 0 };
        });
        ctx.hasIngredients = ctx.ingredients.length > 0;

        // Substance requirements — all nine for the config grid, only the
        // required ones for the display list.
        const subs  = W.alchemical?.substances ?? {};
        const art   = W.alchemical?.substanceArt ?? {};
        const reqMap = src?.alchemyComponents ?? {};
        ctx.substances = Object.keys(subs).map(key => ({
            key,
            label: game.i18n.localize(subs[key] ?? key),
            art:   art[key] ?? "",
            qty:   Number(reqMap[key]) || 0
        }));
        ctx.substancesRequired = ctx.substances.filter(s => s.qty > 0);
        ctx.hasSubstances = ctx.substancesRequired.length > 0;

        return ctx;
    }

    async _onRender(context, options) {
        await super._onRender(context, options);
        if (!this.isEditable) return;
        const root = this.element;

        root.querySelectorAll("[data-drop-zone]").forEach(zone => {
            zone.addEventListener("dragover", ev => { ev.preventDefault(); zone.classList.add("is-drop-target"); });
            zone.addEventListener("dragleave", () => zone.classList.remove("is-drop-target"));
            zone.addEventListener("drop", async ev => {
                ev.preventDefault();
                zone.classList.remove("is-drop-target");
                await this.#handleDrop(ev, zone.dataset.dropZone);
            });
        });

        // Ingredient quantity steppers — not form-bound (the array is
        // managed via update()), so commit changes by index here.
        root.querySelectorAll("input[data-ingredient-qty]").forEach(inp => {
            inp.addEventListener("change", async ev => {
                const idx = Number(ev.target.dataset.ingredientQty);
                const qty = Math.max(0, Math.floor(Number(ev.target.value) || 0));
                const list = foundry.utils.deepClone(this.item.system.craftingComponents ?? []);
                if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) return;
                list[idx].quantity = qty;
                await this.item.update({ "system.craftingComponents": list });
            });
        });

        // Substance steppers — same story as ingredients: not form-bound
        // (alchemyComponents is an opaque ObjectField), so commit directly
        // here. Relying on the form-submit reassembly alone dropped edits
        // across the cog toggle, whose submit() swallows the base
        // _prepareSubmitData validation throw. Rebuild the full map from
        // every stepper and force-replace the field: a plain update diffs
        // only keys present in the new object, so zeroing a substance
        // (dropping its key) would otherwise produce an empty diff and never
        // clear. ForcedReplacement bypasses the diff and assigns the map whole.
        root.querySelectorAll("input[data-substance-key]").forEach(inp => {
            inp.addEventListener("change", async () => {
                const map = {};
                root.querySelectorAll("input[data-substance-key]").forEach(i => {
                    const key = i.dataset.substanceKey;
                    const q = Math.max(0, Math.floor(Number(i.value) || 0));
                    if (q > 0) map[key] = q;
                });
                const { ForcedReplacement } = foundry.data.operators;
                await this.item.update({ "system.alchemyComponents": ForcedReplacement.create(map) });
            });
        });
    }

    async #handleDrop(event, zone) {
        if (!this.isEditable) return;
        let data;
        try { data = JSON.parse(event.dataTransfer.getData("text/plain")); } catch (_) { return; }
        if (data?.type !== "Item" || !data.uuid) return;
        const item = await fromUuid(data.uuid);
        if (!item) return;
        // Don't let a diagram reference itself as its own output/ingredient.
        if (item.uuid === this.item.uuid) return;

        if (zone === "output") {
            await this.item.update({
                "system.associatedItem": { name: item.name, uuid: item.uuid, img: item.img }
            });
        } else if (zone === "ingredient") {
            const list = foundry.utils.deepClone(this.item.system.craftingComponents ?? []);
            const existing = list.find(c => c.uuid && c.uuid === item.uuid);
            if (existing) existing.quantity = (Number(existing.quantity) || 0) + 1;
            else list.push({ uuid: item.uuid, name: item.name, quantity: 1 });
            await this.item.update({ "system.craftingComponents": list });
        }
    }

    static async _onRemoveOutput(event, target) {
        if (!this.isEditable) return;
        await this.item.update({ "system.associatedItem": { name: "", uuid: "", img: null } });
    }

    static async _onRemoveIngredient(event, target) {
        if (!this.isEditable) return;
        const idx = Number(target.closest("[data-ingredient-index]")?.dataset.ingredientIndex);
        if (!Number.isInteger(idx)) return;
        const list = foundry.utils.deepClone(this.item.system.craftingComponents ?? []);
        if (idx < 0 || idx >= list.length) return;
        list.splice(idx, 1);
        await this.item.update({ "system.craftingComponents": list });
    }

    /* Reassemble the substance map from the nine steppers (data-substance-key,
     * not form-named) so the ObjectField writes whole. Only runs when the
     * substance grid is actually rendered (kind === "formula"), so switching
     * to a different kind doesn't wipe a formula's saved requirements — the
     * grid simply isn't present to read. */
    _prepareSubmitData(event, form, formData) {
        const data = super._prepareSubmitData(event, form, formData);
        if (!form) return data;
        // Read the active kind from the dropdown so a non-formula kind drops
        // the substance map (otherwise it lingers because the grid is no
        // longer rendered to reassemble from).
        const kind = form.querySelector('select[name="system.kind"]')?.value
                  || form.querySelector('input[name="system.kind"]')?.value
                  || "diagram";
        const map = {};
        if (kind === "formula") {
            form.querySelectorAll("input[data-substance-key]").forEach(inp => {
                const key = inp.dataset.substanceKey;
                const q = Math.max(0, Math.floor(Number(inp.value) || 0));
                if (q > 0) map[key] = q;
            });
        }
        // Force-replace: a plain ObjectField update diffs only keys present
        // in the new map, so clearing it (switching to a non-formula kind) or
        // zeroing a substance would otherwise leave stale keys behind.
        const { ForcedReplacement } = foundry.data.operators;
        foundry.utils.setProperty(data, "system.alchemyComponents", ForcedReplacement.create(map));
        return data;
    }
}
export class WitcherValuableSheet extends WitcherItemSheet {
    static PARTS = partsFor("valuable");

    static DEFAULT_OPTIONS = {
        actions: { configureBook: WitcherValuableSheet._onConfigureBook }
    };

    /* Open the dedicated book-setup dialog (DC / monster filter / skill range
     * / stress steps). The dialog is GM-rich, player-readonly; it persists to
     * system.bookConfig. Lazy-imported to keep the core sheet decoupled from
     * the chrome book module. */
    static async _onConfigureBook(event, target) {
        const { openBookConfigDialog } = await import("../../chrome/sheets/valuable-study.js");
        await openBookConfigDialog(this.item);
    }

    /* Subtype-driven display context: resolve the subtype label, a short
     * book summary, the map image (system-first, legacy-flag fallback), and
     * the source-monster name for remains. The book/map detail editors are
     * owned elsewhere (dialog / file picker); this only feeds the readout.
     *
     * Subtype resolution: map and remains are first-class item types
     * (item.type === "map" / "remains"); for those, the subtype is implicit
     * from the document type, and the in-sheet subtype <select> is hidden.
     * For plain valuables (item.type === "valuable") the subtype comes from
     * system.type ("" | "book" | "trophy") as before.
     */
    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        const src = ctx.source ?? this.item.toObject().system;
        const docType = this.item.type;
        const subtype = docType === "map" || docType === "remains"
            ? docType
            : String(src?.type ?? "");
        ctx.subtype = subtype;
        // Only valuables surface the subtype <select> — the new types are
        // implicit from their document type, so the dropdown would just
        // confuse the author.
        ctx.showSubtypeSelect = docType === "valuable";

        const SUBTYPE_LABELS = { "": "Valuable", book: "Book", map: "Map", remains: "Remains", trophy: "Trophy" };
        ctx.subtypeLabel = SUBTYPE_LABELS[subtype] ?? "Valuable";

        if (subtype === "trophy") {
            const tc = src?.trophyConfig ?? {};
            ctx.trophy = { monsterCategory: String(tc.monsterCategory ?? "") };
        }

        if (subtype === "book") {
            ctx.bookEnabled = game.system.api.homebrew.isEnabled("bookSystem");
            const bc = src?.bookConfig ?? {};
            ctx.bookType = bc.bookType ?? "monster";
            const TYPE_LABELS = { monster: "Monster Lore", skill: "Skill", stress: "Novel / Lore" };
            ctx.bookTypeLabel = TYPE_LABELS[ctx.bookType] ?? "Monster Lore";
            ctx.bookSummary = summarizeBookConfig(bc);

            // Per-reader progress (only when the item is owned by an actor).
            ctx.bookProgress = null;
            const actor = this.item.actor;
            if (actor) {
                try {
                    const { getBookProgress } = await import("../../chrome/sheets/valuable-study.js");
                    ctx.bookProgress = getBookProgress(this.item, actor);
                } catch (_) { /* chrome module unavailable — skip progress */ }
            }
        }

        if (subtype === "map") {
            const MODULE_ID = "witcher-ttrpg-death-march";
            const LEGACY_ID = "witcher-overhaul-ui";
            ctx.mapImage = String(
                src?.mapImage
                ?? this.item.flags?.[MODULE_ID]?.mapImage
                ?? this.item.flags?.[LEGACY_ID]?.mapImage
                ?? ""
            );
            ctx.hasMap = !!ctx.mapImage;
        }

        if (subtype === "remains") {
            const MODULE_ID = "witcher-ttrpg-death-march";
            const LEGACY_ID = "witcher-overhaul-ui";
            const uuid = src?.monsterUuid
                || this.item.flags?.[MODULE_ID]?.monsterUuid
                || this.item.flags?.[LEGACY_ID]?.monsterUuid
                || "";
            ctx.remainsMonsterName = "";
            if (uuid && typeof fromUuidSync === "function") {
                try { ctx.remainsMonsterName = fromUuidSync(uuid)?.name ?? ""; }
                catch (_) { /* unresolved — leave blank */ }
            }

            // What's been done to the carcass — the only thing worth surfacing
            // in the player-facing view (name + icon already say what it is).
            const f = this.item.flags?.[MODULE_ID] ?? {};
            const CHARGES_MAX = 3;
            ctx.remainsState = {
                harvested:  !!f.harvested,
                extracted:  !!f.mutagenExtracted,
                charges:    f.remainsCharges ?? CHARGES_MAX,
                chargesMax: CHARGES_MAX
            };
        }

        return ctx;
    }
}

/* Short, human-readable summary of a book's system.bookConfig for the sheet
 * readout. The authoritative editor is the chrome book dialog; this stays
 * intentionally light (no bestiary lookups). */
function summarizeBookConfig(bc) {
    const type = bc?.bookType ?? "monster";
    if (type === "stress") {
        const steps = Array.isArray(bc?.stress?.steps) ? bc.stress.steps.length : 0;
        return steps ? `Novel / Lore — ${steps} reading step${steps === 1 ? "" : "s"}.` : "Novel / Lore — not configured yet.";
    }
    if (type === "skill") {
        const sc = bc?.skill ?? {};
        if (!sc.skillId) return "Skill book — not configured yet.";
        return `Skill book — ${sc.skillId} (rank ${sc.rangeMin ?? 0}→${sc.rangeMax ?? 1}).`;
    }
    const mc = bc?.monster ?? {};
    if (mc.mode === "list")   return `Monster study — ${(mc.listKeys ?? []).length} monsters.`;
    if (mc.mode === "filter") return `Monster study — filter mode.`;
    if (mc.specificKey)       return `Monster study — single monster.`;
    return "Monster study — not configured yet.";
}
export class WitcherDieSheet extends WitcherItemSheet {
    static PARTS = partsFor("die");

    /* Per-face rows ({ value, img, weight }) for the display grid + config
     * pickers, plus a loaded-die flag derived from unequal weights. */
    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        const src = ctx.source ?? this.item.toObject().system;
        ctx.faces = [1, 2, 3, 4, 5, 6].map(v => ({
            value: v,
            img: src?.[`face${v}Image`] ?? "",
            weight: src?.[`face${v}Weight`] ?? 1
        }));
        ctx.isLoaded = !ctx.faces.every(f => f.weight === ctx.faces[0].weight);
        return ctx;
    }
}
export class WitcherFoodSheet extends WitcherItemSheet {
    static PARTS = partsFor("food");

    /* Food carries its own ActiveEffects (consumed on Eat / Drink). They
     * must stay DORMANT while the item is merely held — the consume flow
     * copies them onto the consumer with transfer:false. The base class's
     * default is transfer:true (auto-apply to carrier), which would mean
     * carrying a buff-laden pie permanently buffs the holder. */
    get effectsTransfer() { return false; }

    /* Override the base "name new effects after the item" behavior: on a
     * food item that's misleading because the consume flow copies the
     * effect to the actor, where it'd appear as e.g. "Mead" — looking
     * like the food itself rather than what it does. Default to "New
     * Effect" so the GM has to name it intentionally; carry the icon and
     * description as helpful starting points. */
    static async _onCreateEffect(event, target) {
        if (!this.isEditable) return;
        const [effect] = await this.item.createEmbeddedDocuments("ActiveEffect", [{
            name: "New Effect",
            img:  this.item.img,
            description: this.item.system?.description ?? "",
            disabled: false,
            transfer: this.effectsTransfer
        }]);
        effect?.sheet?.render(true);
    }

    /* Add the homebrew-gate flag the food.hbs template uses to hide the
     * taste / charges / satiety / drunk blocks when foodAndDrink is off,
     * plus the localized kind dropdown options and a `kind`-on-source
     * shortcut so the template can `{{#if (eq kind "drink")}}` without
     * re-reading source.kind. The schema fields are always present (ADR
     * 0003); only the UI surface is gated, so flipping the toggle doesn't
     * churn data. */
    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        ctx.foodAndDrinkOn = isHomebrewEnabled("foodAndDrink");
        const src = ctx.source ?? this.item.toObject().system;
        ctx.kind = src?.kind || "meal";
        ctx.kindOptions = {
            meal:  game.i18n.localize("WITCHER.Food.KindMeal"),
            drink: game.i18n.localize("WITCHER.Food.KindDrink")
        };
        ctx.kindLabel = ctx.kindOptions[ctx.kind] ?? ctx.kind;
        ctx.isDrink = ctx.kind === "drink";

        // Freshness readout. Pulled live so the sheet shows the up-to-date
        // state without an explicit re-render. Untracked items (sidebar copy
        // or shelfLifeDays === 0) collapse to `tracked: false` so the
        // template hides the readout instead of saying "0.0 days left".
        try {
            const { getFreshnessState, getFreshnessDaysRemaining } =
                await import("../../mechanics/foodAndDrink.mjs");
            const state = getFreshnessState(this.item);
            const remaining = getFreshnessDaysRemaining(this.item);
            const LABELS = { fresh: "Fresh", stale: "Stale", spoiled: "Spoiled" };
            const ICONS  = { fresh: "fa-leaf", stale: "fa-leaf", spoiled: "fa-skull" };
            ctx.freshness = {
                tracked: state !== "untracked",
                state,
                stateLabel: LABELS[state] ?? "Fresh",
                icon: ICONS[state] ?? "fa-leaf",
                remaining: remaining != null ? remaining.toFixed(1) : ""
            };
        } catch (_) {
            ctx.freshness = { tracked: false };
        }
        return ctx;
    }
}
