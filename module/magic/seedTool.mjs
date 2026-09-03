/**
 * The seeding tool, as a GM-facing dialog.
 *
 * Thin on purpose: all the matching lives in `seed.mjs`, which is Foundry-free
 * and tested. This walks the world and the compendia, shows the plan, and
 * writes only if a person says so.
 *
 * The dry run is not a courtesy. Matching 103 book names against whatever a
 * world actually contains is guesswork, and a guess that has already written
 * is not a guess anybody can inspect.
 */

import { plan, payloadFor, verify, report, normalise } from "./seed.mjs";
import { CORPUS } from "./spells/corpus.mjs";

const SYSTEM_ID = "TheWitcherTRPG";

/** Every spell item a GM could reasonably want seeded. */
export async function collectSpellItems({ world = true, packs = true } = {}) {
    const out = [];
    if (world) out.push(...game.items.filter(i => i.type === "spell"));

    if (packs) {
        for (const pack of game.packs) {
            if (pack.documentName !== "Item") continue;
            /* Locked packs are locked for a reason — a system's own compendium
             * is replaced wholesale on update, so anything written into one is
             * lost at the next release without warning. Skipped, and SAID so
             * in the report rather than silently. */
            if (pack.locked) continue;
            const index = await pack.getIndex({ fields: ["type"] });
            for (const entry of index) {
                if (entry.type !== "spell") continue;
                out.push(await pack.getDocument(entry._id));
            }
        }
    }
    return out;
}

/** Open the tool. GM only — it writes to documents players do not own. */
export async function openSeedTool() {
    if (!game.user.isGM) {
        return ui.notifications.warn(game.i18n.localize("WITCHER.Magic.Seed.GMOnly"));
    }

    const broken = verify();
    if (broken.length) {
        /* Should never fire; the corpus is tested. If it does, something is
         * wrong with the ENGINE, not with the world, and seeding would spread
         * it across every spell at once. */
        return ui.notifications.error(game.i18n.format("WITCHER.Magic.Seed.CorpusBroken",
                                                       { name: broken[0].spell.name }));
    }

    const items = await collectSpellItems();
    const p = plan(items);
    const lockedPacks = game.packs.filter(pk => pk.documentName === "Item" && pk.locked).length;

    const chosen = await foundry.applications.api.DialogV2.wait({
        window: { title: game.i18n.localize("WITCHER.Magic.Seed.Title"), width: 620 },
        content: renderPlan(p, { items: items.length, lockedPacks }),
        buttons: [
            { action: "seed",      label: game.i18n.format("WITCHER.Magic.Seed.Apply", { n: p.matched.length }),
              default: true, disabled: !p.matched.length },
            { action: "overwrite", label: game.i18n.localize("WITCHER.Magic.Seed.Overwrite") },
            { action: "cancel",    label: game.i18n.localize("WITCHER.Magic.Seed.Cancel") }
        ]
    }).catch(() => "cancel");

    if (chosen === "cancel" || !chosen) return;

    const final = chosen === "overwrite" ? plan(items, { overwrite: true }) : p;
    const done = await apply(final);

    ui.notifications.info(game.i18n.format("WITCHER.Magic.Seed.Done", { n: done }));
    return done;
}

/** Write the trees. Sequential rather than parallel — a hundred concurrent
 *  compendium writes is how a pack gets corrupted. */
async function apply({ matched }) {
    let n = 0;
    for (const { item, spell } of matched) {
        try {
            await item.update(payloadFor(spell));
            n++;
        } catch (err) {
            console.warn(`${SYSTEM_ID} | could not seed ${item.name}`, err);
        }
    }
    return n;
}

function renderPlan(p, { items, lockedPacks }) {
    const list = (rows, render) => rows.length
        ? `<ul class="wm-seed-list">${rows.slice(0, 12).map(render).join("")}${
            rows.length > 12 ? `<li class="wm-seed-more">+${rows.length - 12} more</li>` : ""}</ul>`
        : "";

    return `
        <div class="wm-seed">
            <p class="wm-seed-lede">${game.i18n.format("WITCHER.Magic.Seed.Lede",
                { items, corpus: CORPUS.length })}</p>

            <section class="wm-seed-group is-good">
                <h4>${game.i18n.format("WITCHER.Magic.Seed.WillSeed", { n: p.matched.length })}</h4>
                ${list(p.matched, m => `<li>${escape(m.item.name)}</li>`)}
            </section>

            ${p.already.length ? `
            <section class="wm-seed-group">
                <h4>${game.i18n.format("WITCHER.Magic.Seed.Already", { n: p.already.length })}</h4>
                <p class="wm-seed-note">${game.i18n.localize("WITCHER.Magic.Seed.AlreadyNote")}</p>
                ${list(p.already, a => `<li>${escape(a.item.name)}</li>`)}
            </section>` : ""}

            ${p.unused.length ? `
            <section class="wm-seed-group is-warn">
                <h4>${game.i18n.format("WITCHER.Magic.Seed.Unused", { n: p.unused.length })}</h4>
                <p class="wm-seed-note">${game.i18n.localize("WITCHER.Magic.Seed.UnusedNote")}</p>
                ${list(p.unused, s => `<li>${escape(s.name)}</li>`)}
            </section>` : ""}

            ${p.unmatched.length ? `
            <section class="wm-seed-group">
                <h4>${game.i18n.format("WITCHER.Magic.Seed.Unmatched", { n: p.unmatched.length })}</h4>
                <p class="wm-seed-note">${game.i18n.localize("WITCHER.Magic.Seed.UnmatchedNote")}</p>
                ${list(p.unmatched, u => `<li>${escape(u.item.name)}</li>`)}
            </section>` : ""}

            ${lockedPacks ? `<p class="wm-seed-note">${
                game.i18n.format("WITCHER.Magic.Seed.Locked", { n: lockedPacks })}</p>` : ""}
        </div>`;
}

const escape = (s) => String(s ?? "").replace(/[&<>"]/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export { normalise, report };
