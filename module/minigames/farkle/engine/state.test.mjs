import test from "node:test";
import assert from "node:assert/strict";
import { FarkleMatch } from "./state.mjs";

function fresh(opts = {}) {
    return new FarkleMatch({ players: { a: { purse: 1000 }, b: { purse: 1000 } }, target: 1000, ante: 50, ...opts });
}

test("ante is deducted into the pot at start", () => {
    const m = fresh();
    assert.equal(m.players.a.purse, 950);
    assert.equal(m.players.b.purse, 950);
    assert.equal(m.pot, 100);
    assert.equal(m.toAct, "a");
    assert.equal(m.phase, "roll");
    assert.equal(m.diceInHand, 6);
});

test("score, bank, pass to opponent", () => {
    const m = fresh();
    m.submitRoll("a", [1, 2, 3, 3, 4, 6]);     // only the 1 scores
    assert.equal(m.phase, "select");
    m.setAside("a", [1]);
    assert.equal(m.turnTotal, 100);
    assert.equal(m.diceInHand, 5);
    assert.equal(m.phase, "decide");
    m.bank("a");
    assert.equal(m.banked.a, 100);
    assert.equal(m.toAct, "b");
    assert.equal(m.phase, "roll");
    assert.equal(m.turnTotal, 0);
});

test("farkle forfeits the turn total and passes", () => {
    const m = fresh();
    m.submitRoll("a", [1]);
    m.setAside("a", [1]);
    m.rollAgain("a");
    assert.equal(m.phase, "roll");
    m.submitRoll("a", [2, 3, 4, 6]);           // nothing scores
    assert.equal(m.toAct, "b");
    assert.equal(m.phase, "roll");
    assert.equal(m.banked.a, 0);               // 100 was unbanked, lost
});

test("hot dice refills the hand to six", () => {
    const m = fresh();
    m.submitRoll("a", [1, 1, 1, 5, 5, 5]);     // all six score (two triplets = 2500)
    m.setAside("a", [1, 1, 1, 5, 5, 5]);
    assert.equal(m.turnTotal, 2500);
    assert.equal(m.hotDice, true);
    assert.equal(m.diceInHand, 6);
    assert.equal(m.phase, "decide");
});

test("partial set-aside leaves the rest in hand", () => {
    const m = fresh();
    m.submitRoll("a", [1, 1, 5, 2, 3, 4]);
    m.setAside("a", [1, 1]);                   // keep the pair of 1s only
    assert.equal(m.turnTotal, 200);
    assert.equal(m.diceInHand, 4);
    assert.equal(m.hotDice, false);
});

test("rejects a selection not present in the roll", () => {
    const m = fresh();
    m.submitRoll("a", [1, 2, 3, 4, 5, 6]);
    assert.throws(() => m.setAside("a", [1, 1]), /not part of the roll/);
});

test("rejects a non-scoring selection", () => {
    const m = fresh();
    m.submitRoll("a", [1, 2, 3, 4, 5, 6]);     // straight; but picking just the 2 is invalid
    assert.throws(() => m.setAside("a", [2]), /valid scoring/);
});

test("reaching the target wins the pot", () => {
    const m = fresh({ target: 1000 });
    m.submitRoll("a", [1, 1, 1, 5, 5, 5]);     // 1500, hot dice
    m.setAside("a", [1, 1, 1, 5, 5, 5]);
    m.bank("a");
    assert.equal(m.phase, "done");
    assert.deepEqual(m.result, { winner: "a", loser: "b", pot: 100 });
    assert.equal(m.players.a.purse, 950 + 100); // net +50 (won opponent's ante)
    assert.equal(m.players.b.purse, 950);
});

test("turn order alternates a → b → a", () => {
    const m = fresh();
    m.submitRoll("a", [2, 3, 4, 6, 2, 3]);     // farkle
    assert.equal(m.toAct, "b");
    m.submitRoll("b", [3, 4, 6, 2, 3, 4]);     // farkle
    assert.equal(m.toAct, "a");
});

test("dice lost off-board reduce the hand", () => {
    const m = fresh();
    m.submitRoll("a", [1, 5]);                 // rolled 6, only 2 landed
    m.setAside("a", [1]);
    assert.equal(m.diceInHand, 1);             // one landed die remains, not five
});

test("four seats ante into a pot of ante × seats", () => {
    const m = new FarkleMatch({
        players: { a: { purse: 1000 }, b: { purse: 1000 }, c: { purse: 1000 }, d: { purse: 1000 } },
        target: 1000, ante: 50
    });
    assert.deepEqual(m.seats, ["a", "b", "c", "d"]);
    assert.equal(m.pot, 200);
    for (const s of m.seats) assert.equal(m.players[s].purse, 950);
    assert.equal(m.toAct, "a");
});

test("turn order rotates through all seats and wraps", () => {
    const m = new FarkleMatch({ seats: ["a", "b", "c"], players: { a: {}, b: {}, c: {} } });
    m.submitRoll("a", [2, 3, 4, 6, 2, 3]);     // farkle
    assert.equal(m.toAct, "b");
    m.submitRoll("b", [2, 3, 4, 6, 2, 3]);     // farkle
    assert.equal(m.toAct, "c");
    m.submitRoll("c", [2, 3, 4, 6, 2, 3]);     // farkle
    assert.equal(m.toAct, "a");                // wrapped
});

test("explicit starter and seat order from `seats`", () => {
    const m = new FarkleMatch({ seats: ["d", "a", "c"], players: {}, starter: "c" });
    assert.deepEqual(m.seats, ["a", "c", "d"]); // canonicalised
    assert.equal(m.starter, "c");
    assert.equal(m.toAct, "c");
});

test("winner takes the whole multi-seat pot; losers reported", () => {
    const m = new FarkleMatch({
        players: { a: { purse: 100 }, b: { purse: 100 }, c: { purse: 100 } },
        seats: ["a", "b", "c"], target: 1000, ante: 50
    });
    m.submitRoll("a", [1, 1, 1, 5, 5, 5]);     // 1500, hot dice
    m.setAside("a", [1, 1, 1, 5, 5, 5]);
    m.bank("a");
    assert.equal(m.phase, "done");
    assert.deepEqual(m.result, { winner: "a", losers: ["b", "c"], pot: 150 });
    assert.equal(m.players.a.purse, 50 + 150);
});

test("guards enforce phase and turn", () => {
    const m = fresh();
    assert.throws(() => m.setAside("a", [1]), /setAside in phase roll/);
    assert.throws(() => m.bank("a"), /bank in phase roll/);
    m.submitRoll("a", [1, 2, 3, 4, 5, 6]);
    assert.throws(() => m.submitRoll("b", [1]), /submitRoll in phase select/);
    assert.throws(() => m.setAside("b", [1]), /not b's turn/);
});

test("forfeit by the non-acting seat leaves the same seat to act", () => {
    const m = new FarkleMatch({
        players: { a: { purse: 100 }, b: { purse: 100 }, c: { purse: 100 } },
        seats: ["a", "b", "c"], target: 1000, ante: 50
    });
    m.submitRoll("a", [1]);          // a is mid-turn (select)
    m.forfeit("c");                  // a non-acting seat bails
    assert.deepEqual(m.seats, ["a", "b"]);
    assert.equal(m.toAct, "a");      // a keeps acting, phase untouched
    assert.equal(m.phase, "select");
    assert.equal(m.pot, 150);        // c's ante stays in the pot
});

test("forfeited seats are recorded (and survive a snapshot round-trip)", () => {
    const m = new FarkleMatch({
        players: { a: { purse: 100 }, b: { purse: 100 }, c: { purse: 100 } },
        seats: ["a", "b", "c"], target: 1000, ante: 50
    });
    m.submitRoll("a", [1]);
    m.forfeit("c");
    assert.deepEqual(m.forfeited, ["c"]);     // kept for display even though out of play
    assert.ok(!m.seats.includes("c"));        // but removed from turn order
    const restored = new FarkleMatch({ players: { a: {}, b: {} } }).restore(m.snapshot());
    assert.deepEqual(restored.forfeited, ["c"]);
});

test("forfeit by the acting seat passes a fresh turn to the successor", () => {
    const m = new FarkleMatch({
        players: { a: { purse: 100 }, b: { purse: 100 }, c: { purse: 100 } },
        seats: ["a", "b", "c"], target: 1000, ante: 50
    });
    m.submitRoll("a", [1]);
    m.forfeit("a");                  // the active seat bails mid-turn
    assert.deepEqual(m.seats, ["b", "c"]);
    assert.equal(m.toAct, "b");      // successor takes a fresh turn
    assert.equal(m.phase, "roll");
    assert.equal(m.turnTotal, 0);
});

test("when forfeits leave one seat it wins the whole pot by walkover", () => {
    const m = new FarkleMatch({
        players: { a: { purse: 100 }, b: { purse: 100 }, c: { purse: 100 } },
        seats: ["a", "b", "c"], target: 1000, ante: 50
    });
    m.forfeit("b");
    m.forfeit("c");
    assert.equal(m.phase, "done");
    assert.equal(m.result.winner, "a");
    assert.equal(m.result.pot, 150);          // all three antes
    assert.equal(m.players.a.purse, 50 + 150);
});

test("forfeit after the match is done is a no-op", () => {
    const m = fresh();
    m.submitRoll("a", [1, 1, 1, 5, 5, 5]);
    m.setAside("a", [1, 1, 1, 5, 5, 5]);
    m.bank("a");                               // a wins (1500 ≥ 1000)
    assert.equal(m.phase, "done");
    const before = m.result;
    m.forfeit("b");
    assert.equal(m.result, before);
});

test("snapshot/restore round-trips mid-turn state onto a blank match", () => {
    const m = fresh();
    m.submitRoll("a", [1, 5, 2, 3, 4, 6]);   // straight available, but pick partial
    m.setAside("a", [1, 5]);                  // turnTotal 150, 4 dice in hand, decide
    const snap = m.snapshot();

    const other = fresh();                    // a different live match
    other.submitRoll("a", [2, 2, 2]);         // advance it elsewhere
    other.restore(snap);

    assert.equal(other.phase, "decide");
    assert.equal(other.toAct, "a");
    assert.equal(other.turnTotal, 150);
    assert.equal(other.diceInHand, 4);
    assert.deepEqual(other.seats, ["a", "b"]);
    assert.equal(other.pot, 100);
});

test("restore deep-copies so later mutation of the source can't leak", () => {
    const m = fresh();
    m.submitRoll("a", [1, 1, 1]);
    const snap = m.snapshot();
    const other = fresh();
    other.restore(snap);
    m.setAside("a", [1, 1, 1]);               // mutate source after snapshot
    assert.equal(other.phase, "select");      // restored copy is unaffected
    assert.deepEqual(other.lastRoll, [1, 1, 1]);
});
