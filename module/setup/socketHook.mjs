/**
 * registerSocket — wires socket listeners for GM-proxied actions during `ready`.
 *
 * Pattern: player clients emit messages with a `type` discriminator on the
 * system channel `system.witcher-ttrpg-death-march`; the GM client handles
 * them. Used for cross-actor updates that players lack permission to perform
 * directly (rewarding IP from a chat card, applying damage / status to
 * tokens owned by others, etc.).
 *
 * Adding a new message type:
 *   1. Define a sender helper in this file (`export async function emitX(...)`)
 *      so callers don't construct payloads by hand.
 *   2. Add a case to `handleSocketMessage`.
 *   3. Implement the handler — at minimum, validate inputs and update the
 *      target document.
 *
 * Phase 6 covers the registration + the most common messages (damage,
 * IP grant). More types land alongside Phase 7's mechanic port.
 */

import { drainHp, ATTACK_LOCATIONS, getActiveWeaponQualities, WEAPON_QUALITIES } from "./config.mjs";
import { resolveDamage } from "../combat/damageCalculator.mjs";
import { renderDamageBreakdown } from "../combat/damageBreakdown.mjs";
import { autoApplyCriticalWound } from "../chrome/chrome/critical-roll.js";
import { applyQualityRiders, appendAttackResult } from "../documents/mixins/weaponAttackMixin.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const CHANNEL = `system.${SYSTEM_ID}`;
const PARCHMENT_FLAG = "parchments";

/* GM-side permission gate for any socket message that mutates an actor
 * the sender doesn't own.
 *
 * The senders below stamp their user id into the payload as
 * `senderUserId`. The GM handler resolves the target actor (via uuid)
 * and checks the sender's permission against the actor's ownership
 * map. The default required level is OBSERVER (read access is enough
 * to act on a hostile token — e.g. apply Bleeding to a defender you
 * struck), but GM-only actions like grantIP take OWNER.
 *
 * No senderUserId on the payload = direct GM call (handler invoked
 * synchronously from emit() when isActiveGM). Trusted.
 *
 * Surfaced by the multi-player audit S5: handlers were trusting any
 * caller, so a malicious player could socket-call to apply Stunned
 * to a GM-only NPC. */
function authorizeSocket(payload, target, requiredLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OBSERVER ?? 2) {
    const senderUserId = payload?.senderUserId;
    if (!senderUserId) return true;                /* direct GM call */
    const user = game.users?.get(senderUserId);
    if (!user) return false;
    if (user.isGM) return true;
    if (!target) return false;
    /* For documents, prefer the doc's own permission test. */
    if (typeof target.testUserPermission === "function") {
        return target.testUserPermission(user, requiredLevel);
    }
    /* Fallback: read ownership map directly. */
    const level = Number(target?.ownership?.[user.id]
        ?? target?.ownership?.default
        ?? 0);
    return level >= requiredLevel;
}

export function registerSocket() {
    game.socket.on(CHANNEL, handleSocketMessage);
}

function handleSocketMessage(data) {
    // Farkle PvP traffic is peer-routed in minigames/farkle/net.mjs,
    // not GM-proxied; ignore it here so it doesn't trip the unknown warning.
    // `farkleLobby` is GM-authoritative but has its own listener in lobby.mjs.
    if (data?.type === "farkle" || data?.type === "farkleLobby") return;

    /* Direct user→user messages — gated on `recipientUserId` so a single
     * broadcast only acts on the addressed client. Defense prompt round-
     * trip lives here so it bypasses the GM-only gate below. */
    if (data?.type === "defenseRequest") {
        if (data.recipientUserId !== game.user?.id) return;
        return handleDefenseRequest(data);
    }
    if (data?.type === "defenseResponse") {
        if (data.recipientUserId !== game.user?.id) return;
        return handleDefenseResponse(data);
    }

    if (!game.user.isActiveGM) return;
    switch (data?.type) {
        case "applyDamage":       return handleApplyDamage(data);
        case "applyStatus":       return handleApplyStatus(data);
        case "pushToken":         return handlePushToken(data);
        case "reduceReliability": return handleReduceReliability(data);
        case "grantIP":           return handleGrantIP(data);
        case "grantReputation":   return handleGrantReputation(data);
        case "addSceneParchment": return handleAddSceneParchment(data);
        case "removeSceneParchment": return handleRemoveSceneParchment(data);
        case "giftItem":          return handleGiftItem(data);
        case "holdApply":         return handleHoldApply(data);
        case "holdClear":         return handleHoldClear(data);
        case "holdReverse":       return handleHoldReverse(data);
        default:
            console.warn(`${SYSTEM_ID} | unknown socket message`, data);
    }
}

/* GM-side handlers for the hold-link wrappers in mechanics/holdLink.
 * The sender's permission against the relevant actors is checked first
 * so a player Clinching a GM-owned NPC still has to own the holder
 * side (their own PC) — they can't socket-spoof a hold by another
 * player's character. */
async function handleHoldApply(payload) {
    const holder = await fromUuid(payload?.holderUuid);
    const target = await fromUuid(payload?.targetUuid);
    if (!holder || !target) return;
    /* Sender must OWN the holder; for the target, OBSERVER is enough
     * (you can clinch a token you can see/click, even if you don't
     * own it). */
    const OWNER  = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
    if (!authorizeSocket(payload, holder, OWNER)) {
        console.warn(`${SYSTEM_ID} | holdApply refused — sender ${payload?.senderUserId} doesn't own holder ${holder.name}`);
        return;
    }
    if (!authorizeSocket(payload, target)) {
        console.warn(`${SYSTEM_ID} | holdApply refused — sender ${payload?.senderUserId} lacks permission on target ${target.name}`);
        return;
    }
    const { _doApplyHoldLink } = await import("../mechanics/holdLink.mjs");
    await _doApplyHoldLink(holder, target, payload.kind);
}

async function handleHoldClear(payload) {
    const actor = await fromUuid(payload?.actorUuid);
    if (!actor) return;
    const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
    if (!authorizeSocket(payload, actor, OWNER)) {
        console.warn(`${SYSTEM_ID} | holdClear refused — sender ${payload?.senderUserId} doesn't own ${actor.name}`);
        return;
    }
    /* Optional partner uuid for targeted (one-pair) clear. When
     * absent, cascades over every pair the actor is in. */
    const partner = payload?.partnerUuid ? await fromUuid(payload.partnerUuid) : null;
    const { _doClearHoldLink } = await import("../mechanics/holdLink.mjs");
    await _doClearHoldLink(actor, payload.reason ?? "manual", partner);
}

/* CE Reverse Grapple socket handler. Sender must OWN the actor (the
 * one attempting the reversal). Partner (current holder) is looked up
 * on the GM side. */
async function handleHoldReverse(payload) {
    const actor   = await fromUuid(payload?.actorUuid);
    const partner = await fromUuid(payload?.partnerUuid);
    if (!actor || !partner) return;
    const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
    if (!authorizeSocket(payload, actor, OWNER)) {
        console.warn(`${SYSTEM_ID} | holdReverse refused — sender ${payload?.senderUserId} doesn't own ${actor.name}`);
        return;
    }
    const { _doReverseHold } = await import("../mechanics/holdLink.mjs");
    await _doReverseHold(actor, partner, payload.kind);
}

/* -------------------------------------------------------------------------- */
/* Senders (call these from non-GM code)                                      */
/* -------------------------------------------------------------------------- */

/* Apply damage to a target.  Accepts the legacy shape (amount + type +
 * location label + throughArmor) AND the new richer shape (weaponDamage +
 * damageTypes array + locationKey + qualities + qualityValues + critBonus).
 * The handler converts whichever fields are present into the damage-
 * calculator's input shape and runs the full RAW pipeline. */
export function emitApplyDamage(payload) {
    if (game.user.isActiveGM) return handleApplyDamage(payload);
    /* Stamp senderUserId so the GM-side handler can authorize against
     * the target's ownership map. IMPORTANT: spread `payload` FIRST so
     * the `type: "applyDamage"` discriminator can't be overwritten by
     * a caller that also passes `type: "slashing"` (the legacy damage-
     * type field). Without this ordering, the GM client's dispatcher
     * saw `type:"slashing"` → unknown message → silently dropped.
     * (Multi-player audit S1.) */
    game.socket.emit(CHANNEL, { ...payload, type: "applyDamage", senderUserId: game.user?.id });
}

export function emitApplyStatus({ targetUuid, statusId, action = "toggle", sourceTangible = undefined }) {
    if (game.user.isActiveGM) return handleApplyStatus({ targetUuid, statusId, action, sourceTangible });
    game.socket.emit(CHANNEL, { type: "applyStatus", targetUuid, statusId, action, sourceTangible, senderUserId: game.user?.id });
}

/* Knockback push. Moves a token AWAY from a scene point by `distanceMeters`
 * (metres), cut short at the first wall collision. Routed through the GM
 * so a player pushing a GM-owned NPC (Push Kick vs bandit) still lands
 * the move even though the caller lacks token-owner permission. Payload
 * carries a token UUID rather than an actor UUID so we operate on the
 * exact placed token being pushed — the same actor could have multiple
 * tokens on the scene. */
export function emitPushToken({ tokenUuid, sourcePoint, distanceMeters }) {
    if (game.user.isActiveGM) return handlePushToken({ tokenUuid, sourcePoint, distanceMeters });
    game.socket.emit(CHANNEL, { type: "pushToken", tokenUuid, sourcePoint, distanceMeters, senderUserId: game.user?.id });
}

/* Reduce a weapon/shield's Reliability by 1 (floored at 0). Used to
 * auto-charge a Block defense after the attack resolves and shows the
 * Block beat the attack roll. Routed through the GM so the attacker's
 * client can trigger it without needing write permission on the
 * defender's item.
 *
 * `attackMessageUuid` (optional): when provided, the "absorbs a block"
 * notice folds INTO the attack card's collapsible result block
 * instead of posting a standalone chat message. */
export function emitReduceReliability({ itemUuid, attackMessageUuid = null }) {
    if (game.user.isActiveGM) return handleReduceReliability({ itemUuid, attackMessageUuid });
    game.socket.emit(CHANNEL, { type: "reduceReliability", itemUuid, attackMessageUuid, senderUserId: game.user?.id });
}

export function emitGrantIP({ actorUuid, label, value }) {
    if (game.user.isActiveGM) return handleGrantIP({ actorUuid, label, value });
    game.socket.emit(CHANNEL, { type: "grantIP", actorUuid, label, value });
}

export function emitGrantReputation({ actorUuid, delta }) {
    if (game.user.isActiveGM) return handleGrantReputation({ actorUuid, delta });
    game.socket.emit(CHANNEL, { type: "grantReputation", actorUuid, delta });
}

/* Notice-board parchments: players can't write scene flags, so posting
 * (add) and swiping/removing a posting route through the GM client. */
export function emitAddSceneParchment({ sceneId, entry }) {
    if (game.user.isActiveGM) return handleAddSceneParchment({ sceneId, entry });
    game.socket.emit(CHANNEL, { type: "addSceneParchment", sceneId, entry });
}

export function emitRemoveSceneParchment({ sceneId, entryId }) {
    if (game.user.isActiveGM) return handleRemoveSceneParchment({ sceneId, entryId });
    game.socket.emit(CHANNEL, { type: "removeSceneParchment", sceneId, entryId });
}

/* Gift an item from one actor to another. The sender's client may not own
 * the recipient (player A gifting to player B), so the GM proxies the
 * transfer: decrement / delete on source, add to target via actor.addItem
 * (which stack-merges into a matching pile if one exists). */
export function emitGiftItem({ sourceActorUuid, targetActorUuid, itemId, quantity = 1, fromUserId = null }) {
    const payload = { type: "giftItem", sourceActorUuid, targetActorUuid, itemId, quantity, fromUserId };
    if (game.user.isActiveGM) return handleGiftItem(payload);
    game.socket.emit(CHANNEL, payload);
}

/* -------------------------------------------------------------------------- */
/* Handlers (run on the GM client only)                                       */
/* -------------------------------------------------------------------------- */

const ARMOR_LOCS = ["head", "torso", "leftArm", "rightArm", "leftLeg", "rightLeg", "tailWing"];

/* Aggregate equipped armor into the per-location { sp, dr, itemIds } shape
 * the damage calculator expects. SP is the sum of every equipped piece's
 * {location}Stopping (no layering rules yet — simple stack). DR booleans
 * (bludgeoning / slashing / piercing) are unioned across pieces.
 *
 * Armor exposes per-location SP TWO ways: the raw `{loc}Stopping` field
 * on the base system, and the post-enhancement `system.effective.stopping`
 * map (computed by deriveArmorEffective). The effective map IS the truth
 * (it folds in socketed glyphs / mods) but the base fields are the
 * authoritative storage; we prefer effective.stopping when present and
 * fall back to the base field so a pre-effective item still soaks. */
function buildArmorShape(actor) {
    const armor = {};
    for (const item of actor.items ?? []) {
        if (item.type !== "armor" || !item.system?.equipped) continue;
        const eff = item.system?.effective ?? {};
        const sys = item.system;
        const drTypes = [];
        // DR booleans are exposed on effective; fall back to base.
        if (eff.bludgeoning ?? sys.bludgeoning) drTypes.push("bludgeoning");
        if (eff.slashing    ?? sys.slashing)    drTypes.push("slashing");
        if (eff.piercing    ?? sys.piercing)    drTypes.push("piercing");
        /* EO Fireproof (p.8): "Reduces fire damage by half and confers
         * immunity to the Burning status." Adding 'fire' / 'elemental'
         * to the location's DR list makes the damage calculator's DR
         * halving stage fire on those types. Burning-immunity portion
         * is enforced by the status-application path (it skips
         * application when the actor's worn armor has `fireproof`). */
        const armorQualities = sys?.effective?.qualities ?? sys?.qualities ?? [];
        const isFireproof = armorQualities.some(q => q === "fireproof");
        if (isFireproof) {
            drTypes.push("fire", "elemental");
        }
        for (const loc of ARMOR_LOCS) {
            // effective.stopping[loc].value wins; base {loc}Stopping is the fallback.
            const sp = Number(eff.stopping?.[loc]?.value ?? sys[`${loc}Stopping`]) || 0;
            if (sp <= 0) continue;
            if (!armor[loc]) armor[loc] = { sp: 0, dr: [], itemIds: [] };
            armor[loc].sp += sp;
            armor[loc].itemIds.push(item.id);
            for (const t of drTypes) if (!armor[loc].dr.includes(t)) armor[loc].dr.push(t);
        }
    }
    /* Combat Extended — overlay raised shield reliability as additional
     * SP at covered locations (rules1: "your shield's reliability acts
     * as SP / Armor"). The shield's item id rides in itemIds so the
     * ablation handler can drain reliability per penetrating hit. The
     * patch handler branches on `item.type === "shield"` to write
     * `system.reliability.value` instead of `<loc>Stopping`.
     *
     * Approximation note: every penetrating hit ablates BOTH the shield
     * AND the worn armor at the location by 1 each (calculator emits one
     * patch per itemId). A strict-RAW reading would have the shield
     * absorb fully before armor takes any chip — that needs a new
     * calculator stage and is deferred. Today's behavior: shield + armor
     * stack their SP, both lose 1 per hit until one runs out (the broken
     * shield then contributes 0 to the next hit's SP since buildArmorShape
     * reads reliability live). */
    const sr = actor?.system?.guard?.shieldRaised;
    if (sr?.itemId && Array.isArray(sr.coveredLocations) && sr.coveredLocations.length > 0) {
        const shield = actor.items?.get?.(sr.itemId);
        const rel = Number(shield?.system?.reliability?.value) || 0;
        if (shield && shield.type === "shield" && rel > 0) {
            for (const loc of sr.coveredLocations) {
                if (!ARMOR_LOCS.includes(loc)) continue;
                if (!armor[loc]) armor[loc] = { sp: 0, dr: [], itemIds: [] };
                armor[loc].sp += rel;
                if (!armor[loc].itemIds.includes(shield.id)) armor[loc].itemIds.push(shield.id);
            }
        }
    }
    return armor;
}

/* Scan for an Active Effect that represents the target's Active Shield —
 * marked by an `activeShieldHp` flag in the system namespace.  Returns
 * `{ hp, effectId }` so the handler can both feed the calculator AND
 * write the drained value back to the AE.  The flag-driven model lets
 * GMs apply / adjust shields by hand (token HUD, macros) without a
 * dedicated cast handler — RAW magic stays manual per earlier locked
 * decision; the calculator just respects whatever shield is on the
 * actor when an attack lands. */
function buildActiveShield(actor) {
    for (const ae of actor.effects ?? []) {
        if (ae.disabled) continue;
        const hp = Number(ae.getFlag?.(SYSTEM_ID, "activeShieldHp"));
        if (Number.isFinite(hp) && hp > 0) return { hp, effectId: ae.id };
    }
    return null;
}

/* For monsters: their SP is a single flat number on `combat.armor` that
 * applies to every location. Modeled as natural armor (separate from worn
 * armor so the bypassesNaturalArmor flag can target it).  No item-level
 * ablation (monster hides aren't items) — itemIds stays empty. */
function buildNaturalArmorShape(actor) {
    if (actor.type !== "monster") return {};
    const sp = Number(actor.system?.combat?.armor) || 0;
    if (sp <= 0) return {};
    const natural = {};
    for (const loc of ARMOR_LOCS) natural[loc] = { sp, dr: [], itemIds: [] };
    return natural;
}

/* Derive monster combat flags from the actor's authored data:
 *   resistNonSilver / resistNonMeteorite  ←  combat.weaponWeakness (silver|meteorite|none)
 *   vulnerableTo / resistTypes / immuneToTypes  ←  combat.damageProfile (per-type enum)
 *   immuneToOrganCrits  ←  category in {elementa, specter} (RAW Core p.159)
 * The two weapon-weakness flags are INDEPENDENT of the per-type lists —
 * a slashing-resistant monster that also takes half from non-silver
 * weapons quarters non-silver slashing hits and halves silver slashing
 * hits (the calculator stacks them multiplicatively). */
function buildMonsterFlags(actor) {
    if (actor.type !== "monster") return {};
    const sys      = actor.system ?? {};
    const profile  = sys.combat?.damageProfile ?? {};
    const weakness = sys.combat?.weaponWeakness ?? "none";
    /* Organ-crit immunity — explicit per-monster override on
     * system.combat.immuneToOrganCrits ("auto" | "true" | "false")
     * wins; "auto" falls back to category default (elementa / specter
     * are immune by default). */
    const overrideOrgan = sys.combat?.immuneToOrganCrits;
    const categoryOrgan = sys.category === "elementa" || sys.category === "specter";
    const flags = {
        resistNonSilver:    weakness === "silver",
        resistNonMeteorite: weakness === "meteorite",
        vulnerableTo:  [],
        resistTypes:   [],
        immuneToTypes: [],
        immuneToOrganCrits:
            overrideOrgan === "true"  ? true  :
            overrideOrgan === "false" ? false :
            categoryOrgan
    };
    for (const [type, reaction] of Object.entries(profile)) {
        if (reaction === "vulnerable") flags.vulnerableTo.push(type);
        else if (reaction === "resistant") flags.resistTypes.push(type);
        else if (reaction === "immune")    flags.immuneToTypes.push(type);
    }
    return flags;
}

/* Map an ATTACK_LOCATIONS key → the calculator's { key, mult, label } shape.
 * Falls back to a torso ×1 hit so unknown keys don't blow up the math. */
function resolveLocation(locationKey, locationLabel) {
    const entry = ATTACK_LOCATIONS[locationKey];
    if (!entry) return { key: "torso", mult: 1, label: locationLabel || "Torso" };
    return { key: locationKey, mult: entry.mult, label: locationLabel || locationKey };
}

/* Crit-bonus ladder per RAW Core p.158.  Normal targets get the standard
 * Simple +3 / Complex +5 / Difficult +8 / Deadly +10.  Elementa / specter
 * targets get the higher "Bonus Damage" table values (+5/+10/+15/+20)
 * because the organ-based wound effect doesn't apply to them — the
 * stronger flat bonus replaces it (Core p.159 sidebar). */
const CRIT_BONUS_NORMAL    = { simple: 3, complex: 5,  difficult: 8,  deadly: 10 };
const CRIT_BONUS_NO_ORGANS = { simple: 5, complex: 10, difficult: 15, deadly: 20 };
function critBonusFor(severity, immuneToOrganCrits) {
    if (!severity) return 0;
    const ladder = immuneToOrganCrits ? CRIT_BONUS_NO_ORGANS : CRIT_BONUS_NORMAL;
    return ladder[severity] ?? 0;
}

/* Translate the weapon's quality keys into the boolean flags the damage
 * calculator wants. Reads each quality's `damageFlags` config from the
 * active catalog (data-driven via the Qualities Editor) — adding or
 * retargeting a flag is a settings change, not a code edit. Status-rider
 * qualities fire in weaponAttackMixin AFTER damage applies. */
export function qualitiesToDamageFlags(qualities = []) {
    const cat = getActiveWeaponQualities?.() ?? WEAPON_QUALITIES;
    const flags = {
        armorPiercing: false, improvedArmorPiercing: false, ablating: false,
        doubleAblation: false, deniesParry: false,
        bypassesWornArmor: false, bypassesNaturalArmor: false, bypassesShield: false,
        isSilver: false, isMeteorite: false, silverDamage: 0,
        /* Defender-side reaction hints (EO weapon qualities):
         *   indirect — attacker's weapon is Indirect → defender's Block /
         *              Parry rolls take an additional -2 (EO p.7). */
        indirect: false
    };
    for (const key of qualities) {
        const df = cat[key]?.damageFlags;
        if (!df) continue;
        for (const [flag, value] of Object.entries(df)) {
            if (value) flags[flag] = true;
        }
    }
    return flags;
}

async function handleApplyDamage(payload) {
    const target = await fromUuid(payload?.targetUuid);
    if (!target) return;
    /* Permission gate (multi-player audit S5): players can only
     * trigger damage against targets they have at least OBSERVER on
     * (any token they can see/click). The handler runs on the GM
     * client with full perms, so without this check a malicious
     * player could socket-call emitApplyDamage on any actor. */
    if (!authorizeSocket(payload, target)) {
        console.warn(`${SYSTEM_ID} | applyDamage refused — sender ${payload?.senderUserId} lacks permission on ${target.name}`);
        return;
    }

    // Backwards-compat: callers (chat macros, older buttons) may send
    // `amount` instead of `weaponDamage`, `type` (label) instead of
    // `damageTypes` (array), and `location` (label) instead of `locationKey`.
    let weaponDamage = Number(payload.weaponDamage ?? payload.amount);
    if (!Number.isFinite(weaponDamage)) return;

    /* Oil bonus damage. Read the attacker's weapon from `payload.weaponUuid`
     * (stamped by the damage-button click handler in weaponAttackMixin)
     * and fold the oil's authored bonus into weaponDamage when the target
     * matches the oil's target category (or the oil is universal — empty
     * oilTarget). Falls back to the attack message's system.weaponUuid.
     *
     * Runs regardless of the homebrew toggle — appliedOil is the
     * canonical store; an oil with a bonus is always meant to bite when
     * the category matches. Pre-Reborn worlds where appliedOil was
     * untouched will have oilBonusDamage = 0 and add nothing.
     *
     * Audit trail: oilBonusApplied tracks the WHO/WHY of the fold so the
     * damage breakdown card can show "Oil bonus +X — weapon Y + oil X =
     * combined" instead of an unexplained jump in the base number. */
    let oilBonusApplied = null;
    try {
        let weaponUuid0 = payload.weaponUuid || "";
        if (!weaponUuid0 && payload.attackMessageUuid) {
            const attackMsg0 = await fromUuid(payload.attackMessageUuid);
            weaponUuid0 = attackMsg0?.system?.weaponUuid || "";
        }
        const weapon0 = weaponUuid0 ? await fromUuid(weaponUuid0) : null;
        const ao = weapon0?.system?.appliedOil;
        const bonus = Number(ao?.oilBonusDamage) || 0;
        if (bonus > 0) {
            const targetCat = String(target?.system?.category || "").toLowerCase();
            const oilTarget = String(ao?.oilTarget || "").toLowerCase();
            const matched = !oilTarget || (targetCat && oilTarget === targetCat);
            if (matched) {
                const baseWeapon = weaponDamage;
                weaponDamage = weaponDamage + bonus;
                oilBonusApplied = {
                    oilName:  String(ao?.name || "Oil"),
                    bonus,
                    baseWeapon,
                    combined: weaponDamage,
                    targetLabel: oilTarget ? String(ao?.oilTarget || "") : ""
                };
            }
        }
    } catch (err) {
        console.warn(`${SYSTEM_ID} | oil bonus damage fold failed`, err);
    }

    const damageTypes = Array.isArray(payload.damageTypes)
        ? payload.damageTypes
        : (payload.type ? [String(payload.type).toLowerCase()] : []);

    const location = resolveLocation(payload.locationKey, payload.location ?? payload.locationLabel);
    const qualityFlags = qualitiesToDamageFlags(payload.qualities);

    // `throughArmor: true` is the legacy "raw damage to HP" shortcut. Map
    // it to full bypass so the calculator skips SP + DR + shield stages.
    const fullBypass = !!payload.throughArmor;

    // Build target shape first so we can read its monster flags to pick
    // the right crit-bonus ladder (elementa/specter get the higher one).
    const activeShield = buildActiveShield(target);
    const targetShape = {
        uuid:         target.uuid,
        hp:           { value: target.system.derivedStats?.hp?.value, temp: target.system.derivedStats?.hp?.temp },
        shield:       Number(target.system.derivedStats?.shield) || 0,
        armor:        buildArmorShape(target),
        naturalArmor: buildNaturalArmorShape(target),
        monsterFlags: buildMonsterFlags(target),
        activeEffects:{ activeShield: activeShield ? { hp: activeShield.hp } : null }
    };

    // Crit bonus: prefer an explicit numeric override (callers can still
    // pass it directly), else derive from severity using the right ladder.
    const critBonus = (Number.isFinite(Number(payload.critBonus)) && payload.critBonus !== undefined)
        ? Number(payload.critBonus)
        : critBonusFor(payload.critSeverity, targetShape.monsterFlags.immuneToOrganCrits);

    /* Ablating quality (RAW Core p.156): "This weapon does 1d6/2 damage to
     * the stopping power of armor if it penetrates." Roll the chip bonus
     * here on the GM side BEFORE handing the source to the deterministic
     * calculator; the rolled value (0–3) becomes part of the source so the
     * breakdown audit can show exactly what was chipped. */
    const ablatingChipBonus = qualityFlags.ablating
        ? Math.floor((1 + Math.floor(Math.random() * 6)) / 2)
        : 0;

    const damageSource = {
        kind:                  payload.kind ?? "weapon",
        weaponDamage,
        /* Silver-quality split damage (hybrid steel-with-silver-inlay weapons,
         * RAW Core p.157). Pre-rolled on the attacker side; folded by the
         * calculator only when the target is silver-resistant. Zero / unset
         * means no silver portion was rolled. */
        silverDamage:          Math.max(0, Number(payload.silverDamage) || 0),
        ablatingChipBonus,
        critBonus,
        damageTypes,
        location,
        defense:               Array.isArray(payload.defense) ? payload.defense : [],
        tangible:              payload.tangible !== false,
        isOngoingTick:         !!payload.isOngoingTick,
        bypassesWornArmor:     fullBypass || !!payload.bypassesWornArmor,
        bypassesNaturalArmor:  fullBypass || !!payload.bypassesNaturalArmor,
        bypassesShield:        fullBypass || !!payload.bypassesShield,
        ...qualityFlags
    };

    const result = resolveDamage({ damageSource, target: targetShape });

    /* Apply the patches. HP uses drainHp so the temp/value split is right. */
    const hpLoss = -result.patches.hp.delta;
    const updates = {};
    if (hpLoss > 0) {
        const { value, temp } = drainHp(target.system.derivedStats?.hp, hpLoss);
        updates["system.derivedStats.hp.value"] = value;
        updates["system.derivedStats.hp.temp"]  = temp;
    }
    if (result.patches.shield.delta) {
        const cur = Number(target.system.derivedStats?.shield) || 0;
        updates["system.derivedStats.shield"] = Math.max(0, cur + result.patches.shield.delta);
    }
    if (Object.keys(updates).length) await target.update(updates);

    /* Active Shield write-back — the calculator returns an hpDelta on the
     * AE pool; we update the flag with the new value, or delete the AE
     * entirely when the shield collapses (RAW: the spell ends and a
     * collapse rider fires, which the breakdown surfaces). */
    if (activeShield && result.patches.activeShield?.hpDelta) {
        const nextHp = Math.max(0, activeShield.hp + result.patches.activeShield.hpDelta);
        const ae = target.effects?.get?.(activeShield.effectId);
        if (ae) {
            if (nextHp <= 0) {
                try { await ae.delete(); } catch (err) { console.warn(`${SYSTEM_ID} | active shield delete failed`, err); }
            } else {
                try { await ae.setFlag(SYSTEM_ID, "activeShieldHp", nextHp); }
                catch (err) { console.warn(`${SYSTEM_ID} | active shield update failed`, err); }
            }
        }
    }

    /* SP ablation — write the new value per item. Branches on item.type:
     *   - armor  → drains the per-location {locKey}Stopping field.
     *   - shield → drains reliability.value (Combat Extended Raise Shield
     *     overlay; see buildArmorShape). A shield reaching 0 reliability
     *     IS still "raised" — the broken-state check (isBroken) handles
     *     that elsewhere, and the next attack's buildArmorShape will see
     *     reliability = 0 and skip the overlay automatically. */
    for (const { itemId, spDelta } of result.patches.armorAblation ?? []) {
        const item = target.items?.get?.(itemId);
        if (!item) continue;
        if (item.type === "shield") {
            const cur  = Number(item.system?.reliability?.value) || 0;
            const next = Math.max(0, cur + spDelta);
            if (next !== cur) await item.update({ "system.reliability.value": next });
            continue;
        }
        const locKey = damageSource.location.key;
        const field  = `${locKey}Stopping`;
        const cur    = Number(item.system?.[field]) || 0;
        const next   = Math.max(0, cur + spDelta);
        if (next !== cur) await item.update({ [`system.${field}`]: next });
    }

    /* Audit card — collapsed by default; lets the GM see exactly which
     * pipeline stages fired and the running totals. If the caller passed
     * `attackMessageUuid`, APPEND the breakdown to that message so the
     * whole attack lives in a single chat card; otherwise post standalone
     * (the fallback for non-attack damage sources, e.g. spell ticks). */
    try {
        /* Prepend a synthetic "oilBonus" stage so the breakdown ledger
         * accounts for the fold the damage-source apply did up top — the
         * calculator only sees the combined weaponDamage and otherwise
         * the player would see an unexplained jump in the base number. */
        if (oilBonusApplied && Array.isArray(result?.stages)) {
            result.stages.unshift({
                stage:       "oilBonus",
                oilName:     oilBonusApplied.oilName,
                added:       oilBonusApplied.bonus,
                baseWeapon:  oilBonusApplied.baseWeapon,
                combined:    oilBonusApplied.combined,
                targetLabel: oilBonusApplied.targetLabel
            });
        }
        const breakdownHtml = renderDamageBreakdown({
            targetName: target.name,
            result
        });
        const attackMsg = payload.attackMessageUuid ? await fromUuid(payload.attackMessageUuid) : null;

        /* Alchemy Reborn: oil charge deduction on a successful damaging
         * hit. Resolves the weapon via payload.weaponUuid (stamped by the
         * damage-button click handler) first, with the attack message's
         * system.weaponUuid as a fallback. Skipped when the toggle is off,
         * when the hit dealt no damage, or when no weapon can be resolved
         * (ad-hoc damage with no source). */
        try {
            const isReborn = game.settings?.get?.(SYSTEM_ID, "homebrew.alchemyPotency");
            if (isReborn && hpLoss > 0) {
                let weaponUuid = payload.weaponUuid || "";
                if (!weaponUuid && attackMsg) weaponUuid = attackMsg?.system?.weaponUuid || "";
                const weapon = weaponUuid ? await fromUuid(weaponUuid) : null;
                /* Single oil coating per weapon, stored on
                 * weapon.system.appliedOil. Decrement charges by 1; clear
                 * the slot at 0. RAW mode (charges:0) skips this — its
                 * expiry runs off `expireAt` via the worldTime sweep. */
                const ao = weapon?.system?.appliedOil;
                if (ao?.name && Number(ao.charges) > 0) {
                    const charges = Number(ao.charges);
                    const next = charges - 1;
                    try {
                        if (next <= 0) {
                            await weapon.update({
                                "system.appliedOil": { id: "", name: "", img: "", oilTarget: "", oilBonusDamage: 0, appliedAt: 0, expireAt: 0, charges: 0, maxCharges: 0 }
                            });
                            const msg = game.i18n.format("WITCHER.AlchemyReborn.Oil.Depleted", {
                                weapon: weapon.name,
                                oil:    ao.name || "oil coating"
                            });
                            await ChatMessage.create({
                                speaker: ChatMessage.getSpeaker({ actor: weapon.actor ?? null }),
                                content: `<em>${msg}</em>`
                            });
                        } else {
                            await weapon.update({ "system.appliedOil.charges": next });
                        }
                    } catch (err) {
                        console.warn(`${SYSTEM_ID} | oil charge deduct failed`, err);
                    }
                }
            }
        } catch (err) { console.warn(`${SYSTEM_ID} | oil charge handler error`, err); }

        if (attackMsg) {
            const fragment =
                `<div class="wdm-attack-applied">` +
                    `<div class="wdm-attack-applied-head">Applied to <strong>${escAttr(target.name)}</strong>: <span class="wdm-attack-applied-hp">${result.finalDamage > 0 ? `−${result.finalDamage} HP` : "no damage"}</span></div>` +
                    breakdownHtml +
                `</div>`;
            /* Typed summary chip — sits in the master one-liner with
             * a damage-red palette so the eye lands on it. Location
             * goes before damage so the chip reads "torso · 6 dmg". */
            const locLabel = location.label || location.key || "";
            const damageLabel = result.finalDamage > 0
                ? `${locLabel ? `${locLabel} · ` : ""}${result.finalDamage} dmg`
                : `${locLabel ? `${locLabel} · ` : ""}no damage`;
            await appendAttackResult(attackMsg, {
                fragment,
                summaryAdd: { label: damageLabel, kind: "damage", icon: "fa-burst" }
            });
            /* Ablation summary chip — surfaces the SP chip in the collapsed
             * one-liner so a GM scanning the chat can see "−2 SP" without
             * expanding the breakdown. Reads patches.armorAblation (one
             * entry per contributing armor item at the hit location); all
             * entries share the same spDelta since the calculator computes
             * a single per-hit chip. Skipped when no armor was chipped
             * (plain fully-soaked hit, no armor at the location, etc.). */
            const ablation = result.patches?.armorAblation ?? [];
            if (ablation.length) {
                const spLoss = Math.abs(Number(ablation[0]?.spDelta) || 0);
                if (spLoss > 0) {
                    await appendAttackResult(attackMsg, {
                        summaryAdd: {
                            label: `−${spLoss} SP${locLabel ? ` (${locLabel})` : ""}`,
                            kind:  "info",
                            icon:  "fa-shield-halved"
                        }
                    });
                }
            }
        } else {
            await ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor: target }),
                content: breakdownHtml,
                flags: { [SYSTEM_ID]: { category: "combat" } }
            });
        }
    } catch (err) {
        console.warn(`${SYSTEM_ID} | breakdown card render failed`, err);
    }

    /* Quality riders (bleeding, knockdown, fire, freeze, poison, stagger,
     * disease, entangling, stun). RAW: riders fire "on a damaging hit",
     * so gate on penetrated damage > 0 — armor that fully soaks the hit
     * means no rider. Single source of truth across all damage entry
     * points (button click, GM dock auto, scripted damage). */
    if (result.finalDamage > 0 && Array.isArray(payload.qualities) && payload.qualities.length) {
        try {
            await applyQualityRiders(
                target,
                payload.qualities,
                payload.qualityValues ?? {},
                location.key,
                ChatMessage.getSpeaker({ actor: target }),
                /* Pass the attack message uuid so the riders fold into
                 * the result block instead of posting standalone chat. */
                { attackMessageUuid: payload.attackMessageUuid ?? null }
            );
        } catch (err) {
            console.warn(`${SYSTEM_ID} | quality riders apply failed`, err);
        }
    }

    /* Critical wound auto-apply (Core p.158). The crit BONUS damage already
     * landed via the calculator's stage 7; here we also stamp the wound
     * itself onto the target (embedded item) and trigger its Stun save.
     * Only fires if a severity was determined upstream (delta ≥ 7). */
    if (payload.critSeverity) {
        try {
            await autoApplyCriticalWound({
                actor: target,
                severity: payload.critSeverity,
                locationKey: location.key,
                attackMessageUuid: payload.attackMessageUuid ?? null
            });
        } catch (err) {
            console.warn(`${SYSTEM_ID} | crit wound auto-apply failed`, err);
        }
    }

    return result;
}

/** Tiny attr-safe escape — protects against quotes/<> in actor names when
 *  we splice them into HTML being appended to the attack card. */
function escAttr(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function handleApplyStatus(payload) {
    const { targetUuid, statusId, action } = payload;
    const target = await fromUuid(targetUuid);
    if (!target || !statusId) return;
    /* Permission gate (multi-player audit S5): a player can only apply
     * a status to a target they can OBSERVE. Without this, a malicious
     * player could socket-call to apply Stunned / Prone / etc. to any
     * actor including GM-only NPCs. */
    if (!authorizeSocket(payload, target)) {
        console.warn(`${SYSTEM_ID} | applyStatus refused — sender ${payload?.senderUserId} lacks permission on ${target.name}`);
        return;
    }
    /* Validate the status ID up-front so a bad caller (typo in a quality
     * rider, malformed socket payload, scripted macro with an old id) just
     * logs and returns instead of crashing the damage application chain.
     * Foundry's toggleStatusEffect throws hard on unknown ids and that
     * propagated out of every `await emitApplyStatus` call site. */
    const known = (CONFIG.statusEffects ?? []).some(s => s.id === statusId);
    if (!known) {
        console.warn(`${SYSTEM_ID} | handleApplyStatus: unknown status id "${statusId}" — ignoring`);
        return;
    }
    const active = action !== "remove";
    /* Cast-shield gate — an active shield (Quen, Active Shield) absorbs
     * this status when its SOURCE is tangible. Resolution order:
     *   1. `payload.sourceTangible === false` → intangible source (a
     *      suffocation spell, mental effect, noxious hex). Bypasses the
     *      shield entirely; status always lands.
     *   2. `payload.sourceTangible === true` → tangible source (fire
     *      spell, rock spell, lightning). Shield absorbs the status; it
     *      doesn't land on the target.
     *   3. `payload.sourceTangible` unset → fall back to the STATUS
     *      catalog's own `tangible` flag (weapon strikes, macros, and
     *      any caller that didn't specify a source tangibility).
     * Only the APPLY direction is gated — removal always proceeds. */
    if (active) {
        try {
            const explicit = payload?.sourceTangible;
            let blockedByShield = false;
            if (explicit === false) {
                blockedByShield = false;      // intangible source — always passes
            } else if (explicit === true) {
                blockedByShield = !!buildActiveShield(target);  // tangible source — shield absorbs
            } else {
                const { STATUS_CLAUSES } = await import("./statusClauses.mjs");
                const clause = STATUS_CLAUSES?.[statusId];
                blockedByShield = clause?.tangible === true && !!buildActiveShield(target);
            }
            if (blockedByShield) {
                await ChatMessage.create({
                    speaker: ChatMessage.getSpeaker({ actor: target }),
                    content: `<div class="wdm-attack-rider"><i class="fa-solid fa-shield-halved"></i> ` +
                        `<strong>Cast shield</strong> — ${Handlebars.escapeExpression(target.name)}'s active shield ` +
                        `absorbs the ${Handlebars.escapeExpression(statusId)} effect.</div>`,
                    flags: { [SYSTEM_ID]: { category: "combat" } }
                });
                return;
            }
        } catch (err) {
            console.warn(`${SYSTEM_ID} | cast-shield status gate check failed`, err);
        }
    }
    /* Prefer the actor-level toggle — it works whether or not a token is
     * placed on the active scene. Falls back to the token API for legacy
     * callers that pass a token UUID. */
    try {
        if (typeof target.toggleStatusEffect === "function") {
            await target.toggleStatusEffect(statusId, { active });
            return;
        }
        const token = target.getActiveTokens?.()?.[0];
        const def   = CONFIG.statusEffects.find(s => s.id === statusId);
        if (token && def) await token.toggleEffect(def, { active });
    } catch (err) {
        console.warn(`${SYSTEM_ID} | handleApplyStatus failed for ${statusId}:`, err);
    }
}

/** GM-side: apply a knockback push to a placed token. Resolves the
 *  target Token by UUID, then defers to the pure pushToken() primitive.
 *  Fires on the GM's client so the token-document update succeeds even
 *  when a player triggered it against a GM-owned NPC. */
async function handlePushToken(payload) {
    const { tokenUuid, sourcePoint, distanceMeters } = payload;
    let tokenDoc = null;
    try { tokenDoc = await fromUuid(tokenUuid); }
    catch (err) {
        console.warn(`${SYSTEM_ID} | handlePushToken: uuid resolve failed`, err);
        return;
    }
    if (!tokenDoc) {
        console.warn(`${SYSTEM_ID} | handlePushToken: token not found for uuid`, tokenUuid);
        return;
    }
    /* `fromUuid` returns the TokenDocument; the pure function operates on
     * the PlaceableObject for canvas centre + width. Fall back to the
     * document itself (it exposes x/y/width/height) if the placed object
     * isn't reachable (e.g. scene not currently viewed). */
    const placed = tokenDoc.object ?? tokenDoc;
    const { pushToken } = await import("../mechanics/pushToken.mjs");
    return pushToken({ token: placed, sourcePoint, distanceMeters });
}

/** GM-side: reduce a weapon/shield's Reliability by 1. Floored at 0.
 *  When it hits 0 the item is marked broken AND its `equipped` flag is
 *  flipped to false so it stops being a valid defense/attack pick on
 *  the dock / sheet / defense prompt. A chat notice goes out under the
 *  item owner's name so the table sees the breakage. */
async function handleReduceReliability(payload) {
    const { itemUuid, attackMessageUuid = null } = payload;
    const item = await fromUuid(itemUuid);
    if (!item) {
        console.warn(`${SYSTEM_ID} | handleReduceReliability: item not found for uuid`, itemUuid);
        return;
    }
    /* Permission gate: only callers with OBSERVER+ on the item's
     * parent actor can drain its reliability. */
    if (!authorizeSocket(payload, item.parent ?? item)) {
        console.warn(`${SYSTEM_ID} | reduceReliability refused — sender ${payload?.senderUserId}`);
        return;
    }
    const cur = Number(item.system?.reliability?.value) || 0;
    if (cur <= 0) return;       // already broken
    const next = Math.max(0, cur - 1);
    const broke = next === 0;
    const update = { "system.reliability.value": next };
    try {
        await item.update(update);
    } catch (err) {
        console.warn(`${SYSTEM_ID} | handleReduceReliability update failed:`, err);
        return;
    }
    const noticeHtml = `<div class="wdm-attack-rider"><i class="fa-solid fa-shield-halved"></i> <strong>${item.name}</strong> absorbs a block — SP <b>${cur}</b> → <b>${next}</b>${broke ? ` <strong style="color:#ff7a6b">(breaks!)</strong>` : ""}.</div>`;
    const attackMsg = attackMessageUuid ? await fromUuid(attackMessageUuid) : null;
    try {
        if (attackMsg) {
            /* Prefix with the defender's actor name so the summary
             * chip reads "Vlad's Steel Sword: broke" instead of
             * looking like the attacker's weapon. */
            const ownerName = item.actor?.name ? `${item.actor.name}'s ` : "";
            await appendAttackResult(attackMsg, {
                fragment: noticeHtml,
                summaryAdd: {
                    label: broke ? `${ownerName}${item.name} broke` : `${ownerName}${item.name} −1 SP`,
                    kind:  broke ? "fumble" : "status",
                    icon:  "fa-shield-halved"
                }
            });
        } else {
            await ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor: item.actor }),
                content: noticeHtml,
                flags: { [SYSTEM_ID]: { category: "combat" } }
            });
        }
    } catch (err) {
        console.warn(`${SYSTEM_ID} | handleReduceReliability chat post failed:`, err);
    }
}

async function handleGrantIP({ actorUuid, label, value }) {
    const actor = await fromUuid(actorUuid);
    if (!actor) return;
    const log = [...(actor.system.logs?.ipLog ?? []), { label, value }];
    await actor.update({
        "system.improvementPoints": (actor.system.improvementPoints ?? 0) + value,
        "system.logs.ipLog": log
    });
}

async function handleGrantReputation({ actorUuid, delta }) {
    const actor = await fromUuid(actorUuid);
    if (!actor) return;
    const cur = actor.system.general?.reputation?.value ?? 0;
    await actor.update({ "system.general.reputation.value": cur + delta });
}

async function handleAddSceneParchment({ sceneId, entry }) {
    const scene = game.scenes.get(sceneId);
    if (!scene || !entry) return;
    const list = foundry.utils.duplicate(scene.getFlag(SYSTEM_ID, PARCHMENT_FLAG) || []);
    list.push(entry);
    await scene.setFlag(SYSTEM_ID, PARCHMENT_FLAG, list);
}

async function handleRemoveSceneParchment({ sceneId, entryId }) {
    const scene = game.scenes.get(sceneId);
    if (!scene) return;
    const list = foundry.utils.duplicate(scene.getFlag(SYSTEM_ID, PARCHMENT_FLAG) || []);
    await scene.setFlag(SYSTEM_ID, PARCHMENT_FLAG, list.filter(n => n.id !== entryId));
}

/* Gift item handler — GM-side proxy for cross-actor item transfers.
 * Decrements (or deletes) the source item, adds the gifted quantity to
 * the recipient via actor.addItem() (which stack-merges into a matching
 * pile when one exists). Posts a chat message announcing the gift so
 * the table can see what happened. */
async function handleGiftItem({ sourceActorUuid, targetActorUuid, itemId, quantity, fromUserId }) {
    const source = await fromUuid(sourceActorUuid);
    const target = await fromUuid(targetActorUuid);
    if (!source || !target) {
        console.warn(`${SYSTEM_ID} | handleGiftItem: missing source or target actor`);
        return;
    }
    const item = source.items?.get?.(itemId);
    if (!item) {
        console.warn(`${SYSTEM_ID} | handleGiftItem: item ${itemId} not on source ${source.name}`);
        return;
    }
    const stackQty = Math.max(1, Number(item.system?.quantity) || 1);
    const moveQty  = Math.max(1, Math.min(stackQty, Number(quantity) || 1));

    /* Snapshot the data we'll plant on the recipient BEFORE mutating the
     * source — once we decrement / delete, the live item object can no
     * longer be cloned reliably. */
    const proto = item.toObject();
    proto.system = { ...(proto.system ?? {}), quantity: moveQty };
    delete proto._id;

    /* Decrement the source. If the gift empties the stack, delete the
     * item outright. */
    if (moveQty >= stackQty) {
        try { await item.delete(); }
        catch (err) { console.warn(`${SYSTEM_ID} | handleGiftItem: source delete failed`, err); return; }
    } else {
        try { await item.update({ "system.quantity": stackQty - moveQty }); }
        catch (err) { console.warn(`${SYSTEM_ID} | handleGiftItem: source decrement failed`, err); return; }
    }

    /* Add to target via actor.addItem so stack-merging works. */
    try {
        if (typeof target.addItem === "function") {
            await target.addItem(proto, moveQty);
        } else {
            await target.createEmbeddedDocuments("Item", [proto]);
        }
    } catch (err) {
        console.warn(`${SYSTEM_ID} | handleGiftItem: target add failed`, err);
        return;
    }

    /* Announce in chat — keeps the gift visible to the table. */
    try {
        const fromUser = fromUserId ? game.users?.get?.(fromUserId) : null;
        const sender   = fromUser?.name ? `${fromUser.name}` : source.name;
        const qtyText  = moveQty > 1 ? ` ×${moveQty}` : "";
        await ChatMessage.create({
            speaker: ChatMessage.implementation.getSpeaker({ actor: source }),
            content: `<div class="wdm-gift-card">
                <i class="fa-solid fa-gift"></i>
                <strong>${escAttr(sender)}</strong> gave
                <strong>${escAttr(item.name)}${escAttr(qtyText)}</strong>
                to <strong>${escAttr(target.name)}</strong>.
            </div>`
        });
    } catch (err) { console.warn(`${SYSTEM_ID} | handleGiftItem: chat post failed`, err); }
}

/* -------------------------------------------------------------------------- */
/* Defense pre-roll prompt — cross-client request/response                    */
/* -------------------------------------------------------------------------- */

/* Pending requests on the ATTACKER's client, keyed by requestId. Resolved
 * when the matching defenseResponse comes back, or by timeout. */
const _pendingDefenseRequests = new Map();

/* Pick which user should be prompted for a given defender actor. Active
 * player owner first (the actor's actual player). Falls back to the active
 * GM when no player owner is online. Returns null if no one's connected. */
function pickDefenderOwner(actor) {
    if (!actor) return null;
    const players = (game.users?.players ?? [])
        .filter(u => u.active && actor.testUserPermission?.(u, "OWNER"));
    if (players.length) return players[0];
    return game.users?.activeGM ?? null;
}

/* Attacker-side entry point: ask the defender's owner what defense to use.
 * Resolves to { action, itemId?, timedOut? } once they answer or the
 * timeout fires. If the defender has no online owner OR the attacker IS
 * the defender's owner, the prompt opens locally instead. */
export async function requestDefenseFromOwner({
    defenderActor, attackerName, weaponName, weaponImg, engagementId = "", timeoutMs = 30000,
    attackKind = "normal", shotIndex = 1, totalShots = 1, disallowedItemIds = [],
    attackerDamageFlags = null, attackHitLocation = null, allowedDefenses = null,
    requiresShieldCover = false
}) {
    if (!defenderActor) return { action: "none" };

    const owner = pickDefenderOwner(defenderActor);
    /* No active recipient OR we ARE the defender's owner → open the prompt
     * locally, run the defender's actions inline, and resolve directly.
     * The defender's defendWith / defendBySkill calls carry `engagementId`
     * so the resulting defense chat card stamps the linkage flag (used by
     * the attacker's damage button for crit detection). */
    if (!owner || owner.id === game.user?.id) {
        const { openDefensePrompt } = await import("../applications/defensePromptDialog.mjs");
        const choice = await openDefensePrompt({
            attackerName, weaponName, weaponImg, defenderActor, timeoutMs,
            attackKind, shotIndex, totalShots, disallowedItemIds, attackerDamageFlags,
            allowedDefenses, requiresShieldCover
        });
        /* Stamp attackKind onto the choice so runDefenseChoice can gate on
         * disarm/trip for Knightly Stance without another parameter. */
        choice.attackKind = attackKind;
        const packet = await runDefenseChoice(defenderActor, choice, engagementId, attackerDamageFlags, attackHitLocation);
        return { ...choice, ...packet };
    }

    const requestId = `def-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            _pendingDefenseRequests.delete(requestId);
            resolve({ action: "none", timedOut: true });
        }, timeoutMs + 2000);          // a touch longer than the dialog's own timeout
        _pendingDefenseRequests.set(requestId, { resolve, timer });
        game.socket.emit(CHANNEL, {
            type: "defenseRequest",
            recipientUserId: owner.id,
            senderUserId: game.user?.id,
            requestId,
            engagementId,
            attackerName, weaponName, weaponImg,
            attackKind, shotIndex, totalShots, disallowedItemIds, attackerDamageFlags,
            attackHitLocation,
            allowedDefenses,
            requiresShieldCover,
            defenderUuid: defenderActor.uuid,
            timeoutMs
        });
    });
}

/* Run a defender's chosen reaction (defendWith / defendBySkill).  When
 * engagement-linked the underlying roll SUPPRESSES its own chat card —
 * we bubble back the roll total + rendered HTML so the attacker's flow
 * can fold the defense into the unified attack chat card.
 *
 * Returns { defenseTotal, defenseFlavor, defenseBody } or nulls when
 * no roll happened (action "none" / no eligible item / unknown action). */
async function runDefenseChoice(defenderActor, choice, engagementId, attackerDamageFlags = null, attackHitLocation = null) {
    const empty = { defenseTotal: null, defenseFlavor: "", defenseBody: "", defenseChips: [] };
    const pick = (r) => Number.isFinite(r?.defenseTotal)
        ? {
            defenseTotal: r.defenseTotal,
            defenseFlavor: r.defenseFlavor ?? "",
            defenseBody:   r.defenseBody   ?? "",
            /* Structured chip data (guard, status, weapon-quality mods)
             * so the attacker's card can render the defender's modifier
             * breakdown even when the defender's own card is suppressed. */
            defenseChips:  Array.isArray(r.defenseChips) ? r.defenseChips : []
        }
        : empty;
    // Ad-hoc modifier from the defense prompt (numeric input above the
     // buttons). Threaded into every reaction; defendWith/defendBySkill
     // fold it into the total and surface a "Mod" chip when nonzero.
    const extraMod = Math.round(Number(choice?.extraMod) || 0);
    try {
        if (choice.action === "parry" || choice.action === "block") {
            const item = defenderActor.items?.get?.(choice.itemId);
            if (item && typeof defenderActor.defendWith === "function") {
                return pick(await defenderActor.defendWith(item, choice.action, { engagementId, extraMod, attackerDamageFlags, attackHitLocation }));
            }
            console.warn(`${SYSTEM_ID} | defense prompt: ${choice.action} chosen but no eligible item`);
        } else if (choice.action === "dodge") {
            if (typeof defenderActor.defendBySkill === "function") {
                return pick(await defenderActor.defendBySkill("dodge", { label: "Dodge", engagementId, extraMod, attackerDamageFlags }));
            }
        } else if (choice.action === "reposition") {
            if (typeof defenderActor.defendBySkill === "function") {
                return pick(await defenderActor.defendBySkill("athletics", { label: "Reposition", engagementId, reposition: true, extraMod, attackerDamageFlags }));
            }
        } else if (choice.action === "brawlBlock") {
            /* Body Block (Brawling) — bare-hands intercept per user spec:
             * roll REF + Brawling as the defensive total. When the
             * defender's total beats the attacker's, weaponAttackMixin
             * redirects the hit location to a random arm (left / right)
             * so the incoming damage goes through arm SP instead of the
             * originally rolled location. When the defender LOSES, the
             * attack lands at its originally rolled location and the
             * defender takes it — same as any other failed defense. */
            if (typeof defenderActor.defendBySkill === "function") {
                return pick(await defenderActor.defendBySkill("brawling", { label: "Body Block", engagementId, brawlBlock: true, extraMod, attackerDamageFlags }));
            }
        }
    } catch (err) {
        console.warn(`${SYSTEM_ID} | runDefenseChoice failed`, err);
    }
    return empty;
}

/* Defender-side handler: open the prompt and ship the answer back. */
async function handleDefenseRequest(data) {
    try {
        const { openDefensePrompt } = await import("../applications/defensePromptDialog.mjs");
        const defenderActor = await fromUuid(data.defenderUuid);
        if (!defenderActor) {
            game.socket.emit(CHANNEL, {
                type: "defenseResponse",
                recipientUserId: data.senderUserId,
                requestId: data.requestId,
                action: "none",
                error: "defender not found"
            });
            return;
        }
        const choice = await openDefensePrompt({
            attackerName: data.attackerName,
            weaponName:   data.weaponName,
            weaponImg:    data.weaponImg,
            defenderActor,
            timeoutMs:    data.timeoutMs ?? 30000,
            attackKind:        data.attackKind        ?? "normal",
            shotIndex:         data.shotIndex         ?? 1,
            totalShots:        data.totalShots        ?? 1,
            disallowedItemIds: Array.isArray(data.disallowedItemIds) ? data.disallowedItemIds : [],
            attackerDamageFlags:  data.attackerDamageFlags ?? null,
            allowedDefenses:      data.allowedDefenses  ?? null,
            requiresShieldCover:  !!data.requiresShieldCover
        });
        /* Same attackKind-stamping pattern as the local branch so Knightly
         * Stance also lands when the defender is on a remote client. */
        choice.attackKind = data.attackKind ?? "normal";
        /* Fire the defender's actual defense roll on this client (the
         * defender's owner) so the result posts to chat as their own card,
         * stamped with the engagement flag for crit detection.
         *   parry / block → defendWith(item, mode) on a weapon/shield
         *   dodge         → defendBySkill("dodge")          (same as the dock's Dodge button)
         *   reposition      → defendBySkill("athletics", …)   (same as the dock's Reposition button)
         *
         * Roll FIRST then send the response so the attacker's verdict can
         * use the live defenseTotal in the unified chat card. */
        const packet = await runDefenseChoice(defenderActor, choice, data.engagementId ?? "", data.attackerDamageFlags ?? null, data.attackHitLocation ?? null);
        game.socket.emit(CHANNEL, {
            type: "defenseResponse",
            recipientUserId: data.senderUserId,
            requestId: data.requestId,
            action:    choice.action ?? "none",
            itemId:    choice.itemId ?? null,
            timedOut:  !!choice.timedOut,
            defenseTotal:  packet.defenseTotal,
            defenseFlavor: packet.defenseFlavor,
            defenseBody:   packet.defenseBody,
            defenseChips:  packet.defenseChips ?? []
        });
    } catch (err) {
        console.warn(`${SYSTEM_ID} | handleDefenseRequest failed`, err);
    }
}

/* Attacker-side: receive the defender's reply, resolve the pending Promise. */
function handleDefenseResponse(data) {
    const pending = _pendingDefenseRequests.get(data.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    _pendingDefenseRequests.delete(data.requestId);
    pending.resolve({
        action:        data.action ?? "none",
        itemId:        data.itemId ?? null,
        timedOut:      !!data.timedOut,
        defenseTotal:  Number.isFinite(Number(data.defenseTotal)) ? Number(data.defenseTotal) : null,
        defenseFlavor: data.defenseFlavor ?? "",
        defenseBody:   data.defenseBody   ?? "",
        defenseChips:  Array.isArray(data.defenseChips) ? data.defenseChips : []
    });
}
