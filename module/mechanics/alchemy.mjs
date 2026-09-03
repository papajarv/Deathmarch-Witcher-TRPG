/**
 * Alchemy mechanic — porting witcher-alchemy-craft's API into the
 * unified system. Exposed at `game.system.api.alchemy.*`.
 *
 * Homebrew (ADR 0003): everything gates on
 * `isHomebrewEnabled("alchemyPotency")`. With it off, the API still
 * resolves shapes but `craftWith` is a no-op.
 *
 * Data location:
 *   - Base items (valuable / alchemical with potion/oil/bomb baseType):
 *       valuable.system.alchemyBase.{baseType, baseMod, quality}
 *       alchemical.system.{baseType, baseMod}
 *   - Diagram thresholds + outputs:
 *       diagrams.system.{potencyNormal/Enhanced/Superior,
 *                         outputNormal/Enhanced/Superior,
 *                         outputNormalName/...Name,
 *                         memorizedFrom, learned}
 *   - Ingredient potency:
 *       component.system.potency
 *       mutagen.system.{potency, substance} — substance also from substanceType
 *
 * Charges live on:
 *   - valuable.system.charges (when subtype food-drink)
 *   - alchemical.system.charges (legacy alchemy-craft + food-and-drink)
 *
 * Phase 8: read-only helpers + craftWith. UI dialogs (memorize/forget,
 * configure-base, coat-weapon, brew dialog) live in chrome port.
 */

import { isHomebrewEnabled } from "../api/homebrew.mjs";
import { BASE_TYPES, SUBSTANCES } from "../setup/alchemyConsts.mjs";

import { t, tFormat } from "../chrome/lib/i18n.js";
const SYSTEM_ID = "witcher-ttrpg-death-march";

/* ─────────── Read-only helpers ──────────────────────────────────────────── */

/**
 * Resolve the base subschema for a given item.
 * Returns { baseType, baseMod, quality } even if the item has no base.
 *
 * Storage layout (Alchemy Reborn):
 *   alchemical : sys.alchemyBase.{enabled, baseType, baseMod}
 *                (formalized schema field). Legacy top-level
 *                sys.{baseType, baseMod} from witcher-alchemy-craft is
 *                migrated to the nested shape by AlchemicalData.migrateData;
 *                read here as a fallback so a half-migrated item still
 *                resolves correctly.
 *   food       : sys.alchemyBase.{enabled, baseType, baseMod}
 *                (drinks → potion bases, ingredients → bomb / decoction
 *                bases; the kind / baseType pairing is GM-set).
 *   valuable   : sys.alchemyBase.{baseType, baseMod, quality}
 *                Defensive read — there's no formal schema on valuables,
 *                but pre-existing data from earlier code paths might
 *                still exist.
 *
 * `enabled === false` collapses to baseType="" (and therefore quietly
 * drops the base from the wheel) — gives the GM a quick switch without
 * having to clear the baseType string. */
function readBase(item) {
    const sys = item?.system;
    if (!sys) return { baseType: "", baseMod: 0, quality: "" };
    // alchemical / food / component share the enable-gated schema shape
    // (alchemyBase.{enabled, baseType, baseMod}). Component was added so
    // raw ingredients (Saltpetre → bomb, dry-substance vodka → potion,
    // etc.) can serve as brew bases in Alchemy Reborn.
    if (item.type === "alchemical" || item.type === "food" || item.type === "component") {
        const ab = sys.alchemyBase;
        // Honor the explicit enable toggle; without it (or false) the
        // base doesn't surface even if a baseType was authored.
        if (ab && ab.enabled !== false && ab.baseType) {
            return {
                baseType: String(ab.baseType ?? ""),
                baseMod:  Number(ab.baseMod) || 0,
                quality:  String(ab.quality ?? "")
            };
        }
        // Legacy alchemical: top-level baseType/baseMod, no nesting.
        // Pre-AlchemicalData.migrateData state; once the doc has been
        // saved through Foundry once the migration runs and the nested
        // path wins above.
        if (item.type === "alchemical" && sys.baseType) {
            return {
                baseType: String(sys.baseType ?? ""),
                baseMod:  Number(sys.baseMod) || 0,
                quality:  String(sys.quality ?? "")
            };
        }
        return { baseType: "", baseMod: 0, quality: "" };
    }
    if (item.type === "valuable") {
        return {
            baseType: sys.alchemyBase?.baseType ?? "",
            baseMod:  sys.alchemyBase?.baseMod  ?? 0,
            quality:  sys.alchemyBase?.quality  ?? ""
        };
    }
    return { baseType: "", baseMod: 0, quality: "" };
}

export function isBaseOfType(item, type) {
    return readBase(item).baseType === type;
}

export function getBaseMod(item) {
    return readBase(item).baseMod || 0;
}

/**
 * Charges as { current, max } or null if untracked.
 * Reads valuable.system.charges or alchemical.system.charges.
 */
export function getBaseChargeInfo(item) {
    const c = item?.system?.charges;
    if (!c || !Number.isFinite(c.max) || c.max <= 0) return null;
    return { current: c.current ?? 0, max: c.max };
}

/**
 * Map a formula (diagram item or string label) to its canonical base
 * category. 'oil', 'bomb', and 'alchemical' pass through; everything else
 * → 'potion' (decoctions brew off potion bases). 'alchemical' is a base-less
 * category, so getAvailableBases returns [] for it (its else branch).
 */
export function detectFormulaCategory(formulaOrCategory) {
    const t = typeof formulaOrCategory === "string"
        ? formulaOrCategory
        : (formulaOrCategory?.system?.type ?? "potion");
    if (t === "oil" || t === "bomb" || t === "alchemical") return t;
    return "potion";
}

/** "+2" / "-2" / "0". Negative mods don't get the unary minus duplicated. */
export function formatBaseModForDisplay(modOrItem) {
    const n = typeof modOrItem === "number" ? modOrItem : getBaseMod(modOrItem);
    if (!Number.isFinite(n)) return "0";
    if (n === 0) return "0";
    return n > 0 ? `+${n}` : String(n);
}

/**
 * Compute effective DC for a diagram + base pairing.
 * effectiveDC = baseDC + (memorized ? 0 : -2) + baseMod.
 *
 * Having the physical formula in your book (memorized = false) grants
 * -2 DC for the reference material. A memorized-only clone with no
 * physical book gives no discount. This matches the "from book (−2)"
 * label the crafting panel shows and the alchemy-craft canonical
 * helper — both treat the book as the source of the -2, not the
 * memorization itself. An earlier revision here had the sign inverted,
 * which flipped the effective DC by 2 in the "have the formula, not
 * memorized" case that most players hit — the panel promised -2 but
 * the roll used raw.
 */
export function computeEffectiveDC(diagram, baseItem, { memorized } = {}) {
    if (!diagram) return Infinity;
    const sys = diagram.system ?? {};
    const baseDC = sys.alchemyDC ?? sys.craftingDC ?? 12;
    const memorizedActual = typeof memorized === "boolean"
        ? memorized
        : (sys.learned ?? false);
    const dc = baseDC + (memorizedActual ? 0 : -2) + getBaseMod(baseItem);
    return dc;
}

/** Predict quality tier from total ingredient potency. */
export function qualityFromPotency(totalPotency, thresholds) {
    if (!Number.isFinite(totalPotency)) return null;
    const t = thresholds ?? {};
    if (Number.isFinite(t.potencySuperior) && totalPotency >= t.potencySuperior) return "Superior";
    if (Number.isFinite(t.potencyEnhanced) && totalPotency >= t.potencyEnhanced) return "Enhanced";
    if (Number.isFinite(t.potencyNormal)   && totalPotency >= t.potencyNormal)   return "Normal";
    return null;
}

export function qualityColour(quality) {
    switch (quality) {
        case "Superior": return "#7ec8e3";
        case "Enhanced": return "#d4af37";
        case "Normal":   return "#a8d5a2";
        default:         return "#c0392b";
    }
}

/** Flat read of diagram-side alchemy fields. */
export function getDiagramFlags(diagram) {
    const sys = diagram?.system ?? {};
    return {
        /* Normal tier output is the same field as the diagram's Produced
         * Item (system.associatedItem.uuid) — Phase-1 of Alchemy Reborn
         * collapsed the standalone outputNormal field into associatedItem
         * so legacy diagrams automatically have a Normal slot. Enhanced
         * and Superior remain on their own UUID-only string fields. */
        outputNormal:    sys.associatedItem?.uuid ?? "",
        outputEnhanced:  sys.outputEnhanced  ?? "",
        outputSuperior:  sys.outputSuperior  ?? "",
        potencyNormal:   sys.potencyNormal   ?? 0,
        potencyEnhanced: sys.potencyEnhanced ?? 0,
        potencySuperior: sys.potencySuperior ?? 0,
        memorized:       sys.learned          ?? false
    };
}

/** Potency value on a component / mutagen. */
export function getIngredientPotency(item) {
    return item?.system?.potency ?? 0;
}

/* Human-readable summary of an item's Alchemy Reborn base configuration.
 * Returns null when the item isn't a brew base (or the toggle is off);
 * otherwise returns { typeLabel, modSigned, summary, key } where:
 *   typeLabel : localized base-type name ("Potion / Decoction base", …)
 *   modSigned : signed string of the DC modifier ("+1" / "-2" / "0")
 *   summary   : composed display line ("Potion / Decoction · -2 DC")
 *   key       : the bare baseType key (used by callers for theming, e.g.
 *               colour-coding the badge by base category).
 * Used by item sheets and the inventory inspect window so the same line
 * reads identically across surfaces. */
export function baseSummaryFor(item) {
    const { baseType, baseMod } = readBase(item);
    if (!baseType) return null;
    const typeKey = `WITCHER.AlchemyReborn.Base.Type.${
        baseType.charAt(0).toUpperCase() + baseType.slice(1)
    }`;
    const typeLabel = game.i18n?.localize?.(typeKey) ?? baseType;
    const n = Number(baseMod) || 0;
    const modSigned = n > 0 ? `+${n}` : (n === 0 ? "0" : String(n));
    const summary = game.i18n?.format?.(
        "WITCHER.AlchemyReborn.Base.Display.Summary",
        { type: typeLabel, mod: modSigned }
    ) ?? `${typeLabel} · ${modSigned} DC`;
    return { typeLabel, modSigned, summary, key: baseType };
}

/** Substance the ingredient provides. Reads three storage paths in priority
 *  order (canonical, legacy alias, upstream alchemy-craft flag) so compendium
 *  components carrying the substance on the flag — common for Witcher core
 *  packs — still resolve. Lowercased so substance map lookups are
 *  case-insensitive. */
export function getIngredientSubstance(item) {
    if (!item?.system) return "";
    const sub = item.system.substanceType
            || item.system.substance
            || item.flags?.["witcher-alchemy-craft"]?.substance
            || "";
    return String(sub).toLowerCase();
}

/**
 * True when a base item passes the 50%-charge gate. Un-tracked bases
 * (charges.max ≤ 0) always pass — they're single-use items that get
 * decremented by quantity rather than by charge. Charged bases must
 * carry at least ceil(max/2) charges to be legal picks.
 */
function passesChargeGate(item) {
    const ch = getBaseChargeInfo(item);
    if (!ch || ch.max <= 0) return true;
    return ch.current >= Math.ceil(ch.max / 2);
}

/**
 * Bases available on the actor for a given formula category. The
 * 50%-charge gate now applies uniformly across potion / oil / bomb —
 * a charged bomb base (e.g. a food-item bomb precursor) is only legal
 * at ≥ half charges. Legacy named-component oils (dog tallow, bear
 * fat) pass because they have no tracked charges.
 */
export function getAvailableBases(actor, formulaOrCategory) {
    if (!actor?.items) return [];
    const cat = detectFormulaCategory(formulaOrCategory);

    const bases = [];
    for (const item of actor.items) {
        if (cat === "oil") {
            const legalType = isBaseOfType(item, "oil")
                || (item.type === "component"
                    && /(dog tallow|bear fat)/i.test(item.name));
            if (!legalType) continue;
        } else if (cat === "potion") {
            if (!isBaseOfType(item, "potion")) continue;
        } else if (cat === "bomb") {
            if (!isBaseOfType(item, "bomb")) continue;
        } else {
            continue;
        }
        if (!passesChargeGate(item)) continue;
        bases.push(item);
    }
    return bases.sort((a, b) => a.name.localeCompare(b.name));
}

/* ─────────── Craft entry point ──────────────────────────────────────────── */

/**
 * Headless crafting entry. Validates substances + components, rolls
 * alchemy, consumes ingredients + base regardless of outcome, awards the
 * output on success. Returns a failure snapshot so the caller can offer
 * recovery (homebrew "craftingRecovery").
 *
 * @param {Actor}  actor
 * @param {Item}   diagram   — type 'diagrams'
 * @param {object} choices   — { baseId, ingredients: [{ id, qty }] }
 * @returns {Promise<{pass: boolean, dc: number, quality?: string, output?: Item, snapshots?: object[]}>}
 */
export async function craftWith(actor, diagram, choices = {}) {
    if (!isHomebrewEnabled("alchemyPotency")) {
        ui.notifications?.info(t("WITCHER.Mech.Alchemy.Notify.AlchemyPotencySystemIsDisabledHomebrew", "Alchemy potency system is disabled (homebrew off)."));
        return { pass: false, dc: 0 };
    }
    if (!actor || !diagram) return { pass: false, dc: 0 };

    const baseItem = actor.items.get(choices.baseId);
    if (!baseItem) {
        ui.notifications?.warn(t("WITCHER.Mech.Alchemy.Notify.SelectABase", "Select a base."));
        return { pass: false, dc: 0 };
    }

    const ingredients = (choices.ingredients ?? [])
        .map(({ id, qty }) => ({ item: actor.items.get(id), qty: Number(qty) || 0 }))
        .filter(x => x.item && x.qty > 0);
    if (!ingredients.length) {
        ui.notifications?.warn(t("WITCHER.Mech.Alchemy.Notify.SelectAtLeastOneIngredient", "Select at least one ingredient."));
        return { pass: false, dc: 0 };
    }

    // Substance / component requirement check
    const required = diagram.system.alchemyComponents ?? {};
    const provided = {};
    for (const { item, qty } of ingredients) {
        const sub = getIngredientSubstance(item).toLowerCase();
        if (sub) provided[sub] = (provided[sub] ?? 0) + qty;
    }
    const shortfalls = [];
    for (const [sub, need] of Object.entries(required)) {
        const have = provided[sub.toLowerCase()] ?? 0;
        if (have < need) shortfalls.push(`${need - have} ${sub}`);
    }
    if (shortfalls.length) {
        ui.notifications?.warn(tFormat("WITCHER.Mech.Alchemy.Notify.MissingComponents", { list: shortfalls.join(", ") }, "Missing components: {list}."));
        return { pass: false, dc: 0 };
    }

    // Compute quality from total potency
    const totalPotency = ingredients.reduce(
        (s, { item, qty }) => s + getIngredientPotency(item) * qty, 0
    );
    const flags = getDiagramFlags(diagram);
    const quality = qualityFromPotency(totalPotency, flags);
    if (!quality) {
        ui.notifications?.warn(tFormat("WITCHER.Mech.Alchemy.Notify.PotencyBelow", { potency: totalPotency }, "Total potency {potency} doesn't meet any quality threshold."));
        return { pass: false, dc: 0 };
    }
    const outputUuid = flags[`output${quality}`];
    if (!outputUuid) {
        ui.notifications?.warn(tFormat("WITCHER.Mech.Alchemy.Notify.NoOutputItemConfiguredForX", { quality: quality }, "No output item configured for {quality} quality."));
        return { pass: false, dc: 0 };
    }

    // Snapshot ingredients for recovery
    const snapshots = ingredients.map(({ item, qty }) => ({
        ...item.toObject(),
        consumedQty: qty
    }));

    // Roll alchemy
    const dc = computeEffectiveDC(diagram, baseItem);
    const roll = await actor.rollSkillCheck?.("alchemy", dc);
    const pass = (roll?.total ?? 0) >= dc;

    // Consume ingredients regardless of outcome
    for (const { item, qty } of ingredients) {
        const newQty = (item.system.quantity ?? 1) - qty;
        if (newQty <= 0) await item.delete();
        else await item.update({ "system.quantity": newQty });
    }
    // Consume base
    await consumeBase(baseItem);

    if (!pass) {
        return { pass: false, dc, snapshots };
    }

    // Award output
    let output = null;
    try {
        const proto = await fromUuid(outputUuid);
        if (proto) {
            const [created] = await actor.createEmbeddedDocuments("Item", [proto.toObject()]);
            output = created;
        }
    } catch (err) {
        console.warn(`${SYSTEM_ID} | failed to award alchemy output`, err);
    }

    ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: tFormat(
            "WITCHER.Mech.Alchemy.Chat.BrewedItem",
            { actor: actor.name, item: output?.name ?? t("WITCHER.Mech.Alchemy.Text.AnItem", "an item"), colour: qualityColour(quality), quality, potency: totalPotency, dc, base: baseItem.name },
            "<h3>{actor} brewed {item}</h3><div style=\"color:{colour}\"><b>{quality}</b> quality · potency {potency} · DC {dc} · base {base}</div>"
        )
    });

    return { pass: true, dc, quality, output };
}

/**
 * Consume a base after a brew resolves. Applies to potion / oil / bomb
 * bases uniformly — the branching is on whether the base tracks
 * charges, not on baseType.
 *
 *  - Charged base (system.charges.max > 0):
 *      newCurrent = max(0, 2*current - max - ceil(max/2))
 *    Equivalently: consumption = (max - current) + ceil(max/2) — one
 *    "half-max" dose PLUS every charge already missing from a full
 *    bottle. A partially-depleted base therefore wastes its leftover
 *    charges when re-used (e.g. 5/6 → 1/6, 4/6 → 0/6). Only usable
 *    when current ≥ ceil(max/2); the picker gates that upstream.
 *
 *    When the charge hits 0 the bottle is drained: if the actor has a
 *    stack (quantity > 1) we pop one and refill charges from the next
 *    bottle; otherwise the item is deleted.
 *
 *  - Un-tracked base (charges.max ≤ 0 — a food ingredient, a raw
 *    component, an alchemical valuable acting as a bomb base):
 *    treated as a single-use item; decrement quantity by 1 (delete
 *    if the stack was the last one).
 */
export async function consumeBase(baseItem) {
    const ch = getBaseChargeInfo(baseItem);
    if (ch) {
        const halfMax    = Math.ceil(ch.max / 2);
        const newCurrent = Math.max(0, ch.current - (ch.max - ch.current) - halfMax);
        if (newCurrent > 0) {
            return baseItem.update({ "system.charges.current": newCurrent });
        }
        const qty = baseItem.system.quantity ?? 1;
        if (qty <= 1) return baseItem.delete();
        return baseItem.update({
            "system.quantity": qty - 1,
            "system.charges.current": ch.max
        });
    }
    const qty = baseItem.system.quantity ?? 1;
    if (qty <= 1) return baseItem.delete();
    return baseItem.update({ "system.quantity": qty - 1 });
}

/* ─────────── Oil-on-weapon ──────────────────────────────────────────────── */

export function getAppliedOil(weapon) {
    const oil = weapon?.system?.appliedOil;
    if (!oil?.name) return null;
    return { ...oil };
}

/* Headless oil-application — same canonical schema the chrome UI writes,
 * so anything calling `game.system.api.alchemy.applyOilToWeapon(...)` from
 * a macro or another module produces an identical coating. The chrome
 * inventory layer has its own copy that ALSO handles the stack-peel +
 * action-spend; this version is the lean "just write the snapshot" path
 * that headless callers want. */
export async function applyOilToWeapon(weapon, oil) {
    if (!weapon || !oil) return;
    const sys = oil.system ?? {};
    const now = Number(game.time?.worldTime) || 0;
    const alchemyRebornOn = isHomebrewEnabled?.("alchemyPotency");
    /* Reborn: charges authored on the oil item (per source-sheet table,
     * Normal=5 / Enhanced=10 / Superior=15). RAW: no charges, the
     * oilDuration drives expiry instead. Default to 5 when the field is
     * unset so a freshly-authored oil doesn't deplete on first hit. */
    const oilMaxCharges = alchemyRebornOn
        ? Math.max(1, Number(sys.oilCharges) || 5)
        : 0;
    const dur = sys.oilDuration ?? {};
    const v = Number(dur.value) || 0;
    const u = String(dur.units || "").toLowerCase();
    const unitSecs = u.startsWith("d") ? 86400 : u.startsWith("h") ? 3600 : u.startsWith("m") ? 60 : 1;
    const durationSecs = alchemyRebornOn ? 0 : (v > 0 ? v * unitSecs : 0);
    /* Snapshot every non-disabled AE authored on the oil. Each entry is the
     * AE's toObject() so it survives the source oil's deletion (single-use
     * oils get consumed on coat). The socketHook damage handler reads this
     * array and spawns each entry as a fresh AE on the target on every
     * damaging hit — the poison-on-blade flow. */
    const onHitStatuses = (oil.effects?.contents ?? [])
        .filter(e => !e.disabled)
        .map(e => e.toObject());
    await weapon.update({
        "system.appliedOil": {
            id:             oil.id,
            name:           oil.name,
            img:            oil.img ?? "",
            oilTarget:      String(sys.oilTarget ?? ""),
            oilBonusDamage: Number(sys.oilBonusDamage) || 0,
            appliedAt:      now,
            expireAt:       durationSecs > 0 ? (now + durationSecs) : 0,
            charges:        oilMaxCharges,
            maxCharges:     oilMaxCharges,
            onHitStatuses
        }
    });
    // Consume one oil unit
    const qty = oil.system.quantity ?? 1;
    if (qty <= 1) await oil.delete();
    else await oil.update({ "system.quantity": qty - 1 });
}

export async function deductOilCharge(weapon) {
    const oil = getAppliedOil(weapon);
    if (!oil) return;
    const newCharges = Number(oil.charges) - 1;
    if (newCharges <= 0) {
        await weapon.update({ "system.appliedOil": {
            id: "", name: "", img: "", oilTarget: "", oilBonusDamage: 0,
            appliedAt: 0, expireAt: 0, charges: 0, maxCharges: 0,
            onHitStatuses: []
        }});
        ChatMessage.create({
            content: tFormat("WITCHER.Mech.Alchemy.Chat.OilDepleted", { weapon: weapon.name, oil: oil.name }, `${weapon.name} — ${oil.name} depleted.`)
        });
    } else {
        await weapon.update({ "system.appliedOil.charges": newCharges });
    }
}

/* ─────────── Public-facing namespace ────────────────────────────────────── */

export const alchemyApi = Object.freeze({
    isBaseOfType,
    getBaseMod,
    getBaseChargeInfo,
    detectFormulaCategory,
    formatBaseModForDisplay,
    computeEffectiveDC,
    qualityFromPotency,
    qualityColour,
    getDiagramFlags,
    getIngredientPotency,
    getIngredientSubstance,
    getAvailableBases,
    consumeBase,
    craftWith,
    getAppliedOil,
    applyOilToWeapon,
    deductOilCharge,
    baseSummaryFor,
    SUBSTANCES,
    BASE_TYPES
});
