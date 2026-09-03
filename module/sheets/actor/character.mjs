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
import { tierForSatiety, tierDisplayName, isHungerActive, setHungerActive, getSatietyCeil, getSatietyGorgedCeil, getSatietyFloor, hourlySatietyLoss } from "../../mechanics/foodAndDrink.mjs";
import { isHomebrewEnabled } from "../../api/homebrew.mjs";

import { t, tFormat } from "../../chrome/lib/i18n.js";
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
            togglePinSpell(event, target) { return this._onTogglePinSpell(target); },
            toggleProfSkill(event, target) { return this._onToggleProfSkill(target); },
            clearIpLog(event, target) { return this._onClearIpLog(); },
            // Per-actor hunger opt-in — GM checkbox in the tracker strip.
            toggleHunger(event, target) { return this._onToggleHunger(target); },
            // Satiety pill click → open the SatietyDialog for full readout + GM edit.
            // Surface load / open errors as notifications so a broken import
            // doesn't fail silently (the click was silently no-op'ing before
            // we hardened the dialog module).
            async openSatiety(event, target) {
                try {
                    const { openSatietyDialog } = await import("../../applications/satietyDialog.mjs");
                    await openSatietyDialog(this.actor);
                } catch (err) {
                    console.error("[wdm] failed to open SatietyDialog:", err);
                    ui.notifications?.error(tFormat("WITCHER.Mech.FoodAndDrink.Notify.SatietyDialogFailed", { reason: err?.message ?? err }, `Satiety dialog failed to open: ${err?.message ?? err}`));
                }
            },
            // Saves — prompt for a modifier (shared saveMixin dialog).
            rollStunSave(event, target) { return this.actor.promptSave?.({ type: "stun" }); },
            rollDeathSave(event, target) { return this.actor.promptSave?.({ type: "death" }); },
            // Same combat helpers the dock fires, threaded with this actor.
            rollBrawl(event, target)  { return this.actor.brawlAttack?.(); },
            rollCrit(event, target)   { return openCriticalDialog(this.actor); },
            rollFumble(event, target) { return openFumbleDialog(this.actor); }
        }
    };

    /* Persist the hunger opt-in flag from the tracker checkbox. GM-only —
     * mirrors the same permission gate as satiety edits. Reads the checkbox
     * state at click time (Foundry has already toggled it by then). */
    async _onToggleHunger(target) {
        if (!game.user?.isGM) return;
        const checked = !!target?.checked;
        await setHungerActive(this.actor, checked);
        ui.notifications?.info(tFormat("WITCHER.Notify.Character.HungerToggled", { state: checked ? "enabled" : "disabled", actor: this.actor.name }, "Hunger {state} for {actor}."));
    }

    /* Wipe the IP spending ledger (system.logs.ipLog). This only clears the
     * history readout — it does NOT refund or recompute improvementPoints,
     * which are tracked separately. Confirmed first since it's irreversible. */
    async _onClearIpLog() {
        const entries = this.actor.system?.logs?.ipLog ?? [];
        if (!entries.length) return;
        const ok = await foundry.applications.api.DialogV2.confirm({
            window: { title: t("WITCHER.Dialog.IpLog.Clear", "Clear IP Log") },
            content: `<p>${t("WITCHER.Sheet.Actor.Character.Text.ClearAll", "Clear all")} <strong>${entries.length}</strong> IP log ${entries.length === 1 ? "entry" : "entries"}? This only clears the history — it won't change your IP totals.</p>`
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
        /* Skill-rank inputs are unnamed (see the template comment): they
         * display EFFECTIVE rank (source + AE addend) and translate back
         * on change so the SOURCE is what actually persists. Without this
         * intercept, an AE-granted rank would either be double-counted
         * (Foundry writes effective → source, AE re-adds on top) or the
         * rank input would fight the AE every render. The delegated
         * change listener bypasses the form-submit path and calls
         * `actor.update` directly with the source value. */
        const rankInputs = this.element?.querySelectorAll?.('[data-skill-input]');
        for (const inp of (rankInputs ?? [])) {
            if (inp.dataset.wdmRankWired) continue;
            inp.dataset.wdmRankWired = "1";
            inp.addEventListener("change", async (ev) => {
                /* Stop the form-submit chain — this input isn't part of
                 * the tracked schema binding. */
                ev.stopPropagation();
                const addend = Number(inp.dataset.aeAddend) || 0;
                const stat   = String(inp.dataset.stat  ?? "");
                const skill  = String(inp.dataset.skill ?? "");
                if (!stat || !skill) return;
                let effective = Math.round(Number(inp.value) || 0);
                /* Clamp to the same window the input's min/max enforce,
                 * defensively — direct type-in bypasses the min/max
                 * validation in older browsers. Floor at addend (the AE
                 * would restore anything below), ceiling at 10. */
                effective = Math.max(addend, Math.min(10, effective));
                const source = Math.max(0, effective - addend);
                try {
                    await this.actor.update({
                        [`system.skills.${stat}.${skill}.value`]: source
                    });
                } catch (err) {
                    console.warn("witcher-ttrpg-death-march | skill rank update failed", err);
                }
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
            /* Per-stat cap — read the PREPARED value so any AE that
             * raises/lowers `system.stats.X.cap` flows through. Default
             * to 10 for existing worlds pre-schema-update. Feeds the
             * +1 button's data-max via the adjustValue action, so a
             * cap of 12 lets the player click their way from 10 → 12. */
            const cap = Number(sys.stats?.[key]?.cap) || 10;
            return {
                key,
                abbr: STAT_ABBR[key] ?? key.toUpperCase(),
                name: `system.stats.${key}.value`,
                base, modified, showMod: true,
                min: 1, max: cap,
                /* Attr cells render in the monster-sheet layout: big modified
                 * on top, small editable base + delta chip on the bottom.
                 * LUCK and REP keep the legacy character-sheet layout (big
                 * editable base, no primary modified readout). */
                isAttr: true,
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
        // Encumbrance = carried weight vs capacity (BODY×10). getTotalWeight is
        // the same authoritative sum the top-bar chip uses (already rounded).
        const encCarried = Math.round((Number(this.actor.getTotalWeight?.() ?? 0) || 0) * 100) / 100;
        const encMax     = Number(d.enc) || 0;
        ctx.derivedPills = [
            { label: t("WITCHER.Sheet.Actor.Character.Text.Stun", "Stun"),    val: d.stun, action: "rollStunSave", title: t("WITCHER.Dialog.StunSave", "Stun save — 1d10 ≤ Stun (Core p.152)") },
            { label: t("WITCHER.Sheet.Actor.Character.Dialog.Button.Run", "Run"),     val: d.run },
            { label: t("WITCHER.Sheet.Actor.Character.Dialog.Button.Leap", "Leap"),    val: d.leap },
            { label: t("WITCHER.Sheet.Actor.Character.Dialog.Button.Enc", "Enc"),     val: `${encCarried} / ${encMax}`, over: encCarried > encMax, title: t("WITCHER.Chrome.Character.Tip.Enc", "Max carrying weight (BODY × 10)") },
            { label: t("WITCHER.Sheet.Actor.Character.Dialog.Button.Rec", "Rec"),     val: d.rec },
            { label: "WT",      val: d.woundThreshold },
            { label: t("WITCHER.Sheet.Actor.Character.Dialog.Button.Resolve", "Resolve"), val: d.resolve },
            { label: t("WITCHER.Sheet.Actor.Character.Dialog.Button.Melee", "Melee"),   val: mb >= 0 ? `+${mb}` : `${mb}` }
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

        // ── Satiety (homebrew foodAndDrink). Rendered as a tracker in the
        //    main HUD strip alongside Stress when the toggle is on. Editable
        //    by GMs only (preUpdateActor in mechanics/foodAndDrink.mjs strips
        //    player writes server-side; the input here matches that with a
        //    readonly attribute so the UI signals it). The tier label sits
        //    below the value as a sub-line so the player sees a name, not
        //    just a number.
        const satietyOn = isHomebrewEnabled("foodAndDrink");
        if (satietyOn) {
            // Slim pill data + tiny stomach glyph geometry. Full readout
            // (numeric current/max, GM edit form) lives in SatietyDialog.
            const satVal = Number(sys.satiety) || 0;
            const tier = tierForSatiety(satVal, this.actor);
            const satMax = getSatietyCeil(this.actor);
            const satGorgedMax = getSatietyGorgedCeil(this.actor);
            // Single unified color — the tier is communicated by the
            // stomach fill level + tier label, not by color shift. Label
            // comes from the shared, localized tierDisplayName helper
            // (also used by the chrome pill and the SatietyDialog).
            const visual = { label: tierDisplayName(tier), color: "#b89464" };
            // Fill % of the stomach body for the tiny inline glyph.
            const fillPct = satMax > 0 ? Math.max(0, Math.min(100, Math.round((satVal / satMax) * 100))) : 0;
            // Stomach in 191.756-unit viewBox — body y=8..180 (172 tall).
            const fillHeight = Math.round(172 * (fillPct / 100));
            const fillTop    = Math.round(8 + (172 - fillHeight));
            let overflowPct = 0;
            if (satVal > satMax && satGorgedMax > satMax) {
                overflowPct = Math.max(0, Math.min(100, Math.round(((satVal - satMax) / (satGorgedMax - satMax)) * 100)));
            }
            const overflowWidth = Math.round(80 * (overflowPct / 100));
            ctx.satiety = {
                tier,
                tierLabel:  visual.label,
                tierColor:  visual.color,
                fillTop, fillHeight, overflowPct, overflowWidth
            };
        } else {
            ctx.satiety = null;
        }

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
    /* Pin / unpin a spell for the dock's pinned-spells row. Same actor flag the
     * chrome character panel and the dock use (`flags.<sys>.pinnedSpells`). The
     * setFlag re-renders both this sheet (pin highlight) and the dock. */
    async _onTogglePinSpell(target) {
        const id = target.closest("[data-item-id]")?.dataset.itemId;
        if (!id) return;
        const MID = "witcher-ttrpg-death-march";
        const cur = new Set(Array.isArray(this.actor.flags?.[MID]?.pinnedSpells)
            ? this.actor.flags[MID].pinnedSpells : []);
        if (cur.has(id)) cur.delete(id); else cur.add(id);
        await this.actor.setFlag(MID, "pinnedSpells", [...cur]);
    }

    async _onCastItem(target) {
        const id = target.closest("[data-item-id]")?.dataset.itemId;
        const item = this.actor.items.get(id);
        if (!item) return;
        if (typeof this.actor.castSpell !== "function") { item.sheet?.render(true); return; }
        try {
            /* Snapshot combat state before the cast — an area spell's async
             * template placement transiently nulls game.combat, which would make
             * the post-cast spend think we're out of combat. Force it through if
             * the actor was in combat and on turn at cast time. */
            const forceSpend = !!(this.actor?._inActiveCombat && this.actor?._isMyTurn);
            const res = await this.actor.castSpell(item);
            if (!res) return;
            if (res.fullRound) await this.actor.recordFullRound?.(`Cast: ${item.name}`, { force: forceSpend });
            else await this.actor.spendActionSlot?.(`Cast: ${item.name}`, { force: forceSpend });
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
