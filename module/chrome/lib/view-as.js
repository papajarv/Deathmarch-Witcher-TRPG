/**
 * Render + wire helper for the GM "View as" picker.
 *
 * The picker is a small pill with a native <select> that lists every
 * character actor.  Picking one calls setActorOverride() (lib/actor.js);
 * picking the empty / "Default" row clears it.  Setting the override
 * fires VIEWER_OVERRIDE_HOOK so any open chrome can re-render.
 *
 * Each tab (inventory / character / journal / bestiary) calls:
 *   - renderViewAsPicker()  → HTML string for the header
 *   - wireViewAsPicker(panelEl, onRender)  → idempotent change-listener wiring
 *
 * The picker is GM-only.  Callers should still gate render on
 * `game.user?.isGM` to avoid surfacing the control to players.
 */

import { setActorOverride, getActorOverride } from "./actor.js";

function escapeText(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
function escapeAttr(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * @param {object} [opts]
 * @param {string} [opts.defaultLabel="Default"] Label for the empty row.
 *                  Bestiary uses "Aggregated" since its empty-view shows the
 *                  union across PCs.  Other tabs show the GM's own assigned
 *                  character (or nothing) and want the more neutral "Default".
 * @returns {string} HTML
 */
export function renderViewAsPicker({ defaultLabel = "Default" } = {}) {
  const pcs = (game.actors?.contents ?? [])
    .filter(a => a.type === "character")
    .sort((a, b) => a.name.localeCompare(b.name));
  const current = getActorOverride() ?? "";
  const engaged = !!current;
  const opts = pcs.map(pc =>
    `<option value="${escapeAttr(pc.id)}"${current === pc.id ? " selected" : ""}>${escapeText(pc.name)}</option>`
  ).join("");
  /* When the override is engaged, show a one-click clear-X next to the
   * <select> so the GM can pop back to the default view without having to
   * open the dropdown and scroll to "Default". */
  const clearBtn = engaged
    ? `<button type="button" class="wou-viewas-clear" data-action="wou-view-as-clear"
                aria-label="Clear view-as override"
                title="Clear override — return to ${escapeAttr(defaultLabel)}">
         <i class="fa-solid fa-xmark"></i>
       </button>`
    : "";
  return `
    <label class="wou-viewas${engaged ? " is-engaged" : ""}" title="GM only — render this tab as the selected player character.">
      <i class="fa-solid fa-mask"></i>
      <span class="wou-viewas-lbl">View as</span>
      <select class="wou-viewas-select" data-action="wou-view-as">
        <option value=""${current === "" ? " selected" : ""}>— ${escapeText(defaultLabel)} —</option>
        ${opts}
      </select>
      ${clearBtn}
    </label>
  `;
}

/**
 * Attach a one-time change-event delegate to `panelEl` so the picker writes
 * to the shared override and triggers a re-render of the calling tab.  Safe
 * to call from a chrome injector that runs once per session.
 *
 * @param {HTMLElement} panelEl  The persistent panel root.
 * @param {() => void} onChange  Called after the override is updated.
 */
export function wireViewAsPicker(panelEl, onChange) {
  if (!panelEl || panelEl.__wouViewAsWired) return;
  panelEl.__wouViewAsWired = true;
  const fire = () => {
    try { onChange?.(); } catch (err) {
      console.error("[witcher-ttrpg-death-march] view-as onChange failed", err);
    }
  };
  panelEl.addEventListener("change", (ev) => {
    const target = ev.target;
    if (!target?.matches?.('select[data-action="wou-view-as"]')) return;
    if (!game.user?.isGM) return;
    setActorOverride(target.value || null);
    fire();
  });
  /* Clear-X click — also delegated so the button survives every re-render
   * without needing to rebind.  Stopping propagation prevents the click
   * from leaking into a parent <label>'s default activate-the-control
   * behavior, which would re-open the <select>. */
  panelEl.addEventListener("click", (ev) => {
    const btn = ev.target?.closest?.('[data-action="wou-view-as-clear"]');
    if (!btn) return;
    if (!game.user?.isGM) return;
    ev.preventDefault();
    ev.stopPropagation();
    setActorOverride(null);
    fire();
  });
}
