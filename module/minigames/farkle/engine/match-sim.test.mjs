/**
 * End-to-end match simulation: drive a full N-seat game with AI for every seat,
 * injecting rolls from a seeded RNG. This exercises the same engine+AI loop the
 * live FarkleApp runs (submitRoll → setAside → bank/rollAgain), proving an
 * N-seat match always terminates with exactly one winner who took the pot. The
 * app's networking/animation layer can't be tested headlessly; this locks in
 * the deterministic backbone underneath it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { FarkleMatch } from "./state.mjs";
import { chooseSetAside, decideContinue } from "./ai.mjs";

/** Tiny deterministic RNG so every run is reproducible. */
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const rollN = (n, rng) => Array.from({ length: n }, () => 1 + Math.floor(rng() * 6));

/** Play one match to completion with `skill`-level AI on every seat. */
function playOut(seatIds, { target = 2000, ante = 50, seed = 1, skill = 10 } = {}) {
    const players = Object.fromEntries(seatIds.map(s => [s, { purse: 1000 }]));
    const m = new FarkleMatch({ seats: seatIds, players, target, ante });
    const rng = mulberry32(seed);
    let guard = 0;
    while (m.phase !== "done" && guard++ < 100000) {
        const seat = m.toAct;
        if (m.phase === "roll") {
            m.submitRoll(seat, rollN(m.diceInHand, rng));
        } else if (m.phase === "select") {
            m.setAside(seat, chooseSetAside(m.lastRoll, { skill, rng }));
        } else if (m.phase === "decide") {
            const cont = decideContinue({
                turnTotal: m.turnTotal, diceLeft: m.diceInHand,
                banked: m.banked[seat], target: m.target, skill, rng
            });
            if (cont) m.rollAgain(seat); else m.bank(seat);
        }
    }
    return m;
}

for (const seatIds of [["a", "b"], ["a", "b", "c"], ["a", "b", "c", "d"]]) {
    test(`${seatIds.length}-seat AI match terminates with one pot-taking winner`, () => {
        for (let seed = 1; seed <= 20; seed++) {
            const m = playOut(seatIds, { seed });
            assert.equal(m.phase, "done", `seed ${seed} did not finish`);
            const winner = m.result.winner;
            assert.ok(seatIds.includes(winner));
            assert.ok(m.banked[winner] >= m.target, `winner under target (seed ${seed})`);
            assert.equal(m.result.pot, ante(seatIds.length));
            // Winner is credited the pot on top of their post-ante purse.
            assert.equal(m.players[winner].purse, 1000 - 50 + ante(seatIds.length));
        }
    });
}

function ante(n) { return 50 * n; }
