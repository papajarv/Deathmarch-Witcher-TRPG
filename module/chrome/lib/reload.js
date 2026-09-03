import { t, tFormat } from "./i18n.js";
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

    /* Magazine model: the reload button = COCK. When the magazine already holds
     * rounds, cocking needs NO ammo choice (it draws the fed top round), so
     * short-circuit straight to reload() regardless of how many ammo types the
     * wielder carries. Only an EMPTY magazine falls through to the picker
     * (reload auto-feeds one on the completing cock). */
    if (item.usesMagazine && (item.getChamberRounds?.()?.length ?? 0) > 0) {
        return item.reload(null);
    }

    const eligible = item.getEligibleAmmo?.() ?? [];
    // 0 → let the mixin emit its "no ammo" warning; 1 → load it straight.
    if (eligible.length <= 1) return item.reload(eligible[0]?.item?.id ?? null);

    /* Multi-action reload: the earlier actions only BANK progress — no round
     * chambers and the ammo choice doesn't take effect until the FINAL action.
     * So skip the picker on those and just advance the reload; prompt for the
     * ammo only on the completing action (the one that seats the round). */
    const needed   = item.actor?._inActiveCombat ? Math.max(1, item.reloadActions) : 1;
    const progress = (Number(item.system?.loaded?.reloadProgress) || 0) + 1;
    if (progress < needed) return item.reload(null);   // banks a step; no ammo needed yet

    const chosenId = await promptAmmoChoice(item, eligible);
    if (!chosenId) return null;
    return item.reload(chosenId);
}

/** Feed ONE round into a magazine (the "＋ Load Magazine" control), prompting
 *  for the ammo when more than one type is eligible. Distinct from cocking:
 *  it never advances reload progress and never arms the weapon. Returns the
 *  feedMagazine() result, or null if cancelled. */
export async function feedMagazineWithPrompt(item) {
    if (!item?.hasChamber) return null;
    const eligible = item.getEligibleAmmo?.() ?? [];
    // 0 → let the mixin warn; 1 → feed it straight.
    if (eligible.length <= 1) return item.feedMagazine(eligible[0]?.item?.id ?? null);
    const chosenId = await promptAmmoChoice(item, eligible);
    if (!chosenId) return null;
    return item.feedMagazine(chosenId);
}

async function promptAmmoChoice(item, eligible) {
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2) return eligible[0].item.id;   // no dialog → first eligible

    /* Surface any oil coating on the meta line so the player can tell
     * poisoned bolts from plain ones before committing to the reload —
     * matches the same suffix pattern the attack-dialog ammo picker
     * uses. Coated ammo lives on its own 1-qty document (produced by
     * applyOilToAmmo), so eligible entries already list separately. */
    const rows = eligible.map((e) => {
        const oil = e.item?.system?.appliedOil;
        const oilChip = (oil && oil.name)
            ? ` · <span class="wdm-ammo-pick-oil"><i class="fa-solid fa-droplet"></i>${esc(oil.name)}</span>`
            : "";
        return `
        <button type="button" class="wdm-ammo-pick" data-ammo-id="${esc(e.item.id)}">
          <img src="${esc(e.item.img)}" alt="" />
          <span class="wdm-ammo-pick-text">
            <span class="wdm-ammo-pick-name">${esc(e.item.name)}</span>
            <span class="wdm-ammo-pick-meta">×${e.qty} · ${esc(e.container?.name ?? "Loose")}${oilChip}</span>
          </span>
        </button>`;
    }).join("");

    let chosen = null;
    await DialogV2.wait({
        window: { title: tFormat("WITCHER.Dialog.Reload", { item: item.name }, "Reload — {item}"), icon: "fa-solid fa-arrows-rotate" },
        content: `<div class="wdm-ammo-pick-grid">${rows}</div>`,
        buttons: [{ action: "cancel", label: t("WITCHER.Common.Cancel", "Cancel"), default: true }],
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
