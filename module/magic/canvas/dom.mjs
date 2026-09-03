/**
 * Spec → HTML.
 *
 * The only place in the canvas that knows what an element is. Everything above
 * it — layout, legality, the palette — is plain data, which is what lets the
 * whole editor be exercised in a node test and what lets the same code render
 * inside Foundry and in a standalone preview without a branch.
 *
 * Returns strings rather than nodes on purpose: Foundry's HandlebarsApplication
 * wants markup, and a string is trivially snapshot-testable.
 */

import { INDENT } from "./render.mjs";
import { phrase } from "./phrase.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** One authored node and everything under it. */
export function blockHTML(spec) {
    if (spec.kind === "unknown") {
        return `<div class="wm-unknown"><strong>${esc(spec.title)}</strong><br>${esc(spec.hint)}</div>`;
    }

    const addr = `${spec.path.join(".")}|${spec.index}`;
    const head = `
        <div class="wm-blk" style="--h:${spec.hue}" draggable="true"
             tabindex="0" role="treeitem" data-block="${esc(spec.id)}" data-at="${esc(addr)}"
             aria-label="${esc(spec.title)}">
            <div class="wm-blk-line">${spec.parts.map(partHTML).join("")}${
                spec.deferred ? `<span class="wm-defer-tag">later</span>` : ""}</div>
            ${extrasHTML(spec.extras)}
        </div>`;

    if (!spec.holdsBody) return head;

    return `
        <div class="wm-gate${spec.deferred ? " wm-gate--deferred" : ""}" style="--h:${spec.hue}">
            ${head}
            <div class="wm-body" data-body="${esc(addr)}">
                ${spec.emptyBody
                    ? `<div class="wm-drop">${esc(dropHint(spec))}</div>`
                    : spec.body.map(blockHTML).join("")}
            </div>
            <div class="wm-gate-foot"></div>
        </div>`;
}

/**
 * What an empty gate says.
 *
 * "Drop blocks here" is true of every gate and therefore tells nobody
 * anything. A deferred gate's body runs in a context the author is not
 * standing in, and that is the single most confusing thing about the shape.
 */
function dropHint(spec) {
    return spec.deferred
        ? "blocks here run later, for whoever this catches"
        : "blocks here run when this holds";
}

function partHTML(p) {
    if (p.kind === "text") {
        const t = p.text.trim();
        return t ? `<span class="wm-blk-word">${esc(t)}</span>` : "";
    }
    return slotHTML(p);
}

function slotHTML(s) {
    const shown = displayValue(s);
    const empty = shown === "" || shown == null;

    /* An expression that depends on the cast is shown in ENGLISH, with the
     * formula kept as the tooltip and as the thing you edit.
     *
     * `max(1,8-{index})d6` is exactly right and completely opaque, and it was
     * the only place on the block that said Alzur's Thunder loses a die per
     * target — so the most interesting fact about the spell was written in a
     * notation nobody reads. Plain literals like `4d6` are left alone: they
     * are already English, and annotating them teaches people to stop reading
     * the annotations. */
    const said = s.control === "expression" && !empty ? phrase(shown) : null;

    return `<span class="wm-slot${empty ? " wm-slot--empty" : ""}${said ? " is-said" : ""}"
                  data-control="${esc(s.control)}" data-key="${esc(s.key)}"
                  role="button" tabindex="0"
                  title="${esc(said ? `${s.label}: ${shown}` : s.label)}">${
        esc(empty ? s.label : (said ?? shown))
    }</span>`;
}

/**
 * Every argument the label does not mention — including the ones that are empty.
 *
 * They used to be filtered to those that already had a value, which is the
 * same failure as not rendering them at all: an argument you cannot see is one
 * you cannot set. That is how a 30-SP rock wall shipped with no armour, and
 * hiding the empties reintroduced it one level down — the block had an `sp`
 * input, and nothing on screen said so until somebody had already filled it in.
 *
 * An unset argument shows what it wants instead of its value, so the block
 * says what it can do rather than only what it is doing.
 */
function extrasHTML(extras) {
    if (!extras?.length) return "";
    return `<div class="wm-extras">${extras.map(e => {
        const empty = displayValue(e) === "" || displayValue(e) == null;
        return `<span class="wm-extra${empty ? " is-unset" : ""}">
            <span class="wm-extra-key">${esc(e.label)}</span>${slotHTML(e)}
        </span>`;
    }).join("")}</div>`;
}

function displayValue(s) {
    if (s.control === "toggle") return s.value ? "yes" : "no";
    if (s.control === "list")   return Array.isArray(s.value) && s.value.length ? s.value.join(", ") : "";
    if (s.control === "map")    return Object.keys(s.value ?? {}).length
        ? Object.entries(s.value).map(([k, v]) => `${k} = ${v}`).join("  ") : "";
    if (Array.isArray(s.value)) return s.value.join(" or ");
    return s.value == null ? "" : String(s.value);
}

/** One entry point: its hat, and the stack beneath it. */
export function entryHTML(spec) {
    return `
        <section class="wm-stack" data-entry="${esc(spec.entry)}">
            <div class="wm-hat">
                <p class="wm-hat-title">${esc(spec.label)}</p>
                ${/* WHEN it fires, on the hat itself. The scope line that used
                     to sit here — "you already have targets" — answers a
                     question about which blocks fit, not the question someone
                     reading a spell is asking. It moved to the tooltip. */""}
                <p class="wm-hat-when" title="${esc(scopeLine(spec.scope))}">${esc(spec.hint ?? "")}</p>
            </div>
            ${spec.empty
                ? `<div class="wm-drop">${esc(spec.emptyHint ?? "nothing happens yet")}</div>`
                : spec.body.map(blockHTML).join("")}
        </section>`;
}

/**
 * What this entry hands its tree, in words. Now a tooltip rather than a line.
 *
 * Still worth having: it is the reason a block is greyed out in the rail, and
 * without it the greying looks arbitrary. But it is a second-order question,
 * and it was occupying the space where "when does this run" belonged.
 */
function scopeLine(scope = []) {
    const words = scope.filter(s => s !== "caster").map(s =>
        s === "targets" ? "you already have targets" : "an attack is in flight");
    return words.length ? words.join(" · ") : "no targets yet";
}

/**
 * The frame — and it is EDITABLE, because it is the only place these fields
 * live now.
 *
 * They used to be here as read-only prose and again as a form below the
 * canvas: cost, range, defence, element, duration, targeting, twice each. That
 * is not redundancy with the block engine, it is redundancy with itself — a
 * spell's stamina cost IS the frame's cost — and meeting the same eight
 * settings in two places on one sheet is most of why this felt overwhelming.
 *
 * The inputs write to the LEGACY field names on purpose. Every other part of
 * the system reads `system.staminaCost` and `system.defense` — chat cards, the
 * actor sheet's spell list, the compendium browser — and the frame derives
 * from them. One set of fields, one owner, everything downstream unchanged.
 */
export function lawHTML(item, facts, note, vocab = {}) {
    const sys = item.system ?? {};
    /* The sheet supplies these from CONFIG so a module can extend them. The
     * fallbacks are RAW and exist so the panel is never an empty box — a
     * control with no options reads as broken, not as unconfigured. */
    const v = { ...FALLBACK_VOCAB, ...vocab, t: { ...FALLBACK_VOCAB.t, ...(vocab.t ?? {}) } };
    /* `wide` is set explicitly rather than inferred with `:has()`. This
     * codebase already carries a note about Chromium's `:has()` invalidation
     * being unreliable here, and a layout that silently stops spanning is not
     * worth the cleverness. */
    const row = (label, control, wide = false) =>
        `<div class="wm-law-row${wide ? " is-wide" : ""}">
            <span class="wm-law-key">${esc(label)}</span>${control}
        </div>`;

    return `
        <div class="wm-law-inner">
            <p class="wm-law-kind">${esc(v.formLabel ?? "spell")}</p>
            <h2 class="wm-law-name">${esc(item.name ?? "")}</h2>
            <hr class="wm-law-rule">

            <div class="wm-law-fields">
                ${/* Cost is ONE setting with two modes, not a number and an
                     unrelated checkbox beside it. And the variable mode is not
                     redundant with the blocks — it is what FEEDS them: the
                     frame prompts, spends, and publishes the result as `{sta}`,
                     which is the only reason Igni can say `{sta}d6`. A block
                     cannot do it, because it has to happen before any block
                     runs and before the roll. */""}
                ${row(v.t.cost ?? "Costs", `
                    <span class="wm-law-pair">
                        <input type="number" name="system.staminaCost" data-dtype="Number"
                               value="${esc(sys.staminaCost ?? 0)}" min="0" aria-label="${esc(v.t.cost ?? "Costs")}">
                        <span class="wm-mode">
                            <label class="wm-mode-opt${sys.variableCost ? "" : " is-on"}">
                                <input type="radio" name="system.variableCost" data-dtype="Boolean"
                                       value="false" ${sys.variableCost ? "" : "checked"}>
                                ${esc(v.t.costFixed ?? "exactly")}
                            </label>
                            <label class="wm-mode-opt${sys.variableCost ? " is-on" : ""}">
                                <input type="radio" name="system.variableCost" data-dtype="Boolean"
                                       value="true" ${sys.variableCost ? "checked" : ""}>
                                ${esc(v.t.costVariable ?? "up to")}
                            </label>
                        </span>
                    </span>
                    ${sys.variableCost ? `<span class="wm-law-note">${esc(v.t.costVariableNote ?? "")}</span>` : ""}`, true)}

                ${row(v.t.range ?? "Reaches", `
                    <input type="text" name="system.range" data-dtype="String" value="${esc(sys.range ?? "")}"
                           placeholder="${esc(v.t.rangeHint ?? "10m")}">`)}

                ${/* Targeting and its shape are ONE row, and the shape appears
                     the instant "an area" is chosen — beside the control that
                     chose it, not in a separate section further down. Hiding
                     the only place a cone can be defined behind a dropdown
                     nobody knew to touch is how "how do I make Aard a 2m cone"
                     becomes an unanswerable question. */""}
                ${row(v.t.targeting ?? "Targets", `
                    <span class="wm-law-pair">
                        ${select("system.targetType", v.targets, sys.targetType)}
                        ${sys.targetType === "area" ? `
                            ${select("system.areaShape", v.shapes, sys.areaShape)}
                            <span class="wm-law-unit">
                                <input type="number" name="system.areaSize" data-dtype="Number"
                                       value="${esc(sys.areaSize ?? 0)}" min="0"
                                       aria-label="${esc(v.t.areaSize ?? "size in metres")}">
                                <span class="wm-law-suffix">m</span>
                            </span>` : ""}
                    </span>
                    ${sys.targetType === "area" ? `
                        <label class="wm-toggle${sys.areaExcludeCaster ? " is-on" : ""}">
                            <input type="checkbox" name="system.areaExcludeCaster" data-dtype="Boolean"
                                   ${sys.areaExcludeCaster ? "checked" : ""}>
                            <span>${esc(v.t.excludeCaster ?? "spares you")}</span>
                        </label>
                        ${/* Anchor — where the template originates. "on you" locks its
                             origin to the caster's token (Igni-style cone/line that
                             emanates from you, aim direction only); "free-placed" drops
                             it anywhere in range (Alzur's Thunder as authored). A string
                             enum, so a select rather than a checkbox — persists through
                             the same form machinery as the shape control beside it. */""}
                        <label class="wm-law-anchor" title="On you: the template emanates from your token (aim direction only). Free-placed: drop it anywhere in range.">
                            <span class="wm-law-anchor-key">${esc(v.t.anchor ?? "Anchored")}</span>
                            ${select("system.areaAnchor", v.anchors, sys.areaAnchor ?? "caster")}
                        </label>` : ""}`, true)}

                ${row(v.t.defence ?? "Opposed by", multi("system.defense", v.defences, sys.defense ?? []), true)}

                ${row(v.t.element ?? "Element", select("system.school", v.schools, sys.school))}

                ${row(v.t.duration ?? "Lasts", `
                    <span class="wm-law-pair">
                        <input type="text" name="system.duration.value" data-dtype="String" value="${esc(sys.duration?.value ?? "")}"
                               placeholder="${esc(v.t.durationHint ?? "1d10")}">
                        ${select("system.duration.unit", v.units, sys.duration?.unit)}
                    </span>`, true)}
            </div>

            ${note ? `<p class="wm-law-note">${esc(note)}</p>` : ""}

            ${/* What those settings ADD UP TO, in the engine's words. Not a
                  second copy of them — the one line an author cannot work out
                  by reading the boxes, like a maintained spell's upkeep or a
                  sign's 7-STA cap. */""}
            ${facts?.length ? `<details class="wm-law-reads" open><summary>${
                esc(v.t.reads ?? "How the engine reads this")}</summary>
                <dl class="wm-facts">${facts.map(f =>
                    `<dt>${esc(f.key)}</dt><dd>${esc(f.value)}</dd>`).join("")}</dl></details>` : ""}
        </div>`;
}

/** RAW vocabularies. Overridden by whatever the sheet passes in. */
const FALLBACK_VOCAB = Object.freeze({
    formLabel: "spell",
    targets:  [{ value: "direct", label: "one target" }, { value: "area", label: "an area" },
               { value: "self", label: "yourself" }],
    shapes:   [{ value: "radius", label: "radius" }, { value: "cone", label: "cone" },
               { value: "line", label: "line" }, { value: "rect", label: "rectangle" },
               { value: "sphere", label: "sphere" }],
    defences: [{ value: "dodge", label: "Dodge" }, { value: "block", label: "Block" },
               { value: "resistmagic", label: "Resist Magic" },
               { value: "spellcasting", label: "Spell Casting" }],
    schools:  [{ value: "mixed", label: "Mixed" }, { value: "earth", label: "Earth" },
               { value: "air", label: "Air" }, { value: "fire", label: "Fire" },
               { value: "water", label: "Water" }],
    units:    [{ value: "instant", label: "instant" }, { value: "rounds", label: "rounds" },
               { value: "minutes", label: "minutes" }, { value: "hours", label: "hours" },
               { value: "days", label: "days" }, { value: "permanent", label: "permanent" }],
    anchors:  [{ value: "caster", label: "on you (aim only)" }, { value: "free", label: "free-placed" }],
    t: {
        cost: "Costs", costFixed: "exactly", costVariable: "up to",
        costVariableNote: "The caster picks how much to spend, and the blocks can use it as {sta}.",
        range: "Reaches", rangeHint: "10m", targeting: "Targets", area: "Area",
        excludeCaster: "spares you", areaSize: "size in metres", anchor: "Anchored",
        defence: "Opposed by", element: "Element",
        duration: "Lasts", durationHint: "1d10", reads: "How the engine reads this"
    }
});

function select(name, options = [], current) {
    return `<select name="${esc(name)}">${options.map(o =>
        `<option value="${esc(o.value)}"${o.value === current ? " selected" : ""}>${esc(o.label)}</option>`
    ).join("")}</select>`;
}

/**
 * Defence, as a row of toggles rather than a row of checkboxes.
 *
 * A spell can offer more than one and the DEFENDER chooses between them —
 * `Dodge or Block` is one decision, not two rolls. A wrapping list of
 * checkboxes says neither: it reads as four independent settings, the labels
 * wrap raggedly, and nothing shows that picking none is the common case (52 of
 * the 103 core entries are `Defense: None`).
 *
 * Toggles read as one control with several states, they line up, and the
 * selected ones are visible at a glance from across the sheet.
 */
function multi(name, options = [], current = []) {
    const chosen = new Set((Array.isArray(current) ? current : [current]).filter(Boolean));
    const toggles = options.map(o => `
        <label class="wm-toggle${chosen.has(o.value) ? " is-on" : ""}" title="${esc(o.label)}">
            <input type="checkbox" name="${esc(name)}" value="${esc(o.value)}"
                   data-dtype="String"
                   ${chosen.has(o.value) ? "checked" : ""}>
            <span>${esc(o.label)}</span>
        </label>`).join("");

    /* What "none picked" MEANS, said where the decision is made. It is not an
     * omission — the rules define an undefended spell as still answerable by
     * Dispel or Heliotrope, so it is a real choice with a real consequence. */
    const none = chosen.size ? "" :
        `<span class="wm-toggle-note">${esc(NONE_NOTE)}</span>`;

    return `<span class="wm-toggle-row">${toggles}</span>${none}`;
}

const NONE_NOTE = "Undefended — but Dispel and Heliotrope are always offered.";

/** The palette rail. `dim` is a Set of ids that could never fit this entry. */
export function railHTML(groups, dim = new Set()) {
    return groups.map(g => `
        <div class="wm-cat">
            <p class="wm-eyebrow">${esc(g.label)}</p>
            <p class="wm-blurb">${esc(g.blurb)}</p>
        </div>
        <div class="wm-rail-list">
            ${g.blocks.map(b => `
                <button type="button" class="wm-chip" style="--h:${b.hue}"
                        draggable="true" data-block="${esc(b.id)}"
                        data-dim="${dim.has(b.id)}">
                    ${esc(readable(b.id))}
                    ${b.holdsBody ? `<span class="wm-chip-shape">wraps</span>` : ""}
                </button>`).join("")}
        </div>`).join("");
}

const readable = (id) => {
    const n = id.split(":")[1].replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
    return n.charAt(0).toUpperCase() + n.slice(1);
};

export { INDENT };
