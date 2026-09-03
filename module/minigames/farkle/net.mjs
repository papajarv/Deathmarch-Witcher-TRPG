/**
 * Farkle PvP transport.
 *
 * Two human players keep their local FarkleMatch in lock-step by relaying each
 * game INPUT (roll values, set-aside selection, bank, roll-again) over the
 * system socket channel. Because the match is a deterministic state machine
 * driven by injected values, replaying the same ordered inputs on both clients
 * yields identical state — no shared mutable document is needed.
 *
 * Authority: each client is authoritative for its OWN seat's inputs and
 * broadcasts the resulting dice values; the peer applies them verbatim. This is
 * a friendly-table trust model; it does not defend against a doctored client.
 *
 * Envelope: { type: "farkle", matchId, from, to, sub, payload }
 *   sub ∈ "invite" | "accept" | "decline" | "move" | "abort"
 *   `to` is a user id, or null to broadcast. Messages not addressed to this
 *   client are ignored. Foundry does not echo emits back to the sender.
 */

const SYSTEM_ID = "witcher-ttrpg-death-march";
const CHANNEL = `system.${SYSTEM_ID}`;
const ENVELOPE = "farkle";

/** matchId -> live FarkleApp awaiting peer messages. */
const tables = new Map();

export function registerTable(matchId, app) { tables.set(matchId, app); }
export function unregisterTable(matchId) { tables.delete(matchId); }

export function send({ matchId, to = null, sub, payload = {} }) {
    game.socket.emit(CHANNEL, { type: ENVELOPE, matchId, from: game.user.id, to, sub, payload });
}

export function registerFarkleNet() {
    game.socket.on(CHANNEL, (data) => {
        if (data?.type !== ENVELOPE) return;
        if (data.to && data.to !== game.user.id) return;
        onMessage(data);
    });
}

function onMessage(data) {
    if (data.sub === "invite") return onInvite(data);
    const app = tables.get(data.matchId);
    if (app) app.onNetMessage(data);
}

async function onInvite(data) {
    const { matchId, from, payload } = data;
    if (tables.has(matchId)) return; // already seated at this table
    const accept = await foundry.applications.api.DialogV2.confirm({
        window: { title: game.i18n.localize("WITCHER.Farkle.invite.title"), icon: "fa-solid fa-dice" },
        content: `<p>${game.i18n.format("WITCHER.Farkle.invite.body", { name: payload.hostName })}</p>`
    });
    if (!accept) {
        send({ matchId, to: from, sub: "decline" });
        return;
    }
    const { FarkleApp } = await import("./app.mjs");
    new FarkleApp({
        mode: "pvp",
        matchId,
        seat: payload.hostSeat === "a" ? "b" : "a",
        starter: payload.hostSeat,
        config: payload.config,
        opponentUserId: from,
        opponentName: payload.hostName,
        connected: true
    }).render(true);
    send({ matchId, to: from, sub: "accept", payload: { name: game.user.name } });
}

/**
 * Open a PvP table as the host and invite another user. The host always takes
 * seat "a" (the starter). Returns the rendered app.
 */
export function invitePlayer(userId) {
    const user = game.users.get(userId);
    if (!user?.active) {
        ui.notifications.warn(game.i18n.localize("WITCHER.Farkle.invite.offline"));
        return null;
    }
    const matchId = foundry.utils.randomID();
    const config = { target: 2500, ante: 0, purse: 500 };
    return import("./app.mjs").then(({ FarkleApp }) => {
        const app = new FarkleApp({
            mode: "pvp",
            matchId,
            seat: "a",
            starter: "a",
            config,
            opponentUserId: userId,
            opponentName: user.name,
            connected: false
        });
        send({
            matchId, to: userId, sub: "invite",
            payload: { hostName: game.user.name, hostSeat: "a", config }
        });
        return app.render(true);
    });
}
