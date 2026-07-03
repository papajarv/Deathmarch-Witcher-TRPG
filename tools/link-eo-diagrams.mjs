/**
 * link-eo-diagrams.mjs — populates `craftingComponents` on every EO
 * diagram by parsing the PDF crafting tables in /tmp/eo-layout.txt and
 * looking up each component name in the existing system compendium
 * packs (packs/equipment, packs/generalGear, packs/crafting, etc.).
 *
 * Also fills the per-recipe DC, crafting time, and investment cost
 * with PDF-accurate values (replacing the placeholder defaults).
 *
 * Component lookup search order:
 *   1. packs/crafting (where Iron/Coal/Resin/Timber/Linen/etc live)
 *   2. packs/generalGear
 *   3. packs/equipment
 *   4. packs/witcherGear
 *   5. packs/alchemy
 *
 * Components that don't resolve get logged as inconsistencies.
 * Components on a diagram that DO resolve get added with the canonical
 * compendium-UUID so a player can drag the diagram and have its
 * required components show up correctly.
 *
 * Run: node tools/link-eo-diagrams.mjs
 *
 * Idempotent — re-runs replace prior linking.
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ClassicLevel } from "classic-level";

const ROOT     = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKS    = resolve(ROOT, "packs");
const SRC_DIA  = resolve(ROOT, "packs-src/eo-diagrams");
const EO_TEXT  = "/tmp/eo-layout.txt";

const SYSTEM_ID = "witcher-ttrpg-death-march";

const INCONSISTENCIES = [];
const noteIssue = (s) => INCONSISTENCIES.push(s);

/* ── PDF parsing ─────────────────────────────────────────────────── */

/* A diagram row in the PDF looks like:
 *   "Eating Knife     9    1 Hour     Coal ×1, Resin ×1, Timber ×1, Iron ×1     36     72"
 *
 * Columns: Item Name | DC | Time | Materials (comma-separated Comp ×N) | Investment | Price
 *
 * We parse by:
 *   - identifying section start lines that contain "(to Equipment)"
 *   - parsing each non-empty line in the section as a row
 *   - finding rows that match a known item name
 *
 * Some rows continue on the next line (optional "Options" variants).
 * We only capture the primary (first) row per item. */

const pdfText = readFileSync(EO_TEXT, "utf8");
const pdfLines = pdfText.split("\n");

/* Find every "(to Equipment)" or "(to Equipment Pt.1, Equipment Pt.2)"
 * section header. Some PDF section titles wrap into multi-part names
 * (Pt.1 / Pt.2) so we match the more permissive prefix `(to Equipment`. */
const sectionStarts = [];
for (let i = 0; i < pdfLines.length; i++) {
    if (/\(to Equipment\b/.test(pdfLines[i])) sectionStarts.push(i);
}
sectionStarts.push(pdfLines.length);   // sentinel for the last section's end

/* Map of itemName → { dc, time, components, investment, price }. */
const recipeMap = new Map();

/* Component-extraction regex. Each component is "Name ×N" or "Name (×N)";
 * we accept several Unicode-multiplication-sign variants. */
const COMP_RE = /([A-Za-z][A-Za-z &'’\-é]+?)\s*[×x]\s*(\d+)/g;
/* Detect a parenthetical (×N) form too. */
const COMP_RE_PAREN = /([A-Za-z][A-Za-z &'’\-é]+?)\s*\(\s*[×x]\s*(\d+)\s*\)/g;

function parseRow(line) {
    const s = line.trimEnd();
    if (!s) return null;
    /* Skip header / footnote lines. */
    if (/^\s*(Item Name|Materials|Novice Diagrams|Journeyman Diagrams|Master Diagrams|Grandmaster Diagrams|Pg\.|\*|—)/.test(s)) return null;
    if (s.includes("(to Equipment)") || s.includes("(to Crafting)")) return null;

    /* Anchor on the "<N> Hour" / "<N> Min" / "<N> Day" token — every
     * recipe row has one. Split there: pre = name + maybe DC, post =
     * materials + invest + price. Accept "1Hour" (no space) too. */
    const timeMatch = s.match(/\*?(\d+)\s*(Hour|Min|Day)\b/);
    if (!timeMatch) return null;
    const timeIdx = s.indexOf(timeMatch[0]);
    const timeStr = timeMatch[0].replace(/^\*+/, "").trim();

    const pre  = s.slice(0, timeIdx).trimEnd();
    const post = s.slice(timeIdx + timeMatch[0].length).trim();

    /* `pre` is "<spaces>(maybe materials)<spaces>Name<spaces><optional DC>".
     *
     * Two layouts handled:
     *   (a) simple row — pre = "Name  9" (just name + DC)
     *   (b) wrapped row — pre = "Coal ×8, Iron ×4 ...   Estoc   21" because
     *       materials wrap from the line above the centred Name+DC line.
     *
     * Heuristic to separate: split on 2+ whitespace, then for each token
     * decide which kind it is:
     *   - pure integer → DC candidate (only the last one wins)
     *   - contains "×" → material chunk
     *   - else        → name candidate
     *
     * Materials in `pre` get accumulated into `preMaterials` and joined
     * with `post`'s trailing-material continuation later. The name is the
     * LAST non-material non-DC token (or token-run). */
    const preTokens = pre.trim().split(/\s{2,}/);
    let name = "", dc = null;
    const preMaterials = [];
    const nameCandidates = [];
    for (const tok of preTokens) {
        if (/^\d+$/.test(tok)) {
            dc = Number(tok);                          /* last numeric wins */
        } else if (/\(\s*[×x]\s*\d/.test(tok)) {
            /* Parenthesized "(×N)" → part of the item name (e.g.
             * "Throwing Knives (×3)"). Goes to name. */
            nameCandidates.push(tok);
        } else if ((tok.includes("×") || / x\s*\d/.test(tok)) && /\d/.test(tok)) {
            /* Bare ×N → material chunk. */
            preMaterials.push(tok);
        } else {
            nameCandidates.push(tok);
        }
    }
    name = nameCandidates.join(" ").trim();
    if (!name || !/^[A-Z]/.test(name)) return null;

    /* `post` is "<Materials>   <Invest>   <Price>   [maybe wrapped tail]".
     *
     * Two complications:
     *  (a) the item name may wrap to a SECOND line ("Arrows or Bolts,"
     *      / center row / "Broadhead (×10)") — those word tokens land
     *      AFTER the trailing numbers.
     *  (b) materials may wrap to a SECOND line too (the Viroledan and
     *      Eldercraft weapon recipes use a 3-line table) — those ×N
     *      tokens also land AFTER the trailing numbers.
     *
     * Distinguish (a) vs (b) by inspecting the token: tokens that
     * contain "×" (or "x<digit>") are material continuation; pure
     * words are name continuation. */
    /* Peel tokens from the END of post until we hit a pure numeric
     * (which will be Invest or Price). Each peeled token is classified:
     *   - "(×N)" or "(×N)" — name continuation (parenthesized count)
     *   - "×N" / "×N," / a bare-number-with-comma — material continuation
     *   - lowercase fragments (commas, "kg", etc.) — material
     *   - capitalized word — name continuation, UNLESS it neighbors a ×
     *     token in which case it's likely a multi-word material name
     *     (e.g. "Dark Steel ×3" → "Dark", "Steel", "×3").
     *
     * Implementation: pass 1 peel into a working list `wrap`; pass 2
     * partition `wrap` based on the presence of "(" parenthetical groups. */
    const postTokens = post.split(/\s+/);
    const postRev = postTokens.slice().reverse();
    const wrap = [];                                     /* trailing tokens, reversed back to forward order */
    while (postRev.length && !/^\*?\d+$/.test(postRev[0])) {
        wrap.unshift(postRev.shift());
    }
    const wrapText = wrap.join(" ");
    const nameContinuation = [];
    const trailingMaterials = [];
    if (wrapText.includes("(×") || wrapText.includes("(x")) {
        /* Likely a parenthesized name continuation like "Standard (×10)".
         * Everything up to and including the ")" goes to name. */
        const closeIdx = wrapText.indexOf(")");
        const namePart = wrapText.slice(0, closeIdx + 1).trim();
        const restPart = wrapText.slice(closeIdx + 1).trim();
        if (namePart) nameContinuation.push(namePart);
        if (restPart) trailingMaterials.push(restPart);
    } else {
        /* No parenthesized name continuation — assume everything is
         * material continuation (the bottom-row wrap of a 3-line PDF
         * table). */
        if (wrapText) trailingMaterials.push(wrapText);
    }
    let price = null, investment = null;
    if (postRev[0] && /^\*?\d+$/.test(postRev[0])) {
        price = Number(postRev.shift().replace(/^\*+/, ""));
    }
    if (postRev[0] && /^\*?\d+$/.test(postRev[0])) {
        investment = Number(postRev.shift().replace(/^\*+/, ""));
    } else {
        investment = price;
        price = null;
    }
    const postMaterials = postRev.reverse().join(" ").trim();
    const tailMaterials = trailingMaterials.join(" ").trim();
    /* Combine pre-materials + post-materials + trailing wrap. */
    let materials = [preMaterials.join(", "), postMaterials, tailMaterials]
        .filter(Boolean).join(", ");
    materials = materials.replace(/\s{2,}/g, " ").trim();
    if (!materials) return null;

    /* Append the continuation to the name. Trim trailing punctuation
     * like "," from the primary name first. */
    let cleanName = name.replace(/\*+$/, "").replace(/,\s*$/, "").trim();
    if (nameContinuation.length) {
        cleanName = `${cleanName} ${nameContinuation.join(" ")}`.replace(/\s{2,}/g, " ").trim();
    }
    return { name: cleanName, dc, time: timeStr, materialsText: materials, investment, price };
}

function extractComponents(materialsText) {
    const out = [];
    /* Each comma-separated chunk. */
    for (const chunk of materialsText.split(",")) {
        const t = chunk.trim();
        if (!t) continue;
        /* Try ×N form first, then parenthetical. */
        let m = t.match(/^([A-Za-z][A-Za-z &'’\-é]+?)\s*[×x]\s*(\d+)\s*$/);
        if (!m) m = t.match(/^([A-Za-z][A-Za-z &'’\-é]+?)\s*\(\s*[×x]\s*(\d+)\s*\)\s*$/);
        if (!m) {
            /* unparseable — skip */
            continue;
        }
        out.push({ name: m[1].trim(), quantity: Number(m[2]) });
    }
    return out;
}

/* Group consecutive non-blank lines into logical "rows" since the PDF
 * wraps long names + materials across multiple lines (e.g. the ammo
 * recipes split "Arrows or Bolts," / "<...recipe body...>" / "Standard
 * (×10)" across three lines). A blank line ends the current row.
 * Lines that are pure page-footer noise ("Pg.X Equipment Overhaul...")
 * are excluded from the merge. */
function isFooter(line) {
    return /^\s*Pg\.\d+\s+Equipment Overhaul/.test(line);
}
function rowsInSection(start, end) {
    const rows = [];
    let buf = [];
    for (let i = start + 1; i < end; i++) {
        const line = pdfLines[i];
        if (isFooter(line)) continue;
        if (!line.trim()) {
            if (buf.length) rows.push(buf.join(" "));
            buf = [];
        } else {
            buf.push(line);
        }
    }
    if (buf.length) rows.push(buf.join(" "));
    return rows;
}

console.log("→ Parsing PDF diagram tables…");
let rowsFound = 0;
for (let si = 0; si < sectionStarts.length - 1; si++) {
    const start = sectionStarts[si];
    const end   = sectionStarts[si + 1];
    for (const row of rowsInSection(start, end)) {
        const parsed = parseRow(row);
        if (!parsed) continue;
        const components = extractComponents(parsed.materialsText);
        if (components.length === 0) continue;
        const key = parsed.name.toLowerCase();
        if (recipeMap.has(key)) continue;
        recipeMap.set(key, { ...parsed, components });
        rowsFound++;
    }
}
console.log(`  Found ${rowsFound} recipe rows across ${sectionStarts.length - 1} sections.`);
if (process.env.LINK_DEBUG) {
    console.log("All recipe-map entries:");
    for (const [k, v] of recipeMap.entries()) {
        console.log(`  ${k}`);
    }
    console.log(`Total: ${recipeMap.size}`);
}

/* ── Compendium UUID lookup ──────────────────────────────────────── */

/* Core packs are walked FIRST so EO recipes resolve duplicate-named items
 * (Iron, Steel, Coal, Linen, etc.) to the canonical Core item rather than
 * a duplicate sitting in eo-components. The eo-components pack is now
 * stripped down to genuinely EO-only materials (Biraq Steel, Sapphire
 * Dust, Sinews, Drake Scale, Tretagor Steel, Zerrikan Steel, Ancient
 * Timber, Horn, Diamond Dust, Lead, Rope) so it's purely a fallback for
 * those eleven names. */
const LOOKUP_PACKS = [
    "crafting",
    "generalGear",
    "equipment",
    "witcherGear",
    "alchemy",
    "eo-components"   /* fallback — only EO-only materials live here now */
];

/* name (case-insensitive) → { pack, _id, name } */
const compendiumIndex = new Map();

console.log("→ Indexing existing compendium packs…");
for (const pn of LOOKUP_PACKS) {
    const dbDir = resolve(PACKS, pn);
    const db = new ClassicLevel(dbDir, { valueEncoding: "json" });
    try {
        for await (const [key, value] of db.iterator()) {
            if (!key.startsWith("!items!")) continue;
            const name = value?.name;
            if (!name) continue;
            const k = name.toLowerCase().trim();
            /* Don't overwrite — first pack wins (LOOKUP_PACKS order is priority). */
            if (!compendiumIndex.has(k)) {
                compendiumIndex.set(k, { pack: pn, _id: value._id, name });
            }
        }
    } finally {
        await db.close();
    }
}
console.log(`  Indexed ${compendiumIndex.size} compendium items across ${LOOKUP_PACKS.length} packs.`);
if (process.env.LINK_DEBUG) {
    for (const n of ["lead", "diamond dust", "draconid scale", "acid", "etching acid", "dust", "grit", "grease", "col", "coal"]) {
        const hit = compendiumIndex.get(n);
        console.log(`  ${n}: ${hit ? `${hit.pack}/${hit.name}` : "NOT FOUND"}`);
    }
}

/* ── Component-name aliases ───────────────────────────────────────
 * Some PDF component names differ slightly from compendium item names
 * (e.g. "Iron" in the table vs "Iron Ingot" in the pack). Map them. */
const ALIAS = {
    "iron":            ["Iron Ingot", "Iron"],
    "steel":           ["Steel Ingot", "Steel"],
    "silver":          ["Silver Ingot", "Silver"],
    "coal":            ["Coal"],
    "resin":           ["Resin"],
    "timber":          ["Timber"],
    "hardened timber": ["Hardened Timber"],
    "thread":          ["Thread"],
    "cotton":          ["Cotton"],
    "linen":           ["Linen"],
    "leather":         ["Leather"],
    "hardened leather": ["Hardened Leather"],
    "oil":             ["Oil", "Lamp Oil"],
    "ester grease":    ["Ester Grease"],
    "drake oil":       ["Drake Oil"],
    "sharpening grit": ["Sharpening Grit"],
    "wax":             ["Wax", "Beeswax"],
    "double woven linen": ["Double Woven Linen"],
    "silk":            ["Silk"],
    "etching acid":    ["Etching Acid"],
    "dark steel":      ["Dark Steel"],
    "diamond dust":    ["Diamond Dust"],
    "ruby dust":       ["Ruby Dust"],
    "sapphire dust":   ["Sapphire Dust"],
    "emerald dust":    ["Emerald Dust"],
    "meteorite":       ["Meteorite", "Meteorite Ingot"],
    "draconid leather":["Draconid Leather"],
    "ogre wax":        ["Ogre Wax"],
    "ghoul marrow":    ["Ghoul Marrow", "Marrow"],
    "rotfiend blood":  ["Rotfiend Blood"],
    "troll":           ["Troll Bones"],
    "beast bones":     ["Beast Bones"],
    "raw meat":        ["Raw Meat"],
    "tanning herbs":   ["Tanning Herbs"],
    "bone":            ["Bone", "Beast Bones"],
    "marrow":          ["Marrow", "Ghoul Marrow"],
    /* Singular forms / parser-fragmented names mapped to the canonical
     * compendium item names. */
    "beast bone":      ["Beast Bones"],
    "horn":            ["Horn"],
    "sinews":          ["Sinews"],
    "biraq steel":     ["Biraq Steel"],
    "sapphire dust":   ["Sapphire Dust"],
    "ruby dust":       ["Ruby Dust"],
    "emerald dust":    ["Emerald Dust"],
    "tretagor steel":  ["Tretagor Steel"],
    "zerrikan steel":  ["Zerrikan Steel"],
    "dark steel":      ["Dark Steel"],
    "darkening oil":   ["Darkening Oil"],
    "etching acid":    ["Etching Acid"],
    "ogre wax":        ["Ogre Wax"],
    "ancient timber":  ["Ancient Timber"],
    "mahakaman steel": ["Mahakaman Steel"],
    "drake scale":     ["Drake Scale"],
    "fifth essence":   ["Fifth Essence"],
    "gemstone":        ["Gemstone"],
    /* Parser-fragment salvage. When the PDF table layout splits a
     * compound name (e.g. "Etching Acid" → "Acid" alone), we map the
     * bare token to its most-likely full component. Last-resort glue. */
    "acid":            ["Etching Acid"],
    "grit":            ["Sharpening Grit"],
    "grease":          ["Ester Grease"],
    "dust":            ["Diamond Dust"],
    "col":             ["Coal"],
    "dark iron":       ["Iron"],
    "lead":            ["Lead"],
    "diamond dust":    ["Diamond Dust"],
    "draconid scale":  ["Draconid Leather", "Drake Scale"],
    "light essence":   ["Light Essence"],
    "tretagor steel":  ["Tretagor Steel"],
    "lyrian leather":  ["Lyrian Leather"],
    "river clay":      ["River Clay"],
    "glass":           ["Glass"],
    "zerrikanian powder": ["Zerrikanian Powder"],
    "rope":            ["Rope"],
    "raw meat":        ["Raw Meat"],
    "quicksilver solution": ["Quicksilver Solution"],
    "sulfur":          ["Sulfur"],
    "ashes":           ["Ashes"],
    "draconid scales": ["Draconid Scales", "Drake Scale", "Draconid Leather"],
    "essence of fire": ["Essence of Fire"],
    "gold":            ["Gold"],
    "perfect gemstone": ["Perfect Gemstone"],
    "infused dust":    ["Infused Dust"],
    "mahakaman dimeritium": ["Mahakaman Dimeritium"]
};

function resolveComponent(name) {
    const key = name.toLowerCase().trim();
    /* Direct match first. */
    if (compendiumIndex.has(key)) return compendiumIndex.get(key);
    /* Then aliases. */
    if (ALIAS[key]) {
        for (const alt of ALIAS[key]) {
            const got = compendiumIndex.get(alt.toLowerCase());
            if (got) return got;
        }
    }
    return null;
}

/* Diagram-name aliases: PDF recipe row is named differently than the
 * item it produces (e.g. "Throwing Knives (×3)" → "Throwing Knife").
 * Keyed by lowercased ITEM name; value is the lowercased RECIPE name. */
const DIAGRAM_ALIASES = {
    "battle axe":              "battle hatchet",
    "throwing knife":          "throwing knives (×3)",
    "throwing axe":            "throwing a×es (×3)",
    "dart":                    "darts (×3)",
    "shortbow":                "short bow",
    "longbow":                 "long bow",
    "sling bullet, stone":     "bullets, stone (×10)",
    "sling bullet, lead":      "bullets, lead (×10)",
    "heavy bullet":            "bullets, heavy (×10)",
    "incendiary bullet":       "bullets, incendiary (×10)",
    "torch":                   "torch (×5)",
    "chakram":                 "chakram (×3)",
    "jarid":                   "jarid (×3)",
    "orion":                   "orions (×3)",
    /* Arrows / Bolts — the EO crafting tables produce ×10 stacks
     * with a single recipe; our catalog has one item per arrowhead
     * type that all reference the same crafting recipe. */
    "broadhead arrow":         "arrows or bolts broadhead (×10)",
    "bodkin arrow":            "arrows or bolts bodkin (×10)",
    "blunt arrow":             "arrows or bolts blunt (×10)",
    "standard arrow":          "arrows or bolts standard (×10)",
    "flight arrow":            "arrows or bolts standard (×10)",
    "crossbow bolt":           "arrows or bolts standard (×10)",
    /* Northern / Southern specialty ammo */
    "rivian needle":           "arrows or bolts rivian needle (×10)",
    "temerian sheaf":          "arrows or bolts temerian sheaf (×10)",
    "markee howler":           "arrows or bolts markee howler (×10)",
    "black army bodkin":       "arrows or bolts black army bodkin (×10)",
    /* Wrapped-name aliases for the 3-line layout sections where the
     * parser truncates the recipe name. */
    "ducal knight arm harnisse":     "ducal knight arm",
    "ducal knight leg harnisse":     "ducal knight leg",
    "ducal knight breastplate":      "ducal knight breastplate",
    "feline steel sword":            "feline",
    /* "feline silver" already covered as a key. */
    "feline silver sword":           "feline silver",
    "gryphon steel sword":           "gryphon",
    /* Witcher Armor school sets reference "<school> witcher armor" recipes;
     * those include both the helm and the body via the multi-piece kit. */
    "feline hood":                   "feline witcher armor",
    "wolven witcher hood":           "wolven witcher armor",
    "gryphon witcher helmet":        "gryphon witcher armor",
    "manticore witcher hood":        "manticore witcher armor",
    "serpentine witcher hood":       "serpentine witcher armor",
    "ursine witcher helm":           "ursine witcher armor",
    /* Truncated/wrap names in artisan tier sections. */
    "redanian halberd":              "redanian",
    "rondel dagger":                 "rondel",
    "sword catcher":                 "sword catcher",
    "szabla":                        "szabla",
    "sa'if":                         "sa'if",
    "terganian side sword":          "terganian side",
    "viroledan longsword":           "viroledan",
    "vicovarian blade":              "vicovarian",
    "war cleaver":                   "war cleaver",
    "witcher steel sword":           "witcher steel",
    "witcher silver sword":          "witcher silver",
    "verden hunter's hood":          "verden hunter’s hood",
    "verden hunter's cloak":         "verden hunter’s cloak",
    "special forces vambraces":      "special forces vambraces",
    "steel arm harnisse":            "steel arm",
    "steel leg harnisse":            "steel leg",
    "zerrikanian zefhar":            "zerrikanian zefhar",
    "rivian needle":                 "arrows or bolts rivian needle (×10)",
    "whistling bullet":              "bullets whistling (×10)"
};

/* MANUAL_RECIPES — for items whose PDF table layout the auto-parser
 * can't reliably extract (3-line wraps, glyph/runeworks pages without a
 * tabular row, special items). Keyed by lowercased ITEM name. Each
 * entry provides: dc, time, investment, price, components, level. */
const MANUAL_RECIPES = {
    /* Arming Jack / Cold Weather Clothing — base items mentioned without
     * a tabular recipe; here are reasonable values per the EO p.4 sidebar. */
    "arming jack":                  { dc: 8, time: "1 Hour", investment: 25, price: 50,
        components: [{ name: "Thread", quantity: 3 }, { name: "Linen", quantity: 4 }] },
    "cold weather clothing":        { dc: 6, time: "2 Hour", investment: 15, price: 0,
        components: [{ name: "Thread", quantity: 2 }, { name: "Linen", quantity: 3 }, { name: "Leather", quantity: 1 }] },
    "superior arming suit":         { dc: 15, time: "3 Hour", investment: 250, price: 500,
        components: [{ name: "Thread", quantity: 10 }, { name: "Linen", quantity: 10 }, { name: "Silk", quantity: 5 }] },

    /* Basic crossbows + dart — PDF p.13 lists them but in a wrapped layout. */
    "crossbow":                     { dc: 13, time: "5 Hour", investment: 175, price: 350,
        components: [{ name: "Coal", quantity: 4 }, { name: "Hardened Timber", quantity: 3 }, { name: "Resin", quantity: 2 }, { name: "Iron", quantity: 2 }, { name: "Steel", quantity: 1 }] },
    "crossbow pistol":              { dc: 13, time: "4 Hour", investment: 125, price: 250,
        components: [{ name: "Coal", quantity: 3 }, { name: "Hardened Timber", quantity: 2 }, { name: "Resin", quantity: 2 }, { name: "Iron", quantity: 1 }, { name: "Steel", quantity: 1 }] },
    "heavy crossbow":               { dc: 15, time: "7 Hour", investment: 250, price: 500,
        components: [{ name: "Coal", quantity: 5 }, { name: "Hardened Timber", quantity: 4 }, { name: "Resin", quantity: 3 }, { name: "Iron", quantity: 3 }, { name: "Steel", quantity: 2 }] },
    "dart":                         { dc: 10, time: "1 Hour", investment: 18, price: 48,
        components: [{ name: "Resin", quantity: 1 }, { name: "Timber", quantity: 1 }, { name: "Feathers", quantity: 1 }, { name: "Steel", quantity: 1 }] },

    /* Eldercraft */
    "elven saber":                  { dc: 22, time: "10 Hour", investment: 600, price: 1239,
        components: [{ name: "Coal", quantity: 30 }, { name: "Hardened Timber", quantity: 3 }, { name: "Thread", quantity: 3 }, { name: "Ester Grease", quantity: 2 }, { name: "Sharpening Grit", quantity: 4 }, { name: "Mahakaman Steel", quantity: 1 }, { name: "Emerald Dust", quantity: 1 }] },
    "ballock great sword":          { dc: 22, time: "11 Hour", investment: 700, price: 1500,
        components: [{ name: "Coal", quantity: 33 }, { name: "Hardened Timber", quantity: 4 }, { name: "Sharpening Grit", quantity: 5 }, { name: "Mahakaman Steel", quantity: 1 }, { name: "Meteorite", quantity: 1 }] },
    "gwyhyr":                       { dc: 23, time: "11 Hour", investment: 720, price: 1432,
        components: [{ name: "Coal", quantity: 28 }, { name: "Sharpening Grit", quantity: 5 }, { name: "Mahakaman Steel", quantity: 1 }, { name: "Meteorite", quantity: 1 }, { name: "Emerald Dust", quantity: 2 }] },

    /* Northern */
    "francisca":                    { dc: 16, time: "4 Hour", investment: 90, price: 184,
        components: [{ name: "Coal", quantity: 4 }, { name: "Hardened Timber", quantity: 1 }, { name: "Resin", quantity: 1 }, { name: "Sharpening Grit", quantity: 1 }, { name: "Steel", quantity: 1 }] },
    "horseman's shield":            { dc: 14, time: "4 Hour", investment: 100, price: 201,
        components: [{ name: "Coal", quantity: 2 }, { name: "Hardened Timber", quantity: 3 }, { name: "Leather", quantity: 1 }, { name: "Iron", quantity: 1 }] },

    /* Viroledan */
    "hache de guerre":              { dc: 18, time: "8 Hour", investment: 470, price: 948,
        components: [{ name: "Coal", quantity: 24 }, { name: "Hardened Timber", quantity: 3 }, { name: "Darkening Oil", quantity: 2 }, { name: "Sharpening Grit", quantity: 3 }, { name: "Dark Steel", quantity: 2 }] },
    "chakram":                      { dc: 18, time: "5 Hour", investment: 85, price: 175,
        components: [{ name: "Coal", quantity: 4 }, { name: "Sharpening Grit", quantity: 2 }, { name: "Dark Steel", quantity: 1 }] },
    "ducal knight breastplate":     { dc: 21, time: "14 Hour", investment: 800, price: 1695,
        components: [{ name: "Coal", quantity: 80 }, { name: "Linen", quantity: 5 }, { name: "Oil", quantity: 20 }, { name: "Thread", quantity: 5 }, { name: "Leather", quantity: 3 }, { name: "Etching Acid", quantity: 20 }, { name: "Drake Oil", quantity: 5 }, { name: "Dark Steel", quantity: 6 }] },
    "ducal knight arm harnisse":    { dc: 20, time: "10 Hour", investment: 550, price: 1163,
        components: [{ name: "Coal", quantity: 60 }, { name: "Oil", quantity: 12 }, { name: "Leather", quantity: 3 }, { name: "Etching Acid", quantity: 16 }, { name: "Drake Oil", quantity: 3 }, { name: "Dark Steel", quantity: 4 }] },
    "ducal knight leg harnisse":    { dc: 20, time: "12 Hour", investment: 680, price: 1415,
        components: [{ name: "Coal", quantity: 70 }, { name: "Oil", quantity: 14 }, { name: "Leather", quantity: 3 }, { name: "Etching Acid", quantity: 18 }, { name: "Drake Oil", quantity: 4 }, { name: "Dark Steel", quantity: 5 }] },

    /* Northern Special-Forces & Black Army items the parser missed */
    "black army bodkin":            { dc: 16, time: "3 Hour", investment: 14, price: 29,
        components: [{ name: "Coal", quantity: 3 }, { name: "Resin", quantity: 1 }, { name: "Timber", quantity: 1 }, { name: "Wax", quantity: 1 }, { name: "Feathers", quantity: 1 }, { name: "Sharpening Grit", quantity: 1 }, { name: "Steel", quantity: 1 }] },
    "black army brigandine":        { dc: 18, time: "10 Hour", investment: 400, price: 821,
        components: [{ name: "Coal", quantity: 12 }, { name: "Linen", quantity: 4 }, { name: "Thread", quantity: 4 }, { name: "Leather", quantity: 2 }, { name: "Iron", quantity: 3 }, { name: "Dark Steel", quantity: 1 }] },
    "black army vambraces":         { dc: 18, time: "6 Hour", investment: 270, price: 547,
        components: [{ name: "Coal", quantity: 8 }, { name: "Thread", quantity: 2 }, { name: "Leather", quantity: 1 }, { name: "Iron", quantity: 1 }, { name: "Dark Steel", quantity: 1 }] },
    "dimeritium bullet":            { dc: 17, time: "2 Hour", investment: 22, price: 45,
        components: [{ name: "Coal", quantity: 2 }, { name: "Dimeritium", quantity: 1 }, { name: "Lead", quantity: 1 }] },
    "heavy bullet":                 { dc: 12, time: "2 Hour", investment: 5, price: 11,
        components: [{ name: "Coal", quantity: 4 }, { name: "Lead", quantity: 2 }] },

    /* Witcher School: kit (steel + silver swords + crossbow) — PDF p.31 layout
     * is the gnarliest in the doc. Components per the "Witcher School Weapons"
     * crafting table. */
    "feline steel sword":           { dc: 22, time: "10 Hour", investment: 400, price: 800,
        components: [{ name: "Coal", quantity: 20 }, { name: "Hardened Timber", quantity: 2 }, { name: "Resin", quantity: 1 }, { name: "Thread", quantity: 1 }, { name: "Draconid Leather", quantity: 1 }, { name: "Drake Oil", quantity: 2 }, { name: "Ester Grease", quantity: 2 }, { name: "Sharpening Grit", quantity: 4 }, { name: "Meteorite", quantity: 1 }] },
    "feline silver sword":          { dc: 24, time: "12 Hour", investment: 750, price: 1500,
        components: [{ name: "Hardened Timber", quantity: 2 }, { name: "Resin", quantity: 1 }, { name: "Thread", quantity: 1 }, { name: "Draconid Leather", quantity: 1 }, { name: "Drake Oil", quantity: 2 }, { name: "Ester Grease", quantity: 2 }, { name: "Sharpening Grit", quantity: 4 }, { name: "Silver", quantity: 1 }, { name: "Meteorite", quantity: 1 }] },
    "feline crossbow":              { dc: 20, time: "6 Hour", investment: 350, price: 700,
        components: [{ name: "Coal", quantity: 6 }, { name: "Hardened Timber", quantity: 3 }, { name: "Sharpening Grit", quantity: 2 }, { name: "Meteorite", quantity: 1 }] },
    "gryphon steel sword":          { dc: 22, time: "10 Hour", investment: 400, price: 800,
        components: [{ name: "Coal", quantity: 20 }, { name: "Hardened Timber", quantity: 2 }, { name: "Resin", quantity: 1 }, { name: "Thread", quantity: 1 }, { name: "Drake Oil", quantity: 2 }, { name: "Sharpening Grit", quantity: 4 }, { name: "Meteorite", quantity: 1 }, { name: "Light Essence", quantity: 1 }] },
    "gryphon silver sword":         { dc: 24, time: "12 Hour", investment: 750, price: 1500,
        components: [{ name: "Hardened Timber", quantity: 2 }, { name: "Resin", quantity: 1 }, { name: "Thread", quantity: 1 }, { name: "Drake Oil", quantity: 2 }, { name: "Sharpening Grit", quantity: 4 }, { name: "Silver", quantity: 1 }, { name: "Light Essence", quantity: 1 }] },
    "gryphon crossbow":             { dc: 20, time: "6 Hour", investment: 350, price: 700,
        components: [{ name: "Coal", quantity: 6 }, { name: "Hardened Timber", quantity: 3 }, { name: "Sharpening Grit", quantity: 2 }, { name: "Light Essence", quantity: 1 }] },
    "manticore steel sword":        { dc: 22, time: "10 Hour", investment: 400, price: 800,
        components: [{ name: "Coal", quantity: 20 }, { name: "Hardened Timber", quantity: 2 }, { name: "Draconid Leather", quantity: 1 }, { name: "Drake Oil", quantity: 1 }, { name: "Sharpening Grit", quantity: 4 }, { name: "Meteorite", quantity: 1 }] },
    "manticore silver sword":       { dc: 24, time: "12 Hour", investment: 750, price: 1500,
        components: [{ name: "Hardened Timber", quantity: 2 }, { name: "Draconid Leather", quantity: 1 }, { name: "Sharpening Grit", quantity: 4 }, { name: "Silver", quantity: 1 }, { name: "Meteorite", quantity: 1 }] },
    "serpentine sword":             { dc: 23, time: "11 Hour", investment: 600, price: 1200,
        components: [{ name: "Coal", quantity: 24 }, { name: "Hardened Timber", quantity: 2 }, { name: "Sharpening Grit", quantity: 4 }, { name: "Meteorite", quantity: 1 }, { name: "Silver", quantity: 1 }] },
    "wolven steel sword":           { dc: 22, time: "10 Hour", investment: 400, price: 800,
        components: [{ name: "Coal", quantity: 20 }, { name: "Hardened Timber", quantity: 2 }, { name: "Sharpening Grit", quantity: 4 }, { name: "Meteorite", quantity: 1 }] },
    "wolven silver sword":          { dc: 24, time: "12 Hour", investment: 750, price: 1500,
        components: [{ name: "Hardened Timber", quantity: 2 }, { name: "Sharpening Grit", quantity: 4 }, { name: "Silver", quantity: 1 }] },
    "ursine steel sword":           { dc: 23, time: "12 Hour", investment: 500, price: 1000,
        components: [{ name: "Coal", quantity: 25 }, { name: "Hardened Timber", quantity: 3 }, { name: "Sharpening Grit", quantity: 5 }, { name: "Meteorite", quantity: 2 }] },
    "ursine silver sword":          { dc: 25, time: "14 Hour", investment: 900, price: 1800,
        components: [{ name: "Hardened Timber", quantity: 3 }, { name: "Sharpening Grit", quantity: 5 }, { name: "Silver", quantity: 2 }, { name: "Meteorite", quantity: 1 }] },
    "viper fang":                   { dc: 21, time: "6 Hour", investment: 300, price: 600,
        components: [{ name: "Coal", quantity: 10 }, { name: "Hardened Timber", quantity: 1 }, { name: "Sharpening Grit", quantity: 2 }, { name: "Meteorite", quantity: 1 }, { name: "Silver", quantity: 1 }] },
    "wolven silver chain":          { dc: 19, time: "8 Hour", investment: 250, price: 500,
        components: [{ name: "Coal", quantity: 8 }, { name: "Thread", quantity: 4 }, { name: "Silver", quantity: 1 }] },
    "ursine crossbow":              { dc: 21, time: "7 Hour", investment: 400, price: 800,
        components: [{ name: "Coal", quantity: 8 }, { name: "Hardened Timber", quantity: 4 }, { name: "Sharpening Grit", quantity: 3 }, { name: "Meteorite", quantity: 1 }] },

    /* Witcher School Armor / Shields */
    "feline hood":                  { dc: 23, time: "5 Hour", investment: 400, price: 800,
        components: [{ name: "Coal", quantity: 15 }, { name: "Double Woven Linen", quantity: 5 }, { name: "Thread", quantity: 3 }, { name: "Meteorite", quantity: 1 }, { name: "Silver", quantity: 1 }] },
    "serpentine witcher hood":      { dc: 23, time: "5 Hour", investment: 400, price: 800,
        components: [{ name: "Coal", quantity: 15 }, { name: "Double Woven Linen", quantity: 5 }, { name: "Thread", quantity: 3 }, { name: "Meteorite", quantity: 1 }, { name: "Silver", quantity: 1 }] },
    "manticore witcher hood":       { dc: 23, time: "5 Hour", investment: 400, price: 800,
        components: [{ name: "Coal", quantity: 15 }, { name: "Silk", quantity: 3 }, { name: "Thread", quantity: 3 }, { name: "Meteorite", quantity: 1 }, { name: "Silver", quantity: 1 }] },
    "wolven witcher hood":          { dc: 24, time: "6 Hour", investment: 500, price: 1000,
        components: [{ name: "Coal", quantity: 18 }, { name: "Linen", quantity: 8 }, { name: "Thread", quantity: 3 }, { name: "Meteorite", quantity: 2 }, { name: "Silver", quantity: 1 }] },
    "gryphon witcher helmet":       { dc: 25, time: "7 Hour", investment: 567, price: 1134,
        components: [{ name: "Coal", quantity: 28 }, { name: "Linen", quantity: 10 }, { name: "Thread", quantity: 3 }, { name: "Meteorite", quantity: 2 }, { name: "Silver", quantity: 1 }, { name: "Light Essence", quantity: 4 }] },
    "ursine witcher helm":          { dc: 26, time: "8 Hour", investment: 669, price: 1338,
        components: [{ name: "Coal", quantity: 25 }, { name: "Double Woven Linen", quantity: 10 }, { name: "Thread", quantity: 5 }, { name: "Beast Bones", quantity: 2 }, { name: "Meteorite", quantity: 3 }, { name: "Silver", quantity: 1 }] },
    "manticore shield":             { dc: 22, time: "8 Hour", investment: 330, price: 659,
        components: [{ name: "Coal", quantity: 10 }, { name: "Hardened Timber", quantity: 3 }, { name: "Sharpening Grit", quantity: 3 }, { name: "Meteorite", quantity: 1 }, { name: "Silver", quantity: 1 }] },

    /* Glyphs / armor enhancements — minor enchantment recipes. The EO
     * book doesn't give explicit per-glyph crafting tables; we mint
     * reasonable approximations using "Light Essence" as the magic
     * binder + the appropriate dust per Sign. */
    "glyph of aard":                { dc: 18, time: "4 Hour", investment: 175, price: 350,
        components: [{ name: "Coal", quantity: 4 }, { name: "Ester Grease", quantity: 2 }, { name: "Light Essence", quantity: 1 }, { name: "Sapphire Dust", quantity: 1 }] },
    "glyph of igni":                { dc: 18, time: "4 Hour", investment: 200, price: 400,
        components: [{ name: "Coal", quantity: 4 }, { name: "Drake Oil", quantity: 1 }, { name: "Light Essence", quantity: 1 }, { name: "Ruby Dust", quantity: 1 }] },
    "glyph of yrden":               { dc: 18, time: "4 Hour", investment: 190, price: 380,
        components: [{ name: "Coal", quantity: 4 }, { name: "Light Essence", quantity: 1 }, { name: "Sapphire Dust", quantity: 1 }, { name: "Diamond Dust", quantity: 1 }] },
    "glyph of quen":                { dc: 20, time: "6 Hour", investment: 300, price: 600,
        components: [{ name: "Coal", quantity: 6 }, { name: "Light Essence", quantity: 2 }, { name: "Diamond Dust", quantity: 1 }, { name: "Meteorite", quantity: 1 }] },
    "greater glyph of quen":        { dc: 24, time: "10 Hour", investment: 550, price: 1100,
        components: [{ name: "Coal", quantity: 12 }, { name: "Light Essence", quantity: 4 }, { name: "Diamond Dust", quantity: 2 }, { name: "Meteorite", quantity: 2 }] },
    "glyph of warding":             { dc: 21, time: "6 Hour", investment: 250, price: 500,
        components: [{ name: "Coal", quantity: 5 }, { name: "Drake Oil", quantity: 2 }, { name: "Light Essence", quantity: 1 }, { name: "Emerald Dust", quantity: 1 }] },
    "lesser glyph of mending":      { dc: 16, time: "3 Hour", investment: 100, price: 200,
        components: [{ name: "Coal", quantity: 3 }, { name: "Ester Grease", quantity: 2 }, { name: "Light Essence", quantity: 1 }] },

    /* Custom armor mods (homebrew physical mods). */
    "hardened bracing":             { dc: 14, time: "3 Hour", investment: 140, price: 280,
        components: [{ name: "Coal", quantity: 4 }, { name: "Hardened Leather", quantity: 2 }, { name: "Iron", quantity: 2 }] },
    "hardened lining":              { dc: 12, time: "2 Hour", investment: 75, price: 150,
        components: [{ name: "Coal", quantity: 2 }, { name: "Hardened Leather", quantity: 1 }, { name: "Thread", quantity: 2 }] },
    "padded lining":                { dc: 11, time: "2 Hour", investment: 70, price: 140,
        components: [{ name: "Linen", quantity: 4 }, { name: "Thread", quantity: 3 }, { name: "Wax", quantity: 1 }] },
    "mail lining":                  { dc: 15, time: "4 Hour", investment: 110, price: 220,
        components: [{ name: "Coal", quantity: 2 }, { name: "Oil", quantity: 1 }, { name: "Iron", quantity: 2 }] },
    "light padded trim":            { dc: 10, time: "1 Hour", investment: 90, price: 180,
        components: [{ name: "Linen", quantity: 3 }, { name: "Thread", quantity: 2 }] },
    "studded hide":                 { dc: 12, time: "2 Hour", investment: 80, price: 160,
        components: [{ name: "Leather", quantity: 2 }, { name: "Iron", quantity: 1 }, { name: "Thread", quantity: 2 }] },
    "plated underlay":              { dc: 16, time: "5 Hour", investment: 190, price: 380,
        components: [{ name: "Coal", quantity: 5 }, { name: "Hardened Leather", quantity: 1 }, { name: "Iron", quantity: 3 }, { name: "Steel", quantity: 1 }] },
    "reinforced plating":           { dc: 14, time: "4 Hour", investment: 100, price: 200,
        components: [{ name: "Coal", quantity: 3 }, { name: "Iron", quantity: 2 }, { name: "Steel", quantity: 1 }] },

    /* Items the parser couldn't extract from multi-line PDF layouts. */
    "longsword":                    { dc: 12, time: "5 Hour", investment: 172, price: 343,
        components: [{ name: "Coal", quantity: 5 }, { name: "Resin", quantity: 1 }, { name: "Hardened Timber", quantity: 1 }, { name: "Thread", quantity: 1 }, { name: "Leather", quantity: 1 }, { name: "Sharpening Grit", quantity: 1 }, { name: "Steel", quantity: 1 }] },
    "hunting bow":                  { dc: 12, time: "4 Hour", investment: 140, price: 280,
        components: [{ name: "Hardened Timber", quantity: 4 }, { name: "Resin", quantity: 2 }, { name: "Thread", quantity: 2 }, { name: "Wax", quantity: 2 }, { name: "Sinews", quantity: 2 }] },
    "javelin":                      { dc: 10, time: "2 Hour", investment: 31, price: 62,
        components: [{ name: "Coal", quantity: 2 }, { name: "Hardened Timber", quantity: 2 }, { name: "Resin", quantity: 1 }, { name: "Sharpening Grit", quantity: 1 }, { name: "Iron", quantity: 1 }] },
    "pavise":                       { dc: 14, time: "5 Hour", investment: 250, price: 500,
        components: [{ name: "Coal", quantity: 4 }, { name: "Hardened Timber", quantity: 5 }, { name: "Iron", quantity: 2 }] },
    "iron arm harnisse":            { dc: 18, time: "8 Hour", investment: 305, price: 612,
        components: [{ name: "Coal", quantity: 8 }, { name: "Thread", quantity: 2 }, { name: "Leather", quantity: 1 }, { name: "Iron", quantity: 3 }] },
    "plated greaves":               { dc: 17, time: "7 Hour", investment: 220, price: 438,
        components: [{ name: "Coal", quantity: 6 }, { name: "Linen", quantity: 2 }, { name: "Thread", quantity: 3 }, { name: "Iron", quantity: 3 }, { name: "Steel", quantity: 1 }] },

    /* Eldercraft signature items */
    "mahakaman sihil":              { dc: 25, time: "10 Hour", investment: 490, price: 980,
        components: [{ name: "Coal", quantity: 24 }, { name: "Hardened Timber", quantity: 1 }, { name: "Sharpening Grit", quantity: 4 }, { name: "Mahakaman Steel", quantity: 1 }, { name: "Meteorite", quantity: 1 }] },
    "mahakaman pavise":             { dc: 22, time: "8 Hour", investment: 605, price: 1210,
        components: [{ name: "Coal", quantity: 6 }, { name: "Hardened Timber", quantity: 6 }, { name: "Mahakaman Steel", quantity: 2 }] },

    /* Viroledan crossbows + Nilfgaardian heavy set */
    "koviri crossbow":              { dc: 17, time: "5 Hour", investment: 170, price: 341,
        components: [{ name: "Coal", quantity: 4 }, { name: "Hardened Timber", quantity: 2 }, { name: "Resin", quantity: 1 }, { name: "Iron", quantity: 2 }, { name: "Steel", quantity: 1 }] },
    "markee bow":                   { dc: 16, time: "5 Hour", investment: 215, price: 431,
        components: [{ name: "Hardened Timber", quantity: 4 }, { name: "Resin", quantity: 2 }, { name: "Thread", quantity: 2 }, { name: "Sinews", quantity: 2 }, { name: "Drake Oil", quantity: 1 }] },
    "nilfgaardian crossbow":        { dc: 18, time: "5 Hour", investment: 170, price: 342,
        components: [{ name: "Coal", quantity: 4 }, { name: "Hardened Timber", quantity: 2 }, { name: "Thread", quantity: 1 }, { name: "Steel", quantity: 1 }, { name: "Dark Steel", quantity: 1 }] },
    "nilfgaardian breastplate":     { dc: 19, time: "11 Hour", investment: 595, price: 1193,
        components: [{ name: "Coal", quantity: 30 }, { name: "Linen", quantity: 4 }, { name: "Thread", quantity: 5 }, { name: "Leather", quantity: 2 }, { name: "Etching Acid", quantity: 6 }, { name: "Dark Steel", quantity: 3 }] },
    "nilfgaardian arm harnisse":    { dc: 19, time: "8 Hour", investment: 430, price: 861,
        components: [{ name: "Coal", quantity: 22 }, { name: "Thread", quantity: 4 }, { name: "Leather", quantity: 2 }, { name: "Etching Acid", quantity: 5 }, { name: "Dark Steel", quantity: 2 }] },
    "nilfgaardian leg harnisse":    { dc: 19, time: "9 Hour", investment: 547, price: 1097,
        components: [{ name: "Coal", quantity: 28 }, { name: "Thread", quantity: 4 }, { name: "Leather", quantity: 3 }, { name: "Etching Acid", quantity: 5 }, { name: "Dark Steel", quantity: 3 }] },

    /* Special ammo + thrown */
    "jarid":                        { dc: 11, time: "1 Hour", investment: 93, price: 186,
        components: [{ name: "Coal", quantity: 1 }, { name: "Hardened Timber", quantity: 1 }, { name: "Resin", quantity: 1 }, { name: "Iron", quantity: 1 }] },
    "orion":                        { dc: 13, time: "1 Hour", investment: 23, price: 46,
        components: [{ name: "Coal", quantity: 1 }, { name: "Steel", quantity: 1 }] },
    "incendiary bullet":            { dc: 14, time: "1 Hour", investment: 13, price: 26,
        components: [{ name: "Coal", quantity: 1 }, { name: "Oil", quantity: 1 }, { name: "Lead", quantity: 1 }] },
    "markee howler":                { dc: 13, time: "2 Hour", investment: 13, price: 26,
        components: [{ name: "Coal", quantity: 1 }, { name: "Hardened Timber", quantity: 1 }, { name: "Resin", quantity: 1 }, { name: "Sharpening Grit", quantity: 1 }, { name: "Steel", quantity: 1 }] },

    /* Remaining items missed by the parser's PDF-table extraction. */
    "rondel dagger":                { dc: 16, time: "3 Hour", investment: 150, price: 300,
        components: [{ name: "Coal", quantity: 4 }, { name: "Hardened Timber", quantity: 1 }, { name: "Resin", quantity: 1 }, { name: "Sharpening Grit", quantity: 2 }, { name: "Steel", quantity: 1 }] },
    "sword catcher":                { dc: 17, time: "4 Hour", investment: 190, price: 379,
        components: [{ name: "Coal", quantity: 5 }, { name: "Hardened Timber", quantity: 1 }, { name: "Sharpening Grit", quantity: 2 }, { name: "Steel", quantity: 1 }] },
    "szabla":                       { dc: 16, time: "4 Hour", investment: 143, price: 287,
        components: [{ name: "Coal", quantity: 5 }, { name: "Hardened Timber", quantity: 1 }, { name: "Resin", quantity: 1 }, { name: "Sharpening Grit", quantity: 2 }, { name: "Steel", quantity: 1 }] },
    "sa'if":                        { dc: 19, time: "6 Hour", investment: 350, price: 707,
        components: [{ name: "Coal", quantity: 12 }, { name: "Hardened Timber", quantity: 1 }, { name: "Sharpening Grit", quantity: 3 }, { name: "Dark Steel", quantity: 1 }] },
    "war cleaver":                  { dc: 14, time: "5 Hour", investment: 155, price: 314,
        components: [{ name: "Coal", quantity: 6 }, { name: "Hardened Timber", quantity: 3 }, { name: "Resin", quantity: 2 }, { name: "Sharpening Grit", quantity: 2 }, { name: "Steel", quantity: 1 }] },
    "verden hunter's hood":         { dc: 13, time: "3 Hour", investment: 69, price: 138,
        components: [{ name: "Linen", quantity: 2 }, { name: "Thread", quantity: 2 }, { name: "Leather", quantity: 1 }] },
    "special forces vambraces":     { dc: 17, time: "5 Hour", investment: 240, price: 485,
        components: [{ name: "Coal", quantity: 8 }, { name: "Linen", quantity: 2 }, { name: "Thread", quantity: 2 }, { name: "Leather", quantity: 1 }, { name: "Iron", quantity: 1 }] },
    "whistling bullet":             { dc: 11, time: "1 Hour", investment: 3, price: 7,
        components: [{ name: "Coal", quantity: 1 }, { name: "Lead", quantity: 1 }] },
    "rivian needle":                { dc: 16, time: "3 Hour", investment: 13, price: 26,
        components: [{ name: "Coal", quantity: 2 }, { name: "Resin", quantity: 1 }, { name: "Timber", quantity: 1 }, { name: "Feathers", quantity: 1 }, { name: "Sharpening Grit", quantity: 1 }, { name: "Steel", quantity: 1 }] },
    "zerrikanian zefhar":           { dc: 18, time: "6 Hour", investment: 650, price: 1302,
        components: [{ name: "Hardened Timber", quantity: 5 }, { name: "Resin", quantity: 3 }, { name: "Sinews", quantity: 3 }, { name: "Horn", quantity: 2 }, { name: "Drake Oil", quantity: 1 }] },

    /* Viroledan + Northern + Witcher Kit signature items whose PDF
     * tables use a 3-line layout the parser can't extract cleanly. */
    "viroledan longsword":          { dc: 21, time: "9 Hour", investment: 614, price: 1413,
        components: [{ name: "Coal", quantity: 27 }, { name: "Hardened Timber", quantity: 4 }, { name: "Resin", quantity: 5 }, { name: "Thread", quantity: 3 }, { name: "Leather", quantity: 1 }, { name: "Darkening Oil", quantity: 2 }, { name: "Ester Grease", quantity: 2 }, { name: "Sharpening Grit", quantity: 4 }, { name: "Dark Steel", quantity: 2 }, { name: "Diamond Dust", quantity: 1 }] },
    "vicovarian blade":             { dc: 23, time: "10 Hour", investment: 675, price: 1553,
        components: [{ name: "Coal", quantity: 30 }, { name: "Hardened Timber", quantity: 5 }, { name: "Thread", quantity: 5 }, { name: "Hardened Leather", quantity: 1 }, { name: "Darkening Oil", quantity: 3 }, { name: "Ester Grease", quantity: 2 }, { name: "Ogre Wax", quantity: 4 }, { name: "Sharpening Grit", quantity: 4 }, { name: "Dark Steel", quantity: 3 }] },
    "terganian side sword":         { dc: 22, time: "8 Hour", investment: 505, price: 1162,
        components: [{ name: "Coal", quantity: 24 }, { name: "Silk", quantity: 1 }, { name: "Timber", quantity: 1 }, { name: "Thread", quantity: 2 }, { name: "Leather", quantity: 1 }, { name: "Darkening Oil", quantity: 2 }, { name: "Drake Oil", quantity: 1 }, { name: "Etching Acid", quantity: 6 }, { name: "Ogre Wax", quantity: 2 }, { name: "Sharpening Grit", quantity: 3 }, { name: "Dark Steel", quantity: 2 }] },
    "redanian halberd":             { dc: 19, time: "8 Hour", investment: 545, price: 1092,
        components: [{ name: "Coal", quantity: 18 }, { name: "Hardened Timber", quantity: 5 }, { name: "Resin", quantity: 3 }, { name: "Ogre Wax", quantity: 2 }, { name: "Sharpening Grit", quantity: 3 }, { name: "Dark Steel", quantity: 2 }] },
    "estoc":                        { dc: 21, time: "9 Hour", investment: 553, price: 1272,
        components: [{ name: "Coal", quantity: 27 }, { name: "Hardened Timber", quantity: 3 }, { name: "Thread", quantity: 3 }, { name: "Leather", quantity: 1 }, { name: "Darkening Oil", quantity: 2 }, { name: "Drake Oil", quantity: 1 }, { name: "Ester Grease", quantity: 1 }, { name: "Ogre Wax", quantity: 3 }, { name: "Sharpening Grit", quantity: 2 }, { name: "Dark Steel", quantity: 3 }] },

    /* Generic Witcher kit weapons (non-school) — separate from the
     * Feline/Wolven/etc. school variants. */
    "witcher steel sword":          { dc: 21, time: "9 Hour", investment: 400, price: 800,
        components: [{ name: "Coal", quantity: 20 }, { name: "Hardened Timber", quantity: 2 }, { name: "Resin", quantity: 1 }, { name: "Thread", quantity: 1 }, { name: "Leather", quantity: 1 }, { name: "Etching Acid", quantity: 2 }, { name: "Sharpening Grit", quantity: 4 }, { name: "Meteorite", quantity: 1 }] },
    "witcher silver sword":         { dc: 23, time: "11 Hour", investment: 750, price: 1500,
        components: [{ name: "Hardened Timber", quantity: 2 }, { name: "Resin", quantity: 1 }, { name: "Thread", quantity: 1 }, { name: "Leather", quantity: 1 }, { name: "Etching Acid", quantity: 2 }, { name: "Sharpening Grit", quantity: 4 }, { name: "Silver", quantity: 1 }, { name: "Meteorite", quantity: 1 }] },

    /* ── Makeshift weapons / improvised tools (EO p.10-11) ────────────
     * The PDF describes these as picked-up items rather than crafted, but
     * for completeness we mint trivial "recipes" using Timber/Rope so the
     * diagrams link cleanly. Component quantities mirror the in-text
     * conversion rules (1 unit timber → stick, 2 → big stick, 3 → bigger). */
    "stick":                        { dc: 8, time: "10 Min", investment: 0, price: 0,
        components: [{ name: "Timber", quantity: 1 }] },
    "big stick":                    { dc: 11, time: "30 Min", investment: 0, price: 0,
        components: [{ name: "Timber", quantity: 2 }] },
    "bigger stick":                 { dc: 13, time: "1 Hour", investment: 0, price: 0,
        components: [{ name: "Timber", quantity: 3 }] },
    "rock":                         { dc: 6, time: "10 Min", investment: 0, price: 0,
        components: [{ name: "Stone", quantity: 1 }] },
    "stone":                        { dc: 6, time: "10 Min", investment: 0, price: 0,
        components: [{ name: "Stone", quantity: 1 }] },
    "rope":                         { dc: 8, time: "1 Hour", investment: 4, price: 8,
        components: [{ name: "Thread", quantity: 3 }] },
    "silk":                         { dc: 12, time: "2 Hour", investment: 70, price: 148,
        components: [{ name: "Thread", quantity: 4 }, { name: "Silk", quantity: 1 }] },
    "bullwhip":                     { dc: 10, time: "2 Hour", investment: 90, price: 192,
        components: [{ name: "Leather", quantity: 2 }, { name: "Thread", quantity: 1 }, { name: "Rope", quantity: 1 }] },
    "druid's sickle":               { dc: 12, time: "3 Hour", investment: 250, price: 543,
        components: [{ name: "Coal", quantity: 3 }, { name: "Hardened Timber", quantity: 1 }, { name: "Resin", quantity: 1 }, { name: "Sharpening Grit", quantity: 1 }, { name: "Steel", quantity: 1 }] },
    "shepherd's crook":             { dc: 8, time: "1 Hour", investment: 16, price: 35,
        components: [{ name: "Timber", quantity: 2 }, { name: "Resin", quantity: 1 }] },
    "field doctor's syringe":       { dc: 12, time: "2 Hour", investment: 130, price: 286,
        components: [{ name: "Coal", quantity: 2 }, { name: "Glass", quantity: 1 }, { name: "Resin", quantity: 1 }, { name: "Steel", quantity: 1 }] },

    /* ── Artillery ammunition (EO p.36, p.62-63) ──────────────────────
     * Most artillery ammo uses Mangonel-tier recipes — we pick the
     * Ballista (smallest) quantities as the canonical recipe. */
    "stone shot grenade":           { dc: 12, time: "2 Hour", investment: 28, price: 59,
        components: [{ name: "Stone", quantity: 2 }, { name: "River Clay", quantity: 4 }] },
    "clay fire pot":                { dc: 15, time: "2 Hour", investment: 147, price: 324,
        components: [{ name: "Coal", quantity: 12 }, { name: "Oil", quantity: 10 }, { name: "River Clay", quantity: 3 }, { name: "Zerrikanian Powder", quantity: 3 }] },
    "zerrikanian fire":             { dc: 19, time: "2 Hour", investment: 427, price: 983,
        components: [{ name: "Hardened Timber", quantity: 12 }, { name: "Ogre Wax", quantity: 3 }, { name: "Essence of Fire", quantity: 3 }, { name: "River Clay", quantity: 2 }] },
    "carcass":                      { dc: 10, time: "30 Min", investment: 12, price: 25,
        components: [{ name: "Raw Meat", quantity: 5 }] },
    "standard bolt":                { dc: 16, time: "1 Hour", investment: 220, price: 484,
        components: [{ name: "Resin", quantity: 10 }, { name: "Thread", quantity: 5 }, { name: "Timber", quantity: 5 }, { name: "Feathers", quantity: 5 }, { name: "Sharpening Grit", quantity: 2 }, { name: "Iron", quantity: 1 }, { name: "Steel", quantity: 1 }] },
    "flaming bolt":                 { dc: 18, time: "2 Hour", investment: 355, price: 817,
        components: [{ name: "Hardened Timber", quantity: 14 }, { name: "Linen", quantity: 1 }, { name: "Oil", quantity: 4 }, { name: "Resin", quantity: 10 }, { name: "Feathers", quantity: 3 }, { name: "Iron", quantity: 1 }, { name: "Steel", quantity: 1 }] },
    "siege scorpion":               { dc: 18, time: "30 Hour", investment: 6000, price: 13200,
        components: [{ name: "Coal", quantity: 60 }, { name: "Hardened Timber", quantity: 40 }, { name: "Iron", quantity: 20 }, { name: "Steel", quantity: 10 }, { name: "Rope", quantity: 15 }, { name: "Sinews", quantity: 10 }] },

    /* ── Exotic / Ofieri equipment (EO p.24-26) ───────────────────────
     * The Ofieri / exotic crafting tables are spread across multiple
     * pages with the most irregular layouts in the doc. */
    "basic ofieri clothing":        { dc: 8, time: "2 Hour", investment: 12, price: 25,
        components: [{ name: "Linen", quantity: 3 }, { name: "Thread", quantity: 2 }] },
    "fancy ofieri clothing":        { dc: 12, time: "4 Hour", investment: 70, price: 150,
        components: [{ name: "Silk", quantity: 2 }, { name: "Linen", quantity: 2 }, { name: "Thread", quantity: 3 }] },
    "ofieri staff":                 { dc: 26, time: "12 Hour", investment: 1807, price: 4157,
        components: [{ name: "Hardened Timber", quantity: 14 }, { name: "Fifth Essence", quantity: 3 }, { name: "Emerald Dust", quantity: 2 }, { name: "Gold", quantity: 1 }, { name: "Perfect Gemstone", quantity: 1 }, { name: "Silver", quantity: 1 }] },
    "ofieri flight":                { dc: 14, time: "2 Hour", investment: 8, price: 17,
        components: [{ name: "Resin", quantity: 1 }, { name: "Timber", quantity: 2 }, { name: "Wax", quantity: 1 }, { name: "Feathers", quantity: 2 }, { name: "Sharpening Grit", quantity: 1 }, { name: "Steel", quantity: 1 }] },
    "bone-tipped arrow":            { dc: 11, time: "2 Hour", investment: 2, price: 5,
        components: [{ name: "Resin", quantity: 1 }, { name: "Thread", quantity: 1 }, { name: "Timber", quantity: 2 }, { name: "Wax", quantity: 1 }, { name: "Beast Bones", quantity: 1 }, { name: "Feathers", quantity: 1 }] },
    "zerrikanian bladed":           { dc: 16, time: "3 Hour", investment: 16, price: 35,
        components: [{ name: "Coal", quantity: 12 }, { name: "Resin", quantity: 1 }, { name: "Timber", quantity: 2 }, { name: "Wax", quantity: 1 }, { name: "Feathers", quantity: 1 }, { name: "Sharpening Grit", quantity: 4 }, { name: "Zerrikan Steel", quantity: 1 }] },
    "haakish":                      { dc: 17, time: "3 Hour", investment: 17, price: 38,
        components: [{ name: "Coal", quantity: 9 }, { name: "Resin", quantity: 1 }, { name: "Timber", quantity: 2 }, { name: "Wax", quantity: 1 }, { name: "Feathers", quantity: 1 }, { name: "Raw Meat", quantity: 2 }, { name: "Zerrikan Steel", quantity: 1 }] },

    /* ── Ammunition (basic and silver/meteorite specials) ─────────────*/
    "silver bullet":                { dc: 13, time: "2 Hour", investment: 80, price: 184,
        components: [{ name: "Coal", quantity: 8 }, { name: "Silver", quantity: 1 }] },
    "meteorite bullet":             { dc: 15, time: "4 Hour", investment: 198, price: 456,
        components: [{ name: "Coal", quantity: 4 }, { name: "Sharpening Grit", quantity: 3 }, { name: "Meteorite", quantity: 1 }] },

    /* ── Northern military / specialty (EO p.42-44) ───────────────────*/
    "huntsman's crossbow":          { dc: 17, time: "10 Hour", investment: 370, price: 777,
        components: [{ name: "Coal", quantity: 2 }, { name: "Hardened Timber", quantity: 10 }, { name: "Thread", quantity: 8 }, { name: "Hardened Leather", quantity: 1 }, { name: "Ogre Wax", quantity: 4 }, { name: "Steel", quantity: 2 }] },
    "soldier's crossbow":           { dc: 18, time: "12 Hour", investment: 577, price: 1270,
        components: [{ name: "Coal", quantity: 4 }, { name: "Hardened Timber", quantity: 15 }, { name: "Thread", quantity: 12 }, { name: "Ogre Wax", quantity: 6 }, { name: "Drake Oil", quantity: 1 }, { name: "Steel", quantity: 4 }] },
    "strongman's bow":               { dc: 22, time: "7 Hour", investment: 598, price: 1376,
        components: [{ name: "Hardened Timber", quantity: 16 }, { name: "Thread", quantity: 18 }, { name: "Drake Oil", quantity: 4 }, { name: "Ester Grease", quantity: 6 }, { name: "Ogre Wax", quantity: 6 }] },
    "monster hunter's pike":        { dc: 22, time: "8 Hour", investment: 710, price: 1633,
        components: [{ name: "Coal", quantity: 24 }, { name: "Hardened Timber", quantity: 24 }, { name: "Resin", quantity: 5 }, { name: "Leather", quantity: 1 }, { name: "Hardened Leather", quantity: 1 }, { name: "Ester Grease", quantity: 3 }, { name: "Etching Acid", quantity: 3 }, { name: "Mahakaman Steel", quantity: 1 }, { name: "Silver", quantity: 1 }] },
    "monster hunter's crossbow":    { dc: 24, time: "16 Hour", investment: 1047, price: 2409,
        components: [{ name: "Coal", quantity: 4 }, { name: "Hardened Timber", quantity: 25 }, { name: "Thread", quantity: 20 }, { name: "Ogre Wax", quantity: 12 }, { name: "Drake Oil", quantity: 3 }, { name: "Dark Steel", quantity: 4 }] },
    "monster catcher's net":        { dc: 24, time: "16 Hour", investment: 456, price: 1049,
        components: [{ name: "Resin", quantity: 6 }, { name: "Thread", quantity: 25 }, { name: "Wax", quantity: 4 }, { name: "Ester Grease", quantity: 1 }, { name: "Quicksilver Solution", quantity: 3 }, { name: "Sulfur", quantity: 3 }, { name: "Lead", quantity: 2 }] },

    /* ── Cheval (knightly) weapons + armor (EO p.55-58) ───────────────*/
    "cheval dagger":                { dc: 20, time: "5 Hour", investment: 386, price: 888,
        components: [{ name: "Coal", quantity: 15 }, { name: "Hardened Timber", quantity: 2 }, { name: "Resin", quantity: 1 }, { name: "Thread", quantity: 1 }, { name: "Leather", quantity: 1 }, { name: "Ester Grease", quantity: 1 }, { name: "Sharpening Grit", quantity: 2 }, { name: "Diamond Dust", quantity: 1 }, { name: "Mahakaman Steel", quantity: 1 }] },
    "cheval sword":                 { dc: 25, time: "13 Hour", investment: 924, price: 2126,
        components: [{ name: "Coal", quantity: 50 }, { name: "Hardened Timber", quantity: 6 }, { name: "Resin", quantity: 4 }, { name: "Thread", quantity: 3 }, { name: "Leather", quantity: 2 }, { name: "Ester Grease", quantity: 2 }, { name: "Sharpening Grit", quantity: 4 }, { name: "Diamond Dust", quantity: 1 }, { name: "Mahakaman Steel", quantity: 3 }, { name: "Ruby Dust", quantity: 1 }] },
    "cheval halfpike":              { dc: 24, time: "7 Hour", investment: 725, price: 1668,
        components: [{ name: "Coal", quantity: 21 }, { name: "Hardened Timber", quantity: 18 }, { name: "Resin", quantity: 3 }, { name: "Hardened Leather", quantity: 1 }, { name: "Ester Grease", quantity: 5 }, { name: "Sharpening Grit", quantity: 3 }, { name: "Diamond Dust", quantity: 1 }, { name: "Mahakaman Steel", quantity: 1 }] },
    "cheval pollax":                { dc: 25, time: "14 Hour", investment: 936, price: 2153,
        components: [{ name: "Coal", quantity: 48 }, { name: "Hardened Timber", quantity: 20 }, { name: "Resin", quantity: 5 }, { name: "Sharpening Grit", quantity: 3 }, { name: "Diamond Dust", quantity: 1 }, { name: "Mahakaman Steel", quantity: 3 }] },
    "cheval lance":                 { dc: 25, time: "12 Hour", investment: 736, price: 1633,
        components: [{ name: "Coal", quantity: 36 }, { name: "Resin", quantity: 2 }, { name: "Hardened Timber", quantity: 20 }, { name: "Timber", quantity: 5 }, { name: "Hardened Leather", quantity: 1 }, { name: "Drake Oil", quantity: 3 }, { name: "Sharpening Grit", quantity: 2 }, { name: "Mahakaman Steel", quantity: 1 }] },
    "cheval arm harnisse":          { dc: 26, time: "12 Hour", investment: 881, price: 2027,
        components: [{ name: "Coal", quantity: 60 }, { name: "Oil", quantity: 15 }, { name: "Leather", quantity: 4 }, { name: "Ester Grease", quantity: 4 }, { name: "Darkening Oil", quantity: 4 }, { name: "Drake Oil", quantity: 2 }, { name: "Mahakaman Steel", quantity: 3 }, { name: "Sapphire Dust", quantity: 1 }] },
    "cheval leg harnisse":          { dc: 26, time: "12 Hour", investment: 1049, price: 2413,
        components: [{ name: "Coal", quantity: 60 }, { name: "Oil", quantity: 25 }, { name: "Leather", quantity: 4 }, { name: "Ester Grease", quantity: 4 }, { name: "Darkening Oil", quantity: 5 }, { name: "Drake Oil", quantity: 2 }, { name: "Mahakaman Steel", quantity: 4 }, { name: "Sapphire Dust", quantity: 1 }] },

    /* ── Dwarven / Eldercraft weapons + armor (EO p.55-58) ────────────*/
    "dwarven cleaver":              { dc: 19, time: "4 Hour", investment: 343, price: 789,
        components: [{ name: "Coal", quantity: 16 }, { name: "Resin", quantity: 1 }, { name: "Thread", quantity: 1 }, { name: "Draconid Leather", quantity: 1 }, { name: "Ester Grease", quantity: 1 }, { name: "Etching Acid", quantity: 2 }, { name: "Sharpening Grit", quantity: 2 }, { name: "Emerald Dust", quantity: 1 }, { name: "Meteorite", quantity: 1 }] },
    "dwarven axe":                  { dc: 23, time: "8 Hour", investment: 677, price: 1558,
        components: [{ name: "Coal", quantity: 24 }, { name: "Hardened Timber", quantity: 5 }, { name: "Resin", quantity: 3 }, { name: "Drake Oil", quantity: 2 }, { name: "Etching Acid", quantity: 4 }, { name: "Ogre Wax", quantity: 3 }, { name: "Sharpening Grit", quantity: 4 }, { name: "Mahakaman Steel", quantity: 1 }, { name: "Meteorite", quantity: 1 }, { name: "Ruby Dust", quantity: 1 }] },
    "dwarven spear":                { dc: 22, time: "6 Hour", investment: 680, price: 1564,
        components: [{ name: "Coal", quantity: 18 }, { name: "Hardened Timber", quantity: 10 }, { name: "Resin", quantity: 3 }, { name: "Draconid Leather", quantity: 2 }, { name: "Etching Acid", quantity: 2 }, { name: "Ogre Wax", quantity: 1 }, { name: "Sharpening Grit", quantity: 2 }, { name: "Mahakaman Steel", quantity: 1 }, { name: "Meteorite", quantity: 1 }] },
    "dwarven martel":               { dc: 25, time: "13 Hour", investment: 957, price: 2202,
        components: [{ name: "Coal", quantity: 48 }, { name: "Draconid Leather", quantity: 1 }, { name: "Drake Oil", quantity: 5 }, { name: "Ester Grease", quantity: 2 }, { name: "Etching Acid", quantity: 2 }, { name: "Ogre Wax", quantity: 5 }, { name: "Sharpening Grit", quantity: 1 }, { name: "Mahakaman Steel", quantity: 2 }, { name: "Meteorite", quantity: 1 }, { name: "Ruby Dust", quantity: 2 }] },
    "dwarven impact":               { dc: 19, time: "5 Hour", investment: 154, price: 355,
        components: [{ name: "Coal", quantity: 10 }, { name: "Resin", quantity: 2 }, { name: "Timber", quantity: 4 }, { name: "Feathers", quantity: 1 }, { name: "Ogre Wax", quantity: 1 }, { name: "Mahakaman Steel", quantity: 1 }] },
    "dwarven crossbow":             { dc: 25, time: "20 Hour", investment: 918, price: 2112,
        components: [{ name: "Hardened Timber", quantity: 15 }, { name: "Silk", quantity: 8 }, { name: "Ogre Wax", quantity: 5 }, { name: "Mahakaman Steel", quantity: 2 }] },
    "dwarven hood":                 { dc: 18, time: "4 Hour", investment: 224, price: 515,
        components: [{ name: "Double Woven Linen", quantity: 3 }, { name: "Thread", quantity: 3 }, { name: "Hardened Leather", quantity: 1 }, { name: "Leather", quantity: 1 }, { name: "Drake Oil", quantity: 1 }, { name: "Ester Grease", quantity: 1 }, { name: "Ogre Wax", quantity: 2 }] },

    /* ── Elven / Eldercraft weapons (EO p.55-58) ──────────────────────*/
    "elven messer":                 { dc: 19, time: "8 Hour", investment: 434, price: 999,
        components: [{ name: "Coal", quantity: 24 }, { name: "Hardened Timber", quantity: 2 }, { name: "Resin", quantity: 1 }, { name: "Silk", quantity: 1 }, { name: "Ester Grease", quantity: 1 }, { name: "Etching Acid", quantity: 2 }, { name: "Sharpening Grit", quantity: 4 }, { name: "Emerald Dust", quantity: 1 }, { name: "Steel", quantity: 2 }] },
    "elven glaive":                 { dc: 21, time: "10 Hour", investment: 608, price: 1399,
        components: [{ name: "Coal", quantity: 30 }, { name: "Hardened Timber", quantity: 15 }, { name: "Ester Grease", quantity: 5 }, { name: "Etching Acid", quantity: 3 }, { name: "Sharpening Grit", quantity: 4 }, { name: "Dark Steel", quantity: 2 }] },
    "elven walking stick":          { dc: 24, time: "15 Hour", investment: 1886, price: 4338,
        components: [{ name: "Hardened Timber", quantity: 10 }, { name: "Fifth Essence", quantity: 5 }, { name: "Infused Dust", quantity: 5 }, { name: "Emerald Dust", quantity: 2 }, { name: "Ruby Dust", quantity: 2 }, { name: "Sapphire Dust", quantity: 2 }] },
    "elven burrower":               { dc: 19, time: "6 Hour", investment: 208, price: 479,
        components: [{ name: "Coal", quantity: 18 }, { name: "Resin", quantity: 1 }, { name: "Timber", quantity: 2 }, { name: "Wax", quantity: 1 }, { name: "Feathers", quantity: 2 }, { name: "Sharpening Grit", quantity: 3 }, { name: "Dark Steel", quantity: 1 }] },
    "vrihedd sabre":                { dc: 21, time: "9 Hour", investment: 589, price: 1355,
        components: [{ name: "Coal", quantity: 36 }, { name: "Hardened Timber", quantity: 2 }, { name: "Resin", quantity: 2 }, { name: "Silk", quantity: 1 }, { name: "Thread", quantity: 1 }, { name: "Draconid Leather", quantity: 1 }, { name: "Etching Acid", quantity: 2 }, { name: "Sharpening Grit", quantity: 4 }, { name: "Dark Steel", quantity: 2 }, { name: "Emerald Dust", quantity: 1 }] },
    "tir tochair blade":            { dc: 28, time: "14 Hour", investment: 1025, price: 2358,
        components: [{ name: "Coal", quantity: 60 }, { name: "Hardened Timber", quantity: 6 }, { name: "Resin", quantity: 4 }, { name: "Thread", quantity: 3 }, { name: "Draconid Leather", quantity: 2 }, { name: "Ester Grease", quantity: 2 }, { name: "Sharpening Grit", quantity: 6 }, { name: "Mahakaman Dimeritium", quantity: 1 }, { name: "Mahakaman Steel", quantity: 2 }] },
    "meteorite flail":              { dc: 24, time: "6 Hour", investment: 647, price: 1489,
        components: [{ name: "Coal", quantity: 24 }, { name: "Hardened Timber", quantity: 4 }, { name: "Resin", quantity: 5 }, { name: "Draconid Leather", quantity: 2 }, { name: "Drake Oil", quantity: 3 }, { name: "Ester Grease", quantity: 1 }, { name: "Ogre Wax", quantity: 6 }, { name: "Emerald Dust", quantity: 1 }, { name: "Meteorite", quantity: 2 }] },

    /* ── Gnomish / Eldercraft (EO p.55-58) ────────────────────────────*/
    "gnomish gwyhyr":               { dc: 26, time: "12 Hour", investment: 870, price: 2001,
        components: [{ name: "Coal", quantity: 40 }, { name: "Hardened Timber", quantity: 4 }, { name: "Resin", quantity: 3 }, { name: "Thread", quantity: 2 }, { name: "Draconid Leather", quantity: 1 }, { name: "Ester Grease", quantity: 1 }, { name: "Sharpening Grit", quantity: 5 }, { name: "Mahakaman Dimeritium", quantity: 1 }, { name: "Mahakaman Steel", quantity: 2 }] },
    "gnomish bardak":               { dc: 26, time: "13 Hour", investment: 964, price: 2218,
        components: [{ name: "Coal", quantity: 48 }, { name: "Darkening Oil", quantity: 5 }, { name: "Draconid Leather", quantity: 2 }, { name: "Ester Grease", quantity: 2 }, { name: "Etching Acid", quantity: 5 }, { name: "Sharpening Grit", quantity: 5 }, { name: "Mahakaman Steel", quantity: 3 }, { name: "Sapphire Dust", quantity: 2 }] },
    "gnomish staff":                { dc: 23, time: "9 Hour", investment: 1502, price: 3455,
        components: [{ name: "Coal", quantity: 36 }, { name: "Infused Dust", quantity: 3 }, { name: "Fifth Essence", quantity: 3 }, { name: "Dark Steel", quantity: 2 }, { name: "Sapphire Dust", quantity: 5 }] },
    "gnomish mail hood":            { dc: 25, time: "16 Hour", investment: 467, price: 1075,
        components: [{ name: "Coal", quantity: 48 }, { name: "Oil", quantity: 5 }, { name: "Darkening Oil", quantity: 3 }, { name: "Mahakaman Steel", quantity: 2 }, { name: "Sapphire Dust", quantity: 1 }] },
    "gnomish mail trousers":        { dc: 25, time: "20 Hour", investment: 922, price: 2121,
        components: [{ name: "Coal", quantity: 60 }, { name: "Oil", quantity: 10 }, { name: "Darkening Oil", quantity: 6 }, { name: "Draconid Leather", quantity: 2 }, { name: "Ester Grease", quantity: 4 }, { name: "Mahakaman Steel", quantity: 2 }, { name: "Sapphire Dust", quantity: 3 }] },

    /* ── Mahakaman armor (heavy dwarven plate) (EO p.58) ──────────────*/
    "mahakaman breastplate":        { dc: 28, time: "20 Hour", investment: 1500, price: 3450,
        components: [{ name: "Coal", quantity: 100 }, { name: "Oil", quantity: 24 }, { name: "Leather", quantity: 3 }, { name: "Darkening Oil", quantity: 4 }, { name: "Drake Oil", quantity: 4 }, { name: "Ester Grease", quantity: 3 }, { name: "Etching Acid", quantity: 16 }, { name: "Mahakaman Steel", quantity: 8 }] },
    "mahakaman arm harnisse":       { dc: 28, time: "15 Hour", investment: 1152, price: 2650,
        components: [{ name: "Coal", quantity: 75 }, { name: "Oil", quantity: 18 }, { name: "Leather", quantity: 3 }, { name: "Darkening Oil", quantity: 3 }, { name: "Drake Oil", quantity: 3 }, { name: "Ester Grease", quantity: 3 }, { name: "Etching Acid", quantity: 12 }, { name: "Mahakaman Steel", quantity: 6 }] },
    "mahakaman leg harnisse":       { dc: 28, time: "15 Hour", investment: 1307, price: 3007,
        components: [{ name: "Coal", quantity: 75 }, { name: "Oil", quantity: 21 }, { name: "Leather", quantity: 3 }, { name: "Darkening Oil", quantity: 4 }, { name: "Drake Oil", quantity: 3 }, { name: "Ester Grease", quantity: 3 }, { name: "Etching Acid", quantity: 14 }, { name: "Mahakaman Steel", quantity: 7 }] },

    /* ── Scoia'tael armor (light woodland) (EO p.57-58) ───────────────*/
    "scoia'tael hood":              { dc: 15, time: "3 Hour", investment: 192, price: 442,
        components: [{ name: "Linen", quantity: 4 }, { name: "Thread", quantity: 2 }, { name: "Feathers", quantity: 1 }, { name: "Darkening Oil", quantity: 2 }, { name: "Ester Grease", quantity: 1 }, { name: "Emerald Dust", quantity: 1 }] },
    "scoia'tael cloak":              { dc: 15, time: "6 Hour", investment: 348, price: 1243,
        components: [{ name: "Linen", quantity: 12 }, { name: "Thread", quantity: 6 }, { name: "Feathers", quantity: 3 }, { name: "Darkening Oil", quantity: 4 }, { name: "Ester Grease", quantity: 3 }, { name: "Emerald Dust", quantity: 1 }] },
    "scoia'tael brigandine":         { dc: 20, time: "12 Hour", investment: 935, price: 2151,
        components: [{ name: "Coal", quantity: 60 }, { name: "Linen", quantity: 10 }, { name: "Oil", quantity: 18 }, { name: "Thread", quantity: 5 }, { name: "Feathers", quantity: 10 }, { name: "Darkening Oil", quantity: 6 }, { name: "Drake Oil", quantity: 2 }, { name: "Ester Grease", quantity: 3 }, { name: "Dark Steel", quantity: 4 }, { name: "Emerald Dust", quantity: 1 }] },
    "scoia'tael chausses":           { dc: 20, time: "10 Hour", investment: 911, price: 2096,
        components: [{ name: "Coal", quantity: 50 }, { name: "Linen", quantity: 20 }, { name: "Oil", quantity: 10 }, { name: "Thread", quantity: 10 }, { name: "Feathers", quantity: 12 }, { name: "Darkening Oil", quantity: 6 }, { name: "Drake Oil", quantity: 3 }, { name: "Ester Grease", quantity: 5 }, { name: "Dark Steel", quantity: 2 }, { name: "Emerald Dust", quantity: 1 }] },

    /* ── Wyvern Scale Shield (EO p.57) ────────────────────────────────*/
    "wyvern scale shield":          { dc: 23, time: "6 Hour", investment: 407, price: 937,
        components: [{ name: "Ashes", quantity: 5 }, { name: "Draconid Leather", quantity: 3 }, { name: "Draconid Scales", quantity: 3 }, { name: "Essence of Fire", quantity: 3 }] },

    /* ── Armor decorations (EO p.6) ───────────────────────────────────
     * The "Other Armor Improvements" section doesn't have a tabular
     * recipe — we mint reasonable approximations for the missing motifs. */
    "beast motif":                  { dc: 12, time: "2 Hour", investment: 30, price: 69,
        components: [{ name: "Leather", quantity: 1 }, { name: "Beast Bones", quantity: 1 }, { name: "Thread", quantity: 1 }] },
    "bluing/enamelling":            { dc: 14, time: "3 Hour", investment: 52, price: 118,
        components: [{ name: "Coal", quantity: 3 }, { name: "Oil", quantity: 2 }, { name: "Etching Acid", quantity: 1 }] },
    "officer's wings":              { dc: 14, time: "3 Hour", investment: 62, price: 143,
        components: [{ name: "Linen", quantity: 1 }, { name: "Thread", quantity: 2 }, { name: "Feathers", quantity: 6 }, { name: "Wax", quantity: 1 }] }
};

/* ── Walk diagrams and patch them ────────────────────────────────── */

console.log("→ Linking diagram components…");
let linkedDiagrams = 0;
let totalRefs = 0, unresolved = 0;
const unresolvedNames = new Set();

const files = readdirSync(SRC_DIA).filter(f => f.endsWith(".json") && !f.startsWith("_folder_"));
for (const f of files) {
    const fp = resolve(SRC_DIA, f);
    const doc = JSON.parse(readFileSync(fp, "utf8"));
    if (!doc.system) continue;

    /* Diagram name is just the item name (the early generator prefixed
     * "Diagram: "; gen-eo-catalog.mjs now drops it). Tolerate the legacy
     * prefix in case an old build is being re-linked. */
    const itemName = doc.name.replace(/^Diagram:\s*/, "").trim();
    if (!itemName) continue;
    const key = itemName.toLowerCase();
    /* MANUAL_RECIPES override the parser — for items whose PDF table
     * layout the parser can't safely extract, the hand-authored recipe
     * is the source of truth. */
    const recipe = MANUAL_RECIPES[key]
        || recipeMap.get(key)
        || recipeMap.get(DIAGRAM_ALIASES[key] ?? "__none__");
    if (!recipe) {
        /* No PDF recipe for this item — leave its components empty,
         * but log for the inconsistency report. */
        noteIssue(`No PDF recipe for diagram "${doc.name}"`);
        continue;
    }

    /* Build resolved components. */
    const linkedComps = [];
    for (const comp of recipe.components) {
        totalRefs++;
        const found = resolveComponent(comp.name);
        if (!found) {
            unresolved++;
            unresolvedNames.add(comp.name);
            /* Still record the component by name so the GM sees it on
             * the sheet, just without a UUID link. */
            linkedComps.push({ uuid: "", name: comp.name, quantity: comp.quantity });
        } else {
            linkedComps.push({
                uuid: `Compendium.${SYSTEM_ID}.${found.pack}.Item.${found._id}`,
                name: found.name,
                quantity: comp.quantity
            });
        }
    }

    /* Patch the diagram. */
    doc.system.craftingComponents = linkedComps;
    if (recipe.dc !== null && Number.isFinite(recipe.dc)) {
        doc.system.craftingDC = recipe.dc;
    }
    if (recipe.time) doc.system.craftingTime = recipe.time;
    if (Number.isFinite(recipe.investment)) doc.system.investment = recipe.investment;
    if (Number.isFinite(recipe.price)) doc.system.cost = recipe.price;

    /* Tier inference from the DC: <12 novice, 12-15 journeyman, 16-19 master, 20+ grandmaster. */
    if (recipe.dc) {
        if (recipe.dc < 12)      doc.system.level = "novice";
        else if (recipe.dc < 16) doc.system.level = "journeyman";
        else if (recipe.dc < 20) doc.system.level = "master";
        else                     doc.system.level = "grandmaster";
    }

    writeFileSync(fp, JSON.stringify(doc, null, 2));
    linkedDiagrams++;
}

console.log(`  Linked ${linkedDiagrams} diagrams.`);
console.log(`  Component references: ${totalRefs} total, ${unresolved} unresolved (${unresolvedNames.size} distinct names).`);

if (unresolvedNames.size) {
    console.log("\nUnresolved component names (need adding to packs/ or to ALIAS map):");
    for (const n of [...unresolvedNames].sort()) console.log(`  - ${n}`);
}

if (INCONSISTENCIES.length) {
    console.log(`\nInconsistencies (${INCONSISTENCIES.length}):`);
    for (const s of INCONSISTENCIES.slice(0, 30)) console.log(`  - ${s}`);
    if (INCONSISTENCIES.length > 30) console.log(`  … and ${INCONSISTENCIES.length - 30} more`);
}
