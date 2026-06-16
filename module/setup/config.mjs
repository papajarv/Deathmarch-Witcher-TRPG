/**
 * WITCHER — system-wide enumerable game data, attached to `CONFIG.WITCHER`
 * in main.mjs `init`. Modules and sheets read this for stat lists, skill
 * metadata, weapon hand options, status effects, item subtypes, etc.
 *
 * Phase 2 surface: just enough to satisfy what `docs/compatibility.md`
 * enumerates as system-API reads (skillMap, weapon.hands). The skill cost
 * multipliers default to 1; refine to Witcher canon values when porting
 * character advancement in Phase 7.
 */

export const SYSTEM_ID = "witcher-ttrpg-death-march";

/* The nine RAW primary stats (Core p.47). Order intentional: matches the
 * attribute grid layout reading left-to-right top-to-bottom. SPD and LUCK
 * are stats per RAW; only INT/REF/DEX/BODY/EMP/WILL/CRA have skills nested
 * under them in SKILL_MAP. */
export const STATS = Object.freeze([
    "int", "ref", "dex", "body", "spd", "emp", "will", "cra", "luck"
]);

/* Subset that has skill groups — used by the skills panel iteration to
 * skip empty SPD/LUCK groups. */
export const STATS_WITH_SKILLS = Object.freeze([
    "int", "ref", "dex", "body", "emp", "will", "cra"
]);

/* `homebrew` tags a skill as belonging to a homebrew subsystem (ADR 0003).
 * The schema field is ALWAYS present so the data doesn't churn when the GM
 * flips the toggle; renderers check the tag against `isHomebrewEnabled()` to
 * skip the row when the subsystem is off. Untagged skills are RAW and always
 * visible. */
const skill = (statKey, costMultiplier = 1, opts = {}) => Object.freeze({
    statKey,
    costMultiplier,
    ...(opts.homebrew ? { homebrew: opts.homebrew } : {})
});

/**
 * Map of skill key → metadata. The shape is { statKey, costMultiplier,
 * label, homebrew? }. The label is computed lazily by the consumer via
 * `WITCHER.skillLabel(key)` → resolves to an i18n key string.
 *
 * Source of truth for the 39-skill list (see docs/compatibility.md §2).
 */
export const SKILL_MAP = Object.freeze({
    awareness:     skill("int"),
    business:      skill("int"),
    deduction:     skill("int"),
    education:     skill("int"),
    commonspeech:  skill("int"),
    eldersp:       skill("int"),
    dwarven:       skill("int"),
    monster:       skill("int"),
    socialetq:     skill("int"),
    streetwise:    skill("int"),
    tactics:       skill("int"),
    teaching:      skill("int"),
    wilderness:    skill("int"),

    brawling:      skill("ref"),
    dodge:         skill("ref"),
    melee:         skill("ref"),
    riding:        skill("ref"),
    sailing:       skill("ref"),
    smallblades:   skill("ref"),
    staffspear:    skill("ref"),
    swordsmanship: skill("ref"),

    archery:       skill("dex"),
    athletics:     skill("dex"),
    crossbow:      skill("dex"),
    sleight:       skill("dex"),
    stealth:       skill("dex"),

    physique:      skill("body"),
    endurance:     skill("body"),

    charisma:      skill("emp"),
    deceit:        skill("emp"),
    finearts:      skill("emp"),
    gambling:      skill("emp"),
    grooming:      skill("emp"),
    perception:    skill("emp"),
    leadership:    skill("emp"),
    persuasion:    skill("emp"),
    performance:   skill("emp"),
    seduction:     skill("emp"),

    courage:       skill("will"),
    hexweave:      skill("will", 2),  /* Core p.49: difficult skill — ×2 IP/rank */
    intimidation:  skill("will"),
    spellcast:     skill("will", 2),
    resistmagic:   skill("will"),
    resistcoerc:   skill("will"),
    ritcraft:      skill("will", 2),

    alchemy:       skill("cra", 2),
    cooking:       skill("cra", 1, { homebrew: "foodAndDrink" }),
    crafting:      skill("cra"),
    disguise:      skill("cra"),
    firstaid:      skill("cra"),
    forgery:       skill("cra"),
    picklock:      skill("cra"),
    trapcraft:     skill("cra")
});

/* Weapon hand TRAIT — how many hands the weapon needs. The equip SLOT
 * (right/left/quick) is a separate concern decided when the weapon is
 * equipped (see WEAPON_SLOTS + chrome inventory.js). Labels run through
 * `localize` (input returned unchanged when no key matches). */
export const WEAPON_HANDS = Object.freeze({
    one: "WITCHER.Weapon.Hands.one",
    two: "WITCHER.Weapon.Hands.two"
});

/* Equip slots a weapon can occupy. Two-handed weapons take both Right and
 * Left at once (derived as "both" by chrome's conflict + dock logic); the
 * Quick slot only accepts quick items (system.quick) and shields. */
export const WEAPON_SLOTS = Object.freeze({
    right: "WITCHER.Weapon.Slot.right",
    left:  "WITCHER.Weapon.Slot.left",
    quick: "WITCHER.Weapon.Slot.quick"
});

/* Weapon attack style — drives template visibility (range / RoF show for
 * ranged + thrown; melee bonus damage applies to melee + thrown only,
 * Core p.48). */
export const WEAPON_TYPES = Object.freeze({
    melee:  "WITCHER.Weapon.TypeMelee",
    ranged: "WITCHER.Weapon.TypeRanged",
    thrown: "WITCHER.Weapon.TypeThrown"
});

/* Ammunition class — what a ranged weapon fires and what a projectile is.
 * A weapon only loads ammo whose `ammoType` matches its own (arrows go in
 * bows, bolts in crossbows). */
export const AMMO_TYPES = Object.freeze({
    arrow: "WITCHER.Ammo.TypeArrow",
    bolt:  "WITCHER.Ammo.TypeBolt"
});

/* Armor type — Core p.79. The light/medium/heavy distinction drives the
 * layering rule on p.154 ("max 1 heavy + 1 medium per location"). Shield
 * lives here too so it shares the same select on the item sheet. */
export const ARMOR_TYPES = Object.freeze({
    light:  "WITCHER.Armor.TypeLight",
    medium: "WITCHER.Armor.TypeMedium",
    heavy:  "WITCHER.Armor.TypeHeavy",
    shield: "WITCHER.Armor.TypeShield"
});

/* Shield size class — Core p.80-81. Drives the displayed sub-type; the
 * defensive profile (Reliability, EV, AE) lives on the shield item itself. */
export const SHIELD_CATEGORIES = Object.freeze({
    light:  "WITCHER.Shield.CategoryLight",
    medium: "WITCHER.Shield.CategoryMedium",
    heavy:  "WITCHER.Shield.CategoryHeavy"
});

/* Shield bash (Core p.164): a shield can attack as a bludgeoning, LETHAL melee
 * weapon. To-hit uses Melee; damage equals the wielder's Punch (Body table,
 * p.48) shifted UP by shield size — medium +2 levels, heavy +4 (each level is
 * +2 to the formula), capped at the table top (1d6+8). Light shields bash at
 * the bare Punch. */
export const SHIELD_BASH_LEVELS = Object.freeze({ light: 0, medium: 2, heavy: 4 });
export function shieldBashDamage(actor, shield) {
    const meleeBonus = Number(actor?.system?.derivedStats?.meleeBonus) || 0;
    const cat = shield?.system?.category || "medium";
    const levels = SHIELD_BASH_LEVELS[cat] ?? SHIELD_BASH_LEVELS.medium;
    const bonus = Math.min(meleeBonus + levels * 2, 8);
    return `1d6${bonus > 0 ? `+${bonus}` : bonus < 0 ? bonus : ""}`;
}

/* Enhancement kind — Core p.78-79 (gear runes/glyphs + craftsman mods).
 * `type` decides the host: rune/weapon → weapon, glyph/armor → armor
 * (see ENHANCEMENT_TARGET in data/item/enhancement.mjs). The label carries
 * the host side so the dropdown reads unambiguously. */
export const ENHANCEMENT_TYPES = Object.freeze({
    rune:   "WITCHER.Enhancement.TypeRune",
    weapon: "WITCHER.Enhancement.TypeWeaponMod",
    glyph:  "WITCHER.Enhancement.TypeGlyph",
    armor:  "WITCHER.Enhancement.TypeArmorMod"
});

/* Hit-location enum — Core p.152. An armor piece can cover one specific
 * location (Light Helmet → head) or a full coverage set. The per-location
 * stopping fields on the armor schema still drive aggregation; this enum
 * just labels the piece for player clarity + chrome integrations that
 * branch on location (e.g. shield detection at chrome/inventory.js:2105). */
export const ARMOR_LOCATIONS = Object.freeze({
    head:   "WITCHER.Armor.LocHead",
    torso:  "WITCHER.Armor.LocTorso",
    arms:   "WITCHER.Armor.LocArms",
    legs:   "WITCHER.Armor.LocLegs",
    full:   "WITCHER.Armor.LocFull",
    Shield: "WITCHER.Armor.LocShield"   // capital S preserved — chrome reads exactly this
});

/* Availability — common to weapons + armor + consumables (Core p.73, p.78). */
export const AVAILABILITY = Object.freeze({
    everywhere: "WITCHER.Gear.AvailEverywhere",
    common:     "WITCHER.Gear.AvailCommon",
    poor:       "WITCHER.Gear.AvailPoor",
    rare:       "WITCHER.Gear.AvailRare",
    witcher:    "WITCHER.Gear.AvailWitcher",
    na:         "WITCHER.Gear.AvailNA"
});

/* Diagram / formula tiers — every crafting diagram and alchemical
 * formula in the rulebook is grouped by these four levels (Core p.130,
 * p.146). Adds Grandmaster on top of the magic Novice/Journeyman/Master. */
export const DIAGRAM_LEVELS = Object.freeze({
    novice:      "WITCHER.Crafting.LevelNovice",
    journeyman:  "WITCHER.Crafting.LevelJourneyman",
    master:      "WITCHER.Crafting.LevelMaster",
    grandmaster: "WITCHER.Crafting.LevelGrandmaster"
});

/* Alchemical formula sub-types — drive the alchemy screen's section
 * grouping (chrome/crafting.js ALCHEMY_GROUPS). */
export const FORMULA_SUBTYPES = Object.freeze({
    potion:    "WITCHER.Crafting.SubPotion",
    oil:       "WITCHER.Crafting.SubOil",
    decoction: "WITCHER.Crafting.SubDecoction",
    bomb:      "WITCHER.Crafting.SubBomb"
});

/* Crafting diagram sub-types — drive the crafting screen's section
 * grouping (chrome/crafting.js CRAFTING_GROUPS). */
export const DIAGRAM_SUBTYPES = Object.freeze({
    weapon:              "WITCHER.Crafting.SubWeapon",
    "elderfolk-weapon":  "WITCHER.Crafting.SubElderfolkWeapon",
    armor:               "WITCHER.Crafting.SubArmor",
    "elderfolk-armor":   "WITCHER.Crafting.SubElderfolkArmor",
    "armor-enhancement": "WITCHER.Crafting.SubEnhancement",
    ammunition:          "WITCHER.Crafting.SubAmmunition",
    traps:               "WITCHER.Crafting.SubTraps",
    ingredients:         "WITCHER.Crafting.SubIngredients"
});

/* Cooking-recipe sub-types — homebrew food & drink. The screen group is
 * minimal for now; a GM can drop more entries here as a recipe library
 * grows. Recipes whose `type` is "" land in an unsorted bucket. */
export const RECIPE_SUBTYPES = Object.freeze({
    meal:   "WITCHER.Crafting.SubMeal",
    drink:  "WITCHER.Crafting.SubDrink",
    snack:  "WITCHER.Crafting.SubSnack"
});

/* Concealment levels per the weapon table's `Conc.` column. Stored as
 * the single-letter code; label expanded to the full word in the UI. */
export const CONCEALMENT = Object.freeze({
    T:     "Tiny",
    S:     "Small",
    L:     "Large",
    "N/A": "N/A"
});

/* Magic schools — Core p.99. Mixed covers spells that draw on more than
 * one element. Signs and invocations declare the same school as the
 * spell they parallel; in practice most witcher signs are mixed/elemental. */
export const SPELL_SCHOOLS = Object.freeze({
    earth: "WITCHER.Magic.SchoolEarth",
    air:   "WITCHER.Magic.SchoolAir",
    fire:  "WITCHER.Magic.SchoolFire",
    water: "WITCHER.Magic.SchoolWater",
    mixed: "WITCHER.Magic.SchoolMixed"
});

/* Spell form — distinguishes mage spell from witcher sign from priest
 * invocation. Sign STA cost caps at 7 per RAW p.115. */
export const SPELL_FORMS = Object.freeze({
    spell:      "WITCHER.Magic.FormSpell",
    sign:       "WITCHER.Magic.FormSign",
    invocation: "WITCHER.Magic.FormInvocation"
});

/* Spell tier — Core p.101 splits the list into Novice / Journeyman /
 * Master per Magic Training rank. */
export const SPELL_TIERS = Object.freeze({
    novice:     "WITCHER.Magic.TierNovice",
    journeyman: "WITCHER.Magic.TierJourneyman",
    master:     "WITCHER.Magic.TierMaster"
});

/* Targeting type — Core p.169. Direct = attack roll vs defense; Area =
 * defenders in the area each defend individually; Self = no defense. */
export const SPELL_TARGETS = Object.freeze({
    direct: "WITCHER.Magic.TargetDirect",
    area:   "WITCHER.Magic.TargetArea",
    self:   "WITCHER.Magic.TargetSelf"
});

/* How the target resists a spell — a MULTI-select (RAW writes "Dodge or
 * Block", so a spell can list more than one valid defense). The buckets
 * mirror the Core spell list (p.99-115) verbatim. "None" is the absence of
 * any defense, so it's represented by an empty selection rather than a
 * bucket; "Dodge or Block" is just both dodge + block checked. */
export const SPELL_DEFENSES = Object.freeze({
    dodge:        "WITCHER.Magic.DefenseDodge",
    block:        "WITCHER.Magic.DefenseBlock",
    resistmagic:  "WITCHER.Magic.DefenseResistMagic",
    spellcasting: "WITCHER.Magic.DefenseSpellCasting",
    gm:           "WITCHER.Magic.DefenseGM"
});

/* Spell effect-duration units, structured {value, unit} so combat can
 * decrement round-based spells. No "until lifted" (that's a hex). */
export const SPELL_DURATION_UNITS = Object.freeze({
    instant:   "WITCHER.Magic.DurInstant",
    rounds:    "WITCHER.Magic.DurRounds",
    minutes:   "WITCHER.Magic.DurMinutes",
    hours:     "WITCHER.Magic.DurHours",
    days:      "WITCHER.Magic.DurDays",
    months:    "WITCHER.Magic.DurMonths",
    years:     "WITCHER.Magic.DurYears",
    permanent: "WITCHER.Magic.DurPermanent"
});

/* Hex resolution data (Core p.120-122). Hexes are magic: a target resists
 * with Resist Magic, or the curse is unavoidable (None). */
export const HEX_DEFENSES = Object.freeze({
    resistmagic: "WITCHER.Hex.DefenseResistMagic",
    none:        "WITCHER.Hex.DefenseNone"
});

/* Duration units — combat decrements round-based hexes; "lifted" hexes
 * persist until the Lift Requirement is met. */
export const HEX_DURATION_UNITS = Object.freeze({
    instant: "WITCHER.Hex.DurInstant",
    rounds:  "WITCHER.Hex.DurRounds",
    minutes: "WITCHER.Hex.DurMinutes",
    hours:   "WITCHER.Hex.DurHours",
    days:    "WITCHER.Hex.DurDays",
    lifted:  "WITCHER.Hex.DurLifted"
});

/* Hex severity rating. */
export const HEX_DANGER = Object.freeze({
    low:    "WITCHER.Hex.DangerLow",
    medium: "WITCHER.Hex.DangerMedium",
    high:   "WITCHER.Hex.DangerHigh"
});

/* Ritual preparation-time units (Core p.116-119 — "5 Rounds", etc.). A
 * ritual's prep time is structured {value, unit} so the cast flow can
 * tie up the caster for the right span. */
export const RITUAL_TIME_UNITS = Object.freeze({
    rounds:  "WITCHER.Ritual.TimeRounds",
    minutes: "WITCHER.Ritual.TimeMinutes",
    hours:   "WITCHER.Ritual.TimeHours",
    days:    "WITCHER.Ritual.TimeDays"
});

/* Ritual effect-duration units. Unlike hexes there's no "until lifted";
 * a ritual either resolves immediately or persists (permanent). */
export const RITUAL_DURATION_UNITS = Object.freeze({
    instant:   "WITCHER.Ritual.DurInstant",
    rounds:    "WITCHER.Ritual.DurRounds",
    minutes:   "WITCHER.Ritual.DurMinutes",
    hours:     "WITCHER.Ritual.DurHours",
    days:      "WITCHER.Ritual.DurDays",
    permanent: "WITCHER.Ritual.DurPermanent"
});

/* Alchemical categories — Core pp.84-95. Each section has its own table:
 * potions p.84, oils p.86, decoctions p.87. Bombs are deliberately NOT an
 * alchemical subtype: a bomb is crafted from a formula/diagram but the
 * resulting item is a WEAPON, so it's authored on the weapon sheet, not here.
 * (The crafting wheel still detects bomb formulae/diagrams by their own type.)
 * Mutagens are a separate item type but listed here for the picker. */
export const ALCHEMICAL_TYPES = Object.freeze({
    potion:    "WITCHER.Alchemy.TypePotion",
    oil:       "WITCHER.Alchemy.TypeOil",
    decoction: "WITCHER.Alchemy.TypeDecoction",
    item:      "WITCHER.Alchemy.TypeItem",
    other:     "WITCHER.Alchemy.TypeOther"
});

/* Alchemical substances — Core p.143. The nine substances every formula
 * is built from; a crafting component either yields one of these (the
 * `isSubstance` flag + `substanceType` key on the component) or is a plain
 * crafting material. Keys are lower-case so they match the diagram's
 * `alchemyComponents` requirement map, which the crafting wheel compares
 * case-insensitively (see chrome/crafting.js `ingredientSubstance`). */
export const SUBSTANCES = Object.freeze({
    vitriol:    "WITCHER.Alchemy.SubstanceVitriol",
    rebis:      "WITCHER.Alchemy.SubstanceRebis",
    aether:     "WITCHER.Alchemy.SubstanceAether",
    quebrith:   "WITCHER.Alchemy.SubstanceQuebrith",
    hydragenum: "WITCHER.Alchemy.SubstanceHydragenum",
    vermilion:  "WITCHER.Alchemy.SubstanceVermilion",
    sol:        "WITCHER.Alchemy.SubstanceSol",
    caelum:     "WITCHER.Alchemy.SubstanceCaelum",
    fulgur:     "WITCHER.Alchemy.SubstanceFulgur"
});

/* Substance iconography — book-faithful SVG badge per substance (Core p.143),
 * rendered as an <img> wherever a substance appears (crafting wheel, item
 * sheets, inventory inspector) so it reads the same everywhere. The disc
 * colour is baked into the SVG; the glyph is a transparent cut-out. */
export const SUBSTANCE_ART = Object.freeze(Object.fromEntries(
    Object.keys(SUBSTANCES).map(k => [k, `systems/${SYSTEM_ID}/assets/icons/substances/${k}.svg`])
));

/* Damage type — Core p.72 / p.153. Slashing / Piercing / Bludgeoning are
 * physical; the energy types (Fire / Lightning / Cold / Acid) replace the
 * old catch-all "elemental" so a creature can react to each distinctly
 * (e.g. a golem immune to fire but vulnerable to lightning).
 * Weapons can have MULTIPLE damage types (e.g. a flaming sword: slashing
 * + fire). Schema stores as array of keys; UI = multi-checkbox. */
export const DAMAGE_TYPES = Object.freeze({
    slashing:    "WITCHER.Damage.Slashing",
    piercing:    "WITCHER.Damage.Piercing",
    bludgeoning: "WITCHER.Damage.Bludgeoning",
    fire:        "WITCHER.Damage.Fire",
    lightning:   "WITCHER.Damage.Lightning",
    cold:        "WITCHER.Damage.Cold",
    acid:        "WITCHER.Damage.Acid"
});

/* Weapon skills — subset of SKILL_MAP that's a valid weapon-attack skill.
 * Used to filter the "Attack Skill" picker on the weapon sheet so the
 * user can't accidentally tag a sword with Awareness or Persuasion. */
export const WEAPON_SKILL_KEYS = Object.freeze([
    "brawling",      // REF — fists / improvised
    "smallblades",   // REF — daggers, short swords
    "swordsmanship", // REF — longswords, sabres
    "staffspear",    // REF — staves, polearms
    "melee",         // REF — generic melee fallback
    "archery",       // DEX — bows
    "crossbow",      // DEX — crossbows
    "athletics"      // DEX — thrown weapons
]);

/* The in-hand (melee) skills — a thrown weapon used in melee mode rolls one of
 * these (see WeaponData.meleeSkillKey + the attack card's mode toggle). Excludes
 * the ranged/thrown skills (archery / crossbow / athletics). */
export const MELEE_SKILL_KEYS = Object.freeze([
    "brawling", "smallblades", "swordsmanship", "staffspear", "melee"
]);

/* ── Attack resolution — hit locations, strike types, situational mods ───
 * Drives the weapon-attack dialog (applications/attackDialog.mjs) and the
 * roll math in weaponAttackMixin. Numbers follow the published combat tables
 * (Core p.152 aimed-strike penalties / location multipliers; p.165-166
 * attack-modifier list) as encoded by the prior system, so migrated worlds
 * stay consistent. To-hit penalty + damage multiplier per called location;
 * a per-actor `system.derivedStats.aimMod` shifts every penalty (+ = easier). */
export const ATTACK_LOCATIONS = Object.freeze({
    head:     { labelKey: "WITCHER.Attack.LocHead",     penalty: -6, mult: 3   },
    torso:    { labelKey: "WITCHER.Attack.LocTorso",    penalty: -1, mult: 1   },
    rightArm: { labelKey: "WITCHER.Attack.LocRightArm", penalty: -3, mult: 0.5 },
    leftArm:  { labelKey: "WITCHER.Attack.LocLeftArm",  penalty: -3, mult: 0.5 },
    rightLeg: { labelKey: "WITCHER.Attack.LocRightLeg", penalty: -2, mult: 0.5 },
    leftLeg:  { labelKey: "WITCHER.Attack.LocLeftLeg",  penalty: -2, mult: 0.5 },
    tailWing: { labelKey: "WITCHER.Attack.LocTailWing", penalty:  0, mult: 0.5 }  // monsters only
});

/* d10 → location range tables (Core p.152). `max` is the inclusive top of
 * each die band; the first row whose max ≥ roll wins. Humans have two arms,
 * monsters fold arms into the torso band and add a tail/wing slot. */
export const RANDOM_LOCATION = Object.freeze({
    human: [
        { max: 1,  loc: "head"     },
        { max: 4,  loc: "torso"    },
        { max: 5,  loc: "rightArm" },
        { max: 6,  loc: "leftArm"  },
        { max: 8,  loc: "rightLeg" },
        { max: 10, loc: "leftLeg"  }
    ],
    monster: [
        { max: 1,  loc: "head"     },
        { max: 5,  loc: "torso"    },
        { max: 7,  loc: "rightLeg" },
        { max: 9,  loc: "leftLeg"  },
        { max: 10, loc: "tailWing" }
    ]
});

/* Roll a random hit location on the human/monster table. Returns the
 * location key (e.g. "torso") plus the d10 face that produced it. */
export async function rollHitLocation(kind = "human") {
    const table = RANDOM_LOCATION[kind] ?? RANDOM_LOCATION.human;
    const roll  = await new Roll("1d10").evaluate();
    const face  = roll.total;
    const row   = table.find(r => face <= r.max) ?? table[table.length - 1];
    return { loc: row.loc, face };
}

/* Strike types. Bows may pick strong/fast; crossbows are normal-only; melee
 * gets normal/strong/fast (user spec). `toHit` is the attack modifier,
 * `dmgMult` scales damage, `attacks` is how many rolls the strike makes.
 *
 * The Special Attacks (Core p.163) are MELEE-ONLY entries flagged `meleeOnly`
 * — the dialog only offers them for melee weapons, under a "Special Attacks"
 * optgroup. They are LIGHT-mechanized: the to-hit / damage math is applied,
 * and a `note` (i18n key) is surfaced on the chat card describing the rider
 * effect the GM/players resolve by hand. Extra flags: `noDamage` suppresses
 * the damage line, `nonLethal` tags the damage non-lethal, `fullRound` marks
 * a full-round cost, `offhand` requires picking a second (off-hand) weapon —
 * Joint Attack (Dual Wielding, Core p.163) rolls the off-hand weapon as the
 * second attack, both at -3. */
export const STRIKE_TYPES = Object.freeze({
    normal: { labelKey: "WITCHER.Attack.StrikeNormal", toHit:  0, dmgMult: 1, attacks: 1, note: "WITCHER.Attack.NoteNormal" },
    strong: { labelKey: "WITCHER.Attack.StrikeStrong", toHit: -3, dmgMult: 2, attacks: 1, note: "WITCHER.Attack.NoteStrong" },
    fast:   { labelKey: "WITCHER.Attack.StrikeFast",   toHit:  0, dmgMult: 1, attacks: 2, note: "WITCHER.Attack.NoteFast" },
    charge: { labelKey: "WITCHER.Attack.StrikeCharge", toHit: -3, dmgMult: 2, attacks: 1, meleeOnly: true, fullRound: true, note: "WITCHER.Attack.NoteCharge" },
    pommel: { labelKey: "WITCHER.Attack.StrikePommel", toHit:  0, dmgMult: 0.5, attacks: 1, meleeOnly: true, nonLethal: true, note: "WITCHER.Attack.NotePommel" },
    disarm: { labelKey: "WITCHER.Attack.StrikeDisarm", toHit:  0, dmgMult: 1, attacks: 1, meleeOnly: true, noDamage: true, note: "WITCHER.Attack.NoteDisarm" },
    trip:   { labelKey: "WITCHER.Attack.StrikeTrip",   toHit:  0, dmgMult: 1, attacks: 1, meleeOnly: true, noDamage: true, note: "WITCHER.Attack.NoteTrip" },
    feint:  { labelKey: "WITCHER.Attack.StrikeFeint",  toHit:  0, dmgMult: 1, attacks: 1, meleeOnly: true, firstRollSkill: "deceit", noDamage: true, note: "WITCHER.Attack.NoteFeint" },
    joint:  { labelKey: "WITCHER.Attack.StrikeJoint",  toHit: -3, dmgMult: 1, attacks: 2, meleeOnly: true, offhand: true, note: "WITCHER.Attack.NoteJoint" }
});

/* ── Unarmed / brawling combat (Core p.159-160 "Fist Fighting" + grappling) ──
 * Drives applications/brawlDialog.mjs + documents/mixins/brawlMixin.mjs. Every
 * brawl action rolls REF + Brawling to hit and deals NON-LETHAL damage. The
 * grapple riders are LIGHT-mechanized (match the special attacks): the roll is
 * made and a status is applied to the target where trivial, while the opposed
 * Dodge/Escape contest is resolved by the GM (see each `note`).
 *
 *   kind     "attack"  to-hit + (usually) damage from the actor's derived
 *                      Punch/Kick formula
 *            "grapple" to-hit vs the target's Dodge/Escape; no weapon damage
 *                      (Throw is the exception); applies `status`
 *            "defense" the block — rolls Brawling as a defensive reaction
 *   damage      "punch" | "kick" | null  which derived formula to roll
 *   strikes     true → offers normal/strong/fast strike variants (punch/kick)
 *   location    true → offers a hit-location / called shot
 *   half        true → only half damage (push kick)
 *   fixedLoc    a location key the action forces (push kick → torso)
 *   forceStrike a strike key the action locks to (charge → strong)
 *   toHit       a flat to-hit step the action always carries (charge -3)
 *   fullRound   true → costs a full round
 *   status      status id applied to the target on a hit
 *   needsGrapple true → presumes the target is already grappled
 *   note        i18n key describing the rider effect (card + dialog info box) */
export const BRAWL_ACTIONS = Object.freeze({
    block:    { labelKey: "WITCHER.Brawl.Block",    kind: "defense", note: "WITCHER.Brawl.NoteBlock" },
    punch:    { labelKey: "WITCHER.Brawl.Punch",    kind: "attack",  damage: "punch", strikes: true, location: true, note: "WITCHER.Brawl.NotePunch" },
    kick:     { labelKey: "WITCHER.Brawl.Kick",     kind: "attack",  damage: "kick",  strikes: true, location: true, note: "WITCHER.Brawl.NoteKick" },
    pushKick: { labelKey: "WITCHER.Brawl.PushKick", kind: "attack",  damage: "punch", half: true, fixedLoc: "torso", note: "WITCHER.Brawl.NotePushKick" },
    charge:   { labelKey: "WITCHER.Brawl.Charge",   kind: "attack",  damage: "punch", forceStrike: "strong", fullRound: true, note: "WITCHER.Brawl.NoteCharge" },
    disarm:   { labelKey: "WITCHER.Brawl.Disarm",   kind: "grapple", note: "WITCHER.Brawl.NoteDisarm" },
    grapple:  { labelKey: "WITCHER.Brawl.Grapple",  kind: "grapple", status: "grappled", note: "WITCHER.Brawl.NoteGrapple" },
    pin:      { labelKey: "WITCHER.Brawl.Pin",      kind: "grapple", status: "pinned", needsGrapple: true, note: "WITCHER.Brawl.NotePin" },
    choke:    { labelKey: "WITCHER.Brawl.Choke",    kind: "grapple", status: "suffocation", needsGrapple: true, note: "WITCHER.Brawl.NoteChoke" },
    throw:    { labelKey: "WITCHER.Brawl.Throw",    kind: "grapple", damage: "punch", status: "prone", needsGrapple: true, note: "WITCHER.Brawl.NoteThrow" },
    trip:     { labelKey: "WITCHER.Brawl.Trip",     kind: "grapple", status: "prone", note: "WITCHER.Brawl.NoteTrip" }
});

/* Display grouping for the brawl dialog's action picker. Order is the order
 * shown; `block` lives in its own group last. */
export const BRAWL_GROUPS = Object.freeze([
    { labelKey: "WITCHER.Brawl.GroupStrikes", actions: ["punch", "kick", "pushKick"] },
    { labelKey: "WITCHER.Brawl.GroupSpecial", actions: ["charge", "disarm"] },
    { labelKey: "WITCHER.Brawl.GroupGrapple", actions: ["grapple", "pin", "choke", "throw", "trip"] },
    { labelKey: "WITCHER.Brawl.GroupDefense", actions: ["block"] }
]);

/* Extra action (Core p.152): a second action this turn at -3 to hit, costing
 * 3 STA. The STA spend routes through combatRoundMixin.spendStamina. */
export const EXTRA_ACTION = Object.freeze({ toHit: -3, staCost: 3 });

/* Situational attack modifiers (Core p.165-166). Each is a toggle on the
 * attack dialog. `mod` is the to-hit step; `rangedMod` (when present) is the
 * value used instead for ranged/thrown weapons (prone target helps melee but
 * hurts ranged). `rangedOnly` hides the toggle for melee. `group:"range"`
 * entries are mutually exclusive (a single range bracket). */
export const ATTACK_MODIFIERS = Object.freeze([
    { value: "ambush",        labelKey: "WITCHER.Attack.ModAmbush",      mod:  5 },
    { value: "pinned",        labelKey: "WITCHER.Attack.ModPinned",      mod:  4 },
    { value: "silhouetted",   labelKey: "WITCHER.Attack.ModSilhouetted", mod:  2 },
    { value: "hiddenAttacker",labelKey: "WITCHER.Attack.ModHidden",      mod:  3 },
    { value: "proneTarget",   labelKey: "WITCHER.Attack.ModProneTarget", mod:  2, rangedMod: -2 },
    { value: "blindedTarget", labelKey: "WITCHER.Attack.ModBlinded",     mod: -3 },
    { value: "dodgingTarget", labelKey: "WITCHER.Attack.ModDodging",     mod: -2 },
    { value: "attackerMoving",labelKey: "WITCHER.Attack.ModMoving",      mod: -3 },
    { value: "attackerProne", labelKey: "WITCHER.Attack.ModAttackerProne", mod: -2 },
    { value: "movingTarget",  labelKey: "WITCHER.Attack.ModMovingTarget", mod: -3, rangedOnly: true }
]);

/* Range brackets — mutually exclusive, ranged/thrown only (Core p.165 table).
 * `frac` is the distance as a fraction of the weapon's listed range, used to
 * label each band with its real reach (point-blank is a fixed ≤0.5 m, so it
 * has no fraction). `dc` is the unaware/inanimate target DC (Core p.165).
 * `mod` is the to-hit step. Fast-draw/point-blank are no longer separate
 * toggles — point-blank is a band here. */
export const RANGE_BRACKETS = Object.freeze([
    { value: "pointBlank", labelKey: "WITCHER.Attack.RangePointBlank", mod:  5, frac: null, dc: 10 },
    { value: "close",      labelKey: "WITCHER.Attack.RangeClose",      mod:  0, frac: 0.25, dc: 15 },
    { value: "medium",     labelKey: "WITCHER.Attack.RangeMedium",     mod: -2, frac: 0.5,  dc: 20 },
    { value: "long",       labelKey: "WITCHER.Attack.RangeLong",       mod: -4, frac: 1,    dc: 25 },
    { value: "extreme",    labelKey: "WITCHER.Attack.RangeExtreme",    mod: -6, frac: 2,    dc: 30 }
]);

/* Opponent size modifiers (Core p.164 "Size Modifiers"). The book lists these
 * as a target-DC augment (Small +2 … Huge −4 — small things are harder to
 * hit); from the attacker's roll perspective the sign flips, which is what is
 * stored here (Small −2 … Huge +4). RAW this augments ONLY the static target
 * DC of an unaware/inanimate RANGED target (Core p.164) — never melee, never an
 * aware (opposed-defense) target. The attack dialog gates it accordingly. */
export const SIZE_MODIFIERS = Object.freeze([
    { value: "medium", labelKey: "WITCHER.Attack.SizeMedium", mod:  0 },
    { value: "small",  labelKey: "WITCHER.Attack.SizeSmall",  mod: -2 },
    { value: "large",  labelKey: "WITCHER.Attack.SizeLarge",  mod:  2 },
    { value: "huge",   labelKey: "WITCHER.Attack.SizeHuge",   mod:  4 }
]);

/* Max bonus from aiming — +1 per turn spent aiming, capped here (Core RAW). */
export const AIM_BONUS_PER_TURN = 1;
export const AIM_BONUS_CAP = 3;

/* ── Monster taxonomy (Core pp.268-270) ──────────────────────────────────
 * Monster category. Humanoids + Beasts are "not technically monsters" per
 * RAW (no silver vulnerability / steel resistance) but live in the same
 * stat-block. */
export const MONSTER_TYPES = Object.freeze({
    humanoid:   "WITCHER.MonsterType.Humanoid",
    beast:      "WITCHER.MonsterType.Beast",
    necrophage: "WITCHER.MonsterType.Necrophage",
    specter:    "WITCHER.MonsterType.Specter",
    cursedOne:  "WITCHER.MonsterType.CursedOne",
    hybrid:     "WITCHER.MonsterType.Hybrid",
    insectoid:  "WITCHER.MonsterType.Insectoid",
    elementa:   "WITCHER.MonsterType.Elementa",
    relict:     "WITCHER.MonsterType.Relict",
    ogroid:     "WITCHER.MonsterType.Ogroid",
    draconid:   "WITCHER.MonsterType.Draconid",
    vampire:    "WITCHER.MonsterType.Vampire"
});

/* Danger rating — two independent axes (Core p.268): how hard to kill, and
 * how much prep/knowledge a fight demands. */
export const MONSTER_THREAT = Object.freeze({
    easy:   "WITCHER.Monster.Threat.Easy",
    medium: "WITCHER.Monster.Threat.Medium",
    hard:   "WITCHER.Monster.Threat.Hard"
});
export const MONSTER_COMPLEXITY = Object.freeze({
    simple:    "WITCHER.Monster.Complexity.Simple",
    complex:   "WITCHER.Monster.Complexity.Complex",
    difficult: "WITCHER.Monster.Complexity.Difficult"
});

/* Per damage type, a monster is normal / resistant / vulnerable / immune.
 * Feeds the (future) combat engine's damage-resolution step; for now it's
 * authored data + a readable display. */
export const DAMAGE_REACTIONS = Object.freeze({
    none:       "WITCHER.Monster.React.None",
    resistant:  "WITCHER.Monster.React.Resistant",
    vulnerable: "WITCHER.Monster.React.Vulnerable",
    immune:     "WITCHER.Monster.React.Immune"
});

/* Weapon qualities — canonical "Weapon Effects" list from the Witcher
 * TRPG Core Rulebook (Weapon Effects sidebar; weapons table on p.73
 * references these by name).
 *
 * Each entry is `key → { label, description, param? }`. Descriptions are
 * paraphrased mechanical summaries in my own words — the rulebook
 * prose is copyrighted and is intentionally NOT reproduced here.
 *
 * Parameterized qualities carry a `param` slot describing the inline
 * value the player fills in (the % for Bleeding, the dice formula for
 * Silver, the integer for Focus / Stun). Storage lives in a sibling
 * map on the document: `system.qualityValues = { silver: "2d6", … }`.
 * The display tooltip renders parameterized qualities as `Label(value)`. */
const wq = (label, description, param = null) => Object.freeze({
    label, description, param: param ? Object.freeze(param) : null
});
export const WEAPON_QUALITIES = Object.freeze({
    ablating:              wq("Ablating",                "Penetrating hits chip stopping power off armor (1d6/2 SP damage)."),
    armorPiercing:         wq("Armor Piercing",          "Ignores the target armor's damage resistance."),
    improvedArmorPiercing: wq("Improved Armor Piercing", "Ignores damage resistance AND halves the armor's SP on hit."),
    balanced:              wq("Balanced",                "Better criticals: roll 2d6+2 (or 1d6+1 if aimed) for severity."),
    bleeding:              wq("Bleeding",                "On damage, chance to inflict Bleeding (see Status Effects).",
                              { type: "percent", placeholder: "25", suffix: "%" }),
    brawling:              wq("Brawling",                "Uses Brawling skill; adds weapon damage to unarmed strikes."),
    charging:              wq("Charging",                "Used from a mount in motion: add 1d6 bonus damage per meter charged, rather than the usual half."),
    concealment:           wq("Concealment",             "+2 to checks made to conceal this weapon on your person."),
    knockdown:             wq("Knock-Down",              "On a damaging hit, chance to knock the target prone.",
                              { type: "percent", placeholder: "50", suffix: "%" }),
    disease:               wq("Disease",                 "On a damaging hit, chance to inflict the Disease condition (see Status Effects).",
                              { type: "percent", placeholder: "25", suffix: "%" }),
    crushingForce:         wq("Crushing Force",          "Cannot be parried; inflicts double ablation on weapons, shields, and armor."),
    fire:                  wq("Fire",                    "On a damaging hit, chance to set the target alight (see Burning status).",
                              { type: "percent", placeholder: "25", suffix: "%" }),
    focus:                 wq("Focus",                   "Casting through this weapon reduces STA cost by its Focus value.",
                              { type: "number", placeholder: "1" }),
    freeze:                wq("Freeze",                   "On a damaging hit, chance to chill the target solid (see Frozen status).",
                              { type: "percent", placeholder: "25", suffix: "%" }),
    grappling:             wq("Grappling",               "Can be used to grapple and trip opponents in reach."),
    entangling:            wq("Entangling",              "On a hit the target is entangled: -5 SPD and -2 to all physical actions; each turn a DC 18 Dodge/Escape or Contortionist check breaks free, or an ally may spend an action to remove it."),
    magicalAnchoring:      wq("Magically Anchoring",     "While a creature touches the weapon it cannot turn invisible or intangible or teleport away; any already invisible or intangible creature is forced visible and solid."),
    bladeCatcher:          wq("Blade Catcher",           "When you block a melee attack with it, both weapons lock together and are useless until the attacker beats your Small Blades check with a Physique or Sleight of Hand check, or you let go."),
    crewReload:            wq("Crew Reload",             "Reloading takes 2 actions, which two people may split between them."),
    mounted:               wq("Mounted",                 "Fixed in place; it must be set up before use and packed away (an action each) before it can be moved."),
    injector:              wq("Injector",                "Can be charged (an action) with a dose of poison or elixir; a damaging hit drives the dose deep, making a poison 3 harder to resist or an elixir last 3 rounds longer."),
    greaterFocus:          wq("Greater Focus",           "Spells cast through this weapon treat DC as +2."),
    longReach:             wq("Long Reach",              "Strikes targets up to 2m away."),
    meteorite:             wq("Meteorite",               "Full damage vs meteorite-vulnerable monsters; +5 Reliability."),
    nonLethal:             wq("Non-Lethal",              "Deals non-lethal damage with no normal penalty."),
    parrying:              wq("Parrying",                "Parrying with this weapon lowers the parry penalty by 2."),
    poison:                wq("Poison",                   "On a damaging hit, chance to envenom the target (see Poisoned status).",
                              { type: "percent", placeholder: "25", suffix: "%" }),
    silver:                wq("Silver",                  "Counts as silver vs monster resistances; deals the listed damage formula when used as a silver attack.",
                              { type: "text", placeholder: "2d6" }),
    slowReload:            wq("Slow Reload",             "Takes a 1-action reload between shots."),
    stagger:               wq("Stagger",                 "On a damaging hit, chance to knock the target off-balance (see Staggered status).",
                              { type: "percent", placeholder: "25", suffix: "%" }),
    stun:                  wq("Stun",                    "Head/torso hits force a Stun save at the listed penalty.",
                              { type: "text", placeholder: "-2" })
});

/* Armor qualities — the Core Rulebook armor section doesn't have a
 * general "armor effects" sidebar parallel to weapons. The only named
 * effects defined in the armor pages are the two below, mentioned in
 * per-piece sidebars on the helmets and shields pages. Other armor
 * mods (resistances, enhancements) are handled by separate item types
 * (enhancements / runestones) rather than qualities.
 *
 * Descriptions are paraphrased mechanical summaries in my own words. */
export const ARMOR_QUALITIES = Object.freeze({
    restrictedVision: wq("Restricted Vision", "With the visor down, vision narrows to a forward cone; witchers lose their Awareness bonus and Scent Tracking."),
    fullCover:        wq("Full Cover",        "Pavise-sized; can be crouched behind for full cover. Incoming hits must exceed the shield's Reliability before reaching the wielder, and each hit removes 1 SP."),
    // Witcher school-armor critical triggers (DLC: Witcher's Tools).
    criticalDecimation:   wq("Critical Decimation",   "When you score a critical wound with a witcher weapon, treat it as one tier more severe (a Simple critical becomes Complex, and so on)."),
    criticalFlurry:       wq("Critical Flurry",       "When you score a critical wound with a witcher weapon, immediately attempt a Disarm or Trip at no extra penalty and without spending extra Stamina."),
    criticalSpellcasting: wq("Critical Spellcasting", "When you score a critical wound with a witcher weapon, immediately make a Spellcasting check to cast a Sign at no extra penalty and without spending Stamina beyond the Sign's own cost."),
    criticalBlock:        wq("Critical Block",        "When you beat an attacker by more than 4 on a Block or Parry with your Manticore shield, immediately make a Shield Strike that knocks them back 4m and prone, at no extra penalty or Stamina."),
    criticalRiposte:      wq("Critical Riposte",      "When you beat an attacker by more than 4 on a Parry with a witcher weapon, immediately Strike with a held weapon at no extra penalty or Stamina."),
    criticalMomentum:     wq("Critical Momentum",     "When you score a critical wound with a witcher weapon, immediately make a single Strike with a held weapon at no extra penalty or Stamina.")
});

/**
 * Homebrew toggle enumeration (ADR 0003). Each entry becomes a world
 * setting registered in settings.mjs. Runtime code checks via
 * `isHomebrewEnabled(key)` from api/homebrew.mjs.
 *
 * Defaults are ON: migrating users of the existing overhaul-ui stack
 * expect these mechanics to work. Pure-RAW users opt out in settings.
 *
 * **Never gate schema on these — only behavior and UI.**
 */
/* `kind` sorts a toggle into the GM settings surface:
 *   - "content" → added subsystems/minigames; hidden from the main settings
 *     list and edited through the Homebrew Content menu (HomebrewContentEditor).
 *   - "rule"    → house-rule tweaks to core mechanics; shown inline in the
 *     main "Configure Settings" list. */
const homebrew = (defaultOn = true, kind = "content") => Object.freeze({ defaultOn, kind });

export const HOMEBREW = Object.freeze({
    bookSystem:        homebrew(),              // 3-type book mechanic on valuables
    stress:            homebrew(),              // stress counter on characters
    foodAndDrink:      homebrew(),              // food/drink charges + drunkenness
    extendedCombat:    homebrew(true,  "content"), // optional combat overhaul (guard stances etc.) — WIP; lives in the Homebrew Content menu
    farkleTable:       homebrew(),              // Farkle gambling table (GM-opened betting game)
    dicePokerTable:    homebrew(),              // Witcher dice poker table (GM-opened betting game)
    merchant:          homebrew(),              // merchant actor: shops, dynamic pricing, buy/sell
    // House rule, default OFF (RAW): when ON, movement may be split across the
    // turn and interleaved with actions up to total SPD; when OFF, all movement
    // must be taken before any action (acting forfeits remaining movement).
    splitMovement:     homebrew(false, "rule"),
    // RAW toxicity overdose (Core p.248), default ON: combined potion/decoction
    // toxicity over your cap inflicts the Overdosed status (poison-like DoT)
    // until it drops to cap or a DC 18 Endurance check purges the last potion.
    // OFF → toxicity is still tracked but never harms you (house-rule friendly).
    rawToxicity:       homebrew(true, "rule")
});

/* ── Active Effect editor — friendly targets + modes ──────────────────
 * Backs the custom ActiveEffect config sheet (WitcherActiveEffectConfig).
 * A Foundry effect "change" is a {key, type, value} triple where `key` is
 * a raw data path and `type` is an application mode. Non-technical users
 * can't be expected to know either, so the sheet surfaces them as
 * dropdowns driven by the data below. */

/* Plain-language application modes. Keys are Foundry's string change types
 * (CONST.ACTIVE_EFFECT_CHANGE_TYPES). `custom` is intentionally omitted —
 * it needs a programmatic handler and only confuses a manual editor. */
export const EFFECT_CHANGE_MODES = Object.freeze({
    add:       "Add / subtract (+/−)",
    override:  "Set to",
    multiply:  "Multiply by",
    upgrade:   "Raise to at least",
    downgrade: "Lower to at most"
});

/* ── Operation menu — the "what to do to the target" half of an action ──
 * Supersedes EFFECT_CHANGE_MODES for the rebuilt Effects tab. Each entry
 * maps to a native Foundry change `type` (so an "always" action compiles
 * into the engine) AND is interpreted directly by the event engine for
 * per-trigger mutations (applyOperation). `negate` flips the value sign so
 * "subtract" can ride the additive native mode. Ops without a `native`
 * mapping (none yet) would be event-only. */
export const EFFECT_OPERATIONS = Object.freeze([
    { value: "add",      labelKey: "WITCHER.Effect.OpAdd",      native: "add" },
    { value: "subtract", labelKey: "WITCHER.Effect.OpSubtract", native: "add", negate: true },
    { value: "set",      labelKey: "WITCHER.Effect.OpSet",      native: "override" },
    { value: "multiply", labelKey: "WITCHER.Effect.OpMultiply", native: "multiply" },
    { value: "atLeast",  labelKey: "WITCHER.Effect.OpAtLeast",  native: "upgrade" },
    { value: "atMost",   labelKey: "WITCHER.Effect.OpAtMost",   native: "downgrade" }
]);

export function effectOperationOptions() {
    const L = (k) => game.i18n.localize(k);
    return EFFECT_OPERATIONS.map(o => ({ value: o.value, label: L(o.labelKey) }));
}

/* Apply an operation to a numeric current value — the event engine's core
 * mutation step (per-trigger). Mirrors the native modes plus the friendly
 * "subtract" alias. Non-numeric inputs coerce to 0. */
export function applyOperation(current, op, value) {
    const c = Number(current) || 0;
    const v = Number(value)   || 0;
    switch (op) {
        case "subtract": return c - v;
        case "set":      return v;
        case "multiply": return c * v;
        case "atLeast":  return Math.max(c, v);
        case "atMost":   return Math.min(c, v);
        case "add":
        default:         return c + v;
    }
}

/* ── Trigger menu — the "when does this fire" half of an action ─────────
 * `mode` routes the action to a backend:
 *   passive → resolved at data-prep time. "always" compiles to a native
 *             change; "condition" applies the same change only while its
 *             condition expression is true (actor.prepareDerivedData).
 *   event   → fired by the tick / event engine and written to a persistent
 *             ledger scoped to the effect's lifetime (stacks per occurrence,
 *             reverted when the effect ends unless the row says permanent). */
export const EFFECT_TRIGGERS = Object.freeze([
    { value: "always",         labelKey: "WITCHER.Effect.WhenAlways",      mode: "passive" },
    { value: "condition",      labelKey: "WITCHER.Effect.WhenCondition",   mode: "passive" },
    // tick: re-applied to the SOURCE each turn by the tick engine (like heal),
    // gated by a heal-style per-turn condition (the action's `gate`). Dice
    // values are rolled fresh each turn. Distinct from the one-shot `event`
    // triggers below, which count into a revertible ledger.
    { value: "perTurn",        labelKey: "WITCHER.Effect.WhenPerTurn",     mode: "tick"  },
    { value: "eachTurn",       labelKey: "WITCHER.Effect.WhenEachTurn",    mode: "event" },
    { value: "roundStart",     labelKey: "WITCHER.Effect.WhenRoundStart",  mode: "event" },
    { value: "combatStart",    labelKey: "WITCHER.Effect.WhenCombatStart", mode: "event" },
    { value: "adrenalineGain", labelKey: "WITCHER.Effect.WhenAdrenaline",  mode: "event" },
    { value: "tookDamage",     labelKey: "WITCHER.Effect.WhenTookDamage",  mode: "event" },
    { value: "undamaged",      labelKey: "WITCHER.Effect.WhenUndamaged",   mode: "event" }
]);

export function effectTriggerOptions() {
    const L = (k) => game.i18n.localize(k);
    return EFFECT_TRIGGERS.map(o => ({ value: o.value, label: L(o.labelKey) }));
}

/* Lookup helpers for the engine / compiler. */
export const effectOperation = (op) => EFFECT_OPERATIONS.find(o => o.value === op) ?? null;
export const effectTrigger   = (w)  => EFFECT_TRIGGERS.find(t => t.value === w)   ?? null;

/* ── Per-turn tick option lists for the "Effects" tab ─────────────────
 * These feed the heal/damage action rows on the unified Effects tab
 * (templates/active-effect/effect-action.hbs). The tick engine
 * (module/chrome/policy/tick-effects.js) reads the resulting actions from
 * flags.<systemId>.actions[] each turn — locations from a damage action,
 * the heal condition from a heal action.
 *
 * Hit locations mirror the engine's TICK_LOCATIONS (Core p.152 multipliers).
 * Labels are localized at call time; the parenthetical damage multiplier is
 * baked in because it's a rules constant, not a translatable string. */
export const TICK_LOCATIONS = Object.freeze([
    { value: "everyLocation", labelKey: "WITCHER.Effect.LocEvery",         mult: "" },
    { value: "head",          labelKey: "WITCHER.Effect.LocHead",          mult: "×3" },
    { value: "torso",         labelKey: "WITCHER.Effect.LocTorso",         mult: "×1" },
    { value: "rightArm",      labelKey: "WITCHER.Effect.LocRightArm",      mult: "×½" },
    { value: "leftArm",       labelKey: "WITCHER.Effect.LocLeftArm",       mult: "×½" },
    { value: "rightLeg",      labelKey: "WITCHER.Effect.LocRightLeg",      mult: "×½" },
    { value: "leftLeg",       labelKey: "WITCHER.Effect.LocLeftLeg",       mult: "×½" },
    { value: "randomHuman",   labelKey: "WITCHER.Effect.LocRandomHuman",   mult: "" },
    { value: "randomMonster", labelKey: "WITCHER.Effect.LocRandomMonster", mult: "" }
]);

/* Heal-gate conditions for the Logic tab. The tick engine evaluates these
 * against per-round damage / adrenaline markers stamped on the actor
 * (see module/chrome/policy/tick-effects.js). "undamaged" is the Swallow
 * rule (Core p.85 — heals on your turn only if you took no damage that
 * round). Stored as the flag tickHealCondition; default "always". */
export const TICK_HEAL_CONDITIONS = Object.freeze([
    { value: "always",     labelKey: "WITCHER.Effect.HealCondAlways" },
    { value: "undamaged",  labelKey: "WITCHER.Effect.HealCondUndamaged" },
    { value: "damaged",    labelKey: "WITCHER.Effect.HealCondDamaged" },
    { value: "adrenaline", labelKey: "WITCHER.Effect.HealCondAdrenaline" }
]);

/* Localized heal-condition options for the Logic-tab <select>. */
export function tickHealConditionOptions() {
    const L = (k) => game.i18n.localize(k);
    return TICK_HEAL_CONDITIONS.map(o => ({ value: o.value, label: L(o.labelKey) }));
}

/* Localized location options for the Logic-tab <select>. */
export function tickLocationOptions() {
    const L = (k) => game.i18n.localize(k);
    return TICK_LOCATIONS.map(o => ({
        value: o.value,
        label: o.mult ? `${L(o.labelKey)} (${o.mult})` : L(o.labelKey)
    }));
}

/* Anything recomputed unconditionally in prepareDerivedData() runs AFTER the
 * "initial" effect phase, so a change targeting it is only durable in the
 * "final" phase (CONST CHANGE_PHASES = initial, final; final runs after
 * prepareDerivedData). phaseForKey() auto-assigns the phase from the chosen
 * target — recomputed keys → "final", everything else → "initial" (so stat
 * buffs still flow into the derived formulas). */
/* Pools — each has a current `.value` and a `.max`, exposed as TWO separate
 * targets so alchemy can either restore the current value (a healing potion)
 * OR raise the ceiling (a decoction that boosts max HP). The hp/sta maxes are
 * recomputed in prepareDerivedData, so changes to them must apply in the
 * "final" phase to survive; current values and the toxicity/luck caps are
 * player-set (never recomputed) and apply in "initial". */
export const POOL_TARGETS = Object.freeze([
    { key: "system.derivedStats.hp.value",  labelKey: "WITCHER.Effect.PoolHpCur",   phase: "initial" },
    { key: "system.derivedStats.hp.max",    labelKey: "WITCHER.Effect.PoolHpMax",   phase: "final"   },
    { key: "system.derivedStats.sta.value", labelKey: "WITCHER.Effect.PoolStaCur",  phase: "initial" },
    { key: "system.derivedStats.sta.max",   labelKey: "WITCHER.Effect.PoolStaMax",  phase: "final"   },
    { key: "system.stats.toxicity.value",   labelKey: "WITCHER.Effect.PoolToxCur",  phase: "initial" },
    { key: "system.stats.toxicity.max",     labelKey: "WITCHER.Effect.PoolToxMax",  phase: "initial" },
    { key: "system.stats.luck.value",       labelKey: "WITCHER.Effect.PoolLuckCur", phase: "initial" },
    { key: "system.stats.luck.max",         labelKey: "WITCHER.Effect.PoolLuckMax", phase: "initial" }
]);

export const DERIVED_STAT_TARGETS = Object.freeze([
    { key: "system.derivedStats.resolve",        labelKey: "WITCHER.Effect.DerivedResolve" },
    { key: "system.derivedStats.stun",           labelKey: "WITCHER.Effect.DerivedStun" },
    { key: "system.derivedStats.rec",            labelKey: "WITCHER.Effect.DerivedRec" },
    { key: "system.derivedStats.woundThreshold", labelKey: "WITCHER.Effect.DerivedWound" },
    { key: "system.derivedStats.enc",            labelKey: "WITCHER.Effect.DerivedEnc" },
    { key: "system.derivedStats.run",            labelKey: "WITCHER.Effect.DerivedRun" },
    { key: "system.derivedStats.leap",           labelKey: "WITCHER.Effect.DerivedLeap" },
    { key: "system.derivedStats.meleeBonus",     labelKey: "WITCHER.Effect.DerivedMelee" }
]);

/* Combat passives (system.combatMods.*) — AE-targetable school/profession traits. */
export const COMBAT_MOD_TARGETS = Object.freeze([
    { key: "system.combatMods.evTolerance",                  labelKey: "WITCHER.Effect.CmEvTolerance" },
    { key: "system.combatMods.startingAdrenaline",           labelKey: "WITCHER.Effect.CmStartAdr" },
    { key: "system.combatMods.calledShotReduction",          labelKey: "WITCHER.Effect.CmCalledShot" },
    { key: "system.combatMods.parryPenaltyReduction",        labelKey: "WITCHER.Effect.CmParry" },
    { key: "system.combatMods.extraActionPenaltyReduction",  labelKey: "WITCHER.Effect.CmExtraTohit" },
    { key: "system.combatMods.extraActionStaReduction",      labelKey: "WITCHER.Effect.CmExtraSta" },
    { key: "system.combatMods.strongStrikePenaltyReduction", labelKey: "WITCHER.Effect.CmStrong" },
    { key: "system.combatMods.chargePenaltyReduction",       labelKey: "WITCHER.Effect.CmCharge" },
    { key: "system.combatMods.offhandPenaltyReduction",      labelKey: "WITCHER.Effect.CmOffhand" },
    { key: "system.combatMods.fastDrawPenaltyReduction",     labelKey: "WITCHER.Effect.CmFastDraw" },
    { key: "system.combatMods.freeDefenses",                 labelKey: "WITCHER.Effect.CmFreeDef" },
    { key: "system.combatMods.flatAttackMod",                labelKey: "WITCHER.Effect.CmFlatAtk" },
    { key: "system.combatMods.flatDefenseMod",               labelKey: "WITCHER.Effect.CmFlatDef" },
    { key: "system.combatMods.shieldParryPenaltyReduction",  labelKey: "WITCHER.Effect.CmShieldParry" },
    { key: "system.combatMods.quickItemWithShield",          labelKey: "WITCHER.Effect.CmQuickWithShield" },
    { key: "system.combatMods.freeShieldEquip",              labelKey: "WITCHER.Effect.CmFreeShieldEquip" }
]);

const FINAL_PHASE_KEYS = new Set([
    ...DERIVED_STAT_TARGETS.map(o => o.key),
    ...POOL_TARGETS.filter(o => o.phase === "final").map(o => o.key)
]);

/* Apply `amount` damage to an hp pool, draining temporary HP first. Temp HP
 * is a non-regenerable buffer that soaks damage before real HP; healing never
 * refills it. Returns the new { value, temp } numbers to write (value clamped
 * at 0 — dying is decided by healthState, HP doesn't go negative in store). */
export function drainHp(hp, amount) {
    const temp0 = Math.max(0, Number(hp?.temp)  || 0);
    const val0  =            Number(hp?.value) || 0;
    const dmg   = Math.max(0, Number(amount)   || 0);
    const fromTemp = Math.min(temp0, dmg);
    return { temp: temp0 - fromTemp, value: Math.max(0, val0 - (dmg - fromTemp)) };
}

/* Which application phase a change targeting `key` must use to be durable.
 * Derived-stat keys → "final" (applied after prepareDerivedData); all other
 * keys → "initial" (the schema default; buffs propagate into formulas). */
export function phaseForKey(key) {
    return FINAL_PHASE_KEYS.has(key) ? "final" : "initial";
}

/* Flat, exhaustive list of every stat-ish data path an effect action can
 * target, for the rebuilt Effects tab's free-text Target field (backed by a
 * <datalist> so the user gets autocomplete but can still type any path).
 * Covers all 9 stat values, every skill's rank AND temp modifier, both pool
 * current/max pairs, the derived stats, damageBonus, the player-set
 * shield/vigor, adrenaline and toxicity. Localized at call time. */
export function effectTargetGroups() {
    const L = (k) => game.i18n.localize(k);
    // Each core stat is exposed twice: the UNBOUNDED `.modifier` (the usual
    // buff/debuff target — can take the prepared stat past the 1-10 cap) and
    // the `.value` base (clamped 1-10 by the schema, for set/override style
    // changes). luck is a pool — its value/max come from POOL_TARGETS.
    const stats = [];
    for (const s of STATS) {
        if (s === "luck") continue;
        const name = L(`WITCHER.StatName.${s}`);
        stats.push({ key: `system.stats.${s}.modifier`, label: `${name} — ${L("WITCHER.Effect.StatModSuffix")}` });
        stats.push({ key: `system.stats.${s}.value`,    label: `${name} — ${L("WITCHER.Effect.StatBaseSuffix")}` });
    }
    const skills = [];
    for (const [skillKey, meta] of Object.entries(SKILL_MAP)) {
        const name = L(`WITCHER.skills.${skillKey}.label`);
        skills.push({ key: `system.skills.${meta.statKey}.${skillKey}.value`,    label: `${name} — ${L("WITCHER.Effect.SkillRankSuffix")}` });
        skills.push({ key: `system.skills.${meta.statKey}.${skillKey}.modifier`, label: `${name} — ${L("WITCHER.Effect.SkillModSuffix")}` });
    }
    const pools   = POOL_TARGETS.map(o => ({ key: o.key, label: L(o.labelKey) }));
    const derived = [
        ...DERIVED_STAT_TARGETS.map(o => ({ key: o.key, label: L(o.labelKey) })),
        { key: "system.derivedStats.damageBonus", label: L("WITCHER.Effect.DerivedDamageBonus") },
        { key: "system.derivedStats.shield",      label: L("WITCHER.Effect.TargetShield") },
        { key: "system.derivedStats.vigor",       label: L("WITCHER.Effect.TargetVigor") },
        { key: "system.derivedStats.aimMod",      label: L("WITCHER.Effect.TargetAimMod") },
        { key: "system.adrenaline.value",         label: L("WITCHER.Effect.PoolAdrenaline") }
    ];
    const combat  = COMBAT_MOD_TARGETS.map(o => ({ key: o.key, label: L(o.labelKey) }));
    return [
        { label: L("WITCHER.Effect.GroupStats"),   options: stats },
        { label: L("WITCHER.Effect.GroupSkills"),  options: skills },
        { label: L("WITCHER.Effect.GroupPools"),   options: pools },
        { label: L("WITCHER.Effect.GroupDerived"), options: derived },
        { label: L("WITCHER.Effect.GroupCombat"),  options: combat }
    ];
}

/* Flat list of every targetable path — backs the Target field's <datalist>
 * autocomplete and the "browse all parameters" picker (which uses the grouped
 * form). Derived from effectTargetGroups so the two never drift. */
export function effectStatTargets() {
    return effectTargetGroups().flatMap(g => g.options);
}

/* ── Unified "Effects" action model ───────────────────────────────────
 * The AE editor presents ONE list of action rows; each row's `type` picks
 * a behavior. Actions persist as flags.<systemId>.actions[]. They route to
 * three backends by `kind`:
 *   modifier → compiled into native AE changes at prepare time
 *              (WitcherActiveEffect.prepareBaseData → compileActionsToChanges)
 *   event    → fired per turn by the tick engine (heal / damage)
 *   gate     → read in character.prepareDerivedData (suppress)
 *   oneshot  → fired once on createActiveEffect, reclaimed on delete (tempHp)
 * A modifier re-applies every data-prep cycle (idempotent); an event fires
 * once per turn — which is why heal/damage can't live in the change pipeline.
 * A oneshot grants a non-regenerable buffer once (take-higher) and is clawed
 * back when the effect is removed — see tick-effects grant/reclaim hooks. */
export const EFFECT_ACTION_TYPES = Object.freeze([
    { type: "modify",   labelKey: "WITCHER.Effect.ActionModify",   kind: "modifier" },
    { type: "heal",     labelKey: "WITCHER.Effect.ActionHeal",     kind: "event" },
    { type: "damage",   labelKey: "WITCHER.Effect.ActionDamage",   kind: "event" },
    { type: "tempHp",   labelKey: "WITCHER.Effect.ActionTempHp",   kind: "oneshot" },
    { type: "suppress", labelKey: "WITCHER.Effect.ActionSuppress", kind: "gate" },
    { type: "immunity", labelKey: "WITCHER.Effect.ActionImmunity", kind: "immunity" },
    { type: "purge",    labelKey: "WITCHER.Effect.ActionPurge",    kind: "purge" }
]);

export function effectActionTypeOptions() {
    const L = (k) => game.i18n.localize(k);
    return EFFECT_ACTION_TYPES.map(o => ({ value: o.type, label: L(o.labelKey) }));
}

/* What a suppress action can switch off. Labels reuse the Suppress* keys. */
export const SUPPRESS_TARGETS = Object.freeze([
    { value: "death", labelKey: "WITCHER.Effect.SuppressDeath" },
    { value: "wound", labelKey: "WITCHER.Effect.SuppressWound" }
]);

export function suppressTargetOptions() {
    const L = (k) => game.i18n.localize(k);
    return SUPPRESS_TARGETS.map(o => ({ value: o.value, label: L(o.labelKey) }));
}

/* Status ids an `immunity` action can grant immunity to: the registered status
 * effects minus the procedural-only markers (Aim ranks, Fast Draw). Labels are
 * the localized status names. Built at call time so GM clause renames show up. */
export function statusImmunityOptions() {
    const out = [];
    for (const s of (CONFIG.statusEffects ?? [])) {
        if (!s?.id || s.id === "fastDraw" || s.id === "aim" || /^aim-\d+$/.test(s.id)) continue;
        out.push({ value: s.id, label: s.name ? game.i18n.localize(s.name) : (s.label ?? s.id) });
    }
    return out;
}

/* Normalize a raw stored action row into the canonical shape the engine and
 * compiler consume. The rebuilt Effects tab persists rows as
 *   { type, target, op, value, when, condition, fireCap, lasts }
 * but older saves use { type, key, mode, value }; this folds the legacy
 * field names (key→target, mode→op) and supplies defaults so every consumer
 * can read a uniform object. Returns null for non-objects. */
/* Legacy `mode` stored Foundry's native change type (EFFECT_CHANGE_MODES);
 * the rebuilt tab uses the friendlier `op` vocabulary. Translate when only
 * the old field is present. */
const LEGACY_MODE_TO_OP = Object.freeze({
    add:       "add",
    override:  "set",
    multiply:  "multiply",
    upgrade:   "atLeast",
    downgrade: "atMost"
});

export function normalizeAction(a) {
    if (!a || typeof a !== "object") return null;
    const op = a.op ?? (a.mode != null ? (LEGACY_MODE_TO_OP[a.mode] ?? a.mode) : "add");
    return {
        type:      a.type ?? "modify",
        target:    a.target ?? a.key ?? "",
        op,
        value:     a.value ?? "",
        when:      a.when ?? "always",
        gate:      a.gate ?? "always",
        condition: a.condition ?? "",
        fireCap:   a.fireCap ?? "",
        lasts:     a.lasts ?? "untilEffectEnds"
    };
}

/* Coerce a stored action value to its runtime form: numeric-looking strings
 * become numbers (so an "override" of a numeric stat doesn't store a string),
 * everything else passes through. */
export function actionValue(value) {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (trimmed === "") return value;
    // A plain signed/unsigned number: a leading "+" (or no sign) is positive,
    // "-" is negative. JSON.parse THROWS on a leading "+", so handle the sign
    // ourselves — Number() accepts "+2", "-2", and "2".
    if (/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
    // Dice / formula (e.g. "1d6+2"): strip a leading "+" so the Roll parser
    // doesn't choke on it. Fall back to JSON.parse for other literals
    // (true / null / arrays), else pass the string through for evaluateSync.
    const stripped = trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;
    try { return JSON.parse(stripped); } catch { return stripped; }
}

/* Compile the passive `when:"always"` modifier actions of an effect into
 * native v14 change objects {key, type, value, phase, priority}, so Foundry's
 * own change engine applies them every prep cycle. Condition-gated and
 * event-triggered actions are handled elsewhere (actor.prepareDerivedData and
 * the tick/event engine respectively) and produce no changes here. The phase
 * is derived from the target key (derived stats need "final"; see
 * phaseForKey). Returns [] for missing / empty input. */
export function compileActionsToChanges(actions) {
    if (!Array.isArray(actions)) return [];
    const out = [];
    for (const raw of actions) {
        const a = normalizeAction(raw);
        if (!a || a.type !== "modify" || !a.target || a.when !== "always") continue;
        const op = effectOperation(a.op);
        if (!op?.native) continue;
        let value = actionValue(a.value);
        // "subtract" rides the additive native mode by negating the value.
        // A number flips sign directly; a dice/formula string is wrapped so
        // its rolled total is subtracted (e.g. "1d6" → "-(1d6)").
        if (op.negate) {
            if (typeof value === "number") value = -value;
            else if (typeof value === "string" && value.trim() !== "") value = `-(${value})`;
        }
        out.push({
            key: a.target,
            type: op.native,
            value,
            phase: phaseForKey(a.target),
            priority: null
        });
    }
    return out;
}

/* ── Condition expression evaluator (eval-free) ───────────────────────
 * Powers the `when:"condition"` trigger and any threshold-style rule. A
 * recursive-descent parser over a tiny grammar:
 *   or  → and ("or" and)*
 *   and → cmp ("and" cmp)*
 *   cmp → sum ((">"|"<"|">="|"<="|"=="|"!=") sum)?
 *   sum → term (("+"|"-") term)*
 *   term→ unary (("*"|"/") unary)*
 *   unary → "-" unary | atom
 *   atom → number | percent | @path | "true" | "false" | "(" or ")"
 * `@path` is a dotted data path resolved against the actor with
 * foundry.utils.getProperty (coerced to a number). A "%" suffix on a number
 * divides by 100 (so "@…toxicity.value > @…toxicity.max * 125%" reads as
 * "25% over max"). No eval / Function — fully sandboxed. Any parse or lookup
 * error returns false: a malformed rule fails closed and never throws into
 * data prep. */
export function evaluateCondition(expr, actor) {
    if (typeof expr !== "string" || !expr.trim()) return false;
    try {
        const parser = new ConditionParser(tokenizeCondition(expr), actor);
        const result = parser.parseExpression();
        return parser.atEnd() ? Boolean(result) : false;
    } catch {
        return false;
    }
}

function tokenizeCondition(src) {
    const re = /(>=|<=|==|!=|>|<|\+|-|\*|\/|\(|\)|@[A-Za-z_][\w.]*|\d+(?:\.\d+)?%?|[A-Za-z]+)/y;
    const tokens = [];
    let i = 0;
    while (i < src.length) {
        if (/\s/.test(src[i])) { i++; continue; }
        re.lastIndex = i;
        const m = re.exec(src);
        if (!m) throw new Error(`bad token at ${i}`);
        tokens.push(m[0]);
        i = re.lastIndex;
    }
    return tokens;
}

class ConditionParser {
    constructor(tokens, actor) { this.t = tokens; this.i = 0; this.actor = actor; }
    atEnd() { return this.i >= this.t.length; }
    peek()  { return this.t[this.i]; }
    next()  { return this.t[this.i++]; }
    eat(tok) { if (this.peek() !== tok) throw new Error(`expected ${tok}`); return this.next(); }

    parseExpression() { return this.parseOr(); }

    parseOr() {
        let left = this.parseAnd();
        while ((this.peek() || "").toLowerCase() === "or") { this.next(); left = this.parseAnd() || left; }
        return left;
    }
    parseAnd() {
        let left = this.parseCmp();
        while ((this.peek() || "").toLowerCase() === "and") { this.next(); const r = this.parseCmp(); left = Boolean(left) && Boolean(r); }
        return left;
    }
    parseCmp() {
        const left = this.parseSum();
        const op = this.peek();
        if ([">", "<", ">=", "<=", "==", "!="].includes(op)) {
            this.next();
            const right = this.parseSum();
            switch (op) {
                case ">":  return left >  right;
                case "<":  return left <  right;
                case ">=": return left >= right;
                case "<=": return left <= right;
                case "==": return left === right;
                case "!=": return left !== right;
            }
        }
        return left;
    }
    parseSum() {
        let left = this.parseTerm();
        while (this.peek() === "+" || this.peek() === "-") {
            const op = this.next();
            const right = this.parseTerm();
            left = op === "+" ? left + right : left - right;
        }
        return left;
    }
    parseTerm() {
        let left = this.parseUnary();
        while (this.peek() === "*" || this.peek() === "/") {
            const op = this.next();
            const right = this.parseUnary();
            left = op === "*" ? left * right : left / right;
        }
        return left;
    }
    parseUnary() {
        if (this.peek() === "-") { this.next(); return -this.parseUnary(); }
        return this.parseAtom();
    }
    parseAtom() {
        const tok = this.next();
        if (tok === undefined) throw new Error("unexpected end");
        if (tok === "(") { const v = this.parseExpression(); this.eat(")"); return v; }
        const low = tok.toLowerCase();
        if (low === "true")  return true;
        if (low === "false") return false;
        if (tok[0] === "@")  return Number(foundry.utils.getProperty(this.actor, tok.slice(1))) || 0;
        if (tok.endsWith("%")) return parseFloat(tok) / 100;
        const n = Number(tok);
        if (Number.isNaN(n)) throw new Error(`bad atom ${tok}`);
        return n;
    }
}

/* Apply every `when:"condition"` modify action whose condition currently
 * holds. Called at the END of an actor's prepareDerivedData, so conditions
 * see fully-derived values (toxicity caps, HP max, etc.) and the write lands
 * after the native change pipeline. Because it runs post-derivation, a
 * condition buff on a *base* stat does NOT propagate back into the derived
 * formulas this cycle — author such rules against the derived/flat target you
 * actually want to move (meleeBonus, damageBonus, a skill total's modifier).
 * Each write is idempotent per prepare cycle (recomputed from the current
 * value), so it self-reverts the moment the condition stops holding. */
export function applyConditionActions(actor) {
    if (!actor?.allApplicableEffects) return;
    for (const e of actor.allApplicableEffects()) {
        if (!e.active) continue;
        const actions = e.flags?.[SYSTEM_ID]?.actions;
        if (!Array.isArray(actions)) continue;
        for (const raw of actions) {
            const a = normalizeAction(raw);
            if (!a || a.type !== "modify" || a.when !== "condition" || !a.target) continue;
            if (!effectOperation(a.op)) continue;
            if (!evaluateCondition(a.condition, actor)) continue;
            const cur  = Number(foundry.utils.getProperty(actor, a.target)) || 0;
            const next = applyOperation(cur, a.op, actionValue(a.value));
            foundry.utils.setProperty(actor, a.target, next);
        }
    }
}

/* Apply every event-triggered modify action's accumulated firings to the
 * PREPARED data, from the persistent ledger the tick/event engine maintains
 * (flags.<sys>.fx.<effectId>.<actionIndex>.fires). Called at the END of an
 * actor's prepareDerivedData — same layer as applyConditionActions — so the
 * mutation lands on `actor.system.*` rather than the source field.
 *
 * Why prepared, not source: writing a stat back to `system.stats.X.value`
 * (the source) clamps to the 1-10 NumberField range AND overwrites the
 * player's IP-allocated value. Event buffs must behave like native AE changes
 * — they push the prepared value, can exceed 10, and vanish the instant the
 * ledger entry is removed (no revert arithmetic). The op is applied once per
 * recorded firing, so 3 adrenaline gains of "+1 WILL" stack to +3.
 *
 * `lasts:"permanent"` rows are NOT applied here — they're written straight to
 * the source by the engine so they survive the effect's removal. */
export function applyEventLedger(actor) {
    if (!actor?.allApplicableEffects) return;
    const fx = actor.flags?.[SYSTEM_ID]?.fx;
    if (!fx || typeof fx !== "object") return;
    for (const e of actor.allApplicableEffects()) {
        if (!e.active) continue;
        const ledger = fx[e.id];
        if (!ledger || typeof ledger !== "object") continue;
        const actions = e.flags?.[SYSTEM_ID]?.actions;
        if (!Array.isArray(actions)) continue;
        for (const [indexStr, entry] of Object.entries(ledger)) {
            const fires = Number(entry?.fires) || 0;
            if (fires <= 0) continue;
            const a = normalizeAction(actions[Number(indexStr)]);
            if (!a || a.type !== "modify" || !a.target) continue;
            if (a.lasts === "permanent") continue;
            if (effectTrigger(a.when)?.mode !== "event") continue;
            if (!effectOperation(a.op)) continue;
            const value = actionValue(a.value);
            let cur = Number(foundry.utils.getProperty(actor, a.target)) || 0;
            for (let i = 0; i < fires; i++) cur = applyOperation(cur, a.op, value);
            foundry.utils.setProperty(actor, a.target, cur);
        }
    }
}

import { STATUS_EFFECTS } from "./statusEffects.mjs";

/* Which WILL skill resolves each castable item type (Core: spells/signs use
 * Spell Casting, hexes use Hex Weaving, rituals use Ritual Crafting). Drives
 * castSpellMixin + castDialog. */
export const CAST_SKILL_BY_TYPE = Object.freeze({
    spell:  "spellcast",
    hex:    "hexweave",
    ritual: "ritcraft"
});

export const WITCHER = Object.freeze({
    SYSTEM_ID,
    stats: STATS,
    skillMap: SKILL_MAP,
    skillLabel: (key) => `WITCHER.skills.${key}.label`,
    statLabel: (key) => `WITCHER.St${key.charAt(0).toUpperCase()}${key.slice(1)}`,
    weapon: Object.freeze({
        hands:     WEAPON_HANDS,
        slots:     WEAPON_SLOTS,
        types:     WEAPON_TYPES,
        ammoTypes: AMMO_TYPES,
        skillKeys: WEAPON_SKILL_KEYS,
        meleeSkillKeys: MELEE_SKILL_KEYS,
        qualities: WEAPON_QUALITIES
    }),
    armor: Object.freeze({
        types:     ARMOR_TYPES,
        locations: ARMOR_LOCATIONS,
        qualities: ARMOR_QUALITIES
    }),
    shield: Object.freeze({
        categories: SHIELD_CATEGORIES,
        // Shields wield like weapons — reuse the hand/slot catalogs.
        hands: WEAPON_HANDS,
        slots: WEAPON_SLOTS,
        // AE slots can host the same glyph/armor-mod qualities armor uses.
        qualities: ARMOR_QUALITIES
    }),
    enhancement: Object.freeze({
        types: ENHANCEMENT_TYPES
    }),
    availability: AVAILABILITY,
    concealment:  CONCEALMENT,
    magic: Object.freeze({
        schools:       SPELL_SCHOOLS,
        forms:         SPELL_FORMS,
        tiers:         SPELL_TIERS,
        targets:       SPELL_TARGETS,
        defenses:      SPELL_DEFENSES,
        durationUnits: SPELL_DURATION_UNITS
    }),
    hex: Object.freeze({
        defenses:      HEX_DEFENSES,
        durationUnits: HEX_DURATION_UNITS,
        danger:        HEX_DANGER
    }),
    ritual: Object.freeze({
        // Tier + school reuse the magic catalogs (a ritual is graded by the
        // Ritual Crafting rank it needs, and draws on a magic school).
        tiers:         SPELL_TIERS,
        schools:       SPELL_SCHOOLS,
        timeUnits:     RITUAL_TIME_UNITS,
        durationUnits: RITUAL_DURATION_UNITS
    }),
    alchemical: Object.freeze({
        types:          ALCHEMICAL_TYPES,
        substances:     SUBSTANCES,
        substanceArt:   SUBSTANCE_ART
    }),
    crafting: Object.freeze({
        levels:          DIAGRAM_LEVELS,
        formulaSubtypes: FORMULA_SUBTYPES,
        diagramSubtypes: DIAGRAM_SUBTYPES,
        recipeSubtypes:  RECIPE_SUBTYPES
    }),
    damageTypes:  DAMAGE_TYPES,
    attack: Object.freeze({
        locations:     ATTACK_LOCATIONS,
        randomTables:  RANDOM_LOCATION,
        strikeTypes:   STRIKE_TYPES,
        modifiers:     ATTACK_MODIFIERS,
        rangeBrackets: RANGE_BRACKETS,
        sizes:         SIZE_MODIFIERS,
        extraAction:   EXTRA_ACTION,
        aimPerTurn:    AIM_BONUS_PER_TURN,
        aimCap:        AIM_BONUS_CAP
    }),
    statusEffects: STATUS_EFFECTS,
    monster: Object.freeze({
        types:         MONSTER_TYPES,
        threat:        MONSTER_THREAT,
        complexity:    MONSTER_COMPLEXITY,
        damageReactions: DAMAGE_REACTIONS
    }),
    HOMEBREW
});

/* Runtime catalog accessors — defaults baked above + per-entry overrides
 * from the world setting. The override REPLACES nothing; instead we
 * deep-merge per entry:
 *   - For every key in defaults, start with the default entry.
 *   - Overlay the override's entry on top (overriding label, description,
 *     adding/replacing param).
 *   - Any keys in override that aren't in defaults are appended as new.
 * This guards against the failure mode where an earlier save captured
 * entries before parameterized fields existed: defaults' param values
 * flow through unless explicitly overridden. To truly remove a default
 * quality, the override entry can set `{ removed: true }` (handled by
 * sheets — undocumented for now). */
function mergeQualityCatalog(defaults, override) {
    if (!override || Object.keys(override).length === 0) return defaults;
    const merged = {};
    for (const [key, defEntry] of Object.entries(defaults)) {
        const ovrEntry = override[key];
        if (ovrEntry?.removed) continue;
        merged[key] = ovrEntry
            ? {
                label:       ovrEntry.label       ?? defEntry.label,
                description: ovrEntry.description ?? defEntry.description,
                param:       ovrEntry.param       ?? defEntry.param ?? null
            }
            : defEntry;
    }
    for (const [key, ovrEntry] of Object.entries(override)) {
        if (key in defaults || ovrEntry?.removed) continue;
        merged[key] = ovrEntry;
    }
    return merged;
}

export function getActiveWeaponQualities() {
    try {
        const override = game.settings.get(SYSTEM_ID, "weaponQualitiesOverride");
        return mergeQualityCatalog(WEAPON_QUALITIES, override);
    } catch (_) { /* setting not registered yet during init */ }
    return WEAPON_QUALITIES;
}

export function getActiveArmorQualities() {
    try {
        const override = game.settings.get(SYSTEM_ID, "armorQualitiesOverride");
        return mergeQualityCatalog(ARMOR_QUALITIES, override);
    } catch (_) { /* setting not registered yet during init */ }
    return ARMOR_QUALITIES;
}
