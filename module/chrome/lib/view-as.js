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

import { setActorOverride, getActorOverride, setPanelOverride, getPanelOverride } from "./actor.js";
import { t, tFormat } from "../lib/i18n.js";

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
export function renderViewAsPicker({ defaultLabel = t("WITCHER.Chrome.Lib.ViewAs.Default", "Default") } = {}) {
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
                aria-label="${t("WITCHER.Chrome.Lib.ViewAs.Text.ClearViewAsOverride", "Clear view-as override")}"
                title="Clear override — return to ${escapeAttr(defaultLabel)}">
         <i class="fa-solid fa-xmark"></i>
       </button>`
    : "";
  return `
    <label class="wou-viewas${engaged ? " is-engaged" : ""}" title="${t("WITCHER.Chrome.Lib.ViewAs.Text.GMOnlyRenderThisTabAsTheSelectedPlayerCh", "GM only — render this tab as the selected player character.")}">
      <i class="fa-solid fa-mask"></i>
      <span class="wou-viewas-lbl">${t("WITCHER.Chrome.Lib.ViewAs.Text.ViewAs", "Lock as")}</span>
      <select class="wou-viewas-select" data-action="wou-view-as">
        <option value=""${current === "" ? " selected" : ""}>— ${escapeText(defaultLabel)} —</option>
        ${opts}
      </select>
      ${clearBtn}
    </label>
  `;
}

/**
 * Repopulate a live View-As <select> from the CURRENT character roster,
 * preserving its selection. Called the moment the dropdown is opened so a
 * character created since the last render is already in the list — no reload,
 * no panel re-render required.
 */
export function refreshViewAsOptions(sel) {
  if (!sel) return;
  const cur = sel.value;
  const defaultOpt = sel.querySelector('option[value=""]');
  const defaultText = defaultOpt ? defaultOpt.textContent : "— Default —";
  const pcs = (game.actors?.contents ?? [])
    .filter(a => a.type === "character")
    .sort((a, b) => a.name.localeCompare(b.name));
  sel.innerHTML = `<option value="">${escapeText(defaultText)}</option>` +
    pcs.map(pc => `<option value="${escapeAttr(pc.id)}">${escapeText(pc.name)}</option>`).join("");
  // Restore the prior selection if that character still exists.
  if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
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

  /* Rebuild the dropdown from the CURRENT roster the moment it's opened, so a
   * character created since the last render is already in the list — no reload,
   * no panel re-render needed. `pointerdown` fires before the native popup, so
   * the list is fresh by the time it appears. This is the reliable fix: it
   * doesn't depend on any panel choosing to re-render on createActor. */
  panelEl.addEventListener("pointerdown", (ev) => {
    const sel = ev.target?.closest?.('select[data-action="wou-view-as"]');
    if (!sel || !game.user?.isGM) return;
    refreshViewAsOptions(sel);
  });
}

/* ── Per-panel "View as" ─────────────────────────────────────────────────────
 * The softer sibling of the global "Lock as" picker: it drives setPanelOverride
 * (this panel only), not the global lock. Panels that render it should reset it
 * on close (setPanelOverride(key, null)) so it stays transient. */
export function renderViewPanelAsPicker(panelKey, { defaultLabel = t("WITCHER.Chrome.Lib.ViewAs.Default", "Default") } = {}) {
  const pcs = (game.actors?.contents ?? [])
    .filter(a => a.type === "character")
    .sort((a, b) => a.name.localeCompare(b.name));
  const current = getPanelOverride(panelKey) ?? "";
  const engaged = !!current;
  const opts = pcs.map(pc =>
    `<option value="${escapeAttr(pc.id)}"${current === pc.id ? " selected" : ""}>${escapeText(pc.name)}</option>`
  ).join("");
  const clearBtn = engaged
    ? `<button type="button" class="wou-viewas-clear" data-action="wou-view-panel-as-clear"
                aria-label="${t("WITCHER.Chrome.Lib.ViewAs.Text.ClearViewPanelAs", "Show default again")}"
                title="${t("WITCHER.Chrome.Lib.ViewAs.Text.ClearViewPanelAs", "Show default again")}"><i class="fa-solid fa-xmark"></i></button>`
    : "";
  return `
    <label class="wou-viewas wou-viewpanelas${engaged ? " is-engaged" : ""}" title="${t("WITCHER.Chrome.Lib.ViewAs.Text.ViewPanelAsTip", "GM only — show THIS panel as the selected character (this panel only; resets when it closes).")}">
      <i class="fa-solid fa-eye"></i>
      <span class="wou-viewas-lbl">${t("WITCHER.Chrome.Lib.ViewAs.Text.ViewPanelAs", "View as")}</span>
      <select class="wou-viewas-select" data-action="wou-view-panel-as" data-panel="${escapeAttr(panelKey)}">
        <option value=""${current === "" ? " selected" : ""}>— ${escapeText(defaultLabel)} —</option>
        ${opts}
      </select>
      ${clearBtn}
    </label>
  `;
}

/** Idempotent per-panel-picker wiring: change → setPanelOverride, clear-X, and
 *  rebuild-on-open (reuses refreshViewAsOptions — same option shape). */
export function wireViewPanelAsPicker(panelEl, panelKey, onChange) {
  if (!panelEl || panelEl.__wouViewPanelAsWired) return;
  panelEl.__wouViewPanelAsWired = true;
  const fire = () => {
    try { onChange?.(); } catch (err) {
      console.error("[witcher-ttrpg-death-march] view-panel-as onChange failed", err);
    }
  };
  panelEl.addEventListener("change", (ev) => {
    const target = ev.target;
    if (!target?.matches?.('select[data-action="wou-view-panel-as"]')) return;
    if (!game.user?.isGM) return;
    setPanelOverride(target.dataset.panel || panelKey, target.value || null);
    fire();
  });
  panelEl.addEventListener("click", (ev) => {
    const btn = ev.target?.closest?.('[data-action="wou-view-panel-as-clear"]');
    if (!btn || !game.user?.isGM) return;
    ev.preventDefault();
    ev.stopPropagation();
    setPanelOverride(panelKey, null);
    fire();
  });
  panelEl.addEventListener("pointerdown", (ev) => {
    const sel = ev.target?.closest?.('select[data-action="wou-view-panel-as"]');
    if (!sel || !game.user?.isGM) return;
    refreshViewAsOptions(sel);
  });
}
