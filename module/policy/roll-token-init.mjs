/**
 * GM "Roll Token Init" — a combat-tracker button that rolls initiative for
 * EVERY currently-selected token at once. Sits in the shared GM toggle bar
 * (next to Off-Turn Move). It's ENABLED only while one or more tokens are
 * selected on the canvas and greyed out otherwise, so a GM can box-select a
 * group of combatants and drop them all into the tracker with one click.
 *
 * Each token is added to the active combat (a new one is created if none is
 * running) and rolled on the Witcher rule `1d10 + REF` via the actor's own
 * `getInitiativeFormula()` — so per-actor REF (post-AE) is respected. Tokens
 * already in combat just get their initiative rolled; the rest are added first.
 *
 * GM-only; a player never sees the button.
 */

import { ensureGmToggleBar, styleGmToggleButton } from "./gm-tracker-toggles.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const BTN_CLASS = "wdm-roll-token-init";

/** Currently controlled (selected) tokens on the canvas. */
function selectedTokens() {
    return (canvas?.tokens?.controlled ?? []).filter(Boolean);
}

/** Reflect the enabled/greyed state off the current selection count. */
function paintEnabled(btn) {
    const n = selectedTokens().length;
    const enabled = n > 0;
    btn.disabled = !enabled;
    btn.style.opacity = enabled ? "1" : "0.4";
    btn.style.cursor  = enabled ? "pointer" : "not-allowed";
    btn.style.filter  = enabled ? "none" : "grayscale(1)";
    btn.title = enabled
        ? `Roll initiative for the ${n} selected token${n === 1 ? "" : "s"}`
        : "Select one or more tokens on the canvas to enable";
}

/** Add every selected token to the active combat and roll its initiative. */
async function rollInitForSelected() {
    const tokens = selectedTokens();
    if (!tokens.length) return;
    try {
        let combat = game.combat;
        if (!combat) {
            combat = await CONFIG.Combat.documentClass.create(
                { scene: canvas?.scene?.id ?? null, active: true });
        }
        if (!combat) {
            ui.notifications?.error("Could not create or find a combat encounter.");
            return;
        }

        const sceneId = combat.scene?.id ?? canvas?.scene?.id ?? null;
        /* Map tokenId → existing combatant so we can both skip re-adds AND find
         * the combatant to roll (covers character AND monster tokens, linked or
         * unlinked). */
        const byToken = new Map();
        for (const c of combat.combatants) if (c.tokenId) byToken.set(c.tokenId, c);

        // Add a combatant for every selected token that isn't already in combat.
        // NOTE: we require only a token id — NOT a resolvable world actor. Tokens
        // with their own delta-stored sheet (unlinked, base actor deleted or never
        // in the directory) still get rolled; the combatant carries the tokenId and
        // reads its stats off the token's synthetic actor.
        const toAdd = [];
        const wantTokenIds = [];
        for (const tok of tokens) {
            const td    = tok.document ?? tok;
            if (!td?.id) continue;
            const actor = td?.actor ?? tok?.actor;          // TokenDocument.actor (synthetic for unlinked tokens)
            // Controlled tokens are on the active canvas; only exclude if the
            // combat is explicitly bound to a DIFFERENT scene.
            const tScene = td.parent?.id ?? tok.scene?.id ?? canvas?.scene?.id ?? sceneId;
            if (sceneId && tScene && tScene !== sceneId) continue;
            wantTokenIds.push(td.id);
            if (!byToken.has(td.id)) {
                // Let actorId fall back to the token's own actorId (may be null for
                // pure token sheets); Combatant derives its actor from the token.
                const actorId = actor?.id ?? td.actorId ?? null;
                toAdd.push({ tokenId: td.id, sceneId: tScene ?? sceneId, actorId, hidden: !!td.hidden });
            }
        }
        if (toAdd.length) {
            const created = await combat.createEmbeddedDocuments("Combatant", toAdd);
            for (const c of created) if (c?.tokenId) byToken.set(c.tokenId, c);
        }

        /* Roll EVERY selected token's combatant (re-roll on each click — this is
         * an explicit "roll init for the selection" action). Group by per-actor
         * formula so each rolls 1d10 + its OWN REF. Resolve the actor through
         * several fallbacks so unlinked monster combatants aren't dropped. */
        const ids = wantTokenIds.map(tid => byToken.get(tid)?.id).filter(Boolean);
        const byFormula = new Map();
        for (const id of ids) {
            const c = combat.combatants.get(id);
            /* Resolve the actor from the token FIRST — for a token-only sheet the
             * synthetic actor lives on `c.token.actor`; the directory lookup is the
             * last resort and won't exist for these tokens. */
            const actor = c?.token?.actor ?? c?.actor
                        ?? (c?.actorId ? game.actors?.get?.(c.actorId) : null);
            const formula = (typeof actor?.getInitiativeFormula === "function")
                ? actor.getInitiativeFormula()
                : `1d10 + ${Number(actor?.system?.stats?.ref?.value) || 0}`;
            if (!byFormula.has(formula)) byFormula.set(formula, []);
            byFormula.get(formula).push(id);
        }
        for (const [formula, gids] of byFormula) {
            if (gids.length) await combat.rollInitiative(gids, { formula });
        }

        if (!combat.active && typeof combat.activate === "function") await combat.activate();
    } catch (err) {
        ui.notifications?.error("Failed to roll initiative for the selected tokens — see console.");
        console.error(`${SYSTEM_ID} | roll-token-init failed`, err);
    }
}

/** Inject the GM-only button into the tracker's shared toggle bar. */
function renderRollTokenInit(_app, html) {
    if (!game.user?.isGM) return;
    const bar = ensureGmToggleBar(html);
    if (!bar) return;
    bar.querySelectorAll(`.${BTN_CLASS}`).forEach(n => n.remove());   // idempotent

    const btn = document.createElement("button");
    btn.type = "button";
    btn.classList.add(BTN_CLASS);
    styleGmToggleButton(btn);
    btn.innerHTML = `<i class="fa-solid fa-dice-d20"></i><span>Roll Token Init</span>`;
    btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (btn.disabled) return;
        await rollInitForSelected();
    });
    paintEnabled(btn);
    bar.appendChild(btn);
}

/** Re-grey / un-grey the (open) tracker button when the selection changes. */
function refreshButtons() {
    document.querySelectorAll(`.${BTN_CLASS}`).forEach(paintEnabled);
}

/* `controlToken` fires ONCE PER TOKEN, so a box-select or ESC-deselect of many
 * tokens would run refreshButtons() (a DOM query + style writes) N times in one
 * frame. The button's state is a pure function of the FINAL selection, so we
 * coalesce all of a frame's control changes into a single repaint via rAF. */
let _repaintQueued = false;
function queueRefreshButtons() {
    if (_repaintQueued) return;
    _repaintQueued = true;
    requestAnimationFrame(() => { _repaintQueued = false; refreshButtons(); });
}

export function registerRollTokenInit() {
    Hooks.on("renderCombatTracker", renderRollTokenInit);
    /* Selecting / deselecting tokens must live-update the button's greyed state
     * without re-rendering the whole tracker — coalesced so a mass select/
     * deselect is one repaint, not one per token. */
    Hooks.on("controlToken", () => queueRefreshButtons());
}
