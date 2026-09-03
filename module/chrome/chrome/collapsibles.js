/**
 * Collapsible edge bars.
 *
 * Three chrome edges (top, left, right) share the same UX:
 *   - hidden by default off-screen
 *   - cursor near the edge → glow + peek out a small amount
 *   - click while peeking (or any open-trigger) → cascade fully open
 *   - click outside / Esc → collapse again
 *
 * Per-edge behaviour is tuned via options:
 *   - skipPeek            don't apply the `is-peeking` class at all
 *   - closeOnOutsideClick collapse when the user clicks outside the bar
 *   - closeOnEsc          collapse on Esc
 *   - onOpen / onClose    callbacks fired on state transitions
 *
 * The SIDEBAR uses skipPeek:true + closeOnOutsideClick:false + closeOnEsc:false
 * because the user wants it fully hidden, glow-only on hover, and closed
 * exclusively via Foundry's native arrow.
 *
 * `setEntryOpen` lets external observers (Foundry hooks) drive our state
 * from outside without re-firing the callbacks.
 */

const PEEK_THRESHOLD_PX = 14;   // distance from edge that triggers peek

const REGISTRY = [];

/** Register one collapsible. `edge` ∈ "top" | "left" | "right". */
export function registerCollapsible(el, edge, opts = {}) {
  if (!el || REGISTRY.some(r => r.el === el)) return;
  el.classList.add("wou-collapse", `wou-collapse-${edge}`);
  const entry = {
    el, edge,
    onOpen:  opts.onOpen,
    onClose: opts.onClose,
    skipPeek:            opts.skipPeek            ?? false,
    closeOnOutsideClick: opts.closeOnOutsideClick ?? true,
    closeOnEsc:          opts.closeOnEsc          ?? true,
    suspendCallbacks: false
  };
  REGISTRY.push(entry);
  if (!entry.skipPeek) {
    el.addEventListener("click", () => onClickEntry(entry));
  }
  return entry;
}

/** Programmatically set open state. Pass `{silent:true}` to skip callbacks. */
export function setEntryOpen(el, isOpen, opts = { silent: false }) {
  const entry = REGISTRY.find(r => r.el === el);
  if (!entry) return;
  setOpen(entry, isOpen, opts.silent);
}

function setOpen(entry, isOpen, silent = false) {
  entry.suspendCallbacks = silent;
  if (isOpen) {
    entry.el.classList.remove("is-peeking");
    entry.el.classList.add("is-open");
    if (!silent) entry.onOpen?.();
  } else {
    entry.el.classList.remove("is-open");
    if (!silent) entry.onClose?.();
  }
  entry.suspendCallbacks = false;
}

function isInZone(edge, e) {
  switch (edge) {
    case "top":   return e.clientY <= PEEK_THRESHOLD_PX;
    case "left":  return e.clientX <= PEEK_THRESHOLD_PX;
    case "right": return e.clientX >= window.innerWidth - PEEK_THRESHOLD_PX;
  }
  return false;
}

function onClickEntry(entry) {
  if (entry.el.classList.contains("is-peeking")) {
    setOpen(entry, true);
  }
}

function onMouseMove(e) {
  for (const entry of REGISTRY) {
    if (entry.skipPeek) continue;
    if (entry.el.classList.contains("is-open")) continue;
    const inZone = isInZone(entry.edge, e);
    entry.el.classList.toggle("is-peeking", inZone);
  }
}

function onPointerDown(e) {
  for (const entry of REGISTRY) {
    if (!entry.closeOnOutsideClick) continue;
    if (!entry.el.classList.contains("is-open")) continue;
    if (!entry.el.contains(e.target)) {
      setOpen(entry, false);
    }
  }
}

function onKey(e) {
  if (e.key !== "Escape") return;
  for (const entry of REGISTRY) {
    if (!entry.closeOnEsc) continue;
    entry.el.classList.remove("is-peeking");
    if (entry.el.classList.contains("is-open")) setOpen(entry, false);
  }
}

let installed = false;
export function installGlobalListeners() {
  if (installed) return;
  installed = true;
  document.addEventListener("mousemove", onMouseMove, { passive: true });
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKey);
}
