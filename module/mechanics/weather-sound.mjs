/**
 * Weather ambience via Foundry's jukebox. The mastered, seamless CC0 loops in
 * assets/weather/sounds/ are seeded into a "Weather" Playlist (SIMULTANEOUS mode,
 * environment channel) so they show up in the Playlists sidebar and players can
 * adjust loudness with the built-in volume slider — no custom audio plumbing.
 *
 * The system stacks STEMS rather than baking every weather combination: e.g.
 * heavy rain + a gale = the `rain-heavy` and `gale` loops playing together.
 * desiredTracks() maps the active weather tags to the set of stems that should be
 * playing; reconcile toggles each PlaylistSound's `playing` with a cross-fade.
 *
 * Playback is driven by the primary GM (Playlist edits are document writes that
 * Foundry syncs to every client), so players don't run any of this — they just
 * hear the synced playlist and control its volume locally. Gated behind the
 * master `weatherEnabled` switch AND the world `weatherSound` toggle.
 */

import { getActiveWeather } from "./manual-weather.mjs";

const SYSTEM_ID = "witcher-ttrpg-death-march";
const SOUND_DIR = `systems/${SYSTEM_ID}/assets/weather/sounds`;
const FADE = 2000;         // ms cross-fade on play/stop, matched to the visuals
const PLAYLIST_FLAG = "weather";
const TRACK_FLAG = "track";

/* Looping stems. `vol` is the jukebox base gain the players then scale with the
 * environment-channel slider. Rain/hail/blizzard sit near a flat 0.30 bed; the
 * four WIND tiers (breeze < wind < wind-strong < gale) are the author's own
 * recordings, each its OWN file, converted to seamless 44.1 kHz stereo loops
 * (tail-crossfade) and EBU-R128 loudness-matched so the `vol` ladder below is
 * what actually escalates them. `label` is the PlaylistSound name in the jukebox. */
const STEMS = Object.freeze([
    { key: "rain-light",  file: "rain-light.ogg",  vol: 0.24, label: "WITCHER.Weather.Track.RainLight" },
    { key: "rain",        file: "rain.ogg",         vol: 0.30, label: "WITCHER.Weather.Track.Rain" },
    { key: "rain-heavy",  file: "rain-heavy.ogg",   vol: 0.56, label: "WITCHER.Weather.Track.RainHeavy" },
    { key: "breeze",      file: "breeze.ogg",       vol: 0.26, label: "WITCHER.Weather.Track.Breeze" },
    { key: "wind",        file: "wind.ogg",         vol: 0.34, label: "WITCHER.Weather.Track.Wind" },
    { key: "wind-strong", file: "wind-strong.ogg",  vol: 0.56, label: "WITCHER.Weather.Track.WindStrong" },
    { key: "gale",        file: "gale.ogg",          vol: 0.82, label: "WITCHER.Weather.Track.Gale" },
    { key: "blizzard",    file: "blizzard.ogg",     vol: 0.30, label: "WITCHER.Weather.Track.Blizzard" },
    { key: "hail-light",  file: "hail-light.ogg",   vol: 0.30, label: "WITCHER.Weather.Track.HailLight" },
    { key: "hail-heavy",  file: "hail-heavy.ogg",   vol: 0.50, label: "WITCHER.Weather.Track.HailHeavy" }
]);

function settingOn(key) {
    try { return !!game.settings.get(SYSTEM_ID, key); } catch (_) { return false; }
}

/* Only one GM should issue the Playlist writes (they sync to everyone). */
function isPrimaryGM() {
    const u = game.user;
    if (!u?.isGM) return false;
    const ag = game.users?.activeGM;
    return ag ? ag === u : true;
}

/* The set of stem keys that should be playing for these weather tags. Snow only
 * "sounds" as a blizzard (driving wind + snow); plain snowfall is silent. */
function desiredTracks(tags) {
    const t = tags ?? {};
    const precip = Number(t.precip) || 0;
    const snow   = Number(t.snow)   || 0;
    const storm  = !!t.storm;
    const hail   = !!t.hail;
    let wind     = Number(t.wind) || 0;
    if (storm) wind = Math.max(wind, 3);          // any storm drives wind

    const set = new Set();
    if (snow >= 2 && storm) { set.add("blizzard"); return set; }  // bed covers wind+snow

    if (hail)             set.add(precip >= 3 || storm ? "hail-heavy" : "hail-light");
    else if (precip >= 3) set.add("rain-heavy");
    else if (precip === 2) set.add("rain");
    else if (precip === 1) set.add("rain-light");

    if (wind >= 4)        set.add("gale");
    else if (wind === 3)  set.add("wind-strong");
    else if (wind === 2)  set.add("wind");
    else if (wind >= 1)   set.add("breeze");
    return set;
}

function findPlaylist() {
    return game.playlists?.find(p => p.getFlag(SYSTEM_ID, PLAYLIST_FLAG)) ?? null;
}

let _seeding = false;

/* True if the playlist is missing a PlaylistSound for any current stem. Keyed on
 * the stem flag, NOT the sound count — renaming a stem (e.g. wind-storm → gale)
 * keeps the count identical but leaves the new key unseeded, so a count guard
 * would silently never create it. */
function stemsMissing(pl) {
    const have = new Set(pl.sounds.map(s => s.getFlag(SYSTEM_ID, TRACK_FLAG)));
    return STEMS.some(st => !have.has(st.key));
}

/* Ensure the Weather playlist + one PlaylistSound per stem exist (GM write).
 * Also prunes orphan sounds left behind by a renamed/removed stem. */
async function ensurePlaylist() {
    let pl = findPlaylist();
    if (!pl) {
        pl = await Playlist.create({
            name: game.i18n.localize("WITCHER.Weather.PlaylistName"),
            mode: CONST.PLAYLIST_MODES.SIMULTANEOUS,
            flags: { [SYSTEM_ID]: { [PLAYLIST_FLAG]: true } }
        });
    }
    const valid = new Set(STEMS.map(st => st.key));
    const orphans = pl.sounds
        .filter(s => { const k = s.getFlag(SYSTEM_ID, TRACK_FLAG); return k && !valid.has(k); })
        .map(s => s.id);
    if (orphans.length) await pl.deleteEmbeddedDocuments("PlaylistSound", orphans);

    const have = new Set(pl.sounds.map(s => s.getFlag(SYSTEM_ID, TRACK_FLAG)));
    const create = STEMS.filter(st => !have.has(st.key)).map(st => ({
        name: game.i18n.localize(st.label),
        path: `${SOUND_DIR}/${st.file}`,
        channel: "environment",
        repeat: true,
        fade: FADE,
        volume: st.vol,
        playing: false,
        flags: { [SYSTEM_ID]: { [TRACK_FLAG]: st.key } }
    }));
    if (create.length) await pl.createEmbeddedDocuments("PlaylistSound", create);
    return pl;
}

/**
 * Reconcile the Weather playlist with the current weather + toggles. GM-only;
 * idempotent and diff-guarded so it's safe to call on every world-time / setting
 * / canvas change without spamming document updates.
 */
export async function syncWeatherSound() {
    if (!isPrimaryGM()) return;

    const enabled = settingOn("weatherEnabled") && settingOn("weatherSound");
    if (!enabled) {
        const pl = findPlaylist();
        if (pl?.playing) { try { await pl.stopAll(); } catch (_) {} }
        return;
    }

    if (_seeding) return;
    let pl = findPlaylist();
    if (!pl || stemsMissing(pl)) {
        _seeding = true;
        try { pl = await ensurePlaylist(); }
        catch (err) { console.warn("[wdm-weather-sound] playlist seed failed", err); return; }
        finally { _seeding = false; }
    }

    const tags = getActiveWeather().tags ?? {};
    const want = desiredTracks(tags);
    const volByKey = new Map(STEMS.map(st => [st.key, st.vol]));
    const updates = [];
    let any = false;
    for (const s of pl.sounds) {
        const track = s.getFlag(SYSTEM_ID, TRACK_FLAG);
        if (!track) continue;
        const on = want.has(track);
        if (on) any = true;
        const upd = { _id: s.id };
        let changed = false;
        if (!!s.playing !== on) { upd.playing = on; upd.pausedTime = null; changed = true; }
        const vol = volByKey.get(track);
        // Keep the mastered mix balance authoritative (overall loudness is the
        // player's environment-slider job, not this per-sound base volume).
        if (vol != null && Math.abs((s.volume ?? 0) - vol) > 0.001) { upd.volume = vol; changed = true; }
        if (changed) updates.push(upd);
    }
    if (updates.length) {
        try { await pl.update({ sounds: updates, playing: any }); }
        catch (err) { console.warn("[wdm-weather-sound] playlist update failed", err); }
    }
}

/** Stop all weather ambience (GM write). Safe to call when idle. */
export async function stopWeatherSound() {
    if (!isPrimaryGM()) return;
    const pl = findPlaylist();
    if (pl?.playing) { try { await pl.stopAll(); } catch (_) {} }
}
