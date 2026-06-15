/**
 * weaponAttackMixin — actor method for rolling a weapon attack.
 *
 * Composed onto WitcherActor (documents/actor.mjs). Exposes:
 *   actor.weaponAttack(weapon, options)   — roll an attack with a weapon
 *
 * Fired by clicking a weapon NAME in the actor-sheet combat tab or the
 * combat dock. Opens the attack modifier dialog (applications/attackDialog),
 * folds in everything the player declares (strike type, extra action, aiming,
 * hit location, situational mods, range bracket, live weather penalty), then
 * posts a chat card per shot through `extendedRoll` so the d10 explode/fumble
 * chain is uniform with skill rolls.
 *
 * Attack roll = 1d10 + (stat + skill rank + skill mod) + weapon accuracy
 *               + declared modifiers (the dialog's modTotal) + a flat caller
 *               modifier.
 *
 * The reads use the weapon's EFFECTIVE stats (post-enhancement) so socketed
 * runes / mods are already folded into accuracy, damage, types and qualities.
 *
 * Extra action spends 3 STA via combatRoundMixin.spendStamina. Strong strikes
 * carry a damage multiplier; fast strikes roll twice (two shots). Hit-location
 * damage multipliers are surfaced on the card; the damage pipeline applies
 * them downstream.
 *
 * NOTE: this layer does not yet spend ammunition — firing/consumption is the
 * next step. The roll reads what's chambered but leaves the count alone.
 */

import { extendedRoll } from "../../rolls/extendedRoll.mjs";
import { openAttackDialog, isRangedWeapon, isOffhandWeapon } from "../../applications/attackDialog.mjs";
import { STRIKE_TYPES, ATTACK_LOCATIONS, rollHitLocation, EXTRA_ACTION,
         getActiveWeaponQualities, WEAPON_QUALITIES, shieldBashDamage }
    from "../../setup/config.mjs";
import { isAdrenalineEnabled, adrenalineStaPerDie } from "../../api/adrenaline.mjs";
import { attackMod as statusAttackMod } from "../../mechanics/statusEngine.mjs";

const esc    = (s) => Handlebars.escapeExpression(String(s ?? ""));
const signed = (n) => `${n >= 0 ? "+" : ""}${n}`;

/** Resolve a set of quality KEYS to display labels via the active catalog,
 *  folding in any parameter value as "Label(value suffix)". Mirrors the dock's
 *  weaponQualityLabels so the card matches the combat-dock row. */
function qualityLabels(keys = [], values = {}, catalog = null) {
    if (!keys.length) return [];
    const cat = catalog ?? getActiveWeaponQualities() ?? WEAPON_QUALITIES;
    return keys.map((key) => {
        const entry = cat[key] ?? WEAPON_QUALITIES[key];
        if (!entry) return null;
        const param = entry.param ?? WEAPON_QUALITIES[key]?.param ?? null;
        let label = entry.label;
        if (param) {
            const raw = values[key];
            const v   = raw == null ? "" : String(raw).trim();
            if (v.length) label = `${entry.label}(${v}${param.suffix ?? ""})`;
        }
        return label;
    }).filter(Boolean);
}

/** Every quality on the shot: the weapon's effective qualities plus those of
 *  the round it fires. Pass `ammoItem` to use a specific round (a Fast strike
 *  can loose two different arrows); omit it to resolve the default loaded /
 *  nocked round. Deduped by label so a shared quality isn't listed twice. */
function shotQualityLabels(weapon, ammoItem = undefined) {
    const cat = getActiveWeaponQualities() ?? WEAPON_QUALITIES;
    const wq  = qualityLabels(
        weapon.system?.effective?.qualities ?? weapon.system?.qualities ?? [],
        weapon.system?.effective?.qualityValues ?? weapon.system?.qualityValues ?? {},
        cat
    );
    const ammo = (ammoItem !== undefined) ? ammoItem : defaultShotAmmo(weapon);
    const aq = ammo ? qualityLabels(ammo.system?.qualities ?? [], ammo.system?.qualityValues ?? {}, cat) : [];
    return [...new Set([...wq, ...aq])];
}

/** The round a weapon fires by default — chambered for crossbows, nocked
 *  (selected) for bows, null for melee. */
function defaultShotAmmo(weapon) {
    if (!weapon.usesAmmo) return null;
    if (weapon.hasChamber) {
        if ((Number(weapon.system?.loaded?.count) || 0) <= 0) return null;
        const ref = weapon.system?.loaded?.uuid;
        return (ref && typeof fromUuidSync === "function") ? fromUuidSync(ref) : null;
    }
    return weapon.getSelectedAmmo?.() ?? null;
}

/** Localize a stat label, falling back to the upper-cased key. */
function statName(statKey) {
    const key = String(statKey ?? "").toLowerCase();
    const out = game.i18n.localize(CONFIG.WITCHER.statLabel(key));
    return (!out || out.startsWith("WITCHER.")) ? key.toUpperCase() : out;
}

/** Build the attack chat-card header: actor + weapon, a subtitle of skill /
 *  damage types, a chip row of roll components, and the damage line (label,
 *  formula, and a button that rolls the damage). `damage` is
 *  { display, formula, types } — display is the human-readable formula
 *  ("2d6 ×2"), formula is the rollable expression ("(2d6)*2"). */
function attackRollFlavor({ actorName, weaponName, subtitle, chips = [], damage, qualities = [], note = "" }) {
    const qualitiesHtml = qualities.length
        ? `<div class="wdm-attack-qualities"><span class="wdm-attack-qualities-k">${esc(game.i18n.localize("WITCHER.Attack.Qualities"))}</span> ${esc(qualities.join(", "))}</div>`
        : "";
    const noteHtml = note
        ? `<div class="wdm-attack-note"><i class="fa-solid fa-circle-info"></i> ${esc(note)}</div>`
        : "";
    const chipHtml = chips
        .filter(c => c && c.value != null && c.value !== "")
        .map(c => `<span class="wdm-chip"><span class="wdm-chip-k">${esc(c.label)}</span><span class="wdm-chip-v">${esc(c.value)}</span></span>`)
        .join("");
    const locMult = Number(damage?.locMult) || 1;
    const locNote = (damage?.display && locMult !== 1)
        ? `<div class="wdm-attack-damage-note">${esc(game.i18n.localize("WITCHER.Attack.SubtractSP"))} ×${esc(locMult)}${damage.locLabel ? ` (${esc(damage.locLabel)})` : ""}</div>`
        : "";
    const damageHtml = damage?.display ? `
        <div class="wdm-attack-damage">
            <span class="wdm-attack-damage-k">${esc(game.i18n.localize("WITCHER.Attack.Damage"))}</span>
            <span class="wdm-attack-damage-v">${esc(damage.display)}</span>
            ${damage.formula ? `<button type="button" class="wdm-attack-damage-roll" data-action="wdm-roll-damage" data-formula="${esc(damage.formula)}" data-types="${esc(damage.types ?? "")}" data-loc-mult="${esc(locMult)}" data-loc-label="${esc(damage.locLabel ?? "")}"><i class="fa-solid fa-burst"></i> ${esc(game.i18n.localize("WITCHER.Attack.RollDamage"))}</button>` : ""}
        </div>${locNote}` : "";
    return `
        <div class="wdm-skill-head wdm-attack-head">
            <div class="wdm-skill-actor">${esc(actorName)}</div>
            <div class="wdm-skill-name">${esc(weaponName)}</div>
            ${subtitle ? `<div class="wdm-skill-sub">${esc(subtitle)}</div>` : ""}
            ${qualitiesHtml}
            ${chipHtml ? `<div class="wdm-skill-chips">${chipHtml}</div>` : ""}
            ${damageHtml}
            ${noteHtml}
        </div>`;
}

/** Roll a damage card from a clicked attack-card button. Reuses the source
 *  message's speaker so the damage is attributed to the attacker. */
async function rollDamageFromButton(btn) {
    const formula = btn?.dataset?.formula;
    if (!formula) return;
    const li  = btn.closest("[data-message-id]");
    const msg = li ? game.messages.get(li.dataset.messageId) : null;
    const speaker = msg?.speaker ?? ChatMessage.getSpeaker();
    const types = btn.dataset.types || "";
    const locMult = Number(btn.dataset.locMult) || 1;
    const locLabel = btn.dataset.locLabel || "";
    try {
        const roll = await new Roll(formula).evaluate();
        const head = game.i18n.localize("WITCHER.Attack.Damage");
        const note = locMult !== 1
            ? `<div class="wdm-attack-damage-note">${esc(game.i18n.localize("WITCHER.Attack.SubtractSP"))} ×${esc(locMult)}${locLabel ? ` (${esc(locLabel)})` : ""}</div>`
            : "";
        await roll.toMessage({
            speaker,
            flavor: `<h3>${esc(head)}${types ? ` — ${esc(types)}` : ""}</h3>${note}`
        });
    } catch (err) {
        console.error("witcher-ttrpg-death-march | damage roll failed", err);
        ui.notifications?.error("Damage roll failed — see console.");
    }
}

/** Wire the attack-card damage button. Called once during setup. */
export function installAttackChatHandlers() {
    Hooks.on("renderChatMessageHTML", (_msg, el) => {
        const btn = el.querySelector?.('button[data-action="wdm-roll-damage"]');
        if (btn && !btn.dataset.wired) {
            btn.dataset.wired = "1";
            btn.addEventListener("click", () => rollDamageFromButton(btn));
        }
    });
}

/** Default declaration used when the dialog is skipped — a plain normal
 *  attack against a random location, no situational modifiers. `forcedExtra`
 *  mirrors the dialog: when no normal action is left the shot uses the extra
 *  action and carries its -3 (the STA cost is spent by the action economy). */
function defaultDeclaration(baseTotal, forcedExtra = false, aimBonus = 0, offhandPenalty = 0) {
    let modTotal = 0;
    const chips = [];
    if (forcedExtra) {
        modTotal += EXTRA_ACTION.toHit;
        chips.push({ label: game.i18n.localize("WITCHER.Attack.ExtraActionForced"), value: EXTRA_ACTION.toHit });
    }
    if (offhandPenalty) {
        modTotal += offhandPenalty;
        chips.push({ label: game.i18n.localize("WITCHER.Attack.OffHand"), value: offhandPenalty });
    }
    if (aimBonus) {
        modTotal += aimBonus;
        chips.push({ label: game.i18n.localize("WITCHER.Attack.Aim"), value: aimBonus });
    }
    return {
        strike: "normal", strikeMeta: STRIKE_TYPES.normal,
        extraAction: forcedExtra, aimBonus,
        location: { mode: "random", kind: "human", penalty: 0, mult: null },
        range: { mod: 0 }, situational: [], otherMod: 0,
        weather: { total: 0, parts: [] }, chips, modTotal,
        grandMod: baseTotal + modTotal
    };
}

export const weaponAttackMixin = (Base) => class extends Base {

    /**
     * Roll an attack with a weapon. `weapon` is a WitcherItem of type
     * "weapon"; `options` may carry { dc, modifier, skipDialog }.
     *
     * Opens the attack modifier dialog (unless `options.skipDialog`), then
     * posts one chat card per shot. Returns the result of the last shot (or
     * null if the weapon is invalid or the dialog was cancelled).
     */
    async weaponAttack(weapon, options = {}) {
        // Shields bash as a Melee weapon (Core p.164) — they ride the same flow
        // as weapons, only their damage is derived from Punch (see damageFor).
        if (!weapon || (weapon.type !== "weapon" && weapon.type !== "shield")) return null;

        // Ranged weapons must be ready to fire. Chambered weapons (crossbows)
        // need a round in the chamber; bows need eligible ammo in an equipped
        // quiver. Refuse the attack outright if not — don't roll, don't spend.
        if (weapon.usesAmmo) {
            const ready = weapon.hasChamber ? weapon.isLoaded : !!weapon.getSelectedAmmo();
            if (!ready) {
                const key = weapon.hasChamber ? "WITCHER.Attack.NotLoaded" : "WITCHER.Attack.NoAmmo";
                ui.notifications?.warn(game.i18n.format(key, { name: weapon.name }));
                return null;
            }
        }

        // A weapon's roll profile: effective stats, the skill total behind it,
        // accuracy and the combined base to-hit. Factored so a Joint Attack's
        // off-hand weapon can be read with its own skill/accuracy.
        const readWeaponProfile = (w, skillKeyOverride = null) => {
            const weff = w.system?.effective ?? {};
            const wSkillKey = skillKeyOverride || w.system?.skillKey || "";
            const wsv = wSkillKey ? this._readSkillValues(wSkillKey) : null;
            const wAccuracy = Number(weff.accuracy ?? w.system?.accuracy) || 0;
            return { eff: weff, skillKey: wSkillKey, sv: wsv,
                     accuracy: wAccuracy, baseTotal: (wsv?.total ?? 0) + wAccuracy };
        };
        // Read-only skill/WA chips for a profile (shown at the top of the card).
        const baseChipsFor = (p) => [
            p.sv ? { label: statName(p.sv.meta.statKey), value: p.sv.statVal } : null,
            p.sv ? { label: "Skill", value: p.sv.skillVal } : null,
            p.sv && p.sv.skillMod ? { label: "Mod", value: signed(p.sv.skillMod) } : null,
            p.accuracy ? { label: "WA", value: signed(p.accuracy) } : null
        ].filter(Boolean);

        const mainProf   = readWeaponProfile(weapon);
        const flatMod    = Number(options.modifier) || 0;
        const baseTotal  = mainProf.baseTotal;

        // Read-only skill/WA chips shown at the top of the dialog card.
        const baseChips = baseChipsFor(mainProf);

        // Dual-mode thrown weapon (carries a meleeSkillKey): the card lets the
        // player throw it or strike in hand. Build the melee-mode profile too so
        // the dialog can show its base and the shot can roll the right skill.
        const dualMode  = weapon.system?.weaponType === "thrown" && !!weapon.system?.meleeSkillKey;
        const meleeProf = dualMode ? readWeaponProfile(weapon, weapon.system.meleeSkillKey) : null;
        const meleeBase = meleeProf ? { total: meleeProf.baseTotal, chips: baseChipsFor(meleeProf) } : null;

        // Aim (Core p.152): a ranged shot auto-consumes the actor's Aim status,
        // adding its rank bonus to the to-hit. The dialog reads the same rank
        // for its live preview; the skip-dialog path folds it in here. The
        // status is cleared after the shot(s) below.
        const isRanged = isRangedWeapon(weapon);
        const aimBonus = isRanged ? (Number(this.aimBonus) || 0) : 0;

        // Collect declared modifiers from the dialog (or fall back to a plain
        // normal attack when skipped).
        const cm = this.system?.combatMods ?? {};
        let decl;
        if (options.skipDialog) {
            const offRed = Number(cm.offhandPenaltyReduction) || 0;
            const offhandPenalty = isOffhandWeapon(weapon) ? Math.min(0, -3 + offRed) : 0;
            decl = defaultDeclaration(baseTotal, this.nextActionSlot === "extra", aimBonus, offhandPenalty);
        } else {
            decl = await openAttackDialog(weapon, this, { base: { total: baseTotal, chips: baseChips }, meleeBase });
            if (!decl) return null;   // player cancelled
        }

        // Which mode the attack resolved in. A dual-mode weapon thrown in melee
        // mode rolls the melee profile, isn't a ranged shot (no aim consume), and
        // stays in hand (no thrown-drop). skipDialog has no mode → defaults thrown.
        const useMelee   = dualMode && decl.mode === "melee";
        const activeProf = useMelee ? meleeProf : mainProf;
        const firedRanged = useMelee ? false : isRanged;

        // Extra action: the -3 to-hit is already folded into decl.modTotal. The
        // STA cost is NOT spent here — the caller (combat dock) routes an
        // extra-action declaration through the round's action economy
        // (recordExtraAction), which spends 3 STA only while in combat.

        // An inanimate/unaware target is hit against a flat range DC (set by
        // the dialog) rather than a contested defense. Fall back to the caller's
        // dc when the dialog wasn't used.
        const dc = decl.targetDC ?? options.dc ?? null;

        // Resolve the hit location. Called shots already carry their penalty in
        // decl.modTotal; a random location is rolled now (penalty 0) and only
        // contributes its damage multiplier. Inanimate shots have no location.
        let loc = decl.location;
        if (loc.mode === "random") {
            const { loc: key, face } = await rollHitLocation(loc.kind);
            const def = ATTACK_LOCATIONS[key];
            loc = {
                mode: "random", kind: loc.kind, key, face,
                penalty: 0, mult: def?.mult ?? 1,
                label: game.i18n.localize(def?.labelKey ?? key)
            };
        }

        // The strike multiplier (strong strike) scales the rolled dice. The
        // location multiplier is NOT folded into the roll: per RAW, armor SP is
        // subtracted from the damage FIRST and only the remainder is multiplied
        // by the location factor. So we roll strike-scaled damage and report
        // the location multiplier as an after-SP step on the card.
        const strikeMult = decl.strikeMeta?.dmgMult ?? 1;
        const locMult    = loc.mult ?? 1;

        // Special attacks: `noDamage` (disarm/trip) hide the damage line;
        // `note` (i18n key) surfaces the rider effect on the card. A Joint Attack
        // (`offhand`) rolls its second attack with a chosen off-hand weapon.
        const sMeta     = decl.strikeMeta ?? {};
        const noDamage  = !!sMeta.noDamage;
        const strikeNote = sMeta.note ? game.i18n.localize(sMeta.note) : "";
        const offhandWeapon = sMeta.offhand ? (this.items.get(decl.offhandId) ?? null) : null;

        // Feint (Core p.163): a SINGLE Deceit roll instead of an attack — no
        // weapon strike, no damage. If the target fails Awareness vs the Deceit,
        // the attacker's NEXT attack (a separate action) is at +3 (described in
        // the note; not auto-applied). The Deceit roll uses its own skill total,
        // no weapon accuracy and no called-shot penalty (it isn't aimed).
        const feintSkill   = sMeta.firstRollSkill || null;
        const feintProfile = feintSkill ? (() => {
            const sv = this._readSkillValues(feintSkill);
            return { eff: {}, skillKey: feintSkill, sv, accuracy: 0, baseTotal: sv?.total ?? 0 };
        })() : null;
        // The called-shot penalty folded into decl.modTotal — subtracted from the
        // feint's Deceit roll so a head-shot feint doesn't carry -6 on the feint.
        const locPenalty = (decl.location?.mode === "specific") ? (Number(decl.location.penalty) || 0) : 0;

        // Adrenaline dice committed in the dialog (Core p.176): each adds +1d6 to
        // the damage roll and costs `adrenalineStaPerDie()` STA (RAW 10), spent
        // when the attack is rolled. Re-clamp to the live pool in case it changed
        // since the dialog opened. Forced to 0 when the optional rule is off.
        const adrEnabled = isAdrenalineEnabled();
        const adrPool = adrEnabled ? Math.max(0, Number(this.system?.adrenaline?.value) || 0) : 0;
        const adrenalineDice = Math.min(adrPool, Math.max(0, Math.round(Number(decl.adrenalineDice) || 0)));

        // Build a weapon's damage display + rollable formula, honouring the
        // strike multiplier and the noDamage suppression. `adr` extra d6 are
        // appended OUTSIDE the strike multiplier (flat bonus dice, not doubled).
        const damageFor = (w, adr = 0) => {
            const d = w.type === "shield"
                ? shieldBashDamage(this, w)
                : (w.system?.effective?.damage || w.system?.damage || "");
            if (noDamage || !d) return { display: "", formula: "" };
            let display = strikeMult !== 1 ? `${d} ×${strikeMult}` : d;
            let formula = strikeMult !== 1 ? `(${d})*${strikeMult}` : d;
            if (adr > 0) { display += ` + ${adr}d6`; formula += ` + ${adr}d6`; }
            return { display, formula };
        };
        const mainDamage = damageFor(weapon, adrenalineDice);
        const damageStr  = mainDamage.display;

        // Status penalties to the attack (Staggered −2, Blinded −3, Prone −2,
        // Exhausted −1, …) folded straight onto the to-hit. Summed live from the
        // actor's active conditions by the status engine.
        const statusAtk = statusAttackMod(this);

        // To-hit total. decl.modTotal already folds strike/aim/location/range/
        // situational/weather/other; add the base skill/WA and any flat caller
        // modifier on top.
        const grandMod = activeProf.baseTotal + decl.modTotal + flatMod + statusAtk + (Number(cm.flatAttackMod) || 0);
        const formula  = grandMod ? `1d10 + ${grandMod}` : `1d10`;

        const localizeTypes = (keys) => (keys ?? [])
            .map(t => game.i18n.localize(CONFIG.WITCHER.damageTypes?.[t] ?? t))
            .filter(Boolean);

        // Location chip (shows the rolled face for random shots; omitted for
        // inanimate shots, which have no hit location).
        const locLabel = loc.mode === "random" ? `${loc.label} (d10: ${loc.face})` : loc.label;

        const attacks = Math.max(1, decl.strikeMeta?.attacks ?? 1);
        const speaker = ChatMessage.getSpeaker({ actor: this });
        // Per-shot ammo (bows only): the dialog may declare one chosen round per
        // shot. Resolve each id to its item up-front so the card and the spend
        // agree. Falls back to the weapon's default round when unspecified.
        const isBow = !!weapon.usesAmmo && !weapon.hasChamber;
        const declAmmo = Array.isArray(decl.ammo) ? decl.ammo : null;
        const resolveAmmoById = (id) =>
            (weapon.getEligibleAmmo?.() ?? []).find(e => e.item.id === id || e.item.uuid === id)?.item ?? null;
        // Persist the primary chosen round so the dock / next attack reflect it.
        if (isBow && declAmmo?.[0]) {
            try { await weapon.selectAmmo(declAmmo[0]); }
            catch (err) { console.warn("witcher-ttrpg-death-march | selectAmmo failed", err); }
        }
        let result = null;

        // Adrenaline dice ride the first (and, for a feint, only) shot.
        const damagingShot = 0;

        for (let i = 0; i < attacks; i++) {
            // Feint: the one and only shot is a Deceit roll — no weapon strike, no
            // damage, no location. Everything else rolls the weapon.
            const isFeintRoll = !!feintProfile && i === 0;
            // Joint Attack: the second roll uses the chosen off-hand weapon with
            // its OWN skill/accuracy/damage; every other strike reuses the main
            // weapon for each shot.
            const shotWeapon = (offhandWeapon && i === 1) ? offhandWeapon : weapon;
            const isOff = shotWeapon !== weapon;
            const prof  = isFeintRoll ? feintProfile
                        : isOff       ? readWeaponProfile(shotWeapon)
                        :               activeProf;

            // The round this shot fires: chosen bow ammo, chambered round, or none.
            // Ammo applies only to the (ranged) main weapon — an off-hand melee
            // shot never has any. A feint's Deceit roll fires nothing.
            const usesAmmo  = !isOff && !isFeintRoll && shotWeapon.usesAmmo;
            const shotAmmoId = (isBow && !isOff) ? (declAmmo?.[i] ?? declAmmo?.[0] ?? null) : null;
            const shotAmmo = (isBow && !isOff)
                ? (shotAmmoId ? resolveAmmoById(shotAmmoId) : defaultShotAmmo(weapon))
                : null;

            const wTypeKeys = shotWeapon.system?.effective?.damageTypes ?? shotWeapon.system?.damageTypes ?? [];
            const typeKeys = usesAmmo
                ? [...new Set([...wTypeKeys, ...(shotAmmo?.system?.damageTypes ?? [])])]
                : wTypeKeys;
            const types = isFeintRoll ? [] : localizeTypes(typeKeys);
            const shotSkillName = prof.skillKey
                ? game.i18n.localize(CONFIG.WITCHER.skillLabel(prof.skillKey))
                : game.i18n.localize("WITCHER.attack.noSkill");
            const subtitle = [shotSkillName, types.join(" · ")].filter(Boolean).join(" · ");
            const qualities = isFeintRoll ? [] : (usesAmmo ? shotQualityLabels(shotWeapon, shotAmmo) : shotQualityLabels(shotWeapon, null));

            // Adrenaline dice land on the damaging shot only (one declaration per
            // attack), so a Fast strike's 2nd shot / a joint off-hand / a feint's
            // Deceit roll don't double-count them.
            const shotDamage   = isFeintRoll ? { display: "", formula: "" } : damageFor(shotWeapon, i === damagingShot ? adrenalineDice : 0);
            // Feint's Deceit roll drops the called-shot penalty (it isn't aimed).
            const shotGrandMod = prof.baseTotal + decl.modTotal + flatMod + statusAtk
                               - (isFeintRoll ? locPenalty : 0);
            const shotFormula  = shotGrandMod ? `1d10 + ${shotGrandMod}` : `1d10`;

            const shotChips = [
                ...baseChipsFor(prof),
                ...decl.chips
                    .filter(c => !(isFeintRoll && c.label === loc.label))   // drop called-shot pen on the feint roll
                    .map(c => ({ label: c.label, value: signed(c.value) })),
                flatMod ? { label: "Atk Mod", value: signed(flatMod) } : null,
                statusAtk ? { label: "Status", value: signed(statusAtk) } : null,
                (!isFeintRoll && loc.mode !== "none") ? { label: game.i18n.localize("WITCHER.Attack.Location"), value: locLabel } : null,
                dc != null ? { label: "DC", value: dc } : null
            ].filter(Boolean);

            const ammoTag = (isBow && shotAmmo) ? ` — ${shotAmmo.name}` : "";
            // A feint is a single Deceit roll — its card reads "Feint", not the
            // weapon name, and never carries the multi-attack "(n/m)" tag.
            const weaponName = isFeintRoll
                ? game.i18n.localize("WITCHER.Attack.StrikeFeint")
                : (attacks > 1)
                    ? `${shotWeapon.name} (${i + 1}/${attacks})${ammoTag}`
                    : `${shotWeapon.name}${ammoTag}`;
            const flavor = attackRollFlavor({
                actorName: this.name,
                weaponName,
                subtitle,
                chips: shotChips,
                qualities,
                note: strikeNote,
                damage: { display: shotDamage.display, formula: shotDamage.formula, types: types.join(" · "), locMult, locLabel: loc.label }
            });
            result = await extendedRoll(
                shotFormula,
                { speaker, flavor },
                dc != null ? { threshold: dc } : {}
            );

            // Firing the shot spends its round: a chambered weapon (crossbow)
            // empties, a bow draws the chosen round from its quiver. No-op for melee.
            if (usesAmmo) {
                try { await weapon.spendShot(shotAmmoId); }
                catch (err) { console.warn("witcher-ttrpg-death-march | spendShot failed", err); }
            }
        }

        // Spend the committed adrenaline dice now (declared at roll time): drain
        // the pool and pay the configured STA per die (RAW 10, Core p.176). The
        // +Nd6 is already baked into the first shot's damage formula on the card.
        if (adrenalineDice > 0) {
            try {
                await this.update({ "system.adrenaline.value": Math.max(0, adrPool - adrenalineDice) });
                await this.spendStamina?.(adrenalineDice * adrenalineStaPerDie(), { reason: "adrenaline" });
            } catch (err) {
                console.warn("witcher-ttrpg-death-march | adrenaline spend failed", err);
            }
        }

        // Aim is single-use: the bonus is folded into this shot, so clear the
        // Aim status now (ranged only). consumeAim no-ops when not aiming.
        if (firedRanged && aimBonus) {
            try { await this.consumeAim(); }
            catch (err) { console.warn("witcher-ttrpg-death-march | consumeAim failed", err); }
        }

        // Fast Draw is spent the moment its -3 is folded into an attack — clear
        // the status so it doesn't bleed into later rolls this turn.
        if (decl.fastDraw && this.statuses?.has?.("fastDraw")) {
            try { await this.toggleStatusEffect("fastDraw", { active: false }); }
            catch (err) { console.warn("witcher-ttrpg-death-march | failed to clear fastDraw", err); }
        }

        // A thrown weapon leaves the hand — it lands at the target. Drop it to
        // the world (pick-up-able) and remove it from the actor. Weapons never
        // stack, so there's no quantity to decrement: one item, one throw.
        const out = { ...result, formula, weapon, damage: damageStr, location: loc, declaration: decl };
        if (!useMelee && weapon.system?.weaponType === "thrown") {
            try { await this._dropThrownWeapon(weapon); }
            catch (err) { console.warn("witcher-ttrpg-death-march | thrown-weapon drop failed", err); }
        }
        return out;
    }

    /** Drop a thrown weapon into the world after it's been thrown: clone it as
     *  an owner-accessible world item, unlink it from any container, then
     *  delete the actor's copy. Mirrors the dock's dropWeaponToWorld, kept here
     *  so the throw is consistent whether fired from the dock or the sheet. */
    async _dropThrownWeapon(weapon) {
        const OWNER = (globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER) ?? 3;
        const data = weapon.toObject(false);
        data.ownership = { default: OWNER };
        try {
            await Item.implementation.create(data);
        } catch (err) {
            console.warn("witcher-ttrpg-death-march | thrown-weapon world create failed", err);
            return;
        }
        for (const c of this.items) {
            if (c.type !== "container") continue;
            const content = c.system?.content ?? [];
            if (content.includes(weapon.uuid) || content.includes(weapon.id)) {
                await c.update({ "system.content": content.filter(u => u !== weapon.uuid && u !== weapon.id) });
            }
        }
        await weapon.delete();
        ui?.notifications?.info?.(`${this.name} throws ${weapon.name}.`);
    }
};
