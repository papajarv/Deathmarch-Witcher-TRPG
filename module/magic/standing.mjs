/**
 * The effects only a person can end.
 *
 * Three of the engine's end conditions cannot be decided by the world:
 *
 *   untilDestroyed  — the wall of rock is broken, the ice is shattered
 *   untilTaskDone   — "until they carry out the command"
 *   untilWorldEvent — "until the next sunrise", in a world with no calendar
 *
 * They were declared in `ENDS`, offered in the authoring dropdown, and
 * produced by nothing at all — so an effect wearing one was permanent, while
 * reading perfectly correctly in the tree. Sigil of the Hidden immobilised its
 * own caster with no way out anywhere in the system.
 *
 * The world cannot answer these, so a GM does — and the control lives on the
 * cast card that announced the effect, which is where a GM is already looking
 * when the question comes up. `game.witcher.magic.standing()` opens the same
 * list for anything already in play.
 */

import { SYSTEM_ID } from "./systemId.mjs";
import { activeLifetimes, endDestroyed, endTaskDone, endWorldEvent, endWhere, ENDS } from "./lifetimes.mjs";

/** The conditions a person has to call. */
export const GM_ENDED = Object.freeze([
    ENDS.UNTIL_DESTROYED, ENDS.UNTIL_TASK_DONE, ENDS.WORLD_EVENT
]);

/** Does this cast leave anything a GM will have to end by hand? */
export function needsGmEnding(created = []) {
    return created.some(c => (c.life?.conditions ?? []).some(x => GM_ENDED.includes(x)));
}

/** The button the cast card carries when it does. */
export function endingButton(castId) {
    if (!castId) return "";
    return `<button type="button" class="wdm-end-standing" data-action="wdm-end-standing" `
         + `data-cast-id="${castId}">`
         + `<i class="fa-solid fa-hourglass-end"></i> `
         + `${foundry.utils.escapeHTML?.(game.i18n.localize("WITCHER.Magic.EndStanding"))
             ?? game.i18n.localize("WITCHER.Magic.EndStanding")}</button>`;
}

/** End everything this cast left standing that waits on a person's word. */
export function endStanding(castId) {
    const ended = [
        ...endDestroyed(null, castId),
        ...endTaskDone(null, castId)
    ];
    return ended;
}

/** Wire the card button. GM only — it is the GM's call by definition. */
export function installStandingHandler() {
    Hooks.on("renderChatMessageHTML", (_msg, el) => {
        const btn = el.querySelector?.('button[data-action="wdm-end-standing"]');
        if (!btn || btn._wdmStandingWired) return;
        btn._wdmStandingWired = true;
        if (!game.user?.isGM) { btn.remove(); return; }
        btn.addEventListener("click", () => {
            const ended = endStanding(btn.dataset.castId);
            globalThis.ui?.notifications?.info(game.i18n.format("WITCHER.Magic.EndedStanding", { n: ended.length }));
            btn.disabled = true;
        });
    });
}

/**
 * Everything this engine currently holds standing, with a way to end each.
 *
 * Reachable as `game.witcher.magic.standing()`. Deliberately plain: it exists
 * so a GM can always answer "why is that still on them?", which before this
 * had no answer short of a page reload.
 */
export async function openStandingPanel() {
    const { DialogV2 } = foundry.applications.api;
    const live = activeLifetimes();
    const esc = (v) => foundry.utils.escapeHTML?.(String(v ?? "")) ?? String(v ?? "");

    if (!live.length) {
        globalThis.ui?.notifications?.info(game.i18n.localize("WITCHER.Magic.NothingStanding"));
        return null;
    }
    const rows = live.map((e, i) => {
        const who = e.owner?.name ?? "—";
        const ends = e.conditions.join(", ");
        const left = Number.isFinite(e.remaining) ? ` · ${e.remaining} left` : "";
        return `<label style="display:flex;gap:.5rem;align-items:center;padding:2px 0;">
            <input type="checkbox" name="pick" value="${i}">
            <span><b>${esc(who)}</b> — ${esc(e.kind)} <i>(${esc(ends)}${esc(left)})</i></span>
        </label>`;
    }).join("");

    return DialogV2.prompt({
        window: { title: game.i18n.localize("WITCHER.Magic.StandingTitle") },
        content: `<div class="wdm-standing">${rows}</div>`,
        ok: {
            label: game.i18n.localize("WITCHER.Magic.EndSelected"),
            callback: (_ev, button) => {
                const picked = [...button.form.elements.pick]
                    .filter(x => x.checked).map(x => Number(x.value));
                for (const i of picked) {
                    const entry = live[i];
                    if (!entry || entry.ended) continue;
                    /* Ended by a person, and told so: an `onExpire` tree can
                     * tell a GM's call from a clock running out. Matched by
                     * identity so a hand-made effect, or one from a cast whose
                     * record is long gone, ends just the same. */
                    endWhere(e => e === entry, "gm");
                }
                globalThis.ui?.notifications?.info(game.i18n.format("WITCHER.Magic.EndedStanding", { n: picked.length }));
                return picked.length;
            }
        }
    }).catch(() => null);
}

/* Exported for the tests, and for anything that wants the same list. */
export { activeLifetimes };
void SYSTEM_ID; void endWorldEvent; void ENDS;
