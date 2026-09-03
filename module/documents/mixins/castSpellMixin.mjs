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
import { resolveEnhancements } from "../../data/item/templates/enhancementDerivation.mjs";
import {
    CAST_SKILL_BY_TYPE, SPELL_DEFENSES, HEX_DEFENSES, HEX_DANGER,
    SPELL_DURATION_UNITS, HEX_DURATION_UNITS, RITUAL_DURATION_UNITS,
    EXTRA_ACTION, drainHp,
    getActiveWeaponQualities, WEAPON_QUALITIES, equippedArmorHasQualityLabeled
} from "../../setup/config.mjs";
import { triggerElementalFumble } from "../../chrome/chrome/fumble-dialog.js";
import { hasWRPerk } from "../../api/witcherReborn.mjs";
import { requestDefenseFromOwner, emitApplyStatus, emitApplyAuthoredEffects } from "../../setup/socketHook.mjs";
import { appendAttackResult } from "./weaponAttackMixin.mjs";
import { getActorTargets } from "../../chrome/chrome/context-menu-actor.js";
import { pickAreaTargets, pickAreaSnapshot, AREA_CANCELLED } from "../../mechanics/castArea.mjs";
import { beginWeaponTargeting, isTileTargetingEnabled } from "../../policy/weapon-target-overlay.mjs";
import { invokeSpellHook, resolveRiderFlags } from "../../mechanics/spellHandlers.mjs";
import { hrExtraActionToHit } from "../../mechanics/house-rules-config.mjs";
import { resolveRiderChance } from "../../mechanics/staScale.mjs";
import { hasAuthoredTrees } from "../../magic/summary.mjs";
import { createZoneTemplate } from "../../mechanics/zoneEffects.mjs";

import { t, tFormat } from "../../chrome/lib/i18n.js";
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
 *  null for instant / permanent / lifted (nothing to auto-expire).
 *
 *  Rounds-based durations get EMITTED AS SECONDS (rounds × roundTime), NOT
 *  as `{rounds: N}`. Foundry v14's `ActiveEffect#_prepareCombatBasedDuration`
 *  (see foundry_copy client/documents/active-effect.mjs:437) has a bug
 *  where it checks `combat === start.combat` — comparing a Combat OBJECT
 *  to the stored id STRING. That comparison is always false, so it
 *  ignores `start.round` (correctly set to the cast round on preCreate)
 *  and falls back to `combatant.roundJoined`, which is the round the
 *  combatant JOINED combat — typically round 1 for pre-existing PCs.
 *  Net effect: an AE with `{rounds: 6}` cast at round X displays a
 *  `remaining` of `6 - (X - 1)` — a Yrden cast in round 2 reads "5 r"
 *  the moment it's applied instead of the expected "6 r".
 *
 *  Emitting as `{seconds: N × roundTime}` routes the AE through
 *  `_prepareTimeBasedDuration` instead, which uses `start.time`
 *  (correctly stamped on preCreate) with no combat-object comparison
 *  bug. The dock's status renderer (dock-statuses.js) already converts
 *  a seconds-based AE back to a "N r" label whenever combat is active
 *  and `CONFIG.time.roundTime` is set, so the visible label is
 *  identical to what a rounds-based AE would show — just correct. */
/** Resolve a spell duration value that may be a flat number OR a dice
 *  formula ("1d6", "2d10+1"). Non-formula values pass straight through;
 *  formulas roll synchronously. Returns 0 on empty / unparseable. */
function rollDurationValue(raw) {
    const s = String(raw ?? "").trim();
    if (!s) return 0;
    if (/^\d+$/.test(s)) return Number(s);
    try { return Math.max(0, Math.floor(Number(new Roll(s).evaluateSync().total) || 0)); }
    catch (_) { return Number(s) || 0; }
}

/** `overrideValue` lets the caller roll the (possibly dice) duration ONCE
 *  per cast and reuse it across every AE so they all expire together. */
function durationToEffect(item, overrideValue = null) {
    const dur = item.system?.duration;
    if (!dur || !dur.unit) return null;
    const value = overrideValue != null ? (Number(overrideValue) || 0) : rollDurationValue(dur.value);
    if (value <= 0) return null;
    switch (dur.unit) {
        case "rounds": {
            const rt = Number(CONFIG?.time?.roundTime) || 6;
            return { seconds: value * rt };
        }
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
function castFlavor({ actorName, itemName, subtitle, chips = [], rows = [], warn = "", effect = "", hitLocation = null }) {
    /* Promoted out of the chip row, exactly as `attackRollFlavor` does it —
     * same class names, same bullseye, same shape — because a spell that hits
     * the head and a sword that hits the head are the same fact and should not
     * read as two different kinds of card. */
    const hitLocHtml = hitLocation?.label
        ? `<div class="wdm-attack-hit-loc"><i class="fa-solid fa-bullseye"></i>` +
              `<span class="wdm-attack-hit-loc-k">${esc(t("WITCHER.Doc.WeaponAttackMixin.Text.HitLocation", "Hit Location"))}</span>` +
              `<span class="wdm-attack-hit-loc-v">${esc(hitLocation.label)}</span>` +
              (hitLocation.multLabel ? `<span class="wdm-attack-hit-loc-mult">${esc(hitLocation.multLabel)}</span>` : "") +
          `</div>`
        : "";
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
            ${hitLocHtml}
            ${infoHtml}
            ${warnHtml}
            ${effectHtml}
        </div>`;
}

export const castSpellMixin = (Base) => class extends Base {

    /** Every equipped item the caster may cast a spell THROUGH — any weapon,
     *  armor, or Focus item carrying the Focus and/or Greater Focus quality
     *  (base OR granted by a socketed rune/glyph). Empty unless one of the
     *  caster's professions has "Can Use Foci" enabled. Each entry carries the
     *  item's Focus value (STA-cost reduction) and Greater Focus value
     *  (spellcasting-roll bonus). Reads `effective.qualities`/`qualityValues`
     *  (falling back to base) so both hand-set and enhancement-granted foci
     *  count. The caster selects ONE at cast time (see openCastDialog). */
    _availableFoci() {
        const canUse = (this.items ?? []).some(i => i.type === "profession" && i.system?.canUseFoci);
        if (!canUse) return [];
        const out = [];
        for (const it of this.items) {
            if (!it.system?.equipped) continue;
            const quals = it.system?.effective?.qualities ?? it.system?.qualities ?? [];
            const hasFocus   = Array.isArray(quals) && quals.includes("focus");
            const hasGreater = Array.isArray(quals) && quals.includes("greaterFocus");
            if (!hasFocus && !hasGreater) continue;
            const vals = it.system?.effective?.qualityValues ?? it.system?.qualityValues ?? {};
            /* Each value counts ONLY when its quality is actually toggled on —
             * a filled param field with the quality UNchecked must not apply
             * (e.g. a Focus item with a Greater Focus value but no Greater
             * Focus quality gives no roll bonus). */
            out.push({
                id:           it.id,
                name:         it.name,
                focus:        hasFocus   ? Math.max(0, Number(vals.focus) || 0)        : 0,
                greaterFocus: hasGreater ? Math.max(0, Number(vals.greaterFocus) || 0) : 0
            });
        }
        return out;
    }

    /** Worn-armor glyphs whose element matches the spell's school. Each equipped
     *  armor piece's socketed glyph enhancements are resolved; a glyph counts
     *  when its `element` equals the spell `school`. Every matching glyph grants
     *  an INDEPENDENT, stacking cast bonus — at cast the player picks, per glyph,
     *  +3 to the roll OR +1d6 to the spell's effect magnitude (see openCastDialog). */
    _matchingGlyphs(school) {
        const sc = String(school ?? "");
        if (!sc || sc === "none") return [];
        const out = [];
        for (const it of (this.items ?? [])) {
            if (it.type !== "armor" || !it.system?.equipped) continue;
            const glyphs = resolveEnhancements(it.system?.appliedEnhancements)
                .filter(e => e?.system?.type === "glyph"
                          && String(e.system?.element ?? "") === sc);
            for (const g of glyphs) {
                out.push({ name: g.name || it.name, element: sc, armor: it.name });
            }
        }
        return out;
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
        /* Only bucket chaos across rounds when THIS actor is actually a
         * combatant in the active combat. A caster who ISN'T in the fight has
         * no "round" to accumulate against — each of their casts stands alone —
         * so a combat running elsewhere must not make their vigor read as
         * depleted / trigger over-exertion across successive casts. Mirrors the
         * `_inActiveCombat` gate every other per-round budget check uses. */
        if (!this._inActiveCombat) return null;
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
     *  of combat (single casts are judged on their own there), and no-op under
     *  Free-Actions override — Chaos budgeting is a per-round "how much magic
     *  can you burn before over-exertion" gate, and Free Actions bypasses
     *  every per-round gate for consistency with actions / movement / defense. */
    async _commitChaos(spent) {
        if (this._freeActionsMode) return;
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
     *  leaves target effects to the GM; this just tracks that the cast is live.
     *  When `zoneTemplateUuid` is supplied (persistent-zone casts like Yrden),
     *  we tag the AE with that UUID so `stripZoneAEsForTemplate` in
     *  zoneEffects.mjs deletes the marker together with the template. Without
     *  the tag the marker would ride its own duration and outlive (or, if
     *  worldTime doesn't advance, orphan) the zone. */
    async _applyCastDuration(item, durText, zoneTemplateUuid = null) {
        const duration = durationToEffect(item);
        if (!duration) return false;
        try {
            const wdmFlags = { castMarker: true, sourceItem: item.uuid };
            /* Stamp `zoneTemplate` for persistent-zone casts so the
             * WitcherActiveEffect `_prepareDuration` override reads
             * the template's `roundsRemaining` for the marker's
             * display. This ALSO makes the strip pipeline delete
             * the marker when the template dies, AND makes our
             * `onDeleteActiveEffect` hook fire template delete when
             * the marker is manually removed. Two-way binding. */
            if (zoneTemplateUuid) wdmFlags.zoneTemplate = zoneTemplateUuid;
            await this.createEmbeddedDocuments("ActiveEffect", [{
                name: item.name,
                img: item.img,
                duration,
                description: durText ? `${item.name} — ${durText}` : item.name,
                statuses: [],
                flags: { [MODULE]: wdmFlags }
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

    /**
     * Everything that happens BEFORE a cast rolls: gather the caster's skill,
     * their foci and matching glyphs, work out the extra-action penalty, and
     * open the cast dialog.
     *
     * Extracted so the block engine uses the SAME declaration this path always
     * has. It was building its own stamina prompt, which meant a spell on the
     * new engine silently lost adrenaline, Focus discounts, Greater Focus roll
     * bonuses and glyph elements — every one of them a rule somebody had
     * already implemented here.
     *
     * Returns the dialog's declaration, or null if the caster backed out.
     */
    async declareCast(item, { skillKey, isRitual = false, aimable = null, reach = null, facts = null } = {}) {
        const sv = this._readSkillValues(skillKey);
        const baseTotal = sv?.total ?? 0;
        // Spellcasting foci the caster may cast through (empty unless a
        // profession has Can Use Foci). The dialog shows a picker; the chosen
        // focus's Focus value reduces STA and its Greater Focus value adds to
        // the roll. Rituals roll vs a DC, not through a focus, so skip.
        const foci = isRitual ? [] : this._availableFoci();

        // Worn-armor glyphs matching this spell's element (school). Each grants
        // a stacking choice at cast: +3 roll OR +1d6 to the spell's effect
        // magnitude. `spellHasMagnitude` gates the +1d6 option — a utility spell
        // with no damage/heal/shield output can only take the +3.
        const glyphs = this._matchingGlyphs(item.system?.school);
        /* An AUTHORED spell keeps its magnitude in a block, not in
         * `system.damageFormula` — that field is empty for every spell built in
         * the canvas or loaded from the book. Reading only the legacy field
         * meant `spellHasMagnitude` was false for all of them, so the glyph's
         * "+1d6 to the effect" option was never offered.
         *
         * Asked of `dialogFacts`, which is the ONE thing that reads a tree to
         * decide what the dialog should show. This was an inline walk here and
         * was on its way to being several. */
        const { dialogFactsFor } = await import("../../magic/dialogFacts.mjs");
        const treeFacts = facts ?? dialogFactsFor(item.system ?? {});
        const spellHasMagnitude = !!(
            String(item.system?.damageFormula ?? "").trim()
            || String(item.system?.damageType ?? "") === "shieldHp"
            || treeFacts.hasMagnitude
        );

        // Extra action (Core p.151): when the caster has already spent their
        // normal action this turn, the cast rides the extra action and takes
        // its −3 to-hit (the 3-STA cost is charged by the dock's action
        // economy). Rituals are full-round, never an extra action. Mirrors the
        // weapon attack's extra-action handling so casts (Aard, etc.) match.
        const extraAction  = !isRitual && this.nextActionSlot === "extra";
        let   extraPenalty = extraAction ? hrExtraActionToHit() : 0;
        // Versatile (armor): the extra-action penalty is −2 instead of −3 when
        // this cast is a DIFFERENT action than the previous one this turn (a
        // spell after an attack, etc.). Compares the last recorded action label
        // with this cast's label.
        if (extraAction && extraPenalty < 0 && equippedArmorHasQualityLabeled(this, "Versatile")) {
            const last = String(this.system?.combatRound?.actionLabel ?? "").trim().toLowerCase();
            const cur  = `cast: ${String(item.name ?? "").trim().toLowerCase()}`;
            if (last && last !== cur) extraPenalty = Math.min(0, extraPenalty + 1);
        }

        // Read-only skill chips shown at the top of the dialog + card.
        const baseChips = sv ? [
            { label: statName(sv.meta.statKey), value: sv.statVal },
            { label: t("WITCHER.Common.Rank", "Rank"), value: sv.skillVal },
            sv.skillMod ? { label: t("WITCHER.Common.Mod", "Mod"), value: signed(sv.skillMod) } : null
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
            base: { total: baseTotal, chips: baseChips }, foci, glyphs, spellHasMagnitude, extraPenalty,
            /* `null` means nobody worked it out — the legacy path, which has no
             * template step to work it out FROM. There the old behaviour holds
             * and a damaging spell may be aimed. An explicit `false` is the
             * frame saying "not from here". */
            aimable, aimReach: reach, facts: treeFacts,
            extraFields: dialogContext.extraFields
        });
        return decl;
    }

    async castSpell(item, { forceTarget = null } = {}) {
        if (!item || !["spell", "hex", "ritual"].includes(item.type)) return null;

        /* AUTHORED SPELLS take the block engine instead.
         *
         * Routed here rather than at each of the four call sites — the
         * character sheet, the monster sheet, the chrome sheet and the dock —
         * so there is one decision and no chance of three of them agreeing
         * while the fourth quietly does not.
         *
         * An item with no authored trees falls straight through to the
         * original path, unchanged. That is the whole migration strategy: the
         * two engines run side by side, per item, and rolling one spell back
         * is deleting its trees rather than reverting a release on a Friday
         * night with four players waiting. */
        if (hasAuthoredTrees(item.system)) {
            const { castAuthored } = await import("../../magic/cast.mjs");
            return castAuthored(this, item, { forceTarget });
        }

        /* `forceTarget` — an explicit single-target Actor routed in by the
         * canvas tile-targeting overlay (dock spell button). Bypasses
         * game.user.targets so a ranged single-target spell no longer needs
         * to set (and leave) a Foundry target-lock / chevron on the victim.
         * Ignored by AoE-template / narrative / ignore-target spells, which
         * resolve their own targets. */
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
        /* True when the spell's authored areaShape maps to a Foundry
         * MeasuredTemplate (cone/radius/cube/line). AoE spells always
         * draw the template — reticled tokens are discarded regardless
         * of the item's ignoreTargets flag. Single-target shapes
         * (none/touch/self) keep the existing reticle-based flow. */
        const _hasAreaShape = ["cone", "radius", "cube", "line"]
            .includes(String(item.system?.areaShape ?? "none"));
        const _forceTemplate = _hasAreaShape && !isRitual && !isNarrative;

        /* ── AIM BEFORE ASKING ────────────────────────────────────────────
         * The template is placed FIRST, then the cast dialog opens.
         *
         * It used to run the other way: you committed to the cast, chose how
         * much Stamina to pour in, and only then were asked where to point it.
         * That is backwards — you aim a spell and then decide how hard to throw
         * it — and it also left the dialog unable to answer questions that
         * depend on where the spell landed, such as whether anyone caught by it
         * is close enough for a called shot.
         *
         * Cancelling the template still aborts the whole cast before anything
         * is spent, exactly as before; cancelling the dialog still aborts after
         * the aim, costing nothing. The authored engine orders its stages the
         * same way (see STAGES in magic/frame.mjs), so both paths behave alike.
         */
        /* `ignoreTargets` on the spell: user-picked reticles are
         * DISCARDED and only the AoE template harvest below decides
         * who gets hit. Used for signs (Yrden, Aard, Igni) and any
         * zone/blast where the template IS the intent. Requires the
         * area-harvest branch to fire, so we start with an empty
         * candidate pool; the fallback below only runs when the pool
         * is empty AND the shape maps to a Foundry template. */
        const _ignoreTargets = !!item?.system?.ignoreTargets;
        /* _forceTemplate joins the skip list: any AoE-shape spell (cone/
         * radius/cube/line) must draw the template regardless of what the
         * user has reticled, so the pool starts empty and the area-harvest
         * branch below fires. Non-AoE shapes (none/touch/self) still take
         * reticled targets. */
        const _tokenTargets = (isNarrative || _ignoreTargets || _forceTemplate) ? []
            : forceTarget ? [forceTarget]
            : Array.from(game.user?.targets ?? [])
                .map(t => t?.actor)
                .filter(Boolean);
        let _candidatePool = _tokenTargets.slice();
        /* Placement snapshot captured for a persistent-zone cast —
         * passed to `createZoneTemplate` after the roll settles so
         * the scene gets a native zone RegionDocument (Stage 2b) with
         * the caster's aimed orientation. Null for one-shot AoEs and
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
        if (!isNarrative && !_candidatePool.length && !isRitual && _hasAreaShape) {
            try {
                if (isPersistentZone) {
                    const snap = await pickAreaSnapshot({ actor: this, item });
                    /* Right-click / Esc on the template preview aborts the WHOLE
                     * cast — no roll, no STA, no action spent. (A guard-bail /
                     * setup-fail returns non-sentinel falsy and falls through to
                     * a plain cast; only the explicit cancel returns the sentinel.) */
                    if (snap === AREA_CANCELLED) return null;
                    if (snap) {
                        _zonePlacement = snap.placement;
                        if (Array.isArray(snap.actors) && snap.actors.length) {
                            _candidatePool = snap.actors;
                        }
                    }
                } else {
                    const harvested = await pickAreaTargets({ actor: this, item });
                    if (harvested === AREA_CANCELLED) return null;   // cancelled → abort
                    if (Array.isArray(harvested) && harvested.length) _candidatePool = harvested;
                }
            } catch (err) {
                console.warn(`${MODULE} | area harvest failed`, err);
            }
        }

        // Governing magic skill (all WILL-based): spell→spellcast, hex→hexweave,
        // ritual→ritcraft. Read its post-prepare total for the base to-hit.
        const skillKey = CAST_SKILL_BY_TYPE[item.type];
        /* Now that the template has landed we know who it caught and how far
         * away they are, so the dialog can be told whether a called shot is on
         * offer — the same question the authored engine answers in `declare`. */
        const { dialogFactsFor } = await import("../../magic/dialogFacts.mjs");
        const _facts = dialogFactsFor(item.system ?? {});
        let _reach = null;
        {
            const from = this.getActiveTokens?.()?.[0] ?? null;
            for (const target of _candidatePool) {
                const to = target?.getActiveTokens?.()?.[0] ?? null;
                if (!from || !to) continue;
                try {
                    const d = canvas.grid.measurePath([from.center, to.center]).distance;
                    _reach = _reach == null ? d : Math.min(_reach, d);
                } catch (_) { /* no canvas — leave it unknown */ }
            }
        }
        /* A spell with no aiming block is never aimable; one with nothing in
         * reach is not aimable right now. `null` reach (theatre of mind) leaves
         * the decision to the dialog's own default. */
        const _aimable = _facts.aims && _reach != null && _reach <= _facts.aimWithin;

        const decl = await this.declareCast(item, {
            skillKey, isRitual,
            aimable: _reach == null ? null : _aimable,
            reach: _reach, facts: _facts
        });
        if (!decl) return null;   // player cancelled

        // Greater Focus roll bonus from the focus the caster chose in the
        // dialog (0 when they picked "none" or have no foci). Added to the cast
        // roll below, shown as its own chip.
        const spellDCBonus = Math.max(0, Number(decl.focusGreater) || 0);

        // Glyph bonuses the caster claimed in the dialog: +3 per glyph routed to
        // the roll, and a count of glyphs routed to +1d6 effect magnitude
        // (folded into the damage formula / shield HP grant below).
        const glyphRollBonus     = Math.max(0, Number(decl.glyphRollBonus) || 0);
        const glyphMagnitudeDice = Math.max(0, Number(decl.glyphMagnitudeDice) || 0);

        /* Range gate — enforced ONLY when both caster and target have
         * tokens on the canvas. Theatre-of-mind (no tokens) skips the
         * check entirely per user spec. When enforcement fires and the
         * measured distance exceeds the spell's range, refuse the cast
         * BEFORE any STA / adrenaline is debited. No dialog banner —
         * just a ui.notifications.warn (same UX as the ranged weapon
         * out-of-range flow).
         *
         * `ignoreTargets` spells skip this check entirely: the user's
         * reticled tokens aren't the intended victims — the AoE template
         * dropped later determines who gets hit, so measuring caster→
         * reticle distance is meaningless (and was blocking legitimate
         * casts of Yrden / Aard / Igni whenever any distant token was
         * targeted for unrelated reasons). */
        if (!isRitual && !item?.system?.ignoreTargets && !_forceTemplate) {
            const spellRangeM = parseRangeMeters(item);
            const rangeIsFinite = Number.isFinite(spellRangeM) && spellRangeM !== Infinity && spellRangeM >= 0;
            const aTok = this?.getActiveTokens?.()?.[0] ?? null;
            const dTok = forceTarget?.getActiveTokens?.()?.[0]
                ?? Array.from(game.user?.targets ?? [])[0] ?? null;
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
                    ui.notifications?.warn(tFormat(
                        "WITCHER.Doc.CastSpellMixin.Notify.OutOfRange",
                        { item: item.name, distance: Math.round(distanceMeters), max: spellRangeM },
                        "{item} — target is {distance}m away, out of range (max {max}m)."
                    ));
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
        // `spendable` folds in the temp-STA house-rule buffer (spent first).
        if (totalStaSpend > this._sta.spendable) {
            ui.notifications?.warn(L("WITCHER.Cast.NoStamina"));
            return null;
        }
        /* Refuse the cast if the adrenaline pool can't cover the picked dice. */
        if (adrenalineDice > 0 && adrenalineDice > (Number(this.system?.adrenaline?.value) || 0)) {
            ui.notifications?.warn(tFormat("WITCHER.Doc.CastSpellMixin.Notify.NotEnoughAdrenalineXNeeded", { adrenalineDice: adrenalineDice }, "Not enough adrenaline ({adrenalineDice} needed)."));
            return null;
        }

        /* To-cast total: base skill + extra-action penalty + the dialog's other
         * modifier + Greater Focus + glyphs + any called-shot penalty. Rituals
         * roll against the declared DC.
         *
         * TAKEN FROM THE DECLARATION rather than recomputed. This line used to
         * add `baseTotal + extraPenalty`, and BOTH of those are `const`s inside
         * `declareCast` — a different method. Every legacy (non-block) spell
         * therefore threw `baseTotal is not defined` the moment it got past the
         * dialog. Authored spells never hit it because `castSpell` hands them
         * to `castAuthored` and returns long before this line.
         *
         * The dialog already computes exactly this sum and returns it, which is
         * also what the authored path reads (`ctx.declaration.grandMod`), so
         * using it makes the two engines agree by construction instead of by
         * two copies of the same arithmetic. */
        const grandMod = Number.isFinite(Number(decl.grandMod))
            ? Number(decl.grandMod)
            : (Number(decl.otherMod) || 0) + spellDCBonus + glyphRollBonus;
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
        /* Same scope problem, cosmetic half: the dialog reports what it charged. */
        const extraPenalty = Number(decl.extraPenalty) || 0;
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
            ...(Array.isArray(decl.baseChips) ? decl.baseChips : []),
            extraPenalty ? { label: L("WITCHER.Attack.ExtraAction"), value: signed(extraPenalty) } : null,
            spellDCBonus ? { label: t("WITCHER.Doc.CastSpellMixin.Dialog.Button.GreaterFocus", "Greater Focus"), value: signed(spellDCBonus) } : null,
            glyphRollBonus ? { label: t("WITCHER.Cast.Glyph", "Glyph"), value: signed(glyphRollBonus) } : null,
            glyphMagnitudeDice ? { label: t("WITCHER.Cast.Glyph", "Glyph"), value: `+${glyphMagnitudeDice}d6` } : null,
            !isRitual && staToSpend ? { label: L("WITCHER.Cast.StaCost"), value: staToSpend } : null,
            decl.otherMod ? { label: L("WITCHER.Cast.OtherMod"), value: signed(decl.otherMod) } : null,
            dc != null ? { label: L("WITCHER.Cast.DC"), value: dc } : null
        ].filter(Boolean);

        /* Only a CALLED shot is worth a block of its own — "random" is the
         * default and saying so on every card is noise. */
        const declLoc = decl?.location ?? null;
        const hitLocation = declLoc?.mode === "specific"
            ? { label: declLoc.label,
                multLabel: (declLoc.mult && declLoc.mult !== 1) ? `×${declLoc.mult}` : "" }
            : null;

        const flavor = castFlavor({
            actorName: this.name,
            itemName:  item.name,
            subtitle,
            chips,
            rows,
            warn,
            effect: item.system?.effect ?? "",
            hitLocation
        });

        /* Structured cast envelope stamped on the chat message. Riders
         * subscribe to (actor, item, kind, isDamaging) and inject their
         * buttons on the card by reading this. `damage.rolled` is null
         * at stamp time — the rider that opens the damage flow rolls it.
         * `targets[i].defenseTotal / hit` are filled in by the defense
         * resolution downstream. Kept intentionally lean: only include
         * fields that riders actually need to make decisions. */
        /* Never include the caster in the manual/direct target list — a direct
         * attack targeting an enemy must not also splash the caster (castDamage
         * falls through on hit:null for un-resolved entries). Self-cast is
         * handled separately via targetType==="self"; caster-inside-AoE is a
         * template-harvest concern, not a manual-target one. */
        const targetsList = forceTarget
            ? ((forceTarget.uuid && forceTarget.uuid !== this.uuid)
                ? [{ uuid: forceTarget.uuid, defenseTotal: null, hit: null }] : [])
            : Array.from(game.user?.targets ?? [])
                .map(t => t?.actor?.uuid)
                .filter(uuid => uuid && uuid !== this.uuid)
                .map(uuid => ({ uuid, defenseTotal: null, hit: null }));
        /* "No defence" is represented by an EMPTY array — config.mjs calls it
         * "an empty selection rather than a value". The hex type stores its
         * defence as a String whose enum includes "none", and "none" is
         * TRUTHY, so an unavoidable curse used to produce ["none"]: the
         * defender got a prompt whose gate matched no button, could only
         * "Take it", and resolved at defenseTotal 10 — meaning a curse the
         * book says cannot be defended against MISSED on any cast total of
         * 10 or less. Normalise both shapes to the empty-array convention.
         *
         * "gm" is dropped for a different reason: it means the GM sets the
         * DC (Control Water is the only user), so there is no defender roll
         * to prompt for. Left in, it produced the same phantom DC 10. */
        const rawDefense = item.type === "hex"
            ? (item.system?.defense ? [String(item.system.defense)] : [])
            : (Array.isArray(item.system?.defense) ? [...item.system.defense] : []);
        const defenseArr = rawDefense.filter(d => d && d !== "none" && d !== "gm");
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
                /* Glyph magnitude boost — +Nd6 folded into a damaging/healing
                 * formula. Shield spells (damageType shieldHp) carry no damage
                 * formula; their glyph dice go into the HP grant instead
                 * (see the shieldHp branch below), so skip here. */
                const isShieldSpell = String(item.system?.damageType ?? "") === "shieldHp";
                const withGlyph = (withAdr && glyphMagnitudeDice > 0 && !isShieldSpell)
                    ? `${withAdr} + ${glyphMagnitudeDice}d6`
                    : withAdr;
                const source = [
                    ...(adrenalineDice > 0 && baseFormula
                        ? [{ formula: `${adrenalineDice}d6`, source: "Adrenaline" }] : []),
                    ...(withGlyph !== withAdr
                        ? [{ formula: `${glyphMagnitudeDice}d6`, source: "Glyph" }] : [])
                ];
                return {
                    formula:  withGlyph,
                    rolled:   null,
                    element:  String(decl.damageElement ?? item.system?.damageElement ?? "none"),
                    /* damageType: hp / healHp / sta / ablation / reliability /
                     * shieldHp — where the damage lands. */
                    type:     String(item.system?.damageType ?? "none"),
                    /* applyEvery: instant | turn | minute | hour | day — when
                     * set, the resource effect ticks over the duration via a
                     * synthesized AE instead of applying once on cast. */
                    applyEvery: String(item.system?.applyEvery ?? "instant"),
                    /* bypassArmor: HP damage ignores armour SP entirely (routes
                     * as throughArmor). Independent add-on to the damage type. */
                    bypassArmor: !!item.system?.bypassArmor,
                    /* ablateArmor: OPTIONAL secondary armour ablation applied
                     * ALONGSIDE the main damage (e.g. an acid bolt that deals HP
                     * AND rusts armour). Dice/flat formula string; empty = none.
                     * Distinct from damageType:"ablation" which ablates instead
                     * of dealing HP. */
                    ablateArmor: String(item.system?.ablateArmor ?? "").trim(),
                    /* ablateHitLocationOnly: TRUE = ablate only the struck
                     * location; FALSE (default) = every location (RAW Rusting). */
                    ablateHitLocationOnly: !!item.system?.ablateHitLocationOnly,
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
            /* Preserve `mode`, `stripOnExit`, `staScale` too — the
             * downstream rider fan-outs below both do a
             * `rider.mode !== "onHit"` skip check to keep zone / tick
             * riders from being applied at cast time. Without `mode`
             * on the castContext copy, those checks fell through and
             * a persistent-zone rider (e.g. Yrden's `trapped-in-yrden`)
             * got applied twice: once here via `emitApplyStatus` (with
             * the clause's static magnitude, so no STA scaling), and
             * once from `zoneEffects.mjs` on zone entry (with the
             * scaled magnitude). The visible AE was the static one,
             * making the scaled penalty look "not scaling". */
            statusRiders: Array.isArray(item.system?.statusRiders)
                ? item.system.statusRiders.map(r => ({
                    statusId: String(r?.statusId ?? ""),
                    chance:   Number(r?.chance ?? 100) || 0,
                    duration: {
                        value: String(r?.duration?.value ?? ""),
                        unit:  String(r?.duration?.unit  ?? "instant")
                    },
                    mode:        String(r?.mode ?? "onHit"),
                    stripOnExit: r?.stripOnExit !== false,
                    staScale:    r?.staScale ? {
                        offset:  Number(r.staScale.offset)  || 0,
                        divisor: Number(r.staScale.divisor) || 1,
                        cap:     Number(r.staScale.cap)     || 0
                    } : null,
                    /* Routing of the resolved staScale value at apply time
                     * (see spell.mjs schema for full semantics). The rider
                     * dispatch below reads staScaleTarget to route:
                     * magnitude → clause default, endCheckModifier → AE
                     * flag, duration → override authored duration.value. */
                    staScaleTarget:  String(r?.staScaleTarget ?? "magnitude"),
                    /* Re-cast on same target strips prior AEs of this
                     * statusId first (Axii pattern) — schema replacement
                     * for the retired axiiHandler's stripPriorSource. */
                    refreshOnRecast: r?.refreshOnRecast === true
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
        /* TOUCH spell — melee-range single-target pick, run HERE (after the cast
         * dialog) rather than in the dock, so the overlay sequences the SAME as
         * the area templates above instead of popping before the dialog / card.
         * Uses the identical melee overlay a weapon does. Only fires when nothing
         * is already targeted and tile targeting is on; cancelling casts as-is
         * (no specific target), matching the reticle fallback below. */
        if (!isNarrative && !isRitual && !_candidatePool.length
            && String(item?.system?.areaShape ?? "") === "touch") {
            const casterTok = this.getActiveTokens?.()?.[0] ?? null;
            if (casterTok && isTileTargetingEnabled()) {
                const touchWeapon = { name: item.name, type: "weapon", system: { weaponType: "melee", range: "", qualities: [] } };
                let picked = null;
                try {
                    picked = await new Promise((resolve) => {
                        let settled = false;
                        const done = (v) => { if (!settled) { settled = true; resolve(v); } };
                        beginWeaponTargeting(this, casterTok, touchWeapon, {
                            onPick:   (defActor) => done(defActor ?? null),
                            onCancel: ()         => done(AREA_CANCELLED),
                            /* Magic isn't clinch-locked — cast as normal. */
                            ignoreClinchLock: true
                        }).then((engaged) => { if (!engaged) done(null); })
                          .catch(() => done(null));
                    });
                } catch (err) {
                    console.warn(`${MODULE} | touch target pick failed`, err);
                }
                /* Right-click / Esc on the overlay ABORTS the whole cast — no
                 * roll, no STA, no action spent — exactly like cancelling an
                 * area template. A pick sets the target; only a failure to even
                 * open the overlay (null) falls through to a plain cast. */
                if (picked === AREA_CANCELLED) return null;
                if (picked) _candidatePool = [picked];
            }
        }
        if (!isNarrative && !_candidatePool.length) {
            /* Multi-target aware tokenless fallback — actorTargetUuids
             * carries EVERY combat-tracker targeted actor when no canvas
             * tokens exist. Single-value getActorTarget() would truncate
             * a multi-target set to one.
             *
             * Gate: skip this fallback when a forced-template AoE cast
             * ran in canvas mode and yielded no candidates. Empty pool
             * there means the user either canceled the template preview
             * or placed it and hit nothing — in both cases, falling
             * through to persistent actorTargetUuids would silently hit
             * a stale tokenless target from earlier in the session
             * (e.g. a combatant marked via the tracker context menu
             * hours ago that was never cleared). Cancel/miss should
             * fizzle the cast, not redirect it. Caster-on-canvas is the
             * "canvas mode" signal — matches castArea.mjs's own
             * casterToken gate. */
            const _inCanvasMode = !!(this?.getActiveTokens?.()?.length);
            if (!(_forceTemplate && _inCanvasMode)) {
                try {
                    const tokenless = await getActorTargets();
                    if (Array.isArray(tokenless) && tokenless.length) _candidatePool = tokenless;
                } catch (_) { /* soft-fail — no candidates */ }
            }
        }
        const _seenUuids = new Set();
        let _defenderCandidates = _candidatePool.filter(a => {
            if (!a || a === this) return false;
            if (_seenUuids.has(a.uuid)) return false;
            _seenUuids.add(a.uuid);
            return true;
        });

        /* MAGIC INTERCEPTION — legacy parity with the block frame's `oppose`.
         *
         * Authored spells offer themselves to `incomingMagic` wards inside
         * `frame.mjs`; the legacy path never did, so a defender's negate-magic
         * ward (Demetia's Crest Surge, Heliotrope, any charge shield) could not
         * see a legacy spell and every legacy cast sailed straight through —
         * the ward spent nothing and negated nothing. Offer here, AFTER the
         * defender pool is known and BEFORE the defence prompt so a negated
         * target is never even asked to defend, then drop any target whose ward
         * vetoes it: removing it from `_defenderCandidates` skips its defence,
         * status riders, periodic ticks and authored-AE delivery (all build
         * from this list), and stamping `hit:false` onto its castContext target
         * skips its damage in castDamage. The ward's own element gate
         * (`ifIncomingElement`) decides whether it actually fires, so offering
         * for every spell is safe — a non-matching element spends no charge.
         *
         * MAGIC ONLY: the weapon/melee path (socketHook `offerAttackInterception`)
         * is deliberately untouched. */
        if (_defenderCandidates.length) {
            const _spellElement = item.system?.damageElement || item.system?.school || null;
            const _magicNegated = new Set();
            try {
                const { offerMagicInterception } = await import("../../magic/intercept.mjs");
                const { foundryAdapter } = await import("../../magic/adapter.mjs");
                for (const defender of _defenderCandidates) {
                    try {
                        const verdict = await offerMagicInterception(
                            defender,
                            { element: _spellElement, kind: "spell", name: item.name, casterRoll: null },
                            foundryAdapter(defender, {})
                        );
                        if (verdict?.vetoed) _magicNegated.add(defender.uuid);
                    } catch (err) {
                        console.warn(`${MODULE} | magic interception failed for ${defender?.name}`, err);
                    }
                }
            } catch (err) {
                console.warn(`${MODULE} | magic interception unavailable`, err);
            }
            if (_magicNegated.size) {
                _defenderCandidates = _defenderCandidates.filter(a => !_magicNegated.has(a.uuid));
                for (const tt of (castContext.targets ?? [])) {
                    if (_magicNegated.has(tt.uuid)) tt.hit = false;
                }
            }
        }
        const _engagementId = `castEng-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const _willPrompt = !isRitual
            && defenseArr.length > 0
            && _defenderCandidates.length > 0;
        /* Actors HIT by the cast's defense contest, filled in the verdict loop
         * below. The periodic + authored-AE recipient resolution reads THIS —
         * NOT `castContext.targets`, whose local `hit` field is never stamped
         * (only the message copy gets the verdict). Without it, against-defense
         * ("direct") spells delivered their ticking damage / AEs to nobody. */
        const _hitTargetActors = new Set();
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
                if (isHit) _hitTargetActors.add(targetActor);

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
                    ? `<div class="wdm-attack-defense"><span class="wdm-attack-defense-k">${t("WITCHER.Doc.CastSpellMixin.Text.Defense", "Defense")}</span> <span class="wdm-attack-defense-v"><b>${defenseChoice?.timedOut ? "No response" : "Took the hit"}</b> — DC <b>10</b></span></div>`
                    : `<div class="wdm-attack-defense"><span class="wdm-attack-defense-k">${t("WITCHER.Doc.CastSpellMixin.Text.Defense", "Defense")}</span> <span class="wdm-attack-defense-v"><b>${esc(defActionTitle)}</b> → <b>${defenseTotal}</b></span>${chipRow}</div>`;
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
                        /* Skip zone / onTick riders — they're applied
                         * by zoneEffects.mjs on token entry, not on
                         * cast. Firing them here would double-apply
                         * (once via emitApplyStatus with the clause's
                         * static magnitude, once via applyZoneAE with
                         * the scaled magnitude). Mirrors the guard in
                         * the auto-hit fallback block further down. */
                        if (rider.mode && rider.mode !== "onHit") continue;
                        /* Chance can scale with cast stamina — see
                         * spell.mjs statusRiders.staScaleTarget "chance".
                         * When routed, the resolved value REPLACES the
                         * rider's base chance; otherwise the base wins. */
                        const chance  = resolveRiderChance(rider, castContext?.staSpent);
                        const roll100 = Math.floor(Math.random() * 100) + 1;
                        const hit = roll100 <= chance;
                        if (hit && targetActor) {
                            try {
                                /* Rider flags derived from schema (baseSta /
                                 * maxSta / staScaleTarget / refreshOnRecast)
                                 * or from a legacy custom handler. */
                                const extra = (await resolveRiderFlags(item, {
                                    rider, castContext, targetActor
                                })) ?? {};
                                await emitApplyStatus({
                                    targetUuid:       targetActor.uuid,
                                    statusId:         String(rider.statusId),
                                    action:           "apply",
                                    sourceTangible:   _tangible,
                                    flags:            extra.flags ?? null,
                                    stripPriorSource: extra.stripPriorSource ?? null,
                                    /* Caster is the source — GM relay authorizes a spell
                                     * status onto an enemy the player doesn't own. */
                                    sourceActorUuid:  this.uuid
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
                    /* Chance can scale with cast stamina (see the parallel
                     * dispatch above for the full rationale). */
                    const chance  = resolveRiderChance(rider, castContext?.staSpent);
                    const roll100 = Math.floor(Math.random() * 100) + 1;
                    const hit     = roll100 <= chance;
                    if (hit) {
                        try {
                            const extra = (await resolveRiderFlags(item, {
                                rider, castContext, targetActor
                            })) ?? {};
                            await emitApplyStatus({
                                targetUuid:       targetActor.uuid,
                                statusId:         String(rider.statusId),
                                action:           "apply",
                                sourceTangible:   _tangible,
                                flags:            extra.flags ?? null,
                                stripPriorSource: extra.stripPriorSource ?? null,
                                /* Ride on the cast card so a player casting on
                                 * an enemy they don't own is authorized via
                                 * isLegitimateAttackDamage (the GM relay),
                                 * instead of silently failing authorizeSocket. */
                                attackMessageUuid: result.message?.uuid ?? null,
                                /* Also authorize via caster (source) ownership so it
                                 * lands even if the cast card isn't a stamped attack msg. */
                                sourceActorUuid:   this.uuid
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
        let _zoneTemplateUuid = null;
        if (isPersistentZone && _zonePlacement && result?.message) {
            try {
                const doc = await createZoneTemplate({
                    actor:       this,
                    item,
                    castContext,
                    placement:   _zonePlacement,
                    staSpent:    staToSpend,
                    message:     result.message
                });
                /* Capture the template UUID so the marker AE created by
                 * `_applyCastDuration` below can stamp `zoneTemplate:
                 * uuid` and get stripped when the zone deletes. Without
                 * this the caster keeps a lingering "Yrden" duration
                 * chip on their sheet after the template expires. */
                _zoneTemplateUuid = doc?.uuid ?? null;
            } catch (err) {
                console.warn(`${MODULE} | zone template create failed`, err);
            }
        }

        /* ── Authored-AE apply ──────────────────────────────────────
         * Deep-clone each of the item's embedded ActiveEffects onto every
         * hit target (or onto the caster for self-buffs), gated per effect
         * by its own application chance. This is the idiomatic
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
        /* Persistent-zone spells (`areaPersist: true`) route authored-AE
         * application through the ZONE system in mechanics/zoneEffects.mjs
         * instead of the cast-time hit-target block below. `createZoneTemplate`
         * above captures the item's embedded effects on the template flag
         * (`authoredEffects`), and `onZoneEnter` clones+applies them to every
         * token that enters the shape — at cast time (via
         * `applyEntryToAllTokensInside`) AND for anyone who walks in later.
         * `onZoneExit` and `stripZoneAEsForTemplate` remove them on the way
         * out, on template delete, and on duration expiry.
         *
         * Applying the authored clone here at cast time would double-fire
         * (cast-time hit AND zone-enter both create the same AE) and, worse,
         * bake a stale copy onto the target that our strip pipeline can't
         * remove (no `zoneTemplate` linkage was possible before the template
         * was placed). Route ALL persistent-zone effect application through
         * the zone system so enter/exit is authoritative. */
        /* Roll the (possibly dice) spell duration ONCE so every AE this cast
         * spawns — the periodic ticker and the authored AEs — expires
         * together rather than each rolling its own length. */
        const _durValue = rollDurationValue(item.system?.duration?.value);

        /* ── "Apply Every" — periodic resource effect ───────────────
         * applyEvery ≠ instant makes the target-resource effect TICK over the
         * duration instead of applying once. We synthesize a ticking AE on
         * each target carrying a heal (Heal HP) or damage/ablation (Damage HP
         * / Ablation) action at the chosen cadence; the tick engine
         * (chrome/policy/tick-effects.js) fires it every turn / minute / hour
         * / day until the duration expires. Only hp / healHp / ablation are
         * periodic-capable; the one-shot blocks below handle applyEvery=instant
         * (and the Roll Damage button is suppressed for the periodic case). */
        if (!isNarrative && !isRitual && !isPersistentZone) {
            const _dtype   = String(castContext.damage?.type ?? "");
            const _cadence = String(castContext.damage?.applyEvery ?? "instant");
            if (_cadence !== "instant" && (_dtype === "hp" || _dtype === "healHp" || _dtype === "ablation")) {
                const staSpent = Number(castContext?.staSpent ?? 0) || 0;
                const formula = String(castContext.damage?.formula ?? "").trim()
                    .replace(/\{sta\}/gi, String(staSpent))
                    .replace(/\{margin\}/gi, "0");
                if (formula) {
                    let action;
                    if (_dtype === "healHp") {
                        action = { type: "heal", amount: formula, when: "always", cadence: _cadence };
                    } else if (_dtype === "ablation") {
                        action = { type: "damage", formula: "", ablateArmor: formula, cadence: _cadence,
                                   locations: ["torso"], throughArmor: true };
                    } else {
                        /* Secondary armour ablation ticks ALONGSIDE the HP damage
                         * when the spell has an ablateArmor formula (acid DoT that
                         * both hurts and rusts). {sta} substituted like the main
                         * formula; the tick engine's applyDamageAction rolls it. */
                        const _ablatePer = String(item.system?.ablateArmor ?? "").trim()
                            .replace(/\{sta\}/gi, String(staSpent))
                            .replace(/\{margin\}/gi, "0");
                        action = { type: "damage", formula, cadence: _cadence,
                                   locations: ["torso"], throughArmor: !!item.system?.bypassArmor,
                                   ...(_ablatePer ? { ablateArmor: _ablatePer } : {}) };
                    }
                    const durEffect = durationToEffect(item, _durValue);
                    const targetType = String(item.system?.targetType ?? "direct");
                    const recipients = new Set();
                    if (targetType === "self") recipients.add(this);
                    else if (_willPrompt) {
                        /* Read the resolved hit set (see _hitTargetActors) —
                         * the local castContext.targets never carries the hit
                         * verdict, so this is the only reliable source. */
                        for (const a of _hitTargetActors) recipients.add(a);
                    } else {
                        for (const a of _defenderCandidates) recipients.add(a);
                    }
                    /* Human-readable line so the target's player sees WHAT the
                     * ticking effect does, not just a bare spell-name badge. */
                    const _every = _cadence === "turn" ? "every turn" : `every ${_cadence}`;
                    const _descr = _dtype === "healHp" ? `Heals ${formula} HP ${_every}`
                                 : _dtype === "ablation" ? `Ablates armor ${formula} ${_every}`
                                 : `${formula} damage ${_every}`;
                    const aePayload = {
                        name: item.name,
                        img:  item.img,
                        origin: this.uuid,
                        transfer: false,
                        disabled: false,
                        description: `${item.name} — ${_descr}`,
                        ...(durEffect ? { duration: durEffect } : {}),
                        flags: { [MODULE]: {
                            castMarker: true,
                            sourceItem: item.uuid,
                            sourceCaster: this.uuid,
                            castMessage: result?.message?.uuid ?? null,
                            actions: [action]
                        } }
                    };
                    /* Route through the GM socket (same path authored AEs use)
                     * so a player can drop the ticking effect on an ally they
                     * don't own. */
                    for (const targetActor of recipients) {
                        try { await emitApplyAuthoredEffects({ targetUuid: targetActor.uuid, payloads: [aePayload] }); }
                        catch (err) { console.warn(`${MODULE} | periodic cast effect apply failed`, err); }
                    }
                }
            }
        }

        /* ── Heal HP auto-apply (one-shot) ──────────────────────────
         * A spell whose target resource is "healHp" (and applyEvery=instant)
         * RESTORES HP at CAST time — no "Apply Damage" button. Rolls the
         * damage formula as the heal amount (flat / formula / dice, with {sta}
         * interpolation; {margin} → 0 since a heal has no defense contest) per
         * recipient and adds it to their HP, clamped to max. Recipients resolve
         * the same way authored-AEs do (self / hit targets / candidates).
         * Owner/GM-gated per target; armour / DR / element never apply. */
        if (!isNarrative && !isRitual && !isPersistentZone
            && String(castContext.damage?.type) === "healHp"
            && String(castContext.damage?.applyEvery ?? "instant") === "instant") {
            const rawFormula = String(castContext.damage?.formula ?? "").trim();
            if (rawFormula) {
                const staSpent = Number(castContext?.staSpent ?? 0) || 0;
                const healFormula = rawFormula
                    .replace(/\{sta\}/gi, String(staSpent))
                    .replace(/\{margin\}/gi, "0");
                const targetType = String(item.system?.targetType ?? "direct");
                const recipients = new Set();
                if (targetType === "self") {
                    recipients.add(this);
                } else if (_willPrompt) {
                    /* Read the resolved hit set (_hitTargetActors), NOT the
                     * local castContext.targets[].hit — that field is never
                     * populated on the cast side (only the message copy is
                     * patched), so the old loop healed nobody. Matches the
                     * periodic heal path above. */
                    for (const a of _hitTargetActors) recipients.add(a);
                } else {
                    for (const a of _defenderCandidates) recipients.add(a);
                }
                for (const targetActor of recipients) {
                    if (!(game.user?.isActiveGM || targetActor.isOwner)) continue;
                    const hp = targetActor.system?.derivedStats?.hp;
                    if (!hp) continue;
                    let amt = 0;
                    try { amt = Math.max(0, Math.floor(Number((await new Roll(healFormula).evaluate()).total) || 0)); }
                    catch (_) { amt = 0; }
                    if (amt <= 0) continue;
                    const cur = Number(hp.value) || 0;
                    const max = Number(hp.max) || 0;
                    const healed = Math.max(0, Math.min(amt, max - cur));
                    if (healed <= 0) continue;
                    try {
                        await targetActor.update({ "system.derivedStats.hp.value": cur + healed });
                        if (typeof targetActor.createHealMessage === "function") await targetActor.createHealMessage(healed);
                    } catch (err) { console.warn(`${MODULE} | cast heal apply failed`, err); }
                }
            }
        }

        /* Embedded Active Effects are applied to targets on cast whenever the
         * spell has any — no master toggle. Each effect rolls its own
         * per-effect application chance (flags.<sys>.applyChance, default
         * 100%; set 0 to disable an individual effect). */
        /* BUG FIX: `item.effects` is a Foundry EmbeddedCollection, NOT a plain
         * array — `Array.isArray(item.effects)` was ALWAYS false, so this entire
         * authored-effect block was dead code and drag-in / advanced-section AEs
         * never reached ANY target (self, single, or area). Use `.size`. */
        if (!isNarrative && !isRitual && !isPersistentZone
            && (item.effects?.size ?? 0) > 0) {
            const targetType = String(item.system?.targetType ?? "direct");
            const recipients = new Set();
            if (targetType === "self") {
                recipients.add(this);
            } else if (_willPrompt) {
                /* Hit targets receive; miss targets don't. Read the resolved
                 * hit set (_hitTargetActors) — the local castContext.targets
                 * never carries the `hit` verdict (only the message copy does),
                 * so this was silently applying to nobody. */
                for (const a of _hitTargetActors) recipients.add(a);
            } else {
                /* No defense contest ran — treat every candidate as
                 * a hit (matches the auto-hit rider apply block's
                 * philosophy for defense-less spells). */
                for (const a of _defenderCandidates) recipients.add(a);
            }
            if (recipients.size) {
                /* Only ENABLED effects transfer — a disabled advanced-section
                 * effect is authored-but-off and must not apply. (Empty after
                 * the filter → the per-recipient loop just no-ops.) */
                const authoredEffects = item.effects.contents.filter(e => !e.disabled).map(e => e.toObject());
                const itemDuration = durationToEffect(item, _durValue);
                for (const targetActor of (authoredEffects.length ? recipients : [])) {
                    const payloads = authoredEffects.map(src => {
                        /* Per-effect application chance (spell sheet, default
                         * 100%). Roll d100 PER TARGET so each recipient gets
                         * an independent chance to receive this AE. */
                        const chance = Number(src.flags?.[MODULE]?.applyChance ?? 100);
                        if (chance < 100 && (Math.floor(Math.random() * 100) + 1) > Math.max(0, chance)) return null;
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
                        /* Persistent-zone authored AEs get tagged with
                         * the template UUID and the same zoneRiderMode/
                         * stripOnExit shape that `applyZoneAE` uses.
                         * Without this the clone was invisible to
                         * `stripZoneAEsForTemplate` (template delete) and
                         * to `reconcileTokenZoneAEs` (token walks out) —
                         * users saw an entrant get -1 that never cleared
                         * because there was no link back to the zone. */
                        if (isPersistentZone && _zoneTemplateUuid) {
                            cloned.flags[MODULE].zoneTemplate    = _zoneTemplateUuid;
                            cloned.flags[MODULE].zoneRiderMode   = "zone";
                            cloned.flags[MODULE].zoneStripOnExit = true;
                        }
                        return cloned;
                    }).filter(Boolean);
                    /* Diagnostic — GM-only. Grep console for "wdm authored
                     * apply" while casting to see whether the AE being
                     * applied to entrants comes from the authored-clone
                     * path (this block) or from applyZoneAE. If entrants
                     * only get authored clones the item is missing a
                     * `statusRiders[i].mode === "zone"` entry and STA
                     * scaling has no clause to attach to. */
                    if (game.user?.isGM) {
                        console.log(`${MODULE} | wdm authored apply`, {
                            target: targetActor?.name,
                            payloadCount: payloads.length,
                            zoneTagged: isPersistentZone && !!_zoneTemplateUuid,
                            payloadChanges: payloads.map(p => p.changes)
                        });
                    }
                    try {
                        await emitApplyAuthoredEffects({ targetUuid: targetActor.uuid, payloads });
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

        /* ── Shield pool apply (Quen, Active Shield) ───────────────────
         * Deterministic: HP = hpPerSta × staSpent — no damage roll (the
         * old damage-button path required a formula, so Quen items with
         * no formula never applied). Fires on any successful non-fumble
         * cast of a shieldHp spell — self-target, so no defender fan-out
         * is required.
         *
         * Take-higher refill: if the caster already has a castShield AE
         * from a prior cast, the new HP replaces the old ONLY when it's
         * larger. Casting 10-HP Quen while at 3 remaining → 10; casting
         * again at 10 with a 5-HP Quen leaves 10 alone. This matches
         * RAW: Quen doesn't stack, it refills to the new pool's ceiling.
         *
         * The AE is a badge — it carries `activeShieldHp` (the current
         * pool value shown in the AE name) and `castShield: true`
         * (identifier for cleanup + Stage-2 skip). Actual drain lives in
         * system.derivedStats.shield, drained by the damage calculator's
         * Stage 1 shield gate. When shield hits 0, the AE is deleted
         * (see updateActor hook below). */
        if (!isRitual && result?.message && !result.fumble
            && String(item.system?.damageType) === "shieldHp"
            && Number(item.system?.shield?.hpPerSta) > 0) {
            try {
                const hpPerSta = Number(item.system.shield.hpPerSta) || 0;
                let grantHp = Math.max(0, hpPerSta * (Number(staToSpend) || 0));
                /* Glyph magnitude boost — a shield spell's "effect magnitude" is
                 * its HP pool, so each glyph routed to +1d6 rolls and adds to
                 * the grant (the damage-formula fold above deliberately skips
                 * shield spells). */
                if (glyphMagnitudeDice > 0) {
                    try {
                        const gr = await new Roll(`${glyphMagnitudeDice}d6`).evaluate();
                        grantHp += Math.max(0, Number(gr.total) || 0);
                    } catch (_) { /* keep the deterministic grant on roll failure */ }
                }
                if (grantHp > 0) {
                    /* Find any prior shield AE from THIS caster. Match on
                     * castShield:true (identifier) so we refill regardless
                     * of which shield spell created it (Quen and Active
                     * Shield share the pool — casting one refills the
                     * other). */
                    const existing = this.effects?.find?.(e =>
                        !!e.flags?.[MODULE]?.castShield);
                    const oldHp = Number(existing?.flags?.[MODULE]?.activeShieldHp) || 0;
                    const newHp = Math.max(oldHp, grantHp);

                    if (existing) {
                        /* Refill: same AE, updated flag + duration. Take-
                         * higher on duration too, since a longer new cast
                         * shouldn't be shortened by an older cast's clock. */
                        const nextDur = durationToEffect(item);
                        const patch = {
                            [`flags.${MODULE}.activeShieldHp`]: newHp,
                            [`flags.${MODULE}.sourceItem`]: item.uuid,
                            name: item.name
                        };
                        if (nextDur) patch.duration = nextDur;
                        await existing.update(patch);
                    } else {
                        const dur = durationToEffect(item);
                        await this.createEmbeddedDocuments("ActiveEffect", [{
                            name: item.name,
                            img:  item.img ?? "icons/svg/shield.svg",
                            ...(dur ? { duration: dur } : {}),
                            origin: this.uuid,
                            transfer: false,
                            statuses: [],
                            flags: {
                                [MODULE]: {
                                    activeShieldHp: newHp,
                                    castShield:     true,
                                    sourceItem:     item.uuid,
                                    sourceCaster:   this.uuid,
                                    castMessage:    result?.message?.uuid ?? null
                                }
                            }
                        }]);
                    }

                    /* Fill the shield stat — the pool the damage calculator
                     * actually drains. Take-higher against the current value
                     * so casting a smaller Quen doesn't chop the pool. */
                    const curShield = Number(this.system?.derivedStats?.shield) || 0;
                    if (newHp > curShield) {
                        await this.update({ "system.derivedStats.shield": newHp });
                    }
                }
            } catch (err) {
                console.warn(`${MODULE} | shield apply failed`, err);
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
        await this._applyCastDuration(item, durText, _zoneTemplateUuid);

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
