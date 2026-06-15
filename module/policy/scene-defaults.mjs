/**
 * Default scene settings — a "template scene" whose configuration is copied
 * onto every newly created scene, so the GM doesn't have to re-set token
 * vision, grid, environment, etc. by hand each time.
 *
 * Design (mirrors how Foundry backs its own "default token" with a document):
 *  - The template is a real, hidden Scene flagged `isDefaultTemplate`. The GM
 *    edits it through the *native* SceneConfig — every tab, grid alignment and
 *    environment preview work for real because it's a genuine scene.
 *  - On `preCreateScene` we copy the template's settings (minus identity and
 *    content: name, image, dimensions, embedded placeables…) onto the new
 *    scene, but ONLY when the new scene is blank — a fresh "Create Scene". A
 *    scene with a background or any placeables (a Duplicate or an Adventure
 *    import) is left exactly as-is.
 *
 * This is DEFAULT seeding, not a GLOBAL override: existing scenes are never
 * touched, and a seeded scene is freely editable afterwards.
 */

const SYSTEM_ID = "witcher-ttrpg-death-march";
const TEMPLATE_FLAG = "isDefaultTemplate";

/* Scene fields that are identity, geometry, or content — never copied from
   the template onto a new scene (those come from the new scene / its map). */
const COPY_EXCLUDE = new Set([
    "_id", "_stats", "name", "navName", "navOrder", "navigation", "active",
    "sort", "folder", "ownership",
    "background", "foreground", "thumb", "width", "height", "initial",
    "journal", "journalEntryPage", "playlist", "playlistSound",
    "drawings", "tokens", "lights", "notes", "sounds", "regions", "templates",
    "tiles", "walls", "levels"
]);

const EMBEDDED_KEYS = ["tokens", "walls", "tiles", "lights", "notes", "sounds", "drawings", "regions", "templates"];

/** Locate the hidden template scene, if one has been created. */
function findTemplateScene() {
    return game.scenes?.find(s => s.getFlag(SYSTEM_ID, TEMPLATE_FLAG)) ?? null;
}

/** A fresh "Create Scene" is blank; a Duplicate / import carries content. */
function sceneHasContent(scene) {
    const src = scene._source ?? {};
    if (src.background?.src) return true;
    for (const key of EMBEDDED_KEYS) {
        if (scene[key]?.size) return true;
        if (Array.isArray(src[key]) && src[key].length) return true;
    }
    return false;
}

/** Build the settings patch to seed onto a new scene from the template. */
function buildTemplatePatch(templateScene) {
    const data = templateScene.toObject();
    const patch = {};
    for (const [k, v] of Object.entries(data)) {
        if (!COPY_EXCLUDE.has(k)) patch[k] = v;
    }
    // Strip our own marker so the seeded scene isn't mistaken for the template.
    if (patch.flags?.[SYSTEM_ID]) {
        patch.flags = foundry.utils.deepClone(patch.flags);
        delete patch.flags[SYSTEM_ID][TEMPLATE_FLAG];
        if (foundry.utils.isEmpty(patch.flags[SYSTEM_ID])) delete patch.flags[SYSTEM_ID];
    }
    return patch;
}

/** preCreateScene handler — seed a blank new scene from the template. */
export function applyDefaultSceneSettings(scene, data) {
    const src = scene._source ?? data ?? {};
    if (src.flags?.[SYSTEM_ID]?.[TEMPLATE_FLAG]) return;   // never seed the template itself
    if (sceneHasContent(scene)) return;                    // a duplicate / import — leave it

    const template = findTemplateScene();
    if (!template || template.id === scene.id) return;

    const patch = buildTemplatePatch(template);
    if (!foundry.utils.isEmpty(patch)) scene.updateSource(patch);
}

/**
 * Open the template scene's native configuration sheet, creating the hidden
 * template scene on first use. Launched from the "Default Scene Settings"
 * settings menu.
 */
export async function openDefaultSceneTemplate() {
    let scene = findTemplateScene();
    if (!scene) {
        const SceneCls = getDocumentClass("Scene");
        scene = await SceneCls.create({
            name: game.i18n.localize("WITCHER.Settings.SceneDefaults.TemplateName"),
            navigation: false,
            flags: { [SYSTEM_ID]: { [TEMPLATE_FLAG]: true } }
        });
        ui.notifications.info(game.i18n.localize("WITCHER.Settings.SceneDefaults.Created"));
    }
    scene?.sheet.render(true);
    return scene;
}
