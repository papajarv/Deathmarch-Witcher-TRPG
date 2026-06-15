/**
 * castDialog — the spell / hex / ritual casting dialog.
 *
 * Opened by castSpellMixin.castSpell before the roll (the dock's spells row).
 * One picker-free dialog per castable item: it surfaces the STA cost (editable
 * for variable-cost spells, reduced by a Focus weapon), an "other modifier"
 * field, a live roll total, and an info box describing how the target resists,
 * the range, duration, components and (for hexes) danger.
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
    RITUAL_DURATION_UNITS, RITUAL_TIME_UNITS
} from "../setup/config.mjs";

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
        </div>` : `
        <div class="wdm-atk-field">
            <label>${esc(L("WITCHER.Cast.StaCost"))}${sys.variableCost ? ` (${esc(L("WITCHER.Cast.Variable"))})` : isSign ? ` (${esc(L("WITCHER.Cast.SignCapHint"))})` : ""} ${vigorHelpIcon()}</label>
            <input type="number" name="sta" step="1" min="${staFloor}" ${isSign ? `max="${SIGN_STA_CAP}"` : ""} value="${esc(staDefault)}"/>
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
        </div>
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

    return {
        item, staSpend, dc, otherMod, signCapped,
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

    const ctx = {
        actor, item,
        base: opts.base ?? { total: 0, chips: [] },
        focus: Math.max(0, Number(opts.focus) || 0),
        extraPenalty: Number(opts.extraPenalty) || 0
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
