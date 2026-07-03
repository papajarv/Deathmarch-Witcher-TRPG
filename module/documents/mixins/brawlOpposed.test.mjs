// module/documents/mixins/brawlOpposed.test.mjs
//
// Grapple / pin / choke / throw / trip (RAW p.160 + p.163) are OPPOSED
// checks. The pre-refactor brawl flow just applied the status flat, so
// grapples always landed regardless of the defender's response. This
// test file locks the opposition in.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./brawlMixin.mjs", import.meta.url), "utf8");

test("brawlMixin imports requestDefenseFromOwner for opposed-check flow", () => {
    /* The defender's opposed roll (dodge / reposition — see DEFENSE_GATE
     * in defensePromptDialog.mjs, gated with attackKind: "grapple") is
     * requested via the same socket path the weapon-attack path uses. */
    assert.match(src, /import\s*\{\s*requestDefenseFromOwner\s*\}\s*from\s*"[^"]*setup\/socketHook\.mjs"/);
});

test("brawlMixin routes hold-family statuses through applyHoldLink", () => {
    /* The grapple, clinch, pin, and chokehold statuses land as hold
     * pairs (so the adjacency check + multi-clinch bookkeeping fires),
     * not as bare status toggles. */
    assert.match(src, /import\s*\{\s*applyHoldLink,\s*getHoldLinks,\s*HOLD_STATUSES,\s*normalizedActorUuid,\s*areActorsAdjacent\s*\}\s*from\s*"[^"]*mechanics\/holdLink\.mjs"/);
    /* applyStatusToTarget branches on HOLD_STATUSES.includes(statusId). */
    assert.match(src, /HOLD_STATUSES\.includes\(statusId\)[\s\S]+?applyHoldLink\(attacker,\s*target,\s*statusId\)/);
});

test("needsGrapple actions refuse to fire without an existing pair against the target", () => {
    /* Pin, choke, throw, trip all declare needsGrapple:true in the brawl
     * config. RAW p.160 requires the actor to ALREADY be holding the
     * target — not just "some grapple exists in the world". The runtime
     * gate reads getHoldLinks(this) and verifies the target is one of
     * the current partners; missing → warn + abort. */
    assert.match(src, /async function attackerHoldsTarget\(attacker,\s*target\)/);
    assert.match(src, /getHoldLinks\(attacker\)/);
    /* Comparison is normalized on the read side — writes stamp the world
     * uuid, so the check has to normalize `target` (which may be a
     * synthetic-token actor with a `Scene.X.Token.Y.Actor.Z` uuid) the
     * same way. Otherwise Pin/Choke/Throw after a successful grapple on
     * an unlinked NPC token silently refused. */
    assert.match(src, /const\s+targetUuid\s*=\s*normalizedActorUuid\(target\)/);
    assert.match(src, /pairs\.some\(p\s*=>\s*p\?\.partnerUuid\s*===\s*targetUuid\)/);
    /* Gate is upstream of the roll — abort with a warning if no pair. */
    assert.match(src, /if \(meta\.needsGrapple\)[\s\S]+?attackerHoldsTarget\(this,\s*t\)/);
    assert.match(src, /notHeld\.length\s*>\s*0[\s\S]+?return null/);
});

test("All brawl attacks (grapple + plain) request a defense BEFORE the attacker rolls", () => {
    /* Opposed flow (RAW): defender picks their reaction, rolls, and
     * the attacker's shot total then races the defender's total.
     * Coverage extended past grapples to plain attacks (punch, kick,
     * push kick, charge) — every brawl swing is opposed per RAW.
     * Grapple actions gate the defender's options to dodge/reposition
     * (DEFENSE_GATE.grapple); plain attacks use "normal" which opens
     * parry / block / dodge / reposition. */
    assert.match(src, /isGrapple\s*=\s*meta\.kind\s*===\s*"grapple"\s*&&\s*!!meta\.status/);
    assert.match(src, /isPlainAttack\s*=\s*meta\.kind\s*===\s*"attack"/);
    assert.match(src, /isOpposedAction\s*=\s*\(isGrapple\s*\|\|\s*isPlainAttack\)/);
    assert.match(src, /attackKind:\s*isGrapple\s*\?\s*"grapple"\s*:\s*"normal"/);
});

test("Status only applies when the attacker's total BEAT the defender's total", () => {
    /* Pre-refactor: applyStatusToTargets was called unconditionally
     * BEFORE the attacker rolled — the grapple always landed regardless
     * of the roll. Post-refactor: firstShotBeat gates the apply on
     * atkTotal > defenseTotal from the SAME shot the roll produced. */
    assert.match(src, /firstShotBeat\s*=\s*hasDefenseTotal\s*&&\s*Number\.isFinite\(atkTotal\)\s*&&\s*atkTotal\s*>\s*defenseTotal/);
    assert.match(src, /if\s*\(firstShotBeat\)/);
});

test("A resisted grapple posts a 'defender wins' follow-up card, no status applied", () => {
    /* When the defender's opposed total meets or beats the attacker,
     * the action fails — a chat card documents the resistance and no
     * status is written. */
    assert.match(src, /wins the opposed roll[\s\S]+?attempt fails/);
});

test("Non-opposed brawl status appliers (push kick etc.) still route through applyStatusToTarget", () => {
    /* Non-opposed brawl actions (punch/kick with prone, push kick with
     * knockback status) still land their status flat — the refactor
     * preserved that path, just funnelled through the shared apply
     * helper so hold-family statuses go via applyHoldLink and everything
     * else goes via toggleStatusEffect. */
    assert.match(src, /for \(const t of grappleTargets\)[\s\S]+?applyStatusToTarget\(this,\s*t,\s*meta\.status\)/);
});
