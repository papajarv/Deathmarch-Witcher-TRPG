/**
 * MerchantData — shop-keeper actor.
 *
 * A merchant is a vendor NPC: it holds stock (embedded Items, exactly like a
 * loot pile), a coin reserve (the standard six-denomination currency), and a
 * pile of shop configuration — pricing/markup, per-player standing, personality,
 * and an auto-stocking engine that draws randomized inventory from compendiums.
 *
 * Ported from the old `witcher-merchant-system` module. The old model carried
 * empty stats/skills/reputation stubs to keep that system's WitcherActor happy;
 * here derived-data prep lives per-type, so a merchant simply omits them.
 *
 * Behavior (pricing, stocking, transactions) lives in module/merchant/*; this
 * file is schema only.
 */

import { currencySchema, calcCurrencyWeight, CURRENCY_KEYS } from "./templates/currency.mjs";

const fields = foundry.data.fields;

const PERSONALITIES = ["friendly", "grumpy", "shifty", "noble", "desperate", "neutral"];
const SPECIALIZATIONS = ["witcher", "cleric", "mage", "craftsman", "scholar", "mercenary", "thief", "merchant"];
const RARITIES = ["everywhere", "common", "poor", "rare", "witcher"];

export class MerchantData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            // Real coin reserve (six denominations) — the merchant pays players
            // out of this and bankrolls its purchases from it.
            ...currencySchema(),

            // Which denomination prices are quoted and settled in.
            shopDenom: new fields.StringField({
                required: true, initial: "crown", choices: CURRENCY_KEYS
            }),

            shopName:    new fields.StringField({ required: true, initial: "Shop" }),
            description: new fields.HTMLField({ initial: "A curious merchant passes through." }),

            personality: new fields.SchemaField({
                type:  new fields.StringField({ required: true, initial: "neutral", choices: PERSONALITIES }),
                quirk: new fields.StringField({ initial: "" })
            }),

            // Pricing — see module/merchant/pricing.mjs for how these combine.
            pricing: new fields.SchemaField({
                baseMarkup:            new fields.NumberField({ required: true, initial: 1.0, min: 0.5, max: 3, step: 0.01 }),
                bulkDiscountThreshold: new fields.NumberField({ required: true, initial: 5, min: 1, integer: true }),
                bulkDiscountPercent:   new fields.NumberField({ required: true, initial: 10, min: 0, max: 50, step: 1 })
            }),

            // Filters stocking by the items' intended profession (free-form tags).
            specializations: new fields.ArrayField(
                new fields.StringField({ choices: SPECIALIZATIONS }),
                { initial: [] }
            ),

            replenishment: new fields.SchemaField({
                enabled:               new fields.BooleanField({ initial: false }),
                daysToReplenish:       new fields.NumberField({ initial: 3, min: 1, integer: true }),
                lastReplenished:       new fields.NumberField({ initial: 0 }),
                replenishmentTemplate: new fields.ArrayField(new fields.ObjectField(), { initial: [] })
            }),

            // Per-player standing. `playerId` is a character ACTOR id (the buyer).
            playerRelations: new fields.ArrayField(
                new fields.SchemaField({
                    playerId:        new fields.StringField(),
                    relationship:    new fields.NumberField({ min: -100, max: 100, initial: 0 }),
                    lastNegotiation: new fields.NumberField({ initial: 0 }),
                    notes:           new fields.StringField({ initial: "" })
                }),
                { initial: [] }
            ),

            // Curated draw pool (snapshots of items) for "item pool" stocking mode.
            itemPool: new fields.ArrayField(new fields.ObjectField(), { initial: [] }),

            // Auto-stocking configuration.
            stocking: new fields.SchemaField({
                // Each source: { packId, packLabel, folderPaths[], includeKeywords, excludeKeywords, weight, enabled }
                sources: new fields.ArrayField(new fields.ObjectField(), { initial: [] }),

                useItemPool:    new fields.BooleanField({ initial: false }),

                totalMode:      new fields.StringField({ required: true, initial: "fixed", choices: ["fixed", "random"] }),
                totalFixed:     new fields.NumberField({ initial: 20, min: 1, integer: true }),
                totalRandomMin: new fields.NumberField({ initial: 10, min: 1, integer: true }),
                totalRandomMax: new fields.NumberField({ initial: 30, min: 1, integer: true }),

                allowStacks:    new fields.BooleanField({ initial: true }),
                maxStack:       new fields.NumberField({ initial: 3, min: 2, max: 10, integer: true }),
                stackChance:    new fields.NumberField({ initial: 30, min: 0, max: 100 }),

                rarityEnabled: new fields.SchemaField(
                    Object.fromEntries(RARITIES.map(r => [r, new fields.BooleanField({ initial: r !== "witcher" })]))
                ),
                useRarityWeights: new fields.BooleanField({ initial: false }),
                rarityWeights: new fields.SchemaField({
                    everywhere: new fields.NumberField({ initial: 50, min: 0, max: 100 }),
                    common:     new fields.NumberField({ initial: 30, min: 0, max: 100 }),
                    poor:       new fields.NumberField({ initial: 15, min: 0, max: 100 }),
                    rare:       new fields.NumberField({ initial: 4,  min: 0, max: 100 }),
                    witcher:    new fields.NumberField({ initial: 1,  min: 0, max: 100 })
                }),

                lastStock:      new fields.ArrayField(new fields.ObjectField(), { initial: [] }),
                lastStockedAt:  new fields.NumberField({ initial: 0 }),
                lastStockCount: new fields.NumberField({ initial: 0 }),

                presets: new fields.ArrayField(new fields.ObjectField(), { initial: [] })
            }),

            // Item ids (from this merchant's embedded inventory) pinned to the top
            // of the buy sheet.
            featuredPinned: new fields.ArrayField(new fields.StringField(), { initial: [] }),

            portraitCardSettings: new fields.SchemaField({
                showOnScene: new fields.BooleanField({ initial: true }),
                cardScale:   new fields.NumberField({ initial: 1,   min: 0.5, max: 2, step: 0.1 }),
                cardOpacity: new fields.NumberField({ initial: 0.9, min: 0.1, max: 1, step: 0.1 })
            })
        };
    }

    calcCurrencyWeight() {
        return calcCurrencyWeight(this.currency);
    }

    /** Coins on hand in the shop's settlement denomination. */
    get reserve() {
        return Number(this.currency?.[this.shopDenom]) || 0;
    }
}
