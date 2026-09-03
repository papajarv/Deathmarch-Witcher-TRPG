// Hold-link bookkeeping — Clinch / Grapple / Pin / Chokehold.
//
// Post-refactor invariants (bidirectional + multi-clinch):
//   1. Status stamped on BOTH parties of a pair.
//   2. A single target can be clinched by many holders — each apply
//      appends a pair rather than overwriting.
//   3. Escape is pure movement — the movement-break hook clears the
//      specific pair whose distance exceeded reach; other pairs the
//      actor is in stay intact. No Escape action.
//   4. Status is only removed from an actor when they have no other
//      pair of the same kind remaining.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const linkSrc  = readFileSync(new URL("./holdLink.mjs", import.meta.url), "utf8");
const hooksSrc = readFileSync(new URL("../setup/hooks.mjs", import.meta.url), "utf8");
const mixinSrc = readFileSync(new URL("../documents/mixins/weaponAttackMixin.mjs", import.meta.url), "utf8");

test("HOLD_STATUSES lists the hold ids the predicate reads", () => {
    assert.match(linkSrc, /HOLD_STATUSES\s*=\s*Object\.freeze\(\["grappled",\s*"pinned",\s*"clinched",\s*"chokeheld"\]\)/);
});

test("HOLD_BREAK_STATUSES covers stunned/unconscious/dead — but NOT prone (house rule: grapple on the ground)", () => {
    assert.match(linkSrc, /HOLD_BREAK_STATUSES\s*=\s*Object\.freeze\(\["stunned",\s*"unconscious",\s*"dead"\]\)/);
    /* Prone deliberately excluded — going prone neither breaks a hold nor bars grappling. */
    assert.doesNotMatch(linkSrc, /HOLD_BREAK_STATUSES\s*=\s*Object\.freeze\(\[[^\]]*"prone"/);
});

test("applyHoldLink stamps status on TARGET ONLY (RAW-aligned, 2026-07-01 rework)", () => {
    /* RAW Core "Brawling & Wrestling" describes the target's grappled
     * penalties (−2 to all physical actions, can't move away) but says
     * nothing about the grappler's own state. Stamping the status on
     * both sides caused the grappler to take a −2 to their own attacks
     * — not what the rulebook says. Now only the target receives the
     * status; the pair is still bidirectional in the REGISTRY. */
    const applyBlock = linkSrc.match(/async function _doApplyHoldLink[\s\S]+?^\}/m)?.[0] ?? "";
    assert.match(applyBlock, /await target\.toggleStatusEffect\(kind,\s*\{\s*active:\s*true\s*\}\)/);
    /* Choke is now ACTION-DRIVEN (per-turn damage via the Choke action), so the
     * passive `suffocation` DoT is NO LONGER co-applied on the chokeheld pair —
     * that would double-dip on top of the per-action choke damage. */
    assert.doesNotMatch(applyBlock, /toggleStatusEffect\("suffocation"/);
});

test("applyHoldLink appends pairs via setHold (multi-clinch, no overwrite)", () => {
    /* setHold takes (holder, target, kind) and appends. No anchor
     * arg — positions are read live at movement-check time. Uuids
     * are normalized to the WORLD actor's uuid so a synthetic-token
     * target (Scene.X.Token.Y.Actor.Z) is stored the same way the
     * movement hook's lookup expects (Actor.Z). */
    const applyBlock = linkSrc.match(/async function _doApplyHoldLink[\s\S]+?^\}/m)?.[0] ?? "";
    assert.match(applyBlock, /import\("\.\/holdRegistry\.mjs"\)/);
    assert.match(applyBlock, /normalizedActorUuid\(holder\)/);
    assert.match(applyBlock, /normalizedActorUuid\(target\)/);
    assert.match(applyBlock, /setHold\(holderUuid,\s*targetUuid,\s*kind\)/);
});

test("a grapple auto-establishes a clinch pair (CE) as a SEPARATE layer", () => {
    /* Grappling implies a clinch — a grappled foe is chest-to-chest, so
     * _doApplyHoldLink creates a distinct `clinched` pair alongside the
     * grapple: silent (the grapple card already announced) and CE-only
     * (clinch isn't RAW). It repositions the grappler into the target's
     * face like a manual clinch (positionClincher runs). Being a SEPARATE
     * pair is the point: the layered Escape peels grappled before clinched,
     * so breaking the grapple leaves the clinch standing — the victim must
     * Escape a second time to shed it. */
    const applyBlock = linkSrc.match(/async function _doApplyHoldLink[\s\S]+?^\}/m)?.[0] ?? "";
    assert.match(applyBlock, /kind === "grappled" && wasNew && isCEOn\(\)/);
    assert.match(applyBlock, /_doApplyHoldLink\(holder,\s*target,\s*"clinched",\s*\{\s*silent:\s*true\s*\}\)/);
    /* Holder-side clinch marker → BOTH sides of a clinch carry a status. */
    assert.match(linkSrc, /clinched:\s*"isClinching"/);
    /* The clinch (including the auto-clinch) repositions via positionClincher. */
    assert.match(applyBlock, /kind === "clinched" && wasNew[\s\S]+?positionClincher\(holder,\s*target\)/);
});

test("applyHoldLink stores no actor-side link flag — registry is the sole source of truth", () => {
    /* The S6 privacy fix stays. No setFlag on either side. */
    const applyBlock = linkSrc.match(/async function _doApplyHoldLink[\s\S]+?^\}/m)?.[0] ?? "";
    assert.doesNotMatch(applyBlock, /target\.setFlag\(SYSTEM_ID,\s*"holdLink"/);
    assert.doesNotMatch(applyBlock, /holder\.setFlag\(SYSTEM_ID,\s*"holdLink"/);
});

test("applyHoldLink refuses to latch when the holder is incapacitated", () => {
    /* Holder prone / stunned / unconscious / dead can't start a hold. */
    assert.match(linkSrc, /for \(const s of HOLD_BREAK_STATUSES\) \{[\s\S]+?holder\.statuses\?\.has\?\.\(s\)/);
});

test("clearHoldLink supports targeted (partnerActor) and cascade (no partner) modes", () => {
    /* Movement break passes the specific partner so only that pair
     * clears. Deletion and incapacitation cascades pass no partner. */
    assert.match(linkSrc, /export async function clearHoldLink\(actor,\s*reason\s*=\s*"manual",\s*partnerActor\s*=\s*null,\s*kind\s*=\s*null\)/);
    /* Underlying registry clearHold receives normalized uuids so
     * synthetic-token references still find the world-uuid pair — plus the
     * optional `kind` for layered peels (Escape a pin → grapple). */
    assert.match(linkSrc, /clearHold\(actorUuid,\s*normalizedActorUuid\(partnerActor\),\s*kind\)/);
});

test("Clear strips the hold status from ALL representations of the affected actor", () => {
    /* Second half of the synthetic-token bug: even after uuids are
     * normalized, the `clinched` status can live on an unlinked
     * token's synthetic actor (its .statuses set is independent of
     * the world actor's). Toggling only via fromUuid(worldUuid)
     * would leave the status icon on the token forever.
     *
     * Fix: after fromUuid resolves the world actor, ALSO gather
     * every token on the canvas whose actorId matches, and toggle
     * the status off on each of their synthetic actors. */
    const clearBlock = linkSrc.match(/async function _doClearHoldLink[\s\S]+?^\}/m)?.[0] ?? "";
    assert.match(clearBlock, /canvas\?\.tokens\?\.placeables/);
    assert.match(clearBlock, /t\?\.document\?\.actorId\s*===\s*worldActorId/);
    assert.match(clearBlock, /representations\.add\(t\.actor\)/);
    assert.match(clearBlock, /for \(const side of representations\)/);
});

test("Actor uuids are normalized (synthetic → world) at every registry touchpoint", () => {
    /* This was the "stepping away doesn't break clinch" bug: pairs
     * got written under Scene.X.Token.Y.Actor.Z (from a Foundry
     * click-target's actor.uuid) but the movement hook resolved
     * through game.actors.get(tokenDoc.actorId).uuid → Actor.Z.
     * Different strings, no lookup match, clinch never cleared. */
    assert.match(linkSrc, /function normalizedActorUuid\(actor\)[\s\S]+?actor\?\.token\?\.actorId/);
    /* Read paths use normalizedActorUuid too, so a lookup from either
     * side of the synthetic-vs-world divide resolves the same pair. */
    assert.match(linkSrc, /const uuid = normalizedActorUuid\(actor\);[\s\S]+?getHolds\(uuid\)/);
});

test("clearHoldLink strips status only when the actor has no other pair of that kind", () => {
    /* If B is clinched by A, C, D and A steps away, the (A↔B) pair
     * breaks but B still has C and D — B keeps `clinched`. This is
     * the "check remaining pairs" logic. */
    const clearBlock = linkSrc.match(/async function _doClearHoldLink[\s\S]+?^\}/m)?.[0] ?? "";
    /* Reads remaining pairs after clear. */
    assert.match(clearBlock, /getHolds\(uuid\)/);
    /* Only strips a kind that has NO remaining pair of that kind. */
    assert.match(clearBlock, /remainingKinds\.has\(k\)/);
});

test("clearHoldLink strips status via toggleStatusEffect + drops legacy flag", () => {
    const clearBlock = linkSrc.match(/async function _doClearHoldLink[\s\S]+?^\}/m)?.[0] ?? "";
    assert.match(clearBlock, /toggleStatusEffect\(sid,\s*\{\s*active:\s*false\s*\}\)/);
    /* Belt-and-suspenders unsetFlag for pre-migration data. */
    assert.match(clearBlock, /unsetFlag\(SYSTEM_ID,\s*"holdLink"\)/);
});

test("clearHoldLink emits a chat-card audit note per removed pair (non-manual reasons)", () => {
    /* Movement break and incapacitation should leave a trail; explicit
     * manual clears don't need a redundant message. Multi-pair
     * cascades emit one message per pair broken. */
    const clearBlock = linkSrc.match(/async function _doClearHoldLink[\s\S]+?^\}/m)?.[0] ?? "";
    assert.match(clearBlock, /reason !== "manual"[\s\S]+?for \(const pair of removed\)[\s\S]+?ChatMessage\.create/);
});

test("Token-move hook breaks CLINCH on movement (not RAW grapple/pin/choke)", () => {
    /* Clinch consumes your movement: the moment a clinched actor (holder
     * OR target) spends any movement, every clinch they're in breaks. The
     * client policy (canvas-movement.mjs) truncates+snaps the first move
     * for UX; this GM-side hook is the backstop that actually clears the
     * pair. RAW grapple/pin/choke still DON'T auto-break (Escape is their
     * only exit) — the break is gated on `kind === "clinched"`. */
    const hookBlock = linkSrc.match(/async function onUpdateTokenForHold[\s\S]+?^\}/m)?.[0] ?? "";
    // Clinch-only filter + clear on movement.
    assert.match(hookBlock, /kind\s*===\s*"clinched"/);
    assert.match(hookBlock, /clearHoldLink\(actor,\s*"movement"/);
    // Guarded so the clinch's OWN positioning move doesn't self-break it.
    assert.match(hookBlock, /wdmClinchMove/);
    // The hook IS registered on updateToken (also drives CE Ride follow).
    assert.match(linkSrc, /Hooks\.on\?\.\("updateToken",\s*onUpdateTokenForHold\)/);
});

test("Adjacency helper still uses Chebyshev tiles (used for apply-time gate)", () => {
    /* Movement break no longer uses reach math, but applyHoldLink's
     * adjacency check does — you can only clinch someone you're
     * next to (Chebyshev ≤ 1 tile). */
    assert.match(linkSrc, /HOLD_REACH_TILES\s*=\s*1\b/);
    assert.match(linkSrc, /function pixelChebyshevTiles/);
    assert.match(linkSrc, /function areActorsAdjacent[\s\S]+?pixelChebyshevTiles[\s\S]+?<=\s*HOLD_REACH_TILES/);
});

test("applyHoldLink gates on adjacency — refuses when tokens exist and are non-adjacent", () => {
    /* Adjacency check runs on the initiator's client BEFORE the
     * socket-routing branch so a player-triggered clinch never
     * lands unless the two actors are actually adjacent (or the
     * prompt confirmed it in theatre-of-mind). */
    const applyBlock = linkSrc.match(/export async function applyHoldLink[\s\S]+?^\}/m)?.[0] ?? "";
    assert.match(applyBlock, /areActorsAdjacent\(holder,\s*target\)/);
    assert.match(applyBlock, /if \(adj === false\)/);
});

test("applyHoldLink prompts when there are no tokens (combat-tracker target)", () => {
    /* Theatre-of-mind path: the adjacency helper returns null when
     * either actor lacks an active token. The initiator's client
     * shows a DialogV2 confirmation before the clinch lands. */
    const applyBlock = linkSrc.match(/export async function applyHoldLink[\s\S]+?^\}/m)?.[0] ?? "";
    assert.match(applyBlock, /if \(adj === null\)/);
    assert.match(applyBlock, /promptAdjacency/);
    assert.match(linkSrc, /foundry\?\.applications\?\.api\?\.DialogV2/);
});

test("updateActor cascade breaks holds ONLY on terminal states (not merely stunned)", () => {
    /* Unconscious / dead break every hold the actor is in — but a plain STUN
     * must NOT, or one Stun would free every grapple/choke in play. The cascade
     * keys on HOLD_CASCADE_STATUSES (no "stunned"). */
    assert.match(linkSrc, /HOLD_CASCADE_STATUSES\s*=\s*Object\.freeze\(\["unconscious",\s*"dead"\]\)/);
    const hookBlock = linkSrc.match(/async function onUpdateActorForHold[\s\S]+?^\}/m)?.[0] ?? "";
    assert.match(hookBlock, /getHoldLinks\(actor\)/);
    assert.match(hookBlock, /for \(const sid of HOLD_CASCADE_STATUSES\)[\s\S]+?actor\.statuses\?\.has\?\.\(sid\)[\s\S]+?clearHoldLink/);
});

test("createActiveEffect hook also triggers the incapacitation cascade (terminal only)", () => {
    /* Foundry status changes route through ActiveEffect. Cascade clears every
     * pair — but again only on the terminal HOLD_CASCADE_STATUSES, not stun. */
    assert.match(linkSrc, /Hooks\.on\?\.\("createActiveEffect"/);
    assert.match(linkSrc, /sids\.some\(s\s*=>\s*HOLD_CASCADE_STATUSES\.includes\(s\)\)[\s\S]+?clearHoldLink/);
});

test("hooks.mjs registers the hold-link hooks at world init", () => {
    assert.match(hooksSrc, /import\s*\{\s*registerHoldLinkHooks\s*\}\s*from\s*"\.\.\/mechanics\/holdLink\.mjs"/);
    assert.match(hooksSrc, /registerHoldLinkHooks\(\)/);
});

test("weaponAttackMixin routes hold-status applies through applyHoldLink", () => {
    /* On a hit with an `appliesStatus` that's one of the four hold ids,
     * the mixin imports applyHoldLink instead of bare emitApplyStatus. */
    assert.match(mixinSrc, /HOLDS\s*=\s*\["grappled",\s*"pinned",\s*"clinched",\s*"chokeheld"\]/);
    // The trailing `sid` may be followed by an optional options arg (allowReach).
    assert.match(mixinSrc, /HOLDS\.includes\(sid\)[\s\S]+?applyHoldLink\(this,\s*_defenderActor,\s*sid[,)]/);
});

test("Escape action is gone — no clearHoldLink('escape') call in the mixin", () => {
    /* Escape is pure movement now; the movement-break hook clears
     * the pair automatically when the actor moves off the clincher's
     * reach. The dedicated Escape button/handler has been removed. */
    assert.doesNotMatch(mixinSrc, /clearHoldLink\([^)]+,\s*"escape"/);
});
