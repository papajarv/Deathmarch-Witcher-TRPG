/**
 * Chat-preview client configuration.
 *
 * One client-scoped Object setting (`chatPreviewConfig`) holds every knob for
 * the floating chat-card previews. A tiny get/set/apply surface here keeps the
 * preview code (chat-preview.js) and the CSS (via published vars/classes) in
 * sync, and the ChatPreviewConfig dialog edits it.
 *
 * Options:
 *   enabled       — master on/off.
 *   whenMenuOpen  — "over" | "hide": show cards above a full-screen chrome
 *                   overlay (inventory, …) or suppress them there.
 *   from          — "all" | "mine": preview everyone's messages, or only ones
 *                   the current user authored (their own action feedback).
 *   scale         — 0.7–1.6 size multiplier for the whole card column.
 *   lifetimeSec   — 3–30s auto-dismiss.
 */

const SYS = "witcher-ttrpg-death-march";
export const CHAT_PREVIEW_KEY = "chatPreviewConfig";

export const CHAT_PREVIEW_DEFAULTS = Object.freeze({
  enabled: true,
  whenMenuOpen: "over",
  from: "all",
  scale: 1.0,
  lifetimeSec: 11
});

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** Read the config, coerced + clamped to valid shape (defaults fill gaps). */
export function getChatPreviewConfig() {
  let raw = {};
  try { raw = game.settings.get(SYS, CHAT_PREVIEW_KEY) ?? {}; } catch (_) { /* not registered yet */ }
  return {
    enabled:      raw.enabled ?? CHAT_PREVIEW_DEFAULTS.enabled,
    whenMenuOpen: raw.whenMenuOpen === "hide" ? "hide" : "over",
    from:         raw.from === "mine" ? "mine" : "all",
    scale:        clamp(Number(raw.scale) || CHAT_PREVIEW_DEFAULTS.scale, 0.7, 1.6),
    lifetimeSec:  clamp(Math.round(Number(raw.lifetimeSec) || CHAT_PREVIEW_DEFAULTS.lifetimeSec), 3, 30)
  };
}

/** Merge a patch over the current config, persist, and re-apply CSS vars. */
export async function setChatPreviewConfig(patch) {
  const next = { ...getChatPreviewConfig(), ...patch };
  try { await game.settings.set(SYS, CHAT_PREVIEW_KEY, next); } catch (_) { /* ignore */ }
  applyChatPreviewVars();
  return next;
}

/** Push the size scale to CSS as a var and reflect the master toggle as a body
 *  class (so the whole strip can be hidden via CSS too). Called on ready and on
 *  every save/onChange. */
export function applyChatPreviewVars() {
  const cfg = getChatPreviewConfig();
  const root = document.documentElement;
  if (root) root.style.setProperty("--wdm-chatprev-scale", String(cfg.scale));
  document.body?.classList?.toggle("wdm-chatprev-off", !cfg.enabled);
}

/** Register the client setting. Call from the chrome settings setup. */
export function registerChatPreviewSetting() {
  game.settings.register(SYS, CHAT_PREVIEW_KEY, {
    scope: "client",
    config: false,
    type: Object,
    default: { ...CHAT_PREVIEW_DEFAULTS },
    onChange: () => { try { applyChatPreviewVars(); } catch (_) { /* pre-ready */ } }
  });
  /* Apply once the DOM is up so a saved non-default scale takes effect on load
   * (the init-time apply can run before <body> exists). */
  try { Hooks.once("ready", () => { try { applyChatPreviewVars(); } catch (_) {} }); } catch (_) { /* no Hooks yet */ }
}
