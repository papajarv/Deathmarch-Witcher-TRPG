/**
 * castDialog — the spell / hex / ritual casting dialog.
 *
 * Opened by castSpellMixin.castSpell before the roll (the dock's spells row).
 * One picker-free dialog per castable item: it surfaces the STA cost (editable
 * for variable-cost spells, reduced by a Focus weapon), an "other modifier"
 * field, a live roll total, and an info box describing how the target resists,
 * the range, duration, components and (for hexes) danger.
 *
 * Damage section: shows the item's structured damageFormula + damageElement
 * (both read-only by default). For variableCost items, BOTH fields become
 * editable so the caster can retune the payload per cast. Non-damaging
 * (empty formula, non-variable) items skip the section entirely.
 *
 * Rituals are DC-based (Ritual Crafting vs a difficulty) rather than an
 * opposed cast, so they show a DC field + preparation time instead of STA.
 *
 * Returns the collect() result the mixin turns into the roll + chat card, or
 * null on cancel.
 */

import {
    SPELL_DEFENSES, HEX_DEFENSES, HEX_DANGER,
    SPELL_DURATION_UNITS, HEX_DURATION_UNITS,
    RITUAL_DURATION_UNITS, RITUAL_TIME_UNITS,
    SPELL_DAMAGE_ELEMENTS, SPELL_DAMAGE_TYPES, SPELL_AREA_SHAPES
} from "../setup/config.mjs";
import { isAdrenalineEnabled, adrenalineStaPerDie } from "../api/adrenaline.mjs";
import { hasWRPerk } from "../api/witcherReborn.mjs";

const esc = (s) => Handlebars.escapeExpression(String(s ?? ""));
const L   = (k) => game.i18n.localize(k);
const F   = (k, d) => game.i18n.format(k, d);
const signed = (n) => `${n >= 0 ? "+" : ""}${n}`;

/* Signs (witcher) cap at 7 STA per cast (Core p.115). */
const SIGN_STA_CAP = 7;
/* Over-exertion costs 5 HP per STA point poured past Vigor (Core p.166). Kept
   in sync with castSpellMixin so the dialog's pre-cast warning matches reality. */
const OVER_EXERT_PER_POINT = 5;

/* Vigor / over-exertion help — a themed ⓘ tooltip shown beside the STA field. */
const VIGOR_TIP =
  '<div class="wcu-tip">' +
    '<strong>Vigor &amp; Over-Exertion</strong>' +
    'Vigor is how much Stamina you can pour into magic in one round before it backfires.' +
    '<div class="wcu-tip-row"><span>Within Vigor</span><span>Just the STA cost</span></div>' +
    '<div class="wcu-tip-row"><span>Past Vigor</span><span>5 damage per STA over</span></div>' +
    '<div class="wcu-tip-row"><span>Signs</span><span>Capped at 7 STA / cast</span></div>' +
    '<div class="wcu-tip-flavor">Over-exerting also triggers an elemental fumble matching the spell&apos;s school. Vigor resets each combat round.</div>' +
  '</div>';
const vigorHelpIcon = () =>
  `<span class="wdm-help-tip" data-tooltip="${esc(VIGOR_TIP)}" data-tooltip-direction="UP" data-tooltip-class="wou-craft-tip"><i class="fa-solid fa-circle-info"></i></span>`;

/** The defense label(s) the target rolls against — spell carries an array,
 *  hex a single enum, ritual none. Empty / "none" → the no-defense note. */
function defenseLabels(item) {
    if (item.type === "hex") {
        const d = item.system?.defense;
        return (!d || d === "none") ? [] : [L(HEX_DEFENSES[d] ?? d)];
    }
    const arr = Array.isArray(item.system?.defense) ? item.system.defense : [];
    return arr.filter(d => d && d !== "none").map(d => L(SPELL_DEFENSES[d] ?? d));
}

/** Parse the item's free-form range string into a maximum distance in
 *  metres. Returns:
 *    - a positive number for numeric ranges ("10m", "20 metres")
 *    - 0 for "Touch" / "Self" (adjacent only — a 1-tile check happens
 *      at cast time via the caster's SPD/reach; the dialog treats these
 *      as "you must be next to the target")
 *    - Infinity for "Sight" / anything unbounded
 *    - null when the field is empty or the string has no parseable range
 *      (fall back to "any distance" — the GM adjudicates) */
function parseRangeMeters(item) {
    const raw = String(item?.system?.range ?? "").trim();
    if (!raw) return null;
    if (/self/i.test(raw))  return 0;
    if (/touch/i.test(raw)) return 0;
    if (/sight|line of sight|unlimited/i.test(raw)) return Infinity;
    const m = raw.match(/(\d+(?:\.\d+)?)\s*(m|metres?|meters?)?/i);
    if (m) return Number(m[1]);
    return null;
}

/** Human-readable duration ("3 Rounds", "Permanent", "Until Lifted"). */
function durationText(item) {
    const dur = item.system?.duration;
    if (!dur) return "";
    const units = item.type === "hex" ? HEX_DURATION_UNITS
                : item.type === "ritual" ? RITUAL_DURATION_UNITS
                : SPELL_DURATION_UNITS;
    const unitLabel = L(units[dur.unit] ?? dur.unit);
    const val = String(dur.value ?? "").trim();
    // Unit-only durations (instant / permanent / lifted) carry no value.
    return (!val || val === "0") ? unitLabel : `${val} ${unitLabel}`;
}

/** Preparation time for a ritual ("5 Rounds", "1 Hours"). */
function prepText(item) {
    const ct = item.system?.castingTime;
    if (!ct || typeof ct !== "object") return "";
    const unit = L(RITUAL_TIME_UNITS[ct.unit] ?? ct.unit);
    return `${ct.value ?? 0} ${unit}`;
}

/* ── HTML builders ─────────────────────────────────────────────────────── */

function buildContent(ctx) {
    const { item, focus } = ctx;
    const sys = item.system ?? {};
    const isRitual = item.type === "ritual";
    const isSign = item.type === "spell" && sys.spellForm === "sign";

    // Cost / DC controls. Rituals roll vs a DC; everything else spends STA.
    // Signs cost 1-7 STA per cast (Core p.115) — floor at 1, cap at 7, on both
    // the default value and the input bounds.
    const staFloor = isSign ? 1 : 0;
    let baseSta = Math.max(0, (Number(sys.staminaCost) || 0) - focus);
    if (isSign) baseSta = Math.min(Math.max(staFloor, baseSta), SIGN_STA_CAP);
    const staDefault = sys.variableCost ? staFloor : baseSta;
    const costField = isRitual ? `
        <div class="wdm-atk-field">
            <label>${esc(L("WITCHER.Cast.DC"))}</label>
            <input type="number" name="dc" step="1" value="${esc(Number(sys.difficulty) || 0)}" ${sys.variableDC ? "" : ""}/>
        </div>` : sys.variableCost ? `
        <div class="wdm-atk-field">
            <label>${esc(L("WITCHER.Cast.StaCost"))} (${esc(L("WITCHER.Cast.Variable"))})${isSign ? ` — ${esc(L("WITCHER.Cast.SignCapHint"))}` : ""} ${vigorHelpIcon()}</label>
            <input type="number" name="sta" step="1" min="${staFloor}" ${isSign ? `max="${SIGN_STA_CAP}"` : ""} value="${esc(staDefault)}"/>
        </div>` : `
        <div class="wdm-atk-field">
            <label>${esc(L("WITCHER.Cast.StaCost"))} ${vigorHelpIcon()}</label>
            <div class="wdm-atk-readonly">${esc(staDefault)}</div>
            <input type="hidden" name="sta" value="${esc(staDefault)}"/>
        </div>`;

    const focusField = (!isRitual && focus > 0) ? `
        <div class="wdm-atk-field">
            <label>${esc(L("WITCHER.Cast.Focus"))}</label>
            <div class="wdm-atk-readonly">−${esc(focus)}</div>
        </div>` : "";

    const otherModField = `
        <div class="wdm-atk-field">
            <label>${esc(L("WITCHER.Cast.OtherMod"))}</label>
            <input type="number" name="otherMod" step="1" value="0"/>
        </div>`;

    /* Adrenaline dice — each die adds +1d6 to the cast's damage roll.
     * STA/die cost is `adrenalineStaPerDie()` (RAW default 4), HALVED
     * when the caster owns the Griffin Combat Meditation perk. Only
     * shown when the actor has a pool AND the cast is damaging (empty
     * formula = utility spell; adrenaline wouldn't do anything). The
     * live readout under the field echoes dice + total STA cost. */
    const actor = ctx.actor;
    const adrPool = (!isRitual && isAdrenalineEnabled())
        ? Math.max(0, Number(actor?.system?.adrenaline?.value) || 0)
        : 0;
    /* Base STA/die comes from the system setting (`adrenalineStaPerDie`),
     * same source the weapon attacks use — one canonical number for the
     * whole system. Griffin's Combat Meditation halves it (rounded down,
     * floored at 1) so the perk text stays "half stamina cost" rather
     * than a magic number. */
    const hasCM = actor ? hasWRPerk(actor, "combatMeditation") : false;
    const adrStaBase = adrenalineStaPerDie();
    const adrStaPerDie = hasCM ? Math.max(1, Math.floor(adrStaBase / 2)) : adrStaBase;
    const hasDamage = String(sys.damageFormula ?? "").trim() !== "" || !!sys.variableCost;
    const adrenalineField = (adrPool > 0 && hasDamage) ? `
        <div class="wdm-atk-field">
            <label>Adrenaline dice ${hasCM ? '<span class="wdm-atk-perk">(Combat Meditation: −½ STA)</span>' : ''}</label>
            <input type="number" name="adrenaline" step="1" min="0" max="${adrPool}" value="0"
                   data-adr-max="${adrPool}" data-adr-sta="${adrStaPerDie}" />
            <div class="wdm-atk-readout" data-adr-readout></div>
        </div>` : "";

    /* Damage section — always read-only. The formula / element / type
     * are properties of the spell itself (authored on the item), not
     * caster choices. `variableCost` toggles the STA slider (a caster
     * can pour more or less into a scaling formula via `{sta}`), NOT
     * the formula shape. Non-damaging items (empty formula, non-
     * variable) skip the section entirely.
     *
     * Narrative-only spells hide the damage/area/rider blocks — a
     * narrative spell rolls the spellcasting check and posts the
     * effect description; no damage / area / rider metadata is
     * meaningful because nothing auto-applies. */
    const isNarrative = sys.narrative === true;
    const dmgFormula = String(sys.damageFormula ?? "");
    const dmgElement = String(sys.damageElement ?? "none");
    const dmgType    = String(sys.damageType    ?? "none");
    const showDamage = !isRitual && !isNarrative && dmgFormula;
    const damageEditable = false;
    const damageSection = !showDamage ? "" : `
        <div class="wdm-atk-grid" data-cast-damage>
            <div class="wdm-atk-field">
                <label>Damage formula</label>
                ${damageEditable
                    ? `<input type="text" name="damageFormula" value="${esc(dmgFormula)}" placeholder="5d6 or {sta}d6" />`
                    : `<div class="wdm-atk-readonly">${esc(dmgFormula || "—")}</div>`}
            </div>
            <div class="wdm-atk-field">
                <label>Element</label>
                ${damageEditable
                    ? `<select name="damageElement">${
                        Object.entries(SPELL_DAMAGE_ELEMENTS).map(([k, key]) =>
                            `<option value="${esc(k)}" ${k === dmgElement ? "selected" : ""}>${esc(L(key))}</option>`
                        ).join("")
                      }</select>`
                    : `<div class="wdm-atk-readonly">${esc(L(SPELL_DAMAGE_ELEMENTS[dmgElement] ?? dmgElement))}</div>`}
            </div>
            <div class="wdm-atk-field">
                <label>Type</label>
                ${damageEditable
                    ? `<select name="damageType">${
                        Object.entries(SPELL_DAMAGE_TYPES).map(([k, key]) =>
                            `<option value="${esc(k)}" ${k === dmgType ? "selected" : ""}>${esc(L(key))}</option>`
                        ).join("")
                      }</select>`
                    : `<div class="wdm-atk-readonly">${esc(L(SPELL_DAMAGE_TYPES[dmgType] ?? dmgType))}</div>`}
            </div>
        </div>`;

    /* Area + status-rider preview — read-only. Both stay hidden when
     * their field is at its "none" default so the dialog stays lean on
     * simple casts. Riders show one row per authored effect with the
     * chance % and (if present) duration. */
    const aShape = String(sys.areaShape ?? "none");
    const aSize  = Number(sys.areaSize) || 0;
    const aAnchor = String(sys.areaAnchor ?? "caster");
    const aPersist = sys.areaPersist === true;
    const anchorBadge = aShape === "none" || item.type === "ritual" ? "" :
        aAnchor === "free"
            ? ` — <span class="wdm-cast-anchor" style="opacity:0.7">free-placed</span>`
            : ` — <span class="wdm-cast-anchor" style="opacity:0.7">from you (aim)</span>`;
    const persistBadge = aPersist
        ? ` — <span class="wdm-cast-anchor" style="opacity:0.7;color:#c8a878;">persistent</span>`
        : "";
    const areaSection = (aShape === "none" || isNarrative) ? "" : `
        <div class="wdm-atk-note" data-cast-area>
            <i class="fa-solid fa-vector-square"></i>
            Area: <b>${esc(L(SPELL_AREA_SHAPES[aShape] ?? aShape))}</b>${aSize > 0 ? ` — <b>${esc(aSize)}m</b>` : ""}${anchorBadge}${persistBadge}
        </div>`;
    /* Tangibility badge — only surface when the cast is INTANGIBLE, so
     * the caster sees a "phases through shields" note. Tangible casts
     * (the majority) don't need the badge — that's the assumed default. */
    const tangibleSection = (item.type !== "ritual" && sys.tangible === false) ? `
        <div class="wdm-atk-note" data-cast-intangible>
            <i class="fa-solid fa-ghost"></i>
            <b>Intangible</b> — bypasses Active Shield / Quen entirely.
        </div>` : "";
    const riders = Array.isArray(sys.statusRiders) ? sys.statusRiders : [];
    const ridersSection = (riders.length === 0 || isNarrative) ? "" : `
        <div class="wdm-atk-note" data-cast-riders>
            <i class="fa-solid fa-bolt"></i>
            <b>On hit:</b>
            ${riders.map(r => {
                const durVal = String(r?.duration?.value ?? "").trim();
                const durUnit = String(r?.duration?.unit ?? "instant");
                const dur = durVal ? ` (${esc(durVal)} ${esc(durUnit)})` : "";
                return `<span class="wdm-cast-rider">${esc(r?.statusId ?? "")} <em>${esc(r?.chance ?? 100)}%</em>${dur}</span>`;
            }).join(", ")}
        </div>`;

    // Info box — the same per-action explanation pattern the brawl/attack
    // dialogs use, but populated from the castable item's structured fields.
    const defs = defenseLabels(item);
    const rows = [];
    if (!isRitual) {
        rows.push(defs.length
            ? `${esc(L("WITCHER.Cast.Defense"))}: <b>${esc(defs.join(" / "))}</b>`
            : esc(L("WITCHER.Cast.DefenseNone")));
    } else {
        const prep = prepText(item);
        if (prep) rows.push(`${esc(L("WITCHER.Cast.PrepTime"))}: <b>${esc(prep)}</b>`);
    }
    if (sys.range)       rows.push(`${esc(L("WITCHER.Cast.Range"))}: <b>${esc(sys.range)}</b>`);
    const dur = durationText(item);
    if (dur)             rows.push(`${esc(L("WITCHER.Cast.Duration"))}: <b>${esc(dur)}</b>`);
    if (item.type === "hex" && sys.danger)
        rows.push(`${esc(L("WITCHER.Cast.Danger"))}: <b>${esc(L(HEX_DANGER[sys.danger] ?? sys.danger))}</b>`);
    const comps = Array.isArray(sys.components) ? sys.components : [];
    if (comps.length)
        rows.push(`${esc(L("WITCHER.Cast.Components"))}: <b>${esc(comps.map(c => c.qty > 1 ? `${c.name} ×${c.qty}` : c.name).join(", "))}</b>`);

    const infoBox = rows.length ? `
        <div class="wdm-atk-note" data-cast-info>
            <i class="fa-solid fa-circle-info"></i> ${rows.join("<br>")}
        </div>` : "";

    const totalLabel = isRitual ? "WITCHER.Cast.DC" : "WITCHER.Cast.Total";
    const totalBlock = `
        <div class="wdm-atk-total">
            <span class="wdm-atk-total-k">${esc(L(totalLabel))}</span>
            <span class="wdm-atk-total-v" data-total>1d10</span>
        </div>
        <div class="wdm-atk-breakdown" data-breakdown></div>`;

    // Over-exertion warning — populated live in refresh() once the chosen STA
    // (plus this round's prior Chaos) crosses Vigor. Rituals never over-exert.
    const warnBlock = isRitual ? "" : `<div class="wdm-cast-warn" data-cast-warn hidden></div>`;

    return `
    <div class="wdm-atk wdm-cast" data-cast-type="${esc(item.type)}">
        <div class="wdm-atk-grid">
            ${costField}
            ${focusField}
            ${otherModField}
            ${adrenalineField}
        </div>
        ${damageSection}
        ${areaSection}
        ${tangibleSection}
        ${ridersSection}
        ${warnBlock}
        ${infoBox}
        ${totalBlock}
    </div>`;
}

/* ── Read + compute ────────────────────────────────────────────────────── */

function collect(root, ctx) {
    const { item } = ctx;
    const q = (sel) => root.querySelector(sel);
    const isRitual = item.type === "ritual";
    const isSign = item.type === "spell" && item.system?.spellForm === "sign";

    const otherMod = Math.round(Number(q('[name="otherMod"]')?.value) || 0);

    let staSpend = 0, dc = null, signCapped = false;
    if (isRitual) {
        dc = Math.round(Number(q('[name="dc"]')?.value) || 0);
    } else {
        staSpend = Math.max(isSign ? 1 : 0, Math.round(Number(q('[name="sta"]')?.value) || 0));
        if (isSign && staSpend > SIGN_STA_CAP) { staSpend = SIGN_STA_CAP; signCapped = true; }
    }

    const extraPenalty = Number(ctx.extraPenalty) || 0;
    const chips = [];
    if (extraPenalty) chips.push({ label: L("WITCHER.Attack.ExtraAction"), value: extraPenalty });
    if (otherMod) chips.push({ label: L("WITCHER.Cast.OtherMod"), value: otherMod });
    if (!isRitual && staSpend) chips.push({ label: L("WITCHER.Cast.StaCost"), value: staSpend });

    /* Damage — pick up the (possibly-edited) formula + element. Falls
     * back to the item defaults when the dialog didn't expose the fields
     * (non-variable, non-damaging spells + rituals). Empty formula means
     * the cast doesn't deal HP damage — riders can still add damage via
     * addDamage(). */
    const damageFormula = String(
        q('[name="damageFormula"]')?.value
        ?? item.system?.damageFormula
        ?? ""
    ).trim();
    const damageElement = String(
        q('[name="damageElement"]')?.value
        ?? item.system?.damageElement
        ?? "none"
    );

    /* Adrenaline dice — clamped to the pool. STA cost per die is
     * pre-computed at build time (halved for Combat Meditation holders)
     * and lives on the input's dataset. */
    const adrInput = q('[name="adrenaline"]');
    const adrPool = Number(adrInput?.dataset?.adrMax) || 0;
    const adrStaPerDie = Number(adrInput?.dataset?.adrSta) || 0;
    const adrenalineDice = Math.min(adrPool, Math.max(0, Math.round(Number(adrInput?.value) || 0)));
    const adrenalineStaCost = adrenalineDice * adrStaPerDie;
    /* Adrenaline dice do NOT feed the cast roll — they only add damage.
     * Deliberately NOT pushed into `chips` (the modifier chip row
     * displays to-hit mods only). The live readout under the input
     * echoes "+Nd6 damage · N STA" for the caster's benefit. */

    return {
        item, staSpend, dc, otherMod, signCapped,
        damageFormula, damageElement,
        adrenalineDice, adrenalineStaCost, adrStaPerDie,
        chips,
        grandMod: (ctx.base?.total ?? 0) + extraPenalty + otherMod
    };
}

function refresh(root, ctx) {
    // Live-clamp a sign's STA field so a typed value can't sit above the cap.
    const { item } = ctx;
    if (item.type === "spell" && item.system?.spellForm === "sign") {
        const sta = root.querySelector('[name="sta"]');
        if (sta && Number(sta.value) > SIGN_STA_CAP) sta.value = String(SIGN_STA_CAP);
    }
    const r = collect(root, ctx);
    const totalEl = root.querySelector("[data-total]");
    if (totalEl) totalEl.textContent = r.grandMod ? `1d10 ${signed(r.grandMod)}` : "1d10";

    /* Adrenaline readout — echoes the picked dice + total STA cost. Clamps
     * the input to the pool if the user typed a bigger number. */
    const adrInput = root.querySelector('[name="adrenaline"]');
    if (adrInput) {
        const max = Number(adrInput.dataset.adrMax) || 0;
        const v = Math.max(0, Math.min(max, Math.round(Number(adrInput.value) || 0)));
        if (String(v) !== adrInput.value) adrInput.value = String(v);
        const ro = root.querySelector("[data-adr-readout]");
        if (ro) {
            const sta = v * (Number(adrInput.dataset.adrSta) || 0);
            ro.textContent = v > 0 ? `+${v}d6 damage · ${sta} STA` : "";
        }
    }

    const bdEl = root.querySelector("[data-breakdown]");
    if (bdEl) {
        const baseChips = (ctx.base?.chips ?? []).map(c =>
            `<span class="wdm-atk-chip is-base"><span class="k">${esc(c.label)}</span><span class="v">${esc(c.value)}</span></span>`);
        const modChips = r.chips
            .filter(c => c.label !== L("WITCHER.Cast.StaCost"))
            .map(c => `<span class="wdm-atk-chip ${c.value < 0 ? "is-neg" : "is-pos"}"><span class="k">${esc(c.label)}</span><span class="v">${signed(c.value)}</span></span>`);
        bdEl.innerHTML = [...baseChips, ...modChips].join("");
    }

    // Live over-exertion warning: mirror the mixin's marginal math so the
    // dialog states exactly what casting will cost. Only the STA THIS cast
    // drives past max(Vigor, prior round Chaos) is charged (5 HP/point + an
    // elemental fumble). Casting is never blocked — this is a heads-up only.
    const warnEl = root.querySelector("[data-cast-warn]");
    if (warnEl) {
        const actor = ctx.actor;
        const vigor = Number(actor?.system?.derivedStats?.vigor) || 0;
        const prior = Number(actor?._priorChaos) || 0;
        const predicted = prior + r.staSpend;
        const over = vigor > 0 ? Math.max(0, predicted - Math.max(vigor, prior)) : 0;
        if (over > 0) {
            warnEl.hidden = false;
            warnEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> ` +
                esc(F("WITCHER.Cast.OverExertWarn", { over, vigor, spent: predicted, dmg: over * OVER_EXERT_PER_POINT }));
        } else {
            warnEl.hidden = true;
            warnEl.innerHTML = "";
        }
    }

}

/* Exported so castSpellMixin can enforce the range gate AFTER the
 * dialog closes but BEFORE any action / STA is spent — matching how the
 * attack flow handles out-of-range throws (ui.notifications warn +
 * return null). Not in the dialog itself per user spec: no in-dialog
 * warning card, no disabled Cast button. */
export { parseRangeMeters };

/* ── Public entry ──────────────────────────────────────────────────────── */

/**
 * Open the cast dialog.
 * @param {Actor}  actor  the caster
 * @param {Item}   item   the spell / hex / ritual being cast
 * @param {object} opts   { base:{ total, chips }, focus } — the skill portion
 *                        (shown read-only) and the Focus STA reduction
 * @returns {Promise<object|null>}  the collect() result, or null on cancel
 */
export async function openCastDialog(actor, item, opts = {}) {
    const titleKey = item.type === "hex" ? "WITCHER.Cast.DialogTitleHex"
                   : item.type === "ritual" ? "WITCHER.Cast.DialogTitleRitual"
                   : "WITCHER.Cast.DialogTitleSpell";
    const rollKey  = item.type === "hex" ? "WITCHER.Cast.RollHex"
                   : item.type === "ritual" ? "WITCHER.Cast.RollRitual"
                   : "WITCHER.Cast.RollSpell";
    const icon = item.type === "hex" ? "fa-solid fa-skull"
               : item.type === "ritual" ? "fa-solid fa-book-skull"
               : "fa-solid fa-wand-sparkles";

    /* Caster → target distance in metres. Mirrors the attack-dialog
     * measurement: prefer canvas.grid.measureDistance, fall back to
     * pixel-hypotenuse math. Null when either side is tokenless
     * (theatre-of-mind) or no target is set. Used by the range gate. */
    let targetDistanceMeters = null;
    try {
        const aTok = actor?.getActiveTokens?.()?.[0] ?? null;
        let dTok = Array.from(game.user?.targets ?? [])[0] ?? null;
        if (!dTok) {
            const uuid = game.user?.getFlag?.("witcher-ttrpg-death-march", "actorTargetUuid");
            if (uuid) {
                const tActor = await fromUuid(uuid).catch(() => null);
                dTok = tActor?.getActiveTokens?.()?.[0] ?? null;
            }
        }
        if (aTok && dTok && canvas?.grid) {
            /* Chebyshev-in-meters: diagonal-adjacent = 2 m at a 1.5 m/tile
             * grid (matches the mixin's range gate). measureDistance is
             * skipped because it respects the scene's diagonal setting
             * (5-10-5 / Euclidean) and would misreport the diagonal. */
            const a = aTok.center ?? aTok;
            const b = dTok.center ?? dTok;
            const ax = Number(a?.x), ay = Number(a?.y);
            const bx = Number(b?.x), by = Number(b?.y);
            if (Number.isFinite(ax) && Number.isFinite(bx)) {
                const chebyPx = Math.max(Math.abs(ax - bx), Math.abs(ay - by));
                const sz = Number(canvas?.scene?.grid?.size)     || 100;
                const gd = Number(canvas?.scene?.grid?.distance) || 1.5;
                targetDistanceMeters = (chebyPx / sz) * gd;
            }
        }
    } catch (_) { targetDistanceMeters = null; }

    const ctx = {
        actor, item,
        base: opts.base ?? { total: 0, chips: [] },
        focus: Math.max(0, Number(opts.focus) || 0),
        extraPenalty: Number(opts.extraPenalty) || 0,
        targetDistanceMeters
    };

    const result = await foundry.applications.api.DialogV2.wait({
        window: { title: `${L(titleKey)} — ${item.name}`, icon },
        content: buildContent(ctx),
        classes: ["wdm-atk-dialog", "wdm-cast-dialog"],
        buttons: [
            { action: "cast", label: L(rollKey), icon, default: true,
              callback: (_event, _button, dialog) => collect(dialog.element, ctx) },
            { action: "cancel", label: L("WITCHER.Cancel"), icon: "fa-solid fa-xmark" }
        ],
        rejectClose: false,
        render: (_event, dialog) => {
            const root = dialog.element;
            refresh(root, ctx);
            root.addEventListener("input", () => refresh(root, ctx));
            root.addEventListener("change", () => refresh(root, ctx));
        }
    }).catch(() => null);

    return (result && typeof result === "object") ? result : null;
}
