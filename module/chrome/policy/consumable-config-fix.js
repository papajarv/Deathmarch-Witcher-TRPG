/**
 * Consumable-config "remove effect" buttons.
 *
 * Patches two bugs in the system's WitcherConsumableConfigurationSheet:
 *
 *   1. itemEffect() schema has no `id` field, so each row is rendered with
 *      data-id="undefined". The system's ID-based filter then never finds a
 *      match and the row is never removed.
 *   2. In ApplicationV2, DEFAULT_OPTIONS-bound data-action handlers don't
 *      get applied to dynamically-added rows (and in some V2 builds, to
 *      table-cell <a> tags at all), so the removeEffect action silently
 *      never fires.
 *
 * Fix: intercept clicks on the minus buttons ourselves, identify the row by
 * its DOM index within the target table, and splice the array at that index.
 *
 * Migrated in from the standalone witcher-bug-fixes module.
 */

export function installConsumableConfigFix() {
  Hooks.on("renderWitcherConsumableConfigurationSheet", (app, element) => {
    const root = element instanceof HTMLElement ? element : element?.[0];
    if (!root) return;
    bindRemoveButtons(root, app);
  });
}

function bindRemoveButtons(root, app) {
  root.querySelectorAll('[data-action="removeEffect"]').forEach(btn => {
    /* Clone-and-replace to strip any existing (broken) listeners. */
    const fresh = btn.cloneNode(true);
    btn.replaceWith(fresh);

    fresh.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();

      const row    = fresh.closest(".list-item");
      if (!row) return;
      const target = row.dataset.target;   // 'effects' or 'removesEffects'
      if (!target) return;

      /* Index by DOM position among siblings sharing the same target. */
      const allRows = [...root.querySelectorAll(`.list-item[data-target="${target}"]`)];
      const idx     = allRows.indexOf(row);
      if (idx === -1) return;

      const currentList = foundry.utils.deepClone(
        app.item.system.consumeProperties[target] ?? []
      );
      if (idx >= currentList.length) return;
      currentList.splice(idx, 1);

      await app.item.update({
        [`system.consumeProperties.${target}`]: currentList
      });
    });
  });
}
