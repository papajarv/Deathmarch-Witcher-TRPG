/**
 * Keys the engine builds at runtime must exist.
 *
 * The static `WITCHER.*` literals were all present; every gap was in a key
 * assembled from a value — `WITCHER.Magic.Choice.${c}`,
 * `WITCHER.Magic.Object.${what}`, `WITCHER.Defense.${skill}`. Foundry's
 * `localize` returns the KEY on a miss rather than null, so a missing one does
 * not throw and does not fall back: it renders the raw identifier to the
 * player. "Cadfan's Grasp: searTheHolder." is what that looks like at a table.
 *
 * The names are derived from the corpus rather than listed here, so adding a
 * spell with a new choice fails this test instead of shipping a raw key.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CORPUS } from "./spells/corpus.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EN = JSON.parse(readFileSync(join(HERE, "..", "..", "lang", "en.json"), "utf8"));

function harvest() {
    const objects = new Set(), summons = new Set(), choices = new Set(), defences = new Set();
    const walk = (body) => {
        for (const n of body ?? []) {
            if (n.b === "core:createObject" && n.a?.what) objects.add(n.a.what);
            if (n.b === "core:summonCopies" && n.a?.what) summons.add(n.a.what);
            if (n.b === "core:chooseOption") for (const c of (n.a?.choices ?? [])) choices.add(c);
            if (n.b === "core:contest" && n.a?.against) defences.add(n.a.against);
            /* Every skill a block ROLLS is rendered through the same namespace
             * — `rollDefenceSkill` flavours the roll `WITCHER.Defense.${skill}`.
             * `saveEnds` skills were missing, so a Cursed Illness save printed
             * "Cursed Illness — WITCHER.Defense.endurance" on the card. */
            if (n.a?.skill) defences.add(n.a.skill);
            if (n.body) walk(n.body);
        }
    };
    for (const s of CORPUS) {
        for (const body of Object.values(s.on ?? {})) walk(body);
        /* A banded cost's labels are rendered through the same Choice namespace. */
        for (const v of Object.values(s.frame?.cost?.bands ?? {})) choices.add(v);
        if (s.frame?.defence?.type) defences.add(s.frame.defence.type);
    }
    return { objects, summons, choices, defences };
}

test("every interpolated i18n key the corpus can produce exists", () => {
    const { objects, summons, choices, defences } = harvest();
    const missing = [];
    const need = (prefix, names) => {
        for (const n of names) {
            if (typeof n !== "string" || n.startsWith("{")) continue;   // resolved at runtime
            const key = `${prefix}${n}`;
            if (!(key in EN)) missing.push(key);
        }
    };
    need("WITCHER.Magic.Object.", objects);
    need("WITCHER.Magic.Summon.", summons);
    need("WITCHER.Magic.Choice.", choices);
    need("WITCHER.Defense.", defences);
    assert.deepEqual(missing, [], `${missing.length} keys would render raw:\n` + missing.join("\n"));
});

test("no key renders as its own identifier", () => {
    /* A key present but set to its own tail is the same bug wearing a hat. */
    const bad = [];
    for (const [k, v] of Object.entries(EN)) {
        if (!/^WITCHER\.(Magic\.(Object|Summon|Choice)|Defense)\./.test(k)) continue;
        if (v === k.split(".").pop()) bad.push(k);
    }
    assert.deepEqual(bad, []);
});
