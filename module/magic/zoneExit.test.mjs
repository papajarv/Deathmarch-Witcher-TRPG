/**
 * `untilExitZone` — eleven spells author it and nothing could fire it.
 *
 * Two separate faults stacked. It was not a member of `ENDS` at all, so
 * `track()` filed the effect with no scale and no condition anything could
 * match. And the zone layer, which DOES strip effects when a token walks out,
 * recognises its own by three flags — `zoneTemplate`, `zoneRiderMode`,
 * `zoneStripOnExit` — which nothing created by a zone's body ever carried.
 *
 * So the penalty for standing in a Yrden circle followed you out of it, for
 * the rest of the session.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENDS } from "./lifetimes.mjs";
import { deriveContext } from "./context.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const read = (f) => code(readFileSync(join(HERE, f), "utf8"));

test("untilExitZone is a real end condition", () => {
    assert.equal(ENDS.UNTIL_EXIT_ZONE, "untilExitZone");
});

test("every until: the corpus authors is a member of ENDS", async () => {
    const { CORPUS } = await import("./spells/corpus.mjs");
    const known = new Set(Object.values(ENDS));
    const bad = [];
    const walk = (body, spell, entry) => {
        for (const node of body ?? []) {
            for (const key of ["until", "endsOn", "alsoEndsOn"]) {
                const v = node?.a?.[key];
                for (const one of Array.isArray(v) ? v : v ? [v] : []) {
                    if (typeof one === "string" && !one.startsWith("{") && !known.has(one)) {
                        bad.push(`${spell}.${entry}: ${key} "${one}" is not in ENDS — nothing can ever fire it`);
                    }
                }
            }
            if (node.body) walk(node.body, spell, entry);
        }
    };
    for (const s of CORPUS) for (const [entry, body] of Object.entries(s.on ?? {})) walk(body, s.name, entry);
    assert.deepEqual(bad, [], "\n" + bad.join("\n"));
});

test("a body running because someone entered a zone knows which zone", () => {
    const base = { record: Object.freeze({ castId: "x", kind: "spell" }), vars: {},
                   control: { outcome: "success" }, targets: [], created: [] };
    const inside = deriveContext(base, { targets: [{ name: "Walker" }], zone: "Scene.a.Region.b" });
    assert.equal(inside.record.zoneTemplate, "Scene.a.Region.b");
    /* and a body NOT from a zone must not claim to be from one */
    const plain = deriveContext(base, { targets: [{ name: "Victim" }] });
    assert.equal(plain.record.zoneTemplate, undefined);
    assert.equal(plain.record, base.record, "a non-zone body should reuse the sealed record");
});

test("effects made inside a zone body carry the flags the zone layer strips on", () => {
    const ADAPTER = read("adapter.mjs");
    assert.match(ADAPTER, /zoneTemplate: record\.zoneTemplate/, "the template uuid is not stamped");
    assert.match(ADAPTER, /zoneRiderMode: "zone"/, "onZoneExit only strips riderMode 'zone'");
    assert.match(ADAPTER, /zoneStripOnExit: true/, "onZoneExit skips anything with stripOnExit false");

    /* and the zone layer really does match on exactly those three */
    const ZONE = code(readFileSync(join(HERE, "..", "mechanics", "zoneEffects.mjs"), "utf8"));
    assert.match(ZONE, /getFlag\(SYSTEM_ID, "zoneTemplate"\)/);
    assert.match(ZONE, /zoneRiderMode/);
    assert.match(ZONE, /zoneStripOnExit/);
});

test("createZone hands its identity to the body that runs on entry", () => {
    const SRC = read("blocks/effects.mjs");
    assert.match(SRC, /zone: placed\?\.template\?\.uuid/,
        "the entrant's body must be told which zone caught them");
});
