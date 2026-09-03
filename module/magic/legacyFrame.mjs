/**
 * Deriving a frame from the fields a spell already carries.
 *
 * This is what makes the engine a REPLACEMENT rather than a second system
 * running beside the first.
 *
 * Every spell in the world already declares its cost, range, defence, school,
 * tier and duration — the sheet has had those fields for as long as it has
 * existed. Those ARE the frame; they were simply spelled differently. So no
 * spell needs its frame configured by hand, and the only thing an author has
 * to build is what the spell DOES.
 *
 * The alternative was asking people to re-enter twenty-seven fields they had
 * already filled in, which is how a migration becomes a thing nobody performs.
 *
 * The derivation is one-way and non-destructive: it reads the legacy fields
 * and never writes them. A frame stored on the item always wins, so editing
 * the frame in the canvas is permanent and re-deriving cannot undo it.
 */

import { FRAME_DEFAULTS } from "./context.mjs";

/* The sheet's defence keys are lowercase and jammed together; the engine's are
 * camelCase and distinguish "either" from "both". `Dodge or Block` is ONE
 * choice offered to the defender, not two defences. */
const DEFENCE = Object.freeze({
    resistmagic:  "resistMagic",
    resistMagic:  "resistMagic",
    dodge:        "dodge",
    block:        "block",
    spellcasting: "spellCasting",
    spellCasting: "spellCasting",
    none:         "none"
});

/**
 * Shape names, reconciled with the system's own.
 *
 * The engine grew its own vocabulary while the corpus was being authored —
 * `rect`, `sphere` — and the system has had `cube`, `radius` all along. The
 * two never met, so four spells carried a shape the aiming overlay could not
 * map and silently targeted NOBODY: Tanio Ilchar, Part Water, Aard Sweep and
 * Ice Slick. No error, no warning; the cast just landed on no one.
 *
 * One vocabulary now, and it is the system's, because that is what the
 * template layer and the sheet's dropdown already speak.
 */
export const SHAPE = Object.freeze({
    rect:   "cube",
    square: "cube",
    sphere: "radius",   /* a sphere is a radius that also has height, and the
                           template layer draws circles */
    circle: "radius",
    ray:    "line"
});

/** The system's name for a shape, whatever the engine called it. */
export function shapeName(shape) {
    if (!shape) return null;
    return SHAPE[shape] ?? shape;
}

const DURATION = Object.freeze({
    instant:   "instant",
    immediate: "instant",
    rounds:    "rounds",
    minutes:   "minutes",
    hours:     "hours",
    days:      "days",
    /* The sheet offers months and years; the lifetime clock counts rounds,
     * minutes, hours and days. Anything longer became an effect that never
     * ticked and therefore never ended — permanent, silently. Converted to
     * days, which the clock can actually advance. */
    months:    "days",
    years:     "days",
    permanent: "permanent"
});

/** How many days a longer unit is worth, for the conversion above. */
const DAYS_IN = Object.freeze({ months: 30, years: 365 });

/**
 * Build a frame from a spell's own system data.
 *
 * `system.magic.frame` wins wherever it is set — an author who has touched the
 * frame in the canvas must not have it quietly overwritten by a field they
 * edited months ago on the other side of the sheet.
 */
export function frameFor(system = {}) {
    return { ...FRAME_DEFAULTS, ...derive(system), ...(system.magic?.frame ?? {}) };
}

/** The derivation itself, exported so it can be tested without the merge. */
export function derive(system = {}) {
    const out = {};

    out.kind = system.spellForm === "sign" ? "sign"
             : system.spellForm === "invocation" ? "invocation"
             : system.spellForm || "spell";

    out.tier = system.spellType || "novice";

    /* `school` is the engine's `element`. A priest's invocation carries no
     * school of its own and resolves Mixed from the caster, which is what
     * `inherit` means. */
    out.element = out.kind === "invocation" ? "inherit" : (system.school || "mixed");

    /* Signs cap at 7 STA per cast (Core p.115), and that cap is law rather
     * than a suggestion — it holds regardless of what the field says. */
    if (system.variableCost) {
        out.cost = { mode: "variable", min: 1, max: out.kind === "sign" ? 7 : Math.max(1, Number(system.staminaCost) || 7) };
    } else {
        out.cost = { mode: "fixed", amount: Math.max(0, Number(system.staminaCost) || 0) };
    }

    out.range = parseRange(system.range);
    out.targeting = targetingFrom(system);
    out.defence = defenceFrom(system);
    out.duration = durationFrom(system);

    return out;
}

/**
 * The inverse of `frameFor` — a frame written back onto the sheet's own fields.
 *
 * Loading a spell from the book wrote `system.magic.frame` and `system.magic.on`
 * and nothing else, and the CAST DIALOG does not read the frame: it reads
 * `system.staminaCost` and `system.variableCost`, exactly as it always has for
 * the original engine. So a spell loaded from the book arrived with a correct
 * cone, a correct defence, correct blocks — and a stamina cost of ZERO. Aard
 * was free, and the sheet showed "no area" next to a spell that is a 2m cone.
 *
 * Only fields the frame actually determines are returned, so anything the
 * author had already set for themselves and the frame says nothing about is
 * left alone.
 */
export function sheetFieldsFor(frame = {}, on = null) {
    const out = {};

    /* The DAMAGE fields, read off the tree's first damage block.
     *
     * An authored spell keeps its damage in `core:dealDamage`, and the rest of
     * the system reads `system.damageFormula` / `damageElement` / `damageType`:
     * the cast dialog only renders its damage panel when `damageFormula` is
     * non-empty, and `zoneEffects` stamps `damageElement` onto a zone. Left
     * blank, a spell that plainly deals 3d6 fire showed no damage at all on the
     * card it is cast from.
     *
     * Mirrored, not moved — the block stays the source of truth and this is a
     * readable copy for the surrounding system. */
    if (on) {
        const find = (body) => {
            for (const n of body ?? []) {
                if (n?.b === "core:dealDamage") return n;
                const inner = find(n?.body);
                if (inner) return inner;
            }
            return null;
        };
        const dmg = Object.values(on).map(find).find(Boolean);
        if (dmg) {
            out["system.damageFormula"] = String(dmg.a?.formula ?? "");
            out["system.damageType"]    = String(dmg.a?.damageType ?? "none");
            /* The ELEMENT is the spell's school; `damageType` is the kind of
             * harm. The block names the second, the frame names the first. */
            if (frame.element && frame.element !== "inherit") {
                out["system.damageElement"] = frame.element;
            }
        }
    }

    const cost = frame.cost ?? {};
    if (cost.mode === "variable") {
        out["system.variableCost"] = true;
        /* The sheet's number is the CAP for a variable cost (see frameFor),
         * and the dialog offers 1..cap. */
        out["system.staminaCost"] = Math.max(1, Number(cost.max) || 7);
    } else if (cost.mode === "fixed") {
        out["system.variableCost"] = false;
        out["system.staminaCost"] = Math.max(0, Number(cost.amount) || 0);
    } else if (cost.mode === "banded") {
        /* The dialog cannot express a ladder, so it offers the cheapest rung;
         * the band actually bought is resolved from what was spent. */
        const rungs = Object.keys(cost.bands ?? {}).map(Number).filter(Number.isFinite);
        out["system.variableCost"] = true;
        out["system.staminaCost"] = rungs.length ? Math.max(...rungs) : 1;
    }

    const t = frame.targeting ?? {};
    if (t.mode) {
        out["system.targetType"] = t.mode === "area" ? "area" : t.mode;
        if (t.mode === "area") {
            out["system.areaShape"] = t.shape ?? "radius";
            out["system.areaSize"]  = Number(t.size) || 0;
            if (t.excludeCaster != null) out["system.areaExcludeCaster"] = t.excludeCaster !== false;
            /* Anchor. An explicit `targeting.anchor` on the preset wins; failing
             * that, a shape default — cones and lines emanate FROM the caster
             * (Igni, Aard, Alzur's Thunder), so they lock to the caster's token,
             * while area-at-a-point shapes (radius / sphere / cube / rect) are
             * placed freely within range. This is what makes "start from book"
             * seed the right anchor instead of leaving the schema default. */
            const anchor = t.anchor
                ?? (["cone", "line"].includes(String(t.shape)) ? "caster" : "free");
            out["system.areaAnchor"] = anchor === "caster" ? "caster" : "free";
        } else {
            out["system.areaShape"] = "none";
            out["system.areaSize"]  = 0;
        }
    }

    if (frame.range != null) out["system.range"] = `${frame.range}m`;
    else if (t.mode === "self") out["system.range"] = "Self";

    /* `defense` is a LIST on the sheet — two entries mean the defender picks. */
    const d = frame.defence ?? {};
    if (d.type === "none")             out["system.defense"] = [];
    else if (d.type === "dc")          out["system.defense"] = ["gm"];
    else if (d.type === "blockOrDodge")out["system.defense"] = ["block", "dodge"];
    else if (d.type && d.type !== "stat") {
        const back = { resistMagic: "resistmagic", spellCasting: "spellcasting" };
        out["system.defense"] = [back[d.type] ?? d.type];
    }

    if (frame.element && frame.element !== "inherit") out["system.school"] = frame.element;
    if (frame.tier) out["system.spellType"] = frame.tier;
    /* `spellForm` is what makes a sign a SIGN to everything outside the engine.
     * Without it a book-loaded Aard was an ordinary spell to the cast dialog:
     * no 7-Stamina cap, and — before the dialog floored a variable cost at 1 —
     * a default spend of ZERO. Aard's knockdown is `10*{sta}` percent, so at
     * zero Stamina it was a 0% chance and the prone rider could never fire, no
     * matter how well the cast rolled. */
    if (frame.kind) out["system.spellForm"] = frame.kind;

    const dur = frame.duration ?? {};
    if (dur.kind === "instant" || dur.kind === "permanent") {
        out["system.duration.unit"]  = dur.kind;
        out["system.duration.value"] = "";
    } else if (dur.kind) {
        out["system.duration.unit"]  = dur.kind;
        if (dur.value != null) out["system.duration.value"] = String(dur.value);
    }

    return out;
}

/** `"10m"`, `"3m Cone"`, `"Self"`, `"N/A"` → a number of metres, or null. */
export function parseRange(range) {
    if (range == null || range === "") return null;
    const m = String(range).match(/(\d+(?:\.\d+)?)\s*m/i);
    return m ? Number(m[1]) : null;
}

function targetingFrom(system) {
    if (system.targetType === "self") return { mode: "self" };

    /* `areaShape` is a STRING whose "unset" value is the word "none", not an
     * empty one — so a bare truthiness test made every spell an area spell.
     *
     * It only ever bit a spell with no authored frame to override the
     * derivation, which is exactly a spell somebody built by hand in the
     * canvas: it resolved as `mode: "area", shape: "none"`, the template layer
     * cannot place a "none", `pickTargets` came back empty, and the cast
     * resolved as an unopposed success that touched nobody. A hand-built spell
     * charged its stamina, rolled, printed "It works." and did nothing at all.
     *
     * The corpus never showed it because every authored entry carries a frame
     * that overrides this. */
    const namedArea = system.areaShape && system.areaShape !== "none";
    if (system.targetType === "area" || namedArea) {
        return {
            mode: "area",
            shape: shapeName(system.areaShape) || "radius",
            size: Number(system.areaSize) || parseRange(system.range) || 1,
            /* "It would be a shame to cast Static Storm in a desperate
             * situation and accidentally wound your whole party" — the book
             * says the exclusion is part of the spell, not a courtesy. */
            excludeCaster: system.areaExcludeCaster !== false
        };
    }

    /* `ignoreTargets` is the sheet's way of saying "this resolves against a
     * place, not a person" — the engine calls it a point, and it is the
     * difference between Ice Slick freezing the floor and Ice Slick
     * attacking whoever happens to be standing near it. */
    if (system.ignoreTargets) return { mode: "point" };

    return { mode: "direct", count: 1 };
}

function defenceFrom(system) {
    /* `gm` is one of the system's defence keys and it is not a skill: it means
     * "the GM sets a difficulty", which the frame models as a DC rather than
     * as something a defender rolls. Passing it through as a defence type
     * would have the engine ask a target to roll their "gm". */
    const keys = Array.isArray(system.defense) ? system.defense : [system.defense];
    if (keys.includes("gm")) return { type: "dc", dc: "gm", ties: "defender" };

    const raw = (Array.isArray(system.defense) ? system.defense : [system.defense])
        .filter(d => d && d !== "none")
        .map(d => DEFENCE[d] ?? d);

    if (!raw.length) return { type: "none", ties: "defender" };

    /* Two entries mean the DEFENDER CHOOSES, which is one defence with two
     * options rather than two defences. Flattening them apart is how "Dodge or
     * Block" ends up rolling twice. */
    const type = raw.length > 1
        ? (raw.includes("dodge") && raw.includes("block") ? "blockOrDodge" : raw[0])
        : raw[0];

    /* The attacker must roll strictly higher — errata p.164. Dispel is the
     * documented exception and it declares its own tie rule. */
    return { type, ties: "defender" };
}

function durationFrom(system) {
    const unit = DURATION[system.duration?.unit] ?? "instant";
    const value = system.duration?.value;

    if (unit === "instant" || unit === "permanent") return { kind: unit };

    /* `Active (2 STA)` is a maintained spell, and the sheet stores the upkeep
     * in the value. Both halves of the rule are law: the per-round cost AND
     * the bar on casting anything else while it holds. */
    /* Three phrasings, and the fraction has to be tried FIRST: the book writes
     * Fire Stream's upkeep as "1/2 Initial STA", and a plain digit match reads
     * that as 1 — a spell costing one Stamina a round instead of half of what
     * you put into it. */
    const raw = String(value ?? "");
    if (!/active/i.test(raw)) {
        if (raw === "") return { kind: unit };
        /* A month is thirty days to the clock that has to count it. */
        const scale = DAYS_IN[system.duration?.unit];
        const n = scale && /^\d+$/.test(raw) ? String(Number(raw) * scale) : raw;
        return { kind: unit, value: n };
    }

    const upkeep = /1\s*\/\s*2|half|½/i.test(raw) ? "half"
                 : /initial/i.test(raw)             ? "initial"
                 : Number(raw.match(/(\d+)/)?.[1]) || 1;
    return { kind: "active", upkeep };

}

/**
 * Has an author actually touched the frame, or is it still derived?
 *
 * The sheet needs to know: a derived frame should follow the legacy fields
 * when they change, and an edited one must not.
 */
export function frameIsDerived(system = {}) {
    return !Object.keys(system.magic?.frame ?? {}).length;
}
