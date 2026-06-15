/**
 * Witcher dice poker — match flow, pure deterministic state machine.
 *
 * Like the Farkle engine, this never rolls dice itself: outcomes are INJECTED
 * via `submitRoll` / `submitReroll` (from the 3D layer, a seeded RNG, or a
 * test), so every networked client re-sims an identical result from shared
 * inputs.
 *
 * Two flavours share this machine:
 *
 *  • WITCHER 1 (heads-up, the default for 2 seats): a MATCH is best-of-three
 *    HANDS, with a betting round in each hand. One hand is:
 *      roll   — both seats throw their opening five
 *      bet    — a betting round: check / raise / call / surrender(fold)
 *      select — both seats keep a subset and reroll the rest once
 *      showdown — best hand takes the hand's pot; that seat scores the hand
 *    First seat to `target` (2) hand-wins takes the match. A surrender hands
 *    the pot to the opponent immediately (no reroll). An exact tie replays the
 *    hand, pot carried, no fresh ante, no score change.
 *
 *  • WITCHER 2 (3–4 seats, or `betting:false`): a single hand, no betting —
 *    everyone throws, everyone rerolls, best hand takes the whole pot. (This is
 *    the round-based flow the table lobby uses for >2 players.)
 *
 * Outcomes are injected and every move is relayed, so all networked clients
 * re-sim an identical match. Only `toAct` moves; the engine cycles it.
 *
 * Phases:
 *   roll      → submitRoll(values)        opening five for the seat in `toAct`
 *   bet       → check()/raise()/call()/fold()   heads-up betting (W1 only)
 *   select    → stand() | reroll(keepValues)    keep a subset; rest re-throw
 *   rerolling → submitReroll(newValues)         the re-thrown faces → final hand
 *   (hand resolves) → showdown → next hand | match done | replay (tie)
 */

import { evaluateHand, compareEval } from "./hands.mjs";

const SEAT_IDS = ["a", "b", "c", "d"];
const DICE = 5;

export class DicePokerMatch {
    constructor({ players, seats, dice = DICE, ante = 50, starter = "a",
                  betting, target, raiseStep, maxRaises = 3, continuous = false,
                  handLimit = 0 } = {}) {
        let list = (seats ?? Object.keys(players ?? {})).filter(s => SEAT_IDS.includes(s));
        if (list.length < 2) list = ["a", "b"];
        this.seats = [...new Set(list)].sort((x, y) => SEAT_IDS.indexOf(x) - SEAT_IDS.indexOf(y));

        this.dice = dice;
        this.ante = ante;
        this.starter = this.seats.includes(starter) ? starter : this.seats[0];

        // Betting (a check/call/raise/fold round between the opening throw and the
        // reroll) runs at every table by default. Heads-up is best-of-`target`
        // hands; 3+ seats play a single betting hand unless a target is given.
        this.betting = betting ?? true;
        this.target = target ?? (this.seats.length === 2 ? 2 : 1);
        // Continuous play: keep dealing fresh-ante hands until a seat can't cover
        // the ante or forfeits — the score target never ends the match.
        this.continuous = continuous;
        // Fixed-length session: play exactly `handLimit` hands (0 = no limit),
        // then settle — the richest purse is the overall winner. Used by 3–4
        // player tables in place of heads-up best-of-N. Tie replays don't count.
        this.handLimit = handLimit ?? 0;
        this.raiseStep = raiseStep ?? Math.max(1, ante);
        this.maxRaises = maxRaises;

        this.players = {};
        for (const s of this.seats) this.players[s] = { purse: (players?.[s]?.purse ?? 0) - ante };
        this.pot = ante * this.seats.length;

        this.scores = {};
        for (const s of this.seats) this.scores[s] = 0;
        this.handNo = 1;

        // Per-hand betting ledger.
        this.committed = {};
        for (const s of this.seats) this.committed[s] = ante;
        this.currentBet = ante;
        this.raises = 0;
        this.aggressor = null;
        this.acted = {};
        for (const s of this.seats) this.acted[s] = false;

        this.toAct = this.starter;
        this.phase = "roll";       // round 1: opening throws
        this.roll = [];            // the active seat's dice currently on the felt
        this.keep = [];            // values the active seat kept for its reroll
        this.rolls = {};           // seat → opening throw (round 1)
        this.hands = {};           // seat → locked five-die hand (round 2)
        this.replays = 0;          // how many times a tie has forced a re-play
        this.handResult = null;    // { winner, hands, pot, folded, handNo } — last hand
        this.result = null;        // { winners, pot, hands, scores, draw } — whole match
        this.forfeited = [];       // seats that abandoned the MATCH
        this.out = [];             // seats that folded THIS hand (reset each hand)
    }

    /** Serialize to a plain, structured-cloneable object (for late joiners). */
    snapshot() {
        return structuredClone({
            seats: this.seats, dice: this.dice, ante: this.ante, starter: this.starter,
            betting: this.betting, target: this.target, continuous: this.continuous,
            handLimit: this.handLimit,
            raiseStep: this.raiseStep, maxRaises: this.maxRaises,
            players: this.players, pot: this.pot, scores: this.scores, handNo: this.handNo,
            committed: this.committed, currentBet: this.currentBet, raises: this.raises,
            aggressor: this.aggressor, acted: this.acted,
            toAct: this.toAct, phase: this.phase, roll: this.roll, keep: this.keep,
            rolls: this.rolls, hands: this.hands, replays: this.replays,
            handResult: this.handResult, result: this.result,
            forfeited: this.forfeited, out: this.out
        });
    }

    /** Overwrite this match from a snapshot. */
    restore(s) {
        if (!s) return this;
        this.seats = [...s.seats];
        this.dice = s.dice;
        this.ante = s.ante;
        this.starter = s.starter;
        this.betting = s.betting ?? (this.seats.length === 2);
        this.target = s.target ?? (this.betting ? 2 : 1);
        this.continuous = s.continuous ?? false;
        this.handLimit = s.handLimit ?? 0;
        this.raiseStep = s.raiseStep ?? Math.max(1, s.ante ?? 0);
        this.maxRaises = s.maxRaises ?? 3;
        this.players = structuredClone(s.players);
        this.pot = s.pot;
        this.scores = structuredClone(s.scores ?? {});
        this.handNo = s.handNo ?? 1;
        this.committed = structuredClone(s.committed ?? {});
        this.currentBet = s.currentBet ?? 0;
        this.raises = s.raises ?? 0;
        this.aggressor = s.aggressor ?? null;
        this.acted = structuredClone(s.acted ?? {});
        this.toAct = s.toAct;
        this.phase = s.phase;
        this.roll = [...s.roll];
        this.keep = [...s.keep];
        this.rolls = structuredClone(s.rolls ?? {});
        this.hands = structuredClone(s.hands);
        this.replays = s.replays ?? 0;
        this.handResult = s.handResult ? structuredClone(s.handResult) : null;
        this.result = s.result ? structuredClone(s.result) : null;
        this.forfeited = [...(s.forfeited ?? [])];
        this.out = [...(s.out ?? [])];
        return this;
    }

    #next(seat) {
        const i = this.seats.indexOf(seat);
        const base = i < 0 ? -1 : i;
        return this.seats[(base + 1) % this.seats.length];
    }

    /** Seats still live in the current hand (anted in, not folded this hand). */
    #live() {
        return this.seats.filter(s => !this.out.includes(s));
    }

    /** Next live (non-folded) seat cyclically after `seat`. */
    #nextLive(seat) {
        let n = this.#next(seat);
        for (let i = 0; i < this.seats.length; i++) {
            if (!this.out.includes(n)) return n;
            n = this.#next(n);
        }
        return null;
    }

    /** The richest remaining seat — used to settle the match when seats drop out. */
    #richest() {
        const pool = this.seats.length ? this.seats : this.forfeited.slice(-1);
        let best = pool[0];
        for (const s of pool) {
            if ((this.players[s]?.purse ?? 0) > (this.players[best]?.purse ?? 0)) best = s;
        }
        return best;
    }

    #assert(cond, msg) {
        if (!cond) throw new Error(`DicePokerMatch: ${msg}`);
    }

    /** Has every active seat made its opening throw this round? */
    #allRolled() {
        return this.seats.every(s => Array.isArray(this.rolls[s]));
    }

    /** Has every live (non-folded) seat locked a hand this round? */
    #allDone() {
        return this.#live().every(s => Array.isArray(this.hands[s]));
    }

    /** Next seat (cyclic from `from`) matching `pred`, or null if none. */
    #advanceWithin(pred, from) {
        let n = this.#next(from);
        for (let i = 0; i < this.seats.length; i++) {
            if (pred(n)) return n;
            n = this.#next(n);
        }
        return null;
    }

    /** After all opening throws: open a betting round (W1) or go straight to the
     *  reroll round (W2). */
    #afterOpening() {
        if (this.betting) this.#beginBetRound();
        else this.#beginRerollRound();
    }

    /** Open the heads-up betting round. Both seats have anted equally, so the
     *  starter may check or raise. */
    #beginBetRound() {
        this.phase = "bet";
        this.toAct = this.seats.includes(this.starter) ? this.starter : this.seats[0];
        this.raises = 0;
        this.aggressor = null;
        for (const s of this.seats) this.acted[s] = false;
        this.roll = [...(this.rolls[this.toAct] ?? [])];
        this.keep = [];
    }

    /** Begin round 2 (rerolls): seat the starter (or first live survivor) to
     *  select. Folded seats sit the round out. */
    #beginRerollRound() {
        const live = this.#live();
        const n = live.includes(this.starter) ? this.starter : live[0];
        this.toAct = n;
        this.phase = "select";
        this.roll = [...this.rolls[n]];
        this.keep = [];
    }

    /**
     * Inject the active seat's opening throw (round 1).
     * @param {"a"|"b"|"c"|"d"} seat
     * @param {number[]} values  the faces that landed (≤ dice; fewer = dice lost off-board)
     */
    submitRoll(seat, values) {
        this.#assert(this.phase === "roll", `submitRoll in phase ${this.phase}`);
        this.#assert(seat === this.toAct, `not ${seat}'s turn (waiting on ${this.toAct})`);
        this.#assert(Array.isArray(values) && values.length <= this.dice,
            `roll has ${values?.length} values but only ${this.dice} dice`);
        this.#assert(values.every(v => v >= 1 && v <= 6), "die values must be 1–6");

        this.rolls[seat] = [...values];
        if (this.#allRolled()) { this.#afterOpening(); return this; }
        // Next seat that still needs its opening throw.
        this.toAct = this.#advanceWithin(s => !Array.isArray(this.rolls[s]), seat) ?? this.seats[0];
        this.phase = "roll";
        this.roll = [];
        this.keep = [];
        return this;
    }

    /* ----------------------------- betting ---------------------------- */

    /** Coins a seat must still put in to match the current bet. */
    owed(seat) {
        return Math.max(0, this.currentBet - (this.committed[seat] ?? 0));
    }

    /**
     * Can the seat still raise? The per-round raise cap (`maxRaises`) applies
     * with three or more live seats; heads-up (two live) the cap is lifted, the
     * standard limit-poker rule. The seat must also have coins beyond the call.
     */
    canRaise(seat) {
        if (this.phase !== "bet" || seat !== this.toAct) return false;
        const capped = this.#live().length > 2 && this.raises >= this.maxRaises;
        return !capped && (this.players[seat]?.purse ?? 0) > this.owed(seat);
    }

    #payInto(seat, amount) {
        const pay = Math.min(amount, this.players[seat].purse);
        this.players[seat].purse -= pay;
        this.committed[seat] += pay;
        this.pot += pay;
        return pay;
    }

    /** The betting round closes once every live seat has acted and owes nothing
     *  (all checked around, or the last raise has been called by everyone). */
    #betRoundComplete() {
        return this.#live().every(s => this.acted[s] && this.owed(s) === 0);
    }

    /** Hand the action to the next live seat, or close the round if it's over. */
    #advanceBetting(seat) {
        if (this.#betRoundComplete()) { this.#beginRerollRound(); return; }
        const n = this.#nextLive(seat);
        this.toAct = n;
        this.roll = [...(this.rolls[n] ?? [])];
    }

    /** No money on the line to call — stay in and pass (or close the round). */
    check(seat) {
        this.#assert(this.phase === "bet", `check in phase ${this.phase}`);
        this.#assert(seat === this.toAct, `not ${seat}'s turn (waiting on ${this.toAct})`);
        this.#assert(this.owed(seat) === 0, "cannot check facing a bet — call, raise or surrender");
        this.acted[seat] = true;
        this.#advanceBetting(seat);
        return this;
    }

    /** Match the current bet and pass the action on. */
    call(seat) {
        this.#assert(this.phase === "bet", `call in phase ${this.phase}`);
        this.#assert(seat === this.toAct, `not ${seat}'s turn (waiting on ${this.toAct})`);
        this.#assert(this.owed(seat) > 0, "nothing to call — check instead");
        this.#payInto(seat, this.owed(seat));
        this.acted[seat] = true;
        this.#advanceBetting(seat);
        return this;
    }

    /** Add `raiseStep` over the current bet (covering any call first). Every other
     *  live seat must respond again. Capped at the seat's purse and (3+ seats)
     *  at `maxRaises`. */
    raise(seat) {
        this.#assert(this.phase === "bet", `raise in phase ${this.phase}`);
        this.#assert(this.canRaise(seat), "cannot raise — limit reached or not enough coin");
        this.#payInto(seat, this.owed(seat) + this.raiseStep);
        this.currentBet = this.committed[seat];
        this.raises++;
        this.aggressor = seat;
        for (const s of this.#live()) this.acted[s] = false;
        this.acted[seat] = true;
        this.#advanceBetting(seat);
        return this;
    }

    /** Surrender the hand: the seat folds, its committed coins stay in the pot.
     *  If only one live seat remains it takes the pot immediately (no reroll). */
    fold(seat) {
        this.#assert(this.phase === "bet", `fold in phase ${this.phase}`);
        this.#assert(seat === this.toAct, `not ${seat}'s turn (waiting on ${this.toAct})`);
        if (!this.out.includes(seat)) this.out.push(seat);
        const live = this.#live();
        if (live.length === 1) { this.#awardHand(live[0], { folded: true }); return this; }
        this.#advanceBetting(seat);
        return this;
    }

    /** Lock the active seat's opening five as its hand (no reroll). */
    stand(seat) {
        this.#assert(this.phase === "select", `stand in phase ${this.phase}`);
        this.#assert(seat === this.toAct, `not ${seat}'s turn (waiting on ${this.toAct})`);
        this.#finishSeat(seat, [...this.roll]);
        return this;
    }

    /**
     * Keep a subset of the opening five and re-throw the rest (round 2).
     * @param {"a"|"b"|"c"|"d"} seat
     * @param {number[]} keepValues  faces to keep (a subset of the roll); [] rerolls all,
     *                               a full set is equivalent to standing.
     */
    reroll(seat, keepValues) {
        this.#assert(this.phase === "select", `reroll in phase ${this.phase}`);
        this.#assert(seat === this.toAct, `not ${seat}'s turn (waiting on ${this.toAct})`);
        const keep = Array.isArray(keepValues) ? keepValues : [];
        this.#assert(this.#isSubsetOf(keep, this.roll) || keep.length === 0,
            "kept dice are not part of the roll");
        if (keep.length >= this.roll.length) {     // keeping everything = stand
            this.#finishSeat(seat, [...this.roll]);
            return this;
        }
        this.keep = [...keep];
        this.phase = "rerolling";
        return this;
    }

    /** How many dice the active seat will re-throw (valid only in "rerolling"). */
    rerollCount() {
        return Math.max(0, this.roll.length - this.keep.length);
    }

    /**
     * Inject the re-thrown faces; combined with the kept dice they form the hand.
     * @param {"a"|"b"|"c"|"d"} seat
     * @param {number[]} newValues  the re-thrown faces (≤ rerollCount(); fewer = lost off-board)
     */
    submitReroll(seat, newValues) {
        this.#assert(this.phase === "rerolling", `submitReroll in phase ${this.phase}`);
        this.#assert(seat === this.toAct, `not ${seat}'s turn (waiting on ${this.toAct})`);
        this.#assert(Array.isArray(newValues) && newValues.length <= this.rerollCount(),
            `reroll has ${newValues?.length} values but only ${this.rerollCount()} dice re-thrown`);
        this.#assert(newValues.every(v => v >= 1 && v <= 6), "die values must be 1–6");

        this.#finishSeat(seat, [...this.keep, ...newValues]);
        return this;
    }

    /**
     * A seat abandons the match; its committed coins stay in the pot. With only
     * one seat left, that seat wins by walkover (takes the pot, match over).
     */
    forfeit(seat) {
        if (this.phase === "done" || !this.seats.includes(seat)) return this;
        const wasActing = this.toAct === seat;
        this.seats = this.seats.filter(s => s !== seat);
        delete this.hands[seat];
        delete this.rolls[seat];
        delete this.hands[seat];
        this.out = this.out.filter(s => s !== seat);
        if (!this.forfeited.includes(seat)) this.forfeited.push(seat);

        if (this.seats.length === 1) { this.#walkover(this.seats[0]); return this; }

        if (this.phase === "roll") {                 // round 1
            if (this.#allRolled()) { this.#afterOpening(); return this; }
            if (wasActing) {
                this.toAct = this.#advanceWithin(s => !Array.isArray(this.rolls[s]), seat) ?? this.seats[0];
                this.phase = "roll";
                this.roll = [];
                this.keep = [];
            }
            return this;
        }

        if (this.phase === "bet") {                   // mid-betting
            if (this.#live().length === 1) { this.#awardHand(this.#live()[0], { folded: true }); return this; }
            if (wasActing) this.#advanceBetting(seat);
            return this;
        }

        // round 2 (select / rerolling)
        if (this.#allDone()) { this.#showdown(); return this; }
        if (wasActing) {
            const n = this.#advanceWithin(
                s => !this.out.includes(s) && !Array.isArray(this.hands[s]), seat) ?? this.#live()[0];
            this.toAct = n;
            this.phase = "select";
            this.roll = Array.isArray(this.rolls[n]) ? [...this.rolls[n]] : [];
            this.keep = [];
        }
        return this;
    }

    #finishSeat(seat, hand) {
        this.hands[seat] = hand;
        this.keep = [];
        if (this.#allDone()) { this.roll = []; this.#showdown(); return; }
        // Advance to the next live seat that has not yet locked a hand (round 2).
        const n = this.#advanceWithin(
            s => !this.out.includes(s) && !Array.isArray(this.hands[s]), seat) ?? this.#live()[0];
        this.toAct = n;
        this.phase = "select";
        this.roll = Array.isArray(this.rolls[n]) ? [...this.rolls[n]] : [];
        this.keep = [];
    }

    #showdown() {
        const ranked = this.#live().map(s => ({ seat: s, eval: evaluateHand(this.hands[s]) }));
        let best = ranked[0];
        for (const r of ranked) if (compareEval(r.eval, best.eval) > 0) best = r;
        const winners = ranked.filter(r => compareEval(r.eval, best.eval) === 0).map(r => r.seat);
        if (winners.length > 1) {           // exact tie for best → replay the hand
            this.#replayHand();
            return;
        }
        this.#awardHand(winners[0], {});
    }

    /** Replay the current hand after a tie: pot carries, no fresh ante, no score
     *  change. Betting ledger resets (nobody owes anything yet). */
    #replayHand() {
        this.replays++;
        this.rolls = {};
        this.hands = {};
        this.roll = [];
        this.keep = [];
        this.currentBet = 0;
        this.raises = 0;
        this.aggressor = null;
        this.out = [];
        for (const s of this.seats) { this.committed[s] = 0; this.acted[s] = false; }
        this.toAct = this.seats.includes(this.starter) ? this.starter : this.seats[0];
        this.phase = "roll";
    }

    /** Award the current hand's pot to `winner`, score the hand, and either end
     *  the match (target reached) or deal the next hand. */
    #awardHand(winner, { folded = false } = {}) {
        this.players[winner].purse += this.pot;
        this.scores[winner] = (this.scores[winner] ?? 0) + 1;
        this.handResult = {
            winner,
            hands: structuredClone(this.hands),
            pot: this.pot,
            folded,
            handNo: this.handNo
        };
        // Fixed-length session: once the last scheduled hand is settled, the
        // richest purse wins outright (tie replays don't advance handNo).
        if (this.handLimit && this.handNo >= this.handLimit) { this.#finishMatch(this.#richest()); return; }
        if (!this.handLimit && !this.continuous && this.scores[winner] >= this.target) { this.#finishMatch(winner); return; }
        this.#nextHand();
    }

    /** Deal the next hand: fresh ante, fresh dice. Seats that can't cover the
     *  ante drop out of the match; if fewer than two remain, the richest wins. */
    #nextHand() {
        this.handNo++;
        for (const s of [...this.seats]) {
            if (this.players[s].purse < this.ante) {
                this.seats = this.seats.filter(x => x !== s);
                if (!this.forfeited.includes(s)) this.forfeited.push(s);
            }
        }
        if (this.seats.length < 2) { this.#finishMatch(this.#richest()); return; }

        for (const s of this.seats) {
            this.players[s].purse -= this.ante;
            this.committed[s] = this.ante;
            this.acted[s] = false;
        }
        this.pot = this.ante * this.seats.length;
        this.currentBet = this.ante;
        this.raises = 0;
        this.aggressor = null;
        this.out = [];
        this.rolls = {};
        this.hands = {};
        this.roll = [];
        this.keep = [];
        this.starter = this.seats.includes(this.starter) ? this.starter : this.seats[0];
        this.toAct = this.starter;
        this.phase = "roll";
    }

    #finishMatch(winner) {
        this.result = {
            winners: [winner],
            pot: this.pot,
            hands: structuredClone(this.hands),
            scores: structuredClone(this.scores),
            draw: false
        };
        this.phase = "done";
    }

    /** A walkover (the only remaining seat wins the match and the pot). */
    #walkover(winner) {
        this.players[winner].purse += this.pot;
        this.scores[winner] = (this.scores[winner] ?? 0);
        this.result = {
            winners: [winner],
            pot: this.pot,
            hands: structuredClone(this.hands),
            scores: structuredClone(this.scores),
            draw: false
        };
        this.phase = "done";
    }

    #isSubsetOf(sub, sup) {
        if (!Array.isArray(sub) || sub.length === 0 || sub.length > sup.length) return false;
        const counts = [0, 0, 0, 0, 0, 0, 0];
        for (const v of sup) counts[v]++;
        for (const v of sub) {
            if (v < 1 || v > 6 || --counts[v] < 0) return false;
        }
        return true;
    }
}
