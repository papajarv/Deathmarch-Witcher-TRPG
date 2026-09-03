/**
 * ChatPreviewConfig — client-scoped configuration for the floating chat-card
 * previews (the compact cards that appear on the right when the chat tab is
 * collapsed). Opened from the "Chat Previews" button in Configure Settings.
 *
 * Reads/writes the single `chatPreviewConfig` client setting via the helpers in
 * chrome/chat-preview-config.mjs. Save persists + re-applies the CSS vars; the
 * preview code reads live from getChatPreviewConfig() on every message, so most
 * changes take effect on the next preview (no reload needed).
 */

import {
  getChatPreviewConfig, setChatPreviewConfig, CHAT_PREVIEW_DEFAULTS
} from "../chrome/chrome/chat-preview-config.mjs";

const SYS = "witcher-ttrpg-death-march";
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class ChatPreviewConfig extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: "wdm-chat-preview-config",
    tag: "form",
    classes: ["witcher-ttrpg-death-march", "wou-dialog", "wdm-chat-preview-config"],
    window: { title: "Chat Previews", icon: "fa-solid fa-comment-dots", resizable: true },
    position: { width: 460, height: "auto" },
    form: {
      handler: ChatPreviewConfig.#onSubmit,
      submitOnChange: false,
      closeOnSubmit: true
    },
    actions: {
      resetDefaults: ChatPreviewConfig.#onReset
    }
  };

  static PARTS = {
    body:   { template: `systems/${SYS}/templates/applications/chat-preview-config.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  async _prepareContext(_options) {
    const cfg = getChatPreviewConfig();
    return {
      cfg,
      buttons: [
        { type: "button", action: "resetDefaults", icon: "fa-solid fa-arrow-rotate-left", label: "Reset" },
        { type: "submit", icon: "fa-solid fa-floppy-disk", label: "Save" }
      ]
    };
  }

  /* Live-preview the size slider as it's dragged (writes the CSS var directly);
   * the persisted value only changes on Save. */
  _onRender(_context, _options) {
    const root = this.element;
    const scale = root?.querySelector('input[name="scale"]');
    const scaleOut = root?.querySelector('[data-scale-out]');
    const life = root?.querySelector('input[name="lifetimeSec"]');
    const lifeOut = root?.querySelector('[data-life-out]');
    if (scale) {
      const paint = () => {
        if (scaleOut) scaleOut.textContent = `${Math.round(Number(scale.value) * 100)}%`;
        document.documentElement.style.setProperty("--wdm-chatprev-scale", String(scale.value));
      };
      scale.addEventListener("input", paint);
      paint();
    }
    if (life && lifeOut) {
      const paint = () => { lifeOut.textContent = `${life.value}s`; };
      life.addEventListener("input", paint);
      paint();
    }
  }

  /* Restore the persisted scale var if the user closes without saving, so a
   * dragged-but-cancelled preview doesn't leak. */
  async close(options) {
    try { const { applyChatPreviewVars } = await import("../chrome/chrome/chat-preview-config.mjs"); applyChatPreviewVars(); }
    catch (_) { /* ignore */ }
    return super.close(options);
  }

  static async #onSubmit(_event, _form, formData) {
    const d = formData.object ?? {};
    await setChatPreviewConfig({
      enabled:      !!d.enabled,
      whenMenuOpen: d.whenMenuOpen === "hide" ? "hide" : "over",
      from:         d.from === "mine" ? "mine" : "all",
      scale:        Number(d.scale),
      lifetimeSec:  Number(d.lifetimeSec)
    });
  }

  static async #onReset(_event, _target) {
    await setChatPreviewConfig({ ...CHAT_PREVIEW_DEFAULTS });
    this.render();
  }
}
