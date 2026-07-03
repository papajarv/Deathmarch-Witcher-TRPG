# Quality functional audit

Total weapon qualities: 55
Total armor qualities:  29


## Weapon qualities

| Key | Label | Status | When it fires | Engine paths |
|---|---|---|---|---|
| `ablating` | Ablating | ✅ wired + tested | on-hit damage calc | 5 hit(s) — module/setup/socketHook.mjs, module/applications/qualitiesEditor.mjs, module/chrome/chrome/inventory.js |
| `armorPiercing` | Armor Piercing | ✅ wired + tested | on-hit damage calc | 6 hit(s) — module/setup/socketHook.mjs, module/applications/qualitiesEditor.mjs, module/chrome/chrome/inventory.js |
| `improvedArmorPiercing` | Improved Armor Piercing | ✅ wired + tested | on-hit damage calc | 9 hit(s) — module/setup/socketHook.mjs, module/applications/qualitiesEditor.mjs, module/chrome/chrome/inventory.js |
| `balanced` | Balanced | ✅ wired + tested | UNCLEAR | 32 hit(s) — module/applications/guardConfig.mjs |
| `bleeding` | Bleeding | ✅ wired + tested | on-hit rider (status / %) | 1 hit(s) — module/documents/mixins/weaponAttackMixin.mjs |
| `brawling` | Brawling | ✅ wired + tested | unarmed damage | 8 hit(s) — module/documents/mixins/brawlMixin.mjs, module/chrome/sheets/valuable-study.js, module/data/combatExtended/actions.mjs |
| `charging` | Charging (legacy Core) | ⚠️ wired, no test | charge damage, charge calc (mounted vs foot) | 2 hit(s) — module/documents/mixins/weaponAttackMixin.mjs |
| `concealment` | Concealment | 🟡 GM | GM-resolved | — |
| `knockdown` | Knock-Down | ✅ wired + tested | on-hit rider (status / %) | 1 hit(s) — module/documents/mixins/weaponAttackMixin.mjs |
| `disease` | Disease | ⚠️ wired, no test | on-hit rider (status / %) | 1 hit(s) — module/documents/mixins/weaponAttackMixin.mjs |
| `crushingForce` | Crushing Force | ⚠️ wired, no test | on-hit damage calc | 2 hit(s) — module/setup/socketHook.mjs, module/chrome/chrome/inventory.js |
| `fire` | Fire | ✅ wired + tested | on-hit rider (status / %) | 5 hit(s) — module/documents/mixins/weaponAttackMixin.mjs, module/combat/damageCalculator.mjs |
| `focus` | Focus | ⚠️ wired, no test | UNCLEAR | 31 hit(s) — module/applications/castDialog.mjs, module/chrome/chrome/bestiary.js, module/chrome/chrome/character.js |
| `freeze` | Freeze | ✅ wired + tested | on-hit rider (status / %) | 121 hit(s) — module/documents/mixins/weaponAttackMixin.mjs, module/api/homebrew.mjs |
| `grappling` | Grappling | 🟡 GM | damage adjust, GM-resolved | 5 hit(s) — module/applications/attackDialog.mjs, module/data/combatExtended/actions.mjs |
| `entangling` | Entangling | ⚠️ wired, no test | on-hit rider (status / %) | 1 hit(s) — module/documents/mixins/weaponAttackMixin.mjs |
| `magicalAnchoring` | Magically Anchoring | ⚠️ wired, no test | UNCLEAR | 1 hit(s) — module/documents/mixins/weaponAttackMixin.mjs |
| `bladeCatcher` | Blade Catcher | ⚠️ wired, no test | UNCLEAR | 1 hit(s) — module/documents/mixins/weaponAttackMixin.mjs |
| `crewReload` | Crew Reload | 🟡 GM | GM-resolved | — |
| `mounted` | Mounted | 🟡 GM | GM-resolved | 6 hit(s) — module/documents/mixins/weaponAttackMixin.mjs |
| `injector` | Injector | 🟡 GM | GM-resolved | 1 hit(s) — module/documents/mixins/weaponAttackMixin.mjs |
| `greaterFocus` | Greater Focus | ⚠️ wired, no test | spell DC | 1 hit(s) — module/documents/mixins/castSpellMixin.mjs |
| `longReach` | Long Reach | ✅ wired + tested | multi-attack follow-up, engagement range, adjacent-target attack | 3 hit(s) — module/documents/mixins/weaponAttackMixin.mjs |
| `meteorite` | Meteorite | ✅ wired + tested | on-hit damage calc, reliability check, enchantment slots | 5 hit(s) — module/setup/socketHook.mjs, module/data/item/templates/enhancementDerivation.mjs |
| `nonLethal` | Non-Lethal (deprecated) | ✅ wired + tested | damage adjust | 5 hit(s) — module/applications/attackDialog.mjs, module/applications/combatActionsEditor.mjs, module/applications/openCategoryConfigDialog.mjs |
| `parrying` | Parrying | ✅ wired + tested | parry roll | 1 hit(s) — module/documents/mixins/defenseMixin.mjs |
| `poison` | Poison | ✅ wired + tested | on-hit rider (status / %) | 3 hit(s) — module/documents/mixins/weaponAttackMixin.mjs, module/data/item/alchemical.mjs |
| `silver` | Silver | ✅ wired + tested | on-hit damage calc | 5 hit(s) — module/setup/socketHook.mjs, module/data/actor/monster.mjs, module/documents/mixins/weaponAttackMixin.mjs |
| `slowReload` | Slow Reload | ⚠️ wired, no test | UNCLEAR | 1 hit(s) — module/data/item/weapon.mjs |
| `stagger` | Stagger | ⚠️ wired, no test | on-hit rider (status / %) | 1 hit(s) — module/documents/mixins/weaponAttackMixin.mjs |
| `stun` | Stun | ✅ wired + tested | on-hit rider (status / %) | 20 hit(s) — module/documents/mixins/weaponAttackMixin.mjs, module/applications/weatherControl.mjs, module/chrome/chrome/character.js |
| `superiorReach` | Superior Reach | ✅ wired + tested | multi-attack follow-up, engagement range, adjacent-target attack, adjacent strike kind | 4 hit(s) — module/documents/mixins/weaponAttackMixin.mjs |
| `extremeReach` | Extreme Reach | ✅ wired + tested | multi-attack follow-up, engagement range, adjacent-target attack, adjacent strike block | 4 hit(s) — module/documents/mixins/weaponAttackMixin.mjs |
| `guard` | Guard | ✅ wired + tested | defense roll | 38 hit(s) — module/documents/mixins/defenseMixin.mjs, module/applications/guardConfig.mjs |
| `superiorGuard` | Superior Guard | ✅ wired + tested | defense roll | 1 hit(s) — module/documents/mixins/defenseMixin.mjs |
| `feeble` | Feeble | ✅ wired + tested | parry gating, block damage halving, block nonlethal halving | 2 hit(s) — module/documents/mixins/defenseMixin.mjs, module/documents/mixins/weaponAttackMixin.mjs |
| `hefty` | Hefty | ✅ wired + tested | on-hit damage calc, parry gating (defense), block nonlethal halving | 2 hit(s) — module/setup/socketHook.mjs, module/documents/mixins/weaponAttackMixin.mjs |
| `sturdy` | Sturdy | ✅ wired + tested | parry option vs hefty | 1 hit(s) — module/applications/defensePromptDialog.mjs |
| `indirect` | Indirect | ✅ wired + tested | on-hit damage calc, both attack & defense rolls | 4 hit(s) — module/setup/socketHook.mjs, module/documents/mixins/defenseMixin.mjs |
| `nimble` | Nimble | ✅ wired + tested | draw STA cost, attack STA cost | 2 hit(s) — module/documents/mixins/weaponAttackMixin.mjs |
| `cavalry` | Cavalry | ✅ wired + tested | charge damage, equip-time / charge gate, charge calc (mounted vs foot) | 2 hit(s) — module/documents/mixins/weaponAttackMixin.mjs |
| `footCharging` | Charging | ✅ wired + tested | charge damage, charge calc (mounted vs foot) | 2 hit(s) — module/documents/mixins/weaponAttackMixin.mjs |
| `closeQuarters` | Close Quarters | ✅ wired + tested | clinch action, grapple action | 4 hit(s) — module/applications/openCategoryConfigDialog.mjs, module/mechanics/openCategoryBonuses.mjs |
| `throwing` | Throwing | ✅ wired + tested | UNCLEAR | 5 hit(s) — module/applications/attackDialog.mjs, module/applications/openCategoryConfigDialog.mjs, module/mechanics/openCategoryBonuses.mjs |
| `twoHand` | Two-Hand | ✅ wired + tested | UNCLEAR | 8 hit(s) — module/applications/openCategoryConfigDialog.mjs, module/chrome/chrome/dock.js, module/chrome/chrome/inventory.js |
| `strangling` | Strangling | ✅ wired + tested | UNCLEAR | 4 hit(s) — module/applications/openCategoryConfigDialog.mjs, module/mechanics/openCategoryBonuses.mjs |
| `physique` | Physique | ✅ wired + tested | equip-time gate | 5 hit(s) — module/documents/mixins/weaponAttackMixin.mjs, module/chrome/sheets/valuable-study.js |
| `grounded` | Grounded | ✅ wired + tested | use gate (not in air) | 1 hit(s) — module/documents/mixins/weaponAttackMixin.mjs |
| `stableAim` | Stable Aim | ✅ wired + tested | crit roll bonus | 3 hit(s) — module/chrome/chrome/critical-roll.js |
| `improvedRange` | Improved Range | ⚠️ wired, no test | range calc | 1 hit(s) — module/applications/attackDialog.mjs |
| `reducedRange` | Reduced Range | ⚠️ wired, no test | range calc | 1 hit(s) — module/applications/attackDialog.mjs |
| `foraging` | Foraging | ⚠️ wired, no test | downtime forage | 1 hit(s) — module/applications/openCategoryConfigDialog.mjs |
| `crafting` | Crafting | ⚠️ wired, no test | downtime crafting | 22 hit(s) — module/applications/openCategoryConfigDialog.mjs, module/chrome/chrome/crafting.js |
| `freeAmmunition` | Free Ammunition | ⚠️ wired, no test | UNCLEAR | 1 hit(s) — module/documents/mixins/reloadMixin.mjs |
| `halfDamage` | Half Damage | ⚠️ wired, no test | damage adjust | 1 hit(s) — module/documents/mixins/weaponAttackMixin.mjs |

## Armor qualities

| Key | Label | Status | When it fires | Engine paths |
|---|---|---|---|---|
| `restrictedVision` | Restricted Vision | ✅ wired + tested | STA recovery halving | 10 hit(s) — module/documents/mixins/combatRoundMixin.mjs, module/applications/raiseShieldDialog.mjs |
| `fullCover` | Full Cover (deprecated) | ❌ UNWIRED (claims wired) | UNCLEAR | — |
| `criticalDecimation` | Critical Decimation | ✅ wired + tested | crit handling | 1 hit(s) — module/chrome/chrome/critical-roll.js |
| `criticalFlurry` | Critical Flurry | ✅ wired + tested | crit handling | 1 hit(s) — module/documents/mixins/weaponAttackMixin.mjs |
| `criticalSpellcasting` | Critical Spellcasting | ✅ wired + tested | crit handling | 1 hit(s) — module/documents/mixins/weaponAttackMixin.mjs |
| `criticalBlock` | Critical Block | ✅ wired + tested | crit handling | 1 hit(s) — module/documents/mixins/weaponAttackMixin.mjs |
| `criticalRiposte` | Critical Riposte | ✅ wired + tested | crit handling | 1 hit(s) — module/documents/mixins/weaponAttackMixin.mjs |
| `criticalMomentum` | Critical Momentum | ✅ wired + tested | crit handling | 1 hit(s) — module/documents/mixins/weaponAttackMixin.mjs |
| `poorVision` | Poor Vision | ✅ wired + tested | STA recovery halving | 1 hit(s) — module/documents/mixins/combatRoundMixin.mjs |
| `difficult` | Difficult | ✅ wired + tested | crit handling | 15 hit(s) — module/chrome/chrome/critical-roll.js, module/chrome/chrome/inventory.js |
| `stifling` | Stifling | ✅ wired + tested | rest gate (post-combat) | 1 hit(s) — module/sheets/actor/base.mjs |
| `lanceRest` | Lance Rest | 🟡 GM | GM-resolved | — |
| `superiorLanceRest` | Superior Lance Rest | 🟡 GM | GM-resolved | — |
| `options` | Options | 🟡 GM | GM-resolved | 20 hit(s) — module/applications/effectTargetPicker.mjs, module/applications/weatherConfig.mjs, module/chrome/chrome/harvest.js |
| `sturdyShield` | Sturdy | ✅ wired + tested | parry option vs hefty | 1 hit(s) — module/applications/defensePromptDialog.mjs |
| `verySturdy` | Very Sturdy | ✅ wired + tested | parry option vs hefty, parry option vs crushing | 2 hit(s) — module/applications/defensePromptDialog.mjs |
| `parryingShield` | Parrying | ✅ wired + tested | parry roll | 1 hit(s) — module/documents/mixins/defenseMixin.mjs |
| `bladeCatcherArmor` | Blade Catcher | 🟡 GM | GM-resolved | — |
| `deployable` | Deployable | 🟡 GM | GM-resolved | — |
| `silverContact` | Silver Contact | ✅ wired + tested | UNCLEAR | 1 hit(s) — module/documents/mixins/weaponAttackMixin.mjs |
| `meteoriteContact` | Meteorite Contact | ✅ wired + tested | UNCLEAR | 1 hit(s) — module/documents/mixins/weaponAttackMixin.mjs |
| `monsterResistance` | Monster Resistance | 🟡 GM | GM-resolved | — |
| `setBonus` | Set Bonus | 🟡 GM | GM-resolved | 2 hit(s) — module/documents/mixins/weaponAttackMixin.mjs |
| `fireproof` | Fireproof | ✅ wired + tested | UNCLEAR | 1 hit(s) — module/setup/socketHook.mjs |
| `bleedResistance` | Resistance to Bleeding | ✅ wired + tested | UNCLEAR | 2 hit(s) — module/documents/mixins/weaponAttackMixin.mjs |
| `hidden` | Hidden | 🟡 GM | GM-resolved | 21 hit(s) — module/applications/castDialog.mjs, module/applications/guardConfig.mjs |
| `archeryShield` | Archery Shield | 🟡 GM | GM-resolved | — |
| `rangedPenalty` | Ranged Penalty | ✅ wired + tested | range calc | 2 hit(s) — module/documents/mixins/weaponAttackMixin.mjs |
| `spdPenalty` | SPD Penalty | ✅ wired + tested | UNCLEAR | 2 hit(s) — module/data/actor/character.mjs |

## Summary


**Weapon** (55 total):
- ✅ wired + tested: 34
- ⚠️ wired, no test: 16
- 🟡 GM: 5
- ❌ UNWIRED (claims wired): 0

**Armor** (29 total):
- ✅ wired + tested: 19
- ⚠️ wired, no test: 0
- 🟡 GM: 9
- ❌ UNWIRED (claims wired): 1
