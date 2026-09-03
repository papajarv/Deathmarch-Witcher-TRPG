/**
 * BestiaryConfig — groups the GM's Bestiary settings behind one "Bestiary
 * Settings" button: hide Beasts / Humanoids from the Bestiary, and the
 * monster-portrait aspect ratio (Witcher-3 square vs Gwent-card tall).
 * World-scoped, GM-only. Setting onChange handlers do the actual apply work
 * (bestiary re-render / portrait body class), so Save just persists.
 */

import { t } from "../chrome/lib/i18n.js";

const MODULE_ID = "witcher-ttrpg-death-march";
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class BestiaryConfig extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "wdm-bestiary-config",
    tag: "form",
    classes: ["witcher-ttrpg-death-march", "wou-dialog", "wdm-bestiary-config"],
    window: { title: "WOU.Settings.BestiaryConfig.Title", icon: "fa-solid fa-dragon", resizable: true },
    position: { width: 460, height: "auto" },
    actions: {
      configBrackets: BestiaryConfig.#onConfigBrackets
    },
    form: {
      handler: BestiaryConfig.#onSubmit,
      submitOnChange: false,
      closeOnSubmit: true
    }
  };

  /** Open the descriptive-value bracket-name editor (dynamic import to avoid a
   *  chrome dependency at module load). */
  static #onConfigBrackets() {
    import("../chrome/chrome/bestiary.js")
      .then(m => m.openBracketConfig?.())
      .catch(err => console.warn("[witcher-ttrpg-death-march] open bracket config failed", err));
  }

  static PARTS = {
    body:   { template: `systems/${MODULE_ID}/templates/applications/bestiary-config.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  async _prepareContext(_options) {
    const get = (k) => { try { return game.settings.get(MODULE_ID, k); } catch { return undefined; } };
    const aspect  = (get("bestiary.portraitAspect") === "gwent") ? "gwent" : "witcher3";
    const autopsy = get("bestiary.autopsyTypes") ?? {};
    return {
      hideBeasts:      !!get("bestiary.hideBeasts"),
      hideHumanoids:   !!get("bestiary.hideHumanoids"),
      isWitcher3:      aspect === "witcher3",
      isGwent:         aspect === "gwent",
      autopsyCombat:   autopsy.combat   !== false,
      autopsyStats:    autopsy.stats    !== false,
      autopsySkills:   autopsy.skills   !== false,
      autopsyResearch: autopsy.research !== false,
      autopsyDescriptive: get("bestiary.autopsyDescriptive") !== false,
      buttons: [
        { type: "submit", icon: "fa-solid fa-floppy-disk", label: t("WITCHER.Common.Save", "Save") }
      ]
    };
  }

  static async #onSubmit(_event, _form, formData) {
    const data   = foundry.utils.expandObject(formData.object ?? {});
    const aspect = data.portraitAspect === "gwent" ? "gwent" : "witcher3";
    const autopsyTypes = {
      combat:   !!data.autopsyCombat,
      stats:    !!data.autopsyStats,
      skills:   !!data.autopsySkills,
      research: !!data.autopsyResearch
    };
    try { await game.settings.set(MODULE_ID, "bestiary.hideBeasts",     !!data.hideBeasts); }    catch (_) {}
    try { await game.settings.set(MODULE_ID, "bestiary.hideHumanoids",  !!data.hideHumanoids); } catch (_) {}
    try { await game.settings.set(MODULE_ID, "bestiary.portraitAspect", aspect); }               catch (_) {}
    try { await game.settings.set(MODULE_ID, "bestiary.autopsyTypes",   autopsyTypes); }         catch (_) {}
    try { await game.settings.set(MODULE_ID, "bestiary.autopsyDescriptive", !!data.autopsyDescriptive); } catch (_) {}
    // The settings' own onChange handlers re-render the bestiary and re-apply the
    // portrait body class, so no explicit apply is needed here.
  }
}
