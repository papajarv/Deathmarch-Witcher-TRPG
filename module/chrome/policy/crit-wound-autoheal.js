/**
 * Auto-resolve critical wounds once their natural-healing clock runs out.
 *
 * A wound only heals over time while it is `treated` — the data model anchors
 * `system.treatedAt` to the world clock at that moment (CriticalWoundData.treat()),
 * and derives `healComplete` once `healingTime` in-game days have elapsed
 * (Critical Healing table, BODY + level). Deadly wounds have no table entry
 * (`healingTime === 0`) and never complete here.
 *
 * This wires that to the world clock: when time advances, every treated wound
 * that has reached `healComplete` is resolved via `system.resolve()` (which
 * deletes the wound). The deletes are GM-gated so a single client performs them.
 *
 * Separately — and for ALL users — an open critical-wound item sheet must
 * re-render as time passes so its natural-healing counter ticks live. The clock
 * values are getters reading `game.time.worldTime`, but Foundry only re-renders
 * a sheet on document updates; a worldTime tick isn't one. installSheetRefresh-
 * Hooks covers ACTOR sheets only, so we refresh open wound item sheets here.
 */

const MODULE_ID = "witcher-ttrpg-death-march";

function isWound(item) {
    return item?.type === "criticalWound";
}

/* Re-render any open critical-wound item sheet so its healing counter follows
 * the world clock. Skips a sheet the user currently has focus in (mid-edit in
 * the config view) so a keystroke or open <select> isn't wiped — same guard the
 * actor-sheet refresh uses. */
function refreshOpenWoundSheets() {
    const active = document.activeElement;
    for (const app of (foundry.applications.instances?.values?.() ?? [])) {
        const doc = app?.document;
        if (doc?.documentName !== "Item" || doc?.type !== "criticalWound") continue;
        if (!app.rendered) continue;
        if (active && active !== document.body && app.element?.contains(active)) continue;
        app.render(false);
    }
}

async function sweepAllWounds() {
    if (!game.user?.isActiveGM) return;
    for (const actor of (game.actors?.contents ?? [])) {
        if (actor.type !== "character" && actor.type !== "monster") continue;
        for (const item of (actor.items ?? [])) {
            if (!isWound(item)) continue;
            if (item.system?.state !== "treated") continue;
            if (!item.system?.healComplete) continue;
            try {
                await item.system.resolve();
            } catch (err) {
                console.warn(`${MODULE_ID} | failed to resolve healed wound ${item.id}`, err);
            }
        }
    }
}

export function installCritWoundAutoheal() {
    Hooks.on("updateWorldTime", () => {
        refreshOpenWoundSheets();
        sweepAllWounds();
    });
    Hooks.once("ready", () => { sweepAllWounds(); });
}
