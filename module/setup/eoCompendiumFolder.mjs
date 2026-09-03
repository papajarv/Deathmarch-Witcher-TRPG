/**
 * EO compendium sidebar folder + visibility gate.
 *
 * Groups the six Equipment Overhaul packs (eo-armor, eo-weapons,
 * eo-components, eo-armor-enhancements, eo-diagrams, eo-witcher-alchemy)
 * under a
 * "Combat Extended" folder in Foundry's compendium sidebar, AND hides
 * those packs entirely from the sidebar when the extendedCombat
 * homebrew toggle is off — the packs are CE-specific content and a
 * pure-RAW world has no use for them.
 *
 * Two mechanisms:
 *   1. On CE on: ensure a "Combat Extended" Folder doc exists + write
 *      each EO pack into core.compendiumConfiguration with that
 *      folder's id. On CE off: delete the folder + clear the
 *      assignments. (folder grouping)
 *   2. A `renderCompendiumDirectory` hook tags the EO pack LI elements
 *      with `display: none` when CE is off. (visibility)
 *
 * Wired from `setup/hooks.mjs` on the `ready` hook + on `updateSetting`
 * for the master toggle so toggling at runtime reorganizes the sidebar
 * immediately.
 */

import { isHomebrewEnabled } from "../api/homebrew.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const FOLDER_NAME = "Combat Extended";
const EO_PACK_KEYS = Object.freeze([
    `${SYSTEM_ID}.eo-armor`,
    `${SYSTEM_ID}.eo-weapons`,
    `${SYSTEM_ID}.eo-components`,
    `${SYSTEM_ID}.eo-armor-enhancements`,
    `${SYSTEM_ID}.eo-diagrams`,
    `${SYSTEM_ID}.eo-witcher-alchemy`
]);

/** Find the EO folder in the compendium sidebar, if any. */
function findEoFolder() {
    return game.folders?.find?.(f => f.type === "Compendium" && f.name === FOLDER_NAME) ?? null;
}

/** Sync the EO compendium folder to the current CE master toggle state.
 *  GM-only — non-GM users see whatever the GM persisted last. */
export async function syncEoCompendiumFolder() {
    if (!game.user?.isGM) return;
    let ceOn = false;
    try { ceOn = isHomebrewEnabled("extendedCombat") === true; }
    catch (_) { ceOn = false; }

    if (ceOn) {
        /* Ensure folder exists. */
        let folder = findEoFolder();
        if (!folder) {
            try {
                folder = await Folder.create({
                    name: FOLDER_NAME,
                    type: "Compendium",
                    color: "#8b0000",
                    sorting: "a"
                });
            } catch (err) {
                console.warn(`${SYSTEM_ID} | EO compendium folder create failed`, err);
                return;
            }
        }
        /* Assign each EO pack to the folder via the compendium config setting. */
        const cfg = foundry.utils.deepClone(game.settings.get("core", "compendiumConfiguration") ?? {});
        let changed = false;
        for (const key of EO_PACK_KEYS) {
            const cur = cfg[key] ?? {};
            if (cur.folder !== folder.id) {
                cfg[key] = { ...cur, folder: folder.id };
                changed = true;
            }
        }
        if (changed) {
            try { await game.settings.set("core", "compendiumConfiguration", cfg); }
            catch (err) { console.warn(`${SYSTEM_ID} | compendiumConfiguration update failed`, err); }
        }
    } else {
        /* Clear the folder assignment + remove the folder. */
        const cfg = foundry.utils.deepClone(game.settings.get("core", "compendiumConfiguration") ?? {});
        let changed = false;
        for (const key of EO_PACK_KEYS) {
            const cur = cfg[key];
            if (cur?.folder) {
                cfg[key] = { ...cur, folder: null };
                changed = true;
            }
        }
        if (changed) {
            try { await game.settings.set("core", "compendiumConfiguration", cfg); }
            catch (err) { console.warn(`${SYSTEM_ID} | compendiumConfiguration update failed`, err); }
        }
        const folder = findEoFolder();
        if (folder) {
            try { await folder.delete(); }
            catch (err) { console.warn(`${SYSTEM_ID} | EO compendium folder delete failed`, err); }
        }
    }
}

/** Hide / show the EO packs' LI elements based on the CE toggle. Runs
 *  on every `renderCompendiumDirectory` so a toggle change + sidebar
 *  re-render lands the visibility correctly. Foundry v14 ApplicationV2
 *  hands the `html` argument as a raw HTMLElement; older code paths
 *  may pass a jQuery wrapper. Accept both. */
/* Hide EO content from the compendium sidebar when CE is off by
 * REMOVING the LI elements from the DOM after each render. CSS-based
 * approaches lose to Foundry's CSS layers (which give `!important`
 * inverted priority — anonymous-layer `!important` rules can be beaten
 * by deeper-layer ones the system stylesheet uses). Detaching the
 * nodes is bulletproof. The packs themselves are still accessible
 * via game.packs.get() — only the sidebar UI is filtered. */
function applyVisibility(html) {
    let ceOn = false;
    try { ceOn = isHomebrewEnabled("extendedCombat") === true; }
    catch (_) { ceOn = false; }
    /* Normalize html → HTMLElement. */
    let root = html;
    if (root && root.jquery) root = root[0];
    if (!root || typeof root.querySelectorAll !== "function") root = document;

    if (ceOn) return;        /* CE is on — Foundry's render shows them; nothing to do. */

    /* Remove EO pack LIs. */
    for (const key of EO_PACK_KEYS) {
        const el = root.querySelector(`[data-pack="${key}"]`);
        if (el && el.parentNode) el.parentNode.removeChild(el);
    }
    /* Remove the Combat Extended folder LI (it's empty anyway when CE
     * is off — syncEoCompendiumFolder deletes it — but the sidebar may
     * render a stale state until the next session). */
    for (const el of root.querySelectorAll('[data-folder-id]')) {
        const name = el.querySelector(".folder-name")?.textContent?.trim();
        if (name === FOLDER_NAME && el.parentNode) el.parentNode.removeChild(el);
    }
}

/** Public registration. Wires the `ready` hook + a setting-change
 *  watcher so the folder appears/disappears as the GM toggles CE,
 *  PLUS a renderCompendiumDirectory hook for visibility. */
export function registerEoCompendiumFolder() {
    Hooks.once("ready", () => { syncEoCompendiumFolder(); });
    Hooks.on("updateSetting", (setting) => {
        const key = setting?.key ?? "";
        if (key === `${SYSTEM_ID}.homebrew.extendedCombat`) {
            syncEoCompendiumFolder();
            /* Re-render the sidebar so the visibility hook fires
             * against the freshly-toggled state. `force: true` is
             * required — a noop render skips the renderCompendium
             * Directory hook. */
            ui.compendium?.render?.(true);
        }
    });
    Hooks.on("renderCompendiumDirectory", (_app, html) => applyVisibility(html));
}
