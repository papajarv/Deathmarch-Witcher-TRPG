/**
 * Monster defeat → Remains item creation.
 *
 * When a monster actor has the "dead" status effect applied, a world-level
 * `remains` item (first-class type) is created in the Items sidebar and
 * flagged with:
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
import { t } from "../lib/i18n.js";

const CHARGES_MAX       = 3;
const CHARGES_FLAG      = "remainsCharges";
const BASE_WEIGHT_FLAG  = "remainsBaseWeight";
const MONSTER_UUID_FLAG = "monsterUuid";
const TROPHY_ICON_FLAG  = "trophyIcon";
const DIFFICULTY_FLAG   = "monsterDifficulty";   // drives trophy availability
const IS_PEOPLE_FLAG    = "isPeople";             // people carcass → Loot / Trophy only

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

async function createRemainsForMonster(actor, { forceWorldItem = false } = {}) {
    const weight = remainsWeightKg(actor);
    // Configured carcass / trophy icons (monster sheet icon button); fall back
    // to the portrait. The trophy icon is stashed on the carcass so "Take
    // Trophy" can read it without re-resolving the source monster.
    const remainsImg = actor.system?.remainsIcon || actor.img;
    const trophyImg  = actor.system?.trophyIcon  || remainsImg;

    /* Link the carcass to the SPECIFIC instance that died — the token actor the
     * GM may have edited (added loot, linked a mutagen, tweaked the stat block)
     * after dragging it out of the bestiary — so harvest / mutagen / dissect
     * read THAT instance, not the vanilla compendium source. An embedded carcass
     * also resolves its source straight off its parent actor (resolveCarcassMonster),
     * so this UUID mainly serves theater-of-mind carcasses. The compendium origin
     * is only a POST-DELETION fallback: the preDeleteActor hook below rewrites
     * this to the compendium UUID if the world actor is later deleted. */
    const sourceUuid = actor.uuid;

    const itemData = {
        name:  `${actor.name} Carcass`,
        type:  "remains",
        img:   remainsImg,
        system: {
            // Canonical source-monster link. Consumers (harvest / dissect /
            // context menu) and the item sheet read this system field first;
            // the flag below is kept only as a legacy read fallback.
            monsterUuid: sourceUuid,
            cost:        0,
            weight,
            quantity:    1,
            isStored:    false,
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
                // Compendium origin — a LAST-RESORT fallback for resolving the
                // source monster only after the specific instance is gone (see
                // resolveCarcassMonster). Never shadows a live edited instance.
                sourceCompendiumUuid: actor._stats?.compendiumSource ?? actor.flags?.core?.sourceId ?? null,
                [TROPHY_ICON_FLAG]:  trophyImg,
                [DIFFICULTY_FLAG]:   actor.system?.threat?.difficulty ?? "easy",
                [IS_PEOPLE_FLAG]:    !!actor.system?.isPeople,
                // Whether the source monster carries a linked mutagen — read by
                // the carcass context menu to hide "Extract Mutagen" when there's
                // nothing to extract (stamped now, while the actor is in hand).
                mutagenLinked:       !!actor.system?.mutagen?.uuid,
                /* Snapshot the WORLD monster's loot config so harvest reads
                 * what the GM authored on this specific actor rather than
                 * the (usually vanilla) compendium source that `sourceUuid`
                 * points at. Without this, coinLoot / edited loot rows on a
                 * compendium-spawned monster silently vanish the moment it
                 * dies. Kept as a snapshot (not a live pointer) so it
                 * survives the world actor being deleted later. */
                lootSnapshot: {
                    loot:     foundry.utils.duplicate(actor.system?.loot     ?? []),
                    coinLoot: foundry.utils.duplicate(actor.system?.coinLoot ?? {})
                }
            }
        }
    };

    /* TOKEN MODE — the dying monster is on the map (its own token). Embed the
     * carcass on THAT token's actor so it drives the token-click harvest/dissect
     * menu WITHOUT cluttering the Items sidebar. THEATER OF MIND (no token) keeps
     * the world-item behavior so the sidebar carcass is still there to interact
     * with. `isToken` = unlinked synthetic token actor; otherwise fall back to a
     * placed token's actor. */
    /* `forceWorldItem` — the GM's manual "Spawn Carcass (World Item Bar)"
     * right-click. It deliberately skips TOKEN MODE and always creates the
     * world Item, so it works as a reliable fallback even when the monster
     * has a token on the scene (which would otherwise embed the carcass on
     * that token's actor and leave nothing in the Items sidebar). */
    const tokenActor = forceWorldItem
        ? null
        : (actor.isToken ? actor : (actor.getActiveTokens?.()?.[0]?.actor ?? null));
    if (tokenActor) {
        try { await tokenActor.createEmbeddedDocuments("Item", [itemData]); }
        catch (err) { console.warn(`${MODULE_ID} | embed remains on token actor failed`, err); }
        return;
    }

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
        if (item.type !== "remains") return;
        const flagDiff = diff?.flags?.[MODULE_ID];
        if (!flagDiff) return;
        if (!(CHARGES_FLAG in flagDiff) && !(BASE_WEIGHT_FLAG in flagDiff)) return;
        ui.items?.render();
    });
    // Re-render on delete so destroyed carcasses vanish from the directory.
    Hooks.on("deleteItem", (item) => {
        if (item.type !== "remains") return;
        ui.items?.render();
    });
}

/* ============================================================
   Defeat detection — createActiveEffect fires when the "dead"
   status is applied, covering both combat-tracker defeat and
   manual token-HUD application.
   ============================================================ */

/* Resolve the actor a directory row represents (V13 uses data-document-id;
 * older builds data-entry-id). */
function _resolveDirectoryActor(li) {
    const id = li?.dataset?.documentId ?? li?.dataset?.entryId;
    return id ? game.actors?.get(id) : null;
}

/* GM right-click on a monster in the Actors sidebar → spawn its carcass on
 * demand (same item the "dead" status would create). */
function addSpawnCarcass(entries) {
    const label = t("WITCHER.Chrome.MonsterRemains.Text.SpawnCarcass", "Spawn Carcass (World Item Bar)");
    if (entries.some(e => e?.name === label)) return;
    entries.push({
        name: label,
        icon: '<i class="fa-solid fa-skull-crossbones"></i>',
        condition: (li) => game.user?.isGM && _resolveDirectoryActor(li)?.type === "monster",
        callback:  (li) => {
            // GM-only, regardless of monster-actor ownership — mirror the
            // `condition` gate so a player who happens to own the monster can
            // never trigger the world-item spawn even if the menu condition is
            // ever bypassed.
            if (!game.user?.isGM) return;
            const actor = _resolveDirectoryActor(li);
            // Manual GM fallback — always spawn to the world Item bar, even
            // when the monster has a token on the scene (forceWorldItem).
            if (actor?.type === "monster") createRemainsForMonster(actor, { forceWorldItem: true });
        }
    });
}

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

    // Right-click "Spawn Carcass" on monster actors in the sidebar (GM only).
    Hooks.on("getActorContextOptions", (_app, entries) => addSpawnCarcass(entries));

    // One-time migration on ready: upgrade existing remains items that
    // pre-date the default-OWNER change to be accessible by every player.
    Hooks.once("ready", async () => {
        if (game.users.activeGM?.id !== game.user.id) return;
        const stuck = (game.items?.contents ?? []).filter(it =>
            it.type === "remains"
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
            it.type === "remains"
            && (it.system?.monsterUuid === actor.uuid
                || it.flags?.[MODULE_ID]?.[MONSTER_UUID_FLAG] === actor.uuid)
        );
        for (const r of remains) {
            try {
                // Update BOTH the canonical system field (read first by
                // resolveCarcassMonster) and the legacy flag.
                await r.update({
                    "system.monsterUuid":                        sourceUuid,
                    [`flags.${MODULE_ID}.${MONSTER_UUID_FLAG}`]: sourceUuid,
                });
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
