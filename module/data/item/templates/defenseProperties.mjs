/**
 * Defense properties template — armor RAW fields (Core p.78-79).
 *
 *   {location}Stopping     : number  current SP at that location
 *   {location}MaxStopping  : number  max SP before damage erodes it
 *   bludgeoning            : number  damage-type modifier (DR)
 *   slashing               : number
 *   piercing               : number
 *   effects                : HTML    on-equip effects
 *   armorType              : enum    light / medium / heavy / shield (p.79)
 *   location               : enum    head / torso / arms / legs / full / Shield
 *                                    The capital-S "Shield" preserves the
 *                                    chrome's existing check
 *                                    (chrome/inventory.js:2105).
 *   encumbranceValue       : number  EV — penalty applied to REF/DEX (p.78),
 *                                    floor at 1. Magic users also subtract
 *                                    from Vigor per the EV & Magic sidebar.
 *   armorEnhancement       : number  AE — number of runes/glyphs that
 *                                    can be applied (p.78).
 *   availability           : enum    everywhere / common / poor / rare (p.78)
 *   reliability            : number  shield blocks-before-breaking (p.78)
 */

const fields = foundry.data.fields;

const LOCATIONS = ["head", "torso", "leftArm", "rightArm", "leftLeg", "rightLeg"];

const num = (initial = 0) => new fields.NumberField({ initial, integer: true, min: 0 });

export function defensePropertiesSchema() {
    const out = {};
    /* Per-location SP — one value per body slot so a hauberk can be
     * 10 SP torso / 5 SP arms (and arm damage doesn't drain chest SP).
     * The `location` enum (below) determines which of these slots the
     * armor actually covers; uncovered slots are forced to 0 in the
     * derivation step so stale values can't leak. */
    for (const loc of LOCATIONS) {
        out[`${loc}Stopping`]    = num();
        out[`${loc}MaxStopping`] = num();
    }
    /* Damage-type resistances are binary: the armor either resists
     * the damage type or it doesn't. Per the rulebook, armor mods
     * aren't quantitative — they grant a resistance category that
     * halves damage (or similar) when triggered. */
    out.bludgeoning      = new fields.BooleanField({ initial: false });
    out.slashing         = new fields.BooleanField({ initial: false });
    out.piercing         = new fields.BooleanField({ initial: false });
    out.effects          = new fields.HTMLField({ initial: "" });
    out.armorType        = new fields.StringField({ initial: "light" });
    out.location         = new fields.StringField({ initial: "torso" });
    out.encumbranceValue = num();
    out.armorEnhancement = num();
    out.availability     = new fields.StringField({ initial: "common" });
    /* Reliability — current/max pool. Shields track blocks remaining
     * (value) vs. total (max). Migrated from legacy single int in
     * ArmorData.migrateData. */
    out.reliability      = new fields.SchemaField({
        value: num(),
        max:   num()
    });
    /* Qualities catalog selections — same pattern as weapons. The active
     * catalog is `CONFIG.WITCHER.armor.qualities` (override-aware via
     * `getActiveArmorQualities`). `qualityValues` holds the per-key
     * parameter values for parameterized qualities. */
    out.qualities        = new fields.ArrayField(new fields.StringField(), { initial: [] });
    out.qualityValues    = new fields.ObjectField({ initial: {} });
    /* Socketed enhancement items (glyphs / armor mods). UUID reference +
     * cached name/img. ArmorData.prepareDerivedData recomputes effective
     * SP / resistances / EV from these without mutating the base fields.
     * Slot count is capped by `armorEnhancement` in the attach UI. */
    out.appliedEnhancements = new fields.ArrayField(new fields.SchemaField({
        uuid: new fields.StringField({ initial: "" }),
        name: new fields.StringField({ initial: "" }),
        img:  new fields.StringField({ initial: "" }),
        /* Under the EO armor model, armor-mod enhancements (type "armor")
         * consume from a specific body-location's AE pool. This field
         * records which location the slot was charged to. Empty under
         * RAW (single-bucket) and for glyphs (which consume from the
         * total enhancementSlots pool, location-agnostic). */
        location: new fields.StringField({ initial: "" })
    }), { initial: [] });
    /* Equipment Overhaul fields. All present unconditionally so values
     * survive a CE-toggle flip; only consumed when isCESubsystemEnabled
     * ("eoArmorModel") returns true.
     *   aeSlots          per-location Armor Enhancement count map (EO p.4
     *                    "AE slots ... tracked separately for each body
     *                    location"). The sum is the piece's total
     *                    physical-enhancement budget.
     *   enhancementSlots TOTAL glyph (En.) slots for the piece (EO uses
     *                    one number across all locations). Distinct from
     *                    the RAW `armorEnhancement` single bucket.
     *   armingJackKind   "none" | "jack" | "superiorSuit". Marks a piece
     *                    of armor AS an arming jack or a superior arming
     *                    suit.
     *   armoredArmingJackUpgrade
     *                    Same enum. For aketon-style armor that has paid
     *                    the +100 / +750-crown upgrade to also function
     *                    as a jack / superior suit (EO p.4).
     *   difficult        Armor with the Difficult property — requires a
     *                    worn arming jack to equip (EO p.4). */
    out.aeSlots = new fields.SchemaField({
        head:      num(),
        torso:     num(),
        leftArm:   num(),
        rightArm:  num(),
        leftLeg:   num(),
        rightLeg:  num()
    });
    out.enhancementSlots         = num();
    out.armingJackKind           = new fields.StringField({ initial: "none", choices: ["none", "jack", "superiorSuit"] });
    out.armoredArmingJackUpgrade = new fields.StringField({ initial: "none", choices: ["none", "jack", "superiorSuit"] });
    out.difficult                = new fields.BooleanField({ initial: false });
    return out;
}

/* Pre-validation migration: legacy `reliability: 10` becomes
 * `{ value: 10, max: 10 }`. Same shape as the weapon migration so
 * call sites consistently read `.value` / `.max`. Also converts the
 * old numeric damage-resistance fields to booleans — any positive
 * value becomes `true`, 0 becomes `false`. */
export function migrateArmorReliability(data) {
    if (typeof data.reliability === "number") {
        const n = data.reliability;
        data.reliability = { value: n, max: n };
    }
    for (const k of ["bludgeoning", "slashing", "piercing"]) {
        if (typeof data[k] === "number") data[k] = data[k] > 0;
    }
    return data;
}
