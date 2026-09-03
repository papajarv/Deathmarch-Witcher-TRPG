/**
 * Layout, as data.
 *
 * Every function here returns plain objects describing what should be on
 * screen — never DOM, never a string of HTML. A renderer turns the spec into
 * elements; a test asserts on the spec. That separation is why the geometry of
 * a nested gate can be checked without a browser, and why the same spec drives
 * both the Foundry application and the standalone preview.
 */

import { SHAPE, getBlock } from "../registry.mjs";
import { FRAME_DEFAULTS } from "../context.mjs";
import { paletteEntry, labelParts } from "./palette.mjs";
import { blockTitle } from "./legality.mjs";

/** Indent, in pixels, applied per level of nesting inside a gate. */
export const INDENT = 18;

/**
 * Spec for one authored node and everything under it.
 *
 * `path` is the address the drag layer uses, so a rendered block always knows
 * where it lives without the DOM having to be walked backwards.
 */
export function nodeSpec(node, { path = [], index = 0, depth = 0 } = {}) {
    const def = getBlock(node.b);
    if (!def) {
        return {
            kind: "unknown", id: node.b, path, index, depth,
            title: `Missing block: ${node.b}`,
            hint: namespaceOf(node.b) === "core"
                ? "This spell was built with a version of the engine that had a block this one doesn't."
                : `This spell needs the “${namespaceOf(node.b)}” add-on, which isn't installed.`
        };
    }

    const entry = paletteEntry(def);
    const spec = {
        kind: "block",
        id: def.id, path, index, depth,
        shape: def.shape,
        category: entry.category,
        hue: entry.hue,
        title: blockTitle(def.id.split(":")[1]),
        /* Slots are interleaved with the label text, so the block reads as a
         * sentence rather than as a form with captions above it. */
        parts: labelParts(def.label).map(p =>
            p.kind === "text" ? p : slotSpec(p.key, def.inputs[p.key], node.a?.[p.key])),
        /* Arguments the label does not mention still need somewhere to live,
         * or a spell can carry a value nobody can see or change. */
        extras: Object.entries(def.inputs)
            .filter(([k]) => !def.label.includes(`[${k}]`))
            .filter(([, spec]) => spec.type !== "boolean" || true)
            .map(([k, spec]) => slotSpec(k, spec, node.a?.[k])),
        holdsBody: entry.holdsBody,
        deferred: def.shape === SHAPE.DEFERRED,
        body: null
    };

    if (entry.holdsBody) {
        spec.body = (node.body ?? []).map((child, i) =>
            nodeSpec(child, { path: [...path, index, "body"], index: i, depth: depth + 1 }));
        /* An empty gate gets a landing strip rather than collapsing to nothing,
         * because an author has to be able to aim at it. */
        spec.emptyBody = spec.body.length === 0;
    }
    return spec;
}

const namespaceOf = (id) => String(id ?? "").split(":")[0] || "core";

/** Spec for one editable argument. */
export function slotSpec(key, input, value) {
    if (!input) return { kind: "text", text: `[${key}]` };
    const common = { kind: "slot", key, label: humaniseKey(key), value: value ?? input.default ?? null };

    switch (input.type) {
        case "enum":
            return { ...common, control: "choice",
                     options: Array.isArray(input.options) ? input.options : null,
                     vocabulary: typeof input.options === "string" ? input.options.slice(1) : null };
        case "expression":
            return { ...common, control: "expression", numeric: !!input.numeric };
        case "lifetime":
            return { ...common, control: "lifetime" };
        case "list":
            return { ...common, control: "list", value: value ?? [] };
        case "boolean":
            return { ...common, control: "toggle", value: !!value };
        case "map":
            return { ...common, control: "map", value: value ?? {} };
        default:
            return { ...common, control: "text" };
    }
}

/** `damageType` -> `damage type`. Only ever shown, never matched against. */
export function humaniseKey(key) {
    return String(key ?? "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

/**
 * Spec for a whole entry point — the hat block and the stack beneath it.
 *
 * The hat is not decoration. A tree with no trigger above it has no meaning:
 * the same blocks under "when it hits" and under "when damage reaches you" are
 * two different spells, and the entry decides what is even available.
 */
export function entrySpec(entry, tree, { label, scope, hint = "" }) {
    return {
        kind: "entry",
        entry, label, scope, hint,
        emptyHint: `blocks here run ${hint || "when this fires"}`,
        body: (tree ?? []).map((node, i) => nodeSpec(node, { path: [], index: i, depth: 0 })),
        empty: !(tree ?? []).length
    };
}

/** Spec for the whole item: its frame summary, then every entry it declares. */
export function spellSpec(spell, { entryLabels = {}, entryScopes = {} } = {}) {
    return {
        kind: "spell",
        name: spell.name,
        frame: frameSummary(spell.frame),
        entries: Object.entries(spell.on ?? {}).map(([entry, tree]) =>
            entrySpec(entry, tree, {
                label: entryLabels[entry] ?? entry,
                scope: entryScopes[entry] ?? []
            }))
    };
}

/**
 * The frame, rendered as read-only facts rather than as blocks.
 *
 * This is the law/behaviour split made visible, and it is the single most
 * important thing the canvas communicates. Cost, targeting, defence, element
 * and duration are NOT authorable — they are enforced by the frame, in the
 * same order, for every castable in the game. Showing them as blocks would
 * invite an author to delete the stamina cost, and an engine where that is
 * expressible is an engine where it eventually happens.
 */
export function frameSummary(authored = {}) {
    /* Merged with the defaults, because the merged frame is what the ENGINE
     * runs: `castFrame` uses `{...FRAME_DEFAULTS, ...frame}`. Summarising the
     * raw authored object instead would show one thing and do another — and it
     * crashed outright on `{}`, which is the frame every unprogrammed spell in
     * the world has, so the config layer threw on the first spell anyone
     * opened. */
    const frame = { ...FRAME_DEFAULTS, ...authored };
    const out = [];
    const cost = frame.cost ?? {};
    out.push({ key: "Costs", value:
        cost.mode === "fixed"    ? `${cost.amount} STA`
      : cost.mode === "variable" ? `${cost.min}–${cost.max} STA, your choice`
      : cost.mode === "banded"   ? Object.entries(cost.bands ?? {}).map(([n, l]) => `${n} → ${l}`).join(", ")
      : cost.mode === "derived"  ? "worked out at cast time"
      : "nothing" });

    const t = frame.targeting ?? {};
    out.push({ key: "Reaches", value:
        t.mode === "self"   ? "yourself"
      : t.mode === "point"  ? `a spot${frame.range ? ` up to ${frame.range}m away` : ""}`
      : t.mode === "area"   ? `a ${t.size}m ${t.shape}${t.excludeCaster ? ", not counting you" : ""}`
      : t.count == null     ? "any number of targets"
      : `${t.count} target${t.count === 1 ? "" : "s"}${frame.range ? ` within ${frame.range}m` : ""}` });

    const d = frame.defence ?? {};
    /* A spell aimed at a PLACE has nobody to oppose it, so a defence declared
     * on it is never rolled at cast time — Ice Slick's Dodge is for whoever
     * crosses the ice afterwards, which its zone handles. Saying "Dodge" and
     * rolling nothing is exactly the kind of quiet mismatch that makes an
     * engine untrustworthy. */
    /* A DC is checked against the caster's own roll and needs nobody to
     * oppose it, so Control Water's "difficulty the GM sets" is real even
     * with no targets. Only a defence somebody has to ROLL goes unused. */
    const rolledByATarget = d.type && !["none", "dc", "stat"].includes(d.type);
    if (t.mode === "point" && rolledByATarget) {
        out.push({ key: "Opposed by", value:
            `nothing at cast time — ${humaniseKey(d.type)} is rolled by whoever it catches later` });
    } else
    out.push({ key: "Opposed by", value:
        d.type === "none" ? "nothing — but Dispel and Heliotrope are always offered"
      : d.type === "dc"   ? (d.dc === "gm" ? "a difficulty the GM sets" : `a flat DC ${d.dc}`)
      : d.type === "stat" ? `the target's ${String(d.stat ?? "").toUpperCase()}×${d.multiplier ?? 1}`
      : humaniseKey(d.type) });

    out.push({ key: "Element", value: frame.element === "inherit" ? "whatever the caster is" : frame.element });

    const du = frame.duration ?? {};
    out.push({ key: "Lasts", value:
        du.kind === "instant" ? "no time at all"
      : du.kind === "active"  ? `as long as you pay ${upkeepText(du.upkeep)} a round`
      : du.value != null      ? `${du.value} ${du.kind}`
      : humaniseKey(du.kind ?? "instant") });

    if (frame.recastLock) out.push({ key: "Also", value: "can't be cast again while one is up" });
    return out;
}

const upkeepText = (u) =>
    u === "initial" ? "the initial cost"
  : u === "half"    ? "half the initial cost"
  : `${u} STA`;
