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

const { bgraToGray, cropGray } = require('./gray');

const FOCUS_THUMB = { width: 960, height: 540 };   // finer grab, only used while a pointer is on screen
const CROP = { w: 192, h: 108 };                   // window around the pointer (about 20% of the screen each way)

/**
 * 32×18 grayscale sample for the screen-change watcher (576 values, 0–255).
 * `focus` = [{fx, fy}] fractions of the display (where the pointer is). When given, the same grab also yields a
 * fine grayscale crop around each point, so small changes there (a toolbar highlight, a few typed letters) are visible.
 */
async function sampleGray(display, focus = []) {
  const fine = focus.length > 0;
  const src = await findSource(display, fine ? FOCUS_THUMB : { width: HASH_W * 4, height: HASH_H * 4 });
  const thumb = src.thumbnail;
  const small = thumb.resize({ width: HASH_W, height: HASH_H, quality: 'good' });
  const gray = Array.from(bgraToGray(small.toBitmap(), HASH_W * HASH_H));
  const crops = [];
  if (fine) {
    const { width: tw, height: th } = thumb.getSize();
    const buf = thumb.toBitmap();
    for (const f of focus) crops.push(cropGray(buf, tw, th, f.fx, f.fy, CROP.w, CROP.h));
  }
  return { w: HASH_W, h: HASH_H, gray, crops };
}

module.exports = { captureDisplay, sampleGray, HASH_W, HASH_H };
