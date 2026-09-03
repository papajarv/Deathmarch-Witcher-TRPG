/**
 * Loot display.
 *
 * A loot actor (type === "loot") is a shared container the GM populates
 * with dropped goods, quest rewards, or a stash. Instead of granting
 * players Observer permission on it (which would let them read the
 * actor sheet AND its notes), the GM posts a chat card that mirrors the
 * pile's contents with a "Take" button per row. Clicking a Take button
 * routes through emitGiftItem — the GM's socket handler transfers the
 * item from the loot actor to the clicker's assigned character with
 * full permissions.
 *
 * Registrations:
 *   - Actor Directory context menu on loot-type actors → "Display to
 *     Party" (GM only) → posts the chat card.
 *   - renderChatMessageHTML → wires the per-item Take buttons on the
 *     posted card. Idempotent, re-wires on message update.
 */

import { MODULE_ID } from "../setup/settings.js";
import { emitGiftItem } from "../../setup/socketHook.mjs";
import { t, tFormat } from "../lib/i18n.js";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const LOOT_CARD_FLAG = "lootDisplay"; // flags.<SYSTEM_ID>.lootDisplay = { lootUuid }

function esc(s) {
    return String(s ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
}

/* -------------------------------------------------------------------- */
/*  Card render                                                         */
/* -------------------------------------------------------------------- */

/** Build the current-state HTML for a loot actor's items. Re-renders on
 *  every message update so a taken item drops out of the card without
 *  a stale button lingering. */
function renderLootCardHtml(lootActor) {
    if (!lootActor) return "";
    const rows = lootActor.items
        ?.filter?.(i => i && !i.system?.isStored) // hide items inside containers
        .sort?.((a, b) => a.name.localeCompare(b.name)) ?? [];

    const itemRows = rows.length
        ? rows.map(item => {
            const qty  = Math.max(1, Number(item.system?.quantity) || 1);
            const img  = item.img || "icons/svg/item-bag.svg";
            return `
                <li class="wdm-loot-row" data-item-id="${esc(item.id)}">
                    <img class="wdm-loot-img" src="${esc(img)}" alt="" draggable="false"/>
                    <span class="wdm-loot-name">${esc(item.name)}</span>
                    ${qty > 1 ? `<span class="wdm-loot-qty">×${qty}</span>` : ""}
                    <button type="button" class="wdm-loot-take"
                            data-action="wdm-loot-take"
                            data-item-id="${esc(item.id)}"
                            title="${t("WITCHER.Chrome.LootDisplay.Text.TakeThisItemToYourCharacterSInventory", "Take this item to your character's inventory")}">
                        <i class="fa-solid fa-hand-holding"></i> ${t("WITCHER.Chrome.LootDisplay.Text.Take", "Take")}
                    </button>
                </li>`;
        }).join("")
        : `<li class="wdm-loot-empty"><i class="fa-solid fa-check"></i> ${t("WITCHER.Chrome.LootDisplay.Text.AllItemsTaken", "All items taken.")}</li>`;

    const currency = lootActor.system?.currency ?? {};
    const coins = ["crown", "oren", "bizant", "ducat", "lintar", "floren"]
        .map(k => ({ k, v: Number(currency[k]) || 0 }))
        .filter(c => c.v > 0);
    const coinRow = coins.length
        ? `<div class="wdm-loot-coins"><i class="fa-solid fa-coins"></i>
             ${coins.map(c => `<span>${c.v} ${esc(c.k)}${c.v === 1 ? "" : t("WITCHER.Chrome.LootDisplay.Text.PluralS", "s")}</span>`).join(" · ")}
           </div>`
        : "";

    return `
        <div class="wdm-loot-card" data-loot-uuid="${esc(lootActor.uuid)}">
            <header class="wdm-loot-head">
                <img class="wdm-loot-head-img" src="${esc(lootActor.img || "icons/svg/chest.svg")}" alt=""/>
                <div class="wdm-loot-head-text">
                    <span class="wdm-loot-title">${esc(lootActor.name)}</span>
                    <span class="wdm-loot-sub">${t("WITCHER.Chrome.LootDisplay.Text.LootClickTakeToSendToYourCharacter", "Loot — click Take to send to your character")}</span>
                </div>
            </header>
            ${coinRow}
            <ul class="wdm-loot-list">${itemRows}</ul>
        </div>`;
}

/* -------------------------------------------------------------------- */
/*  Post + refresh                                                      */
/* -------------------------------------------------------------------- */

async function postLootCard(lootActor) {
    if (!lootActor) return;
    if (!game.user?.isGM) return;
    try {
        await ChatMessage.create({
            content: renderLootCardHtml(lootActor),
            flags: { [SYSTEM_ID]: { [LOOT_CARD_FLAG]: { lootUuid: lootActor.uuid } } },
            speaker: { alias: lootActor.name }
        });
    } catch (err) {
        console.warn(`${SYSTEM_ID} | loot-display: post failed`, err);
        ui.notifications?.error?.(t("WITCHER.Chrome.LootDisplay.Notify.FailedToPost", "Failed to post loot card — see console."));
    }
}

/** Update every posted loot card that references the given actor so
 *  the button list stays in sync with the pile's contents. Runs on
 *  updateActor / deleteItem / createItem tied to the loot actor. */
async function refreshCardsFor(lootActor) {
    if (!lootActor || !game.user?.isActiveGM) return;
    const targetUuid = lootActor.uuid;
    for (const msg of game.messages ?? []) {
        const ref = msg.getFlag?.(SYSTEM_ID, LOOT_CARD_FLAG);
        if (ref?.lootUuid !== targetUuid) continue;
        try { await msg.update({ content: renderLootCardHtml(lootActor) }); }
        catch (err) { console.warn(`${SYSTEM_ID} | loot-display: refresh failed`, err); }
    }
}

/* -------------------------------------------------------------------- */
/*  Take button                                                         */
/* -------------------------------------------------------------------- */

async function onTakeClick(ev, msg) {
    ev.preventDefault();
    ev.stopPropagation();
    const btn = ev.currentTarget;
    if (btn.dataset.busy) return;
    btn.dataset.busy = "1";
    try {
        const itemId = btn.dataset.itemId;
        const ref = msg?.getFlag?.(SYSTEM_ID, LOOT_CARD_FLAG);
        const lootUuid = ref?.lootUuid;
        if (!itemId || !lootUuid) return;

        const lootActor = await fromUuid(lootUuid);
        if (!lootActor) {
            ui.notifications?.warn?.(t("WITCHER.Chrome.LootDisplay.Notify.LootDeleted", "Loot pile has been deleted."));
            return;
        }

        const recipient = game.user?.character ?? null;
        if (!recipient) {
            ui.notifications?.warn?.(t("WITCHER.Chrome.LootDisplay.Notify.AssignCharacter", "Assign a character to your user before taking loot."));
            return;
        }

        await emitGiftItem({
            sourceActorUuid: lootActor.uuid,
            targetActorUuid: recipient.uuid,
            itemId,
            quantity: 1,
            fromUserId: game.user?.id ?? null
        });
        /* Refresh happens on the GM side via the item delete/update
           hook wired in installLootDisplay. The clicker sees the
           refreshed card once the flag/content update replicates. */
    } catch (err) {
        console.warn(`${SYSTEM_ID} | loot-display: take failed`, err);
        ui.notifications?.error?.(t("WITCHER.Chrome.LootDisplay.Notify.FailedToTake", "Failed to take item — see console."));
    } finally {
        delete btn.dataset.busy;
    }
}

/* -------------------------------------------------------------------- */
/*  Context menu entry (Actor Directory)                                */
/* -------------------------------------------------------------------- */

function addDisplayLoot(entries) {
    if (!game.user?.isGM) return;
    const displayToPartyLabel = t("WITCHER.Chrome.LootDisplay.Text.DisplayToParty", "Display to Party");
    if (entries.some(e => e?.name === displayToPartyLabel)) return;
    entries.push({
        name: displayToPartyLabel,
        icon: '<i class="fa-solid fa-treasure-chest"></i>',
        condition: (li) => {
            const id = li?.dataset?.documentId ?? li?.dataset?.entryId;
            const actor = id ? game.actors?.get(id) : null;
            return actor?.type === "loot";
        },
        callback: async (li) => {
            const id = li?.dataset?.documentId ?? li?.dataset?.entryId;
            const actor = id ? game.actors?.get(id) : null;
            if (actor) await postLootCard(actor);
        }
    });
}

/* -------------------------------------------------------------------- */
/*  Public install                                                      */
/* -------------------------------------------------------------------- */

export function installLootDisplay() {
    Hooks.on("getActorContextOptions", (app, entries) => addDisplayLoot(entries));

    /* Refresh posted loot cards whenever the loot actor's contents
       shift (item taken / added / stack reduced). Gated to activeGM
       so only one client writes back. */
    const onItemChange = (item) => {
        const parent = item?.parent;
        if (parent?.type !== "loot") return;
        refreshCardsFor(parent);
    };
    Hooks.on("createItem", onItemChange);
    Hooks.on("updateItem", onItemChange);
    Hooks.on("deleteItem", onItemChange);
    /* Currency changes on the loot actor also refresh the coin row. */
    Hooks.on("updateActor", (actor) => {
        if (actor?.type === "loot") refreshCardsFor(actor);
    });

    /* Wire the Take buttons on every posted loot card. Runs on every
       render so a message update that rewrites the content re-attaches
       fresh listeners. */
    Hooks.on("renderChatMessageHTML", (msg, el) => {
        const ref = msg?.getFlag?.(SYSTEM_ID, LOOT_CARD_FLAG);
        if (!ref?.lootUuid) return;
        const btns = el.querySelectorAll?.('button[data-action="wdm-loot-take"]') ?? [];
        for (const btn of btns) {
            if (btn.dataset.wired) continue;
            btn.dataset.wired = "1";
            btn.addEventListener("click", (ev) => onTakeClick(ev, msg));
        }
    });
}
