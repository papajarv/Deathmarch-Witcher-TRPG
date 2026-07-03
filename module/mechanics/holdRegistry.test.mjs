// Hidden registry actor for hold relationships.
//
// Two invariants covered here:
//   - Privacy: registry actor is GM-only (default: NONE ownership),
//     created only by the GM client. Info-disclosure fix.
//   - Data model: pair-based storage supporting multi-clinch (one
//     target held by many holders) and bidirectional status (see
//     holdLink.test.mjs for the status side).
//
// Storage shape:
//   flags.<sys>.holds = [
//     { holderUuid, targetUuid, kind },
//     ...
//   ]
// Anchors are gone — the movement-break check reads current token
// positions directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const regSrc  = readFileSync(new URL("./holdRegistry.mjs", import.meta.url), "utf8");
const linkSrc = readFileSync(new URL("./holdLink.mjs", import.meta.url), "utf8");

test("Registry actor is created with default: OBSERVER ownership", () => {
    /* OBSERVER default so the actor is present in every player's world
     * bundle. Players read pair data via `.getFlag()` locally (required
     * by the needsGrapple gate for follow-up Pin / Choke / Throw);
     * writes still route through the socket to the GM. The old NONE
     * default hid the actor from players, which broke
     * `attackerHoldsTarget` after a successful grapple — the player's
     * client couldn't see the pair the GM had just written. */
    assert.match(regSrc, /ownership:\s*\{\s*default:\s*CONST\.DOCUMENT_OWNERSHIP_LEVELS\?\.OBSERVER\s*\?\?\s*2\s*\}/);
});

test("Existing NONE-ownership registries are bumped to OBSERVER on next GM read", () => {
    /* Legacy fixup: existing worlds shipped the registry with NONE
     * default. On the GM's next `getOrCreateRegistry` call, bump to
     * OBSERVER so the actor propagates into player world bundles. */
    assert.match(regSrc, /if \(game\.user\?\.isActiveGM && curr\s*<\s*OBS\)/);
    assert.match(regSrc, /_cachedRegistry\.update\(\{\s*"ownership\.default":\s*OBS\s*\}\)/);
});

test("Registry actor is only created by the GM client", () => {
    /* Non-GM clients can't write to the registry — but they also
     * can't see it to know whether it exists. The lookup function
     * bails for non-GM if the actor isn't already there. */
    assert.match(regSrc, /if \(!game\.user\?\.isActiveGM\) return null/);
});

test("setHold appends a pair without overwriting existing pairs", () => {
    /* Multi-clinch: if A clinches B, then C tries to clinch B, C's
     * write must APPEND (A↔B still exists). No uuid-key overwrites. */
    const setBlock = regSrc.match(/export async function setHold[\s\S]+?^\}/m)?.[0] ?? "";
    /* Must push a new pair with holderUuid + targetUuid + kind. */
    assert.match(setBlock, /cur\.push\(\{\s*holderUuid,\s*targetUuid,\s*kind\s*\}\)/);
    /* Must NOT filter existing entries by uuid (that's the old
     * one-per-actor overwrite that broke multi-clinch). */
    assert.doesNotMatch(setBlock, /cur\s*=\s*_readEntries\(reg\)\s*\.filter\(e\s*=>\s*e\.uuid\s*!==/);
});

test("setHold is idempotent on exact-duplicate apply", () => {
    /* Same holder+target+kind pair applied twice = one entry. Guards
     * against double-writes from concurrent socket delivery. */
    const setBlock = regSrc.match(/export async function setHold[\s\S]+?^\}/m)?.[0] ?? "";
    assert.match(setBlock, /cur\.some\(p\s*=>[\s\S]+?holderUuid\s*===\s*holderUuid[\s\S]+?targetUuid\s*===\s*targetUuid[\s\S]+?kind\s*===\s*kind/);
});

test("getHolds returns every pair the actor is in (either side)", () => {
    /* Actor can be holder of some pairs AND target of others. Reader
     * must return all of them. */
    const getBlock = regSrc.match(/export async function getHolds[\s\S]+?^\}/m)?.[0] ?? "";
    assert.match(getBlock, /filter\(p\s*=>[\s\S]+?holderUuid\s*===\s*actorUuid\s*\|\|\s*p\.targetUuid\s*===\s*actorUuid/);
});

test("getHold (back-compat) returns null when the actor isn't held", () => {
    const getBlock = regSrc.match(/export async function getHold\b[\s\S]+?^\}/m)?.[0] ?? "";
    assert.match(getBlock, /if\s*\(pairs\.length\s*===\s*0\)\s*return null/);
});

test("clearHold supports two modes: cascade (all pairs) and targeted (one pair)", () => {
    /* clearHold(uuid) removes every pair the actor is in — used by
     * deletion sweeps and full-cascade escape.
     * clearHold(uuid, partnerUuid) removes only the specific pair —
     * used by movement break when A steps off B and C, D still hold B. */
    const clearBlock = regSrc.match(/export async function clearHold[\s\S]+?^\}/m)?.[0] ?? "";
    assert.match(clearBlock, /partnerUuid\s*=\s*null/);
    assert.match(clearBlock, /partnerUuid\s*===\s*null/);
    /* Cascade branch touches actor regardless of partner. */
    assert.match(clearBlock, /touchesActor\s*=\s*p\.holderUuid\s*===\s*actorUuid\s*\|\|\s*p\.targetUuid\s*===\s*actorUuid/);
});

test("clearHold returns the removed pairs so callers can decide status cleanup", () => {
    /* clearHoldLink needs the removed pairs to figure out which
     * status(es) to strip. If A ↔ B was the last `clinched` pair
     * either actor was in, they lose the status; if either was in
     * another `clinched` pair, they keep it. */
    const clearBlock = regSrc.match(/export async function clearHold[\s\S]+?^\}/m)?.[0] ?? "";
    assert.match(clearBlock, /return removed;/);
});

test("sweepDeletedActor removes every pair touching the deleted uuid", () => {
    /* On actor delete, both sides need cascade cleanup — including
     * every multi-clinch pair the deleted actor was part of. */
    const sweepBlock = regSrc.match(/export async function sweepDeletedActor[\s\S]+?^\}/m)?.[0] ?? "";
    assert.match(sweepBlock, /p\.holderUuid\s*!==\s*actorUuid\s*&&\s*p\.targetUuid\s*!==\s*actorUuid/);
});

test("Storage is an ARRAY not an object — avoids setFlag's key-path mangling", () => {
    /* UUIDs contain `.` and Foundry treats `.` as a path separator on
     * setFlag. Array storage sidesteps the whole class of bugs. */
    assert.match(regSrc, /function _readEntries[\s\S]+?Array\.isArray\(raw\)\s*\?\s*raw\s*:\s*\[\]/);
});

test("Anchors have been removed — movement uses current token positions", () => {
    /* Under the pure-movement escape rule, the "one tile from clincher"
     * check reads token centers directly on preUpdateToken. Anchors
     * would be stale state to keep in sync. */
    assert.doesNotMatch(regSrc, /\banchor\b/);
});

test("holdLink's applyHoldLink writes only the registry — no actor flag", () => {
    /* The S6 privacy invariant: partner info lives on the hidden
     * registry actor, not on the target's or holder's own flag. */
    const applyBlock = linkSrc.match(/async function _doApplyHoldLink[\s\S]+?^\}/m)?.[0] ?? "";
    assert.doesNotMatch(applyBlock, /target\.setFlag\(SYSTEM_ID,\s*"holdLink"/);
    assert.doesNotMatch(applyBlock, /holder\.setFlag\(SYSTEM_ID,\s*"holdLink"/);
    /* Uuids are normalized to world-actor uuids before calling
     * setHold — the synthetic-vs-world mismatch bug fix. */
    assert.match(applyBlock, /setHold\(holderUuid,\s*targetUuid,\s*kind\)/);
});

test("holdLink's clearHoldLink reads from the registry, not the actor flag", () => {
    const clearBlock = linkSrc.match(/async function _doClearHoldLink[\s\S]+?^\}/m)?.[0] ?? "";
    /* Post-normalization: the actor is resolved to its world uuid
     * (actorUuid) before passing to registry.clearHold. */
    assert.match(clearBlock, /clearHold\(actorUuid/);
    /* Status toggle off remains (status is public by necessity). */
    assert.match(clearBlock, /toggleStatusEffect\(sid,\s*\{\s*active:\s*false\s*\}\)/);
});

test("getHoldLink (public reader) is now async + reads via registry import", () => {
    assert.match(linkSrc, /export async function getHoldLink/);
    assert.match(linkSrc, /import\("\.\/holdRegistry\.mjs"\)/);
});

test("Non-GM clients always socket-route apply + clear (registry is GM-only)", () => {
    /* Pre-S6: caller-owns-both-sides took a direct-write fast path.
     * Post-S6: that path is removed since the registry is GM-only;
     * everything from a non-GM goes through the socket. */
    assert.match(linkSrc, /if \(game\.user\?\.isActiveGM\) return _doApplyHoldLink/);
    /* The fast path with `testUserPermission` is gone from applyHoldLink. */
    const applyPublic = linkSrc.match(/export async function applyHoldLink[\s\S]+?^\}/m)?.[0] ?? "";
    assert.doesNotMatch(applyPublic, /testUserPermission/);
});
