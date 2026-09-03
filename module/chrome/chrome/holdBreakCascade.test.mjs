// module/chrome/chrome/holdBreakCascade.test.mjs
//
// Holds form a dependency STACK: clinch (base) → grapple → pin/choke (top).
// A grapple auto-establishes a clinch, and a pin/choke sits on a grapple.
// Breaking a layer collapses everything built ON it but leaves the layers
// BELOW it standing. These source-match tests lock that matrix in for the
// holder-side break paths (the break pill + the Release-Grapple action).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const breakSrc = readFileSync(new URL("./clinch-break.js", import.meta.url), "utf8");
const brawlSrc = readFileSync(new URL("../../documents/mixins/brawlMixin.mjs", import.meta.url), "utf8");

test("break pill: each layer drops everything stacked on it, nothing below it", () => {
    /* Break clinch → whole stack; grapple → grapple+pin/choke (clinch stays);
     * pin/choke → just that top layer. */
    assert.match(breakSrc, /clinched:\s*\["chokeheld",\s*"pinned",\s*"grappled",\s*"clinched"\]/);
    assert.match(breakSrc, /grappled:\s*\["chokeheld",\s*"pinned",\s*"grappled"\]/);
    assert.match(breakSrc, /pinned:\s*\["pinned"\]/);
    assert.match(breakSrc, /chokeheld:\s*\["chokeheld"\]/);
    /* Every kind in dropKinds is cleared with a KIND-scoped clearHoldLink so
     * only the intended layers drop (never a blind cascade). */
    assert.match(breakSrc, /for\s*\(const k of dropKinds\)[\s\S]+?clearHoldLink\(actor,\s*"break-button",\s*partner\s*\?\?\s*null,\s*k\)/);
});

test("a grapplee's Break-Clinch pill is disabled — they must Escape, not drop the clinch", () => {
    /* A held actor (TARGET of grappled/pinned/chokeheld) who also HOLDS a
     * clinch could otherwise collapse the whole stack by breaking that clinch,
     * escaping the grapple without the opposed Escape roll. The pill is
     * rendered disabled for them and the click handler refuses it. */
    assert.match(breakSrc, /const\s+isGrapplee\s*=\s*st\.pairs\.some\([\s\S]*?p\.role === "target"\s*&&\s*\(p\.kind === "grappled"\s*\|\|\s*p\.kind === "pinned"\s*\|\|\s*p\.kind === "chokeheld"\)/);
    assert.match(breakSrc, /const\s+clinchLocked\s*=\s*cfg\.kind === "clinched"\s*&&\s*isGrapplee/);
    assert.match(breakSrc, /is-disabled/);
    /* Click guard: disabled pill surfaces the reason and no-ops. */
    assert.match(breakSrc, /pill\.dataset\.disabled === "1"[\s\S]+?return;/);
});

test("Release Grapple lets go of the grapple family but keeps the clinch", () => {
    /* The grappler voluntarily releasing drops grapple/pin/choke (kind-scoped)
     * but skips the clinch — breaking a grapple never breaks the clinch. */
    assert.match(brawlSrc, /if\s*\(p\.kind === "clinched"\)\s*continue;/);
    assert.match(brawlSrc, /clearHoldLink\(this,\s*"voluntary release",\s*partner,\s*p\.kind\)/);
});
