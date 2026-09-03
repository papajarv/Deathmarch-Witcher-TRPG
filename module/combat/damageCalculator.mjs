import { t, tFormat } from "../chrome/lib/i18n.js";
import { hrCritBonusNeedsSpBreak } from "../mechanics/house-rules-config.mjs";
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
 *     6. + critBonus (resist-scaled; bypasses armor SP + DR but STILL
 *                     drained by Quen / Active Shield first)
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

const DEFAULT_LOCATION = () => Object.freeze({ key: "torso", mult: 1, label: t("WITCHER.Common.Torso", "Torso") });

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
        /* Non-lethal (pulled blow to Stamina): a controlled, subduing strike.
         * It still soaks through SP/DR for the number, but does NOT wear the
         * target's armor — no base per-hit chip and no Ablating-quality chip.
         * Gates the armor-ablation emit below. */
        nonLethal:             !!over.nonLethal,
        deniesParry:           !!over.deniesParry,
        /* Pre-rolled Ablating SP-chip bonus (1d6/2 — Core p.156). Rolled
         * by handleApplyDamage before the calculator runs so this module
         * stays deterministic and the breakdown can show the exact value. */
        ablatingChipBonus:     Math.max(0, Number(over.ablatingChipBonus) || 0),
        silverDamage:          Math.max(0, Number(over.silverDamage) || 0),
        /* Alchemical oil bonus (matching target category or universal).
         * Folded inside applyNaturalResists AFTER non-silver /
         * non-meteorite halving so oil damage isn't quartered by the
         * "vulnerable only to silver / meteorite" gates — the oil is
         * an alchemical rider, not part of the weapon's mundane blow.
         * oilName / oilTargetLabel are audit-trail metadata surfaced by
         * the breakdown card, purely descriptive. */
        oilBonus:              Math.max(0, Number(over.oilBonus) || 0),
        oilName:               String(over.oilName ?? ""),
        oilTargetLabel:        String(over.oilTargetLabel ?? ""),
        isSilver:              !!over.isSilver,
        newSilverRules:        !!over.newSilverRules,
        isMeteorite:           !!over.isMeteorite,
        location:              normalizeLocation(over.location),
        defense:               Array.isArray(over.defense) ? over.defense : [],
        isOngoingTick:         !!over.isOngoingTick
    };
}

function normalizeLocation(loc) {
    const def = DEFAULT_LOCATION();
    if (!loc) return { ...def };
    return {
        key:   String(loc.key   ?? def.key),
        mult:  Number(loc.mult) || 1,
        label: String(loc.label ?? def.label)
    };
}

/** Construct a flat target shape from whatever the caller can resolve.
 *  Anything missing reads as a no-op for the relevant stage. */
export function makeTarget(over = {}) {
    return {
        uuid:           over.uuid ?? "",
        hp:             { value: Number(over.hp?.value) || 0, temp: Number(over.hp?.temp) || 0 },
        shield:         Math.max(0, Number(over.shield) || 0),
        /* Display name of the cast-shield badge draining `shield` (Quen,
         * Aard Ward, any homebrew shield spell). Purely for the breakdown
         * card — the mechanics are name-agnostic. `null` when no badge
         * exists (i.e. the shield stat carries some non-magic pool). */
        shieldName:     over.shieldName ?? null,
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
            /* `name` piggybacks along so the breakdown can render the
             * actual spell name that spawned this pool. */
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
     * Core p.114 + errata). Crit-bonus damage runs the same drain at
     * stage 6 (shields catch magic-style pool damage regardless of the
     * "crit bypasses armor" carve-out — armor is worn, shield is magic). */
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
        stages.push({ stage: "shield", before: dmg, drained,
                      shieldRemaining: tgt.shield - drained,
                      shieldName: tgt.shieldName });
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
        stages.push({ stage: "activeShield", before: dmg, drained, hpRemaining: after,
                      shieldName: activeShield.name ?? null });
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
     *   silver weapons. Vulnerable → ×2.
     *   Armor Piercing (regular OR improved) negates per-type damage
     *   resistances — whatever damage type the weapon deals that the monster
     *   resists. It does NOT bypass immunity, nor the "half from non-silver" /
     *   "half from non-meteorite" weakness gates. Improved AP additionally
     *   halves armor SP (handled in the SP stage below). */
    function applyNaturalResists(value, { tagPrefix }) {
        if (value <= 0) return value;
        let v = value;
        /* Immunity is absolute — NO armor piercing bypasses it. */
        if (tgt.monsterFlags.immuneToTypes.length
            && src.damageTypes.some(t => tgt.monsterFlags.immuneToTypes.includes(t))) {
            stages.push({ stage: `${tagPrefix}monsterImmune`, before: v, zeroed: true });
            return 0;
        }
        /* Per-type damage resistance (slashing / piercing / bludgeoning / elemental
         * etc.) is negated by EITHER Armor Piercing quality — that's the whole
         * point of AP: "ignore the target's damage resistances". Improved AP does
         * the same here and ALSO halves SP further down. The silver / meteorite
         * weakness gates below are intrinsic and are NOT bypassed by any AP. */
        if (!src.armorPiercing && !src.improvedArmorPiercing
            && tgt.monsterFlags.resistTypes.length
            && src.damageTypes.some(t => tgt.monsterFlags.resistTypes.includes(t))) {
            const after = Math.floor(v / 2);
            stages.push({ stage: `${tagPrefix}monsterTypeResist`, before: v, halved: true, after });
            v = after;
        }
        /* Silver-weakness resolution.
         *
         *   src.isSilver — the weapon is treated as silver (either a
         *   fully-silvered piece OR a silver-quality hybrid). Set via
         *   the "silver" weapon quality's damageFlags.
         *
         *   src.silverDamage — rolled damage from the silver quality's
         *   PARAMETER (e.g. "2d6" silver-inlay portion). Zero for a
         *   solid-silver weapon (no separate inlay portion) — but the
         *   quality still sets isSilver.
         *
         * Cases vs. a monster with resistNonSilver:
         *
         *   1. No silver at all (isSilver=false, silverDamage=0):
         *      base is halved, nothing added → base/2.
         *
         *   2. Hybrid silver-inlay (isSilver=true, silverDamage>0):
         *      base half comes from steel, silver portion adds on top
         *      → base/2 + silverDamage. This is the RAW pattern for
         *      silver-inlay weapons.
         *
         *   3. Solid silver (isSilver=true, silverDamage=0):
         *      full base damage lands, nothing halved → v unchanged.
         *
         * The previous check `!src.isSilver` collapsed cases 2 and 3
         * together, wiping the silver-inlay bonus. Split them by
         * looking at whether a silver PORTION was rolled. */
        const silverPortion = tagPrefix === "" ? Math.max(0, Number(src.silverDamage) || 0) : 0;
        if (v > 0
            && tgt.monsterFlags.resistNonSilver
            && !src.damageTypes.includes("fire")
            && (!src.isSilver || silverPortion > 0)) {
            const halvedBase = Math.floor(v / 2);
            const after      = halvedBase + silverPortion;
            stages.push({
                stage:       `${tagPrefix}monsterResist`,
                before:      v,
                halved:      true,
                halvedBase,
                silverAdded: silverPortion,
                after,
                hybrid:      src.isSilver && silverPortion > 0
            });
            v = after;
        }
        if (v > 0 && tgt.monsterFlags.resistNonMeteorite && !src.isMeteorite && !src.damageTypes.includes("fire")) {
            const after = Math.floor(v / 2);
            stages.push({ stage: `${tagPrefix}monsterMeteoriteResist`, before: v, halved: true, after });
            v = after;
        }
        /* Silver poor-edge (R. Talsorian 7/11/25 rule update). Only fires
         * under the `newSilverRules` house-rule toggle: a silver weapon
         * deals HALF damage to any target that isn't a silver-weak monster.
         * Silver-weak monsters (resistNonSilver) get the FULL hit handled
         * by the branch above. Fire damage bypasses.
         *
         * Meteorite exemption: a weapon that ALSO has the Meteorite quality
         * never eats the silver poor-edge. Meteorite is a superior "works on
         * everyone" material, so against anything the silver edge is bad
         * against — a meteorite-weak monster (handled full by the meteorite
         * gate above) or an ordinary non-monster — the wielder simply strikes
         * with the meteorite edge for FULL damage. Net effect: a silver+
         * meteorite weapon uses whichever material the target is NOT resistant
         * to, and deals normal damage to everyone else. */
        if (v > 0 && src.newSilverRules && src.isSilver && !src.isMeteorite && !tgt.monsterFlags.resistNonSilver && !src.damageTypes.includes("fire")) {
            const after = Math.floor(v / 2);
            stages.push({ stage: `${tagPrefix}silverPoorEdge`, before: v, halved: true, after });
            v = after;
        }
        /* Oil bonus fold moved OUT of this helper — it's now applied AFTER
         * armor SP subtraction (see the block below Stage 5) so the oil
         * only bites when the base weapon damage actually penetrates armor.
         * A fully-soaked hit no longer delivers the oil bonus. */
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
            /* House Rule: "crit bonus needs SP break". When ON, a strike
             * whose base weapon damage was fully soaked by armor also
             * loses its crit bonus — the fiction is that a completely-
             * turned hit doesn't deliver the "kicker" that a solid crit
             * would. RAW keeps crit bonus armor-bypassing regardless;
             * the toggle is off by default. */
            if (src.critBonus === 0 || hrCritBonusNeedsSpBreak()) {
                if (src.critBonus > 0 && hrCritBonusNeedsSpBreak()) {
                    /* Audit chip so the breakdown card explains WHY the
                     * crit bonus vanished — otherwise a spectator sees
                     * "crit landed but did nothing" with no cue. */
                    stages.push({
                        stage: "critBonusSoaked",
                        suppressedCritBonus: src.critBonus,
                        reason: "houseRule.critBonusNeedsSpBreak"
                    });
                }
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
            /* Non-lethal is a pulled blow — it penetrates for the number but
             * doesn't wear armor. Zero out both the base per-hit chip and the
             * Ablating-quality chip, and skip the ablation patches below. */
            const nonLethal    = !!src.nonLethal;
            const baseChip     = nonLethal ? 0 : (src.doubleAblation ? 2 : 1);
            const ablatingChip = nonLethal ? 0 : Math.max(0, Number(src.ablatingChipBonus) || 0);
            const spDelta      = -(baseChip + ablatingChip);
            const spChipped    = !nonLethal;   // RAW: every LETHAL penetrating hit chips SP
            /* Whether any SP actually gets ablated here: worn armor items
             * always chip; natural/monster armor only when its `armorAblates`
             * toggle is on. A monster WITHOUT the Ablate box still soaks with
             * its SP but nothing gets shaved off — so the breakdown must not
             * claim it ablated. Non-lethal never ablates. */
            const wornItemIds    = tgt.armor[locKey]?.itemIds ?? [];
            const naturalAblates = !!tgt.naturalArmor[locKey]?.ablates;
            const armorAblated   = !nonLethal && (wornItemIds.length > 0 || naturalAblates);
            stages.push({
                stage:       "sp",
                before:      dmg,
                sp:          totalSP,
                after,
                ablated:     true,        // penetration flag (see `penetrated` below)
                armorAblated,             // did SP actually get shaved off?
                spChipped,
                spDelta,
                baseChip,
                ablatingChip
            });
            if (!nonLethal) {
                for (const itemId of wornItemIds) {
                    patches.armorAblation.push({ itemId, spDelta });
                }
                /* Natural-armor ablation (monster hide, carapace, etc.).
                 * Only emits when the monster sheet's `armorAblates` toggle
                 * is on — RAW default is a non-ablating natural hide. The
                 * patch has no itemId (naturalArmor is authored on the
                 * actor, not an Item), so the patch handler drains it via
                 * `system.combat.armor` directly. */
                if (naturalAblates) {
                    patches.armorAblation.push({ natural: true, spDelta });
                }
            }
            dmg = after;
        }
    } else if (dmg > 0) {
        // No SP at the location — note for the audit trail but nothing to do.
        stages.push({ stage: "sp", before: dmg, sp: 0, after: dmg });
    }

    /* ── Stage 6: + crit bonus (resist-scaled, armor-bypassing) ──────────
     * Crit bonus damage bypasses worn ARMOR (SP + DR) but is stopped by
     * magic shields the same way weapon damage is (Quen / Active Shield
     * are magic pools, not armor — the fiction is the shield eats the
     * shot regardless of whether it was a "clean hit" or a "critical").
     * It IS modified by the target's natural resistances (monster type
     * immunity / resist / vulnerability shape ALL incoming damage).
     *
     * Order: natural-resist scale first (tagged "crit-" so the audit
     * shows both passes distinctly) → then drain any remaining Quen /
     * Active Shield HP, in that priority — before folding whatever's
     * left onto `dmg`. The shield-drain gates match stages 1 & 2:
     *   - `bypassesShield` skips Quen (same rule as weapon damage).
     *   - `isOngoingTick` / !tangible skip Active Shield.
     *   - `defense.includes("block")` (or weapon-kind fallback) gates
     *     Quen consumption; anything that couldn't drain Quen with
     *     weapon damage also can't drain it with crit bonus. */
    if (src.critBonus > 0) {
        let scaledCrit = applyNaturalResists(src.critBonus, { tagPrefix: "crit-" });
        /* Reuse the exact shield-eligibility test from stage 1. Kept
         * inline (rather than hoisted) so the two passes stay
         * literally identical and can't drift out of sync. */
        const critShieldEligible =
            !src.isOngoingTick &&
            !src.bypassesShield &&
            (src.defense.length === 0
                ? src.kind === "weapon" || src.kind === "raw"
                : src.defense.includes("block"));
        const quenRemaining = tgt.shield + (patches.shield.delta ?? 0);
        if (scaledCrit > 0 && critShieldEligible && quenRemaining > 0) {
            const drained = Math.min(scaledCrit, quenRemaining);
            stages.push({ stage: "critShield", before: scaledCrit, drained,
                          shieldRemaining: quenRemaining - drained,
                          shieldName: tgt.shieldName });
            patches.shield.delta -= drained;
            scaledCrit -= drained;
        }
        const asHp = patches.activeShield?.hpDelta ?? 0;
        const asRemaining = (tgt.activeEffects?.activeShield?.hp ?? 0) + asHp;
        if (scaledCrit > 0 && tgt.activeEffects?.activeShield
            && !src.isOngoingTick && src.tangible && asRemaining > 0) {
            const drained = Math.min(scaledCrit, asRemaining);
            const after   = asRemaining - drained;
            stages.push({ stage: "critActiveShield", before: scaledCrit, drained,
                          hpRemaining: after,
                          shieldName: tgt.activeEffects.activeShield.name ?? null });
            patches.activeShield = { hpDelta: (asHp - drained) };
            scaledCrit -= drained;
            if (after === 0) {
                effects.push({ kind: "activeShieldCollapse", push: 2, dmgFormula: "1d6", location: "torso" });
            }
        }
        stages.push({ stage: "critBonus", added: scaledCrit, weaponDamage: dmg, total: dmg + scaledCrit });
        dmg += scaledCrit;
    }

    /* ── Stage 6b: Oil bonus fold (post-armor, post-crit) ────────────────
     * The oil's category-matched alchemical bonus fires whenever ANY
     * damage got past armor — either the weapon damage penetrated SP
     * (Stage 5) OR the armor-bypassing crit bonus delivered post-shield
     * damage (Stage 6). If everything was fully soaked / drained (dmg is
     * still 0 here) the oil never touched flesh and adds nothing. Flat
     * bonus; independent of natural resists / vulnerabilities (alchemical
     * riders are authored against the target category directly).
     *
     * Note: with the `hrCritBonusNeedsSpBreak` house rule ON, a strike
     * whose weapon damage was fully soaked also loses its crit bonus (via
     * the early return in Stage 5) — the oil rider is therefore skipped
     * too, which matches the fiction: nothing landed. */
    const postArmorOilPortion = Math.max(0, Number(src.oilBonus) || 0);
    if (dmg > 0 && postArmorOilPortion > 0) {
        const after = dmg + postArmorOilPortion;
        stages.push({
            stage:       "oilBonus",
            added:       postArmorOilPortion,
            baseWeapon:  dmg,
            combined:    after,
            oilName:     src.oilName,
            targetLabel: src.oilTargetLabel
        });
        dmg = after;
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
