/**
 * AUTO-GENERATED — do not hand-edit. Re-run:
 *   node tools/i18n-gen-hbs-text-manifest.mjs > tools/i18n-manifest-hbs-text.mjs
 *
 * Phase 4 of the i18n migration: every literal text between two HBS tag
 * boundaries moves into a lang/en.json key (WITCHER.<area>.Text.<slug>).
 * Total: 26 findings across 9 files.
 */
export default [
    {
        "file": "templates/actor/character/main.hbs",
        "replacements": [
            {
                "kind": "hbs-text",
                "before": ">",
                "text": "Death State — all stats ×⅓ until stabilized (Core p.162)",
                "after": "<",
                "key": "WITCHER.Sheet.Character.Text.DeathStateAllStatsUntilStabilizedCoreP16"
            },
            {
                "kind": "hbs-text",
                "before": ">",
                "text": "Empty — right-click an item and choose “Put in Container…”.",
                "after": "<",
                "key": "WITCHER.Sheet.Character.Text.EmptyRightClickAnItemAndChoosePutInConta"
            }
        ]
    },
    {
        "file": "templates/actor/merchant/main.hbs",
        "replacements": [
            {
                "kind": "hbs-text",
                "before": ">",
                "text": "Friendly (-10%)",
                "after": "<",
                "key": "WITCHER.Sheet.Merchant.Text.Friendly10"
            },
            {
                "kind": "hbs-text",
                "before": ">",
                "text": "Grumpy (+15%)",
                "after": "<",
                "key": "WITCHER.Sheet.Merchant.Text.Grumpy15"
            },
            {
                "kind": "hbs-text",
                "before": ">",
                "text": "Shifty (+20%)",
                "after": "<",
                "key": "WITCHER.Sheet.Merchant.Text.Shifty20"
            },
            {
                "kind": "hbs-text",
                "before": ">",
                "text": "Noble (+5%)",
                "after": "<",
                "key": "WITCHER.Sheet.Merchant.Text.Noble5"
            },
            {
                "kind": "hbs-text",
                "before": ">",
                "text": "Desperate (-25%)",
                "after": "<",
                "key": "WITCHER.Sheet.Merchant.Text.Desperate25"
            },
            {
                "kind": "hbs-text",
                "before": ">",
                "text": "Neutral (0%)",
                "after": "<",
                "key": "WITCHER.Sheet.Merchant.Text.Neutral0"
            },
            {
                "kind": "hbs-text",
                "before": ">",
                "text": "How much this merchant charges above or below standard prices. 1% precision.",
                "after": "<",
                "key": "WITCHER.Sheet.Merchant.Text.HowMuchThisMerchantChargesAboveOrBelowSt"
            }
        ]
    },
    {
        "file": "templates/applications/food-and-drink-config.hbs",
        "replacements": [
            {
                "kind": "hbs-text",
                "before": ">",
                "text": "Status Effects → Edit Status Effects",
                "after": "<",
                "key": "WITCHER.App.FoodAndDrinkConfig.Text.StatusEffectsEditStatusEffects"
            },
            {
                "kind": "hbs-text",
                "before": ">",
                "text": "Death %",
                "after": "<",
                "key": "WITCHER.App.FoodAndDrinkConfig.Text.Death"
            }
        ]
    },
    {
        "file": "templates/applications/status-effects-editor.hbs",
        "replacements": [
            {
                "kind": "hbs-text",
                "before": ">",
                "text": "Skill (when kind = skill)",
                "after": "<",
                "key": "WITCHER.App.StatusEffectsEditor.Text.SkillWhenKindSkill"
            }
        ]
    },
    {
        "file": "templates/dialog/heal-rest.hbs",
        "replacements": [
            {
                "kind": "hbs-text",
                "before": "> ",
                "text": "Full rest (×REC instead of REC/2)",
                "after": "<",
                "key": "WITCHER.Dialog.HealRest.Text.FullRestRecInsteadOfRec2"
            },
            {
                "kind": "hbs-text",
                "before": "> ",
                "text": "Sterilized wounds (+2 HP, +2 days each new wound)",
                "after": "<",
                "key": "WITCHER.Dialog.HealRest.Text.SterilizedWounds2Hp2DaysEachNewWound"
            },
            {
                "kind": "hbs-text",
                "before": "> ",
                "text": "Healing Hand (+3 HP)",
                "after": "<",
                "key": "WITCHER.Dialog.HealRest.Text.HealingHand3Hp"
            },
            {
                "kind": "hbs-text",
                "before": "> ",
                "text": "Healing Tent (+2 HP)",
                "after": "<",
                "key": "WITCHER.Dialog.HealRest.Text.HealingTent2Hp"
            }
        ]
    },
    {
        "file": "templates/item/book.hbs",
        "replacements": [
            {
                "kind": "hbs-text",
                "before": ">",
                "text": "Book System homebrew is OFF — enable it in world settings for study books to work.",
                "after": "<",
                "key": "WITCHER.Sheet.Book.Text.BookSystemHomebrewIsOffEnableItInWorldSe"
            }
        ]
    },
    {
        "file": "templates/item/criticalWound.hbs",
        "replacements": [
            {
                "kind": "hbs-text",
                "before": ">",
                "text": "Only this bonus ignored armor · dealt on the original strike",
                "after": "<",
                "key": "WITCHER.Sheet.CriticalWound.Text.OnlyThisBonusIgnoredArmorDealtOnTheOrigi"
            },
            {
                "kind": "hbs-text",
                "before": ">",
                "text": "Deadly — does not heal naturally. Removed only by a prosthesis or magic.",
                "after": "<",
                "key": "WITCHER.Sheet.CriticalWound.Text.DeadlyDoesNotHealNaturallyRemovedOnlyByA"
            },
            {
                "kind": "hbs-text",
                "before": ">",
                "text": "Effect — Unstabilized",
                "after": " <",
                "key": "WITCHER.Sheet.CriticalWound.Text.EffectUnstabilized"
            },
            {
                "kind": "hbs-text",
                "before": ">",
                "text": "Effect — Stabilized",
                "after": " <",
                "key": "WITCHER.Sheet.CriticalWound.Text.EffectStabilized"
            },
            {
                "kind": "hbs-text",
                "before": ">",
                "text": "Effect — Treated",
                "after": " <",
                "key": "WITCHER.Sheet.CriticalWound.Text.EffectTreated"
            }
        ]
    },
    {
        "file": "templates/item/enhancement.hbs",
        "replacements": [
            {
                "kind": "hbs-text",
                "before": ">",
                "text": "Reliability +",
                "after": "<",
                "key": "WITCHER.Sheet.Enhancement.Text.Reliability"
            },
            {
                "kind": "hbs-text",
                "before": ">",
                "text": "Stopping +",
                "after": "<",
                "key": "WITCHER.Sheet.Enhancement.Text.Stopping"
            }
        ]
    },
    {
        "file": "templates/item/valuable.hbs",
        "replacements": [
            {
                "kind": "hbs-text",
                "before": ">",
                "text": "Book (legacy — will migrate)",
                "after": "<",
                "key": "WITCHER.Sheet.Valuable.Text.BookLegacyWillMigrate"
            },
            {
                "kind": "hbs-text",
                "before": ">",
                "text": "Book System homebrew is OFF — enable it in world settings for study books to work.",
                "after": "<",
                "key": "WITCHER.Sheet.Valuable.Text.BookSystemHomebrewIsOffEnableItInWorldSe"
            }
        ]
    }
];

