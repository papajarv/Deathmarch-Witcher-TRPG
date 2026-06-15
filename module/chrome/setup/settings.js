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
    key: "bestiary.sourcePacks",
    type: Array,
    default: [],
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
      onChange: s.onChange
    });
  }
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
