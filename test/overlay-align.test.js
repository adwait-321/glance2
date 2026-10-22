'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mapModelPoint } = require('../src/main/coords');
const { sameRect, alignToOverlay } = require('../src/main/overlay-align');

const imagePx = { width: 2880, height: 1800 };                 // 1920×1200 display at 150%
const display = { x: 0, y: 0, width: 1920, height: 1200 };

test('overlay exactly on the display → local is unchanged (mapper output is untouched)', () => {
  const p = mapModelPoint([500, 500], imagePx, display);
  assert.deepEqual(alignToOverlay(p, display).local, p.local);
  assert.deepEqual(p.local, { x: 960, y: 600 });
});

test('window landed 24px right / 40px down of the display → local shifts back so the pointer stays on the element', () => {
  const p = mapModelPoint([250, 750], imagePx, display);       // element at global (1440, 300)
  const a = alignToOverlay(p, { x: 24, y: 40, width: 1920, height: 1200 });
  assert.deepEqual(a.global, p.global);                          // where the element really is: unchanged
  assert.deepEqual(a.local, { x: 1416, y: 260 });
});

test('secondary monitor with negative origin', () => {
  const d2 = { x: -1920, y: 0, width: 1920, height: 1080 };
  const p = mapModelPoint([500, 500], { width: 1920, height: 1080 }, d2);
  assert.deepEqual(p.global, { x: -960, y: 540 });
  assert.deepEqual(alignToOverlay(p, d2).local, { x: 960, y: 540 });
});

test('null pointer / missing bounds pass straight through; sameRect compares all four fields', () => {
  assert.equal(alignToOverlay(null, display), null);
  const p = mapModelPoint([1, 1], imagePx, display);
  assert.equal(alignToOverlay(p, null), p);
  assert.equal(sameRect(display, { ...display }), true);
  assert.equal(sameRect(display, { ...display, height: 1199 }), false);
});
