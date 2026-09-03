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

import { buildEnhancementSlots, buildEnhancementSlotGroups, wireEnhancementSlots, detachEnhancement } from "./enhancementSlots.mjs";
import { buildComponentLinks, wireComponentDrop, removeComponent } from "./hexComponents.mjs";
import { buildStatusRiderRows, addStatusRider, removeStatusRider, buildStaScaleLadder } from "./statusRiders.mjs";
import { listSpellHandlerIds } from "../../mechanics/spellHandlers.mjs";
import { DARK_VISION_MODES } from "../../mechanics/light-level.mjs";
import { effectStatTargets, statusImmunityOptions, ARMOR_LOCATION_COVERAGE } from "../../setup/config.mjs";
import { isHomebrewEnabled } from "../../api/homebrew.mjs";
import { hrNewSilverRules } from "../../mechanics/house-rules-config.mjs";
/* POSITION MATTERS. This file sits between two pre-existing import cycles
 * (config ↔ statusEffects, light-level ↔ stealth-hooks), and which module in
 * them evaluates first depends on the order of the lines above. Moving these
 * two lines to the end of the block — which looks tidier — makes
 * `stealth-hooks.mjs` read `LIGHT_TIER_RANK` before it exists.
 *
 * Neither cycle fires under Foundry, whose entry point is main.mjs. It fires
 * when a test imports this file directly, which is the only way the sheet gets
 * exercised outside a browser. */
import { authoredSummary } from "../../magic/summary.mjs";
import { captureUI, restoreUI } from "../../magic/canvas/uistate.mjs";
import { baseSummaryFor }    from "../../mechanics/alchemy.mjs";

import { t, tFormat } from "../../chrome/lib/i18n.js";
import { getContainerCfg } from "../../chrome/lib/container.js";
import { feedMagazineWithPrompt } from "../../chrome/lib/reload.js";

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
        // Merchant preview (a shopper viewing stock they don't own): blank the cost
        // everywhere it's shown — every template reads `source.cost` — so the true
        // price never leaks past the shop's Business appraisal check.
        if (this.item.getFlag?.("witcher-ttrpg-death-march", "merchantPreviewHideCost")) {
            ctx.source = { ...ctx.source, cost: "" };
        }
        ctx.WITCHER  = CONFIG.WITCHER;
        ctx.homebrew = (key) => game.system.api.homebrew.isEnabled(key);
        /* Homebrew gate flags exposed to every item template. The food
         * sheet re-sets `foodAndDrinkOn` in its own _prepareContext for
         * its specific dependents, but templates on other item types
         * (race sheet's Alcohol Resistance dropdown, container sheet's
         * charge gates, etc.) need this flag too — without it,
         * `{{#if foodAndDrinkOn}}` gates evaluate undefined/false and
         * the surface never renders. */
        ctx.foodAndDrinkOn = isHomebrewEnabled("foodAndDrink");
        // Display/config mode. Non-owners are pinned to display (no cog
        // shown). Owners default to display and can toggle to config —
        // BUT only when they hold Foundry's "Create Items" (ITEM_CREATE)
        // role permission. That's the same gate Foundry uses for creating
        // items, so it's the natural authority level to also govern who
        // can restructure an item's config. GMs always pass hasPermission.
        // Applied through `canEdit` because every item template uses
        // {{#if canEdit}} to render the cog toggle — one gate covers
        // every item class at once.
        ctx.mode = this.#mode;
        ctx.canEdit = this.isEditable && WitcherItemSheet._canConfigureItems();
        // Item-embedded ActiveEffects — surfaced so per-type templates
        // (e.g. alchemical) can list and manage real Foundry effects in
        // place of a free-form effect text field.
        ctx.effects = this.item.effects.map(e => ({
            id:          e.id,
            name:        e.name,
            img:         e.img,
            disabled:    e.disabled,
            description: e.description ?? "",
            duration:    { label: e.duration?.label ?? "" },
            /* Per-effect application chance (spell sheet). Default 100 =
             * always applies; the cast-time authored-AE loop rolls d100
             * against this per target. */
            applyChance: Number(e.getFlag?.("witcher-ttrpg-death-march", "applyChance") ?? 100)
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
            window: { title: t("WITCHER.Dialog.DeleteEffect", "Delete Effect") },
            content: `<p>${t("WITCHER.Sheet.Item.Base.Text.Remove", "Remove")} <strong>${effect.name}</strong>?</p>`
        });
        if (ok) await effect.delete();
    }
    static async _onToggleEffect(event, target) {
        if (!this.isEditable) return;
        const id = target.closest("[data-effect-id]")?.dataset.effectId;
        const effect = this.item.effects.get(id);
        await effect?.update({ disabled: !effect.disabled });
    }

    /* Foundry role-level ITEM_CREATE permission gate for the item's
       display↔config toggle. GM implicitly passes hasPermission. This
       lives on the base sheet so every item subclass inherits the same
       gate without per-class duplication. */
    static _canConfigureItems() {
        try { return !!game.user?.hasPermission?.("ITEM_CREATE"); }
        catch { return !!game.user?.isGM; }
    }

    static async _onToggleItemMode(event, target) {
        if (!this.isEditable) return;
        /* Belt-and-braces: the cog button is hidden when canEdit is
           false (see _prepareContext), but a crafted click on the
           data-action still routes here — hard-block without
           ITEM_CREATE so it can't restructure item config. */
        if (!WitcherItemSheet._canConfigureItems()) return;
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
        // Per-item flair-colour override (flair-override.hbs partial). The
        // `flairEnabled` checkbox is a UI-only helper. CRITICAL: an unchecked
        // checkbox is omitted from form data entirely, so we must read the
        // control's LIVE state from the form — not `"flairEnabled" in data`,
        // which is only ever true when it's ticked. The colour <input> always
        // submits its picker value (a non-empty default even when the override
        // is off), so unless we force-clear it here every save would silently
        // switch the override on. Only act when this form actually has the row.
        const flairToggle = form.querySelector('input[name="flairEnabled"]');
        if (flairToggle) {
            if (!flairToggle.checked) {
                foundry.utils.setProperty(data, "system.flairColor", "");
            } else {
                // Toggled ON: if the picker is still on an OFF-sentinel colour
                // (the unchecked default), seed a real flair colour so the
                // override actually takes. Without this, hasFlair() reads the
                // sentinel as OFF and the checkbox snaps back on the next render —
                // the user had to toggle twice. (#c8a878 = amber-bright.)
                const cur = String(foundry.utils.getProperty(data, "system.flairColor") ?? "").trim().toLowerCase();
                if (!/^#[0-9a-f]{6}$/.test(cur) || cur === "#000000" || cur === "#b0a894") {
                    foundry.utils.setProperty(data, "system.flairColor", "#c8a878");
                }
            }
            delete data.flairEnabled;
        }
        return data;
    }

    /* Merchant preview (a shopper viewing stock they don't own): strip every price
     * element — the coin-icon display span and the cost input row — so nothing
     * about the price leaks past the shop's Business appraisal. Runs on every
     * render (incl. tab switches), so it survives re-renders. Subclasses call
     * super._onRender, so this fires for all item types. */
    async _onRender(context, options) {
        await super._onRender?.(context, options);
        if (!this.item?.getFlag?.("witcher-ttrpg-death-march", "merchantPreviewHideCost")) return;
        const root = this.element;
        if (!root) return;
        root.querySelectorAll?.(".wdm-w3-price").forEach(n => n.remove());
        root.querySelectorAll?.('[name="system.cost"]').forEach(inp => (inp.closest(".wdm-cfg-row") ?? inp).remove());
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
            detachEnhancement:               WitcherWeaponSheet._onDetachEnhancement,
            addBombEffect:                   WitcherWeaponSheet._onAddBombEffect,
            addBombStatus:                   WitcherWeaponSheet._onAddBombStatus,
            editBombEffect:                  WitcherWeaponSheet._onEditBombEffect,
            deleteBombEffect:                WitcherWeaponSheet._onDeleteBombEffect,
            reload:                          WitcherWeaponSheet._onReload,
            feedMagazine:                    WitcherWeaponSheet._onFeedMagazine,
            fillMagazine:                    WitcherWeaponSheet._onFillMagazine,
            "config-open-category-quality":  WitcherWeaponSheet._onConfigOpenCategory
        }
    };

    static async _onDetachEnhancement(event, target) {
        if (!this.isEditable) return;
        const idx = Number(target.closest("[data-enh-index]")?.dataset.enhIndex);
        if (await detachEnhancement(this.item, idx)) this.render({ force: false });
    }

    /** Open the structured-bonus dialog for an open-category quality
     *  (Two-Hand, Close Quarters, Throwing, Strangling). The dialog
     *  parses + re-emits the qualityValues[key] free-text bonus
     *  string so the existing attack-pipeline parser keeps working. */
    static async _onConfigOpenCategory(event, target) {
        if (!this.isEditable) return;
        const key = target?.dataset?.qualityKey;
        if (!key) return;
        const { openOpenCategoryConfigDialog } = await import("../../applications/openCategoryConfigDialog.mjs");
        const newText = await openOpenCategoryConfigDialog(this.item, key);
        if (newText == null) return;                       /* user cancelled */
        /* Also toggle qualities-list membership to match the value:
         *   non-empty text → ensure the quality key is listed (so the
         *                    OC pipeline's `qs.includes(key)` gate fires)
         *   empty text     → remove the key from the list (the GM has
         *                    turned the bonus off)
         * Without this, a user could set "+5 WA" via the structured dialog
         * and see nothing apply because the checkbox in the qualities grid
         * was still unticked — the parser found the value but the gate
         * rejected the whole quality as inactive. */
        const trimmed = String(newText).trim();
        const cur = Array.isArray(this.item.system?.qualities) ? [...this.item.system.qualities] : [];
        const has = cur.includes(key);
        let nextQualities = cur;
        if (trimmed && !has) nextQualities = [...cur, key];
        else if (!trimmed && has) nextQualities = cur.filter(q => q !== key);
        const patch = { [`system.qualityValues.${key}`]: newText };
        if (nextQualities !== cur) patch["system.qualities"] = nextQualities;
        await this.item.update(patch);
    }

    /* Chamber a slow-reload weapon from the selected eligible ammo. The
     * mixin's reload() decrements the ammo stack and fills system.loaded;
     * the document update re-renders this sheet automatically. */
    static async _onReload(event, target) {
        await this.item.reload();
    }

    /* ＋ Load Magazine — feed ONE round into a magazine crossbow's reservoir
     * without cocking (CE magazine model, capacity 2+). Cocking is the separate
     * Reload button. Like _onReload, the sheet performs the mechanical action
     * without touching the combat-action pool — the dock/overlay call sites own
     * the in-combat action accounting. */
    static async _onFeedMagazine(event, target) {
        await feedMagazineWithPrompt(this.item);
    }

    /* Fill — out-of-combat convenience: top the magazine up with the currently
     * selected ammo until it's full or that stack runs dry (a "uniform load").
     * In combat this collapses to a single feed, since each bolt costs an
     * action there. */
    static async _onFillMagazine(event, target) {
        const item = this.item;
        if (item.actor?._inActiveCombat) return void await feedMagazineWithPrompt(item);
        const sel = item.getSelectedAmmo?.();
        const ammoId = sel?.id ?? null;
        for (let i = 0; i < 99; i++) {
            if (item.getChamberRounds().length >= item.magazineCapacity) break;
            const fed = await item.feedMagazine(ammoId, { silent: i > 0 });
            if (!fed) break;
        }
    }

    /* Bomb Effects — first-class embedded ActiveEffects on the bomb
     * item. Runtime clones each onto failed defenders in bombs.mjs.
     * Application damage is stored per-effect at
     * flags[MODULE].bombRiderDamage (formula string). */

    /* Create a blank AE on the bomb, then open its config sheet for
     * full editing. Foundry's ActiveEffectConfig handles name / img /
     * duration / changes / statuses — no need for us to reimplement. */
    static async _onAddBombEffect(event, target) {
        if (!this.isEditable) return;
        const [ae] = await this.item.createEmbeddedDocuments("ActiveEffect", [{
            name: game.i18n.localize("WITCHER.Sheet.Weapon.Bomb.Text.NewEffect") || "New Effect",
            img:  "icons/svg/aura.svg",
            disabled: false,
            transfer: false,           /* riders don't transfer to the wielder */
            flags: { "witcher-ttrpg-death-march": { bombRider: true, bombRiderDamage: "" } }
        }]);
        if (ae?.sheet) ae.sheet.render(true);
    }

    /* Pick a status from CONFIG.statusEffects and create an AE stamped
     * with that status id. Uses a native <select> in a Foundry dialog
     * so peer modules that register custom statuses just appear here. */
    static async _onAddBombStatus(event, target) {
        if (!this.isEditable) return;
        const statuses = (CONFIG.statusEffects ?? []).slice().sort((a, b) => {
            const la = game.i18n.localize(a?.label ?? a?.name ?? a?.id ?? "");
            const lb = game.i18n.localize(b?.label ?? b?.name ?? b?.id ?? "");
            return la.localeCompare(lb);
        });
        if (!statuses.length) {
            ui.notifications?.warn("No status effects registered.");
            return;
        }
        const options = statuses.map(s => {
            const label = game.i18n.localize(s?.label ?? s?.name ?? s?.id ?? "");
            return `<option value="${s.id}">${label}</option>`;
        }).join("");
        const html = `<div class="form-group">
            <label>${game.i18n.localize("WITCHER.Sheet.Weapon.Bomb.Text.PickStatus") || "Pick a status effect"}</label>
            <select name="statusId">${options}</select>
        </div>`;
        const DialogV2 = foundry.applications?.api?.DialogV2 ?? Dialog;
        const picked = await new Promise((resolve) => {
            if (DialogV2 === Dialog) {
                new Dialog({
                    title: game.i18n.localize("WITCHER.Sheet.Weapon.Bomb.Text.AddStatus") || "Add Status",
                    content: html,
                    buttons: {
                        ok:     { label: "OK",     callback: (h) => resolve(h[0].querySelector('select[name="statusId"]').value) },
                        cancel: { label: "Cancel", callback: () => resolve(null) }
                    },
                    default: "ok",
                    close: () => resolve(null)
                }).render(true);
            } else {
                DialogV2.prompt({
                    window:  { title: game.i18n.localize("WITCHER.Sheet.Weapon.Bomb.Text.AddStatus") || "Add Status" },
                    content: html,
                    ok:      { callback: (event, button) => button.form.elements.statusId.value }
                }).then(resolve).catch(() => resolve(null));
            }
        });
        if (!picked) return;
        const def = statuses.find(s => s.id === picked);
        if (!def) return;
        const [ae] = await this.item.createEmbeddedDocuments("ActiveEffect", [{
            name:     game.i18n.localize(def.label ?? def.name ?? def.id),
            img:      def.img ?? def.icon ?? "icons/svg/aura.svg",
            disabled: false,
            transfer: false,
            statuses: [def.id],
            flags:    { "witcher-ttrpg-death-march": { bombRider: true, bombRiderDamage: "" } }
        }]);
        if (ae?.sheet) ae.sheet.render(true);
    }

    static async _onEditBombEffect(event, target) {
        if (!this.isEditable) return;
        const id = target.closest("[data-effect-id]")?.dataset.effectId;
        const ae = id ? this.item.effects.get(id) : null;
        if (ae?.sheet) ae.sheet.render(true);
    }

    static async _onDeleteBombEffect(event, target) {
        if (!this.isEditable) return;
        const id = target.closest("[data-effect-id]")?.dataset.effectId;
        if (!id) return;
        await this.item.deleteEmbeddedDocuments("ActiveEffect", [id]);
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
        const rawCatalog = cfg.getActiveWeaponQualities() ?? {};
        const defaults = cfg.WEAPON_QUALITIES;
        // Cross-source the values: prepared (post-defaults) usually wins;
        // toObject() source is the belt-and-suspenders when the prepared
        // path has been stripped or hasn't been initialized yet.
        const values  = this.item.system?.qualityValues
                     ?? this.item.toObject?.().system?.qualityValues
                     ?? {};
        /* Silver is a normal, pickable weapon quality (valueless — it just
         * stamps damageFlags.isSilver; no separate silver dice). It replaces
         * the old Silver Weapon Trait checkbox. The `silverTrait` boolean is
         * still honoured on weapons that set it before the switch (see the
         * synthetic chip below + the isSilver derivation in socketHook), so
         * nothing breaks — but there's no toggle in the sheet anymore. */
        ctx.newSilverRules = hrNewSilverRules();
        /* Ranged-only qualities (e.g. Repeating) are hidden from the picker on
         * non-ranged weapons — they'd never take effect off a fired weapon. */
        const isRangedWeapon = this.item.system?.weaponType === "ranged";
        const catalog = Object.fromEntries(Object.entries(rawCatalog).filter(([k]) =>
            (isRangedWeapon || !cfg.isRangedOnlyQuality?.(k))
        ));
        ctx.weaponQualitiesCatalog = catalog;
        /* Open-category qualities (the four EO "per-weapon authored
         * bonus" entries) get a sliders affordance on their display
         * chip — so a GM viewing a weapon doesn't need to flip into
         * config mode to discover the structured-bonus editor. The
         * template reads `isOpenCategory` to decide whether to render
         * the button. */
        const OPEN_CATEGORY_KEYS = new Set(["twoHand", "closeQuarters", "throwing", "strangling"]);
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
                return {
                    key, label, description: entry.description,
                    isOpenCategory: OPEN_CATEGORY_KEYS.has(key),
                    /* Honest UI hint: the chip carries a small marker
                     * when the engine has no automatic consumer for
                     * this quality. Set on the catalog entry's `extra`
                     * for qualities like Concealment / Crew Reload /
                     * Mounted (the catalog description's parenthetical
                     * "(GM-resolved...)" spells out why). */
                    displayOnly: !!entry.displayOnly
                };
            })
            .filter(Boolean);

        /* The Silver Weapon Trait is stored as a boolean, not a quality key,
         * so it wouldn't otherwise show among the quality chips. Surface it as
         * a synthetic "Silver" chip (first, so it reads at a glance) — this is
         * the user-facing indicator that the weapon counts as silver. */
        if (this.item.system?.silverTrait) {
            ctx.weaponQualityList.unshift({
                key: "silverTrait",
                label: t("WITCHER.Sheet.Weapon.Text.Silver", "Silver"),
                description: t("WITCHER.Sheet.Weapon.Tooltip.SilverTrait",
                    "Marks the weapon as silver: silver-weak monsters take full damage; every other target takes half."),
                isOpenCategory: false,
                displayOnly: false,
                isSilver: true
            });
        }

        // Socketed enhancements + effective (enhanced) stats. The base
        // slot count comes from the authored `weaponEnhancement`; the
        // Meteorite quality (and any GM-flagged `meteoriteExtraEnchantSlot`
        // quality) grants +1, capped at 3 per EO p.7. The bonus is
        // exposed on the derived `effective.bonusSlots` field.
        const baseSlots = Number(this.item.system?.weaponEnhancement) || 0;
        const bonusSlots = Number(this.item.system?.effective?.bonusSlots) || 0;
        const slotCount = baseSlots + bonusSlots;
        ctx.enhancementSlots = buildEnhancementSlots(this.item, slotCount);
        ctx.effective = this.item.system?.effective ?? null;
        ctx.isEnhanced = !!ctx.effective?.modified;
        /* Combat Extended toggle — the weapon-sheet display view surfaces
         * Range for MELEE weapons only when CE is on (EO gives most
         * one-handed melee weapons a throwable Range field). Safe read:
         * the settings map may not be ready during early renders, so
         * catch and default to false. */
        try {
            const mod = await import("../../api/homebrew.mjs");
            ctx.ceOn = mod.isCombatExtendedEnabled?.() === true;
        } catch (_) { ctx.ceOn = false; }
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
                return { key, label, description: entry.description, displayOnly: !!entry.displayOnly };
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
            const chamberRounds  = this.item.getChamberRounds();
            const loadedCount    = chamberRounds.length;
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
                /* Magazine model (CE, capacity 2+): loading the magazine and
                 * cocking are separate. `canFeed` gates the ＋ control (room
                 * left); `isArmed` reflects whether it's cocked; the Reload
                 * button becomes state-aware "Cock / Load & Cock / Loaded". */
                usesMagazine:   this.item.usesMagazine,
                isRepeating:    this.item.isRepeating,
                isArmed:        this.item.isArmed,
                canFeed:        this.item.usesMagazine && loadedCount < loadedCapacity,
                canCock:        this.item.usesMagazine && !this.item.isArmed && (loadedCount > 0 || eligible.length > 0),
                /* Fill is the free out-of-combat top-up; in combat each bolt
                 * costs an action so only single-feed is offered. */
                notInCombat:    !this.item.actor?._inActiveCombat,
                loadedName:     loadedCount > 0 ? (this.item.system?.loaded?.name ?? "") : "",
                loadedOilName:  (loadedCount > 0 && this.item.system?.loaded?.appliedOil?.name)
                                    ? String(this.item.system.loaded.appliedOil.name).trim()
                                    : "",
                /* Every chambered round, in FIRE order (FILO — next to fire
                 * first). Each carries its own type + oil. `next` marks the
                 * round that will loose on the next shot. */
                chamber:        chamberRounds.slice().reverse().map((r, i) => ({
                    pos:     i + 1,
                    name:    r.name || "",
                    img:     r.img  || "",
                    oilName: (r.appliedOil?.name && String(r.appliedOil.name).trim())
                                 ? String(r.appliedOil.name).trim() : "",
                    next:    i === 0
                })),
                ammoTypeLabel:  game.i18n.localize(cfg.AMMO_TYPES?.[this.item.ammoType] ?? ""),
                hasAmmo:        eligible.length > 0,
                eligible:       eligible.map(e => ({
                    id:        e.item.id,
                    name:      e.item.name,
                    qty:       e.qty,
                    /* container is null for LOOSE ammo (out-of-combat
                     * loose-bolt eligibility, added 2026-07-02). Falling
                     * back to a bare label instead of throwing on
                     * e.container.name — the previous access threw
                     * `Cannot read properties of null`, which crashed
                     * the whole item sheet render + wrecked the
                     * right-click ContextMenu wiring. */
                    container: e.container?.name ?? t("WITCHER.Sheet.Item.Base.Text.Loose", "Loose"),
                    selected:  selected ? e.item.id === selected.id : false,
                    oilName:   (e.item?.system?.appliedOil?.name)
                                   ? String(e.item.system.appliedOil.name).trim() : ""
                }))
            };
        }

        /* Bomb effects — one row per embedded AE with display-view
         * metadata (duration text, status chips, change chips) plus
         * the per-effect application-damage formula. Only computed
         * for bomb weapons; other weapon types skip this entirely. */
        if (this.item.system?.weaponType === "bomb") {
            ctx.bombEffects = (this.item.effects?.contents ?? []).map(ae => {
                const dur = ae.duration ?? {};
                let durationText = "";
                if      (Number(dur.rounds)  > 0) durationText = `${dur.rounds} r`;
                else if (Number(dur.turns)   > 0) durationText = `${dur.turns} turn`;
                else if (Number(dur.seconds) > 0) durationText = `${dur.seconds} s`;
                const statuses = Array.from(ae.statuses ?? []);
                const statusChips = statuses.map(id => {
                    const def = (CONFIG.statusEffects ?? []).find(s => s?.id === id);
                    return def ? game.i18n.localize(def.label ?? def.name ?? id) : id;
                });
                const changeChips = (ae.changes ?? []).slice(0, 3).map(ch => {
                    const key = String(ch?.key ?? "").split(".").pop() || "?";
                    return `${key} ${ch?.value ?? ""}`.trim();
                });
                return {
                    id:            ae.id,
                    name:          ae.name,
                    img:           ae.img ?? ae.icon ?? "icons/svg/aura.svg",
                    durationText,
                    statusChips,
                    changeChips,
                    appDamage:     String(ae.flags?.["witcher-ttrpg-death-march"]?.bombRiderDamage ?? ""),
                    appChance:     String(ae.flags?.["witcher-ttrpg-death-march"]?.bombRiderChance ?? "")
                };
            });
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

        /* Bomb effect app-damage + app-chance inputs — commit per-input
         * on change. Stored as flags on the AE so they survive the
         * effect's own form roundtrip and don't need schema fields. */
        if (this.isEditable && this.item.system?.weaponType === "bomb") {
            this.element.querySelectorAll("[data-bomb-app-damage]").forEach(inp => {
                inp.addEventListener("change", async ev => {
                    const id = ev.target.dataset.bombAppDamage;
                    if (!id) return;
                    const ae = this.item.effects.get(id);
                    if (!ae) return;
                    const raw = String(ev.target.value ?? "").trim();
                    await ae.update({ "flags.witcher-ttrpg-death-march.bombRiderDamage": raw });
                });
            });
            this.element.querySelectorAll("[data-bomb-app-chance]").forEach(inp => {
                inp.addEventListener("change", async ev => {
                    const id = ev.target.dataset.bombAppChance;
                    if (!id) return;
                    const ae = this.item.effects.get(id);
                    if (!ae) return;
                    /* Empty = auto-apply (100%). Otherwise clamp to 0-100. */
                    const raw = String(ev.target.value ?? "").trim();
                    const clean = raw === "" ? "" : String(Math.max(0, Math.min(100, Math.round(Number(raw) || 0))));
                    await ae.update({ "flags.witcher-ttrpg-death-march.bombRiderChance": clean });
                });
            });
        }
    }

    /* When "Requires Ammo" is checked the weapon's own damage types are
     * dictated by the loaded ammunition, so drop them — otherwise a stale
     * array lingers (the picker is no longer rendered to clear it from). */
    _prepareSubmitData(event, form, formData) {
        const data = super._prepareSubmitData(event, form, formData);
        if (!form) return data;
        const requiresAmmo = !!form.querySelector('input[name="system.requiresAmmo"]')?.checked;
        if (requiresAmmo) foundry.utils.setProperty(data, "system.damageTypes", []);

        /* The reliability MAX field shows the EFFECTIVE max (base + Meteorite /
         * rune bonuses) so the config reads e.g. 25/25 rather than 25/20. Store
         * the BASE the bonus folds onto by subtracting the current bonus — else
         * re-saving would compound it (25 → 30 → 35 …). Bonus is the current
         * effective − base; qualities in this same submit don't shift it enough
         * to matter for the round-trip. */
        const submittedMax = foundry.utils.getProperty(data, "system.reliability.max");
        if (submittedMax != null) {
            const effMax  = Number(this.item.system?.effective?.reliabilityMax) || 0;
            const baseMax = Number(this.item._source?.system?.reliability?.max) || 0;
            const bonus   = Math.max(0, effMax - baseMax);
            if (bonus > 0) {
                foundry.utils.setProperty(data, "system.reliability.max", Math.max(0, Number(submittedMax) - bonus));
            }
        }
        return data;
    }
}
export class WitcherAmmoSheet extends WitcherItemSheet {
    static PARTS = partsFor("ammo");

    /* Ammo shares the weapon quality catalog (Armor-Piercing, etc.) but
     * filtered to projectile-relevant entries — status riders + damage
     * flags only. Wield/reach/skill qualities (Two-Hand, Long Reach,
     * Brawling, …) are weapon-only and would never fire on a shot. */
    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        const cfg = await import("../../setup/config.mjs");
        const fullCatalog = cfg.getActiveWeaponQualities() ?? {};
        const ammoCatalog = cfg.filterAmmoQualities(fullCatalog);
        /* Silver is a normal, pickable quality on ammo too (valueless — just
         * stamps isSilver, no dice), so a player can silver-tip a batch of
         * arrows/bolts. Same as the weapon sheet: no longer filtered out.
         * getActiveWeaponQualities already strips the retired value param, and
         * the shot's merged weapon+ammo qualities carry isSilver into the
         * damage pipeline (see shotQualityRiders). */
        ctx.newSilverRules = hrNewSilverRules();
        const catalog = ammoCatalog;
        /* `defaults` stays UNFILTERED — it's the fallback for resolving
         * an entry on an item that already has a quality saved from
         * before the filter existed (legacy data). The filtered catalog
         * controls only the editable checkbox grid below. */
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
                return { key, label, description: entry.description, displayOnly: !!entry.displayOnly };
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
        const fullCatalog = cfg.getActiveArmorQualities?.() ?? cfg.ARMOR_QUALITIES ?? {};
        /* Armor pieces (helm/torso/limbs) don't see shield-only qualities
         * (Sturdy shield / Parrying shield / Deployable / Blade Catcher /
         * Archery Shield / Very Sturdy / deprecated Full Cover). */
        const catalog  = cfg.filterArmorPieceQualities(fullCatalog);
        const defaults = cfg.ARMOR_QUALITIES ?? {};  // unfiltered fallback for legacy saved keys
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
                return { key, label, description: entry.description, displayOnly: !!entry.displayOnly };
            })
            .filter(Boolean);

        // Per-location SP — six locations, each has value/max. For display
        // we omit any location where max is 0 (the piece doesn't cover
        // it). For config we always show all six so the user can fill in
        // any combination — head-only helmets through full plate.
        const src = ctx.source ?? this.item.toObject().system;
        const LOC_LABELS = {
            head: t("WITCHER.Sheet.Item.Base.Dialog.Button.Head", "Head"), torso: t("WITCHER.Common.Torso", "Torso"),
            leftArm: t("WITCHER.Sheet.Item.Base.Dialog.Button.LeftArm", "Left Arm"), rightArm: t("WITCHER.Sheet.Item.Base.Dialog.Button.RightArm", "Right Arm"),
            leftLeg: t("WITCHER.Sheet.Item.Base.Dialog.Button.LeftLeg", "Left Leg"), rightLeg: t("WITCHER.Sheet.Item.Base.Dialog.Button.RightLeg", "Right Leg")
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
        // Coverage map: shared constant from config.mjs. RAW Core: "torso"
        // includes arms; "arms" / "legs" are standalone arm- or leg-only
        // pieces (bracers, greaves). Single source of truth keeps the
        // sheet form, the inventory display, and the combat derivation
        // in lockstep.
        const activeKeys = ARMOR_LOCATION_COVERAGE[src?.location]
            ?? [src?.location].filter(k => LOC_KEYS.includes(k));
        ctx.spInputs = activeKeys.map(buildRow);
        /* AE slot count — single total. EO models AE as a piece-wide
         * budget the player allocates across body zones at attach time
         * (EO p.4). One input drives the total capacity; the per-zone
         * cards render on the display view and route drops against
         * this budget. */
        ctx.aeSlotInputs = [{
            key:   "total",
            label: t("WITCHER.Sheet.Item.Base.Dialog.Button.AeSlots", "AE slots (total)"),
            name:  "system.aeSlots",
            value: Number(src?.aeSlots) || 0
        }];

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
            /* Per-location SP. Each covered location has its OWN value
             * (so a hauberk can be 10 torso / 5 arms), and the hero
             * number shows the best-protected covered slot. Coverage is
             * gated by the `location` enum — same map deriveArmorEffective
             * uses — so a Torso piece never displays arm SP rows even if
             * a stale leftArmStopping value sits in the document. */
            // Same shared coverage map as the SP-input filter above —
            // hero + per-location rows derive from it.
            const coveredKeys = ARMOR_LOCATION_COVERAGE[src?.location]
                ?? [src?.location].filter(k => LOC_KEYS.includes(k));
            const coveredRows = coveredKeys.map(buildRow);
            const sorted = [...coveredRows].sort((a, b) => b.value - a.value);
            ctx.primarySP    = sorted[0]?.value ?? 0;
            ctx.primarySPMax = sorted[0]?.max   ?? 0;
            ctx.primaryStatLabel = "STOPPING POWER";
            ctx.coverageLabel = coveredRows.map(r => r.label).join(" · ");
            ctx.multiLocation = coveredRows.length > 1;
            ctx.spLocations   = coveredRows.map(r => ({
                label: r.label,
                value: r.value,
                max:   r.max
            }));
        }
        ctx.isShield  = isShield;
        /* Clothes is a lightweight armor subtype: no SP, no EV, no
         * enhancement/AE slots, no damage-resistance toggles, no
         * qualities. It occupies an armor slot (blocks layering) and
         * carries whatever ActiveEffects the author drops onto it —
         * those apply only while equipped (WitcherActiveEffect.isSuppressed
         * gates on parent armor.equipped). The config view collapses to
         * name / type / location / procurement / effects / description. */
        ctx.isClothes = src?.armorType === "clothes";

        /* Socketed enhancements. Under EO, render distinct per-pool
         * strips (one per covered AE location + one glyph strip) so
         * the player can see which pool each slot belongs to and the
         * drop target is unambiguous. Under RAW, fall back to the
         * legacy single-strip view sized by `armorEnhancement`. */
        const _eoMod = await import("../../mechanics/eoArmorModel.mjs");
        ctx.eoArmorModelOn = _eoMod.isEoArmorModelOn();
        if (ctx.eoArmorModelOn) {
            ctx.enhancementSlotGroups = buildEnhancementSlotGroups(this.item);
            /* Keep a flat slots list around too — some legacy code paths
             * (and the test scaffolding) still read it. */
            ctx.enhancementSlots = ctx.enhancementSlotGroups
                .flatMap(g => g.slots.filter(s => s.filled));
        } else {
            const slotCount = Number(src?.armorEnhancement) || 0;
            ctx.enhancementSlots      = buildEnhancementSlots(this.item, slotCount);
            ctx.enhancementSlotGroups = null;
        }
        const eff = this.item.system?.effective ?? null;
        ctx.effective  = eff;
        ctx.isEnhanced = !!eff?.modified;
        ctx.bonusSP    = Number(eff?.bonusSP) || 0;
        // Resistances added by enhancements (not already on the base armor).
        const addedRes = [];
        if (eff?.slashing    && !src?.slashing)    addedRes.push(t("WITCHER.Sheet.Item.Base.Text.Slashing",   "Slashing"));
        if (eff?.piercing    && !src?.piercing)    addedRes.push(t("WITCHER.Sheet.Item.Base.Text.Piercing",   "Piercing"));
        if (eff?.bludgeoning && !src?.bludgeoning) addedRes.push(t("WITCHER.Sheet.Item.Base.Text.Bludgeoning","Bludgeoning"));
        if (eff?.fire        && !src?.fire)        addedRes.push(t("WITCHER.Damage.Fire",      "Fire"));
        if (eff?.lightning   && !src?.lightning)   addedRes.push(t("WITCHER.Damage.Lightning", "Lightning"));
        if (eff?.cold        && !src?.cold)        addedRes.push(t("WITCHER.Damage.Cold",      "Cold"));
        if (eff?.acid        && !src?.acid)        addedRes.push(t("WITCHER.Damage.Acid",      "Acid"));
        ctx.addedResistances = addedRes;
        /* Elemental-only subset — shown under the EO armor model, where the
         * per-zone chips cover the physical three but not elementals (and
         * glyphs are piece-wide, so a piece-wide "(enhanced)" line is right). */
        ctx.addedElementalResistances = addedRes.filter(label =>
            [t("WITCHER.Damage.Fire","Fire"), t("WITCHER.Damage.Lightning","Lightning"),
             t("WITCHER.Damage.Cold","Cold"), t("WITCHER.Damage.Acid","Acid")].includes(label));
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
                return { key, label, description: entry.description, displayOnly: !!entry.displayOnly };
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
     * and AE slots reuse the armor catalog + slot helpers, but the
     * visible catalog is filtered to SHIELD-only entries (Sturdy shield,
     * Parrying shield, Deployable, Blade Catcher, Archery Shield, Very
     * Sturdy, deprecated Full Cover). Armor-piece entries (vision/SP/
     * encumbrance/critical) don't apply to a shield. */
    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        const cfg = await import("../../setup/config.mjs");
        const fullCatalog = cfg.getActiveArmorQualities?.() ?? cfg.ARMOR_QUALITIES ?? {};
        const catalog  = cfg.filterShieldQualities(fullCatalog);
        const defaults = cfg.ARMOR_QUALITIES ?? {};  // unfiltered fallback for legacy saved keys
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
                return { key, label, description: entry.description, displayOnly: !!entry.displayOnly };
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

        /* AE socketing — same slot UI armor uses (host type "armor").
         * Shields are not Difficult and aren't split per-location under
         * EO — the EO p.4 "AE per location" applies to armor pieces, not
         * shields. We keep the single-bucket model for shields. */
        const slotCount = Number(src?.armorEnhancement) || 0;
        ctx.enhancementSlots = buildEnhancementSlots(this.item, slotCount);
        return ctx;
    }
}
export class WitcherAlchemicalSheet extends WitcherItemSheet {
    static PARTS = partsFor("alchemical");

    /* Always-visible "Use" button on the sheet header (player-flow
     * audit #2). The chrome inventory + Items sidebar already
     * register a context-menu Consume entry, but the alchemical
     * sheet itself had no direct affordance — a GM viewing a
     * decoction had View+Delete only. Click → consumeItem applies
     * the embedded AE to the carrying actor (or the assigned PC if
     * the item is unowned). */
    static DEFAULT_OPTIONS = {
        actions: { use: WitcherAlchemicalSheet._onUse }
    };

    static async _onUse(_event, _target) {
        const item = this.item;
        if (!item) return;
        const actor = item.actor;
        if (!actor) {
            ui.notifications?.warn(tFormat("WITCHER.Notify.Item.NeedCharacter", { item: item.name }, "{item}: drag this onto a character first, or assign a default character to your user."));
            return;
        }
        try {
            const { consumeItem } = await import("../../chrome/policy/consume-item.js");
            await consumeItem(item, actor);
        } catch (err) {
            console.warn("witcher-ttrpg-death-march | consume failed", err);
            ui.notifications?.error(tFormat("WITCHER.Notify.Item.ConsumeFailed", { item: item.name }, "Failed to consume {item}."));
        }
    }

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
        ctx.isOil        = type === "oil";
        // Toxicity is only meaningful for potions and decoctions (they add
        // to the Toxicity pool when consumed, Core p.84). Poisons, oils,
        // bombs, etc. don't carry a toxicity figure.
        ctx.hasToxicity  = type === "potion" || type === "decoction";
        // Potions, decoctions and alchemical items can be marked
        // consumable (used = spend a dose + apply effects). Other alchemical
        // categories (oils, bombs) are applied differently, so no toggle.
        ctx.isConsumableType = type === "potion" || type === "decoction" || type === "item";
        ctx.typeLabel    = game.i18n.localize(CONFIG.WITCHER.alchemical.types[type] ?? type);

        // Alchemy Reborn toggle is needed BEFORE the hero math so oils
        // pick the right hero (charges under Reborn, duration under RAW).
        ctx.alchemyRebornOn = isHomebrewEnabled("alchemyPotency");
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
        } else if (ctx.isOil) {
            /* Oils: Reborn swaps the hero to charges; RAW shows the
             * structured oilDuration (value + units). The free-text
             * sys.duration is ignored for oils.
             *
             * Charges display: prefer `currentCharges` (running count on
             * a partially-spent bottle — the ammo-coat flow decrements
             * this per coating). Fresh bottles have currentCharges=0
             * and fall back to the authored `oilCharges` total. Without
             * this, a bottle used to coat 2 arrows would still read
             * "5 CHARGES" on its sheet even though only 3 remain. */
            if (ctx.alchemyRebornOn) {
                const cur = Number(src?.currentCharges) || 0;
                const max = Number(src?.oilCharges) || 0;
                const charges = cur > 0 ? cur : max;
                ctx.heroValue = charges > 0 ? charges : "—";
                ctx.heroLabel = "CHARGES";
                ctx.heroSub   = "";
            } else {
                const dv = Number(src?.oilDuration?.value) || 0;
                const du = String(src?.oilDuration?.units || "");
                ctx.heroValue = dv > 0 ? `${dv} ${du}` : ctx.typeLabel;
                ctx.heroLabel = dv > 0 ? "DURATION" : "TYPE";
                ctx.heroSub   = "";
            }
        } else {
            ctx.heroValue = src?.duration || ctx.typeLabel;
            ctx.heroLabel = src?.duration ? "DURATION" : "TYPE";
            ctx.heroSub   = "";
        }
        // (ctx.alchemyRebornOn was set above so the oil hero could read it.)
        // Base summary for the display view — null when the item isn't a
        // configured brew base, otherwise { typeLabel, modSigned, summary }
        // so the W3 view can render "Potion / Decoction · -2 DC".
        ctx.baseSummary = ctx.alchemyRebornOn ? baseSummaryFor(this.item) : null;
        return ctx;
    }
}
/* Fields the canvas renders from. A change to any of them has to reach the
 * panel and the trigger lines, which are built during `_prepareContext`. */
const CANVAS_FIELDS = Object.freeze([
    "system.staminaCost", "system.variableCost", "system.range",
    "system.targetType", "system.areaShape", "system.areaSize",
    "system.areaExcludeCaster", "system.defense", "system.school",
    "system.duration", "system.spellForm", "system.spellType"
]);

export class WitcherSpellSheet extends WitcherItemSheet {
    static PARTS = partsFor("spell");

    /* Wider than every other item sheet, because this one has a different job.
     * An armour sheet is a form; a spell sheet is a workbench — palette, the
     * spell's own blocks, and the law it runs under, side by side. At 540px
     * those three columns are unusable, which is most of why the canvas looked
     * like an afterthought crammed into a corner. */
    // A spell effect is a reference template applied on a successful cast —
    // it must not auto-apply to the caster who owns the spell item.
    get effectsTransfer() { return false; }

    /* `addStatusRider` / `removeStatusRider` used to live here. They were the
     * old engine's way of saying "and it applies this condition on a hit",
     * which `core:applyStatus` now says with a block that can also be
     * conditional, timed, and removed. Two ways to say one thing is two
     * answers that drift, so there is one. */
    static DEFAULT_OPTIONS = {
        /* A starting size only — clamped to the screen below. */
        position: { width: 620, height: "auto" },
        actions: {
            removeComponent:   WitcherSpellSheet._onRemoveComponent,
            openComponent:     WitcherSpellSheet._onOpenComponent,
            addEntry:          WitcherSpellSheet._onAddEntry,
            startFromBook:     WitcherSpellSheet._onStartFromBook,
            clearSpellCanvas:  WitcherSpellSheet._onClearSpellCanvas
        }
    };

    /**
     * Size the window to the UI scale AND to the screen.
     *
     * This sheet is a workbench — palette, blocks, and the rules beside them —
     * so it needs width a plain item form does not. But the system multiplies
     * every `rem` by the user's scale knob, and a window with a FIXED pixel
     * width therefore gets more crowded the larger someone sets their UI:
     * contents grow, the frame does not, and the whole thing stops fitting.
     *
     * So the width follows the knob, and then both dimensions are clamped to
     * the viewport. A sheet that opens wider than the monitor is not a sheet.
     */
    _initializeApplicationOptions(options) {
        const opts = super._initializeApplicationOptions(options);
        const scale = Number.parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue("--wdm-scale")) || 1;

        /* The window does NOT grow with the knob.
         *
         * Making it grow was backwards: the complaint was that the editor took
         * up too much room, and scaling the frame up is the opposite of a fix.
         * The canvas is one column now — no permanent palette rail, no
         * permanent frame panel — so it fits a normal item-sheet width, and it
         * stays there at every scale. Only the clamp remains, for the case
         * where even this is wider than the screen. */
        opts.position = {
            ...opts.position,
            width: Math.round(Math.min(620, window.innerWidth * 0.9)),
            height: "auto"
        };
        void scale;   // read above only to keep the CSS anchor honest
        return opts;
    }

    /* ── The canvas, hosted by this sheet ──────────────────────────────────
     * `attachCanvas` wants a HOST that can read and write trees, show a
     * refusal, and ask for one argument. The sheet is that host. All four are
     * one-liners here because the interesting parts — legality, layout,
     * markup — are pure functions with their own tests. */
    get canvasHost() {
        const sheet = this;
        return {
            trees: () => sheet.item.system?.magic?.on ?? {},
            focus: () => sheet._canvasFocus ?? Object.keys(sheet.item.system?.magic?.on ?? {})[0] ?? "hit",
            async commit(entry, tree) {
                sheet._canvasRefusal = null;
                sheet._canvasFocus = entry;
                const { writeTree } = await import("../../magic/canvas/persist.mjs");
                await writeTree(sheet.item, entry, tree);
                return sheet.render({ force: false });
            },
            refuse(reason) {
                sheet._canvasRefusal = reason;
                return sheet.render({ force: false });
            },
            async append(blockId) {
                /* With no trigger yet, a click on the palette used to create
                 * "when it hits" in silence — a reasonable default, arrived at
                 * without asking and without saying. It still defaults, but it
                 * says which trigger the block went into. */
                const existing = Object.keys(sheet.item.system?.magic?.on ?? {});
                const implicit = !sheet._canvasFocus && !existing.length;
                const entry = this.focus();
                if (implicit) {
                    const { ENTRY_LABELS } = await import("../../magic/summary.mjs");
                    ui.notifications?.info(game.i18n.format(
                        "WITCHER.Sheet.Spell.Text.AddedToTrigger",
                        { trigger: ENTRY_LABELS[entry] ?? entry }));
                }
                const { newNode } = await import("../../magic/canvas/interactions.mjs");
                const { canDrop } = await import("../../magic/canvas/legality.mjs");
                const tree = this.trees()[entry] ?? [];
                const verdict = canDrop(tree, entry, [], tree.length, blockId);
                if (!verdict.ok) return this.refuse(verdict.reason);
                return this.commit(entry, [...tree, newNode(blockId)]);
            },
            async ask(spec, current, key) {
                const { promptForInput } = await import("../../magic/canvas/sheet.mjs");
                return promptForInput(spec, current, key);
            }
        };
    }

    async close(options) {
        this._detachCanvas?.();
        this._detachCanvas = null;
        return super.close(options);
    }

    /* Add a trigger. An entry point is not decoration — the same blocks under
     * "when it hits" and "when damage reaches you" are two different spells. */
    static async _onAddEntry(event, target) {
        /* `data-entry`, not `.value`.
         *
         * The trigger list is a row of BUTTONS carrying `data-entry="hit"` —
         * it stopped being a `<select>` when the bare dropdown was replaced
         * with named rows that say when each trigger fires. A button has no
         * `value`, so this read `undefined`, hit the guard below, and returned:
         * clicking a trigger did nothing at all, silently. */
        const entry = target?.dataset?.entry || target?.value || "";
        if (!entry) return;
        this._canvasFocus = entry;
        const { writeTree } = await import("../../magic/canvas/persist.mjs");
        await writeTree(this.item, entry, []);
        return this.render({ force: false });
    }

    /* Load the book's version as a STARTING POINT, then edit it like anything
     * else. The authored corpus is a library, not a lock — its whole purpose
     * was proving the block set can express the book, and a spell you cannot
     * then change is the hardwiring this engine replaced. */
    static async _onStartFromBook(event, target) {
        const { startFromBook } = await import("../../magic/canvas/sheet.mjs");
        const applied = await startFromBook(this.item);
        if (applied) { this._canvasFocus = null; this.render({ force: false }); }
    }

    /* Put the spell back on the original engine.
     *
     * The reason the two engines run side by side per item: rolling one spell
     * back is deleting its trees, not reverting a release. Confirmed because
     * it discards authored work, and scoped to `system.magic` so nothing else
     * on the item is touched. */
    static async _onClearSpellCanvas(event, target) {
        const ok = await foundry.applications.api.DialogV2.confirm({
            window: { title: this.item.name },
            content: `<p>${game.i18n.localize("WITCHER.Sheet.Spell.Text.ConfirmClearBehaviour")}</p>`
        });
        if (!ok) return;
        /* NOT `update({ "system.magic": { frame: {}, on: {} } })`. An
         * ObjectField update merges, so an empty object removes nothing —
         * Clear appeared to do nothing at all. Every dropped key has to be
         * named with Foundry's `-=` syntax. */
        const { clearAll } = await import("../../magic/canvas/persist.mjs");
        await clearAll(this.item);
        this._canvasFocus = null;
        this.render({ force: false });
    }

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

        /* WHICH ENGINE runs when this is cast — the question a GM opening a
         * spell actually has. Without it on screen the two paths look
         * identical, and a spell that quietly does nothing is
         * indistinguishable from one that quietly works. */
        ctx.authored = authoredSummary(this.item.system?.magic, this.item.name);

        /* The canvas, rendered INTO the config layer. Not a button that opens
         * a window — the config surface IS where a spell is programmed. */
        const canvasSheet = await import("../../magic/canvas/sheet.mjs");
        Object.assign(ctx, canvasSheet.canvasContext(this.item, {
            focus: this._canvasFocus,
            refusal: this._canvasRefusal
        }));
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
        ctx.staLabel = src?.variableCost ? t("WITCHER.Sheet.Item.Base.Text.Variable", "Variable") : String(Number(src?.staminaCost) || 0);
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
        /* Status riders and their STA-scaling ladders were the old engine's
         * way of saying "and it applies this condition on a hit". Blocks say
         * it now — `core:applyStatus`, which can also be conditional, timed,
         * and removed — so the rows, the ladder and the sub-panel that
         * rendered them are all gone together.
         *
         * They went in three places and I removed two: the template stopped
         * rendering them and the assignment stopped happening, but the loop
         * that walked them stayed, three lines further down, and every spell
         * sheet threw `ctx.statusRiderRows is not iterable` before it could
         * open. Deleting a thing means deleting everything that touches it. */
        /* Display-view labels for the new damage / area / status-rider
         * fields. Reads the enum labels from CONFIG.WITCHER.magic; skips
         * emitting anything when the field is at its "none" default so
         * the tooltip stays tight on non-damaging spells. */
        const dmgFormula = String(src?.damageFormula ?? "").trim();
        if (dmgFormula) {
            const el = String(src?.damageElement ?? "none");
            const ty = String(src?.damageType ?? "none");
            const elLabel = el === "none" ? "" : game.i18n.localize(M.damageElements?.[el] ?? el);
            const tyLabel = ty === "none" ? "" : game.i18n.localize(M.damageTypes?.[ty] ?? ty);
            const parts = [dmgFormula, elLabel, tyLabel].filter(Boolean);
            ctx.damageLabel = parts.join(" · ");
        } else {
            ctx.damageLabel = "";
        }
        const aShape = String(src?.areaShape ?? "none");
        if (aShape !== "none") {
            const size = Number(src?.areaSize) || 0;
            const shapeLabel = game.i18n.localize(M.areaShapes?.[aShape] ?? aShape);
            ctx.areaLabel = size > 0 ? `${size}m ${shapeLabel}` : shapeLabel;
        } else {
            ctx.areaLabel = "";
        }
        /* spellCfg — computed context for the collapsible config view.
         * Everything the template needs to (a) hide sections whose
         * enabling field is off, (b) populate dropdowns from live
         * registries, and (c) decide which collapsible sections default
         * to open. Kept as a single sub-object so the template's guards
         * stay tight ({{#if spellCfg.hasDamage}} etc.). */
        const hasDamage      = !!dmgFormula;
        /* Stamina scaling on riders is only meaningful when the caster
         * can VARY the stamina they spend — otherwise every cast uses
         * the same fixed cost and the scaling formula collapses to one
         * value. Gate the whole per-rider STA scaling panel on this so
         * authors of fixed-cost spells don't see irrelevant knobs, and
         * point them to the toggle when they try. */
        const variableCost   = !!src?.variableCost;
        /* Area section is only meaningful when Targeting is set to "area"
         * — Direct and Self spells don't project a template. Legacy items
         * with a stray `areaShape` set under non-area targeting still get
         * the section (so authors can zero it out or fix the mismatch)
         * via the second clause. */
        const targetIsArea   = String(src?.targetType ?? "") === "area";
        const legacyAreaMismatch = aShape !== "none" && !targetIsArea;
        const showArea       = targetIsArea || legacyAreaMismatch;
        const hasArea        = aShape !== "none";
        /* Riders are gone with the old behaviour config — `core:applyStatus`
         * says it better. Kept as a constant rather than deleted because it
         * feeds `isFresh` below, which decides which sections open on a spell
         * nobody has configured yet. */
        const hasRiders      = false;
        const hasComponents  = ctx.componentLinks.length > 0;
        const hasEffects     = ctx.effects.length > 0;
        const hasAuthoredAE  = !!src?.castsAuthoredAE;
        const hasHandler     = !!String(src?.mechanicHandler ?? "").trim();
        const isGift         = src?.spellForm === "gift";
        const hasDuration    = !(src?.duration?.unit === "instant" || src?.duration?.unit === "permanent");
        /* Handler dropdown — real registered ids from the runtime
         * registry. Falls back to `[""]` when the module hasn't loaded
         * axii/etc. yet (test / init edge). Authored value survives
         * even when not currently registered so authors can type an id
         * for a handler that's shipped by an extension module. */
        const handlerIds = listSpellHandlerIds();
        const currentHandler = String(src?.mechanicHandler ?? "");
        const handlerKnown   = handlerIds.includes(currentHandler);
        /* Status-effect options for the rider StatusId datalist —
         * Foundry rebuilds CONFIG.statusEffects at init from the system's
         * STATUS_EFFECTS array. Sort alphabetically by localized name so
         * the picker reads well. */
        const statusOptions = Array.isArray(CONFIG.statusEffects)
            ? CONFIG.statusEffects.map(s => ({
                id: s.id,
                label: game.i18n?.localize?.(s.name ?? s.label ?? s.id) ?? s.id
              })).sort((a, b) => a.label.localeCompare(b.label))
            : [];
        /* Lookup map so the rider template can detect a stored statusId
         * that isn't in the current registry (renamed / missing module)
         * and preserve it as a fallback option instead of silently
         * discarding the value. */
        const statusOptionsById = Object.fromEntries(
            statusOptions.map(o => [o.id, o.label])
        );
        /* Rider-mode friendly labels — swap the raw enum keys ("onHit",
         * "zone", "onTick") for prose the template surfaces alongside
         * the dropdown so authors don't need to memorize the tokens. */
        const riderModeHelp = {
            onHit:  t("WITCHER.Sheet.Spell.RiderMode.OnHitHelp",
                "Rolled once per target when the cast lands. Use for one-shot statuses (burning on Aenye, prone on Water Jet)."),
            zone:   t("WITCHER.Sheet.Spell.RiderMode.ZoneHelp",
                "Applied when a token ENTERS a persistent zone. Requires the Area/Zone section to be on with Persistent enabled."),
            onTick: t("WITCHER.Sheet.Spell.RiderMode.OnTickHelp",
                "Applied every round to tokens still inside the zone. Use for over-time drains (Blaze of Korath).")
        };
        /* STA-scaling target labels + one-liners — surfaced next to the
         * dropdown so authors pick the right routing. */
        const staScaleTargetHelp = {
            magnitude: t("WITCHER.Sheet.Spell.StaScaleTarget.MagnitudeHelp",
                "Sets how strong the status is when it applies — Yrden's REF/DEX penalty, Static Storm's damage tick."),
            endCheckModifier: t("WITCHER.Sheet.Spell.StaScaleTarget.EndCheckHelp",
                "Makes the target's save to shake off the status harder. This is the Axii pattern — the more stamina you pour in, the harder the target has to work to escape."),
            chance: t("WITCHER.Sheet.Spell.StaScaleTarget.ChanceHelp",
                "Bonus added to the rider's base chance %. Rider chance = floor at minimum stamina; scaling adds more likelihood as stamina grows. Final chance clamped to 0-100.")
        };
        /* Short labels for the same targets — used by the live ladder
         * preview so authors see "→ Save penalty" instead of the full
         * paragraph. */
        const staScaleTargetLabel = {
            magnitude:        t("WITCHER.Sheet.Spell.StaScaleTarget.MagnitudeShort",        "Effect strength"),
            endCheckModifier: t("WITCHER.Sheet.Spell.StaScaleTarget.EndCheckModifierShort", "Save penalty"),
            chance:           t("WITCHER.Sheet.Spell.StaScaleTarget.ChanceShort",           "Chance to apply (%)")
        };
        /* Sections default-open when they carry authored data OR when
         * the item is fresh (all-defaults) so a new spell shows the
         * essential sections without the user hunting for chevrons. */
        const isFresh = !hasDamage && !hasArea && !hasRiders && !hasComponents
            && !hasEffects && !src?.effect && !hasHandler;
        ctx.spellCfg = {
            /* Behavior-family enable flags — a section opens itself if
             * its enabling field is populated, or stays open once the
             * author opens it (native <details> preserves user state). */
            hasDamage, hasArea, hasRiders, hasComponents, hasEffects,
            hasAuthoredAE, hasHandler, isGift, hasDuration, variableCost,
            /* Which sections start open on a fresh item: essentials
             * only. Populated items open the sections carrying data. */
            openIdentity:  true,
            openDefense:   true,
            openDuration:  hasDuration || isFresh,
            /* Always open — the damage sub-fields (element/type/tangible)
             * are now visible without gating on hasDamage, and every input
             * change triggers a re-render. Recomputing openDamage from
             * hasDamage each render would collapse the section the moment
             * the user cleared the formula. */
            openDamage:    true,
            showArea,
            legacyAreaMismatch,
            openArea:      hasArea || legacyAreaMismatch,
            openRiders:    hasRiders,
            openEffect:    !!src?.effect || isFresh,
            openComponents:hasComponents,
            openAdvanced:  hasHandler || hasAuthoredAE || hasEffects,
            /* Registry / catalog fills. */
            handlerIds,
            currentHandler,
            handlerKnown,
            statusOptions,
            statusOptionsById,
            riderModeHelp,
            staScaleTargetHelp,
            staScaleTargetLabel
        };
        return ctx;
    }

    /**
     * Carry the editor's UI state across a re-render.
     *
     * Every edit writes to the document and rebuilds the DOM, so without this
     * the palette you are picking from snaps shut, the panel you opened folds,
     * the block list jumps to the top and the control you just changed loses
     * focus. Choosing three things in a row meant opening the same panel three
     * times.
     *
     * Foundry provides this pair for exactly that: read from the DOM that is
     * about to go, write to the one replacing it.
     */
    _preSyncPartState(partId, newElement, priorElement, state) {
        super._preSyncPartState?.(partId, newElement, priorElement, state);
        /* NEVER let this stop a render. Restoring which panels were open is a
         * convenience; a throw in here would abort the part swap and leave the
         * OLD dom on screen — so a stale panel would be the visible symptom of
         * a bug in the code that exists to keep panels tidy. */
        try { state.witcherCanvas = captureUI(priorElement); }
        catch (err) { console.warn("witcher | could not capture canvas state", err); }
    }

    _syncPartState(partId, newElement, priorElement, state) {
        super._syncPartState?.(partId, newElement, priorElement, state);
        try { restoreUI(newElement, state.witcherCanvas); }
        catch (err) { console.warn("witcher | could not restore canvas state", err); }
    }

    /**
     * Re-render when a field the CANVAS displays changes.
     *
     * The canvas is built in `_prepareContext`, so it only reflects a change
     * once the sheet renders again. Foundry re-renders on a document update,
     * but the law panel's controls are injected as raw markup rather than
     * declared parts — so anything that swallows the update leaves the shape
     * and size controls of a targeting mode you have just left behind, and the
     * trigger line still describing the old reach.
     *
     * Asking for the render explicitly costs one extra pass and removes the
     * whole class of "it looks right but hasn't changed".
     */
    async _onChangeForm(formConfig, event) {
        await super._onChangeForm(formConfig, event);
        const name = event?.target?.getAttribute?.("name") ?? "";
        if (!CANVAS_FIELDS.some(f => name === f || name.startsWith(`${f}.`))) return;
        this.render({ force: false });
    }

    async _onRender(context, options) {
        await super._onRender(context, options);
        wireComponentDrop(this);

        /* Wire the canvas. This class ALREADY had an `_onRender`, and adding a
         * second one silently did nothing — a later definition of the same
         * method simply wins, with no error and no warning. The canvas
         * rendered and refused to be dragged, which is the least debuggable
         * possible failure. */
        const { attachCanvas } = await import("../../magic/canvas/interactions.mjs");
        this._detachCanvas?.();
        this._detachCanvas = attachCanvas(this.element, this.canvasHost);
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
            openComponent:     WitcherHexSheet._onOpenComponent,
            addStatusRider:    WitcherHexSheet._onAddStatusRider,
            removeStatusRider: WitcherHexSheet._onRemoveStatusRider
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

    static async _onAddStatusRider(event, target) {
        if (!this.isEditable) return;
        if (await addStatusRider(this.item)) this.render({ force: false });
    }

    static async _onRemoveStatusRider(event, target) {
        if (!this.isEditable) return;
        const idx = Number(target.closest("[data-status-rider-index]")?.dataset.statusRiderIndex);
        if (await removeStatusRider(this.item, idx)) this.render({ force: false });
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
        ctx.statusRiderRows = buildStatusRiderRows(this.item);
        /* Display-view labels for damage + area, same shape as spells.
         * Reads CONFIG.WITCHER.hex.* (which re-exports the shared magic
         * enums). Most RAW hexes have no damage; the labels stay empty. */
        const HM = CONFIG.WITCHER?.hex ?? {};
        const dmgFormula = String(src?.damageFormula ?? "").trim();
        if (dmgFormula) {
            const el = String(src?.damageElement ?? "none");
            const ty = String(src?.damageType ?? "none");
            const elLabel = el === "none" ? "" : game.i18n.localize(HM.damageElements?.[el] ?? el);
            const tyLabel = ty === "none" ? "" : game.i18n.localize(HM.damageTypes?.[ty] ?? ty);
            ctx.damageLabel = [dmgFormula, elLabel, tyLabel].filter(Boolean).join(" · ");
        } else {
            ctx.damageLabel = "";
        }
        const aShape = String(src?.areaShape ?? "none");
        if (aShape !== "none") {
            const size = Number(src?.areaSize) || 0;
            const shapeLabel = game.i18n.localize(HM.areaShapes?.[aShape] ?? aShape);
            ctx.areaLabel = size > 0 ? `${size}m ${shapeLabel}` : shapeLabel;
        } else {
            ctx.areaLabel = "";
        }
        return ctx;
    }

    /**
     * Carry the editor's UI state across a re-render.
     *
     * Every edit writes to the document and rebuilds the DOM, so without this
     * the palette you are picking from snaps shut, the panel you opened folds,
     * the block list jumps to the top and the control you just changed loses
     * focus. Choosing three things in a row meant opening the same panel three
     * times.
     *
     * Foundry provides this pair for exactly that: read from the DOM that is
     * about to go, write to the one replacing it.
     */
    _preSyncPartState(partId, newElement, priorElement, state) {
        super._preSyncPartState?.(partId, newElement, priorElement, state);
        /* NEVER let this stop a render. Restoring which panels were open is a
         * convenience; a throw in here would abort the part swap and leave the
         * OLD dom on screen — so a stale panel would be the visible symptom of
         * a bug in the code that exists to keep panels tidy. */
        try { state.witcherCanvas = captureUI(priorElement); }
        catch (err) { console.warn("witcher | could not capture canvas state", err); }
    }

    _syncPartState(partId, newElement, priorElement, state) {
        super._syncPartState?.(partId, newElement, priorElement, state);
        try { restoreUI(newElement, state.witcherCanvas); }
        catch (err) { console.warn("witcher | could not restore canvas state", err); }
    }

    /**
     * Re-render when a field the CANVAS displays changes.
     *
     * The canvas is built in `_prepareContext`, so it only reflects a change
     * once the sheet renders again. Foundry re-renders on a document update,
     * but the law panel's controls are injected as raw markup rather than
     * declared parts — so anything that swallows the update leaves the shape
     * and size controls of a targeting mode you have just left behind, and the
     * trigger line still describing the old reach.
     *
     * Asking for the render explicitly costs one extra pass and removes the
     * whole class of "it looks right but hasn't changed".
     */
    async _onChangeForm(formConfig, event) {
        await super._onChangeForm(formConfig, event);
        const name = event?.target?.getAttribute?.("name") ?? "";
        if (!CANVAS_FIELDS.some(f => name === f || name.startsWith(`${f}.`))) return;
        this.render({ force: false });
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
        ctx.dcLabel = src?.variableDC ? t("WITCHER.Sheet.Item.Base.Text.Variable", "Variable") : String(Number(src?.difficulty) || 0);
        ctx.componentLinks = buildComponentLinks(this.item);
        return ctx;
    }

    /**
     * Carry the editor's UI state across a re-render.
     *
     * Every edit writes to the document and rebuilds the DOM, so without this
     * the palette you are picking from snaps shut, the panel you opened folds,
     * the block list jumps to the top and the control you just changed loses
     * focus. Choosing three things in a row meant opening the same panel three
     * times.
     *
     * Foundry provides this pair for exactly that: read from the DOM that is
     * about to go, write to the one replacing it.
     */
    _preSyncPartState(partId, newElement, priorElement, state) {
        super._preSyncPartState?.(partId, newElement, priorElement, state);
        /* NEVER let this stop a render. Restoring which panels were open is a
         * convenience; a throw in here would abort the part swap and leave the
         * OLD dom on screen — so a stale panel would be the visible symptom of
         * a bug in the code that exists to keep panels tidy. */
        try { state.witcherCanvas = captureUI(priorElement); }
        catch (err) { console.warn("witcher | could not capture canvas state", err); }
    }

    _syncPartState(partId, newElement, priorElement, state) {
        super._syncPartState?.(partId, newElement, priorElement, state);
        try { restoreUI(newElement, state.witcherCanvas); }
        catch (err) { console.warn("witcher | could not restore canvas state", err); }
    }

    /**
     * Re-render when a field the CANVAS displays changes.
     *
     * The canvas is built in `_prepareContext`, so it only reflects a change
     * once the sheet renders again. Foundry re-renders on a document update,
     * but the law panel's controls are injected as raw markup rather than
     * declared parts — so anything that swallows the update leaves the shape
     * and size controls of a targeting mode you have just left behind, and the
     * trigger line still describing the old reach.
     *
     * Asking for the render explicitly costs one extra pass and removes the
     * whole class of "it looks right but hasn't changed".
     */
    async _onChangeForm(formConfig, event) {
        await super._onChangeForm(formConfig, event);
        const name = event?.target?.getAttribute?.("name") ?? "";
        if (!CANVAS_FIELDS.some(f => name === f || name.startsWith(`${f}.`))) return;
        this.render({ force: false });
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
        // Alchemy Reborn: surface the toggle so the substance + potency
        // block on the mutagen sheet can hide when the homebrew is off.
        // Direct import path — game.system.api.homebrew is wired at the
        // `ready` hook, but a sheet can render before that (drag preview,
        // compendium browse) and the optional-chain access would return
        // undefined → toggle reads false even when it's actually on.
        // isHomebrewEnabled reads game.settings directly so it works at
        // any time after settings register (which is `init`).
        ctx.alchemyRebornOn = isHomebrewEnabled("alchemyPotency");
        // Substance hero on the display view — mirrors WitcherComponentSheet.
        // Reads the same multi-source priority chain the chrome wheel uses
        // (substanceType → substance → witcher-alchemy-craft flag) so
        // stock-pack mutagens with the flag-only substance also render the
        // hero. Potency line shown when the toggle is on AND the value is
        // non-zero (a 0-potency mutagen contributes nothing to a brew).
        const src = ctx.source ?? this.item.toObject().system;
        const subs = CONFIG.WITCHER?.alchemical?.substances ?? {};
        const art  = CONFIG.WITCHER?.alchemical?.substanceArt ?? {};
        const subKey = String(src?.substanceType
                           || src?.substance
                           || this.item.flags?.["witcher-alchemy-craft"]?.substance
                           || "").trim().toLowerCase();
        ctx.hasSubstance = ctx.alchemyRebornOn && !!subKey;
        if (ctx.hasSubstance) {
            ctx.substanceKey  = subKey;
            ctx.substanceName = game.i18n.localize(subs[subKey] ?? subKey);
            ctx.substanceArt  = art[subKey] ?? "";
        }
        ctx.showPotency = ctx.alchemyRebornOn && (Number(src?.potency) || 0) > 0;
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
        // t("WITCHER.Sheet.Item.Base.Dialog.Button.NA", "N/A") (and the chrome treats it as non-rollable).
        const statOpts = (chosen) => [
            { key: "", label: t("WITCHER.Sheet.Item.Base.Dialog.Button.NA", "N/A"), selected: !chosen },
            ...W.stats.map(k => ({
                key:      k,
                label:    game.i18n.localize(W.statLabel(k)),
                selected: k === chosen
            }))
        ];
        // Key→label map so the display view can name a slot's governing stat
        // (empty key → t("WITCHER.Sheet.Item.Base.Dialog.Button.NA", "N/A")).
        ctx.statLabels = {
            "": t("WITCHER.Sheet.Item.Base.Dialog.Button.NA", "N/A"),
            ...Object.fromEntries(
                W.stats.map(k => [k, game.i18n.localize(W.statLabel(k))])
            )
        };

        // Defining skill — config stat options + display label.
        ctx.definingStatOptions = statOpts(src.definingSkill?.stat ?? "");
        ctx.definingIsMagical   = !!src.definingSkill?.isMagical;

        // The three trees, both as flat config rows and a display list.
        const TREE_KEYS  = ["skillPath1", "skillPath2", "skillPath3"];
        const SLOT_KEYS  = ["skill1", "skill2", "skill3"];
        ctx.treesConfig  = [];
        ctx.treesDisplay = [];
        TREE_KEYS.forEach((prefix, ti) => {
            const path = src[prefix] ?? {};
            ctx.treesConfig.push({
                label:    tFormat("WITCHER.Sheet.Item.Base.Dialog.Button.SkillTreeX", { val0: ti + 1 }, "Skill Tree {val0}"),
                prefix,
                pathName: path.pathName ?? "",
                skills:   SLOT_KEYS.map((slot, si) => {
                    const s = path[slot] ?? {};
                    return {
                        prefix, slot, n: si + 1,
                        skillName:  s.skillName ?? "",
                        definition: s.definition ?? "",
                        statOptions: statOpts(s.stat ?? ""),
                        isMagical:  !!s.isMagical
                    };
                })
            });
            const shown = SLOT_KEYS
                .map(slot => path[slot] ?? {})
                .filter(s => s.skillName)
                .map(s => ({
                    skillName:  s.skillName,
                    definition: s.definition ?? "",
                    statLabel:  ctx.statLabels[s.stat] ?? t("WITCHER.Sheet.Item.Base.Dialog.Button.NA", "N/A"),
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
        /* Creature-type dropdown context. See RaceData#creatureType — an
         * empty value means "no category" (blade-oil target matching skips
         * this actor). MONSTER_TYPES is looked up lazily via CONFIG.WITCHER
         * so the sheet doesn't need a direct import. */
        const monsterTypes = CONFIG.WITCHER?.monster?.types ?? {};
        ctx.creatureType = ctx.source.creatureType || "";
        ctx.creatureTypeOptions = [
            { value: "", label: game.i18n.localize("WITCHER.Sheet.Race.Text.NoCreatureType") || "(none)" },
            ...Object.entries(monsterTypes).map(([value, key]) => ({
                value,
                label: game.i18n.localize(key) || value
            }))
        ];
        ctx.creatureTypeLabel = ctx.creatureType
            ? (game.i18n.localize(monsterTypes[ctx.creatureType]) || ctx.creatureType)
            : "";
        /* Dark Vision mode dropdown — the Foundry vision filter the token gets. */
        const curMode = ctx.source.darkVisionMode || "monochromatic";
        ctx.darkVisionModes = DARK_VISION_MODES.map(m => ({
            value:    m.value,
            label:    game.i18n.localize(m.labelKey) || m.value,
            hint:     game.i18n.localize(m.hintKey) || "",
            selected: curMode === m.value
        }));
        /* Natural Weapons config — weapon-quality catalog + damage types for
         * the checkgrid/picker, and a resolved label list for the display. */
        const cfg = await import("../../setup/config.mjs");
        ctx.naturalWeaponQualitiesCatalog = cfg.getActiveWeaponQualities?.() ?? cfg.WEAPON_QUALITIES ?? {};
        /* Natural weapons get one EXTRA pickable type over the shared weapon
         * damage list: "nonlethal". Selecting it lets the wielder choose to
         * pull the blow — the strike lands as BLUNT damage to STAMINA even if
         * the natural weapon is otherwise flagged lethal. Scoped here (not the
         * global DAMAGE_TYPES) so it doesn't leak into weapon damage pickers. */
        ctx.naturalWeaponTypes = {
            ...(cfg.DAMAGE_TYPES ?? CONFIG.WITCHER?.damageTypes ?? {}),
            nonlethal: "WITCHER.Damage.Nonlethal"
        };
        const nwCat  = ctx.naturalWeaponQualitiesCatalog;
        const nwVals = ctx.source.naturalWeaponQualityValues ?? {};
        ctx.naturalWeaponQualityList = (ctx.source.naturalWeaponQualities ?? [])
            .map(key => {
                const e = nwCat[key];
                if (!e) return null;
                let label = e.label;
                if (e.param) {
                    const raw = nwVals[key];
                    const v = raw == null ? "" : String(raw).trim();
                    if (v.length) label = `${e.label}(${v}${e.param.suffix ?? ""})`;
                }
                return label;
            })
            .filter(Boolean);
        return ctx;
    }

    /* submitOnChange rebuilds the whole form on every field change, which
     * collapses the Natural Weapons "qualities" <details> back to its default
     * closed state — jarring when the user is toggling qualities inside it.
     * Persist the open state on an instance field and restore it after each
     * re-render so the chevron stays where the user left it. */
    async _onRender(context, options) {
        await super._onRender(context, options);
        const details = this.element?.querySelector("details.wdm-cfg-collapse");
        if (!details) return;
        if (this._nwQualitiesOpen) details.open = true;
        details.addEventListener("toggle", () => { this._nwQualitiesOpen = details.open; });
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
        // Alchemy Reborn gate: surface the homebrew toggle state so the
        // template can show/hide the Potency stepper (and any other Reborn
        // fields) without a hard-coded gate. Same shorthand as ctx.homebrew
        // on the base sheet, scoped to the alchemyPotency flag.
        // Direct import path — game.system.api.homebrew is wired at the
        // `ready` hook, but a sheet can render before that (drag preview,
        // compendium browse) and the optional-chain access would return
        // undefined → toggle reads false even when it's actually on.
        // isHomebrewEnabled reads game.settings directly so it works at
        // any time after settings register (which is `init`).
        ctx.alchemyRebornOn = isHomebrewEnabled("alchemyPotency");
        // showPotency drives the Potency line in the W3 display hero —
        // only show when the toggle is on, the component is a substance,
        // AND the potency value is non-zero (a 0-potency component still
        // satisfies count requirements but contributes nothing, so the
        // hero line would just read "Potency 0" — confusing).
        ctx.showPotency = ctx.alchemyRebornOn && ctx.hasHero && (Number(src?.potency) || 0) > 0;
        // Alchemy Reborn base picker — mirrors alchemical / food sheets.
        // Raw ingredients (Sulphur, Saltpetre, Timber, dry vodka
        // substance, …) can legitimately serve as bomb / potion bases,
        // so expose the same enable-gated block. baseSummary drives the
        // display view's "Potion · +1 DC" line the same way the other
        // sheets render it.
        ctx.baseSummary = ctx.alchemyRebornOn ? baseSummaryFor(this.item) : null;
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

        const TYPE_LABELS = {
            rune:   t("WITCHER.Sheet.Item.Base.EnhType.Rune",     "Rune"),
            glyph:  t("WITCHER.Sheet.Item.Base.EnhType.Glyph",    "Glyph"),
            weapon: t("WITCHER.Sheet.Item.Base.EnhType.WeaponMod","Weapon Mod"),
            armor:  t("WITCHER.Sheet.Item.Base.EnhType.ArmorMod", "Armor Mod")
        };
        ctx.typeLabel   = TYPE_LABELS[type] ?? type;

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
                return { key, label, description: entry.description, displayOnly: !!entry.displayOnly };
            })
            .filter(Boolean);

        ctx.damageTypes = cfg.DAMAGE_TYPES ?? CONFIG.WITCHER?.damageTypes ?? {};

        const rows = [];
        if (isWeaponSide) {
            const acc = Number(src?.accuracyBonus) || 0;
            const rel = Number(src?.reliabilityBonus) || 0;
            const dmg = (src?.damageBonus ?? "").toString().trim();
            if (acc) rows.push({ val: (acc > 0 ? "+" : "") + acc, lbl: t("WITCHER.Sheet.Item.Base.ModRow.WeaponAccuracy","Weapon Accuracy"), positive: acc > 0 });
            if (dmg) rows.push({ val: (dmg.startsWith("-") ? "" : "+") + dmg, lbl: t("WITCHER.Sheet.Item.Base.ModRow.Damage","Damage"), positive: !dmg.startsWith("-") });
            if (rel) rows.push({ val: (rel > 0 ? "+" : "") + rel, lbl: t("WITCHER.Sheet.Item.Base.ModRow.Reliability","Reliability"), positive: rel > 0 });
        } else {
            const sp = Number(src?.stopping) || 0;
            const ev = Number(src?.encumbranceMod) || 0;
            if (sp) rows.push({ val: "+" + sp, lbl: t("WITCHER.Sheet.Item.Base.ModRow.StoppingPower","Stopping Power"), positive: true });
            if (ev) rows.push({ val: (ev > 0 ? "+" : "") + ev, lbl: t("WITCHER.Sheet.Item.Base.ModRow.Encumbrance","Encumbrance"), positive: ev < 0 });
        }
        ctx.modRows = rows;

        const W = CONFIG.WITCHER ?? {};
        if (isWeaponSide) {
            ctx.addedTypeTags = (src?.addedDamageTypes ?? [])
                .map(k => game.i18n.localize(W.damageTypes?.[k] ?? k));
        } else {
            const res = [];
            if (src?.slashing)    res.push(t("WITCHER.Sheet.Item.Base.Text.Slashing",   "Slashing"));
            if (src?.piercing)    res.push(t("WITCHER.Sheet.Item.Base.Text.Piercing",   "Piercing"));
            if (src?.bludgeoning) res.push(t("WITCHER.Sheet.Item.Base.Text.Bludgeoning","Bludgeoning"));
            if (src?.fire)        res.push(t("WITCHER.Damage.Fire",      "Fire"));
            if (src?.lightning)   res.push(t("WITCHER.Damage.Lightning", "Lightning"));
            if (src?.cold)        res.push(t("WITCHER.Damage.Cold",      "Cold"));
            if (src?.acid)        res.push(t("WITCHER.Damage.Acid",      "Acid"));
            ctx.resistTags = res;
        }

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

    /* Wider than the 540px item default: the configuration view packs
     * compartment cards (type + kind selects, count, size/weight limits, combat
     * toggles) that need horizontal room to sit on their intended rows instead
     * of wrapping into a cramped column. Merges over the parent DEFAULT_OPTIONS
     * (ApplicationV2 deep-merges the static chain), so only the width changes. */
    static DEFAULT_OPTIONS = {
        position: { width: 680 }
    };

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
        // Only general / hybrid containers have a weight pool → capacity bar.
        // A compartment-only (slots) container never shows it, even with a carry
        // number set.
        const capMode = getContainerCfg(this.item)?.capacityMode;
        const hasWeightPool = (capMode === "general" || capMode === "hybrid") && capacity > 0;
        ctx.capacity     = capacity;
        ctx.storedWeight = Math.round(stored * 100) / 100;
        ctx.contentCount = content.length;
        ctx.hasCapacity  = hasWeightPool;
        ctx.isOver       = hasWeightPool && stored > capacity;
        ctx.fillPct      = hasWeightPool ? Math.min(100, Math.round((stored / capacity) * 100)) : 0;
        return ctx;
    }
}
export class WitcherNoteSheet          extends WitcherItemSheet { static PARTS = partsFor("note"); }
export class WitcherFocusSheet         extends WitcherItemSheet { static PARTS = partsFor("focus"); }
// Perk — icon + description + a transfer:true AE (stack multiple effects on one
// item). effectsTransfer defaults to true on WitcherItemSheet, so a perk's
// passives land on whoever carries it.
export class WitcherPerkSheet          extends WitcherItemSheet { static PARTS = partsFor("perk"); }
/* RAW critical-wound reference data (Core p.159-161, p.174), keyed by
 * criticalLevel. bonusDmg = Critical Wounds Table bonus damage (armor cannot
 * stop it); healDC / healTurns = Healing Hands table (a doctor treating the
 * wound); spellDC / spellUses = Healing Spell table (a mage). Surfaced
 * read-only in the display view so the wound card "reads" the rules. */
const CRIT_WOUND_INFO = () => ({
    simple:    { label: t("WITCHER.Sheet.Item.Base.Dialog.Button.Simple", "Simple"),    bonusDmg: 3,  healDC: 12, healTurns: 2,  spellDC: 14, spellUses: 4  },
    complex:   { label: t("WITCHER.Sheet.Item.Base.Dialog.Button.Complex", "Complex"),   bonusDmg: 5,  healDC: 14, healTurns: 4,  spellDC: 16, spellUses: 6  },
    difficult: { label: t("WITCHER.Sheet.Item.Base.Dialog.Button.Difficult", "Difficult"), bonusDmg: 8,  healDC: 16, healTurns: 6,  spellDC: 18, spellUses: 8  },
    deadly:    { label: t("WITCHER.Sheet.Item.Base.Dialog.Button.Deadly", "Deadly"),    bonusDmg: 10, healDC: 18, healTurns: 8,  spellDC: 20, spellUses: 10 }
});

const CRIT_LOCATIONS = () => [
    { key: "head",     label: t("WITCHER.Sheet.Item.Base.Dialog.Button.Head", "Head") },
    { key: "torso",    label: t("WITCHER.Common.Torso", "Torso") },
    { key: "rightArm", label: t("WITCHER.Sheet.Item.Base.Dialog.Button.RightArm", "Right Arm") },
    { key: "leftArm",  label: t("WITCHER.Sheet.Item.Base.Dialog.Button.LeftArm", "Left Arm") },
    { key: "rightLeg", label: t("WITCHER.Sheet.Item.Base.Dialog.Button.RightLeg", "Right Leg") },
    { key: "leftLeg",  label: t("WITCHER.Sheet.Item.Base.Dialog.Button.LeftLeg", "Left Leg") }
];

const CRIT_STATES = () => [
    { key: "unstabilized", label: t("WITCHER.Sheet.Item.Base.Dialog.Button.Unstabilized", "Unstabilized") },
    { key: "stabilized",   label: t("WITCHER.Sheet.Item.Base.Dialog.Button.Stabilized", "Stabilized") },
    { key: "treated",      label: t("WITCHER.Sheet.Item.Base.Dialog.Button.Treated", "Treated") }
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

        const critWoundInfo = CRIT_WOUND_INFO();
        const critLocations = CRIT_LOCATIONS();
        const critStates    = CRIT_STATES();
        const level = critWoundInfo[src.criticalLevel] ? src.criticalLevel : "simple";
        const info  = critWoundInfo[level];
        const state = critStates.some(s => s.key === src.state) ? src.state : "unstabilized";

        ctx.levelOptions = Object.entries(critWoundInfo).map(([key, v]) => ({
            key, label: v.label, selected: key === src.criticalLevel
        }));
        ctx.locationOptions = critLocations.map(o => ({ ...o, selected: o.key === src.location }));
        ctx.stateOptions    = critStates.map(o => ({ ...o, selected: o.key === state }));

        // Status effects this wound inflicts while unstabilized — chip picker
        // in the config view (same status registry as monster immunities).
        // policy/wound-statuses.mjs reconciles these onto the bearer.
        const woundStatuses = new Set(src.statuses ?? []);
        ctx.woundStatusOptions = statusImmunityOptions().map(o => ({
            ...o, active: woundStatuses.has(o.value)
        }));

        ctx.levelLabel    = info.label;
        ctx.locationLabel = critLocations.find(o => o.key === src.location)?.label ?? src.location;
        ctx.stateLabel    = critStates.find(o => o.key === state)?.label ?? state;
        ctx.variantLabel  = src.lesserEffect ? t("WITCHER.Sheet.Item.Base.Text.Lesser", "Lesser") : t("WITCHER.Sheet.Item.Base.Text.Greater", "Greater");
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
            body:        Number(this.item.actor?.system?.stats?.body?.value) || 0,
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
        ctx.effectGroups = CRIT_STATES().map(s => ({
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
            removeIngredient: WitcherDiagramsSheet._onRemoveIngredient,
            removeTierOutput: WitcherDiagramsSheet._onRemoveTierOutput
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
        const dcLabel = isRecipe  ? t("WITCHER.Chrome.Inventory.Text.CookingDC",  "Cooking DC")
                      : isFormula ? t("WITCHER.Chrome.Inventory.Text.AlchemyDC",  "Alchemy DC")
                                  : t("WITCHER.Chrome.Inventory.Text.CraftingDC", "Crafting DC");
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

        // Alchemy Reborn: surface the toggle for the tier outputs block.
        ctx.alchemyRebornOn = isHomebrewEnabled("alchemyPotency");

        // Alchemy Reborn tier outputs — three slots authored as drop-zones.
        // Normal IS the existing `system.associatedItem` ("Produced Item"
        // pre-Reborn): every legacy diagram already has it set, so flipping
        // Alchemy Reborn on doesn't leave compendium formulae empty-handed.
        // Enhanced and Superior live on `system.outputEnhanced/Superior` —
        // bare UUID strings whose name + img get resolved here for display.
        // The standalone "Produced Item" section is gone (collapsed into
        // the Normal tile so the GM sees one place to set it, not two).
        const tierBuildAssociated = (tier, label, potencyField) => {
            const assoc = src?.associatedItem ?? {};
            const uuid = assoc.uuid || "";
            let name = assoc.name || "", img = assoc.img || "icons/svg/item-bag.svg";
            // Prefer the live document for name/img when available so a
            // renamed associatedItem reflects without a save. The cached
            // {name, img, uuid} stays as the fallback for compendium-only
            // items that fromUuidSync can't resolve.
            if (uuid && typeof fromUuidSync === "function") {
                try {
                    const d = fromUuidSync(uuid);
                    if (d) { name = d.name; img = d.img ?? img; }
                } catch (_) { /* unresolved — keep the cached values */ }
            }
            return {
                tier,
                label,
                potency:      Number(src?.[potencyField]) || 0,
                potencyField,
                uuidField:    "associatedItem.uuid",   // unused (drop handler hardcodes the schema field for Normal)
                uuid,
                name,
                img,
                linked:       !!uuid,
                dropZone:    `output-${tier}`
            };
        };
        const tierBuildUuid = (tier, label, uuidField, potencyField) => {
            const uuid = src?.[uuidField] ?? "";
            let name = "", img = "icons/svg/item-bag.svg", linked = false;
            if (uuid && typeof fromUuidSync === "function") {
                try {
                    const d = fromUuidSync(uuid);
                    if (d) { name = d.name; img = d.img ?? img; linked = true; }
                } catch (_) { /* unresolved */ }
            }
            return {
                tier, label,
                potency:      Number(src?.[potencyField]) || 0,
                potencyField, uuidField,
                uuid, name, img, linked,
                dropZone:    `output-${tier}`
            };
        };
        ctx.tierOutputs = [
            tierBuildAssociated("normal",   game.i18n.localize("WITCHER.AlchemyReborn.Tier.Normal"),   "potencyNormal"),
            tierBuildUuid("enhanced",       game.i18n.localize("WITCHER.AlchemyReborn.Tier.Enhanced"), "outputEnhanced", "potencyEnhanced"),
            tierBuildUuid("superior",       game.i18n.localize("WITCHER.AlchemyReborn.Tier.Superior"), "outputSuperior", "potencySuperior")
        ];

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
                /* Stop bubbling so the drop can't reach any ancestor form /
                 * ApplicationV2 default drop listener and re-interpret the
                 * item drag as a sheet-scoped action. Without this, dropping
                 * on a tier-output zone was observed to reset kind → diagram
                 * (the layout would flip back to single-output mode). */
                ev.stopPropagation();
                zone.classList.remove("is-drop-target");
                /* Flush any focused field so submitOnChange's async submit
                 * doesn't race the item.update below. If the potency input
                 * still had focus when the user let go of the drag, the
                 * ensuing blur fired a form submit whose formData raced
                 * our partial update — occasionally clobbering fields. */
                if (document.activeElement?.tagName &&
                    ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) {
                    document.activeElement.blur();
                    try { await this.submit({ preventClose: true, preventRender: true }); }
                    catch (_) { /* validation failure — surface via ui.notifications */ }
                }
                await this.#handleDrop(ev, zone.dataset.dropZone);
            });
        });

        // Per-effect application chance — not form-bound (effects are
        // embedded documents, not system fields), so commit to the effect's
        // flag on change. Clamped 0–100.
        root.querySelectorAll(".wdm-effect-chance").forEach(inp => {
            inp.addEventListener("change", async ev => {
                const id = ev.target.dataset.effectId;
                const effect = this.item.effects.get(id);
                if (!effect) return;
                let v = Math.round(Number(ev.target.value));
                if (!Number.isFinite(v)) v = 100;
                v = Math.max(0, Math.min(100, v));
                ev.target.value = v;
                await effect.setFlag("witcher-ttrpg-death-march", "applyChance", v);
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
        /* Embedded-effect drop zone — "drag in an effect". Accept a dragged
         * ActiveEffect (embed a copy), or an Item (embed copies of its own
         * effects), authored locally on THIS item. Kept separate from the
         * component/output zones below, which only take Items. */
        if (zone === "effect") { await this.#embedDroppedEffect(data); return; }
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
        } else if (zone === "output-normal") {
            /* Normal tier IS the existing Produced Item (associatedItem) —
             * one place to set it, every legacy diagram already has it.
             * Caches name/img alongside uuid the same way the original
             * output drop did, so the tile renders fully even without an
             * fromUuidSync lookup. */
            await this.item.update({
                "system.associatedItem": { name: item.name, uuid: item.uuid, img: item.img }
            });
        } else if (zone === "output-enhanced" || zone === "output-superior") {
            /* Enhanced / Superior — bare UUID on the matching string field.
             * Name + img resolve at render time via fromUuidSync so a rename
             * flows through without a save round-trip; the diagram stays
             * lean (no triplet cached). */
            const tier = zone.slice("output-".length);
            const field = `system.output${tier.charAt(0).toUpperCase()}${tier.slice(1)}`;
            await this.item.update({ [field]: item.uuid });
        }
    }

    /** Embed a dropped effect as a local copy on this item. Accepts a dragged
     *  ActiveEffect directly, or an Item (embeds copies of ITS effects). The
     *  copy's `_id` / `origin` are stripped so it's authored here, not linked
     *  back to the source. Embedded effects are flat — they apply as authored
     *  when the spell casts (system.castsAuthoredAE); Status Riders remain the
     *  stamina-scaling path. */
    async #embedDroppedEffect(data) {
        if (!data?.uuid) return;
        let sources = [];
        if (data.type === "ActiveEffect") {
            const ae = await fromUuid(data.uuid);
            if (ae) sources = [ae.toObject()];
        } else if (data.type === "Item") {
            const item = await fromUuid(data.uuid);
            if (item?.uuid === this.item.uuid) return;   // no self-embed
            const effs = item?.effects ? [...item.effects] : [];
            sources = effs.map(e => e.toObject());
        }
        if (!sources.length) {
            ui.notifications?.info(game.i18n.localize("WITCHER.Sheet.Item.Notify.NoEffectToEmbed"));
            return;
        }
        for (const src of sources) { delete src._id; delete src.origin; }
        await this.item.createEmbeddedDocuments("ActiveEffect", sources);
    }

    /* Read the current form state directly from the DOM and return an
       update payload with every form-bound field the sheet exposes
       (kind, level, type, DCs, name, requiresForge, craftingTime,
       investment, availability, learned, and the alchemyComponents
       substance map when kind is "formula"). This is the reliable way
       to persist the user's uncommitted picks alongside a programmatic
       mutation: this.submit() proved unreliable (silent failures + race
       with submitOnChange), so we skip it and fold the values into the
       same item.update as the mutation itself. Single write, no race. */
    static _readFormState() {
        const form = this.form ?? this.element?.querySelector?.("form") ?? this.element;
        const update = {};
        if (!form) return update;

        const val = (sel) => form.querySelector(sel)?.value;
        const num = (sel) => {
            const v = form.querySelector(sel)?.value;
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
        };
        const bool = (sel) => !!form.querySelector(sel)?.checked;

        const kind = val('[name="system.kind"]');
        if (kind) update["system.kind"] = kind;
        const level = val('[name="system.level"]');
        if (level != null) update["system.level"] = level;
        const type = val('[name="system.type"]');
        if (type != null) update["system.type"] = type;
        const name = val('[name="name"]');
        if (name != null) update["name"] = name;

        const alchemyDC = num('[name="system.alchemyDC"]');
        if (alchemyDC != null) update["system.alchemyDC"] = alchemyDC;
        const craftingDC = num('[name="system.craftingDC"]');
        if (craftingDC != null) update["system.craftingDC"] = craftingDC;
        const investment = num('[name="system.investment"]');
        if (investment != null) update["system.investment"] = investment;

        if (form.querySelector('[name="system.requiresForge"]')) {
            update["system.requiresForge"] = bool('[name="system.requiresForge"]');
        }
        const craftingTime = val('[name="system.craftingTime"]');
        if (craftingTime != null) update["system.craftingTime"] = craftingTime;
        const availability = val('[name="system.availability"]');
        if (availability != null) update["system.availability"] = availability;
        if (form.querySelector('[name="system.learned"]')) {
            update["system.learned"] = bool('[name="system.learned"]');
        }

        /* Substance map — same routing as _prepareSubmitData at :2202.
           Only meaningful when kind === "formula"; otherwise the grid
           isn't rendered and we'd zero-clear a pending switch. */
        if (kind === "formula") {
            const map = {};
            form.querySelectorAll('input[data-substance-key]').forEach(inp => {
                const key = inp.dataset.substanceKey;
                const q = Math.max(0, Math.floor(Number(inp.value) || 0));
                if (q > 0) map[key] = q;
            });
            const { ForcedReplacement } = foundry.data.operators;
            update["system.alchemyComponents"] = ForcedReplacement.create(map);
        }

        return update;
    }

    /* Blur any focused element so the per-input change listeners
       (ingredient-qty at :2074, substance stepper at :2094) get a
       chance to commit their pending edits BEFORE the read below.
       Then read the DOM directly — we can't rely on this.submit()
       here because it silently no-ops or races with submitOnChange
       for buttons that don't originate from a form submit event. */
    static _blurActive() {
        const active = document.activeElement;
        if (active?.blur && active !== document.body) {
            try { active.blur(); } catch (_) { /* detached */ }
        }
    }

    static async _onRemoveOutput(event, target) {
        if (!this.isEditable) return;
        WitcherDiagramsSheet._blurActive();
        const update = WitcherDiagramsSheet._readFormState.call(this);
        update["system.associatedItem"] = { name: "", uuid: "", img: null };
        await this.item.update(update);
    }

    static async _onRemoveTierOutput(event, target) {
        if (!this.isEditable) return;
        const tier = target?.dataset?.tier;
        if (!tier) return;
        WitcherDiagramsSheet._blurActive();
        const update = WitcherDiagramsSheet._readFormState.call(this);
        if (tier === "normal") {
            update["system.associatedItem"] = { name: "", uuid: "", img: null };
        } else {
            const field = `system.output${tier.charAt(0).toUpperCase()}${tier.slice(1)}`;
            update[field] = "";
        }
        await this.item.update(update);
    }

    static async _onRemoveIngredient(event, target) {
        if (!this.isEditable) return;
        const idx = Number(target.closest("[data-ingredient-index]")?.dataset.ingredientIndex);
        if (!Number.isInteger(idx)) return;
        WitcherDiagramsSheet._blurActive();
        const update = WitcherDiagramsSheet._readFormState.call(this);
        const list = foundry.utils.deepClone(this.item.system.craftingComponents ?? []);
        if (idx < 0 || idx >= list.length) return;
        list.splice(idx, 1);
        update["system.craftingComponents"] = list;
        await this.item.update(update);
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

    /* Open the dedicated book-setup dialog (DC / monster filter / skill range
     * / stress steps). The dialog is GM-rich, player-readonly; it persists to
     * system.bookConfig. Lazy-imported to keep the core sheet decoupled from
     * the chrome book module.
     *
     * MUST be declared BEFORE `DEFAULT_OPTIONS` — static class fields run in
     * source order, and the actions map on DEFAULT_OPTIONS captures the
     * handler by reference at that moment. If `_onConfigureBook` were
     * declared after DEFAULT_OPTIONS, Foundry would register `undefined`
     * and the button click would silently no-op. */
    static async _onConfigureBook(event, target) {
        const { openBookConfigDialog } = await import("../../chrome/sheets/valuable-study.js");
        await openBookConfigDialog(this.item);
    }

    static DEFAULT_OPTIONS = {
        actions: { configureBook: WitcherValuableSheet._onConfigureBook }
    };

    /* Fallback wire — attach a direct click listener on every render, so
     * even if Foundry's action dispatcher misses (has happened before
     * with DEFAULT_OPTIONS timing quirks), the button still opens the
     * dialog. `dataset.wdmBookBtnWired` guards against double-wiring. */
    async _onRender(context, options) {
        await super._onRender?.(context, options);
        const btn = this.element?.querySelector?.('button[data-action="configureBook"]');
        if (!btn || btn.dataset.wdmBookBtnWired === "1") return;
        btn.dataset.wdmBookBtnWired = "1";
        btn.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            WitcherValuableSheet._onConfigureBook.call(this, ev, btn)
                .catch(err => console.warn("witcher-ttrpg-death-march | Configure Book failed", err));
        });
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

        // "book" is no longer a valuable subtype — it's its own first-class
        // item type now (see data/item/book.mjs + WitcherBookSheet). Legacy
        // valuable items with `system.type === "book"` still render via this
        // sheet until the migration in migrateLegacyFlags.mjs rewrites them,
        // so the label fallback covers that grace-period case.
        const SUBTYPE_LABELS = {
            "":      t("WITCHER.Sheet.Item.Base.ValuableType.Valuable", "Valuable"),
            book:    t("WITCHER.Sheet.Item.Base.ValuableType.Book",     "Book"),
            map:     t("WITCHER.Sheet.Item.Base.ValuableType.Map",      "Map"),
            remains: t("WITCHER.Sheet.Item.Base.ValuableType.Remains",  "Remains"),
            trophy:  t("WITCHER.Sheet.Item.Base.ValuableType.Trophy",   "Trophy")
        };
        ctx.subtypeLabel = SUBTYPE_LABELS[subtype] ?? t("WITCHER.Sheet.Item.Base.ValuableType.Valuable", "Valuable");

        if (subtype === "trophy") {
            const tc = src?.trophyConfig ?? {};
            ctx.trophy = { monsterCategory: String(tc.monsterCategory ?? "") };
        }

        if (subtype === "book") {
            // Legacy valuable-with-book-subtype still works until the
            // migration converts the document to a `book` item.
            ctx.bookEnabled = game.system.api.homebrew.isEnabled("bookSystem");
            const bc = src?.bookConfig ?? {};
            ctx.bookType = bc.bookType ?? "monster";
            const TYPE_LABELS = { monster: "Monster Lore", skill: "Skill", stress: "Novel / Lore" };
            ctx.bookTypeLabel = TYPE_LABELS[ctx.bookType] ?? "Monster Lore";
            ctx.bookSummary = summarizeBookConfig(bc);

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
            // Whether the source monster has a linked mutagen — hides the
            // "Mutagen extracted" line when there was never one to extract.
            // Prefer the stamped flag; fall back to a sync resolve for legacy
            // carcasses; err toward showing only if we truly can't tell.
            let hasMutagen;
            if (typeof f.mutagenLinked === "boolean") {
                hasMutagen = f.mutagenLinked;
            } else if (uuid && typeof fromUuidSync === "function") {
                try {
                    const m = fromUuidSync(uuid);
                    hasMutagen = m?.system ? !!m.system?.mutagen?.uuid : true;
                } catch (_) { hasMutagen = true; }
            } else {
                hasMutagen = false;
            }
            ctx.remainsState = {
                harvested:  !!f.harvested,
                extracted:  !!f.mutagenExtracted,
                hasMutagen,
                charges:    f.remainsCharges ?? CHARGES_MAX,
                chargesMax: CHARGES_MAX
            };
        }

        return ctx;
    }
}

/**
 * WitcherBookSheet — first-class book sheet (item.type === "book"). Pure
 * book content — no subtype machinery — since the document type alone
 * carries that information now. Reuses the same context shape the legacy
 * valuable-book sheet exposed (`bookEnabled`, `bookType`, `bookTypeLabel`,
 * `bookSummary`, `bookProgress`) so the chrome book dialog and the
 * progress-render helpers don't need to know which sheet rendered the item.
 */
export class WitcherBookSheet extends WitcherItemSheet {
    static PARTS = partsFor("book");

    /* Lazy-imported chrome dialog launcher — keeps the data layer decoupled
     * from the chrome bundle the same way WitcherValuableSheet does.
     * MUST come before DEFAULT_OPTIONS so the actions map captures the
     * function, not `undefined` (see the note on WitcherValuableSheet). */
    static async _onConfigureBook(event, target) {
        const { openBookConfigDialog } = await import("../../chrome/sheets/valuable-study.js");
        await openBookConfigDialog(this.item);
    }

    static DEFAULT_OPTIONS = {
        actions: { configureBook: WitcherBookSheet._onConfigureBook }
    };

    /* See WitcherValuableSheet._onRender — same fallback direct-click
     * wire so the button still opens the dialog even if action-dispatch
     * lookup misses. */
    async _onRender(context, options) {
        await super._onRender?.(context, options);
        const btn = this.element?.querySelector?.('button[data-action="configureBook"]');
        if (!btn || btn.dataset.wdmBookBtnWired === "1") return;
        btn.dataset.wdmBookBtnWired = "1";
        btn.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            WitcherBookSheet._onConfigureBook.call(this, ev, btn)
                .catch(err => console.warn("witcher-ttrpg-death-march | Configure Book failed", err));
        });
    }

    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        const src = ctx.source ?? this.item.toObject().system;

        ctx.bookEnabled = game.system.api.homebrew.isEnabled("bookSystem");
        const bc = src?.bookConfig ?? {};
        ctx.bookType = bc.bookType ?? "monster";
        const TYPE_LABELS = { monster: "Monster Lore", skill: "Skill", stress: "Novel / Lore" };
        ctx.bookTypeLabel = TYPE_LABELS[ctx.bookType] ?? "Monster Lore";
        ctx.bookSummary = summarizeBookConfig(bc);

        // Per-reader progress — only meaningful when the book is owned.
        ctx.bookProgress = null;
        const actor = this.item.actor;
        if (actor) {
            try {
                const { getBookProgress } = await import("../../chrome/sheets/valuable-study.js");
                ctx.bookProgress = getBookProgress(this.item, actor);
            } catch (_) { /* chrome module unavailable — skip progress */ }
        }

        // Language flavour — a Witcher-3-tooltip-style hint about how legible
        // the book is to the viewing reader, driven by their language-skill
        // rank vs the book's required rank. Falls back to the user's assigned
        // character when the book isn't owned by anyone.
        const viewer = actor ?? game.user?.character ?? null;
        ctx.languageFlavor = ctx.bookEnabled ? describeBookLanguage(bc, viewer) : null;
        return ctx;
    }
}

/* Language skills (all INT). Kept local to the data layer so the book sheet
 * doesn't have to reach into the chrome bundle just to phrase a hint. */
const BOOK_LANGUAGE_SKILLS = ["commonspeech", "eldersp", "elderspskellige", "dwarven", "nilfgaardian"];

/* The three Elder Speech dialects are mutually intelligible: a reader who lacks
 * the exact dialect a book needs can fall back on another they know, but their
 * effective rank drops by 4 (the book's shortfall penalty then applies on top). */
const ELDER_SPEECH_VARIANTS = ["eldersp", "elderspskellige", "nilfgaardian"];
const ELDER_SPEECH_CROSS_PENALTY = 2;

/* A reader's EFFECTIVE rank in a book's required language. A direct rank always
 * wins; for an Elder Speech dialect the reader has NO ranks in, the best OTHER
 * dialect they know stands in at −4 (floored at 0). */
function effectiveLanguageRank(actor, skillId) {
    const rankIn = (id) => {
        const s = actor?.system?.skills?.int?.[id];
        return Number(s?.modifiedValue ?? s?.value ?? 0);
    };
    const direct = rankIn(skillId);
    if (direct > 0 || !ELDER_SPEECH_VARIANTS.includes(skillId)) return direct;
    const best = Math.max(0, ...ELDER_SPEECH_VARIANTS.filter(id => id !== skillId).map(rankIn));
    return best > 0 ? Math.max(0, best - ELDER_SPEECH_CROSS_PENALTY) : 0;
}

/**
 * Describe how legible a book is to a reader, as a { tone, text } hint.
 * Returns null when the book has no language set or there's no viewer.
 * Tone escalates with how far the reader's rank sits below (or above) the
 * book's required rank: unreadable → archaic → dense → slight → fluent → slang.
 */
function describeBookLanguage(bc, actor) {
    // Respect the global language-subsystem toggle (Book System settings).
    try {
        if (game.settings?.get?.("witcher-ttrpg-death-march", "bookSystemConfig")?.languageEnabled === false) return null;
    } catch (_) { /* setting not registered yet — treat as enabled */ }
    const lang = bc?.language ?? {};
    const skillId = String(lang.skillId ?? "");
    if (!skillId || !BOOK_LANGUAGE_SKILLS.includes(skillId)) return null;
    const langLabel = game.i18n?.localize?.(`WITCHER.skills.${skillId}.label`) || skillId;
    if (!actor) return null;

    const req = Math.max(0, Number(lang.requiredRank) || 0);
    const rank = effectiveLanguageRank(actor, skillId);

    if (rank <= 0) return { tone: "unreadable", text: tFormat("WITCHER.Sheet.Book.Lang.Unreadable", { lang: langLabel }, "It seems written in a language you don't speak.") };
    const gap = req - rank;
    if (gap >= 4) return { tone: "archaic", text: tFormat("WITCHER.Sheet.Book.Lang.Archaic", { lang: langLabel }, "It seems written in a high, archaic form of {lang}.") };
    if (gap >= 2) return { tone: "dense",   text: tFormat("WITCHER.Sheet.Book.Lang.Dense",   { lang: langLabel }, "The phrasing is dense and formal — slow going.") };
    if (gap >= 1) return { tone: "slight",  text: tFormat("WITCHER.Sheet.Book.Lang.Slight",  { lang: langLabel }, "Mostly clear, with the odd unfamiliar turn of phrase.") };
    if (rank - req >= 4) return { tone: "slang", text: tFormat("WITCHER.Sheet.Book.Lang.Slang", { lang: langLabel }, "It reads like simple slang to you — almost too plain.") };
    return { tone: "fluent", text: tFormat("WITCHER.Sheet.Book.Lang.Fluent", { lang: langLabel }, "You read {lang} comfortably.") };
}

/* Short, human-readable summary of a book's system.bookConfig for the sheet
 * readout. The authoritative editor is the chrome book dialog; this stays
 * intentionally light (no bestiary lookups). */
function summarizeBookConfig(bc) {
    const type = bc?.bookType ?? "monster";
    if (type === "stress") {
        const steps = Array.isArray(bc?.stress?.steps) ? bc.stress.steps.length : 0;
        return steps ? tFormat("WITCHER.Sheet.Item.Book.NovelLoreSteps", { n: steps, plural: steps === 1 ? "" : "s" }, `Novel / Lore — ${steps} reading step${steps === 1 ? "" : "s"}.`) : t("WITCHER.Sheet.Item.Book.NovelLoreNotConfigured", "Novel / Lore — not configured yet.");
    }
    if (type === "skill") {
        const sc = bc?.skill ?? {};
        if (!sc.skillId) return t("WITCHER.Sheet.Item.Book.SkillBookNotConfigured", "Skill book — not configured yet.");
        return tFormat("WITCHER.Sheet.Item.Book.SkillBookConfigured", { skill: sc.skillId, min: sc.rangeMin ?? 0, max: sc.rangeMax ?? 1 }, `Skill book — ${sc.skillId} (rank ${sc.rangeMin ?? 0}→${sc.rangeMax ?? 1}).`);
    }
    const mc = bc?.monster ?? {};
    if (mc.mode === "list")   return tFormat("WITCHER.Sheet.Item.Book.MonsterStudyList", { n: (mc.listKeys ?? []).length }, `Monster study — ${(mc.listKeys ?? []).length} monsters.`);
    if (mc.mode === "filter") return t("WITCHER.Sheet.Item.Book.MonsterStudyFilter", "Monster study — filter mode.");
    if (mc.specificKey)       return t("WITCHER.Sheet.Item.Book.MonsterStudySingle", "Monster study — single monster.");
    return t("WITCHER.Sheet.Item.Book.MonsterStudyNotConfigured", "Monster study — not configured yet.");
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
            name: t("WITCHER.Sheet.Item.Base.Text.NewEffect", "New Effect"),
            img:  this.item.img,
            description: this.item.system?.description ?? "",
            disabled: false,
            transfer: this.effectsTransfer
        }]);
        effect?.sheet?.render(true);
    }

    /* Wipe orthogonal kind-specific blocks when the GM switches `kind`.
     *
     * Kind-specific blocks:
     *   drink       → `system.drunk.*` (alcohol metadata)
     *   ingredient  → `system.ingredient.*` (edible / makesSick)
     *                 ingredients also DO NOT carry charges or pour metadata
     *                 (the consume branch returns before either is read), so
     *                 entering ingredient clears those too.
     *   meal        → none
     *
     * Without this, switching drink→meal leaves `drunk.isAlcohol: true` lying
     * around (the UI hides the editor when `kind !== "drink"` but the schema
     * keeps the value), so a Pour-a-Glass spawn or a future re-toggle to
     * drink resurrects the old "is alcohol" flag silently. Same with a
     * meal→ingredient transition that leaves charges=5/5 on the ingredient —
     * the config UI hides the Portions field for ingredients but the W3
     * display tooltip reads `source.charges.max` unconditionally and prints
     * a portions ticker on what should be a single-unit raw ingredient.
     *
     * Schema defaults (kept in sync with food.mjs):
     *   drunk = { isAlcohol:false, dc:10, levelJump:1, flavorVerb:"drinks", effectIcon:"" }
     *   ingredient = { edible:false, makesSick:false }
     *   charges = { current:0, max:0 }   (max:0 disables the ticker)
     *   pour* fields default to "" / false */
    _prepareSubmitData(event, form, formData) {
        const data = super._prepareSubmitData(event, form, formData);
        if (!form) return data;
        const newKind = form.querySelector('select[name="system.kind"]')?.value
                     || form.querySelector('input[name="system.kind"]')?.value;
        const curKind = this.item.system?.kind;
        if (!newKind || newKind === curKind) return data;
        // Leaving "drink" — clear alcohol metadata back to schema defaults.
        if (curKind === "drink" && newKind !== "drink") {
            foundry.utils.setProperty(data, "system.drunk", {
                isAlcohol:  false,
                dc:         10,
                levelJump:  1,
                flavorVerb: "drinks",
                effectIcon: ""
            });
        }
        // Leaving "ingredient" — clear ingredient toggles back to defaults.
        if (curKind === "ingredient" && newKind !== "ingredient") {
            foundry.utils.setProperty(data, "system.ingredient", {
                edible:    false,
                makesSick: false
            });
        }
        // Entering "ingredient" — strip portions + pour metadata. Ingredients
        // are atomic units (one entry = one ingredient); the consume branch
        // ignores charges and the pour split is meaningless for raw inputs,
        // so dropping these to schema defaults stops the W3 tooltip from
        // printing a stale "5/5 Portions" line on the ingredient view.
        if (newKind === "ingredient" && curKind !== "ingredient") {
            foundry.utils.setProperty(data, "system.charges", { current: 0, max: 0 });
            foundry.utils.setProperty(data, "system.pourLabel", "");
            foundry.utils.setProperty(data, "system.pourIconCustom", false);
            foundry.utils.setProperty(data, "system.pourIcon", "");
        }
        return data;
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
        ctx.alchemyRebornOn = isHomebrewEnabled("alchemyPotency");
        // Base summary mirrors the alchemical sheet so a drink configured
        // as a potion base / an ingredient configured as a bomb base shows
        // the same "Type · ±N DC" line on its display view.
        ctx.baseSummary = ctx.alchemyRebornOn ? baseSummaryFor(this.item) : null;
        const src = ctx.source ?? this.item.toObject().system;
        ctx.kind = src?.kind || "meal";
        ctx.kindOptions = {
            meal:       game.i18n.localize("WITCHER.Food.KindMeal"),
            drink:      game.i18n.localize("WITCHER.Food.KindDrink"),
            ingredient: game.i18n.localize("WITCHER.Food.KindIngredient")
        };
        ctx.kindLabel = ctx.kindOptions[ctx.kind] ?? ctx.kind;
        ctx.isDrink = ctx.kind === "drink";
        ctx.isIngredient = ctx.kind === "ingredient";
        // Tier dropdown for the bland-diet / bonus-axis mechanic.
        ctx.tier = src?.tier || "medium";
        ctx.tierOptions = {
            poor:   "Poor",
            medium: "Medium",
            good:   "Good",
            lavish: "Lavish"
        };
        // Bland-eating checkbox — only consulted at runtime when tier is
        // "poor", but the field is always surfaced so the GM can flip it on
        // POOR forage / sweet / ritual items. Default is true (schema initial).
        ctx.blandFood = src?.blandFood !== false;
        // Mirrors the runtime rule in foodAndDrink.mjs applyDietTierMechanics:
        // only poor-tier, non-drink food with blandFood on actually ticks the
        // bland stack. Drinks bypass the mechanic, and blandFood=false is the
        // author's opt-out for foraged / sweet / ritual poor items. Any UI
        // surface that says "Bland" must agree with this predicate — otherwise
        // authors see a bland badge on an item that won't move the stack.
        ctx.isBland = ctx.tier === "poor" && ctx.blandFood && !ctx.isDrink;
        // Player-facing tier label for the display view subtitle stripe.
        // Poor tier splits: only actual bland-marked items read as "Bland" so
        // the subtitle doesn't lie when the GM unticked blandFood on a poor
        // forage / ritual item.
        ctx.tierLabel = ctx.tier === "poor"
            ? (ctx.isBland ? "Bleak meal" : "Poor meal")
            : ({ medium: "Modest meal", good: "Good meal", lavish: "Lavish meal" }[ctx.tier] ?? "");
        // Bonus hint — parse the first axis-tagged AE on the item to produce
        // a human-readable "Grants +1 STA recovery for 4h" line for the
        // display view. POOR/MEDIUM items don't carry an axis AE so the
        // hint stays empty. Reads either the legacy `wdm` scope (from
        // pre-fix pack data) OR the registered system-id scope (new writes).
        try {
            const SYSTEM_ID = "witcher-ttrpg-death-march";
            const axisAE = this.item.effects?.find?.(e =>
                (e.flags?.[SYSTEM_ID]?.foodAxis ?? e.flags?.wdm?.foodAxis));
            if (axisAE) {
                const axisTag = String(axisAE.flags?.[SYSTEM_ID]?.foodAxis
                                    ?? axisAE.flags?.wdm?.foodAxis);
                const axis = axisTag.split("-")[0];
                const hours = Math.round((axisAE.duration?.seconds || 0) / 3600);
                const value = Number(axisAE.changes?.[0]?.value) || 1;
                const axisDescr = {
                    stamax:    "STA max",
                    starec:    "Recovery",
                    hphealing: "HP max",
                    refreshed: "REC"
                }[axis] || axis;
                ctx.foodBonus = `+${value} ${axisDescr} for ${hours}h`;
            }
        } catch {}
        // Surface the two ingredient toggles so the template can branch the
        // Satiety field on `edible` and show the sickness toggle directly.
        ctx.ingredientEdible    = !!src?.ingredient?.edible;
        ctx.ingredientMakesSick = !!src?.ingredient?.makesSick;

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
