/**
 * Adds an "Is shield" toggle to weapon item sheets. When checked, two
 * numeric inputs — CV (Cover Value) and EV (Encumbrance Value) — appear
 * inline next to the toggle.
 *
 * Storage lives on item flags (`witcher-ttrpg-death-march.isShield/cv/ev`)
 * because injected inputs aren't picked up by the AppV2 form auto-submit
 * pass — see valuable-map.js for the same pattern.
 */

const MODULE_ID = "witcher-ttrpg-death-march";
const FLAG_IS_SHIELD = "isShield";
const FLAG_CV        = "cv";
const FLAG_EV        = "ev";

/** Read a numeric flag clamped to >= 0. */
function readNum(item, key) {
  const v = Number(item?.flags?.[MODULE_ID]?.[key]);
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

/** True if the weapon is flagged as a shield. */
export function isShieldWeapon(item) {
  return item?.type === "weapon" && !!item?.flags?.[MODULE_ID]?.[FLAG_IS_SHIELD];
}

export function getShieldCV(item) { return readNum(item, FLAG_CV); }
export function getShieldEV(item) { return readNum(item, FLAG_EV); }

function injectStyles() {
  if (document.getElementById(`${MODULE_ID}-weapon-shield-styles`)) return;
  const style = document.createElement("style");
  style.id = `${MODULE_ID}-weapon-shield-styles`;
  style.textContent = `
    .wou-shield-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px 14px;
      padding: 4px 8px;
      margin: 2px 0;
      border-top: 1px solid rgba(0, 0, 0, 0.12);
      border-bottom: 1px solid rgba(0, 0, 0, 0.12);
    }
    .wou-shield-tickbox {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      white-space: nowrap;
    }
    .wou-shield-field {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      white-space: nowrap;
      font-size: 0.9em;
    }
    .wou-shield-field input[type="number"] {
      width: 48px;
      text-align: center;
    }
    .wou-shield-fields.wou-hidden {
      display: none;
    }
    .wou-shield-fields {
      display: inline-flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px 12px;
    }
  `;
  document.head.appendChild(style);
}

Hooks.on("renderWitcherWeaponSheet", (app, _html, _ctx, _opts) => {
  const root = app?.element;
  const item = app?.item;
  if (!root || !item || item.type !== "weapon") return;

  injectStyles();

  // The system's `.item-options` row is a fixed-height (54px), two-column
  // flex block — appending into it overflows or clips on narrow windows.
  // Instead, drop our own wrap-friendly bar immediately after it.
  const options = root.querySelector(".item-options");
  if (!options) return;

  // Idempotent: if our bar already exists in this rendered DOM, skip.
  if (root.querySelector(".wou-shield-bar")) return;

  const checked = isShieldWeapon(item) ? "checked" : "";
  const cv      = getShieldCV(item);
  const ev      = getShieldEV(item);
  const i18n    = (k, fb) => game.i18n?.localize(k) || fb;

  const bar = document.createElement("div");
  bar.className = "wou-shield-bar";
  bar.innerHTML = `
    <label class="wou-shield-tickbox">
      <input type="checkbox" class="wou-is-shield-input" ${checked} />
      ${i18n("WOU.Shield.IsShield", "Is shield")}
    </label>
    <span class="wou-shield-fields${checked ? "" : " wou-hidden"}">
      <span class="wou-shield-field">
        <label>${i18n("WOU.Shield.CV", "CV")}</label>
        <input type="number" min="0" step="1" class="wou-shield-cv" value="${cv}" />
      </span>
      <span class="wou-shield-field">
        <label>${i18n("WOU.Shield.EV", "EV")}</label>
        <input type="number" min="0" step="1" class="wou-shield-ev" value="${ev}" />
      </span>
    </span>
  `;
  options.after(bar);

  const cbx    = bar.querySelector(".wou-is-shield-input");
  const fields = bar.querySelector(".wou-shield-fields");
  const cvIn   = bar.querySelector(".wou-shield-cv");
  const evIn   = bar.querySelector(".wou-shield-ev");

  cbx.addEventListener("change", async (e) => {
    const on = !!e.target.checked;
    fields.classList.toggle("wou-hidden", !on);
    try { await item.setFlag(MODULE_ID, FLAG_IS_SHIELD, on); }
    catch (err) { console.warn(`${MODULE_ID} | could not persist isShield`, err); }
  });

  const writeNum = (key) => async (e) => {
    const raw = Number(e.target.value);
    const val = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
    e.target.value = val;
    try { await item.setFlag(MODULE_ID, key, val); }
    catch (err) { console.warn(`${MODULE_ID} | could not persist ${key}`, err); }
  };

  cvIn.addEventListener("change", writeNum(FLAG_CV));
  evIn.addEventListener("change", writeNum(FLAG_EV));
});
