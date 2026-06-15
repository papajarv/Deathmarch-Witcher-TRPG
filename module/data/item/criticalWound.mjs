/**
 * CriticalWoundData — a critical wound applied to an actor (Core p.158-161,
 * p.174).
 *
 * A wound moves through three states. Each state has its OWN effect text,
 * mirroring the Effect / Stabilized / Treated columns on the Critical Wound
 * tables — the penalty lessens as the wound is cared for:
 *
 *   unstabilized  Freshly scored. The full Effect column applies. The victim
 *                 may be bleeding / dying. Cleared by a First Aid roll at the
 *                 wound's Healing Hands DC → stabilize().
 *   stabilized    "At a negative but no longer being killed by the wound."
 *                 The reduced Stabilized-column effect applies. Does NOT heal
 *                 on its own — a doctor's Healing Hands rolls move it on.
 *   treated       The doctor has done the work. The further-reduced Treated-
 *                 column effect applies and the natural-healing clock starts:
 *                 the wound clears once `healingTime` in-game days pass since
 *                 `treatedAt` (Critical Healing table, BODY + level). Deadly
 *                 wounds have no entry on that table — they never heal here.
 *
 * Only the BONUS damage from the original strike bypasses armor (p.158); that
 * is dealt once at strike time and is not modelled on the wound item — the
 * sheet surfaces it as reference.
 *
 * The healing clock is exposed as GETTERS (not stored / prepared fields) so it
 * reads `game.time.worldTime` live on every access. The sheets re-render on
 * `updateWorldTime` (see installSheetRefreshHooks), and because these are
 * getters the counter ticks with the world clock instead of freezing at the
 * value computed during the last document prepare.
 *
 * Schema:
 *   location         : "head" | "torso" | "rightArm" | "leftArm" | "rightLeg" | "leftLeg"
 *   criticalLevel    : "simple" | "complex" | "difficult" | "deadly"
 *   lesserEffect     : boolean   (lesser vs greater variant)
 *   state            : "unstabilized" | "stabilized" | "treated"
 *   description      : HTML  — Effect column (active while unstabilized)
 *   effectStabilized : HTML  — Stabilized column
 *   effectTreated    : HTML  — Treated column
 *   treatedAt        : number — game.time.worldTime (s) when treated; null otherwise
 *
 * Flat stat penalties are authored as standard Foundry ActiveEffects on the
 * wound item (the sheet's Effects field, same as alchemical items) and
 * transfer to the bearer; they aren't modelled in this schema.
 *
 * Derived getters:
 *   healingTime      : days to clear once treated (Critical Healing table)
 *   healDaysElapsed  : whole in-game days since treatedAt
 *   healPct          : 0-100 healing progress (treated, non-deadly)
 *   healComplete     : true once the clock has run out
 *   activeEffect     : the effect HTML for the current state
 */

const fields = foundry.data.fields;

const STATES = ["unstabilized", "stabilized", "treated"];

function secondsPerDay() {
    return game.time?.calendar?.secondsPerDay || 86400;
}

export class CriticalWoundData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            location:         new fields.StringField({ initial: "torso" }),
            criticalLevel:    new fields.StringField({ initial: "simple" }),
            lesserEffect:     new fields.BooleanField({ initial: false }),
            state:            new fields.StringField({ initial: "unstabilized", choices: STATES }),
            description:      new fields.HTMLField({ initial: "" }),
            effectStabilized: new fields.HTMLField({ initial: "" }),
            effectTreated:    new fields.HTMLField({ initial: "" }),
            treatedAt:        new fields.NumberField({ required: false, nullable: true, initial: null, integer: true }),
            // Status ids this wound inflicts while UNSTABILIZED (e.g. "bleed").
            // Reconciled onto the bearer by policy/wound-statuses.mjs: applied
            // while untreated, suppressed by immunity, resumed when immunity
            // lapses, cleared once the wound is stabilized.
            statuses:         new fields.ArrayField(new fields.StringField()),
            // Free-text provenance (book/supplement). criticalWound does not
            // spread baseItemSchema, so the shared source field is declared here.
            source:           new fields.StringField({ initial: "" })
        };
    }

    /**
     * Days to clear the Treated penalty (Critical Healing table, p.175 —
     * by BODY + level). simple = 8-BODY, complex = 12-BODY, difficult =
     * 15-BODY (each min 1); deadly = 0 (no natural heal — prosthesis only).
     */
    get healingTime() {
        const body = Number(this.parent?.parent?.system?.stats?.body?.max) || 0;
        switch (this.criticalLevel) {
            case "simple":    return Math.max(8  - body, 1);
            case "complex":   return Math.max(12 - body, 1);
            case "difficult": return Math.max(15 - body, 1);
            default:          return 0;  // deadly / unknown
        }
    }

    /** Whole in-game days elapsed since the wound was treated (0 until then). */
    get healDaysElapsed() {
        if (this.state !== "treated" || this.treatedAt == null) return 0;
        const now = Number(game.time?.worldTime) || 0;
        return Math.max(0, Math.floor((now - this.treatedAt) / secondsPerDay()));
    }

    /** Healing progress 0-100; 0 unless treated and non-deadly. */
    get healPct() {
        const time = this.healingTime;
        if (this.state !== "treated" || time <= 0) return 0;
        return Math.min(100, Math.round((this.healDaysElapsed / time) * 100));
    }

    /** True once a treated, non-deadly wound's clock has run out. */
    get healComplete() {
        const time = this.healingTime;
        return this.state === "treated" && time > 0 && this.healDaysElapsed >= time;
    }

    /** The effect HTML that applies in the current state. */
    get activeEffect() {
        return this.state === "treated"    ? this.effectTreated
             : this.state === "stabilized" ? this.effectStabilized
             :                               this.description;
    }

    /**
     * unstabilized → stabilized. The First Aid roll (DC = the wound's Healing
     * Hands DC) is resolved in the UI; this just records the success.
     */
    async stabilize() {
        if (this.state !== "unstabilized") return;
        await this.parent.update({ "system.state": "stabilized" });
    }

    /**
     * → treated. Records the world-time anchor so the natural-healing clock
     * starts from this moment. Idempotent for an already-treated wound.
     */
    async treat() {
        if (this.state === "treated") return;
        await this.parent.update({
            "system.state": "treated",
            "system.treatedAt": Number(game.time?.worldTime) || 0
        });
    }

    /**
     * Fully resolve the wound — remove it from the actor. Called by the
     * autoheal sweep once the healing clock runs out, and by the GM's manual
     * "Resolve" action.
     */
    async resolve() {
        await this.parent?.delete();
    }

    calcWeight() {
        return 0;
    }
}
