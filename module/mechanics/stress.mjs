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

const SYSTEM_ID = "witcher-ttrpg-death-march";
const BREAKDOWN_FLAG = "stressBreakdown";  // marker on ActiveEffects we own

/* ─────────── Tables ─────────────────────────────────────────────────────── */

const MENTAL_BREAKS = Object.freeze([
    { min: 1,  max: 5,  name: "Indulgent",    effect: "This is too much. You need your vice. You need comfort." },
    { min: 6,  max: 7,  name: "Paranoid",     effect: "Can you really trust anyone but yourself? Are you being watched? Something is out to get you." },
    { min: 8,  max: 9,  name: "Scared",       effect: "You're in danger. Everything is uncertain." },
    { min: 10, max: 11, name: "Depressive",   effect: "Nothing seems to matter that much anymore. What's the point." },
    { min: 12, max: 14, name: "Impulsive",    effect: "Just do something. Anything. Not the time to think about it." },
    { min: 15, max: 16, name: "Self-Harming", effect: "Stupid, stupid, stupid. This is all your fault. You did this." },
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
        await setStress(actor, Math.max(0, will - 1));
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

    // Failure — pick a breakdown not already on the actor
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

export async function applyBreakdownEffect(actor, breakdown) {
    if (!actor || !breakdown) return;
    if (!actor.isOwner && !game.user.isGM) return;
    await actor.createEmbeddedDocuments("ActiveEffect", [{
        name: breakdown.name,
        img: "icons/svg/terror.svg",
        description: breakdown.effect,
        disabled: false,
        duration: {},
        changes: [],
        flags: { [SYSTEM_ID]: { [BREAKDOWN_FLAG]: true } }
    }]);
}

export async function clearBreakdownEffects(actor) {
    if (!actor) return;
    if (!actor.isOwner && !game.user.isGM) return;
    const ours = actor.effects.filter(e => e.getFlag(SYSTEM_ID, BREAKDOWN_FLAG));
    if (!ours.length) return;
    await actor.deleteEmbeddedDocuments("ActiveEffect", ours.map(e => e.id));
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
