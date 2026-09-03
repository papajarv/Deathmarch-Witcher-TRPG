import test from "node:test";
import assert from "node:assert/strict";
import {
    layerSpBonus, combineTwoLayers, combineLayeredSP,
    combineTwoLayersCE, combineLayeredSPCE, combineLayeredSPFor,
    zonesCovered, layeringEvSurcharge, layeringLimitViolations, layeringReadout
} from "./armorLayering.mjs";

/* ── SP buffer table (Core p.155) ─────────────────────────────────── */
test("layerSpBonus reads the RAW difference table (with >20 extrapolation)", () => {
    assert.equal(layerSpBonus(0), 5);
    assert.equal(layerSpBonus(4), 5);
    assert.equal(layerSpBonus(5), 4);
    assert.equal(layerSpBonus(8), 4);
    assert.equal(layerSpBonus(9), 3);
    assert.equal(layerSpBonus(14), 3);
    assert.equal(layerSpBonus(15), 2);
    assert.equal(layerSpBonus(20), 2);
    assert.equal(layerSpBonus(21), 1);   // extrapolated past the printed table
});

test("combineTwoLayers = stronger + min(weaker, tableBonus(diff))", () => {
    // plate 15 over gambeson 5: diff 10 → +3, weaker 5 > 3 → +3 → 18
    assert.equal(combineTwoLayers(15, 5), 18);
    assert.equal(combineTwoLayers(5, 15), 18);        // order-independent
    // 10 vs 8: diff 2 → +5, weaker 8 > 5 → +5 → 15
    assert.equal(combineTwoLayers(10, 8), 15);
    // 10 vs 2: diff 8 → +4, but weaker only 2 → capped at 2 → 12
    assert.equal(combineTwoLayers(10, 2), 12);
    // a zero/negative layer adds nothing
    assert.equal(combineTwoLayers(7, 0), 7);
});

test("combineLayeredSP folds three layers weakest-first (RAW p.155)", () => {
    assert.equal(combineLayeredSP([]), 0);
    assert.equal(combineLayeredSP([9]), 9);
    // [5,5,15] weakest-first: combine(5,5) diff 0 → +5 cap, min(5,5)=+5 → 10,
    // then combine(10,15) diff 5 → +4 cap, min(10,4)=+4 → 19
    assert.equal(combineLayeredSP([15, 5, 5]), 19);
    assert.equal(combineLayeredSP([5, 15, 5]), 19);   // input order doesn't matter (sorted)
    // worked example: [5,10,15] → combine(5,10)=14, combine(14,15)=20
    assert.equal(combineLayeredSP([5, 10, 15]), 20);
    // never LESS than the strongest single layer
    assert.ok(combineLayeredSP([12, 1, 1]) >= 12);
});

/* ── Combat Extended model ────────────────────────────────────────── */
test("CE combine: stronger + floor(weaker/4), folded weakest-first", () => {
    assert.equal(combineTwoLayersCE(6, 16), 17);   // 16 + floor(6/4)=1
    assert.equal(combineTwoLayersCE(16, 6), 17);   // order-agnostic per pair
    assert.equal(combineTwoLayersCE(24, 0), 24);   // a zero layer adds nothing
    // [6,16,24]: (6,16)->17, then (17,24)-> 24 + floor(17/4)=4 -> 28
    assert.equal(combineLayeredSPCE([6, 16, 24]), 28);
    assert.equal(combineLayeredSPCE([24, 6, 16]), 28);   // input order doesn't matter
    assert.equal(combineLayeredSPCE([]), 0);
    assert.equal(combineLayeredSPCE([9]), 9);
});

test("combineLayeredSPFor dispatches RAW vs CE by model flag", () => {
    assert.equal(combineLayeredSPFor([6, 16, 24], true),  28);                        // CE
    assert.equal(combineLayeredSPFor([6, 16, 24], false), combineLayeredSP([6, 16, 24])); // RAW (=20)
});

/* ── Zone coverage ────────────────────────────────────────────────── */
test("zonesCovered maps the location enum to body zones", () => {
    assert.deepEqual(zonesCovered("torso"), ["torso"]);
    assert.deepEqual(zonesCovered("full"), ["head", "torso", "arms", "legs"]);
    assert.deepEqual(zonesCovered("Shield"), []);   // shields don't layer as armor
    assert.deepEqual(zonesCovered(""), []);
});

/* ── EV surcharge: only for actually-layered pieces ───────────────── */
/* Build a fake armor piece with SP on the fine slots its `location` covers.
 * `maxSp` (default 5) sets {slot}MaxStopping → drives LAYER MEMBERSHIP;
 * `curSp` (default maxSp) sets {slot}Stopping → drives the SP combination.
 * maxSp=0 → not a layer (clothes); maxSp>0 & curSp=0 → ablated, still a layer. */
const SLOTS_FOR = {
    head:  ["head"],
    torso: ["torso"],
    arms:  ["leftArm", "rightArm"],
    legs:  ["leftLeg", "rightLeg"],
    full:  ["head", "torso", "leftArm", "rightArm", "leftLeg", "rightLeg"]
};
const armor = (armorType, location, maxSp = 5, curSp = maxSp, qualities = []) => {
    const system = { armorType, location, qualities };
    for (const s of (SLOTS_FOR[location] || [])) {
        system[`${s}Stopping`]    = curSp;
        system[`${s}MaxStopping`] = maxSp;
    }
    return { system };
};

test("layeringEvSurcharge charges nothing for a lone / non-overlapping piece", () => {
    assert.equal(layeringEvSurcharge([armor("heavy", "torso")]), 0);
    // heavy torso + heavy legs never share a zone → no surcharge
    assert.equal(layeringEvSurcharge([armor("heavy", "torso"), armor("heavy", "legs")]), 0);
});

test("layeringEvSurcharge adds +1/medium +2/heavy for overlapping pieces", () => {
    // medium + heavy both on torso: layered → +1 +2 = +3
    assert.equal(layeringEvSurcharge([armor("medium", "torso"), armor("heavy", "torso")]), 3);
    // light layers add no surcharge even when layered
    assert.equal(layeringEvSurcharge([armor("light", "torso"), armor("light", "torso")]), 0);
    // a full heavy over a full medium overlap on every zone → +2 +1, counted once each
    assert.equal(layeringEvSurcharge([armor("heavy", "full"), armor("medium", "full")]), 3);
});

test("a 0-MAX-SP piece does NOT count as a layer (clothes)", () => {
    // heavy torso + a 0-max 'clothes' torso piece → only one real layer → no surcharge
    assert.equal(layeringEvSurcharge([armor("heavy", "torso"), armor("light", "torso", 0)]), 0);
    // and the 0-max piece doesn't consume a stacking slot / doesn't layer in the readout
    assert.deepEqual(layeringReadout([armor("heavy", "torso"), armor("light", "torso", 0)]).zones, []);
    assert.deepEqual(
        layeringLimitViolations(armor("light", "torso"), [armor("heavy", "torso"), armor("light", "torso", 0)]),
        []   // real layers = heavy + candidate = 2, legal
    );
});

test("an ablated layer (0 current SP but MAX SP > 0) still counts as a layer", () => {
    const ablated = armor("medium", "torso", 4, 0);   // max 4, current 0 (fully chipped)
    // still layers with the heavy → EV surcharge +2 +1 = 3
    assert.equal(layeringEvSurcharge([armor("heavy", "torso", 10), ablated]), 3);
    const r = layeringReadout([armor("heavy", "torso", 10), ablated]);
    assert.equal(r.zones[0].count, 2);          // both count as layers (membership = max SP)
    assert.equal(r.zones[0].combinedSP, 10);    // ablated adds 0 to CURRENT protection
    assert.equal(r.zones[0].bonusSP, 0);
    // and it fills a stacking slot: candidate would be the 3rd real layer here
    assert.deepEqual(
        layeringLimitViolations(armor("light", "torso"), [armor("heavy", "torso", 10), ablated, armor("light", "torso")]).map(v => v.kind),
        ["maxLayers"]
    );
});

/* ── Stacking limits ──────────────────────────────────────────────── */
test("layeringLimitViolations flags 4th layer and 2nd heavy/medium per zone", () => {
    const torsoHeavy  = armor("heavy", "torso");
    const torsoMedium = armor("medium", "torso");
    const torsoLight  = armor("light", "torso");

    assert.deepEqual(layeringLimitViolations(torsoLight, [torsoHeavy, torsoMedium]), []); // 3rd, legal
    assert.deepEqual(
        layeringLimitViolations(torsoLight, [torsoHeavy, torsoMedium, torsoLight]).map(v => v.kind),
        ["maxLayers"]
    );
    assert.deepEqual(
        layeringLimitViolations(armor("heavy", "torso"), [torsoHeavy]).map(v => v.kind),
        ["secondHeavy"]
    );
    assert.deepEqual(
        layeringLimitViolations(armor("medium", "full"), [armor("medium", "torso")]).map(v => v.kind),
        ["secondMedium"]
    );
    // non-overlapping zones never conflict
    assert.deepEqual(layeringLimitViolations(armor("heavy", "legs"), [torsoHeavy]), []);
});

test("stifling armor can't layer with another stifling armor (both models)", () => {
    // different armor types so ONLY the stifling rule fires (not secondMedium etc.)
    const stiffMed   = () => armor("medium", "torso", 5, 5, ["stifling"]);
    const stiffLight = () => armor("light",  "torso", 5, 5, ["stifling"]);
    assert.deepEqual(layeringLimitViolations(stiffMed(), [stiffLight()]).map(v => v.kind), ["twoStifling"]);
    assert.deepEqual(layeringLimitViolations(stiffMed(), [stiffLight()], { ceModel: true }).map(v => v.kind), ["twoStifling"]);
    // stifling over a plain (non-stifling) piece → no stifling violation
    assert.deepEqual(
        layeringLimitViolations(stiffMed(), [armor("light", "torso")]).filter(v => v.kind === "twoStifling"), []);
    // under CE the count/type caps are suppressed, but stifling still fires
    assert.deepEqual(
        layeringLimitViolations(stiffMed(), [stiffLight(), armor("light", "torso"), armor("light", "torso")], { ceModel: true })
            .map(v => v.kind),
        ["twoStifling"]);
});

test("layeringReadout flags a twoStifling zone (both models)", () => {
    const stack = [armor("medium", "torso", 5, 5, ["stifling"]), armor("light", "torso", 5, 5, ["stifling"])];
    assert.equal(layeringReadout(stack, { ceModel: true }).zones[0].twoStifling, true);
    assert.equal(layeringReadout(stack).zones[0].twoStifling, true);
});

/* ── Inventory readout ────────────────────────────────────────────── */
test("layeringReadout reports layered zones with SP bonus + EV surcharge", () => {
    // torso: heavy SP 15 over medium SP 5 → combined 18, bonus 3; EV +2 +1 = 3
    const r = layeringReadout([armor("heavy", "torso", 15), armor("medium", "torso", 5)]);
    assert.equal(r.evSurcharge, 3);
    assert.equal(r.zones.length, 1);
    const z = r.zones[0];
    assert.equal(z.zone, "torso");
    assert.equal(z.count, 2);
    assert.equal(z.combinedSP, 18);
    assert.equal(z.bonusSP, 3);
    assert.equal(z.secondHeavy, false);
});

test("layeringReadout ignores unlayered zones and flags over-cap / double-type", () => {
    // single torso piece → no layered zones, no surcharge
    assert.deepEqual(layeringReadout([armor("heavy", "torso", 10)]).zones, []);
    // two heavies + a light on torso → count 3, secondHeavy true
    const r = layeringReadout([
        armor("heavy", "torso", 10), armor("heavy", "torso", 8), armor("light", "torso", 2)
    ]);
    assert.equal(r.zones[0].count, 3);
    assert.equal(r.zones[0].secondHeavy, true);
    assert.equal(r.zones[0].overCap, false);   // 3 is the cap, not over
});

test("layeringReadout CE mode: CE combine, no EV surcharge, no limit flags", () => {
    const stack = [armor("heavy", "torso", 24), armor("medium", "torso", 16), armor("light", "torso", 6)];
    const r = layeringReadout(stack, { ceModel: true });
    assert.equal(r.ceModel, true);
    assert.equal(r.evSurcharge, 0);                 // RAW surcharge suppressed under CE
    const z = r.zones.find(z => z.zone === "torso");
    assert.equal(z.combinedSP, 28);                 // CE fold
    assert.equal(z.bonusSP, 4);                     // 28 − strongest 24
    assert.equal(z.overCap, false);                 // no type/count limits under CE
    assert.equal(z.secondHeavy, false);
    // same stack under RAW mode applies the surcharge (the clean RAW-only signal;
    // note the combined SP happens to coincide at 28 for 6/16/24)
    const raw = layeringReadout(stack, { ceModel: false });
    assert.ok(raw.evSurcharge > 0);
    // and the two models' combine functions genuinely differ on other inputs:
    assert.equal(combineLayeredSPCE([8, 8]), 10);   // 8 + floor(8/4)=2
    assert.equal(combineLayeredSP([8, 8]),   13);   // 8 + min(8, table(0)=5)=5
});
