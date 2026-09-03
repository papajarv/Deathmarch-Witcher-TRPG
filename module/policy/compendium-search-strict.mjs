/**
 * Directory search — strict entry-name matching.
 *
 * Two things user doesn't want in this system's compendium/sidebar search:
 *   1. Folder-name cascade — a folder-name match auto-includes every child
 *      entry in the results.
 *   2. Full-text search (in FULL mode) — greps sheet content and returns
 *      loosely-related items.
 *
 * IMPORTANT — CSS-based hiding does NOT work reliably in Foundry v14. Core
 * uses CSS Cascade Layers (@layer applications { ... }); when both an
 * anonymous-layer and a layered rule declare `!important`, the LAYERED
 * rule wins ("!important inversion"). So we can't rely on `display: none !important` from the
 * system stylesheet to hide entries — we have to detach the DOM nodes.
 *
 * Approach:
 *  - Hook `renderCompendium` / `renderDocumentDirectory`.
 *  - Clone the search input to strip Foundry's own SearchFilter listener
 *    (which is stored inside a debounce closure — see search-filter.mjs —
 *    and can't be replaced via prototype patch).
 *  - Attach our own debounced input listener.
 *  - On query change: RESTORE all previously-removed nodes to their original
 *    parent/next-sibling positions, then walk the collection to find name
 *    matches (no folder cascade, no full-text), then DETACH every non-match.
 *  - Empty query → restore everything.
 *
 * Playlist directory is deliberately left alone — its folder-cascade
 * drives track highlighting and users depend on it.
 */

const SYSTEM_ID   = "witcher-ttrpg-death-march";
const DEBOUNCE_MS = 100;

export function installCompendiumSearchStrict() {
    Hooks.on("renderCompendium",         wireStrictSearch);
    Hooks.on("renderDocumentDirectory",  wireStrictSearch);
}

function wireStrictSearch(app, html /* , context, options */) {
    try {
        const root  = html instanceof HTMLElement ? html : html?.[0];
        if (!root) return;
        const oldInput = root.querySelector("search input, input[name='search'], input[type='search']");
        const list     = root.querySelector(".directory-list");
        if (!oldInput || !list) return;

        /* Clone the input to strip Foundry's SearchFilter listener. */
        const input = oldInput.cloneNode(true);
        oldInput.replaceWith(input);
        input.dataset.wdmStrict = "1";

        /* Store {parent, nextSibling} of every detached node so we can
         * put it back exactly where it belonged when the query changes or
         * clears. Fresh per wire so re-renders start clean. */
        const detached = new Map();
        /* Snapshot of folder expand/collapse state captured the moment a search
         * begins, so clearing the query returns folders to how the user had
         * them — not fully expanded (the search auto-expands to reveal hits).
         * `.snap` is null when no search is active. */
        const savedExpansion = { snap: null };

        let timer = null;
        input.addEventListener("input", (ev) => {
            const value = ev.target.value ?? "";
            clearTimeout(timer);
            timer = setTimeout(() => applyStrictFilter(value, list, app, detached, savedExpansion), DEBOUNCE_MS);
        });

        /* Initial pass — reflect any pre-populated query. */
        applyStrictFilter(input.value ?? "", list, app, detached, savedExpansion);
    } catch (err) {
        console.warn(`${SYSTEM_ID} | strict-search wire failed`, err);
    }
}

/* Restore every previously-detached node to its original spot. Must run
 * BEFORE any new filter pass so the collection walk sees the full tree.
 *
 * Order matters: entries are detached first (leaves), folders second
 * (branches), so a naive single pass in insertion order tries to re-insert an
 * entry into a subfolder whose folder node hasn't been reconnected yet — its
 * stored parent isn't `.isConnected`, the node gets skipped, and the item is
 * lost (the "clearing search wipes items inside folders/subfolders" bug).
 *
 * Fix: re-insert in repeated passes. Each pass reconnects whatever parents are
 * now connected (ancestors first cascade down to descendants); loop until a
 * pass makes no progress. Anything still unattachable had a parent that truly
 * left the DOM (e.g. a re-render replaced the list) and is safely dropped. */
function restoreAll(detached) {
    let remaining = Array.from(detached.entries());
    let progress = true;
    while (remaining.length && progress) {
        progress = false;
        const still = [];
        for (const item of remaining) {
            const [el, { parent, nextSibling }] = item;
            if (!parent || !parent.isConnected) { still.push(item); continue; }
            if (nextSibling && nextSibling.parentNode === parent) parent.insertBefore(el, nextSibling);
            else parent.appendChild(el);
            progress = true;
        }
        remaining = still;
    }
    detached.clear();
}

function applyStrictFilter(rawQuery, list, app, detached, savedExpansion) {
    /* Always restore first — otherwise a second query wouldn't know about
     * nodes we removed in the previous pass. */
    restoreAll(detached);

    const query = String(rawQuery ?? "").trim();
    if (!query) {
        /* Empty query — everything restored. Return folders to their
         * pre-search expand state (the search auto-expanded survivors). */
        if (savedExpansion?.snap) {
            for (const el of list.querySelectorAll(".directory-item.folder")) {
                const id = el.dataset.folderId;
                if (id == null) continue;
                const wasExpanded = savedExpansion.snap.get(id);
                if (wasExpanded === undefined) continue;
                el.classList.toggle("expanded", wasExpanded);
            }
            savedExpansion.snap = null;
        }
        return;
    }

    /* Snapshot the pre-search folder expand state ONCE, before the pass below
     * force-expands survivors — captured after restoreAll so the whole tree is
     * present. Only the first keystroke of a search run captures it. */
    if (savedExpansion && !savedExpansion.snap) {
        savedExpansion.snap = new Map();
        for (const el of list.querySelectorAll(".directory-item.folder")) {
            const id = el.dataset.folderId;
            if (id != null) savedExpansion.snap.set(id, el.classList.contains("expanded"));
        }
    }

    const cleanQuery = foundry.applications.ux.SearchFilter.cleanQuery;
    const rgx        = new RegExp(RegExp.escape(cleanQuery(query)), "i");
    const collection = app?.collection;
    const entries    = collection?.index ?? collection?.contents ?? null;

    const keepEntryIds  = new Set();
    const keepFolderIds = new Set();

    if (entries) {
        for (const entry of entries) {
            if (!rgx.test(cleanQuery(entry.name))) continue;
            keepEntryIds.add(entry._id);
            let folder = entry.folder;
            while (folder) {
                const fid = typeof folder === "string" ? folder : folder._id;
                if (keepFolderIds.has(fid)) break;
                keepFolderIds.add(fid);
                const fobj = typeof folder === "string"
                    ? collection.folders?.get?.(folder)
                    : folder;
                /* Walk to the parent via the raw stored id, NOT via the
                 * `fobj.folder` getter. In v14 that getter routes through
                 * `ForeignDocumentField.initialize` → `Folder.get(id, {pack})`
                 * → `pack.index.get(id)` — but pack folders live in
                 * `pack.folders`, not `pack.index`, so the lookup returns
                 * null and the walk terminates one hop early. Result:
                 * grandparent folders never enter `keepFolderIds`, get
                 * detached, and carry the matching entry away with them.
                 * Reading `_source.folder` sidesteps the getter and lets
                 * the next iteration resolve the id via `collection.folders`. */
                folder = fobj?._source?.folder ?? null;
            }
        }
    } else {
        /* Rare fallback — no collection object exposed. Match by DOM name. */
        for (const el of list.querySelectorAll(".directory-item:not(.folder)")) {
            const text = cleanQuery(el.querySelector(".entry-name, .document-name, .name")?.textContent ?? "");
            if (rgx.test(text)) keepEntryIds.add(el.dataset.entryId);
        }
        for (const el of list.querySelectorAll(".directory-item.folder")) {
            const hit = Array.from(el.querySelectorAll(".directory-item:not(.folder)"))
                .some(c => keepEntryIds.has(c.dataset.entryId));
            if (hit) keepFolderIds.add(el.dataset.folderId);
        }
    }

    /* Two-pass detach: entries first (leaves), then folders (branches).
     * Snapshot the query results because detaching mutates the tree. */
    const entryEls = Array.from(list.querySelectorAll(".directory-item:not(.folder)"));
    for (const el of entryEls) {
        if (keepEntryIds.has(el.dataset.entryId)) continue;
        detached.set(el, { parent: el.parentNode, nextSibling: el.nextSibling });
        el.remove();
    }
    const folderEls = Array.from(list.querySelectorAll(".directory-item.folder"));
    for (const el of folderEls) {
        if (keepFolderIds.has(el.dataset.folderId)) continue;
        detached.set(el, { parent: el.parentNode, nextSibling: el.nextSibling });
        el.remove();
    }

    /* Expand every surviving folder so matches inside are actually
     * visible (Foundry hides `.subdirectory` when the folder LI lacks
     * `.expanded`). Add-only — never touch existing state on folders
     * outside the query result. */
    for (const el of list.querySelectorAll(".directory-item.folder")) {
        el.classList.add("expanded");
    }
}
