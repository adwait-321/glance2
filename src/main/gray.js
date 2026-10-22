'use strict';
/** Pure pixel helpers for screen sampling (no Electron), so they can be unit-tested. */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** BGRA bitmap (Electron's toBitmap order) -> luminance. */
function bgraToGray(buf, count) {
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) out[i] = Math.round(0.299 * buf[i * 4 + 2] + 0.587 * buf[i * 4 + 1] + 0.114 * buf[i * 4]);
  return out;
}

/**
 * Grayscale window of a BGRA bitmap (tw x th) centred on the fractional point (fx, fy), clamped inside the image.
 * Used to look closely at the spot the pointer is on; the same fractions give the same window on every sample.
 */
function cropGray(buf, tw, th, fx, fy, cropW, cropH) {
  const w = Math.min(cropW, tw), h = Math.min(cropH, th);
  const x0 = clamp(Math.round(fx * tw - w / 2), 0, tw - w);
  const y0 = clamp(Math.round(fy * th - h / 2), 0, th - h);
  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let i = ((y0 + y) * tw + x0) * 4;
    for (let x = 0; x < w; x++, i += 4) gray[y * w + x] = Math.round(0.299 * buf[i + 2] + 0.587 * buf[i + 1] + 0.114 * buf[i]);
  }
  return { x0, y0, w, h, gray };
}

module.exports = { bgraToGray, cropGray, clamp };
