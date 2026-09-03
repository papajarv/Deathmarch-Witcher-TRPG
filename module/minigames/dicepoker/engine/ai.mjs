/**
 * NPC dice-poker AI — pure given its inputs (and an injectable RNG for blunders).
 *
 * One decision per turn: which dice to keep before the single reroll
 * (`chooseKeep`). Keeping all five is a "stand". The optimal keep is found by
 * brute force: for every subset of the roll, average the resulting hand strength
 * over all reroll completions and take the best — exact, and cheap (≤ 7^5
 * hand evaluations total).
 *
 * Skill (an actor's INT + EMP + Gambling, 2..30) maps to competence in [0,1] via the
 * same curve as the Farkle AI. With probability p the AI keeps optimally; the
 * shortfall drives blunders (a random, legal-but-worse keep). Default skill is
 * "perfect" so tests and callers that omit it get deterministic optimal play.
 */

import { evaluateHand } from "./hands.mjs";
import { competence } from "../../farkle/engine/ai.mjs";

const PERFECT_SKILL = 30;

/** Monotone scalar for a hand: rank dominates, tiebreak key refines fractionally. */
function strength(values) {
    const { rank, key } = evaluateHand(values);
    let frac = 0, scale = 1 / 7;
    for (const k of key) { frac += (k / 7) * scale; scale /= 7; }
    return rank + frac;
}

/** Expected strength of keeping `kept` and re-throwing `m` fair dice. */
function expectedStrength(kept, m) {
    if (m === 0) return strength(kept);
    const total = 6 ** m;
    const extra = new Array(m);
    let sum = 0;
    for (let n = 0; n < total; n++) {
        let x = n;
        for (let i = 0; i < m; i++) { extra[i] = (x % 6) + 1; x = (x / 6) | 0; }
        sum += strength([...kept, ...extra]);
    }
    return sum / total;
}

/** Every subset of `roll` (as value arrays), smallest reroll first won't matter — we scan all. */
function subsets(roll) {
    const out = [];
    const n = roll.length;
    for (let mask = 0; mask < (1 << n); mask++) {
        const keep = [];
        for (let i = 0; i < n; i++) if (mask & (1 << i)) keep.push(roll[i]);
        out.push(keep);
    }
    return out;
}

/**
 * Pick which dice to keep before the reroll.
 * @param {number[]} roll  the faces currently showing
 * @param {object} [opts]
 * @param {number} [opts.skill=30]   INT + EMP + Gambling (2..30); 30 = optimal
 * @param {() => number} [opts.rng]  uniform [0,1); consulted only when skill < perfect
 * @returns {number[]} the subset of faces to keep (keeping all = stand)
 */
export function chooseKeep(roll, { skill = PERFECT_SKILL, rng = Math.random } = {}) {
    const options = subsets(roll).map(keep => ({
        keep,
        ev: expectedStrength(keep, roll.length - keep.length)
    }));
    // Best EV; on ties prefer keeping MORE dice (lower variance, plays it safe).
    options.sort((a, b) => (b.ev - a.ev) || (b.keep.length - a.keep.length));

    const p = competence(skill);
    if (p >= 1 || rng() < p) return options[0].keep;

    // Blunder: pick a SUB-optimal keep — but a weak player makes a near-miss,
    // not a deranged one (a uniform pick over all subsets would happily break a
    // made pair to reroll it). Bias the choice toward the top of the EV-sorted
    // list; the more competent a slipping player is, the closer to optimal the
    // slip. `skew` (1 → uniform at skill 2, larger → hugs the front) pushes the
    // sample toward index 0, so catastrophic keeps stay rare except for true
    // dumbasses. Fall back to optimal if it's the only option (a one-die roll).
    if (options.length <= 1) return options[0].keep;
    const skew = 1 + 3 * p;
    const idx = 1 + Math.floor(Math.pow(rng(), skew) * (options.length - 1));
    return options[idx].keep;
}

export { strength };
