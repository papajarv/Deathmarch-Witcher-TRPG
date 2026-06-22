/**
 * Combat tracker target indicators.
 *
 * Marks the tracker row of every actor the current user is targeting,
 * so you can see at a glance who you have selected without scanning the
 * canvas. Updates on:
 *
 *   - renderCombatTracker      (initial paint + Foundry re-render)
 *   - targetToken              (canvas click or context-menu target)
 *   - updateUser               (per-user actor-target flag changed)
 *
 * Resolution priority for "is this row targeted":
 *   1. Any token currently in game.user.targets whose actor matches the
 *      row's combatant.actor.
 *   2. The per-user actor-target flag (theater-of-mind tokenless target,
 *      set via the combat-tracker context menu).
 *
 * Visual: the matching row gets `data-wdm-targeted="1"` set on the
 * combatant <li>. Styling lives in styles/sidebar.css; default look is a
 * 3px amber inset on the left edge + a small crosshair badge in the corner.
 */

const SYSTEM_ID = "witcher-ttrpg-death-march";
const ACTOR_TARGET_FLAG = "actorTargetUuid";

/** Return the set of Actor ids the current user is targeting (token-based
 *  + the actor-target flag). */
function targetedActorIds() {
    const ids = new Set();
    for (const t of (game.user?.targets ?? [])) {
        if (t?.actor?.id) ids.add(t.actor.id);
    }
    const flagUuid = game.user?.getFlag?.(SYSTEM_ID, ACTOR_TARGET_FLAG);
    if (flagUuid) {
        // Synchronous cheap path: the actor index has uuid → doc lookup
        const a = fromUuidSync?.(flagUuid);
        if (a?.id) ids.add(a.id);
    }
    return ids;
}

/** Apply the data attribute to each combatant row whose actor matches a
 *  currently-targeted actor. Idempotent — strips the attr first so
 *  un-targeted rows clear when targets shrink. */
function paintTrackerRows(html) {
    const root = (html instanceof HTMLElement) ? html : html?.[0] ?? document;
    const rows = root.querySelectorAll?.("[data-combatant-id]") ?? [];
    if (!rows.length) return;
    const ids = targetedActorIds();
    for (const li of rows) {
        const cid = li.dataset.combatantId;
        const cb  = cid ? game.combat?.combatants?.get(cid) : null;
        const actorId = cb?.actor?.id;
        if (actorId && ids.has(actorId)) li.dataset.wdmTargeted = "1";
        else delete li.dataset.wdmTargeted;
    }
}

/** Refresh the currently-rendered combat tracker (sidebar + popout). Used
 *  when targets change OUTSIDE the renderCombatTracker hook (canvas click,
 *  context-menu pick, flag write). */
function refreshAllTrackers() {
    /* The sidebar tracker + any open popout both render to DOM nodes that
     * contain `[data-combatant-id]` rows. Re-paint every match. */
    paintTrackerRows(document);
}

export function registerCombatTrackerTargets() {
    Hooks.on("renderCombatTracker", (_app, html) => paintTrackerRows(html));

    /* Live re-paint on target changes. */
    Hooks.on("targetToken", (user) => {
        if (user !== game.user) return;
        refreshAllTrackers();
    });
    Hooks.on("updateUser", (user, changes) => {
        if (user !== game.user) return;
        // Only re-paint on actor-target flag changes — saves churn.
        const flagPath = changes?.flags?.[SYSTEM_ID]?.[ACTOR_TARGET_FLAG];
        if (flagPath === undefined && !("flags" in (changes ?? {}))) return;
        refreshAllTrackers();
    });
    /* Combatants can be added/removed mid-combat — re-paint when they
     * settle. updateCombat catches turn changes (cheap). */
    Hooks.on("updateCombat", () => refreshAllTrackers());

    /* Un-defeat: when the GM toggles a combatant from defeated → alive,
     * Foundry's tracker sometimes leaves the strike-through / dead
     * styling stuck (the combatant doc updates but the rendered row
     * isn't fully rebuilt). Force-render the tracker on every combatant
     * update, AND drop the "dead" status effect off the actor when
     * defeated flips to false so the skull overlay doesn't linger. */
    Hooks.on("updateCombatant", async (combatant, changes) => {
        try { ui.combat?.render?.(true); } catch (_) { /* tracker not open */ }
        if (!("defeated" in (changes ?? {}))) return;
        if (changes.defeated === false) {
            const actor = combatant.actor;
            if (actor?.toggleStatusEffect) {
                const deadId = CONFIG.specialStatusEffects?.DEFEATED ?? "dead";
                try {
                    if (actor.statuses?.has?.(deadId)) {
                        await actor.toggleStatusEffect(deadId, { active: false });
                    }
                } catch (err) {
                    console.warn(`${SYSTEM_ID} | un-defeat status cleanup failed`, err);
                }
            }
        }
        refreshAllTrackers();
    });
}
