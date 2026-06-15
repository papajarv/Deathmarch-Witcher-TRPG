/**
 * Alchemy canonical lists — substances, base tier table, toxicity tiers,
 * formula category labels.
 *
 * Extracted from the witcher-alchemy-craft module's hardcoded constants
 * (craft.mjs:15-52). Single source of truth so `mechanics/alchemy.mjs`,
 * sheets, and any chrome derive from the same values.
 */

export const SUBSTANCES = Object.freeze([
    "Vitriol", "Rebis", "Aether", "Quebrith",
    "Hydragenum", "Vermilion", "Sol", "Caelum", "Fulgur"
]);

export const BASE_TIERS = Object.freeze([
    { mod:  2, label: "Bad",     cost:   8 },
    { mod:  1, label: "Weak",    cost:  15 },
    { mod:  0, label: "Neutral", cost:  20 },
    { mod: -1, label: "Good",    cost:  35 },
    { mod: -2, label: "Great",   cost:  50 },
    { mod: -6, label: "Optimal", cost: 100 }
]);

export const BASE_TYPES = Object.freeze(["potion", "oil", "bomb"]);

export const FORMULA_TYPE_LABELS = Object.freeze({
    potion:               "Potion",
    decoction:            "Decoction",
    oil:                  "Oil",
    alchemical:           "Alchemical",
    weapon:               "Weapon",
    armor:                "Armor",
    "armor-enhancement":  "Enhancement",
    bomb:                 "Bomb",
    traps:                "Trap",
    ammunition:           "Ammunition",
    ingredients:          "Ingredient",
    "elderfolk-weapon":   "Elderfolk Weapon",
    "elderfolk-armor":    "Elderfolk Armor"
});

/**
 * Toxicity status effects — added to CONFIG.statusEffects when the
 * alchemyPotency homebrew is on. Damage column is tick damage per round.
 */
export const TOXICITY_TIERS = Object.freeze([
    { id: "toxicity-mild",   name: "WITCHER.Status.ToxicityMild",   img: "icons/svg/poison.svg",    damage: 1 },
    { id: "toxicity-strong", name: "WITCHER.Status.ToxicityStrong", img: "icons/svg/poison.svg",    damage: 2 },
    { id: "toxicity-severe", name: "WITCHER.Status.ToxicitySevere", img: "icons/svg/poison.svg",    damage: 3 },
    { id: "toxicity-deadly", name: "WITCHER.Status.ToxicityDeadly", img: "icons/svg/skull.svg",     damage: 0 }
]);
