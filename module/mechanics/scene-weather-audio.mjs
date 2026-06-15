/**
 * Local, per-client weather-ambience shaping for the VIEWED scene's weather mode.
 *
 * The weather ambience is a single GLOBAL synced Playlist driven by the primary
 * GM (see weather-sound.mjs) — "the party's weather", the same for everyone. But
 * the per-scene `weatherMode` flag (scene-weather-mode.mjs) is a per-client,
 * per-viewed-scene concept. So we can't toggle the ambience at the document
 * level; instead each client reshapes the playlist's LIVE Sound nodes locally:
 *
 *   "indoor" — fade the bed down and run it through a low-pass biquad, so the
 *              storm is heard muffled "through the walls".
 *   "off"    — silence the bed locally (gain 0); the GM's playlist keeps running,
 *              this client just doesn't hear it.
 *   "outdoor"— release our hold and restore the document volume / dry signal.
 *
 * Nothing here writes a document — it only adjusts WebAudio gain + effects on the
 * client's own Sound instances, exactly the mechanism core uses for wall-muffled
 * ambient sounds (canvas/placeables/sound.mjs). All best-effort + guarded: if the
 * audio API shape differs, weather simply isn't muffled (it never throws).
 */

import { sceneWeatherMode, WEATHER_MODES } from "./scene-weather-mode.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const PLAYLIST_FLAG = "weather";
const TRACK_FLAG = "track";

const INDOOR_VOL = 0.62;       // ambience eased indoors — lowpass carries the muffle
const INDOOR_LOWPASS = 7;      // biquad intensity — "through the walls" muffle

// Hail is sharp, high-frequency clatter; the standard muffle lowpass annihilates
// it far more than the low-mid rumble of rain/wind, so indoors it reads as silent.
// Muffle the hail stems gently and lift their gain so they survive the walls —
// WITHOUT touching the rest of the (loudness-matched) bed.
const HAIL_KEYS = new Set(["hail-light", "hail-heavy"]);
const HAIL_LOWPASS = 4;        // softer than the bed: keeps the clatter present
const HAIL_BOOST = 1.25;       // lift to offset what the lowpass still removes

const FADE = 2000;             // ms — match the playlist's own cross-fade (weather-sound.mjs)
const BOOT_FADE = 300;         // quick ease-in at cold start, so the bed isn't silent for a
                               // full 2s after the audio-unlock click (then we revert to FADE)

// True only during the cold-start window (just after audio unlocks on load): the
// whole bed eases in fast instead of over the 2s cross-fade meant for genuine
// weather changes. Flipped false a few seconds after unlock (registerSceneWeatherAudio).
let _fastOnset = true;

/* Per-PlaylistSound memory of what we last did, so we only rewire the (clicky)
 * effects pipeline when the mode or the underlying Sound instance actually
 * changes. Keyed by PlaylistSound id → { mode, sound, onPlay }. `onPlay` is the
 * "play"-event listener we attach so a (re)started track re-pins the muffle (see
 * applyToSound). */
const _state = new Map();

function findWeatherPlaylist() {
    return game.playlists?.find(p => p.getFlag(SYSTEM_ID, PLAYLIST_FLAG)) ?? null;
}

/* A fresh low-pass node on the sound's own AudioContext, via the same registry
 * core uses (CONFIG.soundEffects). Null if unavailable. */
function makeLowpass(sound, intensity) {
    const cfg = CONFIG?.soundEffects?.lowpass;
    if (!cfg?.effectClass || !sound?.context) return null;
    try { return new cfg.effectClass(sound.context, { type: "lowpass", intensity }); }
    catch (_) { return null; }
}

const indoorVolume = (base, key) => base * INDOOR_VOL * (HAIL_KEYS.has(key) ? HAIL_BOOST : 1);

/* Ramp the gain toward `v`. `fade` glides over the playlist cross-fade window so
 * weather transitions stay smooth (no pop/cut); without it the gain snaps — used
 * only for instant corrections (a GM volume-slider nudge) where a ramp would lag. */
function setVolume(sound, v, fade) {
    if (fade) {
        try { sound.fade(v, { duration: _fastOnset ? BOOT_FADE : FADE }); return; }
        catch (_) { /* no fade API on this build — hard set below */ }
    }
    try { sound.volume = v; } catch (_) {}
}

/* Shape a single live Sound for a non-outdoor mode: low-pass + duck for indoor,
 * gain 0 for off, dry full volume for outdoor. Pure gain/effect work, no docs. */
function shapeSound(sound, base, mode, key, fade) {
    if (mode === WEATHER_MODES.OUTDOOR) { sound.applyEffects([]); setVolume(sound, base, fade); return; }
    if (mode === WEATHER_MODES.OFF)     { sound.applyEffects([]); setVolume(sound, 0, fade); return; }
    const hail = HAIL_KEYS.has(key);                // INDOOR — hail gets the gentle treatment
    const lp = makeLowpass(sound, hail ? HAIL_LOWPASS : INDOOR_LOWPASS);
    sound.applyEffects(lp ? [lp] : []);
    setVolume(sound, indoorVolume(base, key), fade);   // faded down + muffled
}

function applyToSound(ps, mode) {
    const sound = ps?.sound;
    if (!sound) { _state.delete(ps.id); return; }     // not created yet; catch it next pass

    const eff = mode;
    const key = ps.getFlag(SYSTEM_ID, TRACK_FLAG);
    const prev = _state.get(ps.id);
    const soundChanged = prev?.sound !== sound;        // Sound recreated on (re)play → re-wire
    const base = Number(ps.volume) || 0;

    try {
        if (eff === WEATHER_MODES.OUTDOOR) {
            if (!prev || prev.mode === WEATHER_MODES.OUTDOOR) return;   // we never held it
            if (prev.onPlay && prev.sound) prev.sound.removeEventListener("play", prev.onPlay);
            shapeSound(sound, base, eff, key, true);   // un-muffle, fading back to dry/full
            _state.set(ps.id, { mode: eff, sound, onPlay: null, base });
            return;
        }

        // INDOOR / OFF. A mode switch or a fresh Sound re-wires the effect chain and
        // FADES to the muffled target — matching the playlist cross-fade, so stems
        // ease in/out instead of popping. When nothing structural changed we leave
        // the running fade ALONE (re-pinning the gain every tick is what made
        // transitions choppy); only a GM volume-slider nudge gets a silent snap.
        if (prev?.mode !== eff || soundChanged) {
            shapeSound(sound, base, eff, key, true);
        } else if (prev?.base !== base) {
            setVolume(sound, eff === WEATHER_MODES.OFF ? 0 : indoorVolume(base, key), false);
        }

        // PlaylistSound#_onStart fades a (re)started track from 0 toward the full doc
        // volume (playlist-sound.mjs), which would undo the muffle for a stem that
        // starts while indoors. Re-pin from a "play" listener: it registers after
        // PlaylistSound's, so it fires last and re-fades to the muffled target.
        let onPlay = soundChanged ? null : prev?.onPlay;
        if (!onPlay) {
            onPlay = () => {
                try { shapeSound(sound, Number(ps.volume) || 0, sceneWeatherMode(canvas?.scene), key, true); }
                catch (_) { /* leave untouched */ }
            };
            sound.addEventListener("play", onPlay);
        }
        _state.set(ps.id, { mode: eff, sound, onPlay, base });
    } catch (_) { /* audio shape mismatch — leave the bed untouched */ }
}

let _retryTimer = null;
let _retries = 0;
const MAX_RETRIES = 25;        // ~1.5s of 60ms polls — covers a slow first decode

/**
 * Reshape the weather ambience for the locally viewed scene's mode. Idempotent
 * and cheap; safe to call on every world-time / scene / playlist change.
 *
 * Self-polls while a just-(re)started stem's Sound is still decoding — its doc is
 * flagged `playing` but `ps.sound` is null, so applyToSound can't muffle it yet.
 * Without this the stem plays un-muffled until some later sync fires; on RELOAD
 * the resumed synced playlist fires no update hook at all, so the startup pass
 * would otherwise never catch it (the "plays as if outside on reload" bug).
 */
export function syncSceneWeatherAudio() {
    if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
    const pl = findWeatherPlaylist();
    if (!pl) { _retries = 0; return; }
    const mode = sceneWeatherMode(canvas?.scene);
    let pending = false;
    for (const ps of pl.sounds) {
        if (mode !== WEATHER_MODES.OUTDOOR && ps.playing && !ps.sound) pending = true;
        applyToSound(ps, mode);
    }
    if (pending && _retries < MAX_RETRIES) {
        _retries++;
        _retryTimer = setTimeout(() => { _retryTimer = null; syncSceneWeatherAudio(); }, 60);
    } else {
        _retries = 0;
    }
}

/* PlaylistSound (re)creates its client Sound when a track starts, dropping our
 * effects/gain; the doc-update hook fires before that Sound exists, so defer the
 * re-assert (syncSceneWeatherAudio then self-polls until it appears). Debounced —
 * a playlist update can touch many sounds at once. */
let _timer = null;
function scheduleReapply() {
    if (_timer) return;
    _timer = setTimeout(() => { _timer = null; syncSceneWeatherAudio(); }, 60);
}

/** Register the local-audio hooks. Visual + world-time triggers come through
 * scene-fx's tick(); these cover GM-driven playlist track changes. */
export function registerSceneWeatherAudio() {
    Hooks.on("updatePlaylist", (pl) => { if (pl?.getFlag(SYSTEM_ID, PLAYLIST_FLAG)) scheduleReapply(); });
    Hooks.on("updatePlaylistSound", (ps) => { if (ps?.parent?.getFlag(SYSTEM_ID, PLAYLIST_FLAG)) scheduleReapply(); });
    // Drop our per-sound state when a stem is deleted, so the Map (and the Sound
    // + listener it holds) doesn't accumulate stale entries across edits.
    Hooks.on("deletePlaylistSound", (ps) => { _state.delete(ps?.id); });

    // Browsers suspend audio until the first user gesture: on (re)load the
    // environment AudioContext doesn't exist and the resumed weather playlist's
    // Sounds aren't created until then — and that resume fires NO document hook, so
    // the startup tick has nothing to muffle and the bed plays un-muffled "outside".
    // game.audio.unlock resolves on that first gesture (after pending playback is
    // flushed), so re-sync then; syncSceneWeatherAudio self-polls for the freshly
    // created Sounds and applies the muffle. The cold-start bed eases in fast
    // (BOOT_FADE); revert to the smooth 2s cross-fade once it's in.
    Hooks.once("ready", () => {
        const unlock = game.audio?.unlock;
        if (unlock?.then) {
            unlock.then(() => {
                syncSceneWeatherAudio();
                setTimeout(() => { _fastOnset = false; }, 2500);
            }).catch(() => { _fastOnset = false; });
        } else {
            _fastOnset = false;
        }
    });
}
