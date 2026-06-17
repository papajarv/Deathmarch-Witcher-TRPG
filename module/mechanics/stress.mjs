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
const BOON_TINT  = "#4a7c59";   // sage green

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
    { min: 10, max: 11, name: "Defiant",        effect: "You've had worse. Is this all they have? Roll twice and take the best on your next mental break roll." },
    { min: 12, max: 14, name: "Focused",        effect: "+1 WA for the rest of the day." },
    { min: 15, max: 16, name: "Stalwart",       effect: "You clear 2 STRESS. You will survive this." },
    { min: 17, max: 18, name: "Determined",     effect: "You clear 4 STRESS. If in combat and below wound threshold, ignore the penalties for 3 turns." },
    { min: 19, max: 19, name: "Unbreakable",    effect: "All your STRESS is cleared. You are resolute. Nothing will stop you." },
    { min: 20, max: 20, name: "Smile at Death", effect: "You make peace with your demise. Clear all STRESS. Ignore wound penalties until combat ends. +2d6 temp HP and STA. +2 REF. When combat ends, thrown back into death state." }
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
/** Penalty to recovery and similar rolls when stress exceeds WILL. */
export function getStressPenalty(actor) {
    return Math.max(0, getStress(actor) - getWill(actor));
}
export async function setStress(actor, val) {
    if (!actor) return;
    return actor.update({ "system.stress": Math.max(0, val) });
}
export async function grantStress(actor, delta) {
    if (!actor) return;
    return setStress(actor, getStress(actor) + delta);
}

/* ─────────── Save flow ──────────────────────────────────────────────────── */

/**
 * Run the WILL save when stress exceeds WILL on an increase.
 * Called from the updateActor hook in hooks.mjs.
 */
export async function runStressCheck(actor, stress, will) {
    if (!isHomebrewEnabled("stress")) return;

    const penalty   = stress - will;
    const threshold = will - penalty;
    const speaker   = ChatMessage.getSpeaker({ actor });

    const saveRoll = await new Roll("1d10").evaluate();
    const nat1     = saveRoll.total === 1;
    const passed   = saveRoll.total <= threshold;

    if (nat1) {
        const tableRoll = await new Roll("1d20").evaluate();
        const boon = lookup(BOONS, tableRoll.total);
        await ChatMessage.create({
            speaker,
            content: buildCard({
                actor, stress, will, penalty, threshold,
                saveRoll: saveRoll.total, header: "NATURAL 1 — BOON",
                colour: "#4a7c59", tableRoll: tableRoll.total, result: boon
            })
        });
        // Boon clears whatever stress its rule says (instant amount, or all);
        // applyBoonEffect handles the per-row stress clear + any AE the boon
        // attaches. The default "save → stress to WILL−1" only applies if the
        // boon doesn't define its own clear.
        const cleared = await applyBoonEffect(actor, boon, { will });
        if (!cleared) await setStress(actor, Math.max(0, will - 1));
        return;
    }

    if (passed) {
        await ChatMessage.create({
            speaker,
            content: `<div style="border-left:3px solid #4a7c59;padding:4px 8px">
                <b>${actor.name}</b> — Stress WILL Save<br>
                Stress <b>${stress}</b> / Will <b>${will}</b> · need ≤ <b>${threshold}</b><br>
                Rolled <b>${saveRoll.total}</b> — <span style="color:#4a7c59"><b>Holds together. Barely.</b></span>
            </div>`
        });
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

    if (owned.size >= MENTAL_BREAKS.length) {
        await ChatMessage.create({
            speaker,
            content: `<div style="border-left:3px solid #4b0000;padding:6px 10px">
                <b>${actor.name}</b> — Stress WILL Save<br>
                Stress <b>${stress}</b> / Will <b>${will}</b> · need ≤ <b>${threshold}</b><br>
                Rolled <b>${saveRoll.total}</b> — <span style="color:#4b0000"><b>NO ROOM LEFT</b></span>
                <hr><i>Every break the mind can take is already taken.
                Control of <b>${actor.name}</b> passes to the GM.</i>
            </div>`
        });
        await setStress(actor, Math.max(0, will - 1));
        return;
    }

    let tableRoll, breakdown;
    for (let i = 0; i < 50; i++) {
        tableRoll = await new Roll("1d20").evaluate();
        breakdown = lookup(MENTAL_BREAKS, tableRoll.total);
        if (breakdown && !owned.has(breakdown.name)) break;
    }

    await ChatMessage.create({
        speaker,
        content: buildCard({
            actor, stress, will, penalty, threshold,
            saveRoll: saveRoll.total, header: "MENTAL BREAK",
            colour: "#8b0000", tableRoll: tableRoll.total, result: breakdown
        })
    });
    await applyBreakdownEffect(actor, breakdown);
    await setStress(actor, Math.max(0, will - 1));
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
const BREAK_CONFIG = Object.freeze({
    "Indulgent":    { },
    "Paranoid":     { },
    "Scared":       { statusId: "break-scared"     },
    "Depressive":   { statusId: "break-depressive" },
    "Impulsive":    { },
    "Self-Harming": { onApply: applySelfHarmDamage },
    "Selfish":      { },
    "Violent":      { combatEffect: { statusId: "break-violent", name: "Violent Fury",
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
        img: "icons/svg/terror.svg",
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
        img: "icons/svg/sword.svg",
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
    "Stoic":          { effect: "absorb", absorbDice: "1d6"           },
    "Optimistic":     { effect: "clear",  clearAmount: 1               },
    "Hopeful":        { effect: "absorb-sources", absorbDice: "2d6"    },
    "Defiant":        { effect: "reroll-next-break"                    },
    "Focused":        { effect: "duration", statusId: "boon-focused", durationSeconds: 86400, label: "Focused" },
    "Stalwart":       { effect: "clear",  clearAmount: 2               },
    "Determined":     { effect: "clear+grit", clearAmount: 4           },
    "Unbreakable":    { effect: "clear-all"                            },
    "Smile at Death": { effect: "smile"                                }
});

async function applyBoonEffect(actor, boon, { will }) {
    if (!actor || !boon) return false;
    if (!actor.isOwner && !game.user.isGM) return false;
    const cfg = BOON_CONFIG[boon.name];
    if (!cfg) return false;

    const stress = getStress(actor);
    switch (cfg.effect) {
        case "clear": {
            await setStress(actor, stress - cfg.clearAmount);
            return true;
        }
        case "clear-all": {
            await setStress(actor, 0);
            return true;
        }
        case "absorb": {
            // Stoic: track a counter in flags; mechanics elsewhere can read
            // `flags.<sys>.stressAbsorbPoints` and decrement on raises. For
            // now park the buffer here; the consumer half is intentionally
            // left out of scope until a follow-up wires it into onUpdateActor.
            const roll = await new Roll(cfg.absorbDice).evaluate();
            await actor.setFlag(SYSTEM_ID, "stressAbsorbPoints", roll.total);
            await ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor }),
                content: `<i>${actor.name} steels themselves — ignores the next ${roll.total} STRESS.</i>`
            });
            await setStress(actor, Math.max(0, will - 1));
            return true;
        }
        case "absorb-sources": {
            const roll = await new Roll(cfg.absorbDice).evaluate();
            await actor.setFlag(SYSTEM_ID, "stressAbsorbSources", roll.total);
            await ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor }),
                content: `<i>${actor.name} sees a way through — ignores the next ${roll.total} sources of STRESS.</i>`
            });
            await setStress(actor, Math.max(0, will - 1));
            return true;
        }
        case "reroll-next-break": {
            await actor.setFlag(SYSTEM_ID, "stressRerollNextBreak", true);
            return false;  // default WILL−1 clear still applies
        }
        case "duration": {
            // Focused: persistent AE with status-driven modifier (e.g. +1 to
            // attack). Native worldTime duration set on the AE so it auto-
            // expires after `durationSeconds` of in-game time.
            await actor.createEmbeddedDocuments("ActiveEffect", [{
                name: cfg.label,
                img: "icons/svg/upgrade.svg",
                tint: BOON_TINT,
                description: boon.effect,
                disabled: false,
                statuses: [cfg.statusId],
                changes: statusChanges(cfg.statusId),
                duration: { seconds: cfg.durationSeconds, startTime: Number(game.time?.worldTime) || 0 },
                flags: { [SYSTEM_ID]: { [BOON_FLAG]: true } }
            }]);
            await setStress(actor, Math.max(0, will - 1));
            return true;
        }
        case "clear+grit": {
            // Determined: clear 4 stress + 3-round AE that suppresses the
            // wound-threshold penalty via the system's existing `suppress`
            // unified action (character.mjs reads flags.<sys>.actions and
            // toggles suppressWound). No custom status / changes needed —
            // the action does all the work.
            await setStress(actor, stress - cfg.clearAmount);
            const inCombat = !!game.combat?.started;
            if (inCombat) {
                await actor.createEmbeddedDocuments("ActiveEffect", [{
                    name: "Determined Grit",
                    img: "icons/svg/regen.svg",
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
            // Smile at Death: clear all stress, +2d6 temp HP, attach an AE
            // that boosts REF (status mod) AND suppresses both wound and
            // death-state penalties via the unified `suppress` action. The
            // "thrown back into death state on combat end" rider isn't wired
            // here — `flags.<sys>.smileAtDeath: true` marks the AE so a
            // follow-up `deleteCombat` hook can find it and roll death.
            await setStress(actor, 0);
            const hp = await new Roll("2d6").evaluate();
            const st = await new Roll("2d6").evaluate();
            const curHp = Number(actor.system?.derivedStats?.hp?.temp) || 0;
            try {
                await actor.update({
                    "system.derivedStats.hp.temp": curHp + hp.total
                });
            } catch (_) { /* swallow */ }
            await actor.createEmbeddedDocuments("ActiveEffect", [{
                name: "Smile at Death",
                img: "icons/svg/lightning.svg",
                tint: BOON_TINT,
                description: `${boon.effect} Temp HP +${hp.total}, Temp STA +${st.total}.`,
                disabled: false,
                statuses: ["boon-smile-at-death"],
                changes: statusChanges("boon-smile-at-death"),
                duration: game.combat?.started ? { rounds: 99 } : { seconds: 3600 },
                flags: { [SYSTEM_ID]: {
                    [BOON_FLAG]: true,
                    smileAtDeath: true,
                    actions: [
                        { type: "suppress", what: "wound" },
                        { type: "suppress", what: "death" }
                    ]
                } }
            }]);
            await ChatMessage.create({
                speaker: ChatMessage.getSpeaker({ actor }),
                content: `<i>${actor.name} smiles at Death — Temp HP +<b>${hp.total}</b>, Temp STA +<b>${st.total}</b>.</i>`
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
        const subs = actor.effects.filter(e => e.getFlag(SYSTEM_ID, BREAKDOWN_COMBAT_FLAG));
        if (!subs.length) continue;
        try {
            await actor.deleteEmbeddedDocuments("ActiveEffect", subs.map(e => e.id));
        } catch (err) {
            console.warn(`${SYSTEM_ID} | combat-scoped break teardown failed`, err);
        }
    }
}

/* Wire the combat lifecycle hooks for stress. Called once at setup. */
export function registerStressCombatHooks() {
    Hooks.on("combatStart",  onCombatStartStressBreaks);
    Hooks.on("deleteCombat", onDeleteCombatStressBreaks);
}

/* ─────────── Hook handlers (wired in hooks.mjs) ─────────────────────────── */

const prevStress = new Map();

export function onPreUpdateActor(actor, changes) {
    if (changes?.system?.stress !== undefined) {
        prevStress.set(actor.id, getStress(actor));
    }
}

export async function onUpdateActor(actor, changes, options, userId) {
    if (userId !== game.userId) return;
    if (actor.type !== "character") return;
    if (!isHomebrewEnabled("stress")) return;

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

    await runStressCheck(actor, next, will);
}

/* ─────────── Public API ─────────────────────────────────────────────────── */

export const stressApi = Object.freeze({
    getStress, setStress, grantStress,
    getStressPenalty,
    runStressCheck,
    applyBreakdownEffect, clearBreakdownEffects,
    tables: { MENTAL_BREAKS, BOONS }
});
