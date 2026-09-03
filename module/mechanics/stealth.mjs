/**
 * Stealth — token sneak system.
 *
 * State lives on `actor.flags[SYSTEM_ID].stealth`:
 *   {
 *     active:        boolean,      // sneaking or not
 *     modifiers:     number,       // situational mod agreed at entry, applied
 *                                 // to every in-cone check for this sneak
 *     spottedBy:     [actorUuid],  // actors who have successfully spotted this stealther
 *     enteredAt:     number,       // world-time epoch when sneak entered (for logs)
 *   }
 *
 * PHASE 1 CONTENT (this file): entry / exit / modifier prompt / stored roll.
 * Movement-triggered spot checks, visual overlays, targeting gates, and
 * combat-tracker filtering live in follow-up modules to keep this file
 * focused on the state machine.
 *
 * Permission model:
 *   - Toggle on/off runs on the token's OWNER client (usually the player);
 *     writes to `actor.flags` need only self-ownership so no GM proxy is
 *     required for entry/exit.
 *   - Cross-actor writes (adding a spotter to another actor's `spottedBy`)
 *     go through the socket in stealth-hooks.mjs (Phase 3+).
 */

import { t, tFormat } from "../chrome/lib/i18n.js";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const FLAG_KEY  = "stealth";

/* ─────────── state readers ─────────── */

/**
 * Flag-safe key for a spotter, used by the `exposure` map.
 *
 * Actor UUIDs contain dots (`Actor.abc123`, `Scene.x.Token.y.Actor.z`), and
 * Foundry expands dotted keys into nested objects when a document updates. So
 * writing `exposure: { "Actor.abc": 5 }` is stored as
 * `exposure: { Actor: { abc: 5 } }`, and reading it back by the original key
 * yields undefined — silently, forever.
 *
 * That bug made exposure read as 0 on every tick, so the clock never
 * accumulated: only a single tick big enough to clear the threshold on its own
 * (a point-blank CAUGHT) could ever spot anyone, and the suspicion eye never
 * filled. Strip the dots.
 */
export function exposureKey(spotterUuid) {
    return String(spotterUuid ?? "").replace(/\./g, "_");
}

/** Read the stealth state blob from actor flags. Returns a normalized
 *  object (never null) so callers don't have to null-check. */
export function getStealthState(actor) {
    const raw = actor?.getFlag?.(SYSTEM_ID, FLAG_KEY) ?? null;
    return {
        active:      !!raw?.active,
        modifiers:   Number(raw?.modifiers) || 0,
        spottedBy:   Array.isArray(raw?.spottedBy) ? raw.spottedBy.slice() : [],
        enteredAt:   Number(raw?.enteredAt) || 0,
        /* ── exposure model (stealth-detection.mjs) ──
         * exposure:    spotter actor uuid → accumulated exposure points.
         *              Spotted when a spotter's total reaches the threshold.
         * lastTickPos: {x, y} in pixels at the previous tick — the baseline
         *              for MEASURED pace (distance travelled per tick).
         * lastPace:    last measured PACE, carried so the cone can be drawn
         *              for how the sneak is currently moving rather than
         *              re-deriving it on every overlay refresh. */
        exposure:    (raw?.exposure && typeof raw.exposure === "object") ? { ...raw.exposure } : {},
        lastTickPos: (raw?.lastTickPos && typeof raw.lastTickPos === "object")
            ? { x: Number(raw.lastTickPos.x) || 0, y: Number(raw.lastTickPos.y) || 0 }
            : null,
        /* Defaults to STILL, not walking: someone who has just hidden and not
         * yet moved has not moved. Pace feeds `paceBonus` on the in-cone check
         * and the movement badge under the token, so defaulting to "walk" would
         * penalise a sneak for motion no tick had measured. */
        lastPace:    String(raw?.lastPace ?? "still")
    };
}

/** Convenience: is this actor currently sneaking? */
export function isStealthed(actor) {
    return getStealthState(actor).active;
}

/** Convenience: has `spotter` already detected `stealther`? Returns true
 *  if the stealther isn't sneaking (nothing to hide from). */
export function isSpottedBy(stealtherActor, spotterActor) {
    if (!stealtherActor || !spotterActor) return true;
    const st = getStealthState(stealtherActor);
    if (!st.active) return true;
    return st.spottedBy.includes(spotterActor.uuid);
}

/* ─────────── entry: modifier dialog + roll ─────────── */

/** Prompt the player for a situational modifier and return the chosen
 *  number. Returns `null` if the player cancels. DialogV2 is Foundry v14
 *  standard — matches the pattern used elsewhere in this module (see
 *  brawlDialog.mjs, castDialog.mjs). */
async function promptStealthModifier(actor) {
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2) return 0;   /* soft-fail — proceed with 0 mod */

    const actorName = actor?.name ?? t("WITCHER.Common.Actor", "Actor");
    const title = tFormat("WITCHER.Mech.Stealth.Dialog.Title",
        { name: actorName }, `Enter Stealth: ${actorName}`);

    const content = `
        <div style="padding:0.5rem 0.25rem 0.25rem 0.25rem;font-size:0.95rem;">
            <p style="margin:0 0 0.5rem 0;color:#c8a878;">
                ${t("WITCHER.Mech.Stealth.Dialog.Prompt",
                    "Any situational modifier to your Stealth roll? (cover, terrain, lighting…)")}
            </p>
            <div style="display:flex;align-items:center;gap:0.5rem;">
                <label for="wdm-stealth-mod" style="flex:0 0 auto;font-weight:bold;">
                    ${t("WITCHER.Common.Mod", "Mod")}:
                </label>
                <input id="wdm-stealth-mod" name="mod" type="number" value="0" step="1"
                       style="flex:1 1 auto;padding:0.25rem 0.5rem;background:#0a0907;
                              color:#e0d0a0;border:1px solid #6b5a3a;border-radius:3px;"
                       autofocus />
            </div>
        </div>
    `;

    const result = await DialogV2.wait({
        window: { title, icon: "fa-solid fa-user-ninja" },
        content,
        buttons: [
            {
                action: "roll",
                label:  t("WITCHER.Mech.Stealth.Dialog.Roll", "Sneak"),
                icon:   "fa-solid fa-user-ninja",
                default: true,
                /* Return a wrapper object so `wait` can distinguish
                 * "chose roll with value 0" from "cancelled/closed"
                 * (both would look like falsy scalars otherwise). */
                callback: (_ev, _btn, dlg) => {
                    const input = dlg?.element?.querySelector?.('input[name="mod"]');
                    return { mod: Number(input?.value) || 0 };
                }
            },
            {
                action: "cancel",
                label:  t("WITCHER.Common.Cancel", "Cancel"),
                icon:   "fa-solid fa-xmark"
            }
        ],
        rejectClose: false
    }).catch(() => null);

    if (!result || typeof result !== "object") return null;
    return Number(result.mod) || 0;
}

/* NOTE: `rollStealth()` was removed along with the entry roll. The cone is
 * sized from BASE numbers and each tick rolls its own d10, so an entry roll
 * influenced nothing — the player threw a die for no effect. The entry dialog
 * now collects only the situational modifier, which DOES apply to every
 * in-cone check. */


/* ─────────── entry / exit ─────────── */

/** Enter stealth: prompt for mod, roll, store on actor flags, post a
 *  private log. Idempotent — calling on an already-stealthed actor
 *  re-prompts + rerolls (useful for "reset my roll" without exiting). */
export async function enterStealth(actor) {
    if (!actor) return false;
    try {
        const mod = await promptStealthModifier(actor);
        if (mod === null) return false;    /* cancelled */

        /* NO ENTRY ROLL.
         *
         * There used to be one — `1d10 + DEX + Stealth + mods`, stored as
         * `state.roll` — and nothing read it any more. The cone's size comes
         * from BASE numbers, and each tick inside a cone rolls its own fresh
         * d10, so the entry roll was a die the player threw for no effect.
         *
         * What the dialog is genuinely for is the SITUATIONAL modifier: the
         * GM-agreed bonus or penalty for this particular attempt (a good
         * approach, a bad one, a distraction arranged beforehand). That is
         * carried on `modifiers` and applied to every in-cone check for the
         * duration of the sneak.
         */
        /* Seed the movement baseline at the position the sneak starts from.
         * Without it the FIRST exposure tick has nothing to measure against and
         * reports "still" no matter how fast the actor was actually moving —
         * a free tick at the stillness discount every time someone enters
         * stealth mid-sprint. Falls back to null (→ treated as still) only when
         * the actor has no token on the canvas. */
        const tok = actor.getActiveTokens?.()?.[0] ?? null;
        const startPos = tok
            ? { x: Number(tok.center?.x ?? tok.x) || 0, y: Number(tok.center?.y ?? tok.y) || 0 }
            : null;

        await actor.setFlag(SYSTEM_ID, FLAG_KEY, {
            active:      true,
            modifiers:   mod,
            spottedBy:   [],
            /* Fresh sneak = fresh clock. This is a whole-object write, so any
             * exposure from a previous sneak is dropped with it. */
            exposure:    {},
            lastTickPos: startPos,
            lastPace:    "still",
            enteredAt:   Date.now()
        });
        return true;
    } catch (err) {
        console.warn(`${SYSTEM_ID} | enterStealth failed`, err);
        ui.notifications?.warn(t("WITCHER.Mech.Stealth.Notify.EntryFailed",
            "Couldn't enter stealth — check the console."));
        return false;
    }
}

/** Exit stealth: clear the flag. Runs silently — the visual overlay
 *  disappearing is feedback enough. */
export async function exitStealth(actor) {
    if (!actor) return false;
    await actor.unsetFlag(SYSTEM_ID, FLAG_KEY);
    return true;
}

/** HUD dispatcher — toggles based on current state. Called from the
 *  token HUD's `data-action="toggle-stealth"` handler. */
export async function toggleStealth(actor) {
    if (!actor) return false;
    if (isStealthed(actor)) return exitStealth(actor);
    return enterStealth(actor);
}

/* ─────────── spotter list mutations (used by hooks in Phase 3+) ─────────── */

/** Add a spotter's actor uuid to the stealther's `spottedBy`. Idempotent.
 *  MUST run on the GM client because the stealther is usually a different
 *  actor than the spotter's owner. Callers that aren't the GM should
 *  route through the socket helper in stealth-hooks.mjs. */
export async function markSpotted(stealtherActor, spotterActor) {
    if (!stealtherActor || !spotterActor) return false;
    const st = getStealthState(stealtherActor);
    if (!st.active) return false;
    const spotterUuid = spotterActor.uuid;
    if (st.spottedBy.includes(spotterUuid)) return false;
    const next = [...st.spottedBy, spotterUuid];
    await stealtherActor.setFlag(SYSTEM_ID, FLAG_KEY, {
        ...st,
        spottedBy: next
    });
    return true;
}

/** Overwrite the whole stealth state blob. Used by the spot-check hook
 *  to update `spottedBy` + `roll` in one write when a movement forces a
 *  fresh stealth roll for the stealther. */
export async function writeStealthState(actor, patch) {
    if (!actor) return false;
    const current = getStealthState(actor);
    await actor.setFlag(SYSTEM_ID, FLAG_KEY, { ...current, ...patch });
    return true;
}
