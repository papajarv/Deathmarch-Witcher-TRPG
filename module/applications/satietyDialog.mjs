/**
 * SatietyDialog — the click-through popup for the actor sheet satiety pill.
 *
 * Design goals:
 *   - Shows the anatomical stomach glyph filled to satiety-as-percent-of-MAX,
 *     with a Gorged overflow band above the fundus when applicable.
 *   - Numeric readout: current / max (and the Gorged ceiling if relevant).
 *   - Tier name in tier-colored text.
 *   - GM-only edit input + Save; players get read-only.
 *
 * Uses ApplicationV2 + Handlebars mixin so the window inherits Foundry's UI
 * scaling, drag/resize behaviour, and system-theme styling. The window class
 * `witcher-ttrpg-death-march` opts into the sheet's dark-amber theme.
 */
import { t } from "../chrome/lib/i18n.js";
import { getSatietyCeil, getSatietyGorgedCeil, getSatietyFloor, tierForSatiety, tierDisplayName, hourlySatietyLoss, adjustSatiety, isHungerActive, setHungerActive } from "../mechanics/foodAndDrink.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const SYSTEM_ID = "witcher-ttrpg-death-march";

/* Single unified color — every tier renders the same amber; the tier is
 * communicated by the stomach fill LEVEL + the tier NAME, not by a color
 * shift. Matches --wdm-amber-hi (also used by the sheet + chrome pills). */
const UNIFIED_COLOR = "#b89464";

export class SatietyDialog extends HandlebarsApplicationMixin(ApplicationV2) {
    constructor(options = {}) {
        /* Same options-bag pattern as RingPortraitCropper — destructure
         * dialog-specific args so ApplicationV2 doesn't see them, and set
         * a per-actor id so simultaneous dialogs for different actors get
         * their own window. */
        const { actor, ...rest } = options;
        const withId = { id: `wdm-satiety-${actor?.id ?? "unknown"}`, ...rest };
        super(withId);
        this.actor = actor ?? null;
    }

    static DEFAULT_OPTIONS = {
        classes: ["witcher-ttrpg-death-march", "wdm-satiety-dialog"],
        tag: "form",
        window: {
            /* Title is localized via ApplicationV2's built-in title
             * pipeline (it calls game.i18n.localize on this string), so
             * passing the key here is enough — no explicit t() call. */
            title: "WITCHER.Mech.FoodAndDrink.Dialog.Title",
            icon: "fa-solid fa-utensils",
            resizable: false
        },
        position: { width: 360, height: "auto" },
        form: {
            handler: SatietyDialog.#onSubmit,
            submitOnChange: false,
            /* Keep the window open on save — GM's expectation is to see
             * the new tier / fill level reflect immediately in the same
             * window they just typed into, then close manually. The
             * handler re-renders the dialog after adjustSatiety commits. */
            closeOnSubmit: false
        },
        actions: {
            toggleHunger: SatietyDialog.#onToggleHunger
        }
    };

    static PARTS = {
        main: { template: "systems/witcher-ttrpg-death-march/templates/applications/satiety-dialog.hbs" }
    };

    async _prepareContext(options) {
        const ctx = await super._prepareContext(options);
        const actor = this.actor;
        const cur   = Number(actor?.system?.satiety) || 0;
        const max   = getSatietyCeil(actor);
        const gorgedMax = getSatietyGorgedCeil(actor);
        const min   = getSatietyFloor(actor);
        const drain = hourlySatietyLoss(actor);
        const tier  = tierForSatiety(cur, actor);
        const visual = { label: tierDisplayName(tier), color: UNIFIED_COLOR };

        // Fill % of the stomach body (0-100, clamped).
        const fillPct = max > 0 ? Math.max(0, Math.min(100, Math.round((cur / max) * 100))) : 0;
        // Overflow % — how deep into the Gorged band the actor is.
        let overflowPct = 0;
        if (cur > max && gorgedMax > max) {
            overflowPct = Math.max(0, Math.min(100, Math.round(((cur - max) / (gorgedMax - max)) * 100)));
        }

        // SVG geometry — stomach path spans y=8..180 in the 191.756 viewBox.
        const fillHeight = Math.round(172 * (fillPct / 100));
        const fillTop    = Math.round(8 + (172 - fillHeight));
        const overflowWidth = Math.round(80 * (overflowPct / 100));

        // Anatomical stomach path (svgrepo.com — CC0).
        const stomachPath = "M189.037,74.668c-7.97-32.176-34.188-32.853-48.274-33.216c-2.92-0.075-5.442-0.14-7.13-0.438c-8.423-1.487-13.116-7.29-14.345-17.741l-1.306-11.096c-0.23-1.956-1.849-3.453-3.816-3.53L97.522,7.994c-1.102-0.05-2.163,0.366-2.949,1.133c-0.786,0.766-1.223,1.822-1.208,2.919c0.014,1.013,0.457,25.028,10.605,43.634c5.42,9.936,15.738,34.799-5.449,51.042c-9.796,7.51-18.104,10.859-26.936,10.86c-5.97,0-12.088-1.415-20.025-3.697c-3.727-1.072-7.666-1.615-11.705-1.615c-15.869,0-29.768,8.159-34.586,20.302c-5.796,14.609-5.345,20.325-5.196,21.322c0.293,1.958,1.976,3.408,3.956,3.408H21c2.209,0,4-1.791,4-4c0-0.41,0.17-10.033,14.928-10.033c6.74,0,8.533,3.229,11.946,10.532c3.37,7.212,7.564,16.188,20.119,21.465c10.001,4.204,22.022,8.5,35.35,8.501c0.001,0,0.001,0,0.002,0c15.681,0,30.543-5.967,45.435-18.24C186.073,138.086,197.594,109.215,189.037,74.668z";

        Object.assign(ctx, {
            actorName:   actor?.name ?? "",
            current:     cur,
            max, gorgedMax, min,
            tier,
            tierLabel:   visual.label,
            tierColor:   visual.color,
            fillPct, overflowPct,
            fillTop, fillHeight, overflowWidth,
            stomachPath,
            drainPerHour: drain,
            hoursToFamished: drain > 0 ? Math.round((cur - 0) / drain * 10) / 10 : null,
            hoursSinceFull:  drain > 0 ? Math.round((max - cur) / drain * 10) / 10 : null,
            isGM:            !!game.user?.isGM,
            hungerActive:    isHungerActive(actor),
            hungerStress:    Number(actor?.system?.hungerStress) || 0,
            buttons: (!!game.user?.isGM) ? [{ type: "submit", icon: "fa-solid fa-floppy-disk", label: t("WITCHER.Common.Save", "Save") }] : []
        });
        return ctx;
    }

    /* GM-only toggle: turn the hourly hunger tick on/off for this actor.
     * Default is OFF for every actor — the GM opts in via this checkbox
     * (satiety cascade would otherwise run for every NPC "character" in
     * the world on every day-skip, which is the observed lag source in
     * high-NPC-count worlds). Re-renders after the flag write so the
     * checkbox reflects the persisted state. */
    static async #onToggleHunger(event, target) {
        if (!this.actor || !game.user?.isGM) return;
        const checked = !!target?.checked;
        await setHungerActive(this.actor, checked);
        this.render();
    }

    static async #onSubmit(event, form, formData) {
        const data = foundry.utils.expandObject(formData.object);
        if (!this.actor || !game.user?.isGM) return;
        const raw = Number(data.satiety);
        if (!Number.isFinite(raw)) return;
        const cur = Number(this.actor.system?.satiety) || 0;
        const delta = raw - cur;
        if (delta !== 0) {
            // Route through adjustSatiety so the hunger cascade / tier
            // reconcile fires as it normally would for a food consume.
            await adjustSatiety(this.actor, delta);
        }
        // Re-render in place so the new tier / fill / numeric readout
        // reflect immediately in the still-open dialog.
        this.render();
    }
}

/** Convenience opener used from sheet click handlers. Async so the caller
 *  can await and surface any render error rather than losing it in an
 *  unhandled promise rejection. */
export async function openSatietyDialog(actor) {
    if (!actor) return;
    const dialog = new SatietyDialog({ actor });
    await dialog.render(true);
    return dialog;
}
