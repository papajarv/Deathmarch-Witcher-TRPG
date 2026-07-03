// Per-item-type catalog filters. Each item type should only show
// qualities its domain can actually consume.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    WEAPON_QUALITIES, ARMOR_QUALITIES,
    isAmmoQuality, isShieldQuality, isArmorPieceQuality,
    filterAmmoQualities, filterShieldQualities, filterArmorPieceQualities
} from "./config.mjs";

test("isAmmoQuality keeps post-hit riders (Bleeding, Stun, Fire, …)", () => {
    assert.equal(isAmmoQuality(WEAPON_QUALITIES.bleeding), true);
    assert.equal(isAmmoQuality(WEAPON_QUALITIES.stun), true);
    assert.equal(isAmmoQuality(WEAPON_QUALITIES.fire), true);
    assert.equal(isAmmoQuality(WEAPON_QUALITIES.knockdown), true);
    assert.equal(isAmmoQuality(WEAPON_QUALITIES.poison), true);
});

test("isAmmoQuality keeps damage flags (Armor Piercing, Ablating, Silver, Meteorite)", () => {
    assert.equal(isAmmoQuality(WEAPON_QUALITIES.armorPiercing), true);
    assert.equal(isAmmoQuality(WEAPON_QUALITIES.improvedArmorPiercing), true);
    assert.equal(isAmmoQuality(WEAPON_QUALITIES.ablating), true);
    assert.equal(isAmmoQuality(WEAPON_QUALITIES.silver), true);
    assert.equal(isAmmoQuality(WEAPON_QUALITIES.meteorite), true);
});

test("isAmmoQuality rejects wield-only / reach / skill weapon qualities", () => {
    assert.equal(isAmmoQuality(WEAPON_QUALITIES.twoHand), false);
    assert.equal(isAmmoQuality(WEAPON_QUALITIES.closeQuarters), false);
    assert.equal(isAmmoQuality(WEAPON_QUALITIES.throwing), false);
    assert.equal(isAmmoQuality(WEAPON_QUALITIES.strangling), false);
    assert.equal(isAmmoQuality(WEAPON_QUALITIES.longReach), false);
    assert.equal(isAmmoQuality(WEAPON_QUALITIES.parrying), false);
    assert.equal(isAmmoQuality(WEAPON_QUALITIES.brawling), false);
    assert.equal(isAmmoQuality(WEAPON_QUALITIES.guard), false);
    assert.equal(isAmmoQuality(WEAPON_QUALITIES.feeble), false);
});

test("filterAmmoQualities yields only projectile-relevant entries", () => {
    const filt = filterAmmoQualities(WEAPON_QUALITIES);
    assert.ok(filt.bleeding, "expected bleeding kept");
    assert.ok(filt.armorPiercing, "expected armorPiercing kept");
    assert.equal(filt.twoHand, undefined);
    assert.equal(filt.longReach, undefined);
    assert.equal(filt.brawling, undefined);
});

test("isShieldQuality picks out the shield-only ARMOR_QUALITIES entries", () => {
    assert.equal(isShieldQuality("sturdyShield"), true);
    assert.equal(isShieldQuality("verySturdy"), true);
    assert.equal(isShieldQuality("parryingShield"), true);
    assert.equal(isShieldQuality("bladeCatcherArmor"), true);
    assert.equal(isShieldQuality("deployable"), true);
    assert.equal(isShieldQuality("archeryShield"), true);
});

test("isArmorPieceQuality rejects shield-only keys but keeps the rest of ARMOR_QUALITIES", () => {
    assert.equal(isArmorPieceQuality("sturdyShield"), false);
    assert.equal(isArmorPieceQuality("parryingShield"), false);
    assert.equal(isArmorPieceQuality("restrictedVision"), true);
    assert.equal(isArmorPieceQuality("difficult"), true);
    assert.equal(isArmorPieceQuality("stifling"), true);
    assert.equal(isArmorPieceQuality("criticalDecimation"), true);
    assert.equal(isArmorPieceQuality("fireproof"), true);
});

test("filterShieldQualities yields only shield-relevant entries", () => {
    const filt = filterShieldQualities(ARMOR_QUALITIES);
    assert.ok(filt.sturdyShield, "sturdyShield kept");
    assert.ok(filt.parryingShield, "parryingShield kept");
    assert.equal(filt.restrictedVision, undefined);
    assert.equal(filt.difficult, undefined);
    assert.equal(filt.criticalDecimation, undefined);
});

test("filterArmorPieceQualities excludes shield-only entries", () => {
    const filt = filterArmorPieceQualities(ARMOR_QUALITIES);
    assert.ok(filt.restrictedVision, "armor-side restrictedVision kept");
    assert.ok(filt.difficult, "armor-side difficult kept");
    assert.equal(filt.sturdyShield, undefined);
    assert.equal(filt.parryingShield, undefined);
    assert.equal(filt.deployable, undefined);
});

test("ammo + shield + armor-piece filters jointly cover their domain", () => {
    // No quality the GM saved on a piece of armor should be invisible
    // when reopening the same sheet (split happens at SHIELD boundary).
    const armorKeys = new Set(Object.keys(filterArmorPieceQualities(ARMOR_QUALITIES)));
    const shieldKeys = new Set(Object.keys(filterShieldQualities(ARMOR_QUALITIES)));
    // Joint coverage of the full ARMOR_QUALITIES catalog.
    for (const k of Object.keys(ARMOR_QUALITIES)) {
        assert.ok(armorKeys.has(k) || shieldKeys.has(k),
            `ARMOR_QUALITIES key "${k}" must appear in either armor-piece or shield filter`);
    }
    // Empty intersection — a key never appears in both.
    for (const k of armorKeys) assert.equal(shieldKeys.has(k), false, `key "${k}" leaked into shield filter`);
});
