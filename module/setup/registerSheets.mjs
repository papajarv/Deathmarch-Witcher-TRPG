/**
 * registerSheets — registers ApplicationV2 sheet classes for actors and items.
 *
 * Sheet-class names are load-bearing: Foundry fires `render<ClassName>`
 * hooks based on the class identifier, and the overhaul-ui contract
 * targets `renderWitcherCharacterSheet`, `renderWitcherMonsterSheet`,
 * `renderWitcherWeaponSheet`, etc. Don't rename these.
 *
 * v14 API note: the v13-era `Actors.registerSheet(...)` /
 * `Items.registerSheet(...)` collection methods were removed. Sheet
 * registration now goes through
 * `foundry.applications.apps.DocumentSheetConfig.registerSheet(
 *     documentClass, scope, sheetClass, { types, makeDefault, label })`.
 */

import { WitcherCharacterSheet } from "../sheets/actor/character.mjs";
import { WitcherMonsterSheet }   from "../sheets/actor/monster.mjs";
import { WitcherLootSheet }      from "../sheets/actor/loot.mjs";
import { WitcherMerchantSheet }  from "../sheets/actor/merchant.mjs";
import {
    WitcherItemSheet,
    WitcherWeaponSheet,
    WitcherAmmoSheet,
    WitcherArmorSheet,
    WitcherShieldSheet,
    WitcherAlchemicalSheet,
    WitcherSpellSheet,
    WitcherHexSheet,
    WitcherRitualSheet,
    WitcherMutagenSheet,
    WitcherProfessionSheet,
    WitcherRaceSheet,
    WitcherHomelandSheet,
    WitcherComponentSheet,
    WitcherEnhancementSheet,
    WitcherContainerSheet,
    WitcherNoteSheet,
    WitcherPerkSheet,
    WitcherCriticalWoundSheet,
    WitcherDiagramsSheet,
    WitcherValuableSheet,
    WitcherBookSheet,
    WitcherDieSheet,
    WitcherFoodSheet
} from "../sheets/item/base.mjs";
import { WitcherActiveEffectConfig } from "../sheets/activeEffect/config.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";

export function registerSheets() {
    const DSC = foundry.applications.apps.DocumentSheetConfig;
    const Actor = foundry.documents.Actor;
    const Item  = foundry.documents.Item;
    const ActiveEffect = foundry.documents.ActiveEffect;

    // `makeDefault: true` on our registrations is sufficient to make our
    // sheets primary; explicit unregister of the core defaults isn't
    // needed and can warn if the core sheet ID doesn't match what's
    // currently registered.

    DSC.registerSheet(Actor, SYSTEM_ID, WitcherCharacterSheet, {
        types: ["character"], makeDefault: true,
        label: "WITCHER.SheetClassCharacter"
    });
    DSC.registerSheet(Actor, SYSTEM_ID, WitcherMonsterSheet, {
        types: ["monster"], makeDefault: true,
        label: "WITCHER.SheetClassMonster"
    });
    DSC.registerSheet(Actor, SYSTEM_ID, WitcherLootSheet, {
        types: ["loot"], makeDefault: true,
        label: "WITCHER.SheetClassLoot"
    });
    DSC.registerSheet(Actor, SYSTEM_ID, WitcherMerchantSheet, {
        types: ["merchant"], makeDefault: true,
        label: "WITCHER.SheetClassMerchant"
    });

    // Item types with named subclasses so the per-type render hooks
    // fire (overhaul-ui contract requirement) AND each gets its bespoke
    // RAW-shaped template under templates/item/<type>.hbs.
    DSC.registerSheet(Item, SYSTEM_ID, WitcherWeaponSheet,      { types: ["weapon"],      makeDefault: true, label: "WITCHER.SheetClassItem" });
    DSC.registerSheet(Item, SYSTEM_ID, WitcherAmmoSheet,        { types: ["ammo"],        makeDefault: true, label: "WITCHER.SheetClassItem" });
    DSC.registerSheet(Item, SYSTEM_ID, WitcherArmorSheet,       { types: ["armor"],       makeDefault: true, label: "WITCHER.SheetClassItem" });
    DSC.registerSheet(Item, SYSTEM_ID, WitcherShieldSheet,      { types: ["shield"],      makeDefault: true, label: "WITCHER.SheetClassItem" });
    DSC.registerSheet(Item, SYSTEM_ID, WitcherAlchemicalSheet,  { types: ["alchemical"],  makeDefault: true, label: "WITCHER.SheetClassItem" });
    DSC.registerSheet(Item, SYSTEM_ID, WitcherSpellSheet,       { types: ["spell"],       makeDefault: true, label: "WITCHER.SheetClassItem" });
    DSC.registerSheet(Item, SYSTEM_ID, WitcherHexSheet,         { types: ["hex"],         makeDefault: true, label: "WITCHER.SheetClassItem" });
    DSC.registerSheet(Item, SYSTEM_ID, WitcherRitualSheet,      { types: ["ritual"],      makeDefault: true, label: "WITCHER.SheetClassItem" });
    DSC.registerSheet(Item, SYSTEM_ID, WitcherMutagenSheet,     { types: ["mutagen"],     makeDefault: true, label: "WITCHER.SheetClassItem" });
    DSC.registerSheet(Item, SYSTEM_ID, WitcherProfessionSheet,  { types: ["profession"],  makeDefault: true, label: "WITCHER.SheetClassItem" });
    DSC.registerSheet(Item, SYSTEM_ID, WitcherRaceSheet,        { types: ["race"],        makeDefault: true, label: "WITCHER.SheetClassItem" });
    DSC.registerSheet(Item, SYSTEM_ID, WitcherHomelandSheet,    { types: ["homeland"],    makeDefault: true, label: "WITCHER.SheetClassItem" });
    DSC.registerSheet(Item, SYSTEM_ID, WitcherComponentSheet,   { types: ["component"],   makeDefault: true, label: "WITCHER.SheetClassItem" });
    DSC.registerSheet(Item, SYSTEM_ID, WitcherEnhancementSheet, { types: ["enhancement"], makeDefault: true, label: "WITCHER.SheetClassItem" });
    DSC.registerSheet(Item, SYSTEM_ID, WitcherContainerSheet,     { types: ["container"],     makeDefault: true, label: "WITCHER.SheetClassItem" });
    // Map + Remains share the valuable sheet — the sheet branches on
    // document.type to pick the right config / display block. One sheet
    // covers all three because the rendered shape is almost identical: a
    // header + a type-specific config section (image picker for map,
    // source-monster link for remains, subtype select for plain valuables).
    DSC.registerSheet(Item, SYSTEM_ID, WitcherValuableSheet,      { types: ["valuable", "map", "remains"], makeDefault: true, label: "WITCHER.SheetClassItem" });
    // Books are now a first-class item type — own data model, own sheet, own
    // template. Legacy `valuable + system.type === "book"` items still render
    // via WitcherValuableSheet until the migration in migrateLegacyFlags.mjs
    // rewrites them to the `book` type.
    DSC.registerSheet(Item, SYSTEM_ID, WitcherBookSheet,          { types: ["book"],          makeDefault: true, label: "WITCHER.SheetClassItem" });
    DSC.registerSheet(Item, SYSTEM_ID, WitcherDieSheet,           { types: ["die"],           makeDefault: true, label: "WITCHER.SheetClassItem" });
    DSC.registerSheet(Item, SYSTEM_ID, WitcherFoodSheet,          { types: ["food"],          makeDefault: true, label: "WITCHER.SheetClassItem" });
    DSC.registerSheet(Item, SYSTEM_ID, WitcherNoteSheet,          { types: ["note"],          makeDefault: true, label: "WITCHER.SheetClassItem" });
    DSC.registerSheet(Item, SYSTEM_ID, WitcherPerkSheet,          { types: ["perk"],          makeDefault: true, label: "WITCHER.SheetClassItem" });
    DSC.registerSheet(Item, SYSTEM_ID, WitcherCriticalWoundSheet, { types: ["criticalWound"], makeDefault: true, label: "WITCHER.SheetClassItem" });
    DSC.registerSheet(Item, SYSTEM_ID, WitcherDiagramsSheet,      { types: ["diagrams"],      makeDefault: true, label: "WITCHER.SheetClassItem" });

    // Active Effects — friendly editor (grouped Target / plain-language
    // How / Amount) replacing the raw key/mode/value table for every
    // effect, on actors and items alike.
    DSC.registerSheet(ActiveEffect, SYSTEM_ID, WitcherActiveEffectConfig, {
        makeDefault: true, label: "WITCHER.SheetClassEffect"
    });

    // Generic fallback — used only if a future item type is added
    // without its own bespoke sheet. Currently all 19 types have one.
}
