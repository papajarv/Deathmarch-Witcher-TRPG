/**
 * Stress mechanic — port of witcher-stress-mechanic.
 *
 * Stress lives at `character.system.stress` (Phase 3 migration). When
 * stress exceeds WILL on an increase, the character makes a 1d10 save vs
 * a threshold of `WILL - (stress - WILL)`. Failure → roll d20 on the
 * Mental Break table → apply a flavor-only ActiveEffect. Nat 1 on the
 * save → roll d20 on the Boon table.
 *
 * After every check (pass or fail) stress clears to `WILL - 1`.
 *
 * Breakdowns persist as ActiveEffects until stress falls to 0, at which
 * point they get swept off the actor.
 *
 * Homebrew (ADR 0003): gates on `isHomebrewEnabled("stress")`.
 */

import { isHomebrewEnabled } from "../api/homebrew.mjs";
import { statusChanges } from "./statusEngine.mjs";
import { appendAttackResult } from "../documents/mixins/weaponAttackMixin.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const BOON_FLAG  = "stressBoon";                       // marker on boon AEs (parallel to BREAKDOWN_FLAG)
const BREAKDOWN_FLAG = "stressBreakdown";              // marker on the persistent "experienced" AE
const BREAKDOWN_COMBAT_FLAG = "stressBreakdownCombatEffect"; // marker on combat-scoped sub-effects
const BREAKDOWN_BANKED_FLAG = "stressBreakdownBanked"; // flag list of break names waiting on a future combat

/* Family tints for status-icon visual differentiation. Foundry reads the
 * AE's `tint` field in Token._drawEffect and applies it to the icon sprite,
 * so a rust-red tint on a break instantly signals "stress homebrew, this is
 * bad" vs a sage-green boon. The duration ring color (the circular bar that
 * sweeps around the icon as it expires) isn't customizable from here — that
 * lives inside Foundry's canvas rendering — but the tinted icon is enough
 * to read homebrew-source at a glance. */
const BREAK_TINT = "#a83232";   // rust red
const BOON_TINT  = "#89cff0";   // baby blue

/* A break AE is either the persistent "experienced" marker OR a combat-
 * scoped sub-effect spawned by one. Both sweep when stress hits 0. */
function isBreakAE(e) {
    return !!(e?.getFlag?.(SYSTEM_ID, BREAKDOWN_FLAG)
           || e?.getFlag?.(SYSTEM_ID, BREAKDOWN_COMBAT_FLAG));
}

/* ─────────── Tables ─────────────────────────────────────────────────────── */

const MENTAL_BREAKS = Object.freeze([
    { min: 1,  max: 5,  name: "Indulgent",    effect: "This is too much. You need your vice. You need comfort. Eat food until you are gorged." },
    { min: 6,  max: 7,  name: "Paranoid",     effect: "Can you really trust anyone but yourself? Are you being watched? Something is out to get you. Isolate." },
    { min: 8,  max: 9,  name: "Scared",       effect: "You're in danger. Everything is uncertain. −1 to every roll." },
    { min: 10, max: 11, name: "Depressive",   effect: "Nothing seems to matter that much anymore. What's the point. −2 WILL." },
    { min: 12, max: 14, name: "Impulsive",    effect: "Just do something. Anything. Not the time to think about it." },
    { min: 15, max: 16, name: "Self-Harming", effect: "Stupid, stupid, stupid. This is all your fault. You did this. Take 1d6 damage on a random body part." },
    { min: 17, max: 18, name: "Selfish",      effect: "This is not the time to think of others. You need to look out for yourself." },
    { min: 19, max: 20, name: "Violent",      effect: "You've had enough. Violence is the only answer. +1 REF for the immediate combat." }
]);

const BOONS = Object.freeze([
    { min: 1,  max: 5,  name: "Stoic",          effect: "This is nothing to you. You ignore the next 1d6 points of STRESS." },
    { min: 6,  max: 7,  name: "Optimistic",     effect: "This isn't so bad. Clear 1 STRESS." },
    { min: 8,  max: 9,  name: "Hopeful",        effect: "There is a light at the end of the tunnel. Ignore the next 2d6 sources of STRESS." },
    { min: 10, max: 11, name: "Defiant",        effect: "You've had worse. Is this all they have? You roll twice and take the best result on your next mental break roll." },
    { min: 12, max: 14, name: "Focused",        effect: "You will have +1 WA for the rest of the day." },
    { min: 15, max: 16, name: "Stalwart",       effect: "You clear 2 STRESS. You will survive this." },
    { min: 17, max: 18, name: "Determined",     effect: "You clear 4 STRESS. If in combat and below wound threshold, you ignore the penalties for 3 turns." },
    { min: 19, max: 19, name: "Unbreakable",    effect: "All your STRESS is cleared. You are resolute. Nothing will stop you. You automatically pass 3 death saves if in combat, and ignore penalties from being below your wound threshold and death state for 3 turns." },
    { min: 20, max: 20, name: "Smile at Death", effect: "You make peace with your demise. Clear all STRESS. Ignore all wound penalties until the end of combat. You gain 2d6 temporary HP and 2d6 temporary STA. You gain +2 REF until the end of combat. When combat ends, you are automatically thrown back into death state." }
]);

const lookup = (table, roll) =>
    table.find(r => roll >= r.min && roll <= r.max) ?? null;

/* ─────────── Read / write helpers ───────────────────────────────────────── */

export function getStress(actor) {
    return actor?.system?.stress ?? 0;
}
export function getWill(actor) {
    return actor?.system?.stats?.will?.value ?? 0;
}
/* GM-tunable stress config. World setting backing object — `getStressConfig`
 * returns the merged defaults+stored payload. Consumed by every site that
 * makes a knob-able decision (WILL save threshold, post-save clear target,
 * breakdown cap, wound-stress amounts, recovery-penalty toggle). Defaults
 * mirror RAW behavior so a world that never opens the menu still runs as
 * before. */
const STRESS_CONFIG_DEFAULTS = Object.freeze({
    recoveryPenaltyEnabled: true,
    thresholdPenaltyMultiplier: 1,
    postSaveClearOffset: -1,            // stress = WILL + offset (RAW: -1)
    breakdownCap: 8,                    // max simultaneous breaks before handover
    woundStressEnabled: true,
    woundStressSimple: 1,
    woundStressComplex: 2,
    woundStressDifficult: 3,
    woundStressDeadly: 4
});

export function getStressConfig() {
    let stored = {};
    try { stored = game.settings?.get?.(SYSTEM_ID, "stressConfig") ?? {}; }
    catch (_) { stored = {}; }
    return { ...STRESS_CONFIG_DEFAULTS, ...(stored ?? {}) };
}

export const STRESS_CONFIG_KEY = "stressConfig";
export { STRESS_CONFIG_DEFAULTS };

/** Penalty to recovery and similar rolls when stress exceeds WILL.
 *  Returns 0 if the recovery-penalty toggle is off, regardless of stress. */
export function getStressPenalty(actor) {
    const cfg = getStressConfig();
    if (!cfg.recoveryPenaltyEnabled) return 0;
    return Math.max(0, getStress(actor) - getWill(actor));
}
export async function setStress(actor, val, opts = {}) {
    if (!actor) return;
    /* opts.attackMessageUuid (optional): the attack chat card to fold
     * any consequent WILL save / break / boon chat messages into,
     * instead of posting standalone. Stashed on the update options
     * so onUpdateActor → runStressCheck can read it back. */
    const updateOpts = {};
    if (opts.attackMessageUuid) updateOpts.wdmAttackMessageUuid = opts.attackMessageUuid;
    return actor.update({ "system.stress": Math.max(0, val) }, updateOpts);
}
export async function grantStress(actor, delta, opts = {}) {
    if (!actor) return;
    return setStress(actor, getStress(actor) + delta, opts);
}

/* ─────────── Save flow ──────────────────────────────────────────────────── */

/**
 * Run the WILL save when stress exceeds WILL on an increase.
 * Called from the updateActor hook in hooks.mjs.
 */
export async function runStressCheck(actor, stress, will, opts = {}) {
    if (!isHomebrewEnabled("stress")) return;

    const cfg       = getStressConfig();
    const mult      = Number(cfg.thresholdPenaltyMultiplier) || 1;
    const penalty   = Math.round((stress - will) * mult);
    const threshold = will - penalty;
    const speaker   = ChatMessage.getSpeaker({ actor });

    /* When the stress check was kicked off by an attack chain, fold every
     * chat message into that attack card's collapsible damage block
     * (user spec: stress and hit-defending stuff under the same
     * collapsible card). Without an attackMessageUuid (out-of-combat
     * stress, GM dock stress nudge, etc.), keep posting standalone. */
    const attackMsg = opts.attackMessageUuid ? await fromUuid(opts.attackMessageUuid) : null;
    const post = async (content, summaryAdd) => {
        if (attackMsg) {
            /* Static import at file top — dynamic await import() inside
             * this function silently failed in some Foundry contexts,
             * which dropped stress chat into standalone messages and
             * skipped the summary-chip update. */
            await appendAttackResult(attackMsg, { fragment: content, summaryAdd });
        } else {
            await ChatMessage.create({ speaker, content });
        }
    };

    const saveRoll = await new Roll("1d10").evaluate();
    const nat1     = saveRoll.total === 1;
    const passed   = saveRoll.total <= threshold;

    if (nat1) {
        const tableRoll = await new Roll("1d20").evaluate();
        const boon = lookup(BOONS, tableRoll.total);
        await post(
            buildCard({
                actor, stress, will, penalty, threshold,
                saveRoll: saveRoll.total, header: "NATURAL 1 — BOON",
                colour: "#89cff0", tableRoll: tableRoll.total, result: boon
            }),
            { label: `${actor.name}: ${boon?.name ? `Boon — ${boon.name}` : "Boon"}`, kind: "stress", icon: "fa-hand-holding-heart" }
        );
        // Boon clears whatever stress its rule says (instant amount, or all);
        // applyBoonEffect handles the per-row stress clear + any AE the boon
        // attaches. The default "save → stress to WILL−1" only applies if the
        // boon doesn't define its own clear.
        const cleared = await applyBoonEffect(actor, boon, { will });
        if (!cleared) await setStress(actor, Math.max(0, will + (Number(getStressConfig().postSaveClearOffset) || -1)));
        return;
    }

    if (passed) {
        await post(
            `<div style="border-left:3px solid #4a7c59;padding:4px 8px">
                <b>${actor.name}</b> — Stress WILL Save<br>
                Stress <b>${stress}</b> / Will <b>${will}</b> · need ≤ <b>${threshold}</b><br>
                Rolled <b>${saveRoll.total}</b> — <span style="color:#4a7c59"><b>Holds together. Barely.</b></span>
            </div>`,
            { label: `${actor.name}: Stress save passed (${saveRoll.total}/${threshold})`, kind: "stress", icon: "fa-brain" }
        );
        return;
    }

    // Failure — pick a breakdown not already on the actor. Counts ONLY the
    // persistent marker AEs (BREAKDOWN_FLAG); combat-scoped sub-effects use
    // a different flag and wouldn't dedupe correctly here.
    const owned = new Set(
        actor.effects
            .filter(e => e.getFlag(SYSTEM_ID, BREAKDOWN_FLAG))
            .map(e => e.name)
    );

    const cap = Math.min(MENTAL_BREAKS.length, Math.max(1, Number(cfg.breakdownCap) || MENTAL_BREAKS.length));
    if (owned.size >= cap) {
        await post(
            `<div style="border-left:3px solid #4b0000;padding:6px 10px">
                <b>${actor.name}</b> — Stress WILL Save<br>
                Stress <b>${stress}</b> / Will <b>${will}</b> · need ≤ <b>${threshold}</b><br>
                Rolled <b>${saveRoll.total}</b> — <span style="color:#4b0000"><b>NO ROOM LEFT</b></span>
                <hr><i>Every break the mind can take is already taken.
                Control of <b>${actor.name}</b> passes to the GM.</i>
            </div>`,
            { label: `${actor.name}: Mental break overflow`, kind: "fumble", icon: "fa-skull" }
        );
        await setStress(actor, Math.max(0, will + (Number(getStressConfig().postSaveClearOffset) || -1)));
        return;
    }

    // Defiant: if the actor carries a reroll-next-break marker AE, roll the
    // d20 TWICE and take the lower total (rolling low on MENTAL_BREAKS lands
    // on the more benign entries — "best" from the player's perspective).
    // The marker is consumed (AE deleted) once a breakdown is locked in.
    const defiantAE = findActiveAEWithFlag(actor, REROLL_BREAK_FLAG);

    let tableRoll, breakdown;
    for (let i = 0; i < 50; i++) {
        if (defiantAE) {
            const r1 = await new Roll("1d20").evaluate();
            const r2 = await new Roll("1d20").evaluate();
            tableRoll = r1.total <= r2.total ? r1 : r2;
        } else {
            tableRoll = await new Roll("1d20").evaluate();
        }
        breakdown = lookup(MENTAL_BREAKS, tableRoll.total);
        if (breakdown && !owned.has(breakdown.name)) break;
    }
    if (defiantAE) {
        try { await defiantAE.delete(); } catch (_) { /* AE already gone */ }
    }

    await post(
        buildCard({
            actor, stress, will, penalty, threshold,
            saveRoll: saveRoll.total,
            header: defiantAE ? "MENTAL BREAK (Defiant reroll)" : "MENTAL BREAK",
            colour: "#8b0000", tableRoll: tableRoll.total, result: breakdown
        }),
        { label: `${actor.name}: ${breakdown?.name ? `Break — ${breakdown.name}` : "Mental Break"}`, kind: "fumble", icon: "fa-brain" }
    );
    await applyBreakdownEffect(actor, breakdown);
    await setStress(actor, Math.max(0, will + (Number(getStressConfig().postSaveClearOffset) || -1)));
}

function buildCard({ actor, stress, will, penalty, threshold, saveRoll, header, colour, tableRoll, result }) {
    return `<div style="border-left:3px solid ${colour};padding:4px 8px">
        <b>${actor.name}</b> — Stress WILL Save<br>
        Stress <b>${stress}</b> / Will <b>${will}</b> · penalty <b>-${penalty}</b> · need ≤ <b>${threshold}</b><br>
        Rolled <b>${saveRoll}</b> — <span style="color:${colour}"><b>${header}</b></span>
        <hr style="margin:4px 0">
        <b>d20: ${tableRoll} — ${result?.name ?? "???"}</b><br>
        <i>${result?.effect ?? ""}</i>
        <br><small style="opacity:0.7">Stress cleared to ${will - 1}.</small>
    </div>`;
}

/* ─────────── Breakdown effects ──────────────────────────────────────────── */

/* Per-break wiring. Three fields:
 *   statusId       — persistent status the marker AE carries (Scared, Depressive).
 *                    Stays on the actor for as long as the break is "experienced"
 *                    (until stress drops to 0 / character handed to GM).
 *   combatEffect   — combat-scoped effect that's separate from the marker. When
 *                    the break lands during combat → created immediately, expires
 *                    at deleteCombat. When it lands outside combat → name banked
 *                    in flags.<sys>.stressBreakdownBanked, fires on next combatStart.
 *                    Has its own statusId for the actual mod. Either way the
 *                    *marker* AE (counted toward the 8-cap) is unaffected by
 *                    combat lifecycle.
 *   onApply        — one-shot side effect at AE creation time (Self-Harming).
 *
 * Names match the MENTAL_BREAKS table rows. */
const ICON_DIR = "systems/witcher-ttrpg-death-march/assets/icons/statuses";
const BREAK_CONFIG = Object.freeze({
    "Indulgent":    { statusId: "break-indulgent",    img: `${ICON_DIR}/break-indulgent.svg` },
    "Paranoid":     { statusId: "break-paranoid",     img: `${ICON_DIR}/break-paranoid.svg` },
    "Scared":       { statusId: "break-scared",       img: `${ICON_DIR}/break-scared.svg` },
    "Depressive":   { statusId: "break-depressive",   img: `${ICON_DIR}/break-depressive.svg` },
    "Impulsive":    { statusId: "break-impulsive",    img: `${ICON_DIR}/break-impulsive.svg` },
    "Self-Harming": { statusId: "break-self-harming", img: `${ICON_DIR}/break-self-harming.svg`, onApply: applySelfHarmDamage },
    "Selfish":      { statusId: "break-selfish",      img: `${ICON_DIR}/break-selfish.svg` },
    // Violent: the MARKER deliberately has NO statusId — the "break-violent"
    // clause carries the +1 REF mod, and we don't want that mod on the
    // persistent experience marker (the +1 REF is combat-scoped per RAW).
    // The combat sub-AE owns the statusId and the mod; the marker just
    // tracks "you've experienced Violent" until stress drops to 0.
    "Violent":      { img: `${ICON_DIR}/break-violent.svg`,
                      combatEffect: { statusId: "break-violent", name: "Violent Fury",
                                       img: `${ICON_DIR}/break-violent.svg`,
                                       description: "Violent — +1 REF for the immediate combat." } }
});

/* Self-Harming: 1d6 to a randomly-rolled body part with the standard RAW
 * location multiplier applied (Core p.152): head ×3, torso ×1, arms / legs
 * ×0.5. Armor is intentionally NOT applied — the wound is self-inflicted at
 * a vulnerable spot, not a structured attack against the character's armored
 * silhouette. Final damage floors at 1 so a glancing self-harm still hurts. */
async function applySelfHarmDamage(actor) {
    if (!actor) return;
    const damageRoll   = await new Roll("1d6").evaluate();
    const locationRoll = await new Roll("1d10").evaluate();
    // [min, max, display label, multiplier]
    const LOCS = [
        [1,  1,  "Head",      3.0],
        [2,  4,  "Torso",     1.0],
        [5,  5,  "Right Arm", 0.5],
        [6,  6,  "Left Arm",  0.5],
        [7,  8,  "Right Leg", 0.5],
        [9,  10, "Left Leg",  0.5]
    ];
    const hit = LOCS.find(([min, max]) => locationRoll.total >= min && locationRoll.total <= max) ?? [0, 0, "Torso", 1];
    const loc        = hit[2];
    const multiplier = hit[3];
    const base       = damageRoll.total;
    // Floor at 1 — a 1×0.5 roll otherwise rounds to 0 and reads as a free pass.
    const damage = Math.max(1, Math.floor(base * multiplier));
    const hp = Number(actor.system?.derivedStats?.hp?.value) || 0;
    try {
        await actor.update({ "system.derivedStats.hp.value": Math.max(0, hp - damage) });
    } catch (err) { console.warn(`${SYSTEM_ID} | self-harm damage failed`, err); }
    try {
        const multTxt = multiplier === 1
            ? ""
            : ` ×<b>${multiplier}</b> (${loc} multiplier)`;
        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            content: `<div style="border-left:3px solid #6b3f3f;padding:4px 8px">
                <b>${actor.name}</b> — self-harm: <b>${base}</b>${multTxt} = <b>${damage}</b> damage to the <b>${loc}</b>.
            </div>`
        });
    } catch (_) { /* chat is informational only */ }
}

export async function applyBreakdownEffect(actor, breakdown) {
    if (!actor || !breakdown) return;
    if (!actor.isOwner && !game.user.isGM) return;
    const cfg = BREAK_CONFIG[breakdown.name] ?? {};

    // 1. Persistent "experienced" marker. Always created — counts toward the
    //    8-cap and persists until stress drops to 0. Carries the status mod
    //    inline only when the break's mechanical effect is permanent (Scared,
    //    Depressive). Combat-scoped effects live on a separate AE; the marker
    //    has no mods so it survives combat-end without losing its meta-track.
    const markerStatuses = cfg.statusId ? [cfg.statusId] : [];
    const markerChanges  = cfg.statusId ? statusChanges(cfg.statusId) : [];
    await actor.createEmbeddedDocuments("ActiveEffect", [{
        name: breakdown.name,
        img: cfg.img || `${ICON_DIR}/famished.svg`,
        tint: BREAK_TINT,
        description: breakdown.effect,
        disabled: false,
        duration: {},
        statuses: markerStatuses,
        changes: markerChanges,
        flags: { [SYSTEM_ID]: { [BREAKDOWN_FLAG]: true } }
    }]);

    // 2. Combat-scoped effect. If combat is already running, apply now and
    //    let deleteCombat tear it down. If no combat, bank the break name so
    //    the next combatStart can fire the effect.
    if (cfg.combatEffect) {
        if (game.combat?.started) {
            await createCombatScopedBreakEffect(actor, breakdown.name, cfg.combatEffect);
        } else {
            await bankCombatBreakEffect(actor, breakdown.name);
        }
    }

    // 3. One-shot side effects (Self-Harming damage etc.).
    if (typeof cfg.onApply === "function") await cfg.onApply(actor);
}

/* Spawn the combat-scoped sub-AE for a break that has one. Lasts until the
 * containing combat is deleted (or stress hits 0). Uses a sentinel-large
 * `rounds` value because Foundry's combat duration needs SOMETHING to chew
 * on; the actual expiry is the deleteCombat hook. */
async function createCombatScopedBreakEffect(actor, breakName, ce) {
    await actor.createEmbeddedDocuments("ActiveEffect", [{
        name: ce.name ?? `${breakName} (combat)`,
        img: ce.img || `${ICON_DIR}/break-violent.svg`,
        tint: BREAK_TINT,
        description: ce.description ?? `${breakName} — combat effect.`,
        disabled: false,
        statuses: ce.statusId ? [ce.statusId] : [],
        changes: ce.statusId ? statusChanges(ce.statusId) : [],
        duration: { rounds: 999 },
        flags: { [SYSTEM_ID]: {
            [BREAKDOWN_COMBAT_FLAG]: breakName,    // the source break name
            sourceBreakName: breakName
        } }
    }]);
}

/* Save a break name on the actor so the next combatStart can fire its
 * combat-scoped effect. Idempotent — re-banking the same break is a no-op. */
async function bankCombatBreakEffect(actor, breakName) {
    const current = actor.getFlag(SYSTEM_ID, BREAKDOWN_BANKED_FLAG) ?? [];
    if (current.includes(breakName)) return;
    await actor.setFlag(SYSTEM_ID, BREAKDOWN_BANKED_FLAG, [...current, breakName]);
}

/* ─────────── Boons ─────────────────────────────────────────────────────── */

/* Per-boon wiring. Boons with persistent mechanical effects spin up a marker
 * AE (flagged BOON_FLAG so a GM can wipe them via the same kind of helper as
 * breakdowns if desired); instant clears use `clearStress`; stateful boons
 * (Stoic absorbs / Defiant reroll / Hopeful sources) carry a flag the stress
 * pipeline reads. Returns true if the boon owned the stress clear (so the
 * caller skips the default WILL−1 setStress). */
const BOON_CONFIG = Object.freeze({
    "Stoic":          { effect: "absorb",            statusId: "boon-stoic" },
    "Optimistic":     { effect: "clear",             clearAmount: 1,    statusId: "boon-optimistic" },
    "Hopeful":        { effect: "absorb-sources",    statusId: "boon-hopeful" },
    "Defiant":        { effect: "reroll-next-break", statusId: "boon-defiant" },
    "Focused":        { effect: "duration",          statusId: "boon-focused", durationSeconds: 86400, label: "Focused" },
    "Stalwart":       { effect: "clear",             clearAmount: 2,    statusId: "boon-stalwart" },
    "Determined":     { effect: "clear+grit",        clearAmount: 4,    statusId: "boon-determined-grit" },
    "Unbreakable":    { effect: "clear-all+death",   statusId: "boon-unbreakable" },
    "Smile at Death": { effect: "smile",             statusId: "boon-smile-at-death" }
});

/* Absorb flag names — stored on the boon AE so the buffer rides with the
 * effect lifetime. preUpdateActor reads these to compute how much stress to
 * absorb before a raise; updateActor decrements them (or deletes the AE
 * when the buffer is exhausted). Persisting on the AE lets the marker stay
 * until depleted instead of expiring on an arbitrary timer. */
const ABSORB_POINTS_FLAG  = "stressAbsorbPoints";   // Stoic: per-point buffer
const ABSORB_SOURCES_FLAG = "stressAbsorbSources";  // Hopeful: per-source buffer
const REROLL_BREAK_FLAG   = "stressRerollNextBreak"; // Defiant: roll-twice marker

function findActiveAEWithFlag(actor, flagName) {
    if (!actor?.effects) return null;
    for (const ae of actor.effects) {
        if (ae.disabled) continue;
        const v = ae.getFlag(SYSTEM_ID, flagName);
        if (v === undefined || v === null || v === false) continue;
        if (typeof v === "number" && v <= 0) continue;
        return ae;
    }
    return null;
}

/* Decide how much of a stress raise to absorb. Synchronous — runs inside
 * preUpdateActor before the update commits. Returns null if nothing absorbs.
 * Hopeful takes precedence (one event = one source spent for the whole raise);
 * Stoic falls in next (per-point buffer, decrements by the absorbed amount). */
function planAbsorb(actor, delta) {
    if (!(delta > 0)) return null;

    const hopefulAE = findActiveAEWithFlag(actor, ABSORB_SOURCES_FLAG);
    if (hopefulAE) {
        const remaining = Number(hopefulAE.getFlag(SYSTEM_ID, ABSORB_SOURCES_FLAG)) || 0;
        if (remaining > 0) {
            return {
                absorbed: delta,
                boonName: hopefulAE.name,
                hopeful:  { aeId: hopefulAE.id, decrementBy: 1, remaining }
            };
        }
    }

    const stoicAE = findActiveAEWithFlag(actor, ABSORB_POINTS_FLAG);
    if (stoicAE) {
        const remaining = Number(stoicAE.getFlag(SYSTEM_ID, ABSORB_POINTS_FLAG)) || 0;
        const absorbed  = Math.min(remaining, delta);
        if (absorbed > 0) {
            return {
                absorbed,
                boonName: stoicAE.name,
                stoic:    { aeId: stoicAE.id, decrementBy: absorbed, remaining }
            };
        }
    }
    return null;
}

/* Commit the absorb plan after the actor.update completes. Decrements (or
 * deletes when fully spent) the absorb-bearing AEs, and posts chat feedback. */
async function applyAbsorbPlan(actor, plan) {
    if (!plan) return;
    /* Single AE mutation per consume — flag + name re-stamp in one update so
     * the chrome dock badge tooltip ("Stoic (4)") tracks the live buffer
     * count instead of going stale. The setFlag-only approach we had before
     * fired updateActiveEffect for the flag write, dock refreshed its
     * badges, but the cached name still read "(4)" because nothing rewrote
     * it. Now the name regex swaps the trailing "(N)" in place, so the
     * tooltip / future re-renders show the live remaining count. */
    const consume = async (aeId, flag, remaining, decrementBy) => {
        const ae = actor.effects.get(aeId);
        if (!ae) return;
        const next = remaining - decrementBy;
        if (next <= 0) {
            try { await ae.delete(); }
            catch (err) { console.warn(`${SYSTEM_ID} | absorb AE delete failed`, err); }
            return;
        }
        const updateData = { [`flags.${SYSTEM_ID}.${flag}`]: next };
        const renamed = ae.name.replace(/\(\d+\)\s*$/, `(${next})`);
        if (renamed !== ae.name) updateData.name = renamed;
        try { await ae.update(updateData); }
        catch (err) { console.warn(`${SYSTEM_ID} | absorb AE update failed`, err); }
    };
    if (plan.hopeful) await consume(plan.hopeful.aeId, ABSORB_SOURCES_FLAG, plan.hopeful.remaining, plan.hopeful.decrementBy);
    if (plan.stoic)   await consume(plan.stoic.aeId,   ABSORB_POINTS_FLAG,  plan.stoic.remaining,   plan.stoic.decrementBy);

    const detail = plan.hopeful
        ? `1 source spent — ${plan.hopeful.remaining - 1 > 0 ? `${plan.hopeful.remaining - 1} sources left` : "depleted"}`
        : `${plan.stoic.decrementBy} points spent — ${plan.stoic.remaining - plan.stoic.decrementBy > 0 ? `${plan.stoic.remaining - plan.stoic.decrementBy} points left` : "depleted"}`;
    try {
        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            content: `<div style="border-left:3px solid ${BOON_TINT};padding:4px 8px">
                <b>${actor.name}</b> — <b>${plan.boonName}</b> absorbed <b>${plan.absorbed}</b> STRESS<br>
                <small>${detail}</small>
            </div>`
        });
    } catch (_) { /* chat is informational only */ }
}

/* Boon marker AE helper. Every boon — including the ones whose only
 * mechanical effect is a stress clear — drops a marker AE on the actor so
 * the player can see at a glance which boon they rolled. Instant-clear
 * boons get a short native duration so the marker self-cleans after a
 * minute. Flag-based boons (Stoic, Hopeful, Defiant) skip this helper —
 * they create their own AE inline so they can carry the absorb / reroll
 * flag, have no native duration, and persist until their buffer is depleted
 * or their consumer fires. */
const BRIEF_BOON_SECS = 60;

async function createBoonMarkerAE(actor, { name, img, description, statusId, durationSeconds }) {
    const statuses = statusId ? [statusId] : [];
    const changes  = statusId ? statusChanges(statusId) : [];
    // Pull the registered icon from CONFIG.statusEffects when the caller
    // didn't pass one — keeps the FA icon stored against the status id (in
    // setup/statusEffects.mjs) as the single source of truth so every boon
    // marker AE picks up the GM's editor edits automatically.
    let finalImg = img;
    if (!finalImg && statusId) {
        const reg = CONFIG.statusEffects?.find?.(s => s?.id === statusId);
        finalImg = reg?.img;
    }
    await actor.createEmbeddedDocuments("ActiveEffect", [{
        name,
        img: finalImg || `${ICON_DIR}/boon-optimistic.svg`,
        tint: BOON_TINT,
        description,
        disabled: false,
        statuses,
        changes,
        duration: { seconds: durationSeconds, startTime: Number(game.time?.worldTime) || 0 },
        flags: { [SYSTEM_ID]: { [BOON_FLAG]: true } }
    }]);
}

async function applyBoonEffect(actor, boon, { will }) {
    if (!actor || !boon) return false;
    if (!actor.isOwner && !game.user.isGM) return false;
    const cfg = BOON_CONFIG[boon.name];
    if (!cfg) return false;

    const stress = getStress(actor);
    switch (cfg.effect) {
        case "clear": {
            await setStress(actor, stress - cfg.clearAmount);
            await createBoonMarkerAE(actor, {
                name: boon.name, description: boon.effect,
                statusId: cfg.statusId,
                durationSeconds: BRIEF_BOON_SECS
            });
            return true;
        }
        case "clear-all": {
            await setStress(actor, 0);
            await createBoonMarkerAE(actor, {
                name: boon.name, description: boon.effect,
                statusId: cfg.statusId,
                durationSeconds: BRIEF_BOON_SECS
            });
            return true;
        }
        case "clear-all+death": {
            // Unbreakable: clear all stress, plus a 3-turn AE that suppresses
            // BOTH the wound-threshold penalty AND the death-state penalty
            // via the unified `suppress` actions (character.prepareDerivedData
            // reads flags.<sys>.actions[] and toggles suppressWound /
            // suppressDeath). When the AE lands during combat, the actor also
            // banks 3 auto-pass death saves on the AE flag — the death-save
            // pipeline reads it on each save attempt, returns "auto-pass" and
            // decrements until depleted. Duration is rounds-in-combat /
            // seconds-out-of-combat so a 3-turn effect ticks the same span
            // (3 × roundTime seconds) when no combat tracker exists.
            await setStress(actor, 0);
            const inCombat = !!game.combat?.started;
            const roundSecs = Number(CONFIG.time?.roundTime) || 3;
            const duration = inCombat
                ? { rounds: 3 }
                : { seconds: 3 * roundSecs, startTime: Number(game.time?.worldTime) || 0 };
            const flagPayload = {
                [BOON_FLAG]: true,
                actions: [
                    { type: "suppress", what: "wound" },
                    { type: "suppress", what: "death" }
                ]
            };
            if (inCombat) flagPayload.deathSaveAutoPasses = 3;
            await actor.createEmbeddedDocuments("ActiveEffect", [{
                name: boon.name,
                img: `${ICON_DIR}/boon-unbreakable.svg`,
                tint: BOON_TINT,
                description: boon.effect,
                disabled: false,
                statuses: [cfg.statusId],
                changes: [],
                duration,
                flags: { [SYSTEM_ID]: flagPayload }
            }]);
            return true;
        }
        case "absorb":
        case "absorb-sources": {
            // Stoic / Hopeful: the absorb buffer is provisioned by the status
            // engine when this AE lands (it reads the clause's `stressShield`
            // field, rolls the dice, sets the absorb flag, and posts chat).
            // The preUpdateActor gate then consumes the flag on every stress
            // raise — manual dock entry and WILL-save raises alike — and the
            // AE persists until depleted. This case just stamps the marker.
            await setStress(actor, Math.max(0, will + (Number(getStressConfig().postSaveClearOffset) || -1)));
            const img = cfg.effect === "absorb" ? `${ICON_DIR}/boon-stoic.svg` : `${ICON_DIR}/boon-hopeful.svg`;
            await actor.createEmbeddedDocuments("ActiveEffect", [{
                name: boon.name,
                img,
                tint: BOON_TINT,
                description: boon.effect,
                disabled: false,
                statuses: [cfg.statusId],
                changes: [],
                duration: {},
                flags: { [SYSTEM_ID]: { [BOON_FLAG]: true } }
            }]);
            return true;
        }
        case "reroll-next-break": {
            // Defiant: marker AE persists until consumed by runStressCheck
            // on the next break roll (rolls twice, takes the lower / more
            // benign result, then deletes the AE).
            await actor.createEmbeddedDocuments("ActiveEffect", [{
                name: boon.name,
                img: `${ICON_DIR}/boon-defiant.svg`,
                tint: BOON_TINT,
                description: boon.effect,
                disabled: false,
                statuses: [cfg.statusId],
                changes: [],
                duration: {},
                flags: { [SYSTEM_ID]: { [BOON_FLAG]: true, [REROLL_BREAK_FLAG]: true } }
            }]);
            return false;  // default WILL−1 clear still applies
        }
        case "duration": {
            // Focused: persistent AE with status-driven modifier (e.g. +1 to
            // attack). Native worldTime duration set on the AE so it auto-
            // expires after `durationSeconds` of in-game time.
            await actor.createEmbeddedDocuments("ActiveEffect", [{
                name: cfg.label,
                img: `${ICON_DIR}/boon-focused.svg`,
                tint: BOON_TINT,
                description: boon.effect,
                disabled: false,
                statuses: [cfg.statusId],
                changes: statusChanges(cfg.statusId),
                duration: { seconds: cfg.durationSeconds, startTime: Number(game.time?.worldTime) || 0 },
                flags: { [SYSTEM_ID]: { [BOON_FLAG]: true } }
            }]);
            await setStress(actor, Math.max(0, will + (Number(getStressConfig().postSaveClearOffset) || -1)));
            return true;
        }
        case "clear+grit": {
            // Determined (RAW p.???): "You clear 4 STRESS. If in combat AND
            // below wound threshold, you ignore the penalties for 3 turns."
            // Both clauses must hold — out of combat OR above the threshold,
            // the stress clear lands but no suppression AE is created.
            await setStress(actor, stress - cfg.clearAmount);
            const inCombat = !!game.combat?.started;
            const hs = actor.system?.healthState ?? {};
            const belowThreshold = !!(hs.wounded || hs.dying);
            if (inCombat && belowThreshold) {
                await actor.createEmbeddedDocuments("ActiveEffect", [{
                    name: "Determined Grit",
                    img: `${ICON_DIR}/boon-determined-grit.svg`,
                    tint: BOON_TINT,
                    description: "Determined — ignore wound penalties for 3 turns.",
                    disabled: false,
                    statuses: ["boon-determined-grit"],
                    changes: [],
                    duration: { rounds: 3 },
                    flags: { [SYSTEM_ID]: {
                        [BOON_FLAG]: true,
                        actions: [{ type: "suppress", what: "wound" }]
                    } }
                }]);
            }
            return true;
        }
        case "smile": {
            // Smile at Death (RAW): "Clear all STRESS. Ignore all wound
            // penalties until the end of combat. +2d6 temp HP and +2d6 temp
            // STA. +2 REF until end of combat. When combat ends, you are
            // automatically thrown back into death state."
            //
            // Implementation:
            //   • setStress(0).
            //   • Add the rolled temp HP AND temp STA to the actor's pools
            //     (the temp-STA write was previously missing — see audit).
            //   • Spawn an AE with the +2 REF mod (statusChanges) and the
            //     suppress-wound action (RAW only calls out wound penalties,
            //     not death; the AE-end revert handles re-entering death).
            //   • Mark the AE with `smileAtDeath: true` — the deleteCombat
            //     hook below sees the flag, deletes the AE, and zeroes HP
            //     so the next prepare-data pass re-classifies the actor as
            //     `dying`.
            //   • Duration is rounds-in-combat (sentinel 999, deleteCombat
            //     cleans up) / seconds-out-of-combat (3×roundTime as the
            //     RAW 3-turn equivalent, though Smile is fundamentally a
            //     combat boon and seldom rolled outside one).
            await setStress(actor, 0);
            const hpRoll = await new Roll("2d6").evaluate();
            const stRoll = await new Roll("2d6").evaluate();
            const curHpTemp = Number(actor.system?.derivedStats?.hp?.temp)  || 0;
            const curStTemp = Number(actor.system?.derivedStats?.sta?.temp) || 0;
            try {
                await actor.update({
                    "system.derivedStats.hp.temp":  curHpTemp + hpRoll.total,
                    "system.derivedStats.sta.temp": curStTemp + stRoll.total
                });
            } catch (_) { /* swallow — derivedStats may be missing on edge actors */ }
            const inCombat = !!game.combat?.started;
            const roundSecs = Number(CONFIG.time?.roundTime) || 3;
            const duration = inCombat
                ? { rounds: 999 }
                : { seconds: 3 * roundSecs, startTime: Number(game.time?.worldTime) || 0 };
            await actor.createEmbeddedDocuments("ActiveEffect", [{
                name: "Smile at Death",
                img: `${ICON_DIR}/boon-smile-at-death.svg`,
                tint: BOON_TINT,
                description: `${boon.effect} Temp HP +${hpRoll.total}, Temp STA +${stRoll.total}.`,
                disabled: false,
                statuses: ["boon-smile-at-death"],
                changes: statusChanges("boon-smile-at-death"),
                duration,
                flags: { [SYSTEM_ID]: {
                    [BOON_FLAG]: true,
                    smileAtDeath: true,
                    actions: [
                        { type: "suppress", what: "wound" }
                    ]
                } }
            }]);
            await ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor }),
                content: `<i>${actor.name} smiles at Death — Temp HP +<b>${hpRoll.total}</b>, Temp STA +<b>${stRoll.total}</b>.</i>`
            });
            return true;
        }
    }
    return false;
}

export async function clearBreakdownEffects(actor) {
    if (!actor) return;
    if (!actor.isOwner && !game.user.isGM) return;
    // Sweep BOTH the persistent markers AND any combat-scoped sub-effects.
    const ours = actor.effects.filter(isBreakAE);
    if (ours.length) {
        await actor.deleteEmbeddedDocuments("ActiveEffect", ours.map(e => e.id));
    }
    // Clear any banked-for-next-combat list too — stress 0 wipes everything.
    if (actor.getFlag(SYSTEM_ID, BREAKDOWN_BANKED_FLAG)) {
        try { await actor.unsetFlag(SYSTEM_ID, BREAKDOWN_BANKED_FLAG); }
        catch (_) { /* swallow */ }
    }
}

/* ─────────── Combat lifecycle for combat-scoped break effects ──────────── */

/* On combatStart: for each combatant, walk their banked break list and spawn
 * the combat-scoped sub-AE for each. Clear the banked list once consumed. */
async function onCombatStartStressBreaks(combat) {
    if (!game.user?.isActiveGM) return;
    if (!isHomebrewEnabled("stress")) return;
    for (const c of combat.turns ?? []) {
        const actor = c.actor;
        if (!actor) continue;
        const banked = actor.getFlag(SYSTEM_ID, BREAKDOWN_BANKED_FLAG) ?? [];
        if (!banked.length) continue;
        for (const breakName of banked) {
            const ce = BREAK_CONFIG[breakName]?.combatEffect;
            if (!ce) continue;
            // Skip if a combat-scoped sub-AE for this break already exists
            // (defensive — the banked list should be empty during combat,
            // but a manual edit could leave residue).
            const exists = actor.effects.some(
                e => e.getFlag(SYSTEM_ID, BREAKDOWN_COMBAT_FLAG) === breakName
            );
            if (exists) continue;
            await createCombatScopedBreakEffect(actor, breakName, ce);
        }
        try { await actor.unsetFlag(SYSTEM_ID, BREAKDOWN_BANKED_FLAG); }
        catch (_) { /* swallow */ }
    }
}

/* On deleteCombat: tear down every combat-scoped break sub-AE for everyone
 * who was in that combat. The persistent marker AEs stay (counts toward the
 * 8-cap and the experience track) — only the bonus/penalty for THIS combat
 * goes away. */
async function onDeleteCombatStressBreaks(combat) {
    if (!game.user?.isActiveGM) return;
    if (!isHomebrewEnabled("stress")) return;
    const seen = new Set();
    for (const c of combat.turns ?? []) {
        const actor = c.actor;
        if (!actor || seen.has(actor.id)) continue;
        seen.add(actor.id);

        // Sweep combat-scoped break sub-effects (Violent Fury etc.) — the
        // persistent "experienced" markers stay; only the per-combat bonus
        // goes away.
        const subs = actor.effects.filter(e => e.getFlag(SYSTEM_ID, BREAKDOWN_COMBAT_FLAG));
        if (subs.length) {
            try {
                await actor.deleteEmbeddedDocuments("ActiveEffect", subs.map(e => e.id));
            } catch (err) {
                console.warn(`${SYSTEM_ID} | combat-scoped break teardown failed`, err);
            }
        }

        // Smile at Death rider: when combat ends, the actor is "automatically
        // thrown back into death state". Find any AE flagged `smileAtDeath`,
        // delete it (which strips the +2 REF, wound suppression, and the
        // temp HP/STA buffs go away with the AE's changes — though the temp
        // pool VALUES on the actor are not auto-rolled back, since RAW
        // doesn't specify how to unwind them; leave the leftover temp pool
        // to drain naturally / be cleared by the GM), and zero HP so the
        // next prepareDerivedData pass re-classifies the actor as dying.
        const smileAEs = actor.effects.filter(e => e.getFlag(SYSTEM_ID, "smileAtDeath"));
        if (smileAEs.length) {
            try {
                await actor.deleteEmbeddedDocuments("ActiveEffect", smileAEs.map(e => e.id));
                // Force re-entry into death state — zero out base HP AND the
                // temp pool so hpEff drops to 0 and `dying` flips true on
                // next prepare. The actor is then subject to normal death
                // saves on their turn (if any combat resumes).
                await actor.update({
                    "system.derivedStats.hp.value": 0,
                    "system.derivedStats.hp.temp":  0
                });
                await ChatMessage.create({
                    speaker: ChatMessage.getSpeaker({ actor }),
                    content: `<em>${actor.name} — combat ends. <b>Smile at Death</b> claims its due. Thrown back into death state.</em>`
                });
            } catch (err) {
                console.warn(`${SYSTEM_ID} | Smile at Death combat-end revert failed`, err);
            }
        }
    }
}

/* Stress on critical-wound receipt — every level-* wound that LANDS on a
 * character pays out flat stress: simple +1, complex +2, difficult +3,
 * deadly +4. Fires only on `createItem` so moving / deleting / editing the
 * wound after the fact is free: tearing the wound out doesn't refund the
 * stress (RAW intent — the shock of taking it is what hurts, not the
 * lingering damage), and editing the wound's state doesn't re-charge.
 *
 * The grant goes through `grantStress`, which means the absorb gate
 * (Stoic / Hopeful), the chrome dock counter, and the WILL-save pipeline
 * all see it like any other stress raise. So a player wearing a Stoic
 * shield is protected from this stress just like from any other source. */
async function onCreateCriticalWoundStress(item, options, userId) {
    if (game.user.id !== userId) return;
    if (!isHomebrewEnabled?.("stress")) return;
    if (item.type !== "criticalWound") return;
    const actor = item.parent;
    if (!(actor instanceof Actor)) return;
    if (actor.type !== "character") return;
    const cfg = getStressConfig();
    if (!cfg.woundStressEnabled) return;
    const level = String(item.system?.criticalLevel || "").toLowerCase();
    const map = {
        simple:    Number(cfg.woundStressSimple)    || 0,
        complex:   Number(cfg.woundStressComplex)   || 0,
        difficult: Number(cfg.woundStressDifficult) || 0,
        deadly:    Number(cfg.woundStressDeadly)    || 0
    };
    const delta = map[level] || 0;
    if (delta <= 0) return;
    /* Read the attack-message UUID off the wound item — autoApplyCriticalWound
     * stamps it there so the whole stress chain folds into the attack card. */
    const attackMessageUuid = item.getFlag?.(SYSTEM_ID, "attackMessageUuid") ?? null;
    await grantStress(actor, delta, { attackMessageUuid });
    try {
        const label = level.charAt(0).toUpperCase() + level.slice(1);
        const fragment = `<div class="wdm-attack-rider" style="border-left:3px solid ${BREAK_TINT}"><i class="fa-solid fa-brain"></i> <strong>${actor.name}</strong> · <strong>${label}</strong> critical wound — Stress <b>+${delta}</b>.</div>`;
        const attackMsg = attackMessageUuid ? await fromUuid(attackMessageUuid) : null;
        if (attackMsg) {
            /* Static import at file top — see runStressCheck for why. */
            await appendAttackResult(attackMsg, {
                fragment,
                summaryAdd: { label: `${actor.name}: +${delta} Stress`, kind: "stress", icon: "fa-brain" }
            });
        } else {
            await ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor }),
                content: `<div style="border-left:3px solid ${BREAK_TINT};padding:4px 8px">
                    <b>${actor.name}</b> — received <b>${label}</b> critical wound.<br>
                    Stress <b>+${delta}</b> from the shock of the injury.
                </div>`
            });
        }
    } catch (_) { /* chat is informational only */ }
}

/* Wire the combat lifecycle hooks for stress. Called once at setup. */
export function registerStressCombatHooks() {
    Hooks.on("combatStart",  onCombatStartStressBreaks);
    Hooks.on("deleteCombat", onDeleteCombatStressBreaks);
    Hooks.on("createItem",   onCreateCriticalWoundStress);
}

/* ─────────── Hook handlers (wired in hooks.mjs) ─────────────────────────── */

const prevStress = new Map();

/* preUpdateActor — stash the prior stress value so the post-update hook can
 * detect a raise, AND (when homebrew stress is on) consume any active absorb
 * AE (Stoic / Hopeful) BEFORE the increase commits. The absorbed portion is
 * trimmed off `changes.system.stress` in place; the consumption plan is
 * parked in `options.wdmStressAbsorbPlan` for the post-update hook to apply
 * to the AEs. This is the single gate for ALL stress raises — the WILL-save
 * pipeline, manual dock typing, GM-panel edits, and any future caller all
 * route through actor.update and therefore through here. */
export function onPreUpdateActor(actor, changes, options, userId) {
    if (changes?.system?.stress === undefined) return;

    const oldStress = getStress(actor);
    prevStress.set(actor.id, oldStress);

    if (!isHomebrewEnabled?.("stress")) return;
    if (actor.type !== "character") return;

    const newStress = Number(changes.system.stress);
    if (!Number.isFinite(newStress)) return;
    const delta = newStress - oldStress;
    if (delta <= 0) return;

    const plan = planAbsorb(actor, delta);
    if (!plan) return;

    // Trim the absorbed portion off the committed value. Floors at oldStress
    // so a partial absorb still allows the rest of the raise through.
    const adjusted = Math.max(oldStress, newStress - plan.absorbed);

    if (adjusted === oldStress) {
        // FULL absorb — committed value equals the current value, so
        // Foundry's diff is empty and updateActor would NOT fire. Strip the
        // stress field so the no-op write is skipped entirely, and apply
        // the plan via a microtask so the AE buffer still decrements / the
        // AE still deletes when depleted.
        //
        // The dock counter / leftbar / party panel all subscribe to
        // updateActor to refresh their cached vitals. With no native hook
        // firing, those subscribers keep showing the player's optimistically
        // typed value (e.g. "1") until something else triggers a re-render
        // — inventory toggle, an AE change, etc. Fire a synthetic
        // updateActor at the tail of the microtask so they re-pull from
        // server-truth immediately and the player sees the input snap back
        // to the actual stress value.
        delete changes.system.stress;
        Promise.resolve().then(async () => {
            try {
                await applyAbsorbPlan(actor, plan);
                Hooks.callAll("updateActor", actor, {}, {}, game.userId);
            } catch (err) { console.warn(`${SYSTEM_ID} | absorb apply failed`, err); }
        });
        return;
    }

    // PARTIAL absorb — the trimmed value is a real diff; commit it and let
    // onUpdateActor apply the plan via the normal post-update flow.
    changes.system.stress = adjusted;
    options.wdmStressAbsorbPlan = plan;
}

export async function onUpdateActor(actor, changes, options, userId) {
    if (userId !== game.userId) return;
    if (actor.type !== "character") return;
    if (!isHomebrewEnabled("stress")) return;

    // Apply any absorb plan that preUpdateActor staged: decrement the AE's
    // buffer flag, delete it when fully spent, and post a chat receipt. The
    // committed stress value has already been trimmed by the plan, so this
    // is post-hoc bookkeeping only.
    const plan = options?.wdmStressAbsorbPlan;
    if (plan) {
        await applyAbsorbPlan(actor, plan);
        delete options.wdmStressAbsorbPlan;
    }

    const next = changes?.system?.stress;
    if (next === undefined) return;

    const before = prevStress.get(actor.id) ?? next;
    prevStress.delete(actor.id);

    if (Number(next) === 0) {
        await clearBreakdownEffects(actor);
    }
    if (next <= before) return;

    const will = getWill(actor);
    if (next <= will) return;

    /* Forward the attack-message UUID stashed on the update options
     * (set by setStress when called from the crit-wound chain) so the
     * WILL save + break chat fold into the attack card instead of
     * posting standalone messages. */
    const attackMessageUuid = options?.wdmAttackMessageUuid ?? null;
    await runStressCheck(actor, next, will, { attackMessageUuid });
}

/* ─────────── Public API ─────────────────────────────────────────────────── */

/* Read-only absorb preview — same `planAbsorb` the preUpdate gate uses, but
 * exposed for UI prediction (chrome dock tracker shows the post-absorb value
 * on click instead of flashing the raw delta then snapping back). Pure
 * function: no mutation, just returns the plan or null. */
function previewAbsorb(actor, delta) {
    return planAbsorb(actor, delta);
}

export const stressApi = Object.freeze({
    getStress, setStress, grantStress,
    getStressPenalty,
    runStressCheck,
    applyBreakdownEffect, clearBreakdownEffects,
    previewAbsorb,
    tables: { MENTAL_BREAKS, BOONS }
});
