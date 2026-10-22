'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { bgraToGray, cropGray } = require('../src/main/gray');

function bitmap(w, h, fn) {                         // BGRA
  const b = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = fn(x, y); const i = (y * w + x) * 4; b[i] = v; b[i + 1] = v; b[i + 2] = v; b[i + 3] = 255; }
  return b;
}

test('bgraToGray: white=255, black=0, mid grey stays', () => {
  const g = bgraToGray(bitmap(3, 1, (x) => [255, 0, 128][x]), 3);
  assert.deepEqual([...g], [255, 0, 128]);
});

test('cropGray: window is centred on the fractional point and sees the right pixels', () => {
  const buf = bitmap(100, 50, (x, y) => (x === 60 && y === 25 ? 0 : 255));
  const c = cropGray(buf, 100, 50, 0.6, 0.5, 20, 10);
  assert.deepEqual([c.x0, c.y0, c.w, c.h], [50, 20, 20, 10]);
  assert.equal(c.gray[(25 - 20) * 20 + (60 - 50)], 0);
  assert.equal(c.gray.filter((v) => v === 0).length, 1);
});

test('cropGray: clamps at the edges and never exceeds the image', () => {
  const buf = bitmap(100, 50, () => 200);
  const tl = cropGray(buf, 100, 50, 0, 0, 20, 10), br = cropGray(buf, 100, 50, 1, 1, 20, 10);
  assert.deepEqual([tl.x0, tl.y0], [0, 0]);
  assert.deepEqual([br.x0, br.y0], [80, 40]);
  const small = cropGray(bitmap(8, 4, () => 1), 8, 4, 0.5, 0.5, 20, 10);
  assert.deepEqual([small.w, small.h], [8, 4]);
});
