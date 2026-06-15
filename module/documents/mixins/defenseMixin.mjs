/**
 * defenseMixin — actor methods for defending with a weapon or shield.
 *
 * Composed onto WitcherActor in documents/actor.mjs. Exposes:
 *   actor.defendWith(item, mode)        — Parry (−3) or Block (no penalty)
 *   actor.defendBySkill(skill, {label}) — Dodge or Relocation
 *
 * The four defensive reactions — Relocation, Dodge, Parry, Block — all go
 * through the defense reaction economy (`recordDefense` — first free, each
 * extra costs 1 STA, Core p.152). Parry/Block roll the wielding item's skill
 * (a shield's `skillKey` is "melee"; a weapon rolls its own); Dodge rolls the
 * Dodge/Escape skill and Relocation the Athletics skill.
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

/** The Parry action button — opens the staggered-target picker. */
function parryButtonHtml() {
    return `<div class="wdm-defense-actions">
        <button type="button" class="wdm-defense-btn" data-action="wdm-apply-stagger">
            <i class="fa-solid fa-person-falling"></i>
            Apply Stagger
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
        content: `<em>${esc(item.name)} absorbs a block — SP ${cur} → ${next}${broke ? " <strong>(breaks!)</strong>" : ""}.</em>`
    });
}

/** Stagger a chosen actor. Candidates are the actors the clicker owns (a GM
 *  owns every actor), picked from a DialogV2 dropdown. Applies the
 *  "staggered" status to the selection. */
async function applyStaggerFromButton() {
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2) return;
    const candidates = game.actors.contents.filter(a => a.isOwner);
    if (!candidates.length) {
        ui.notifications?.warn("No actors you control to stagger.");
        return;
    }
    const options = candidates
        .map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`)
        .join("");
    let chosen;
    try {
        chosen = await DialogV2.prompt({
            window: { title: "Apply Stagger" },
            modal: true,
            content: `<div style="padding:8px 0;display:flex;flex-direction:column;gap:10px;">
                <label style="display:flex;gap:10px;align-items:center;">
                  <span style="min-width:60px;">Target</span>
                  <select name="actorId" autofocus style="flex:1;">${options}</select>
                </label>
                <p style="margin:0;font-size:11px;opacity:0.7;">A parried attacker is Staggered (−2 to attack and defense).</p>
              </div>`,
            ok: { callback: (event, button) => button.form.elements.actorId.value },
            rejectClose: true
        });
    } catch (e) { return; }                            // user cancelled
    if (!chosen) return;
    const target = game.actors.get(chosen);
    if (!target) return;
    await target.toggleStatusEffect?.("staggered", { active: true });
    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: target }),
        content: `<em>${esc(target.name)} is <strong>Staggered</strong> (Core p.159).</em>`
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
        const parry = el.querySelector?.('button[data-action="wdm-apply-stagger"]');
        if (parry && !parry.dataset.wired) {
            parry.dataset.wired = "1";
            parry.addEventListener("click", () => applyStaggerFromButton());
        }
    });
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
    async defendWith(item, mode = "parry") {
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

        const flavor = defenseFlavor({
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
        }) + (block ? blockButtonHtml(item) : parryButtonHtml());

        const result = await extendedRoll(formula, {
            speaker: ChatMessage.getSpeaker({ actor: this }),
            flavor
        }, {});

        await this.recordDefense();
        return { ...result, formula, mode };
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
     *                so it posts a "Relocation — defense" card and counts
     *                against the defense economy.
     *
     * Rolls `1d10 + stat + skill` (no penalty) and records the defense
     * reaction (first free, each extra costs 1 STA). Returns the roll result,
     * or null if invalid / stunned.
     */
    async defendBySkill(skillKey, { label } = {}) {
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

        const result = await extendedRoll(formula, {
            speaker: ChatMessage.getSpeaker({ actor: this }),
            flavor
        }, {});

        await this.recordDefense();
        return { ...result, formula, mode: skillKey };
    }
};
