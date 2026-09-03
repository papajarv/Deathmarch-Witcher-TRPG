/**
 * Reconciling the corpus's status names with the system's registered ones.
 *
 * Found by casting Aenye for real. The corpus says `onFire`; the system
 * registers `burning`; and the GM-side handler's response to a name it does
 * not know is to log a line and carry on:
 *
 *     handleApplyStatus: unknown status id "onFire" — ignoring
 *
 * Silently. The card still posts, the damage still lands, and the target
 * simply never catches fire — which nobody notices until three sessions later
 * when somebody asks why Igni has never once set anything alight.
 *
 * Two kinds of mismatch, and they need opposite fixes:
 *
 *   ALIASES — the system already has this condition under another name.
 *     `onFire` is `burning`, `frozen` is `freeze`, `death` is `dead`. Mapping
 *     is right; registering a second one would split the condition in two,
 *     so a target could be `burning` and `onFire` at once and Downpour would
 *     put out only one of them.
 *
 *   NEW — the condition genuinely does not exist yet. `compelled`, `charmed`,
 *     `polymorphed`. These have to be registered or the spells that apply them
 *     do nothing at all.
 *
 * Which is which is a judgement about the system, not about the spells, which
 * is why it lives here and not in the authored entries.
 */

/** Corpus name → the id the system already registers. */
export const STATUS_ALIASES = Object.freeze({
    onFire:      "burning",
    frozen:      "freeze",
    suffocating: "suffocation",
    death:       "dead",
    immobilised: "restrained",
    calmed:      "staggered"        // no distinct calm state; the closest RAW effect
});

/**
 * Conditions the spells need and the system does not have.
 *
 * Deliberately short. Every entry here is one the corpus applies and no
 * existing status covers — anything that could reasonably be an alias is one,
 * because a near-duplicate condition is worse than an imperfect match: two
 * statuses meaning the same thing means every rule that reads one misses the
 * other.
 */
export const MAGIC_STATUSES = Object.freeze([
    /* Mind. Three distinct states the book keeps apart: Axii's compulsion to
     * act, Puppet's outright control, and Light of Truth's compelled honesty. */
    { id: "compelled",        name: "WITCHER.Status.Compelled",       img: "icons/svg/daze.svg" },
    { id: "charmed",          name: "WITCHER.Status.Charmed",         img: "icons/svg/terror.svg" },
    { id: "compelledToTruth", name: "WITCHER.Status.CompelledToTruth", img: "icons/svg/eye.svg" },
    { id: "enraged",          name: "WITCHER.Status.Enraged",         img: "icons/svg/blood.svg" },
    { id: "fearless",         name: "WITCHER.Status.Fearless",        img: "icons/svg/upgrade.svg" },

    /* Mind Manipulation "allows you to force one target to feel one of the
     * following emotions for the duration of the spell: hatred, love,
     * depression, or euphoria." Four separate conditions, not one `emotional`
     * status with a parameter — the spell names them individually, they play
     * differently at the table, and a single status with a label inside it is
     * one nothing else can read. */
    { id: "hatred",           name: "WITCHER.Status.Hatred",          img: "icons/svg/terror.svg" },
    { id: "love",             name: "WITCHER.Status.Love",            img: "icons/svg/heal.svg" },
    { id: "depression",       name: "WITCHER.Status.Depression",      img: "icons/svg/downgrade.svg" },
    { id: "euphoria",         name: "WITCHER.Status.Euphoria",        img: "icons/svg/aura.svg" },

    /* Shape and body. */
    { id: "polymorphed",      name: "WITCHER.Status.Polymorphed",     img: "icons/svg/mystery-man.svg" },
    { id: "healingComa",      name: "WITCHER.Status.HealingComa",     img: "icons/svg/sleep.svg" },
    { id: "dismembered",      name: "WITCHER.Status.Dismembered",     img: "icons/svg/blood.svg" },
    { id: "branded",          name: "WITCHER.Status.Branded",         img: "icons/svg/fire.svg", showOnToken: false },

    /* Fire that is not the fire status. Eternal Judgement was an ALIAS onto
     * plain `burning` — which meant the card announced white fire and the world
     * received the ordinary kind: half the damage, and a "Put Out Fire" action
     * the book explicitly denies ("cannot be extinguished except by magic, or
     * by completely submerging underwater for 3 rounds"). An alias is the right
     * shape only when the system's condition IS the corpus's condition, and
     * here it is not: what ends it differs, which is the whole point of the
     * spell. Its own id, so `burning` keeps its self-clear and this one can
     * refuse it (see the clause in setup/statusClauses.mjs).
     *
     * Deliberately NOT burning's flame icon — a GM has to tell the two apart on
     * a token at a glance, because only one of them can be stamped out.
     *
     * Downpour still stops it: COUNTER_TAG_OF below tags this `fire`, and the
     * adapter refuses to land a tagged status inside a counteracting zone. That
     * is not a leak in the "cannot be extinguished" rule — Downpour is magic,
     * which is the exception the book itself grants. */
    { id: "whiteFire",        name: "WITCHER.Status.WhiteFire",       img: "icons/svg/sun.svg" },

    /* Position and movement. */
    { id: "gliding",          name: "WITCHER.Status.Gliding",         img: "icons/svg/wing.svg" },
    { id: "underwater",       name: "WITCHER.Status.Underwater",      img: "icons/svg/waterfall.svg" },
    { id: "stuckToMagnet",    name: "WITCHER.Status.StuckToMagnet",   img: "icons/svg/net.svg" },

    /* Sight and surroundings. Carried as statuses rather than as zone
     * membership because they follow the CREATURE — you stay blinded when you
     * leave the flare's radius, and you keep breathing when you swim out of
     * the air pocket only as long as the spell holds. */
    { id: "brightlyLit",      name: "WITCHER.Status.BrightlyLit",     img: "icons/svg/light.svg" },
    { id: "visionLimited4m",  name: "WITCHER.Status.VisionLimited",   img: "icons/svg/blind.svg" },
    { id: "breathing",        name: "WITCHER.Status.Breathing",       img: "icons/svg/regen.svg" },
    { id: "cleanAir",         name: "WITCHER.Status.CleanAir",        img: "icons/svg/regen.svg", showOnToken: false },
    { id: "shelteredFromWeather", name: "WITCHER.Status.Sheltered",   img: "icons/svg/aura.svg", showOnToken: false },

    /* Magic-visible links. */
    { id: "telepathicLink",   name: "WITCHER.Status.TelepathicLink",  img: "icons/svg/sound.svg", showOnToken: false },
    { id: "incorporeal",      name: "WITCHER.Status.Incorporeal",     img: "icons/svg/invisible.svg" }
]);

/**
 * Resolve a corpus status name to the id the system will actually accept.
 *
 * Unknown names come back unchanged rather than nulled: the GM handler already
 * logs what it does not recognise, and swallowing the name here would hide the
 * one signal that says a spell is asking for something that does not exist.
 */
export function resolveStatus(name) {
    return STATUS_ALIASES[name] ?? name;
}

/** Every id the engine may hand to `emitApplyStatus`. */
export function magicStatusIds() {
    return new Set([...MAGIC_STATUSES.map(s => s.id), ...Object.values(STATUS_ALIASES)]);
}


/**
 * Which suppression tag a status answers to.
 *
 * `core:counteract` names the thing being suppressed — "fire", "poison" — and
 * a status has to be recognisable as one of them for the suppression to bite.
 * Downpour "counteracts fire effects": that has to mean the burning it stops
 * a target catching, not a keyword nobody compares against.
 */
export const COUNTER_TAG_OF = Object.freeze({
    burning: "fire", onFire: "fire", whiteFire: "fire", branded: "fire",
    freeze: "water", frozen: "water", soaked: "water",
    poisoned: "poison", intoxicated: "intoxication",
    diseased: "disease", sick: "disease"
});

/** The tag a status answers to, or null when nothing suppresses it. */
export function counterTagOf(statusId) {
    return COUNTER_TAG_OF[statusId] ?? COUNTER_TAG_OF[resolveStatus(statusId)] ?? null;
}
