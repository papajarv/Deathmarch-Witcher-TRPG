/**
 * resolveDamage — pure function for the RAW Witcher damage pipeline.
 *
 * Inputs the caller assembles from the attacker / target / source, runs
 * every stage in RAW order, and returns:
 *   - finalDamage     : number applied to HP after all stages
 *   - stages          : an audit log of what happened at each stage (for
 *                       the chat-card breakdown the GM can expand)
 *   - patches         : the diffs the caller must persist
 *                       (HP delta, shield delta, per-armor SP ablation)
 *   - effects         : on-penetrate / on-collapse riders to dispatch
 *
 * The function is intentionally side-effect-free so it's unit-testable and
 * safe to run on the GM client over a socket. Reading the target's current
 * armor SP / shield / monster flags is the CALLER'S job — the calculator
 * doesn't load documents.
 *
 * Pipeline (all stages skip cleanly when their inputs aren't present):
 *
 *   Stages 1–6 operate on weaponDamage only:
 *     1. Basic Quen shield drain        (RAW Core p.114 + errata)
 *     2. Active Shield drain            (RAW Core p.115 + errata)
 *     3. SP subtraction (worn + natural, AP / Improved AP rules)
 *     4. Damage Resistance halve        (typed; bypassed by any AP)
 *     5. Monster non-silver resist      (errata: fire bypasses)
 *     6. Vulnerability ×2
 *
 *   Stages 7–9 operate on the combined total:
 *     7. + critBonus                    (joins AFTER armor/resist stages)
 *     8. × location multiplier          (head ×3, limbs ×½, etc.)
 *     9. Apply to HP                    (patch only — caller commits)
 *
 * If stage 3 fully soaks the weapon damage (and there's no crit bonus),
 * the pipeline returns early — no ablation, no DR/resist math, no HP
 * delta. With a crit bonus present, the pipeline still continues so the
 * armor-bypassing bonus can land. */

/* -------------------------------------------------------------------------- */
/* Defaults                                                                   */
/* -------------------------------------------------------------------------- */

const DEFAULT_LOCATION = Object.freeze({ key: "torso", mult: 1, label: "Torso" });

/** Construct a flat damageSource from whatever fields the caller has,
 *  with safe defaults for everything else.  Used by the calculator AND by
 *  call sites so they don't have to spell out every field. */
export function makeDamageSource(over = {}) {
    return {
        kind:                  over.kind                  ?? "weapon",
        weaponDamage:          Math.max(0, Number(over.weaponDamage) || 0),
        critBonus:             Math.max(0, Number(over.critBonus)    || 0),
        damageTypes:           Array.isArray(over.damageTypes) ? over.damageTypes : [],
        armorPiercing:         !!over.armorPiercing,
        improvedArmorPiercing: !!over.improvedArmorPiercing,
        bypassesWornArmor:     !!over.bypassesWornArmor,
        bypassesNaturalArmor:  !!over.bypassesNaturalArmor,
        bypassesShield:        !!over.bypassesShield,
        tangible:              over.tangible !== false,   // default true
        ablating:              !!over.ablating,
        silverDamage:          Math.max(0, Number(over.silverDamage) || 0),
        isSilver:              !!over.isSilver,
        isMeteorite:           !!over.isMeteorite,
        location:              normalizeLocation(over.location),
        defense:               Array.isArray(over.defense) ? over.defense : [],
        isOngoingTick:         !!over.isOngoingTick
    };
}

function normalizeLocation(loc) {
    if (!loc) return { ...DEFAULT_LOCATION };
    return {
        key:   String(loc.key   ?? DEFAULT_LOCATION.key),
        mult:  Number(loc.mult) || 1,
        label: String(loc.label ?? DEFAULT_LOCATION.label)
    };
}

/** Construct a flat target shape from whatever the caller can resolve.
 *  Anything missing reads as a no-op for the relevant stage. */
export function makeTarget(over = {}) {
    return {
        uuid:           over.uuid ?? "",
        hp:             { value: Number(over.hp?.value) || 0, temp: Number(over.hp?.temp) || 0 },
        shield:         Math.max(0, Number(over.shield) || 0),
        armor:          over.armor          ?? {},   // { [locKey]: { sp, dr: [..], itemIds: [..] } }
        naturalArmor:   over.naturalArmor   ?? {},
        monsterFlags:   {
            resistNonSilver:   !!over.monsterFlags?.resistNonSilver,
            resistNonMeteorite:!!over.monsterFlags?.resistNonMeteorite,
            vulnerableTo:      Array.isArray(over.monsterFlags?.vulnerableTo) ? over.monsterFlags.vulnerableTo : [],
            // Per-type halve (a per-damage-type version of the non-silver
            // resist — e.g. a fiend that's "Resistant: Cold"). Stacks
            // multiplicatively if multiple matching types appear.
            resistTypes:       Array.isArray(over.monsterFlags?.resistTypes)  ? over.monsterFlags.resistTypes  : [],
            // Per-type immunity — incoming damage is zeroed if ANY of the
            // source's types is in this list.
            immuneToTypes:     Array.isArray(over.monsterFlags?.immuneToTypes)? over.monsterFlags.immuneToTypes: [],
            immuneToOrganCrits:!!over.monsterFlags?.immuneToOrganCrits
        },
        activeEffects:  {
            activeShield: over.activeEffects?.activeShield ?? null
        }
    };
}

/* -------------------------------------------------------------------------- */
/* The pipeline                                                               */
/* -------------------------------------------------------------------------- */

/** Run the full damage pipeline. Returns the result + patches + effects. */
export function resolveDamage({ damageSource, target }) {
    const src = makeDamageSource(damageSource ?? {});
    const tgt = makeTarget(target ?? {});

    const stages  = [];
    const patches = {
        hp:           { delta: 0 },
        shield:       { delta: 0 },
        armorAblation:[],
        activeShield: null
    };
    const effects = [];

    let dmg = src.weaponDamage;

    /* ── Stage 1: basic Quen shield drain ────────────────────────────────
     * The shield only drains from attack-time damage whose Defense entry
     * includes "Block" — Aard / Resist Magic / None spells bypass the
     * shield, as do poison / disease / suffocation per-round ticks (RAW
     * Core p.114 + errata). Crit bonus damage is handled separately at
     * stage 7 and never touches the shield. */
    const shieldGate =
        !src.isOngoingTick &&
        !src.bypassesShield &&
        tgt.shield > 0 &&
        dmg > 0 &&
        (src.defense.length === 0           // weapons (no spell defense entry)
         ? src.kind === "weapon" || src.kind === "raw"
         : src.defense.includes("block"));
    if (shieldGate) {
        const drained = Math.min(dmg, tgt.shield);
        stages.push({ stage: "shield", before: dmg, drained, shieldRemaining: tgt.shield - drained });
        patches.shield.delta -= drained;
        dmg -= drained;
    }

    /* ── Stage 2: Active Shield drain (separate AE pool) ─────────────────
     * Active Shield blocks anything tangible (default), with explicit
     * incorporeal magic flipping `tangible: false`. Ongoing ticks (poison
     * etc.) pass through. */
    const activeShield = tgt.activeEffects.activeShield;
    if (activeShield && !src.isOngoingTick && src.tangible && dmg > 0 && (activeShield.hp ?? 0) > 0) {
        const drained = Math.min(dmg, activeShield.hp);
        const after   = activeShield.hp - drained;
        stages.push({ stage: "activeShield", before: dmg, drained, hpRemaining: after });
        patches.activeShield = { hpDelta: -drained };
        dmg -= drained;
        if (after === 0) {
            // RAW collapse rider: push 2m + 1d6 torso to anyone adjacent.
            effects.push({ kind: "activeShieldCollapse", push: 2, dmgFormula: "1d6", location: "torso" });
        }
    }

    /* ── Stage 3: SP subtraction (per-location, AP-aware) ────────────────
     * If SP fully soaks the WEAPON damage AND there's no crit bonus, we
     * stop here — no ablation, no DR/resist stages, no HP delta. With a
     * crit bonus present, weaponDamage falls to 0 but the pipeline keeps
     * going so the armor-bypassing bonus can still land. */
    const locKey   = src.location.key;
    const wornSP   = src.bypassesWornArmor    ? 0 : Number(tgt.armor[locKey]?.sp        ?? 0);
    const naturalSP= src.bypassesNaturalArmor ? 0 : Number(tgt.naturalArmor[locKey]?.sp ?? 0);
    let totalSP    = wornSP + naturalSP;
    if (src.improvedArmorPiercing) totalSP = Math.floor(totalSP / 2);
    if (dmg > 0 && totalSP > 0) {
        if (totalSP >= dmg) {
            stages.push({ stage: "sp", before: dmg, sp: totalSP, soakedAll: true });
            // Soaked. No ablation. weaponDamage path stops; crit bonus can still ride.
            dmg = 0;
            if (src.critBonus === 0) {
                return finish({ stages, patches, effects, finalDamage: 0 });
            }
        } else {
            const after = dmg - totalSP;
            stages.push({ stage: "sp", before: dmg, sp: totalSP, after, ablated: true });
            // Mark every contributing armor item for -1 SP ablation.
            for (const itemId of (tgt.armor[locKey]?.itemIds ?? [])) {
                patches.armorAblation.push({ itemId, spDelta: -1 });
            }
            dmg = after;
        }
    } else if (dmg > 0) {
        // No SP at the location — note for the audit trail but nothing to do.
        stages.push({ stage: "sp", before: dmg, sp: 0, after: dmg });
    }

    /* ── Stage 4: Damage Resistance halve ────────────────────────────────
     * Skipped by ANY AP. Halves once if the worn or natural armor at the
     * location resists ANY of the source's damage types. */
    if (dmg > 0 && !src.armorPiercing && !src.improvedArmorPiercing) {
        const drList = [
            ...(tgt.armor[locKey]?.dr        ?? []),
            ...(tgt.naturalArmor[locKey]?.dr ?? [])
        ];
        const hit = src.damageTypes.some(t => drList.includes(t));
        if (hit) {
            const after = Math.floor(dmg / 2);
            stages.push({ stage: "dr", before: dmg, halved: true, after });
            dmg = after;
        }
    }

    /* ── Stage 5a: Per-type immunity ─────────────────────────────────────
     * If ANY of the source's damage types is in the monster's immunity
     * list, damage is zeroed. Crit bonus still rides past this — bonus
     * damage operates outside stages 1-6. */
    if (dmg > 0 && tgt.monsterFlags.immuneToTypes.length &&
        src.damageTypes.some(t => tgt.monsterFlags.immuneToTypes.includes(t))) {
        stages.push({ stage: "monsterImmune", before: dmg, zeroed: true });
        dmg = 0;
    }

    /* ── Stage 5b: Per-type resist (halve) ───────────────────────────────
     * Halve once if any source type is in the monster's resist list. */
    if (dmg > 0 && tgt.monsterFlags.resistTypes.length &&
        src.damageTypes.some(t => tgt.monsterFlags.resistTypes.includes(t))) {
        const after = Math.floor(dmg / 2);
        stages.push({ stage: "monsterTypeResist", before: dmg, halved: true, after });
        dmg = after;
    }

    /* ── Stage 5c: Monster non-silver resist ─────────────────────────────
     * Half damage from non-silver weapons. Fire bypasses this (errata
     * sidebar). A silver-tagged weapon also bypasses. Stacks with any
     * per-type DR / resist already applied (so a slashing-DR + non-silver
     * monster hit by a steel sword takes 1/4 damage; hit by a silver
     * sword takes 1/2). */
    if (dmg > 0 && tgt.monsterFlags.resistNonSilver && !src.isSilver && !src.damageTypes.includes("fire")) {
        const after = Math.floor(dmg / 2);
        stages.push({ stage: "monsterResist", before: dmg, halved: true, after });
        dmg = after;
    }

    /* ── Stage 5d: Monster non-meteorite resist (optional novel rule p.175) ─
     * Mirror of stage 5c for the alternate weakness category — half
     * damage from non-meteorite weapons. The two flags are independent
     * (a single monster wears only one in RAW, but the engine doesn't
     * enforce that — leaves room for homebrew). */
    if (dmg > 0 && tgt.monsterFlags.resistNonMeteorite && !src.isMeteorite && !src.damageTypes.includes("fire")) {
        const after = Math.floor(dmg / 2);
        stages.push({ stage: "monsterMeteoriteResist", before: dmg, halved: true, after });
        dmg = after;
    }

    /* ── Stage 6: Vulnerability ×2 ───────────────────────────────────────
     * If any source damage type matches the target's vulnerableTo list,
     * double the damage. (Errata: silver doubles automatically against
     * monsters susceptible to silver — wire that via vulnerableTo too.) */
    if (dmg > 0 && src.damageTypes.some(t => tgt.monsterFlags.vulnerableTo.includes(t))) {
        const after = dmg * 2;
        stages.push({ stage: "vulnerability", before: dmg, doubled: true, after });
        dmg = after;
    }

    /* ── Stage 7: + crit bonus ───────────────────────────────────────────
     * Crit bonus damage bypasses SP / DR / shield (handled by not being
     * in stages 1-6). Adds to the weapon damage HERE, then the combined
     * total is multiplied by location mult at stage 8. */
    if (src.critBonus > 0) {
        stages.push({ stage: "critBonus", added: src.critBonus, weaponDamage: dmg, total: dmg + src.critBonus });
        dmg += src.critBonus;
    }

    /* ── Stage 8: Location multiplier ────────────────────────────────────
     * Head ×3, torso ×1, limbs ×½, tail/wing ×½ (Core p.152-154). */
    if (dmg > 0 && src.location.mult !== 1) {
        const after = Math.floor(dmg * src.location.mult);
        stages.push({ stage: "location", before: dmg, mult: src.location.mult, label: src.location.label, after });
        dmg = after;
    }

    /* ── Stage 9: HP patch ───────────────────────────────────────────────*/
    patches.hp.delta = -dmg;

    /* Rider: on-penetrate. We can re-derive "did weapon damage make it
     * past SP?" from whether stage 3 logged `ablated: true`. */
    const penetrated = stages.some(s => s.stage === "sp" && s.ablated);
    if (penetrated) {
        // Caller decides how to dispatch riders; here we just signal that
        // the gate condition was met.
        effects.push({ kind: "onPenetrate" });
    }

    return finish({ stages, patches, effects, finalDamage: dmg });
}

function finish({ stages, patches, effects, finalDamage }) {
    return { stages, patches, effects, finalDamage };
}
