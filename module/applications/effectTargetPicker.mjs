/**
 * effectTargetPicker — a browse-and-click window over EVERY AE-targetable
 * parameter, grouped (Attributes / Skills / Pools / Derived / Combat passives),
 * with a category dropdown + live search. Replaces "know the path and type it".
 *
 * `pickEffectTarget(current)` opens the dialog and resolves the chosen data
 * path string, or null if cancelled.
 */

import { effectTargetGroups } from "../setup/config.mjs";

const esc = (s) => Handlebars.escapeExpression(String(s ?? ""));

export async function pickEffectTarget(current = "") {
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2) return null;

    const groups = effectTargetGroups();
    const list = groups.map((g, i) => `
        <section class="wdm-tp-group" data-group="${i}">
          <header class="wdm-tp-group-label">${esc(g.label)}</header>
          ${g.options.map(o => `
            <button type="button" class="wdm-tp-opt${o.key === current ? " is-current" : ""}"
                    data-key="${esc(o.key)}"
                    data-search="${esc((g.label + " " + o.label + " " + o.key).toLowerCase())}">
              <span class="wdm-tp-opt-label">${esc(o.label)}</span>
              <code class="wdm-tp-opt-key">${esc(o.key)}</code>
            </button>`).join("")}
        </section>`).join("");

    const content = `<div class="wdm-target-picker">
        <div class="wdm-tp-bar">
          <select class="wdm-tp-cat">
            <option value="">All categories</option>
            ${groups.map((g, i) => `<option value="${i}">${esc(g.label)}</option>`).join("")}
          </select>
          <input type="search" class="wdm-tp-search" placeholder="Search parameters…" autofocus />
        </div>
        <div class="wdm-tp-list">${list}</div>
      </div>`;

    let picked = null;
    await DialogV2.wait({
        window: { title: game.i18n.localize("WITCHER.Effect.BrowseTargets"), resizable: true },
        position: { width: 500, height: 600 },
        content,
        buttons: [{ action: "cancel", label: "Cancel", default: true }],
        rejectClose: false,
        classes: ["witcher-ttrpg-death-march", "wdm-target-picker-dialog"],
        render: (_event, dlg) => {
            const root = dlg?.element ?? dlg;
            if (!root) return;
            const cat    = root.querySelector(".wdm-tp-cat");
            const search = root.querySelector(".wdm-tp-search");
            const sections = [...root.querySelectorAll(".wdm-tp-group")];

            const apply = () => {
                const q = (search?.value || "").trim().toLowerCase();
                const c = cat?.value ?? "";
                for (const sec of sections) {
                    const inCat = (c === "" || c === sec.dataset.group);
                    let any = false;
                    for (const b of sec.querySelectorAll(".wdm-tp-opt")) {
                        const show = inCat && (!q || b.dataset.search.includes(q));
                        b.style.display = show ? "" : "none";
                        if (show) any = true;
                    }
                    sec.style.display = any ? "" : "none";
                }
            };
            cat?.addEventListener("change", apply);
            search?.addEventListener("input", apply);
            for (const b of root.querySelectorAll(".wdm-tp-opt")) {
                b.addEventListener("click", () => { picked = b.dataset.key; dlg.close(); });
            }
        }
    }).catch(() => null);
    return picked;
}
