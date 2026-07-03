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
 *   Pipeline order (RAW: natural resistances → armor → SP → crit → location):
 *     1. Basic Quen shield drain        (RAW Core p.114 + errata)
 *     2. Active Shield drain            (RAW Core p.115 + errata)
 *     3. Natural resistances            (monster immune / type resist /
 *                                        non-silver / non-meteorite / vuln)
 *                                       — apply to weaponDamage AND critBonus,
 *                                        since these are intrinsic monster
 *                                        traits that shape ALL incoming damage.
 *     4. Armor DR halve                 (typed; bypassed by any AP)
 *     5. SP subtraction (worn + natural, AP / Improved AP rules)
 *     6. + critBonus (already resist-scaled at stage 3, bypasses armor)
 *     7. × location multiplier          (head ×3, limbs ×½, etc.)
 *     8. Apply to HP                    (patch only — caller commits)
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
        doubleAblation:        !!over.doubleAblation,
        deniesParry:           !!over.deniesParry,
        /* Pre-rolled Ablating SP-chip bonus (1d6/2 — Core p.156). Rolled
         * by handleApplyDamage before the calculator runs so this module
         * stays deterministic and the breakdown can show the exact value. */
        ablatingChipBonus:     Math.max(0, Number(over.ablatingChipBonus) || 0),
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

    const locKey = src.location.key;

    /* ── Stage 3: Natural resistances ────────────────────────────────────
     * Monster intrinsic traits — type immunity / resist / vulnerability
     * and the silver/meteorite weakness gates. Applied to weaponDamage
     * BEFORE armor. The same helper runs again in stage 6 on the crit
     * bonus, since natural resistances SHAPE all incoming damage while
     * armor stops only base weapon damage.
     *   Immune → zero. Resist → halve. Non-silver resist (non-silver
     *   weapon, target has silver weakness, damage isn't fire) → halve;
     *   silver-damage portion adds ON TOP of the halved base for hybrid
     *   silver weapons. Vulnerable → ×2. Improved AP bypasses immunity
     *   and per-type resist (built to overcome resistant biology) but
     *   NOT the silver/meteorite gates (intrinsic monster defences). */
    function applyNaturalResists(value, { tagPrefix }) {
        if (value <= 0) return value;
        let v = value;
        if (!src.improvedArmorPiercing
            && tgt.monsterFlags.immuneToTypes.length
            && src.damageTypes.some(t => tgt.monsterFlags.immuneToTypes.includes(t))) {
            stages.push({ stage: `${tagPrefix}monsterImmune`, before: v, zeroed: true });
            return 0;
        }
        if (!src.improvedArmorPiercing
            && tgt.monsterFlags.resistTypes.length
            && src.damageTypes.some(t => tgt.monsterFlags.resistTypes.includes(t))) {
            const after = Math.floor(v / 2);
            stages.push({ stage: `${tagPrefix}monsterTypeResist`, before: v, halved: true, after });
            v = after;
        }
        if (v > 0 && tgt.monsterFlags.resistNonSilver && !src.isSilver && !src.damageTypes.includes("fire")) {
            const halvedBase = Math.floor(v / 2);
            // Silver-portion add-on only applies to the base weapon-damage
            // pass, not the crit bonus (bonus damage is untyped).
            const silver = tagPrefix === "" ? Math.max(0, Number(src.silverDamage) || 0) : 0;
            const after  = halvedBase + silver;
            stages.push({
                stage:       `${tagPrefix}monsterResist`,
                before:      v,
                halved:      true,
                halvedBase,
                silverAdded: silver,
                after
            });
            v = after;
        }
        if (v > 0 && tgt.monsterFlags.resistNonMeteorite && !src.isMeteorite && !src.damageTypes.includes("fire")) {
            const after = Math.floor(v / 2);
            stages.push({ stage: `${tagPrefix}monsterMeteoriteResist`, before: v, halved: true, after });
            v = after;
        }
        if (v > 0 && src.damageTypes.some(t => tgt.monsterFlags.vulnerableTo.includes(t))) {
            const after = v * 2;
            stages.push({ stage: `${tagPrefix}vulnerability`, before: v, doubled: true, after });
            v = after;
        }
        return v;
    }
    dmg = applyNaturalResists(dmg, { tagPrefix: "" });

    /* ── Stage 4: Armor DR halve ─────────────────────────────────────────
     * Skipped by ANY AP. Halves once if the worn or natural armor at the
     * location resists ANY of the source's damage types. Applied to
     * post-natural-resist weaponDamage only; crit bonus bypasses armor. */
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

    /* ── Stage 4: SP subtraction (per-location, AP-aware) ────────────────
     * If SP fully soaks the (post-resist) WEAPON damage AND there's no
     * crit bonus, we stop here — no ablation, no monster-resist stages,
     * no HP delta. With a crit bonus present, weaponDamage falls to 0
     * but the pipeline keeps going so the armor-bypassing bonus can
     * still land. */
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
            /* SP ablation (RAW Core p.156).
             *   Default rule: every penetrating hit reduces armor SP by 1.
             *   Crushing Force: doubles the default chip to −2 SP.
             *   Ablating:      adds N SP damage ON TOP of the default,
             *                  where N is rolled OUTSIDE the calculator
             *                  (handleApplyDamage rolls 1d6/2 and stamps
             *                  it on `src.ablatingChipBonus`) so this
             *                  module stays deterministic.
             * Effects compose: a Crushing-Force + Ablating swing lands −2
             * from the doubled base plus the rolled Ablating bonus.
             * `ablated: true` is preserved as the downstream on-penetrate
             * trigger; `spDelta` reports the final chip amount so the
             * breakdown card can show it. */
            const baseChip     = src.doubleAblation ? 2 : 1;
            const ablatingChip = Math.max(0, Number(src.ablatingChipBonus) || 0);
            const spDelta      = -(baseChip + ablatingChip);
            const spChipped    = true;   // RAW: every penetrating hit chips SP
            stages.push({
                stage:       "sp",
                before:      dmg,
                sp:          totalSP,
                after,
                ablated:     true,
                spChipped,
                spDelta,
                baseChip,
                ablatingChip
            });
            for (const itemId of (tgt.armor[locKey]?.itemIds ?? [])) {
                patches.armorAblation.push({ itemId, spDelta });
            }
            dmg = after;
        }
    } else if (dmg > 0) {
        // No SP at the location — note for the audit trail but nothing to do.
        stages.push({ stage: "sp", before: dmg, sp: 0, after: dmg });
    }

    /* ── Stage 6: + crit bonus (resist-scaled, armor-bypassing) ──────────
     * Crit bonus damage bypasses armor (SP + DR + shield) but IS modified
     * by the target's natural resistances — monster type
     * immunity/resist/vulnerability shape ALL incoming damage, not just
     * the base weapon roll. Run the same natural-resist helper on the
     * bonus (tagged "crit-" so the audit shows both passes distinctly),
     * then add the scaled bonus to the post-armor weapon damage. */
    if (src.critBonus > 0) {
        const scaledCrit = applyNaturalResists(src.critBonus, { tagPrefix: "crit-" });
        stages.push({ stage: "critBonus", added: scaledCrit, weaponDamage: dmg, total: dmg + scaledCrit });
        dmg += scaledCrit;
    }

    /* ── Stage 7: Location multiplier ────────────────────────────────────
     * Head ×3, torso ×1, limbs ×½, tail/wing ×½ (Core p.152-154). */
    if (dmg > 0 && src.location.mult !== 1) {
        const after = Math.floor(dmg * src.location.mult);
        stages.push({ stage: "location", before: dmg, mult: src.location.mult, label: src.location.label, after });
        dmg = after;
    }

    /* ── Stage 8: HP patch ───────────────────────────────────────────────*/
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
