/**
 * CombatActionsEditor — the GM-facing form for tuning the Combat Extended
 * attack and defense actions. Opens from Configure Settings → "Combat
 * Actions" (the menu is only attached when the extendedCombat homebrew
 * toggle is on).
 *
 * One row per action, grouped by kind (Attacks first, then Defenses). The
 * editable knobs come straight from `EDITABLE_FIELDS` in
 * `module/data/combatExtended/actions.mjs` — keep that list authoritative
 * if you add a knob.
 *
 * Storage: the form diffs each row against its seed default; rows equal to
 * default are dropped, so an untouched catalog persists `{}`. The result
 * is written to the `combatActionsOverride` world setting, which
 * `getActiveCombatActions()` merges over the defaults at read time.
 */

import {
    DEFAULT_COMBAT_ACTIONS, EDITABLE_FIELDS,
    actionLabel, actionDescription
} from "../data/combatExtended/actions.mjs";
import { CE_SUBSYSTEM_DEFAULTS } from "../api/homebrew.mjs";

import { t, tFormat } from "../chrome/lib/i18n.js";
const SYSTEM_ID = "witcher-ttrpg-death-march";
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/* Per-subsystem toggle metadata. Drives the editor's Subsystems section
 * + the save-time diff. Keys mirror CE_SUBSYSTEM_DEFAULTS. */
const SUBSYSTEM_META = Object.freeze([
    { key: "guards",       label: "Guard stances",
      hint: "Balanced / Warding / Closed / Fool's stances + dock guard button + per-weapon Warding location pick." },
    { key: "raiseShield",  label: "Raise Shield",
      hint: "Per-shield Raise Shield button + coverage picker + Restricted Vision on head cover + damage routing through shield reliability." },
    { key: "actionCosts",  label: "Combat-Extended action costs",
      hint: "Use the CE attack catalog (revised STA costs + new actions: Push, Bash, Clinch, Lunge, Impale, Ride, Escape, Pin, Chokehold). Disable to fall back to the RAW STRIKE_TYPES." },
    { key: "defenseCosts", label: "Combat-Extended defense costs",
      hint: "Apply the CE defense costs (Parry 0 / Block 0 / Dodge 1 / Reposition 2) and the additive +1 STA per defense past the first. Disable to fall back to RAW (1st free, +1 each extra)." },
    { key: "eoArmorModel", label: "EO armor model (arming jacks + new EV)",
      hint: "Equipment Overhaul: armor EV reduces max Stamina + RUN (floor 2×SPD) and applies half-EV penalty to Dodge/Athletics/Stealth/Sleight/Endurance/Hexweave/Ritcraft/Spellcast (instead of subtracting from REF/DEX); armor with Difficult requires a worn arming jack to equip; Superior Arming Suit reduces each worn Difficult piece's EV by 1; per-location AE slots + separate En (glyph) slot pool." }
]);

/* Extra tuneables — secondary knobs that live alongside the subsystem
 * toggles. Each entry maps to a `combatExtendedTuneables` setting key
 * and renders a single checkbox or numeric input. Default values come
 * from CE_TUNEABLE_DEFAULTS. */
const TUNEABLE_META = Object.freeze([
    { key: "additiveDefenseRecurrence", kind: "boolean", default: true,
      label: "Additive defense recurrence",
      hint: "ON: every defense past the 1st adds +1 STA to the action's BASE cost (so 2nd Parry = 0+1, 2nd Dodge = 1+1, 2nd Relocate = 2+1). OFF: per-defense base cost only — no recurrence." },
    { key: "raiseShieldAutoBalanced", kind: "boolean", default: true,
      label: "Raise Shield → Balanced guard",
      hint: "ON: raising a shield automatically returns the actor to a Balanced guard (rules1). OFF: the actor keeps their current guard." },
    { key: "headCoverAppliesRestrictedVision", kind: "boolean", default: true,
      label: "Head cover → Restricted Vision",
      hint: "ON: when Raise Shield covers the head, the actor gets the Restricted Vision status (−2 to Block/Parry/Dodge until next turn). OFF: skip the status." },
    { key: "heftyBlocksFastStrike", kind: "boolean", default: true,
      label: "Hefty weapons block Fast Strike",
      hint: "House variant: ON: Hefty weapons remove Fast Strike from the strike picker entirely (use Single Attack instead). OFF: Hefty allows Fast Strike but clamps to one attack (EO RAW)." }
]);
export const CE_TUNEABLE_DEFAULTS = Object.freeze(
    Object.fromEntries(TUNEABLE_META.map(t => [t.key, t.default]))
);

/* Field metadata per kind. The editor iterates this to render the inputs
 * AND to drive the save-time diff — keeping rendering + storage on the
 * same schema means there's exactly ONE list to keep in sync. */
const FIELD_META = Object.freeze({
    attack: Object.freeze([
        { key: "staCost",   type: "number",  label: "STA"      },
        { key: "toHit",     type: "number",  label: "To-Hit"   },
        { key: "dmgMult",   type: "number",  label: "Dmg ×",   step: "0.5" },
        { key: "attacks",   type: "number",  label: "Attacks", min: 1 },
        { key: "noDamage",  type: "boolean", label: "No dmg"   },
        { key: "nonLethal", type: "boolean", label: "Non-lethal" },
        { key: "fullRound", type: "boolean", label: "Full round" }
    ]),
    defense: Object.freeze([
        { key: "staCost", type: "number", label: "STA"     },
        { key: "penalty", type: "number", label: "Penalty" }
    ])
});

export class CombatActionsEditor extends HandlebarsApplicationMixin(ApplicationV2) {

    static DEFAULT_OPTIONS = {
        id: "wdm-combat-actions-editor",
        classes: ["witcher-ttrpg-death-march", "wdm-combat-actions-editor"],
        tag: "form",
        window: {
            title: "WITCHER.CombatExtended.ActionsEditor.Title",
            icon: "fa-solid fa-burst",
            resizable: true
        },
        position: { width: 880, height: 800 },
        form: {
            handler: CombatActionsEditor.#onSubmit,
            submitOnChange: false,
            closeOnSubmit: true
        },
        actions: {
            resetRow:     CombatActionsEditor.#onResetRow,
            resetCatalog: CombatActionsEditor.#onResetCatalog
        }
    };

    static PARTS = {
        main:   { template: "systems/witcher-ttrpg-death-march/templates/applications/combat-actions-editor.hbs", scrollable: [""] },
        footer: { template: "templates/generic/form-footer.hbs" }
    };

    /* { attack: [row…], defense: [row…] }; null until first prepare. */
    #working = null;

    /* ─────────── row helpers ─────────── */

    /* Translate an entry (default or merged) into the UI row shape. The
     * `label` / `desc` columns prefer the editor-authored override TEXT
     * over the i18n KEY — actionLabel/actionDescription already encode
     * that preference. */
    static #rowFromEntry(key, entry) {
        const fields = {};
        for (const meta of FIELD_META[entry.kind] ?? []) {
            const v = entry[meta.key];
            fields[meta.key] = meta.type === "boolean" ? !!v : (Number.isFinite(Number(v)) ? Number(v) : 0);
        }
        return {
            key,
            kind: entry.kind,
            label: actionLabel(entry),
            desc:  actionDescription(entry),
            fields,
            meleeOnly:        !!entry.meleeOnly,
            meleeOrBow:       !!entry.meleeOrBow,
            requiresPiercing: !!entry.requiresPiercing,
            requiresShield:   !!entry.requiresShield,
            offhand:          !!entry.offhand,
            prereq:           entry.prereq ?? "",
            defenseSkill:     entry.defenseSkill ?? ""
        };
    }

    /* Convert a row back to an override patch — only the fields that DIFFER
     * from the default are kept. Equal rows return null (caller drops them
     * from the override so an untouched catalog persists `{}`). */
    static #patchFromRow(row, def) {
        const out = {};
        const defLabel = actionLabel(def);
        const defDesc  = actionDescription(def);
        if (row.label !== defLabel) out.label = row.label;
        if (row.desc  !== defDesc)  out.desc  = row.desc;
        for (const meta of FIELD_META[row.kind] ?? []) {
            const cur = meta.type === "boolean" ? !!row.fields[meta.key] : Number(row.fields[meta.key]) || 0;
            const dft = meta.type === "boolean" ? !!def[meta.key]        : Number(def[meta.key])        || 0;
            if (cur !== dft) out[meta.key] = cur;
        }
        return Object.keys(out).length ? out : null;
    }

    /* ─────────── working-set lifecycle ─────────── */

    #initWorking() {
        const override = (game.settings.get(SYSTEM_ID, "combatActionsOverride") ?? {});
        this.#working = { attack: [], defense: [], subsystems: {}, tuneables: {} };
        for (const [key, def] of Object.entries(DEFAULT_COMBAT_ACTIONS)) {
            const o = override[key];
            /* Build a one-shot "merged" view that mirrors what
             * getActiveCombatActions would expose — without re-running the
             * full merge helper (we need both the row AND the diff target). */
            const merged = { ...def };
            if (o && typeof o === "object") {
                if (typeof o.label === "string") merged.labelText = o.label;
                if (typeof o.desc  === "string") merged.descText  = o.desc;
                for (const meta of FIELD_META[def.kind] ?? []) {
                    if (Object.hasOwn(o, meta.key)) {
                        merged[meta.key] = meta.type === "boolean" ? !!o[meta.key] : Number(o[meta.key]) || 0;
                    }
                }
            }
            const row = CombatActionsEditor.#rowFromEntry(key, merged);
            (this.#working[row.kind] ?? this.#working.attack).push(row);
        }
        /* Subsystem toggles — read the override map, fall through to
         * CE_SUBSYSTEM_DEFAULTS for unset keys. */
        const subOverride = game.settings.get(SYSTEM_ID, "combatExtendedSubsystems") ?? {};
        for (const { key } of SUBSYSTEM_META) {
            this.#working.subsystems[key] = Object.hasOwn(subOverride, key)
                ? !!subOverride[key]
                : CE_SUBSYSTEM_DEFAULTS[key];
        }
        /* Secondary tuneables — read the override map, fall through to
         * CE_TUNEABLE_DEFAULTS for unset keys. */
        const tunOverride = game.settings.get(SYSTEM_ID, "combatExtendedTuneables") ?? {};
        for (const meta of TUNEABLE_META) {
            const v = tunOverride[meta.key];
            if (v === undefined) {
                this.#working.tuneables[meta.key] = meta.default;
            } else {
                this.#working.tuneables[meta.key] = meta.kind === "boolean" ? !!v : Number(v) || 0;
            }
        }
    }

    /* Read the rendered inputs back into the working set before we
     * mutate it (reset / reset-all). */
    #syncFromForm() {
        if (!this.#working) return;
        const form = this.element?.querySelector?.("form") ?? this.element;
        if (!form) return;
        for (const kind of ["attack", "defense"]) {
            for (const row of this.#working[kind] ?? []) {
                const prefix = `rows.${kind}.${row.key}`;
                const labelEl = form.querySelector(`[name="${prefix}.label"]`);
                const descEl  = form.querySelector(`[name="${prefix}.desc"]`);
                if (labelEl) row.label = String(labelEl.value ?? "");
                if (descEl)  row.desc  = String(descEl.value  ?? "");
                for (const meta of FIELD_META[kind] ?? []) {
                    const el = form.querySelector(`[name="${prefix}.${meta.key}"]`);
                    if (!el) continue;
                    row.fields[meta.key] = meta.type === "boolean"
                        ? !!el.checked
                        : (Number.isFinite(Number(el.value)) ? Number(el.value) : 0);
                }
            }
        }
        /* Subsystem toggles. */
        for (const { key } of SUBSYSTEM_META) {
            const el = form.querySelector(`[name="subsystems.${key}"]`);
            if (el) this.#working.subsystems[key] = !!el.checked;
        }
        /* Secondary tuneables. */
        for (const meta of TUNEABLE_META) {
            const el = form.querySelector(`[name="tuneables.${meta.key}"]`);
            if (!el) continue;
            this.#working.tuneables[meta.key] = meta.kind === "boolean"
                ? !!el.checked
                : (Number.isFinite(Number(el.value)) ? Number(el.value) : meta.default);
        }
    }

    /* ─────────── handlers ─────────── */

    static async #onResetRow(_event, target) {
        const kind = target.dataset.kind;
        const key  = target.dataset.key;
        const def  = DEFAULT_COMBAT_ACTIONS[key];
        if (!def) return;
        this.#syncFromForm();
        const fresh = CombatActionsEditor.#rowFromEntry(key, def);
        const arr = this.#working[kind];
        const idx = arr.findIndex(r => r.key === key);
        if (idx !== -1) arr[idx] = fresh;
        this.render();
    }

    static async #onResetCatalog() {
        /* Reset the action rows AND the subsystem toggles + tuneables
         * back to their defaults. Sync the form first so a Reset doesn't
         * silently drop an in-progress save the user hadn't pressed Save
         * on yet — actually, on reflection, Reset SHOULD discard pending
         * edits since that's the point. Skipping the sync is correct. */
        this.#working = { attack: [], defense: [], subsystems: {}, tuneables: {} };
        for (const [key, def] of Object.entries(DEFAULT_COMBAT_ACTIONS)) {
            const row = CombatActionsEditor.#rowFromEntry(key, def);
            (this.#working[row.kind] ?? this.#working.attack).push(row);
        }
        for (const { key } of SUBSYSTEM_META) {
            this.#working.subsystems[key] = CE_SUBSYSTEM_DEFAULTS[key];
        }
        for (const meta of TUNEABLE_META) {
            this.#working.tuneables[meta.key] = meta.default;
        }
        this.render();
    }

    static async #onSubmit(_event, _form, formData) {
        this.#syncFromForm();
        const override = {};
        for (const kind of ["attack", "defense"]) {
            for (const row of this.#working[kind] ?? []) {
                const def = DEFAULT_COMBAT_ACTIONS[row.key];
                if (!def) continue;
                const patch = CombatActionsEditor.#patchFromRow(row, def);
                if (patch) override[row.key] = patch;
            }
        }
        await game.settings.set(SYSTEM_ID, "combatActionsOverride", override);
        /* Subsystem overrides — persist the EXPLICIT current state for
         * every subsystem, not the diff-against-default. The reader
         * (api/homebrew.isCESubsystemEnabled) falls back to the
         * default when a key is missing, so a diff-only write was
         * mathematically equivalent — but it visibly wiped the
         * setting object to `{}` after every save, which is alarming
         * to any GM inspecting the world settings and to anyone
         * tailing the audit log. Explicit state is louder and
         * easier to reason about. (Player-flow audit critical #1.) */
        const subOut = {};
        for (const { key } of SUBSYSTEM_META) {
            subOut[key] = !!this.#working.subsystems[key];
        }
        await game.settings.set(SYSTEM_ID, "combatExtendedSubsystems", subOut);
        /* Tuneables: same explicit-state treatment. */
        const tunOut = {};
        for (const meta of TUNEABLE_META) {
            const cur = this.#working.tuneables[meta.key];
            tunOut[meta.key] = meta.kind === "boolean" ? !!cur : Number(cur);
        }
        await game.settings.set(SYSTEM_ID, "combatExtendedTuneables", tunOut);
        ui.notifications?.info(t("WITCHER.Notify.CombatExtended.Saved", "Combat Extended configuration saved."));
    }

    /* ─────────── prepare ─────────── */

    async _prepareContext() {
        if (!this.#working) this.#initWorking();
        const subsystems = SUBSYSTEM_META.map(m => ({
            ...m,
            enabled: !!this.#working.subsystems[m.key]
        }));
        const tuneables = TUNEABLE_META.map(m => ({
            ...m,
            value: this.#working.tuneables[m.key]
        }));
        /* The expanded card body's "knobs" grid renders one input per
         * editable field. staCost is now rendered INLINE on the
         * collapsed summary (so the GM can tune it without expanding
         * each card), so strip it from the body-grid meta to avoid
         * two inputs sharing the same form name (which would conflict
         * on submit). */
        const bodyFieldMeta = Object.fromEntries(
            Object.entries(FIELD_META).map(([kind, list]) => [kind, list.filter(m => m.key !== "staCost")])
        );
        return {
            attacks:  this.#working.attack,
            defenses: this.#working.defense,
            subsystems,
            tuneables,
            fieldMeta: bodyFieldMeta,
            buttons: [
                { type: "button", icon: "fa-solid fa-rotate-left", label: "Reset All to Defaults", action: "resetCatalog" },
                { type: "submit", icon: "fa-solid fa-floppy-disk", label: "Save" }
            ]
        };
    }
}
