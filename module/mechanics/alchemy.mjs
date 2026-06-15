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

const SYSTEM_ID = "witcher-ttrpg-death-march";

/* ─────────── Read-only helpers ──────────────────────────────────────────── */

/**
 * Resolve the base subschema for a given item.
 * Returns { baseType, baseMod, quality } even if the item has no base.
 */
function readBase(item) {
    const sys = item?.system;
    if (!sys) return { baseType: "", baseMod: 0, quality: "" };
    // Alchemical bases store directly; valuables nest under alchemyBase.
    if (item.type === "alchemical") {
        return {
            baseType: sys.baseType ?? "",
            baseMod:  sys.baseMod  ?? 0,
            quality:  sys.quality  ?? ""
        };
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
 * category. 'oil' and 'bomb' pass through; everything else → 'potion'.
 */
export function detectFormulaCategory(formulaOrCategory) {
    const t = typeof formulaOrCategory === "string"
        ? formulaOrCategory
        : (formulaOrCategory?.system?.type ?? "potion");
    if (t === "oil" || t === "bomb") return t;
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
 * effectiveDC = baseDC + (memorized ? -2 : 0) + baseMod.
 * (Memorized formulas get -2 DC because the alchemist knows them by heart.)
 */
export function computeEffectiveDC(diagram, baseItem, { memorized } = {}) {
    if (!diagram) return Infinity;
    const sys = diagram.system ?? {};
    const baseDC = sys.alchemyDC ?? sys.craftingDC ?? 12;
    const memorizedActual = typeof memorized === "boolean"
        ? memorized
        : (sys.learned ?? false);
    const dc = baseDC + (memorizedActual ? -2 : 0) + getBaseMod(baseItem);
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
        outputNormal:    sys.outputNormal    ?? "",
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

/** Substance the ingredient provides (component: substanceType). Mutagens
 *  are no longer ingredients, so they yield no substance. */
export function getIngredientSubstance(item) {
    if (!item?.system) return "";
    return item.system.substance || item.system.substanceType || "";
}

/**
 * Bases available on the actor for a given formula category.
 *   - oil:    items tagged as oil bases + legacy named components
 *   - potion: items tagged as potion bases AND with ≥50% charge (if charged)
 *   - bomb:   items tagged as bomb bases (no charge filter)
 */
export function getAvailableBases(actor, formulaOrCategory) {
    if (!actor?.items) return [];
    const cat = detectFormulaCategory(formulaOrCategory);

    const bases = [];
    for (const item of actor.items) {
        if (cat === "oil") {
            if (isBaseOfType(item, "oil")) { bases.push(item); continue; }
            // Legacy: dog tallow / bear fat by name
            if (item.type === "component" && /(dog tallow|bear fat)/i.test(item.name)) {
                bases.push(item);
            }
        } else if (cat === "potion") {
            if (!isBaseOfType(item, "potion")) continue;
            const ch = getBaseChargeInfo(item);
            if (ch && ch.max > 0 && ch.current < Math.ceil(ch.max / 2)) continue;
            bases.push(item);
        } else if (cat === "bomb") {
            if (isBaseOfType(item, "bomb")) bases.push(item);
        }
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
        ui.notifications?.info("Alchemy potency system is disabled (homebrew off).");
        return { pass: false, dc: 0 };
    }
    if (!actor || !diagram) return { pass: false, dc: 0 };

    const baseItem = actor.items.get(choices.baseId);
    if (!baseItem) {
        ui.notifications?.warn("Select a base.");
        return { pass: false, dc: 0 };
    }

    const ingredients = (choices.ingredients ?? [])
        .map(({ id, qty }) => ({ item: actor.items.get(id), qty: Number(qty) || 0 }))
        .filter(x => x.item && x.qty > 0);
    if (!ingredients.length) {
        ui.notifications?.warn("Select at least one ingredient.");
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
        ui.notifications?.warn(`Missing components: ${shortfalls.join(", ")}.`);
        return { pass: false, dc: 0 };
    }

    // Compute quality from total potency
    const totalPotency = ingredients.reduce(
        (s, { item, qty }) => s + getIngredientPotency(item) * qty, 0
    );
    const flags = getDiagramFlags(diagram);
    const quality = qualityFromPotency(totalPotency, flags);
    if (!quality) {
        ui.notifications?.warn(`Total potency ${totalPotency} doesn't meet any quality threshold.`);
        return { pass: false, dc: 0 };
    }
    const outputUuid = flags[`output${quality}`];
    if (!outputUuid) {
        ui.notifications?.warn(`No output item configured for ${quality} quality.`);
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
        content: `<h3>${actor.name} brewed ${output?.name ?? "an item"}</h3>
                  <div style="color:${qualityColour(quality)}"><b>${quality}</b> quality
                  · potency ${totalPotency} · DC ${dc} · base ${baseItem.name}</div>`
    });

    return { pass: true, dc, quality, output };
}

/**
 * Consume a base: oils decrement quantity; potions deduct
 * ceil(max × 0.5) charges and roll over to next bottle when depleted.
 */
async function consumeBase(baseItem) {
    const { baseType } = readBase(baseItem);
    if (baseType === "potion") {
        const ch = getBaseChargeInfo(baseItem);
        if (ch) {
            const deduct = Math.ceil(ch.max / 2);
            const newCurrent = ch.current - deduct;
            if (newCurrent > 0) {
                return baseItem.update({ "system.charges.current": newCurrent });
            }
            // Bottle empty — move to next
            const qty = baseItem.system.quantity ?? 1;
            if (qty <= 1) return baseItem.delete();
            return baseItem.update({
                "system.quantity": qty - 1,
                "system.charges.current": ch.max
            });
        }
    }
    // Oils / bombs / un-charged potions: decrement quantity
    const qty = baseItem.system.quantity ?? 1;
    if (qty <= 1) return baseItem.delete();
    return baseItem.update({ "system.quantity": qty - 1 });
}

/* ─────────── Oil-on-weapon ──────────────────────────────────────────────── */

export function getAppliedOil(weapon) {
    const oil = weapon?.system?.appliedOil;
    if (!oil?.id) return null;
    return { ...oil };
}

export async function applyOilToWeapon(weapon, oil) {
    if (!weapon || !oil) return;
    const ch = getBaseChargeInfo(oil);
    await weapon.update({
        "system.appliedOil": {
            id:         oil.id,
            name:       oil.name,
            img:        oil.img ?? "",
            effect:     oil.system?.effect ?? "",
            charges:    ch?.current ?? (oil.system?.time ?? 1),
            maxCharges: ch?.max ?? (oil.system?.time ?? 1)
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
    const newCharges = oil.charges - 1;
    if (newCharges <= 0) {
        await weapon.update({ "system.appliedOil": {
            id: "", name: "", img: "", effect: "", charges: 0, maxCharges: 0
        }});
        ChatMessage.create({
            content: `${weapon.name} — ${oil.name} depleted.`
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
    craftWith,
    getAppliedOil,
    applyOilToWeapon,
    deductOilCharge,
    SUBSTANCES,
    BASE_TYPES
});
