/**
 * Welcome dialog — shown once per client when the world loads.
 *
 * The setting is client-scope so each player can dismiss it independently.
 * Toggling the checkbox inside the dialog flips the same client setting,
 * so both entry points stay in sync.
 */

import { t } from "../chrome/lib/i18n.js";

const SYSTEM_ID = "witcher-ttrpg-death-march";
export const WELCOME_SETTING = "showWelcomeMessage";

const GITHUB_URL  = "https://github.com/papajarv/Deathmarch-Witcher-TRPG/issues";
const PATREON_URL = "https://patreon.com/papaJarv";
const DISCORD_URL = "https://discord.gg/93Z5kURgDZ";

/* English fallbacks so the dialog is still readable if a client happens to
 * have a stale lang cache (Foundry's browser lang fetch caches en.json;
 * a Foundry world-restart doesn't bust it — only a hard browser refresh
 * or a system.json version bump does). Using t() with a fallback matches
 * the pattern the rest of the migrated chrome uses. */
const FALLBACK = {
    "WITCHER.Welcome.Title": "Welcome to Deathmarch",
    "WITCHER.Welcome.Body": "Hey! This is an unofficial effort made by someone who is passionate about The Witcher. Please consider donating to help me keep developing and supporting this system. Another way you can seriously help is by reporting any bugs you find — either on GitHub's Issues section or on the Discord server. Thank you, enjoy :)",
    "WITCHER.Welcome.Github": "Report a Bug",
    "WITCHER.Welcome.Discord": "Join the Discord",
    "WITCHER.Welcome.Patreon": "Support on Patreon",
    "WITCHER.Welcome.Close": "Close",
    "WITCHER.Welcome.DontShowAgain": "Don't show again",
    "WITCHER.Welcome.Promo": "Free Compendium Module on Patreon"
};

export function registerWelcomeSetting() {
    game.settings.register(SYSTEM_ID, WELCOME_SETTING, {
        name: "WITCHER.Settings.ShowWelcome.Name",
        hint: "WITCHER.Settings.ShowWelcome.Hint",
        scope: "client",
        config: true,
        type: Boolean,
        default: true
    });
}

export async function showWelcomeDialogIfEnabled() {
    if (!game.settings.get(SYSTEM_ID, WELCOME_SETTING)) return;

    const DialogV2 = foundry.applications.api.DialogV2;
    const L = (k) => t(k, FALLBACK[k] ?? k);

    /* When a button fires, capture the checkbox state and stash it on the
     * dialog element so the .then() can read it after the dialog resolves.
     * This dodges the DialogV2 quirk where different button callbacks
     * return different value shapes.
     *
     * Returns null when the checkbox can't be found (DOM already torn
     * down by DialogV2's close animation) so callers can distinguish
     * "read false" from "couldn't read" and avoid clobbering an earlier
     * true captured by a button callback or the live change listener. */
    const readCheckbox = (dialog) => {
        const cb = dialog?.element?.querySelector?.("input[name='dontShow']");
        return cb ? !!cb.checked : null;
    };

    const content = `
        <div style="padding:4px 2px 8px; line-height:1.5;">
            <p>${L("WITCHER.Welcome.Body")}</p>
            <label style="display:flex; align-items:center; gap:6px; margin-top:12px; cursor:pointer;">
                <input type="checkbox" name="dontShow" />
                <span>${L("WITCHER.Welcome.DontShowAgain")}</span>
            </label>
        </div>
    `;

    let dontShow = false;
    /* Only overwrite dontShow when we successfully READ the checkbox.
     * A null return means the DOM was already torn down (DialogV2's
     * close callback frequently fires post-teardown), which used to
     * silently clobber a true value captured by a button callback. */
    const captureFromDom = (dialog) => {
        const state = readCheckbox(dialog);
        if (state !== null) dontShow = state;
    };
    const openLink = (url, dialog) => {
        captureFromDom(dialog);
        window.open(url, "_blank", "noopener,noreferrer");
        /* Don't return anything truthy — DialogV2 closes on the returned
         * value, which we don't need beyond the checkbox capture above. */
        return null;
    };

    /* Live sync: hook a change listener on the checkbox as soon as the
     * dialog renders. This is the authoritative source of truth for
     * `dontShow`, so any close path (Close button, ✕, Escape, alt+F4)
     * lands the correct value even if the DOM is gone by the time
     * a close/button callback tries to re-read it. Matched to this
     * dialog by class so other DialogV2 instances aren't touched. */
    const renderHookId = Hooks.on("renderDialogV2", (app, element) => {
        const el = element instanceof HTMLElement ? element : (element?.[0] ?? app?.element);
        if (!el?.classList?.contains?.("wdm-welcome-dialog")) return;
        const cb = el.querySelector("input[name='dontShow']");
        if (!cb || cb.dataset.wdmWired === "1") return;
        cb.dataset.wdmWired = "1";
        cb.addEventListener("change", () => { dontShow = !!cb.checked; });

        /* Distinct promo line UNDER the buttons. The buttons live in DialogV2's
         * footer, so inject after it (styled in styles/chrome.css). */
        if (!el.querySelector(".wdm-welcome-promo")) {
            const footer = el.querySelector(".form-footer, .dialog-buttons");
            const promo = document.createElement("div");
            promo.className = "wdm-welcome-promo";
            promo.innerHTML = `<i class="fa-brands fa-patreon"></i> <span>${L("WITCHER.Welcome.Promo")}</span>`;
            if (footer) footer.after(promo);
            else (el.querySelector(".window-content") ?? el).appendChild(promo);
        }
    });

    try {
        await DialogV2.wait({
            window: { title: L("WITCHER.Welcome.Title"), icon: "fa-solid fa-book-skull" },
            position: { width: 460 },
            content,
            classes: ["wdm-welcome-dialog"],
            buttons: [
                {
                    action: "github",
                    label: L("WITCHER.Welcome.Github"),
                    icon:  "fa-brands fa-github",
                    callback: (_e, _btn, dialog) => openLink(GITHUB_URL, dialog)
                },
                {
                    action: "patreon",
                    label: L("WITCHER.Welcome.Patreon"),
                    icon:  "fa-brands fa-patreon",
                    callback: (_e, _btn, dialog) => openLink(PATREON_URL, dialog)
                },
                {
                    /* Full-width Discord button spanning the Github+Patreon row
                     * above it (styled in styles/chrome.css). */
                    action: "discord",
                    label: L("WITCHER.Welcome.Discord"),
                    icon:  "fa-brands fa-discord",
                    callback: (_e, _btn, dialog) => openLink(DISCORD_URL, dialog)
                },
                {
                    action: "close",
                    label: L("WITCHER.Welcome.Close"),
                    icon:  "fa-solid fa-xmark",
                    default: true,
                    callback: (_e, _btn, dialog) => { captureFromDom(dialog); return null; }
                }
            ],
            rejectClose: false,
            /* Also handle the case where the user closes the dialog with the
             * window ✕ or Escape — read the checkbox one last time. Guarded
             * so a torn-down DOM doesn't overwrite the live-synced value. */
            close: (_event, dialog) => { captureFromDom(dialog); }
        }).catch(() => { /* rejectClose:false + catch = no-op on dismiss */ });
    } finally {
        Hooks.off("renderDialogV2", renderHookId);
    }

    if (dontShow) {
        await game.settings.set(SYSTEM_ID, WELCOME_SETTING, false);
    }
}
