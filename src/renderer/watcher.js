/**
 * Screen-change watcher state machine (the "auto-advance" trigger).
 *
 *   arm(gray)        → remember the screen the user was just shown a step for
 *   tick(gray, mask) → feed a new 32×18 sample; returns { fire } when the screen has CHANGED and then SETTLED
 *   disarm()         → stop firing (API error, new session, …) until arm() is called again
 *
 * Why it is its own file: it used to live inside renderer.js, where none of this could be tested.
 * Works both in the renderer (window.Watcher) and in Node tests (module.exports).
 */
(function (root) {
  'use strict';
  const PH = typeof module !== 'undefined' && module.exports && typeof require === 'function' ? require('./phash') : root.PHash;

  function createWatcher(opts) {
    const o = Object.assign({
      settleSamples: 2,        // consecutive "quiet" samples needed after a change
      maxSettleMs: 8000,       // …but never wait longer than this (video / spinner / animated banner never go quiet)
      pixelThreshold: 24,      // fine crop: a pixel counts as changed above this luminance move
      focusPx: 12,             // fine crop: this many changed pixels near the pointer = "something happened there"
      focusPersist: 2,         // …and it must still be there on this many consecutive samples (ignores a blinking caret)
      focusSettlePx: 6,        // while settling, this much movement near the pointer means "still typing / animating"
      now: () => Date.now(),
    }, opts || {});

    let baseline = null, prev = null, changed = false, stable = 0, changedAt = 0;
    let baseCrops = null, prevCrops = null, localHits = 0;

    function reset(gray, crops) {
      baseline = gray || null; prev = gray || null; changed = false; stable = 0; changedAt = 0;
      baseCrops = crops && crops.length ? crops : null; prevCrops = baseCrops; localHits = 0;
    }

    const maxDiff = (as, bs, thr) => {
      let m = 0;
      for (let i = 0; i < as.length; i++) m = Math.max(m, PH.pixelDiff(as[i].gray, bs[i].gray, thr));
      return m;
    };

    return {
      arm(gray, crops) { reset(gray, crops); },
      disarm() { reset(null); },
      isArmed() { return !!baseline; },
      isChanged() { return changed; },

      /**
       * @param gray  32×18 sample · @param mask cells to ignore · @param crops fine crops around the pointer (optional)
       * @returns {{fire:boolean, reason?:'settled'|'timeout', changed:boolean, cells:number, bits:number, local:number}}
       */
      tick(gray, mask, crops) {
        if (!baseline) return { fire: false, changed: false, cells: 0, bits: 0, local: 0 };
        const c = crops && baseCrops && crops.length === baseCrops.length ? crops : null;
        let d, reason = null, local = 0;
        if (!changed) {
          d = PH.compare(baseline, gray, { mask });
          if (c) local = maxDiff(baseCrops, c, o.pixelThreshold);
          localHits = local >= o.focusPx ? localHits + 1 : 0;
          if (d.changed || localHits >= o.focusPersist) { changed = true; stable = 0; changedAt = o.now(); }
        } else {
          d = PH.compare(prev, gray, { changedCells: 2, changedBits: 6, mask });
          let moving = d.changed;
          if (c && prevCrops && prevCrops.length === c.length) {
            local = maxDiff(prevCrops, c, o.pixelThreshold);
            if (local >= o.focusSettlePx) moving = true;
          }
          stable = moving ? 0 : stable + 1;
          if (stable >= o.settleSamples) reason = 'settled';
          else if (o.now() - changedAt >= o.maxSettleMs) reason = 'timeout';
        }
        prev = gray;
        prevCrops = c;
        const out = { fire: !!reason, reason: reason || undefined, changed, cells: d.cells, bits: d.bits, local };
        if (reason) reset(null);            // one-shot: caller re-arms after it has fetched the next step
        return out;
      },
    };
  }

  const api = { createWatcher };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Watcher = api;
})(typeof self !== 'undefined' ? self : this);
