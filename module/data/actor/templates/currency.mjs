/**
 * Currency template — Witcher TRPG coin tracking.
 *
 * Six denominations matching TheWitcherTRPG's canonical schema (singular
 * keys, so existing world data and the overhaul-ui topbar both bind):
 *   bizant, ducat, lintar, floren, crown, oren.
 *
 * Plus a method exposed on data model classes: calcCurrencyWeight().
 * Reference per-coin weight: 0.0025 kg/coin (default).
 */

const fields = foundry.data.fields;

const coin = () => new fields.NumberField({ initial: 0, integer: true, min: 0 });

const COIN_WEIGHT_KG = 0.0025;

export const CURRENCY_KEYS = ["bizant", "ducat", "lintar", "floren", "crown", "oren"];

export function currencySchema() {
    return {
        currency: new fields.SchemaField(
            Object.fromEntries(CURRENCY_KEYS.map(k => [k, coin()]))
        )
    };
}

/**
 * Sum of weights for all coins on this actor.
 * Called as `actor.system.calcCurrencyWeight()` — see overhaul-ui topbar.js:221.
 */
export function calcCurrencyWeight(currency) {
    if (!currency) return 0;
    let total = 0;
    for (const k of CURRENCY_KEYS) total += Number(currency[k]) || 0;
    return total * COIN_WEIGHT_KG;
}
