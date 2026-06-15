/**
 * Farkle table economics — pure helpers for the betting lobby.
 *
 * Kept free of Foundry so it can be unit-tested headlessly. The app layer reads
 * actor data into plain numbers, calls these, and writes the results back.
 *
 *   aiSkill     — fold an actor's INT + EMP + Gambling into the 2..30 AI skill scale.
 *   canAfford   — does a purse cover the ante?
 *   pickDice    — choose which Die profiles a seat actually rolls with.
 *
 * A "die profile" is `{ weights, faces }` as consumed by board3d.setDieProfiles:
 * `weights` is a six-element relative-weight array (or null ⇒ fair) and `faces`
 * is a {pip: imageUrl} map (or null ⇒ default brass).
 */

const FAIR_PROFILE = Object.freeze({ weights: null, faces: null });

/**
 * Seat AI competence on the design's 2..30 scale: an actor's INT plus EMP plus
 * Gambling rank. A bare table (generic AI) passes nothing and the caller
 * defaults to 10. Floors at 2 so a statless/zeroed actor is merely terrible,
 * not broken.
 */
export function aiSkill(int = 0, emp = 0, gambling = 0) {
    const total = (Number(int) || 0) + (Number(emp) || 0) + (Number(gambling) || 0);
    return Math.max(2, total);
}

/** Can a purse balance cover the ante? */
export function canAfford(balance, ante) {
    return (Number(balance) || 0) >= (Number(ante) || 0);
}

/**
 * Choose the `count` dice a seat rolls with from the Die profiles in its
 * inventory. With fewer than `count` usable dice the hand is padded with fair
 * defaults; with more, `count` are picked at random (the surplus stays in the
 * bag). Always returns exactly `count` profiles.
 *
 * @param {Array<{weights?:number[], faces?:object}>} owned  resolved Die profiles
 * @param {number} count                                     dice in this game
 * @param {() => number} [rng]                                uniform [0,1)
 */
export function pickDice(owned = [], count = 6, rng = Math.random) {
    const pool = Array.isArray(owned) ? owned.slice() : [];
    let chosen;
    if (pool.length <= count) {
        chosen = pool;
    } else {
        // Fisher–Yates partial shuffle: pull `count` distinct dice.
        for (let i = 0; i < count; i++) {
            const j = i + Math.floor(rng() * (pool.length - i));
            [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        chosen = pool.slice(0, count);
    }
    const out = chosen.map(p => ({ weights: p?.weights ?? null, faces: p?.faces ?? null }));
    while (out.length < count) out.push({ ...FAIR_PROFILE });
    return out;
}
