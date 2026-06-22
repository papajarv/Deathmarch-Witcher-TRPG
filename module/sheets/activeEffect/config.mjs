/**
 * WitcherActiveEffectConfig — friendly, unified ActiveEffect editor.
 *
 * Replaces core's raw {key, type, value} change table AND the old split
 * Changes/Logic tabs with ONE "Effects" tab: a single list of action rows.
 * Each row picks an action `type` (Modify / Heal / Damage / Suppress) and
 * shows only that action's fields. The whole list persists as
 * flags.<systemId>.actions[] and routes to three backends:
 *   modify   → compiled into native changes (WitcherActiveEffect)
 *   heal/damage → fired per turn by the tick engine
 *   suppress → read in character.prepareDerivedData
 *
 * Details / duration / footer are inherited unchanged.
 */

import {
    effectStatTargets,
    effectOperationOptions,
    effectTriggerOptions,
    effectTrigger,
    effectActionTypeOptions,
    tickHealConditionOptions,
    tickLocationOptions,
    suppressTargetOptions,
    statusImmunityOptions
} from "../../setup/config.mjs";
import { pickEffectTarget } from "../../applications/effectTargetPicker.mjs";

const ActiveEffectConfig = foundry.applications.sheets.ActiveEffectConfig;
const SYSTEM_ID = "witcher-ttrpg-death-march";

export class WitcherActiveEffectConfig extends ActiveEffectConfig {

    static DEFAULT_OPTIONS = {
        classes: ["witcher-ttrpg-death-march"],
        // Live editing: each change saves and re-renders in place, so picking
        // an action type immediately swaps in that type's fields. closeOnSubmit
        // must be off or every change would close the sheet.
        form: { submitOnChange: true, closeOnSubmit: false },
        actions: {
            addAction:    WitcherActiveEffectConfig.#onAddAction,
            deleteAction: WitcherActiveEffectConfig.#onDeleteAction,
            browseTarget: WitcherActiveEffectConfig.#onBrowseTarget
        }
    };

    /* Core parts, minus the raw "changes" part, plus our single "effects"
     * part. The per-row template is listed so it preloads as a partial. */
    static PARTS = {
        header:   { template: "templates/sheets/active-effect/header.hbs" },
        tabs:     { template: "templates/generic/tab-navigation.hbs" },
        details:  { template: "templates/sheets/active-effect/details.hbs", scrollable: [""] },
        duration: { template: "templates/sheets/active-effect/duration.hbs" },
        effects: {
            template:  `systems/${SYSTEM_ID}/templates/active-effect/effects.hbs`,
            templates: [`systems/${SYSTEM_ID}/templates/active-effect/effect-action.hbs`],
            scrollable: ["ol[data-actions]"]
        },
        footer:   { template: "templates/generic/form-footer.hbs" }
    };

    static TABS = {
        sheet: {
            tabs: [
                { id: "details",  icon: "fa-solid fa-book" },
                { id: "duration", icon: "fa-solid fa-clock" },
                { id: "effects",  icon: "fa-solid fa-wand-magic-sparkles" }
            ],
            initial: "details",
            labelPrefix: "EFFECT.TABS"
        }
    };

    /** Build the Effects-tab context. Each stored action is rendered to an
     *  HTML string here (mirroring the codebase's row-render pattern) so the
     *  tab template just emits them; the row context carries both the row's
     *  own view-model and the shared option lists it needs. */
    async _preparePartContext(partId, context) {
        const ctx = await super._preparePartContext(partId, context);
        if (partId !== "effects") return ctx;

        const actions = Array.isArray(this.document.flags?.[SYSTEM_ID]?.actions)
            ? this.document.flags[SYSTEM_ID].actions
            : [];

        const shared = {
            operationOptions:     effectOperationOptions(),
            triggerOptions:       effectTriggerOptions(),
            actionTypeOptions:    effectActionTypeOptions(),
            healConditionOptions: tickHealConditionOptions(),
            suppressOptions:      suppressTargetOptions(),
            immunityOptions:      statusImmunityOptions()
        };
        const rowPath = `systems/${SYSTEM_ID}/templates/active-effect/effect-action.hbs`;

        ctx.targetList = effectStatTargets();
        ctx.actions = [];
        for (let index = 0; index < actions.length; index++) {
            const rowCtx = { ...shared, ...this.#actionRow(actions[index], index) };
            ctx.actions.push(await foundry.applications.handlebars.renderTemplate(rowPath, rowCtx));
        }
        return ctx;
    }

    /** One action row view-model. Precomputes the flattened flag paths each
     *  field binds to, the current values, and the per-type selection state
     *  (custom-key flag for modify; selected locations for damage). */
    #actionRow(a, index) {
        const type = a?.type ?? "modify";
        const base = `flags.${SYSTEM_ID}.actions.${index}`;
        // Legacy rows stored key/mode; surface them under the new target/op
        // names so old saves still populate the rebuilt fields.
        const when = a?.when ?? "always";
        const row = {
            index,
            type,
            typePath: `${base}.type`,
            isModify:   type === "modify",
            isHeal:     type === "heal",
            isDamage:   type === "damage",
            isTempHp:   type === "tempHp",
            isSuppress: type === "suppress",
            isImmunity: type === "immunity",
            isPurge:    type === "purge",
            isAlcoholRollAdvantage: type === "alcoholRollAdvantage",
            isClearHangover:        type === "clearHangover",
            isStressShield:         type === "stressShield",
            // modify: <op> <value> TO <target> WHEN <when>
            targetPath: `${base}.target`, target: a?.target ?? a?.key ?? "",
            opPath:     `${base}.op`,     op:     a?.op ?? a?.mode ?? "add",
            valuePath:  `${base}.value`,  value:  a?.value ?? "",
            whenPath:   `${base}.when`,   when,
            gatePath:   `${base}.gate`,   gate:   a?.gate ?? "always",
            conditionPath: `${base}.condition`, condition: a?.condition ?? "",
            fireCapPath:   `${base}.fireCap`,   fireCap:   a?.fireCap ?? "",
            lastsPath:     `${base}.lasts`,     lasts:     a?.lasts ?? "untilEffectEnds",
            isCondition:    type === "modify" && when === "condition",
            isEventTrigger: type === "modify" && effectTrigger(when)?.mode === "event",
            isTickModify:   type === "modify" && effectTrigger(when)?.mode === "tick",
            // heal
            amountPath: `${base}.amount`, amount: a?.amount ?? "",
            // damage
            formulaPath:      `${base}.formula`,      formula: a?.formula ?? "",
            locationsPath:    `${base}.locations`,
            throughArmorPath: `${base}.throughArmor`, throughArmor: !!a?.throughArmor,
            ablateArmorPath:  `${base}.ablateArmor`,  ablateArmor: Number(a?.ablateArmor) || 0,
            // suppress
            whatPath: `${base}.what`, what: a?.what ?? "death",
            // immunity
            statusPath: `${base}.status`, status: a?.status ?? "",
            // stress shield — kind (points/sources) + buffer dice
            kindPath: `${base}.kind`, kind: a?.kind ?? "points",
            dicePath: `${base}.dice`, dice: a?.dice ?? "1d6"
        };
        if (type === "damage") {
            const raw = a?.locations;
            const set = new Set(
                (Array.isArray(raw) ? raw : (raw != null && raw !== "" ? [raw] : ["torso"])).map(String)
            );
            row.locationOptions = tickLocationOptions().map(o => ({
                ...o,
                path: `${base}.locFlags.${o.value}`,
                selected: set.has(o.value)
            }));
        }
        return row;
    }

    /** Annotate core's "Apply Effect to Actor" (transfer) checkbox on the
     *  Details tab with a warning: a consumable item's effects must stay
     *  dormant while carried (consume-item.js holds transfer:false), so
     *  leaving transfer ON would double-apply the buff. Injected once. */
    async _onRender(context, options) {
        await super._onRender(context, options);
        this.#injectTransferWarning();
        this.#injectDurationFormula();
    }

    #injectTransferWarning() {
        const input = this.element?.querySelector('input[name="transfer"]');
        if (!input || input.dataset.wdmWarned) return;
        input.dataset.wdmWarned = "1";
        const note = document.createElement("p");
        note.className = "hint wdm-transfer-warning";
        note.textContent = game.i18n.localize("WITCHER.Effect.TransferConsumableWarning");
        (input.closest(".form-group") ?? input.parentElement)?.appendChild(note);
    }

    /** Append a dice-formula field to the Duration tab, bound to the
     *  durationFormula flag. When set, consume-item rolls it fresh each use
     *  (e.g. "1d6/2"), so the duration is random per consume; units come from
     *  the native units dropdown above. */
    #injectDurationFormula() {
        const root = this.element;
        const tab = root?.querySelector('[data-application-part="duration"]')
                 ?? root?.querySelector('.tab[data-tab="duration"]');
        const name = `flags.${SYSTEM_ID}.durationFormula`;
        if (!tab || tab.querySelector(`input[name="${name}"]`)) return;
        const cur = String(this.document.flags?.[SYSTEM_ID]?.durationFormula ?? "")
            .replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
        const group = document.createElement("div");
        group.className = "form-group";
        group.innerHTML =
            `<label>${game.i18n.localize("WITCHER.Effect.DurationFormula")}</label>` +
            `<div class="form-fields"><input type="text" name="${name}" value="${cur}" placeholder="1d6/2" /></div>` +
            `<p class="hint">${game.i18n.localize("WITCHER.Effect.DurationFormulaHint")}</p>`;
        tab.appendChild(group);
    }

    /** flags.<sys>.actions arrives from the form as an index-keyed object
     *  (expandObject turns "actions.0.x" into {0:{x}}). Convert it back to a
     *  real array so the stored flag is an array, not {0:…,1:…}. */
    _processFormData(event, form, formData) {
        const submitData = super._processFormData(event, form, formData);
        const path = `flags.${SYSTEM_ID}.actions`;
        let actions = foundry.utils.getProperty(submitData, path);
        if (actions && !Array.isArray(actions) && foundry.utils.isPlainObject(actions)) {
            actions = Object.values(actions);
            foundry.utils.setProperty(submitData, path, actions);
        }
        // Damage rows submit per-location boolean checkboxes under locFlags;
        // fold the checked ones back into the locations[] array the engine reads.
        if (Array.isArray(actions)) {
            for (const a of actions) {
                if (!a || a.locFlags === undefined) continue;
                a.locations = Object.entries(a.locFlags).filter(([, on]) => on).map(([k]) => k);
                delete a.locFlags;
            }
        }
        return submitData;
    }

    /** The Target dropdown on a Modify row is a helper control (no `name`, so
     *  it never submits). On change, mirror the chosen data path into the real
     *  named key input. Picking "Advanced" reveals the input for raw typing.
     *  Run before super so the value is in the DOM when submitOnChange reads
     *  the form. Phase is no longer set here — the compiler derives it from
     *  the key (see compileActionsToChanges / phaseForKey). */
    _onChangeForm(formConfig, event) {
        const picker = event.target;
        if (picker?.classList?.contains("wdm-action-type-picker")) {
            // Mirror the chosen action type into the hidden named input so the
            // submit (and the re-render that swaps in this type's fields) sees
            // the new value.
            const typeInput = picker.closest("li")?.querySelector("input[data-type-input]");
            if (typeInput) typeInput.value = picker.value;
        }
        super._onChangeForm(formConfig, event);
    }

    /* ── Add / delete action rows ─────────────────────────────────────── */

    /** Append a new Modify row (the safe default — pure stat change). Reads
     *  the live form so in-progress edits aren't lost, then resubmits. */
    static async #onAddAction() {
        const submitData = this._processFormData(null, this.form, new foundry.applications.ux.FormDataExtended(this.form));
        const actions = WitcherActiveEffectConfig.#actionsFrom(submitData);
        actions.push({ type: "modify", target: "", op: "add", value: "", when: "always" });
        return this.submit({ updateData: { flags: { [SYSTEM_ID]: { actions } } } });
    }

    /** Remove the action row whose delete button was clicked. */
    static async #onDeleteAction(event) {
        const submitData = this._processFormData(null, this.form, new foundry.applications.ux.FormDataExtended(this.form));
        const actions = WitcherActiveEffectConfig.#actionsFrom(submitData);
        const index = Number(event.target.closest("li")?.dataset.index) || 0;
        actions.splice(index, 1);
        return this.submit({ updateData: { flags: { [SYSTEM_ID]: { actions } } } });
    }

    /** Open the categorized parameter picker for a Modify row's Target field
     *  and write the chosen path back (the change persists via submitOnChange). */
    static async #onBrowseTarget(event, target) {
        const input = target.closest(".wdm-action-row")?.querySelector(".wdm-target-input");
        if (!input) return;
        const key = await pickEffectTarget(input.value);
        if (!key) return;
        input.value = key;
        input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    /** Pull the actions list out of processed submit data as a real array. */
    static #actionsFrom(submitData) {
        const raw = foundry.utils.getProperty(submitData, `flags.${SYSTEM_ID}.actions`) ?? [];
        return Array.isArray(raw) ? raw : Object.values(raw);
    }
}
