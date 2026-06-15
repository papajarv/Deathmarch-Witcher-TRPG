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
import { openCastDialog } from "../../applications/castDialog.mjs";
import {
    CAST_SKILL_BY_TYPE, SPELL_DEFENSES, HEX_DEFENSES, HEX_DANGER,
    SPELL_DURATION_UNITS, HEX_DURATION_UNITS, RITUAL_DURATION_UNITS,
    EXTRA_ACTION, drainHp
} from "../../setup/config.mjs";
import { triggerElementalFumble } from "../../chrome/chrome/fumble-dialog.js";

/** Over-exertion costs 5 HP per STA point poured past Vigor in one round. */
const OVER_EXERT_PER_POINT = 5;

const MODULE = "witcher-ttrpg-death-march";
const esc    = (s) => Handlebars.escapeExpression(String(s ?? ""));
const signed = (n) => `${n >= 0 ? "+" : ""}${n}`;
const L      = (k) => game.i18n.localize(k);
const F      = (k, d) => game.i18n.format(k, d);

/* Signs (witcher) cap at 7 STA per cast (Core p.115). */
const SIGN_STA_CAP = 7;

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

    /** The round id used to bucket cumulative Chaos (STA spent on magic). Null
     *  out of combat, where there's no round to accumulate across. */
    _castRoundKey() {
        const c = game.combat;
        return c?.started ? c.round : null;
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

        // Governing magic skill (all WILL-based): spell→spellcast, hex→hexweave,
        // ritual→ritcraft. Read its post-prepare total for the base to-hit.
        const skillKey = CAST_SKILL_BY_TYPE[item.type];
        const sv = this._readSkillValues(skillKey);
        const baseTotal = sv?.total ?? 0;
        const focus = this._castFocus();

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

        const decl = await openCastDialog(this, item, {
            base: { total: baseTotal, chips: baseChips }, focus, extraPenalty
        });
        if (!decl) return null;   // player cancelled

        // What this cast spends. Rituals roll vs a DC and pay their fixed model
        // cost; spells / hexes spend the dialog amount. Signs are hard-capped at
        // SIGN_STA_CAP here regardless of what the dialog returned.
        let staToSpend = isRitual
            ? Math.max(0, Number(item.system?.staminaCost) || 0)
            : Math.max(0, Number(decl.staSpend) || 0);
        let signCapped = !!decl.signCapped;
        if (isSign && staToSpend > SIGN_STA_CAP) { staToSpend = SIGN_STA_CAP; signCapped = true; }

        // Refuse the cast if the pool can't cover it — don't roll, don't spend.
        if (staToSpend > this._sta.value) {
            ui.notifications?.warn(L("WITCHER.Cast.NoStamina"));
            return null;
        }

        // To-cast total: base skill + extra-action penalty + the dialog's other
        // modifier. Rituals roll against the declared DC.
        const grandMod = baseTotal + extraPenalty + (Number(decl.otherMod) || 0);
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

        const result = await extendedRoll(
            formula,
            { speaker: ChatMessage.getSpeaker({ actor: this }), flavor },
            dc != null ? { threshold: dc } : {}
        );

        // Side effects, post-roll: spend STA, bank Chaos, consume components,
        // and register the auto-expiring duration effect.
        if (staToSpend) await this.spendStamina(staToSpend, { reason: "cast" });
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
