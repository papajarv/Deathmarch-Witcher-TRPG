/**
 * DicePokerApp — the Witcher dice poker table (solo vs NPC, and lobby tables).
 *
 * Coin model: every seat antes into a pot; the best five-die hand takes the
 * whole pot. Play is round-based (Witcher 2 feel): ROUND 1, every seat throws
 * its opening five in turn; ROUND 2, every seat keeps a subset and rerolls the
 * rest ONCE (or stands) to lock its hand; then the showdown ranks all hands. An
 * exact tie for the best hand replays from a fresh round 1 (pot carried).
 *
 * Because the 3D board is shared by all seats, a seat's round-2 turn begins by
 * re-placing its recorded opening dice on the felt (other seats threw in
 * between) before it picks keeps and rerolls.
 *
 * The engine (DicePokerMatch) is a deterministic state machine; it never rolls.
 * Values are injected: a seat's controller rolls from a local RNG and relays
 * every input (roll values, keep/stand, reroll values) so all clients stay in
 * lock-step. Only `toAct` moves; the engine cycles it seat-to-seat per round.
 *
 * Reuses the Farkle 3D board (DiceBoard3D) with five dice and `asideOnRim`, so
 * KEPT dice rest atop the board's near rim. "Set aside" on the board == "keep".
 */

import { DicePokerMatch } from "./engine/state.mjs";
import { chooseKeep } from "./engine/ai.mjs";
import { competence } from "../farkle/engine/ai.mjs";
import { evaluateHand, handKey } from "./engine/hands.mjs";
import { registerTable, unregisterTable, send } from "./net.mjs";
import { settleNets, endTable, notifyLiveClosed } from "./lobby.mjs";
import { DiceBoard3D } from "../farkle/board3d.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const BOARD_W = 600, BOARD_H = 600;
const DICE = 5;

const PIP_FACES = Object.freeze({
    1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9],
    5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9]
});

const DEFAULTS = { ante: 0, purse: 500, format: "bo3" };

// Heads-up match length → engine config. Best-of-N needs ⌈N/2⌉ hand-wins;
// "continuous" never ends on score (only when a seat can't cover the ante).
const MATCH_FORMATS = Object.freeze({
    // Heads-up (2 seats): best-of-N races to ⌈N/2⌉ hand-wins.
    bo1: { target: 1, continuous: false },
    bo3: { target: 2, continuous: false },
    bo5: { target: 3, continuous: false },
    bo7: { target: 4, continuous: false },
    // 3–4 seats: play a fixed number of hands, then the richest purse wins.
    hands3: { handLimit: 3, continuous: false },
    hands5: { handLimit: 5, continuous: false },
    hands10: { handLimit: 10, continuous: false },
    continuous: { target: 2, continuous: true }
});
const NPC_STEP_MS = 450;
const OPP_PICK_MS = 200;
// How long the finished hand rests on the rims (both final hands shown) before
// the next hand is dealt — a visible showdown beat between hands.
const SHOWDOWN_MS = 1500;

/** Multiset difference: `all` minus one occurrence of each value in `remove`. */
function subtractMultiset(all, remove) {
    const out = [...all];
    for (const v of remove) {
        const i = out.indexOf(v);
        if (i >= 0) out.splice(i, 1);
    }
    return out;
}

export class DicePokerApp extends HandlebarsApplicationMixin(ApplicationV2) {

    static DEFAULT_OPTIONS = {
        id: "wdm-dicepoker-{id}",
        classes: ["witcher-ttrpg-death-march", "wdm-farkle", "wdm-farkle-app", "wdm-dicepoker-app"],
        tag: "div",
        window: {
            title: "WITCHER.DicePoker.title",
            icon: "fa-solid fa-dice-d6",
            resizable: false,
            minimizable: false
        },
        position: { width: 640, height: "auto" },
        actions: {
            check: DicePokerApp.#onCheck,
            call: DicePokerApp.#onCall,
            raiseBet: DicePokerApp.#onRaise,
            fold: DicePokerApp.#onFold,
            stand: DicePokerApp.#onStand,
            reroll: DicePokerApp.#onReroll,
            newGame: DicePokerApp.#onNewGame,
            showRules: DicePokerApp.#onShowRules,
            forfeit: DicePokerApp.#onForfeit,
            forceForfeit: DicePokerApp.#onForceForfeit,
            endTable: DicePokerApp.#onEndTable,
            close: DicePokerApp.#onCloseAction
        }
    };

    static PARTS = {
        status: { template: `systems/${SYSTEM_ID}/templates/minigames/dicepoker/status.hbs` },
        stage: { template: `systems/${SYSTEM_ID}/templates/minigames/dicepoker/stage.hbs` },
        controls: { template: `systems/${SYSTEM_ID}/templates/minigames/dicepoker/controls.hbs` }
    };

    constructor(options = {}) {
        super(options);
        this.mode = options.mode ?? "solo";
        this.matchId = options.matchId ?? foundry.utils.randomID();

        this.roster = (options.seats ?? this.#defaultRoster(options))
            .slice()
            .sort((x, y) => x.id.localeCompare(y.id));
        this.seatIds = this.roster.map(s => s.id);
        this.seatById = Object.fromEntries(this.roster.map(s => [s.id, s]));

        this.mySeat = options.mySeat
            ?? this.roster.find(s => s.kind === "human" && s.userId === game.user.id)?.id
            ?? options.seat
            ?? null;

        this.starter = this.seatIds.includes(options.starter) ? options.starter : this.seatIds[0];
        this.cfg = { ...DEFAULTS, ...(options.config ?? {}) };
        this.rng = Math.random;
        this.log = [];

        this.seatDice = options.seatDice ?? {};
        this._skinSeat = null;

        this.board = null;
        this._armToken = null;
        // Up-faces of the dice the player has clicked to KEEP this throw.
        this._selValues = [];
        // The launched-but-not-yet-settled local throw: { kind, values }.
        this._pendingRoll = null;
        this._boardSettleResolve = null;
        this._oppDice = [];
        this._oppAnimating = false;

        this.opponentUserId = options.opponentUserId ?? null;
        this.connected = true;
        if (this.mode === "table") registerTable(this.matchId, this);

        this._closed = false;
        this._aiBusy = false;

        this._stateSeq = 0;
        this._lastStateSeq = -1;
        this._helloSent = false;

        this.#startMatch();
    }

    get isTable() { return this.mode === "table"; }

    #defaultRoster() {
        const youName = game.i18n.localize("WITCHER.DicePoker.you");
        return [
            { id: "a", kind: "human", userId: game.user.id, actorId: null, name: youName, skill: null },
            { id: "b", kind: "ai", userId: null, actorId: null,
              name: game.i18n.localize("WITCHER.DicePoker.opponent"), skill: 15 }
        ];
    }

    /* --------------------------- seat helpers ------------------------- */

    /** Identifies one round-1 instance: a fresh hand bumps `handNo`, a tie-replay
     *  bumps `replays` (handNo unchanged) — so the pair is unique per deal. */
    #handToken() { return `${this.match.handNo}|${this.match.replays}`; }

    #isAiSeat(id) { return this.seatById[id]?.kind === "ai"; }
    #aiSkill(id) { return this.seatById[id]?.skill ?? 15; }
    #seatName(id) { return this.seatById[id]?.name ?? game.i18n.localize("WITCHER.DicePoker.opponent"); }
    #isAiDriver() { return this.mode === "solo" ? true : game.user.isActiveGM; }
    #otherSeat(id) { return this.seatIds.find(s => s !== id) ?? id; }

    /** Compass slot ("S"|"W"|"N"|"E") for a seat as a TRUE place around the
     *  table, oriented to the LOCAL viewer: you are always "S" (the near rim),
     *  the rest fan out by their fixed offset around the ring so a given player
     *  keeps the same seat for everyone. Observers (no seat) read absolute. */
    #seatCompass(seat) {
        const ring = this.seatIds, n = ring.length;
        const layout = n <= 2 ? ["S", "N"]
                     : n === 3 ? ["S", "W", "E"]
                     :           ["S", "W", "N", "E"];
        const base = this.mySeat != null ? ring.indexOf(this.mySeat) : 0;
        const rel = (ring.indexOf(seat) - base + n) % n;
        return layout[rel] ?? "S";
    }

    /** Wipe all rim props when a fresh hand begins (the deal/replay changed), so
     *  last hand's dice don't linger on the rims into the new one. */
    #seatHandsForHand() {
        const tok = this.#handToken();
        if (this._seatHandsHand === tok) return;
        this._seatHandsHand = tok;
        this._reveal = {};            // new hand: cards go back to "—" until each seat's dice land
        this.board?.clearSeatHands();
    }

    /** Stamp a seat's currently-known dice (locked hand, else opening throw) as a
     *  persistent prop on its own rim, then hide the live physics set. */
    #stampSeatHand(seat, valsOverride = null) {
        const m = this.match;
        // A terminal stand/reroll cascades through showdown → next hand inside the
        // engine, wiping m.hands/m.rolls. Callers that just applied such an action
        // pass the seat's known final hand; the handResult snapshot is the last
        // resort. NB: stamping never wipes the rims — only #beginSeatLive does,
        // when the NEXT hand's first opening throw begins — so a finished hand
        // stays on its rim through the showdown beat instead of vanishing.
        const vals = valsOverride
            ?? (Array.isArray(m.hands[seat]) ? m.hands[seat] : m.rolls?.[seat])
            ?? m.handResult?.hands?.[seat];
        if (!vals?.length) return;
        // This is the ONLY point a seat's dice are known-landed (opening rested on
        // its rim, or final hand thrown and settled). Reveal the HUD card here so
        // an opponent's hand name never appears before its dice stop tumbling.
        (this._reveal ??= {})[seat] = [...vals];
        const b = this.board;
        if (!b) return;
        b.setSeatHand(seat, vals, this.#seatCompass(seat), this.seatDice?.[seat] ?? null);
        b.hideLiveDice();
    }

    /** Declaratively place every RESTING seat's known dice on its own rim, from
     *  authoritative engine state (locked hand, else opening throw). `liveSeat`
     *  is the seat (if any) currently throwing/selecting in the centre — it is
     *  skipped so its live dice aren't clobbered. Idempotent via seatHandMatches,
     *  so it never restamps (and never drops rim-select glow) when already right.
     *
     *  This is the safety net the per-turn imperative stamps lacked: whenever the
     *  board syncs, each non-acting seat's hand is re-asserted onto its rim, so a
     *  stamp lost to an animation/refresh race can't leave a hand floating in the
     *  centre or vanished off the rim between phases. */
    #paintRestingHands(liveSeat = null) {
        const b = this.board;
        if (!b) return;
        const m = this.match;
        for (const seat of this.seatIds) {
            if (seat === liveSeat) continue;
            const vals = Array.isArray(m.hands[seat]) ? m.hands[seat]
                       : Array.isArray(m.rolls?.[seat]) ? m.rolls[seat]
                       : null;
            const edge = this.#seatCompass(seat);
            if (!vals?.length) { b.clearSeatHand(seat); continue; }
            if (b.seatHandMatches(seat, vals, edge)) continue;
            b.setSeatHand(seat, vals, edge, this.seatDice?.[seat] ?? null);
        }
    }

    /** Hold the just-finished hand on the rims (both final hands shown) for a beat
     *  before the next hand deals. Idempotent per hand via `_shownResultFor`, so
     *  it can be called from every between-hands juncture (AI loop, my own final
     *  input, a relayed move) without double-pausing. Skips a match-ending hand —
     *  that path shows its own result banner. */
    async #showdownPause() {
        const hr = this.match.handResult;
        if (!hr || this.match.phase === "done") return;
        const id = `${hr.handNo}|${hr.winner}`;
        if (this._shownResultFor === id) return;
        this._shownResultFor = id;
        // Hold the board: the engine has already dealt the next hand, so an
        // unguarded refresh would re-arm (and wipe) the rims for that hand. Block
        // #syncBoard / #maybeDriveAi until the showdown beat elapses.
        this._showdownHolding = true;
        for (const seat of this.seatIds) {
            const vals = hr.hands?.[seat];
            if (Array.isArray(vals) && vals.length) this.#stampSeatHand(seat, vals);
        }
        this.#maybeAnnounceHand();
        this.#refresh();
        await this.#wait(SHOWDOWN_MS);
        this._showdownHolding = false;
        this._armToken = null;          // force a clean re-arm for the new hand
    }

    /** A seat is about to roll: drop its persistent prop and bring the live dice
     *  back so its throw/selection animates in the central well. */
    #beginSeatLive(seat) {
        const b = this.board;
        if (!b) return;
        this.#seatHandsForHand();
        b.clearSeatHand(seat);
        b.showLiveDice();
    }

    /** Localized hand name for a five-die hand. */
    #handName(values) {
        if (!Array.isArray(values) || !values.length) return "";
        return game.i18n.localize(`WITCHER.DicePoker.hand.${handKey(evaluateHand(values).rank)}`);
    }

    bringToFront() {}
    setPosition() { return this.position; }

    #refresh() {
        if (this._closed) return Promise.resolve(this);
        return this.render({ parts: ["status", "controls"] });
    }

    /* ----------------------------- lifecycle -------------------------- */

    #startMatch() {
        const players = {};
        for (const id of this.seatIds) players[id] = { purse: this.cfg.purse };
        // Starting bankrolls, to read each seat's net win/loss between hands.
        this._startPurse = Object.fromEntries(this.seatIds.map(id => [id, this.cfg.purse]));
        this._settled = new Set();   // seats whose net already paid out (dedup on leave + sweep)
        // Heads-up runs best-of-N; 3+ seats run a fixed-length session (play N
        // hands, richest wins) or continuous. The lobby offers seat-appropriate
        // formats; guard against a stale best-of-N leaking onto a multi-seat table.
        const headsUp = this.seatIds.length === 2;
        let fmt = MATCH_FORMATS[this.cfg.format] ?? MATCH_FORMATS[headsUp ? "bo3" : "hands3"];
        if (!headsUp && fmt.target != null && !fmt.handLimit && !fmt.continuous) fmt = MATCH_FORMATS.hands3;
        this.match = new DicePokerMatch({
            players, seats: this.seatIds, dice: DICE,
            ante: this.cfg.ante, starter: this.starter,
            target: fmt.target, continuous: fmt.continuous, handLimit: fmt.handLimit ?? 0
        });
        this.log = [];
        this._selValues = [];
        this._oppDice = [];
        this._pendingRoll = null;
        this._armToken = null;
        this._seq = 0;
        this._resultAnnounced = false;
        this._handAnnounced = 0;
        this._shownResultFor = null;
        this._showdownHolding = false;
        this._seatHandsHand = null;
        this._reveal = {};            // seat → dice the HUD card may name (set only once dice land)
        this._seatAction = {};        // seat → [{id,text}] transient action labels under the hand
        this._netShown = {};          // seat → net swing shown on the chip (snapshot at reveals only)
        this.#say("WITCHER.DicePoker.log.newMatch", { ante: this.cfg.ante });
    }

    #skinFor(seat) {
        if (!this.board || this._skinSeat === seat) return;
        this._skinSeat = seat;
        this.board.setDieProfiles(this.seatDice?.[seat] ?? null);
    }

    #say(key, data = {}) {
        const line = game.i18n.format(key, data);
        this.log.push(line);
        return line;
    }

    /**
     * One clear, named betting line, shared by the local player, the AI, and
     * remote relays so it always reads "<Name> raises to N (pot P)" — never an
     * ambiguous bare amount. Call AFTER the engine has applied the action so the
     * pot / current bet reflect the new state.
     * @param {string} seat   the acting seat
     * @param {"check"|"call"|"raise"|"fold"} action
     * @param {number} amount for "call" the coins paid; for "raise" the new bet
     */
    #betLine(seat, action, amount = 0) {
        const name = this.#seatName(seat);
        const pot = this.match.pot;
        let line;
        if (action === "check")      line = this.#say("WITCHER.DicePoker.log.bet_check", { name });
        else if (action === "call")  line = this.#say("WITCHER.DicePoker.log.bet_call", { name, amount, pot });
        else if (action === "raise") line = this.#say("WITCHER.DicePoker.log.bet_raise", { name, bet: amount, pot });
        else if (action === "fold")  line = this.#say("WITCHER.DicePoker.log.bet_fold", { name });
        // Flash an on-board pill for OTHERS' moves (AI + remote players) — the log
        // rail only keeps the last three lines, so a quick check/raise/fold would
        // otherwise scroll past unseen. Skip my own action (the button I clicked
        // is feedback enough).
        if (line && seat !== this.mySeat) this.#flashAction(seat, line);
    }

    /** Briefly label a seat's check/call/raise/fold directly under its own hand
     *  indicator. Rendered through the seat card (status part) rather than an
     *  overlay, so it sits exactly beneath that player's hand — no absolute
     *  guesswork — and survives the #refresh that follows the move. Each message
     *  STACKS beneath the previous one (rather than replacing it) so two quick
     *  successive moves both stay visible; each entry auto-clears ~3.8s later on
     *  its own timer. */
    #flashAction(seat, text) {
        const bag = (this._seatAction ??= {});
        const list = (bag[seat] ??= []);
        const id = (this._actionSeq = (this._actionSeq ?? 0) + 1);
        list.push({ id, text });
        this.#refresh();
        setTimeout(() => {
            const cur = this._seatAction?.[seat];
            if (!cur) return;
            const next = cur.filter(e => e.id !== id);
            if (next.length) this._seatAction[seat] = next;
            else delete this._seatAction[seat];
            this.#refresh();
        }, 3800);
    }

    /* ----------------------- input application ------------------------ */

    #apply(event, args) {
        const m = this.match;
        switch (event) {
            case "submitRoll":   m.submitRoll(args.seat, args.values); break;
            case "check":        m.check(args.seat); break;
            case "call":         m.call(args.seat); break;
            case "raise":        m.raise(args.seat); break;
            case "fold":         m.fold(args.seat); break;
            case "stand":        m.stand(args.seat); break;
            case "reroll":       m.reroll(args.seat, args.keep); break;
            case "submitReroll": m.submitReroll(args.seat, args.values); break;
            case "forfeit":      m.forfeit(args.seat); break;
        }
        this._seq++;
        this.#broadcastState();
    }

    #broadcastState() {
        if (!this.isTable || !game.user.isActiveGM || !this.match) return;
        this._stateSeq++;
        send({ matchId: this.matchId, to: null, sub: "state",
            payload: { seq: this._stateSeq, mseq: this._seq, snap: this.match.snapshot() } });
    }

    #relay(event, args) {
        if (this.isTable) send({ matchId: this.matchId, to: null, sub: "move", payload: { event, args } });
    }

    #maybeSettle() {
        if (!this.isTable || !game.user.isActiveGM || this.match.phase !== "done") return;
        this.#settleSeats(this.seatIds, { close: true });
    }

    /** GM only: pay each named seat's betting net (finalPurse − startPurse) to its
     *  actor, clamped at zero, and announce any credit owed. `_settled` dedups so a
     *  seat paid out on leave isn't paid again by the match-end sweep. */
    #settleSeats(seatIds, { close = false } = {}) {
        if (!this.isTable || !game.user.isActiveGM) return;
        const m = this.match;
        const nets = [];
        for (const id of seatIds) {
            if (this._settled.has(id)) continue;
            this._settled.add(id);
            nets.push({ seatId: id, net: (m.players[id]?.purse ?? 0) - (this._startPurse?.[id] ?? 0) });
        }
        settleNets(nets, { close })
            .then(debts => this.#announceDebts(debts))
            .catch(err => console.error("DicePoker | settle failed", err));
    }

    /** Post a Foundry chat line for each seat whose losses outran their purse —
     *  they leave "on credit", owing the shortfall (flavour for the table). */
    #announceDebts(debts) {
        for (const d of (debts ?? [])) {
            ChatMessage.create({
                content: game.i18n.format("WITCHER.DicePoker.chat.credit", { name: d.name, owed: d.owed })
            });
        }
    }

    #advance() {
        if (this.match.phase === "done") { this.#logResult(); this.#maybeSettle(); return this.#refresh(); }
        this.#maybeAnnounceHand();
        if (this.#isAiSeat(this.match.toAct) && this.#isAiDriver()) {
            this.#refresh();
            return this.#runAiTurns();
        }
        return this.#refresh();
    }

    /* --------------------------- human moves -------------------------- */

    /** A betting action (check / call / raise / fold) by the local player. */
    #humanBet(action) {
        const me = this.mySeat;
        if (this.match.phase !== "bet" || this.match.toAct !== me) return;
        const owedBefore = this.match.owed(me);
        this.#apply(action, { seat: me });
        this.#relay(action, { seat: me });
        // After apply: currentBet reflects a raise; owedBefore is what a call paid.
        this.#betLine(me, action, action === "raise" ? this.match.currentBet : owedBefore);
        if (action === "fold") this.board?.disableBoard();
        return this.#advance();
    }

    /**
     * Pick an AI seat's betting action from its opening hand strength, the size
     * of the call, and the seat's skill (INT + EMP + Gambling, 2..30).
     *
     * Skill maps to competence c∈[0,1]. A skilled seat (c→1) folds *by pot odds*:
     * a weak hand walks only when the call is dear relative to the pot, never for
     * a trivial nudge. A dumbass (c→0) barely folds at all: it calls into almost
     * anything ("why not"). Folding is thus blended between an expert pot-odds
     * target and a stubborn novice floor, so price only scares off the competent.
     */
    #aiBetDecision(seat, skill = 15) {
        const m = this.match;
        const opening = m.rolls?.[seat] ?? [];
        const rank = opening.length ? evaluateHand(opening).rank : 0;
        const owed = m.owed(seat);
        const c = competence(skill);
        const r = this.rng();

        if (owed > 0) {
            // Pot odds drive the fold, NOT hand rank alone: the call costs `owed`
            // to win the standing pot, so its share of the post-call pot is the
            // real price. A cheap call (tiny vs the pot — e.g. a 1-coin nudge) is
            // nearly free and an expert almost never folds it; only an expensive
            // call (committing a big slice of the pot) lets a weak hand walk.
            // Opening hands are provisional too — a reroll is still to come — so
            // weakness only matters in proportion to that price.
            const pot = m.pot ?? 0;
            const potOdds = owed / Math.max(1, pot + owed);
            const weakness = 1 - Math.min(1, rank / 5);
            const expertFold = Math.min(0.9, weakness * potOdds * 1.6);
            // Novice almost never folds (calls down dumbass-style). Blend by skill.
            const foldProb = c * expertFold + (1 - c) * 0.05;
            if (r < foldProb) return "fold";
            // Staying in: skilled seats value-raise strong hands.
            const raiseProb = c * (rank >= 5 ? 0.6 : rank >= 4 ? 0.3 : 0) + 0.05 * (1 - c);
            if (m.canRaise(seat) && this.rng() < raiseProb) return "raise";
            return "call";
        }

        // Nothing to call: open a raise on strength (skilled), else check; the
        // occasional thin bluff is the novice's, not the expert's.
        const raiseProb = rank >= 4 ? 0.3 + 0.5 * c
                        : rank >= 2 ? 0.15 + 0.2 * c
                        :             0.10 * (1 - c) + 0.04 * c;
        if (m.canRaise(seat) && r < raiseProb) return "raise";
        return "check";
    }

    /** Snapshot every seat's net swing (purse − startPurse) into the value the
     *  HUD chip reads. Called only at result reveals (hand won/lost, match end)
     *  so the chip reflects settled outcomes, never the mid-hand dip as coins go
     *  into the pot. */
    #snapshotNets() {
        const shown = (this._netShown ??= {});
        const players = this.match?.players ?? {};
        for (const id of this.seatIds) {
            shown[id] = (players[id]?.purse ?? 0) - (this._startPurse?.[id] ?? 0);
        }
    }

    /** Flash a between-hand result banner once when a hand of a best-of-N match
     *  resolves (but the match continues). */
    #maybeAnnounceHand() {
        const hr = this.match.handResult;
        if (!hr || hr.handNo === this._handAnnounced || this.match.phase === "done") return;
        this._handAnnounced = hr.handNo;
        // The pot has been awarded by now — refresh the on-screen net chips so the
        // win/loss is shown exactly as the hand banner appears.
        this.#snapshotNets();
        if (!this.match.betting) return;        // single-hand games: no per-hand banner
        const me = this.mySeat;
        const score = me
            ? `${this.match.scores[me] ?? 0}–${this.match.scores[this.#otherSeat(me)] ?? 0}`
            : "";
        // A folded hand never reaches a showdown — say so, so the winner knows
        // they took the pot because the opponent bowed out, not on a better hand.
        if (hr.folded) this.#logFold(hr);
        if (me && hr.winner === me) {
            const key = hr.folded ? "WITCHER.DicePoker.banner.foldWin" : "WITCHER.DicePoker.banner.handWin";
            this.#flashBanner(game.i18n.format(key, { score }), "win", 2200, { small: true });
        } else if (me) {
            this.#flashBanner(game.i18n.format("WITCHER.DicePoker.banner.handLose", { score }), "lose", 2000, { small: true });
        } else {
            this.#flashBanner(game.i18n.format("WITCHER.DicePoker.banner.handWinner",
                { name: this.#seatName(hr.winner) }), "", 2000, { small: true });
        }
    }

    /** Log why a hand ended on a fold (no showdown): the winner took the pot
     *  because every other live seat surrendered rather than cover the bet. */
    #logFold(hr) {
        const me = this.mySeat;
        if (me && hr.winner === me) {
            this.#say("WITCHER.DicePoker.log.foldWin", { name: this.#seatName(this.#otherSeat(me)), pot: hr.pot });
        } else if (me) {
            this.#say("WITCHER.DicePoker.log.foldLose", { pot: hr.pot });
        } else {
            this.#say("WITCHER.DicePoker.log.foldWinner",
                { name: this.#seatName(hr.winner), pot: hr.pot });
        }
    }

    #humanRoll(values, { relayed = false } = {}) {
        this._selValues = [];
        if (!relayed) {
            this.#say("WITCHER.DicePoker.log.youRolled", { dice: values.join("  ") });
            this.#relay("submitRoll", { seat: this.mySeat, values });
        }
        this.#apply("submitRoll", { seat: this.mySeat, values });
        this.#stampSeatHand(this.mySeat, values);   // my opening rests on my own rim
        return this.#advance();
    }

    /** Lock the current dice as my hand (no reroll). */
    async #humanStand() {
        const me = this.mySeat;
        const hand = [...this.match.roll];
        const handNoBefore = this.match.handNo;
        this.#apply("stand", { seat: me });
        this.#relay("stand", { seat: me });
        this.board?.disableBoard();
        this.#stampSeatHand(me, hand);      // my locked hand rests on my own rim
        this.#say("WITCHER.DicePoker.log.youStood", { hand: this.#handName(hand) });
        this._selValues = [];
        if (this.match.handNo !== handNoBefore) await this.#showdownPause();
        return this.#afterMyTurnInput();
    }

    /** Reroll the dice tapped on my rim; the rest stay put. Lifts the tapped
     *  dice off the rim, then #syncBoard tumbles that subset in the centre. */
    #humanReroll() {
        const me = this.mySeat;
        const reroll = this.#currentSelectionValues();   // rim taps = dice to reroll
        // Rerolling nothing is a stand.
        if (reroll.length === 0) return this.#humanStand();
        const keep = subtractMultiset(this.match.roll, reroll);
        this.#apply("reroll", { seat: me, keep });
        this.#relay("reroll", { seat: me, keep });
        this.board?.liftRimToKeep(me, keep);   // tapped dice leave the rim (engine keep is authoritative)
        this._selValues = [];
        this.#say("WITCHER.DicePoker.log.youKept", { n: keep.length });
        // Engine is now in "rerolling"; #syncBoard will throw the lifted subset.
        return this.#advance();
    }

    /** The reroll throw has settled — combine kept + new dice into my hand. */
    async #humanReroll2(values, { relayed = false } = {}) {
        const me = this.mySeat;
        // Final hand = kept (still in m.keep) + the rerolled faces. Capture it
        // before submitReroll: acting last resolves the hand and resets m.hands.
        const finalHand = [...this.match.keep, ...values];
        const handNoBefore = this.match.handNo;
        if (!relayed) {
            this.#say("WITCHER.DicePoker.log.youRerolled", { dice: values.join("  ") });
            this.#relay("submitReroll", { seat: me, values });
        }
        this.#apply("submitReroll", { seat: me, values });
        this.board?.disableBoard();
        this.#stampSeatHand(me, finalHand); // my final hand rests on my own rim
        this.#say("WITCHER.DicePoker.log.youHand", { hand: this.#handName(finalHand) });
        if (this.match.handNo !== handNoBefore) await this.#showdownPause();
        return this.#afterMyTurnInput();
    }

    /** After I lock a hand, hand off: drive AI seats I own, or wait for peers. */
    #afterMyTurnInput() {
        return this.#advance();
    }

    /* ----------------------------- AI turns --------------------------- */

    async #runAiTurns() {
        if (this._aiBusy || !this.#isAiDriver()) return;
        this._aiBusy = true;
        const m = this.match;
        this.board?.disableBoard();
        let guard = 0;
        // Drive ONE phase-action per iteration (round-based flow): an AI seat's
        // round-1 opening throw, or its round-2 keep/stand/reroll. The engine
        // advances `toAct` seat-to-seat within each round, so we loop only while
        // the seat to act is an AI we own. Scope the loop to the CURRENT hand: a
        // terminal stand/reroll cascades into the next hand inside the engine, and
        // without this guard the loop would bleed straight into that hand's opening
        // throw (an apparent "extra full-5 roll before picking"). Break instead, so
        // the showdown can rest on the rims for a beat before the next deal.
        const startHand = m.handNo;
        while (this.#isAiSeat(m.toAct) && m.phase !== "done"
               && m.handNo === startHand && !this._closed && guard++ < 200) {
            const ai = m.toAct, skill = this.#aiSkill(ai);

            if (m.phase === "roll") {
                // Round 1: opening throw only — control then passes to the next seat.
                this.#beginSeatLive(ai);
                this.#skinFor(ai);
                this.board?.newTurn();
                const values = this.board ? this.board.drawInHandValues(this.rng) : this.#rollN(DICE);
                this._oppDice = values;
                this.#relay("submitRoll", { seat: ai, values });
                m.submitRoll(ai, values); this._seq++;
                this.#say("WITCHER.DicePoker.log.npcRolled", { dice: values.join("  ") });
                this.#broadcastState();
                // Animate the throw and rest it on the rim BEFORE refreshing the
                // HUD: submitRoll may have closed the opening round and flipped the
                // engine to the human's bet turn, but the bet controls must not
                // appear while this seat's dice are still tumbling in the centre.
                await this.#npcThrowTo(values);
                this.#stampSeatHand(ai, values);   // opening rests on this seat's rim
                this.#refresh();
                await this.#wait(NPC_STEP_MS);
                continue;
            }

            if (m.phase === "bet") {
                // Betting round: decide and act (no board animation — the human's
                // own dice stay shown). A fold ends the hand here.
                const decision = this.#aiBetDecision(ai, skill);
                const owedBefore = m.owed(ai);
                this.#relay(decision, { seat: ai });
                m[decision](ai); this._seq++;
                this.#betLine(ai, decision, decision === "raise" ? m.currentBet : owedBefore);
                this.#broadcastState();
                this.#maybeAnnounceHand();
                this.#refresh();
                await this.#wait(NPC_STEP_MS);
                continue;
            }

            // Round 2 (phase "select"): this seat's opening hand already rests on
            // its rim. Decide, mark the reroll dice ON the rim, then tumble just
            // that subset in the centre — the kept dice never leave the rim.
            const opening = [...m.roll];
            const keep = chooseKeep(opening, { skill, rng: this.rng });
            if (keep.length >= opening.length) {
                this.#relay("stand", { seat: ai });
                m.stand(ai); this._seq++;
                this.#say("WITCHER.DicePoker.log.npcStood", { hand: this.#handName(opening) });
                this.#stampSeatHand(ai, opening);  // re-affirm the locked hand on the rim
                this.#broadcastState();
                this.#refresh();
                await this.#wait(NPC_STEP_MS);
                continue;
            }

            const rerollVals = subtractMultiset(opening, keep);
            this.#relay("reroll", { seat: ai, keep });
            m.reroll(ai, keep); this._seq++;
            this.#say("WITCHER.DicePoker.log.npcKept", { n: keep.length });
            this.#broadcastState();
            this.#refresh();
            await this.#animateOppRimSelect(ai, rerollVals);   // glow the reroll dice on the rim

            // Lift the marked dice off the rim and tumble that subset. Re-skin the
            // live dice to THIS seat's profile first (textures + weights): my own
            // reroll may have left my skin on them, and drawInHandValues rolls on
            // the live dice's weights.
            this.board?.liftRimToKeep(ai, keep);
            this.#skinFor(ai);
            this.board?.armRerollSubset(m.rerollCount());
            const newVals = this.board ? this.board.drawInHandValues(this.rng) : this.#rollN(m.rerollCount());
            // Final hand = kept + rerolled. Capture it before submitReroll: if this
            // seat acts last, the engine resolves the hand and resets m.hands here.
            const finalHand = [...keep, ...newVals];
            this.#relay("submitReroll", { seat: ai, values: newVals });
            m.submitReroll(ai, newVals); this._seq++;
            this.#broadcastState();
            this.#refresh();
            await this.#npcThrowTo(newVals);
            // Name the hand only once its dice have landed — logging it before the
            // throw would spoil the reveal in the rail (the remote path already
            // waits; keep the two in step).
            this.#say("WITCHER.DicePoker.log.npcHand", { hand: this.#handName(finalHand) });
            this.#stampSeatHand(ai, finalHand);  // final hand rests on this seat's rim
            this.#refresh();
            await this.#wait(NPC_STEP_MS);
        }
        this._aiBusy = false;
        this._oppDice = [];
        if (m.phase === "done") { this.#logResult(); this.#maybeSettle(); return this.#refresh(); }
        // A hand resolved (handNo advanced) but the match continues: hold the
        // showdown on the rims, then deal/drive the next hand from a clean slate.
        if (m.handNo !== startHand) {
            await this.#showdownPause();
            this.#refresh();
            return this.#advance();
        }
        return this.#refresh();
    }

    #rollN(n) {
        return Array.from({ length: n }, () => 1 + Math.floor(this.rng() * 6));
    }

    #npcThrowTo(values) {
        const b = this.board;
        if (!b) return this.#wait(NPC_STEP_MS);
        return new Promise(resolve => {
            this._boardSettleResolve = resolve;
            b.autoThrow(values);
        }).then(() => this.#wait(140));
    }

    #wait(ms) { return new Promise(r => setTimeout(r, ms)); }

    /** Animate a seat picking its reroll dice on its own rim, one at a time. */
    async #animateOppRimSelect(seat, values) {
        const b = this.board;
        if (!b) { await this.#wait(NPC_STEP_MS); return; }
        b.clearRimSelection(seat);
        for (const v of values) {
            b.selectOneRim(seat, v);
            await this.#wait(OPP_PICK_MS);
        }
        await this.#wait(140);
    }

    async #flashBanner(text, variant = "", ms = 1400, { small = false } = {}) {
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
        // Per-hand notices ("Hand lost — 0–1", "Opponent folded — …") are full
        // sentences and wrap at the big match-end size, so flag them small.
        el.classList.toggle("wdm-fk-banner-sm", small);
        el.classList.add("wdm-fk-banner-show");
        await this.#wait(ms);
        el.classList.remove("wdm-fk-banner-show");
    }

    /* ----------------------------- networking ------------------------- */

    onNetMessage(data) {
        switch (data.sub) {
            case "endTable":
                ui.notifications.info(game.i18n.localize("WITCHER.DicePoker.lobby.cancelled"));
                this.close();
                break;
            case "move":
                this._moveQueue = (this._moveQueue ?? Promise.resolve())
                    .then(() => this.#applyRemoteMove(data.payload))
                    .catch(err => console.error("DicePoker | remote move failed", err));
                break;
            case "state":
                this._moveQueue = (this._moveQueue ?? Promise.resolve())
                    .then(() => this.#applyRemoteState(data.payload))
                    .catch(err => console.error("DicePoker | state sync failed", err));
                break;
            case "sel":
                this.#mirrorSelectPreview(data.payload);
                break;
            case "hello":
                if (game.user.isActiveGM && this.isTable) this.#broadcastState();
                break;
        }
    }

    async #applyRemoteState({ seq, mseq, snap }) {
        if (game.user.isActiveGM || !snap) return;
        if (typeof seq === "number" && seq <= this._lastStateSeq) return;
        if (typeof mseq === "number" && mseq <= this._seq) return;
        this._lastStateSeq = seq ?? this._lastStateSeq;
        this._seq = mseq ?? this._seq;
        this.match.restore(snap);
        this._armToken = null;
        return this.#refresh();
    }

    #moveIsStale(event, seat) {
        const m = this.match;
        if (event === "forfeit") return false;
        if (m.toAct !== seat) return true;
        switch (event) {
            case "submitRoll":   return m.phase !== "roll";
            case "check":
            case "call":
            case "raise":
            case "fold":         return m.phase !== "bet";
            case "reroll":
            case "stand":        return m.phase !== "select";
            case "submitReroll": return m.phase !== "rerolling";
            default:             return false;
        }
    }

    async #applyRemoteMove({ event, args }) {
        const m = this.match;
        const seat = args.seat;
        if (this.#moveIsStale(event, seat)) return this.#afterRemoteMove();
        this._oppAnimating = true;
        try {
            if (event === "submitRoll") {
                this._oppDice = args.values;
                this.#say("WITCHER.DicePoker.log.oppRolled", { dice: args.values.join("  "), name: this.#seatName(seat) });
                this.#beginSeatLive(seat);
                await this.#animateOppThrow(args.values, true, seat);
                this.#apply(event, args);
                this.#stampSeatHand(seat, args.values);   // opening rests on this seat's rim
            } else if (event === "reroll") {
                // Round 2: this seat's opening hand rests on its rim — mark its
                // reroll dice there, then lift them off.
                const rerollVals = subtractMultiset(m.rolls[seat] ?? [], args.keep ?? []);
                await this.#animateOppRimSelect(seat, rerollVals);
                this.#apply(event, args);
                this.board?.liftRimToKeep(seat, args.keep ?? []);
                this.#say("WITCHER.DicePoker.log.oppKept", { n: (args.keep ?? []).length, name: this.#seatName(seat) });
            } else if (event === "submitReroll") {
                // Capture the final hand before applying — acting last resolves the
                // hand and resets m.hands/m.keep inside the engine.
                const finalHand = [...m.keep, ...args.values];
                await this.#animateOppRerollThrow(seat, args.values);
                this.#apply(event, args);
                this.#stampSeatHand(seat, finalHand);     // final hand rests on this seat's rim
                this.#say("WITCHER.DicePoker.log.oppHand", { hand: this.#handName(finalHand), name: this.#seatName(seat) });
            } else if (event === "stand") {
                // Round 2: the opening hand already rests on the rim; just hold.
                const stoodHand = [...m.roll];
                this.#apply(event, args);
                this.board?.disableBoard();
                this.#stampSeatHand(seat, stoodHand);     // re-affirm the locked hand on the rim
                this.#say("WITCHER.DicePoker.log.oppStood", { name: this.#seatName(seat) });
                await this.#wait(400);
            } else if (["check", "call", "raise", "fold"].includes(event)) {
                // Betting round: no board animation — my own dice stay on the felt.
                const owedBefore = m.owed(seat);
                this.#apply(event, args);
                this.#betLine(seat, event, event === "raise" ? m.currentBet : owedBefore);
                await this.#wait(140);
            } else if (event === "forfeit") {
                this.#apply(event, args);
                // GM is the currency authority: pay out the seat that just bowed out
                // (a match-ending forfeit gets the rest swept by #afterRemoteMove).
                if (game.user.isActiveGM) this.#settleSeats([seat], { close: false });
            } else {
                this.#apply(event, args);
            }
        } finally {
            this._oppAnimating = false;
        }
        return this.#afterRemoteMove();
    }

    async #afterRemoteMove() {
        const m = this.match;
        if (m.toAct === this.mySeat) this._oppDice = [];
        this.#maybeAnnounceHand();
        if (m.phase === "done") { this.#logResult(); this.#maybeSettle(); return this.#refresh(); }
        // If a relayed move just resolved a hand, rest the showdown on the rims
        // before the next hand deals (self-guarded — runs once per hand).
        await this.#showdownPause();
        if (this.#isAiSeat(m.toAct) && this.#isAiDriver() && !this._aiBusy) {
            this.#refresh();
            return this.#runAiTurns();
        }
        return this.#refresh();
    }

    async #animateOppThrow(values, fresh, seat) {
        const b = this.board;
        if (!b) return;
        this.#skinFor(seat);
        if (fresh) b.newTurn(); else b.prepareReroll();
        await new Promise(resolve => {
            this._boardSettleResolve = resolve;
            b.autoThrow(values);
        });
        await this.#wait(140);
    }

    /** Tumble only a seat's lifted reroll subset (round 2) to `values`. The kept
     *  dice stay on its rim; #stampSeatHand re-lays the full hand afterwards. */
    async #animateOppRerollThrow(seat, values) {
        const b = this.board;
        if (!b) return;
        this.#skinFor(seat);
        b.armRerollSubset(values.length);
        await new Promise(resolve => {
            this._boardSettleResolve = resolve;
            b.autoThrow(values);
        });
        await this.#wait(140);
    }

    /* ----------------------------- logging ---------------------------- */

    #logResult() {
        const r = this.match.result;
        if (!r) return;
        const winner = r.winners?.[0];
        const hand = this.#handName(r.hands?.[winner]);
        // If the deciding hand was a fold, explain that before the pot line.
        const hr = this.match.handResult;
        if (hr?.folded && hr.winner === winner && hr.handNo !== this._handAnnounced) {
            this._handAnnounced = hr.handNo;
            this.#logFold(hr);
        }
        if (!this.mySeat) {
            this.#say("WITCHER.DicePoker.log.winner", { name: this.#seatName(winner), pot: r.pot, hand });
        } else {
            const won = winner === this.mySeat;
            this.#say(won ? "WITCHER.DicePoker.log.youWin" : "WITCHER.DicePoker.log.youLose", { pot: r.pot, hand });
        }
        this.#announceResult();
    }

    /** Big celebratory (or commiserating) banner over the board when the hand
     *  ends. Fires once per match. */
    #announceResult() {
        if (this._resultAnnounced) return;
        this._resultAnnounced = true;
        this.#snapshotNets();   // final net swing, shown as the match-end banner appears
        const r = this.match.result;
        if (!r) return;
        const winner = r.winners?.[0];
        const hand = this.#handName(r.hands?.[winner]);
        // A win by fold never reached a showdown — there is no contested hand to
        // name, so say the opponent folded instead of flashing a phantom hand.
        const hr = this.match.handResult;
        const byFold = hr?.folded && hr.winner === winner;
        if (!this.mySeat) {
            const key = byFold ? "WITCHER.DicePoker.banner.winnerFold" : "WITCHER.DicePoker.banner.winner";
            this.#flashBanner(game.i18n.format(key, { name: this.#seatName(winner) }), "win", 3000);
        } else if (winner === this.mySeat) {
            const key = byFold ? "WITCHER.DicePoker.banner.youWinFold" : "WITCHER.DicePoker.banner.youWin";
            this.#flashBanner(game.i18n.format(key, { hand }), "win", 3200);
        } else {
            this.#flashBanner(game.i18n.localize("WITCHER.DicePoker.banner.youLose"), "lose", 2400);
        }
    }

    /* ----------------------------- context ---------------------------- */

    #currentSelectionValues() {
        return this._selValues.slice();
    }

    /* ----------------------------- 3D board --------------------------- */

    _onRender(context, options) {
        super._onRender?.(context, options);
        if (this.isTable && !game.user.isActiveGM && !this._helloSent) {
            this._helloSent = true;
            send({ matchId: this.matchId, to: null, sub: "hello" });
        }
        const mountedStage = options.parts?.includes("stage") || !this.board;
        if (mountedStage) this.#mountBoard();
        this.#installFitHooks();
        if (mountedStage) this.#scheduleFit(); else this.#fitToStage();
        this.#syncBoard();
        this.#maybeDriveAi();
        this.#updateBoardPrompt();
    }

    #maybeDriveAi() {
        const m = this.match;
        if (m.phase === "done" || this._aiBusy || this._showdownHolding) return;
        if (this.#isAiSeat(m.toAct) && this.#isAiDriver()) this.#runAiTurns();
    }

    #boardPromptText() {
        const m = this.match;
        if (m.phase === "done") return "";
        if (m.toAct !== this.mySeat) return game.i18n.localize("WITCHER.DicePoker.wait.opponentTurn");
        if (m.phase === "roll") return game.i18n.localize("WITCHER.DicePoker.board.rollHint");
        if (m.phase === "bet") return game.i18n.localize("WITCHER.DicePoker.board.betHint");
        if (m.phase === "select") return game.i18n.localize("WITCHER.DicePoker.board.selectHint");
        if (m.phase === "rerolling") return game.i18n.localize("WITCHER.DicePoker.board.rerollHint");
        return "";
    }

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
            canvas, width: BOARD_W, height: BOARD_H, dieCount: DICE, asideOnRim: true,
            onThrow: (values) => this.#onBoardThrow(values),
            onSettled: () => this.#onBoardSettled(),
            onSelectChange: (values) => this.#onBoardSelect(values)
        });
    }

    #chromeInsets(vw, vh) {
        const mine = this.element;
        const ins = { top: 0, bottom: 0, left: 0, right: 0 };
        const MAXBAND = 0.45;
        const NEAR = 6;
        for (const e of document.body.querySelectorAll("*")) {
            if (e === mine || mine?.contains(e) || e.contains(mine)) continue;
            const cs = getComputedStyle(e);
            if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0) continue;
            const r = e.getBoundingClientRect();
            if (r.width < 8 || r.height < 8) continue;
            if (r.width >= vw * 0.18 && r.height <= vh * MAXBAND) {
                if (r.top <= NEAR && r.bottom > ins.top) ins.top = r.bottom;
                if (r.bottom >= vh - NEAR && (vh - r.top) > ins.bottom) ins.bottom = vh - r.top;
            }
            if (r.height >= vh * 0.18 && r.width <= vw * MAXBAND) {
                if (r.left <= NEAR && r.right > ins.left) ins.left = r.right;
                if (r.right >= vw - NEAR && (vw - r.left) > ins.right) ins.right = vw - r.left;
            }
        }
        return ins;
    }

    #fitToStage() {
        const el = this.element;
        if (!el) return;
        const vw = window.innerWidth, vh = window.innerHeight;
        const { top: t, bottom: b } = this.#chromeInsets(vw, vh);
        const width = vw;
        const height = Math.max(0, vh - t - b);
        if (height < vh * 0.15) {
            if (!this._closed) requestAnimationFrame(() => { if (!this._closed) this.#fitToStage(); });
            return;
        }
        const s = el.style;
        s.setProperty("top", `${t}px`, "important");
        s.setProperty("left", `0px`, "important");
        s.setProperty("width", `${width}px`, "important");
        s.setProperty("height", `${height}px`, "important");
        const square = Math.min(width, height);
        s.setProperty("--fk-pad-x", `${Math.max(0, (width - square) / 2)}px`);
        s.setProperty("--fk-pad-y", `${Math.max(0, (height - square) / 2)}px`);
        this.board?.setSize(square, square);
    }

    #installFitHooks() {
        if (this._fitBound) return;
        this._fitBound = () => this.#fitToStage();
        window.addEventListener("resize", this._fitBound);
        this._fitHookIds = [
            ["renderSceneNavigation", Hooks.on("renderSceneNavigation", this._fitBound)],
            ["renderHotbar", Hooks.on("renderHotbar", this._fitBound)]
        ];
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

    #scheduleFit() {
        this.#fitToStage();
        requestAnimationFrame(() => { if (!this._closed) this.#fitToStage(); });
        for (const ms of [60, 200, 500]) {
            setTimeout(() => { if (!this._closed) this.#fitToStage(); }, ms);
        }
    }

    /** Arm the board for the current phase exactly once per transition. */
    #syncBoard() {
        const b = this.board;
        if (!b || this._aiBusy || this._oppAnimating || this._showdownHolding) return;
        const m = this.match;
        // The bet round shows MY opening dice once per hand (every seat threw in
        // round 1), regardless of who's to act — so key it on the hand, not the
        // active seat. Other phases re-arm per seat/turn within a hand.
        const token = m.phase === "bet"
            ? `bet|${this.#handToken()}`
            : `${m.phase}|${m.toAct}|${this.#handToken()}|${this._seq}`;
        if (this._armToken === token) return;
        this._armToken = token;
        const mine = m.toAct === this.mySeat;
        // The seat whose dice are LIVE in the centre right now (its own opening
        // throw or reroll tumble). Betting has none — both hands rest on rims.
        const liveSeat = (m.phase === "roll" || m.phase === "select" || m.phase === "rerolling")
            ? m.toAct : null;
        // Re-assert every other seat's hand onto its rim before per-phase setup,
        // so a seat's opening hand always rests on its rim through bet/select.
        this.#paintRestingHands(liveSeat);
        if (m.phase === "bet") {
            // Every seat's opening dice now rest on their own rim (seat props);
            // betting is driven by the control buttons. Hide any live dice still
            // lingering from the last throw and leave the board read-only.
            b.hideLiveDice();
            b.disableBoard();
        } else if (mine && m.phase === "roll") {
            this.#beginSeatLive(this.mySeat);
            this.#skinFor(this.mySeat);
            b.newTurn();
        } else if (mine && m.phase === "select") {
            // Round 2: my opening hand already rests on my rim — pick the dice to
            // reroll right there.
            this.#armHumanSelect();
        } else if (mine && this.match.phase === "rerolling") {
            // The tapped dice were lifted off my rim in #humanReroll. Skin the live
            // dice to MY profile (textures + weights — the AI's skin is left on them
            // from its round-1 throw) and arm the subset interactively so I throw it
            // myself, exactly like my opening throw. The kept dice stay on the rim.
            this.#skinFor(this.mySeat);
            this._pendingRoll = null;
            b.armRerollSubset(this.match.rerollCount(), true);
        } else {
            b.disableBoard();
        }
    }

    /** Round 2: my opening hand already rests on my rim (stamped in round 1 and
     *  kept there through the bet round), so just make those rim dice tappable —
     *  tap the ones to reroll. No re-throw; the hand never left the rim. */
    #armHumanSelect() {
        this.board?.enterRimSelect(this.mySeat);
    }

    #onBoardThrow(values) {
        const m = this.match;
        if (m.toAct !== this.mySeat) return;
        if (m.phase === "roll") {
            this._pendingRoll = { kind: "roll", values };
            this.#say("WITCHER.DicePoker.log.youRolled", { dice: values.join("  ") });
            this.#relay("submitRoll", { seat: this.mySeat, values });
        } else if (m.phase === "rerolling") {
            this._pendingRoll = { kind: "reroll", values };
            this.#say("WITCHER.DicePoker.log.youRerolled", { dice: values.join("  ") });
            this.#relay("submitReroll", { seat: this.mySeat, values });
        }
    }

    #onBoardSettled() {
        if (this._boardSettleResolve) {
            const done = this._boardSettleResolve;
            this._boardSettleResolve = null;
            done();
            return;
        }
        const m = this.match;
        if (m.toAct !== this.mySeat) return;
        const pend = this._pendingRoll;
        this._pendingRoll = null;
        this.board.disableBoard();
        if (m.phase === "roll") {
            const values = pend?.values ?? this.board.readLiveValues().values;
            this.#humanRoll(values, { relayed: true });
        } else if (m.phase === "rerolling") {
            // I slingshot the reroll subset myself; onThrow already recorded and
            // relayed the faces (like my opening throw), so don't relay again.
            const values = pend?.values ?? this.board.readLiveValues().values;
            this.#humanReroll2(values, { relayed: true });
        }
    }

    #onBoardSelect(values) {
        this._selValues = values;
        if (this.isTable && this.match.toAct === this.mySeat) {
            send({ matchId: this.matchId, to: null, sub: "sel", payload: { seat: this.mySeat, values } });
        }
        if (!this._closed) this.render({ parts: ["controls"] });
    }

    #mirrorSelectPreview({ seat, values } = {}) {
        if (!this.board || seat == null || seat === this.mySeat) return;
        if (this._oppAnimating || this.match.toAct !== seat) return;
        this.board.clearRimSelection(seat);
        for (const v of values ?? []) this.board.selectOneRim(seat, v);
    }

    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        const m = this.match;
        const mine = this.mySeat;
        const myTurn = mine != null && m.toAct === mine;

        ctx.pot = m.pot;

        // Net is shown from a snapshot (this._netShown) refreshed only at result
        // reveals (hand won/lost, match end) — NOT live during betting, so the
        // chip doesn't dip mid-hand as coins go into the pot. Defaults to 0
        // before the first reveal (purse === startPurse).
        const net = id => this._netShown?.[id] ?? 0;
        const netLabel = n => n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "±0";
        const netSign = n => n > 0 ? "up" : n < 0 ? "down" : "even";

        const seatView = id => {
            const hand = this._reveal?.[id] ?? null;
            const forfeited = (m.forfeited ?? []).includes(id);
            const foldedOut = !forfeited && (m.out ?? []).includes(id);
            const n = net(id);
            return {
                id,
                name: this.#seatName(id),
                isAI: this.#isAiSeat(id),
                handName: hand ? this.#handName(hand) : null,
                done: !!hand,
                actions: this._seatAction?.[id] ?? [],
                canKick: this.isTable && game.user.isActiveGM && this.#isAiSeat(id)
                         && !forfeited && m.phase !== "done" && !this._aiBusy && !this._oppAnimating,
                forfeited,
                foldedOut,
                net: n, netLabel: netLabel(n), netSign: netSign(n),
                active: m.toAct === id && m.phase !== "done" && !forfeited && !foldedOut
            };
        };

        const myFoldedOut = mine != null && !(m.forfeited ?? []).includes(mine) && (m.out ?? []).includes(mine);
        ctx.me = mine ? {
            name: game.i18n.localize("WITCHER.DicePoker.you"),
            handName: this._reveal?.[mine] ? this.#handName(this._reveal[mine]) : null,
            foldedOut: myFoldedOut,
            net: net(mine), netLabel: netLabel(net(mine)), netSign: netSign(net(mine)),
            active: myTurn && m.phase !== "done" && !myFoldedOut
        } : null;

        // Seat the opponents at their TRUE places around the table (relative to
        // the local viewer), so a given player keeps the same seat for everyone
        // instead of always landing in one corner.
        const others = this.seatIds.filter(s => s !== mine).map(seatView);
        ctx.others = others;
        ctx.seatN = others.find(o => this.#seatCompass(o.id) === "N") ?? null;
        ctx.seatW = others.find(o => this.#seatCompass(o.id) === "W") ?? null;
        ctx.seatE = others.find(o => this.#seatCompass(o.id) === "E") ?? null;

        ctx.log = this.log.slice(-3);

        // Rim selection = the dice you've tapped to REROLL; the rest you keep.
        const sel = this.#currentSelectionValues();
        const selecting = myTurn && m.phase === "select";
        ctx.rerollCount = selecting ? sel.length : 0;
        ctx.keepCount = selecting ? Math.max(0, m.roll.length - sel.length) : 0;
        // Preview the hand you'd hold if you rerolled nothing more (the keepers).
        const keepers = selecting ? subtractMultiset(m.roll, sel) : [];
        ctx.currentHand = (selecting && keepers.length) ? this.#handName(keepers) : "";

        ctx.myTurn = myTurn;
        ctx.showRoll = myTurn && m.phase === "roll";
        ctx.showBet = myTurn && m.phase === "bet";
        ctx.showSelect = myTurn && m.phase === "select";
        ctx.showReroll = myTurn && m.phase === "rerolling";
        ctx.showResult = m.phase === "done";
        ctx.waitOpponent = !myTurn && m.phase !== "done";
        ctx.canNewGame = this.mode === "solo";

        // Betting view (best-of-three, heads-up only).
        ctx.betting = m.betting;
        if (m.betting) {
            const owed = mine ? m.owed(mine) : 0;
            ctx.bet = {
                pot: m.pot,
                currentBet: m.currentBet,
                owed,
                raiseStep: m.raiseStep,
                canCheck: ctx.showBet && owed === 0,
                canCall: ctx.showBet && owed > 0,
                canRaise: ctx.showBet && mine != null && m.canRaise(mine),
                callLabel: game.i18n.format("WITCHER.DicePoker.bet.callAmt", { amount: owed })
            };
            // Head-to-head score only reads for a multi-hand heads-up match;
            // 3+ seats run a single pot hand (target 1) where it is meaningless.
            ctx.scores = (mine && (m.continuous || m.target > 1))
                ? { me: m.scores[mine] ?? 0, opp: m.scores[this.#otherSeat(mine)] ?? 0 }
                : null;
            ctx.handNo = m.handNo;
            ctx.target = m.target;
            ctx.continuous = m.continuous;
            ctx.handLimit = m.handLimit;
        }

        ctx.isSolo = this.mode === "solo";
        ctx.canEndTable = this.isTable && game.user.isActiveGM && m.phase !== "done";
        ctx.canForfeit = this.isTable && mine != null && m.phase !== "done";
        ctx.showClose = !ctx.canEndTable && !ctx.canForfeit;

        ctx.boardW = BOARD_W;
        ctx.boardH = BOARD_H;

        if (m.phase === "done") {
            const winner = m.result.winners?.[0];
            ctx.result = {
                won: mine != null && winner === mine,
                pot: m.result.pot,
                winnerName: this.#seatName(winner),
                winnerHand: this.#handName(m.result.hands?.[winner])
            };
        }

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
        if (this.isTable) {
            unregisterTable(this.matchId);
            notifyLiveClosed();
        }
        return super._onClose(options);
    }

    /* --------------------------- action handlers ---------------------- */

    static #onCheck(event, target) { this.#humanBet("check"); }
    static #onCall(event, target) { this.#humanBet("call"); }
    static #onRaise(event, target) { this.#humanBet("raise"); }
    static #onFold(event, target) { this.#humanBet("fold"); }

    static #onStand(event, target) {
        if (!(this.match.toAct === this.mySeat && this.match.phase === "select")) return;
        this.#humanStand();
    }

    static #onReroll(event, target) {
        if (!(this.match.toAct === this.mySeat && this.match.phase === "select")) return;
        this.#humanReroll();
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
            { eg: [4, 4, 4, 4, 4], k: "fiveKind" },
            { eg: [3, 3, 3, 3, 6], k: "fourKind" },
            { eg: [2, 2, 2, 5, 5], k: "fullHouse" },
            { eg: [2, 3, 4, 5, 6], k: "straightHigh" },
            { eg: [1, 2, 3, 4, 5], k: "straightLow" },
            { eg: [6, 6, 6, 2, 1], k: "threeKind" },
            { eg: [6, 6, 3, 3, 1], k: "twoPair" },
            { eg: [6, 6, 4, 3, 1], k: "pair" },
            { eg: [6, 4, 3, 2, 1], k: "nothing" }
        ];
        const rows = combos.map(({ eg, k }) => `
            <div class="wdm-fk-rules-row">
                ${dice(eg)}
                <div class="wdm-fk-rules-text">
                    <strong>${game.i18n.localize(`WITCHER.DicePoker.hand.${k}`)}</strong>
                </div>
            </div>`).join("");
        const content = `
            <div class="wdm-farkle-rules">
                <p>${game.i18n.localize("WITCHER.DicePoker.rules.flow")}</p>
                <h4>${game.i18n.localize("WITCHER.DicePoker.rules.rankingTitle")}</h4>
                <div class="wdm-fk-rules-list">${rows}</div>
                <p class="wdm-fk-rules-note">${game.i18n.localize("WITCHER.DicePoker.rules.tie")}</p>
            </div>`;
        foundry.applications.api.DialogV2.prompt({
            window: { title: "WITCHER.DicePoker.rules.title", icon: "fa-solid fa-book" },
            classes: ["witcher-ttrpg-death-march", "wdm-farkle"],
            content,
            ok: { label: "WITCHER.DicePoker.rules.close" }
        });
    }

    static #onForfeit(event, target) {
        if (!(this.isTable && this.mySeat != null && this.match.phase !== "done")) return this.close();
        const seat = this.mySeat;
        this.#apply("forfeit", { seat });
        this.#relay("forfeit", { seat });
        // Pay out the leaver's net now (GM only — non-GM leavers are settled by the
        // GM when it processes the relayed forfeit). A match-ending forfeit then
        // sweeps the remaining seats via #maybeSettle.
        if (game.user.isActiveGM) {
            this.#settleSeats([seat], { close: false });
            if (this.match.phase !== "done") {
                this.mySeat = null;
                return this.#advance();
            }
            this.#maybeSettle();
        }
        this.close();
    }

    /** GM kicks a house gambler (an AI seat) out of the match: it forfeits on the
     *  spot, its committed coins stay in the pot, and its net is settled. The GM
     *  stays at the table — unlike #onForfeit, this neither nulls mySeat nor closes.
     *  Disabled mid-AI-turn/animation (guarded in canKick) so it can't apply a
     *  forfeit to a seat the AI loop is mid-acting on. */
    static #onForceForfeit(event, target) {
        const seat = target?.dataset?.seat;
        if (!(this.isTable && game.user.isActiveGM && this.match.phase !== "done")) return;
        if (seat == null || !this.#isAiSeat(seat) || this._aiBusy || this._oppAnimating) return;
        this.#say("WITCHER.DicePoker.log.npcForfeit", { name: this.#seatName(seat) });
        this.#apply("forfeit", { seat });
        this.#relay("forfeit", { seat });
        this.#settleSeats([seat], { close: false });
        if (this.match.phase === "done") { this.#logResult(); this.#maybeSettle(); return this.#refresh(); }
        return this.#advance();
    }

    static #onEndTable(event, target) {
        if (!(this.isTable && game.user.isActiveGM)) return;
        endTable();
        this.close();
    }

    static #onCloseAction(event, target) {
        this.close();
    }
}

/**
 * Launch the live N-seat table from a lobby roster.
 * @param {object} o
 * @param {string} o.matchId
 * @param {Array}  o.seats     roster [{ id, kind, userId, actorId, name, skill }]
 * @param {object} o.config    { ante, denom }
 * @param {object} o.seatDice  per-seat dice profiles
 * @param {string} o.starter
 * @param {?string} o.mySeat
 */
export function openDicePokerTableGame({ matchId, seats, config, seatDice, starter, mySeat }) {
    const app = new DicePokerApp({ mode: "table", matchId, seats, config, seatDice, starter, mySeat });
    app.render(true);
    return app;
}
