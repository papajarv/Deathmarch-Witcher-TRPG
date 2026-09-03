/**
 * Foundry v14 multi-level scene chooser bridge.
 *
 * Foundry renders the level chooser as #scene-navigation-levels inside
 * #scene-navigation. Our chrome.css hides all of #scene-navigation to
 * suppress the native scene picker, but that also swallows the level
 * chooser. We CAN'T just un-hide #scene-navigation-levels because:
 *   1. Its parent (#ui-middle) carries `transform: scale(var(--ui-scale))`,
 *      which establishes a containing block for position:fixed — so any
 *      fixed positioning on the descendant becomes effectively absolute
 *      relative to #ui-middle, landing in the wrong place.
 *   2. Even if we worked around that, #scene-controls sits at z-index
 *      9100 and would occlude anything we position at the left edge.
 *
 * Instead: keep #scene-navigation hidden, inject our own #wou-scene-levels
 * container at document.body root (outside every DM transform-scaled
 * ancestor), and mirror the level rows into it on renderSceneNavigation.
 * Clicks route to Scene#view({level}) directly.
 */

let containerEl = null;
let leftbarObserver = null;
let observedEl = null;

function ensureContainer() {
  if (containerEl && document.body.contains(containerEl)) return containerEl;
  containerEl = document.createElement("menu");
  containerEl.id = "wou-scene-levels";
  containerEl.setAttribute("role", "menu");
  document.body.appendChild(containerEl);
  return containerEl;
}

/* Publish the leftbar's current RIGHT-edge viewport pixel to
 * `--wdm-leftbar-right`, which the chooser CSS reads for its `left`
 * offset. Anchored positioning would be cleaner but this stays legible
 * and doesn't require the panel to be a DOM descendant of the leftbar
 * (which has overflow:hidden and grid-template-rows we don't want to
 * disturb). Safe to ResizeObserve because we write a DIFFERENT CSS var
 * than the leftbar consumes — no self-feedback loop (see the note in
 * chrome/sideedges.js about the earlier scene-controls observer).
 *
 * When the leftbar is translated OFF-SCREEN (collapsed via .wou-collapse-
 * left transform:translateX(-100%)), getBoundingClientRect().right goes
 * negative — we clamp to 0 so the chooser's `left: calc(var + gutter)`
 * doesn't push into negative territory. CSS separately hides the chooser
 * when the leftbar isn't `.is-open` (via :has()), so the clamp is
 * belt-and-braces for the moment between transition and visibility. */
function publishLeftbarRight() {
  const sc = document.getElementById("scene-controls");
  if (!sc) return;
  const right = Math.max(0, Math.round(sc.getBoundingClientRect().right));
  document.documentElement.style.setProperty("--wdm-leftbar-right", `${right}px`);
}

/* (Re)wire observers on the leftbar. Foundry re-renders SceneControls
 * as an AppV2, which replaces the #scene-controls element wholesale each
 * time — the old observer's target becomes detached and stops firing.
 * Re-checking element identity on each hook fire keeps the observer
 * pointed at the LIVE element.
 *
 * Two publish triggers, both terminal (no per-frame tracking — the
 * earlier rAF chain that mirrored the slide made the chooser stutter
 * because it was interpolating `left` values while the leftbar's own
 * transform was still mid-flight):
 *   - ResizeObserver: fires on layout size changes (tool-panel widens
 *     when switching to a wider control set). Not fired on transforms.
 *   - transitionend on `transform`: fires ONCE when the leftbar's
 *     slide-in / slide-out animation settles. The chooser reads the
 *     final `right` there and CSS-fades in at its resting position
 *     (see the opacity transition + delay in chrome.css — fade-in is
 *     delayed to land after the leftbar's slide completes; fade-out
 *     runs first so the chooser is invisible before the leftbar
 *     starts collapsing). */
function ensureLeftbarObserver() {
  const sc = document.getElementById("scene-controls");
  if (!sc) return;
  if (leftbarObserver && observedEl === sc) return;
  if (leftbarObserver) leftbarObserver.disconnect();
  leftbarObserver = new ResizeObserver(publishLeftbarRight);
  leftbarObserver.observe(sc);
  observedEl = sc;

  sc.addEventListener("transitionend", (ev) => {
    if (ev.propertyName === "transform") publishLeftbarRight();
  });

  publishLeftbarRight();
}

/* Startup polling: at init the leftbar might not be in the DOM yet, and
 * ResizeObserver won't fire for the initial layout pass on an element
 * that never resizes. Poll for the first ~2 seconds so the CSS var
 * lands quickly regardless of Foundry's render timing — same low-cost
 * pattern used by chrome/sideedges.js for its topstrip var. */
function scheduleInitialPolls() {
  let ticks = 0;
  const poll = setInterval(() => {
    ensureLeftbarObserver();
    if (++ticks >= 10) clearInterval(poll);
  }, 200);
}

function repaint() {
  const el = ensureContainer();
  const scene = canvas?.scene ?? game?.scenes?.viewed;
  const levels = scene?.availableLevels ? Array.from(scene.availableLevels) : [];
  if (!scene || levels.length < 2) {
    el.classList.remove("has-levels");
    el.replaceChildren();
    return;
  }
  const currentLevelId = canvas?.level?.id ?? null;
  /* Match Foundry's rendering order (reversed availableLevels — see
   * scene-navigation.mjs #prepareLevels), so higher floors appear at the
   * top of the panel. */
  const rows = levels.slice().reverse().map(level => {
    const li = document.createElement("li");
    li.className = "level-row";
    const btn = document.createElement("div");
    btn.className = `ui-control scene scene-level${level.id === currentLevelId ? " view" : ""}`;
    btn.dataset.sceneId = scene.id;
    btn.dataset.levelId = level.id;
    btn.setAttribute("role", "menuitem");
    btn.setAttribute("tabindex", "0");
    const label = document.createElement("span");
    label.className = "ellipsis";
    label.textContent = level.name ?? level.id;
    btn.appendChild(label);
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (level.id === currentLevelId) return;
      try { scene.view({ level: level.id }); } catch (err) { console.warn("witcher-ttrpg-death-march | scene.view(level) failed", err); }
    });
    li.appendChild(btn);
    return li;
  });
  el.replaceChildren(...rows);
  el.classList.add("has-levels");
}

export function registerSceneLevelsBridge() {
  /* Container lazy-created on first repaint (renderSceneNavigation fires
   * after document.body is populated, so we don't need to guard init
   * against a missing body). */
  Hooks.on("renderSceneNavigation", repaint);
  /* Level activation goes via canvas.view which doesn't necessarily
   * refire renderSceneNavigation; canvasReady catches the new level
   * being active so our .view highlight stays in sync. */
  Hooks.on("canvasReady", () => { repaint(); ensureLeftbarObserver(); });
  /* Multi-level scenes get created/edited via the scene config sheet;
   * updateScene fires on both add-level and rename-level, refresh so
   * new/changed rows land immediately. */
  Hooks.on("updateScene", (scene) => {
    if (scene?.id === (canvas?.scene?.id ?? game?.scenes?.viewed?.id)) repaint();
  });
  /* Leftbar element gets recreated on each SceneControls re-render, so
   * re-attach the ResizeObserver each fire. Also publish immediately
   * — Foundry's initial renderSceneControls happens BEFORE the leftbar
   * has finished sizing in some window widths, and the observer's own
   * first-firing suffices only when sizing changes AFTER hookup. */
  Hooks.on("renderSceneControls", () => { ensureLeftbarObserver(); publishLeftbarRight(); });
  Hooks.on("ready", () => { ensureLeftbarObserver(); publishLeftbarRight(); });
  scheduleInitialPolls();
}
