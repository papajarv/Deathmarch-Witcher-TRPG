/**
 * The rules text, as the core rulebook prints it.
 *
 * Extracted from the PDF rather than retyped, then cleaned of what a
 * two-column layout leaves behind: hyphenation across line breaks, ligatures
 * the encoder split mid-word ("Th under", "Suff ocate"), and the occasional
 * sidebar bleeding into the effect column.
 *
 * Kept apart from the authored trees on purpose. A tree says what a spell
 * DOES; this says what the book says, which is what a player reads at the
 * table and what a GM adjudicates the edges from. Different jobs, and they
 * drift for different reasons — an errata moves one without touching the other.
 */

export const DESCRIPTIONS = Object.freeze({
    "Aard":
        "Aard shoots a wave of telekinetic force, staggering creatures with a 10% chance of those affected being knocked prone. The percentage rises by 10% for each point of STA spent.",
    "Aard Sweep":
        "Aard now shoots a burst of telekinetic force around you. For each STA point spent, everything caught in the burst has a 10% chance of being knocked to the ground and staggered. The burst travels out in all directions as a sphere. Flying creatures struck with Aard Sweep are knocked out of the air as well as being knocked down.",
    "Active Shield":
        "Quen now creates a glowing shield around you. The shield has 10 HP for every Stamina point spent. Each round after the first, you must spend a number of STA points equal to the initial STA cost to maintain the shield. Active Shield only covers you, but you can fit one other person into it if you are pressed together. While in the active shield nothing tangible can pass in or out without destroying the shield first and you must move slowly to keep the shield up, meaning you cannot run. When the shield is expended or dropped, anything adjacent to you is pushed back 2m and takes 1d6 damage to the torso. This includes objects, furniture, and allies. Anything rooted to the ground or heavier than 226kg is not pushed back but still takes damage.",
    "Adenydd":
        "Adenydd allows you to lighten yourself slightly and create a simple glide path when falling. This means for each 2m you fall you travel 2m in a direction. If you make it to the ground within the duration of the spell you take no damage.",
    "Aenye":
        "Aenye allows you to throw a ball of pure fire at an opponent within the range of the spell. This ball of fire does 4d6 damage and has a 75% chance of lighting the target on fire.",
    "Afan's Mirror":
        "Created by the talented Aedirnian mage Afan of Gulet, Afan's mirror creates 1d10 illusory copies of the caster. These copies are intangible, but indistinguishable from the caster and controlled by the caster's mind. Controlling the copies does not require an action but they cannot leave the spell's range.",
    "Aine Verseos":
        "Aine Verseos creates an area of bright light in a 4m radius centred on you.",
    "Air Pocket":
        "Air Pocket allows you to create a pocket of fresh air underwater or in an area where there normally wouldn't be fresh air. The pocket has a 1m radius for the duration of the spell.",
    "Alzur's Thunder":
        "Alzur's Thunder allows you to shoot a powerful lightning bolt at a target which does 8d6 damage and has a 75% chance of setting the target on fire. Alzur's Thunder can travel in a straight line through targets. For every target it passes through the damage to the next target decreases by 1d6.",
    "Anialwch":
        "Anialwch allows you to suck some of the liquid from a target's body, damaging and exhausting them. The spell does 4d6 damage which cannot be blocked by armor or shields. The extreme dehydration creates a fatigue which lowers the target's current STA by 4d6 as well.",
    "Axii":
        "Axii stuns an opponent until they can make Stun save at -1. For every 2 points of additional STA you spend past 1, the Stun save becomes harder by 1 point.",
    "Blessing of Death":
        "Summoning the power of the Lion-Headed Spider, you cut the ties of life holding a target to this world. The target must roll Resist Magic or be thrust into Death state as if by taking normal damage. However if they are treated with a successful First Aid or Healing Hands roll at a DC of 16, they immediately recover their previous number of Health Points.",
    "Blessing of Fortune":
        "The Blessing of Fortune gives the target LUCK points equal to half the value you rolled over DC:12 (max 5).",
    "Blessing of Healing":
        "Blessing of Healing jumpstarts a target's healing, allowing them to heal at 3 points per round. This blessing can be used multiple times to heal a critical wound.",
    "Blessing of Love":
        "The Blessing of Love gives the caster a +3 to Charisma and Seduction for the duration of the invocation.",
    "Blinding Dust":
        "Blinding Dust allows you to shoot a magical dust into the eyes of a target that blinds them for the duration of the spell.",
    "Boiling Blood":
        "Boiling Blood causes an animal or non-sentient monster within range to become enraged at a target. The creature will try to attack the chosen target until the duration ends.",
    "Brand of Fire":
        "Brand of Fire allows you to brand a target with a simple symbol or word anywhere on their exposed body. This does 1d6 damage to the target and leaves a large, permanent scar.",
    "Bronwyn's Gust":
        "Bronwyn's Gust is named after the Skellige mage and raider, Bronwyn Deadeye. The spell allows you to knock a target back a number of meters equal to the number of points you rolled over the opponent's defense. This attack only does 1d6 damage, but if your opponent strikes something they take ramming damage.",
    "Cadfan's Grasp":
        "Cadfan's Grasp, named for the magician and smith Cadfan of Ebbing, allows you to super-heat a metal item, making the holder drop the item or take 2d6 damage to the limb holding it. Alternatively, the spell can heat weapons to give +2d6 damage and a 50% chance to ignite a target.",
    "Carys' Hail":
        "Named for its creator Carys of Cintra, this spell hurls pellets of ice at high speeds at 1 opponent. For every 1 point you roll over your opponent's Dodge/ Block (maximum 5), you deal 1d6 damage and have a 25% chance to freeze your opponent. Each roll counts as its own separate attack when determining location and dealing damage.",
    "Cenlly Graig":
        "Cenlly Graig hurls sharp stones at your opponent. For every point you roll above your opponent's defense (maximum 10) you deal 1d6 damage. Each roll counts as its own attack.",
    "Cleansing Fire":
        "Cleansing Fire ignites one target, doing 3d6 damage and setting them on fire.",
    "Codi Bywyd":
        "Codi Bywyd can grow a small plant from seed to maturity in one turn. This allows you to grow herbs and alchemical plants, but not larger plants such as trees.",
    "Control Water":
        "Control Water allows you to control the speed at which a body of water is moving and in what direction it's moving for the duration of the spell. This can be used to slow swimming targets by half, speed up ships by half, or slow or halt river currents.",
    "Curse of Sedna":
        "Named after the tumultuous Sedna Abyss, which is considered a suicidal destination for ships, Curse of Sedna creates a powerful whirlpool in a 4 meter area. Anyone within 5m must make a Swimming check equal to your Spell Casting check or be dragged underwater. They must make a check each round or remain underwater, where they will start suffocating.",
    "Cursed Illness":
        "Cursed Illness causes one target to fall ill. The illness manifests differently based on how many Stamina points are spent. 2 points causes the target to double over coughing and staggers them. 4 points causes the target to become violently ill, stunning them. 6 points causes the target to become ill with a ravaging disease which is treated as a poison. The invocation ends when the target makes an Endurance roll at a DC equal to the casting roll.",
    "Demetia's Crest Surge":
        "Demetia's Crest Surge allows you to create a shield of pure fire magic around you that blocks a number of water spells equal to 2 times your Spell Casting skill value. Projectiles that enter the shield are destroyed, and living creatures cannot enter the area of the shield.",
    "Dervish":
        "Created by a mysterious Ofieri magician, Dervish allows you to create a 2m tornado around yourself. This tornado immediately redirects ranged attacks as per Gwynt Troelli and acts a Zephyr spell against anyone within 2m of you. You cannot run while within this tornado, or make attacks out of it. But if you move within 2m of a target they are effected by Zephyr.",
    "Diagnostic Spell":
        "Diagnostic Spell allows you to quickly assess a person's health and determine how many Health Points they have, what critical wounds they have, and if they are sick or poisoned.",
    "Dispel":
        "Dispel allows you to end a spell/ritual/hex within the range of this spell. This spell can cancel magic with a duration and can be used as a defensive action to block magic attacks with or without physical components. To cancel a magical effect you must spend half as many Stamina points as the caster spent to cast the magic and make a Spell Casting roll that beats their casting roll.",
    "Divine Portal":
        "Divine Portal creates a standing portal for a brief instant. The portal lasts for just one round and allows you to transport yourself or others anywhere you can recall. This portal otherwise functions like the mage spell, Standing Portal.",
    "Divine Wisdom":
        "Divine Wisdom searches with a powerful augury for the answer to a question. This answer cannot predict the future. The GM sets your DC based on the secrecy of the information.",
    "Dormyn's Fog":
        "Created by Dormyn of Gemmera, Dormyn's Fog creates an area with a 10m radius, centred on you, of thick fog which puts anyone in it at a -3 to Awareness and limits vision range to 4m.",
    "Downpour":
        "Downpour creates a 10m radius area of rain that puts out any fire it hits. This spell counteracts fir e effects.",
    "Earthen Spike":
        "Earthen Spike creates an angled stalagmite to stab up into the target. This spike does 5d6 damage and remains until destroyed. It can be destroyed by doing 20 points of damage to it.",
    "Eilhart's Technique":
        "Named for its creator Philippa Eilhart, this gruesome spell allows you to dig into a target's mind and tear out information. If you succeed on your Spell Casting roll you gain one piece of information from the target. If the target fumbles their defense, their INT is reduced by 1 permanently.",
    "Elgan's Theory":
        "Elgan's Theory was discovered by Elgan of Verden who travelled to the heart of Mahakam and worked for years studying earth magic. The spell allows you to magnetize a metal object within 8m. Anything metal within 2m is drawn and sticks to the magnet. It takes a DC:18 Physique check to pry an object off. All metal that sticks to someone's weapons or armor counts against their ENC.",
    "Eternal Judgement":
        "Using the power granted to you by the Eternal Fire, you cause a target to burst into a bright white fire, tinged with red. The fire does double the normal fire damage and cannot be extinguished except by magic, or by completely submerging underwater for 3 rounds. Anything that touches this magical fire ignites with normal fire and can be put out in one full round.",
    "Fire Stream":
        "Igni now throws out a constant stream of fire and sparks from your hand which does 1d6 damage per STA point spent, and has a 75% chance of lighting the opponent on fire. Fire Stream must be maintained every round with a number of STA points equal to 1/2 the number of STA points spent to cast the sign. You can switch targets on your turn and the stream can be aimed at body locations.",
    "Flaming Vortex":
        "Flaming Vortex creates a flaming tornado 2m wide. You can direct the tornado to move a number of meters equal to your Spell Casting skill value per turn. If it runs over or into a target, make a Spell Casting roll versus their Dodge/Escape roll. If they fail, they take 5d6 damage and have a 50% chance of being set on fire. The vortex will not travel beyond the spell's range.",
    "Freshen Air":
        "Freshen Air allows you to clear a 4m radius area (centered around you) of any smoke, poison, or any other tainted air for the duration of the spell.",
    "Freya's Bravery":
        "Calling upon the power of the goddess Freya, you summon her spirit into your body, creating a glow around yourself which emanates 20m in all directions. Every person within that area is emboldened by Modron Freya's love and guidance. They become immune to fear and gain 25 Health Points for the duration of the spell. If they leave the area of the invocation, its effects last for 1d6 rounds. These rounds renew if the person re-enters the area of the invocation and leaves again. This invocation affects those who don't believe in Freya, but the power can be withheld from anyone the caster chooses.",
    "Friend to Wild Kind":
        "Friend to Wild Kind grants the caster a +3 to Wilderness Survival for handling animals. Alternately it can calm one animal if the Spell Casting roll exceeds the animal's WILLx3.",
    "Glamour":
        "Glamour allows you to cast an illusion around yourself that makes you look stunning. This spell grants you +3 to Seduction, Charisma, and Leadership.",
    "Gwynt Troelli":
        "Gwynt Troelli creates a barrier of wind around you that blocks ranged attacks and projectiles. Any projectile attack must beat your Spell Casting roll. If they fail, the barrier knocks the projectile 8m away in a random direction.",
    "Healing Rest":
        "With the power granted to you by Melitele, the mother goddess, you can place a number of people equal to the value of your Spell Casting skill into a deep coma in which their bodies heal themselves. They cannot act for the entirety of the rest and are unaware of their surroundings even if touched, moved, or attacked. At the end of the rest, targets revive at full health. If they had any critical wounds that had been treated, these wounds have been healed. This does not remove permanent penalties from Deadly Critical Wounds.",
    "Holy Fortification":
        "Holy Fortification bolsters a target's willpower and allows the target to make a new check against the effects of any spell that is currently affecting them.",
    "Holy Light":
        "Holy Light lights up an area as though the caster was carrying a torch. The light gives offno heat and cannot be used to ignite other objects like a torch can.",
    "Ice Slick":
        "Ice Slick allows you to create a 2m square area of ice. Anyone who crosses that area must make an Athletics check at a DC equal to your Spell Casting check or trip on the ice.",
    "Igni":
        "Igni throws out a wave of sparks and fire which does 1d6 damage per STA point spent and has a 50% chance of lighting anything it hits on fire. Igni always deals damage to the torso unless used at point blank range. When used at point blank range Igni can be aimed at body locations.",
    "Illusion":
        "Illusion allows you to create any visual illusion you want within 20m of yourself. Anyone who fails the Resist Magic check sees the illusion and believes it. The illusion cannot be touched, smelled, or heard, however.",
    "Korath's Breath":
        "Korath's Breath breaks down a nearby stone or earth surface and sprays burning sand in a 3m cone in front of you. Opponents in that area that fail their defense are blinded for 1d6 rounds.",
    "Light of Truth":
        "The Light of Truth allows you to create a bright white light that forces one target to speak truthfully. Every round the target must make another check. If they fail, they must answer any question truthfully.",
    "Lightning Storm":
        "Lightning Storm allows you to create a lightning storm. Lightning strikes randomly around the area. Anyone (except you) in the area has a 35% chance of being struck by lightning. If they miss this roll, they must make a Dodge/ Escape check or take 8d6 damage to the torso and have a 75% chance to be ignited.",
    "Luck of the Father":
        "With power granted to you by Kreve, the All-Father, you gather divine providence to you. For the duration of the spell you can spend a number of LUCK points equal to your Spell Casting skill value times 3. You can augment any rolls you make, but can also impose penalties or grant bonuses to the roll of anyone within 10m.",
    "Luthien's Quill":
        "Named for its inventor, Luthien of Ebbing, Luthien's Quill can etch writing or drawings into any solid surface. It cannot be used on living creatures.",
    "Magic Compass":
        "Magic Compass allows you to instantly determine the direction to a place you have been before. Alternately, the spell tells which direction is north.",
    "Magic Flare":
        "Magic Flare creates a bright flash above you. Everyone within an 8m radius must make a Resist Magic check or be blinded for 1d6 rounds. This flare can be seen for 10 kilometers.",
    "Magic Healing":
        "Magic Healing stimulates the natural healing of a target to heal them at a rate of 3 points of damage per round. This lasts for the duration of the spell. Alternatively, this spell can be used repeatedly to heal a critical wound.",
    "Magic Trap":
        "Yrden now creates a magical trap that takes one round to prepare. This trap attacks using your Spell Casting & WILL and does 3d6 damage. The trap will make one attack against the closest enemy each round.",
    "Melgar's Fire":
        "This spell is well known for sowing chaos on the fields of the Pontar Valley. Melgar's Fire allows you to rain balls of fire from the sky over a huge area. Anyone (except you) in the area has a 75% chance of being struck by a ball of fire. If they miss this roll, they must defend at a DC equal to your Spell Casting check or take 4d6 damage to a random location and have a 75% chance of being ignited.",
    "Mental Command":
        "Mental Command allows you to plant an order in the mind of a target. This command must be executed to the letter by the target. If the command is something the target would never do, they get a +5 to their Resist Magic check.",
    "Merigold's Hailstorm":
        "Named for its creator Triss Merigold, ex-advisor of King Foltest of Temeria, Merigold's Hailstorm creates a hailstorm encompassing the area of the spell. Everyone within the storm must make a Dodge/Escape check at a DC equal to your Spell Casting check each round or take 2d6 damage to a body part.",
    "Mind Manipulation":
        "Mind Manipulation allows you to force one target to feel one of the following emotions for the duration of the spell: hatred, love, depression, or euphoria.",
    "Mirror Effect":
        "Mirror Effect creates a blinding beam of light which does 10d6 damage. This laser can be dodged and blocked (destroying whatever blocks it) but it cannot be displaced by wind and can only be parried by a reflective surface, which still takes damage. The reflected laser goes offin a random direction. This spell uses the rays of the sun and cannot be used where the sun's rays can't penetrate. By the light of the moon or on overcast days, it does half damage.",
    "Nature's Gift":
        "Nature's Giftgrows a small cluster of edible plants in soil of any kind. These plants are enough to sustain a number of people equal to the number of STA points spent for 1 day.",
    "Nature's Sight":
        "Nature's Sight allows you to see creatures that are not natural to this realm. This allows you to see monsters within 50m, even through obstacles. Monsters seen in this view appears as glowing versions of themselves.",
    "Part Water":
        "Part Water allows you to create an open area in a body of water, up to 10m by 100m by 10m. Fish, monsters, and other creatures in the water are swept back with the water. You can pass in and out of the wall as easily as stepping in or out of a body of water without disturbing the walls. If used while in the water the the effect pushes the caster aside as well. The area can be summoned in any orientation, even vertical.",
    "Polymorphism":
        "Polymorphism allows you to take the shape of a serpent, a cat, a bird, or a dog. While in this form, you have the physical statistics of that animal (See Bestiary, pg.310). Any items on your person transform with you. You must cast the spell again to change back to your human form.",
    "Primal Reservoir":
        "Primal Reservoir allows you to tap into the primal power of a target and awaken it. It grants them a +2 to Melee Damage, but a -2 to INT for the duration of the spell.",
    "Puppet":
        "Axii now controls an opponent's mind, making them your ally for a number of rounds equal to the number of STA points you spent on the spell. Each round, the target can make a Resist Magic roll against your Spell Casting roll to try and free themselves.",
    "Puro Dwr":
        "Puro Dwr allows you to purify 1 cubic meter of water. This negates poison and disease, but will not force living creatures out of it. If cast on a small part of a larger body of polluted water, the water will begin to pollute again after the duration of the spell ends.",
    "Quen":
        "Quen creates a shield with 5 Health Points per point of Stamina spent to protect you. If you fail (or choose not to or are unable to) to defend against an attack or effect which causes damage, the damage is first applied to the Quen shield. Lethal and non-lethal damage reduce the Quen shield's Health Points equally. If the shield is reduced to 0 Health any remaining damage is applied to you as per normal and must penetrate your armor and damage resistances to impact your Health Points or Stamina just like any other attack. Quen can be used to defend against any spell which can be Blocked but is ineffective against damage caused by spells which cannot be Blocked or against damage caused by already being poisoned, having a disease, or suffocation due to a lack of oxygen in the surrounding area. You cannot cast Quen again until your current Quen shield has been exhausted or the duration ends.",
    "Raise Flame":
        "Raise Flame allows you to spread an existing fire at a speed of 2m per round in any direction, dull down a fire to a weak blaze (lowering the fire damage by 1), or intensify the fire (raising the fire damage by 1).",
    "Rhewi":
        "Rhewi creates a thick layer of ice around a target for the duration of the spell. The target is treated as frozen. If used on a non-living target, the target cannot to be manipulated or moved.",
    "Rhwystr Graig":
        "Rhwystr Graig allows you to create a 2m by 3m rock wall with 30 points of SP anywhere within 10m with any facing. This wall remains until destroyed.",
    "Seirff Haul":
        "SeirffHaul creates a number of serpents from fire magic that swarm over a target. The target is grappled and on fire until they make a Dodge/Escape check vs. your Spell Casting roll. Every round that the target fails the Dodge/Escape check, the DC rises by 1 point as the serpents tighten.",
    "Shape Nature":
        "Shape Nature allows you to create a golem from a small nearby tree. The golem serves you for the duration of the spell and will turn back into a tree when the duration ends. If killed, the golem only yields 2d10 units of timber. In all other ways, the tree acts as a normal golem.",
    "Sigil of the Hidden":
        "Drawing the Sigil of the Hidden covers a 3m area in branches, foliage, and other natural elements to provide complete visual cover. This grants you a +5 to Stealth, but immobilizes those inside and must be cast again to uncover yourself. You can cut away the brush by doing 10 points of damage to it.",
    "Song of the Sky":
        "The Song of the Sky changes the weather in the area directly around you. You can change the weather to: clear sky (no modifiers), cloudy (little sunlight), rainstorm (puts out fires), wind storm (-2 to DEX for ranged attacks), or lightning storm (35% chance of being struck by lightning, equivalent to the Lightning Storm spell).",
    "Stammelford's Earthquake":
        "Stammelford's Earthquake allows you to disrupt the ground in a 10m area and create a jagged, crumbling terrain which puts everyone in the area at a -2 to Reflex and a -3 to SPD. Small structures on the shattered ground have a 10% chance of collapsing. Each round, a creature in the spell's area must make an Athletics roll or sink into the crumbling ground, which causes them to suffocate until they make a successful Athletics check to climb out. After the duration of the spell ends, the ground stops churning but it will remain shattered.",
    "Standing Portal":
        "Standing Portal creates a 1m by 2m floating portal up to 10m from you. Stepping through this portal teleports you anywhere you can recall. The portal can transport anything that fits through it. If you end the portal while something is partially through, the portal slices the object (or creature) in two. The person is counted as being dismembered, as per the Critical Wound. You can create a portal to a location you don't know as per Teleportation.",
    "Static Storm":
        "Static Storm allows you to infuse a 5m radius centred around you with electricity. Anyone within this area (excluding you) who is wearing metal armor or carrying metal weapons takes 2 points of damage per round.",
    "Suffocate":
        "Suffocates a target for 1d10 damage per turn. The suffocation ends if the caster is struck with a weapon or stops focusing on the spell. While suffocating, a target is treated as staggered.",
    "Summon Staff":
        "Summon Staffallows you dematerialize your staffand transport it to a place you have been within the last day. You can cast the spell again to summon the staffback to you.",
    "Talfryn's Prison":
        "Talfryn's Prison is named for Talfryn of Nazair, a treacherous knight who was trapped for three days in the garden of the magician Drystan. The spell allows you to bind a target in roots. The roots take 15 points of damage to break. Otherwise a Dodge/Escape check must be made at a DC equal to your original Spell Casting roll to escape.",
    "Tanio Ilchar":
        "Tanio Ilchar creates a burst of fire in a 2m by 2m area. This has a 100% chance of lighting a target in the area on fire.",
    "Telekinesis":
        "Telekinesis allows you to liftand manipulate an object (up to 5 ENC per 1 point of Spell Casting) as though you were holding it.",
    "Telepathy":
        "Telepathy allows you to communicate telepathically with one subject for the duration of the spell. Telepathy crosses language barriers.",
    "Teleportation":
        "Teleportation allows you to teleport to a known location instantaneously. You cannot take anyone with you and can only transport the items on your person or in your hands. Attempting to teleport with a person simply teleports you and leaves them behind. Teleporting require a DC: 15 Spell Casting roll. If you fail the roll, you wind up in a random location 1d6 miles away.",
    "Threads of Life":
        "Threads of Life allows you to see the life energy binding every target within the radius of the spell, which tells you their current Health Points and any critical wounds they have suffered.",
    "Transmutation":
        "Transmutation allows you to change the properties of a mineral or metal. You can change one unit of metal into any other metal, or change an imperfect gem into a perfect gem suitable for magic. Dimeritium or other metals in contact with dimeritium cannot be created or changed by this spell.",
    "Tryferi Gaeaf":
        "Tryferi Gaeaf allows you to shoot a number of 2m spikes of ice equal to half your Spell Casting skill value at any number of targets within range. These spikes do 5d6 points of damage and, if they do damage through armor, freeze the opponent and do 2 point of damage each round until they are broken offwith a DC:20 Physique check or by doing 20 points of damage to them. Otherwise, these spikes last for the duration of the spell. Each attack resolves separately.",
    "Urien's Shelter":
        "Urien's Shelter, created by the nautical air magician Urien of Cidaris, allows you to negate hostile weather effects in an 8m radius centered on you. This negates extreme heat, extreme cold, rain, and snow.",
    "Vaults of Knowledge":
        "Vaults of Knowledge allows you to reach back into your mind and access any knowledge or memory that you've ever known as if you were just experiencing it.",
    "Waters of Clearance":
        "Waters of Clearance sobers the target immediately. This incantation counteracts alcohol and alchemical solutions that cause intoxication.",
    "Wave of Fire":
        "Wave of Fire shoots a 3m cone of fire in one direction that does 2d6 damage to anyone who isn't able to dodge or block, and has a 50% chance of igniting a target.",
    "Waves of the Naglfar":
        "Created by a mage who claimed to have witnessed the ride of the Wild Hunt, this spell creates a wave of ice magic that spreads out 3m from you in all directions. Anyone who doesn't dodge or block the spell is frozen and takes 4d6 damage.",
    "Web of Lies":
        "Web of Lies allows you to scramble the information in a target's head, making them question every piece of information and memory. This stuns the target. Once per round, on their turn, the target can roll 1d10. If they roll under their INT the effect ends.",
    "White Flame":
        "Summoning the power of the Great Sun, you create a bright aura of White Fire which lights the surrounding area to the level of bright light. This aura of fire doesn't burn anyone who touches it but does thaw anyone in the spell's area, and dispels water-based spells in the area. Water-based spells can only be cast in the area of the spell if the caster's Spell Casting check beats that of the Priest of the Great Sun. On top of this, any monster in the area that is vulnerable to sunlight takes double the normal penalties.",
    "Yrden":
        "Yrden creates a large magic circle on the ground around you. Anything that steps into that circle takes a negative to SPD and REF (equal to the number of STA you spent) until they exit the circle. Any incorporeal creatures that enter the circle become corporeal.",
    "Zephyr":
        "Zephyr allows you to shoot out a burst of wind that blasts anyone within 2m of you back 6m. This attack does only 1d6 damage, but if your opponent hits something they suffer ramming damage.",
});

/** The book's text for a spell, or null if it is not a core entry. */
export function describe(name) {
    return DESCRIPTIONS[name] ?? null;
}
