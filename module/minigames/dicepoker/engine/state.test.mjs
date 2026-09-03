import { test } from "node:test";
import assert from "node:assert/strict";
import { DicePokerMatch } from "./state.mjs";

const P2 = () => ({ a: { purse: 500 }, b: { purse: 500 } });
const P3 = () => ({ a: { purse: 500 }, b: { purse: 500 }, c: { purse: 500 } });

function freshHand(m, aVals, bVals) {
    m.submitRoll("a", aVals);
    m.submitRoll("b", bVals);
}

test("heads-up defaults: betting on, best-of-three, ante in pot", () => {
    const m = new DicePokerMatch({ players: P2(), seats: ["a", "b"], ante: 10 });
    assert.equal(m.betting, true);
    assert.equal(m.target, 2);
    assert.equal(m.raiseStep, 10);
    assert.equal(m.pot, 20);
    assert.deepEqual(m.scores, { a: 0, b: 0 });
    assert.equal(m.players.a.purse, 490);
});

test("3+ seats get a betting round, single hand (target 1)", () => {
    const m = new DicePokerMatch({ players: { a: {}, b: {}, c: {} }, seats: ["a", "b", "c"], ante: 10 });
    assert.equal(m.betting, true);
    assert.equal(m.target, 1);
    m.submitRoll("a", [1, 1, 1, 1, 1]);
    m.submitRoll("b", [2, 2, 2, 3, 4]);
    m.submitRoll("c", [6, 6, 5, 4, 3]);
    // Betting opens once everyone has thrown.
    assert.equal(m.phase, "bet");
    assert.equal(m.toAct, "a");
    assert.equal(m.pot, 30);
});

test("3-way betting: action goes around; all check closes the round", () => {
    const m = new DicePokerMatch({ players: { a: {}, b: {}, c: {} }, seats: ["a", "b", "c"], ante: 10 });
    m.submitRoll("a", [1, 1, 1, 1, 1]);
    m.submitRoll("b", [2, 2, 2, 3, 4]);
    m.submitRoll("c", [6, 6, 5, 4, 3]);
    m.check("a"); assert.equal(m.toAct, "b");
    m.check("b"); assert.equal(m.toAct, "c");
    m.check("c");
    assert.equal(m.phase, "select");   // round closed, into rerolls
    assert.equal(m.toAct, "a");
});

test("3-way betting: a fold drops a seat; raise reopens action to all live", () => {
    const m = new DicePokerMatch({ players: P3(), seats: ["a", "b", "c"], ante: 10 });
    m.submitRoll("a", [1, 1, 1, 1, 1]);
    m.submitRoll("b", [2, 2, 2, 3, 4]);
    m.submitRoll("c", [6, 6, 5, 4, 3]);
    m.raise("a");                       // a bets, b & c owe
    assert.equal(m.toAct, "b");
    m.fold("b");                        // b out this hand
    assert.equal(m.toAct, "c");
    m.call("c");                        // c matches; back to a, who is paid
    assert.equal(m.phase, "select");    // round closes
    assert.equal(m.pot, 10 + 20 + 20);  // b's ante 10 stays, a 20, c 20
    // b sits out the reroll round entirely.
    assert.equal(m.toAct, "a");
});

test("3-way hand plays through to a showdown, best hand takes the pot", () => {
    const m = new DicePokerMatch({ players: P3(), seats: ["a", "b", "c"], ante: 10 });
    m.submitRoll("a", [5, 5, 5, 1, 2]);   // trips
    m.submitRoll("b", [2, 2, 3, 4, 6]);   // pair
    m.submitRoll("c", [6, 6, 5, 4, 3]);   // pair
    m.check("a"); m.check("b"); m.check("c");
    assert.equal(m.phase, "select");
    // round 2: everyone stands on what they have
    m.stand("a"); m.stand("b"); m.stand("c");
    assert.equal(m.phase, "done");
    assert.deepEqual(m.result.winners, ["a"]);
    assert.equal(m.players.a.purse, 490 + 30); // anted 10, took the 30 pot
});

test("opening rolls lead into the bet phase (heads-up)", () => {
    const m = new DicePokerMatch({ players: P2(), seats: ["a", "b"], ante: 10 });
    freshHand(m, [1, 2, 3, 4, 5], [6, 6, 1, 2, 3]);
    assert.equal(m.phase, "bet");
    assert.equal(m.toAct, "a");
    assert.equal(m.owed("a"), 0);
    assert.deepEqual(m.roll, [1, 2, 3, 4, 5]); // active seat's dice shown
});

test("check / check closes betting into the reroll round", () => {
    const m = new DicePokerMatch({ players: P2(), seats: ["a", "b"], ante: 10 });
    freshHand(m, [1, 2, 3, 4, 5], [6, 6, 1, 2, 3]);
    m.check("a");
    assert.equal(m.toAct, "b");
    assert.equal(m.phase, "bet");
    m.check("b");
    assert.equal(m.phase, "select");
    assert.equal(m.toAct, "a");
    assert.equal(m.pot, 20); // unchanged
});

test("raise then call: pot grows, both paid, betting closes", () => {
    const m = new DicePokerMatch({ players: P2(), seats: ["a", "b"], ante: 10 });
    freshHand(m, [1, 2, 3, 4, 5], [6, 6, 1, 2, 3]);
    m.raise("a");
    assert.equal(m.currentBet, 20);
    assert.equal(m.committed.a, 20);
    assert.equal(m.players.a.purse, 480);
    assert.equal(m.toAct, "b");
    assert.equal(m.owed("b"), 10);
    m.call("b");
    assert.equal(m.players.b.purse, 480);
    assert.equal(m.pot, 40);
    assert.equal(m.phase, "select"); // closed
});

test("raise / re-raise / call", () => {
    const m = new DicePokerMatch({ players: P2(), seats: ["a", "b"], ante: 10 });
    freshHand(m, [1, 2, 3, 4, 5], [6, 6, 1, 2, 3]);
    m.raise("a"); // bet 20
    m.raise("b"); // owed 10 + step 10 -> committed 30
    assert.equal(m.currentBet, 30);
    assert.equal(m.committed.b, 30);
    assert.equal(m.toAct, "a");
    assert.equal(m.owed("a"), 10);
    m.call("a");
    assert.equal(m.pot, 60);
    assert.equal(m.phase, "select");
});

test("raise cap is enforced with 3+ seats; heads-up is uncapped", () => {
    const m = new DicePokerMatch({ players: P3(), seats: ["a", "b", "c"], ante: 10, maxRaises: 2 });
    m.submitRoll("a", [1, 2, 3, 4, 5]);
    m.submitRoll("b", [6, 6, 1, 2, 3]);
    m.submitRoll("c", [1, 1, 2, 3, 4]);
    m.raise("a"); m.raise("b");       // two raises -> cap (maxRaises 2) reached
    assert.equal(m.raises, 2);
    assert.equal(m.canRaise("c"), false);
    assert.throws(() => m.raise("c"), /cannot raise/);

    // Heads-up: the cap is lifted (standard limit-poker rule).
    const h = new DicePokerMatch({ players: P2(), seats: ["a", "b"], ante: 10, maxRaises: 2 });
    freshHand(h, [1, 2, 3, 4, 5], [6, 6, 1, 2, 3]);
    h.raise("a"); h.raise("b"); h.raise("a");   // 3 raises > maxRaises, still legal
    assert.equal(h.canRaise("b"), true);
});

test("surrender hands the pot to the opponent and scores the hand", () => {
    const m = new DicePokerMatch({ players: P2(), seats: ["a", "b"], ante: 10 });
    freshHand(m, [1, 2, 3, 4, 5], [6, 6, 1, 2, 3]);
    m.raise("a"); // pot 30, a committed 20 (purse 480)
    m.fold("b");
    assert.equal(m.scores.a, 1);
    assert.equal(m.handResult.folded, true);
    assert.equal(m.handResult.winner, "a");
    // Best-of-three: not over yet, next hand auto-dealt (fresh ante deducted).
    assert.equal(m.phase, "roll");
    assert.equal(m.handNo, 2);
    assert.equal(m.players.a.purse, 480 + 30 - 10); // won pot 30, paid next ante
    assert.equal(m.players.b.purse, 490 - 10);      // only paid next ante
});

test("best-of-three: two hand wins ends the match", () => {
    const m = new DicePokerMatch({ players: P2(), seats: ["a", "b"], ante: 10 });
    const winHandForA = () => {
        freshHand(m, [5, 5, 5, 5, 5], [1, 2, 3, 4, 6]);
        m.check("a"); m.check("b");
        // round 2: both stand
        m.stand("a"); m.stand("b");
    };
    winHandForA();
    assert.equal(m.scores.a, 1);
    assert.equal(m.phase, "roll"); // next hand
    winHandForA();
    assert.equal(m.scores.a, 2);
    assert.equal(m.phase, "done");
    assert.deepEqual(m.result.winners, ["a"]);
    assert.deepEqual(m.result.scores, { a: 2, b: 0 });
});

test("custom target: best-of-five needs three hand-wins", () => {
    const m = new DicePokerMatch({ players: P2(), seats: ["a", "b"], ante: 10, target: 3 });
    assert.equal(m.target, 3);
    const winHandForA = () => {
        freshHand(m, [5, 5, 5, 5, 5], [1, 2, 3, 4, 6]);
        m.check("a"); m.check("b");
        m.stand("a"); m.stand("b");
    };
    winHandForA(); winHandForA();
    assert.equal(m.scores.a, 2);
    assert.equal(m.phase, "roll");      // not over at two — best-of-five
    winHandForA();
    assert.equal(m.phase, "done");
    assert.deepEqual(m.result.scores, { a: 3, b: 0 });
});

test("continuous: score target never ends it; broke does", () => {
    const m = new DicePokerMatch({
        players: { a: { purse: 1000 }, b: { purse: 45 } },
        seats: ["a", "b"], ante: 10, continuous: true
    });
    assert.equal(m.continuous, true);
    const winHandForA = () => {
        freshHand(m, [5, 5, 5, 5, 5], [1, 2, 3, 4, 6]);
        m.check("a"); m.check("b");
        m.stand("a"); m.stand("b");
    };
    winHandForA(); winHandForA();
    assert.equal(m.scores.a, 2);        // would end a best-of-three…
    assert.equal(m.phase, "roll");      // …but continuous keeps dealing
    // snapshot/restore preserves the continuous flag mid-run
    const m2 = new DicePokerMatch({ players: P2(), seats: ["a", "b"], ante: 10 }).restore(m.snapshot());
    assert.equal(m2.continuous, true);
    winHandForA(); winHandForA();        // b can no longer cover the ante
    assert.equal(m.phase, "done");
    assert.deepEqual(m.result.winners, ["a"]);
});

test("tie replays the hand: pot carries, ledger resets, no score change", () => {
    const m = new DicePokerMatch({ players: P2(), seats: ["a", "b"], ante: 10 });
    freshHand(m, [1, 2, 3, 4, 6], [1, 2, 3, 4, 6]);
    m.raise("a"); m.call("b");      // pot 40
    m.stand("a"); m.stand("b");     // identical hands -> tie
    assert.equal(m.phase, "roll");
    assert.equal(m.pot, 40);        // carried
    assert.equal(m.replays, 1);
    assert.deepEqual(m.scores, { a: 0, b: 0 });
    assert.equal(m.committed.a, 0); // ledger reset
    assert.equal(m.currentBet, 0);
    assert.equal(m.owed("a"), 0);   // both can check fresh
});

test("snapshot / restore round-trips betting + score state", () => {
    const m = new DicePokerMatch({ players: P2(), seats: ["a", "b"], ante: 10 });
    freshHand(m, [1, 2, 3, 4, 5], [6, 6, 1, 2, 3]);
    m.raise("a");
    const snap = m.snapshot();
    const m2 = new DicePokerMatch({ players: P2(), seats: ["a", "b"], ante: 10 }).restore(snap);
    assert.equal(m2.phase, "bet");
    assert.equal(m2.currentBet, 20);
    assert.equal(m2.committed.a, 20);
    assert.equal(m2.toAct, "b");
    assert.deepEqual(m2.scores, m.scores);
    assert.equal(m2.handNo, m.handNo);
    // and it can continue identically
    m2.call("b");
    assert.equal(m2.phase, "select");
});

test("cannot check when facing a bet", () => {
    const m = new DicePokerMatch({ players: P2(), seats: ["a", "b"], ante: 10 });
    freshHand(m, [1, 2, 3, 4, 5], [6, 6, 1, 2, 3]);
    m.raise("a");
    assert.throws(() => m.check("b"), /cannot check/);
});

test("forfeit during a heads-up match is a walkover", () => {
    const m = new DicePokerMatch({ players: P2(), seats: ["a", "b"], ante: 10 });
    freshHand(m, [1, 2, 3, 4, 5], [6, 6, 1, 2, 3]);
    m.forfeit("b");
    assert.equal(m.phase, "done");
    assert.deepEqual(m.result.winners, ["a"]);
});

// Drive one hand to showdown: everyone throws, all check, all stand.
function playHandAllCheckStand(m, rolls) {
    for (const s of [...m.seats]) m.submitRoll(s, rolls[s]);
    while (m.phase === "bet") m.check(m.toAct);
    while (m.phase === "select") m.stand(m.toAct);
}

test("fixed-length session: play exactly handLimit hands, richest wins", () => {
    const m = new DicePokerMatch({
        players: P3(), seats: ["a", "b", "c"], ante: 10, handLimit: 2
    });
    assert.equal(m.handLimit, 2);
    // Hand 1 — a holds five-of-a-kind, takes the pot.
    playHandAllCheckStand(m, { a: [6, 6, 6, 6, 6], b: [1, 1, 2, 3, 4], c: [2, 2, 3, 4, 5] });
    assert.equal(m.phase, "roll");      // not done yet — one hand left
    assert.equal(m.handNo, 2);
    // Hand 2 — a wins again; the session ends after the scheduled hands.
    playHandAllCheckStand(m, { a: [5, 5, 5, 5, 5], b: [1, 1, 2, 3, 4], c: [2, 2, 3, 4, 5] });
    assert.equal(m.phase, "done");
    assert.deepEqual(m.result.winners, ["a"]);   // richest purse after 2 hands
    assert.equal(m.scores.a, 2);
});

test("fixed-length session: handLimit overrides any score target", () => {
    const m = new DicePokerMatch({
        players: P2(), seats: ["a", "b"], ante: 10, handLimit: 1
    });
    // One hand only, even though heads-up would otherwise be best-of-three.
    playHandAllCheckStand(m, { a: [6, 6, 6, 6, 6], b: [1, 1, 2, 3, 4] });
    assert.equal(m.phase, "done");
    assert.deepEqual(m.result.winners, ["a"]);
});

test("handLimit survives a snapshot/restore round-trip", () => {
    const m = new DicePokerMatch({
        players: P3(), seats: ["a", "b", "c"], ante: 10, handLimit: 5
    });
    const m2 = new DicePokerMatch().restore(m.snapshot());
    assert.equal(m2.handLimit, 5);
});
