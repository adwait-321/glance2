'use strict';
/**
 * Capture (Module 1)
 * Grabs the screen at NATIVE pixel resolution and reports both
 *   - imagePx:       the screenshot's real pixel size
 *   - displayBounds: the display in points (DIP)
 * so the Coordinate Mapper can convert correctly.
 */
const { desktopCapturer, screen } = require('electron');

const HASH_W = 32;
const HASH_H = 18;

async function findSource(display, thumbnailSize) {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
  if (!sources.length) throw new Error('No screen sources available (screen-recording permission?)');
  const byId = sources.find((s) => s.display_id && String(s.display_id) === String(display.id));
  if (byId) return byId;
  // Some Linux setups leave display_id empty — fall back to display order.
  const idx = screen.getAllDisplays().findIndex((d) => d.id === display.id);
  return sources[idx] || sources[0];
}

/** Full-resolution capture of one display. */
async function captureDisplay(display) {
  const sf = display.scaleFactor || 1;
  const nativeSize = {
    width: Math.round(display.bounds.width * sf),
    height: Math.round(display.bounds.height * sf),
  };
  const src = await findSource(display, nativeSize);
  const image = src.thumbnail;
  if (image.isEmpty()) throw new Error('Screen capture returned an empty image (screen-recording permission?)');
  return {
    image,
    imagePx: image.getSize(),          // TRUE capture size — the mapper rescales against this
    displayBounds: { ...display.bounds },
    scaleFactor: sf,
  };
}

/**
 * Tiny 32×18 grayscale sample for the screen-change watcher.
 * Returns a plain array (IPC-friendly) of 576 luminance values 0–255.
 */
async function sampleGray(display) {
  const src = await findSource(display, { width: HASH_W * 4, height: HASH_H * 4 });
  const img = src.thumbnail.resize({ width: HASH_W, height: HASH_H, quality: 'good' });
  const buf = img.toBitmap(); // BGRA
  const out = new Array(HASH_W * HASH_H);
  for (let i = 0; i < out.length; i++) {
    const b = buf[i * 4], g = buf[i * 4 + 1], r = buf[i * 4 + 2];
    out[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return { w: HASH_W, h: HASH_H, gray: out };
}

module.exports = { captureDisplay, sampleGray, HASH_W, HASH_H };
