/**
 * Lightweight perceptual hash for the screen-change watcher.
 * Input: 32×18 grayscale array (576 values, 0–255).
 *
 *  - aHash: 1 bit per cell (cell > mean)            → hamming distance
 *  - cellDiff: # of cells whose luminance moved > T  → catches local changes (menus, dialogs)
 *
 * Works both in the renderer (window.PHash) and in Node tests (module.exports).
 */
(function (root) {
  'use strict';

  function aHash(gray) {
    let sum = 0;
    for (let i = 0; i < gray.length; i++) sum += gray[i];
    const mean = sum / gray.length;
    const bits = new Uint8Array(gray.length);
    for (let i = 0; i < gray.length; i++) bits[i] = gray[i] > mean ? 1 : 0;
    return bits;
  }

  function hamming(a, b, mask) {
    let d = 0;
    for (let i = 0; i < a.length; i++) if (!(mask && mask[i]) && a[i] !== b[i]) d++;
    return d;
  }

  function cellDiff(a, b, threshold, mask) {
    const t = threshold == null ? 12 : threshold;
    let n = 0;
    for (let i = 0; i < a.length; i++) if (!(mask && mask[i]) && Math.abs(a[i] - b[i]) > t) n++;
    return n;
  }

  /**
   * Build a mask (1 = ignore) for cells covered by our own overlay UI
   * (panel, reticle) so Glance never reacts to itself.
   * rects are in CSS px of a viewport of size vw × vh.
   */
  function maskFromRects(rects, vw, vh, w, h) {
    const W = w || 32, H = h || 18;
    const m = new Uint8Array(W * H);
    const cw = vw / W, ch = vh / H;
    for (const r of rects) {
      if (!r || r.width <= 0 || r.height <= 0) continue;
      const x0 = Math.max(0, Math.floor(r.left / cw)), x1 = Math.min(W - 1, Math.floor((r.left + r.width) / cw));
      const y0 = Math.max(0, Math.floor(r.top / ch)), y1 = Math.min(H - 1, Math.floor((r.top + r.height) / ch));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m[y * W + x] = 1;
    }
    return m;
  }

  /** Compare two gray samples. opts.mask marks cells to ignore. */
  function compare(a, b, opts) {
    const o = Object.assign({ cellThreshold: 12, changedCells: 4, changedBits: 10, mask: null }, opts || {});
    const bits = hamming(aHash(a), aHash(b), o.mask);
    const cells = cellDiff(a, b, o.cellThreshold, o.mask);
    return { bits, cells, changed: cells >= o.changedCells || bits >= o.changedBits };
  }

  const api = { aHash, hamming, cellDiff, compare, maskFromRects };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PHash = api;
})(typeof self !== 'undefined' ? self : this);
