/**
 * Top-bar scene menu (GM only).
 *
 * Clicking the scene name in the top bar as GM opens a floating panel
 * with two sections:
 *   1. Favorites  — user-picked scenes, always shown first, persists per-client
 *   2. Recent     — auto-tracked, last N viewed scenes
 *
 * Each row exposes ALL the controls Foundry's scene sidebar context menu
 * offers (view, activate, configure, preload, toggle nav, notes, duplicate,
 * delete, generate thumbnail, permissions) plus our favorite toggle.
 *
 * Rather than re-implementing each Foundry action (which would drift from
 * core over time), we pull the live options from
 * `ui.scenes._getEntryContextOptions()` at menu open — same list Foundry
 * builds for its own right-click menu, so any core additions surface here
 * automatically. Each option is rendered as a compact icon button; its
 * `visible(li)` predicate is honored so an action that doesn't apply
 * (e.g. Activate on the already-active scene) is hidden per row.
 *
 * Storage:
 *   localStorage `wdm.topbar.favoriteScenes` — array of scene IDs, newest
 *     favorited first.
 *   localStorage `wdm.topbar.recentScenes`   — array of scene IDs, newest
 *     viewed first, capped at RECENT_MAX.
 *
 * Client-scoped: both live in localStorage rather than Foundry settings so
 * favorites/recent are per-browser and don't burden the world config.
 */
import { t } from "../lib/i18n.js";

const FAVORITE_KEY   = "wdm.topbar.favoriteScenes";
const COLLAPSED_KEY  = "wdm.topbar.collapsedFolders";
/* When Navigation section has more scenes than this threshold, folders
 * default to COLLAPSED so the user isn't dumped into a scroll wall on
 * open. Users can still expand any folder, and search auto-expands
 * matching folders regardless. Chosen empirically: at ~30 rows the
 * menu is still fast (<50ms render) but visually starts looking
 * overwhelming, so that's the "collapse first" trigger. */
const AUTO_COLLAPSE_THRESHOLD = 30;

let menuEl = null;
let sceneNameEl = null;
/* Live search string. Empty = no filter. Reset on close so a fresh
 * open starts with everything visible. */
let searchTerm = "";

/* ── storage helpers ─────────────────────────────────────────────── */

function readList(key) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr.filter(x => typeof x === "string") : [];
    } catch (_) { return []; }
}

function writeList(key, arr) {
    try { localStorage.setItem(key, JSON.stringify(arr.slice(0, 50))); }
    catch (_) { /* quota / private mode */ }
}

function getFavoriteIds() { return readList(FAVORITE_KEY); }
function isFavorite(sceneId) { return getFavoriteIds().includes(sceneId); }

function toggleFavorite(sceneId) {
    if (!sceneId) return;
    const cur = getFavoriteIds();
    const idx = cur.indexOf(sceneId);
    if (idx >= 0) cur.splice(idx, 1);
    else cur.unshift(sceneId);
    writeList(FAVORITE_KEY, cur);
}

/* ── folder-collapse persistence ─────────────────────────────────── */

function readCollapsedMap() {
    try {
        const raw = localStorage.getItem(COLLAPSED_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch (_) { return {}; }
}
function writeCollapsedMap(map) {
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(map)); }
    catch (_) { /* quota / private mode */ }
}
function toggleFolderCollapse(folderId) {
    const map = readCollapsedMap();
    map[folderId] = !map[folderId];
    writeCollapsedMap(map);
}
/** Effective collapse state for a folder.
 *  - Explicit user preference wins (true = collapsed, false = expanded).
 *  - No explicit preference AND Navigation is big → collapsed by default.
 *  - No explicit preference AND Navigation is small → expanded by default.
 *  - Search active → always expanded (so results are visible). */
function isFolderCollapsed(folderId, autoCollapse) {
    if (searchTerm) return false;
    const map = readCollapsedMap();
    if (folderId in map) return !!map[folderId];
    return !!autoCollapse;
}

/* ── Foundry scene actions ───────────────────────────────────────── */

/** Get Foundry's live scene-directory context options, filtered to the
 *  set that makes sense inside a scene SWITCHER quick-menu.
 *
 *  Dropped from the raw Foundry list because they don't fit the
 *  "jump-to-a-scene" workflow the menu is designed for:
 *    - SCENE.ToggleNav — toggles a scene's presence in Foundry's default
 *      scene navigation bar, which the death-march chrome hides entirely.
 *      Dead-weight here.
 *    - SCENE.GenerateThumb — technical GM chore (regenerate the thumbnail
 *      image), not a switcher action.
 *    - OWNERSHIP.Configure — permissions dialog; rarely done inline while
 *      jumping between scenes.
 *
 *  Kept: View, Activate, Configure, Notes (journal), Preload, Duplicate,
 *  Delete — everything a GM actually uses when hopping between scenes. */
const DROPPED_LABELS = new Set([
    "SCENE.ToggleNav",
    "SCENE.GenerateThumb",
    "OWNERSHIP.Configure"
]);
function getFoundryContextOptions() {
    const dir = ui?.scenes;
    if (!dir || typeof dir._getEntryContextOptions !== "function") return [];
    try {
        const opts = dir._getEntryContextOptions();
        return Array.isArray(opts)
            ? opts.filter(o => !DROPPED_LABELS.has(o?.label))
            : [];
    } catch (err) {
        console.warn("wdm scene-menu | _getEntryContextOptions failed", err);
        return [];
    }
}

/** Foundry's context handlers expect an `li` element with
 *  `dataset.entryId = sceneId`. We synthesize one per row. */
function fakeLi(sceneId) {
    const li = document.createElement("li");
    li.dataset.entryId = sceneId;
    return li;
}

function sceneById(id) { return game?.scenes?.get?.(id) ?? null; }
function isActiveScene(s) { return !!s && s.active; }
function isViewedScene(s) { return !!s && game?.scenes?.viewed?.id === s.id; }

/** Return the active non-GM users whose `viewedScene` is this scene.
 *  Foundry v14 tracks each user's currently-viewed scene on
 *  `user.viewedScene` (user.mjs:51), synced across clients via the
 *  user document — so from the GM's client we can read every other
 *  user's location. Used to render a "who's here" indicator on each
 *  row so the GM can see at a glance which scene each player has
 *  open (relevant when a scene is activated but a player is still
 *  viewing another one). */
function playersViewing(scene) {
    if (!scene || !game?.users) return [];
    return game.users.filter(u => u?.active && !u.isGM && u.viewedScene === scene.id);
}

/* ── menu render ─────────────────────────────────────────────────── */

/** Convert a Foundry context option to a compact icon button. Localizes
 *  the label into the button's tooltip. Returns "" if the option's
 *  visible predicate refuses this scene. */
function renderContextButton(option, li, sceneId, idx) {
    try {
        if (typeof option.visible === "function" && !option.visible(li)) return "";
    } catch (_) { return ""; }
    const label = _localize(option.label ?? option.name ?? "");
    const iconClass = String(option.icon ?? "fa-solid fa-ellipsis")
        .replace(/"/g, "");
    return `<button type="button" class="wdm-scene-act" data-op-idx="${idx}" title="${_escape(label)}"><i class="${iconClass}"></i></button>`;
}

function renderSceneRow(scene, ctxOptions) {
    if (!scene) return "";
    const id       = scene.id;
    const name     = scene.name ?? "(unnamed)";
    const active   = isActiveScene(scene);
    const viewed   = isViewedScene(scene);
    const favorite = isFavorite(id);
    const cls = [
        "wdm-scene-row",
        active   ? "is-active" : "",
        viewed   ? "is-viewed" : "",
        favorite ? "is-favorite" : ""
    ].filter(Boolean).join(" ");

    const favLabel = favorite
        ? _localize(t("WITCHER.Chrome.Topbar.SceneMenu.Text.Unfavorite", "Unfavorite"))
        : _localize(t("WITCHER.Chrome.Topbar.SceneMenu.Text.Favorite",   "Favorite"));
    const favBtn = `<button type="button" class="wdm-scene-act wdm-scene-fav" data-op="favorite" title="${_escape(favLabel)}"><i class="fa-solid ${favorite ? "fa-star" : "fa-star"}${favorite ? " is-lit" : ""}"></i></button>`;

    const li = fakeLi(id);
    const ctxBtns = ctxOptions
        .map((opt, i) => renderContextButton(opt, li, id, i))
        .join("");

    /* Player-here indicators — a color chip per non-GM user currently
     * viewing this scene. Position after the name so the GM's eye
     * naturally goes: [favorite] name [who's here] [actions]. Empty
     * when nobody's on this scene (no visual noise on unused scenes). */
    const viewers = playersViewing(scene);
    const viewersHTML = viewers.length
        ? `<span class="wdm-scene-viewers" title="${_escape(_localize(t("WITCHER.Chrome.Topbar.SceneMenu.Text.PlayersHere", "Players viewing")))}: ${_escape(viewers.map(u => u.name).join(", "))}">
             ${viewers.map(u => `<span class="wdm-scene-viewer-dot" style="background:${u.color?.css ?? u.color ?? "#888"};"></span>`).join("")}
           </span>`
        : "";

    return `
      <div class="${cls}" data-scene-id="${id}">
        ${favBtn}
        <span class="wdm-scene-name" title="${_escape(name)}">${_escape(name)}</span>
        ${viewersHTML}
        <span class="wdm-scene-actions">${ctxBtns}</span>
      </div>`;
}

function _escape(s) {
    return String(s).replace(/[&<>"']/g, ch => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[ch]);
}
function _localize(key) {
    try { const v = game?.i18n?.localize?.(key); return v && v !== key ? v : key; }
    catch (_) { return key; }
}

/* Cached per open — the ContextMenu options list is stable while a
 * menu is open. Cleared on close so a subsequent open picks up any
 * module additions to _getEntryContextOptions. */
let _cachedCtxOptions = null;

/** Case-insensitive substring match on scene name. Empty search → true. */
function matchesSearch(scene) {
    if (!searchTerm) return true;
    const q = searchTerm.trim().toLowerCase();
    if (!q) return true;
    return String(scene?.name ?? "").toLowerCase().includes(q);
}

/** Group scenes by folder into an ordered `[{folder, scenes}]` array.
 *  Scenes without a folder go into a synthetic bucket at the top with
 *  `folder = null`. Folders themselves are sorted by their `sort` field
 *  then name; scenes within each bucket by navOrder. */
function groupByFolder(scenes) {
    const buckets = new Map();      // folderId → { folder, scenes[] }
    const noneKey = "__none__";
    for (const scene of scenes) {
        const folder = scene.folder ?? null;
        const key = folder?.id ?? noneKey;
        if (!buckets.has(key)) buckets.set(key, { folder, scenes: [] });
        buckets.get(key).scenes.push(scene);
    }
    /* Sort within each bucket by navOrder. */
    for (const b of buckets.values()) {
        b.scenes.sort((a, b) => (a.navOrder ?? 0) - (b.navOrder ?? 0));
    }
    /* Sort buckets: folderless first, then folders by (sort, name). */
    const arr = Array.from(buckets.values());
    arr.sort((a, b) => {
        if (!a.folder && b.folder) return -1;
        if (a.folder && !b.folder) return 1;
        if (!a.folder && !b.folder) return 0;
        const s = (a.folder.sort ?? 0) - (b.folder.sort ?? 0);
        if (s !== 0) return s;
        return String(a.folder.name).localeCompare(String(b.folder.name));
    });
    return arr;
}

function renderMenuHTML() {
    _cachedCtxOptions = getFoundryContextOptions();

    /* ── Section builders ─────────────────────────────────────────
     * This menu is the death-march port of Foundry's default scene
     * navigation bar. Foundry's SceneNavigation (scene-navigation.mjs
     * :86) shows a scene when: `active || isView || (navigation &&
     * visible)`. We mirror that filter, then bucket by state:
     *   1. Favorites    — user's custom picks (always shown, always
     *                     first). Not filtered by navigation flag —
     *                     a user favoriting a scene means they want
     *                     it accessible even if not in navigation.
     *   2. Current      — the scene currently on screen. Always shown
     *                     even if not flagged navigation, matching
     *                     Foundry's behavior of always showing the
     *                     viewed scene.
     *   3. Active       — the world-active scene + any scene one or
     *                     more players are currently viewing.
     *   4. Navigation   — remaining scenes with `navigation: true`
     *                     that aren't already above.
     * All sections sort by `navOrder` to match Foundry. Favorites
     * de-dupe against Current/Active/Navigation so a favorited scene
     * only appears once (in Favorites). */

    const viewedId    = game.scenes?.viewed?.id;
    const seenIds     = new Set();
    const allScenes = Array.from(game.scenes ?? []);

    /* Favorites first — resolve in favorite order (newest-first per
     * store), skip missing scenes, apply search filter. */
    const favoriteScenes = getFavoriteIds()
        .map(sceneById)
        .filter(s => s && matchesSearch(s));
    favoriteScenes.forEach(s => seenIds.add(s.id));

    /* Current viewed scene — always shown when it matches the search
     * filter (and isn't already in Favorites). */
    const viewedScene = viewedId ? sceneById(viewedId) : null;
    const currentScenes = (viewedScene && !seenIds.has(viewedScene.id) && matchesSearch(viewedScene))
        ? [viewedScene]
        : [];
    currentScenes.forEach(s => seenIds.add(s.id));

    /* Active section — world-active + player-populated. */
    const activeScenes = allScenes
        .filter(s => !seenIds.has(s.id))
        .filter(s => s.active || playersViewing(s).length)
        .filter(matchesSearch)
        .sort((a, b) => (b.active - a.active) || ((a.navOrder ?? 0) - (b.navOrder ?? 0)));
    activeScenes.forEach(s => seenIds.add(s.id));

    /* Navigation section — Foundry's `navigation: true` visible scenes
     * that aren't already above. Grouped by folder for scale. */
    const navigationScenes = allScenes
        .filter(s => !seenIds.has(s.id))
        .filter(s => s.navigation && s.visible)
        .filter(matchesSearch);
    /* Count BEFORE search filter to decide auto-collapse — if the user
     * has 500 nav-flagged scenes, we want folders collapsed even when
     * their current search happens to trim results down. */
    const navTotalUnfiltered = allScenes.filter(s => !seenIds.has(s.id) && s.navigation && s.visible).length;
    const autoCollapse = navTotalUnfiltered > AUTO_COLLAPSE_THRESHOLD;
    const navFolders = groupByFolder(navigationScenes);

    const favHeading     = _localize(t("WITCHER.Chrome.Topbar.SceneMenu.Text.Favorites",  "Favorites"));
    const currentHeading = _localize(t("WITCHER.Chrome.Topbar.SceneMenu.Text.Current",    "Current"));
    const activeHeading  = _localize(t("WITCHER.Chrome.Topbar.SceneMenu.Text.Active",     "Active"));
    const navHeading     = _localize(t("WITCHER.Chrome.Topbar.SceneMenu.Text.Navigation", "Navigation"));
    const emptyMsg       = _localize(t("WITCHER.Chrome.Topbar.SceneMenu.Text.NoScenes",   "No scenes to show."));
    const searchPh       = _localize(t("WITCHER.Chrome.Topbar.SceneMenu.Text.SearchPlaceholder", "Search scenes…"));

    const renderFlatSection = (heading, scenes) => scenes.length
        ? `<div class="wdm-scene-section">
             <div class="wdm-scene-heading">${heading}</div>
             ${scenes.map(s => renderSceneRow(s, _cachedCtxOptions)).join("")}
           </div>`
        : "";

    /* Navigation section: render folder groups (folderless bucket
     * inline, then each real folder as a collapsible sub-group). */
    const renderNavSection = () => {
        if (!navFolders.length) return "";
        const parts = [`<div class="wdm-scene-heading">${navHeading}</div>`];
        for (const { folder, scenes } of navFolders) {
            if (!folder) {
                /* Folderless scenes — flat list, no header. */
                parts.push(scenes.map(s => renderSceneRow(s, _cachedCtxOptions)).join(""));
                continue;
            }
            const collapsed = isFolderCollapsed(folder.id, autoCollapse);
            const chev = collapsed ? "fa-caret-right" : "fa-caret-down";
            const folderCls = ["wdm-scene-folder", collapsed ? "is-collapsed" : ""].filter(Boolean).join(" ");
            parts.push(`
              <div class="${folderCls}" data-folder-id="${folder.id}">
                <button type="button" class="wdm-scene-folder-header" data-op="folder-toggle">
                  <i class="fa-solid ${chev}"></i>
                  <span class="wdm-scene-folder-name" style="color:${_escape(folder.color?.css ?? folder.color ?? "")}">${_escape(folder.name)}</span>
                  <span class="wdm-scene-folder-count">${scenes.length}</span>
                </button>
                <div class="wdm-scene-folder-body">
                  ${collapsed ? "" : scenes.map(s => renderSceneRow(s, _cachedCtxOptions)).join("")}
                </div>
              </div>`);
        }
        return `<div class="wdm-scene-section">${parts.join("")}</div>`;
    };

    /* Search bar — persistent at the top of the menu. Wrapped in a
     * dedicated container so its own layout doesn't get squeezed by
     * the scrollable content below. */
    const searchBar = `
      <div class="wdm-scene-searchbar">
        <i class="fa-solid fa-magnifying-glass"></i>
        <input type="text" class="wdm-scene-search" placeholder="${_escape(searchPh)}" value="${_escape(searchTerm)}" spellcheck="false" autocomplete="off"/>
      </div>`;

    let html = `<div class="wdm-scene-menu-inner">`;
    html += searchBar;
    html += `<div class="wdm-scene-scroll">`;
    html += renderFlatSection(favHeading,     favoriteScenes);
    html += renderFlatSection(currentHeading, currentScenes);
    html += renderFlatSection(activeHeading,  activeScenes);
    html += renderNavSection();
    if (!favoriteScenes.length && !currentScenes.length &&
        !activeScenes.length && !navigationScenes.length) {
        html += `<div class="wdm-scene-empty">${emptyMsg}</div>`;
    }
    html += `</div></div>`;
    return html;
}

/* ── show / hide / position ──────────────────────────────────────── */

function ensureMenuEl() {
    if (menuEl && document.body.contains(menuEl)) return menuEl;
    menuEl = document.createElement("div");
    menuEl.id = "wdm-scene-menu";
    menuEl.className = "wdm-scene-menu";
    menuEl.setAttribute("aria-hidden", "true");
    document.body.appendChild(menuEl);
    /* Click delegation. Bound once here so re-renders of `.innerHTML`
     * don't strand listeners. */
    menuEl.addEventListener("click", onMenuClick);
    /* Left-click on the scene name area of a row activates + views;
     * matches the common "click a scene to jump there" UX. */
    menuEl.addEventListener("click", onSceneNameClick, true);
    /* Search input events — bound at the container level so re-renders
     * of `.innerHTML` don't lose them. `input` fires on every keystroke,
     * which drives the live filter. */
    menuEl.addEventListener("input", onSearchInput);
    /* Focus + selection preservation: re-rendering the menu HTML wipes
     * the search input. We capture caret + focus before render and
     * restore after via `re-render`, so typing feels continuous even
     * as the results below refresh with each keystroke. */
    return menuEl;
}

/** Rebuild the menu HTML and reposition, preserving search-input
 *  focus + caret position across the re-render. */
function rerender() {
    if (!menuEl) return;
    const activeInput = document.activeElement === menuEl.querySelector(".wdm-scene-search");
    const selStart = activeInput ? menuEl.querySelector(".wdm-scene-search").selectionStart : null;
    const selEnd   = activeInput ? menuEl.querySelector(".wdm-scene-search").selectionEnd   : null;
    menuEl.innerHTML = renderMenuHTML();
    if (activeInput) {
        const inp = menuEl.querySelector(".wdm-scene-search");
        if (inp) {
            inp.focus();
            try { inp.setSelectionRange(selStart, selEnd); } catch (_) {}
        }
    }
    positionMenu();
}

function onSearchInput(ev) {
    const inp = ev.target.closest(".wdm-scene-search");
    if (!inp) return;
    searchTerm = inp.value ?? "";
    rerender();
}

function positionMenu() {
    if (!menuEl || !sceneNameEl) return;
    const rect = sceneNameEl.getBoundingClientRect();
    const gap = 6;
    const menuRect = menuEl.getBoundingClientRect();
    let top  = rect.bottom + gap;
    let left = rect.left;
    /* Clamp horizontally so the menu doesn't clip off the right edge. */
    const maxLeft = window.innerWidth - menuRect.width - 8;
    if (left > maxLeft) left = Math.max(8, maxLeft);
    /* Flip above if there's no room below (unlikely with topbar). */
    const maxTop = window.innerHeight - menuRect.height - 8;
    if (top > maxTop) top = Math.max(8, rect.top - menuRect.height - gap);
    menuEl.style.top  = `${Math.round(top)}px`;
    menuEl.style.left = `${Math.round(left)}px`;
}

export function openMenu() {
    ensureMenuEl();
    menuEl.innerHTML = renderMenuHTML();
    menuEl.classList.add("is-open");
    menuEl.setAttribute("aria-hidden", "false");
    sceneNameEl?.classList.add("wdm-scene-name-active");
    positionMenu();
    document.addEventListener("pointerdown", onDocPointerDown, true);
    document.addEventListener("keydown", onDocKeyDown, true);
}

export function closeMenu() {
    if (!menuEl) return;
    menuEl.classList.remove("is-open");
    menuEl.setAttribute("aria-hidden", "true");
    sceneNameEl?.classList.remove("wdm-scene-name-active");
    _cachedCtxOptions = null;
    /* Fresh open = fresh search. Preserving the search across opens
     * would surprise the user with a stale filter next time. */
    searchTerm = "";
    document.removeEventListener("pointerdown", onDocPointerDown, true);
    document.removeEventListener("keydown", onDocKeyDown, true);
}

function isMenuOpen() { return !!menuEl?.classList.contains("is-open"); }

function onDocPointerDown(ev) {
    if (!menuEl) return;
    if (menuEl.contains(ev.target)) return;
    if (sceneNameEl && sceneNameEl.contains(ev.target)) return;
    closeMenu();
}

function onDocKeyDown(ev) {
    if (ev.key === "Escape") closeMenu();
}

/** Click on the scene name text portion of a row = view that scene
 *  (like clicking a scene in Foundry's directory). Uses capture so it
 *  fires before the icon-button handler; icon clicks are caught first
 *  by their own bubble-phase listener. */
function onSceneNameClick(ev) {
    const nameEl = ev.target.closest(".wdm-scene-name");
    if (!nameEl) return;
    const row = nameEl.closest("[data-scene-id]");
    if (!row) return;
    const scene = sceneById(row.dataset.sceneId);
    if (!scene) return;
    ev.stopPropagation();
    ev.preventDefault();
    scene.view();
    closeMenu();
}

async function onMenuClick(ev) {
    const btn = ev.target.closest("[data-op], [data-op-idx]");
    if (!btn) return;

    /* Folder header toggle — collapse/expand the folder's scene list.
     * Handled BEFORE the scene-row branch because folder headers are
     * NOT inside a `[data-scene-id]` element. */
    if (btn.dataset.op === "folder-toggle") {
        const folderEl = btn.closest("[data-folder-id]");
        if (!folderEl) return;
        ev.stopPropagation();
        ev.preventDefault();
        toggleFolderCollapse(folderEl.dataset.folderId);
        rerender();
        return;
    }

    const row = btn.closest("[data-scene-id]");
    if (!row) return;
    const sceneId = row.dataset.sceneId;
    const scene = sceneById(sceneId);
    if (!scene) return;
    ev.stopPropagation();
    ev.preventDefault();

    if (btn.dataset.op === "favorite") {
        toggleFavorite(sceneId);
        rerender();
        return;
    }

    /* Foundry context option — dispatch by index. */
    const idx = Number(btn.dataset.opIdx);
    const opt = _cachedCtxOptions?.[idx];
    if (!opt || typeof opt.onClick !== "function") return;
    const li = fakeLi(sceneId);
    try {
        await opt.onClick(ev, li);
    } catch (err) {
        console.warn("wdm scene-menu | context option failed", err);
    }
    /* Refresh the menu so state icons (active-star, viewed-highlight,
     * nav-toggle) update after the action. If Foundry's onClick opened
     * a sheet or dialog, we still close our menu — feels natural. */
    if (opt.label === "SCENE.Configure" || opt.label === "SCENE.Notes") {
        closeMenu();
        return;
    }
    if (isMenuOpen()) rerender();
}

/* ── wiring ──────────────────────────────────────────────────────── */

function toggleMenu(ev) {
    if (ev) { ev.preventDefault(); ev.stopPropagation(); }
    if (isMenuOpen()) closeMenu();
    else openMenu();
}

/** Attach click handler to the scene-name span in the topbar. GM-only —
 *  non-GM users get no click affordance (regular text). Idempotent. */
export function wireSceneMenu() {
    sceneNameEl = document.querySelector('#wou-top-bar [data-bind="scene-name"]');
    if (!sceneNameEl) return;
    if (!game?.user?.isGM) return;

    /* Cursor + class signal that the scene name is now clickable. */
    sceneNameEl.classList.add("wdm-scene-name-clickable");

    /* Left-click OR right-click on the name opens the menu. Right-click
     * preventDefault swallows the browser context menu. */
    sceneNameEl.addEventListener("click", toggleMenu);
    sceneNameEl.addEventListener("contextmenu", toggleMenu);

    /* Live refresh when scene state changes so Current / Active /
     * Navigation buckets stay accurate while the menu is open. */
    const refreshIfOpen = () => {
        if (!isMenuOpen()) return;
        rerender();   // preserves search focus/caret
    };
    Hooks.on("updateScene", refreshIfOpen);
    Hooks.on("createScene", refreshIfOpen);
    Hooks.on("deleteScene", refreshIfOpen);
    /* canvasReady fires when the GM (or a player) switches scenes —
     * the Current bucket needs to move to the new scene. */
    Hooks.on("canvasReady", refreshIfOpen);

    /* User state — players joining/leaving OR switching scenes update
     * the "who's here" chips on each row. `updateUser` fires when
     * `viewedScene` changes; `userConnected` fires on connect/disconnect
     * (chips vanish when a player logs out). */
    Hooks.on("updateUser", refreshIfOpen);
    Hooks.on("userConnected", refreshIfOpen);
}
