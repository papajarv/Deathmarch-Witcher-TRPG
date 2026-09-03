/**
 * `wdmWeatherAudio` region behavior — per-token weather audio override.
 *
 * When a token owned by (or assigned to) the current client is inside a
 * region with this behavior, the LOCAL weather ambience is shaped as if
 * the scene were in Indoor mode (muffled + volume override) or Off mode
 * (silent), regardless of the actual scene-level weather mode.
 *
 * Lets a GM author "you're in a tavern" pockets on an outdoor scene
 * without flipping the whole scene indoors, since a single scene may
 * mix indoor + outdoor spaces (a house on a village map, a cave mouth
 * on a hillside).
 *
 * Visuals stay unchanged — this only touches the local ambience mix
 * (the weather PARTICLE / lightning suppression lives on the core
 * `suppressWeather` region behavior, which is per-region visual only).
 *
 * The behavior fires TOKEN_ENTER / TOKEN_EXIT to trigger a re-sync;
 * scene-weather-mode.effectiveWeatherAudio walks the viewer's owned
 * tokens on every sync and reduces their region memberships to a
 * winning (mode, volumeOverride) tuple.
 */

const { StringField, NumberField } = foundry.data.fields;

const { REGION_EVENTS } = CONST;
const RegionBehaviorType = foundry.data.regionBehaviors.RegionBehaviorType;

export const WEATHER_AUDIO_BEHAVIOR = "wdmWeatherAudio";

export default class WeatherAudioRegionBehaviorType extends RegionBehaviorType {

    static LOCALIZATION_PREFIXES = ["BEHAVIOR.TYPES.wdmWeatherAudio", "BEHAVIOR.TYPES.base"];

    static defineSchema() {
        return {
            mode: new StringField({
                required: true,
                initial: "indoor",
                choices: {
                    indoor: "Indoor (muffled)",
                    off:    "Off (silent)"
                },
                label: "WITCHER.Data.WeatherAudio.Label.AudioMode"
            }),
            /* Only meaningful for `indoor`. When set (>0), the indoor
             * base multiplier used by scene-weather-audio is REPLACED
             * with this value; leave at 0 to fall back to the built-in
             * INDOOR_VOL (0.62). Range 0–1 (relative to the playlist's
             * authored track volume). */
            volumeOverride: new NumberField({
                required: true,
                initial: 0,
                min: 0,
                max: 1,
                step: 0.01,
                label: "WITCHER.Data.WeatherAudio.Label.IndoorVolumeOverride"
            })
        };
    }

    static async #onTokenEnter(event) {
        try {
            const audio = await import("../../mechanics/scene-weather-audio.mjs");
            audio.syncSceneWeatherAudio?.();
        } catch (_) { /* audio module unavailable — nothing to sync */ }
    }

    static async #onTokenExit(event) {
        try {
            const audio = await import("../../mechanics/scene-weather-audio.mjs");
            audio.syncSceneWeatherAudio?.();
        } catch (_) {}
    }

    static events = {
        [REGION_EVENTS.TOKEN_ENTER]: this.#onTokenEnter,
        [REGION_EVENTS.TOKEN_EXIT]:  this.#onTokenExit
    };
}
