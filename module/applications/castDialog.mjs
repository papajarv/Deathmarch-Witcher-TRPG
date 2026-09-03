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
    SPELL_DAMAGE_ELEMENTS, SPELL_DAMAGE_TYPES, SPELL_AREA_SHAPES,
    ATTACK_LOCATIONS
} from "../setup/config.mjs";
import { isAdrenalineEnabled, adrenalineStaPerDieFor } from "../api/adrenaline.mjs";
import { hasWRPerk } from "../api/witcherReborn.mjs";
import { t, tFormat } from "../chrome/lib/i18n.js";

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
const VIGOR_TIP = () =>
  '<div class="wcu-tip">' +
    `<strong>${L("WITCHER.App.CastDialog.Tip.VigorHeader")}</strong>` +
    L("WITCHER.App.CastDialog.Tip.VigorIntro") +
    `<div class="wcu-tip-row"><span>${L("WITCHER.App.CastDialog.Tip.WithinVigor")}</span><span>${L("WITCHER.App.CastDialog.Tip.WithinVigorDesc")}</span></div>` +
    `<div class="wcu-tip-row"><span>${L("WITCHER.App.CastDialog.Tip.PastVigor")}</span><span>${L("WITCHER.App.CastDialog.Tip.PastVigorDesc")}</span></div>` +
    `<div class="wcu-tip-row"><span>${L("WITCHER.App.CastDialog.Tip.Signs")}</span><span>${L("WITCHER.App.CastDialog.Tip.SignsDesc")}</span></div>` +
    `<div class="wcu-tip-flavor">${L("WITCHER.App.CastDialog.Tip.VigorFlavor")}</div>` +
  '</div>';
const vigorHelpIcon = () =>
  `<span class="wdm-help-tip" data-tooltip="${esc(VIGOR_TIP())}" data-tooltip-direction="UP" data-tooltip-class="wou-craft-tip"><i class="fa-solid fa-circle-info"></i></span>`;

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
    const { item } = ctx;
    const foci = Array.isArray(ctx.foci) ? ctx.foci : [];
    const sys = item.system ?? {};
    const isRitual = item.type === "ritual";
    const isSign = item.type === "spell" && sys.spellForm === "sign";

    // Default focus = the first available (the caster can switch or pick None).
    const defFocus = (!isRitual && foci[0]) ? Math.max(0, Number(foci[0].focus) || 0) : 0;

    // Cost / DC controls. Rituals roll vs a DC; everything else spends STA.
    // Signs cost 1-7 STA per cast (Core p.115) — floor at 1, cap at 7, on both
    // the default value and the input bounds. A Focus reduces a FIXED spell's
    // cost (never below 1); variable/sign costs are the caster's own choice.
    /* A VARIABLE cost is a choice of how much power to pour in, and "none" is
     * not one of the choices — the frame's band starts at 1 for every variable
     * spell, not just signs. The floor was `isSign ? 1 : 0`, so an ordinary
     * variable-cost spell opened at 0 and could be cast for nothing: free Aard
     * after loading it from the book, free Cursed Illness, and a banded cost
     * that bought no band at all because 0 reaches no rung.
     *
     * A FIXED cost keeps a floor of 0, because a spell whose printed cost
     * really is 0 should show 0. */
    const staFloor = (isSign || sys.variableCost) ? 1 : 0;
    const rawCost = Number(sys.staminaCost) || 0;
    let baseSta = rawCost > 0 ? Math.max(1, rawCost - defFocus) : 0;
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
            <div class="wdm-atk-readonly" data-sta-readonly>${esc(staDefault)}</div>
            <input type="hidden" name="sta" value="${esc(staDefault)}"/>
        </div>`;

    // Focus picker — choose ONE equipped focus to cast through (or None). Each
    // option carries its Focus (STA reduction) + Greater Focus (roll bonus).
    // Defaults to the first focus; live-recomputes the STA cost in refresh().
    const fociField = (!isRitual && foci.length > 0) ? `
        <div class="wdm-atk-field">
            <label>${esc(L("WITCHER.Cast.Focus"))}</label>
            <select name="focusId" class="wdm-cast-focus-select">
                <option value="">${esc(L("WITCHER.Cast.NoFocus"))}</option>
                ${foci.map((f, i) => {
                    const bits = [];
                    if (Number(f.focus) > 0)        bits.push(`−${esc(f.focus)} STA`);
                    if (Number(f.greaterFocus) > 0) bits.push(`+${esc(f.greaterFocus)}`);
                    const suffix = bits.length ? ` · ${bits.join(" · ")}` : "";
                    return `<option value="${esc(f.id)}" data-focus="${esc(Number(f.focus) || 0)}" data-greater="${esc(Number(f.greaterFocus) || 0)}"${i === 0 ? " selected" : ""}>${esc(f.name)}${suffix}</option>`;
                }).join("")}
            </select>
        </div>` : "";

    /* AIMING — the same control the attack dialog uses, on the same table.
     *
     * A spell that deals damage can be aimed exactly as a weapon can: the
     * called shot takes its penalty and pays out its multiplier. The cast
     * dialog never offered it, so every damaging spell hit a random location
     * and a caster could not choose to go for the head. The options, the
     * penalties and the `aimMod` adjustment are read from the same
     * `ATTACK_LOCATIONS` the weapon path uses, so the two cannot drift.
     *
     * Offered only when the spell HAS damage to place — a buff has no
     * location, and a dropdown that does nothing is worse than no dropdown. */
    /* `isNarrative` is declared further down with the damage section; computed
     * here so this block does not read it before its `const` runs. */
    /* A called shot needs two things: damage to place, and somebody close
     * enough to place it on. The second is decided by the frame AFTER the
     * template lands (`AIM_REACH_METRES`) — Igni is a 2m cone, and you only
     * get to choose where on somebody it burns if you are right on top of
     * them. `null` means nobody worked it out (the legacy path has no template
     * step), and there the old behaviour holds. */
    const hasMagnitude = String(sys.damageFormula ?? "").trim() || ctx.spellHasMagnitude;
    const closeEnough  = ctx.aimable === null || ctx.aimable === undefined ? true : ctx.aimable === true;
    const spellAims = !isRitual && sys.narrative !== true && hasMagnitude && closeEnough;
    const aimMod = Number(ctx.actor?.system?.derivedStats?.aimMod) || 0;
    const locOpts = [
        `<option value="random:human">${esc(L("WITCHER.Attack.LocRandomHuman"))}</option>`,
        `<option value="random:monster">${esc(L("WITCHER.Attack.LocRandomMonster"))}</option>`,
        ...Object.entries(ATTACK_LOCATIONS).map(([key, loc]) => {
            const pen = loc.penalty + aimMod;
            const penTxt = pen ? ` (${pen > 0 ? "+" : ""}${pen})` : "";
            const multTxt = loc.mult !== 1 ? ` ×${loc.mult}` : "";
            return `<option value="loc:${key}">${esc(L(loc.labelKey))}${esc(penTxt)}${esc(multTxt)}</option>`;
        })
    ].join("");
    const locationField = !spellAims ? "" : `
        <div class="wdm-atk-field wdm-atk-field-wide" data-cast-loc-field>
            <label>${esc(L("WITCHER.Attack.Location"))}</label>
            <select name="location">${locOpts}</select>
        </div>`;

    const otherModField = `
        <div class="wdm-atk-field">
            <label>${esc(L("WITCHER.Cast.OtherMod"))}</label>
            <input type="number" name="otherMod" step="1" value="0"/>
        </div>`;

    /* Matching armor glyphs — one row per worn glyph whose element matches
     * this spell. Each row independently routes its bonus to +3 on the roll
     * OR +1d6 on the spell's effect magnitude (the latter is hidden when the
     * spell has no damage/heal/shield output — utility spells can only take
     * the roll bonus). Bonuses STACK across rows. */
    const glyphs   = Array.isArray(ctx.glyphs) ? ctx.glyphs : [];
    const glyphMag = !!ctx.spellHasMagnitude;
    const glyphField = glyphs.length > 0 ? `
        <div class="wdm-cast-glyphs" data-cast-glyphs>
            <div class="wdm-cast-glyphs-head">${esc(L("WITCHER.Cast.GlyphChoiceHead"))}</div>
            ${glyphs.map((g, i) => `
                <div class="wdm-cast-glyph">
                    <span class="wdm-cast-glyph-name">${esc(g.name)}</span>
                    <label class="wdm-cast-glyph-opt">
                        <input type="radio" name="glyph-${i}" value="roll" checked />
                        <span>+3 ${esc(L("WITCHER.Cast.GlyphRoll"))}</span>
                    </label>
                    ${glyphMag ? `<label class="wdm-cast-glyph-opt">
                        <input type="radio" name="glyph-${i}" value="mag" />
                        <span>+1d6 ${esc(L("WITCHER.Cast.GlyphMagnitude"))}</span>
                    </label>` : ""}
                </div>`).join("")}
        </div>` : "";

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
    const adrStaBase = adrenalineStaPerDieFor(actor);
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
                <label>${L("WITCHER.App.CastDialog.Label.DamageFormula")}</label>
                ${damageEditable
                    ? `<input type="text" name="damageFormula" value="${esc(dmgFormula)}" placeholder="5d6 or {sta}d6" />`
                    : `<div class="wdm-atk-readonly">${esc(dmgFormula || "—")}</div>`}
            </div>
            <div class="wdm-atk-field">
                <label>${L("WITCHER.App.CastDialog.Label.Element")}</label>
                ${damageEditable
                    ? `<select name="damageElement">${
                        Object.entries(SPELL_DAMAGE_ELEMENTS).map(([k, key]) =>
                            `<option value="${esc(k)}" ${k === dmgElement ? "selected" : ""}>${esc(L(key))}</option>`
                        ).join("")
                      }</select>`
                    : `<div class="wdm-atk-readonly">${esc(L(SPELL_DAMAGE_ELEMENTS[dmgElement] ?? dmgElement))}</div>`}
            </div>
            <div class="wdm-atk-field">
                <label>${L("WITCHER.App.CastDialog.Label.Type")}</label>
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
            ? ` — <span class="wdm-cast-anchor" style="opacity:0.7">${L("WITCHER.App.CastDialog.Text.FreePlaced")}</span>`
            : ` — <span class="wdm-cast-anchor" style="opacity:0.7">${L("WITCHER.App.CastDialog.Text.FromYouAim")}</span>`;
    const persistBadge = aPersist
        ? ` — <span class="wdm-cast-anchor" style="opacity:0.7;color:#c8a878;">${L("WITCHER.App.CastDialog.Text.Persistent")}</span>`
        : "";
    const areaSection = (aShape === "none" || isNarrative) ? "" : `
        <div class="wdm-atk-note" data-cast-area>
            <i class="fa-solid fa-vector-square"></i>
            ${t("WITCHER.App.CastDialog.Text.Area", "Area:")} <b>${esc(L(SPELL_AREA_SHAPES[aShape] ?? aShape))}</b>${aSize > 0 ? ` — <b>${esc(aSize)}m</b>` : ""}${anchorBadge}${persistBadge}
        </div>`;
    /* Tangibility badge — only surface when the cast is INTANGIBLE, so
     * the caster sees a "phases through shields" note. Tangible casts
     * (the majority) don't need the badge — that's the assumed default. */
    const tangibleSection = (item.type !== "ritual" && sys.tangible === false) ? `
        <div class="wdm-atk-note" data-cast-intangible>
            <i class="fa-solid fa-ghost"></i>
            <b>${t("WITCHER.App.CastDialog.Text.Intangible", "Intangible")}</b> — bypasses Active Shield / Quen entirely.
        </div>` : "";
    const riders = Array.isArray(sys.statusRiders) ? sys.statusRiders : [];
    const ridersSection = (riders.length === 0 || isNarrative) ? "" : `
        <div class="wdm-atk-note" data-cast-riders>
            <i class="fa-solid fa-bolt"></i>
            <b>${t("WITCHER.App.CastDialog.Text.OnHit", "On hit:")}</b>
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
            ${fociField}
            ${locationField}
            ${otherModField}
            ${adrenalineField}
        </div>
        ${glyphField}
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

    /* The called shot, read the same way the attack dialog reads it so the two
     * cannot drift: `random:<kind>` or `loc:<key>`, with `aimMod` folded into
     * the penalty. A location the caster did not choose stays random, which is
     * what every damaging spell did before this control existed. */
    const locVal = q('[name="location"]')?.value || "random:human";
    const aimMod = Number(ctx.actor?.system?.derivedStats?.aimMod) || 0;
    let location = { mode: "random", key: null, kind: "human", penalty: 0, mult: null, label: "" };
    if (locVal.startsWith("loc:")) {
        const key = locVal.slice(4);
        const loc = ATTACK_LOCATIONS[key];
        location = { mode: "specific", key, kind: null,
                     penalty: (loc?.penalty ?? 0) + aimMod, mult: loc?.mult ?? 1,
                     label: L(loc?.labelKey ?? key) };
    } else {
        const kind = locVal.split(":")[1] || "human";
        location = { mode: "random", key: null, kind, penalty: 0, mult: null,
                     label: L(kind === "monster" ? "WITCHER.Attack.LocRandomMonster"
                                                 : "WITCHER.Attack.LocRandomHuman") };
    }

    /* Chosen focus (or none). Its Focus value is already folded into the STA
     * field by refresh(); its Greater Focus value is a roll bonus. */
    const focusSel     = q('select[name="focusId"]');
    const focusOpt     = focusSel?.selectedOptions?.[0] ?? null;
    const focusId      = focusSel?.value || "";
    const focusGreater = Math.max(0, Number(focusOpt?.dataset?.greater) || 0);
    const focusReduce  = Math.max(0, Number(focusOpt?.dataset?.focus)   || 0);

    /* Matching-glyph choices: each row routed to "roll" adds +3; each routed
     * to "mag" adds one +1d6 to the effect magnitude. Rows default to "roll"
     * and the "mag" radio is absent for non-magnitude spells, so an unread
     * row correctly counts as a roll bonus. */
    const glyphList = Array.isArray(ctx.glyphs) ? ctx.glyphs : [];
    let glyphRollCount = 0, glyphMagnitudeDice = 0;
    for (let i = 0; i < glyphList.length; i++) {
        const choice = q(`input[name="glyph-${i}"]:checked`)?.value ?? "roll";
        if (choice === "mag") glyphMagnitudeDice++;
        else                  glyphRollCount++;
    }
    const glyphRollBonus = glyphRollCount * 3;

    let staSpend = 0, dc = null, signCapped = false;
    if (isRitual) {
        dc = Math.round(Number(q('[name="dc"]')?.value) || 0);
    } else {
        /* Same floor on the way back in — the input can be cleared or typed
         * over, and an empty box reads as 0. */
        const spendFloor = (isSign || item.system?.variableCost) ? 1 : 0;
        staSpend = Math.max(spendFloor, Math.round(Number(q('[name="sta"]')?.value) || 0));
        /* Variable & sign costs are entered raw, so apply the Focus STA discount
         * here (fixed spells already have it folded into their readonly field).
         * This is what lets a Focus(2) let 6 Vigor cover an 8-STA cast — the
         * spend, the Vigor/over-exertion check, and the pool debit all use the
         * reduced value. A real cast never drops below 1 STA. */
        if ((item.system?.variableCost || isSign) && staSpend > 0 && focusReduce > 0) {
            staSpend = Math.max(1, staSpend - focusReduce);
        }
        if (isSign && staSpend > SIGN_STA_CAP) { staSpend = SIGN_STA_CAP; signCapped = true; }
    }

    const extraPenalty = Number(ctx.extraPenalty) || 0;
    const chips = [];
    if (extraPenalty) chips.push({ label: L("WITCHER.Attack.ExtraAction"), value: extraPenalty });
    if (otherMod) chips.push({ label: L("WITCHER.Cast.OtherMod"), value: otherMod });
    if (location.mode === "specific" && location.penalty) {
        chips.push({ label: location.label, value: location.penalty });
    }
    if (focusGreater) chips.push({ label: L("WITCHER.Cast.GreaterFocus"), value: focusGreater });
    if (glyphRollBonus) chips.push({ label: L("WITCHER.Cast.Glyph"), value: glyphRollBonus });
    if (glyphMagnitudeDice) chips.push({ label: L("WITCHER.Cast.Glyph"), value: `+${glyphMagnitudeDice}d6` });
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
        focusId, focusGreater,
        glyphRollBonus, glyphMagnitudeDice,
        damageFormula, damageElement,
        adrenalineDice, adrenalineStaCost, adrStaPerDie,
        chips,
        location,
        /* Reported back so the caller can show what it charged without
         * reaching into the dialog's own scope for it. `baseChips` is the
         * read-only skill row the card reprints; `castSpell` used to splice in
         * `...baseChips` from `declareCast`'s scope, which is a different
         * method — so every legacy spell threw `baseChips is not defined` right
         * after it threw `baseTotal is not defined`. */
        extraPenalty,
        baseChips: Array.isArray(ctx.base?.chips) ? ctx.base.chips : [],
        grandMod: (ctx.base?.total ?? 0) + extraPenalty + otherMod + focusGreater + glyphRollBonus
                  + (Number(location.penalty) || 0)
    };
}

function refresh(root, ctx) {
    // Live-clamp a sign's STA field so a typed value can't sit above the cap.
    const { item } = ctx;
    if (item.type === "spell" && item.system?.spellForm === "sign") {
        const sta = root.querySelector('[name="sta"]');
        if (sta && Number(sta.value) > SIGN_STA_CAP) sta.value = String(SIGN_STA_CAP);
    }

    /* Focus picker → recompute a FIXED spell's STA cost (cost − Focus, min 1).
     * Only the readonly/hidden fixed field is touched; variable & sign costs
     * are the caster's own input and are left alone. */
    const focusSel = root.querySelector('select[name="focusId"]');
    const roDiv    = root.querySelector('[data-sta-readonly]');
    const staHidden = root.querySelector('input[name="sta"][type="hidden"]');
    if (focusSel && roDiv && staHidden && !item.system?.variableCost && item.type !== "ritual") {
        const selFocus = Math.max(0, Number(focusSel.selectedOptions?.[0]?.dataset?.focus) || 0);
        const rawCost = Number(item.system?.staminaCost) || 0;
        const reduced = rawCost > 0 ? Math.max(1, rawCost - selFocus) : 0;
        roDiv.textContent = String(reduced);
        staHidden.value = String(reduced);
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
        foci: Array.isArray(opts.foci) ? opts.foci : [],
        glyphs: Array.isArray(opts.glyphs) ? opts.glyphs : [],
        spellHasMagnitude: !!opts.spellHasMagnitude,
        extraPenalty: Number(opts.extraPenalty) || 0,
        /* Whether a called shot may be offered, decided by the frame once the
         * template has landed. `undefined` from the legacy path, which has no
         * template step and therefore nothing to decide it from — buildContent
         * treats that as "no opinion" and keeps the old behaviour. */
        aimable: opts.aimable,
        aimReach: opts.aimReach ?? null,
        targetDistanceMeters
    };

    const result = await foundry.applications.api.DialogV2.wait({
        window: { title: `${L(titleKey)} — ${item.name}`, icon, resizable: true },
        /* Fixed starting width so long spell text wraps instead of expanding the
         * window; resizable adds the bottom-right corner handle. */
        position: { width: 480 },
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
