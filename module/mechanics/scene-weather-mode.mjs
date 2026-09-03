/**
 * Per-scene weather mode — a GM-authored scene flag that lets a single scene opt
 * out of the global weather presentation without touching the weather engine:
 *
 *   "outdoor" (default) — full weather: particles, scene tint/darkness, lightning,
 *                         and ambience play normally.
 *   "indoor"            — you're inside: NO particles, NO weather tint/darkness,
 *                         NO lightning flashes, and the ambience is faded down +
 *                         low-pass "muffled", as if the storm is heard through
 *                         walls.
 *   "off"               — weather is irrelevant here (a deep dungeon, an abstract
 *                         map): everything off, ambience silenced too.
 *
 * The flag is read per-CLIENT against the locally VIEWED scene (`canvas.scene`):
 * what you are looking at decides what you see and hear. Visuals are already
 * local per client, so they just gate on this. The weather ambience is a single
 * GLOBAL synced playlist ("the party's weather"), so it can't be toggled per
 * scene at the document level — instead each client locally muffles / silences
 * the playlist's live Sound nodes for its own viewed scene (see
 * `syncSceneWeatherAudio`). Nothing here writes the playlist or scene document
 * beyond the GM's explicit button press.
 */

import { getAssignedActor } from "../chrome/lib/actor.js";

const SYSTEM_ID = "witcher-ttrpg-death-march";

export const WEATHER_MODE_FLAG = "weatherMode";
export const NO_TIME_DARKNESS_FLAG = "disableTimeDarkness";
/* GM-pinned scene light tier (theater-of-the-mind). Must match light-level.mjs's
 * LIGHT_OVERRIDE_FLAG. "" / unset = Auto. */
export const LIGHT_OVERRIDE_FLAG = "lightOverride";

/* Picker options: value = LIGHT_TIERS key ("" = Auto), label = i18n key. */
export const LIGHT_OVERRIDE_OPTIONS = Object.freeze([
    { value: "",         label: "WITCHER.Weather.SceneMode.LightAuto" },
    { value: "bright",   label: "WITCHER.Light.Tier.Bright" },
    { value: "daylight", label: "WITCHER.Light.Tier.Daylight" },
    { value: "dim1",     label: "WITCHER.Weather.SceneMode.LightDim1" },
    { value: "dim2",     label: "WITCHER.Weather.SceneMode.LightDim2" },
    { value: "dim3",     label: "WITCHER.Weather.SceneMode.LightDim3" },
    { value: "darkness", label: "WITCHER.Light.Tier.Darkness" },
    { value: "pitch",    label: "WITCHER.Light.Tier.Pitch" }
]);

export const WEATHER_MODES = Object.freeze({
    OUTDOOR: "outdoor",
    INDOOR: "indoor",
    OFF: "off"
});

/** The weather mode of a scene, normalised. Unknown / unset → "outdoor". */
export function sceneWeatherMode(scene = canvas?.scene) {
    const m = scene?.getFlag?.(SYSTEM_ID, WEATHER_MODE_FLAG);
    return (m === WEATHER_MODES.INDOOR || m === WEATHER_MODES.OFF) ? m : WEATHER_MODES.OUTDOOR;
}

/** True when the viewed scene should show NO weather visuals (indoor OR off). */
export function suppressWeatherVisuals(scene = canvas?.scene) {
    return sceneWeatherMode(scene) !== WEATHER_MODES.OUTDOOR;
}

/* ── Per-viewer region overrides ─────────────────────────────────────────────
 * Tokens inside regions with certain behaviors override the base scene
 * mode LOCALLY for the client whose viewer (assigned actor / controlled
 * token) is inside them:
 *
 *   `wdmWeatherAudio` (behavior we author) — sets an audio mode +
 *      optional volume override, no visual effect.
 *   `suppressWeather` (Foundry core) — visual suppression at the
 *      region shape; we also read it here so lightning flashes for
 *      the viewer are muted when their token is inside one (a
 *      full-screen flash can't be region-shaped, so the correct read
 *      is "the viewer's PoV is sheltered from the storm; don't flash
 *      the screen for them").
 */

/* Collect the client's "viewer tokens" — TokenDocuments on the current
 * scene whose position feeds these per-viewer overrides. Routes through
 * the DM chrome's `getAssignedActor()` so the viewer identity matches
 * every other DM subsystem (dock, chrome, immersive camera): a single
 * owned controlled token when present, a GM's view-as override
 * (`setActorOverride`), or the user's assigned character as fallback.
 * Also folds in ANY controlled owned tokens (GMs often control an NPC
 * while their character is null) so the region check still fires for
 * "the token I'm actively driving". */
function viewerTokens() {
    const scene = canvas?.scene;
    if (!scene) return [];
    const tokens = new Set();
    /* Every owned controlled token — covers GMs driving NPCs, players
     * with multiple pets, etc. */
    for (const t of (canvas?.tokens?.controlled ?? [])) {
        if (t?.document?.isOwner) tokens.add(t.document);
    }
    const assignedActor = getAssignedActor();
    if (assignedActor?.token) tokens.add(assignedActor.token);
    else if (assignedActor?.id) {
        for (const td of scene.tokens) {
            if (td.actorId === assignedActor.id) tokens.add(td);
        }
    }
    return [...tokens];
}

/* Walk viewer tokens' region memberships and reduce them to the
 * effective audio config for the CURRENT client. `off` wins over
 * `indoor`; the strongest indoor volumeOverride (largest number,
 * treating 0 as "no override") wins among indoor matches. When no
 * region applies, returns the scene mode + null volumeOverride. */
export function effectiveWeatherAudio() {
    const scene = canvas?.scene;
    const baseMode = sceneWeatherMode(scene);
    if (!scene) return { mode: baseMode, volumeOverride: null };

    const tokens = viewerTokens();
    if (!tokens.length) return { mode: baseMode, volumeOverride: null };

    let regionMode = null;      // "off" | "indoor" | null
    let volumeOverride = null;
    for (const region of scene.regions) {
        // Skip regions no viewer token is inside.
        let inside = false;
        for (const td of tokens) { if (region.tokens.has(td)) { inside = true; break; } }
        if (!inside) continue;
        for (const behavior of region.behaviors) {
            if (behavior.disabled) continue;
            if (behavior.type !== "wdmWeatherAudio") continue;
            const m = behavior.system?.mode;
            if (m === "off") regionMode = "off";
            else if (m === "indoor" && regionMode !== "off") {
                if (regionMode !== "indoor") regionMode = "indoor";
                const v = Number(behavior.system?.volumeOverride) || 0;
                if (v > 0 && (volumeOverride == null || v > volumeOverride)) volumeOverride = v;
            }
        }
    }

    if (regionMode === "off")    return { mode: WEATHER_MODES.OFF,    volumeOverride: null };
    if (regionMode === "indoor") return { mode: WEATHER_MODES.INDOOR, volumeOverride };
    return { mode: baseMode, volumeOverride: null };
}

/* True when the current client's viewer token is inside a Foundry-core
 * `suppressWeather` region. Used to gate lightning flashes for the
 * local viewer regardless of the scene's own weather mode. */
export function viewerInsideSuppressWeather() {
    const scene = canvas?.scene;
    if (!scene) return false;
    const tokens = viewerTokens();
    if (!tokens.length) return false;
    for (const region of scene.regions) {
        let inside = false;
        for (const td of tokens) { if (region.tokens.has(td)) { inside = true; break; } }
        if (!inside) continue;
        for (const behavior of region.behaviors) {
            if (behavior.disabled) continue;
            if (behavior.type === "suppressWeather") return true;
        }
    }
    return false;
}

/* True when a SPECIFIC token (not the viewer) sits inside a Foundry-core
 * `suppressWeather` region — the per-token version of the check above. Used by
 * Snow Blindness so a character sheltered in an ignore-weather region takes no
 * penalty, matching the rest of the weather-track exposure gating. */
export function tokenInsideSuppressWeather(tokenDoc) {
    const doc = tokenDoc?.document ?? tokenDoc;
    const scene = doc?.parent ?? canvas?.scene;
    if (!scene || !doc) return false;
    for (const region of scene.regions) {
        if (!region.tokens.has(doc)) continue;
        for (const behavior of region.behaviors) {
            if (behavior.disabled) continue;
            if (behavior.type === "suppressWeather") return true;
        }
    }
    return false;
}

/** The scene's pinned light tier, or "" for Auto. */
export function sceneLightOverrideValue(scene = canvas?.scene) {
    const t = scene?.getFlag?.(SYSTEM_ID, LIGHT_OVERRIDE_FLAG);
    return LIGHT_OVERRIDE_OPTIONS.some(o => o.value === t && o.value !== "") ? t : "";
}

/* Set the scene light override ("" = Auto → clear the flag). render:false so it
 * doesn't blow away unsaved Scene-config edits; the canvas reacts via updateScene. */
export async function setSceneLightOverride(scene, tier) {
    if (!scene) return;
    const val = LIGHT_OVERRIDE_OPTIONS.some(o => o.value === tier && o.value !== "") ? tier : "";
    try {
        if (val) await scene.update({ [`flags.${SYSTEM_ID}.${LIGHT_OVERRIDE_FLAG}`]: val }, { render: false });
        else await scene.update({ [`flags.${SYSTEM_ID}.-=${LIGHT_OVERRIDE_FLAG}`]: null }, { render: false });
    } catch (err) { console.warn(`${SYSTEM_ID} | scene lightOverride update failed`, err); }
}

/** True when this scene opts OUT of the day/night darkness cycle — its authored
 * lighting stays fixed regardless of the in-world time. */
export function isTimeDarknessDisabled(scene = canvas?.scene) {
    return !!scene?.getFlag?.(SYSTEM_ID, NO_TIME_DARKNESS_FLAG);
}

/* Toggle the per-scene "Disable Time Darkness" flag (render:false so it doesn't
 * blow away unsaved Scene-config edits; the canvas reacts via updateScene). */
export async function setSceneTimeDarknessDisabled(scene, on) {
    if (!scene) return;
    try {
        if (on) await scene.update({ [`flags.${SYSTEM_ID}.${NO_TIME_DARKNESS_FLAG}`]: true }, { render: false });
        else await scene.update({ [`flags.${SYSTEM_ID}.${NO_TIME_DARKNESS_FLAG}`]: new foundry.data.operators.ForcedDeletion() }, { render: false });
    } catch (err) { console.warn("[wdm] scene disableTimeDarkness update failed", err); }
}

/* ─────────── Scene-config buttons ──────────────────────────────────────────── */

const FLAG_PATH = `flags.${SYSTEM_ID}.${WEATHER_MODE_FLAG}`;

/* Set a scene's weather mode directly (Outdoors clears the flag back to default).
 * Written with render:false so it doesn't blow away unsaved edits in an open
 * Scene config — the canvas FX still react via the updateScene hook regardless.
 * Shared by the Scene-config buttons and the GM weather panel. */
export async function setSceneWeatherMode(scene, mode) {
    if (!scene) return WEATHER_MODES.OUTDOOR;
    const next = (mode === WEATHER_MODES.INDOOR || mode === WEATHER_MODES.OFF)
        ? mode : WEATHER_MODES.OUTDOOR;
    try {
        /* Outdoors = clear the flag back to default. Use the v14 ForcedDeletion
         * operator (matches setSceneTimeDarknessDisabled above) instead of the
         * legacy `-=weatherMode` key, which Foundry now warns is deprecated. */
        if (next === WEATHER_MODES.OUTDOOR) await scene.update({ [FLAG_PATH]: new foundry.data.operators.ForcedDeletion() }, { render: false });
        else await scene.update({ [FLAG_PATH]: next }, { render: false });
    } catch (err) { console.warn("[wdm] scene weatherMode update failed", err); }
    return next;
}

function modeButton(mode, icon, label, active) {
    const btn = document.createElement("button");
    btn.type = "button";                                  // never submit the config form
    btn.className = `wdm-weather-mode-btn${active ? " active" : ""}`;
    btn.dataset.mode = mode;
    btn.setAttribute("aria-pressed", String(active));
    btn.innerHTML = `<i class="fa-solid ${icon}"></i> ${label}`;
    return btn;
}

function onRenderSceneConfig(app, html) {
    if (!game.user?.isGM) return;
    const root = html instanceof HTMLElement ? html : (html?.[0] ?? html);
    const tab = root?.querySelector('[data-application-part="environment"]')
        ?? root?.querySelector('[data-tab="environment"]');
    if (!tab || tab.querySelector(".wdm-weather-mode")) return;   // no tab / already injected

    const scene = app.document;
    const L = (k) => game.i18n.localize(k);
    const mode = sceneWeatherMode(scene);

    const fs = document.createElement("fieldset");
    fs.className = "wdm-weather-mode";
    const legend = document.createElement("legend");
    legend.textContent = L("WITCHER.Weather.SceneMode.Legend");
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = L("WITCHER.Weather.SceneMode.Hint");
    const fields = document.createElement("div");
    fields.className = "form-fields";

    const buttons = [
        modeButton(WEATHER_MODES.OUTDOOR, "fa-cloud-sun", L("WITCHER.Weather.SceneMode.Outdoors"), mode === WEATHER_MODES.OUTDOOR),
        modeButton(WEATHER_MODES.INDOOR, "fa-house", L("WITCHER.Weather.SceneMode.Indoors"), mode === WEATHER_MODES.INDOOR),
        modeButton(WEATHER_MODES.OFF, "fa-cloud-slash", L("WITCHER.Weather.SceneMode.Disable"), mode === WEATHER_MODES.OFF)
    ];
    for (const btn of buttons) {
        btn.addEventListener("click", async () => {
            const next = await setSceneWeatherMode(scene, btn.dataset.mode);
            for (const b of buttons) {
                const on = b.dataset.mode === next;
                b.classList.toggle("active", on);
                b.setAttribute("aria-pressed", String(on));
            }
        });
        fields.appendChild(btn);
    }

    // "Disable Time Darkness" — an INDEPENDENT per-scene toggle (not a mode):
    // pins the scene's authored lighting regardless of the in-world time, for
    // maps that shouldn't go dark at 3 a.m. (a torch-lit dungeon). A 4th button
    // next to the mode buttons, with its own pressed state.
    const darkBtn = document.createElement("button");
    darkBtn.type = "button";
    const darkOn = isTimeDarknessDisabled(scene);
    darkBtn.className = `wdm-weather-mode-btn wdm-weather-dark-btn${darkOn ? " active" : ""}`;
    darkBtn.setAttribute("aria-pressed", String(darkOn));
    darkBtn.innerHTML = `<i class="fa-solid fa-lightbulb"></i> ${L("WITCHER.Weather.SceneMode.NoTimeDarkness")}`;
    darkBtn.addEventListener("click", async () => {
        const next = !isTimeDarknessDisabled(scene);
        await setSceneTimeDarknessDisabled(scene, next);
        darkBtn.classList.toggle("active", next);
        darkBtn.setAttribute("aria-pressed", String(next));
    });
    fields.appendChild(darkBtn);

    const darkHint = document.createElement("p");
    darkHint.className = "hint";
    darkHint.textContent = L("WITCHER.Weather.SceneMode.NoTimeDarknessHint");

    // Scene Light Override — pins the whole scene to a fixed light tier for
    // theater-of-the-mind scenes (no map, no light objects). "" = Auto (sample
    // canvas + time + weather). Absolute when set; vision waivers still apply.
    const lightRow = document.createElement("label");
    lightRow.className = "wdm-weather-lightoverride";
    lightRow.style.cssText = "display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;margin-top:0.4rem;";
    const lightLabel = document.createElement("span");
    lightLabel.innerHTML = `<i class="fa-solid fa-circle-half-stroke"></i> ${L("WITCHER.Weather.SceneMode.LightOverride")}`;
    const lightSel = document.createElement("select");
    lightSel.style.minWidth = "10rem";
    const curOv = sceneLightOverrideValue(scene);
    for (const opt of LIGHT_OVERRIDE_OPTIONS) {
        const o = document.createElement("option");
        o.value = opt.value;
        o.textContent = L(opt.label);
        if (opt.value === curOv) o.selected = true;
        lightSel.appendChild(o);
    }
    lightSel.addEventListener("change", () => setSceneLightOverride(scene, lightSel.value));
    lightRow.append(lightLabel, lightSel);

    const lightHint = document.createElement("p");
    lightHint.className = "hint";
    lightHint.textContent = L("WITCHER.Weather.SceneMode.LightOverrideHint");

    fs.append(legend, hint, fields, darkHint, lightRow, lightHint);
    tab.appendChild(fs);
}

/** Register the Scene-config injection. Call once at init. */
export function registerSceneWeatherMode() {
    Hooks.on("renderSceneConfig", onRenderSceneConfig);
}
