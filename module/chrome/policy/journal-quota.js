/**
 * Player journal quota — gates how many journal entries each non-GM player
 * may create. Controlled by the `policy.maxJournalEntriesPerPlayer` world
 * setting (0 = unlimited, default). GMs are unrestricted.
 *
 * "Owned by the player" = journal's `ownership[userId] === OWNER (3)`.
 * Foundry writes this entry on the ownership map when a non-GM user creates
 * a document — reliable creator proxy across V13.
 */

import { MODULE_ID, getSetting } from "../setup/settings.js";

export function installJournalQuota() {
    Hooks.on("preCreateJournalEntry", (entry, data, options, userId) => {
        const cap = Number(getSetting("policy.maxJournalEntriesPerPlayer")) || 0;
        if (cap <= 0) return true;

        const user = game.users.get(userId);
        if (!user || user.isGM) return true;

        const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
        const existing = game.journal.filter(j => j.ownership?.[userId] === OWNER);
        if (existing.length >= cap) {
            ui.notifications.error(
                `${MODULE_ID}: you can only have ${cap} journal ${cap === 1 ? "entry" : "entries"}. Delete an existing one before creating another.`
            );
            return false;
        }
    });
}
