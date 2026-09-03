/**
 * Every `stat:` a spell modifies must be a field an actor actually has.
 *
 * `grantModifier` writes an ActiveEffect change at a computed path. A path the
 * sheet does not have is not an error in Foundry — the effect applies to
 * nothing, silently. That is how Axii's whole mechanic ("stunSave") and Freya's
 * Bravery ("health") and Primal Reservoir ("meleeDamage") did nothing at all.
 *
 * The names below are the actor schema's, confirmed against a live world.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { CORPUS } from "./spells/corpus.mjs";

const STATS = ["int","ref","dex","body","spd","emp","cra","will","luck"];
const DERIVED = ["hp","sta","vigor","stun","rec","enc","damageBonus","meleeBonus",
                 "resolve","woundThreshold","focus","shield","encPenalty","aimMod"];
const SKILLS = [
    "alchemy","archery","athletics","awareness","brawling","business","charisma","commonspeech",
    "cooking","courage","crafting","deduction","disguise","dodge","dwarven","education","eldersp",
    "endurance","firstaid","forgery","gambling","grooming","hexweave","human","intimidation",
    "leadership","melee","nilfgaardian","persuasion","physique","picklock","resistcoerc",
    "resistmagic","riding","ritcraft","sailing","seduction","smallblades","socialetiq","spellcast",
    "staffspear","stealth","streetwise","survival","swordsmanship","tailoring","trapcraft",
    "wildernesssurvival","wilderness","socialetiquette","businesss"
];
const KNOWN = new Set([...STATS, ...DERIVED, ...SKILLS]);

function walk(body, fn) {
    for (const node of body ?? []) { fn(node); if (node.body) walk(node.body, fn); }
}

test("every stat a spell modifies is a real field", () => {
    const bad = [];
    for (const spell of CORPUS) {
        for (const [entry, body] of Object.entries(spell.on ?? {})) {
            walk(body, (node) => {
                const stat = node?.a?.stat;
                if (stat && !String(stat).startsWith("{") && !KNOWN.has(stat)) {
                    bad.push(`${spell.name}.${entry}: modifies "${stat}", which no actor has`);
                }
            });
        }
    }
    assert.deepEqual(bad, [], "\n" + bad.join("\n"));
});

test("every resource a spell drains is a real field", () => {
    const RESOURCES = new Set(["sta", "hp", "luck", "stamina", "health"]);
    const bad = [];
    for (const spell of CORPUS) {
        for (const [entry, body] of Object.entries(spell.on ?? {})) {
            walk(body, (node) => {
                if (node?.b !== "core:drainResource") return;
                const r = node?.a?.resource;
                if (r && !RESOURCES.has(r)) bad.push(`${spell.name}.${entry}: drains "${r}"`);
            });
        }
    }
    assert.deepEqual(bad, [], "\n" + bad.join("\n"));
});
