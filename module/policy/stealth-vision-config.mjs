/**
 * stealth-vision-config — token config UI patch for the two-parameter
 * vision system (True / Allowed).
 *
 * Two DOM mutations on every TokenConfig render:
 *
 *   1. Relabel Foundry's stock "Vision Angle" field (bound to
 *      `sight.angle`) to "True Vision Angle" — that field now
 *      represents the creature's biological / natural max FOV,
 *      which is used for peripheral-band boundaries.
 *
 *   2. Inject a new "Allowed Vision Angle" numeric input right
 *      below it, bound to
 *      `flags.witcher-ttrpg-death-march.allowedVisionAngle`.
 *      Foundry auto-serializes fields with dotted `name=` into the
 *      correct nested document path on submit, so no custom save
 *      handler is needed. Empty / 0 = no equipment restriction
 *      (falls back to True).
 *
 * Version-agnostic hook registration mirrors ring-portrait-button:
 * we listen on every TokenConfig hook name Foundry has used across
 * v12 / v13 / v14 / prototype variants; the injector is idempotent
 * so re-renders don't stack duplicate fields.
 */

import { TRUE_ANGLE_FLAG, ALLOWED_ANGLE_FLAG } from "../mechanics/stealth-hooks.mjs";
import { t } from "../chrome/lib/i18n.js";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const INJECT_MARK = "wdmStealthAllowedFieldInjected";

/* Hook names — matches ring-portrait-button's cover-all-versions
 * strategy. */
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

/** Locate Foundry's Vision Angle form-group. Foundry v14 markup:
 *     <div class="form-group">
 *       <label>Vision Angle</label>
 *       <div class="form-fields">
 *         <input type="number" name="sight.angle" ...>
 *         ...
 *       </div>
 *     </div>
 *
 *  Older versions may use slightly different structure but the
 *  `input[name="sight.angle"]` selector has held stable. */
function findVisionAngleGroup(root) {
    const input = root.querySelector('input[name="sight.angle"]');
    if (!input) return null;
    return { input, group: input.closest(".form-group") };
}

function injectVisionFields(root, app) {
    if (root.dataset[INJECT_MARK] === "1") return;   /* idempotent */
    const found = findVisionAngleGroup(root);
    if (!found?.group) return;

    /* Rebind Foundry's stock "Vision Angle" input to the True flag
     * — the user now enters TRUE here (biological max). Combined
     * with the Allowed flag below, both cap `sight.angle` (see
     * preUpdateToken hook). Relabel + retooltip to match. */
    const doc = app?.document ?? app?.object ?? app?.token ?? null;

    const label = found.group.querySelector("label");
    if (label) {
        label.textContent = t("WITCHER.Policy.StealthVisionConfig.TrueLabel", "True Vision Angle");
    }
    if (found.input) {
        /* Rewrite name so the form submits to the flag, not
         * sight.angle. Preload the current True value. */
        found.input.setAttribute("name", `flags.${SYSTEM_ID}.${TRUE_ANGLE_FLAG}`);
        found.input.setAttribute("title",
            t("WITCHER.Policy.StealthVisionConfig.TrueTooltip",
              "Biological max field of view. Peripheral bands compute off this value. Also caps rendered vision when smaller than Allowed."));
        const currentTrue = Number(doc?.getFlag?.(SYSTEM_ID, TRUE_ANGLE_FLAG));
        if (Number.isFinite(currentTrue) && currentTrue > 0) {
            found.input.value = String(currentTrue);
        } else {
            /* Preload from sight.angle so users see their previously
             * configured value; the preUpdateToken hook will migrate
             * it to the flag on first save. */
            const s = Number(doc?.sight?.angle);
            if (Number.isFinite(s) && s > 0) found.input.value = String(s);
        }
    }

    /* Inject Allowed as a sibling below True. */
    const currentAllowed = Number(doc?.getFlag?.(SYSTEM_ID, ALLOWED_ANGLE_FLAG));
    const allowedValue = Number.isFinite(currentAllowed) && currentAllowed > 0
        ? String(currentAllowed) : "";
    const allowedFieldHtml = `
        <div class="form-group" data-wdm-allowed-vision="1">
            <label title="${t("WITCHER.Policy.StealthVisionConfig.AllowedTooltip",
                "Equipment-limited field of view (helmet, hood). Also caps rendered vision when smaller than True. Leave blank / 0 = no restriction beyond True.")}">${
                t("WITCHER.Policy.StealthVisionConfig.AllowedLabel", "Allowed Vision Angle")
            }</label>
            <div class="form-fields">
                <input type="number"
                       name="flags.${SYSTEM_ID}.${ALLOWED_ANGLE_FLAG}"
                       value="${allowedValue}"
                       min="0" max="360" step="1"
                       placeholder="${t("WITCHER.Policy.StealthVisionConfig.AllowedPlaceholder", "same as True")}">
            </div>
            <p class="hint">${
                t("WITCHER.Policy.StealthVisionConfig.AllowedHint",
                  "Additional restriction from equipment. Foundry's rendered vision cone equals the smaller of True and Allowed. Peripheral bands stay computed off True so a helmet doesn't buff peripheral detection.")
            }</p>
        </div>
    `;
    found.group.insertAdjacentHTML("afterend", allowedFieldHtml);
    root.dataset[INJECT_MARK] = "1";
}

/** preUpdateToken hook — whenever the True or Allowed flag changes
 *  (via our injected form fields OR any other write), compute
 *  `sight.angle = min(True, Allowed)` and merge it into the same
 *  update so Foundry's rendered vision cone matches. This is what
 *  makes True actually restrict FOV — sight.angle is the value
 *  Foundry consumes for LOS rendering. */
function onPreUpdateToken(tokenDoc, changes) {
    const flagChanges = changes?.flags?.[SYSTEM_ID];
    if (!flagChanges) return;
    const trueTouched    = TRUE_ANGLE_FLAG    in flagChanges;
    const allowedTouched = ALLOWED_ANGLE_FLAG in flagChanges;
    if (!trueTouched && !allowedTouched) return;

    /* Resolve effective values: pull from the update if the flag
     * is being written this round, else read the current stored
     * value. Blank / 0 means "unset" → treat as unbounded (360). */
    const readEffective = (updateVal, currentVal) => {
        const src = updateVal !== undefined ? updateVal : currentVal;
        const n = Number(src);
        return (Number.isFinite(n) && n > 0) ? n : 360;
    };

    const trueVal    = readEffective(flagChanges[TRUE_ANGLE_FLAG],    tokenDoc.getFlag(SYSTEM_ID, TRUE_ANGLE_FLAG));
    const allowedVal = readEffective(flagChanges[ALLOWED_ANGLE_FLAG], tokenDoc.getFlag(SYSTEM_ID, ALLOWED_ANGLE_FLAG));
    const effective  = Math.min(trueVal, allowedVal);

    /* Merge into the update payload so it commits in the same
     * write cycle as the flag change. Preserves other pending
     * `sight.*` edits. */
    changes.sight = { ...(changes.sight ?? {}), angle: effective };
}

export function registerStealthVisionConfig() {
    for (const name of HOOK_NAMES) {
        Hooks.on(name, (app, html) => {
            try {
                const root = asElement(html);
                if (!root) return;
                injectVisionFields(root, app);
            } catch (err) {
                console.warn(`${SYSTEM_ID} | stealth-vision-config injection failed`, err);
            }
        });
    }
    /* Sync sight.angle to min(True, Allowed) on any flag write —
     * covers form submits, macro flag sets, and third-party writes. */
    Hooks.on("preUpdateToken",          onPreUpdateToken);
    Hooks.on("preUpdatePrototypeToken", onPreUpdateToken);
    Hooks.on("preUpdateActor", (actorDoc, changes) => {
        /* Prototype-token flag edits on an actor go through
         * updateActor with `prototypeToken.flags[...]`. Route
         * those through the same computation. */
        const proto = changes?.prototypeToken;
        if (!proto?.flags?.[SYSTEM_ID]) return;
        const fakeToken = actorDoc.prototypeToken;
        /* onPreUpdateToken mutates the `sight` key of the object it's
         * handed (see line ~156). Give it a real sub-object we can read
         * back, then propagate the computed sight.angle into the actual
         * prototypeToken payload — otherwise the recompute is written to
         * a throwaway and the prototype keeps its stale sight.angle. */
        const sub = { flags: proto.flags, sight: proto.sight };
        onPreUpdateToken(fakeToken, sub);
        if (sub.sight !== undefined) {
            proto.sight = { ...(proto.sight ?? {}), ...sub.sight };
        }
    });

    /* Spawn-time safety net. A token dropped from a prototype copies the
     * prototype's stored sight.angle verbatim. Prototypes saved before
     * this fix (or before the two-parameter system existed) carry a stale
     * angle — commonly 0 — even though their True/Allowed flags are set,
     * so the dropped token renders the wrong cone until it's re-edited on
     * canvas. Recompute sight.angle = min(True, Allowed) from the token's
     * own flags at creation. Only fires when a flag is actually configured,
     * so tokens that never opted into the two-parameter system keep their
     * stock sight.angle untouched. */
    Hooks.on("preCreateToken", (tokenDoc) => {
        const rawTrue    = Number(tokenDoc.getFlag?.(SYSTEM_ID, TRUE_ANGLE_FLAG));
        const rawAllowed = Number(tokenDoc.getFlag?.(SYSTEM_ID, ALLOWED_ANGLE_FLAG));
        const hasTrue    = Number.isFinite(rawTrue)    && rawTrue    > 0;
        const hasAllowed = Number.isFinite(rawAllowed) && rawAllowed > 0;
        if (!hasTrue && !hasAllowed) return;
        const effective = Math.min(hasTrue ? rawTrue : 360, hasAllowed ? rawAllowed : 360);
        if (tokenDoc.sight?.angle !== effective) {
            tokenDoc.updateSource({ sight: { angle: effective } });
        }
    });
}
