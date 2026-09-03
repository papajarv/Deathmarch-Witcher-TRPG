/**
 * Item context-menu — adds "[1 charge] Harvest Materials",
 * "[1 charge] Extract Mutagen", and "[1 charge] Dissect" entries on
 * remains items (first-class `remains` item type).
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
import { doDissect, anyAutopsyEnabled } from "./dissect.js";
import { doHarvest, openCarcassPopup } from "./harvest.js";
import { encKey, bestiaryKeyFor, bumpResearchIfZero, promptCarcassModifier, resolveCarcassMonster, resolveCarcassMonsterSync } from "../lib/bestiary.js";
import { reloadWithPrompt, feedMagazineWithPrompt } from "../lib/reload.js";
import { itemInQuickDrawSlot } from "../lib/container.js";
import { hasVisorQuality, isVisorRaised } from "../../mechanics/helmetVision.mjs";

import { t, tFormat } from "../lib/i18n.js";
function escapeText(s) {
  return String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
}

const ICON_HARVEST = '<i class="fa-solid fa-scissors"></i>';
const ICON_EXTRACT = '<i class="fa-solid fa-flask-vial"></i>';
const ICON_DISSECT = '<i class="fa-solid fa-stethoscope"></i>';
const ICON_READ    = '<i class="fa-solid fa-book-open"></i>';
const ICON_REVIEW  = '<i class="fa-solid fa-list-ol"></i>';
const ICON_FLIP    = '<i class="fa-solid fa-book-open-reader"></i>';
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
    return item?.type === "remains";
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
        && !hasExtractedMutagen(item)
        && monsterHasMutagen(item);
}

/** Does the carcass's source monster carry a linked mutagen? Extraction is
 *  pointless otherwise, so we hide the action. Prefers the LIVE instance (the
 *  token actor this carcass came from — it may have gained/lost a mutagen link
 *  after leaving the bestiary); falls back to the `mutagenLinked` flag stamped
 *  at spawn when the instance can't be resolved synchronously (e.g. a theater
 *  carcass pointing at an unindexed compendium); and, if it genuinely can't
 *  tell, leaves the action shown — doExtractMutagen handles the empty case. */
function monsterHasMutagen(item) {
    const monster = resolveCarcassMonsterSync(item);
    if (monster?.system) return !!monster.system?.mutagen?.uuid;
    const flags = item?.flags?.[MODULE_ID] ?? {};
    if (typeof flags.mutagenLinked === "boolean") return flags.mutagenLinked;
    return true;
}

export async function runCarcassAction(action, item, actor = null) {
    const cost = 1;

    const flags      = item.flags?.[MODULE_ID] ?? {};
    const current    = flags[CHARGES_FLAG]     ?? CHARGES_MAX;
    const baseWeight = flags[BASE_WEIGHT_FLAG] ?? Number(item.system?.weight ?? 0);

    /* People carcasses don't use the 3-charge model. Loot is a one-and-
     * done pocket-frisk (marked complete via HARVESTED_FLAG so the row
     * won't re-appear); Take Trophy is already gated by its own
     * trophyTaken flag. Neither decrements charges or shrinks the
     * carcass weight. Bail out of the charge/weight bookkeeping below. */
    const peopleCarcass = !!item.flags?.[MODULE_ID]?.isPeople;

    if (!peopleCarcass && current < cost) {
        const label = action === "harvest" ? t("WITCHER.Chrome.ContextMenuItem.Text.ChargeHarvestMaterials", "[1 charge] Harvest Materials")
                    : action === "extract" ? t("WITCHER.Chrome.ContextMenuItem.Text.ChargeExtractMutagen",   "[1 charge] Extract Mutagen")
                    :                        t("WITCHER.Chrome.ContextMenuItem.Text.ChargeDissect",         "[1 charge] Dissect");
        ui.notifications?.warn(tFormat(
          "WITCHER.Chrome.ContextMenuItem.Notify.NotEnoughCharges",
          { label, item: item.name, current, cost },
          "{label}: not enough charges on \"{item}\" — {current} remaining, need {cost}."
        ));
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
    } else if (action === "loot") {
        /* People carcasses (isPeople=true on the source monster, flag stamped
         * on the remains) skip the Wilderness Survival check — you're
         * pocketing gear, not identifying alchemy substrates. */
        const ok = await doHarvest(item, actor, { skipCheck: true });
        if (ok === false) return;
    } else if (action === "dissect") {
        const ok = await doDissect(item, actor);
        if (ok === false) return;
    }

    /* People carcasses: no charge decrement, no weight shrink, no
     * destroy-on-spent. doHarvest already stamped HARVESTED_FLAG so
     * the Loot action's `condition` will refuse a second click. */
    if (peopleCarcass) return;

    const remaining = current - cost;
    // Each spent charge cuts the carcass to a third of its previous weight
    // (base → base/3 → base/9 → base/27 across the three charges).
    const spent     = CHARGES_MAX - remaining;
    const newWeight = parseFloat((baseWeight * Math.pow(1 / 3, spent)).toFixed(2));

    /* GM-proxied: on the map the remains is embedded on the (GM-owned) monster
     * token actor, so a player can't write it directly. The GM shrinks/
     * decrements the body and, on the last charge, deletes it UNLESS it still
     * holds uncollected harvested loot (kept so the popup can retrieve it). */
    const { emitRemainsSpendCharge } = await import("../../setup/socketHook.mjs");
    await emitRemainsSpendCharge({ remainsUuid: item.uuid, remaining, newWeight, baseWeight });

    if (remaining === 0) {
        // Keep-vs-destroy is decided GM-side from authoritative state; here we
        // just report the body is used up. Any harvested loot still to collect
        // is already shown in the auto-opened carcass popup.
        ui.notifications?.info(tFormat("WITCHER.Notify.Item.ConsumedSpent", { item: item.name }, "{item} — fully consumed."));
        return;
    }

    const label = action === "harvest" ? t("WITCHER.Chrome.ContextMenuItem.Text.HarvestMaterials", "Harvest Materials")
                : action === "extract" ? t("WITCHER.Chrome.ContextMenuItem.Text.ExtractMutagen",   "Extract Mutagen")
                :                        t("WITCHER.Chrome.ContextMenuItem.Text.Dissect",          "Dissect");
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
        ui.notifications?.warn(t("WITCHER.Notify.Mutagen.NotSidebar", "Extract Mutagen must be triggered from a character sheet, not the sidebar."));
        return false;
    }

    if (typeof actor.findProfessionSlot !== "function") {
        ui.notifications?.error(t("WITCHER.Notify.Mutagen.HelperMissing", `System's profession-skill helper missing — cannot extract.`));
        return false;
    }
    const slot = actor.findProfessionSlot(EXTRACT_SKILL_NAME);
    if (!slot) {
        ui.notifications?.error(tFormat("WITCHER.Notify.Mutagen.NoSkill", { actor: actor.name, skill: EXTRACT_SKILL_NAME }, "{actor} doesn't know how to extract mutagens (no \"{skill}\" profession skill)."));
        return false;
    }

    // The SPECIFIC instance this carcass came from (its parent token actor,
    // including any mutagen linked after it left the bestiary) — not the
    // compendium source.
    const monster = await resolveCarcassMonster(item);
    if (!monster) {
        ui.notifications?.error(t("WITCHER.Notify.Remains.MonsterMissing", `The source monster could not be found (deleted or compendium not loaded).`));
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
        ui.notifications?.error(tFormat("WITCHER.Notify.Mutagen.LinkMissing", { monster: monster.name }, "{monster}'s linked mutagen could not be found (deleted or unloaded)."));
        return false;
    }

    if (typeof actor.rollProfessionSkill !== "function") {
        ui.notifications?.error(t("WITCHER.Notify.Mutagen.RollHelperMissing", `System's profession-skill roll helper missing — cannot extract.`));
        return false;
    }

    /* Optional situational modifier on the extraction check. Cancel aborts
     * BEFORE the roll (return false → the caller skips the charge decrement). */
    const extractMod = await promptCarcassModifier(t("WITCHER.Chrome.ContextMenuItem.Text.ExtractMutagen", "Extract Mutagen"));
    if (extractMod === null) return false;

    const roll = await actor.rollProfessionSkill(slot, { dc: EXTRACT_DC, situational: extractMod });
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
        // One-shot on the carcass (GM-proxied — see emitRemainsMutate).
        const { emitRemainsMutate } = await import("../../setup/socketHook.mjs");
        await emitRemainsMutate({ remainsUuid: item.uuid, update: { [`flags.${MODULE_ID}.${EXTRACTED_FLAG}`]: true } });
        // Reveal the mutagen on this PC's bestiary entry for the monster
        // so the bestiary panel renders its name + description from now on.
        await revealMutagenInBestiary(actor, monster, mutagen);
        ui.notifications?.info(tFormat("WITCHER.Notify.Mutagen.Extracted", { actor: actor.name, mutagen: mutagen.name, item: item.name }, "{actor} extracted {mutagen} from {item}."));
    } else {
        ui.notifications?.info(tFormat("WITCHER.Notify.Mutagen.ExtractFailed", { actor: actor.name, total: total, dc: EXTRACT_DC }, "{actor} failed the extraction (rolled {total} vs DC {dc})."));
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
            quantity:    1,
            description: "",
            isStored:    false,
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
    // One-shot on the carcass (GM-proxied — the remains may be embedded on a
    // GM-owned monster token the looting player can't write directly).
    const { emitRemainsMutate } = await import("../../setup/socketHook.mjs");
    await emitRemainsMutate({ remainsUuid: item.uuid, update: { [`flags.${MODULE_ID}.trophyTaken`]: true } });
    ui.notifications?.info(tFormat("WITCHER.Notify.Trophy.Taken", { name: monsterName }, "Trophy taken: \"{name} Trophy\"."));
}

/* True when the carcass's source monster is a person (bandit, cultist,
 * etc.) — flag is stamped by monster-remains.js at carcass creation
 * from monster.system.isPeople. People carcasses swap the alchemy /
 * bestiary action set (Harvest / Extract Mutagen / Dissect) for a
 * lighter Loot action (harvest without the Survival check). Take Trophy
 * stays available on both. */
function isPeopleRemains(item) {
    return !!item?.flags?.[MODULE_ID]?.isPeople;
}

/* The carcass (Harvest/Extract/Dissect/Loot/Open) and book (Study/Read/Review)
 * actions, registered once for all surfaces. */
function registerCarcassAndBookActions() {
    const remainsAction = (label, icon, action, cost) => ({
        name: label, icon,
        condition: (item) => {
            if (!isRemains(item) || getCharges(item) < cost) return false;
            /* Non-loot alchemy/bestiary actions don't apply to people. */
            if (action !== "loot" && isPeopleRemains(item)) return false;
            /* Dissect vanishes entirely when the GM has disabled every autopsy
             * category in Bestiary Settings. */
            if (action === "dissect" && !anyAutopsyEnabled()) return false;
            /* Loot only appears on people carcasses — for monster carcasses
             * the Harvest Materials action serves the same purpose (with a
             * Survival check gate). */
            if (action === "loot" && !isPeopleRemains(item)) return false;
            if (action === "extract" && hasExtractedMutagen(item))   return false;
            /* No mutagen on the source monster → hide Extract Mutagen entirely. */
            if (action === "extract" && !monsterHasMutagen(item))    return false;
            if (action === "harvest" && hasHarvestedMaterials(item)) return false;
            if (action === "loot"    && hasHarvestedMaterials(item)) return false;
            return true;
        },
        callback: (item, actor) => runCarcassAction(action, item, actor)
    });
    registerItemAction(remainsAction("[1 charge] Harvest Materials", ICON_HARVEST, "harvest", 1));
    registerItemAction(remainsAction("[1 charge] Extract Mutagen",   ICON_EXTRACT, "extract", 1));
    registerItemAction(remainsAction("[1 charge] Dissect",           ICON_DISSECT, "dissect", 1));
    /* Loot label has no "[1 charge]" prefix — people carcasses don't
     * use the charge model. runCarcassAction's peopleCarcass branch
     * skips the charge/weight bookkeeping entirely. */
    registerItemAction(remainsAction("Loot",                         ICON_HARVEST, "loot",    0));
    registerItemAction({
        name: t("WITCHER.Chrome.ContextMenuItem.Text.OpenCarcass", "Open Carcass"),
        icon: '<i class="fa-solid fa-box-open"></i>',
        condition: (item) => {
            if (!isRemains(item)) return false;
            const contents = item.flags?.[MODULE_ID]?.harvest?.contents;
            return Array.isArray(contents) && contents.length > 0;
        },
        callback: (item) => openCarcassPopup(item)
    });
    registerItemAction({
        name: t("WITCHER.Chrome.ContextMenuItem.Text.TakeTrophy", "Take Trophy"),
        icon: '<i class="fa-solid fa-trophy"></i>',
        condition: (item) => isRemains(item) && !item.flags?.[MODULE_ID]?.trophyTaken,
        callback: (item, actor) => takeTrophy(item, actor)
    });
    registerItemAction({
        name: t("WITCHER.Chrome.ContextMenuItem.Text.Study", "Study"), icon: '<i class="fa-solid fa-magnifying-glass"></i>',
        condition: (item) => isStudyBook(item),
        callback: (item) => interactWithBook(item)
    });
    registerItemAction({
        name: t("WITCHER.Chrome.ContextMenuItem.Text.Read", "Read"), icon: ICON_READ,
        condition: (item) => isReadableBook(item),
        callback: (item) => interactWithBook(item)
    });
    registerItemAction({
        name: t("WITCHER.Chrome.ContextMenuItem.Text.ReviewChapters", "Review Chapters"), icon: ICON_REVIEW,
        condition: (item, actor) => !!(item && actor && canReviewBook(item, actor)),
        callback: (item) => reviewStressBookChapters(item)
    });
    /* Flip Through — post the novel's `flipThroughDescription` to chat
     * so a reader can peek at what the book is about without spending
     * the full in-world reading time. Only offered for readable (stress /
     * novel / lore) books whose author populated the field. */
    registerItemAction({
        name: t("WITCHER.Chrome.ContextMenuItem.Text.FlipThrough", "Flip Through"), icon: ICON_FLIP,
        condition: (item) => isReadableBook(item)
            && !!String(item?.system?.flipThroughDescription ?? "").trim(),
        callback: (item, actor) => flipThroughBook(item, actor)
    });
}

/* Post a "flip through" summary card for a novel/lore book. Shows the
 * book's icon + title and the author-authored short summary — deliberately
 * minimal (no rolls, no state change) since flipping through is meant to
 * be a zero-cost peek at the contents. Speaker prefers the acting actor
 * so party chat sees "Geralt flips through <book>"; falls back to the
 * current user when no owner is on hand. */
async function flipThroughBook(item, actor = null) {
    if (!item) return;
    const summary = String(item.system?.flipThroughDescription ?? "").trim();
    if (!summary) {
        ui.notifications?.warn(t("WITCHER.Notify.Book.NoFlipThrough",
            "This book has no flip-through description."));
        return;
    }
    /* Enrich for inline @UUID + rolls, same treatment as book descriptions
     * elsewhere. Fall back to the raw text if the enricher isn't loaded. */
    let body = summary;
    try {
        const TE = foundry?.applications?.ux?.TextEditor?.implementation
                ?? foundry?.applications?.ux?.TextEditor
                ?? globalThis?.TextEditor;
        if (TE?.enrichHTML) body = await TE.enrichHTML(summary, { async: true });
    } catch (_) { /* enrichment is a nicety */ }
    const speaker = actor
        ? ChatMessage.getSpeaker({ actor })
        : ChatMessage.getSpeaker();
    const title = t("WITCHER.Chrome.ContextMenuItem.Chat.FlipThroughTitle", "Flipping through");
    const content =
        `<div class="wdm-flip-through-card" style="display:flex;gap:0.5rem;align-items:flex-start;padding:0.15rem 0;">
            <img src="${item.img}" alt="" style="width:2.25rem;height:2.25rem;flex:0 0 auto;border:1px solid #6e5224;background:#0a0907;object-fit:contain;" />
            <div style="flex:1 1 auto;font-size:0.8125rem;line-height:1.4;">
                <div style="font-family:var(--wdm-font-display,inherit);font-size:0.7rem;letter-spacing:0.14em;text-transform:uppercase;color:#c8a878;">${title}</div>
                <div style="font-family:var(--wdm-font-display,inherit);font-size:0.95rem;color:#e5d6b6;margin-bottom:0.35rem;">${item.name}</div>
                <div class="wdm-flip-through-body">${body}</div>
            </div>
        </div>`;
    try {
        await ChatMessage.create({ speaker, content, flags: { [MODULE_ID]: { category: "lore" } } });
    } catch (err) {
        console.error(`${MODULE_ID} | flipThroughBook chat post failed`, err);
    }
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

/* Snap-draw (quick-draw) is only allowed out of a SLOT whose "Quick-Draw"
 * toggle is ticked. Same equipped-container access rule as a
 * normal draw, plus the per-slot capability gate. A weapon in a plain slot
 * still draws normally (costs an action), it just can't snap-draw. */
export function isItemInQuickDrawContainer(actor, item) {
    if (!actor || !item) return false;
    for (const c of actor.items) {
        if (c.type !== "container" || c.system?.equipped !== true) continue;
        const content = c.system?.content ?? [];
        if (!(content.includes(item.uuid) || content.includes(item.id))) continue;
        if (itemInQuickDrawSlot(c, item)) return true;
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
    // Must be stowed in an equipped container whose slot has Quick-Draw ticked.
    // A loose weapon, one in a stowed pack, or one in a plain equipped slot
    // can't be snap-drawn — only normal-drawn.
    if (!isItemInQuickDrawContainer(actor, item)) {
        ui?.notifications?.warn?.("Can't fast draw — the weapon must be in an equipped container's Quick-Draw slot.");
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
        condition: (item, actor) => item?.type === "weapon" && !item.system?.equipped && canFastDraw(actor) && isItemInQuickDrawContainer(actor, item),
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
        /* Magazine model (CE): the Reload entry = COCK. Show it while the weapon
         * is un-cocked and there's something to cock — fed rounds already in the
         * magazine, or feedable ammo to auto-load. Room-in-chamber does NOT gate
         * cocking: a FULL magazine still needs cocking. */
        if (item.usesMagazine) {
            return !item.isArmed && (cnt > 0 || (item.getEligibleAmmo?.().length ?? 0) > 0);
        }
        return cnt < cap && (item.getEligibleAmmo?.().length ?? 0) > 0;
    };
    /* ＋ Load Magazine — magazine crossbows only: feed one bolt into the
     * reservoir (separate from cocking). Needs room + feedable ammo. */
    const magazineFeedable = (item) => {
        if (!item?.usesMagazine) return false;
        const cnt = Number(item.system?.loaded?.count) || 0;
        const cap = Math.max(1, Number(item.system?.loaded?.capacity) || 1);
        return cnt < cap && (item.getEligibleAmmo?.().length ?? 0) > 0;
    };
    registerItemAction({
        name: t("WITCHER.Chrome.ContextMenuItem.Text.Reload", "Reload"),
        icon: '<i class="fa-solid fa-arrows-rotate"></i>',
        condition: (item) => chamberLoadable(item),
        callback: (item) => reloadWithPrompt(item),
        surfaces: { sidebar: false }
    });
    registerItemAction({
        name: t("WITCHER.Chrome.ContextMenuItem.Text.LoadMagazine", "Load Magazine"),
        icon: '<i class="fa-solid fa-plus"></i>',
        condition: (item) => magazineFeedable(item),
        callback: (item) => feedMagazineWithPrompt(item),
        surfaces: { sidebar: false }
    });
    registerItemAction({
        name: t("WITCHER.Chrome.ContextMenuItem.Text.Unload", "Unload"),
        icon: '<i class="fa-solid fa-arrow-up-from-bracket"></i>',
        /* Unload whenever the chamber/magazine holds rounds — an un-cocked but
         * fed magazine has rounds to return even though isLoaded (armed) is
         * false, so gate on the actual round count, not readiness. */
        condition: (item) => !!item?.usesAmmo && item.hasChamber && ((item.getChamberRounds?.()?.length ?? 0) > 0),
        callback: (item) => item.unload(),
        surfaces: { sidebar: false }
    });
}

/* Food / drink portion-pouring. Uses our own food-and-drink mechanic
 * (mechanics/foodAndDrink.mjs). Splits a charged source (Bottle of X /
 * Plate of X) into a NON-charged single-portion item ("Glass of X" /
 * "Portion of X") on the same actor and decrements the source by one
 * charge. The portion's label prefix + optional icon override are
 * authored on the source's item-sheet config view (system.pourLabel /
 * system.pourIconCustom / system.pourIcon) — there's no separate
 * "configure" context entry. */
const DEFAULT_POUR_FALLBACKS = { drink: "Glass", meal: "Portion", ingredient: "Portion" };
const DEFAULT_POUR_LABEL = new Proxy(DEFAULT_POUR_FALLBACKS, {
    get(target, prop) {
        if (!(prop in target)) return undefined;
        return t(`WITCHER.Chrome.ContextMenuItem.Pour.${String(prop)}`, target[prop]);
    }
});

/** Strip the source's container prefix so "Glass of X" reads cleanly
 *  instead of "Glass of Bottle of X". */
function strippedSourceName(name) {
    return String(name ?? "").replace(/^(?:Bottle|Flask|Cask|Jug|Plate|Bowl|Tray|Pot)\s+of\s+/i, "");
}

/** True when this item is a `food`-type charged source with 2+ portions
 *  left (1 = consume only, no pour). `expectedKind` is "drink" for the
 *  Pour-a-Glass action; anything else (meal / ingredient) routes through
 *  the Serve-a-Portion action. */
function canPourFrom(item, expectedKind) {
    if (!item || item.type !== "food") return false;
    const charges = item.system?.charges;
    if (!Number.isFinite(charges?.max) || charges.max <= 0) return false;
    if (Number(charges.current ?? 0) < 2) return false;
    const kind = item.system?.kind ?? "meal";
    if (expectedKind === "drink") return kind === "drink";
    return kind !== "drink";
}

/** Split one portion off `item` into a fresh NON-CHARGED single-portion
 *  item on the same actor. Source decrements via consumeOneCharge so
 *  stack-of-N-bottles split semantics behave like the rest of the
 *  consume flow. */
async function pourPortion(item, actor) {
    if (item?.type !== "food") return;
    const charges = item.system?.charges;
    if (!Number.isFinite(charges?.max) || charges.max <= 0) {
        ui.notifications?.warn(tFormat("WITCHER.Notify.Item.NoCharges", { item: item.name }, "{item} has no charges configured."));
        return;
    }
    if (Number(charges.current ?? 0) < 2) {
        ui.notifications?.warn(tFormat("WITCHER.Notify.Item.PourTooLow", { item: item.name }, "{item} doesn't have enough left to pour a portion (needs 2+ charges)."));
        return;
    }
    const kind   = item.system?.kind ?? "meal";
    const labelOverride = String(item.system?.pourLabel ?? "").trim();
    const prefix  = labelOverride || (DEFAULT_POUR_LABEL[kind] ?? t("WITCHER.Chrome.ContextMenuItem.Pour.Portion", "Portion"));
    const newName = tFormat("WITCHER.Chrome.ContextMenuItem.Pour.OfPattern", { prefix, source: strippedSourceName(item.name) }, `${prefix} of ${strippedSourceName(item.name)}`);

    /* Build the portion: clone source, drop charges entirely (portion is
     * a dumb single-serving item, not a charged source — consuming it
     * follows the base quantity-decrement path). Set qty 1, scale weight
     * + cost down to one-portion shares, optionally swap the icon. */
    const data = item.toObject();
    delete data._id;
    data.name = newName;
    /* The icon override is the only place the GM-authored portion icon
     * makes a difference. When off, the portion inherits the source's
     * img. */
    if (item.system?.pourIconCustom && String(item.system?.pourIcon ?? "").trim()) {
        data.img = item.system.pourIcon;
    }
    /* Strip flags from peer modules (witcher-food-and-drink, alchemy
     * craft, etc.) that might cache charge state, anchor timestamps, or
     * other source-only metadata. The portion is a fresh single-serving
     * item; only OUR namespace's flags survive (and the pour-config
     * flags on those are blank-reset anyway via system fields below). */
    if (data.flags) {
        const ours = data.flags[MODULE_ID];
        data.flags = ours ? { [MODULE_ID]: ours } : {};
    }
    data.system = {
        ...(data.system ?? {}),
        quantity: 1,
        /* Reset charges to a "no ticker" state — the portion is an item
         * without portions, NOT a 1/1 source. Setting both to 0
         * disables the consume flow's charge path entirely, so eating /
         * drinking the portion routes through the base quantity drop
         * (qty 1 → 0 → item.delete). */
        charges: { current: 0, max: 0 },
        /* Reset freshness anchor — the portion is freshly poured "now",
         * not aged from when the bottle was acquired. Shelf life carries
         * over so the portion still spoils on its own schedule, but it
         * starts counting from this moment via stampFreshnessAnchor on
         * its first acquisition by an actor (already triggered by the
         * addItem below). */
        freshness: {
            shelfLifeDays: Number(item.system?.freshness?.shelfLifeDays) || 0,
            anchorTime:    null
        },
        /* The portion itself isn't a pourable source — clear the per-
         * item pour config so it doesn't accidentally surface as one. */
        pourLabel:      "",
        pourIconCustom: false,
        pourIcon:       "",
        /* The parent bottle is a valid brew base (Cheap Vodka → potion
         * base); the poured GLASS is not. Otherwise the crafting picker
         * lists both the bottle AND every glass poured from it. Reset the
         * block to its disabled default so `readBase` returns nothing for
         * portions regardless of what the source carried. */
        alchemyBase: { enabled: false, baseType: "", baseMod: 0 }
    };
    const max = Math.max(1, Number(charges.max) || 1);
    if (Number.isFinite(Number(item.system?.weight))) {
        data.system.weight = Number((Number(item.system.weight) / max).toFixed(4));
    }
    if (Number.isFinite(Number(item.system?.cost))) {
        data.system.cost = Math.round(Number(item.system.cost) / max);
    }

    /* Resolve the target container BEFORE creation so the portion is
       spawned pre-flagged with the correct isStored state. Sequence
       matters:
         - Post-hoc "create at top level, then move to container" flashed
           the portion through the actor's top-level inventory, where
           WitcherActor.addItem's stack-merge search runs — a matching
           sibling portion already inside the container was skipped by
           the search (isStored=true), but a NEW sibling at top level
           would merge, and even without a merge the post-creation find
           picked up the wrong doc when duplicates existed.
         - Setting isStored=true upfront + skipping addItem entirely
           means each pour is a deterministic new document, always landing
           inside the source's container in one shot. */
    let sourceContainerId = null;
    try {
        const { findContainerHoldingItem } = await import("./inventory.js");
        sourceContainerId = findContainerHoldingItem(actor, item.id);
    } catch (_) { /* fallthrough — top-level create */ }

    data.system = {
        ...(data.system ?? {}),
        isStored: !!sourceContainerId
    };

    let created = null;
    try {
        /* createEmbeddedDocuments directly, not addItem — addItem would
           merge into any existing top-level sibling and lose the fresh
           freshness anchor + per-pour identity. Portions never stack. */
        const [doc] = await actor.createEmbeddedDocuments("Item", [data]);
        created = doc ?? null;
    } catch (err) {
        console.warn(`${MODULE_ID} | pourPortion: add to actor failed`, err);
        return;
    }

    if (created && sourceContainerId) {
        try {
            const container = actor.items.get(sourceContainerId);
            if (container) {
                const content = container.system?.content ?? [];
                if (!content.includes(created.uuid)) {
                    await container.update({ "system.content": [...content, created.uuid] });
                }
            }
        } catch (err) {
            console.warn(`${MODULE_ID} | pourPortion: container assignment failed`, err);
        }
    }

    try {
        const { consumeOneCharge } = await import("../../mechanics/foodAndDrink.mjs");
        await consumeOneCharge(item);
    } catch (err) {
        console.warn(`${MODULE_ID} | pourPortion: source decrement failed`, err);
    }
}

/** Register the two pour-related actions. Authoring (pour label + icon
 *  override) happens on the food item's sheet config view; no separate
 *  context-menu configurator. */
function registerFoodDrinkPourActions() {
    registerItemAction({
        name: t("WITCHER.Chrome.ContextMenuItem.Text.PourAGlass", "Pour a Glass"),
        icon: '<i class="fa-solid fa-wine-glass"></i>',
        condition: (item, actor) => !!actor && canPourFrom(item, "drink"),
        callback:  (item, actor) => pourPortion(item, actor),
        surfaces:  { sidebar: false }
    });
    registerItemAction({
        name: t("WITCHER.Chrome.ContextMenuItem.Text.ServeAPortion", "Serve a Portion"),
        icon: '<i class="fa-solid fa-utensils"></i>',
        condition: (item, actor) => !!actor && canPourFrom(item, "meal"),
        callback:  (item, actor) => pourPortion(item, actor),
        surfaces:  { sidebar: false }
    });
}

/* Gift an item to another actor — opens a recipient picker, optionally
 * splits a stack, then routes the transfer through the GM proxy so a
 * player can gift to another player's PC without owning that PC. */
function registerGiftItemAction() {
    registerItemAction({
        name: t("WITCHER.Dialog.Item.Gift", "Gift Item"),
        icon: '<i class="fa-solid fa-gift"></i>',
        /* Requires an actor parent (sidebar templates have no owner — the
         * surfaces gate below also blocks that path). Containers are
         * giftable — handleGiftItem recursively transfers their contents
         * (including nested containers) and rewrites the container's
         * content array to point at the new UUIDs on the recipient. */
        condition: (item, actor) => !!actor,
        callback: (item, actor) => openGiftDialog(item, actor),
        surfaces: { sidebar: false }
    });
}

/** Dialog: pick the recipient actor + quantity, then emit the gift. */
async function openGiftDialog(item, sourceActor) {
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (!DialogV2 || !item || !sourceActor) return;

    /* Eligible recipients: every character actor the giver can normally
     * see, plus any actor (of any type) flagged as accepting gifts.
     * The "accepts gifts" flag (flags.<sysId>.acceptsGifts, GM-toggled
     * via the Actor Directory context menu) opens up the recipient list
     * for actors the player has no LIMITED/OBSERVER on — the socket
     * handler runs on the GM client with full perms, so no server-side
     * permission relaxation is needed. Skip the source. Sorted by name. */
    const acceptsGifts = (a) =>
        !!a?.getFlag?.("witcher-ttrpg-death-march", "acceptsGifts");
    const recipients = (game.actors?.contents ?? [])
        .filter(a => a && a !== sourceActor)
        .filter(a => (a.type === "character" && a.visible !== false) || acceptsGifts(a))
        .sort((a, b) => a.name.localeCompare(b.name));
    if (!recipients.length) {
        ui.notifications?.warn(t("WITCHER.Notify.Item.NoRecipients", "No eligible recipients found."));
        return;
    }

    const stackQty = Math.max(1, Number(item.system?.quantity) || 1);
    const recipientOpts = recipients
        .map(a => `<option value="${a.uuid}">${escapeText(a.name)}</option>`)
        .join("");

    const content = `
        <div class="wdm-gift-dialog" style="display:flex;flex-direction:column;gap:10px;padding:6px 2px;">
            <div style="font-size:0.75rem;opacity:0.85;">${tFormat("WITCHER.Chrome.ContextMenuItem.Text.GiveItemFromTo", { item: escapeText(item.name), source: escapeText(sourceActor.name) }, `Give <strong>${escapeText(item.name)}</strong> from <em>${escapeText(sourceActor.name)}</em> to:`)}</div>
            <label style="display:flex;flex-direction:column;gap:4px;font-size:0.75rem;">
                <span>${t("WITCHER.Chrome.ContextMenuItem.Text.Recipient", "Recipient")}</span>
                <select name="recipient" autofocus>${recipientOpts}</select>
            </label>
            ${stackQty > 1 ? `
            <label style="display:flex;flex-direction:column;gap:4px;font-size:0.75rem;">
                <span>${tFormat("WITCHER.Chrome.ContextMenuItem.Text.QuantityRange", { max: stackQty }, `Quantity (1–${stackQty})`)}</span>
                <input type="number" name="qty" value="${stackQty}" min="1" max="${stackQty}" step="1" />
            </label>` : `<input type="hidden" name="qty" value="1" />`}
        </div>`;

    let choice;
    try {
        choice = await DialogV2.prompt({
            window: { title: t("WITCHER.Dialog.Item.Gift", "Gift Item"), icon: "fa-solid fa-gift" },
            content,
            rejectClose: false,
            ok: {
                label: t("WITCHER.Chrome.ContextMenuItem.Dialog.Button.Give", "Give"),
                icon: "fa-solid fa-gift",
                callback: (_event, button) => ({
                    recipientUuid: button.form?.elements?.recipient?.value ?? "",
                    qty: Math.max(1, Math.min(stackQty, Number(button.form?.elements?.qty?.value) || 1))
                })
            }
        });
    } catch (_) { return; }
    if (!choice?.recipientUuid) return;

    const { emitGiftItem } = await import("../../setup/socketHook.mjs");
    await emitGiftItem({
        sourceActorUuid: sourceActor.uuid,
        targetActorUuid: choice.recipientUuid,
        itemId:          item.id,
        quantity:        choice.qty,
        fromUserId:      game.user?.id ?? null
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
        /* People carcasses don't use the charge model. Skip both the
         * badge and the GM charge-config button. Loot is one-shot;
         * Take Trophy is gated by its own flag. */
        if (isPeopleRemains(item)) return;

        const charges = getCharges(item);
        const anchor  = row.querySelector(".item-name, .name, [data-action='editItem'], a, span") || row;

        const badge = document.createElement("span");
        badge.className = "wou-remains-badge";
        badge.textContent = `${charges}/${CHARGES_MAX}`;
        badge.dataset.tooltip = tFormat("WITCHER.Chrome.ContextMenuItem.Tip.ChargesRemaining", { charges, max: CHARGES_MAX }, `${charges}/${CHARGES_MAX} charges remaining`);
        anchor.appendChild(badge);

        if (game.user.isGM) {
            const btn = document.createElement("a");
            btn.className = "wou-remains-cfg-btn";
            btn.dataset.tooltip = t("WITCHER.Chrome.ContextMenuItem.Tip.ConfigureChargesGM", "Configure Charges (GM)");
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
        window: { title: tFormat("WITCHER.Dialog.Item.Charges", { item: item.name }, "Configure Charges — {item}") },
        content: `
            <form>
                <div class="form-group">
                    <label>${t("WITCHER.Chrome.ContextMenuItem.Label.CurrentCharges", "Current charges")}</label>
                    <input type="number" name="charges"
                           value="${current}" min="0" max="${CHARGES_MAX}" step="1">
                    <p class="hint">${tFormat("WITCHER.Chrome.ContextMenuItem.Hint.WeightScales", { max: CHARGES_MAX }, `0–${CHARGES_MAX}. Weight scales proportionally.`)}</p>
                </div>
                <div class="form-group">
                    <label>${tFormat("WITCHER.Chrome.ContextMenuItem.Label.BaseWeightAt", { max: CHARGES_MAX }, `Base weight (at ${CHARGES_MAX}/${CHARGES_MAX})`)}</label>
                    <input type="number" name="baseWeight"
                           value="${baseWeight}" min="0" step="0.01">
                </div>
            </form>
        `,
        position: { width: 320 },
        buttons: [
            {
                action: "save",
                label: t("WITCHER.Common.Save", "Save"),
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
            { action: "cancel", label: t("WITCHER.Common.Cancel", "Cancel") }
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
    if (sheet.document?.type !== "remains") return;

    const root = html instanceof HTMLElement ? html : (html?.[0] ?? html);
    if (!root?.querySelector) return;

    const headerEl = root.querySelector("header.item-header");
    if (!headerEl) return;
    if (headerEl.querySelector(":scope > .wou-remains-sheet-cfg")) return;

    if (!headerEl.style.position) headerEl.style.position = "relative";

    const btn = document.createElement("a");
    btn.className = "wou-remains-sheet-cfg wfd-config-btn";
    btn.dataset.tooltip = t("WITCHER.Chrome.ContextMenuItem.Tip.ConfigureChargesGM", "Configure Charges (GM)");
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
        badge.dataset.tooltip = tFormat("WITCHER.Chrome.ContextMenuItem.Tip.ChargesRemaining", { charges, max: CHARGES_MAX }, `${charges}/${CHARGES_MAX} charges remaining`);
        const nameEl = li.querySelector(".entry-name") ?? li;
        nameEl.appendChild(badge);
    });
}

/* ============================================================
   Legacy hook into an upstream character sheet that bucketed
   valuables into named subsections (general / foodAndDrinks /
   toolkits) and dropped books out of General. The Death March
   character sheet doesn't define `_prepareValuables`, so this
   patch silently bails on this codebase — kept only as a safety
   net if a future sheet variant reintroduces the method.

   Remains are no longer a valuable subtype, so the previous
   carcass-injection responsibility has moved entirely to the
   chrome inventory categorizer (`isPlainValuable` matches
   `item.type === "remains"` alongside plain valuables, so the
   Valuables tab catches them automatically).
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
        // Legacy valuable-book items still surface in `context.valuables`
        // (they're valuables with system.type === "book") — relocate them to
        // `general` like before. First-class `book` items don't appear in
        // `context.valuables` so they're handled by their own sheet category.
        const extras = (context.valuables ?? []).filter(
            i => i.system?.type === "book"
        );
        if (extras.length) {
            context.general = [...(context.general ?? []), ...extras];
        }
    };

    // Force the current sheet to re-render so the patched method runs.
    app.render(false);
}

/* Raise / Lower Visor (Combat Extended) — helms carrying the `visor` quality.
 * Toggling `system.visorRaised` lifts / restores the helm's Restricted/Poor
 * Vision effects (STA-recovery halving, −2 Awareness/ranged, 90° token vision —
 * all reconciled off the resulting updateItem). While the wearer is in active
 * combat AND actually wearing the helm, the flip costs one Action. */
async function toggleVisor(item, actor, raised) {
    if (item?.type !== "armor") return;
    const chargeable = !!actor?._inActiveCombat && !!item.system?.equipped;
    if (chargeable && actor.hasActionSlot === false) {
        ui.notifications?.warn(t("WITCHER.Notify.Dock.NoActions", "No actions left this turn."));
        return;
    }
    try { await item.update({ "system.visorRaised": raised }); }
    catch (err) { console.warn(`${MODULE_ID} | visor toggle failed`, err); return; }
    if (chargeable) {
        const label = raised
            ? tFormat("WITCHER.Chrome.ContextMenuItem.Text.RaiseVisorLabel", { name: item.name }, `Raise visor: ${item.name}`)
            : tFormat("WITCHER.Chrome.ContextMenuItem.Text.LowerVisorLabel", { name: item.name }, `Lower visor: ${item.name}`);
        try { await actor.spendActionSlot?.(label); } catch (_) { /* action bookkeeping only */ }
    }
}

function registerArmorVisorActions() {
    registerItemAction({
        name: t("WITCHER.Chrome.ContextMenuItem.Text.RaiseVisor", "Raise Visor"),
        icon: '<i class="fa-solid fa-mask"></i>',
        // Shown when the visor is DOWN (restrictions active).
        condition: (item) => item?.type === "armor" && hasVisorQuality(item) && !isVisorRaised(item),
        callback: (item, actor) => toggleVisor(item, actor, true),
        surfaces: { sidebar: false }
    });
    registerItemAction({
        name: t("WITCHER.Chrome.ContextMenuItem.Text.LowerVisor", "Lower Visor"),
        icon: '<i class="fa-solid fa-helmet-safety"></i>',
        // Shown when the visor is UP (restrictions negated).
        condition: (item) => item?.type === "armor" && hasVisorQuality(item) && isVisorRaised(item),
        callback: (item, actor) => toggleVisor(item, actor, false),
        surfaces: { sidebar: false }
    });
}

export function registerItemContextMenu() {
    registerCarcassAndBookActions();
    registerWeaponDrawAction();
    registerWeaponReloadActions();
    registerArmorVisorActions();
    registerFoodDrinkPourActions();
    registerGiftItemAction();

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
