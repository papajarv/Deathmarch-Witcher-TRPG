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
    SIZE_MODIFIERS, EXTRA_ACTION, AIM_BONUS_PER_TURN, AIM_BONUS_CAP,
    DAMAGE_TYPES
} from "../setup/config.mjs";
import { getActiveStrikeTable } from "../data/combatExtended/actions.mjs";
import { WEAPON_QUALITIES as WQ_CATALOG } from "../setup/config.mjs";
import { ceTuneable, isCombatExtendedEnabled } from "../api/homebrew.mjs";
import { guardAttackMod, guardOf } from "../data/combatExtended/guards.mjs";

/* Map BOTH legacy (RAW) and Combat Extended strike keys to a canonical
 * category, used by the combat-mod-reduction lookups below ("the Strong-
 * Strike penalty reduction applies regardless of which ruleset names the
 * strike"). Legacy key → same category; CE rename → same category. New
 * CE-only categories map to themselves; an unknown key falls back to the
 * key itself, so dialog logic still works (just with no mod reduction
 * lookup hit). */
const STRIKE_CATEGORY = Object.freeze({
    normal: "normal",  single: "normal",
    strong: "strong",  strongAttack: "strong",
    fast:   "fast",    fastAttack: "fast",
    joint:  "joint",   jointAttack: "joint",
    charge: "charge",
    pommel: "pommel",  pommelStrike: "pommel",
    disarm: "disarm",
    trip:   "trip",
    feint:  "feint"
});
const cat = (key) => STRIKE_CATEGORY[key] ?? key;

/* Pick the first strike key in the active table whose category matches —
 * lets call sites say "the default plain swing" without caring whether
 * the active ruleset names it "normal" (RAW) or "single" (CE). */
const keyForCategory = (table, category) => {
    for (const [k, _v] of Object.entries(table)) {
        if (cat(k) === category) return k;
    }
    return null;
};
import { getActiveWeatherModifiers } from "../mechanics/weather-modifiers.mjs";
import { isAdrenalineEnabled, adrenalineStaPerDie } from "../api/adrenaline.mjs";
import { getActorTargets } from "../chrome/chrome/context-menu-actor.js";

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

/** Ranged-style weapon (accrues range/weather/point-blank). Only true
 *  for bows, crossbows, siege pieces — the dedicated ranged weaponType.
 *  Melee weapons that HAPPEN to have a range field (throwable) are NOT
 *  ranged in the "shoot from range" sense; the throw path is handled
 *  separately via canThrow + isThrownMode + isThrowStrike. */
export function isRangedWeapon(weapon) {
    const wt = weapon?.system?.weaponType;
    return wt === "ranged";
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
export async function resolveWeaponRange(weapon, actor, ammo = null) {
    let raw = String(weapon?.system?.range ?? "").trim();
    if (!raw) return null;

    // Tolerate a trailing distance unit ("20m", "20 meters", "30 metres") so
    // a range typed with its unit still resolves to a number to scale the bands.
    raw = raw.replace(/\s*(?:m|meters?|metres?)\s*$/i, "").trim();
    if (!raw) return null;

    let base = null;
    const n = Number(raw);
    if (Number.isFinite(n)) base = n;
    else {
        const stats = actor?.system?.stats ?? {};
        /* Accept multiple multiplication marks: ASCII x/X, Unicode × (U+00D7),
         * Unicode · (U+00B7), and asterisk (already valid). EO's pack ships
         * "BODY×1" with the Unicode × so the ASCII-x-only replace missed
         * it — parser returned null and the auto-bracket defaulted to
         * Close (0 mod), letting throws land with no distance penalty. */
        const expr = raw
            .replace(/[x×·]/gi, "*")
            .replace(/[a-z]+/gi, (tok) => {
                const v = stats[tok.toLowerCase()]?.value;
                return v != null ? String(v) : tok;
            });
        if (!/^[\d+\-*/().\s]+$/.test(expr)) return null;
        try {
            const r = await new Roll(expr).evaluate();
            base = Number.isFinite(r.total) ? r.total : null;
        } catch (_) {
            return null;
        }
    }
    if (base == null) return null;

    /* Ammo range modifier qualities (EO p.13 etc.):
     *   improvedRange → ×1.5, reducedRange → ×0.5
     * Both stack if a hypothetical ammo carried both, which would resolve
     * to ×0.75 — RAW doesn't address that case, fine to multiply through. */
    const ammoQs = ammo ? (ammo.system?.qualities ?? []) : [];
    if (ammoQs.includes("improvedRange")) base *= 1.5;
    if (ammoQs.includes("reducedRange"))  base *= 0.5;

    return Math.round(base);
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
    /* Read the active strike table once. When Combat Extended is OFF this
     * is STRIKE_TYPES verbatim (legacy keys); ON, it's the CE actions
     * reshaped to the STRIKE_TYPES contract. Storing it on ctx so collect
     * / refresh below can reuse it without re-resolving the setting. */
    const STRIKE_TABLE = getActiveStrikeTable(STRIKE_TYPES);
    ctx._strikeTable = STRIKE_TABLE;

    // Strike-type options. Basic strikes (normal/strong/fast) honour `variants`
    // (crossbows are normal-only). The Special Attacks are melee-only and live
    // under their own optgroup. Bows default to a Fast strike (two arrows);
    // everything else defaults to Normal.
    const NORMAL_KEY = keyForCategory(STRIKE_TABLE, "normal") ?? "normal";
    const FAST_KEY   = keyForCategory(STRIKE_TABLE, "fast")   ?? "fast";
    /* Thrown mode: default the strike to "throw" so the Throwing bonus
     * fires on submit. Computed after the canThrow gate below so we don't
     * read it before its definition — placeholder set here and overridden
     * once isThrownMode is known. */
    let defaultStrike = (usesAmmo && variants) ? FAST_KEY : NORMAL_KEY;
    const strikeOption = ([key, s]) => {
        const bits = [];
        const category = cat(key);
        const stRed = category === "strong" ? cm.strongStrikePenaltyReduction
                    : category === "charge" ? cm.chargePenaltyReduction
                    : category === "joint"  ? cm.offhandPenaltyReduction : 0;
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
    /* Prereq gate for CE-only strikes (Pin / Chokehold / Ride require
     * an active grapple state on the attacker; Escape requires any
     * hold). Returns true when the strike CAN be picked. Strikes
     * without a prereq pass through. Status keys checked: "grappled"
     * (RAW + CE) for grappling, plus pinned / suffocation for anyHold. */
    const passesPrereq = (s) => {
        const need = s?.prereq;
        if (!need) return true;
        const have = ctx.actor?.statuses ?? new Set();
        if (need === "grappling") return have.has?.("grappled");
        if (need === "anyHold")   return have.has?.("grappled") || have.has?.("pinned") || have.has?.("suffocation");
        return true;
    };
    /* Hefty (house variant): a Hefty weapon can't perform a Fast Strike —
     * the option is removed from the picker entirely. The player uses
     * Single Attack (RAW Normal) for one-swing, or Strong for one-swing-
     * at-bonus-damage. This is a clean filter rather than a clamp. */
    const weaponQualities = weapon?.system?.effective?.qualities ?? weapon?.system?.qualities ?? [];
    const heftyOnWeapon = weaponQualities.some(q => WQ_CATALOG[q]?.heftyBlocksFastStrike === true);
    /* Gate: the heftyBlocksFastStrike tuneable defaults ON (house variant
     * — filter Fast Strike out). When OFF, the picker still offers Fast
     * Strike on a Hefty weapon, and weaponAttackMixin clamps it to 1
     * attack as the EO RAW fallback. */
    const heftyBlocksFastOn = ceTuneable("heftyBlocksFastStrike") !== false;
    const passesHefty = (key) => {
        if (!(heftyOnWeapon && heftyBlocksFastOn)) return true;
        return cat(key) !== "fast";    /* hides "fast" + "fastAttack" */
    };
    const entries = Object.entries(STRIKE_TABLE);
    /* Throw strike gate:
     *
     *   - Combat Extended ON: ANY weapon with a range value can be
     *     thrown (one-handed OR two-handed — user spec: "every weapon
     *     in combat extended can be throwing"). The `throwing` quality
     *     still grants a per-weapon accuracy bonus on top; it isn't a
     *     gate.
     *   - RAW (CE off): gated to one-handed weapons with a non-empty
     *     range. The `range` field IS the throwability marker — the
     *     legacy `weaponType: "thrown"` distinction was collapsed into
     *     "melee with a range" (see WeaponData.migrateData).
     *
     * The throw itself always rolls Athletics (see weaponAttackMixin's
     * throwProf branch), and the chat card surfaces the weapon's range
     * so the defender knows the arc. */
    const wHands = weapon?.system?.hands ?? "one";
    const wRange = String(weapon?.system?.range ?? "").trim();
    /* `N/A` (case-insensitive) is the pack convention for "no throwable
     * range" — a bullwhip, bagh nakh, or medical syringe carries the
     * field so the sheet renders cleanly but shouldn't unlock the throw
     * strike. `--` and `-` are alternative sentinels seen in the wild. */
    const hasRealRange = wRange.length > 0
        && !/^n\/?a$/i.test(wRange)
        && wRange !== "-"
        && wRange !== "--";
    let ceOn = false;
    try { ceOn = isCombatExtendedEnabled(); } catch (_) { /* settings not ready */ }
    /* Throw eligibility.
     *   CE  : ANY melee weapon (any hand count) with a non-empty Range
     *         value can be thrown. Two-handed weapons included — user
     *         spec: "every weapon in combat extended can be throwing".
     *   RAW : gated to one-handed weapons that are natively thrown or
     *         carry the Throwing quality (preserves core-rules behavior). */
    const canThrow = ceOn
        ? hasRealRange
        : (wHands === "one" && hasRealRange);
    /* In THROWN mode (active mode on the dialog), the only strike is Throw —
     * the player committed to releasing the weapon. Surface it as the basic
     * (and only) option so the dialog doesn't show a hollow "Normal" pick
     * that silently skips the Throwing bonus. */
    const isThrownMode = canThrow
        && (ctx.mode === "thrown" || ctx.weapon?.system?.slot === "quick");
    if (isThrownMode) defaultStrike = "throw";
    /* Charging status locks the strike picker to Strong only. The
     * dock's Charge full-round action applies the `charging` status;
     * weaponAttack detects it and translates the Strong strike →
     * Charge strike post-dialog so the fullRound + prone-on-block
     * rider machinery fires. Under CE the active strike table renames
     * keys (`strong` → `strongAttack`, `charge` → CE's own charge
     * entry), so we resolve the KEY via keyForCategory rather than
     * hardcoding — the same category ("strong") maps to whichever
     * key the active ruleset uses. */
    const _isCharging = !!ctx.actor?.statuses?.has?.("charging");
    const STRONG_KEY = keyForCategory(STRIKE_TABLE, "strong") ?? "strong";
    let basicOpts;
    if (isThrownMode) {
        basicOpts = entries
            .filter(([key]) => key === "throw")
            .map(strikeOption).join("");
    } else if (_isCharging) {
        basicOpts = entries
            .filter(([key]) => key === STRONG_KEY)
            .map(strikeOption).join("");
        if (basicOpts) defaultStrike = STRONG_KEY;
    } else {
        basicOpts = entries
            /* Charge is a full-round action driven from the dock's
             * Full Round menu (Dock → Full Round → Charge), not a
             * per-attack strike variant. Excluding it from the
             * attack-dialog picker so a player can't accidentally
             * pick it here and end up in an inconsistent state
             * (charge grants SPD×3 movement, which only the
             * full-round flow sets). The strike entry itself stays
             * in STRIKE_TYPES because `openChargeFlow` passes
             * `strike: "charge"` when it opens this dialog. */
            .filter(([key, s]) => !s.meleeOnly && (variants || cat(key) === "normal") && passesPrereq(s) && passesHefty(key) && key !== "charge")
            .map(strikeOption).join("");
    }
    // Off-hand strikes (Joint Attack) only appear when a valid off-hand weapon
    // exists; with a two-handed main weapon there are none, so joint is hidden.
    // Monster mode also excludes Feint per RAW (Sage's Answers — monsters
    // can't fast/strong/joint/feint).
    const excluded = ctx.excludedSpecials ?? null;
    /* Charging locks us to Strong only — no special attacks either. */
    const specialOpts = (melee && !isThrownMode && !_isCharging)
        ? entries.filter(([key, s]) =>
                s.meleeOnly
                && (!s.offhand || offhandChoices.length)
                && !(excluded && excluded.has(key))
                && passesPrereq(s)
                && passesHefty(key)
                /* Throw is its own basic strike in thrown mode (see
                 * isThrownMode → basicOpts above). Don't ALSO put it in
                 * the melee specials menu — the dialog UI in melee mode
                 * doesn't render range brackets, so a player who picked
                 * Throw here would throw without range/weather applied.
                 * Players who want to throw must flip the mode toggle. */
                && key !== "throw"
                /* Charge lives in the Full Round menu — see filter
                 * comment on basicOpts above. Exclude here too so it
                 * doesn't appear in the Special Attacks optgroup. */
                && key !== "charge")
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

    /* Target-assignment picker.  Shown when at least one actor is
     * currently targeted (canvas or tracker).  The player MUST assign
     * each shot to one specific target — Strong Strike / Trip / Feint
     * / Joint / Normal all resolve as one attack against one opponent,
     * so they get a single dropdown.  Fast Strike gets a second
     * dropdown that reveals itself in `refresh()` — the two shots may
     * hit the same target or two different targets.  Targets left
     * unassigned (Fast shot 2 with no selection) simply don't get
     * struck; the mixin `continue`s that iteration. */
    const targetPool = Array.isArray(ctx.targetPool) ? ctx.targetPool : [];
    const targetOpts = targetPool
        .map(a => `<option value="${esc(a.uuid)}">${esc(a.name)}</option>`).join("");
    const targetBlock = targetPool.length ? `
        <div class="wdm-atk-targets-block" data-targets-block>
            <div class="wdm-atk-section-label">${esc(L("WITCHER.Attack.AssignTargets") || "Assign Target(s)")}</div>
            <div class="wdm-atk-grid">
                <div class="wdm-atk-field" data-target-row="1">
                    <label data-target-shot-label>${esc(L("WITCHER.Attack.TargetShot1") || "Target")}</label>
                    <select name="target1">${targetOpts}</select>
                </div>
                <div class="wdm-atk-field" data-target-row="2" style="display:none;">
                    <label>${esc(L("WITCHER.Attack.TargetShot2") || "Second Shot")}</label>
                    <select name="target2">${targetOpts}</select>
                </div>
            </div>
        </div>` : "";

    // Adrenaline dice field — each die adds +1d6 to the damage roll and costs
    // 10 STA when the attack is rolled. Only shown when the actor has a pool.
    const adrenalineField = adrenaline > 0 ? `
        <div class="wdm-atk-field">
            <label>${esc(L("WITCHER.Attack.AdrenalineDice"))}</label>
            <input type="number" name="adrenaline" step="1" min="0" max="${adrenaline}" value="0" data-adr-max="${adrenaline}" />
        </div>` : "";

    /* Damage-type picker. A weapon can list multiple damageTypes (a
     * spear does slashing OR piercing, a flaming sword does slashing OR
     * fire). The player picks ONE type per swing — radio buttons, not
     * checkboxes — so a hit lands as a single damage type against the
     * target's resistances/weaknesses. Bows/crossbows draw their damage
     * type from the loaded ammo (weapon has none), so the picker is
     * hidden for them. Only shown when there are ≥ 2 choices; a
     * single-type weapon needs no picker. */
    const weaponDamageTypes = (weapon?.system?.effective?.damageTypes ?? weapon?.system?.damageTypes ?? [])
        .filter(t => typeof t === "string" && t.length > 0);
    const showDamageTypePicker = !weapon?.system?.requiresAmmo && weaponDamageTypes.length >= 2;
    const damageTypeBlock = showDamageTypePicker ? `
        <div class="wdm-atk-dmgtype-block" data-dmgtype-block>
            <div class="wdm-atk-section-label">${esc(L("WITCHER.Attack.DamageTypes"))}</div>
            <div class="wdm-atk-checks">${
                weaponDamageTypes.map((t, i) => `
                    <label class="wdm-atk-check">
                        <input type="radio" name="dmgtype" value="${esc(t)}"${i === 0 ? " checked" : ""} />
                        <span>${esc(L(DAMAGE_TYPES[t] ?? t))}</span>
                    </label>`).join("")
            }</div>
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

    /* Range bracket (ranged/thrown only). Each band is labelled with its
     * real reach for this weapon, derived from the listed range.
     *
     * Auto-select the bracket that matches the target's actual token
     * distance when a target + measurable range are both present. The
     * player can still change it — this is a convenience default, not
     * a lock. Falls back to `close` when we can't measure (theater of
     * mind, no target set, or `baseRange` unresolved). */
    const targetDistanceM = Number(ctx.targetDistanceMeters);
    const autoBracketKey = (Number.isFinite(targetDistanceM) && Number.isFinite(baseRange) && baseRange > 0)
        ? (() => {
            if (targetDistanceM <= 0.5) return "pointBlank";
            for (const b of RANGE_BRACKETS) {
                if (b.frac == null) continue;
                if (targetDistanceM <= baseRange * b.frac) return b.value;
            }
            return "extreme";
          })()
        : "close";
    const rangeBlock = ranged ? `
        <div class="wdm-atk-field">
            <label>${esc(L("WITCHER.Attack.RangeBracket"))}</label>
            <select name="range">
                ${RANGE_BRACKETS.map(r => {
                    const dist = rangeDistanceLabel(r, baseRange);
                    const distTxt = dist ? ` — ${dist}` : "";
                    const modTxt  = r.mod ? ` (${signed(r.mod)})` : "";
                    return `<option value="${r.value}"${r.value === autoBracketKey ? " selected" : ""}>${esc(L(r.labelKey))}${esc(distTxt)}${esc(modTxt)}</option>`;
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
    // Melee is listed FIRST so a browser that ignores the `selected` attribute
    // (or the user popping the dropdown quickly) defaults to the in-hand swing
    // for a melee weapon — throwing your sword should be the deliberate pick,
    // not the accidental one.
    /* Hover tooltip explains the throw-eligibility rule so the player
     * knows WHY the Thrown option is available (or isn't). Under the new
     * schema throwability = the weapon's Range field. CE lets any weapon
     * with a range be thrown (2h included); RAW only allows 1h. */
    const modeTip = ctx.dualMode
        ? "Throw eligibility: any weapon with a Range value (Combat Extended) or a one-handed weapon with a Range value (RAW)."
        : "";
    const modeField = ctx.dualMode ? `
            <div class="wdm-atk-field" title="${esc(modeTip)}">
                <label>${esc(L("WITCHER.Attack.Mode"))}</label>
                <select name="mode">
                    <option value="melee"${ctx.mode === "melee" ? " selected" : ""}>${esc(L("WITCHER.Attack.ModeMelee"))}</option>
                    <option value="thrown"${ctx.mode === "thrown" ? " selected" : ""}>${esc(L("WITCHER.Attack.ModeThrown"))}</option>
                </select>
            </div>` : "";
    /* Raw weapon-range display in thrown mode. Users want to see the
     * exact "Range" string from the weapon sheet (e.g. "10/20/30" or
     * "BODY×2") in the dialog when they've flipped to Thrown, without
     * having to interpret the parsed range brackets below. */
    const rawWeaponRange = String(ctx.weapon?.system?.range ?? "").trim();
    const isThrownModeView = ctx.dualMode && ctx.mode === "thrown";
    /* Use the weapon-sheet Range i18n key (which exists in every locale)
     * with a plain "Range" fallback in case of a locale miss — the
     * previous `WITCHER.Attack.Range` key wasn't defined, so the label
     * rendered as the raw key text. */
    const weaponRangeField = (isThrownModeView && rawWeaponRange) ? `
            <div class="wdm-atk-field">
                <label>${esc(L("WITCHER.Sheet.Weapon.Text.Range") || "Range")}</label>
                <div class="wdm-atk-readonly">${esc(rawWeaponRange)}</div>
            </div>` : "";

    return `
    <div class="wdm-atk" data-ranged="${ranged ? "1" : "0"}">
        <div class="wdm-atk-grid">
            ${modeField}
            ${weaponRangeField}
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
        ${targetBlock}
        ${offhandBlock}
        ${ranged ? inanimateBlock : ""}
        ${extraActionBlock}
        ${rangeBlock}
        ${ammoBlock}

        <div class="wdm-atk-sit-block" data-sit-block>
            <div class="wdm-atk-section-label">${esc(L("WITCHER.Attack.Situational"))}</div>
            <div class="wdm-atk-checks">${sitRows}</div>
        </div>

        ${damageTypeBlock}
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

    /* Active strike table — built once in buildContent and stashed on
     * ctx, so the dialog reads from a single resolved snapshot whether
     * CE is on or off. Falls back to STRIKE_TYPES if some earlier path
     * hasn't run buildContent (defensive). */
    const STRIKE_TABLE = ctx._strikeTable ?? STRIKE_TYPES;
    const NORMAL_KEY = keyForCategory(STRIKE_TABLE, "normal") ?? "normal";
    const strikeKey = q('[name="strike"]')?.value || NORMAL_KEY;
    const strike    = STRIKE_TABLE[strikeKey] ?? STRIKE_TABLE[NORMAL_KEY] ?? STRIKE_TYPES.normal;

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
    // inanimate target. Strikes that carry `fixedLoc` (e.g. Trip → leftLeg)
    // override the dialog picker: RAW Trip is a leg strike by definition,
    // not a called shot the player chooses.
    const locVal = q('[name="location"]')?.value || "random:human";
    let location;
    if (inanimate) {
        location = { mode: "none", penalty: 0, mult: 1, label: "" };
    } else if (strike?.fixedLoc && ATTACK_LOCATIONS[strike.fixedLoc]) {
        const key = strike.fixedLoc;
        const loc = ATTACK_LOCATIONS[key];
        location = { mode: "specific", key, penalty: (loc?.penalty ?? 0), mult: loc?.mult ?? 1, label: L(loc?.labelKey ?? key) };
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
    const strikeCat = cat(strikeKey);
    const strikeRed = strikeCat === "strong" ? cm.strongStrikePenaltyReduction
                    : strikeCat === "charge" ? cm.chargePenaltyReduction
                    : strikeCat === "joint"  ? cm.offhandPenaltyReduction
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
    /* Combat Extended guard contribution to the attack — Closed = −2,
     * Fool's = +2, Warding / Balanced = 0. Rolled into the dialog's
     * running total + chip breakdown so the player can see it BEFORE
     * committing to the shot; the resulting modTotal carries the
     * contribution into the roll formula. When CE / the guards
     * subsystem is off, `guardAttackMod` returns 0 and this is a
     * no-op. Live at dialog scope so switching guards mid-dialog isn't
     * a supported edge case (guards change out of the dialog, then you
     * open it). */
    const guardAtk = guardAttackMod(ctx.actor);
    if (guardAtk) add(`Guard (${guardOf(ctx.actor).key})`, guardAtk);

    /* Witchers Reborn — feint follow-up preview. A successful feint
     * (RAW or CE — both go through the same `feintAdvantage` flag)
     * stamps the feinted target's UUID on the attacker; if the
     * currently targeted actor matches, surface the +3 base + any
     * Pirouette add-on as their own chips so the player sees the
     * payoff BEFORE committing to the shot. The flag never applies
     * to the feint strike itself — only to the follow-up. */
    if (strikeKey !== "feint") {
        const SYS = "witcher-ttrpg-death-march";
        const feintAdvTargetUuid = ctx.actor?.getFlag?.(SYS, "feintAdvantage") || null;
        if (feintAdvTargetUuid) {
            const target = [...(game.user?.targets ?? [])][0]?.actor;
            if (target && target.uuid === feintAdvTargetUuid) {
                add("Feint", 3);
                const pir = Number(ctx.actor?.getFlag?.(SYS, "wr.pirouetteBonus")) || 0;
                if (pir > 0) add("Pirouette", pir);
            }
        }
    }

    if (otherMod) add(L("WITCHER.Attack.OtherMod"), otherMod);

    /* Damage-type picker: one type per swing (radio). No picker rendered
     * (single-type weapon or bow/crossbow) → override stays null so
     * downstream code falls back to the weapon's full damage-type list. */
    const pickedDmgType = root.querySelector('input[name="dmgtype"]:checked')?.value || null;
    const damageTypesOverride = pickedDmgType ? [pickedDmgType] : null;

    /* Per-shot target assignment.  Null when no picker was rendered
     * (target pool empty) → mixin falls back to its single-defender
     * resolution.  Non-null → array of UUIDs where index i is the
     * assigned target for shot i; Fast Strike carries up to 2, every
     * other strike carries 1. Empty string entries mean "unassigned"
     * (Fast shot 2 with no picked target) — the mixin skips that shot. */
    let targetUuids = null;
    const targetsBlock = root.querySelector("[data-targets-block]");
    if (targetsBlock) {
        const t1 = q('[name="target1"]')?.value || "";
        const isFast = cat(strikeKey) === "fast";
        if (isFast) {
            const t2 = q('[name="target2"]')?.value || "";
            targetUuids = [t1, t2].filter(Boolean);
        } else {
            targetUuids = t1 ? [t1] : [];
        }
    }

    return {
        mode: ctx.dualMode ? ctx.mode : null,
        strike: strikeKey, strikeMeta: strike, offhandId, adrenalineDice,
        extraAction, aimBonus, aimRank: ctx.aimRank ?? 0,
        location, range, size, situational, otherMod, fastDraw, ammo,
        inanimate, targetDC,
        damageTypes: damageTypesOverride,
        weather: ranged ? weather : { total: 0, parts: [] },
        chips, modTotal,
        grandMod: (base?.total ?? 0) + modTotal,
        targetUuids
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
    const STRIKE_TABLE = ctx._strikeTable ?? STRIKE_TYPES;
    const NORMAL_KEY = keyForCategory(STRIKE_TABLE, "normal") ?? "normal";
    const strikeKey = root.querySelector('[name="strike"]')?.value || NORMAL_KEY;

    // Info box: describe the selected strike (every strike-table entry
    // carries a `note`). Updated here because the card isn't rebuilt on a
    // strike change.
    const noteEl = root.querySelector("[data-strike-note]");
    if (noteEl) {
        const noteKey = STRIKE_TABLE[strikeKey]?.note;
        noteEl.innerHTML = noteKey ? `<i class="fa-solid fa-circle-info"></i> ${esc(L(noteKey))}` : "";
        noteEl.style.display = noteKey ? "" : "none";
    }

    const needsOffhand = !!STRIKE_TABLE[strikeKey]?.offhand;
    const offhandField = root.querySelector("[data-offhand-field]");
    if (offhandField) offhandField.style.display = needsOffhand ? "" : "none";

    // A Fast strike looses two arrows — reveal the second ammo picker and
    // relabel the first as "1st shot". Category-based so RAW "fast" and
    // CE "fastAttack" both trigger the second slot.
    const fast = cat(strikeKey) === "fast";
    const ammo2 = root.querySelector("[data-ammo2]");
    if (ammo2) ammo2.style.display = fast ? "" : "none";
    const ammo1Label = root.querySelector("[data-ammo1-label]");
    if (ammo1Label) ammo1Label.textContent = L(fast ? "WITCHER.Attack.AmmoShot1" : "WITCHER.Attack.Ammo");

    /* Target picker — Fast is the only strike where the second shot can
     * hit a different target than the first. Every other strike (Normal,
     * Strong, Trip, Feint, Joint) resolves as a single attack against
     * one target, so shot 2 stays hidden and shot 1's label drops the
     * "1st" qualifier. Joint's second roll still lands on the first-
     * shot's target — the mixin's per-shot loop reuses index 0 for
     * shot 1's UUID when the strike carries `offhand`. */
    const targetRow2 = root.querySelector('[data-target-row="2"]');
    if (targetRow2) targetRow2.style.display = fast ? "" : "none";
    const targetShotLabel = root.querySelector("[data-target-shot-label]");
    if (targetShotLabel) targetShotLabel.textContent = fast
        ? (L("WITCHER.Attack.TargetShot1") || "First Shot")
        : (L("WITCHER.Attack.Target") || "Target");

    // Inanimate target: hide the defender-only sections, reveal the DC list,
    // and highlight the band whose DC this shot is rolling against.
    const inanimate = !!root.querySelector('[name="inanimate"]')?.checked;
    const show = (sel, on) => { const el = root.querySelector(sel); if (el) el.style.display = on ? "" : "none"; };
    // Strikes with fixedLoc (e.g. RAW Trip → leftLeg) force the location —
    // hide the picker so the player can't override the strike's rule.
    const fixedLocStrike = !!STRIKE_TABLE[strikeKey]?.fixedLoc;
    show("[data-loc-field]", !inanimate && !fixedLocStrike);
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
    /* Monster mode (RAW Core p.153 — Sage's Answers): monsters can't use
     * Strong / Fast / Joint / Feint, but they CAN still do the other
     * special attacks (Charge, Pommel, Disarm, Trip) and the standard
     * Normal swing. The system also doesn't model range for monster
     * ranged attacks, so range/weather/ammo controls are stripped.
     *   variants = false   → strips Strong/Fast from the basic-strike list
     *   melee    = weapon's natural value → keeps the Special Attacks
     *                                       optgroup populated
     *   ranged   = false   → strips range bracket + weather + ammo picker
     *   offhandChoices = [] (below) → strips Joint Attack (gated on it)
     *   excludedSpecials  → drops Pommel Strike for monsters (no pommel
     *                       on a claw or bite). Feint stays — a wraith
     *                       can fake a high swing as much as a fencer.
     * The modifier panel + target row stay. */
    const monsterMode      = !!opts.monsterMode;
    const excludedSpecials = monsterMode ? new Set(["pommel"]) : null;
    /* Quick-slot equip = the actor's main hand is busy with a 2H weapon
     * or a different primary; the quick item is drawn ONLY to throw. No
     * melee strikes; mode is forced to thrown. */
    const inQuickSlot = weapon?.system?.slot === "quick";
    /* Dual-mode (Melee | Throw toggle): a melee weapon that has a range
     * value is throwable — the range field IS the throwability marker
     * under the new schema. Examples:
     *   - Iron Sword (range BODY×2)                 → dual-mode, no throw bonus
     *   - Dagger (range + throwing quality)         → dual-mode + throw bonus
     *   - Dart (was weaponType=thrown, now melee)   → dual-mode
     *   - Bow / Crossbow (weaponType=ranged)        → NOT dual-mode
     *   - Plain sword with no range                 → NOT dual-mode */
    const wType     = weapon?.system?.weaponType;
    /* Mirror the canThrow logic from buildContent (kept inline to avoid a
     * circular dep — buildContent needs the same answer derived from ctx).
     * CE: any weapon with a Range is throwable (2H included per user
     * spec). RAW: one-handed with a Range. Ranged weapons (bows,
     * crossbows) are never dual-mode — they have their own shot flow. */
    let setupCeOn = false;
    try { setupCeOn = isCombatExtendedEnabled(); } catch (_) { /* fall through */ }
    const wHandsSetup = weapon?.system?.hands ?? "one";
    const wRangeSetup = String(weapon?.system?.range ?? "").trim();
    const setupCanThrow = setupCeOn
        ? wRangeSetup.length > 0
        : (wHandsSetup === "one" && wRangeSetup.length > 0);
    const rawDualMode = setupCanThrow && wType === "melee";
    /* Quick-slot collapses dual-mode → throw-only. */
    const dualMode = monsterMode ? false : (rawDualMode && !inQuickSlot);
    /* Default mode picks the weapon's primary use:
     *   - Quick slot → always thrown (hands are busy with the main weapon)
     *   - Dual-mode weapon (melee with a range) → ALWAYS melee — melee
     *     is the standard use, throwing is the deliberate one-off act.
     *   - Everything else → melee. */
    const mode = inQuickSlot ? "thrown"
                : dualMode   ? "melee"
                :              "melee";
    const ranged    = monsterMode ? false
                     : inQuickSlot ? true
                     : isRangedWeapon(weapon) || (dualMode && mode === "thrown");
    const variants  = monsterMode ? false
                     : inQuickSlot ? false   /* thrown shots are normal-only */
                     : allowsStrikeVariants(weapon) || (dualMode && mode === "melee");
    const melee     = (wType === "melee" && !inQuickSlot);

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
    const offhandChoices = (!monsterMode && (melee || dualMode) && !mainTwoHanded)
        ? (actor?.items ?? []).filter(i =>
              i.type === "weapon" && i.id !== weapon.id
              && i.system?.weaponType === "melee"
              && i.system?.hands !== "two"
              && i.system?.equipped)
            .map(i => ({ id: i.id, name: i.name }))
        : [];
    const aimMod    = monsterMode ? 0 : (Number(actor?.system?.derivedStats?.aimMod) || 0);
    const weather   = ranged ? weatherRangedPenalty() : { total: 0, parts: [] };
    /* Pick up the currently-loaded/selected ammo before resolving range so
     * improvedRange/reducedRange ammo qualities scale the bracket distances
     * the dialog displays. */
    const loadedAmmo = weapon?.getSelectedAmmo?.()?.item ?? null;
    /* Parse the weapon's range whenever it CAN be thrown — not just when
     * `ranged` is already true. For a dual-mode weapon that opens in
     * melee mode, `ranged` is false at first render but the player can
     * flip to Thrown mid-dialog. Without this the bracket labels lose
     * their per-distance suffix and the auto-bracket falls back to
     * "close" because baseRange stays null. */
    const baseRange = (ranged || setupCanThrow)
        ? await resolveWeaponRange(weapon, actor, loadedAmmo)
        : null;
    /* Monsters don't fast-draw — they're never holstering a sheathed
     * weapon. Force the penalty to 0 (the same numeric shape the regular
     * path returns), so the fast-draw row hides cleanly via its truthy
     * check at render time. Passing an object here was producing NaN /
     * "[object Object]" in the to-hit total and the chip list. */
    const fastDraw  = monsterMode ? 0 : fastDrawPenalty(actor);
    // The dock gates on hasActionSlot before opening, so if no normal action
    // remains the only slot left is the extra action — forced, with its -3.
    const forcedExtra = actor?.nextActionSlot === "extra";

    // Bow ammo selection: bows (no chamber) draw a round at fire time, so the
    // player picks which eligible arrow to loose. Crossbows fire what's already
    // chambered, so they get no picker here.
    const usesAmmo = !monsterMode && (!!weapon.usesAmmo && !weapon.hasChamber);
    const ammoChoices = usesAmmo
        ? (weapon.getEligibleAmmo?.() ?? []).map(e => ({ id: e.item.id, name: e.item.name, qty: e.qty }))
        : [];
    const selectedAmmoId = usesAmmo ? (weapon.getSelectedAmmo?.()?.id ?? "") : "";

    // Aim is read from the actor's Aim status (built by the full-round Aim
    // action) and applies to ranged shots only. The mixin clears it after firing.
    const aimRank  = (!monsterMode && ranged) ? (Number(actor?.aimRank) || 0) : 0;
    const aimBonus = Math.min(AIM_BONUS_CAP, aimRank * AIM_BONUS_PER_TURN);

    // Adrenaline pool (optional rule, Core p.176): each die the player commits
    // adds +1d6 to this attack's damage. Capped at the actor's current pool.
    // Monsters don't have an adrenaline pool — force 0 in monster mode.
    const adrenaline = (!monsterMode && isAdrenalineEnabled())
        ? Math.max(0, Number(actor?.system?.adrenaline?.value) || 0)
        : 0;

    // Attacking with the off-hand weapon itself is -3 (added in collect for
    // non-joint strikes; joint carries its own -3).
    const mainIsOffhand = isOffhandWeapon(weapon);

    // Whether a full-round strike (Charge) can be taken this turn — gates the
    // Charge option in the strike picker. Defaults to true if the actor predates
    // the getter (out-of-combat / non-combatant).
    const canFullRound = actor?.canTakeFullRound !== false;

    /* Compute target-to-attacker token distance in metres so the range
     * bracket auto-selects sensibly (auto-select but overrideable, per
     * user spec). Reads Foundry's grid measure when both tokens exist;
     * falls back to null when either side is tokenless (theatre-of-mind)
     * so the dropdown reverts to its "close" default. */
    let targetDistanceMeters = null;
    try {
        const aTok = actor?.getActiveTokens?.()?.[0] ?? null;
        /* Target resolution order:
         *   1. Foundry canvas token target (game.user.targets)
         *   2. Tokenless combat-tracker target (actorTargetUuid flag) —
         *      if that target actor has a token on canvas, use it.
         * Without step 2 the auto-bracket + out-of-range gate silently
         * default to their "no target" behavior when the user is
         * targeting via the combat tracker rather than clicking the
         * enemy's token. */
        let dTok = Array.from(game.user?.targets ?? [])[0] ?? null;
        if (!dTok) {
            try {
                const uuid = game.user?.getFlag?.("witcher-ttrpg-death-march", "actorTargetUuid");
                if (uuid) {
                    const targetActor = await fromUuid(uuid);
                    dTok = targetActor?.getActiveTokens?.()?.[0] ?? null;
                }
            } catch (_) { /* leave null */ }
        }
        if (aTok && dTok && canvas?.grid) {
            /* Chebyshev-in-meters: matches the Witcher system's grid model
             * (diagonal-adjacent = 2 m at 1.5 m/tile, NOT 2.12 / 3 m).
             * Foundry's canvas.grid.measureDistance respects the scene's
             * diagonal-cost setting (5-10-5 / Euclidean) and would
             * misreport diagonals, so we inline max(|dx|, |dy|) instead. */
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
    } catch (_) { /* keep targetDistanceMeters null */ }

    /* Target assignment pool — every actor currently targeted (canvas
     * token + tokenless-flag list), deduped, minus the attacker. The
     * dialog surfaces a per-shot picker when this is non-empty: pool
     * = [] falls through to the mixin's single-defender resolution
     * (options.forceDefender / game.user.targets[0] / getActorTarget).
     * Pool ≥ 1 with N shot slots (Fast = 2, everything else = 1) forces
     * the player to assign each shot to a specific target so a Strong
     * Strike doesn't auto-broadcast to N enemies. */
    let targetPool = Array.from(game.user?.targets ?? [])
        .map(t => t?.actor)
        .filter(Boolean);
    if (!targetPool.length) {
        try {
            const tokenless = await getActorTargets();
            if (Array.isArray(tokenless) && tokenless.length) targetPool = tokenless;
        } catch (_) { /* soft-fail — leave empty */ }
    }
    const _seenTPool = new Set();
    targetPool = targetPool.filter(a => {
        if (!a || a === actor) return false;
        if (_seenTPool.has(a.uuid)) return false;
        _seenTPool.add(a.uuid);
        return true;
    });

    const ctx = { weapon, actor, base: opts.base ?? { total: 0, chips: [] }, meleeBase: opts.meleeBase ?? null, dualMode, mode, ranged, variants, melee, offhandChoices, mainIsOffhand, aimMod, weather, baseRange, targetDistanceMeters, fastDraw, forcedExtra, usesAmmo, ammoChoices, selectedAmmoId, aimRank, aimBonus, adrenaline, canFullRound, excludedSpecials, targetPool };

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
