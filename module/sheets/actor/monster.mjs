/**
 * WitcherMonsterSheet — monster / NPC creature actor sheet.
 *
 * Tabbed GM editor (combat / skills / knowledge / loot / notes). Inline
 * array rows (attacks, abilities, vulnerabilities, loot, knowledge tiers)
 * are edited in place; each carries a `shown` flag the bestiary/research
 * layer will later read. The sheet is a GM editor, so it renders every
 * entry and dims the hidden ones — `shown` gates the *player-facing*
 * views, not this one.
 *
 * Hook name: `renderWitcherMonsterSheet`.
 */

import { WitcherActorSheet } from "./base.mjs";
import { getActiveWeaponQualities, WEAPON_QUALITIES } from "../../setup/config.mjs";
import { openFumbleDialog }   from "../../chrome/chrome/fumble-dialog.js";
import { openCriticalDialog } from "../../chrome/chrome/critical-roll.js";

const SYSTEM_ID  = "witcher-ttrpg-death-march";
const MONSTER_TABS = ["combat", "skills", "knowledge", "loot", "inventory", "effects", "notes"];

/* System-relative paths of every inline-editable ArrayField on this sheet.
 * submitOnChange posts the whole form, so each of these arrives as an
 * index-keyed object holding ONLY the named inputs of each row. An
 * ArrayField replaces wholesale and fills missing fields with defaults, so
 * button-toggled (`shown`) and hidden (`uuid`) fields would silently reset
 * on every keystroke-blur. `_processFormData` merges the partial back into
 * the current full array to preserve them. */
const MONSTER_ARRAY_PATHS = [
    "combat.attacks",
    "combat.specialAbilities",
    "combat.vulnerabilities",
    "knowledge",
    "loot"
];

/* Item types that, when dropped, become a loot row instead of an embedded
 * item. A humanoid monster's *weapons* still embed normally (handled by the
 * super drop) — these are harvest/drop materials. Mutagens are NOT here: a
 * monster has a single signature mutagen, linked in its own slot. */
const LOOT_DROP_TYPES = new Set(["component", "alchemical", "valuable", "map", "remains"]);

/* Resolve a list of weapon-quality keys into display rows. Parameterized
 * qualities fold their stored value into the label (`Silver(2d6)`) and
 * expose the raw value + placeholder so an inline editor can bind to it.
 * Falls back to the canonical WEAPON_QUALITIES for `param` shape so a GM
 * settings override that predates parameterization can't suppress it. */
function formatQualityList(keys, values, catalog) {
    return (keys ?? []).map(key => {
        const entry = catalog[key] ?? WEAPON_QUALITIES[key];
        if (!entry) return null;
        const param = entry.param ?? WEAPON_QUALITIES[key]?.param ?? null;
        let label = entry.label;
        let value = "";
        if (param) {
            const raw = values?.[key];
            value = raw == null ? "" : String(raw).trim();
            if (value.length) label = `${entry.label}(${value}${param.suffix ?? ""})`;
        }
        return {
            key, label, description: entry.description,
            param: !!param,
            value,
            placeholder: param?.placeholder ?? "",
            suffix: param?.suffix ?? ""
        };
    }).filter(Boolean);
}

/* Resolve a linked item's icon synchronously for display. fromUuidSync
 * returns a live world doc or a compendium index entry (both carry `img`);
 * falls back to a generic bag when the source is missing/unindexed. */
function lootIcon(uuid) {
    if (!uuid) return "icons/svg/item-bag.svg";
    try { return foundry.utils.fromUuidSync(uuid)?.img ?? "icons/svg/item-bag.svg"; }
    catch (_) { return "icons/svg/item-bag.svg"; }
}

/* Catalog keys not already present — the add-quality dropdown options. */
function addableQualities(keys, catalog) {
    const have = new Set(keys ?? []);
    return Object.entries(catalog)
        .filter(([k]) => !have.has(k))
        .map(([value, entry]) => ({ value, label: entry.label }))
        .sort((a, b) => a.label.localeCompare(b.label));
}

export class WitcherMonsterSheet extends WitcherActorSheet {

    static DEFAULT_OPTIONS = {
        classes: [...WitcherActorSheet.DEFAULT_OPTIONS.classes, "monster"],
        position: { width: 760, height: 720 },
        actions: {
            // Combat actions. Initiative is overridden (below) to drop the
            // monster into the encounter AND roll; the saves delegate to the
            // shared actor methods (saveMixin); the fumble/crit dialogs are the
            // same universal functions the dock fires, threaded with this actor
            // so a crit rolled here applies to THIS monster.
            rollInitiative(event, target) { return this._addToCombatAndRoll(); },
            rollStunSave(event, target)  { return this.actor.promptSave?.({ type: "stun" }); },
            rollDeathSave(event, target) { return this.actor.promptSave?.({ type: "death" }); },
            rollFumble(event, target)    { return openFumbleDialog(this.actor); },
            rollCrit(event, target)      { return openCriticalDialog(this.actor); },
            addRow:              WitcherMonsterSheet._onAddRow,
            deleteRow:           WitcherMonsterSheet._onDeleteRow,
            toggleImmunity:      WitcherMonsterSheet._onToggleImmunity,
            rollMonsterAttack:   WitcherMonsterSheet._onRollMonsterAttack,
            openLootItem:        WitcherMonsterSheet._onOpenLootItem,
            addRandomLoot:       WitcherMonsterSheet._onAddRandomLoot,
            removePoolItem:      WitcherMonsterSheet._onRemovePoolItem,
            toggleRandomPool:    WitcherMonsterSheet._onToggleRandomPool,
            clearMutagen:        WitcherMonsterSheet._onClearMutagen,
            removeSkill:         WitcherMonsterSheet._onRemoveSkill,
            removeAttackQuality: WitcherMonsterSheet._onRemoveAttackQuality,
            removeWeaponQuality: WitcherMonsterSheet._onRemoveWeaponQuality,
            configRemainsIcon:   WitcherMonsterSheet._onConfigRemainsIcon
        }
    };

    static PARTS = {
        main: {
            template: "systems/witcher-ttrpg-death-march/templates/actor/monster/main.hbs",
            // "" = the part's own root element (.wdm-actor-sheet) is the
            // scroller. A descendant selector would never match the root,
            // so scroll wouldn't survive submitOnChange re-renders.
            scrollable: [""]
        }
    };

    /* Build {value,label,selected} option lists from a CONFIG map. */
    static _opts(map, current) {
        return Object.entries(map).map(([value, label]) => ({
            value,
            label: game.i18n.localize(label),
            selected: value === current
        }));
    }

    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        const sys = this.actor.system;

        // The saddlebag Inventory tab only exists when this creature is a
        // rideable mount — a non-mount monster has no rider-facing carry slot.
        const isMount = !!sys.mount?.isMount;
        const tabList = MONSTER_TABS.filter(t => t !== "inventory" || isMount);
        ctx.isMount = isMount;

        // Active tab — own namespace so the character-sheet default ("stats")
        // never leaks in. Validated against the (mount-aware) tab list, so a
        // stale "inventory" flag falls back to "combat" once isMount is off.
        const flagged = this.actor.getFlag(SYSTEM_ID, "activeTab");
        ctx.activeTab = tabList.includes(flagged) ? flagged : "combat";
        ctx.tabs = tabList.map(t => ({
            id: t,
            label: `WITCHER.Monster.Tab.${t.charAt(0).toUpperCase() + t.slice(1)}`,
            active: t === ctx.activeTab
        }));

        const W = CONFIG.WITCHER;
        ctx.categoryOptions   = WitcherMonsterSheet._opts(W.monster.types,      sys.category);
        ctx.threatOptions     = WitcherMonsterSheet._opts(W.monster.threat,     sys.threat?.difficulty);
        ctx.complexityOptions = WitcherMonsterSheet._opts(W.monster.complexity, sys.threat?.complexity);

        // Per-damage-type reaction rows.
        const reactions = W.monster.damageReactions;
        ctx.damageRows = Object.entries(W.damageTypes ?? {}).map(([key, label]) => ({
            key,
            label: game.i18n.localize(label),
            options: WitcherMonsterSheet._opts(reactions, sys.combat?.damageProfile?.[key] ?? "none")
        }));

        // Status-reaction checklist — collapse tier variants (bleed-1/-2 →
        // bleed) so the GM toggles a status family, not each tier. Each chip
        // is tri-state: none → resistant → immune (see _onToggleImmunity).
        const immune = new Set(sys.combat?.statusImmunities ?? []);
        const resist = new Set(sys.combat?.statusResistances ?? []);
        const seen = new Set();
        ctx.immunityList = [];
        for (const eff of (CONFIG.statusEffects ?? [])) {
            const base = eff.id.replace(/-\d+$/, "");
            if (seen.has(base)) continue;
            seen.add(base);
            const state = immune.has(base) ? "immune" : resist.has(base) ? "resistant" : "none";
            const reactKey = { none: "None", resistant: "Resistant", immune: "Immune" }[state];
            ctx.immunityList.push({
                id: base,
                label: game.i18n.localize(eff.name),
                state,
                reactLabel: game.i18n.localize(`WITCHER.Monster.React.${reactKey}`)
            });
        }

        // Skill option list for knowledge-tier skill pickers (sorted by label).
        const skillMap = W.skillMap ?? {};
        const skillLabel = (key) => game.i18n.localize(W.skillLabel?.(key) ?? key);
        const statLabel  = (key) => game.i18n.localize(W.statLabel?.(key) ?? key);
        const skillOptions = Object.keys(skillMap)
            .filter(k => typeof skillMap[k] === "object")
            .map(value => ({ value, label: skillLabel(value) }))
            .sort((a, b) => a.label.localeCompare(b.label));

        // Skills tab shows only *trained* skills (rank > 0) grouped by stat —
        // a monster touches a handful of the 39, so listing them all is noise.
        // Empty stat groups are dropped. Untrained skills are surfaced through
        // the add-skill picker (sets a chosen skill's rank to 1).
        const trainedGroups = [];
        for (const [statKey, group] of Object.entries(sys.skills ?? {})) {
            const rows = [];
            for (const [key, sk] of Object.entries(group)) {
                if (!(Number(sk?.value) > 0)) continue;
                rows.push({
                    statKey, key,
                    label: skillLabel(key),
                    value: sk.value,
                    modifier: sk.modifier,
                    total: sk.total,
                    isDifficult: sk.isDifficult
                });
            }
            if (!rows.length) continue;
            rows.sort((a, b) => a.label.localeCompare(b.label));
            trainedGroups.push({ statKey, statLabel: statLabel(statKey), skills: rows });
        }
        ctx.trainedSkillGroups = trainedGroups;
        ctx.hasTrainedSkills   = trainedGroups.length > 0;
        ctx.addableSkills = Object.keys(skillMap)
            .filter(k => typeof skillMap[k] === "object")
            .filter(k => !(Number(sys.skills?.[skillMap[k].statKey]?.[k]?.value) > 0))
            .map(value => ({ value, label: skillLabel(value) }))
            .sort((a, b) => a.label.localeCompare(b.label));

        const idx = (arr) => (arr ?? []).map((row, i) => ({ ...row, index: i }));

        // Weapon-quality catalog (GM override or seed defaults). Inline attacks
        // carry quality keys (+ parameterized values); dragged weapon Items
        // bring their own, edited on the item but surfaced here too.
        const qCatalog = getActiveWeaponQualities() ?? {};

        ctx.attacks = (sys.combat?.attacks ?? []).map((row, i) => ({
            ...row,
            index: i,
            qualities: formatQualityList(row.qualities, row.qualityValues, qCatalog),
            addableQualities: addableQualities(row.qualities, qCatalog),
            skillOptions: skillOptions.map(o => ({ ...o, selected: o.value === row.skill }))
        }));
        ctx.abilities = idx(sys.combat?.specialAbilities);
        ctx.vulns = idx(sys.combat?.vulnerabilities);
        // Random-loot pools collapse by default so a large pool (e.g. the
        // 88-item Random Possessions list) doesn't flood the tab. The set of
        // indices the GM has expanded is transient per-sheet state.
        const expanded = this._expandedPools ??= new Set();
        ctx.loot = (sys.loot ?? []).map((row, i) => {
            const pool = (row.pool ?? []).map(c => ({
                ...c,
                isTable: c.kind === "table",
                img: c.kind === "table" ? null : lootIcon(c.uuid)
            }));
            return {
                ...row,
                index: i,
                isRandom: row.kind === "random",
                linked: !!row.uuid,
                img: row.uuid ? lootIcon(row.uuid) : null,
                pool,
                collapsed: pool.length > 0 && !expanded.has(i)
            };
        });

        ctx.knowledgeTiers = (sys.knowledge ?? []).map((row, i) => ({
            ...row,
            index: i,
            skillLabel: skillLabel(row.skill),
            skillOptions: skillOptions.map(o => ({ ...o, selected: o.value === row.skill }))
        }));

        // Embedded weapon items — a humanoid monster can wield real weapons,
        // each retaining (and editable for) its own qualities.
        ctx.weaponItems = this.actor.items.filter(i => i.type === "weapon").map(w => ({
            id: w.id,
            name: w.name,
            img: w.img,
            damage: w.system?.damage,
            qualities: formatQualityList(w.system?.qualities, w.system?.qualityValues, qCatalog),
            addableQualities: addableQualities(w.system?.qualities, qCatalog)
        }));

        // ── Inventory (saddlebag) tab ────────────────────────────────────
        // Every embedded item that isn't surfaced elsewhere as a stat-block
        // entry (i.e. not the signature mutagen) is carried gear. Containers
        // sort first; weight is qty×weight, the same rule the chrome saddlebag
        // and character encumbrance use. The mount's carry cap is the scalar
        // derivedStats.enc (BODY×10).
        const carried = this.actor.items
            .filter(i => i.type !== "criticalWound" && i.type !== "mutagen" && !i.system?.isStored)
            .map(i => {
                const s = i.system ?? {};
                const qty = Number(s.quantity) || 0;
                const wt  = Number(s.weight)   || 0;
                return {
                    id: i.id,
                    name: i.name,
                    img: i.img,
                    type: i.type,
                    isContainer: i.type === "container",
                    qty: qty || 1,
                    weight: Math.round(qty * wt * 100) / 100
                };
            })
            .sort((a, b) => (b.isContainer - a.isContainer) || a.name.localeCompare(b.name));

        let totalWeight = 0;
        for (const i of this.actor.items) {
            const s = i.system ?? {};
            if (s.isCarried === false || s.isStored === true) continue;
            totalWeight += (Number(s.quantity) || 0) * (Number(s.weight) || 0);
        }
        if (typeof sys.calcCurrencyWeight === "function") {
            totalWeight += Number(sys.calcCurrencyWeight()) || 0;
        }
        totalWeight = Math.round(totalWeight * 100) / 100;
        const encMax = Number(sys.derivedStats?.enc) || 0;
        ctx.mountInventory = {
            items: carried,
            hasItems: carried.length > 0,
            totalWeight,
            encMax,
            over: encMax > 0 && totalWeight > encMax,
            fillPct: encMax > 0 ? Math.min(100, Math.round((totalWeight / encMax) * 100)) : 0
        };

        return ctx;
    }

    /**
     * Initiative for a monster: ensure an active encounter exists, add this
     * monster's token(s) as combatants (tokenless actors get a single
     * actor-only combatant), then roll RAW initiative (1d10 + REF, post-AE)
     * for them. REF is baked into the formula rather than relying on
     * getRollData, since this system registers no initiative formula. Only
     * combatants that haven't rolled yet are rolled, so re-clicking doesn't
     * re-roll an already-placed monster.
     */
    async _addToCombatAndRoll() {
        const actor = this.actor;
        try {
            let combat = game.combat;
            if (!combat) {
                combat = await CONFIG.Combat.documentClass.create(
                    { scene: canvas?.scene?.id ?? null, active: true });
            }
            if (!combat) {
                ui.notifications.error("Could not create or find a combat encounter.");
                return;
            }

            // This actor's tokens on the combat's scene (TokenDocuments).
            const sceneId = combat.scene?.id ?? canvas?.scene?.id ?? null;
            const tokens = actor.getActiveTokens(false, true)
                .filter(t => !sceneId || t.scene?.id === sceneId);

            const placed = new Set(combat.combatants.map(c => c.tokenId).filter(Boolean));
            if (tokens.length) {
                const toAdd = tokens
                    .filter(t => !placed.has(t.id))
                    .map(t => ({ tokenId: t.id, sceneId: t.scene.id, actorId: actor.id, hidden: t.hidden }));
                if (toAdd.length) await combat.createEmbeddedDocuments("Combatant", toAdd);
            } else if (!combat.combatants.some(c => c.actorId === actor.id)) {
                await combat.createEmbeddedDocuments("Combatant", [{ actorId: actor.id }]);
            }

            // Roll only the not-yet-rolled combatants for this actor.
            const mine = combat.combatants.filter(c => c.actorId === actor.id);
            const ids  = mine.filter(c => c.initiative == null).map(c => c.id);
            const rollIds = ids.length ? ids : mine.map(c => c.id);
            if (rollIds.length) {
                const ref = Number(actor.system?.stats?.ref?.value) || 0;
                await combat.rollInitiative(rollIds, { formula: `1d10 + ${ref}` });
            }
            if (!combat.active && typeof combat.activate === "function") await combat.activate();
        } catch (err) {
            ui.notifications.error("Failed to roll initiative into combat — see console.");
            console.error(err);
        }
    }

    /**
     * Bind the add-skill / add-quality dropdowns. These selects carry no
     * `name`, so they never submit — but a bare `change` would still bubble
     * to the form and trigger a submitOnChange re-render that resets the
     * picker before the user's choice is committed. Binding on the select
     * itself + `stopPropagation` lets us intercept the choice first and run
     * the targeted update. Guarded per-element (re-render re-binds new nodes).
     */
    async _onRender(context, options) {
        await super._onRender(context, options);
        const root = this.element;
        if (!root) return;
        root.querySelectorAll("select[data-add-picker]").forEach(sel => {
            if (sel.dataset.addBound) return;
            sel.dataset.addBound = "1";
            sel.addEventListener("change", (event) => {
                event.stopPropagation();
                const value = sel.value;
                sel.value = "";
                if (!value) return;
                switch (sel.dataset.addPicker) {
                    case "skill":         this._addSkill(value); break;
                    case "attackQuality": this._addAttackQuality(Number(sel.dataset.index), value); break;
                    case "weaponQuality": this._addWeaponQuality(sel.dataset.itemId, value); break;
                }
            });
        });
    }

    /* ── Skills (relevant-only + add picker) ───────────────────────── */
    /* "Train" a skill by setting its rank to 1 — it then surfaces in the
     * trained list where the rank input can fine-tune it. */
    async _addSkill(key) {
        const statKey = CONFIG.WITCHER.skillMap?.[key]?.statKey;
        if (!statKey) return;
        await this._flushForm();
        await this.actor.update({ [`system.skills.${statKey}.${key}.value`]: 1 });
    }

    /* Configure the remains (carcass) and trophy icons for this monster.
     * Opens a small dialog with two image inputs, each with a FilePicker
     * browse button (the proven _onEditImage pattern). Saved to
     * system.remainsIcon / system.trophyIcon, consumed by monster-remains.js
     * and the Take Trophy action. */
    static async _onConfigRemainsIcon(event, target) {
        if (!this.isEditable) return;
        const actor    = this.actor;
        const DialogV2 = foundry.applications.api.DialogV2;
        const FP       = foundry.applications.apps.FilePicker.implementation;
        const remains  = actor.system.remainsIcon || actor.img;
        const trophy   = actor.system.trophyIcon  || actor.img;
        const row = (label, name, val) =>
            `<div class="form-group" style="display:flex;align-items:center;gap:6px;margin:6px 0;">
               <label style="flex:0 0 96px;">${label}</label>
               <img class="ricfg-prev" data-for="${name}" src="${val}"
                    style="width:32px;height:32px;object-fit:cover;border:1px solid #555;border-radius:3px;" />
               <input type="text" name="${name}" value="${val}" style="flex:1;min-width:0;" />
               <button type="button" class="ricfg-browse" data-for="${name}" title="Browse">
                 <i class="fa-solid fa-folder-open"></i></button>
             </div>`;
        const result = await DialogV2.prompt({
            window: { title: "Trophy/Remains Icons" },
            content: `<form>${row("Remains icon", "remainsIcon", remains)}${row("Trophy icon", "trophyIcon", trophy)}</form>`,
            modal: false,
            rejectClose: false,
            render: (ev, dialog) => {
                const root = dialog?.element ?? dialog;
                root.querySelectorAll?.(".ricfg-browse").forEach((btn) => {
                    btn.addEventListener("click", () => {
                        const name  = btn.dataset.for;
                        const input = root.querySelector(`input[name="${name}"]`);
                        new FP({
                            type: "image",
                            current: input?.value,
                            callback: (path) => {
                                if (input) input.value = path;
                                const prev = root.querySelector(`img.ricfg-prev[data-for="${name}"]`);
                                if (prev) prev.src = path;
                            }
                        }).render(true);
                    });
                });
            },
            ok: {
                label: "Save",
                callback: (e, button) => ({
                    remainsIcon: (button.form.elements.remainsIcon.value || "").trim(),
                    trophyIcon:  (button.form.elements.trophyIcon.value  || "").trim()
                })
            }
        }).catch(() => null);
        if (!result) return;
        await actor.update({
            "system.remainsIcon": result.remainsIcon || "",
            "system.trophyIcon":  result.trophyIcon  || ""
        });
    }

    /* Untrain — rank back to 0 drops the row from the relevant list. */
    static async _onRemoveSkill(event, target) {
        const statKey  = target.dataset.stat;
        const skillKey = target.dataset.skill;
        if (!statKey || !skillKey) return;
        await this._flushForm();
        await this.actor.update({ [`system.skills.${statKey}.${skillKey}.value`]: 0 });
    }

    /* ── Attack qualities (inline rows) ────────────────────────────── */
    async _addAttackQuality(index, key) {
        if (!Number.isInteger(index) || !key) return;
        await this._flushForm();
        const arr = this._readArray("combat.attacks");
        const row = arr[index];
        if (!row) return;
        const set = new Set(row.qualities ?? []);
        if (set.has(key)) return;
        set.add(key);
        row.qualities = [...set];
        await this.actor.update({ "system.combat.attacks": arr });
    }

    static async _onRemoveAttackQuality(event, target) {
        const index = Number(target.dataset.index);
        const key   = target.dataset.quality;
        if (!Number.isInteger(index) || !key) return;
        await this._flushForm();
        const arr = this._readArray("combat.attacks");
        const row = arr[index];
        if (!row) return;
        row.qualities = (row.qualities ?? []).filter(k => k !== key);
        if (row.qualityValues) delete row.qualityValues[key];
        await this.actor.update({ "system.combat.attacks": arr });
    }

    /* ── Weapon qualities (embedded Items — edits the weapon itself) ── */
    async _addWeaponQuality(itemId, key) {
        const item = this.actor.items.get(itemId);
        if (!item || item.type !== "weapon" || !key) return;
        await this._flushForm();
        const set = new Set(item.system?.qualities ?? []);
        if (set.has(key)) return;
        set.add(key);
        await item.update({ "system.qualities": [...set] });
    }

    static async _onRemoveWeaponQuality(event, target) {
        const itemId = target.dataset.itemId;
        const key    = target.dataset.quality;
        const item = this.actor.items.get(itemId);
        if (!item || !key) return;
        await this._flushForm();
        await item.update({ "system.qualities": (item.system?.qualities ?? []).filter(k => k !== key) });
    }

    /* Read a system ArrayField as a mutable clone for whole-array writes. */
    _readArray(path) {
        return foundry.utils.deepClone(
            foundry.utils.getProperty(this.actor.system, path) ?? []
        );
    }

    /**
     * Repair inline-array submissions BEFORE the document validates them.
     * submitOnChange posts the whole form; expandObject leaves each ArrayField
     * as `{0:{…},1:{…}}` holding only that row's *named* inputs. If this reaches
     * `_prepareSubmitData`'s `document.validate({clean,copy:false})`, the
     * ArrayField cleans in place — rebuilding the array and resetting every
     * un-named field (`shown`, loot `uuid`, random-loot `kind`/`pool`, attack
     * `qualities`) to its default. A random-loot card would silently revert to
     * a plain item row on any field edit. So we overlay each row's edited fields
     * onto a clone of the live array HERE (pre-validate) and hand validate a
     * complete array, leaving the un-named fields intact.
     */
    _processFormData(event, form, formData) {
        const data = super._processFormData(event, form, formData);
        for (const path of MONSTER_ARRAY_PATHS) {
            const partial = foundry.utils.getProperty(data, `system.${path}`);
            if (!partial || typeof partial !== "object") continue;
            const current = this._readArray(path);
            const entries = Array.isArray(partial)
                ? partial.map((v, i) => [i, v])
                : Object.entries(partial);
            for (const [k, patch] of entries) {
                const i = Number(k);
                if (Number.isInteger(i) && current[i] && patch && typeof patch === "object") {
                    foundry.utils.mergeObject(current[i], patch);
                }
            }
            foundry.utils.setProperty(data, `system.${path}`, current);
        }
        return data;
    }

    /**
     * Append a blank row to an array field. The element carries
     * `data-array="<system-relative path>"`. Foundry rebuilds the
     * ArrayField against schema, so an empty object gets default fields.
     */
    static async _onAddRow(event, target) {
        const path = target.dataset.array;
        if (!path) return;
        await this._flushForm();
        const arr = this._readArray(path);
        arr.push({});
        await this.actor.update({ [`system.${path}`]: arr });
    }

    /* Remove a row. Element carries `data-array` + `data-index`. */
    static async _onDeleteRow(event, target) {
        const path = target.dataset.array;
        const index = Number(target.dataset.index);
        if (!path || !Number.isInteger(index)) return;
        await this._flushForm();
        const arr = this._readArray(path);
        if (index < 0 || index >= arr.length) return;
        arr.splice(index, 1);
        await this.actor.update({ [`system.${path}`]: arr });
    }

    /* Roll an inline monster attack (Core p.163): to-hit = 1d10 + the
     * attack's chosen combat skill (stat + rank + mods, already summed into
     * skill.total), plus a damage roll. Both land in one chat card. */
    static async _onRollMonsterAttack(event, target) {
        const index = Number(target.dataset.index);
        const attack = this.actor.system?.combat?.attacks?.[index];
        if (!attack) return;

        const skillMap  = CONFIG.WITCHER?.skillMap ?? {};
        const skillKey  = attack.skill || "melee";
        const statKey   = skillMap[skillKey]?.statKey ?? "ref";
        const total     = Number(this.actor.system?.skills?.[statKey]?.[skillKey]?.total) || 0;
        const skillLbl  = game.i18n.localize(CONFIG.WITCHER?.skillLabel?.(skillKey) ?? skillKey);

        const hitRoll = await new Roll(`1d10 + ${total}`).evaluate();

        const dmgFormula = (attack.damage ?? "").trim();
        let dmgRoll = null;
        if (dmgFormula) {
            try { dmgRoll = await new Roll(dmgFormula).evaluate(); } catch { dmgRoll = null; }
        }

        const name   = attack.name || game.i18n.localize("WITCHER.Monster.Attacks");
        const rof    = Number(attack.rof) || 1;
        const effect = (attack.effect ?? "").trim();
        const sign   = total >= 0 ? "+" : "";
        const dmgLine = dmgRoll
            ? `<div style="font-size:11px;opacity:0.85">${game.i18n.localize("WITCHER.Monster.ColDamage")}: <strong>${dmgRoll.total}</strong> <span style="opacity:0.6">(${dmgFormula})</span></div>`
            : (dmgFormula ? `<div style="font-size:11px;opacity:0.85">${game.i18n.localize("WITCHER.Monster.ColDamage")}: <strong>${dmgFormula}</strong></div>` : "");

        await hitRoll.toMessage({
            speaker: ChatMessage.getSpeaker({ actor: this.actor }),
            flavor: `<h3>${this.actor.name} — ${name} <span style="font-size:10px;opacity:0.65">×${rof}</span></h3>
                     <div style="font-size:11px;opacity:0.85">${game.i18n.localize("WITCHER.Monster.Attack")}: ${skillLbl} ${sign}${total}</div>
                     ${dmgLine}
                     ${effect ? `<div style="font-size:11px;opacity:0.85">${game.i18n.localize("WITCHER.Monster.ColEffect")}: ${effect}</div>` : ""}`
        });

        if (dmgRoll && game.dice3d) game.dice3d.showForRoll(dmgRoll, game.user, true);
    }

    /* Cycle a status id's reaction: none → resistant → immune → none.
     * Resist + immune live in two parallel arrays (a status is in at most
     * one); the bestiary lists resistances under Resistances and immunities
     * under Immunities. Element: `data-status`. */
    static async _onToggleImmunity(event, target) {
        const id = target.dataset.status;
        if (!id) return;
        await this._flushForm();
        const immune = new Set(this.actor.system.combat?.statusImmunities ?? []);
        const resist = new Set(this.actor.system.combat?.statusResistances ?? []);
        if (immune.has(id))      immune.delete(id);                   // immune → none
        else if (resist.has(id)) { resist.delete(id); immune.add(id); } // resistant → immune
        else                     resist.add(id);                     // none → resistant
        await this.actor.update({
            "system.combat.statusImmunities":  [...immune],
            "system.combat.statusResistances": [...resist]
        });
    }

    /* Open the source Item sheet for a loot row that links one. */
    static async _onOpenLootItem(event, target) {
        const uuid = target.dataset.uuid;
        if (!uuid) return;
        const doc = await fromUuid(uuid);
        doc?.sheet?.render(true);
    }

    /**
     * Drop handling — harvest materials become loot rows; everything else
     * (notably weapons for humanoid monsters) embeds via the default flow.
     */
    /**
     * Target-aware drop. A drop landing inside a random-loot card's zone
     * (`[data-random-loot]`) adds the dropped Item OR RollTable to that
     * pool instead of the default flow. Everything else falls through to
     * the standard dispatch (`_onDropItem` etc.). RollTables only have a
     * destination here — the base sheet ignores them otherwise.
     */
    async _onDropDocument(event, document) {
        const zone = event.target?.closest?.("[data-random-loot]");
        if (zone && (document.documentName === "Item" || document.documentName === "RollTable")) {
            await this._addToRandomPool(Number(zone.dataset.randomLoot), document);
            return document;
        }
        return super._onDropDocument(event, document);
    }

    /* Append a candidate to a random-loot pool. Candidates never stack —
     * a repeat uuid is a no-op (the pool is a set of distinct options). */
    async _addToRandomPool(index, document) {
        if (!Number.isInteger(index)) return;
        await this._flushForm();
        const arr = this._readArray("loot");
        const row = arr[index];
        if (!row || row.kind !== "random") return;
        const pool = Array.isArray(row.pool) ? row.pool : [];
        if (pool.some(c => c.uuid === document.uuid)) return;
        pool.push({
            name: document.name,
            uuid: document.uuid,
            kind: document.documentName === "RollTable" ? "table" : "item"
        });
        row.pool = pool;
        await this.actor.update({ "system.loot": arr });
    }

    /* Add a blank random-loot row (a drop target for building a pool). */
    static async _onAddRandomLoot(event, target) {
        await this._flushForm();
        const arr = this._readArray("loot");
        arr.push({ kind: "random", name: "", shown: false, pool: [] });
        await this.actor.update({ "system.loot": arr });
    }

    /* Collapse / expand a random-loot pool. Pure UI toggle: flip the DOM
     * class and the transient instance set so it survives the next render,
     * without a full re-render (keeps scroll position and edit focus). */
    static _onToggleRandomPool(event, target) {
        const index = Number(target.dataset.index);
        if (!Number.isInteger(index)) return;
        const set = this._expandedPools ??= new Set();
        const card = target.closest("[data-random-loot]");
        const willCollapse = !card?.classList.contains("is-collapsed");
        if (willCollapse) set.delete(index); else set.add(index);
        card?.classList.toggle("is-collapsed", willCollapse);
        const icon = target.querySelector("i");
        if (icon) {
            icon.classList.toggle("fa-chevron-right", willCollapse);
            icon.classList.toggle("fa-chevron-down", !willCollapse);
        }
        target.setAttribute("aria-expanded", String(!willCollapse));
    }

    /* Remove one candidate from a random-loot pool. */
    static async _onRemovePoolItem(event, target) {
        const index = Number(target.dataset.index);
        const uuid  = target.dataset.uuid;
        if (!Number.isInteger(index) || !uuid) return;
        await this._flushForm();
        const arr = this._readArray("loot");
        const row = arr[index];
        if (!row) return;
        row.pool = (row.pool ?? []).filter(c => c.uuid !== uuid);
        await this.actor.update({ "system.loot": arr });
    }

    async _onDropItem(event, item) {
        await this._flushForm();
        // A drop landing in the Inventory tab's saddlebag zone embeds the item
        // (or container) as real carried gear — bypassing the mutagen slot and
        // loot-row routing that govern drops elsewhere on the sheet.
        if (event.target?.closest?.("[data-inventory-zone]")) {
            return super._onDropItem(event, item);
        }
        if (item.type === "mutagen") {
            await this.actor.update({
                "system.mutagen": { name: item.name, uuid: item.uuid }
            });
            return item;
        }
        // Dropping ANY item onto the loot block links it as a loot row;
        // component/alchemical/valuable items always loot regardless of where
        // they land (they have no combat representation on a monster).
        const inLootZone = !!event.target?.closest?.("[data-loot-zone]");
        if (inLootZone || LOOT_DROP_TYPES.has(item.type)) {
            const arr = this._readArray("loot");
            arr.push({ kind: "item", name: item.name, qty: "1", uuid: item.uuid, shown: false });
            await this.actor.update({ "system.loot": arr });
            return item;
        }
        return super._onDropItem(event, item);
    }

    /* Unlink the signature mutagen. */
    static async _onClearMutagen(event, target) {
        await this._flushForm();
        await this.actor.update({ "system.mutagen": { name: "", uuid: "" } });
    }
}
