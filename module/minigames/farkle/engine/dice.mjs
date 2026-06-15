/**
 * Weighted die draw — pure given an RNG.
 *
 * A Die item carries six relative landing weights (see DieData.faceWeights).
 * `drawFace` turns a weight profile into a face value 1–6; `rollDice` draws a
 * whole hand, one independent face per die (each die may have its own profile,
 * e.g. a mix of fair and loaded dice).
 *
 * These values are INJECTED into the match (`submitRoll`) and the 3D layer is
 * snapped to them, exactly like the lock-step PvP path — the physics never
 * decides the outcome, so a loaded die biases probability without faking the
 * simulation differently across clients.
 */

const FAIR = Object.freeze([1, 1, 1, 1, 1, 1]);

/** Coerce arbitrary input to six finite, non-negative weights. */
function normalize(weights) {
    const w = new Array(6);
    for (let i = 0; i < 6; i++) {
        const x = Number(weights?.[i]);
        w[i] = Number.isFinite(x) && x > 0 ? x : 0;
    }
    return w;
}

/**
 * Draw a single face value (1–6) from a weight profile.
 * @param {number[]} [weights]      six relative weights; missing/invalid → fair
 * @param {() => number} [rng]      uniform [0,1)
 * @returns {number} 1–6
 */
export function drawFace(weights = FAIR, rng = Math.random) {
    const w = normalize(weights);
    const total = w.reduce((a, b) => a + b, 0);
    if (total <= 0) return 1 + Math.floor(rng() * 6); // degenerate profile → uniform
    let r = rng() * total;
    for (let v = 0; v < 6; v++) {
        r -= w[v];
        if (r < 0) return v + 1;
    }
    return 6; // float slop guard
}

/**
 * Draw a hand of faces. `profiles` is one weight array per die to roll; a bare
 * count (or a single profile) rolls that many fair dice.
 * @param {number|number[]|number[][]} profiles
 * @param {() => number} [rng]
 * @returns {number[]}
 */
export function rollDice(profiles, rng = Math.random) {
    if (typeof profiles === "number") {
        return Array.from({ length: profiles }, () => drawFace(FAIR, rng));
    }
    const isPerDie = Array.isArray(profiles) && Array.isArray(profiles[0]);
    if (isPerDie) return profiles.map(w => drawFace(w, rng));
    // A single shared profile — caller must pass a count via the number form to
    // size the hand; here we just draw one die from the given profile.
    return [drawFace(profiles, rng)];
}
