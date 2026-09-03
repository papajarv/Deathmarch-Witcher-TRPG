/**
 * Shared test harness for the authored corpus.
 *
 * The adapter is a PROXY that records every method the engine reaches for.
 * That is not a convenience — it is the deliverable. Whatever this thing logs
 * across the whole corpus IS the contract the Foundry adapter has to satisfy,
 * derived from the spells rather than guessed at in advance. The previous
 * engine's interface was written first and half of it was never called.
 *
 * Anything the corpus never touches is not in the contract, and anything it
 * touches that the real adapter lacks is a hole with a name.
 */

import { makeContext, OUTCOME } from "../context.mjs";
import { castFrame } from "../frame.mjs";
import { _resetRegistry, validateSpell } from "../registry.mjs";
import { registerCoreBlocks } from "../blocks/core.mjs";
import { registerDefensiveBlocks } from "../blocks/defensive.mjs";
import { registerEffectBlocks } from "../blocks/effects.mjs";
import { registerKnowledgeBlocks } from "../blocks/knowledge.mjs";
import { registerContestBlocks } from "../blocks/contest.mjs";

export { OUTCOME };

/** Every block set, in the order the live system will register them. */
export function registerAll() {
    _resetRegistry();
    registerCoreBlocks();
    registerDefensiveBlocks();
    registerEffectBlocks();
    registerKnowledgeBlocks();
    registerContestBlocks();
}

/** Method names the proxy has been asked for, across every harness built. */
export const TOUCHED = new Set();
export function _resetTouched() { TOUCHED.clear(); }

const BASE = (over) => ({
    currentStamina: () => over.stamina ?? 60,
    currentHealth:  () => over.health ?? 60,
    vigorThreshold: () => over.vigor ?? 20,
    chaosSpentThisRound: () => over.chaosSpent ?? 0,
    skillValue: (_a, k) => over.skills?.[k] ?? 7,
    casterElement: () => over.casterElement ?? "mixed",
    isWitcher: () => !!over.witcher,
    knowsSpell: () => !!over.knows,

    distanceBetween: async () => over.distance ?? 0,
    hasActiveInstance: async () => !!over.activeInstance,
    promptStamina: async (_a, c) => over.sta ?? c.max ?? c.min ?? 1,
    promptBand: async (_a, bands) => over.band ?? Number(Object.keys(bands)[0]),
    applyFocusDiscount: async (_a, c) => c,
    spendStamina: async () => {},
    spendHealth: async () => {},
    commitChaos: async () => {},
    /* An area spell now ALWAYS aims, so this stands in for the template: it
     * catches whoever the test placed in front of the caster. Returning []
     * here would mean every area spell in the suite resolved against nobody —
     * which is what a real template returns only when the cone is empty. */
    pickTargets: async () => over.caught ?? [],

    rollCast: async () => over.roll ?? { total: 20, natural: 8, fumbleBy: 0 },
    requestDefence: async () => ({ option: null, total: over.defence ?? 9, fumbled: !!over.defenceFumbled }),
    confirmCondition: async () => !!over.conditionHolds,
    /* Mirrors the adapter's richer answer; `over.percentileHits` still drives
     * the verdict so every existing spell test keeps its meaning. */
    rollPercentile: async (chance) => ({ passed: over.percentileHits ?? true,
                                         roll: over.percentileRoll ?? null,
                                         chance: Math.round(Number(chance) || 0) }),
    rollFormula: async (f) => (typeof f === "number" ? f : (over.formulaResult ?? 10)),
    applyFumble: async () => {},

    applyDamage: async () => {},
    applyStatus: async () => {},
    removeStatus: async () => {},
    heal: async () => {},
    drainResource: async () => {},
    grantModifier: async () => ({ id: "m1" }),
    removeModifier: async () => {},
    createShield: async () => {},
    createObject: async (_a, o) => ({ id: "o1", ...o }),
    removeObject: async () => {},
    createZone: async (_a, z) => ({ id: "z1", ...z }),
    removeZone: async () => {},
    registerSave: async () => {},
    scheduleEachRound: async (_a, s) => { if (over.runClockOnce !== false) await s.run(); },
    summonCopies: async (_a, o) => ({ id: "s1", ...o }),
    removeSummon: async () => {},

    beginConcentration: async () => {},
    releaseConcentration: async () => {},

    chooseOption: async (_a, o) => ("choice" in over ? over.choice : (o.choices[0] ?? null)),
    revealInfo: async (_a, o) => ({ about: o.about }),
    narrate: async () => {},
    magicOn: async () => over.standingMagic ?? [],
    rollDefenceSkill: async () => over.defence ?? 9,
    knockback: async () => ({ struck: !!over.struckSomething }),
    targetHas: async () => over.targetHas ?? true,
    environmentIs: async () => over.environmentIs ?? true,
    onDeflect: async () => {},
    askDC: async () => over.gmDC ?? 15,
    nearestTargets: async () => over.nearest ?? [{ name: "Nearest" }],
    scheduleAfter: async (_a, s) => { if (over.runDelay !== false) await s.run(); },
    statValue: async (_a, st) => over.stats?.[st] ?? 5,
    grantPool: async () => ({ id: "p1" }),
    removePool: async () => {},
    counteract: async (_a, o) => ({ tag: o.tag }),
    removeCounteract: async () => {},
    endMagic: async () => {}
});

/**
 * Build a recording adapter and the bags it writes into.
 *
 * `log` holds `[method, ...args]` for the calls worth asserting on. `TOUCHED`
 * accumulates every name the engine reached for across the whole run,
 * including ones it probed with `?.` and found missing.
 */
export function makeHarness(over = {}) {
    const log = [], zones = [], clocks = [];
    const ad = harnessInto(log, zones, clocks, over);
    return { ad, log, zones, clocks };
}

function harnessInto(log, zones, clocks, over) {
    const base = BASE(over);
    const name = (a) => a?.name ?? "?";
    Object.assign(base, {
        applyDamage: async (t, n, o = {}) => { log.push(["damage", name(t), n, o.damageType ?? null, !!o.bypassArmour]); },
        applyStatus: async (t, s) => { log.push(["status", name(t), s]); },
        heal: async (t, n) => { log.push(["heal", name(t), n]); },
        drainResource: async (t, r, n) => { log.push(["drain", name(t), r, n]); },
        grantModifier: async (t, m) => { log.push(["mod", name(t), m.stat, m.delta, m.record]); return { id: "m1" }; },
        createObject: async (_a, o) => { log.push(["object", o.what, o.hp, o.sp]); return { id: "o1", ...o }; },
        createShield: async (_a, o) => { log.push(["shield", o.hp]); },
        createZone: async (_a, z) => { log.push(["zone", z.shape, z.size]); zones.push(z); return { id: "z1", ...z }; },
        registerSave: async (t, s) => { log.push(["save", name(t), s.skill, s.dc]); },
        summonCopies: async (_a, o) => { log.push(["summon", o.what, o.count]); return { id: "s1", ...o }; },
        revealInfo: async (_a, o) => { log.push(["reveal", o.about, o.to]); return { about: o.about }; },
        narrate: async (_a, o) => { log.push(["narrate", o.scale]); },
        chooseOption: async (_a, o) => { log.push(["choose", o.choices.length]);
            return "choice" in over ? over.choice : (o.choices[0] ?? null); },
        beginConcentration: async (_a, o) => { log.push(["upkeep", o.perRound]); },
        endMagic: async (t, e) => { log.push(["endMagic", name(t), e.id ?? null]); },
        requestDefence: async (_t, o) => { log.push(["defence", o.bonus]);
            return { option: null, total: over.defence ?? 9, fumbled: !!over.defenceFumbled }; },
        knockback: async (t, o) => { log.push(["knockback", name(t), o.metres, o.onImpact]); return { struck: !!over.struckSomething }; },
        rollDefenceSkill: async (t, sk) => { log.push(["defenceRoll", name(t), sk]); return over.defence ?? 9; },
        targetHas: async (t, tr) => { log.push(["has", name(t), tr]); return over.targetHas ?? true; },
        removeStatus: async (t, st) => { log.push(["unstatus", name(t), st]); },
        /* The dice EXPRESSION is what several entries are actually about —
         * Alzur's falloff, Igni's per-stamina scaling, Cenlly Graig's cap. It
         * is only ever visible here, so the harness records it. */
        confirmCondition: async (t, c) => { log.push(["condition", c.condition]); return !!over.conditionHolds; },
        rollFormula: async (f) => { log.push(["formula", f]); return typeof f === "number" ? f : (over.formulaResult ?? 10); },
        counteract: async (_a, o) => { log.push(["counteract", o.tag]); return { tag: o.tag }; },
        askDC: async () => { log.push(["askDC"]); return over.gmDC ?? 15; },
        nearestTargets: async (_a, o) => { log.push(["nearest", o.of]); return over.nearest ?? [{ name: "Nearest" }]; },
        statValue: async (t, st) => { log.push(["stat", name(t), st]); return over.stats?.[st] ?? 5; },
        grantPool: async (t, o) => { log.push(["pool", name(t), o.resource, o.size]); return { id: "p1" }; },
        scheduleAfter: async (_a, s) => { log.push(["delay", s.rounds]); if (over.runDelay !== false) await s.run(); },
        scheduleEachRound: async (_a, s) => { clocks.push(s); log.push(["schedule", s.rounds]); if (over.runClockOnce !== false) await s.run(); }
    });
    return new Proxy(base, {
        get(target, prop) {
            if (typeof prop === "string") TOUCHED.add(prop);
            return target[prop];
        }
    });
}

/** Cast one authored entry. Returns the finished context plus the log. */
export async function castOne(spell, over = {}, targets = [{ name: "Target" }]) {
    /* The fake template catches whatever the test put in front of the caster,
     * unless the test says otherwise — `caught: []` is how you write "the cone
     * landed on nobody". */
    const { ad, log, zones, clocks } = makeHarness({ caught: targets, ...over });
    const ctx = makeContext({
        actor: over.caster ?? { name: "Caster" },
        item: { name: spell.name },
        frame: spell.frame, adapter: ad, targets, trees: spell.on
    });
    if (spell.frame.cost.mode === "derived") ctx.dispelTarget = over.dispelTarget ?? null;
    await castFrame(ctx, spell.on);
    return { ctx, log, zones, clocks, ad };
}

/** Validate every entry tree of one authored spell. */
export function problemsIn(spell) {
    return validateSpell(spell);
}
