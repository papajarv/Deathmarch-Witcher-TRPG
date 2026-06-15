/**
 * Merchant auto-stocking — fills a merchant's embedded inventory by drawing
 * from compendium sources (or a curated item pool).
 *
 * Ported from witcher-merchant-system merchant-sheet-enhanced.js. The old code
 * lived as sheet methods; here the engine is pure actor-level logic so the
 * sheet only owns the confirm dialog and the re-render. Rarity filtering goes
 * through `rarityOf` (new-system `system.availability` enum) rather than the
 * old substring match on `system.avail`.
 *
 * A "source" is a plain object on `merchant.system.stocking.sources`:
 *   { packId, packLabel, folderPaths[], includeKeywords, excludeKeywords, weight, enabled }
 */

import { rarityOf, NON_MERCHANT_TYPES } from "./pricing.mjs";

/** Rarity keys that the stocking filter understands, in ladder order. */
const RARITY_KEYS = ["everywhere", "common", "poor", "rare", "witcher"];

/**
 * Generate fresh stock for a merchant from its configured sources.
 *
 * @param {Actor} merchant
 * @param {object} [opts]
 * @param {boolean} [opts.isRestock]  Top-up mode: keep current stock, add a
 *                                    quarter of the last full count, don't clear.
 * @returns {Promise<{ok: boolean, count: number, reason?: string}>}
 */
export async function stockMerchant(merchant, { isRestock = false } = {}) {
    const config      = merchant.system.stocking ?? {};
    const sources     = (config.sources ?? []).filter(s => s.enabled !== false);
    const useItemPool = config.useItemPool ?? false;

    if (!useItemPool && sources.length === 0) {
        return { ok: false, reason: "noSources" };
    }
    if (useItemPool && (merchant.system.itemPool ?? []).length === 0) {
        return { ok: false, reason: "emptyPool" };
    }

    const totalRows = rowsToGenerate(config, isRestock);

    const rolled = useItemPool
        ? rollFromItemPool(merchant, totalRows, config)
        : await rollFromCompendiumSources(merchant, totalRows, sources, config);

    if (!rolled || rolled.length === 0) {
        return { ok: false, reason: "noItems" };
    }

    const itemsToCreate = rolled.map(itemData => {
        let quantity = 1;
        if (config.allowStacks && Math.random() * 100 < (config.stackChance ?? 30)) {
            const maxStack = config.maxStack ?? 3;
            quantity = 2 + Math.floor(Math.random() * (maxStack - 1));
        }
        foundry.utils.setProperty(itemData, "system.quantity", quantity);
        delete itemData._id;
        return itemData;
    });

    // render:false suppresses per-item sheet repaints during the bulk swap; the
    // caller re-renders once afterwards.
    if (!isRestock && merchant.items.size > 0) {
        const ids = merchant.items.map(i => i.id);
        await merchant.deleteEmbeddedDocuments("Item", ids, { render: false });
    }

    await merchant.createEmbeddedDocuments("Item", itemsToCreate, { render: false });

    if (!isRestock) {
        await merchant.update({
            "system.stocking.lastStock":      itemsToCreate,
            "system.stocking.lastStockCount": itemsToCreate.length,
            "system.stocking.lastStockedAt":  Date.now()
        });
    }

    return { ok: true, count: itemsToCreate.length };
}

/** How many inventory rows to draw this run. */
function rowsToGenerate(config, isRestock) {
    if (isRestock) {
        return Math.max(1, Math.ceil((config.lastStockCount ?? 0) / 4));
    }
    if (config.totalMode === "random") {
        const min = config.totalRandomMin ?? 10;
        const max = config.totalRandomMax ?? 30;
        return min + Math.floor(Math.random() * (max - min + 1));
    }
    return config.totalFixed ?? 20;
}

/** Whether a given rarity key is switched on in the stocking config. */
function rarityAllowed(key, config) {
    const enabled = config.rarityEnabled ?? {};
    return RARITY_KEYS.includes(key) ? enabled[key] !== false : enabled.everywhere !== false;
}

/**
 * Draw rows from the curated item pool (taverns, fixed-menu shops). Pool entries
 * are plain snapshots; rarity filtering still applies.
 */
function rollFromItemPool(merchant, totalRows, config) {
    const pool = foundry.utils.duplicate(merchant.system.itemPool ?? []);
    const filtered = pool.filter(itemData =>
        !NON_MERCHANT_TYPES.includes(itemData.type) && rarityAllowed(rarityOf(itemData), config));
    if (filtered.length === 0) return [];

    const rolled = [];
    for (let i = 0; i < totalRows; i++) {
        rolled.push(foundry.utils.duplicate(filtered[Math.floor(Math.random() * filtered.length)]));
    }
    return rolled;
}

/** Draw rows from compendium sources, weighted by each source's share. */
async function rollFromCompendiumSources(merchant, totalRows, sources, config) {
    const pools = await buildSourcePools(sources, config);
    if (pools.every(p => p.items.length === 0)) return [];

    const rolled = [];
    const maxAttempts = totalRows * 10;
    let attempts = 0;

    while (rolled.length < totalRows && attempts < maxAttempts) {
        attempts++;
        const idx = pickWeightedSource(pools);
        if (idx === -1) break;
        const pool = pools[idx];
        if (pool.items.length === 0) continue;
        const pick = pool.items[Math.floor(Math.random() * pool.items.length)];
        rolled.push(pick.toObject());
    }
    return rolled;
}

/**
 * Resolve each source to its eligible item documents, applying folder, keyword,
 * and rarity filters. Returns [{ packId, weight, items[] }].
 */
async function buildSourcePools(sources, config) {
    const pools = [];

    for (const source of sources) {
        const pack = game.packs.get(source.packId);
        if (!pack) {
            console.warn(`[merchant] compendium not found: ${source.packId}`);
            pools.push({ packId: source.packId, weight: Number(source.weight) || 0, items: [] });
            continue;
        }

        let filtered = await pack.getDocuments();

        const folderPaths = source.folderPaths?.length
            ? source.folderPaths
            : (source.folderPath ? [source.folderPath] : []);
        if (folderPaths.length > 0) {
            filtered = filtered.filter(doc => {
                if (!doc.folder) return false;
                const docPath = folderPathOf(doc.folder);
                return folderPaths.some(fp => docPath === fp || docPath.startsWith(fp + " / "));
            });
        }

        filtered = filtered.filter(doc => !NON_MERCHANT_TYPES.includes(doc.type));
        filtered = applyKeywordFilter(filtered, source.includeKeywords, true);
        filtered = applyKeywordFilter(filtered, source.excludeKeywords, false);
        filtered = filtered.filter(doc => rarityAllowed(rarityOf(doc), config));

        pools.push({ packId: source.packId, weight: Number(source.weight) || 0, items: filtered });
    }

    return pools;
}

/** " A / B / C" breadcrumb for a compendium folder. */
function folderPathOf(folder) {
    const parts = [];
    let cur = folder;
    while (cur) {
        parts.unshift(cur.name);
        cur = cur.folder;
    }
    return parts.join(" / ");
}

/** Keep (include=true) or drop (include=false) docs whose name matches a keyword. */
function applyKeywordFilter(docs, raw, include) {
    const words = String(raw ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    if (words.length === 0) return docs;
    return docs.filter(doc => {
        const name = doc.name.toLowerCase();
        const hit = words.some(w => name.includes(w));
        return include ? hit : !hit;
    });
}

/** Pick a source index proportional to weight, skipping empties. */
function pickWeightedSource(pools) {
    const totalWeight = pools.reduce((s, p) => s + (p.weight || 0), 0);
    if (totalWeight === 0) return pools.findIndex(p => p.items.length > 0);

    const roll = Math.random() * totalWeight;
    let cumulative = 0;
    for (let i = 0; i < pools.length; i++) {
        cumulative += pools[i].weight;
        if (roll < cumulative) {
            if (pools[i].items.length > 0) return i;
            return pools.findIndex(p => p.items.length > 0);
        }
    }
    return pools.findIndex(p => p.items.length > 0);
}
