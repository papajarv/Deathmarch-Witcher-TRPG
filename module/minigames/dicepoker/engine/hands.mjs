/**
 * Witcher dice poker — hand evaluation and comparison.
 *
 * Five six-sided dice. After the initial throw a player keeps any subset and
 * re-rolls the rest ONCE; the resulting five dice form a poker hand. Ranking,
 * highest → lowest (The Witcher / Witcher 2 in-game order):
 *
 *   8  Five of a kind        (e.g. 4 4 4 4 4)
 *   7  Four of a kind        (e.g. 3 3 3 3 6)
 *   6  Full house            (a triple + a pair)
 *   5  Six-high straight     (2 3 4 5 6)
 *   4  Five-high straight    (1 2 3 4 5)
 *   3  Three of a kind
 *   2  Two pairs
 *   1  One pair
 *   0  Nothing               (no combination — high die)
 *
 * Ties: equal category compares ordered tiebreak keys (the combination's own
 * faces first, then kickers high→low). An exact key match is a true draw.
 *
 * Pure module — no Foundry / no RNG. The match injects the five values; this
 * only classifies and orders them, so every client ranks identically.
 */

export const HAND_RANK = Object.freeze({
    nothing: 0, pair: 1, twoPair: 2, threeKind: 3,
    straightLow: 4, straightHigh: 5, fullHouse: 6, fourKind: 7, fiveKind: 8
});

/** i18n stem (WITCHER.DicePoker.hand.<key>) per numeric rank. */
const RANK_KEY = Object.freeze([
    "nothing", "pair", "twoPair", "threeKind",
    "straightLow", "straightHigh", "fullHouse", "fourKind", "fiveKind"
]);

/** rank → i18n key stem. */
export function handKey(rank) {
    return RANK_KEY[rank] ?? "nothing";
}

/** Face counts for a 1–6 hand: index 1..6 holds how many dice show that face. */
function faceCounts(values) {
    const c = [0, 0, 0, 0, 0, 0, 0];
    for (const v of values) if (v >= 1 && v <= 6) c[v]++;
    return c;
}

/**
 * Classify a five-die hand.
 * @param {number[]} values  five face values (1–6)
 * @returns {{ rank:number, key:number[] }}  rank = HAND_RANK.*; key = tiebreak
 *   values compared lexicographically (higher wins) AFTER rank.
 */
export function evaluateHand(values) {
    const c = faceCounts(values);
    // Faces present, ordered by count desc then face desc — so byCount[0] is the
    // biggest group (highest face breaks a count tie), giving the combo faces and
    // kickers in comparison order.
    const byCount = [];
    for (let f = 1; f <= 6; f++) if (c[f]) byCount.push({ face: f, count: c[f] });
    byCount.sort((a, b) => (b.count - a.count) || (b.face - a.face));

    const distinct = byCount.length;
    const top = byCount[0];
    const second = byCount[1];
    // Straights need five distinct faces; the set is either {1..5} or {2..6}.
    const isSixHigh = distinct === 5 && c[1] === 0;   // 2 3 4 5 6
    const isFiveHigh = distinct === 5 && c[6] === 0;  // 1 2 3 4 5

    // NOTE: also called on PARTIAL hands (<5 dice) to preview a player's kept
    // subset mid-select, so every group lookup past byCount[0] must tolerate a
    // missing entry — a four-of-a-kind among only four kept dice has no kicker.
    if (!top) return { rank: HAND_RANK.nothing, key: [] };
    if (top.count === 5) return { rank: HAND_RANK.fiveKind, key: [top.face] };
    if (top.count === 4) return { rank: HAND_RANK.fourKind, key: [top.face, second?.face ?? 0] };
    if (top.count === 3 && second?.count === 2) return { rank: HAND_RANK.fullHouse, key: [top.face, second.face] };
    if (isSixHigh) return { rank: HAND_RANK.straightHigh, key: [6] };
    if (isFiveHigh) return { rank: HAND_RANK.straightLow, key: [5] };
    if (top.count === 3) {
        const kick = byCount.slice(1).map(x => x.face).sort((a, b) => b - a);
        return { rank: HAND_RANK.threeKind, key: [top.face, ...kick] };
    }
    if (top.count === 2 && second?.count === 2) {
        const pairs = [top.face, second.face].sort((a, b) => b - a);
        const kicker = byCount[2]?.face ?? 0;
        return { rank: HAND_RANK.twoPair, key: [...pairs, kicker] };
    }
    if (top.count === 2) {
        const kick = byCount.slice(1).map(x => x.face).sort((a, b) => b - a);
        return { rank: HAND_RANK.pair, key: [top.face, ...kick] };
    }
    return { rank: HAND_RANK.nothing, key: [...values].sort((a, b) => b - a) };
}

/**
 * Compare two evaluated hands. Positive → `a` is the stronger hand, negative →
 * `b`, exactly 0 → a true tie (same category and tiebreak keys).
 */
export function compareEval(a, b) {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const n = Math.max(a.key.length, b.key.length);
    for (let i = 0; i < n; i++) {
        const x = a.key[i] ?? 0, y = b.key[i] ?? 0;
        if (x !== y) return x - y;
    }
    return 0;
}

/** Convenience: compare two raw value arrays. */
export function compareHands(av, bv) {
    return compareEval(evaluateHand(av), evaluateHand(bv));
}
