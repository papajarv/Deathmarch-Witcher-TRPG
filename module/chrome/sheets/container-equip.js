/**
 * Container slot-rows editor.
 *
 * Injects a Slot Rows section directly after the sheet's `.storedWeight`
 * block so it lives in the same visual band as the kg fields.  Once a
 * container has any rows configured the kg fields fall back to an
 * optional "Weight Limit" input (no slot config = legacy weight-only).
 *
 * Persistence: a single structured flag (see `lib/container.js` for the
 * shape).  Capacity enforcement happens in `lib/container.js` and is
 * called from every drop site.
 */

import {
  SLOT_TYPES, SUBTYPES_BY_TYPE, slotTypeLabel, subtypeLabel,
  CONCEAL_CODES, CONCEAL_LABELS, getContainerCfg,
} from "../lib/container.js";

const MODULE_ID = "witcher-ttrpg-death-march";
const FLAG_KEY  = "containerCfg";

function injectStyles() {
  if (document.getElementById(`${MODULE_ID}-container-cfg-styles`)) return;
  const style = document.createElement("style");
  style.id = `${MODULE_ID}-container-cfg-styles`;
  style.textContent = `
    .wou-slotcfg {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin: 4px 0 6px;
    }
    .wou-slotcfg .wou-slotcfg-head {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      font-size: 0.9em;
    }
    .wou-slotcfg .wou-slotcfg-head label {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      white-space: nowrap;
    }
    .wou-slotcfg .wou-slotcfg-head input[type="number"] {
      width: 64px;
      text-align: center;
    }
    .wou-slotcfg .wou-slotcfg-title {
      font-weight: 600;
      margin-right: auto;
    }
    .wou-slotcfg .wou-slotcfg-rows {
      display: flex;
      flex-direction: column;
      gap: 3px;
      padding-left: 2px;
    }
    .wou-slotcfg .wou-slotcfg-row {
      display: grid;
      grid-template-columns: 1.1fr 1.2fr 52px 0.9fr 24px;
      align-items: center;
      gap: 4px;
      font-size: 0.9em;
    }
    .wou-slotcfg .wou-slotcfg-row.no-conceal {
      grid-template-columns: 1.1fr 1.2fr 52px 0.9fr 24px;
    }
    .wou-slotcfg select { min-width: 0; width: 100%; }
    .wou-slotcfg input[type="number"].wou-slotcfg-count {
      width: 52px;
      text-align: center;
    }
    .wou-slotcfg .wou-slotcfg-remove {
      background: none;
      border: 1px solid rgba(0, 0, 0, 0.2);
      border-radius: 3px;
      padding: 0;
      width: 22px;
      height: 22px;
      cursor: pointer;
      line-height: 1;
      font-size: 1.1em;
    }
    .wou-slotcfg .wou-slotcfg-add {
      align-self: flex-start;
      padding: 2px 8px;
      cursor: pointer;
      font-size: 0.85em;
    }
    .wou-slotcfg .wou-slotcfg-row .wou-slotcfg-conceal.is-na { visibility: hidden; }
    .wou-slotcfg .wou-slotcfg-empty {
      font-style: italic;
      opacity: 0.65;
      font-size: 0.9em;
    }
  `;
  document.head.appendChild(style);
}

function buildTypeSelect(currentType) {
  const opts = SLOT_TYPES.map(t =>
    `<option value="${t}" ${t === currentType ? "selected" : ""}>${slotTypeLabel(t)}</option>`
  );
  return `<select class="wou-slotcfg-type">${opts.join("")}</select>`;
}

function buildSubtypeSelect(type, currentSubtype) {
  const enumObj = SUBTYPES_BY_TYPE[type];
  if (!enumObj) {
    // No subtypes for this type → disabled select with "—".
    return `<select class="wou-slotcfg-subtype" disabled><option value="">—</option></select>`;
  }
  const opts = [`<option value="" ${!currentSubtype ? "selected" : ""}>Any subtype</option>`];
  for (const [k, label] of Object.entries(enumObj)) {
    opts.push(`<option value="${k}" ${k === currentSubtype ? "selected" : ""}>${label}</option>`);
  }
  return `<select class="wou-slotcfg-subtype">${opts.join("")}</select>`;
}

function buildConcealSelect(current, applicable) {
  const opts = [`<option value="" ${!current ? "selected" : ""}>Any size</option>`];
  for (const c of CONCEAL_CODES) {
    opts.push(`<option value="${c}" ${c === current ? "selected" : ""}>${c} · ${CONCEAL_LABELS[c]}</option>`);
  }
  return `<select class="wou-slotcfg-conceal ${applicable ? "" : "is-na"}" title="Max size this slot accepts (weapon-only)">${opts.join("")}</select>`;
}

function rowHTML(slot) {
  const isWeapon = slot.type === "weapon";
  return `
    <div class="wou-slotcfg-row">
      ${buildTypeSelect(slot.type)}
      ${buildSubtypeSelect(slot.type, slot.subtype)}
      <input type="number" min="1" step="1" class="wou-slotcfg-count" value="${slot.count}" title="Slot count" />
      ${buildConcealSelect(slot.maxConceal || "", isWeapon)}
      <button type="button" class="wou-slotcfg-remove" title="Remove this slot row">×</button>
    </div>
  `;
}

Hooks.on("renderWitcherContainerSheet", (app, _html, _ctx, _opts) => {
  const root = app?.element;
  const item = app?.item;
  if (!root || !item || item.type !== "container") return;

  injectStyles();
  const form = root.querySelector("form") || root;
  if (form.querySelector(".wou-slotcfg")) return;

  const storedWeightEl = form.querySelector(".storedWeight");
  if (!storedWeightEl) return;

  /* The original `.storedWeight` block (stored + system.carry kg fields)
   * is replaced by our Slot Rows + Weight Limit.  Hide it outright —
   * weight is now part of our config blob, not the system's. */
  storedWeightEl.style.display = "none";

  const cfg = getContainerCfg(item);

  const block = document.createElement("div");
  block.className = "wou-slotcfg";
  block.innerHTML = `
    <div class="wou-slotcfg-head">
      <span class="wou-slotcfg-title">Slot Rows</span>
      <label title="When ON, accepts items with quantity > 1 (each unit consumes one slot — quivers / bandoliers). When OFF, only single units are accepted.">
        <input type="checkbox" class="wou-slotcfg-stack" ${cfg.stack ? "checked" : ""} />
        Items stack
      </label>
      <label title="Optional cap on the weight of any SINGLE item. 0 = no per-item limit.">
        Weight per item
        <input type="number" min="0" step="0.1" class="wou-slotcfg-wlimit-item" value="${cfg.weightLimitPerItem}" />
      </label>
    </div>
    <div class="wou-slotcfg-rows">
      ${cfg.slots.length
        ? cfg.slots.map(rowHTML).join("")
        : `<div class="wou-slotcfg-empty">No slot rows. This container accepts anything (subject to the kg cap below).</div>`
      }
    </div>
    <button type="button" class="wou-slotcfg-add">+ Add slot row</button>
  `;
  storedWeightEl.after(block);

  const rowsWrap = block.querySelector(".wou-slotcfg-rows");
  const addBtn   = block.querySelector(".wou-slotcfg-add");
  const stackCbx     = block.querySelector(".wou-slotcfg-stack");
  const wlimitItemIn = block.querySelector(".wou-slotcfg-wlimit-item");

  const persist = async () => {
    const stack              = !!stackCbx.checked;
    const weightLimitPerItem = Math.max(0, Number(wlimitItemIn.value) || 0);
    const slots = [];
    rowsWrap.querySelectorAll(".wou-slotcfg-row").forEach(row => {
      const type    = String(row.querySelector(".wou-slotcfg-type")?.value || "");
      const subtype = String(row.querySelector(".wou-slotcfg-subtype")?.value || "");
      const cRaw    = Number(row.querySelector(".wou-slotcfg-count")?.value);
      const count   = Number.isFinite(cRaw) && cRaw >= 1 ? Math.floor(cRaw) : 1;
      const mc      = String(row.querySelector(".wou-slotcfg-conceal")?.value || "");
      const maxConceal = (type === "weapon" && CONCEAL_CODES.includes(mc)) ? mc : "";
      if (type) slots.push({ type, subtype, count, maxConceal });
    });
    try { await item.setFlag(MODULE_ID, FLAG_KEY, { slots, stack, weightLimitPerItem }); }
    catch (err) { console.warn(`${MODULE_ID} | could not persist containerCfg`, err); }
  };

  const reflectEmptyState = () => {
    const empty = !rowsWrap.querySelector(".wou-slotcfg-row");
    if (empty && !rowsWrap.querySelector(".wou-slotcfg-empty")) {
      rowsWrap.innerHTML = `<div class="wou-slotcfg-empty">No slot rows. This container accepts anything (subject to the kg cap below).</div>`;
    } else if (!empty) {
      rowsWrap.querySelector(".wou-slotcfg-empty")?.remove();
    }
  };

  stackCbx.addEventListener("change", persist);
  const clampedNumber = (input) => {
    const raw = Number(input.value);
    input.value = Number.isFinite(raw) && raw >= 0 ? raw : 0;
  };
  wlimitIn.addEventListener("change", async () => { clampedNumber(wlimitIn); await persist(); });
  wlimitItemIn.addEventListener("change", async () => { clampedNumber(wlimitItemIn); await persist(); });

  addBtn.addEventListener("click", async () => {
    rowsWrap.querySelector(".wou-slotcfg-empty")?.remove();
    rowsWrap.insertAdjacentHTML("beforeend", rowHTML({
      type: "weapon", subtype: "swordsmanship", count: 1, maxConceal: "",
    }));
    await persist();
  });

  rowsWrap.addEventListener("change", async (ev) => {
    /* Type changed → rebuild that row's subtype select (different enum)
     * and grey the conceal select unless the new type is "weapon". */
    if (ev.target.matches(".wou-slotcfg-type")) {
      const row = ev.target.closest(".wou-slotcfg-row");
      if (row) {
        const newType = String(ev.target.value);
        const subSel = row.querySelector(".wou-slotcfg-subtype");
        subSel.outerHTML = buildSubtypeSelect(newType, "");
        const conSel = row.querySelector(".wou-slotcfg-conceal");
        conSel.classList.toggle("is-na", newType !== "weapon");
      }
    }
    if (ev.target.matches(".wou-slotcfg-count")) {
      const raw = Number(ev.target.value);
      ev.target.value = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
    }
    await persist();
  });
  rowsWrap.addEventListener("click", async (ev) => {
    const btn = ev.target.closest(".wou-slotcfg-remove");
    if (!btn) return;
    btn.closest(".wou-slotcfg-row")?.remove();
    reflectEmptyState();
    await persist();
  });
});
