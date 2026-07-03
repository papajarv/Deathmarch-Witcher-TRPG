/**
 * gen-eo-components.mjs — emits the EO crafting-component pack as
 * packs-src/eo-components/*.json.
 *
 * EO p.37 "New Components" introduces several materials that EO's
 * crafting recipes reference but the Core "Crafting Components" table
 * doesn't include (Biraq Steel, Horn, Sinews, Sapphire Dust, Zerrikan
 * Steel, Ancient Timber). Plus we mint a handful of artisan-tier
 * materials that are widely referenced in the EO crafting tables
 * (Tretagor Steel, Dark Steel, Mahakaman Steel, Ogre Wax, Drake Oil,
 * Darkening Oil, Etching Acid, Ester Grease, Lyrian Leather, Drake
 * Scale, Hardened Timber, Hardened Leather, Sharpening Grit,
 * Darkening Oil) — these were assumed to exist in the Core compendium
 * but weren't, so the linker couldn't resolve them.
 *
 * IDs are stable 16-char hex derived from name+kind so re-runs produce
 * the same _id.
 */

import { writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC  = join(ROOT, "packs-src/eo-components");

const AVAIL = { E: "everywhere", C: "common", P: "poor", R: "rare" };

function makeId(name) {
    const h = createHash("md5").update(`component:${name}`).digest("hex");
    return h.slice(0, 16);
}

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

/* EO components catalog. Each entry:
 *   name, weight, cost, av, [forage], [forageDC], [forageQuantity],
 *   [potency], description
 *
 * Potency (0-10) feeds the Alchemy Reborn crafting wheel (alchemy.mjs):
 * sum of ingredient potencies tiers the output Normal / Enhanced / Superior.
 * Calibration ladder (rough):
 *   1-2  Everywhere/common raw materials      (Timber, Iron, Thread, Cotton, …)
 *   3-4  Worked uncommons / artisan inputs    (Steel, Bronze, Mahakaman Steel, …)
 *   5-6  Rare specials                        (Dark Steel, Tretagor, Biraq, Zerrikan)
 *   7-8  Very-rare imports                    (Meteorite, Dimeritium, Draconid Leather, Ogre Wax)
 *   9-10 Legendary / arcane reagents          (Sapphire Dust, Magic Dust, Fifth Essence)
 * The availability code (E/C/P/R) and cost are the tiebreakers — a rare
 * but mundane item (Lead, Gemstone) sits lower than a rare arcane reagent
 * (Sapphire Dust). */
/* Only NEW components live here — anything also in the Core `crafting`
 * pack is intentionally absent so EO recipes link to the Core item
 * instead of a duplicate. The linker (tools/link-eo-diagrams.mjs) walks
 * Core packs FIRST and only falls back to eo-components for items that
 * are genuinely EO-original.
 *
 * Items removed because they live in Core:
 *   Beast Bones, Coal, Cotton, Dark Steel, Darkening Oil, Dimeritium,
 *   Double Woven Linen, Draconid Leather, Drake Oil, Emerald Dust, Ester
 *   Grease, Etching Acid, Feathers, Fifth Essence, Gemstone, Glass,
 *   Hardened Leather, Hardened Timber, Iron, Leather, Light Essence,
 *   Linen, Lyrian Leather, Mahakaman Steel, Meteorite, Ogre Wax, Oil,
 *   Resin, River Clay, Ruby Dust, Sharpening Grit, Silk, Silver, Steel,
 *   Stone, Thread, Timber, Wax. */
const COMPONENTS = [
    /* — EO p.37 "New Components" — */
    { name: "Ancient Timber",  wt: 1,   cost: 200, av: "R", potency: 7, forage: "Brokilon and other primeval forests", forageDC: 14, forageQuantity: "1d6",
      description: "<p>Hardened timber from primeval forests — the only material that holds enchantment without burning.</p>" },
    { name: "Biraq Steel",     wt: 1,   cost: 96,  av: "R", potency: 5, forage: "Must be bought or crafted.", forageDC: 0, forageQuantity: "N/A",
      description: "<p>Distinctively-patterned steel forged with the Biraq tradition.</p>" },
    { name: "Horn",            wt: 0.5, cost: 35,  av: "C", potency: 2, forage: "Harvested from goats, rams, or cattle.", forageDC: 0, forageQuantity: "1d6/2",
      description: "<p>Animal horn. Used in fletching and as a bow nock.</p>" },
    { name: "Sapphire Dust",   wt: 0.1, cost: 104, av: "R", potency: 9, forage: "Mountains & Underground", forageDC: 22, forageQuantity: "1d6/2",
      description: "<p>Powdered sapphire — for inlay and the enchantment of armor.</p>" },
    { name: "Sinews",          wt: 0.5, cost: 22,  av: "E", potency: 1, forage: "Must be bought or crafted.", forageDC: 0, forageQuantity: "N/A",
      description: "<p>Bound tendon strands — used for bow strings, lashings, and reinforcements.</p>" },
    { name: "Zerrikan Steel",  wt: 1,   cost: 88,  av: "R", potency: 5, forage: "Must be bought or crafted.", forageDC: 0, forageQuantity: "N/A",
      description: "<p>Folded Zerrikan steel.</p>" },

    /* — EO artisan-tier and other materials NOT in Core — */
    { name: "Diamond Dust",    wt: 0.1, cost: 120, av: "R", potency: 10, forage: "Mountains & Underground", forageDC: 24, forageQuantity: "1d6/2",
      description: "<p>Powdered diamond — for masterwork edge inlay and enchantment.</p>" },
    { name: "Drake Scale",     wt: 1,   cost: 278, av: "R", potency: 7,
      description: "<p>Layered drake-scale — fire-resistant armor material.</p>" },
    { name: "Lead",            wt: 1.5, cost: 40,  av: "C", potency: 2, forage: "Mountains & Underground", forageDC: 16, forageQuantity: "1d6",
      description: "<p>Lead ingot. Cast into sling bullets or used as ballast.</p>" },
    { name: "Rope",            wt: 0.5, cost: 10,  av: "E", potency: 1,
      description: "<p>Hemp rope. Climbing and binding material.</p>" },
    { name: "Tretagor Steel",  wt: 1,   cost: 120, av: "R", potency: 6,
      description: "<p>Tretagor-pattern refined steel — the chosen alloy for Tretagor knight kit.</p>" }
];

function buildJSON(c) {
    return {
        _id: makeId(c.name),
        name: c.name,
        type: "component",
        img: "icons/containers/bags/sack-cloth-brown.webp",
        system: {
            description: c.description ?? "",
            weight: c.wt ?? 0.1,
            quantity: 1,
            cost: c.cost ?? 0,
            availability: AVAIL[c.av] ?? "common",
            isSubstance: false,
            substanceType: "",
            substance: "",
            // Potency feeds the Alchemy Reborn crafting wheel — sum across
            // a recipe's ingredients tiers the output Normal/Enhanced/Superior.
            // Per-component values calibrated in COMPONENTS above.
            potency: c.potency ?? 0,
            forageLocation: c.forage ?? "",
            forageDC: c.forageDC ?? 0,
            forageQuantity: c.forageQuantity ?? ""
        },
        effects: [],
        folder: null,
        sort: 100,
        ownership: { default: 0 },
        flags: {}
    };
}

/* Folder bucketing. The audit found all 49 components at the pack root
 * with no folder structure — a GM looking for "Tretagor Steel" has to
 * scroll the whole flat list. Bucket by category so the browse is
 * scannable. Categories are derived heuristically from the canonical
 * Witcher TRPG component groupings (Core p.139-140 + EO p.37). */
const COMPONENT_CATEGORIES = {
    "Metals":   ["Iron","Steel","Silver","Lead","Mahakaman Steel","Tretagor Steel","Dark Steel","Biraq Steel","Zerrikan Steel","Meteorite","Dimeritium","Bronze"],
    "Hides & Cloth": ["Leather","Hardened Leather","Lyrian Leather","Draconid Leather","Drake Scale","Cotton","Linen","Double Woven Linen","Silk","Thread","Feathers","Sinews","Horn","Beast Bones"],
    "Timber & Resins": ["Timber","Hardened Timber","Ancient Timber","Resin","Coal","Wax","Oil","Rope","Ester Grease","Drake Oil","Darkening Oil","Etching Acid","River Clay","Stone","Glass","Ogre Wax","Sharpening Grit"],
    "Gems & Reagents": ["Gemstone","Sapphire Dust","Ruby Dust","Emerald Dust","Diamond Dust","Light Essence","Fifth Essence"]
};
function categoryFor(name) {
    for (const [cat, names] of Object.entries(COMPONENT_CATEGORIES)) {
        if (names.includes(name)) return cat;
    }
    return "Other";
}

function folderDoc(name, sort) {
    const idHash = createHash("md5").update(`folder:eo-components::${name}`).digest("hex");
    return {
        _id: idHash.slice(0, 16),
        name,
        type: "Item",
        folder: null,
        sorting: "a",
        color: null,
        sort,
        flags: {}
    };
}

if (existsSync(SRC)) rmSync(SRC, { recursive: true, force: true });
mkdirSync(SRC, { recursive: true });

/* Emit folder docs (one _folder_*.json per category). */
const folders = {};
let folderSort = 100;
for (const cat of Object.keys(COMPONENT_CATEGORIES).concat(["Other"])) {
    const f = folderDoc(cat, folderSort);
    folders[cat] = f;
    writeFileSync(join(SRC, `_folder_${slugify(cat)}.json`), JSON.stringify(f, null, 2));
    folderSort += 100;
}

for (const c of COMPONENTS) {
    const doc = buildJSON(c);
    /* Attach to the appropriate folder. */
    doc.folder = folders[categoryFor(c.name)]._id;
    writeFileSync(join(SRC, `${slugify(c.name)}.json`), JSON.stringify(doc, null, 2));
}
console.log(`Wrote ${COMPONENTS.length} EO crafting components to ${SRC} (in ${Object.keys(folders).length} folders)`);
