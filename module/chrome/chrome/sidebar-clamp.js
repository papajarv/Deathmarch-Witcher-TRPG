/**
 * Sidebar vertical clamp.
 *
 * The sidebar's bottom edge should butt cleanly against the top of #wou-dock
 * regardless of peace / combat mode. The dock's height varies per mode and
 * also flexes with content, so static values (160 / 230) drift in both
 * directions. Measure the dock directly and publish a single CSS variable
 * `--wdm-sidebar-bottom-clamp` that sidebar.css consumes.
 *
 * Uses ResizeObserver on #wou-dock so any height change (combat transition,
 * adrenaline counter rendering, custom content) flows through automatically.
 */

let _observer = null;

function publish() {
  const dock = document.getElementById("wou-dock");
  if (!dock) return;
  const h = dock.getBoundingClientRect().height;
  if (h <= 0) return;
  /* Dock's box top = visible top edge of the dock. Combat content that
     "overflows above" the dock box is INSIDE the sidebar's vertical range
     either way — we just need the icon strip to actually fit (sized in CSS),
     not the clamp to swallow more vertical space. */
  document.documentElement.style.setProperty("--wdm-sidebar-bottom-clamp", `${h}px`);
  document.body.dataset.wouSidebarClamp = `${Math.round(h)}px`;
}

let _pollId = null;
function publishBurst() {
  publish();
  /* The encounter transition animates .identity-combat in over ~350ms.
     Poll a few frames after the trigger so we catch the steady state once
     the animation settles. Cheap. */
  if (_pollId) clearInterval(_pollId);
  let count = 0;
  _pollId = setInterval(() => {
    publish();
    if (++count >= 8) {
      clearInterval(_pollId);
      _pollId = null;
    }
  }, 60);
}

export function wireSidebarClamp() {
  if (_observer) return;

  // Initial publish — fire several times because the dock's final height
  // settles after fonts load + after the bottom-strip painter resolves the
  // first repaint. Cheap to over-fire.
  publish();
  requestAnimationFrame(publish);
  setTimeout(publish, 100);
  setTimeout(publish, 500);
  setTimeout(publish, 1500);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(publish);

  const dock = document.getElementById("wou-dock");
  if (dock && "ResizeObserver" in window) {
    _observer = new ResizeObserver(() => publish());
    _observer.observe(dock);
  }
  window.addEventListener("resize", publish, { passive: true });

  // Combat hooks — every signal that might toggle the dock's combat layout.
  for (const hook of ["createCombat", "deleteCombat", "updateCombat", "combatStart", "combatTurn", "combatRound"]) {
    Hooks.on(hook, publishBurst);
  }
  // The body class transition is the actual visual switch — observe directly.
  if ("MutationObserver" in window) {
    new MutationObserver(publishBurst).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  }
  // Animation-end + transition-end on body and dock (the combat-in keyframe
  // settles after ~350ms, the leaving fade after ~350ms).
  document.body.addEventListener("transitionend", publish, { passive: true });
  document.body.addEventListener("animationend", publish, { passive: true });
}
