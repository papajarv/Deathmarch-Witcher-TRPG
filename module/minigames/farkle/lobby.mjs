/**
 * Farkle table lobby — the shared, GM-authoritative pre-game state.
 *
 * The whole table (open flag, config, four seats) lives in ONE world setting
 * (`farkleTable`). Only the GM can write a world setting, so every mutation is
 * funnelled through `request(action, args)`: a GM applies it directly; a player
 * emits a `farkleLobby` socket message and the GM applies it on their behalf
 * (validating currency, seat ownership, etc.). After each write the native
 * `updateSetting` hook fires on every client, and `syncFarkleUI` opens/refreshes
 * /closes the lobby and live board — so all clients converge without bespoke
 * broadcast.
 *
 * Seats are the canonical `["a","b","c","d"]` (engine order). A seat is either
 * empty (null) or `{ kind:"human"|"ai", userId, actorId, name, skill,
 * diceItemIds, ready }`. Dice items are resolved to weight/face profiles at
 * START (see resolveSeatProfiles), not stored expanded in the setting.
 *
 * Money: each seat antes `config.ante` of `config.denom`; a seat can only be
 * occupied by an actor that can cover the ante (checked on claim AND at start).
 * Antes are debited at start and the whole pot is credited to the winner.
 */

import { isHomebrewEnabled } from "../../api/homebrew.mjs";
import { aiSkill, canAfford, pickDice } from "./engine/wager.mjs";
import { CURRENCY_KEYS } from "../../data/actor/templates/currency.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const CHANNEL = `system.${SYSTEM_ID}`;
const SETTING = "farkleTable";
/** World setting that remembers the last stake currency, so a fresh table opens
 *  on it instead of the hard default. */
const LAST_DENOM_SETTING = "farkleLastDenom";
/** Per-user flag: the die-item ids a player last brought to a Farkle table, so a
 *  fresh claim re-picks them. Written client-side in the dice picker. */
export const LAST_DICE_FLAG = "farkleLastDice";

export const SEAT_IDS = ["a", "b", "c", "d"];
export const LOBBY_DEFAULTS = Object.freeze({ target: 2500, ante: 0, denom: "crown", diceCount: 6 });

/* ----------------------------- state access ---------------------------- */

export function getTable() {
    return game.settings.get(SYSTEM_ID, SETTING) ?? null;
}

export function isTableOpen() {
    return isHomebrewEnabled("farkleTable") && !!getTable()?.open;
}

function defaultTable(hostUserId) {
    return {
        open: true,
        started: false,
        hostUserId,
        matchId: foundry.utils.randomID(),
        config: { ...LOBBY_DEFAULTS, denom: lastDenom() },
        seats: { a: null, b: null, c: null, d: null }
    };
}

/* --------------------------- currency helpers --------------------------- */

/** Coins of `denom` an actor holds (0 if the actor/denom is missing). */
export function purseOf(actor, denom) {
    return Number(actor?.system?.currency?.[denom]) || 0;
}

/** True if the actor can cover `ante` of `denom`. */
export function actorCanAfford(actor, denom, ante) {
    return canAfford(purseOf(actor, denom), ante);
}

async function debit(actor, denom, amount) {
    if (!actor || amount <= 0) return;
    await actor.update({ [`system.currency.${denom}`]: purseOf(actor, denom) - amount });
}

async function credit(actor, denom, amount) {
    if (!actor || amount <= 0) return;
    await actor.update({ [`system.currency.${denom}`]: purseOf(actor, denom) + amount });
}

/* ----------------------------- dice profiles ---------------------------- */

/** Resolve a seat's chosen Die items into `diceCount` board profiles. */
export function resolveSeatProfiles(seat, diceCount, rng = Math.random) {
    const actor = seat?.actorId ? game.actors.get(seat.actorId) : null;
    const owned = (seat?.diceItemIds ?? [])
        .map(id => actor?.items?.get(id))
        .filter(it => it?.type === "die")
        .map(it => ({ weights: it.system.faceWeights, faces: it.system.faceImages }));
    return pickDice(owned, diceCount, rng);
}

/** The Die items an actor owns (for the lobby's dice picker). */
export function dieItemsOf(actor) {
    return (actor?.items?.filter(it => it.type === "die")) ?? [];
}

/** Every PHYSICAL die an actor owns as a flat id list — a stack of quantity N
 *  contributes its id N times (the seat selection is a multiset). */
function ownedDiceIds(actor) {
    const ids = [];
    for (const it of dieItemsOf(actor)) {
        const qty = Math.max(1, it.system?.quantity ?? 1);
        for (let i = 0; i < qty; i++) ids.push(it.id);
    }
    return ids;
}

/** The dice a fresh seat starts with: the user's remembered last pick (filtered
 *  to dice the actor still owns), else the first `diceCount` dice they own.
 *  Empty when the actor owns none — `resolveSeatProfiles` then pads with fair
 *  defaults. */
export function defaultDiceFor(actor, userId, diceCount) {
    const available = ownedDiceIds(actor);
    if (!available.length) return [];
    const remembered = game.users.get(userId)?.getFlag(SYSTEM_ID, LAST_DICE_FLAG);
    if (Array.isArray(remembered) && remembered.length) {
        const pool = [...available];
        const picked = [];
        for (const id of remembered) {
            const idx = pool.indexOf(id);
            if (idx === -1) continue;          // no longer owned (or stack exhausted)
            pool.splice(idx, 1);
            picked.push(id);
            if (picked.length >= diceCount) break;
        }
        if (picked.length) return picked;
    }
    return available.slice(0, diceCount);
}

/* ------------------------------ networking ------------------------------ */

/** Apply a lobby action. GM applies directly; players proxy to the GM. */
export function request(action, args = {}) {
    if (game.user.isActiveGM) return applyAsGM(action, { ...args, byUserId: game.user.id });
    game.socket.emit(CHANNEL, { type: "farkleLobby", action, args: { ...args, byUserId: game.user.id } });
}

/** GM-side authority: validate + write the canonical table. */
async function applyAsGM(action, args) {
    if (!game.user.isActiveGM) return;
    if (action === "open") return openTableGM(args);
    const table = getTable();
    if (!table) return;
    const t = foundry.utils.deepClone(table);
    switch (action) {
        case "close":      return game.settings.set(SYSTEM_ID, SETTING, null);
        case "endTable":   return endTableGM();
        case "setConfig":  applyConfig(t, args); break;
        case "claimSeat":  if (!claimSeat(t, args)) return; break;
        case "leaveSeat":  leaveSeat(t, args); break;
        case "setAISeat":  setAISeat(t, args); break;
        case "setDice":    setDice(t, args); break;
        case "start":      return startGM(t, args);
        default: return;
    }
    await game.settings.set(SYSTEM_ID, SETTING, t);
}

function openTableGM({ byUserId }) {
    if (getTable()) return; // already open
    return game.settings.set(SYSTEM_ID, SETTING, defaultTable(byUserId));
}

function applyConfig(t, { config }) {
    if (t.started) return;
    const next = { ...t.config, ...config };
    next.target = Math.max(500, Number(next.target) || LOBBY_DEFAULTS.target);
    next.ante = Math.max(0, Number(next.ante) || 0);
    if (!CURRENCY_KEYS.includes(next.denom)) next.denom = t.config.denom ?? lastDenom();
    t.config = next;
    // Remember this currency so the next table opens on it.
    game.settings.set(SYSTEM_ID, LAST_DENOM_SETTING, next.denom);
}

/** The remembered stake currency, falling back to the lobby default. */
function lastDenom() {
    const d = game.settings.get(SYSTEM_ID, LAST_DENOM_SETTING);
    return CURRENCY_KEYS.includes(d) ? d : LOBBY_DEFAULTS.denom;
}

/** Validate + seat a human. Rejected (returns false) if the seat is taken or
 *  the actor can't cover the ante. */
function claimSeat(t, { seatId, userId, actorId }) {
    if (t.started || !SEAT_IDS.includes(seatId) || t.seats[seatId]) return false;
    const actor = game.actors.get(actorId);
    if (!actor || !actorCanAfford(actor, t.config.denom, t.config.ante)) {
        warnUser(userId, "WITCHER.Farkle.lobby.cantAfford");
        return false;
    }
    // One seat per user.
    for (const s of SEAT_IDS) if (t.seats[s]?.userId === userId) t.seats[s] = null;
    t.seats[seatId] = {
        kind: "human", userId, actorId, name: actor.name,
        skill: null, diceItemIds: defaultDiceFor(actor, userId, t.config.diceCount), ready: false
    };
    return true;
}

function leaveSeat(t, { seatId, byUserId, force }) {
    if (t.started) return;
    const seat = t.seats[seatId];
    if (!seat) return;
    // A player may only vacate their own seat; the GM (or host) may clear any.
    if (!force && seat.kind === "human" && seat.userId !== byUserId && !isGmUser(byUserId)) return;
    t.seats[seatId] = null;
}

function setAISeat(t, { seatId, actorId, byUserId }) {
    if (t.started || !isGmUser(byUserId) || !SEAT_IDS.includes(seatId)) return;
    const actor = actorId ? game.actors.get(actorId) : null;
    const skill = actor
        ? aiSkill(actor.system?.stats?.int?.value, actor.system?.stats?.emp?.value, actor.system?.skills?.emp?.gambling?.value)
        : 15;
    t.seats[seatId] = {
        kind: "ai", userId: null, actorId: actorId ?? null,
        name: actor?.name ?? game.i18n.localize("WITCHER.Farkle.lobby.genericAI"),
        skill, diceItemIds: defaultDiceFor(actor, null, t.config.diceCount), ready: true
    };
}

function setDice(t, { seatId, diceItemIds, byUserId }) {
    if (t.started) return;
    const seat = t.seats[seatId];
    if (!seat) return;
    if (seat.kind === "human" && seat.userId !== byUserId && !isGmUser(byUserId)) return;
    seat.diceItemIds = Array.isArray(diceItemIds) ? diceItemIds.slice(0, t.config.diceCount) : [];
}

/** GM-only: debit antes, freeze the roster, flip to started, then launch. */
async function startGM(t, { byUserId }) {
    if (t.started || !isGmUser(byUserId)) return;
    const occupied = SEAT_IDS.filter(s => t.seats[s]);
    if (occupied.length < 2) return warn("WITCHER.Farkle.lobby.needTwo");
    // Re-validate funds for every human seat before taking anyone's coin.
    for (const s of occupied) {
        const seat = t.seats[s];
        if (seat.kind !== "human") continue;
        const actor = game.actors.get(seat.actorId);
        if (!actorCanAfford(actor, t.config.denom, t.config.ante)) {
            t.seats[s] = null; // kicked for insolvency
            warn("WITCHER.Farkle.lobby.kicked", { name: seat.name });
        }
    }
    const live = SEAT_IDS.filter(s => t.seats[s]);
    if (live.length < 2) { await game.settings.set(SYSTEM_ID, SETTING, t); return; }
    for (const s of live) {
        const seat = t.seats[s];
        const actor = game.actors.get(seat.actorId);
        await debit(actor, t.config.denom, t.config.ante);
    }
    t.started = true;
    await game.settings.set(SYSTEM_ID, SETTING, t);
}

/** GM: pay the whole pot to the winning seat's actor and close the table. */
export async function settleAndClose(seatId) {
    if (!game.user.isActiveGM) return;
    const t = getTable();
    if (!t?.started) return;
    const seat = t.seats?.[seatId];
    const live = SEAT_IDS.filter(s => t.seats[s]).length;
    const pot = t.config.ante * live;
    if (seat?.actorId) await credit(game.actors.get(seat.actorId), t.config.denom, pot);
    await game.settings.set(SYSTEM_ID, SETTING, null);
}

/** GM: cancel the table mid-game, refunding every human seat its original ante,
 *  tell every live client to tear down its board, then close the table. */
async function endTableGM() {
    const t = getTable();
    if (!t) return;
    if (t.started) {
        for (const s of SEAT_IDS) {
            const seat = t.seats[s];
            if (seat?.kind === "human" && seat.actorId) {
                await credit(game.actors.get(seat.actorId), t.config.denom, t.config.ante);
            }
        }
    }
    // Foundry never echoes an emit back to the sender, so the GM's own live board
    // is closed by its action handler; this reaches the other participants.
    game.socket.emit(CHANNEL, { type: "farkle", matchId: t.matchId, from: game.user.id, to: null, sub: "endTable", payload: {} });
    await game.settings.set(SYSTEM_ID, SETTING, null);
}

/** Cancel the table (GM authority): refund antes and dismiss everyone's board. */
export function endTable() {
    if (game.user.isActiveGM) return endTableGM();
    request("endTable");
}

/* ------------------------------ utilities ------------------------------- */

function isGmUser(userId) {
    return game.users.get(userId)?.isGM ?? false;
}

function warn(key, data = {}) {
    ui.notifications?.warn(game.i18n.format(key, data));
}

/** Warn a specific user (GM context validating a player's request). */
function warnUser(userId, key) {
    if (userId === game.user.id) warn(key);
    else game.socket.emit(CHANNEL, { type: "farkleLobby", action: "warn", args: { userId, key } });
}

/* ------------------------------ UI sync --------------------------------- */

const VIS_FLAG = "farkleOpen";

let _lobbyApp = null;
let _liveApp = null;

/** Per-user intent: "I want the Farkle board visible". Persisted as a user flag
 *  so a reload only re-opens the board for users who left it open. */
function boardOpenFlag() { return !!game.user.getFlag(SYSTEM_ID, VIS_FLAG); }

/**
 * Converge THIS user's Farkle windows with the shared table and their own
 * visibility flag.
 *
 *  - A STARTED match is handed off to the live FarkleApp exactly once. The
 *    participants and the active GM are forced in (and the flag persisted) — you
 *    can't be "involved but hidden" the moment a match begins; minimise it
 *    afterwards with the left-bar icon. Anyone else can open the board to
 *    SPECTATE: they launch the same live view with no seat (mySeat null), so
 *    they watch the relayed moves without being forced in.
 *  - The lobby window is a pure view over the open-but-unstarted table; it is
 *    shown only to a user who has the board toggled on, and destroyed otherwise
 *    (cheap to reopen from the setting).
 *  - The live board is never destroyed here (its match lives only in memory);
 *    the flag just hides/shows it (minimise).
 */
async function syncFarkleUI() {
    if (!isHomebrewEnabled("farkleTable")) return;
    const table = getTable();
    let forceVisible = false;

    // Launch the live board when a started match has no board on this client yet
    // (none open, or the open one belongs to a previous match). Comparing the
    // live app's matchId — rather than a one-shot "launched" guard — lets a user
    // who closed their board reopen it (it re-syncs from the GM snapshot).
    if (table?.started && table.matchId && _liveApp?.matchId !== table.matchId) {
        const amParticipant = SEAT_IDS.some(s =>
            table.seats[s]?.kind === "human" && table.seats[s].userId === game.user.id);
        // Participants and the GM are pulled in automatically; a spectator only
        // launches once they've opened the board themselves.
        const auto = amParticipant || game.user.isActiveGM;
        if (auto || boardOpenFlag()) {
            closeLobby();
            if (auto && !boardOpenFlag()) game.user.setFlag(SYSTEM_ID, VIS_FLAG, true);
            forceVisible = auto;
            _liveApp = await launchGame(table);
        }
    }

    // Live board visibility tracks the flag (minimise = CSS-hide, keep match).
    // EXCEPTION: a FINISHED game is never minimised. Once the user toggles it off
    // it is disposed for real, so the next icon click opens a fresh game in one
    // click instead of first un-hiding (and resurrecting) the stale result board.
    const visible = forceVisible || boardOpenFlag();
    if (_liveApp && !visible && _liveApp.match?.phase === "done") {
        _liveApp.close();   // _onClose → notifyLiveClosed clears _liveApp + flag
    } else {
        const liveEl = _liveApp?.element;
        if (liveEl) liveEl.classList.toggle("wdm-fk-hidden", !visible);
    }

    const showLobby = boardOpenFlag() && table?.open && !table.started;
    if (showLobby) {
        const { FarkleLobbyApp } = await import("./lobbyApp.mjs");
        if (!_lobbyApp) _lobbyApp = new FarkleLobbyApp();
        if (_lobbyApp.rendered) _lobbyApp.render();
        else _lobbyApp.render(true);
    } else {
        closeLobby();
    }
}

function closeLobby() {
    if (_lobbyApp) { _lobbyApp.close(); _lobbyApp = null; }
}

/** Left-bar icon: toggle this user's board. With a table present syncFarkleUI
 *  shows the lobby (pre-start) or the live board — spectating it if this user
 *  holds no seat. Opening with NO table makes the GM host a fresh one; a player
 *  with nothing in progress is simply told so. */
export async function toggleFarkleBoard() {
    if (!isHomebrewEnabled("farkleTable")) return warn("WITCHER.Farkle.lobby.disabled");
    const open = !boardOpenFlag();
    await game.user.setFlag(SYSTEM_ID, VIS_FLAG, open);
    if (open && !getTable()) {
        if (game.user.isGM) request("open"); // → updateSetting → syncFarkleUI shows the lobby
        else ui.notifications.info(game.i18n.localize("WITCHER.Farkle.lobby.noGame"));
    }
    syncFarkleUI();
}

/** Build the live-table launch arguments for THIS client from the shared table.
 *  Every seated client + the GM launches; each resolves dice profiles for the
 *  seats it can read (board values are relayed, so weight/face differences are
 *  cosmetic and never desync the match). */
async function launchGame(table) {
    const seatedIds = SEAT_IDS.filter(s => table.seats[s]);
    const mySeat = seatedIds.find(s => table.seats[s].kind === "human"
        && table.seats[s].userId === game.user.id) ?? null;

    const seats = seatedIds.map(s => {
        const { kind, userId, actorId, name, skill } = table.seats[s];
        return { id: s, kind, userId, actorId, name, skill };
    });
    const seatDice = {};
    for (const s of seatedIds) seatDice[s] = resolveSeatProfiles(table.seats[s], table.config.diceCount);

    const { openFarkleTableGame } = await import("./app.mjs");
    return openFarkleTableGame({
        matchId: table.matchId,
        seats,
        config: { target: table.config.target, ante: table.config.ante, denom: table.config.denom },
        seatDice,
        starter: seatedIds[0],
        mySeat
    });
}

export function notifyLobbyClosed() { _lobbyApp = null; }

/** The live board was destroyed (forfeit / close / GM end-table). Clear this
 *  user's "keep it open" intent too — otherwise the flag stays true while the
 *  board is gone, so the next left-bar click only flips the stale flag (no
 *  visible effect) and the board needs a SECOND click to actually reopen. */
export function notifyLiveClosed() {
    _liveApp = null;
    if (boardOpenFlag()) game.user.setFlag(SYSTEM_ID, VIS_FLAG, false);
}

/* ----------------------------- registration ----------------------------- */

export function registerFarkleLobby() {
    // Player → GM proxy + GM → player warnings.
    game.socket.on(CHANNEL, (data) => {
        if (data?.type !== "farkleLobby") return;
        if (data.action === "warn") {
            if (data.args?.userId === game.user.id) warn(data.args.key);
            return;
        }
        if (game.user.isActiveGM) applyAsGM(data.action, data.args);
    });

    // Converge every client's UI whenever the canonical table changes.
    Hooks.on("updateSetting", (setting) => {
        if (setting?.key !== `${SYSTEM_ID}.${SETTING}`) return;
        syncFarkleUI();
    });

    // The left-bar control lives in the shared "Games" category (games.mjs),
    // which calls toggleFarkleBoard — registered here is only the socket proxy,
    // the updateSetting convergence, and the post-reload restore below.

    // Restore the live UI after a reload: the canonical table persists in the
    // world setting, but the `updateSetting` hook only fires on *changes* — so
    // nothing re-opens the board on a fresh load. Sync once now (it opens only
    // what this user is involved in / had toggled open).
    syncFarkleUI();
}

/** API: open the table programmatically (GM). */
export function openFarkleTable() {
    if (!isHomebrewEnabled("farkleTable")) {
        return warn("WITCHER.Farkle.lobby.disabled");
    }
    if (!boardOpenFlag()) game.user.setFlag(SYSTEM_ID, VIS_FLAG, true);
    request("open");
    syncFarkleUI();
}
