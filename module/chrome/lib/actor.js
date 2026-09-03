/**
 * Read the user's assigned character and derive the values the dock
 * displays. Wrapped in try/catch so a missing field doesn't crash render.
 *
 * Data paths follow the Witcher TRPG system (TheWitcherTRPG). Adjust here
 * if/when paths change between system versions.
 */

/* Shared session-only "view as" override.  When a GM picks a character from
 * any tab's "View as" dropdown (inventory / character / journal / bestiary),
 * `getAssignedActor()` reports that character to every UI surface that asks
 * — dock, hotbar, every overlay panel.  Non-GMs cannot impersonate; the
 * override is gated on `game.user.isGM` at read time.  Cleared on reload.
 *
 * Setting the override fires `VIEWER_OVERRIDE_HOOK` so chrome that doesn't
 * have a natural re-render trigger (the dock, hotbar, currently-open tab)
 * can pick up the change.
 */
import { isAdrenalineEnabled } from "../../api/adrenaline.mjs";
import { t, tFormat } from "../lib/i18n.js";

export const VIEWER_OVERRIDE_HOOK = "witcher-ttrpg-death-march:viewerOverrideChanged";
let _actorOverrideId = null;
/* When the override targets a TOKEN's synthetic actor (unlinked token),
 * we ALSO capture the token id so getAssignedActor can resolve back to
 * the synthetic instead of the shared world actor. Without this, three
 * unlinked tokens of the same monster would all resolve to the world
 * actor on every dock interaction — shared HP, shared action budget,
 * shared everything — even though the tokens themselves have independent
 * deltas. */
let _actorOverrideTokenId = null;

/* Accept EITHER a string actorId (legacy) OR an Actor instance. When
 * passed an Actor, we also pull its token reference (synthetic actors
 * carry .token). Pass null to clear. */
export function setActorOverride(actorOrId) {
  let nextActorId = null;
  let nextTokenId = null;
  if (actorOrId) {
    if (typeof actorOrId === "string") {
      nextActorId = actorOrId;
    } else if (typeof actorOrId === "object") {
      // Actor instance — synthetic actors expose their TokenDocument via
      // `.token`; world actors return null and stay world-resolved.
      nextActorId = actorOrId.id ?? null;
      nextTokenId = actorOrId.token?.id ?? null;
    }
  }
  if (nextActorId === _actorOverrideId && nextTokenId === _actorOverrideTokenId) return;
  _actorOverrideId      = nextActorId;
  _actorOverrideTokenId = nextTokenId;
  Hooks.callAll(VIEWER_OVERRIDE_HOOK, nextActorId);
}

export function getActorOverride() {
  return _actorOverrideId;
}

export function getAssignedActor() {
  const u = game?.user;
  if (u?.isGM && _actorOverrideId) {
    /* Token-scoped override (unlinked token): resolve via the token's
     * synthetic actor so updates land on the token's delta, not the
     * shared world actor. Search the active scene; fall back to the
     * world actor lookup if the token can't be found (scene change,
     * token deleted, etc.). */
    if (_actorOverrideTokenId) {
      const tokenDoc = canvas?.scene?.tokens?.get?.(_actorOverrideTokenId);
      const synth = tokenDoc?.actor ?? null;
      if (synth?.type === "character" || synth?.type === "monster") return synth;
    }
    const override = game.actors?.get?.(_actorOverrideId);
    /* Accept BOTH character and monster overrides — take-control on
     * turn binds the dock to whichever combatant is up. */
    if (override?.type === "character" || override?.type === "monster") return override;
  }
  // A single controlled, owned token drives the dock — so the action-economy
  // and combat flow run on the TOKEN's actor (the same document the combat
  // tracks, incl. unlinked/synthetic actors), not the base character. Falls
  // back to the user's assigned character when no single token is controlled.
  const controlled = canvas?.tokens?.controlled ?? [];
  if (controlled.length === 1) {
    const tokenActor = controlled[0]?.actor;
    /* GM || isOwner — an orphaned unlinked token (base actor deleted) still
     * carries its stats on its synthetic actor, but that actor's `isOwner` can
     * be false, which made selecting it fall through to the user's character so
     * the dock/"View As" never bound to the token. The GM can view-as any
     * controlled token. */
    if (tokenActor && (u?.isGM || tokenActor.isOwner)) return tokenActor;
  }
  return u?.character ?? null;
}

/* ── Per-panel "View as" override ────────────────────────────────────────────
 * The GLOBAL override above ("Lock as") locks EVERY panel and ignores token
 * selection until cleared. "View as" is the softer, per-panel version: it makes
 * ONE panel show a chosen character while everything else follows normal
 * selection, and it's meant to be transient (panels clear it on close). Keyed by
 * panel id ("inventory", "character", …). GM-only. */
export const PANEL_OVERRIDE_HOOK = "witcher-ttrpg-death-march:panelOverrideChanged";
const _panelOverrides = new Map();

/** Set (or clear, with null) the per-panel "View as" override. */
export function setPanelOverride(panelKey, actorOrId) {
  const id = typeof actorOrId === "string" ? actorOrId : (actorOrId?.id ?? null);
  const prev = _panelOverrides.get(panelKey) ?? null;
  if (id === prev) return;
  if (id) _panelOverrides.set(panelKey, id);
  else    _panelOverrides.delete(panelKey);
  Hooks.callAll(PANEL_OVERRIDE_HOOK, panelKey);
}

export function getPanelOverride(panelKey) {
  return _panelOverrides.get(panelKey) ?? null;
}

/** The actor a panel should show: its own "View as" override if set (GM-only),
 *  otherwise the shared resolution (global "Lock as" → selected token → the
 *  user's character). Panels call this instead of getAssignedActor(). */
export function getPanelActor(panelKey) {
  if (game?.user?.isGM) {
    const id = _panelOverrides.get(panelKey);
    if (id) {
      const a = game.actors?.get?.(id);
      if (a?.type === "character" || a?.type === "monster") return a;
    }
  }
  return getAssignedActor();
}

/* Resolve the started combat `actor` is a combatant of, on the CURRENT scene
 * (or a scene-global combat), or null.
 *
 * We deliberately do NOT go through `game.combat`. In Foundry v14 that getter
 * returns the combat tracker's `viewed` combat while the tracker is rendered,
 * and only falls back to `combats.find(c => c.isActive)` otherwise. A combat
 * that is `started` but not `active` (e.g. begun via a path that never called
 * `combat.activate()`) therefore makes `game.combat` collapse to null the
 * moment the native tracker briefly de-renders — which it does on every
 * item/actor update, because the tracker re-renders. That intermittently
 * reported live combatants as "out of combat", so action-economy charges that
 * ran right after an item write (ranged fire → spendShot, reload → progress,
 * weapon draw → slot assign) silently spent nothing. Reading the combat
 * straight from the data is immune to the tracker's render state and the
 * `active` flag.
 *
 * The scene scope (current scene or scene:null) preserves the original intent:
 * a lingering/other started combat the GM left running on ANOTHER scene must
 * not count this actor as "in combat". */
export function resolveActorCombat(actor) {
  if (!actor) return null;
  // Match by token first (a synthetic/unlinked token actor carries its token),
  // so the right combatant is found even when several tokens share a base actor.
  const tokenId = actor.token?.id ?? null;
  const sceneId = canvas?.scene?.id ?? null;
  return (game?.combats?.contents ?? []).find(c =>
    c.started &&
    (c.scene?.id == null || c.scene.id === sceneId) &&
    c.combatants?.some(cb =>
      (tokenId && cb.tokenId === tokenId) || (cb.actorId ?? cb.actor?.id) === actor.id)
  ) ?? null;
}

/* True when `actor` is a combatant of the current-scene started combat.
 * Action-economy auto-spend (attack / cast / draw) gates on this so slots are
 * only consumed during the live encounter. See `resolveActorCombat` for why
 * this no longer reads `game.combat`. */
export function isActorInActiveCombat(actor) {
  return !!resolveActorCombat(actor);
}

const NULL_POOL = { cur: 0, max: 0, frac: 0 };

function safe(getter, fallback) {
  try { const v = getter(); return (v === undefined || v === null) ? fallback : v; }
  catch { return fallback; }
}

function pool(cur, max) {
  cur = Number(cur) || 0;
  max = Number(max) || 0;
  return { cur, max, frac: max > 0 ? Math.max(0, Math.min(1, cur / max)) : 0 };
}

/* HP pool with a temp-HP "shield" buffer folded in. Temp blends into the
 * displayed numbers (cur = value+temp, max = realMax+temp) so the readout and
 * sawtooth read as one bar, but the segments stay separate: amber `realFrac`
 * for real HP, frost `tempFrac` for the shield sitting contiguous after it.
 * `realCur`/`realMax` are kept raw for severity (wounds key off real HP, not
 * the shield). Denominator is (realMax + temp). */
/* STA pool with the temp-STA "shield" buffer folded in, mirroring hpPool (but
 * without the negative/dying semantics — STA never goes below 0). Temp blends
 * into the displayed numbers (cur = value+temp, max = realMax+temp) so the
 * readout + sawtooth read as one bar, with amber `realFrac` for real STA and
 * frost `tempFrac` for the buffer sitting contiguous after it. */
function staPool(value, max, temp) {
  const cur  = Math.max(0, Number(value) || 0);
  max  = Math.max(0, Number(max)  || 0);
  temp = Math.max(0, Number(temp) || 0);
  const den   = (max + temp) || 1;
  const clamp = (n) => Math.max(0, Math.min(1, n));
  return {
    cur:      cur + temp,
    max:      max + temp,
    temp,
    hasTemp:  temp > 0,
    realCur:  cur,
    realMax:  max,
    frac:     clamp((cur + temp) / den),
    realFrac: clamp(Math.min(cur, max) / den),
    tempFrac: clamp(temp / den)
  };
}

function hpPool(value, max, temp) {
  // Real HP may go NEGATIVE (a dying character below 0) — keep the raw value for
  // the displayed number and for severity, and use a clamped copy ONLY for the
  // bar-fill geometry (a negative bar is just empty). Clamping the displayed
  // value was hiding negative current health in the chrome/dock readouts.
  const raw     = Number(value) || 0;
  const clamped = Math.max(0, raw);
  max   = Math.max(0, Number(max)   || 0);
  temp  = Math.max(0, Number(temp)  || 0);
  const den   = (max + temp) || 1;
  const clamp = (n) => Math.max(0, Math.min(1, n));
  return {
    cur:      raw + temp,        // displayed current HP — negative shows through
    max:      max + temp,
    temp,
    hasTemp:  temp > 0,
    realCur:  raw,               // raw real HP for severity (dying at <= 0)
    realMax:  max,
    frac:     clamp((clamped + temp) / den),
    realFrac: clamp(Math.min(clamped, max) / den),
    tempFrac: clamp(temp / den)
  };
}

export function getDockData(actor) {
  if (!actor) {
    return {
      name: t("WITCHER.Chrome.Lib.Actor.Text.NoCharacterAssigned", "— no character assigned —"),
      profession: "",
      race: "",
      medallion: "",
      hp:  { ...NULL_POOL },
      sta: { ...NULL_POOL },
      tox: { ...NULL_POOL },
      adrenaline: { cur: 0, max: 3 },
      stress:     { cur: 0, max: 0 },
      satiety:    null,
      shield:     { cur: 0, max: 0 },
      vigor:      0,
      combatRound: null
    };
  }

  const s = actor.system ?? {};
  const isMonster = actor.type === "monster";

  // Identity — Profession and Race are EMBEDDED ITEMS on the actor
  // (system.items of type "profession" / "race"), not raw string fields.
  // Monsters: no profession; "race" line shows the monster's category
  // (necrophage, beast, elementa, ...) and the medallion uses the actor
  // portrait so the dock has an identifying face.
  const name       = actor.name ?? "—";
  const profItem   = isMonster ? null : safe(() => actor.items?.find(i => i.type === "profession"), null);
  const raceItem   = isMonster ? null : safe(() => actor.items?.find(i => i.type === "race"), null);
  const profession = safe(() => String(profItem?.name ?? ""), "");
  const race       = isMonster
      ? safe(() => String(s.category ?? ""), "")
      : safe(() => String(raceItem?.name ?? ""), "");
  // Medallion icon is linked to the PROFESSION item (system.medallionIcon).
  // No profession, or none set → empty, and the dock hides the medallion.
  // Monsters: fall back to actor.img so the dock's central portrait isn't blank.
  const medallion  = isMonster
      ? safe(() => String(actor.img ?? ""), "")
      : safe(() => String(profItem?.system?.medallionIcon ?? ""), "");

  // Pools — Witcher TRPG schema:
  //   derivedStats.{hp,sta}.{value,max}    primary pools
  //   stats.toxicity.{value,max}           alchemical buildup (default max 100)
  const hpCur  = safe(() => s.derivedStats?.hp?.value, 0);
  const hpMax  = safe(() => s.derivedStats?.hp?.max, 0);
  const hpTemp = safe(() => s.derivedStats?.hp?.temp, 0);
  const staCur  = safe(() => s.derivedStats?.sta?.value, 0);
  const staMax  = safe(() => s.derivedStats?.sta?.max, 0);
  const staTemp = safe(() => s.derivedStats?.sta?.temp, 0);
  const toxCur = safe(() => s.stats?.toxicity?.value, 0);
  const toxMax = safe(() => s.stats?.toxicity?.max, 0);

  // Counters
  //   adrenaline           system.adrenaline.value           (max = body stat)
  //   stress (homebrew)    system.stress; max = will. Only present when the
  //                        "stress" homebrew toggle is enabled — otherwise the
  //                        dock/topbar must not show the tracker at all.
  //   shield (Quen)        system.derivedStats.shield            (single number, no max — schema Phase 13)
  const adrOn  = safe(() => isAdrenalineEnabled(), true);
  const adrCur = safe(() => s.adrenaline?.value, 0);
  const adrMax = safe(() => Number(s.stats?.body?.value) || 0, 0);
  const stressOn = safe(() => game.system?.api?.homebrew?.isEnabled?.("stress"), false);
  const strCur = safe(() => Number(s.stress) || 0, 0);
  const strMax = safe(() => s.stats?.will?.value, 0);
  // Satiety (homebrew food & drink). Range is BODY-scaled: MAX = drain × 24
  // (roughly one day of BMR), FLOOR = -MAX. Editable BY THE GM ONLY. Tier is
  // derived from satiety as a percentage of the actor's personal max.
  const fdOn   = safe(() => game.system?.api?.homebrew?.isEnabled?.("foodAndDrink"), false);
  const satCur = safe(() => Number(s.satiety) || 0, 0);
  const satTier = safe(() => game.system?.api?.mechanics?.foodAndDrink?.tierForSatiety?.(satCur, actor) ?? "", "");
  const shdCur = safe(() => Number(s.derivedStats?.shield) || 0, 0);
  const shdMax = shdCur; // single-number stat; renderer uses (cur, max) shape so mirror it

  // Investigation Focus pool (A Witcher's Journal p.145): real pool with a
  // derived max ⌊(WILL+INT)/2⌋×3; value player-set, drained by Evidence checks.
  const focCur = safe(() => Number(s.derivedStats?.focus?.value) || 0, 0);
  const focMax = safe(() => Number(s.derivedStats?.focus?.max) || 0, 0);

  // Vigor — single static threshold (Core p.38). Must live in the dock data so
  // it joins the rebind signature; otherwise a vigor-only edit produces an
  // unchanged sig and the dock skips the rebind (stale until F5). Legacy
  // {value,max} world data falls through until the first save rewrites it.
  const vigRaw = safe(() => s.derivedStats?.vigor, 0);
  const vigor  = (typeof vigRaw === "number" ? vigRaw : (vigRaw?.max ?? vigRaw?.value ?? 0)) || 0;

  // Round Chaos — magic STA poured into spells so far this combat round
  // (castSpellMixin's `chaosRound` flag). Drives the segmented vigor bar's
  // depletion. Zero out of combat or when the flag is from an older round, so
  // the bar reads full. Composite `${combatId}:${round}` key so a flag from a
  // PRIOR combat with a matching round number doesn't bleed into this one
  // (was making vigor read as depleted on the matching round of a new combat).
  const vigorSpent = safe(() => {
    const combat = game.combat;
    if (!combat?.started) return 0;
    const roundKey = `${combat.id}:${combat.round}`;
    const f = actor.getFlag?.("witcher-ttrpg-death-march", "chaosRound") ?? {};
    return f.round === roundKey ? (Number(f.spent) || 0) : 0;
  }, 0);

  // Combat round budget (Core p.151-152). Folded into the dock data so a
  // movement/action/extra/defense change joins the rebind signature and the
  // slot pills repaint live. SPD rides along for the movement prompt default.
  const cr  = s.combatRound ?? {};
  const spd = safe(() => Number(s.stats?.spd?.value) || 0, 0);
  /* Witchers Reborn — Viper · Lightning Fast: the rolled Nd6 bonus (in
   * meters) is stamped on flags.wr.lightningFastBonus by
   * wrHeroic.lightningFast and cleared on turn end by
   * combatRoundMixin.resetCombatRound. Ridden along here so the dock's
   * Movement pill shows the extended cap live once the heroic is
   * invoked. */
  const lightningFastBonus = safe(() =>
    Number(actor?.flags?.["witcher-ttrpg-death-march"]?.wr?.lightningFastBonus) || 0, 0);
  const combatRound = {
    movementUsed:    !!cr.movementUsed,
    movementMeters:  Number(cr.movementMeters) || 0,
    actionUsed:      !!cr.actionUsed,
    actionLabel:     String(cr.actionLabel ?? ""),
    extraUsed:       !!cr.extraUsed,
    extraLabel:      String(cr.extraLabel ?? ""),
    fullRound:       !!cr.fullRound,
    fullRoundLabel:  String(cr.fullRoundLabel ?? ""),
    /* Run (full-round action) triples the movement cap to SPD×3 and locks
     * normal/extra actions. The dock surfaces this as a "spent/cap" string
     * on the Movement slot — `runUsed` flips the cap multiplier from 1 to 3. */
    runUsed:         !!cr.runUsed,
    defenseCount:    Number(cr.defenseCount) || 0,
    activelyDodging: !!cr.activelyDodging,
    spd,
    lightningFastBonus
  };

  return {
    name, profession, race, medallion,
    hp:  hpPool(hpCur, hpMax, hpTemp),
    sta: staPool(staCur, staMax, staTemp),
    tox: pool(toxCur, toxMax),
    adrenaline: adrOn ? { cur: Number(adrCur) || 0, max: adrMax } : null,
    stress:     stressOn ? { cur: Number(strCur) || 0, max: Number(strMax) || 0 } : null,
    satiety:    fdOn ? (() => {
      const fd = safe(() => game.system?.api?.mechanics?.foodAndDrink, null);
      const max       = safe(() => fd?.getSatietyCeil?.(actor)       ?? 125, 125);
      const gorgedMax = safe(() => fd?.getSatietyGorgedCeil?.(actor) ?? Math.floor(max * 1.25), Math.floor(max * 1.25));
      const min       = safe(() => fd?.getSatietyFloor?.(actor)      ?? -max, -max);
      let fillPct = 0;
      if (max > 0) fillPct = Math.max(0, Math.min(100, Math.round((satCur / max) * 100)));
      let overflowPct = 0;
      if (satCur > max && gorgedMax > max) {
        overflowPct = Math.max(0, Math.min(100, Math.round(((satCur - max) / (gorgedMax - max)) * 100)));
      }
      // Single unified color across all tiers — the tier is communicated
      // by the fill LEVEL inside the stomach glyph + the tier name, not by
      // a color shift. Tier name comes from the shared, localized
      // `tierDisplayName` helper so all three pill implementations (chrome
      // here, actor sheet, dialog) read from the same string source.
      const UNIFIED_COLOR = "#b89464"; // matches --wdm-amber-hi
      const tierLabel = safe(() => game.system?.api?.mechanics?.foodAndDrink?.tierDisplayName?.(satTier), null) || satTier || "Fed";
      return { cur: satCur, tier: satTier, tierLabel, tierColor: UNIFIED_COLOR, max, gorgedMax, min, fillPct, overflowPct };
    })() : null,
    shield:     { cur: Number(shdCur) || 0, max: Number(shdMax) || 0 },
    focus:      { cur: Number(focCur) || 0, max: Number(focMax) || 0 },
    vigor,
    vigorSpent,
    combatRound
  };
}
