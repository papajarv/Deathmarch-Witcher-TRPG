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
    { key: "ablating",              label: "Ablating (-1 SP on penetrating hit)"   },
    { key: "bypassesWornArmor",     label: "Bypasses Worn Armor"                   },
    { key: "bypassesNaturalArmor",  label: "Bypasses Natural Armor"                },
    { key: "bypassesShield",        label: "Bypasses Shield (Quen)"                },
    { key: "isSilver",              label: "Counts as Silver (vs monster resists)" }
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
            title: "Weapon & Armor Qualities",
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
            ignoresRepositionDistance: !!entry?.ignoresRepositionDistance,
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
        // Tactical flags — only persist when set, same diff-tightness rule.
        if (row.ignoresRepositionDistance) entry.ignoresRepositionDistance = true;
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
                    ? {
                        label:       o.label       ?? defEntry.label,
                        description: o.description ?? defEntry.description,
                        param:       o.param       ?? defEntry.param ?? null,
                        damageFlags: o.damageFlags ?? defEntry.damageFlags ?? {},
                        rider:       o.rider       ?? defEntry.rider ?? null,
                        ignoresRepositionDistance:
                            o.ignoresRepositionDistance ?? defEntry.ignoresRepositionDistance ?? false
                    }
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
                    ignoresRepositionDistance:
                        r.ignoresRepositionDistance === true || r.ignoresRepositionDistance === "true" || r.ignoresRepositionDistance === "on",
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
            ignoresRepositionDistance: !!row.ignoresRepositionDistance
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
            window: { title: "Restore defaults?" },
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
            ui.notifications.info("Qualities catalogs saved.");
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
