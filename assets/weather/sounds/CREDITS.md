# Weather ambience audio

The weather subsystem plays looped ambience + thunder from this folder. The
code (`module/mechanics/weather-sound.mjs`, `module/mechanics/lightning-fx.mjs`)
expects these exact files. Missing files are handled gracefully — that track
just stays silent (thunder falls back to a procedural synth).

## Required files

Looping stems (`STEMS` in `weather-sound.mjs`), seeded into the "Weather"
Playlist and stacked to match the active weather:

| Path                | What it is                                  | When it plays                                    |
|---------------------|---------------------------------------------|--------------------------------------------------|
| `rain-light.ogg`    | gentle rain loop                            | Showers (precip 1)                               |
| `rain.ogg`          | steady rain loop                            | Rainfall (precip 2)                              |
| `rain-heavy.ogg`    | heavy rain / downpour loop                  | Heavy rain (precip ≥3 or storm)                  |
| `wind.ogg`          | sustained wind loop                         | Light/moderate wind (wind 1–2)                   |
| `wind-strong.ogg`   | strong wind loop                            | Strong wind (wind 3)                             |
| `wind-storm.ogg`    | gale loop                                   | Gale (wind ≥4); any storm drives wind            |
| `blizzard.ogg`      | driving wind + snow loop                    | Blizzard (snow ≥2 + storm; covers wind+snow)     |
| `hail-light.ogg`    | light hail rattle loop                      | Hail (no storm, precip <3)                        |
| `hail-heavy.ogg`    | hard hail / hailstorm rattle loop           | Hailstorm (storm or precip ≥3)                   |

Thunder one-shots (`THUNDER_FILES` in `lightning-fx.mjs`), played at random
during a Lightning Storm:

| Path                     | What it is                       |
|--------------------------|----------------------------------|
| `thunder/thunder-1.ogg`  | thunderclap one-shot             |
| `thunder/thunder-2.ogg`  | thunderclap one-shot (variation) |
| `thunder/thunder-3.ogg`  | thunderclap one-shot (variation) |
| `thunder/thunder-4.ogg`  | thunderclap one-shot (variation) |
| `thunder/thunder-5.ogg`  | thunderclap one-shot (variation) |

Notes:
- **Format:** `.ogg` (Vorbis). If you swap formats, change the extensions in
  `STEMS` / `THUNDER_FILES`.
- **Loops** (stems) must be **seamless** — these were mastered with a tail↔head
  crossfade (see `/tmp/wx/master.sh`) so they loop without a click.
- **Thunder** files are one-shots (not loops); 5 variations so claps don't
  repeat audibly. Add more by extending `THUNDER_FILES` in `lightning-fx.mjs`.

## License: CC0 / public domain ONLY

This system is distributed publicly, so every bundled sound MUST be CC0 (public
domain) — no attribution-required (CC-BY/CC-BY-SA) or "free for non-commercial"
clips. Verify the license **on each file's own page** before adding it; a
collection being "mostly CC0" is not enough.

### Vetted starting points (confirm CC0 on each file's page)

- **Freesound — CC0 filter** (license dropdown already set to *Creative
  Commons 0*; pick a seamless loop, download, convert to `.ogg`):
  - Rain: <https://freesound.org/search/?q=rain+loop&f=license:%22Creative+Commons+0%22>
  - Heavy rain: <https://freesound.org/search/?q=heavy+rain+downpour&f=license:%22Creative+Commons+0%22>
  - Hail/sleet: <https://freesound.org/search/?q=hail+sleet&f=license:%22Creative+Commons+0%22>
  - Wind: <https://freesound.org/search/?q=wind+loop&f=license:%22Creative+Commons+0%22>
  - Thunder: <https://freesound.org/search/?q=thunder+clap&f=license:%22Creative+Commons+0%22>
- **OpenGameArt — CC0 sound effects:** <https://opengameart.org/content/cc0-sound-effects>
  (filter the site by license = CC0; has weather/ambience packs)

When you add files, append a line per sound below with its source URL so the
CC0 provenance is recorded with the distribution.

## Provenance

The shipped `.ogg` files were mastered (clean, loudness-normalize, seamless
loop) from user-supplied source samples in `new-foundry-system/weathersounds/`
via `/tmp/wx/master.sh`. The source filenames are recorded below as the
starting point for provenance.

**⚠ CC0 NOT YET VERIFIED.** Per the rule above, the license must be confirmed
on each clip's own page before public distribution. Some thunder source names
embed an apparent Freesound id (the trailing number) — confirm CC0 there and
fill in the `(verify)` URLs, or replace any clip that isn't CC0.

| Output                | Source file (in `weathersounds/`)                              | Source / license          |
|-----------------------|----------------------------------------------------------------|---------------------------|
| `rain-light.ogg`      | `freesound_community-rain-light-6704.mp3`                      | Freesound #6704 (verify)  |
| `rain.ogg`            | `Rain/rain_loop.mp3`                                           | (verify)                  |
| `rain-heavy.ogg`      | `Rain/rain_heavy_loop.mp3`                                     | (verify)                  |
| `wind.ogg`            | `Wind/winds.mp3`                                               | (verify)                  |
| `wind-strong.ogg`     | `Wind/strongwinds.mp3`                                         | (verify)                  |
| `wind-storm.ogg`      | `Wind/windstorm.mp3`                                           | (verify)                  |
| `blizzard.ogg`        | `blizzard/dragon-studio-howling-wind-and-snow-515984.mp3`     | Freesound #515984 (verify)|
| `hail-light.ogg`      | `hail/lighthail.mp3`                                           | (verify)                  |
| `hail-heavy.ogg`      | `hail/hailstorm.mp3`                                           | (verify)                  |
| `thunder/thunder-1.ogg` | `thunders/freesound_community-big-thunder-clap-99753.mp3`   | Freesound #99753 (verify) |
| `thunder/thunder-2.ogg` | `thunders/freesound_community-thunder-big-30291.mp3`        | Freesound #30291 (verify) |
| `thunder/thunder-3.ogg` | `thunders/soundmarker33-thunder-clap-512544.mp3`            | Freesound #512544 (verify)|
| `thunder/thunder-4.ogg` | `thunders/soundsforyou-natural-thunder-113219.mp3`          | Freesound #113219 (verify)|
| `thunder/thunder-5.ogg` | `thunders/u_vrs223ln83-loud-thunder-439064.mp3`             | Freesound #439064 (verify)|
