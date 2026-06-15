/**
 * Dock — the always-visible bottom band.
 *
 * Structure copied from the Vladimir mockup (reference.html):
 *
 *   [ identity card ]   [ pool 2x2 grid ]   [ sign tray ]
 *   ─────────────────── prompt keys ───────────────────
 *
 * Pool entries follow the user's simplified XP-bar styling:
 *   [cur]   ╱╲╱╲╱╲╱╲   [max]
 * Both numbers and the fill share the pool's accent color.  No icon,
 * no name label.
 *
 * On encounter (an active Combat exists), body gets `.in-encounter`,
 * which CSS uses to brighten the dock's top rule and reveal embers.
 */

import { getAssignedActor, getDockData, isActorInActiveCombat } from "../lib/actor.js";
import { injectHotbar } from "./hotbar.js";
import { sheathWeapon, dropWeaponToWorld, occupancyOf } from "./inventory.js";
import { injectStatusesRow, describeDuration } from "./dock-statuses.js";
import { openFumbleDialog, installFumbleChatHandler } from "./fumble-dialog.js";
import { openCriticalDialog, installCritChatHandler } from "./critical-roll.js";
import { isHomebrewEnabled } from "../../api/homebrew.mjs";
import { reloadWithPrompt } from "../lib/reload.js";
import { getActiveWeaponQualities, WEAPON_QUALITIES, AIM_BONUS_CAP, AIM_BONUS_PER_TURN } from "../../setup/config.mjs";
import { selfClearOptions, actionEndCheckOptions, performActionEndCheck } from "../../mechanics/statusEngine.mjs";
import { isAdrenalineEnabled, adrenalineStaPerDie } from "../../api/adrenaline.mjs";
import { getActiveWeatherModifiers } from "../../mechanics/weather-modifiers.mjs";
import { suppressWeatherVisuals } from "../../mechanics/scene-weather-mode.mjs";

const AIM_MAX_RANK = Math.max(1, Math.ceil(AIM_BONUS_CAP / AIM_BONUS_PER_TURN));

/* Install the chat-button handler for Apply-Critical-Wound on module load. */
installCritChatHandler();
/* Install the chat-button handler for the elemental-fumble picker. */
installFumbleChatHandler();

const DOCK_HTML = `
<footer id="wou-dock">

  <!-- embers (hidden unless body has .in-encounter) — denser cluster
       than peacetime so combat reads as visually charged. -->
  <span class="ember"    style="left:4%;  animation-duration: 8s;  animation-delay: 0s;"></span>
  <span class="ember lg" style="left:10%; animation-duration: 11s; animation-delay: 1.4s;"></span>
  <span class="ember sm" style="left:16%; animation-duration: 7s;  animation-delay: 3s;"></span>
  <span class="ember"    style="left:22%; animation-duration: 9s;  animation-delay: 0.7s;"></span>
  <span class="ember lg" style="left:28%; animation-duration: 12s; animation-delay: 4.5s;"></span>
  <span class="ember sm" style="left:34%; animation-duration: 8s;  animation-delay: 2s;"></span>
  <span class="ember"    style="left:40%; animation-duration: 10s; animation-delay: 5.8s;"></span>
  <span class="ember lg" style="left:46%; animation-duration: 11s; animation-delay: 1s;"></span>
  <span class="ember sm" style="left:52%; animation-duration: 9.5s;animation-delay: 3.6s;"></span>
  <span class="ember"    style="left:58%; animation-duration: 12s; animation-delay: 6.5s;"></span>
  <span class="ember sm" style="left:64%; animation-duration: 8.5s;animation-delay: 2.4s;"></span>
  <span class="ember lg" style="left:70%; animation-duration: 11s; animation-delay: 0.3s;"></span>
  <span class="ember"    style="left:76%; animation-duration: 9s;  animation-delay: 4s;"></span>
  <span class="ember sm" style="left:82%; animation-duration: 10s; animation-delay: 1.8s;"></span>
  <span class="ember lg" style="left:88%; animation-duration: 12s; animation-delay: 5s;"></span>
  <span class="ember"    style="left:94%; animation-duration: 9.5s;animation-delay: 2.7s;"></span>

  <div class="bs-grid">

    <!-- IDENTITY — medallion with STA + TOX as half-moon arcs orbiting its
         right side (STA inside, TOX outside).  Vitality stays as a sawtooth
         bar in the text column. -->
    <section class="identity">
      <div class="portrait">
        <!-- VIGOR — Witcher-3-style segmented ARC hugging the lower-left of the
             medallion. N segments = total Vigor; the upper ones stay lit (yellow→
             green), round Chaos eats them from the bottom (red). Hidden below 1
             Vigor. Segment <path>s are built per-render in renderVigorBar. -->
        <svg class="vigor-arc" data-bind="vigor-bar" viewBox="0 0 110 110"
             xmlns="http://www.w3.org/2000/svg" aria-hidden="true"></svg>
        <img class="medallion" data-bind="medallion" src="" alt="" />
        <svg class="arcs" viewBox="0 0 90 90" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <!-- Decorative FULL ring around the medallion (where the old
               half-moon used to sit).  Static, amber palette. -->
          <circle class="arc-decor" cx="45" cy="45" r="40"
                  fill="none" stroke-width="2"/>

          <!-- STRESS arc — left half-moon, mirror of STA below.
               Same radius (38) and thickness (3) as the right arc. -->
          <path class="arc-track"
                d="M 45 83 A 38 38 0 0 1 45 7"
                fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="3"/>
          <path class="arc-fill" data-kind="stress" data-bind="stress-arc"
                d="M 45 83 A 38 38 0 0 1 45 7"
                fill="none" stroke-width="3" stroke-linecap="butt"
                pathLength="100" stroke-dasharray="0 100"/>

          <!-- STA arc — right half-moon (radius 38, 3px). -->
          <path class="arc-track"
                d="M 45 83 A 38 38 0 0 0 45 7"
                fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="3"/>
          <path class="arc-fill" data-kind="sta" data-bind="sta-arc"
                d="M 45 83 A 38 38 0 0 0 45 7"
                fill="none" stroke-width="3" stroke-linecap="butt"
                pathLength="100" stroke-dasharray="0 100"/>
        </svg>
      </div>
      <div class="ident-text">
        <!-- Name, rule, vitality, then profession + race stacked beneath the
             healthbar — identical order in peace and combat. The VITALITY
             pool carries inline cur/max readouts that only render in combat
             (per the .in-encounter scope in CSS). -->
        <div class="name-row">
          <div class="name"       data-bind="name">— no character assigned —</div>
        </div>
        <div class="rule"></div>
        <div class="pool" data-kind="hp">
          <svg class="teeth" viewBox="0 0 200 12" preserveAspectRatio="none"
               data-bind="hp-bar"></svg>
          <!-- In combat: HP / STA / TOX current values trail the bar in
               their respective accent colors. Peace mode hides them so
               the bar reads the same as before. -->
          <span class="cur cur-hp"  data-bind="c-hp-cur">0</span>
          <span class="cur cur-sta" data-bind="c-sta-cur">0</span>
          <span class="cur cur-tox" data-bind="c-tox-cur">0</span>
        </div>
        <!-- Profession omitted here — the medallion icon already conveys it;
             only the race shows beside the medallion. -->
        <div class="race" data-bind="race"></div>
      </div>
      <!-- Combat-only addendum: pinned spells row. Hidden outside combat.
           (Vigor now reads off the segmented bar by the medallion, above.) -->
      <div class="identity-combat">
        <div class="spells-row" data-bind="spells-row"></div>
      </div>
    </section>

    <!-- CENTER COLUMN — peace state shows nothing; combat state shows
         the secondary counters row (stress / adrenaline / shield), the
         defense armor figure, and the equipped weapons list. -->
    <section class="dock-state peace-state" aria-hidden="true"></section>
    <section class="dock-state combat-state">
      <!-- Stats stack on the LEFT (counters only — bars now live with
           the medallion); equipped weapons list on the RIGHT. -->
      <div class="stats-stack">
        <!-- Action-economy budget: Full Round banner spans the panel
             above the three constituent slots (Movement, Action, Extra
             Action). A teal divider <div> sits between Full Round and
             the sub-buttons to visually group them — uses a real
             element instead of a ::after pseudo because .action-btn
             has overflow:hidden which kept clipping it. No behavior
             wired yet. -->
        <div class="action-budget">
          <button type="button" class="action-btn full-round" data-action="full-round" title="Full Round (consumes Movement + Action)">
            <i class="fa-solid fa-arrows-rotate"></i>
            <span class="nm">Full Round</span>
          </button>
          <div class="action-divider" aria-hidden="true"></div>
          <div class="action-row">
            <button type="button" class="action-btn" data-action="movement" title="Movement">
              <i class="fa-solid fa-shoe-prints"></i>
              <span class="nm">Movement</span>
            </button>
            <button type="button" class="action-btn" data-action="action" title="Action">
              <i class="fa-solid fa-bullseye"></i>
              <span class="nm">Action</span>
            </button>
            <button type="button" class="action-btn" data-action="extra-action" title="Extra Action (3 STA, −3 to hit)">
              <i class="fa-solid fa-bolt"></i>
              <span class="nm">Extra Action</span>
            </button>
          </div>
        </div>
        <div class="counters-row">
          <div class="counter" data-kind="stress" title="Stress">
            <i class="fa-solid fa-brain"></i>
            <span class="val" data-bind="c-stress-cur">0</span>
            <span class="sep">/</span>
            <span class="mx"  data-bind="c-stress-max">0</span>
          </div>
          <div class="counter" data-kind="adrenaline" title="Adrenaline — click to spend on temp HP">
            <i class="fa-solid fa-bolt"></i>
            <span class="val" data-bind="c-adrenaline-cur">0</span>
            <span class="sep">/</span>
            <span class="mx"  data-bind="c-adrenaline-max">3</span>
          </div>
          <div class="counter" data-kind="shield" title="Quen Shield">
            <i class="fa-solid fa-shield-halved"></i>
            <span class="val" data-bind="c-shield-cur">0</span>
            <span class="sep">/</span>
            <span class="mx"  data-bind="c-shield-max">0</span>
          </div>
        </div>
      </div>
      <!-- Defense column: guard-stance button on top (Balanced), then the
           armor body figure on the left + Dodge / Rel / Brawl buttons
           stacked vertically on its right.  Height matches the stat bars
           (further left) and weapons list (further right). -->
      <div class="defense-col">
        <!-- Guard-stance picker. Currently a single Balanced state with
             the option to cycle through other stances later. No behavior
             wired yet. -->
        <button type="button" class="guard-btn" data-action="guard-stance" data-stance="balanced" title="Sword guard: Balanced">
          <i class="fa-solid fa-sword guard-sword"></i>
          <span class="nm">Balanced</span>
        </button>
        <!-- Body figure: each limb is a clickable SVG zone.
             Click → decrement SP.  Hover → popover with SP/max + resistances.
             Note: in the SVG, the character's LEFT side is on the viewer's
             RIGHT (mirror image), so data-loc="leftArm" sits on the right
             side of the figure, etc. -->
        <div class="defense-row">
          <div class="sp-figure-wrap">
            <svg class="sp-figure" viewBox="0 0 100 220" xmlns="http://www.w3.org/2000/svg" aria-label="Armor by body location">
              <path class="sp-zone" data-loc="head"
                    d="M 38 4 Q 32 4 32 18 Q 32 32 36 36 L 36 42 L 64 42 L 64 36 Q 68 32 68 18 Q 68 4 62 4 Z"/>
              <path class="sp-zone" data-loc="torso"
                    d="M 30 44 L 70 44 L 66 116 L 34 116 Z"/>
              <path class="sp-zone" data-loc="rightArm"
                    d="M 8 46 L 26 46 L 22 116 L 12 116 Z"/>
              <path class="sp-zone" data-loc="leftArm"
                    d="M 74 46 L 92 46 L 88 116 L 78 116 Z"/>
              <path class="sp-zone" data-loc="rightLeg"
                    d="M 30 120 L 48 120 L 46 210 L 32 210 Z"/>
              <path class="sp-zone" data-loc="leftLeg"
                    d="M 52 120 L 70 120 L 68 210 L 54 210 Z"/>
            </svg>
          </div>
          <div class="defense-buttons">
            <button type="button" class="defense-btn" data-action="dodge" title="Dodge">
              <i class="fa-solid fa-person-running"></i><span class="nm">Dodge</span>
            </button>
            <button type="button" class="defense-btn" data-action="relocate" title="Relocate">
              <i class="fa-solid fa-arrows-up-down-left-right"></i><span class="nm">Rel</span>
            </button>
            <button type="button" class="defense-btn" data-action="brawl" title="Brawl">
              <i class="fa-solid fa-hand-fist"></i><span class="nm">Brawl</span>
            </button>
          </div>
        </div>
      </div>
      <!-- Equipped weapons list (auto-populated from actor.items where
           system.equipped === true).  Click → actor.weaponAttack(weapon). -->
      <div class="weapon-list" data-bind="weapon-list"></div>
    </section>

    <!-- ACTION TRAYS — peace + combat variants.  CSS toggles between them
         on encounter enter/exit.  No behavior wired yet. -->
    <section class="sign-tray peace-signs">
      <div class="sign" title="Skills"     data-action="skills">
        <i class="fa-solid fa-sitemap"></i><span class="nm">Skills</span>
      </div>
      <div class="sign" title="Sober Up"   data-action="sober-up">
        <i class="fa-solid fa-beer-mug-empty"></i><span class="nm">Sober Up</span>
        <span class="sober-badge" data-bind="sober-rank"></span>
      </div>
      <div class="sign" title="Heal"       data-action="heal">
        <i class="fa-solid fa-heart-pulse"></i><span class="nm">Heal</span>
      </div>
      <div class="sign" title="Initiative" data-action="initiative">
        <i class="fa-solid fa-bolt"></i><span class="nm">Initiative</span>
      </div>
      <div class="sign" title="Awareness"  data-action="awareness">
        <i class="fa-solid fa-eye"></i><span class="nm">Awareness</span>
      </div>
      <div class="sign" title="Brawl"      data-action="brawl">
        <i class="fa-solid fa-hand-fist"></i><span class="nm">Brawl</span>
      </div>
    </section>
    <section class="sign-tray combat-signs">
      <div class="sign" title="Skills"        data-action="skills">
        <i class="fa-solid fa-sitemap"></i><span class="nm">Skills</span>
      </div>
      <div class="sign" title="Critical"      data-action="crit">
        <i class="fa-solid fa-burst"></i><span class="nm">Crit</span>
      </div>
      <div class="sign" title="Fumble"        data-action="fumble">
        <i class="fa-solid fa-face-frown-open"></i><span class="nm">Fumble</span>
      </div>
      <div class="sign" title="Stun / Death Saving Throw"  data-action="saving-throw">
        <i class="fa-solid fa-dice-d20"></i><span class="nm">Stun/Death</span>
      </div>
      <div class="sign" title="Initiative"    data-action="initiative">
        <i class="fa-solid fa-bolt"></i><span class="nm">Init</span>
      </div>
    </section>

  </div>

  <!-- PROMPTS — static keycap row (1-5), inert visual placeholder -->
  <div class="prompts" data-bind="prompts"></div>
</footer>
`;

/* ---------- sawtooth path generator -------------------------------------- */

/** Outline path for 16 teeth across a 200x12 viewBox (matches reference.html). */
const SAWTOOTH_OUTLINE = (() => {
  const parts = ["M0 1.5"];
  for (let i = 1; i <= 32; i++) {
    const x = i * 6.25;
    const y = (i % 2 === 1) ? 10 : 1.5;
    parts.push(`L${x} ${y}`);
  }
  return parts.join(" ");
})();

/** Fill polygon up to a given fraction (0–1). */
function sawtoothFill(frac) {
  const fillX = Math.max(0, Math.min(200, frac * 200));
  const parts = ["M0 1.5"];
  let i = 0;
  while (true) {
    const x = (i + 1) * 6.25;
    if (x >= fillX) {
      const lastY = (i % 2 === 0) ? 10 : 1.5;
      parts.push(`L${fillX} ${lastY}`);
      break;
    }
    const y = (i % 2 === 0) ? 10 : 1.5;
    parts.push(`L${x} ${y}`);
    i++;
  }
  parts.push(`L${fillX} 0`, "L0 0 Z");
  return parts.join(" ");
}

/* Draws the sawtooth fill. `frac` is the real (amber) fill fraction; `tempFrac`
 * is an optional temp-HP "shield" segment that blends in contiguously after it.
 * The frost shield is drawn FIRST spanning real+temp, then the amber real fill
 * is layered on top — so frost only shows in the gap past real HP, no offset
 * path math needed. */
function renderSawtooth(svg, frac, tempFrac = 0) {
  if (!svg) return;
  svg.innerHTML = "";
  const ns = "http://www.w3.org/2000/svg";
  const outline = document.createElementNS(ns, "path");
  outline.setAttribute("d", SAWTOOTH_OUTLINE);
  outline.setAttribute("fill", "none");
  outline.setAttribute("stroke", "var(--accent)");
  outline.setAttribute("stroke-width", "1.1");
  svg.appendChild(outline);

  if (tempFrac > 0) {
    const temp = document.createElementNS(ns, "path");
    temp.setAttribute("d", sawtoothFill(Math.min(1, frac + tempFrac)));
    temp.setAttribute("fill", "var(--wdm-frost, #6a8aa2)");
    svg.appendChild(temp);
  }
  if (frac > 0) {
    const fill = document.createElementNS(ns, "path");
    fill.setAttribute("d", sawtoothFill(frac));
    fill.setAttribute("fill", "var(--accent)");
    svg.appendChild(fill);
  }
}

/* ---------- SP per body location ----------------------------------------- */

export const SP_LOCATIONS = ["head", "torso", "leftArm", "rightArm", "leftLeg", "rightLeg"];

/** Sum SP across natural armor + every equipped armor item, per location. */
export function getLocationSP(actor) {
  const sp = { head: 0, torso: 0, leftArm: 0, rightArm: 0, leftLeg: 0, rightLeg: 0 };
  if (!actor) return sp;

  const s = actor.system ?? {};
  sp.head     += Number(s.armorHead)  || 0;
  sp.torso    += Number(s.armorUpper) || 0;
  sp.leftArm  += Number(s.armorUpper) || 0;
  sp.rightArm += Number(s.armorUpper) || 0;
  sp.leftLeg  += Number(s.armorLower) || 0;
  sp.rightLeg += Number(s.armorLower) || 0;

  const items = actor.items?.contents ?? actor.items ?? [];
  for (const a of items) {
    if (a.type !== "armor" || !a.system?.equipped) continue;
    const sys = a.system;
    sp.head     += Number(sys.headStopping)     || 0;
    sp.torso    += Number(sys.torsoStopping)    || 0;
    sp.leftArm  += Number(sys.leftArmStopping)  || 0;
    sp.rightArm += Number(sys.rightArmStopping) || 0;
    sp.leftLeg  += Number(sys.leftLegStopping)  || 0;
    sp.rightLeg += Number(sys.rightLegStopping) || 0;
  }
  return sp;
}

/** Damage-resistance letter mapping. The system armorData schema has three
 *  boolean flags: bludgeoning / slashing / piercing. We surface a single
 *  capital letter per active flag — smaller and more legible than icons. */
export const RES_TYPES = [
  { key: "bludgeoning", letter: "B", tip: "Bludgeoning Resistance" },
  { key: "slashing",    letter: "S", tip: "Slashing Resistance"    },
  { key: "piercing",    letter: "P", tip: "Piercing Resistance"    }
];

/** Returns a Set of resistance keys active for `loc` based on equipped armor.
 *  Logic: any equipped armor item that contributes stopping > 0 at this loc
 *  AND has the resistance flag set contributes that resistance. */
export function getResistancesForLocation(actor, loc) {
  const found = new Set();
  if (!actor) return found;
  const stoppingField = `${loc}Stopping`;
  const items = actor.items?.contents ?? actor.items ?? [];
  for (const a of items) {
    if (a.type !== "armor" || !a.system?.equipped) continue;
    if (!(Number(a.system?.[stoppingField]) > 0)) continue;
    for (const { key } of RES_TYPES) {
      if (a.system?.[key]) found.add(key);
    }
  }
  return found;
}

/** Decrement 1 SP from the armor covering a location. Priority:
 *  - First equipped armor item with stopping > 0 at that location, then
 *  - Natural armor field on the actor (armorHead / armorUpper / armorLower).
 *  Floors at 0; no-op if everything's already 0. */
export async function decrementArmorSP(actor, loc) {
  if (!actor) return;
  const stoppingField = `${loc}Stopping`; // headStopping, torsoStopping, etc.
  const items = actor.items?.contents ?? actor.items ?? [];
  for (const a of items) {
    if (a.type !== "armor" || !a.system?.equipped) continue;
    const cur = Number(a.system?.[stoppingField]) || 0;
    if (cur > 0) {
      await a.update({ [`system.${stoppingField}`]: Math.max(0, cur - 1) });
      return;
    }
  }
  const natField = loc === "head"
    ? "armorHead"
    : (loc === "leftLeg" || loc === "rightLeg")
      ? "armorLower"
      : "armorUpper";
  const cur = Number(actor.system?.[natField]) || 0;
  if (cur > 0) {
    await actor.update({ [`system.${natField}`]: Math.max(0, cur - 1) });
  }
}

function wireSPDecDelegation(dock) {
  if (dock.dataset.wouSpDecWired === "1") return;
  dock.dataset.wouSpDecWired = "1";
  dock.addEventListener("click", async (ev) => {
    /* Two click sources: the old minus-buttons (kept for fallback) and the
     * new SVG body-figure zones.  Both carry data-loc. */
    const target = ev.target.closest?.(".sp-dec, .sp-zone");
    if (!target) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (target.classList.contains("is-empty")) return; /* SVG zone with 0 SP */
    if (target.classList.contains("is-zero"))  return; /* legacy dec-button   */
    const loc = target.dataset.loc;
    const actor = getAssignedActor();
    if (!loc || !actor) return;
    try {
      await decrementArmorSP(actor, loc);
      /* Live-refresh the popover so the player sees the new SP without
       * having to mouse out and back in.  Only refresh if the popover is
       * still pointing at the zone the user just clicked. */
      refreshSPPopIfOpen(actor, loc, target);
    }
    catch (err) { console.warn("witcher-ttrpg-death-march | sp decrement failed", err); }
  });
  wireSPFigurePopover(dock);
}

/** Click the Quen-shield counter to spend one point of the shield pool
 *  (system.derivedStats.shield, a single player-set number). Clamped at 0. */
function wireShieldDecDelegation(dock) {
  if (dock.dataset.wouShieldDecWired === "1") return;
  dock.dataset.wouShieldDecWired = "1";
  dock.addEventListener("click", async (ev) => {
    const counter = ev.target.closest?.('.counter[data-kind="shield"]');
    if (!counter) return;
    ev.preventDefault();
    ev.stopPropagation();
    const actor = getAssignedActor();
    if (!actor) return;
    const cur = Number(actor.system?.derivedStats?.shield) || 0;
    if (cur <= 0) return;
    try { await actor.update({ "system.derivedStats.shield": Math.max(0, cur - 1) }); }
    catch (err) { console.warn("witcher-ttrpg-death-march | shield decrement failed", err); }
  });
}

/** Click the Adrenaline counter to spend points as temporary HP. Opens a
 *  prompt for how many points to commit; each point rolls 1d6 and the total
 *  is added to system.derivedStats.hp.temp (stacking with any existing temp,
 *  which also counts toward staying above the wound threshold / out of death
 *  state). Drains that many adrenaline points. */
function wireAdrenalineDelegation(dock) {
  if (dock.dataset.wouAdrWired === "1") return;
  dock.dataset.wouAdrWired = "1";
  dock.addEventListener("click", async (ev) => {
    const counter = ev.target.closest?.('.counter[data-kind="adrenaline"]');
    if (!counter) return;
    ev.preventDefault();
    ev.stopPropagation();
    const actor = getAssignedActor();
    if (!actor) return;
    await promptAdrenalineTempHp(actor);
  });
}

/** Spend N adrenaline (≤ current pool) → roll Nd6 → add the total to temp HP.
 *  Each die also costs the configured Stamina (RAW 10, Core p.176). */
async function promptAdrenalineTempHp(actor) {
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2 || !actor) return;
  if (!isAdrenalineEnabled()) return;
  const pool = Math.max(0, Number(actor.system?.adrenaline?.value) || 0);
  if (pool <= 0) { ui.notifications?.info("No adrenaline to spend."); return; }
  const staPer = adrenalineStaPerDie();
  const content = `<div class="wou-adr-prompt">
    <label>Adrenaline dice → temp HP</label>
    <input type="number" name="dice" min="1" max="${pool}" step="1" value="${pool}" autofocus />
    <p class="hint">Spend up to ${pool} adrenaline. Each point rolls 1d6 (added as temp HP) and costs ${staPer} STA.</p>
  </div>`;
  const dice = await DialogV2.prompt({
    window: { title: `Adrenaline → Temp HP — ${actor.name}` },
    content,
    ok: { label: "Roll", callback: (_e, btn) => Number(btn.form?.elements?.dice?.value) || 0 },
    rejectClose: false
  }).catch(() => null);
  if (dice == null) return;
  const spend = Math.min(pool, Math.max(0, Math.round(dice)));
  if (spend <= 0) return;
  try {
    const roll = await new Roll(`${spend}d6`).evaluate();
    const gained  = Math.max(0, Math.floor(Number(roll.total)) || 0);
    const curTemp = Math.max(0, Number(actor.system?.derivedStats?.hp?.temp) || 0);
    // Track the adrenaline-sourced share of temp HP on a flag so leaving combat
    // can evaporate exactly that much (and no potion/effect temp HP) — see
    // policy/combat-round-reset.mjs endCombatForActor.
    const priorAdrTemp = Math.max(0, Number(actor.getFlag?.("witcher-ttrpg-death-march", "adrenalineTempHp")) || 0);
    await actor.update({
      "system.adrenaline.value":      Math.max(0, pool - spend),
      "system.derivedStats.hp.temp":  curTemp + gained,
      "flags.witcher-ttrpg-death-march.adrenalineTempHp": priorAdrTemp + gained
    });
    // Pay the Stamina cost (RAW 10/die, Core p.176), same path the attack flow uses.
    const staCost = spend * staPer;
    if (staCost > 0) {
      try { await actor.spendStamina?.(staCost, { reason: "adrenaline" }); }
      catch (err) { console.warn("witcher-ttrpg-death-march | adrenaline STA spend failed", err); }
    }
    await roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor }),
      flavor:  `Adrenaline surge — spent ${spend} adrenaline (${staCost} STA) for +${gained} temp HP`
    });
  } catch (err) {
    console.warn("witcher-ttrpg-death-march | adrenaline temp HP failed", err);
  }
}

/* =========================================================================
   BODY-FIGURE HOVER POPOVER
   Module-scope helpers so the click handler can re-render the popover
   in place after a decrement, without rewiring its events.
   ========================================================================= */

const SP_POP_ID = "wou-sp-zone-popover";
const SP_LOC_LABELS = {
  head: "Head", torso: "Torso",
  leftArm: "L. Arm", rightArm: "R. Arm",
  leftLeg: "L. Leg", rightLeg: "R. Leg"
};
/* Witcher RAW damage-location multiplier: head x3, torso x1, limbs x0.5. */
const SP_LOC_DMG_MULT = {
  head: 3, torso: 1,
  leftArm: 0.5, rightArm: 0.5,
  leftLeg: 0.5, rightLeg: 0.5
};

function renderSPPopContent(actor, loc) {
  const sp = getLocationSP(actor)[loc] ?? 0;
  const res = getResistancesForLocation(actor, loc);
  const hasRes = RES_TYPES.some(t => res.has(t.key));
  const resHtml = hasRes
    ? RES_TYPES.filter(t => res.has(t.key)).map(t => t.letter).join(" ")
    : '<span class="none">none</span>';
  const mult = SP_LOC_DMG_MULT[loc] ?? 1;
  /* Render the multiplier as ×3, ×1, ×0.5 — same column-width as SP. */
  const multLabel = `×${mult}`;
  return `
    <div class="sp-pop-loc">${SP_LOC_LABELS[loc] ?? loc}</div>
    <div class="sp-pop-row ${sp === 0 ? "sp-pop-empty" : ""}"><span>SP</span><b>${sp}</b></div>
    <div class="sp-pop-row"><span>Damage</span><b>${multLabel}</b></div>
    <div class="sp-pop-row"><span>Resist</span><span class="sp-pop-res ${hasRes ? "" : "none"}">${resHtml}</span></div>
  `;
}

function positionSPPop(pop, anchorRect) {
  pop.style.left = "0px";
  pop.style.top = "0px";
  const pr = pop.getBoundingClientRect();
  let left = anchorRect.right + 10;        /* default: right of the limb */
  let top = anchorRect.top + (anchorRect.height - pr.height) / 2;
  if (left + pr.width > window.innerWidth - 8) {
    left = anchorRect.left - pr.width - 10; /* flip to left side if no room right */
  }
  top = Math.max(8, Math.min(top, window.innerHeight - pr.height - 8));
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top  = `${Math.round(top)}px`;
}

/**
 * After a click-to-damage, if the popover is currently open and pointing
 * at the zone the user just clicked, re-render its content + reposition.
 * No-op otherwise (e.g. fallback minus-button click).
 */
function refreshSPPopIfOpen(actor, loc, zoneEl) {
  const pop = document.getElementById(SP_POP_ID);
  if (!pop || !pop.classList.contains("is-open")) return;
  if (!zoneEl || !zoneEl.classList?.contains("sp-zone")) return;
  pop.innerHTML = renderSPPopContent(actor, loc);
  positionSPPop(pop, zoneEl.getBoundingClientRect());
}

/* Custom hover popover for the body-figure zones.  Mirrors the dock-statuses
 * popover pattern (own DOM, own positioning, never touches Foundry's global
 * tooltip).  Content is rendered per-hover from the actor's current SP. */
function wireSPFigurePopover(dock) {
  if (dock.dataset.wouSpFigPopover === "1") return;
  dock.dataset.wouSpFigPopover = "1";

  let pop = document.getElementById(SP_POP_ID);
  if (!pop) {
    const style = document.createElement("style");
    style.id = "wou-sp-zone-popover-style";
    style.textContent = `
      #${SP_POP_ID} {
        position: fixed;
        z-index: 9200;
        display: none;
        min-width: 130px;
        padding: 8px 12px 9px;
        background:
          radial-gradient(ellipse 200px 100px at 50% 0%, rgba(184,148,100,0.12), transparent 75%),
          linear-gradient(180deg, rgba(22,18,13,0.98) 0%, rgba(10,9,8,0.98) 100%);
        background-color: rgba(10,9,8,0.98);
        border: 1px solid var(--wdm-amber-dim);
        border-radius: 2px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.85), inset 0 0 0 1px rgba(184,148,100,0.10);
        color: var(--wdm-ink-hi);
        font-family: var(--wdm-font-body);
        font-size: 14px;
        line-height: 1.5;
        text-align: left;
        pointer-events: none;
      }
      #${SP_POP_ID}.is-open { display: block; }
      #${SP_POP_ID} .sp-pop-loc {
        display: block;
        font-family: var(--wdm-font-display);
        font-size: 12px; font-weight: 700;
        letter-spacing: 0.30em; text-transform: uppercase;
        color: var(--wdm-amber-bright);
        margin-bottom: 4px;
        padding-bottom: 4px;
        border-bottom: 1px dotted rgba(184,148,100,0.25);
      }
      #${SP_POP_ID} .sp-pop-row {
        display: flex; justify-content: space-between; gap: 12px;
        font-family: var(--wdm-font-display);
        font-size: 12px; letter-spacing: 0.10em; text-transform: uppercase;
        color: var(--wdm-ink);
      }
      #${SP_POP_ID} .sp-pop-row b {
        color: var(--wdm-amber-hi);
        font-weight: 700;
      }
      #${SP_POP_ID} .sp-pop-row.sp-pop-empty b { color: var(--wdm-ink-faint); }
      #${SP_POP_ID} .sp-pop-res { color: var(--wdm-amber-hi); letter-spacing: 0.20em; }
      #${SP_POP_ID} .sp-pop-res.none { color: var(--wdm-ink-faint); font-style: italic; letter-spacing: 0; }
    `;
    document.head.appendChild(style);
    pop = document.createElement("div");
    pop.id = SP_POP_ID;
    document.body.appendChild(pop);
  }

  dock.addEventListener("mouseover", (e) => {
    const zone = e.target.closest?.(".sp-zone");
    if (!zone) return;
    const loc = zone.dataset.loc;
    const actor = getAssignedActor();
    if (!loc || !actor) return;
    pop.innerHTML = renderSPPopContent(actor, loc);
    pop.classList.add("is-open");
    positionSPPop(pop, zone.getBoundingClientRect());
  });
  dock.addEventListener("mouseout", (e) => {
    const zone = e.target.closest?.(".sp-zone");
    if (!zone) return;
    if (zone.contains(e.relatedTarget)) return;
    pop.classList.remove("is-open");
  });
  window.addEventListener("scroll", () => pop.classList.remove("is-open"), { capture: true, passive: true });
}

/* ---------- vigor bar --------------------------------------------------- */

/* Discreet ⓘ that opens a themed rich tooltip — used inside the action /
 * full-round / movement dialogs. (escapeHTML is hoisted, safe to call here.) */
function helpIconHTML(tip) {
  return `<span class="wdm-help-tip" data-tooltip="${escapeHTML(tip)}" data-tooltip-direction="UP" data-tooltip-class="wou-craft-tip"><i class="fa-solid fa-circle-info"></i></span>`;
}

/* War-bar help: action economy + how to shake off conditions. Shown via a ⓘ
 * inside the Action / Full Round / Movement dialogs. */
const ACTION_ECON_TIP =
  '<div class="wcu-tip">' +
    '<strong>Your Turn</strong>' +
    'Each round you get one Movement and one Action.' +
    '<div class="wcu-tip-row"><span>Movement</span><span>Up to your SPD in metres</span></div>' +
    '<div class="wcu-tip-row"><span>Action</span><span>Attack, cast, defend…</span></div>' +
    '<div class="wcu-tip-row"><span>Extra Action</span><span>3 STA, −3 to hit</span></div>' +
    '<div class="wcu-tip-row"><span>Full Round</span><span>Spends Movement + Action</span></div>' +
    '<div class="wcu-tip-row"><span>Defending</span><span>1st free, then 1 STA each</span></div>' +
    '<div class="wcu-tip-flavor">Shake off a condition from the Action menu: “Clear a condition” (Stand, Put Out Fire…) or “End a condition — roll” (an Endurance/Physique check). Most cost 1 action.</div>' +
  '</div>';

const SVG_NS = "http://www.w3.org/2000/svg";

/* Cartesian point on the vigor circle. 0° = 12 o'clock, sweeping clockwise. */
function vigorPolar(cx, cy, r, deg) {
  const a = (deg - 90) * Math.PI / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

/* Minor-arc path between two clockwise angles (battle-tested describeArc). */
function vigorArcPath(cx, cy, r, startDeg, endDeg) {
  const [sx, sy] = vigorPolar(cx, cy, r, endDeg);
  const [ex, ey] = vigorPolar(cx, cy, r, startDeg);
  const large = (endDeg - startDeg) <= 180 ? 0 : 1;
  return `M ${sx.toFixed(2)} ${sy.toFixed(2)} A ${r} ${r} 0 ${large} 0 ${ex.toFixed(2)} ${ey.toFixed(2)}`;
}

/* Lit-pip gradient endpoints — muted amber→bronze, desaturated to sit in the
 * dock's theme rather than read as neon green. */
const VIGOR_GRAD_HI = "#c2a85a";   // soft gold (the full / bottom end)
const VIGOR_GRAD_LO = "#7c6630";   // dark bronze (toward the depleting top end)

/* Linear interpolate two #rrggbb colours → "rgb(r,g,b)". */
function lerpHex(a, b, t) {
  const parse = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const m = (x, y) => Math.round(x + (y - x) * Math.max(0, Math.min(1, t)));
  return `rgb(${m(ar, br)},${m(ag, bg)},${m(ab, bb)})`;
}

/* Witcher-3-style segmented vigor ARC hugging the medallion's lower-left
 * (6 o'clock → 9 o'clock). `vigor` segments along the arc; the upper ones
 * (toward 9 o'clock) stay `is-lit` (yellow→green), round Chaos eats them from
 * the bottom (`is-spent`, red). Hidden below 1 Vigor. Rebuilt each render. */
function renderVigorBar(host, vigor, spent) {
  if (!host) return;
  const total = Math.max(0, Number(vigor) || 0);
  if (total < 1) { host.hidden = true; host.replaceChildren(); return; }

  const lit = Math.max(0, Math.min(total, total - (Number(spent) || 0)));
  host.hidden = false;
  host.setAttribute("aria-label", `Vigor ${lit}/${total}`);

  // Centre of the 110×110 viewBox; the 70px portrait has radius 35 here, so a
  // radius of 50 floats the arc a clear ~12px off the medallion (concentric).
  const cx = 55, cy = 55, r = 50;
  const A0 = 180, A1 = 270;              // bottom → left (the lower-left quadrant)
  const step = (A1 - A0) / total;
  // Modest inter-pip gap so the splits read but don't gape (paired with `butt`
  // caps in CSS — round caps would overhang and swallow the gap).
  const gap = total > 1 ? Math.min(6, step * 0.26) : 0;

  const frag = document.createDocumentFragment();
  for (let i = 0; i < total; i++) {
    const s = A0 + i * step + gap / 2;
    const e = A0 + (i + 1) * step - gap / 2;
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", vigorArcPath(cx, cy, r, s, e));
    p.setAttribute("fill", "none");
    // Light the BOTTOM `lit` units (lowest indices, toward 6 o'clock); the TOP
    // (toward 9 o'clock) depletes FIRST → the bar empties top-to-bottom.
    const isLit = i < lit;
    p.setAttribute("class", `v-unit ${isLit ? "is-lit" : "is-spent"}`);
    // Per-pip gradient across the lit run — a muted amber→bronze ramp (theme
    // palette, desaturated). Spent pips keep the CSS red. Fraction is by the
    // unit's fixed position so the gradient stays put as pips deplete.
    if (isLit) {
      const t = total > 1 ? i / (total - 1) : 0;
      p.style.stroke = lerpHex(VIGOR_GRAD_HI, VIGOR_GRAD_LO, t);
    }
    frag.appendChild(p);
  }
  host.replaceChildren(frag);
}

/* ---------- spells row (combat) ----------------------------------------- */

function renderSpellsRow(host, actor) {
  if (!host) return;
  host.innerHTML = "";
  if (!actor) return;

  const items = actor.items?.contents ?? actor.items ?? [];

  /* Only pinned spells appear in the dock — no fallback.  Players curate
   * via the pin toggle on the character magic subtab; if nothing is
   * pinned the row stays empty (and the empty hint takes its place). */
  const pinnedIds = actor.flags?.["witcher-ttrpg-death-march"]?.pinnedSpells;
  const pinSet    = Array.isArray(pinnedIds) ? new Set(pinnedIds) : new Set();
  const spells    = items.filter(i =>
    (i.type === "spell" || i.type === "hex" || i.type === "ritual")
    && pinSet.has(i.id)
  );

  if (!spells.length) {
    host.innerHTML = `<div class="spells-empty">— no pinned spells —</div>`;
    return;
  }

  // No action slot left in combat → casting isn't possible; grey the buttons.
  const noActions = isActorInActiveCombat(actor) && actor?.nextActionSlot == null;

  for (const spell of spells) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "spell-btn" + (noActions ? " is-disabled" : "");
    btn.title = noActions ? "No actions left this turn." : spell.name;
    btn.dataset.spellId = spell.id;
    btn.innerHTML = `<img src="${escapeHTML(spell.img ?? "")}" alt="${escapeHTML(spell.name)}" />`;
    btn.addEventListener("click", async (e) => {
      e.preventDefault(); e.stopPropagation();
      if (noActions) { ui.notifications?.warn("No actions left this turn."); return; }
      try {
        if (typeof actor.castSpell !== "function") {
          if (typeof actor.useItem === "function") await actor.useItem(spell.id);
          return;
        }
        // Route the action economy off the cast result: cancel spends nothing;
        // a ritual / multi-action cast locks the whole turn; otherwise it takes
        // a normal action slot (auto-falls through to the extra action).
        const res = await actor.castSpell(spell);
        if (!res) return;
        if (res.fullRound) {
          if (typeof actor.recordFullRound === "function") {
            await actor.recordFullRound(`Cast: ${spell.name}`);
          }
        } else {
          await maybeSpendActionSlot(actor, `Cast: ${spell.name}`);
        }
      } catch (err) {
        console.warn("witcher-ttrpg-death-march | castSpell failed", err);
      }
    });
    host.appendChild(btn);
  }
}

/* ---------- equipped weapons list --------------------------------------- */

/** Witcher TRPG combat skills → FontAwesome Pro icon class (the system
 *  bundles FA Pro, so these are available).  Pick the closest weapon-y
 *  glyph for each skill family. */
const WEAPON_SKILL_ICONS = {
  brawling:      "fa-fist-raised",
  swordsmanship: "fa-sword",
  smallblades:   "fa-dagger",
  melee:         "fa-axe-battle",
  staffspear:    "fa-staff",       // no spearhead glyph in FA — staff is closest
  athletics:     "fa-person-running",
  archery:       "fa-bow-arrow",
  crossbow:      "fa-bow-arrow",   // no dedicated crossbow icon in FA either
};

/** Resolve the actual skill that drives a weapon's attack roll.
 *  Witcher TRPG stores `meleeAttackSkill` and `rangedAttackSkill` separately
 *  (with `attackOptions` being a Set indicating which apply).  For throwable
 *  melee weapons (e.g., a thrown dagger) both options exist — we prefer
 *  ranged, since that's the bow/crossbow/throwing skill that picks the
 *  recognizable icon. */
function getWeaponSkill(weapon) {
  const sys = weapon?.system ?? {};
  const opts = sys.attackOptions;
  const has = (key) =>
    opts?.has?.(key) ?? (Array.isArray(opts) && opts.includes(key));
  if (has("ranged")) return sys.rangedAttackSkill || sys.attackSkill;
  if (has("melee"))  return sys.meleeAttackSkill  || sys.attackSkill;
  return sys.attackSkill || "swordsmanship";
}

/** Read the oil coating off a weapon. A coating is one or more ActiveEffects
 *  copied onto the weapon by inventory.js (tagged flags.<sys>.oilCoating); each
 *  carries the user-configured duration + a description with the bonus text.
 *  The representative is the soonest-expiring effect (drives the bar); we carry
 *  its live `duration` object out so the dock formats it through describeDuration
 *  — the SAME path potion badges and the inventory inspect use — so the weapon
 *  bar reads identically (rounds in combat, wall clock out). Returns null when
 *  there's no live coating. Pure read — no writes. */
function getAppliedOilForWeapon(weapon) {
  let repRem = Infinity, repDur = null, name = null;
  const texts = [];
  for (const e of weapon?.effects ?? []) {
    if (e.disabled) continue;
    const flag = e.getFlag?.("witcher-ttrpg-death-march", "oilCoating");
    if (!flag) continue;
    const secs = Number(e.duration?.seconds);
    let remaining = Infinity;
    if (secs > 0) {
      // v14 computes secondsRemaining from start.time + value/units.
      const rem = Number(e.duration?.secondsRemaining);
      remaining = Number.isFinite(rem) ? rem : secs;
    }
    if (Number.isFinite(remaining) && remaining <= 0) continue;   // worn off
    const d = String(e.description || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (d) texts.push(d);
    if (name == null || remaining < repRem) { repRem = remaining; repDur = e.duration; name = flag.oilName ?? e.name ?? "Oil"; }
  }
  if (name == null) return null;
  return { name, effect: texts.join(" · "), dur: repDur };
}

/** Resolve a weapon's quality KEYS to display labels via the active catalog
 *  (GM override or seed defaults), folding in any parameter value as
 *  "Label(value suffix)". Reads the effective (post-enhancement) quality set
 *  when present so socketed runes show alongside the weapon's own. */
function weaponQualityLabels(w) {
  const keys = w.system?.effective?.qualities ?? w.system?.qualities ?? [];
  if (!keys.length) return [];
  const catalog = getActiveWeaponQualities() ?? {};
  const values  = w.system?.effective?.qualityValues ?? w.system?.qualityValues ?? {};
  return keys.map((key) => {
    const entry = catalog[key] ?? WEAPON_QUALITIES[key];
    if (!entry) return null;
    const param = entry.param ?? WEAPON_QUALITIES[key]?.param ?? null;
    let label = entry.label;
    if (param) {
      const raw = values[key];
      const v   = raw == null ? "" : String(raw).trim();
      if (v.length) label = `${entry.label}(${v}${param.suffix ?? ""})`;
    }
    return label;
  }).filter(Boolean);
}

/** The ammo a ranged weapon will fire, or null. Chamber weapons (crossbows)
 *  expose it via `loaded.uuid` but only while a round is actually chambered;
 *  bows draw at fire time, so it's the selected/nocked eligible ammo. Used to
 *  fold the projectile's on-hit qualities (Armor-Piercing bodkins, etc.) into
 *  the weapon row once it's loaded. */
function getLoadedAmmo(w) {
  if (!w?.usesAmmo) return null;
  if (w.hasChamber) {
    if ((Number(w.system?.loaded?.count) || 0) <= 0) return null;
    const ref = w.system?.loaded?.uuid;
    return (ref && typeof fromUuidSync === "function") ? fromUuidSync(ref) : null;
  }
  return w.getSelectedAmmo?.() ?? null;
}

function escapeHTML(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/* Signature of everything renderWeaponList draws, so rebindDock's sig-skip
 * re-renders the weapon row on equip/unequip and as oil coatings tick down.
 * Oil remaining is keyed to whole seconds — world time only advances in
 * discrete jumps (never real-time), so this re-renders exactly when the
 * coating's countdown actually changes, with no per-second thrash. */
function weaponListSig(actor) {
  const equipped = (actor?.items?.contents ?? actor?.items ?? [])
    .filter(i => (i.type === "weapon" || i.type === "shield") && i.system?.equipped);
  return equipped.map(w => {
    const oil = getAppliedOilForWeapon(w);
    const od  = oil ? describeDuration(oil.dur ?? {}) : null;
    const oilKey = od ? `${od.label}:${Math.round(od.remaining)}` : "";
    const ammoKey = w.usesAmmo
      ? (w.hasChamber
          ? `c${Number(w.system?.loaded?.count) || 0}/${Math.max(1, Number(w.system?.loaded?.capacity) || 1)}:${w.system?.loaded?.uuid ?? ""}:p${Number(w.system?.loaded?.reloadProgress) || 0}`
          : `b${Number(w.getSelectedAmmo?.()?.system?.quantity) || 0}:${w.getSelectedAmmo?.()?.id ?? ""}`)
      : "";
    return `${w.id}:${w.name}:${occupancyOf(w)}:${oil?.name ?? ""}:${oilKey}:${ammoKey}`;
  }).join("|");
}

/** Ask whether a defense is a Parry (−3, inflicts Staggered, no item wear) or
 *  a Block (no penalty, may spend the item's SP). Returns "parry" | "block" |
 *  null (cancelled). Shared by weapon and shield rows. */
async function promptDefenseMode(item) {
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2) return "parry";
  try {
    return await DialogV2.wait({
      window: { title: `Defend — ${item?.name ?? ""}` },
      modal: true,
      content: `<div style="padding:8px 0;display:flex;flex-direction:column;gap:8px;">
          <p style="margin:0;"><strong>Parry</strong> — roll at −3; a success leaves the attacker Staggered.</p>
          <p style="margin:0;"><strong>Block</strong> — roll at no penalty; absorbing the hit spends 1 SP.</p>
        </div>`,
      buttons: [
        { action: "parry", label: "Parry (−3)", default: true, callback: () => "parry" },
        { action: "block", label: "Block",      callback: () => "block" }
      ],
      rejectClose: false
    });
  } catch (e) { return null; }
}

function renderWeaponList(host, actor) {
  if (!host) return;
  host.innerHTML = "";
  if (!actor) return;

  const equipped = (actor.items?.contents ?? actor.items ?? [])
    .filter(i => (i.type === "weapon" || i.type === "shield") && i.system?.equipped);

  if (!equipped.length) {
    host.innerHTML = `<div class="weapon-empty">— no equipped weapons —</div>`;
    return;
  }

  // A Quick item occupies the off-hand slot and blocks any two-handed
  // weapon from attacking — the 2H attack button greys out and clicks
  // are ignored. Computed once per render. Shields count too (they read as
  // "quick" occupancy), so iterate every equipped item, not just weapons.
  const hasQuick = (actor.items?.contents ?? actor.items ?? [])
    .some(i => i.system?.equipped && occupancyOf(i) === "quick");

  // In combat with no action slot left (action + extra spent, or a full-round
  // lock), attacking isn't possible — grey the attack buttons to match.
  const noActions = isActorInActiveCombat(actor) && actor?.nextActionSlot == null;

  for (const w of equipped) {
    // Shields bash on the Melee skill (system.skillKey === "melee") but show a
    // shield glyph rather than the melee weapon icon. Weapons read their own
    // skillKey, falling back to the legacy resolver for the icon lookup.
    const isShield = w.type === "shield";
    const skill = w.system?.skillKey || getWeaponSkill(w);
    const iconCls = isShield ? "fa-shield" : (WEAPON_SKILL_ICONS[skill] ?? "fa-sword");
    // Shields sheathe/draw like any one-handed item.
    const canSheathe = true;
    // Loaded ammo lends its own qualities to the shot (Armor-Piercing, etc.),
    // so merge them into the weapon's quality line once a round is chambered/
    // nocked. Deduped by label so a shared quality isn't listed twice.
    const ammoItem = getLoadedAmmo(w);
    const ammoQualities = ammoItem ? weaponQualityLabels(ammoItem) : [];
    const qualities = [...new Set([...weaponQualityLabels(w), ...ammoQualities])];

    const oil = getAppliedOilForWeapon(w);
    const od  = oil ? describeDuration(oil.dur ?? {}) : null;
    const oilTimed = !!od && od.total > 0;
    const oilPct   = oilTimed ? Math.max(0, Math.min(100, (od.remaining / od.total) * 100)) : 100;
    const oilLabel = oilTimed ? od.label : "";

    const occupancy = occupancyOf(w);             // right | left | both | quick
    const isTwoHanded = w.system?.hands === "two";
    const blockedByQuick = isTwoHanded && hasQuick;

    // Which hand(s) the weapon occupies — shown as a small greyed tag after the
    // name (e.g. "Steel Sword (R)").
    const HAND_TAG   = { right: "(M)", left: "(O)", both: "(Both)", quick: "(Q)" };
    const HAND_TITLE = {
      right: "Held in the main hand",
      left:  "Held in the off-hand",
      both:  "Two-handed — occupies both hands",
      quick: "Quick / off-hand slot"
    };
    const handTag = occupancy
      ? `<span class="weapon-hand-tag" data-hand="${occupancy}" title="${HAND_TITLE[occupancy] ?? ""}">${HAND_TAG[occupancy] ?? ""}</span>`
      : "";

    // Ammunition readiness — a loaded indicator for ammo-firing weapons, plus
    // a Reload button for chamber weapons (crossbows). Bows have no chamber:
    // they show the nocked round count and need no reload step.
    const usesAmmo = !!w.usesAmmo;
    let ammoBadge = "";
    let chamberFull = false;
    if (usesAmmo) {
      if (w.hasChamber) {
        const cnt = Number(w.system?.loaded?.count) || 0;
        const cap = Math.max(1, Number(w.system?.loaded?.capacity) || 1);
        chamberFull = cnt >= cap;
        const loadedName = (cnt > 0 ? w.system?.loaded?.name : "") || "";
        // The loaded round name IS the next to fire (a chamber holds one ammo
        // type), so show it inline — matters most for big magazines.
        const label = loadedName ? `${cnt}/${cap} · ${escapeHTML(loadedName)}` : `${cnt}/${cap}`;
        const title = loadedName ? `Next to fire: ${escapeHTML(loadedName)}` : "Chamber empty";
        ammoBadge = `<span class="weapon-ammo ${w.isLoaded ? "is-loaded" : "is-empty"}" title="${title}"><i class="fa-solid fa-bullseye"></i> <span class="weapon-ammo-text">${label}</span></span>`;
      } else {
        const sel = w.getSelectedAmmo?.();
        const qty = Number(sel?.system?.quantity) || 0;
        const nm  = sel ? escapeHTML(sel.name) : "no ammo in an equipped container";
        const label = sel ? `${qty} · ${escapeHTML(sel.name)}` : `${qty}`;
        ammoBadge = `<span class="weapon-ammo ${qty > 0 ? "is-loaded" : "is-empty"}" title="Nocked: ${nm}"><i class="fa-solid fa-bullseye"></i> <span class="weapon-ammo-text">${label}</span></span>`;
      }
    }
    // Reload only when there's room — a full chamber hides the button.
    const showReload = usesAmmo && w.hasChamber && !chamberFull;

    // Multi-action reload progress (Slow Reload weapons that need >1 action):
    // a thin bar atop the card fills as reload actions are banked, emptying
    // once the chamber fills or progress is dropped.
    const reloadNeeded   = (usesAmmo && w.hasChamber) ? Math.max(1, Number(w.reloadActions) || 0) : 0;
    const reloadProgress = Number(w.system?.loaded?.reloadProgress) || 0;
    const showReloadBar  = reloadNeeded > 1 && reloadProgress > 0;
    const reloadPct      = showReloadBar ? Math.max(0, Math.min(100, (reloadProgress / reloadNeeded) * 100)) : 0;

    const el = document.createElement("div");
    el.className = "weapon-item"
      + (blockedByQuick ? " is-blocked-by-quick" : "")
      + (noActions ? " is-no-action" : "");
    el.dataset.weaponId = w.id;
    const mainTitle = blockedByQuick
      ? `Two-handed weapons can't attack while a Quick item is equipped.`
      : noActions
        ? `No actions left this turn.`
        : `Attack with ${escapeHTML(w.name)}`;
    const parryTitle = blockedByQuick
      ? `Two-handed weapons can't defend while a Quick item is equipped.`
      : `Defend with ${escapeHTML(w.name)} — Parry or Block`;
    el.innerHTML = `
      ${showReloadBar
        ? `<span class="weapon-reload-bar" title="Reloading ${escapeHTML(w.name)} — ${reloadProgress}/${reloadNeeded} actions">
             <span class="weapon-reload-bar-fill" style="width:${reloadPct.toFixed(1)}%"></span>
           </span>`
        : ""}
      <button type="button" class="weapon-parry${blockedByQuick ? " is-disabled" : ""}" ${blockedByQuick ? "disabled" : ""} title="${parryTitle}">
        <i class="fa-solid fa-shield-halved"></i>
      </button>
      <button type="button" class="weapon-main${blockedByQuick ? " is-disabled" : ""}" ${blockedByQuick ? "disabled" : ""} title="${mainTitle}">
        <span class="weapon-icon-wrap">
          <i class="fa-solid ${iconCls}"></i>
          ${oil ? `<i class="fa-solid fa-droplet weapon-oil-icon" title="Coated: ${escapeHTML(oil.name)}"></i>` : ""}
        </span>
        <span class="weapon-text">
          <span class="weapon-name">${escapeHTML(w.name)}${handTag ? ` ${handTag}` : ""}</span>
          ${qualities.length
            ? `<span class="weapon-qualities">${qualities.map(escapeHTML).join(", ")}</span>`
            : ""}
          ${ammoBadge}
        </span>
      </button>
      ${showReload
        ? `<button type="button" class="weapon-reload${noActions ? " is-disabled" : ""}" ${noActions ? "disabled" : ""} title="${noActions ? "No actions left this turn." : `Reload ${escapeHTML(w.name)}`}"><i class="fa-solid fa-arrows-rotate"></i></button>`
        : ""}
      ${canSheathe
        ? `<button type="button" class="weapon-sheath" title="Sheathe ${escapeHTML(w.name)}">
             <i class="fa-solid fa-arrow-down-to-bracket"></i>
           </button>`
        : ""}
      <button type="button" class="weapon-drop" title="Drop ${escapeHTML(w.name)} to the world (any player can pick up)">
        <i class="fa-solid fa-hand-holding"></i>
      </button>
      ${oil
        ? `<span class="weapon-oil-bar"
                 data-oil-name="${escapeHTML(oil.name)}"
                 data-oil-label="${escapeHTML(oilLabel)}"
                 data-oil-effect="${escapeHTML(oil.effect ?? "")}">
             <span class="weapon-oil-bar-fill" style="width:${oilPct.toFixed(1)}%"></span>
           </span>`
        : ""}
    `;
    // Defend → choose Parry (−3, inflicts Staggered) or Block (spends the
    // item's SP) then roll via actor.defendWith (blocked when a Quick item
    // obscures a 2H weapon). Applies to weapons and shields alike.
    el.querySelector(".weapon-parry").addEventListener("click", async (e) => {
      e.preventDefault(); e.stopPropagation();
      if (blockedByQuick) return;
      try {
        const mode = await promptDefenseMode(w);
        if (!mode) return;
        if (typeof actor.defendWith === "function") await actor.defendWith(w, mode);
      } catch (err) {
        console.warn("witcher-ttrpg-death-march | defense roll failed", err);
      }
    });
    // Main button → attack with the weapon (blocked if a Quick is up).
    el.querySelector(".weapon-main").addEventListener("click", async (e) => {
      e.preventDefault(); e.stopPropagation();
      if (blockedByQuick) return;
      // No action slot left → refuse before the dialog/roll so we don't roll
      // the attack OR spend ammo for a shot that can't be taken.
      if (actor.hasActionSlot === false) {
        ui.notifications?.warn("No actions left this turn.");
        return;
      }
      let res;
      try {
        if (typeof actor.weaponAttack === "function") res = await actor.weaponAttack(w);
        else if (typeof actor.useItem === "function") { actor.useItem(w.id); res = {}; }
      } catch (err) {
        console.warn("witcher-ttrpg-death-march | weapon attack failed", err);
      }
      // weaponAttack returns null when the modifier dialog was cancelled (or
      // the weapon was invalid) — spend nothing in that case. A Charge is a
      // full-round action (consumes the whole turn); a declared Extra Action
      // takes the extra slot (3 STA in combat); otherwise spend the next slot.
      if (!res) return;
      if (res.declaration?.strikeMeta?.fullRound) await actor.recordFullRound?.(`Charge: ${w.name}`);
      else if (res.declaration?.extraAction) await actor.recordExtraAction?.(`Attack: ${w.name}`);
      else await maybeSpendActionSlot(actor, `Attack: ${w.name}`);
    });
    // Reload button (chamber weapons only) → chamber a round from the
    // selected equipped-container ammo; reloading is itself an action.
    el.querySelector(".weapon-reload")?.addEventListener("click", async (e) => {
      e.preventDefault(); e.stopPropagation();
      // In combat a reload costs an action — refuse when none remain (out of
      // combat the economy is untracked, so reloading is always free).
      if (actor.hasActionSlot === false) {
        ui.notifications?.warn("No actions left this turn.");
        return;
      }
      let res = null;
      try {
        res = await reloadWithPrompt(w);
      } catch (err) {
        console.warn("witcher-ttrpg-death-march | weapon reload failed", err);
      }
      // A reload action was taken (chambered OR banked toward a multi-action
      // reload). Burn the action, flag the turn so banked progress survives,
      // and surface progress when the reload isn't finished yet.
      if (res) {
        await maybeSpendActionSlot(actor, `Reload: ${w.name}`);
        await actor.markReloadAction?.();
        if (res.complete === false) {
          ui?.notifications?.info?.(`Reloading ${w.name} (${res.progress}/${res.needed}).`);
        }
      }
    });
    // Sheath button → put the weapon away (origin container, any
    // container, or just unequip).
    el.querySelector(".weapon-sheath")?.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      sheathWeapon(actor, w);
    });
    // Drop button → remove from actor, create at world level with default
    // OWNER ownership so any player can claim it.
    el.querySelector(".weapon-drop").addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      dropWeaponToWorld(actor, w);
    });
    host.appendChild(el);
  }
}

/* ---------- peace-tray sign actions ------------------------------------- */

const DRUNK_ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII"];

/** Open the unarmed-action dialog (punch/kick/grapple chain + block) and route
 *  its action economy. Shared by the combat-state defense Brawl button and the
 *  peace-tray Brawl sign so both show the identical dialog. The economy
 *  bookkeeping only fires inside an active combat — out of combat it's free. */
async function runBrawlAction(actor) {
  if (typeof actor?.brawlAttack !== "function") return;
  let res = null;
  try { res = await actor.brawlAttack(); }
  catch (err) { console.warn("witcher-ttrpg-death-march | brawl failed", err); }
  if (!res) return;
  if (!isActorInActiveCombat(actor)) return;
  try {
    const brawlLabel = `Brawl: ${game.i18n.localize(res.declaration?.actionMeta?.labelKey ?? "WITCHER.Brawl.DialogTitle")}`;
    if (res.kind === "defense") await actor.recordDefense?.();
    else if (res.declaration?.actionMeta?.fullRound) await actor.recordFullRound?.(brawlLabel);
    else if (res.declaration?.extraAction) await actor.recordExtraAction?.("Brawl");
    else await maybeSpendActionSlot(actor, brawlLabel);
  } catch (err) { console.warn("witcher-ttrpg-death-march | brawl economy failed", err); }
}

/** Run an action keyed off `.sign[data-action="…"]` for a given actor. */
async function runPeaceSignAction(action, actor) {
  switch (action) {
    case "brawl": {
      await runBrawlAction(actor);
      return;
    }
    case "sober-up": {
      if (!isHomebrewEnabled("foodAndDrink")) return;
      const api = game.witcherFoodAndDrink?.drunk;
      if (!api?.soberUp) {
        ui.notifications?.warn("witcher-food-and-drink is not active.");
        return;
      }
      await api.soberUp(actor);
      return;
    }
    case "heal": {
      // _onHeal lives on the character sheet (via healMixin) and only
      // touches this.actor + a DialogV2 — no rendered sheet required.
      const sheet = actor.sheet;
      if (typeof sheet?._onHeal === "function") await sheet._onHeal();
      return;
    }
    case "initiative": {
      // Witcher initiative is 1d10 + REF. Pre-resolve REF off the actor so
      // the formula is a simple literal (no @-substitution dependency, no
      // CONFIG-level state spilling onto other actors' rolls).
      const ref = Number(actor.system?.stats?.ref?.value) || 0;
      const formula = `1d10 + ${ref}`;

      // If the actor already has combatant(s) in the active combat, just
      // re-roll those — never spawn a duplicate. Actor#rollInitiative w/
      // createCombatants:true will add a fresh tokenless combatant every click
      // for any actor whose token isn't on the scene, hence the duplicates.
      let combat = game.combat;
      if (!combat) {
        if (game.user.isGM && canvas.scene) {
          combat = await getDocumentClass("Combat").create({ scene: canvas.scene.id, active: true });
        } else { ui.notifications?.warn("No active combat encounter."); return; }
      }
      let existing = combat.combatants.filter(c => c.actorId === actor.id);
      // No combatant yet — create one per active token (or a tokenless one) so a
      // token already on the scene rolls AND lands on the track in one click.
      if (!existing.length) {
        const tokens = actor.getActiveTokens?.() ?? [];
        const toCreate = tokens.length
          ? tokens.filter(t => !t.inCombat).map(t => ({ tokenId: t.id, sceneId: t.scene.id, actorId: actor.id, hidden: t.document.hidden }))
          : [{ actorId: actor.id }];
        if (toCreate.length) await combat.createEmbeddedDocuments("Combatant", toCreate);
        existing = combat.combatants.filter(c => c.actorId === actor.id);
      }
      // Roll by combatant id — works for linked AND unlinked tokens, unlike
      // Actor#rollInitiative whose gather skips synthetic token actors.
      if (existing.length) await combat.rollInitiative(existing.map(c => c.id), { formula });
      return;
    }
    case "awareness": {
      await rollAwarenessWithModifiers(actor);
      return;
    }
    // "skills" is handled separately by the skills-panel popover; no-op here.
  }
}

/** Combat-tray sign actions — hooked to the same actor-sheet handlers the
 *  in-game character sheet uses, so behavior stays consistent. */
async function runCombatSignAction(action, actor) {
  switch (action) {
    case "saving-throw": {
      await promptStatSavingThrow(actor);
      return;
    }
    case "fumble": {
      await openFumbleDialog(actor);
      return;
    }
    case "crit": {
      await openCriticalDialog(actor);
      return;
    }
    case "initiative": {
      // Same Initiative flow as the peace tray — reuse to keep behavior
      // identical regardless of which mode the dock is in.
      await runPeaceSignAction("initiative", actor);
      return;
    }
  }
}

/** Prompt for Stun vs Death save, then dispatch. Delegates to the actor's
 *  shared saveMixin prompt (the same one the sheet buttons use). */
async function promptStatSavingThrow(actor) {
  return actor?.promptSave?.();
}

/** Roll a skill as a BLIND roll (GM sees the result; players see only that a
 *  blind roll was made). extendedRoll calls Roll#toMessage without a rollMode,
 *  so we intercept the next preCreateChatMessage and tag it blind + GM-whisper. */
async function rollBlindSkill(actor, skill, opts = {}) {
  if (typeof actor.rollSkill !== "function") return;
  const gmIds = game.users.filter(u => u.isGM).map(u => u.id);
  let fired = false;
  const hookId = Hooks.once("preCreateChatMessage", (msg) => {
    fired = true;
    msg.updateSource({ blind: true, whisper: gmIds });
  });
  try { await actor.rollSkill(skill, opts); }
  finally { if (!fired) Hooks.off("preCreateChatMessage", hookId); }
}

/** Awareness from the dock: open a modifier prompt listing the weather/light
 *  penalties that bear on perception (fog, rain, snow, storm, moonlight,
 *  darkness, glare — every active modifier whose `target` is "awareness"),
 *  each individually toggleable, plus a free situational field. The selected
 *  parts fold into the (still blind) skill roll and show as named chips on the
 *  card. Falls back to a plain blind roll if DialogV2 is unavailable.
 *
 *  The weather/light penalties are open-air effects, so their checkboxes
 *  DEFAULT to the scene's exposure: ON when the viewed scene is outdoors,
 *  pre-unchecked when it's indoor / weather-fx-disabled (`suppressWeatherVisuals`)
 *  on the assumption you're sheltered from them. Either way they stay listed so
 *  the GM can opt a stray one in or out (e.g. a draughty hall, an open window). */
async function rollAwarenessWithModifiers(actor) {
  const DialogV2 = foundry?.applications?.api?.DialogV2;

  // Outdoors → weather penalties presumed in effect (default checked); indoors
  // or fx-disabled → presumed sheltered (default unchecked).
  let outdoors = true;
  try { outdoors = !suppressWeatherVisuals(); } catch (_) { /* no scene/canvas — treat as open air */ }

  // Weather + light records that target Awareness. Guarded — the weather
  // subsystem may be disabled or the calendar not yet ready.
  let weatherMods = [];
  try {
    weatherMods = (getActiveWeatherModifiers() ?? [])
      .filter(m => m?.target === "awareness")
      .map((m, i) => ({ id: `wx${i}`, label: game.i18n.localize(m.label), value: Number(m.value) || 0 }));
  } catch (_) { /* weather/calendar not ready — prompt still offers a manual mod */ }

  if (!DialogV2) return rollBlindSkill(actor, "awareness");

  const headNote = weatherMods.length
    ? (outdoors ? "" : ` <span class="wou-skillmod-note">(indoors — off by default)</span>`)
    : "";
  const rows = weatherMods.length
    ? weatherMods.map(m => `
        <label class="wou-skillmod-row">
          <input type="checkbox" name="${m.id}"${outdoors ? " checked" : ""} />
          <span class="wou-skillmod-name">${escapeHTML(m.label)}</span>
          <span class="wou-skillmod-val">${m.value >= 0 ? "+" : ""}${m.value}</span>
        </label>`).join("")
    : `<p class="wou-skillmod-empty">No weather or light conditions affect Awareness right now.</p>`;

  const content = `
    <div class="wou-skillmod-prompt">
      <div class="wou-skillmod-head">Weather &amp; light${headNote}</div>
      ${rows}
      <label class="wou-skillmod-manual">
        <span>Other situational modifier</span>
        <input type="number" name="manual" step="1" value="0" />
      </label>
    </div>`;

  const picked = await DialogV2.prompt({
    window: { title: `Awareness — ${actor.name}` },
    content,
    ok: {
      label: "Roll",
      callback: (_e, btn) => {
        const form = btn.form;
        const parts = [];
        for (const m of weatherMods) {
          if (form.elements[m.id]?.checked) parts.push({ label: m.label, value: m.value });
        }
        const manual = Number(form.elements.manual?.value) || 0;
        if (manual) parts.push({ label: "Situational", value: manual });
        return parts;
      }
    },
    rejectClose: false
  }).catch(() => null);

  if (picked == null) return;   // cancelled
  const situational = picked.reduce((s, p) => s + (Number(p.value) || 0), 0);
  return rollBlindSkill(actor, "awareness", { situational, situationalParts: picked });
}

function wireSignDelegation(dock) {
  if (dock.dataset.wouSignWired === "1") return;
  dock.dataset.wouSignWired = "1";
  dock.addEventListener("click", async (ev) => {
    /* Match any sign in either tray.  We route by the tray class so peace
     * and combat actions stay separate even though both share the click path. */
    const sign = ev.target.closest?.('.sign-tray .sign');
    if (!sign) return;
    const action = sign.dataset.action;
    if (!action || action === "skills") return;     // skills handled by skills-panel popover
    ev.preventDefault();
    ev.stopPropagation();
    const actor = getAssignedActor();
    if (!actor) {
      ui.notifications?.warn("No character assigned to this user.");
      return;
    }
    const isCombat = sign.closest(".sign-tray")?.classList.contains("combat-signs");
    try {
      if (isCombat) await runCombatSignAction(action, actor);
      else          await runPeaceSignAction(action, actor);
    } catch (err) {
      console.warn(`witcher-ttrpg-death-march | sign action "${action}" failed`, err);
    }
  });
}

/* ---------- main injector + binder -------------------------------------- */

/* Portal popover for oil bars — single shared element appended to <body> so it
 * escapes the dock's overflow clipping (the in-flow approach made the weapon
 * list reflow and "vibrate" on hover). Show/position on pointerenter, hide on
 * pointerleave. Event delegation on the dock means no per-render wiring. */
function ensureOilPopover() {
  let el = document.getElementById("wou-oil-popover");
  if (el) return el;
  el = document.createElement("div");
  el.id = "wou-oil-popover";
  el.className = "wou-oil-popover";
  el.setAttribute("role", "tooltip");
  el.style.display = "none";
  document.body.appendChild(el);
  return el;
}

function showOilPopover(bar) {
  const pop = ensureOilPopover();
  const name   = bar.dataset.oilName   ?? "";
  const label  = bar.dataset.oilLabel  ?? "";
  const effect = bar.dataset.oilEffect ?? "";
  const timeLine = label ? `${label} remaining` : "active until cleansed";
  pop.innerHTML =
    `<div class="wou-oil-tt-title">${escapeHTML(name)}</div>` +
    `<div class="wou-oil-tt-charges">${timeLine}</div>` +
    (effect ? `<div class="wou-oil-tt-effect">${escapeHTML(effect)}</div>` : "");
  pop.style.display = "block";
  // Position above and right-aligned to the bar so it floats over the dock
  // without clipping. Use viewport coordinates (position:fixed).
  const rect = bar.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  let top  = rect.top  - popRect.height - 8;
  let left = rect.left + (rect.width / 2) - (popRect.width / 2);
  if (top  < 4) top  = rect.bottom + 8;                      // flip below if no room above
  if (left < 4) left = 4;                                    // viewport clamp
  if (left + popRect.width > window.innerWidth - 4) left = window.innerWidth - popRect.width - 4;
  pop.style.top  = `${top}px`;
  pop.style.left = `${left}px`;
}

function hideOilPopover() {
  const pop = document.getElementById("wou-oil-popover");
  if (pop) pop.style.display = "none";
}

function wireOilPopoverDelegation(dock) {
  if (dock.dataset.wouOilDelegationWired === "1") return;
  dock.dataset.wouOilDelegationWired = "1";
  dock.addEventListener("pointerenter", (ev) => {
    const bar = ev.target.closest?.(".weapon-oil-bar");
    if (bar) showOilPopover(bar);
  }, true);
  dock.addEventListener("pointerleave", (ev) => {
    const bar = ev.target.closest?.(".weapon-oil-bar");
    if (bar) hideOilPopover();
  }, true);
}

/* =========================================================================
   ACTION ECONOMY — RAW combat round budget (Core p.151-152).
   The four action-budget buttons drive system.combatRound via the actor's
   combatRoundMixin. Movement opens a meters prompt; Action / Extra open a
   menu of RAW actions; Full Round opens the full-round submenu (Run /
   Actively Dodge / Aim / Recovery). Auto-spend on attack / cast / draw is
   gated on isActorInActiveCombat so it only fires inside an encounter.
   ========================================================================= */

// Single-action options (Core p.151).
// Attack and Cast Magic are informational here — you launch them from the
// weapon list / spells row, which spends the slot for you. Shown greyed so
// players know they're actions, but not clickable from this menu.
const ACTION_OPTIONS = [
  { key: "attack", icon: "fa-gavel",          label: "Attack",   info: "Use the weapon buttons to attack" },
  { key: "cast",   icon: "fa-wand-sparkles",  label: "Cast Magic", info: "Use the spells row to cast" },
  { key: "skill",  icon: "fa-hand",           label: "Use a Skill" },
  { key: "draw",   icon: "fa-hand-fist",      label: "Draw / Pick Up Item" },
  { key: "verbal", icon: "fa-comments",       label: "Initiate Verbal Combat" }
];
// Full-round options (Core p.152) — use the whole turn (lock all three slots).
const FULL_ROUND_OPTIONS = [
  { key: "run",      icon: "fa-person-running", label: "Run (SPD×3)" },
  { key: "dodge",    icon: "fa-shield-halved",  label: "Actively Dodge" },
  { key: "aim",      icon: "fa-crosshairs",     label: "Aim (+1/round, max +3)" },
  { key: "recovery", icon: "fa-lungs",          label: "Recovery Action (regain REC STA)" }
];

/** Spend an action slot for an attack / cast / draw, but only inside an
 *  active combat the actor is part of. No-op (and no warning) otherwise. */
async function maybeSpendActionSlot(actor, label) {
  if (!actor || !isActorInActiveCombat(actor)) return;
  if (typeof actor.spendActionSlot !== "function") return;
  try { await actor.spendActionSlot(label); }
  catch (err) { console.warn("witcher-ttrpg-death-march | action auto-spend failed", err); }
}

/** Menu of RAW actions. `slot` is "action" (single actions only),
 *  "extra" (single actions, costs 3 STA), or "full" (full-round only —
 *  these have their own dock button). */
async function openActionMenu(actor, slot) {
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2 || !actor) return;
  const sections = [];
  if (slot === "action" || slot === "extra") {
    sections.push({
      group: "normal",
      title: slot === "extra" ? "Extra Action — 3 STA, at −3" : "Action",
      opts: ACTION_OPTIONS
    });
    // No-roll "shake it off" actions (Stand / Put Out Fire / Wash Off Acid),
    // sourced from the status clauses' selfClear field. An entry is clickable
    // only while the bearer actually has that condition; otherwise it's shown
    // greyed (info) so players know the action exists.
    const clearOpts = selfClearOptions().map(o => actor.statuses?.has?.(o.id)
      ? { key: `clear:${o.id}`, icon: o.icon, label: o.label }
      : { key: `clear:${o.id}`, icon: o.icon, label: o.label, info: `Requires the ${o.statusName} condition` });
    if (clearOpts.length) sections.push({ group: "clear", title: "Clear a condition (1 action)", opts: clearOpts });

    // Roll-to-end actions (Overdose purge) — sourced from clauses whose endCheck
    // is `viaAction`. Costs 1 action AND rolls the check; repeatable (take it as
    // an extra action if you want another go). Clickable only while the bearer
    // has the condition.
    const checkOpts = actionEndCheckOptions().map(o => actor.statuses?.has?.(o.id)
      ? { key: `endcheck:${o.id}`, icon: o.icon, label: o.label }
      : { key: `endcheck:${o.id}`, icon: o.icon, label: o.label, info: `Requires the ${o.statusName} condition` });
    if (checkOpts.length) sections.push({ group: "endcheck", title: "End a condition — roll (1 action)", opts: checkOpts });
  }
  if (slot === "full") {
    // Aim caps at AIM_MAX_RANK — once there, show it greyed/informational
    // rather than clickable, since re-aiming would do nothing.
    const aimMaxed = (Number(actor.aimRank) || 0) >= AIM_MAX_RANK;
    // Stunned at 0 STA: only the Recovery action is allowed; the rest are shown
    // greyed/informational so the player sees why they're locked out.
    const staMax = Number(actor.system?.derivedStats?.sta?.max) || 0;
    const staVal = Number(actor.system?.derivedStats?.sta?.value) || 0;
    const stunned = staMax > 0 && staVal === 0;
    const fullOpts = FULL_ROUND_OPTIONS.map(o => {
      if (stunned && o.key !== "recovery")
        return { ...o, info: "Stunned at 0 STA — recover first" };
      if (o.key === "aim" && aimMaxed)
        return { ...o, info: `Already at maximum aim (Aim ${AIM_MAX_RANK})` };
      return o;
    });
    sections.push({ group: "full", title: "Full Round — uses your whole turn", opts: fullOpts });
  }
  const content = `<div class="wou-action-menu">
    <div class="wou-action-menu-help">${helpIconHTML(ACTION_ECON_TIP)}</div>
    ${sections.map(s => `
    <div class="wou-action-group">
      <div class="wou-action-group-title">${escapeHTML(s.title)}</div>
      ${s.opts.map(o => o.info
        ? `<div class="wou-action-cell is-info" data-key="${o.key}" title="${escapeHTML(o.info)}"><i class="fa-solid ${o.icon}"></i><span>${escapeHTML(o.label)}</span></div>`
        : `<button type="button" class="wou-action-cell" data-group="${s.group}" data-key="${o.key}" data-label="${escapeHTML(o.label)}"><i class="fa-solid ${o.icon}"></i><span>${escapeHTML(o.label)}</span></button>`).join("")}
    </div>`).join("")}</div>`;

  await DialogV2.wait({
    window: { title: `Action — ${actor.name}` },
    content,
    buttons: [{ action: "close", label: "Cancel", default: true }],
    rejectClose: false,
    classes: ["wou-action-menu-dialog"],
    render: (_e, dlg) => {
      const root = dlg?.element ?? dlg;
      root?.querySelectorAll?.("button.wou-action-cell").forEach(btn => {
        btn.addEventListener("click", async (ev) => {
          ev.preventDefault();
          const label = btn.dataset.label;
          try {
            if (btn.dataset.group === "clear") {
              // Spend the slot first; only clear the condition if it was spent
              // (in combat a failed spend — no slot / extra before action —
              // notifies and leaves the status in place).
              const statusId = btn.dataset.key.slice("clear:".length);
              const spent = slot === "extra"
                ? await actor.recordExtraAction(label)
                : await actor.recordAction(label);
              if (spent) await actor.toggleStatusEffect?.(statusId, { active: false });
            } else if (btn.dataset.group === "endcheck") {
              // Roll-to-end (Overdose purge): spend the slot, then roll. A failed
              // spend (no slot — take it as an extra action) leaves it unattempted.
              const statusId = btn.dataset.key.slice("endcheck:".length);
              const spent = slot === "extra"
                ? await actor.recordExtraAction(label)
                : await actor.recordAction(label);
              if (spent) await performActionEndCheck(actor, statusId);
            } else if (btn.dataset.group === "full") {
              if (btn.dataset.key === "recovery") await actor.takeRecoveryAction();
              else if (btn.dataset.key === "aim") await actor.takeAimAction();
              else await actor.recordFullRound(label);
            } else if (slot === "extra") {
              await actor.recordExtraAction(label);
            } else {
              await actor.recordAction(label);
            }
          } catch (err) { console.warn("witcher-ttrpg-death-march | action menu failed", err); }
          dlg?.close?.();
        });
      });
    }
  }).catch(() => null);
}

/** Movement prompt — declare meters moved (default = SPD). */
async function promptMovement(actor) {
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2 || !actor) return;
  const spd = Number(actor.system?.stats?.spd?.value) || 0;
  const split = isHomebrewEnabled("splitMovement");
  const prior = Number(actor.system?.combatRound?.movementMeters) || 0;
  const remaining = split && spd ? Math.max(0, spd - prior) : spd;
  const hint = split
    ? `Up to ${remaining}m left of your SPD ${spd}m this turn — movement can be split across actions. Running (SPD×3) is a full-round action.`
    : `Up to your SPD of ${spd}m — moving locks the Move action, and acting forfeits remaining movement. Running (SPD×3) is a full-round action.`;
  const content = `<div class="wou-move-prompt">
    <label>Distance moved (m) ${helpIconHTML(ACTION_ECON_TIP)}</label>
    <input type="number" name="meters" min="0" max="${remaining}" step="1" value="${remaining}" autofocus />
    <p class="hint">${hint}</p>
  </div>`;
  const meters = await DialogV2.prompt({
    window: { title: `Move — ${actor.name}` },
    content,
    ok: { label: "Confirm", callback: (_e, btn) => Number(btn.form?.elements?.meters?.value) || 0 },
    rejectClose: false
  }).catch(() => null);
  if (meters == null) return;
  try { await actor.recordMovement(meters); }
  catch (err) { console.warn("witcher-ttrpg-death-march | recordMovement failed", err); }
}

/** Paint the four action-budget buttons from combatRound state. Out of an
 *  active combat the budget is unlimited — ignore persisted slot state and
 *  paint everything available. */
/** Stunned: STA pool exists (max > 0) and is depleted to 0. */
function isStunnedSta(sta) {
  return Number(sta?.max) > 0 && Number(sta?.cur) === 0;
}

function paintActionBudget(dock, cr, inCombat = false, sta = null) {
  const budget = dock.querySelector(".action-budget");
  if (!budget) return;
  // Out of combat: blank the round so every slot reads fresh/available.
  const c = inCombat ? (cr ?? {}) : {};
  budget.classList.toggle("out-of-combat", !inCombat);
  budget.classList.toggle("is-locked", !!c.fullRound);

  // Stunned at 0 STA (regardless of whether a combat is started): every slot
  // but the Recovery full-round action is locked out until STA climbs to ≥1.
  const stunned = isStunnedSta(sta);
  const STUN_TITLE = "Stunned at 0 STA — only a Recovery action is available";

  // Full-round needs the whole turn — once any slot is spent (but not by a
  // committed full round itself) it can no longer be taken. Show that as blocked.
  const dirty = !c.fullRound && (c.movementUsed || (Number(c.movementMeters) || 0) > 0 || c.actionUsed || c.extraUsed);
  const full = budget.querySelector(".action-btn.full-round");
  if (full) {
    full.classList.toggle("is-used", !!c.fullRound);
    // Greyed + non-clickable once a full round is committed, or once any other
    // slot is spent (which makes a full round impossible this turn).
    full.classList.toggle("is-blocked", !!dirty || !!c.fullRound);
    full.title = c.fullRound
      ? (c.fullRoundLabel || "Full Round")
      : dirty
        ? "Full Round unavailable — you've already moved or acted this turn"
        : "Full Round (uses your whole turn — locks all three)";
  }
  const move = budget.querySelector('.action-btn[data-action="movement"]');
  if (move) {
    // With Split Movement on, the total accumulates and only locks at SPD —
    // show the running tally even before it's exhausted. Otherwise it's
    // single-use: declaring any distance locks Move and crosses it out.
    const moved = Number(c.movementMeters) || 0;
    move.classList.toggle("is-used", !!c.movementUsed);
    // RAW (Split Movement off): acting forfeits any remaining movement, so
    // once an action/extra is spent the Move button is no longer available.
    const splitOff = !isHomebrewEnabled("splitMovement");
    const moveLockedByAction = splitOff && !c.movementUsed && (c.actionUsed || c.extraUsed);
    move.classList.toggle("is-blocked", !!moveLockedByAction || stunned);
    const nm = move.querySelector(".nm");
    if (nm) nm.textContent = moved > 0 ? `${moved}m` : "Movement";
    move.title = stunned
      ? STUN_TITLE
      : c.movementUsed
        ? `Moved ${moved}m — movement spent`
        : moveLockedByAction
          ? "Movement unavailable — you've already acted this turn (enable Split Movement to interleave)"
          : moved > 0
            ? `Moved ${moved}m so far (split movement)`
            : "Movement (declare distance, up to SPD)";
  }
  const act = budget.querySelector('.action-btn[data-action="action"]');
  if (act) {
    act.classList.toggle("is-used", !!c.actionUsed);
    act.classList.toggle("is-blocked", stunned);
    act.title = stunned ? STUN_TITLE : c.actionUsed ? (c.actionLabel || "Action used") : "Action";
  }
  const extra = budget.querySelector('.action-btn[data-action="extra-action"]');
  if (extra) {
    extra.classList.toggle("is-used", !!c.extraUsed);
    // The extra action is a SECOND action — it can't be taken until the normal
    // action is spent. Grey it out until then, in AND out of combat. Out of
    // combat the budget is blanked (c = {}), so the normal action is never
    // tracked as used and the extra stays unavailable, which is intended:
    // the extra action is a combat-only second action.
    const extraLocked = !c.fullRound && !c.extraUsed && !c.actionUsed;
    extra.classList.toggle("is-blocked", !!extraLocked || stunned);
    extra.title = stunned
      ? STUN_TITLE
      : c.extraUsed
        ? (c.extraLabel || "Extra action used")
        : extraLocked
          ? "Use your action first — the extra action is a second action (3 STA, at −3)"
          : "Extra Action (3 STA, at −3)";
  }
  // Full-round stays reachable while stunned so the player can pick Recovery —
  // openActionMenu restricts the menu to the Recovery option. Retitle it, but
  // keep it blocked if a full round is genuinely impossible (already moved/acted).
  if (full && stunned && !c.fullRound && !dirty) full.title = STUN_TITLE;
}

/** Clone-wire the four action-budget buttons (avoids double-binding on rebind). */
function wireActionButtons(dock, actor) {
  const budget = dock.querySelector(".action-budget");
  if (!budget) return;
  budget.querySelectorAll(".action-btn").forEach(btn => {
    const clone = btn.cloneNode(true);
    btn.replaceWith(clone);
    clone.addEventListener("click", async (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!actor) return;
      // Buttons always open their UI. The action-economy methods themselves
      // no-op out of combat, so actions are free / untracked there.
      // A greyed (is-blocked) button is unavailable this turn — ignore clicks.
      if (clone.classList.contains("is-blocked")) return;
      const action = clone.dataset.action;
      if (action === "movement")          await promptMovement(actor);
      else if (action === "action")       await openActionMenu(actor, "action");
      else if (action === "extra-action") await openActionMenu(actor, "extra");
      else if (action === "full-round")   await openActionMenu(actor, "full");
    });
  });
}

export function injectDock() {
  if (document.getElementById("wou-dock")) return;
  const host = document.getElementById("interface") || document.body;
  host.insertAdjacentHTML("beforeend", DOCK_HTML);
  const dock = document.getElementById("wou-dock");
  if (dock) {
    wireOilPopoverDelegation(dock);
    wireSPDecDelegation(dock);
    wireShieldDecDelegation(dock);
    wireAdrenalineDelegation(dock);
    wireSignDelegation(dock);
  }
  rebindDock();
  injectStatusesRow();
}

/** Coalesce dock rebinds: N hooks per tick → 1 rebind per animation
 *  frame.  rebindDock itself is fast (mostly textContent writes), but
 *  the inventory / sheet flows can fire 6+ updateItem hooks in a row,
 *  and there's no need to do the work each time. */
let _rebindPending = false;
export function scheduleRebindDock() {
  if (_rebindPending) return;
  _rebindPending = true;
  requestAnimationFrame(() => {
    _rebindPending = false;
    rebindDock();
  });
}

let _lastRebindSig = null;
export function rebindDock() {
  const dock = document.getElementById("wou-dock");
  if (!dock) return;

  const actor = getAssignedActor();
  const data = getDockData(actor);

  /* Sig-skip: getDockData is cheap-ish to recompute, but the ~30 DOM
   * writes + getElement calls below force layout work that's wasted
   * when nothing visible has changed.  JSON.stringify on this object
   * is ~1KB / sub-millisecond, way cheaper than re-doing the writes.
   *
   * getDockData carries only identity + pools, NOT the equipped-weapon
   * list — so fold in a weapon signature, otherwise equip/unequip (which
   * changes nothing in `data`) gets skipped and the weapon row never
   * re-renders.  Includes oil minute-buckets so the coating bar ticks too.
   *
   * Same problem for the armor figure (per-location SP) and the pinned
   * spells row — neither lives in `data`, so equipping armor or pinning a
   * spell would otherwise no-op the rebind.  Fold both in. */
  const armorSig = JSON.stringify(getLocationSP(actor));
  const pinSig   = JSON.stringify(actor?.flags?.["witcher-ttrpg-death-march"]?.pinnedSpells ?? []);
  const sig = JSON.stringify(data) + "|" + weaponListSig(actor) + "|" + armorSig + "|" + pinSig;
  if (sig === _lastRebindSig) return;
  _lastRebindSig = sig;

  const setText = (sel, val) => {
    dock.querySelectorAll(sel).forEach(el => { el.textContent = val ?? ""; });
  };

  // identity
  setText('[data-bind="name"]',       data.name);
  setText('[data-bind="profession"]', data.profession);
  setText('[data-bind="race"]',       data.race);
  const medImg = dock.querySelector('[data-bind="medallion"]');
  if (medImg) {
    // The medallion icon is the profession's linked SVG. No profession (or
    // none set) → empty src; hide the img so the centre stays bare.
    if (data.medallion) {
      medImg.src = data.medallion;
      medImg.style.display = "";
    } else {
      medImg.removeAttribute("src");
      medImg.style.display = "none";
    }
    medImg.alt = data.profession || "";
  }

  // Vitality — sawtooth, no numeric readout. The pool also flags a
  // severity state for CSS — `wounded` triggers at half HP (the Witcher
  // wound threshold) and `dying` at 0 HP (death saves), each darkening
  // the bar's --accent to a deeper blood-red.
  renderSawtooth(dock.querySelector('[data-bind="hp-bar"]'), data.hp.realFrac, data.hp.tempFrac);
  const hpPool = dock.querySelector('.ident-text .pool[data-kind="hp"]');
  if (hpPool) {
    // Severity keys off REAL HP — the temp shield doesn't mask wounds.
    const cur = data.hp?.realCur ?? 0;
    const max = data.hp?.realMax ?? 0;
    const sev = cur <= 0
      ? "dying"
      : (max > 0 && cur <= max / 2 ? "wounded" : "normal");
    hpPool.dataset.severity = sev;
  }

  // STA + STRESS — concentric half-moon arcs (right / left). `data.stress` is
  // null when the stress homebrew toggle is off — hide the arc entirely.
  for (const kind of ["sta", "stress"]) {
    const arc = dock.querySelector(`[data-bind="${kind}-arc"]`);
    if (!arc) continue;
    if (!data[kind]) { arc.style.display = "none"; continue; }
    arc.style.display = "";
    const frac = data[kind]?.max > 0
      ? Math.max(0, Math.min(1, data[kind].cur / data[kind].max))
      : 0;
    arc.setAttribute("stroke-dasharray", `${frac * 100} 100`);
  }

  // Guard-stance button — part of the optional combat overhaul. Hide it
  // unless the `extendedCombat` homebrew toggle is enabled.
  const guard = dock.querySelector(".defense-col .guard-btn");
  if (guard) guard.style.display = isHomebrewEnabled("extendedCombat") ? "" : "none";

  // TOX — fills the medallion's background from the top down via a gradient
  // stop driven by the `--tox-frac` custom property on the portrait.
  const portrait = dock.querySelector(".identity .portrait");
  if (portrait) {
    const toxFrac = data.tox?.max > 0
      ? Math.max(0, Math.min(1, data.tox.cur / data.tox.max))
      : 0;
    portrait.style.setProperty("--tox-frac", String(toxFrac));
  }

  // Combat-state center column — 3 sawtooth bars + 3 counters.
  for (const kind of ["hp", "sta", "tox"]) {
    const p = data[kind];
    renderSawtooth(dock.querySelector(`[data-bind="c-${kind}-bar"]`), p.realFrac ?? p.frac, p.tempFrac ?? 0);
    setText(`[data-bind="c-${kind}-cur"]`, String(p.cur));
    setText(`[data-bind="c-${kind}-max"]`, String(p.max));
  }
  for (const kind of ["stress", "adrenaline", "shield"]) {
    const counter = dock.querySelector(`.counter[data-kind="${kind}"]`);
    if (!data[kind]) { if (counter) counter.style.display = "none"; continue; }
    if (counter) counter.style.display = "";
    setText(`[data-bind="c-${kind}-cur"]`, String(data[kind].cur));
    setText(`[data-bind="c-${kind}-max"]`, String(data[kind].max));
  }

  // Combat-state SP per body location.  The body figure has one SVG zone
  // per location — we update its class to reflect SP state and let CSS pick
  // the fill color.  Hover content is rendered live from getLocationSP /
  // getResistancesForLocation in the popover handler, so nothing to bind
  // here beyond the visual state.
  const sp = getLocationSP(actor);
  for (const loc of SP_LOCATIONS) {
    const zone = dock.querySelector(`.sp-zone[data-loc="${loc}"]`);
    if (!zone) continue;
    zone.classList.toggle("is-empty",  sp[loc] === 0);
    zone.classList.toggle("is-fresh",  sp[loc] >= 5);
    zone.classList.toggle("is-worn",   sp[loc] > 0 && sp[loc] < 5);
  }

  // Action-economy budget — wire the four slot buttons, then paint state.
  // Out of combat the budget is unlimited, so ignore any persisted slot
  // state and paint everything fresh.
  wireActionButtons(dock, actor);
  paintActionBudget(dock, data.combatRound, isActorInActiveCombat(actor), data.sta);

  // Defense buttons — dodge rolls the dodge skill, relocate rolls athletics.
  // Each also records a defensive action (1st free, each extra costs 1 STA
  // unless Actively Dodging — Core p.152), but only inside an active combat.
  // Stunned at 0 STA: defenses are locked out too — grey them and ignore clicks.
  const defStunned = isStunnedSta(data.sta);

  // Once the free reaction this round is spent, every further defense draws
  // 1 STA. Flag the dock so CSS dims ALL defensive controls (Dodge / Rel /
  // Brawl + each weapon's Parry-Block icon) — a glanceable "this now costs
  // stamina" cue. Actively Dodging keeps defenses free, so it never dims.
  const dr = data.combatRound ?? {};
  // Free reactions this round = 1 + combatMods.freeDefenses; only past that do
  // defenses start drawing STA (and the dim cue fires).
  const freeDef = Number(actor?.system?.combatMods?.freeDefenses) || 0;
  const defensesCost = isActorInActiveCombat(actor)
    && !dr.activelyDodging
    && (Number(dr.defenseCount) || 0) >= (1 + freeDef);
  dock.classList.toggle("defenses-costing", defensesCost && !defStunned);
  dock.querySelectorAll('.defense-btn').forEach(btn => {
    // Avoid double-binding on re-render — replace with clone
    const clone = btn.cloneNode(true);
    btn.replaceWith(clone);
    // Brawl stays clickable even with no action slot — its Block option is a
    // defensive reaction (block a melee attack with your limbs). Only stun (no
    // defense possible) greys it; the dialog disables the ATTACK/grapple options
    // when no action slot remains.
    clone.classList.toggle("is-blocked", defStunned);
    if (defStunned) clone.title = "Stunned at 0 STA — you can't defend until you recover";
    clone.addEventListener("click", async (e) => {
      e.preventDefault(); e.stopPropagation();
      if (clone.classList.contains("is-blocked")) return;
      const action = clone.dataset.action;

      // Brawl opens the unarmed-action dialog (punch/kick/grapple chain + block).
      // It routes its own economy: a block records a defense, an attack/grapple
      // spends an action slot — so this branch returns before the dodge/relocate
      // defense bookkeeping below.
      if (action === "brawl") {
        await runBrawlAction(actor);
        return;
      }

      // Dodge and Relocation are first-class defensive actions (not generic
      // skill rolls): defendBySkill posts a "Dodge"/"Relocation — defense" card
      // and records the reaction itself (first free, each extra 1 STA), so no
      // separate rollSkill / recordDefense here. Relocation uses the Athletics
      // skill but is distinct from throwing something with Athletics.
      const def = action === "dodge" ? { skill: "dodge", label: "Dodge" }
                : action === "relocate" ? { skill: "athletics", label: "Relocation" }
                : null;
      if (def && actor && typeof actor.defendBySkill === "function") {
        try { await actor.defendBySkill(def.skill, { label: def.label }); }
        catch (err) { console.warn("witcher-ttrpg-death-march | defense roll failed", err); }
      }
    });
  });

  // Combat-state equipped weapons list — re-rendered on any actor / item update.
  renderWeaponList(dock.querySelector('[data-bind="weapon-list"]'), actor);

  // Vigor — Witcher-3-style segmented bar by the medallion. One segment per
  // point of Vigor; the top (vigor − vigorSpent) stay lit, the rest read spent.
  // Hidden below 1 Vigor (fixed space otherwise). Sourced from getDockData so
  // vigor + vigorSpent join the rebind signature (else stale until F5).
  renderVigorBar(dock.querySelector('[data-bind="vigor-bar"]'), data.vigor, data.vigorSpent);
  renderSpellsRow(dock.querySelector('[data-bind="spells-row"]'), actor);

  // Sober Up rank badge — mirrors the witcher-food-and-drink sheet inject:
  // Roman numeral I–VIII, hidden when sober.
  const soberSign = dock.querySelector('.peace-signs .sign[data-action="sober-up"]');
  if (soberSign && !isHomebrewEnabled("foodAndDrink")) {
    soberSign.style.display = "none";
  } else if (soberSign) {
    soberSign.style.display = "";
    const drunkApi = game.witcherFoodAndDrink?.drunk;
    const level = (actor && drunkApi?.getLevel)
      ? Number(drunkApi.getLevel(actor)) || 0
      : 0;
    const badge = soberSign.querySelector('[data-bind="sober-rank"]');
    if (level > 0) {
      const numeral = DRUNK_ROMAN[level - 1] ?? String(level);
      if (badge) {
        badge.textContent = numeral;
        badge.classList.add("has-rank");
      }
      soberSign.title = `Sober Up (currently Drunk ${numeral}) — roll 1d10 under BODY`;
    } else {
      if (badge) {
        badge.textContent = "";
        badge.classList.remove("has-rank");
      }
      soberSign.title = "Sober Up — currently sober";
    }
  }

  // Hotbar — 5 slots persisted on the assigned actor; items + macros.
  injectHotbar(dock.querySelector('[data-bind="prompts"]'), actor);
}
