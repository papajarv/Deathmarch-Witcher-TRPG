/**
 * reload.js — UI helper for chambering a weapon. The reloadMixin's
 * reload(ammoId) does the mechanical work (move rounds from ammo → chamber);
 * this layer just decides WHICH ammo to feed it: silent when there's a single
 * eligible round, a picker dialog when the wielder carries more than one type
 * of matching ammo in their equipped containers.
 */

/** Reload a chamber weapon, prompting for a choice when more than one ammo
 *  type is eligible. Returns the reload() result, or null if cancelled. */
export async function reloadWithPrompt(item) {
    if (!item?.hasChamber) return null;
    const eligible = item.getEligibleAmmo?.() ?? [];
    // 0 → let the mixin emit its "no ammo" warning; 1 → load it straight.
    if (eligible.length <= 1) return item.reload(eligible[0]?.item?.id ?? null);
    const chosenId = await promptAmmoChoice(item, eligible);
    if (!chosenId) return null;
    return item.reload(chosenId);
}

async function promptAmmoChoice(item, eligible) {
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2) return eligible[0].item.id;   // no dialog → first eligible

    const rows = eligible.map((e) => `
        <button type="button" class="wdm-ammo-pick" data-ammo-id="${esc(e.item.id)}">
          <img src="${esc(e.item.img)}" alt="" />
          <span class="wdm-ammo-pick-text">
            <span class="wdm-ammo-pick-name">${esc(e.item.name)}</span>
            <span class="wdm-ammo-pick-meta">×${e.qty} · ${esc(e.container.name)}</span>
          </span>
        </button>`).join("");

    let chosen = null;
    await DialogV2.wait({
        window: { title: `Reload — ${item.name}`, icon: "fa-solid fa-arrows-rotate" },
        content: `<div class="wdm-ammo-pick-grid">${rows}</div>`,
        buttons: [{ action: "cancel", label: "Cancel", default: true }],
        rejectClose: false,
        classes: ["wdm-ammo-pick-dialog"],
        render: (_event, dlg) => {
            const root = dlg?.element ?? dlg;
            root?.querySelectorAll?.(".wdm-ammo-pick").forEach((btn) => {
                btn.addEventListener("click", () => {
                    chosen = btn.dataset.ammoId;
                    dlg?.close?.();
                });
            });
        }
    }).catch(() => null);
    return chosen;
}

function esc(s) {
    return String(s ?? "")
        .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
