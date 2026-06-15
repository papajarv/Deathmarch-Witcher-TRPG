/**
 * Central hook registration.
 *
 * Phase 0: just apply feature body-classes on `ready`. Future phases will
 * attach their renderers/handlers from their own module files and we'll
 * call them from here. Keeping ALL hook registration in one place makes
 * it easier to disable subsystems for debugging.
 */

import { applyFeatureClasses } from "./settings.js";

export function registerHooks() {
  Hooks.on("ready", () => {
    applyFeatureClasses();
  });

  // Phase 1 — top chrome
  // Hooks.on("renderSceneNavigation", (app, html, data) => { ... });

  // Phase 2 — sidebar
  // Hooks.on("renderSidebar", (app, html, data) => { ... });
  // Hooks.on("renderChatLog", (app, html, data) => { ... });
  // Hooks.on("renderCombatTracker", (app, html, data) => { ... });

  // Phase 3 — controls + players
  // Hooks.on("renderSceneControls", (app, html, data) => { ... });
  // Hooks.on("renderPlayers", (app, html, data) => { ... });

  // Phase 4 — hotbar: wired in main.js#ready via bindHotkeys + installItemCleanup
  //   (slot render lives in scripts/chrome/hotbar.js, called from dock rebind)

  // Phase 5/6 — sheets
  // Hooks.on("renderActorSheet", (app, html, data) => { ... });
  // Hooks.on("renderItemSheet", (app, html, data) => { ... });

  // Phase 7 — chat cards (typed)
  // Hooks.on("renderChatMessage", (msg, html, data) => { ... });

  // Phase 8 — compendium + journals
  // Hooks.on("renderCompendiumDirectory", (app, html, data) => { ... });
  // Hooks.on("renderJournalSheet", (app, html, data) => { ... });

  // Phase 9 — dialogs + tooltips + dice tray
  // Hooks.on("renderDialog", (app, html, data) => { ... });
}
