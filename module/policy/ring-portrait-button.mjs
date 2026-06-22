/**
 * ring-portrait-button — injects a "Crop From Portrait" button into
 * Foundry's Token / Prototype Token Configuration dialog, next to the
 * Subject Texture / Subject Scale fields of the Dynamic Token Ring
 * section.
 *
 * Foundry v12 / v13 / v14 each use a slightly different class name and
 * markup for token configuration:
 *
 *   v12   : TokenConfig                (renderTokenConfig)
 *   v13   : TokenConfig V2             (renderTokenConfig)
 *   v14   : TokenConfig V2 / PrototypeTokenConfig
 *           → render hooks named after the class
 *
 * We register on ALL plausible hook names; the predicate below filters to
 * the form we actually care about. The injector targets any input/element
 * whose `name` ends in `subject.texture` (works for `ring.subject.texture`
 * on placed tokens AND `prototypeToken.ring.subject.texture` on the actor
 * prototype form), and bails idempotently if the button is already there.
 */

import { RingPortraitCropper } from "../applications/ringPortraitCropper.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";

/* Hook names across the Foundry versions we may run under. Registering on
 * all of them is cheap (each app fires exactly one); the inject function
 * is idempotent on re-render. */
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

function actorOf(app) {
    if (app?.actor) return app.actor;
    const doc = app?.token ?? app?.object ?? app?.document;
    if (doc?.actor) return doc.actor;
    // Prototype tokens: doc.parent is the Actor. Placed tokens: doc.parent
    // is the Scene; ignore those for the prototype-only scope.
    if (doc?.parent?.documentName === "Actor") return doc.parent;
    return null;
}

/* Detect a prototype-token form. We accept both the "edit prototype from
 * the actor sheet" entry point (the doc's parent is an Actor) and the
 * `isPrototype: true` flag some classes carry. Placed-token configs (the
 * scene token's gear-icon dialog) are intentionally skipped per scope. */
function isPrototypeForm(app) {
    if (!app) return false;
    if (app.isPrototype === true) return true;
    const doc = app.token ?? app.object ?? app.document;
    return !!(doc?.parent?.documentName === "Actor");
}

function injectButton(app, html) {
    try {
        const root = asElement(html);
        if (!root) return;
        if (!isPrototypeForm(app)) return;

        const actor = actorOf(app);
        if (!actor) return;

        // Idempotent: TokenConfig re-renders on form change. Don't pile
        // up buttons across re-renders.
        if (root.querySelector('[data-wdm-ring-portrait-btn]')) return;

        // Find the Subject Texture row. Try several selector variants to
        // survive markup changes across Foundry versions / V2 inputs that
        // wrap the native <input> in a custom element (file-picker,
        // form-fields wrapper, etc.).
        const candidates = [
            'input[name$="ring.subject.texture"]',
            '[name$="ring.subject.texture"]',
            'input[name*="subject.texture"]',
            '[name*="subject.texture"]',
            'file-picker[name$="ring.subject.texture"]',
            'file-picker[name*="subject.texture"]'
        ];
        let anchor = null;
        for (const sel of candidates) {
            anchor = root.querySelector(sel);
            if (anchor) break;
        }
        if (!anchor) {
            console.warn(`${SYSTEM_ID} | ring-portrait-button: Subject Texture field not found in TokenConfig. Markup may have changed; selectors tried:`, candidates);
            return;
        }

        // Walk up to the row wrapper Foundry uses, falling back to the
        // immediate parent if no .form-group ancestor exists.
        const group = anchor.closest(".form-group, .form-fields, fieldset")
                   ?? anchor.parentElement;
        if (!group) return;

        const button = document.createElement("button");
        button.type = "button";
        button.className = "wdm-ring-portrait-btn";
        button.dataset.wdmRingPortraitBtn = "1";
        button.innerHTML = `<i class="fa-solid fa-crop-simple"></i> Crop Portrait into Token`;
        button.title = "Open the cropper, frame the portrait, and bake a circular token texture onto this actor (no file upload).";
        button.addEventListener("click", async (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            console.log(`${SYSTEM_ID} | ring-portrait-button: click on ${actor.name}, opening cropper…`);
            try {
                const cropper = new RingPortraitCropper({
                    actor,
                    tokenConfigApp: app,
                    sourceImage: actor.img
                });
                await cropper.render(true);
                console.log(`${SYSTEM_ID} | ring-portrait-button: cropper rendered`);
            } catch (err) {
                console.error(`${SYSTEM_ID} | ring-portrait-button: failed to open cropper`, err);
                ui.notifications?.error(`Cropper failed to open: ${err?.message ?? err}. Check console.`);
            }
        });

        group.appendChild(button);
        console.log(`${SYSTEM_ID} | ring-portrait-button: injected on ${app?.constructor?.name ?? "TokenConfig"} for ${actor.name}`);
    } catch (err) {
        console.warn(`${SYSTEM_ID} | ring-portrait-button inject failed`, err);
    }
}

export function registerRingPortraitButton() {
    for (const hookName of HOOK_NAMES) {
        Hooks.on(hookName, (app, html) => injectButton(app, html));
    }
    console.log(`${SYSTEM_ID} | ring-portrait-button: registered on ${HOOK_NAMES.length} hook names`);
}
