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
 *            "Gorged" easier to reach, etc.
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
        combatStaPerUnit:  0.5    // satiety drained per 1 STA spent in combat
    },
    hungerTiers: {
        // Minimum satiety value at which the tier kicks in (top-down).
        // Famished has no min (falls through to it).
        gorged:  101,
        full:     76,
        fed:      51,
        peckish:  26,
        hungry:    1
    },
    drunkTiers: {
        1: { defaultDC: 10, levelJump: 1 },
        2: { defaultDC: 12, levelJump: 1 },
        3: { defaultDC: 14, levelJump: 1 },
        4: { defaultDC: 16, levelJump: 1 },
        5: { defaultDC: 18, levelJump: 1 },
        6: { defaultDC: 20, levelJump: 1, unconsciousDC: 20 },
        7: { defaultDC: 24, levelJump: 1, unconsciousDC: 24, deathChance: 25 },
        8: { defaultDC: 30, levelJump: 1, unconsciousDC: 30, deathChance: 50 }
    }
});

/* Public read helper — returns the live config (defaults merged with the
 * GM's stored override). Safe to call before settings are registered (returns
 * defaults). Foreign code reads through here so the merge logic stays in one
 * place. */
export function getFoodAndDrinkConfig() {
    let stored = null;
    try { stored = game.settings?.get?.(SYSTEM_ID, "foodAndDrinkConfig"); }
    catch { stored = null; }
    if (!stored || typeof stored !== "object") return FOOD_AND_DRINK_CONFIG_DEFAULTS;
    return foundry.utils.mergeObject(
        foundry.utils.deepClone(FOOD_AND_DRINK_CONFIG_DEFAULTS),
        stored,
        { inplace: false }
    );
}

export class FoodAndDrinkConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {

    static DEFAULT_OPTIONS = {
        id: "wdm-food-drink-config",
        classes: ["witcher-ttrpg-death-march", "wdm-food-drink-config"],
        tag: "form",
        window: {
            title: "Food & Drink Configuration",
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
        ctx.hungerTiers = [
            { key: "gorged",   label: "Gorged",   min: cfg.hungerTiers.gorged  },
            { key: "full",     label: "Full",     min: cfg.hungerTiers.full    },
            { key: "fed",      label: "Fed",      min: cfg.hungerTiers.fed     },
            { key: "peckish",  label: "Peckish",  min: cfg.hungerTiers.peckish },
            { key: "hungry",   label: "Hungry",   min: cfg.hungerTiers.hungry  }
        ];
        ctx.drunkTiers = [1,2,3,4,5,6,7,8].map(n => {
            const t = cfg.drunkTiers[n] ?? {};
            return {
                level: n,
                roman: ["","I","II","III","IV","V","VI","VII","VIII"][n],
                defaultDC:     t.defaultDC ?? "",
                levelJump:     t.levelJump ?? 1,
                unconsciousDC: t.unconsciousDC ?? "",
                deathChance:   t.deathChance ?? "",
                // Precomputed flags so the template doesn't have to lean on
                // a subexpression helper (`{{#if (gte this.level 7)}}` was
                // flaky inside the {{#each}} loop — pulling the logic out to
                // the view-model is cleaner and rendering-safe).
                isLethal:      n >= 6,
                hasDeathChance: n >= 7
            };
        });
        ctx.buttons = [{ type: "submit", icon: "fa-solid fa-floppy-disk", label: "Save & Reload" }];
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
        const next = {
            decay: {
                base:             num(data.decay?.base,             D.decay.base,             { min: 0 }),
                bodyDivisor:      num(data.decay?.bodyDivisor,      D.decay.bodyDivisor,      { min: 1 }),
                combatStaPerUnit: num(data.decay?.combatStaPerUnit, D.decay.combatStaPerUnit, { min: 0 })
            },
            hungerTiers: {
                gorged:  num(data.hungerTiers?.gorged,  D.hungerTiers.gorged,  { min: -100, max: 125 }),
                full:    num(data.hungerTiers?.full,    D.hungerTiers.full,    { min: -100, max: 125 }),
                fed:     num(data.hungerTiers?.fed,     D.hungerTiers.fed,     { min: -100, max: 125 }),
                peckish: num(data.hungerTiers?.peckish, D.hungerTiers.peckish, { min: -100, max: 125 }),
                hungry:  num(data.hungerTiers?.hungry,  D.hungerTiers.hungry,  { min: -100, max: 125 })
            },
            drunkTiers: {}
        };
        for (const n of [1,2,3,4,5,6,7,8]) {
            const t = data.drunkTiers?.[n] ?? {};
            const d = D.drunkTiers[n];
            const entry = {
                defaultDC: num(t.defaultDC, d.defaultDC, { min: 0 }),
                levelJump: num(t.levelJump, d.levelJump, { min: 0 })
            };
            if (n >= 6) {
                entry.unconsciousDC = num(t.unconsciousDC, d.unconsciousDC ?? 20, { min: 0 });
            }
            if (n >= 7) {
                entry.deathChance = num(t.deathChance, d.deathChance ?? 25, { min: 0, max: 100 });
            }
            next.drunkTiers[n] = entry;
        }

        await game.settings.set(SYSTEM_ID, "foodAndDrinkConfig", next);
        ui.notifications.info("Food & Drink config saved.");

        // requiresReload:true → prompt for a reload so the satiety tick,
        // hunger tier ranges, and drunk roll metadata pick up fresh values.
        const SettingsConfig = foundry.applications?.settings?.SettingsConfig
                            ?? globalThis.SettingsConfig;
        try { await SettingsConfig?.reloadConfirm?.({ world: true }); }
        catch (err) { console.warn(`${SYSTEM_ID} | food-drink config reload prompt failed`, err); }
    }
}
