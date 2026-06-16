/**
 * WitcherActorSheet — base ApplicationV2 sheet for all actor types.
 *
 * Phase 4a: minimal scaffold so each actor type opens, renders its core
 * fields, and saves edits. Phase 4b replaces the templates with the
 * overhaul-ui chrome port.
 *
 * Sheet-class naming matters: Foundry fires the hook `renderWitcher<Type>Sheet`
 * automatically from the class's name. Our future chrome injection hooks
 * (ported from overhaul-ui) hang off these names.
 */

import { descriptionFor } from "../../mechanics/statusEngine.mjs";
import { drainHp, shieldBashDamage } from "../../setup/config.mjs";
import { buildConsumeEntry } from "../../chrome/policy/consume-item.js";
import { describeDuration } from "../../chrome/chrome/dock-statuses.js";
import {
    drawWeapon, sheathWeapon, dropWeaponToWorld, occupancyOf, isQuickItem,
    findContainerHoldingItem, moveItemToContainer, removeItemFromSource,
    canSpendCombatAction, chargeCombatAction
} from "../../chrome/chrome/inventory.js";
import { getCapacityDisplay } from "../../chrome/lib/container.js";
import { isActorInActiveCombat } from "../../chrome/lib/actor.js";
import { isAdrenalineEnabled } from "../../api/adrenaline.mjs";

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ActorSheetV2 } = foundry.applications.sheets;

const OIL_FLAG_SCOPE = "witcher-ttrpg-death-march";

// Item types that may be stowed inside a container from the sheet's
// right-click menu. Containers themselves are excluded (no nesting).
const STORABLE_TYPES = new Set([
    "weapon", "shield", "armor", "alchemical", "mutagen", "component",
    "diagrams", "enhancement", "food", "die", "valuable", "note",
    "map", "remains"
]);

// Field paths whose template siblings are COMPUTED (modified-stat column,
// HP/STA bars, derived block, skill totals). Editing one of these must
// re-render so the readout reflects the new base. Every OTHER field is
// independent — persisting it needs no re-render, and skipping the render
// keeps the focused input, its caret, and any open <select> alive instead of
// tearing the DOM out from under the user mid-edit (see _onChangeForm).
const DERIVED_FIELD_RE = /^system\.(stats|derivedStats|skills)\./;

// Read the soonest-expiring oil coating on a weapon (effect-based model).
// Returns { name, effect, remaining|Infinity } or null. Mirrors the chrome
// inventory/dock readers so the system sheet shows the same indicator.
function readWeaponOil(weapon) {
    if (weapon?.type !== "weapon") return null;
    let repRem = Infinity, name = null, repDur = null;
    const texts = [];
    for (const e of weapon.effects ?? []) {
        if (e.disabled) continue;
        const flag = e.getFlag?.(OIL_FLAG_SCOPE, "oilCoating");
        if (!flag) continue;
        const secs = Number(e.duration?.seconds);
        // v14 computes secondsRemaining from start.time + value/units.
        let remaining = Infinity;
        if (secs > 0) {
            const rem = Number(e.duration?.secondsRemaining);
            remaining = Number.isFinite(rem) ? rem : secs;
        }
        if (Number.isFinite(remaining) && remaining <= 0) continue;
        const d = String(e.description || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
        if (d) texts.push(d);
        // Carry the live duration object (not a derived seconds count) so the
        // label can flip wall-clock⇄rounds via describeDuration — same as the
        // dock and inventory.
        if (name == null || remaining < repRem) { repRem = remaining; repDur = e.duration; name = flag.oilName ?? e.name ?? "Oil"; }
    }
    if (name == null) return null;
    return { name, effect: texts.join(" · "), remaining: repRem, dur: repDur };
}

export class WitcherActorSheet extends HandlebarsApplicationMixin(ActorSheetV2) {

    /** Container ids the user has collapsed on the Inventory tab. Per-instance,
     *  survives re-renders (the sheet object persists); not persisted to disk. */
    _collapsedContainers = new Set();

    static DEFAULT_OPTIONS = {
        classes: ["witcher-ttrpg-death-march", "sheet", "actor"],
        position: { width: 720, height: 640 },
        window: { resizable: true },
        form: { submitOnChange: true, closeOnSubmit: false },
        actions: {
            editImage:        WitcherActorSheet._onEditImage,
            rollSkill:        WitcherActorSheet._onRollSkill,
            rollProfSkill:    WitcherActorSheet._onRollProfSkill,
            rollInitiative:   WitcherActorSheet._onRollInitiative,
            takeBreath:       WitcherActorSheet._onTakeBreath,
            stabilizeWound:   WitcherActorSheet._onStabilizeWound,
            treatWound:       WitcherActorSheet._onTreatWound,
            resolveWound:     WitcherActorSheet._onResolveWound,
            toggleEquip:      WitcherActorSheet._onToggleEquip,
            sheatheWeapon:    WitcherActorSheet._onSheatheWeapon,
            unequipWeapon:    WitcherActorSheet._onUnequipWeapon,
            dropWeapon:       WitcherActorSheet._onDropWeapon,
            toggleContainer:  WitcherActorSheet._onToggleContainer,
            rollWeapon:       WitcherActorSheet._onRollWeapon,
            cycleSkillCategory: WitcherActorSheet._onCycleSkillCategory,
            changeTab:        WitcherActorSheet._onChangeTab,
            changeSheetView:  WitcherActorSheet._onChangeSheetView,
            refillLuck:       WitcherActorSheet._onRefillLuck,
            adjustValue:      WitcherActorSheet._onAdjustValue,
            addLifeEvent:     WitcherActorSheet._onAddLifeEvent,
            editLifeEvent:    WitcherActorSheet._onEditLifeEvent,
            deleteLifeEvent:  WitcherActorSheet._onDeleteLifeEvent,
            editItem:         WitcherActorSheet._onEditItem,
            deleteItem:       WitcherActorSheet._onDeleteItem,
            createPerk:       WitcherActorSheet._onCreatePerk,
            createEffect:     WitcherActorSheet._onCreateEffect,
            editEffect:       WitcherActorSheet._onEditEffect,
            deleteEffect:     WitcherActorSheet._onDeleteEffect,
            toggleEffect:     WitcherActorSheet._onToggleEffect
        }
    };

    /**
     * Stack a dropped item into an existing identical stack instead of
     * creating a duplicate.  Only intercepts drops that would CREATE a new
     * item on this actor (foreign / cross-actor); same-actor drops (sorting)
     * fall through to the default handler.
     */
    async _onDropItem(event, item) {
        const foreign = item && item.parent?.id !== this.actor.id;
        // Professions aren't physical gear — never a combat "pick up". Create
        // it, then (on characters) prompt any skill packages and auto-mark the
        // granted + chosen skills as Profession (P).
        if (item?.type === "profession") {
            const result = await super._onDropItem(event, item);
            const created = Array.isArray(result) ? result[0] : result;
            const prof = created?.id ? created : this.actor.items.find(i => i.type === "profession" && i.name === item.name);
            if (prof) await this._markProfessionSkills(prof);
            return result;
        }
        // Character-build items (perk, race, homeland) aren't physical gear, so
        // they skip the combat "pick up" action cost — drop straight through.
        if (["perk", "race", "homeland"].includes(item?.type)) {
            return super._onDropItem(event, item);
        }
        // Picking an item up off the world is a combat action — refuse if no slot.
        if (foreign && !canSpendCombatAction(this.actor)) return [];
        if (foreign && typeof this.actor.findStackTarget === "function") {
            const data = item.toObject?.() ?? item;
            if (this.actor.findStackTarget(data)) {
                await this.actor.addItem(item, Number(item.system?.quantity) || 1);
                await chargeCombatAction(this.actor, `Pick up: ${item.name}`);
                return [];
            }
        }
        const result = await super._onDropItem(event, item);
        // Charge only when the drop actually created something on the actor.
        const created = Array.isArray(result) ? result.length > 0 : !!result;
        if (foreign && created) await chargeCombatAction(this.actor, `Pick up: ${item.name}`);
        return result;
    }

    /**
     * Resolve a dropped profession's granted-skill package on this character:
     * the always-granted `professionSkills`, plus the player's pick for each
     * "choose X of Y" package, all marked category "profession" (P). Skills
     * only — the defining skill + advancement trees are untouched.
     */
    async _markProfessionSkills(prof) {
        if (!prof || this.actor?.type !== "character") return;
        const W = CONFIG.WITCHER;
        const resolved = new Set(Array.from(prof.system?.professionSkills ?? []));

        const packages = Array.isArray(prof.system?.skillChoices) ? prof.system.skillChoices : [];
        for (const pkg of packages) {
            const options = Array.from(pkg?.options ?? []);
            if (!options.length) continue;
            const choose = Math.max(1, Math.min(Number(pkg?.choose) || 1, options.length));
            const picked = await this._promptSkillChoice(prof.name, choose, options);
            for (const k of picked) resolved.add(k);
        }

        const upd = {};
        for (const key of resolved) {
            const stat = W.skillMap?.[key]?.statKey;
            if (!stat) continue;
            if (!this.actor.system?.skills?.[stat]?.[key]) continue;
            upd[`system.skills.${stat}.${key}.category`] = "profession";
        }
        if (Object.keys(upd).length) await this.actor.update(upd);
    }

    /** Prompt the player to pick exactly `choose` of `optionKeys` (skill keys).
     *  Confirm stays disabled until the count is exact; over-picking is blocked.
     *  Returns the chosen keys ([] if cancelled). */
    async _promptSkillChoice(profName, choose, optionKeys) {
        const DialogV2 = foundry?.applications?.api?.DialogV2;
        if (!DialogV2) return optionKeys.slice(0, choose);
        const W = CONFIG.WITCHER;
        const rows = optionKeys.map(k =>
            `<label class="wdm-skillpick-row"><input type="checkbox" value="${k}" />
               <span>${game.i18n.localize(W.skillLabel(k))}</span></label>`).join("");
        const content = `<div class="wdm-skillpick">
            <p>Choose <strong>${choose}</strong> skill${choose > 1 ? "s" : ""} for <strong>${profName}</strong>:</p>
            ${rows}</div>`;
        const picked = await DialogV2.wait({
            window: { title: `Skill Package — ${profName}` },
            content,
            buttons: [{
                action: "ok", label: "Confirm", default: true,
                callback: (_e, _btn, dlg) => Array.from(
                    (dlg.element ?? dlg).querySelectorAll('input[type="checkbox"]:checked')
                ).map(c => c.value)
            }],
            rejectClose: false,
            render: (_e, dlg) => {
                const root = dlg?.element ?? dlg;
                const boxes = Array.from(root.querySelectorAll('input[type="checkbox"]'));
                const ok = root.querySelector('button[data-action="ok"]');
                const sync = () => {
                    const n = boxes.filter(b => b.checked).length;
                    boxes.forEach(b => { if (!b.checked) b.disabled = n >= choose; });
                    if (ok) ok.disabled = n !== choose;
                };
                boxes.forEach(b => b.addEventListener("change", sync));
                sync();
            }
        }).catch(() => null);
        return Array.isArray(picked) ? picked.slice(0, choose) : [];
    }

    async _prepareContext(options) {
        // Inherit `document`, `editable`, `fields`, etc. from
        // DocumentSheetV2. The parent sets `source = document._source`
        // (the WHOLE actor source — name, items, system, …). For our
        // templates the only useful piece is the system source, so we
        // override `source` to be just that. Editable inputs bind their
        // `value=` attribute to `source.stats.X.value` (the raw stored
        // base, what the player allocates IP into) while their `name=`
        // still targets `system.stats.X.value` for the update. The
        // readonly modified column reads `system.stats.X.value` (post-AE,
        // the value rolls and derived stats actually consume).
        const ctx = await super._prepareContext(options);
        ctx.actor    = this.actor;
        ctx.system   = this.actor.system;
        ctx.source   = this.actor.toObject().system;
        ctx.items    = this.actor.items.contents;
        ctx.WITCHER  = CONFIG.WITCHER;
        ctx.homebrew = (key) => game.system.api.homebrew.isEnabled(key);
        ctx.adrenalineEnabled = isAdrenalineEnabled();

        // HP bar geometry. Temp HP is a non-regenerable buffer (not hand-set:
        // granted by effects, drained before real HP). Temp folds into BOTH
        // displayed numbers: current = value+temp, max = max+temp (32/50 with
        // 30 temp reads 62/80). The bar denominator is max+temp; real HP fills
        // amber from the left, the temp buffer renders as a frost segment
        // contiguous with it, and missing real HP is the empty remainder.
        const hp   = this.actor.system?.derivedStats?.hp ?? {};
        const hpV  = Math.max(0, Number(hp.value) || 0);
        const hpM  = Math.max(0, Number(hp.max)   || 0);
        const hpT  = Math.max(0, Number(hp.temp)  || 0);
        const den  = (hpM + hpT) || 1;
        const pct  = (n) => Math.round((n / den) * 1000) / 10;   // 0.1% precision
        ctx.hpBar = {
            realValue:    hpV,
            realMax:      hpM,
            temp:         hpT,
            hasTemp:      hpT > 0,
            curDisplay:   hpV + hpT,
            maxDisplay:   hpM + hpT,
            fillPct:      pct(Math.min(hpV, hpM)),
            tempStartPct: pct(Math.min(hpV, hpM)),   // temp begins where real HP ends
            tempPct:      pct(hpT)
        };
        // Active tab — persists via flag so re-renders (from
        // submitOnChange) don't kick the user back to "stats".
        ctx.activeTab = this.actor.getFlag("witcher-ttrpg-death-march", "activeTab") || "stats";
        // Top-level Sheet/Notes view — stored per USER (each player keeps their
        // own last view per actor), defaulting to the sheet. No document write,
        // so switching it never re-renders the sheet for other viewers.
        ctx.sheetView = game.user.getFlag("witcher-ttrpg-death-march", "sheetViews")?.[this.actor.id] || "sheet";

        // Critical wounds — surfaced as their own sheet section so the
        // player can see + treat/resolve them without digging through
        // the items tab. Sorted by severity for triage visibility.
        const severityOrder = { deadly: 0, difficult: 1, complex: 2, simple: 3 };
        ctx.criticalWounds = this.actor.items
            .filter(i => i.type === "criticalWound")
            .sort((a, b) =>
                (severityOrder[a.system.criticalLevel] ?? 9) -
                (severityOrder[b.system.criticalLevel] ?? 9));
        ctx.hasCriticalWounds = ctx.criticalWounds.length > 0;

        // Equipped armor — aggregate SP per hit location with RAW layering
        // (Core p.154-155):
        //   • Max 3 layers per location
        //   • Max 1 heavy + 1 medium (light can stack freely up to the 3 cap)
        //   • Layer bonus by SP diff: 0-4→+5, 5-8→+4, 9-14→+3, 15-20→+2
        // Shields are excluded — they're held, not layered onto a location.
        const armorPieces = this.actor.items.filter(
            i => i.type === "armor" && i.system?.equipped &&
                 i.system?.location !== "Shield" && i.system?.armorType !== "shield"
        );
        const layerBonus = (diff) => {
            if (diff <= 4)  return 5;
            if (diff <= 8)  return 4;
            if (diff <= 14) return 3;
            if (diff <= 20) return 2;
            return 0;
        };
        const armorLocations = [
            { key: "head",     label: "Head" },
            { key: "torso",    label: "Torso" },
            { key: "rightArm", label: "R. Arm" },
            { key: "leftArm",  label: "L. Arm" },
            { key: "rightLeg", label: "R. Leg" },
            { key: "leftLeg",  label: "L. Leg" }
        ];
        const pickLayers = (pieces) => {
            // pieces: [{ name, sp, type }] sorted desc by sp
            // Greedily select up to 3 respecting "max 1 heavy + 1 medium".
            // Lights are unrestricted within the 3-layer cap.
            const out = []; let heavyUsed = false, mediumUsed = false;
            for (const p of pieces) {
                if (out.length >= 3) break;
                if (p.type === "heavy") {
                    if (heavyUsed) continue;
                    heavyUsed = true;
                } else if (p.type === "medium") {
                    if (mediumUsed) continue;
                    mediumUsed = true;
                }
                out.push(p);
            }
            return out;
        };
        ctx.armorByLocation = armorLocations.map(({ key, label }) => {
            const stoppingKey = `${key}Stopping`;
            const candidates = armorPieces
                .map(a => {
                    const eff = a.system?.effective ?? a.system ?? {};
                    return {
                        name: a.name,
                        sp:   Number(a.system?.[stoppingKey]) || 0,
                        type: a.system?.armorType || "light",
                        slashing:    !!eff.slashing,
                        piercing:    !!eff.piercing,
                        bludgeoning: !!eff.bludgeoning
                    };
                })
                .filter(p => p.sp > 0)
                .sort((a, b) => b.sp - a.sp);
            const contributing = pickLayers(candidates);
            let total = 0;
            for (let i = 0; i < contributing.length; i++) {
                if (i === 0) total = contributing[i].sp;
                else total += layerBonus(contributing[i - 1].sp - contributing[i].sp);
            }
            // A location resists a damage type if ANY piece covering it does.
            const resists = [];
            if (candidates.some(p => p.slashing))    resists.push("Slash");
            if (candidates.some(p => p.piercing))    resists.push("Pierce");
            if (candidates.some(p => p.bludgeoning)) resists.push("Bludgeon");
            return {
                key, label, total,
                layers: contributing.length,
                pieces: contributing,
                resists
            };
        });
        ctx.hasArmor = ctx.armorByLocation.some(l => l.total > 0);
        ctx.armorEV  = Number(this.actor.system?.armorEV) || 0;

        // Worn armor only — the Combat tab shows what's currently equipped.
        // Unworn armor lives in the Inventory tab (Armor group) and is worn
        // from there via right-click. Shields are surfaced in the weapons
        // list, so they stay excluded here.
        const armorLocLabels = { head: "Head", torso: "Torso", leftArm: "L.Arm", rightArm: "R.Arm", leftLeg: "L.Leg", rightLeg: "R.Leg" };
        ctx.armorList = this.actor.items
            .filter(i => i.type === "armor" && i.system?.equipped &&
                         i.system?.location !== "Shield" && i.system?.armorType !== "shield")
            .map(a => {
                const coverage = [];
                for (const [loc, lbl] of Object.entries(armorLocLabels)) {
                    const sp = Number(a.system?.[`${loc}Stopping`]) || 0;
                    if (sp > 0) coverage.push({ label: lbl, sp });
                }
                const t = a.system?.armorType || "light";
                // Damage-type resistances — read the post-enhancement
                // `effective` block when present, falling back to the base.
                const eff = a.system?.effective ?? a.system ?? {};
                const resists = [];
                if (eff.slashing)    resists.push("Slash");
                if (eff.piercing)    resists.push("Pierce");
                if (eff.bludgeoning) resists.push("Bludgeon");
                return {
                    id:   a.id,
                    name: a.name,
                    img:  a.img,
                    equipped:  !!a.system?.equipped,
                    typeLabel: t.charAt(0).toUpperCase() + t.slice(1),
                    ev:   Number(a.system?.encumbranceValue) || 0,
                    coverage,
                    resists
                };
            })
            .sort((x, y) => (y.equipped - x.equipped) || x.name.localeCompare(y.name));
        ctx.hasArmorItems = ctx.armorList.length > 0;

        // Active statuses — read actor.statuses (set populated by Foundry
        // when status effects are toggled on the token HUD). For each id,
        // resolve the localized name + icon from CONFIG.statusEffects and
        // pair the RAW description resolved through the clause registry
        // (descriptionFor), which also covers GM-authored custom statuses.
        // Equipable items — weapons + shields (armor with location=Shield)
        // + alchemicals (bombs/potions) the player might tag Quick. Surface
        // each with its current slot so the player can swap from the sheet
        // without opening the items tab. The chrome's preUpdateItem hook
        // enforces the right/left/2H/quick exclusivity rules per the
        // user's spec (see chrome/inventory.js checkEquipConflicts).
        // Slot labels match the WEAPON_HANDS catalog values so the
        // character-sheet equip picker stays in sync with the weapon
        // config Hands dropdown (both write to system.hands). Legacy
        // "both" entries are mapped to the new "two-handed" key.
        // Occupancy labels — keyed by the derived hand-slot a weapon takes
        // (occupancyOf): right/left/quick for one-handed, "both" for two-handed.
        const slotLabels = { right: "Main Hand", left: "Off-hand", both: "Two-Handed", quick: "Quick / Off-hand" };
        const slotShorts = { right: "M", left: "O", both: "2H", quick: "Q" };
        // Combat tab shows the EQUIPPED set only — unequipped weapons/shields
        // live in the Inventory tab and are drawn from there (right-click).
        ctx.equipableItems = this.actor.items
            .filter(i =>
                (i.type === "weapon" && i.system?.equipped) ||
                (i.type === "shield" && i.system?.equipped) ||
                (i.type === "armor" && i.system?.location === "Shield" && i.system?.equipped) ||
                (i.type === "alchemical" && i.system?.equipped)
            )
            .map(i => {
                const oil = readWeaponOil(i);
                const od  = oil ? describeDuration(oil.dur ?? {}) : null;
                const oilTimed = !!od && od.total > 0;
                return {
                id:    i.id,
                name:  i.name,
                img:   i.img,
                type:  i.type,
                oil:        oil ? { name: oil.name, effect: oil.effect } : null,
                oilLabel:   oil ? (oilTimed ? od.label : "∞") : "",
                oilTip:     oil ? (oil.effect ? `${oil.name} — ${oil.effect}` : oil.name) : "",
                equipped: !!i.system?.equipped,
                isWeapon:    i.type === "weapon",
                isShield:    i.type === "shield",
                canSheathe:  true,
                isTwoHanded: (i.type === "weapon" || i.type === "shield") && i.system?.hands === "two",
                // One-handed weapons/shields offer a hand selector (Right/Left,
                // plus Quick if the item is quick-eligible). Two-handed items
                // take both hands, so no choice is offered.
                canSelectHand: (i.type === "weapon" || i.type === "shield") && i.system?.hands !== "two",
                quickEligible: isQuickItem(i),
                isQuick:       (i.type === "weapon" || i.type === "shield") && !!i.system?.quick,
                slot:  i.system?.equipped ? (occupancyOf(i) || "") : "",
                slotLabel: i.system?.equipped ? (slotLabels[occupancyOf(i)] || "Equipped") : "",
                slotShort: i.system?.equipped ? (slotShorts[occupancyOf(i)] || ((i.type === "weapon" || i.type === "shield") ? "H" : "Worn")) : "",
                damage:      i.type === "shield" ? shieldBashDamage(this.actor, i) : i.system?.damage,
                damageType:  Array.isArray(i.system?.damageTypes)
                    ? i.system.damageTypes
                        .map(k => game.i18n.localize(CONFIG.WITCHER.damageTypes[k] ?? k))
                        .join(" · ")
                    : "",
                range:       i.system?.range,
                accuracy:    i.system?.accuracy,
                reliability:    i.system?.reliability?.value ?? i.system?.reliability ?? 0,
                reliabilityMax: i.system?.reliability?.max   ?? i.system?.reliability ?? 0,
                effects:     i.system?.effects
            };
            });
        ctx.hasEquipableItems = ctx.equipableItems.length > 0;

        const statusList = CONFIG.statusEffects ?? [];
        ctx.activeStatuses = [...(this.actor.statuses ?? [])].map(id => {
            const def = statusList.find(s => s.id === id) ?? {};
            // `tier`/`label` are explicit presentation fields on the ranked
            // Aim statuses (Aim 1-3); plain and GM-authored statuses carry
            // neither, so they show no rank badge.
            return {
                id,
                img: def.img ?? "icons/svg/aura.svg",
                label: def.label ?? (def.name ? game.i18n.localize(def.name) : id),
                tier: def.tier ?? null,
                description: descriptionFor(id)
            };
        });
        ctx.hasActiveStatuses = ctx.activeStatuses.length > 0;

        // Per-tab item collections. Profession / race / homeland are
        // single-instance items (first wins) — UI shows their card or an
        // empty hint.
        // toObject() yields SOURCE (has _id, not id); stamp the real id back so
        // the card's data-item-id={{x.id}} edit/delete handlers resolve the item.
        const sourceWithId = (i) => { if (!i) return null; const o = i.toObject(); o.id = i.id; return o; };
        ctx.professionItem = sourceWithId(this.actor.items.find(i => i.type === "profession"));
        ctx.raceItem       = sourceWithId(this.actor.items.find(i => i.type === "race"));
        ctx.homelandItem   = sourceWithId(this.actor.items.find(i => i.type === "homeland"));
        // Perks — misc grants (life events, school bonuses) shown under Race &
        // Homeland. Any number; each carries a transfer:true AE.
        ctx.perkItems      = this.actor.items.filter(i => i.type === "perk").map(sourceWithId);

        // ── MAGIC GROUPS ──
        // The Magic tab groups items by sub-type per the Core Rulebook
        // chapter on magic. Spells split further by `spellForm` (spell /
        // sign / invocation) — set per-item on the spell sheet. Hexes and
        // rituals are their own item types.
        const tagSpell = (i) => {
            const s = i.system ?? {};
            const sta = s.staminaCost ?? 0;
            const range = s.range ? ` · ${s.range}` : "";
            return `${sta} STA${range}`;
        };
        const tagHex = (i) => {
            const s = i.system ?? {};
            const sta = s.staminaCost ?? 0;
            const label = s.danger ? game.i18n.localize(CONFIG.WITCHER?.hex?.danger?.[s.danger] ?? s.danger) : "";
            const sub = label ? ` · ${label} danger` : "";
            return `${sta} STA${sub}`;
        };
        const tagRitual = (i) => {
            const s = i.system ?? {};
            const sta = s.staminaCost ?? 0;
            const diff = s.difficulty != null ? ` · DC ${s.difficulty}` : "";
            return `${sta} STA${diff}`;
        };
        const mapItems = (filterFn, tagFn) => this.actor.items
            .filter(filterFn)
            .map(i => {
                // toObject() returns SOURCE data — it has `_id`, not `id`, so the
                // template's data-item-id={{this.id}} would be empty and every
                // [data-item-id] handler (edit/delete/context-menu/consume) would
                // look up "" and no-op. Stamp the real document id back on.
                const obj = i.toObject();
                obj.id = i.id;
                obj.meta = tagFn(obj);
                return obj;
            })
            .sort((a, b) => a.name.localeCompare(b.name));

        const spells = mapItems(
            i => i.type === "spell" && (i.system?.spellForm ?? "spell") === "spell",
            tagSpell
        );
        const signs = mapItems(
            i => i.type === "spell" && i.system?.spellForm === "sign",
            tagSpell
        );
        const invocations = mapItems(
            i => i.type === "spell" && i.system?.spellForm === "invocation",
            tagSpell
        );
        const hexes   = mapItems(i => i.type === "hex",    tagHex);
        const rituals = mapItems(i => i.type === "ritual", tagRitual);

        // Preserve label-order for the template iterator.
        ctx.magicGroups = [
            { key: "spells",      label: "Spells",      items: spells },
            { key: "signs",       label: "Signs",       items: signs },
            { key: "invocations", label: "Invocations", items: invocations },
            { key: "hexes",       label: "Hexes",       items: hexes },
            { key: "rituals",     label: "Rituals",     items: rituals }
        ];
        ctx.hasMagic = ctx.magicGroups.some(g => g.items.length > 0);

        // ── INVENTORY (GEAR) GROUPS ──
        // Per Witcher TRPG Core Rulebook Chapter 4 (Gear) — everything
        // the character carries that isn't magic / class / lineage. Each
        // group's `meta` field is the at-a-glance secondary info shown
        // beside the name (weight, SP, cost, etc.).
        const tagWeapon  = i => {
            const dmg = i.system?.damage || "";
            const wa  = i.system?.accuracy != null ? `WA ${i.system.accuracy >= 0 ? "+" : ""}${i.system.accuracy}` : "";
            return [dmg, wa].filter(Boolean).join(" · ");
        };
        const tagArmor   = i => {
            const sp = i.system?.stoppingPower ?? i.system?.sp ?? "";
            return sp ? `SP ${sp}` : "";
        };
        const tagAlch    = i => {
            const tox = i.system?.toxicity != null ? `${i.system.toxicity} TOX` : "";
            const sub = i.system?.alchemicalType || "";
            return [sub, tox].filter(Boolean).join(" · ");
        };
        const tagMut     = i => i.system?.tier ? `Tier ${i.system.tier}` : "";
        const tagWeight  = i => {
            const w = i.system?.weight;
            return w != null ? `${w} kg` : "";
        };
        // Food meta: portions (when configured), stack count, weight. Each
        // section is optional so a quantity-1 unportioned food just shows its
        // weight. The stack count is intentionally separate from the portion
        // ticker — the spec was the "stack number" used to be hidden by the
        // portion display; surfacing it next to portions keeps both legible.
        const tagFood = i => {
            const parts = [];
            const max = Number(i.system?.charges?.max) || 0;
            if (max > 0) {
                const cur = Math.max(0, Math.min(max, Number(i.system?.charges?.current) || 0));
                parts.push(`${cur}/${max} portions`);
            }
            const qty = Number(i.system?.quantity) || 1;
            if (qty > 1) parts.push(`×${qty}`);
            const w = i.system?.weight;
            if (w != null && w !== 0) parts.push(`${w} kg`);
            return parts.join(" · ");
        };
        // Inventory-row meta for stowed gear. Weapons advertise their hand
        // trait and Quick eligibility so the player sees how a draw will land
        // before equipping; armor advertises type / shield.
        const tagInvWeapon = i => {
            const dmg   = i.system?.damage || "";
            const hands = i.system?.hands === "two" ? "2H" : "1H";
            const quick = i.system?.quick ? "Quick" : "";
            return [dmg, hands, quick].filter(Boolean).join(" · ");
        };
        const tagInvArmor = i => {
            if (i.system?.location === "Shield" || i.system?.armorType === "shield") return "Shield";
            const t = i.system?.armorType || "light";
            return t.charAt(0).toUpperCase() + t.slice(1);
        };
        // Shields advertise block reliability + hand trait before equipping.
        const tagInvShield = i => {
            const rel   = i.system?.reliability?.value;
            const blocks = rel != null ? `${rel} blk` : "";
            const hands = i.system?.hands === "two" ? "2H" : "1H";
            return [blocks, hands].filter(Boolean).join(" · ");
        };

        const inventoryItems = (filterFn, tagFn) => mapItems(filterFn, tagFn);
        ctx.gearGroups = [
            { key: "weapons",     label: "Weapons",      items: inventoryItems(i => i.type === "weapon" && !i.system?.equipped, tagInvWeapon) },
            { key: "shields",     label: "Shields",      items: inventoryItems(i => i.type === "shield" && !i.system?.equipped, tagInvShield) },
            { key: "armor",       label: "Armor",        items: inventoryItems(i => i.type === "armor"  && !i.system?.equipped, tagInvArmor) },
            { key: "alchemicals", label: "Alchemicals",  items: inventoryItems(i => i.type === "alchemical", tagAlch) },
            { key: "mutagens",    label: "Mutagens",     items: inventoryItems(i => i.type === "mutagen",    tagMut) },
            { key: "components",  label: "Substances",   items: inventoryItems(i => i.type === "component",  tagWeight) },
            { key: "diagrams",    label: "Diagrams",     items: inventoryItems(i => i.type === "diagrams",   tagWeight) },
            { key: "enhancements",label: "Enhancements", items: inventoryItems(i => i.type === "enhancement",tagWeight) },
            { key: "food",        label: "Food & Drink", items: inventoryItems(i => i.type === "food",       tagFood) },
            { key: "dice",        label: "Dice",         items: inventoryItems(i => i.type === "die",        tagWeight) },
            // Remains sort into Valuables alongside generic valuables — they're
            // monster carcasses (own item type) and the inventory tab keeps the
            // same bucket for both. Maps sort into Notes for the same reason.
            { key: "valuables",   label: "Valuables",    items: inventoryItems(i => i.type === "valuable" || i.type === "remains", tagWeight) },
            { key: "notes",       label: "Notes",        items: inventoryItems(i => i.type === "note" || i.type === "map", () => "") }
        ];

        // Nested container view. Containers render as their own section with
        // their contents listed underneath; stored items are pulled OUT of the
        // flat gear groups so each item appears exactly once (in its container).
        const resolveOwned = (uuid) =>
            this.actor.items.find(x => x.uuid === uuid || x.id === uuid) ?? null;
        const rowMeta = (i) => {
            if (i.type === "weapon")     return tagInvWeapon(i);
            if (i.type === "shield")     return tagInvShield(i);
            if (i.type === "armor")      return tagInvArmor(i);
            if (i.type === "alchemical") return tagAlch(i);
            if (i.type === "mutagen")    return tagMut(i);
            return tagWeight(i);
        };
        const storedIds = new Set();
        ctx.containers = this.actor.items
            .filter(i => i.type === "container")
            .map(c => {
                const items = (c.system?.content ?? [])
                    .map(resolveOwned)
                    .filter(Boolean)
                    .map(it => {
                        storedIds.add(it.id);
                        const handItem = it.type === "weapon" || it.type === "shield";
                        // Drawing pulls a hand item (weapon or shield) from its
                        // container — a combat action.
                        const canEquip = handItem;
                        return {
                            id:       it.id,
                            name:     it.name,
                            img:      it.img,
                            type:     it.type,
                            meta:     rowMeta(it),
                            isQuick:  handItem && !!it.system?.quick,
                            equipped: !!it.system?.equipped,
                            canEquip,
                            equipLabel: "Draw",
                            equipIcon:  it.type === "shield" ? "fa-shield" : "fa-hand-fist"
                        };
                    })
                    .sort((a, b) => a.name.localeCompare(b.name));
                const cap = getCapacityDisplay(c);
                const capLabel = cap
                    ? (cap.hasSlots ? `${cap.cur}/${cap.max}` : `${cap.cur}/${cap.max}${cap.label ? ` ${cap.label}` : ""}`)
                    : "";
                return {
                    id: c.id, name: c.name, img: c.img, capLabel, over: !!cap?.over, items,
                    collapsed: this._collapsedContainers?.has(c.id) ?? false
                };
            })
            .sort((a, b) => a.name.localeCompare(b.name));
        ctx.hasContainers = ctx.containers.length > 0;

        // Drop stowed items from the flat groups; mark Quick weapons for the
        // row badge and give hand items (weapons / shields) a visible Equip
        // control. Flat-group items are never inside a container (stowed ones
        // are pulled out above), so this is always a loose → hand Equip, never
        // a from-sheath Draw.
        for (const g of ctx.gearGroups) {
            g.items = g.items.filter(it => !storedIds.has(it.id));
            for (const it of g.items) {
                if (it.type === "weapon" || it.type === "shield") {
                    it.isQuick   = !!it.system?.quick;
                    it.canEquip  = true;
                    it.equipLabel = "Equip";
                    it.equipIcon  = it.type === "shield" ? "fa-shield" : "fa-hand";
                }
            }
        }

        // Active effects — `allApplicableEffects` includes item-transferred
        // ones, which is what the Effects tab wants to show.
        ctx.effects = Array.from(this.actor.allApplicableEffects()).map(e => ({
            id:          e.id,
            name:        e.name,
            img:         e.img,
            disabled:    e.disabled,
            description: e.description ?? "",
            sourceName:  e.parent?.name === this.actor.name ? "" : (e.parent?.name ?? ""),
            // Shared formatter: rounds in combat, wall-clock out — uniform with
            // the dock status badges, oil bar, and inventory overlay.
            duration:    { label: describeDuration(e.duration).label }
        }));

        // Background tab — lifeEvents is a free-form ObjectField shared with
        // the chrome character panel. Each entry stores `{ value, details }`;
        // date + location live on actor flags (the schema has neither). We
        // flatten to an array the template can iterate. Legacy keys that used
        // title/year/detail still resolve via the fallbacks.
        const events = this.actor.system?.general?.lifeEvents ?? {};
        ctx.lifeEventEntries = Object.entries(events).map(([id, val]) => {
            const obj = (val && typeof val === "object") ? val : { value: String(val ?? "") };
            return {
                id,
                label:    obj.value ?? obj.title ?? obj.label ?? "",
                date:     this.actor.getFlag("witcher-ttrpg-death-march", `lifeEventDates.${id}`) ?? "",
                location: this.actor.getFlag("witcher-ttrpg-death-march", `lifeEventLocations.${id}`) ?? "",
                detail:   obj.details ?? obj.detail ?? obj.description ?? ""
            };
        });
        ctx.ipLogEntries = Array.isArray(this.actor.system?.logs?.ipLog)
            ? this.actor.system.logs.ipLog
            : [];

        return ctx;
    }

    /**
     * Clamp number inputs to their declared `min`/`max` on focus-out.
     * HTML's `min`/`max` attributes only constrain the spinner — typed
     * values pass through unmodified, and Foundry's NumberField
     * `_cleanType` behavior on out-of-range values varies across
     * versions. So we enforce client-side: when the user types 99 in a
     * stat input and tabs away, the `change` event fires here first
     * (it's attached to the input element itself, not the form), we
     * clamp the input.value in-place, then Foundry's submitOnChange
     * handler reads the already-clamped value.
     */
    async _onRender(context, options) {
        await super._onRender(context, options);
        const root = this.element;
        if (!root) return;
        root.querySelectorAll('input[type="number"][min][max]').forEach(input => {
            if (input.dataset.clampBound) return;
            input.dataset.clampBound = "1";
            input.addEventListener("change", () => {
                if (input.value === "") return;
                const v = Number(input.value);
                if (!Number.isFinite(v)) {
                    input.value = String(input.min);
                    return;
                }
                const min = Number(input.min);
                const max = Number(input.max);
                if (Number.isFinite(min) && v < min) input.value = String(min);
                else if (Number.isFinite(max) && v > max) input.value = String(max);
            });
        });

        /* Per-weapon hand selector on equipped one-handed weapons. Writing
         * system.slot routes through the chrome's preUpdateItem conflict hook,
         * which validates exclusivity (and the Quick-only-quick-items rule)
         * and cancels with a warning on conflict — the re-render then restores
         * the old selection. No `name` attr, so it never hits form submit. */
        root.querySelectorAll('select[data-hand-select]').forEach(sel => {
            if (sel.dataset.handBound) return;
            sel.dataset.handBound = "1";
            sel.addEventListener("change", async (event) => {
                event.stopPropagation();
                const item = this.actor.items.get(sel.dataset.itemId);
                if (!item) return;
                await item.update({ "system.equipped": true, "system.slot": sel.value });
            });
        });

        /* Folded HP field (only present while temp HP > 0). It shows the
         * blended total (value + temp) and has no `name`, so it never submits
         * directly. Editing it is a damage/heal gesture: a lower number drains
         * the temp shield first (drainHp), a higher number heals real HP only
         * (capped at real max — temp never refills). This restores the "type a
         * new HP number" workflow that the read-only fold removed. */
        root.querySelectorAll('input[data-hp-total]').forEach(input => {
            if (input.dataset.hpTotalBound) return;
            input.dataset.hpTotalBound = "1";
            input.addEventListener("change", async (event) => {
                event.stopPropagation();
                const hp    = this.actor.system?.derivedStats?.hp ?? {};
                const value = Math.max(0, Number(hp.value) || 0);
                const temp  = Math.max(0, Number(hp.temp)  || 0);
                const max   = Math.max(0, Number(hp.max)   || 0);
                const total = value + temp;
                const next  = Number(input.value);
                if (!Number.isFinite(next) || next === total) {
                    input.value = String(total);
                    return;
                }
                if (next < total) {
                    const drained = drainHp(hp, total - next);
                    await this.actor.update({
                        "system.derivedStats.hp.value": drained.value,
                        "system.derivedStats.hp.temp":  drained.temp
                    });
                } else {
                    const healed = Math.min(next - total, Math.max(0, max - value));
                    if (healed > 0) {
                        await this.actor.update({ "system.derivedStats.hp.value": value + healed });
                    } else {
                        input.value = String(total);   // already at real max; nothing to heal
                    }
                }
            });
        });

        /* Right-click item menu. ContextMenu delegates from the persistent root
         * and survives inner part re-renders, so bind once per root element. */
        if (!root.dataset.itemMenuBound) {
            root.dataset.itemMenuBound = "1";
            this.itemContextMenu(root);
        }
    }

    /**
     * Foundry already re-focuses the previously-focused control after a
     * submitOnChange re-render (HandlebarsApplicationMixin._syncPartState), but
     * it does NOT restore the caret — so typing mid-string snaps the cursor to
     * the end ("append only"). Capture the selection here so `_syncPartState`
     * can put it back. Augments the native behavior; does not replace it.
     */
    _preSyncPartState(partId, newElement, priorElement, state) {
        super._preSyncPartState(partId, newElement, priorElement, state);
        const focused = priorElement.querySelector(":focus");
        if (focused && typeof focused.selectionStart === "number") {
            state.witcherCaret = { start: focused.selectionStart, end: focused.selectionEnd };
        }
    }

    _syncPartState(partId, newElement, priorElement, state) {
        super._syncPartState(partId, newElement, priorElement, state);
        const caret = state.witcherCaret;
        if (caret && state.focus) {
            const el = newElement.querySelector(state.focus);
            if (el && typeof el.setSelectionRange === "function") {
                try { el.setSelectionRange(caret.start, caret.end); } catch (_) {}
            }
        }
    }

    /**
     * submitOnChange fires on EVERY field's `change`, and the built-in handler
     * re-renders the whole sheet each time. That re-render replaces the part's
     * DOM — fine for a committed value, but ruinous when the `change` was the
     * blur of the *previous* field as the user reaches for a <select> or the
     * portrait: the element they're now interacting with is swapped out, so the
     * dropdown snaps shut / loses focus and the FilePicker's captured <img>
     * detaches before its path can be read.
     *
     * Only stat / derived / skill fields have computed siblings that need the
     * recompute (modified column, HP-STA bars, totals). For everything else we
     * persist with `{render:false}` — the typed value is already in the DOM, so
     * nothing visible goes stale, and the live control survives untouched.
     */
    _onChangeForm(formConfig, event) {
        const el = event.target;
        // Profession-tree rank inputs sit inside the actor form but edit the
        // embedded profession item, not the actor. They carry data-prof-path
        // and no `name` (so they're absent from actor submit data) — route
        // them straight to the item.
        if (el?.dataset?.profPath) {
            event.preventDefault();
            this._onProfRankChange(el).catch(err => ui.notifications.error(err, { console: true }));
            return;
        }
        const name = el?.name || "";
        if (!formConfig.submitOnChange || !this.rendered || DERIVED_FIELD_RE.test(name)) {
            return super._onChangeForm(formConfig, event);
        }
        event.preventDefault();
        // Mirror _onSubmitForm's error surfacing — submit() runs validate()
        // with fallback:false, which throws on an invalid value.
        this.submit({ render: false }).catch(err => ui.notifications.error(err, { console: true }));
    }

    /**
     * Commit a profession-skill rank edit to the embedded profession item.
     * render:false keeps the typed value and caret in place — the input is
     * the only place this level is shown, so nothing visible goes stale.
     */
    async _onProfRankChange(el) {
        if (!this.isEditable) return;
        const prof = this.actor.items.find(i => i.type === "profession");
        if (!prof) return;
        const lvl = Math.min(10, Math.max(0, Math.round(Number(el.value) || 0)));
        await prof.update({ [el.dataset.profPath]: lvl }, { render: false });
    }

    /**
     * Open Foundry's FilePicker on the portrait and write the chosen path
     * straight to the actor. The built-in editImage action stashes the path on
     * the clicked <img> and waits for a form submit — but a concurrent
     * submitOnChange re-render detaches that <img> first, so the path is lost.
     * Updating the document directly sidesteps the race entirely.
     */
    static async _onEditImage(event, target) {
        if (!this.isEditable) return;
        const field   = target.dataset.edit || "img";
        const current = foundry.utils.getProperty(this.actor, field);
        const FP      = foundry.applications.apps.FilePicker.implementation;
        const fp      = new FP({
            type: "image",
            current,
            callback: path => this.actor.update({ [field]: path }),
            top:  (this.position?.top  ?? 0) + 40,
            left: (this.position?.left ?? 0) + 10
        });
        fp.render(true);
    }

    /**
     * Commit any pending form edit before a mutating action runs. Clicking a
     * button blurs the focused input, whose `change` fires a concurrent
     * submitOnChange update that races the action's own `actor.update` — one
     * clobbers the other (e.g. "Add random" dropping a freshly-typed loot row).
     * Blur to flush the value, then await the submit (no render) so the action
     * reads freshly-saved state.
     */
    async _flushForm() {
        const el = document.activeElement;
        if (el?.tagName && ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName)) el.blur();
        // `render:false` is forwarded to document.update — the submit persists
        // the pending edit but does NOT re-render, so the action that called us
        // can mutate freshly-saved state and render once itself.
        try { await this.submit({ render: false }); }
        catch (_) { /* validation failure already surfaced */ }
    }

    /**
     * Action handler — `data-action="rollSkill" data-skill="<key>"`.
     * Delegates to the actor's mixin method.
     */
    static async _onRollSkill(event, target) {
        const key = target.dataset.skill;
        if (!key) return;
        await this.actor.rollSkill?.(key);
    }

    /**
     * Action handler — `data-action="rollProfSkill" data-prof-slot="<path>"`.
     * Reads the slot live off the profession item (so a just-edited rank is
     * current) and rolls 1d10 + stat + level.
     */
    static async _onRollProfSkill(event, target) {
        const slotPath = target.dataset.profSlot;
        const prof = this.actor.items.find(i => i.type === "profession");
        if (!prof || !slotPath) return;
        const slot = foundry.utils.getProperty(prof.system, slotPath);
        await this.actor.rollProfessionSkill?.(slot);
    }

    /**
     * Roll initiative (Core p.151). `1d10 + REF` (post-AE so debuffs
     * count). Posts to the chat log; doesn't push to a combat tracker
     * automatically — that's a follow-up if the GM wants integration.
     */
    static async _onRollInitiative(event, target) {
        const ref = Number(this.actor.system?.stats?.ref?.value) || 0;
        const roll = await new Roll(`1d10 + ${ref}`).evaluate();
        await roll.toMessage({
            speaker: ChatMessage.getSpeaker({ actor: this.actor }),
            flavor: `<h3>${this.actor.name} — Initiative</h3>`
        });
    }

    /**
     * "Take a Breath" — full-round recovery action (Core p.152).
     * Regains STA equal to REC, capped at sta.max. Player must spend
     * the round on this — the sheet only handles the bookkeeping.
     */
    static async _onTakeBreath(event, target) {
        const sta = this.actor.system?.derivedStats?.sta;
        const rec = Number(this.actor.system?.derivedStats?.rec) || 0;
        if (!sta) return;
        const next = Math.min((Number(sta.value) || 0) + rec, Number(sta.max) || 0);
        await this.actor.update({ "system.derivedStats.sta.value": next });
        ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor: this.actor }),
            content: `<em>${this.actor.name} takes a breath — STA ${sta.value} → ${next}.</em>`
        });
    }

    /**
     * Stabilize a wound (unstabilized → stabilized) — the First Aid roll
     * that stops it killing the victim. Does not start healing.
     */
    static async _onStabilizeWound(event, target) {
        const id = target.dataset.itemId;
        const wound = this.actor.items.get(id);
        if (!wound || wound.type !== "criticalWound") return;
        await wound.system.stabilize();
    }

    /**
     * Treat a wound (→ treated) — the doctor's Healing Hands work. Anchors
     * the natural-healing clock to the current world time.
     */
    static async _onTreatWound(event, target) {
        const id = target.dataset.itemId;
        const wound = this.actor.items.get(id);
        if (!wound || wound.type !== "criticalWound") return;
        await wound.system.treat();
    }

    /**
     * Manually resolve a wound — spawns the follow-up item (if any)
     * and deletes the wound. Use when the GM judges it's done.
     */
    static async _onResolveWound(event, target) {
        const id = target.dataset.itemId;
        const wound = this.actor.items.get(id);
        if (!wound || wound.type !== "criticalWound") return;
        await wound.system.resolve();
    }

    /**
     * Equip toggle. Mirrors the chrome inventory equip flow: a weapon is
     * drawn via `drawWeapon`, which picks the slot from `system.slot`
     * (Right/Left/Quick, default Right, auto-falling back to the free hand),
     * runs the right/left/2H/quick exclusivity check, and warns instead of
     * silently evicting a conflicting weapon. Shields and equipped
     * alchemicals just flip `system.equipped`. Clicking an already-equipped
     * item sheathes it (clears equipped, keeping `slot` so the next draw
     * remembers the preferred hand).
     */
    static async _onToggleEquip(event, target) {
        const id = target.dataset.itemId;
        const item = this.actor.items.get(id);
        if (!item) return;
        if (item.system?.equipped) {
            if (item.type === "weapon" || item.type === "shield") await sheathWeapon(this.actor, item);
            else await this._setEquipped(item, false, "Unequip");
            return;
        }
        if (item.type === "weapon" || item.type === "shield") {
            // A weapon/shield in a container is Drawn (a combat action); a loose
            // one is Equipped — not a combat action, and disallowed mid-combat.
            const inContainer = !!findContainerHoldingItem(this.actor, item.id);
            if (!inContainer && isActorInActiveCombat(this.actor)) {
                ui?.notifications?.warn?.("Can't equip a loose weapon or shield in combat — draw it from a container.");
                return;
            }
            await drawWeapon(this.actor, item);
        } else {
            await this._setEquipped(item, true, "Equip");
        }
    }

    /** Sheathe an equipped weapon or shield into a railed container (costs an
     *  action in combat). Mirrors the war-mode dock's sheathe button. */
    static async _onSheatheWeapon(event, target) {
        const item = this.actor.items.get(target.dataset.itemId);
        if (item?.type !== "weapon" && item?.type !== "shield") return;
        await sheathWeapon(this.actor, item);
    }

    /** Unequip an equipped weapon or shield, leaving it loose in inventory.
     *  Disallowed mid-combat — a drawn weapon can only be sheathed/stowed into
     *  a container or dropped, never set loose in hand. Free out of combat. */
    static async _onUnequipWeapon(event, target) {
        const item = this.actor.items.get(target.dataset.itemId);
        if (item?.type !== "weapon" && item?.type !== "shield") return;
        if (isActorInActiveCombat(this.actor)) {
            ui?.notifications?.warn?.("Can't unequip mid-combat — sheathe it into a container or drop it.");
            return;
        }
        await this._setEquipped(item, false, "Unequip");
    }

    /** Drop an equipped weapon or shield to the world (free — no action cost).
     *  Mirrors the war-mode dock's drop button. */
    static async _onDropWeapon(event, target) {
        const item = this.actor.items.get(target.dataset.itemId);
        if (item?.type === "weapon" || item?.type === "shield") await dropWeaponToWorld(this.actor, item);
    }

    /**
     * Persist the active tab so re-renders triggered by submitOnChange
     * don't kick the user back to the default. Stored as a flag on the
     * actor; `_prepareContext` reads it into `ctx.activeTab`.
     */
    static async _onChangeTab(event, target) {
        const tab = target.dataset.tab;
        if (!tab) return;
        await this.actor.setFlag("witcher-ttrpg-death-march", "activeTab", tab);
    }

    /** Switch the top-level Sheet ⇄ Notes view. Stored per USER (that player's
     *  own last view for this actor), so no document update fires — toggle the
     *  DOM in place to keep the ProseMirror editor mounted and leave other
     *  clients undisturbed. */
    static async _onChangeSheetView(event, target) {
        const view = target.dataset.view;
        if (!view) return;
        await game.user.setFlag("witcher-ttrpg-death-march", `sheetViews.${this.actor.id}`, view);
        const root = this.element?.querySelector(".wcs-sheet");
        if (root) root.dataset.sheetView = view;
        this.element?.querySelectorAll('[data-action="changeSheetView"]').forEach(b =>
            b.classList.toggle("is-active", b.dataset.view === view));
    }

    /** Collapse / expand a container's nested item list. Toggles the DOM class
     *  immediately (no re-render flicker) and records the state so re-renders
     *  honor it. */
    static _onToggleContainer(event, target) {
        const id = target.dataset.containerId;
        if (!id) return;
        const box = target.closest(".wcs-container");
        const collapsed = box?.classList.toggle("is-collapsed");
        if (collapsed) this._collapsedContainers.add(id);
        else this._collapsedContainers.delete(id);
    }

    /**
     * Refill LUCK pool to the LUCK stat (per RAW: pool refills to LUCK
     * at start of each session). Sets `system.stats.luck.value =
     * system.stats.luck.max`.
     */
    static async _onRefillLuck(event, target) {
        const cap = Number(this.actor.system?.stats?.luck?.max) || 0;
        await this.actor.update({ "system.stats.luck.value": cap });
    }

    /* ── Life Events editor (Background tab) ───────────────────────
     * Stored as `system.general.lifeEvents` ObjectField — a free-form
     * map of `{ id → { value, details } }`, with date + location kept on
     * actor flags (`lifeEventDates.{id}` / `lifeEventLocations.{id}`) and
     * the drag-order in `lifeEventOrder`. This is the SAME shape the chrome
     * character panel reads/writes, so events created in either editor
     * round-trip. Add/edit go through a DialogV2 prompt so we don't have to
     * fight Foundry's "every input belongs to the form" submit pipeline for
     * dynamic keys. */
    static _lifeEventDialogContent(entry = {}) {
        const esc = foundry.utils.escapeHTML ?? (s => String(s ?? "")
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"));
        return `
            <div class="wdm-event-form">
              <label class="wdm-event-field"><span>Title</span>
                <input type="text" name="value" value="${esc(entry.value ?? "")}" placeholder="A moment that mattered" />
              </label>
              <label class="wdm-event-field"><span>Date</span>
                <input type="date" name="date" value="${esc(entry.date ?? "")}" />
              </label>
              <label class="wdm-event-field"><span>Location</span>
                <input type="text" name="location" value="${esc(entry.location ?? "")}" placeholder="Where it happened" />
              </label>
              <label class="wdm-event-field"><span>Detail</span>
                <textarea name="details" placeholder="What happened, who was there, why it sticks">${esc(entry.details ?? "")}</textarea>
              </label>
            </div>`;
    }
    static _readLifeEventForm(button) {
        const form = button.form;
        return {
            value:    form.elements.value?.value?.trim()    ?? "",
            date:     form.elements.date?.value?.trim()     ?? "",
            location: form.elements.location?.value?.trim() ?? "",
            details:  form.elements.details?.value?.trim()  ?? ""
        };
    }
    /* Persist a life event's value/details to the schema and its
     * date/location to flags (clearing a flag rather than storing "" so we
     * don't leave phantom sub-keys behind). Mirrors the chrome commit path. */
    async _writeLifeEvent(id, result) {
        await this.actor.update({
            [`system.general.lifeEvents.${id}`]: { value: result.value, details: result.details }
        });
        if (result.date) await this.actor.setFlag("witcher-ttrpg-death-march", `lifeEventDates.${id}`, result.date);
        else await this.actor.unsetFlag("witcher-ttrpg-death-march", `lifeEventDates.${id}`);
        if (result.location) await this.actor.setFlag("witcher-ttrpg-death-march", `lifeEventLocations.${id}`, result.location);
        else await this.actor.unsetFlag("witcher-ttrpg-death-march", `lifeEventLocations.${id}`);
    }
    static async _onAddLifeEvent(event, target) {
        const result = await foundry.applications.api.DialogV2.prompt({
            window: { title: "New Life Event" },
            content: WitcherActorSheet._lifeEventDialogContent(),
            ok: { label: "Add", callback: (event, button) => WitcherActorSheet._readLifeEventForm(button) }
        });
        if (!result || (!result.value && !result.details)) return;
        const id = `evt-${foundry.utils.randomID(8)}`;
        await this._writeLifeEvent(id, result);
    }
    static async _onEditLifeEvent(event, target) {
        const id = target.closest("[data-event-id]")?.dataset.eventId;
        if (!id) return;
        const events = this.actor.system?.general?.lifeEvents ?? {};
        const entry = events[id];
        if (!entry) return;
        const populated = {
            value:    entry.value ?? entry.title ?? entry.label ?? "",
            details:  entry.details ?? entry.detail ?? entry.description ?? "",
            date:     this.actor.getFlag("witcher-ttrpg-death-march", `lifeEventDates.${id}`) ?? "",
            location: this.actor.getFlag("witcher-ttrpg-death-march", `lifeEventLocations.${id}`) ?? ""
        };
        const result = await foundry.applications.api.DialogV2.prompt({
            window: { title: "Edit Life Event" },
            content: WitcherActorSheet._lifeEventDialogContent(populated),
            ok: { label: "Save", callback: (event, button) => WitcherActorSheet._readLifeEventForm(button) }
        });
        if (!result) return;
        await this._writeLifeEvent(id, result);
    }
    static async _onDeleteLifeEvent(event, target) {
        const id = target.closest("[data-event-id]")?.dataset.eventId;
        if (!id) return;
        const ok = await foundry.applications.api.DialogV2.confirm({
            window: { title: "Delete Life Event" },
            content: "<p>Remove this life event?</p>"
        });
        if (!ok) return;
        await this.actor.update({ [`system.general.lifeEvents.-=${id}`]: null });
        /* Scrub the sibling flags + drag-order entry so a re-added key with
         * the same id can't inherit stale date/location/position. */
        await this.actor.unsetFlag("witcher-ttrpg-death-march", `lifeEventDates.${id}`);
        await this.actor.unsetFlag("witcher-ttrpg-death-march", `lifeEventLocations.${id}`);
        const order = this.actor.getFlag("witcher-ttrpg-death-march", "lifeEventOrder");
        if (Array.isArray(order) && order.includes(id)) {
            await this.actor.setFlag("witcher-ttrpg-death-march", "lifeEventOrder", order.filter(k => k !== id));
        }
    }

    /**
     * Generic +/- adjuster. The triggering element carries:
     *   data-target = "system.foo.bar"   (the field path)
     *   data-delta  = "1" | "-1" | etc.  (additive)
     *   data-min    = optional integer floor (default 0)
     *   data-max    = optional integer ceiling
     * Reads the CURRENT prepared value, adds delta, clamps, writes back
     * to source via document.update. Used by Adrenaline / pool steppers
     * so the bookkeeping isn't a "type a new number and tab away" chore.
     */
    static async _onAdjustValue(event, target) {
        const path = target.dataset.target;
        const delta = Number(target.dataset.delta);
        if (!path || !Number.isFinite(delta)) return;
        const current = Number(foundry.utils.getProperty(this.actor.system, path.replace(/^system\./, ""))) || 0;
        let next = current + delta;
        const lo = target.dataset.min !== undefined ? Number(target.dataset.min) : 0;
        const hi = target.dataset.max !== undefined ? Number(target.dataset.max) : Number.POSITIVE_INFINITY;
        if (Number.isFinite(lo)) next = Math.max(lo, next);
        if (Number.isFinite(hi)) next = Math.min(hi, next);
        await this.actor.update({ [path]: next });
    }

    /**
     * Cycle a skill's category. "profession" (P) is set automatically when a
     * profession is dropped (its granted-skill package) and is LOCKED — the
     * player can't hand-set or clear it here. Manual clicks only toggle the
     * "pickup" (Pu) marker: "" ↔ "pickup". Both feed the cost-×2 rule (p.59).
     */
    static async _onCycleSkillCategory(event, target) {
        const stat  = target.dataset.stat;
        const skill = target.dataset.skill;
        if (!stat || !skill) return;
        if (!this.actor.system?.skills?.[stat]?.[skill]) return;
        const current = this.actor.system.skills[stat][skill].category || "";
        // Profession skills are profession-controlled — locked WHILE a profession
        // backs them. With no profession on the actor, the mark is stale; allow a
        // click to clear it back to normal.
        if (current === "profession") {
            const hasProfession = this.actor.items?.some?.(i => i.type === "profession");
            if (hasProfession) {
                ui.notifications?.info?.("Profession skill — granted by your profession.");
                return;
            }
            await this.actor.update({ [`system.skills.${stat}.${skill}.category`]: "" });
            return;
        }
        const next = current === "pickup" ? "" : "pickup";
        await this.actor.update({
            [`system.skills.${stat}.${skill}.category`]: next
        });
    }

    /**
     * Roll an attack with a weapon (Core p.163):
     *   Melee:   1d10 + REF + Melee/Sword/etc. + WA + modifiers
     *   Ranged:  1d10 + DEX + Archery/Crossbow + WA + range mod
     *   Thrown:  1d10 + DEX + Athletics/etc.   + WA + range mod
     *
     * Stat is chosen from the weapon's skillKey → SKILL_MAP statKey, with
     * a sensible fallback by weaponType when skillKey is blank.
     *
     * Damage line shows the weapon's damage formula; if the weapon is
     * melee or thrown AND `appliesMeleeBonus` is on, the actor's
     * derivedStats.meleeBonus (Core p.48) is appended to the damage.
     */
    static async _onRollWeapon(event, target) {
        const id = target.dataset.itemId;
        const weapon = this.actor.items.get(id);
        if (!weapon || (weapon.type !== "weapon" && weapon.type !== "shield")) return;
        return this.actor.weaponAttack?.(weapon);
    }

    /* ── Item edit / delete (Magic, Profession, Race tabs) ────────── */
    static async _onEditItem(event, target) {
        const id = target.closest("[data-item-id]")?.dataset.itemId;
        const item = this.actor.items.get(id);
        item?.sheet?.render(true);
    }
    /** Create a blank Perk on the actor and open it in config mode to fill in. */
    static async _onCreatePerk(event, target) {
        if (!this.isEditable) return;
        const [perk] = await this.actor.createEmbeddedDocuments("Item", [{
            name: "New Perk", type: "perk", img: "icons/sundries/scrolls/scroll-bound-sealed-red.webp"
        }]);
        perk?.sheet?.render(true);
    }
    static async _onDeleteItem(event, target) {
        const id = target.closest("[data-item-id]")?.dataset.itemId;
        const item = this.actor.items.get(id);
        if (!item) return;
        const ok = await foundry.applications.api.DialogV2.confirm({
            window: { title: "Delete Item" },
            content: `<p>Remove <strong>${item.name}</strong> from this actor?</p>`
        });
        if (ok) await item.delete();
    }

    /* ── Right-click item context menu ─────────────────────────────────────
     * Native menu over any [data-item-id] row. The bundled chrome layer may
     * REPLACE this.itemContextMenu (prototype) with a shimmed version that
     * folds in extra entries (remains/book actions); it reuses editItem() /
     * deleteItem() below as its base entries and pushes Consume as an extra.
     * The body here is the no-chrome fallback and includes Consume directly. */
    itemContextMenu(html) {
        const root = html instanceof HTMLElement ? html : (html?.[0] ?? html);
        if (!root) return;
        const entries = [
            this.editItem(),
            ...this.equipMenuEntries(),
            this.deleteItem(),
            buildConsumeEntry(this)
        ].filter(Boolean);
        // fixed:true renders the menu in a <body>-level layer. Without it the
        // <nav> is injected inside the right-clicked row, where later sibling
        // rows paint over it and it reads as "no menu appeared".
        new foundry.applications.ux.ContextMenu(root, "[data-item-id]", entries, { jQuery: false, fixed: true });
    }

    /* Equip / draw / stow entries for the right-click menu. Mirror the chrome
     * UI: a weapon IN a container is Drawn (a combat action — pick a hand);
     * a LOOSE weapon (not in a container) is Equipped instead, which is not a
     * combat action and is blocked while the actor is in active combat. Both
     * paths run the same conflict check via drawWeapon. Armor/shields/
     * alchemicals flip equipped; stowing reuses the chrome container helpers. */
    equipMenuEntries() {
        const get = (el) => this.actor?.items?.get(el?.dataset?.itemId);
        // Legacy armor-modeled shield (old stack). The new `shield` item type is
        // a hand item — it routes through the weapon Draw/Equip entries below.
        const isShield = (i) => i?.type === "armor" &&
            (i.system?.location === "Shield" || i.system?.armorType === "shield");
        const handItem = (i) => i?.type === "weapon" || i?.type === "shield";
        const isEquippable = (i) => i && (handItem(i) || i.type === "armor" || i.type === "alchemical");
        const looseWeapon = (i) => handItem(i) && !i.system?.equipped && !findContainerHoldingItem(this.actor, i.id);
        const containerWeapon = (i) => handItem(i) && !i.system?.equipped && !!findContainerHoldingItem(this.actor, i.id);
        const oneHand = (i) => i?.system?.hands !== "two";
        const inCombat = () => isActorInActiveCombat(this.actor);
        // Draw pulls from a container (combat action); Equip stows a loose weapon (no action, out of combat only).
        const toHand = (hand, opts) => async (el) => {
            const item = get(el);
            if (!handItem(item)) return;
            if (hand && item.system?.slot !== hand) await item.update({ "system.slot": hand });
            await drawWeapon(this.actor, item, opts);
        };
        return [
            { name: "Draw — Main Hand", icon: '<i class="fa-solid fa-hand-fist"></i>',
              condition: (el) => { const i = get(el); return containerWeapon(i) && oneHand(i); }, callback: toHand("right") },
            { name: "Draw — Off-hand", icon: '<i class="fa-solid fa-hand-fist"></i>',
              condition: (el) => { const i = get(el); return containerWeapon(i) && oneHand(i); }, callback: toHand("left") },
            { name: "Draw — Quick / Off-hand", icon: '<i class="fa-solid fa-bolt"></i>',
              condition: (el) => { const i = get(el); return containerWeapon(i) && oneHand(i) && isQuickItem(i); }, callback: toHand("quick") },
            { name: "Draw — Wield", icon: '<i class="fa-solid fa-hand-fist"></i>',
              condition: (el) => { const i = get(el); return containerWeapon(i) && !oneHand(i); }, callback: toHand(null) },
            { name: "Equip — Main Hand", icon: '<i class="fa-solid fa-hand"></i>',
              condition: (el) => { const i = get(el); return looseWeapon(i) && oneHand(i) && !inCombat(); }, callback: toHand("right", { spendAction: false }) },
            { name: "Equip — Off-hand", icon: '<i class="fa-solid fa-hand"></i>',
              condition: (el) => { const i = get(el); return looseWeapon(i) && oneHand(i) && !inCombat(); }, callback: toHand("left", { spendAction: false }) },
            { name: "Equip — Quick / Off-hand", icon: '<i class="fa-solid fa-bolt"></i>',
              condition: (el) => { const i = get(el); return looseWeapon(i) && oneHand(i) && isQuickItem(i) && !inCombat(); }, callback: toHand("quick", { spendAction: false }) },
            { name: "Equip — Wield", icon: '<i class="fa-solid fa-hand"></i>',
              condition: (el) => { const i = get(el); return looseWeapon(i) && !oneHand(i) && !inCombat(); }, callback: toHand(null, { spendAction: false }) },
            { name: "Equip", icon: '<i class="fa-solid fa-shield-halved"></i>',
              condition: (el) => { const i = get(el); return !i?.system?.equipped && (isShield(i) || i?.type === "alchemical"); },
              callback: (el) => this._setEquipped(get(el), true, "Equip") },
            { name: "Wear", icon: '<i class="fa-solid fa-shirt"></i>',
              condition: (el) => { const i = get(el); return i?.type === "armor" && !isShield(i) && !i.system?.equipped; },
              callback: (el) => this._setEquipped(get(el), true, "Wear") },
            { name: "Sheathe / Unequip", icon: '<i class="fa-solid fa-box-archive"></i>',
              condition: (el) => { const i = get(el); return isEquippable(i) && !!i.system?.equipped; },
              callback: async (el) => {
                  const i = get(el);
                  if (!i) return;
                  if (handItem(i)) await sheathWeapon(this.actor, i);
                  else await this._setEquipped(i, false, "Unequip");
              } },
            { name: "Put in Container…", icon: '<i class="fa-solid fa-box"></i>',
              condition: (el) => {
                  const i = get(el);
                  if (!i || i.system?.equipped || !STORABLE_TYPES.has(i.type)) return false;
                  return this.actor.items.some(c => c.type === "container" && c.id !== i.id);
              },
              callback: (el) => this._promptPutInContainer(get(el)) },
            { name: "Take Out of Container", icon: '<i class="fa-solid fa-box-open"></i>',
              condition: (el) => { const i = get(el); return !!i?.system?.isStored && !!findContainerHoldingItem(this.actor, i.id); },
              callback: async (el) => {
                  const i = get(el);
                  const cid = findContainerHoldingItem(this.actor, i.id);
                  if (cid) await removeItemFromSource(this.actor, i, `container:${cid}`, { spendAction: true });
              } }
        ];
    }

    /* Flip an item's equipped flag — wearing/removing armour, equipping a shield
     * or alchemical. In combat this is an action: refuse (no change) when no slot
     * is left, otherwise charge one. Out of combat it's free. */
    async _setEquipped(item, equipped, verb) {
        if (!item) return;
        if (!canSpendCombatAction(this.actor)) return;
        await item.update({ "system.equipped": equipped });
        await chargeCombatAction(this.actor, `${verb}: ${item.name}`);
    }

    /* DialogV2 picker → stow an item into one of the actor's containers via the
     * chrome moveItemToContainer (which enforces capacity). */
    async _promptPutInContainer(item) {
        if (!item) return;
        const containers = this.actor.items.filter(c => c.type === "container" && c.id !== item.id);
        if (!containers.length) return;
        const esc = foundry.utils.escapeHTML ?? (s => String(s ?? ""));
        const options = containers.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
        const containerId = await foundry.applications.api.DialogV2.prompt({
            window: { title: `Stow ${item.name}` },
            content: `<div class="wdm-event-form"><label class="wdm-event-field"><span>Container</span><select name="container">${options}</select></label></div>`,
            ok: { label: "Stow", callback: (_event, button) => button.form.elements.container?.value }
        }).catch(() => null);
        if (!containerId) return;
        const srcId = findContainerHoldingItem(this.actor, item.id);
        await moveItemToContainer(this.actor, item.id, containerId, srcId ? `container:${srcId}` : "grid", { spendAction: true });
    }

    editItem() {
        return {
            name: "View",
            icon: '<i class="fa-solid fa-eye"></i>',
            condition: (el) => !!this.actor?.items?.get(el?.dataset?.itemId),
            callback:  (el) => this.actor?.items?.get(el?.dataset?.itemId)?.sheet?.render(true)
        };
    }

    deleteItem() {
        return {
            name: "Delete",
            icon: '<i class="fa-solid fa-trash"></i>',
            condition: (el) => !!this.actor?.items?.get(el?.dataset?.itemId),
            callback:  async (el) => {
                const item = this.actor?.items?.get(el?.dataset?.itemId);
                if (!item) return;
                const ok = await foundry.applications.api.DialogV2.confirm({
                    window: { title: "Delete Item" },
                    content: `<p>Remove <strong>${item.name}</strong> from this actor?</p>`
                });
                if (ok) await item.delete();
            }
        };
    }

    /* ── ActiveEffect tab handlers ─────────────────────────────────── */
    static async _onCreateEffect(event, target) {
        const [effect] = await this.actor.createEmbeddedDocuments("ActiveEffect", [{
            name: "New Effect",
            img:  "icons/svg/aura.svg",
            disabled: false
        }]);
        effect?.sheet?.render(true);
    }
    static async _onEditEffect(event, target) {
        const id = target.closest("[data-effect-id]")?.dataset.effectId;
        const effect = this.actor.effects.get(id);
        effect?.sheet?.render(true);
    }
    static async _onDeleteEffect(event, target) {
        const id = target.closest("[data-effect-id]")?.dataset.effectId;
        const effect = this.actor.effects.get(id);
        if (!effect) return;
        const ok = await foundry.applications.api.DialogV2.confirm({
            window: { title: "Delete Effect" },
            content: `<p>Remove <strong>${effect.name}</strong>?</p>`
        });
        if (ok) await effect.delete();
    }
    static async _onToggleEffect(event, target) {
        const id = target.closest("[data-effect-id]")?.dataset.effectId;
        const effect = this.actor.effects.get(id);
        await effect?.update({ disabled: !effect.disabled });
    }
}

/* Effect-duration labels flip wall-clock⇄rounds on combat edges and tick down
 * as time passes (describeDuration keys off game.combat.started + remaining
 * time). Foundry only re-renders an actor sheet on document updates, so an open
 * sheet wouldn't refresh on those edges by itself — re-render any open Witcher
 * actor sheet on the same triggers the dock and inventory already use, so the
 * Effects tab timer stays uniform with them. */
let _sheetRefreshHooksInstalled = false;
function installSheetRefreshHooks() {
    if (_sheetRefreshHooksInstalled) return;
    _sheetRefreshHooksInstalled = true;
    const refresh = () => {
        // The world clock advances in real time (mechanics/time-flow.mjs),
        // firing updateWorldTime ~once a second. Re-rendering a sheet the user
        // is mid-edit on would wipe the uncommitted keystroke or snap an open
        // <select> shut, so skip any sheet that currently holds focus.
        const active = document.activeElement;
        for (const app of foundry.applications.instances.values()) {
            if (!(app instanceof WitcherActorSheet) || !app.rendered) continue;
            if (active && active !== document.body && app.element?.contains(active)) continue;
            app.render(false);
        }
    };
    for (const h of ["createCombat", "deleteCombat", "updateCombat",
                     "combatStart", "combatTurn", "combatRound", "updateWorldTime"]) {
        Hooks.on(h, refresh);
    }
}
installSheetRefreshHooks();
