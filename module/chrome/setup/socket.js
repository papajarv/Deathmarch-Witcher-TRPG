/**
 * Module socket — single channel for player→GM writes.
 *
 * Foundry only lets the GM persist world-scope settings, so anything a
 * player triggers that needs to write to `bestiary.state` (or any future
 * GM-only state) is delegated through this socket.  The GM client owns the
 * handler; non-GM clients only emit.
 *
 * Convention: every payload has a `type` discriminator.  Add new
 * (type → handler) entries here as features need them.
 */

const CHANNEL = "module.witcher-ttrpg-death-march";

/* ─── Handlers (GM-side) ─────────────────────────────────────────────────
 * Add (msg-type → handler) entries here as features need them. Knowledge
 * rolls used to go through this channel in the party-shared model; in the
 * per-character model the player writes their own actor flags directly,
 * so no socket round-trip is needed. */

const HANDLERS = {};

/* ─── Setup ─────────────────────────────────────────────────────────────── */

export function registerSocket() {
  game.socket.on(CHANNEL, async (msg) => {
    if (!msg || typeof msg !== "object") return;
    /* Only the GM acts on these messages.  Foundry broadcasts to everyone
     * including the sender, so we can't bail on "is it from me" — we just
     * gate handlers by `isGM`. */
    if (!game.user?.isGM) return;
    const handler = HANDLERS[msg.type];
    if (!handler) return;
    try { await handler(msg); }
    catch (err) { console.warn("[witcher-ttrpg-death-march] socket handler failed", msg.type, err); }
  });
}

/* ─── Emitters (any client) ─────────────────────────────────────────────── */

/* Future cross-actor write helpers go here.  Player-side actor-flag writes
 * (e.g. knowledge rolls, book studies) no longer require socket plumbing
 * because each player owns their own character's flags. */
