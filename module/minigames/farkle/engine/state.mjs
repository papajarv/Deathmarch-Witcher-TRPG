/**
 * Farkle match flow — pure, deterministic state machine.
 *
 * The engine never rolls dice itself: roll outcomes are INJECTED via
 * `submitRoll`. The 3D physics layer (or a seeded RNG, or a test) supplies the
 * values, so every networked client re-sims an identical result from shared
 * inputs. A die that falls off the board simply doesn't appear in the submitted
 * values — fewer values than dice in hand means those dice are lost for the turn.
 *
 * Two to four seats, drawn from "a", "b", "c", "d" in that canonical order.
 * `a` starts by default. Coin model: every seat antes into a pot; the first to
 * reach `target` banked points wins and takes the whole pot.
 *
 * Turn phases (for the seat in `toAct`):
 *   roll   → submitRoll(values)
 *            · no scoring die  → FARKLE: turn total lost, pass to next seat (→ roll)
 *            · scoring present → select
 *   select → setAside(values)  (≥1 valid scoring die; remaining dice stay in hand)
 *            → decide  (or, if all in-hand dice scored: HOT DICE, hand refills to 6)
 *   decide → bank()    → banked += turnTotal; reach target ⇒ done, else pass (→ roll)
 *          → rollAgain() → roll
 */

import { scoreSelection, hasAnyScore, bestScoreFull } from "./scoring.mjs";

const SEAT_IDS = ["a", "b", "c", "d"];
const HAND = 6;

export class FarkleMatch {
    constructor({ players, seats, target = 4000, ante = 50, starter = "a" } = {}) {
        // Resolve the seat list (2–4 seats) in canonical order. If `seats` isn't
        // given, derive it from the supplied players, defaulting to ["a","b"].
        let list = (seats ?? Object.keys(players ?? {})).filter(s => SEAT_IDS.includes(s));
        if (list.length < 2) list = ["a", "b"];
        this.seats = [...new Set(list)].sort((x, y) => SEAT_IDS.indexOf(x) - SEAT_IDS.indexOf(y));

        this.target = target;
        this.ante = ante;
        this.starter = this.seats.includes(starter) ? starter : this.seats[0];

        // Every seat antes into the pot up front.
        this.players = {};
        this.banked = {};
        for (const s of this.seats) {
            this.players[s] = { purse: (players?.[s]?.purse ?? 0) - ante };
            this.banked[s] = 0;
        }
        this.pot = ante * this.seats.length;

        this.toAct = this.starter;
        this.phase = "roll";
        this.diceInHand = HAND;
        this.turnTotal = 0;
        this.hotDice = false;
        this.lastRoll = [];        // values from the most recent submitRoll, still in hand
        this.result = null;        // { winner, loser|losers, pot }
        this.forfeited = [];       // seats that abandoned the match (kept for display)
    }

    /** Serialize the full match state to a plain, structured-cloneable object.
     *  Used to bring a late-joining / reconnecting client to the canonical
     *  state held by the authoritative client (the active GM in a table). */
    snapshot() {
        return structuredClone({
            seats: this.seats, target: this.target, ante: this.ante, starter: this.starter,
            players: this.players, banked: this.banked, pot: this.pot,
            toAct: this.toAct, phase: this.phase, diceInHand: this.diceInHand,
            turnTotal: this.turnTotal, hotDice: this.hotDice, lastRoll: this.lastRoll,
            result: this.result, forfeited: this.forfeited
        });
    }

    /** Overwrite this match with a snapshot (see snapshot()). */
    restore(s) {
        if (!s) return this;
        this.seats = [...s.seats];
        this.target = s.target;
        this.ante = s.ante;
        this.starter = s.starter;
        this.players = structuredClone(s.players);
        this.banked = structuredClone(s.banked);
        this.pot = s.pot;
        this.toAct = s.toAct;
        this.phase = s.phase;
        this.diceInHand = s.diceInHand;
        this.turnTotal = s.turnTotal;
        this.hotDice = s.hotDice;
        this.lastRoll = [...s.lastRoll];
        this.result = s.result ? structuredClone(s.result) : null;
        this.forfeited = [...(s.forfeited ?? [])];
        return this;
    }

    /** The seat that acts after `seat`, wrapping in seat order. */
    #next(seat) {
        const i = this.seats.indexOf(seat);
        return this.seats[(i + 1) % this.seats.length];
    }

    #assert(cond, msg) {
        if (!cond) throw new Error(`FarkleMatch: ${msg}`);
    }

    /** Best points obtainable from the current roll (UI hint / farkle = 0). */
    bestAvailable() {
        return bestScoreFull(this.lastRoll);
    }

    /**
     * Inject a roll for the active seat.
     * @param {"a"|"b"|"c"|"d"} seat
     * @param {number[]} values  faces that landed (≤ diceInHand; fewer = dice lost off-board)
     */
    submitRoll(seat, values) {
        this.#assert(this.phase === "roll", `submitRoll in phase ${this.phase}`);
        this.#assert(seat === this.toAct, `not ${seat}'s turn (waiting on ${this.toAct})`);
        this.#assert(Array.isArray(values) && values.length <= this.diceInHand,
            `roll has ${values?.length} values but only ${this.diceInHand} dice in hand`);
        this.#assert(values.every(v => v >= 1 && v <= 6), "die values must be 1–6");

        this.lastRoll = [...values];
        if (!hasAnyScore(this.lastRoll)) {
            // Farkle: forfeit the unbanked turn total and pass.
            this.turnTotal = 0;
            this.#endTurn();
            return this;
        }
        this.phase = "select";
        return this;
    }

    /**
     * Set aside a chosen scoring selection from the current roll.
     * @param {"a"|"b"|"c"|"d"} seat
     * @param {number[]} values  faces to keep; must be a valid scoring set and a subset of the roll
     */
    setAside(seat, values) {
        this.#assert(this.phase === "select", `setAside in phase ${this.phase}`);
        this.#assert(seat === this.toAct, `not ${seat}'s turn (waiting on ${this.toAct})`);
        this.#assert(this.#isSubsetOf(values, this.lastRoll), "selection is not part of the roll");

        const { valid, points } = scoreSelection(values);
        this.#assert(valid && points > 0, "selection is not a valid scoring combination");

        this.turnTotal += points;
        const remaining = this.lastRoll.length - values.length;
        if (remaining === 0) {
            this.hotDice = true;
            this.diceInHand = HAND;       // hot dice: fresh full hand
        } else {
            this.hotDice = false;
            this.diceInHand = remaining;
        }
        this.lastRoll = [];
        this.phase = "decide";
        return this;
    }

    /** Bank the turn total and end the turn (may win the match). */
    bank(seat) {
        this.#assert(this.phase === "decide", `bank in phase ${this.phase}`);
        this.#assert(seat === this.toAct, `not ${seat}'s turn (waiting on ${this.toAct})`);
        this.banked[seat] += this.turnTotal;
        if (this.banked[seat] >= this.target) {
            this.#settle(seat);
            return this;
        }
        this.#endTurn();
        return this;
    }

    /** Roll the dice remaining in hand again (push your luck). */
    rollAgain(seat) {
        this.#assert(this.phase === "decide", `rollAgain in phase ${this.phase}`);
        this.#assert(seat === this.toAct, `not ${seat}'s turn (waiting on ${this.toAct})`);
        this.phase = "roll";
        return this;
    }

    /**
     * A seat abandons the match. Its ante stays in the pot (it is NOT refunded
     * here — the GM "end table" path handles refunds out-of-band). If only one
     * seat is left standing, that seat wins by walkover and takes the whole pot.
     * @param {"a"|"b"|"c"|"d"} seat
     */
    forfeit(seat) {
        if (this.phase === "done" || !this.seats.includes(seat)) return this;
        const successor = this.#next(seat);   // resolve BEFORE removing the seat
        const wasActing = this.toAct === seat;
        this.seats = this.seats.filter(s => s !== seat);
        if (!this.forfeited.includes(seat)) this.forfeited.push(seat);
        if (this.seats.length === 1) {
            this.#settle(this.seats[0]);
            return this;
        }
        if (wasActing) {
            this.toAct = this.seats.includes(successor) ? successor : this.seats[0];
            this.turnTotal = 0;
            this.hotDice = false;
            this.diceInHand = HAND;
            this.lastRoll = [];
            this.phase = "roll";
        }
        return this;
    }

    #endTurn() {
        this.turnTotal = 0;
        this.hotDice = false;
        this.diceInHand = HAND;
        this.lastRoll = [];
        this.toAct = this.#next(this.toAct);
        this.phase = "roll";
    }

    #settle(winner) {
        this.players[winner].purse += this.pot;
        // Preserve the 2-seat result shape; report all non-winners for 3–4 seats.
        if (this.seats.length === 2) {
            this.result = { winner, loser: this.#next(winner), pot: this.pot };
        } else {
            this.result = { winner, losers: this.seats.filter(s => s !== winner), pot: this.pot };
        }
        this.phase = "done";
    }

    /** True if every value in `sub` exists in `sup` with sufficient multiplicity. */
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
