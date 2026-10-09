'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseModelPoint, mapModelPoint } = require('../src/main/coords');

test('parses y-first [y, x]', () => {
  assert.deepEqual(parseModelPoint([250, 750]), { y: 250, x: 750 });
  assert.deepEqual(parseModelPoint('[100, 900]'), { y: 100, x: 900 });
  assert.deepEqual(parseModelPoint({ point: [10, 20] }), { y: 10, x: 20 });
  assert.deepEqual(parseModelPoint({ y: 5, x: 6 }), { y: 5, x: 6 });
  assert.equal(parseModelPoint([]), null);
  assert.equal(parseModelPoint(null), null);
  assert.deepEqual(parseModelPoint([-5, 1200]), { y: 0, x: 1000 }); // clamped
});

test('1x display: 0–1000 → px → points', () => {
  const m = mapModelPoint([500, 250], { width: 1920, height: 1080 }, { x: 0, y: 0, width: 1920, height: 1080 });
  assert.deepEqual(m.screenshotPx, { x: 480, y: 540 });
  assert.deepEqual(m.local, { x: 480, y: 540 });
});

test('HiDPI 2x (Retina): screenshot px are halved to points', () => {
  const m = mapModelPoint([100, 900], { width: 2880, height: 1800 }, { x: 0, y: 0, width: 1440, height: 900 });
  assert.deepEqual(m.screenshotPx, { x: 2592, y: 180 });
  assert.deepEqual(m.local, { x: 1296, y: 90 });
});

test('Windows 125% scaling + secondary monitor offset', () => {
  // 2560x1440 physical @125% = 2048x1152 points, display placed right of a 1920 primary
  const m = mapModelPoint([1000, 1000], { width: 2560, height: 1440 }, { x: 1920, y: 0, width: 2048, height: 1152 });
  assert.deepEqual(m.local, { x: 2048, y: 1152 });
  assert.deepEqual(m.global, { x: 3968, y: 1152 });
});

test('y-first is respected (not swapped)', () => {
  const m = mapModelPoint([0, 1000], { width: 1000, height: 500 }, { x: 0, y: 0, width: 1000, height: 500 });
  assert.deepEqual(m.local, { x: 1000, y: 0 }); // top-right
});
