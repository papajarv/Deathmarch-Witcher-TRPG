/**
 * FarkleApp — the Farkle table (solo vs NPC, and PvP).
 *
 * Coin model: both seats ante into a pot; the first to reach the points target
 * banks the win and takes the pot. A turn is push-your-luck: roll the dice in
 * hand, set aside at least one scoring die, then bank the running total or roll
 * the rest again. Rolling with no scoring die is a FARKLE — the unbanked total
 * is lost and the turn passes. Setting aside all dice in hand earns HOT DICE: a
 * fresh six to keep going.
 *
 * The engine (FarkleMatch) is a deterministic state machine; it never rolls.
 * Values are injected: a seat's controller rolls from a local RNG and relays
 * every input (roll values, set-aside selection, bank/roll-again) so all clients
 * stay in lock-step. Because turns are strictly sequential (only `toAct` moves),
 * replaying the same ordered inputs yields identical state on every client.
 *
 * Seats are a roster drawn from the canonical order "a","b","c","d" (2–4 seats).
 * Each seat is human or AI:
 *   - solo : one human (mine) + one generic AI; driven entirely locally.
 *   - pvp  : two humans, point-to-point relay (legacy challenge entry point).
 *   - table: lobby-launched, 2–4 humans and/or AI. Moves broadcast to all.
 * A human seat is driven by its own user's client; AI seats are driven by the
 * "AI driver" — the local client in solo, the active GM in a networked table —
 * which broadcasts each AI move. `mySeat` is the seat this client controls (null
 * for a GM observing a table without sitting).
 */

import { FarkleMatch } from "./engine/state.mjs";
import { chooseSetAside, decideContinue } from "./engine/ai.mjs";
import { scoreSelection, bestScoreFull } from "./engine/scoring.mjs";
import { registerTable, unregisterTable, send } from "./net.mjs";
import { settleAndClose, endTable, notifyLiveClosed } from "./lobby.mjs";
import { DiceBoard3D } from "./board3d.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

// Intrinsic GL canvas resolution (CSS scales it down to fit the window).
const BOARD_W = 600, BOARD_H = 600;

// 3x3 pip grid cells lit per die face (cells numbered 1-9, row-major).
const PIP_FACES = Object.freeze({
    1: [5],
    2: [1, 9],
    3: [1, 5, 9],
    4: [1, 3, 7, 9],
    5: [1, 3, 5, 7, 9],
    6: [1, 3, 4, 6, 7, 9]
});

const DEFAULTS = { target: 2500, ante: 0, purse: 500 };
const NPC_STEP_MS = 850;
const OPP_PICK_MS = 420;   // pause between each opponent die pick (reads as a player choosing)

export class FarkleApp extends HandlebarsApplicationMixin(ApplicationV2) {

    static DEFAULT_OPTIONS = {
        id: "wdm-farkle-{id}",
        classes: ["witcher-ttrpg-death-march", "wdm-farkle", "wdm-farkle-app"],
        tag: "div",
        window: {
            title: "WITCHER.Farkle.title",
            icon: "fa-solid fa-dice",
            resizable: false,
            minimizable: false
        },
        position: { width: 640, height: "auto" },
        actions: {
            setAside: FarkleApp.#onSetAside,
            rollAgain: FarkleApp.#onRollAgain,
            bank: FarkleApp.#onBank,
            newGame: FarkleApp.#onNewGame,
            showRules: FarkleApp.#onShowRules,
            forfeit: FarkleApp.#onForfeit,
            endTable: FarkleApp.#onEndTable,
            close: FarkleApp.#onCloseAction
        }
    };

    static PARTS = {
        status: { template: `systems/${SYSTEM_ID}/templates/minigames/farkle/status.hbs` },
        stage: { template: `systems/${SYSTEM_ID}/templates/minigames/farkle/stage.hbs` },
        controls: { template: `systems/${SYSTEM_ID}/templates/minigames/farkle/controls.hbs` }
    };

    constructor(options = {}) {
        super(options);
        this.mode = options.mode ?? "solo";
        this.matchId = options.matchId ?? foundry.utils.randomID();

        // Seat roster (canonical order). Solo/pvp synthesize a 2-seat roster;
        // table mode is launched from the lobby with the full roster.
        this.roster = (options.seats ?? this.#defaultRoster(options))
            .slice()
            .sort((x, y) => x.id.localeCompare(y.id));
        this.seatIds = this.roster.map(s => s.id);
        this.seatById = Object.fromEntries(this.roster.map(s => [s.id, s]));

        // The seat THIS client controls (null = observer, e.g. a GM not sitting).
        this.mySeat = options.mySeat
            ?? this.roster.find(s => s.kind === "human" && s.userId === game.user.id)?.id
            ?? options.seat
            ?? null;

        this.starter = this.seatIds.includes(options.starter) ? options.starter : this.seatIds[0];
        this.cfg = { ...DEFAULTS, ...(options.config ?? {}) };
        this.rng = Math.random;
        this.log = [];

        // Per-seat dice: { a: [ {weights, faces}, … up to 6 ], b: [...] }. Each
        // entry skins one physical die and biases its draw; absent → fair brass.
        // Populated by the lobby (#50); the board is skinned to the acting seat.
        this.seatDice = options.seatDice ?? {};
        this._skinSeat = null;

        // 3D dice board (sole renderer; shows whichever seat is acting).
        this.board = null;
        this._armToken = null;
        this._freshHand = true;
        // Up-faces of the dice the player has clicked on the board this throw.
        this._selValues = [];
        // Opponent (AI/remote-human) animation bookkeeping.
        this._oppFresh = true;       // the acting opponent's next roll starts a fresh six
        this._oppAnimating = false;  // board owned by an opponent animation
        this._boardSettleResolve = null;
        // The acting opponent's last roll values (kept for log; rendered on board).
        this._oppDice = [];

        // Networking. PvP relays point-to-point to one peer; table broadcasts.
        this.opponentUserId = options.opponentUserId ?? null;
        this.opponentName = options.opponentName ?? null;
        this.connected = this.mode === "pvp" ? (options.connected ?? false) : true;
        if (this.mode === "pvp" || this.mode === "table") registerTable(this.matchId, this);

        this._closed = false;
        this._aiBusy = false;

        // Authoritative-state sync (table mode). The active GM applies every
        // move (its own, AI-driven, and relayed human moves) and broadcasts a
        // serialized snapshot stamped with a monotonic seq. Non-GM clients adopt
        // any snapshot newer than the last they saw — this catches up spectators
        // and reconnects, and self-heals drift. The deterministic move relay is
        // kept for animation; snapshots are the source of truth.
        this._stateSeq = 0;       // GM: last broadcast seq
        this._lastStateSeq = -1;  // non-GM: last adopted broadcast seq
        this._helloSent = false;

        this.#startMatch();
        // If the starter is an AI seat we own the driving of, kick it off once
        // the board has mounted (see _onRender → #maybeDriveAi).
    }

    get isPvp() { return this.mode === "pvp"; }
    get isTable() { return this.mode === "table"; }

    /** Synthesize the 2-seat roster for the solo/pvp entry points. */
    #defaultRoster(options) {
        const youName = game.i18n.localize("WITCHER.Farkle.you");
        if (this.mode === "pvp") {
            const mine = options.seat ?? "a";
            const opp = mine === "a" ? "b" : "a";
            return [
                { id: mine, kind: "human", userId: game.user.id, actorId: null, name: youName, skill: null },
                { id: opp, kind: "human", userId: options.opponentUserId ?? null, actorId: null,
                  name: options.opponentName ?? game.i18n.localize("WITCHER.Farkle.opponent"), skill: null }
            ];
        }
        return [
            { id: "a", kind: "human", userId: game.user.id, actorId: null, name: youName, skill: null },
            { id: "b", kind: "ai", userId: null, actorId: null,
              name: game.i18n.localize("WITCHER.Farkle.opponent"), skill: 15 }
        ];
    }

    /* --------------------------- seat helpers ------------------------- */

    #isAiSeat(id) { return this.seatById[id]?.kind === "ai"; }
    #aiSkill(id) { return this.seatById[id]?.skill ?? 15; }
    #seatName(id) { return this.seatById[id]?.name ?? game.i18n.localize("WITCHER.Farkle.opponent"); }

    /** This client drives AI seats? Locally in solo; the active GM in a table. */
    #isAiDriver() { return this.mode === "solo" ? true : game.user.isActiveGM; }

    /** Highest banked score among seats other than `seat` (the leader to chase). */
    #bestOpponentBanked(seat) {
        let best = 0;
        for (const s of this.seatIds) if (s !== seat) best = Math.max(best, this.match.banked[s]);
        return best;
    }

    /** Pinned beneath other windows: clicking it must never raise it above an
     *  actor sheet the user opened on top. CSS holds the low z-index; this stops
     *  the framework from reassigning a higher one on focus. */
    bringToFront() {}

    /** We own our geometry entirely (see #fitToStage). The framework re-applies
     *  position AFTER _onRender on every render, and our DEFAULT height:"auto"
     *  makes it collapse the element to content height and re-centre it — which
     *  folds the board the moment a parts re-render lands (e.g. after the dice
     *  settle). No-op it so our inline fit is never clobbered. */
    setPosition() { return this.position; }

    #refresh() {
        if (this._closed) return Promise.resolve(this);
        // The "stage" PART holds the GL canvas — never re-render it (that would
        // tear down the WebGL context). The board is driven imperatively.
        return this.render({ parts: ["status", "controls"] });
    }

    /* ----------------------------- lifecycle -------------------------- */

    #startMatch() {
        const players = {};
        for (const id of this.seatIds) players[id] = { purse: this.cfg.purse };
        this.match = new FarkleMatch({
            players, seats: this.seatIds,
            target: this.cfg.target, ante: this.cfg.ante, starter: this.starter
        });
        this.log = [];
        this._selValues = [];
        this._oppDice = [];
        this._freshHand = true;
        this._oppFresh = true;
        this._armToken = null;
        this._seq = 0;
        this._resultAnnounced = false;
        this.#say("WITCHER.Farkle.log.newMatch", { ante: this.cfg.ante, target: this.cfg.target });
    }

    #rollN(n) {
        return Array.from({ length: n }, () => 1 + Math.floor(this.rng() * 6));
    }

    /** Skin the board to a seat's chosen dice (idempotent per seat). */
    #skinFor(seat) {
        if (!this.board || this._skinSeat === seat) return;
        this._skinSeat = seat;
        this.board.setDieProfiles(this.seatDice?.[seat] ?? null);
    }

    #say(key, data = {}) {
        this.log.push(game.i18n.format(key, data));
    }

    /* ----------------------- input application ------------------------ */

    #apply(event, args) {
        const m = this.match;
        switch (event) {
            case "submitRoll": m.submitRoll(args.seat, args.values); break;
            case "setAside": m.setAside(args.seat, args.values); break;
            case "rollAgain": m.rollAgain(args.seat); break;
            case "bank": m.bank(args.seat); break;
            case "forfeit": m.forfeit(args.seat); break;
        }
        this._seq++;
        this.#broadcastState();
    }

    /** GM authority (table only): push the canonical match state to everyone,
     *  stamped with a rising seq so receivers can drop anything stale. */
    #broadcastState() {
        if (!this.isTable || !game.user.isActiveGM || !this.match) return;
        this._stateSeq++;
        // `mseq` is the GM's applied-move count (every client increments `_seq`
        // on each applied move, so it's a shared logical clock). Receivers adopt
        // a snapshot only when its mseq is AHEAD of their own — i.e. they've
        // missed a move — so a snapshot can never roll a client back over a move
        // it already applied. `seq` is the broadcast order, used only to discard
        // a network-reordered older snapshot.
        send({ matchId: this.matchId, to: null, sub: "state",
            payload: { seq: this._stateSeq, mseq: this._seq, snap: this.match.snapshot() } });
    }

    /** Relay a move to peers: point-to-point in pvp, broadcast in a table. */
    #relay(event, args) {
        if (this.isPvp) send({ matchId: this.matchId, to: this.opponentUserId, sub: "move", payload: { event, args } });
        else if (this.isTable) send({ matchId: this.matchId, to: null, sub: "move", payload: { event, args } });
    }

    /** GM (table only): pay the pot to the winner and close the shared table. */
    #maybeSettle() {
        if (!this.isTable || !game.user.isActiveGM) return;
        const winner = this.match.result?.winner;
        if (winner) settleAndClose(winner);
    }

    /** After a locally-applied move, drive any AI seat whose turn it now is
     *  (only on the client that owns AI). Otherwise just refresh and wait for
     *  the controlling client to relay the next move. */
    #advance() {
        if (this.match.phase === "done") { this.#logResult(); this.#maybeSettle(); return this.#refresh(); }
        if (this.#isAiSeat(this.match.toAct) && this.#isAiDriver()) {
            this.#refresh();
            return this.#runAiTurns();
        }
        return this.#refresh();
    }

    /* --------------------------- human moves -------------------------- */

    async #humanRoll(values, { relayed = false } = {}) {
        const me = this.mySeat;
        this._selValues = [];
        // When relayed === true the say + #relay already went out at launch
        // (#onBoardThrow); here we only need to apply the outcome locally.
        if (!relayed) {
            this.#say("WITCHER.Farkle.log.youRolled", { dice: values.join("  ") });
            this.#relay("submitRoll", { seat: me, values });
        }
        this.#apply("submitRoll", { seat: me, values });
        if (this.match.toAct !== me) {
            this._freshHand = true; // farkle: turn passes, next own roll is fresh
            this._oppFresh = true;  // the next seat's turn begins fresh
            this.#say("WITCHER.Farkle.log.youFarkle");
            await this.#announceFarkle(); // red tint + "Farkle!" banner on my own bust
        }
        return this.#advance();
    }

    #humanSetAside(values) {
        const { valid, points } = scoreSelection(values);
        if (!valid || points === 0) {
            return ui.notifications.warn(game.i18n.localize("WITCHER.Farkle.warn.invalidSelection"));
        }
        this.#apply("setAside", { seat: this.mySeat, values });
        // `live: true` tells spectators the picks were already streamed (see
        // #onBoardSelect), so they confirm-and-commit instead of re-animating.
        this.#relay("setAside", { seat: this.mySeat, values, live: true });
        this.board?.commitSelection();
        this._selValues = [];
        this.#say("WITCHER.Farkle.log.youSetAside", { pts: points, total: this.match.turnTotal });
        if (this.match.hotDice) this.#say("WITCHER.Farkle.log.hotDice");
        return this.#advance();
    }

    #humanRollAgain() {
        // Hot dice → fresh six; otherwise re-throw only the dice still in hand.
        this._freshHand = this.match.hotDice;
        this.#apply("rollAgain", { seat: this.mySeat });
        this.#relay("rollAgain", { seat: this.mySeat });
        return this.#advance();
    }

    #humanBank() {
        const gained = this.match.turnTotal;
        this._freshHand = true;
        this._oppFresh = true; // the next seat's turn begins fresh
        this.#apply("bank", { seat: this.mySeat });
        this.#relay("bank", { seat: this.mySeat });
        if (this.match.phase !== "done") this.#say("WITCHER.Farkle.log.youBanked", { pts: gained, total: this.match.banked[this.mySeat] });
        return this.#advance();
    }

    /* ----------------------------- AI turns --------------------------- */

    /** Drive every consecutive AI seat from the seat currently in `toAct` until
     *  the turn returns to a human (or the match ends). Only the AI-driver client
     *  runs this; each move is relayed so all clients replay it. */
    async #runAiTurns() {
        if (this._aiBusy || !this.#isAiDriver()) return;
        this._aiBusy = true;
        const m = this.match;
        this.board?.disableBoard();
        let guard = 0;
        while (this.#isAiSeat(m.toAct) && m.phase !== "done" && !this._closed && guard++ < 480) {
            const ai = m.toAct, skill = this.#aiSkill(ai);
            let fresh = true;
            while (m.toAct === ai && m.phase !== "done" && !this._closed && guard++ < 480) {
                if (m.phase === "roll") {
                    // Relay-at-launch: draw the outcome up-front (set the board up
                    // first so the throwable set matches), relay + apply + push the
                    // snapshot the INSTANT the throw launches, then animate locally.
                    // Peers animate their own copy in parallel instead of waiting
                    // for this client's physics to settle, so the roll looks synced.
                    this.#skinFor(ai);
                    const b = this.board;
                    if (b) { if (fresh) b.newTurn(); else b.prepareReroll(); }
                    const values = b ? b.drawInHandValues(this.rng) : this.#rollN(m.diceInHand);
                    this._oppDice = values;
                    this.#relay("submitRoll", { seat: ai, values });
                    m.submitRoll(ai, values); this._seq++;
                    this.#say("WITCHER.Farkle.log.npcRolled", { dice: values.join("  ") });
                    this.#broadcastState();
                    this.#refresh();
                    await this.#npcThrowTo(values);   // local cosmetic tumble onto the drawn faces
                    if (m.toAct !== ai) {
                        this.#say("WITCHER.Farkle.log.npcFarkle");
                        await this.#announceFarkle();
                    }
                    fresh = false;
                    continue;
                }
                if (m.phase === "select") {
                    const keep = chooseSetAside(m.lastRoll, { skill, rng: this.rng });
                    const pts = scoreSelection(keep).points;
                    // Relay-at-launch: peers animate the same pick in parallel.
                    this.#relay("setAside", { seat: ai, values: keep });
                    m.setAside(ai, keep); this._seq++;
                    this.#say("WITCHER.Farkle.log.npcSetAside", { pts, total: m.turnTotal });
                    if (m.hotDice) { this.#say("WITCHER.Farkle.log.hotDice"); fresh = true; }
                    this.#broadcastState();
                    this.#refresh();
                    await this.#animateOppSelect(keep);       // pick the scorers one by one
                    this.board?.commitSelection();           // freeze the scored dice
                    const cont = decideContinue({
                        turnTotal: m.turnTotal, diceLeft: m.diceInHand,
                        banked: m.banked[ai], oppBanked: this.#bestOpponentBanked(ai),
                        target: m.target, skill, rng: this.rng
                    });
                    if (cont) {
                        this.#relay("rollAgain", { seat: ai });
                        m.rollAgain(ai); this._seq++;
                        this.#broadcastState();
                    } else {
                        const gained = m.turnTotal;
                        this.#relay("bank", { seat: ai });
                        m.bank(ai); this._seq++;
                        this.#broadcastState();
                        if (m.phase !== "done") this.#say("WITCHER.Farkle.log.npcBanked", { pts: gained, total: m.banked[ai] });
                    }
                    this.#refresh();
                    await this.#wait(NPC_STEP_MS);
                }
            }
            this._oppFresh = true; // the next seat (AI or human) begins fresh
        }
        this._aiBusy = false;
        this._oppDice = [];
        this._freshHand = true; // turn returns to the player as a fresh hand
        if (m.phase === "done") { this.#logResult(); this.#maybeSettle(); }
        return this.#refresh();
    }

    /** Animate one NPC throw onto already-drawn faces (the outcome was relayed at
     *  launch). The throw is predetermined, so the dice rest on exactly `values`
     *  — no post-land re-orient. Set up the board (newTurn/prepareReroll) BEFORE
     *  calling this. */
    #npcThrowTo(values) {
        const b = this.board;
        if (!b) return this.#wait(NPC_STEP_MS);
        return new Promise(resolve => {
            this._boardSettleResolve = resolve;
            b.autoThrow(values);   // land on exactly the relayed faces (no post-land snap)
        }).then(() => this.#wait(300));
    }

    #wait(ms) { return new Promise(r => setTimeout(r, ms)); }

    /** Animate the opponent (NPC or PvP) picking its scoring dice one at a time,
     *  so the player sees each die light up as if a real player were choosing. */
    async #animateOppSelect(values) {
        const b = this.board;
        if (!b) { await this.#wait(NPC_STEP_MS); return; }
        b.clearSelection();
        for (const v of values) {
            b.selectOne(v);
            await this.#wait(OPP_PICK_MS);
        }
        await this.#wait(300); // hold the bright selection a beat before it commits
    }

    /** Flash a large message over the board (e.g. FARKLE). The stage PART is
     *  never re-rendered, so the banner element is created/toggled imperatively. */
    async #flashBanner(text, variant = "", ms = 1400) {
        const wrap = this.element?.querySelector(".wdm-fk-board-wrap");
        if (!wrap) { await this.#wait(ms); return; }
        let el = wrap.querySelector(".wdm-fk-board-banner");
        if (!el) {
            el = document.createElement("div");
            el.className = "wdm-fk-board-banner";
            wrap.appendChild(el);
        }
        el.textContent = text;
        el.dataset.variant = variant;
        el.classList.add("wdm-fk-banner-show");
        await this.#wait(ms);
        el.classList.remove("wdm-fk-banner-show");
    }

    /** Make an opponent farkle unmistakable: red dice + a FARKLE banner. */
    async #announceFarkle() {
        this.board?.setDiceTint(0x7a1410);
        await this.#flashBanner(game.i18n.localize("WITCHER.Farkle.board.farkle"), "farkle", 1500);
        this.board?.clearDiceTint();
    }

    /* ----------------------------- PvP -------------------------------- */

    onNetMessage(data) {
        switch (data.sub) {
            case "accept":
                this.connected = true;
                this.opponentName = data.payload?.name ?? this.opponentName;
                this.#say("WITCHER.Farkle.log.joined", { name: this.opponentName });
                this.#refresh();
                break;
            case "decline":
                ui.notifications.info(game.i18n.format("WITCHER.Farkle.invite.declined", { name: this.opponentName }));
                this.close();
                break;
            case "abort":
                this.#say("WITCHER.Farkle.log.opponentLeft", { name: this.opponentName });
                this.connected = false;
                this.#refresh();
                break;
            case "endTable":
                // GM cancelled the table mid-game; antes are refunded GM-side.
                ui.notifications.info(game.i18n.localize("WITCHER.Farkle.lobby.cancelled"));
                this.close();
                break;
            case "move":
                // Serialize moves so an in-flight board animation finishes
                // before the next relayed input is applied.
                this._moveQueue = (this._moveQueue ?? Promise.resolve())
                    .then(() => this.#applyRemoteMove(data.payload))
                    .catch(err => console.error("Farkle | remote move failed", err));
                break;
            case "state":
                // Authoritative snapshot from the GM — adopt it (queued after any
                // in-flight animation so it doesn't tear a move mid-flight).
                this._moveQueue = (this._moveQueue ?? Promise.resolve())
                    .then(() => this.#applyRemoteState(data.payload))
                    .catch(err => console.error("Farkle | state sync failed", err));
                break;
            case "sel":
                // Live (uncommitted) selection preview from the acting seat —
                // mirror the glow so spectators watch the picks in real time,
                // not only at commit. Transient/cosmetic: NOT queued, no state.
                this.#mirrorSelectPreview(data.payload);
                break;
            case "hello":
                // A client just opened/reconnected; (re)send it the truth.
                if (game.user.isActiveGM && this.isTable) this.#broadcastState();
                break;
        }
    }

    /** Adopt the GM's authoritative snapshot whenever it is AHEAD of our local
     *  move clock — i.e. we've missed a relayed move (a dropped packet, a join
     *  mid-match, or a move that lost a snapshot/relay race). This self-heals a
     *  desynced client (notably a spectator watching AI turns) without ever
     *  rolling an active player back: a snapshot whose mseq is ≤ our own `_seq`
     *  reflects a state we've already reached locally, so we ignore it. The GM
     *  is the authority and never adopts. */
    async #applyRemoteState({ seq, mseq, snap }) {
        if (game.user.isActiveGM || !snap) return;
        // Discard a network-reordered older broadcast.
        if (typeof seq === "number" && seq <= this._lastStateSeq) return;
        // Only adopt when the GM is ahead of us; equal/behind means we're in sync
        // (or our local moves are newer and the next snapshot will confirm them).
        if (typeof mseq === "number" && mseq <= this._seq) return;
        this._lastStateSeq = seq ?? this._lastStateSeq;
        this._seq = mseq ?? this._seq;
        this.match.restore(snap);
        this._armToken = null;   // force #syncBoard to re-evaluate for the new state
        return this.#refresh();  // _onRender re-arms the board + HUD from the snapshot
    }

    /** Has this relayed move already been applied locally (e.g. an adopted
     *  snapshot advanced us past it, or it's a duplicate)? If the current phase
     *  no longer matches the move's precondition, applying it would trip the
     *  engine's asserts — so skip it. A genuinely-missed earlier move is healed
     *  by the next snapshot, not by a premature later move, so skipping is safe. */
    #moveIsStale(event, seat) {
        const m = this.match;
        if (event === "forfeit") return false;       // forfeit no-ops on its own
        if (m.toAct !== seat) return true;           // turn already moved on
        switch (event) {
            case "submitRoll": return m.phase !== "roll";
            case "setAside":   return m.phase !== "select";
            case "rollAgain":
            case "bank":       return m.phase !== "decide";
            default:           return false;
        }
    }

    async #applyRemoteMove({ event, args }) {
        const m = this.match;
        const seat = args.seat;
        if (this.#moveIsStale(event, seat)) return this.#afterRemoteMove();
        this._oppAnimating = true; // board is driven by this handler, not #syncBoard
        try {
            if (event === "submitRoll") {
                this._oppDice = args.values;
                this.#say("WITCHER.Farkle.log.oppRolled", { dice: args.values.join("  "), name: this.#seatName(seat) });
                // Cosmetic tumble, then resolve the dice to the relayed faces.
                await this.#animateOppThrow(args.values, this._oppFresh, seat);
                this._oppFresh = false;
                this.#apply(event, args);
                if (m.toAct !== seat) {   // farkle: the turn passed
                    this.#say("WITCHER.Farkle.log.oppFarkle");
                    await this.#announceFarkle();
                    this.board?.disableBoard();
                    this._oppFresh = true; // the next seat begins fresh
                }
            } else if (event === "setAside") {
                if (args.live) {
                    // Picks were already mirrored live (see #mirrorSelectPreview);
                    // just confirm the final set instantly and commit — no slow
                    // re-animation (which would clear then re-glow and look like a
                    // hitch right before the dice are set aside).
                    this.board?.clearSelection();
                    for (const v of args.values) this.board?.selectOne(v);
                    await this.#wait(250);
                } else {
                    await this.#animateOppSelect(args.values);   // pick the scorers one by one
                }
                this.#apply(event, args);
                this.board?.commitSelection();
                this.#say("WITCHER.Farkle.log.oppSetAside", { pts: scoreSelection(args.values).points, total: m.turnTotal });
                if (m.hotDice) this._oppFresh = true;
            } else {
                this.#apply(event, args);
                if (event === "bank") {
                    if (m.phase !== "done") this.#say("WITCHER.Farkle.log.oppBanked", { total: m.banked[seat], name: this.#seatName(seat) });
                    this._oppFresh = true; // the next seat begins fresh
                }
            }
        } finally {
            this._oppAnimating = false;
        }
        return this.#afterRemoteMove();
    }

    /** Shared tail for an applied (or skipped-stale) remote move: hand the board
     *  back to the local player if it's now their turn, settle a finished match,
     *  pick up any AI seat this client drives, and re-render. */
    #afterRemoteMove() {
        const m = this.match;
        if (m.toAct === this.mySeat) {
            this._oppDice = [];
            this._freshHand = true; // turn returns to me as a fresh hand
            this._oppFresh = true;
        }
        if (m.phase === "done") { this.#logResult(); this.#maybeSettle(); }
        // If the turn passed to an AI seat I drive, take it over.
        if (m.phase !== "done" && this.#isAiSeat(m.toAct) && this.#isAiDriver() && !this._aiBusy) {
            this.#refresh();
            return this.#runAiTurns();
        }
        return this.#refresh();
    }

    /** Cosmetic opponent throw: tumble the board dice onto the relayed faces.
     *  The throw is predetermined (autoThrow(values) records-then-replays onto
     *  exactly `values`), so the dice already rest on the right faces — no
     *  post-land re-orient, which would visibly re-randomise their yaw. */
    async #animateOppThrow(values, fresh, seat) {
        const b = this.board;
        if (!b) return;
        this.#skinFor(seat);
        if (fresh) b.newTurn(); else b.prepareReroll();
        await new Promise(resolve => {
            this._boardSettleResolve = resolve;
            b.autoThrow(values);    // land on the relayed faces (no post-land snap)
        });
        await this.#wait(300);
    }

    /* ----------------------------- logging ---------------------------- */

    #logResult() {
        const r = this.match.result;
        if (!this.mySeat) {
            this.#say("WITCHER.Farkle.log.winner", { name: this.#seatName(r.winner), pot: r.pot });
        } else {
            const won = r.winner === this.mySeat;
            this.#say(won ? "WITCHER.Farkle.log.youWin" : "WITCHER.Farkle.log.youLose", { pot: r.pot });
        }
        this.#announceResult();
    }

    /** Big celebratory (or commiserating) banner over the board when the match
     *  ends. Fires once per match. */
    #announceResult() {
        if (this._resultAnnounced) return;
        this._resultAnnounced = true;
        const r = this.match.result;
        if (!r) return;
        if (!this.mySeat) {
            this.#flashBanner(game.i18n.format("WITCHER.Farkle.banner.winner",
                { name: this.#seatName(r.winner) }), "win", 3000);
        } else if (r.winner === this.mySeat) {
            this.#flashBanner(game.i18n.localize("WITCHER.Farkle.banner.youWin"), "win", 3200);
        } else {
            this.#flashBanner(game.i18n.localize("WITCHER.Farkle.banner.youLose"), "lose", 2400);
        }
    }

    /* ----------------------------- context ---------------------------- */

    /** Values clicked on the 3D board this throw (drives the Set Aside button). */
    #currentSelectionValues() {
        return this._selValues.slice();
    }

    /* ----------------------------- 3D board --------------------------- */

    _onRender(context, options) {
        super._onRender?.(context, options);
        // A non-GM table client (seat-holder, reconnect, or spectator) asks the
        // GM for the canonical state once, on first mount — so it catches up to
        // a match already in progress instead of showing a fresh board.
        if (this.isTable && !game.user.isActiveGM && !this._helloSent) {
            this._helloSent = true;
            send({ matchId: this.matchId, to: null, sub: "hello" });
        }
        const mountedStage = options.parts?.includes("stage") || !this.board;
        if (mountedStage) this.#mountBoard();
        this.#installFitHooks();
        // Only the stage (re)mount needs the multi-frame fit cascade (catch the
        // chrome bars settling). Routine status/controls refreshes — e.g. right
        // after a throw settles — just need one cheap re-fit, which is a no-op
        // when the size is unchanged, so they don't churn the GL buffer / flicker.
        if (mountedStage) this.#scheduleFit(); else this.#fitToStage();
        this.#syncBoard();
        this.#maybeDriveAi();
        this.#updateBoardPrompt();
    }

    /** Kick off AI turns when it's an AI seat's turn and this client owns AI
     *  (the starter is an AI, or a render landed on an AI turn). Idempotent —
     *  #runAiTurns guards re-entry with `_aiBusy`. */
    #maybeDriveAi() {
        const m = this.match;
        if (m.phase === "done" || this._aiBusy) return;
        if (this.#isAiSeat(m.toAct) && this.#isAiDriver()) this.#runAiTurns();
    }

    /** Phase hint shown over the board. */
    #boardPromptText() {
        const m = this.match;
        if (m.phase === "done") return "";
        if (m.toAct !== this.mySeat) return game.i18n.localize("WITCHER.Farkle.wait.opponentTurn");
        if (m.phase === "roll") return game.i18n.localize("WITCHER.Farkle.board.rollHint");
        if (m.phase === "select") return game.i18n.localize("WITCHER.Farkle.board.selectHint");
        if (m.phase === "decide") return game.i18n.localize("WITCHER.Farkle.board.decideHint");
        return "";
    }

    /** The stage PART never re-renders, so refresh the prompt text in place. */
    #updateBoardPrompt() {
        const el = this.element?.querySelector(".wdm-fk-board-prompt");
        if (el) el.textContent = this.#boardPromptText();
    }

    #mountBoard() {
        const canvas = this.element.querySelector(".wdm-fk-board-canvas");
        if (!canvas || (this.board && this.board.canvas === canvas)) return;
        this.board?.dispose();
        this._armToken = null;
        this.board = new DiceBoard3D({
            canvas, width: BOARD_W, height: BOARD_H, dieCount: 6,
            onThrow: (values) => this.#onBoardThrow(values),
            onSettled: () => this.#onBoardSettled(),
            onSelectChange: (values) => this.#onBoardSelect(values)
        });
    }

    /** Scan the whole page for the chrome bars actually pinned to each viewport
     *  edge and return how far each intrudes. This is element-id agnostic: it
     *  finds whatever bar (Foundry's or this system's) hugs the top/bottom/left/
     *  right edge, ignoring full-screen layers (the scene canvas, our own
     *  overlay) and anything too large to be a bar. */
    #chromeInsets(vw, vh) {
        const mine = this.element;
        const ins = { top: 0, bottom: 0, left: 0, right: 0 };
        const MAXBAND = 0.45;             // a bar occupies < 45% of the axis
        const NEAR = 6;                   // px tolerance for "pinned to the edge"
        for (const e of document.body.querySelectorAll("*")) {
            if (e === mine || mine?.contains(e) || e.contains(mine)) continue;
            const cs = getComputedStyle(e);
            if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0) continue;
            const r = e.getBoundingClientRect();
            if (r.width < 8 || r.height < 8) continue;

            // Horizontal bars (top / bottom): wide and short.
            if (r.width >= vw * 0.18 && r.height <= vh * MAXBAND) {
                if (r.top <= NEAR && r.bottom > ins.top) ins.top = r.bottom;
                if (r.bottom >= vh - NEAR && (vh - r.top) > ins.bottom) ins.bottom = vh - r.top;
            }
            // Vertical bars (left / right): tall and narrow.
            if (r.height >= vh * 0.18 && r.width <= vw * MAXBAND) {
                if (r.left <= NEAR && r.right > ins.left) ins.left = r.right;
                if (r.right >= vw - NEAR && (vw - r.left) > ins.right) ins.right = vw - r.left;
            }
        }
        return ins;
    }

    /** Size and position the overlay to fill the central scene area BETWEEN the
     *  visible chrome bars on all four edges (see #chromeInsets). The square felt
     *  renders letterboxed-centered inside whatever rectangle results. */
    #fitToStage() {
        const el = this.element;
        if (!el) return;
        const vw = window.innerWidth, vh = window.innerHeight;
        // Only the top/bottom bars matter: the board is a centered square sized
        // to the available height, so it can never reach the left/right bars.
        const { top: t, bottom: b } = this.#chromeInsets(vw, vh);

        const width = vw;
        const height = Math.max(0, vh - t - b);
        // Reject degenerate measurements: a transient frame (mid-render, or a
        // chrome panel animating open/closed) can momentarily report a "bar"
        // spanning most of the height, which would fold the board onto itself.
        // No real chrome layout leaves the centre stage under 15% tall — so keep
        // the last good size and retry next frame instead of collapsing.
        if (height < vh * 0.15) {
            if (!this._closed) requestAnimationFrame(() => { if (!this._closed) this.#fitToStage(); });
            return;
        }

        const s = el.style;
        s.setProperty("top", `${t}px`, "important");
        s.setProperty("left", `0px`, "important");
        s.setProperty("width", `${width}px`, "important");
        s.setProperty("height", `${height}px`, "important");

        // The board-wrap is a centered square (height-sized). Its horizontal
        // margins are --fk-pad-x, which the HUD text anchors to so it hugs the
        // board rather than the far window edges.
        const square = Math.min(width, height);
        s.setProperty("--fk-pad-x", `${Math.max(0, (width - square) / 2)}px`);
        s.setProperty("--fk-pad-y", `${Math.max(0, (height - square) / 2)}px`);

        this.board?.setSize(square, square);
    }

    /** Keep the overlay fitted as the viewport/chrome changes. The initial open
     *  fires before Foundry finishes laying out the bars, so we also re-fit on
     *  the next frames and whenever the nav/hotbar/sidebar (re)render. */
    #installFitHooks() {
        if (this._fitBound) return;
        this._fitBound = () => this.#fitToStage();
        window.addEventListener("resize", this._fitBound);
        // Only the top/bottom bars affect the fit now.
        this._fitHookIds = [
            ["renderSceneNavigation", Hooks.on("renderSceneNavigation", this._fitBound)],
            ["renderHotbar", Hooks.on("renderHotbar", this._fitBound)]
        ];
        // Watch the top/bottom layout zones directly: any resize → re-fit
        // (rAF-throttled) so the nav/hotbar appearing or changing is tracked.
        let queued = false;
        const obs = new ResizeObserver(() => {
            if (queued) return;
            queued = true;
            requestAnimationFrame(() => { queued = false; if (!this._closed) this.#fitToStage(); });
        });
        for (const id of ["ui-top", "ui-bottom", "interface"]) {
            const e = document.getElementById(id);
            if (e) obs.observe(e);
        }
        this._fitObserver = obs;

        // Chrome panels (inventory, character, map, …) are body-level overlays
        // toggled via `wou-*-open` body classes — they don't resize #interface,
        // so the ResizeObserver above never sees them open/close. Their close
        // animation can leave a transient bad inset that folds the board, with
        // no later event to correct it. Watch only the chrome-panel open flags
        // (not every body class change, which would catch unrelated transient
        // frames) and re-run the multi-frame fit cascade so the board settles
        // once the panel finishes animating.
        const chromeOpenFlags = () => Array.from(document.body.classList)
            .filter(c => c.startsWith("wou-") && c.endsWith("-open")).sort().join(" ");
        this._lastChromeFlags = chromeOpenFlags();
        const bodyObs = new MutationObserver(() => {
            const flags = chromeOpenFlags();
            if (flags === this._lastChromeFlags) return;
            this._lastChromeFlags = flags;
            if (!this._closed) this.#scheduleFit();
        });
        bodyObs.observe(document.body, { attributes: true, attributeFilter: ["class"] });
        this._bodyClassObserver = bodyObs;
    }

    /** Re-fit across the next few frames so we catch the bars once Foundry has
     *  finished positioning them after our window opens. */
    #scheduleFit() {
        this.#fitToStage();
        requestAnimationFrame(() => { if (!this._closed) this.#fitToStage(); });
        for (const ms of [60, 200, 500]) {
            setTimeout(() => { if (!this._closed) this.#fitToStage(); }, ms);
        }
    }

    /** Arm the board for the current phase exactly once per phase transition.
     *  Skipped while an opponent animation is driving the board directly. */
    #syncBoard() {
        const b = this.board;
        if (!b || this._aiBusy || this._oppAnimating) return;
        const token = `${this.match.phase}|${this.match.toAct}|${this._seq}`;
        if (this._armToken === token) return;
        this._armToken = token;
        if (this.match.toAct === this.mySeat && this.match.phase === "roll") {
            this.#skinFor(this.mySeat);
            if (this._freshHand) b.newTurn(); else b.prepareReroll();
        } else if (this.match.toAct === this.mySeat && this.match.phase === "select") {
            b.enterSelect();
        } else {
            b.disableBoard();
        }
    }

    /** The player's throw has LAUNCHED. The outcome is predetermined at launch,
     *  so relay it to spectators immediately — they animate the same throw in
     *  parallel instead of waiting ~3s for this client to settle and submit. */
    #onBoardThrow(values) {
        const m = this.match;
        if (m.toAct !== this.mySeat || m.phase !== "roll") return;
        this._pendingRoll = values;
        this.#say("WITCHER.Farkle.log.youRolled", { dice: values.join("  ") });
        this.#relay("submitRoll", { seat: this.mySeat, values });
    }

    /** A throw has settled. If an opponent animation is awaiting it, hand off
     *  to that resolver; otherwise it's the human's roll → apply it locally
     *  (the relay already went out at launch in #onBoardThrow). */
    #onBoardSettled() {
        if (this._boardSettleResolve) {
            const done = this._boardSettleResolve;
            this._boardSettleResolve = null;
            done();
            return;
        }
        const m = this.match;
        if (m.toAct === this.mySeat && m.phase === "roll") {
            // The values were drawn and relayed at launch; settle just applies
            // the same outcome locally (the shown result never changed on landing).
            const values = this._pendingRoll ?? this.board.readLiveValues().values;
            this._pendingRoll = null;
            // Lock the board immediately: between this settle and the async
            // re-arm into select mode, the dice must not be grabbable/re-throwable
            // (#syncBoard re-enables interactivity when it arms enterSelect).
            this.board.disableBoard();
            this.#humanRoll(values, { relayed: true });
        }
    }

    /** Player toggled a die selection on the board. */
    #onBoardSelect(values) {
        this._selValues = values;
        // Stream the live (uncommitted) selection to peers so spectators see each
        // die light up as I click it, rather than only when I commit (setAside).
        if ((this.isPvp || this.isTable) && this.match.toAct === this.mySeat) {
            const payload = { seat: this.mySeat, values };
            if (this.isPvp) send({ matchId: this.matchId, to: this.opponentUserId, sub: "sel", payload });
            else send({ matchId: this.matchId, to: null, sub: "sel", payload });
        }
        if (!this._closed) this.render({ parts: ["controls"] });
    }

    /** Mirror a peer's live selection preview onto the board (spectator side).
     *  Each message carries the FULL current selection, so clear + re-glow is
     *  idempotent and order-independent. Cosmetic only — never touches state. */
    #mirrorSelectPreview({ seat, values } = {}) {
        if (!this.board || seat == null || seat === this.mySeat) return;
        if (this._oppAnimating || this.match.toAct !== seat) return; // stale / mid-tumble
        this.board.clearSelection();
        for (const v of values ?? []) this.board.selectOne(v);
    }

    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        const m = this.match;
        const mine = this.mySeat;
        const myTurn = mine != null && m.toAct === mine;
        const turnPtsOf = id => (m.toAct === id && m.phase !== "done") ? m.turnTotal : 0;

        ctx.target = m.target;
        ctx.pot = m.pot;
        ctx.turnTotal = m.turnTotal;
        ctx.diceInHand = m.diceInHand;

        // My seat's tallies (null when observing a table without a seat).
        ctx.me = mine ? {
            name: game.i18n.localize("WITCHER.Farkle.you"),
            banked: m.banked[mine],
            turnPts: myTurn ? m.turnTotal : 0,
            active: myTurn
        } : null;
        // Every other seat (2–4 total): rendered around the board.
        const forfeited = m.forfeited ?? [];
        ctx.others = this.seatIds.filter(s => s !== mine).map(s => ({
            id: s,
            name: this.#seatName(s),
            isAI: this.#isAiSeat(s),
            banked: m.banked[s],
            turnPts: turnPtsOf(s),
            forfeited: forfeited.includes(s),
            active: m.toAct === s && m.phase !== "done" && !forfeited.includes(s)
        }));
        // Spread the opponent readouts so the top-right corner doesn't pile up:
        // the first opponent sits top-right, any remaining ones stack on the left.
        ctx.oppTopRight = ctx.others.slice(0, 1);
        ctx.oppLeft     = ctx.others.slice(1);

        ctx.log = this.log.slice(-3);
        ctx.connecting = this.isPvp && !this.connected;

        const sel = this.#currentSelectionValues();
        const selScore = sel.length ? scoreSelection(sel) : { valid: false, points: 0 };
        ctx.selectionValid = selScore.valid;
        ctx.selectionPoints = selScore.points;
        ctx.bestAvailable = m.phase === "select" ? bestScoreFull(m.lastRoll) : 0;

        ctx.myTurn = myTurn;
        ctx.showRoll = myTurn && m.phase === "roll";
        ctx.showSelect = myTurn && m.phase === "select";
        ctx.showDecide = myTurn && m.phase === "decide";
        ctx.showResult = m.phase === "done";
        ctx.waitOpponent = !myTurn && m.phase !== "done";
        ctx.canNewGame = this.mode === "solo";

        // Leave controls: any seated player in a networked game may Forfeit their
        // own seat — including a GM who is also playing. The GM additionally gets
        // End table (refunds everyone). Solo/spectator just closes.
        ctx.isSolo = this.mode === "solo";
        ctx.canEndTable = this.isTable && game.user.isActiveGM && m.phase !== "done";
        ctx.canForfeit = this.isTable && mine != null && m.phase !== "done";
        ctx.showClose = !ctx.canEndTable && !ctx.canForfeit;

        ctx.boardW = BOARD_W;
        ctx.boardH = BOARD_H;

        if (m.phase === "done") {
            ctx.result = {
                won: mine != null && m.result.winner === mine,
                pot: m.result.pot,
                winnerName: this.#seatName(m.result.winner)
            };
        }

        // Always non-empty at open so the prompt element exists for in-place
        // updates later (the stage PART is never re-rendered).
        ctx.boardPrompt = this.#boardPromptText() || " ";
        return ctx;
    }

    /* ----------------------------- lifecycle -------------------------- */

    async _onClose(options) {
        this._closed = true;
        if (this._fitBound) {
            window.removeEventListener("resize", this._fitBound);
            for (const [name, id] of this._fitHookIds ?? []) Hooks.off(name, id);
            this._fitHookIds = null;
            this._fitObserver?.disconnect();
            this._fitObserver = null;
            this._bodyClassObserver?.disconnect();
            this._bodyClassObserver = null;
            this._fitBound = null;
        }
        this.board?.dispose();
        this.board = null;
        if (this.isPvp) {
            send({ matchId: this.matchId, to: this.opponentUserId, sub: "abort" });
            unregisterTable(this.matchId);
        } else if (this.isTable) {
            unregisterTable(this.matchId);
        }
        if (this.isTable) notifyLiveClosed();
        return super._onClose(options);
    }

    /* --------------------------- action handlers ---------------------- */

    static #onSetAside(event, target) {
        if (!(this.match.toAct === this.mySeat && this.match.phase === "select")) return;
        this.#humanSetAside(this.#currentSelectionValues());
    }

    static #onRollAgain(event, target) {
        if (!(this.match.toAct === this.mySeat && this.match.phase === "decide")) return;
        this.#humanRollAgain();
    }

    static #onBank(event, target) {
        if (!(this.match.toAct === this.mySeat && this.match.phase === "decide")) return;
        this.#humanBank();
    }

    static #onNewGame(event, target) {
        if (this.mode !== "solo") return;
        if (this.match.players[this.mySeat].purse < this.cfg.ante) this.cfg.purse = DEFAULTS.purse;
        this.#startMatch();
        this.#refresh();
    }

    static async #onShowRules(event, target) {
        const die = v => `<span class="wdm-fk-die">${PIP_FACES[v].map(c => `<span class="wdm-fk-pip wdm-fk-pip-${c}"></span>`).join("")}</span>`;
        const dice = arr => `<span class="wdm-fk-rules-dice">${arr.map(die).join("")}</span>`;
        const combos = [
            { eg: [1], k: "single1" },
            { eg: [5], k: "single5" },
            { eg: [2, 2, 2], k: "threeN" },
            { eg: [1, 1, 1], k: "three1" },
            { eg: [3, 3, 3, 3], k: "fourKind" },
            { eg: [4, 4, 4, 4, 4], k: "fiveKind" },
            { eg: [6, 6, 6, 6, 6, 6], k: "sixKind" },
            { eg: [1, 2, 3, 4, 5, 6], k: "straight" },
            { eg: [2, 2, 4, 4, 6, 6], k: "threePairs" },
            { eg: [2, 2, 2, 5, 5, 5], k: "twoTriplets" },
            { eg: [3, 3, 3, 3, 6, 6], k: "fourPlusPair" }
        ];
        const rows = combos.map(({ eg, k }) => `
            <div class="wdm-fk-rules-row">
                ${dice(eg)}
                <div class="wdm-fk-rules-text">
                    <strong>${game.i18n.localize(`WITCHER.Farkle.combo.${k}.label`)}</strong>
                    <span class="wdm-fk-rules-pts">${game.i18n.localize(`WITCHER.Farkle.combo.${k}.pts`)}</span>
                </div>
            </div>`).join("");
        const content = `
            <div class="wdm-farkle-rules">
                <p>${game.i18n.format("WITCHER.Farkle.rules.flow", { target: this.match.target })}</p>
                <h4>${game.i18n.localize("WITCHER.Farkle.rules.scoringTitle")}</h4>
                <div class="wdm-fk-rules-list">${rows}</div>
                <p class="wdm-fk-rules-note">${game.i18n.localize("WITCHER.Farkle.rules.hotDice")}</p>
                <p class="wdm-fk-rules-note">${game.i18n.localize("WITCHER.Farkle.rules.farkle")}</p>
            </div>`;
        foundry.applications.api.DialogV2.prompt({
            window: { title: "WITCHER.Farkle.rules.title", icon: "fa-solid fa-book" },
            classes: ["witcher-ttrpg-death-march", "wdm-farkle"],
            content,
            ok: { label: "WITCHER.Farkle.rules.close" }
        });
    }

    /** Player leaves a networked match. In a table, the seat is removed from the
     *  live match (its ante stays in the pot) and the move is relayed so every
     *  client drops it — if that leaves one seat, the survivor wins by walkover
     *  and the GM settles. PvP just tears down (the peer gets an abort). */
    static #onForfeit(event, target) {
        if (!(this.isTable && this.mySeat != null && this.match.phase !== "done")) return this.close();
        const seat = this.mySeat;
        this.#apply("forfeit", { seat });
        this.#relay("forfeit", { seat });
        // A playing GM stays on as the table's authority (drives AI seats + relays
        // state) so the game keeps running for everyone else — it just drops to a
        // seatless spectator. Any other seat-holder leaves outright.
        if (game.user.isActiveGM && this.match.phase !== "done") {
            this.mySeat = null;
            return this.#advance();
        }
        if (this.match.phase === "done") this.#maybeSettle();
        this.close();
    }

    /** GM cancels the whole table: refund every ante and dismiss all boards. */
    static #onEndTable(event, target) {
        if (!(this.isTable && game.user.isActiveGM)) return;
        endTable();      // refund antes + broadcast cancel + close the shared table
        this.close();    // the broadcast isn't echoed to the sender — close ours
    }

    static #onCloseAction(event, target) {
        this.close();
    }
}

/** Launcher (solo vs NPC) exposed on game.system.api.minigames. */
export function openFarkle() {
    return new FarkleApp({ mode: "solo" }).render(true);
}

/**
 * Launch the live N-seat table from a lobby roster. Called on every seated
 * client (and the GM, who drives the AI seats) when the lobby flips to started.
 * @param {object} o
 * @param {string} o.matchId   shared id so relayed moves route to this table
 * @param {Array}  o.seats     roster [{ id, kind, userId, actorId, name, skill }]
 * @param {object} o.config    { target, ante, denom }
 * @param {object} o.seatDice  per-seat dice profiles { [seatId]: [{weights,faces}] }
 * @param {string} o.starter   seat that acts first
 * @param {?string} o.mySeat   the seat this client controls (null = observer)
 */
export function openFarkleTableGame({ matchId, seats, config, seatDice, starter, mySeat }) {
    const app = new FarkleApp({ mode: "table", matchId, seats, config, seatDice, starter, mySeat });
    app.render(true);
    return app;
}
