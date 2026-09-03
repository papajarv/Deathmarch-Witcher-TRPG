/**
 * Roll Damage sits in the cast card's HEADER, not its body.
 *
 * A cast card gets wrapped into a `details.wdm-attack-card` the moment a
 * resolution is appended, and that wrapper starts CLOSED. Anything injected
 * into `.wdm-cast-head` therefore lands inside the collapsed body — which is
 * where the cast Roll Damage button used to go, so the next thing the caster
 * was meant to click could only be reached by expanding the card first. Melee
 * puts its copy in the summary's action slot; these assertions hold the cast
 * flow to the same place, and hold the injection and the post-roll cleanup to
 * the same class so they cannot drift apart.
 *
 * Source-grep, matching the convention used by lootNotTargetable.test.mjs and
 * rideAction.test.mjs — the injection lives inside a `renderChatMessageHTML`
 * hook with far too much Foundry around it to instantiate honestly here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const castSrc  = readFileSync(new URL("./castDamage.mjs", import.meta.url), "utf8");
const meleeSrc = readFileSync(new URL("../documents/mixins/weaponAttackMixin.mjs", import.meta.url), "utf8");
const cssSrc   = readFileSync(new URL("../../styles/base.css", import.meta.url), "utf8");

test("the cast damage button targets the collapsed card's summary", () => {
    assert.match(castSrc, /details\.wdm-attack-card > summary\.wdm-attack-card-summary/);
    assert.match(castSrc, /wdm-card-sum-action/);
});

test("the head is only a FALLBACK, for a card nothing has wrapped yet", () => {
    const summaryAt = castSrc.indexOf("summary.wdm-attack-card-summary");
    const headAt    = castSrc.indexOf('querySelector(".wdm-cast-head")');
    assert.ok(summaryAt > 0 && headAt > 0, "both branches must exist");
    assert.ok(summaryAt < headAt,
        "the summary branch has to be tried first — otherwise the button lands in the collapsed body again");
});

test("the injected button carries the class the strip removes", () => {
    /* Injection and cleanup agree, or a spent button survives a re-render. */
    assert.match(castSrc, /btn\.classList\.add\("wdm-card-sum-roll"\)/);
    assert.match(castSrc, /querySelectorAll\("\.wdm-card-sum-roll"\)\.forEach\(n => n\.remove\(\)\)/);
});

test("the click is stopped from toggling the card it now sits on", () => {
    /* A button inside <summary> would otherwise open/close the details on
     * every click. Melee relies on the same stopPropagation. */
    assert.match(castSrc, /ev\.stopPropagation\(\)/);
    assert.match(meleeSrc, /e\.stopPropagation\(\);\s*\n\s*\/\* Don't preventDefault/);
});

test("the header slot is styled — the button is not landing somewhere blind", () => {
    assert.match(cssSrc, /details\.wdm-attack-card > summary \.wdm-card-sum-action button/);
});
