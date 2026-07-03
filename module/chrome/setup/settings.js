/**
 * Module settings.
 *
 * Master `enabled` toggle plus per-feature toggles so users can opt into
 * individual phases. Each phase 1-9 gets its own boolean; Phase 0 (tokens,
 * base CSS, body class) is always on if the master switch is.
 */

export const MODULE_ID = "witcher-ttrpg-death-march";

const settings = [
  /* The chrome surface is GM-controlled (world-scoped): players can't opt
   * out of the shared UI. `feature.chat` is the deliberate exception — the
   * chat-card styling is a per-player preference and stays client-scoped. */
  {
    key: "enabled",
    name: "WOU.Settings.Enabled.Name",
    hint: "WOU.Settings.Enabled.Hint",
    type: Boolean,
    default: true,
    scope: "world",
    config: false,                         /* always on — not GM-disablable */
    onChange: () => location.reload()
  },
  {
    key: "feature.topChrome",
    name: "WOU.Settings.TopChrome.Name",
    hint: "WOU.Settings.TopChrome.Hint",
    type: Boolean,
    default: true,
    scope: "world",
    config: false,                         /* always on — not GM-disablable */
    onChange: () => location.reload()
  },
  {
    key: "feature.sidebar",
    name: "WOU.Settings.Sidebar.Name",
    hint: "WOU.Settings.Sidebar.Hint",
    type: Boolean,
    default: true,
    scope: "world",
    config: false,                         /* always on — not GM-disablable */
    onChange: () => location.reload()
  },
  {
    key: "feature.sceneControls",
    name: "WOU.Settings.SceneControls.Name",
    hint: "WOU.Settings.SceneControls.Hint",
    type: Boolean,
    default: true,
    scope: "world",
    config: false,                         /* always on — not GM-disablable */
    onChange: () => location.reload()
  },
  {
    key: "feature.hotbar",
    name: "WOU.Settings.Hotbar.Name",
    hint: "WOU.Settings.Hotbar.Hint",
    type: Boolean,
    default: true,
    scope: "world",
    config: false,                         /* always on — not GM-disablable */
    onChange: () => location.reload()
  },
  {
    key: "feature.actorSheets",
    name: "WOU.Settings.ActorSheets.Name",
    hint: "WOU.Settings.ActorSheets.Hint",
    type: Boolean,
    default: true,
    scope: "world",
    config: false,                         /* always on — not GM-disablable */
    onChange: () => location.reload()
  },
  {
    key: "feature.itemSheets",
    name: "WOU.Settings.ItemSheets.Name",
    hint: "WOU.Settings.ItemSheets.Hint",
    type: Boolean,
    default: true,
    scope: "world",
    config: false,                         /* always on — not GM-disablable */
    onChange: () => location.reload()
  },
  {
    key: "feature.chat",
    name: "WOU.Settings.Chat.Name",
    hint: "WOU.Settings.Chat.Hint",
    type: Boolean,
    default: true,
    config: false,                         /* always on — not GM-disablable */
    onChange: () => location.reload()
  },
  {
    key: "feature.compendium",
    name: "WOU.Settings.Compendium.Name",
    hint: "WOU.Settings.Compendium.Hint",
    type: Boolean,
    default: true,
    scope: "world",
    config: false,                         /* always on — not GM-disablable */
    onChange: () => location.reload()
  },

  /* ---- UI scale (per-client) ---------------------------------------------
   * Drives `--wdm-scale` on <html>, which the chrome CSS reads to scale
   * `font-size` on the chrome scope. All rem-based sizes in our styles flow
   * from that single value. See chrome/setup/ui-scale.js for the picker.
   *
   * `ui.scaleMode` — "manual" (use ui.scale verbatim) or "auto" (pick from
   * viewport + DPR; ui.scale acts as a baseline multiplier on top).
   * `ui.scale`    — 0.6–1.6. The range UI lets the user nudge in 0.05 steps.
   *
   * Client-scoped: every player picks their own. No reload needed —
   * applyUIScale() flips the CSS var live. */
  /* The three UI scaling settings are config:false — they're edited via the
   * "Configure UI Scaling" menu button registered below, not Foundry's
   * setting list. Apply in that dialog writes them all at once with live
   * preview. */
  {
    key: "ui.scaleMode",
    type: String,
    default: "auto",
    scope: "client",
    config: false,
    onChange: () => import("./ui-scale.js").then(m => m.applyUIScale())
  },
  {
    key: "ui.scale",
    type: Number,
    default: 1.0,
    scope: "client",
    config: false,
    onChange: () => import("./ui-scale.js").then(m => m.applyUIScale())
  },
  {
    key: "ui.chromeBarsScale",
    type: Number,
    default: 1.0,
    scope: "client",
    config: false,
    onChange: () => import("./ui-scale.js").then(m => m.applyUIScale())
  },
  /* Detailed scale mode — per-element scale overrides. When
   * `ui.scaleMode === "detailed"`, each of these drives its own CSS
   * variable (--wdm-<name>-scale) and the aggregate --wdm-chrome-bars-
   * scale / --wdm-scale + font-size chain is bypassed. In auto/manual
   * these values are ignored; the aggregate sliders drive everything.
   *
   * Persisted as a single object rather than seven individual keys so
   * a partial write (e.g. only three sliders touched) is atomic and
   * missing keys fall back to 1.0 cleanly. */
  {
    key: "ui.detailedScales",
    type: Object,
    default: {
      ui: 1.0,         // main UI scale (text via html font-size + popup fallback)
      topbar: 1.0,     // #wou-top-bar
      dock: 1.0,       // #wou-dock
      sidebar: 1.0,    // #sidebar (right)
      scenecontrols: 1.0, // #scene-controls (left)
      popups: 1.0      // .window-app / .application[data-appid] / .dialog / #compendium
    },
    scope: "client",
    config: false,
    onChange: () => import("./ui-scale.js").then(m => m.applyUIScale())
  },

  /* ---- Policy: world-scoped settings the GM controls for all players ---- */
  {
    key: "policy.maxJournalEntriesPerPlayer",
    name: "WOU.Settings.MaxJournalEntries.Name",
    hint: "WOU.Settings.MaxJournalEntries.Hint",
    type: Number,
    default: 0,                            /* 0 = no cap */
    scope: "world",
    range: { min: 0, max: 20, step: 1 }
  },

  /* ---- Bestiary -----------------------------------------------------------
   * `sourcePacks` is the list of compendium pack IDs that contribute to the
   * bestiary entry list (alongside world monster actors).  `state` is the
   * pin/research/encounter store keyed by bestiary-key (see lib/bestiary.js).
   * Both are world-scoped + config:false — managed via the bestiary panel
   * and module API, not Foundry's settings UI. */
  {
    /* Default seeded with the system's own bestiary pack so a fresh world's
     * monster-lore books, encounter search, and research UI find monsters
     * without the GM first having to open the Populate Bestiary dialog.
     * The GM can still add or remove packs from that dialog at any time. */
    key: "bestiary.sourcePacks",
    type: Array,
    default: ["witcher-ttrpg-death-march.bestiary"],
    scope: "world",
    config: false
  },
  {
    /* Legacy world-shared bestiary state (party-wide research/encounters/
     * knowledge).  As of schema v2 (per-character model) this is wiped by
     * migrateBestiarySchemaIfNeeded() on first GM ready; kept registered
     * so older worlds don't error on the wipe call. */
    key: "bestiary.state",
    type: Object,
    default: {},
    scope: "world",
    config: false
  },
  {
    /* Bestiary state schema version — bumped on migration.  Drives the
     * one-time wipe of the legacy world-shared state. */
    key: "bestiary.schemaVersion",
    type: Number,
    default: 0,
    scope: "world",
    config: false
  },

  /* ---- GM Panel: Pinboard tab store (images, doc links, free notes) ---- */
  { key: "gmPinboard", type: Object, default: { images: [], links: [], notes: "" }, scope: "world", config: false },

  /* ---- GM Panel: Reference tab store (editable rules cheat-sheets) ---- */
  { key: "gmReference", type: Object, default: { categories: [] }, scope: "world", config: false },

  /* ---- GM Panel: per-GM view memory (client-scoped) ---- */
  { key: "gmRefCollapsed", type: Array, default: [], scope: "client", config: false },
  { key: "gmNotesHeight", type: Number, default: 0, scope: "client", config: false }
];

export function registerSettings() {
  for (const s of settings) {
    game.settings.register(MODULE_ID, s.key, {
      name: s.name ? game.i18n.localize(s.name) : "",
      hint: s.hint ? game.i18n.localize(s.hint) : "",
      scope: s.scope ?? "client",
      /* Settings without a localized name are internal (e.g. bestiary state)
       * — hide them from the Foundry settings UI. */
      config: s.config !== undefined ? s.config : !!s.name,
      type: s.type,
      default: s.default,
      range: s.range,
      choices: s.choices,
      onChange: s.onChange
    });
  }

  /* "Configure UI Scaling" button — opens the UIScaleConfig dialog where
   * the user can preview drag-by-drag and press Apply to persist. */
  import("./ui-scale-config.js").then(({ UIScaleConfig }) => {
    game.settings.registerMenu(MODULE_ID, "uiScaleConfig", {
      name: "WOU.Settings.UIScaleConfig.MenuName",
      label: "WOU.Settings.UIScaleConfig.MenuLabel",
      hint: "WOU.Settings.UIScaleConfig.MenuHint",
      icon: "fa-solid fa-up-right-and-down-left-from-center",
      type: UIScaleConfig,
      restricted: false
    });
  });
}

export function getSetting(key) {
  try { return game.settings.get(MODULE_ID, key); }
  catch { return undefined; }
}

/** Apply per-feature body classes so CSS can scope rules. */
export function applyFeatureClasses() {
  const features = [
    "feature.topChrome",
    "feature.sidebar",
    "feature.sceneControls",
    "feature.hotbar",
    "feature.actorSheets",
    "feature.itemSheets",
    "feature.chat",
    "feature.compendium"
  ];
  for (const f of features) {
    const slug = f.replace("feature.", "").replace(/([A-Z])/g, "-$1").toLowerCase();
    const cls = `wou-${slug}`;
    if (getSetting(f)) document.body.classList.add(cls);
    else document.body.classList.remove(cls);
  }
}
