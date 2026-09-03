// Player-flow audit (the GM/Player end-to-end run) found three
// critical bugs + the build-pipeline race. Tests pin the fixes:
//   #1 CE config dialog persists explicit subsystem state (not a diff)
//   #2 Alchemical sheet has an always-visible Use button
//   #3 Diagram sheet renders ingredients (fixed by re-ordering the
//      pack build pipeline: gen → link → build, exposed via a new
//      `npm run build:eo` script).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const editorSrc   = readFileSync(new URL("../applications/combatActionsEditor.mjs", import.meta.url), "utf8");
const sheetSrc    = readFileSync(new URL("../sheets/item/base.mjs", import.meta.url), "utf8");
const alchTpl     = readFileSync(new URL("../../templates/item/alchemical.hbs", import.meta.url), "utf8");
const pkgJson     = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

test("#1 — CE editor saves explicit subsystem state (audit fix)", () => {
    /* Diff-against-default version wrote `{}` on a no-change save,
     * looking destructive in the world-settings audit log. Explicit
     * state preserves the louder, more debuggable shape. */
    assert.match(editorSrc, /for \(const \{ key \} of SUBSYSTEM_META\(\)\) \{[\s\S]+?subOut\[key\]\s*=\s*!!this\.#working\.subsystems\[key\]/);
    /* Tuneables get the same treatment. */
    assert.match(editorSrc, /for \(const meta of TUNEABLE_META\(\)\) \{[\s\S]+?tunOut\[meta\.key\]\s*=\s*meta\.kind\s*===\s*"boolean"\s*\?\s*!!cur\s*:\s*Number\(cur\)/);
});

test("#2 — Alchemical sheet header does NOT duplicate the Use button (consume via context menu)", () => {
    /* The audit originally added a header Use button, but it was later
     * dropped: the same consume action is reachable via the right-click
     * context menu's Consume entry (module/chrome/policy/consume-item.js)
     * and the chrome inventory rail, so duplicating it in the sheet
     * header added no affordance. The `use` ACTION is still wired on the
     * sheet class — see the sibling test below. */
    assert.doesNotMatch(alchTpl, /<button[^>]+data-action="use"/);
    // The removal is documented in the template so it isn't re-added by accident.
    assert.match(alchTpl, /Use button removed from the display header/);
});

test("#2 — Alchemical sheet wires the Use action to consumeItem", () => {
    /* Click handler imports consume-item.js and calls consumeItem
     * with the resolved actor. Falls back with a warn when the item
     * isn't owned (no carrier to apply the AE to). */
    assert.match(sheetSrc, /WitcherAlchemicalSheet[\s\S]+?actions:\s*\{\s*use:\s*WitcherAlchemicalSheet\._onUse/);
    assert.match(sheetSrc, /static async _onUse[\s\S]+?import\("\.\.\/\.\.\/chrome\/policy\/consume-item\.js"\)/);
    assert.match(sheetSrc, /await consumeItem\(item, actor\)/);
});

test("#3 — npm run build:eo chains gen → link → build (no stale pack races)", () => {
    /* The diagram-empty bug surfaced because build-packs.mjs ran
     * BEFORE link-eo-diagrams.mjs populated the source JSONs with
     * craftingComponents. The new `build:eo` script enforces the
     * correct order so a maintainer can't reproduce the race. */
    const cmd = pkgJson.scripts?.["build:eo"];
    assert.ok(cmd, "package.json must declare build:eo");
    /* Must include all four phases in order. */
    assert.match(cmd, /gen-eo-components\.mjs/);
    assert.match(cmd, /gen-eo-catalog\.mjs/);
    assert.match(cmd, /gen-eo-witcher-kit\.mjs/);
    assert.match(cmd, /link-eo-diagrams\.mjs/);
    assert.match(cmd, /build-packs\.mjs/);
    /* Linker must come AFTER the generators and BEFORE build. */
    const order = ["gen-eo-components", "gen-eo-catalog", "gen-eo-witcher-kit", "link-eo-diagrams", "build-packs"];
    let cursor = 0;
    for (const step of order) {
        const idx = cmd.indexOf(step, cursor);
        assert.ok(idx >= 0, `build:eo missing ${step} in correct order`);
        cursor = idx;
    }
});
