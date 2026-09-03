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
    statusImmunityOptions,
    visionTypeOptions
} from "../../setup/config.mjs";
import { DARK_VISION_MODES } from "../../mechanics/light-level.mjs";
import { pickEffectTarget } from "../../applications/effectTargetPicker.mjs";

import { t, tFormat } from "../../chrome/lib/i18n.js";
const ActiveEffectConfig = foundry.applications.sheets.ActiveEffectConfig;
const SYSTEM_ID = "witcher-ttrpg-death-march";

/* Global belt-and-braces hook — runs on every ActiveEffect config render,
 * regardless of class or subclass. Two jobs:
 *   1. Flip the `duration.value` input from type="number" (which the
 *      browser filters non-digits from) to type="text" so dice codes
 *      ("1d6", "2d10+3") can actually be typed.
 *   2. If the AE carries a stored `durationFormula` flag, echo that
 *      formula back into the input so the user sees "2d6" instead of
 *      the bare 0 the schema stores.
 * Idempotent per input via `dataset.wdmDurationFlipped`. Attached at
 * module load. */
function flipDurationInput(root, app) {
    if (!root) return;
    const inputs = new Set();
    root.querySelectorAll?.('[data-duration] input')?.forEach(el => inputs.add(el));
    root.querySelectorAll?.('input[name="duration.value"]')?.forEach(el => inputs.add(el));
    root.querySelectorAll?.('input[id$="-duration.value"]')?.forEach(el => inputs.add(el));
    // Prefer the draft's formula when the sheet is mid-edit — otherwise
    // the intermediate re-render after a structural change would clobber
    // the user's typed "2d6" back to the persisted value (empty or an
    // older formula). Draft is undefined for the base ActiveEffectConfig
    // and for WitcherActiveEffectConfig instances with nothing in flight.
    const draftFormula = app?.pendingDraft?.flags?.[SYSTEM_ID]?.durationFormula;
    const documentFormula = app?.document?.flags?.[SYSTEM_ID]?.durationFormula;
    const storedFormula = String(draftFormula ?? documentFormula ?? "").trim();
    let firstInput = null;
    for (const input of inputs) {
        firstInput ??= input;
        if (input.type !== "text") {
            input.type = "text";
            input.setAttribute("inputmode", "numeric");
            input.setAttribute("placeholder", "5 or 1d6+2");
            input.dataset.wdmDurationFlipped = "1";
        }
        /* Echo the stored formula whenever the field would otherwise show
         * `0` (or is empty). Foundry re-renders after `_processFormData`
         * writes `duration.value = 0`, so the field lands at 0 on the
         * next render — this replaces it with the raw formula so the user
         * sees their input persisted. */
        if (storedFormula && (input.value === "" || input.value === "0")) {
            input.value = storedFormula;
        }
    }
    /* Append a hint under the duration form-group. Runs from here (not
     * the per-instance _onRender) because that method didn't reliably
     * fire on every rebuild — this hook is guaranteed by Foundry's
     * render lifecycle. Idempotent via `.wdm-duration-dice-hint` check. */
    if (firstInput) {
        const group = firstInput.closest?.("[data-duration]")
                   ?? firstInput.closest?.(".form-group")
                   ?? firstInput.parentElement?.parentElement;
        if (group && !group.querySelector(".wdm-duration-dice-hint")) {
            const hint = document.createElement("p");
            hint.className = "hint wdm-duration-dice-hint";
            const key = "WITCHER.Effect.DurationDiceHint";
            const localized = game.i18n.localize(key);
            /* `localize` returns the key itself when the entry is missing —
             * detect that so we can fall back to the English string. */
            hint.textContent = localized && localized !== key
                ? localized
                : "Also accepts a dice expression (e.g. 1d6, 2d10+3) — rolled fresh each time this effect is applied.";
            group.appendChild(hint);
        }
    }
}

Hooks.on("renderActiveEffectConfig", (app, html) => {
    const root = html instanceof HTMLElement ? html : html?.[0];
    flipDurationInput(root, app);
});
/* Foundry v14 fires hooks up the inheritance chain (renderXxx for each class
 * in the constructor chain), so `renderActiveEffectConfig` catches the base
 * class and the WitcherActiveEffectConfig subclass alike. The subclass hook
 * is registered too for defense — some render paths early-return before
 * dispatching parent hooks. */
Hooks.on("renderWitcherActiveEffectConfig", (app, html) => {
    const root = html instanceof HTMLElement ? html : html?.[0];
    flipDurationInput(root, app);
});

export class WitcherActiveEffectConfig extends ActiveEffectConfig {

    static DEFAULT_OPTIONS = {
        classes: ["witcher-ttrpg-death-march"],
        // Draft-state editing: field changes stay in-memory (and in the DOM)
        // until the user clicks Submit Changes. Structural events (adding /
        // deleting an action row, changing an action's type dropdown) snapshot
        // the form into a draft and re-render from it so the interface can
        // morph (e.g., picking "heal" swaps in that type's fields) without
        // touching the persisted document. `submitOnChange: false` disables
        // the per-keystroke round-trip; `closeOnSubmit: true` closes on Save.
        form: { submitOnChange: false, closeOnSubmit: true },
        actions: {
            addAction:    WitcherActiveEffectConfig.#onAddAction,
            deleteAction: WitcherActiveEffectConfig.#onDeleteAction,
            browseTarget: WitcherActiveEffectConfig.#onBrowseTarget
        }
    };

    /** Draft state — a snapshot of the current form merged over the
     *  document, held in memory across re-renders. `null` when the user
     *  hasn't made any edits (or after a successful Submit / Discard).
     *  Populated by `#snapshotDraft()` on any structural event that needs
     *  a re-render, so the new render reads the in-progress state instead
     *  of the persisted document. Reads via `#readDraft(path)`. */
    #draft = null;

    /** Snapshot the current form into the draft, merged over the document's
     *  current source. Idempotent — repeated calls refresh the draft from
     *  the latest form state so any typing between structural events is
     *  captured. Returns the draft. */
    #snapshotDraft() {
        const formData = new foundry.applications.ux.FormDataExtended(this.form);
        const submitData = this._processFormData(null, this.form, formData);
        this.#draft = foundry.utils.mergeObject(this.document.toObject(), submitData, { inplace: false });
        return this.#draft;
    }

    /** Read a dotted path from the draft when present, else from the live
     *  document. Use this in `_preparePartContext` anywhere a part reads
     *  from `this.document.flags[SYSTEM_ID]` so the render reflects the
     *  in-progress state. */
    #readDraft(path) {
        if (this.#draft) return foundry.utils.getProperty(this.#draft, path);
        return foundry.utils.getProperty(this.document, path);
    }

    /** Public accessor for the in-progress draft. Returns `null` when no
     *  draft is active. Consumed by the module-level `flipDurationInput`
     *  render hook so it can echo a typed-but-unsubmitted duration formula
     *  back into the field on re-render (private `#draft` isn't reachable
     *  from that scope). Do not mutate the returned object. */
    get pendingDraft() { return this.#draft; }

    /** True if the current form state differs from the persisted document.
     *  Cheap enough to call from `close()` — reads the form once and diffs. */
    #hasUnsavedChanges() {
        try {
            const formData = new foundry.applications.ux.FormDataExtended(this.form);
            const submitData = this._processFormData(null, this.form, formData);
            const diff = foundry.utils.diffObject(this.document.toObject(), submitData);
            return !foundry.utils.isEmpty(diff);
        } catch (_) { return false; }
    }

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
        // Custom status tab — item-local clause authoring so an oil / potion /
        // custom AE can define its OWN status effect (id, description, mods,
        // restrict, DoT) without polluting the world Status Effects registry.
        // The clause is read via statusEngine.clauseFor(id, actor) which
        // checks the actor's active AEs before falling back to the registry.
        customStatus: {
            template: `systems/${SYSTEM_ID}/templates/active-effect/custom-status.hbs`,
            scrollable: [""]
        },
        footer:   { template: "templates/generic/form-footer.hbs" }
    };

    static TABS = {
        sheet: {
            tabs: [
                { id: "details",      icon: "fa-solid fa-book" },
                { id: "duration",     icon: "fa-solid fa-clock" },
                { id: "effects",      icon: "fa-solid fa-wand-magic-sparkles" },
                { id: "customStatus", icon: "fa-solid fa-heart-crack" }
            ],
            initial: "details",
            labelPrefix: "EFFECT.TABS"
        }
    };

    /** Build the Effects-tab context. Each stored action is rendered to an
     *  HTML string here (mirroring the codebase's row-render pattern) so the
     *  tab template just emits them; the row context carries both the row's
     *  own view-model and the shared option lists it needs. */
    /** Overlay the draft onto `context.source` so every standard form field
     *  ({{source.name}}, {{source.disabled}}, {{source.description}},
     *  {{source.duration.value}} etc.) renders the in-progress state instead
     *  of the persisted document. Only kicks in while a structural event has
     *  populated a draft; ordinary reads still see the live document. */
    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        if (this.#draft) ctx.source = this.#draft;
        return ctx;
    }

    async _preparePartContext(partId, context) {
        const ctx = await super._preparePartContext(partId, context);
        if (partId === "customStatus") {
            const cs = this.#readDraft(`flags.${SYSTEM_ID}.customStatus`) ?? {};
            const stats = ["int","ref","dex","body","spd","emp","cra","will","luck"];
            const rolls = [
                { key: "attack",    label: t("WITCHER.Sheet.Effect.Config.Dialog.Button.Attack", "Attack") },
                { key: "defense",   label: t("WITCHER.Sheet.Effect.Config.Dialog.Button.Defense", "Defense") },
                { key: "awareness", label: t("WITCHER.Sheet.Effect.Config.Dialog.Button.AwarenessSight", "Awareness (sight)") },
                { key: "all",       label: t("WITCHER.Sheet.Effect.Config.Dialog.Button.AllRolls", "All rolls") },
                { key: "verbal",    label: t("WITCHER.Sheet.Effect.Config.Dialog.Button.VerbalCombat", "Verbal Combat") }
            ];
            const derived = [
                { key: "recovery", label: t("WITCHER.Sheet.Effect.Config.Dialog.Button.Recovery", "Recovery") },
                { key: "stun",     label: t("WITCHER.Sheet.Effect.Config.Dialog.Button.StunDC", "Stun DC") },
                { key: "enc",      label: t("WITCHER.Sheet.Effect.Config.Dialog.Button.Encumbrance", "Encumbrance") },
                { key: "run",      label: t("WITCHER.Sheet.Effect.Config.Dialog.Button.RunMult", "Run mult.") },
                { key: "leap",     label: t("WITCHER.Sheet.Effect.Config.Dialog.Button.LeapMult", "Leap mult.") }
            ];
            const base = `flags.${SYSTEM_ID}.customStatus`;
            ctx.cs = {
                base,
                enabled:      !!cs.enabled,
                id:           String(cs.id ?? ""),
                description:  String(cs.description ?? ""),
                statRows:    stats.map(k =>   ({ key: k, label: k.toUpperCase(), value: cs.mods?.stats?.[k]   ?? "" })),
                rollRows:    rolls.map(r =>   ({ ...r,                            value: cs.mods?.roll?.[r.key]  ?? "" })),
                derivedRows: derived.map(r => ({ ...r,                            value: cs.mods?.derived?.[r.key] ?? "" })),
                statModCount:    stats.reduce((n, k)   => n + (Number(cs.mods?.stats?.[k]) ? 1 : 0), 0),
                rollModCount:    rolls.reduce((n, r)   => n + (Number(cs.mods?.roll?.[r.key]) ? 1 : 0), 0),
                derivedModCount: derived.reduce((n, r) => n + (Number(cs.mods?.derived?.[r.key]) ? 1 : 0), 0),
                restrict: {
                    act:    !!cs.restrict?.act,
                    defend: !!cs.restrict?.defend,
                    move:   !!cs.restrict?.move,
                    hard:   !!cs.restrict?.hard
                },
                incomingDC:  cs.incomingDC ?? "",
                dot: {
                    amount:        String(cs.dot?.amount ?? ""),
                    cadence:       Number(cs.dot?.cadence ?? 1),
                    ablateArmor:   String(cs.dot?.ablateArmor  ?? ""),
                    ablateArmorOnlyIfPenetrated: !!cs.dot?.ablateArmorOnlyIfPenetrated,
                    ablateWeapon:  String(cs.dot?.ablateWeapon ?? ""),
                    ablateWeaponOnlyIfPenetrated: !!cs.dot?.ablateWeaponOnlyIfPenetrated,
                    throughArmor:  !!cs.dot?.throughArmor,
                    everyLocation: !!cs.dot?.everyLocation,
                    damageType:    String(cs.dot?.damageType ?? ""),
                    // Damage type dropdown — sourced from CONFIG.WITCHER.damageTypes
                    // so it stays in lockstep with the weapon/spell damage-type
                    // vocabulary. Used by applyDamageAction to look up monster
                    // damageProfile (immune → 0×, resistant → 0.5×, vulnerable
                    // → 2×). Empty = untyped, no resistance/vulnerability check.
                    damageTypeOptions: (() => {
                        const map = CONFIG.WITCHER?.damageTypes ?? {};
                        return Object.entries(map)
                            .map(([value, key]) => ({ value, label: game.i18n.localize(key) }))
                            .sort((a, b) => a.label.localeCompare(b.label));
                    })()
                },
                endCheck: {
                    kind:       String(cs.endCheck?.kind ?? "none"),
                    skill:      String(cs.endCheck?.skill ?? ""),
                    dc:         cs.endCheck?.dc ?? "",
                    actionCost: cs.endCheck?.actionCost ?? "",
                    // Skill dropdown options — pulled from CONFIG.WITCHER.skillMap
                    // (labels via WITCHER.skills.<key>.label), sorted A-Z. Same
                    // source the world Status Effects editor uses so the two
                    // stay in lockstep.
                    skillOptions: (() => {
                        const map = CONFIG.WITCHER?.skillMap ?? {};
                        const label = (k) => game.i18n.localize(CONFIG.WITCHER?.skillLabel?.(k) ?? k);
                        return Object.keys(map)
                            .filter(k => typeof map[k] === "object")
                            .map(k => ({ value: k, label: label(k) }))
                            .sort((a, b) => a.label.localeCompare(b.label));
                    })()
                },
                clearsAtOwnTurn: !!cs.clearsAtOwnTurn,
                clearsAtOwnTurnEnd: !!cs.clearsAtOwnTurnEnd,
                clearOnHit:      !!cs.clearOnHit,
                periodic: {
                    every:     cs.periodic?.every ?? "",
                    rollUnder: String(cs.periodic?.rollUnder ?? "")
                },
                // "Counts as" — list of existing status ids this custom status
                // should be treated as for resistance / immunity checks. Sourced
                // from CONFIG.statusEffects, sorted A-Z. Multi-select so you can
                // author "counts as poisoned + necrotic" (etc.). Stored as an
                // array of ids on the flag.
                countsAs:        Array.isArray(cs.countsAs) ? cs.countsAs.map(String) : [],
                countsAsCount:   Array.isArray(cs.countsAs) ? cs.countsAs.length : 0,
                countsAsOptions: (() => {
                    const list = Array.isArray(CONFIG.statusEffects) ? CONFIG.statusEffects : [];
                    const selected = new Set((Array.isArray(cs.countsAs) ? cs.countsAs : []).map(String));
                    return list
                        .filter(s => s?.id)
                        .map(s => ({
                            value: s.id,
                            label: game.i18n.localize(s.name ?? s.label ?? s.id),
                            selected: selected.has(s.id)
                        }))
                        .sort((a, b) => a.label.localeCompare(b.label));
                })()
            };
            return ctx;
        }
        if (partId !== "effects") return ctx;

        const rawActions = this.#readDraft(`flags.${SYSTEM_ID}.actions`);
        const actions = Array.isArray(rawActions) ? rawActions : [];

        const shared = {
            operationOptions:     effectOperationOptions(),
            triggerOptions:       effectTriggerOptions(),
            actionTypeOptions:    effectActionTypeOptions(),
            healConditionOptions: tickHealConditionOptions(),
            suppressOptions:      suppressTargetOptions(),
            immunityOptions:      statusImmunityOptions(),
            visionTypeOptions:    visionTypeOptions(),
            visionModeOptions:    DARK_VISION_MODES.map(m => ({
                value: m.value,
                label: game.i18n.localize(m.labelKey) || m.value,
                hint:  game.i18n.localize(m.hintKey) || ""
            }))
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
            isClearHangover:        type === "clearHangover",
            isStressShield:         type === "stressShield",
            isAdrenalineCostDelta:  type === "adrenalineStaCostDelta",
            // vision: grant a night-vision tier; Dark Vision also carries range + mode
            isVision:        type === "vision",
            isVisionDark:    type === "vision" && (a?.visionType ?? "night") === "dark",
            visionTypePath:  `${base}.visionType`,  visionType:  a?.visionType ?? "night",
            visionRangePath: `${base}.visionRange`, visionRange: a?.visionRange ?? "",
            visionModePath:  `${base}.visionMode`,  visionMode:  a?.visionMode ?? "monochromatic",
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
            // heal cadence — "turn" (default), "minute", "hour", "day". Non-
            // turn cadences fire on world-time crossings instead of per turn.
            cadencePath: `${base}.cadence`, cadence: a?.cadence ?? "turn",
            // damage
            formulaPath:      `${base}.formula`,      formula: a?.formula ?? "",
            locationsPath:    `${base}.locations`,
            throughArmorPath: `${base}.throughArmor`, throughArmor: !!a?.throughArmor,
            /* Ablation values accept a flat integer OR a dice formula
             * ("1d6", "1d3+1") — evaluated per tick via rollOrFlat.
             * Stored as string so the formula survives round-trip. */
            ablateArmorPath:  `${base}.ablateArmor`,  ablateArmor: String(a?.ablateArmor ?? ""),
            /* Ablation gates — when true, SP / reliability erosion
             * only fires if the damage actually penetrated the target
             * (post-SP damage > 0). Default false: corrosive DoTs
             * eat armor whether or not the tick hurt the wearer. */
            ablateArmorOnlyIfPenetratedPath: `${base}.ablateArmorOnlyIfPenetrated`,
            ablateArmorOnlyIfPenetrated:     !!a?.ablateArmorOnlyIfPenetrated,
            /* Weapon ablation — chip N points of reliability off each
             * of the target's equipped weapons per tick (corrosive /
             * rust-inducing effects). Accepts formulas too. */
            ablateWeaponPath: `${base}.ablateWeapon`, ablateWeapon: String(a?.ablateWeapon ?? ""),
            ablateWeaponOnlyIfPenetratedPath: `${base}.ablateWeaponOnlyIfPenetrated`,
            ablateWeaponOnlyIfPenetrated:     !!a?.ablateWeaponOnlyIfPenetrated,
            // suppress
            whatPath: `${base}.what`, what: a?.what ?? "death",
            // immunity
            statusPath: `${base}.status`, status: a?.status ?? "",
            // stress shield — kind (points/sources) + buffer dice
            kindPath: `${base}.kind`, kind: a?.kind ?? "points",
            dicePath: `${base}.dice`, dice: a?.dice ?? "1d6",
            // adrenaline STA cost delta — signed integer per adrenaline die
            deltaPath:  `${base}.delta`, delta: a?.delta ?? 0
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
        this.#injectImmediateToggle();
        this.#injectDurationDiceHint();
        this.#relaxDurationInputType();
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

    /** Append the "Immediate" toggle to the Duration tab. When set, the AE
     *  fires its onApply actions on create then auto-deletes (a fire-and-
     *  forget effect: "stun bomb explodes → applies Stunned to targets
     *  → bomb AE removes itself"). Persistent stat modifiers should leave
     *  this OFF; their `changes` need the AE alive to fold into
     *  prepareDerivedData.
     *
     *  NB: earlier this method also injected a dedicated "Duration formula
     *  (dice)" input bound to `flags.<sys>.durationFormula`. That input is
     *  gone — dice-code entry is now supported directly in the core
     *  `duration.value` field via `_processFormData`'s reroute, which
     *  writes to the same flag. The dedicated input duplicated the write
     *  path and could double-post on submit. */
    #injectImmediateToggle() {
        const root = this.element;
        const tab = root?.querySelector('[data-application-part="duration"]')
                 ?? root?.querySelector('.tab[data-tab="duration"]');
        if (!tab) return;
        const immediateName = `flags.${SYSTEM_ID}.immediate`;
        if (tab.querySelector(`input[name="${immediateName}"]`)) return;
        const immGroup = document.createElement("div");
        immGroup.className = "form-group";
        const checked = this.document.flags?.[SYSTEM_ID]?.immediate ? "checked" : "";
        immGroup.innerHTML =
            `<label>${game.i18n.localize("WITCHER.Effect.Immediate") || "Immediate"}</label>` +
            `<div class="form-fields"><input type="checkbox" name="${immediateName}" ${checked} /></div>` +
            `<p class="hint">${game.i18n.localize("WITCHER.Effect.ImmediateHint")
                || "Fire this effect's actions on create, then delete the effect. Use for one-shot triggers (apply a status, deal damage); leave OFF for persistent stat modifiers."}</p>`;
        tab.appendChild(immGroup);
    }

    /** Insert a one-line hint under the standard Duration form-group letting
     *  the author know the value field accepts a dice expression as well as
     *  a fixed integer. Rendered as a `.hint` paragraph to match Foundry's
     *  own duration-tab hint styling. Selector fallback chain covers v14
     *  DOM (which drops `data-duration` in some paths): walk from the
     *  `duration.value` input up to its enclosing `.form-group`. */
    #injectDurationDiceHint() {
        const root = this.element;
        if (!root) return;
        const input = root.querySelector('input[name="duration.value"]')
                   ?? root.querySelector('input[id$="-duration.value"]');
        const group = root.querySelector('[data-duration]')
                   ?? input?.closest?.(".form-group")
                   ?? input?.parentElement?.parentElement;
        if (!group || group.querySelector('.wdm-duration-dice-hint')) return;
        const hint = document.createElement("p");
        hint.className = "hint wdm-duration-dice-hint";
        hint.textContent = game.i18n.localize("WITCHER.Effect.DurationDiceHint")
            || "Also accepts a dice expression (e.g. 1d6, 2d10+3) — rolled fresh each time this effect is applied.";
        group.appendChild(hint);
    }

    /** Convert the schema-generated `<input type="number">` on the
     *  duration.value field into a plain text input so the user can
     *  actually type "d". A `type="number"` element rejects non-digit keys
     *  at the browser level, so `_onChangeForm` never sees a dice string.
     *
     *  Runs on every render, AND installs a bubbling `focusin` listener
     *  on the app root that flips any duration.value input to text the
     *  moment it gains focus — so even if a mid-typing re-render re-
     *  creates the field as type="number", the user's next click/tab
     *  lands on a text input. */
    #relaxDurationInputType() {
        const root = this.element;
        if (!root) return;
        /* If the AE carries a stored formula, echo it into the duration
         * input on render so the user sees their formula back — otherwise
         * they'd just see a bare 0 and think their input didn't take. */
        const storedFormula = String(this.document.flags?.[SYSTEM_ID]?.durationFormula ?? "").trim();
        const flip = (input) => {
            if (!input) return;
            if (input.type !== "text") {
                input.type = "text";
                input.setAttribute("inputmode", "numeric");
                input.setAttribute("placeholder", "5 or 1d6+2");
            }
            if (storedFormula && (input.value === "" || input.value === "0")) {
                input.value = storedFormula;
            }
        };
        const findAll = () => {
            const set = new Set();
            root.querySelectorAll('[data-duration] input').forEach(el => set.add(el));
            root.querySelectorAll('input[name="duration.value"]').forEach(el => set.add(el));
            root.querySelectorAll('input[id$="-duration.value"]').forEach(el => set.add(el));
            return set;
        };
        for (const input of findAll()) flip(input);

        if (root.dataset.wdmDurationFlipWired === "1") return;
        root.dataset.wdmDurationFlipWired = "1";
        root.addEventListener("focusin", (ev) => {
            const el = ev.target;
            if (!(el instanceof HTMLInputElement)) return;
            const name  = el.getAttribute("name") || "";
            const idAtt = el.id || "";
            const inDur = !!el.closest?.("[data-duration]");
            if (name === "duration.value" || idAtt.endsWith("-duration.value") || inDur) flip(el);
        }, true);
    }

    /** flags.<sys>.actions arrives from the form as an index-keyed object
     *  (expandObject turns "actions.0.x" into {0:{x}}). Convert it back to a
     *  real array so the stored flag is an array, not {0:…,1:…}. */
    _processFormData(event, form, formData) {
        const submitData = super._processFormData(event, form, formData);
        /* Duration dice reroute: `duration.value` is a NumberField, so a
         * dice string like "2d6" would blow the schema check at
         * validate(). Detect it here, before validation runs, and route
         * it to `flags.<sys>.durationFormula` (rolled fresh at each
         * apply — see documents/activeEffect.mjs `_preCreate`). A plain
         * number clears the stale formula so the number wins next apply. */
        const dvRaw = foundry.utils.getProperty(submitData, "duration.value");
        if (typeof dvRaw === "string") {
            const dv = dvRaw.trim();
            if (/d\d/i.test(dv)) {
                foundry.utils.setProperty(submitData, "duration.value", 0);
                foundry.utils.setProperty(submitData, `flags.${SYSTEM_ID}.durationFormula`, dv);
            } else if (/^\d+$/.test(dv)) {
                foundry.utils.setProperty(submitData, "duration.value", Number(dv));
                if (this.document.flags?.[SYSTEM_ID]?.durationFormula) {
                    foundry.utils.setProperty(submitData, `flags.${SYSTEM_ID}.durationFormula`, "");
                }
            } else if (dv === "") {
                // Empty → no duration. Must be null, NOT 0. Foundry's isTemporary
                // returns true for Number.isFinite(0), which would enroll the AE
                // in the ActiveEffectRegistry with remaining=0 and immediately
                // expire it on the next updateWorldTime tick (the time-flow
                // ticker fires every real second when the primary GM is on).
                // A NEW AE stays permanent this way; clearing a previously-set
                // duration also correctly returns the AE to permanent.
                foundry.utils.setProperty(submitData, "duration.value", null);
                if (this.document.flags?.[SYSTEM_ID]?.durationFormula) {
                    foundry.utils.setProperty(submitData, `flags.${SYSTEM_ID}.durationFormula`, "");
                }
            }
        }
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
        // Custom Status "Counts as" — the template renders per-status checkboxes
        // with `data-cs-countsas-id` attributes and NO `name` attribute (so they
        // never touch submitData directly). Collect the checked ones into the
        // canonical array shape here so downstream readers (statusEngine,
        // status-immunity policy) see the same array they always saw. Runs only
        // when the checkboxes are actually present in the DOM — collapsed
        // custom-status sections leave the stored array untouched.
        const csBoxes = (form ?? this.form)?.querySelectorAll?.("input[data-cs-countsas-id]") ?? [];
        if (csBoxes.length) {
            const arr = [...csBoxes].filter(b => b.checked).map(b => b.dataset.csCountsasId);
            // Only write when the array actually needs to change: skip when
            // both sides are empty (no false-positive diff for a purely
            // untouched panel) but do write when the user just unchecked
            // everything on a previously-populated list (so the persisted
            // array actually gets cleared).
            const existing = this.document?.flags?.[SYSTEM_ID]?.customStatus?.countsAs;
            const existingNonEmpty = Array.isArray(existing) && existing.length > 0;
            if (arr.length || existingNonEmpty) {
                foundry.utils.setProperty(submitData, `flags.${SYSTEM_ID}.customStatus.countsAs`, arr);
            }
        }
        return submitData;
    }

    /** Capture the currently-focused named field (+ its selection range for
     *  text/textarea) and every scrolled container's position before an
     *  explicit re-render fires; `_onRender` restores them. Called from any
     *  structural event (type-picker change, add / delete row) that mutates
     *  the draft and re-renders. Non-structural edits stay in the DOM and
     *  never trigger a render, so no capture is needed for typing. */
    #capturePendingFocusAndScroll() {
        const active = document.activeElement;
        if (active && this.form?.contains(active)) {
            const key = active.getAttribute("name")
                     || active.dataset?.csCountsasId
                     || active.dataset?.focusKey;
            if (key) {
                this._pendingFocus = { key };
                if (typeof active.selectionStart === "number") {
                    this._pendingFocus.start = active.selectionStart;
                    this._pendingFocus.end   = active.selectionEnd;
                }
            }
        }
        this._pendingScroll = [];
        const scrollers = this.form?.querySelectorAll(".tab.scrollable, .scrollable, .wdm-cs-details-body") ?? [];
        for (const s of scrollers) {
            if (!s.scrollTop && !s.scrollLeft) continue;
            const locator = _scrollLocator(s);
            if (!locator) continue;
            this._pendingScroll.push({ locator, top: s.scrollTop, left: s.scrollLeft });
        }
    }

    /** Handle form-input change events. With `submitOnChange: false`, every
     *  ordinary field change (name, description, duration, action values)
     *  just sits in the DOM until Submit — no round-trip, no re-render, no
     *  document write. The one exception is the action-row type picker: the
     *  row's field set morphs with type, so we snapshot the form into the
     *  draft (so any in-progress typing survives) and re-render locally to
     *  swap in that type's template. Phase is not set here — the compiler
     *  derives it from the key (see compileActionsToChanges / phaseForKey).
     *  Duration dice-code entry ("2d6") is normalized in `_processFormData`
     *  at Submit time, not here. */
    _onChangeForm(formConfig, event) {
        const picker = event.target;
        if (picker?.classList?.contains("wdm-action-type-picker")) {
            // Mirror the chosen type into the hidden named input so the
            // form snapshot picks it up when we re-render below.
            const typeInput = picker.closest("li")?.querySelector("input[data-type-input]");
            if (typeInput) typeInput.value = picker.value;
            this.#snapshotDraft();
            this.#capturePendingFocusAndScroll();
            this.render();
            return;
        }
        // Vision-type sub-select morphs the row (Dark Vision reveals range + mode).
        // It's a directly-named input, so no hidden-input mirroring is needed —
        // just snapshot the form and re-render locally.
        if (picker?.classList?.contains("wdm-vision-type-picker")) {
            this.#snapshotDraft();
            this.#capturePendingFocusAndScroll();
            this.render();
            return;
        }
        // "Make Status Condition" toggle — the whole status-clause section is
        // gated behind {{#if cs.enabled}}, so flipping it must re-render to
        // reveal (or hide) the id / description / mods / DoT fields. Same
        // snapshot-then-render pattern as the pickers above.
        if (picker?.name === `flags.${SYSTEM_ID}.customStatus.enabled`) {
            this.#snapshotDraft();
            this.#capturePendingFocusAndScroll();
            this.render();
            return;
        }
        // Non-structural change → do nothing. DOM holds the value until Submit.
        super._onChangeForm(formConfig, event);
    }

    _onRender(context, options) {
        super._onRender?.(context, options);
        const root = this.form;

        // Restore scroll positions BEFORE focus so focus() doesn't scroll the
        // focused element into a viewport that hasn't been settled yet.
        const scrolls = this._pendingScroll;
        this._pendingScroll = null;
        if (scrolls?.length && root) {
            for (const s of scrolls) {
                const el = root.querySelector(s.locator);
                if (!el) continue;
                el.scrollTop  = s.top;
                el.scrollLeft = s.left;
            }
        }

        const pf = this._pendingFocus;
        if (!pf || !root) return;
        this._pendingFocus = null;
        // Try named field first; fall back to countsAs checkboxes (identified
        // by data attribute, not by name).
        const el = root.querySelector(`[name="${CSS.escape(pf.key)}"]`)
                ?? root.querySelector(`input[data-cs-countsas-id="${CSS.escape(pf.key)}"]`);
        if (!el) return;
        try { el.focus({ preventScroll: true }); } catch (_) { el.focus(); }
        if (typeof pf.start === "number" && typeof el.setSelectionRange === "function") {
            try { el.setSelectionRange(pf.start, pf.end ?? pf.start); } catch (_) { /* selection unsupported */ }
        }
    }

    /* ── Add / delete action rows ─────────────────────────────────────── */

    /** Clear the draft once the update lands. Subsequent renders (including
     *  the close animation) then read from the persisted document rather
     *  than the (now-committed) draft. Called via the Submit Changes
     *  button's form-submit flow; close-with-unsaved handling is in
     *  `close()` below. */
    async _processSubmitData(event, form, submitData, options) {
        await super._processSubmitData(event, form, submitData, options);
        this.#draft = null;
    }

    /** Guard the close path when there's unsaved work. Skipped when Foundry
     *  is closing us as part of a successful submit (`options.submitted`)
     *  or when the caller passes `force: true`. Otherwise diff the current
     *  form against the persisted document and, if different, offer the
     *  user Discard / Cancel. Cancel returns without closing. Save-and-
     *  close is intentionally NOT offered — the Submit Changes button in
     *  the footer is the explicit path for that, so the prompt keeps a
     *  single unambiguous save affordance. */
    async close(options = {}) {
        if (options.submitted || options.force) return super.close(options);
        if (!this.#hasUnsavedChanges()) return super.close(options);
        const discard = await foundry.applications.api.DialogV2.confirm({
            window: { title: t("WITCHER.Dialog.UnsavedChanges", "Unsaved Changes") },
            content: `<p>${t("WITCHER.Sheet.Effect.UnsavedChangesBody",
                "This effect has unsaved changes. Discard them?")}</p>`,
            yes: { label: t("WITCHER.Common.Discard", "Discard"), icon: "fa-solid fa-trash" },
            no:  { label: t("WITCHER.Common.Cancel", "Cancel"),   icon: "fa-solid fa-xmark", default: true }
        });
        if (!discard) return this;
        this.#draft = null;
        return super.close(options);
    }

    /** Append a new Modify row (the safe default — pure stat change).
     *  Snapshots the current form into the draft so in-progress edits are
     *  preserved, mutates the draft's actions array, then re-renders from
     *  the draft. No document write — the change lands only when the user
     *  clicks Submit Changes. */
    static async #onAddAction() {
        const draft = this.#snapshotDraft();
        foundry.utils.setProperty(draft, `flags.${SYSTEM_ID}.actions`,
            [...(foundry.utils.getProperty(draft, `flags.${SYSTEM_ID}.actions`) ?? []),
             { type: "modify", target: "", op: "add", value: "", when: "always" }]);
        this.#capturePendingFocusAndScroll();
        return this.render();
    }

    /** Remove the action row whose delete button was clicked. Draft-only
     *  like #onAddAction — the removal persists only on Submit Changes. */
    static async #onDeleteAction(event) {
        const draft = this.#snapshotDraft();
        const index = Number(event.target.closest("li")?.dataset.index) || 0;
        const current = foundry.utils.getProperty(draft, `flags.${SYSTEM_ID}.actions`) ?? [];
        const next = [...current];
        next.splice(index, 1);
        foundry.utils.setProperty(draft, `flags.${SYSTEM_ID}.actions`, next);
        this.#capturePendingFocusAndScroll();
        return this.render();
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

/* Build a stable CSS selector that identifies `el` inside the form after a
 * re-render. Preference order:
 *   1. Its containing <section class="tab"> data-tab attribute (unique per tab
 *      in this sheet) — plus a class-based tail to pick between the tab root
 *      and inner scrollables like <details>-body.
 *   2. Fallback: tag + a stable class subset.
 * Returns null if we can't build a reliable selector — caller skips restore
 * for that element rather than risking a mismatch. */
function _scrollLocator(el) {
    if (!el) return null;
    // Tab root itself?
    if (el.matches?.(".tab[data-tab]")) {
        return `.tab[data-tab="${CSS.escape(el.dataset.tab)}"]`;
    }
    // Scrollable inside a tab — anchor to the parent tab's data-tab then a
    // class-based descendant selector.
    const tab = el.closest?.(".tab[data-tab]");
    if (tab?.dataset?.tab) {
        const cls = [...el.classList].find(c => c.startsWith("wdm-"));
        if (cls) return `.tab[data-tab="${CSS.escape(tab.dataset.tab)}"] .${CSS.escape(cls)}`;
    }
    return null;
}
