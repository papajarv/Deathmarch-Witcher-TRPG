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
const ACTOR_TARGET_FLAG      = "actorTargetUuid";    // legacy, single-value
const ACTOR_TARGET_LIST_FLAG = "actorTargetUuids";   // current, list

/** Return the set of TOKEN ids the current user is targeting, PLUS the
 *  set of Actor ids targeted via the tokenless flag (theater-of-mind
 *  path). Combat-tracker rows match by TOKEN first (so unlinked tokens
 *  of the same actor mark independently), falling back to actor id only
 *  for combatants whose token can't be resolved on the active scene. */
function targetedKeys() {
    const tokenIds = new Set();
    const actorIds = new Set();
    for (const t of (game.user?.targets ?? [])) {
        if (t?.id) tokenIds.add(t.id);
    }
    /* Multi-target tokenless flag (list). Legacy single-string flag
     * folded in for saves authored before the list existed. */
    const uuids = [];
    const list = game.user?.getFlag?.(SYSTEM_ID, ACTOR_TARGET_LIST_FLAG);
    if (Array.isArray(list)) uuids.push(...list.filter(Boolean).map(String));
    const legacy = game.user?.getFlag?.(SYSTEM_ID, ACTOR_TARGET_FLAG);
    if (legacy && !uuids.includes(String(legacy))) uuids.push(String(legacy));
    for (const uuid of uuids) {
        const a = fromUuidSync?.(uuid);
        if (a?.id) actorIds.add(a.id);
    }
    return { tokenIds, actorIds };
}

/** Apply the data attribute to each combatant row whose token (or actor,
 *  for the tokenless fallback) is currently targeted. Idempotent —
 *  strips the attr first so un-targeted rows clear when targets shrink. */
function paintTrackerRows(html) {
    const root = (html instanceof HTMLElement) ? html : html?.[0] ?? document;
    const rows = root.querySelectorAll?.("[data-combatant-id]") ?? [];
    if (!rows.length) return;
    const { tokenIds, actorIds } = targetedKeys();
    for (const li of rows) {
        const cid = li.dataset.combatantId;
        const cb  = cid ? game.combat?.combatants?.get(cid) : null;
        const tokenId = cb?.tokenId ?? null;
        const actorId = cb?.actor?.id ?? null;
        /* Per-token match first — keeps unlinked-token rows independent
         * (3 wolf combatants of the same actor only light up the row
         * whose token is in the target set). The actor-id branch fires
         * from the tokenless target LIST — a combatant WITH a token can
         * still be tokenless-targeted (e.g. GM has a token but the
         * player theatred-of-mind them via right/middle-click). */
        const targeted = (tokenId && tokenIds.has(tokenId))
                      || (actorId && actorIds.has(actorId));
        if (targeted) li.dataset.wdmTargeted = "1";
        else delete li.dataset.wdmTargeted;
    }
}

/** Refresh the currently-rendered combat tracker (sidebar + popout). Used
 *  when targets change OUTSIDE the renderCombatTracker hook (canvas click,
 *  context-menu pick, flag write). */
/* rAF-coalesced so a burst of combat/combatant/target updates in one frame
 * (turn change, mass initiative roll, multi-target) collapses into a SINGLE
 * DOM paint instead of one full `querySelectorAll` + row rebuild per event. */
let _trackerRepaintQueued = false;
function refreshAllTrackers() {
    /* The sidebar tracker + any open popout both render to DOM nodes that
     * contain `[data-combatant-id]` rows. Re-paint every match — once per frame. */
    if (_trackerRepaintQueued) return;
    _trackerRepaintQueued = true;
    requestAnimationFrame(() => { _trackerRepaintQueued = false; paintTrackerRows(document); });
}

/** Is the current user the "acting" party right now — i.e. does the
 *  current combatant belong to them? GM is treated as always acting
 *  (they drive NPC turns and can always tag targets). This is the gate
 *  the middle-click-to-target handler uses. */
function isMyTurnNow() {
    if (game.user?.isGM) return true;
    const cb = game.combat?.combatant;
    if (!cb) return false;
    return !!cb.actor?.isOwner;
}

/** Middle-click a tracker row → target the combatant. Mirrors the
 *  right-click context-menu path in chrome/context-menu-actor.js: if
 *  the combatant has a placed token on the active scene, toggle that
 *  token in `game.user.targets`; if it doesn't (theater-of-mind /
 *  no-token combatant), toggle the per-user `actorTargetUuid` flag
 *  which the attack pipeline reads via `getActorTarget()`. Ungated:
 *  players plan targets ahead of their turn; damage/status still hit
 *  the socket-side permission gate before landing on a target. */
async function onTrackerAuxClick(ev) {
    /* AUX button === 1 is the middle mouse button. Bail on any other
     * button — this handler is strictly the plain middle-click. */
    if (ev.button !== 1) return;
    const row = ev.target?.closest?.("[data-combatant-id]");
    if (!row) return;
    ev.preventDefault();
    ev.stopPropagation();
    /* Targeting is a planning affordance, not an action — allow any user
     * to tag from the tracker at any point in the round. Applying damage
     * / status still hits the socket-side permission gate on the target
     * actor (see socketHook.mjs authorizeSocket + isLegitimateAttackDamage),
     * so ungating tracker-target here doesn't unlock spoofing. */
    const cid = row.dataset.combatantId;
    const cb  = cid ? game.combat?.combatants?.get(cid) : null;
    if (!cb) return;

    const actor = cb.actor ?? null;
    if (actor?.type === "loot") return;   // loot piles aren't combatants — never targetable
    /* Look for a placed token first (canvas targeting is what the
     * attack pipeline prefers). Any token belonging to this actor on
     * the current scene qualifies — combatant.tokenId is authoritative
     * when the actor has multiple placed tokens. */
    const token = cb.token?.object
               ?? canvas?.tokens?.get?.(cb.tokenId)
               ?? (actor ? canvas?.tokens?.placeables?.find(t => t.actor?.id === actor.id) : null);

    /* Canvas manual token target-lock is disabled — on the canvas, targeting
     * is handled by the weapon → tile flow, not a manual middle-click lock.
     * A tracker middle-click therefore only sets a target in the tokenless
     * (theatre-of-the-mind) case; a combatant with a placed token is a no-op. */
    if (token) return;
    try {
        /* No token on canvas → toggle the actor's uuid in the
         * tokenless target LIST. Multiple actors can sit in the list
         * simultaneously; the attack pipeline picks them up via
         * getActorTarget() / getActorTargets(). */
        if (!actor) return;
        const { toggleActorTargetUuid } = await import("../chrome/chrome/context-menu-actor.js");
        await toggleActorTargetUuid(actor.uuid);
    } catch (err) {
        console.warn(`${SYSTEM_ID} | tracker middle-click target failed`, err);
    }
}

/** Wire the middle-click handler onto the current tracker DOM. Called
 *  after each render so a re-rendered tracker doesn't lose the listener.
 *  Uses `auxclick` (dispatched for non-primary buttons in modern
 *  browsers) with a `mousedown` fallback for older paths. Attached with
 *  the same delegation pattern the rest of the tracker code uses. */
function wireTrackerAuxClick(root) {
    if (!root || root.dataset?.wdmAuxWired === "1") return;
    root.addEventListener("auxclick", onTrackerAuxClick);
    /* Some browsers / Foundry element wrappers swallow auxclick for
     * elements without a native handler. mousedown+button===1 is the
     * belt-and-suspenders path. */
    root.addEventListener("mousedown", (ev) => {
        if (ev.button !== 1) return;
        /* Prevent the middle-click autoscroll cursor on scrollable
         * tracker bodies before it starts. */
        ev.preventDefault();
    });
    root.dataset.wdmAuxWired = "1";
}

export function registerCombatTrackerTargets() {
    Hooks.on("renderCombatTracker", (_app, html) => {
        paintTrackerRows(html);
        const root = (html instanceof HTMLElement) ? html : html?.[0] ?? null;
        wireTrackerAuxClick(root);
    });

    /* Live re-paint on target changes. */
    Hooks.on("targetToken", (user) => {
        if (user !== game.user) return;
        refreshAllTrackers();
    });
    Hooks.on("updateUser", (user, changes) => {
        if (user !== game.user) return;
        /* Only re-paint on actor-target flag changes — saves churn.
         * Watch both the legacy single-value flag AND the current
         * multi-value list flag so a middle-click that stacks a second
         * tokenless target immediately lights up its row. */
        const flags = changes?.flags?.[SYSTEM_ID];
        const touchedTarget = flags && (
               ACTOR_TARGET_FLAG      in flags
            || ACTOR_TARGET_LIST_FLAG in flags
        );
        if (!touchedTarget && !("flags" in (changes ?? {}))) return;
        refreshAllTrackers();
    });
    /* Combatants can be added/removed mid-combat — re-paint when they
     * settle. updateCombat catches turn changes (cheap). */
    Hooks.on("updateCombat", () => refreshAllTrackers());

    /* Auto-clear the tokenless actor-target flag on cleanup events —
     * otherwise a "target lock" set via the combat-tracker context
     * menu persists after the target's token or actor is deleted, or
     * after the combat ends. Only the CURRENT user's own flag is
     * cleared; flags belong to individual users so we don't reach
     * across.
     *
     * Also clears real token targets on combat end for the same
     * reason — leaving `game.user.targets` populated after an
     * encounter finishes causes the next attack to still fire against
     * a stale target. */
    const clearOwnActorTargetIfMatches = async (actorUuid) => {
        try {
            /* Drop the deleted actor from the multi-value list — but
             * leave the OTHER entries alone so a stale token deletion
             * doesn't clear the whole target set. Also handles the
             * legacy single flag for the transition period. */
            const list = game.user?.getFlag?.(SYSTEM_ID, ACTOR_TARGET_LIST_FLAG);
            if (Array.isArray(list) && list.includes(actorUuid)) {
                const next = list.filter(u => u !== actorUuid);
                if (next.length) await game.user.setFlag(SYSTEM_ID, ACTOR_TARGET_LIST_FLAG, next);
                else             await game.user.unsetFlag(SYSTEM_ID, ACTOR_TARGET_LIST_FLAG);
            }
            const legacy = game.user?.getFlag?.(SYSTEM_ID, ACTOR_TARGET_FLAG);
            if (legacy && legacy === actorUuid) {
                await game.user.unsetFlag(SYSTEM_ID, ACTOR_TARGET_FLAG);
            }
        } catch (err) {
            console.warn(`${SYSTEM_ID} | target-flag cleanup failed`, err);
        }
    };
    Hooks.on("deleteToken", async (tokenDoc) => {
        const actorUuid = tokenDoc?.actor?.uuid;
        if (actorUuid) await clearOwnActorTargetIfMatches(actorUuid);
        refreshAllTrackers();
    });
    Hooks.on("deleteActor", async (actor) => {
        if (actor?.uuid) await clearOwnActorTargetIfMatches(actor.uuid);
        refreshAllTrackers();
    });
    Hooks.on("deleteCombat", async () => {
        /* Combat ended — drop the tokenless flag AND release every
         * token target so the next fight starts clean. Targets are
         * per-user, so releaseAllTargets only touches the current
         * client's own targets. */
        try {
            if (game.user?.getFlag?.(SYSTEM_ID, ACTOR_TARGET_FLAG)) {
                await game.user.unsetFlag(SYSTEM_ID, ACTOR_TARGET_FLAG);
            }
            if (game.user?.getFlag?.(SYSTEM_ID, ACTOR_TARGET_LIST_FLAG)) {
                await game.user.unsetFlag(SYSTEM_ID, ACTOR_TARGET_LIST_FLAG);
            }
            /* game.user.updateTokenTargets([]) is the v13 API that
             * clears every current token target. Guarded with a
             * fallback to the older releaseAllTargets pattern. */
            if (typeof game.user?.updateTokenTargets === "function") {
                game.user.updateTokenTargets([]);
            } else {
                for (const t of [...(game.user?.targets ?? [])]) {
                    try { t.setTarget(false, { user: game.user, releaseOthers: false, groupSelection: false }); }
                    catch (_) { /* per-token failure — keep going */ }
                }
            }
        } catch (err) {
            console.warn(`${SYSTEM_ID} | end-of-combat target release failed`, err);
        }
        refreshAllTrackers();
    });

    /* Un-defeat: when the GM toggles a combatant from defeated → alive,
     * Foundry's tracker sometimes leaves the strike-through / dead
     * styling stuck (the combatant doc updates but the rendered row
     * isn't fully rebuilt). Force-render the tracker on every combatant
     * update, AND drop the "dead" status effect off the actor when
     * defeated flips to false so the skull overlay doesn't linger. */
    Hooks.on("updateCombatant", async (combatant, changes) => {
        /* Only a DEFEATED toggle needs our forced full rebuild (Foundry can
         * leave the strike-through styling stuck). Every OTHER combatant update
         * — most notably initiative — already re-renders via core, so forcing a
         * full `ui.combat.render(true)` here would turn one action into N full
         * tracker rebuilds (e.g. rolling initiative across a token selection).
         * Repaint our target chips (coalesced) and bail in that common case. */
        if (!("defeated" in (changes ?? {}))) { refreshAllTrackers(); return; }
        try { ui.combat?.render?.(true); } catch (_) { /* tracker not open */ }
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
