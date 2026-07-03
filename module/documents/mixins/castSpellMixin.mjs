/**
 * castSpellMixin — actor method for casting a spell / hex / ritual.
 *
 * Composed onto WitcherActor (documents/actor.mjs). Exposes:
 *   actor.castSpell(item)   — cast a spell, weave a hex, or perform a ritual
 *
 * Fired by clicking a pinned castable in the combat dock's spells row. Opens
 * the cast dialog (applications/castDialog), rolls the governing magic skill
 * (spellcast / hexweave / ritcraft) through extendedRoll, then posts a single
 * "light" chat card: the d10 result plus the defense the target must beat, an
 * over-exertion warning when the round's Chaos exceeds Vigor, the components
 * spent, and a duration note. Damage is NOT auto-applied — the card carries
 * the effect narrative and the GM rolls the opposed defense / damage.
 *
 * Side effects, all post-roll: Stamina spent (signs capped at 7), components
 * decremented, and a native ActiveEffect created for round/time durations so
 * Foundry auto-expires it. Over-exertion (round Chaos past Vigor) costs 5 HP
 * per point over and lands an elemental fumble rider.
 *
 * Returns { item, fullRound } for the dock's action economy, or null on cancel.
 */

import { extendedRoll } from "../../rolls/extendedRoll.mjs";
import { openCastDialog, parseRangeMeters } from "../../applications/castDialog.mjs";
import {
    CAST_SKILL_BY_TYPE, SPELL_DEFENSES, HEX_DEFENSES, HEX_DANGER,
    SPELL_DURATION_UNITS, HEX_DURATION_UNITS, RITUAL_DURATION_UNITS,
    EXTRA_ACTION, drainHp,
    getActiveWeaponQualities, WEAPON_QUALITIES
} from "../../setup/config.mjs";
import { triggerElementalFumble } from "../../chrome/chrome/fumble-dialog.js";
import { hasWRPerk } from "../../api/witcherReborn.mjs";
import { requestDefenseFromOwner, emitApplyStatus } from "../../setup/socketHook.mjs";
import { appendAttackResult } from "./weaponAttackMixin.mjs";
import { getActorTargets } from "../../chrome/chrome/context-menu-actor.js";
import { pickAreaTargets, pickAreaSnapshot } from "../../mechanics/castArea.mjs";
import { invokeSpellHook } from "../../mechanics/spellHandlers.mjs";
import { createZoneTemplate } from "../../mechanics/zoneEffects.mjs";

/** Over-exertion costs 5 HP per STA point poured past Vigor in one round. */
const OVER_EXERT_PER_POINT = 5;

const MODULE = "witcher-ttrpg-death-march";
const esc    = (s) => Handlebars.escapeExpression(String(s ?? ""));
const signed = (n) => `${n >= 0 ? "+" : ""}${n}`;
const L      = (k) => game.i18n.localize(k);
const F      = (k, d) => game.i18n.format(k, d);

/* Signs (witcher) cap at 7 STA per cast (Core p.115). */
const SIGN_STA_CAP = 7;

/** Human label for a CONFIG.statusEffects entry id (Foundry v11+ uses
 *  `name`, older data still on `label`). Falls back to the id itself. */
function statusLabelById(id) {
    const def = (CONFIG.statusEffects ?? []).find(s => s?.id === String(id));
    if (!def) return String(id);
    const key = def.name ?? def.label;
    if (!key) return String(id);
    try { return game.i18n.localize(key) || String(id); }
    catch (_) { return String(key); }
}

/** Build a "Status Effects" fragment for one target — a titled block
 *  with one row per rider (APPLIED / MISSED chip + raw roll for
 *  transparency). Empty string when no riders resolved. */
function buildRiderFragment(targetName, riderResults) {
    if (!riderResults.length) return "";
    const rows = riderResults.map(r => {
        const cls = r.hit ? "is-hit" : "is-miss";
        const ico = r.hit ? "fa-check" : "fa-xmark";
        const verb = r.hit ? "applied" : "missed";
        return `<div class="wdm-cast-status-line ${cls}" style="display:flex;gap:6px;align-items:center;font-size:0.75rem;line-height:1.5;">
            <i class="fa-solid ${ico}" style="opacity:0.85;"></i>
            <strong>${esc(statusLabelById(r.statusId))}</strong>
            <span style="opacity:0.7;">${verb}</span>
            <span style="opacity:0.5;margin-left:auto;">rolled ${r.roll} vs ${r.chance}%</span>
        </div>`;
    }).join("");
    return `<div class="wdm-cast-status-block" style="margin-top:6px;padding:6px 8px;background:rgba(200,168,120,0.06);border:1px solid rgba(200,168,120,0.2);border-radius:2px;">
        <div class="wdm-cast-status-head" style="font-family:var(--wdm-font-display,inherit);font-size:0.75rem;letter-spacing:0.12em;text-transform:uppercase;color:#c8a878;margin-bottom:4px;">
            <i class="fa-solid fa-hand-sparkles"></i> Status Effects — ${esc(targetName)}
        </div>
        ${rows}
    </div>`;
}

/** Localize a stat label, falling back to the upper-cased key. */
function statName(statKey) {
    const key = String(statKey ?? "").toLowerCase();
    const out = game.i18n.localize(CONFIG.WITCHER.statLabel(key));
    return (!out || out.startsWith("WITCHER.")) ? key.toUpperCase() : out;
}

/** The defense label(s) the target rolls against — spell carries an array,
 *  hex a single enum, ritual none. Empty / "none" → []. */
function defenseLabels(item) {
    if (item.type === "hex") {
        const d = item.system?.defense;
        return (!d || d === "none") ? [] : [L(HEX_DEFENSES[d] ?? d)];
    }
    const arr = Array.isArray(item.system?.defense) ? item.system.defense : [];
    return arr.filter(d => d && d !== "none").map(d => L(SPELL_DEFENSES[d] ?? d));
}

/** Translate a {value, unit} duration into a native ActiveEffect duration, or
 *  null for instant / permanent / lifted (nothing to auto-expire). */
function durationToEffect(item) {
    const dur = item.system?.duration;
    if (!dur || !dur.unit) return null;
    const value = Number(dur.value) || 0;
    if (value <= 0) return null;
    switch (dur.unit) {
        case "rounds":  return { rounds: value };
        case "minutes": return { seconds: value * 60 };
        case "hours":   return { seconds: value * 3600 };
        case "days":    return { seconds: value * 86400 };
        default:        return null;   // instant / permanent / lifted
    }
}

/** Build the cast chat-card header: actor + castable name, a subtitle of the
 *  governing skill, a chip row of roll components, an info note block (defense,
 *  components, duration, danger, over-exertion warning) and the effect
 *  narrative. Mirrors attackRollFlavor's shape so the card sits with the others. */
function castFlavor({ actorName, itemName, subtitle, chips = [], rows = [], warn = "", effect = "" }) {
    const chipHtml = chips
        .filter(c => c && c.value != null && c.value !== "")
        .map(c => `<span class="wdm-chip"><span class="wdm-chip-k">${esc(c.label)}</span><span class="wdm-chip-v">${esc(c.value)}</span></span>`)
        .join("");
    const infoHtml = rows.length
        ? `<div class="wdm-attack-note"><i class="fa-solid fa-circle-info"></i> ${rows.join("<br>")}</div>`
        : "";
    const warnHtml = warn
        ? `<div class="wdm-attack-note wdm-cast-warn"><i class="fa-solid fa-triangle-exclamation"></i> ${esc(warn)}</div>`
        : "";
    const effectHtml = effect
        ? `<div class="wdm-cast-effect">${effect}</div>`
        : "";
    return `
        <div class="wdm-skill-head wdm-cast-head">
            <div class="wdm-skill-actor">${esc(actorName)}</div>
            <div class="wdm-skill-name">${esc(itemName)}</div>
            ${subtitle ? `<div class="wdm-skill-sub">${esc(subtitle)}</div>` : ""}
            ${chipHtml ? `<div class="wdm-skill-chips">${chipHtml}</div>` : ""}
            ${infoHtml}
            ${warnHtml}
            ${effectHtml}
        </div>`;
}

export const castSpellMixin = (Base) => class extends Base {

    /** Largest Focus value among equipped weapons carrying the Focus quality
     *  (Core p.115 — a focus reduces the STA cost of a cast). Reads effective
     *  stats so a socketed rune granting Focus counts. */
    _castFocus() {
        let focus = 0;
        for (const w of this.items) {
            if (w.type !== "weapon" || !w.system?.equipped) continue;
            const quals = w.system?.effective?.qualities ?? w.system?.qualities ?? [];
            if (!quals.includes("focus")) continue;
            const vals = w.system?.effective?.qualityValues ?? w.system?.qualityValues ?? {};
            focus = Math.max(focus, Number(vals.focus) || 0);
        }
        return focus;
    }

    /** Largest spellDCBonus among equipped weapons whose qualities carry it
     *  (Greater Focus = +2). Reads the active qualities catalog so a custom
     *  GM-authored quality with spellDCBonus picks up automatically. Only
     *  meaningful for rituals (and any other DC-rolled cast); applied as a
     *  default added to the dialog's DC. */
    _castSpellDCBonus() {
        const cat = (typeof getActiveWeaponQualities === "function" ? getActiveWeaponQualities() : null)
            ?? WEAPON_QUALITIES;
        let bonus = 0;
        for (const w of this.items) {
            if (w.type !== "weapon" || !w.system?.equipped) continue;
            const quals = w.system?.effective?.qualities ?? w.system?.qualities ?? [];
            for (const q of quals) {
                bonus = Math.max(bonus, Number(cat[q]?.spellDCBonus) || 0);
            }
        }
        return bonus;
    }

    /** The round id used to bucket cumulative Chaos (STA spent on magic). Null
     *  out of combat, where there's no round to accumulate across.
     *
     *  Composite key `${combatId}:${round}` so the flag from a PRIOR combat
     *  doesn't collide with the same round number in a NEW combat — that
     *  was making vigor read as depleted on a fresh combat once its round
     *  number happened to match a leftover flag. */
    _castRoundKey() {
        const c = game.combat;
        if (!c?.started) return null;
        return `${c.id}:${c.round}`;
    }

    /** Chaos (magic STA) already spent earlier this combat round, 0 if this is
     *  the first cast of the round or we're out of combat. */
    get _priorChaos() {
        const roundNo = this._castRoundKey();
        const flag = this.getFlag(MODULE, "chaosRound") ?? {};
        return (roundNo != null && flag.round === roundNo) ? (Number(flag.spent) || 0) : 0;
    }

    /** Record `spent` more Chaos against this round's running total. No-op out
     *  of combat (single casts are judged on their own there). */
    async _commitChaos(spent) {
        const roundNo = this._castRoundKey();
        if (roundNo == null || spent <= 0) return;
        await this.setFlag(MODULE, "chaosRound", { round: roundNo, spent: this._priorChaos + spent });
    }

    /** Over-exertion (Core p.166): pouring magic STA past Vigor in one round
     *  costs 5 HP per point over AND triggers an elemental fumble rider matching
     *  the spell's school (earth/air/fire/water/mixed). Owner writes its own HP /
     *  status, so no socket relay is needed. */
    async _applyOverExertion(over, element = null) {
        const dmg = Math.max(0, Number(over) || 0) * OVER_EXERT_PER_POINT;
        const hp = this.system?.derivedStats?.hp;
        if (hp && dmg > 0) {
            const { value, temp } = drainHp(hp, dmg);
            await this.update({
                "system.derivedStats.hp.value": value,
                "system.derivedStats.hp.temp":  temp
            });
        }
        await triggerElementalFumble(this, over, dmg, element);
    }

    /** Plan component consumption read-only: for each listed component, resolve
     *  the carried item (by uuid, else by name) and note how many are needed vs
     *  held. The card is built from this; _applyComponents mutates it after. */
    _planComponents(item) {
        const comps = Array.isArray(item.system?.components) ? item.system.components : [];
        return comps.map(c => {
            const need  = Math.max(1, Number(c.qty) || 1);
            const found = this._findComponentItem(c);
            const have  = found ? (Number(found.system?.quantity) || 1) : 0;
            return { name: c.name, need, have, item: found, missing: have < need };
        });
    }

    /** Find the carried inventory item backing a component reference. Matches
     *  the linked uuid first, then falls back to a name match (the link may
     *  point at a compendium/world source the actor only owns a copy of). */
    _findComponentItem(c) {
        if (c?.uuid) {
            const byUuid = this.items.find(i => i.uuid === c.uuid);
            if (byUuid) return byUuid;
        }
        if (c?.name) {
            return this.items.find(i =>
                i.name === c.name && !["spell", "hex", "ritual"].includes(i.type)) ?? null;
        }
        return null;
    }

    /** Decrement the planned components, deleting any stack that hits zero. */
    async _applyComponents(plan) {
        for (const p of plan) {
            if (!p.item || p.have <= 0) continue;
            const left = p.have - Math.min(p.need, p.have);
            if (left <= 0) await p.item.delete();
            else await p.item.update({ "system.quantity": left });
        }
    }

    /** Create a marker ActiveEffect on the caster for a round/time duration so
     *  Foundry auto-expires it. It carries no stat changes — light resolution
     *  leaves target effects to the GM; this just tracks that the cast is live. */
    async _applyCastDuration(item, durText) {
        const duration = durationToEffect(item);
        if (!duration) return false;
        try {
            await this.createEmbeddedDocuments("ActiveEffect", [{
                name: item.name,
                img: item.img,
                duration,
                description: durText ? `${item.name} — ${durText}` : item.name,
                statuses: [],
                flags: { [MODULE]: { castMarker: true, sourceItem: item.uuid } }
            }]);
            return true;
        } catch (err) {
            console.warn("witcher-ttrpg-death-march | cast duration effect failed", err);
            return false;
        }
    }

    /**
     * Cast a spell / hex / ritual. `item` is a WitcherItem of one of those
     * types. Opens the cast dialog, rolls the magic skill, posts the light card,
     * and applies the side effects (STA, components, duration). Returns
     * { item, fullRound } for the dock's action economy, or null on cancel.
     */
    async castSpell(item) {
        if (!item || !["spell", "hex", "ritual"].includes(item.type)) return null;
        const isRitual = item.type === "ritual";
        // Witcher signs cap at 7 STA per cast (Core p.115). Authoritative here,
        // not just in the dialog, so the cap holds regardless of entry point.
        const isSign = item.type === "spell" && item.system?.spellForm === "sign";
        /* Narrative-only spells (system.narrative:true) skip every
         * mechanical branch — no target selection, no defense
         * contest, no zone create, no auto-apply of anything. They
         * roll the spellcasting check, post the effect description
         * on the chat card, spend STA + components, and hand off
         * adjudication to the GM. Reserved for spells whose
         * mechanics can't fit the schema (or where the GM wants
         * pure prose resolution). */
        const isNarrative = item.system?.narrative === true;
        /* Persistent zone flag — determines whether the area
         * harvest branch below asks for a placement snapshot
         * (createZoneTemplate consumes it after the roll settles)
         * or a one-shot actor list (existing AoE damage path). */
        const isPersistentZone = !isRitual
            && !isNarrative
            && item.system?.areaPersist === true
            && ["cone", "radius", "cube", "line"].includes(String(item.system?.areaShape ?? "none"));

        // Governing magic skill (all WILL-based): spell→spellcast, hex→hexweave,
        // ritual→ritcraft. Read its post-prepare total for the base to-hit.
        const skillKey = CAST_SKILL_BY_TYPE[item.type];
        const sv = this._readSkillValues(skillKey);
        const baseTotal = sv?.total ?? 0;
        const focus = this._castFocus();
        // Greater Focus (and any quality declaring spellDCBonus): the cast
        // roll gets a flat positive modifier. Implemented as a +N to the
        // cast roll rather than −N to the DC so the modifier is visible in
        // the chips and applies uniformly to spells AND rituals.
        const spellDCBonus = this._castSpellDCBonus();

        // Extra action (Core p.151): when the caster has already spent their
        // normal action this turn, the cast rides the extra action and takes
        // its −3 to-hit (the 3-STA cost is charged by the dock's action
        // economy). Rituals are full-round, never an extra action. Mirrors the
        // weapon attack's extra-action handling so casts (Aard, etc.) match.
        const extraAction  = !isRitual && this.nextActionSlot === "extra";
        const extraPenalty = extraAction ? EXTRA_ACTION.toHit : 0;

        // Read-only skill chips shown at the top of the dialog + card.
        const baseChips = sv ? [
            { label: statName(sv.meta.statKey), value: sv.statVal },
            { label: "Rank", value: sv.skillVal },
            sv.skillMod ? { label: "Mod", value: signed(sv.skillMod) } : null
        ].filter(Boolean) : [];

        /* Handler onCastDialog hook — bespoke pre-dialog step for
         * spells whose dialog needs extra fields (mode picker for
         * Wrath of Nature, STA-tier picker for Cursed Illness).
         * Handler pushes fields into `dialogContext.extraFields`
         * which openCastDialog renders under the standard block. */
        const dialogContext = { extraFields: [] };
        await invokeSpellHook(item, "onCastDialog", {
            actor: this, item, dialogContext
        });

        const decl = await openCastDialog(this, item, {
            base: { total: baseTotal, chips: baseChips }, focus, extraPenalty,
            extraFields: dialogContext.extraFields
        });
        if (!decl) return null;   // player cancelled

        /* Range gate — enforced ONLY when both caster and target have
         * tokens on the canvas. Theatre-of-mind (no tokens) skips the
         * check entirely per user spec. When enforcement fires and the
         * measured distance exceeds the spell's range, refuse the cast
         * BEFORE any STA / adrenaline is debited. No dialog banner —
         * just a ui.notifications.warn (same UX as the ranged weapon
         * out-of-range flow). */
        if (!isRitual) {
            const spellRangeM = parseRangeMeters(item);
            const rangeIsFinite = Number.isFinite(spellRangeM) && spellRangeM !== Infinity && spellRangeM >= 0;
            const aTok = this?.getActiveTokens?.()?.[0] ?? null;
            const dTok = Array.from(game.user?.targets ?? [])[0] ?? null;
            if (rangeIsFinite && aTok && dTok && canvas?.grid) {
                /* Chebyshev distance in meters — diagonal-adjacent tiles
                 * count as 1 tile, matching the Witcher system's grid model
                 * (diagonal-adjacent = 2 m at 1.5 m/tile). Foundry's
                 * canvas.grid.measureDistance respects the SCENE's
                 * diagonal-cost setting (5-10-5 / Euclidean) and would
                 * report 2.12 m or 3 m diagonally, breaking short-range
                 * spells at diagonal reach. We compute Chebyshev inline
                 * to stay independent of the scene's diagonal choice. */
                let distanceMeters = null;
                const a = aTok.center ?? aTok;
                const b = dTok.center ?? dTok;
                const ax = Number(a?.x), ay = Number(a?.y);
                const bx = Number(b?.x), by = Number(b?.y);
                if (Number.isFinite(ax) && Number.isFinite(bx)) {
                    const chebyPx = Math.max(Math.abs(ax - bx), Math.abs(ay - by));
                    const sz = Number(canvas?.scene?.grid?.size)     || 100;
                    const gd = Number(canvas?.scene?.grid?.distance) || 1.5;
                    distanceMeters = (chebyPx / sz) * gd;
                }
                if (Number.isFinite(distanceMeters) && distanceMeters > spellRangeM) {
                    ui.notifications?.warn(
                        `${item.name} — target is ${Math.round(distanceMeters)}m away, ` +
                        `out of range (max ${spellRangeM}m).`
                    );
                    return null;
                }
            }
        }

        // What this cast spends. Rituals roll vs a DC and pay their fixed model
        // cost; spells / hexes spend the dialog amount. Signs are hard-capped at
        // SIGN_STA_CAP here regardless of what the dialog returned.
        let staToSpend = isRitual
            ? Math.max(0, Number(item.system?.staminaCost) || 0)
            : Math.max(0, Number(decl.staSpend) || 0);
        let signCapped = !!decl.signCapped;
        if (isSign && staToSpend > SIGN_STA_CAP) { staToSpend = SIGN_STA_CAP; signCapped = true; }

        /* Adrenaline dice — each die adds +1d6 to the cast's damage roll
         * and costs `adrStaPerDie` STA (halved for Combat Meditation
         * holders, computed in the dialog). Total STA burnt this cast
         * = spell STA + adrenaline STA; both count toward over-exertion
         * per RAW Core p.166 ("magic STA past Vigor"). */
        const adrenalineDice    = Math.max(0, Number(decl.adrenalineDice) || 0);
        const adrenalineStaCost = Math.max(0, Number(decl.adrenalineStaCost) || 0);
        const totalStaSpend     = staToSpend + adrenalineStaCost;

        // Refuse the cast if the pool can't cover it — don't roll, don't spend.
        if (totalStaSpend > this._sta.value) {
            ui.notifications?.warn(L("WITCHER.Cast.NoStamina"));
            return null;
        }
        /* Refuse the cast if the adrenaline pool can't cover the picked dice. */
        if (adrenalineDice > 0 && adrenalineDice > (Number(this.system?.adrenaline?.value) || 0)) {
            ui.notifications?.warn(`Not enough adrenaline (${adrenalineDice} needed).`);
            return null;
        }

        // To-cast total: base skill + extra-action penalty + the dialog's other
        // modifier + Greater Focus bonus from equipped weapons. Rituals roll
        // against the declared DC.
        const grandMod = baseTotal + extraPenalty + (Number(decl.otherMod) || 0) + spellDCBonus;
        const formula  = grandMod >= 0 ? `1d10 + ${grandMod}` : `1d10 - ${Math.abs(grandMod)}`;
        const dc = isRitual ? (Number(decl.dc) || 0) : null;

        // Compute the card's notes BEFORE rolling (extendedRoll posts the card
        // with this flavor); the actual mutations happen afterwards.
        const plan = this._planComponents(item);
        const durText = this._durationText(item);

        // Over-exertion (Core p.166): Vigor is the round's threshold for ALL
        // magic — cumulative magic STA poured past it costs 5 HP/point. Only the
        // MARGINAL points THIS cast pushes above the threshold are charged: the
        // floor is max(Vigor, priorChaos) so earlier over-exertion isn't
        // re-billed each subsequent cast. Predict here for the card; commit after.
        //
        // Adrenaline STA is EXCLUDED from the vigor check per user ruling — the
        // spell's own STA drives magic, adrenaline is a separate resource
        // channelled INTO the roll. Only `staToSpend` (the spell's own cost)
        // is measured against Vigor.
        let over = 0;
        if (!isRitual && staToSpend) {
            const vigor = Number(this.system?.derivedStats?.vigor) || 0;
            if (vigor > 0) {
                const prior = this._priorChaos;
                const predicted = prior + staToSpend;
                over = Math.max(0, predicted - Math.max(vigor, prior));
            }
        }

        // Build the info rows.
        const rows = [];
        if (!isRitual) {
            const defs = defenseLabels(item);
            rows.push(defs.length
                ? `${esc(L("WITCHER.Cast.Defense"))}: <b>${esc(defs.join(" / "))}</b>`
                : esc(L("WITCHER.Cast.DefenseNone")));
        }
        if (item.type === "hex" && item.system?.danger)
            rows.push(`${esc(L("WITCHER.Cast.Danger"))}: <b>${esc(L(HEX_DANGER[item.system.danger] ?? item.system.danger))}</b>`);
        if (staToSpend) rows.push(esc(F("WITCHER.Cast.Spent", { n: staToSpend })));
        if (extraPenalty) rows.push(esc(L("WITCHER.Attack.ExtraActionForced")));
        if (signCapped) rows.push(esc(L("WITCHER.Cast.SignCap")));
        const consumedNames = plan.filter(p => p.item && p.have > 0).map(p => p.need > 1 ? `${p.name} ×${p.need}` : p.name);
        if (consumedNames.length) rows.push(esc(F("WITCHER.Cast.Consumed", { items: consumedNames.join(", ") })));
        for (const p of plan.filter(p => p.missing))
            rows.push(esc(F("WITCHER.Cast.ComponentMissing", { name: p.name, qty: p.need })));
        if (durText && durationToEffect(item))
            rows.push(esc(F("WITCHER.Cast.DurationApplied", { dur: durText })));

        const warn = over > 0
            ? F("WITCHER.Cast.OverExert", { spent: this._priorChaos + staToSpend, vigor: Number(this.system?.derivedStats?.vigor) || 0, over, dmg: over * OVER_EXERT_PER_POINT })
            : "";

        const subtitle = game.i18n.localize(CONFIG.WITCHER.skillLabel(skillKey));
        const chips = [
            ...baseChips,
            extraPenalty ? { label: L("WITCHER.Attack.ExtraAction"), value: signed(extraPenalty) } : null,
            spellDCBonus ? { label: "Greater Focus", value: signed(spellDCBonus) } : null,
            !isRitual && staToSpend ? { label: L("WITCHER.Cast.StaCost"), value: staToSpend } : null,
            decl.otherMod ? { label: L("WITCHER.Cast.OtherMod"), value: signed(decl.otherMod) } : null,
            dc != null ? { label: L("WITCHER.Cast.DC"), value: dc } : null
        ].filter(Boolean);

        const flavor = castFlavor({
            actorName: this.name,
            itemName:  item.name,
            subtitle,
            chips,
            rows,
            warn,
            effect: item.system?.effect ?? ""
        });

        /* Structured cast envelope stamped on the chat message. Riders
         * subscribe to (actor, item, kind, isDamaging) and inject their
         * buttons on the card by reading this. `damage.rolled` is null
         * at stamp time — the rider that opens the damage flow rolls it.
         * `targets[i].defenseTotal / hit` are filled in by the defense
         * resolution downstream. Kept intentionally lean: only include
         * fields that riders actually need to make decisions. */
        const targetsList = Array.from(game.user?.targets ?? [])
            .map(t => t?.actor?.uuid)
            .filter(Boolean)
            .map(uuid => ({ uuid, defenseTotal: null, hit: null }));
        const defenseArr = item.type === "hex"
            ? (item.system?.defense ? [String(item.system.defense)] : [])
            : (Array.isArray(item.system?.defense) ? [...item.system.defense] : []);
        const vigorAtCast = Number(this.system?.derivedStats?.vigor) || 0;
        const castContext = {
            itemUuid:    item.uuid,
            casterUuid:  this.uuid,
            kind:        item.type,
            form:        item.system?.spellForm ?? null,
            school:      item.system?.school ?? null,
            tier:        item.system?.spellType ?? null,
            /* staSpent is the SPELL's own STA — the number Igni-style
             * "1d6 per STA" scales against. Adrenaline STA is tracked
             * separately (adrenalineStaSpent) because it's a channelled
             * side-cost, not "STA driving the spell." */
            staSpent:         staToSpend,
            adrenalineStaSpent: adrenalineStaCost,
            vigorAtCast,
            overExertion: {
                threshold:  vigorAtCast,
                priorChaos: this._priorChaos,
                marginal:   over
            },
            variable: {
                supported: !!item.system?.variableCost,
                factor:    !!item.system?.variableCost && Number(item.system?.staminaCost) > 0
                    ? staToSpend / Number(item.system.staminaCost)
                    : 1
            },
            defense: defenseArr,
            targeting: {
                mode:  item.system?.targetType ?? "direct",
                range: item.system?.range ?? ""
            },
            duration: {
                value: item.system?.duration?.value ?? "",
                unit:  item.system?.duration?.unit  ?? "instant"
            },
            damage: (() => {
                /* Base formula authored on the item (or edited in the
                 * dialog for variableCost casts). Empty = non-damaging. */
                const baseFormula = String(decl.damageFormula ?? item.system?.damageFormula ?? "");
                /* Fold adrenaline dice into the formula as `+Nd6`. Only
                 * applies when the base formula is non-empty (adrenaline
                 * doesn't invent damage on a utility spell). Combat
                 * Meditation is already reflected in the STA cost, not
                 * the dice count — same +1d6 either way, just cheaper. */
                const withAdr = (baseFormula && adrenalineDice > 0)
                    ? `${baseFormula} + ${adrenalineDice}d6`
                    : baseFormula;
                const source = adrenalineDice > 0 && baseFormula
                    ? [{ formula: `${adrenalineDice}d6`, source: "Adrenaline" }]
                    : [];
                return {
                    formula:  withAdr,
                    rolled:   null,
                    element:  String(decl.damageElement ?? item.system?.damageElement ?? "none"),
                    /* damageType: hp / sta / ablation / reliability / shieldHp —
                     * where the damage lands. */
                    type:     String(item.system?.damageType ?? "none"),
                    /* addedBy: audit trail for boosts (Adrenaline field,
                     * future cast riders). */
                    addedBy:  source
                };
            })(),
            /* Tangibility of the cast as a whole — drives shield
             * interaction on BOTH damage AND status riders. TRUE = shield
             * drains / blocks (fire, rocks, lightning, ice, impact).
             * FALSE = bypasses shield entirely (suffocation, noxious
             * fumes, mental effects, most hexes). Read straight off the
             * item schema; the damage-apply + rider paths in castDamage.mjs
             * key off this. */
            tangible: item.system?.tangible !== false,
            /* Area geometry — separate from `targetType` (which is the
             * tactical intent axis). area.shape carries the projected shape
             * (cone/radius/cube/line/touch/self); size is metres. */
            area: {
                shape: String(item.system?.areaShape ?? "none"),
                size:  Number(item.system?.areaSize ?? 0) || 0
            },
            /* Status riders — from the item's authored statusRiders array.
             * Each has {statusId, chance, duration}. Downstream: after damage
             * lands, each rider rolls chance% to inflict the status on the
             * hit target. */
            statusRiders: Array.isArray(item.system?.statusRiders)
                ? item.system.statusRiders.map(r => ({
                    statusId: String(r?.statusId ?? ""),
                    chance:   Number(r?.chance ?? 100) || 0,
                    duration: {
                        value: String(r?.duration?.value ?? ""),
                        unit:  String(r?.duration?.unit  ?? "instant")
                    }
                }))
                : [],
            targets: targetsList,
            components: plan
                .filter(p => p.item && p.have > 0)
                .map(p => ({ name: p.name, qty: p.need }))
        };

        /* ── Defender fan-out + parallel defense prompts ──────────────
         * Collect EVERY currently-targeted actor into the candidate pool
         * (multi-target: Aard vs 3 grunts, Igni cone vs 4 spiders). Fall
         * back to the combat-tracker per-user actorTargetUuid for
         * theater-of-mind when no visible tokens are targeted. Dispatch
         * defense requests in PARALLEL — serial would stack N × 30s
         * timeouts on the caster's UI.
         *
         * Skip the whole fan-out when:
         *   - Ritual (roll-vs-DC, no defenders).
         *   - No defense clauses on the spell.
         *   - No candidates resolved.
         *   - Every candidate is the caster (self-buffs). */
        const _tokenTargets = isNarrative ? [] :
            Array.from(game.user?.targets ?? [])
                .map(t => t?.actor)
                .filter(Boolean);
        let _candidatePool = _tokenTargets.slice();
        /* Placement snapshot captured for a persistent-zone cast —
         * passed to `createZoneTemplate` after the roll settles so
         * the scene gets a real MeasuredTemplateDocument with the
         * caster's aimed orientation. Null for one-shot AoEs and
         * for spells with no area shape at all. */
        let _zonePlacement = null;
        /* Area harvest — when the user picked NO targets AND the spell
         * has a Foundry-mappable area shape (cone/radius/cube/line),
         * drop an interactive MeasuredTemplate preview and gather every
         * token whose center falls inside. Silent skip when the shape
         * doesn't map (touch/self/none) or the harvest is cancelled.
         *
         * Persistent-zone branch uses `pickAreaSnapshot` instead of
         * `pickAreaTargets` — same UX, but the returned snapshot
         * carries { x, y, direction, shape, size, foundryType }
         * needed to write the scene-persistent template. Actors
         * inside at cast-time are still returned so a persistent
         * zone can ALSO deal one-shot damage on placement when
         * `damagePer:"cast"` is set. */
        const _areaShape = String(item.system?.areaShape ?? "none");
        const _hasAreaShape = ["cone", "radius", "cube", "line"].includes(_areaShape);
        if (!isNarrative && !_candidatePool.length && !isRitual && _hasAreaShape) {
            try {
                if (isPersistentZone) {
                    const snap = await pickAreaSnapshot({ actor: this, item });
                    if (snap) {
                        _zonePlacement = snap.placement;
                        if (Array.isArray(snap.actors) && snap.actors.length) {
                            _candidatePool = snap.actors;
                        }
                    }
                } else {
                    const harvested = await pickAreaTargets({ actor: this, item });
                    if (Array.isArray(harvested) && harvested.length) _candidatePool = harvested;
                }
            } catch (err) {
                console.warn(`${MODULE} | area harvest failed`, err);
            }
        }
        if (!isNarrative && !_candidatePool.length) {
            /* Multi-target aware tokenless fallback — actorTargetUuids
             * carries EVERY combat-tracker targeted actor when no canvas
             * tokens exist. Single-value getActorTarget() would truncate
             * a multi-target set to one. */
            try {
                const tokenless = await getActorTargets();
                if (Array.isArray(tokenless) && tokenless.length) _candidatePool = tokenless;
            } catch (_) { /* soft-fail — no candidates */ }
        }
        const _seenUuids = new Set();
        const _defenderCandidates = _candidatePool.filter(a => {
            if (!a || a === this) return false;
            if (_seenUuids.has(a.uuid)) return false;
            _seenUuids.add(a.uuid);
            return true;
        });
        const _engagementId = `castEng-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const _willPrompt = !isRitual
            && defenseArr.length > 0
            && _defenderCandidates.length > 0;
        /* Parallel dispatch → array of { targetActor, defenseChoice }
         * in candidate order. Each defender's owner sees their own
         * prompt independently; timeouts run concurrently. */
        let _defenderResults = [];
        if (_willPrompt) {
            _defenderResults = await Promise.all(_defenderCandidates.map(async (defenderActor) => {
                let choice = { action: "none", defenseTotal: null };
                try {
                    choice = await requestDefenseFromOwner({
                        defenderActor,
                        attackerName:      this.name,
                        weaponName:        item.name,
                        weaponImg:         item.img,
                        engagementId:      _engagementId,
                        attackKind:        "cast",
                        shotIndex:         1,
                        totalShots:        1,
                        disallowedItemIds: [],
                        attackerDamageFlags: null,
                        attackHitLocation: null,
                        /* Narrow to the spell's declared defenses (Igni
                         * ["dodge","block"], Aard ["dodge"], etc.). */
                        allowedDefenses:   defenseArr,
                        /* Blocking a spell requires a shield with cover
                         * ≥ 1 — same gate as ranged/thrown. */
                        requiresShieldCover: true
                    }) ?? choice;
                } catch (err) {
                    console.warn(`${MODULE} | cast defense prompt failed for ${defenderActor?.name}`, err);
                }
                return { targetActor: defenderActor, defenseChoice: choice };
            }));
        }
        /* Legacy single-defender alias — kept so the message-level
         * `defenderUuid` flag (read by melee-side crit / Manticore code)
         * still resolves. Null when no fan-out fired. */
        const _defenderActor = _defenderResults[0]?.targetActor ?? null;

        /* Handler onBeforeRoll hook — LAST chance to mutate castContext
         * before the roll is rolled and stamped on the chat card.
         * Handler may push damage bonuses, override formula/element,
         * add ad-hoc riders, or set castContext.abort = true to bail
         * out silently (no roll, no STA spent — the mixin returns
         * null and the dock's action economy sees a cancellation). */
        const _hookCtx = { actor: this, item, castContext, decl, abort: false };
        await invokeSpellHook(item, "onBeforeRoll", _hookCtx);
        if (_hookCtx.abort) return null;

        const result = await extendedRoll(
            formula,
            {
                speaker: ChatMessage.getSpeaker({ actor: this }),
                flavor,
                flags: (r) => ({
                    [MODULE]: {
                        category:    "combat",
                        /* Same flag shape the attack flow uses so downstream
                         * damage / rider readers can share the same lookups
                         * (defenderUuid, attackerUuid, engagementId, attackTotal). */
                        attackerUuid: this.uuid,
                        attackerName: this.name,
                        engagementId: _engagementId,
                        attackTotal:  r.total,
                        ...(_defenderActor?.uuid ? { defenderUuid: _defenderActor.uuid } : {}),
                        castContext: {
                            ...castContext,
                            castTotal: r.total,
                            fumble:    r.fumble,
                            /* Copy EVERY resolved defender into the target
                             * list — castDamage iterates this array to
                             * apply per-target damage and status. `hit`
                             * fills in below once the cast total resolves. */
                            targets: _defenderResults.length
                                ? _defenderResults.map(({ targetActor, defenseChoice }) => ({
                                    uuid: targetActor.uuid,
                                    defenseTotal: Number.isFinite(defenseChoice?.defenseTotal) ? defenseChoice.defenseTotal : null,
                                    hit: null
                                }))
                                : castContext.targets
                        }
                    }
                })
            },
            { ...(dc != null ? { threshold: dc } : {}), fumbleCategory: "magic" }
        );

        /* ── Per-target verdict blocks on the cast card ───────────────
         * One HIT/MISS block per defender. Shape matches melee's verdict
         * block. When >1 defender, each block leads with a "vs
         * <TargetName>" chip so a collapsed 3-target row still reads
         * cleanly. Ties favor defender (RAW).
         *
         * Aggregate flags:
         *   castVerdict = "hit" when ANY target hit (Roll Damage button
         *     injects, per-target loop in castDamage filters on t.hit).
         *   castVerdict = "miss" when EVERY target missed (button strips).
         *   defenseTotal (legacy scalar) = first defender's number, for
         *     downstream code that still reads the message-level flag.
         *
         * castContext.targets on the message is patched with the resolved
         * `hit` and `defenseTotal` per target so castDamage's per-target
         * damage/status apply loop can skip missed targets. */
        if (_willPrompt && result?.message && _defenderResults.length) {
            const attackTotal = Number(result.total) || 0;
            const perTarget = [];
            let anyHit = false;

            for (const { targetActor, defenseChoice } of _defenderResults) {
                let defenseTotal = Number(defenseChoice?.defenseTotal);
                /* No response / cancelled → treat as helpless: DC 10
                 * (RAW p.161 adapted for casts). */
                const dc10Pass = (defenseChoice?.action === "none" || defenseChoice?.timedOut === true);
                if (!Number.isFinite(defenseTotal)) defenseTotal = 10;
                const delta = attackTotal - defenseTotal;
                const isHit = delta > 0;
                if (isHit) anyHit = true;

                const verdictHead  = isHit ? "HIT" : "MISS";
                const verdictClass = isHit ? "is-hit" : "is-miss";
                const verdictSub = delta > 0
                    ? `attacker beat by ${delta}`
                    : delta === 0
                        ? `tie — defender wins`
                        : `defender beat by ${Math.abs(delta)}`;
                const chipRow = Array.isArray(defenseChoice?.defenseChips) && defenseChoice.defenseChips.length
                    ? `<span class="wdm-attack-defense-chips">${defenseChoice.defenseChips
                        .map(c => `<span class="wdm-atk-chip"><span class="k">${esc(c.label)}</span><span class="v">${esc(c.value)}</span></span>`)
                        .join("")}</span>`
                    : "";
                const defActionTitle = defenseChoice?.action
                    ? defenseChoice.action.charAt(0).toUpperCase() + defenseChoice.action.slice(1)
                    : "None";
                const defenseLine = dc10Pass
                    ? `<div class="wdm-attack-defense"><span class="wdm-attack-defense-k">Defense</span> <span class="wdm-attack-defense-v"><b>${defenseChoice?.timedOut ? "No response" : "Took the hit"}</b> — DC <b>10</b></span></div>`
                    : `<div class="wdm-attack-defense"><span class="wdm-attack-defense-k">Defense</span> <span class="wdm-attack-defense-v"><b>${esc(defActionTitle)}</b> → <b>${defenseTotal}</b></span>${chipRow}</div>`;
                /* Per-target label surfaces only in the fan-out case;
                 * single-defender casts read identically to before. */
                const targetLabel = _defenderResults.length > 1
                    ? `<div class="wdm-cast-verdict-target" style="font-size:0.75rem;letter-spacing:0.08em;text-transform:uppercase;opacity:0.7;margin-bottom:2px;">vs ${esc(targetActor.name)}</div>`
                    : "";
                const verdictFragment =
                    targetLabel +
                    `<div class="wdm-attack-verdict ${verdictClass}">` +
                        `<span class="wdm-attack-verdict-head">${verdictHead}</span>` +
                        `<span class="wdm-attack-verdict-sub">${esc(verdictSub)}</span>` +
                    `</div>` +
                    defenseLine;
                const summaryLabel = _defenderResults.length > 1
                    ? `${verdictHead} · ${targetActor.name}`
                    : verdictHead;
                perTarget.push({
                    uuid: targetActor.uuid,
                    fragment: verdictFragment,
                    summaryLabel,
                    isHit,
                    defenseTotal
                });
            }

            /* Sequential append so summary-chip order matches the
             * candidate order (appendAttackResult queues per-message,
             * but keeping this loop explicit avoids depending on that
             * internal detail). */
            for (const p of perTarget) {
                try {
                    await appendAttackResult(result.message, {
                        fragment: p.fragment,
                        summaryAdd: { label: p.summaryLabel, kind: p.isHit ? "hit" : "miss" }
                    });
                } catch (err) {
                    console.warn(`${MODULE} | cast verdict patch failed`, err);
                }
            }
            /* Stamp hit/defenseTotal per target back onto castContext so
             * castDamage's per-target damage loop skips missed targets. */
            try {
                const freshContext = result.message.getFlag(MODULE, "castContext") ?? {};
                const stampedTargets = (freshContext.targets ?? []).map(t => {
                    const p = perTarget.find(x => x.uuid === t.uuid);
                    return p ? { ...t, hit: p.isHit, defenseTotal: p.defenseTotal } : t;
                });
                await result.message.setFlag(MODULE, "castContext", {
                    ...freshContext,
                    targets: stampedTargets
                });
                await result.message.setFlag(MODULE, "defenseTotal", perTarget[0]?.defenseTotal ?? null);
                await result.message.setFlag(MODULE, "castVerdict", anyHit ? "hit" : "miss");
            } catch (err) {
                console.warn(`${MODULE} | cast verdict flag stamp failed`, err);
            }

            /* Auto-apply status riders per hit target. Fires at CAST
             * time, not damage-button time, so spells with no damage
             * formula (Aard's knockdown, Yrden's paralysis, Somne's
             * sleep) still land their effect. Each rider rolls d100
             * vs chance% per target; hits fire emitApplyStatus with
             * the cast's tangibility so intangible sources bypass
             * shield-status blocks (handleApplyStatus resolves the
             * gate). Fragment + summary chips fold into the same
             * cast card. */
            const _riders = Array.isArray(castContext.statusRiders) ? castContext.statusRiders : [];
            if (_riders.length && anyHit) {
                const _tangible = castContext.tangible !== false;
                for (const p of perTarget) {
                    if (!p.isHit) continue;
                    const targetActor = await fromUuid(p.uuid).catch(() => null);
                    const targetName  = targetActor?.name ?? "target";
                    const riderResults = [];
                    for (const rider of _riders) {
                        const chance = Number(rider.chance) || 0;
                        const roll100 = Math.floor(Math.random() * 100) + 1;
                        const hit = roll100 <= chance;
                        if (hit && targetActor) {
                            try {
                                await emitApplyStatus({
                                    targetUuid:     targetActor.uuid,
                                    statusId:       String(rider.statusId),
                                    action:         "apply",
                                    sourceTangible: _tangible
                                });
                            } catch (_) { /* soft-fail per rider */ }
                        }
                        riderResults.push({ statusId: String(rider.statusId), chance, roll: roll100, hit });
                    }
                    if (riderResults.length) {
                        try {
                            await appendAttackResult(result.message, {
                                fragment: buildRiderFragment(targetName, riderResults)
                            });
                            for (const r of riderResults) {
                                if (r.hit) await appendAttackResult(result.message, {
                                    summaryAdd: { label: statusLabelById(r.statusId), kind: "status" }
                                });
                            }
                        } catch (err) {
                            console.warn(`${MODULE} | cast rider fold failed`, err);
                        }
                    }
                }
            }
        }

        /* ── Auto-hit status apply when the spell has no defense clause ─
         * Spells authored with `defense: []` (nothing to resist against)
         * skip the fan-out above, so status riders never got their
         * chance to fire. Fall through here: for every candidate, roll
         * each rider's chance% and apply on success. Mirrors the shape
         * of the rider block inside `_willPrompt` — same fold, same
         * summary chips — so the card reads identically. Guarded on
         * `!_willPrompt` so no double-apply.
         *
         * Only mode:"onHit" riders fire here — zone-mode riders are
         * applied by zoneEffects.mjs when tokens enter the persistent
         * template, not at cast time. Narrative spells skip the auto-
         * apply entirely (adjudicated by GM). */
        if (!isNarrative && !_willPrompt && !isRitual && result?.message
            && _defenderCandidates.length
            && Array.isArray(castContext.statusRiders) && castContext.statusRiders.length) {
            const _tangible = castContext.tangible !== false;
            for (const targetActor of _defenderCandidates) {
                const targetName = targetActor?.name ?? "target";
                const riderResults = [];
                for (const rider of castContext.statusRiders) {
                    /* Skip zone / tick riders — they're applied by the
                     * zone engine on token entry, not on cast. */
                    if (rider.mode && rider.mode !== "onHit") continue;
                    const chance  = Number(rider.chance) || 0;
                    const roll100 = Math.floor(Math.random() * 100) + 1;
                    const hit     = roll100 <= chance;
                    if (hit) {
                        try {
                            await emitApplyStatus({
                                targetUuid:     targetActor.uuid,
                                statusId:       String(rider.statusId),
                                action:         "apply",
                                sourceTangible: _tangible
                            });
                        } catch (_) { /* soft-fail per rider */ }
                    }
                    riderResults.push({ statusId: String(rider.statusId), chance, roll: roll100, hit });
                }
                if (riderResults.length) {
                    try {
                        await appendAttackResult(result.message, {
                            fragment: buildRiderFragment(targetName, riderResults)
                        });
                        for (const r of riderResults) {
                            if (r.hit) await appendAttackResult(result.message, {
                                summaryAdd: { label: statusLabelById(r.statusId), kind: "status" }
                            });
                        }
                    } catch (err) {
                        console.warn(`${MODULE} | cast rider fold failed (no defense clause)`, err);
                    }
                }
            }
        }

        /* ── Persistent zone create ──────────────────────────────────
         * When the item has `areaPersist:true` AND placement was
         * captured earlier (pickAreaSnapshot returned a snapshot),
         * write a scene-embedded MeasuredTemplate with the full zone
         * payload (rider list with resolved staScale magnitudes,
         * roundsRemaining, exclude-caster gate, tangibility, damage
         * config). The zone engine's updateToken diff handles entry/
         * exit AE apply/strip from here on; combatRound ticks down
         * roundsRemaining and deletes the template at expiry.
         *
         * Skipped when narrative:true or the placement was cancelled. */
        if (isPersistentZone && _zonePlacement && result?.message) {
            try {
                await createZoneTemplate({
                    actor:       this,
                    item,
                    castContext,
                    placement:   _zonePlacement,
                    staSpent:    staToSpend,
                    message:     result.message
                });
            } catch (err) {
                console.warn(`${MODULE} | zone template create failed`, err);
            }
        }

        /* ── Authored-AE apply ──────────────────────────────────────
         * When `system.castsAuthoredAE: true`, deep-clone each of the
         * item's embedded ActiveEffects onto every hit target (or
         * onto the caster for self-buffs). This is the idiomatic
         * Foundry authoring path for simple stat/skill buffs
         * (Sharpen Senses +N Awareness, Glamour +3 to social skills,
         * Freya's Bravery temp HP + fear immunity).
         *
         * Target resolution:
         *   targetType "self" → caster
         *   targetType "area" or "direct" → each hit target (from
         *      perTarget / _defenderCandidates)
         *   No hits AND no self → skip
         *
         * Duration: the item's `duration` field is stamped on each
         * cloned AE (if it has no explicit duration of its own).
         * A source-tracking flag `flags.<systemId>.castMarker: true`
         * is added so cleanups (recast, dispel) can find them. */
        if (!isNarrative && !isRitual && item.system?.castsAuthoredAE
            && Array.isArray(item.effects) && item.effects.contents?.length) {
            const targetType = String(item.system?.targetType ?? "direct");
            const recipients = new Set();
            if (targetType === "self") {
                recipients.add(this);
            } else if (_willPrompt) {
                /* Use the per-target verdict block (only exists when
                 * a defense contest ran). Hit targets receive; miss
                 * targets don't. */
                for (const t of (castContext?.targets ?? [])) {
                    if (t?.hit !== true) continue;
                    const a = await fromUuid(t.uuid).catch(() => null);
                    if (a) recipients.add(a);
                }
            } else {
                /* No defense contest ran — treat every candidate as
                 * a hit (matches the auto-hit rider apply block's
                 * philosophy for defense-less spells). */
                for (const a of _defenderCandidates) recipients.add(a);
            }
            if (recipients.size) {
                const authoredEffects = item.effects.contents.map(e => e.toObject());
                const itemDuration = durationToEffect(item);
                for (const targetActor of recipients) {
                    const payloads = authoredEffects.map(src => {
                        const cloned = foundry.utils.duplicate(src);
                        delete cloned._id;
                        /* Only stamp the spell's duration when the AE
                         * doesn't carry its own. GMs who want a
                         * different duration author it directly on
                         * the AE. */
                        const hasOwnDur = cloned.duration && (
                            (cloned.duration.rounds ?? 0) > 0
                            || (cloned.duration.seconds ?? 0) > 0
                            || (cloned.duration.turns ?? 0) > 0
                        );
                        if (!hasOwnDur && itemDuration) cloned.duration = itemDuration;
                        cloned.origin = this.uuid;
                        cloned.transfer = false;
                        cloned.flags = cloned.flags ?? {};
                        cloned.flags[MODULE] = {
                            ...(cloned.flags[MODULE] ?? {}),
                            castMarker: true,
                            sourceItem: item.uuid,
                            sourceCaster: this.uuid,
                            castMessage: result?.message?.uuid ?? null
                        };
                        return cloned;
                    });
                    try {
                        await targetActor.createEmbeddedDocuments("ActiveEffect", payloads);
                    } catch (err) {
                        console.warn(`${MODULE} | authored-AE apply failed on ${targetActor.name}`, err);
                    }
                }
            }
        }

        /* ── Handler onAfterRoll hook ────────────────────────────────
         * Fires after the verdict block, rider apply, and zone create.
         * Handler may append additional card fragments, spawn linked
         * messages, stamp secondary flags (e.g., Empower stamping a
         * `wr.empowerNext` flag on the caster). No-op when the item
         * has no `mechanicHandler` id. */
        if (!isRitual && result?.message) {
            try {
                await invokeSpellHook(item, "onAfterRoll", {
                    actor: this, item, castContext,
                    message: result.message, result, decl
                });
            } catch (err) {
                console.warn(`${MODULE} | handler onAfterRoll failed`, err);
            }
        }

        // Side effects, post-roll: spend STA (spell + adrenaline), debit
        // adrenaline pool, bank Chaos (spell STA only), consume components,
        // register the auto-expiring duration effect. Both STA components go
        // through spendStamina so the satiety-burn + 0-STA-stun downstream
        // hooks see the full spend, but Chaos only tracks the spell's own
        // STA — adrenaline doesn't count against Vigor (see over-exertion
        // block above for the same ruling).
        if (totalStaSpend) await this.spendStamina(totalStaSpend, { reason: "cast" });
        if (adrenalineDice > 0) {
            const cur = Number(this.system?.adrenaline?.value) || 0;
            await this.update({ "system.adrenaline.value": Math.max(0, cur - adrenalineDice) });
        }
        if (!isRitual && staToSpend) await this._commitChaos(staToSpend);
        // Elemental fumble keys off the spell's school; hexes (no school) and
        // anything else fall back to "mixed" (GM picks the rider).
        if (over > 0) await this._applyOverExertion(over, item.system?.school || "mixed");
        await this._applyComponents(plan);
        await this._applyCastDuration(item, durText);

        // Rituals always take their whole prep time (full round); a spell/hex
        // with a multi-action casting time also locks the turn.
        const fullRound = isRitual || (Number(item.system?.castingTime) || 0) > 1;
        return { item, fullRound, result };
    }

    /** Human-readable duration ("3 Rounds", "Permanent"). Kept here so the card
     *  text matches the dialog's info box. */
    _durationText(item) {
        const dur = item.system?.duration;
        if (!dur || !dur.unit) return "";
        const units = item.type === "hex" ? HEX_DURATION_UNITS
                    : item.type === "ritual" ? RITUAL_DURATION_UNITS
                    : SPELL_DURATION_UNITS;
        const unitLabel = L(units[dur.unit] ?? dur.unit);
        const val = String(dur.value ?? "").trim();
        return (!val || val === "0") ? unitLabel : `${val} ${unitLabel}`;
    }
};
