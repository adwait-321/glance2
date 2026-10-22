'use strict';
/**
 * Overlay alignment helpers (kept separate from coords.js — the normalization maths is NOT touched).
 *
 * The mapper assumes the overlay window sits exactly on the display, so `local = global - display.origin`.
 * If the OS places the window elsewhere (Windows mixed-DPI setBounds quirk, display change, taskbar), every
 * pointer is off by that difference. We keep `global` (where the element really is on the desktop) and
 * recompute `local` against where the window ACTUALLY is.
 */
const sameRect = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** ptr = result of mapModelPoint (or null). Returns a copy whose `local` is relative to the real overlay origin. */
function alignToOverlay(ptr, overlayBounds) {
  if (!ptr || !overlayBounds) return ptr;
  return { ...ptr, local: { x: ptr.global.x - overlayBounds.x, y: ptr.global.y - overlayBounds.y } };
}

module.exports = { sameRect, alignToOverlay };
