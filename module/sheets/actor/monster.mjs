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
import { buildMonsterVirtualWeapon, monsterAttackHasStamina, chargeMonsterAttackStamina } from "../../combat/monsterVirtualWeapon.mjs";

import { t, tFormat } from "../../chrome/lib/i18n.js";
import { isCESubsystemEnabled } from "../../api/homebrew.mjs";
import { openRaiseShieldDialog } from "../../applications/raiseShieldDialog.mjs";
import { isActorInActiveCombat } from "../../chrome/lib/actor.js";
import { beginWeaponTargeting, isTileTargetingEnabled } from "../../policy/weapon-target-overlay.mjs";
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
    "combat.spells",
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
            castMonsterSpell:    WitcherMonsterSheet._onCastMonsterSpell,
            deleteMonsterSpell:  WitcherMonsterSheet._onDeleteMonsterSpell,
            openLootItem:        WitcherMonsterSheet._onOpenLootItem,
            addRandomLoot:       WitcherMonsterSheet._onAddRandomLoot,
            removePoolItem:      WitcherMonsterSheet._onRemovePoolItem,
            toggleRandomPool:    WitcherMonsterSheet._onToggleRandomPool,
            clearMutagen:        WitcherMonsterSheet._onClearMutagen,
            removeSkill:         WitcherMonsterSheet._onRemoveSkill,
            removeAttackQuality: WitcherMonsterSheet._onRemoveAttackQuality,
            removeWeaponQuality: WitcherMonsterSheet._onRemoveWeaponQuality,
            configRemainsIcon:   WitcherMonsterSheet._onConfigRemainsIcon,
            openMonsterShield:   WitcherMonsterSheet._onOpenMonsterShield,
            deleteMonsterShield: WitcherMonsterSheet._onDeleteMonsterShield,
            raiseMonsterShield:  WitcherMonsterSheet._onRaiseMonsterShield
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

        /* Optional novel-rule weapon weakness (Core p.175). Independent of
         * the per-type damage profile below — they stack multiplicatively:
         * a Slashing-resistant + Silver-vulnerable monster takes 1/4 from
         * a non-silver slashing hit (typed DR halves, then non-silver
         * halves) and 1/2 from a silver slashing hit (typed DR halves;
         * silver bypasses the non-silver stage). */
        const WEAKNESS_LABELS = {
            none:      "None",
            silver:    "Half from non-silver (RAW Core p.162 / novel)",
            meteorite: "Half from non-meteorite (novel rule p.175)"
        };
        ctx.weaponWeaknessOptions = Object.entries(WEAKNESS_LABELS).map(([value, label]) => ({
            value, label, selected: (sys.combat?.weaponWeakness ?? "none") === value
        }));

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
            const reactKey = {
                none:      t("WITCHER.Sheet.Actor.Monster.Reaction.None",      "None"),
                resistant: t("WITCHER.Sheet.Actor.Monster.Reaction.Resistant", "Resistant"),
                immune:    t("WITCHER.Sheet.Actor.Monster.Reaction.Immune",    "Immune")
            }[state];
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

        /* Damage-type checkboxes per attack — read DAMAGE_TYPES from
         * config and mark which ones the attack carries. Lets per-type
         * target reactions (resistant/vulnerable/immune) apply correctly
         * to monster attacks (previously they rolled as typeless). */
        const dmgTypeDefs = CONFIG.WITCHER?.damageTypes ?? {};
        const dmgTypeKeys = Object.keys(dmgTypeDefs);
        ctx.attacks = (sys.combat?.attacks ?? []).map((row, i) => {
            const selectedTypes = new Set(Array.isArray(row.damageTypes) ? row.damageTypes : []);
            return {
                ...row,
                index: i,
                qualities: formatQualityList(row.qualities, row.qualityValues, qCatalog),
                addableQualities: addableQualities(row.qualities, qCatalog),
                /* Weapon-skill picker for the SKILL-derived to-hit model (the UI
                 * default). Marks the row's chosen skill selected; the template
                 * shows it (+ the WA field) when the attack isn't in flat mode. */
                skillOptions: skillOptions.map(o => ({ ...o, selected: (row.skill || "melee") === o.value })),
                damageTypeOptions: dmgTypeKeys.map(key => ({
                    key,
                    label:    game.i18n.localize(dmgTypeDefs[key] ?? key),
                    checked:  selectedTypes.has(key)
                }))
            };
        });
        ctx.abilities = idx(sys.combat?.specialAbilities);
        ctx.vulns = idx(sys.combat?.vulnerabilities);
        /* Embedded castables — spell/hex/ritual items dragged onto the
         * monster (via _onDropItem). Rendered as cards on the sheet
         * with the same schema fields that character-side spell cards
         * consume (staminaCost, castingTime, range, duration, defense,
         * school, effect). Cast fires via `_onCastMonsterSpell`, which
         * hands off to the shared actor.castSpell pipeline. */
        const SPELL_KIND_LABELS = {
            spell:  t("WITCHER.Sheet.Actor.Monster.SpellKind.Spell",  "Spell"),
            hex:    t("WITCHER.Sheet.Actor.Monster.SpellKind.Hex",    "Hex"),
            ritual: t("WITCHER.Sheet.Actor.Monster.SpellKind.Ritual", "Ritual")
        };
        ctx.spellItems = this.actor.items
            .filter(i => i.type === "spell" || i.type === "hex" || i.type === "ritual")
            .map(sp => {
                const s = sp.system ?? {};
                const kindLabel = SPELL_KIND_LABELS[sp.type] ?? sp.type;
                const staCost = s.staminaCost ?? 0;
                const range   = String(s.range ?? "").trim();
                const durUnit = s.duration?.unit ?? "instant";
                const durVal  = String(s.duration?.value ?? "").trim();
                const hasDur  = durVal && durVal !== "0";
                const durLabel = (durUnit === "instant" || durUnit === "permanent" || !hasDur) ? durUnit : `${durVal} ${durUnit}`;
                const school  = String(s.school ?? "").trim();
                const defs    = Array.isArray(s.defense) ? s.defense : (s.defense ? [s.defense] : []);
                const defense = defs.length ? defs.join(" or ") : "None";
                /* Body text: effect first (mechanical); fall back to
                 * description for legacy content, and to lift-requirement
                 * for hexes. Strip HTML for the compact card summary. */
                const rawBody =
                    (sp.type === "hex" ? s.liftRequirement : s.effect)
                    || s.effect || s.description || "";
                const div = document.createElement("div");
                div.innerHTML = String(rawBody);
                const body = (div.textContent || "").trim() || "—";
                return {
                    id:        sp.id,
                    name:      sp.name,
                    img:       sp.img,
                    kind:      sp.type,
                    kindLabel,
                    staCost,
                    castingTime: s.castingTime ?? "",
                    range,
                    durLabel,
                    school,
                    defense,
                    body
                };
            });
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
        // each retaining (and editable for) its own qualities. ROF is a
        // per-monster override stored as a flag on the item; default 1.
        // For ranged weapons (bow / crossbow), also list every ammo item on
        // the monster whose ammoType matches this weapon's, so the GM sees
        // what's actually loadable and can drop more in beside it.
        const ammoOnActor = this.actor.items.filter(i => i.type === "ammo");
        ctx.weaponItems = this.actor.items.filter(i => i.type === "weapon").map(w => {
            const usesAmmo = !!w.usesAmmo;
            const want = usesAmmo ? (w.system?.ammoType || "arrow") : "";
            const ammo = usesAmmo
                ? ammoOnActor
                    .filter(a => (a.system?.ammoType || "arrow") === want)
                    .map(a => ({
                        id: a.id,
                        name: a.name,
                        img: a.img,
                        qty: Number(a.system?.quantity) || 0
                    }))
                : [];
            return {
                id: w.id,
                name: w.name,
                img: w.img,
                damage: w.system?.damage,
                rof: Math.max(1, Number(w.getFlag?.("witcher-ttrpg-death-march", "monsterRof")) || 1),
                /* Per-monster STA cost flag on the weapon item — same
                 * per-item store as monsterRof so the same weapon on two
                 * different monsters can carry different costs. Default 0
                 * (free); values > 0 gate + drain STA on invocation. */
                monsterStaminaCost: Math.max(0, Number(w.getFlag?.("witcher-ttrpg-death-march", "monsterStaminaCost")) || 0),
                usesAmmo,
                ammoType: want,
                ammo,
                qualities: formatQualityList(w.system?.qualities, w.system?.qualityValues, qCatalog),
                addableQualities: addableQualities(w.system?.qualities, qCatalog)
            };
        });

        // Embedded shield items — a humanoid monster can wield a shield the
        // same way it wields a weapon. Equipping is a simple flag flip (no hand
        // slots / rails on the monster model); once equipped it feeds the block
        // + shield-bash flows exactly like a character's shield (defenseMixin /
        // dock filter on `type === "shield" && equipped`).
        // Combat Extended — Raise Shield is available on the monster sheet the
        // same as the dock, once the raiseShield subsystem is on.
        ctx.ceRaiseShield = isCESubsystemEnabled("raiseShield");
        const raisedShieldId = this.actor.system?.guard?.shieldRaised?.itemId ?? "";
        ctx.shieldItems = this.actor.items.filter(i => i.type === "shield").map(s => ({
            id: s.id,
            name: s.name,
            img: s.img,
            equipped: !!s.system?.equipped,
            reliability: Number(s.system?.reliability?.value) || 0,
            reliabilityMax: Number(s.system?.reliability?.max) || 0,
            coverValue: Number(s.system?.coverValue) || 0,
            raised: raisedShieldId === s.id,
            qualities: formatQualityList(s.system?.qualities, s.system?.qualityValues, qCatalog)
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
            if (s.isCarried === false) continue;
            /* Stored items are aggregated by their container's calcWeight
               (see data/item/container.mjs). Skipping them here + routing
               everything else through calcWeight() means containers carry
               their contents into the total instead of vanishing. */
            if (s.isStored === true) continue;
            const w = typeof s.calcWeight === "function"
                ? Number(s.calcWeight()) || 0
                : (Number(s.quantity) || 0) * (Number(s.weight) || 0);
            totalWeight += w;
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
        /* Refuse when already in the active combat — this button rolls an actor
         * INTO combat; re-clicking it on a combatant re-rolls/re-adds their slot
         * and reshuffles the order mid-fight. Re-rolls belong to the tracker. */
        if (game.combat?.combatants?.some(c => c.actorId === actor.id)) {
            ui.notifications.warn(t("WITCHER.Notify.Combat.AlreadyInCombat", "This actor is already in combat — use the combat tracker to re-roll."));
            return;
        }
        try {
            let combat = game.combat;
            if (!combat) {
                combat = await CONFIG.Combat.documentClass.create(
                    { scene: canvas?.scene?.id ?? null, active: true });
            }
            if (!combat) {
                ui.notifications.error(t("WITCHER.Notify.Combat.NoEncounter", "Could not create or find a combat encounter."));
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
            ui.notifications.error(t("WITCHER.Notify.Combat.InitiativeFailed", "Failed to roll initiative into combat — see console."));
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
        /* ROF input on each dragged-in weapon card. Writes the value into a
         * per-item flag (`flags.<sys>.monsterRof`) — this monster's ROF, not
         * the weapon's global stat, so the same shortsword worn by two
         * different monsters can fire at different rates. */
        root.querySelectorAll("input[data-monster-weapon-rof]").forEach(input => {
            if (input.dataset.rofBound) return;
            input.dataset.rofBound = "1";
            input.addEventListener("change", async (event) => {
                event.stopPropagation();
                const id = input.dataset.itemId;
                const item = this.actor.items.get(id);
                if (!item) return;
                const n = Math.max(1, parseInt(input.value, 10) || 1);
                input.value = String(n);
                try { await item.setFlag("witcher-ttrpg-death-march", "monsterRof", n); }
                catch (err) { console.warn("witcher-ttrpg-death-march | monsterRof set failed", err); }
            });
        });
        /* STA input on each dragged-in weapon card. Same per-item flag
         * pattern as monsterRof — enforced by the dock's monster weapon
         * button click handler (reads flag, refuses swing if insufficient,
         * drains on successful commit). Default 0 = free. */
        root.querySelectorAll("input[data-monster-weapon-sta]").forEach(input => {
            if (input.dataset.staBound) return;
            input.dataset.staBound = "1";
            input.addEventListener("change", async (event) => {
                event.stopPropagation();
                const id = input.dataset.itemId;
                const item = this.actor.items.get(id);
                if (!item) return;
                const n = Math.max(0, parseInt(input.value, 10) || 0);
                input.value = String(n);
                try { await item.setFlag("witcher-ttrpg-death-march", "monsterStaminaCost", n); }
                catch (err) { console.warn("witcher-ttrpg-death-march | monsterStaminaCost set failed", err); }
            });
        });
        /* Knowledge-tier lore boxes auto-grow to fit their text. Dragging the
         * old resize handle only set an inline height that this AppV2
         * re-render (fired on any blur/change) wiped — so a resize "reset".
         * Auto-sizing removes the need to resize and always shows the full
         * text. CSS `field-sizing: content` does this natively in Chromium;
         * this is the cross-browser fallback and the initial fit. */
        const autoGrowKnowledge = (ta) => {
            if (!ta || ta.offsetParent === null) return;   // hidden tab → scrollHeight is 0; skip
            ta.style.height = "auto";
            ta.style.height = `${ta.scrollHeight}px`;
        };
        root.querySelectorAll(".wdm-knowledge-card textarea").forEach(ta => {
            autoGrowKnowledge(ta);
            if (ta.dataset.autogrowBound) return;
            ta.dataset.autogrowBound = "1";
            ta.addEventListener("input", () => autoGrowKnowledge(ta));
        });
        /* The knowledge panel is display:none until its tab is shown, so the
         * pass above measures 0 on first render — re-fit when the tab opens. */
        root.querySelectorAll('.wdm-tab-btn[data-tab="knowledge"]').forEach(btn => {
            if (btn.dataset.knowGrowBound) return;
            btn.dataset.knowGrowBound = "1";
            btn.addEventListener("click", () => requestAnimationFrame(() =>
                root.querySelectorAll(".wdm-knowledge-card textarea").forEach(autoGrowKnowledge)));
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
               <button type="button" class="ricfg-browse" data-for="${name}" title="${t("WITCHER.Sheet.Actor.Monster.Text.Browse", "Browse")}">
                 <i class="fa-solid fa-folder-open"></i></button>
             </div>`;
        const result = await DialogV2.prompt({
            window: { title: t("WITCHER.Dialog.Monster.TrophyIcons", "Trophy/Remains Icons") },
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
                label: t("WITCHER.Common.Save", "Save"),
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

    /* ── Embedded shields (open / delete) ────────────────────────────────
     * A shield dropped on a monster is auto-equipped in `_onDropItem`, so it's
     * usable right away — the block + shield-bash flows (defenseMixin / dock)
     * gate on `type === "shield" && equipped`. No equip step is surfaced. */
    static async _onOpenMonsterShield(event, target) {
        const item = this.actor.items.get(target.dataset.itemId);
        item?.sheet?.render(true);
    }

    static async _onDeleteMonsterShield(event, target) {
        const item = this.actor.items.get(target.dataset.itemId);
        if (item?.type !== "shield") return;
        await item.delete();
    }

    /* Combat Extended — Raise Shield. Same dialog + coverage picker the dock
     * uses; monsters carry the guard schema (shieldRaised) so it persists and
     * spends a Special Action slot in combat exactly like a character. */
    static async _onRaiseMonsterShield(event, target) {
        if (!isCESubsystemEnabled("raiseShield")) return;
        const item = this.actor.items.get(target.dataset.itemId);
        if (item?.type !== "shield") return;
        await openRaiseShieldDialog(this.actor, item);
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
                    /* Multi-input checkbox rows (damageTypes; qualities via
                     * add-then-remove cycles) round-trip unchecked slots as
                     * nulls. Strip null / empty-string entries from any array
                     * field on the row so downstream consumers — the dock
                     * (renderWeaponList) and the attack pipeline
                     * (weaponAttackMixin localizeTypes) — don't see
                     * [null,null,...] sparse junk that crashes string coercion. */
                    for (const [field, val] of Object.entries(current[i])) {
                        if (Array.isArray(val)) {
                            current[i][field] = val.filter(v => v != null && v !== "");
                        }
                    }
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

    /* Build a virtual weapon item from a monster attack declaration so
     * the unified weaponAttack() flow can roll it the same way it rolls
     * a character's weapon. The object quacks like a WitcherItem of
     * type "weapon" — has .type, .name, .img, .id, .uuid, .actor, and
     * a .system shaped like the weapon data model — without actually
     * being an embedded document on the actor. The attack flow's reads
     * are all non-mutating (no .update() on the weapon), so a plain
     * object works.
     *
     * Carries through:
     *   - damage formula (system.damage / system.effective.damage)
     *   - weapon qualities + values (Bleeding, AP, Silver — fed to the
     *     post-hit rider pipeline + the damage calculator's quality flags)
     *   - damage types (per-type reaction lookup on target)
     *   - chosen combat skill (skillKey)
     *
     * Stubs ammo APIs to no-ops so the bow/crossbow branches in the
     * attack flow stay quiescent for natural attacks. */
    _buildVirtualWeapon(attack, index) {
        return buildMonsterVirtualWeapon(this.actor, attack, index);
    }

    /* Roll an inline monster attack through the same flow that handles
     * character weapons (Core p.163 — monster to-hit = 1d10 + skill).
     * Routes through actor.weaponAttack() with a virtual weapon so the
     * resulting chat card carries the same collapsible summary, verdict
     * chips, Roll Damage button, status riders, crit wound auto-apply,
     * and target damage application that PCs get.
     *
     * Opens the modifier dialog in monsterMode (chrome monster dock uses
     * the same call). monsterMode strips strike-variant tabs (Strong /
     * Fast / Joint / Feint are PC-only per RAW p.153), aim, ammo, and
     * fast-draw — but ranged monster weapons get the full range-bracket
     * picker + weather ranged penalty + situational-mods surface that
     * PCs get (attackDialog dropped the monsterMode gate on `ranged` so
     * the branch fires for isRangedWeapon(weapon) regardless of PC/mon).
     * `skipActionGate` still fires because RAW Core p.151 has monsters
     * firing per ROF each round rather than burning the character
     * action budget. */
    static async _onRollMonsterAttack(event, target) {
        const index = Number(target.dataset.index);
        const attack = this.actor.system?.combat?.attacks?.[index];
        if (!attack) return;
        /* STA gate (same rule the dock uses). Refuses the swing if the
         * monster can't afford the printed staminaCost. Zero-cost
         * attacks always pass. */
        if (!monsterAttackHasStamina(this.actor, attack)) {
            const staCost = Number(attack?.staminaCost) || 0;
            const staCur  = Number(this.actor?.system?.derivedStats?.sta?.value) || 0;
            ui.notifications?.warn(
                `${this.actor.name} needs ${staCost} STA for this attack (has ${staCur}).`);
            return;
        }
        const virtualWeapon = this._buildVirtualWeapon(attack, index);
        /* Pre-gate parity with the dock's inline attack: refuse when the monster
         * has no action slot left this turn, so we don't roll a swing that can't
         * be committed and keep ROF/action bookkeeping in sync. */
        if (isActorInActiveCombat(this.actor) && this.actor?.nextActionSlot == null) {
            ui.notifications?.warn(
                tFormat("WITCHER.Notify.Dock.ActorNoActions", { actor: this.actor.name }, "{actor} has no actions left this turn."));
            return;
        }
        /* Capture combat membership BEFORE the async attack — game.combat can
         * transiently read null during weaponAttack's dialogs/targeting, so a
         * post-attack re-check would skip the ROF tick + action spend (same
         * failure the spell-cast fix addressed). */
        const wasLiveCombatant = !!(this.actor?._inActiveCombat && this.actor?._isMyTurn);

        /* Run the swing + post-commit bookkeeping. Shared by the immediate
         * path and the canvas tile-targeting path below (onPick hands us the
         * chosen defender via `forceDefender`). Mirrors the dock's
         * `runAttackAndSpend`, including its own try/catch so a deferred
         * onPick attack (fired after the overlay resolves, outside the setup
         * try/catch) is still guarded. */
        const runMonsterAttackAndSpend = async (attackOpts = {}) => {
            try {
                /* NOT skipActionGate — same as the dock's inline handler. weaponAttack
                 * enforces the turn / action-lock / slot gate, and we do the ROF +
                 * action-slot bookkeeping AFTER a committed swing. Previously this path
                 * skipped the gate AND never ticked ROF, so monster attacks rolled
                 * from the sheet never deducted ROF (the dock path did). */
                const result = await this.actor.weaponAttack(virtualWeapon, { monsterMode: true, ...attackOpts });
                /* Null return → cancelled / refused (no target, off-turn, no slot):
                 * no swing, no STA drain, no ROF tick. */
                if (result === null) return;
                await chargeMonsterAttackStamina(this.actor, attack);
                /* ROF + action-slot accounting — mirrors the dock's inline handler.
                 * Per-attack swing counter lives in the `monsterAttackUsed` flag; the
                 * action slot is committed only on the FINAL swing of the attack's ROF
                 * (earlier swings ride the slot freely), then all counters reset for
                 * the next slot. In-combat only; `force` bypasses the re-check that
                 * game.combat may have transiently nulled during the attack flow. */
                if (wasLiveCombatant) {
                    const SYS = "witcher-ttrpg-death-march";
                    const rofMax = Math.max(1, Number(attack?.rof) || 1);
                    const cur = this.actor.getFlag(SYS, "monsterAttackUsed") ?? {};
                    const nextCount = (Number(cur?.[index]) || 0) + 1;
                    if (nextCount >= rofMax) {
                        if (typeof this.actor.spendActionSlot === "function") {
                            await this.actor.spendActionSlot(`Attack: ${attack?.name || "Attack"}`, { force: true });
                        }
                        await this.actor.unsetFlag(SYS, "monsterAttackUsed");
                    } else {
                        await this.actor.setFlag(SYS, "monsterAttackUsed", { ...cur, [index]: nextCount });
                    }
                }
            } catch (err) {
                console.warn("witcher-ttrpg-death-march | monster attack failed", err);
                ui.notifications?.error(t("WITCHER.Notify.Monster.AttackFailed", "Monster attack failed — see console."));
            }
        };

        /* Canvas tile-targeting — the SAME overlay the character dock uses, so
         * monster melee AND ranged attacks pick their target on the canvas
         * (highlight reach / range → click the defender's tile → the picked
         * actor drives weaponAttack via `forceDefender`). Requires the monster
         * to have a token on a gridded canvas with the world setting on; any
         * other case (no token, gridless, unparseable range, setting off) makes
         * `beginWeaponTargeting` return false and we fall through to the
         * immediate attack. The virtual weapon carries `weaponType` + `range`,
         * so the overlay resolves melee-reach vs ranged-band exactly as it does
         * for a PC weapon. */
        try {
            const token = this.actor.getActiveTokens?.()?.[0] ?? null;
            if (token && isTileTargetingEnabled()) {
                const engaged = await beginWeaponTargeting(this.actor, token, virtualWeapon, {
                    onPick: (defenderActor) => runMonsterAttackAndSpend({ forceDefender: defenderActor })
                });
                if (engaged) return;   // the overlay owns the flow now
            }
        } catch (err) {
            console.warn("witcher-ttrpg-death-march | monster tile targeting failed", err);
        }

        await runMonsterAttackAndSpend();
    }

    /* Cast an embedded spell / hex / ritual from a monster's spell card.
     * The card carries `data-spell-id` = the embedded Item's id; we
     * resolve it via `actor.items.get` and hand off to the shared
     * `actor.castSpell` pipeline (same one the character dock uses).
     * Delegated click on the card body — buttons INSIDE the card that
     * carry their own `data-action` (delete) stop propagation so they
     * don't cast when clicked. */
    static async _onCastMonsterSpell(event, target) {
        /* Ignore clicks on interactive children of the card (delete etc.). */
        if (event.target?.closest?.("[data-action]") !== target) {
            /* The click landed on a nested action; let its handler run. */
            return;
        }
        const spellId = target.dataset.spellId
                     ?? target.closest?.("[data-spell-id]")?.dataset?.spellId;
        if (!spellId) return;
        const item = this.actor.items?.get?.(spellId);
        if (!item) {
            ui.notifications?.error(t("WITCHER.Notify.Monster.NoSpellItem", "Spell item could not be found on this monster."));
            return;
        }
        if (!["spell", "hex", "ritual"].includes(item.type)) return;
        try {
            /* Route the action economy off the cast result, same as the character
             * sheet / dock: capture in-combat + turn BEFORE the async cast so the
             * spend survives a transient game.combat null, then force it. Ritual /
             * multi-action casts lock the turn; else take an action slot. This was
             * missing entirely — monster casts from the sheet never spent. */
            const canAct = !!(this.actor?._inActiveCombat && this.actor?._isMyTurn);
            const res = await this.actor.castSpell(item);
            if (!res) return;
            if (res.fullRound) await this.actor.recordFullRound?.(`Cast: ${item.name}`, { force: canAct });
            else await this.actor.spendActionSlot?.(`Cast: ${item.name}`, { force: canAct });
        } catch (err) {
            console.warn("witcher-ttrpg-death-march | monster cast failed", err);
            ui.notifications?.error(t("WITCHER.Notify.Monster.CastFailed", "Monster cast failed — see console."));
        }
    }

    /* Remove an embedded spell from a monster (the trash button on the
     * spell card). */
    static async _onDeleteMonsterSpell(event, target) {
        event.stopPropagation?.();
        const spellId = target.dataset.spellId
                     ?? target.closest?.("[data-spell-id]")?.dataset?.spellId;
        if (!spellId) return;
        const item = this.actor.items?.get?.(spellId);
        if (!item) return;
        try { await item.delete(); }
        catch (err) {
            console.warn("witcher-ttrpg-death-march | monster spell delete failed", err);
        }
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
    /* A shield dropped onto a monster is usable immediately — monsters have no
     * equip step, so mark it equipped on embed. That flag is what the block /
     * shield-bash / dock flows gate on (`type === "shield" && equipped`), same
     * as a character's equipped shield. */
    async _onDropItem(event, item) {
        const result = await super._onDropItem(event, item);
        const created = Array.isArray(result) ? result : (result ? [result] : []);
        for (const it of created) {
            if (it?.type === "shield" && !it.system?.equipped) {
                try { await it.update({ "system.equipped": true }); } catch (_) { /* non-fatal */ }
            }
        }
        return result;
    }

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
        /* Spell / hex / ritual → EMBED on the monster as a real Item
         * document (same pattern as dragged-in weapons). Once embedded,
         * the spell surfaces on the sheet's Spells section as a card,
         * carries its full schema (staminaCost, castingTime, range,
         * duration, defense, school, effect, description), can be
         * pinned, and casts via the shared castSpell pipeline just
         * like a character's own spell. Skips the standard `_onDropItem`
         * super path so we control the copy (toObject stripping any
         * source-actor bindings). */
        if (["spell", "hex", "ritual"].includes(item.type)) {
            const proto = item.toObject();
            delete proto._id;
            const [created] = await this.actor.createEmbeddedDocuments("Item", [proto]);
            return created ?? item;
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
        /* Same-actor drop → sort, don't stack (moving an item within the
         * monster's own inventory shouldn't merge or duplicate). */
        if (this.actor.uuid === item.parent?.uuid) {
            return super._onDropItem(event, item);
        }
        /* Everything else (weapons, ammo, generic items dragged in from a
         * compendium or another actor) routes through the shared
         * WitcherActor.addItem path so identical ammo stacks by
         * `stackSignature` (name + type + img + system minus placement) —
         * dropping five bundles of the same arrow no longer produces five
         * rows. Weapons / armor / containers stay unique because
         * WitcherActor.itemIsStackable excludes them. */
        const landed = await this.actor.addItem(item);
        return landed ?? null;
    }

    /* Unlink the signature mutagen. */
    static async _onClearMutagen(event, target) {
        await this._flushForm();
        await this.actor.update({ "system.mutagen": { name: "", uuid: "" } });
    }
}
