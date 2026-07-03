/**
 * i18n migration manifest — phase 2 (dialog titles + JS .title / .textContent).
 *
 * Most entries are dialog window titles for DialogV2 / Dialog calls.
 * A handful are `.title` or `.textContent` property assignments on DOM
 * elements.
 *
 * The migration tool uses string-context replacement, so a `title:` field
 * in a Dialog config and a free-standing string literal are both reachable
 * with the same kind:"plain"/"format" entries used in phase 1.
 */

const IMPORT_CHROME_CHROME = 'import { t, tFormat } from "../lib/i18n.js";';
const IMPORT_CHROME_INTEG  = 'import { t, tFormat } from "../lib/i18n.js";';
const IMPORT_CHROME_LIB    = 'import { t, tFormat } from "./i18n.js";';
const IMPORT_CHROME_SHEETS = 'import { t, tFormat } from "../lib/i18n.js";';
const IMPORT_APPLICATIONS  = 'import { t, tFormat } from "../chrome/lib/i18n.js";';
const IMPORT_SHEETS_ACTOR  = 'import { t, tFormat } from "../../chrome/lib/i18n.js";';
const IMPORT_SHEETS_ACTOR_MIX = 'import { t, tFormat } from "../../../chrome/lib/i18n.js";';
const IMPORT_SHEETS_ITEM   = 'import { t, tFormat } from "../../chrome/lib/i18n.js";';

export default [
    /* ---- applications ---- */
    {
        file: "module/applications/defensePromptDialog.mjs",
        importLine: IMPORT_APPLICATIONS,
        replacements: [
            { kind: "format", text: "Incoming ${strikeLabel}${shotTag} — ${weaponName ?? \"weapon\"}",
              pattern: "Incoming {strike}{shot} — {weapon}",
              data: "{ strike: strikeLabel, shot: shotTag, weapon: weaponName ?? \"weapon\" }",
              key: "WITCHER.Dialog.Defense.Incoming" },
        ]
    },
    {
        file: "module/applications/foodAndDrinkConfig.mjs",
        importLine: IMPORT_APPLICATIONS,
        replacements: [
            { kind: "plain", text: "Food & Drink Configuration",
              key:  "WITCHER.Dialog.FoodAndDrink.Title" },
        ]
    },
    {
        file: "module/applications/guardConfig.mjs",
        importLine: IMPORT_APPLICATIONS,
        replacements: [
            { kind: "format", text: "Guard — ${actor.name}",
              pattern: "Guard — {actor}",
              data: "{ actor: actor.name }",
              key: "WITCHER.Dialog.Guard.Title" },
        ]
    },
    {
        file: "module/applications/homebrewContentEditor.mjs",
        importLine: IMPORT_APPLICATIONS,
        replacements: [
            { kind: "plain", text: "Homebrew Content",
              key:  "WITCHER.Dialog.Homebrew.Title" },
        ]
    },
    {
        file: "module/applications/qualitiesEditor.mjs",
        importLine: IMPORT_APPLICATIONS,
        replacements: [
            { kind: "plain", text: "Weapon & Armor Qualities",
              key:  "WITCHER.Dialog.Qualities.Title" },
            { kind: "plain", text: "Restore defaults?",
              key:  "WITCHER.Dialog.RestoreDefaults" },
        ]
    },
    {
        file: "module/applications/raiseShieldDialog.mjs",
        importLine: IMPORT_APPLICATIONS,
        replacements: [
            { kind: "format", text: "Raise Shield — ${shield.name}",
              pattern: "Raise Shield — {shield}",
              data: "{ shield: shield.name }",
              key: "WITCHER.Dialog.RaiseShield.Title" },
        ]
    },
    {
        file: "module/applications/ringPortraitCropper.mjs",
        importLine: IMPORT_APPLICATIONS,
        replacements: [
            { kind: "plain", text: "Crop Portrait into Token Ring",
              key:  "WITCHER.Dialog.Crop.Title" },
        ]
    },
    {
        file: "module/applications/statusEffectsEditor.mjs",
        importLine: IMPORT_APPLICATIONS,
        replacements: [
            { kind: "plain", text: "Status Effects",
              key:  "WITCHER.Dialog.StatusEditor.Title" },
            { kind: "plain", text: "Restore RAW defaults?",
              key:  "WITCHER.Dialog.RestoreRawDefaults" },
        ]
    },
    {
        file: "module/applications/stressConfig.mjs",
        importLine: IMPORT_APPLICATIONS,
        replacements: [
            { kind: "plain", text: "Stress Configuration",
              key:  "WITCHER.Dialog.Stress.Title" },
            { kind: "plain", text: "Reset stress config?",
              key:  "WITCHER.Dialog.Stress.Reset" },
        ]
    },

    /* ---- chrome/chrome/ ---- */
    {
        file: "module/chrome/chrome/bestiary.js",
        importLine: IMPORT_CHROME_CHROME,
        replacements: [
            { kind: "plain", text: "Reset entry",
              key:  "WITCHER.Dialog.Bestiary.ResetEntry" },
            { kind: "plain", text: "Populate Bestiary",
              key:  "WITCHER.Dialog.Bestiary.Populate" },
            { kind: "plain", text: "Wipe Research Progress",
              key:  "WITCHER.Dialog.Bestiary.WipeResearch" },
            { kind: "plain", text: "Wipe Encounter Data",
              key:  "WITCHER.Dialog.Bestiary.WipeEncounters" },
        ]
    },
    {
        file: "module/chrome/chrome/context-menu-actor.js",
        importLine: IMPORT_CHROME_CHROME,
        replacements: [
            { kind: "format", text: "Apply Status — ${actor.name}",
              pattern: "Apply Status — {actor}",
              data: "{ actor: actor.name }",
              key: "WITCHER.Dialog.Status.Apply" },
        ]
    },
    {
        file: "module/chrome/chrome/context-menu-item.js",
        importLine: IMPORT_CHROME_CHROME,
        replacements: [
            { kind: "plain", text: "Gift Item",
              key:  "WITCHER.Dialog.Item.Gift" },
            { kind: "format", text: "Configure Charges — ${item.name}",
              pattern: "Configure Charges — {item}",
              data: "{ item: item.name }",
              key: "WITCHER.Dialog.Item.Charges" },
        ]
    },
    {
        file: "module/chrome/chrome/critical-roll.js",
        importLine: IMPORT_CHROME_CHROME,
        replacements: [
            { kind: "plain", text: "Roll Critical Wound",
              key:  "WITCHER.Dialog.Crit.Roll" },
            { kind: "plain", text: "Apply Critical To...",
              key:  "WITCHER.Dialog.Crit.ApplyTo" },
        ]
    },
    {
        file: "module/chrome/chrome/dissect.js",
        importLine: IMPORT_CHROME_CHROME,
        replacements: [
            { kind: "plain", text: "Choose autopsy category",
              key:  "WITCHER.Dialog.Dissect.Category" },
            { kind: "format", text: "Choose skill — ${typeLabel}",
              pattern: "Choose skill — {type}",
              data: "{ type: typeLabel }",
              key: "WITCHER.Dialog.Dissect.Skill" },
        ]
    },
    {
        file: "module/chrome/chrome/dock.js",
        importLine: IMPORT_CHROME_CHROME,
        replacements: [
            { kind: "format", text: "Adrenaline → Temp HP — ${actor.name}",
              pattern: "Adrenaline → Temp HP — {actor}",
              data: "{ actor: actor.name }",
              key: "WITCHER.Dialog.Dock.AdrenalineToTempHp" },
            { kind: "format", text: "Sword guard: ${label} (click to configure)",
              pattern: "Sword guard: {label} (click to configure)",
              data: "{ label: label }",
              key: "WITCHER.Tooltip.Dock.Guard" },
            { kind: "format", text: "Defend — ${item?.name ?? \"weapon\"}",
              pattern: "Defend — {weapon}",
              data: "{ weapon: item?.name ?? \"weapon\" }",
              key: "WITCHER.Dialog.Dock.Defend" },
            { kind: "format", text: "Awareness — ${actor.name}",
              pattern: "Awareness — {actor}",
              data: "{ actor: actor.name }",
              key: "WITCHER.Dialog.Dock.Awareness" },
            { kind: "plain", text: "Clear a condition (1 action)",
              key:  "WITCHER.Dialog.Dock.ClearCondition" },
            { kind: "plain", text: "End a condition — roll (1 action)",
              key:  "WITCHER.Dialog.Dock.EndCondition" },
            { kind: "plain", text: "Special Abilities",
              key:  "WITCHER.Dialog.Dock.SpecialAbilities" },
            { kind: "plain", text: "Full Round — uses your whole turn",
              key:  "WITCHER.Dialog.Dock.FullRound" },
            { kind: "format", text: "Action — ${actor.name}",
              pattern: "Action — {actor}",
              data: "{ actor: actor.name }",
              key: "WITCHER.Dialog.Dock.Action" },
            { kind: "format", text: "Move — ${actor.name}",
              pattern: "Move — {actor}",
              data: "{ actor: actor.name }",
              key: "WITCHER.Dialog.Dock.Move" },
            { kind: "plain", text: "Movement",
              key:  "WITCHER.Dock.MovementLabel" },
            { kind: "plain", text: "Stunned at 0 STA — you can't defend until you recover",
              key:  "WITCHER.Tooltip.Dock.Stunned" },
            { kind: "format", text: "Sober Up (currently Drunk ${numeral}) — roll 1d10 under BODY",
              pattern: "Sober Up (currently Drunk {numeral}) — roll 1d10 under BODY",
              data: "{ numeral: numeral }",
              key: "WITCHER.Tooltip.Dock.SoberUpDrunk" },
            { kind: "plain", text: "Sober Up — currently sober",
              key:  "WITCHER.Tooltip.Dock.SoberUpSober" },
        ]
    },
    {
        file: "module/chrome/chrome/fumble-dialog.js",
        importLine: IMPORT_CHROME_CHROME,
        replacements: [
            { kind: "plain", text: "Fumble Table",
              key:  "WITCHER.Dialog.Fumble.Table" },
            { kind: "plain", text: "Elemental Fumble",
              key:  "WITCHER.Dialog.Fumble.Elemental" },
        ]
    },
    {
        file: "module/chrome/chrome/gm-panel.js",
        importLine: IMPORT_CHROME_CHROME,
        replacements: [
            { kind: "plain", text: "GM Panel",
              key:  "WITCHER.Tooltip.GMPanel" },
            { kind: "plain", text: "New category",
              key:  "WITCHER.Dialog.GM.NewCategory" },
            { kind: "plain", text: "Distribute rewards",
              key:  "WITCHER.Dialog.GM.DistributeRewards" },
        ]
    },
    {
        file: "module/chrome/chrome/harvest.js",
        importLine: IMPORT_CHROME_CHROME,
        replacements: [
            { kind: "format", text: "Carcass · ${item.name}",
              pattern: "Carcass · {item}",
              data: "{ item: item.name }",
              key: "WITCHER.Dialog.Harvest.Carcass" },
        ]
    },
    {
        file: "module/chrome/chrome/inventory.js",
        importLine: IMPORT_CHROME_CHROME,
        replacements: [
            { kind: "plain", text: "Main hand — drag a one-handed weapon here",
              key:  "WITCHER.Inv.Slot.MainHand" },
            { kind: "plain", text: "Off-hand — drag a one-handed weapon here",
              key:  "WITCHER.Inv.Slot.OffHand" },
            { kind: "plain", text: "Quick / off-hand — quick weapons & shields only",
              key:  "WITCHER.Inv.Slot.Quick" },
            { kind: "plain", text: "Switch hands",
              key:  "WITCHER.Inv.SwitchHands" },
            { kind: "plain", text: "Link Mount / Companion",
              key:  "WITCHER.Dialog.LinkMount" },
            { kind: "format", text: "Apply Oil: ${oil.name}",
              pattern: "Apply Oil: {oil}",
              data: "{ oil: oil.name }",
              key: "WITCHER.Dialog.ApplyOil" },
            { kind: "format", text: "Gift ${item.name}",
              pattern: "Gift {item}",
              data: "{ item: item.name }",
              key: "WITCHER.Dialog.GiftItem" },
            { kind: "format", text: "Split ${item.name}",
              pattern: "Split {item}",
              data: "{ item: item.name }",
              key: "WITCHER.Dialog.SplitItem" },
            { kind: "format", text: "Delete ${item.name}",
              pattern: "Delete {item}",
              data: "{ item: item.name }",
              key: "WITCHER.Dialog.DeleteNamedItem" },
        ]
    },
    {
        file: "module/chrome/chrome/journal.js",
        importLine: IMPORT_CHROME_CHROME,
        replacements: [
            { kind: "plain", text: "Delete relationship",
              key:  "WITCHER.Dialog.Journal.DeleteRelationship" },
            { kind: "plain", text: "Delete page",
              key:  "WITCHER.Dialog.Journal.DeletePage" },
        ]
    },
    {
        file: "module/chrome/chrome/skills-panel.js",
        importLine: IMPORT_CHROME_CHROME,
        replacements: [
            { kind: "plain", text: "Defining Skill",
              key:  "WITCHER.Dialog.Skills.Defining" },
        ]
    },

    /* ---- chrome/integrations/ ---- */
    {
        file: "module/chrome/integrations/portrait-toxicity.js",
        importLine: IMPORT_CHROME_INTEG,
        replacements: [
            { kind: "format", text: "Variable Portrait — ${actor.name}",
              pattern: "Variable Portrait — {actor}",
              data: "{ actor: actor.name }",
              key: "WITCHER.Dialog.Portrait.Variable" },
        ]
    },

    /* ---- chrome/lib/ ---- */
    {
        file: "module/chrome/lib/reload.js",
        importLine: IMPORT_CHROME_LIB,
        replacements: [
            { kind: "format", text: "Reload — ${item.name}",
              pattern: "Reload — {item}",
              data: "{ item: item.name }",
              key: "WITCHER.Dialog.Reload" },
        ]
    },

    /* ---- chrome/sheets/ ---- */
    {
        file: "module/chrome/sheets/valuable-study.js",
        importLine: IMPORT_CHROME_SHEETS,
        replacements: [
            { kind: "plain", text: "Study Failed",
              key:  "WITCHER.Dialog.Study.Failed" },
            { kind: "plain", text: "The Last Page",
              key:  "WITCHER.Dialog.Study.LastPage" },
            { kind: "plain", text: "Study Session",
              key:  "WITCHER.Dialog.Study.Session" },
            { kind: "plain", text: "Mastery Achieved",
              key:  "WITCHER.Dialog.Study.Mastery" },
            { kind: "plain", text: "Rank Advanced!",
              key:  "WITCHER.Dialog.Study.RankUp" },
            { kind: "format", text: "Reviewing — ${item.name}",
              pattern: "Reviewing — {item}",
              data: "{ item: item.name }",
              key: "WITCHER.Dialog.Study.Reviewing" },
            { kind: "format", text: "Configure Book — ${item.name}",
              pattern: "Configure Book — {item}",
              data: "{ item: item.name }",
              key: "WITCHER.Dialog.Study.ConfigureBook" },
        ]
    },

    /* ---- module/sheets/actor/ ---- */
    {
        file: "module/sheets/actor/base.mjs",
        importLine: IMPORT_SHEETS_ACTOR,
        replacements: [
            { kind: "format", text: "Skill Package — ${profName}",
              pattern: "Skill Package — {prof}",
              data: "{ prof: profName }",
              key: "WITCHER.Dialog.Skill.Package" },
            { kind: "plain", text: "New Life Event",
              key:  "WITCHER.Dialog.LifeEvent.New" },
            { kind: "plain", text: "Edit Life Event",
              key:  "WITCHER.Dialog.LifeEvent.Edit" },
            { kind: "plain", text: "Delete Life Event",
              key:  "WITCHER.Dialog.LifeEvent.Delete" },
            { kind: "plain", text: "Delete Item",
              key:  "WITCHER.Dialog.DeleteItem" },
            { kind: "format", text: "Stow ${item.name}",
              pattern: "Stow {item}",
              data: "{ item: item.name }",
              key: "WITCHER.Dialog.StowItem" },
            { kind: "plain", text: "Delete Effect",
              key:  "WITCHER.Dialog.DeleteEffect" },
        ]
    },
    {
        file: "module/sheets/actor/character.mjs",
        importLine: IMPORT_SHEETS_ACTOR,
        replacements: [
            { kind: "plain", text: "Clear IP Log",
              key:  "WITCHER.Dialog.IpLog.Clear" },
            { kind: "plain", text: "Stun save — 1d10 ≤ Stun (Core p.152)",
              key:  "WITCHER.Dialog.StunSave" },
        ]
    },
    {
        file: "module/sheets/actor/merchant.mjs",
        importLine: IMPORT_SHEETS_ACTOR,
        replacements: [
            { kind: "plain", text: "Remove Item",
              key:  "WITCHER.Dialog.Merchant.RemoveItem" },
            { kind: "plain", text: "Clear Stock",
              key:  "WITCHER.Dialog.Merchant.ClearStock" },
            { kind: "format", text: "Markup: ${item.name}",
              pattern: "Markup: {item}",
              data: "{ item: item.name }",
              key: "WITCHER.Dialog.Merchant.Markup" },
            { kind: "plain", text: "Deposit Coin",
              key:  "WITCHER.Dialog.Merchant.Deposit" },
            { kind: "plain", text: "Withdraw Coin",
              key:  "WITCHER.Dialog.Merchant.Withdraw" },
            { kind: "plain", text: "Run Stocking",
              key:  "WITCHER.Dialog.Merchant.RunStock" },
            { kind: "plain", text: "Save Stocking Preset",
              key:  "WITCHER.Dialog.Merchant.SavePreset" },
            { kind: "plain", text: "Load Preset",
              key:  "WITCHER.Dialog.Merchant.LoadPreset" },
            { kind: "plain", text: "Delete Preset",
              key:  "WITCHER.Dialog.Merchant.DeletePreset" },
            { kind: "plain", text: "Clear Item Pool",
              key:  "WITCHER.Dialog.Merchant.ClearPool" },
        ]
    },
    {
        file: "module/sheets/actor/monster.mjs",
        importLine: IMPORT_SHEETS_ACTOR,
        replacements: [
            { kind: "plain", text: "Trophy/Remains Icons",
              key:  "WITCHER.Dialog.Monster.TrophyIcons" },
        ]
    },

    /* ---- module/sheets/actor/mixins/ ---- */
    {
        file: "module/sheets/actor/mixins/healSheetMixin.mjs",
        importLine: IMPORT_SHEETS_ACTOR_MIX,
        replacements: [
            { kind: "format", text: "Rest — ${actor.name}",
              pattern: "Rest — {actor}",
              data: "{ actor: actor.name }",
              key: "WITCHER.Dialog.Rest.Title" },
            { kind: "format", text: "Total recover + ${total}",
              pattern: "Total recover + {total}",
              data: "{ total: total }",
              key: "WITCHER.Rest.TotalRecover" },
        ]
    },

    /* ---- module/sheets/item/ ---- */
    {
        file: "module/sheets/item/base.mjs",
        importLine: IMPORT_SHEETS_ITEM,
        replacements: [
            { kind: "plain", text: "Delete Effect",
              key:  "WITCHER.Dialog.DeleteEffect" },
        ]
    },
    {
        file: "module/sheets/item/enhancementSlots.mjs",
        importLine: IMPORT_SHEETS_ITEM,
        replacements: [
            { kind: "plain", text: "Pick AE Location",
              key:  "WITCHER.Dialog.Enhance.PickLocation" },
            { kind: "plain", text: "Remove Enhancement",
              key:  "WITCHER.Dialog.Enhance.Remove" },
        ]
    },
];
