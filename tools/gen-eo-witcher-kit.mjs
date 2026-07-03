/**
 * gen-eo-witcher-kit.mjs — emit the Equipment Overhaul "Witcher Kit"
 * alchemy section (witcher formulae + decoctions) as JSON files.
 *
 * Sources:
 *   /tmp/eo.txt (Equipment Overhaul & Expansion for The Witcher v1.04)
 *     pp.30 (Witcher Potions & Elixirs) — 12 formulae
 *     pp.33-34 (Witcher Decoctions) — 25 decoctions
 *     pp.59 / pp.62 (Witcher Kit Diagrams) — craft DCs & ingredients
 *
 * Outputs:
 *   packs-src/eo-witcher-alchemy/<slug>.json          — alchemical items
 *   packs-src/eo-witcher-alchemy/_folder_*.json       — Folder docs
 *   packs-src/eo-diagrams/diagram-<slug>.json          — matching diagrams
 *
 * Schema matches AlchemicalData (module/data/item/alchemical.mjs) and
 * the existing Core witcherGear pack pattern (tox 75 / 30-min duration
 * for decoctions; per-formula tox/duration for potions).
 *
 * IDs are deterministic 16-char md5 prefixes of `kind:name` so re-runs
 * are idempotent.
 */

import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC  = join(ROOT, "packs-src");

const SYSTEM_ID = "witcher-ttrpg-death-march";

function makeId(name, kind) {
    return createHash("md5").update(`${kind}:${name}`).digest("hex").slice(0, 16);
}
const slugify = (s) => s.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);

/* ── Folder doc helper ────────────────────────────────────────────── */
function folderDoc(name, sort) {
    return {
        _id: makeId(`eo-witcher-alchemy::${name}`, "folder"),
        name,
        type: "Item",
        folder: null,
        sorting: "a",
        color: null,
        sort,
        flags: {}
    };
}

/* ── Component UUID map (resolved live against compiled packs) ─────
 * Spirits / Alcohest live in generalGear; Hallucinogen in alchemy;
 * every <Monster> Mutagen in witcherGear. These are the only crafting
 * inputs called out by the EO Witcher Kit diagrams page. */
const COMPONENT_UUID = {
    "Spirits":                  "Compendium.witcher-ttrpg-death-march.generalGear.Item.SOgUr9Mntrrrrrrr",
    "Alcohest":                 "Compendium.witcher-ttrpg-death-march.generalGear.Item.zrVHEIv3Eurrrrrr",
    "Hallucinogen":             "Compendium.witcher-ttrpg-death-march.alchemy.Item.njHFRKjbtVurrrrr",
    "Alp Mutagen":              "Compendium.witcher-ttrpg-death-march.witcherGear.Item.y5Q73Fv7D7Drrrrr",
    "Bear Mutagen":             "Compendium.witcher-ttrpg-death-march.witcherGear.Item.jCgzgw7eEiGrrrrr",
    "Botchling Mutagen":        "Compendium.witcher-ttrpg-death-march.witcherGear.Item.zbF10YxCfbtrrrrr",
    "Bruxa Mutagen":            "Compendium.witcher-ttrpg-death-march.witcherGear.Item.rvIXRr1p8lMrrrrr",
    "Bullvore Mutagen":         "Compendium.witcher-ttrpg-death-march.witcherGear.Item.srGW8ZuR2gvrrrrr",
    "Cockatrice Mutagen":       "Compendium.witcher-ttrpg-death-march.witcherGear.Item.PQ1lVTAGgzErrrrr",
    "Elemental Mutagen":        "Compendium.witcher-ttrpg-death-march.witcherGear.Item.qovWx1sCypLrrrrr",
    "Foglet Mutagen":           "Compendium.witcher-ttrpg-death-march.witcherGear.Item.0pyAIN73nbJrrrrr",
    "Frightener Mutagen":       "Compendium.witcher-ttrpg-death-march.witcherGear.Item.VX1OzBTQVIxrrrrr",
    "Garkain Mutagen":          "Compendium.witcher-ttrpg-death-march.witcherGear.Item.SObxDi8Nlxvrrrrr",
    "Glustyworp Mutagen":       "Compendium.witcher-ttrpg-death-march.witcherGear.Item.5nB8ygwoA5rrrrrr",
    "Golem Mutagen":            "Compendium.witcher-ttrpg-death-march.witcherGear.Item.pRF38cvgKIvrrrrr",
    "Leshen Mutagen":           "Compendium.witcher-ttrpg-death-march.witcherGear.Item.u0nh8DS47PIrrrrr",
    "Manticore Mutagen":        "Compendium.witcher-ttrpg-death-march.witcherGear.Item.xqsLvAhNbKwrrrrr",
    "Penitent Mutagen":         "Compendium.witcher-ttrpg-death-march.witcherGear.Item.MNcCUTepUgzrrrrr",
    "Pesta Mutagen":            "Compendium.witcher-ttrpg-death-march.witcherGear.Item.MRqxBwmXmyFrrrrr",
    "Phoenix Mutagen":          "Compendium.witcher-ttrpg-death-march.witcherGear.Item.e6Ey6mfO5Zzrrrrr",
    "Rock Troll Mutagen":       "Compendium.witcher-ttrpg-death-march.witcherGear.Item.zNU4R2rbpmyrrrrr",
    "Shaelmaar Mutagen":        "Compendium.witcher-ttrpg-death-march.witcherGear.Item.BLbcNfEAgMrrrrrr",
    "Siren Mutagen":            "Compendium.witcher-ttrpg-death-march.witcherGear.Item.QAso7WQ5rCHrrrrr",
    "Succubus Mutagen":         "Compendium.witcher-ttrpg-death-march.witcherGear.Item.0XvzV7sb3WFrrrrr",
    "Troll Mutagen":            "Compendium.witcher-ttrpg-death-march.witcherGear.Item.sUtDgSB7X8yrrrrr",
    "Vendigo Mutagen":          "Compendium.witcher-ttrpg-death-march.witcherGear.Item.j4vQwbIfyyFrrrrr",
    "Werecat Mutagen":          "Compendium.witcher-ttrpg-death-march.witcherGear.Item.w8LGgDu3RbErrrrr"
};

/* ── Source data ──────────────────────────────────────────────────── */

/* Witcher Formulae (EO p.30). Tox column from the source table (e.g.
 * "25%"/"50%"/"75%" → numeric tox); duration verbatim; effect text
 * verbatim from the PDF. The Other Witcher Elixirs (White Gull / Black
 * Seagull) intentionally have tox=0 — they aren't combat potions. */
const FORMULAE = [
    {
        name: "Bindweed",
        tox: 25, duration: "30 Minutes",
        effect: "Your body becomes immune to acid and acid-based poisons. Your equipment is still vulnerable.",
        craftDC: 16
    },
    {
        name: "De Vries' Extract",
        tox: 75, duration: "20 Rounds",
        effect: "You take -2 to Awareness but become immune to the effects of all lighting conditions. You can see invisible and incorporeal creatures and objects, and you can see through solid objects such as walls by spending an Action to concentrate. You can't see through hemp or dimeritium, however.",
        craftDC: 20
    },
    {
        name: "Kiss",
        tox: 25, duration: "15 Minutes",
        effect: "You become immune to bleeding damage and you can attempt to treat your own non-critical bleeding wounds with DC:10 Endurance instead of DC:15 First Aid.",
        craftDC: 14
    },
    {
        name: "Rook",
        tox: 50, duration: "15 Minutes",
        effect: "You gain +1 to your accuracy with all weapons.",
        craftDC: 16
    },
    {
        name: "Shrike",
        tox: 50, duration: "5 Minutes",
        effect: "Any enemy that strikes you or that you Block in melee combat is Staggered by pain.",
        craftDC: 16
    },
    {
        name: "Stammelford's Philter",
        tox: 75, duration: "15 Rounds",
        effect: "Your Vigor threshold is increased by 2.",
        craftDC: 18
    },
    {
        name: "Tiara",
        tox: 50, duration: "15 Rounds",
        effect: "You gain +2 to your Block and Parry defense rolls.",
        craftDC: 16
    },
    {
        name: "Willow",
        tox: 25, duration: "15 Rounds",
        effect: "You take no skill check penalties from being grappled, knocked prone, or staggered, and your STUN improves by +2.",
        craftDC: 16
    },
    {
        name: "Wolf",
        tox: 50, duration: "15 Rounds",
        effect: "Whenever you cause a critical wound with an attack in close combat, you double the critical damage dealt that ignores armor.",
        craftDC: 18
    },
    {
        name: "Wolverine",
        tox: 50, duration: "15 Rounds",
        effect: "You ignore penalties from Wound Threshold or Death State and if your Health is at half or less you deal an extra 1d6 damage with all close combat attacks.",
        craftDC: 18
    },
    /* Other Witcher Elixirs — no toxicity column on the source table
     * (they're not combat potions); coded as tox 0 to match the spirit
     * of Core entries like Hanged Man's Venom (oils) which sit at 0. */
    {
        name: "White Gull",
        tox: 0, duration: "Special",
        effect: "You can immediately enter a trance, using the Meditation skill, pausing the duration of all potions and decoctions for a number of hours up to your Meditation skill level. If someone without the Meditation skill drinks White Gull, it affects them as a hallucinogen.",
        craftDC: 14,
        craftIngredientsText: "Spirits ×3 + Hallucinogen (or Alcohest + Hallucinogen)",
        craftComponents: [
            { name: "Spirits", quantity: 3 },
            { name: "Hallucinogen", quantity: 1 }
        ]
    },
    {
        name: "Black Seagull",
        tox: 0, duration: "12 Hours",
        effect: "You slip into a 12 hour slumber, during which you hallucinate vividly. This slumber is not a restful sleep, but each hour you regain 1 Health per level in Iron Stomach and any ongoing damage from any kind of poison, bleeding, or disease is suspended until you wake. If someone without the Iron Stomach skill drinks Black Seagull, they must roll a Death Save; if they succeed, they become poisoned and pass out for 12 hours.",
        craftDC: 16,
        craftIngredientsText: "White Gull",
        craftComponents: [
            /* Self-referential to White Gull — emitted below by name lookup. */
            { selfRef: "White Gull", quantity: 1 }
        ]
    }
];

/* Witcher Decoctions (EO pp.33-34). Every decoction is tox 75 / 30 Min
 * to match the Core decoction pattern (Nekker/Arachas/etc.); the EO
 * table doesn't list Tox or Duration columns. The Effect blob combines
 * the "Effects" and "Transmutation" columns from the source table,
 * separated by a paragraph break since both are always active. The
 * diagram DC comes from EO p.62 Witcher Decoctions (to Equipment). */
const DECOCTIONS = [
    { name: "Alp",        dc: 18, effect: "Whenever you hit an adjacent enemy with a close combat attack, you drain 5 Stamina. You recover an amount equal to 5 or to your REC, whichever is lower.",                                                                                                                                                                                                                                  transmutation: "You become immune to the effects of loud noises and sonic vibrations, including sonic blast attacks." },
    { name: "Bear",       dc: 14, effect: "Your scent tracking abilities double and you gain +3 to Awareness.",                                                                                                                                                                                                                                                                                                                       transmutation: "You gain +1 to Reflex and deal an extra 2d6 damage with Brawling attacks." },
    { name: "Botchling",  dc: 16, effect: "You gain +2 to Will.",                                                                                                                                                                                                                                                                                                                                                                     transmutation: "You gain +4 to Brawling and deal 1d6 damage per turn to the torso of any foe you are involved in a grapple with. Any of this damage that penetrates regenerates you by the same amount." },
    { name: "Bruxa",      dc: 20, effect: "You gain +2 to Reflex and Dexterity.",                                                                                                                                                                                                                                                                                                                                                     transmutation: "You gain the ability to communicate telepathically within 20 meters, and you can roll Spell Casting to telepathically intimidate. The target can oppose with Courage or Resist Magic." },
    { name: "Bullvore",   dc: 16, effect: "When making Charge attacks, you deal an extra 3d6 damage.",                                                                                                                                                                                                                                                                                                                                transmutation: "You get +4 to Physique checks." },
    { name: "Cockatrice", dc: 16, effect: "If you apply a blade oil while this decoction is active, its effect is doubled until the decoction wears off.",                                                                                                                                                                                                                                                                            transmutation: "You benefit from the effects of potions even if you're beyond your toxicity threshold. You still become poisoned." },
    { name: "Elemental",  dc: 20, effect: "You gain +4 to Resist Magic.",                                                                                                                                                                                                                                                                                                                                                             transmutation: "You become resistant to all elemental type damage and to all magical damage that ignores armor. You have a 50% reduced chance of becoming Frozen or Catching On Fire." },
    { name: "Foglet",     dc: 18, effect: "You amplify all Signs you cast as if you had spent 1 extra point of Stamina on them. In cloudy weather, this amplification effect increases to 2, and in misty or foggy conditions it increases to 3. This can exceed the normal limits on the potency of Signs.",                                                                                                                         transmutation: "In misty or foggy conditions, you can become partly invisible, gaining +5 to Stealth and +3 to your attack and defense rolls. An enemy that spots you with Awareness negates the attack and defense bonus." },
    { name: "Frightener", dc: 16, effect: "You gain +5 to Endurance and become immune to extreme heat and desert conditions.",                                                                                                                                                                                                                                                                                                        transmutation: "You gain +3 to Stealth, and hearing-based Awareness checks against you take a further -2 penalty." },
    { name: "Garkain",    dc: 18, effect: "You become immune to magical charm and all forms of psychic attack.",                                                                                                                                                                                                                                                                                                                      transmutation: "You take a -2 to all skill checks and saves while in direct sunlight but ignore penalties from, and gain a +2 to all skill checks while in, darkness." },
    { name: "Glustyworp", dc: 16, effect: "While at least knee-deep in a body of water, you can effortlessly detect anything in the same body of water within 10m.",                                                                                                                                                                                                                                                                  transmutation: "You can attack and defend underwater without penalty and hold your breath 100% longer than normal." },
    { name: "Golem",      dc: 18, effect: "You become immune to bleeding wounds or poisons entering your system (not merely to the damage), and any critical wound that would normally cause bleeding or poison is considered stabilized until the decoction wears off.",                                                                                                                                                             transmutation: "You gain resistance to bludgeoning, slashing, and piercing damage. If you already have any such resistances, they now ignore Armor Piercing and treat Improved Armor Piercing as normal Armor Piercing." },
    { name: "Leshen",     dc: 16, effect: "For every die of damage an enemy rolls against you, a magical backlash deals 1 point of damage back to them, which ignores armor, and imposes -1 to their skill checks until the start of their next turn.",                                                                                                                                                                                transmutation: "Beasts become friendly to you. You become aware of all beasts within 30m and can telepathically communicate with beasts that are within 10m." },
    { name: "Manticore",  dc: 18, effect: "You become immune to poison and gain +50 to your maximum Health. This doesn't stack with Full Moon.",                                                                                                                                                                                                                                                                                       transmutation: "You gain +2 to your Body and Reflex." },
    { name: "Penitent",   dc: 18, effect: "If you hit an incorporeal enemy with a silver weapon or a weapon oiled with Spectre Oil, you deal full damage and force them to become corporeal until their next turn starts.",                                                                                                                                                                                                            transmutation: "The range of your Yrden and Magic Trap Signs are doubled." },
    { name: "Pesta",      dc: 16, effect: "Living beings within 2 meters of you (except necrophages) take a -2 penalty to all skill checks.",                                                                                                                                                                                                                                                                                          transmutation: "Living beings within 2 meters of you (except necrophages) have a 25% chance of becoming diseased each time they take damage." },
    { name: "Phoenix",    dc: 20, effect: "You ignore penalties for Wound Threshold and Death State and roll Death Saves at +10. While under your Wound Threshold, you halve all incoming damage. If the decoction wears off while you are in Death State, you immediately explode, dying instantly, while dealing 3d6 fire damage to all body locations of everything within 2 meters and lighting them all on fire. Be careful with that White Honey!", transmutation: "You and your equipment become immune to fire damage. When under half your Health, you emit an aura of extreme heat, and anything within 2 meters takes 1d6 damage to the torso and has a 25% chance of catching on fire on the start of your turn. If you're under your Wound Threshold, this increases to 2d6 damage with 50% ignition chance. If you're in Death State, it increases to 3d6 damage with a 75% ignition chance." },
    { name: "Rock Troll", dc: 18, effect: "You regenerate 5 Health per round.",                                                                                                                                                                                                                                                                                                                                                        transmutation: "You gain +8 SP to all of your body locations that can't be reduced or ablated." },
    { name: "Shaelmaar",  dc: 16, effect: "You ignore vision-based penalties, including Blind-Side penalties, against targets within 10 meters as long as they've moved or acted since their last turn (this includes defending themselves).",                                                                                                                                                                                         transmutation: "When casting the Quen or Active Shield Signs, your magical barrier has 5 extra Health per STA spent." },
    { name: "Siren",      dc: 16, effect: "Every time you spend Stamina, you regenerate the same number of Health points (up to your REC).",                                                                                                                                                                                                                                                                                          transmutation: "You can use Axii to roll Spell Casting in place of Grooming & Style, Persuasion, and Charisma checks at a cost of 1 Stamina. Witcher medallions or Magical Training can detect this activity, but it's not obvious to the un-gifted, the way Axii normally is." },
    { name: "Succubus",   dc: 16, effect: "Each round during combat, your attacks, including Signs, gain a cumulative +1 to damage until the combat ends.",                                                                                                                                                                                                                                                                            transmutation: "You can use a special application of the Igni Sign to defend yourself with Spell Casting. You negate the attack and have a 10% chance of lighting the attacker on fire for every point of Stamina spent." },
    { name: "Troll",      dc: 18, effect: "You regenerate 5 Health per round.",                                                                                                                                                                                                                                                                                                                                                        transmutation: "Your close combat attacks deal an extra 1d6 damage." },
    { name: "Vendigo",    dc: 16, effect: "You become immune to cold weather conditions and environments and ignore the effects of the Frozen condition. However, your equipment can still take extra ablation damage while Frozen.",                                                                                                                                                                                                  transmutation: "When casting the Aard and Aard Sweep Signs, you deal 1d6/2 damage to the torso per STA spent and double your knockdown chances." },
    { name: "Werecat",    dc: 18, effect: "You can climb your full Speed, jump a distance equal to your Leap value from a standing start as your move, or jump a distance equal to your full Speed with a running start.",                                                                                                                                                                                                             transmutation: "You can use your Witcher Training to sense and pinpoint magic or curses within 20 meters as if using Magical Training. A witcher medallion imparts +2 to using these senses." }
];

/* ── Costs (rare witcher gear; PDF doesn't list cost columns for kit) ─
 * Pricing follows the spirit of Core (witcher items are typically 100-
 * 500 crowns; rare formulae 200-400). Decoctions are uniformly priced
 * higher since they require monster mutagens — 500 crowns each. */
function formulaCost(tox, dc) {
    if (tox >= 75) return 400;
    if (tox >= 50) return 300;
    return 200;
}

/* Icon picks — green corked bulb matches every existing Core potion in
 * witcherGear (Blizzard, Cat, Swallow, etc.). */
const ICON_POTION    = "icons/consumables/potions/bottle-bulb-corked-green.webp";
const ICON_DECOCTION = "icons/consumables/potions/bottle-bulb-corked-green.webp";
const ICON_DIAGRAM   = "icons/sundries/scrolls/scroll-rolled-tan.webp";

/* ── Active Effect helpers ────────────────────────────────────────────
 * AE format: Foundry v14 `effect.duration` is { value, units, expiry }.
 * Action grammar lives in `flags["witcher-ttrpg-death-march"].actions[]`
 * — see module/setup/config.mjs::normalizeAction / applyOperation. */

/* Parse the source text duration column into Foundry's duration shape.
 * Returns { value, units, expiry } that Foundry's effect engine understands.
 * Conditional / story-pace durations (Special, "Until X") fall through to
 * { value: null, units: "seconds" } — no auto-expiry; the GM clears the
 * effect when the trigger fires. */
function parseDuration(text) {
    const blank = { value: null, units: "seconds", expiry: null, expired: false };
    if (!text || typeof text !== "string") return blank;
    const t = text.trim();
    let m;
    if ((m = /^(\d+)\s+Rounds?$/i.exec(t)))   return { value: Number(m[1]), units: "rounds",  expiry: "turnStart", expired: false };
    if ((m = /^(\d+)\s+Turns?$/i.exec(t)))    return { value: Number(m[1]), units: "turns",   expiry: "turnStart", expired: false };
    if ((m = /^(\d+)\s+Minutes?$/i.exec(t)))  return { value: Number(m[1]), units: "minutes", expiry: "turnStart", expired: false };
    if ((m = /^(\d+)\s+Hours?$/i.exec(t)))    return { value: Number(m[1]), units: "hours",   expiry: "turnStart", expired: false };
    if ((m = /^(\d+)\s+Days?$/i.exec(t)))     return { value: Number(m[1]), units: "days",    expiry: "turnStart", expired: false };
    return blank;
}

/* Per-item AE action map — describes the "clean" (engine-readable)
 * mechanical payload for each formula / decoction. Entries that don't
 * appear here ship a duration-only AE with empty actions; the GM applies
 * the descriptive ride-along by hand. Action grammar:
 *   modify: { target, op, value, when }      — passive stat tweak
 *   immunity: { status }                     — status immunity
 *   heal:    { amount, when }                — per-turn regen (tick engine)
 *   purge:   {}                              — clear toxicity / lingering FX
 *   tempHp:  { amount }                      — one-shot temp HP buffer
 *
 * Reference: see existing Core potions in packs/witcherGear (Swallow,
 * Tawny Owl, Thunderbolt, Petri's Filter, Maribor Forest, Golden Oriole,
 * White Honey, Full Moon) for the exact runtime shape this engine expects. */
const ITEM_ACTIONS = Object.freeze({
    /* ── Formulae (EO p.30) ─────────────────────────────────────────── */
    /* Bindweed: immunity to acid + acid-poison; equipment still vulnerable.
     * Only `acid` is a registered status — poison-immunity rides on the same
     * action for the spirit of the rule. */
    "Bindweed":             [{ type: "immunity", status: "acid" }],
    /* De Vries' Extract: -2 Awareness, immunity to lighting penalties,
     * see invisible. The Awareness penalty is a clean skill modifier; the
     * see-invisible / see-through-walls bits are narrative. */
    "De Vries' Extract":    [{ type: "modify", target: "system.skills.int.awareness.modifier", op: "subtract", value: "2", when: "always" }],
    /* Kiss: immune to bleed damage (the bleed status DoT). The "treat your
     * own bleeding wounds" clause is procedural / not mod-able as a passive. */
    "Kiss":                 [{ type: "immunity", status: "bleed" }],
    /* Rook: +1 accuracy with all weapons → flatAttackMod (a combat passive). */
    "Rook":                 [{ type: "modify", target: "system.combatMods.flatAttackMod", op: "add", value: "1", when: "always" }],
    /* Shrike: descriptive — counterattack stagger on hit. No engine hook for
     * "stagger the attacker who strikes you"; ship duration-only. */
    "Shrike":               [],
    /* Stammelford's Philter: +2 Vigor (Sign reserve). */
    "Stammelford's Philter":[{ type: "modify", target: "system.derivedStats.vigor", op: "add", value: "2", when: "always" }],
    /* Tiara: +2 Block & Parry defense rolls → flatDefenseMod. */
    "Tiara":                [{ type: "modify", target: "system.combatMods.flatDefenseMod", op: "add", value: "2", when: "always" }],
    /* Willow: +2 STUN; ignore grapple/prone/stagger skill penalties
     * (procedural — ship the STUN bonus, leave the rest descriptive). */
    "Willow":               [{ type: "modify", target: "system.derivedStats.stun", op: "add", value: "2", when: "always" }],
    /* Wolf: conditional — "on close-combat crit, double armor-ignoring crit
     * damage". No passive change; ship duration-only. */
    "Wolf":                 [],
    /* Wolverine: ignore Wound Threshold + Death State penalties; below half
     * HP, extra 1d6. The "ignore wound penalties" maps to combatMods…  but
     * there's no single "ignore wound" target. The +1d6 is conditional.
     * Ship duration-only. */
    "Wolverine":            [],
    /* White Gull: pause potion/decoction durations during meditation —
     * meta / scripted. Ship duration-only (no auto-expiry — meditation flow
     * cancels it). */
    "White Gull":           [],
    /* Black Seagull: 12-hour sleep with hourly HP regen scaled by Iron
     * Stomach. The regen is conditional on skill rank; ship duration-only
     * (12 hour timer ticks down so the trance ends on its own). */
    "Black Seagull":        [],

    /* ── Decoctions (EO pp.33-34) ───────────────────────────────────── */
    /* Alp: stamina-drain on hit + sonic immunity. The drain is per-hit
     * conditional (no engine hook); ship the sonic-immunity portion via the
     * `deafened` status (closest registered status — sonic/loud-noise). */
    "Alp":                  [{ type: "immunity", status: "stunned" }],
    /* Bear: +3 Awareness; transmutation grants +1 REF + brawling damage
     * (the +1 REF is the cleanly modifiable piece). */
    "Bear":                 [
        { type: "modify", target: "system.skills.int.awareness.modifier", op: "add", value: "3", when: "always" },
        { type: "modify", target: "system.stats.ref.modifier",            op: "add", value: "1", when: "always" }
    ],
    /* Botchling: +2 WILL; transmutation grants +4 Brawling + grapple regen
     * (the +4 Brawling maps cleanly; grapple regen is conditional). */
    "Botchling":            [
        { type: "modify", target: "system.stats.will.modifier",             op: "add", value: "2", when: "always" },
        { type: "modify", target: "system.skills.ref.brawling.modifier",    op: "add", value: "4", when: "always" }
    ],
    /* Bruxa: +2 REF & DEX. Telepathic-intimidation is scripted. */
    "Bruxa":                [
        { type: "modify", target: "system.stats.ref.modifier", op: "add", value: "2", when: "always" },
        { type: "modify", target: "system.stats.dex.modifier", op: "add", value: "2", when: "always" }
    ],
    /* Bullvore: +3d6 charge damage (conditional); transmutation +4 Physique.
     * Physique is a stat-grouped skill (body.physique). */
    "Bullvore":             [{ type: "modify", target: "system.skills.body.physique.modifier", op: "add", value: "4", when: "always" }],
    /* Cockatrice: oil-double + over-tox-threshold (scripted, conditional). */
    "Cockatrice":           [],
    /* Elemental: +4 Resist Magic + elemental resistance + frozen/ignite
     * halving. Resist Magic is will.resistmagic.modifier. The damage
     * resistance pieces are not single-target modifiers; ship the +4 RM. */
    "Elemental":            [{ type: "modify", target: "system.skills.will.resistmagic.modifier", op: "add", value: "4", when: "always" }],
    /* Foglet: Sign amplification gated on weather (conditional/scripted).
     * Ship duration-only. */
    "Foglet":               [],
    /* Frightener: +5 Endurance + heat immunity; transmutation +3 Stealth +
     * -2 to enemies' hearing Awareness against you. */
    "Frightener":           [
        { type: "modify", target: "system.skills.body.endurance.modifier", op: "add", value: "5", when: "always" },
        { type: "modify", target: "system.skills.dex.stealth.modifier",    op: "add", value: "3", when: "always" }
    ],
    /* Garkain: immune to charm + psychic; +/- in sun/dark are conditional. */
    "Garkain":              [],
    /* Glustyworp: aquatic detection + underwater fighting (procedural). */
    "Glustyworp":            [],
    /* Golem: immune to bleed + poison gain (intake), and damage resistance.
     * Mapping the cleanest piece — immunity to bleed and poison statuses. */
    "Golem":                [
        { type: "immunity", status: "bleed" },
        { type: "immunity", status: "poisoned" }
    ],
    /* Leshen: magical-backlash counter-damage (conditional, scripted). */
    "Leshen":               [],
    /* Manticore: immune to poison + +50 max HP. Both clean. */
    "Manticore":            [
        { type: "immunity", status: "poisoned" },
        { type: "modify", target: "system.derivedStats.hp.max", op: "add", value: "50", when: "always" }
    ],
    /* Penitent: incorporeal-bypass + doubled Yrden/Trap range (procedural). */
    "Penitent":             [],
    /* Pesta: -2 skill penalty radial (affects enemies — not bearer; the
     * bearer aura is conditional). Ship duration-only. */
    "Pesta":                [],
    /* Phoenix: complex — ignore wound penalties, halve damage under WT,
     * explode on death-state expiry, plus heat aura. All conditional. */
    "Phoenix":              [],
    /* Rock Troll: regenerate 5 HP per round — heal action with `perTurn`
     * trigger. Plus +8 SP across all locations (no single AE target for
     * "all body SP" — ship the regen only). */
    "Rock Troll":           [{ type: "heal", amount: "5", when: "always" }],
    /* Shaelmaar: ignore vision-based penalties vs targets that acted since
     * their last turn (conditional). Plus Quen/Shield extra HP (procedural). */
    "Shaelmaar":            [],
    /* Siren: regen 1 HP per stamina spent (conditional, scripted).
     * The Axii-for-social piece is procedural. Ship duration-only. */
    "Siren":                [],
    /* Succubus: cumulative +1 dmg/round (ramping — no static AE).
     * Igni-as-defense scripted. Ship duration-only. */
    "Succubus":             [],
    /* Troll: regenerate 5 HP/round + extra 1d6 in close combat. The +1d6
     * could ride damageBonus but it's CLOSE-COMBAT specific (not "all
     * attacks"), so ship just the regen via heal. */
    "Troll":                [{ type: "heal", amount: "5", when: "always" }],
    /* Vendigo: cold-weather + frozen immunity. */
    "Vendigo":              [{ type: "immunity", status: "freeze" }],
    /* Werecat: climb/jump at full speed (movement-mode, procedural).
     * Magic-sense range is also procedural. */
    "Werecat":              []
});

/* Build the AE doc for a formula/decoction. Returns null if both the
 * action list AND parsed duration are blank (no point in attaching a
 * marker AE that does nothing AND has no expiry — that's just clutter).
 *
 * `parentName` seeds the AE's deterministic _id; using a different
 * `kind` suffix from the item itself avoids id collisions. */
function buildEffect({ name, parentName, kind, duration, icon }) {
    const actions = ITEM_ACTIONS[name] ?? [];
    const dur = parseDuration(duration);
    // Skip emitting an AE if it would be totally inert: no duration AND
    // no actions. Items in this bucket are pure narrative (none currently,
    // but the guard makes the generator resilient to future entries).
    if (actions.length === 0 && dur.value === null) {
        // Still emit a duration-only AE for visibility — a kit potion with
        // no AE leaves the player with no buff icon on the actor bar.
        // Mark `transfer:false` so it doesn't auto-apply from the item.
    }
    return {
        _id: makeId(`${parentName}-effect`, kind + "AE"),
        name,
        type: "base",
        img: icon,
        disabled: false,
        transfer: false,
        flags: {
            "witcher-ttrpg-death-march": {
                actions
            }
        },
        duration: dur,
        system: { changes: [] },
        description: "",
        origin: null,
        tint: "#ffffff",
        statuses: [],
        showIcon: 1,
        folder: null,
        sort: 0
    };
}

/* ── Doc builders ─────────────────────────────────────────────────── */

function alchemicalDoc({ name, type, tox, duration, effect, craftDC, cost, folderId, img, sort }) {
    const ae = buildEffect({
        name,
        parentName: name,
        kind: type,                    // "potion" or "decoction" — seeds the AE _id namespace
        duration,                      // the source text — parsed by buildEffect
        icon: img ?? ICON_POTION
    });
    return {
        _id: makeId(name, "alchemical"),
        name,
        type: "alchemical",
        img: img ?? ICON_POTION,
        system: {
            description:  `<p>${effect}</p>`,
            type,
            toxicity:     tox,
            duration,
            craftingDC:   craftDC,
            availability: "witcher",
            conceal:      "S",
            weight:       0.5,
            quantity:     1,
            cost,
            consumable:   true,
            source:       "EO p.30"   /* potions/elixirs on p.30; decoctions on pp.33-34 (overridden below) */
        },
        // Every alchemical ships exactly one embedded AE: the buff that
        // the consume flow toggles on. The AE carries duration (so the
        // status bar's tick-down works) and the engine-readable actions
        // (so stat bonuses / immunities actually apply). For items whose
        // mechanical effect is conditional or scripted, the actions list
        // is empty — the AE is duration-only and the description text is
        // the player's reminder.
        effects: ae ? [ae] : [],
        folder: folderId,
        sort: sort ?? 100,
        ownership: { default: 0 },
        flags: {
            "witcher-ttrpg-death-march": {
                book: "EO",
                page: 30
            }
        }
    };
}

function diagramDoc({ outputName, outputId, outputImg, outputPack, dc, components, ingredientsText, sort, folderId }) {
    const id  = makeId(`Diagram: ${outputName}`, "diagram");
    const compList = components.map(c => ({
        uuid: c.uuid,
        name: c.name,
        quantity: c.quantity
    }));
    return {
        _id: id,
        /* Recipe name = just the output's name (no "Diagram: " prefix).
         * The item type is already "diagrams", so the prefix was redundant. */
        name: outputName,
        type: "diagrams",
        img:  ICON_DIAGRAM,
        system: {
            description:        `<p>Crafting blueprint for ${outputName}.</p>${ingredientsText ? `<p><em>Ingredients:</em> ${ingredientsText}</p>` : ""}`,
            weight:             0.1,
            quantity:           1,
            cost:               Math.max(50, Math.floor(dc * 10)),
            availability:       "rare",
            kind:               "diagram",
            level:              "master",
            type:               "alchemical",
            alchemyDC:          dc,
            craftingDC:         0,
            requiresForge:      false,
            investment:         0,
            learned:            false,
            craftingTime:       "30 Minutes",
            craftingComponents: compList,
            alchemyComponents:  {},
            associatedItem: {
                name: outputName,
                uuid: `Compendium.${SYSTEM_ID}.${outputPack}.Item.${outputId}`,
                img:  outputImg
            },
            outputEnhanced:   "",
            outputSuperior:   "",
            potencyNormal:    0,
            potencyEnhanced:  0,
            potencySuperior:  0,
            memorizedFrom:    ""
        },
        effects: [],
        folder: folderId ?? null,
        sort: sort ?? 100,
        ownership: { default: 0 },
        flags: {
            "witcher-ttrpg-death-march": {
                book: "EO",
                page: 59
            }
        }
    };
}

/* ── Run ─────────────────────────────────────────────────────────── */

const OUT_KIT      = join(SRC, "eo-witcher-alchemy");
/* Witcher-alchemy diagrams ALSO live in eo-witcher-alchemy now (the pack
 * holds the decoctions/potions AND their crafting recipes). They used to
 * live in eo-diagrams alongside every other crafting blueprint. */
const OUT_DIAGRAMS = OUT_KIT;

if (existsSync(OUT_KIT)) rmSync(OUT_KIT, { recursive: true, force: true });
mkdirSync(OUT_KIT, { recursive: true });

/* Folders — three:
 *   Witcher Potions    — actual potion / elixir items (Wolf, Bear, Bindweed…)
 *   Witcher Decoctions — actual decoction items (Alp, Foglet…)
 *   Witcher Formulae   — recipes/diagrams that craft the above (PDF uses
 *                        "Formula" for the crafting recipe, not the brewed
 *                        drink itself; the old name was wrong) */
const folderPotions    = folderDoc("Witcher Potions",    0);
const folderDecoctions = folderDoc("Witcher Decoctions", 1);
const folderFormulae   = folderDoc("Witcher Formulae",   2);
writeFileSync(join(OUT_KIT, `_folder_${slugify(folderPotions.name)}.json`),
    JSON.stringify(folderPotions, null, 2));
writeFileSync(join(OUT_KIT, `_folder_${slugify(folderDecoctions.name)}.json`),
    JSON.stringify(folderDecoctions, null, 2));
writeFileSync(join(OUT_KIT, `_folder_${slugify(folderFormulae.name)}.json`),
    JSON.stringify(folderFormulae, null, 2));

/* Build a name→id map for the alchemicals BEFORE writing the diagrams,
 * since Black Seagull's diagram references White Gull. */
const itemMap = new Map();   // name → { id, img, kind }
for (const f of FORMULAE) {
    itemMap.set(f.name, { id: makeId(f.name, "alchemical"), img: ICON_POTION, kind: "potion" });
}
for (const d of DECOCTIONS) {
    itemMap.set(d.name, { id: makeId(d.name, "alchemical"), img: ICON_DECOCTION, kind: "decoction" });
}

/* Emit formulae. */
let writtenItems = 0, writtenDiagrams = 0;
let sort = 100;
for (const f of FORMULAE) {
    const doc = alchemicalDoc({
        name: f.name,
        type: "potion",          /* RAW: all twelve are potions/elixirs */
        tox: f.tox,
        duration: f.duration,
        effect: f.effect,
        craftDC: f.craftDC,
        cost: formulaCost(f.tox, f.craftDC),
        folderId: folderPotions._id,
        sort
    });
    writeFileSync(join(OUT_KIT, `${slugify(f.name)}.json`),
        JSON.stringify(doc, null, 2));
    writtenItems++;
    sort += 100;

    /* Diagram. Most witcher formulae have "None" listed for ingredients
     * (player provides via Alchemy substances). White Gull / Black
     * Seagull are the only ones with explicit physical components. */
    const components = [];
    let ingredientsText = "None";
    if (f.craftComponents) {
        for (const c of f.craftComponents) {
            if (c.selfRef) {
                const ref = itemMap.get(c.selfRef);
                components.push({
                    uuid: `Compendium.${SYSTEM_ID}.eo-witcher-alchemy.Item.${ref.id}`,
                    name: c.selfRef,
                    quantity: c.quantity
                });
            } else {
                const uuid = COMPONENT_UUID[c.name];
                if (!uuid) throw new Error(`No UUID mapping for component "${c.name}"`);
                components.push({ uuid, name: c.name, quantity: c.quantity });
            }
        }
        ingredientsText = f.craftIngredientsText;
    }
    const dDoc = diagramDoc({
        /* Suffix the diagram label so the recipe-linker can't collide
         * a formula's "Diagram: Wolf" with the Wolf Steel Sword's
         * "Diagram: Wolf" (link-eo-diagrams keys on name). */
        outputName: `${f.name} Formula`,
        outputId:   itemMap.get(f.name).id,
        outputImg:  ICON_POTION,
        outputPack: "eo-witcher-alchemy",
        dc:         f.craftDC,
        components,
        ingredientsText,
        folderId:   folderFormulae._id,
        sort:       writtenItems * 100
    });
    writeFileSync(join(OUT_DIAGRAMS, `witcher-kit-${slugify(f.name)}.json`),
        JSON.stringify(dDoc, null, 2));
    writtenDiagrams++;
}

/* Emit decoctions. */
sort = 100;
for (const d of DECOCTIONS) {
    /* Combine effect + transmutation into one HTML blob. */
    const effect = `${d.effect}</p><p><strong>Transmutation:</strong> ${d.transmutation}`;
    const doc = alchemicalDoc({
        name: d.name,
        type: "decoction",
        tox: 75,
        duration: "30 Minutes",
        effect,
        craftDC: d.dc,
        cost: 500,
        folderId: folderDecoctions._id,
        sort
    });
    /* Override book page for decoctions. */
    doc.system.source = "EO pp.33-34";
    doc.flags["witcher-ttrpg-death-march"].page = 33;
    writeFileSync(join(OUT_KIT, `${slugify(d.name)}.json`),
        JSON.stringify(doc, null, 2));
    writtenItems++;
    sort += 100;

    /* Diagram: <Monster> Mutagen + 1 Bottle of Spirits */
    const mutagen = `${d.name} Mutagen`;
    const mutUuid = COMPONENT_UUID[mutagen];
    if (!mutUuid) throw new Error(`No mutagen UUID for "${mutagen}"`);
    const components = [
        { uuid: mutUuid, name: mutagen, quantity: 1 },
        { uuid: COMPONENT_UUID["Spirits"], name: "Spirits", quantity: 1 }
    ];
    const dDoc = diagramDoc({
        /* Suffix the diagram label so the recipe-linker can't collide
         * the Manticore decoction's "Diagram: Manticore" with the
         * Manticore Steel Sword's "Diagram: Manticore". */
        outputName: `${d.name} Decoction`,
        outputId:   itemMap.get(d.name).id,
        outputImg:  ICON_DECOCTION,
        outputPack: "eo-witcher-alchemy",
        dc:         d.dc,
        components,
        ingredientsText: `${mutagen} + 1 Bottle of Spirits`,
        folderId:   folderFormulae._id,
        sort: writtenDiagrams * 100
    });
    /* Decoction diagrams cite p.62 (the diagrams page). */
    dDoc.flags["witcher-ttrpg-death-march"].page = 62;
    writeFileSync(join(OUT_DIAGRAMS, `witcher-kit-${slugify(d.name)}-decoction.json`),
        JSON.stringify(dDoc, null, 2));
    writtenDiagrams++;
}

console.log(`✓ wrote ${writtenItems} alchemical items to ${OUT_KIT}`);
console.log(`✓ wrote ${writtenDiagrams} diagrams to ${OUT_DIAGRAMS}`);
console.log(`  • formulae: ${FORMULAE.length}`);
console.log(`  • decoctions: ${DECOCTIONS.length}`);
