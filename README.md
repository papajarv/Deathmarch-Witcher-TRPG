# Death March — an unofficial Witcher TRPG system for Foundry VTT

Death March is a from-scratch Foundry VTT v14 system for The Witcher TRPG.

Playing Witcher on Foundry used to mean a clunky and barren base system plus a pile of community modules held together with hope. This is all of it in one place: the rules, the interface, the GM tools, and a good amount of homebrew.

If you'd rather run it closer to the book, almost all of the homebrew can be switched off.

It runs on Foundry v14, built and tested against 14.363. It's English-only for now, and there's no build step — drop it in and it works.

<img width="1280" height="800" alt="Death March Foundry VTT system overview" src="https://github.com/user-attachments/assets/adb832b2-0683-4034-9425-a87b8ea5a067" />

---

## What's in it

### Complete UI Rework

The Ui is now composed of four docks: left and right dock, with the respective Foundry tools. Additionally, there's bottom and top bar.

---

## Bottom Bar

Bottom bar tracks:

- Vigor
- HP
- Toxicity
- Your profession, displaying the icon associated with your profession item
- Race
- Some more stats and utility buttons depending if you are in combat or not

<img width="2552" height="343" alt="Death March bottom bar" src="https://github.com/user-attachments/assets/5b1dc3c7-df29-4600-8708-9077010527d7" />

The hotbar below it can recieve macros to be ran, weapons to be drawn/sheated, containers and consumables.

Once the actor is in combat or a weapon is drawn, the bottom bar changes into combat mode.

---

## Top Bar

Top bar has:

- The scene name
- Current weather
- Time of day
- Moon phase
- Currency
- Encumbrance
- All the new interface utilities

These utilities include:

---

### New Inventory / Equipment UI

Not only display, reworked the logic. You can only access gear in containers in combat, from weapons to consumables. You can quickdraw, stow things, etc.

<img width="1280" height="800" alt="Death March inventory and equipment UI" src="https://github.com/user-attachments/assets/12fe9938-5229-433f-87fc-140cebdcd5a0" />

---

### Character Sheet

Visual rework with IP spending, wounds (critical wounds which track with different states, penalties and heal over game time) and biography (character background stuff).

<img width="1280" height="800" alt="Death March character sheet" src="https://github.com/user-attachments/assets/d1651706-5dc5-4587-b1b3-6972df0a5fe2" />

---

### A Journal

For personal entries, relationships with NPCs, that sync with a auto-calculating timeline based on your age.

<img width="1280" height="655" alt="Death March journal" src="https://github.com/user-attachments/assets/085ba571-7542-48d7-957b-f4b60fe8dd63" />

---

### Bestiary

Includes research levels for monsters, encounter tracking, a learning system aswell as the option to dissect monsters to learn more about them.

<img width="1280" height="655" alt="Death March bestiary" src="https://github.com/user-attachments/assets/4882e5a7-37e2-4725-9622-1935f47e4479" />

---

### Crafting Sreen

A visual aid for crafting items.

<img width="1280" height="655" alt="Death March crafting screen" src="https://github.com/user-attachments/assets/6e70f766-fe51-4269-8c3e-dc0178acb667" />

---

### Map

If you have map items in your inventory, you may visualize them.

---

## Mechanics

- Combat is tracked through an action budget off the bottom bar.
- Weapon sheathing/drawing along with Fast Draw.
- Manually harvesting mutagens and loot, aswell as dissection bestiary mechanic, off monster remain items (When monsters are marked defeated in combat, they create a remains item in the world item bar)
- Complete list of item classes with two layers, visual and configuration.
- Custom time and weather engine, can be turned off and used with module ones.
- Effects go off system time.
- Crafting requires appropriate tools. They go off name, so just have an item with the correct name.
- Automatic potion threshhold.
- Race items have a check that allows its actor to have a variable portrait depending on toxicity or other effects, accessed via top right corner of the top bar's character button.
- Enhancements were designed to attach to weapons with real changes to their stats.
- Monsters can be toggled as "mounts", have a control modifier set and have their portrait dragged unto the mount slot of the inventory UI to have access to their bags and gain the modifier as a riding bonus.
- Dice Poker and Farkle :))))
- Note Items that can be dragged on scene to look like contract postings, then swiped to player inventories
- Merchant Actor with complex shop stock system that can be dragged on scene to have a shopfront for players

And many more features! Feel free to explore :) They're genuinely too many to document.

<p align="center">
  <img width="49%" alt="Death March dice poker" src="https://github.com/user-attachments/assets/405b58ba-5e3f-459e-9aad-fa4f6ed59add" />
  <img width="49%" alt="Death March farkle" src="https://github.com/user-attachments/assets/1d7bd9b4-8359-4bad-94e1-afd209a57cb0" />
</p>

<p align="center">
  <img width="49%" alt="Death March game screen" src="https://github.com/user-attachments/assets/92681ac1-d26b-41a5-aa85-a503fb6d7766" />
  <img width="49%" alt="Death March game screen" src="https://github.com/user-attachments/assets/aeb2e39f-3b53-48f7-af78-5dd15134735a" />
</p>

<p align="center">
  <img width="49%" alt="Death March game screen" src="https://github.com/user-attachments/assets/ce1cb307-8198-4c7d-aa15-664ca8dada24" />
</p>


---

## Homebrew is the whole point

Those who have played the witcher system know its, despite having a lot of love poured into it, a bit of a mess full of gameplay loop dead-ends and unbalanced inconsistencies.

But a dedicated community is always homebrewing and cooking up stuff. I am doing my best to leave everything open to configuration, change, and general engine support for homebrewing things, such as being able to add your own weapon and armor qualities, edit and add status effects, switch in between rules and a detailed active effect configuration engine in order to produce the result you want it to.

I am adding my own campaign's rules into this system, which can be turned on/off.

---

## Installing

You need Foundry VTT v14, tested on 14.363. It won't load on v13 or earlier.

Drop the system into Foundry's `Data/systems/` folder and restart. The folder must be named:

```txt
witcher-ttrpg-death-march
```

Where that lives:

- **Windows:** `%localappdata%/FoundryVTT/Data/systems/`
- **Linux:** `~/.local/share/FoundryVTT/Data/systems/`
- **macOS:** `~/Library/Application Support/FoundryVTT/Data/systems/`

Alternatively, install it directly via Foundry by using the manifest url:

```txt
https://github.com/papajarv/Deathmarch-Witcher-TRPG/releases/download/1.0/system.json
```

Then make a world with it and you're off.

---

## FAQ

### Do I need any other modules?

No. This system is standalone plug and play. 0 dependencies.

### Is this official?

No. It's unofficial fan content under R. Talsorian Games' Homebrew Content Policy. RTG and CD Projekt Red haven't endorsed it.

### Is the rulebook in here?

No, I am not allowed to. I placed items without any copyrighted icons on compendiums with a barebones description, which I am allowed to, aswell as empty monster stat blocks.

I recommend using icons without backgrounds for items as they look a lot better in the inventory.

### What do my players have to install?

Nothing. Plug and play!

### Can I turn the homebrew off?

Yes, each piece is its own setting. The data stays intact when something's off, so switching it back on later is safe.

Flipping a toggle reloads the world.

### Will my old Witcher TRPG world carry over?

Not automatically, this is a different system. Character sheets, items, journal entries, all of that will be lost.

### I found a bug / I want a feature.

Open an issue. Include your Foundry version, the system version, what you did, and anything in the console, F12.

I am more than willing to answer questions and troubleshoot with you :)

---

## The legal bit

Death March is unofficial content released under the Homebrew Content Policy of R. Talsorian Games, and it isn't approved or endorsed by RTG.

It references material owned by R. Talsorian Games and its licensees.

*The Witcher* and its world are © CD Projekt Red.
