/**
 * registerDataModels — attaches TypeDataModel classes to CONFIG.<Doc>.dataModels
 * during the `init` hook.
 *
 * Add each type's data model here as it gets implemented. The presence of
 * a registration here is what tells Foundry to use our schema instead of
 * the empty shell declared in system.json's `documentTypes` block
 * (template.json was deprecated in v14; document types now live in
 * system.json per the System Data Models guide).
 */

// Actor data models
import { CharacterData } from "../data/actor/character.mjs";
import { MonsterData }   from "../data/actor/monster.mjs";
import { LootData }      from "../data/actor/loot.mjs";
import { MerchantData }  from "../data/actor/merchant.mjs";

// Item data models
import { WeaponData }        from "../data/item/weapon.mjs";
import { AmmoData }          from "../data/item/ammo.mjs";
import { ArmorData }         from "../data/item/armor.mjs";
import { ShieldData }        from "../data/item/shield.mjs";
import { ContainerData }     from "../data/item/container.mjs";
import { ComponentData }     from "../data/item/component.mjs";
import { MutagenData }       from "../data/item/mutagen.mjs";
import { DiagramsData }      from "../data/item/diagrams.mjs";
import { ValuableData }      from "../data/item/valuable.mjs";
import { BookData }          from "../data/item/book.mjs";
import { MapData }           from "../data/item/map.mjs";
import { RemainsData }       from "../data/item/remains.mjs";
import { DieData }           from "../data/item/die.mjs";
import { FoodData }          from "../data/item/food.mjs";
import { CriticalWoundData } from "../data/item/criticalWound.mjs";
import { NoteData }          from "../data/item/note.mjs";
import { PerkData }          from "../data/item/perk.mjs";
import { AlchemicalData }    from "../data/item/alchemical.mjs";
import { EnhancementData }   from "../data/item/enhancement.mjs";
import { ProfessionData }    from "../data/item/profession.mjs";
import { RaceData }          from "../data/item/race.mjs";
import { HomelandData }      from "../data/item/homeland.mjs";
import { SpellData }         from "../data/item/spell.mjs";
import { HexData }           from "../data/item/hex.mjs";
import { RitualData }        from "../data/item/ritual.mjs";

// ChatMessage data models
import { AttackMessageData }  from "../data/chatMessage/attack.mjs";
import { DefenseMessageData } from "../data/chatMessage/defense.mjs";
import { DamageMessageData }  from "../data/chatMessage/damage.mjs";

// ActiveEffect data models
import { TemporaryItemImprovementData } from "../data/activeEffect/temporaryItemImprovement.mjs";

export function registerDataModels() {
    // Actors (3)
    CONFIG.Actor.dataModels.character = CharacterData;
    CONFIG.Actor.dataModels.monster   = MonsterData;
    CONFIG.Actor.dataModels.loot      = LootData;
    CONFIG.Actor.dataModels.merchant  = MerchantData;

    // Items (21)
    CONFIG.Item.dataModels.weapon        = WeaponData;
    CONFIG.Item.dataModels.ammo          = AmmoData;
    CONFIG.Item.dataModels.armor         = ArmorData;
    CONFIG.Item.dataModels.shield        = ShieldData;
    CONFIG.Item.dataModels.container     = ContainerData;
    CONFIG.Item.dataModels.component     = ComponentData;
    CONFIG.Item.dataModels.mutagen       = MutagenData;
    CONFIG.Item.dataModels.diagrams      = DiagramsData;
    CONFIG.Item.dataModels.valuable      = ValuableData;
    CONFIG.Item.dataModels.book          = BookData;
    CONFIG.Item.dataModels.map           = MapData;
    CONFIG.Item.dataModels.remains       = RemainsData;
    CONFIG.Item.dataModels.die           = DieData;
    CONFIG.Item.dataModels.food          = FoodData;
    CONFIG.Item.dataModels.criticalWound = CriticalWoundData;
    CONFIG.Item.dataModels.note          = NoteData;
    CONFIG.Item.dataModels.perk          = PerkData;
    CONFIG.Item.dataModels.alchemical    = AlchemicalData;
    CONFIG.Item.dataModels.enhancement   = EnhancementData;
    CONFIG.Item.dataModels.profession    = ProfessionData;
    CONFIG.Item.dataModels.race          = RaceData;
    CONFIG.Item.dataModels.homeland      = HomelandData;
    CONFIG.Item.dataModels.spell         = SpellData;
    CONFIG.Item.dataModels.hex           = HexData;
    CONFIG.Item.dataModels.ritual        = RitualData;

    // ChatMessages (3)
    CONFIG.ChatMessage.dataModels.attack  = AttackMessageData;
    CONFIG.ChatMessage.dataModels.defense = DefenseMessageData;
    CONFIG.ChatMessage.dataModels.damage  = DamageMessageData;

    // ActiveEffects (1)
    CONFIG.ActiveEffect.dataModels.temporaryItemImprovement = TemporaryItemImprovementData;
}
