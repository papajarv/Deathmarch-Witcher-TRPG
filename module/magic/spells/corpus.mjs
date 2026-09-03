/**
 * The authored corpus — every core-rulebook spell, invocation and sign.
 *
 * Rituals and hexes are deliberately absent: they are narrative procedures
 * with components and hours-long casting times, and automating them would mean
 * automating a scene rather than a roll.
 *
 * One authoring per spell. Nothing here re-exports or extends anything else in
 * this directory, so two copies of one entry cannot drift apart.
 */

import { NOVICE_MIXED } from "./novice-mixed.mjs";
import { EARTH }        from "./earth.mjs";
import { AIR }          from "./air.mjs";
import { FIRE }         from "./fire.mjs";
import { WATER }        from "./water.mjs";
import { SIGNS }        from "./signs.mjs";
import { INVOCATIONS }  from "./invocations.mjs";

export const CORPUS = [
    ...NOVICE_MIXED, ...EARTH, ...AIR, ...FIRE, ...WATER, ...SIGNS, ...INVOCATIONS
];

export { NOVICE_MIXED, EARTH, AIR, FIRE, WATER, SIGNS, INVOCATIONS };

/** Look one up by its printed name. */
export function spellNamed(name) {
    return CORPUS.find(s => s.name === name) ?? null;
}
