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

const SYSTEM_ID = "witcher-ttrpg-death-march";

export const WEATHER_MODE_FLAG = "weatherMode";
export const NO_TIME_DARKNESS_FLAG = "disableTimeDarkness";

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
        else await scene.update({ [`flags.${SYSTEM_ID}.-=${NO_TIME_DARKNESS_FLAG}`]: null }, { render: false });
    } catch (err) { console.warn("[wdm] scene disableTimeDarkness update failed", err); }
}

/* ─────────── Scene-config buttons ──────────────────────────────────────────── */

const FLAG_PATH = `flags.${SYSTEM_ID}.${WEATHER_MODE_FLAG}`;
const FLAG_UNSET = `flags.${SYSTEM_ID}.-=${WEATHER_MODE_FLAG}`;

/* Set a scene's weather mode directly (Outdoors clears the flag back to default).
 * Written with render:false so it doesn't blow away unsaved edits in an open
 * Scene config — the canvas FX still react via the updateScene hook regardless.
 * Shared by the Scene-config buttons and the GM weather panel. */
export async function setSceneWeatherMode(scene, mode) {
    if (!scene) return WEATHER_MODES.OUTDOOR;
    const next = (mode === WEATHER_MODES.INDOOR || mode === WEATHER_MODES.OFF)
        ? mode : WEATHER_MODES.OUTDOOR;
    try {
        if (next === WEATHER_MODES.OUTDOOR) await scene.update({ [FLAG_UNSET]: null }, { render: false });
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

    fs.append(legend, hint, fields, darkHint);
    tab.appendChild(fs);
}

/** Register the Scene-config injection. Call once at init. */
export function registerSceneWeatherMode() {
    Hooks.on("renderSceneConfig", onRenderSceneConfig);
}
