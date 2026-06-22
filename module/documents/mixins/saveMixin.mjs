/**
 * saveMixin — actor methods for stat saves and stun / death saves.
 *
 * Composed onto WitcherActor in documents/actor.mjs. Exposes:
 *   actor.rollStunSave()    — 1d10 under Stun (Core p.47)
 *   actor.rollDeathSave()   — 1d10 under unmodified Stun, at a cumulative
 *                             −1 per prior success; a single FAIL is death
 *                             (Core p.162)
 *
 * Both go through `extendedRoll(...)` so the exploding/imploding d10 chain
 * and chat card match every other roll in the system. RAW "roll under"
 * means strictly under: a roll equal to the target fails.
 */

import { extendedRoll } from "../../rolls/extendedRoll.mjs";

const esc = (s) => Handlebars.escapeExpression(String(s ?? ""));

/** Header for a save chat card — actor + title + a chip row. Mirrors the
 *  skill-roll header so the two read alike. */
function saveFlavor({ actorName, title, subtitle, chips = [] }) {
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

export const saveMixin = (Base) => class extends Base {

    /**
     * Prompt for a saving throw, then dispatch. With no `type` the dialog
     * offers a Stun/Death selector; with `type` fixed ("stun"/"death") it
     * only asks for the situational modifier. Shared by the dock's saving-
     * throw sign and the character / monster sheet's Stun & Death buttons.
     */
    async promptSave({ type = null } = {}) {
        const DialogV2 = foundry?.applications?.api?.DialogV2;
        if (!DialogV2) return;
        const stun      = Number(this.system?.derivedStats?.stun) || 0;
        const stunUnmod = Number(this.system?.derivedStats?.stunUnmodified
                              ?? this.system?.derivedStats?.stun) || 0;
        const successes = Number(this.system?.deathSaves) || 0;
        const deathTgt  = stunUnmod - successes;

        const typeField = type
            ? `<input type="hidden" name="type" value="${type}" />`
            : `<label style="display:flex;gap:10px;align-items:center;">
                 <span style="min-width:60px;">Type</span>
                 <select name="type" autofocus style="flex:1;">
                   <option value="stun">Stun Save (1d10 ≤ ${stun})</option>
                   <option value="death">Death Save (1d10 ≤ ${deathTgt}${successes ? ` — ${stunUnmod} −${successes}` : ""})</option>
                 </select>
               </label>`;
        const title = type === "stun" ? "Stun Save" : type === "death" ? "Death Save" : "Saving Throw";

        let chosen;
        try {
            chosen = await DialogV2.prompt({
                window: { title },
                modal: true,
                content: `<div style="padding:8px 0;display:flex;flex-direction:column;gap:10px;">
                    ${typeField}
                    <label style="display:flex;gap:10px;align-items:center;">
                      <span style="min-width:60px;">Modifier</span>
                      <input type="number" name="modifier" value="0" step="1" ${type ? "autofocus" : ""} style="flex:1;" />
                    </label>
                    <p style="margin:0;font-size:11px;opacity:0.7;">＋ makes the save easier, − harder (roll-under).</p>
                  </div>`,
                ok: { callback: (event, button) => ({
                    type:     button.form.elements.type.value,
                    modifier: Number(button.form.elements.modifier.value) || 0
                }) },
                rejectClose: true
            });
        } catch (e) { return; }                   // user cancelled
        if (!chosen) return;
        const modifier = chosen.modifier || 0;
        if (chosen.type === "stun")  return this.rollStunSave({ modifier });
        if (chosen.type === "death") return this.rollDeathSave({ modifier });
    }

    /**
     * Roll a Stun save (Core p.47): `1d10` with success STRICTLY UNDER the
     * actor's Stun value. An optional situational `modifier` shifts the
     * TARGET (＋ easier / − harder) to match the roll-under direction the
     * death save already uses. Passing CLEARS the `stunned` status.
     * Returns `{ pass, ... }`.
     */
    async rollStunSave({ modifier = 0 } = {}) {
        const stun      = Number(this.system.derivedStats?.stun) || 0;
        const mod       = Number(modifier) || 0;
        const threshold = stun + mod;
        const flavor = saveFlavor({
            actorName: this.name,
            title:     "Stun Save",
            chips: [
                { label: "Stun", value: stun },
                mod ? { label: "Modifier", value: mod > 0 ? `+${mod}` : String(mod) } : null,
                mod ? { label: "Target",   value: `< ${threshold}` } : null
            ].filter(Boolean)
        });
        const result = await extendedRoll("1d10", {
            speaker: ChatMessage.getSpeaker({ actor: this }),
            flavor
        }, {
            threshold, rollUnder: true,
            /* Flat d10 — no explode, no fumble. Roll-under save where
             * a nat 10 exploding is trivially a fail and a nat 1 is a
             * trivial pass; the fumble flag would be misleading. */
            flat: true,
            messageOnSuccess: "Stays standing",
            messageOnFailure: "Stunned"
        });
        const pass = result.total < threshold;
        // Pass ends the Stunned condition; fail inflicts (or keeps) it (Core p.47).
        // At 0 Stamina the character can't recover from being stunned, so even a
        // passed save leaves the Stunned status in place.
        const sta = Number(this.system.derivedStats?.sta?.value) || 0;
        const clears = pass && sta > 0;
        await this.toggleStatusEffect?.("stunned", { active: !clears });
        if (pass && !clears) {
            await ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor: this }),
                content: `<em>${esc(this.name)} passes the save but stays <strong>Stunned</strong> — no Stamina to recover (Core p.47).</em>`
            });
        }
        return { ...result, pass, stun, modifier: mod, threshold, sta, clears };
    }

    /**
     * Roll a Death save (Core p.162, homebrew survival rule) — a Stun save
     * made while dying. Houserule: each PRIOR success stacks a cumulative −1
     * onto the next save (`system.deathSaves` counts successes), and any
     * single FAIL kills the character outright (the "dead" status is applied).
     *
     * Death saves roll against UNMODIFIED stun (pre death/wound penalty) so
     * the death-state ×⅓ debuff doesn't also lower the survival save; the
     * accumulated success penalty is the only thing that erodes it.
     */
    async rollDeathSave({ modifier = 0 } = {}) {
        // Unbreakable death-save bank: an AE with `flags.<sys>.deathSaveAutoPasses`
        // (the Unbreakable boon stamps 3 of these on apply during combat)
        // auto-passes the save without rolling. The bank decrements on each
        // consume; AE deletes when the buffer hits 0. The success still
        // counts toward the cumulative −1 penalty so the actor isn't IMMORTAL
        // — once the bank's gone, the deepening penalty stays.
        const SYS = "witcher-ttrpg-death-march";
        const bankAE = this.effects?.find?.(e =>
            !e.disabled && Number(e.getFlag?.(SYS, "deathSaveAutoPasses")) > 0
        );
        if (bankAE) {
            const remaining = Number(bankAE.getFlag(SYS, "deathSaveAutoPasses")) || 0;
            const next = remaining - 1;
            if (next <= 0) await bankAE.delete();
            else await bankAE.setFlag(SYS, "deathSaveAutoPasses", next);
            const successes = Number(this.system.deathSaves) || 0;
            const advanced  = successes + 1;
            await this.update({ "system.deathSaves": advanced });
            await ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor: this }),
                content: `<em>${esc(this.name)} — death save auto-passed (Unbreakable, ${next} left).</em>`
            });
            return { pass: true, deathSaves: advanced, dead: false, autoPassed: true };
        }

        const stun      = Number(this.system.derivedStats?.stunUnmodified
                              ?? this.system.derivedStats?.stun) || 0;
        const successes = Number(this.system.deathSaves) || 0;
        const mod       = Number(modifier) || 0;
        const threshold = stun - successes + mod;
        const flavor = saveFlavor({
            actorName: this.name,
            title:     "Death Save",
            subtitle:  "Dying — Core p.162",
            chips: [
                { label: "Stun (unmod)", value: stun },
                { label: "Penalty", value: successes ? `−${successes}` : "0" },
                mod ? { label: "Modifier", value: mod > 0 ? `+${mod}` : String(mod) } : null,
                { label: "Target", value: `< ${threshold}` }
            ].filter(Boolean)
        });
        const result = await extendedRoll("1d10", {
            speaker: ChatMessage.getSpeaker({ actor: this }),
            flavor
        }, {
            threshold, rollUnder: true,
            /* Flat d10 — no explode, no fumble (see Stun save above). */
            flat: true,
            messageOnSuccess: "Holds on",
            messageOnFailure: "Death save failed — death"
        });
        const pass = result.total < threshold;
        if (pass) {
            // Each success deepens the hole: −1 to every subsequent save.
            const next = successes + 1;
            await this.update({ "system.deathSaves": next });
            return { ...result, pass, deathSaves: next, dead: false };
        }
        // A single failure is fatal.
        await this.toggleStatusEffect?.("dead", { active: true });
        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor: this }),
            content: `<em>${esc(this.name)} fails a death save — <strong>death (Core p.162).</strong></em>`
        });
        return { ...result, pass, deathSaves: successes, dead: true };
    }
};
