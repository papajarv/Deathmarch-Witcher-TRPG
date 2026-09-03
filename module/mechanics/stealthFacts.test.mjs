/**
 * Smoke test for the detection FACT BUILDERS.
 *
 * These run on every tick inside a try/catch, so a ReferenceError in one of
 * them is completely silent: the cones keep drawing (the overlay builds its
 * own facts) while no check ever fires. That failure shipped once —
 * `gatherDetectionFacts` was left referencing `darkSight` and `ceiling`, two
 * locals belonging to `coneReachFor`, after a find-and-replace matched the
 * wrong function. `node --check` passes on that; only calling it catches it.
 *
 * The assertions are deliberately shallow. The point is not to pin down the
 * numbers — `stealthDetection.test.mjs` covers the model — it is to prove the
 * builders EXECUTE and return the fields the tick reads.
 */
import test from "node:test";
import assert from "node:assert/strict";

globalThis.foundry = { utils: { mergeObject(o, x = {}) {
    const out = structuredClone(o);
    for (const [k, v] of Object.entries(x)) {
        out[k] = (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object")
            ? this.mergeObject(out[k], v) : v;
    }
    return out;
} } };
globalThis.foundry.data        = { CalendarData: class {}, fields: new Proxy({}, { get: () => class {} }) };
globalThis.foundry.abstract    = { TypeDataModel: class {}, DataModel: class {} };
globalThis.foundry.applications = { api: {}, sheets: {} };
globalThis.Hooks  = { on() {}, once() {}, callAll() {} };
globalThis.game   = { settings: { get: () => ({}) }, i18n: { localize: s => s, format: s => s }, user: {} };
globalThis.canvas = null;          /* no scene: every canvas read must stay optional */
globalThis.CONFIG = {};
globalThis.ui     = { notifications: { warn() {}, info() {} } };

const { gatherDetectionFacts, coneReachFor, bodyProbesFor,
        isEligibleSpotterToken } = await import("./stealth-hooks.mjs");

function mkToken({ id = "t", uuid = "Actor.a", sightRange = 30 } = {}) {
    return {
        id,
        center: { x: 0, y: 0 },
        document: {
            x: 0, y: 0, rotation: 0, elevation: 0,
            sight: { angle: 120, range: sightRange, visionMode: "basic" },
            light: { bright: 0, dim: 0 },
            getFlag: () => undefined
        },
        actor: {
            uuid, statuses: new Set(), getFlag: () => undefined,
            system: {
                stats:  { int: { value: 6 }, dex: { value: 6 } },
                skills: { int: { awareness: { value: 4 } }, dex: { stealth: { value: 4 } } },
                armorEV: 0
            }
        }
    };
}

test("gatherDetectionFacts executes and returns every field the tick reads", () => {
    const facts = gatherDetectionFacts(
        mkToken({ id: "sp" }), mkToken({ id: "st", uuid: "Actor.b" }),
        null, { skipCoverage: true });

    /* The tick reads all of these; any one missing silently disables detection. */
    for (const key of ["lightPenalty", "lightPitch", "weatherPenalty", "coverFraction",
                       "pace", "prone", "perception", "entryModifier",
                       "awarenessBase", "stealthBase", "darkvisionRange", "sightCeiling"]) {
        assert.ok(key in facts, `facts is missing "${key}"`);
    }
    assert.equal(typeof facts.darkvisionRange, "number");
    assert.ok(Number.isFinite(facts.darkvisionRange), "darkvisionRange must be finite");
    assert.equal(typeof facts.sightCeiling, "number");
    assert.ok(Number.isFinite(facts.awarenessBase) && facts.awarenessBase > 0);
    assert.ok(Number.isFinite(facts.stealthBase) && facts.stealthBase > 0);
});

test("coneReachFor executes and its facts carry the same shape", () => {
    /* Exercises the per-refresh memo path too — the memo maps are what the
     * mis-targeted replacement was introducing when it broke the other builder. */
    const memo = { light: new Map(), weather: new Map(),
                   perceive: new Map(), ceiling: new Map(), darkSight: new Map() };
    const r = coneReachFor(mkToken({ id: "sp" }), mkToken({ id: "st", uuid: "Actor.b" }), memo);
    assert.ok(r && typeof r === "object");
    if (r.facts) {
        assert.equal(typeof r.facts.darkvisionRange, "number");
        assert.equal(typeof r.facts.awarenessBase, "number");
        assert.equal(typeof r.facts.stealthBase, "number");
    }
    assert.equal(typeof r.D, "number");
});

test("bodyProbesFor returns the silhouette probe set", () => {
    /* Guards the module-scope SAMPLE_OFFSETS hoist. When those offsets lived
     * inside computeCoverageFraction, referencing them from here was a
     * ReferenceError — the same silent, caught-and-swallowed failure mode that
     * once disabled detection entirely while cones kept drawing. */
    const pts = bodyProbesFor(mkToken({ id: "st" }));
    assert.ok(Array.isArray(pts), "must return an array");
    assert.equal(pts.length, 29, "7x7 grid clipped to the inscribed ellipse = 29 probes");
    for (const pt of pts) {
        assert.ok(Number.isFinite(pt.x) && Number.isFinite(pt.y), "probe coords must be finite");
    }
});

test("isEligibleSpotterToken is the single eligibility rule", () => {
    /* FRIENDLY must be eligible: the overlay and the mechanic disagreed about
     * this once, so allies drew cones that could never roll. */
    const t = mkToken({ id: "sp" });
    for (const disp of [-2, -1, 0, 1]) {
        t.document.disposition = disp;
        assert.equal(isEligibleSpotterToken(t), true, `disposition ${disp} should be eligible`);
    }
    t.document.disposition = 0;
    /* A token, not an actor — the dead check must read through to the actor. */
    t.actor.statuses = new Set(["dead"]);
    assert.equal(isEligibleSpotterToken(t), false, "a corpse must not keep watch");
});
