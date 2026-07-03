/**
 * gen-eo-catalog.mjs — emits the full Equipment Overhaul catalog as JSON
 * files in packs-src/.
 *
 * Item-data tables are inline below (one object per row, transcribed from
 * "Equipment for the Witcher v1.04" by J. Obadiah Ridinger). The
 * generator writes:
 *
 *   packs-src/eo-armor/<slug>.json           every armor piece
 *   packs-src/eo-weapons/<slug>.json         every weapon
 *   packs-src/eo-shields/<slug>.json         every shield
 *   packs-src/eo-ammunition/<slug>.json      every ammo type
 *   packs-src/eo-armor-enhancements/<slug>.json     glyphs + armor mods
 *   packs-src/eo-diagrams/<slug>.json        crafting diagrams (1 per item)
 *
 * Run via `node tools/gen-eo-catalog.mjs` then `node tools/build-packs.mjs`.
 *
 * IDs are deterministic 16-char strings derived from name+kind so re-runs
 * produce the same _id for the same item (idempotent).
 *
 * Inconsistencies & ambiguities are collected in INCONSISTENCIES at the
 * top of the file and printed at the end of a run.
 */

import { writeFileSync, mkdirSync, existsSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC  = join(ROOT, "packs-src");

const INCONSISTENCIES = [];

/* Stable 16-char alphanumeric ID derived from a string. */
function makeId(name, kind) {
    const h = createHash("md5").update(`${kind}:${name}`).digest("hex");
    // 16-char alphanumeric; foundry needs A-Za-z0-9 only.
    return h.slice(0, 16);
}

const slugify = (s) => s.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);

/* ── Icon selection ─────────────────────────────────────────────────
 *
 * Pick a representative Foundry-bundled icon for each item based on its
 * category / location / ammo type. The default icons that came with the
 * generator (all weapons → sword, all armor → breastplate) were a
 * one-size-fits-all band-aid; each category now has a curated icon. */

/* Icon paths verified against Foundry v14's bundled icon set
 * (resources/app/public/icons/...). The 404s the UX audit caught
 * came from icon filenames that look plausible but don't ship —
 * `glove-leather-brown` vs the real `glove-tooled-leather-brown`,
 * `sword-guard-engraved-gold` vs `shortsword-guard-gold`, etc. */
const WEAPON_ICON_BY_CATEGORY = {
    swordsmanship: "icons/weapons/swords/shortsword-guard-gold.webp",
    smallBlades:   "icons/weapons/daggers/dagger-jeweled-purple.webp",
    melee:         "icons/weapons/axes/axe-battle-black.webp",
    staffSpear:    "icons/weapons/polearms/spear-ornate-gold.webp",
    brawling:      "icons/weapons/fist/fist-knuckles-spiked-brown.webp",
    bow:           "icons/weapons/bows/bow-recurve-black.webp",
    crossbow:      "icons/weapons/crossbows/crossbow-blue.webp",
    sling:         "icons/weapons/slings/sling-leather.webp",
    thrown:        "icons/weapons/thrown/throwing-knife-flat-steel.webp"
};
function weaponIconFor(w) {
    /* Two-handed swords get a distinct greatsword icon. */
    if (w.category === "swordsmanship" && w.hands === "two") {
        return "icons/weapons/swords/greatsword-crossguard-flanged-purple.webp";
    }
    /* Hammers/maces aren't a separate category — detect by name keyword. */
    if (w.category === "melee" && /hammer|maul|mace/i.test(w.name)) {
        return "icons/weapons/hammers/hammer-double-engraved-gold.webp";
    }
    return WEAPON_ICON_BY_CATEGORY[w.category] ?? "icons/weapons/swords/shortsword-guard-brass.webp";
}

/* Armor icons by primary location + weight. */
function armorIconFor(a) {
    const loc = a.cover;
    const t   = a.type;          /* light / medium / heavy */
    if (loc === "head") {
        if (t === "heavy")  return "icons/equipment/head/helm-barbute-brass-steel.webp";
        if (t === "medium") return "icons/equipment/head/helm-barbute-engraved-steel.webp";
        return "icons/equipment/head/hood-simple-leather-brown.webp";
    }
    if (loc === "arms") {
        if (t === "heavy")  return "icons/equipment/hand/gauntlet-armored-blue.webp";
        return "icons/equipment/hand/glove-tooled-leather-brown.webp";
    }
    if (loc === "legs") {
        if (t === "heavy")  return "icons/equipment/leg/cuisses-plate-reticulated-steel-blue.webp";
        return "icons/equipment/leg/pants-breeches-leather-brown.webp";
    }
    if (loc === "torso" || loc === "torso+arms") {
        if (t === "heavy")  return "icons/equipment/chest/breastplate-cuirass-steel-grey.webp";
        if (t === "medium") return "icons/equipment/chest/breastplate-banded-steel-grey.webp";
        return "icons/equipment/chest/breastplate-metal-tan.webp";
    }
    if (loc === "full") {
        if (t === "heavy")  return "icons/equipment/chest/breastplate-cuirass-steel-grey.webp";
        if (t === "medium") return "icons/equipment/chest/breastplate-banded-leather-brown.webp";
        return "icons/equipment/chest/breastplate-collared-leather-brown.webp";
    }
    return "icons/equipment/chest/breastplate-banded-simple-leather-brown.webp";
}

/* Shield icons keyed on CV (cover value tracks shield size). */
function shieldIconFor(s) {
    if (s.cv <= 1) return "icons/equipment/shield/buckler-wooden-boss-steel.webp";
    if (s.cv >= 5) return "icons/equipment/shield/heater-steel-grey.webp";
    return "icons/equipment/shield/heater-steel-worn.webp";
}

/* Ammo icons by ammoType. */
function ammoIconFor(a) {
    const t = a.subtype;
    if (t === "bolt")        return "icons/weapons/ammunition/arrows-bodkin-yellow-red.webp";
    if (t === "slingBullet") return "icons/weapons/ammunition/ammo-piercing-blue.webp";
    return "icons/weapons/ammunition/arrow-broadhead.webp";
}

/* Enhancement (glyph / armor mod) icons by subtype. */
function enhancementIconFor(e) {
    if (e.subType === "glyph") return "icons/magic/symbols/rune-sigil-horned-blue.webp";
    return "icons/equipment/chest/breastplate-cuirass-steel-grey.webp";
}

/* Default per-location stopping schema piece (all zeroes). */
const ZERO_STOPPING = {
    headStopping: 0, headMaxStopping: 0,
    torsoStopping: 0, torsoMaxStopping: 0,
    leftArmStopping: 0, leftArmMaxStopping: 0,
    rightArmStopping: 0, rightArmMaxStopping: 0,
    leftLegStopping: 0, leftLegMaxStopping: 0,
    rightLegStopping: 0, rightLegMaxStopping: 0
};

/* Cover → location enum + per-location SP fill helper. */
function fillStopping(sp, cover) {
    const out = { ...ZERO_STOPPING };
    const setLoc = (loc) => { out[`${loc}Stopping`] = sp; out[`${loc}MaxStopping`] = sp; };
    const covers = cover.split("+");
    for (const c of covers) setLoc(c);
    return out;
}

/* Cover names → schema `location` enum + the body slots to fill. */
const COVER = {
    "head":       { location: "head",  slots: ["head"] },
    "torso":      { location: "torso", slots: ["torso"] },
    "arms":       { location: "arms",  slots: ["leftArm", "rightArm"] },
    "legs":       { location: "legs",  slots: ["leftLeg", "rightLeg"] },
    "torso+arms": { location: "torso", slots: ["torso", "leftArm", "rightArm"] },
    "full":       { location: "full",  slots: ["torso", "leftArm", "rightArm", "leftLeg", "rightLeg"] },
    "fullbody":   { location: "full",  slots: ["torso", "leftArm", "rightArm", "leftLeg", "rightLeg", "head"] }
};
const AVAIL = { E: "everywhere", C: "common", P: "poor", R: "rare" };

/* Resist code → boolean fields. EO uses S (Slashing), P (Piercing), B
 * (Bludgeoning); combinations like "S/B", "S/P", "S/P/B". */
function parseResist(code) {
    const out = { slashing: false, piercing: false, bludgeoning: false };
    if (!code || code === "―" || code === "-" || code === "") return out;
    if (code.includes("S")) out.slashing = true;
    if (code.includes("P")) out.piercing = true;
    if (code.includes("B")) out.bludgeoning = true;
    return out;
}

/* ── ARMOR catalog (EO p.4 onwards). Stat columns from the tables.
 *
 *  sp        : stopping power
 *  ev        : encumbrance value
 *  resist    : EO resist code ("S", "P", "B", "S/B", "S/P", "S/P/B", "")
 *  cover     : COVER key
 *  ae        : per-location AE counts (object) OR a number — if number,
 *              it's spread across primary slots
 *  en        : enhancement (glyph) total
 *  wt        : weight kg
 *  cost      : crowns
 *  av        : availability code (E/C/P/R)
 *  type      : armorType enum (light/medium/heavy)
 *  qualities : array of armor-quality catalog keys
 *  effects   : narrative HTML (description appendix from the PDF)
 *  difficult : Difficult flag
 *  jack      : armingJackKind ("none"/"jack"/"superiorSuit")
 *  upgrade   : armoredArmingJackUpgrade
 *  description : top-level item description (from the PDF text)
 * ────────────────────────────────────────────────────────────────── */

const ARMOR = [
    /* ── Arming jacks ─────────────────────────────────────────── */
    { name: "Arming Jack", sp: 0, ev: 1, resist: "", cover: "torso", ae: 0, en: 0,
      wt: 1, cost: 50, av: "C", type: "light", jack: "jack",
      description: "<p>A padded garment worn under heavy armor. Required to equip Difficult armor pieces.</p>" },

    { name: "Superior Arming Suit", sp: 0, ev: 1, resist: "", cover: "torso", ae: 0, en: 0,
      wt: 2.5, cost: 500, av: "P", type: "light", jack: "superiorSuit",
      description: "<p>A high-end padded suit. Acts as an Arming Jack and reduces the EV of each worn Difficult armor piece by 1.</p>" },

    /* ── Basic Light Armor (EO p.13) ──────────────────────────── */
    /* Hats & Hoods */
    { name: "Aketon Coif",    sp: 6, ev: 0, resist: "",  cover: "head", ae: 0, en: 0, wt: 0.5, cost: 56,  av: "E", type: "light",
      description: "<p>Padded cloth head covering.</p>" },
    { name: "Buff Leather Cap", sp: 8, ev: 0, resist: "", cover: "head", ae: 0, en: 0, wt: 1,   cost: 83,  av: "E", type: "light",
      description: "<p>Thick buff-leather cap.</p>" },
    { name: "Mail Coif",      sp: 8, ev: 0, resist: "S", cover: "head", ae: 0, en: 0, wt: 2,   cost: 184, av: "C", type: "light",
      description: "<p>Mail hood covering the head and neck.</p>" },
    { name: "Double Woven Hood", sp: 8, ev: 0, resist: "P", cover: "head", ae: 0, en: 0, wt: 1, cost: 205, av: "P", type: "light",
      description: "<p>Hood of double-woven linen — naturally resists piercing.</p>" },
    /* Jacks & Coats */
    { name: "Cold Weather Clothing", sp: 2, ev: 1, resist: "", cover: "full", ae: 0, en: 0, wt: 0, cost: 0, av: "E", type: "light",
      description: "<p>Heavy cold-weather garb (Core p.93). Counts as a layer of armor when worn.</p>" },
    { name: "Aketon Doublet", sp: 6, ev: 1, resist: "", cover: "torso+arms", ae: 0, en: 1, wt: 2, cost: 154, av: "E", type: "light",
      description: "<p>A quilted doublet covering torso and arms. <em>Options (EV -1)</em>. Can be upgraded (+100c) to function as an Arming Jack; an Aketon Doublet + Aketon Trousers can together (+750c set) function as a Superior Arming Suit when both worn.</p>" },
    { name: "Buff Leather Coat", sp: 8, ev: 2, resist: "", cover: "full", ae: 0, en: 1, wt: 5, cost: 217, av: "E", type: "light",
      description: "<p>Heavy buff-leather coat covering torso, arms, and legs. <em>Options (EV -1)</em>.</p>" },
    { name: "Mail Byrnie",    sp: 8, ev: 1, resist: "S", cover: "torso+arms", ae: 0, en: 1, wt: 8, cost: 459, av: "C", type: "light",
      description: "<p>Short mail shirt covering torso and arms. <em>Options (EV -1)</em>.</p>" },
    { name: "Double Woven Gambeson", sp: 8, ev: 1, resist: "P", cover: "torso+arms", ae: 0, en: 1, wt: 5, cost: 1023, av: "P", type: "light",
      description: "<p>Thickly layered linen gambeson — naturally resists piercing. <em>Options (EV -1)</em>.</p>" },
    /* Limb Armor */
    { name: "Mail Sleeves",   sp: 8, ev: 1, resist: "S", cover: "arms", ae: 0, en: 0, wt: 3,   cost: 251, av: "C", type: "light",
      description: "<p>Mail sleeves protecting the arms.</p>" },
    { name: "Aketon Trousers", sp: 6, ev: 1, resist: "", cover: "legs", ae: 0, en: 0, wt: 1.4, cost: 99,  av: "C", type: "light",
      description: "<p>Quilted leg coverings. Pair with Aketon Doublet for the Superior Arming Suit upgrade.</p>" },
    { name: "Cavalry Trousers", sp: 8, ev: 1, resist: "", cover: "legs", ae: 0, en: 0, wt: 2, cost: 132, av: "C", type: "light",
      description: "<p>Reinforced riding trousers.</p>" },
    { name: "Mail Chausses",  sp: 8, ev: 1, resist: "S", cover: "legs", ae: 0, en: 0, wt: 5, cost: 263, av: "C", type: "light",
      description: "<p>Mail leg coverings.</p>" },
    { name: "Double Woven Chausses", sp: 8, ev: 1, resist: "P", cover: "legs", ae: 0, en: 0, wt: 3, cost: 614, av: "P", type: "light",
      description: "<p>Double-woven linen leg coverings.</p>" },

    /* ── Basic Medium Armor (EO p.14) ─────────────────────────── */
    /* Helmets */
    { name: "Cuir Bouilli Cap", sp: 12, ev: 0, resist: "", cover: "head", ae: { head: 1 }, en: 0, wt: 1, cost: 208, av: "C", type: "medium",
      description: "<p>Hardened leather cap.</p>" },
    { name: "Iron Cap",         sp: 16, ev: 1, resist: "", cover: "head", ae: { head: 1 }, en: 0, wt: 1.5, cost: 209, av: "E", type: "medium",
      description: "<p>Simple iron skullcap.</p>" },
    { name: "Kettle Helmet",    sp: 16, ev: 1, resist: "", cover: "head", ae: { head: 1 }, en: 0, wt: 2, cost: 254, av: "C", type: "medium",
      qualities: ["stifling"],
      description: "<p>Wide-brimmed iron helm. <strong>Stifling</strong>; reduces Bright Light penalties by 2.</p>" },
    { name: "Spectacle Helmet", sp: 16, ev: 1, resist: "P", cover: "head", ae: { head: 1 }, en: 0, wt: 2.5, cost: 328, av: "C", type: "medium",
      qualities: ["stifling"],
      description: "<p>Iron helm with a perforated face plate. <strong>Stifling</strong>.</p>" },
    { name: "Bascinet or Sallet", sp: 16, ev: 1, resist: "S", cover: "head", ae: { head: 2 }, en: 0, wt: 2.5, cost: 330, av: "P", type: "medium",
      qualities: ["stifling"],
      description: "<p>Iron helm with neck guard. <strong>Stifling</strong>.</p>" },
    /* Corslets */
    { name: "Cuirass",          sp: 12, ev: 1, resist: "", cover: "torso", ae: { torso: 1 }, en: 1, wt: 3, cost: 559, av: "C", type: "medium",
      qualities: ["stifling"],
      description: "<p>Hardened leather torso protection. <strong>Stifling</strong>.</p>" },
    { name: "Mail Hauberk",     sp: 12, ev: 2, resist: "S", cover: "full", ae: 0, en: 0, wt: 18, cost: 903, av: "C", type: "medium",
      qualities: ["options"], qualityValues: { options: "EV -1" },
      description: "<p>Full-body mail covering torso, arms, and legs. <em>Options (EV -1)</em>.</p>" },
    { name: "Brigandine",       sp: 16, ev: 1, resist: "S", cover: "torso", ae: { torso: 1 }, en: 1, wt: 7, cost: 607, av: "C", type: "medium",
      qualities: ["stifling"],
      description: "<p>Cloth garment lined with riveted metal plates. <strong>Stifling</strong>.</p>" },
    /* Spaulders */
    { name: "Cuir Bouilli Vambraces", sp: 10, ev: 1, resist: "", cover: "arms", ae: { leftArm: 1, rightArm: 0 }, en: 0, wt: 2, cost: 346, av: "P", type: "medium",
      qualities: ["stifling"],
      description: "<p>Hardened leather arm protection. <strong>Stifling</strong>.</p>" },
    { name: "Plated Vambraces", sp: 12, ev: 2, resist: "", cover: "arms", ae: { leftArm: 1, rightArm: 0 }, en: 0, wt: 6, cost: 388, av: "P", type: "medium",
      qualities: ["difficult", "stifling", "rangedPenalty"], difficult: true,
      description: "<p>Plated arm guards. <strong>Difficult</strong>, <strong>Stifling</strong>; <strong>Ranged -1</strong>.</p>" },
    /* Greaves & Chausses */
    { name: "Cuir Bouilli Greaves", sp: 10, ev: 1, resist: "", cover: "legs", ae: { leftLeg: 1, rightLeg: 0 }, en: 0, wt: 3, cost: 418, av: "P", type: "medium",
      qualities: ["stifling"],
      description: "<p>Hardened leather leg armor. <strong>Stifling</strong>.</p>" },
    { name: "Plated Greaves",   sp: 12, ev: 2, resist: "", cover: "legs", ae: { leftLeg: 1, rightLeg: 0 }, en: 0, wt: 7, cost: 438, av: "P", type: "medium",
      qualities: ["difficult", "stifling", "spdPenalty"], difficult: true,
      description: "<p>Plated leg armor. <strong>Difficult</strong>, <strong>Stifling</strong>; <strong>SPD -1</strong>.</p>" },

    /* ── Basic Heavy Armor (EO p.14-15) ───────────────────────── */
    { name: "Barbute",           sp: 18, ev: 2, resist: "S/B", cover: "head", ae: { head: 1 }, en: 0, wt: 3, cost: 404, av: "P", type: "heavy",
      qualities: ["stifling", "restrictedVision"],
      description: "<p>Iron face-covering helm. <strong>Stifling, Restricted Vision</strong>.</p>" },
    { name: "Great Helm",        sp: 24, ev: 2, resist: "S/P", cover: "head", ae: 0, en: 0, wt: 4, cost: 493, av: "P", type: "heavy",
      qualities: ["stifling", "poorVision"],
      description: "<p>Heavy enclosed helm. <strong>Stifling, Poor Vision</strong>.</p>" },
    { name: "Armet",             sp: 24, ev: 1, resist: "S/P/B", cover: "head", ae: 0, en: 0, wt: 2, cost: 547, av: "R", type: "heavy",
      qualities: ["stifling", "poorVision"],
      description: "<p>Articulated helm with hinged faceguard. <strong>Stifling*, Poor Vision (can be opened)</strong>.</p>" },

    /* Heavy Breastplates & Harnisses (Basic Heavy, EO p.15) */
    { name: "Iron Breastplate",   sp: 24, ev: 2, resist: "S", cover: "torso", ae: { torso: 1 }, en: 1, wt: 5, cost: 803, av: "P", type: "heavy",
      qualities: ["difficult", "stifling"], difficult: true,
      description: "<p>Iron breastplate. <strong>Difficult, Stifling</strong>.</p>" },
    { name: "Steel Breastplate",  sp: 28, ev: 2, resist: "S/B", cover: "torso", ae: { torso: 1 }, en: 1, wt: 6, cost: 1102, av: "P", type: "heavy",
      qualities: ["difficult", "stifling"], difficult: true,
      description: "<p>Steel breastplate. <strong>Difficult, Stifling</strong>.</p>" },
    { name: "Iron Arm Harnisse",  sp: 20, ev: 3, resist: "S", cover: "arms", ae: { leftArm: 1 }, en: 0, wt: 3, cost: 612, av: "P", type: "heavy",
      qualities: ["difficult", "stifling", "rangedPenalty"], qualityValues: { rangedPenalty: "2" }, difficult: true,
      description: "<p>Iron arm harnisse. <strong>Difficult, Stifling, Ranged -2</strong>.</p>" },
    { name: "Steel Arm Harnisse", sp: 24, ev: 3, resist: "S/B", cover: "arms", ae: { leftArm: 1 }, en: 0, wt: 3.5, cost: 879, av: "P", type: "heavy",
      qualities: ["difficult", "stifling", "rangedPenalty"], qualityValues: { rangedPenalty: "2" }, difficult: true,
      description: "<p>Steel arm harnisse. <strong>Difficult, Stifling, Ranged -2</strong>.</p>" },
    { name: "Iron Leg Harnisse",  sp: 20, ev: 3, resist: "S", cover: "legs", ae: { leftLeg: 1 }, en: 0, wt: 5, cost: 779, av: "P", type: "heavy",
      qualities: ["difficult", "stifling", "spdPenalty"], qualityValues: { spdPenalty: "2" }, difficult: true,
      description: "<p>Iron leg harnisse. <strong>Difficult, Stifling, SPD -2</strong>.</p>" },
    { name: "Steel Leg Harnisse", sp: 24, ev: 3, resist: "S/B", cover: "legs", ae: { leftLeg: 1 }, en: 0, wt: 6, cost: 1051, av: "P", type: "heavy",
      qualities: ["difficult", "stifling", "spdPenalty"], qualityValues: { spdPenalty: "2" }, difficult: true,
      description: "<p>Steel leg harnisse. <strong>Difficult, Stifling, SPD -2</strong>.</p>" },

    /* ── Quality Northern Armor (EO p.18-19) ────────────────────── */
    /* Verden Hunter's Set */
    { name: "Verden Hunter's Hood",  sp: 2,  ev: 0, resist: "",   cover: "head",  ae: 0, en: 0, wt: 0.5, cost: 138,  av: "P", type: "light",
      description: "<p>Verden hunter's hood. <em>Set Bonus</em>.</p>" },
    { name: "Verden Hunter's Cloak", sp: 2,  ev: 0, resist: "",   cover: "full",  ae: 0, en: 1, wt: 1,   cost: 317,  av: "P", type: "light",
      description: "<p>Verden hunter's cloak. <em>Set Bonus</em>.</p>" },
    /* Special Forces Set */
    { name: "Special Forces Hood",     sp: 8,  ev: 0, resist: "P", cover: "head",        ae: { head: 1 },   en: 0, wt: 1, cost: 297, av: "R", type: "light",
      description: "<p>Special Forces hood. <em>Set Bonus</em>.</p>" },
    { name: "Special Forces Jack",     sp: 8,  ev: 1, resist: "P", cover: "torso+arms",  ae: { torso: 1 },  en: 0, wt: 4, cost: 937, av: "R", type: "light",
      description: "<p>Special Forces jack. <em>Options (EV-1); Set Bonus</em>.</p>" },
    { name: "Special Forces Trousers", sp: 8,  ev: 1, resist: "P", cover: "legs",        ae: { leftLeg: 1 }, en: 0, wt: 3, cost: 750, av: "R", type: "light",
      description: "<p>Special Forces trousers. <em>Set Bonus</em>.</p>" },
    /* Lyrian Set (medium) */
    { name: "Lyrian Helmet",   sp: 16, ev: 1, resist: "B", cover: "head", ae: { head: 1 }, en: 0, wt: 1.5, cost: 302, av: "P", type: "medium",
      qualities: ["stifling"],
      description: "<p>Lyrian iron helm. <strong>Stifling</strong>; <em>Set Bonus</em>.</p>" },
    { name: "Lyrian Cuirass",  sp: 16, ev: 1, resist: "B", cover: "torso", ae: { torso: 1 }, en: 1, wt: 4, cost: 827, av: "P", type: "medium",
      qualities: ["stifling"],
      description: "<p>Lyrian cuirass. <strong>Stifling</strong>; <em>Set Bonus</em>.</p>" },
    { name: "Lyrian Vambraces", sp: 12, ev: 2, resist: "B", cover: "arms", ae: { leftArm: 1 }, en: 0, wt: 2, cost: 482, av: "P", type: "medium",
      qualities: ["stifling", "rangedPenalty"], qualityValues: { rangedPenalty: "1" },
      description: "<p>Lyrian arm guards. <strong>Stifling, Ranged -1</strong>; <em>Set Bonus</em>.</p>" },
    { name: "Lyrian Greaves",  sp: 12, ev: 2, resist: "B", cover: "legs", ae: { leftLeg: 1 }, en: 0, wt: 3, cost: 584, av: "P", type: "medium",
      qualities: ["stifling", "spdPenalty"], qualityValues: { spdPenalty: "1" },
      description: "<p>Lyrian leg armor. <strong>Stifling, SPD -1</strong>; <em>Set Bonus</em>.</p>" },
    /* Special Forces medium (EO p.19 — pairs with the Special Forces light set) */
    { name: "Special Forces Bascinet",   sp: 16, ev: 1, resist: "S", cover: "head", ae: { head: 2 },    en: 0, wt: 2, cost: 319, av: "R", type: "medium",
      qualities: ["stifling"],
      description: "<p>Special Forces medium helm. <strong>Stifling</strong>; <em>Set Bonus*</em>.</p>" },
    { name: "Special Forces Brigandine", sp: 16, ev: 1, resist: "S", cover: "torso", ae: { torso: 2 }, en: 0, wt: 5, cost: 846, av: "R", type: "medium",
      qualities: ["stifling"],
      description: "<p>Special Forces brigandine. <strong>Stifling</strong>; <em>Set Bonus*</em>.</p>" },
    { name: "Special Forces Vambraces",  sp: 12, ev: 1, resist: "S", cover: "arms", ae: { leftArm: 2 }, en: 0, wt: 3, cost: 485, av: "R", type: "medium",
      qualities: ["stifling"],
      description: "<p>Special Forces arm guards. <strong>Stifling</strong>; <em>Set Bonus*</em>.</p>" },
    { name: "Special Forces Greaves",    sp: 12, ev: 1, resist: "S", cover: "legs", ae: { leftLeg: 2 }, en: 0, wt: 4, cost: 588, av: "R", type: "medium",
      qualities: ["stifling"],
      description: "<p>Special Forces leg armor. <strong>Stifling</strong>; <em>Set Bonus*</em>.</p>" },
    /* Tretagor heavy (Difficult set) */
    { name: "Tretagor Great Bascinet", sp: 30, ev: 2, resist: "S/P/B", cover: "head", ae: { head: 1 }, en: 0, wt: 3, cost: 610, av: "R", type: "heavy",
      qualities: ["stifling", "poorVision"],
      description: "<p>Tretagor knightly bascinet. <strong>Stifling, Poor Vision (can be opened)</strong>; <em>Set Bonus</em>.</p>" },
    { name: "Tretagor White Breastplate", sp: 30, ev: 2, resist: "S/B", cover: "torso", ae: { torso: 1 }, en: 2, wt: 6, cost: 1167, av: "R", type: "heavy",
      qualities: ["stifling", "lanceRest"], difficult: true,
      description: "<p>Tretagor knight's white breastplate. <strong>Difficult, Stifling, Lance Rest</strong>; <em>Set Bonus</em>.</p>" },
    { name: "Tretagor Arm Harnisse", sp: 24, ev: 3, resist: "S", cover: "arms", ae: { leftArm: 1 }, en: 0, wt: 4, cost: 833, av: "R", type: "heavy",
      qualities: ["stifling", "rangedPenalty"], qualityValues: { rangedPenalty: "2" }, difficult: true,
      description: "<p>Tretagor knight's arm harnisse. <strong>Difficult, Stifling, Ranged -2</strong>; <em>Set Bonus</em>.</p>" },
    { name: "Tretagor Leg Harnisse", sp: 24, ev: 3, resist: "S", cover: "legs", ae: { leftLeg: 1 }, en: 0, wt: 6, cost: 1034, av: "R", type: "heavy",
      qualities: ["stifling", "spdPenalty"], qualityValues: { spdPenalty: "2" }, difficult: true,
      description: "<p>Tretagor knight's leg harnisse. <strong>Difficult, Stifling, SPD -2</strong>; <em>Set Bonus</em>.</p>" },
    /* Hindarsfjall Raider — heavy Skellige set */
    { name: "Hindarsfjall Masked Helm", sp: 24, ev: 1, resist: "S/P", cover: "head", ae: { head: 3 }, en: 0, wt: 3, cost: 726, av: "R", type: "heavy",
      qualities: ["stifling", "restrictedVision"],
      description: "<p>Skellige raider's masked great helm. <strong>Stifling, Restricted Vision (can be opened)</strong>; <em>Set Bonus</em>.</p>" },
    { name: "Hindarsfjall Brigandine", sp: 24, ev: 2, resist: "S", cover: "torso", ae: { torso: 3 }, en: 2, wt: 8, cost: 1333, av: "R", type: "heavy",
      qualities: ["stifling"],
      description: "<p>Skellige raider's brigandine. <strong>Stifling</strong>; <em>Set Bonus</em>.</p>" },

    /* ── Fine Southern Armor (EO p.22) ──────────────────────────── */
    /* Black Army light */
    { name: "Black Army Coif",       sp: 10, ev: 1, resist: "S", cover: "head",        ae: 0, en: 0, wt: 1.5, cost: 256,  av: "P", type: "light",
      description: "<p>Black Army (Nilfgaardian) infantry coif. <em>Set Bonus</em>.</p>" },
    { name: "Black Army Haubergeon", sp: 10, ev: 1, resist: "S", cover: "torso+arms",  ae: 0, en: 0, wt: 5,   cost: 789,  av: "P", type: "light",
      description: "<p>Black Army haubergeon. <em>Options (EV-1); Set Bonus</em>.</p>" },
    { name: "Black Army Chausses",   sp: 10, ev: 1, resist: "S", cover: "legs",        ae: 0, en: 0, wt: 4,   cost: 553,  av: "P", type: "light",
      description: "<p>Black Army chausses. <em>Set Bonus</em>.</p>" },
    /* Markee Rider set */
    { name: "Markee Riding Cap",      sp: 8, ev: 0, resist: "P", cover: "head",       ae: { head: 1 }, en: 0, wt: 0.5, cost: 404,  av: "R", type: "light",
      description: "<p>Mettinese rider's cap. <em>Set Bonus</em>.</p>" },
    { name: "Markee Riding Coat",     sp: 8, ev: 0, resist: "P", cover: "torso+arms", ae: { torso: 1 }, en: 0, wt: 3, cost: 1338, av: "R", type: "light",
      description: "<p>Mettinese riding coat. <em>Set Bonus</em>.</p>" },
    { name: "Markee Riding Trousers", sp: 8, ev: 0, resist: "P", cover: "legs",       ae: { leftLeg: 1 }, en: 0, wt: 2, cost: 1063, av: "R", type: "light",
      description: "<p>Mettinese riding trousers. <em>Set Bonus</em>.</p>" },
    /* Black Army medium */
    { name: "Black Army Sallet",      sp: 20, ev: 1, resist: "S/B", cover: "head",  ae: 0, en: 0, wt: 2.5, cost: 364,  av: "P", type: "medium",
      qualities: ["stifling"],
      description: "<p>Black Army sallet. <strong>Stifling</strong>; <em>Set Bonus</em>.</p>" },
    { name: "Black Army Brigandine",  sp: 20, ev: 1, resist: "S/B", cover: "torso", ae: 0, en: 1, wt: 8,   cost: 821,  av: "P", type: "medium",
      qualities: ["stifling"],
      description: "<p>Black Army brigandine. <strong>Stifling</strong>; <em>Set Bonus</em>.</p>" },
    { name: "Black Army Vambraces",   sp: 14, ev: 2, resist: "S",   cover: "arms",  ae: 0, en: 0, wt: 5,   cost: 547,  av: "P", type: "medium",
      qualities: ["stifling", "rangedPenalty"],
      description: "<p>Black Army arm guards. <strong>Stifling, Ranged -1</strong>; <em>Set Bonus</em>.</p>" },
    { name: "Black Army Greaves",     sp: 14, ev: 2, resist: "S",   cover: "legs",  ae: 0, en: 0, wt: 7,   cost: 665,  av: "P", type: "medium",
      qualities: ["stifling", "spdPenalty"],
      description: "<p>Black Army greaves. <strong>Stifling, SPD -1</strong>; <em>Set Bonus</em>.</p>" },
    /* Pacifier set (medium) */
    { name: "Pacifier Morion",        sp: 20, ev: 1, resist: "",    cover: "head",  ae: { head: 1 }, en: 0, wt: 2, cost: 435, av: "R", type: "medium",
      qualities: ["stifling"],
      description: "<p>Pacifier morion. <strong>Stifling</strong>; <em>Set Bonus</em>.</p>" },
    { name: "Pacifier Breastplate",   sp: 20, ev: 1, resist: "",    cover: "torso", ae: { torso: 1 }, en: 1, wt: 4, cost: 1070, av: "R", type: "medium",
      qualities: ["stifling"],
      description: "<p>Pacifier breastplate. <strong>Stifling</strong>; <em>Set Bonus</em>.</p>" },
    { name: "Pacifier Vambraces",     sp: 14, ev: 2, resist: "",    cover: "arms",  ae: { leftArm: 1 }, en: 0, wt: 4, cost: 551, av: "R", type: "medium",
      qualities: ["stifling", "rangedPenalty"],
      description: "<p>Pacifier vambraces. <strong>Stifling, Ranged -1</strong>; <em>Set Bonus</em>.</p>" },
    { name: "Pacifier Greaves",       sp: 14, ev: 2, resist: "",    cover: "legs",  ae: { leftLeg: 1 }, en: 0, wt: 4, cost: 884, av: "R", type: "medium",
      qualities: ["stifling", "spdPenalty"],
      description: "<p>Pacifier greaves. <strong>Stifling, SPD -1</strong>; <em>Set Bonus</em>.</p>" },
    /* Nilfgaardian heavy (Difficult set) */
    { name: "Nilfgaardian Sallet",        sp: 24, ev: 2, resist: "S",   cover: "head",  ae: { head: 3 }, en: 0, wt: 2, cost: 645, av: "R", type: "heavy",
      qualities: ["stifling"],
      description: "<p>Nilfgaardian heavy sallet. <strong>Stifling</strong>; <em>Set Bonus</em>.</p>" },
    { name: "Nilfgaardian Breastplate",   sp: 30, ev: 2, resist: "S/B", cover: "torso", ae: { torso: 2 }, en: 1, wt: 5, cost: 1193, av: "R", type: "heavy",
      qualities: ["stifling"], difficult: true,
      description: "<p>Nilfgaardian breastplate. <strong>Difficult, Stifling</strong>; <em>Set Bonus</em>.</p>" },
    { name: "Nilfgaardian Arm Harnisse",  sp: 24, ev: 3, resist: "S",   cover: "arms",  ae: { leftArm: 2 }, en: 0, wt: 3, cost: 861, av: "R", type: "heavy",
      qualities: ["stifling", "rangedPenalty"], difficult: true,
      description: "<p>Nilfgaardian arm harnisse. <strong>Difficult, Stifling, Ranged -2</strong>; <em>Set Bonus</em>.</p>" },
    { name: "Nilfgaardian Leg Harnisse",  sp: 24, ev: 3, resist: "S",   cover: "legs",  ae: { leftLeg: 2 }, en: 0, wt: 5, cost: 1097, av: "R", type: "heavy",
      qualities: ["stifling", "spdPenalty"], difficult: true,
      description: "<p>Nilfgaardian leg harnisse. <strong>Difficult, Stifling, SPD -2</strong>; <em>Set Bonus</em>.</p>" },
    /* Ducal Knight (Difficult, heavy, +Lance Rest) */
    { name: "Ducal Knight Helm",          sp: 36, ev: 3, resist: "S/P/B", cover: "head",  ae: 0, en: 0, wt: 5, cost: 910, av: "R", type: "heavy",
      qualities: ["stifling", "restrictedVision"],
      description: "<p>Ducal knight's great helm. <strong>Stifling, Restricted Vision (can be opened)</strong>; <em>Set Bonus</em>.</p>" },
    { name: "Ducal Knight Breastplate",   sp: 36, ev: 3, resist: "S/P/B", cover: "torso", ae: 0, en: 2, wt: 10, cost: 1695, av: "R", type: "heavy",
      qualities: ["stifling", "superiorLanceRest"], difficult: true,
      description: "<p>Ducal knight's breastplate. <strong>Difficult, Stifling, Superior Lance Rest</strong>; <em>Set Bonus</em>.</p>" },
    { name: "Ducal Knight Arm Harnisse",  sp: 32, ev: 3, resist: "S/P/B", cover: "arms",  ae: 0, en: 0, wt: 6,  cost: 1163, av: "R", type: "heavy",
      qualities: ["stifling", "rangedPenalty"], difficult: true,
      description: "<p>Ducal knight's arm harnisse. <strong>Difficult, Stifling, Ranged -3</strong>; <em>Set Bonus</em>.</p>" },
    { name: "Ducal Knight Leg Harnisse",  sp: 32, ev: 3, resist: "S/P/B", cover: "legs",  ae: 0, en: 0, wt: 8,  cost: 1415, av: "R", type: "heavy",
      qualities: ["stifling", "spdPenalty"], difficult: true,
      description: "<p>Ducal knight's leg harnisse. <strong>Difficult, Stifling, SPD -3</strong>; <em>Set Bonus</em>.</p>" },

    /* ── Exotic Armor (EO p.25) ─────────────────────────────────── */
    /* Steppe Warrior set */
    { name: "Steppe Warrior Cap",      sp: 6,  ev: 0, resist: "P", cover: "head",        ae: 0, en: 0, wt: 1, cost: 355, av: "P", type: "light",
      qualities: ["bleedResistance"],
      description: "<p>Steppe Warrior cap. <strong>Resistance to Bleeding</strong>; <em>Set Bonus</em>.</p>" },
    { name: "Steppe Warrior Coat",     sp: 6,  ev: 1, resist: "P", cover: "torso+arms",  ae: 0, en: 0, wt: 3, cost: 888, av: "P", type: "light",
      qualities: ["bleedResistance"],
      description: "<p>Steppe Warrior coat. <strong>Resistance to Bleeding</strong>; <em>Options (EV-1); Set Bonus</em>.</p>" },
    { name: "Steppe Warrior Trousers", sp: 6,  ev: 1, resist: "P", cover: "legs",        ae: 0, en: 0, wt: 2, cost: 533, av: "P", type: "light",
      qualities: ["bleedResistance"],
      description: "<p>Steppe Warrior trousers. <strong>Resistance to Bleeding</strong>; <em>Set Bonus</em>.</p>" },
    /* Drake Leather set */
    { name: "Drake Leather Cap",       sp: 8,  ev: 0, resist: "",  cover: "head",        ae: { head: 1 },    en: 0, wt: 1, cost: 441, av: "R", type: "light",
      qualities: ["fireproof"],
      description: "<p>Drake-hide cap. <strong>Resistance to Fire</strong>.</p>" },
    { name: "Drake Leather Coat",      sp: 8,  ev: 1, resist: "",  cover: "torso+arms",  ae: { torso: 1 },   en: 1, wt: 4, cost: 758, av: "R", type: "light",
      qualities: ["fireproof"],
      description: "<p>Drake-hide coat. <strong>Resistance to Fire</strong>; <em>Options (EV-1)</em>.</p>" },
    { name: "Drake Leather Trousers",  sp: 8,  ev: 1, resist: "",  cover: "legs",        ae: { leftLeg: 1 }, en: 0, wt: 3, cost: 690, av: "R", type: "light",
      qualities: ["fireproof"],
      description: "<p>Drake-hide trousers. <strong>Resistance to Fire</strong>.</p>" },
    /* Biraq Mail */
    { name: "Biraq Mail Hood", sp: 12, ev: 0, resist: "S", cover: "head", ae: { head: 1 }, en: 0, wt: 2, cost: 464,  av: "R", type: "light",
      description: "<p>Biraq mail hood.</p>" },
    { name: "Biraq Mail Coat", sp: 12, ev: 2, resist: "S", cover: "full", ae: { torso: 1 }, en: 0, wt: 12, cost: 2167, av: "R", type: "heavy",
      description: "<p>Biraq full-body mail. <em>Options (EV-1)</em>.</p>" },
    /* Fāris (medium) */
    { name: "Fāris Helmet",      sp: 16, ev: 0, resist: "", cover: "head",  ae: { head: 1 },  en: 0, wt: 1.5, cost: 465,  av: "R", type: "medium",
      qualities: ["stifling"],
      description: "<p>Fāris ceremonial helmet. <strong>Stifling</strong>.</p>" },
    { name: "Fāris Breastplate", sp: 16, ev: 0, resist: "", cover: "torso", ae: { torso: 1 }, en: 2, wt: 6,   cost: 1116, av: "R", type: "medium",
      qualities: ["stifling"],
      description: "<p>Fāris breastplate. <strong>Stifling</strong>.</p>" },
    /* Katafrakt set */
    { name: "Katafrakt Dragon Helm", sp: 20, ev: 1, resist: "S", cover: "head", ae: { head: 1 }, en: 2, wt: 2, cost: 542, av: "R", type: "medium",
      qualities: ["stifling"],
      description: "<p>Katafrakt dragon-styled helm. <strong>Stifling</strong>; <em>Set Bonus</em>.</p>" },
    { name: "Katafrakt Coat",        sp: 20, ev: 5, resist: "S", cover: "full", ae: { torso: 1 }, en: 0, wt: 16, cost: 2646, av: "R", type: "heavy",
      qualities: ["stifling"],
      description: "<p>Katafrakt full coat. <strong>Stifling, Options* (EV-2)</strong>; <em>Set Bonus</em>.</p>" },
    /* Anusyia (Ofieri Immortals) */
    { name: "Anusyia Helmet", sp: 20, ev: 1, resist: "S/P", cover: "head", ae: 0, en: 0, wt: 2,  cost: 572,  av: "R", type: "medium",
      qualities: ["stifling", "restrictedVision"],
      description: "<p>Anusyia helm. <strong>Stifling, Restricted Vision</strong>; <em>Set Bonus</em>.</p>" },
    { name: "Anusyia Coat",   sp: 20, ev: 5, resist: "S/B", cover: "full", ae: 0, en: 2, wt: 16, cost: 3032, av: "R", type: "heavy",
      qualities: ["stifling"],
      description: "<p>Anusyia full-body coat. <strong>Stifling, Options* (EV-2)</strong>; <em>Set Bonus</em>.</p>" },

    /* ── Witcher School Armor (EO p.31) ─────────────────────────── */
    /* Light Armor schools */
    { name: "Feline Hood",         sp: 8,  ev: 0, resist: "", cover: "head",       ae: { head: 2 },    en: 0, wt: 1, cost: 0, av: "R", type: "light",
      qualities: ["meteorite", "silver", "monsterResistance"], qualityValues: { monsterResistance: "all monster sets" },
      description: "<p>Cat School witcher hood. <strong>Meteorite, Silver, Monster Resistance</strong>.</p>" },
    { name: "Feline Witcher Armor", sp: 8, ev: 0, resist: "", cover: "full",       ae: { torso: 2 },   en: 1, wt: 3, cost: 0, av: "R", type: "light",
      qualities: ["meteorite", "silver", "monsterResistance"], qualityValues: { monsterResistance: "all monster sets" },
      description: "<p>Cat School witcher armor. <strong>Set effects (Witcher only):</strong> (1) On a random hit location, you can also roll for location and choose to force the attack to use your result. (2) On a successful Dodge/Reposition you can spend 2 STA to stagger the attacker. (3) Extra-Action STA cost for Fast Strikes with swords/small blades is reduced from 3 to 1.</p>" },
    { name: "Serpentine Witcher Hood", sp: 10, ev: 0, resist: "", cover: "head",   ae: { head: 2 },    en: 0, wt: 1, cost: 0, av: "R", type: "light",
      qualities: ["meteorite", "silver", "monsterResistance"], qualityValues: { monsterResistance: "all monster sets" },
      description: "<p>Viper School witcher hood. <strong>Meteorite, Silver, Monster Resistance</strong>.</p>" },
    { name: "Serpentine Witcher Armor", sp: 10, ev: 0, resist: "", cover: "full",  ae: { torso: 2 },   en: 1, wt: 5, cost: 0, av: "R", type: "light",
      qualities: ["meteorite", "silver", "monsterResistance"], qualityValues: { monsterResistance: "all monster sets" },
      description: "<p>Viper School witcher armor. <strong>Set effects (Witcher only):</strong> (1) +2 Stealth. (2) When you hit an enemy with the right blade oil applied, they suffer poison even if normally immune. (3) Extra-Action STA cost for Joint Strikes with swords/small blades is reduced from 3 to 1.</p>" },
    { name: "Manticore Witcher Hood", sp: 10, ev: 0, resist: "", cover: "head",    ae: { head: 2 },    en: 0, wt: 1.5, cost: 0, av: "R", type: "light",
      qualities: ["meteorite", "silver", "monsterResistance"], qualityValues: { monsterResistance: "all monster sets" },
      description: "<p>Manticore School witcher hood. <strong>Meteorite, Silver, Monster Resistance</strong>.</p>" },
    { name: "Manticore Witcher Armor", sp: 10, ev: 0, resist: "", cover: "full",   ae: { torso: 2 },   en: 1, wt: 6, cost: 0, av: "R", type: "light",
      qualities: ["meteorite", "silver", "monsterResistance"], qualityValues: { monsterResistance: "all monster sets" },
      description: "<p>Manticore School witcher armor. <strong>Set effects (Witcher only):</strong> (1) Once per round, draw an item from the bandolier without spending an Action. (2) +2 Alchemy. (3) Ignore STA cost of Blocking with a shield.</p>" },

    /* Medium Armor schools */
    { name: "Wolven Witcher Hood", sp: 14, ev: 0, resist: "", cover: "head",       ae: { head: 2 },    en: 0, wt: 1.5, cost: 0, av: "R", type: "medium",
      qualities: ["meteorite", "silver", "monsterResistance"], qualityValues: { monsterResistance: "all monster sets" },
      description: "<p>Wolf School witcher hood. <strong>Meteorite, Silver, Monster Resistance</strong>.</p>" },
    { name: "Wolven Witcher Armor", sp: 14, ev: 2, resist: "", cover: "full",      ae: { torso: 2 },   en: 1, wt: 8.5, cost: 0, av: "R", type: "medium",
      qualities: ["meteorite", "silver", "monsterResistance"], qualityValues: { monsterResistance: "all monster sets" },
      description: "<p>Wolf School witcher armor. <strong>Set effects (Witcher only):</strong> (1) Armor EV does not apply to Dodge/Escape. (2) Ignore STA cost of Blocking with a sword. (3) Extra-Action STA cost for Strong Strikes with swords is reduced from 3 to 1.</p>" },
    { name: "Gryphon Witcher Helmet", sp: 16, ev: 0, resist: "", cover: "head",    ae: { head: 1 },    en: 0, wt: 2, cost: 0, av: "R", type: "medium",
      qualities: ["meteorite", "silver", "monsterResistance", "stifling"], qualityValues: { monsterResistance: "all monster sets" },
      description: "<p>Griffin School witcher helmet. <strong>Meteorite, Silver, Monster Resistance, Stifling</strong>.</p>" },
    { name: "Gryphon Witcher Armor", sp: 16, ev: 4, resist: "", cover: "full",     ae: { torso: 1 },   en: 2, wt: 13, cost: 0, av: "R", type: "medium",
      qualities: ["meteorite", "silver", "monsterResistance"], qualityValues: { monsterResistance: "all monster sets" },
      description: "<p>Griffin School witcher armor. <strong>Set effects (Witcher only):</strong> (1) Armor EV does not affect Spell Casting. (2) Extra-Action STA cost for casting Signs is reduced from 3 to 1. (3) Halve all penalties for being ganged up on.</p>" },

    /* Heavy Armor school */
    { name: "Ursine Witcher Helm", sp: 20, ev: 0, resist: "", cover: "head",       ae: { head: 2 },    en: 0, wt: 3, cost: 0, av: "R", type: "heavy",
      qualities: ["meteorite", "silver", "monsterResistance", "stifling"], qualityValues: { monsterResistance: "all monster sets" },
      description: "<p>Bear School witcher helm. <strong>Meteorite, Silver, Monster Resistance, Stifling</strong>.</p>" },
    { name: "Ursine Witcher Armor", sp: 20, ev: 6, resist: "", cover: "full",      ae: { torso: 2 },   en: 1, wt: 18, cost: 0, av: "R", type: "heavy",
      qualities: ["meteorite", "silver", "monsterResistance"], qualityValues: { monsterResistance: "all monster sets" },
      description: "<p>Bear School witcher armor. <strong>Set effects (Witcher only):</strong> (1) Armor EV does not apply to Endurance. (2) If an enemy strikes you for 0 damage you can spend 1 STA to stagger them. (3) When struck, treat the attack's crit threshold as 3 lower for the purposes of suffering critical wounds.</p>" },

    /* ── ADDED v2 — missing PDF content (auto-spliced) ──────────── */
    /* ── Ofieri Clothing (EO p.3 general gear) ──────────────────────── */
    /* Basic Ofieri Clothing — listed under General Gear, not as armor
       but used as a clothing layer.  SP 0 (it's clothing). */
    { name: "Basic Ofieri Clothing", sp: 0, ev: 0, resist: "", cover: "full",
      ae: 0, en: 0, wt: 1.5, cost: 25, av: "R", type: "light",
      description: "<p>Loose Ofieri robes suited to desert travel.</p>" },
    // uncertain: SP for fancy clothing not listed; treated as cosmetic with no SP.
    { name: "Fancy Ofieri Clothing", sp: 0, ev: 0, resist: "", cover: "full",
      ae: 0, en: 0, wt: 1.5, cost: 150, av: "R", type: "light",
      qualities: ["fireproof"], // uncertain: "+5 Endurance vs hot weather" has no exact catalog key; closest is heat tolerance — left as a descriptive note instead of mapping to fireproof; remove if undesired
      description: "<p>Finely tailored Ofieri robes. Grants +5 to Endurance checks made to resist hot weather environments.</p>" },

    /* ── Elderfolk Armory — Light Armor (EO p.28 / desc. p.80) ───── */
    { name: "Protective Doublet", sp: 8, ev: 0, resist: "", cover: "torso+arms",
      ae: { torso: 1 }, en: 2, wt: 1, cost: 429, av: "R", type: "light",
      qualities: ["hidden"], qualityValues: { hidden: "DC:20 Awareness" },
      description: "<p>A sturdily padded jacket that nonetheless looks like ordinary clothing. Especially easy to conceal under other clothing; certain halfling-owned workshops excel in their production. <strong>Hidden (DC:20 Awareness)</strong>.</p>" },

    { name: "Gnomish Mail Hood", sp: 10, ev: 0, resist: "S", cover: "head",
      ae: { head: 1 }, en: 0, wt: 1.5, cost: 668, av: "R", type: "light",
      description: "<p>A finely woven gnomish mail hood of perfect Mahakaman steel. Fits as snugly as well-tailored clothing.</p>" },

    { name: "Gnomish Mail Shirt", sp: 10, ev: 0, resist: "S", cover: "torso+arms",
      ae: { torso: 1 }, en: 2, wt: 2.5, cost: 1858, av: "R", type: "light",
      description: "<p>A finely woven gnomish mail shirt of perfect Mahakaman steel. Dense coverage with no encumbrance penalty thanks to gnomish craft.</p>" },

    { name: "Gnomish Mail Trousers", sp: 10, ev: 0, resist: "S", cover: "legs",
      ae: { leftLeg: 1 }, en: 0, wt: 2, cost: 1319, av: "R", type: "light",
      description: "<p>Finely woven gnomish mail chausses of perfect Mahakaman steel.</p>" },

    { name: "Scoia'tael Hood", sp: 8, ev: 0, resist: "", cover: "head",
      ae: { head: 1 }, en: 0, wt: 0.5, cost: 275, av: "R", type: "light",
      description: "<p>A linen forest-elf hood crafted by old ritualistic methods that function as an alchemical strengthening treatment. <em>Set Bonus (Scoia'tael)</em>.</p>" },

    { name: "Scoia'tael Cloak", sp: 8, ev: 0, resist: "", cover: "full",
      ae: { torso: 1 }, en: 0, wt: 1.5, cost: 498, av: "R", type: "light",
      description: "<p>Flowing linen elven cloak/robe, bound up with belts; utterly silent and helps the wearer blend into the wilds. Marks the wearer as a free-elf sympathizer. <em>Set Bonus (Scoia'tael)</em>.</p>" },

    /* ── Elderfolk Armory — Medium Armor ──────────────────────────── */
    { name: "Dwarven Hood", sp: 16, ev: 0, resist: "", cover: "head",
      ae: { head: 2 }, en: 0, wt: 1, cost: 321, av: "R", type: "medium",
      description: "<p>A hardy dwarven travel hood of dense linen and leather; waterproof and ideal as flexible armor.</p>" },

    { name: "Dwarven Cloak", sp: 16, ev: 0, resist: "", cover: "full",
      ae: { torso: 2 }, en: 1, wt: 4, cost: 1230, av: "R", type: "medium",
      description: "<p>A hardy dwarven travel cloak of dense linen and leather; waterproof and ideal as flexible armor.</p>" },

    { name: "Scoia'tael Brigandine", sp: 20, ev: 0, resist: "", cover: "torso",
      ae: { torso: 2 }, en: 1, wt: 6, cost: 1338, av: "R", type: "medium",
      description: "<p>Dark-steel brigandine faced with forest patterns; effective yet relatively light, allowing stealthy movement. <em>Set Bonus (Scoia'tael)</em>.</p>" },

    { name: "Scoia'tael Chausses", sp: 14, ev: 1, resist: "", cover: "legs",
      ae: { leftLeg: 2 }, en: 0, wt: 4, cost: 1303, av: "R", type: "medium",
      description: "<p>Dark-steel plated chausses faced with forest patterns. <em>Set Bonus (Scoia'tael)</em>.</p>" },

    /* ── Elderfolk Armory — Heavy Armor (Cheval set) ─────────────── */
    { name: "Cheval Helm", sp: 24, ev: 1, resist: "S", cover: "head",
      ae: { head: 3 }, en: 0, wt: 3, cost: 869, av: "R", type: "heavy",
      qualities: ["stifling"],
      description: "<p>An open-faced gnomish sallet of exquisitely etched Mahakaman steel. <strong>Stifling</strong>; <em>Set Bonus (Cheval)</em>.</p>" },

    { name: "Cheval Breastplate", sp: 24, ev: 1, resist: "S", cover: "torso",
      ae: { torso: 3 }, en: 2, wt: 4, cost: 1605, av: "R", type: "heavy",
      qualities: ["stifling", "superiorLanceRest"], difficult: true,
      description: "<p>A hinged Mahakaman-steel breastplate with reinforced lance rest, designed for the lance charge; lacks coverage at armpits and groin. <strong>Difficult, Stifling, Superior Lance Rest</strong>; <em>Set Bonus (Cheval)</em>.</p>" },

    { name: "Cheval Arm Harnisse", sp: 20, ev: 2, resist: "S", cover: "arms",
      ae: { leftArm: 3 }, en: 0, wt: 3, cost: 1260, av: "R", type: "heavy",
      qualities: ["stifling", "rangedPenalty"], qualityValues: { rangedPenalty: "1" }, difficult: true,
      description: "<p>Cheval arm harnisse of Mahakaman steel; doesn't cover the inner or lower arms. <strong>Difficult, Stifling, Ranged -1</strong>; <em>Set Bonus (Cheval)</em>.</p>" },

    { name: "Cheval Leg Harnisse", sp: 20, ev: 2, resist: "S", cover: "legs",
      ae: { leftLeg: 3 }, en: 0, wt: 4, cost: 1501, av: "R", type: "heavy",
      qualities: ["stifling", "spdPenalty"], qualityValues: { spdPenalty: "1" }, difficult: true,
      description: "<p>Cheval leg harnisse of Mahakaman steel; leaves hips and inner legs vulnerable. <strong>Difficult, Stifling, SPD -1</strong>; <em>Set Bonus (Cheval)</em>.</p>" },

    /* ── Elderfolk Armory — Heavy Armor (Mahakaman set) ──────────── */
    { name: "Mahakaman Helm", sp: 30, ev: 2, resist: "S/P/B", cover: "head",
      ae: { head: 3 }, en: 0, wt: 5, cost: 1110, av: "R", type: "heavy",
      qualities: ["stifling", "poorVision"],
      description: "<p>Distinctive angular dwarven helm of Mahakaman steel, etched with runes; long domed visor can be opened for vision and breathing. <strong>Stifling, Poor Vision (can be opened)</strong>.</p>" },

    { name: "Mahakaman Breastplate", sp: 30, ev: 2, resist: "S/P/B", cover: "torso",
      ae: { torso: 3 }, en: 2, wt: 8, cost: 2145, av: "R", type: "heavy",
      qualities: ["stifling"], difficult: true,
      description: "<p>Total, layered dwarven breastplate with gorget, hinged plackart, articulated fauld and besagews; etched Mahakaman steel. <strong>Difficult, Stifling</strong>.</p>" },

    { name: "Mahakaman Arm Harnisse", sp: 24, ev: 3, resist: "S/P/B", cover: "arms",
      ae: { leftArm: 3 }, en: 0, wt: 6, cost: 1648, av: "R", type: "heavy",
      qualities: ["stifling", "rangedPenalty"], qualityValues: { rangedPenalty: "2" }, difficult: true,
      description: "<p>Dwarven arm harnisse beginning at sturdy pauldrons over rerebraces, with articulated couters layering double defenses over vambraces and broad-cuffed fingered gauntlets. <strong>Difficult, Stifling, Ranged -2</strong>.</p>" },

    { name: "Mahakaman Leg Harnisse", sp: 24, ev: 3, resist: "S/P/B", cover: "legs",
      ae: { leftLeg: 3 }, en: 0, wt: 7, cost: 1870, av: "R", type: "heavy",
      qualities: ["stifling", "spdPenalty"], qualityValues: { spdPenalty: "2" }, difficult: true,
      description: "<p>Dwarven leg harnisse with tassets over hips, cuisses and greaves encasing the legs front to back, articulated poleyns, and sabotons over the arming shoes. <strong>Difficult, Stifling, SPD -2</strong>.</p>" }
];

/* ── SHIELDS (EO p.13: Basic Shields, columns CV Rel. Bash EV En.) ── */
const SHIELDS = [
    /* Basic Shields (EO p.13) — Small / Medium / Large per the table. */
    { name: "Wood Buckler",     cv: 0, rel: 5,  bash: "1d6",    ev: 0, en: 0, wt: 0.5, cost: 13,  av: "E",
      qualities: ["parryingShield"],
      description: "<p>Wooden fist-shield. <strong>Parrying</strong>.</p>" },
    { name: "Leather Buckler",  cv: 0, rel: 10, bash: "1d6",    ev: 0, en: 0, wt: 1,   cost: 52,  av: "E",
      qualities: ["parryingShield"],
      description: "<p>Hardened leather buckler. <strong>Parrying</strong>.</p>" },
    { name: "Iron Buckler",     cv: 0, rel: 15, bash: "1d6",    ev: 0, en: 1, wt: 1,   cost: 94,  av: "C",
      qualities: ["parryingShield"],
      description: "<p>Iron-banded buckler. <strong>Parrying</strong>.</p>" },
    { name: "Round Skjold",     cv: 3, rel: 12, bash: "1d6+4",  ev: 1, en: 1, wt: 1.5, cost: 141, av: "P",
      description: "<p>Skellige round shield.</p>" },
    { name: "Arming Shield",    cv: 2, rel: 16, bash: "1d6+4",  ev: 2, en: 1, wt: 2,   cost: 157, av: "C",
      qualities: ["sturdyShield"],
      description: "<p>Knight's arming shield. <strong>Sturdy</strong>.</p>" },
    { name: "Heavy Shield",     cv: 2, rel: 20, bash: "1d6+4",  ev: 4, en: 1, wt: 3,   cost: 322, av: "P",
      qualities: ["verySturdy"],
      description: "<p>Heavy infantry shield. <strong>Very Sturdy</strong>.</p>" },
    { name: "Horseman's Shield", cv: 4, rel: 12, bash: "1d6+8", ev: 3, en: 1, wt: 2.5, cost: 201, av: "C",
      qualities: ["sturdyShield"],
      description: "<p>Cavalry shield. <strong>Sturdy</strong>.</p>" },
    { name: "Skyuto",           cv: 3, rel: 15, bash: "1d6+8",  ev: 5, en: 1, wt: 4,   cost: 399, av: "R",
      qualities: ["verySturdy"],
      description: "<p>Large Ofieri war shield. <strong>Very Sturdy</strong>.</p>" },
    { name: "Pavise",           cv: 6, rel: 15, bash: "1d6+8",  ev: 8, en: 0, wt: 5,   cost: 500, av: "P",
      qualities: ["sturdyShield", "deployable"],
      description: "<p>Massive freestanding shield. CV 6 — full cover when deployed. <strong>Sturdy, Deployable</strong>.</p>" },

    /* ── Quality Northern Shields (EO p.18) ─────────────────────── */
    { name: "Temerian Target",   cv: 1, rel: 15, bash: "1d6",    ev: 0, en: 2, wt: 2,   cost: 266, av: "P",
      qualities: ["sturdyShield"],
      description: "<p>Strapped shoulder-shield (no hands). <strong>Sturdy</strong>. Use a weapon at -2 in the other hand alongside.</p>" },
    { name: "Drakeskin Skjold",  cv: 3, rel: 12, bash: "1d6+4",  ev: 1, en: 1, wt: 3,   cost: 428, av: "R",
      qualities: ["fireproof"],
      description: "<p>Skellige drake-hide shield. <strong>Fireproof</strong>.</p>" },
    { name: "Kaedweni Teardrop", cv: 4, rel: 18, bash: "1d6+8",  ev: 4, en: 1, wt: 3.5, cost: 337, av: "P",
      qualities: ["verySturdy"],
      description: "<p>Kaedweni teardrop war-shield. <strong>Very Sturdy</strong>.</p>" },

    /* ── Fine Southern Shields (EO p.21) ────────────────────────── */
    { name: "Terganian Buckler", cv: 0, rel: 10, bash: "1d6",    ev: 0, en: 1, wt: 1,   cost: 259, av: "P",
      qualities: ["parryingShield", "bladeCatcherArmor"],
      description: "<p>Notched parrying-buckler. <strong>Parrying, Blade Catcher</strong>. Catches use Melee instead of Small Blades.</p>" },
    { name: "Etolian Rodella",   cv: 2, rel: 16, bash: "1d6+4",  ev: 3, en: 1, wt: 4,   cost: 601, av: "P",
      qualities: ["verySturdy"],
      description: "<p>Heavy round shield. <strong>Very Sturdy</strong>.</p>" },
    { name: "Black Army Pavise", cv: 6, rel: 21, bash: "1d6+8",  ev: 8, en: 1, wt: 6,   cost: 790, av: "P",
      qualities: ["verySturdy", "deployable"],
      description: "<p>Nilfgaardian military pavise. <strong>Very Sturdy, Deployable</strong>.</p>" },

    /* ── Exotic Shields (EO p.24) ───────────────────────────────── */
    { name: "Bambai", cv: 1, rel: 10, bash: "1d6",   ev: 0, en: 0, wt: 1, cost: 73,  av: "R",
      qualities: ["archeryShield"],
      description: "<p>Haakish archer's shield. <strong>Archery Shield</strong>. Worn on forearm: -1 Block/Parry, allows bow/crossbow at no penalty.</p>" },
    { name: "Derah",  cv: 2, rel: 20, bash: "1d6+4", ev: 2, en: 2, wt: 3, cost: 588, av: "R",
      qualities: ["verySturdy"],
      description: "<p>Ofieri round war-shield. <strong>Very Sturdy</strong>.</p>" },
    { name: "Spara",  cv: 5, rel: 12, bash: "1d6+8", ev: 2, en: 0, wt: 2, cost: 141, av: "R",
      qualities: ["deployable"],
      description: "<p>Wicker freestanding shield. <strong>Deployable</strong>.</p>" },

    /* ── Eldercraft Shields (EO p.26 — Mahakaman pavise) ────────── */
    { name: "Mahakaman Pavise", cv: 5, rel: 24, bash: "1d6+8", ev: 6, en: 1, wt: 6, cost: 1210, av: "R",
      qualities: ["verySturdy", "deployable"],
      description: "<p>Dwarven master-crafted pavise. <strong>Very Sturdy, Deployable</strong>.</p>" },

    /* ── Witcher School Shields (EO p.31) ───────────────────────── */
    { name: "Manticore Shield", cv: 2, rel: 16, bash: "1d6+4", ev: 2, en: 2, wt: 2, cost: 0, av: "R",
      qualities: ["sturdyShield", "meteorite", "silver"], qualityValues: { silver: "2d6" },
      description: "<p>Manticore School round shield. <strong>Sturdy, Meteorite, Silver +2d6</strong>.</p>" },

    /* ── ADDED v2 — missing PDF content (auto-spliced) ──────────── */
    /* ── Elderfolk Shields (EO p.28 / desc. p.80) ───────────────── */
    { name: "Gnomish Buckler", cv: 0, rel: 20, bash: "1d6", ev: 0, en: 3, wt: 1, cost: 484, av: "R",
      qualities: ["parryingShield"],
      description: "<p>An ornate gnomish steel buckler; for gnomes it's a sizable shield, for humans/elves it barely covers the fist — but incredibly durable. <strong>Parrying</strong>.</p>" },

    { name: "Elven Shield", cv: 3, rel: 16, bash: "1d6+4", ev: 1, en: 2, wt: 2, cost: 851, av: "R",
      qualities: ["sturdyShield"],
      description: "<p>An ornate aen siedhe wooden shield rimmed and bossed with dark steel, faced with dyed silk. A relic of an era when elves fought in shield walls. <strong>Sturdy</strong>.</p>" },

    { name: "Wyvern Scale Shield", cv: 3, rel: 16, bash: "1d6+4", ev: 3, en: 1, wt: 3, cost: 583, av: "R",
      qualities: ["sturdyShield", "fireproof"],
      description: "<p>A sturdy shield of treated drake hide, highly flame resistant and non-flammable. Kept in Mahakaman armories against fire-breathing draconids; popular with monster hunters. <strong>Sturdy, Fireproof</strong>.</p>" }
];

/* ── WEAPONS (EO p.10-12: Basic Melee + Ranged) ─────────────────────
 * Columns: WA, Dmg, Throw (range mult of BODY or N/A), Rl. (reliability),
 *          En. (slot), effects (qualities), Cn. (conceal), Wt., Av., Price.
 * `category` is the skill grouping: knives/swords1h/swords2h/melee1h/
 *  melee2h/staff1h/staff2h/throwing/bows/crossbows1h/crossbows2h/etc.
 * `damageType` is P/S/B/N etc. (EO uses combos like P/S, B/N for nonlethal).
 *  Damage type codes: P=piercing, S=slashing, B=bludgeoning, N=non-lethal,
 *  E=elemental. Translate to schema damageTypes array.
 * `hands` is "one" or "two".
 * ───────────────────────────────────────────────────────────────── */

/* Helper: parse "P/S" → ["piercing","slashing"]. "B/N" → ["bludgeoning"] + nonLethal flag. */
function parseDamageType(code) {
    const types = [];
    let nonLethal = false;
    for (const c of code.split("/")) {
        switch (c.trim()) {
            case "P": types.push("piercing"); break;
            case "S": types.push("slashing"); break;
            case "B": types.push("bludgeoning"); break;
            case "N": nonLethal = true; break;
            case "E": types.push("elemental"); break;
            default: INCONSISTENCIES.push(`Unknown damage-type code in weapon: "${c}"`);
        }
    }
    return { types, nonLethal };
}

const WEAPONS = [
    /* Knives & Daggers (Brawling / Small Blades, throwing-capable) */
    { name: "Eating Knife",  wa: 0, dmg: "1d6",   dmgType: "P/S",   range: "BODY×3", rel: 2, en: 0, conceal: "T", wt: 0.1, cost: 51, av: "E", hands: "one", quick: true,
      qualities: ["closeQuarters", "throwing"], qualityValues: { closeQuarters: "+1 WA, +3 Dmg" },
      category: "smallBlades", skill: "smallBlades",
      description: "<p>A simple eating knife. Close Quarters: +1 WA, +3 Dmg.</p>" },
    { name: "Work Knife",    wa: 0, dmg: "1d6+2", dmgType: "P/S",   range: "BODY×3", rel: 6, en: 0, conceal: "T", wt: 0.3, cost: 76, av: "E", hands: "one", quick: true,
      qualities: ["nimble", "feeble", "bleeding", "foraging", "closeQuarters", "throwing"],
      qualityValues: { bleeding: "25", foraging: "carcasses", closeQuarters: "+1 WA, +1d6 Dmg" },
      category: "smallBlades", skill: "smallBlades",
      description: "<p>Versatile work knife. Used for skinning, dressing carcasses, and short-range combat.</p>" },
    { name: "Throwing Knife", wa: 0, dmg: "1d6", dmgType: "P", range: "BODY×4", rel: 1, en: 0, conceal: "T", wt: 0.1, cost: 38, av: "E", hands: "one", quick: true,
      qualities: ["feeble", "nimble", "concealment", "bleeding", "throwing"],
      qualityValues: { bleeding: "25", throwing: "+1 WA, +1d6 Dmg" },
      category: "smallBlades", skill: "smallBlades",
      description: "<p>Balanced throwing knife.</p>" },
    { name: "Dagger",         wa: 0, dmg: "1d6+2", dmgType: "P/S", range: "BODY×3", rel: 4, en: 0, conceal: "S", wt: 0.3, cost: 122, av: "E", hands: "one", quick: true,
      qualities: ["feeble", "nimble", "balanced", "bleeding", "closeQuarters", "throwing"],
      qualityValues: { bleeding: "50", closeQuarters: "+2 WA, +1d6 Dmg" },
      category: "smallBlades", skill: "smallBlades",
      description: "<p>Standard fighting dagger. Excellent close-quarters bonus.</p>" },

    /* Swordsmanship, One-Handed */
    { name: "Iron Sword",    wa: 1, dmg: "2d6+3", dmgType: "P/S", range: "BODY×1", rel: 10, en: 0, conceal: "L", wt: 1.2, cost: 250, av: "E", hands: "one",
      qualities: ["guard"],
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>Basic iron sword. <strong>Guard</strong>.</p>" },
    { name: "Steel Sword",   wa: 1, dmg: "3d6+2", dmgType: "P/S", range: "BODY×1", rel: 10, en: 1, conceal: "L", wt: 1.2, cost: 261, av: "C", hands: "one",
      qualities: ["guard"],
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>Quality steel sword. <strong>Guard</strong>.</p>" },
    { name: "Longsword",     wa: 0, dmg: "3d6+4", dmgType: "P/S", range: "BODY×1", rel: 10, en: 1, conceal: "N/A", wt: 1.5, cost: 343, av: "P", hands: "one",
      qualities: ["guard", "twoHand"], qualityValues: { twoHand: "+2 WA, Balanced" },
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>Versatile hand-and-a-half sword. <strong>Guard</strong>; <strong>Two-Hand</strong>: +2 WA, Balanced.</p>" },

    /* Melee, One-Handed (axes, picks, hammers) */
    { name: "Throwing Axe",  wa: 0, dmg: "2d6", dmgType: "S", range: "BODY×2", rel: 4, en: 0, conceal: "S", wt: 0.6, cost: 65, av: "C", hands: "one",
      qualities: ["throwing"], qualityValues: { throwing: "+2d6 Dmg" },
      category: "melee", skill: "melee",
      description: "<p>Balanced throwing axe.</p>" },
    { name: "Mace",          wa: 0, dmg: "4d6", dmgType: "B", range: "BODY×1", rel: 10, en: 0, conceal: "L", wt: 1, cost: 256, av: "C", hands: "one",
      qualities: ["ablating"],
      category: "melee", skill: "melee",
      description: "<p>Heavy single-handed mace. <strong>Ablating</strong>.</p>" },
    { name: "Battle Axe",    wa: 0, dmg: "4d6", dmgType: "S", range: "BODY×1", rel: 8, en: 0, conceal: "L", wt: 1, cost: 260, av: "C", hands: "one",
      qualities: ["ablating"],
      category: "melee", skill: "melee",
      description: "<p>Single-bit battle axe. <strong>Ablating</strong>.</p>" },
    { name: "War Hammer",    wa: 0, dmg: "3d6+3", dmgType: "P/B", range: "BODY×1", rel: 10, en: 0, conceal: "N/A", wt: 1.5, cost: 329, av: "C", hands: "one",
      qualities: ["hefty", "armorPiercing", "twoHand"], qualityValues: { twoHand: "+2d6 Dmg" },
      category: "melee", skill: "melee",
      description: "<p>Heavy war hammer. <strong>Hefty, Armor Piercing</strong>; <strong>Two-Hand</strong>: +2d6 Dmg.</p>" },

    /* Melee, Two-Handed */
    { name: "Infantry Mace", wa: 0, dmg: "5d6", dmgType: "B", range: "N/A", rel: 10, en: 0, conceal: "N/A", wt: 2, cost: 314, av: "C", hands: "two",
      qualities: ["longReach", "sturdy", "ablating"],
      category: "melee", skill: "melee",
      description: "<p>Two-handed war mace. <strong>Long Reach, Sturdy, Ablating</strong>.</p>" },
    { name: "War Cleaver",   wa: 0, dmg: "5d6", dmgType: "S", range: "N/A", rel: 10, en: 0, conceal: "N/A", wt: 1.8, cost: 314, av: "C", hands: "two",
      qualities: ["hefty", "sturdy"],
      category: "melee", skill: "melee",
      description: "<p>Massive two-handed cleaver. <strong>Hefty, Sturdy</strong>.</p>" },
    { name: "Great Axe",     wa: 0, dmg: "5d6+3", dmgType: "S", range: "N/A", rel: 10, en: 0, conceal: "N/A", wt: 1.6, cost: 339, av: "C", hands: "two",
      qualities: ["longReach", "hefty", "ablating"],
      category: "melee", skill: "melee",
      description: "<p>Two-handed great axe. <strong>Long Reach, Hefty, Ablating</strong>.</p>" },

    /* Staff/Spear, One-Handed */
    { name: "Javelin",       wa: 0, dmg: "1d6+4", dmgType: "P", range: "BODY×5", rel: 4, en: 0, conceal: "L", wt: 0.5, cost: 62, av: "C", hands: "one",
      qualities: ["throwing"], qualityValues: { throwing: "+1 WA, +2d6 Dmg" },
      category: "staffSpear", skill: "staffSpear",
      description: "<p>Light throwing spear.</p>" },
    { name: "Spear",         wa: 0, dmg: "3d6+4", dmgType: "P", range: "BODY×3", rel: 8, en: 1, conceal: "N/A", wt: 1.5, cost: 163, av: "E", hands: "one",
      qualities: ["longReach", "footCharging", "twoHand"], qualityValues: { footCharging: "+2d6", twoHand: "+1 WA, Balanced" },
      category: "staffSpear", skill: "staffSpear",
      description: "<p>Standard infantry spear. <strong>Long Reach</strong>; <strong>Charging</strong>: +2d6; <strong>Two-Hand</strong>: +1 WA, Balanced.</p>" },
    { name: "Mage Crook",    wa: 0, dmg: "2d6", dmgType: "B/N", range: "N/A", rel: 4, en: 1, conceal: "N/A", wt: 1.5, cost: 364, av: "P", hands: "one",
      qualities: ["longReach", "grappling", "focus", "twoHand"], qualityValues: { focus: "1", twoHand: "+2 Dmg" },
      category: "staffSpear", skill: "staffSpear",
      description: "<p>Hooked walking staff carried by mages. <strong>Long Reach, Grappling, Focus (1)</strong>; <strong>Two-Hand</strong>: +2 Dmg.</p>" },
    { name: "Wizard Staff",  wa: 0, dmg: "2d6", dmgType: "B/N", range: "N/A", rel: 4, en: 1, conceal: "N/A", wt: 1.5, cost: 392, av: "P", hands: "one",
      qualities: ["longReach", "focus", "twoHand"], qualityValues: { focus: "1", twoHand: "+4 Dmg" },
      category: "staffSpear", skill: "staffSpear",
      description: "<p>Wizard's staff. <strong>Long Reach, Focus (1)</strong>; <strong>Two-Hand</strong>: +4 Dmg.</p>" },

    /* Staff/Spear, Two-Handed */
    { name: "Pike",          wa: 0, dmg: "4d6", dmgType: "P", range: "N/A", rel: 6, en: 0, conceal: "N/A", wt: 3.3, cost: 185, av: "C", hands: "two",
      qualities: ["superiorReach", "footCharging"], qualityValues: { footCharging: "+1d6" },
      category: "staffSpear", skill: "staffSpear",
      description: "<p>Long infantry pike. <strong>Superior Reach</strong>; <strong>Charging</strong>: +1d6.</p>" },
    { name: "Lance of Peace", wa: 0, dmg: "2d6+2", dmgType: "B/N", range: "N/A", rel: 10, en: 0, conceal: "N/A", wt: 4, cost: 302, av: "P", hands: "two",
      qualities: ["longReach", "hefty", "cavalry", "physique", "footCharging"],
      qualityValues: { physique: "13", footCharging: "+3d6" },
      category: "staffSpear", skill: "staffSpear",
      description: "<p>Blunted tournament lance. <strong>Long Reach, Hefty, Cavalry, Physique (13)</strong>; <strong>Charging</strong>: +3d6.</p>" },
    { name: "War Lance",     wa: 0, dmg: "2d6+2", dmgType: "P", range: "N/A", rel: 10, en: 0, conceal: "N/A", wt: 4, cost: 303, av: "P", hands: "two",
      qualities: ["longReach", "hefty", "cavalry", "physique", "footCharging"],
      qualityValues: { physique: "13", footCharging: "+5d6" },
      category: "staffSpear", skill: "staffSpear",
      description: "<p>Heavy war lance. <strong>Long Reach, Hefty, Cavalry, Physique (13)</strong>; <strong>Charging</strong>: +5d6.</p>" },
    { name: "Pole-Axe",      wa: 0, dmg: "6d6", dmgType: "P/S", range: "N/A", rel: 10, en: 0, conceal: "N/A", wt: 3.5, cost: 330, av: "C", hands: "two",
      qualities: ["longReach", "hefty", "sturdy", "grappling"],
      category: "staffSpear", skill: "staffSpear",
      description: "<p>Knight's pole-axe. <strong>Long Reach, Hefty, Sturdy, Grappling</strong>.</p>" },

    /* ── Quality Northern Hand Weapons (EO p.17) ────────────────── */
    { name: "Poniard", wa: 0, dmg: "2d6+3", dmgType: "P", range: "BODY×3", rel: 4, en: 1, conceal: "S", wt: 0.3, cost: 258, av: "P", hands: "one", quick: true,
      qualities: ["nimble", "balanced", "bleeding", "closeQuarters", "throwing"],
      qualityValues: { bleeding: "75", closeQuarters: "+3 WA, +1d6 Dmg, Armor Piercing" },
      category: "smallBlades", skill: "smallBlades",
      description: "<p>Long Northern dagger of fine steel. <strong>Nimble, Balanced, Bleed 75%</strong>; <strong>Close Quarters</strong> +3 WA, +1d6 Dmg, Armor Piercing.</p>" },
    { name: "Rondel Dagger", wa: 0, dmg: "2d6", dmgType: "P", range: "BODY×3", rel: 8, en: 1, conceal: "S", wt: 0.4, cost: 300, av: "P", hands: "one", quick: true,
      qualities: ["nimble", "bleeding", "armorPiercing", "closeQuarters", "throwing"],
      qualityValues: { bleeding: "25", closeQuarters: "+2 WA, +1d6 Dmg, Improved Armor Piercing" },
      category: "smallBlades", skill: "smallBlades",
      description: "<p>Knight's mail-piercing dagger. <strong>Nimble, Bleed 25%, Armor Piercing</strong>; <strong>Close Quarters</strong> +2 WA, +1d6 Dmg, Improved Armor Piercing.</p>" },
    { name: "Sword Catcher", wa: 0, dmg: "2d6", dmgType: "P/S", range: "BODY×2", rel: 10, en: 0, conceal: "S", wt: 0.5, cost: 379, av: "R", hands: "one", quick: true,
      qualities: ["nimble", "bladeCatcher", "bleeding", "closeQuarters", "throwing"],
      qualityValues: { bleeding: "25", closeQuarters: "+1 WA, +1d6 Dmg" },
      category: "smallBlades", skill: "smallBlades",
      description: "<p>Curved parrying-dagger. <strong>Nimble, Blade Catcher, Bleed 25%</strong>; <strong>Close Quarters</strong> +1 WA, +1d6 Dmg.</p>" },
    { name: "Tretagor Blade", wa: 1, dmg: "4d6", dmgType: "P/S", range: "BODY×1", rel: 15, en: 1, conceal: "L", wt: 1.3, cost: 605, av: "P", hands: "one",
      qualities: ["guard", "balanced", "twoHand", "closeQuarters"],
      qualityValues: { twoHand: "+1d6 Dmg", closeQuarters: "Armor Piercing" },
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>Refined Tretagor knight's sword. <strong>Guard, Balanced</strong>; <strong>Two-Hand</strong>: +1d6 Dmg; <strong>Close Quarters</strong>: Armor Piercing.</p>" },
    { name: "Krigssverd", wa: 1, dmg: "4d6+4", dmgType: "P/S", range: "BODY×1", rel: 10, en: 1, conceal: "L", wt: 1.3, cost: 620, av: "P", hands: "one",
      qualities: ["balanced"],
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>Heavy Skellige war-blade. <strong>Balanced</strong>.</p>" },
    { name: "Kord", wa: 1, dmg: "4d6+4", dmgType: "P/S", range: "BODY×1", rel: 15, en: 1, conceal: "N/A", wt: 1.5, cost: 691, av: "R", hands: "one",
      qualities: ["superiorGuard"],
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>Master-forged Skellige longsword. <strong>Superior Guard</strong>.</p>" },
    { name: "Dopplehander", wa: 0, dmg: "6d6", dmgType: "P/S", range: "BODY×1", rel: 20, en: 2, conceal: "N/A", wt: 3.5, cost: 1139, av: "R", hands: "two",
      qualities: ["longReach", "superiorGuard", "hefty", "sturdy", "ablating"],
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>Massive two-handed greatsword. <strong>Long Reach, Superior Guard, Hefty, Sturdy, Ablating</strong>.</p>" },
    { name: "Francisca", wa: 0, dmg: "2d6", dmgType: "S", range: "BODY×3", rel: 10, en: 0, conceal: "L", wt: 1, cost: 184, av: "R", hands: "one",
      qualities: ["throwing"], qualityValues: { throwing: "+3d6 Dmg, Armor Piercing" },
      category: "melee", skill: "melee",
      description: "<p>Frankish throwing axe. <strong>Throwing</strong>: +3d6 Dmg, Armor Piercing. If a thrown francisca misses, it bounces 1d6m in a random direction and may attack a nearby creature using 2d6 as its base.</p>" },
    { name: "Lamia", wa: 0, dmg: "2d6", dmgType: "S/B", range: "N/A", rel: 5, en: 0, conceal: "N/A", wt: 1.5, cost: 387, av: "R", hands: "one",
      qualities: ["bleeding", "indirect", "grappling"], qualityValues: { bleeding: "100" },
      category: "melee", skill: "melee",
      description: "<p>Hooked Indrun whip-flail. <strong>Bleed 100%, Indirect, Grappling</strong>.</p>" },
    { name: "Jogar", wa: 0, dmg: "5d6", dmgType: "B", range: "BODY×1", rel: 20, en: 1, conceal: "L", wt: 1.5, cost: 460, av: "C", hands: "one",
      qualities: ["ablating"],
      category: "melee", skill: "melee",
      description: "<p>Skellige war-club. <strong>Ablating</strong>.</p>" },
    { name: "Skeggax", wa: 0, dmg: "5d6", dmgType: "S", range: "BODY×2", rel: 10, en: 1, conceal: "L", wt: 1.3, cost: 488, av: "C", hands: "one",
      qualities: ["ablating"],
      category: "melee", skill: "melee",
      description: "<p>Bearded battle axe. <strong>Ablating</strong>.</p>" },
    { name: "Berserkax", wa: 0, dmg: "6d6+4", dmgType: "S", range: "N/A", rel: 10, en: 1, conceal: "N/A", wt: 1.8, cost: 791, av: "R", hands: "two",
      qualities: ["longReach", "sturdy", "ablating"],
      category: "melee", skill: "melee",
      description: "<p>Two-handed berserker's axe. <strong>Long Reach, Sturdy, Ablating</strong>.</p>" },
    { name: "Martel à Bec", wa: -1, dmg: "6d6+4", dmgType: "P/B", range: "N/A", rel: 12, en: 1, conceal: "N/A", wt: 3, cost: 958, av: "P", hands: "two",
      qualities: ["hefty", "sturdy", "ablating", "armorPiercing"],
      category: "melee", skill: "melee",
      description: "<p>Spike-tipped war hammer. <strong>Hefty, Sturdy, Ablating, Armor Piercing</strong>.</p>" },
    { name: "Highland Mauler", wa: -1, dmg: "6d6+4", dmgType: "B", range: "N/A", rel: 10, en: 1, conceal: "N/A", wt: 3.5, cost: 1107, av: "R", hands: "two",
      qualities: ["hefty", "sturdy", "stun"], qualityValues: { stun: "-2" },
      category: "melee", skill: "melee",
      description: "<p>Skellige greatmaul. <strong>Hefty, Sturdy, Stun (-2)</strong>.</p>" },
    { name: "Doryo", wa: 0, dmg: "4d6+2", dmgType: "P", range: "BODY×2", rel: 10, en: 1, conceal: "N/A", wt: 2, cost: 525, av: "R", hands: "one",
      qualities: ["longReach", "bleeding", "footCharging", "twoHand"],
      qualityValues: { bleeding: "25", footCharging: "+2d6", twoHand: "+1 WA, +2 Dmg" },
      category: "staffSpear", skill: "staffSpear",
      description: "<p>Verden hunting spear. <strong>Long Reach, Bleed 25%</strong>; <strong>Charging</strong>: +2d6; <strong>Two-Hand</strong>: +1 WA, +2 Dmg.</p>" },
    { name: "Vingespyd", wa: 0, dmg: "4d6", dmgType: "P", range: "BODY×2", rel: 10, en: 1, conceal: "N/A", wt: 1.8, cost: 553, av: "P", hands: "one",
      qualities: ["longReach", "footCharging", "twoHand"],
      qualityValues: { footCharging: "+1d6", twoHand: "+2 WA, +1d6 Dmg, Guard" },
      category: "staffSpear", skill: "staffSpear",
      description: "<p>Winged Skellige spear. <strong>Long Reach</strong>; <strong>Charging</strong>: +1d6; <strong>Two-Hand</strong>: +2 WA, +1d6 Dmg, Guard.</p>" },
    { name: "Crystal Staff", wa: 0, dmg: "1d6", dmgType: "B/N", range: "N/A", rel: 5, en: 2, conceal: "N/A", wt: 2, cost: 1927, av: "R", hands: "two",
      qualities: ["longReach", "focus", "greaterFocus"], qualityValues: { focus: "3" },
      category: "staffSpear", skill: "staffSpear",
      description: "<p>Mage's crystal-headed staff. <strong>Long Reach, Focus (3), Greater Focus</strong>.</p>" },
    { name: "Military Fork", wa: 0, dmg: "5d6+2", dmgType: "P", range: "BODY×1", rel: 12, en: 0, conceal: "N/A", wt: 2.5, cost: 529, av: "C", hands: "two",
      qualities: ["longReach", "sturdy", "grappling", "bleeding", "footCharging"],
      qualityValues: { bleeding: "50", footCharging: "+2d6" },
      category: "staffSpear", skill: "staffSpear",
      description: "<p>Two-tined infantry fork. <strong>Long Reach, Sturdy, Grappling, Bleed 50%</strong>; <strong>Charging</strong>: +2d6.</p>" },
    { name: "Redanian Halberd", wa: -1, dmg: "7d6", dmgType: "P/S", range: "N/A", rel: 10, en: 1, conceal: "N/A", wt: 4, cost: 1092, av: "P", hands: "two",
      qualities: ["superiorReach", "hefty", "sturdy", "grappling", "ablating", "footCharging"],
      qualityValues: { footCharging: "+1d6" },
      category: "staffSpear", skill: "staffSpear",
      description: "<p>Redanian polearm. <strong>Superior Reach, Hefty, Sturdy, Grappling, Ablating</strong>; <strong>Charging</strong>: +1d6.</p>" },

    /* ── Fine Southern (Viroledan) Hand Weapons (EO p.20-21) ────── */
    { name: "Stiletto", wa: 0, dmg: "1d6", dmgType: "P", range: "BODY×3", rel: 2, en: 1, conceal: "T", wt: 0.2, cost: 232, av: "C", hands: "one", quick: true,
      qualities: ["concealment", "feeble", "nimble", "bleeding", "closeQuarters", "throwing"],
      qualityValues: { bleeding: "50", closeQuarters: "+4 WA, +1d6 Dmg" },
      category: "smallBlades", skill: "smallBlades",
      description: "<p>Long narrow stabbing knife. <strong>Concealment, Feeble, Nimble, Bleed 50%</strong>; <strong>Close Quarters</strong>: +4 WA, +1d6 Dmg.</p>" },
    { name: "Sinestro", wa: 0, dmg: "2d6", dmgType: "P/S", range: "BODY×2", rel: 10, en: 1, conceal: "S", wt: 0.5, cost: 380, av: "P", hands: "one", quick: true,
      qualities: ["parrying", "nimble", "bleeding", "closeQuarters", "throwing"],
      qualityValues: { bleeding: "25", closeQuarters: "+1 WA, +1d6 Dmg" },
      category: "smallBlades", skill: "smallBlades",
      description: "<p>Viroledan parrying-dagger. <strong>Parrying, Nimble, Bleed 25%</strong>; <strong>Close Quarters</strong>: +1 WA, +1d6 Dmg.</p>" },
    { name: "Esboda", wa: 1, dmg: "4d6+2", dmgType: "P/S", range: "BODY×1", rel: 15, en: 1, conceal: "L", wt: 1.4, cost: 688, av: "P", hands: "one",
      qualities: ["guard", "cavalry"],
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>Mettinese cavalry sword. <strong>Guard, Cavalry</strong>.</p>" },
    { name: "Terganian Side Sword", wa: 2, dmg: "3d6+2", dmgType: "P/S", range: "BODY×1", rel: 10, en: 1, conceal: "N/A", wt: 1.4, cost: 723, av: "R", hands: "one",
      qualities: ["superiorGuard", "balanced"],
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>Viroledan side-sword. <strong>Superior Guard, Balanced</strong>.</p>" },
    { name: "Estoc", wa: 0, dmg: "3d6+2", dmgType: "P", range: "BODY×1", rel: 10, en: 1, conceal: "L", wt: 1.5, cost: 791, av: "R", hands: "one",
      qualities: ["guard", "armorPiercing", "twoHand", "closeQuarters"],
      qualityValues: { twoHand: "+1 WA, +1d6 Dmg", closeQuarters: "Improved Armor Piercing" },
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>Heavy-tipped thrusting sword. <strong>Guard, Armor Piercing</strong>; <strong>Two-Hand</strong>: +1 WA, +1d6 Dmg; <strong>Close Quarters</strong>: Improved Armor Piercing.</p>" },
    { name: "Viroledan Longsword", wa: 1, dmg: "4d6", dmgType: "P/S", range: "BODY×1", rel: 10, en: 1, conceal: "L", wt: 1.6, cost: 879, av: "R", hands: "one",
      qualities: ["guard", "balanced", "twoHand"], qualityValues: { twoHand: "+1 WA, +4 Dmg" },
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>Master-smithed longsword. <strong>Guard, Balanced</strong>; <strong>Two-Hand</strong>: +1 WA, +4 Dmg.</p>" },
    { name: "Vicovarian Blade", wa: 1, dmg: "5d6+2", dmgType: "P/S", range: "BODY×1", rel: 15, en: 1, conceal: "N/A", wt: 2.2, cost: 966, av: "R", hands: "two",
      qualities: ["guard", "sturdy", "balanced"],
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>Two-handed Vicovarian war-sword. <strong>Guard, Sturdy, Balanced</strong>.</p>" },
    { name: "Torrwr", wa: 1, dmg: "6d6", dmgType: "P/S", range: "BODY×1", rel: 15, en: 2, conceal: "N/A", wt: 3, cost: 1130, av: "R", hands: "two",
      qualities: ["longReach", "guard", "sturdy"],
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>Massive elven-inspired greatsword. <strong>Long Reach, Guard, Sturdy</strong>.</p>" },
    { name: "Flamberge", wa: 0, dmg: "6d6", dmgType: "P/S", range: "BODY×1", rel: 10, en: 2, conceal: "N/A", wt: 3.5, cost: 1180, av: "R", hands: "two",
      qualities: ["longReach", "superiorGuard", "hefty", "sturdy", "bleeding"],
      qualityValues: { bleeding: "50" },
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>Wavy-bladed two-handed sword. <strong>Long Reach, Superior Guard, Hefty, Sturdy, Bleed 50%</strong>.</p>" },
    { name: "Martello", wa: 0, dmg: "5d6+2", dmgType: "P/B", range: "BODY×1", rel: 10, en: 1, conceal: "L", wt: 1.2, cost: 540, av: "P", hands: "one",
      qualities: ["cavalry"],
      category: "melee", skill: "melee",
      description: "<p>Heavy cavalry hammer. <strong>Cavalry</strong>.</p>" },
    { name: "Ascia", wa: 0, dmg: "5d6+2", dmgType: "P/S", range: "BODY×1", rel: 10, en: 1, conceal: "L", wt: 1.2, cost: 547, av: "P", hands: "one",
      qualities: ["cavalry"],
      category: "melee", skill: "melee",
      description: "<p>Cavalry pickaxe. <strong>Cavalry</strong>.</p>" },
    { name: "Hache de Guerre", wa: 0, dmg: "6d6+4", dmgType: "P/S/B", range: "N/A", rel: 12, en: 1, conceal: "N/A", wt: 2.6, cost: 948, av: "P", hands: "two",
      qualities: ["hefty", "sturdy", "armorPiercing"],
      category: "melee", skill: "melee",
      description: "<p>Mettinese war-axe. <strong>Hefty, Sturdy, Armor Piercing</strong>.</p>" },
    { name: "Pilum", wa: 0, dmg: "4d6", dmgType: "P", range: "BODY×3", rel: 8, en: 1, conceal: "N/A", wt: 2, cost: 408, av: "P", hands: "one",
      qualities: ["throwing"], qualityValues: { throwing: "+1 WA, Improved Armor Piercing" },
      category: "staffSpear", skill: "staffSpear",
      description: "<p>Roman-style throwing spear. <strong>Throwing</strong>: +1 WA, Improved Armor Piercing.</p>" },
    { name: "Spontoon", wa: 1, dmg: "4d6", dmgType: "P", range: "BODY×2", rel: 12, en: 1, conceal: "N/A", wt: 1.6, cost: 536, av: "C", hands: "one",
      qualities: ["longReach", "footCharging", "twoHand"],
      qualityValues: { footCharging: "+1d6", twoHand: "+1d6 Dmg, Guard, Balanced" },
      category: "staffSpear", skill: "staffSpear",
      description: "<p>Officer's half-pike. <strong>Long Reach</strong>; <strong>Charging</strong>: +1d6; <strong>Two-Hand</strong>: +1d6 Dmg, Guard, Balanced.</p>" },
    { name: "Mancatcher", wa: 0, dmg: "0", dmgType: "B", range: "N/A", rel: 10, en: 0, conceal: "N/A", wt: 3, cost: 328, av: "C", hands: "two",
      qualities: ["longReach", "grappling"],
      category: "staffSpear", skill: "staffSpear",
      description: "<p>Long polearm with two-pronged grappling head. <strong>Long Reach, Grappling</strong>. Used only for Grapple/Pin/Choke Hold/Disarm/Trip at +2; can deal 3d6 B/N forgoing the bonus.</p>" },
    { name: "Partisan", wa: 1, dmg: "5d6+3", dmgType: "P/S", range: "BODY×2", rel: 12, en: 1, conceal: "N/A", wt: 2.4, cost: 777, av: "C", hands: "two",
      qualities: ["longReach", "guard", "sturdy", "footCharging"], qualityValues: { footCharging: "+1d6" },
      category: "staffSpear", skill: "staffSpear",
      description: "<p>Officer's polearm. <strong>Long Reach, Guard, Sturdy</strong>; <strong>Charging</strong>: +1d6.</p>" },
    { name: "Valenkosa", wa: 0, dmg: "7d6+3", dmgType: "S", range: "N/A", rel: 10, en: 1, conceal: "N/A", wt: 3.5, cost: 1052, av: "C", hands: "two",
      qualities: ["longReach", "hefty", "sturdy", "ablating", "bleeding"],
      qualityValues: { bleeding: "50" },
      category: "staffSpear", skill: "staffSpear",
      description: "<p>Cossack war-scythe. <strong>Long Reach, Hefty, Sturdy, Ablating, Bleed 50%</strong>.</p>" },
    { name: "Iron Staff", wa: -2, dmg: "5d6", dmgType: "B", range: "N/A", rel: 25, en: 1, conceal: "N/A", wt: 5, cost: 1459, av: "R", hands: "two",
      qualities: ["longReach", "hefty", "sturdy", "ablating", "focus"], qualityValues: { focus: "2" },
      category: "staffSpear", skill: "staffSpear",
      description: "<p>Iron-bound battle staff. <strong>Long Reach, Hefty, Sturdy, Ablating, Focus (2)</strong>. A mage can attune this staff for −1kg / +1 accuracy per 5 levels of Magical Training, costing 1 STA/round to maintain.</p>" },

    /* ── ADDED v2 — missing PDF content (auto-spliced) ──────────── */
    /* ── Makeshift Weapons (EO p.9-10) ─────────────────────────── */

    /* Brawling — Makeshift */
    { name: "Rope", wa: -1, dmg: "1d6+2", dmgType: "B", range: "N/A", rel: 4, en: 0, conceal: "L", wt: 0.5, cost: 20, av: "E", hands: "one", // uncertain: price/wt cross-referenced to core rules
      qualities: ["indirect", "grappling", "longReach", "strangling"],
      qualityValues: { strangling: "+2 WA, ×2 suffocation" },
      category: "brawling", skill: "brawling",
      description: "<p>A length of rope used to strike, trip, or strangle. <strong>Indirect, Grapple, Long Reach</strong>; <strong>Strangling</strong>: +2 WA, ×2 suffocation.</p>" },
    { name: "Rock", wa: -1, dmg: "1d6+4", dmgType: "B", range: "BODY×4", rel: 6, en: 0, conceal: "T", wt: 0.5, cost: 0, av: "E", hands: "one", quick: true, // uncertain: price N/A in PDF — free debris
      qualities: ["concealment", "throwing"],
      qualityValues: { throwing: "+1d6 Dmg" },
      category: "brawling", skill: "brawling",
      description: "<p>A simple rock picked up from the ground. <strong>Concealable</strong>; <strong>Throwing</strong>: +1d6 Dmg.</p>" },
    { name: "Field Doctor's Syringe", wa: 0, dmg: "1d6", dmgType: "P", range: "N/A", rel: 1, en: 0, conceal: "T", wt: 0.5, cost: 286, av: "P", hands: "one",
      qualities: ["feeble", "armorPiercing", "injector"],
      qualityValues: {},
      category: "smallBlades", skill: "smallBlades",
      description: "<p>A bulky reinforced syringe for piercing mail. <strong>Feeble, Armor Piercing, Injector</strong>.</p>" },

    /* Swordsmanship, One-Handed — Makeshift */
    { name: "Waster Sword", wa: 1, dmg: "1d6+4", dmgType: "B", range: "BODY×1", rel: 6, en: 0, conceal: "L", wt: 1, cost: 54, av: "E", hands: "one",
      qualities: ["twoHand"],
      qualityValues: { twoHand: "+1 WA, +1d6 Dmg" },
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>A wooden practice sword. <strong>Two-Hand</strong>: +1 WA, +1d6 Dmg.</p>" },

    /* Melee, One-Handed — Makeshift */
    { name: "Stick", wa: 0, dmg: "1d6+4", dmgType: "B", range: "BODY×1", rel: 4, en: 0, conceal: "S", wt: 1, cost: 0, av: "E", hands: "one", // uncertain: price N/A — free debris
      qualities: [],
      qualityValues: {},
      category: "melee", skill: "melee",
      description: "<p>A simple branch or chair-leg used as an improvised club.</p>" },
    { name: "Torch", wa: -1, dmg: "2d6", dmgType: "B", range: "BODY×1", rel: 2, en: 0, conceal: "L", wt: 0.2, cost: 6, av: "E", hands: "one", // dmgType uncertain: PDF lists E (fire) — using B as fallback; fire energy via quality
      qualities: ["fire"],
      qualityValues: { fire: "25" },
      category: "melee", skill: "melee",
      description: "<p>A lit torch used to strike or set foes alight. <strong>Fire 25%</strong>. Unlit, deals half damage as non-lethal bludgeoning.</p>" },
    { name: "Adze", wa: -1, dmg: "3d6+3", dmgType: "P", range: "BODY×2", rel: 4, en: 0, conceal: "S", wt: 1.5, cost: 93, av: "E", hands: "one",
      qualities: ["feeble", "crafting", "foraging"],
      qualityValues: { crafting: "fortifications", foraging: "timber, ore, & roots" },
      category: "melee", skill: "melee",
      description: "<p>An axe-like digging tool. <strong>Feeble, Craft (fortifications), Forage (timber, ore, & roots)</strong>.</p>" },
    { name: "Billhook", wa: -1, dmg: "3d6+3", dmgType: "S", range: "BODY×2", rel: 4, en: 0, conceal: "S", wt: 1.5, cost: 93, av: "E", hands: "one",
      qualities: ["feeble", "foraging"],
      qualityValues: { foraging: "timber & crops" },
      category: "melee", skill: "melee",
      description: "<p>A pruning blade used for shearing branches. <strong>Feeble, Forage (timber & crops)</strong>.</p>" },
    { name: "Hand Axe", wa: -1, dmg: "4d6", dmgType: "S", range: "BODY×2", rel: 4, en: 0, conceal: "S", wt: 1.5, cost: 93, av: "E", hands: "one",
      qualities: ["feeble", "ablating", "foraging"],
      qualityValues: { foraging: "timber" },
      category: "melee", skill: "melee",
      description: "<p>A small wood-cutting axe. <strong>Feeble, Ablating, Forage (timber)</strong>.</p>" },
    { name: "Pick", wa: -1, dmg: "4d6", dmgType: "P", range: "BODY×2", rel: 4, en: 0, conceal: "S", wt: 1.5, cost: 93, av: "E", hands: "one",
      qualities: ["feeble", "ablating", "foraging"],
      qualityValues: { foraging: "ore & roots" },
      category: "melee", skill: "melee",
      description: "<p>A spike-and-chisel digging tool. <strong>Feeble, Ablating, Forage (ore & roots)</strong>.</p>" },
    { name: "Work Hammer", wa: -1, dmg: "4d6", dmgType: "B", range: "BODY×2", rel: 4, en: 0, conceal: "S", wt: 1.5, cost: 93, av: "E", hands: "one",
      qualities: ["feeble", "ablating", "crafting"],
      qualityValues: { crafting: "carpentry & smithing" },
      category: "melee", skill: "melee",
      description: "<p>A common hammer for driving nails or shaping metal. <strong>Feeble, Ablating, Craft (carpentry & smithing)</strong>.</p>" },
    { name: "Sickle", wa: -2, dmg: "4d6+2", dmgType: "S", range: "BODY×1", rel: 4, en: 0, conceal: "L", wt: 1, cost: 100, av: "E", hands: "one",
      qualities: ["feeble", "grappling", "indirect", "bleeding", "foraging"],
      qualityValues: { bleeding: "50", foraging: "crops" },
      category: "melee", skill: "melee",
      description: "<p>A curved harvesting blade. <strong>Feeble, Grappling, Indirect, Bleed 50%, Forage (crops)</strong>.</p>" },
    { name: "Cudgel", wa: 0, dmg: "3d6", dmgType: "B", range: "BODY×1", rel: 8, en: 0, conceal: "L", wt: 1, cost: 105, av: "E", hands: "one",
      qualities: ["sturdy"],
      qualityValues: {},
      category: "melee", skill: "melee",
      description: "<p>A shaped striking stick. <strong>Sturdy</strong>.</p>" },
    { name: "Fighting Stick", wa: 1, dmg: "2d6", dmgType: "B", range: "BODY×1", rel: 4, en: 0, conceal: "S", wt: 0.5, cost: 112, av: "E", hands: "one",
      qualities: [],
      qualityValues: {},
      category: "melee", skill: "melee",
      description: "<p>A stick shaped for balance — accurate, but lighter than a club.</p>" },
    { name: "Bullwhip", wa: 0, dmg: "1d6+2", dmgType: "B", range: "N/A", rel: 2, en: 0, conceal: "S", wt: 0.5, cost: 192, av: "C", hands: "one",
      qualities: ["longReach", "feeble", "indirect", "grappling", "strangling"],
      qualityValues: { strangling: "×2 suffocation" },
      category: "melee", skill: "melee",
      description: "<p>A long leather lash used to trip, grapple, or crack. <strong>Long Reach, Feeble, Indirect, Grappling</strong>; <strong>Strangling</strong>: ×2 suffocation.</p>" },
    { name: "Druid's Sickle", wa: 0, dmg: "4d6", dmgType: "S", range: "BODY×1", rel: 15, en: 0, conceal: "L", wt: 1.2, cost: 543, av: "P", hands: "one",
      qualities: ["grappling", "indirect", "bleeding", "foraging"],
      qualityValues: { bleeding: "50", foraging: "crops" },
      category: "melee", skill: "melee",
      description: "<p>A finely-made ritual sickle, sharp and combat-worthy. <strong>Grappling, Indirect, Bleed 50%, Forage (crops)</strong>.</p>" },

    /* Melee, Two-Handed — Makeshift */
    { name: "Big Stick", wa: 0, dmg: "2d6+3", dmgType: "B", range: "BODY×1", rel: 6, en: 0, conceal: "L", wt: 2, cost: 0, av: "E", hands: "two", // uncertain: price N/A — free debris
      qualities: ["sturdy"],
      qualityValues: {},
      category: "melee", skill: "melee",
      description: "<p>A large branch, fence post, or piece of furniture used as a club. <strong>Sturdy</strong>.</p>" },
    { name: "Shovel", wa: 0, dmg: "3d6+3", dmgType: "S/B", range: "N/A", rel: 15, en: 0, conceal: "N/A", wt: 1.5, cost: 56, av: "E", hands: "two",
      qualities: ["sturdy", "foraging", "crafting"],
      qualityValues: { foraging: "roots or minerals", crafting: "pits & ditches, foundations" },
      category: "melee", skill: "melee",
      description: "<p>A sturdy digging tool. <strong>Sturdy, Forage (roots or minerals), Craft (pits & ditches, foundations)</strong>.</p>" },
    { name: "Lumber Axe", wa: -1, dmg: "5d6", dmgType: "S", range: "N/A", rel: 8, en: 0, conceal: "N/A", wt: 3, cost: 163, av: "E", hands: "two",
      qualities: ["hefty", "ablating", "foraging"],
      qualityValues: { foraging: "timber" },
      category: "melee", skill: "melee",
      description: "<p>A heavy axe for felling trees. <strong>Hefty, Ablating, Forage (timber)</strong>.</p>" },
    { name: "Mattock", wa: -1, dmg: "5d6", dmgType: "P", range: "N/A", rel: 8, en: 0, conceal: "N/A", wt: 3, cost: 163, av: "E", hands: "two",
      qualities: ["hefty", "ablating", "foraging"],
      qualityValues: { foraging: "ore & roots" },
      category: "melee", skill: "melee",
      description: "<p>A heavy pick with an adze counterweight. <strong>Hefty, Ablating, Forage (ore & roots)</strong>.</p>" },
    { name: "Maul", wa: -1, dmg: "5d6", dmgType: "B", range: "N/A", rel: 8, en: 0, conceal: "N/A", wt: 3, cost: 163, av: "E", hands: "two",
      qualities: ["hefty", "ablating", "crafting"],
      qualityValues: { crafting: "fortification & destruction" },
      category: "melee", skill: "melee",
      description: "<p>A heavy hammer for driving stakes or breaking constructions. <strong>Hefty, Ablating, Craft (fortification & destruction)</strong>.</p>" },
    { name: "Heavy Club", wa: 0, dmg: "4d6", dmgType: "B", range: "N/A", rel: 10, en: 0, conceal: "N/A", wt: 1.5, cost: 167, av: "E", hands: "two",
      qualities: ["hefty", "sturdy"],
      qualityValues: {},
      category: "melee", skill: "melee",
      description: "<p>A long, heavy cudgel balanced for fighting. <strong>Hefty, Sturdy</strong>.</p>" },
    { name: "Scythe", wa: -2, dmg: "5d6+2", dmgType: "S", range: "N/A", rel: 4, en: 0, conceal: "N/A", wt: 2, cost: 177, av: "E", hands: "two",
      qualities: ["hefty", "grappling", "indirect", "bleeding", "foraging"],
      qualityValues: { bleeding: "50", foraging: "crops" },
      category: "melee", skill: "melee",
      description: "<p>A long, concave farming blade. <strong>Hefty, Grappling, Indirect, Bleed 50%, Forage (crops)</strong>.</p>" },
    { name: "Flail", wa: -2, dmg: "5d6+4", dmgType: "B", range: "N/A", rel: 6, en: 0, conceal: "N/A", wt: 2.5, cost: 180, av: "E", hands: "two",
      qualities: ["hefty", "grappling", "indirect", "foraging"],
      qualityValues: { foraging: "grains" },
      category: "melee", skill: "melee",
      description: "<p>A threshing club with a swipple on a chain. <strong>Hefty, Grappling, Indirect, Forage (grains)</strong>.</p>" },

    /* Staff/Spear, One-Handed — Makeshift */
    { name: "Shepherd's Crook", wa: 0, dmg: "2d6", dmgType: "B", range: "N/A", rel: 4, en: 1, conceal: "N/A", wt: 1.2, cost: 35, av: "E", hands: "one",
      qualities: ["longReach", "grappling", "twoHand"],
      qualityValues: { twoHand: "+2 Dmg" },
      category: "staffSpear", skill: "staffSpear",
      description: "<p>A long staff with a curved hooked end. <strong>Long Reach, Grappling</strong>; <strong>Two-Hand</strong>: +2 Dmg.</p>" },
    { name: "Walking Stick", wa: 0, dmg: "2d6", dmgType: "B", range: "N/A", rel: 4, en: 1, conceal: "N/A", wt: 1.2, cost: 47, av: "E", hands: "one",
      qualities: ["longReach", "twoHand"],
      qualityValues: { twoHand: "+4 Dmg" },
      category: "staffSpear", skill: "staffSpear",
      description: "<p>A long, sturdy traveler's staff. <strong>Long Reach</strong>; <strong>Two-Hand</strong>: +4 Dmg.</p>" },

    /* Staff/Spear, Two-Handed — Makeshift */
    { name: "Bigger Stick", wa: 0, dmg: "3d6+2", dmgType: "B", range: "N/A", rel: 6, en: 0, conceal: "N/A", wt: 3, cost: 0, av: "E", hands: "two", // uncertain: price N/A — free debris
      qualities: ["longReach", "hefty", "sturdy"],
      qualityValues: {},
      category: "staffSpear", skill: "staffSpear",
      description: "<p>An extra-long heavy length of wood or barge pole. <strong>Long Reach, Hefty, Sturdy</strong>.</p>" },
    { name: "Pitch Fork", wa: -1, dmg: "4d6", dmgType: "P", range: "N/A", rel: 10, en: 0, conceal: "N/A", wt: 2.4, cost: 62, av: "E", hands: "two",
      qualities: ["grappling", "footCharging"],
      qualityValues: { footCharging: "+1d6" },
      category: "staffSpear", skill: "staffSpear",
      description: "<p>A long-hafted spiked farm tool. <strong>Grappling</strong>; <strong>Charging</strong>: +1d6.</p>" },
    { name: "Quarterstaff", wa: 1, dmg: "3d6+2", dmgType: "B", range: "N/A", rel: 10, en: 0, conceal: "N/A", wt: 1.8, cost: 87, av: "E", hands: "two",
      qualities: ["longReach", "sturdy"],
      qualityValues: {},
      category: "staffSpear", skill: "staffSpear",
      description: "<p>A 2.5m hardwood staff, well-balanced and hard-hitting. <strong>Long Reach, Sturdy</strong>.</p>" },
    { name: "Long Staff", wa: 0, dmg: "3d6+4", dmgType: "B", range: "N/A", rel: 10, en: 0, conceal: "N/A", wt: 2.8, cost: 149, av: "E", hands: "two",
      qualities: ["superiorReach", "sturdy"],
      qualityValues: {},
      category: "staffSpear", skill: "staffSpear",
      description: "<p>A 4m hardwood pole with terrific reach. <strong>Superior Reach, Sturdy</strong>.</p>" },
    { name: "Gissarme", wa: -1, dmg: "5d6", dmgType: "P/S", range: "N/A", rel: 8, en: 0, conceal: "N/A", wt: 3.5, cost: 195, av: "E", hands: "two",
      qualities: ["longReach", "hefty", "grappling"],
      qualityValues: {},
      category: "staffSpear", skill: "staffSpear",
      description: "<p>An improvised bladed polearm of welded farm implements. <strong>Long Reach, Hefty, Grappling</strong>.</p>" },
    { name: "War Scythe", wa: -1, dmg: "5d6+2", dmgType: "S", range: "N/A", rel: 8, en: 0, conceal: "N/A", wt: 4, cost: 220, av: "E", hands: "two",
      qualities: ["longReach", "hefty"],
      qualityValues: {},
      category: "staffSpear", skill: "staffSpear",
      description: "<p>A scythe blade remounted on a straight pole. <strong>Long Reach, Hefty</strong>.</p>" },

    /* ── Basic Hand Weapons — additions (EO p.11) ──────────────── */
    { name: "Garrote", wa: 0, dmg: "0", dmgType: "B", range: "N/A", rel: 4, en: 0, conceal: "T", wt: 0.1, cost: 78, av: "C", hands: "two", // uncertain: stats minimal in PDF (no WA/Dmg/Rl/En columns); wt/rel best-guess
      qualities: ["concealment", "strangling"],
      qualityValues: { strangling: "+2 WA, ×3 suffocation" },
      category: "brawling", skill: "brawling",
      description: "<p>A thin garroting wire that focuses the force of a choke hold. <strong>Concealable</strong>; <strong>Strangling</strong>: +2 WA, ×3 suffocation.</p>" },
    { name: "Knuckle Dusters", wa: 1, dmg: "+1d6", dmgType: "B", range: "N/A", rel: 4, en: 0, conceal: "T", wt: 0.5, cost: 75, av: "E", hands: "one", // uncertain: rel not listed in row
      qualities: ["brawling", "concealment"],
      qualityValues: { brawling: "Punch" },
      category: "brawling", skill: "brawling",
      description: "<p>A metal bar worn over the knuckles for extra punch. <strong>Brawling (Punch), Concealable</strong>.</p>" },
    { name: "Steeled Boots", wa: 1, dmg: "+1d6", dmgType: "B", range: "N/A", rel: 6, en: 0, conceal: "S", wt: 3, cost: 174, av: "C", hands: "one", // uncertain: rel/hands not standard for kicks
      qualities: ["brawling"],
      qualityValues: { brawling: "Kick" },
      category: "brawling", skill: "brawling",
      description: "<p>Reinforced boots that add weight to your kicks. <strong>Brawling (Kick)</strong>.</p>" },
    { name: "Temerian Pike", wa: 0, dmg: "4d6", dmgType: "P", range: "N/A", rel: 4, en: 0, conceal: "N/A", wt: 4.4, cost: 290, av: "P", hands: "two",
      qualities: ["extremeReach", "footCharging"],
      qualityValues: { footCharging: "+1d6" },
      category: "staffSpear", skill: "staffSpear",
      description: "<p>A twenty-foot pike first deployed at Brenna. <strong>Extreme Reach</strong>; <strong>Charging</strong>: +1d6.</p>" },

    /* ── Exotic Hand Weapons (EO p.23) ─────────────────────────── */
    { name: "Talvara", wa: 1, dmg: "4d6+4", dmgType: "P/S", range: "BODY×1", rel: 10, en: 1, conceal: "L", wt: 1.2, cost: 598, av: "R", hands: "one",
      qualities: ["bleeding"],
      qualityValues: { bleeding: "75" },
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>An Ofieri sabre with a deep, scything curve. <strong>Bleed 75%</strong>.</p>" },
    { name: "Pata", wa: 2, dmg: "3d6+4", dmgType: "P/S", range: "BODY×1", rel: 15, en: 1, conceal: "N/A", wt: 1.4, cost: 608, av: "R", hands: "one",
      qualities: ["superiorGuard", "balanced"],
      qualityValues: {},
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>A Zerrikan gauntlet-sword with full hand protection. <strong>Superior Guard, Balanced</strong>.</p>" },
    { name: "Kurra", wa: 0, dmg: "5d6+2", dmgType: "P/S", range: "BODY×1", rel: 10, en: 1, conceal: "N/A", wt: 1.5, cost: 986, av: "R", hands: "one",
      qualities: ["bleeding", "ablating"],
      qualityValues: { bleeding: "50" },
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>A heavy Ofieri war-blade with an extreme cutting curve. <strong>Bleed 50%, Ablating</strong>.</p>" },
    { name: "Aršti", wa: 1, dmg: "3d6", dmgType: "P", range: "BODY×2", rel: 10, en: 1, conceal: "N/A", wt: 1.2, cost: 319, av: "R", hands: "one",
      qualities: ["longReach", "balanced", "footCharging"],
      qualityValues: { footCharging: "+1d6" },
      category: "staffSpear", skill: "staffSpear",
      description: "<p>A nimble Ofieri spear. <strong>Long Reach, Balanced</strong>; <strong>Charging</strong>: +1d6.</p>" },
    { name: "Tzad", wa: 0, dmg: "3d6", dmgType: "P", range: "BODY×2", rel: 10, en: 0, conceal: "N/A", wt: 1.8, cost: 331, av: "R", hands: "one",
      qualities: ["longReach", "cavalry", "footCharging", "twoHand"],
      qualityValues: { footCharging: "+3d6", twoHand: "+3 Dmg, Grappling" },
      category: "staffSpear", skill: "staffSpear",
      description: "<p>An Ofieri cavalry lance. <strong>Long Reach, Cavalry</strong>; <strong>Charging</strong>: +3d6; <strong>Two-Hand</strong>: +3 Dmg, Grappling.</p>" },
    { name: "Ofieri Staff", wa: 0, dmg: "3d6", dmgType: "B", range: "N/A", rel: 15, en: 2, conceal: "N/A", wt: 1.6, cost: 2585, av: "R", hands: "one",
      qualities: ["longReach", "focus", "twoHand"],
      qualityValues: { focus: "3", twoHand: "+1 WA" },
      category: "staffSpear", skill: "staffSpear",
      description: "<p>An elemental Ofieri mage-staff that can channel fire, water, air, or earth. <strong>Long Reach, Focus (3)</strong>; <strong>Two-Hand</strong>: +1 WA.</p>" },
    { name: "Kontosa", wa: 1, dmg: "4d6", dmgType: "P", range: "N/A", rel: 8, en: 1, conceal: "N/A", wt: 2.2, cost: 527, av: "R", hands: "two",
      qualities: ["superiorReach", "cavalry", "footCharging"],
      qualityValues: { footCharging: "+3d6" },
      category: "staffSpear", skill: "staffSpear",
      description: "<p>A long Zerrikan cavalry lance. <strong>Superior Reach, Cavalry</strong>; <strong>Charging</strong>: +3d6.</p>" },

    /* ── Elderfolk Armory — Hand Weapons (EO p.26-27) ───────────── */
    /* Note: PDF table omits availability column; all entries are Rare. */
    { name: "Elven Seax", wa: 0, dmg: "2d6+4", dmgType: "P/S", range: "BODY×3", rel: 10, en: 2, conceal: "T", wt: 0.3, cost: 266, av: "R", hands: "one", quick: true,
      qualities: ["feeble", "nimble", "bleeding", "closeQuarters", "throwing"],
      qualityValues: { bleeding: "75", closeQuarters: "+3 WA, +1d6 Dmg" },
      category: "smallBlades", skill: "smallBlades",
      description: "<p>An exquisite elven utility dagger. <strong>Feeble, Nimble, Bleed 75%</strong>; <strong>Close Quarters</strong>: +3 WA, +1d6 Dmg.</p>" },
    { name: "Dwarven Cleaver", wa: 2, dmg: "3d6", dmgType: "S", range: "BODY×2", rel: 15, en: 1, conceal: "S", wt: 0.8, cost: 491, av: "R", hands: "one", quick: true,
      qualities: ["nimble", "bleeding", "meteorite", "closeQuarters", "throwing"],
      qualityValues: { bleeding: "50", closeQuarters: "+1d6 Dmg" },
      category: "smallBlades", skill: "smallBlades",
      description: "<p>A meteorite-edged dwarven utility cleaver. <strong>Nimble, Bleed 50%, Meteorite</strong>; <strong>Close Quarters</strong>: +1d6 Dmg.</p>" },
    { name: "Cheval Dagger", wa: 1, dmg: "1d6", dmgType: "P", range: "BODY×2", rel: 10, en: 1, conceal: "S", wt: 0.5, cost: 552, av: "R", hands: "one", quick: true,
      qualities: ["nimble", "bleeding", "improvedArmorPiercing", "closeQuarters", "throwing"],
      qualityValues: { bleeding: "25", closeQuarters: "+2 WA, +2d6 Dmg" },
      category: "smallBlades", skill: "smallBlades",
      description: "<p>A knight's mail-piercing elven dagger. <strong>Nimble, Bleed 25%, Improved Armor Piercing</strong>; <strong>Close Quarters</strong>: +2 WA, +2d6 Dmg.</p>" },
    { name: "Elven Messer", wa: 2, dmg: "3d6+4", dmgType: "P/S", range: "BODY×1", rel: 15, en: 2, conceal: "L", wt: 1, cost: 621, av: "R", hands: "one",
      qualities: ["superiorGuard", "balanced", "bleeding"],
      qualityValues: { bleeding: "50" },
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>A long-knife styled elven blade with extended hilt. <strong>Superior Guard, Balanced, Bleed 50%</strong>.</p>" },
    { name: "Vrihedd Sabre", wa: 2, dmg: "4d6+4", dmgType: "P/S", range: "BODY×1", rel: 15, en: 1, conceal: "N/A", wt: 1.3, cost: 843, av: "R", hands: "one",
      qualities: ["superiorGuard", "cavalry", "bleeding"],
      qualityValues: { bleeding: "50" },
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>The Vrihedd brigade's elven cavalry sabre. <strong>Superior Guard, Cavalry, Bleed 50%</strong>.</p>" },
    { name: "Gnomish Gwyhyr", wa: 3, dmg: "4d6", dmgType: "P/S", range: "BODY×1", rel: 10, en: 2, conceal: "N/A", wt: 0.7, cost: 1245, av: "R", hands: "one",
      qualities: ["guard", "balanced", "bleeding", "twoHand"],
      qualityValues: { bleeding: "75", twoHand: "+1 WA, +2 Dmg" },
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>A masterwork gnomish sword, exceptional in every way. <strong>Guard, Balanced, Bleed 75%</strong>; <strong>Two-Hand</strong>: +1 WA, +2 Dmg.</p>" },
    { name: "Cheval Sword", wa: 2, dmg: "5d6", dmgType: "P/S", range: "BODY×1", rel: 20, en: 1, conceal: "L", wt: 1.6, cost: 1322, av: "R", hands: "two",
      qualities: ["superiorGuard", "balanced", "closeQuarters"],
      qualityValues: { closeQuarters: "Improved Armor Piercing" },
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>A two-handed elven longsword. <strong>Superior Guard, Balanced</strong>; <strong>Close Quarters</strong>: Improved Armor Piercing.</p>" },
    { name: "Tir Tochair Blade", wa: 3, dmg: "5d6+3", dmgType: "P/S", range: "BODY×1", rel: 15, en: 2, conceal: "N/A", wt: 1.1, cost: 1466, av: "R", hands: "two",
      qualities: ["guard", "sturdy", "balanced", "bleeding"],
      qualityValues: { bleeding: "75" },
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>A masterwork Tir Tochair greatsword. <strong>Guard, Sturdy, Balanced, Bleed 75%</strong>.</p>" },
    { name: "Meteorite Flail", wa: 0, dmg: "6d6+4", dmgType: "B", range: "BODY×1", rel: 20, en: 1, conceal: "S", wt: 1, cost: 926, av: "R", hands: "one",
      qualities: ["hefty", "indirect", "grappling", "armorPiercing", "ablating", "meteorite"],
      qualityValues: {},
      category: "melee", skill: "melee",
      description: "<p>A meteorite-headed flail. <strong>Hefty, Indirect, Grappling, Armor Piercing, Ablating, Meteorite</strong>.</p>" },
    { name: "Dwarven Axe", wa: 1, dmg: "6d6+2", dmgType: "S", range: "BODY×2", rel: 20, en: 1, conceal: "L", wt: 1, cost: 969, av: "R", hands: "one",
      qualities: ["armorPiercing", "ablating", "bleeding", "meteorite"],
      qualityValues: { bleeding: "25" },
      category: "melee", skill: "melee",
      description: "<p>A meteorite-bladed dwarven axe. <strong>Armor Piercing, Ablating, Bleed 25%, Meteorite</strong>.</p>" },
    { name: "Cheval Pollax", wa: -1, dmg: "7d6", dmgType: "P/S/B", range: "N/A", rel: 15, en: 1, conceal: "N/A", wt: 4, cost: 1339, av: "R", hands: "two",
      qualities: ["hefty", "sturdy", "ablating", "improvedArmorPiercing"],
      qualityValues: {},
      category: "melee", skill: "melee",
      description: "<p>A two-handed knight's pole-axe of elven make. <strong>Hefty, Sturdy, Ablating, Improved Armor Piercing</strong>.</p>" },
    { name: "Dwarven Martel", wa: 1, dmg: "7d6+3", dmgType: "P/B", range: "N/A", rel: 15, en: 2, conceal: "N/A", wt: 1.6, cost: 1369, av: "R", hands: "two",
      qualities: ["hefty", "sturdy", "armorPiercing", "ablating", "meteorite"],
      qualityValues: {},
      category: "melee", skill: "melee",
      description: "<p>A meteorite-headed dwarven war hammer. <strong>Hefty, Sturdy, Armor Piercing, Ablating, Meteorite</strong>.</p>" },
    { name: "Gnomish Bardak", wa: 1, dmg: "7d6+3", dmgType: "S/B", range: "N/A", rel: 15, en: 2, conceal: "N/A", wt: 1.5, cost: 1379, av: "R", hands: "two",
      qualities: ["hefty", "sturdy", "armorPiercing", "bleeding", "stun"],
      qualityValues: { bleeding: "50", stun: "0" }, // uncertain: PDF gives separate slash/bludgeon riders, not a stun modifier number
      category: "melee", skill: "melee",
      description: "<p>A gnomish dual-mode war-axe. <strong>Hefty, Sturdy, Armor Piercing</strong>; <strong>Slashing</strong>: Bleed 50%; <strong>Bludgeoning</strong>: Stun.</p>" },
    { name: "Dwarven Spear", wa: 1, dmg: "5d6+4", dmgType: "P", range: "BODY×2", rel: 15, en: 1, conceal: "N/A", wt: 1.5, cost: 973, av: "R", hands: "one",
      qualities: ["longReach", "meteorite", "footCharging", "twoHand"],
      qualityValues: { footCharging: "+1d6", twoHand: "+1 WA, +1d6 Dmg, Guard, Sturdy" },
      category: "staffSpear", skill: "staffSpear",
      description: "<p>A meteorite-tipped dwarven spear. <strong>Long Reach, Meteorite</strong>; <strong>Charging</strong>: +1d6; <strong>Two-Hand</strong>: +1 WA, +1d6 Dmg, Guard, Sturdy.</p>" },
    { name: "Gnomish Staff", wa: 1, dmg: "3d6", dmgType: "B", range: "N/A", rel: 15, en: 2, conceal: "N/A", wt: 1.4, cost: 2148, av: "R", hands: "two",
      qualities: ["longReach", "focus", "meteorite"],
      qualityValues: { focus: "3" },
      category: "staffSpear", skill: "staffSpear",
      description: "<p>A meteorite-bound gnomish mage-staff. <strong>Long Reach, Focus (3), Meteorite</strong>.</p>" },
    { name: "Elven Walking Stick", wa: 1, dmg: "2d6+3", dmgType: "B", range: "N/A", rel: 10, en: 2, conceal: "N/A", wt: 1.2, cost: 2697, av: "R", hands: "two",
      qualities: ["longReach", "focus", "greaterFocus", "twoHand"],
      qualityValues: { focus: "3", twoHand: "+1d6 Dmg" },
      category: "staffSpear", skill: "staffSpear",
      description: "<p>An exquisitely crafted elven mage-staff disguised as a walking stick. <strong>Long Reach, Focus (3), Greater Focus</strong>; <strong>Two-Hand</strong>: +1d6 Dmg.</p>" },
    { name: "Elven Glaive", wa: 2, dmg: "6d6+2", dmgType: "P/S", range: "BODY×1", rel: 10, en: 2, conceal: "N/A", wt: 2.2, cost: 870, av: "R", hands: "two",
      qualities: ["longReach", "sturdy", "balanced", "bleeding"],
      qualityValues: { bleeding: "75" },
      category: "staffSpear", skill: "staffSpear",
      description: "<p>An elegant elven polearm. <strong>Long Reach, Sturdy, Balanced, Bleed 75%</strong>.</p>" },
    { name: "Cheval Halfpike", wa: 1, dmg: "5d6+2", dmgType: "P", range: "BODY×2", rel: 10, en: 1, conceal: "N/A", wt: 2, cost: 1037, av: "R", hands: "two",
      qualities: ["longReach", "sturdy", "improvedArmorPiercing", "footCharging"],
      qualityValues: { footCharging: "+1d6" },
      category: "staffSpear", skill: "staffSpear",
      description: "<p>A short cavalry pike of fine elven make. <strong>Long Reach, Sturdy, Improved Armor Piercing</strong>; <strong>Charging</strong>: +1d6.</p>" },
    { name: "Cheval Lance", wa: -1, dmg: "2d6+4", dmgType: "P", range: "N/A", rel: 15, en: 1, conceal: "N/A", wt: 4, cost: 1053, av: "R", hands: "two",
      qualities: ["superiorReach", "hefty", "cavalry", "armorPiercing", "physique", "footCharging"],
      qualityValues: { physique: "16", footCharging: "+6d6" },
      category: "staffSpear", skill: "staffSpear",
      description: "<p>A heavy elven war-lance. <strong>Superior Reach, Hefty, Cavalry, Armor Piercing, Physique (16)</strong>; <strong>Charging</strong>: +6d6.</p>" },

    /* ── Elderfolk Silver Weapons (EO p.27) ────────────────────── */
    { name: "Elven Moonblade", wa: 2, dmg: "1d6", dmgType: "P/S", range: "BODY×1", rel: 8, en: 2, conceal: "L", wt: 1.1, cost: 857, av: "R", hands: "one",
      qualities: ["balanced", "silver"],
      qualityValues: { silver: "+3d6" },
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>An elegant silver-coated elven sabre. <strong>Balanced, Silver +3d6</strong>.</p>" },
    { name: "Silver Hatchet", wa: 0, dmg: "2d6", dmgType: "S", range: "BODY×2", rel: 4, en: 1, conceal: "L", wt: 1, cost: 681, av: "R", hands: "one",
      qualities: ["ablating", "armorPiercing", "silver"],
      qualityValues: { silver: "+3d6" },
      category: "melee", skill: "melee",
      description: "<p>A well-crafted silver fighting hatchet. <strong>Ablating, Armor Piercing, Silver +3d6</strong>.</p>" },
    { name: "Golem Smasher", wa: -1, dmg: "3d6+4", dmgType: "B", range: "N/A", rel: 6, en: 1, conceal: "N/A", wt: 3, cost: 1050, av: "R", hands: "two",
      qualities: ["hefty", "sturdy", "ablating", "stun", "silver"],
      qualityValues: { stun: "-1", silver: "+3d6" },
      category: "melee", skill: "melee",
      description: "<p>A two-handed silver-headed maul. <strong>Hefty, Sturdy, Ablating, Stun (-1), Silver +3d6</strong>.</p>" },
    { name: "Monster Hunter's Pike", wa: 0, dmg: "1d6", dmgType: "P", range: "BODY×2", rel: 10, en: 1, conceal: "N/A", wt: 3.2, cost: 1016, av: "R", hands: "two",
      qualities: ["superiorReach", "superiorGuard", "sturdy", "silver", "footCharging"],
      qualityValues: { silver: "+3d6", footCharging: "+1d6" },
      category: "staffSpear", skill: "staffSpear",
      description: "<p>A crosspiece-tipped silver pike for keeping impaled beasts at bay. <strong>Superior Reach, Superior Guard, Sturdy, Silver +3d6</strong>; <strong>Charging</strong>: +1d6.</p>" },

    /* ── Witcher Kit (EO p.29) ─────────────────────────────────── */
    { name: "Silver Knife", wa: 0, dmg: "1d6+1", dmgType: "P/S", range: "BODY×3", rel: 2, en: 0, conceal: "T", wt: 0.2, cost: 160, av: "R", hands: "one", quick: true, // uncertain: PDF lists "+1 P/S" (bonus dmg); price taken from crafting diagram (160)
      qualities: ["feeble", "nimble", "silver", "foraging", "closeQuarters", "throwing"],
      qualityValues: { silver: "+3d6", foraging: "monster carcasses", closeQuarters: "+2 WA" },
      category: "smallBlades", skill: "smallBlades",
      description: "<p>A witcher's silver utility knife — useful for carving monster corpses and discouraging hungry beasts. <strong>Feeble, Nimble, Silver +3d6, Forage (monster carcasses)</strong>; <strong>Close Quarters</strong>: +2 WA.</p>" },
];

/* ── RANGED WEAPONS (EO p.12-13) ──────────────────────────────── */
const RANGED = [
    /* Athletics (throwing) — already covered above (Javelin, Throwing Knife etc.) */
    { name: "Dart", wa: 1, dmg: "3d6", dmgType: "P", range: "BODY×6", rel: 2, en: 0, conceal: "L", wt: 0.2, cost: 48, av: "C", hands: "one", quick: true,
      qualities: ["feeble", "armorPiercing", "throwing"],
      category: "thrown", skill: "athletics",
      description: "<p>Sharp throwing dart. <strong>Feeble, Armor Piercing</strong>.</p>" },
    { name: "Weighted Net", wa: 0, dmg: "0", dmgType: "B", range: "4m", rel: 5, en: 0, conceal: "L", wt: 4, cost: 175, av: "E", hands: "two",
      qualities: ["grappling", "entangling"],
      category: "thrown", skill: "athletics",
      description: "<p>Weighted entangling net. <strong>Grappling, Entangling</strong>. No damage.</p>" },
    /* Sling */
    { name: "Sling", wa: -1, dmg: "3d6", dmgType: "B", range: "100m", rel: 1, en: 0, conceal: "T", wt: 0.1, cost: 76, av: "E", hands: "one",
      qualities: ["feeble", "concealment", "freeAmmunition"],
      category: "sling", skill: "athletics",
      description: "<p>Simple shepherd's sling. <strong>Feeble, Concealment, Free Ammunition</strong>.</p>" },
    { name: "Staff-Sling", wa: -2, dmg: "3d6", dmgType: "B", range: "200m", rel: 4, en: 0, conceal: "N/A", wt: 1.2, cost: 167, av: "C", hands: "two",
      qualities: ["freeAmmunition"],
      category: "sling", skill: "athletics",
      description: "<p>Staff-sling. <strong>Free Ammunition</strong>. Can use Staff/Spear in close combat (1d6+2 B/N).</p>" },
    /* Bows */
    { name: "Shortbow", wa: 0, dmg: "3d6+1", dmgType: "P", range: "150m", rel: 4, en: 1, conceal: "N/A", wt: 0.5, cost: 200, av: "C", hands: "two",
      category: "bow", skill: "archery",
      description: "<p>Compact recurve shortbow.</p>" },
    { name: "Hunting Bow", wa: 0, dmg: "3d6+2", dmgType: "P", range: "200m", rel: 8, en: 1, conceal: "N/A", wt: 0.8, cost: 280, av: "C", hands: "two",
      category: "bow", skill: "archery",
      description: "<p>Hunter's medium bow.</p>" },
    { name: "Longbow", wa: 0, dmg: "4d6", dmgType: "P", range: "350m", rel: 10, en: 1, conceal: "N/A", wt: 1.5, cost: 460, av: "P", hands: "two",
      qualities: ["physique"], qualityValues: { physique: "12" },
      category: "bow", skill: "archery",
      description: "<p>Heavy longbow. <strong>Physique (12)</strong>.</p>" },
    /* Crossbows */
    { name: "Crossbow Pistol", wa: 1, dmg: "2d6+2", dmgType: "P", range: "50m", rel: 5, en: 0, conceal: "S", wt: 1, cost: 250, av: "C", hands: "one",
      qualities: ["concealment"],
      category: "crossbow", skill: "crossbow",
      description: "<p>One-handed crossbow pistol. <strong>Concealment</strong>.</p>" },
    { name: "Crossbow", wa: 1, dmg: "3d6+2", dmgType: "P", range: "200m", rel: 10, en: 1, conceal: "N/A", wt: 3, cost: 350, av: "C", hands: "two",
      category: "crossbow", skill: "crossbow",
      description: "<p>Standard crossbow.</p>" },
    { name: "Heavy Crossbow", wa: 0, dmg: "4d6+2", dmgType: "P", range: "250m", rel: 10, en: 1, conceal: "N/A", wt: 5, cost: 500, av: "P", hands: "two",
      qualities: ["armorPiercing"],
      category: "crossbow", skill: "crossbow",
      description: "<p>Heavy military crossbow. <strong>Armor Piercing</strong>.</p>" },

    /* ── Quality Northern Ranged (EO p.17) ──────────────────────── */
    { name: "Bone Bow", wa: 1, dmg: "3d6", dmgType: "P", range: "100m", rel: 2, en: 0, conceal: "L", wt: 0.5, cost: 299, av: "P", hands: "two",
      qualities: ["feeble"],
      category: "bow", skill: "archery",
      description: "<p>Skellige bone-and-sinew bow. <strong>Feeble</strong>.</p>" },
    { name: "Verden Longbow", wa: 1, dmg: "4d6+2", dmgType: "P", range: "200m", rel: 4, en: 1, conceal: "N/A", wt: 1, cost: 432, av: "R", hands: "two",
      qualities: ["physique", "grounded"], qualityValues: { physique: "12" },
      category: "bow", skill: "archery",
      description: "<p>Verden master-archer's longbow. <strong>Physique (12), Grounded</strong>.</p>" },
    { name: "Koviri Crossbow", wa: 2, dmg: "4d6", dmgType: "P", range: "50m", rel: 1, en: 1, conceal: "L", wt: 1, cost: 341, av: "P", hands: "one",
      qualities: ["feeble", "stableAim", "slowReload"], qualityValues: { slowReload: "1" },
      category: "crossbow", skill: "crossbow",
      description: "<p>Koviri precision crossbow. <strong>Feeble, Stable Aim, Slow Reload (1)</strong>.</p>" },
    { name: "Tretagor Arbalest", wa: 2, dmg: "8d6", dmgType: "P", range: "150m", rel: 5, en: 1, conceal: "N/A", wt: 4, cost: 1337, av: "P", hands: "two",
      qualities: ["stableAim", "slowReload", "grounded"], qualityValues: { slowReload: "4" },
      category: "crossbow", skill: "crossbow",
      description: "<p>Heavy Tretagor arbalest. <strong>Stable Aim, Slow Reload (4), Grounded</strong>.</p>" },

    /* ── Fine Southern Ranged (EO p.21) ─────────────────────────── */
    { name: "Orion", wa: 2, dmg: "1d6", dmgType: "S", range: "BODY×4", rel: 1, en: 0, conceal: "T", wt: 0.1, cost: 46, av: "P", hands: "one", quick: true,
      qualities: ["feeble", "nimble", "concealment", "throwing"],
      category: "thrown", skill: "athletics",
      description: "<p>Star-shaped throwing blade. <strong>Feeble, Nimble, Concealment</strong>. Action to throw a handful (up to half Sleight of Hand) at -1 per extra; hits = margin of success.</p>" },
    { name: "Markee Bow", wa: 1, dmg: "3d6+2", dmgType: "P", range: "150m", rel: 2, en: 1, conceal: "L", wt: 0.5, cost: 431, av: "R", hands: "two",
      qualities: ["feeble", "balanced", "nimble"],
      category: "bow", skill: "archery",
      description: "<p>Mettinese precision bow. <strong>Feeble, Balanced, Nimble</strong>.</p>" },
    { name: "Black Infantry Bow", wa: 0, dmg: "5d6+3", dmgType: "P", range: "250m", rel: 6, en: 1, conceal: "N/A", wt: 1.5, cost: 691, av: "P", hands: "two",
      qualities: ["physique", "grounded"], qualityValues: { physique: "15" },
      category: "bow", skill: "archery",
      description: "<p>Nilfgaardian heavy infantry longbow. <strong>Physique (15), Grounded</strong>.</p>" },
    { name: "Nilfgaardian Crossbow", wa: 2, dmg: "2d6+3", dmgType: "P", range: "30m", rel: 1, en: 1, conceal: "S", wt: 0.3, cost: 342, av: "R", hands: "one",
      qualities: ["feeble", "nimble", "stableAim", "concealment"],
      category: "crossbow", skill: "crossbow",
      description: "<p>Nilfgaardian hand crossbow. <strong>Feeble, Nimble, Stable Aim, Concealment</strong>. Hand-spanned (no Slow Reload); can't make Strong Strikes.</p>" },

    /* ── Exotic Imports — Ranged (EO p.24) ──────────────────────── */
    { name: "Chakram", wa: 0, dmg: "3d6+4", dmgType: "S", range: "BODY×4", rel: 5, en: 1, conceal: "L", wt: 0.5, cost: 175, av: "R", hands: "one",
      qualities: ["guard", "balanced", "bleeding"], qualityValues: { bleeding: "50" },
      category: "thrown", skill: "athletics",
      description: "<p>Indian throwing-disc. <strong>Guard, Balanced, Bleed 50%</strong>. Can be used in melee at -1 with Melee skill (loses Bleed/Balanced/AP).</p>" },
    { name: "Jarid", wa: 1, dmg: "3d6+2", dmgType: "P", range: "BODY×6", rel: 3, en: 0, conceal: "S", wt: 0.7, cost: 186, av: "R", hands: "one", quick: true,
      qualities: ["feeble", "balanced", "armorPiercing", "throwing"],
      category: "thrown", skill: "athletics",
      description: "<p>Light throwing javelin. <strong>Feeble, Balanced, Armor Piercing</strong>.</p>" },
    { name: "Kaman", wa: 1, dmg: "4d6+2", dmgType: "P", range: "200m", rel: 2, en: 2, conceal: "L", wt: 1, cost: 733, av: "R", hands: "two",
      qualities: ["feeble", "balanced", "nimble"],
      category: "bow", skill: "archery",
      description: "<p>Ofieri recurve bow. <strong>Feeble, Balanced, Nimble</strong>.</p>" },
    { name: "Mori Num", wa: 0, dmg: "6d6", dmgType: "P", range: "250m", rel: 2, en: 1, conceal: "L", wt: 1.5, cost: 1102, av: "R", hands: "two",
      qualities: ["balanced", "physique"], qualityValues: { physique: "12" },
      category: "bow", skill: "archery",
      description: "<p>Zerrikanian war bow. <strong>Balanced, Physique (12)</strong>.</p>" },
    { name: "Zerrikanian Zefhar", wa: 2, dmg: "5d6", dmgType: "P", range: "200m", rel: 2, en: 2, conceal: "L", wt: 1.5, cost: 1302, av: "R", hands: "two",
      qualities: ["feeble", "balanced", "nimble"],
      category: "bow", skill: "archery",
      description: "<p>Master-crafted Zerrikanian bow. <strong>Feeble, Balanced, Nimble</strong>.</p>" },
    { name: "Höl Num", wa: 0, dmg: "7d6", dmgType: "P", range: "300m", rel: 8, en: 1, conceal: "N/A", wt: 2.5, cost: 1584, av: "R", hands: "two",
      qualities: ["physique", "grounded"], qualityValues: { physique: "15" },
      category: "bow", skill: "archery",
      description: "<p>Heavy Zerrikanian foot bow. <strong>Physique (15), Grounded</strong>.</p>" },

    /* ── ADDED v2 — missing PDF content (auto-spliced) ──────────── */
    /* ── Basic Ranged that was missing (EO p.12) ──────────────────── */
    { name: "War Bow", wa: 0, dmg: "5d6", dmgType: "P", range: "200m", rel: 6, en: 1, conceal: "N/A", wt: 1.5, cost: 557, av: "P",
      hands: "two", quick: false, ammoType: "arrow",
      qualities: ["physique", "grounded"], qualityValues: { physique: "14" },
      category: "bow", skill: "archery",
      description: "<p>Heavy military longbow used by professional foot archers in Aedirn, Verden, Cintra, Nazair, Ebbing, Vicovaro and Etolia. <strong>Physique (14), Grounded</strong>.</p>" },

    { name: "Strongman's Bow", wa: 0, dmg: "6d6", dmgType: "P", range: "250m", rel: 8, en: 1, conceal: "N/A", wt: 2, cost: 856, av: "R",
      hands: "two", quick: false, ammoType: "arrow",
      qualities: ["physique", "grounded"], qualityValues: { physique: "18" },
      category: "bow", skill: "archery",
      description: "<p>Heaviest war bow, built in royal workshops for the strongest archers. Can drive arrows through steel breastplates in ideal conditions. <strong>Physique (18), Grounded</strong>.</p>" },

    { name: "Gabrielle", wa: 1, dmg: "3d6", dmgType: "P", range: "50m", rel: 1, en: 1, conceal: "S", wt: 0.5, cost: 242, av: "C",
      hands: "one", quick: false, ammoType: "bolt",
      qualities: ["feeble", "stableAim", "slowReload", "nimble"], qualityValues: { slowReload: "1" },
      category: "crossbow", skill: "crossbow",
      description: "<p>Small hand-spanned crossbow concealable under a travel coat. <strong>Feeble, Stable Aim, Slow Reload (1), Nimble</strong>.</p>" },

    { name: "Huntsman's Crossbow", wa: 2, dmg: "5d6", dmgType: "P", range: "100m", rel: 2, en: 1, conceal: "N/A", wt: 2.5, cost: 522, av: "C",
      hands: "two", quick: false, ammoType: "bolt",
      qualities: ["stableAim", "slowReload"], qualityValues: { slowReload: "2" },
      category: "crossbow", skill: "crossbow",
      description: "<p>Light hunting crossbow with a long power stroke for accurate big-game shots. <strong>Stable Aim, Slow Reload (2)</strong>.</p>" },

    { name: "Soldier's Crossbow", wa: 1, dmg: "6d6", dmgType: "P", range: "100m", rel: 4, en: 1, conceal: "N/A", wt: 3, cost: 820, av: "P",
      hands: "two", quick: false, ammoType: "bolt",
      qualities: ["stableAim", "slowReload", "grounded"], qualityValues: { slowReload: "3" },
      category: "crossbow", skill: "crossbow",
      description: "<p>Standard military crossbow with steel prods, spanned by lever or belt hook. <strong>Stable Aim, Slow Reload (3), Grounded</strong>.</p>" },

    { name: "Arbalest", wa: 1, dmg: "8d6", dmgType: "P", range: "150m", rel: 6, en: 1, conceal: "N/A", wt: 3.5, cost: 1163, av: "P",
      hands: "two", quick: false, ammoType: "bolt",
      qualities: ["stableAim", "slowReload", "grounded"], qualityValues: { slowReload: "5" },
      category: "crossbow", skill: "crossbow",
      description: "<p>Heavy Temerian/Aedirnian arbalest spanned by winch or windlass. <strong>Stable Aim, Slow Reload (5), Grounded</strong>.</p>" },

    { name: "Monster Hunter's Crossbow", wa: 1, dmg: "10d6", dmgType: "P", range: "200m", rel: 8, en: 1, conceal: "N/A", wt: 4, cost: 1498, av: "R",
      hands: "two", quick: false, ammoType: "bolt",
      qualities: ["stableAim", "slowReload", "grounded"], qualityValues: { slowReload: "7" },
      category: "crossbow", skill: "crossbow",
      description: "<p>Massive crossbow halfway between an arbalest and a light ballista, favored by outfits like the Crinfrid Reavers. <strong>Stable Aim, Slow Reload (7), Grounded</strong>.</p>" },

    /* ── Elderfolk Ranged (EO p.27) ───────────────────────────────── */
    { name: "Werebubb Harpoon", wa: 1, dmg: "2d6+4", dmgType: "P", range: "10m", rel: 4, en: 0, conceal: "L", wt: 0.5, cost: 224, av: "R",
      hands: "one", quick: false, ammoType: "thrown",
      qualities: ["bleeding", "poison", "grappling"], qualityValues: { bleeding: "100", poison: "100" },
      category: "thrown", skill: "athletics",
      description: "<p>Barbed werebubb harpoon attached to a tough line; hooks the target on hit and grapples them. <strong>Bleed 100%, Poison 100%, Grappling</strong>. DC:14 First Aid to remove if it dealt damage; DC:14 Crafting otherwise. The line can be cut with a DC:17 slashing attack.</p>" },

    { name: "Halfling Weighted Dart", wa: 1, dmg: "3d6", dmgType: "P", range: "30m", rel: 2, en: 0, conceal: "S", wt: 0.5, cost: 284, av: "R",
      hands: "one", quick: true, ammoType: "thrown",
      qualities: ["improvedArmorPiercing"],
      category: "thrown", skill: "athletics",
      description: "<p>Expertly crafted weighted dart prized in halfling families. <strong>Improved Armor Piercing</strong>.</p>" },

    { name: "Monster Catcher's Net", wa: 0, dmg: "0", dmgType: "B", range: "4m", rel: 5, en: 0, conceal: "L", wt: 4, cost: 653, av: "R",
      hands: "two", quick: false, ammoType: "thrown",
      qualities: ["entangling", "magicalAnchoring"], // uncertain: "Magically Anchoring" is EO-specific; canonical quality key guessed
      category: "thrown", skill: "athletics",
      description: "<p>Alchemically treated net mimicking silver, meteorite and dimeritium — disables the magical abilities of any monster entangled by it. <strong>Entangling, Magically Anchoring</strong>. No damage.</p>" },

    { name: "Elven Travel Zefhar", wa: 2, dmg: "4d6", dmgType: "P", range: "200m", rel: 2, en: 2, conceal: "L", wt: 1.2, cost: 833, av: "R",
      hands: "two", quick: false, ammoType: "arrow",
      qualities: ["feeble", "balanced", "nimble"],
      category: "bow", skill: "archery",
      description: "<p>Four-armed elven bow named for a rune in its shape; smooth draw imparts great energy without high strength. <strong>Feeble, Balanced, Nimble</strong>.</p>" },

    { name: "Brokilon Bow", wa: 3, dmg: "3d6", dmgType: "P", range: "200m", rel: 4, en: 3, conceal: "L", wt: 1, cost: 1142, av: "R",
      hands: "two", quick: false, ammoType: "arrow",
      qualities: ["balanced", "nimble"],
      category: "bow", skill: "archery",
      description: "<p>Bow of the dryads of Brokilon, crafted from alchemically treated ancient timber. Incredibly accurate but limited by its light draw. <strong>Balanced, Nimble</strong>.</p>" },

    { name: "Elven War Zefhar", wa: 2, dmg: "6d6", dmgType: "P", range: "350m", rel: 6, en: 2, conceal: "N/A", wt: 2.2, cost: 1180, av: "R",
      hands: "two", quick: false, ammoType: "arrow",
      qualities: ["balanced", "physique", "grounded"], qualityValues: { physique: "14" },
      category: "bow", skill: "archery",
      description: "<p>Heavy zefhar of the ancient elven warriors — powerful, smooth, and accurate. <strong>Balanced, Physique (14), Grounded</strong>.</p>" },

    { name: "Gnomish Crossbow", wa: 4, dmg: "3d6", dmgType: "P", range: "100m", rel: 1, en: 1, conceal: "S", wt: 1, cost: 527, av: "R",
      hands: "one", quick: false, ammoType: "bolt",
      qualities: ["feeble", "nimble", "stableAim", "slowReload"], qualityValues: { slowReload: "1" },
      category: "crossbow", skill: "crossbow",
      description: "<p>Ornate gnomish hand crossbow with finely fitted trigger and long power stroke. <strong>Feeble, Nimble, Stable Aim, Slow Reload (1)</strong>.</p>" },

    { name: "Dwarven Crossbow", wa: 3, dmg: "6d6", dmgType: "P", range: "300m", rel: 8, en: 1, conceal: "N/A", wt: 3, cost: 1313, av: "R",
      hands: "two", quick: false, ammoType: "bolt",
      qualities: ["stableAim", "slowReload", "grounded"], qualityValues: { slowReload: "2" },
      category: "crossbow", skill: "crossbow",
      description: "<p>Mahakaman masterpiece — the power of a heavy arbalest with the spanning weight of a hunting crossbow. <strong>Stable Aim, Slow Reload (2), Grounded</strong>.</p>" },

    /* ── Artillery (EO p.35) ──────────────────────────────────────── */
    { name: "Scorpio", wa: 0, dmg: "12d6", dmgType: "P", range: "300m", rel: 8, en: 0, conceal: "N/A", wt: 40, cost: 2610, av: "R",
      hands: "two", quick: false, ammoType: "ballista",
      qualities: ["slowReload", "crewReload", "mounted"],
      qualityValues: { slowReload: "8", crewReload: "2" },
      category: "crossbow", skill: "crossbow",
      description: "<p>Light anti-personnel Nilfgaardian siege crossbow that can be dismounted/re-mounted as a Full Turn. Uses Crossbows skill. Cannot make Fast or Strong Strikes. <strong>Slow Reload (8), Crew ×2, Artillery (1)</strong>.</p>" },

    { name: "Siege Scorpion", wa: -3, dmg: "8d10", dmgType: "P", range: "600m", rel: 12, en: 0, conceal: "N/A", wt: 200, cost: 13200, av: "R",
      hands: "two", quick: false, ammoType: "ballista",
      qualities: ["slowReload", "crewReload", "mounted"],
      qualityValues: { slowReload: "15", crewReload: "3" },
      category: "crossbow", skill: "crossbow",
      description: "<p>The largest crossbow in the world — Nilfgaardian dark-steel-prodded siege engine. Disassembles into four 50kg components (DC:12 Crafting; 30 min assembly). Uses Crossbows skill. <strong>Slow Reload (15), Crew ×3, SPD 2, Heavy Artillery (1d6)</strong>.</p>" },

    { name: "Ballista", wa: -2, dmg: "12d6", dmgType: "P", range: "500m", rel: 15, en: 0, conceal: "N/A", wt: 100, cost: 4625, av: "R",
      hands: "two", quick: false, ammoType: "ballista",
      qualities: ["slowReload", "crewReload", "mounted"],
      qualityValues: { slowReload: "24", crewReload: "4" },
      category: "artillery", skill: "artillery",
      description: "<p>Torsion siege engine with bronze-plated arms strung by horsehair. Deconstructs into four 25kg components (5 min). Uses Crafting/Artillery skill. <strong>Slow Reload (24), Crew ×4, SPD 3, Artillery (1d6)</strong>.</p>" },

    { name: "Mangonel", wa: -5, dmg: "10d10", dmgType: "B", range: "300m", rel: 20, en: 0, conceal: "N/A", wt: 1000, cost: 26000, av: "R",
      hands: "two", quick: false, ammoType: "stone",
      qualities: ["slowReload", "crewReload", "mounted"],
      qualityValues: { slowReload: "60", crewReload: "12" },
      category: "artillery", skill: "artillery",
      description: "<p>Traction-powered siege engine — bulky, immobile, devastating. Ten 100kg components; 24 hours assembly (DC:10 Crafting). Uses Crafting/Artillery skill. <strong>Slow Reload (60), Crew ×12, Stationary, Heavy Artillery (1d10)</strong>.</p>" },

    { name: "Trebuchet", wa: -8, dmg: "12d10", dmgType: "B", range: "400m", rel: 30, en: 0, conceal: "N/A", wt: 10000, cost: 52000, av: "R",
      hands: "two", quick: false, ammoType: "stone",
      qualities: ["slowReload", "crewReload", "mounted"],
      qualityValues: { slowReload: "600", crewReload: "60" },
      category: "artillery", skill: "artillery",
      description: "<p>Counterweight trebuchet — the largest and most powerful siege engine known. One hundred 100kg components; 24 days assembly (DC:15 Crafting). Out-ranges hand-held crossbows and war bows. <strong>Slow Reload (600), Crew ×60, Stationary, Heavy Artillery (1d10+2)</strong>.</p>" }
];

/* ── Exotic Hand Weapons (EO p.23-24) — added to main WEAPONS list ── */
WEAPONS.push(
    { name: "Bagh Nakh", wa: 0, dmg: "+1d6", dmgType: "S", range: "N/A", rel: 99, en: 0, conceal: "T", wt: 0.1, cost: 229, av: "R", hands: "one",
      qualities: ["bleeding", "concealment", "closeQuarters"],
      qualityValues: { bleeding: "75", closeQuarters: "+3 WA, +2d6 Dmg" },
      category: "brawling", skill: "brawling",
      description: "<p>Tiger-claw punching weapon. <strong>Brawling (Punch), Bleed 75%, Concealment</strong>; <strong>Close Quarters</strong>: +3 WA, +2d6 Dmg.</p>" },
    { name: "Jambiya", wa: 0, dmg: "1d6", dmgType: "P", range: "BODY×2", rel: 4, en: 1, conceal: "T", wt: 0.3, cost: 494, av: "R", hands: "one", quick: true,
      qualities: ["feeble", "nimble", "bleeding", "balanced", "closeQuarters", "throwing"],
      qualityValues: { bleeding: "100", closeQuarters: "+3 WA, +2d6 Dmg" },
      category: "smallBlades", skill: "smallBlades",
      description: "<p>Curved Ofieri ceremonial dagger. <strong>Feeble, Nimble, Bleed 100%, Balanced</strong>; <strong>Close Quarters</strong>: +3 WA, +2d6 Dmg.</p>" },
    { name: "Katar", wa: 0, dmg: "3d6", dmgType: "P", range: "N/A", rel: 8, en: 1, conceal: "T", wt: 0.6, cost: 501, av: "R", hands: "one",
      qualities: ["feeble", "improvedArmorPiercing", "bleeding"], qualityValues: { bleeding: "25" },
      category: "smallBlades", skill: "smallBlades",
      description: "<p>Punching dagger. <strong>Feeble, Improved Armor Piercing, Bleed 25%</strong>.</p>" },
    { name: "Kris", wa: 1, dmg: "2d6", dmgType: "P", range: "BODY×2", rel: 6, en: 2, conceal: "S", wt: 0.5, cost: 505, av: "R", hands: "one", quick: true,
      qualities: ["nimble", "bleeding", "ablating", "closeQuarters", "throwing"],
      qualityValues: { bleeding: "100", closeQuarters: "+1 WA, +1d6 Dmg" },
      category: "smallBlades", skill: "smallBlades",
      description: "<p>Wavy-bladed Ofieri dagger. <strong>Nimble, Bleed 100%, Ablating</strong>; <strong>Close Quarters</strong>: +1 WA, +1d6 Dmg.</p>" },
    { name: "Szabla", wa: 1, dmg: "3d6+2", dmgType: "S", range: "BODY×1", rel: 10, en: 0, conceal: "L", wt: 1, cost: 287, av: "C", hands: "one",
      qualities: ["cavalry"],
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>Curved cavalry sabre. <strong>Cavalry</strong>.</p>" },
    { name: "Shafra", wa: 2, dmg: "3d6", dmgType: "S", range: "BODY×1", rel: 10, en: 0, conceal: "L", wt: 1.1, cost: 302, av: "P", hands: "one",
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>Ofieri straight sword.</p>" },
    { name: "Sa'if", wa: 2, dmg: "4d6", dmgType: "S", range: "BODY×1", rel: 10, en: 1, conceal: "L", wt: 1.1, cost: 707, av: "R", hands: "one",
      qualities: ["balanced"],
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>Ofieri sabre. <strong>Balanced</strong>.</p>" },
    { name: "Shamshir", wa: 1, dmg: "4d6", dmgType: "S", range: "BODY×1", rel: 10, en: 1, conceal: "L", wt: 1.3, cost: 730, av: "R", hands: "one",
      qualities: ["cavalry", "bleeding"], qualityValues: { bleeding: "75" },
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>Deeply-curved Ofieri sabre. <strong>Cavalry, Bleed 75%</strong>.</p>" },
    { name: "Kilij", wa: 1, dmg: "5d6", dmgType: "S", range: "BODY×1", rel: 10, en: 1, conceal: "N/A", wt: 1.3, cost: 791, av: "R", hands: "one",
      qualities: ["bleeding"], qualityValues: { bleeding: "50" },
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>Turkish flared-tip sabre. <strong>Bleed 50%</strong>.</p>" },
    { name: "Shishpar", wa: 0, dmg: "5d6", dmgType: "B", range: "BODY×1", rel: 15, en: 1, conceal: "L", wt: 1.7, cost: 633, av: "R", hands: "one",
      qualities: ["guard", "cavalry", "ablating"],
      category: "melee", skill: "melee",
      description: "<p>Flanged mace. <strong>Guard, Cavalry, Ablating</strong>.</p>" },
    { name: "Tabarzin", wa: 0, dmg: "5d6", dmgType: "S", range: "BODY×1", rel: 15, en: 1, conceal: "L", wt: 1.6, cost: 653, av: "R", hands: "one",
      qualities: ["guard", "cavalry", "ablating"],
      category: "melee", skill: "melee",
      description: "<p>Ofieri saddle axe. <strong>Guard, Cavalry, Ablating</strong>.</p>" },
    { name: "Tabar", wa: 1, dmg: "6d6", dmgType: "S", range: "N/A", rel: 20, en: 2, conceal: "N/A", wt: 2.2, cost: 1179, av: "R", hands: "two",
      qualities: ["sturdy", "ablating"],
      category: "melee", skill: "melee",
      description: "<p>Two-handed war axe. <strong>Sturdy, Ablating</strong>.</p>" }
);

/* ── Elderfolk Armory & Witcher Kit weapons (EO p.26-29) ──────── */
WEAPONS.push(
    /* Elderfolk knife & swords (signature blades) — stats per EO PDF */
    { name: "Mahakaman Sihil", wa: 1, dmg: "4d6+4", dmgType: "P/S", range: "BODY×1", rel: 20, en: 2, conceal: "L", wt: 0.8, cost: 980, av: "R", hands: "one",
      qualities: ["balanced", "armorPiercing", "meteorite", "twoHand"],
      qualityValues: { twoHand: "+1 WA, +1d6 Dmg" },
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>Meteorite-blade sword prized by Mahakamans. <strong>Balanced, Armor Piercing, Meteorite</strong>; <strong>Two-Hand</strong>: +1 WA, +1d6 Dmg. The impact-concentrated tip can easily reach around an enemy's guard.</p>" },
    { name: "Gwyhyr", wa: 3, dmg: "4d6", dmgType: "P/S", range: "BODY×1", rel: 10, en: 2, conceal: "L", wt: 1.1, cost: 1432, av: "R", hands: "one",
      qualities: ["guard", "balanced", "bleeding", "twoHand"],
      qualityValues: { bleeding: "75", twoHand: "+1 WA, +2 Dmg" },
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>Gnomish gwyhyr — the finest elven smithing of the continent. <strong>Guard, Balanced, Bleed 75%</strong>; <strong>Two-Hand</strong>: +1 WA, +2 Dmg.</p>" },
    { name: "Elven Saber", wa: 2, dmg: "4d6+4", dmgType: "S", range: "BODY×1", rel: 12, en: 2, conceal: "L", wt: 1.1, cost: 1239, av: "R", hands: "one",
      qualities: ["balanced", "bleeding", "cavalry"], qualityValues: { bleeding: "50" },
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>Elven cavalry saber. <strong>Balanced, Bleed 50%, Cavalry</strong>.</p>" },
    /* Witcher Kit signature: silver swords — stats per EO PDF Witcher Kit table */
    { name: "Witcher Steel Sword", wa: 1, dmg: "4d6+2", dmgType: "P/S", range: "BODY×1", rel: 15, en: 2, conceal: "L", wt: 1, cost: 800, av: "R", hands: "one",
      qualities: ["guard", "balanced", "meteorite", "twoHand"],
      qualityValues: { twoHand: "+1 WA, +2 Dmg" },
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>Witcher-forged steel sword. <strong>Guard, Balanced, Meteorite</strong>; <strong>Two-Hand</strong>: +1 WA, +2 Dmg.</p>" },
    { name: "Witcher Silver Sword", wa: 1, dmg: "1d6+2", dmgType: "P/S", range: "BODY×1", rel: 5, en: 2, conceal: "L", wt: 1, cost: 1500, av: "R", hands: "one",
      qualities: ["guard", "balanced", "silver", "twoHand"],
      qualityValues: { silver: "3d6", twoHand: "+1 WA, +2 Dmg" },
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>Witcher silver-edged sword for monsters. <strong>Guard, Balanced, Silver +3d6</strong>; <strong>Two-Hand</strong>: +1 WA, +2 Dmg.</p>" },
    { name: "Silver Knuckles", wa: 0, dmg: "+0", dmgType: "B/N", range: "N/A", rel: 2, en: 0, conceal: "T", wt: 0.5, cost: 250, av: "P", hands: "one",
      qualities: ["silver"], qualityValues: { silver: "2d6" },
      category: "brawling", skill: "brawling",
      description: "<p>Silver-tipped knuckle dusters for desperate measures. <strong>Brawling (Punch), Silver +2d6</strong>.</p>" },

    /* ── Witcher School Weapons (EO p.31) ────────────────────────── */
    { name: "Feline Steel Sword", wa: 3, dmg: "4d6+2", dmgType: "P/S", range: "BODY×1", rel: 15, en: 2, conceal: "L", wt: 0.7, cost: 0, av: "R", hands: "one",
      qualities: ["guard", "balanced", "meteorite"],
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>Cat School steel sword — extraordinarily nimble. <strong>Guard, Balanced, Meteorite</strong>.</p>" },
    { name: "Feline Silver Sword", wa: 3, dmg: "1d6+2", dmgType: "P/S", range: "BODY×1", rel: 5, en: 2, conceal: "L", wt: 0.7, cost: 0, av: "R", hands: "one",
      qualities: ["guard", "balanced", "silver"], qualityValues: { silver: "3d6" },
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>Cat School silver sword. <strong>Guard, Balanced, Silver +3d6</strong>.</p>" },
    { name: "Gryphon Steel Sword", wa: 2, dmg: "4d6+2", dmgType: "P/S", range: "BODY×1", rel: 15, en: 2, conceal: "L", wt: 0.9, cost: 0, av: "R", hands: "one",
      qualities: ["guard", "balanced", "focus", "meteorite"], qualityValues: { focus: "1" },
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>Griffin School steel sword. <strong>Guard, Balanced, Focus (1), Meteorite</strong>.</p>" },
    { name: "Gryphon Silver Sword", wa: 2, dmg: "1d6+2", dmgType: "P/S", range: "BODY×1", rel: 5, en: 2, conceal: "L", wt: 0.9, cost: 0, av: "R", hands: "one",
      qualities: ["guard", "balanced", "focus", "silver"], qualityValues: { focus: "1", silver: "3d6" },
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>Griffin School silver sword. <strong>Guard, Balanced, Focus (1), Silver +3d6</strong>.</p>" },
    { name: "Manticore Steel Sword", wa: 2, dmg: "4d6+2", dmgType: "P/S", range: "BODY×1", rel: 15, en: 2, conceal: "L", wt: 0.9, cost: 0, av: "R", hands: "one",
      qualities: ["balanced", "armorPiercing", "meteorite"],
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>Manticore School steel sword. <strong>Balanced, Armor Piercing, Meteorite</strong>.</p>" },
    { name: "Manticore Silver Sword", wa: 2, dmg: "1d6+2", dmgType: "P/S", range: "BODY×1", rel: 5, en: 2, conceal: "L", wt: 0.9, cost: 0, av: "R", hands: "one",
      qualities: ["balanced", "armorPiercing", "silver"], qualityValues: { silver: "3d6" },
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>Manticore School silver sword. <strong>Balanced, Armor Piercing, Silver +3d6</strong>.</p>" },
    { name: "Serpentine Sword", wa: 2, dmg: "4d6+2", dmgType: "P/S", range: "BODY×1", rel: 10, en: 2, conceal: "L", wt: 0.7, cost: 0, av: "R", hands: "one",
      qualities: ["balanced", "bleeding", "meteorite", "silver"],
      qualityValues: { bleeding: "75", silver: "3d6" },
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>Viper School twin-blade. <strong>Balanced, Bleed 75%, Meteorite, Silver +3d6</strong>.</p>" },
    { name: "Wolven Steel Sword", wa: 1, dmg: "4d6+2", dmgType: "P/S", range: "BODY×1", rel: 20, en: 2, conceal: "N/A", wt: 1, cost: 0, av: "R", hands: "one",
      qualities: ["superiorGuard", "meteorite", "twoHand"],
      qualityValues: { twoHand: "+1 WA, +2 Dmg, Balanced" },
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>Wolf School steel sword. <strong>Superior Guard, Meteorite</strong>; <strong>Two-Hand</strong>: +1 WA, +2 Dmg, Balanced.</p>" },
    { name: "Wolven Silver Sword", wa: 1, dmg: "1d6+2", dmgType: "P/S", range: "BODY×1", rel: 10, en: 2, conceal: "N/A", wt: 1, cost: 0, av: "R", hands: "one",
      qualities: ["superiorGuard", "silver", "twoHand"],
      qualityValues: { silver: "3d6", twoHand: "+1 WA, +2 Dmg, Balanced" },
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>Wolf School silver sword. <strong>Superior Guard, Silver +3d6</strong>; <strong>Two-Hand</strong>: +1 WA, +2 Dmg, Balanced.</p>" },
    { name: "Ursine Steel Sword", wa: 2, dmg: "5d6+2", dmgType: "P/S", range: "BODY×1", rel: 25, en: 2, conceal: "N/A", wt: 1.5, cost: 0, av: "R", hands: "two",
      qualities: ["guard", "sturdy", "ablating", "armorPiercing", "meteorite"],
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>Bear School two-handed steel sword. <strong>Guard, Sturdy, Ablating, Armor Piercing, Meteorite</strong>.</p>" },
    { name: "Ursine Silver Sword", wa: 2, dmg: "2d6+2", dmgType: "P/S", range: "BODY×1", rel: 15, en: 2, conceal: "N/A", wt: 1.5, cost: 0, av: "R", hands: "two",
      qualities: ["guard", "sturdy", "ablating", "armorPiercing", "silver"], qualityValues: { silver: "3d6" },
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>Bear School two-handed silver sword. <strong>Guard, Sturdy, Ablating, Armor Piercing, Silver +3d6</strong>.</p>" },
    { name: "Ballock Great Sword", wa: 1, dmg: "6d6", dmgType: "P/S", range: "BODY×1", rel: 25, en: 2, conceal: "N/A", wt: 2.5, cost: 0, av: "R", hands: "two",
      qualities: ["guard", "sturdy", "meteorite"],
      category: "swordsmanship", skill: "swordsmanship",
      description: "<p>Massive two-handed witcher sword. <strong>Guard, Sturdy, Meteorite</strong>.</p>" },
    { name: "Viper Fang", wa: 0, dmg: "1d6+2", dmgType: "P/S", range: "BODY×2", rel: 10, en: 1, conceal: "S", wt: 0.5, cost: 0, av: "R", hands: "one", quick: true,
      qualities: ["nimble", "parrying", "bleeding", "meteorite", "silver", "closeQuarters", "throwing"],
      qualityValues: { bleeding: "75", silver: "3d6", closeQuarters: "+3 WA, +2d6 Dmg" },
      category: "smallBlades", skill: "smallBlades",
      description: "<p>Viper School fanged dagger. <strong>Nimble, Parrying, Bleed 75%, Meteorite, Silver +3d6</strong>; <strong>Close Quarters</strong>: +3 WA, +2d6 Dmg.</p>" },
    { name: "Wolven Silver Chain", wa: 0, dmg: "1d6", dmgType: "B/N", range: "BODY×1", rel: 5, en: 0, conceal: "S", wt: 2, cost: 0, av: "R", hands: "two",
      qualities: ["longReach", "indirect", "grappling", "entangling", "silver", "strangling"],
      qualityValues: { silver: "2d6", strangling: "+1 WA, suffocation ×2" },
      category: "melee", skill: "melee",
      description: "<p>Wolf School weighted silver chain. <strong>Long Reach, Indirect, Grappling, Entangling, Silver +2d6</strong>; <strong>Strangling</strong>: +1 WA, ×2 suffocation.</p>" },
    { name: "Feline Crossbow", wa: 2, dmg: "3d6+2", dmgType: "P", range: "50m", rel: 2, en: 1, conceal: "L", wt: 0.5, cost: 0, av: "R", hands: "one",
      qualities: ["feeble", "nimble", "balanced", "stableAim", "slowReload"], qualityValues: { slowReload: "1" },
      category: "crossbow", skill: "crossbow",
      description: "<p>Cat School light crossbow. <strong>Feeble, Nimble, Balanced, Stable Aim, Slow Reload (1)</strong>.</p>" },
    { name: "Gryphon Crossbow", wa: 1, dmg: "4d6+1", dmgType: "P", range: "50m", rel: 2, en: 2, conceal: "L", wt: 0.5, cost: 0, av: "R", hands: "one",
      qualities: ["feeble", "nimble", "stableAim", "slowReload"], qualityValues: { slowReload: "1" },
      category: "crossbow", skill: "crossbow",
      description: "<p>Griffin School crossbow. <strong>Feeble, Nimble, Stable Aim, Slow Reload (1)</strong>.</p>" },
    { name: "Ursine Crossbow", wa: 0, dmg: "5d6", dmgType: "P", range: "50m", rel: 4, en: 1, conceal: "L", wt: 1, cost: 0, av: "R", hands: "one",
      qualities: ["feeble", "stableAim", "slowReload"], qualityValues: { slowReload: "1" },
      category: "crossbow", skill: "crossbow",
      description: "<p>Bear School heavy crossbow. <strong>Feeble, Stable Aim, Slow Reload (1)</strong>.</p>" }
);

/* ── AMMUNITION (EO p.13) ───────────────────────────────────────── */
const AMMUNITION = [
    /* EO ammunition is RIDER-only — no independent damage column. The
     * weapon's base damage drives the shot; the ammo carries on-hit
     * qualities. We leave `dmg` empty for that reason. */
    /* Stats per EO p.13 unified Arrows & Bolts table (/tmp/eo-layout.txt
     * L728-736). Blunt is B/N with Half Damage; weights & costs match the
     * PDF row. The arrow + bolt variant share these values. */
    { name: "Broadhead Arrow", subtype: "arrow", dmg: "0", dmgType: "S", qualities: ["bleeding"], qualityValues: { bleeding: "100" },
      wt: 0.06, cost: 14, av: "C", description: "<p>Wide-cutting arrowhead. <strong>Bleeding 100%</strong>.</p>" },
    { name: "Bodkin Arrow",    subtype: "arrow", dmg: "0", dmgType: "P", qualities: ["armorPiercing"],
      wt: 0.08, cost: 15, av: "C", description: "<p>Narrow armor-piercing arrowhead. <strong>Armor Piercing</strong>.</p>" },
    { name: "Blunt Arrow",     subtype: "arrow", dmg: "0", dmgType: "B", qualities: ["halfDamage", "nonLethal"],
      wt: 0.07, cost: 6,  av: "C", description: "<p>Blunt arrowhead — non-lethal blow. <strong>Half Damage</strong>.</p>" },
    { name: "Flight Arrow",    subtype: "arrow", dmg: "0", dmgType: "P", qualities: ["improvedRange"],
      wt: 0.04, cost: 6,  av: "C", description: "<p>Long-range flight arrow. <strong>Improved Range</strong>.</p>" },
    { name: "Standard Arrow",  subtype: "arrow", dmg: "0", dmgType: "P", qualities: [],
      wt: 0.06, cost: 7,  av: "E", description: "<p>Plain target / hunting arrow.</p>" },
    /* ── Basic crossbow bolts (EO p.13 — "Arrows & Bolts" share names) ── */
    { name: "Crossbow Bolt",   subtype: "bolt",  dmg: "0", dmgType: "P", qualities: [],
      wt: 0.06, cost: 7,  av: "E", description: "<p>Standard crossbow bolt.</p>" },
    { name: "Blunt Bolt",      subtype: "bolt",  dmg: "0", dmgType: "B",
      qualities: ["halfDamage", "nonLethal"], qualityValues: {},
      wt: 0.07, cost: 6, av: "C",
      description: "<p>Blunt-tipped bolt — non-lethal blow. <strong>Half Damage</strong>.</p>" },
    { name: "Broadhead Bolt",  subtype: "bolt",  dmg: "0", dmgType: "S",
      qualities: ["bleeding"], qualityValues: { bleeding: "100" },
      wt: 0.06, cost: 14, av: "C",
      description: "<p>Wide-cutting crossbow bolt. <strong>Bleed 100%</strong>.</p>" },
    { name: "Bodkin Bolt",     subtype: "bolt",  dmg: "0", dmgType: "P",
      qualities: ["armorPiercing"], qualityValues: {},
      wt: 0.08, cost: 15, av: "C",
      description: "<p>Narrow armor-piercing crossbow bolt. <strong>Armor Piercing</strong>.</p>" },
    /* Flaming variant: PDF p.13 lists "Flaming, ×1" under Arrows & Bolts.
     * Both arrow and bolt are emitted; the artillery "Flaming Scorpio Bolt"
     * is a separate, heavier (2kg) Scorpio round. */
    { name: "Flaming Arrow",   subtype: "arrow", dmg: "0", dmgType: "P",
      qualities: ["halfDamage", "reducedRange", "fire"], qualityValues: { fire: "25" },
      wt: 0.07, cost: 18, av: "P",
      description: "<p>Pitch-soaked flaming arrow. -1 WA; <strong>Half Damage, Reduced Range, Fire 25%</strong>. Sieges &amp; ambushes against ignitable targets.</p>" },
    { name: "Flaming Bolt",    subtype: "bolt",  dmg: "0", dmgType: "P",
      qualities: ["halfDamage", "reducedRange", "fire"], qualityValues: { fire: "25" },
      wt: 0.07, cost: 18, av: "P",
      description: "<p>Pitch-soaked flaming crossbow bolt. -1 WA; <strong>Half Damage, Reduced Range, Fire 25%</strong>.</p>" },
    { name: "Sling Bullet, Clay",   subtype: "slingBullet", dmg: "0", dmgType: "B",
      qualities: ["nonLethal", "concealment"],
      wt: 0.05, cost: 1, av: "E",
      description: "<p>Clay sling bullet — compact and accurate for non-lethal blows. +1 WA; <strong>Concealment</strong>.</p>" },
    { name: "Sling Bullet, Stone",  subtype: "slingBullet", dmg: "0", dmgType: "B", qualities: ["freeAmmunition"],
      wt: 0.05, cost: 0, av: "E", description: "<p>Sling stone. <strong>Free Ammunition</strong>.</p>" },
    { name: "Sling Bullet, Lead",   subtype: "slingBullet", dmg: "0", dmgType: "B", qualities: ["improvedRange", "concealment"],
      wt: 0.07, cost: 8, av: "C", description: "<p>Lead sling bullet. +1 WA; <strong>Improved Range, Concealment</strong>.</p>" },

    /* ── Quality Northern Ammunition (EO p.17) ──────────────────── */
    /* PDF lists each as "Arrows or Bolts, <name>" — share recipe + stats;
     * we emit both subtypes so crossbow loadouts have the same variety. */
    { name: "Rivian Needle",   subtype: "arrow", dmg: "0", dmgType: "P",
      qualities: ["improvedRange", "bleeding"], qualityValues: { bleeding: "50" },
      wt: 0.5, cost: 26, av: "P", description: "<p>Long Rivian needle-arrow. <strong>Improved Range, Bleed 50%</strong>.</p>" },
    { name: "Rivian Needle Bolt", subtype: "bolt", dmg: "0", dmgType: "P",
      qualities: ["improvedRange", "bleeding"], qualityValues: { bleeding: "50" },
      wt: 0.5, cost: 26, av: "P", description: "<p>Long Rivian needle-bolt. <strong>Improved Range, Bleed 50%</strong>.</p>" },
    { name: "Temerian Sheaf",  subtype: "arrow", dmg: "0", dmgType: "P",
      qualities: ["improvedArmorPiercing"],
      wt: 1, cost: 33, av: "P", description: "<p>Temerian heavy-shaft sheaf arrow. <strong>Improved Armor Piercing</strong>.</p>" },
    { name: "Temerian Sheaf Bolt", subtype: "bolt", dmg: "0", dmgType: "P",
      qualities: ["improvedArmorPiercing"],
      wt: 1, cost: 33, av: "P", description: "<p>Temerian heavy-shaft sheaf bolt. <strong>Improved Armor Piercing</strong>.</p>" },
    { name: "Whistling Bullet",   subtype: "slingBullet", dmg: "0", dmgType: "B",
      qualities: ["halfDamage", "reducedRange", "concealment"],
      wt: 0.5, cost: 7, av: "C", description: "<p>Whistling sling bullet. <strong>Half Damage, Reduced Range, Concealment</strong>. Enemies within 10m of flight path beat DC:14 Courage or be Staggered.</p>" },
    { name: "Dimeritium Bullet",  subtype: "slingBullet", dmg: "0", dmgType: "B",
      qualities: [],
      wt: 0.8, cost: 45, av: "R", description: "<p>Dimeritium-cored sling bullet. +1 WA; target is affected as if they touched dimeritium for 1 round.</p>" },

    /* ── Fine Southern Ammunition (EO p.21) ─────────────────────── */
    { name: "Markee Howler",        subtype: "arrow", dmg: "0", dmgType: "P",
      qualities: ["halfDamage", "reducedRange"],
      wt: 0.07, cost: 26, av: "R", description: "<p>Howling Mettinese arrow. <strong>Half Damage, Reduced Range</strong>. Enemies within 10m of flight path beat DC:14 Courage or be Staggered.</p>" },
    { name: "Markee Howler Bolt",   subtype: "bolt", dmg: "0", dmgType: "P",
      qualities: ["halfDamage", "reducedRange"],
      wt: 0.07, cost: 26, av: "R", description: "<p>Howling Mettinese bolt. <strong>Half Damage, Reduced Range</strong>. Enemies within 10m of flight path beat DC:14 Courage or be Staggered.</p>" },
    { name: "Black Army Bodkin",    subtype: "arrow", dmg: "0", dmgType: "P",
      qualities: ["ablating", "armorPiercing"],
      wt: 0.9, cost: 29, av: "P", description: "<p>Nilfgaardian heavy bodkin arrow. <strong>Ablating, Armor Piercing</strong>.</p>" },
    { name: "Black Army Bodkin Bolt", subtype: "bolt", dmg: "0", dmgType: "P",
      qualities: ["ablating", "armorPiercing"],
      wt: 0.9, cost: 29, av: "P", description: "<p>Nilfgaardian heavy bodkin bolt. <strong>Ablating, Armor Piercing</strong>.</p>" },
    { name: "Heavy Bullet",         subtype: "slingBullet", dmg: "0", dmgType: "B",
      qualities: ["reducedRange", "ablating", "concealment"],
      wt: 0.1, cost: 11, av: "C", description: "<p>Heavy lead bullet. +1 WA, <strong>Reduced Range, Ablating, Concealment</strong>.</p>" },
    { name: "Incendiary Bullet",    subtype: "slingBullet", dmg: "0", dmgType: "B",
      qualities: ["halfDamage", "fire", "concealment"], qualityValues: { fire: "25" },
      wt: 0.05, cost: 26, av: "P", description: "<p>Incendiary pellet. <strong>Half Damage, Fire 25%, Concealment</strong>.</p>" },

    /* ── Exotic Ammunition (EO p.24) — "Arrows or Bolts" rows from PDF. ── */
    { name: "Bone-Tipped Arrow", subtype: "arrow", dmg: "0", dmgType: "P", qualities: [], qualityValues: {},
      rel: 1, wt: 0.06, cost: 5, av: "P", conceal: "L",
      description: "<p>Bone-tipped arrows are nearly as effective as iron arrows and a bit cheaper. Common beyond the Korath in Zerrikania and among the Haaks.</p>" },
    { name: "Bone-Tipped Bolt",  subtype: "bolt",  dmg: "0", dmgType: "P", qualities: [], qualityValues: {},
      rel: 1, wt: 0.06, cost: 5, av: "P", conceal: "L",
      description: "<p>Bone-tipped bolts are nearly as effective as iron bolts and a bit cheaper.</p>" },

    { name: "Ofieri Flight", subtype: "arrow", dmg: "0", dmgType: "P", qualities: ["improvedRange"], qualityValues: {},
      rel: 1, wt: 0.03, cost: 17, av: "R", conceal: "L",
      description: "<p>Light Ofieri distance-shooting arrow, favored in sport. <strong>Improved Range</strong>.</p>" },
    { name: "Ofieri Flight Bolt", subtype: "bolt", dmg: "0", dmgType: "P", qualities: ["improvedRange"], qualityValues: {},
      rel: 1, wt: 0.03, cost: 17, av: "R", conceal: "L",
      description: "<p>Light Ofieri distance-shooting bolt. <strong>Improved Range</strong>.</p>" },

    { name: "Zerrikanian Bladed", subtype: "arrow", dmg: "0", dmgType: "P",
      qualities: ["ablating", "bleeding"], qualityValues: { bleeding: "75" },
      rel: 1, wt: 0.07, cost: 35, av: "R", conceal: "L",
      description: "<p>Triple-bladed crucible-steel arrowhead — strips armor and causes severe bleeding. <strong>Ablating, Bleed 75%</strong>.</p>" },
    { name: "Zerrikanian Bladed Bolt", subtype: "bolt", dmg: "0", dmgType: "P",
      qualities: ["ablating", "bleeding"], qualityValues: { bleeding: "75" },
      rel: 1, wt: 0.07, cost: 35, av: "R", conceal: "L",
      description: "<p>Triple-bladed crucible-steel bolt — strips armor and causes severe bleeding. <strong>Ablating, Bleed 75%</strong>.</p>" },

    { name: "Haakish", subtype: "arrow", dmg: "0", dmgType: "P",
      qualities: ["bleeding", "poison", "disease"],
      qualityValues: { bleeding: "50", poison: "25", disease: "25" },
      rel: 1, wt: 0.05, cost: 38, av: "R", conceal: "L",
      description: "<p>Alchemically treated Haakish arrow combining bleeding, venom, and infection. <strong>Bleed 50%, Poison 25%, Disease 25%</strong>.</p>" },
    { name: "Haakish Bolt", subtype: "bolt", dmg: "0", dmgType: "P",
      qualities: ["bleeding", "poison", "disease"],
      qualityValues: { bleeding: "50", poison: "25", disease: "25" },
      rel: 1, wt: 0.05, cost: 38, av: "R", conceal: "L",
      description: "<p>Alchemically treated Haakish bolt combining bleeding, venom, and infection. <strong>Bleed 50%, Poison 25%, Disease 25%</strong>.</p>" },

    /* ── Eldercraft Ammunition (EO p.27) — "Arrows or Bolts" rows. ── */
    { name: "Dwarven Impact", subtype: "arrow", dmgType: "B", dmg: "0",
      qualities: ["ablating", "stagger"], qualityValues: { stagger: "50" },
      rel: 1, wt: 0.1, cost: 23, av: "P", conceal: "L",
      description: "<p>Dwarven arrow tipped with heavy tempered steel balls — buckles the heaviest armor when fielded en masse. <strong>Ablating, Stagger 50%</strong>.</p>" },
    { name: "Dwarven Impact Bolt", subtype: "bolt", dmgType: "B", dmg: "0",
      qualities: ["ablating", "stagger"], qualityValues: { stagger: "50" },
      rel: 1, wt: 0.1, cost: 23, av: "P", conceal: "L",
      description: "<p>Dwarven bolt tipped with heavy tempered steel balls. <strong>Ablating, Stagger 50%</strong>.</p>" },

    { name: "Elven Burrower", subtype: "arrow", dmgType: "P", dmg: "0",
      qualities: ["bleeding"], qualityValues: { bleeding: "100" },
      rel: 1, wt: 0.06, cost: 30, av: "P", conceal: "L",
      description: "<p>Barbed scoia'tael arrow that burrows deep on impact. Requires DC:16 First Aid to remove from a bleeding wound. <strong>Bleed 100%</strong>.</p>" },
    { name: "Elven Burrower Bolt", subtype: "bolt", dmgType: "P", dmg: "0",
      qualities: ["bleeding"], qualityValues: { bleeding: "100" },
      rel: 1, wt: 0.06, cost: 30, av: "P", conceal: "L",
      description: "<p>Barbed scoia'tael bolt that burrows deep on impact. Requires DC:16 First Aid to remove from a bleeding wound. <strong>Bleed 100%</strong>.</p>" },

    { name: "Silver Bullet", subtype: "slingBullet", dmgType: "B", dmg: "0",
      qualities: ["improvedRange", "silver", "concealment"],
      qualityValues: { silver: "2d6" },
      rel: 1, wt: 0.05, cost: 12, av: "P", conceal: "L",
      description: "<p>Dense silver sling bullet for monster hunting. +1 WA; <strong>Improved Range, Silver +2d6, Concealment</strong>.</p>" },

    { name: "Meteorite Bullet", subtype: "slingBullet", dmgType: "B", dmg: "0",
      qualities: ["improvedRange", "ablating", "meteorite", "concealment"],
      rel: 1, wt: 0.05, cost: 29, av: "R", conceal: "L",
      description: "<p>Meteoric-iron sling bullet — not the densest, but its properties affect certain monsters. <strong>Improved Range, Ablating, Meteorite, Concealment</strong>.</p>" },

    /* ── Artillery Ammunition (EO p.35) ───────────────────────────── */
    /* Scorpio bolts — disambiguated from basic crossbow bolts of the same
     * effect name. PDF p.35 uses "Standard Bolt (Scorpio)" on the spread;
     * we make that explicit in the names so the inventory doesn't show two
     * "Standard Bolt" rows. */
    { name: "Standard Scorpio Bolt", subtype: "ballista", dmgType: "P", dmg: "0",
      qualities: ["bleeding"], qualityValues: { bleeding: "25" },
      rel: 1, wt: 2, cost: 475, av: "R", conceal: "N/A",
      description: "<p>Standard barbed scorpio bolt — leaves a broad, nasty bleeding wound. <strong>Bleed 25%</strong>. (Scorpio ammunition.)</p>" },

    { name: "Breaker Scorpio Bolt", subtype: "ballista", dmgType: "B", dmg: "0",
      qualities: ["ablating"], qualityValues: {},
      rel: 1, wt: 2, cost: 478, av: "R", conceal: "N/A",
      description: "<p>Broad, blunt, pronged scorpio bolt for shattering armor or light fortifications. -1 WA; <strong>Ablating</strong>. (Scorpio ammunition.)</p>" },

    { name: "Piercer Scorpio Bolt", subtype: "ballista", dmgType: "P", dmg: "0",
      qualities: ["armorPiercing"], qualityValues: {},
      rel: 1, wt: 2, cost: 615, av: "R", conceal: "N/A",
      description: "<p>Reinforced bodkin-tipped scorpio bolt that glides through armor. <strong>Armor Piercing</strong>. (Scorpio ammunition.)</p>" },

    { name: "Flaming Scorpio Bolt", subtype: "ballista", dmgType: "P", dmg: "0",
      qualities: ["fire"], qualityValues: { fire: "25" },
      rel: 1, wt: 2, cost: 508, av: "R", conceal: "N/A",
      description: "<p>Pitch-wrapped scorpio bolt — sometimes the satisfaction of lighting someone on fire is worth the lost accuracy. -1 WA; <strong>Fire 25%</strong>. (Scorpio ammunition.)</p>" },

    /* Ballista & Siege Scorpion ammunition */
    { name: "Ballista Bolt", subtype: "ballista", dmgType: "P", dmg: "0",
      qualities: ["improvedArmorPiercing"], qualityValues: {}, // uncertain: "travels another 1d10m hitting each creature in path" needs a custom quality
      rel: 1, wt: 5, cost: 313, av: "P", conceal: "N/A",
      description: "<p>Ballista/siege-scorpion bolt that doesn't stop after impaling. After hitting its target it travels another 1d10m, hitting each creature in its path that fails to defend; each victim that takes damage reduces the damage dealt to the next by their Stopping Power + BODY.</p>" },

    { name: "Stone", subtype: "stone", dmgType: "B", dmg: "0",
      qualities: [], qualityValues: {},
      rel: 1, wt: 10, cost: 29, av: "C", conceal: "N/A",
      description: "<p>Large stone or boulder — the simplest and cheapest siege ammunition. Stats shown are for ballistae/siege scorpions; mangonel stones are 40kg/114c and trebuchet stones 80kg/229c.</p>" },

    { name: "Stone Shot Grenade", subtype: "stone", dmgType: "B", dmg: "0",
      qualities: [], qualityValues: {}, // uncertain: custom "quarter dmg to every body location within 3m" effect
      rel: 1, wt: 10, cost: 40, av: "C", conceal: "N/A",
      description: "<p>Clay pot packed with small jagged rocks. Deals quarter damage to every body location of everything within 3m (ballista/siege scorpion); 5m radius for mangonels, 7m for trebuchets.</p>" },

    { name: "Clay Fire Pot", subtype: "stone", dmgType: "B", dmg: "0",
      qualities: ["fire"], qualityValues: { fire: "25" }, // uncertain: special AoE ignition effect — see description
      rel: 1, wt: 7, cost: 209, av: "P", conceal: "N/A",
      description: "<p>Clay pot of pitch, burning coals, and alchemical fire. Deals half damage to the target and 25% chance of lighting everything within 3m on fire (ballista/siege scorpion); 5m radius for mangonels (25kg, 658c), 7m for trebuchets (50kg, 1293c).</p>" },

    { name: "Zerrikanian Fire", subtype: "stone", dmgType: "E", dmg: "0",
      qualities: ["fire"], qualityValues: { fire: "100" }, // uncertain: "E (fire)" damage type; using "E" elemental
      rel: 1, wt: 6, cost: 611, av: "R", conceal: "N/A",
      description: "<p>Huge clay pot of Zerrikanian Fire — devastates fortifications supported by wooden structures. Deals quarter damage to the target and 100% chance of lighting everything within 3m on fire (siege scorpion); 5m for mangonels (20kg, 2281c), 7m for trebuchets (40kg, 5523c).</p>" },

    { name: "Carcass", subtype: "stone", dmgType: "B", dmg: "0",
      qualities: ["disease"], qualityValues: { disease: "100" }, // uncertain: DC:15 Endurance to avoid disease — modeled as disease 100% rider
      rel: 1, wt: 40, cost: 0, av: "P", conceal: "N/A",
      description: "<p>Rotting cadaver hurled over the walls — spreads disease and terror. Deals half damage to the target; everyone within 9m (mangonel; 11m–15m for trebuchet variants) must beat DC:15 Endurance or contract disease. Mangonel carcass shown; trebuchet variants are 80kg (25c), 120kg/25% range (50c), or 200kg/50% range (100c). Scavenged from any approximately appropriately sized rotting body — not crafted.</p>" }
];

/* ── ARMOR ENHANCEMENTS (Glyphs + physical mods, EO p.4 framework) ──
 *
 *   target  : "armor" — these all attach to armor (not weapons)
 *   subType : "glyph" or "armor" (physical mod)
 *   bonus   : SP, EV change, resistances, etc.
 * ───────────────────────────────────────────────────────────────── */
const ARMOR_ENHANCEMENTS = [
    /* Glyphs (consume from En. pool) */
    { name: "Glyph of Aard", subType: "glyph", stopping: 0, bludgeoning: true,
      cost: 350, av: "P", description: "<p>Glyph of Aard. Grants bludgeoning resistance.</p>" },
    { name: "Glyph of Igni", subType: "glyph", stopping: 0, qualities: ["fireproof"],
      cost: 400, av: "P", description: "<p>Glyph of Igni. Grants fire resistance.</p>" },
    { name: "Glyph of Yrden", subType: "glyph", stopping: 1,
      cost: 380, av: "P", description: "<p>Glyph of Yrden. +1 SP to all covered locations.</p>" },
    { name: "Glyph of Quen", subType: "glyph", stopping: 2,
      cost: 600, av: "R", description: "<p>Glyph of Quen. +2 SP to all covered locations.</p>" },
    /* Physical mods (consume from per-location AE pool) */
    { name: "Reinforced Plating", subType: "armor", stopping: 2,
      cost: 200, av: "C", description: "<p>Riveted reinforcement plate. +2 SP to the attached location.</p>" },
    { name: "Hardened Lining", subType: "armor", stopping: 1, slashing: true,
      cost: 150, av: "C", description: "<p>Hardened inner lining. +1 SP, +Slashing resist.</p>" },
    { name: "Padded Lining", subType: "armor", stopping: 1, bludgeoning: true,
      cost: 140, av: "C", description: "<p>Quilted padding. +1 SP, +Bludgeoning resist.</p>" },
    { name: "Mail Lining", subType: "armor", stopping: 1, slashing: true, encumbranceMod: 1,
      cost: 220, av: "P", description: "<p>Layered mail lining. +1 SP, +Slashing resist, +1 EV.</p>" },
    { name: "Studded Hide", subType: "armor", stopping: 1, piercing: true,
      cost: 160, av: "C", description: "<p>Studded hide layer. +1 SP, +Piercing resist.</p>" },
    /* More glyphs (EO p.32-34 reference; representative subset) */
    { name: "Lesser Glyph of Mending", subType: "glyph", stopping: 0,
      cost: 200, av: "C", description: "<p>Self-mending glyph. Restores 1 reliability per long rest while worn.</p>" },
    { name: "Greater Glyph of Quen", subType: "glyph", stopping: 3,
      cost: 1100, av: "R", description: "<p>Greater protective glyph. +3 SP to all covered locations.</p>" },
    { name: "Glyph of Warding", subType: "glyph", stopping: 0, qualities: ["fireproof"],
      cost: 500, av: "R", description: "<p>Anti-elemental glyph. Grants fire and elemental resistance.</p>" },
    /* More physical mods */
    { name: "Hardened Bracing", subType: "armor", stopping: 2, encumbranceMod: 1,
      cost: 280, av: "P", description: "<p>Heavy hardened bracing plate. +2 SP, +1 EV.</p>" },
    { name: "Light Padded Trim", subType: "armor", stopping: 0, encumbranceMod: -1,
      cost: 180, av: "C", description: "<p>Lightweight padding trim. -1 EV (minimum 0).</p>" },
    { name: "Plated Underlay", subType: "armor", stopping: 3, encumbranceMod: 1, slashing: true,
      cost: 380, av: "P", description: "<p>Layered plate underlay. +3 SP, +1 EV, +Slashing resist.</p>" },

    /* ── ADDED v2 — missing PDF content (auto-spliced) ──────────── */
    /* ── Material Enhancements (17) ───────────────────────────── */

    { name: "Padding", subType: "armor", category: "material",
      stopping: 1,
      qualities: ["bleedResistance"], qualityValues: { bleedResistance: "25%" },
      // uncertain: PDF lists +1 SP only with no resist text; we add a token
      //            bleed resistance because padding/gambeson is the
      //            canonical anti-bleed underlayer in EO lore. If the
      //            literal PDF is preferred, drop the qualities array.
      encumbranceMod: 0,
      wt: 0.5, cost: 55, av: "E",
      description: "<p>Quilted cloth padding. +1 SP to the attached location.</p>" },

    { name: "Chainmail", subType: "armor", category: "material",
      stopping: 2, slashing: true,
      encumbranceMod: 0,
      wt: 1, cost: 58, av: "E",
      description: "<p>Riveted mail layer. +2 SP and Resistance to Slashing. If the armor already has Slashing resistance, instead adds Resistance to Piercing (heavy armor only).</p>" },

    { name: "Silver", subType: "armor", category: "material",
      stopping: 0,
      qualities: ["silver"],
      encumbranceMod: 0,
      wt: 1, cost: 119, av: "R",
      description: "<p>Silver-laced armor plating. Adds the Silver effect: silver-susceptible monsters are staggered when striking this piece or grappling its wearer. On arms or legs, also grants the Silver effect to brawling strikes from that limb.</p>" },

    { name: "Cuir Bouilli", subType: "armor", category: "material",
      stopping: 1, bludgeoning: true,
      encumbranceMod: 0,
      wt: 1, cost: 119, av: "C",
      description: "<p>Boiled-leather plating. +1 SP and Resistance to Bludgeoning.</p>" },

    { name: "Canvas", subType: "armor", category: "material",
      stopping: 1, piercing: true,
      encumbranceMod: 0,
      wt: 1, cost: 130, av: "P",
      description: "<p>Double-woven canvas layer. +1 SP and Resistance to Piercing.</p>" },

    { name: "Iron Plate", subType: "armor", category: "material",
      stopping: 3, slashing: true,
      // uncertain: PDF's cascade ("if the armor already has Slashing, adds
      //            Piercing + Restricted Vision; if both, adds Bludgeoning
      //            + Poor Vision") is conditional on the base armor's
      //            existing resistances and can't be expressed in this
      //            flat schema. Default to Slashing here; document the
      //            full rule in the description.
      encumbranceMod: 0,
      wt: 2, cost: 136, av: "C",
      description: "<p>Riveted iron plating. +3 SP and Resistance to Slashing. If the armor already has Slashing resistance, instead adds Piercing resistance (and Restricted Vision on helmets). If it has both, adds Bludgeoning resistance (and Poor Vision on helmets).</p>" },

    { name: "Lyrian Leather", subType: "armor", category: "material",
      stopping: 3, bludgeoning: true,
      encumbranceMod: 0,
      wt: 1, cost: 137, av: "P",
      description: "<p>Lyrian-tanned heavy leather. +3 SP and Resistance to Bludgeoning. If the armor already has Bludgeoning resistance, adds Resistance to Slashing instead.</p>" },

    { name: "Silk", subType: "armor", category: "material",
      stopping: 0,
      qualities: ["bleedResistance"], qualityValues: { bleedResistance: "50%" },
      // uncertain: PDF says "Adds Resistance to Bleeding" without a number;
      //            using 50% as a reasonable middle value. Adjust if the
      //            system has a canonical bleed-resist tier.
      encumbranceMod: 0,
      wt: 0.3, cost: 148, av: "R",
      description: "<p>Silk-lined armor. Adds Resistance to Bleeding.</p>" },

    { name: "Steel Plate", subType: "armor", category: "material",
      stopping: 4, slashing: true,
      // uncertain: same conditional cascade as Iron Plate; default Slashing.
      encumbranceMod: 0,
      wt: 2, cost: 198, av: "P",
      description: "<p>Riveted steel plating. +4 SP. Resistance progression follows Iron Plate: Slashing first; then Piercing (with Restricted Vision on helmets) if Slashing is already present; then Bludgeoning (with Poor Vision on helmets) if both are present.</p>" },

    { name: "Chitin", subType: "armor", category: "material",
      stopping: 2, slashing: true,
      encumbranceMod: 0,
      wt: 1.5, cost: 201, av: "R",
      description: "<p>Insectile chitin plating. +2 SP and Resistance to Slashing. Grants a cumulative armor bonus to Intimidate (outer layer only).</p>" },

    { name: "Trollskin", subType: "armor", category: "material",
      stopping: 2, bludgeoning: true,
      encumbranceMod: 0,
      wt: 2.5, cost: 228, av: "R",
      description: "<p>Cured troll hide. +2 SP and Resistance to Bludgeoning. Grants a cumulative armor bonus to Intimidate (outer layer only).</p>" },

    { name: "Elven", subType: "armor", category: "material",
      stopping: 2,
      encumbranceMod: 0,
      wt: 0.5, cost: 239, av: "R",
      description: "<p>Elven-crafted laminate. +2 SP. Grants a cumulative armor bonus to Stealth (outer layer only).</p>" },

    { name: "Gnomish", subType: "armor", category: "material",
      stopping: 1,
      encumbranceMod: -1,
      wt: 0.5, cost: 249, av: "R",
      description: "<p>Gnomish-engineered plating. +1 SP and reduces EV by 1 (minimum 0). Cumulative across multiple body locations.</p>" },

    { name: "Drake Scale", subType: "armor", category: "material",
      stopping: 2,
      qualities: ["fireproof"],
      encumbranceMod: 0,
      wt: 1, cost: 278, av: "R",
      description: "<p>Draconid-scale plating. +2 SP and Resistance to Fire. Grants a cumulative armor bonus to Intimidate (outer layer only).</p>" },

    { name: "Dwarven", subType: "armor", category: "material",
      stopping: 5, slashing: true,
      // uncertain: PDF entry reads "See: Iron Plate" so the same conditional
      //            resist cascade applies. Default Slashing.
      encumbranceMod: 0,
      wt: 2, cost: 401, av: "R",
      description: "<p>Mahakaman-steel plating. +5 SP. Resistance progression follows Iron Plate: Slashing first; then Piercing (with Restricted Vision on helmets); then Bludgeoning (with Poor Vision on helmets).</p>" },

    { name: "Meteorite", subType: "armor", category: "material",
      stopping: 4,
      qualities: ["meteorite"],
      encumbranceMod: 0,
      wt: 2, cost: 460, av: "R",
      description: "<p>Meteorite-alloy plating. +4 SP and adds the Meteorite effect: meteorite-susceptible monsters are staggered when striking this piece or grappling its wearer; on arms or legs, brawling strikes from that limb gain Meteorite. (Optional rule: if Monsters In The Novels is disabled, instead functions like Iron Plate but with +6 SP.)</p>" },

    { name: "Dimeritium", subType: "armor", category: "material",
      stopping: 3,
      qualities: ["dimeritium"],
      // uncertain: "dimeritium" quality key — using it as the canonical
      //            tag; the system may key it differently. Vigor / magic-
      //            user effects are descriptive only (not in this schema).
      encumbranceMod: 0,
      wt: 2, cost: 864, av: "R",
      description: "<p>Mahakaman-dimeritium plating. +3 SP. Grants a cumulative armor bonus to Resist Magic. Each unit reduces all Vigor scores within 10m by 2. Any magic user is affected as if touching dimeritium while the wearer is in armor, and the wearer's brawling/unarmed strikes (if applied to the appropriate limb) affect magic users as if dimeritium-touched.</p>" },

    /* ── Other Armor Improvements / Decorations (4) ───────────── */

    { name: "Beast Motif", subType: "armor", category: "decoration",
      stopping: 0,
      encumbranceMod: 0,
      wt: 0.5, cost: 69, av: "C",
      description: "<p>Decorative beast trim (taxidermied bones/hides). Applies a cumulative bonus to Intimidate. Does not consume an enhancement slot.</p>" },

    { name: "Bluing/Enamelling", subType: "armor", category: "decoration",
      stopping: 0,
      encumbranceMod: 0,
      wt: 0, cost: 118, av: "P",
      description: "<p>Bluing, tempering, or enamelled finish. Applies a cumulative bonus to Grooming & Style. Does not consume an enhancement slot.</p>" },

    { name: "Gilding", subType: "armor", category: "decoration",
      stopping: 0,
      encumbranceMod: 0,
      wt: 0.1, cost: 129, av: "R",
      description: "<p>Gold leaf or inlay. Applies a cumulative armor bonus to Reputation (does not increase a Reputation of 0). Does not consume an enhancement slot.</p>" },

    { name: "Officer's Wings", subType: "armor", category: "decoration",
      stopping: 0,
      encumbranceMod: 0,
      wt: 0.2, cost: 143, av: "R",
      description: "<p>Imperial officer's winged crest. Helmets only. Grants +1 to Leadership when commanding Imperial soldiers. Does not consume an enhancement slot.</p>" }
];

/* ── Item builders ──────────────────────────────────────────────── */

function aeSlotsFrom(input) {
    /* Accepts an object map OR a number (spreads across primary covered slots). */
    if (typeof input === "object" && input !== null) {
        return {
            head:     Number(input.head)     || 0,
            torso:    Number(input.torso)    || 0,
            leftArm:  Number(input.leftArm)  || 0,
            rightArm: Number(input.rightArm) || 0,
            leftLeg:  Number(input.leftLeg)  || 0,
            rightLeg: Number(input.rightLeg) || 0
        };
    }
    return { head: 0, torso: 0, leftArm: 0, rightArm: 0, leftLeg: 0, rightLeg: 0 };
}

function damageTypesFor(code) {
    const { types, nonLethal } = parseDamageType(code);
    return { types, nonLethal };
}

function buildArmorJSON(a, sort) {
    const cv = COVER[a.cover];
    if (!cv) {
        INCONSISTENCIES.push(`Unknown armor cover code "${a.cover}" for "${a.name}"`);
        return null;
    }
    const stopping = { ...ZERO_STOPPING };
    for (const loc of cv.slots) {
        stopping[`${loc}Stopping`]    = a.sp;
        stopping[`${loc}MaxStopping`] = a.sp;
    }
    const resist = parseResist(a.resist);
    const aeSlots = aeSlotsFrom(a.ae);
    return {
        _id: makeId(a.name, "armor"),
        name: a.name,
        type: "armor",
        img: armorIconFor(a),
        system: {
            description: a.description ?? "",
            weight: a.wt ?? 0,
            quantity: 1,
            cost: a.cost ?? 0,
            availability: AVAIL[a.av] ?? "common",
            armorType: a.type ?? "light",
            location: cv.location,
            encumbranceValue: a.ev ?? 0,
            armorEnhancement: 0,
            ...stopping,
            ...resist,
            reliability: { value: 0, max: 0 },
            qualities: a.qualities ?? [],
            qualityValues: a.qualityValues ?? {},
            appliedEnhancements: [],
            aeSlots,
            enhancementSlots: a.en ?? 0,
            armingJackKind: a.jack ?? "none",
            armoredArmingJackUpgrade: a.upgrade ?? "none",
            difficult: !!a.difficult,
            effects: ""
        },
        effects: [],
        folder: null, sort, ownership: { default: 0 }, flags: {}
    };
}

/* Map source `ammoType` field to schema's ammoType + the requiresAmmo flag.
 * Source values are richer (ballista, stone, thrown) than the schema, which
 * only knows arrow/bolt/slingBullet/siege; collapse ballista→bolt and
 * stone→siege. Throwing weapons are their own ammo (requiresAmmo:false).
 * Slings without an explicit ammoType default to slingBullet so they don't
 * accidentally accept arrows. */
function ammoFieldsForWeapon(w) {
    const raw = w.ammoType;
    /* Categories that don't load external ammo. */
    if (raw === "thrown" || w.category === "thrown" || w.category === "brawling"
        || raw == null && (w.category === "swordsmanship" || w.category === "smallBlades"
                          || w.category === "melee" || w.category === "staffSpear")) {
        return { requiresAmmo: false };
    }
    const ammoType = raw === "bolt"        ? "bolt"
                    : raw === "ballista"   ? "bolt"
                    : raw === "stone"      ? "siege"
                    : raw === "arrow"      ? "arrow"
                    : w.category === "sling"     ? "slingBullet"
                    : w.category === "crossbow"  ? "bolt"
                    : w.category === "artillery" ? "siege"
                    : w.category === "bow"       ? "arrow"
                    : raw ?? "arrow";
    return { requiresAmmo: true, ammoType };
}

function buildWeaponJSON(w, sort) {
    const { types, nonLethal } = damageTypesFor(w.dmgType);
    const ammoFields = ammoFieldsForWeapon(w);
    const qs = w.qualities ?? [];
    /* skillKey    = the weapon's attack skill. For melee weapons this is
     *               the swing/stab skill. For ranged weapons it's the
     *               shooting skill (archery, crossbow, artillery).
     * weaponType:
     *     "ranged"  bows / crossbows / slings / artillery
     *     "melee"   everything else. Throwability is derived from the
     *               `range` field — a melee weapon with a Range value
     *               can be thrown, and the throw always rolls Athletics
     *               (hard-coded in the strike table). The legacy
     *               "thrown" weaponType was collapsed into "melee with
     *               a range"; see tools/migrate-thrown-to-melee.mjs.
     * meleeSkillKey — schema keeps this field for legacy validation but
     *               it's no longer read. Emitting empty. */
    const skillKey = w.skill ?? "";
    const weaponType = (w.category === "bow" || w.category === "crossbow"
                     || w.category === "sling" || w.category === "artillery")
        ? "ranged"
        : "melee";
    const meleeSkillKey = "";
    return {
        _id: makeId(w.name, "weapon"),
        name: w.name,
        type: "weapon",
        img: weaponIconFor(w),
        system: {
            description: w.description ?? "",
            weight: w.wt ?? 0,
            quantity: 1,
            cost: w.cost ?? 0,
            availability: AVAIL[w.av] ?? "common",
            accuracy: w.wa ?? 0,
            damage: w.dmg ?? "",
            damageTypes: types,
            range: w.range ?? "",
            reliability: { value: w.rel ?? 0, max: w.rel ?? 0 },
            weaponEnhancement: w.en ?? 0,
            conceal: w.conceal ?? "L",
            hands: w.hands ?? "one",
            slot: w.hands === "two" ? "right" : "right",
            quick: !!w.quick,
            qualities: qs,
            qualityValues: w.qualityValues ?? {},
            appliedEnhancements: [],
            skillKey,
            meleeSkillKey,
            weaponType,
            ...ammoFields,
            damageProperties: {
                nonLethal,
                deniesParry: qs.includes("hefty")
            }
        },
        effects: [],
        folder: null, sort, ownership: { default: 0 }, flags: {}
    };
}

function buildShieldJSON(s, sort) {
    return {
        _id: makeId(s.name, "shield"),
        name: s.name,
        type: "shield",
        img: shieldIconFor(s),
        system: {
            description: s.description ?? "",
            weight: s.wt ?? 0,
            quantity: 1,
            cost: s.cost ?? 0,
            availability: AVAIL[s.av] ?? "common",
            coverValue: s.cv ?? 0,
            reliability: { value: s.rel ?? 0, max: s.rel ?? 0 },
            bashDamage: s.bash ?? "",
            encumbranceValue: s.ev ?? 0,
            armorEnhancement: s.en ?? 0,
            qualities: s.qualities ?? [],
            qualityValues: s.qualityValues ?? {},
            appliedEnhancements: [],
            hands: "one",
            slot: "left",
            location: "Shield"
        },
        effects: [],
        folder: null, sort, ownership: { default: 0 }, flags: {}
    };
}

function buildAmmoJSON(a, sort) {
    const { types } = damageTypesFor(a.dmgType || "P");
    /* Map subtype → schema's ammoType. AMMO_TYPES now defines four classes
     * (arrow / bolt / slingBullet / siege) so each EO subtype routes to its
     * proper class — sling bullets aren't loadable into bows, siege rounds
     * aren't loadable into crossbows.
     *   bolt + ballista → bolt   (crossbows & scorpios share the bolt
     *                              ammoType; ballista bolts are scorpio
     *                              artillery rounds tagged as bolts so
     *                              the existing crossbow→bolt match holds)
     *   slingBullet     → slingBullet
     *   stone           → siege  (catapult / mangonel / trebuchet rounds)
     *   default         → arrow */
    const ammoType = (a.subtype === "bolt" || a.subtype === "ballista") ? "bolt"
                    : a.subtype === "slingBullet" ? "slingBullet"
                    : a.subtype === "stone"       ? "siege"
                    : "arrow";
    return {
        _id: makeId(a.name, "ammo"),
        name: a.name,
        type: "ammo",
        img: ammoIconFor(a),
        system: {
            description: a.description ?? "",
            weight: a.wt ?? 0.05,
            quantity: 1,
            cost: a.cost ?? 0,
            availability: AVAIL[a.av] ?? "common",
            ammoType,
            damageTypes: types,
            qualities: a.qualities ?? [],
            qualityValues: a.qualityValues ?? {},
            conceal: "N/A",
            effects: ""
        },
        effects: [],
        folder: null, sort, ownership: { default: 0 }, flags: {}
    };
}

function buildEnhancementJSON(e, sort) {
    return {
        _id: makeId(e.name, "enhancement"),
        name: e.name,
        type: "enhancement",
        img: enhancementIconFor(e),
        system: {
            description: e.description ?? "",
            weight: 0,
            quantity: 1,
            cost: e.cost ?? 0,
            availability: AVAIL[e.av] ?? "common",
            type: e.subType,
            target: "armor",
            applied: false,
            slotCost: 1,
            attachedTo: "",
            accuracyBonus: 0,
            reliabilityBonus: 0,
            damageBonus: "",
            addedDamageTypes: [],
            stopping:       e.stopping       ?? 0,
            slashing:       !!e.slashing,
            piercing:       !!e.piercing,
            bludgeoning:    !!e.bludgeoning,
            encumbranceMod: e.encumbranceMod ?? 0,
            grantedQualities: e.qualities ?? [],
            qualityValues: {},
            effects: ""
        },
        effects: [],
        folder: null, sort, ownership: { default: 0 }, flags: {}
    };
}

/* Diagram for a given item (output linked by UUID). Name is just the
 * output item name — the "Diagram: " prefix the early generator used was
 * redundant since the item type is already "diagrams". The id-seed keeps
 * the prefix so existing world links by _id remain stable. */
function buildDiagramJSON(outputItem, kind, sort) {
    const outputUuid = `Compendium.witcher-ttrpg-death-march.eo-${kind}.Item.${outputItem._id}`;
    return {
        _id: makeId(`Diagram: ${outputItem.name}`, "diagram"),
        name: outputItem.name,
        type: "diagrams",
        img: "icons/sundries/scrolls/scroll-rolled-tan.webp",
        system: {
            description: `<p>Crafting blueprint for ${outputItem.name}.</p>`,
            weight: 0.1, quantity: 1,
            cost: Math.max(1, Math.floor((outputItem.system.cost ?? 0) * 0.5)),
            availability: outputItem.system.availability ?? "common",
            kind: "diagram",
            level: "novice",
            type: outputItem.type === "weapon" ? "weapon" : (outputItem.type === "armor" ? "armor" : "weapon"),
            alchemyDC: 0,
            craftingDC: 14,
            requiresForge: false,
            investment: Math.max(1, Math.floor((outputItem.system.cost ?? 0) * 0.45)),
            learned: false,
            craftingTime: "6 Hour",
            craftingComponents: [],   /* component links — populated by a later pass */
            alchemyComponents: {},
            associatedItem: {
                name: outputItem.name,
                uuid: outputUuid,
                img:  outputItem.img
            },
            outputEnhanced:  "",
            outputSuperior:  "",
            potencyNormal:   0,
            potencyEnhanced: 0,
            potencySuperior: 0,
            memorizedFrom: ""
        },
        effects: [],
        folder: null, sort, ownership: { default: 0 }, flags: {}
    };
}

/* ── Origin / category classifiers (derive folder hierarchy from item name) ─ */

/* Map a name prefix to an origin bucket. Order matters — first match wins.
 * Names are checked against the START of the item's display name. */
const ORIGIN_PATTERNS = [
    /* Arming Suits = the two dedicated jack/suit items only. Aketon Doublet /
     * Trousers / Coif and Cold Weather Clothing are BASIC light armor pieces
     * by default — they can pay the +100c/+750c EO p.4 upgrade to function
     * as a jack, but the compendium item ships in its base form so they live
     * with the other Aketons in Basic light armor. */
    { origin: "Arming Suits",  re: /^(Arming Jack|Superior Arming Suit)\b/i },
    { origin: "Witcher Kit",   re: /^(Witcher (Steel|Silver)|Silver Knuckles|Feline|Wolven|Gryphon|Manticore|Ursine|Serpentine|Viper Fang|Ballock)\b/i },
    /* Elderfolk includes Cheval (elven knightly), Dwarven (mahakaman),
     * Gnomish, Scoia'tael, Elven racial — plus the Wyvern Scale Shield
     * + Silver/Meteorite Bullets which the EO PDF places in the
     * Elderfolk armory rather than the basic / artisan tables. */
    { origin: "Elderfolk",     re: /^(Mahakaman|Gwyhyr|Elven|Eldercraft|Protective Doublet|Gnomish|Scoia|Cheval|Dwarven|Wyvern Scale|Vrihedd|Tir Tochair|Meteorite Flail|Silver Hatchet|Silver Bullet|Meteorite Bullet|Werebubb|Halfling Weighted|Monster Catcher|Brokilon|Golem Smasher|Monster Hunter)\b/i },
    /* Exotic = Ofieri / Zerrikan / Haakish sphere. Add Bone-Tipped
     * (exotic ammo) + Haakish (exotic ammo) which were originally
     * mis-classified as Basic by the audit. */
    { origin: "Exotic",        re: /^(Bagh Nakh|Jambiya|Katar\b|Kris\b|Szabla|Shafra|Talvara|Pata\b|Sa'if|Shamshir|Kilij|Kurra|Shishpar|Tabarzin|Tabar\b|Aršti|Tzad|Ofieri|Kontosa|Chakram|Jarid|Kaman|Mori Num|Zerrikanian|Höl Num|Steppe Warrior|Drake Leather|Biraq|Fāris|Katafrakt|Anusyia|Bambai|Derah|Spara|Bone-Tipped|Haakish)\b/i },
    { origin: "Viroledan",     re: /^(Stiletto|Sinestro|Esboda|Terganian|Estoc|Viroledan|Vicovarian|Torrwr|Flamberge|Martello|Ascia|Hache de Guerre|Pilum|Spontoon|Mancatcher|Partisan|Valenkosa|Iron Staff|Black Army|Markee|Pacifier|Nilfgaardian|Ducal Knight|Heavy Bullet|Incendiary Bullet|Orion|Etolian|Markee Howler|Black Army Bodkin)\b/i },
    { origin: "Northern",      re: /^(Verden|Special Forces|Lyrian|Tretagor|Hindarsfjall|Kaedweni|Temerian|Drakeskin|Bone Bow|Koviri|Krigssverd|Kord\b|Dopplehander|Berserkax|Highland Mauler|Vingespyd|Crystal Staff|Military Fork|Redanian Halberd|Francisca|Lamia|Jogar|Skeggax|Martel à Bec|Doryo|Poniard|Rondel Dagger|Sword Catcher|Whistling Bullet|Dimeritium Bullet|Rivian Needle|Temerian Sheaf)\b/i }
];
function originFor(name) {
    for (const p of ORIGIN_PATTERNS) if (p.re.test(name)) return p.origin;
    return "Basic";
}

/* For weapons, infer the skill bucket from `category` field (already set
 * on each entry in WEAPONS/RANGED). Maps to display labels. */
const SKILL_LABEL = {
    swordsmanship: "Swordsmanship",
    melee:         "Melee (axe / hammer / club)",
    staffSpear:    "Staff & Spear",
    smallBlades:   "Small Blades",
    brawling:      "Brawling",
    bow:           "Bows",
    crossbow:      "Crossbows",
    sling:         "Slings",
    thrown:        "Thrown",
    /* Artillery (EO p.13–15): Scorpio, Siege Scorpion, Ballista,
     * Mangonel, Trebuchet. Distinct skill bucket so siege engines
     * don't clutter the Crossbow / Basic-Melee folders. */
    artillery:     "Artillery"
};

/* For armor, group by armorType (light/medium/heavy). */
const ARMOR_TYPE_LABEL = {
    light:  "Light Armor",
    medium: "Medium Armor",
    heavy:  "Heavy Armor"
};

/* ── Folder builders ─────────────────────────────────────────────── */

/* A Folder document (Foundry compendium folder). 16-char _id derived from
 * pack+path so re-runs are idempotent. */
function makeFolder(packName, name, parent = "", sort = 0) {
    const path = parent ? `${parent}/${name}` : name;
    return {
        _id: makeId(`${packName}::${path}`, "folder"),
        name,
        sorting: "a",
        folder: parent || null,
        description: "",
        color: null,
        sort,
        flags: {},
        type: "Item",
        /* `_filename` is a hint to the build script — not persisted to the
         * doc; build-packs strips it before writing to LevelDB. */
        _filename: `_folder_${slugify(path)}`
    };
}

/* ── Emit ───────────────────────────────────────────────────────── */

/* Drop folder docs that have zero items AND no descendant folder with items.
 * The generator pre-builds every origin × category combo upfront because
 * the item-assignment loop doesn't know the shape yet — this cull runs
 * after assignment to ship only folders that actually surface content. */
function cullEmptyFolders(items, folders) {
    const byId = new Map(folders.map(f => [f._id, f]));
    const directlyUsed = new Set();
    for (const it of items) {
        if (it?.folder) directlyUsed.add(it.folder);
    }
    /* Walk up parent chain — a sub-bucket folder counts its ancestors as
     * needed too, otherwise removing a mid-level "Armor" parent would
     * orphan its surviving "Light Armor" child. */
    const keep = new Set();
    const markChain = (id) => {
        let cur = id;
        while (cur && byId.has(cur) && !keep.has(cur)) {
            keep.add(cur);
            cur = byId.get(cur).folder || null;
        }
    };
    for (const id of directlyUsed) markChain(id);
    return folders.filter(f => keep.has(f._id));
}

function emit(packName, items, folders = []) {
    const dir = join(SRC, packName);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const culled = cullEmptyFolders(items, folders);
    let n = 0;
    for (const f of culled) {
        if (!f) continue;
        const fn = f._filename ?? `_folder_${f._id}`;
        const { _filename: _, ...persisted } = f;
        writeFileSync(join(dir, `${fn}.json`), JSON.stringify(persisted, null, 2));
    }
    for (const item of items) {
        if (!item) continue;
        const slug = slugify(item.name);
        writeFileSync(join(dir, `${slug}.json`), JSON.stringify(item, null, 2));
        n++;
    }
    console.log(`  ${packName}: ${n} item(s), ${culled.length}/${folders.length} folder(s)`);
}

/* ── Build raw item lists, tagging each with origin + classifier ── */

const armorItems = ARMOR.map((a, i) => buildArmorJSON(a, (i + 1) * 100));
const weaponItems = [...WEAPONS, ...RANGED].map((w, i) => buildWeaponJSON(w, (i + 1) * 100));
const shieldItems = SHIELDS.map((s, i) => buildShieldJSON(s, (i + 1) * 100));
const ammoItems = AMMUNITION.map((a, i) => buildAmmoJSON(a, (i + 1) * 100));
const enhanceItems = ARMOR_ENHANCEMENTS.map((e, i) => buildEnhancementJSON(e, (i + 1) * 100));

/* Memo classifiers on each item so the diagram emit can reuse them. */
for (const it of armorItems) {
    it._origin   = originFor(it.name);
    it._weight   = it.system.armorType;
}
for (const it of shieldItems) {
    it._origin   = originFor(it.name);
}
for (const it of weaponItems) {
    it._origin   = originFor(it.name);
    /* Find the matching source spec (WEAPONS/RANGED) to get category. */
    const src = [...WEAPONS, ...RANGED].find(w => w.name === it.name);
    it._category = src?.category ?? "melee";
}
for (const it of ammoItems) {
    it._origin   = originFor(it.name);
    /* Walk the source AMMUNITION array to recover the EO subtype — kept off
     * the persisted item but used for folder bucketing so visually similar
     * categories (artillery bolts vs crossbow bolts) sit in their own folder
     * even though they share the same ammoType. */
    const src = AMMUNITION.find(a => a.name === it.name);
    it._subtype = src?.subtype ?? "arrow";
}

/* ── eo-armor pack: armor pieces + shields, organized into folders ─── */
{
    const folders = [];
    /* Top-level: Armor / Shields / Arming Suits */
    const fArmor   = makeFolder("eo-armor", "Armor",         "", 100); folders.push(fArmor);
    const fShields = makeFolder("eo-armor", "Shields",       "", 200); folders.push(fShields);
    const fSuits   = makeFolder("eo-armor", "Arming Suits",  "", 300); folders.push(fSuits);

    /* Armor sub-folders: per origin, per weight. */
    const ORIGIN_ORDER = ["Basic", "Northern", "Viroledan", "Exotic", "Elderfolk", "Witcher Kit"];
    const WEIGHT_ORDER = ["light", "medium", "heavy"];
    const armorOriginFolders = {};
    const armorBucketFolders = {};
    let sortIdx = 100;
    for (const o of ORIGIN_ORDER) {
        const of_ = makeFolder("eo-armor", o, fArmor._id, sortIdx); sortIdx += 100;
        folders.push(of_);
        armorOriginFolders[o] = of_;
        let ws = 100;
        for (const w of WEIGHT_ORDER) {
            const wf = makeFolder("eo-armor", ARMOR_TYPE_LABEL[w], of_._id, ws); ws += 100;
            folders.push(wf);
            armorBucketFolders[`${o}/${w}`] = wf;
        }
    }
    /* Shield sub-folders: per origin. */
    const shieldOriginFolders = {};
    sortIdx = 100;
    for (const o of ORIGIN_ORDER) {
        const sf = makeFolder("eo-armor", o, fShields._id, sortIdx); sortIdx += 100;
        folders.push(sf);
        shieldOriginFolders[o] = sf;
    }

    /* Assign folders to items. Arming-suit items (jack/superior + aketon
     * pieces flagged with armingJackKind upgrade) land in the Arming Suits
     * folder. Everything else goes by origin/weight. */
    for (const it of armorItems) {
        if (it._origin === "Arming Suits") {
            it.folder = fSuits._id;
            continue;
        }
        const key = `${it._origin}/${it._weight}`;
        it.folder = (armorBucketFolders[key] ?? armorOriginFolders[it._origin] ?? fArmor)._id;
    }
    for (const it of shieldItems) {
        it.folder = (shieldOriginFolders[it._origin] ?? fShields)._id;
    }

    emit("eo-armor", [...armorItems, ...shieldItems], folders);
}

/* ── eo-weapons pack: weapons + ammunition, organized into folders ─── */
{
    const folders = [];
    const fWeapons = makeFolder("eo-weapons", "Weapons",     "", 100); folders.push(fWeapons);
    const fAmmo    = makeFolder("eo-weapons", "Ammunition",  "", 200); folders.push(fAmmo);

    const ORIGIN_ORDER = ["Basic", "Northern", "Viroledan", "Exotic", "Elderfolk", "Witcher Kit"];
    const SKILL_ORDER  = ["swordsmanship", "smallBlades", "melee", "staffSpear", "brawling", "bow", "crossbow", "thrown", "sling"];

    const weaponOriginFolders = {};
    const weaponSkillFolders  = {};
    let sortIdx = 100;
    for (const o of ORIGIN_ORDER) {
        const of_ = makeFolder("eo-weapons", o, fWeapons._id, sortIdx); sortIdx += 100;
        folders.push(of_);
        weaponOriginFolders[o] = of_;
        let ws = 100;
        for (const s of SKILL_ORDER) {
            const sf = makeFolder("eo-weapons", SKILL_LABEL[s], of_._id, ws); ws += 100;
            folders.push(sf);
            weaponSkillFolders[`${o}/${s}`] = sf;
        }
    }
    /* Ammo: split first by AMMO TYPE (Arrows / Bolts / Sling Bullets)
     * since each type is loaded into a different weapon class, then by
     * origin within each type. */
    const AMMO_TYPE_LABEL = {
        arrow:        "Arrows",
        bolt:         "Bolts",
        slingBullet:  "Sling Bullets",
        /* Artillery munitions get their own bucket. EO p.13–15 lists
         * Standard / Breaker / Piercer / Flaming Bolt, Stone, Stone
         * Shot Grenade, Ballista Bolt, Clay Fire Pot, Zerrikanian
         * Fire, Carcass. Without these buckets they fall back to the
         * top-level Ammunition root (loose, no subfolder). */
        ballista:     "Artillery Bolts",
        stone:        "Stones & Munitions"
    };
    const AMMO_TYPE_ORDER = ["arrow", "bolt", "slingBullet", "ballista", "stone"];
    const ammoTypeFolders   = {};
    const ammoBucketFolders = {};
    sortIdx = 100;
    for (const t of AMMO_TYPE_ORDER) {
        const tf = makeFolder("eo-weapons", AMMO_TYPE_LABEL[t], fAmmo._id, sortIdx); sortIdx += 100;
        folders.push(tf);
        ammoTypeFolders[t] = tf;
        let os = 100;
        for (const o of ORIGIN_ORDER) {
            const of_ = makeFolder("eo-weapons", o, tf._id, os); os += 100;
            folders.push(of_);
            ammoBucketFolders[`${t}/${o}`] = of_;
        }
    }

    for (const it of weaponItems) {
        const key = `${it._origin}/${it._category}`;
        it.folder = (weaponSkillFolders[key] ?? weaponOriginFolders[it._origin] ?? fWeapons)._id;
    }
    for (const it of ammoItems) {
        /* Folder bucketing uses the EO subtype (arrow / bolt / slingBullet /
         * ballista / stone) — separates artillery bolts from regular crossbow
         * bolts even though both share `bolt` ammoType. */
        const t = it._subtype ?? it.system?.ammoType ?? "arrow";
        const key = `${t}/${it._origin}`;
        it.folder = (ammoBucketFolders[key] ?? ammoTypeFolders[t] ?? fAmmo)._id;
    }

    emit("eo-weapons", [...weaponItems, ...ammoItems], folders);
}

/* ── eo-armor-enhancements: split by subType (glyph vs armor mod) +
 *    secondary split between EO material enhancements and decorative
 *    improvements (Beast Motif, Bluing/Enamelling, Gilding, Officer's
 *    Wings — EO p.16). The decorative names live in DECORATIVE_NAMES
 *    so the bucketing is data-driven rather than a regex on the
 *    description. */
{
    const folders = [];
    const fGlyphs       = makeFolder("eo-armor-enhancements", "Glyphs",        "", 100); folders.push(fGlyphs);
    const fMaterials    = makeFolder("eo-armor-enhancements", "Material Mods", "", 200); folders.push(fMaterials);
    const fDecorative   = makeFolder("eo-armor-enhancements", "Decorative",    "", 300); folders.push(fDecorative);
    const DECORATIVE_NAMES = new Set([
        "Beast Motif", "Bluing/Enamelling", "Gilding", "Officer's Wings"
    ]);
    for (const it of enhanceItems) {
        if (it.system.type === "glyph") it.folder = fGlyphs._id;
        else if (DECORATIVE_NAMES.has(it.name)) it.folder = fDecorative._id;
        else it.folder = fMaterials._id;
    }
    emit("eo-armor-enhancements", enhanceItems, folders);
}

/* ── eo-diagrams: mirror the structure of the source items' pack ─── */
{
    const folders = [];
    /* Top-level mirrors: Armor diagrams / Shields diagrams / Weapons / Ammunition / Enhancements. */
    const fArmDia  = makeFolder("eo-diagrams", "Armor Diagrams",         "", 100); folders.push(fArmDia);
    const fShDia   = makeFolder("eo-diagrams", "Shield Diagrams",        "", 200); folders.push(fShDia);
    const fWeapDia = makeFolder("eo-diagrams", "Weapon Diagrams",        "", 300); folders.push(fWeapDia);
    const fAmmoDia = makeFolder("eo-diagrams", "Ammunition Diagrams",    "", 400); folders.push(fAmmoDia);
    const fEnhDia  = makeFolder("eo-diagrams", "Enhancement Diagrams",   "", 500); folders.push(fEnhDia);

    const ORIGIN_ORDER = ["Basic", "Northern", "Viroledan", "Exotic", "Elderfolk", "Witcher Kit"];
    const armorDiaOriginF = {}, shieldDiaOriginF = {}, weaponDiaOriginF = {};
    let sortIdx = 100;
    for (const o of ORIGIN_ORDER) {
        armorDiaOriginF[o]  = makeFolder("eo-diagrams", o, fArmDia._id,  sortIdx); folders.push(armorDiaOriginF[o]);
        shieldDiaOriginF[o] = makeFolder("eo-diagrams", o, fShDia._id,   sortIdx); folders.push(shieldDiaOriginF[o]);
        weaponDiaOriginF[o] = makeFolder("eo-diagrams", o, fWeapDia._id, sortIdx); folders.push(weaponDiaOriginF[o]);
        sortIdx += 100;
    }
    /* Ammunition Diagrams: mirror the item-pack's Type → Origin split. */
    const AMMO_TYPE_LABEL_DIA = { arrow: "Arrows", bolt: "Bolts", slingBullet: "Sling Bullets", ballista: "Artillery Bolts", stone: "Stones & Munitions" };
    const AMMO_TYPE_ORDER_DIA = ["arrow", "bolt", "slingBullet"];
    const ammoDiaBucketF = {};
    sortIdx = 100;
    for (const t of AMMO_TYPE_ORDER_DIA) {
        const tf = makeFolder("eo-diagrams", AMMO_TYPE_LABEL_DIA[t], fAmmoDia._id, sortIdx); sortIdx += 100;
        folders.push(tf);
        let os = 100;
        for (const o of ORIGIN_ORDER) {
            const of_ = makeFolder("eo-diagrams", o, tf._id, os); os += 100;
            folders.push(of_);
            ammoDiaBucketF[`${t}/${o}`] = of_;
        }
    }

    const diagramItems = [];
    let dsort = 100;
    for (const it of armorItems)   { const d = buildDiagramJSON(it, "armor",   dsort); d.folder = (armorDiaOriginF[it._origin]  ?? fArmDia)._id;  diagramItems.push(d); dsort += 100; }
    for (const it of shieldItems)  { const d = buildDiagramJSON(it, "armor",   dsort); d.folder = (shieldDiaOriginF[it._origin] ?? fShDia)._id;   diagramItems.push(d); dsort += 100; }
    for (const it of weaponItems)  { const d = buildDiagramJSON(it, "weapons", dsort); d.folder = (weaponDiaOriginF[it._origin] ?? fWeapDia)._id; diagramItems.push(d); dsort += 100; }
    for (const it of ammoItems)    {
        const d = buildDiagramJSON(it, "weapons", dsort);
        const t = it._subtype ?? it.system?.ammoType ?? "arrow";
        d.folder = (ammoDiaBucketF[`${t}/${it._origin}`] ?? fAmmoDia)._id;
        diagramItems.push(d); dsort += 100;
    }
    for (const it of enhanceItems) { const d = buildDiagramJSON(it, "armor-enhancements", dsort); d.folder = fEnhDia._id; diagramItems.push(d); dsort += 100; }

    emit("eo-diagrams", diagramItems, folders);
}

/* Strip transient classifier fields from items (they're for build-time
 * only). Already done — these keys (_origin/_weight/_category) live on
 * the runtime object before emit(), but emit's JSON.stringify will
 * persist them. Strip via a post-walk. */
for (const dir of ["eo-armor", "eo-weapons"]) {
    const dpath = join(SRC, dir);
    if (!existsSync(dpath)) continue;
    for (const f of readdirSync(dpath)) {
        if (!f.endsWith(".json") || f.startsWith("_folder_")) continue;
        const p = join(dpath, f);
        const j = JSON.parse(readFileSync(p, "utf8"));
        delete j._origin; delete j._weight; delete j._category;
        writeFileSync(p, JSON.stringify(j, null, 2));
    }
}

console.log("\nDone.");
if (INCONSISTENCIES.length) {
    console.log(`\nInconsistencies (${INCONSISTENCIES.length}):`);
    for (const note of INCONSISTENCIES) console.log(`  - ${note}`);
} else {
    console.log("\nNo inconsistencies detected during emit.");
}
