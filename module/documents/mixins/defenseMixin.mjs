/**
 * defenseMixin — actor methods for defending with a weapon or shield.
 *
 * Composed onto WitcherActor in documents/actor.mjs. Exposes:
 *   actor.defendWith(item, mode)        — Parry (−3) or Block (no penalty)
 *   actor.defendBySkill(skill, {label}) — Dodge or Reposition
 *
 * The four defensive reactions — Reposition, Dodge, Parry, Block — all go
 * through the defense reaction economy (`recordDefense` — first free, each
 * extra costs 1 STA, Core p.152). Parry/Block roll the wielding item's skill
 * (a shield's `skillKey` is "melee"; a weapon rolls its own); Dodge rolls the
 * Dodge/Escape skill and Reposition the Athletics skill.
 *
 *   PARRY  rolls at −3 and, on the chat card, offers "Apply Stagger" — a
 *          successful parry leaves the attacker Staggered. Parry does NOT
 *          erode the item.
 *   BLOCK  rolls at no penalty and, on the chat card, offers a button that
 *          spends one point of the item's Reliability ("SP") per click —
 *          each block absorbed degrades the weapon / shield (Core p.78).
 *
 * The buttons live in the roll's flavor (extendedRoll posts content = flavor
 * + body), so they ride along on the same chat card as the defense roll.
 */

import { extendedRoll } from "../../rolls/extendedRoll.mjs";
import { defenseMod as statusDefenseMod, cannotDefend } from "../../mechanics/statusEngine.mjs";
import { emitApplyStatus } from "../../setup/socketHook.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";

/** Find the attack chat message linked to this defense via the engagement
 *  flag.  Returns `{ attackTotal, attackerActor }` — both can be null if no
 *  link exists (defender used a dock button outside an engagement, or the
 *  attack predates the linkage). */
function lookupEngagement(engagementId) {
    if (!engagementId || !globalThis.game?.messages) return { attackTotal: null, attackerActor: null };
    for (const msg of game.messages) {
        if (msg.getFlag?.(SYSTEM_ID, "engagementId") !== engagementId) continue;
        // Only the attack message stamps `attackTotal` — defense msgs stamp
        // `defenseTotal`. Discriminating on which flag is present picks the right one.
        const at = msg.getFlag(SYSTEM_ID, "attackTotal");
        if (at == null) continue;
        // Resolve the speaker → actor for the auto-status apply.
        const sp = msg.speaker;
        const actor = sp?.actor ? game.actors?.get?.(sp.actor)
                    : sp?.token ? game.scenes?.get?.(sp.scene)?.tokens?.get?.(sp.token)?.actor
                    : null;
        return { attackTotal: Number(at), attackerActor: actor ?? null };
    }
    return { attackTotal: null, attackerActor: null };
}

/* Build the flag payload that links a defense roll to its attack. The
 * attacker's damage button reads `defenseTotal` off the matching message
 * (matched by `engagementId`) to compute the attack-vs-defense delta for
 * crit detection. Also stamps the chat-filter category so defense rolls
 * land in Combat Logs. No-op (returns just the category) when engagementId
 * is empty (e.g. dock Dodge button outside an engagement). */
function engagementFlags(engagementId, defenseTotal) {
    const base = { category: "combat" };
    if (!engagementId) return { [SYSTEM_ID]: base };
    return { [SYSTEM_ID]: { ...base, engagementId, defenseTotal: Number(defenseTotal) || 0 } };
}

const esc = (s) => Handlebars.escapeExpression(String(s ?? ""));
const signed = (n) => `${n >= 0 ? "+" : ""}${n}`;

/** Localize a stat label, falling back to the upper-cased key when the i18n
 *  key is missing (mirrors the helper in skillMixin). */
function statName(statKey) {
    const key = String(statKey ?? "").toLowerCase();
    const out = game.i18n.localize(CONFIG.WITCHER.statLabel(key));
    return (!out || out.startsWith("WITCHER.")) ? key.toUpperCase() : out;
}

/** Header for a defense chat card — mirrors the skill/save header so all
 *  three read alike. */
function defenseFlavor({ actorName, title, subtitle, chips = [] }) {
    const chipHtml = chips
        .filter(c => c && c.value != null && c.value !== "")
        .map(c => `<span class="wdm-chip"><span class="wdm-chip-k">${esc(c.label)}</span><span class="wdm-chip-v">${esc(c.value)}</span></span>`)
        .join("");
    return `
        <div class="wdm-skill-head">
            <div class="wdm-skill-actor">${esc(actorName)}</div>
            <div class="wdm-skill-name">${esc(title)}</div>
            ${subtitle ? `<div class="wdm-skill-sub">${esc(subtitle)}</div>` : ""}
            ${chipHtml ? `<div class="wdm-skill-chips">${chipHtml}</div>` : ""}
        </div>`;
}

/** The Block action button — spends one Reliability point per click. */
function blockButtonHtml(item) {
    return `<div class="wdm-defense-actions">
        <button type="button" class="wdm-defense-btn" data-action="wdm-reduce-reliability"
                data-item-uuid="${esc(item.uuid)}">
            <i class="fa-solid fa-shield-halved"></i>
            Block absorbed — spend 1 SP (${esc(item.name)})
        </button>
    </div>`;
}


/** Equipped weapons/shields (with an SP pool) whose actor the current user
 *  controls, for the GM's Block target picker. Scopes to the GM's selected
 *  tokens + the defender from the card, falling back to every owned actor.
 *  `preselect` (the item that actually defended) is always included first. */
function reliabilityCandidates(preselect) {
    const pool = new Set();
    for (const t of canvas?.tokens?.controlled ?? []) {
        if (t.actor?.isOwner) pool.add(t.actor);
    }
    if (preselect?.actor?.isOwner) pool.add(preselect.actor);
    if (!pool.size) {
        for (const a of game.actors ?? []) if (a.isOwner) pool.add(a);
    }
    const items = [];
    for (const a of pool) {
        for (const it of a.items) {
            if ((it.type === "weapon" || it.type === "shield")
                && it.system?.equipped
                && (Number(it.system?.reliability?.max) || 0) > 0) {
                items.push(it);
            }
        }
    }
    if (preselect && !items.includes(preselect)) items.unshift(preselect);
    return items;
}

/** Dropdown to choose which equipped weapon/shield ate the block. Pre-selects
 *  the defending item. Returns the chosen item, or null on cancel. */
async function pickReliabilityItem(items, preselect) {
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2) return preselect ?? items[0] ?? null;
    const opts = items.map(it => {
        const sp  = `${Number(it.system?.reliability?.value) || 0}/${Number(it.system?.reliability?.max) || 0}`;
        const sel = it === preselect ? "selected" : "";
        return `<option value="${esc(it.uuid)}" ${sel}>${esc(it.actor?.name ?? "")} — ${esc(it.name)} (SP ${sp})</option>`;
    }).join("");
    let chosen;
    try {
        chosen = await DialogV2.prompt({
            window: { title: "Block — reduce which SP?" },
            modal: true,
            content: `<div style="padding:8px 0;display:flex;flex-direction:column;gap:10px;">
                <label style="display:flex;gap:10px;align-items:center;">
                  <span style="min-width:60px;">Item</span>
                  <select name="uuid" autofocus style="flex:1;">${opts}</select>
                </label>
                <p style="margin:0;font-size:11px;opacity:0.7;">Spends 1 point of the chosen weapon / shield's Reliability.</p>
              </div>`,
            ok: { callback: (event, button) => button.form.elements.uuid.value },
            rejectClose: true
        });
    } catch (e) { return null; }                       // cancelled
    if (!chosen) return null;
    return await fromUuid(chosen);
}

/** Spend one point of a weapon/shield's Reliability ("SP"), floored at 0. The
 *  GM gets a dropdown to route the loss to whichever of their monsters blocked
 *  (defaulting to the defending item); a player can only ever degrade their own
 *  defending item — the `isOwner` gate enforces it. */
async function reduceReliabilityFromButton(btn) {
    const uuid = btn?.dataset?.itemUuid;
    const cardItem = uuid ? await fromUuid(uuid) : null;

    let item = cardItem;
    if (game.user.isGM) {
        const candidates = reliabilityCandidates(cardItem);
        if (candidates.length > 1) {
            item = await pickReliabilityItem(candidates, cardItem);
            if (!item) return;                          // cancelled the picker
        } else if (candidates.length === 1) {
            item = candidates[0];
        }
    }
    if (!item) { ui.notifications?.warn("No weapon or shield to reduce."); return; }
    if (!item.isOwner) { ui.notifications?.warn("You don't own that item."); return; }
    const cur = Number(item.system?.reliability?.value) || 0;
    if (cur <= 0) {
        ui.notifications?.warn(`${item.name} has no Reliability left — it's broken.`);
        return;
    }
    const next = Math.max(0, cur - 1);
    await item.update({ "system.reliability.value": next });
    const broke = next === 0;
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: item.actor }),
        content: `<em>${esc(item.name)} absorbs a block — SP ${cur} → ${next}${broke ? " <strong>(breaks!)</strong>" : ""}.</em>`,
        flags: { [SYSTEM_ID]: { category: "combat" } }
    });
}

/** Wire the defense-card action buttons. Called once during setup. */
export function installDefenseChatHandlers() {
    Hooks.on("renderChatMessageHTML", (_msg, el) => {
        const block = el.querySelector?.('button[data-action="wdm-reduce-reliability"]');
        if (block && !block.dataset.wired) {
            block.dataset.wired = "1";
            block.addEventListener("click", () => reduceReliabilityFromButton(block));
        }
        // Reposition's "Re-show overlay" button is gone — the overlay
        // auto-pops when the roll resolves; no re-show affordance.
        // Parry's Apply Stagger button is gone — auto-staggers via
        // defendWith when the parry roll beats the linked attack.
    });
}

/** Show an interactive "move preview" overlay for the Reposition defense.
 *
 *  Highlights every grid cell the defender can reach within their half-SPD
 *  budget; clicking a highlighted cell snaps the token there. ESC cancels.
 *  Per RAW Witcher TRPG p.151-152 + the "Reposition" defense houserule.
 *
 *  Distance model: cells are eligible if (Chebyshev cell distance) × (meters
 *  per cell) ≤ halfSpd. Diagonal counts the same as orthogonal — matches the
 *  RAW "in meters" movement model and Foundry's default measureDistance for
 *  square grids without a 1.5×-diagonal house rule.
 *
 *  Idempotent: any prior overlay is torn down before showing a new one.
 */
let _repositionActive = null;
export async function showRepositionOverlay(token, halfSpd) {
    if (!canvas?.scene || !token) return;
    if (halfSpd <= 0) {
        ui.notifications?.info("Half-SPD is 0 — no reposition distance to spend.");
        return;
    }
    // Tear down any prior overlay before re-arming.
    if (_repositionActive) {
        try { _repositionActive.cleanup(); } catch (_) {}
        _repositionActive = null;
    }

    const gridSize    = Number(canvas.scene.grid?.size)     || 100;
    const gridMeters  = Number(canvas.scene.grid?.distance) || 1.5;
    const cellsRadius = Math.floor(halfSpd / gridMeters);
    if (cellsRadius <= 0) {
        ui.notifications?.info(`Half-SPD (${halfSpd}m) is less than one grid cell (${gridMeters}m) — no reposition distance.`);
        return;
    }

    const tw      = Number(token.document?.width)  || 1;
    const th      = Number(token.document?.height) || 1;
    const baseX   = Number(token.document?.x) ?? Number(token.x);
    const baseY   = Number(token.document?.y) ?? Number(token.y);
    const baseCx  = Math.floor(baseX / gridSize);
    const baseCy  = Math.floor(baseY / gridSize);

    /* Pre-compute every reachable cell + draw EACH one as its own
     * interactive PIXI.Graphics. Per-cell event-mode = "static" makes
     * each cell its own hit-target — Foundry's higher canvas layers
     * (token, tile, grid) won't swallow the click because PIXI's
     * interaction manager hit-tests our overlay first when its z-order
     * sits on top of the canvas.controls / canvas.interface layer. */
    const overlay = new PIXI.Container();
    overlay.eventMode = "passive";   // child cells handle events themselves
    overlay.zIndex = 9999;
    overlay.sortableChildren = true;

    const commitMove = async (cx, cy) => {
        cleanup();
        try {
            /* Reposition is a defensive REACTION on someone else's turn —
             * canvas-movement.mjs's "not your turn" + budget gates would
             * otherwise block this. Set wdmFreeReposition so those gates
             * skip the check. */
            await token.document.update(
                { x: cx * gridSize, y: cy * gridSize },
                { wdmFreeReposition: true }
            );
            const movedCells = Math.max(Math.abs(cx - baseCx), Math.abs(cy - baseCy));
            ui.notifications?.info(`Repositioned ${movedCells * gridMeters}m.`);
        } catch (err) {
            console.warn("witcher-ttrpg-death-march | reposition move failed", err);
            ui.notifications?.error("Reposition: token update failed — see console.");
        }
    };

    let cellCount = 0;
    for (let dy = -cellsRadius; dy <= cellsRadius; dy++) {
        for (let dx = -cellsRadius; dx <= cellsRadius; dx++) {
            if (dx === 0 && dy === 0) continue;
            const cellDist = Math.max(Math.abs(dx), Math.abs(dy));   // Chebyshev
            if (cellDist > cellsRadius) continue;
            const cx = baseCx + dx;
            const cy = baseCy + dy;
            cellCount++;
            const cell = new PIXI.Graphics();
            cell.lineStyle(2, 0xffcc66, 0.85);
            cell.beginFill(0xffaa44, 0.22);
            cell.drawRect(cx * gridSize, cy * gridSize, gridSize * tw, gridSize * th);
            cell.endFill();
            cell.eventMode = "static";
            cell.cursor = "pointer";
            cell.hitArea = new PIXI.Rectangle(cx * gridSize, cy * gridSize, gridSize * tw, gridSize * th);
            cell.on("pointerdown", (event) => {
                event.stopPropagation();
                void commitMove(cx, cy);
            });
            cell.on("pointerover", () => { cell.alpha = 1.0; cell.tint = 0xffff99; });
            cell.on("pointerout",  () => { cell.alpha = 1.0; cell.tint = 0xffffff; });
            overlay.addChild(cell);
        }
    }

    /* Hint label hovering above the token. eventMode=none so it doesn't
     * steal clicks meant for cells that may visually overlap it. */
    const hint = new PIXI.Text(`Click a highlighted tile · ${halfSpd}m budget (${cellsRadius} cells, ${cellCount} reachable) · ESC to cancel`, {
        fontFamily: "monospace", fontSize: 16, fontWeight: "700",
        fill: 0xffcc66, stroke: 0x000000, strokeThickness: 4, align: "center"
    });
    hint.eventMode = "none";
    hint.anchor.set(0.5, 1);
    hint.x = baseX + (gridSize * tw) / 2;
    hint.y = baseY - 6;
    hint.zIndex = 10000;
    overlay.addChild(hint);

    /* `canvas.controls` is the top-most canvas group in v14 (above tokens,
     * grid, lighting). Attaching there means our interactive cells hit-test
     * BEFORE Foundry's standard click handlers — no stolen events. */
    const host = canvas.controls ?? canvas.interface ?? canvas.stage;
    host.addChild(overlay);

    const cleanup = () => {
        try { overlay.parent?.removeChild(overlay); overlay.destroy({ children: true }); } catch (_) {}
        try { window.removeEventListener("keydown", onKey); } catch (_) {}
        _repositionActive = null;
    };

    const onKey = (e) => {
        if (e.key === "Escape") { cleanup(); ui.notifications?.info("Reposition cancelled."); }
    };

    window.addEventListener("keydown", onKey);
    _repositionActive = { cleanup };
}

export const defenseMixin = (Base) => class extends Base {

    /**
     * Defend with a weapon or shield. `mode` is "parry" (−3, inflicts
     * Staggered on success, no item wear) or "block" (no penalty, may spend
     * the item's Reliability). Rolls the item's skill (`skillKey`, defaulting
     * to "melee" for shields) and posts a chat card carrying the matching
     * action button. Records the defense reaction (first free, each extra
     * costs 1 STA). Returns the roll result, or null if invalid / stunned.
     */
    async defendWith(item, mode = "parry", { engagementId = "" } = {}) {
        if (!item || (item.type !== "weapon" && item.type !== "shield")) return null;
        if (this._stunned || cannotDefend(this)) {
            ui.notifications?.warn(`${this.name} can't defend right now.`);
            return null;
        }
        const skillKey = item.system?.skillKey || "melee";
        const v = this._readSkillValues(skillKey);
        if (!v) return null;

        const cm = this.system?.combatMods ?? {};
        const block   = mode === "block";
        // Parry is −3; combatMods.parryPenaltyReduction shaves it (3 = no penalty).
        // Shields get an extra, shield-only reduction (Manticore school) so a
        // shield can parry without the −3 while weapons still take it.
        const shieldRed = item.type === "shield" ? (Number(cm.shieldParryPenaltyReduction) || 0) : 0;
        const penalty = block ? 0 : Math.min(0, -3 + (Number(cm.parryPenaltyReduction) || 0) + shieldRed);
        // Status penalties to defense (Staggered −2, Blinded −3, Prone −2, …),
        // summed live from the actor's active conditions.
        const statusDef = statusDefenseMod(this);
        // Base = governing stat + trained skill rank + skill modifier — the same
        // 1d10 + stat + skill every other roll uses — then the defense penalty
        // and any passive flat defense bonus (combatMods.flatDefenseMod).
        const base    = v.statVal + v.skillVal + v.skillMod;
        const total   = base + penalty + statusDef + (Number(cm.flatDefenseMod) || 0);
        const formula = total >= 0 ? `1d10 + ${total}` : `1d10 - ${Math.abs(total)}`;
        const title   = block ? "Block" : "Parry";

        const flavorBase = defenseFlavor({
            actorName: this.name,
            title,
            subtitle: `${item.name} — defense`,
            chips: [
                { label: statName(v.meta.statKey), value: v.statVal },
                { label: "Skill", value: v.skillVal },
                v.skillMod ? { label: "Mod", value: `${v.skillMod >= 0 ? "+" : ""}${v.skillMod}` } : null,
                penalty ? { label: title, value: String(penalty) } : null,
                statusDef ? { label: "Status", value: signed(statusDef) } : null
            ].filter(Boolean)
        });

        // Block: keep the SP-spend button. Parry: no button — auto-stagger
        // happens below if the roll beats the attack.
        const buttons = block ? blockButtonHtml(item) : "";

        // Engagement-linked defenses suppress their own chat card — the
        // attacker's chat card folds the defense roll inline (unified UX).
        // Standalone defenses (dock buttons, no engagement) still post.
        const suppress = !!engagementId;
        const result = await extendedRoll(formula, {
            speaker: ChatMessage.getSpeaker({ actor: this }),
            flavor: flavorBase + buttons,
            flags:   (r) => engagementFlags(engagementId, r.total),
            suppressMessage: suppress
        }, {});

        // NOTE: Parry's auto-stagger (RAW Core p.164: "Your opponent is
        // also staggered") fires from the ATTACKER's verdict patch, not
        // here. The attack roll happens AFTER the defense prompt resolves,
        // so at this point we don't yet know if the parry beat the attack.

        await this.recordDefense();
        // Return the rolled total + rendered HTML chunks so callers
        // (handleDefenseRequest → back over the socket → attacker's
        // weaponAttackMixin) can compute the attack-vs-defense verdict
        // AND render the defense roll inline on the unified attack card.
        return {
            ...result, formula, mode,
            defenseTotal: Number(result?.total) || 0,
            defenseFlavor: result?.flavor ?? "",
            defenseBody:   result?.body   ?? ""
        };
    }

    /**
     * Defend with a skill rather than a held item — the two skill-based
     * defensive reactions:
     *
     *   DODGE       (Reflex + Dodge/Escape) — leap clear; full avoidance.
     *   RELOCATION  (DEX + Athletics)       — a specific defensive scramble
     *                out of the way. This is NOT a generic Athletics check
     *                (which also covers throwing a weapon); it's a distinct
     *                defensive action that happens to use the Athletics skill,
     *                so it posts a "Reposition — defense" card and counts
     *                against the defense economy.
     *
     * Rolls `1d10 + stat + skill` (no penalty) and records the defense
     * reaction (first free, each extra costs 1 STA). Returns the roll result,
     * or null if invalid / stunned.
     */
    async defendBySkill(skillKey, { label, engagementId = "", reposition = false } = {}) {
        if (this._stunned || cannotDefend(this)) {
            ui.notifications?.warn(`${this.name} can't defend right now.`);
            return null;
        }
        const v = this._readSkillValues(skillKey);
        if (!v) return null;

        const title = label || game.i18n.localize(CONFIG.WITCHER.skillLabel(skillKey));
        const statusDef = statusDefenseMod(this);
        const total = v.statVal + v.skillVal + v.skillMod + statusDef;
        const formula = total >= 0 ? `1d10 + ${total}` : `1d10 - ${Math.abs(total)}`;

        const flavor = defenseFlavor({
            actorName: this.name,
            title,
            subtitle: "defense",
            chips: [
                { label: statName(v.meta.statKey), value: v.statVal },
                { label: "Skill", value: v.skillVal },
                v.skillMod ? { label: "Mod", value: `${v.skillMod >= 0 ? "+" : ""}${v.skillMod}` } : null,
                statusDef ? { label: "Status", value: signed(statusDef) } : null
            ].filter(Boolean)
        });

        const suppress = !!engagementId;
        const result = await extendedRoll(formula, {
            speaker: ChatMessage.getSpeaker({ actor: this }),
            flavor,
            flags:   (r) => engagementFlags(engagementId, r.total),
            suppressMessage: suppress
        }, {});

        await this.recordDefense();

        /* Reposition (Athletics-based scramble): RAW companion to the roll is
         * up to half-SPD movement. We compute the allowance, append it as a
         * note to the defense body, AUTO-show the canvas tile-picker overlay
         * (defender just clicks a highlighted square), and provide a re-arm
         * button in case the defender dismissed the overlay and wants to
         * pick again. */
        let defenseBody = result?.body ?? "";
        if (reposition) {
            const spd = Number(this.system?.stats?.spd?.value) || 0;
            const halfSpd = Math.max(0, Math.floor(spd / 2));
            const token = this.getActiveTokens?.()?.[0] ?? null;
            const tokenUuid = token?.document?.uuid ?? token?.uuid ?? "";
            /* No "Re-show overlay" button in the chat card — the overlay
             * auto-pops when the roll resolves, and the user explicitly
             * doesn't want a leftover button cluttering the card. If the
             * defender dismissed the overlay early, they can re-pick by
             * re-rolling Reposition (the cost of choosing). */
            defenseBody += `<div class="wdm-defense-reposition" data-half-spd="${halfSpd}" data-token-uuid="${tokenUuid}">` +
                `<span class="wdm-defense-reposition-k">Reposition</span>` +
                ` move up to <b>${halfSpd}m</b> on the canvas.` +
                (tokenUuid ? "" : ` <em>(no token on canvas — move manually)</em>`) +
            `</div>`;
            /* Auto-show the overlay so the defender doesn't have to click a
             * chat button first — straight from the defense roll into "pick
             * a tile on the canvas". Wrapped so a missing canvas / token
             * never blocks the defense card from returning. */
            if (token && halfSpd > 0) {
                try { await showRepositionOverlay(token, halfSpd); }
                catch (err) { console.warn("witcher-ttrpg-death-march | auto-reposition overlay failed", err); }
            }
        }

        return {
            ...result, formula, mode: skillKey,
            defenseTotal: Number(result?.total) || 0,
            defenseFlavor: result?.flavor ?? "",
            defenseBody
        };
    }
};
