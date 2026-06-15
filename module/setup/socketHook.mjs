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

import { drainHp } from "./config.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const CHANNEL = `system.${SYSTEM_ID}`;
const PARCHMENT_FLAG = "parchments";

export function registerSocket() {
    game.socket.on(CHANNEL, handleSocketMessage);
}

function handleSocketMessage(data) {
    // Farkle PvP traffic is peer-routed in minigames/farkle/net.mjs,
    // not GM-proxied; ignore it here so it doesn't trip the unknown warning.
    // `farkleLobby` is GM-authoritative but has its own listener in lobby.mjs.
    if (data?.type === "farkle" || data?.type === "farkleLobby") return;
    if (!game.user.isActiveGM) return;
    switch (data?.type) {
        case "applyDamage":       return handleApplyDamage(data);
        case "applyStatus":       return handleApplyStatus(data);
        case "grantIP":           return handleGrantIP(data);
        case "grantReputation":   return handleGrantReputation(data);
        case "addSceneParchment": return handleAddSceneParchment(data);
        case "removeSceneParchment": return handleRemoveSceneParchment(data);
        default:
            console.warn(`${SYSTEM_ID} | unknown socket message`, data);
    }
}

/* -------------------------------------------------------------------------- */
/* Senders (call these from non-GM code)                                      */
/* -------------------------------------------------------------------------- */

export function emitApplyDamage({ targetUuid, amount, type, location, throughArmor }) {
    if (game.user.isActiveGM) return handleApplyDamage({ targetUuid, amount, type, location, throughArmor });
    game.socket.emit(CHANNEL, { type: "applyDamage", targetUuid, amount, type, location, throughArmor });
}

export function emitApplyStatus({ targetUuid, statusId, action = "toggle" }) {
    if (game.user.isActiveGM) return handleApplyStatus({ targetUuid, statusId, action });
    game.socket.emit(CHANNEL, { type: "applyStatus", targetUuid, statusId, action });
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

/* -------------------------------------------------------------------------- */
/* Handlers (run on the GM client only)                                       */
/* -------------------------------------------------------------------------- */

async function handleApplyDamage({ targetUuid, amount }) {
    const target = await fromUuid(targetUuid);
    if (!target || !Number.isFinite(amount)) return;
    const { value, temp } = drainHp(target.system.derivedStats?.hp, amount);
    await target.update({
        "system.derivedStats.hp.value": value,
        "system.derivedStats.hp.temp":  temp
    });
}

async function handleApplyStatus({ targetUuid, statusId, action }) {
    const target = await fromUuid(targetUuid);
    if (!target) return;
    const token = target.getActiveTokens()[0];
    if (!token) return;
    await token.toggleEffect(CONFIG.statusEffects.find(s => s.id === statusId), { active: action !== "remove" });
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
