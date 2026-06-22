/**
 * Witcher Token HUD — full custom replacement for Foundry's default token
 * HUD. Opens on right-click of a token; dismissed by clicking elsewhere
 * on the scene, by deselecting the token, or via the close button. Each
 * right-click reopens it, so the panel can be cycled freely. Matches the
 * chrome dock + character panel design (dark amber gradients, display-
 * font labels, hairline borders, ornate frame).
 *
 * Layout (vertical panel anchored to the right of the selected token):
 *
 *   ┌─────────────────────────┐
 *   │  ◯ Token portrait       │
 *   │  TOKEN NAME             │
 *   ├─────────────────────────┤
 *   │  COMBAT                 │
 *   │  [In Combat] [Hide]     │
 *   │  [Target]               │
 *   ├─────────────────────────┤
 *   │  STATUSES               │
 *   │  [◉][◉][◉][◉] …         │
 *   ├─────────────────────────┤
 *   │  VITALITY               │
 *   │  HP  ▓▓▓▓▓░░ 23/30      │
 *   │  STA ▓▓▓░░░░  8/10      │
 *   ├─────────────────────────┤
 *   │  [Sheet] [Configure]    │
 *   └─────────────────────────┘
 *
 * Implementation:
 *   - `renderTokenHUD` (fired by Foundry on right-click) is the trigger:
 *     we close Foundry's default HUD and build our own panel anchored to
 *     the right-clicked token. Re-firing on every right-click means the
 *     panel can be reopened without re-selecting the token.
 *   - A capture-phase window `pointerdown` listener dismisses the HUD on
 *     any click outside it that isn't a Foundry UI panel.
 *   - On `controlToken(token, false)` or scene change the HUD is removed.
 *   - On `canvasPan` (panning / zooming) the HUD is re-positioned so it
 *     tracks the token.
 *   - On actor or token updates the HUD re-renders to reflect new HP,
 *     status effects, etc.
 *
 * Status grid pulls directly from CONFIG.statusEffects so it picks up
 * the homebrew Witcher statuses (food/drink, stress breaks/boons, etc.)
 * as well as RAW conditions.
 */

import { clauseFor } from "../mechanics/statusEngine.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const HUD_ID = "wdm-token-hud";

/* DoT statuses (bleed, burning, acid, poison …) stack per instance — each
 * application is its own AE that ticks separately. Matches the Apply Status
 * picker in chrome/chrome/context-menu-actor.js so the HUD and the actor-
 * sidebar dialog share one stacking model. */
const isStackableStatus = (id) => !!clauseFor(id)?.dot;
const statusInstanceCount = (actor, id) =>
    actor?.effects?.contents?.filter(e => e.statuses?.has?.(id)).length ?? 0;

let _hudEl = null;
let _activeToken = null;
let _hooksWired = false;
/* Persisted across re-renders so the GM's preferences aren't reset
 * every time the HUD repaints (which happens on every actor/token/effect
 * update tick). Module-level so they survive token deselect+reselect too. */
let _statusesOpen = false;
let _hudPosition = null;   // {left, top} once dragged; null = anchor to token
let _dragState = null;

/* ─────────── DOM rendering ─────────── */

function escapeAttr(s) {
    return String(s ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}
function escapeText(s) {
    return String(s ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}

function getActorPortrait(actor, token) {
    return actor?.img && !actor.img.includes("mystery-man")
        ? actor.img
        : token?.document?.texture?.src ?? "";
}

function renderVitalityBar(label, cur, max) {
    const pct = max > 0 ? Math.max(0, Math.min(100, (cur / max) * 100)) : 0;
    return `
        <div class="wdm-hud-bar">
            <span class="wdm-hud-bar-label">${escapeText(label)}</span>
            <div class="wdm-hud-bar-track">
                <span class="wdm-hud-bar-fill" data-kind="${escapeAttr(label.toLowerCase())}" style="width:${pct}%;"></span>
            </div>
            <span class="wdm-hud-bar-num">${cur}/${max}</span>
        </div>
    `;
}

function renderStatusGrid(token) {
    const statuses = CONFIG.statusEffects ?? [];
    const actor = token?.actor;
    /* Source of truth is the actor's status Set (derived from its applied
     * effects), NOT the token document — token.document.statuses is not a
     * mirror of the actor's effect-borne statuses, so reading it here was
     * making statuses applied via any other path (sidebar Apply Status
     * dialog, drag-drop, programmatic toggles) look inactive in the HUD. */
    const active = actor?.statuses ?? new Set();
    return statuses.map(s => {
        const id = s.id;
        if (!id) return "";
        const name = game.i18n?.localize?.(s.name ?? s.label ?? id) ?? (s.name ?? id);
        const img  = s.img ?? s.icon ?? "icons/svg/aura.svg";
        const stack = isStackableStatus(id);
        const count = stack && actor ? statusInstanceCount(actor, id) : 0;
        const isActive = stack ? count > 0 : active.has?.(id);
        const title = stack
            ? `${name} — left-click: add a stack · right-click: remove one (non-wound)`
            : name;
        return `
            <button type="button" class="wdm-hud-status ${isActive ? "is-active" : ""}"
                    data-action="toggle-status" data-status="${escapeAttr(id)}"
                    data-stackable="${stack}"
                    title="${escapeAttr(title)}">
                <img src="${escapeAttr(img)}" alt="" draggable="false"/>
                ${stack && count > 0 ? `<span class="wdm-hud-status-count">${count}</span>` : ""}
            </button>
        `;
    }).join("");
}

function buildHUD(token) {
    const actor = token.actor;
    const portraitSrc = getActorPortrait(actor, token);
    const name = actor?.name ?? token.name ?? "Token";

    // Vitality readouts from Witcher's derivedStats (chrome dock uses the
    // same path). Fall back gracefully if a non-character is selected.
    const hp  = { cur: Number(actor?.system?.derivedStats?.hp?.value)  || 0,
                  max: Number(actor?.system?.derivedStats?.hp?.max)    || 0 };
    const sta = { cur: Number(actor?.system?.derivedStats?.sta?.value) || 0,
                  max: Number(actor?.system?.derivedStats?.sta?.max)   || 0 };

    const inCombat = !!game.combat?.combatants?.some?.(c => c.tokenId === token.id);
    const isHidden = !!token.document.hidden;
    const isTargeted = token.document.isTargeted;

    const el = document.createElement("div");
    el.id = HUD_ID;
    el.className = "wdm-token-hud";
    /* Inline dimensions on the container + the portrait img as a safety
     * net. If the system CSS file fails to load (cache miss, override
     * conflict), the panel still renders at sane dimensions instead of
     * blowing up into a screen-filling natural-resolution image. */
    el.style.cssText = "width:240px;max-width:240px;box-sizing:border-box;";
    el.innerHTML = `
        <header class="wdm-hud-titlebar" data-drag-handle="1">
            ${portraitSrc ? `<img class="wdm-hud-portrait" src="${escapeAttr(portraitSrc)}" alt="" draggable="false"
                                 style="width:24px;height:24px;max-width:24px;max-height:24px;object-fit:cover;border-radius:50%;flex:0 0 auto;border:1px solid #6b5a3a;background:#0a0907;"/>` : ""}
            <div class="wdm-hud-title">${escapeText(name)}</div>
            <button type="button" class="wdm-hud-close" data-action="close" title="Close HUD">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </header>

        <div class="wdm-hud-body">

        <section class="wdm-hud-section">
            <div class="wdm-hud-section-label">Combat</div>
            <div class="wdm-hud-row">
                <button type="button" class="wdm-hud-btn ${inCombat ? "is-on" : ""}" data-action="toggle-combat" title="Toggle in combat">
                    <i class="fa-solid fa-swords"></i><span>${inCombat ? "Leave" : "Enter"}</span>
                </button>
                <button type="button" class="wdm-hud-btn ${isHidden ? "is-on" : ""}" data-action="toggle-hidden" title="Toggle visibility">
                    <i class="fa-solid ${isHidden ? "fa-eye-slash" : "fa-eye"}"></i><span>${isHidden ? "Hidden" : "Visible"}</span>
                </button>
                <button type="button" class="wdm-hud-btn ${isTargeted ? "is-on" : ""}" data-action="toggle-target" title="Target this token">
                    <i class="fa-solid fa-bullseye"></i><span>Target</span>
                </button>
            </div>
        </section>

        <details class="wdm-hud-section wdm-hud-section-collapsible" data-section="statuses" ${_statusesOpen ? "open" : ""}>
            <summary class="wdm-hud-section-label">
                Statuses
                <i class="fa-solid fa-chevron-right wdm-hud-chev wdm-hud-chev-end"></i>
            </summary>
            <div class="wdm-hud-status-grid">
                ${renderStatusGrid(token)}
            </div>
        </details>

        ${(hp.max > 0 || sta.max > 0) ? `
        <section class="wdm-hud-section">
            <div class="wdm-hud-section-label">Vitality</div>
            ${hp.max  > 0 ? renderVitalityBar("HP",  hp.cur,  hp.max)  : ""}
            ${sta.max > 0 ? renderVitalityBar("STA", sta.cur, sta.max) : ""}
        </section>
        ` : ""}

        <footer class="wdm-hud-foot">
            <button type="button" class="wdm-hud-btn" data-action="open-sheet" title="Open actor sheet">
                <i class="fa-solid fa-id-card"></i><span>Sheet</span>
            </button>
            <button type="button" class="wdm-hud-btn" data-action="configure-token" title="Configure token">
                <i class="fa-solid fa-gear"></i><span>Token</span>
            </button>
        </footer>

        </div>
    `;
    return el;
}

/* ─────────── positioning ─────────── */

function positionHUD(hud, token) {
    if (!hud) return;
    hud.style.position = "fixed";
    hud.style.zIndex = "100";

    // If the user dragged the HUD, honor that position across re-renders
    // until they close it. The window stays where they put it instead of
    // snapping back to the token.
    if (_hudPosition) {
        hud.style.left = `${_hudPosition.left}px`;
        hud.style.top  = `${_hudPosition.top}px`;
        return;
    }

    if (!token || !canvas?.stage) return;
    const bounds = token.bounds ?? new PIXI.Rectangle(token.x, token.y, token.w ?? 100, token.h ?? 100);
    const stage = canvas.stage;
    const topRight = stage.worldTransform.apply({ x: bounds.x + bounds.width, y: bounds.y });
    const padding = 12;
    hud.style.left = `${Math.round(topRight.x + padding)}px`;
    hud.style.top  = `${Math.round(topRight.y)}px`;
    // Flip to the left of the token if the panel would run off the right edge.
    const panelRect = hud.getBoundingClientRect();
    if (panelRect.right > window.innerWidth - 4) {
        const topLeft = stage.worldTransform.apply({ x: bounds.x, y: bounds.y });
        hud.style.left = `${Math.round(topLeft.x - panelRect.width - padding)}px`;
    }
}

/* ─────────── show / hide ─────────── */

function hideHUD() {
    if (_hudEl) {
        try { _hudEl.remove(); } catch (_) { /* detached */ }
    }
    _hudEl = null;
    _activeToken = null;
}

function showHUD(token) {
    hideHUD();
    if (!token || !token.actor && !token.document) return;
    _activeToken = token;
    _hudEl = buildHUD(token);
    document.body.appendChild(_hudEl);
    positionHUD(_hudEl, token);
    wireActions(_hudEl, token);
}

function refreshHUD() {
    if (!_activeToken) return;
    showHUD(_activeToken);
}

/* ─────────── status apply (shared with chrome/context-menu-actor) ─────────── */

/* Add a status. DoT/stackable statuses create a fresh AE instance (so a new
 * combat bleed piles on top of any wound-sourced bleed); non-stackable
 * statuses are a binary toggle on the actor's shared status Set. Matches the
 * Apply Status dialog so both entry points behave identically. */
async function applyStatus(actor, id, stack) {
    if (!actor || !id) return;
    try {
        if (stack) {
            const def = (CONFIG.statusEffects ?? []).find(s => s.id === id) ?? {};
            await actor.createEmbeddedDocuments("ActiveEffect", [{
                name:     def.name ? game.i18n.localize(def.name) : id,
                img:      def.img ?? "icons/svg/aura.svg",
                statuses: [id]
            }]);
        } else {
            const active = actor.statuses?.has?.(id) ?? false;
            await actor.toggleStatusEffect(id, { active: !active });
        }
    } catch (err) {
        console.warn(`${SYSTEM_ID} | apply status ${id} failed`, err);
        ui.notifications?.error(`Failed to apply status: ${id}`);
    }
}

/* Remove one non-wound instance of a stackable status. Wound-sourced
 * instances are flagged and left alone (they clear when the wound is
 * treated). Mirrors the Apply Status dialog. */
async function removeStatusStack(actor, id) {
    if (!actor || !id) return;
    const nonWound = (actor.effects?.contents ?? [])
        .filter(e => e.statuses?.has?.(id) && !e.flags?.[SYSTEM_ID]?.woundStatus);
    if (!nonWound.length) {
        ui.notifications?.info(`No removable ${id} — wound-sourced instances clear when the wound is treated.`);
        return;
    }
    try { await actor.deleteEmbeddedDocuments("ActiveEffect", [nonWound[nonWound.length - 1].id]); }
    catch (err) { console.warn(`${SYSTEM_ID} | remove status ${id} failed`, err); }
}

/* ─────────── action wiring ─────────── */

function wireActions(hud, token) {
    /* Action delegation (clicks). */
    hud.addEventListener("click", async (ev) => {
        const btn = ev.target.closest("[data-action]");
        if (!btn) return;
        ev.preventDefault();
        ev.stopPropagation();
        const action = btn.dataset.action;
        try {
            switch (action) {
                case "close":             hideHUD(); _hudPosition = null; return;
                case "toggle-combat":     await toggleCombatant(token); break;
                case "toggle-hidden":     await token.document.update({ hidden: !token.document.hidden }); break;
                case "toggle-target":     token.setTarget(!token.isTargeted, { releaseOthers: false }); break;
                case "open-sheet":        await token.actor?.sheet?.render(true); break;
                case "configure-token":   await token.document.sheet?.render(true); break;
                case "toggle-status": {
                    const statusId = btn.dataset.status;
                    if (!statusId) break;
                    const stack = btn.dataset.stackable === "true";
                    await applyStatus(token.actor, statusId, stack);
                    break;
                }
            }
            if (action === "toggle-target") refreshHUD();
        } catch (err) {
            console.warn(`${SYSTEM_ID} | token HUD action "${action}" failed`, err);
        }
    });

    /* Right-click a stackable status to remove one (non-wound) instance. */
    hud.addEventListener("contextmenu", async (ev) => {
        const btn = ev.target.closest('.wdm-hud-status[data-stackable="true"]');
        if (!btn) return;
        ev.preventDefault();
        ev.stopPropagation();
        const statusId = btn.dataset.status;
        if (statusId) await removeStatusStack(token.actor, statusId);
    });

    /* Persist the collapsed/open state of any <details> section across the
     * HUD's frequent re-renders. The native <details> toggle fires after
     * the attribute changes, so we capture the new state on `toggle`. */
    hud.addEventListener("toggle", (ev) => {
        const det = ev.target;
        if (!(det instanceof HTMLDetailsElement)) return;
        if (det.dataset.section === "statuses") _statusesOpen = det.open;
    }, true);

    /* Window-style drag on the titlebar. Mousedown captures the offset
     * from the click point to the HUD's top-left corner; mousemove
     * updates `_hudPosition` (which positionHUD honors); mouseup releases.
     * Detaches listeners on cancel to avoid leaks across re-renders. */
    const handle = hud.querySelector('[data-drag-handle]');
    if (handle) {
        const onDown = (ev) => {
            if (ev.button !== 0) return; // left only
            const target = ev.target;
            // Don't start a drag if the user clicked the close button.
            if (target.closest('[data-action="close"]')) return;
            ev.preventDefault();
            const rect = hud.getBoundingClientRect();
            _dragState = {
                offsetX: ev.clientX - rect.left,
                offsetY: ev.clientY - rect.top
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
        };
        const onMove = (ev) => {
            if (!_dragState) return;
            _hudPosition = {
                left: Math.max(0, Math.min(window.innerWidth - 50, ev.clientX - _dragState.offsetX)),
                top:  Math.max(0, Math.min(window.innerHeight - 50, ev.clientY - _dragState.offsetY))
            };
            hud.style.left = `${_hudPosition.left}px`;
            hud.style.top  = `${_hudPosition.top}px`;
        };
        const onUp = () => {
            _dragState = null;
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
        handle.addEventListener("mousedown", onDown);
    }
}

async function toggleCombatant(token) {
    const inCombat = !!game.combat?.combatants?.some?.(c => c.tokenId === token.id);
    if (inCombat) {
        const c = game.combat.combatants.find(c => c.tokenId === token.id);
        if (c) await c.delete();
    } else {
        if (!game.combat) {
            const cls = getDocumentClass("Combat");
            await cls.create({ scene: canvas.scene.id });
        }
        await game.combat.createEmbeddedDocuments("Combatant", [{
            tokenId: token.id,
            sceneId: canvas.scene.id,
            actorId: token.actor?.id ?? null
        }]);
    }
}

/* ─────────── lifecycle hooks ─────────── */

export function registerWitcherTokenHUD() {
    if (_hooksWired) return;
    _hooksWired = true;

    /* Right-click on a token is the only trigger — Foundry's default Token
     * HUD opens on right-click, so we hijack `renderTokenHUD`: close the
     * default and show our custom panel for the same token. Every right-
     * click re-fires this, so re-opening after the user dismissed the panel
     * works without needing to deselect+reselect the token. */
    Hooks.on("renderTokenHUD", (hud) => {
        const token = hud?.object ?? null;
        try { hud.close({ force: true }); } catch (_) { /* not yet rendered */ }
        if (token) showHUD(token);
    });

    // Deselecting the token also hides the HUD (matches Foundry's default).
    Hooks.on("controlToken", (token, controlled) => {
        if (!controlled && _activeToken && _activeToken.id === token.id) hideHUD();
    });

    // Keep position in sync with canvas pan / zoom.
    Hooks.on("canvasPan", () => {
        if (_hudEl && _activeToken) positionHUD(_hudEl, _activeToken);
    });

    // Document updates → re-render the HUD content so HP / statuses /
    // visibility track the current document state.
    Hooks.on("updateToken", (doc) => {
        if (_activeToken && _activeToken.id === doc.id) refreshHUD();
    });
    Hooks.on("updateActor", (actor) => {
        if (_activeToken?.actor?.id === actor.id) refreshHUD();
    });
    Hooks.on("createActiveEffect", (eff) => {
        if (_activeToken?.actor?.id === eff?.parent?.id) refreshHUD();
    });
    Hooks.on("deleteActiveEffect", (eff) => {
        if (_activeToken?.actor?.id === eff?.parent?.id) refreshHUD();
    });
    Hooks.on("updateActiveEffect", (eff) => {
        if (_activeToken?.actor?.id === eff?.parent?.id) refreshHUD();
    });
    Hooks.on("createCombatant", refreshHUD);
    Hooks.on("deleteCombatant", refreshHUD);

    // Scene change / token delete clears any lingering HUD.
    Hooks.on("canvasReady", hideHUD);
    Hooks.on("deleteToken",  (doc) => { if (_activeToken?.id === doc.id) hideHUD(); });

    /* Click anywhere on the scene that isn't the HUD or a Foundry UI panel
     * closes the HUD. Capture-phase so canvas pointer handling doesn't eat
     * the event first. The right-click that opens the HUD also fires this,
     * but _hudEl is null at that moment so the early-return short-circuits;
     * by the time the user clicks again, _hudEl is set and dismissal works. */
    window.addEventListener("pointerdown", (ev) => {
        if (!_hudEl) return;
        if (_hudEl.contains(ev.target)) return;
        const inUI = !!ev.target.closest?.(
            "#sidebar, #ui-left, #ui-top, #ui-bottom, #ui-right, " +
            ".application, .window-app, dialog, [role=\"dialog\"]"
        );
        if (inUI) return;
        hideHUD();
        _hudPosition = null;
    }, true);
}
