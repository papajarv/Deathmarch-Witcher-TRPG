// tools/gen-skill-books.mjs
//
// Author skill-type books for every entry in SKILL_LIST.
//
// House rule (this campaign): skill books cap at rank 4. Higher ranks
// require a trainer. Four single-rank tiers per skill — each book takes the
// reader one step.
//
//   tier 1 — Primer    (0→1, DC 12, 40 c,  common)
//   tier 2 — Companion (1→2, DC 14, 80 c,  common)
//   tier 3 — Manual    (2→3, DC 16, 160 c, poor)
//   tier 4 — Treatise  (3→4, DC 18, 320 c, rare)
//
// Generated into packs-src/books/ under the "Skill" folder. Run standalone
// or after gen-books.mjs, then:
//   node tools/build-packs.mjs books

import { writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, "..");
const OUT_DIR   = resolve(ROOT, "packs-src/books");

const hashId = (s) => createHash("sha1").update(s).digest("hex").slice(0, 16);
const slug   = (s) => s.toLowerCase().replace(/[''']/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);

/* ── Tier ladder ─────────────────────────────────────────────────────── */

const TIERS = [
    { label: "Primer",    rangeMin: 0, rangeMax: 1, dc: 12, cost: 40,  weight: 0.4, availability: "common",
      cover: "A slim cheap chapbook bound in unglazed brown paper, dog-eared and much-thumbed, the sort a village schoolmaster passes to a promising pupil." },
    { label: "Companion", rangeMin: 1, rangeMax: 2, dc: 14, cost: 80,  weight: 0.5, availability: "common",
      cover: "A stouter working octavo bound in tooled brown calf, spine grown supple with use; the paper carries pencil-notes in three different hands." },
    { label: "Manual",    rangeMin: 2, rangeMax: 3, dc: 16, cost: 160, weight: 0.7, availability: "poor",
      cover: "A serious quarto in dark purple boards with the title debossed in silver, its endpapers marbled and its margins already claimed by whichever previous student was most rigorous." },
    { label: "Treatise",  rangeMin: 3, rangeMax: 4, dc: 18, cost: 320, weight: 0.9, availability: "rare",
      cover: "A rare tall folio bound in gold-stamped calf with proper leather ties, its paper heavy enough to survive an academy library, its author's name given only in initials on the reverse of the title page." }
];

/* Icon theme families — each is 4 progression icons matching Primer →
 * Companion → Manual → Treatise. All slugs verified against Foundry core
 * icons/sundries/books/. */
const THEME_ICONS = {
    brown:  ["book-worn-brown",        "book-embossed-bound-brown",         "book-embossed-steel-brown",         "book-tooled-gold-brown"],
    green:  ["book-worn-green",        "book-embossed-roots-green",         "book-embossed-gold-green",          "book-embossed-jewel-gold-green"],
    blue:   ["book-worn-blue",         "book-embossed-blue",                "book-symbol-cross-blue",            "book-embossed-jewel-blue-red"],
    red:    ["book-worn-red",          "book-red-cross",                    "book-embossed-gold-red",            "book-tooled-eye-gold-red"],
    purple: ["book-worn-purple",       "book-purple-detail",                "book-embossed-spiral-purple-white", "book-embossed-jewel-gold-purple"],
    grey:   ["book-worn-brown-grey",   "book-tooled-grey",                  "book-black-grey",                   "book-embossed-jewel-silver-green"],
    teal:   ["book-worn-teal",         "book-turquoise-moon",               "book-teal-lightning",               "book-backed-blue-gold"],
    gold:   ["book-plain-orange",      "book-tooled-brass-brown",           "book-tooled-gold-brown",            "book-backed-silver-gold"]
};

/* Per-skill theme choice. Skills fall back to `brown` if omitted. */
const SKILL_THEME = {
    // INT
    awareness: "grey", business: "gold", deduction: "blue", education: "blue",
    commonspeech: "brown", eldersp: "green", dwarven: "brown", monster: "grey",
    socialetq: "gold", streetwise: "grey", tactics: "blue", teaching: "brown",
    wilderness: "green",
    // REF
    brawling: "brown", dodge: "grey", melee: "brown", riding: "brown",
    sailing: "teal", smallblades: "grey", staffspear: "brown", swordsmanship: "grey",
    // DEX
    archery: "brown", athletics: "green", crossbow: "brown", sleight: "purple",
    stealth: "grey",
    // BODY
    physique: "brown", endurance: "green",
    // EMP
    charisma: "gold", deceit: "purple", finearts: "gold", gambling: "red",
    grooming: "purple", perception: "blue", leadership: "gold", persuasion: "gold",
    performance: "gold", seduction: "red",
    // WILL
    courage: "blue", hexweave: "red", intimidation: "grey", spellcast: "purple",
    resistmagic: "blue", resistcoerc: "grey", ritcraft: "purple",
    // CRA
    alchemy: "green", cooking: "brown", crafting: "brown", disguise: "purple",
    firstaid: "red", forgery: "purple", picklock: "grey", trapcraft: "brown"
};

/* ── Skill catalog: 4 bespoke [name, one-sentence desc] tuples per skill ─ */

const SKILLS = {
    /* ── INT ─────────────────────────────────────────────────────────── */
    awareness: { stat: "int", tiers: [
        ["The Watchful Eye",                  "A trail-warden's primer on noticing what others overlook — wind shifts, missing birdsong, a saddle straightened by a guilty hand."],
        ["Noting the Unseen",                 "A second reader from the same warden, focused on small inconsistencies in crowds, camps, and the homes of people who claim to be alone."],
        ["The Observer's Method",             "A senior agent's manual on disciplined scanning — sectors, intervals, and the small habits that make a long watch survivable and useful."],
        ["On Reading the Room",               "Advanced exercises in court and tavern observation, written by a Redanian agent who outlived all of her handlers."]
    ]},
    business: { stat: "int", tiers: [
        ["Coin, Cart, and Common Sense",      "A burgher-aunt's handbook for newly-married couples opening their first shop in a small Pontar town."],
        ["The Steady Stall",                  "A guild-secretary's reader on stock, margin, and the slow art of keeping a stall open for a second year and a third."],
        ["The Merchant's Long Game",          "A senior factor's manual on credit, partnership, and the careful management of risk across a long trading season."],
        ["The Novigrad Ledger",               "A merchant-house master's notes on hidden tariffs, factoring, and the polite extortion of harbor officials."]
    ]},
    deduction: { stat: "int", tiers: [
        ["Following the Stray Thread",        "A retired bailiff's casebook on small-town theft, lost children, and the lies that unravel themselves under patient questioning."],
        ["The Bailiff's Casebook II",         "A second collection of provincial investigations — arson, missing livestock, the quiet feuds that become bodies in the snow."],
        ["On the Hidden Cause",               "A senior investigator's manual on motive, opportunity, and the patient triangulation of an answer that no witness will give freely."],
        ["The Inferential Method",            "An Oxenfurt fellow's essay on chained reasoning, written after she solved three murders the city watch had filed as accidents."]
    ]},
    education: { stat: "int", tiers: [
        ["The Apprentice's Companion",        "A scribe-master's reader covering letters, ciphers, weights, calendars, and the common errors of unschooled clerks."],
        ["The Second-Year Reader",            "An Oxenfurt junior textbook covering history, geography, and the early forms of disputation, with exercises at every chapter's end."],
        ["Inquiry and Method",                "A senior tutor's manual on citation, sources, and the disciplined construction of an argument a fellow cannot dismiss."],
        ["The Seven Disciplines",             "A standard Oxenfurt survey of rhetoric, logic, history, grammar, mathematics, natural philosophy, and theology."]
    ]},
    commonspeech: { stat: "int", tiers: [
        ["The Traveler's Common Tongue",      "A merchant's pocket grammar of the trade-tongue, with phrases for inns, customs houses, and irritated cart drivers."],
        ["The Town Clerk's Reader",           "A burgher's second grammar for those whose work now requires writing as well as speaking — petitions, receipts, depositions, oaths."],
        ["Style and Register",                "A senior clerk's manual on tone and register — how to write to a duke, a guild-master, a constable, and a furious mother-in-law without offending any of them."],
        ["Idioms and Polite Lies",            "An advanced manual of regional dialect, courtly euphemism, and the small wordings that mark a foreigner."]
    ]},
    eldersp: { stat: "int", tiers: [
        ["A Northern Reader of Hen Llinge",   "An introductory grammar compiled from elven inscriptions, sympathetic in tone, occasionally wrong about cases."],
        ["The Second Reader",                 "A continuation volume from the same author, now with longer passages and the first honest attempt at the Aen Seidhe future tense."],
        ["On Aen Seidhe Poetry",              "A senior scholar's manual on meter, kenning, and the small grammatical fossils that make elven verse so difficult to translate honestly."],
        ["Songs of Lara Dorren",              "A poetic anthology with parallel translation, intended as language practice for serious students of the Aen Seidhe."]
    ]},
    dwarven: { stat: "int", tiers: [
        ["The Mahakam Phrasebook",            "A trader's companion to mountain-tongue greetings, oaths, weight-measures, and the proper way to refuse a sixth ale."],
        ["The Trader's Second Reader",        "A continuation grammar with passages on contract, partnership, and the dwarven legal idioms a human merchant must read carefully."],
        ["Custom and Clan-Speech",            "A senior scholar's manual on clan honorifics, hearth-titles, and the dialectal shifts between the upper and lower halls of Mahakam."],
        ["Hammers and Honour",                "An advanced reader of dwarven legal poetry, drafted by a Mahakam clan-recorder for outside scholars who promised to behave."]
    ]},
    monster: { stat: "int", tiers: [
        ["A Bestiary for the Cautious",       "A village-elder's field guide to common Northern threats — drowners, ghouls, nekkers — written for folk who do not own a silver sword."],
        ["The Hunter's Field Guide",          "A working bestiary by a retired monster-hunter, with notes on tracks, leavings, and the regional behaviours that printed bestiaries get wrong."],
        ["On the Marks They Leave",           "A senior witcher's manual on identifying species from spoor, kill-marks, and the small environmental disturbances that precede a hunt."],
        ["The Hierarchy of Monstrous Kinds",  "A Witcher-school taxonomy of Necrophages, Specters, Hybrids, and Relicts, with notes on substance distillation."]
    ]},
    socialetq: { stat: "int", tiers: [
        ["Courtesies for the Country Visitor","A tutor's handbook for minor gentry sending children to court for the first time — bows, address, what not to discuss at table."],
        ["The Court Newcomer's Reader",       "A second volume on minor courts and lesser titles — how to move through a chapel, a ballroom, and a long-table dinner without giving offence."],
        ["On Precedence and Address",         "A senior chamberlain's manual on the cold mathematics of seating, procession, and the form of address required by every shade of rank."],
        ["The Lesser Houses' Book of Forms",  "A heraldic and procedural manual for moving safely between the courts of Redania, Temeria, Kaedwen, and Aedirn."]
    ]},
    streetwise: { stat: "int", tiers: [
        ["A Stranger's Guide to Novigrad",    "A pickpocket's discarded notebook, lightly corrected by the constable who confiscated it."],
        ["The Quarter's Inner Ways",          "A second volume with route-notes for moving discreetly between the river quarters, the temple district, and the small lanes the watch prefers not to enter."],
        ["On Marks, Fixers, and Whisper-Lines","A senior operator's manual on the social geometry of the city — who passes word to whom, who collects, and who can be safely asked for a favour."],
        ["The Shadow Markets",                "A fence's reflective treatise on the unwritten laws of contraband, fixed prices, and informants who live longer than most."]
    ]},
    tactics: { stat: "int", tiers: [
        ["The Sergeant's Square",             "A campaign-veteran's primer for new file-leaders covering march order, picket placement, and how to refuse a stupid order politely."],
        ["The Lieutenant's Reader",           "A second volume on small-unit deployment, scouting, and the early-warning protocols that keep a company from being surprised on the road."],
        ["On Ground and Maneuver",            "A senior staff officer's manual on terrain, reserve, and the slow art of moving troops to a place where the enemy must fight on poor footing."],
        ["On Engagement and Withdrawal",      "A Kaedweni captain's monograph on broken-ground warfare, with diagrams that have started several arguments in officers' messes."]
    ]},
    teaching: { stat: "int", tiers: [
        ["The Patient Hand",                  "An older monk's gentle handbook on instructing children, apprentices, and adults who insist they already know."],
        ["The Instructor's Reader",           "A second volume on lesson structure, repetition, and the small encouragements that keep an apprentice present for a third year."],
        ["On Demonstration and Drill",        "A senior master's manual on the careful staging of practical exercises and the discipline of correcting a student in front of peers without humiliating them."],
        ["On the Transmission of Craft",      "A masters'-guild essay on apprenticeship, examination, and the slow art of correcting without humiliating."]
    ]},
    wilderness: { stat: "int", tiers: [
        ["The Outdoorsman's Companion",       "A retired trapper's practical guide to firecraft, shelter, dry tinder, and the seven mistakes that kill amateurs in the Pontar woods."],
        ["The Wayfarer's Reader",             "A second volume on multi-day travel — water sourcing, river fording, and the small daily rituals that keep a party from quietly falling apart in the wet."],
        ["On Reading Land and Weather",       "A senior surveyor's manual on slope, drainage, and the early signs in cloud and bird that warn of weather hard enough to kill the unprepared."],
        ["Maps Without Roads",                "An advanced wilderness manual on navigation by star, slope, and root, written by a surveyor who has crossed the Mahakam foothills four times."]
    ]},

    /* ── REF ─────────────────────────────────────────────────────────── */
    brawling: { stat: "ref", tiers: [
        ["The Tavern Floor",                  "A retired pit-fighter's blunt handbook on stance, balance, and ending things before they start."],
        ["The Bouncer's Reader",              "A second volume on managing tavern crowds, removing the loud without breaking them, and the rare moment a blade comes out of a sleeve."],
        ["On Bone and Joint",                 "A senior unarmed instructor's manual on locks, throws, and the practical anatomy of a fight at arm's length."],
        ["The Closed Distance",               "An advanced grappling treatise from a Kaedweni guard captain, illustrated with anatomical diagrams of the throat and elbow."]
    ]},
    dodge: { stat: "ref", tiers: [
        ["Footwork for the Living",           "A travelling fencing-master's primer on stance, recovery, and the simple rule that a step back is also a step away from death."],
        ["The Second Drill",                  "A continuation volume of footwork drills focused on changes of line, broken tempo, and the discipline of moving before the eye decides where."],
        ["On Range and Tempo",                "A senior fencing-master's manual on measure and timing — when to retreat, when to enter, and the small footwork that buys a heartbeat from a faster opponent."],
        ["Reading the Strike",                "An advanced guide to anticipation drills, written by an Aretuza guard who insists most fights are decided before the blade moves."]
    ]},
    melee: { stat: "ref", tiers: [
        ["The Country Sword Manual",          "A militia drillmaster's plain-text guide to footwork, guards, and the half-dozen cuts that win most country brawls."],
        ["The Soldier's Reader",              "A second volume for line soldiers on weapon-and-shield, formation footwork, and the small rules that keep one alive in a press."],
        ["On Guard and Recovery",             "A senior weapons-master's manual on the disciplined return to guard after every cut, and the slow correction of the bad habits a militia drill cannot reach."],
        ["Of Iron and Edge",                  "A campaign veteran's advanced treatise on armoured melee, including notes on weapon balance, wear, and rotational fatigue."]
    ]},
    riding: { stat: "ref", tiers: [
        ["The Beginner's Saddle",             "A stable-master's gentle introduction to mounting, posture, and the small kindnesses that make a horse trust you."],
        ["The Yard-Hand's Reader",            "A second volume on care, grooming, and the daily rhythm of stable work that turns a rider into a horsewoman."],
        ["On Pace and Gait",                  "A senior cavalry instructor's manual on transitions, lengthening, and the conditioning that lets a sound horse carry one through a long campaign."],
        ["Long Roads, Sound Horse",           "An advanced rider's manual on endurance, lameness, river crossings, and the discipline of dismounting before the animal needs you to."]
    ]},
    sailing: { stat: "ref", tiers: [
        ["The Coastal Hand",                  "A river-pilot's primer for fresh hands on smaller vessels — knots, points of sail, and the early-warning signs of a captain who drinks."],
        ["The Mate's Reader",                 "A second volume on watchkeeping, sail-handling under wind, and the small responsibilities of a hand the captain has begun to trust."],
        ["On Set and Trim",                   "A senior bosun's manual on sail-setting, trim, and the patient correction of a vessel that wants to round up when she shouldn't."],
        ["Winds, Tides, and Skellige",        "An advanced seamanship manual focused on the northern routes, with chapters on storm-tactics, dead reckoning, and reading the islanders' moods."]
    ]},
    smallblades: { stat: "ref", tiers: [
        ["The Discreet Blade",                "A traveling courier's pocket guide to the dagger and stiletto — concealment, draw, and the moral arithmetic of opening someone's vein in a city street."],
        ["The Knife-Hand's Reader",           "A second volume on entry, exit, and the small footwork that keeps an opponent from closing on the strong arm."],
        ["On the Inside Line",                "A senior instructor's manual on close-quarters knife-work, parry into bind, and the deliberate use of an off-hand to control the opponent's weapon."],
        ["The Quick and the Quiet",           "An advanced treatise on close-quarters knife-work and parrying daggers, written under an alias and circulated only among professionals."]
    ]},
    staffspear: { stat: "ref", tiers: [
        ["The Quarterstaff's Lessons",        "A monastic drill-book covering grip, leverage, and the use of a stout pole as both weapon and walking aid."],
        ["The Yard Drill-Book",               "A second volume of training-yard exercises with spear and quarterstaff — pairs, lines, and the slow building of a working measure."],
        ["On Point and Butt",                 "A senior drillmaster's manual on the dual employment of the spear — thrust with the point, strike with the butt, and the footwork between them."],
        ["The Long Reach",                    "An advanced manual of spear and pike combat, written by a Temerian sergeant who survived three formation-breaks at the Yaruga."]
    ]},
    swordsmanship: { stat: "ref", tiers: [
        ["The Long Blade, First Lessons",     "An academy reader for noble children: posture, the four guards, and why one bows to the master, not to the sword."],
        ["The Second Volume of the Sword",    "A second-year reader on footwork drill, recovery, and the slow building of measure and tempo."],
        ["On Bind and Cut",                   "A senior swordsman's manual on bind, lever, and the geometry of forcing a weaker line into one's preferred angle."],
        ["Treatise on the Long Blade",        "A master-of-arms' analytical text on cuts, binds, and the geometry of the longsword — the standard volume at Ban Ard."]
    ]},

    /* ── DEX ─────────────────────────────────────────────────────────── */
    archery: { stat: "dex", tiers: [
        ["The Steady Hand",                   "A bowyer's primer on draw, anchor, release, and the slow patience that separates archers from arrow-flingers."],
        ["The Bowman's Reader",               "A second volume on quiver discipline, arrow selection, and the standing drills that make a useful warbow archer in a single summer."],
        ["On Holds and Releases",             "A senior captain-of-archers' manual on long-range volley, instinctive release, and the small variations of anchor that survive a long day's shooting."],
        ["Wind, Distance, and Will",          "An advanced longbow manual from a forester of the Pontar uplands, with detailed wind charts and notes on arrow selection."]
    ]},
    athletics: { stat: "dex", tiers: [
        ["The Sound Body",                    "An infantry physical-training handbook covering running, climbing, swimming, and the daily discipline that makes a soldier useful."],
        ["The Soldier's Conditioning Manual", "A second volume of progressive drill — distance, load, and the careful building of a body that can march and fight in the same day."],
        ["On Strength, Speed, and Stamina",   "A senior trainer's manual on the relationship between strength, sprint, and long-effort, with notes on rest, diet, and signs of decline."],
        ["Endurance and Recovery",            "An advanced volume on conditioning, rest, and the recognition of overtraining, written by a Witcher-trained physician."]
    ]},
    crossbow: { stat: "dex", tiers: [
        ["The Mechanic's Bow",                "A guildsman's plain-language guide to the crossbow — loading, sighting, span and trigger maintenance, and the rules for use in a city."],
        ["The Quarrelman's Reader",           "A second volume on bolt selection, ranging shots, and the small mechanical adjustments a fielded crossbow tolerates between repairs."],
        ["On Span and Trigger",               "A senior armourer's manual on lath-construction, trigger geometry, and the careful tuning of release and sear that separates a fielded weapon from a workshop curiosity."],
        ["The Cranequin and the Goat",        "An advanced treatise on heavy crossbows, including notes on the windlass, the cranequin, and the slow reload's place in modern warfare."]
    ]},
    sleight: { stat: "dex", tiers: [
        ["Quick Fingers, Light Touch",        "A street-performer's handbook on coin-vanishing, card-passing, and the harmless deceptions that keep a tavern audience laughing."],
        ["The Showman's Reader",              "A second volume of stage-routine and table-work, with notes on patter, misdirection, and the strict rule that one practices in a closed room."],
        ["On Palm, Pass, and Misdirection",   "A senior performer's manual on the three foundational moves of sleight, with detailed breakdowns of timing, line of sight, and the small social arts that hide the work."],
        ["The Discreet Hand",                 "An advanced manual on serious sleight — picking pockets, palming keys, and the etiquette of professional thieves who wish to remain anonymous."]
    ]},
    stealth: { stat: "dex", tiers: [
        ["The Quiet Step",                    "A poacher's primer on moving in woodland and town without leaving sound, scent, or witnesses."],
        ["The Forester's Second Reader",      "A continuation volume on long approach, blind-spotting, and the small daily habits that keep a poacher out of the gallows."],
        ["On Shadow and Cover",               "A senior agent's manual on cover-use, light discipline, and the precise rhythms of movement that defeat a watcher's attention."],
        ["Shadow and Patience",               "An advanced stealth manual focused on indoor work — corridors, locked rooms, sleeping households — written by an unnamed Redanian agent."]
    ]},

    /* ── BODY ────────────────────────────────────────────────────────── */
    physique: { stat: "body", tiers: [
        ["The Strong Back",                   "A blacksmith's daily-exercise primer for apprentices — lifting form, recovery, and the work that makes labor possible at fifty."],
        ["The Labourer's Reader",             "A second volume on progressive load, joint-care, and the body-mechanics that distinguish a smith at forty from a man who is broken at thirty."],
        ["On Lift, Carry, and Throw",         "A senior trainer's manual on heavy work — bracing, transfer, and the patient development of a frame that does not fail at the wrong moment."],
        ["On the Limits of the Body",         "An advanced strength manual by a campaign physician, with notes on tendon injury, conditioning, and the slow building of useful power."]
    ]},
    endurance: { stat: "body", tiers: [
        ["The Marching Heart",                "A drillmaster's primer on breath, pace, and the discipline of walking ten leagues with full kit."],
        ["The Courier's Reader",              "A second volume on multi-day work — water discipline, foot-care, and the small daily routines that keep a courier on the road for a full season."],
        ["On Long Days and Hard Nights",      "A senior campaigner's manual on the conditioning required for the deep field, with chapters on cold-weather work and the early signs of frostbite."],
        ["Of Cold, Heat, and Hunger",         "An advanced survival treatise on enduring the Continent's worst weather, written by a courier who has carried winter mail through Kaedwen for thirty years."]
    ]},

    /* ── EMP ─────────────────────────────────────────────────────────── */
    charisma: { stat: "emp", tiers: [
        ["The Listening Friend",              "A travelling preacher's gentle guide to warmth, attention, and the way a single kind question can reshape a long evening."],
        ["The Friend's Reader",               "A second volume on the small habits of being good company — remembering names, asking after children, and the kindness of a well-timed silence."],
        ["On Warmth and Bearing",             "A senior diplomat's manual on the disciplined warmth of presence — how to enter a room, how to leave it, and how to be remembered for the right reason."],
        ["Of Presence and Weight",            "An advanced essay on bearing, voice, and the careful art of being heard in a room one does not own."]
    ]},
    deceit: { stat: "emp", tiers: [
        ["The Honest Liar",                   "A travelling con-man's reflective handbook on small deceptions, written in retirement and addressed to his nephew."],
        ["The Confidence Man's Reader",       "A second volume on building plausible identities — the seven small things one must know about any town one claims to be from."],
        ["On the Long Con",                   "A senior swindler's manual on extended deception, mark-selection, and the cold mathematics of when to leave."],
        ["The Architecture of a Lie",         "An advanced treatise on long-form deception, identity construction, and the discipline of remembering one's own falsehoods."]
    ]},
    finearts: { stat: "emp", tiers: [
        ["The Apprentice's Brush",            "A studio-master's primer covering line, value, proportion, and the cheerful necessity of ruining a great deal of paper."],
        ["The Studio's Second Reader",        "A continuation volume on color, mixing, and the slow correction of an apprentice's tendency to overwork every passage."],
        ["On Light, Shadow, and Form",        "A senior painter's manual on the patient construction of volume, with notes on observation, edge-control, and the discipline of finishing before one ruins the work."],
        ["On Composition",                    "An advanced volume of theory and practice from an Oxenfurt master, focused on portraiture, draughtsmanship, and the deliberate use of negative space."]
    ]},
    gambling: { stat: "emp", tiers: [
        ["The Long Night at the Table",       "A retired card-player's primer on common games of the Northern realms, written more honestly than the games themselves are played."],
        ["The Player's Reader",               "A second volume on house-edge, bankroll, and the strict discipline of leaving the table at a planned stop, whether ahead or behind."],
        ["On Tells, Tempo, and Bankroll",     "A senior gambler's manual on opponent-reading, hand-disguising, and the slow cultivation of patience that separates the working player from the ruined one."],
        ["Odds, Tells, and Ruin",             "An advanced volume on probability, opponent-reading, and the strict bankroll discipline that separates gamblers from victims."]
    ]},
    grooming: { stat: "emp", tiers: [
        ["The Well-Kept Person",              "A valet's primer on hair, shave, dress, and the small daily kindnesses one owes to one's own body."],
        ["The Valet's Reader",                "A second volume on travel-kits, mending, and the discreet care of clothing that must look freshly attended after a long road."],
        ["On Fit, Fabric, and Finish",        "A senior tailor's manual on the small adjustments that distinguish a borrowed coat from a made one, with notes on regional cut and seasonal cloth."],
        ["The Courtly Wardrobe",              "An advanced manual of dress, cosmetic, and bearing for those who wish to move unremarkably in the higher courts of Redania and Temeria."]
    ]},
    perception: { stat: "emp", tiers: [
        ["Faces and Small Tells",             "A market-trader's primer on reading customers — the lifted eyebrow, the closing purse, the smile that lasts a beat too long."],
        ["The Watcher's Reader",              "A second volume on reading whole rooms — who is comfortable, who is performing comfort, and who is preparing to leave."],
        ["On Reading What Goes Unsaid",       "A senior diplomat's manual on attending to silence, hesitation, and the gestures by which people reveal a position they have not chosen to state."],
        ["The Honest Eye",                    "An advanced volume on attention, mood, and the slow craft of seeing through pretense without becoming cynical."]
    ]},
    leadership: { stat: "emp", tiers: [
        ["The Sergeant's Voice",              "A line-officer's primer on small-unit command — speaking clearly, owning a mistake, and being the first one tired and the last one fed."],
        ["The Captain's Reader",              "A second volume on company-level leadership — selecting subordinates, distributing tasks, and the small daily acknowledgements that build a unit's confidence."],
        ["On Order, Trust, and Punishment",   "A senior officer's manual on the careful balance of discipline, with chapters on the small mercies that make a hard order survivable."],
        ["On Command",                        "An advanced treatise by a retired Temerian colonel on the slow construction of trust, discipline, and the willingness to be obeyed."]
    ]},
    persuasion: { stat: "emp", tiers: [
        ["The Patient Voice",                 "A guild-mediator's primer on reasoned argument — listening first, naming the other side's case fairly, and never raising a voice that hasn't been raised first."],
        ["The Mediator's Reader",             "A second volume on framing, concession, and the small moments at which a disputant becomes willing to consider a thing they had refused to hear."],
        ["On Frame, Pace, and Concession",    "A senior advocate's manual on the slow choreography of persuasion — the small concessions that earn the right to ask for the larger one."],
        ["The Rhetorician's Art",             "An advanced volume on classical rhetoric — ethos, pathos, structure, refutation — written by an Oxenfurt master who occasionally argued for the wrong side on purpose."]
    ]},
    performance: { stat: "emp", tiers: [
        ["The Player's First Stage",          "A troupe-leader's primer on voice, gesture, audience, and the cheerful humiliation of one's first three or four bad performances."],
        ["The Player's Second Reader",        "A second volume on character work, projection, and the small choices that distinguish a player from a competent reciter of lines."],
        ["On Audience and Air",               "A senior actor's manual on the slow management of a room — pace, pause, and the small lifts and lowerings of energy that hold an audience for a full evening."],
        ["On Stagecraft and Song",            "An advanced volume on theatre, ballad, and recital, with chapters on timing, comic restraint, and the rare gift of silence."]
    ]},
    seduction: { stat: "emp", tiers: [
        ["The Open Door",                     "A retired courtesan's reflective primer on warmth, signal, and the kindness of letting someone retreat without humiliation."],
        ["The Suitor's Reader",               "A second volume on conversation, attention, and the small gifts that signal interest without obligating the recipient to anything they have not chosen."],
        ["On the Slow Approach",              "A senior charmer's manual on patience — the deliberate slowing of a courtship that the other party seems eager to hurry, and the dignity that survives both refusal and acceptance."],
        ["The Long Conversation",             "An advanced volume on charm, restraint, and the difficult art of being desired without lying about who one is."]
    ]},

    /* ── WILL ────────────────────────────────────────────────────────── */
    courage: { stat: "will", tiers: [
        ["The Steady Heart",                  "A village-priest's primer on small acts of courage — keeping one's word, speaking in the moment, refusing to flinch from useful work."],
        ["The Sentinel's Reader",             "A second volume on the discipline of long watch — staying awake, staying afraid in the right way, and acting before the body has finished being scared."],
        ["On Standing Firm",                  "A senior chaplain's manual on the slow management of fear under sustained pressure, with chapters on prayer, breath, and the small private rituals that keep a soldier in the line."],
        ["On Fear",                           "An advanced essay on the management of dread, written by a Witcher-trained chaplain who has seen what fear does and what it can be made to do."]
    ]},
    hexweave: { stat: "will", tiers: [
        ["A Reader for Hedge-Witches",        "A village mage's careful primer on minor weavings — protective knots, calming touches, the small magics that don't draw the wrong attention."],
        ["The Village Mage's Second Reader",  "A continuation volume on stronger weavings — household protection, livestock-binding, and the small discretion required when a neighbour begins asking too many questions."],
        ["On Bind, Knot, and Counter",        "A senior practitioner's manual on hex construction and disassembly, with diagrams clearly meant for someone who already knows the work."],
        ["On Curse and Counter-Curse",        "An advanced volume of hex-craft theory, with diagrams; sealed editions only and not to be left where a curious child might find it."]
    ]},
    intimidation: { stat: "will", tiers: [
        ["The Hard Eye",                      "A retired bouncer's plain-language primer on stance, voice, and the difference between threatening and committing."],
        ["The Enforcer's Reader",             "A second volume on collection work and the small theatre of pressure — entries, exits, and the strict rule that one does not threaten what one cannot or will not do."],
        ["On Stance, Voice, and Eye",         "A senior sheriff's manual on the controlled use of presence — how to fill a doorway without speaking, and how to leave a room without breaking it."],
        ["Authority Without Violence",        "An advanced treatise on extracting compliance without bloodshed, written by a sheriff who outlasted two of the bandits she retired."]
    ]},
    spellcast: { stat: "will", tiers: [
        ["The Novice's Cantrip Book",         "An Aretuza junior reader covering minor signs, focus exercises, and the strict rules about which spells may be cast where."],
        ["The Second-Year Spellbook",         "A continuation reader on intermediate weaves — defensive sigils, modest evocations, and the disciplined boundary between practice and live casting."],
        ["On Focus and Conduit",              "A senior caster's manual on attention, breath, and the slow tempering of the conduit that turns a competent novice into a working mage."],
        ["On the Channelling of Chaos",       "An advanced volume of spellcasting theory drawn from Ban Ard and Aretuza lectures, with notes on focus discipline and overdraw."]
    ]},
    resistmagic: { stat: "will", tiers: [
        ["Against the Whispering Touch",      "A temple primer on warding one's mind against minor enchantments — focus exercises, breathing patterns, and the daily discipline of doubt."],
        ["The Warded Mind's Reader",          "A second volume on stronger resistances — protective verses, mental anchors, and the small daily rituals that keep an active mind unsuggestible."],
        ["On Wards, Charms, and Stronger Wills","A senior anchorite's manual on the disciplined refusal of compulsion, with chapters on the early signs that a charm has taken hold."],
        ["The Unmoved Mind",                  "An advanced volume on resistance to higher magics, written by a courtier who had survived seven attempts to compel her."]
    ]},
    resistcoerc: { stat: "will", tiers: [
        ["The Quiet No",                      "A trial-advocate's primer on standing firm under pressure — questioning, intimidation, and the slow erosion of will."],
        ["The Witness's Reader",              "A second volume on enduring interrogation — what to say, what not to say, and the disciplined habit of answering only the question asked."],
        ["On Pressure, Silence, and Truth",   "A senior advocate's manual on hard questioning from both sides — the legitimate methods and the ones a careful witness must be ready to refuse."],
        ["Under Hard Questioning",            "An advanced treatise on resistance to coercion, written by a Redanian agent whose original copy bears bloodstains the editor has tactfully ignored."]
    ]},
    ritcraft: { stat: "will", tiers: [
        ["The Circle and the Stone",          "A primer on ritual fundamentals — sigil, focus, timing — written for hedge-priests and folk healers in plain country language."],
        ["The Hedge-Priest's Second Reader",  "A continuation volume on stronger rites — seasonal observances, household consecrations, and the strict discipline of preparation."],
        ["On Site, Hour, and Sign",           "A senior ritualist's manual on the careful selection of place and moment, with chapters on the small inadequacies that ruin a working."],
        ["On the Great Rites",                "An advanced volume of ritual magic theory and practice, restricted in Oxenfurt and Aretuza editions but circulated in censored form."]
    ]},

    /* ── CRA ─────────────────────────────────────────────────────────── */
    alchemy: { stat: "cra", tiers: [
        ["The Apprentice's Mortar",           "A village herbalist's primer on the nine substances, basic glassware, and the daily routines that keep a workshop from killing its owner."],
        ["The Journeyman's Reader",           "A second volume on extraction, calcination, and the small workshop disciplines that distinguish a careful alchemist from one whose neighbours are nervous."],
        ["On Heat, Time, and Vessel",         "A senior alchemist's manual on the relationship between fire, duration, and apparatus, with diagrams of regional still-types and their failure modes."],
        ["The Substances and Their Bonds",    "An advanced treatise on alchemical bonding and distillation, written by an Oxenfurt master whose laboratory has only burned down twice."]
    ]},
    crafting: { stat: "cra", tiers: [
        ["The Honest Workshop",               "A guild-master's primer on tools, materials, joinery, and the small daily habits that distinguish a craftsman from a hobbyist."],
        ["The Journeyman's Companion",        "A continuation volume on intermediate work — finishing, repair, and the small discipline of doing a job in fewer pieces than one is tempted to use."],
        ["On Joint, Grain, and Temper",       "A senior craftsman's manual on the structural disciplines of wood and steel, with chapters on the failures that are caught at the bench and the ones that fail in service."],
        ["The Materials of the North",        "An advanced manual on metal, wood, leather, and bone — origins, working temperatures, defects, and the small lies merchants tell about them."]
    ]},
    disguise: { stat: "cra", tiers: [
        ["Paint, Wig, and Posture",           "A theatre-troupe's primer on appearance and bearing — small physical tells that change who a person seems to be."],
        ["The Property-Master's Reader",      "A second volume on costume, prop, and the small visible details that earn an audience's first willing suspension."],
        ["On Voice, Gait, and Detail",        "A senior actor's manual on full inhabitation — the working accent, the corrected posture, and the small private rituals that keep one in character through a long evening."],
        ["The Borrowed Face",                 "An advanced manual on full disguise, voice, gait, and the slow discipline of inhabiting a falsified life without losing one's own."]
    ]},
    firstaid: { stat: "cra", tiers: [
        ["The Field Surgeon's Companion",     "A campaign-physician's primer on bleeding, breathing, broken bone, and the strict rule that one does not move a wounded comrade until one must."],
        ["The Field-Hospital Reader",         "A second volume on triage, splinting, and the small disciplined work that converts a panicked aid-station into a useful one."],
        ["On Bleeding, Bone, and Breath",     "A senior surgeon's manual on the management of serious trauma — pressure, immobilisation, and the careful judgment of which patient can be helped now."],
        ["On Wounds and Recovery",            "An advanced surgical treatise from an Oxenfurt-trained physician, with diagrams that respectable households generally store in a locked cabinet."]
    ]},
    forgery: { stat: "cra", tiers: [
        ["The Honest Hand",                   "An anonymous primer on ink, paper, seal, and the small habits by which scribes give themselves away — published, ironically, as a guide to detection."],
        ["The Scribe's Second Reader",        "A continuation volume on hand-imitation and document construction — the careful matching of pen, ink, and stroke pressure."],
        ["On Ink, Paper, and Seal",           "A senior forger's manual on the material side of the work — sourcing the right paper for a given year, aging an ink, and the small chemical tricks that defeat a casual examination."],
        ["The Borrowed Seal",                 "An advanced manual on document, ledger, and signet replication, circulated only among professionals and tax-evading nobles."]
    ]},
    picklock: { stat: "cra", tiers: [
        ["The Lockwright's Reader",           "A guild apprentice's primer on lock construction, tumbler, and the patient discipline of feel — written, technically, for locksmiths."],
        ["The Journeyman Lockwright's Reader","A continuation volume on warded locks, lever mechanisms, and the diagnostic technique of a smith asked to repair something the owner cannot describe."],
        ["On Tumbler, Tension, and Touch",    "A senior operator's manual on the fine technique of single-pin picking and tension control, with the strict observation that practice is the only path past page twenty."],
        ["The Quiet Tools",                   "An advanced manual on professional bypass — picks, tension, and the etiquette by which a serious operator avoids becoming a household story."]
    ]},
    trapcraft: { stat: "cra", tiers: [
        ["The Forester's Snare",              "A trapper's primer on snares, deadfalls, and the strict rules that keep one from catching one's own foot in one's own work."],
        ["The Sapper's Reader",               "A second volume on field-improvised mechanisms — alarm cords, simple deadfalls, and the careful documentation that lets a comrade pass safely tomorrow."],
        ["On Trigger, Spring, and Tether",    "A senior sapper's manual on the geometry of mechanical traps, with sober chapters on safe handling, marked withdrawal, and the recovery of one's own work."],
        ["On Mechanism and Trigger",          "An advanced treatise on mechanical traps — alarm, capture, and lethal — written by a retired sapper who insists his work was always purely defensive."]
    ]}
};

/* ── Folder ──────────────────────────────────────────────────────────── */

const FOLDER_NAME = "Skill";
const FOLDER_ID   = hashId(`book-folder-${FOLDER_NAME}`);

/* Remove any prior skill-book filenames (idempotent regen). Includes both
 * the root folder file and all per-skill subfolder files. */
for (const f of readdirSync(OUT_DIR)) {
    if (f.startsWith("skill-") && f.endsWith(".json")) unlinkSync(join(OUT_DIR, f));
    if (f === "_folder_skill.json") unlinkSync(join(OUT_DIR, f));
    if (f.startsWith("_folder_skill-") && f.endsWith(".json")) unlinkSync(join(OUT_DIR, f));
}

/* Root folder doc. */
writeFileSync(join(OUT_DIR, "_folder_skill.json"), JSON.stringify({
    _id: FOLDER_ID,
    name: FOLDER_NAME,
    type: "Item",
    folder: null,
    sorting: "a",
    description: "",
    color: null,
    sort: 500,
    flags: {}
}, null, 2) + "\n");

/* Per-skill subfolder display names — the raw skillId is a working key,
 * these are the labels the GM sees in the folder tree. */
const SKILL_DISPLAY = {
    awareness: "Awareness", business: "Business", deduction: "Deduction", education: "Education",
    commonspeech: "Common Speech", eldersp: "Elder Speech", dwarven: "Dwarven",
    monster: "Monster Lore", socialetq: "Social Etiquette", streetwise: "Streetwise",
    tactics: "Tactics", teaching: "Teaching", wilderness: "Wilderness Survival",
    brawling: "Brawling", dodge: "Dodge & Escape", melee: "Melee", riding: "Riding",
    sailing: "Sailing", smallblades: "Small Blades", staffspear: "Staff & Spear",
    swordsmanship: "Swordsmanship", archery: "Archery", athletics: "Athletics",
    crossbow: "Crossbow", sleight: "Sleight of Hand", stealth: "Stealth",
    physique: "Physique", endurance: "Endurance",
    charisma: "Charisma", deceit: "Deceit", finearts: "Fine Arts", gambling: "Gambling",
    grooming: "Grooming & Style", perception: "Human Perception", leadership: "Leadership",
    persuasion: "Persuasion", performance: "Performance", seduction: "Seduction",
    courage: "Courage", hexweave: "Hex Weaving", intimidation: "Intimidation",
    spellcast: "Spell Casting", resistmagic: "Resist Magic", resistcoerc: "Resist Coercion",
    ritcraft: "Ritual Crafting",
    alchemy: "Alchemy", cooking: "Cooking", crafting: "Crafting", disguise: "Disguise",
    firstaid: "First Aid", forgery: "Forgery", picklock: "Pick Lock", trapcraft: "Trap Crafting"
};

/* Emit one subfolder per skill, alphabetically sorted, parented under Skill. */
const skillFolderIds = {};
let subSort = 100;
for (const skillId of Object.keys(SKILLS).sort((a, b) => (SKILL_DISPLAY[a] || a).localeCompare(SKILL_DISPLAY[b] || b))) {
    const displayName = SKILL_DISPLAY[skillId] || skillId;
    const subId = hashId(`book-folder-Skill-${skillId}`);
    skillFolderIds[skillId] = subId;
    writeFileSync(join(OUT_DIR, `_folder_skill-${slug(skillId)}.json`), JSON.stringify({
        _id: subId,
        name: displayName,
        type: "Item",
        folder: FOLDER_ID,
        sorting: "a",
        description: "",
        color: null,
        sort: subSort,
        flags: {}
    }, null, 2) + "\n");
    subSort += 100;
}

/* ── Emit books ──────────────────────────────────────────────────────── */

let sort = 100, total = 0;
const skillIds = Object.keys(SKILLS);
const seenNames = new Set();

for (const skillId of skillIds) {
    const entry = SKILLS[skillId];
    const { stat, tiers } = entry;

    for (let i = 0; i < TIERS.length; i++) {
        const t = TIERS[i];
        const [name, desc] = tiers[i];

        const theme    = SKILL_THEME[skillId] || "brown";
        const iconSlug = THEME_ICONS[theme][i] || THEME_ICONS.brown[i];
        const iconPath = `icons/sundries/books/${iconSlug}.webp`;

        const doc = {
            _id: hashId(`skill-book:${skillId}:${t.label}`),
            name,
            type: "book",
            img: iconPath,
            system: {
                description: `<p>${t.cover}</p><p>${desc}</p><p><em>${t.label} · ${stat.toUpperCase()} / ${skillId} · ranks ${t.rangeMin}–${t.rangeMax}.</em></p>`,
                weight:   t.weight,
                cost:     t.cost,
                quantity: 1,
                equipped: false,
                isStored: false,
                encumb:   0,
                class:    "",
                source:   "",
                consumable: false,
                availability: t.availability,
                bookConfig: {
                    bookType: "skill",
                    monster:  {},
                    skill: {
                        skillStat: stat,
                        skillId,
                        rangeMin: t.rangeMin,
                        rangeMax: t.rangeMax,
                        dc:       t.dc
                    },
                    stress:   {}
                }
            },
            effects: [],
            folder: skillFolderIds[skillId] || FOLDER_ID,
            sort,
            ownership: { default: 0 },
            flags: {}
        };
        sort += 100;
        total++;

        let outName = `skill-${skillId}-${t.label.toLowerCase()}`;
        if (seenNames.has(outName)) outName = `${outName}-${doc._id.slice(0, 4)}`;
        seenNames.add(outName);

        writeFileSync(
            join(OUT_DIR, `${outName}.json`),
            JSON.stringify(doc, null, 2) + "\n"
        );
    }
}

console.log(`→ wrote ${total} skill book(s) across ${skillIds.length} skills × ${TIERS.length} tiers`);
