// module/applications/attackDialog.ceThrow.test.mjs
//
// Throw semantics (post-migration schema):
//   - Throwability derives from the weapon's `range` field. If range is
//     set, the weapon can be thrown; the throw is always Athletics.
//   - CE on: any weapon (1H or 2H) with a range can be thrown.
//   - RAW (CE off): only one-handed weapons with a range.
//   - The `weaponType: "thrown"` distinction was collapsed into "melee
//     with a range" — see WeaponData.migrateData + tools/migrate-thrown-to-melee.mjs.
//   - Every throw uses Athletics (a DEX skill), regardless of the weapon's
//     declared skillKey.
//   - The throw chat card surfaces the weapon's range.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dialogSrc = readFileSync(new URL("./attackDialog.mjs", import.meta.url), "utf8");
const mixinSrc  = readFileSync(new URL("../documents/mixins/weaponAttackMixin.mjs", import.meta.url), "utf8");

test("canThrow gates on isCombatExtendedEnabled — RAW is strict on hand count, CE is permissive", () => {
    /* Post-migration schema: throwability = the Range field alone.
     *   RAW  : one-handed weapon with a real range.
     *   CE   : any weapon with a real range (2h included).
     * `N/A`, `-`, and `--` are pack sentinels for "no throwable range"
     * and must not unlock the throw strike (bullwhip, bagh nakh, syringe). */
    assert.match(dialogSrc, /isCombatExtendedEnabled/);
    assert.match(dialogSrc, /canThrow\s*=\s*ceOn[\s\S]+?hasRealRange[\s\S]+?wHands\s*===\s*"one"[\s\S]+?hasRealRange/);
    /* hasRealRange rejects the sentinel values. */
    assert.match(dialogSrc, /hasRealRange\s*=\s*wRange\.length\s*>\s*0/);
    assert.match(dialogSrc, /\/\^n\\\/\?a\$\/i\.test\(wRange\)/);
});

test("weaponAttackMixin imports isCombatExtendedEnabled from the homebrew api", () => {
    assert.match(mixinSrc, /import\s*\{\s*isCombatExtendedEnabled\s*\}\s*from\s*"[^"]*api\/homebrew\.mjs"/);
});

test("throwProf overrides the weapon's skill to Athletics on any throw strike", () => {
    /* readWeaponProfile(weapon, "athletics") builds a profile that
     * bypasses weapon.skillKey. The literal "athletics" string carries
     * the DEX-skill guarantee. Fires on any throw strike — RAW dedicated
     * thrown weapons or CE any-weapon-with-range. */
    assert.match(mixinSrc, /isThrowStrike\s*=\s*!!\(decl\.strikeMeta\?\.thrown\)/);
    assert.match(mixinSrc, /throwProf\s*=\s*isThrowStrike\s*\?\s*readWeaponProfile\(weapon,\s*"athletics"\)\s*:\s*null/);
    assert.match(mixinSrc, /activeProf\s*=\s*throwProf\s*\?\?/);
});

test("firedRanged is TRUE for a throw regardless of weapon.weaponType", () => {
    /* A melee-type sword thrown via the throw strike should fire as a
     * ranged shot (arc + range brackets apply). Post-migration all
     * throwable weapons are weaponType="melee" — the strike itself
     * flags the throw, and the dialog's "thrown" mode selection also
     * routes into firedRanged. */
    assert.match(mixinSrc, /firedRanged\s*=\s*isThrowStrike\s*\|\|\s*isThrownMode\s*\|\|\s*\(isRanged\s*&&\s*!useMelee\)/);
});

test("Throw chat card carries the weapon's range as a dedicated chip", () => {
    /* The card shows the weapon's throw range as its own `Range` chip
     * on the chip row when the strike is a throw. Sentinels (N/A,
     * "-", "--") are filtered so a bullwhip mistakenly reaching the
     * throw path doesn't render "Range N/A". */
    assert.match(mixinSrc, /throwRangeStr\s*=\s*\(isThrowStrike\s*&&\s*rawRange/);
    assert.match(mixinSrc, /!\/\^n\\\/\?a\$\/i\.test\(rawRange\)/);
    /* Range appears as a chip, not just in the subtitle. The label is now
     * localized via t(...) (fallback "Range") rather than a bare literal. */
    assert.match(mixinSrc, /throwRangeStr\s*\?\s*\{\s*label:\s*t\([^)]*"Range"[^)]*\),\s*value:\s*throwRangeStr\s*\}\s*:\s*null/);
});

test("Weapon drop-on-throw fires on any throw strike (not just weaponType='thrown')", () => {
    /* Post-refactor: the drop signal is decl.strikeMeta.thrown — the
     * strike itself — not the weapon's type. A hand-axe hurled via the
     * throw strike drops to the canvas the same way a dedicated dart
     * used to. Legacy weaponType-based double-check is gone. */
    assert.match(mixinSrc, /if \(decl\?\.strikeMeta\?\.thrown\) \{\s*try \{ await this\._dropThrownWeapon/);
    assert.doesNotMatch(mixinSrc, /wasThrownStrike\s*=/);
});

test("EO weapon pack — no weapon carries weaponType='thrown'", () => {
    /* User directive: under Combat Extended, thrown isn't a weapon type
     * anymore. Every EO weapon lives as `weaponType: "melee"` and is
     * throwable via the CE any-weapon-with-range rule. */
    const here = dirname(fileURLToPath(import.meta.url));
    const eoDir = join(here, "..", "..", "packs-src", "eo-weapons");
    let files = [];
    try { files = readdirSync(eoDir).filter(f => f.endsWith(".json")); }
    catch (_) { /* packs-src is optional in some checkouts */ return; }
    const thrownFiles = [];
    for (const f of files) {
        const data = JSON.parse(readFileSync(join(eoDir, f), "utf8"));
        if (data?.system?.weaponType === "thrown") thrownFiles.push(f);
    }
    assert.equal(thrownFiles.length, 0,
        `EO weapons still carrying weaponType="thrown": ${thrownFiles.join(", ")}`);
});
