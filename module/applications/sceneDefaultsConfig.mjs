/**
 * SceneDefaultsLauncher — the "Default Scene Settings" entry in Configure
 * Settings. It is NOT a form of its own: it opens the hidden "Default Scene
 * Template" scene in Foundry's native SceneConfig (creating it on first use),
 * so the GM edits every scene setting through the real, familiar sheet.
 *
 * The template's settings are seeded onto newly created blank scenes by
 * policy/scene-defaults.mjs on preCreateScene. This is a DEFAULT, not a global
 * override: existing scenes are never touched.
 */

import { openDefaultSceneTemplate } from "../policy/scene-defaults.mjs";

const { ApplicationV2 } = foundry.applications.api;

export class SceneDefaultsLauncher extends ApplicationV2 {

    /** Foundry instantiates the menu `type` and calls render(). We hijack that
     *  to open the template scene's native config instead of showing a window. */
    async render(_options) {
        await openDefaultSceneTemplate();
        return this;
    }
}
