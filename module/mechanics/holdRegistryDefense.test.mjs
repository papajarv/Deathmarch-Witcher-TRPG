// Defensive hardening for the hold registry — three anticipated
// real-world failure modes a GM will trip:
//   1. Two near-simultaneous holds race to create the registry actor
//      (e.g. a macro clinching four targets in one tick).
//   2. An actor is deleted mid-hold; the registry should not retain
//      a dangling entry that future getHold calls return forever.
//   3. The cryptic `__witcher_hold_registry__` actor would otherwise
//      clutter the GM's Actor Directory sidebar.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const regSrc  = readFileSync(new URL("./holdRegistry.mjs", import.meta.url), "utf8");
const linkSrc = readFileSync(new URL("./holdLink.mjs", import.meta.url), "utf8");

test("Concurrent registry creates share one promise (no dupes)", () => {
    /* Without a shared in-flight promise, two callers that both miss
     * the cache would each call Actor.create — Foundry happily makes
     * two registries and the next read picks one at random. */
    assert.match(regSrc, /let _creatingPromise = null/);
    assert.match(regSrc, /if \(_creatingPromise\) return _creatingPromise/);
    /* finally clears it so a one-shot create-failure doesn't wedge
     * every subsequent attempt. */
    assert.match(regSrc, /finally \{[\s\S]+?_creatingPromise = null/);
});

test("Lookup tolerates pre-existing duplicate registry actors (oldest wins)", () => {
    /* Legacy worlds may already have multiple — sort by createdTime
     * and use the oldest deterministically. */
    assert.match(regSrc, /multiple hold-registry actors found/);
    assert.match(regSrc, /candidates\.sort[\s\S]+?_stats\?\.createdTime/);
});

test("Registry lookup keys on the marker flag, not just the name", () => {
    /* A GM-renamed registry would still be found via the
     * `isHoldRegistry` flag; name-only matching would lose it. */
    assert.match(regSrc, /a\?\.getFlag\?\.\(SYSTEM_ID,\s*"isHoldRegistry"\)\s*===\s*true/);
});

test("sweepDeletedActor removes pairs on EITHER side of a hold", () => {
    /* A deleted actor could be the holder OR the target of any pair
     * (including multi-clinch pairs where they were one of many
     * holders). Sweep every pair touching the deleted uuid. */
    assert.match(regSrc, /export async function sweepDeletedActor/);
    assert.match(regSrc, /p\.holderUuid !== actorUuid\s*&&\s*p\.targetUuid !== actorUuid/);
});

test("deleteActor hook fires the sweep (GM-side only)", () => {
    assert.match(linkSrc, /Hooks\.on\?\.\("deleteActor"[\s\S]+?game\.user\?\.isActiveGM[\s\S]+?sweepDeletedActor\(actor\.uuid\)/);
});

test("renderActorDirectory hook hides the registry from the GM's sidebar", () => {
    /* Without this the GM sees a confusing `__witcher_hold_registry__`
     * row. The hook strips its DOM node post-render. */
    assert.match(linkSrc, /Hooks\.on\?\.\("renderActorDirectory"/);
    assert.match(linkSrc, /a\?\.getFlag\?\.\("witcher-ttrpg-death-march",\s*"isHoldRegistry"\)/);
    assert.match(linkSrc, /row\.remove\(\)/);
});
