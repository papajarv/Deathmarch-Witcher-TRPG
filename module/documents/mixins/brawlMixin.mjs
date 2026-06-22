/**
 * brawlMixin — actor method for unarmed / brawling combat.
 *
 * Composed onto WitcherActor (documents/actor.mjs). Exposes:
 *   actor.brawlAttack(options)   — open the brawl dialog and resolve the action
 *
 * Fired by the combat dock's Brawl button. Covers the full Fist-Fighting +
 * grappling list (Core p.159-160): punch / kick (with strong/fast strikes and
 * called shots), push kick, charge, disarm, and the grapple chain
 * (grapple / pin / choke / throw / trip). Block is the defensive use — it rolls
 * Brawling as a defense and records a defensive action.
 *
 * Brawling rolls REF + Brawling to hit and deals NON-LETHAL damage from the
 * actor's derived Punch/Kick formula. Grapple riders are LIGHT-mechanized: the
 * roll is posted, the relevant status (grappled/pinned/prone/suffocation) is
 * applied to the user's target where possible, and the opposed Dodge/Escape
 * contest is left to the GM (described on the card).
 *
 * Returns { declaration, kind } so the dock can route the action economy
 * (attacks spend an action slot; a block records a defense), or null on cancel.
 */

import { extendedRoll } from "../../rolls/extendedRoll.mjs";
import { openBrawlDialog } from "../../applications/brawlDialog.mjs";
import { ATTACK_LOCATIONS, rollHitLocation } from "../../setup/config.mjs";

const esc    = (s) => Handlebars.escapeExpression(String(s ?? ""));
const signed = (n) => `${n >= 0 ? "+" : ""}${n}`;
const L      = (k) => game.i18n.localize(k);

/** Localize a stat label, falling back to the upper-cased key. */
function statName(statKey) {
    const key = String(statKey ?? "").toLowerCase();
    const out = game.i18n.localize(CONFIG.WITCHER.statLabel(key));
    return (!out || out.startsWith("WITCHER.")) ? key.toUpperCase() : out;
}

/** Build the unarmed damage display + rollable formula from the actor's derived
 *  Punch/Kick. Honours the strike multiplier (strong ×2) and the half-damage
 *  push kick. Returns empty strings for actions that deal no damage. */
function brawlDamage(actor, meta, strikeMeta) {
    if (!meta.damage) return { display: "", formula: "" };
    const ds = actor.system?.derivedStats ?? {};
    const base = meta.damage === "kick" ? ds.kick : ds.punch;
    if (!base) return { display: "", formula: "" };
    if (meta.half) return { display: `½ (${base})`, formula: `floor((${base})/2)` };
    const mult = strikeMeta?.dmgMult ?? 1;
    if (mult !== 1) return { display: `${base} ×${mult}`, formula: `(${base})*${mult}` };
    return { display: base, formula: base };
}

/** Apply a status to every token the user currently targets. Returns the names
 *  it landed on and how many targets there were, so the card can describe it. */
async function applyStatusToTargets(statusId) {
    const targets = [...(game.user?.targets ?? [])];
    if (!statusId) return { applied: [], targets: targets.length };
    const applied = [];
    for (const t of targets) {
        const a = t.actor;
        if (!a) continue;
        try { await a.toggleStatusEffect(statusId, { active: true }); applied.push(a.name); }
        catch (err) { console.warn("witcher-ttrpg-death-march | brawl status apply failed", err); }
    }
    return { applied, targets: targets.length };
}

/** The brawl chat-card header — actor + action, a chip row, optional damage
 *  line (with the wdm-roll-damage button the global handler wires) and a note. */
function brawlFlavor({ actorName, actionName, subtitle, chips = [], damage, note = "" }) {
    const chipHtml = chips
        .filter(c => c && c.value != null && c.value !== "")
        .map(c => `<span class="wdm-chip"><span class="wdm-chip-k">${esc(c.label)}</span><span class="wdm-chip-v">${esc(c.value)}</span></span>`)
        .join("");
    const locMult = Number(damage?.locMult) || 1;
    const locNote = (damage?.display && locMult !== 1)
        ? `<div class="wdm-attack-damage-note">${esc(L("WITCHER.Attack.SubtractSP"))} ×${esc(locMult)}${damage.locLabel ? ` (${esc(damage.locLabel)})` : ""}</div>`
        : "";
    const damageHtml = damage?.display ? `
        <div class="wdm-attack-damage">
            <span class="wdm-attack-damage-k">${esc(L("WITCHER.Attack.Damage"))}</span>
            <span class="wdm-attack-damage-v">${esc(damage.display)}</span>
            ${damage.formula ? `<button type="button" class="wdm-attack-damage-roll" data-action="wdm-roll-damage" data-formula="${esc(damage.formula)}" data-types="${esc(damage.types ?? "")}" data-loc-mult="${esc(locMult)}" data-loc-label="${esc(damage.locLabel ?? "")}"><i class="fa-solid fa-burst"></i> ${esc(L("WITCHER.Attack.RollDamage"))}</button>` : ""}
        </div>${locNote}` : "";
    const noteHtml = note
        ? `<div class="wdm-attack-note"><i class="fa-solid fa-circle-info"></i> ${note}</div>`
        : "";
    return `
        <div class="wdm-skill-head wdm-attack-head">
            <div class="wdm-skill-actor">${esc(actorName)}</div>
            <div class="wdm-skill-name">${esc(actionName)}</div>
            ${subtitle ? `<div class="wdm-skill-sub">${esc(subtitle)}</div>` : ""}
            ${chipHtml ? `<div class="wdm-skill-chips">${chipHtml}</div>` : ""}
            ${damageHtml}
            ${noteHtml}
        </div>`;
}

export const brawlMixin = (Base) => class extends Base {

    /**
     * Open the brawl dialog and resolve the chosen unarmed action.
     * @param {object} options  reserved for future callers
     * @returns {Promise<{declaration:object, kind:string}|null>}
     */
    async brawlAttack(options = {}) {
        const sv = this._readSkillValues("brawling");
        if (!sv) return null;
        const baseChips = [
            { label: statName(sv.meta.statKey), value: sv.statVal },
            { label: "Rank", value: sv.skillVal },
            sv.skillMod ? { label: "Mod", value: signed(sv.skillMod) } : null
        ].filter(Boolean);

        const decl = await openBrawlDialog(this, { base: { total: sv.total, chips: baseChips } });
        if (!decl) return null;

        const meta = decl.actionMeta;
        const speaker = ChatMessage.getSpeaker({ actor: this });

        // Block — a defensive Brawling roll. No damage, no target status; the
        // dock records the defensive action.
        if (meta.kind === "defense") {
            await this.rollSkill("brawling");
            return { declaration: decl, kind: "defense" };
        }

        // Resolve the hit location for a damaging strike. Random shots roll now
        // (penalty already 0); called shots carried their penalty in modTotal and
        // only contribute the damage multiplier (subtracted after SP).
        let loc = decl.location;
        if (loc.mode === "random") {
            const { loc: key, face } = await rollHitLocation(loc.kind);
            const def = ATTACK_LOCATIONS[key];
            loc = { mode: "random", kind: loc.kind, key, face, penalty: 0, mult: def?.mult ?? 1,
                    label: L(def?.labelKey ?? key) };
        }
        const locMult  = loc.mult ?? 1;
        const locLabel = loc.mode === "random" ? `${loc.label} (d10: ${loc.face})`
                       : loc.mode === "specific" ? loc.label : "";

        // Grapple-chain prerequisite check — pin/choke/throw require the
        // target to already be Grappled (RAW Core p.160).  When the target
        // isn't grappled, we still apply the status (GM call) but flag it
        // in the note so the table catches the violation.
        const grappleTargets = [...(game.user?.targets ?? [])].map(t => t.actor).filter(Boolean);
        const grappleViolations = (meta.needsGrapple
            ? grappleTargets.filter(a => !a.statuses?.has?.("grappled"))
            : []).map(a => a.name);

        // Apply the rider status to the user's target(s), then build the note:
        // the action's RAW text plus what actually happened to the target.
        const status = await applyStatusToTargets(meta.status);
        const noteParts = [];
        if (meta.note) noteParts.push(esc(L(meta.note)));
        if (meta.status) {
            const statusDef = (CONFIG.statusEffects ?? []).find(s => s.id === meta.status);
            const statusLabel = statusDef?.name ? L(statusDef.name) : meta.status;
            if (status.applied.length) noteParts.push(esc(L("WITCHER.Brawl.StatusApplied").replace("{status}", statusLabel).replace("{targets}", status.applied.join(", "))));
            else noteParts.push(esc(L("WITCHER.Brawl.StatusManual").replace("{status}", statusLabel)));
        }
        // Push Kick distance (RAW p.159): body/3 meters of knockback, surfaced
        // as a note line so the GM moves the token. Floor to whole metres.
        if (meta.pushBackFormula === "body/3") {
            const body = Number(this.system?.stats?.body?.value) || 0;
            const push = Math.floor(body / 3);
            if (push > 0) noteParts.push(esc(`Push back ${push}m on a successful kick.`));
        }
        // Grapple-chain prerequisite violation note (Pin/Choke/Throw vs an
        // un-grappled target — RAW says these require an existing grapple).
        if (grappleViolations.length) {
            noteParts.push(`<strong style="color:#b97;">⚠ Target not Grappled — RAW requires a prior grapple (${esc(grappleViolations.join(", "))}).</strong>`);
        }
        const note = noteParts.join("<br>");

        const damage = brawlDamage(this, meta, decl.strikeMeta);
        const types  = meta.damage ? L("WITCHER.Brawl.NonLethal") : "";
        const subtitle = [L("WITCHER.skills.brawling.label"), types].filter(Boolean).join(" · ");

        const attacks = Math.max(1, decl.strikeMeta?.attacks ?? 1);
        let result = null;
        for (let i = 0; i < attacks; i++) {
            const shotChips = [
                ...baseChips,
                ...decl.chips.map(c => ({ label: c.label, value: signed(c.value) })),
                loc.mode !== "none" ? { label: L("WITCHER.Attack.Location"), value: locLabel } : null
            ].filter(Boolean);
            // Damage rides the first shot only (a fast punch/kick rolls twice).
            const shotDamage = i === 0 ? damage : { display: "", formula: "" };
            const actionName = attacks > 1 ? `${L(meta.labelKey)} (${i + 1}/${attacks})` : L(meta.labelKey);
            const flavor = brawlFlavor({
                actorName: this.name, actionName, subtitle, chips: shotChips,
                damage: { ...shotDamage, types, locMult, locLabel: loc.label },
                note: i === 0 ? note : ""
            });
            result = await extendedRoll(decl.grandMod ? `1d10 + ${decl.grandMod}` : `1d10`,
                { speaker, flavor, flags: { "witcher-ttrpg-death-march": { category: "combat" } } }, {});
        }

        // RAW Throw (Core p.160): on a successful throw, target makes a
        // Stun save at −1. We trigger the prompt on each currently-targeted
        // actor — the same rollStunSave used everywhere else (auto-applies
        // Stunned on fail, clears on pass).
        if (meta.triggerStunSave?.mod != null && grappleTargets.length) {
            for (const a of grappleTargets) {
                if (typeof a.rollStunSave !== "function") continue;
                try { await a.rollStunSave({ modifier: meta.triggerStunSave.mod }); }
                catch (err) { console.warn("witcher-ttrpg-death-march | throw stun save failed", err); }
            }
        }

        return { declaration: decl, kind: meta.kind };
    }
};
