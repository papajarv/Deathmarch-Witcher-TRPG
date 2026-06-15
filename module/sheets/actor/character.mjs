/**
 * WitcherCharacterSheet — character actor sheet.
 *
 * Hook name: `renderWitcherCharacterSheet` (matches the class name; future
 * chrome injection hooks ported from overhaul-ui target this name).
 *
 * Composes `healSheetMixin` so the chrome dock's Rest button (which calls
 * `actor.sheet._onHeal()`) finds its handler — and so the in-sheet Heal
 * button (data-action="heal") can reuse the same dialog.
 *
 * The base sheet (`WitcherActorSheet`) builds the shared actor context
 * (hpBar, armorByLocation, equipableItems, magicGroups, gearGroups,
 * effects, criticalWounds, profession/race/homeland items, …). This
 * subclass layers on the character-specific view-model the chrome-styled
 * layout needs: a flat statblock (8 attrs + LUCK + REP), derived-stat
 * pills, vital bar percentages, the total-stats tally, and a tab set
 * tuned to the new layout.
 */

import { WitcherActorSheet } from "./base.mjs";
import { healSheetMixin } from "./mixins/healSheetMixin.mjs";
import { openFumbleDialog }   from "../../chrome/chrome/fumble-dialog.js";
import { openCriticalDialog } from "../../chrome/chrome/critical-roll.js";

// Statblock cell order + 3-letter abbreviations (BOD / WIL match the
// printed sheet). LUCK and REP are appended as special cells.
const STAT_ORDER = ["int", "ref", "dex", "body", "spd", "emp", "will", "cra"];
const STAT_ABBR  = { int: "INT", ref: "REF", dex: "DEX", body: "BOD", spd: "SPD", emp: "EMP", will: "WIL", cra: "CRA" };

// Tabs available in the redesigned layout. Validated against the persisted
// flag so a stale "stats" (the base default / old layout) falls back cleanly.
const CHAR_TABS = ["combat", "skills", "magic", "inventory", "profession", "background", "effects"];

export class WitcherCharacterSheet extends healSheetMixin(WitcherActorSheet) {

    static DEFAULT_OPTIONS = {
        classes: [...WitcherActorSheet.DEFAULT_OPTIONS.classes, "character"],
        position: { width: 980, height: 820 },
        actions: {
            // Bridge the data-action to the mixin's instance method. Action
            // handlers run with `this` bound to the sheet instance.
            heal(event, target) { return this._onHeal(); },
            castItem(event, target) { return this._onCastItem(target); },
            toggleProfSkill(event, target) { return this._onToggleProfSkill(target); },
            clearIpLog(event, target) { return this._onClearIpLog(); },
            // Saves — prompt for a modifier (shared saveMixin dialog).
            rollStunSave(event, target) { return this.actor.promptSave?.({ type: "stun" }); },
            rollDeathSave(event, target) { return this.actor.promptSave?.({ type: "death" }); },
            // Same combat helpers the dock fires, threaded with this actor.
            rollBrawl(event, target)  { return this.actor.brawlAttack?.(); },
            rollCrit(event, target)   { return openCriticalDialog(this.actor); },
            rollFumble(event, target) { return openFumbleDialog(this.actor); }
        }
    };

    /* Wipe the IP spending ledger (system.logs.ipLog). This only clears the
     * history readout — it does NOT refund or recompute improvementPoints,
     * which are tracked separately. Confirmed first since it's irreversible. */
    async _onClearIpLog() {
        const entries = this.actor.system?.logs?.ipLog ?? [];
        if (!entries.length) return;
        const ok = await foundry.applications.api.DialogV2.confirm({
            window: { title: "Clear IP Log" },
            content: `<p>Clear all <strong>${entries.length}</strong> IP log ${entries.length === 1 ? "entry" : "entries"}? This only clears the history — it won't change your IP totals.</p>`
        });
        if (ok) await this.actor.update({ "system.logs.ipLog": [] });
    }

    static PARTS = {
        main: {
            template: "systems/witcher-ttrpg-death-march/templates/actor/character/main.hbs",
            scrollable: [".wcs-panels"]
        }
    };

    /** Skip auto re-renders (document updates, world-clock ticks, etc.) while the
     *  Notes ProseMirror editor is OPEN — a re-render rebuilds the element and
     *  loses unsaved text. Forced/user renders still pass; the editor's `close`
     *  event triggers the deferred render once editing ends. */
    async render(options, ...rest) {
        const force = options === true || options?.force === true;
        if (!force && this.element?.querySelector("prose-mirror.wcs-notes-editor.active")) {
            return this;
        }
        return super.render(options, ...rest);
    }

    async _onRender(context, options) {
        await super._onRender(context, options);
        const pm = this.element?.querySelector("prose-mirror.wcs-notes-editor");
        if (pm && !pm.dataset.wdmCloseWired) {
            pm.dataset.wdmCloseWired = "1";
            // On save/close: commit the edited content, then do the re-render we
            // deferred while the editor was open.
            pm.addEventListener("close", async () => {
                await this.submit({ render: false }).catch(() => {});
                this.render(false);
            });
        }
    }

    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);

        const sys = this.actor.system;
        const src = this.actor.toObject().system;

        // Notes display: a `toggled` <prose-mirror> renders its INNER HTML
        // (#enriched) when inactive, NOT its `value` — an empty element shows
        // blank even when the value is saved. Feed the enriched notes as inner
        // content so saved notes display after the editor closes.
        const TE = foundry?.applications?.ux?.TextEditor?.implementation
                ?? foundry?.applications?.ux?.TextEditor ?? window?.TextEditor;
        ctx.enrichedNotes = sys.notes
            ? await (TE?.enrichHTML?.(sys.notes, { async: true, relativeTo: this.actor, secrets: this.actor.isOwner }) ?? sys.notes)
            : "";

        // ── Active tab — override the base default ("stats", from the old
        //    layout) with the redesigned tab set. A persisted flag that's no
        //    longer a valid tab falls back to "combat".
        const flag = this.actor.getFlag("witcher-ttrpg-death-march", "activeTab");
        ctx.activeTab = CHAR_TABS.includes(flag) ? flag : "combat";

        // ── Statblock cells. Each editable input binds `value` to the SOURCE
        //    (pre-AE) number the player allocates, while `name` targets the
        //    prepared path for the update. The `mod` readout shows the
        //    post-AE delta (wound/death penalties, racial AE, etc.).
        const signDelta = (delta) => ({
            delta,
            deltaSign: delta > 0 ? "plus" : delta < 0 ? "minus" : "zero",
            deltaText: delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : "±0"
        });

        const attrCells = STAT_ORDER.map(key => {
            const base = Number(src.stats?.[key]?.value) || 0;
            const modified = Number(sys.stats?.[key]?.value) || 0;
            return {
                key,
                abbr: STAT_ABBR[key] ?? key.toUpperCase(),
                name: `system.stats.${key}.value`,
                base, modified, showMod: true,
                min: 1, max: 10,
                ...signDelta(modified - base)
            };
        });

        // LUCK cell binds the stat (luck.max). The spendable pool (luck.value)
        // lives in the trackers row, not here.
        const luckBase = Number(src.stats?.luck?.max) || 0;
        const luckMod  = Number(sys.stats?.luck?.max) || 0;
        const luckCell = {
            key: "luck", abbr: "LUCK", isLuck: true,
            name: "system.stats.luck.max",
            base: luckBase, modified: luckMod, showMod: true,
            // LUCK is the one core stat allowed to be 0 (others floor at 1).
            min: 0, max: 10,
            ...signDelta(luckMod - luckBase)
        };

        // REP has no AE pipeline — display the value, editable in place.
        const repVal = Number(sys.general?.reputation?.value) || 0;
        const repCell = {
            key: "rep", abbr: "REP", isRep: true,
            name: "system.general.reputation.value",
            base: repVal, modified: repVal, showMod: false,
            ...signDelta(0)
        };

        ctx.statCells = [...attrCells, luckCell, repCell];

        // Sum of the nine statistics' base values (RAW "total stats") — the
        // eight core attributes plus LUCK (stored at stats.luck.max).
        ctx.totalStats = STAT_ORDER.reduce((s, k) => s + (Number(src.stats?.[k]?.value) || 0), 0)
            + (Number(src.stats?.luck?.max) || 0);

        // ── Derived-stat pills — all computed, read-only.
        const d = sys.derivedStats ?? {};
        const mb = Number(d.meleeBonus) || 0;
        ctx.derivedPills = [
            { label: "Stun",    val: d.stun, action: "rollStunSave", title: "Stun save — 1d10 ≤ Stun (Core p.152)" },
            { label: "Run",     val: d.run },
            { label: "Leap",    val: d.leap },
            { label: "Enc",     val: d.enc },
            { label: "Rec",     val: d.rec },
            { label: "WT",      val: d.woundThreshold },
            { label: "Resolve", val: d.resolve },
            { label: "Melee",   val: mb >= 0 ? `+${mb}` : `${mb}` }
        ];

        // ── Vital bar geometry (HP comes from base.mjs ctx.hpBar). STA + TOX
        //    need their own fill percentages for the bar.
        const pct = (v, m) => (m > 0 ? Math.round(Math.min(100, Math.max(0, (v / m) * 100))) : 0);
        const sta = d.sta ?? {};
        const tox = sys.stats?.toxicity ?? {};
        ctx.vitals = {
            sta: {
                value: Number(src.derivedStats?.sta?.value) || 0,
                max:   Number(sta.max) || 0,
                pct:   pct(Number(sta.value) || 0, Number(sta.max) || 0)
            },
            tox: {
                value: Number(src.stats?.toxicity?.value) || 0,
                max:   Number(tox.max) || 0,
                pct:   pct(Number(tox.value) || 0, Number(tox.max) || 0)
            }
        };

        // ── Player-set counters surfaced in the trackers row. `bodyValue`
        //    caps the adrenaline stepper (RAW p.153).
        ctx.bodyValue = Number(sys.stats?.body?.value) || 0;

        // ── Profession skill tree (defining skill + 3 advancement paths).
        //    Each rank input edits the embedded profession item's `.level`
        //    via data-prof-path (no form name → routed by _onProfRankChange,
        //    not the actor submit). Empty slots (no skillName) are dropped.
        const prof = this.actor.items.find(i => i.type === "profession");
        if (prof) {
            this._expandedProfSkills ??= new Set();
            const psys = prof.system ?? {};
            // `slotPath` is relative to the item's system (e.g.
            // "skillPath1.skill1") — the roll handler reads the live slot off
            // it, so a just-edited rank isn't stale. `path` (the .level path)
            // drives the rank input + the expand key.
            const slot = (s, slotPath) => (s?.skillName ? {
                skillName:  s.skillName,
                stat:       String(s.stat ?? "").toUpperCase(),
                level:      Number(s.level) || 0,
                definition: String(s.definition ?? "").trim(),
                path:       `system.${slotPath}.level`,
                slotPath,
                expanded:   this._expandedProfSkills.has(`system.${slotPath}.level`)
            } : null);
            const pathVM = (n) => {
                const p = psys[`skillPath${n}`];
                const skills = ["skill1", "skill2", "skill3"]
                    .map(k => slot(p?.[k], `skillPath${n}.${k}`))
                    .filter(Boolean);
                return { pathName: p?.pathName?.trim() || `Path ${n}`, skills };
            };
            ctx.professionTree = {
                defining: slot(psys.definingSkill, "definingSkill"),
                paths:    [pathVM(1), pathVM(2), pathVM(3)].filter(p => p.skills.length)
            };
        }

        // ── Homeland — a dropped homeland item (e.g. "Cidaris") drives the
        //    displayed origin; the free-text field is the manual fallback.
        ctx.homelandLabel = ctx.homelandItem?.name?.trim() || (sys.general?.homeland ?? "");

        return ctx;
    }

    /* Left-click a magic card → the cast dialog (castSpellMixin), then route the
     * action economy off the result exactly like the dock / chrome tab: a ritual
     * or multi-action cast locks the turn, else it takes an action slot. Falls
     * back to opening the item sheet if the cast flow isn't available. */
    async _onCastItem(target) {
        const id = target.closest("[data-item-id]")?.dataset.itemId;
        const item = this.actor.items.get(id);
        if (!item) return;
        if (typeof this.actor.castSpell !== "function") { item.sheet?.render(true); return; }
        try {
            const res = await this.actor.castSpell(item);
            if (!res) return;
            if (res.fullRound) await this.actor.recordFullRound?.(`Cast: ${item.name}`);
            else await this.actor.spendActionSlot?.(`Cast: ${item.name}`);
        } catch (err) {
            console.warn("witcher-ttrpg-death-march | castSpell failed", err);
        }
    }

    /* Expand/collapse a profession skill's description. State lives on the
     * sheet instance (keyed by the slot's data-prof-path), so it survives the
     * re-renders triggered by other edits / the world clock. */
    _onToggleProfSkill(target) {
        const key = target.dataset.profKey;
        if (!key) return;
        this._expandedProfSkills ??= new Set();
        if (this._expandedProfSkills.has(key)) this._expandedProfSkills.delete(key);
        else this._expandedProfSkills.add(key);
        this.render(false);
    }
}
