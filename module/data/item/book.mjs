/**
 * BookData — first-class Book item.
 *
 * Previously a subtype of `valuable` (system.type === "book"), promoted to
 * its own item type so categorization, sheet rendering, and the book-system
 * machinery no longer need the `valuable + system.type === "book"` two-step.
 *
 * The schema mirrors the legacy `valuable.bookConfig` SchemaField verbatim
 * so every existing consumer (chrome/sheets/valuable-study.js, the
 * configure-book dialog, the study/read flows) continues to read
 * `item.system.bookConfig.*` unchanged. The migration step in
 * `migrateLegacyFlags.mjs` rewrites `valuable + book` items to `book` items
 * while preserving the bookConfig payload byte-for-byte.
 *
 * Homebrew (ADR 0003): gated on `isHomebrewEnabled("bookSystem")` at the
 * consumer level; the schema is always present so disable+re-enable
 * doesn't lose configuration.
 *
 * bookConfig shape:
 *   bookType : "monster" | "skill" | "stress"
 *   monster  : ObjectField — monster-study config (mode, listKeys, filter,
 *                            specificKey, DC, totalReadings, rpPerReading,
 *                            commonKnowledgeReading, secondKnowledgeReading)
 *   skill    : ObjectField — skill book (skillId, rangeMin, rangeMax, DC,
 *                            readingsPerRank)
 *   stress   : ObjectField — novel/lore book (steps[])
 */

import { baseItemSchema } from "./templates/base.mjs";

const fields = foundry.data.fields;

export class BookData extends foundry.abstract.TypeDataModel {
    static defineSchema() {
        return {
            ...baseItemSchema(),

            // Market rarity on the shared RAW availability scale
            // (CONFIG.WITCHER.availability: everywhere / common / poor / rare …).
            availability: new fields.StringField({ initial: "common" }),

            // Book configuration — read by getBookConfig in
            // chrome/sheets/valuable-study.js. Same shape as the legacy
            // valuable.bookConfig nested schema, so consumer code is
            // unchanged after the type promotion.
            bookConfig: new fields.SchemaField({
                bookType: new fields.StringField({ initial: "monster" }),
                // initial MUST be a factory `() => ({})`, not a literal `{}`: a
                // literal is evaluated once and SHARED by reference across every
                // book that leaves the field unset, so editing one book's config
                // leaked into the others (e.g. a language set on one book showing
                // up on the next). A factory hands each instance its own object.
                monster:  new fields.ObjectField({ initial: () => ({}) }),
                skill:    new fields.ObjectField({ initial: () => ({}) }),
                stress:   new fields.ObjectField({ initial: () => ({}) }),
                // Language the book is written in + the language-skill rank
                // required to read it. { skillId: "<language skill>", requiredRank: N }.
                // Empty skillId = language-agnostic (no gate, no penalty).
                language: new fields.ObjectField({ initial: () => ({}) })
            }),
            /* Short summary of what the book is about — posted to chat by
             * the "Flip Through" context-menu action so a reader can get
             * a rough sense of the contents without spending the in-world
             * reading time. Only meaningful for stress (novel/lore) books;
             * the sheet form gates the input on bookType === "stress".
             * HTMLField because authors want line breaks + light markup. */
            flipThroughDescription: new fields.HTMLField({ initial: "" })
        };
    }

    calcWeight() {
        return this.weight * this.quantity;
    }
}
