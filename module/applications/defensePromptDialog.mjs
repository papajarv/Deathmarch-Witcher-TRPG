/**
 * defensePromptDialog — modal shown to the target's owner the moment an
 * attacker declares an attack against them. Lets the defender pick how to
 * react before the attacker rolls.
 *
 * Options (button row, dynamic):
 *   - Parry (if defender has an equipped weapon/shield with a parry skill)
 *   - Block (if defender has an equipped shield, or any item with reliability
 *     to spend on a block)
 *   - Dodge (always available — body roll)
 *   - Take it (no defense; attacker just rolls vs base stat)
 *
 * Returns: { action: "parry"|"block"|"dodge"|"none", itemId?: string }
 * — itemId is the embedded item that Parry/Block was declared with. For v1
 * we auto-pick the first eligible weapon/shield; a future pass can let the
 * defender choose which.
 *
 * Auto-resolves to {action:"none"} after `timeoutMs` (default 30s) if the
 * defender doesn't react — so the attacker isn't stuck waiting forever.
 */

import { WEAPON_QUALITIES, ARMOR_QUALITIES } from "../setup/config.mjs";
import { hasWRPerk } from "../api/witcherReborn.mjs";
import { isCombatExtendedEnabled } from "../api/homebrew.mjs";

import { t, tFormat } from "../chrome/lib/i18n.js";
import { findGrappleWeapon, GRAPPLE_DEFENSE_KINDS } from "../mechanics/grappleWeapon.mjs";
import { isInGrappleFamily, isInPin, isPinned } from "../mechanics/holdModifiers.mjs";
const SYSTEM_ID = "witcher-ttrpg-death-march";

const escAttr = (s) => String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escText = (s) => String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/* A weapon/shield is "broken" when it has a Reliability pool
 * (reliability.max > 0) and the current value is 0. Broken items stay
 * EQUIPPED (the user explicitly wants them visible in their slot so the
 * player has to consciously swap or repair) but can't parry / block /
 * attack until repaired. */
function isBroken(item) {
    const max = Number(item?.system?.reliability?.max) || 0;
    if (max <= 0) return false;
    const cur = Number(item?.system?.reliability?.value) || 0;
    return cur <= 0;
}
/* `requireEquipped` is false for MONSTER defenders: a monster has no hand-slot
 * / equip UX for weapons (only shields auto-equip on drop), so any weapon it
 * holds is "wielded" and usable to parry / block. Characters still require the
 * item to be equipped. */
function parryEligible(item, requireEquipped = true) {
    if (requireEquipped && !item?.system?.equipped) return false;
    if (isBroken(item)) return false;
    if (item.type === "weapon") return true;
    if (item.type === "shield") return true;
    if (item.type === "armor" && item.system?.location === "Shield") return true;
    return false;
}
function blockEligible(item, requireEquipped = true) {
    if (requireEquipped && !item?.system?.equipped) return false;
    if (isBroken(item)) return false;
    if (item.type === "shield") return true;
    if (item.type === "armor" && item.system?.location === "Shield") return true;
    if (item.type === "weapon") return Number(item.system?.reliability?.value ?? item.system?.reliability) > 0;
    return false;
}

/* Human label for the strike kind shown in the dialog header. Lowercased
 * keys match weaponAttackMixin's `decl.strike` enum. */
const STRIKE_LABEL_FALLBACKS = {
    normal: "Normal strike",
    strong: "Strong strike",
    fast:   "Fast strike",
    joint:  "Joint attack",
    charge: "Charge",
    feint:  "Feint",
    pommel: "Pommel strike",
    disarm: "Disarm",
    trip:   "Trip",
    grapple:"Grapple",
    pin:    "Pin",
    choke:  "Choke",
    throw:  "Throw",
    pushKick:"Push Kick",
    push:   "Push",
    slam:   "Slam",
    takedown: "Takedown",
    reverseGrapple: "Reverse Grapple",
    bomb:   "Bomb"
};
/* Lazy — labels localize at read time so `STRIKE_LABELS.charge` returns
 * "Charge" in English or "Charger" in French without any caller change. */
const STRIKE_LABELS = new Proxy(STRIKE_LABEL_FALLBACKS, {
    get(target, prop) {
        if (!(prop in target)) return undefined;
        return t(`WITCHER.App.DefensePromptDialog.Strike.${String(prop)}`, target[prop]);
    }
});

/* Which defense actions are valid against each attack kind, per RAW
 * Core p.163-164.  Weapon strikes accept any of the four defenses;
 * grapple / disarm / trip-style attacks accept ONLY dodge or reposition
 * (the prompt's skill-based defenses, which roll Dodge/Escape and
 * Athletics — same skills as RAW's Brawling-counter). */
/* Weapon-strike key → RAW category. Combat Extended renames the strikes
 * (single/strongAttack/fastAttack/…), but DEFENSE_GATE below is keyed by the RAW
 * category. Kept local (mirrors STRIKE_CATEGORY in attackDialog.mjs) to avoid
 * importing a UI module. Keys not listed pass through unchanged — the standalone
 * actions (grapple/pin/choke/throw/bash/…) already ARE their own gate keys.
 * (Bash is NOT a grapple action — it's a shield shove; it's listed here only as
 * an example of a key that maps to itself.) */
const STRIKE_TO_CATEGORY = Object.freeze({
    normal: "normal",  single:       "normal",
    strong: "strong",  strongAttack: "strong",
    fast:   "fast",    fastAttack:   "fast",
    joint:  "joint",   jointAttack:  "joint",
    charge: "charge",
    pommel: "pommel",  pommelStrike: "pommel",
    /* The melee CE choke strike is keyed "chokehold"; map it to the "choke"
     * defense gate so a Strangling-weapon choke is resisted exactly like a
     * Brawling choke (Brawling / grappling weapon only — no parry/block/dodge). */
    chokehold: "choke"
});

const DEFENSE_GATE = {
    /* Default — every standard weapon strike. `brawlBlock` is a bare-
     * hands intercept (roll Brawling; on success, the hit is redirected
     * to your arms). Available with or without a weapon in-hand — you
     * can always try to catch the strike on your forearms. */
    normal:   { parry: true, block: true, dodge: true, reposition: true, brawlBlock: true },
    strong:   { parry: true, block: true, dodge: true, reposition: true, brawlBlock: true },
    fast:     { parry: true, block: true, dodge: true, reposition: true, brawlBlock: true },
    joint:    { parry: true, block: true, dodge: true, reposition: true, brawlBlock: true },
    charge:   { parry: true, block: true, dodge: true, reposition: true, brawlBlock: true },
    pommel:   { parry: true, block: true, dodge: true, reposition: true, brawlBlock: true },
    /* Grapple / wrestling chain — RAW p.160. Dodge/Escape only. Brawl-
     * block doesn't fit here — the whole action IS a body-on-body grab. */
    /* Base Grapple: defend with Brawling OR Dodge/Escape (CE spec). brawlBlock
     * is the engine's Brawling defense; with a Grappling weapon equipped the
     * socket-side roll swaps to that weapon's skill (the *** rule). Pin/Choke/
     * Throw stay Dodge/Escape-only below. */
    grapple:  { parry: false, block: false, dodge: true, reposition: true, brawlBlock: true },
    pin:      { parry: false, block: false, dodge: true, reposition: true, brawlBlock: false },
    /* Choke — resisted ONLY with Brawling (a Grappling weapon may stand in via
     * GRAPPLE_DEFENSE_KINDS). No dodge/escape/relocate — you're pinned. */
    choke:    { parry: false, block: false, dodge: false, reposition: false, brawlBlock: true },
    throw:    { parry: false, block: false, dodge: true, reposition: true, brawlBlock: false },
    pushKick: { parry: false, block: false, dodge: true, reposition: true, brawlBlock: false },
    /* CE Push (shove) — resisted with Brawling OR Dodge/Escape (a Grappling
     * weapon may stand in for the Brawling side, per GRAPPLE_DEFENSE_KINDS).
     * No parry/block/relocate. */
    push:     { parry: false, block: false, dodge: true, reposition: false, brawlBlock: true },
    /* CE Slam — a grapple finisher (double kick + prone + 1d6m + Stun). Like
     * push, it's resisted with Brawling OR Dodge/Escape (a Grappling weapon may
     * stand in for the Brawling side, per GRAPPLE_DEFENSE_KINDS). No parry/block/
     * relocate. */
    slam:     { parry: false, block: false, dodge: true, reposition: false, brawlBlock: true },
    /* CE Takedown — opposed Brawling (a Grappling weapon may stand in). Resisted
     * with Brawling or Dodge/Escape; no parry/block/relocate. */
    takedown: { parry: false, block: false, dodge: true, reposition: false, brawlBlock: true },
    /* Disarm — resisted with Brawling (or a Grappling weapon's skill, via
     * GRAPPLE_DEFENSE_KINDS) OR Dodge/Escape (RAW p.163). No parry/block. */
    disarm:   { parry: false, block: false, dodge: true, reposition: true, brawlBlock: true },
    /* CE Trip — grappler-only, opposed Brawling (a Grappling weapon may stand
     * in). Resisted with Brawling or Dodge/Escape; no parry/block/relocate —
     * same profile as Takedown. */
    trip:     { parry: false, block: false, dodge: true, reposition: false, brawlBlock: true },
    /* CE Bash — the attacker charges in with a shoulder / body slam. It's
     * a Brawling roll to hit; there's nothing to parry or block against
     * a body shove, so only dodge / reposition apply. */
    bash:     { parry: false, block: false, dodge: true, reposition: true, brawlBlock: false },
    /* CE Reverse Grapple — the grapplee wrestles for the dominant position.
     * Even when performed with a Grappling WEAPON (so it routes through the
     * weapon-attack flow), it is NOT a strike the holder can parry, block, or
     * reposition away from: per spec the holder resists ONLY with Brawling or
     * Dodge/Escape (a Grappling weapon of their own swaps Brawling to its
     * skill — see GRAPPLE_DEFENSE_KINDS). No reposition — you can't relocate
     * out of a hold you're the one maintaining. */
    reverseGrapple: { parry: false, block: false, dodge: true, reposition: false, brawlBlock: true }
    /* Feint never reaches the defense prompt — it's an opposed
     * Deceit-vs-Awareness check the attacker rolls solo. */
};

const REMOVED_DEFENSE_NOTE_FALLBACKS = {
    parry: "Parry not allowed against this attack kind (RAW p.163).",
    block: "Block not allowed against this attack kind (RAW p.163)."
};
const REMOVED_DEFENSE_NOTE = new Proxy(REMOVED_DEFENSE_NOTE_FALLBACKS, {
    get(target, prop) {
        if (!(prop in target)) return undefined;
        return t(`WITCHER.App.DefensePromptDialog.RemovedNote.${String(prop)}`, target[prop]);
    }
});

/* @param {object} opts
 * @param {string}   opts.attackerName
 * @param {string}   opts.weaponName
 * @param {string}   opts.weaponImg
 * @param {Actor}    opts.defenderActor
 * @param {number}   [opts.timeoutMs=30000]
 * @param {string}   [opts.attackKind]        decl.strike — drives the header label
 * @param {number}   [opts.shotIndex]         1-based shot number for multi-shot strikes
 * @param {number}   [opts.totalShots]        total shots in this declaration
 * @param {string[]} [opts.disallowedItemIds] items the defender already committed
 *                                            to a previous shot (joint-attack rule:
 *                                            you can't parry both attacks with one
 *                                            item — Core p.163 sidebar) */
export async function openDefensePrompt({
    attackerName, weaponName, weaponImg, defenderActor, timeoutMs = null,
    attackKind = "normal", shotIndex = 1, totalShots = 1, disallowedItemIds = [],
    disallowedActions = [],
    attackerDamageFlags = null, allowedDefenses = null, requiresShieldCover = false,
    attackHitLocation = null
}) {
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2) return { action: "none" };

    /* Witchers Reborn — Viper · Blade Dance: exempt from the joint-attack
     * item-lockout rule. A Blade Dance viper can parry both blades in a
     * joint attack with the same weapon. Note the perk text says "no
     * joint-attack penalty" — the "penalty" in this system's rendering is
     * the item-reuse restriction, not a numeric to-defense malus. */
    const jointExempt = hasWRPerk(defenderActor, "bladeDance");
    const blocked = new Set(jointExempt ? [] : (disallowedItemIds ?? []));
    /* Item-less defense lockout — parallel Set for actions like dodge,
     * reposition, brawlBlock, resistMagic. Same joint-attack rule: an
     * action already used earlier in this joint attack is unavailable
     * for the current shot. Blade Dance exempts both restrictions. */
    const blockedActions = new Set(jointExempt ? [] : (disallowedActions ?? []));
    const items = defenderActor?.items ?? [];
    /* Natural-weapon defense toggles (race config): claws/horns can be set to
     * parry and/or block. Item-less — resolved as REF + Brawling; a natural
     * block fully negates the hit but costs the defender 1 HP (charged
     * attacker-side). Read the race once here; the buttons are added below,
     * gated by the same attack-kind gate that governs weapon parry/block. */
    const nwRace     = [...items].find(it => it.type === "race" && it.system?.naturalWeapons);
    const nwCanParry = !!nwRace?.system?.naturalWeaponCanParry;
    const nwCanBlock = !!nwRace?.system?.naturalWeaponCanBlock;
    /* Monsters have no equip step for weapons (only shields auto-equip), so a
     * dragged-in weapon they hold must still count as wielded for parry/block. */
    const isMonster = defenderActor?.type === "monster";
    /* Base (stat-block) monster attacks that the GM toggled Parry/Block on — the
     * monster equivalent of a character's natural-weapon race toggle. Each becomes
     * an item-less defense option that rolls the attack's own skill. Melee only. */
    const baseAttacks = isMonster ? (defenderActor?.system?.combat?.attacks ?? []) : [];
    const baseParry = [];
    const baseBlock = [];
    baseAttacks.forEach((atk, idx) => {
        if (!atk || (atk.weaponType && atk.weaponType !== "melee")) return;
        if (atk.canParry) baseParry.push({ idx, name: atk.name || t("WITCHER.App.DefensePromptDialog.Text.BaseAttack", "Attack") });
        if (atk.canBlock) baseBlock.push({ idx, name: atk.name || t("WITCHER.App.DefensePromptDialog.Text.BaseAttack", "Attack") });
    });
    /* Blocking a ranged / thrown / cast attack requires a shield.
     * RAW: ANY shield works. CE: only shields with cover value ≥ 1 (a
     * CV-0 buckler can't intercept an arrow or a spell). Weapons and
     * non-shield items never intercept in either mode.
     *
     * BOMB variant (attackKind === "bomb"): stricter gate — RAW needs
     * a shield with the `fullCover` quality; CE needs CV ≥ 5. A CV-1
     * buckler catches an arrow but doesn't cover you from an
     * explosion — physical sense trumps the general ranged gate.
     *
     * `requiresShieldCover` is passed by whoever fired the request
     * (weaponAttackMixin sets it when the shot is ranged / thrown;
     * castSpellMixin sets it always; bombs.mjs sets it AND passes
     * attackKind: "bomb"). Melee attacks leave it false and any
     * block-eligible item works. */
    const isCast  = attackKind === "cast";
    const isBomb  = attackKind === "bomb";
    const isShield = (it) => it?.type === "shield"
        || (it?.type === "armor" && it?.system?.location === "Shield");
    const ceOn = isCombatExtendedEnabled();
    /* A grapple-family attack (grapple/pin/choke/throw/ride/reverse/push) is a
     * body-on-body WRESTLING exchange — always melee. Its `brawlBlock` defense
     * is "resist with Brawling" (a Grappling weapon may stand in for the skill —
     * the *** rule), NOT the forearm-interpose "Arm Block" used against weapon
     * strikes. So the leg hit-location guard below (you can't get a forearm in
     * front of a shin — an Arm Block concern only) must NOT strip Brawling here:
     * wrestling out of a grab isn't location-bound. */
    const isGrappleKind = GRAPPLE_DEFENSE_KINDS.has(attackKind);
    const hasCover = (it) => (Number(it?.system?.coverValue) || 0) >= 1;
    /* Bomb-strength cover: RAW = `fullCover` quality flag; CE = CV ≥ 5.
     * Shields carry `qualities` like armor / weapons; the `fullCover`
     * key is the legacy pavise-style tag. */
    const hasBombCover = (it) => {
        if (!isShield(it)) return false;
        const cv = Number(it?.system?.coverValue) || 0;
        if (ceOn) return cv >= 5;
        const qs = it?.system?.qualities ?? [];
        return Array.isArray(qs) && qs.includes("fullCover");
    };
    // ALL eligible items — a defender with two swords + a shield should be
    // able to pick which one parries / blocks. Previously the dialog grabbed
    // only the first eligible item with .find(), hiding everything else.
    const parryItems = [...items].filter(it => parryEligible(it, !isMonster) && !blocked.has(it.id));
    /* Feeble (EO p.7): a Feeble weapon can ONLY parry another Feeble weapon.
     * When the attacker's weapon isn't Feeble, drop feeble parry items — the
     * defender must BLOCK with it instead (half the damage leaks through; see
     * weaponAttackMixin) or Dodge. `attackerFeeble` rides in on the attacker's
     * damage flags, mirroring how Hefty's `deniesParry` gates parry below. */
    if (!attackerDamageFlags?.attackerFeeble) {
        const feebleCat = WEAPON_QUALITIES;
        const isFeebleItem = (it) => {
            const qs = it?.system?.effective?.qualities ?? it?.system?.qualities ?? [];
            return qs.some(q => feebleCat[q]?.feebleParryRestrictedToFeeble);
        };
        for (let i = parryItems.length - 1; i >= 0; i--) {
            if (isFeebleItem(parryItems[i])) parryItems.splice(i, 1);
        }
    }
    const blockItems = [...items].filter(it => {
        if (!blockEligible(it, !isMonster) || blocked.has(it.id)) return false;
        if (isBomb) {
            /* Strict bomb gate — see hasBombCover above. */
            return hasBombCover(it);
        }
        if (requiresShieldCover || isCast) {
            if (!isShield(it)) return false;
            /* CE layers the cover-value requirement on top; RAW accepts
             * any equipped shield. */
            if (ceOn && !hasCover(it)) return false;
            return true;
        }
        return true;
    });
    const parryItem = parryItems[0] ?? null;   // legacy fallback when no id encoded
    const blockItem = blockItems[0] ?? null;

    const strikeLabel = STRIKE_LABELS[attackKind] ?? "Attack";
    const shotTag     = totalShots > 1 ? ` (${shotIndex}/${totalShots})` : "";
    const blockedNote = (blocked.size > 0 || blockedActions.size > 0)
        ? `<div style="margin-top:4px;font-size:0.6875rem;color:#b97;opacity:0.85;">${t("WITCHER.App.DefensePromptDialog.Text.ItemsUsedInThePreviousShotAreUnavailable", "Items used in the previous shot are unavailable for this defense (joint-attack rule).")}</div>`
        : "";

    /* Re-build the content here so we can include the gate note (which
     * is computed below — moved the content build after the buttons). */
    const buildContent = (extraNotes) => `
        <div class="wdm-defense-prompt" style="display:flex;gap:10px;padding:6px 2px;">
            ${weaponImg ? `<img src="${escAttr(weaponImg)}" alt="" style="width:48px;height:48px;flex:0 0 auto;border:1px solid #6e5224;background:#0a0907;object-fit:contain;"/>` : ""}
            <div style="flex:1 1 auto;font-size:0.75rem;line-height:1.4;">
                <div style="font-family:var(--wdm-font-display,inherit);font-size:0.8125rem;letter-spacing:0.12em;text-transform:uppercase;color:#c8a878;">${escText(attackerName ?? "Attacker")} — ${escText(strikeLabel)}${escText(shotTag)}</div>
                <div style="opacity:0.85;">${tFormat("WITCHER.App.DefensePromptDialog.Text.AttacksYouWith", { weapon: escText(weaponName ?? t("WITCHER.App.DefensePromptDialog.Text.AWeapon", "a weapon")) }, `attacks you with <strong>${escText(weaponName ?? "a weapon")}</strong>.`)}</div>
                <div style="margin-top:6px;font-size:0.6875rem;opacity:0.7;">${t("WITCHER.App.DefensePromptDialog.Text.PickDefense", "Pick your defense before they roll.")}</div>
                ${blockedNote}
                ${extraNotes}
            </div>
        </div>
        <div class="wdm-defense-prompt-mods" style="display:flex;align-items:center;gap:8px;padding:4px 2px 2px;border-top:1px solid #2a2520;margin-top:6px;">
            <label for="wdm-def-extra-mod" style="font-size:0.6875rem;letter-spacing:0.12em;text-transform:uppercase;color:#c8a878;flex:0 0 auto;">${t("WITCHER.App.DefensePromptDialog.Text.OtherModifier", "Other modifier")}</label>
            <input id="wdm-def-extra-mod" type="number" name="extraMod" step="1" value="0"
                style="width:64px;padding:2px 4px;background:#0a0907;border:1px solid #6e5224;color:#e5d6b6;font-family:inherit;" />
            <span style="font-size:0.6875rem;opacity:0.6;">${t("WITCHER.App.DefensePromptDialog.Text.AppliedToDefenseRoll", "applied to the defense roll")}</span>
        </div>
    `;

    /* Filter the buttons by which defenses are valid against this attack
     * kind (Disarm/Trip/Grapple/Pin/Choke/Throw can't be parried/blocked
     * per RAW p.163-164). Cast-kind uses `allowedDefenses` from the spell
     * item — Igni is `["dodge","block"]` so no parry button; Aard is
     * `["dodge"]` so only dodge/reposition. Empty allowedDefenses on a
     * cast means "no defense clause on the item" — the target just takes
     * it. Default to "allow all" if the strike isn't in the gate map and
     * no allowedDefenses were passed. */
    let baseGate;
    if (Array.isArray(allowedDefenses) && allowedDefenses.length > 0) {
        const allowed = new Set(allowedDefenses.map(String));
        baseGate = {
            parry:      allowed.has("parry"),
            /* Spell "block" clause allows block (shield only, filtered
             * above). Spell "dodge" clause enables BOTH dodge and
             * reposition — both are DEX-based evasion. Bombs and other
             * area weapons pass "reposition" explicitly (dodge is not
             * an option — you can't dodge an AoE, you leave it), so
             * reposition is also enabled when explicitly requested. */
            block:      allowed.has("block"),
            dodge:      allowed.has("dodge"),
            reposition: allowed.has("dodge") || allowed.has("reposition"),
            /* Resist Magic — the Will-based skill defense against a
             * spell / hex whose defense clause includes "resistmagic".
             * Rolls WILL + Resist Magic; no item involved. Common on
             * mind-affecting spells and every hex on the RAW list. */
            resistMagic: allowed.has("resistmagic"),
            /* Spell Casting — the defence Dispel declares. A caster counters
             * an incoming spell with an opposed Spell Casting roll. Without
             * this branch the clause built an all-false gate, leaving only
             * "Take it" and a phantom DC 10. */
            spellCasting: allowed.has("spellcasting"),
            /* No brawlBlock against a spell — you can't punch a fireball. But a
             * wrestling exchange (grapple/pin/choke/throw/ride) always keeps its
             * Brawling / grappling-weapon defense even if the attack narrowed
             * allowedDefenses: this rebuild branch would otherwise strip the CE
             * grapple override in the `else` below and silently kill the defense. */
            brawlBlock: ceOn && GRAPPLE_DEFENSE_KINDS.has(attackKind)
        };
    } else if (Array.isArray(allowedDefenses) && allowedDefenses.length === 0 && (isCast || isBomb)) {
        /* Cast with no defense clause — no defense possible; only
         * "take it" is available. */
        baseGate = { parry: false, block: false, dodge: false, reposition: false, brawlBlock: false, resistMagic: false, spellCasting: false };
    } else {
        /* Normalize the strike key to its RAW category before the gate lookup.
         * Combat Extended renames the weapon strikes (normal→single,
         * strong→strongAttack, fast→fastAttack, joint→jointAttack,
         * pommel→pommelStrike), but DEFENSE_GATE is keyed by category. Without
         * this, a CE "single" strike misses the table and falls to the default —
         * which lacked a `brawlBlock` key, so the always-available Arm Block
         * silently disappeared on every CE melee attack. The fallback now also
         * carries brawlBlock:true so any other unmapped melee strike keeps it
         * (ranged/thrown still forces it off below via requiresShieldCover). */
        const gateKey = STRIKE_TO_CATEGORY[attackKind] ?? attackKind;
        baseGate = DEFENSE_GATE[gateKey] ?? { parry: true, block: true, dodge: true, reposition: true, brawlBlock: true, resistMagic: false, spellCasting: false };
        /* CE Combat Extended (2026-07-03) grapple-flow gate overrides.
         *
         *   Grapple  — defender picks between Dodge/Escape,
         *              Reposition, OR Brawling (CE spec: "Roll Brawling
         *              vs target's Brawling, or Dodge Escape, or
         *              Reposition to try and grapple them.").
         *              brawlBlock is our engine-side Brawling defense —
         *              enable it under CE.
         *   Pin / Choke / Throw / Ride — CE spec: "Follow-up actions
         *              such as pin, ride, etc etc, will always be only
         *              resisted with brawling." Dodge + Reposition are
         *              REMOVED and only brawlBlock remains, matching
         *              the "close-in, wrestling continues" flavor.
         *
         * Guarded on the master extendedCombat toggle so RAW behavior
         * is untouched when CE is off. */
        if (ceOn) {
            if (attackKind === "grapple") {
                baseGate = { ...baseGate, brawlBlock: true };
            } else if (attackKind === "pin" || attackKind === "choke" || attackKind === "chokehold"
                    || attackKind === "throw" || attackKind === "ride") {
                baseGate = { parry: false, block: false, dodge: false, reposition: false, brawlBlock: true };
            }
        }
    }
    /* Ranged / thrown attacks can't be parried in RAW (Core: parry is a
     * melee response). Only shield-block (see item filter above) and
     * dodge/reposition work. Same rule for CE. A future witcher-only
     * "arrow parry" perk would flip a bypass flag here; not implemented
     * yet. `requiresShieldCover` is the same signal that gates shield-
     * only block, so the two guards fire together.
     *
     * We also FORCE-ENABLE block here. Weapon "throw" strikes and
     * wrestling "throw" actions share the attackKind:"throw" — the
     * DEFENSE_GATE entry above was written for the wrestling variant
     * and hard-disables block, which would strand the shield-block
     * intent for a hurled dagger. `requiresShieldCover` is only set
     * for genuine ranged/thrown weapon shots (weaponAttackMixin) and
     * casts (castSpellMixin) — never for wrestling — so it's safe to
     * override baseGate.block here. The item filter above already
     * restricts the block button to shields (RAW) or CV≥1 shields
     * (CE). */
    if (requiresShieldCover) {
        baseGate = { ...baseGate, parry: false, block: true, brawlBlock: false };
    }
    /* IN A PIN (CE): both parties — the pinned grapplee AND the pinner — are
     * locked down and may ONLY BLOCK on defense: shield block or arm
     * (brawl) block. NO parry, NO dodge, NO relocate. Registry-based (either
     * role), so token linkage doesn't matter.
     *
     * Extra rule for the PINNED target specifically: against a grappling attack
     * (grapple/pin/choke/throw/ride/reverse) they can't block at all — it lands
     * on the pinned incomingDC (10). The pinner keeps their block vs a reverse. */
    if (ceOn && isInPin(defenderActor)) {
        if (isPinned(defenderActor) && GRAPPLE_DEFENSE_KINDS.has(attackKind)) {
            /* A pinned target normally can't defend a grapple attack — it lands
             * on the pinned DC. CHOKE is the EXCEPTION: it is explicitly resisted
             * with Brawling (or a grappling weapon), so keep brawlBlock on for a
             * choke even though the target is pinned. Everything else stays fully
             * locked out. */
            const isChokeAtk = attackKind === "choke" || attackKind === "chokehold";
            baseGate = { parry: false, block: false, dodge: false, reposition: false, brawlBlock: isChokeAtk, resistMagic: false, spellCasting: false };
        } else {
            baseGate = { ...baseGate, parry: false, dodge: false, reposition: false };
        }
    }
    /* Grapple movement-lock: anyone in a grapple/pin/choke — grappler OR
     * grapplee — is locked in place and cannot Relocate as a defense. Dodge
     * stays (you can still twist away in place). Registry-based, so an unlinked
     * token's hold still counts. (No-op under RAW: no hold pairs exist.) */
    if (isInGrappleFamily(defenderActor)) {
        baseGate = { ...baseGate, reposition: false };
    }
    /* Quality-driven override: the attacker's weapon may carry a damageFlag
     * that strips a defense category (Crushing Force / Hefty / `deniesParry`
     * denies the parry response per RAW Core p.165 + EO p.7). The flag flows
     * in via `attackerDamageFlags` from the attack pipeline.
     *
     * EO counter rule: if any of the defender's would-be parry items
     * carries Sturdy / Very Sturdy (counterHefty) — or Very Sturdy
     * (counterCrushingForce) — parry is RE-ENABLED, restricted to those
     * specific items. We filter parryItems to keep only the counterers
     * in that case; the parry buttons that get rendered for the user
     * are then only the legitimate ones. */
    let parryGateLocal = baseGate.parry && !attackerDamageFlags?.deniesParry;
    const gate = { ...baseGate, parry: parryGateLocal };
    /* Arm Block interposes a FOREARM — physically impossible against a strike
     * aimed at the legs. Drop the option when the hit lands on a leg (the strike
     * redirects to an arm, which you can't get in front of your shin). Head /
     * torso / arm hits still allow it. */
    if ((attackHitLocation === "leftLeg" || attackHitLocation === "rightLeg") && !isGrappleKind) {
        gate.brawlBlock = false;
    }
    if (baseGate.parry && attackerDamageFlags?.deniesParry) {
        /* Pull the union catalog so we can identify counterHefty items
         * regardless of whether they're weapons or shields. */
        const allCat = { ...WEAPON_QUALITIES, ...ARMOR_QUALITIES };
        const isCountering = (it) => {
            const qs = it?.system?.effective?.qualities ?? it?.system?.qualities ?? [];
            return qs.some(q => allCat[q]?.counterHefty || allCat[q]?.counterCrushingForce);
        };
        const counterers = parryItems.filter(isCountering);
        if (counterers.length > 0) {
            /* Restrict parryItems to the counterers + re-enable parry */
            parryItems.length = 0;
            for (const it of counterers) parryItems.push(it);
            gate.parry = true;
        }
    }
    /* Buttons are organized as one COLUMN per action kind (Parry / Block /
     * Dodge / Reposition / Take it). Multiple eligible parry or block items
     * stack inside their own column so the row stays visually aligned: each
     * kind sits in its own slot, and only the variant cells grow downward.
     *
     * We keep a flat `buttons` list as a DialogV2 fallback (its footer is
     * hidden via CSS — the interactive buttons render inline inside the
     * content). This lets DialogV2 still satisfy its API requirement
     * (non-empty buttons array) without showing a duplicate row. */
    const cols = { parry: [], block: [], dodge: [], reposition: [], resistMagic: [], spellCasting: [], none: [] };
    const buttons = [];
    const pushBtn = (kind, b) => { buttons.push(b); cols[kind].push(b); };
    if (gate.parry) {
        if (parryItems.length <= 1) {
            // 0 or 1 eligible — single button (disabled if none)
            pushBtn("parry", {
                action: "parry",
                label:  parryItem ? `Parry (${parryItem.name})` : "Parry",
                disabled: !parryItem,
                icon: "fa-solid fa-shield-halved"
            });
        } else {
            // 2+ eligible — one button per item. Action carries the itemId
            // after a colon (`parry:abc123`) so the result handler can route.
            for (const it of parryItems) {
                pushBtn("parry", {
                    action: `parry:${it.id}`,
                    label:  tFormat("WITCHER.App.DefensePromptDialog.Dialog.Button.ParryX", { it: it.name }, "Parry — {it}"),
                    icon:   "fa-solid fa-shield-halved"
                });
            }
        }
        /* Natural-weapon parry (race toggle) — an ADDITIONAL option alongside any
         * weapon parry. gate.parry already excludes ranged (no parry) and
         * deniesParry weapons, so it's melee-only and can't beat Crushing Force. */
        if (nwCanParry) {
            pushBtn("parry", {
                action: "parry:natural",
                label:  t("WITCHER.App.DefensePromptDialog.Dialog.Button.ParryNatural", "Parry (Natural Weapon)"),
                icon:   "fa-solid fa-shield-halved"
            });
        }
        /* Base monster-attack parry (stat-block toggle) — item-less, rolls the
         * attack's own skill. Melee-only (filtered when gathered above). */
        for (const b of baseParry) {
            pushBtn("parry", {
                action: `parry:base:${b.idx}`,
                label:  tFormat("WITCHER.App.DefensePromptDialog.Dialog.Button.ParryX", { it: b.name }, "Parry — {it}"),
                icon:   "fa-solid fa-shield-halved"
            });
        }
    }
    if (gate.block) {
        if (blockItems.length <= 1) {
            pushBtn("block", {
                action: "block",
                label:  blockItem ? `Block (${blockItem.name})` : "Block",
                disabled: !blockItem,
                icon: "fa-solid fa-shield"
            });
        } else {
            for (const it of blockItems) {
                pushBtn("block", {
                    action: `block:${it.id}`,
                    label:  tFormat("WITCHER.App.DefensePromptDialog.Dialog.Button.BlockX", { it: it.name }, "Block — {it}"),
                    icon:   "fa-solid fa-shield"
                });
            }
        }
        /* Natural-weapon block (race toggle) — melee only (a claw can't intercept
         * an arrow or a spell, and a bomb needs hard cover), so it's excluded when
         * a shield-cover block is required. Full block; costs 1 HP on success. */
        if (nwCanBlock && !requiresShieldCover && !isCast && !isBomb) {
            pushBtn("block", {
                action: "block:natural",
                label:  t("WITCHER.App.DefensePromptDialog.Dialog.Button.BlockNatural", "Block (Natural Weapon)"),
                icon:   "fa-solid fa-shield"
            });
        }
        /* Base monster-attack block (stat-block toggle) — item-less, melee only
         * (a claw can't intercept an arrow / spell / bomb). */
        if (!requiresShieldCover && !isCast && !isBomb) {
            for (const b of baseBlock) {
                pushBtn("block", {
                    action: `block:base:${b.idx}`,
                    label:  tFormat("WITCHER.App.DefensePromptDialog.Dialog.Button.BlockX", { it: b.name }, "Block — {it}"),
                    icon:   "fa-solid fa-shield"
                });
            }
        }
    }
    if (gate.dodge) {
        pushBtn("dodge", {
            action: "dodge",
            label:  t("WITCHER.Common.Dodge", "Dodge"),
            icon:   "fa-solid fa-person-running",
            disabled: blockedActions.has("dodge")
        });
    }
    /* Brawling defense — two flavors sharing the `brawlBlock` engine:
     *
     *   - "Arm Block" (RAW + CE, vs weapon strikes): bare-hands intercept,
     *     REF + Brawling roll; the incoming hit is redirected to a random
     *     arm — damage applies against arm SP instead of the location the
     *     attacker rolled.
     *   - "Brawling" (CE only, vs the grapple family): CE spec allows the
     *     defender to resist a grapple attempt — or a follow-up pin / choke
     *     / throw / ride — by rolling their own Brawling opposed to the
     *     attacker's. Same engine as Arm Block on our side; the label
     *     changes so the player understands they're wrestling out rather
     *     than tanking a hit on the forearm.
     *
     * Nested UNDER the Block column so the layout stays compact (no extra
     * column that would overflow the dialog width). */
    if (gate.brawlBlock) {
        const isGrappleFamily = GRAPPLE_DEFENSE_KINDS.has(attackKind);
        /* Unarmed Brawling defense — ALWAYS present when brawlBlock is gated.
         * This is the plain body-on-body resist and must never be replaced by
         * the weapon option below (they're distinct choices). */
        pushBtn("block", {
            action: "brawlBlock",
            label:  isGrappleFamily ? "Brawling" : "Arm Block",
            icon:   "fa-solid fa-hand-fist",
            disabled: blockedActions.has("brawlBlock")
        });
        /* ADDITIONAL option (never a replacement): resist with a Grappling
         * weapon, rolling THAT weapon's skill instead of unarmed Brawling
         * (the *** rule). Encoded as `brawlBlock:<itemId>` so the socket-side
         * roll knows which weapon to use; falls back to unarmed if the item is
         * gone. Only offered for grapple-family kinds and only when the
         * defender actually has such a weapon. */
        if (isGrappleFamily) {
            const gw = findGrappleWeapon(defenderActor);
            if (gw) {
                pushBtn("block", {
                    action: `brawlBlock:${gw.id}`,
                    label:  tFormat("WITCHER.App.DefensePromptDialog.Dialog.Button.GrappleWith", { name: gw.name }, `Grapple (${gw.name})`),
                    icon:   "fa-solid fa-hand-fist",
                    disabled: blockedActions.has("brawlBlock")
                });
            }
        }
    }
    if (gate.reposition) {
        /* Reposition button availability:
         *
         *   Combat Extended ON  — per-defence allowance is ½SPD, and
         *     total across all defences this round is capped at SPD.
         *     Disable the button once the SPD round budget is spent
         *     rather than letting the click open a doomed overlay.
         *
         *   Combat Extended OFF — per-defence allowance is still ½SPD,
         *     but the per-round cumulative cap is lifted. As many
         *     reposition reactions as attacks come in are allowed, so
         *     the button never disables on budget grounds; the label
         *     also drops the "X/SPD" tally since there's no total to
         *     tally against. */
        const spd = Number(defenderActor?.system?.stats?.spd?.value) || 0;
        const priorReposition = Number(defenderActor?.system?.combatRound?.repositionMeters) || 0;
        const halfSpd = Math.floor(spd / 2);
        const roundRemaining = ceOn
            ? (spd > 0 ? Math.max(0, spd - priorReposition) : Infinity)
            : Infinity;
        const canReposition = spd > 0 && roundRemaining > 0 && halfSpd > 0;
        pushBtn("reposition", {
            action:   "reposition",
            label:    (ceOn && spd > 0)
                ? `Reposition (${priorReposition}/${spd}m)`
                : "Reposition",
            icon:     "fa-solid fa-arrows-up-down-left-right",
            disabled: !canReposition || blockedActions.has("reposition")
        });
    }
    if (gate.resistMagic) {
        /* Resist Magic — WILL + Resist Magic skill roll. No item, no
         * position cost, no round budget. Only surfaces when the spell /
         * hex explicitly lists "resistmagic" in its defense clause. */
        pushBtn("resistMagic", {
            action: "resistMagic",
            label:  t("WITCHER.App.DefensePromptDialog.Dialog.Button.ResistMagic", "Resist Magic"),
            icon:   "fa-solid fa-hand-sparkles",
            disabled: blockedActions.has("resistMagic")
        });
    }
    if (gate.spellCasting) {
        /* Spell Casting — WILL + Spell Casting. The counter-cast defence
         * declared by Dispel, whose own defence clause is "spellcasting".
         * Same shape as Resist Magic: a skill roll, no item, no position
         * cost. */
        pushBtn("spellCasting", {
            action: "spellCasting",
            label:  t("WITCHER.App.DefensePromptDialog.Dialog.Button.SpellCasting", "Spell Casting"),
            icon:   "fa-solid fa-wand-sparkles",
            disabled: blockedActions.has("spellCasting")
        });
    }
    pushBtn("none", { action: "none", label: t("WITCHER.App.DefensePromptDialog.Dialog.Button.TakeIt", "Take it"), default: true, icon: "fa-solid fa-xmark" });

    /* Render one button (matches the kind-column layout — used in the inline
     * action row, not DialogV2's hidden footer). */
    const renderInlineBtn = (b) => `
        <button type="button" class="wdm-defense-btn${b.default ? " default" : ""}"
            data-action="${escAttr(b.action)}"${b.disabled ? " disabled" : ""}>
            <i class="${escAttr(b.icon)}"></i>
            <span>${escText(b.label)}</span>
        </button>`;
    const renderCol = (kind) => {
        const items = cols[kind];
        if (!items.length) return "";
        return `<div class="wdm-defense-col" data-kind="${kind}">${items.map(renderInlineBtn).join("")}</div>`;
    };
    const actionsHtml = `
        <div class="wdm-defense-actions">
            ${renderCol("parry")}
            ${renderCol("block")}
            ${renderCol("dodge")}
            ${renderCol("reposition")}
            ${renderCol("resistMagic")}
            ${renderCol("none")}
        </div>`;

    /* Append a small note explaining why parry/block are missing for
     * gated attacks (RAW reference). Quality-driven denial gets its own
     * line so the defender knows the attack kind isn't the cause. */
    const kindGated   = !baseGate.parry || !baseGate.block;
    const qualityGate = baseGate.parry && !gate.parry;   // parry stripped by deniesParry
    const spdForNote  = Number(defenderActor?.system?.stats?.spd?.value) || 0;
    const priorRepositionForNote = Number(defenderActor?.system?.combatRound?.repositionMeters) || 0;
    const repositionCapReached = spdForNote > 0 && priorRepositionForNote >= spdForNote;
    /* Build the "valid defenses" hint from the actual gate — under CE,
     * grapple-family attacks add Brawling as a valid response (grapple
     * still allows Dodge + Reposition; pin/choke/throw/ride drop those
     * and leave Brawling only). RAW mode keeps the original wording. */
    const validDefenseNames = [
        gate.dodge && t("WITCHER.Common.Dodge", "Dodge"),
        gate.reposition && "Reposition",
        gate.brawlBlock && "Brawling"
    ].filter(Boolean);
    const validDefenseText = validDefenseNames.length
        ? validDefenseNames.join(" / ")
        : "Dodge / Reposition";
    const gateNote = [
        kindGated
            ? `<div style="margin-top:4px;font-size:0.6875rem;color:#b97;opacity:0.85;">Only ${escText(validDefenseText)} are valid against ${escText(STRIKE_LABELS[attackKind] ?? "this attack")} (RAW Core p.163-164).</div>`
            : "",
        qualityGate
            ? `<div style="margin-top:4px;font-size:0.6875rem;color:#b97;opacity:0.85;">Parry denied — the attacker's weapon cannot be parried (e.g. Crushing Force).</div>`
            : "",
        /* Under CE the note tracks the per-round SPD tally + cap-reached
         * state. Under RAW (CE off) there is no round cap, so the note
         * just states the per-defence ½SPD ceiling — no tally to display,
         * no cap to reach. */
        gate.reposition && spdForNote > 0
            ? (ceOn
                ? (repositionCapReached
                    ? `<div style="margin-top:4px;font-size:0.6875rem;color:#b97;opacity:0.85;">Reposition cap reached — ${priorRepositionForNote} of ${spdForNote}m used this round.</div>`
                    : `<div style="margin-top:4px;font-size:0.6875rem;opacity:0.65;">Reposition: ${priorRepositionForNote} / ${spdForNote}m used this round (half-SPD ${Math.floor(spdForNote/2)}m per defense).</div>`)
                : `<div style="margin-top:4px;font-size:0.6875rem;opacity:0.65;">Reposition: up to half-SPD (${Math.floor(spdForNote/2)}m) per defense, no round cap (CE off).</div>`)
            : ""
    ].join("");

    let dialog = null;
    let resolved = false;
    return await new Promise((resolve) => {
        const finalize = (result) => {
            if (resolved) return;
            resolved = true;
            try { dialog?.close?.({ force: true }); } catch (_) { /* already closed */ }
            resolve(result);
        };
        /* Timeout is opt-in. Callers that want a hard cap can pass
         * `timeoutMs` explicitly; the default `null` lets the defender
         * take as long as they need — closing the dialog by clicking
         * "Take it" or a defense action is the only path to resolution. */
        const timer = (typeof timeoutMs === "number" && timeoutMs > 0)
            ? setTimeout(() => finalize({ action: "none", timedOut: true }), timeoutMs)
            : null;

        /* Translate a raw action string ("parry", "parry:<id>", "dodge", "none")
         * into the shaped result the caller expects, folding in the extra-mod
         * input. Shared by both the inline-button click handler (the visible
         * path) and the DialogV2 footer fallback (hidden — only reachable if
         * someone overrides the CSS that hides it). */
        const buildResult = (raw, root) => {
            const result = { action: raw };
            const colon = raw.indexOf(":");
            if (colon > 0) {
                result.action = raw.slice(0, colon);
                result.itemId = raw.slice(colon + 1);
            } else {
                if (result.action === "parry") result.itemId = parryItem?.id ?? null;
                if (result.action === "block") result.itemId = blockItem?.id ?? null;
            }
            if (result.action !== "none") {
                const v = root?.querySelector?.('[name="extraMod"]')?.value;
                const n = Math.round(Number(v) || 0);
                if (n) result.extraMod = n;
            }
            return result;
        };

        DialogV2.wait({
            window: {
                title: tFormat("WITCHER.Dialog.Defense.Incoming", { strike: strikeLabel, shot: shotTag, weapon: weaponName ?? "" }, "Incoming {strike}{shot} — {weapon}").trim(),
                icon: "fa-solid fa-shield-halved"
            },
            classes: ["wdm-defense-prompt-dialog"],
            content: buildContent(gateNote) + actionsHtml,
            buttons,
            rejectClose: false,
            render: (_event, dlg) => {
                dialog = dlg;
                const root = dlg.element;
                /* Wire the inline kind-column buttons. Clicking one resolves
                 * the outer Promise (via finalize) and closes the dialog —
                 * the hidden DialogV2 footer never participates. */
                root.querySelectorAll(".wdm-defense-btn").forEach(btn => {
                    btn.addEventListener("click", (ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                        if (btn.disabled) return;
                        finalize(buildResult(btn.dataset.action || "none", root));
                    });
                });
            }
        }).then(action => {
            clearTimeout(timer);
            // DialogV2 footer is hidden — this path only fires if a user/style
            // override re-exposes it, or DialogV2 itself synthesises a default.
            finalize(buildResult(action || "none", dialog?.element));
        }).catch(() => {
            clearTimeout(timer);
            finalize({ action: "none" });
        });
    });
}
