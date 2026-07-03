// Player-side audit follow-up fixes:
//   1. build-packs.mjs now splits embedded effects[] into !items.effects! keys
//   2. eoCompendiumFolder.EO_PACK_KEYS includes eo-witcher-alchemy
//   3. holdLink hooks use isActiveGM + resolve world-actor + scene grid size
//   4. inventory.js has a symmetric Difficult-armor EQUIP gate + preCreate gate

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const buildSrc  = readFileSync(new URL("../../tools/build-packs.mjs", import.meta.url), "utf8");
const folderSrc = readFileSync(new URL("./eoCompendiumFolder.mjs", import.meta.url), "utf8");
const holdSrc   = readFileSync(new URL("../mechanics/holdLink.mjs", import.meta.url), "utf8");
const invSrc    = readFileSync(new URL("../chrome/chrome/inventory.js", import.meta.url), "utf8");

test("build-packs splits embedded ActiveEffects into separate !items.effects! keys", () => {
    /* The compiled pack's `effects` array on the item must be an
     * array of AE IDs, not the full embedded docs (Foundry v14
     * convention). Without this split the AE never loads. */
    assert.match(buildSrc, /\!items\.effects\!\$\{doc\._id\}\.\$\{ae\._id\}/);
    /* The item's effects array is rewritten to id-only before the
     * item itself is written. */
    assert.match(buildSrc, /doc\.effects\s*=\s*ids/);
});

test("EO_PACK_KEYS includes eo-witcher-alchemy so CE-off hides the pack", () => {
    assert.match(folderSrc, /\${SYSTEM_ID}\.eo-witcher-alchemy/);
});

test("holdLink token-move hook was retired in the RAW grapple rework (2026-07-01)", () => {
    /* RAW Core "Brawling & Wrestling" — Escape is a dedicated Dodge/
     * Escape roll against the grappler's Brawling. Movement no longer
     * auto-clears holds. The hook body was gutted to a `return;` and
     * de-registered from Hooks. Guarding these facts here so a future
     * re-add would fail loud rather than silently reintroducing the
     * old auto-break behavior.
     *
     * The onUpdateActorForHold hook (incapacitation cascade) STILL
     * uses isActiveGM — kept for stunned/prone/dead break behavior. */
    assert.match(holdSrc, /onUpdateActorForHold[\s\S]+?game\.user\?\.isActiveGM/);
    /* Token-move hook is a no-op export; ensure nobody's reading
     * game.actors or grid size from it anymore (that logic is dead). */
    const hookBlock = holdSrc.match(/async function onUpdateTokenForHold[\s\S]+?^\}/m)?.[0] ?? "";
    assert.doesNotMatch(hookBlock, /game\.actors\?\.get\(tokenDoc\.actorId\)/);
    assert.doesNotMatch(hookBlock, /canvas\?\.scene\?\.grid\?\.size/);
    assert.doesNotMatch(hookBlock, /pixelChebyshevTiles/);
    /* Hook itself is not attached. */
    assert.doesNotMatch(holdSrc, /Hooks\.on\?\.\("updateToken",\s*onUpdateTokenForHold\)/);
});

test("inventory.js has a symmetric Difficult-armor EQUIP gate (preUpdateItem)", () => {
    /* Block-equip path: goingOn = change.system.equipped === true,
     * gated on isDifficult + EO toggle + no jack worn → veto by
     * deleting change.system.equipped. */
    assert.match(invSrc, /EO equip gate \(symmetric to the un-equip gate/);
    assert.match(invSrc, /goingOn\s*=\s*[\s\S]+?change\.system\.equipped\s*===\s*true/);
    assert.match(invSrc, /Can't equip[\s\S]+?Difficult armor requires an Arming Jack/);
});

test("inventory.js also catches preCreate of armor with equipped:true", () => {
    /* Item.create + drag-from-compendium can land an item already
     * equipped; need to gate at the create boundary too. */
    assert.match(invSrc, /preCreate equip gate failed/);
    assert.match(invSrc, /createData\?\.system\?\.equipped\s*===\s*true/);
    assert.match(invSrc, /item\.updateSource\(\{\s*"system\.equipped":\s*false\s*\}\)/);
});
