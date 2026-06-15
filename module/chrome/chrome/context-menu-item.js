/**
 * Item context-menu — adds "[1 charge] Harvest Materials",
 * "[1 charge] Extract Mutagen", and "[1 charge] Dissect" entries on
 * remains items (valuable with system.type === "remains").
 *
 * Follows the same pattern as witcher-food-and-drink/charges.mjs:
 *   - installSheetContextMenuExtra(builder)  installs a single shared
 *     itemContextMenu shim (idempotent, marked on the prototype) and pushes
 *     `builder` onto the shim's `__wtrpgItemContextMenuExtras` array. Peer
 *     modules using the same convention coexist without clobbering, and
 *     other code in this module (e.g. inventory.js for Drop on Scene) can
 *     register additional builders without re-implementing the walker.
 *   - registerActorSheetHooks() uses renderWitcher*Sheet hooks to inject a
 *     charge badge and a GM configure-button into each remains item row.
 *
 * Charge state is stored in item flags under MODULE_ID:
 *   remainsCharges    — current charges (0–3, defaults to 3 for fresh items)
 *   remainsBaseWeight — weight at 3/3 charges (snapshotted on first use)
 */

import { MODULE_ID } from "../setup/settings.js";
import { isStudyBook, isReadableBook, interactWithBook, canReviewBook, reviewStressBookChapters } from "../sheets/valuable-study.js";
import { doDissect } from "./dissect.js";
import { doHarvest, openCarcassPopup } from "./harvest.js";
import { encKey, bestiaryKeyFor, bumpResearchIfZero } from "../lib/bestiary.js";
import { reloadWithPrompt } from "../lib/reload.js";

function escapeText(s) {
  return String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
}

const ICON_HARVEST = '<i class="fa-solid fa-scissors"></i>';
const ICON_EXTRACT = '<i class="fa-solid fa-flask-vial"></i>';
const ICON_DISSECT = '<i class="fa-solid fa-stethoscope"></i>';
const ICON_READ    = '<i class="fa-solid fa-book-open"></i>';
const ICON_REVIEW  = '<i class="fa-solid fa-list-ol"></i>';
const ICON_CFG     = '<i class="fa-solid fa-bone"></i>';

const CHARGES_MAX      = 3;
const CHARGES_FLAG     = "remainsCharges";
const BASE_WEIGHT_FLAG = "remainsBaseWeight";
const MONSTER_UUID_FLAG = "monsterUuid";       // set by monster-remains.js on creation
const EXTRACTED_FLAG    = "mutagenExtracted";  // set by doExtractMutagen on SUCCESS only
const HARVESTED_FLAG       = "harvested";      // set by doHarvestMaterials on SUCCESS only

// Dissection (Extract Mutagen) rules.
const EXTRACT_SKILL_NAME = "Witcher Training";
const EXTRACT_DC = 16;

const SYSTEM_ENTRY_METHODS = [
    'editItem', 'equipMenuEntries', 'consumableItem', 'removableEnhancement',
    'giftableItem', 'dismantableItem', 'deleteItem'
];

export function isRemains(item) {
    return item?.type === "valuable" && item?.system?.type === "remains";
}

export function getCharges(item) {
    return item?.flags?.[MODULE_ID]?.[CHARGES_FLAG] ?? CHARGES_MAX;
}

/** True once Extract Mutagen has succeeded on this remains item. A failed
 *  extraction still costs a charge but does NOT set this — the player can
 *  try again with the remaining charges. */
export function hasExtractedMutagen(item) {
    return !!item?.flags?.[MODULE_ID]?.[EXTRACTED_FLAG];
}

/** Same one-shot semantics for the harvest action. */
export function hasHarvestedMaterials(item) {
    return !!item?.flags?.[MODULE_ID]?.[HARVESTED_FLAG];
}

/** Whether the "Extract Mutagen" action can still be offered on this item. */
function canExtract(item) {
    return isRemains(item)
        && getCharges(item) >= 1
        && !hasExtractedMutagen(item);
}

export async function runCarcassAction(action, item, actor = null) {
    const cost = 1;

    const flags      = item.flags?.[MODULE_ID] ?? {};
    const current    = flags[CHARGES_FLAG]     ?? CHARGES_MAX;
    const baseWeight = flags[BASE_WEIGHT_FLAG] ?? Number(item.system?.weight ?? 0);

    if (current < cost) {
        const label = action === "harvest" ? "[1 charge] Harvest Materials"
                    : action === "extract" ? "[1 charge] Extract Mutagen"
                    : "[1 charge] Dissect";
        ui.notifications?.warn(
            `${label}: not enough charges on "${item.name}" — ${current} remaining, need ${cost}.`
        );
        return;
    }

    // Per-action mechanic. If the action returns false, abort BEFORE decrementing
    // charges — failed pre-conditions shouldn't waste a body.
    if (action === "extract") {
        const ok = await doExtractMutagen(item, actor);
        if (ok === false) return;
    } else if (action === "harvest") {
        const ok = await doHarvest(item, actor);
        if (ok === false) return;
    } else if (action === "dissect") {
        const ok = await doDissect(item, actor);
        if (ok === false) return;
    }

    const remaining = current - cost;
    // Each spent charge cuts the carcass to a third of its previous weight
    // (base → base/3 → base/9 → base/27 across the three charges).
    const spent     = CHARGES_MAX - remaining;
    const newWeight = parseFloat((baseWeight * Math.pow(1 / 3, spent)).toFixed(2));

    await item.update({
        "system.weight":                            newWeight,
        [`flags.${MODULE_ID}.${CHARGES_FLAG}`]:     remaining,
        [`flags.${MODULE_ID}.${BASE_WEIGHT_FLAG}`]: baseWeight,
    });

    if (remaining === 0) {
        /* Spent body. If it still holds harvested loot the player hasn't
         * collected, keep it around so the carcass popup can be opened to
         * retrieve the contents — it's destroyed once emptied (see
         * harvest.js removeEntry). Otherwise destroy it now. */
        const leftover = item.flags?.[MODULE_ID]?.harvest?.contents;
        if (Array.isArray(leftover) && leftover.length > 0) {
            ui.notifications?.info(`${item.name} — fully consumed, but still holds harvested loot. Open it to collect.`);
            return;
        }
        ui.notifications?.info(`${item.name} — fully consumed, destroyed.`);
        await item.delete();
        return;
    }

    const label = action === "harvest" ? "Harvest Materials"
                : action === "extract" ? "Extract Mutagen"
                : "Dissect";
    ui.notifications?.info(
        `${label}: ${item.name} — ${remaining}/${CHARGES_MAX} charges remaining.`
    );
}

/**
 * Extract Mutagen mechanic.
 *   - Looks up the monster the carcass came from via the MONSTER_UUID_FLAG
 *     that monster-remains.js set on creation.
 *   - Reads the monster's linked mutagen from system.mutagen.uuid.
 *   - Rolls the actor's "Witcher Training" profession skill vs DC 16 via the
 *     system's own doProfessionSkillRoll (chat card, crit/fumble, threshold UI).
 *   - On pass, copies the mutagen onto the actor.
 *
 * Returns:
 *   false → preconditions failed (skill missing, no source, no mutagen);
 *           runCarcassAction will SKIP the charge decrement so no body is wasted.
 *   true  → roll fired (pass OR fail); the charge decrement proceeds.
 */
async function doExtractMutagen(item, actor) {
    if (!actor) {
        ui.notifications?.warn("Extract Mutagen must be triggered from a character sheet, not the sidebar.");
        return false;
    }

    if (typeof actor.findProfessionSlot !== "function") {
        ui.notifications?.error(`System's profession-skill helper missing — cannot extract.`);
        return false;
    }
    const slot = actor.findProfessionSlot(EXTRACT_SKILL_NAME);
    if (!slot) {
        ui.notifications?.error(`${actor.name} doesn't know how to extract mutagens (no "${EXTRACT_SKILL_NAME}" profession skill).`);
        return false;
    }

    const monsterUuid = item.system?.monsterUuid || item.flags?.[MODULE_ID]?.[MONSTER_UUID_FLAG];
    if (!monsterUuid) {
        ui.notifications?.error(`These remains aren't linked to a source monster.`);
        return false;
    }
    const monster = await fromUuid(monsterUuid);
    if (!monster) {
        ui.notifications?.error(`The source monster could not be found (deleted or compendium not loaded).`);
        return false;
    }

    const mutagenUuid = monster.system?.mutagen?.uuid;
    if (!mutagenUuid) {
        const msg = `${monster.name} carries no mutagen — extraction yields nothing.`;
        ui.notifications?.warn(msg);
        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            content: `<div class="wou-extract-card">
              <h3 style="margin:0 0 4px;">Extract Mutagen · ${escapeText(item.name)}</h3>
              <p style="margin:0;font-style:italic;opacity:0.85;">${escapeText(msg)}</p>
            </div>`
        });
        return false;
    }
    const mutagen = await fromUuid(mutagenUuid);
    if (!mutagen) {
        ui.notifications?.error(`${monster.name}'s linked mutagen could not be found (deleted or unloaded).`);
        return false;
    }

    if (typeof actor.rollProfessionSkill !== "function") {
        ui.notifications?.error(`System's profession-skill roll helper missing — cannot extract.`);
        return false;
    }

    const roll = await actor.rollProfessionSkill(slot, { dc: EXTRACT_DC });
    const total = roll?.total ?? 0;

    if (total >= EXTRACT_DC) {
        const data = mutagen.toObject();
        delete data._id;
        // Force quantity 1 — each extraction is a separate item, not a stack.
        // createEmbeddedDocuments already bypasses the system's addItem
        // merge-by-name, but the source mutagen might carry a stacked
        // quantity so we reset it explicitly here.
        data.system ??= {};
        data.system.quantity = 1;
        await actor.createEmbeddedDocuments("Item", [data]);
        // One-shot on the carcass.
        await item.setFlag(MODULE_ID, EXTRACTED_FLAG, true);
        // Reveal the mutagen on this PC's bestiary entry for the monster
        // so the bestiary panel renders its name + description from now on.
        await revealMutagenInBestiary(actor, monster, mutagen);
        ui.notifications?.info(`${actor.name} extracted ${mutagen.name} from ${item.name}.`);
    } else {
        ui.notifications?.info(`${actor.name} failed the extraction (rolled ${total} vs DC ${EXTRACT_DC}).`);
    }
    /* The act of cutting the body open to attempt an extraction (pass or
     * fail) counts as observation — bump research 0 → 1 if it's still 0.
     * The helper is safe-against-downgrade (a player already at tier 3
     * stays at tier 3). */
    await bumpResearchIfZero(actor, monster);
    return true;
}

/** Write `dissection.mutagenRevealed = true` on this PC's bestiary entry
 *  for the source monster, merging the bestiary doc so existing fields
 *  (research, encounters, dissection.facts) aren't blown away. Uses
 *  bestiaryKeyFor so the key matches what bestiary.js's panel renders
 *  under — same canonical key chain. */
async function revealMutagenInBestiary(actor, monster, mutagen) {
    const key  = bestiaryKeyFor(monster);
    if (!key) return;
    const path = `bestiary.${encKey(key)}`;
    const entry = actor.getFlag(MODULE_ID, path) ?? {};
    const next = {
        ...entry,
        dissection: { ...(entry.dissection ?? {}), mutagenRevealed: true },
    };
    try { await actor.setFlag(MODULE_ID, path, next); }
    catch (err) { console.warn(`${MODULE_ID} | failed to reveal mutagen on bestiary entry`, err); }
}

/* Harvest Materials and Dissect mechanics live in their own modules
 * (chrome/harvest.js and chrome/dissect.js). runCarcassAction above
 * dispatches into them. */

/* ============================================================
   0. Unified item-action registry
   ------------------------------------------------------------
   Register an item action ONCE here and it appears on every
   surface that shows an item context menu: the Witcher actor
   sheets, the chrome inventory overlay, AND the Foundry Items
   sidebar directory. No more hand-mirroring the same entry per
   surface.

   An action is { name, icon, condition?, callback } where both
   condition and callback receive (item, actor, ctx):
     item  — the resolved Item (owned by an actor, or a world item)
     actor — who to act against: the sheet's actor, the overlay's
             assigned actor, or the user's assigned character for
             the sidebar (may be null in the sidebar)
     ctx   — { source: "sheet" | "overlay" | "sidebar" }
   ============================================================ */
const _itemActions = [];

export function registerItemAction(action) {
    if (action && typeof action.callback === "function") _itemActions.push(action);
}

/* Adapt the registry to one surface. `resolveItem(row)` → Item|null and
 * `resolveActor(row)` → Actor|null bridge that surface's DOM/ownership
 * model; `source` tags the ctx. Returns ContextMenu entries in the
 * {name, icon, condition(row), callback(row)} shape every surface expects.
 *
 * An action may opt OUT of a surface with `surfaces: { sidebar: false }` —
 * used for owned-dose actions (Consume, Apply Oil) that only make sense
 * against a held item on the sheet/overlay, not a world template in the
 * Items sidebar. Default is to appear on every surface. */
export function buildItemActionEntries(resolveItem, resolveActor, source) {
    return _itemActions.filter((action) => action.surfaces?.[source] !== false).map((action) => ({
        name: action.name,
        icon: action.icon,
        condition: (row) => {
            const item = resolveItem(row);
            if (!item) return false;
            try { return action.condition ? !!action.condition(item, resolveActor(row), { source }) : true; }
            catch (err) { console.error(`${MODULE_ID} | item action "${action.name}" condition failed`, err); return false; }
        },
        callback: (row) => {
            const item = resolveItem(row);
            if (!item) return;
            try { action.callback(item, resolveActor(row), { source }); }
            catch (err) { console.error(`${MODULE_ID} | item action "${action.name}" callback failed`, err); }
        }
    }));
}

/* Run an item's PRIMARY context action — the first registered action whose
 * condition passes for (item, actor). Used by the hotbar's left-click "use":
 * oils -> Apply to Weapon, remains -> Harvest, books -> Study/Read, food/drink
 * -> Pour/Serve, etc. Returns true if an action ran, false if none applied (so
 * the caller can fall back to opening the sheet). `source` defaults to a
 * dedicated "hotbar" tag — no action opts out of it, so every surface-agnostic
 * action is eligible. */
export function runPrimaryItemAction(item, actor, source = "hotbar") {
    if (!item) return false;
    for (const action of _itemActions) {
        if (action.surfaces?.[source] === false) continue;
        let ok = false;
        try { ok = action.condition ? !!action.condition(item, actor, { source }) : true; }
        catch (err) { console.error(`${MODULE_ID} | item action "${action.name}" condition failed`, err); continue; }
        if (!ok) continue;
        try { action.callback(item, actor, { source }); return true; }
        catch (err) { console.error(`${MODULE_ID} | item action "${action.name}" callback failed`, err); return false; }
    }
    return false;
}

/* Sheet extras builder — installSheetContextMenuExtra binds `this` to the
 * actor sheet at render time, so resolution reads the live sheet.actor. */
function sheetItemActionsBuilder() {
    const sheet = this;
    return buildItemActionEntries(
        (itemHtml) => sheet.actor?.items?.get(itemHtml?.dataset?.itemId),
        () => sheet.actor,
        "sheet"
    );
}

/* Take Trophy — spawn a trophy valuable named "<Monster> Trophy", inheriting
 * the carcass icon (the configured trophy icon when set), weighing 10% of the
 * ORIGINAL carcass weight (the base, not the charge-reduced current weight). */
async function takeTrophy(item, actor = null) {
    const flags        = item.flags?.[MODULE_ID] ?? {};
    const baseWeight   = flags[BASE_WEIGHT_FLAG] ?? Number(item.system?.weight ?? 0);
    const trophyWeight = parseFloat((baseWeight * 0.1).toFixed(2));
    const monsterName  = item.name.replace(/\s*Carcass\s*$/i, "").trim() || item.name;
    // Trophy availability tracks the monster's threat difficulty.
    const TROPHY_AVAIL = { easy: "common", medium: "poor", hard: "rare", exceptional: "rare" };
    const availability = TROPHY_AVAIL[flags.monsterDifficulty] ?? "common";
    const trophyData = {
        name: `${monsterName} Trophy`,
        type: "valuable",
        img:  flags.trophyIcon || item.img,
        system: {
            type:        "trophy",
            weight:      trophyWeight,
            availability: availability,
            cost:        0,
            quantity:    "1",
            monsterUuid: flags[MONSTER_UUID_FLAG] ?? item.system?.monsterUuid ?? "",
            description: "",
            isHidden:    false,
            isStored:    false,
            isCarried:   true,
        },
        ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER },
    };
    // Put the trophy where the carcass lives: an owned carcass → its owner's
    // inventory (mirrors Harvest/Extract); a loose world/scene carcass → a
    // world item. Carving a trophy off a body in your pack shouldn't spawn a
    // stray world item.
    const owner = (actor?.documentName === "Actor") ? actor
                : (item.parent?.documentName === "Actor") ? item.parent
                : null;
    if (owner) await owner.createEmbeddedDocuments("Item", [trophyData]);
    else       await Item.create(trophyData, { displaySheet: false });
    await item.setFlag(MODULE_ID, "trophyTaken", true);
    ui.notifications?.info(`Trophy taken: "${monsterName} Trophy".`);
}

/* The carcass (Harvest/Extract/Dissect/Open) and book (Study/Read/Review)
 * actions, registered once for all surfaces. */
function registerCarcassAndBookActions() {
    const remainsAction = (label, icon, action, cost) => ({
        name: label, icon,
        condition: (item) => {
            if (!isRemains(item) || getCharges(item) < cost) return false;
            if (action === "extract" && hasExtractedMutagen(item))   return false;
            if (action === "harvest" && hasHarvestedMaterials(item)) return false;
            return true;
        },
        callback: (item, actor) => runCarcassAction(action, item, actor)
    });
    registerItemAction(remainsAction("[1 charge] Harvest Materials", ICON_HARVEST, "harvest", 1));
    registerItemAction(remainsAction("[1 charge] Extract Mutagen",   ICON_EXTRACT, "extract", 1));
    registerItemAction(remainsAction("[1 charge] Dissect",           ICON_DISSECT, "dissect", 1));
    registerItemAction({
        name: "Open Carcass",
        icon: '<i class="fa-solid fa-box-open"></i>',
        condition: (item) => {
            if (!isRemains(item)) return false;
            const contents = item.flags?.[MODULE_ID]?.harvest?.contents;
            return Array.isArray(contents) && contents.length > 0;
        },
        callback: (item) => openCarcassPopup(item)
    });
    registerItemAction({
        name: "Take Trophy",
        icon: '<i class="fa-solid fa-trophy"></i>',
        condition: (item) => isRemains(item) && !item.flags?.[MODULE_ID]?.trophyTaken,
        callback: (item, actor) => takeTrophy(item, actor)
    });
    registerItemAction({
        name: "Study", icon: '<i class="fa-solid fa-magnifying-glass"></i>',
        condition: (item) => isStudyBook(item),
        callback: (item) => interactWithBook(item)
    });
    registerItemAction({
        name: "Read", icon: ICON_READ,
        condition: (item) => isReadableBook(item),
        callback: (item) => interactWithBook(item)
    });
    registerItemAction({
        name: "Review Chapters", icon: ICON_REVIEW,
        condition: (item, actor) => !!(item && actor && canReviewBook(item, actor)),
        callback: (item) => reviewStressBookChapters(item)
    });
}

/* Fast Draw (Core p.165): snap-drawing a weapon and making an attack the same
 * turn. It is a way INTO the turn order, so it only makes sense before
 * initiative is locked: out of combat (rolls you in) or on round 1. After
 * round 1 you already have a turn — no snap-draw re-entry. Also blocked if the
 * actor is already mid-fast-draw (status active). */
export function canFastDraw(actor) {
    if (!actor || actor.statuses?.has?.("fastDraw")) return false;
    const combat = game.combat;
    if (!combat?.started) return true;
    return (Number(combat.round) || 0) <= 1;
}

/* Fast draw is a snap-draw from a worn sheath/scabbard — the weapon must be
 * stowed in one of the actor's EQUIPPED containers, the same place a normal
 * draw pulls from. A loose weapon, or one in a stowed pack, can't be
 * fast-drawn. */
export function isItemInEquippedContainer(actor, item) {
    if (!actor || !item) return false;
    for (const c of actor.items) {
        if (c.type !== "container" || c.system?.equipped !== true) continue;
        const content = c.system?.content ?? [];
        if (content.includes(item.uuid) || content.includes(item.id)) return true;
    }
    return false;
}

/* Perform a fast draw: actually draw the weapon into hand, flag the `fastDraw`
 * status (the attack/cast flow reads it and folds in the -3 to hit), and roll
 * the actor into initiative with a +3 bonus on top of the usual 1d10 + REF.
 * Mirrors the dock's initiative action: re-roll an existing combatant, else
 * create one. Returns true if the fast draw went through, false if it couldn't
 * (not allowed, or the draw was blocked by a hand conflict). */
export async function fastDrawWeapon(item, actor) {
    // Already in hand → nothing to draw. Guards the hotbar Shift path too,
    // since that calls fastDrawWeapon directly without the menu condition.
    if (!actor || item?.type !== "weapon" || item.system?.equipped || !canFastDraw(actor)) return false;
    // Must be stowed in an equipped container — you can't snap-draw a loose
    // item or one in a stowed pack (same access rule as a normal draw).
    if (!isItemInEquippedContainer(actor, item)) {
        ui?.notifications?.warn?.("Can't fast draw — the weapon must be stowed in an equipped container (sheath/scabbard).");
        return false;
    }

    // Fast draw is a real draw — pull the weapon into hand first. drawWeapon
    // warns and bails on a hand conflict; detect that via the equipped flag.
    // Imported lazily to avoid a static import cycle with inventory.js.
    // spendAction:false — the snap-draw is free; unlike a normal draw it does
    // NOT cost an action (it folds into the same-turn attack).
    try {
        const { drawWeapon } = await import("./inventory.js");
        await drawWeapon(actor, item, { spendAction: false });
    } catch (err) { console.warn(`${MODULE_ID} | fast draw: draw failed`, err); }
    if (!item.system?.equipped) return false;

    try { await actor.toggleStatusEffect?.("fastDraw", { active: true }); }
    catch (err) { console.warn(`${MODULE_ID} | fast draw: failed to set status`, err); }

    // Fast draw rolls you straight into the fight: get or create the encounter,
    // add this actor as a combatant, roll initiative at +3, and (GM) start the
    // encounter so you're acting immediately. Actor#rollInitiative auto-creates
    // the Combat when none is active (Foundry actor.mjs) and returns it.
    const ref = Number(actor.system?.stats?.ref?.value) || 0;
    const formula = `1d10 + ${ref} + 3`;
    try {
        let combat = game.combat;
        const existing = combat?.combatants.filter(c => c.actorId === actor.id) ?? [];
        if (combat && existing.length) {
            await combat.rollInitiative(existing.map(c => c.id), { formula });
        } else if (typeof actor.rollInitiative === "function") {
            CONFIG.Combat.initiative.formula = formula;
            combat = await actor.rollInitiative({ createCombatants: true, rerollInitiative: true });
        }
        // Begin the encounter so war mode engages and turns start (GM only —
        // Combat#startCombat is a GM-side mutation).
        if (combat && !combat.started && game.user?.isGM) await combat.startCombat();
    } catch (err) {
        console.error(`${MODULE_ID} | fast draw: failed to roll initiative`, err);
    }
    return true;
}

function registerWeaponDrawAction() {
    registerItemAction({
        name: "WITCHER.Weapon.Draw",
        icon: '<i class="fa-solid fa-bolt"></i>',
        condition: (item, actor) => item?.type === "weapon" && !item.system?.equipped && canFastDraw(actor) && isItemInEquippedContainer(actor, item),
        callback: (item, actor) => fastDrawWeapon(item, actor),
        surfaces: { sidebar: false }
    });
}

/* Reload / Unload for ammo-firing chamber weapons (crossbows). Bows have no
 * chamber, so they never qualify — they draw straight from selected ammo at
 * fire time. Both act against the wielder's equipped containers, so they only
 * make sense on an owned weapon (sheet / overlay), never a sidebar template. */
function registerWeaponReloadActions() {
    const chamberLoadable = (item) => {
        if (!item?.usesAmmo || !item.hasChamber) return false;
        const cnt = Number(item.system?.loaded?.count) || 0;
        const cap = Math.max(1, Number(item.system?.loaded?.capacity) || 1);
        return cnt < cap && (item.getEligibleAmmo?.().length ?? 0) > 0;
    };
    registerItemAction({
        name: "Reload",
        icon: '<i class="fa-solid fa-arrows-rotate"></i>',
        condition: (item) => chamberLoadable(item),
        callback: (item) => reloadWithPrompt(item),
        surfaces: { sidebar: false }
    });
    registerItemAction({
        name: "Unload",
        icon: '<i class="fa-solid fa-arrow-up-from-bracket"></i>',
        condition: (item) => !!item?.usesAmmo && item.hasChamber && item.isLoaded,
        callback: (item) => item.unload(),
        surfaces: { sidebar: false }
    });
}

/* ============================================================
   1. Items sidebar (global Items panel)
   ============================================================ */

function resolveSidebarItem(li) {
    const id = li?.dataset?.documentId ?? li?.dataset?.entryId;
    return id ? game.items?.get(id) : null;
}

function sidebarPourEntry(label, icon, category) {
    return {
        name: label,
        icon,
        condition: (li) => {
            const api = game.witcherFoodAndDrink?.charges;
            if (!api) return false;
            const item = resolveSidebarItem(li);
            if (!item || !api.isCharged(item)) return false;
            const cfg = api.getConfig(item);
            return (cfg?.category || 'drink') === category && Number(cfg?.current ?? 0) > 0;
        },
        callback: (li) => {
            const item = resolveSidebarItem(li);
            if (item) game.witcherFoodAndDrink?.charges?.pourGlass(item, 1);
        }
    };
}

/* ============================================================
   2. Actor-sheet context menu — shared shim (peer-safe)
   ------------------------------------------------------------
   The shim and the marker keys are intentionally identical to
   witcher-food-and-drink/charges.mjs so the two modules cooperate
   instead of overwriting each other's entries. Whichever module
   loads first installs the shim; the other sees the marker and
   only pushes its entries.
   ============================================================ */

const CTX_EXTRAS_KEY    = "__wtrpgItemContextMenuExtras";
const CTX_OVERRIDES_KEY = "__wtrpgItemContextMenuOverrides";
const CTX_PATCHED_KEY   = "__wtrpgItemContextMenuPatched";

function ensureContextMenuShim(cls) {
    const proto = cls.prototype;
    // Already upgraded (our shim, with overrides support).  Skip.
    const hasOurShim = Object.prototype.hasOwnProperty.call(proto, CTX_OVERRIDES_KEY);
    if (hasOurShim) return;

    // If a peer module's older shim is already installed (CTX_PATCHED_KEY set
    // but no CTX_OVERRIDES_KEY), we still upgrade — replacing the function
    // with our override-aware version.  The CTX_EXTRAS_KEY array is preserved
    // so any extras the peer pushed remain wired.  Peers that try to install
    // after us see CTX_PATCHED_KEY and bail, but their extras still land in
    // the shared array.
    if (!Object.prototype.hasOwnProperty.call(proto, CTX_EXTRAS_KEY)) {
        proto[CTX_EXTRAS_KEY] = [];
    }
    proto[CTX_OVERRIDES_KEY] = new Map();
    proto.itemContextMenu = function (html) {
        // Build the system's base entries, applying any registered override
        // wrappers per method (so stack-aware Gift/Delete can replace the
        // stock ones in-place).  Wrappers are stacked: each receives the
        // entry the previous wrapper returned.
        const overrides = this[CTX_OVERRIDES_KEY] ?? new Map();
        // Most system methods return a single entry; some (equipMenuEntries)
        // return an array of them. Normalize to a flat list so the array-valued
        // builders contribute all their entries instead of one nested array.
        const baseEntries = SYSTEM_ENTRY_METHODS
            .filter(m => typeof this[m] === "function")
            .flatMap(m => {
                const result = this[m]();
                if (!result) return [];
                const list = Array.isArray(result) ? result.filter(Boolean) : [result];
                const wrappers = overrides.get(m);
                if (!wrappers?.length) return list;
                return list.map(entry => wrappers.reduce((curr, fn) => {
                    try { return fn.call(this, curr) ?? curr; }
                    catch (err) {
                        console.error(`itemContextMenu override for ${m} failed`, err);
                        return curr;
                    }
                }, entry));
            });
        const extras = (this[CTX_EXTRAS_KEY] ?? []).flatMap((fn) => {
            try { return fn.call(this) ?? []; }
            catch (err) {
                console.error("itemContextMenu extras builder failed", err);
                return [];
            }
        });
        // fixed:true renders the menu in a <body>-level layer; without it the
        // <nav> nests inside the right-clicked row and is painted over by the
        // rows below it (matches the inventory dock's ContextMenu options).
        new foundry.applications.ux.ContextMenu(
            html, "[data-item-id]", [...baseEntries, ...extras], { jQuery: false, fixed: true }
        );
    };
    cls.prototype[CTX_PATCHED_KEY] = true;
}

/**
 * Walk every concrete actor-sheet class registered with Foundry and invoke
 * `callback(cls)` on each one that owns its own `itemContextMenu` (i.e. the
 * Witcher actor sheets — the shim attaches there).  Used by both extras and
 * overrides; returns the set of patched classes so the caller can warn when
 * nothing matched.
 */
function _walkPatchableClasses(callback) {
    const patched = new Set();
    const buckets = CONFIG.Actor?.sheetClasses ?? {};
    for (const subtype of Object.keys(buckets)) {
        for (const entry of Object.values(buckets[subtype] ?? {})) {
            let cls = entry?.cls;
            while (cls && cls.prototype) {
                if (
                    Object.prototype.hasOwnProperty.call(cls.prototype, "itemContextMenu") &&
                    !patched.has(cls)
                ) {
                    try {
                        ensureContextMenuShim(cls);
                        callback(cls);
                        patched.add(cls);
                    } catch (err) {
                        console.error(`${MODULE_ID} | itemContextMenu patch failed on ${cls.name}`, err);
                    }
                }
                cls = Object.getPrototypeOf(cls);
                if (!cls || cls === Function.prototype) break;
            }
        }
    }
    return patched;
}

const _pushedBuilders = new Set();

/**
 * Register an entry builder on every actor sheet's itemContextMenu, using
 * the shared shim convention so multiple callers stack instead of clobber.
 * Idempotent per builder: the same function reference will only ever be
 * pushed once.
 *
 * The builder is invoked with `this` bound to the sheet at menu-render
 * time, and may return either a single entry or an array of entries.
 */
export function installSheetContextMenuExtra(builder) {
    if (typeof builder !== "function") return;
    if (_pushedBuilders.has(builder)) return;
    _pushedBuilders.add(builder);
    const patched = _walkPatchableClasses((cls) => {
        cls.prototype[CTX_EXTRAS_KEY].push(builder);
    });
    if (!patched.size) {
        console.warn(`${MODULE_ID} | no actor sheets patched — context-menu extra unavailable on actor sheets.`);
    }
}

/**
 * Install a wrapper that replaces (or transforms) one of the system's base
 * context-menu entries on every actor sheet.  `methodName` must be one of
 * SYSTEM_ENTRY_METHODS — keying by method instead of localized entry name
 * keeps overrides stable across language packs.  `wrapper(entry)` is invoked
 * with the sheet bound as `this` and the original entry as the only arg,
 * and should return the replacement entry (or undefined to keep the original).
 *
 * Wrappers stack: if two callers install for the same method, the second's
 * `entry` arg is whatever the first one returned.  Idempotent per wrapper —
 * registering the same function twice is a no-op.
 */
export function installSheetContextMenuOverride(methodName, wrapper) {
    if (!SYSTEM_ENTRY_METHODS.includes(methodName)) {
        console.warn(`${MODULE_ID} | installSheetContextMenuOverride: unknown method "${methodName}"`);
        return;
    }
    if (typeof wrapper !== "function") return;
    const patched = _walkPatchableClasses((cls) => {
        const map = cls.prototype[CTX_OVERRIDES_KEY];
        const arr = map.get(methodName) ?? [];
        if (!arr.includes(wrapper)) arr.push(wrapper);
        map.set(methodName, arr);
    });
    if (!patched.size) {
        console.warn(`${MODULE_ID} | no actor sheets patched — context-menu override for "${methodName}" unavailable.`);
    }
}


/* ============================================================
   3. Actor-sheet render hooks — charge badge + configure button
      (mirrors witcher-food-and-drink/charges.mjs injectBadgesAndButtons)
   ============================================================ */

function injectRemainsUI(sheet, html) {
    const root = html instanceof HTMLElement ? html : (html?.[0] ?? html);
    if (!root?.querySelectorAll) return;
    const actor = sheet.actor;
    if (!actor) return;

    root.querySelectorAll("[data-item-id]").forEach(row => {
        if (row.querySelector(".wou-remains-badge")) return;
        const item = actor.items.get(row.dataset.itemId);
        if (!isRemains(item)) return;

        const charges = getCharges(item);
        const anchor  = row.querySelector(".item-name, .name, [data-action='editItem'], a, span") || row;

        const badge = document.createElement("span");
        badge.className = "wou-remains-badge";
        badge.textContent = `${charges}/${CHARGES_MAX}`;
        badge.dataset.tooltip = `${charges}/${CHARGES_MAX} charges remaining`;
        anchor.appendChild(badge);

        if (game.user.isGM) {
            const btn = document.createElement("a");
            btn.className = "wou-remains-cfg-btn";
            btn.dataset.tooltip = "Configure Charges (GM)";
            btn.innerHTML = ICON_CFG;
            btn.addEventListener("click", ev => {
                ev.preventDefault();
                ev.stopPropagation();
                openChargeConfig(item);
            });
            anchor.appendChild(btn);
        }
    });
}

async function openChargeConfig(item) {
    const current    = getCharges(item);
    const baseWeight = item.flags?.[MODULE_ID]?.[BASE_WEIGHT_FLAG]
                    ?? Number(item.system?.weight ?? 0);

    const DialogV2 = foundry.applications.api.DialogV2;

    await DialogV2.wait({
        window: { title: `Configure Charges — ${item.name}` },
        content: `
            <form>
                <div class="form-group">
                    <label>Current charges</label>
                    <input type="number" name="charges"
                           value="${current}" min="0" max="${CHARGES_MAX}" step="1">
                    <p class="hint">0–${CHARGES_MAX}. Weight scales proportionally.</p>
                </div>
                <div class="form-group">
                    <label>Base weight (at ${CHARGES_MAX}/${CHARGES_MAX})</label>
                    <input type="number" name="baseWeight"
                           value="${baseWeight}" min="0" step="0.01">
                </div>
            </form>
        `,
        position: { width: 320 },
        buttons: [
            {
                action: "save",
                label: "Save",
                default: true,
                callback: async (_ev, button) => {
                    const f   = button.form.elements;
                    const val = Math.max(0, Math.min(CHARGES_MAX, Number(f.charges.value)));
                    const bw  = Math.max(0, Number(f.baseWeight.value));
                    const nw  = parseFloat((bw * val / CHARGES_MAX).toFixed(2));
                    await item.update({
                        "system.weight":                            nw,
                        [`flags.${MODULE_ID}.${CHARGES_FLAG}`]:     val,
                        [`flags.${MODULE_ID}.${BASE_WEIGHT_FLAG}`]: bw,
                    });
                }
            },
            { action: "cancel", label: "Cancel" }
        ],
        rejectClose: false,
    });
}

/* ============================================================
   4. Cog button on the Valuable item sheet (GM only)
      Mirrors witcher-food-and-drink/consumable-dialog.mjs registerCogHook
   ============================================================ */

function injectRemainsSheetCog(sheet, html) {
    if (!game.user.isGM) return;
    if (sheet.document?.type !== "valuable") return;
    if (sheet.document?.system?.type !== "remains") return;

    const root = html instanceof HTMLElement ? html : (html?.[0] ?? html);
    if (!root?.querySelector) return;

    const headerEl = root.querySelector("header.item-header");
    if (!headerEl) return;
    if (headerEl.querySelector(":scope > .wou-remains-sheet-cfg")) return;

    if (!headerEl.style.position) headerEl.style.position = "relative";

    const btn = document.createElement("a");
    btn.className = "wou-remains-sheet-cfg wfd-config-btn";
    btn.dataset.tooltip = "Configure Charges (GM)";
    btn.innerHTML = ICON_CFG;
    btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        await openChargeConfig(sheet.document);
    });
    headerEl.appendChild(btn);
}

/* ============================================================
   Public entry point — called from main.js registerItemContextMenu
   ============================================================ */

function injectSidebarBadges(html) {
    const root = html instanceof HTMLElement ? html : (html?.[0] ?? html);
    if (!root?.querySelectorAll) return;
    root.querySelectorAll("li[data-entry-id]").forEach(li => {
        if (li.querySelector(".wou-remains-badge")) return;
        const item = game.items?.get(li.dataset.entryId);
        if (!isRemains(item)) return;
        const charges = getCharges(item);
        const badge = document.createElement("span");
        badge.className = "wou-remains-badge";
        badge.textContent = `${charges}/${CHARGES_MAX}`;
        badge.dataset.tooltip = `${charges}/${CHARGES_MAX} charges remaining`;
        const nameEl = li.querySelector(".entry-name") ?? li;
        nameEl.appendChild(badge);
    });
}

/* ============================================================
   The system's character sheet filters valuables into named
   subsections (general, foodAndDrinks, toolkits, …) but doesn't
   include `system.type === "remains"` in any of them, so a
   carcass dropped on a character is invisible in the inventory
   tab. Patch _prepareValuables on first render to append remains
   to the General list so they surface under Valuables.
   ============================================================ */

let _valuablesPatched = false;
function patchPrepareValuables(app) {
    if (_valuablesPatched) return;
    let proto = Object.getPrototypeOf(app);
    while (proto && !Object.prototype.hasOwnProperty.call(proto, "_prepareValuables")) {
        proto = Object.getPrototypeOf(proto);
        if (!proto || proto === Object.prototype) { proto = null; break; }
    }
    if (!proto) return;   // method moved/renamed — bail without retry every render
    _valuablesPatched = true;

    const original = proto._prepareValuables;
    proto._prepareValuables = function (context) {
        original.call(this, context);
        const extras = (context.valuables ?? []).filter(
            i => i.system?.type === "remains" || i.system?.type === "book"
        );
        if (extras.length) {
            context.general = [...(context.general ?? []), ...extras];
        }
    };

    // Force the current sheet to re-render so the patched method runs.
    app.render(false);
}

export function registerItemContextMenu() {
    registerCarcassAndBookActions();
    registerWeaponDrawAction();
    registerWeaponReloadActions();

    // Sidebar hook — world items have no owning actor, so the registry's
    // actions act against the user's assigned character. The food-and-drink
    // pour entries stay manual: they bridge to a peer module's charge API.
    Hooks.on("getItemContextOptions", (_app, entries) => {
        entries.push(
            ...buildItemActionEntries(resolveSidebarItem, () => game.user?.character ?? null, "sidebar"),
            sidebarPourEntry("Pour Glass", '<i class="fa-solid fa-wine-glass"></i>', 'drink'),
            sidebarPourEntry("Serve Piece", '<i class="fa-solid fa-utensils"></i>', 'food')
        );
    });

    // Charge badges in the Foundry Items sidebar
    Hooks.on("renderItemDirectory", (_app, html) => injectSidebarBadges(html));

    // Cog on the valuable item sheet
    Hooks.on("renderWitcherValuableSheet", injectRemainsSheetCog);

    // Actor-sheet patches need CONFIG.Actor.sheetClasses to be populated
    Hooks.once("ready", () => {
        installSheetContextMenuExtra(sheetItemActionsBuilder);

        Hooks.on("renderWitcherCharacterSheet", (app, html) => {
            patchPrepareValuables(app);
            injectRemainsUI(app, html);
        });
        Hooks.on("renderWitcherLootSheet",      injectRemainsUI);
        Hooks.on("renderWitcherMonsterSheet",   injectRemainsUI);
    });
}
