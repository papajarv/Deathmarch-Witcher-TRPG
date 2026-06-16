/**
 * statusEngine — the interpreter over `setup/statusClauses.mjs`.
 *
 * Every mechanical consequence of a status effect is read THROUGH this module:
 * the rest of the system never hard-codes a status id. That keeps the clause
 * registry the single editable source of truth — retuning a condition is a
 * data edit, not a code hunt.
 *
 * Responsibilities:
 *   - statusChanges(id)        AE changes[] a status carries (stat debuffs)
 *   - rollMods / *Mod(actor)   roll modifiers summed over active statuses
 *   - cannotAct / cannotDefend hard action / defense locks
 *   - incomingAttackDC(actor)  auto-hit floor against a helpless target
 *   - runTurnStartMutations    GM-side: auto-clears + periodic saves
 *   - promptStatusEndChecks    owner-side: auto-prompt the ending checks
 *
 * DoT is NOT here — it lives with the damage machinery in
 * `chrome/policy/tick-effects.js`, which already resolves armor SP and hit-
 * location multipliers. That engine reads the same clause registry.
 */

import { getActiveClauses } from "./statusOverrides.mjs";
// NOTE: `stress.mjs` is intentionally NOT imported at the top of this module.
// stress.mjs → api/homebrew.mjs → setup/config.mjs → setup/statusEffects.mjs
// → setup/statusOverrides.mjs and back here, forming a cycle that re-enters
// statusEffects.mjs mid-evaluation. When statusEffects.mjs then runs its
// top-level `PURE_RAW_PRESENTATION.map(finishStatusEntry)`, finishStatusEntry
// calls statusChanges() → `change(...)`, but the `change` const below has not
// yet been initialized in this module's evaluation pass, throwing a TDZ
// ReferenceError that hard-aborts boot. `grantStress` is only ever needed at
// hook-fire time (well after every module has finished initializing), so we
// dynamic-import it inside the handler instead.

const SYSTEM_ID = "witcher-ttrpg-death-march";

const esc = (s) => Handlebars.escapeExpression(String(s ?? ""));

/** Resolve a status id to its clause, read THROUGH the runtime override layer
 *  (RAW defaults + the GM's edits). Numeric-suffixed ids (legacy `bleed-3`)
 *  fall back to the family stem so stale tokens still read sensibly. */
export function clauseFor(id) {
    if (!id) return null;
    const clauses = getActiveClauses();
    return clauses[id] ?? clauses[String(id).replace(/-\d+$/, "")] ?? null;
}

/** A status id's RAW (or overridden) description, with the same family
 *  fallback `clauseFor` applies. "" when the status carries no clause.
 *
 *  When the `stress` homebrew is enabled, the clause's `stressNote` (if any)
 *  is appended — keeps the player-facing copy aligned with the mechanic, so a
 *  pure-stress-off world reads no mention of stress on a drunk / hunger /
 *  gorged tile even though the schema still carries the field.
 *
 *  Note: we MUST read `game.settings` directly here, not `game.system.api`.
 *  `game.system.api` is wired in the `ready` hook, but this function runs at
 *  `init` time (buildStatusEffects bakes descriptions into CONFIG.statusEffects
 *  during init, BEFORE ready) — relying on the api there silently dropped the
 *  stressNote even when the toggle was on. settings.get is safe at init
 *  because registerSettings runs first in the init sequence. */
export function descriptionFor(id) {
    const c = clauseFor(id);
    if (!c) return "";
    const base = c.description ?? "";
    if (!c.stressNote) return base;
    let stressOn = false;
    try { stressOn = !!game.settings?.get?.(SYSTEM_ID, "homebrew.stress"); }
    catch { /* settings not yet registered — treat as off */ }
    return stressOn ? base + c.stressNote : base;
}

/* The AE change shape this system's effect data model understands
 * (key/value/type/phase — NOT Foundry's native mode/priority pair). */
const change = (key, value) =>
    ({ key, value: String(value), type: "add", phase: "initial", priority: 0 });

/**
 * Build the ActiveEffect changes[] for a status's stat / skill clauses. Stat
 * debuffs target the UNBOUNDED `.modifier` field (folded into the prepared
 * value by prepareDerivedData) so a −3 SPD can cross the 1-10 source clamp
 * instead of being silently floored. Skill debuffs target each skill's own
 * `.modifier` field (one AE change per affected skill). Returns [] for
 * statuses with no stat or skill clause.
 *
 * NOT included: derived-stat aggregates (`mods.derived.*`) — those are read
 * live during prepareDerivedData via `derivedMods()` so they recompute every
 * prepare cycle from current active statuses, not from a baked-in AE change.
 */
export function statusChanges(id) {
    const out = [];
    const stats = clauseFor(id)?.mods?.stats;
    if (stats) {
        for (const [k, n] of Object.entries(stats)) {
            if (Number(n)) out.push(change(`system.stats.${k}.modifier`, Number(n)));
        }
    }
    const skills = clauseFor(id)?.mods?.skills;
    if (skills) {
        for (const [statKey, group] of Object.entries(skills)) {
            if (!group || typeof group !== "object") continue;
            for (const [skillKey, n] of Object.entries(group)) {
                if (Number(n)) out.push(change(`system.skills.${statKey}.${skillKey}.modifier`, Number(n)));
            }
        }
    }
    return out;
}

/**
 * Sum the `mods.derived.*` numbers across every active status on `actor`.
 * Read live by CharacterData.prepareDerivedData (and any other derive-time
 * consumer) so a GM tuning a clause in the editor flows in without an AE
 * reapply.
 *
 *   staMaxFraction  multiplicative cut applied to sta.max (negative shrinks).
 *                   Floors at -1 so max never goes below 0.
 *   recBonus        flat REC add. No clamp here — the consumer floors at 0.
 */
export function derivedMods(actor) {
    const out = { staMaxFraction: 0, recBonus: 0 };
    if (!actor?.statuses) return out;
    for (const id of actor.statuses) {
        const d = clauseFor(id)?.mods?.derived;
        if (!d) continue;
        if (typeof d.staMaxFraction === "number") out.staMaxFraction += d.staMaxFraction;
        if (typeof d.recBonus === "number")        out.recBonus       += d.recBonus;
    }
    out.staMaxFraction = Math.max(-1, out.staMaxFraction);
    return out;
}

/**
 * Sum every active status's roll modifiers for `actor` into bucket totals.
 * Callers fold the buckets they care about into their own roll.
 */
export function rollMods(actor) {
    const out = { attack: 0, defense: 0, awareness: 0, all: 0, verbal: 0 };
    for (const id of (actor?.statuses ?? [])) {
        const roll = clauseFor(id)?.mods?.roll;
        if (!roll) continue;
        for (const k of Object.keys(out)) {
            if (typeof roll[k] === "number") out[k] += roll[k];
        }
    }
    return out;
}

/** Net to-hit modifier from statuses (status attack penalties + all-rolls). */
export function attackMod(actor) {
    const m = rollMods(actor);
    return m.attack + m.all;
}

/** Net defense modifier from statuses. */
export function defenseMod(actor) {
    const m = rollMods(actor);
    return m.defense + m.all;
}

/** Net modifier for a skill check. Awareness also takes the sight penalty. */
export function skillMod(actor, skillKey) {
    const m = rollMods(actor);
    return m.all + (skillKey === "awareness" ? m.awareness : 0);
}

/** True if any active status forbids taking actions (Stunned / Paralyzed /
 *  Unconscious). STA-depletion stun is handled separately by
 *  combatRoundMixin._stunned; this covers status-flagged restrictions. */
export function cannotAct(actor) {
    for (const id of (actor?.statuses ?? [])) {
        if (clauseFor(id)?.restrict?.act) return true;
    }
    return false;
}

/** True if any active status forbids defending. */
export function cannotDefend(actor) {
    for (const id of (actor?.statuses ?? [])) {
        if (clauseFor(id)?.restrict?.defend) return true;
    }
    return false;
}

/** True if any active status is a HARD lock that forbids even the Recovery
 *  full-round action (Paralyzed / Unconscious). Plain Stunned is NOT hard —
 *  the STA-recovery house rule lets a stunned fighter still catch their breath
 *  (combatRoundMixin). */
export function cannotRecover(actor) {
    for (const id of (actor?.statuses ?? [])) {
        if (clauseFor(id)?.restrict?.hard) return true;
    }
    return false;
}

/** Every status that can be cleared by a no-roll self-action (clause field
 *  `selfClear`), in registry order: `{ id, label, actionCost, icon, statusName }`.
 *  The combat dock lists these in its Action menu and greys an entry unless the
 *  bearer currently has the status. Read THROUGH the override layer so a GM
 *  rename/retune shows up. */
export function selfClearOptions() {
    const clauses = getActiveClauses();
    const out = [];
    for (const [id, c] of Object.entries(clauses)) {
        const sc = c?.selfClear;
        if (!sc) continue;
        out.push({
            id,
            label: sc.label || `Clear ${statusLabel(id)}`,
            actionCost: Number(sc.actionCost) || 0,
            icon: sc.icon || "fa-arrow-up",
            statusName: statusLabel(id)
        });
    }
    return out;
}

/** Every status whose end-check is player-triggered from the dock Action menu
 *  (clause `endCheck.viaAction`), in registry order:
 *  `{ id, label, icon, skill, dc, onPass, actionCost, statusName }`. The dock
 *  lists these as roll-actions (greyed unless the bearer has the status). */
export function actionEndCheckOptions() {
    const clauses = getActiveClauses();
    const out = [];
    for (const [id, c] of Object.entries(clauses)) {
        const ec = c?.endCheck;
        if (!ec || !ec.viaAction || ec.kind !== "skill") continue;
        out.push({
            id,
            label: ec.label || `End ${statusLabel(id)}`,
            icon: ec.icon || "fa-dice-d10",
            skill: ec.skill, dc: Number(ec.dc) || 0, onPass: ec.onPass,
            actionCost: Number(ec.actionCost) || 0,
            statusName: statusLabel(id)
        });
    }
    return out;
}

/** Run a viaAction end-check (the action-slot spend is the caller's job): roll
 *  the clause's skill check, and on a pass either purge the last potion
 *  (onPass:"endLastPotion") or clear the status. Repeatable — no per-round cap. */
export async function performActionEndCheck(actor, id) {
    const ec = clauseFor(id)?.endCheck;
    if (!actor || !ec || ec.kind !== "skill") return;

    const name = statusLabel(id);
    const res = await actor.rollSkillCheck?.(ec.skill, ec.dc);
    const passed = res && typeof res.total === "number" && res.total >= ec.dc;
    if (passed && ec.onPass === "endLastPotion") {
        const ended = await actor.endLastConsumedPotion?.();
        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            content: ended
                ? `<em>${esc(actor.name)} forces out the last potion they drank${ended.name ? ` (<strong>${esc(ended.name)}</strong>)` : ""}.</em>`
                : `<em>${esc(actor.name)} steadies against the toxicity.</em>`
        });
    } else if (passed) {
        try { await actor.toggleStatusEffect?.(id, { active: false }); }
        catch (err) { console.warn("witcher-ttrpg-death-march | action end-check clear failed", err); }
        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            content: `<em>${esc(actor.name)} shakes off <strong>${esc(name)}</strong>.</em>`
        });
    }
}

/** The set of status ids `actor` is immune to, unioning two sources:
 *  (a) a monster's GM-set `system.combat.statusImmunities[]`; and
 *  (b) every active effect carrying an `immunity` action (AE editor) — e.g.
 *      Golden Oriole → poisoned. Read THROUGH here so the application gate and
 *      the on-grant cure share one definition. */
export function statusImmunities(actor) {
    const out = new Set();
    if (!actor) return out;
    for (const id of (actor.system?.combat?.statusImmunities ?? [])) {
        if (id) out.add(String(id));
    }
    for (const e of (actor.allApplicableEffects?.() ?? [])) {
        if (e.disabled || e.system?.isSuppressed) continue;
        const actions = e.flags?.[SYSTEM_ID]?.actions;
        if (!Array.isArray(actions)) continue;
        for (const a of actions) {
            if (a?.type === "immunity" && a.status) out.add(String(a.status));
        }
    }
    return out;
}

/** True if `actor` is immune to the status `id` (from either source above). */
export function isImmuneToStatus(actor, id) {
    return !!actor && !!id && statusImmunities(actor).has(String(id));
}

/** Lowest auto-hit DC among the target's helpless statuses, or null — an
 *  attacker only needs to beat this to land a blow (Core p.161). */
export function incomingAttackDC(actor) {
    let dc = null;
    for (const id of (actor?.statuses ?? [])) {
        const v = clauseFor(id)?.incomingDC;
        if (typeof v === "number") dc = dc == null ? v : Math.min(dc, v);
    }
    return dc;
}

/* Localized display label for a status id, from the registered effect. */
function statusLabel(id) {
    const def = (CONFIG.statusEffects ?? []).find(s => s.id === id);
    if (def?.label) return def.label;
    if (def?.name) return game.i18n.localize(def.name);
    return id;
}

/* Localized skill name for an end-check prompt. */
function skillDisplay(key) {
    const label = CONFIG.WITCHER?.skillLabel?.(key);
    return label ? game.i18n.localize(label) : key;
}

/**
 * GM-side, run once at the bearer's turn start (from the tick engine, which is
 * already deduped per round): auto-clear expiring statuses and roll any
 * periodic saves. State mutations only — no dialogs.
 */
export async function runTurnStartMutations(actor) {
    if (!actor) return;
    // 1. Auto-clear statuses that lapse at the bearer's own turn start.
    for (const id of [...(actor.statuses ?? [])]) {
        if (clauseFor(id)?.clearsAt === "ownTurnStart") {
            try { await actor.toggleStatusEffect?.(id, { active: false }); }
            catch (err) { console.warn("witcher-ttrpg-death-march | status auto-clear failed", err); }
        }
    }
    // 2. Periodic saves (e.g. Nausea every 3 rounds).
    const round = Number(game.combat?.round) || 0;
    if (round > 0) {
        for (const id of [...(actor.statuses ?? [])]) {
            const p = clauseFor(id)?.periodic;
            if (!p) continue;
            const every = Math.max(1, Number(p.everyRounds) || 1);
            if (round % every !== 0) continue;
            await rollPeriodic(actor, id, p);
        }
    }
}

/* Roll a periodic "under-stat" check and report it. Informational — it posts
 * the outcome (resisted / loses the round) but does not forcibly consume the
 * turn, since the bearer may still want to react defensively. */
async function rollPeriodic(actor, id, p) {
    const statKey = String(p.rollUnder || "body");
    const target  = Number(actor.system?.stats?.[statKey]?.value) || 0;
    const roll    = await new Roll("1d10").evaluate();
    const passed  = roll.total < target;       // strict roll-under
    const verdict = passed ? "resisted" : "spends the round retching";
    await roll.toMessage({
        speaker: ChatMessage.getSpeaker({ actor }),
        flavor: `${esc(statusLabel(id))} — roll under ${statKey.toUpperCase()} (${target}): ${verdict}`
    });
}

/**
 * Owner-side, run at the bearer's turn start: auto-prompt the check that can
 * END each active status (Stun save, DC 15 Endurance, DC 16 Physique, …).
 * Sequential modal prompts; declining leaves the status in place. The caller
 * gates WHO prompts (the controlling player, else the GM) and dedupes per
 * round — see policy/combat-round-reset.mjs.
 */
export async function promptStatusEndChecks(actor) {
    if (!actor) return;
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2) return;
    for (const id of [...(actor.statuses ?? [])]) {
        const ec = clauseFor(id)?.endCheck;
        if (!ec) continue;
        // viaAction checks are player-triggered from the dock Action menu, never
        // auto-prompted at turn start (Overdosed purge).
        if (ec.viaAction) continue;
        // Statuses sourced ONLY from critical wounds are not cleared by their
        // own end-check (e.g. First Aid on bleed) — only treating/stabilizing
        // the wound lifts them (policy/wound-statuses.mjs). Don't prompt for
        // those; a mixed case (a wound bleed AND an independent bleed) still
        // prompts, and the reconciler re-asserts the wound instance after.
        const carriers = (actor.appliedEffects ?? actor.effects ?? [])
            .filter(e => e.statuses?.has?.(id) && !e.disabled && !e.system?.isSuppressed);
        if (carriers.length && carriers.every(e => e.flags?.[SYSTEM_ID]?.woundStatus)) continue;
        const name = statusLabel(id);

        if (ec.kind === "stunSave") {
            const ok = await confirm(DialogV2, name, `Make a Stun save to shake off ${name}?`);
            if (ok) await actor.rollStunSave?.();        // clears on pass itself
            continue;
        }

        if (ec.kind === "skill") {
            const label = skillDisplay(ec.skill);
            // RAW action cost (statusClauses → endCheck.actionCost), charged only
            // to actors that model the per-round action budget (characters; not
            // monsters) and only in combat, where the economy is live — out of
            // combat spendActionSlot is a free no-op so the check is always open.
            const costs = (Number(ec.actionCost) || 0) > 0 && !!actor.system?.combatRound;
            if (costs && actor._inActiveCombat && !actor.hasActionSlot) {
                ui?.notifications?.info?.(
                    `${actor.name}: no action left this turn to attempt the ${label} check on ${name}.`
                );
                continue;
            }
            const costNote = costs ? " (costs 1 action)" : "";
            const ok = await confirm(DialogV2, name, `Make a DC ${ec.dc} ${label} check to end ${name}?${costNote}`);
            if (!ok) continue;
            if (costs) await actor.spendActionSlot?.(`End ${name}`);
            const res = await actor.rollSkillCheck?.(ec.skill, ec.dc);
            const passed = res && typeof res.total === "number" && res.total >= ec.dc;
            if (passed && ec.onPass === "endLastPotion") {
                // Overdosed (Core p.248): the check purges the LAST potion drunk
                // rather than clearing the status directly — the toxicity
                // reconciler then lifts Overdosed only if you're back under cap.
                const ended = await actor.endLastConsumedPotion?.();
                await ChatMessage.create({
                    speaker: ChatMessage.getSpeaker({ actor }),
                    content: ended
                        ? `<em>${esc(actor.name)} forces out the last potion they drank${ended.name ? ` (<strong>${esc(ended.name)}</strong>)` : ""}.</em>`
                        : `<em>${esc(actor.name)} steadies against the toxicity.</em>`
                });
            } else if (passed) {
                try { await actor.toggleStatusEffect?.(id, { active: false }); }
                catch (err) { console.warn("witcher-ttrpg-death-march | end-check clear failed", err); }
                await ChatMessage.create({
                    speaker: ChatMessage.getSpeaker({ actor }),
                    content: `<em>${esc(actor.name)} shakes off <strong>${esc(name)}</strong>.</em>`
                });
            }
        }
    }
}

/**
 * Hook handler for `createActiveEffect`. If the new effect carries any status
 * whose clause has an `onApply.stress` delta, apply the sum to the bearer's
 * stress in one shot. Active-GM-only so multi-client sessions don't double up.
 *
 * NOT idempotent across reapplies of the SAME status: by design, every fresh
 * AE counts as a fresh apply. Crossing into Hungry, sating, then crossing back
 * into Hungry pays the +1 stress again — which is what the spec wants.
 *
 * Wired in setup/hooks.mjs.
 */
export async function onCreateActiveEffectStatus(effect, options /*, userId */) {
    try {
        if (!game.user?.isActiveGM) return;
        // Callers that own DIRECTIONAL semantics (sobering through a relief
        // tier; eating back across a stress-on-entry tier) pass
        // `wdmSkipOnApply: true` in createEmbeddedDocuments options to opt this
        // AE out — the one-shot was intended for ascending the ladder only.
        if (options?.wdmSkipOnApply) return;
        const actor = effect?.parent;
        if (!actor || actor.documentName !== "Actor") return;
        // Stress lives on characters only — monsters don't carry the schema
        // field. A relief delta on a monster would silently fail; a gain delta
        // would write a stray field. Cheaper to bail.
        if (actor.type !== "character") return;
        // If the stress homebrew is off, onApply.stress is a no-op even though
        // the clause field is present. The player-facing description likewise
        // hides its `stressNote` (see descriptionFor) so flavor and mechanic
        // stay aligned in a pure-stress-off world. Read settings directly so
        // a hook fired before `ready` (where game.system.api is wired) still
        // gets the right answer.
        let stressOn = false;
        try { stressOn = !!game.settings?.get?.(SYSTEM_ID, "homebrew.stress"); }
        catch { /* settings not yet registered */ }
        if (!stressOn) return;
        const statuses = effect.statuses;
        if (!statuses?.size) return;

        let stressDelta = 0;
        for (const id of statuses) {
            const oa = clauseFor(id)?.onApply;
            if (!oa) continue;
            if (typeof oa.stress === "number") stressDelta += oa.stress;
        }
        if (stressDelta !== 0) {
            const { grantStress } = await import("./stress.mjs");
            await grantStress(actor, stressDelta);
        }
    } catch (err) {
        console.warn("witcher-ttrpg-death-march | onCreateActiveEffect onApply failed", err);
    }
}

/* DialogV2.confirm wrapper — resolves false on cancel/close instead of throwing. */
async function confirm(DialogV2, title, question) {
    try {
        return await DialogV2.confirm({
            window: { title: `End ${title}?` },
            content: `<p style="margin:6px 0;">${esc(question)}</p>`,
            modal: true,
            rejectClose: false
        });
    } catch (_) { return false; }
}
