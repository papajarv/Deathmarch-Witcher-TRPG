// tools/gen-books.mjs
//
// Generate packs-src/books/*.json from the authored JS source arrays at
// /home/coder/shared/witcher_foundry_knowledge_base/{CommonDescriptiveBooks,
// Novels,Odd Books,Romance}.js
//
// Each source file is one Foundry compendium folder (Lore / Novels / Odd /
// Romance). Each book becomes a `book`-type Item with system.bookConfig.stress
// populated from chapters[].
//
// Stress rule (per user directive):
//   - Per-chapter stress is a "rollercoaster" — swings between -2 and +2.
//   - Most books net -1 total stress (calming, with a wobble); some net 0.
//   - Roughly 75/25 split, deterministic per book name.
//
// Source values are ignored; this script derives a fresh rollercoaster from
// the chapter count so the curve is consistent across the pack. Run:
//   node tools/gen-books.mjs
// Then:
//   node tools/build-packs.mjs books

import { existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, "..");
const OUT_DIR   = resolve(ROOT, "packs-src/books");
const KB_DIR    = "/home/coder/shared/witcher_foundry_knowledge_base";

/* ── Sources ─────────────────────────────────────────────────────────── */

const SOURCES = [
    { file: "CommonDescriptiveBooks.js", folder: "Lore",     img: "icons/sundries/books/book-worn-brown.webp" },
    { file: "Novels.js",                 folder: "Novels",   img: "icons/sundries/books/book-worn-purple.webp" },
    { file: "Odd Books.js",              folder: "Odd",      img: "icons/sundries/books/book-tooled-eye-gold-red.webp" },
    { file: "Romance.js",                folder: "Romance",  img: "icons/sundries/books/book-worn-red.webp" },
    { file: "Bestiary.js",               folder: "Bestiary", img: "icons/sundries/books/book-worn-green.webp" }
];

/* Icon pools per folder — real Foundry icon slugs (no `.webp`, no prefix).
 * Each book gets a deterministic pick from its folder's pool. Bestiary uses
 * its category pool instead (see BESTIARY_ICONS below). All paths verified
 * against the Foundry core icon set. */
const FOLDER_ICON_POOL = {
    Lore: [
        "book-worn-brown", "book-worn-brown-grey", "book-simple-brown", "book-plain-orange",
        "book-backed-wood-tan", "book-embossed-bound-brown", "book-embossed-clasp-gold-brown",
        "book-embossed-steel-brown", "book-tooled-brass-brown", "book-tooled-gold-brown",
        "book-open-brown", "book-open-brown-black", "book-symbol-anchor-brown",
        "book-symbol-axe-brown", "book-symbol-plant-brown", "book-symbol-link-brown",
        "book-symbol-triangle-silver-brown", "book-symbol-anchor", "book-notes-ragged-green",
        "book-embossed-blue", "book-tooled-blue-yellow", "book-tooled-silver-blue",
        "book-notebook-spiral-blue", "book-tooled-green", "book-embossed-gold-green"
    ],
    Novels: [
        "book-worn-purple", "book-worn-teal", "book-worn-red", "book-worn-blue", "book-worn-green",
        "book-backed-blue-gold", "book-backed-silver-red", "book-backed-wood-tan",
        "book-embossed-blue", "book-embossed-jewel-blue-red", "book-embossed-jewel-gold-green",
        "book-embossed-jewel-silver-green", "book-embossed-jewel-gold-purple",
        "book-tooled-blue-yellow", "book-tooled-gold-brown", "book-tooled-gold-purple",
        "book-tooled-silver-blue", "book-turquoise-moon", "book-open-brown", "book-open-purple",
        "book-open-turquoise", "book-open-red", "book-rounded-blue", "book-rounded-teal",
        "book-symbol-canterbury-cross", "book-embossed-gold-red"
    ],
    Odd: [
        "book-eye-pink", "book-eye-purple", "book-eye-red", "book-tooled-eye-gold-red",
        "book-face-black", "book-face-blue", "book-symbol-hexagram-silver-red",
        "book-symbol-spiral-silver-blue", "book-symbol-skull-grey", "book-symbol-yellow-grey",
        "book-black-grey", "book-mimic", "book-purple-glyph", "book-purple-gem",
        "book-purple-detail", "book-purple-cross", "book-embossed-spiral-purple-white",
        "book-notes-ragged-green", "book-symbol-canterbury-cross", "book-symbol-reverse-blue"
    ],
    Romance: [
        "book-worn-red", "book-worn-purple", "book-embossed-gold-red",
        "book-embossed-jewel-gold-purple", "book-embossed-jewel-blue-red",
        "book-purple-detail", "book-purple-gem", "book-tooled-gold-purple",
        "book-open-red", "book-open-purple", "book-rounded-red", "book-rounded-clasp-red",
        "book-red-square"
    ]
};

/* Per-Bestiary-category icon pools. Categories are MONSTER_TYPES keys and
 * are looked up via bestiary-categories.json. */
const BESTIARY_ICONS = {
    beast: [
        "book-symbol-plant-brown", "book-symbol-anchor-brown", "book-simple-brown",
        "book-worn-brown-grey", "book-symbol-leaf-green", "book-embossed-bound-brown"
    ],
    necrophage: [
        "book-symbol-skull-grey", "book-face-black", "book-black-grey",
        "book-worn-brown", "book-symbol-hexagram-silver-red", "book-red-exclamation"
    ],
    specter: [
        "book-eye-purple", "book-eye-pink", "book-embossed-spiral-purple-white",
        "book-worn-purple", "book-turquoise-moon", "book-symbol-triangle-silver-purple",
        "book-face-blue", "book-symbol-cross-blue"
    ],
    vampire: [
        "book-symbol-bat-red", "book-red-cross", "book-tooled-eye-gold-red",
        "book-embossed-gold-red", "book-red-square", "book-worn-red"
    ],
    insectoid: [
        "book-symbol-triangle-silver-brown", "book-symbol-square-blue-green",
        "book-symbol-triangle-blue", "book-symbol-triangle-silver-blue",
        "book-embossed-steel-brown", "book-tooled-grey"
    ],
    ogroid: [
        "book-symbol-axe-brown", "book-embossed-steel-green", "book-embossed-bound-brown",
        "book-tooled-brass-brown", "book-embossed-clasp-gold-brown", "book-clasp-spiral-green"
    ],
    draconid: [
        "book-reye-reptile-brown", "book-symbol-fire-gold-orange",
        "book-embossed-gold-green", "book-tooled-gold-brown"
    ],
    cursedOne: [
        "book-symbol-hexagram-silver-red", "book-mimic",
        "book-eye-red", "book-embossed-jewel-blue-red"
    ],
    relict: [
        "book-embossed-roots-green", "book-symbol-tree-silver-green",
        "book-symbol-leaf-gold-green", "book-leaves-circle", "book-worn-green",
        "book-embossed-gold-green", "book-symbol-plant-brown", "book-symbol-spiral-silver-blue"
    ],
    elementa: [
        "book-symbol-fire-gold-orange", "book-teal-lightning",
        "book-symbol-lightning-silver-blue", "book-embossed-jewel-silver-green",
        "book-embossed-steel-brown"
    ],
    hybrid: [
        "book-symbol-triangle-silver-purple", "book-purple-detail",
        "book-embossed-jewel-gold-purple", "book-tooled-gold-purple",
        "book-symbol-canterbury-cross"
    ],
    humanoid: ["book-symbol-triangle-blue"]
};

/* ── Helpers ─────────────────────────────────────────────────────────── */

/** 16-char hex id, deterministic from a string. */
function hashId(input) {
    return createHash("sha1").update(input).digest("hex").slice(0, 16);
}

/** Mulberry32 PRNG. */
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Seed an int from a string for the PRNG. */
function strSeed(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

/** Generate a rollercoaster sequence of N ints summing to target.
 *  Values in roughly [-2, +2]; biased slightly negative; never flat. */
function rollercoaster(N, target, rng) {
    if (N <= 0) return [];
    if (N === 1) return [target];
    if (N === 2) {
        const pairs = target === -1
            ? [[+1, -2], [-2, +1], [+2, -3], [-1, 0], [0, -1]]
            : [[+1, -1], [-1, +1], [+2, -2], [-2, +2], [0, 0]];
        return pairs[Math.floor(rng() * pairs.length)];
    }
    /* Pool biased toward small-negative & small-positive; rare extremes. */
    const pool = [-2, -1, -1, -1, 0, 0, +1, +1, +2];
    const out  = [];
    let sum = 0;
    for (let i = 0; i < N - 1; i++) {
        const v = pool[Math.floor(rng() * pool.length)];
        out.push(v);
        sum += v;
    }
    let last = target - sum;
    /* If last lands outside [-3, +3], shuttle ±1 from random earlier entries
     * until it's in range — preserves the swing feel and the exact total. */
    let guard = 0;
    while ((last > 3 || last < -3) && guard++ < 200) {
        const idx = Math.floor(rng() * (N - 1));
        if (last > 3) { out[idx] += 1; last -= 1; }
        else          { out[idx] -= 1; last += 1; }
    }
    out.push(last);
    /* Ensure not perfectly flat (all zeros) — rare but possible when target=0. */
    if (out.every(v => v === 0)) {
        const idx1 = Math.floor(rng() * N);
        let idx2 = Math.floor(rng() * N);
        while (idx2 === idx1) idx2 = Math.floor(rng() * N);
        out[idx1] = +1; out[idx2] = -1;
    }
    return out;
}

/** Slugify a name for filenames. */
function slug(s) {
    return s.toLowerCase()
        .replace(/[''']/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60);
}

/* ── Source loader (handles truncated CommonDescriptiveBooks.js) ─────── */

function loadJsArray(filePath) {
    let src = readFileSync(filePath, "utf8");

    /* CommonDescriptiveBooks.js cuts off mid-text inside the second chapter
     * of "Colors of Rank". Patch the open structures before parsing. */
    if (filePath.endsWith("CommonDescriptiveBooks.js")) {
        const marker = "The author notes that clothing lies as";
        const cut    = src.indexOf(marker);
        if (cut !== -1) {
            const chapterStart = src.lastIndexOf("{ text:", cut);
            src = src.slice(0, chapterStart);
            src += `{ text: "The second chapter compares regional habits, from practical Kaedweni wool to richer Pontar merchant fashions and courtly display in southern halls. Clothing marks rank in ways both obvious and subtle, and the price of dressing incorrectly can range from embarrassment to dangerous misunderstanding.", stress: 0 }\n]\n}\n]`;
        }
    }

    /* Strip any leading prose before the first '['. Some files concatenate
     * multiple top-level arrays — walk them. */
    const startIdx = src.indexOf("[");
    if (startIdx === -1) return [];
    const raw = src.slice(startIdx);

    let out = [];
    let i = 0;
    while (i < raw.length) {
        const arrStart = raw.indexOf("[", i);
        if (arrStart === -1) break;
        let depth = 0, j = arrStart;
        while (j < raw.length) {
            const c = raw[j];
            if (c === "[") depth++;
            else if (c === "]") { depth--; if (depth === 0) { j++; break; } }
            j++;
        }
        const chunk = raw.slice(arrStart, j);
        /* eslint-disable-next-line no-new-func */
        const arr = (new Function(`return (${chunk});`))();
        out = out.concat(arr);
        i = j;
    }
    return out;
}

/* ── Build ───────────────────────────────────────────────────────────── */

/* Clear existing book JSONs (deterministic regen). */
/* Only wipe files we're about to regenerate. `gen-skill-books.mjs` writes
 * skill-*.json + _folder_skill.json into the same directory; leaving them
 * alone keeps the two generators co-existing. */
const OWNED_PREFIXES = ["lore-", "novels-", "odd-", "romance-", "bestiary-", "_folder_lore", "_folder_novels", "_folder_odd", "_folder_romance", "_folder_bestiary"];
for (const f of readdirSync(OUT_DIR)) {
    if (!f.endsWith(".json")) continue;
    if (!OWNED_PREFIXES.some(p => f.startsWith(p))) continue;
    unlinkSync(join(OUT_DIR, f));
}

let totalItems = 0;
const seenNames = new Map(); // dedupe slugs across all sources

/* Optional Bestiary category map. When present and the current source is
 * Bestiary, each book is placed into a per-category subfolder. */
let bestiaryMap = null;
try {
    const raw = readFileSync(resolve(__dirname, "bestiary-categories.json"), "utf8");
    bestiaryMap = JSON.parse(raw);
} catch (_) { /* absent → skip subfolder logic */ }

/* Optional bestiary UUID map — resolves monster names to compendium UUIDs
 * so Bestiary books with a `study` field can be emitted as first-class
 * monster-lore books. Regenerate via a small helper if the bestiary is
 * rebuilt with new IDs. */
let bestiaryUuids = null;
try {
    const raw = readFileSync(resolve(__dirname, "bestiary-uuids.json"), "utf8");
    bestiaryUuids = JSON.parse(raw);
} catch (_) { /* absent → study configs land as list mode with empty targets */ }

for (const { file, folder, img } of SOURCES) {
    const arr = loadJsArray(join(KB_DIR, file));
    const folderId = hashId(`book-folder-${folder}`);

    /* Emit root folder doc. */
    const folderDoc = {
        _id: folderId,
        name: folder,
        type: "Item",
        folder: null,
        sorting: "a",
        description: "",
        color: null,
        sort: 100,
        flags: {}
    };
    writeFileSync(
        join(OUT_DIR, `_folder_${slug(folder)}.json`),
        JSON.stringify(folderDoc, null, 2) + "\n"
    );

    /* Bestiary: emit one subfolder per referenced category. Sorting is by
     * display-name so the folder tree reads alphabetically. */
    const subFolderIds = {};
    if (folder === "Bestiary" && bestiaryMap) {
        const usedCats = new Set(arr.map(b => bestiaryMap.categories[b?.name]).filter(Boolean));
        const ordered = [...usedCats].sort((a, b) => (bestiaryMap.displayNames[a] || a).localeCompare(bestiaryMap.displayNames[b] || b));
        let subSort = 100;
        for (const cat of ordered) {
            const subId = hashId(`book-folder-${folder}-${cat}`);
            subFolderIds[cat] = subId;
            writeFileSync(
                join(OUT_DIR, `_folder_${slug(folder)}-${slug(cat)}.json`),
                JSON.stringify({
                    _id: subId,
                    name: bestiaryMap.displayNames[cat] || cat,
                    type: "Item",
                    folder: folderId,
                    sorting: "a",
                    description: "",
                    color: null,
                    sort: subSort,
                    flags: {}
                }, null, 2) + "\n"
            );
            subSort += 100;
        }
    }

    let itemSort = 100;
    for (const book of arr) {
        if (!book?.name || !Array.isArray(book.chapters) || !book.chapters.length) continue;

        const rng = mulberry32(strSeed(`book:${book.name}`));
        /* 75% net -1, 25% net 0 — deterministic per book. */
        const target = rng() < 0.75 ? -1 : 0;
        const stressSeq = rollercoaster(book.chapters.length, target, rng);

        const steps = book.chapters.map((ch, i) => ({
            text:         ch.text,
            stressChange: stressSeq[i]
        }));

        const id = hashId(`book:${book.name}`);
        const fileSlug = slug(book.name);
        let outName = `${slug(folder)}-${fileSlug}`;
        if (seenNames.has(outName)) {
            outName = `${outName}-${id.slice(0, 4)}`;
        }
        seenNames.set(outName, true);

        /* Deterministic icon pick. Bestiary uses its per-category pool via
         * bestiary-categories.json; every other folder uses its FOLDER pool.
         * Fallback to the SOURCES `img` if no pool matches. */
        let iconSlug = null;
        if (folder === "Bestiary" && bestiaryMap) {
            const cat  = bestiaryMap.categories[book.name];
            const pool = BESTIARY_ICONS[cat] || BESTIARY_ICONS.beast;
            iconSlug   = pool[strSeed(`icon:${book.name}`) % pool.length];
        } else if (FOLDER_ICON_POOL[folder]) {
            const pool = FOLDER_ICON_POOL[folder];
            iconSlug   = pool[strSeed(`icon:${book.name}`) % pool.length];
        }
        const bookImg = iconSlug ? `icons/sundries/books/${iconSlug}.webp` : img;

        /* Bestiary books carry a `study` config on the source entry. When
         * present, the book is emitted as `bookType: "monster"` with the
         * study rules populated. Monster names resolve to compendium UUIDs
         * via bestiary-uuids.json — unknown names are dropped from the
         * target list with a console warning. */
        let bookType     = "stress";
        let monsterCfg   = {};
        let bookCost     = folder === "Lore" ? 25 : (folder === "Novels" ? 15 : 10);
        let bookAvail    = folder === "Odd" ? "rare" : "common";
        if (folder === "Bestiary" && book.study) {
            bookType = "monster";
            const s = book.study;
            if (s.mode === "specific") {
                const uuid = bestiaryUuids?.[s.target] ?? "";
                if (!uuid) console.warn(`  WARN unknown monster: ${s.target} (from "${book.name}")`);
                monsterCfg = {
                    mode: "specific",
                    specificKey: uuid,
                    listKeys: [],
                    filter: { category: "", difficultyOp: "any", difficultyValue: "", environment: "" },
                    dc: s.dc,
                    totalReadings: s.totalReadings,
                    rpPerReading: s.rpPerReading,
                    commonKnowledgeReading: s.commonKnowledgeReading,
                    secondKnowledgeReading: s.secondKnowledgeReading
                };
            } else if (s.mode === "list") {
                const uuids = (s.targets ?? []).map(n => {
                    const u = bestiaryUuids?.[n];
                    if (!u) console.warn(`  WARN unknown monster: ${n} (from "${book.name}")`);
                    return u;
                }).filter(Boolean);
                monsterCfg = {
                    mode: "list",
                    specificKey: "",
                    listKeys: uuids,
                    filter: { category: "", difficultyOp: "any", difficultyValue: "", environment: "" },
                    dc: s.dc,
                    totalReadings: s.totalReadings,
                    rpPerReading: s.rpPerReading,
                    commonKnowledgeReading: s.commonKnowledgeReading,
                    secondKnowledgeReading: s.secondKnowledgeReading
                };
            }
            if (typeof s.cost === "number")         bookCost  = s.cost;
            if (typeof s.availability === "string") bookAvail = s.availability;
        }

        const doc = {
            _id: id,
            name: book.name,
            type: "book",
            img: bookImg,
            system: {
                description: book.desc
                    ? `<p>${String(book.desc).replace(/\n+/g, "</p><p>")}</p>`
                    : `<p><em>A ${folder.toLowerCase()} volume of the North, ${book.chapters.length} chapter${book.chapters.length === 1 ? "" : "s"}.</em></p>`,
                weight: 0.5,
                cost: bookCost,
                quantity: 1,
                equipped: false,
                isStored: false,
                encumb: 0,
                class: "",
                source: "",
                consumable: false,
                availability: bookAvail,
                bookConfig: {
                    bookType,
                    monster: monsterCfg,
                    skill:   {},
                    stress:  { steps }
                }
            },
            effects: [],
            folder: (folder === "Bestiary" && bestiaryMap && subFolderIds[bestiaryMap.categories[book.name]])
                    || folderId,
            sort: itemSort,
            ownership: { default: 0 },
            flags: {}
        };

        writeFileSync(
            join(OUT_DIR, `${outName}.json`),
            JSON.stringify(doc, null, 2) + "\n"
        );
        itemSort += 100;
        totalItems++;
    }
    console.log(`  ${folder}: ${arr.length} book(s)`);
}

console.log(`\n→ wrote ${totalItems} books to packs-src/books/`);
