/**
 * gen-witcher-reborn.mjs — author the Witchers Reborn compendium content.
 *
 * Six schools, each as a `race` item. The four training perks are recorded
 * in the race's four quality boxes; the school's identity is stamped as a
 * flag (`flags.<system>.wr.school`) so mechanic hooks in the combat / spell
 * / defense mixins can gate on it. Each race also carries a transferring
 * ActiveEffect that grants the school's skill bonus (+4 primary, +2
 * secondary) via the DM action DSL — plus a set of `wr.<perk>` flag
 * writes so per-perk hooks (Blade Expertise, Sting, Combat Meditation …)
 * can detect ownership via `actor.getFlag()` at check time.
 *
 * Regenerate via:
 *   node tools/gen-witcher-reborn.mjs && node tools/build-packs.mjs witcher-reborn
 */

import { writeFileSync, readdirSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, "..");
const OUT_DIR   = resolve(ROOT, "packs-src/witcher-reborn");
const SYSTEM_ID = "witcher-ttrpg-death-march";

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

/* Deterministic id from a string — same helper the other generators use.
 * 16-char hex satisfies build-packs' _id length check. */
const hashId = (s) => createHash("sha1").update(s).digest("hex").slice(0, 16);
const slug   = (s) => s.toLowerCase().replaceAll(/[''']/g, "").replaceAll(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/* Each school gets its own medallion icon from the system assets. The
 * effect and perk item share the icon so the AE badge on the actor
 * sheet matches the perk in inventory. */
const SCHOOL_ICON = (key) => `systems/${SYSTEM_ID}/assets/medallions/${key}.png`;

/* ── Schools ─────────────────────────────────────────────────────────── */

const FOLDER_ID = hashId("wr-folder-witcher-reborn");

const SCHOOLS = [
    {
        key: "wolf",
        name: "Wolf School Witcher (Reborn)",
        skillBonus: { primary: "wilderness", primaryVal: 2, primaryStat: "int", label: "Wilderness Survival" },
        witcherTrainingBonus: 4,
        perks: [
            { key: "bladeExpertise",  name: "Blade Expertise",  desc: "You ignore the standard −3 penalty on Parry defenses." },
            { key: "balancedStance",  name: "Balanced Stance",  desc: "You may spend 5 STA to ignore a fumble of any kind." },
            { key: "calmMind",        name: "Calm Mind",        desc: "Adrenaline costs half STA. (Heroic action adrenaline spends still pay full cost.)" },
            { key: "stalkThePrey",    name: "Stalk the Prey",   desc: "After a successful witcher training check to recall information on a monster you have stalked, you may reroll one check against that monster." }
        ],
        heroic: { key: "pirouette", name: "Pirouette",
                  desc: "After a successful feint, you may spend any number of adrenaline dice (and their STA cost) to add +1 per die to your next attack's feint bonus (base +3, so N dice → +3+N). The bonus lasts until the end of your NEXT turn — if you end that turn without attacking the feinted target, the bonus is lost." }
    },
    {
        key: "cat",
        name: "Cat School Witcher (Reborn)",
        skillBonus: { primary: "athletics", primaryVal: 4, primaryStat: "dex", label: "Athletics",
                      secondary: "stealth",  secondaryVal: 2, secondaryStat: "dex", secondaryLabel: "Stealth" },
        perks: [
            { key: "bloodlust",       name: "Bloodlust",       desc: "You start every combat with 2 adrenaline dice already in your pool." },
            { key: "precisionStrike", name: "Precision Strike", desc: "+2 to your attack rolls when aiming for a specific hit location." },
            { key: "swiftRecovery",   name: "Swift Recovery",  desc: "You are not staggered when your attacks are parried." },
            { key: "lightStance",     name: "Light Stance",    desc: "You may spend 5 STA to ignore a fumble on Unarmed Defenses and Armed Attacks." }
        ],
        heroic: { key: "deadlyFocus", name: "Deadly Focus",
                  desc: "You may spend adrenaline dice (and their STA cost) to upgrade a critical you inflict — Simple → Complex costs 1 die, Complex → Difficult costs 2 dice, Difficult → Deadly costs 3 dice. A given critical can only be upgraded once." }
    },
    {
        key: "bear",
        name: "Bear School Witcher (Reborn)",
        skillBonus: { primary: "endurance", primaryVal: 4, primaryStat: "body", label: "Endurance",
                      secondary: "physique", secondaryVal: 2, secondaryStat: "body", secondaryLabel: "Physique" },
        perks: [
            { key: "juggernaut",   name: "Juggernaut",   desc: "You ignore 6 EV from armor for penalty calculations." },
            { key: "forcefulBlow", name: "Forceful Blow", desc: "You may spend 5 STA to reroll a strong attack's damage roll and keep the higher result (once per attack)." },
            { key: "perserver",    name: "Perserver",    desc: "When you receive a critical wound in combat, gain adrenaline based on its severity — Simple: 1 die, Difficult: 2 dice, Complex: 3 dice. Deadly wounds function as normal. (Grants are capped by BODY like any other adrenaline source.)" },
            { key: "heavyStance",  name: "Heavy Stance",  desc: "You may spend 5 STA to ignore a fumble on Armed Defenses and Attacks." }
        ],
        heroic: { key: "unrelenting", name: "Unrelenting",
                  desc: "When below your wound threshold, you may spend adrenaline (and its STA cost) to ignore the wound-state penalties for this round. At Death State, you may do the same to automatically pass this round's death save." }
    },
    {
        key: "griffin",
        name: "Griffin School Witcher (Reborn)",
        skillBonus: { primary: "spellcast", primaryVal: 4, primaryStat: "will", label: "Spell Casting",
                      secondary: "alchemy", secondaryVal: 2, secondaryStat: "cra", secondaryLabel: "Alchemy" },
        vigorBonus: 2,
        perks: [
            { key: "conduit",           name: "Conduit",           desc: "+2 Vigor." },
            { key: "combatMeditation",  name: "Combat Meditation", desc: "Adrenaline dice you pour into magic damage cost half stamina per die." },
            { key: "studiedWisdom",     name: "Studied Wisdom",    desc: "You may memorize double your INT in diagrams." },
            { key: "elementalControl",  name: "Elemental Control", desc: "You may spend 5 STA to ignore a magical fumble." }
        ],
        heroic: { key: "flowAndEbb", name: "Flow and Ebb",
                  desc: "May spend adrenaline dice (and their STA cost) to regenerate vigor points this turn — one vigor point per adrenaline die spent." }
    },
    {
        key: "viper",
        name: "Viper School Witcher (Reborn)",
        skillBonus: { primary: "stealth",   primaryVal: 4, primaryStat: "dex", label: "Stealth",
                      secondary: "athletics", secondaryVal: 2, secondaryStat: "dex", secondaryLabel: "Athletics" },
        perks: [
            { key: "bladeDance",   name: "Blade Dance", desc: "You do not receive the joint-attack penalty." },
            { key: "sting",        name: "Sting",       desc: "If your target is stunned or pinned, or your attack is an ambush, your attack becomes Armor Piercing. If it already has Armor Piercing, it becomes Improved Armor Piercing. And if it already has that, it gains +5 damage." },
            { key: "slither",      name: "Slither",     desc: "Your Relocate defense allows you to move over terrain vertically, jump gaps, or vault obstacles — but the distance of that terrain counts as double." },
            { key: "lightStance",  name: "Light Stance", desc: "You may spend 5 STA to ignore a fumble on Unarmed Defenses and Armed Attacks." }
        ],
        heroic: { key: "lightningFast", name: "Lightning Fast",
                  desc: "You may spend any number of adrenaline dice (and their STA cost) to extend your movement this round. Roll Nd6 and add the total (in meters) to your movement cap this round." }
    },
    {
        key: "manticore",
        name: "Manticore School Witcher (Reborn)",
        skillBonus: { primary: "melee",       primaryVal: 4, primaryStat: "ref", label: "Melee",
                      secondary: "wilderness", secondaryVal: 2, secondaryStat: "int", secondaryLabel: "Wilderness Survival" },
        perks: [
            { key: "alwaysReady",   name: "Always Ready",   desc: "Equipping or stowing a shield costs no action." },
            { key: "perfectParry",  name: "Perfect Parry",  desc: "No penalty for parrying with a shield." },
            { key: "riposte",       name: "Riposte",        desc: "Successfully parrying with a shield allows for an immediate bash or a single attack at the cost of 5 STA." },
            { key: "shieldMastery", name: "Shield Mastery", desc: "Can use quick items with a shield and a weapon." }
        ],
        heroic: { key: "standAside", name: "Stand Aside",
                  desc: "When adjacent to an ally, you may pay an adrenaline die (and its STA cost) to redirect an incoming attack against them onto yourself." }
    }
];

/* ── Folder ──────────────────────────────────────────────────────────── */

/* Clean anything we own before regen. */
for (const f of readdirSync(OUT_DIR)) {
    if (f.endsWith(".json")) unlinkSync(join(OUT_DIR, f));
}

writeFileSync(join(OUT_DIR, "_folder_witcher-reborn.json"), JSON.stringify({
    _id: FOLDER_ID,
    name: "Witchers Reborn",
    type: "Item",
    folder: null,
    sorting: "a",
    description: "",
    color: null,
    sort: 100,
    flags: {}
}, null, 2) + "\n");

/* ── Emit races ──────────────────────────────────────────────────────── */

/* Build a single transferring effect that stamps every school-flag the
 * mechanic hooks will read AND applies the skill-bonus skill.modifier
 * changes. Using the DM action DSL (flags.<sys>.actions[]) keeps parity
 * with the Human-race style seen in the base character pack. */
function buildRaceEffect(school) {
    const actions = [];
    const changes = [];

    /* One canonical school flag; hooks that only care about "which school
     * is this actor" read this. Individual per-perk flags land below so
     * hooks that care about a specific perk can gate cheaply. */
    actions.push({
        type: "modify", target: `flags.${SYSTEM_ID}.wr.school`,
        op: "set", value: school.key, when: "always"
    });

    /* Per-perk flag writes — each perk's mechanic hook will check
     * actor.getFlag(SYSTEM_ID, `wr.${perkKey}`) to see if the actor owns
     * it. Value is "1" (truthy) rather than boolean so the DSL's string
     * handling doesn't accidentally coerce false-y. */
    for (const p of school.perks) {
        actions.push({
            type: "modify", target: `flags.${SYSTEM_ID}.wr.${p.key}`,
            op: "set", value: "1", when: "always"
        });
    }
    /* Heroic action flag — the UI riders check this to decide whether to
     * render the button on the appropriate chat card / dock slot. */
    actions.push({
        type: "modify", target: `flags.${SYSTEM_ID}.wr.heroic`,
        op: "set", value: school.heroic.key, when: "always"
    });

    /* Skill bonus: primary. Value is the SKILL RANK (the level you have
     * in the skill), not the modifier. Modifiers can push a skill above
     * 10; ranks are the RAW-tracked training level. School bonuses are
     * training investments, so they add to rank. Additive so IP-bought
     * ranks still compose. */
    const sk = school.skillBonus;
    actions.push({
        type: "modify",
        target: `system.skills.${sk.primaryStat}.${sk.primary}.value`,
        op: "add", value: String(sk.primaryVal), when: "always"
    });
    if (sk.secondary) {
        actions.push({
            type: "modify",
            target: `system.skills.${sk.secondaryStat}.${sk.secondary}.value`,
            op: "add", value: String(sk.secondaryVal), when: "always"
        });
    }

    /* Wolf-specific: also grants "Witcher Training" as an initial skill.
     * (Not a system skill per se — recorded as a flag consumers can read
     * to gate the training-check flow.) */
    if (school.witcherTrainingBonus) {
        actions.push({
            type: "modify", target: `flags.${SYSTEM_ID}.wr.witcherTraining`,
            op: "set", value: String(school.witcherTrainingBonus), when: "always"
        });
    }

    /* Foundry v14 uses STRING change types on the AE change spec:
     *   "add" (arithmetic), "override" (set), "multiply", "upgrade",
     *   "downgrade". The old v10 numeric modes (2/5/etc.) get silently
     *   normalized to "custom" and never apply. All native changes here
     *   emit strings so the change engine actually runs them. */
    if (school.key === "bear") {
        /* Juggernaut writes 6 into the numeric ignoredArmorEV lifepath
         * modifier via an additive change. */
        changes.push({
            key: "system.lifepathModifiers.ignoredArmorEncumbrance",
            type: "add", value: "6", priority: 20
        });
    }

    if (school.key === "cat") {
        /* Bloodlust grants +2 starting adrenaline at combat start.
         * Piggybacks on combatMods.startingAdrenaline
         * (see policy/combat-round-reset.mjs applyStartingAdrenaline). */
        changes.push({
            key: "system.combatMods.startingAdrenaline",
            type: "add", value: "2", priority: 20
        });
        /* Precision Strike shaves 2 off called-shot penalties via the
         * existing combatMods.calledShotReduction combatMod — read by
         * attackDialog + the attack-fold pipeline, so aimed shots are
         * live-corrected in the dialog AND in the roll's grandMod. */
        changes.push({
            key: "system.combatMods.calledShotReduction",
            type: "add", value: "2", priority: 20
        });
    }

    if (school.key === "manticore") {
        /* Perfect Parry: no penalty when parrying with a shield. Writes
         * +3 to combatMods.shieldParryPenaltyReduction so defenseMixin
         * (~line 471) cancels the −3 parry penalty for shield parries only.
         * Weapon parries still take the standard penalty. */
        changes.push({
            key: "system.combatMods.shieldParryPenaltyReduction",
            type: "add", value: "3", priority: 20
        });
        /* Always Ready: equipping / stowing a shield costs no action.
         * Piggybacks on combatMods.freeShieldEquip in inventory.js. */
        changes.push({
            key: "system.combatMods.freeShieldEquip",
            type: "add", value: "1", priority: 20
        });
        /* Shield Mastery: quick items may occupy the off-hand while a
         * shield + weapon are equipped. Piggybacks on combatMods
         * .quickItemWithShield (see inventory.js checkEquipConflicts,
         * ~line 3517 — nonzero flips the guard). */
        changes.push({
            key: "system.combatMods.quickItemWithShield",
            type: "add", value: "1", priority: 20
        });
    }

    if (school.key === "wolf") {
        /* Blade Expertise: ignores the standard −3 parry penalty by
         * writing +3 to combatMods.parryPenaltyReduction — the same
         * combatMod defenseMixin reads at ~line 480 for existing parry-
         * penalty tweaks. No code branch needed. */
        changes.push({
            key: "system.combatMods.parryPenaltyReduction",
            type: "add", value: "3", priority: 20
        });
    }

    if (school.key === "griffin" && school.vigorBonus) {
        /* Conduit's +2 vigor. Rides the "final" phase so it applies to
         * the already-computed derivedStats.vigor rather than the
         * source. The per-cast sign STA cap is untouched — Conduit
         * only raises the pool, not the per-sign ceiling. */
        changes.push(
            { key: "system.derivedStats.vigor",
              type: "add", value: String(school.vigorBonus), priority: 20, phase: "final" }
        );
    }

    return {
        name: school.name,
        type: "base",
        img: SCHOOL_ICON(school.key),
        transfer: true,
        disabled: false,
        /* wrGate: the WitcherActiveEffect isSuppressed getter honors
         * this — when witcherReborn is off, every change on this AE
         * (both native `changes[]` and DSL actions[] flags) is
         * suppressed. Ensures flipping the toggle really turns the
         * perks off instead of leaving derived stats stuck. */
        flags: { [SYSTEM_ID]: { actions, wrGate: "witcherReborn" } },
        system: { changes },
        description: `Witchers Reborn — ${school.name}. Perks: ${school.perks.map(p => p.name).join(", ")}. Heroic Action: ${school.heroic.name}.`,
        _id: hashId(`wr-effect-${school.key}`),
        _stats: { coreVersion: "14.363", systemId: null, systemVersion: null, createdTime: null, modifiedTime: null, lastModifiedBy: null, compendiumSource: null, duplicateSource: null, exportSource: null },
        start: null,
        duration: { value: null, units: "seconds", expiry: null, expired: false },
        origin: null,
        tint: "#ffffff",
        statuses: [],
        showIcon: 1,
        folder: null,
        sort: 0
    };
}

function buildPerk(school, sort) {
    const eff = buildRaceEffect(school);
    /* Full mechanical readout — everything the AE writes to the actor,
     * plus the four sub-perks + heroic. Reads top-to-bottom so a player
     * skimming the item sheet sees the complete package without having
     * to cross-reference the pack generator. */
    const sk = school.skillBonus;
    const skillLine = sk.secondary
        ? `<strong>${sk.label}</strong> +${sk.primaryVal} rank, <strong>${sk.secondaryLabel}</strong> +${sk.secondaryVal} rank`
        : `<strong>${sk.label}</strong> +${sk.primaryVal} rank`;
    /* Only truly out-of-band bonuses go here — extra flags / combatMods
     * the AE writes that AREN'T one of the four named training perks
     * (those get listed once under "Training perks" below). Otherwise
     * the same effect would appear twice on the sheet. */
    const bakedLines = [];
    if (school.key === "wolf") {
        bakedLines.push(`<strong>Witcher Training +${school.witcherTrainingBonus}</strong> — the special training skill that gates recall-info checks against monsters.`);
    }
    if (school.key === "manticore") {
        bakedLines.push(`<strong>Shield parry baseline</strong> — parrying with a shield ignores the standard −3 parry penalty.`);
    }
    const bakedBlock = bakedLines.length
        ? `<h4>Passive bonuses (always on)</h4><ul>${bakedLines.map(l => `<li>${l}</li>`).join("")}</ul>`
        : "";
    const perkList = school.perks.map(p =>
        `<li><strong>${p.name}.</strong> ${p.desc}</li>`
    ).join("");
    const description =
        `<p>A Witcher of the ${school.key.charAt(0).toUpperCase()}${school.key.slice(1)} School under the <em>Witchers Reborn</em> ruleset.</p>` +
        `<h4>Starting skill bonus</h4>` +
        `<p>${skillLine}. (Applied to the skill's rank, not modifier — pushes the trained level, not the situational cap.)</p>` +
        bakedBlock +
        `<h4>Training perks</h4>` +
        `<ul>${perkList}</ul>` +
        `<h4>Heroic Action — ${school.heroic.name}</h4>` +
        `<p>${school.heroic.desc}</p>`;
    return {
        _id: hashId(`wr-perk-${school.key}`),
        name: school.name,
        type: "perk",
        img: SCHOOL_ICON(school.key),
        system: {
            description,
            source: "Witchers Reborn (Homebrew)"
        },
        effects: [eff],
        folder: FOLDER_ID,
        sort,
        ownership: { default: 0 },
        flags: {
            [SYSTEM_ID]: {
                homebrewGate: "witcherReborn",  /* consumers can check this if they want to hide the race when the toggle is off */
                wr: { schoolKey: school.key, heroicKey: school.heroic.key }
            }
        },
        _stats: {
            coreVersion: "14.363",
            systemId: SYSTEM_ID,
            systemVersion: "1.1",
            createdTime: Date.now(),
            modifiedTime: Date.now(),
            lastModifiedBy: null,
            compendiumSource: null,
            duplicateSource: null,
            exportSource: null
        }
    };
}

let sort = 100;
for (const school of SCHOOLS) {
    const doc = buildPerk(school, sort);
    writeFileSync(join(OUT_DIR, `perk-${school.key}.json`), JSON.stringify(doc, null, 2) + "\n");
    sort += 100;
}

console.log(`→ wrote ${SCHOOLS.length} perk items + 1 folder to packs-src/witcher-reborn/`);
