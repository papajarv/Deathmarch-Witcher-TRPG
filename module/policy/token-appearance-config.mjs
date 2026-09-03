/**
 * token-appearance-config — injects two death-march controls into the NATIVE
 * Foundry TokenConfig "Appearance" tab (placed tokens + prototype tokens):
 *
 *   1. Token Image Rotation — bound to the core `texture.rotation` field, so a
 *      top-down token's art can be spun to face the way the facing arrow points
 *      (the stock config doesn't surface this field). Foundry renders and
 *      serializes texture.rotation natively; we only add the control. Setting it
 *      on a prototype means dropped tokens spawn already aligned.
 *
 *   2. Facing Arrow — a per-token toggle for the amber facing chevron, bound to
 *      `flags.<sys>.facingArrow`. Default ON (undefined = on); uncheck to hide.
 *      Read by refreshFacingArrow in policy/witcher-token-style.mjs.
 *
 * Version-agnostic hook registration mirrors stealth-vision-config /
 * ring-portrait-button; the injector is idempotent so re-renders don't stack
 * duplicate fields. Fields use dotted `name=` so Foundry auto-serializes them
 * to the right document path on submit — no custom save handler needed.
 */

import { t } from "../chrome/lib/i18n.js";

const SYSTEM_ID = "witcher-ttrpg-death-march";
export const FACING_ARROW_FLAG = "facingArrow";
export const ART_ROTATION_FLAG = "artRotation";
const INJECT_MARK = "wdmTokenAppearanceInjected";

/* Normalize a raw degree input to 0–359. */
function normDeg(raw) {
    const n = Number(raw);
    return Number.isFinite(n) ? ((n % 360) + 360) % 360 : 0;
}

const HOOK_NAMES = [
    "renderTokenConfig",
    "renderTokenConfigV2",
    "renderPrototypeTokenConfig",
    "renderPrototypeTokenConfigV2",
    "renderTokenApplication"
];

function asElement(html) {
    if (html instanceof HTMLElement) return html;
    if (html?.[0] instanceof HTMLElement) return html[0];
    if (html?.element instanceof HTMLElement) return html.element;
    return null;
}

/* A stable anchor in the Appearance / Image tab to inject after. Foundry's
 * markup shifts between versions, so try several texture fields in order. */
function findAppearanceAnchor(root) {
    const selectors = [
        'input[name="texture.scaleX"]',
        'input[name="texture.scale"]',
        'color-picker[name="texture.tint"]',
        'input[name="texture.tint"]',
        'file-picker[name="texture.src"]',
        'input[name="texture.src"]'
    ];
    for (const s of selectors) {
        const el = root.querySelector(s);
        const group = el?.closest(".form-group");
        if (group) return group;
    }
    return null;
}

function injectAppearanceFields(root, app) {
    if (root.dataset[INJECT_MARK] === "1") return;   // idempotent
    const anchor = findAppearanceAnchor(root);
    if (!anchor) return;
    const doc = app?.document ?? app?.object ?? app?.token ?? null;

    let html = "";

    /* 1. Token Image Rotation → a FLAG (not the core texture.rotation input,
     * which AppV2 drops from the submit because it isn't in the config's own
     * template). The preUpdate hooks below mirror the flag onto the live
     * texture.rotation so Foundry actually renders the rotated art. Preload
     * from the flag, falling back to any pre-existing texture.rotation. */
    const curRot = normDeg(doc?.getFlag?.(SYSTEM_ID, ART_ROTATION_FLAG) ?? doc?.texture?.rotation);
    html += `
        <div class="form-group" data-wdm-token-appearance="1">
            <label>${t("WITCHER.Policy.TokenAppearance.ImageRotationLabel", "Token Image Rotation")}</label>
            <div class="form-fields">
                <input type="number" name="flags.${SYSTEM_ID}.${ART_ROTATION_FLAG}" value="${curRot}" step="1" min="0" max="359">
                <span class="units">°</span>
            </div>
            <p class="hint">${t("WITCHER.Policy.TokenAppearance.ImageRotationHint", "Rotate the token artwork (independent of its facing) so top-down art points the way the facing arrow does.")}</p>
        </div>`;

    /* 2. Facing Arrow toggle → flags.<sys>.facingArrow (default ON). Foundry's
     * FormDataExtended reads the checkbox as a boolean, so unchecking saves
     * `false` and re-checking saves `true`. */
    const arrowOn = doc?.getFlag?.(SYSTEM_ID, FACING_ARROW_FLAG) !== false;
    html += `
        <div class="form-group" data-wdm-token-appearance="1">
            <label>${t("WITCHER.Policy.TokenAppearance.FacingArrowLabel", "Facing Arrow")}</label>
            <div class="form-fields">
                <input type="checkbox" name="flags.${SYSTEM_ID}.${FACING_ARROW_FLAG}" ${arrowOn ? "checked" : ""}>
            </div>
            <p class="hint">${t("WITCHER.Policy.TokenAppearance.FacingArrowHint", "Show the amber facing chevron on this token. On by default — uncheck to hide it.")}</p>
        </div>`;

    anchor.insertAdjacentHTML("afterend", html);
    root.dataset[INJECT_MARK] = "1";
}

/* Apply the art-rotation offset to the token mesh. Foundry sets
 * `mesh.angle = doc.rotation` (client/canvas/placeables/token.mjs:1540) and
 * IGNORES texture.rotation for tokens, so we add our per-token offset on top
 * after each refresh. This is a display-only write (no document update, no
 * refresh loop). Skipped for lockRotation tokens — the immersive camera owns
 * their mesh.angle; everything else (the normal rotating token) is ours. */
function applyArtRotation(token) {
    try {
        const doc = token?.document;
        if (!doc || !token.mesh || doc.lockRotation) return;
        const deg = normDeg(doc.getFlag?.(SYSTEM_ID, ART_ROTATION_FLAG));
        if (!deg) return;                         // no offset → leave Foundry's value
        token.mesh.angle = (Number(doc.rotation) || 0) + deg;
    } catch (_) { /* mid-teardown race — ignore */ }
}

export function registerTokenAppearanceConfig() {
    for (const name of HOOK_NAMES) {
        Hooks.on(name, (app, html) => {
            try {
                const root = asElement(html);
                if (!root) return;
                injectAppearanceFields(root, app);
            } catch (err) {
                console.warn(`${SYSTEM_ID} | token-appearance-config injection failed`, err);
            }
        });
    }

    /* refreshToken fires after Foundry has reset mesh.angle to doc.rotation, so
     * re-adding the offset here keeps the art rotated across rotation, movement,
     * and animation frames. drawToken covers the initial draw / scene load. */
    Hooks.on("refreshToken", applyArtRotation);
    Hooks.on("drawToken",    applyArtRotation);
}
