// module/magic/vocabulary.test.mjs
//
// EXECUTING test that the engine and the system speak the same language.
//
// This is the failure that keeps recurring, and it is always silent:
//
//   • the corpus said `rect` and `sphere`; the template layer knows `cube` and
//     `radius`, so four spells built no template and landed on NOBODY
//   • the corpus said `onFire`; the status registry says `burning`, so the GM
//     handler dropped it with a console line nobody reads
//   • `createZone` offered `point`; the aiming overlay knows `caster` and
//     `free`, and read anything else as "caster" — so a zone meant to sit
//     where you clicked appeared on top of the caster
//   • the sheet offers a `gm` defence and durations in months; the engine had
//     no idea, and turned the first into a skill nobody has and the second
//     into an effect that never ended
//
// Every one shipped, none threw, and each was found by somebody noticing a
// spell doing nothing. So the vocabularies are compared here instead.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { registerAll } from "./spells/harness.mjs";
import { CORPUS } from "./spells/corpus.mjs";
import { derive, shapeName } from "./legacyFrame.mjs";
import { getBlock, allBlocks } from "./registry.mjs";
import { ENDS } from "./lifetimes.mjs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const CONFIG_SRC = read("../setup/config.mjs");
const CAST_AREA  = read("../mechanics/castArea.mjs");

/** The keys of an `Object.freeze({...})` the system exports. */
function vocabulary(name) {
    const at = CONFIG_SRC.indexOf(`export const ${name}`);
    assert.ok(at > 0, `${name} is not in config.mjs — did it get renamed?`);
    const body = CONFIG_SRC.slice(at, CONFIG_SRC.indexOf("});", at));
    return new Set([...body.matchAll(/^\s{4}([\w-]+):/gm)].map(m => m[1]));
}

/** Every value the corpus uses for one block argument. */
function corpusValues(blockId, arg) {
    const out = new Set();
    const walk = (body) => (body ?? []).forEach(n => {
        if (n.b === blockId && n.a?.[arg] != null && n.a[arg] !== "") out.add(String(n.a[arg]));
        walk(n.body);
    });
    CORPUS.forEach(s => Object.values(s.on).forEach(walk));
    return out;
}

test.before(registerAll);

/* ── Shapes ──────────────────────────────────────────────────────────────── */

test("every shape the corpus uses can actually be drawn", () => {
    // `SHAPE_TO_FOUNDRY` is the map from a Witcher shape to a Foundry template
    // type. A shape missing from it produces no template, and no template
    // means no targets — silently.
    const block = CAST_AREA.slice(CAST_AREA.indexOf("SHAPE_TO_FOUNDRY = Object.freeze"));
    const placeable = new Set([...block.slice(0, block.indexOf("})")).matchAll(/(\w+):\s*"/g)].map(m => m[1]));
    assert.ok(placeable.size >= 4, `only ${placeable.size} placeable shapes found`);

    const used = new Set();
    for (const s of CORPUS) {
        if (s.frame.targeting?.mode === "area" && s.frame.targeting.shape) used.add(s.frame.targeting.shape);
    }
    for (const v of corpusValues("core:createZone", "shape")) used.add(v);

    const orphans = [...used].filter(sh => !placeable.has(sh));
    assert.deepEqual(orphans, [], `${orphans.join(", ")} cannot be drawn, so those spells hit nobody`);
});

test("the shape the sheet offers is the shape the engine keeps", () => {
    const offered = vocabulary("SPELL_AREA_SHAPES");
    for (const shape of offered) {
        if (shape === "none" || shape === "touch" || shape === "self") continue;
        const kept = derive({ targetType: "area", areaShape: shape }).targeting.shape;
        assert.ok(offered.has(kept) || kept === shapeName(shape),
            `picking "${shape}" on the sheet produces "${kept}", which is not a shape`);
    }
});

/* ── Anchors ─────────────────────────────────────────────────────────────── */

test("every anchor the corpus uses is one the aiming overlay understands", () => {
    // It reads anything it does not recognise as "caster", so a zone meant to
    // sit where you clicked lands on top of you instead.
    const known = vocabulary("SPELL_AREA_ANCHORS");
    const engineOnly = new Set(["object"]);   // handled by the adapter, not the overlay
    const used = corpusValues("core:createZone", "anchor");
    const orphans = [...used].filter(a => !known.has(a) && !engineOnly.has(a));
    assert.deepEqual(orphans, [], `${orphans.join(", ")} silently becomes "caster"`);
});

test("the anchors a block offers match the ones that exist", () => {
    const known = new Set([...vocabulary("SPELL_AREA_ANCHORS"), "object"]);
    const offered = getBlock("core:createZone").inputs.anchor.options;
    const orphans = offered.filter(a => a && !known.has(a));
    assert.deepEqual(orphans, [], `the block offers ${orphans.join(", ")}, which nothing implements`);
});

/* ── Defences ────────────────────────────────────────────────────────────── */

test("every defence key the sheet offers derives to something the frame runs", () => {
    const RESOLVABLE = new Set(["none", "dc", "stat", "dodge", "block", "blockOrDodge",
                                "resistMagic", "spellCasting"]);
    for (const key of vocabulary("SPELL_DEFENSES")) {
        const d = derive({ defense: [key] }).defence;
        assert.ok(RESOLVABLE.has(d.type),
            `"${key}" on the sheet becomes defence type "${d.type}", which oppose() cannot resolve`);
    }
});

test("`gm` becomes a difficulty, not a skill nobody has", () => {
    // It is a defence key in the system and means "the GM sets a DC".
    const d = derive({ defense: ["gm"] }).defence;
    assert.equal(d.type, "dc");
    assert.equal(d.dc, "gm");
});

/* ── Durations ───────────────────────────────────────────────────────────── */

test("every duration unit the sheet offers can be counted down", () => {
    // A unit no clock advances is an effect that never ends — permanent,
    // without saying so.
    const TICKABLE = new Set([ENDS.ROUNDS, ENDS.MINUTES, ENDS.HOURS, ENDS.DAYS]);
    const TIMELESS = new Set([ENDS.IMMEDIATE, ENDS.PERMANENT, "instant"]);
    for (const unit of vocabulary("SPELL_DURATION_UNITS")) {
        const kind = derive({ duration: { unit, value: "5" } }).duration.kind;
        assert.ok(TICKABLE.has(kind) || TIMELESS.has(kind),
            `"${unit}" becomes "${kind}", which no clock advances`);
    }
});

test("a duration in months is converted, not dropped", () => {
    const d = derive({ duration: { unit: "months", value: "2" } });
    assert.equal(d.duration.kind, "days");
    assert.equal(d.duration.value, "60", "two months is sixty days to a clock that counts days");
});

/* ── Statuses ────────────────────────────────────────────────────────────── */

test("every status the corpus applies is registered or aliased", async () => {
    const { resolveStatus, MAGIC_STATUSES } = await import("./statuses.mjs");
    const STATUSES = read("../setup/statusEffects.mjs");
    const registered = new Set([
        ...[...STATUSES.matchAll(/id:\s*"([a-zA-Z0-9_-]+)"/g)].map(m => m[1]),
        ...MAGIC_STATUSES.map(s => s.id)
    ]);
    const named = new Set();
    const walk = (body) => (body ?? []).forEach(n => {
        if (n.b === "core:applyStatus" || n.b === "core:removeStatus") {
            const st = n.a?.status;
            if (st && !st.includes("{")) named.add(st);
        }
        walk(n.body);
    });
    CORPUS.forEach(s => Object.values(s.on).forEach(walk));
    const unknown = [...named].filter(st => !registered.has(resolveStatus(st)));
    assert.deepEqual(unknown, [], `${unknown.join(", ")} would be dropped in silence`);
});

/* ── The general rule ────────────────────────────────────────────────────── */

test("no block offers an option the corpus contradicts", () => {
    // A block whose dropdown and whose authored usage disagree means one of
    // them is wrong, and the authored side is the one that runs.
    const problems = [];
    for (const def of allBlocks()) {
        for (const [arg, spec] of Object.entries(def.inputs ?? {})) {
            if (spec.type !== "enum" || !Array.isArray(spec.options)) continue;
            const allowed = new Set(spec.options.filter(Boolean));
            for (const used of corpusValues(def.id, arg)) {
                if (!allowed.has(used)) problems.push(`${def.id}.${arg} = "${used}" is not offered`);
            }
        }
    }
    assert.deepEqual(problems, []);
});
