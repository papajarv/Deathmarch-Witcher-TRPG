// Player-side audit follow-up fixes:
//   1. build-packs.mjs now splits embedded effects[] into !items.effects! keys
//   2. holdLink hooks use isActiveGM + resolve world-actor + scene grid size
//   3. inventory.js has a symmetric Difficult-armor EQUIP gate + preCreate gate

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

/* tools/build-packs.mjs ships only in the packaging repo, not this play
 * checkout — read it optionally so its absence skips the one build-packs
 * test rather than crashing the whole file at load. */
const buildUrl  = new URL("../../tools/build-packs.mjs", import.meta.url);
const buildSrc  = existsSync(buildUrl) ? readFileSync(buildUrl, "utf8") : null;
const holdSrc   = readFileSync(new URL("../mechanics/holdLink.mjs", import.meta.url), "utf8");
const invSrc    = readFileSync(new URL("../chrome/chrome/inventory.js", import.meta.url), "utf8");

test("build-packs splits embedded ActiveEffects into separate !items.effects! keys", { skip: buildSrc === null && "tools/build-packs.mjs not present in this checkout" }, () => {
    /* The compiled pack's `effects` array on the item must be an
     * array of AE IDs, not the full embedded docs (Foundry v14
     * convention). Without this split the AE never loads. */
    assert.match(buildSrc, /\!items\.effects\!\$\{doc\._id\}\.\$\{ae\._id\}/);
    /* The item's effects array is rewritten to id-only before the
     * item itself is written. */
    assert.match(buildSrc, /doc\.effects\s*=\s*ids/);
});

test("holdLink token-move hook drives clinch auto-break + Ride follow-mount", () => {
    /* The token-move hook was retired in the 2026-07-01 RAW rework, but
     * later re-added for the Combat Extended movement mechanics: a real
     * token move by anyone in a CLINCH breaks that pair (GM-side backstop
     * to the client-side break-step in policy/canvas-movement.mjs), and a
     * MOUNT's move slaves the rider's token to it (CE Ride follow-mount).
     * Both the actor-update and token-update hooks are GM-gated. */
    assert.match(holdSrc, /onUpdateActorForHold[\s\S]+?game\.user\?\.isActiveGM/);
    /* Token-move hook is live, GM-gated, and only reacts to x/y changes. */
    const hookBlock = holdSrc.match(/async function onUpdateTokenForHold[\s\S]+?\n\}/m)?.[0] ?? "";
    assert.match(hookBlock, /game\.user\?\.isActiveGM/);
    assert.match(hookBlock, /changes\?\.x == null && changes\?\.y == null/);
    /* Clinch auto-break: a move by holder OR target clears every clinch
     * they're in (skipped for our own wdmClinchMove positioning move). */
    assert.match(hookBlock, /wdmClinchMove/);
    assert.match(hookBlock, /kind === "clinched"[\s\S]+?clearHoldLink\(actor,\s*"movement"/);
    /* Hook IS attached again. */
    assert.match(holdSrc, /Hooks\.on\?\.\("updateToken",\s*onUpdateTokenForHold\)/);
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
