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
const FOOD_DRINK_DRUNK = [1,2,3,4,5,6,7,8].map(n => ({
    id:    `drunk-${n}`,
    name:  `Drunk ${["", "I","II","III","IV","V","VI","VII","VIII"][n]}`,
    img:   n >= 7 ? "icons/svg/skull.svg" : "icons/svg/tankard.svg",
    family: "drunk",
    tier:   n
}));
/* Hunger ladder — only IMPACTFUL tiers register as statuses. The "sated"
 * baseline (full / fed / peckish) has no mechanical effect per spec, so it
 * never lands as an AE; the satiety widget on the actor sheet still shows
 * those names as TIER LABELS (tierForSatiety in foodAndDrink.mjs computes
 * the full 6-tier map for display). */
const FOOD_DRINK_HUNGER = [
    { id: "gorged",   name: "Gorged",   img: "icons/svg/regen.svg", family: "hunger", tier: 5 },
    { id: "hungry",   name: "Hungry",   img: "icons/svg/degen.svg", family: "hunger", tier: 1 },
    { id: "famished", name: "Famished", img: "icons/svg/skull.svg", family: "hunger", tier: 0 }
];
const FOOD_DRINK_HANGOVER = [
    { id: "hangover", name: "Hangover", img: "icons/svg/sleep.svg", family: "hangover" }
];
const FOOD_DRINK = [...FOOD_DRINK_DRUNK, ...FOOD_DRINK_HUNGER, ...FOOD_DRINK_HANGOVER];

/* The default presentation layer (id / name / icon) before any GM override.
 * Food & Drink statuses are appended only when the homebrew toggle is on —
 * checked at buildStatusEffects() time, since registerSettings has already
 * run by then. */
const PURE_RAW_PRESENTATION = [...BASELINE, ...AIM];
function defaultPresentation() {
    const list = [...PURE_RAW_PRESENTATION];
    if (isHomebrewEnabled?.("foodAndDrink")) list.push(...FOOD_DRINK);
    return list;
}
/* Used by override-merge as "is this a default id" — we want the union of
 * RAW + every homebrew family, because turning off a toggle shouldn't make a
 * GM's custom override re-appear as a brand-new status. */
const ALL_DEFAULT_IDS = new Set([...PURE_RAW_PRESENTATION, ...FOOD_DRINK].map(s => s.id));

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
        list.push(finishStatusEntry({ ...s, name: o?.name ?? s.name, img: o?.img ?? s.img }));
    }
    for (const [id, o] of Object.entries(override)) {
        if (ALL_DEFAULT_IDS.has(id) || !o || o.removed) continue;
        const name = o.name || id;
        list.push(finishStatusEntry({ id, name, label: name, img: o.img || DEFAULT_STATUS_ICON }));
    }
    return list;
}

/* Default (no-override) registry — the seed used when the setting hasn't been
 * read yet. CONFIG.statusEffects is rebuilt from buildStatusEffects() at init,
 * AFTER settings register, so the homebrew gate is honored from then on. */
export const STATUS_EFFECTS = Object.freeze(
    PURE_RAW_PRESENTATION.map(finishStatusEntry)
);
