import { t, tFormat } from "../chrome/lib/i18n.js";
/**
 * FoodAndDrinkConfigApp — the GM-facing editor for the numeric knobs of the
 * food & drink homebrew. Opens from Configure Settings → "Food & Drink
 * Configuration" (only registered when the foodAndDrink toggle is on).
 *
 * Stores its state as one world-scoped Object setting
 * (`foodAndDrinkConfig`) — a single round-trip on save keeps the API simple.
 *
 * Sections:
 *   - Decay: how fast satiety drains per hour (base + BODY divisor) and how
 *            much one STA spend in combat costs.
 *   - Hunger Tiers: the minimum satiety value at which each named tier kicks
 *            in. Lets the GM widen/tighten the "Peckish warning band", make
 *            t("WITCHER.App.FoodAndDrinkConfig.Dialog.Button.Gorged", "Gorged") easier to reach, etc.
 *   - Drunk Tiers: per-tier metadata the status-effects editor doesn't expose:
 *            the Endurance DC the dring author can override, the level-jump
 *            default, the unconscious DC for the lethal tiers, and the death-
 *            chance percent for VII / VIII.
 *
 * The setting is requiresReload:true — saving triggers Foundry's reload
 * prompt so the satiety tick and drunk-roll code pick up the new numbers
 * from a clean init.
 */

const SYSTEM_ID = "witcher-ttrpg-death-march";
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/* Defaults — used both as the schema seed AND as fallback values for any
 * key the GM hasn't touched yet. Spec-canonical numbers from the original
 * food & drink design. */
export const FOOD_AND_DRINK_CONFIG_DEFAULTS = Object.freeze({
    decay: {
        // hourly drain = base + ceil(BODY / bodyDivisor)
        base:              1,
        bodyDivisor:       4,
        // Combat drain: FRACTION OF THE ACTOR'S SATIETY MAX per STA spent
        // (not absolute satiety points). 0.0025 = 0.25% × MAX per STA, which
        // works out to ~0.24 satiety per STA at BODY 9-12 (MAX 96), scaling
        // with body size so every actor loses the same PROPORTION per STA.
        // Change to e.g. 0.005 for a doubled combat-hunger effect.
        combatStaPerUnit:  0.0025
    },
    hungerTiers: {
        // MINIMUM PERCENTAGE of the actor's satiety MAX at which each tier
        // kicks in (top-down). MAX = drain × 24 (one full day of BMR), so
        // these percentages produce uniform hours-to-tier across all BODY:
        //   Full: 75% → recently ate (0-6h after full meal)
        //   Fed:  50% → normal comfortable state (6-12h)
        //   Peckish: 25% → should eat soon (12-18h)
        //   Hungry: 0% → real hunger, +1 LOCKED stress (18-24h)
        //   Famished: below 0% → subdivided into 4 depths, each -12.5% max STA
        // The Gorged threshold (100%) marks the ceiling; a Gorged actor has
        // eaten a huge meal that filled them to the brim.
        gorged:  100,
        full:     75,
        fed:      50,
        peckish:  25,
        hungry:    0
    },
    drunkTiers: {
        1: { defaultDC: 10, levelJump: 1 },
        2: { defaultDC: 12, levelJump: 1 },
        3: { defaultDC: 14, levelJump: 1 },
        4: { defaultDC: 16, levelJump: 1 },
        5: { defaultDC: 18, levelJump: 1 },
        6: { defaultDC: 20, levelJump: 1, unconsciousDC: 20 },
        7: { defaultDC: 24, levelJump: 1, unconsciousDC: 24 },
        8: { defaultDC: 30, levelJump: 1, unconsciousDC: 30, deathChance: 5 }
    },
    /* Chat toggles — GM preference for how noisy the food mechanic is
     * in the log. Spoilage notifications are the loudest recurring source
     * (fires on every day-skip that turns any tracked food) so it gets
     * its own opt-out. Default on preserves the pre-toggle behaviour. */
    chat: {
        spoilageNotifications: true
    }
});

/* Cached, deep-cloned merge of defaults + GM overrides. `getFoodAndDrinkConfig`
 * is on the hot path of every satiety adjust / hourly hunger tick / tier
 * calc; without a cache the deepClone + mergeObject ran 10-20× per cascade.
 * Cache is invalidated when the underlying `foodAndDrinkConfig` setting
 * changes (updateSetting hook installed lazily on first read) so a GM tweak
 * still takes effect without a reload. The stored value is frozen so no
 * caller can mutate the shared reference. */
let _configCache = null;
let _configHookInstalled = false;

function _installConfigHook() {
    if (_configHookInstalled) return;
    _configHookInstalled = true;
    try {
        Hooks?.on?.("updateSetting", (setting) => {
            const key = setting?.key ?? "";
            if (key === `${SYSTEM_ID}.foodAndDrinkConfig`) _configCache = null;
        });
    } catch (_) { /* Hooks not ready — will re-attempt on next read */ _configHookInstalled = false; }
}

/* Public read helper — returns the live config (defaults merged with the
 * GM's stored override). Safe to call before settings are registered (returns
 * defaults). Foreign code reads through here so the merge logic stays in one
 * place. */
export function getFoodAndDrinkConfig() {
    if (_configCache) return _configCache;
    _installConfigHook();
    let stored = null;
    try { stored = game.settings?.get?.(SYSTEM_ID, "foodAndDrinkConfig"); }
    catch { stored = null; }
    if (!stored || typeof stored !== "object") {
        _configCache = FOOD_AND_DRINK_CONFIG_DEFAULTS;
        return _configCache;
    }
    _configCache = foundry.utils.mergeObject(
        foundry.utils.deepClone(FOOD_AND_DRINK_CONFIG_DEFAULTS),
        stored,
        { inplace: false }
    );
    /* Legacy-value migration: `combatStaPerUnit` used to be an ABSOLUTE
     * satiety-points-per-STA value (typical 0.25–0.5). It's now a FRACTION
     * of the actor's satiety MAX per STA (typical 0.0025–0.005). Any stored
     * value > 0.1 is definitely the old semantic (0.1 × MAX = 10% per STA
     * would burn a full pool in ~10 STA, which nobody would set on purpose).
     * Coerce to the new default so a world upgrading from the old rate
     * doesn't accidentally run at 50%+ per STA. */
    const legacyRate = Number(_configCache?.decay?.combatStaPerUnit);
    if (Number.isFinite(legacyRate) && legacyRate > 0.1) {
        _configCache.decay.combatStaPerUnit = FOOD_AND_DRINK_CONFIG_DEFAULTS.decay.combatStaPerUnit;
    }
    return _configCache;
}

export class FoodAndDrinkConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {

    static DEFAULT_OPTIONS = {
        id: "wdm-food-drink-config",
        classes: ["witcher-ttrpg-death-march", "wdm-food-drink-config"],
        tag: "form",
        window: {
            title: t("WITCHER.Dialog.FoodAndDrink.Title", "Food & Drink Configuration"),
            icon: "fa-solid fa-utensils",
            resizable: true
        },
        // Fixed height so the body actually overflows + scrolls. "auto" lets
        // the window grow to fit content, which means scrolling never kicks
        // in — even with eight drunk tiers and the full hunger table the
        // user couldn't see everything without resizing.
        position: { width: 660, height: 700 },
        form: {
            handler: FoodAndDrinkConfigApp.#onSubmit,
            submitOnChange: false,
            closeOnSubmit: true
        }
    };

    static PARTS = {
        // scrollable target is the inner `.wdm-fdc-scroll` wrapper rather
        // than the part root — keeps the section headers and the footer
        // pinned while the body scrolls cleanly.
        main:   { template: "systems/witcher-ttrpg-death-march/templates/applications/food-and-drink-config.hbs", scrollable: [".wdm-fdc-scroll"] },
        footer: { template: "templates/generic/form-footer.hbs" }
    };

    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        const cfg = getFoodAndDrinkConfig();
        ctx.decay = cfg.decay;
        /* Chat toggles — pass-through so the template renders the current
         * value of each checkbox. Defaults live in FOOD_AND_DRINK_CONFIG_DEFAULTS
         * and are merged into the cached cfg by getFoodAndDrinkConfig. */
        ctx.chat = {
            spoilageNotifications: cfg.chat?.spoilageNotifications !== false
        };
        ctx.hungerTiers = [
            { key: "gorged",   label: t("WITCHER.App.FoodAndDrinkConfig.Dialog.Button.Gorged", "Gorged"),   min: cfg.hungerTiers.gorged  },
            { key: "full",     label: t("WITCHER.App.FoodAndDrinkConfig.Dialog.Button.Full", "Full"),     min: cfg.hungerTiers.full    },
            { key: "fed",      label: t("WITCHER.App.FoodAndDrinkConfig.Dialog.Button.Fed", "Fed"),      min: cfg.hungerTiers.fed     },
            { key: "peckish",  label: t("WITCHER.App.FoodAndDrinkConfig.Dialog.Button.Peckish", "Peckish"),  min: cfg.hungerTiers.peckish },
            { key: "hungry",   label: t("WITCHER.App.FoodAndDrinkConfig.Dialog.Button.Hungry", "Hungry"),   min: cfg.hungerTiers.hungry  }
        ];
        ctx.drunkTiers = [1,2,3,4,5,6,7,8].map(n => {
            const t = cfg.drunkTiers[n] ?? {};
            return {
                level: n,
                roman: ["","I","II","III","IV","V","VI","VII","VIII"][n],
                unconsciousDC: t.unconsciousDC ?? "",
                // `isLethal` (>= 6) → shows the "Endurance DC to stay
                //   conscious" cell; matches when _rollAlcoholPoisoning
                //   fires an unconscious check in the mechanic. Death
                //   chance column removed from the UI — only Drunk-VIII
                //   carries one, hard-coded to 5% in the defaults + baked
                //   into the effect description.
                isLethal:      n >= 6
            };
        });
        ctx.buttons = [{ type: "submit", icon: "fa-solid fa-floppy-disk", label: t("WITCHER.Common.SaveReload", "Save & Reload") }];
        return ctx;
    }

    static async #onSubmit(event, form, formData) {
        const data = foundry.utils.expandObject(formData.object);
        // Coerce + clamp. Numbers fall back to defaults when a field's blank
        // or non-numeric so a bad input never breaks the math downstream.
        const D = FOOD_AND_DRINK_CONFIG_DEFAULTS;
        const num = (v, fallback, { min = -Infinity, max = Infinity } = {}) => {
            const n = Number(v);
            return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
        };
        /* Preserve any hunger-tier thresholds the GM may have previously
         * customised. The UI no longer exposes these fields (they're spec-
         * canonical and don't reward tweaking), so the form doesn't submit
         * values for them — reading stored settings ensures we don't blow
         * a legacy customisation away when saving. */
        let storedHungerTiers = {};
        try { storedHungerTiers = (game.settings.get(SYSTEM_ID, "foodAndDrinkConfig") ?? {}).hungerTiers ?? {}; }
        catch (_) { storedHungerTiers = {}; }
        const next = {
            decay: {
                base:             num(data.decay?.base,             D.decay.base,             { min: 0 }),
                bodyDivisor:      num(data.decay?.bodyDivisor,      D.decay.bodyDivisor,      { min: 1 }),
                combatStaPerUnit: num(data.decay?.combatStaPerUnit, D.decay.combatStaPerUnit, { min: 0 })
            },
            hungerTiers: {
                gorged:  Number.isFinite(Number(storedHungerTiers.gorged))  ? Number(storedHungerTiers.gorged)  : D.hungerTiers.gorged,
                full:    Number.isFinite(Number(storedHungerTiers.full))    ? Number(storedHungerTiers.full)    : D.hungerTiers.full,
                fed:     Number.isFinite(Number(storedHungerTiers.fed))     ? Number(storedHungerTiers.fed)     : D.hungerTiers.fed,
                peckish: Number.isFinite(Number(storedHungerTiers.peckish)) ? Number(storedHungerTiers.peckish) : D.hungerTiers.peckish,
                hungry:  Number.isFinite(Number(storedHungerTiers.hungry))  ? Number(storedHungerTiers.hungry)  : D.hungerTiers.hungry
            },
            drunkTiers: {},
            chat: {
                /* Checkbox → boolean. HTML checkboxes send "on" / undefined,
                 * so coerce accordingly. */
                spoilageNotifications: data.chat?.spoilageNotifications === true
                    || data.chat?.spoilageNotifications === "on"
                    || data.chat?.spoilageNotifications === "true"
            }
        };
        for (const n of [1,2,3,4,5,6,7,8]) {
            const t = data.drunkTiers?.[n] ?? {};
            const d = D.drunkTiers[n];
            /* Preserved fields (not editable in the UI, defaults come from
             * the schema): defaultDC + levelJump live on the drink item
             * itself (getDrunkConfig reads there); deathChance is hard-set
             * to 5% for Drunk-VIII in the schema and baked into the effect
             * description — never worth exposing as a per-tier knob. */
            const entry = {
                defaultDC: d.defaultDC,
                levelJump: d.levelJump
            };
            if (n >= 6) {
                entry.unconsciousDC = num(t.unconsciousDC, d.unconsciousDC ?? 20, { min: 0 });
            }
            if (n >= 8 && Number.isFinite(Number(d.deathChance))) {
                entry.deathChance = Number(d.deathChance);
            }
            next.drunkTiers[n] = entry;
        }

        await game.settings.set(SYSTEM_ID, "foodAndDrinkConfig", next);
        ui.notifications.info(t("WITCHER.Notify.FoodAndDrink.Saved", "Food & Drink config saved."));

        // requiresReload:true → prompt for a reload so the satiety tick,
        // hunger tier ranges, and drunk roll metadata pick up fresh values.
        const SettingsConfig = foundry.applications?.settings?.SettingsConfig
                            ?? globalThis.SettingsConfig;
        try { await SettingsConfig?.reloadConfirm?.({ world: true }); }
        catch (err) { console.warn(`${SYSTEM_ID} | food-drink config reload prompt failed`, err); }
    }
}
