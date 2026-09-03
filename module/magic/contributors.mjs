/**
 * Contributed defences.
 *
 * The attack's `defence` parameter says how IT may be resisted. It cannot be
 * the only source of options, because the most important defences in this
 * game are owned by the DEFENDER and appear against magic that declares no
 * defence at all.
 *
 * The rules are explicit that `Defense: None` does not mean undefendable —
 * it means "cannot be defended against UNLESS the Dispel spell or Heliotrope
 * sign is used to defend against it". Fifty-two of the 103 core entries sit
 * in that category, so without contribution more than half the spell list has
 * no defence whatsoever.
 *
 * A contributor is not a cast. It is a standing declaration that an option
 * exists, under what conditions, at what price, and what happens if the
 * defender takes it.
 *
 * ── On tie direction ──────────────────────────────────────────────────────
 * Worth stating precisely, because it is easy to get backwards. `ties` names
 * WHO WINS A TIE.
 *
 *   Ordinary attacks   ties: "defender"  — the attacker must roll HIGHER
 *                                          (errata, p.164: "not equal to or
 *                                          higher"), so a tie is a miss.
 *   Heliotrope         ties: "defender"  — "equals or beats" from the
 *                                          defender's side is the SAME rule
 *                                          stated from the other end.
 *   Dispel             ties: "attacker"  — the dispeller must "beat their
 *                                          casting roll", so a tie leaves the
 *                                          original cast standing.
 *
 * So Heliotrope matches the house convention and Dispel is the exception —
 * the reverse of how it first reads.
 */

const CONTRIBUTORS = [];

/**
 * Register a standing defence option.
 *
 * @param {object} c
 * @param {string} c.id          the option name the defender is offered
 * @param {function} c.matches   (record) => boolean — is this attack in scope
 * @param {function} c.eligible  (owner, adapter) => boolean — may this actor use it
 * @param {function} [c.cost]    (record) => number — STA charged to attempt it
 * @param {string} [c.skill]     skill rolled to resolve it
 * @param {string} [c.ties]      who wins a tie: "defender" (default) | "attacker"
 * @param {Array}  [c.tree]      blocks run when it succeeds
 */
export function registerContributor(c) {
    const entry = Object.freeze({ ties: "defender", cost: () => 0, tree: [], ...c });
    CONTRIBUTORS.push(entry);
    return entry;
}

export function _resetContributors() { CONTRIBUTORS.length = 0; }
export function contributorCount() { return CONTRIBUTORS.length; }

/**
 * Every contributed option a given defender may use against a given cast.
 * Both predicates must pass: the attack must be in scope, and the defender
 * must be able to use it — which for Heliotrope means being a witcher who
 * can actually pay half the caster's expenditure.
 */
export function contributorsFor(owner, record, adapter) {
    return CONTRIBUTORS.filter(c => {
        try {
            if (!c.matches(record)) return false;
            if (!c.eligible(owner, adapter)) return false;
            const cost = c.cost(record);
            return cost <= adapter.currentStamina(owner);
        } catch { return false; }
    });
}

export function contributorById(id) {
    return CONTRIBUTORS.find(c => c.id === id) ?? null;
}

/* ── The two RAW contributors ─────────────────────────────────────────── */

export function registerCoreContributors() {

    /**
     * HELIOTROPE — book page 70, in the SKILLS chapter, not the Magic one.
     *
     *   "When a Witcher is targeted by a spell, invocation, or hex they can
     *    roll Heliotrope to attempt to negate the effects. They must roll a
     *    Heliotrope roll that equals or beats the opponent's roll and expend
     *    an amount of Stamina equal to half the Stamina spent to cast the
     *    magic."
     *
     * The cost is the interesting part: it is derived from the ATTACKER'S
     * expenditure, which means the caster's spend has to survive into the
     * defence step. A pipeline that consumes and discards it before targeting
     * cannot price this at all.
     *
     * Note the scope: spell, invocation, hex — signs and rituals are NOT
     * listed. Transcribed as printed rather than generalised.
     */
    registerContributor({
        id: "heliotrope",
        label: "Heliotrope",
        matches: (record) => ["spell", "invocation", "hex"].includes(record?.kind),
        /* Knowing the sign, not a skill rank in it: the system has no
         * `heliotrope` skill, so the old rank test could only return 0. */
        eligible: (owner, adapter) => !!adapter.isWitcher?.(owner)
                                   && !!adapter.knowsSpell?.(owner, "Heliotrope"),
        cost: (record) => Math.floor((record?.staSpent ?? 0) / 2),
        /* Rolled with Spell Casting — the sign has no skill of its own. */
        skill: "spellcast",
        ties: "defender",                       // "equals or beats"
        tree: [{ b: "core:negateMagic" }]
    });

    /**
     * DISPEL as a defensive action — book page 102, as amended by errata:
     * "It can be cast as a Defensive Action to block magic attacks with or
     * without physical components."
     *
     *   "To cancel a magical effect you must spend half as many Stamina
     *    points as the caster spent to cast the magic and make a Spell
     *    Casting roll that beats their casting roll."
     *
     * Same derived cost as Heliotrope, opposite tie direction, and available
     * to any caster who knows the spell rather than to witchers.
     */
    registerContributor({
        id: "dispel",
        label: "Dispel",
        matches: (record) => !!record?.kind,
        eligible: (owner, adapter) => !!adapter.knowsSpell?.(owner, "Dispel"),
        cost: (record) => Math.floor((record?.staSpent ?? 0) / 2),
        skill: "spellcast",
        ties: "attacker",                       // must "beat" — a tie fails
        tree: [{ b: "core:negateMagic" }]
    });
}
