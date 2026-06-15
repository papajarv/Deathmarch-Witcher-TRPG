/**
 * NPC Farkle AI — pure given its inputs (and an injectable RNG for fallible play).
 *
 * Two decisions: which scoring dice to set aside (`chooseSetAside`), and whether
 * to press on or bank (`decideContinue`). The continue decision is an
 * expected-value rule: roll again only while the turn total stays below a
 * per-dice-count threshold derived from farkle odds.
 *
 * Both decisions are scaled by a `skill` value = an actor's INT + EMP + Gambling
 * (2 to 30). ~16 is average, 2 is disgustingly bad, 30 is perfect. Skill maps
 * to a competence p in [0,1]; with probability p the AI plays optimally, and
 * the shortfall (1-p) drives blunders: leaving guaranteed points on the table
 * and jittering the press/bank threshold. The default skill is "perfect" so
 * callers that omit it (and the unit tests) get deterministic optimal play; the
 * lobby passes the real skill, defaulting a generic AI to 10.
 */

import { bestScoreFull, _internal } from "./scoring.mjs";
const { toCounts, scoreSpecial, scoreGreedyGeneral } = _internal;

const PERFECT_SKILL = 30;

/** Skill (2..30) → competence in [0,1]. 2→0 (awful), 16→~0.5, 30→1. */
export function competence(skill) {
    return Math.max(0, Math.min(1, (skill - 2) / 28));
}

/** The optimal set-aside: whole n-of-a-kind groups plus every loose 1/5. */
function optimalSetAside(roll) {
    const counts = toCounts(roll);

    // A full six-die special combo (straight, three pairs, two triplets,
    // four+pair) is only scorable by keeping all six — and triggers hot dice.
    if (roll.length === 6) {
        const spec = scoreSpecial(counts, 6);
        if (spec !== null && spec >= scoreGreedyGeneral(counts)) return [...roll];
    }

    const keep = [];
    for (let v = 1; v <= 6; v++) {
        if (counts[v] >= 3) for (let k = 0; k < counts[v]; k++) keep.push(v);
    }
    const singleOnes = counts[1] >= 3 ? 0 : counts[1];
    for (let k = 0; k < singleOnes; k++) keep.push(1);
    const singleFives = counts[5] >= 3 ? 0 : counts[5];
    for (let k = 0; k < singleFives; k++) keep.push(5);

    return keep;
}

/**
 * A fallible set-aside: keep the n-of-a-kind blocks (splitting them would
 * forfeit the score outright), but flip a coin on each loose 1/5 — a bad
 * gambler leaves guaranteed points on the table to reroll. Always keeps at
 * least one scoring die so the selection stays valid.
 */
function blunderSetAside(keep, rng) {
    const counts = toCounts(keep);
    const blocks = [];      // n-of-a-kind (≥3): all-or-nothing, always kept whole
    const loose = [];       // standalone scorers (loose 1s/5s): droppable
    for (let v = 1; v <= 6; v++) {
        if (counts[v] >= 3) for (let k = 0; k < counts[v]; k++) blocks.push(v);
        else if (v === 1 || v === 5) for (let k = 0; k < counts[v]; k++) loose.push(v);
    }
    // No standalone scorers and no blocks ⇒ the only score is an indivisible
    // special (straight, three pairs, …); there's no legal worse play.
    if (blocks.length === 0 && loose.length === 0) return keep;
    const kept = [...blocks];
    for (const d of loose) if (rng() >= 0.5) kept.push(d);
    if (kept.length === 0) kept.push(loose[0]);
    return kept;
}

/**
 * Pick the dice to set aside from a roll.
 * @param {number[]} roll  faces that landed (already known to contain a score)
 * @param {object} [opts]
 * @param {number} [opts.skill=30]   INT + EMP + Gambling (2..30); 30 = optimal
 * @param {() => number} [opts.rng]  uniform [0,1); only consulted when skill < perfect
 * @returns {number[]} the subset of faces to keep (a valid scoring selection)
 */
export function chooseSetAside(roll, { skill = PERFECT_SKILL, rng = Math.random } = {}) {
    const keep = optimalSetAside(roll);
    const p = competence(skill);
    if (p >= 1 || rng() < p) return keep;
    return blunderSetAside(keep, rng);
}

// Roll-again EV thresholds keyed by dice remaining: roll while turnTotal < threshold.
// Derived from avgGain·(1-pFarkle)/pFarkle for typical farkle odds per dice count.
const ROLL_THRESHOLD = { 1: 37, 2: 163, 3: 519, 4: 1342, 5: 4195, 6: 25500 };

/**
 * Decide whether to keep rolling or bank.
 * @param {object} ctx
 * @param {number} ctx.turnTotal   unbanked points this turn
 * @param {number} ctx.diceLeft    dice that would be rolled next
 * @param {number} ctx.banked      AI's banked score
 * @param {number} [ctx.oppBanked] best opponent banked score
 * @param {number} ctx.target      points needed to win
 * @param {number} [ctx.skill=30]  INT + EMP + Gambling (2..30); 30 = optimal
 * @param {() => number} [ctx.rng] uniform [0,1); only consulted when skill < perfect
 * @returns {boolean} true = roll again, false = bank
 */
export function decideContinue({ turnTotal, diceLeft, banked, oppBanked = 0, target, skill = PERFECT_SKILL, rng = Math.random }) {
    if (banked + turnTotal >= target) return false; // banking wins — take it
    let threshold = ROLL_THRESHOLD[diceLeft] ?? 0;
    if (oppBanked >= target * 0.75) threshold *= 1.4; // press when an opponent is close
    const p = competence(skill);
    if (p < 1) {
        // Misjudge the gamble: swing the threshold up (reckless) or down (timid)
        // by up to ±80%, scaled by how far short of perfect the AI is.
        threshold *= 1 + (rng() * 2 - 1) * (1 - p) * 0.8;
    }
    return turnTotal < threshold;
}

export { bestScoreFull };
