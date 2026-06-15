/**
 * attackDialog — the weapon-attack modifier dialog.
 *
 * Opened by weaponAttackMixin.weaponAttack before the roll. Surfaces every
 * attack modifier the player can declare (Core p.152, 165-166):
 *
 *   - strike type     (melee + bows: normal / strong / fast; crossbows: normal)
 *   - extra action    (-3 to hit, 3 STA — combatRoundMixin handles the spend)
 *   - aim             (read-only: auto-applied from the actor's Aim status,
 *                      +1/rank capped, consumed by the mixin after the shot)
 *   - hit location    (random table, or a called shot at its penalty —
 *                      shifted by the actor's aimMod so a steady hand aims
 *                      cheaper)
 *   - situational mods (ambush, point-blank, prone target, range bracket, …)
 *   - weather         (the live ranged penalty from the weather subsystem,
 *                      auto-folded for ranged/thrown weapons)
 *   - a free numeric "other" field
 *
 * It computes a LIVE running total as the player toggles things, then returns
 * a structured result the mixin turns into the roll. Returns null on cancel.
 */

import {
    STRIKE_TYPES, ATTACK_MODIFIERS, ATTACK_LOCATIONS, RANGE_BRACKETS,
    SIZE_MODIFIERS, EXTRA_ACTION, AIM_BONUS_PER_TURN, AIM_BONUS_CAP
} from "../setup/config.mjs";
import { getActiveWeatherModifiers } from "../mechanics/weather-modifiers.mjs";
import { isAdrenalineEnabled, adrenalineStaPerDie } from "../api/adrenaline.mjs";

/** Fast Draw status: drawing + attacking the same turn is -3 to hit. */
const FAST_DRAW_PENALTY = -3;

/** Attacking with a weapon held in an off-hand slot (left/quick) is -3 to hit.
 *  A Joint Attack already carries its own -3 (STRIKE_TYPES.joint.toHit), so this
 *  is only added to non-joint single attacks. */
const OFFHAND_PENALTY = -3;

/** Whether `weapon` is wielded in an off-hand slot (left or quick). Mirrors
 *  occupancyOf for weapons: two-handed = both (main), else the stored slot.
 *  Only counts when the weapon is actually equipped. A quick item used alongside
 *  a two-handed weapon is NOT an off-hand attack — you rest the 2H weapon to use
 *  it, so it takes no -3. */
export function isOffhandWeapon(weapon) {
    if (!weapon?.system?.equipped) return false;
    if (weapon.system?.hands === "two") return false;
    const slot = weapon.system?.slot;
    if (slot !== "left" && slot !== "quick") return false;
    if (slot === "quick") {
        const actor = weapon.actor ?? weapon.parent ?? null;
        const hasTwoHanded = !!actor?.items?.some?.(i =>
            i.type === "weapon" && i.system?.equipped && i.system?.hands === "two");
        if (hasTwoHanded) return false;
    }
    return true;
}

const esc = (s) => Handlebars.escapeExpression(String(s ?? ""));
const L   = (k) => game.i18n.localize(k);
const signed = (n) => `${n >= 0 ? "+" : ""}${n}`;

/** Ranged-style weapon (accrues range/weather/point-blank). */
export function isRangedWeapon(weapon) {
    const wt = weapon?.system?.weaponType;
    return wt === "ranged" || wt === "thrown";
}

/** Strong/Fast are available to melee weapons and to bows (arrow ammo);
 *  crossbows (bolt ammo) and thrown weapons are normal-only (user spec). */
function allowsStrikeVariants(weapon) {
    const wt = weapon?.system?.weaponType;
    if (wt === "melee") return true;
    if (wt === "ranged" && weapon?.system?.ammoType === "arrow") return true;
    return false;
}

/** Mode-dependent view of the dialog ctx. A dual-mode thrown weapon (one that
 *  carries a meleeSkillKey) can be attacked as a thrown ranged shot OR an in-hand
 *  melee strike; the chosen mode (ctx.mode) flips the ranged treatment (range
 *  brackets / weather / aim / size), strike-variant + joint availability, which
 *  base profile (skill) rolls, and whether aim applies. Non-dual weapons just
 *  return their static ctx values, so behaviour is unchanged for them. */
function modeView(ctx) {
    if (!ctx.dualMode) {
        return { ranged: ctx.ranged, melee: ctx.melee, variants: ctx.variants,
                 base: ctx.base, aimBonus: ctx.aimBonus };
    }
    const isMelee = ctx.mode === "melee";
    return {
        ranged:   !isMelee,                       // thrown mode is the ranged path
        melee:    isMelee,
        variants: isMelee,                        // melee: strong/fast; thrown: normal-only
        base:     isMelee ? (ctx.meleeBase ?? ctx.base) : ctx.base,
        aimBonus: isMelee ? 0 : ctx.aimBonus
    };
}

/** The live ranged weather penalty as { total, parts:[{label,value}] }. */
function weatherRangedPenalty() {
    let mods = [];
    try { mods = getActiveWeatherModifiers() ?? []; } catch (_) { mods = []; }
    const parts = mods
        .filter(m => m.target === "ranged")
        .map(m => ({ label: L(m.label), value: Number(m.value) || 0 }))
        .filter(p => p.value);
    return { total: parts.reduce((s, p) => s + p.value, 0), parts };
}

/** The Fast Draw to-hit penalty if the attacker has the status, else 0. */
function fastDrawPenalty(actor) {
    return actor?.statuses?.has?.("fastDraw") ? FAST_DRAW_PENALTY : 0;
}

/**
 * Resolve a weapon's listed range to a number of metres for the attacker.
 * The field is free-form: a plain number ("30") or a stat expression
 * ("BODYx4"). Stat tokens are substituted from the actor and the arithmetic
 * is evaluated via a Roll (safe — validated to digits/operators only).
 * Returns null when it can't be resolved (so bands show without distances).
 */
async function resolveWeaponRange(weapon, actor) {
    let raw = String(weapon?.system?.range ?? "").trim();
    if (!raw) return null;

    // Tolerate a trailing distance unit ("20m", "20 meters", "30 metres") so
    // a range typed with its unit still resolves to a number to scale the bands.
    raw = raw.replace(/\s*(?:m|meters?|metres?)\s*$/i, "").trim();
    if (!raw) return null;

    const n = Number(raw);
    if (Number.isFinite(n)) return n;

    const stats = actor?.system?.stats ?? {};
    const expr = raw
        .replace(/x/gi, "*")
        .replace(/[a-z]+/gi, (tok) => {
            const v = stats[tok.toLowerCase()]?.value;
            return v != null ? String(v) : tok;
        });
    if (!/^[\d+\-*/().\s]+$/.test(expr)) return null;
    try {
        const r = await new Roll(expr).evaluate();
        return Number.isFinite(r.total) ? Math.round(r.total) : null;
    } catch (_) {
        return null;
    }
}

/** Label one range band with its real reach for this weapon. */
function rangeDistanceLabel(bracket, baseRange) {
    if (bracket.frac == null) return "≤ 0.5m";          // point-blank is fixed
    if (baseRange == null)    return "";
    return `≤ ${Math.round(baseRange * bracket.frac)}m`;
}

/* ── HTML builders ─────────────────────────────────────────────────────── */

function buildContent(ctx) {
    const { weapon, offhandChoices, aimMod, weather, baseRange, fastDraw, forcedExtra, usesAmmo, ammoChoices, selectedAmmoId, aimRank, adrenaline, canFullRound } = ctx;
    const { ranged, variants, melee, aimBonus } = modeView(ctx);
    const cm = ctx.actor?.system?.combatMods ?? {};

    // Strike-type options. Basic strikes (normal/strong/fast) honour `variants`
    // (crossbows are normal-only). The Special Attacks are melee-only and live
    // under their own optgroup. Bows default to a Fast strike (two arrows);
    // everything else defaults to Normal.
    const defaultStrike = (usesAmmo && variants) ? "fast" : "normal";
    const strikeOption = ([key, s]) => {
        const bits = [];
        const stRed = key === "strong" ? cm.strongStrikePenaltyReduction
                    : key === "charge" ? cm.chargePenaltyReduction
                    : key === "joint"  ? cm.offhandPenaltyReduction : 0;
        const toHit = s.toHit < 0 ? Math.min(0, s.toHit + (Number(stRed) || 0)) : s.toHit;
        if (toHit)           bits.push(signed(toHit));
        if (s.noDamage)      bits.push("no dmg");
        else if (s.dmgMult !== 1) bits.push(`×${s.dmgMult} dmg`);
        if (s.attacks > 1)   bits.push(`${s.attacks} attacks`);
        if (s.nonLethal)     bits.push("non-lethal");
        if (s.fullRound)     bits.push("full round");
        // A full-round strike (Charge) can't be picked unless the whole turn is
        // still free — disable it and say why instead of letting it be chosen.
        const blocked = s.fullRound && !canFullRound;
        if (blocked) bits.push(L("WITCHER.Attack.NeedsFullRound"));
        const tail = bits.length ? ` (${bits.join(", ")})` : "";
        const sel  = (key === defaultStrike && !blocked) ? " selected" : "";
        return `<option value="${key}"${sel}${blocked ? " disabled" : ""}>${esc(L(s.labelKey))}${esc(tail)}</option>`;
    };
    const entries = Object.entries(STRIKE_TYPES);
    const basicOpts = entries
        .filter(([key, s]) => !s.meleeOnly && (variants || key === "normal"))
        .map(strikeOption).join("");
    // Off-hand strikes (Joint Attack) only appear when a valid off-hand weapon
    // exists; with a two-handed main weapon there are none, so joint is hidden.
    const specialOpts = melee
        ? entries.filter(([, s]) => s.meleeOnly && (!s.offhand || offhandChoices.length))
            .map(strikeOption).join("")
        : "";
    const strikeOpts = specialOpts
        ? `${basicOpts}<optgroup label="${esc(L("WITCHER.Attack.SpecialAttacks"))}">${specialOpts}</optgroup>`
        : basicOpts;

    // Off-hand weapon picker (Joint Attack / Dual Wielding, Core p.163). Hidden
    // until a strike with `offhand` is chosen; lists the actor's OTHER equipped
    // one-handed melee weapons. The second attack is rolled with this weapon.
    const offhandOpts = offhandChoices
        .map(w => `<option value="${esc(w.id)}">${esc(w.name)}</option>`).join("");
    const offhandBlock = offhandChoices.length ? `
        <div class="wdm-atk-field wdm-atk-field-wide" data-offhand-field style="display:none;">
            <label>${esc(L("WITCHER.Attack.OffHandWeapon"))}</label>
            <select name="offhand">${offhandOpts}</select>
        </div>` : "";

    // Adrenaline dice field — each die adds +1d6 to the damage roll and costs
    // 10 STA when the attack is rolled. Only shown when the actor has a pool.
    const adrenalineField = adrenaline > 0 ? `
        <div class="wdm-atk-field">
            <label>${esc(L("WITCHER.Attack.AdrenalineDice"))}</label>
            <input type="number" name="adrenaline" step="1" min="0" max="${adrenaline}" value="0" data-adr-max="${adrenaline}" />
        </div>` : "";

    // Unaware / inanimate target: the shot is resolved against a flat range DC
    // (Core static-target rule) instead of a contested defense, so hit location
    // and situational defender mods don't apply. This static-DC path is the
    // ONLY place opponent size factors in (Core p.164), and only for ranged.
    // A readout of every band's DC, with the active one highlighted in refresh().
    const dcRows = RANGE_BRACKETS.map(r =>
        `<div class="wdm-atk-dc-row" data-dc-row="${r.value}">
            <span>${esc(L(r.labelKey))}</span><span>DC ${r.dc}</span>
        </div>`).join("");
    const inanimateBlock = `
        <label class="wdm-atk-check wdm-atk-inanimate">
            <input type="checkbox" name="inanimate" />
            <span>${esc(L("WITCHER.Attack.Inanimate"))}</span>
        </label>
        <div class="wdm-atk-dc-list" data-dc-list style="display:none;">
            <div class="wdm-atk-section-label">${esc(L("WITCHER.Attack.InanimateDCs"))}</div>
            ${dcRows}
        </div>`;

    // Location <select>: random tables first, then called shots with their
    // aimMod-adjusted penalty baked into the label.
    const locOpts = [
        `<option value="random:human">${esc(L("WITCHER.Attack.LocRandomHuman"))}</option>`,
        `<option value="random:monster">${esc(L("WITCHER.Attack.LocRandomMonster"))}</option>`,
        ...Object.entries(ATTACK_LOCATIONS).map(([key, loc]) => {
            const raw = loc.penalty + aimMod;
            const pen = raw < 0 ? Math.min(0, raw + (Number(cm.calledShotReduction) || 0)) : raw;
            const penTxt = pen ? ` (${signed(pen)})` : "";
            const multTxt = loc.mult !== 1 ? ` ×${loc.mult}` : "";
            return `<option value="loc:${key}">${esc(L(loc.labelKey))}${esc(penTxt)}${esc(multTxt)}</option>`;
        })
    ].join("");

    // Situational toggles (filter ranged-only ones out for melee).
    const sitRows = ATTACK_MODIFIERS
        .filter(m => ranged || !m.rangedOnly)
        .map(m => {
            const v = (ranged && m.rangedMod != null) ? m.rangedMod : m.mod;
            return `<label class="wdm-atk-check">
                <input type="checkbox" name="sit" value="${m.value}" data-mod="${v}" />
                <span>${esc(L(m.labelKey))} <em>${signed(v)}</em></span>
            </label>`;
        }).join("");

    // Target size options — every weapon (small targets are harder to hit,
    // large/huge easier). Default to Medium.
    const sizeOpts = SIZE_MODIFIERS.map(s =>
        `<option value="${s.value}"${s.value === "medium" ? " selected" : ""}>${esc(L(s.labelKey))}${s.mod ? ` (${signed(s.mod)})` : ""}</option>`
    ).join("");

    // Range bracket (ranged/thrown only). Each band is labelled with its real
    // reach for this weapon, derived from the listed range.
    const rangeBlock = ranged ? `
        <div class="wdm-atk-field">
            <label>${esc(L("WITCHER.Attack.RangeBracket"))}</label>
            <select name="range">
                ${RANGE_BRACKETS.map(r => {
                    const dist = rangeDistanceLabel(r, baseRange);
                    const distTxt = dist ? ` — ${dist}` : "";
                    const modTxt  = r.mod ? ` (${signed(r.mod)})` : "";
                    return `<option value="${r.value}"${r.value === "close" ? " selected" : ""}>${esc(L(r.labelKey))}${esc(distTxt)}${esc(modTxt)}</option>`;
                }).join("")}
            </select>
        </div>` : "";

    // Extra-action readout (display-only). There is no choice: a normal action
    // is always used when one is free; only when it's gone does the attack fall
    // to the extra action, and then this surfaces the auto-applied -3 / STA cost.
    const extraActionBlock = forcedExtra ? `
        <div class="wdm-atk-weather wdm-atk-extra">
            <span class="wdm-atk-weather-k"><i class="fa-solid fa-bolt-lightning"></i> ${esc(L("WITCHER.Attack.ExtraActionForced"))}</span>
            <span class="wdm-atk-weather-v">${signed(Math.min(0, EXTRA_ACTION.toHit + (Number(cm.extraActionPenaltyReduction) || 0)))}, ${Math.max(0, EXTRA_ACTION.staCost - (Number(cm.extraActionStaReduction) || 0))} STA</span>
        </div>` : "";

    // Fast Draw readout (display-only — auto-applied from the status, any weapon).
    const fastDrawBlock = fastDraw ? `
        <div class="wdm-atk-weather wdm-atk-fastdraw">
            <span class="wdm-atk-weather-k"><i class="fa-solid fa-bolt"></i> ${esc(L("WITCHER.Attack.FastDraw"))}</span>
            <span class="wdm-atk-weather-v">${signed(Math.min(0, fastDraw + (Number(cm.fastDrawPenaltyReduction) || 0)))}</span>
        </div>` : "";

    // Weather readout (ranged only, display-only — always applied).
    const weatherBlock = (ranged && weather.parts.length) ? `
        <div class="wdm-atk-weather">
            <span class="wdm-atk-weather-k"><i class="fa-solid fa-cloud-rain"></i> ${esc(L("WITCHER.Attack.Weather"))}</span>
            <span class="wdm-atk-weather-v">${signed(weather.total)}</span>
            <div class="wdm-atk-weather-parts">${
                weather.parts.map(p => `${esc(p.label)} ${signed(p.value)}`).join(" · ")
            }</div>
        </div>` : "";

    // Bow ammo picker. The first select always shows; the second is revealed by
    // refresh() only for a Fast strike (two arrows). Both default to the weapon's
    // current selection.
    const ammoOption = (a, sel) => `<option value="${esc(a.id)}"${a.id === sel ? " selected" : ""}>${esc(a.name)} (×${esc(a.qty)})</option>`;
    const ammoOpts = (sel) => ammoChoices.map(a => ammoOption(a, sel)).join("");
    const ammoBlock = (usesAmmo && ammoChoices.length) ? `
        <div class="wdm-atk-ammo">
            <div class="wdm-atk-field wdm-atk-field-wide">
                <label data-ammo1-label>${esc(L("WITCHER.Attack.Ammo"))}</label>
                <select name="ammo1">${ammoOpts(selectedAmmoId)}</select>
            </div>
            <div class="wdm-atk-field wdm-atk-field-wide" data-ammo2 style="display:none;">
                <label>${esc(L("WITCHER.Attack.AmmoShot2"))}</label>
                <select name="ammo2">${ammoOpts(selectedAmmoId)}</select>
            </div>
        </div>` : "";

    // Aim is no longer a manual field — it's read from the actor's Aim status
    // (built up by the full-round Aim action) and applied automatically. Show
    // it read-only when the attacker is aiming a ranged shot.
    const aimCell = (ranged && aimBonus) ? `
            <div class="wdm-atk-field">
                <label>${esc(L("WITCHER.Attack.Aim"))}</label>
                <div class="wdm-atk-readonly" title="${esc(L("WITCHER.Attack.AimAutoHint"))}">${signed(aimBonus)} (Aim ${esc(aimRank)})</div>
            </div>` : "";

    // Mode toggle (dual-mode thrown weapons only): throw it or strike in hand.
    // Changing it re-renders the card (see openAttackDialog render hook).
    const modeField = ctx.dualMode ? `
            <div class="wdm-atk-field">
                <label>${esc(L("WITCHER.Attack.Mode"))}</label>
                <select name="mode">
                    <option value="thrown"${ctx.mode === "thrown" ? " selected" : ""}>${esc(L("WITCHER.Attack.ModeThrown"))}</option>
                    <option value="melee"${ctx.mode === "melee" ? " selected" : ""}>${esc(L("WITCHER.Attack.ModeMelee"))}</option>
                </select>
            </div>` : "";

    return `
    <div class="wdm-atk" data-ranged="${ranged ? "1" : "0"}">
        <div class="wdm-atk-grid">
            ${modeField}
            <div class="wdm-atk-field">
                <label>${esc(L("WITCHER.Attack.Strike"))}</label>
                <select name="strike">${strikeOpts}</select>
            </div>
            ${aimCell}
            <div class="wdm-atk-field wdm-atk-field-wide" data-loc-field>
                <label>${esc(L("WITCHER.Attack.Location"))}</label>
                <select name="location">${locOpts}</select>
            </div>
            <div class="wdm-atk-field" data-size-field>
                <label>${esc(L("WITCHER.Attack.TargetSize"))}</label>
                <select name="size">${sizeOpts}</select>
            </div>
            <div class="wdm-atk-field">
                <label>${esc(L("WITCHER.Attack.OtherMod"))}</label>
                <input type="number" name="otherMod" step="1" value="0" />
            </div>
            ${adrenalineField}
        </div>

        <div class="wdm-atk-note" data-strike-note></div>
        ${offhandBlock}
        ${ranged ? inanimateBlock : ""}
        ${extraActionBlock}
        ${rangeBlock}
        ${ammoBlock}

        <div class="wdm-atk-sit-block" data-sit-block>
            <div class="wdm-atk-section-label">${esc(L("WITCHER.Attack.Situational"))}</div>
            <div class="wdm-atk-checks">${sitRows}</div>
        </div>

        ${fastDrawBlock}
        ${weatherBlock}

        <div class="wdm-atk-total">
            <span class="wdm-atk-total-k">${esc(L("WITCHER.Attack.TotalToHit"))}</span>
            <span class="wdm-atk-total-v" data-total>1d10</span>
        </div>
        <div class="wdm-atk-breakdown" data-breakdown></div>
        <div class="wdm-atk-adr-readout" data-adr-readout></div>
    </div>`;
}

/* ── Read + compute ────────────────────────────────────────────────────── */

/** Read the dialog DOM into the structured result + a chip breakdown. */
function collect(root, ctx) {
    const { aimMod, weather, fastDraw, forcedExtra } = ctx;
    const q = (sel) => root.querySelector(sel);

    // Keep ctx.mode in sync with the live toggle so modeView resolves correctly
    // even if collect runs before a re-render lands.
    if (ctx.dualMode) {
        const m = q('[name="mode"]')?.value;
        if (m) ctx.mode = m;
    }
    const { ranged, base } = modeView(ctx);

    const strikeKey = q('[name="strike"]')?.value || "normal";
    const strike    = STRIKE_TYPES[strikeKey] ?? STRIKE_TYPES.normal;

    // Off-hand weapon for a Joint Attack (Dual Wielding, Core p.163): the second
    // attack is rolled with this weapon. Only read when the strike requires it.
    const offhandId = (strike.offhand && ctx.offhandChoices?.length)
        ? (q('[name="offhand"]')?.value || ctx.offhandChoices[0].id)
        : null;

    // Inanimate / unaware target → resolve vs a flat range DC; defender-only
    // mods (hit location, size, situational) are switched off.
    const inanimate = !!q('[name="inanimate"]')?.checked;

    // Bow ammo: one chosen round per shot (Fast = two). null when not a bow or
    // no eligible ammo, leaving the mixin to fall back to the weapon's selection.
    let ammo = null;
    if (ctx.usesAmmo && ctx.ammoChoices?.length) {
        const fallback = ctx.selectedAmmoId || ctx.ammoChoices[0].id;
        const a1 = q('[name="ammo1"]')?.value || fallback;
        const attacks = Math.max(1, strike.attacks ?? 1);
        ammo = attacks > 1 ? [a1, q('[name="ammo2"]')?.value || a1] : [a1];
    }

    // No player choice: the extra action (and its -3) is used only when forced,
    // i.e. no normal action is left this turn.
    const extraAction = !!forcedExtra;
    // Aim is auto-applied from the actor's Aim status (ranged only) — not a
    // form field. The mixin clears the status after the shot.
    const aimBonus = (ranged && modeView(ctx).aimBonus) ? Number(modeView(ctx).aimBonus) : 0;
    const otherMod    = Math.round(Number(q('[name="otherMod"]')?.value) || 0);

    // Adrenaline dice committed to this attack — clamped to the actor's pool.
    // Adds to DAMAGE (not the to-hit), so it never enters modTotal/grandMod.
    const adrPool = Math.max(0, Number(ctx.adrenaline) || 0);
    const adrenalineDice = Math.min(adrPool, Math.max(0, Math.round(Number(q('[name="adrenaline"]')?.value) || 0)));

    // Location — switched off (no called shots / damage multiplier) against an
    // inanimate target.
    const locVal = q('[name="location"]')?.value || "random:human";
    let location;
    if (inanimate) {
        location = { mode: "none", penalty: 0, mult: 1, label: "" };
    } else if (locVal.startsWith("random:")) {
        location = { mode: "random", kind: locVal.split(":")[1] || "human", penalty: 0, mult: null, label: L(locVal.endsWith("monster") ? "WITCHER.Attack.LocRandomMonster" : "WITCHER.Attack.LocRandomHuman") };
    } else {
        const key = locVal.split(":")[1];
        const loc = ATTACK_LOCATIONS[key];
        location = { mode: "specific", key, penalty: (loc?.penalty ?? 0) + aimMod, mult: loc?.mult ?? 1, label: L(loc?.labelKey ?? key) };
    }

    // Range bracket. For an inanimate target the bracket picks the flat DC; its
    // contested to-hit modifier is dropped (the DC already encodes the range).
    const rangeKey = ranged ? (q('[name="range"]')?.value || "close") : "close";
    const rangeDef = RANGE_BRACKETS.find(r => r.value === rangeKey) ?? RANGE_BRACKETS[0];
    const range = { key: rangeKey, mod: inanimate ? 0 : rangeDef.mod, label: L(rangeDef.labelKey) };

    // The flat target DC for an unaware/inanimate shot: the active range band's
    // DC. Only reachable when ranged — the checkbox is ranged-only (Core p.164;
    // melee vs unaware is still an opposed defense + Ambush +5, p.153).
    const targetDC = inanimate ? rangeDef.dc : null;

    // Target size — RAW it augments only the static target DC of an unaware /
    // inanimate RANGED target (Core p.164). An opposed defense (every melee
    // attack, and any aware ranged target) rolls against the defender, where
    // size never applies. Only folded into the to-hit when ranged && inanimate.
    const sizeKey = q('[name="size"]')?.value || "medium";
    const sizeDef = SIZE_MODIFIERS.find(s => s.value === sizeKey) ?? SIZE_MODIFIERS[0];
    const size = { key: sizeKey, mod: sizeDef.mod, label: L(sizeDef.labelKey) };

    // Situational toggles — defender-relative, so none apply to an object.
    const situational = inanimate ? [] : [...root.querySelectorAll('[name="sit"]:checked')].map(el => {
        const def = ATTACK_MODIFIERS.find(m => m.value === el.value);
        return { value: el.value, mod: Number(el.dataset.mod) || 0, label: L(def?.labelKey ?? el.value) };
    });

    // Assemble the modifier chip breakdown + total (base skill/WA chips are
    // display-only; modTotal is everything the dialog adds on top).
    const chips = [];
    let modTotal = 0;
    const add = (label, value) => { if (value) { modTotal += value; chips.push({ label, value }); } };

    // Combat-passive penalty reductions (system.combatMods): a positive amount
    // shaves a negative penalty toward 0 (3 nullifies a −3). School passives are
    // AEs on the profession/gear; this folds them into the live total + roll.
    const cm = ctx.actor?.system?.combatMods ?? {};
    const reduce = (pen, amt) => pen < 0 ? Math.min(0, pen + (Number(amt) || 0)) : pen;
    const strikeRed = strikeKey === "strong" ? cm.strongStrikePenaltyReduction
                    : strikeKey === "charge" ? cm.chargePenaltyReduction
                    : strikeKey === "joint"  ? cm.offhandPenaltyReduction
                    : 0;

    if (strike.toHit) add(L(strike.labelKey), reduce(strike.toHit, strikeRed));
    // Off-hand weapon attack: -3 (a joint strike already includes its own -3).
    if (ctx.mainIsOffhand && !strike.offhand) add(L("WITCHER.Attack.OffHand"), reduce(OFFHAND_PENALTY, cm.offhandPenaltyReduction));
    if (extraAction)  add(L("WITCHER.Attack.ExtraAction"), reduce(EXTRA_ACTION.toHit, cm.extraActionPenaltyReduction));
    if (aimBonus)     add(L("WITCHER.Attack.Aim"), aimBonus);
    if (location.mode === "specific" && location.penalty) add(location.label, reduce(location.penalty, cm.calledShotReduction));
    if (ranged && inanimate && size.mod) add(size.label, size.mod);
    for (const s of situational) add(s.label, s.mod);
    if (range.mod) add(range.label, range.mod);
    if (fastDraw) add(L("WITCHER.Attack.FastDraw"), reduce(fastDraw, cm.fastDrawPenaltyReduction));
    if (ranged && weather.total) add(L("WITCHER.Attack.Weather"), weather.total);
    if (otherMod) add(L("WITCHER.Attack.OtherMod"), otherMod);

    return {
        mode: ctx.dualMode ? ctx.mode : null,
        strike: strikeKey, strikeMeta: strike, offhandId, adrenalineDice,
        extraAction, aimBonus, aimRank: ctx.aimRank ?? 0,
        location, range, size, situational, otherMod, fastDraw, ammo,
        inanimate, targetDC,
        weather: ranged ? weather : { total: 0, parts: [] },
        chips, modTotal,
        grandMod: (base?.total ?? 0) + modTotal
    };
}

/** Repaint the live total + breakdown from the current form state. */
function refresh(root, ctx) {
    const r = collect(root, ctx);
    const mv = modeView(ctx);
    const totalEl = root.querySelector("[data-total]");
    if (totalEl) totalEl.textContent = r.grandMod ? `1d10 ${signed(r.grandMod)}` : "1d10";

    // Adrenaline dice: clamp the input to the pool and echo the damage/STA cost.
    const adrInput = root.querySelector('[name="adrenaline"]');
    if (adrInput) {
        const max = Number(adrInput.dataset.adrMax) || 0;
        const v = Math.max(0, Math.min(max, Math.round(Number(adrInput.value) || 0)));
        if (String(v) !== adrInput.value) adrInput.value = String(v);
        const ro = root.querySelector("[data-adr-readout]");
        if (ro) ro.textContent = v > 0
            ? L("WITCHER.Attack.AdrenalineReadout").replace("{dice}", v).replace("{sta}", v * adrenalineStaPerDie())
            : "";
    }

    // Off-hand weapon picker: shown only for a strike that requires one (Joint
    // Attack). Hidden for every other strike.
    const strikeKey = root.querySelector('[name="strike"]')?.value || "normal";

    // Info box: describe the selected strike (every STRIKE_TYPES entry carries a
    // `note`). Updated here because the card isn't rebuilt on a strike change.
    const noteEl = root.querySelector("[data-strike-note]");
    if (noteEl) {
        const noteKey = STRIKE_TYPES[strikeKey]?.note;
        noteEl.innerHTML = noteKey ? `<i class="fa-solid fa-circle-info"></i> ${esc(L(noteKey))}` : "";
        noteEl.style.display = noteKey ? "" : "none";
    }

    const needsOffhand = !!STRIKE_TYPES[strikeKey]?.offhand;
    const offhandField = root.querySelector("[data-offhand-field]");
    if (offhandField) offhandField.style.display = needsOffhand ? "" : "none";

    // A Fast strike looses two arrows — reveal the second ammo picker and
    // relabel the first as "1st shot".
    const fast = (root.querySelector('[name="strike"]')?.value || "normal") === "fast";
    const ammo2 = root.querySelector("[data-ammo2]");
    if (ammo2) ammo2.style.display = fast ? "" : "none";
    const ammo1Label = root.querySelector("[data-ammo1-label]");
    if (ammo1Label) ammo1Label.textContent = L(fast ? "WITCHER.Attack.AmmoShot1" : "WITCHER.Attack.Ammo");

    // Inanimate target: hide the defender-only sections, reveal the DC list,
    // and highlight the band whose DC this shot is rolling against.
    const inanimate = !!root.querySelector('[name="inanimate"]')?.checked;
    const show = (sel, on) => { const el = root.querySelector(sel); if (el) el.style.display = on ? "" : "none"; };
    show("[data-loc-field]", !inanimate);
    show("[data-sit-block]", !inanimate);
    show("[data-dc-list]", inanimate);
    // Size only matters on the ranged target-DC path (unaware/inanimate) — hide
    // it for melee and for aware ranged targets, where the roll is opposed.
    show("[data-size-field]", mv.ranged && inanimate);
    const activeBand = mv.ranged ? (root.querySelector('[name="range"]')?.value || "close") : "pointBlank";
    root.querySelectorAll("[data-dc-row]").forEach(el =>
        el.classList.toggle("is-active", el.dataset.dcRow === activeBand));

    const bdEl = root.querySelector("[data-breakdown]");
    if (bdEl) {
        const baseChips = (mv.base?.chips ?? []).map(c =>
            `<span class="wdm-atk-chip is-base"><span class="k">${esc(c.label)}</span><span class="v">${esc(c.value)}</span></span>`);
        const modChips = r.chips.map(c =>
            `<span class="wdm-atk-chip ${c.value < 0 ? "is-neg" : "is-pos"}"><span class="k">${esc(c.label)}</span><span class="v">${signed(c.value)}</span></span>`);
        bdEl.innerHTML = [...baseChips, ...modChips].join("");
    }
}

/* ── Public entry ──────────────────────────────────────────────────────── */

/**
 * Open the attack dialog.
 * @param {Item}  weapon  weapon item being fired
 * @param {Actor} actor   attacker
 * @param {object} opts    { base:{ total, chips } } — the skill/WA portion the
 *                         mixin already computed, shown read-only in the card
 * @returns {Promise<object|null>}  the collect() result, or null on cancel
 */
export async function openAttackDialog(weapon, actor, opts = {}) {
    const ranged    = isRangedWeapon(weapon);
    const variants  = allowsStrikeVariants(weapon);
    const melee     = weapon?.system?.weaponType === "melee";
    // A thrown weapon with a melee skill can be struck in hand OR thrown; the
    // card offers a mode toggle. Default to thrown (its primary use).
    const dualMode  = weapon?.system?.weaponType === "thrown" && !!weapon?.system?.meleeSkillKey;
    const mode      = "thrown";

    // Off-hand candidates for a Joint Attack: the actor's OTHER EQUIPPED
    // one-handed melee or thrown weapons (a quick throwing axe equipped in the
    // off hand counts; ranged bows/crossbows don't). Must be equipped — an
    // equipped quick item already sits in a hand slot, so this still includes
    // it; unequipped weapons in the pack do not qualify. A two-handed MAIN
    // weapon fills both hands, so it can't joint-attack at all → empty list.
    // The off-hand itself must also be one-handed. No candidates → the joint
    // strike is hidden (see specialOpts gating in buildContent).
    // A dual-mode thrown weapon can joint-attack in its melee mode, so build the
    // candidate list for it too (the joint strike is still hidden unless melee
    // mode is the active one — see specialOpts gating).
    const mainTwoHanded = weapon?.system?.hands === "two";
    const offhandChoices = ((melee || dualMode) && !mainTwoHanded)
        ? (actor?.items ?? []).filter(i =>
              i.type === "weapon" && i.id !== weapon.id
              && (i.system?.weaponType === "melee" || i.system?.weaponType === "thrown")
              && i.system?.hands !== "two"
              && i.system?.equipped)
            .map(i => ({ id: i.id, name: i.name }))
        : [];
    const aimMod    = Number(actor?.system?.derivedStats?.aimMod) || 0;
    const weather   = ranged ? weatherRangedPenalty() : { total: 0, parts: [] };
    const baseRange = ranged ? await resolveWeaponRange(weapon, actor) : null;
    const fastDraw  = fastDrawPenalty(actor);
    // The dock gates on hasActionSlot before opening, so if no normal action
    // remains the only slot left is the extra action — forced, with its -3.
    const forcedExtra = actor?.nextActionSlot === "extra";

    // Bow ammo selection: bows (no chamber) draw a round at fire time, so the
    // player picks which eligible arrow to loose. Crossbows fire what's already
    // chambered, so they get no picker here.
    const usesAmmo = !!weapon.usesAmmo && !weapon.hasChamber;
    const ammoChoices = usesAmmo
        ? (weapon.getEligibleAmmo?.() ?? []).map(e => ({ id: e.item.id, name: e.item.name, qty: e.qty }))
        : [];
    const selectedAmmoId = usesAmmo ? (weapon.getSelectedAmmo?.()?.id ?? "") : "";

    // Aim is read from the actor's Aim status (built by the full-round Aim
    // action) and applies to ranged shots only. The mixin clears it after firing.
    const aimRank  = ranged ? (Number(actor?.aimRank) || 0) : 0;
    const aimBonus = Math.min(AIM_BONUS_CAP, aimRank * AIM_BONUS_PER_TURN);

    // Adrenaline pool (optional rule, Core p.176): each die the player commits
    // adds +1d6 to this attack's damage. Capped at the actor's current pool.
    const adrenaline = isAdrenalineEnabled() ? Math.max(0, Number(actor?.system?.adrenaline?.value) || 0) : 0;

    // Attacking with the off-hand weapon itself is -3 (added in collect for
    // non-joint strikes; joint carries its own -3).
    const mainIsOffhand = isOffhandWeapon(weapon);

    // Whether a full-round strike (Charge) can be taken this turn — gates the
    // Charge option in the strike picker. Defaults to true if the actor predates
    // the getter (out-of-combat / non-combatant).
    const canFullRound = actor?.canTakeFullRound !== false;

    const ctx = { weapon, actor, base: opts.base ?? { total: 0, chips: [] }, meleeBase: opts.meleeBase ?? null, dualMode, mode, ranged, variants, melee, offhandChoices, mainIsOffhand, aimMod, weather, baseRange, fastDraw, forcedExtra, usesAmmo, ammoChoices, selectedAmmoId, aimRank, aimBonus, adrenaline, canFullRound };

    const content = buildContent(ctx);

    const result = await foundry.applications.api.DialogV2.wait({
        window: { title: `${L("WITCHER.Attack.DialogTitle")} — ${weapon.name}`, icon: "fa-solid fa-crosshairs" },
        content,
        classes: ["wdm-atk-dialog"],
        buttons: [
            { action: "roll",   label: L("WITCHER.Attack.RollButton"), icon: "fa-solid fa-burst", default: true,
              callback: (_event, _button, dialog) => collect(dialog.element, ctx) },
            { action: "cancel", label: L("WITCHER.Cancel"), icon: "fa-solid fa-xmark" }
        ],
        rejectClose: false,
        render: (_event, dialog) => {
            const root = dialog.element;
            refresh(root, ctx);
            root.addEventListener("change", (e) => {
                // Switching melee/thrown mode swaps which whole card layout
                // applies (range vs strike variants, base skill), so rebuild it.
                if (ctx.dualMode && e.target?.name === "mode") {
                    ctx.mode = e.target.value;
                    const host = root.querySelector(".wdm-atk");
                    if (host) host.outerHTML = buildContent(ctx);
                }
                refresh(root, ctx);
            });
            root.addEventListener("input",  () => refresh(root, ctx));
        }
    }).catch(() => null);

    return (result && typeof result === "object") ? result : null;
}
