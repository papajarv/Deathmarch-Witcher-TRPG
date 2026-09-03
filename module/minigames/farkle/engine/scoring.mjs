/**
 * Pure Farkle scoring core — no Foundry deps, fully deterministic.
 *
 * Reference scoring set:
 *   Single 1 = 100, single 5 = 50.
 *   Three of a kind: 1s = 1000, else face×100. Four = ×2, five = ×3, six = ×4 of the triple.
 *   Straight (1-6) = 1500. Three pairs = 1500. Four-of-a-kind + a pair = 1500. Two triplets = 2500.
 * Faces 2/3/4/6 only score in groups of ≥3; faces 1/5 also score singly.
 */

function toCounts(values) {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const v of values) counts[v]++;
  return counts;
}

/** Points for c (≥3) dice of face v. */
function nokValue(v, c) {
  const base3 = v === 1 ? 1000 : v * 100;
  const mult = c === 3 ? 1 : c === 4 ? 2 : c === 5 ? 3 : 4; // c capped at 6
  return base3 * mult;
}

/** Best points from the standard (singles + n-of-a-kind) interpretation, scoring every scorable die. */
function scoreGreedyGeneral(counts) {
  let points = 0;
  for (let v = 1; v <= 6; v++) {
    const c = counts[v];
    if (c === 0) continue;
    if (c >= 3) points += nokValue(v, c);
    else if (v === 1) points += c * 100;
    else if (v === 5) points += c * 50;
  }
  return points;
}

/** Standard interpretation, but only valid if EVERY die is consumed by a combo. */
function scoreStrictGeneral(counts) {
  let points = 0;
  let consumed = 0;
  let total = 0;
  for (let v = 1; v <= 6; v++) {
    const c = counts[v];
    total += c;
    if (c === 0) continue;
    if (c >= 3) { points += nokValue(v, c); consumed += c; }
    else if (v === 1) { points += c * 100; consumed += c; }
    else if (v === 5) { points += c * 50; consumed += c; }
  }
  return { points, valid: consumed === total };
}

/** Special 6-die combos. Returns best matching value, or null. */
function scoreSpecial(counts, n) {
  if (n !== 6) return null;
  const candidates = [];
  // Straight 1-6.
  if ([1, 2, 3, 4, 5, 6].every(v => counts[v] === 1)) candidates.push(1500);
  // Three pairs.
  if ([1, 2, 3, 4, 5, 6].filter(v => counts[v] === 2).length === 3) candidates.push(1500);
  // Four of a kind + a pair. The combo is worth 1500, but it must never score
  // LESS than the four-of-a-kind on its own — otherwise keeping the (otherwise
  // worthless) pair would drop your score (e.g. four 1s = 2000, yet four 1s +
  // a pair of 4s would read 1500). The pair is consumed for free to make the
  // all-six set-aside legal; take the better of the two readings.
  const fourFace = [1, 2, 3, 4, 5, 6].find(v => counts[v] === 4);
  const pair = [1, 2, 3, 4, 5, 6].some(v => counts[v] === 2);
  if (fourFace && pair) candidates.push(Math.max(1500, nokValue(fourFace, 4)));
  // Two triplets.
  if ([1, 2, 3, 4, 5, 6].filter(v => counts[v] === 3).length === 2) candidates.push(2500);
  return candidates.length ? Math.max(...candidates) : null;
}

/**
 * Score a player's chosen set-aside.
 * @returns {{valid:boolean, points:number}} valid=false if any selected die isn't consumed by a combo.
 */
export function scoreSelection(values) {
  if (!values || values.length === 0) return { valid: false, points: 0 };
  const counts = toCounts(values);
  const candidates = [];
  const gen = scoreStrictGeneral(counts);
  if (gen.valid) candidates.push(gen.points);
  const spec = scoreSpecial(counts, values.length);
  if (spec !== null) candidates.push(spec);
  if (!candidates.length) return { valid: false, points: 0 };
  return { valid: true, points: Math.max(...candidates) };
}

/** Maximum points obtainable from the best scoring subset of a roll. */
export function bestScoreFull(values) {
  if (!values || values.length === 0) return 0;
  const counts = toCounts(values);
  let best = scoreGreedyGeneral(counts);
  const spec = scoreSpecial(counts, values.length);
  if (spec !== null) best = Math.max(best, spec);
  return best;
}

/** True if a roll contains at least one scoring die (i.e. it is NOT a farkle). */
export function hasAnyScore(values) {
  return bestScoreFull(values) > 0;
}

export const _internal = { nokValue, scoreSpecial, scoreGreedyGeneral, scoreStrictGeneral, toCounts };
