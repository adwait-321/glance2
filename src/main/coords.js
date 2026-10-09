'use strict';
/**
 * Coordinate Mapper (Module 3)
 *
 * Gemini emits a point y-first on a 0–1000 grid:  [y, x]
 *
 *   Stage 1:  [y, x] (0–1000)      →  screenshot pixels   (rescale against TRUE capture size)
 *   Stage 2:  screenshot pixels    →  display points      (rescale pixels → DIP, add display origin)
 *
 * Screenshot pixels are physical pixels (display points × scaleFactor on HiDPI),
 * so going straight from 0–1000 to display points would only work by accident.
 * Keeping both stages explicit is what makes the reticle land on the element
 * at any resolution / DPI scaling.
 */

const GRID = 1000;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Accepts the model's point in any of the shapes it tends to emit and returns
 * { y, x } on the 0–1000 grid, or null when there is nothing to point at.
 *   [y, x] | {y, x} | {point:[y,x]} | "[y, x]"
 */
function parseModelPoint(raw) {
  if (raw == null) return null;
  let p = raw;
  if (typeof p === 'string') {
    try { p = JSON.parse(p); } catch { return null; }
  }
  if (p && !Array.isArray(p) && typeof p === 'object' && Array.isArray(p.point)) p = p.point;

  let y, x;
  if (Array.isArray(p)) {
    if (p.length < 2) return null;
    [y, x] = p;                      // y-first — Gemini native spatial format
  } else if (p && typeof p === 'object') {
    ({ y, x } = p);
  } else {
    return null;
  }
  y = Number(y); x = Number(x);
  if (!Number.isFinite(y) || !Number.isFinite(x)) return null;
  return { y: clamp(y, 0, GRID), x: clamp(x, 0, GRID) };
}

/** Stage 1: normalized [y,x] 0–1000 → screenshot pixel (x, y). */
function normalizedToScreenshotPx(norm, imagePx) {
  return {
    x: (norm.x / GRID) * imagePx.width,
    y: (norm.y / GRID) * imagePx.height,
  };
}

/**
 * Stage 2: screenshot pixel → display point.
 * Returns both the overlay-local point (what the overlay window draws at,
 * since the overlay covers exactly this display) and the global point.
 */
function screenshotPxToDisplay(px, imagePx, displayBounds) {
  const sx = displayBounds.width / imagePx.width;
  const sy = displayBounds.height / imagePx.height;
  const local = { x: px.x * sx, y: px.y * sy };
  return {
    local,
    global: { x: displayBounds.x + local.x, y: displayBounds.y + local.y },
  };
}

/** Full pipeline. Returns null when the model gave no usable point. */
function mapModelPoint(raw, imagePx, displayBounds) {
  const norm = parseModelPoint(raw);
  if (!norm) return null;
  if (!imagePx || !imagePx.width || !imagePx.height) throw new Error('mapModelPoint: invalid capture size');
  const screenshotPx = normalizedToScreenshotPx(norm, imagePx);
  const { local, global } = screenshotPxToDisplay(screenshotPx, imagePx, displayBounds);
  const r = (o) => ({ x: Math.round(o.x), y: Math.round(o.y) });
  return { normalized: norm, screenshotPx: r(screenshotPx), local: r(local), global: r(global) };
}

module.exports = { GRID, parseModelPoint, normalizedToScreenshotPx, screenshotPxToDisplay, mapModelPoint };
