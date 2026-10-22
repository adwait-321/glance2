'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWatcher } = require('../src/renderer/watcher');
const P = require('../src/renderer/phash');

const W = 32, H = 18;
const flat = (v) => new Array(W * H).fill(v);
function withRect(base, x0, y0, w, h, v) {
  const a = base.slice();
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) a[y * W + x] = v;
  return a;
}
const clock = () => { let t = 0; return { now: () => t, adv: (ms) => { t += ms; } }; };

test('menu opens → fires once the screen is quiet for 2 samples', () => {
  const c = clock(); const w = createWatcher({ now: c.now });
  const before = flat(40), after = withRect(before, 4, 3, 5, 3, 230);
  w.arm(before);
  assert.equal(w.tick(before).fire, false);          // nothing yet
  assert.equal(w.tick(after).fire, false);           // change seen, not settled
  assert.equal(w.tick(after).fire, false);           // 1 quiet sample
  const r = w.tick(after);                           // 2 quiet samples
  assert.equal(r.fire, true);
  assert.equal(r.reason, 'settled');
});

test('one-shot: after firing it stays silent until re-armed', () => {
  const c = clock(); const w = createWatcher({ now: c.now });
  const before = flat(40), after = withRect(before, 0, 0, 32, 18, 220);
  w.arm(before); w.tick(after); w.tick(after);
  assert.equal(w.tick(after).fire, true);
  assert.equal(w.isArmed(), false);
  assert.equal(w.tick(flat(10)).fire, false);
  w.arm(after);
  assert.equal(w.isArmed(), true);
});

test('disarm (API error) → never fires, even if the screen changes', () => {
  const w = createWatcher();
  w.arm(flat(40)); w.disarm();
  for (let i = 0; i < 6; i++) assert.equal(w.tick(withRect(flat(40), 0, 0, 32, 18, 220)).fire, false);
});

test('screen that never goes quiet (video / spinner) still fires after maxSettleMs', () => {
  const c = clock(); const w = createWatcher({ now: c.now, maxSettleMs: 8000 });
  const base = flat(40);
  w.arm(base);
  let n = 0, fired = null;
  for (let i = 0; i < 40 && !fired; i++) {
    c.adv(600);
    const frame = withRect(base, 0, 0, 32, 18, 60 + (i % 2) * 150);   // flickers every sample
    const r = w.tick(frame);
    if (r.fire) fired = r;
    n++;
  }
  assert.ok(fired, 'should fire');
  assert.equal(fired.reason, 'timeout');
  assert.ok(n * 600 >= 8000 && n * 600 <= 9600, `fired after ${n * 600}ms`);
});

test('clock-tick noise (1 cell) never triggers', () => {
  const w = createWatcher();
  const a = withRect(flat(40), 0, 0, 32, 2, 200);
  w.arm(a);
  for (let i = 0; i < 20; i++) assert.equal(w.tick(withRect(a, 30, 0, 1, 1, 120 + i)).fire, false);
});

test('the mask blind-spot: a 6-cell change under the pointer is invisible when masked, visible when not', () => {
  const before = flat(40), after = withRect(before, 10, 8, 3, 2, 230);       // e.g. a dialog/panel opening at the target
  const mask = P.maskFromRects([{ left: 560, top: 440, width: 240, height: 180 }], 1920, 1080);   // reticle neighbourhood
  const run = (m) => { const w = createWatcher(); w.arm(before); w.tick(after, m); w.tick(after, m); return w.tick(after, m).fire; };
  assert.equal(run(mask), false);   // old behaviour on Windows: never advances
  assert.equal(run(null), true);    // new behaviour on Windows: advances
});

// ── close-up check around the pointer (small changes the 32×18 grid cannot see) ──
const crop = (fill = 255, w = 192, h = 108) => ({ x0: 0, y0: 0, w, h, gray: new Uint8Array(w * h).fill(fill) });
function inkAt(c, n) {                                   // darken n pixels (e.g. a few typed letters)
  const g = c.gray.slice();
  for (let i = 0; i < n; i++) g[300 + i] = 30;
  return { ...c, gray: g };
}

test('tiny change at the pointer (typed text / toolbar highlight) fires although the coarse grid sees nothing', () => {
  const base = flat(200), blank = crop(), typed = inkAt(blank, 40);
  const w = createWatcher();
  w.arm(base, [blank]);
  assert.equal(w.tick(base, null, [blank]).fire, false);
  assert.equal(w.tick(base, null, [typed]).fire, false);       // seen once: could be a caret blink
  assert.equal(w.tick(base, null, [typed]).fire, false);       // persists -> "changed", settling starts
  assert.equal(w.tick(base, null, [typed]).fire, false);       // 1 quiet sample
  const r = w.tick(base, null, [typed]);                         // 2 quiet samples
  assert.equal(r.fire, true);
  assert.equal(r.reason, 'settled');
});

test('the same tiny change is invisible without the close-up crops (the old behaviour)', () => {
  const base = flat(200), w = createWatcher();
  w.arm(base);
  for (let i = 0; i < 8; i++) assert.equal(w.tick(base).fire, false);
});

test('a one-sample flicker near the pointer (caret blink) does not trigger', () => {
  const base = flat(200), blank = crop(), blink = inkAt(blank, 20);
  const w = createWatcher();
  w.arm(base, [blank]);
  for (let i = 0; i < 10; i++) assert.equal(w.tick(base, null, [i % 2 ? blink : blank]).fire, false);
});

test('while the user is still typing near the pointer it keeps waiting, then fires once they pause', () => {
  const base = flat(200), blank = crop();
  const w = createWatcher();
  w.arm(base, [blank]);
  let n = 10;
  w.tick(base, null, [inkAt(blank, n)]); w.tick(base, null, [inkAt(blank, n)]);      // change detected
  const fires = [];
  for (let i = 0; i < 4; i++) { n += 12; fires.push(w.tick(base, null, [inkAt(blank, n)]).fire); }   // typing continues
  assert.deepEqual(fires, [false, false, false, false]);
  w.tick(base, null, [inkAt(blank, n)]);                                              // pause: 1 quiet sample
  assert.equal(w.tick(base, null, [inkAt(blank, n)]).fire, true);                     // 2 quiet samples
});

test('mismatched crop counts (pointer moved between samples) are ignored safely', () => {
  const base = flat(200), w = createWatcher();
  w.arm(base, [crop()]);
  assert.equal(w.tick(base, null, [crop(), crop()]).fire, false);
});
