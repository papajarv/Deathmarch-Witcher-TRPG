// ============================================================
//  witcher-ttrpg-death-march — scripts/sheets/inventory-qol.js
//  Foundry v13 · TheWitcherTRPG system
//
//  Migrated from the standalone witcher-inventory-qol module.  Adds
//  expand/collapse chevrons, inline container panels with weight bars,
//  container drag-drop targets, and quality-name tag pills to the
//  WitcherCharacterSheet's inventory list.  Keeps its own `qol-*` CSS
//  class prefix to avoid colliding with the inventory-overlay styles.
// ============================================================

const MODULE_ID = "witcher-ttrpg-death-march";

// ── CONFIGURATION ─────────────────────────────────────────────────────────
//
//  QUALITIES_JOURNAL_NAME
//    The exact name of the journal that holds your quality descriptions.
//    Each page inside it must be titled with the quality name as it appears
//    in item descriptions. Lookup is case-insensitive and trims whitespace.
//
//  QUALITIES_COMPENDIUM_PACK
//    The full pack id of the compendium that contains the journal above.
//    Format: "module-id.pack-name"  — e.g. "my-witcher-module.item-qualities"
//    Find it in Foundry → Compendium Packs → right-click the pack → Copy ID,
//    or read the "name" field in the module's manifest packs array.
//    Set to "" (empty string) to search only world journals instead.
//
const QUALITIES_JOURNAL_NAME    = "Weapon and Armor Qualities";
const QUALITIES_COMPENDIUM_PACK = "world.new-armor-and-weapons-rules"; // ← fill in your pack id here

import { fitsInContainer, overflowWarning } from "../lib/container.js";

// ── STYLES ────────────────────────────────────────────────────────────────

function injectStyles() {
    if (document.getElementById(`${MODULE_ID}-styles`)) return;
    const style = document.createElement("style");
    style.id = `${MODULE_ID}-styles`;
    style.textContent = `

/* ── Expand/collapse chevron ─────────────────────────────── */

/* Anchor the chevron inside the image cell, not as its own grid column */
.display-details {
    position: relative;
}

.qol-chevron {
    position: absolute;
    bottom: 0;
    right: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    cursor: pointer;
    color: var(--color-text-dark-primary, #ccc);
    font-size: 0.7em;
    border-radius: 3px 0 0 0;
    background: rgba(0, 0, 0, 0.55);
    transition: color 0.15s, background 0.15s;
    user-select: none;
    z-index: 3;
}
.qol-chevron:hover {
    color: var(--color-text-hyperlink, #c4a30e);
    background: rgba(0, 0, 0, 0.78);
}
.qol-chevron i {
    transition: transform 0.18s ease;
    pointer-events: none;
}
.qol-chevron.qol-open i {
    transform: rotate(90deg);
}
.list-item[data-has-info="0"] .qol-chevron {
    opacity: 0.25;
    cursor: default;
    pointer-events: none;
}

/* ── Container toggle button on the bar ──────────────────── */

.qol-contents-btn {
    cursor: pointer;
    color: var(--color-text-dark-secondary, #aaa);
    transition: color 0.15s;
    display: inline-flex;
    align-items: center;
}
.qol-contents-btn:hover,
.qol-contents-btn.qol-active {
    color: var(--color-text-hyperlink, #c4a30e);
}

/* ── Container drag-over highlight ───────────────────────── */

.list-item.qol-dragover {
    outline: 2px solid var(--color-border-highlight, #c4a30e);
    outline-offset: -2px;
    background: rgba(196, 163, 14, 0.07);
    border-radius: 3px;
}

/* ── Container contents panel ────────────────────────────── */

.qol-container-panel {
    overflow: hidden;
    max-height: 0;
    opacity: 0;
    transition: max-height 0.22s ease, opacity 0.18s ease, padding 0.18s ease;
    padding: 0 6px;
    border-left: 2px solid rgba(196, 163, 14, 0.3);
    margin: 0 4px;
}
.qol-container-panel.qol-open {
    max-height: 600px;
    opacity: 1;
    padding: 6px 6px 8px;
}

.qol-weight-bar-wrap {
    margin-bottom: 6px;
}
.qol-weight-bar-wrap progress {
    width: 100%;
    height: 4px;
    border-radius: 2px;
    display: block;
}
.qol-weight-labels {
    display: flex;
    justify-content: space-between;
    font-size: 0.72em;
    color: var(--color-text-dark-secondary, #888);
    margin-top: 2px;
}

.qol-stored-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.qol-empty-msg {
    font-style: italic;
    font-size: 0.8em;
    color: var(--color-text-dark-secondary, #888);
    text-align: center;
    padding: 4px 0 2px;
}

.qol-stored-item {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 4px 6px;
    border-radius: 3px;
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.06);
    font-size: 0.83em;
}
.qol-stored-item:hover {
    background: rgba(255,255,255,0.06);
}

.qol-stored-img {
    width: 24px;
    height: 24px;
    object-fit: cover;
    border-radius: 2px;
    flex-shrink: 0;
}

.qol-stored-name {
    flex: 1;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.qol-stored-meta {
    font-size: 0.85em;
    color: var(--color-text-dark-secondary, #999);
    white-space: nowrap;
    flex-shrink: 0;
}

.qol-eject-btn {
    all: unset;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 3px;
    color: #a04040;
    opacity: 0.55;
    transition: opacity 0.15s, background 0.15s;
    flex-shrink: 0;
}
.qol-eject-btn:hover {
    opacity: 1;
    background: rgba(160, 64, 64, 0.15);
}

/* ── Quality tag pills ───────────────────────────────────── */

.qol-quality-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 4px 6px 2px;
}

.qol-quality-tag {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 8px 2px 6px;
    border-radius: 4px;
    background: rgba(30, 25, 15, 0.85);
    border: 1px solid rgba(196, 163, 14, 0.35);
    font-size: 0.78em;
    font-family: var(--font-primary, serif);
    color: var(--color-text-dark-secondary, #bbb);
    cursor: pointer;
    user-select: none;
    transition: border-color 0.15s, color 0.15s, background 0.15s;
    position: relative;
}
.qol-quality-tag:hover {
    border-color: rgba(196, 163, 14, 0.75);
    color: var(--color-text-hyperlink, #c4a30e);
    background: rgba(40, 33, 15, 0.95);
}
.qol-quality-tag i {
    font-size: 0.85em;
    opacity: 0.6;
}
.qol-quality-tag.qol-unknown {
    opacity: 0.45;
    cursor: default;
    pointer-events: none;
}

/* ── Quality tooltip popup ───────────────────────────────── */

.qol-quality-popup {
    position: fixed;
    z-index: 9999;
    min-width: 220px;
    max-width: 320px;
    background: #1a1611;
    border: 1px solid rgba(196, 163, 14, 0.55);
    border-radius: 5px;
    box-shadow: 0 4px 18px rgba(0,0,0,0.7);
    padding: 8px 10px 10px;
    pointer-events: none;
    opacity: 0;
    transform: translateY(4px);
    transition: opacity 0.12s ease, transform 0.12s ease;
}
.qol-quality-popup.qol-visible {
    opacity: 1;
    transform: translateY(0);
    pointer-events: auto;
}
.qol-quality-popup-title {
    font-size: 0.88em;
    font-weight: bold;
    color: var(--color-text-hyperlink, #c4a30e);
    margin-bottom: 5px;
    border-bottom: 1px solid rgba(196, 163, 14, 0.25);
    padding-bottom: 4px;
}
.qol-quality-popup-body {
    font-size: 0.8em;
    color: var(--color-text-dark-secondary, #ccc);
    line-height: 1.45;
}
.qol-quality-popup-body p {
    margin: 0 0 4px 0;
}
.qol-quality-popup-body p:last-child {
    margin-bottom: 0;
}
    `;
    document.head.appendChild(style);
}

// ── JOURNAL QUALITY CACHE ─────────────────────────────────────────────────

//  Lazy-loaded map: lowercase quality name → { name, description (HTML) }
let _qualityCache = null;

async function _loadQualityCache() {
    _qualityCache = new Map();

    let journal = null;

    if (QUALITIES_COMPENDIUM_PACK) {
        const pack = game.packs.get(QUALITIES_COMPENDIUM_PACK);
        if (pack) {
            const index = await pack.getIndex();
            const entry = index.find(e => e.name.trim().toLowerCase() === QUALITIES_JOURNAL_NAME.trim().toLowerCase());
            if (entry) journal = await pack.getDocument(entry._id);
        }
        if (!journal) console.warn(`[${MODULE_ID}] Journal "${QUALITIES_JOURNAL_NAME}" not found in pack "${QUALITIES_COMPENDIUM_PACK}".`);
    }

    if (!journal) {
        journal = game.journal.find(j => j.name.trim().toLowerCase() === QUALITIES_JOURNAL_NAME.trim().toLowerCase());
    }

    if (!journal) {
        console.warn(`[${MODULE_ID}] Journal "${QUALITIES_JOURNAL_NAME}" not found. Quality tags will appear greyed out.`);
        return;
    }

    for (const page of (journal.pages.contents ?? journal.pages)) {
        const key = normalizeQualityName(page.name);
        const html = page.text?.content ?? "";
        _qualityCache.set(key, { name: page.name.trim(), description: html });
    }
}

function buildQualityCache() {
    return _qualityCache ?? new Map();
}

// Invalidate and reload cache when journal pages change
Hooks.on("updateJournalEntryPage", () => { _loadQualityCache(); });
Hooks.on("createJournalEntryPage", () => { _loadQualityCache(); });
Hooks.on("deleteJournalEntryPage", () => { _loadQualityCache(); });

// ── PARSE QUALITIES FROM DESCRIPTION ─────────────────────────────────────
//
//  The description is stored as HTML (rich text). We extract the text content
//  and scan for a comma-separated list. The heuristic is:
//    • Strip all HTML tags → plain text
//    • Find the first run of comma-separated tokens that look like quality
//      names (2–40 chars each, not purely numeric).
//  If the description starts with such a list (before any longer prose) it's
//  treated as the qualities line. Otherwise we scan every comma-separated
//  chunk in the whole description.
//

function normalizeQualityName(name) {
    return String(name)
    .replace(/\s*\(.*?\)/g, "") // remove "(4d6)", "(X)", "(+2)", etc
    .trim()
    .toLowerCase();
}

// Split on commas that sit at parenthesis depth 0 — so qualities with
// multi-clause parentheticals like "Close Quarters (+1 WA, Nigga)" stay
// attached as a single token instead of getting torn at the inner comma.
function splitTopLevelCommas(text) {
    const out = [];
    let buf = "";
    let depth = 0;
    for (const ch of text) {
        if (ch === "(" || ch === "[") depth++;
        else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
        if (ch === "," && depth === 0) {
            out.push(buf);
            buf = "";
        } else {
            buf += ch;
        }
    }
    if (buf) out.push(buf);
    return out;
}

// Extract the first paragraph only — qualities live on the leading line
// of the description and any subsequent prose should be ignored.  Treats
// literal `\n\n`, `</p>`, and consecutive `<br>` as paragraph boundaries.
function firstParagraphText(html) {
    if (!html) return "";
    const withBreaks = String(html)
        .replace(/<\/p\s*>/gi, "\n\n")
        .replace(/<br\s*\/?>/gi, "\n");
    const tmp = document.createElement("div");
    tmp.innerHTML = withBreaks;
    const text = tmp.textContent || tmp.innerText || "";
    return text.split(/\n\s*\n/)[0].trim();
}

function parseQualities(descriptionHtml) {
    if (!descriptionHtml) return [];

    // Plain text of only the first paragraph.
    const text = firstParagraphText(descriptionHtml);

    // Paren-aware split, then clean up each token.  Length cap is generous
    // (80) so qualities with longer parenthetical clauses still pass.
    const tokens = splitTopLevelCommas(text)
        .map(t => t.trim())
        .filter(t => t.length >= 2 && t.length <= 80 && !/^\d+$/.test(t));

    // Keep only tokens that look like title-case or all-caps words
    // (i.e. not full sentences), and deduplicate
    const seen = new Set();
    const qualities = [];
    for (const tok of tokens) {
        // Reject if it contains sentence-ending punctuation or is longer than
        // a plausible quality name (guard against picking up prose sentences)
        if (/[.!?;]/.test(tok)) break; // stop at first sentence-like token
        if (tok.split(" ").length > 8) break; // more than 8 words → prose
        const key = normalizeQualityName(tok);
        if (!seen.has(key)) {
            seen.add(key);
            qualities.push(tok);
        }
    }
    return qualities;
}

// ── TOOLTIP SINGLETON ─────────────────────────────────────────────────────

let _popup = null;
let _hideTimer = null;
let _showTimer = null;

function getPopup() {
    if (!_popup) {
        _popup = document.createElement("div");
        _popup.className = "qol-quality-popup";
        document.body.appendChild(_popup);

        _popup.addEventListener("mouseenter", () => {
            clearTimeout(_hideTimer);
        });
        _popup.addEventListener("mouseleave", () => {
            hidePopup();
        });
    }
    return _popup;
}

function showPopup(anchorEl, qualityName, descHtml) {
    clearTimeout(_hideTimer);
    const popup = getPopup();

    popup.innerHTML = `
        <div class="qol-quality-popup-title">${qualityName}</div>
        <div class="qol-quality-popup-body">${descHtml || "<em>No description found.</em>"}</div>
    `;

    // Position above the tag pill
    const rect = anchorEl.getBoundingClientRect();
    popup.style.left = "0px";
    popup.style.top = "0px";
    popup.classList.add("qol-visible");

    const pw = popup.offsetWidth;
    const ph = popup.offsetHeight;

    let left = rect.left + rect.width / 2 - pw / 2;
    let top  = rect.top - ph - 6;

    // Keep on-screen
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (left < 4) left = 4;
    if (left + pw > vw - 4) left = vw - pw - 4;
    if (top < 4) top = rect.bottom + 6; // flip below if not enough room above

    popup.style.left = `${left}px`;
    popup.style.top  = `${top}px`;
}

function hidePopup(delay = 120) {
    clearTimeout(_hideTimer);
    _hideTimer = setTimeout(() => {
        if (_popup) _popup.classList.remove("qol-visible");
    }, delay);
}

// ── QUALITY TAGS PANEL ────────────────────────────────────────────────────

function buildQualityTags(qualities) {
    const cache = buildQualityCache();
    return qualities.map(name => {
        const entry = cache.get(normalizeQualityName(name));
        const cls   = entry ? "" : " qol-unknown";
        const icon  = entry ? "fa-solid equals" : "fa-solid fa-question";
        const title  = entry ? ` "${name}"` : `"${name}" not found in journal`;
        return `<span class="qol-quality-tag${cls}" data-quality="${name}" title="${title}">` +
               `<i class="${icon}"></i>${name}</span>`;
    }).join("");
}

function setupQualityTags($html, actor) {
    $html.find(".list-item").each((_, el) => {
        const $li    = $(el);
        const itemId = el.dataset.itemId;
        if (!itemId) return;

        const item = actor.items.get(itemId);
        if (!item) return;

        // Only process weapons and armors
        if (!["weapon", "armor"].includes(item.type)) return;

        const desc       = item.system.description ?? "";
        const qualities  = parseQualities(desc);
        if (!qualities.length) return;

        // Remove any old tags panel
        $li.find(".qol-quality-tags").remove();

        const $tags = $(`<div class="qol-quality-tags">${buildQualityTags(qualities)}</div>`);

        // Insert right after .list-details (the main row) but before .item-info
        const $details = $li.find(".list-details").first();
        if ($details.length) {
            $details.after($tags);
        } else {
            $li.append($tags);
        }

        // Tooltip events (delegated)
        $tags.on("mouseenter.qol", ".qol-quality-tag:not(.qol-unknown)", e => {
            clearTimeout(_showTimer);

            const tag = e.currentTarget;

            _showTimer = setTimeout(() => {
                const qualName = tag.dataset.quality;
                const entry = buildQualityCache().get(
                    normalizeQualityName(qualName)
                );

                if (entry) {
                    showPopup(tag, entry.name, entry.description);
                }
            }, 1000); // 2 seconds
        });

        $tags.on("mouseleave.qol", ".qol-quality-tag", () => {
            clearTimeout(_showTimer);
            hidePopup();
        });
    });
}

// ── CHEVRONS ──────────────────────────────────────────────────────────────

function setupChevrons($html) {
    $html.find(".list-item").each((_, el) => {
        const $li   = $(el);
        const $info = $li.find(".item-info").first();
        const $dets = $li.find(".list-details").first();
        if (!$dets.length) return;

        $dets.find(".qol-chevron").remove();

        const hasInfo = $info.length > 0;
        $li.attr("data-has-info", hasInfo ? "1" : "0");

        const $chev = $(`<span class="qol-chevron"><i class="fa-solid fa-chevron-right"></i></span>`);
        // Inject into the image container so it overlays as a badge — keeps the grid intact
        const $imgContainer = $dets.find(".display-details").first();
        if ($imgContainer.length) {
            $imgContainer.append($chev);
        } else {
            $dets.prepend($chev);
        }

        if (!hasInfo) return;

        const syncChev = () => $chev.toggleClass("qol-open", !$info.hasClass("invisible"));
        syncChev();

        // Clicking the chevron triggers the expand/collapse
        $chev.on("click.qol", e => {
            e.preventDefault();
            e.stopPropagation();
            $info.toggleClass("invisible");
            syncChev();
        });

        // Keep in sync when the system's own click handlers toggle it
        new MutationObserver(syncChev).observe($info[0], {
            attributes: true,
            attributeFilter: ["class"]
        });
    });
}

// ── CONTAINER PANEL ───────────────────────────────────────────────────────

function buildPanelHTML(container) {
    const items    = container.system.itemContent ?? [];
    const stored   = container.system.storedWeight ?? 0;
    const capacity = container.system.carry ?? 0;
    const over     = capacity > 0 && stored > capacity;

    const weightBar = `
        <div class="qol-weight-bar-wrap">
            <progress value="${stored}" max="${Math.max(capacity, stored)}"
                style="accent-color:${over ? "#a04040" : ""}"></progress>
            <div class="qol-weight-labels">
                <span>${stored} kg stored</span>
                <span>${capacity} kg capacity</span>
            </div>
        </div>`;

    if (!items.length) {
        return `${weightBar}
            <p class="qol-empty-msg">Empty — drag items here to store them.</p>`;
    }

    const rows = items.map(item => `
        <div class="qol-stored-item">
            <img class="qol-stored-img" src="${item.img}" alt="">
            <span class="qol-stored-name">${item.name}</span>
            <span class="qol-stored-meta">${item.quantity} × ${item.weight} kg</span>
            <button class="qol-eject-btn" data-item-uuid="${item.uuid}"
                    title="Remove from container" type="button">
                <i class="fa-solid fa-right-from-bracket"></i>
            </button>
        </div>`).join("");

    return `${weightBar}<div class="qol-stored-list">${rows}</div>`;
}

function setupContainers($html, actor) {
    $html.find(".list-item").each((_, el) => {
        const $li    = $(el);
        const itemId = el.dataset.itemId;
        if (!itemId) return;

        const container = actor.items.get(itemId);
        if (!container || container.type !== "container") return;

        // Hide the system's built-in container section inside .item-info
        // (h3 "Container Items", weight bar, stored items list)
        // so the chevron only reveals description + tags, like any other item.
        const $info = $li.find(".item-info").first();
        $info.find("h3").filter((_, h) =>
            h.textContent.trim().toLowerCase().includes("container")
        ).hide();
        $info.find(".progress-bar-stored-weight").hide();
        $info.find(".container-stored-item").hide();

        // Our panel sits as a sibling AFTER .item-info, outside its expand scope
        $li.find(".qol-container-panel").remove();
        const $panel = $(`<div class="qol-container-panel"></div>`);
        $panel.html(buildPanelHTML(container));
        $li.append($panel);

        // Toggle button on the bar
        const $controls = $li.find(".list-controls").first();
        $controls.find(".qol-contents-btn").remove();
        const $btn = $(`<a class="qol-contents-btn" title="Show/hide contents">
            <i class="fa-solid fa-box-open"></i>
        </a>`);
        $controls.prepend($btn);

        $btn.on("click.qol", e => {
            e.preventDefault();
            e.stopPropagation();
            $panel.toggleClass("qol-open");
            $btn.toggleClass("qol-active");
        });

        // Eject buttons (delegated so they survive HTML swaps)
        $panel.on("click.qol", ".qol-eject-btn", async e => {
            e.preventDefault();
            e.stopPropagation();
            const uuid    = e.currentTarget.dataset.itemUuid;
            const ejected = await fromUuid(uuid);
            if (!ejected) return;
            await container.update({
                "system.content": container.system.content.filter(u => u !== uuid)
            });
            await ejected.update({ "system.isStored": false });
        });
    });
}

// ── CONTAINER DRAG-DROP ───────────────────────────────────────────────────

function setupContainerDrop($html, actor) {
    $html.find(".list-item").each((_, el) => {
        const $li    = $(el);
        const itemId = el.dataset.itemId;
        if (!itemId) return;

        const container = actor.items.get(itemId);
        if (!container || container.type !== "container") return;

        $li.off(".qol-drop");

        $li.on("dragover.qol-drop", e => {
            let data;
            try { data = JSON.parse(e.originalEvent.dataTransfer.getData("text/plain") || "{}"); }
            catch { return; }
            if (data.type !== "Item") return;

            e.preventDefault();
            e.stopPropagation();
            e.originalEvent.dataTransfer.dropEffect = "move";
            $li.addClass("qol-dragover");
        });

        $li.on("dragleave.qol-drop", e => {
            if (!el.contains(e.relatedTarget)) $li.removeClass("qol-dragover");
        });

        $li.on("drop.qol-drop", async e => {
            e.preventDefault();
            e.stopPropagation();
            $li.removeClass("qol-dragover");

            let data;
            try { data = JSON.parse(e.originalEvent.dataTransfer.getData("text/plain") || "{}"); }
            catch { return; }
            if (data.type !== "Item" || !data.uuid) return;

            const dragged = await fromUuid(data.uuid);
            if (!dragged) return;

            if (dragged.parent?.uuid !== actor.uuid) {
                ui.notifications.warn("Only items from this character can be stored here.");
                return;
            }
            if (dragged.type === "container") {
                ui.notifications.warn("Containers cannot be stored inside other containers.");
                return;
            }
            if (dragged.id === itemId) return;

            // Capacity / type check — reject BEFORE pulling out of the
            // previous container, so a failed drop leaves the source
            // intact.  Routes through lib/container.js so sheath
            // (weapon-type + slot count) and weight rules share one
            // source of truth.
            if (!fitsInContainer(container, dragged)) {
                ui.notifications.warn(overflowWarning(container, dragged));
                return;
            }

            // If already stored elsewhere, pull it out first
            if (dragged.system.isStored) {
                const prev = actor.items.find(
                    i => i.type === "container" && i.system.content.includes(dragged.uuid)
                );
                if (prev) {
                    await prev.update({
                        "system.content": prev.system.content.filter(u => u !== dragged.uuid)
                    });
                }
            }

            await container.update({
                "system.content": [...container.system.content, dragged.uuid]
            });
            await dragged.update({ "system.isStored": true });
        });
    });
}

// ── MERGE CONTAINERS INTO GENERAL ─────────────────────────────────────────

function mergeContainersIntoGeneral($html) {
    let $containersHeader = null;
    $html.find('details > summary, .section-header').each((_, el) => {
        if (/^containers$/i.test(el.textContent.trim())) {
            $containersHeader = $(el);
        }
    });
    if (!$containersHeader) return;

    const $details = $containersHeader.closest('details');
    const $parent  = $details.length ? $details : $containersHeader.parent();
    const $rows    = $parent.find('.list-item');

    let $generalList = null;
    $html.find('details > summary, .section-header').each((_, el) => {
        if (/^general$/i.test(el.textContent.trim())) {
            const $gen = $(el).closest('details');
            $generalList = $gen.length ? $gen : $(el).parent();
        }
    });

    if ($generalList) $rows.each((_, row) => $generalList.append(row));
    $parent.hide();
}

// ── RENDER HOOK ───────────────────────────────────────────────────────────

const _timers = new Map();

Hooks.once("ready", () => { injectStyles(); _loadQualityCache(); });

Hooks.on("renderWitcherCharacterSheet", (app, _html, _context, _options) => {
    const actor = app.actor;
    if (!actor || actor.type !== "character") return;

    clearTimeout(_timers.get(app.id));
    _timers.set(app.id, setTimeout(() => {
        _timers.delete(app.id);
        if (!app.rendered) return;

        const $html = $(app.element);
        setupChevrons($html);
        setupContainers($html, actor);
        setupContainerDrop($html, actor);
        setupQualityTags($html, actor);  // ← new
        mergeContainersIntoGeneral($html);
    }, 50));
});

Hooks.on("closeWitcherCharacterSheet", app => {
    clearTimeout(_timers.get(app.id));
    _timers.delete(app.id);
});
