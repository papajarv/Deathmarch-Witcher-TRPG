/**
 * HouseRulesConfigApp — GM-only global combat house-rules configuration.
 *
 * Edits the single `houseRulesConfig` world Object payload. Sections:
 *   • Strike restrictions (bows can't strong strike, etc.).
 *   • Critical wound SP downgrade rule.
 *   • Action economy (extra action to-hit + STA, extra defense STA).
 *   • Strike & offhand penalties.
 *
 * Save reads the form, merges over the current stored config, and
 * writes back. Consumers pull LIVE from the setting on every check,
 * so mid-session edits take effect on the next dispatch without a
 * world reload.
 *
 * Per-actor Active Effect overrides (strong-strike / offhand penalty
 * reductions, additive-defense recurrence) are unchanged — they
 * continue to layer on TOP of the global values set here.
 */

import { HOUSE_RULES_CONFIG_DEFAULTS, HOUSE_RULES_CONFIG_KEY,
         setHouseRulesConfig } from "../mechanics/house-rules-config.mjs";

import { t } from "../chrome/lib/i18n.js";
const SYSTEM_ID = "witcher-ttrpg-death-march";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class HouseRulesConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {

    static DEFAULT_OPTIONS = {
        id: "wdm-house-rules-config",
        classes: ["witcher-ttrpg-death-march", "wdm-house-rules-config"],
        tag: "form",
        window: {
            title: "WITCHER.App.HouseRulesConfig.Title",
            icon: "fa-solid fa-scale-balanced",
            resizable: true
        },
        position: { width: 600, height: 640 },
        form: {
            handler: HouseRulesConfigApp.#onSubmit,
            submitOnChange: false,
            closeOnSubmit: true
        },
        actions: {
            resetDefaults: HouseRulesConfigApp.#onResetDefaults
        }
    };

    static PARTS = {
        main:   { template: `systems/${SYSTEM_ID}/templates/applications/house-rules-config.hbs` },
        footer: { template: "templates/generic/form-footer.hbs" }
    };

    /* ─────────── context ─────────── */

    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        let stored = {};
        try { stored = game.settings.get(SYSTEM_ID, HOUSE_RULES_CONFIG_KEY) ?? {}; }
        catch (_) { stored = {}; }
        const v = foundry.utils.mergeObject(
            foundry.utils.deepClone(HOUSE_RULES_CONFIG_DEFAULTS),
            stored,
            { inplace: true, overwrite: true }
        );

        /* splitMovement and rawToxicity live in the standalone homebrew.<key>
         * world settings so isHomebrewEnabled() keeps working everywhere.
         * The house rules UI just reads/writes them alongside the fields
         * that live inside the houseRulesConfig payload. */
        const readHomebrew = (key, fallback) => {
            try { return !!game.settings.get(SYSTEM_ID, `homebrew.${key}`); }
            catch (_) { return fallback; }
        };
        ctx.values = {
            bowsCannotStrongStrike: !!v.bowsCannotStrongStrike,
            critSpDowngradeMode:    (v.critSpDowngradeMode === "greaterToLesser"
                                  || v.critSpDowngradeMode === "anyToSimple")
                                        ? v.critSpDowngradeMode : "off",
            critBonusNeedsSpBreak:  !!v.critBonusNeedsSpBreak,
            /* Both default to true; undefined = RAW enabled. */
            d10Explode:             v.d10Explode  !== false,
            d10Collapse:            v.d10Collapse !== false,
            extraActionToHit:       Number(v.extraActionToHit) || 0,
            extraActionStaCost:     Math.max(0, Number(v.extraActionStaCost) || 0),
            extraDefenseStaCost:    Math.max(0, Number(v.extraDefenseStaCost) || 0),
            strongStrikePenalty:    Number(v.strongStrikePenalty) || 0,
            offhandPenalty:         Number(v.offhandPenalty) || 0,
            proneCrawlQuarterSpd:   !!v.proneCrawlQuarterSpd,
            containerEquipEV:       !!v.containerEquipEV,
            critBracketSimple:      Math.max(1, Math.round(Number(v.critBracketSimple)    || 7)),
            critBracketComplex:     Math.max(1, Math.round(Number(v.critBracketComplex)   || 10)),
            critBracketDifficult:   Math.max(1, Math.round(Number(v.critBracketDifficult) || 13)),
            critBracketDeadly:      Math.max(1, Math.round(Number(v.critBracketDeadly)    || 15)),
            /* Bonus damage ladders — clamped to non-negative integers
             * (0 disables that tier's bonus; negative would heal). */
            critBonusSimple:            Math.max(0, Math.round(Number(v.critBonusSimple)            ||  3)),
            critBonusComplex:           Math.max(0, Math.round(Number(v.critBonusComplex)           ||  5)),
            critBonusDifficult:         Math.max(0, Math.round(Number(v.critBonusDifficult)         ||  8)),
            critBonusDeadly:            Math.max(0, Math.round(Number(v.critBonusDeadly)            || 10)),
            critBonusNoOrgansSimple:    Math.max(0, Math.round(Number(v.critBonusNoOrgansSimple)    ||  5)),
            critBonusNoOrgansComplex:   Math.max(0, Math.round(Number(v.critBonusNoOrgansComplex)   || 10)),
            critBonusNoOrgansDifficult: Math.max(0, Math.round(Number(v.critBonusNoOrgansDifficult) || 15)),
            critBonusNoOrgansDeadly:    Math.max(0, Math.round(Number(v.critBonusNoOrgansDeadly)    || 20)),
            splitMovement:          readHomebrew("splitMovement", false),
            rawToxicity:            readHomebrew("rawToxicity",   true)
        };
        ctx.buttons = [
            { type: "button", action: "resetDefaults", icon: "fa-solid fa-arrow-rotate-left",
              label: t("WITCHER.App.HouseRulesConfig.ResetToDefaults", "Reset to Defaults") },
            { type: "submit", icon: "fa-solid fa-floppy-disk",
              label: t("WITCHER.App.HouseRulesConfig.Save", "Save") }
        ];
        return ctx;
    }

    /* ─────────── actions ─────────── */

    static async #onResetDefaults() {
        const ok = await foundry.applications.api.DialogV2.confirm({
            window: { title: t("WITCHER.App.HouseRulesConfig.ResetConfirmTitle", "Reset house rules?") },
            content: `<p>${t("WITCHER.App.HouseRulesConfig.ResetConfirmBody",
                "Discard all house-rules overrides and restore the shipped defaults? Takes effect when you Save.")}</p>`,
            modal: true,
            rejectClose: false
        }).catch(() => false);
        if (!ok) return;
        /* Defaults for the two homebrew-backed toggles live in HOMEBREW
         * (config.mjs) rather than HOUSE_RULES_CONFIG_DEFAULTS. Hard-code
         * them here so Reset restores the shipped RAW baseline
         * (splitMovement OFF, rawToxicity ON) without a config.mjs import. */
        const HOMEBREW_DEFAULTS = { splitMovement: false, rawToxicity: true };
        for (const el of this.element.querySelectorAll("[data-config-key]")) {
            const key = el.dataset.configKey;
            const def = HOUSE_RULES_CONFIG_DEFAULTS[key] ?? HOMEBREW_DEFAULTS[key];
            if (def === undefined) continue;
            if (el.type === "checkbox") el.checked = !!def;
            else el.value = String(def);
        }
    }

    static async #onSubmit(event, form, formData) {
        const raw = foundry.utils.expandObject(formData.object);
        const patch = {
            bowsCannotStrongStrike: !!raw.bowsCannotStrongStrike,
            critSpDowngradeMode:    (raw.critSpDowngradeMode === "greaterToLesser"
                                  || raw.critSpDowngradeMode === "anyToSimple")
                                        ? raw.critSpDowngradeMode : "off",
            critBonusNeedsSpBreak:  !!raw.critBonusNeedsSpBreak,
            d10Explode:             !!raw.d10Explode,
            d10Collapse:            !!raw.d10Collapse,
            /* Signed integer clamp for to-hit modifiers — they can be
             * negative (penalty) or positive (a GM-turned house rule
             * that gives a bonus). Round to integer so form typos
             * don't inject a 0.5-mod that surprises later math. */
            extraActionToHit:    Math.round(Number(raw.extraActionToHit)    || 0),
            strongStrikePenalty: Math.round(Number(raw.strongStrikePenalty) || 0),
            offhandPenalty:      Math.round(Number(raw.offhandPenalty)      || 0),
            proneCrawlQuarterSpd: !!raw.proneCrawlQuarterSpd,
            containerEquipEV:     !!raw.containerEquipEV,
            adrenalineToTempSta:  !!raw.adrenalineToTempSta,
            /* STA costs clamped to non-negative — a "negative cost" would
             * add STA on defense, which breaks the round-tally invariant
             * that STA is a spent resource. */
            extraActionStaCost:  Math.max(0, Math.round(Number(raw.extraActionStaCost)  || 0)),
            extraDefenseStaCost: Math.max(0, Math.round(Number(raw.extraDefenseStaCost) || 0)),
            /* Crit brackets — coerced + ordering-clamped so simple<complex<difficult<deadly
             * is always true. hrCritBrackets also enforces this on read
             * (defense-in-depth), but persisting the corrected values
             * keeps the form and the getter in sync visually. */
            ...(() => {
                const one = (v, fallback) => Math.max(1, Math.round(Number(v) || fallback));
                let simple    = one(raw.critBracketSimple,     7);
                let complex   = one(raw.critBracketComplex,   10);
                let difficult = one(raw.critBracketDifficult, 13);
                let deadly    = one(raw.critBracketDeadly,    15);
                if (complex   <= simple)    complex   = simple    + 1;
                if (difficult <= complex)   difficult = complex   + 1;
                if (deadly    <= difficult) deadly    = difficult + 1;
                return {
                    critBracketSimple: simple,
                    critBracketComplex: complex,
                    critBracketDifficult: difficult,
                    critBracketDeadly: deadly
                };
            })(),
            /* Bonus-damage ladders — non-negative integers. No ordering
             * requirement (unlike brackets — bonus tiers are
             * independent flat values, GM could rationally want the
             * same or even lower values per tier). */
            critBonusSimple:            Math.max(0, Math.round(Number(raw.critBonusSimple)            ||  3)),
            critBonusComplex:           Math.max(0, Math.round(Number(raw.critBonusComplex)           ||  5)),
            critBonusDifficult:         Math.max(0, Math.round(Number(raw.critBonusDifficult)         ||  8)),
            critBonusDeadly:            Math.max(0, Math.round(Number(raw.critBonusDeadly)            || 10)),
            critBonusNoOrgansSimple:    Math.max(0, Math.round(Number(raw.critBonusNoOrgansSimple)    ||  5)),
            critBonusNoOrgansComplex:   Math.max(0, Math.round(Number(raw.critBonusNoOrgansComplex)   || 10)),
            critBonusNoOrgansDifficult: Math.max(0, Math.round(Number(raw.critBonusNoOrgansDifficult) || 15)),
            critBonusNoOrgansDeadly:    Math.max(0, Math.round(Number(raw.critBonusNoOrgansDeadly)    || 20))
        };
        await setHouseRulesConfig(patch);
        /* splitMovement / rawToxicity are backed by their own homebrew.<key>
         * world settings — write them alongside the payload so the House
         * Rules menu behaves as a single "Save all" surface. Only write
         * when the new value differs from the current one to avoid
         * spamming updateSetting hooks (and requiresReload prompts) for
         * an untouched toggle. */
        const writeIfChanged = async (key, next) => {
            const cur = !!game.settings.get(SYSTEM_ID, `homebrew.${key}`);
            if (cur !== next) await game.settings.set(SYSTEM_ID, `homebrew.${key}`, next);
        };
        await writeIfChanged("splitMovement", !!raw.splitMovement);
        await writeIfChanged("rawToxicity",   !!raw.rawToxicity);
        ui.notifications.info(t("WITCHER.App.HouseRulesConfig.Saved", "House rules saved."));
        /* No reload prompt: every consumer reads live via
         * `getHouseRulesConfig()` / the `hr*` getters, so the next
         * combat check picks up the change immediately. */
    }
}
