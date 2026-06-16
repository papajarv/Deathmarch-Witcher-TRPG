/**
 * Legacy flag migration.
 *
 * Users coming from the TheWitcherTRPG + witcher-* module stack carry world
 * data with flags like `flags["witcher-overhaul-ui"].bookConfig`,
 * `flags["witcher-stress-mechanic"].stress`, etc. Death March exposes the
 * same data as first-class system fields per ADR 0002 / 0003.
 *
 * On world load, this migrator walks all actors and items, reads the
 * legacy flags, writes them into the system schema, and stamps a
 * world-setting `migrationVersion` so subsequent loads skip the work.
 *
 * Idempotent: a partially-migrated world resumes cleanly.
 *
 * GM-only — players have no permission to update actors they don't own.
 */

const SYSTEM_ID = "witcher-ttrpg-death-march";
const CURRENT_VERSION = 4;

const OUI = "witcher-overhaul-ui";
const STRESS = "witcher-stress-mechanic";
// witcher-alchemy-craft kept for the diagram-output migration (RAW
// diagrams predate the homebrew, so the output UUID fields are still
// valid). The potency / baseMod / charges parts of that module are
// dropped; see migrateItem for the truncated migration path.
const ALCHEMY = "witcher-alchemy-craft";

/**
 * Entry — call from main.mjs ready hook. No-op for players and for worlds
 * already at the current migration version.
 */
export async function runLegacyMigration() {
    if (!game.user.isActiveGM) return;
    const current = game.settings.get(SYSTEM_ID, "migrationVersion") ?? 0;
    if (current >= CURRENT_VERSION) return;

    console.log(`${SYSTEM_ID} | migrating legacy flag data → system fields (from v${current} to v${CURRENT_VERSION})`);

    let migrated = 0;
    let failed = 0;
    const tally = (n) => { if (n < 0) failed += -n; else migrated += n; };
    // Per-doc isolation: one bad apple must not abort the whole run, or
    // the version stamp never lands and the migration replays (with toast)
    // on every subsequent boot.
    const safe = async (fn, label) => {
        try {
            return await fn();
        } catch (err) {
            console.warn(`${SYSTEM_ID} | migration: ${label} failed`, err);
            return -1;
        }
    };

    if (current < 1) {
        for (const actor of game.actors) tally(await safe(() => migrateActor(actor), `actor ${actor.id}`));
        for (const item of game.items)   tally(await safe(() => migrateItem(item),   `item ${item.id}`));
        for (const actor of game.actors)
            for (const item of actor.items)
                tally(await safe(() => migrateItem(item), `embedded item ${item.id} on ${actor.id}`));
    }

    // v2: flag-namespace copy. Chrome JS now reads/writes flags under
    // SYSTEM_ID. Existing worlds carry chrome flags under "witcher-overhaul-ui".
    // Copy the whole flag bag (NOT individual keys — the chrome touches many
    // ad-hoc keys) onto the new namespace. Leaves source flags in place so an
    // older client could still read the world.
    if (current < 2) {
        tally(await safe(() => copyChromeFlagsAcrossWorld(), "chrome flag-bag copy"));
    }

    // v3: stop hex effects transferring to the holder. A hex effect is a
    // reference template the combat flow applies to a TARGET — it must never
    // apply to the caster carrying the hex. Effects created before this rule
    // landed have transfer:true; flip them off across the world. (Oils are
    // reconciled by the consume-item policy's own ready-hook, not here.)
    if (current < 3) {
        tally(await safe(() => fixHexEffectTransferAcrossWorld(), "hex effect transfer flip"));
    }

    // v4: valuable subtype fields off the SYSTEM_ID flag bag → system fields.
    // The v2 flag-bag copy (and the ported flag-based chrome) deposited
    // bookConfig / mapImage / monsterUuid under flags[SYSTEM_ID]. The bespoke
    // valuable sheet now reads/writes system.* exclusively, so lift those keys
    // into the schema. (v1 already covered flags[OUI]; this covers dev worlds
    // that only ever had the SYSTEM_ID bag.)
    if (current < 4) {
        tally(await safe(() => migrateValuableFlagBagAcrossWorld(), "valuable flag-bag → system"));
    }

    // Stamp the version even if some docs failed — partial-migration is
    // better than infinite retry. Failures already logged per-doc; the
    // user toast surfaces the count so they know something needs eyes.
    try {
        await game.settings.set(SYSTEM_ID, "migrationVersion", CURRENT_VERSION);
    } catch (err) {
        console.error(`${SYSTEM_ID} | failed to stamp migrationVersion — migration will retry next boot`, err);
        return;
    }
    console.log(`${SYSTEM_ID} | migration complete: ${migrated} updates applied, ${failed} failures`);
    if (failed > 0) {
        ui.notifications?.warn(`Witcher TTRPG: migration applied ${migrated} updates, ${failed} docs failed (see console).`);
    } else if (migrated > 0) {
        ui.notifications?.info(`Witcher TTRPG: migration complete (${migrated} updates).`);
    }
    // Zero updates + zero failures: silent. Fresh worlds shouldn't see a toast.
}

/**
 * Per-actor migration. Returns the number of update operations performed.
 */
async function migrateActor(actor) {
    const updates = {};
    let count = 0;

    // Stress (witcher-stress-mechanic) → character.system.stress
    const stress = actor.getFlag(STRESS, "stress");
    if (stress != null && actor.type === "character") {
        updates["system.stress"] = Number(stress) || 0;
        count++;
    }

    // Bestiary state (witcher-overhaul-ui) is carried per-character in the
    // flag bag (keyed by encoded monster uuid), not a system field — the
    // v2 chrome flag-bag copy moves it onto flags[SYSTEM_ID].bestiary and
    // sanitizes the legacy knowledge sub-object there. Nothing to do here.

    // Book usage per encoded book uuid → character.system.bookUsage
    const bookUsage = actor.getFlag(OUI, "bookUsage");
    if (bookUsage && actor.type === "character") {
        updates["system.bookUsage"] = bookUsage;
        count++;
    }

    // Life-event metadata (dates / locations / order) stays as flags on the
    // actor for now — those are sparsely-keyed maps and don't map cleanly to
    // a schema field. Revisit in Phase 7 follow-up if needed.

    if (Object.keys(updates).length) {
        await actor.update(updates);
    }
    return count;
}

/**
 * Per-item migration. Returns the number of update operations performed.
 */
async function migrateItem(item) {
    const updates = {};
    let count = 0;

    // Book config on valuable items → system.bookConfig
    const bookConfig = item.getFlag(OUI, "bookConfig");
    if (bookConfig && item.type === "valuable") {
        updates["system.bookConfig"] = bookConfig;
        count++;
    }

    // Map image legacy flag → system.mapImage on the new first-class `map`
    // item type (it used to live on valuables of subtype "map"; that subtype
    // was retired). Skipped silently for plain valuables — they no longer
    // carry the field.
    const mapImage = item.getFlag(OUI, "mapImage");
    if (mapImage && item.type === "map") {
        updates["system.mapImage"] = mapImage;
        count++;
    }

    // Source-monster uuid legacy flag → system.monsterUuid on the new
    // first-class `remains` item type. Same retired-subtype story as
    // mapImage above.
    const monsterUuid = item.getFlag(OUI, "monsterUuid");
    if (monsterUuid && item.type === "remains") {
        updates["system.monsterUuid"] = monsterUuid;
        count++;
    }

    // Diagram outputs (witcher-alchemy-craft flags → system fields).
    // Potency thresholds were homebrew and aren't in the schema anymore;
    // skip them. Output UUIDs / names still apply.
    if (item.type === "diagrams") {
        const aFlag = (k) => item.getFlag(ALCHEMY, k);
        const fields = [
            "outputNormal", "outputEnhanced", "outputSuperior",
            "outputNormalName", "outputEnhancedName", "outputSuperiorName",
            "memorizedFrom"
        ];
        const legacyMap = {
            outputEnhanced:     "outputEnchanted",
            outputEnhancedName: "outputEnchantedName"
        };
        let touched = false;
        for (const k of fields) {
            const v = aFlag(k) ?? aFlag(legacyMap[k]);
            if (v != null && v !== "" && v !== 0) {
                updates[`system.${k}`] = v;
                touched = true;
            }
        }
        if (touched) count++;
    }

    // NOTE: potency / baseMod / baseType / charges / drunk / appliedOil
    // migrations are dropped in RAW-only mode — their target schema fields
    // were removed when we stripped witcher-alchemy-craft +
    // witcher-food-and-drink. Old flag values stay on the items (harmless)
    // until a future cleanup migration prunes them.

    if (Object.keys(updates).length) {
        await item.update(updates);
    }
    return count;
}

/**
 * Flip `transfer` to false on embedded effects of hex items. A hex effect is a
 * template the combat flow applies to a target, never to the caster carrying
 * the hex. Returns the count of items touched.
 */
async function fixHexEffectTransferAcrossWorld() {
    let count = 0;

    const fixItem = async (item) => {
        if (item.type !== "hex") return 0;
        const updates = item.effects
            .filter(e => e.transfer === true)
            .map(e => ({ _id: e.id, transfer: false }));
        if (!updates.length) return 0;
        await item.updateEmbeddedDocuments("ActiveEffect", updates);
        return 1;
    };

    for (const i of game.items)        count += await fixItem(i);
    for (const a of game.actors)
        for (const i of a.items)       count += await fixItem(i);

    return count;
}

/**
 * Lift legacy subtype fields off `flags[SYSTEM_ID]` into the system schema.
 * Subtypes now span multiple item types after the map/remains extraction:
 * mapImage lands on `map` items, monsterUuid on `remains` items, bookConfig
 * on `valuable` items. Only fills a system field that is still empty/default
 * — a value already written by the bespoke sheet (system.*) always wins over
 * the stale flag. Returns the count of items touched.
 */
async function migrateValuableFlagBagAcrossWorld() {
    let count = 0;

    const bookConfigIsUnset = (bc) =>
        !bc || (
            Object.keys(bc.monster ?? {}).length === 0 &&
            Object.keys(bc.skill   ?? {}).length === 0 &&
            !(Array.isArray(bc.stress?.steps) && bc.stress.steps.length)
        );

    const fixItem = async (item) => {
        const bag = item.flags?.[SYSTEM_ID];
        if (!bag || typeof bag !== "object") return 0;
        const updates = {};

        // Subtype-driven targets after the map/remains extraction: the
        // mapImage and monsterUuid schema fields no longer exist on plain
        // valuables. The legacy flag bag is migrated to the new first-class
        // types instead. bookConfig stays on valuables (book subtype).
        if (item.type === "map" && bag.mapImage && !item.system?.mapImage) {
            updates["system.mapImage"] = bag.mapImage;
        }
        if (item.type === "remains" && bag.monsterUuid && !item.system?.monsterUuid) {
            updates["system.monsterUuid"] = bag.monsterUuid;
        }
        if (item.type === "valuable" && bag.bookConfig?.bookType && bookConfigIsUnset(item.system?.bookConfig)) {
            updates["system.bookConfig"] = bag.bookConfig;
        }

        if (!Object.keys(updates).length) return 0;
        await item.update(updates);
        return 1;
    };

    for (const i of game.items)   count += await fixItem(i);
    for (const a of game.actors)
        for (const i of a.items)  count += await fixItem(i);

    return count;
}

/**
 * Walk every document type that chrome touches and copy
 * `flags["witcher-overhaul-ui"]` onto `flags["witcher-ttrpg-death-march"]`.
 *
 * Deep-merges into the new namespace so any system-set flags survive
 * (e.g. a world that already started on v2 chrome and now has both bags
 * partially populated — the new-namespace values win).
 *
 * Source flags are NOT cleared. Cheap insurance for users who roll back.
 */
/**
 * Sanitize a legacy bestiary flag bag for the new schema. Entries keep their
 * research / rp / pinned / encounters, but the legacy `knowledge` sub-object
 * (keyed by fixed track: common/academic/monster) can't be mapped 1:1 onto
 * the new per-tier-index reveal model, so it's reset. The research tier (the
 * main progression) carries over and re-reveals on next study/roll.
 */
function sanitizeBestiaryBag(bag) {
    if (!bag || typeof bag !== "object") return bag;
    const out = {};
    for (const [key, entry] of Object.entries(bag)) {
        out[key] = (entry && typeof entry === "object")
            ? { ...entry, knowledge: {} }
            : entry;
    }
    return out;
}

async function copyChromeFlagsAcrossWorld() {
    let count = 0;

    const merge = async (doc) => {
        const legacy = doc.getFlag(OUI, undefined) ?? doc.flags?.[OUI];
        if (!legacy || typeof legacy !== "object") return 0;
        const updates = {};
        for (const [k, v] of Object.entries(legacy)) {
            updates[`flags.${SYSTEM_ID}.${k}`] = k === "bestiary" ? sanitizeBestiaryBag(v) : v;
        }
        try {
            await doc.update(updates, { recursive: false });
            return 1;
        } catch (err) {
            console.warn(`${SYSTEM_ID} | flag-bag copy failed on ${doc.documentName} ${doc.id}:`, err);
            return 0;
        }
    };

    for (const a of game.actors)        count += await merge(a);
    for (const a of game.actors)
        for (const i of a.items)        count += await merge(i);
    for (const i of game.items)         count += await merge(i);
    for (const s of game.scenes)        count += await merge(s);
    for (const j of game.journal) {
                                        count += await merge(j);
        for (const p of j.pages)        count += await merge(p);
    }
    for (const m of game.macros)        count += await merge(m);
    for (const m of game.messages)      count += await merge(m);

    return count;
}
