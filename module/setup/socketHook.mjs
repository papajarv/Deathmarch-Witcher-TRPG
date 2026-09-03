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

import { drainHp, ATTACK_LOCATIONS, getActiveWeaponQualities, WEAPON_QUALITIES, getActiveArmorQualities, ARMOR_QUALITIES, equippedArmorHasQualityLabeled } from "./config.mjs";
import { durableAblationNegated } from "../mechanics/durable.mjs";
import { resolveDamage } from "../combat/damageCalculator.mjs";
import { renderDamageBreakdown } from "../combat/damageBreakdown.mjs";
import { critBonusFor } from "../combat/critBonus.mjs";
import { hrCritBonusLadders, hrNewSilverRules } from "../mechanics/house-rules-config.mjs";
import { combineLayeredSPFor } from "../mechanics/armorLayering.mjs";
import { isCESubsystemEnabled } from "../api/homebrew.mjs";
import { autoApplyCriticalWound } from "../chrome/chrome/critical-roll.js";
import { applyQualityRiders, appendAttackResult } from "../documents/mixins/weaponAttackMixin.mjs";
import { grappleWeaponSkill, GRAPPLE_DEFENSE_KINDS } from "../mechanics/grappleWeapon.mjs";

import { t, tFormat } from "../chrome/lib/i18n.js";
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

/* Fallback authorization for damage/status writes that ride on a resolved
 * attack. Lets a player push damage / attack-tied riders through the GM
 * relay against an NPC they don't have OBSERVER on — the common "GM
 * hides NPC sheets from players" setup. Two acceptable proofs:
 *
 *   STRICT — Payload references an attackMessageUuid whose stamped
 *   defenderUuid matches payload.targetUuid AND the sender owns the
 *   attack's speaker (attacker). Both bindings must hold, so a player
 *   can't reuse an attack card to spoof damage onto a different actor
 *   than the one the pipeline resolved.
 *
 *   RELAXED — Payload references an attackMessageUuid AND the sender
 *   owns the attack's speaker (attacker). Skips the defender-uuid
 *   match: covers the "no target token when the attack rolled" flow
 *   where weaponAttackMixin never stamped defenderUuid. The player
 *   still can only apply damage on attacks THEY authored (owner check
 *   on the speaker), so a rogue player can't apply damage on other
 *   players' cards.
 *
 * The relaxed branch is what unblocks the "player rolls attack, then
 * clicks Roll Damage on their own card" flow when the target is an
 * NPC the player has no ownership on. */
async function isLegitimateAttackDamage(payload) {
    const attackUuid = payload?.attackMessageUuid;
    const senderId   = payload?.senderUserId;
    if (!attackUuid || !senderId) return false;
    const msg = await fromUuid(attackUuid);
    if (!msg) return false;
    const sender = game.users?.get(senderId);
    if (!sender) return false;
    const sp = msg.speaker ?? {};
    const attacker = sp.actor ? game.actors?.get?.(sp.actor)
                    : sp.token ? game.scenes?.get?.(sp.scene)?.tokens?.get?.(sp.token)?.actor
                    : null;
    const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
    if (!attacker?.testUserPermission?.(sender, OWNER)) return false;
    const defUuid = msg.getFlag?.(SYSTEM_ID, "defenderUuid");
    /* STRICT match preferred. */
    if (defUuid && defUuid === payload?.targetUuid) return true;
    /* RELAXED: sender owns attacker + payload rides on this attack card.
     * Sufficient because the damage-button dataset stamps attackMessageUuid,
     * so a player can only push damage from a card they themselves authored. */
    return true;
}

/* Status-specific authorization: the sender OWNS the source actor (the
 * attacker / caster) named in the payload. A combat status is applied BY a
 * source actor TO a target; if the player owns the source, the GM trusts the
 * routed apply. This is what lets a player's brawl / weapon rider / spell
 * status land on a GM-owned NPC they have no ownership of — without it, the
 * emitApplyStatus round-trip was silently refused (no attack card on these
 * paths, no OBSERVER on the NPC). Bounded to the sender's OWN actors as the
 * source, so a player can't spoof a status from an actor they don't control. */
function senderOwnsSourceActor(payload) {
    const senderId = payload?.senderUserId;
    const srcUuid  = payload?.sourceActorUuid;
    if (!senderId) return true;                       /* direct GM call */
    if (!srcUuid) return false;
    const user = game.users?.get(senderId);
    if (!user) return false;
    if (user.isGM) return true;
    let src = null;
    try { src = fromUuidSync?.(srcUuid) ?? null; } catch (_) { src = null; }
    if (src && src.documentName !== "Actor" && src.actor) src = src.actor;   /* token doc → actor */
    const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
    return !!src?.testUserPermission?.(user, OWNER);
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
    /* The engine host's answer, coming back to whoever asked. Addressed, so it
     * has to clear the GM gate below the same way a defence response does. */
    if (data?.type === "magicInterceptResponse") {
        if (data.recipientUserId !== game.user?.id) return;
        return handleInterceptionResponse(data);
    }

    if (!game.user.isActiveGM) return;
    switch (data?.type) {
        case "magicInterceptRequest": return handleInterceptionRequest(data);
        case "applyDamage":       return handleApplyDamage(data);
        case "applyStatus":       return handleApplyStatus(data);
        case "drainPool":         return handleDrainPool(data);
        case "createConjured":    return handleCreateConjured(data);
        case "removeConjured":    return handleRemoveConjured(data);
        case "appendAttackFragment": return handleAppendAttackFragment(data);
        case "pushToken":         return handlePushToken(data);
        case "moveToken":         return handleMoveToken(data);
        case "reduceReliability": return handleReduceReliability(data);
        case "grantIP":           return handleGrantIP(data);
        case "grantReputation":   return handleGrantReputation(data);
        case "addSceneParchment": return handleAddSceneParchment(data);
        case "removeSceneParchment": return handleRemoveSceneParchment(data);
        case "giftItem":          return handleGiftItem(data);
        case "dropItemToWorld":   return handleDropItemToWorld(data);
        case "dropItemToMap":     return handleDropItemToMap(data);
        case "dropItemAsTile":    return handleDropItemAsTile(data);
        case "dropWorldItemAsTile": return handleDropWorldItemAsTile(data);
        case "takeTileItem":      return handleTakeTileItem(data);
        case "deleteCorpseToken": return handleDeleteCorpseToken(data);
        case "transferLootCurrency": return handleTransferLootCurrency(data);
        case "takeAllLoot":       return handleTakeAllLoot(data);
        case "remainsMutate":     return handleRemainsMutate(data);
        case "remainsSpendCharge": return handleRemainsSpendCharge(data);
        case "holdApply":         return handleHoldApply(data);
        case "holdClear":         return handleHoldClear(data);
        case "holdReverse":       return handleHoldReverse(data);
        case "applyAuthoredEffects": return handleApplyAuthoredEffects(data);
        case "removeAuthoredEffects": return handleRemoveAuthoredEffects(data);
        case "healActor": return handleHealActor(data);
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
    /* Sender must OWN the HOLDER (their own PC / the acting side) — that alone
     * authorizes the hold, exactly like a player attacking an NPC they don't
     * own. We deliberately do NOT require OBSERVER on the target: NPCs default
     * to NONE ownership for players, so a target check refused every player
     * grapple against a GM-owned foe (and, since _doApplyHoldLink both stamps
     * the status AND runs the clinch/pin positioning, that refusal made it look
     * like "statuses can't apply and tokens can't move"). */
    const OWNER  = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
    if (!authorizeSocket(payload, holder, OWNER)) {
        console.warn(`${SYSTEM_ID} | holdApply refused — sender ${payload?.senderUserId} doesn't own holder ${holder.name}`);
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
    /* Optional kind filter — peels one layer (e.g. Escape a pin → grapple). */
    await _doClearHoldLink(actor, payload.reason ?? "manual", partner, payload.kind ?? null);
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

export function emitApplyStatus({ targetUuid, statusId, action = "toggle", sourceTangible = undefined, attackMessageUuid = null, flags = null, stripPriorSource = null, sourceActorUuid = null }) {
    if (game.user.isActiveGM) return handleApplyStatus({ targetUuid, statusId, action, sourceTangible, attackMessageUuid, flags, stripPriorSource, sourceActorUuid });
    game.socket.emit(CHANNEL, { type: "applyStatus", targetUuid, statusId, action, sourceTangible, attackMessageUuid, flags, stripPriorSource, sourceActorUuid, senderUserId: game.user?.id });
}

/* Apply a list of AuthoredEffect payloads onto a target actor. Used by
 * castSpellMixin when a spell resolves on non-caster-owned targets — a
 * direct `createEmbeddedDocuments` fails on permission there. Routes to
 * the GM if the caller isn't one; if the caller DOES own the target (own
 * PC, own summon) the local path handles it without a socket round-trip. */
export function emitApplyAuthoredEffects({ targetUuid, payloads }) {
    if (!targetUuid || !Array.isArray(payloads) || !payloads.length) return;
    if (game.user.isActiveGM) return handleApplyAuthoredEffects({ targetUuid, payloads });
    /* Local shortcut: caller owns the target — the direct create is
     * authorized. Skip the socket hop. */
    try {
        const target = fromUuidSync(targetUuid);
        if (target && target.isOwner) {
            return target.createEmbeddedDocuments("ActiveEffect", payloads)
                .catch(err => console.warn(`${SYSTEM_ID} | authored-AE local apply failed`, err));
        }
    } catch (_) { /* fromUuidSync unavailable / stale uuid — fall through to socket */ }
    game.socket.emit(CHANNEL, { type: "applyAuthoredEffects", targetUuid, payloads, senderUserId: game.user?.id });
}

/**
 * Remove authored ActiveEffects from an actor — the missing half of
 * `emitApplyAuthoredEffects`.
 *
 * Applying went through the GM; removing did not. `removeModifier` deleted the
 * effect only `if (effect?.isOwner)`, so a modifier a caster put on someone
 * else's actor applied correctly and then NEVER LIFTED — Yrden's penalty, a
 * granted pool, a registered save. Silent, and permanent.
 *
 * `match` names what to remove: `castId` (everything one cast left on them),
 * `name`, or `origin` (the item uuid). At least one is required — an empty
 * match would clear every effect on the actor.
 */
/**
 * Heal an actor, through the GM.
 *
 * `adapter.heal` used to route healing as NEGATIVE damage through
 * `emitApplyDamage`, on the reasoning that hurting and healing are the same
 * pipeline pointed opposite ways. They are not: nothing in the damage
 * calculator or this handler understands a "healing" type or a negative
 * amount, so every point of it was clamped away. `core:healHealth` — Magic
 * Healing, Blessing of Healing, every restorative invocation — had never
 * restored a single hit point.
 *
 * Clamped to `hp.max` the same way the system's own rest does.
 */
export function emitHealActor({ targetUuid, amount }) {
    if (!targetUuid || !(Number(amount) > 0)) return;
    if (game.user.isActiveGM) return handleHealActor({ targetUuid, amount });
    try {
        const target = fromUuidSync(targetUuid);
        if (target && target.isOwner) return handleHealActor({ targetUuid, amount });
    } catch (_) { /* stale uuid — fall through to the socket */ }
    game.socket.emit(CHANNEL, { type: "healActor", targetUuid, amount, senderUserId: game.user?.id });
}

/**
 * Take a flat amount off a pool — Stamina, Luck, Vigor.
 *
 * A drain is a subtraction, and the magic engine used to express it as an
 * ActiveEffect with `mode: 2, value: -n`: a live-computed penalty sitting on a
 * number the actor also spends from. Anialwch's "lowers the target's CURRENT
 * Stamina by 4d6" became a permanent −17 that followed the pool around instead
 * of a one-time loss. Damage keeps its own pipeline; this is for everything
 * that is not damage.
 */
export function emitDrainPool({ targetUuid, path, amount, sourceActorUuid = null }) {
    if (!targetUuid || !path || !(Number(amount) > 0)) return;
    const payload = { type: "drainPool", targetUuid, path, amount, sourceActorUuid,
                      senderUserId: game.user?.id };
    if (game.user.isActiveGM) return handleDrainPool(payload);
    try {
        const target = fromUuidSync(targetUuid);
        if (target && target.isOwner) return handleDrainPool(payload);
    } catch (_) { /* stale uuid — fall through to the socket */ }
    game.socket.emit(CHANNEL, payload);
}

async function handleDrainPool({ targetUuid, path, amount }) {
    try {
        const target = await fromUuid(targetUuid);
        if (!target) return;
        const cur = Number(foundry.utils.getProperty(target, path)) || 0;
        await target.update({ [path]: Math.max(0, cur - Math.max(0, Math.floor(amount))) });
    } catch (err) {
        console.warn(`${SYSTEM_ID} | drainPool failed on ${targetUuid}`, err);
    }
}

/**
 * Put a conjured thing on the map: a wall of rock, a stalagmite, an illusory
 * copy, a tree golem.
 *
 * The magic engine used to "create" these by posting a chat card that told the
 * GM to place something themselves, and returning `placed: false`. Every spell
 * that conjures anything therefore printed a destructible HP total for an
 * object nobody could attack — "it can be destroyed by doing 20 points of
 * damage to it" with nothing on the canvas to aim at.
 *
 * Made as a `monster`-type actor because that is what the damage pipeline
 * knows how to hurt: it has hit points, it has armour, and a sword swing
 * resolves against it exactly as it would against anything else.
 */
export function emitCreateConjured(spec) {
    const payload = { type: "createConjured", ...spec, senderUserId: game.user?.id };
    if (game.user.isActiveGM) return handleCreateConjured(payload);
    game.socket.emit(CHANNEL, payload);
    /* A player's cast cannot wait for the GM's answer over a socket, so the
     * caller gets null and treats the thing as placed-elsewhere. */
    return null;
}

async function handleCreateConjured({ name, img, hp, sp, sceneId, x, y, disposition = 0,
                                      blocksMovement = false, size = 1, castId = null,
                                      sourceActorUuid = null }) {
    const scene = game.scenes?.get?.(sceneId) ?? canvas?.scene ?? null;
    if (!scene) return null;
    const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
    /* `null` means the book gave it no pool: it gets a nominal one so the
     * token exists, and its armour is the real defence. A wall of rock is
     * 30 SP and not a bag of hit points. */
    const hitPoints = hp == null ? 1 : Math.max(1, Math.floor(Number(hp) || 1));
    const stopping  = Math.max(0, Math.floor(Number(sp) || 0));
    let actor = null;
    try {
        actor = await Actor.implementation.create({
            name: name || "Conjured",
            type: "monster",
            img: img || "icons/svg/statue.svg",
            ownership: { default: OWNER },
            system: {
                derivedStats: { hp: { value: hitPoints, max: hitPoints } },
                /* A monster's armour is one flat number, which is exactly what
                 * the book gives these: "30 SP", no hit points. */
                combat: { armor: stopping }
            },
            prototypeToken: {
                name: name || "Conjured", actorLink: true, disposition,
                width: Math.max(1, Math.floor(Number(size) || 1)),
                height: Math.max(1, Math.floor(Number(size) || 1)),
                texture: { src: img || "icons/svg/statue.svg" }
            },
            flags: { [SYSTEM_ID]: { conjured: { castId, sourceActorUuid, blocksMovement } } }
        });
    } catch (err) { console.warn(`${SYSTEM_ID} | conjured actor create failed`, err); return null; }
    if (!actor) return null;

    try {
        const gs = Number(scene.grid?.size) || 100;
        const tokenDoc = await actor.getTokenDocument({
            x: Math.round((Number(x) || 0) - gs / 2),
            y: Math.round((Number(y) || 0) - gs / 2)
        });
        const [placed] = await scene.createEmbeddedDocuments("Token", [tokenDoc.toObject()]);
        return { actorUuid: actor.uuid, tokenUuid: placed?.uuid ?? null };
    } catch (err) {
        console.warn(`${SYSTEM_ID} | conjured token place failed`, err);
        try { await actor.delete(); } catch (_) {}
        return null;
    }
}

/** Take a conjured thing off the map again, actor and all. */
export function emitRemoveConjured({ actorUuid }) {
    const payload = { type: "removeConjured", actorUuid, senderUserId: game.user?.id };
    if (game.user.isActiveGM) return handleRemoveConjured(payload);
    game.socket.emit(CHANNEL, payload);
}

async function handleRemoveConjured({ actorUuid }) {
    try {
        const actor = await fromUuid(actorUuid);
        if (!actor) return;
        for (const t of actor.getActiveTokens?.() ?? []) { try { await t.document.delete(); } catch (_) {} }
        await actor.delete();
    } catch (err) { console.warn(`${SYSTEM_ID} | conjured removal failed`, err); }
}

export function emitRemoveAuthoredEffects({ targetUuid, match }) {
    if (!targetUuid || !match || !(match.castId || match.name || match.origin)) return;
    if (game.user.isActiveGM) return handleRemoveAuthoredEffects({ targetUuid, match });
    try {
        const target = fromUuidSync(targetUuid);
        if (target && target.isOwner) return handleRemoveAuthoredEffects({ targetUuid, match });
    } catch (_) { /* stale uuid — fall through to the socket */ }
    game.socket.emit(CHANNEL, { type: "removeAuthoredEffects", targetUuid, match, senderUserId: game.user?.id });
}

/* Append an HTML fragment (typically a rolled-damage block) to an attack
 * ChatMessage on the GM's behalf. Used when the button-clicker owns the
 * attacker but isn't the message author (e.g. the GM rolled the attack
 * from the combat dock), so their own `msg.update` would be rejected by
 * Foundry's ChatMessage permissions (default `update: "OWNER"`, author-
 * only). Without this route the rolled damage block never appears on
 * the card and the player sees "nothing" happen. */
export function emitAppendAttackFragment({ attackMessageUuid, fragment = "", summaryAction = null, summaryAdd = null, wrapperSelector = null }) {
    const payload = { type: "appendAttackFragment", attackMessageUuid, fragment, summaryAction, summaryAdd, wrapperSelector };
    if (game.user.isActiveGM) return handleAppendAttackFragment(payload);
    game.socket.emit(CHANNEL, { ...payload, senderUserId: game.user?.id });
}

/* Knockback push. Moves a token AWAY from a scene point by `distanceMeters`
 * (metres), cut short at the first wall collision. Routed through the GM
 * so a player pushing a GM-owned NPC (Push Kick vs bandit) still lands
 * the move even though the caller lacks token-owner permission. Payload
 * carries a token UUID rather than an actor UUID so we operate on the
 * exact placed token being pushed — the same actor could have multiple
 * tokens on the scene. */
export function emitPushToken({ tokenUuid, sourcePoint, distanceMeters, preserveHolds = false }) {
    if (game.user.isActiveGM) return handlePushToken({ tokenUuid, sourcePoint, distanceMeters, preserveHolds });
    game.socket.emit(CHANNEL, { type: "pushToken", tokenUuid, sourcePoint, distanceMeters, preserveHolds, senderUserId: game.user?.id });
}

/* Move a token to absolute top-left coords (CE Drag), GM-routed so a player
 * can move a GM-owned NPC they're dragging. `preserveHolds` passes wdmClinchMove
 * so the drag doesn't snap the hold stack. */
export function emitMoveToken({ tokenUuid, x, y, rotation = null, preserveHolds = false }) {
    if (game.user.isActiveGM) return handleMoveToken({ tokenUuid, x, y, rotation, preserveHolds });
    game.socket.emit(CHANNEL, { type: "moveToken", tokenUuid, x, y, rotation, preserveHolds, senderUserId: game.user?.id });
}
async function handleMoveToken(payload) {
    const { tokenUuid, x, y, rotation = null, preserveHolds = false } = payload;
    let tokenDoc = null;
    try { tokenDoc = await fromUuid(tokenUuid); } catch (_) { return; }
    if (!tokenDoc?.update) return;
    try {
        const upd = { x: Math.round(x), y: Math.round(y) };
        if (Number.isFinite(rotation)) upd.rotation = ((Math.round(rotation) % 360) + 360) % 360;
        /* wdmFreeFacing: the drag's re-facing is free (doesn't cost rotation
         * stamina / trigger the facing-cost policy). wdmClinchMove keeps the
         * hold from snapping on the move. */
        await tokenDoc.update(upd,
            preserveHolds
                ? { wdmForcedMove: true, wdmClinchMove: true, wdmFreeFacing: true, animate: true }
                : { wdmForcedMove: true, wdmFreeFacing: true, animate: true });
    } catch (err) { console.warn(`${SYSTEM_ID} | handleMoveToken failed`, err); }
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

/* Drop an owned item out of an actor's inventory and INTO the world Items
 * collection (the sidebar Items tab), where anyone can pick it up. World
 * items require GM permission to create — players can't run
 * `Item.create()` directly against the world collection — so the sender
 * ships the item's JSON to the GM who performs the create and then
 * removes the original from the source actor.
 *
 * Source-actor permission check on the GM side prevents a rogue player
 * from ripping items off another player's PC via this socket. */
export function emitDropItemToWorld({ sourceActorUuid, itemId }) {
    const payload = { type: "dropItemToWorld", sourceActorUuid, itemId, senderUserId: game.user?.id };
    if (game.user.isActiveGM) return handleDropItemToWorld(payload);
    game.socket.emit(CHANNEL, payload);
}

/* Drop one of the sender's items onto the MAP: the GM mints a per-item `loot`
 * actor (art = the item) holding just that item, places its token at the drop
 * point, and removes the item from the source actor. GM-proxied because players
 * can't create world actors/tokens. Source-owner check mirrors dropItemToWorld. */
export function emitDropItemToMap({ sourceActorUuid, itemId, sceneId, x, y }) {
    const payload = { type: "dropItemToMap", sourceActorUuid, itemId, sceneId, x, y, senderUserId: game.user?.id };
    if (game.user.isActiveGM) return handleDropItemToMap(payload);
    game.socket.emit(CHANNEL, payload);
}

/* Drop one of the sender's items onto the scene as a small TILE showing the
 * item's icon (a ground item — no per-item actor). The GM creates the tile and
 * removes the item from the source. */
export function emitDropItemAsTile({ sourceActorUuid, itemId, sceneId, x, y }) {
    const payload = { type: "dropItemAsTile", sourceActorUuid, itemId, sceneId, x, y, senderUserId: game.user?.id };
    if (game.user.isActiveGM) return handleDropItemAsTile(payload);
    game.socket.emit(CHANNEL, payload);
}

/* Pick up a ground-item TILE: the GM creates the stored item on the taker and
 * deletes the tile. Authorized on the TARGET (the taker must own their own
 * character). */
export function emitTakeTileItem({ sceneId, tileId, targetActorUuid }) {
    const payload = { type: "takeTileItem", sceneId, tileId, targetActorUuid, senderUserId: game.user?.id };
    if (game.user.isActiveGM) return handleTakeTileItem(payload);
    game.socket.emit(CHANNEL, payload);
}

/* Transfer N coins of a given denomination from a loot actor into a
 * recipient actor. GM-proxied so a player without ownership of either
 * actor can pull their share. Loot-only on the source side. */
export function emitTransferLootCurrency({ sourceActorUuid, targetActorUuid, coin, quantity, fromUserId = null }) {
    const payload = { type: "transferLootCurrency", sourceActorUuid, targetActorUuid, coin, quantity, fromUserId };
    if (game.user.isActiveGM) return handleTransferLootCurrency(payload);
    game.socket.emit(CHANNEL, payload);
}

/* Sweep every item + coin off a loot actor into the recipient. Runs
 * item-gift + coin-transfer in sequence on the GM. */
export function emitTakeAllLoot({ sourceActorUuid, targetActorUuid, fromUserId = null }) {
    const payload = { type: "takeAllLoot", sourceActorUuid, targetActorUuid, fromUserId };
    if (game.user.isActiveGM) return handleTakeAllLoot(payload);
    game.socket.emit(CHANNEL, payload);
}

/* Mutate a monster CARCASS (remains item) as the GM. On the map the remains is
 * embedded on the (GM-owned) monster token actor, so a player inherits the
 * monster's permission and can't write it — every harvest/dissect/loot/trophy
 * mutation would throw. The GM performs the write here, the same way giftItem
 * and the "take carcass" grab already do. `update` is a flat update object
 * (flag-path keys etc.); `del` deletes the remains. `cleanupIfSpent` deletes
 * the remains AFTER the update iff it's fully spent (0 charges) and holds no
 * uncollected harvested loot — used when the loot popup empties a carcass. A
 * non-GM sender may only touch `remains`-type items (they're loot targets), so
 * this can't become a generic write-any-item backdoor. */
/* A player who DIRECTLY owns the remains (a world / theater-of-mind carcass
 * carries ownership.default = OWNER) can write it themselves — no GM hop, so it
 * still works with no GM online. Only the on-map embedded remains (inheriting
 * the GM-owned monster's permission) needs the proxy. */
function ownsRemainsDirectly(remainsUuid) {
    try { return !!fromUuidSync(remainsUuid)?.isOwner; }
    catch (_) { return false; }
}
export function emitRemainsMutate({ remainsUuid, update = null, del = false, cleanupIfSpent = false }) {
    const payload = { type: "remainsMutate", remainsUuid, update, del, cleanupIfSpent, senderUserId: game.user?.id };
    if (game.user.isActiveGM || ownsRemainsDirectly(remainsUuid)) return handleRemainsMutate(payload);
    game.socket.emit(CHANNEL, payload);
}
async function handleRemainsMutate({ remainsUuid, update, del, cleanupIfSpent }) {
    const item = await fromUuid(remainsUuid);
    if (!item || item.documentName !== "Item" || item.type !== "remains") {
        console.warn(`${SYSTEM_ID} | remainsMutate: not a remains item`, remainsUuid);
        return;
    }
    try {
        if (del) { await item.delete(); return; }
        if (update && typeof update === "object") await item.update(update);
        if (cleanupIfSpent) {
            const flags    = item.flags?.[SYSTEM_ID] ?? {};
            const charges  = flags.remainsCharges ?? null;
            const contents = flags.harvest?.contents;
            const empty    = !Array.isArray(contents) || contents.length === 0;
            if (charges === 0 && empty) await item.delete();
        }
    } catch (err) { console.warn(`${SYSTEM_ID} | remainsMutate failed`, err); }
}

/* Spend one carcass charge (harvest / dissect / extract) as the GM: shrink the
 * weight and decrement charges, then — on the last charge — delete the body
 * UNLESS it still holds uncollected harvested loot (kept so the player can open
 * it and grab the rest). The keep-vs-delete test reads the GM-authoritative
 * remains state, so it's correct no matter how the player's socket writes were
 * ordered. Same GM-proxy rationale as emitRemainsMutate. */
export function emitRemainsSpendCharge({ remainsUuid, remaining, newWeight, baseWeight }) {
    const payload = { type: "remainsSpendCharge", remainsUuid, remaining, newWeight, baseWeight, senderUserId: game.user?.id };
    if (game.user.isActiveGM || ownsRemainsDirectly(remainsUuid)) return handleRemainsSpendCharge(payload);
    game.socket.emit(CHANNEL, payload);
}
async function handleRemainsSpendCharge({ remainsUuid, remaining, newWeight, baseWeight }) {
    const item = await fromUuid(remainsUuid);
    if (!item || item.documentName !== "Item" || item.type !== "remains") {
        console.warn(`${SYSTEM_ID} | remainsSpendCharge: not a remains item`, remainsUuid);
        return;
    }
    try {
        await item.update({
            "system.weight":                          newWeight,
            [`flags.${SYSTEM_ID}.remainsCharges`]:    remaining,
            [`flags.${SYSTEM_ID}.remainsBaseWeight`]: baseWeight,
        });
        if (remaining === 0) {
            const contents = item.flags?.[SYSTEM_ID]?.harvest?.contents;
            const hasLoot  = Array.isArray(contents) && contents.length > 0;
            if (!hasLoot) await item.delete();
        }
    } catch (err) { console.warn(`${SYSTEM_ID} | remainsSpendCharge failed`, err); }
}

/* -------------------------------------------------------------------------- */
/* Handlers (run on the GM client only)                                       */
/* -------------------------------------------------------------------------- */

const ARMOR_LOCS = ["head", "torso", "leftArm", "rightArm", "leftLeg", "rightLeg", "tailWing"];

/* Aggregate equipped armor into the per-location { sp, dr, itemIds } shape
 * the damage calculator expects. Layering rule: SP is the MAXIMUM across
 * every equipped piece at the location, not the sum — a breastplate over
 * gambeson doesn't literally double your protection, it uses the tougher
 * of the two as the effective SP. Ablation, however, is still shared
 * across ALL pieces at the location (via `itemIds`), so a penetrating hit
 * chips every layer — the fiction is "the blow got through both layers,
 * damaging each". DR booleans (bludgeoning / slashing / piercing) are
 * unioned across pieces (either layer's resistance protects you).
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
        /* EO Fireproof (p.8) is a piece-wide QUALITY, not a per-zone
         * enhancement resistance — applies to every covered location. */
        const armorQualities = sys?.effective?.qualities ?? sys?.qualities ?? [];
        const isFireproof = armorQualities.some(q => q === "fireproof");
        for (const loc of ARMOR_LOCS) {
            // effective.stopping[loc].value wins; base {loc}Stopping is the fallback.
            const sp = Number(eff.stopping?.[loc]?.value ?? sys[`${loc}Stopping`]) || 0;
            if (sp <= 0) continue;
            /* Per-location DR list (EO p.4 zone-scoping): base piece-wide
             * resistances apply to every covered location; enhancement-
             * added resistances apply only to the zone their enhancement
             * was attached to. `effective.resistancesByLoc[loc]` carries
             * the merged view; when it's missing (legacy world data pre-
             * dating this derivation) fall back to the piece-wide flags. */
            const locRes = eff.resistancesByLoc?.[loc] ?? null;
            const drTypes = [];
            /* Physical + elemental resistances — read the per-location merged
             * view when present, else fall back to the piece-wide flags. */
            for (const rt of ["bludgeoning", "slashing", "piercing", "fire", "lightning", "cold", "acid"]) {
                const has = locRes ? !!locRes[rt] : !!sys[rt];
                if (has) drTypes.push(rt);
            }
            if (isFireproof) drTypes.push("fire", "elemental");
            if (!armor[loc]) armor[loc] = { sp: 0, dr: [], itemIds: [], _spList: [] };
            /* Collect each layer's SP; the combination (RAW buffer table vs
             * EO max-of-layers) is resolved once all pieces are gathered,
             * below. Both pieces still ride in `itemIds` so the ablation loop
             * in the damage calculator chips every layer on a penetrating hit. */
            armor[loc]._spList.push(sp);
            armor[loc].itemIds.push(item.id);
            for (const dt of drTypes) if (!armor[loc].dr.includes(dt)) armor[loc].dr.push(dt);
        }
    }
    /* Resolve the per-location SP from the gathered layers per the active armor
     * model: RAW buffer table (Core p.155), or the Combat Extended
     * "stronger + ¼ weaker" fold when eoArmorModel is on. MUST mirror
     * getLocationSP (dock.js) so the paperdoll / DoT soak agree with what an
     * incoming attack resolves against. */
    const _ceArmor = isCESubsystemEnabled?.("eoArmorModel");
    for (const loc of Object.keys(armor)) {
        armor[loc].sp = combineLayeredSPFor(armor[loc]._spList ?? [], _ceArmor);
        delete armor[loc]._spList;
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
export function buildActiveShield(actor) {
    for (const ae of actor.effects ?? []) {
        if (ae.disabled) continue;
        /* Skip castShield AEs — those are magic-shield sign casts (Quen,
         * Aard Ward, homebrew shield spells) whose pool lives in
         * system.derivedStats.shield (drained by Stage 1). Reading their
         * activeShieldHp flag here would cause Stage 2 to double-drain
         * the same pool. Non-cast activeShield AEs (manual GM setup,
         * focus features) still drain here. */
        if (ae.flags?.[SYSTEM_ID]?.castShield) continue;
        const hp = Number(ae.getFlag?.(SYSTEM_ID, "activeShieldHp"));
        if (Number.isFinite(hp) && hp > 0) return { hp, effectId: ae.id, name: ae.name ?? null };
    }
    return null;
}

/* For monsters: their SP is a single flat number on `combat.armor` that
 * applies to every location. Modeled as natural armor (separate from worn
 * armor so the bypassesNaturalArmor flag can target it).  No item-level
 * ablation (monster hides aren't items) — itemIds stays empty. */
function buildNaturalArmorShape(actor) {
    if (actor.type === "monster") {
        const sp = Number(actor.system?.combat?.armor) || 0;
        if (sp <= 0) return {};
        /* `ablates` mirrors the monster-sheet toggle. When true the calc
         * emits a synthetic ablation patch that our patch handler drains
         * from `system.combat.armor` directly (no item to update). */
        const ablates = !!actor.system?.combat?.armorAblates;
        const natural = {};
        for (const loc of ARMOR_LOCS) natural[loc] = { sp, dr: [], itemIds: [], ablates };
        return natural;
    }
    if (actor.type === "character") {
        /* Race natural armor (tough hide, scales, chitin…): full-body SP that
         * adds on top of worn armor on EVERY location, is NEVER ablated, and is
         * not a worn item so it never counts toward armor layering. Summed over
         * owned race items (a character normally has one). */
        let sp = 0;
        for (const it of actor.items?.contents ?? []) {
            if (it.type === "race") sp += Number(it.system?.naturalArmorSP) || 0;
        }
        if (sp <= 0) return {};
        const natural = {};
        for (const loc of ARMOR_LOCS) natural[loc] = { sp, dr: [], itemIds: [], ablates: false };
        return natural;
    }
    return {};
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

/* Crit bonus ladder now lives in the shared pure helper
 * combat/critBonus.mjs (RAW defaults) with world-level overrides in
 * mechanics/house-rules-config.mjs (hrCritBonusLadders). Both callsites
 * that need to convert a severity into a bonus value pass the live
 * ladders in, so a GM edit takes effect on the next hit. */

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
        /* `silverDamage` is a per-attack numeric payload field, not a
         * quality-derived boolean — kept out of this initializer so a
         * later `...qualityFlags` spread can't zero-out the rolled
         * silver total the damage source was built with. */
        isSilver: false, isMeteorite: false,
        /* Defender-side reaction hints (EO weapon qualities):
         *   indirect       — attacker's weapon is Indirect → defender's Block /
         *                    Parry rolls take an additional -2 (EO p.7).
         *   attackerFeeble — attacker's weapon is Feeble → a defender's Feeble
         *                    weapon is ALLOWED to Parry it (a Feeble weapon can
         *                    only Parry other Feeble weapons, EO p.7). When
         *                    false, the dialog drops feeble parry options. */
        indirect: false,
        attackerFeeble: false
    };
    for (const key of qualities) {
        if (cat[key]?.feebleParryRestrictedToFeeble) flags.attackerFeeble = true;
        const df = cat[key]?.damageFlags;
        if (!df) continue;
        for (const [flag, value] of Object.entries(df)) {
            if (value) flags[flag] = true;
        }
    }
    return flags;
}

/* Tracks which (attackMessage::target) pairs have already spent an oil-coating
 * charge this session. A single swing can apply damage to the same target more
 * than once — observed with Bear Forceful Blow, where two applies share the
 * attack message (e.g. the normal Roll-Damage button plus the Forceful Blow
 * rider, and/or a crit-bonus top-up). Without this each would tick a charge.
 * Checked+set synchronously to be race-safe within the GM's socket processing. */
const _oilChargeGuard = new Set();

/* ── Unmoving (armor quality) ───────────────────────────────────────────────
 * When an attacker strikes the wearer and deals 0 damage, the wearer may spend
 * 5 STA to immediately Stagger them. Implemented as a reactive button appended
 * to the attack card; the wearer's owner clicks it. */
const UNMOVING_STA_COST = 5;

function actorHasUnmoving(actor) {
    return equippedArmorHasQualityLabeled(actor, "Unmoving");
}

/* Append the Unmoving offer to the attack card. Resolves the attacker from the
 * attack message's speaker. No-op if already offered or no valid attacker. */
async function offerUnmovingStagger(defender, attackMessageUuid) {
    const msg = await fromUuid(attackMessageUuid).catch(() => null);
    if (!msg) return;
    if (String(msg.content ?? "").includes('data-action="wdm-unmoving"')) return;   // already offered
    const spk = msg.speaker ?? {};
    const attacker = spk.actor ? (game.actors?.get?.(spk.actor) ?? null) : null;
    const attackerUuid = attacker?.uuid ?? "";
    if (!attackerUuid || attacker === defender) return;
    const label = tFormat("WITCHER.Mech.Unmoving.Button", { cost: UNMOVING_STA_COST },
        `Unmoving — spend ${UNMOVING_STA_COST} STA to Stagger the attacker`);
    const btn = `<div class="wdm-attack-rider wdm-unmoving-offer">`
        + `<button type="button" data-action="wdm-unmoving" data-defender-uuid="${defender.uuid}" data-attacker-uuid="${attackerUuid}">`
        + `<i class="fa-solid fa-shield-halved"></i> ${label}</button></div>`;
    try { await msg.update({ content: String(msg.content ?? "") + btn }); } catch (_) { /* best effort */ }
}

/* Wire the Unmoving button (client-side). The wearer's owner spends 5 STA and
 * Staggers the attacker (via the GM status socket). */
export function installUnmovingHandler() {
    Hooks.on("renderChatMessageHTML", async (_msg, el) => {
        const btn = el.querySelector?.('button[data-action="wdm-unmoving"]');
        if (!btn || btn._wdmUnmovingWired) return;
        btn._wdmUnmovingWired = true;
        /* Only the defender's owner (and the GM) may see + use the offer. */
        const defenderPeek = await fromUuid(btn.dataset.defenderUuid).catch(() => null);
        if (!game.user?.isGM && !defenderPeek?.isOwner) {
            btn.closest(".wdm-unmoving-offer")?.remove() ?? btn.remove();
            return;
        }
        btn.addEventListener("click", async () => {
            const defender = await fromUuid(btn.dataset.defenderUuid).catch(() => null);
            const attackerUuid = btn.dataset.attackerUuid;
            if (!defender || !attackerUuid) return;
            if (!defender.isOwner) { ui.notifications?.warn(t("WITCHER.Mech.Unmoving.NotYours", "You don't control that defender.")); return; }
            const sta = Number(defender.system?.derivedStats?.sta?.value) || 0;
            if (sta < UNMOVING_STA_COST) { ui.notifications?.warn(t("WITCHER.Mech.Unmoving.NoSta", "Not enough Stamina for Unmoving.")); return; }
            try {
                if (typeof defender.spendStamina === "function") await defender.spendStamina(UNMOVING_STA_COST, { reason: "unmovingStagger" });
                else await defender.update({ "system.derivedStats.sta.value": Math.max(0, sta - UNMOVING_STA_COST) });
                emitApplyStatus({ targetUuid: attackerUuid, statusId: "staggered", action: "apply" });
                btn.disabled = true;
                btn.innerHTML = `<i class="fa-solid fa-check"></i> ${t("WITCHER.Mech.Unmoving.Done", "Unmoving — attacker Staggered.")}`;
            } catch (err) { console.warn(`${SYSTEM_ID} | Unmoving stagger failed`, err); }
        });
    });
}

async function handleApplyDamage(payload) {
    const target = await fromUuid(payload?.targetUuid);
    if (!target) return;
    /* Permission gate (multi-player audit S5): players can only
     * trigger damage against targets they have at least OBSERVER on
     * (any token they can see/click). The handler runs on the GM
     * client with full perms, so without this check a malicious
     * player could socket-call emitApplyDamage on any actor.
     *
     * Fallback: accept the write if the payload references an attack
     * message whose speaker the sender owns AND whose stamped
     * defenderUuid matches payload.targetUuid — covers the "GM hides
     * NPC sheets from players" setup where the attacker owns their own
     * PC but has no OBSERVER on the NPC target. See isLegitimateAttackDamage. */
    if (!authorizeSocket(payload, target) && !(await isLegitimateAttackDamage(payload))) {
        console.warn(`${SYSTEM_ID} | applyDamage refused — sender ${payload?.senderUserId} lacks permission on ${target.name}`);
        return;
    }

    // Backwards-compat: callers (chat macros, older buttons) may send
    // `amount` instead of `weaponDamage`, `type` (label) instead of
    // `damageTypes` (array), and `location` (label) instead of `locationKey`.
    let weaponDamage = Number(payload.weaponDamage ?? payload.amount);
    if (!Number.isFinite(weaponDamage)) return;

    /* Direct stamina drain — the Hefty block-through: the effort of blocking a
     * powerful blow. It is NOT a physical hit, so it bypasses the ENTIRE damage
     * pipeline: no Quen / Active Shield drain, no armor SP, no resists. The raw
     * amount (already halved by the caller) comes straight off stamina. */
    if (payload.directStamina) {
        const drain = Math.max(0, Math.floor(weaponDamage));
        if (drain > 0) {
            const staCur = Number(target.system.derivedStats?.sta?.value) || 0;
            try { await target.update({ "system.derivedStats.sta.value": Math.max(0, staCur - drain) }); }
            catch (err) { console.warn(`${SYSTEM_ID} | direct stamina drain failed`, err); }
        }
        return;
    }

    /* Direct HP drain — a self-inflicted COST, not an incoming hit (the 1 HP
     * strain of blocking a weapon with a natural weapon). Like directStamina it
     * bypasses the ENTIRE pipeline — no Quen / Active Shield, no armor SP, no
     * resists — so it always costs exactly the stated amount. Drains the temp
     * buffer first via drainHp, matching normal HP loss bookkeeping. */
    if (payload.directHp) {
        const drain = Math.max(0, Math.floor(weaponDamage));
        if (drain > 0) {
            try {
                const { value, temp } = drainHp(target.system.derivedStats?.hp, drain);
                await target.update({ "system.derivedStats.hp.value": value, "system.derivedStats.hp.temp": temp });
            } catch (err) { console.warn(`${SYSTEM_ID} | direct HP drain failed`, err); }
        }
        return;
    }

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
    /* Resolved oil bonus that flows into damageSource.oilBonus. Zero
     * unless the target category matched (or the oil is universal). */
    let resolvedOilBonus = 0;
    try {
        let weaponUuid0 = payload.weaponUuid || "";
        if (!weaponUuid0 && payload.attackMessageUuid) {
            const attackMsg0 = await fromUuid(payload.attackMessageUuid);
            weaponUuid0 = attackMsg0?.system?.weaponUuid || "";
        }
        /* Coating resolution.
         *
         * Ranged shots: the attack roll captures the fired ammo's oil
         * snapshot INLINE into the damage-button dataset (see
         * attackRollFlavor + emitApplyDamage). We prefer that inline
         * snapshot because spendShot deletes the 1-qty coated stack
         * before this click runs — fromUuid(ammoUuid) at this point
         * would return null and the fold would silently drop.
         *
         * Melee / thrown: no ammo, no inline snapshot; fall through to
         * the weapon's own appliedOil via fromUuid on weaponUuid0.
         *
         * A ranged shot from a coated bow with an UNCOATED arrow now
         * correctly folds NOTHING — the ammo carries no snapshot and
         * we never reach the weapon path for ranged (Core p.166). */
        const inlineBonus  = Number(payload.ammoOilBonus)  || 0;
        const inlineTarget = String(payload.ammoOilTarget || "");
        const inlineName   = String(payload.ammoOilName   || "");
        const hasInline    = !!payload.ammoUuid || inlineBonus > 0 || !!inlineName;
        let ao   = null;
        let bonus = 0;
        if (hasInline) {
            ao    = { name: inlineName, oilTarget: inlineTarget, oilBonusDamage: inlineBonus };
            bonus = inlineBonus;
        } else {
            const oilSource = weaponUuid0 ? await fromUuid(weaponUuid0) : null;
            ao    = oilSource?.system?.appliedOil ?? null;
            bonus = Number(ao?.oilBonusDamage) || 0;
        }
        if (bonus > 0) {
            /* Resolve the target's creature category for oil-match:
             *   monster  → system.category (canonical MONSTER_TYPES key)
             *   character→ first non-empty Race item's system.creatureType
             *              (set on the race sheet; enables oils like
             *              "humanoid oil" to bite a human PC).
             * Empty string when unresolved. */
            const oilTarget = String(ao?.oilTarget || "").toLowerCase();
            let targetCat = "";
            if (target?.type === "monster") {
                targetCat = String(target.system?.category || "").toLowerCase();
            } else if (target?.type === "character") {
                for (const it of target.items?.contents ?? []) {
                    if (it.type !== "race") continue;
                    const ct = String(it.system?.creatureType || "").trim().toLowerCase();
                    if (ct) { targetCat = ct; break; }
                }
            }
            const matched = !oilTarget || (targetCat && oilTarget === targetCat);
            if (matched) {
                /* Pass the oil bonus through the calculator as a
                 * separate field (see damageCalculator.mjs applyNatural-
                 * Resists — folded AFTER non-silver / non-meteorite
                 * halving so alchemical oil doesn't get quartered by
                 * the material gate). weaponDamage is left untouched;
                 * the calc adds oilBonus in-place. */
                resolvedOilBonus = bonus;
                oilBonusApplied = {
                    oilName:  String(ao?.name || "Oil"),
                    bonus,
                    baseWeapon: weaponDamage,
                    combined:   weaponDamage + bonus,
                    targetLabel: oilTarget ? String(ao?.oilTarget || "") : ""
                };
            }
        }
    } catch (err) {
        console.warn(`${SYSTEM_ID} | oil bonus damage fold failed`, err);
    }

    /* A WARD GETS ITS SAY FIRST.
     *
     * Gwynt Troelli deflects projectiles; Dervish redirects them. Both author
     * under `incomingAttack`, which nothing published — so both posted cards
     * promising protection the world never received. This is the one place
     * every attack in the system passes through, so it is where the offer
     * belongs.
     *
     * Deflection only. Absorption is the shield pool the calculator drains a
     * few lines below, and running both would soak the same points twice. */
    if (!payload.isOngoingTick) {
        try {
            const { offerAttackInterception } = await import("../magic/intercept.mjs");
            const { foundryAdapter } = await import("../magic/adapter.mjs");
            const attacker = payload.sourceActorUuid ? await fromUuid(payload.sourceActorUuid) : null;
            const verdict = await offerAttackInterception(target, {
                attackRoll: Number(payload.attackTotal) || null,
                kind: payload.kind ?? "weapon",
                damageTypes: payload.damageTypes ?? [],
                attacker
            }, foundryAdapter(target));
            if (verdict?.deflected) {
                console.log(`${SYSTEM_ID} | attack on ${target.name} deflected by a ward`);
                return { finalDamage: 0, deflected: true, effects: [] };
            }
        } catch (err) { console.warn(`${SYSTEM_ID} | attack interception failed`, err); }
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
    /* Cast-shield badge name (Quen, Aard Ward, Runic Guard, any homebrew
     * shield spell) — piped through the calculator so breakdown-line
     * renderers can name the actual spell that just took the hit rather
     * than defaulting to "Quen". Nothing depends on the string except
     * display. Null when no badge is present. */
    const castShieldBadge = (target.effects?.contents ?? [])
        .find(e => !!e.flags?.[SYSTEM_ID]?.castShield);
    const targetShape = {
        uuid:         target.uuid,
        hp:           { value: target.system.derivedStats?.hp?.value, temp: target.system.derivedStats?.hp?.temp },
        shield:       Number(target.system.derivedStats?.shield) || 0,
        shieldName:   castShieldBadge?.name ?? null,
        armor:        buildArmorShape(target),
        naturalArmor: buildNaturalArmorShape(target),
        monsterFlags: buildMonsterFlags(target),
        activeEffects:{ activeShield: activeShield ? { hp: activeShield.hp, name: activeShield.name ?? null } : null }
    };

    // Crit bonus: prefer an explicit numeric override (callers can still
    // pass it directly), else derive from severity using the ladder pair
    // for this target (normal vs. organ-immune). Ladders read live so
    // GM house-rule edits take effect on the next hit.
    const critBonus = (Number.isFinite(Number(payload.critBonus)) && payload.critBonus !== undefined)
        ? Number(payload.critBonus)
        : critBonusFor(payload.critSeverity, targetShape.monsterFlags.immuneToOrganCrits, hrCritBonusLadders());

    /* Ablating quality (RAW Core p.156): "This weapon does 1d6/2 damage to
     * the stopping power of armor if it penetrates." Roll the chip bonus
     * here on the GM side BEFORE handing the source to the deterministic
     * calculator; the rolled value (0–3) becomes part of the source so the
     * breakdown audit can show exactly what was chipped. */
    const ablatingChipBonus = qualityFlags.ablating
        ? Math.floor((1 + Math.floor(Math.random() * 6)) / 2)
        : 0;

    /* Silver Weapon Trait (R. Talsorian 7/11/25 rule update). When the
     * `newSilverRules` house-rule is ON, a weapon carrying the trait is
     * treated as silver for downstream gates — regardless of legacy
     * qualities. When the house rule is OFF, the trait is inert. Reads the
     * weapon by UUID from either the explicit payload field or the attack
     * chat message, mirroring the oil-resolution path above. */
    const newSilverRulesOn = hrNewSilverRules();
    let silverTraitOn = false;
    if (newSilverRulesOn) {
        try {
            let wu = payload.weaponUuid || "";
            if (!wu && payload.attackMessageUuid) {
                const am = await fromUuid(payload.attackMessageUuid);
                wu = am?.system?.weaponUuid || "";
            }
            if (wu) {
                const w = await fromUuid(wu);
                silverTraitOn = !!w?.system?.silverTrait;
            }
        } catch (_) { /* keep default false */ }
    }
    const damageSource = {
        /* qualityFlags spread FIRST so per-payload fields below (weaponDamage,
         * silverDamage, damageTypes, etc.) win over the flags-object defaults.
         * Prior order let a stale `silverDamage: 0` from the flags initializer
         * clobber the rolled silver total — silver-vs-silver-weak monsters
         * received a halved base with zero silver top-up. */
        ...qualityFlags,
        /* Silver is a pickable weapon quality (valueless → stamps
         * damageFlags.isSilver, no separate silver dice). The legacy
         * `silverTrait` boolean is still honoured so weapons that set it
         * before Silver became a quality keep counting as silver. Either
         * marks the weapon silver; the calculator's silver-weak-full +
         * poor-edge-half behaviour (and the Meteorite exemption) key off
         * isSilver. The separate silver damage roll stays disabled under the
         * new rules (silverDamage is forced to 0 below). */
        isSilver: !!qualityFlags.isSilver || silverTraitOn,
        /* Passed through so the calculator can gate the new-rule
         * "silver poor edge" halve without another config import. */
        newSilverRules: newSilverRulesOn,
        kind:                  payload.kind ?? "weapon",
        weaponDamage,
        /* Silver-quality split damage (hybrid steel-with-silver-inlay weapons,
         * RAW Core p.157). Pre-rolled on the attacker side; folded by the
         * calculator only when the target is silver-resistant. Zero / unset
         * means no silver portion was rolled. Under new silver rules the
         * legacy silver quality is disabled — drop any pre-rolled portion. */
        silverDamage:          newSilverRulesOn ? 0 : Math.max(0, Number(payload.silverDamage) || 0),
        oilBonus:              resolvedOilBonus,
        oilName:               oilBonusApplied?.oilName ?? "",
        oilTargetLabel:        oilBonusApplied?.targetLabel ?? "",
        ablatingChipBonus,
        /* Non-lethal (brawl/pommel/Hefty block-through, and pulled-blow natural
         * weapons) is a controlled subduing hit — it drains STA (below) and,
         * per the calculator's gate, does NOT ablate the target's armor. */
        nonLethal:             !!payload.nonLethal,
        critBonus,
        damageTypes,
        location,
        defense:               Array.isArray(payload.defense) ? payload.defense : [],
        tangible:              payload.tangible !== false,
        isOngoingTick:         !!payload.isOngoingTick,
        bypassesWornArmor:     fullBypass || !!payload.bypassesWornArmor,
        bypassesNaturalArmor:  fullBypass || !!payload.bypassesNaturalArmor,
        bypassesShield:        fullBypass || !!payload.bypassesShield
    };

    /* Snapshot the magic shield's display name BEFORE the calculator's
     * patches get written back — the cast-shield badge AE is deleted
     * inline when the pool hits zero (line ~774 below), so by the time
     * we reach the crit-wound apply block a shield-broke-under-crit
     * hit would have no badge left to read the name from. */
    const magicShieldName = (target.effects?.contents ?? [])
        .find(e => !!e.flags?.[SYSTEM_ID]?.castShield)?.name ?? null;

    const result = resolveDamage({ damageSource, target: targetShape });

    /* Apply the patches. HP uses drainHp so the temp/value split is right. */
    const hpLoss = -result.patches.hp.delta;
    const updates = {};
    if (hpLoss > 0) {
        if (payload.staThenHp) {
            /* Suffocation (choke): drains STAMINA first; any amount beyond the
             * target's current stamina spills over into HP. So a choke wears the
             * victim down (stamina) and only starts killing once they're winded. */
            const staCur = Number(target.system.derivedStats?.sta?.value) || 0;
            const toSta  = Math.min(staCur, hpLoss);
            const toHp   = hpLoss - toSta;
            updates["system.derivedStats.sta.value"] = staCur - toSta;
            if (toHp > 0) {
                const { value, temp } = drainHp(target.system.derivedStats?.hp, toHp);
                updates["system.derivedStats.hp.value"] = value;
                updates["system.derivedStats.hp.temp"]  = temp;
            }
        } else if (payload.nonLethal) {
            /* Non-lethal damage (brawl, pommel, Hefty block-through) drains
             * STAMINA, not HP — armor / resists still shape the number above,
             * only the destination pool changes. A 0-STA result is the stun
             * threshold handled by the existing STA machinery. */
            const staCur = Number(target.system.derivedStats?.sta?.value) || 0;
            updates["system.derivedStats.sta.value"] = Math.max(0, staCur - hpLoss);
        } else {
            const { value, temp } = drainHp(target.system.derivedStats?.hp, hpLoss);
            updates["system.derivedStats.hp.value"] = value;
            updates["system.derivedStats.hp.temp"]  = temp;
        }
    }
    if (result.patches.shield.delta) {
        const cur = Number(target.system.derivedStats?.shield) || 0;
        updates["system.derivedStats.shield"] = Math.max(0, cur + result.patches.shield.delta);
    }
    if (Object.keys(updates).length) await target.update(updates);

    /* Struck-clears-status. Any active status whose clause is flagged
     * `clearOnHit` (currently `stunned`, statusClauses.mjs) ends the instant the
     * bearer takes a hit — the flag existed but nothing ever consumed it. Gated
     * on damage actually landing (finalDamage > 0). Note a STA-depletion stun
     * will re-apply on the next STA sync, which is correct: being winded outlasts
     * a single blow, whereas a rider-inflicted stun is shaken off by it. */
    if ((Number(result.finalDamage) || 0) > 0 && target.statuses?.size) {
        try {
            const { clauseFor } = await import("../mechanics/statusEngine.mjs");
            for (const sid of [...target.statuses]) {
                if (!clauseFor(sid, target)?.clearOnHit) continue;
                /* Clears even a 0-STA stun: it's now a one-shot condition (see
                 * mechanics/stun.mjs), so being struck removes it and it does NOT
                 * re-apply while STA stays at 0 — the actor is no longer stunned
                 * but still owes a Recovery action to refill Stamina. */
                await target.toggleStatusEffect(sid, { active: false });
            }
        } catch (err) {
            console.warn(`${SYSTEM_ID} | clearOnHit status removal failed`, err);
        }
    }

    /* Unmoving (armor) — the wearer soaked the strike for 0 HP; offer the
     * reactive 5-STA Stagger on the attack card. GM-side append. */
    if (hpLoss <= 0 && payload.attackMessageUuid && actorHasUnmoving(target)) {
        try { await offerUnmovingStagger(target, payload.attackMessageUuid); } catch (_) { /* best effort */ }
    }

    /* Cast-shield badge sync — Quen / Active Shield cast AEs live at
     * flags.<SYSTEM_ID>.castShield with an activeShieldHp value shown
     * on the AE name. Stage 1 just drained the underlying pool
     * (system.derivedStats.shield); refresh every badge's flag to
     * match, and delete any whose pool has hit zero. Iterating in a
     * batch keeps this cheap even if the actor is somehow carrying
     * multiple cast-shield AEs (only one at a time is the intended
     * invariant, but a stale duplicate shouldn't survive drain). */
    if (result.patches.shield.delta) {
        const shieldNow = Number(updates["system.derivedStats.shield"]
                                ?? target.system.derivedStats?.shield) || 0;
        const badges = (target.effects?.contents ?? [])
            .filter(e => !!e.flags?.[SYSTEM_ID]?.castShield);
        for (const ae of badges) {
            try {
                if (shieldNow <= 0) await ae.delete();
                else await ae.setFlag(SYSTEM_ID, "activeShieldHp", shieldNow);
            } catch (err) {
                console.warn(`${SYSTEM_ID} | cast-shield badge sync failed`, err);
            }
        }
    }

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

    /* SP ablation — write the new value per patch. Three shapes:
     *   - { natural: true, spDelta } → drains actor's
     *     system.combat.armor (monster natural armor, one field for
     *     all locations; opted into via the monster sheet's
     *     "Armor ablates" toggle).
     *   - { itemId, spDelta } where item.type === "shield" → drains
     *     reliability.value (Combat Extended Raise Shield overlay).
     *     Shield reaching 0 is still "raised"; isBroken handles that,
     *     and the next attack's buildArmorShape sees the 0 and
     *     drops the overlay.
     *   - { itemId, spDelta } → drains per-location {locKey}Stopping
     *     on the worn armor item. */
    for (const patch of result.patches.armorAblation ?? []) {
        if (patch.natural) {
            const cur  = Number(target.system?.combat?.armor) || 0;
            const next = Math.max(0, cur + patch.spDelta);
            if (next !== cur) await target.update({ "system.combat.armor": next });
            continue;
        }
        const item = target.items?.get?.(patch.itemId);
        if (!item) continue;
        if (item.type === "shield") {
            // Only roll the Durable save when the patch actually ablates.
            if (Number(patch.spDelta) < 0 && await durableAblationNegated(item, { actor: target })) continue;
            const cur  = Number(item.system?.reliability?.value) || 0;
            const next = Math.max(0, cur + patch.spDelta);
            if (next !== cur) await item.update({ "system.reliability.value": next });
            continue;
        }
        const locKey = damageSource.location.key;
        const field  = `${locKey}Stopping`;
        const cur    = Number(item.system?.[field]) || 0;
        const next   = Math.max(0, cur + patch.spDelta);
        if (next !== cur) await item.update({ [`system.${field}`]: next });
    }

    /* Audit card — collapsed by default; lets the GM see exactly which
     * pipeline stages fired and the running totals. If the caller passed
     * `attackMessageUuid`, APPEND the breakdown to that message so the
     * whole attack lives in a single chat card; otherwise post standalone
     * (the fallback for non-attack damage sources, e.g. spell ticks). */
    try {
        /* Oil bonus stage is now emitted by the calculator inside
         * applyNaturalResists (after non-silver / non-meteorite halving),
         * so no synthetic prepend is needed here — the breakdown ledger
         * reads it in its correct pipeline position. */
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
            /* Ranged shots (payload.ammoUuid set) skip the charge-decrement
             * entirely: the coated arrow is a 1-qty item that gets consumed
             * by spendShot on the same fire, taking its appliedOil with it.
             * Decrementing charges on an item about to be deleted would
             * fire the "coating depleted" chat line for nothing. Melee /
             * thrown shots (no ammoUuid) still tick the weapon's charges
             * as before. */
            /* One coating charge per ATTACK per target — not per damage
             * application. A single swing can re-enter handleApplyDamage more
             * than once for the same hit (observed with Bear Forceful Blow);
             * each re-entry is the same strike and must cost a single charge.
             * Dedupe on the attack message + target, and only count applies
             * that actually delivered weapon/silver damage (a pure crit-bonus
             * top-up carries neither and shouldn't tick oil). */
            const dealtWeaponDmg = (Number(payload.weaponDamage) || 0) > 0
                                 || (Number(payload.silverDamage) || 0) > 0;
            const oilAttackUuid  = payload.attackMessageUuid || attackMsg?.uuid || "";
            const oilKey         = oilAttackUuid ? `${oilAttackUuid}::${target.uuid}` : "";
            const oilDuplicate   = oilKey && _oilChargeGuard.has(oilKey);
            if (isReborn && hpLoss > 0 && !payload.ammoUuid && dealtWeaponDmg && !oilDuplicate && !payload.nonLethal) {
                if (oilKey) _oilChargeGuard.add(oilKey);
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
                                "system.appliedOil": { id: "", name: "", img: "", oilTarget: "", oilBonusDamage: 0, appliedAt: 0, expireAt: 0, charges: 0, maxCharges: 0, onHitStatuses: [] }
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

        /* Oil-poison on-hit application. Runs on every damaging hit (hpLoss > 0)
         * regardless of Alchemy Reborn / RAW: appliedOil.onHitStatuses is the
         * canonical snapshot of the source oil's AEs, taken at coat time. Each
         * entry is fresh-spawned as an AE on the target actor with the coated
         * weapon UUID as origin — so downstream tick + duration mechanics see
         * it exactly like an AE from a consumed alchemical (the pause action
         * catches it too, since fromAlchemicalItem is stamped when origin
         * resolves to an alchemical item). */
        try {
            if (hpLoss > 0 && !payload.nonLethal) {
                let weaponUuid = payload.weaponUuid || "";
                if (!weaponUuid && attackMsg) weaponUuid = attackMsg?.system?.weaponUuid || "";
                const weapon = weaponUuid ? await fromUuid(weaponUuid) : null;
                const statuses = weapon?.system?.appliedOil?.onHitStatuses;
                if (Array.isArray(statuses) && statuses.length) {
                    const originUuid = weapon?.uuid || "";
                    const seeds = statuses.map(s => {
                        const seed = foundry.utils.deepClone(s);
                        delete seed._id;
                        seed.origin = originUuid;
                        // Landing directly on an actor — never transfer:true.
                        // Inheriting the source oil AE's transfer flag would
                        // be meaningless here (no parent item to transfer from)
                        // and could confuse Foundry's ownership resolver.
                        seed.transfer = false;
                        // Stamp fromAlchemicalItem directly — the standard
                        // _preCreate check resolves `origin` and only stamps
                        // when it points to an item of type "alchemical". The
                        // origin here is the WEAPON (so tickTimedHeals /
                        // pauser resume can find its way back), not the oil,
                        // so the check would fail and alchemy-pause wouldn't
                        // catch these statuses. Stamp explicitly since we
                        // know for certain they're oil-borne.
                        seed.flags = seed.flags ?? {};
                        seed.flags[SYSTEM_ID] = seed.flags[SYSTEM_ID] ?? {};
                        seed.flags[SYSTEM_ID].fromAlchemicalItem = true;
                        // Anchor time-based durations to the moment of application.
                        if (seed.duration) {
                            seed.duration.startTime = Number(game.time?.worldTime ?? 0);
                            delete seed.duration.startRound;
                            delete seed.duration.startTurn;
                        }
                        return seed;
                    });
                    await target.createEmbeddedDocuments("ActiveEffect", seeds);
                }
            }
        } catch (err) { console.warn(`${SYSTEM_ID} | oil on-hit status apply failed`, err); }

        if (attackMsg) {
            /* `suppressBreakdown` payload flag — when set, we still apply
             * HP damage and append the compact summary chip to the
             * attack card's one-liner, but SKIP the verbose per-hit
             * breakdown `<details>` block. Used by callers that
             * generate many rapid hits (bombs: 6 per-location applies
             * per victim → 6 breakdowns would flood the card). Those
             * callers post their own consolidated summary via
             * emitAppendAttackFragment afterward. */
            const suppress = !!payload.suppressBreakdown;
            /* Head line — include location label prominently when the
             * hit specifies one so per-location breakdowns (bombs,
             * multi-location spells) read clearly in the nested tree.
             * "Torso — Applied to Timmy: −4 HP" instead of a
             * location-less "Applied to Timmy: −4 HP". */
            const headLocPrefix = location.label
                ? `<strong class="wdm-attack-applied-loc">${escAttr(location.label)}</strong> — `
                : "";
            const fragment = suppress ? "" :
                `<div class="wdm-attack-applied">` +
                    `<div class="wdm-attack-applied-head">${headLocPrefix}${t("WITCHER.Setup.SocketHook.Text.AppliedTo", "Applied to")} <strong>${escAttr(target.name)}</strong>: <span class="wdm-attack-applied-hp">${result.finalDamage > 0 ? `−${result.finalDamage} HP` : "no damage"}</span></div>` +
                    breakdownHtml +
                `</div>`;
            /* Typed summary chip — sits in the master one-liner with
             * a damage-red palette so the eye lands on it. Location
             * goes before damage so the chip reads "torso · 6 dmg". */
            const locLabel = location.label || location.key || "";
            /* Optional source tag (e.g. "Ramming") so a folded-in extra hit is
             * distinguishable from the main strike's damage chip. */
            const srcTag = payload.sourceLabel ? `${payload.sourceLabel} · ` : "";
            const damageLabel = result.finalDamage > 0
                ? `${srcTag}${locLabel ? `${locLabel} · ` : ""}${result.finalDamage} dmg`
                : `${srcTag}${locLabel ? `${locLabel} · ` : ""}no damage`;
            await appendAttackResult(attackMsg, {
                fragment,
                summaryAdd: { label: damageLabel, kind: "damage", icon: "fa-burst" },
                /* Bombs pass appendWrapperSelector so their per-
                 * location breakdowns land nested inside the pre-
                 * posted per-victim <details> instead of at card top. */
                wrapperSelector: payload.appendWrapperSelector ?? null
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
            /* Magic-shield (Quen / Barrier / Active Shield) chip — surface the
             * barrier interaction in the collapsed one-liner so it's obvious the
             * shield soaked the hit, and — when its pool hits 0 — that it
             * SHATTERED. Same for melee, ramming, spells; any damage that drew on
             * a shield. Reads the calculator's shield stages. */
            const _shieldStages = (result.stages ?? []).filter(s =>
                s.stage === "shield" || s.stage === "activeShield"
                || s.stage === "critShield" || s.stage === "critActiveShield");
            if (_shieldStages.length) {
                const drained   = _shieldStages.reduce((a, s) => a + (Number(s.drained) || 0), 0);
                const remaining = Math.min(..._shieldStages.map(s => Number(s.shieldRemaining ?? s.hpRemaining ?? 0)));
                if (drained > 0) {
                    const shieldNm = magicShieldName || t("WITCHER.Chat.MagicShield.Fallback", "magic shield");
                    await appendAttackResult(attackMsg, {
                        summaryAdd: remaining <= 0
                            ? { label: tFormat("WITCHER.Setup.SocketHook.Text.MagicShieldShattered", { shield: shieldNm }, "{shield} shattered"),        kind: "fumble", icon: "fa-shield-slash" }
                            : { label: tFormat("WITCHER.Setup.SocketHook.Text.MagicShieldSoaked",    { shield: shieldNm, n: drained }, "{shield} soaked {n}"), kind: "info",   icon: "fa-shield-halved" }
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
     * Only fires if a severity was determined upstream (delta ≥ 7).
     *
     * Magic-shield suppression: if the hit netted 0 HP damage AND a magic
     * shield (Quen / Active Shield, base or crit-drain stages) participated
     * in absorbing it, the crit wound doesn't land — the fiction is the
     * shield ate the whole strike, catastrophic angle and all. Post a
     * feedback chip naming the shield in place of the wound apply so the
     * table can see what happened. */
    if (payload.critSeverity && !payload.nonLethal) {
        const shieldStages = new Set(["shield", "activeShield", "critShield", "critActiveShield"]);
        const magicShieldAbsorbed = result.finalDamage === 0
            && (result.stages ?? []).some(s => shieldStages.has(s.stage));
        if (magicShieldAbsorbed) {
            const attackMsg = payload.attackMessageUuid
                ? await fromUuid(payload.attackMessageUuid).catch(() => null)
                : null;
            if (attackMsg) {
                try {
                    await appendAttackResult(attackMsg, {
                        summaryAdd: {
                            label: tFormat(
                                "WITCHER.Setup.SocketHook.Text.MagicShieldStoppedCrit",
                                { shield: magicShieldName ?? t("WITCHER.Chat.MagicShield.Fallback", "magic shield") },
                                "{shield} stopped critical wound"),
                            kind: "info",
                            icon: "fa-shield-halved"
                        }
                    });
                } catch (err) { console.warn(`${SYSTEM_ID} | crit-suppressed chip append failed`, err); }
            }
        } else {
            try {
                await autoApplyCriticalWound({
                    actor: target,
                    severity: payload.critSeverity,
                    locationKey: location.key,
                    attackMessageUuid: payload.attackMessageUuid ?? null,
                    /* `finalDamage > 0` = the strike broke through the
                     * target's SP at the hit location. Passed so the
                     * crit-apply flow can honour the "House Rules →
                     * Crit SP Downgrade" mode when armor fully
                     * absorbed the hit. */
                    damagePenetrated: (Number(result.finalDamage) || 0) > 0
                });
            } catch (err) {
                console.warn(`${SYSTEM_ID} | crit wound auto-apply failed`, err);
            }
        }
    }

    return result;
}

/** Tiny attr-safe escape — protects against quotes/<> in actor names when
 *  we splice them into HTML being appended to the attack card. */
function escAttr(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/* GM-side: append an HTML fragment to an attack ChatMessage.
 *
 * Gated on the sender OWNING the attack card's speaker actor (or being
 * a GM) — the same isAttacker || isGM check that decides whether the
 * caller can even SEE the damage button in weaponAttackMixin. So no
 * new sender can slip through this route that couldn't already trigger
 * a damage roll. */
async function handleAppendAttackFragment(payload) {
    const attackMsg = payload?.attackMessageUuid ? await fromUuid(payload.attackMessageUuid) : null;
    if (!attackMsg) return;
    const senderUserId = payload?.senderUserId;
    if (senderUserId) {
        const sender = game.users?.get(senderUserId);
        if (!sender) return;
        if (!sender.isGM) {
            const sp = attackMsg.speaker ?? {};
            const attackerActor = sp.actor ? game.actors?.get?.(sp.actor)
                                : sp.token ? game.scenes?.get?.(sp.scene)?.tokens?.get?.(sp.token)?.actor
                                : null;
            const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
            const ok = attackerActor && typeof attackerActor.testUserPermission === "function"
                && attackerActor.testUserPermission(sender, OWNER);
            if (!ok) {
                console.warn(`${SYSTEM_ID} | appendAttackFragment refused — sender ${senderUserId} lacks owner permission on the attack's speaker`);
                return;
            }
        }
    }
    const opts = {};
    if (typeof payload.fragment === "string" && payload.fragment) opts.fragment = payload.fragment;
    if (payload.summaryAction !== undefined && payload.summaryAction !== null) opts.summaryAction = payload.summaryAction;
    if (payload.summaryAdd) opts.summaryAdd = payload.summaryAdd;
    if (payload.wrapperSelector) opts.wrapperSelector = payload.wrapperSelector;
    await appendAttackResult(attackMsg, opts);
}

async function handleApplyStatus(payload) {
    const { targetUuid, statusId, action } = payload;
    const target = await fromUuid(targetUuid);
    if (!target || !statusId) return;
    /* Permission gate (multi-player audit S5): a player can only apply
     * a status to a target they can OBSERVE. Without this, a malicious
     * player could socket-call to apply Stunned / Prone / etc. to any
     * actor including GM-only NPCs.
     *
     * Fallback: attack-tied riders (Trip → prone, holds, etc.) come
     * with the same attackMessageUuid the damage payload uses, so accept
     * the write when the sender owns the attacker AND the target is the
     * message's stamped defender. Same tight check as applyDamage. */
    if (!authorizeSocket(payload, target)
        && !senderOwnsSourceActor(payload)
        && !(await isLegitimateAttackDamage(payload))) {
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
    /* Refresh sweep — a caller with `stripPriorSource:"axii"` (etc.) wants
     * any existing status-carrying AE from the same SOURCE removed before
     * the new one is stamped. Used by re-cast rules where the latest cast
     * replaces prior instances (e.g. Axii re-cast overwrites the previous
     * −N save penalty rather than stacking). We only match AEs that
     * BOTH carry `statusId` AND have `flags.<SYSTEM_ID>.source === source`,
     * so unrelated stunned AEs (STA-depletion, Stun-quality weapon) are
     * untouched. Fires only in the APPLY direction. */
    if (active && payload?.stripPriorSource) {
        try {
            const src = String(payload.stripPriorSource);
            const priors = (target.effects ?? []).filter(e =>
                e.statuses?.has?.(statusId)
                && String(e.getFlag?.(SYSTEM_ID, "source") ?? "") === src
            );
            if (priors.length) {
                await target.deleteEmbeddedDocuments(
                    "ActiveEffect",
                    priors.map(e => e.id)
                );
            }
        } catch (err) {
            console.warn(`${SYSTEM_ID} | handleApplyStatus stripPriorSource failed`, err);
        }
    }
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
                    content: tFormat(
                        "WITCHER.Setup.SocketHook.Chat.ShieldAbsorbs",
                        { label: t("WITCHER.Setup.SocketHook.Text.CastShield", "Cast shield"), target: Handlebars.escapeExpression(target.name), status: Handlebars.escapeExpression(statusId) },
                        "<div class=\"wdm-attack-rider\"><i class=\"fa-solid fa-shield-halved\"></i> <strong>{label}</strong> — {target}'s active shield absorbs the {status} effect.</div>"
                    ),
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
        } else {
            const token = target.getActiveTokens?.()?.[0];
            const def   = CONFIG.statusEffects.find(s => s.id === statusId);
            if (token && def) await token.toggleEffect(def, { active });
        }
        /* Flags stamp — a caller (Axii's rider path) may attach extra AE
         * flags that persist WITH the status: an end-check modifier read
         * later by promptStatusEndChecks, or a source key that later
         * refresh sweeps can match. Applied to the AE that carries this
         * status; picks the freshest match when several exist. Only
         * fires when the toggle just APPLIED the status. */
        if (active && payload?.flags && typeof payload.flags === "object") {
            const carriers = (target.effects ?? []).filter(e =>
                e.statuses?.has?.(statusId)
            );
            const carrier = carriers[carriers.length - 1];
            if (carrier) await carrier.update({ flags: payload.flags });
        }
    } catch (err) {
        console.warn(`${SYSTEM_ID} | handleApplyStatus failed for ${statusId}:`, err);
    }
}

/** GM-side: apply a knockback push to a placed token. Resolves the
 *  target Token by UUID, then defers to the pure pushToken() primitive.
 *  Fires on the GM's client so the token-document update succeeds even
 *  when a player triggered it against a GM-owned NPC. */
async function handlePushToken(payload) {
    const { tokenUuid, sourcePoint, distanceMeters, preserveHolds = false } = payload;
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
    return pushToken({ token: placed, sourcePoint, distanceMeters, preserveHolds });
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
    if (await durableAblationNegated(item, { actor: item.parent })) return;   // Durable rune save
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
 * the table can see what happened.
 *
 * Container path: containers carry an array of item UUIDs in
 * `system.content` pointing at OTHER embedded items on the same actor
 * (see chrome/lib/container.js and moveItemToContainer). When gifting a
 * container we recursively gather the whole subtree, batch-create it on
 * the recipient, and rewrite each new container's `content` to point at
 * the new UUIDs. Nested containers are supported; the transfer is
 * atomic-ish (create-then-delete), so a mid-flow failure leaves the
 * source intact. */
/* Serialize handlers that read-then-write the SAME resource so two concurrent
 * takes can't both pass the exists/quantity check before either write lands
 * (which duplicates items/coin). Unlike the tile CLAIM guard (a tile is
 * single-use, so the 2nd take is refused), a stack legitimately lets two takers
 * each grab one — so we CHAIN by key instead of blocking: the 2nd call runs
 * after the 1st resolves and therefore reads the decremented quantity. */
const _transferLocks = new Map();   // key → tail promise of the serialized chain
function serializeByKey(key, fn) {
    const prev = _transferLocks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    _transferLocks.set(key, next);
    next.finally(() => { if (_transferLocks.get(key) === next) _transferLocks.delete(key); });
    return next;
}

function handleGiftItem(payload) {
    return serializeByKey(`gift:${payload?.sourceActorUuid}:${payload?.itemId}`, () => _doGiftItem(payload));
}
async function _doGiftItem({ sourceActorUuid, targetActorUuid, itemId, quantity, fromUserId }) {
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

    if (item.type === "container") {
        const ok = await giftContainerTree(source, target, item);
        if (!ok) return;
        try {
            const fromUser = fromUserId ? game.users?.get?.(fromUserId) : null;
            const sender   = fromUser?.name ? `${fromUser.name}` : source.name;
            await ChatMessage.create({
                speaker: ChatMessage.implementation.getSpeaker({ actor: source }),
                content: tFormat(
                    "WITCHER.Setup.SocketHook.Chat.GiftGave",
                    { sender: escAttr(sender), item: escAttr(item.name), target: escAttr(target.name) },
                    "<div class=\"wdm-gift-card\"><i class=\"fa-solid fa-gift\"></i> <strong>{sender}</strong> gave <strong>{item}</strong> to <strong>{target}</strong>.</div>"
                )
            });
        } catch (err) { console.warn(`${SYSTEM_ID} | handleGiftItem: chat post failed`, err); }
        return;
    }

    const stackQty = Math.max(1, Number(item.system?.quantity) || 1);
    const moveQty  = Math.max(1, Math.min(stackQty, Number(quantity) || 1));

    /* Snapshot the data we'll plant on the recipient BEFORE mutating the
     * source — once we decrement / delete, the live item object can no
     * longer be cloned reliably.
     *
     * Strip container-membership state (`isStored`, `isCarried: false`)
     * before handing to the recipient. If the gifted item was inside one
     * of the sender's containers, `isStored: true` came along in the
     * snapshot — landing it on the receiver in that state makes the
     * inventory display filter it out (see chrome/inventory.js:2788,
     * 2891, 3242 — all skip `isStored` items on the loose-inventory
     * pass), so the receiver saw "nothing arrived" even though the item
     * was actually on their actor. Same story for `isCarried: false`
     * items that were staged out of inventory before the gift. */
    const proto = item.toObject();
    proto.system = { ...(proto.system ?? {}), quantity: moveQty };
    delete proto.system.isStored;
    delete proto.system.isCarried;
    delete proto._id;

    /* Decrement the source. If the gift empties the stack, delete the
     * item outright AND scrub any container.system.content array that
     * referenced it — mirrors the container-cleanup in
     * handleDropItemToWorld (line 1402-1411). Without this, the source
     * actor's container keeps a dead uuid in its content list, which
     * shows up as an empty slot + throws the container's rolled-up
     * weight math off. */
    if (moveQty >= stackQty) {
        for (const container of source.items) {
            if (container.type !== "container") continue;
            const content = container.system?.content;
            if (!Array.isArray(content)) continue;
            if (content.includes(item.uuid) || content.includes(item.id)) {
                const next = content.filter(u => u !== item.uuid && u !== item.id);
                try { await container.update({ "system.content": next }); }
                catch (err) { console.warn(`${SYSTEM_ID} | handleGiftItem container cleanup failed`, err); }
            }
        }
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
            content: tFormat(
                "WITCHER.Setup.SocketHook.Chat.GiftGaveQty",
                { sender: escAttr(sender), item: escAttr(item.name), qty: escAttr(qtyText), target: escAttr(target.name) },
                "<div class=\"wdm-gift-card\"><i class=\"fa-solid fa-gift\"></i> <strong>{sender}</strong> gave <strong>{item}{qty}</strong> to <strong>{target}</strong>.</div>"
            )
        });
    } catch (err) { console.warn(`${SYSTEM_ID} | handleGiftItem: chat post failed`, err); }
}

/* GM-side handler for a player's "drop item to world" request.
 * Snapshots the source item's JSON, creates it in the world Items
 * collection with default-OWNER ownership (so any player can pick it
 * up), then deletes the original from the source actor (including
 * removing it from any container's content list). Refuses if the
 * sender doesn't own the source actor — prevents cross-player theft. */
async function handleDropItemToWorld({ sourceActorUuid, itemId, senderUserId }) {
    const source = await fromUuid(sourceActorUuid);
    if (!source) return;
    /* Sender must OWN the source actor. Their own PC = fine; someone
     * else's PC = refuse. */
    const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
    if (!authorizeSocket({ senderUserId }, source, OWNER)) {
        console.warn(`${SYSTEM_ID} | dropItemToWorld refused — sender lacks OWNER on ${source?.name}`);
        return;
    }
    const item = source.items?.get?.(itemId);
    if (!item) return;
    const itemData = item.toObject(false);
    /* Default OWNER so any player can pick it back up. */
    itemData.ownership = { default: OWNER };
    try {
        await Item.implementation.create(itemData);
    } catch (err) {
        console.warn(`${SYSTEM_ID} | dropItemToWorld create failed`, err);
        return;
    }
    /* Remove from a container's content list first if it lived inside
     * one, then delete the embedded item. Container mutation runs
     * before delete so the sheet's Items collection stays consistent
     * during the removal cascade. */
    for (const container of source.items) {
        if (container.type !== "container") continue;
        const content = container.system?.content;
        if (!Array.isArray(content)) continue;
        if (content.includes(item.uuid) || content.includes(item.id)) {
            const next = content.filter(u => u !== item.uuid && u !== item.id);
            try { await container.update({ "system.content": next }); }
            catch (err) { console.warn(`${SYSTEM_ID} | dropItemToWorld container update failed`, err); }
        }
    }
    try { await item.delete(); }
    catch (err) { console.warn(`${SYSTEM_ID} | dropItemToWorld source delete failed`, err); }
}

async function handleDropItemToMap({ sourceActorUuid, itemId, sceneId, x, y, senderUserId }) {
    const source = await fromUuid(sourceActorUuid);
    if (!source) return;
    const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
    if (!authorizeSocket({ senderUserId }, source, OWNER)) {
        console.warn(`${SYSTEM_ID} | dropItemToMap refused — sender lacks OWNER on ${source?.name}`);
        return;
    }
    const item = source.items?.get?.(itemId);
    if (!item) return;
    const scene = game.scenes?.get?.(sceneId) ?? canvas?.scene ?? null;
    if (!scene) return;

    const itemData = item.toObject(false);
    delete itemData._id;
    itemData.ownership = { default: OWNER };
    // A per-item ground loot actor — art mirrors the item so the token reads.
    let lootActor = null;
    try {
        lootActor = await Actor.implementation.create({
            name: item.name,
            type: "loot",
            img: item.img,
            ownership: { default: OWNER },
            prototypeToken: { name: item.name, actorLink: false, disposition: 0, texture: { src: item.img } },
            items: [itemData]
        });
    } catch (err) { console.warn(`${SYSTEM_ID} | dropItemToMap actor create failed`, err); return; }
    if (!lootActor) return;

    // Place its token centered on the drop point.
    try {
        const gs = Number(scene.grid?.size) || 100;
        const tx = Math.round((Number(x) || 0) - gs / 2);
        const ty = Math.round((Number(y) || 0) - gs / 2);
        const tokenDoc = await lootActor.getTokenDocument({ x: tx, y: ty });
        await scene.createEmbeddedDocuments("Token", [tokenDoc.toObject()]);
    } catch (err) { console.warn(`${SYSTEM_ID} | dropItemToMap token place failed`, err); }

    // Remove from the source (detach from any container first), mirroring dropItemToWorld.
    for (const container of source.items) {
        if (container.type !== "container") continue;
        const content = container.system?.content;
        if (!Array.isArray(content)) continue;
        if (content.includes(item.uuid) || content.includes(item.id)) {
            try { await container.update({ "system.content": content.filter(u => u !== item.uuid && u !== item.id) }); }
            catch (err) { console.warn(`${SYSTEM_ID} | dropItemToMap container update failed`, err); }
        }
    }
    try { await item.delete(); }
    catch (err) { console.warn(`${SYSTEM_ID} | dropItemToMap source delete failed`, err); }
}

async function handleDropItemAsTile({ sourceActorUuid, itemId, sceneId, x, y, senderUserId }) {
    const source = await fromUuid(sourceActorUuid);
    if (!source) return;
    const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
    if (!authorizeSocket({ senderUserId }, source, OWNER)) {
        console.warn(`${SYSTEM_ID} | dropItemAsTile refused — sender lacks OWNER on ${source?.name}`);
        return;
    }
    const item = source.items?.get?.(itemId);
    if (!item) return;
    const scene = game.scenes?.get?.(sceneId) ?? canvas?.scene ?? null;
    if (!scene) return;

    const gs   = Number(scene.grid?.size) || 100;
    const size = Math.max(8, Math.round(gs * 0.5));   // 0.5-grid ground marker
    const itemData = item.toObject(false);
    delete itemData._id;
    itemData.ownership = { default: OWNER };
    const tileData = {
        texture: { src: item.img || "icons/svg/item-bag.svg" },
        width:  size,
        height: size,
        x: Math.round((Number(x) || 0) - size / 2),
        y: Math.round((Number(y) || 0) - size / 2),
        // Overhead so it sits ON the floor above the background, below tokens.
        sort: 0,
        // Shared loot-tile schema (also settable via the Tile Config UI):
        //   isLoot   — the "This is Loot" toggle
        //   lootData — a snapshot item (canvas drop); or lootUuid resolved at take
        flags: { [SYSTEM_ID]: { isLoot: true, lootData: itemData, lootName: item.name, lootImg: item.img, lootUuid: "" } }
    };
    try { await scene.createEmbeddedDocuments("Tile", [tileData]); }
    catch (err) { console.warn(`${SYSTEM_ID} | dropItemAsTile create failed`, err); return; }

    // Remove from the source (detach from any container first), mirroring dropItemToMap.
    for (const container of source.items) {
        if (container.type !== "container") continue;
        const content = container.system?.content;
        if (!Array.isArray(content)) continue;
        if (content.includes(item.uuid) || content.includes(item.id)) {
            try { await container.update({ "system.content": content.filter(u => u !== item.uuid && u !== item.id) }); }
            catch (err) { console.warn(`${SYSTEM_ID} | dropItemAsTile container update failed`, err); }
        }
    }
    try { await item.delete(); }
    catch (err) { console.warn(`${SYSTEM_ID} | dropItemAsTile source delete failed`, err); }
}

/* World item (Items sidebar) dropped on the map → a loot tile snapshot. Unlike
 * the actor-inventory path above, the source is a reusable world template, so
 * NOTHING is deleted — the sidebar item stays put. Authorized on the item
 * (OWNER) so a GM (or a player who owns the world item) can place it. */
export function emitDropWorldItemAsTile({ itemUuid, sceneId, x, y }) {
    const payload = { type: "dropWorldItemAsTile", itemUuid, sceneId, x, y, senderUserId: game.user?.id };
    if (game.user.isActiveGM) return handleDropWorldItemAsTile(payload);
    game.socket.emit(CHANNEL, payload);
}
/* Remove a corpse token from a scene (GM-routed — players can't delete tokens
 * they don't own). Guarded to CORPSES only (dead status / defeated combatant /
 * loot actor) so a player request can never delete a living token. Used when a
 * player takes the whole carcass — the body leaves the map. */
export function emitDeleteCorpseToken({ sceneId, tokenId }) {
    const payload = { type: "deleteCorpseToken", sceneId, tokenId, senderUserId: game.user?.id };
    if (game.user.isActiveGM) return handleDeleteCorpseToken(payload);
    game.socket.emit(CHANNEL, payload);
}
async function handleDeleteCorpseToken({ sceneId, tokenId, senderUserId }) {
    const scene = game.scenes?.get?.(sceneId) ?? canvas?.scene ?? null;
    if (!scene) return;
    const tok = scene.tokens?.get?.(tokenId);
    if (!tok) return;   // already gone
    const sender = senderUserId ? game.users?.get?.(senderUserId) : game.user;
    const actor = tok.actor;
    const isCorpse = !!(actor?.statuses?.has?.("dead")
        || actor?.type === "loot"
        || tok.combatant?.isDefeated
        || scene.combats?.some?.(c => c.combatants?.some?.(cb => cb.tokenId === tokenId && cb.isDefeated)));
    // GMs may remove any token; a non-GM request is honored only for corpses.
    if (!sender?.isGM && !isCorpse) {
        console.warn(`${SYSTEM_ID} | deleteCorpseToken refused — ${tok.name} is not a corpse`);
        return;
    }
    try { await scene.deleteEmbeddedDocuments("Token", [tokenId]); }
    catch (err) { console.warn(`${SYSTEM_ID} | deleteCorpseToken failed`, err); }
}

async function handleDropWorldItemAsTile({ itemUuid, sceneId, x, y, senderUserId }) {
    const item = await fromUuid(itemUuid);
    if (!item || item.documentName !== "Item") return;
    const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
    if (!authorizeSocket({ senderUserId }, item, OWNER)) {
        console.warn(`${SYSTEM_ID} | dropWorldItemAsTile refused — sender lacks OWNER on ${item?.name}`);
        return;
    }
    const scene = game.scenes?.get?.(sceneId) ?? canvas?.scene ?? null;
    if (!scene) return;

    const gs   = Number(scene.grid?.size) || 100;
    const size = Math.max(8, Math.round(gs * 0.5));   // 0.5-grid ground marker
    const itemData = item.toObject(false);
    delete itemData._id;
    itemData.ownership = { default: OWNER };
    const tileData = {
        texture: { src: item.img || "icons/svg/item-bag.svg" },
        width:  size,
        height: size,
        // Tiles use a CENTER texture anchor (0.5), so document.x/y IS the image
        // center — drop it straight on the cursor point (no half-size offset).
        x: Math.round(Number(x) || 0),
        y: Math.round(Number(y) || 0),
        sort: 0,
        flags: { [SYSTEM_ID]: { isLoot: true, lootData: itemData, lootName: item.name, lootImg: item.img, lootUuid: "" } }
    };
    try { await scene.createEmbeddedDocuments("Tile", [tileData]); }
    catch (err) { console.warn(`${SYSTEM_ID} | dropWorldItemAsTile create failed`, err); }
}

const _tileClaims = new Set();   // tile ids currently being taken (GM-side dedupe)
async function handleTakeTileItem({ sceneId, tileId, targetActorUuid, senderUserId }) {
    // Two players clicking the same tile in one tick would both pass the
    // exists-check before either delete resolves → double loot. The GM runs
    // single-threaded, so a synchronous claim set prevents concurrent processing.
    if (_tileClaims.has(tileId)) return;
    _tileClaims.add(tileId);
    try {
        await _doTakeTileItem({ sceneId, tileId, targetActorUuid, senderUserId });
    } finally {
        _tileClaims.delete(tileId);
    }
}
async function _doTakeTileItem({ sceneId, tileId, targetActorUuid, senderUserId }) {
    const scene  = game.scenes?.get?.(sceneId) ?? canvas?.scene ?? null;
    const target = await fromUuid(targetActorUuid);
    if (!scene || !target) return;
    const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
    // The taker must OWN the destination (their own character).
    if (!authorizeSocket({ senderUserId }, target, OWNER)) {
        console.warn(`${SYSTEM_ID} | takeTileItem refused — sender lacks OWNER on ${target?.name}`);
        return;
    }
    const tile = scene.tiles?.get?.(tileId);
    if (!tile) return;
    const f = tile.flags?.[SYSTEM_ID] ?? {};
    if (!f.isLoot) return;
    // Prefer a snapshot (canvas-dropped); else resolve the config-assigned uuid.
    let data = f.lootData ? foundry.utils.duplicate(f.lootData) : null;
    if (!data && f.lootUuid) {
        try { const src = await fromUuid(f.lootUuid); if (src?.toObject) data = src.toObject(false); }
        catch (_) { data = null; }
    }
    if (!data) return;
    delete data._id;
    data.ownership = { default: OWNER };
    try { await target.createEmbeddedDocuments("Item", [data]); }
    catch (err) { console.warn(`${SYSTEM_ID} | takeTileItem create failed`, err); return; }
    try { await tile.delete(); }
    catch (err) { console.warn(`${SYSTEM_ID} | takeTileItem tile delete failed`, err); }
}

const LOOT_COIN_KEYS = ["crown", "oren", "bizant", "ducat", "lintar", "floren"];

/* Transfer N coins of `coin` from a loot actor to a recipient actor.
 * Guards: source must be type "loot" (blocks a hostile client from
 * shuffling coins between arbitrary actors); coin must be a known
 * denomination; move quantity is clamped to what's actually on the pile. */
function handleTransferLootCurrency(payload) {
    return serializeByKey(`coin:${payload?.sourceActorUuid}:${payload?.coin}`, () => _doTransferLootCurrency(payload));
}
async function _doTransferLootCurrency({ sourceActorUuid, targetActorUuid, coin, quantity, fromUserId }) {
    const source = await fromUuid(sourceActorUuid);
    const target = await fromUuid(targetActorUuid);
    if (!source || !target) return;
    /* Loot piles AND corpses (defeated characters / monsters) can be relieved
     * of coin — map-loot pulls a downed PC's purse. Live-PC theft still needs a
     * grabbable (defeated) token on the client side. */
    if (!["loot", "character", "monster"].includes(source.type)) {
        console.warn(`${SYSTEM_ID} | transferLootCurrency refused — source ${source?.name} has no lootable purse`);
        return;
    }
    if (!LOOT_COIN_KEYS.includes(coin)) return;
    const available = Math.max(0, Number(source.system?.currency?.[coin]) || 0);
    const want = Math.max(0, Math.floor(Number(quantity) || 0));
    const move = Math.min(available, want);
    if (move <= 0) return;
    const targetCur = Math.max(0, Number(target.system?.currency?.[coin]) || 0);
    try {
        await source.update({ [`system.currency.${coin}`]: available - move });
        await target.update({ [`system.currency.${coin}`]: targetCur + move });
    } catch (err) {
        console.warn(`${SYSTEM_ID} | transferLootCurrency: update failed`, err);
        return;
    }
    try {
        const fromUser = fromUserId ? game.users?.get?.(fromUserId) : null;
        const sender = fromUser?.name ? fromUser.name : target.name;
        await ChatMessage.create({
            speaker: ChatMessage.implementation.getSpeaker({ actor: source }),
            content: tFormat(
                "WITCHER.Setup.SocketHook.Chat.TookCoin",
                { sender: escAttr(sender), move, coin: escAttr(coin), plural: move === 1 ? "" : t("WITCHER.Setup.SocketHook.Text.CoinPlural", "s"), source: escAttr(source.name) },
                "<div class=\"wdm-gift-card\"><i class=\"fa-solid fa-coins\"></i> <strong>{sender}</strong> took <strong>{move} {coin}{plural}</strong> from <strong>{source}</strong>.</div>"
            )
        });
    } catch (err) { console.warn(`${SYSTEM_ID} | transferLootCurrency: chat post failed`, err); }
}

/* Sweep every top-level item + every coin off a loot actor into the
 * recipient. Items route through handleGiftItem (full stacks, container
 * subtree preserved). Currency is patched in a single update per side. */
function handleTakeAllLoot(payload) {
    // Serialize the WHOLE sweep by source: its currency pass writes source
    // directly (not via the currency handler), so two concurrent Take-alls could
    // otherwise both duplicate the coin. The per-item gifts inside also serialize
    // on their own `gift:` keys.
    return serializeByKey(`takeall:${payload?.sourceActorUuid}`, () => _doTakeAllLoot(payload));
}
async function _doTakeAllLoot({ sourceActorUuid, targetActorUuid, fromUserId }) {
    const source = await fromUuid(sourceActorUuid);
    const target = await fromUuid(targetActorUuid);
    if (!source || !target) return;
    if (source.type !== "loot") {
        console.warn(`${SYSTEM_ID} | takeAllLoot refused — source ${source?.name} is not a loot actor`);
        return;
    }
    /* Snapshot ids BEFORE mutating — handleGiftItem deletes items on
     * source as it goes, which would invalidate a live iterator. */
    const topItemIds = (source.items?.contents ?? [])
        .filter(i => i && !i.system?.isStored)
        .map(i => i.id);
    for (const id of topItemIds) {
        const item = source.items?.get?.(id);
        if (!item) continue;
        const qty = Math.max(1, Number(item.system?.quantity) || 1);
        try {
            await handleGiftItem({ sourceActorUuid, targetActorUuid, itemId: id, quantity: qty, fromUserId });
        } catch (err) { console.warn(`${SYSTEM_ID} | takeAllLoot: gift ${id} failed`, err); }
    }

    const sCur = source.system?.currency ?? {};
    const tCur = target.system?.currency ?? {};
    const sourcePatch = {};
    const targetPatch = {};
    let anyCoin = false;
    for (const k of LOOT_COIN_KEYS) {
        const v = Math.max(0, Number(sCur[k]) || 0);
        if (v <= 0) continue;
        anyCoin = true;
        sourcePatch[`system.currency.${k}`] = 0;
        targetPatch[`system.currency.${k}`] = (Math.max(0, Number(tCur[k]) || 0)) + v;
    }
    if (anyCoin) {
        try {
            await source.update(sourcePatch);
            await target.update(targetPatch);
        } catch (err) { console.warn(`${SYSTEM_ID} | takeAllLoot: currency sweep failed`, err); }
    }

    try {
        const fromUser = fromUserId ? game.users?.get?.(fromUserId) : null;
        const sender = fromUser?.name ? fromUser.name : target.name;
        await ChatMessage.create({
            speaker: ChatMessage.implementation.getSpeaker({ actor: source }),
            content: tFormat(
                "WITCHER.Setup.SocketHook.Chat.TookEverything",
                { sender: escAttr(sender), source: escAttr(source.name) },
                "<div class=\"wdm-gift-card\"><i class=\"fa-solid fa-hand-holding-dollar\"></i> <strong>{sender}</strong> took everything from <strong>{source}</strong>.</div>"
            )
        });
    } catch (err) { console.warn(`${SYSTEM_ID} | takeAllLoot: chat post failed`, err); }
}

/* Walk `container.system.content` (and nested containers) DFS, returning
 * the ordered list of embedded items on `source` that make up the whole
 * container subtree — root first, children after. Skips content refs
 * that don't resolve to items on this actor (stale UUIDs from moves that
 * left dangling references — see the pruning in moveItemToContainer). */
/* Resolve a container content-ref to the item ON `source`. Mirrors the UI's
 * resolveContentRef (which works) but always maps back to the source actor's
 * OWN copy (needed to snapshot + delete). Strategies, in order:
 *   1. bare id / trailing-id lookup on source.items
 *   2. exact uuid / id scan of source.items
 *   3. global fromUuidSync(ref) → then map that item's id back onto source.
 * A corpse is usually an UNLINKED token actor whose synthetic items keep the
 * base item id but carry a token-scoped uuid, while the ref still holds the
 * base uuid — so a plain uuid scan misses. */
function resolveContentOnSource(source, ref) {
    if (!ref || !source) return null;
    const refId = (typeof ref === "string" && ref.includes(".")) ? ref.split(".").pop() : ref;
    let child = source.items.get?.(ref) ?? source.items.get?.(refId) ?? null;
    if (!child) child = source.items.find(i => i.uuid === ref || i.id === ref || i.id === refId) ?? null;
    if (!child) {
        let g = null; try { g = (typeof fromUuidSync === "function") ? fromUuidSync(ref) : null; } catch (_) { g = null; }
        if (g?.id) child = source.items.get?.(g.id) ?? source.items.find(i => i.id === g.id) ?? null;
    }
    return child;
}

function collectContainerSubtree(source, root) {
    const out = [];
    const seen = new Set();
    const walk = (it) => {
        if (!it || seen.has(it.id)) return;
        seen.add(it.id);
        out.push(it);
        if (it.type !== "container") return;
        for (const ref of it.system?.content ?? []) {
            const child = resolveContentOnSource(source, ref);
            if (child) walk(child);
        }
    };
    walk(root);
    return out;
}

/* Gift a container and its whole content subtree from `source` to
 * `target`. Returns true on success, false on failure (source untouched).
 *
 * Order matters:
 *   1. Snapshot the subtree on source (via toObject).
 *   2. Batch-create clones on target — collects the new UUIDs.
 *   3. Rewrite each new container's `system.content` to point at the
 *      new sibling UUIDs (the snapshots still hold the OLD source
 *      UUIDs). Done in a single update per container so target sheets
 *      only re-render once.
 *   4. Delete the source subtree — children before parents so a
 *      container's content-array validation can't complain about
 *      dangling refs during the delete cascade. */
async function giftContainerTree(source, target, rootContainer) {
    const subtree = collectContainerSubtree(source, rootContainer);
    if (!subtree.length) return false;

    /* Snapshot each container's content array FROM THE SOURCE — the
     * preCreateItem hook in chrome/inventory.js clears
     * `system.content` on every new container to stop compendium drops
     * from carrying over a template's stale refs. That hook can't tell
     * a gift from a fresh compendium drop, so reading content off the
     * newly-created doc would come back empty and we'd skip the rewrite.
     * Snapshot BY SOURCE ID (not by index) so we're robust against any
     * Foundry version reordering the batch return from
     * createEmbeddedDocuments. */
    const contentBySrcId = new Map();
    for (const it of subtree) {
        if (it.type !== "container") continue;
        contentBySrcId.set(it.id, (it.system?.content ?? []).slice());
    }

    /* Stamp each proto with a temp flag we can use to correlate the
     * returned doc back to its source item — the map is torn down on
     * the target afterwards. This avoids relying on batch-return order,
     * which Foundry doesn't guarantee in writing. */
    const FLAG_MOD = SYSTEM_ID;
    const FLAG_KEY = "giftSrcId";
    const protos = subtree.map((it, idx) => {
        const p = it.toObject();
        delete p._id;
        p.flags = p.flags ?? {};
        p.flags[FLAG_MOD] = { ...(p.flags[FLAG_MOD] ?? {}), [FLAG_KEY]: it.id };
        /* Root of the gift: force clean placement flags. If the giver had
         * the container itself STORED inside another bag (e.g. gifting a
         * small pouch that lived inside a backpack) or EQUIPPED (a pack
         * they wore), those flags would ride along via toObject and leave
         * the recipient's root container invisible — isStored hides it
         * from the loose grid, and no container on the RECIPIENT claims
         * it in `system.content`, so it renders nowhere. Reset both.
         * Children keep their source flags — the content-rewrite loop
         * asserts isStored=true on them explicitly. */
        if (idx === 0) {
            p.system = { ...(p.system ?? {}), isStored: false, equipped: false };
        }
        return p;
    });

    let created;
    try {
        created = await target.createEmbeddedDocuments("Item", protos);
    } catch (err) {
        console.error(`${SYSTEM_ID} | handleGiftItem: target container create failed`, err);
        ui.notifications?.error(tFormat("WITCHER.Setup.SocketHook.Notify.GiftFailedOnXXSee", { target: target.name, val0: err?.message ?? err }, "Gift failed on {target}: {val0} (see console)."));
        return false;
    }
    if (!created || created.length !== subtree.length) {
        const msg = tFormat("WITCHER.Setup.SocketHook.Notify.GiftPartialCreated", { created: created?.length ?? 0, total: subtree.length, target: target.name }, `Gift partial-created ${created?.length ?? 0}/${subtree.length} items on ${target.name} — aborting so the giver's copy isn't lost.`);
        console.error(`${SYSTEM_ID} | handleGiftItem: ${msg}`);
        ui.notifications?.error(msg);
        /* Roll back what did land, so the giver keeps their copy and the
         * recipient isn't left holding a partial tree. */
        if (Array.isArray(created) && created.length) {
            try { await target.deleteEmbeddedDocuments("Item", created.map(c => c.id)); }
            catch (rbErr) { console.warn(`${SYSTEM_ID} | rollback delete failed`, rbErr); }
        }
        return false;
    }

    /* Map old (source) ids + uuids → new (target) uuid so we can rewrite
     * each container's content array without depending on the ref format.
     *
     * Correlate by the giftSrcId flag stamped on protos rather than
     * assuming batch-return order. Build the target UUID DETERMINISTICALLY
     * from the actor uuid + item id — `Document.uuid` is a getter that
     * walks `parent.uuid` and re-derives on every access; right after
     * createEmbeddedDocuments returns, we've seen intermittent cases where
     * either the getter returned a temporarily-inconsistent string or
     * `created.find(c => c.uuid === ref)` failed identity due to getter
     * re-evaluation. A hand-built `Actor.<id>.Item.<id>` is a plain
     * string and matches everywhere Foundry stores content refs. */
    const targetUuidOf = (id) => `${target.uuid}.Item.${id}`;
    const newIdByOldRef = new Map();  // old uuid or id  -> new item id
    const oldIdByNewId  = new Map();  // new item id     -> old (source) id
    for (const newItem of created) {
        if (!newItem?.id) {
            console.error(`${SYSTEM_ID} | handleGiftItem: created item missing id — abort rewrite`);
            ui.notifications?.error(tFormat("WITCHER.Setup.SocketHook.Notify.GiftFailedOnXInternalId", { target: target.name }, "Gift failed on {target}: internal id missing on new item (see console)."));
            return false;
        }
        const srcId = newItem.getFlag?.(FLAG_MOD, FLAG_KEY);
        if (!srcId) continue;
        const oldItem = subtree.find(it => it.id === srcId);
        if (!oldItem) continue;
        newIdByOldRef.set(oldItem.uuid, newItem.id);
        newIdByOldRef.set(oldItem.id,   newItem.id);
        oldIdByNewId.set(newItem.id, oldItem.id);
    }

    /* Rewrite each new container's content per-item. Per-doc updates keep
     * the flow explicit and let a single failing update log without
     * poisoning the whole batch — a batch updateEmbeddedDocuments that
     * fails one spec silently drops ALL of them on some Foundry paths. */
    for (const newItem of created) {
        /* Only containers hold content — skip weapons/ammo/etc even if
         * the batch happens to include them. */
        if (newItem.type !== "container") continue;
        const srcId = oldIdByNewId.get(newItem.id);
        if (!srcId) continue;
        const orig = contentBySrcId.get(srcId);
        if (!orig || !orig.length) continue;
        /* Look up each content ref against the old→new id map. The map is keyed
         * by the SOURCE item's uuid (token-scoped on a corpse, e.g.
         * Scene.…Token.…Actor.…Item.<id>) and bare id, but `content` refs are
         * stored in BASE-actor form (Actor.<base>.Item.<id>) — which matches
         * NEITHER key. So fall back to the ref's trailing item id, which equals
         * the source item's id (a key). Without this the rewrite maps every
         * child to nothing and the transferred container arrives empty. */
        const refToNewId = (ref) => {
            if (newIdByOldRef.has(ref)) return newIdByOldRef.get(ref);
            const refId = (typeof ref === "string" && ref.includes(".")) ? ref.split(".").pop() : ref;
            return newIdByOldRef.get(refId);
        };
        const newIds = orig.map(refToNewId).filter(Boolean);
        const expected = orig.filter(ref => refToNewId(ref) != null).length;
        if (newIds.length !== expected) {
            console.warn(`${SYSTEM_ID} | handleGiftItem: uuidMap miss on ${newItem.name} — ${newIds.length}/${expected} children mapped`);
        }
        if (!newIds.length) continue;
        const newContent = newIds.map(targetUuidOf);
        try {
            await newItem.update({ "system.content": newContent });
        } catch (err) {
            console.error(`${SYSTEM_ID} | handleGiftItem: content rewrite failed on ${newItem.name}`, err);
            ui.notifications?.error(tFormat("WITCHER.Setup.SocketHook.Notify.GiftLinkContentsFailed", { target: target.name, item: newItem.name }, `Gift to ${target.name}: '${newItem.name}' failed to link contents (see console).`));
            continue;
        }
        /* Verify the update took. Read from BOTH the held reference and
         * the live Collection lookup — v14 has occasionally shown these
         * diverge briefly right after an embedded update (Collection is
         * eventually consistent, held ref reflects the write immediately).
         * If either shows the content, we accept it. */
        const liveByRef  = Array.isArray(newItem?.system?.content) ? newItem.system.content : [];
        const liveByGet  = target.items.get(newItem.id);
        const liveByColl = Array.isArray(liveByGet?.system?.content) ? liveByGet.system.content : [];
        const wroteLen   = Math.max(liveByRef.length, liveByColl.length);
        if (wroteLen !== newContent.length) {
            console.error(
                `${SYSTEM_ID} | handleGiftItem: content rewrite dropped refs on ${newItem.name} (type=${newItem.type}, id=${newItem.id})`
                + ` — wanted ${newContent.length}, saved ${wroteLen}.`
                + ` newContent=${JSON.stringify(newContent)}`
                + ` sourceContent=${JSON.stringify(orig)}`
                + ` liveByRef=${JSON.stringify(liveByRef)}`
                + ` liveByColl=${JSON.stringify(liveByColl)}`
            );
            ui.notifications?.error(tFormat("WITCHER.Setup.SocketHook.Notify.GiftWrongContents", { target: target.name, item: newItem.name }, `Gift to ${target.name}: '${newItem.name}' saved with wrong contents (see console).`));
        }
        /* Belt-and-braces: every child referenced by this container must
         * carry isStored=true, else it surfaces in the loose grid instead
         * of nested inside the bag. toObject preserves the source flag,
         * but a preCreate hook or schema default can flip it. */
        for (const childId of newIds) {
            const child = target.items.get(childId);
            if (child && child.system?.isStored !== true) {
                try { await child.update({ "system.isStored": true }); }
                catch (err) { console.warn(`${SYSTEM_ID} | handleGiftItem: isStored assert failed on ${child.name}`, err); }
            }
        }
    }

    /* Tear down the temp giftSrcId flag we stamped for cross-batch
     * correlation — it has no runtime meaning on the recipient, and
     * leaving it around would confuse a subsequent gift of the same
     * container. Non-fatal if any single unset fails. */
    for (const newItem of created) {
        try { await newItem.unsetFlag?.(FLAG_MOD, FLAG_KEY); }
        catch (err) { /* ignore — cosmetic cleanup */ }
    }

    /* If the gifted root itself lived INSIDE another container on the
     * source (e.g. a small pouch stored in a backpack), that outer
     * container's `system.content` still references the root's now-doomed
     * uuid/id. Scrub the ref BEFORE the delete so the outer bag doesn't
     * point at a dangling id and confuse content resolvers. */
    const rootId   = rootContainer.id;
    const rootUuid = rootContainer.uuid;
    const outerBags = source.items?.filter?.(it =>
        it.type === "container" && Array.isArray(it.system?.content)
        && it.system.content.some(ref => ref === rootId || ref === rootUuid)
    ) ?? [];
    for (const bag of outerBags) {
        const filtered = bag.system.content.filter(ref => ref !== rootId && ref !== rootUuid);
        try { await bag.update({ "system.content": filtered }); }
        catch (err) { console.warn(`${SYSTEM_ID} | handleGiftItem: outer-bag scrub failed on ${bag.name}`, err); }
    }

    /* Delete leaves first so a container isn't asked to hold a
     * newly-invalid content ref mid-cascade. */
    const idsBottomUp = subtree.map(it => it.id).reverse();
    try {
        await source.deleteEmbeddedDocuments("Item", idsBottomUp);
    } catch (err) {
        /* Non-fatal: the target already has the items. Log so the GM
         * can clean up the source if this fires. */
        console.warn(`${SYSTEM_ID} | handleGiftItem: source subtree delete failed`, err);
    }
    /* Verify the source actually lost them, and sweep any survivors one by one.
     * A batch deleteEmbeddedDocuments can quietly drop ids on synthetic
     * (unlinked-token) actors; a per-item delete is the reliable fallback. */
    const survivors = idsBottomUp.filter(id => source.items?.get?.(id));
    for (const id of survivors) {
        try { await source.items.get(id)?.delete(); }
        catch (err) { console.warn(`${SYSTEM_ID} | handleGiftItem: retry delete failed for ${id}`, err); }
    }
    if (idsBottomUp.some(id => source.items?.get?.(id))) {
        console.warn(`${SYSTEM_ID} | handleGiftItem: ${idsBottomUp.filter(id => source.items?.get?.(id)).length} item(s) could not be removed from ${source.name}`);
    }

    /* Force a target sheet re-render — per-doc updates each fire an
     * `updateItem` hook, but the sheet's derived state (which container
     * has which contents) resolves through `resolveContainerContents`
     * against the ACTOR's item collection, and that collection view
     * doesn't always invalidate cleanly mid-cascade. A final explicit
     * render seals it. Only if the sheet's open — no side effect. */
    if (target.sheet?.rendered) {
        try { target.sheet.render(false); } catch (_) { /* not fatal */ }
    }
    return true;
}

/* -------------------------------------------------------------------------- */
/* Defense pre-roll prompt — cross-client request/response                    */
/* -------------------------------------------------------------------------- */

/* Pending requests on the ATTACKER's client, keyed by requestId. Resolved
 * when the matching defenseResponse comes back, or by timeout. */
const _pendingDefenseRequests = new Map();

/* ── Magic interception, resolved by the engine host ──────────────────────
 *
 * The ward subscription list lives in one browser (the active GM's — see
 * `magic/wardRegistry.mjs`), because a module-level array cannot be anywhere
 * else. Attacks are resolved on the ATTACKER's client, which has no such list.
 * This is the hop between them: the attacker asks, the host runs the ward's
 * tree against its own subscriptions, and only the fields a ward is entitled
 * to change come back.
 *
 * Fails OPEN. Every failure path — no GM, a timeout, an error inside the tree
 * — resolves `null`, and `hostIntercept` then leaves the attack exactly as it
 * was. A ward that cannot answer must not be able to swallow the attack it was
 * supposed to stop, and must not hang the attacker's turn waiting.
 */
const _pendingInterceptions = new Map();
const INTERCEPT_TIMEOUT_MS = 5000;

export async function requestInterception({ kind, targetUuid, ...rest }) {
    if (!targetUuid) return null;
    /* No active GM: nobody holds the list, so there is nothing to ask. */
    const gm = game.users?.find?.(u => u.isGM && u.active) ?? null;
    if (!gm) return null;

    const requestId = `mint-${foundry.utils.randomID()}`;
    const sentAt = performance.now();
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            _pendingInterceptions.delete(requestId);
            /* LOUD, because this is not a clean failure. The host may already
             * have spent the ward's charge before we gave up — the attack then
             * resolves unwarded while the defender has paid for it. */
            console.warn(`${SYSTEM_ID} | interception request timed out after `
                + `${Math.round(performance.now() - sentAt)}ms; attack resolves UNWARDED `
                + `(the host may still have spent the ward)`);
            resolve(null);
        }, INTERCEPT_TIMEOUT_MS);
        _pendingInterceptions.set(requestId, { resolve, timer, sentAt });
        game.socket.emit(CHANNEL, {
            type: "magicInterceptRequest",
            senderUserId: game.user?.id,
            requestId, kind, targetUuid, ...rest
        });
    });
}

function handleInterceptionResponse(data) {
    const pending = _pendingInterceptions.get(data.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    _pendingInterceptions.delete(data.requestId);
    /* An attack waits on this, so how long it took is a UX number, not a
     * curiosity. Logged only when it is slow enough for a player to feel. */
    const ms = Math.round(performance.now() - (pending.sentAt ?? performance.now()));
    if (ms > 250) console.log(`${SYSTEM_ID} | interception answered in ${ms}ms`);
    pending.resolve(data.verdict ?? null);
}

/**
 * The magic side registers what to run; this file never imports it.
 *
 * The handler used to `await import("../magic/…")` on every request, and it
 * HUNG there — `adapter.mjs` and friends sit on the other side of a module
 * graph this file is already part of, and resolving them from inside a socket
 * handler never settled. The host received the request, resolved the target,
 * and then stopped; the attacker timed out and resolved the attack unwarded
 * while the ward had already been asked to pay. Found only with two clients —
 * a single-client game never takes this path at all.
 *
 * Injecting the runner at `ready` also takes four module resolutions off the
 * hot path of every warded attack, which is the difference between a ward
 * being correct and a ward being usable.
 */
let _interceptionRunner = null;
export function setInterceptionRunner(fn) { _interceptionRunner = fn; }

async function handleInterceptionRequest(data) {
    const reply = (verdict) => game.socket.emit(CHANNEL, {
        type: "magicInterceptResponse",
        recipientUserId: data.senderUserId,
        requestId: data.requestId,
        verdict: verdict ?? null
    });
    if (!_interceptionRunner) { reply(null); return; }
    let verdict = null;
    try { verdict = await _interceptionRunner(data); }
    catch (err) {
        console.warn(`${SYSTEM_ID} | interception on the host failed`, err);
        verdict = null;
    }
    reply(verdict);
}


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
    defenderActor, attackerName, weaponName, weaponImg, engagementId = "", timeoutMs = null,
    attackKind = "normal", shotIndex = 1, totalShots = 1, disallowedItemIds = [],
    disallowedActions = [],
    attackerDamageFlags = null, attackHitLocation = null, allowedDefenses = null,
    requiresShieldCover = false, attackerUuid = ""
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
            attackKind, shotIndex, totalShots, disallowedItemIds, disallowedActions,
            attackerDamageFlags, allowedDefenses, requiresShieldCover, attackHitLocation
        });
        /* Stamp attackKind onto the choice so runDefenseChoice can gate on
         * disarm/trip for Knightly Stance without another parameter. */
        choice.attackKind = attackKind;
        const packet = await runDefenseChoice(defenderActor, choice, engagementId, attackerDamageFlags, attackHitLocation, attackerUuid);
        return { ...choice, ...packet };
    }

    const requestId = `def-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve) => {
        /* Same opt-in timeout policy as the dialog: only set a fallback
         * timer when the caller asked for one. Null lets the promise stay
         * open until the defender's client sends their response — no
         * silent "Take it" from a table pause / rules lookup. */
        const timer = (typeof timeoutMs === "number" && timeoutMs > 0)
            ? setTimeout(() => {
                _pendingDefenseRequests.delete(requestId);
                resolve({ action: "none", timedOut: true });
            }, timeoutMs + 2000)          // a touch longer than the dialog's own timeout
            : null;
        _pendingDefenseRequests.set(requestId, { resolve, timer });
        game.socket.emit(CHANNEL, {
            type: "defenseRequest",
            recipientUserId: owner.id,
            senderUserId: game.user?.id,
            requestId,
            engagementId,
            attackerName, weaponName, weaponImg,
            attackKind, shotIndex, totalShots,
            disallowedItemIds, disallowedActions,
            attackerDamageFlags,
            attackHitLocation,
            allowedDefenses,
            requiresShieldCover,
            attackerUuid,
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
async function runDefenseChoice(defenderActor, choice, engagementId, attackerDamageFlags = null, attackHitLocation = null, attackerUuid = "") {
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
            /* Natural-weapon defense (claws/horns — race toggles) is ITEM-LESS:
             * it rolls REF + Brawling like the unarmed Body Block, but keeps the
             * parry/block ACTION so the attack card resolves it as a real parry
             * (staggers the attacker) or a full block (negates the hit). The 1 HP
             * block cost is charged attacker-side at the block-success step. */
            if (choice.itemId === "natural" && typeof defenderActor.defendBySkill === "function") {
                const label = choice.action === "parry"
                    ? t("WITCHER.App.DefensePromptDialog.Dialog.Button.ParryNatural", "Parry (Natural Weapon)")
                    : t("WITCHER.App.DefensePromptDialog.Dialog.Button.BlockNatural", "Block (Natural Weapon)");
                return pick(await defenderActor.defendBySkill("brawling", { label, engagementId, extraMod, attackerDamageFlags, attackKind: choice.attackKind, attackerUuid }));
            }
            /* Base (stat-block) monster attack toggled Parry/Block — ITEM-LESS
             * like a natural weapon, but rolls the ATTACK's own skill (or, for a
             * flat-bonus stat block, 1d10 + flatBonus via baseOverride). The
             * parry/block ACTION is preserved, so the attacker card staggers
             * (parry) or negates (block) exactly as a weapon defense would. */
            if (typeof choice.itemId === "string" && choice.itemId.startsWith("base:")
                    && typeof defenderActor.defendBySkill === "function") {
                const idx = Number(choice.itemId.slice(5));
                const atk = defenderActor.system?.combat?.attacks?.[idx];
                if (atk) {
                    const label = atk.name || (choice.action === "parry"
                        ? t("WITCHER.App.DefensePromptDialog.Dialog.Button.ParryNatural", "Parry")
                        : t("WITCHER.App.DefensePromptDialog.Dialog.Button.BlockNatural", "Block"));
                    /* Roll the SAME model the attack uses (see monsterVirtualWeapon):
                     * 1d10 + stat + the attack's skill, with WA folded into the
                     * situational modifier so the parry/block lands on the same
                     * number the attack would. */
                    return pick(await defenderActor.defendBySkill(atk.skill || "melee", {
                        label, engagementId, attackerDamageFlags,
                        attackKind: choice.attackKind, attackerUuid,
                        extraMod: extraMod + (Number(atk.weaponAccuracy) || 0)
                    }));
                }
            }
            const item = defenderActor.items?.get?.(choice.itemId);
            if (item && typeof defenderActor.defendWith === "function") {
                return pick(await defenderActor.defendWith(item, choice.action, { engagementId, extraMod, attackerDamageFlags, attackHitLocation, attackerUuid }));
            }
            console.warn(`${SYSTEM_ID} | defense prompt: ${choice.action} chosen but no eligible item`);
        } else if (choice.action === "dodge") {
            if (typeof defenderActor.defendBySkill === "function") {
                return pick(await defenderActor.defendBySkill("dodge", { label: t("WITCHER.Common.Dodge", "Dodge"), engagementId, extraMod, attackerDamageFlags, attackKind: choice.attackKind, attackerUuid }));
            }
        } else if (choice.action === "reposition") {
            if (typeof defenderActor.defendBySkill === "function") {
                return pick(await defenderActor.defendBySkill("athletics", { label: t("WITCHER.Setup.SocketHook.Dialog.Button.Reposition", "Reposition"), engagementId, reposition: true, extraMod, attackerDamageFlags, attackKind: choice.attackKind, attackerUuid }));
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
                /* Grapple defense with a Grappling weapon uses THAT weapon's
                 * own skill (the *** rule: grapple actions/defenses can be done
                 * with a grappling weapon) instead of unarmed Brawling. Only
                 * for a grapple (choice.attackKind === "grapple"); a normal
                 * Body Block stays unarmed Brawling. */
                let _defSkill = "brawling";
                let _defLabel = t("WITCHER.Setup.SocketHook.Dialog.Button.BodyBlock", "Body Block");
                /* The defender EXPLICITLY chose which brawl defense to roll:
                 *   brawlBlock          → unarmed Brawling (this default).
                 *   brawlBlock:<itemId> → wrestle with that Grappling weapon,
                 *                         rolling the weapon's own skill.
                 * We honour the choice (via choice.itemId) rather than auto-
                 * swapping to a weapon — unarmed Brawling stays a valid option. */
                if (choice.itemId && GRAPPLE_DEFENSE_KINDS.has(choice.attackKind)) {
                    const gw = defenderActor.items?.get?.(choice.itemId);
                    const sk = gw ? grappleWeaponSkill(gw) : null;
                    if (gw && sk) { _defSkill = sk; _defLabel = gw.name; }
                }
                return pick(await defenderActor.defendBySkill(_defSkill, { label: _defLabel, engagementId, brawlBlock: true, extraMod, attackerDamageFlags, attackKind: choice.attackKind, attackerUuid }));
            }
        } else if (choice.action === "spellCasting") {
            /* Spell Casting — WILL + Spell Casting skill roll. Fires when the
             * incoming magic declared "spellcasting" in its defense clause —
             * Dispel is the only RAW user, countering a spell with an opposed
             * cast. Same defendBySkill path as Resist Magic so the roll folds
             * into the attacker's card and the engagement flag lands. */
            if (typeof defenderActor.defendBySkill === "function") {
                return pick(await defenderActor.defendBySkill("spellcast", { label: t("WITCHER.Setup.SocketHook.Dialog.Button.SpellCasting", "Spell Casting"), engagementId, extraMod, attackerDamageFlags, attackKind: choice.attackKind, attackerUuid }));
            }
        } else if (choice.action === "resistMagic") {
            /* Resist Magic — WILL + Resist Magic skill roll. Fires when
             * the incoming spell / hex declared "resistmagic" in its
             * defense clause and the defender picked the Resist Magic
             * button on the prompt. Same defendBySkill path as
             * dodge / reposition / brawlBlock so the roll folds into
             * the attacker's chat card and the engagement flag lands. */
            if (typeof defenderActor.defendBySkill === "function") {
                return pick(await defenderActor.defendBySkill("resistmagic", { label: t("WITCHER.Setup.SocketHook.Dialog.Button.ResistMagic", "Resist Magic"), engagementId, extraMod, attackerDamageFlags, attackKind: choice.attackKind, attackerUuid }));
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
            timeoutMs:    data.timeoutMs ?? null,
            attackKind:        data.attackKind        ?? "normal",
            shotIndex:         data.shotIndex         ?? 1,
            totalShots:        data.totalShots        ?? 1,
            disallowedItemIds: Array.isArray(data.disallowedItemIds) ? data.disallowedItemIds : [],
            disallowedActions: Array.isArray(data.disallowedActions) ? data.disallowedActions : [],
            attackerDamageFlags:  data.attackerDamageFlags ?? null,
            allowedDefenses:      data.allowedDefenses  ?? null,
            requiresShieldCover:  !!data.requiresShieldCover,
            attackHitLocation:    data.attackHitLocation ?? null
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
        const packet = await runDefenseChoice(defenderActor, choice, data.engagementId ?? "", data.attackerDamageFlags ?? null, data.attackHitLocation ?? null, data.attackerUuid ?? "");
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

/* GM-side handler for authored-AE apply. Uses the GM's own permission to
 * create ActiveEffects on any target actor. Payloads are already sanitized
 * (origin / flags stamped) by the caster. */
async function handleApplyAuthoredEffects({ targetUuid, payloads }) {
    try {
        const target = await fromUuid(targetUuid);
        if (!target?.createEmbeddedDocuments) {
            console.warn(`${SYSTEM_ID} | applyAuthoredEffects: no target for ${targetUuid}`);
            return;
        }
        if (!Array.isArray(payloads) || !payloads.length) return;
        await target.createEmbeddedDocuments("ActiveEffect", payloads);
    } catch (err) {
        console.warn(`${SYSTEM_ID} | applyAuthoredEffects failed on ${targetUuid}`, err);
    }
}

/* GM-side handler for healing. Mirrors what the system's own rest does:
 * add, then clamp to max. */
async function handleHealActor({ targetUuid, amount }) {
    try {
        const target = await fromUuid(targetUuid);
        const hp = target?.system?.derivedStats?.hp;
        if (!hp) {
            console.warn(`${SYSTEM_ID} | healActor: no target for ${targetUuid}`);
            return;
        }
        const healed = Math.min((Number(hp.value) || 0) + Math.max(0, Math.floor(amount)),
                                Number(hp.max) || 0);
        await target.update({ "system.derivedStats.hp.value": healed });
    } catch (err) {
        console.warn(`${SYSTEM_ID} | healActor failed on ${targetUuid}`, err);
    }
}

/* GM-side handler for authored-AE removal. The mirror of the apply handler
 * above, and the reason a magic effect on an unowned actor can now end. */
async function handleRemoveAuthoredEffects({ targetUuid, match }) {
    try {
        const target = await fromUuid(targetUuid);
        if (!target?.effects) {
            console.warn(`${SYSTEM_ID} | removeAuthoredEffects: no target for ${targetUuid}`);
            return;
        }
        if (!match || !(match.castId || match.name || match.origin)) return;
        const doomed = target.effects.filter(e => {
            const f = e.flags?.[SYSTEM_ID] ?? {};
            if (match.castId && f.record?.castId !== match.castId) return false;
            if (match.name   && e.name !== match.name) return false;
            if (match.origin && e.origin !== match.origin) return false;
            /* Only ever OUR effects — never something another module put there. */
            return !!f.record || !!f.source;
        }).map(e => e.id);
        if (doomed.length) await target.deleteEmbeddedDocuments("ActiveEffect", doomed);
    } catch (err) {
        console.warn(`${SYSTEM_ID} | removeAuthoredEffects failed on ${targetUuid}`, err);
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
