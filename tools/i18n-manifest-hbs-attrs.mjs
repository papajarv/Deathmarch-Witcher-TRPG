/**
 * AUTO-GENERATED — do not hand-edit. Re-run:
 *   node tools/i18n-gen-hbs-attr-manifest.mjs > tools/i18n-manifest-hbs-attrs.mjs
 *
 * Phase 3 of the i18n migration: every HBS attribute (title="...",
 * placeholder="...", aria-label="...", alt="...") moves into a
 * lang/en.json key. Key shape:
 *
 *   WITCHER.<area>.<attrKind>.<pascalSlug>
 *
 * where <attrKind> is Tooltip / Hint / Aria / Alt.
 */

export default [
    {
        "file": "templates/actor/character/main.hbs",
        "replacements": [
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Death state — Core p.162",
                "key": "WITCHER.Sheet.Character.Tooltip.DeathStateCoreP162"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Wounded — Core p.156",
                "key": "WITCHER.Sheet.Character.Tooltip.WoundedCoreP156"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Successful death saves — each adds −1 to the next (Core p.162)",
                "key": "WITCHER.Sheet.Character.Tooltip.SuccessfulDeathSavesEachAdds1ToTheNextCo"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Improvement Points — edit on the Skills tab",
                "key": "WITCHER.Sheet.Character.Tooltip.ImprovementPointsEditOnTheSkillsTab"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Initiative — 1d10 + REF (Core p.151)",
                "key": "WITCHER.Sheet.Character.Tooltip.Initiative1d10RefCoreP151"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Take a Breath — STA += REC (Core p.152)",
                "key": "WITCHER.Sheet.Character.Tooltip.TakeABreathStaRecCoreP152"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Stun save — 1d10 ≤ Stun (Core p.152)",
                "key": "WITCHER.Sheet.Character.Tooltip.StunSave1d10StunCoreP152"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Death save — 1d10 ≤ unmodified Stun (−1 per prior success); a fail is death (Core p.162)",
                "key": "WITCHER.Sheet.Character.Tooltip.DeathSave1d10UnmodifiedStun1PerPriorSucc"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Brawl — unarmed / grapple attack",
                "key": "WITCHER.Sheet.Character.Tooltip.BrawlUnarmedGrappleAttack"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Critical — roll a critical wound and apply it",
                "key": "WITCHER.Sheet.Character.Tooltip.CriticalRollACriticalWoundAndApplyIt"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Fumble — roll on the fumble table",
                "key": "WITCHER.Sheet.Character.Tooltip.FumbleRollOnTheFumbleTable"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Invested points (Core p.38). AE bonuses are added on top and shown as → N.",
                "key": "WITCHER.Sheet.Character.Tooltip.InvestedPointsCoreP38AeBonusesAreAddedOn"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Stored Shield. AE bonuses (Quen, armor, etc.) are added on top and shown as → N.",
                "key": "WITCHER.Sheet.Character.Tooltip.StoredShieldAeBonusesQuenArmorEtcAreAdde"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Investigation pool — A Witcher's Journal p.145",
                "key": "WITCHER.Sheet.Character.Tooltip.InvestigationPoolAWitcherSJournalP145"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Attack — 1d10 + stat + skill + WA",
                "key": "WITCHER.Sheet.Character.Tooltip.Attack1d10StatSkillWa"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Unequip — leave loose in inventory (costs an action in combat)",
                "key": "WITCHER.Sheet.Character.Tooltip.UnequipLeaveLooseInInventoryCostsAnActio"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Drop to the world — any player can pick it up (free)",
                "key": "WITCHER.Sheet.Character.Tooltip.DropToTheWorldAnyPlayerCanPickItUpFree"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Difficult skill — ×2 IP per rank (Core p.49)",
                "key": "WITCHER.Sheet.Character.Tooltip.DifficultSkill2IpPerRankCoreP49"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Modifier from effects + items",
                "key": "WITCHER.Sheet.Character.Tooltip.ModifierFromEffectsItems"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Total: stat + rank + modifier − EV penalty",
                "key": "WITCHER.Sheet.Character.Tooltip.TotalStatRankModifierEvPenalty"
            }
        ]
    },
    {
        "file": "templates/actor/loot/main.hbs",
        "replacements": [
            {
                "kind": "hbs-attr",
                "attr": "placeholder",
                "text": "What's in the pile, who left it, narrative hooks…",
                "key": "WITCHER.Sheet.Loot.Hint.WhatSInThePileWhoLeftItNarrativeHooks"
            }
        ]
    },
    {
        "file": "templates/actor/monster/main.hbs",
        "replacements": [
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Manual — printed bestiary HP. Leave 0 on a new monster to auto-fill (BODY+WILL)/2 × 5",
                "key": "WITCHER.Sheet.Monster.Tooltip.ManualPrintedBestiaryHpLeave0OnANewMonst"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Manual — printed bestiary STA (0 = construct/never tires). Leave 0 on a new monster to auto-fill (BODY+WILL)/2 × 5",
                "key": "WITCHER.Sheet.Monster.Tooltip.ManualPrintedBestiarySta0ConstructNeverT"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Initiative — adds this monster to the encounter and rolls 1d10 + REF (Core p.151)",
                "key": "WITCHER.Sheet.Monster.Tooltip.InitiativeAddsThisMonsterToTheEncounterA"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Stun save — 1d10 &lt; Stun (Core p.152)",
                "key": "WITCHER.Sheet.Monster.Tooltip.StunSave1d10StunCoreP152"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Death save — 1d10 &lt; unmodified Stun (−1 per prior success); a fail is death (Core p.162)",
                "key": "WITCHER.Sheet.Monster.Tooltip.DeathSave1d10UnmodifiedStun1PerPriorSucc"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Fumble — roll on the fumble table",
                "key": "WITCHER.Sheet.Monster.Tooltip.FumbleRollOnTheFumbleTable"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Critical — roll a critical wound and apply it to this monster",
                "key": "WITCHER.Sheet.Monster.Tooltip.CriticalRollACriticalWoundAndApplyItToTh"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Successful death saves — each adds −1 to the next (Core p.162)",
                "key": "WITCHER.Sheet.Monster.Tooltip.SuccessfulDeathSavesEachAdds1ToTheNextCo"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Base — monsters may exceed 10 (large/supernatural creatures); mutations / AE push the modified higher",
                "key": "WITCHER.Sheet.Monster.Tooltip.BaseMonstersMayExceed10LargeSupernatural"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "BODY × 10",
                "key": "WITCHER.Sheet.Monster.Tooltip.Body10"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Manual — printed bestiary REC. Leave 0 on a new monster to auto-fill (BODY + WILL) / 2",
                "key": "WITCHER.Sheet.Monster.Tooltip.ManualPrintedBestiaryRecLeave0OnANewMons"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "SPD × 3",
                "key": "WITCHER.Sheet.Monster.Tooltip.Spd3"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "RAW Core p.159 — creatures without organs (elementa, specters, constructs) don't take organ-based critical wounds; they take a higher flat bonus instead (+5/+10/+15/+20 vs +3/+5/+8/+10). 'Auto' defers to category.",
                "key": "WITCHER.Sheet.Monster.Tooltip.RawCoreP159CreaturesWithoutOrgansElement"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Damage types — target's reactions to these types apply",
                "key": "WITCHER.Sheet.Monster.Tooltip.DamageTypesTargetSReactionsToTheseTypesA"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Difficult skill — costs ×2 IP per rank (Core p.49)",
                "key": "WITCHER.Sheet.Monster.Tooltip.DifficultSkillCosts2IpPerRankCoreP49"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Modifier from active effects + items",
                "key": "WITCHER.Sheet.Monster.Tooltip.ModifierFromActiveEffectsItems"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Total: stat + rank + modifier",
                "key": "WITCHER.Sheet.Monster.Tooltip.TotalStatRankModifier"
            }
        ]
    },
    {
        "file": "templates/applications/status-effects-editor.hbs",
        "replacements": [
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Color of the countdown ring on the chrome dock status badge. Leave blank to use the family default (red = stress break, green = stress boon, orange = food/drink, amber = everything else).",
                "key": "WITCHER.App.StatusEffectsEditor.Tooltip.ColorOfTheCountdownRingOnTheChromeDockSt"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Erode this much Stopping Power off the armor at each struck location, every turn (fire/acid). 0 = none.",
                "key": "WITCHER.App.StatusEffectsEditor.Tooltip.ErodeThisMuchStoppingPowerOffTheArmorAtE"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Buffer size rolled on apply. Accepts any Roll formula — dice (1d6, 2d6, 3d6+1) or a flat number (3). Ignored when Kind is None.",
                "key": "WITCHER.App.StatusEffectsEditor.Tooltip.BufferSizeRolledOnApplyAcceptsAnyRollFor"
            }
        ]
    },
    {
        "file": "templates/applications/stress-config.hbs",
        "replacements": [
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Each point of stress over WILL hits the WILL save by this much. 1 = default (stress 9 vs WILL 6 → save target 3). 0.5 = saves stay easier at high stress; 2 = each point over WILL doubles the pain.",
                "key": "WITCHER.App.StressConfig.Tooltip.EachPointOfStressOverWillHitsTheWillSave"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "After every WILL save, stress settles to (WILL + this number). Default =−1, so WILL 6 lands at 5. Use 0 to stop at WILL exactly; use −3 for a stronger reset.",
                "key": "WITCHER.App.StressConfig.Tooltip.AfterEveryWillSaveStressSettlesToWillThi"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "How many distinct mental breaks a character can accumulate before control passes to the GM. Default =8 (every entry on the break table). Lower numbers make the character break sooner.",
                "key": "WITCHER.App.StressConfig.Tooltip.HowManyDistinctMentalBreaksACharacterCan"
            }
        ]
    },
    {
        "file": "templates/inspection/item-card.hbs",
        "replacements": [
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Effective weight (kg) — portion-scaled",
                "key": "WITCHER.Inspect.ItemCard.Tooltip.EffectiveWeightKgPortionScaled"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Effective value (crowns) — portion-scaled",
                "key": "WITCHER.Inspect.ItemCard.Tooltip.EffectiveValueCrownsPortionScaled"
            }
        ]
    },
    {
        "file": "templates/item/alchemical.hbs",
        "replacements": [
            {
                "kind": "hbs-attr",
                "attr": "placeholder",
                "text": "Alchemical lore, appearance, provenance…",
                "key": "WITCHER.Sheet.Alchemical.Hint.AlchemicalLoreAppearanceProvenance"
            }
        ]
    },
    {
        "file": "templates/item/ammo.hbs",
        "replacements": [
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "GM-resolved — engine has no automatic consumer",
                "key": "WITCHER.Sheet.Ammo.Tooltip.GmResolvedEngineHasNoAutomaticConsumer"
            },
            {
                "kind": "hbs-attr",
                "attr": "placeholder",
                "text": "Ammunition lore, appearance, narrative notes…",
                "key": "WITCHER.Sheet.Ammo.Hint.AmmunitionLoreAppearanceNarrativeNotes"
            }
        ]
    },
    {
        "file": "templates/item/armor.hbs",
        "replacements": [
            {
                "kind": "hbs-attr",
                "attr": "data-tooltip",
                "text": "Empty slot — drag a Glyph or armor-mod enhancement to fill",
                "key": "WITCHER.Sheet.Armor.Tooltip.EmptySlotDragAGlyphOrArmorModEnhancement"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "GM-resolved — engine has no automatic consumer",
                "key": "WITCHER.Sheet.Armor.Tooltip.GmResolvedEngineHasNoAutomaticConsumer"
            },
            {
                "kind": "hbs-attr",
                "attr": "placeholder",
                "text": "Armor lore, appearance, provenance…",
                "key": "WITCHER.Sheet.Armor.Hint.ArmorLoreAppearanceProvenance"
            }
        ]
    },
    {
        "file": "templates/item/book.hbs",
        "replacements": [
            {
                "kind": "hbs-attr",
                "attr": "placeholder",
                "text": "What this book is about, where it came from, what it's worth…",
                "key": "WITCHER.Sheet.Book.Hint.WhatThisBookIsAboutWhereItCameFromWhatIt"
            }
        ]
    },
    {
        "file": "templates/item/component.hbs",
        "replacements": [
            {
                "kind": "hbs-attr",
                "attr": "placeholder",
                "text": "Fields / Mountains & underground / Forests …",
                "key": "WITCHER.Sheet.Component.Hint.FieldsMountainsUndergroundForests"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Wilderness Survival DC to find this in the wild (0 = can't be foraged).",
                "key": "WITCHER.Sheet.Component.Tooltip.WildernessSurvivalDcToFindThisInTheWild0"
            },
            {
                "kind": "hbs-attr",
                "attr": "placeholder",
                "text": "Ingredient lore, appearance, where it's harvested…",
                "key": "WITCHER.Sheet.Component.Hint.IngredientLoreAppearanceWhereItSHarveste"
            }
        ]
    },
    {
        "file": "templates/item/container.hbs",
        "replacements": [
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Maximum weight this container can hold. 0 = unlimited.",
                "key": "WITCHER.Sheet.Container.Tooltip.MaximumWeightThisContainerCanHold0Unlimi"
            },
            {
                "kind": "hbs-attr",
                "attr": "placeholder",
                "text": "What it looks like, where it's worn…",
                "key": "WITCHER.Sheet.Container.Hint.WhatItLooksLikeWhereItSWorn"
            }
        ]
    },
    {
        "file": "templates/item/criticalWound.hbs",
        "replacements": [
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Critical Healing table, p.175 — days to clear the Treated penalty.",
                "key": "WITCHER.Sheet.CriticalWound.Tooltip.CriticalHealingTableP175DaysToClearTheTr"
            }
        ]
    },
    {
        "file": "templates/item/diagrams.hbs",
        "replacements": [
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "What this entry represents. Diagram → Crafting roll. Formula → Alchemy roll (uses the nine substances). Recipe → Cooking roll (homebrew food & drink).",
                "key": "WITCHER.Sheet.Diagrams.Tooltip.WhatThisEntryRepresentsDiagramCraftingRo"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Metalwork — crafting this needs a Forge rather than a portable Crafting kit. Drives the tool requirement on the crafting panel.",
                "key": "WITCHER.Sheet.Diagrams.Tooltip.MetalworkCraftingThisNeedsAForgeRatherTh"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Memorized — craftable without the physical diagram in hand.",
                "key": "WITCHER.Sheet.Diagrams.Tooltip.MemorizedCraftableWithoutThePhysicalDiag"
            },
            {
                "kind": "hbs-attr",
                "attr": "placeholder",
                "text": "What the diagram describes, where it was found…",
                "key": "WITCHER.Sheet.Diagrams.Hint.WhatTheDiagramDescribesWhereItWasFound"
            }
        ]
    },
    {
        "file": "templates/item/die.hbs",
        "replacements": [
            {
                "kind": "hbs-attr",
                "attr": "placeholder",
                "text": "Provenance, craftsmanship, the tell of a loaded die…",
                "key": "WITCHER.Sheet.Die.Hint.ProvenanceCraftsmanshipTheTellOfALoadedD"
            }
        ]
    },
    {
        "file": "templates/item/enhancement.hbs",
        "replacements": [
            {
                "kind": "hbs-attr",
                "attr": "placeholder",
                "text": "Mechanical effect text shown on the enhancement…",
                "key": "WITCHER.Sheet.Enhancement.Hint.MechanicalEffectTextShownOnTheEnhancemen"
            },
            {
                "kind": "hbs-attr",
                "attr": "placeholder",
                "text": "Flavor, where it was found…",
                "key": "WITCHER.Sheet.Enhancement.Hint.FlavorWhereItWasFound"
            }
        ]
    },
    {
        "file": "templates/item/food.hbs",
        "replacements": [
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Satiety restored on consume (0–125). Only used when Edible is on.",
                "key": "WITCHER.Sheet.Food.Tooltip.SatietyRestoredOnConsume0125OnlyUsedWhen"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "When ON, consuming this ingredient runs the spoiled-food hazard (DC 14 Endurance; fail = Food Sickness AE for 24 h). Stacks with Edible — an edible-but-sickening ingredient grants satiety AND triggers the save.",
                "key": "WITCHER.Sheet.Food.Tooltip.WhenOnConsumingThisIngredientRunsTheSpoi"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Total portions per unit (0 = no portion ticker, consume just decrements quantity).",
                "key": "WITCHER.Sheet.Food.Tooltip.TotalPortionsPerUnit0NoPortionTickerCons"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Satiety restored per portion eaten (0–125).",
                "key": "WITCHER.Sheet.Food.Tooltip.SatietyRestoredPerPortionEaten0125"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Prefix for the spawned single-portion item. Defaults to 'Glass' for drinks, 'Portion' for meals/ingredients. Custom values: 'Flagon', 'Bowl', 'Plate', 'Mug', …",
                "key": "WITCHER.Sheet.Food.Tooltip.PrefixForTheSpawnedSinglePortionItemDefa"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "When ON, the spawned portion uses the icon below instead of inheriting the source's icon — useful when a bottle should pour into a glass-shaped icon.",
                "key": "WITCHER.Sheet.Food.Tooltip.WhenOnTheSpawnedPortionUsesTheIconBelowI"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "In-game days before the food spoils after it's first acquired by a character. 0 = never spoils (cured, dried, distilled).",
                "key": "WITCHER.Sheet.Food.Tooltip.InGameDaysBeforeTheFoodSpoilsAfterItSFir"
            },
            {
                "kind": "hbs-attr",
                "attr": "placeholder",
                "text": "Short flavor line — printed in chat each time a portion is consumed (never on the display tooltip).",
                "key": "WITCHER.Sheet.Food.Hint.ShortFlavorLinePrintedInChatEachTimeAPor"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Verb used in chat: 'drinks', 'sips', 'guzzles', 'downs'…",
                "key": "WITCHER.Sheet.Food.Tooltip.VerbUsedInChatDrinksSipsGuzzlesDowns"
            },
            {
                "kind": "hbs-attr",
                "attr": "placeholder",
                "text": "What it is, how it tastes, what it does…",
                "key": "WITCHER.Sheet.Food.Hint.WhatItIsHowItTastesWhatItDoes"
            }
        ]
    },
    {
        "file": "templates/item/hex.hbs",
        "replacements": [
            {
                "kind": "hbs-attr",
                "attr": "placeholder",
                "text": "Touch, 10m, Sight…",
                "key": "WITCHER.Sheet.Hex.Hint.Touch10mSight"
            },
            {
                "kind": "hbs-attr",
                "attr": "placeholder",
                "text": "Mechanical effect on the target…",
                "key": "WITCHER.Sheet.Hex.Hint.MechanicalEffectOnTheTarget"
            },
            {
                "kind": "hbs-attr",
                "attr": "placeholder",
                "text": "What it takes to break the curse…",
                "key": "WITCHER.Sheet.Hex.Hint.WhatItTakesToBreakTheCurse"
            }
        ]
    },
    {
        "file": "templates/item/homeland.hbs",
        "replacements": [
            {
                "kind": "hbs-attr",
                "attr": "placeholder",
                "text": "Where the character hails from, and what that means…",
                "key": "WITCHER.Sheet.Homeland.Hint.WhereTheCharacterHailsFromAndWhatThatMea"
            }
        ]
    },
    {
        "file": "templates/item/main.hbs",
        "replacements": [
            {
                "kind": "hbs-attr",
                "attr": "placeholder",
                "text": "Item description, lore, mechanical notes…",
                "key": "WITCHER.Sheet.Main.Hint.ItemDescriptionLoreMechanicalNotes"
            }
        ]
    },
    {
        "file": "templates/item/note.hbs",
        "replacements": [
            {
                "kind": "hbs-attr",
                "attr": "placeholder",
                "text": "The text on the page, the contents of the journal, the clue itself…",
                "key": "WITCHER.Sheet.Note.Hint.TheTextOnThePageTheContentsOfTheJournalT"
            }
        ]
    },
    {
        "file": "templates/item/perk.hbs",
        "replacements": [
            {
                "kind": "hbs-attr",
                "attr": "placeholder",
                "text": "What this perk represents (a life event, a school bonus, a quirk…)",
                "key": "WITCHER.Sheet.Perk.Hint.WhatThisPerkRepresentsALifeEventASchoolB"
            }
        ]
    },
    {
        "file": "templates/item/profession.hbs",
        "replacements": [
            {
                "kind": "hbs-attr",
                "attr": "placeholder",
                "text": "What the defining skill does…",
                "key": "WITCHER.Sheet.Profession.Hint.WhatTheDefiningSkillDoes"
            },
            {
                "kind": "hbs-attr",
                "attr": "placeholder",
                "text": "What this skill does…",
                "key": "WITCHER.Sheet.Profession.Hint.WhatThisSkillDoes"
            },
            {
                "kind": "hbs-attr",
                "attr": "placeholder",
                "text": "The profession's flavour and role…",
                "key": "WITCHER.Sheet.Profession.Hint.TheProfessionSFlavourAndRole"
            }
        ]
    },
    {
        "file": "templates/item/race.hbs",
        "replacements": [
            {
                "kind": "hbs-attr",
                "attr": "placeholder",
                "text": "What this quality does…",
                "key": "WITCHER.Sheet.Race.Hint.WhatThisQualityDoes"
            },
            {
                "kind": "hbs-attr",
                "attr": "placeholder",
                "text": "Lore, appearance, lineage…",
                "key": "WITCHER.Sheet.Race.Hint.LoreAppearanceLineage"
            }
        ]
    },
    {
        "file": "templates/item/ritual.hbs",
        "replacements": [
            {
                "kind": "hbs-attr",
                "attr": "placeholder",
                "text": "Touch, 10m, Sight…",
                "key": "WITCHER.Sheet.Ritual.Hint.Touch10mSight"
            },
            {
                "kind": "hbs-attr",
                "attr": "placeholder",
                "text": "Mechanical effect of a successful ritual…",
                "key": "WITCHER.Sheet.Ritual.Hint.MechanicalEffectOfASuccessfulRitual"
            }
        ]
    },
    {
        "file": "templates/item/shield.hbs",
        "replacements": [
            {
                "kind": "hbs-attr",
                "attr": "data-tooltip",
                "text": "Empty slot — drag a Glyph or armor-mod enhancement to fill",
                "key": "WITCHER.Sheet.Shield.Tooltip.EmptySlotDragAGlyphOrArmorModEnhancement"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "GM-resolved — engine has no automatic consumer",
                "key": "WITCHER.Sheet.Shield.Tooltip.GmResolvedEngineHasNoAutomaticConsumer"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Combat Extended — Cover Value: how many adjacent hit locations Raise Shield can cover. CV 6+ = full cover (all locations); CV 7+ shields are too unwieldy to Block/Parry in melee (cover only).",
                "key": "WITCHER.Sheet.Shield.Tooltip.CombatExtendedCoverValueHowManyAdjacentH"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Shield bash (Core p.164) — a Melee attack dealing bludgeoning, lethal damage equal to your Punch shifted up by shield size (medium +2 Body levels, heavy +4). Capped at 1d6+8.",
                "key": "WITCHER.Sheet.Shield.Tooltip.ShieldBashCoreP164AMeleeAttackDealingBlu"
            },
            {
                "kind": "hbs-attr",
                "attr": "placeholder",
                "text": "Special rules, e.g. Full Cover behaviour…",
                "key": "WITCHER.Sheet.Shield.Hint.SpecialRulesEGFullCoverBehaviour"
            },
            {
                "kind": "hbs-attr",
                "attr": "placeholder",
                "text": "Shield lore, appearance, provenance…",
                "key": "WITCHER.Sheet.Shield.Hint.ShieldLoreAppearanceProvenance"
            }
        ]
    },
    {
        "file": "templates/item/spell.hbs",
        "replacements": [
            {
                "kind": "hbs-attr",
                "attr": "placeholder",
                "text": "Touch, 10m, Sight…",
                "key": "WITCHER.Sheet.Spell.Hint.Touch10mSight"
            },
            {
                "kind": "hbs-attr",
                "attr": "placeholder",
                "text": "Mechanical effect, damage formula, on-hit rules…",
                "key": "WITCHER.Sheet.Spell.Hint.MechanicalEffectDamageFormulaOnHitRules"
            },
            {
                "kind": "hbs-attr",
                "attr": "placeholder",
                "text": "The gift's mandatory side-effect…",
                "key": "WITCHER.Sheet.Spell.Hint.TheGiftSMandatorySideEffect"
            }
        ]
    },
    {
        "file": "templates/item/valuable.hbs",
        "replacements": [
            {
                "kind": "hbs-attr",
                "attr": "placeholder",
                "text": "Vampire, Relict…",
                "key": "WITCHER.Sheet.Valuable.Hint.VampireRelict"
            },
            {
                "kind": "hbs-attr",
                "attr": "placeholder",
                "text": "What this item is, where it came from, what it's worth…",
                "key": "WITCHER.Sheet.Valuable.Hint.WhatThisItemIsWhereItCameFromWhatItSWort"
            }
        ]
    },
    {
        "file": "templates/item/weapon.hbs",
        "replacements": [
            {
                "kind": "hbs-attr",
                "attr": "data-tooltip",
                "text": "Empty slot — drag a Rune or weapon-mod enhancement to fill",
                "key": "WITCHER.Sheet.Weapon.Tooltip.EmptySlotDragARuneOrWeaponModEnhancement"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "GM-resolved — engine has no automatic consumer for this quality",
                "key": "WITCHER.Sheet.Weapon.Tooltip.GmResolvedEngineHasNoAutomaticConsumerFo"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "A quick item (throwing knife, dagger…) may sit in the off-hand Quick slot. Otherwise one-handed weapons only fit Right or Left.",
                "key": "WITCHER.Sheet.Weapon.Tooltip.AQuickItemThrowingKnifeDaggerMaySitInThe"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Current — blocks remaining",
                "key": "WITCHER.Sheet.Weapon.Tooltip.CurrentBlocksRemaining"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Maximum — total blocks before breaking",
                "key": "WITCHER.Sheet.Weapon.Tooltip.MaximumTotalBlocksBeforeBreaking"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Add actor's Bonus Melee Damage (Core p.48). Default on for melee + thrown.",
                "key": "WITCHER.Sheet.Weapon.Tooltip.AddActorSBonusMeleeDamageCoreP48DefaultO"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Ammo class this weapon fires. Only matching ammo can be loaded — arrows in bows, bolts in crossbows.",
                "key": "WITCHER.Sheet.Weapon.Tooltip.AmmoClassThisWeaponFiresOnlyMatchingAmmo"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Actions to reload a chamber-load. 0 = bow (nock-and-loose, no reload step). 1 = Slow Reload (crossbows). Higher for heavier arms.",
                "key": "WITCHER.Sheet.Weapon.Tooltip.ActionsToReloadAChamberLoad0BowNockAndLo"
            },
            {
                "kind": "hbs-attr",
                "attr": "title",
                "text": "Skill rolled when this weapon is used in melee (in hand) instead of thrown. The attack card offers a melee/thrown toggle. Leave at — none — to allow throwing only.",
                "key": "WITCHER.Sheet.Weapon.Tooltip.SkillRolledWhenThisWeaponIsUsedInMeleeIn"
            },
            {
                "kind": "hbs-attr",
                "attr": "placeholder",
                "text": "Weapon lore, appearance, narrative notes…",
                "key": "WITCHER.Sheet.Weapon.Hint.WeaponLoreAppearanceNarrativeNotes"
            }
        ]
    }
];

