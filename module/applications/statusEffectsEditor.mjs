/**
 * StatusEffectsEditor — the GM-facing form for customizing combat statuses.
 * Opens from Configure Settings → "Edit Status Effects".
 *
 * Each status is a card with friendly controls for the whole clause vocabulary
 * (mechanics/statusEngine.mjs): name, icon, description, per-stat modifiers,
 * roll modifiers, damage-over-time, action/defense locks, auto-hit DC, the
 * ending check, auto-clear, and periodic saves. No JSON.
 *
 * Storage: the working set of cards is diffed against the RAW defaults on save.
 * A status equal to its default is omitted (so it keeps tracking code defaults
 * and the i18n label); a changed default is stored whole; a default the GM
 * deleted is stored `{removed:true}`; a brand-new status is stored whole. The
 * result is written to the `statusEffectsOverride` world setting, which is
 * `requiresReload:true` — saving triggers Foundry's reload prompt so the token
 * HUD + CONFIG.statusEffects rebuild cleanly.
 */

import { STATUS_CLAUSES } from "../setup/statusClauses.mjs";
import { STATUS_EFFECTS } from "../setup/statusEffects.mjs";
import { SYSTEM_ID, STATUS_OVERRIDE_SETTING, readStatusOverride } from "../mechanics/statusOverrides.mjs";

/* Build the "everything we know how to edit" map at editor-open time.
 * STATUS_EFFECTS is the PURE-RAW seed — it deliberately omits the homebrew-
 * gated entries (drunk-1..8, hunger ladder, hangover) so they don't appear in
 * a pure-RAW world's token HUD. The EDITOR needs them all the time though, so
 * the GM can tune them whether the toggle is currently on or off. We union the
 * seed with every id present in STATUS_CLAUSES (the editable source of truth)
 * and fall back to a default presentation for ids the seed doesn't carry. */
function buildEditableRegistry() {
    const out = Object.fromEntries(
        STATUS_EFFECTS.map(s => [s.id, { name: s.name, img: s.img, rimColor: s.rimColor }])
    );
    // Conservative icon defaults for clause-only ids. Mirrors what
    // setup/statusEffects.mjs assigns to drunk/hunger/hangover when registered.
    /* Status icon directory — local SVGs shipped in /assets/icons/statuses/.
     * Mirror the registry entries in setup/statusEffects.mjs. */
    const ICON_DIR = "systems/witcher-ttrpg-death-march/assets/icons/statuses";
    const ICON_FALLBACKS = {
        // Drunk ladder — files named drunk-1.svg … drunk-8.svg.
        "drunk-1": `${ICON_DIR}/drunk-1.svg`,
        "drunk-2": `${ICON_DIR}/drunk-2.svg`,
        "drunk-3": `${ICON_DIR}/drunk-3.svg`,
        "drunk-4": `${ICON_DIR}/drunk-4.svg`,
        "drunk-5": `${ICON_DIR}/drunk-5.svg`,
        "drunk-6": `${ICON_DIR}/drunk-6.svg`,
        "drunk-7": `${ICON_DIR}/drunk-7.svg`,
        "drunk-8": `${ICON_DIR}/drunk-8.svg`,
        gorged:   `${ICON_DIR}/gorged.svg`,
        // full / fed are clause-only (not registered as actual statuses) —
        // borrow the gorged / peckish icons for the editor preview.
        full:     `${ICON_DIR}/gorged.svg`,
        fed:      `${ICON_DIR}/peckish.svg`,
        peckish:  `${ICON_DIR}/peckish.svg`,
        hungry:   `${ICON_DIR}/hungry.svg`,
        famished: `${ICON_DIR}/famished.svg`,
        hangover: `${ICON_DIR}/hangover.svg`,
        "food-sickness":          `${ICON_DIR}/food-sickness.svg`,
        // Stress homebrew — mental break / boon presentation. Mirror the
        // STRESS_BREAKS / STRESS_BOONS entries in setup/statusEffects.mjs.
        "break-indulgent":        `${ICON_DIR}/break-indulgent.svg`,
        "break-paranoid":         `${ICON_DIR}/break-paranoid.svg`,
        "break-scared":           `${ICON_DIR}/break-scared.svg`,
        "break-depressive":       `${ICON_DIR}/break-depressive.svg`,
        "break-impulsive":        `${ICON_DIR}/break-impulsive.svg`,
        "break-self-harming":     `${ICON_DIR}/break-self-harming.svg`,
        "break-selfish":          `${ICON_DIR}/break-selfish.svg`,
        "break-violent":          `${ICON_DIR}/break-violent.svg`,
        "boon-stoic":             `${ICON_DIR}/boon-stoic.svg`,
        "boon-optimistic":        `${ICON_DIR}/boon-optimistic.svg`,
        "boon-hopeful":           `${ICON_DIR}/boon-hopeful.svg`,
        "boon-defiant":           `${ICON_DIR}/boon-defiant.svg`,
        "boon-focused":           `${ICON_DIR}/boon-focused.svg`,
        "boon-stalwart":          `${ICON_DIR}/boon-stalwart.svg`,
        "boon-determined-grit":   `${ICON_DIR}/boon-determined-grit.svg`,
        "boon-unbreakable":       `${ICON_DIR}/boon-unbreakable.svg`,
        "boon-smile-at-death":    `${ICON_DIR}/boon-smile-at-death.svg`
    };
    const NAME_FALLBACKS = {
        "drunk-1": "Drunk I",   "drunk-2": "Drunk II",  "drunk-3": "Drunk III",
        "drunk-4": "Drunk IV",  "drunk-5": "Drunk V",   "drunk-6": "Drunk VI",
        "drunk-7": "Drunk VII", "drunk-8": "Drunk VIII",
        gorged: "Gorged", full: "Full", fed: "Fed",
        peckish: "Peckish", hungry: "Hungry", famished: "Famished",
        hangover: "Hangover",
        "food-sickness":         "Food Sickness",
        "break-indulgent":       "Indulgent",
        "break-paranoid":        "Paranoid",
        "break-scared":          "Scared",
        "break-depressive":      "Depressive",
        "break-impulsive":       "Impulsive",
        "break-self-harming":    "Self-Harming",
        "break-selfish":         "Selfish",
        "break-violent":         "Violent",
        "boon-stoic":            "Stoic",
        "boon-optimistic":       "Optimistic",
        "boon-hopeful":          "Hopeful",
        "boon-defiant":          "Defiant",
        "boon-focused":          "Focused",
        "boon-stalwart":         "Stalwart",
        "boon-determined-grit":  "Determined Grit",
        "boon-unbreakable":      "Unbreakable",
        "boon-smile-at-death":   "Smile at Death"
    };
    // Clause-only ids the editor must NOT surface as editable rows:
    //   - "aim" : doc-only clause; real registrations are aim-1..3 (the bare
    //             "aim" clause exists only so the status panel can read the
    //             help text for the aim mechanic).
    //   - "full" / "fed" : sated-baseline hunger tiers that are DELIBERATELY
    //             not registered (no AE ever lands). Their clauses exist for
    //             documentation only. Peckish IS registered (per spec — it's
    //             a heads-up warning even though it has no stat changes).
    // fastDraw IS a real registered status (procedural marker), so don't
    // skip it — the editor should let the GM retune its description.
    const SKIP_IDS = new Set(["aim", "full", "fed"]);
    for (const id of Object.keys(STATUS_CLAUSES)) {
        if (out[id]) continue;
        if (SKIP_IDS.has(id)) continue;
        out[id] = {
            name: NAME_FALLBACKS[id] ?? id,
            img:  ICON_FALLBACKS[id] ?? DEFAULT_ICON
        };
    }
    return out;
}

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const DEFAULT_ICON = "icons/svg/aura.svg";
const STAT_KEYS = ["int", "ref", "dex", "body", "spd", "emp", "cra", "will", "luck"];
const ROLL_KEYS = [
    { key: "attack",    label: "Attack" },
    { key: "defense",   label: "Defense" },
    { key: "awareness", label: "Awareness (sight)" },
    { key: "all",       label: "All rolls" },
    { key: "verbal",    label: "Verbal Combat" }
];
const END_KINDS = [
    { value: "none",     label: "None" },
    { value: "stunSave", label: "Stun save" },
    { value: "skill",    label: "Skill check (DC)" }
];

/* Default presentation (id → name/img). Pulled through buildEditableRegistry()
 * which unions the RAW seed with every homebrew-gated status (drunk, hunger,
 * hangover) so the GM can edit them regardless of toggle state. */
const DEFAULT_PRESENTATION = buildEditableRegistry();
const DEFAULT_IDS = new Set(Object.keys(DEFAULT_PRESENTATION));

/* Map a status id to its homebrew family (if any). Returning null = always
 * shown regardless of toggles. Currently keyed off the id-prefix conventions
 * the codebase uses in setup/statusEffects.mjs — kept in sync with the
 * STRESS / FOOD_DRINK arrays there. */
function homebrewFor(id) {
    if (id.startsWith("break-")) return "stress";
    if (id.startsWith("boon-"))  return "stress";
    if (id.startsWith("drunk-")) return "foodAndDrink";
    if (["gorged","full","fed","peckish","hungry","famished","hangover","food-sickness"].includes(id)) {
        return "foodAndDrink";
    }
    return null;
}

/* True when this status should be HIDDEN from the editor because its
 * homebrew toggle is currently off. Settings are read directly so we don't
 * depend on `game.system.api` being wired yet. */
function isHomebrewGatedOff(id) {
    const fam = homebrewFor(id);
    if (!fam) return false;
    try { return !game.settings?.get?.(SYSTEM_ID, `homebrew.${fam}`); }
    catch { return false; }  // settings not yet registered — show by default
}

/* Localize an i18n-key name for display; pass literals through unchanged. */
function displayName(name) {
    const s = String(name ?? "");
    return s.startsWith("WITCHER.") ? game.i18n.localize(s) : s;
}

export class StatusEffectsEditor extends HandlebarsApplicationMixin(ApplicationV2) {

    static DEFAULT_OPTIONS = {
        id: "wdm-status-editor",
        classes: ["witcher-ttrpg-death-march", "wdm-status-editor"],
        tag: "form",
        window: {
            title: "Status Effects",
            icon: "fa-solid fa-heart-crack",
            resizable: true
        },
        position: { width: 760, height: 720 },
        form: {
            handler: StatusEffectsEditor.#onSubmit,
            submitOnChange: false,
            closeOnSubmit: true
        },
        actions: {
            addStatus:    StatusEffectsEditor.#onAddStatus,
            removeStatus: StatusEffectsEditor.#onRemoveStatus,
            resetAll:     StatusEffectsEditor.#onResetAll,
            pickIcon:     StatusEffectsEditor.#onPickIcon,
            clearRim:     StatusEffectsEditor.#onClearRim
        }
    };

    static PARTS = {
        main:   { template: "systems/witcher-ttrpg-death-march/templates/applications/status-effects-editor.hbs", scrollable: [""] },
        footer: { template: "templates/generic/form-footer.hbs" }
    };

    /* Ordered working set of status rows; null until first render. */
    #working = null;

    /* ─────────── default ↔ row conversion ─────────── */

    /* The editable row shape, derived from a clause + presentation. */
    static #rowFromClause(id, pres, clause) {
        const stats = {};
        for (const k of STAT_KEYS) stats[k] = Number(clause?.mods?.stats?.[k]) || 0;
        const roll = {};
        for (const { key } of ROLL_KEYS) roll[key] = Number(clause?.mods?.roll?.[key]) || 0;
        const ec = clause?.endCheck ?? null;
        return {
            id,
            name: displayName(pres?.name ?? id),
            img: pres?.img ?? DEFAULT_ICON,
            rimColor: pres?.rimColor ?? "",
            isDefault: DEFAULT_IDS.has(id),
            description: clause?.description ?? "",
            stats,
            roll,
            dotAmount: Number(clause?.dot?.amount) || 0,
            dotBypassArmor: !!clause?.dot?.bypassArmor,
            dotEveryLocation: clause?.dot?.scope === "all-locations",
            dotAblateArmor: Number(clause?.dot?.ablateArmor) || 0,
            restrictAct: !!clause?.restrict?.act,
            restrictDefend: !!clause?.restrict?.defend,
            restrictHard: !!clause?.restrict?.hard,
            incomingDC: clause?.incomingDC ?? "",
            endKind: ec ? (ec.kind === "stunSave" ? "stunSave" : "skill") : "none",
            endSkill: ec?.skill ?? "",
            endDC: ec?.dc ?? "",
            endActionCost: ec?.actionCost ?? 0,
            clearsAtOwnTurn: clause?.clearsAt === "ownTurnStart",
            clearOnHit: !!clause?.clearOnHit,
            periodicEvery: clause?.periodic?.everyRounds ?? "",
            periodicRollUnder: clause?.periodic?.rollUnder ?? "",
            // Stress shield (Stoic / Hopeful) — declarative absorb buffer
            // wired through statusEngine.onApply. "none" means this status is
            // not a shield (default for every clause that doesn't opt in).
            stressShieldKind: clause?.stressShield?.kind ?? "none",
            stressShieldDice: String(clause?.stressShield?.dice ?? "")
        };
    }

    /* The RAW-default row for an id (no override) — used for the save-time
     * diff so an untouched status is omitted from the override. */
    static #defaultRow(id) {
        return StatusEffectsEditor.#rowFromClause(id, DEFAULT_PRESENTATION[id], STATUS_CLAUSES[id]);
    }

    /* Canonical stored override entry for a row, empties dropped. Both the
     * working row and the default row pass through here, so equality holds
     * exactly when nothing changed. */
    static #entryFromRow(row) {
        const entry = { name: row.name, img: row.img };
        if (row.rimColor && /^#[0-9a-f]{3,8}$/i.test(String(row.rimColor).trim())) {
            entry.rimColor = String(row.rimColor).trim();
        }
        if (row.description) entry.description = row.description;

        const stats = {};
        for (const k of STAT_KEYS) if (Number(row.stats?.[k])) stats[k] = Number(row.stats[k]);
        const roll = {};
        for (const { key } of ROLL_KEYS) if (Number(row.roll?.[key])) roll[key] = Number(row.roll[key]);
        const mods = {};
        if (Object.keys(stats).length) mods.stats = stats;
        if (Object.keys(roll).length) mods.roll = roll;
        if (Object.keys(mods).length) entry.mods = mods;

        const amt = Number(row.dotAmount) || 0;
        if (amt > 0) {
            const dot = { amount: amt };
            if (row.dotBypassArmor) dot.bypassArmor = true;
            if (row.dotEveryLocation) dot.scope = "all-locations";
            if (Number(row.dotAblateArmor) > 0) dot.ablateArmor = Number(row.dotAblateArmor);
            entry.dot = dot;
        }

        const restrict = {};
        if (row.restrictAct) restrict.act = true;
        if (row.restrictDefend) restrict.defend = true;
        if (row.restrictHard) restrict.hard = true;
        if (Object.keys(restrict).length) entry.restrict = restrict;

        if (row.incomingDC !== "" && row.incomingDC != null && Number.isFinite(Number(row.incomingDC))) {
            entry.incomingDC = Number(row.incomingDC);
        }

        if (row.endKind === "stunSave") {
            entry.endCheck = { kind: "stunSave" };
        } else if (row.endKind === "skill" && row.endSkill) {
            entry.endCheck = { kind: "skill", skill: row.endSkill, dc: Number(row.endDC) || 0 };
            if (Number(row.endActionCost) > 0) entry.endCheck.actionCost = Number(row.endActionCost);
        }

        if (row.clearsAtOwnTurn) entry.clearsAt = "ownTurnStart";
        if (row.clearOnHit) entry.clearOnHit = true;

        const every = Number(row.periodicEvery) || 0;
        if (every > 0) {
            entry.periodic = { everyRounds: every };
            if (row.periodicRollUnder) entry.periodic.rollUnder = row.periodicRollUnder;
        }

        // Stress shield — only persisted when kind is points / sources. Dice
        // default to "1d6" if the GM left the field blank but picked a kind,
        // so the buffer still has SOMETHING to roll against.
        if (row.stressShieldKind === "points" || row.stressShieldKind === "sources") {
            entry.stressShield = {
                kind: row.stressShieldKind,
                dice: row.stressShieldDice || "1d6"
            };
        }
        return entry;
    }

    /* ─────────── working-set lifecycle ─────────── */

    /* Build the initial working set: every live status (defaults merged with
     * the current override), in registry order with customs appended. */
    #initWorking() {
        const override = readStatusOverride();
        const rows = [];
        for (const id of DEFAULT_IDS) {
            const o = override[id];
            if (o?.removed) continue;
            if (isHomebrewGatedOff(id)) continue;  // hide if its toggle is off
            const clause = o ? StatusEffectsEditor.#stripPresentation(o) : STATUS_CLAUSES[id];
            const pres = {
                name:     o?.name     ?? DEFAULT_PRESENTATION[id].name,
                img:      o?.img      ?? DEFAULT_PRESENTATION[id].img,
                rimColor: o?.rimColor ?? DEFAULT_PRESENTATION[id].rimColor
            };
            rows.push(StatusEffectsEditor.#rowFromClause(id, pres, clause));
        }
        for (const [id, o] of Object.entries(override)) {
            if (DEFAULT_IDS.has(id) || !o || o.removed) continue;
            if (isHomebrewGatedOff(id)) continue;
            rows.push(StatusEffectsEditor.#rowFromClause(id, { name: o.name, img: o.img, rimColor: o.rimColor }, StatusEffectsEditor.#stripPresentation(o)));
        }
        this.#working = rows;
    }

    static #stripPresentation(entry) {
        const { name, img, rimColor, removed, ...clause } = entry;
        return clause;
    }

    /* Pull the rendered inputs back into #working so add/remove keep edits. */
    #syncFromForm() {
        if (!this.element) return;
        const data = foundry.utils.expandObject(new foundry.applications.ux.FormDataExtended(this.element).object);
        const rows = data.s || {};
        const next = [];
        for (const key of Object.keys(rows).sort((a, b) => Number(a) - Number(b))) {
            const r = rows[key];
            const stats = {};
            for (const k of STAT_KEYS) stats[k] = Number(r.stats?.[k]) || 0;
            const roll = {};
            for (const { key: rk } of ROLL_KEYS) roll[rk] = Number(r.roll?.[rk]) || 0;
            next.push({
                id: String(r.id || "").trim(),
                name: String(r.name ?? "").trim(),
                img: String(r.img ?? "").trim() || DEFAULT_ICON,
                rimColor: String(r.rimColor ?? "").trim(),
                isDefault: r.isDefault === true || r.isDefault === "true",
                description: String(r.description ?? "").trim(),
                stats,
                roll,
                dotAmount: Number(r.dotAmount) || 0,
                dotBypassArmor: !!r.dotBypassArmor,
                dotEveryLocation: !!r.dotEveryLocation,
                dotAblateArmor: Number(r.dotAblateArmor) || 0,
                restrictAct: !!r.restrictAct,
                restrictDefend: !!r.restrictDefend,
                restrictHard: !!r.restrictHard,
                incomingDC: r.incomingDC === "" || r.incomingDC == null ? "" : Number(r.incomingDC),
                endKind: String(r.endKind || "none"),
                endSkill: String(r.endSkill || ""),
                endDC: r.endDC === "" || r.endDC == null ? "" : Number(r.endDC),
                endActionCost: Number(r.endActionCost) || 0,
                clearsAtOwnTurn: !!r.clearsAtOwnTurn,
                clearOnHit: !!r.clearOnHit,
                periodicEvery: r.periodicEvery === "" || r.periodicEvery == null ? "" : Number(r.periodicEvery),
                periodicRollUnder: String(r.periodicRollUnder || ""),
                stressShieldKind: String(r.stressShieldKind || "none"),
                stressShieldDice: String(r.stressShieldDice || "").trim()
            });
        }
        this.#working = next;
    }

    /* ─────────── context ─────────── */

    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        if (!this.#working) this.#initWorking();

        const skillMap = CONFIG.WITCHER?.skillMap ?? {};
        const skillKeys = Object.keys(skillMap)
            .filter(k => typeof skillMap[k] === "object")
            .sort((a, b) => this.#skillLabel(a).localeCompare(this.#skillLabel(b)));

        ctx.statuses = this.#working.map((row, index) => this.#statusView(row, index, skillKeys));
        ctx.buttons = [{ type: "submit", icon: "fa-solid fa-floppy-disk", label: "Save & Reload" }];
        // Gate the per-card "Stress shield" section behind the stress
        // homebrew toggle — if stress is off, the editor doesn't expose any
        // stress-shaped controls anywhere.
        try { ctx.showStressShield = !!game.settings?.get?.(SYSTEM_ID, "homebrew.stress"); }
        catch { ctx.showStressShield = false; }
        return ctx;
    }

    /* Wire the rim-color picker ↔ text input pairs. The text field is the
     * canonical form value (Foundry's FormDataExtended only reads named
     * inputs); the color picker is unnamed and exists purely for the visual
     * "pick a hex" UX. Two-way sync: typing in the text updates the swatch;
     * picking a color overwrites the text. */
    _onRender(context, options) {
        super._onRender?.(context, options);
        const root = this.element;
        if (!root) return;
        for (const pick of root.querySelectorAll("input[data-rim-picker]")) {
            const idx = pick.dataset.rimPicker;
            const text = root.querySelector(`input[data-rim-text="${idx}"]`);
            if (!text) continue;
            pick.addEventListener("input", () => { text.value = pick.value; });
            text.addEventListener("input", () => {
                const v = text.value.trim();
                if (/^#[0-9a-f]{6}$/i.test(v)) pick.value = v;
            });
        }
    }

    #skillLabel(key) {
        const k = CONFIG.WITCHER?.skillLabel?.(key);
        return k ? game.i18n.localize(k) : key;
    }

    #statLabel(key) {
        const k = CONFIG.WITCHER?.statLabel?.(key);
        const out = k ? game.i18n.localize(k) : key;
        return (!out || out.startsWith("WITCHER.")) ? key.toUpperCase() : out;
    }

    #statusView(row, index, skillKeys) {
        const opt = (value, label, selected) => ({ value, label, selected });
        return {
            index,
            id: row.id,
            name: row.name,
            img: row.img,
            rimColor: row.rimColor || "",
            isDefault: row.isDefault,
            description: row.description,
            statRows: STAT_KEYS.map(k => ({ key: k, label: this.#statLabel(k), value: row.stats?.[k] || 0 })),
            rollRows: ROLL_KEYS.map(r => ({ key: r.key, label: r.label, value: row.roll?.[r.key] || 0 })),
            dotAmount: row.dotAmount || 0,
            dotBypassArmor: row.dotBypassArmor,
            dotEveryLocation: row.dotEveryLocation,
            dotAblateArmor: row.dotAblateArmor || 0,
            restrictAct: row.restrictAct,
            restrictDefend: row.restrictDefend,
            restrictHard: row.restrictHard,
            incomingDC: row.incomingDC,
            endKindOptions: END_KINDS.map(e => opt(e.value, e.label, row.endKind === e.value)),
            endIsSkill: row.endKind === "skill",
            skillOptions: skillKeys.map(k => opt(k, this.#skillLabel(k), row.endSkill === k)),
            endDC: row.endDC,
            endActionCost: row.endActionCost || 0,
            clearsAtOwnTurn: row.clearsAtOwnTurn,
            clearOnHit: row.clearOnHit,
            periodicEvery: row.periodicEvery,
            rollUnderOptions: [opt("", "—", !row.periodicRollUnder)]
                .concat(STAT_KEYS.map(k => opt(k, this.#statLabel(k), row.periodicRollUnder === k))),
            stressShieldKind: row.stressShieldKind || "none",
            stressShieldDice: row.stressShieldDice || "",
            stressShieldOptions: [
                opt("none",    "None (not a shield)",          row.stressShieldKind === "none" || !row.stressShieldKind),
                opt("points",  "Absorbs N points of stress",   row.stressShieldKind === "points"),
                opt("sources", "Absorbs N stress sources",     row.stressShieldKind === "sources")
            ]
        };
    }

    /* ─────────── actions ─────────── */

    static async #onAddStatus() {
        this.#syncFromForm();
        const id = this.#uniqueId("status");
        this.#working.push(StatusEffectsEditor.#rowFromClause(id, { name: "New Status", img: DEFAULT_ICON }, { description: "" }));
        this.render();
    }

    static async #onRemoveStatus(event, target) {
        this.#syncFromForm();
        const index = Number(target.dataset.index);
        if (Number.isInteger(index)) this.#working.splice(index, 1);
        this.render();
    }

    static async #onResetAll() {
        const ok = await foundry.applications.api.DialogV2.confirm({
            window: { title: "Restore RAW defaults?" },
            content: "<p>Discard all status customizations and restore the strict Core Rulebook defaults? This takes effect when you Save.</p>",
            modal: true,
            rejectClose: false
        }).catch(() => false);
        if (!ok) return;
        this.#working = Object.keys(STATUS_CLAUSES)
            .filter(id => DEFAULT_IDS.has(id))
            .filter(id => !isHomebrewGatedOff(id))
            .map(id => StatusEffectsEditor.#defaultRow(id));
        // Include any default presentation ids without a clause (markers).
        for (const id of DEFAULT_IDS) {
            if (this.#working.some(r => r.id === id)) continue;
            if (isHomebrewGatedOff(id)) continue;
            this.#working.push(StatusEffectsEditor.#rowFromClause(id, DEFAULT_PRESENTATION[id], STATUS_CLAUSES[id]));
        }
        this.render();
    }

    /* Clear the rim-color override for a card so it falls back to the family
     * default (or the RAW amber if no family). Reset both the text input
     * (which is the canonical form value) and the visual color picker beside
     * it. No re-render — the form change is in-place. */
    static async #onClearRim(event, target) {
        const index = Number(target.dataset.index);
        if (!Number.isInteger(index)) return;
        const text = this.element.querySelector(`input[name="s.${index}.rimColor"]`);
        if (text) text.value = "";
        const pick = this.element.querySelector(`input[data-rim-picker="${index}"]`);
        if (pick) pick.value = "#c8a878";
    }

    static async #onPickIcon(event, target) {
        const index = Number(target.dataset.index);
        const input = this.element.querySelector(`input[name="s.${index}.img"]`);
        const current = input?.value || DEFAULT_ICON;
        const fp = new foundry.applications.apps.FilePicker.implementation({
            type: "image",
            current,
            callback: (path) => {
                if (input) input.value = path;
                const preview = this.element.querySelector(`img[data-preview="${index}"]`);
                if (preview) preview.src = path;
            }
        });
        fp.render(true);
    }

    #uniqueId(base) {
        const taken = new Set([...DEFAULT_IDS, ...this.#working.map(r => r.id)]);
        let i = 1;
        let id = `${base}-${i}`;
        while (taken.has(id)) id = `${base}-${++i}`;
        return id;
    }

    /* ─────────── submit ─────────── */

    static async #onSubmit(event, form, formData) {
        this.#syncFromForm();
        const rows = this.#working;

        // Validate ids: non-empty, unique, slug-safe.
        const seen = new Set();
        for (const row of rows) {
            const id = String(row.id || "").trim();
            if (!id || !/^[a-z0-9][a-z0-9-]*$/i.test(id)) {
                ui.notifications.error(`Invalid status id "${row.id}". Use letters, numbers, and hyphens.`);
                throw new Error("invalid status id");
            }
            if (seen.has(id)) {
                ui.notifications.error(`Duplicate status id "${id}".`);
                throw new Error("duplicate status id");
            }
            seen.add(id);
        }

        const override = {};
        for (const row of rows) {
            const entry = StatusEffectsEditor.#entryFromRow(row);
            if (DEFAULT_IDS.has(row.id)) {
                const def = StatusEffectsEditor.#entryFromRow(StatusEffectsEditor.#defaultRow(row.id));
                if (!foundry.utils.objectsEqual(entry, def)) override[row.id] = entry;
            } else {
                override[row.id] = entry;
            }
        }
        // Any default the GM removed from the list → store a tombstone.
        for (const id of DEFAULT_IDS) {
            if (!seen.has(id)) override[id] = { removed: true };
        }

        await game.settings.set(SYSTEM_ID, STATUS_OVERRIDE_SETTING, override);
        ui.notifications.info("Status effects saved.");
        // The setting is requiresReload:true, but Foundry's auto-reload prompt
        // only fires from the native Configure Settings panel. Our custom
        // editor has to invoke it itself — otherwise the GM saves, the panel
        // closes, and no reload happens (so CONFIG.statusEffects keeps the
        // stale values until they manually refresh).
        const SettingsConfig = foundry.applications?.settings?.SettingsConfig
                            ?? globalThis.SettingsConfig;
        try { await SettingsConfig?.reloadConfirm?.({ world: true }); }
        catch (err) { console.warn("witcher-ttrpg-death-march | status editor reload prompt failed", err); }
    }
}
