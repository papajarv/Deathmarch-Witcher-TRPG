/**
 * Dice poker table lobby — the shared, GM-authoritative pre-game state.
 *
 * The analogue of the Farkle lobby: the whole table (open flag, config, four
 * seats) lives in ONE world setting (`dicePokerTable`). Only the GM can write a
 * world setting, so every mutation is funnelled through `request(action, args)`:
 * a GM applies it directly; a player emits a `dicePokerLobby` socket message and
 * the GM applies it on their behalf. After each write the native `updateSetting`
 * hook fires on every client, and `syncDicePokerUI` opens/refreshes/closes the
 * lobby and live board — so all clients converge without bespoke broadcast.
 *
 * Seats are the canonical `["a","b","c","d"]` (engine order). Money: each seat
 * antes `config.ante` of `config.denom`; the best hand takes the whole pot.
 */

import { isHomebrewEnabled } from "../../api/homebrew.mjs";
import { aiSkill, canAfford, pickDice } from "../farkle/engine/wager.mjs";
import { CURRENCY_KEYS } from "../../data/actor/templates/currency.mjs";

/** World setting that remembers the last stake currency, so a fresh table opens
 *  on it instead of the hard default. */
const LAST_DENOM_SETTING = "dicePokerLastDenom";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const CHANNEL = `system.${SYSTEM_ID}`;
const SETTING = "dicePokerTable";
/** Per-user flag: the die-item ids a player last brought to a dice poker table. */
export const LAST_DICE_FLAG = "dicePokerLastDice";

export const SEAT_IDS = ["a", "b", "c", "d"];
// Heads-up match length: best-of-N hand-wins, or continuous until broke.
export const HEADS_UP_FORMATS = Object.freeze(["bo1", "bo3", "bo5", "bo7", "continuous"]);
// 3–4 seats: play a fixed number of hands (richest wins), or continuous.
export const MULTI_FORMATS = Object.freeze(["hands3", "hands5", "hands10", "continuous"]);
// Every valid format key (for config validation, seat-count agnostic).
export const MATCH_FORMATS = Object.freeze([...new Set([...HEADS_UP_FORMATS, ...MULTI_FORMATS])]);
export const LOBBY_DEFAULTS = Object.freeze({ ante: 0, denom: "crown", diceCount: 5, format: "bo3" });

/** Format keys offered for a table with `seatCount` occupied seats. */
export function formatsFor(seatCount) {
    return seatCount > 2 ? MULTI_FORMATS : HEADS_UP_FORMATS;
}

/* ----------------------------- state access ---------------------------- */

export function getTable() {
    return game.settings.get(SYSTEM_ID, SETTING) ?? null;
}

export function isTableOpen() {
    return isHomebrewEnabled("dicePokerTable") && !!getTable()?.open;
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

export function purseOf(actor, denom) {
    return Number(actor?.system?.currency?.[denom]) || 0;
}

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

export function resolveSeatProfiles(seat, diceCount, rng = Math.random) {
    const actor = seat?.actorId ? game.actors.get(seat.actorId) : null;
    const owned = (seat?.diceItemIds ?? [])
        .map(id => actor?.items?.get(id))
        .filter(it => it?.type === "die")
        .map(it => ({ weights: it.system.faceWeights, faces: it.system.faceImages }));
    return pickDice(owned, diceCount, rng);
}

export function dieItemsOf(actor) {
    return (actor?.items?.filter(it => it.type === "die")) ?? [];
}

function ownedDiceIds(actor) {
    const ids = [];
    for (const it of dieItemsOf(actor)) {
        const qty = Math.max(1, it.system?.quantity ?? 1);
        for (let i = 0; i < qty; i++) ids.push(it.id);
    }
    return ids;
}

export function defaultDiceFor(actor, userId, diceCount) {
    const available = ownedDiceIds(actor);
    if (!available.length) return [];
    const remembered = game.users.get(userId)?.getFlag(SYSTEM_ID, LAST_DICE_FLAG);
    if (Array.isArray(remembered) && remembered.length) {
        const pool = [...available];
        const picked = [];
        for (const id of remembered) {
            const idx = pool.indexOf(id);
            if (idx === -1) continue;
            pool.splice(idx, 1);
            picked.push(id);
            if (picked.length >= diceCount) break;
        }
        if (picked.length) return picked;
    }
    return available.slice(0, diceCount);
}

/* ------------------------------ networking ------------------------------ */

export function request(action, args = {}) {
    if (game.user.isActiveGM) return applyAsGM(action, { ...args, byUserId: game.user.id });
    game.socket.emit(CHANNEL, { type: "dicePokerLobby", action, args: { ...args, byUserId: game.user.id } });
}

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
    if (getTable()) return;
    return game.settings.set(SYSTEM_ID, SETTING, defaultTable(byUserId));
}

function applyConfig(t, { config }) {
    if (t.started) return;
    const next = { ...t.config, ...config };
    next.ante = Math.max(0, Number(next.ante) || 0);
    if (!MATCH_FORMATS.includes(next.format)) next.format = "bo3";
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

function claimSeat(t, { seatId, userId, actorId }) {
    if (t.started || !SEAT_IDS.includes(seatId) || t.seats[seatId]) return false;
    const actor = game.actors.get(actorId);
    if (!actor || !actorCanAfford(actor, t.config.denom, t.config.ante)) {
        warnUser(userId, "WITCHER.DicePoker.lobby.cantAfford");
        return false;
    }
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
        name: actor?.name ?? game.i18n.localize("WITCHER.DicePoker.lobby.genericAI"),
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

async function startGM(t, { byUserId }) {
    if (t.started || !isGmUser(byUserId)) return;
    const occupied = SEAT_IDS.filter(s => t.seats[s]);
    if (occupied.length < 2) return warn("WITCHER.DicePoker.lobby.needTwo");
    for (const s of occupied) {
        const seat = t.seats[s];
        if (seat.kind !== "human") continue;
        const actor = game.actors.get(seat.actorId);
        if (!actorCanAfford(actor, t.config.denom, t.config.ante)) {
            t.seats[s] = null;
            warn("WITCHER.DicePoker.lobby.kicked", { name: seat.name });
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

/**
 * GM: apply each seat's betting net to its actor's real currency, clamped at 0.
 *
 * `nets` is [{ seatId, net }] where net = finalPurse − startingPurse (the swing
 * shown under each seat). The ante was debited at sit-down and the net already
 * accounts for the ante's flow through the pot, so we add the ante back — the
 * real currency delta then equals the net. A loss deeper than the actor's coin
 * is clamped to zero (no negative balances); the shortfall is returned as a debt
 * the caller can announce ("on credit"). With `close`, the table is ended after.
 *
 * @param {Array<{seatId:string, net:number}>} nets
 * @param {{close?: boolean}} [opts]
 * @returns {Promise<Array<{name:string, owed:number}>>} seats left owing on credit
 */
export async function settleNets(nets, { close = false } = {}) {
    const debts = [];
    if (!game.user.isActiveGM) return debts;
    const t = getTable();
    if (t?.started) {
        const denom = t.config.denom;
        const ante = t.config.ante ?? 0;
        for (const { seatId, net } of nets) {
            const seat = t.seats?.[seatId];
            if (seat?.kind !== "human" || !seat.actorId) continue;
            const actor = game.actors.get(seat.actorId);
            if (!actor) continue;
            const after = purseOf(actor, denom) + net + ante;
            if (after < 0) debts.push({ name: seat.name, owed: -after });
            await actor.update({ [`system.currency.${denom}`]: Math.max(0, after) });
        }
    }
    if (close) await game.settings.set(SYSTEM_ID, SETTING, null);
    return debts;
}

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
    game.socket.emit(CHANNEL, { type: "dicepoker", matchId: t.matchId, from: game.user.id, to: null, sub: "endTable", payload: {} });
    await game.settings.set(SYSTEM_ID, SETTING, null);
}

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

function warnUser(userId, key) {
    if (userId === game.user.id) warn(key);
    else game.socket.emit(CHANNEL, { type: "dicePokerLobby", action: "warn", args: { userId, key } });
}

/* ------------------------------ UI sync --------------------------------- */

const VIS_FLAG = "dicePokerOpen";

let _lobbyApp = null;
let _liveApp = null;

function boardOpenFlag() { return !!game.user.getFlag(SYSTEM_ID, VIS_FLAG); }

async function syncDicePokerUI({ boot = false } = {}) {
    if (!isHomebrewEnabled("dicePokerTable")) return;
    const table = getTable();

    // World boot: every minigame window starts closed; the user reopens from the
    // games icon. A match's gameplay state lives only in the live app's memory, so
    // a `started` table that survives a reload is a zombie — the active GM nulls it.
    // We also drop this user's persisted "keep open" flag so neither the live board
    // nor the lobby auto-pops on load.
    if (boot) {
        if (table?.started && game.user.isActiveGM) await endTableGM();
        if (boardOpenFlag()) await game.user.setFlag(SYSTEM_ID, VIS_FLAG, false);
        return;
    }
    let forceVisible = false;

    if (table?.started && table.matchId && _liveApp?.matchId !== table.matchId) {
        const amParticipant = SEAT_IDS.some(s =>
            table.seats[s]?.kind === "human" && table.seats[s].userId === game.user.id);
        const auto = amParticipant || game.user.isActiveGM;
        if (auto || boardOpenFlag()) {
            closeLobby();
            if (auto && !boardOpenFlag()) game.user.setFlag(SYSTEM_ID, VIS_FLAG, true);
            forceVisible = auto;
            _liveApp = await launchGame(table);
        }
    }

    const visible = forceVisible || boardOpenFlag();
    if (_liveApp && !visible && _liveApp.match?.phase === "done") {
        _liveApp.close();
    } else {
        const liveEl = _liveApp?.element;
        if (liveEl) liveEl.classList.toggle("wdm-fk-hidden", !visible);
    }

    const showLobby = boardOpenFlag() && table?.open && !table.started;
    if (showLobby) {
        const { DicePokerLobbyApp } = await import("./lobbyApp.mjs");
        if (!_lobbyApp) _lobbyApp = new DicePokerLobbyApp();
        if (_lobbyApp.rendered) _lobbyApp.render();
        else _lobbyApp.render(true);
    } else {
        closeLobby();
    }
}

function closeLobby() {
    if (_lobbyApp) { _lobbyApp.close(); _lobbyApp = null; }
}

export async function toggleDicePokerBoard() {
    if (!isHomebrewEnabled("dicePokerTable")) return warn("WITCHER.DicePoker.lobby.disabled");
    const open = !boardOpenFlag();
    await game.user.setFlag(SYSTEM_ID, VIS_FLAG, open);
    if (open && !getTable()) {
        if (game.user.isGM) request("open");
        else ui.notifications.info(game.i18n.localize("WITCHER.DicePoker.lobby.noGame"));
    }
    syncDicePokerUI();
}

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

    const { openDicePokerTableGame } = await import("./app.mjs");
    return openDicePokerTableGame({
        matchId: table.matchId,
        seats,
        config: { ante: table.config.ante, denom: table.config.denom, format: table.config.format },
        seatDice,
        starter: seatedIds[0],
        mySeat
    });
}

export function notifyLobbyClosed() { _lobbyApp = null; }

export function notifyLiveClosed() {
    _liveApp = null;
    if (boardOpenFlag()) game.user.setFlag(SYSTEM_ID, VIS_FLAG, false);
}

/* ----------------------------- registration ----------------------------- */

export function registerDicePokerLobby() {
    game.socket.on(CHANNEL, (data) => {
        if (data?.type !== "dicePokerLobby") return;
        if (data.action === "warn") {
            if (data.args?.userId === game.user.id) warn(data.args.key);
            return;
        }
        if (game.user.isActiveGM) applyAsGM(data.action, data.args);
    });

    Hooks.on("updateSetting", (setting) => {
        if (setting?.key !== `${SYSTEM_ID}.${SETTING}`) return;
        syncDicePokerUI();
    });

    syncDicePokerUI({ boot: true });
}

