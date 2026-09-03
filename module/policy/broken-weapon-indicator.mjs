/**
 * Broken-weapon visual indicator.
 *
 * A weapon / shield is "broken" when reliability.max > 0 and
 * reliability.value === 0. Broken items stay equipped (per user spec —
 * "doesn't return to inventory") but should be visually distinct
 * everywhere they appear: actor sheet inventory rows, container UIs,
 * merchant inventories, the chrome combat dock, the token HUD, etc.
 *
 * Approach: instead of hand-instrumenting every template + every
 * dynamic DOM build site (there are 8+ of them across system + chrome),
 * we hook the universal `renderApplication` event and walk the
 * rendered element looking for `[data-item-id]` nodes. For each, we
 * resolve the item, check its broken state, and toggle
 * `data-wdm-broken="1"` + the `wdm-item-broken` class. CSS handles the
 * visual (diagonal slash + dimmed icon + a small "BROKEN" badge).
 *
 * The hook runs cheap when nothing changed — toggling a data attr is a
 * no-op if it's already set to the same value.
 */

const SYSTEM_ID = "witcher-ttrpg-death-march";

function isBrokenItem(item) {
    if (!item) return false;
    if (item.type !== "weapon" && item.type !== "shield") return false;
    const max = Number(item.system?.reliability?.max) || 0;
    if (max <= 0) return false;
    const cur = Number(item.system?.reliability?.value) || 0;
    return cur <= 0;
}

/* Marker text appended to broken-item names. Wrapped in a span so we
 * can find + strip it on repair without leaving "(BROKEN)" stuck on
 * the visible name. */
const BROKEN_LABEL_HTML = ` <span class="wdm-broken-label" data-wdm-broken-label="1">(BROKEN)</span>`;

function stripBrokenLabel(text) {
    return String(text ?? "").replace(/\s*\(BROKEN\)\s*$/i, "");
}

/* Apply the brain-dead-simple "broken" decoration to a single item row:
 *   1. Grey out every <img> inside it (inline opacity so it beats most
 *      sheet stylesheets).
 *   2. Append " (BROKEN)" to the item-name element — looks for the most
 *      common name-bearing children (.item-name, .wcs-item-name,
 *      .weapon-name, the first text child, or the row's own innerHTML
 *      if it's a plain text label). Idempotent.
 * On repair, both effects are reversed. */
/* Selectors that host the WEAPON ICON specifically (not action button
 * glyphs in the same row). Per-surface:
 *   <img> / .icon / .item-image — actor sheet + merchant + chrome img slots
 *   .weapon-icon-wrap > i       — chrome dock (icon lives in this span)
 *   .wou-equip > i.fa-solid     — chrome equip slot fallback when item has no img
 *   .bs-item-slot > i.fa-solid  — merchant slot fallback (same)
 *   background-image            — any element using a CSS-painted icon
 *
 * Deliberately NOT using broad `i.fa-solid` — that'd also grey the
 * Sheath / Unequip / Drop action buttons sharing the row. */
const ICON_SELECTORS = [
    "img",
    ".icon", ".item-image", ".wcs-item-icon", ".wou-slot-icon",
    ".bs-item-img", ".wou-cw-art",
    ".weapon-icon-wrap > i",
    ".wou-equip > i.fa-solid",
    ".bs-item-slot > i.fa-solid",
    "i.wou-cw-art",
    "[style*='background-image']"
].join(", ");

function dimIconNode(node) {
    if (!node) return;
    if (!node.dataset.wdmBrokenPrev) {
        node.dataset.wdmBrokenPrev = JSON.stringify({
            filter: node.style.filter || ""
        });
    }
    /* Pure desaturation — no brightness reduction, no opacity dimming.
     * "Greyed out" = saturation 0, not "darker / fainter". */
    node.style.filter = "grayscale(1)";
}

function undimIconNode(node) {
    if (!node?.dataset?.wdmBrokenPrev) return;
    let prev = {};
    try { prev = JSON.parse(node.dataset.wdmBrokenPrev); } catch (_) {}
    node.style.filter = prev.filter ?? "";
    delete node.dataset.wdmBrokenPrev;
}

function applyBrokenDeco(el) {
    if (el.dataset.wdmBrokenDeco === "1") return;
    el.dataset.wdmBrokenDeco = "1";

    /* Grey out the ICON: try multiple selectors so we cover both
     * sheet-style <img> icons AND chrome-inventory .icon images
     * AND any element with a background-image style. */
    el.querySelectorAll(ICON_SELECTORS).forEach(dimIconNode);
    /* If the row itself uses a background-image, dim THAT too. */
    const styleBg = el.style?.backgroundImage || "";
    if (styleBg && styleBg !== "none") dimIconNode(el);

    /* Append (BROKEN) wherever the item's NAME is visible. */
    const nameNode = el.querySelector(
        ".wcs-item-name, .item-name, .weapon-name, .name, .wdm-item-name, " +
        ".bs-item-name, .bs-item-label, .bs-item-clickable .name, " +
        ".col-name, td.col-name, " +
        ".wou-inspection-name, .wou-inspection-body h1, .wou-inspection-body h2, " +
        "[data-bind='name']"
    );
    const hasNameLabel = !!nameNode;
    if (nameNode && !nameNode.querySelector(".wdm-broken-label")) {
        nameNode.insertAdjacentHTML("beforeend", BROKEN_LABEL_HTML);
    }
    /* Many chrome surfaces (inventory slots, equip slots, container
     * mounts) have no visible name — the item name lives only in the
     * `title` tooltip. Append (BROKEN) to the title too so hovering
     * a broken slot reads "Sword (BROKEN)". */
    if (el.hasAttribute("title")) {
        const orig = el.getAttribute("title") || "";
        if (!/\(BROKEN\)\s*$/i.test(orig)) {
            el.dataset.wdmBrokenOrigTitle = orig;
            el.setAttribute("title", `${orig} (BROKEN)`);
        }
    }
    /* That's it. No wrench, no badge, no overlay. The two effects above
     * (grey the icon, append (BROKEN) to the name) are the entire
     * indicator. If a surface has no visible name, the (BROKEN) tag
     * goes onto the title tooltip handled above. */
}

function clearBrokenDeco(el) {
    if (el.dataset.wdmBrokenDeco !== "1") return;
    delete el.dataset.wdmBrokenDeco;
    /* Undim everything we dimmed (img + .icon + background-image + el) */
    el.querySelectorAll(ICON_SELECTORS).forEach(undimIconNode);
    undimIconNode(el);
    /* Strip the (BROKEN) label */
    el.querySelectorAll(".wdm-broken-label").forEach(n => n.remove());
    /* Also remove any prior wrench icons / icon wrappers from earlier
     * versions of this decorator — left in for safe upgrade. */
    el.querySelectorAll(".wdm-broken-icon").forEach(n => n.remove());
    el.querySelectorAll(".wdm-broken-icon-wrap").forEach(wrap => {
        const parent = wrap.parentNode;
        if (!parent) return;
        while (wrap.firstChild) parent.insertBefore(wrap.firstChild, wrap);
        wrap.remove();
    });
    /* Restore the original title attribute */
    if (el.dataset.wdmBrokenOrigTitle != null) {
        el.setAttribute("title", el.dataset.wdmBrokenOrigTitle);
        delete el.dataset.wdmBrokenOrigTitle;
    } else {
        /* Title might have been mutated by another pass — strip any
         * trailing "(BROKEN)" defensively. */
        const t = el.getAttribute("title");
        if (t) el.setAttribute("title", stripBrokenLabel(t));
    }
}

/** Walk an HTMLElement subtree and decorate every [data-item-id] node
 *  that refers to a broken weapon/shield on ANY actor we can find the
 *  item in. Idempotent — running it twice is fine.
 *
 *  `contextActor` (optional) is the actor we already know from the
 *  application context (ActorSheet → app.actor). When present, it
 *  short-circuits the ancestor scan: actor sheets rarely stamp
 *  data-actor-id on every row, so without it `item` resolution fails
 *  and the broken badge never paints. */
function decorate(root, contextActor = null) {
    if (!root || !root.querySelectorAll) return;
    /* Some sheets put data-item-id on the row, others put it on a
     * child button. Decorate every node that carries it AND has the
     * resolved item broken — but de-dupe by item-id so we don't
     * grey-out the same row 5 times for 5 different buttons inside it. */
    const nodes = root.querySelectorAll("[data-item-id]");
    if (!nodes.length) return;
    /* Group nodes by item-id so we can decorate the OUTERMOST row
     * (not the inner buttons), which is what the user actually sees. */
    const byId = new Map();
    for (const el of nodes) {
        const id = el.dataset.itemId;
        if (!id) continue;
        const list = byId.get(id) ?? [];
        list.push(el);
        byId.set(id, list);
    }
    for (const [itemId, els] of byId) {
        /* Resolve the item ONCE per id (lookup is the expensive part). */
        let item = contextActor?.items?.get?.(itemId) ?? null;
        if (!item) {
            /* Try resolving via any ancestor that exposes an actor link
             * from any of the candidate nodes (not just els[0]) — the
             * same item id can appear in multiple subtrees, only some
             * of which have a data-actor-id ancestor. */
            for (const el of els) {
                const ancestor = el.closest("[data-actor-id], [data-actor-uuid]");
                if (!ancestor) continue;
                const actorId = ancestor.dataset?.actorId;
                const actorUuid = ancestor.dataset?.actorUuid;
                const ancestorActor = actorId
                    ? game.actors?.get(actorId)
                    : (actorUuid ? fromUuidSync?.(actorUuid) : null);
                item = ancestorActor?.items?.get?.(itemId) ?? null;
                if (item) break;
            }
        }
        if (!item) item = game.items?.get(itemId) ?? null;
        if (!item) {
            for (const a of (game.actors?.contents ?? [])) {
                const found = a.items?.get?.(itemId);
                if (found) { item = found; break; }
            }
        }
        const broken = isBrokenItem(item);

        /* Decorate EVERY element with this id — same broken weapon
         * might be visible on the dock AND a hand slot AND inside a
         * container popup AND on the merchant view all at once. The
         * earlier de-dupe-to-one-row was the actual bug: a multi-
         * surface item only got greyed in whichever surface happened
         * to be first in DOM order. */
        for (const row of els) {
            if (broken) {
                row.dataset.wdmBroken = "1";
                row.classList.add("wdm-item-broken");
                applyBrokenDeco(row);
            } else {
                if (row.dataset.wdmBroken === "1") {
                    delete row.dataset.wdmBroken;
                    row.classList.remove("wdm-item-broken");
                }
                clearBrokenDeco(row);
            }
        }
    }
}

export function registerBrokenWeaponIndicator() {
    /* Foundry v13+ render hooks. The system actor sheets fire
     * renderApplicationV2; legacy v1 apps fire renderApplication. */
    const onRender = (app, el) => {
        try {
            const root = el instanceof HTMLElement ? el : el?.[0];
            const ctxActor = app?.actor
                          ?? (app?.document?.documentName === "Actor" ? app.document : null);
            decorate(root, ctxActor);
        } catch (err) {
            console.warn(`${SYSTEM_ID} | broken-indicator decorate failed`, err);
        }
    };
    Hooks.on("renderApplication",   onRender);
    Hooks.on("renderApplicationV2", onRender);

    /* Re-decorate when any weapon/shield item updates — repair / break
     * flip should reflect everywhere instantly. */
    Hooks.on("updateItem", (item) => {
        if (item.type !== "weapon" && item.type !== "shield") return;
        try { decorate(document); }
        catch (err) { console.warn(`${SYSTEM_ID} | broken-indicator updateItem decorate failed`, err); }
    });

    /* The chrome inventory + dock + token HUD render via direct
     * `innerHTML = ...` assignment, which fires NO Foundry hook at all.
     * Listening on render hooks alone misses every chrome panel.
     *
     * MutationObserver catches it: whenever a [data-item-id] node
     * appears (or moves) anywhere in the document body, schedule a
     * re-decoration. Debounced to one rAF tick so a panel that rewrites
     * 50 slots in one innerHTML assignment triggers ONE decorate call.
     *
     * Filter: only fire when added nodes actually contain item-ids
     * (skip cosmetic re-renders, tooltips, etc). */
    let pending = false;
    const scheduleScan = () => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
            pending = false;
            try { decorate(document.body); }
            catch (err) { console.warn(`${SYSTEM_ID} | broken-indicator observer decorate failed`, err); }
        });
    };
    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            for (const n of (m.addedNodes ?? [])) {
                if (n.nodeType !== 1) continue;
                if (n.matches?.("[data-item-id]") || n.querySelector?.("[data-item-id]")) {
                    scheduleScan();
                    return;
                }
            }
        }
    });
    /* Start observing once the body exists. */
    const startObserver = () => {
        if (!document.body) return;
        observer.observe(document.body, { childList: true, subtree: true });
        /* Initial sweep over whatever's already in the DOM at startup. */
        scheduleScan();
    };
    if (document.body) startObserver();
    else document.addEventListener("DOMContentLoaded", startObserver, { once: true });
    /* Also do a sweep on `ready` — by then all chrome panels are wired
     * and any pre-populated state needs initial decoration. */
    Hooks.once("ready", () => scheduleScan());
    Hooks.on("canvasReady", () => scheduleScan());
}
