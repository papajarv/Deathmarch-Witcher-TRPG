/**
 * Dice poker PvP transport.
 *
 * Lobby-launched tables keep every client's local DicePokerMatch in lock-step by
 * relaying each game INPUT (roll values, keep/stand, reroll values) over the
 * system socket channel, plus authoritative GM snapshots. Because the match is a
 * deterministic state machine driven by injected values, replaying the same
 * ordered inputs on every client yields identical state.
 *
 * Envelope: { type: "dicepoker", matchId, from, to, sub, payload }
 *   sub ∈ "move" | "state" | "sel" | "hello" | "endTable"
 *   `to` is a user id, or null to broadcast. Foundry does not echo emits back to
 *   the sender.
 */

const SYSTEM_ID = "witcher-ttrpg-death-march";
const CHANNEL = `system.${SYSTEM_ID}`;
const ENVELOPE = "dicepoker";

/** matchId -> live DicePokerApp awaiting peer messages. */
const tables = new Map();

export function registerTable(matchId, app) { tables.set(matchId, app); }
export function unregisterTable(matchId) { tables.delete(matchId); }

export function send({ matchId, to = null, sub, payload = {} }) {
    game.socket.emit(CHANNEL, { type: ENVELOPE, matchId, from: game.user.id, to, sub, payload });
}

export function registerDicePokerNet() {
    game.socket.on(CHANNEL, (data) => {
        if (data?.type !== ENVELOPE) return;
        if (data.to && data.to !== game.user.id) return;
        const app = tables.get(data.matchId);
        if (app) app.onNetMessage(data);
    });
}
