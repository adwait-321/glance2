'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/renderer/phash');

const W = 32, H = 18;
const flat = (v) => new Array(W * H).fill(v);
function withRect(base, x0, y0, w, h, v) {
  const a = base.slice();
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) a[y * W + x] = v;
  return a;
}

test('identical screens → no change', () => {
  const a = withRect(flat(40), 0, 0, 32, 2, 200);
  assert.equal(P.compare(a, a.slice()).changed, false);
});

test('tiny noise (clock tick, 1 cell) → no change', () => {
  const a = withRect(flat(40), 0, 0, 32, 2, 200);
  const b = withRect(a, 30, 0, 1, 1, 120);
  assert.equal(P.compare(a, b).changed, false);
});

test('menu / dropdown opens (~5x3 cells) → change', () => {
  const a = flat(40);
  const b = withRect(a, 4, 3, 5, 3, 230);
  assert.equal(P.compare(a, b).changed, true);
});

test('new window / page → change', () => {
  const a = flat(40);
  const b = withRect(a, 0, 0, 32, 18, 220);
  assert.equal(P.compare(a, b).changed, true);
});

test('mask hides our own overlay (panel region) from the watcher', () => {
  const a = flat(40);
  const b = withRect(a, 20, 10, 12, 8, 230);               // bottom-right area changes (our panel)
  const mask = P.maskFromRects([{ left: 1200, top: 600, width: 720, height: 480 }], 1920, 1080);
  assert.equal(P.compare(a, b).changed, true);
  assert.equal(P.compare(a, b, { mask }).changed, false);
});
