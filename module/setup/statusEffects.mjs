/**
 * statusEffects — the Witcher TRPG status effect registry.
 *
 * Registered onto `CONFIG.statusEffects` during init (main.mjs). Foundry
 * uses this list for the token HUD status toggle and for effect lookups
 * by id.
 *
 * Strict RAW (Core p.161-165): every combat condition is a single flat
 * status — there is no homebrew tier ladder. Bleeding is always 2/round,
 * Burning 5, Poison 3, Suffocation 3, etc. (The old Bleed I-V / Burning
 * I-VI / Acid I-VI / Suffocation II-IV tier sets are retired.)
 *
 * What each status DOES lives in `setup/statusClauses.mjs` and is
 * interpreted by `mechanics/statusEngine.mjs`. This file is just the
 * presentation layer: id, localized name, icon. Stat-debuff ActiveEffect
 * changes are pulled from the clause via `statusChanges(id)`; the RAW
 * description likewise comes from the clause, so there is one source of
 * truth for the mechanics.
 *
 * Toxicity is a SINGLE number stat per RAW (Core p.84) — its threshold
 * statuses are added separately (alchemyConsts.mjs). Food & drink homebrew
 * statuses (drunk-1..8, hunger ladder, hangover) are registered at the bottom
 * of this file, gated on `isHomebrewEnabled('foodAndDrink')`; their mechanics
 * live in setup/statusClauses.mjs.
 */

import { statusChanges, descriptionFor } from "../mechanics/statusEngine.mjs";
import { readStatusOverride } from "../mechanics/statusOverrides.mjs";
import { isHomebrewEnabled } from "../api/homebrew.mjs";

/* Fallback icon for a GM-added custom status that doesn't specify one. */
const DEFAULT_STATUS_ICON = "icons/svg/aura.svg";

/* Baseline statuses point at Foundry's bundled SVG icon library to avoid
 * shipping icon files. Mechanics (stat debuffs, DoT, locks) come from the
 * matching clause — these entries carry only id / name / icon. */
const BASELINE = [
    { id: "prone",        name: "WITCHER.Status.Prone",        img: "icons/svg/falling.svg"     },
    { id: "stunned",      name: "WITCHER.Status.Stunned",      img: "icons/svg/daze.svg"        },
    { id: "staggered",    name: "WITCHER.Status.Staggered",    img: "icons/svg/sword.svg"       },
    { id: "blinded",      name: "WITCHER.Status.Blinded",      img: "icons/svg/blind.svg"       },
    { id: "grappled",     name: "WITCHER.Status.Grappled",     img: "icons/svg/net.svg"         },
    { id: "pinned",       name: "WITCHER.Status.Pinned",       img: "icons/svg/net.svg"         },
    { id: "intoxicated",  name: "WITCHER.Status.Intoxicated",  img: "icons/svg/tankard.svg"     },
    { id: "hallucinating",name: "WITCHER.Status.Hallucinating",img: "icons/svg/stoned.svg"      },
    { id: "paralyzed",    name: "WITCHER.Status.Paralyzed",    img: "icons/svg/paralysis.svg"   },
    { id: "restrained",   name: "WITCHER.Status.Restrained",   img: "icons/svg/net.svg"         },
    { id: "entangled",    name: "WITCHER.Status.Entangled",    img: "icons/svg/net.svg"         },
    { id: "unconscious",  name: "WITCHER.Status.Unconscious",  img: "icons/svg/unconscious.svg" },
    { id: "dead",         name: "WITCHER.Status.Dead",         img: "icons/svg/skull.svg"       },
    { id: "poisoned",     name: "WITCHER.Status.Poisoned",     img: "icons/svg/poison.svg"      },
    { id: "overdosed",    name: "WITCHER.Status.Overdosed",    img: "icons/svg/hazard.svg"      },
    { id: "diseased",     name: "WITCHER.Status.Diseased",     img: "icons/svg/biohazard.svg"   },
    { id: "exhausted",    name: "WITCHER.Status.Exhausted",    img: "icons/svg/sleep.svg"       },
    { id: "freeze",       name: "WITCHER.Status.Freeze",       img: "icons/svg/frozen.svg"      },
    // Flat RAW damage-over-time conditions (DoT resolved by the tick engine).
    { id: "bleed",        name: "WITCHER.Status.Bleed",        img: "icons/svg/blood.svg"       },
    { id: "burning",      name: "WITCHER.Status.Burning",      img: "icons/svg/fire.svg"        },
    { id: "acid",         name: "WITCHER.Status.Acid",         img: "icons/svg/acid.svg"        },
    { id: "suffocation",  name: "WITCHER.Status.Suffocation",  img: "icons/svg/waterfall.svg"   },
    { id: "nausea",       name: "WITCHER.Status.Nausea",       img: "icons/svg/degen.svg"       },
    // Fast Draw (Core p.165): a pure marker read by the attack/cast flow.
    { id: "fastDraw",     name: "WITCHER.Status.FastDraw",     img: "icons/svg/upgrade.svg"     }
    /* No `bloodied` status — the wounded indicator is a PIXI visual
     * treatment (red inner-glow + blood streaks on the token mesh) that
     * does NOT obscure the portrait. See policy/health-state-visuals.mjs.
     * Dying uses the same PIXI path — grayscale mesh + ~20%-alpha skull
     * glyph centered, also non-obscuring. The canonical `dead` status
     * stays in the baseline above for MANUAL application (NPC killed by
     * narrative fiat, instant-kill abilities, etc.). */
];

// Aim (Core p.152): the full-round Aim action grants +1 to your next ranged
// attack, stacking up to +3. Modelled as a 3-rank status — re-aiming bumps the
// rank (combatRoundMixin.takeAimAction); the ranged attack reads the rank,
// applies it, and clears the status. Pure markers (no AE changes).
const AIM = [1, 2, 3].map(n => ({
    id:     `aim-${n}`,
    name:   `WITCHER.Status.Aim.${n}`,
    img:    "icons/svg/target.svg",
    label:  `Aim ${n}`,
    tier:   n,
    family: "aim"
}));

/* Food & drink homebrew (ADR 0003) — drunk ladder, hunger ladder, hangover.
 * Mechanics live in statusClauses.mjs; only the presentation layer is here.
 * Registration is gated on `isHomebrewEnabled('foodAndDrink')` so a pure-RAW
 * world doesn't see them in the token HUD or trigger their clauses (no AE
 * carrying a status can be applied if the status isn't registered). The
 * setting is requiresReload, so toggling rebuilds CONFIG.statusEffects from
 * a clean init — no live editing of the registry needed. */
/* Status icon directory — local SVGs shipped in /assets/icons/statuses/.
 * Filenames mirror the status id so the registry stays single-source: edit
 * the id, rename the SVG, both stay in sync. */
const ICON_DIR = "systems/witcher-ttrpg-death-march/assets/icons/statuses";
const FOOD_DRINK_DRUNK = [1,2,3,4,5,6,7,8].map(n => ({
    id:    `drunk-${n}`,
    name:  `Drunk ${["", "I","II","III","IV","V","VI","VII","VIII"][n]}`,
    img:   `${ICON_DIR}/drunk-${n}.svg`,
    family: "drunk",
    tier:   n
}));
/* Hunger ladder — the IMPACTFUL tiers plus Peckish (a heads-up warning that
 * carries no stats but lands on the token so the player sees Hungry is one
 * tick away). The "sated" baseline (full / fed) is intentionally NOT
 * registered — those names still show as TIER LABELS on the satiety widget
 * via tierForSatiety, just without an active effect. */
const FOOD_DRINK_HUNGER = [
    { id: "gorged",   name: "Gorged",   img: `${ICON_DIR}/gorged.svg`,   family: "hunger", tier: 5 },
    { id: "peckish",  name: "Peckish",  img: `${ICON_DIR}/peckish.svg`,  family: "hunger", tier: 2 },
    { id: "hungry",   name: "Hungry",   img: `${ICON_DIR}/hungry.svg`,   family: "hunger", tier: 1 },
    { id: "famished", name: "Famished", img: `${ICON_DIR}/famished.svg`, family: "hunger", tier: 0 }
];
const FOOD_DRINK_HANGOVER = [
    { id: "hangover", name: "Hangover", img: `${ICON_DIR}/hangover.svg`, family: "hangover" }
];
/* Food sickness — applied when an actor eats SPOILED food and fails the
 * Endurance save (mechanics/foodAndDrink.mjs#applySpoiledHazard). 1-day
 * native duration; cleared automatically on expiry. */
const FOOD_DRINK_SICKNESS = [
    { id: "food-sickness", name: "Food Sickness", img: `${ICON_DIR}/food-sickness.svg`, family: "sickness" }
];
const FOOD_DRINK = [...FOOD_DRINK_DRUNK, ...FOOD_DRINK_HUNGER, ...FOOD_DRINK_HANGOVER, ...FOOD_DRINK_SICKNESS];

/* Stress mental breaks + selected boons. Registered as statuses so the
 * modifier pipeline (rollMods, attackMod, statusChanges) picks them up when
 * applied to an actor. Only the breaks with mechanical effects (Scared,
 * Depressive, Violent) and the persistent boons (Focused, Determined Grit,
 * Smile at Death) need entries here — flavor-only breaks (Indulgent,
 * Paranoid, Impulsive, Selfish) and instant boons (stress clears) don't. */
const STRESS_BREAKS = [
    { id: "break-indulgent",         name: "Indulgent",         img: `${ICON_DIR}/break-indulgent.svg`,    family: "stress-break" },
    { id: "break-paranoid",          name: "Paranoid",          img: `${ICON_DIR}/break-paranoid.svg`,     family: "stress-break" },
    { id: "break-scared",            name: "Scared",            img: `${ICON_DIR}/break-scared.svg`,       family: "stress-break" },
    { id: "break-depressive",        name: "Depressive",        img: `${ICON_DIR}/break-depressive.svg`,   family: "stress-break" },
    { id: "break-impulsive",         name: "Impulsive",         img: `${ICON_DIR}/break-impulsive.svg`,    family: "stress-break" },
    { id: "break-self-harming",      name: "Self-Harming",      img: `${ICON_DIR}/break-self-harming.svg`, family: "stress-break" },
    { id: "break-selfish",           name: "Selfish",           img: `${ICON_DIR}/break-selfish.svg`,      family: "stress-break" },
    { id: "break-violent",           name: "Violent",           img: `${ICON_DIR}/break-violent.svg`,      family: "stress-break" }
];
const STRESS_BOONS = [
    { id: "boon-stoic",              name: "Stoic",             img: `${ICON_DIR}/boon-stoic.svg`,           family: "stress-boon" },
    { id: "boon-optimistic",         name: "Optimistic",        img: `${ICON_DIR}/boon-optimistic.svg`,      family: "stress-boon" },
    { id: "boon-hopeful",            name: "Hopeful",           img: `${ICON_DIR}/boon-hopeful.svg`,         family: "stress-boon" },
    { id: "boon-defiant",            name: "Defiant",           img: `${ICON_DIR}/boon-defiant.svg`,         family: "stress-boon" },
    { id: "boon-focused",            name: "Focused",           img: `${ICON_DIR}/boon-focused.svg`,         family: "stress-boon" },
    { id: "boon-stalwart",           name: "Stalwart",          img: `${ICON_DIR}/boon-stalwart.svg`,        family: "stress-boon" },
    { id: "boon-determined-grit",    name: "Determined Grit",   img: `${ICON_DIR}/boon-determined-grit.svg`, family: "stress-boon" },
    { id: "boon-unbreakable",        name: "Unbreakable",       img: `${ICON_DIR}/boon-unbreakable.svg`,     family: "stress-boon" },
    { id: "boon-smile-at-death",     name: "Smile at Death",    img: `${ICON_DIR}/boon-smile-at-death.svg`,  family: "stress-boon" }
];
const STRESS = [...STRESS_BREAKS, ...STRESS_BOONS];

/* The default presentation layer (id / name / icon) before any GM override.
 * Food & Drink statuses are appended only when the homebrew toggle is on —
 * checked at buildStatusEffects() time, since registerSettings has already
 * run by then. */
const PURE_RAW_PRESENTATION = [...BASELINE, ...AIM];
function defaultPresentation() {
    const list = [...PURE_RAW_PRESENTATION];
    if (isHomebrewEnabled?.("foodAndDrink")) list.push(...FOOD_DRINK);
    if (isHomebrewEnabled?.("stress"))       list.push(...STRESS);
    return list;
}
/* Used by override-merge as "is this a default id" — we want the union of
 * RAW + every homebrew family, because turning off a toggle shouldn't make a
 * GM's custom override re-appear as a brand-new status. */
const ALL_DEFAULT_IDS = new Set([...PURE_RAW_PRESENTATION, ...FOOD_DRINK, ...STRESS].map(s => s.id));

/* Attach a status entry's mechanics: stat-debuff `changes` (from the active
 * clause) and the RAW/overridden `description`, both read THROUGH the engine
 * so a GM edit flows in automatically. */
function finishStatusEntry(s) {
    const changes = statusChanges(s.id);
    return {
        ...s,
        ...(changes.length ? { changes } : {}),
        description: descriptionFor(s.id)
    };
}

/**
 * Build the live status registry: the default presentation merged with the
 * GM's `statusEffectsOverride` (renames, re-icons, removals, and brand-new
 * custom statuses), each entry finished with its clause-derived mechanics.
 *
 * Called at init (main.mjs) to populate CONFIG.statusEffects. The override
 * setting is `requiresReload: true`, so this re-runs from a clean init after
 * any save.
 */
export function buildStatusEffects() {
    const override = readStatusOverride();
    const list = [];
    for (const s of defaultPresentation()) {
        const o = override[s.id];
        if (o?.removed) continue;
        list.push(finishStatusEntry({
            ...s,
            name: o?.name ?? s.name,
            img:  o?.img  ?? s.img,
            // GM-set per-status rim color — overrides the family default in the
            // chrome dock badge. Undefined → no override (inherit family / RAW).
            ...(o?.rimColor ? { rimColor: o.rimColor } : {})
        }));
    }
    for (const [id, o] of Object.entries(override)) {
        if (ALL_DEFAULT_IDS.has(id) || !o || o.removed) continue;
        const name = o.name || id;
        list.push(finishStatusEntry({
            id, name, label: name,
            img: o.img || DEFAULT_STATUS_ICON,
            ...(o.rimColor ? { rimColor: o.rimColor } : {})
        }));
    }
    return list;
}

/* Default (no-override) registry — the seed used when the setting hasn't been
 * read yet. CONFIG.statusEffects is rebuilt from buildStatusEffects() at init,
 * AFTER settings register, so the homebrew gate is honored from then on. */
export const STATUS_EFFECTS = Object.freeze(
    PURE_RAW_PRESENTATION.map(finishStatusEntry)
);
