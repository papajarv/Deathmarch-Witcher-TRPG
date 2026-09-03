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
import { t, tFormat } from "../chrome/lib/i18n.js";
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

/** Remove a status from an actor. Handles BOTH registered CONFIG.statusEffects
 *  ids (via the built-in `toggleStatusEffect`) AND custom-status ids that only
 *  exist on an AE's `statuses` set (via direct AE delete/edit). The built-in
 *  throws "Invalid status ID" when called with an unregistered id, so a plain
 *  `try { toggleStatusEffect(id, {active:false}) } catch` swallows the error
 *  and the status never clears — the fallback below is the fix.
 *
 *  Behavior:
 *    - If the id is a registered CONFIG.statusEffects id → use toggleStatusEffect
 *      (delegates cleanup to Foundry, preserves the "single-status carrier"
 *      semantic Foundry documents).
 *    - Otherwise, find every AE on the actor whose `statuses` contains the id.
 *      If the AE carries ONLY this status, delete the whole AE. If it carries
 *      multiple statuses, remove just this id from the set.
 *  Failures log but don't throw so callers can loop without unwinding. */
export async function clearStatusFromActor(actor, id) {
    if (!actor || !id) return;
    const registered = (CONFIG.statusEffects ?? []).some(s => s?.id === id);
    if (registered) {
        try { await actor.toggleStatusEffect?.(id, { active: false }); }
        catch (err) { console.warn(`${SYSTEM_ID} | toggleStatusEffect(${id}) failed`, err); }
        return;
    }
    const carriers = (actor.appliedEffects ?? actor.effects?.contents ?? [])
        .filter(e => e.statuses?.has?.(id));
    for (const e of carriers) {
        try {
            if (e.statuses.size <= 1) await e.delete();
            else await e.update({ statuses: [...e.statuses].filter(s => s !== id) });
        } catch (err) { console.warn(`${SYSTEM_ID} | clearStatusFromActor(${id}) failed`, err); }
    }
}

/** Resolve a status id to its clause, read THROUGH the runtime override layer
 *  (RAW defaults + the GM's edits). Numeric-suffixed ids (legacy `bleed-3`)
 *  fall back to the family stem so stale tokens still read sensibly.
 *
 *  When `actor` is provided, ANY active AE on that actor carrying a
 *  `flags[SYSTEM_ID].customStatus.enabled === true` clause whose `id`
 *  matches wins over the world registry — item-local status semantics
 *  (a poison-oil AE authoring its own "poisoned" clause on the target
 *  supersedes the RAW poisoned clause for that actor only). Multiple
 *  matching AEs: first found wins (Foundry's iteration order is stable). */
export function clauseFor(id, actor = null) {
    if (!id) return null;
    if (actor) {
        try {
            for (const e of actor.appliedEffects ?? []) {
                if (e?.disabled) continue;
                const cs = e.flags?.[SYSTEM_ID]?.customStatus;
                if (!cs?.enabled) continue;
                if (String(cs.id ?? "").trim() !== String(id)) continue;
                return _customClauseView(cs);
            }
        } catch (_) { /* actor.appliedEffects unusable — fall through to registry */ }
    }
    const clauses = getActiveClauses();
    return clauses[id] ?? clauses[String(id).replace(/-\d+$/, "")] ?? null;
}

/* Present a stored customStatus flag as a clause the rest of the engine can
 * read via the same shape as world clauses (mods.stats, mods.roll,
 * mods.derived, restrict{...}, dot{amount,cadence,throughArmor}, description).
 * Missing sub-objects collapse to null so the callers' optional-chain reads
 * behave the same as a barely-authored world status. */
function _customClauseView(cs) {
    const trimNumbers = (m) => {
        if (!m || typeof m !== "object") return null;
        const out = {};
        for (const [k, v] of Object.entries(m)) {
            const n = Number(v);
            if (Number.isFinite(n) && n !== 0) out[k] = n;
        }
        return Object.keys(out).length ? out : null;
    };
    const stats   = trimNumbers(cs.mods?.stats);
    const skills  = trimNumbers(cs.mods?.skills);
    const roll    = trimNumbers(cs.mods?.roll);
    const derived = trimNumbers(cs.mods?.derived);
    const modsHas = stats || skills || roll || derived;
    const restrictHas = !!(cs.restrict?.act || cs.restrict?.defend || cs.restrict?.move || cs.restrict?.hard);
    const dotAmount = String(cs.dot?.amount ?? "").trim();
    const dotCad   = Number(cs.dot?.cadence ?? 0);
    const dotAblate = Number(cs.dot?.ablateArmor ?? 0);
    const dotHas = (dotAmount && dotCad > 0) || dotAblate > 0;
    const ec = cs.endCheck ?? {};
    const endHas = ec.kind && ec.kind !== "none";
    const periodicEvery = Number(cs.periodic?.every ?? 0);
    const periodicHas = periodicEvery > 0 && cs.periodic?.rollUnder;
    const incomingDC = Number(cs.incomingDC ?? 0);
    return {
        description: String(cs.description ?? ""),
        mods:     modsHas ? { stats, skills, roll, derived } : undefined,
        restrict: restrictHas ? {
            act:    !!cs.restrict?.act,
            defend: !!cs.restrict?.defend,
            move:   !!cs.restrict?.move,
            hard:   !!cs.restrict?.hard
        } : undefined,
        /* DoT is emitted in the CANONICAL world-clause shape (see
         * setup/statusClauses.mjs — `bypassArmor` and `scope: "all-locations"`),
         * so tick-effects reads it identically to a RAW status clause without a
         * shape adapter. Storage on the flag keeps the friendlier names
         * (`throughArmor`, `everyLocation`) — the mapping happens here. */
        dot: dotHas ? {
            amount:       dotAmount,
            cadence:      dotCad || 1,
            ablateArmor:  dotAblate || undefined,
            bypassArmor:  !!cs.dot?.throughArmor,
            scope:        cs.dot?.everyLocation ? "all-locations" : undefined,
            damageType:   String(cs.dot?.damageType ?? "") || undefined
        } : undefined,
        /* countsAs propagates onto the clause so the DoT applier can look up
         * status-based resistance / immunity against every id this custom
         * status is treated as (a spider-poison AE with countsAs: [poisoned]
         * gets halved by a monster whose statusResistances includes poisoned). */
        countsAs:   (Array.isArray(cs.countsAs) && cs.countsAs.length)
            ? cs.countsAs.map(String).filter(Boolean)
            : undefined,
        incomingDC: incomingDC > 0 ? incomingDC : undefined,
        endCheck:   endHas ? {
            kind:       String(ec.kind),
            skill:      String(ec.skill ?? ""),
            dc:         Number(ec.dc ?? 0) || undefined,
            actionCost: Number(ec.actionCost ?? 0) || undefined
        } : undefined,
        /* Turn-END wins when both are set: many statuses default to
         * "ownTurnStart", so ticking "turn end" is an explicit override that
         * must take effect (otherwise the leftover start box keeps it clearing
         * a round later). */
        clearsAt:   cs.clearsAtOwnTurnEnd ? "ownTurnEnd"
                  : cs.clearsAtOwnTurn ? "ownTurnStart" : undefined,
        clearOnHit: !!cs.clearOnHit || undefined,
        /* Emit `everyRounds` (world-clause canonical), NOT `every` (the
         * friendlier name we STORE on the flag). runTurnStartMutations has a
         * fallback that reads either, but the clause interface should look
         * exactly like a RAW status clause so no downstream reader has to
         * special-case custom-status shape. */
        periodic:   periodicHas ? {
            everyRounds: periodicEvery,
            rollUnder:   String(cs.periodic.rollUnder)
        } : undefined
    };
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
    if (!stressOn) return base;
    /* Resolve the stress addendum through the same lazy-getter pattern the
     * description uses: prefer `WITCHER.Setup.StatusClauses.<id>.StressNote`
     * from the loaded language file, fall back to the raw English written
     * on the clause. Keeps stress-gated flavor translatable per-language
     * without every clause needing to author its own getter. */
    let note = c.stressNote;
    try {
        const key = `WITCHER.Setup.StatusClauses.${id}.StressNote`;
        const localized = game.i18n?.localize?.(key);
        if (localized && localized !== key) note = localized;
    } catch { /* i18n not yet ready — use raw */ }
    return base + note;
}

/* The AE change shape this system's effect data model understands
 * (key/value/type/phase — NOT Foundry's native mode/priority pair).
 *
 * A hoisted `function` (not a `const` arrow) on purpose: statusChanges() is
 * called at module-EVAL time by statusEffects.mjs's `STATUS_EFFECTS` map, and
 * this file sits in a circular import (statusEngine → statusOverrides →
 * statusClauses → statusEngine). Under some load orders that map runs before a
 * `const change` would have initialized → "Cannot access 'change' before
 * initialization" (TDZ). Function declarations are hoisted + initialized before
 * any statements execute, so `change` is always callable regardless of order. */
function change(key, value) {
    return { key, value: String(value), type: "add", phase: "initial", priority: 0 };
}

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
        const d = clauseFor(id, actor)?.mods?.derived;
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
        const roll = clauseFor(id, actor)?.mods?.roll;
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
        if (clauseFor(id, actor)?.restrict?.act) return true;
    }
    return false;
}

/** Statuses whose `restrict.act` comes from being HELD (pinned / chokeheld /
 *  clinched) rather than from true incapacitation (paralyzed / unconscious).
 *  Escape must remain possible from these — RAW Core "Brawling & Wrestling":
 *  "You can only attempt to Escape while pinned." — so `cannotEscape` filters
 *  them out. Keep this in sync with mechanics/holdLink.HOLD_STATUSES. */
const HOLD_STATUS_IDS = ["grappled", "pinned", "clinched", "chokeheld"];

/** True if any active status forbids EVEN attempting an Escape. Filters out
 *  the hold-family statuses whose whole point is that Escape is the one
 *  action the held actor can still take; a paralyzed / unconscious / dead
 *  actor still can't escape, but a pinned one can. Consumed by the dock's
 *  Action-menu escape wiring and by combatRoundMixin's action-spend gate
 *  when the spend is flagged as an escape attempt. */
export function cannotEscape(actor) {
    for (const id of (actor?.statuses ?? [])) {
        if (HOLD_STATUS_IDS.includes(id)) continue;
        if (clauseFor(id, actor)?.restrict?.act) return true;
    }
    return false;
}

/** True if any active status forbids defending. */
export function cannotDefend(actor) {
    for (const id of (actor?.statuses ?? [])) {
        if (clauseFor(id, actor)?.restrict?.defend) return true;
    }
    return false;
}

/** True if any active status forbids voluntary movement (Grappled per RAW
 *  Core "Brawling & Wrestling" — the target cannot move away from the
 *  grappler; also Pinned, which is a hard immobilize). Consumed by the
 *  canvas-movement policy + the dock's Move button to refuse a move
 *  attempt with a warning instead of silently accepting the drag. */
export function cannotMove(actor) {
    for (const id of (actor?.statuses ?? [])) {
        if (clauseFor(id, actor)?.restrict?.move) return true;
    }
    return false;
}

/** True if any active status is a HARD lock that forbids even the Recovery
 *  full-round action (Paralyzed / Unconscious). Plain Stunned is NOT hard —
 *  the STA-recovery house rule lets a stunned fighter still catch their breath
 *  (combatRoundMixin). */
export function cannotRecover(actor) {
    for (const id of (actor?.statuses ?? [])) {
        if (clauseFor(id, actor)?.restrict?.hard) return true;
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
 *  lists these as roll-actions (greyed unless the bearer has the status).
 *
 *  Alchemy Reborn gate: the RAW `overdosed` status is superseded by the
 *  toxicity-mild/strong/severe/deadly tier ladder when the Alchemy Reborn
 *  homebrew is on. Hide `overdosed` (and therefore its Purge Overdose
 *  Action-menu entry) so the dock doesn't offer a purge that doesn't apply
 *  to any status the actor can carry. */
export function actionEndCheckOptions() {
    const clauses = getActiveClauses();
    const alchemyReborn = (() => {
        try { return !!game?.settings?.get?.("witcher-ttrpg-death-march", "homebrew.alchemyPotency"); }
        catch (_) { return false; }
    })();
    const out = [];
    for (const [id, c] of Object.entries(clauses)) {
        const ec = c?.endCheck;
        if (!ec || !ec.viaAction || ec.kind !== "skill") continue;
        if (alchemyReborn && id === "overdosed") continue;
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
    const ec = clauseFor(id, actor)?.endCheck;
    if (!actor || !ec || ec.kind !== "skill") return;

    const name = statusLabel(id);
    const res = await actor.rollSkillCheck?.(ec.skill, ec.dc);
    const passed = res && typeof res.total === "number" && res.total >= ec.dc;
    if (passed && ec.onPass === "endLastPotion") {
        const ended = await actor.endLastConsumedPotion?.();
        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            content: ended
                ? tFormat("WITCHER.Mech.StatusEngine.Chat.ForcesOutPotion", { actor: esc(actor.name), potion: ended.name ? ` (<strong>${esc(ended.name)}</strong>)` : "" }, `<em>${esc(actor.name)} forces out the last potion they drank${ended.name ? ` (<strong>${esc(ended.name)}</strong>)` : ""}.</em>`)
                : tFormat("WITCHER.Mech.StatusEngine.Chat.SteadiesAgainstToxicity", { actor: esc(actor.name) }, `<em>${esc(actor.name)} steadies against the toxicity.</em>`)
        });
    } else if (passed) {
        await clearStatusFromActor(actor, id);
        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            content: tFormat("WITCHER.Mech.StatusEngine.Chat.ShakesOff", { actor: esc(actor.name), status: esc(name) }, "<em>{actor} shakes off <strong>{status}</strong>.</em>")
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
        const v = clauseFor(id, actor)?.incomingDC;
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
        if (clauseFor(id, actor)?.clearsAt === "ownTurnStart") {
            await clearStatusFromActor(actor, id);
        }
    }
    // 2. Periodic saves (e.g. Nausea every 3 rounds). World clauses use
    //    `periodic.everyRounds`; custom-status clauses use `periodic.every`
    //    (the friendlier name in the AE editor). Read both.
    const round = Number(game.combat?.round) || 0;
    if (round > 0) {
        for (const id of [...(actor.statuses ?? [])]) {
            const p = clauseFor(id, actor)?.periodic;
            if (!p) continue;
            const every = Math.max(1, Number(p.everyRounds ?? p.every) || 1);
            if (round % every !== 0) continue;
            await rollPeriodic(actor, id, p);
        }
    }
}

/**
 * GM-side, run once when the bearer's turn ENDS (from combat-round-reset's
 * turn-transition handler, using the outgoing combatant). Auto-clears statuses
 * flagged to lapse at the bearer's own turn end. State mutations only.
 */
export async function runTurnEndMutations(actor) {
    if (!actor) return;
    for (const id of [...(actor.statuses ?? [])]) {
        if (clauseFor(id, actor)?.clearsAt === "ownTurnEnd") {
            await clearStatusFromActor(actor, id);
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
    const verdict = passed
        ? t("WITCHER.Mech.StatusEngine.Text.Resisted", "resisted")
        : t("WITCHER.Mech.StatusEngine.Text.RetchingRound", "spends the round retching");
    await roll.toMessage({
        speaker: ChatMessage.getSpeaker({ actor }),
        flavor: tFormat("WITCHER.Mech.StatusEngine.Chat.RollUnderStat", { status: esc(statusLabel(id)), stat: statKey.toUpperCase(), target, verdict }, `${esc(statusLabel(id))} — roll under ${statKey.toUpperCase()} (${target}): ${verdict}`)
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
        const ec = clauseFor(id, actor)?.endCheck;
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
            /* Sum any endCheckModifier flags carried by AEs that hold
             * this status — Axii stamps −1 (scaled by cast STA) via its
             * spell handler, and future bespoke stuns can do the same
             * without touching this file. Passed straight to rollStunSave
             * as `modifier` so the roll-under threshold shifts. */
            let modifier = 0;
            for (const e of (actor.appliedEffects ?? actor.effects ?? [])) {
                if (e.disabled || e.system?.isSuppressed) continue;
                if (!e.statuses?.has?.(id)) continue;
                const m = Number(e.getFlag?.(SYSTEM_ID, "endCheckModifier")) || 0;
                if (m) modifier += m;
            }
            const modNote = modifier ? ` (${modifier > 0 ? `+${modifier}` : String(modifier)} to save)` : "";
            const ok = await confirm(DialogV2, name, tFormat("WITCHER.Mech.StatusEngine.Dialog.StunSavePrompt", { name, modNote }, `Make a Stun save to shake off ${name}${modNote}?`));
            if (ok) await actor.rollStunSave?.({ modifier });   // clears on pass itself
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
                    tFormat("WITCHER.Mech.StatusEngine.Notify.NoActionForCheck", { actor: actor.name, label, name }, `${actor.name}: no action left this turn to attempt the ${label} check on ${name}.`)
                );
                continue;
            }
            const costNote = costs ? t("WITCHER.Mech.StatusEngine.Text.CostsOneAction", " (costs 1 action)") : "";
            const ok = await confirm(DialogV2, name, tFormat("WITCHER.Mech.StatusEngine.Dialog.SkillCheckPrompt", { dc: ec.dc, label, name, costNote }, `Make a DC ${ec.dc} ${label} check to end ${name}?${costNote}`));
            if (!ok) continue;
            if (costs) await actor.spendActionSlot?.(tFormat("WITCHER.Mech.StatusEngine.Text.EndStatus", { name }, `End ${name}`));
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
                        ? tFormat("WITCHER.Mech.StatusEngine.Chat.ForcesOutPotion", { actor: esc(actor.name), potion: ended.name ? ` (<strong>${esc(ended.name)}</strong>)` : "" }, `<em>${esc(actor.name)} forces out the last potion they drank${ended.name ? ` (<strong>${esc(ended.name)}</strong>)` : ""}.</em>`)
                        : tFormat("WITCHER.Mech.StatusEngine.Chat.SteadiesAgainstToxicity", { actor: esc(actor.name) }, `<em>${esc(actor.name)} steadies against the toxicity.</em>`)
                });
            } else if (passed) {
                await clearStatusFromActor(actor, id);
                await ChatMessage.create({
                    speaker: ChatMessage.getSpeaker({ actor }),
                    content: tFormat("WITCHER.Mech.StatusEngine.Chat.ShakesOff", { actor: esc(actor.name), status: esc(name) }, "<em>{actor} shakes off <strong>{status}</strong>.</em>")
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
        // The two onApply flows (stressDelta + stressShield) have different
        // data sources: stressDelta reads CLAUSES off the AE's statuses,
        // shield reads BOTH the AE's flags.<sys>.actions[] AND its statuses'
        // clauses. So we can't bail on statuses-being-empty up front — a
        // status-less AE that carries a stressShield action row (a potion,
        // a perk) wouldn't reach the shield handler. Fall through with an
        // empty Set instead; the stressDelta loop becomes a no-op naturally.
        const statuses = effect.statuses ?? new Set();

        let stressDelta = 0;
        const stressSources = [];   // for the chat feedback: which statuses drove the delta
        for (const id of statuses) {
            const oa = clauseFor(id)?.onApply;
            if (!oa) continue;
            if (typeof oa.stress === "number" && oa.stress !== 0) {
                stressDelta += oa.stress;
                stressSources.push({ id, delta: oa.stress });
            }
        }
        if (stressDelta !== 0) {
            const { grantStress, getStress } = await import("./stress.mjs");
            const before = getStress(actor);
            await grantStress(actor, stressDelta);
            // Feedback card so the player (and the GM) SEE the stress
            // change — drinking alcohol relieves 1, crossing Hungry adds 1,
            // etc. Without this the mechanic silently mutates system.stress
            // and the source is opaque unless the actor sheet is open.
            try {
                const after = Math.max(0, before + stressDelta);
                const sign  = stressDelta > 0 ? "+" : "";
                const colour = stressDelta > 0 ? "#c76b6b" : "#7abf7a";
                const icon  = stressDelta > 0
                    ? '<i class="fa-solid fa-bolt"></i>'
                    : '<i class="fa-solid fa-heart-pulse"></i>';
                const esc   = (s) => Handlebars?.escapeExpression?.(String(s ?? "")) ?? String(s ?? "");
                const sourceLabels = stressSources
                    .map(s => {
                        const label = clauseFor(s.id)?.label
                                   ?? (CONFIG.statusEffects ?? []).find(x => x.id === s.id)?.name
                                   ?? s.id;
                        return `${esc(game.i18n?.localize?.(label) ?? label)} (${s.delta > 0 ? "+" : ""}${s.delta})`;
                    })
                    .join(", ");
                // Whisper — actor owners + GMs only. Stress is private info;
                // a public card would leak Cat School Witcher A's stress
                // relief to Witcher B's table. `testUserPermission(OWNER)`
                // gets every player with OWNER perms on this specific actor
                // plus any assigned-character user; GMs are picked up by
                // Foundry's default whisper broadcast rule.
                const whisperIds = (game.users?.filter?.(u =>
                    u.isGM || actor.testUserPermission?.(u, "OWNER")
                ) ?? []).map(u => u.id);
                await ChatMessage.create({
                    speaker: ChatMessage.getSpeaker({ actor }),
                    style:   CONST.CHAT_MESSAGE_STYLES.OTHER,
                    whisper: whisperIds,
                    content: tFormat(
                        "WITCHER.Mech.StatusEngine.Chat.StressOnApply",
                        { colour, icon, name: esc(actor.name), sign, delta: stressDelta, before, after, sources: sourceLabels },
                        "<div style=\"border-left:3px solid {colour}; padding:4px 8px; margin:2px 0;\">{icon} <b>{name}</b> — Stress <b>{sign}{delta}</b> <small style=\"opacity:0.75;\">({before} → {after})</small><div style=\"opacity:0.85; font-size:0.8125rem;\">{sources}</div></div>"
                    ),
                    flags: { [SYSTEM_ID]: { category: "stress-onapply" } }
                });
            } catch (err) {
                console.warn(`${SYSTEM_ID} | stress onApply chat post failed`, err);
            }
        }

        /* Stress shield — declarative absorb buffer. Two sources, same handler:
         *   • clause `stressShield` on any of the AE's statuses (Stoic /
         *     Hopeful out of the box, plus any GM-tagged custom status via
         *     the Status Effects editor).
         *   • action row `{ type: "stressShield", kind, dice }` on the AE
         *     itself (set in the AE editor). Lets a potion / perk / custom
         *     buff carry a shield without needing a registered status.
         * First match wins — one shield per AE, action overrides clause.
         *
         * Idempotent across re-renders: bails if the corresponding flag is
         * already set, so the GM can pre-roll a buffer (or fix a runaway) via
         * the AE editor without it being overwritten next createAE pass. */
        const collectShieldSpecs = () => {
            const specs = [];
            const actions = effect.flags?.[SYSTEM_ID]?.actions;
            if (Array.isArray(actions)) {
                for (const a of actions) {
                    if (a?.type === "stressShield") specs.push({ kind: a.kind, dice: a.dice });
                }
            }
            for (const id of statuses) {
                const s = clauseFor(id)?.stressShield;
                if (s) specs.push({ kind: s.kind, dice: s.dice });
            }
            return specs;
        };

        for (const spec of collectShieldSpecs()) {
            const flag = spec.kind === "sources" ? "stressAbsorbSources" : "stressAbsorbPoints";
            if (effect.getFlag(SYSTEM_ID, flag)) break;  // already provisioned
            const dice = String(spec.dice || "1d6").trim();
            let total = 0;
            try {
                const r = await new Roll(dice).evaluate();
                total = Math.max(0, Math.floor(r.total));
            } catch (_) { break; }
            if (total <= 0) break;
            try { await effect.setFlag(SYSTEM_ID, flag, total); }
            catch (_) { break; }
            if (!/\(\d+\)\s*$/.test(effect.name)) {
                try { await effect.update({ name: `${effect.name} (${total})` }); }
                catch (_) { /* presentation only */ }
            }
            const unit = spec.kind === "sources" ? "sources" : "points";
            try {
                await ChatMessage.create({
                    speaker: ChatMessage.getSpeaker({ actor }),
                    content: tFormat(
                        "WITCHER.Mech.StatusEngine.Chat.StressAbsorb",
                        { actor: actor.name, effect: effect.name.replace(/\s*\(\d+\)\s*$/, ""), total, unit },
                        "<i>{actor}'s {effect} will absorb the next <b>{total}</b> {unit} of STRESS.</i>"
                    )
                });
            } catch (_) { /* chat is informational */ }
            break;  // one shield per AE
        }
    } catch (err) {
        console.warn("witcher-ttrpg-death-march | onCreateActiveEffect onApply failed", err);
    }
}

/* DialogV2.confirm wrapper — resolves false on cancel/close instead of throwing. */
async function confirm(DialogV2, title, question) {
    try {
        return await DialogV2.confirm({
            window: { title: tFormat("WITCHER.Mech.StatusEngine.Dialog.Title.EndX", { title: title }, "End {title}?") },
            content: `<p style="margin:6px 0;">${esc(question)}</p>`,
            modal: true,
            rejectClose: false
        });
    } catch (_) { return false; }
}
