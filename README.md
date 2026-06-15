# Death March — an unofficial Witcher TRPG system for Foundry VTT

Death March is a from-scratch Foundry VTT v14 system for The Witcher TRPG.

Playing Witcher on Foundry used to mean a base system plus a pile of community
modules held together with hope. This is all of it in one place: the rules, the
interface, the GM tools, and a good amount of homebrew. If you'd rather run it
closer to the book, almost all of the homebrew can be switched off.

It's a beta and it's still moving. It runs on Foundry v14 (built and tested
against 14.363), it's English-only for now, and there's no build step — drop it
in and it works.

## What's in it

**The interface is completely redone.** There's a dock across the bottom of the
screen with your medallion, your pools, your defenses, and your equipped gear.
Once a fight starts it also tracks your action economy for the turn — full round,
movement, action, extra action — and it won't let you spend what you don't have.
Actions you can't take grey out, and the tooltips tell you what each one costs,
so nobody has to keep the turn rules in their head. Character and monster sheets
are rebuilt, the inventory is a real rail with working containers and loadouts,
and skills, journal, crafting, the bestiary, and the map all open as side panels.

**The hunt actually plays out.** The bestiary hides what your players haven't
earned yet. Knowledge unlocks in tiers as they read up on a creature and live
through fights with it; the more they know, the more of its stats, weaknesses,
and drops they can see. When something's dead, they can dissect and harvest the
remains for crafting components and alchemy ingredients — as much as their
knowledge lets them find.

**Books that do something.** Monster lore, skill training, and stress relief all
come as readable in-world books. Picking one up and reading it has an effect, not
just flavor text.

**GM tools come with it — no extra module.** There's a GM-only panel behind the
eye button at the far left of the dock:

- **Party** — every PC, NPC, combatant, or token on the scene in one filterable
  list. Edit HP, STA, Toxicity, Stress, and Adrenaline right there and toggle
  status effects on anyone, and it updates live as the game changes.
- **Reference** — editable rules cheat-sheets, already filled in with the core
  combat tables (attack mods, ranges and DCs, light levels, crits, hit
  locations, cover). Add your own sections and rows; it remembers what you left
  collapsed.
- **Pinboard** — a digital screen. Pin images (click to blow one up), drop in
  journal/actor/item links, jot notes.
- **Session** — roll a skill check for the whole party at once (public, private,
  blind, or your own eyes only) and hand out IP and coin in one go.

**Alchemy, crafting, and gear that connect.** Diagrams, substances and ingredient
potency, charges on consumables, mutagens, and enhancements — runes, glyphs,
weapon and armor upgrades — that you attach to an item and that actually change
its numbers.

**Magic that the system can run.** Spells, hexes, and rituals are stored as real
fields (cast time, defense, duration, components), so casting is something the
engine drives rather than text you read off the sheet.

**The world keeps time.** A Witcher calendar with moon phases, a running clock,
and weather drawn with native shaders that tracks season, region, and time of day.

**Merchants you can actually shop at.** Merchant actors stock a shop and handle
buying and selling. Prices aren't fixed — they move with how the buyer stands
with the merchant and with bulk deals — and shops pull their stock from curated
pools like taverns and fixed-menu vendors.

**Dice in the back of the tavern.** Two gambling minigames, Dice Poker and
Farkle, both with 3D physics dice, a coin pot, and either an NPC or another
player across the table. And yes, you can slip a weighted die into dice poker if
you don't mind cheating.

**Compendium content.** Eleven packs covering equipment, general gear, alchemy,
crafting, experimental tech, witcher gear, magic and runes, character options,
critical wounds, and dice. The bestiary pack is only a list of monster names — a
placeholder. I can't ship the creatures' stat blocks; those belong to R.
Talsorian Games, and the homebrew policy doesn't allow redistributing them.

## Homebrew is the whole point

The optional systems are each a switch you can flip in the settings — stress,
food and drink, the book mechanic, the Farkle table, and an extended-combat
overhaul that's still in progress. Turn them off to play closer to
rules-as-written; turn them back on and nothing you'd entered is lost.

You can also customize the moving parts directly: weapon and armor qualities are
editable, and there's a built-in engine for editing status effects and active
effects and the values they push around.

Bestiary research is the one thing that's always on.

More is coming. The combat overhaul is the big one in flight, and new optional
systems will arrive as their own switches so a table that's mid-campaign can opt
in without anything breaking underneath them.

## Installing

You need Foundry VTT v14 (tested on 14.363). It won't load on v13 or earlier.

Drop the system into Foundry's `Data/systems/` folder and restart. The folder
must be named `witcher-ttrpg-death-march`. Where that lives:

- **Windows:** `%localappdata%/FoundryVTT/Data/systems/`
- **Linux:** `~/.local/share/FoundryVTT/Data/systems/`
- **macOS:** `~/Library/Application Support/FoundryVTT/Data/systems/`

Then make a world with it and you're off.

## FAQ

**Do I need any other modules?** No. The rules, the UI, the GM tools, and the
homebrew are all in this one system.

**Is this official?** No. It's unofficial fan content under R. Talsorian Games'
Homebrew Content Policy. RTG and CD Projekt Red haven't endorsed it.

**Is the rulebook in here?** No, and it can't be. The compendia carry item stats
and tables so the system actually works, but the monster stat blocks and the
rules text itself aren't reproduced — that's RTG's material. You'll still want
the core book and whatever supplements your table uses.

**What do my players have to install?** Nothing. The system runs on the host;
they just join. The GM tools simply don't show up for them.

**Can I turn the homebrew off?** Yes, each piece is its own setting. The data
stays intact when something's off, so switching it back on later is safe.
Flipping a toggle reloads the world.

**Will my old Witcher TRPG world carry over?** Not automatically — this is a
different system, not an upgrade. There's some legacy migration in place, but
back up first and treat it as a manual move.

**I found a bug / I want a feature.** Open an issue. Include your Foundry
version, the system version, what you did, and anything in the console (F12).

## The legal bit

Death March is unofficial content released under the Homebrew Content Policy of
R. Talsorian Games, and it isn't approved or endorsed by RTG. It references
material owned by R. Talsorian Games and its licensees. *The Witcher* and its
world are © CD Projekt Red. Art credits are in [`CREDITS.md`](CREDITS.md), and
the full compliance record is in
[`docs/compliance/homebrew-policy.md`](docs/compliance/homebrew-policy.md).

The **code** is MIT — see [`LICENSE`](LICENSE). The **compendium content and
assets** can't be relicensed; they're distributed free under RTG's Homebrew
Content Policy ([`CONTENT-LICENSE.md`](CONTENT-LICENSE.md)), and the underlying
IP stays with R. Talsorian Games and CD Projekt Red.

## For tinkerers

No build step — it's plain ESM, so edits take effect on reload. Most of the
behavior lives in mixins on the actor and item classes; sheets are ApplicationV2
and data is built on TypeDataModels.
