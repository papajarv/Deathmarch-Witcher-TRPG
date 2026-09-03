/**
 * The canvas as a spell sheet's config surface.
 *
 * Everything here is what the SHEET needs and the standalone window did not:
 * markup sized for a panel rather than a page, a trigger picker, and a way to
 * load the book's version of a spell as a starting point.
 *
 * That last one is the correction. The authored corpus was built to prove the
 * block set can express the whole rulebook — it found about twenty gaps doing
 * it — and then I mistook the proof for the product and wrote a tool that
 * baked 103 spell definitions onto items. A spell you cannot then change is
 * the hardwiring this engine replaced. So the corpus is a LIBRARY: load
 * Igni's blocks, then move them.
 */

import { palette } from "./palette.mjs";
import { entrySpec, frameSummary } from "./render.mjs";
import { entryHTML, railHTML, lawHTML } from "./dom.mjs";
import { entryOptions, unreachableIn } from "./legality.mjs";
import { authoredSummary, castStatus, ENTRY_LABELS } from "../summary.mjs";
import { frameFor, frameIsDerived } from "../legacyFrame.mjs";
import { phrase } from "./phrase.mjs";

/* ALL of them, including the ones nothing fires yet: a tree already authored
 * under `afterApply` still has to render, and rendering needs its scope and
 * its hint. Only the "add a trigger" list below hides them. */
const SCOPES = Object.fromEntries(entryOptions({ includeUnfired: true }).map(e => [e.id, e.scope]));
const HINTS  = Object.fromEntries(entryOptions({ includeUnfired: true }).map(e => [e.id, e.hint]));

/**
 * Everything the spell template needs to render the canvas.
 *
 * Returns markup rather than a model because the layout functions already
 * produce strings and are tested that way — handing Handlebars a structure to
 * re-walk would mean a second layout implementation with no tests behind it.
 */
export function canvasContext(item, { focus = null, refusal = null } = {}) {
    const magic = item.system?.magic ?? {};
    const trees = magic.on ?? {};
    const declared = Object.keys(trees);
    const current = focus ?? declared[0] ?? null;

    const groups = palette();
    const dim = unreachableIn(current ?? "hit", groups.flatMap(g => g.blocks));

    /* An entry with no tree yet is still shown — an author who adds "when it
     * misses" and then sees nothing has no way to know it worked. */
    /* The hat says WHO, not just when.
     *
     * "How does the block make Aard a 2m cone" is the right question and the
     * canvas had no answer on it: the cone lives in the frame, no block
     * mentions one, and nothing joined the two. The trigger line now carries
     * the frame's reach, so the thing deciding who these blocks run against is
     * written directly above them. */
    const reach = reachOf(item);
    const entries = declared.map(entry => entryHTML(entrySpec(entry, trees[entry], {
        label: ENTRY_LABELS[entry] ?? entry,
        scope: SCOPES[entry] ?? [],
        hint:  hintFor(entry, HINTS[entry] ?? "", reach)
    })));

    return {
        /* ONE COLUMN.
         *
         * It was three: a permanent palette rail, the blocks, and a permanent
         * frame panel — about 225px of an 800px window gone before a single
         * block was drawn, on every spell, whether or not you were adding
         * anything. On a small monitor that is most of the sheet.
         *
         * Both side panels are now on demand. The frame is a one-line summary
         * that opens to edit; the palette is a popover that overlays rather
         * than reserving space. What is left is the thing you came to look at:
         * the blocks, full width. */
        canvasHTML: `
            <div class="wm-canvas is-lean">
                ${/* Open. Cost, range, defence and duration are the spell's
                     rules; collapsing them by default means opening a spell
                     and being shown nothing about it. The strip still folds
                     for anyone who wants the room, and the state survives a
                     re-render. */""}
                <details class="wm-frame-strip" open>
                    <summary class="wm-frame-line">
                        ${/* A LABEL, then the summary. The strip showed only
                             "5 STA · 12m · Dodge / Block" — which says what is
                             inside it but never what it IS, so the one control
                             that folds away every rule the spell runs under
                             read as a stray line of stats. */""}
                        <span class="wm-frame-label">${
                            game.i18n.localize("WITCHER.Sheet.Spell.Section.Rules")}</span>
                        <span class="wm-frame-glance">${frameGlance(item)}</span>
                    </summary>
                    ${lawHTML(item, frameSummary(frameFor(item.system)), null, frameVocabulary())}
                </details>

                <div class="wm-sheet" role="tree">
                    ${entries.length ? entries.join("") : emptyState()}
                </div>

                ${statusLine(item)}

                <details class="wm-palette-pop">
                    <summary class="wm-palette-open">${
                        game.i18n.localize("WITCHER.Sheet.Spell.Button.AddBlock")}</summary>
                    <div class="wm-palette-panel">
                        <input type="search" class="wm-palette-filter"
                               placeholder="${game.i18n.localize("WITCHER.Sheet.Spell.Text.FilterBlocks")}">
                        <div class="wm-rail">${railHTML(groups, dim)}</div>
                    </div>
                </details>
            </div>`,
        entryChoices: entryOptions().filter(e => !declared.includes(e.id)),
        refusal
    };
}

/**
 * What happens when this is cast — stated permanently, under the blocks.
 *
 * "What if I just don't pick a trigger?" is the right question and the sheet
 * had no answer on it anywhere. Worse, the honest answer has a trap in the
 * middle: a trigger with nothing under it looks finished and behaves exactly
 * like no trigger at all.
 */
function statusLine(item) {
    const status = castStatus(item.system?.magic, item.name);
    return `
        <p class="wm-status is-${status.state}">
            <span class="wm-status-dot" aria-hidden="true"></span>
            ${game.i18n.format(`WITCHER.Sheet.Spell.Text.${status.key}`, status.data)}
        </p>`;
}

/**
 * Who a cast reaches, in words — read off the frame, not off any block.
 *
 * This is the half of a spell that is NOT authorable, and the half people go
 * looking for in the palette. Aard's 2m cone is `targeting`, not a block, and
 * no amount of scrolling the block list will find it.
 */
function reachOf(item) {
    const sys = item.system ?? {};
    if (sys.targetType === "self") return null;
    if (sys.targetType === "area" && sys.areaSize) {
        const shape = game.i18n.localize(
            CONFIG.WITCHER?.magic?.areaShapes?.[sys.areaShape] ?? sys.areaShape ?? "radius");
        return game.i18n.format("WITCHER.Sheet.Spell.Text.ReachArea",
                                { size: sys.areaSize, shape: String(shape).toLowerCase() });
    }
    return null;
}

/** Fold the reach into the trigger's own line, where it applies. */
function hintFor(entry, hint, reach) {
    /* Only for the triggers that run against the cast's targets. An
     * interception fires for whoever is carrying the effect, and the cast's
     * cone has nothing to do with it. */
    const usesCastTargets = entry === "hit" || entry === "miss";
    if (!reach || !usesCastTargets) return hint;
    return game.i18n.format("WITCHER.Sheet.Spell.Text.ReachAnd", { reach, hint });
}

/**
 * The frame in one line, for the collapsed strip.
 *
 * Enough to check at a glance without opening anything — the four things a GM
 * actually verifies when they open a spell. Not a summary of the engine's
 * reading of them; those live inside, where the controls are.
 */
function frameGlance(item) {
    const sys = item.system ?? {};
    /* The SHAPE belongs here. For Aard the cone is the most distinctive thing
     * about the spell, and the collapsed line said only "≤7 STA" — so the one
     * setting somebody was hunting for was invisible until they opened the
     * panel and then changed a dropdown. */
    const area = sys.targetType === "area" && sys.areaSize
        ? `${sys.areaSize}m ${sys.areaShape ?? "radius"}`
        : sys.targetType === "self" ? game.i18n.localize("WITCHER.Sheet.Spell.Text.TargetSelf") : null;

    const bits = [
        sys.variableCost ? `≤${sys.staminaCost ?? 0} STA` : `${sys.staminaCost ?? 0} STA`,
        area,
        sys.range || null,
        (Array.isArray(sys.defense) ? sys.defense : [sys.defense])
            .filter(d => d && d !== "none").map(labelFor).join(" / ") || null,
        sys.duration?.value ? `${sys.duration.value} ${sys.duration.unit ?? ""}`.trim()
                            : (sys.duration?.unit && sys.duration.unit !== "instant" ? sys.duration.unit : null)
    ].filter(Boolean);
    return bits.join(" · ");
}

const labelFor = (key) => game.i18n.localize(
    CONFIG.WITCHER?.magic?.defenses?.[key] ?? key);

/**
 * The panel's dropdowns, from the system's own config.
 *
 * Read at render time rather than at module load, so a module that adds a
 * school or a defence shows up without the engine knowing about it — and so a
 * world with the config not yet built still renders something usable rather
 * than five empty selects.
 */
function frameVocabulary() {
    const M = CONFIG.WITCHER?.magic ?? {};
    const opts = (map) => Object.entries(map ?? {})
        .map(([value, label]) => ({ value, label: game.i18n.localize(label) }));

    const built = {
        targets:  opts(M.targets),
        shapes:   opts(M.areaShapes),
        defences: opts(M.defenses),
        schools:  opts(M.schools),
        units:    opts(M.durationUnits),
        t: {
            cost: game.i18n.localize("WITCHER.Sheet.Spell.Label.STACost"),
            costFixed: game.i18n.localize("WITCHER.Sheet.Spell.Text.CostExactly"),
            costVariable: game.i18n.localize("WITCHER.Sheet.Spell.Text.CostUpTo"),
            costVariableNote: game.i18n.localize("WITCHER.Sheet.Spell.Text.CostVariableNote"),
            variable: game.i18n.localize("WITCHER.Sheet.Spell.Text.VariableCost"),
            range: game.i18n.localize("WITCHER.Sheet.Spell.Text.Range"),
            targeting: game.i18n.localize("WITCHER.Sheet.Spell.Text.Targeting"),
            defence: game.i18n.localize("WITCHER.Sheet.Spell.Text.Defense"),
            element: game.i18n.localize("WITCHER.Sheet.Spell.Text.School"),
            duration: game.i18n.localize("WITCHER.Sheet.Spell.Text.Duration"),
            reads: game.i18n.localize("WITCHER.Sheet.Spell.Text.HowTheEngineReadsThis")
        }
    };
    /* Anything the world has not configured falls back to RAW rather than
     * rendering an empty control, which reads as broken. */
    for (const key of ["targets", "shapes", "defences", "schools", "units"]) {
        if (!built[key].length) delete built[key];
    }
    return built;
}

/**
 * What an unprogrammed spell shows.
 *
 * Not "no behaviour configured". This is the first thing anyone meets, and it
 * is the only chance to explain the model before they are looking at a wall of
 * blocks: a spell is one or more TRIGGERS, and under each one a stack of
 * blocks that runs when it fires.
 *
 * Two sentences, because a blank canvas with no visible way in is how an
 * editor teaches people it is not for them.
 */
function emptyState() {
    const t = (k) => game.i18n.localize(`WITCHER.Sheet.Spell.Text.${k}`);
    return `
        <div class="wm-empty-canvas">
            <p class="wm-empty-title">${t("NoBehaviour")}</p>
            <p class="wm-empty-hint">${t("NoBehaviourHint")}</p>

            ${/* The model, in the order you meet it. Numbered because it IS a
                 sequence — the trigger has to exist before blocks can go under
                 it, and a block cannot be dropped anywhere else. */""}
            <ol class="wm-empty-steps">
                <li><b>${t("StepTriggerName")}</b> ${t("StepTrigger")}</li>
                <li><b>${t("StepBlocksName")}</b> ${t("StepBlocks")}</li>
                <li><b>${t("StepRulesName")}</b> ${t("StepRules")}</li>
            </ol>
        </div>`;
}

/**
 * Load the book's version of this spell as a starting point.
 *
 * Matches on the printed name, and offers the list if it cannot. What lands is
 * an ordinary tree: every block draggable, every argument editable, the frame
 * shown as law beside it. Nothing about it is special afterwards.
 */
export async function startFromBook(item) {
    const { CORPUS } = await import("../spells/corpus.mjs");
    const { normalise } = await import("../seed.mjs");

    const key = normalise(item.name);
    let spell = CORPUS.find(s => normalise(s.name) === key);

    if (!spell) {
        const picked = await pickFromBook(CORPUS, item.name);
        if (!picked) return false;
        spell = picked;
    }

    if (authoredSummary(item.system?.magic, item.name).any) {
        const ok = await foundry.applications.api.DialogV2.confirm({
            window: { title: item.name },
            content: `<p>${game.i18n.format("WITCHER.Sheet.Spell.Text.ConfirmReplaceBehaviour",
                                            { name: spell.name })}</p>`
        });
        if (!ok) return false;
    }

    /* `replaceAll`, not a plain update: an ObjectField update MERGES, so
     * writing the book's trees onto a spell that already had some left both
     * sets on the item — the spell fired its old behaviour and its new one,
     * and the sheet showed no sign of it.
     *
     * Deep-cloned because a corpus entry is a module-level constant shared by
     * every world on this machine, and handing Foundry the live object would
     * let the next drag mutate the source of truth for all of them. */
    const { replaceAll } = await import("./persist.mjs");
    /* The sheet's own fields come along too.
     *
     * The cast dialog reads `system.staminaCost` / `system.variableCost` — not
     * the frame — because it is shared with the original engine. Writing only
     * `system.magic.*` left a book-loaded spell with the right cone, the right
     * defence and a cost of ZERO: Aard was free to cast, and the panel read
     * "no area" beside a 2m cone. */
    const { sheetFieldsFor } = await import("../legacyFrame.mjs");
    await replaceAll(item, {
        frame: structuredClone(spell.frame),
        on: structuredClone(spell.on),
        sheetFields: sheetFieldsFor(spell.frame, spell.on)
    });

    /* The book's own words, if the item has none of its own.
     *
     * Blocks say what a spell DOES; the description says what the book says,
     * and a GM adjudicating an edge case reads the second. Loading Alzur's
     * Thunder and getting its behaviour but a blank description is half a
     * spell.
     *
     * Only when EMPTY — somebody who has written their own text meant it, and
     * a "start from the book" that silently overwrites prose is one nobody
     * risks pressing twice. */
    const { describe } = await import("../spells/descriptions.mjs");
    const text = describe(spell.name);
    const existing = String(item.system?.effect ?? "").replace(/<[^>]*>/g, "").trim();
    if (text && !existing) {
        await item.update({ "system.effect": `<p>${text}</p>` });
    }
    ui.notifications?.info(game.i18n.format("WITCHER.Sheet.Spell.Text.LoadedFromBook", { name: spell.name }));
    return true;
}

/** Offer the corpus, nearest names first. */
async function pickFromBook(corpus, itemName) {
    const { normalise } = await import("../seed.mjs");
    const key = normalise(itemName);
    const scored = corpus
        .map(s => ({ s, d: distance(key, normalise(s.name)) }))
        .sort((a, b) => a.d - b.d || a.s.name.localeCompare(b.s.name));

    /* A searchable list, not a 103-row `<select size="14">`.
     *
     * The select was unusable: no way to find anything without scrolling past
     * a hundred entries, no visible grouping, and a native listbox that sizes
     * itself differently in every browser. A filter box and a scrolling list
     * of buttons is more markup and vastly less friction. */
    /* Rows are DIVs, not buttons.
     *
     * Foundry styles `button` hard — its own height, uppercase, letter
     * spacing, nowrap — on selectors specific enough that every attempt to
     * reset them lost. The rows came out overlapping, with the name and the
     * tier on different lines and everything shouting in capitals.
     *
     * A picker row is not a button anyway: it is an option in a list, and
     * saying so costs one ARIA role and gives back the whole cascade. */
    const rows = scored.map(({ s }) => `
        <div class="wm-book-row" role="option" tabindex="0" aria-selected="false"
             data-name="${escAttr(s.name)}"
             data-search="${escAttr(`${s.name} ${s.tier} ${s.element}`.toLowerCase())}">
            <span class="wm-book-name">${escHtml(s.name)}</span>
            <span class="wm-book-meta">${escHtml(s.tier)} · ${escHtml(s.element)}</span>
        </div>`).join("");

    return new Promise((resolve) => {
        const dlg = new foundry.applications.api.DialogV2({
            /* `resizable` is off by default on DialogV2, so the window had no
             * grip in its corner — and with a hundred rows in it, that is the
             * one control it most obviously wanted. */
            window: { title: game.i18n.localize("WITCHER.Sheet.Spell.Text.PickFromBook"),
                      resizable: true },
            /* The class is what the stylesheet hangs the scroll chain off.
             * Foundry's own `.window-content` is not a flex column, so a child
             * asking for `height: 100%` inside it resolves against nothing and
             * the list grows forever instead of scrolling. */
            classes: ["witcher", "wm-book-dialog"],
            position: { width: 360, height: 480 },
            content: `
                <div class="wm-book">
                    <p class="wm-book-hint">${game.i18n.format(
                        "WITCHER.Sheet.Spell.Text.PickFromBookHint", { name: escHtml(itemName) })}</p>
                    <input type="search" class="wm-book-filter" autofocus
                           placeholder="${game.i18n.localize("WITCHER.Sheet.Spell.Text.FilterSpells")}">
                    <div class="wm-book-list" role="listbox"
                         aria-label="${game.i18n.localize("WITCHER.Sheet.Spell.Text.PickFromBook")}">${rows}</div>
                </div>`,
            buttons: [{ action: "cancel", label: game.i18n.localize("WITCHER.Sheet.Spell.Text.Cancel") }],
            submit: () => resolve(null),
            close: () => resolve(null)
        });

        dlg.addEventListener("render", () => {
            const root = dlg.element;
            const filter = root.querySelector(".wm-book-filter");
            const items = [...root.querySelectorAll(".wm-book-row")];
            filter?.addEventListener("input", () => {
                const q = filter.value.trim().toLowerCase();
                for (const el of items) el.hidden = q && !el.dataset.search.includes(q);
            });
            const choose = (el) => {
                resolve(corpus.find(s => s.name === el.dataset.name) ?? null);
                dlg.close();
            };
            for (const el of items) {
                el.addEventListener("click", () => choose(el));
                /* A div gets no keyboard behaviour for free. Enter and Space
                 * pick; the arrows walk the list, because a hundred rows with
                 * no keyboard path is a list only a mouse can use. */
                el.addEventListener("keydown", (ev) => {
                    if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); return choose(el); }
                    if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
                    ev.preventDefault();
                    const visible = items.filter(i => !i.hidden);
                    const at = visible.indexOf(el);
                    const next = visible[at + (ev.key === "ArrowDown" ? 1 : -1)];
                    next?.focus();
                });
            }
            /* Typing in the filter and pressing Down should land in the list. */
            filter?.addEventListener("keydown", (ev) => {
                if (ev.key !== "ArrowDown") return;
                ev.preventDefault();
                items.find(i => !i.hidden)?.focus();
            });
        });
        dlg.render(true);
    });
}

const escHtml = (v) => String(v ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const escAttr = (v) => escHtml(v).replace(/"/g, "&quot;");

/** Cheap edit distance — good enough to float near-matches to the top. */
function distance(a, b) {
    if (a === b) return 0;
    if (b.startsWith(a) || a.startsWith(b)) return 1;
    const shared = [...new Set(a.split(" "))].filter(w => b.includes(w)).length;
    return 10 - shared;
}


/**
 * Ask a person for one argument.
 *
 * World vocabularies (`@statuses`) resolve here rather than in the block, so a
 * module adding a status makes it available to every block that takes one
 * without touching the registry.
 *
 * `undefined` means dismissed and `null` means cleared. They are different
 * answers and collapsing them is how a cancelled dialog silently wipes a
 * value.
 */
export async function promptForInput(spec, current, key) {
    const { DialogV2 } = foundry.applications.api;

    if (spec.type === "boolean") return !current;

    if (spec.type === "enum") {
        const options = Array.isArray(spec.options) ? spec.options : await vocabulary(spec.options);
        if (!options.length) return undefined;
        const picked = await DialogV2.prompt({
            window: { title: humanKey(key) },
            content: `<select name="v" style="width:100%">${options.map(o =>
                `<option value="${o}"${String(o) === String(current) ? " selected" : ""}>${o}</option>`
            ).join("")}</select>`,
            ok: { callback: (_e, b) => b.form.elements.v.value }
        }).catch(() => undefined);
        return picked ?? undefined;
    }

    if (spec.type === "list") {
        const typed = await DialogV2.prompt({
            window: { title: humanKey(key) },
            content: `<input type="text" name="v" style="width:100%" value="${
                escapeAttr((Array.isArray(current) ? current : []).join(", "))}"
                placeholder="${game.i18n.localize("WITCHER.Sheet.Spell.Hint.CommaSeparated")}">`,
            ok: { callback: (_e, b) => b.form.elements.v.value }
        }).catch(() => undefined);
        if (typed === undefined) return undefined;
        return typed.split(",").map(x => x.trim()).filter(Boolean);
    }

    /* An expression is CHOSEN, not typed.
     *
     * Nobody should have to know that `{index}` exists, let alone that it
     * counts from zero, to say "it loses a die for each target it passes
     * through". So the shape is picked in plain words and the numbers are
     * filled in; the formula is built from that and never has to be seen.
     *
     * The raw box is still reachable for anyone who wants it, and it is what a
     * hand-written expression no shape recognises falls back to — mangling
     * somebody's exotic formula into the nearest shape it half-matches would
     * be worse than leaving it alone. */
    if (spec.type === "expression") return promptForExpression(current, key, spec);

    if (spec.type === "lifetime") return promptForLifetime(current, key);

    if (spec.type === "map") return promptForMap(current, key);

    /* Everything left is a `string`, and strings come in two kinds.
     *
     * Some are PROSE — what a spell narrates, what an object looks like. A box
     * is exactly right for those and typing them is the point.
     *
     * The rest are engine IDENTIFIERS: a stat key, a skill key, an
     * environment condition. Those are unguessable — `ifEnvironment.condition`
     * has precisely two legal values and the adapter matches them with a
     * `switch` — so a free-text box there is a trap. Any input declaring `of:`
     * gets the list instead. */
    if (spec.of) {
        const options = await vocabulary(spec.of);
        if (options.length) return promptFromList(options, current, key, { allowOther: true });
    }
    return promptForProse(current, key, spec);
}

/** A word from a known list, with an escape hatch for words we do not know. */
async function promptFromList(options, current, key, { allowOther = false } = {}) {
    const { DialogV2 } = foundry.applications.api;
    const OTHER = "\u0000other";
    const known = options.includes(current) || current == null || current === "";
    const picked = await DialogV2.prompt({
        window: { title: humanKey(key) },
        content: `<select name="v" style="width:100%">${
            options.map(o => `<option value="${escapeAttr(o)}"${
                String(o) === String(current) ? " selected" : ""}>${vocabLabel(o)}</option>`).join("")
        }${allowOther ? `<option value="${OTHER}"${known ? "" : " selected"}>${
            game.i18n.localize("WITCHER.Sheet.Spell.Hint.SomethingElse")}</option>` : ""}</select>`,
        ok: { callback: (_e, b) => b.form.elements.v.value }
    }).catch(() => undefined);
    if (picked === undefined) return undefined;
    if (picked !== OTHER) return picked;
    return promptForProse(known ? "" : current, key, {});
}

/** A free-text answer — prose, or a word no vocabulary covers. */
async function promptForProse(current, key, spec = {}) {
    const { DialogV2 } = foundry.applications.api;
    const long = String(current ?? "").length > 60 || spec.long;
    const typed = await DialogV2.prompt({
        window: { title: humanKey(key), resizable: true },
        content: long
            ? `<textarea name="v" rows="5" style="width:100%">${
                  String(current ?? "").replace(/</g, "&lt;")}</textarea>`
            : `<input type="text" name="v" style="width:100%" value="${escapeAttr(current ?? "")}">`,
        ok: { callback: (_e, b) => b.form.elements.v.value }
    }).catch(() => undefined);
    return typed === undefined ? undefined : typed;
}

/**
 * When an effect ends.
 *
 * Checkboxes rather than a dropdown because several spells end on more than
 * one thing at once — Sigil of the Hidden lifts when it is destroyed OR
 * dispelled OR recast — and a single-choice control cannot say that. One box
 * ticked returns the plain string the rest of the engine expects; more than
 * one returns the array it also accepts.
 */
async function promptForLifetime(current, key) {
    const { DialogV2 } = foundry.applications.api;
    const chosen = new Set(Array.isArray(current) ? current : current ? [current] : []);
    const rows = LIFETIME_CHOICES.map(({ id, label }) => `
        <label style="display:flex;gap:.5em;align-items:baseline;padding:.15em 0">
            <input type="checkbox" name="v" value="${escapeAttr(id)}"${chosen.has(id) ? " checked" : ""}>
            <span>${game.i18n.localize(label)}</span>
        </label>`).join("");
    const picked = await DialogV2.prompt({
        window: { title: humanKey(key), resizable: true },
        content: `<div style="max-height:22em;overflow:auto">${rows}</div>`,
        ok: { callback: (_e, b) => [...b.form.querySelectorAll("input[name=v]:checked")].map(i => i.value) }
    }).catch(() => undefined);
    if (picked === undefined) return undefined;
    if (!picked.length) return undefined;              // ticking nothing is not a change
    return picked.length === 1 ? picked[0] : picked;
}

/**
 * A handful of named values — `core:narrate.values` and nothing else.
 *
 * Rows, not JSON. The values here are frequently expressions, which is the one
 * corner of the canvas where a formula still has to be written by hand; the
 * builder cannot reach inside a map.
 */
async function promptForMap(current, key) {
    const { DialogV2 } = foundry.applications.api;
    const entries = Object.entries(current && typeof current === "object" ? current : {});
    while (entries.length < 4) entries.push(["", ""]);
    const row = ([k, v], i) => `
        <div style="display:flex;gap:.4em;margin-bottom:.25em">
            <input type="text" name="k${i}" placeholder="${
                game.i18n.localize("WITCHER.Sheet.Spell.Hint.Name")}" value="${escapeAttr(k)}" style="flex:1">
            <input type="text" name="x${i}" placeholder="${
                game.i18n.localize("WITCHER.Sheet.Spell.Hint.Value")}" value="${escapeAttr(v)}" style="flex:2">
        </div>`;
    const out = await DialogV2.prompt({
        window: { title: humanKey(key), resizable: true },
        content: entries.map(row).join(""),
        ok: { callback: (_e, b) => {
            const map = {};
            for (let i = 0; i < 99; i++) {
                const kEl = b.form.elements[`k${i}`];
                if (!kEl) break;
                const name = String(kEl.value ?? "").trim();
                if (name) map[name] = String(b.form.elements[`x${i}`]?.value ?? "").trim();
            }
            return map;
        } }
    }).catch(() => undefined);
    return out === undefined ? undefined : out;
}

/**
 * Every way an effect can end, in the order a person would look for one.
 *
 * Kept here rather than derived from `ENDS` because the engine's order is
 * alphabetical-ish by accident and the useful order is "durations first, then
 * the things that interrupt them".
 */
const LIFETIME_CHOICES = Object.freeze([
    { id: "immediate",      label: "WITCHER.Sheet.Spell.Ends.immediate" },
    { id: "rounds",         label: "WITCHER.Sheet.Spell.Ends.rounds" },
    { id: "minutes",        label: "WITCHER.Sheet.Spell.Ends.minutes" },
    { id: "hours",          label: "WITCHER.Sheet.Spell.Ends.hours" },
    { id: "days",           label: "WITCHER.Sheet.Spell.Ends.days" },
    { id: "permanent",      label: "WITCHER.Sheet.Spell.Ends.permanent" },
    { id: "untilExitZone",  label: "WITCHER.Sheet.Spell.Ends.untilExitZone" },
    { id: "untilPutOut",    label: "WITCHER.Sheet.Spell.Ends.untilPutOut" },
    { id: "untilDestroyed", label: "WITCHER.Sheet.Spell.Ends.untilDestroyed" },
    { id: "untilDispelled", label: "WITCHER.Sheet.Spell.Ends.untilDispelled" },
    { id: "untilRecast",    label: "WITCHER.Sheet.Spell.Ends.untilRecast" },
    { id: "untilTaskDone",  label: "WITCHER.Sheet.Spell.Ends.untilTaskDone" },
    { id: "untilExpended",  label: "WITCHER.Sheet.Spell.Ends.untilExpended" },
    { id: "saveEnds",       label: "WITCHER.Sheet.Spell.Ends.saveEnds" },
    { id: "poolEmpty",      label: "WITCHER.Sheet.Spell.Ends.poolEmpty" },
    { id: "upkeepUnpaid",   label: "WITCHER.Sheet.Spell.Ends.upkeepUnpaid" },
    { id: "casterStruck",   label: "WITCHER.Sheet.Spell.Ends.casterStruck" },
    { id: "untilWorldEvent",label: "WITCHER.Sheet.Spell.Ends.untilWorldEvent" }
]);

/** World vocabularies, resolved lazily so modules can extend them. */
async function vocabulary(name) {
    switch (name) {
        case "@statuses":       return (CONFIG.statusEffects ?? []).map(s => s.id);
        case "@damageTypes":    return Object.keys(CONFIG.WITCHER?.damageTypes ?? {});
        case "@damageChannels": return ["attack", "poison", "disease", "suffocation", "burning", "bleeding"];
        case "@defences":       return ["dodge", "block", "blockOrDodge", "resistMagic", "spellCasting", "none"];
        /* The weapon qualities the damage pipeline understands — read from the
         * live catalogue (the Qualities Editor's own source), so a world that
         * adds one gets it here without a code change. */
        case "@qualities": {
            const { getActiveWeaponQualities } = await import("../../setup/config.mjs");
            return Object.keys(getActiveWeaponQualities?.() ?? {});
        }
        case "@elements":       return ["earth", "air", "fire", "water", "mixed"];
        case "@infoKinds":      return ["health", "direction", "memory", "secret", "monsters", "augury"];
        case "@lifetimes":      return LIFETIME_CHOICES.map(c => c.id);

        /* Below: the vocabularies behind what used to be free-text boxes.
         *
         * These are engine identifiers, not words. `ifEnvironment.condition`
         * has exactly two values the adapter's `switch` recognises; anything
         * else silently matches nothing. Offering the list is the difference
         * between a control and a guessing game. */
        case "@skills":         return skillKeys();
        case "@stats":          return [...STAT_KEYS, ...DERIVED_KEYS, ...skillKeys()];
        case "@traits":         return ["metalGear", "beast"];
        case "@conditions":     return ["directSunlight", "anyLight"];
        case "@counterTags":    return ["fire", "water", "poison", "disease", "intoxication"];
        case "@resources":      return ["sta", "hp", "luck"];
        default:                return [];
    }
}

const STAT_KEYS    = ["int", "ref", "dex", "body", "spd", "emp", "cra", "will", "luck"];
const DERIVED_KEYS = ["hp", "sta", "vigor", "stun", "rec", "enc", "damageBonus", "meleeBonus"];

/**
 * Skill keys as the ACTOR schema spells them.
 *
 * Read off the live config where possible: the corpus was authored from the
 * printed book ("Resist Magic", "Dodge/Escape") and those are not the keys.
 * Handing an author the book's spelling is how `resistMagic` got written into
 * eighteen spells and resolved to nothing.
 */
function skillKeys() {
    /* `skillMap` is keyed BY skill — `{ awareness: { statKey, costMultiplier } }`.
     * Reading its values instead yielded `statKey` and `costMultiplier` as if
     * they were skills, which is the same shape of mistake this vocabulary
     * exists to prevent. */
    const map = CONFIG.WITCHER?.skillMap;
    if (map && typeof map === "object") return Object.keys(map).sort();
    return ["athletics", "awareness", "brawling", "charisma", "courage", "dodge", "endurance",
            "hexweave", "intimidation", "leadership", "physique", "resistcoerc", "resistmagic",
            "ritcraft", "seduction", "spellcast", "stealth", "wilderness"];
}

/**
 * A word as a person would recognise it.
 *
 * The system already knows that `resistmagic` prints as "Resist Magic"; the
 * picker showing the raw key is how an author learns engine spellings they
 * should never have to see.
 */
function vocabLabel(id) {
    const printed = CONFIG.WITCHER?.skillLabel?.(id);
    if (printed && printed !== id) return printed;
    const key = `WITCHER.Sheet.Spell.Vocab.${id}`;
    const local = game.i18n.localize(key);
    return local === key ? humanKey(id) : local;
}

const humanKey = (k) => String(k ?? "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
const escapeAttr = (v) => String(v ?? "").replace(/"/g, "&quot;");


/**
 * What the current formula says, in English, above the help.
 *
 * The formula is the truth and the only thing editable — a prose field that
 * could be typed into would be a second source of truth for one fact. This is
 * a reading of it, and it updates when the formula does because it is derived
 * from it every time.
 */
function readingOf(current) {
    const said = phrase(current);
    if (!said) return "";
    return `<p class="wm-expr-says"><span>${game.i18n.localize(
        "WITCHER.Sheet.Spell.Expr.Says")}</span> ${said}</p>`;
}

/**
 * What an expression may refer to, spelled out where it is being written.
 *
 * Each one says WHEN it is worth using, not just what it holds — "how many
 * targets the spell has already passed through" is the sentence that makes
 * Alzur's falloff writable; "the loop counter" is not.
 */
function expressionHelp() {
    const t = (k) => game.i18n.localize(`WITCHER.Sheet.Spell.Expr.${k}`);
    const vars = [
        ["{sta}",    t("Sta")],
        ["{margin}", t("Margin")],
        ["{index}",  t("Index")],
        ["{skill}",  t("Skill")],
        ["{vigor}",  t("Vigor")]
    ];
    return `
        <div class="wm-expr-help">
            <p class="wm-expr-lede">${t("Lede")}</p>
            <dl class="wm-expr-vars">
                ${vars.map(([v, why]) =>
                    `<dt><code>${v}</code></dt><dd>${why}</dd>`).join("")}
            </dl>
            <p class="wm-expr-lede">${t("Maths")}</p>
        </div>`;
}


/**
 * Build a value by choosing, not by typing.
 *
 * Every shape's fields are rendered once and all but the chosen one hidden, so
 * changing the dropdown swaps which set is visible with no re-render and no
 * re-binding. The first version rebuilt the dialog's markup by hand and
 * re-fired a synthetic render event to re-attach its listeners — the kind of
 * thing that works until it quietly does not, in a dialog somebody is halfway
 * through using.
 */
async function promptForExpression(current, key, spec = {}) {
    const B = await import("./builder.mjs");
    const { DialogV2 } = foundry.applications.api;

    /* `default: null` is the block's way of saying the empty value is a real
     * setting rather than a missing one. */
    const canBlank = "default" in spec && spec.default === null;

    const opened = B.openOn(current);
    let chosen = opened.chosen ?? opened.id;
    let values = { ...opened.values };

    const view = B.builderView(chosen, values);
    const content = `
        <div class="wm-build">
            <label class="wm-build-shape">
                <span>${escHtml(game.i18n.localize("WITCHER.Sheet.Spell.Build.How"))}</span>
                <select name="shape">
                    ${view.panels.map(p => `<option value="${escAttr(p.id)}"${
                        p.active ? " selected" : ""}>${escHtml(p.label)}</option>`).join("")}
                </select>
            </label>

            ${view.panels.map(p => `
                <div class="wm-build-fields" data-shape="${escAttr(p.id)}" ${p.active ? "" : "hidden"}>
                    ${p.fields.map(f => `
                        <label class="wm-build-field">
                            <span>${escHtml(f.label)}</span>
                            <input type="number" data-key="${escAttr(f.key)}"
                                   value="${escAttr(f.value)}" min="${f.min}" step="${f.step}">
                        </label>`).join("")}
                </div>`).join("")}

            <p class="wm-build-reads">${escHtml(view.reads)}</p>
            ${opened.custom ? `<p class="wm-build-custom">${escHtml(game.i18n.format(
                "WITCHER.Sheet.Spell.Build.Custom", { formula: opened.custom }))}</p>` : ""}
        </div>`;

    return new Promise((resolve) => {
        const dlg = new DialogV2({
            window: { title: humanKey(key), resizable: true },
            classes: ["witcher", "wm-build-dialog"],
            position: { width: 460 },
            content,
            buttons: [
                { action: "ok", label: game.i18n.localize("WITCHER.Sheet.Spell.Build.Use"), default: true },
                /* Only where blank MEANS something. An input declaring
                 * `default: null` documents a behaviour for the empty value —
                 * "the same area the cast used", "for the whole duration" —
                 * and there was no way back to it: the dialog could return a
                 * formula or "cancelled", and cancelled means no change. So
                 * once a zone had a size it had one forever. */
                ...(canBlank ? [{ action: "blank",
                    label: game.i18n.localize("WITCHER.Sheet.Spell.Build.Blank") }] : []),
                { action: "cancel", label: game.i18n.localize("WITCHER.Sheet.Spell.Text.Cancel") }
            ],
            submit: (action) => resolve(action === "ok"    ? B.buildExpression(chosen, values)
                                      : action === "blank" ? null
                                      : undefined)
        });

        dlg.addEventListener("render", () => {
            const root = dlg.element;
            const reads = root.querySelector(".wm-build-reads");
            const panels = [...root.querySelectorAll("[data-shape]")];
            const say = () => { if (reads) reads.textContent = B.builderView(chosen, values).reads; };

            root.querySelector('[name="shape"]')?.addEventListener("change", (ev) => {
                const next = B.chooseShape(ev.target.value);
                if (!next) return;
                chosen = next.chosen;
                values = next.values;
                for (const panel of panels) panel.hidden = panel.dataset.shape !== chosen;
                /* The new shape's inputs already hold its defaults, which is
                 * what `values` was just set to — nothing to write back. */
                say();
            });

            for (const input of root.querySelectorAll(".wm-build-field input")) {
                input.addEventListener("input", () => {
                    if (input.closest("[data-shape]")?.dataset.shape !== chosen) return;
                    values = B.setValue(chosen, values, input.dataset.key, input.value);
                    say();
                });
            }
        });

        dlg.render(true);
    });
}
