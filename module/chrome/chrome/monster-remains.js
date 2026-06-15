/**
 * Monster defeat → Remains item creation.
 *
 * When a monster actor has the "dead" status effect applied, a world-level
 * "remains" valuable is created in the Items sidebar and flagged with:
 *   - remainsCharges / remainsBaseWeight  (charge system, full on creation)
 *   - monsterUuid                          (UUID back-reference for future loot harvest)
 *
 * Only the active GM client executes the creation to avoid duplicates.
 *
 * Sidebar charge display stays live via an updateItem hook that
 * re-renders the ItemDirectory whenever a remains item's charge flags change.
 */

import { MODULE_ID } from "../setup/settings.js";
import { parseWeightKg } from "../lib/weight-parser.js";

const CHARGES_MAX       = 3;
const CHARGES_FLAG      = "remainsCharges";
const BASE_WEIGHT_FLAG  = "remainsBaseWeight";
const MONSTER_UUID_FLAG = "monsterUuid";
const TROPHY_ICON_FLAG  = "trophyIcon";
const DIFFICULTY_FLAG   = "monsterDifficulty";   // drives trophy availability

/* Resolve a monster's carcass weight in kg.
 *   1. Explicit "Weightless" / incorporeal note → 0 (ghosts leave no body).
 *   2. A readable number in the notes-subtab weight field → that value.
 *   3. Otherwise fall back to BODY × 10  (Body 8 → 80 kg).
 * The weight lives at system.descriptors.weight (the "notes" subtab). */
export function remainsWeightKg(actor) {
    const raw = String(actor?.system?.descriptors?.weight ?? "");
    if (/weightless|incorporeal|no\s*weight/i.test(raw)) return 0;
    const parsed = parseWeightKg(raw);
    if (parsed > 0) return parsed;
    const body = Number(actor?.system?.stats?.body?.value ?? 0);
    return body * 10;
}

/* ============================================================
   Create world remains item for a defeated monster
   ============================================================ */

async function createRemainsForMonster(actor) {
    const weight = remainsWeightKg(actor);
    // Configured carcass / trophy icons (monster sheet icon button); fall back
    // to the portrait. The trophy icon is stashed on the carcass so "Take
    // Trophy" can read it without re-resolving the source monster.
    const remainsImg = actor.system?.remainsIcon || actor.img;
    const trophyImg  = actor.system?.trophyIcon  || remainsImg;

    /* Prefer the compendium source UUID over the world-actor UUID so the
     * link survives the world actor being deleted later. Foundry stores
     * the original on `_stats.compendiumSource` in v13 (and on the legacy
     * `flags.core.sourceId` for older worlds). If neither is set the
     * monster is purely world-defined; we fall back to the world UUID. */
    const sourceUuid =
        actor._stats?.compendiumSource ??
        actor.flags?.core?.sourceId ??
        actor.uuid;

    const itemData = {
        name:  `${actor.name} Carcass`,
        type:  "valuable",
        img:   remainsImg,
        system: {
            type:        "remains",
            // Canonical source-monster link. Consumers (harvest / dissect /
            // context menu) and the item sheet read this system field first;
            // the flag below is kept only as a legacy read fallback.
            monsterUuid: sourceUuid,
            cost:        0,
            weight,
            quantity:    "1",
            isHidden:    false,
            isStored:    false,
            isCarried:   true,
            description: "",
        },
        // Default everyone to OWNER so any player can harvest / extract /
        // dissect the carcass and write its flags. Without this, the row
        // is GM-only by default and players can't interact.
        ownership: {
            default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER,
        },
        flags: {
            [MODULE_ID]: {
                [CHARGES_FLAG]:     CHARGES_MAX,
                [BASE_WEIGHT_FLAG]: weight,
                [MONSTER_UUID_FLAG]: sourceUuid,
                [TROPHY_ICON_FLAG]:  trophyImg,
                [DIFFICULTY_FLAG]:   actor.system?.threat?.difficulty ?? "easy",
            }
        }
    };

    const created = await Item.create(itemData, { displaySheet: false });
    if (created) {
        ui.notifications?.info(
            `Remains created: "${created.name}" added to the Items sidebar.`
        );
    }
}

/* ============================================================
   Sidebar live-update — re-render ItemDirectory when a remains
   item's charge flags are updated so the badge stays current.
   ============================================================ */

function registerSidebarRefresh() {
    Hooks.on("updateItem", (item, diff) => {
        if (item.type !== "valuable" || item.system?.type !== "remains") return;
        const flagDiff = diff?.flags?.[MODULE_ID];
        if (!flagDiff) return;
        if (!(CHARGES_FLAG in flagDiff) && !(BASE_WEIGHT_FLAG in flagDiff)) return;
        ui.items?.render();
    });
    // Re-render on delete so destroyed carcasses vanish from the directory.
    Hooks.on("deleteItem", (item) => {
        if (item.type !== "valuable" || item.system?.type !== "remains") return;
        ui.items?.render();
    });
}

/* ============================================================
   Defeat detection — createActiveEffect fires when the "dead"
   status is applied, covering both combat-tracker defeat and
   manual token-HUD application.
   ============================================================ */

export function registerMonsterRemainsHooks() {
    // Only the active GM creates the world item (avoids duplicate creation
    // when multiple clients are connected).
    Hooks.on("createActiveEffect", (effect) => {
        if (game.users.activeGM?.id !== game.user.id) return;
        if (!effect.statuses?.has("dead")) return;
        const actor = effect.parent;
        if (!actor || actor.type !== "monster") return;
        createRemainsForMonster(actor);
    });

    // One-time migration on ready: upgrade existing remains items that
    // pre-date the default-OWNER change to be accessible by every player.
    Hooks.once("ready", async () => {
        if (game.users.activeGM?.id !== game.user.id) return;
        const stuck = (game.items?.contents ?? []).filter(it =>
            it.type === "valuable"
            && it.system?.type === "remains"
            && (it.ownership?.default ?? 0) < CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER
        );
        if (!stuck.length) return;
        try {
            await Item.updateDocuments(stuck.map(it => ({
                _id: it.id,
                ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER },
            })));
            console.log(`${MODULE_ID} | promoted ${stuck.length} existing carcass${stuck.length === 1 ? "" : "es"} to default-OWNER`);
        } catch (err) {
            console.warn(`${MODULE_ID} | could not migrate carcass ownership`, err);
        }
    });

    /* Migrate the monsterUuid pointer when a world monster is deleted so
     * the remains items stay linked. Without this, deleting a monster from
     * the Actors sidebar leaves every carcass tied to it permanently broken.
     * We rewrite to the compendium source UUID when one exists; if not, the
     * carcass becomes orphaned and dissect/extract will warn. */
    Hooks.on("preDeleteActor", async (actor) => {
        if (actor.type !== "monster") return;
        if (game.users.activeGM?.id !== game.user.id) return;
        const sourceUuid =
            actor._stats?.compendiumSource ??
            actor.flags?.core?.sourceId ??
            null;
        if (!sourceUuid) return;   // no compendium origin, nothing we can do

        const remains = (game.items?.contents ?? []).filter(it =>
            it.type === "valuable"
            && it.system?.type === "remains"
            && it.flags?.[MODULE_ID]?.[MONSTER_UUID_FLAG] === actor.uuid
        );
        for (const r of remains) {
            try {
                await r.setFlag(MODULE_ID, MONSTER_UUID_FLAG, sourceUuid);
            } catch (err) {
                console.warn(`${MODULE_ID} | failed to migrate monsterUuid on "${r.name}"`, err);
            }
        }
        if (remains.length) {
            ui.notifications?.info(
                `Re-linked ${remains.length} remains item${remains.length === 1 ? "" : "s"} to the compendium source of "${actor.name}".`
            );
        }
    });

    registerSidebarRefresh();
}
