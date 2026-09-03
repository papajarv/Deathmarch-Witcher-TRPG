/**
 * Module settings.
 *
 * Master `enabled` toggle plus per-feature toggles so users can opt into
 * individual phases. Each phase 1-9 gets its own boolean; Phase 0 (tokens,
 * base CSS, body class) is always on if the master switch is.
 */

import { registerChatPreviewSetting, applyChatPreviewVars } from "../chrome/chat-preview-config.mjs";

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
  /* Per-surface DECOUPLED scaling (the "text vs size" split).
   *   ui.sizeScales — per-surface LAYOUT zoom (frame/spacing/icons). Drives
   *                   `--wdm-size-<key>` → the surface's `zoom`.
   *   ui.fontScales — per-surface TEXT multiplier. Drives `--wdm-fs-<key>`,
   *                   folded into the surface's text factor so text scales
   *                   with UI Scale × this, INDEPENDENT of the size zoom.
   * Both default 1.0 (no change from today's look). Keys cover the four chrome
   * bars + the middle panels. See styles + ui-scale.js for how they're applied. */
  {
    key: "ui.sizeScales",
    type: Object,
    default: {
      topbar: 1.0, dock: 1.0, sidebar: 1.0, scenecontrols: 1.0,
      character: 1.0, inventory: 1.0, bestiary: 1.0,
      journal: 1.0, crafting: 1.0, map: 1.0
    },
    scope: "client",
    config: false,
    onChange: () => import("./ui-scale.js").then(m => m.applyUIScale())
  },
  {
    key: "ui.fontScales",
    type: Object,
    default: {
      topbar: 1.0, dock: 1.0, sidebar: 1.0, scenecontrols: 1.0,
      character: 1.0, inventory: 1.0, bestiary: 1.0,
      journal: 1.0, crafting: 1.0, map: 1.0
    },
    scope: "client",
    config: false,
    onChange: () => import("./ui-scale.js").then(m => m.applyUIScale())
  },
  /* Per-MODE memory for the UI Scale + Overall Scaling sliders so switching
   * scale modes doesn't bleed values between them. `ui.scale` and
   * `ui.chromeBarsScale` above stay the ACTIVE (runtime) values that
   * ui-scale.js reads; this remembers each mode's own last-applied slider
   * positions and restores them when you switch back. Keyed by mode name
   * (auto / manual / detailed / persection) → { scale, bars }. Default {}
   * so the first open falls back to the active flat value (migration).
   * (Detailed's ui.detailedScales and per-section's ui.sizeScales/fontScales
   * are already mode-exclusive, so they don't bleed and aren't stored here.) */
  {
    key: "ui.modeValues",
    type: Object,
    default: {},
    scope: "client",
    config: false
  },

  /* ---- Movement cost label size (client) ---------------------------------
   * On-screen size (CSS px) of the immersive movement planner's cost labels.
   * The label is world-space PIXI text held at a constant screen size by the
   * upright ticker (see policy/immersive-tactical-grid.mjs), so this is a true
   * screen-px size independent of map zoom. No reload — the next hover redraw
   * reads it. */
  {
    key: "immersiveGrid.costLabelSize",
    name: "WOU.Settings.MovementLabelSize.Name",
    hint: "WOU.Settings.MovementLabelSize.Hint",
    type: Number,
    default: 18,
    scope: "client",
    config: true,
    range: { min: 10, max: 40, step: 1 }
  },

  /* ---- Hotbar (per-user) -------------------------------------------------
   * Number of hotbar slots rendered in the dock's prompts row. Slot 10
   * is triggered by the "0" key; slots 1-9 by their matching digit.
   * No reload — the onChange re-runs injectHotbar on the current dock. */
  {
    key: "hotbar.slotCount",
    name: "WOU.Settings.HotbarSlotCount.Name",
    hint: "WOU.Settings.HotbarSlotCount.Hint",
    type: Number,
    default: 5,
    scope: "client",
    range: { min: 1, max: 10, step: 1 },
    onChange: () => import("../chrome/hotbar.js").then(m => m.refreshHotbar())
  },

  /* ---- UI Customisation: war-mode (in-encounter) visual effects (client) ---- */
  {
    key: "disableWarSparks",
    name: "WOU.Settings.DisableWarSparks.Name",
    hint: "WOU.Settings.DisableWarSparks.Hint",
    type: Boolean,
    default: false,
    scope: "client",
    onChange: () => applyWarModeClasses()
  },
  {
    key: "disableWarGlow",
    name: "WOU.Settings.DisableWarGlow.Name",
    hint: "WOU.Settings.DisableWarGlow.Hint",
    type: Boolean,
    default: false,
    scope: "client",
    onChange: () => applyWarModeClasses()
  },
  {
    /* Show the pinned-spells row on the dock even in PEACE mode (default: only
     * in war/combat mode). Purely a display toggle — a body class the CSS reads. */
    key: "showPinnedSpellsInPeace",
    name: "WOU.Settings.ShowPinnedSpellsInPeace.Name",
    hint: "WOU.Settings.ShowPinnedSpellsInPeace.Hint",
    type: Boolean,
    default: false,
    scope: "client",
    onChange: () => applyWarModeClasses()
  },
  {
    /* When ON (default), drawing a weapon puts the dock into war mode even with
     * no combat running. When OFF, war mode only engages while the actor is in
     * an active combat — equipping a weapon out of combat stays in peace. */
    key: "warModeOnEquip",
    name: "WOU.Settings.WarModeOnEquip.Name",
    hint: "WOU.Settings.WarModeOnEquip.Hint",
    type: Boolean,
    default: true,
    scope: "client",
    onChange: () => { import("../chrome/encounter.js").then(m => m.refreshEncounterState?.()).catch(() => {}); }
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
  {
    /* GM exclusion toggle — hide every Beast-category monster from the Bestiary
     * (world monsters + compendium entries). */
    key: "bestiary.hideBeasts",
    name: "WOU.Settings.BestiaryHideBeasts.Name",
    hint: "WOU.Settings.BestiaryHideBeasts.Hint",
    type: Boolean,
    default: false,
    scope: "world",
    /* Edited via the "Bestiary Settings" menu (registered below), not the raw
     * settings list. */
    config: false,
    onChange: () => { import("../chrome/bestiary.js").then(m => m.invalidateBestiaryEntries?.()).catch(() => {}); }
  },
  {
    /* GM exclusion toggle — hide every Humanoid-category monster from the
     * Bestiary. */
    key: "bestiary.hideHumanoids",
    name: "WOU.Settings.BestiaryHideHumanoids.Name",
    hint: "WOU.Settings.BestiaryHideHumanoids.Hint",
    type: Boolean,
    default: false,
    scope: "world",
    config: false,
    onChange: () => { import("../chrome/bestiary.js").then(m => m.invalidateBestiaryEntries?.()).catch(() => {}); }
  },
  {
    /* Monster-portrait aspect ratio in the Bestiary detail view: "witcher3"
     * (square, the default) or "gwent" (a tall Gwent-card crop). Applied as the
     * `wou-bestiary-gwent` body class by applyBestiaryPortraitAspect(). */
    key: "bestiary.portraitAspect",
    type: String,
    default: "witcher3",
    scope: "world",
    config: false,
    onChange: () => { try { applyBestiaryPortraitAspect(); } catch (_) {} }
  },
  {
    /* Which autopsy (Dissect) categories are offered: combat / stats / skills /
     * research. When ALL four are off, the Dissect action is hidden on every
     * carcass entirely (see context-menu-item.js remainsAction + dissect.js). */
    key: "bestiary.autopsyTypes",
    type: Object,
    default: { combat: true, stats: true, skills: true, research: true },
    scope: "world",
    config: false
  },
  {
    /* Immersive autopsy: when true, revealed stat/skill VALUES render as
     * descriptive adjectives ("Masterful") instead of raw numbers ("10"), so
     * the bestiary reads like in-world lore rather than a metagame stat block.
     * Players still learn the information — just not the literal number. */
    key: "bestiary.autopsyDescriptive",
    type: Boolean,
    default: true,
    scope: "world",
    config: false,
    onChange: () => { import("../chrome/bestiary.js").then(m => m.invalidateBestiaryEntries?.()).catch(() => {}); }
  },
  {
    /* Per-world overrides for the descriptive-value bracket NAMES. Keyed by
     * bracket namespace → array of words (blank entry = use the shipped default).
     * Edited via the "Configure bracket names…" dialog (openBracketConfig). */
    key: "bestiary.autopsyBrackets",
    type: Object,
    default: {},
    scope: "world",
    config: false,
    onChange: () => { import("../chrome/bestiary.js").then(m => m.invalidateBestiaryEntries?.()).catch(() => {}); }
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
  /* "Bestiary Settings" button — groups the GM's bestiary exclusions (hide
   * Beasts / Humanoids) and the monster-portrait aspect ratio. */
  import("../../applications/bestiaryConfig.mjs").then(({ BestiaryConfig }) => {
    game.settings.registerMenu(MODULE_ID, "bestiaryConfig", {
      name: "WOU.Settings.BestiaryConfig.MenuName",
      label: "WOU.Settings.BestiaryConfig.MenuLabel",
      hint: "WOU.Settings.BestiaryConfig.MenuHint",
      icon: "fa-solid fa-dragon",
      type: BestiaryConfig,
      restricted: true
    });
  }).catch((err) => console.warn(`${MODULE_ID} | bestiary config menu register failed`, err));

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

  /* Chat-preview client options — register the setting (synchronously, so it's
   * readable before the first message), then a "Chat Previews" button in
   * Configure Settings that opens the dialog. */
  registerChatPreviewSetting();
  try { applyChatPreviewVars(); } catch (_) { /* body may not exist yet */ }
  import("../../applications/chatPreviewConfig.mjs").then(({ ChatPreviewConfig }) => {
    game.settings.registerMenu(MODULE_ID, "chatPreviewConfig", {
      name: "Chat Previews",
      label: "Configure Chat Previews",
      hint: "Size, duration, which messages to show, and behaviour when a full-screen menu is open — for the floating chat cards.",
      icon: "fa-solid fa-comment-dots",
      type: ChatPreviewConfig,
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
  applyWarModeClasses();
  applyBestiaryPortraitAspect();
}

/** Toggle the `wou-bestiary-gwent` body class so CSS can swap the Bestiary
 *  detail portrait between the default square (Witcher-3) crop and a tall
 *  Gwent-card crop. Applied on init (via applyFeatureClasses) and live from the
 *  `bestiary.portraitAspect` setting's onChange. */
export function applyBestiaryPortraitAspect() {
  const aspect = getSetting("bestiary.portraitAspect");
  document.body.classList.toggle("wou-bestiary-gwent", aspect === "gwent");
}

/** Toggle body classes for the war-mode (in-encounter) effect opt-outs so CSS
 *  can suppress the dock sparks / glow. Called on init + on setting change. */
export function applyWarModeClasses() {
  document.body.classList.toggle("wou-no-war-sparks", !!getSetting("disableWarSparks"));
  document.body.classList.toggle("wou-no-war-glow",   !!getSetting("disableWarGlow"));
  document.body.classList.toggle("wou-pinned-peace",  !!getSetting("showPinnedSpellsInPeace"));
}
