/**
 * QualitiesEditor — the GM-facing form for editing the weapon and armor
 * quality catalogs. Opens from Configure Settings → "Edit Qualities".
 *
 * Two catalogs, one card per quality, friendly controls for the whole
 * entry shape (config.mjs `wq`): label, description, and an optional
 * parameter slot (the inline value the player fills in — Bleeding's %,
 * Silver's dice formula, Focus's integer). No JSON.
 *
 * Storage: each catalog's cards are diffed against the seed defaults on
 * save. A quality equal to its default is omitted (so it keeps tracking
 * the seed); a changed default is stored whole; a default the GM deleted
 * is stored `{removed:true}`; a brand-new quality is stored whole. The
 * results are written to the `weaponQualitiesOverride` /
 * `armorQualitiesOverride` world settings, which merge per-entry at
 * runtime via getActive*Qualities().
 */

import { WEAPON_QUALITIES, ARMOR_QUALITIES } from "../setup/config.mjs";

import { t, tFormat } from "../chrome/lib/i18n.js";
const SYSTEM_ID = "witcher-ttrpg-death-march";
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const PARAM_TYPES = [
    { value: "none",    label: "No parameter" },
    { value: "percent", label: "Percent (%)" },
    { value: "number",  label: "Number" },
    { value: "text",    label: "Text / formula" }
];

/* Calculator-side flags a quality can carry — surfaced as a checkbox grid
 * per quality.  Mirrors the keys the damage calculator and socket handler
 * recognize; adding a new flag here makes it editable without code changes
 * elsewhere. */
const DAMAGE_FLAG_KEYS = [
    { key: "armorPiercing",         label: "Armor Piercing (negates DR)"           },
    { key: "improvedArmorPiercing", label: "Improved AP (negates DR + halves SP)"  },
    { key: "ablating",              label: "Ablating (+1d6/2 SP damage on penetration, on top of the standard −1 SP chip)" },
    { key: "doubleAblation",        label: "Double Ablation (doubles the standard chip to −2 SP, e.g. Crushing Force)" },
    { key: "bypassesWornArmor",     label: "Bypasses Worn Armor"                   },
    { key: "bypassesNaturalArmor",  label: "Bypasses Natural Armor"                },
    { key: "bypassesShield",        label: "Bypasses Shield (Quen)"                },
    { key: "isSilver",              label: "Counts as Silver (vs monster resists)" },
    { key: "isMeteorite",           label: "Counts as Meteorite (vs monster resists)" },
    { key: "deniesParry",           label: "Cannot Be Parried (e.g. Crushing Force)" }
];

/* Per-quality numeric and string effects — surfaced as individual inputs
 * because they don't fit a checkbox grid.  Each consumer reads them by
 * scanning the bearer's equipped weapons (or, for deniesParry, the
 * attacker's weapon at defense-prompt time). */
const NUMERIC_EFFECT_KEYS = [
    { key: "parryPenaltyDelta",   label: "Parry Penalty Reduction",
      hint: "Shaves N off the −3 parry penalty when DEFENDING with this weapon (Parrying = 2)." },
    { key: "spellDCBonus",        label: "Spell DC Bonus",
      hint: "Spells cast through this weapon treat their target DC as +N (Greater Focus = 2)." },
    { key: "reliabilityBonus",    label: "Reliability Bonus",
      hint: "Added to the weapon's max Reliability when this quality is present (Meteorite = 5)." },
    { key: "chargeBonusPerMeter", label: "Charge Bonus / Meter",
      hint: "Bonus damage dice per meter charged from a mount (Charging = 1, i.e. +1d6/m)." }
];

const STRING_EFFECT_KEYS = [
    { key: "skillOverride",       label: "Attack Skill Override",
      hint: "Forces the weapon's to-hit roll to use this skillMap key (rarely used — the weapon's own skillKey covers most cases). Blank = use the weapon's default." }
];

/* Boolean tactical flags that travel as top-level entry fields (not under
 * damageFlags, because they're read OUTSIDE the damage pipeline). Mirror
 * of DAMAGE_FLAG_KEYS for grid rendering — adding a new flag is one line. */
const TACTICAL_FLAG_KEYS = [
    { key: "ignoresRepositionDistance",
      label: "Ignores Reposition Distance (long-reach weapon — defender's Reposition doesn't void follow-up swings)" },
    { key: "addsDamageToUnarmed",
      label: "Adds Damage to Unarmed (Brawling — cestus / spiked gauntlet folds its damage into punches/kicks)" }
];

/* Post-hit rider kinds — pick one per quality. */
const RIDER_KINDS = [
    { value: "none",     label: "No rider"                            },
    { value: "auto",     label: "Auto (applies on every damaging hit)"},
    { value: "percent",  label: "Percent (rolls d100 vs parameter)"   },
    { value: "stunSave", label: "Stun Save (target rolls Stun at param)"}
];

/* Hit-location keys that the stunSave rider can be gated to.  Mirrors
 * ATTACK_LOCATIONS — duplicated here so the editor doesn't have to import
 * config at load time. */
const RIDER_LOCATION_KEYS = ["head", "torso", "leftArm", "rightArm", "leftLeg", "rightLeg", "tailWing"];

/* Per-catalog wiring: the form-field prefix, the settings key, and the
 * seed catalog it diffs against. */
const CATALOGS = {
    weapon: { prefix: "w", setting: "weaponQualitiesOverride", defaults: WEAPON_QUALITIES },
    armor:  { prefix: "a", setting: "armorQualitiesOverride",  defaults: ARMOR_QUALITIES }
};

export class QualitiesEditor extends HandlebarsApplicationMixin(ApplicationV2) {

    static DEFAULT_OPTIONS = {
        id: "wdm-qualities-editor",
        classes: ["witcher-ttrpg-death-march", "wdm-qualities-editor"],
        tag: "form",
        window: {
            title: t("WITCHER.Dialog.Qualities.Title", "Weapon & Armor Qualities"),
            icon: "fa-solid fa-list-check",
            resizable: true
        },
        position: { width: 720, height: 660 },
        form: {
            handler: QualitiesEditor.#onSubmit,
            submitOnChange: false,
            closeOnSubmit: true
        },
        actions: {
            addQuality:    QualitiesEditor.#onAddQuality,
            removeQuality: QualitiesEditor.#onRemoveQuality,
            resetCatalog:  QualitiesEditor.#onResetCatalog
        }
    };

    static PARTS = {
        main: {
            template: "systems/witcher-ttrpg-death-march/templates/applications/qualities-editor.hbs",
            scrollable: [""]
        },
        footer: { template: "templates/generic/form-footer.hbs" }
    };

    /* { weapon: [row…], armor: [row…] }; null until first render. */
    #working = null;

    /* ─────────── entry ↔ row conversion ─────────── */

    static #rowFromEntry(key, entry, isDefault) {
        const p = entry?.param ?? null;
        const flags = {};
        for (const { key: fk } of DAMAGE_FLAG_KEYS) flags[fk] = !!entry?.damageFlags?.[fk];
        const rider = entry?.rider ?? null;
        const numerics = {};
        for (const { key: nk } of NUMERIC_EFFECT_KEYS) numerics[nk] = Number(entry?.[nk]) || 0;
        const strings = {};
        for (const { key: sk } of STRING_EFFECT_KEYS) strings[sk] = String(entry?.[sk] ?? "");
        return {
            key,
            label: entry?.label ?? key,
            description: entry?.description ?? "",
            paramType: p?.type ?? "none",
            paramPlaceholder: p?.placeholder ?? "",
            paramSuffix: p?.suffix ?? "",
            flags,
            riderKind:      rider?.kind     ?? "none",
            riderStatus:    rider?.statusId ?? "",
            // Locations are a comma-joined string in the form (simpler than an
            // ArrayField on FormDataExtended); split / re-join at the IO edges.
            riderLocations: rider?.locations?.length ? rider.locations.join(",") : "",
            // Tactical flags — read by combat-flow code (not the damage pipeline).
            tacticalFlags: Object.fromEntries(TACTICAL_FLAG_KEYS.map(t => [t.key, !!entry?.[t.key]])),
            // Back-compat alias kept so older callers / templates see the
            // same field; mirrors tacticalFlags.ignoresRepositionDistance.
            ignoresRepositionDistance: !!entry?.ignoresRepositionDistance,
            numerics,
            strings,
            isDefault
        };
    }

    /* Canonical stored override entry for a row, empties dropped. Both the
     * working row and the default row pass through here, so equality holds
     * exactly when nothing changed. */
    static #entryFromRow(row) {
        const entry = { label: row.label, description: row.description };
        if (row.paramType && row.paramType !== "none") {
            const param = { type: row.paramType };
            if (row.paramPlaceholder) param.placeholder = row.paramPlaceholder;
            if (row.paramSuffix) param.suffix = row.paramSuffix;
            entry.param = param;
        }
        // Damage flags — only persist truthy flags so the diff-against-default
        // stays tight (an entry with no flags === default no-flags shape).
        const flagsOut = {};
        for (const { key: fk } of DAMAGE_FLAG_KEYS) if (row.flags?.[fk]) flagsOut[fk] = true;
        if (Object.keys(flagsOut).length) entry.damageFlags = flagsOut;
        // Rider — only persist when a real kind + status is set.
        if (row.riderKind && row.riderKind !== "none" && row.riderStatus) {
            const rider = { kind: row.riderKind, statusId: row.riderStatus };
            const locs = String(row.riderLocations ?? "")
                .split(",").map(s => s.trim()).filter(Boolean);
            if (locs.length) rider.locations = locs;
            entry.rider = rider;
        }
        // Tactical flags — only persist truthy entries (diff-tightness rule).
        for (const { key: tk } of TACTICAL_FLAG_KEYS) {
            if (row.tacticalFlags?.[tk] || (tk === "ignoresRepositionDistance" && row.ignoresRepositionDistance)) {
                entry[tk] = true;
            }
        }
        // Numeric + string effects — only persist non-zero / non-empty so an
        // untouched quality still diffs equal to its default and is omitted
        // from the override.
        for (const { key: nk } of NUMERIC_EFFECT_KEYS) {
            const v = Number(row.numerics?.[nk]) || 0;
            if (v) entry[nk] = v;
        }
        for (const { key: sk } of STRING_EFFECT_KEYS) {
            const v = String(row.strings?.[sk] ?? "").trim();
            if (v) entry[sk] = v;
        }
        return entry;
    }

    /* The seed-default row for a key — used for the save-time diff so an
     * untouched quality is omitted from the override. */
    static #defaultRow(catalog, key) {
        return QualitiesEditor.#rowFromEntry(key, CATALOGS[catalog].defaults[key], true);
    }

    /* ─────────── working-set lifecycle ─────────── */

    #initWorking() {
        this.#working = {};
        for (const [name, cfg] of Object.entries(CATALOGS)) {
            const override = QualitiesEditor.#readOverride(cfg.setting);
            const rows = [];
            for (const [key, defEntry] of Object.entries(cfg.defaults)) {
                const o = override[key];
                if (o?.removed) continue;
                const entry = o
                    ? (() => {
                        const merged = {
                            label:       o.label       ?? defEntry.label,
                            description: o.description ?? defEntry.description,
                            param:       o.param       ?? defEntry.param ?? null,
                            damageFlags: o.damageFlags ?? defEntry.damageFlags ?? {},
                            rider:       o.rider       ?? defEntry.rider ?? null
                        };
                        // Tactical flags — same fall-through rule as above.
                        for (const { key: tk } of TACTICAL_FLAG_KEYS) {
                            merged[tk] = o[tk] ?? defEntry[tk] ?? false;
                        }
                        // Numeric / string effects — fall through to default if
                        // override doesn't set them, so an untouched effect on
                        // a partially-customized quality keeps its built-in.
                        for (const { key: nk } of NUMERIC_EFFECT_KEYS) {
                            merged[nk] = o[nk] ?? defEntry[nk] ?? 0;
                        }
                        for (const { key: sk } of STRING_EFFECT_KEYS) {
                            merged[sk] = o[sk] ?? defEntry[sk] ?? "";
                        }
                        return merged;
                    })()
                    : defEntry;
                rows.push(QualitiesEditor.#rowFromEntry(key, entry, true));
            }
            for (const [key, o] of Object.entries(override)) {
                if (key in cfg.defaults || !o || o.removed) continue;
                rows.push(QualitiesEditor.#rowFromEntry(key, o, false));
            }
            this.#working[name] = rows;
        }
    }

    static #readOverride(setting) {
        const o = game.settings.get(SYSTEM_ID, setting);
        return (o && typeof o === "object") ? o : {};
    }

    /* Pull the rendered inputs back into #working so add/remove/reset
     * keep edits. */
    #syncFromForm() {
        if (!this.element) return;
        const data = foundry.utils.expandObject(new foundry.applications.ux.FormDataExtended(this.element).object);
        for (const [name, cfg] of Object.entries(CATALOGS)) {
            const rows = data[cfg.prefix] || {};
            const next = [];
            for (const idx of Object.keys(rows).sort((a, b) => Number(a) - Number(b))) {
                const r = rows[idx];
                const flags = {};
                for (const { key: fk } of DAMAGE_FLAG_KEYS) flags[fk] = !!(r.flags?.[fk]);
                const numerics = {};
                // Clamp at zero — labels all read "Bonus" / "Reduction" /
                // "Delta" with positive semantics. A negative `parryPenaltyDelta`
                // would WORSEN parry instead of helping (the label promises
                // reduction); same logic across the other fields. The HTML
                // input gets min="0" too, but this is the authoritative gate.
                for (const { key: nk } of NUMERIC_EFFECT_KEYS) numerics[nk] = Math.max(0, Number(r.numerics?.[nk]) || 0);
                const strings = {};
                for (const { key: sk } of STRING_EFFECT_KEYS) strings[sk] = String(r.strings?.[sk] ?? "").trim();
                const tacticalFlags = {};
                for (const { key: tk } of TACTICAL_FLAG_KEYS) {
                    const v = r.tacticalFlags?.[tk];
                    tacticalFlags[tk] = v === true || v === "true" || v === "on";
                }
                // Back-compat: the legacy standalone ignoresRepositionDistance
                // input still posts under its old name; OR it in.
                if (r.ignoresRepositionDistance === true || r.ignoresRepositionDistance === "true" || r.ignoresRepositionDistance === "on") {
                    tacticalFlags.ignoresRepositionDistance = true;
                }
                next.push({
                    key: String(r.key ?? "").trim(),
                    label: String(r.label ?? "").trim(),
                    description: String(r.description ?? "").trim(),
                    paramType: String(r.paramType || "none"),
                    paramPlaceholder: String(r.paramPlaceholder ?? "").trim(),
                    paramSuffix: String(r.paramSuffix ?? "").trim(),
                    flags,
                    riderKind:      String(r.riderKind   || "none"),
                    riderStatus:    String(r.riderStatus ?? "").trim(),
                    riderLocations: String(r.riderLocations ?? "").trim(),
                    tacticalFlags,
                    ignoresRepositionDistance: !!tacticalFlags.ignoresRepositionDistance,
                    numerics,
                    strings,
                    isDefault: r.isDefault === true || r.isDefault === "true"
                });
            }
            this.#working[name] = next;
        }
    }

    /* ─────────── context ─────────── */

    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        if (!this.#working) this.#initWorking();
        // Status-effect ids for the rider dropdown.  Reads at render time
        // so any GM additions in the Status Effects editor show up.
        const statusIds = (CONFIG.statusEffects ?? [])
            .map(s => ({ id: s.id, label: game.i18n?.localize?.(s.name) ?? s.name ?? s.id }))
            .filter(s => s.id)
            .sort((a, b) => a.label.localeCompare(b.label));
        ctx.catalogs = [
            this.#catalogView("weapon", "Weapons", statusIds),
            this.#catalogView("armor", "Armor",   statusIds)
        ];
        ctx.buttons = [{ type: "submit", icon: "fa-solid fa-floppy-disk", label: "Save" }];
        return ctx;
    }

    #catalogView(name, label, statusIds) {
        const cfg = CATALOGS[name];
        const rows = this.#working[name].map((row, index) => ({
            index,
            key: row.key,
            label: row.label,
            description: row.description,
            isDefault: row.isDefault,
            paramTypeOptions: PARAM_TYPES.map(p => ({ value: p.value, label: p.label, selected: row.paramType === p.value })),
            hasParam: row.paramType !== "none",
            paramPlaceholder: row.paramPlaceholder,
            paramSuffix: row.paramSuffix,
            // Damage-pipeline flag checkboxes (catalog-driven via DAMAGE_FLAG_KEYS).
            flagControls: DAMAGE_FLAG_KEYS.map(f => ({
                key: f.key,
                label: f.label,
                checked: !!row.flags?.[f.key]
            })),
            // Rider config — kind picker + status-effect dropdown + optional
            // location filter (only meaningful when kind = stunSave).
            riderKindOptions: RIDER_KINDS.map(k => ({
                value: k.value, label: k.label, selected: row.riderKind === k.value
            })),
            riderStatusOptions: [{ value: "", label: "— pick a status —", selected: !row.riderStatus }]
                .concat(statusIds.map(s => ({ value: s.id, label: `${s.label} (${s.id})`, selected: row.riderStatus === s.id }))),
            riderHasLocations: row.riderKind === "stunSave",
            riderLocationKeysHint: RIDER_LOCATION_KEYS.join(", "),
            riderLocations: row.riderLocations ?? "",
            tacticalControls: TACTICAL_FLAG_KEYS.map(t => ({
                key:     t.key,
                label:   t.label,
                checked: !!row.tacticalFlags?.[t.key] || (t.key === "ignoresRepositionDistance" && !!row.ignoresRepositionDistance)
            })),
            numericControls: NUMERIC_EFFECT_KEYS.map(n => ({
                key:   n.key,
                label: n.label,
                hint:  n.hint,
                value: Number(row.numerics?.[n.key]) || 0
            })),
            stringControls: STRING_EFFECT_KEYS.map(s => ({
                key:   s.key,
                label: s.label,
                hint:  s.hint,
                value: String(row.strings?.[s.key] ?? "")
            }))
        }));
        return { name, prefix: cfg.prefix, label, rows };
    }

    /* ─────────── actions ─────────── */

    static async #onAddQuality(event, target) {
        this.#syncFromForm();
        const name = target.dataset.catalog;
        const key = this.#uniqueKey(name, "newQuality");
        this.#working[name].push(QualitiesEditor.#rowFromEntry(key, { label: "New Quality", description: "" }, false));
        this.render();
    }

    static async #onRemoveQuality(event, target) {
        this.#syncFromForm();
        const name = target.dataset.catalog;
        const index = Number(target.dataset.index);
        if (Number.isInteger(index)) this.#working[name].splice(index, 1);
        this.render();
    }

    static async #onResetCatalog(event, target) {
        const name = target.dataset.catalog;
        const ok = await foundry.applications.api.DialogV2.confirm({
            window: { title: t("WITCHER.Dialog.RestoreDefaults", "Restore defaults?") },
            content: `<p>Discard your customizations to the ${name} qualities and restore the system defaults? This takes effect when you Save.</p>`,
            modal: true,
            rejectClose: false
        }).catch(() => false);
        if (!ok) return;
        this.#syncFromForm();
        this.#working[name] = Object.keys(CATALOGS[name].defaults)
            .map(key => QualitiesEditor.#defaultRow(name, key));
        this.render();
    }

    #uniqueKey(name, base) {
        const taken = new Set([
            ...Object.keys(CATALOGS[name].defaults),
            ...this.#working[name].map(r => r.key)
        ]);
        let i = 1;
        let key = `${base}${i}`;
        while (taken.has(key)) key = `${base}${++i}`;
        return key;
    }

    /* ─────────── submit ─────────── */

    static async #onSubmit(event, form, formData) {
        this.#syncFromForm();
        try {
            for (const [name, cfg] of Object.entries(CATALOGS)) {
                const override = QualitiesEditor.#buildOverride(name, this.#working[name]);
                await game.settings.set(SYSTEM_ID, cfg.setting, override);
            }
            ui.notifications.info(t("WITCHER.Notify.Qualities.Saved", "Qualities catalogs saved."));
        } catch (e) {
            ui.notifications.error(e.message);
            throw e;
        }
    }

    static #buildOverride(name, rows) {
        const defaults = CATALOGS[name].defaults;
        const override = {};
        const seen = new Set();
        for (const row of rows) {
            const key = String(row.key || "").trim();
            if (!key || !/^[a-z][a-z0-9_-]*$/i.test(key)) {
                throw new Error(`Invalid ${name} quality key "${row.key}". Use a letter followed by letters, numbers, "-" or "_".`);
            }
            if (seen.has(key)) throw new Error(`Duplicate ${name} quality key "${key}".`);
            seen.add(key);

            const entry = QualitiesEditor.#entryFromRow(row);
            if (key in defaults) {
                const def = QualitiesEditor.#entryFromRow(QualitiesEditor.#defaultRow(name, key));
                if (!foundry.utils.objectsEqual(entry, def)) override[key] = entry;
            } else {
                override[key] = entry;
            }
        }
        for (const key of Object.keys(defaults)) {
            if (!seen.has(key)) override[key] = { removed: true };
        }
        return override;
    }
}
