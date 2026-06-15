/**
 * profession-skills — keep a character's "profession" (P) skill marks in sync
 * with their profession item. The marks are applied on drop (actor sheet
 * `_markProfessionSkills`); this clears them when the profession is removed so
 * a character with no profession has no P skills.
 */

const MODULE = "witcher-ttrpg-death-march";

/* Single-writer: the active GM if present, else the owning client. Avoids
 * every connected client racing the same actor.update. */
function isWriter(actor) {
    const gm = game.users?.activeGM;
    return gm ? gm.isSelf : !!actor?.isOwner;
}

/** Set every "profession"-category skill back to unmarked. */
export async function clearProfessionMarks(actor) {
    const skills = actor?.system?.skills ?? {};
    const upd = {};
    for (const [stat, group] of Object.entries(skills)) {
        if (!group || typeof group !== "object") continue;
        for (const [key, sk] of Object.entries(group)) {
            if (sk?.category === "profession") upd[`system.skills.${stat}.${key}.category`] = "";
        }
    }
    if (Object.keys(upd).length) await actor.update(upd);
}

async function onDeleteProfession(item) {
    const actor = item?.parent;
    if (!actor || item.type !== "profession" || actor.type !== "character") return;
    if (!isWriter(actor)) return;
    // A second profession still backing the marks → leave them in place.
    if (actor.items.some(i => i.type === "profession" && i.id !== item.id)) return;
    await clearProfessionMarks(actor);
}

export function registerProfessionSkills() {
    Hooks.on("deleteItem", onDeleteProfession);
}
