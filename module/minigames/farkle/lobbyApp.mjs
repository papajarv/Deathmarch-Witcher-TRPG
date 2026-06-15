/**
 * FarkleLobbyApp — the pre-game table window.
 *
 * Pure VIEW over the shared `farkleTable` setting: it renders the four seats and
 * the stake config, and every button just calls `request(action, …)` in
 * lobby.mjs. It never writes the setting itself (the GM does), so it simply
 * re-renders whenever `syncFarkleUI` pokes it after a change lands.
 */

import {
    SEAT_IDS, getTable, request, dieItemsOf, purseOf, notifyLobbyClosed, LAST_DICE_FLAG
} from "./lobby.mjs";
import { CURRENCY_KEYS } from "../../data/actor/templates/currency.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class FarkleLobbyApp extends HandlebarsApplicationMixin(ApplicationV2) {

    static DEFAULT_OPTIONS = {
        id: "wdm-farkle-lobby",
        classes: ["witcher-ttrpg-death-march", "wdm-farkle-lobby"],
        tag: "div",
        window: { title: "WITCHER.Farkle.lobby.title", icon: "fa-solid fa-dice", resizable: false },
        position: { width: 560, height: "auto" },
        actions: {
            claim: FarkleLobbyApp.#onClaim,
            leave: FarkleLobbyApp.#onLeave,
            seatAI: FarkleLobbyApp.#onSeatAI,
            chooseDice: FarkleLobbyApp.#onChooseDice,
            start: FarkleLobbyApp.#onStart,
            closeTable: FarkleLobbyApp.#onCloseTable
        }
    };

    static PARTS = {
        body: { template: `systems/${SYSTEM_ID}/templates/minigames/farkle/lobby.hbs` }
    };

    /** The actor a given user gambles with: their assigned character. */
    #userActor(userId) {
        return game.users.get(userId)?.character ?? null;
    }

    async _prepareContext() {
        const t = getTable();
        const isGM = game.user.isGM;
        const myActor = game.user.character;
        const denom = t?.config?.denom ?? "crown";

        const seats = SEAT_IDS.map(id => {
            const s = t?.seats?.[id] ?? null;
            const mine = s?.kind === "human" && s.userId === game.user.id;
            const actor = s?.actorId ? game.actors.get(s.actorId) : null;
            return {
                id, occupied: !!s, kind: s?.kind ?? null, name: s?.name ?? null,
                mine, isAI: s?.kind === "ai", skill: s?.skill ?? null,
                diceCount: s?.diceItemIds?.length ?? 0,
                purse: actor ? purseOf(actor, denom) : null,
                canManageDice: mine || (isGM && s),
                canClear: !!s && (mine || isGM)
            };
        });

        return {
            isGM,
            open: !!t?.open,
            config: t?.config ?? null,
            seats,
            denom,
            denoms: CURRENCY_KEYS.map(k => ({ key: k, label: `WITCHER.Currency.${k}`, selected: k === denom })),
            mySeated: SEAT_IDS.some(id => t?.seats?.[id]?.userId === game.user.id),
            myActorName: myActor?.name ?? null,
            myPurse: myActor ? purseOf(myActor, denom) : 0,
            ante: t?.config?.ante ?? 0,
            gmActors: isGM ? game.actors.filter(a => ["character", "monster"].includes(a.type)).map(a => ({ id: a.id, name: a.name })) : []
        };
    }

    _onRender(context, options) {
        // GM stake-config inputs: write on change (debounced by the re-render).
        if (!game.user.isGM) return;
        this.element.querySelectorAll("[data-config]").forEach(el => {
            el.addEventListener("change", () => {
                const key = el.dataset.config;
                const value = el.type === "number" ? Number(el.value) : el.value;
                request("setConfig", { config: { [key]: value } });
            });
        });
        // GM "seat a specific actor as AI" selects.
        this.element.querySelectorAll("[data-ai-actor]").forEach(el => {
            el.addEventListener("change", () => {
                request("setAISeat", { seatId: el.dataset.aiActor, actorId: el.value || null });
            });
        });
    }

    _onClose(options) {
        notifyLobbyClosed();
        return super._onClose(options);
    }

    /* ------------------------------ actions ----------------------------- */

    static #onClaim(event, target) {
        const seatId = target.dataset.seat;
        const actor = game.user.character;
        if (!actor) return ui.notifications.warn(game.i18n.localize("WITCHER.Farkle.lobby.noCharacter"));
        request("claimSeat", { seatId, userId: game.user.id, actorId: actor.id });
    }

    static #onLeave(event, target) {
        request("leaveSeat", { seatId: target.dataset.seat });
    }

    static #onSeatAI(event, target) {
        request("setAISeat", { seatId: target.dataset.seat, actorId: null });
    }

    static async #onChooseDice(event, target) {
        const seatId = target.dataset.seat;
        const t = getTable();
        const seat = t?.seats?.[seatId];
        const actor = seat?.actorId ? game.actors.get(seat.actorId) : null;
        const dice = dieItemsOf(actor);
        if (!dice.length) return ui.notifications.info(game.i18n.localize("WITCHER.Farkle.lobby.noDice"));
        // How many of each die id are already chosen (a stack can be picked more
        // than once, so the selection is a multiset, not a set).
        const chosenCount = id => (seat.diceItemIds ?? []).filter(x => x === id).length;
        const fairLabel = game.i18n.localize("WITCHER.Farkle.lobby.fairDie");
        const loadedLabel = game.i18n.localize("WITCHER.Farkle.lobby.loadedDie");
        // Expand a stacked die (quantity > 1) into one selectable row per physical
        // die so a stack isn't collapsed to a single pickable entry.
        const rows = dice.flatMap(d => {
            const fair = d.system.isFair;
            const badge = fair
                ? `<span class="wdm-fk-dice-tag is-fair">${fairLabel}</span>`
                : `<span class="wdm-fk-dice-tag is-loaded"><i class="fa-solid fa-scale-unbalanced"></i> ${loadedLabel}</span>`;
            const qty = Math.max(1, d.system.quantity ?? 1);
            const already = chosenCount(d.id);
            return Array.from({ length: qty }, (_, i) => {
                const label = qty > 1 ? `${d.name} (${i + 1}/${qty})` : d.name;
                return `
            <label class="wdm-fk-dice-row">
                <input type="checkbox" name="${d.id}__${i}" data-die="${d.id}" ${i < already ? "checked" : ""}/>
                <img class="wdm-fk-dice-img" src="${foundry.utils.escapeHTML(d.img)}" alt=""/>
                <span class="wdm-fk-dice-name">${foundry.utils.escapeHTML(label)}</span>
                ${badge}
            </label>`;
            });
        }).join("");
        const result = await foundry.applications.api.DialogV2.prompt({
            window: { title: game.i18n.localize("WITCHER.Farkle.lobby.chooseDice") },
            content: `<div class="wdm-fk-dice-pick"><p>${game.i18n.format("WITCHER.Farkle.lobby.diceHint", { n: t.config.diceCount })}</p>${rows}</div>`,
            ok: {
                label: game.i18n.localize("WITCHER.Farkle.lobby.confirm"),
                callback: (ev, button) => Array.from(button.form.elements)
                    .filter(el => el.type === "checkbox" && el.checked).map(el => el.dataset.die)
            }
        }).catch(() => null);
        if (result) {
            // Remember this pick for next time, but only when editing your OWN
            // seat (a GM editing another seat must not clobber their own memory).
            if (seat.kind === "human" && seat.userId === game.user.id) {
                await game.user.setFlag(SYSTEM_ID, LAST_DICE_FLAG, result);
            }
            request("setDice", { seatId, diceItemIds: result });
        }
    }

    static #onStart(event, target) {
        request("start", {});
    }

    static #onCloseTable(event, target) {
        request("close");
    }
}
