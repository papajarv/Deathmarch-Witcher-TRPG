// Multi-player audit follow-up — five socket/permission fixes:
//   S1. emitApplyDamage spreads payload BEFORE the type discriminator
//   S2. movement-break uses changes.x/y (already covered in playerFlowFixes)
//   S5. handleApplyStatus / handleApplyDamage gated on authorizeSocket
//   S5. handleReduceReliability also gated
//   S8. applyHoldLink + clearHoldLink socket-route when caller can't write
//   S8. new handleHoldApply / handleHoldClear with sender-owns-holder check

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sockSrc = readFileSync(new URL("./socketHook.mjs", import.meta.url), "utf8");
const holdSrc = readFileSync(new URL("../mechanics/holdLink.mjs", import.meta.url), "utf8");

test("S1 — emitApplyDamage spreads payload BEFORE the type discriminator", () => {
    /* The "applyDamage" discriminator must always win even if the
     * caller passes legacy `type: "slashing"` from the damage-type
     * field. */
    assert.match(sockSrc, /game\.socket\.emit\(CHANNEL,\s*\{\s*\.\.\.payload,\s*type:\s*"applyDamage",\s*senderUserId:/);
});

test("S5 — authorizeSocket helper exists and reads sender's ownership level", () => {
    assert.match(sockSrc, /function authorizeSocket\(payload, target, requiredLevel/);
    assert.match(sockSrc, /senderUserId\s*=\s*payload\?\.senderUserId/);
    assert.match(sockSrc, /testUserPermission\(user, requiredLevel\)/);
});

test("S5 — emitters stamp senderUserId for the GM-side auth check", () => {
    assert.match(sockSrc, /emitApplyDamage[\s\S]+?senderUserId:\s*game\.user\?\.id/);
    assert.match(sockSrc, /emitApplyStatus[\s\S]+?senderUserId:\s*game\.user\?\.id/);
    assert.match(sockSrc, /emitReduceReliability[\s\S]+?senderUserId:\s*game\.user\?\.id/);
});

test("S5 — handleApplyDamage gates on authorizeSocket before draining HP", () => {
    /* Without this, a player could socket-call to apply damage to any
     * actor (incl. GM-only NPCs / other players' PCs). */
    assert.match(sockSrc, /handleApplyDamage[\s\S]+?authorizeSocket\(payload, target\)/);
});

test("S5 — handleApplyStatus gates on authorizeSocket", () => {
    assert.match(sockSrc, /handleApplyStatus[\s\S]+?authorizeSocket\(payload, target\)/);
});

test("S5 — handleReduceReliability gates on authorizeSocket against the item's parent actor", () => {
    assert.match(sockSrc, /handleReduceReliability[\s\S]+?authorizeSocket\(payload, item\.parent \?\? item\)/);
});

test("S8 — applyHoldLink socket-routes when the caller can't OWN both sides", () => {
    /* GM (or full-owner single-user) writes directly. Mixed-ownership
     * (player → NPC) routes through `type: "holdApply"` so the GM
     * client makes the writes. */
    /* Non-GM path now ALWAYS socket-routes: the registry actor lives
     * in the GM's data scope, so even an "I own both sides" caller
     * still can't write to it locally. The S6 fix collapsed the
     * earlier two-branch path into a single emit. */
    assert.match(holdSrc, /if \(game\.user\?\.isActiveGM\) return _doApplyHoldLink/);
    assert.match(holdSrc, /type:\s*"holdApply"[\s\S]+?holderUuid:[\s\S]+?targetUuid:[\s\S]+?kind/);
});

test("S8 — clearHoldLink socket-routes when the caller can't OWN both sides", () => {
    assert.match(holdSrc, /if \(game\.user\?\.isActiveGM\) return _doClearHoldLink/);
    assert.match(holdSrc, /type:\s*"holdClear"[\s\S]+?actorUuid/);
});

test("S8 — socket dispatcher routes holdApply / holdClear to GM handlers", () => {
    assert.match(sockSrc, /case "holdApply":\s+return handleHoldApply/);
    assert.match(sockSrc, /case "holdClear":\s+return handleHoldClear/);
});

test("S8 — handleHoldApply requires OWNER on the holder (no socket-spoof of another player's hold)", () => {
    /* OWNER is the third permission level; OBSERVER is enough for the
     * target. Without the holder-owner check, a malicious player could
     * spoof a hold initiated by another player's PC. */
    assert.match(sockSrc, /handleHoldApply[\s\S]+?authorizeSocket\(payload, holder, OWNER\)/);
});
