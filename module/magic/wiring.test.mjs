// module/magic/wiring.test.mjs
//
// EXECUTING test for the seam between the engine and the system.
//
// Everything here is checkable without Foundry because it is about SHAPE:
// whether the schema has the field the canvas writes to, whether the router
// covers every call site, whether the localisation keys the card asks for
// exist. Each of these fails silently in a live world — Foundry drops an
// unschema'd update without a word, a missing i18n key renders as its own
// name, and a call site the router misses just quietly runs the old engine.
//
// Silent failures are exactly the ones worth a test.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

/** Source with comments removed — for asserting on what the code DOES. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const SCHEMA  = read("../data/item/spell.mjs");
const MIXIN   = read("../documents/mixins/castSpellMixin.mjs");
const CAST    = read("./cast.mjs");
const SHEETMOD = read("./canvas/sheet.mjs");
const FRAME    = read("./frame.mjs");
const SHEET   = read("../sheets/item/base.mjs");
const MAIN    = read("../main.mjs");
const LANG    = JSON.parse(read("../../lang/en.json"));
const SYSTEM  = JSON.parse(read("../../system.json"));
const STATUSES = read("../setup/statusEffects.mjs");
const SPELL_HBS = read("../../templates/item/spell.hbs");


/* ── The field the canvas writes to ──────────────────────────────────────── */

test("the spell schema has the `magic` field, or nothing can be authored", () => {
    // `item.update({"system.magic.on.hit": [...]})` against an unschema'd path
    // is dropped by Foundry WITHOUT AN ERROR. The canvas would look like it
    // worked and the tree would never exist.
    assert.match(SCHEMA, /magic:\s*new fields\.SchemaField\(/);
    const block = SCHEMA.slice(SCHEMA.search(/magic:\s*new fields\.SchemaField\(/));
    assert.match(block, /frame:\s*new fields\.ObjectField/);
    assert.match(block, /on:\s*new fields\.ObjectField/);
});

test("the canvas writes to the path the schema declares", () => {
    // The two halves of this were written days apart. If they disagree the
    // editor silently does nothing.
    const PERSIST = read("./canvas/persist.mjs");
    assert.match(PERSIST, /system\.magic\.on\.\$\{entry\}/);
    assert.match(SHEET, /sheet\.item\.system\?\.magic\?\.on/);
    assert.match(SHEETMOD, /item\.system\?\.magic/);
});

test("nothing writes the magic block as a whole object", () => {
    // An ObjectField update MERGES. `update({ "system.magic": { on: {} } })`
    // removes nothing, so Clear did nothing and loading from the book left the
    // old triggers beside the new ones — both silently, with a re-render that
    // showed exactly what it showed before.
    // Comments stripped first. A comment explaining WHY something is wrong
    // names the wrong thing by necessity, and a test that fails on its own
    // explanation is a test people delete.
    for (const [name, src] of [["the sheet", SHEET], ["the canvas", SHEETMOD]]) {
        assert.doesNotMatch(code(src), /update\(\{\s*"system\.magic":/,
            `${name} writes the magic block wholesale, which merges`);
    }
});

test("every removal is named explicitly, with Foundry's deletion syntax", () => {
    const PERSIST = read("./canvas/persist.mjs");
    assert.match(PERSIST, /system\.magic\.on\.-=\$\{entry\}/);
    assert.match(PERSIST, /system\.magic\.frame\.-=\$\{key\}/);
});

test("the canvas IS the config layer, not a window beside it", () => {
    // The complaint that produced this: opening a spell's config showed the
    // same form as before, because the editor lived in a separate application
    // reached by a button. A config surface you have to leave to use is one
    // people stop using.
    assert.match(SPELL_HBS, /\{\{\{canvasHTML\}\}\}/, "the canvas renders into the sheet");
    assert.doesNotMatch(SHEET, /new SpellCanvas/, "no separate window is opened");
    assert.match(SHEET, /attachCanvas\(this\.element, this\.canvasHost\)/);
});

test("the canvas is the FIRST thing in the config view, and it is open", () => {
    // Buried twice: first behind a button that opened another window, then as
    // a collapsed <details> below Advanced. Both times the report was the
    // same — "it's the same as before" — because a headline feature below the
    // fold is a feature nobody has.
    const cfg = SPELL_HBS.indexOf('<div class="wdm-config-view">');
    const behaviour = SPELL_HBS.indexOf("WITCHER.Sheet.Spell.Section.Behaviour");
    const advanced  = SPELL_HBS.indexOf("WITCHER.Sheet.Spell.Section.Advanced");

    assert.ok(behaviour > cfg, "it is in the config view");
    assert.ok(behaviour < advanced, "and nowhere near the bottom");

    const section = SPELL_HBS.slice(behaviour - 400, behaviour);
    assert.match(section, /<details class="wdm-cfg-collapse is-canvas" open>/,
        "and it does not have to be unfolded to be found");
});

test("the old behaviour config is GONE, not sitting beside the new one", () => {
    // It replaced nothing while both existed — you opened a spell and met two
    // half-systems, one of which silently won. Every field here is something a
    // block says better, and saying it twice means two answers that drift.
    for (const field of ["damageFormula", "damageElement", "damageType", "applyEvery",
                         "bypassArmor", "ablateArmor", "ablateHitLocationOnly",
                         "tangible", "areaPersist"]) {
        assert.ok(!SPELL_HBS.includes(`name="system.${field}"`), `${field} is still editable`);
    }
    // Scoped to the SPELL sheet: hexes are deliberately outside this engine
    // (narrative procedures, hours-long castings) and keep their own riders.
    const spellSheet = SHEET.slice(SHEET.indexOf("class WitcherSpellSheet"),
                                   SHEET.indexOf("class WitcherHexSheet"));
    // Code, not prose — the comment explaining WHY they went is allowed to
    // name them, and a test that fails on its own explanation is a nuisance.
    assert.doesNotMatch(spellSheet, /addStatusRider:\s*WitcherSpellSheet/, "action still registered");
    assert.doesNotMatch(spellSheet, /_onAddStatusRider\(/, "handler still defined");
    assert.doesNotMatch(spellSheet, /statusRiderRows =/, "context nobody renders");
});

test("every frame setting is editable in exactly ONE place", () => {
    // They were on the sheet AND in the panel beside the blocks: cost, range,
    // defence, element, duration, targeting, twice each. Not redundancy with
    // the block engine — redundancy with itself, and the main reason the sheet
    // read as overwhelming.
    const { lawHTML } = require_lawHTML();
    const panel = lawHTML({ name: "X", system: { targetType: "area" } }, [], null, {});
    for (const field of ["staminaCost", "variableCost", "range", "defense", "school",
                         "duration.unit", "duration.value", "targetType",
                         "areaShape", "areaSize", "areaExcludeCaster"]) {
        assert.ok(!SPELL_HBS.includes(`name="system.${field}"`),
            `${field} is on the sheet as well as in the panel`);
        assert.ok(panel.includes(`name="system.${field}"`), `${field} is nowhere at all`);
    }
});

test("no field is edited twice on the sheet", () => {
    // `castingTime` shipped twice — added once when the Identity section went,
    // then again in a later pass that did not notice. Two inputs bound to one
    // path fight each other on submit, and the third duplication in this file
    // is enough to stop finding them by eye.
    const cfg = SPELL_HBS.slice(SPELL_HBS.indexOf('<div class="wdm-config-view">'));
    const counts = new Map();
    for (const [, field] of cfg.matchAll(/name="system\.([\w.]+)"/g)) {
        counts.set(field, (counts.get(field) ?? 0) + 1);
    }
    /* `defense` is legitimately repeated: one checkbox per option, all bound
     * to the same array. Anything else is a duplicate. */
    const dupes = [...counts].filter(([f, n]) => n > 1 && f !== "defense").map(([f]) => f);
    assert.deepEqual(dupes, [], `${dupes.length} field(s) bound twice`);
});

test("every form control declares the type it submits", () => {
    // A checkbox submits a BOOLEAN unless told otherwise, so the defence boxes
    // were sending `true` instead of "dodge" and the schema rejected the whole
    // form on every keystroke anywhere on the sheet. A number field left empty
    // submits "" for the same reason.
    //
    // EVERY input, not a count of some of them — a threshold is a number
    // somebody has to remember to raise, and the first version of this test
    // failed on a control it should have been glad to see.
    const DOMSRC = read("./canvas/dom.mjs");
    const inputs = [...DOMSRC.matchAll(/<input[\s\S]*?>/g)].map(m => m[0]);
    assert.ok(inputs.length >= 6, `only ${inputs.length} controls in the panel`);
    for (const tag of inputs) {
        assert.match(tag, /data-dtype="(String|Number|Boolean)"/,
            `no dtype: ${tag.replace(/\s+/g, " ").slice(0, 90)}`);
    }
});

test("the defence checkboxes submit STRINGS, not booleans", () => {
    // Four boxes share one name because the field is an array of defence keys.
    // Without the dtype they collapse to [true, false, …].
    const { lawHTML } = require_lawHTML();
    const html = lawHTML({ name: "X", system: { defense: ["dodge"] } }, [], null, {});
    const boxes = html.match(/<input type="checkbox" name="system\.defense"[\s\S]*?>/g) ?? [];
    assert.ok(boxes.length >= 4);
    for (const b of boxes) assert.match(b, /data-dtype="String"/);
});

test("no form name is repeated across the WHOLE template", () => {
    // Both views live in the DOM at once — only one is visible, and
    // FormDataExtended does not care which. A name in both becomes an array,
    // and `castingTime: must be a number` is what that looks like.
    const names = [...SPELL_HBS.matchAll(/name="([\w.\-]+)"/g)].map(m => m[1]);
    const seen = new Map();
    for (const n of names) seen.set(n, (seen.get(n) ?? 0) + 1);
    const dupes = [...seen].filter(([n, c]) => c > 1 && n !== "system.defense").map(([n]) => n);
    assert.deepEqual(dupes, [], `${dupes.length} name(s) submit as an array`);
});

test("the description is the LAST thing in the config view", () => {
    // It is the longest field and the one you scroll to write in. Sitting it
    // above Advanced meant every visit to the block editor scrolled past a
    // paragraph of prose.
    const cfg = SPELL_HBS.indexOf('<div class="wdm-config-view">');
    const order = [...SPELL_HBS.matchAll(/wdm-cfg-collapse-title">\{\{localize '([\w.]+)'/g)]
        .filter(m => m.index > cfg)
        .map(m => m[1].split(".").pop());
    assert.equal(order.at(-1), "Effect", `order is ${order.join(" → ")}`);
    assert.ok(SPELL_HBS.includes('name="system.effect"'), "and the field is still there");
});

test("no section heading appears twice", () => {
    // The same class of bug one level up — a section re-added rather than
    // moved, which is how this template once ended up concatenated with
    // itself.
    const titles = [...SPELL_HBS.matchAll(/wdm-cfg-collapse-title">\{\{localize '([^']+)'/g)]
        .map(m => m[1]);
    assert.deepEqual(titles, [...new Set(titles)], "a section is duplicated");
});

test("what neither the panel nor a block covers is still on the sheet", () => {
    // Overshooting is the other failure. The rules text is what a player reads
    // at the table; components are what the casting consumes; cast time is
    // action economy, which the dock reads and the frame never sees.
    for (const field of ["effect", "castingTime"]) {
        assert.ok(SPELL_HBS.includes(`name="system.${field}"`), `${field} became unsettable`);
    }
    assert.match(SPELL_HBS, /data-action="removeComponent"/, "components survived");
});

test("the window does NOT grow with the UI scale", () => {
    // Making it grow was backwards. The complaint was that the editor took up
    // too much room; scaling the frame up is the opposite of a fix. The canvas
    // is one column now, so it fits an ordinary item-sheet width and stays
    // there at every scale.
    const spell = SHEET.slice(SHEET.indexOf("class WitcherSpellSheet"));
    assert.match(spell, /_initializeApplicationOptions\(options\)/);
    assert.doesNotMatch(code(spell), /\d+ \* (Math\.min\()?scale/, "the width follows the knob");
    assert.match(spell, /Math\.min\(620, window\.innerWidth \* 0?\.9\)/, "modest, and clamped to the screen");
    assert.match(spell, /height: "auto"/, "a fixed height cannot shrink for a simple spell");
});

test("the canvas is sized in em against a damped anchor, never in rem", () => {
    // `rem` reads the document root, which this system multiplies by the UI
    // scale — so a canvas laid out in rem grew with the knob while its px type
    // stood still, and bloated out of its window.
    const CSS = read("../../styles/spell-canvas.css");
    const rems = [...CSS.matchAll(/[\d.]+rem/g)].map(m => m[0]);
    assert.deepEqual(rems, [], `${rems.length} rem values still scale independently`);

    // Every detached root needs its own anchor, and they must all be the same
    // damped expression or the pieces drift apart at high scale.
    const anchors = CSS.match(/font-size: calc\(6px \+ 4px \* var\(--wdm-scale, 1\)\)/g) ?? [];
    assert.ok(anchors.length >= 3, `${anchors.length} anchors — every detached root needs one`);
    assert.equal((CSS.match(/var\(--wdm-scale/g) ?? []).length, anchors.length,
        "something reads the knob outside an anchor");
});

test("every collapsible section says what it is, not just what is in it", () => {
    // The rules strip showed "5 STA · 12m · Dodge / Block" and nothing else —
    // a summary of its contents that never named them, so the one control
    // folding away every rule the spell runs under read as a stray line of
    // stats.
    assert.match(SHEETMOD, /wm-frame-label/);
    assert.match(SHEETMOD, /WITCHER\.Sheet\.Spell\.Section\.Rules/);
    assert.ok("WITCHER.Sheet.Spell.Section.Rules" in LANG);

    /* Every other fold on the canvas already carries a name; check none has
     * quietly lost it. */
    for (const [what, marker] of [["the palette", "wm-palette-open"],
                                  ["the triggers", "wm-trigger-add"]]) {
        assert.ok(SHEETMOD.includes(marker) || SPELL_HBS.includes(marker),
            `${what} has no label`);
    }
});

test("the trigger line says WHO the blocks run against", () => {
    // "How does the block make Aard a 2m cone" is the right question, and the
    // canvas had no answer on it: the cone is frame law, no block mentions
    // one, and nothing joined the two. Somebody looking for it scrolls a
    // palette of 38 blocks that will never contain it.
    assert.match(SHEETMOD, /function reachOf\(item\)/);
    assert.match(SHEETMOD, /WITCHER\.Sheet\.Spell\.Text\.ReachArea/);
    assert.ok("WITCHER.Sheet.Spell.Text.ReachArea" in LANG);
    assert.match(LANG["WITCHER.Sheet.Spell.Text.ReachArea"], /\{size\}m \{shape\}/);
});

test("only the triggers that use the CAST's targets mention its reach", () => {
    // An interception fires for whoever is carrying the effect. Quen's shield
    // absorbing a blow has nothing to do with whatever cone Quen was cast in.
    assert.match(SHEETMOD, /entry === "hit" \|\| entry === "miss"/);
});

test("both engines open the SAME cast dialog", () => {
    // The engine had its own stamina prompt, so a spell on the new path
    // silently lost the Focus discount, the Greater Focus roll bonus, glyph
    // elements, adrenaline dice and the extra-action penalty — every one a
    // rule somebody had already written, bypassed because the new path asked a
    // simpler question.
    assert.match(MIXIN, /async declareCast\(item, \{[^}]*skillKey/,
        "the gathering is not extracted");
    /* Wrapped across lines once the aiming flags joined it. */
    assert.match(MIXIN, /const decl = await this\.declareCast\(item, \{\s*\n?\s*skillKey, isRitual/,
        "the old path no longer uses it");
    const ADAPTER = read("./adapter.mjs");
    /* Wrapped across lines once the aiming flags joined it. */
    assert.match(ADAPTER, /a\.declareCast\(item, \{\s*\n?\s*skillKey/, "the new path does not use it");
});

test("the dialog's total reaches the roll, and the skill is not counted twice", async () => {
    /* `grandMod` is the COMPLETE modifier — it already contains the caster's
     * full skill total. The adapter used to add `skillTotal` on top, so a
     * WILL 8 / Spell Casting 8 mage saw "1d10 +16" in the dialog and then
     * rolled 1d10+24. Only the formula shows that; a regex never could. */
    const { castFormula } = await import("./castFormula.mjs");
    assert.equal(castFormula(16), "1d10 + 16", "the declared total is rolled verbatim");
    assert.equal(castFormula(-3), "1d10 - 3", "a negative total subtracts");
    assert.equal(castFormula(16, 2), "1d10 + 16 + 2d6", "adrenaline dice ride along");
    assert.equal(castFormula(0), "1d10 + 0");

    /* And the frame must distinguish "declared zero" from "nobody declared". */
    assert.match(FRAME, /modifier: ctx\.declaration \? Number\(ctx\.declaration\.grandMod\) \|\| 0 : null/,
        "passing 0 for an absent declaration makes the adapter re-add the skill");
    const ADAPTER = read("./adapter.mjs");
    assert.match(ADAPTER, /const declared = opts\.modifier != null/, "the adapter must branch on null");
    assert.doesNotMatch(ADAPTER, /skillTotal\(a, "spellcast"\)[\s\S]{0,120}\+ \$\{mod\}/,
        "the skill must never be added on top of a declared total");
});

test("a glyph can change what element the cast resolves as", () => {
    assert.match(FRAME, /declaredElement\s*\?\?/);
    assert.match(FRAME, /declared\.damageElement/);
});

test('...but "none" is the dialog\'s empty answer, not an element', () => {
    /* `castDialog` defaults the field to the STRING "none" when the item has no
     * `system.damageElement`, and `||` treated that as a real choice — so every
     * spell cast through the dialog resolved as element "none" and nothing
     * could match on element. Demetia's Crest Surge let a Carys' Hail straight
     * through; caught by casting one at the other in a live world. */
    assert.match(FRAME, /declared\.damageElement !== "none"/);
    assert.doesNotMatch(FRAME, /ctx\.record\.element = declared\.damageElement\s*\n\s*\|\|/,
        "the || fallback is what let the sentinel win");
});

test("adrenaline's stamina is charged on top of the spell's", () => {
    assert.match(FRAME, /Number\(declared\.adrenalineStaCost\) \|\| 0/);
});

test("the engine still runs when nothing can declare", () => {
    // The test harness has no dialog, and neither does a re-fired effect
    // resolving rounds after its cast.
    assert.match(FRAME, /if \(!ctx\.adapter\.declareCast\) return ctx;/);
});

test("a spell that hits an area AND leaves a zone is aimed ONCE", () => {
    // Eight core spells do both — Static Storm, Dormyn's Fog, Freya's Bravery
    // — and each asked the caster to place the same circle twice: once for the
    // frame to work out who was caught, once for the block to leave the zone.
    const ADAPTER = read("./adapter.mjs");
    assert.match(ADAPTER, /pickAreaSnapshot/, "the aim must yield geometry, not just tokens");
    assert.match(ADAPTER, /this\.lastPlacement = snap\.placement/);
    const zone = ADAPTER.slice(ADAPTER.indexOf("async createZone("));
    assert.match(zone.slice(0, 900), /this\.lastPlacement/, "the zone re-aims instead of reusing");
});

test("what aims a template gives what places one everything it needs", () => {
    // Two functions written years apart in different files, joined by the
    // engine. `createZoneTemplate` reads x, y and direction off the placement;
    // a block's own spec has only a shape and a size, because a block
    // describes a footprint and not a position.
    const ZONES = read("../mechanics/zoneEffects.mjs");
    const AREA  = read("../mechanics/castArea.mjs");

    const consumer = ZONES.slice(ZONES.indexOf("export async function createZoneTemplate"));
    const needs = new Set([...consumer.slice(0, consumer.indexOf("\nexport "))
        .matchAll(/placement\.(\w+)/g)].map(m => m[1]));

    /* The literal `pickAreaSnapshot` returns. */
    const at = AREA.indexOf("        placement: {");
    /* Shorthand counts: the literal writes `shape,` and `size,` without a
     * colon, and a pattern that only sees `name:` reports two fields as
     * missing that are plainly there. */
    const gives = new Set([...AREA.slice(at, AREA.indexOf("},", at))
        .matchAll(/^\s+(\w+)\s*[:,]/gm)].map(m => m[1]));

    /* `elevation` falls back to the caster's own token, so it is the one
     * field the aim does not have to supply. */
    const missing = [...needs].filter(k => !gives.has(k) && k !== "elevation");
    assert.deepEqual(missing, [],
        `${missing.join(", ")} — the zone would be placed at undefined`);
});

test("a zone with no frame area aims its own template", () => {
    // Yrden, Ice Slick, Air Pocket and Elgan's Theory leave a zone without
    // hitting an area first, so nothing has aimed anything yet — and their
    // whole purpose IS the zone.
    const ADAPTER = read("./adapter.mjs");
    const zone = ADAPTER.slice(ADAPTER.indexOf("async createZone("));
    const body = zone.slice(0, zone.indexOf("\n        },"));
    assert.match(body, /if \(!placement && spec\.anchor !== "object"\)/);
    assert.match(body, /pickAreaSnapshot/, "it would place the zone at undefined");
    assert.match(body, /this\.lastPlacement = placement/, "a second zone should reuse the aim");
});

test("a caster-anchored zone follows the caster, not the cursor", () => {
    const ADAPTER = read("./adapter.mjs");
    const zone = ADAPTER.slice(ADAPTER.indexOf("async createZone("));
    /* Slice widened: the object-anchored branch now sits above this one. */
    assert.match(zone.slice(0, 3200), /spec\.anchor === "caster" \? "caster" : "free"/);
});

test("a zone anchored to an OBJECT still places itself", () => {
    // Elgan's Theory magnetises a specific object; its zone follows that, not
    // wherever the caster happened to point the targeting template.
    //
    // "Excluded from the aiming path" was the whole bug: the anchor fell
    // through with no x/y and the template layer's `Number(placement.x) || 0`
    // built the region at scene coordinate (0,0), in the corner of the map.
    // So it is not enough that the branch EXISTS — it has to end with a
    // position.
    const ADAPTER = read("./adapter.mjs");
    const zone = ADAPTER.slice(ADAPTER.indexOf("async createZone("));
    assert.match(zone.slice(0, 2400), /spec\.anchor === "object"/);
    assert.match(zone.slice(0, 2400), /placement = \{ x: anchorTok\.center\.x, y: anchorTok\.center\.y/,
        "an object-anchored zone must resolve to real coordinates, not fall through");
});

test("the placement cannot survive into the next cast", () => {
    // It lives on the adapter, and an adapter is built per cast.
    const ADAPTER = read("./adapter.mjs");
    assert.match(ADAPTER, /lastPlacement: null,/);
    assert.doesNotMatch(code(ADAPTER), /^let lastPlacement/m, "module-level state would leak");
});

test("nothing reserves permanent space beside the blocks", () => {
    // The actual complaint: a permanent palette rail and a permanent frame
    // panel ate ~225px of an 800px window before a block was drawn, on every
    // spell, whether or not you were adding anything.
    const CSS = read("../../styles/spell-canvas.css");
    assert.match(CSS, /\.wm-canvas\.is-lean \{[^}]*flex-direction: column/,
        "the canvas is one column");
    assert.match(CSS, /\.wm-palette-panel \{[^}]*position: absolute/,
        "the palette overlays rather than reserving space");
    assert.match(SHEETMOD, /<details class="wm-frame-strip" open>/,
        "the frame is a strip that folds, not a column that stays");
});

test("the sheet is a canvas HOST — four methods, all one-liners", () => {
    // Bounded by the next method, whatever it is — slicing to a hard-coded
    // neighbour breaks the moment anything moves.
    const from = SHEET.indexOf("get canvasHost()");
    const to = SHEET.indexOf("\n    async _onRender", from);
    const host = SHEET.slice(from, to > from ? to : from + 2600);
    for (const method of ["trees:", "focus:", "async commit(", "refuse(", "async ask("]) {
        assert.ok(host.includes(method), `host.${method} is missing`);
    }
});

test("no sheet class defines the same method twice", () => {
    // A later definition of the same method silently wins — no error, no
    // warning. Adding an `_onRender` to a class that already had one meant the
    // canvas rendered and then refused to be dragged, which is the least
    // debuggable failure available.
    const classes = [...SHEET.matchAll(/^export class (\w+) extends/gm)].map(m => m[1]);
    for (const [i, name] of classes.entries()) {
        const from = SHEET.indexOf(`class ${name} extends`);
        const to = i + 1 < classes.length ? SHEET.indexOf(`class ${classes[i + 1]} extends`) : SHEET.length;
        const body = SHEET.slice(from, to);
        const seen = new Map();
        /* Keywords that look like a method declaration at four spaces of
         * indent but are not one. Missing them turns this guard into noise,
         * and a noisy guard gets deleted. */
        const NOT_METHODS = new Set(["if", "for", "while", "switch", "return", "catch",
                                     "try", "else", "do", "await", "const", "let", "var",
                                     "new", "throw", "typeof", "yield", "case"]);
        for (const m of body.matchAll(/^\s{4}(?:static\s+)?(?:async\s+)?(?:get\s+)?([_a-zA-Z]\w*)\s*[(=]/gm)) {
            const method = m[1];
            if (NOT_METHODS.has(method)) continue;
            assert.ok(!seen.has(method), `${name} defines ${method} twice — the second one wins in silence`);
            seen.set(method, true);
        }
    }
});

test("nothing shadows the `canvas` global inside a sheet", () => {
    // `canvas` is Foundry's. A local of the same name inside a sheet method is
    // a landmine for whoever edits that method next.
    assert.doesNotMatch(SHEET, /const canvas\s*=/);
});

test("a re-render does not throw away what you had open", () => {
    // Every edit writes to the document and rebuilds the DOM. Without this the
    // palette snaps shut, the list jumps to the top and the control you just
    // changed loses focus — so picking three things means opening the same
    // panel three times.
    assert.match(SHEET, /_preSyncPartState\(partId, newElement, priorElement, state\)/);
    assert.match(SHEET, /state\.witcherCanvas = captureUI\(priorElement\)/);
    assert.match(SHEET, /restoreUI\(newElement, state\.witcherCanvas\)/);
});

test("the picker list is a listbox of options, not a stack of buttons", () => {
    // Foundry styles `button` hard enough — its own height, uppercase, letter
    // spacing — that every reset lost, and the rows came out overlapping with
    // the name and tier on different lines. A picker row is an option anyway.
    assert.match(SHEETMOD, /role="option"/);
    assert.match(SHEETMOD, /role="listbox"/);
    assert.doesNotMatch(code(SHEETMOD), /<button[^>]*class="wm-book-row/);
});

test("a div row still answers the keyboard", () => {
    // A div gets nothing for free, and a hundred rows only a mouse can reach
    // is not a list.
    assert.match(SHEETMOD, /ev\.key === "Enter" \|\| ev\.key === " "/);
    assert.match(SHEETMOD, /ArrowDown/);
    assert.match(SHEETMOD, /tabindex="0"/);
});

test("a change to anything the canvas shows forces a re-render", () => {
    // The canvas is built in `_prepareContext`, so it only reflects a change
    // once the sheet renders again. Anything that swallows the update leaves
    // the shape and size controls of a targeting mode you have just left, and
    // a trigger line still describing the old reach — it looks right and is
    // not.
    assert.match(SHEET, /async _onChangeForm\(formConfig, event\)/);
    assert.match(SHEET, /this\.render\(\{ force: false \}\)/);

    /* Every control the panel renders has to be in the list, or changing it
     * updates the document and not the screen. */
    const list = SHEET.slice(SHEET.indexOf("const CANVAS_FIELDS"));
    const watched = new Set([...list.slice(0, list.indexOf("]);"))
        .matchAll(/"system\.([\w.]+)"/g)].map(m => m[1]));

    const { lawHTML } = require_lawHTML();
    const panel = lawHTML({ name: "X", system: { targetType: "area" } }, [], null, {});
    for (const [, field] of panel.matchAll(/name="system\.([\w.]+)"/g)) {
        const root = field.split(".")[0];
        assert.ok(watched.has(field) || watched.has(root),
            `changing ${field} would not redraw the canvas`);
    }
});

test("failing to restore panel state can never abort a render", () => {
    // Restoring which panels were open is a convenience. A throw in there
    // aborts the part swap and leaves the OLD dom on screen — so a stale
    // panel becomes the visible symptom of a bug in the code whose entire job
    // is keeping panels tidy.
    const sync = SHEET.slice(SHEET.indexOf("_preSyncPartState(partId"),
                             SHEET.indexOf("async _onChangeForm("));
    assert.equal((sync.match(/try \{/g) ?? []).length, 2, "both halves must be guarded");
    assert.doesNotMatch(sync, /\$\{SYSTEM_ID\}/,
        "the guard referenced an identifier this file does not define");
});

test("the canvas is torn down when the sheet closes", () => {
    // Listeners on a removed element keep the sheet alive; re-rendering a
    // spell forty times in a session should not leave forty canvases wired.
    assert.match(SHEET, /this\._detachCanvas\?\.\(\)/);
    assert.match(SHEET, /async close\(options\) \{/);
});

test("the book's version is a STARTING POINT, not a lock", () => {
    // The correction that produced this file: the corpus was built to prove
    // the block set can express the rulebook, and I mistook the proof for the
    // product. What lands from the book is an ordinary tree.
    assert.match(SHEETMOD, /export async function startFromBook/);
    assert.match(SHEETMOD, /structuredClone\(spell\.frame\)/);
    assert.match(SPELL_HBS, /data-action="startFromBook"/);
});

test("the cast reads the trees off the item and DERIVES the frame", () => {
    assert.match(CAST, /item\.system\?\.magic\?\.on/);
    // The frame is not read raw. Every spell already declares its cost, range,
    // defence, school and duration on the sheet — those ARE the frame, and
    // asking people to re-enter twenty-seven fields they had already filled in
    // is how a migration becomes a thing nobody performs.
    assert.match(CAST, /frame: frameFor\(item\.system\)/);
});

test("an author's frame edit always beats a derived field", async () => {
    const { frameFor } = await import("./legacyFrame.mjs");
    const system = { staminaCost: 5, magic: { frame: { cost: { mode: "fixed", amount: 99 } } } };
    assert.equal(frameFor(system).cost.amount, 99);
});

test("the frame panel edits the spell's OWN long-standing fields", () => {
    // Not `system.magic.frame`. Everything downstream reads `staminaCost` and
    // `defense` — chat cards, the actor sheet's spell list, the compendium
    // browser — and the frame derives from them. One set of fields, one owner,
    // nothing downstream to update.
    assert.match(SHEETMOD, /frameSummary\(frameFor\(item\.system\)\)/);
    const { lawHTML } = require_lawHTML();
    const html = lawHTML({ name: "X", system: { staminaCost: 4 } }, [], null, {});
    assert.ok(html.includes('name="system.staminaCost"'));
    assert.ok(!html.includes('name="system.magic.frame'), "the frame stays derived");
});

test("the panel's dropdowns come from the world's config, not from the engine", () => {
    // So a module adding a school or a defence appears without the engine
    // knowing it exists.
    assert.match(SHEETMOD, /CONFIG\.WITCHER\?\.magic/);
    assert.match(SHEETMOD, /if \(!built\[key\]\.length\) delete built\[key\]/,
        "and an unconfigured world falls back to RAW rather than empty selects");
});

/* ── The router ──────────────────────────────────────────────────────────── */

test("routing sits in castSpell, so every call site is covered by one decision", () => {
    // Four call sites — character sheet, monster sheet, chrome sheet, dock.
    // Routing at each would mean four chances for three to agree and one not.
    const body = MIXIN.slice(MIXIN.indexOf("async castSpell(item"));
    const guard = body.indexOf("hasAuthoredTrees(item.system)");
    assert.ok(guard > 0, "castSpell checks for authored trees");
    assert.ok(guard < body.indexOf("this.declareCast("),
        "and it decides BEFORE the old path declares");
});

test("the router and the sheet share ONE definition of `is this authored`", async () => {
    // They were written days apart and each grew its own copy. Two predicates
    // that answer the same question are two predicates that eventually
    // disagree — and the disagreement here means a sheet showing the new
    // engine on a spell the router still sends down the old path.
    assert.match(MIXIN, /import \{ hasAuthoredTrees \} from "\.\.\/\.\.\/magic\/summary\.mjs"/);
    assert.doesNotMatch(MIXIN, /function hasAuthoredTrees/, "no second copy");
    const SHEET = read("../sheets/item/base.mjs");
    assert.match(SHEET, /import \{ authoredSummary \} from "\.\.\/\.\.\/magic\/summary\.mjs"/);
});

test("an empty `on` object is not mistaken for authored behaviour", async () => {
    // The schema initialises `on` to `{}` for EVERY spell in the world. If
    // that counted as authored, the new engine would take over every cast the
    // moment this shipped.
    const { hasAuthoredTrees } = await import("./summary.mjs");
    assert.equal(hasAuthoredTrees({ magic: { on: {} } }), false, "every spell would have been hijacked");
    assert.equal(hasAuthoredTrees({ magic: { on: { hit: [] } } }), false, "an abandoned trigger is not behaviour");
    assert.equal(hasAuthoredTrees({}), false, "and neither is a spell with no magic block");
    assert.equal(hasAuthoredTrees({ magic: { on: { hit: [{ b: "core:dealDamage" }] } } }), true);
});

/* ── Refusing before spending ────────────────────────────────────────────── */

test("a broken spell is refused BEFORE anything is paid", () => {
    const before = CAST.indexOf("validateSpell(");
    const after  = CAST.indexOf("castFrame(ctx");
    assert.ok(before > 0 && before < after,
        "failing halfway costs the stamina and leaves half the effects standing");
});

/* ── Registration ────────────────────────────────────────────────────────── */

test("the engine registers its blocks at init and its hooks at ready", () => {
    const init  = MAIN.indexOf("registerMagicEngine()");
    const ready = MAIN.indexOf("registerMagicHooks()");
    assert.ok(init > 0 && ready > init, "blocks must exist before any sheet renders");
});

test("the canvas stylesheet is loaded by system.json", () => {
    assert.ok(SYSTEM.styles.includes("styles/spell-canvas.css"));
});

/* ── The item sheet ──────────────────────────────────────────────────────
 * "Is this all visualized through the item config layer?" — it was not. The
 * action handler existed and NOTHING FIRED IT: `openSpellCanvas` was
 * registered on the sheet class and no template carried the button, so the
 * canvas was unreachable from the game. Dead code that looks like a feature. */

test("something in the template actually fires every action the sheet registers", () => {
    const SHEET = read("../sheets/item/base.mjs");
    const block = SHEET.slice(SHEET.indexOf("class WitcherSpellSheet"));
    const registered = [...block.slice(0, block.indexOf("};")).matchAll(/^\s{12}(\w+):/gm)].map(m => m[1]);
    assert.ok(registered.includes("startFromBook"), "the sheet registers canvas actions");
    for (const action of registered) {
        assert.ok(SPELL_HBS.includes(`data-action="${action}"`),
            `nothing in spell.hbs fires "${action}"`);
    }
});

test("the sheet shows WHICH ENGINE a spell is on", () => {
    // Without it the two paths are indistinguishable, and a spell that quietly
    // does nothing looks exactly like one that quietly works.
    assert.match(SPELL_HBS, /\{\{#if authored\.any\}\}/);
    assert.match(SPELL_HBS, /authored\.badge/);
    const SHEET = read("../sheets/item/base.mjs");
    assert.match(SHEET, /ctx\.authored = authoredSummary\(/);
});

test("clearing behaviour is confirmed, and scoped to system.magic", () => {
    const SHEET = read("../sheets/item/base.mjs");
    const fn = SHEET.slice(SHEET.indexOf("_onClearSpellCanvas(event"));
    assert.match(fn.slice(0, 700), /DialogV2\.confirm/, "it discards authored work");
    assert.match(fn.slice(0, 700), /"system\.magic": \{ frame: \{\}, on: \{\} \}/,
        "and touches nothing else on the item");
});

test("the summary refuses to call an abandoned trigger `behaviour`", async () => {
    const { authoredSummary } = await import("./summary.mjs");
    assert.equal(authoredSummary({ on: {} }).any, false);
    assert.equal(authoredSummary({ on: { hit: [] } }).any, false);
    assert.equal(authoredSummary(undefined).any, false);
});

test("the summary names what a tree DOES, not what it contains", async () => {
    // "3 blocks" does not tell a GM whether this is the spell they meant.
    const { registerAll } = await import("./spells/harness.mjs");
    const { authoredSummary } = await import("./summary.mjs");
    const { AENYE } = await import("./spells/fire.mjs");
    registerAll();
    const s = authoredSummary({ on: AENYE.on }, "Aenye");
    assert.equal(s.entries[0].summary, "deals damage, applies a status");
    assert.equal(s.badge, "3 blocks · 1 trigger");
});

test("a drifted spell says so on the sheet rather than at cast time", async () => {
    const { authoredSummary } = await import("./summary.mjs");
    const s = authoredSummary({ on: { hit: [{ b: "coven:hexBolt", a: {} }] } }, "Drifted");
    assert.equal(s.problems.length, 1);
    assert.match(s.badge, /1 problem/);
});

/* ── Starting from the book ──────────────────────────────────────────────
 * There used to be a seeding tool here that walked the world and wrote 103
 * spell definitions onto items. It was the wrong shape: a tool that bakes
 * behaviour in is the hardwiring this engine replaced, and the answer to "how
 * do I change what Igni does" became "re-run the seeder" rather than "drag the
 * block". The corpus is a library reachable from the canvas instead. */

test("nothing bulk-writes behaviour onto items behind the author's back", () => {
    const SETTINGS = read("../setup/settings.mjs");
    assert.doesNotMatch(SETTINGS, /spellCorpusSeed/);
});

test("the library is reached from the spell being edited", () => {
    assert.match(SPELL_HBS, /data-action="startFromBook"/);
    assert.match(SHEET, /_onStartFromBook/);
});

test("loading from the book brings the book's TEXT as well as its blocks", () => {
    // Blocks say what a spell does; the description says what the book says,
    // and a GM adjudicating an edge reads the second. Getting the behaviour
    // and a blank description is half a spell.
    assert.match(SHEETMOD, /import\("\.\.\/spells\/descriptions\.mjs"\)/);
    assert.match(SHEETMOD, /"system\.effect": `<p>\$\{text\}<\/p>`/);
});

test("it never overwrites a description somebody wrote", () => {
    // A "start from the book" that silently replaces prose is one nobody
    // risks pressing twice.
    assert.match(SHEETMOD, /if \(text && !existing\)/);
    assert.match(SHEETMOD, /replace\(\/<\[\^>\]\*>\/g, ""\)\.trim\(\)/,
        "markup-only text must count as empty");
});

test("every authored spell has the book's words to go with it", async () => {
    const { describe } = await import("./spells/descriptions.mjs");
    const { CORPUS } = await import("./spells/corpus.mjs");
    const missing = CORPUS.filter(s => !describe(s.name)).map(s => s.name);
    assert.deepEqual(missing, [], `${missing.length} spells would load with a blank description`);
});

test("the extracted text carries no PDF wreckage", async () => {
    // A two-column layout leaves hyphenation across line breaks, ligatures
    // split mid-word ("Th under", "Suff ocate"), and letter-tracked headings.
    const { DESCRIPTIONS } = await import("./spells/descriptions.mjs");
    const broken = Object.entries(DESCRIPTIONS)
        .filter(([, v]) => /\/f_|\bTh [a-z]|\bff [a-z]|\bEff |\b\w \w \w\b/.test(v))
        .map(([k]) => k);
    assert.deepEqual(broken, [], `${broken.length} descriptions still read like a broken PDF`);
});

test("an expression slot says what it can refer to", () => {
    // Alzur's Thunder loses a die per target and says so with
    // `max(1,8-{index})d6` — which works, and which nobody could have written,
    // because nothing anywhere mentioned that `{index}` exists.
    assert.match(SHEETMOD, /function expressionHelp\(\)/);
    for (const v of ["{sta}", "{margin}", "{index}", "{skill}", "{vigor}"]) {
        assert.ok(SHEETMOD.includes(v), `${v} is not offered`);
    }
    for (const key of ["Sta", "Margin", "Index", "Skill", "Vigor", "Lede", "Maths"]) {
        assert.ok(`WITCHER.Sheet.Spell.Expr.${key}` in LANG, `${key} has no text`);
    }
});

test("the falloff variable is explained by example, not by name", () => {
    // "the loop counter" does not make Alzur's falloff writable. "How many
    // targets it has already passed through" does.
    assert.match(LANG["WITCHER.Sheet.Spell.Expr.Index"], /already passed through/);
    assert.match(LANG["WITCHER.Sheet.Spell.Expr.Index"], /max\(1,8-\{index\}\)d6/);
});

test("loading from the book confirms before discarding existing work", () => {
    assert.match(SHEETMOD, /DialogV2\.confirm/);
    assert.ok(Object.keys(LANG).includes("WITCHER.Sheet.Spell.Text.ConfirmReplaceBehaviour"));
});

test("the book window can be resized and its list can scroll", () => {
    // Two symptoms, one cause. `resizable` is off by default on DialogV2, so
    // there was no grip in the corner; and `height: 100%` only resolves when
    // EVERY ancestor has a definite height — Foundry's `.window-content` is a
    // plain block, so the list had nothing to measure against, grew to fit all
    // hundred rows, and pushed the dialog off the screen with no scrollbar.
    assert.match(SHEETMOD, /resizable: true/);
    assert.match(SHEETMOD, /classes: \["witcher", "wm-book-dialog"\]/);

    const CSS = read("../../styles/spell-canvas.css");
    const chain = CSS.slice(CSS.indexOf(".wm-book-dialog .window-content"));
    for (const link of [".wm-book-dialog .window-content", ".wm-book-dialog form", ".wm-book {", ".wm-book-list {"]) {
        const rule = CSS.slice(CSS.indexOf(link), CSS.indexOf("}", CSS.indexOf(link)));
        assert.match(rule, /min-height: 0/, `${link} breaks the scroll chain`);
    }
    assert.match(chain, /overflow-y: auto/, "and something actually scrolls");
});

test("scrolling the book list does not scroll the sheet behind it", () => {
    const CSS = read("../../styles/spell-canvas.css");
    assert.match(CSS, /overscroll-behavior: contain/);
});

test("a spell with no book entry is offered the list rather than nothing", () => {
    // Homebrew is the common case, and "no match" must not be a dead end.
    assert.match(SHEETMOD, /pickFromBook\(CORPUS, item\.name\)/);
});

test("every string the canvas sheet asks for exists", () => {
    const keys = new Set();
    for (const [, k] of SHEETMOD.matchAll(/localize\("([^"]+)"\)/g)) keys.add(k);
    for (const [, k] of SHEETMOD.matchAll(/format\("([^"]+)"/g)) keys.add(k);
    const missing = [...keys].filter(k => !(k in LANG)).sort();
    assert.deepEqual(missing, []);
});

test("every string the spell template asks for exists", () => {
    const keys = [...SPELL_HBS.matchAll(/localize '([^']+)'/g)].map(m => m[1]);
    const missing = [...new Set(keys)].filter(k => !(k in LANG)).sort();
    assert.deepEqual(missing, [], `${missing.length} render as their own key`);
});

/* ── Statuses ────────────────────────────────────────────────────────────
 * Found by casting Aenye for real, against the actual GM handler:
 *
 *     handleApplyStatus: unknown status id "onFire" — ignoring
 *
 * Silently. The card posts, the damage lands, and the target simply never
 * catches fire — which nobody notices until somebody asks, three sessions
 * later, why Igni has never once set anything alight. A whole category of
 * bug that 262 passing tests could not see, because the fake adapter accepted
 * any string it was handed. */

test("every status the corpus applies resolves to a registered id", async () => {
    const { registerAll } = await import("./spells/harness.mjs");
    const { CORPUS } = await import("./spells/corpus.mjs");
    const { resolveStatus, MAGIC_STATUSES } = await import("./statuses.mjs");
    registerAll();

    const registered = new Set([
        ...[...STATUSES.matchAll(/id:\s*"([a-zA-Z0-9_-]+)"/g)].map(m => m[1]),
        ...MAGIC_STATUSES.map(s => s.id)
    ]);

    const named = new Set();
    const walk = (body) => (body ?? []).forEach(n => {
        if (n.b === "core:applyStatus" || n.b === "core:removeStatus") {
            const st = n.a?.status;
            /* `{band}` and `{choice}` are interpolated at cast time from the
             * banded cost or the author's pick — checked separately below. */
            if (st && !st.includes("{")) named.add(st);
        }
        walk(n.body);
    });
    CORPUS.forEach(sp => Object.values(sp.on).forEach(walk));

    const unknown = [...named].filter(st => !registered.has(resolveStatus(st))).sort();
    assert.deepEqual(unknown, [], `${unknown.length} statuses the GM handler would drop in silence`);
});

test("every value a banded or chosen status can take is registered too", async () => {
    const { CORPUS } = await import("./spells/corpus.mjs");
    const { resolveStatus, MAGIC_STATUSES } = await import("./statuses.mjs");
    const registered = new Set([
        ...[...STATUSES.matchAll(/id:\s*"([a-zA-Z0-9_-]+)"/g)].map(m => m[1]),
        ...MAGIC_STATUSES.map(s => s.id)
    ]);

    /* A banded cost's LABELS become the status. Cursed Illness pays 2/4/6 for
     * staggered/stunned/poisoned, and each of those has to be a real id. */
    const values = new Set();
    for (const sp of CORPUS) {
        for (const label of Object.values(sp.frame.cost?.bands ?? {})) values.add(label);
        const walk = (body) => (body ?? []).forEach(n => {
            if (n.b === "core:chooseOption") (n.a?.choices ?? []).forEach(c => {
                /* Only when the body actually applies the pick as a status. */
                if ((n.body ?? []).some(k => k.b === "core:applyStatus" && /\{/.test(k.a?.status ?? ""))) {
                    values.add(c);
                }
            });
            walk(n.body);
        });
        Object.values(sp.on).forEach(walk);
    }

    const unknown = [...values].filter(v => !registered.has(resolveStatus(v))).sort();
    assert.deepEqual(unknown, [], `${unknown.length} would be dropped in silence`);
});

test("an alias never shadows a status the system already has", async () => {
    // Registering `onFire` alongside `burning` would split one condition in
    // two: a target could be both, and Downpour would put out only one.
    const { STATUS_ALIASES, MAGIC_STATUSES } = await import("./statuses.mjs");
    const newIds = new Set(MAGIC_STATUSES.map(s => s.id));
    for (const from of Object.keys(STATUS_ALIASES)) {
        assert.ok(!newIds.has(from), `${from} is both aliased AND registered`);
    }
});

test("every alias points at an id the system actually declares", async () => {
    const { STATUS_ALIASES } = await import("./statuses.mjs");
    const declared = new Set([...STATUSES.matchAll(/id:\s*"([a-zA-Z0-9_-]+)"/g)].map(m => m[1]));
    for (const [from, to] of Object.entries(STATUS_ALIASES)) {
        assert.ok(declared.has(to), `${from} → ${to}, which does not exist`);
    }
});

test("the adapter resolves through the alias table on the way out", () => {
    const ADAPTER = read("./adapter.mjs");
    const apply = ADAPTER.slice(ADAPTER.indexOf("async applyStatus("));
    /* The guard between the two grew — widened rather than loosened, so this
     * still asserts the alias runs BEFORE the id is sent. */
    assert.match(apply.slice(0, 2000), /const id = resolveStatus\(statusId\);[\s\S]{0,1600}?statusId: id/);
});

test("every new status has a name key, or it renders as its own key", async () => {
    const { MAGIC_STATUSES } = await import("./statuses.mjs");
    const missing = MAGIC_STATUSES.map(s => s.name).filter(k => !(k in LANG)).sort();
    assert.deepEqual(missing, []);
});

/* ── Localisation ────────────────────────────────────────────────────────── */

test("every key the cast card asks for exists", () => {
    // A missing key renders as the key itself — "WITCHER.Magic.Did.damage" in
    // the middle of a chat card, which nobody notices until a player does.
    const keys = new Set();
    for (const [, k] of CAST.matchAll(/localize\("([^"]+)"\)/g)) keys.add(k);
    for (const [, k] of CAST.matchAll(/format\("([^"]+)"/g)) keys.add(k);
    /* Template keys, resolved at runtime from the outcome or the effect kind. */
    for (const outcome of ["hit", "miss", "success", "fumble", "aborted"]) keys.add(`WITCHER.Magic.Outcome.${outcome}`);
    for (const [, k] of CAST.matchAll(/`WITCHER\.Magic\.Did\.\$\{[^}]+\}`/g)) keys.delete(k);
    for (const [, kind] of CAST.matchAll(/t\("(\w+)",/g)) keys.add(`WITCHER.Magic.Did.${kind}`);

    const missing = [...keys]
        .filter(k => !k.includes("${"))
        .filter(k => !(k in LANG))
        .sort();
    assert.deepEqual(missing, [], `${missing.length} keys render as their own name`);
});

test("every key the adapter asks for exists", () => {
    const ADAPTER = read("./adapter.mjs");
    const keys = new Set();
    for (const [, k] of ADAPTER.matchAll(/localize\("([^"]+)"\)/g)) keys.add(k);
    for (const [, k] of ADAPTER.matchAll(/format\("([^"]+)"/g)) keys.add(k);
    const missing = [...keys].filter(k => !(k in LANG)).sort();
    assert.deepEqual(missing, [], `${missing.length} missing`);
});

test("the language file keeps its original order", () => {
    // It is not alphabetical and never has been. Sorting it would produce a
    // diff nobody can review against a file with seven thousand keys in it.
    const keys = Object.keys(LANG);
    assert.notDeepEqual(keys, [...keys].sort(), "the file was re-sorted");
});


/* The panel is rendered, not grepped: its field names are templated in, so
 * source text is the wrong instrument for asking what it edits. */
let _lawHTML = null;
function require_lawHTML() {
    if (!_lawHTML) throw new Error("lawHTML not loaded — see the before hook");
    return { lawHTML: _lawHTML };
}
test.before(async () => { ({ lawHTML: _lawHTML } = await import("./canvas/dom.mjs")); });

test("BOTH engines aim before they ask", async () => {
    /* You point the spell, then decide how much to pour into it — not the
     * other way round. The authored engine orders its stages; the original
     * engine used to run its template harvest some four hundred lines AFTER
     * the dialog, so the same click behaved differently depending on whether
     * the spell happened to have blocks on it.
     *
     * Asserted on POSITION because that is exactly what went wrong: both calls
     * were present, in the wrong order. */
    const { STAGES } = await import("./frame.mjs");
    const order = STAGES.map(([label]) => label.replace(/^L\d+ /, ""));
    assert.ok(order.indexOf("targets") < order.indexOf("declare"),
        `authored engine: ${order.join(" -> ")}`);

    const harvest = MIXIN.indexOf("await pickAreaTargets({ actor: this, item })");
    const dialog  = MIXIN.indexOf("const decl = await this.declareCast(item");
    assert.ok(harvest > 0 && dialog > 0, "one of the two calls has moved — update this test");
    assert.ok(harvest < dialog,
        "the original engine still opens its dialog before placing the template");
});
