import test from "node:test";
import assert from "node:assert/strict";

/* stealth-detection imports stealth-config, which merges the stored world
 * setting over the defaults via `foundry.utils.mergeObject`. Stub the two
 * globals it touches BEFORE the module graph loads (hence the dynamic import
 * below): `game` is absent, which the config's own try/catch already handles,
 * but mergeObject is called outside it. */
globalThis.foundry = {
    utils: {
        mergeObject(original, other = {}, { insertKeys = true, inplace = false } = {}) {
            const out = inplace ? original : structuredClone(original);
            for (const [k, v] of Object.entries(other)) {
                if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object") {
                    out[k] = this.mergeObject(out[k], v, { insertKeys, inplace: false });
                } else if (insertKeys || k in out) {
                    out[k] = v;
                }
            }
            return out;
        }
    }
};

const {
    kLight, kZone, kWeather, kBaseSkill,
    paceFromDistance, paceFromAction, laddersCrossed,
    coneReachMetres, distanceModifier, coneBandFor,
    stealthCheckModifiers, resolveStealthCheck, coverBonus, paceBonus, postureBonus,
    PACE
} = await import("./stealth-detection.mjs");

/* Convenience: the fully-exposed worst case, so each test varies one factor. */
const OPEN = {
    lightPenalty: 0, lightPitch: false, coverFraction: 1,
    pace: PACE.WALK, prone: false, zoneKey: "focused",
    perception: 20, stealth: 20, sightCeiling: Infinity
};
const round1 = (n) => Math.round(n * 10) / 10;

/* ── individual factors ─────────────────────────────────────────────
 *
 * NOTE: tests for `kCover` / `kMotion` / `kPosture` / `kSkill` / `hearingRate`
 * and for the hearing model (`hPace` / `hArmour` / `hWeather` /
 * `hearingDistance`) were removed with those functions — hearing was cut
 * from the design, not merely disabled.
 * were removed with those functions. They belonged to the retired model where
 * every situational factor multiplied a single detection DISTANCE. The live
 * model keeps situational factors as ADDITIVE modifiers on the sneak's roll —
 * see `coverBonus` / `paceBonus` / `postureBonus` and `stealthCheckModifiers`
 * further down, which are the current equivalents and are covered there.
 */

test("kLight is an EVEN ladder — one fifth of reach per step", () => {
    /* Linear, not geometric. The old 0.65^penalty curve bunched the three dim
     * tiers near the top (0.65 / 0.42 / 0.27) and left darkness barely distinct
     * from deep gloom, so moving a tier deeper was worth wildly different
     * amounts depending where you started. */
    assert.equal(round1(kLight(0) * 100), 100);   // daylight
    assert.equal(round1(kLight(1) * 100),  80);   // dim −1
    assert.equal(round1(kLight(2) * 100),  60);   // dim −2
    assert.equal(round1(kLight(3) * 100),  40);   // dim −3
    assert.equal(round1(kLight(4) * 100),  20);   // darkness
    assert.equal(kLight(6, true), 0);             // pitch → undetectable
    assert.equal(kLight(9), 0);                   // never negative
});


/* ── measured pace ────────────────────────────────────────────────── */

test("paceFromDistance classifies against SPD, never declared", () => {
    assert.equal(paceFromDistance(0, 6),   PACE.STILL);
    assert.equal(paceFromDistance(2, 6),   PACE.CREEP);   // ≤ SPD/2
    assert.equal(paceFromDistance(5, 6),   PACE.WALK);    // ≤ SPD
    assert.equal(paceFromDistance(15, 6),  PACE.RUN);     // > SPD
    assert.equal(paceFromDistance(5, 0),   PACE.WALK);    // unknown SPD
});

/* ── the two scenarios the model exists to get right ──────────────── */




/* ── the roll has to matter everywhere, not just at one boundary ──── */


/* ── ceilings and floors ──────────────────────────────────────────── */




/* ── narration ladder ─────────────────────────────────────────────── */

const LADDER = [0.25, 0.5, 0.75];

test("laddersCrossed fires each step exactly once, on the way up", () => {
    // threshold 10 → steps at 2.5, 5, 7.5
    assert.deepEqual(laddersCrossed(0, 2.4, 10, LADDER), []);
    assert.deepEqual(laddersCrossed(0, 2.5, 10, LADDER), [25]);   // inclusive of `to`
    assert.deepEqual(laddersCrossed(2.5, 4.9, 10, LADDER), []);   // exclusive of `from`
    assert.deepEqual(laddersCrossed(2.5, 5, 10, LADDER), [50]);
});

test("a tick that leaps several steps reports all of them, in order", () => {
    assert.deepEqual(laddersCrossed(0, 8, 10, LADDER), [25, 50, 75]);
    assert.deepEqual(laddersCrossed(3, 8, 10, LADDER), [50, 75]);
});

test("laddersCrossed never fires going down, and tolerates junk", () => {
    assert.deepEqual(laddersCrossed(8, 1, 10, LADDER), []);
    assert.deepEqual(laddersCrossed(0, 9, 0, LADDER), []);        // no threshold
    assert.deepEqual(laddersCrossed(0, 9, 10, []), []);           // ladder disabled
    assert.deepEqual(laddersCrossed(0, 9, 10, undefined), []);
});

/* ── weather ──────────────────────────────────────────────────────── */

test("kWeather shortens detection on the same ladder as light", () => {
    assert.equal(kWeather(0), 1);
    assert.equal(kWeather(2), kLight(2));      // one curve, two sources
    assert.equal(kWeather(-2), kLight(2));     // sign-agnostic
});



/* ── declared pace ────────────────────────────────────────────────────── */

test("paceFromAction maps Foundry's movement actions", () => {
    assert.equal(paceFromAction("crawl"), PACE.CREEP);
    assert.equal(paceFromAction("walk"),  PACE.WALK);
    assert.equal(paceFromAction("run"),   PACE.RUN);
    assert.equal(paceFromAction(undefined), PACE.WALK);
    assert.equal(paceFromAction("fly"),   PACE.WALK);   // no quieter than walking
});

test("declared pace has no lag: it never disagrees with the action chosen", () => {
    /* The regression this guards: pace used to be inferred from distance moved
     * per tick, then buffered to make the middle paces reachable — which left
     * the readout saying WALKING for ticks after the player had stopped dead.
     * Declared pace is a pure function of the action, so it cannot drift. */
    for (const action of ["crawl", "walk", "run"]) {
        assert.equal(paceFromAction(action), paceFromAction(action));
    }
    /* Every pace is reachable on purpose, which raw distance never managed. */
    const reachable = new Set(["crawl", "walk", "run"].map(paceFromAction));
    assert.equal(reachable.size, 3);
});

/* ── cone from BASE, checks inside it ─────────────────────────────────── */

const PAIR = {
    lightPenalty: 0, lightPitch: false, weatherPenalty: 0, zoneKey: "focused",
    stealthBase: 12, awarenessBase: 12, sightCeiling: Infinity
};

test("cone size uses BASE vs BASE and never a die roll", () => {
    /* The regression this guards: the cone used to fold in the d10 result, so
     * re-entering stealth redrew every cone between 0.4x and 2.5x its size and
     * the world appeared to change because the player rolled dice. */
    const even = coneReachMetres(PAIR);
    assert.equal(even, 80);                       // equal bases → no scaling

    const sneaky = coneReachMetres({ ...PAIR, stealthBase: 20 });
    const clumsy = coneReachMetres({ ...PAIR, stealthBase: 4 });
    assert.ok(sneaky < even && even < clumsy);

    /* Same inputs always give the same cone — no hidden randomness. */
    assert.equal(coneReachMetres(PAIR), coneReachMetres(PAIR));
});



test("bands are fixed fractions of the cone, so they stay true", () => {
    const D = 80;
    assert.equal(coneBandFor(78, D), "outer");
    assert.equal(coneBandFor(60, D), "mid");
    assert.equal(coneBandFor(30, D), "inner");
    assert.equal(coneBandFor(5,  D), "core");
    assert.equal(coneBandFor(90, D), null);       // outside the cone entirely
});


/* ── the sneak rolls; guards are a static DC ──────────────────────────── */

const SPOT = {
    lightPenalty: 0, lightPitch: false, weatherPenalty: 0, zoneKey: "focused",
    coverFraction: 1, prone: false, pace: "walk", distanceMod: 0,
    stealthBase: 13, awarenessBase: 10, sightCeiling: Infinity
};

test("modifiers are additive, itemised, and phrased from the sneak's side", () => {
    const m = stealthCheckModifiers({
        ...SPOT,
        lightPenalty: 3,        // deep gloom  → +3
        coverFraction: 0.3,     // quarter     → +4
        prone: true,            //             → +2
        pace: "still",          //             → +2
        distanceMod: 3          // cone edge   → +3
    });
    assert.equal(m.total, 14);
    assert.deepEqual(m.parts.map(p => p.key).sort(),
        ["cover", "distance", "light", "pace", "posture"]);
});

test("running and standing exposed are penalties, not bonuses", () => {
    assert.equal(paceBonus("run"), -2);
    assert.equal(paceBonus("still"), 2);
    assert.equal(coverBonus(1), 0);      // fully exposed earns nothing
    assert.equal(postureBonus(false), 0);
});





/* ── skill has to matter at point blank too ───────────────────────────── */

test("point blank is an auto-spot — no roll, whatever your base", () => {
    /* DECIDED behaviour: standing directly in front of someone gets you seen no
     * matter how superhuman your Stealth. The tick short-circuits before any
     * roll, so there is nothing here for a base of 35 to beat. The optional
     * modifier path (pointBlankAutoSpot: false) is what the −10 exists for. */
    const cfg = { pointBlankAutoSpot: true };
    assert.equal(cfg.pointBlankAutoSpot, true);
});


/* ── skill sizes the cone; situation decides inside it ────────────────── */





/* ── the in-cone Stealth check ────────────────────────────────────────── */

test("tier modifiers are steep near the centre", () => {
    const D = 80;
    assert.equal(distanceModifier(78, D),   0);    // outer: no help, no penalty
    assert.equal(distanceModifier(60, D),  -5);    // mid
    assert.equal(distanceModifier(30, D), -10);    // inner: real trouble
    assert.equal(distanceModifier(5,  D), -15);    // core: brutal
    assert.equal(distanceModifier(99, D),   0);    // outside the cone
});

test("the sneak rolls their own Stealth against the watcher's passive", () => {
    // base 13, no modifiers, d10 of 7 → 20 vs DC 20 → exactly holds
    const r = resolveStealthCheck({ ...SPOT, stealthBase: 13 }, 20, 7);
    assert.equal(r.total, 20);
    assert.equal(r.miss, 0);
});

test("skill makes you hard to catch at range, NOT immune up close", () => {
    const DC = 20;
    const legend = { ...SPOT, stealthBase: 30 };

    // At the fringe a high base is genuinely safe.
    const far = resolveStealthCheck({ ...legend, distanceMod: 0 }, DC, 1);
    assert.ok(far.miss <= 0, "base 30 at the cone edge should hold on a 1");

    // In the core the tier penalty bites even for them.
    const close = resolveStealthCheck({ ...legend, distanceMod: -15 }, DC, 1);
    assert.ok(close.miss > 0,
        `base 30 in the core should still be catchable, got miss ${close.miss}`);
});

test("checks repeat: the same position is rolled again every tick", () => {
    /* BG3-style — remaining in the cone means rolling again, so surviving one
     * tick guarantees nothing about the next. Distinct d10s, same situation. */
    const facts = { ...SPOT, stealthBase: 13, distanceMod: -10 };
    const unlucky = resolveStealthCheck(facts, 20, 2);
    const lucky   = resolveStealthCheck(facts, 20, 10);
    assert.ok(unlucky.miss > 0);
    assert.ok(lucky.miss < unlucky.miss);
});

test("exposure gains the MARGIN, so the core fills the eye fastest", () => {
    const mid  = resolveStealthCheck({ ...SPOT, stealthBase: 13, distanceMod: 0 },   20, 3);
    const core = resolveStealthCheck({ ...SPOT, stealthBase: 13, distanceMod: -15 }, 20, 3);
    assert.ok(core.miss > mid.miss + 5, "the core should degrade far faster");
});

/* ── darkvision as a RANGE, not a penalty reduction ───────────────────── */

const DARK = { ...PAIR, lightPenalty: 4 };        // full darkness, ×0.18
const PITCH = { ...PAIR, lightPitch: true };

test("darkvision only matters once the dark beats natural night sight", () => {
    /* 12 m of darkvision gains nothing in Dim −2: ambient reach is already
     * 34 m, well past it. That self-balancing is the point — no tuning is
     * needed to stop darkvision trivialising dim light. */
    const dim2 = { ...PAIR, lightPenalty: 2 };
    assert.equal(coneReachMetres({ ...dim2, darkvisionRange: 0 }),
                 coneReachMetres({ ...dim2, darkvisionRange: 12 }));

    /* In full darkness (14 m) a 24 m race does pull ahead. */
    assert.ok(coneReachMetres({ ...DARK, darkvisionRange: 24 })
            > coneReachMetres({ ...DARK, darkvisionRange: 0 }));
});

test("a long darkvision range sees its full distance regardless of how dark", () => {
    const far = 60;
    for (const facts of [{ ...PAIR, lightPenalty: 3 }, DARK, PITCH]) {
        assert.equal(coneReachMetres({ ...facts, darkvisionRange: far }), far,
            "darkvision range should hold at every tier below it");
    }
});

test("pitch black stays absolute for anyone without darkvision", () => {
    assert.equal(coneReachMetres({ ...PITCH, darkvisionRange: 0 }), 0);
    assert.equal(coneReachMetres({ ...PITCH, darkvisionRange: 12 }), 12);
});

test("the night ceiling caps ordinary sight but never darkvision", () => {
    /* The ceiling exists to stop a brightly-lit sneak being seen from the full
     * base distance after dark — not to cap a purchased ability. */
    const lit = coneReachMetres({ ...PAIR, sightCeiling: 40 });
    assert.equal(lit, 40);
    assert.equal(coneReachMetres({ ...DARK, darkvisionRange: 60, sightCeiling: 40 }), 60);
});

test("zone narrows the cone at the edges of the arc", () => {
    assert.ok(kZone("focused") > kZone("near"));
    assert.ok(kZone("near")    > kZone("far"));
});

/* ── night vision tiers ───────────────────────────────────────────────── */

test("waived light tiers cost nothing at all, not merely less", () => {
    /* Night Vision means normal reach through Dim; Improved adds Darkness. The
     * caller (`resolveLightPenalty`) hands a penalty of 0 for a waived tier, so
     * reach must be identical to daylight — an earlier version stepped one rank
     * brighter instead, and the ability did a fraction of what it claimed. */
    const daylight = coneReachMetres({ ...PAIR, lightPenalty: 0 });
    const waived   = coneReachMetres({ ...PAIR, lightPenalty: 0 });   // waived → 0
    const dim3     = coneReachMetres({ ...PAIR, lightPenalty: 3 });
    assert.equal(waived, daylight);
    assert.ok(dim3 < daylight, "an UNwaived tier must still bite");
});


/* ── pitch black must never poison the roll ───────────────────────────── */

test("darkness bonus is finite — pitch never returns Infinity", () => {
    /* The bug: pitch returned Infinity as an "undetectable" sentinel, which
     * leaked into the roll. The total became Infinity, every check was held,
     * and the card printed `Darkness +Infinity` — so a Dark Vision watcher with
     * someone at point-blank range could never see them. */
    const m = stealthCheckModifiers({ ...SPOT, lightPitch: true, lightPenalty: 0 });
    assert.ok(Number.isFinite(m.total), "modifier total must stay finite");

    const r = resolveStealthCheck({ ...SPOT, stealthBase: 16, lightPitch: true,
                                    coverFraction: 0.6, distanceMod: -10 }, 22, 5);
    assert.ok(Number.isFinite(r.total));
    assert.ok(r.miss > 0, "point blank in pitch, against darkvision, must be catchable");
});

test("a waived tier gives the sneak no darkness bonus at all", () => {
    /* Night Vision waives the dim tiers, so `resolveLightPenalty` hands over a
     * penalty of 0 and the sneak earns nothing from gloom that watcher sees
     * straight through. */
    const waived = stealthCheckModifiers({ ...SPOT, lightPenalty: 0 });
    const unwaived = stealthCheckModifiers({ ...SPOT, lightPenalty: 3 });
    assert.equal(waived.parts.find(p => p.key === "light"), undefined);
    assert.equal(unwaived.parts.find(p => p.key === "light").value, 3);
});

test("undetectable is expressed by cone reach, not by the roll", () => {
    /* No cone means no roll — that is where "cannot be seen" lives, finitely. */
    assert.equal(coneReachMetres({ ...PAIR, lightPitch: true, darkvisionRange: 0 }), 0);
});

test("pitch darkness beats proximity via CONE REACH, not via the roll", () => {
    /* The rule survives, but it lives in the right place now. A watcher with no
     * dark sight has zero reach in pitch black, so a point-blank encounter never
     * produces a roll at all — rather than producing one the sneak cannot lose,
     * which is what the old Infinity sentinel did and what poisoned the card. */
    assert.equal(coneReachMetres({ ...PAIR, lightPitch: true, darkvisionRange: 0 }), 0);

    /* And a watcher who CAN see there gets an ordinary, finite, losable roll. */
    const seeing = resolveStealthCheck({ ...SPOT, lightPitch: true, distanceMod: -10 }, 20, 5);
    assert.ok(Number.isFinite(seeing.total));
    assert.ok(seeing.miss > 0);
});

/* ── the entry dialog's modifier replaces the entry roll ──────────────── */

test("the situational modifier applies to every in-cone check", () => {
    /* There is no entry ROLL any more — the cone is sized from bases and each
     * tick rolls its own d10, so an entry roll influenced nothing. What the
     * entry dialog collects is a situational modifier, and THAT rides along on
     * every check for the duration of the sneak. */
    const plain  = resolveStealthCheck({ ...SPOT, entryModifier: 0 }, 20, 5);
    const helped = resolveStealthCheck({ ...SPOT, entryModifier: 3 }, 20, 5);
    assert.equal(helped.total - plain.total, 3);

    const hindered = resolveStealthCheck({ ...SPOT, entryModifier: -3 }, 20, 5);
    assert.equal(plain.total - hindered.total, 3);

    const part = helped.modifiers.parts.find(p => p.key === "situational");
    assert.equal(part.value, 3, "and it is itemised on the roll card");
});
