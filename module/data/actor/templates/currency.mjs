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

/**
 * Value of one coin, expressed in CROWNS — the base the whole economy is
 * balanced around (item `system.cost` is in crowns; ITEM_BASE_DENOM). From the
 * canonical Witcher exchange (1 Crown = 1 Oren = 3 Ducats; 1 Floren = 3 Crowns;
 * 1 Bizant = 4 Crowns; 1 Lintar = 2 Crowns):
 *   crown = 1, oren = 1, ducat = 1/3, lintar = 2, floren = 3, bizant = 4.
 * A merchant re-quotes crown-based costs into its own `shopDenom` via
 * convertCurrency().
 */
export const COIN_CROWN_VALUE = Object.freeze({
    crown: 1, oren: 1, ducat: 1 / 3, lintar: 2, floren: 3, bizant: 4
});

/** The denomination item `system.cost` is authored in. */
export const ITEM_BASE_DENOM = "crown";

/**
 * Value of `amount` coins of `fromDenom`, expressed in `toDenom` (float —
 * callers round to whole coins at the display / settlement boundary). Unknown
 * denominations pass through unconverted.
 */
export function convertCurrency(amount, fromDenom, toDenom) {
    const from = COIN_CROWN_VALUE[fromDenom];
    const to   = COIN_CROWN_VALUE[toDenom];
    const amt  = Number(amount) || 0;
    if (!from || !to || from === to) return amt;
    return amt * from / to;
}

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
