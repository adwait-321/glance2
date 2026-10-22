/**
 * Renderer (sandboxed): the pointer (click / drag / scroll / type / key guides), a single thin type bar,
 * the step loop with plan tracking, the screen-change watcher, and voice in/out.
 * Talks to the main process only through window.glance (preload bridge).
 */
(function () {
  'use strict';

  const api = window.glance;
  const $ = (s) => document.querySelector(s);

  const el = {
    bar: $('#bar'), dot: $('#dot'), input: $('#bar-input'), mic: $('#mic'),
    reticle: $('#reticle'), label: $('#reticle-label'),
    labelAction: $('#label-action'), labelHint: $('#label-hint'), labelText: $('#label-text'),
    scroll: $('#scroll-arrows'),
    dragLayer: $('#drag-layer'), dragLine: $('#drag-line'), dragBox: $('#drag-box'),
    dragEnd: $('#drag-end'), dragGhost: $('#drag-ghost'), calib: $('#calib'),
  };

  // ───────────── Config ─────────────
  const WATCH_INTERVAL_MS = 600;
  const SETTLE_SAMPLES = 2;
  const MAX_STEPS = 80;
  const WAIT_RECHECK_MS = 3500;
  const MAX_CONSECUTIVE_WAITS = 25;
  const DONE_POINTER_MS = 8000;
  const BAR_AVOID_PX = 90;          // keep the bar at least this far from anything we point at

  // The watcher must ignore our own overlay only where screen samples can contain it. On Windows the overlay is
  // excluded from capture, so masking would just blind the watcher around the very element the user must click.
  let maskOwnUi = true;             // safe default until main says otherwise
  let debugWatch = false;
  let focusOn = true;               // close-up change check around the pointer (Windows only; see maskOwnUi)
  const watcher = Watcher.createWatcher({ settleSamples: SETTLE_SAMPLES });

  const ACTION_LABEL = {
    click: '', double_click: 'Double-click', right_click: 'Right-click', hover: 'Hover',
    drag: 'Press & drag', scroll: 'Scroll', type: 'Type', key: 'Press',
  };

  let hotkeyText = 'Ctrl+Shift+G';
  const IDLE_PLACEHOLDER = () => `What do you want to do? (${hotkeyText})`;

  // ───────────── Session state ─────────────
  const S = {
    sessionId: null, goal: '', goalAudio: null, reuseFrom: null,
    history: [], plan: [], planIndex: 0,
    running: false, busy: false,
    lastStep: '', lastStatus: 'next', last: null, focus: [],
    waits: 0, waitTimer: null, doneTimer: null,
    listening: null, pointerVisible: false,
  };

  // ───────────── Click-through: only the bar takes the mouse, and only while hovered ─────────────
  let interactive = false;
  function setInteractive(on) {
    if (on === interactive) return;
    interactive = on;
    api.setInteractive(on);
  }
  document.addEventListener('mousemove', (e) => {
    setInteractive(!!(e.target && e.target.closest && e.target.closest('.interactive')));
  });
  document.addEventListener('mouseleave', () => setInteractive(false));

  // ───────────── Bar ─────────────
  function setBar(state, text) {
    el.dot.dataset.s = state;
    if (text !== undefined) {
      el.input.placeholder = text;
      el.bar.title = text;
    }
    el.bar.classList.toggle('running', S.running);
  }

  /** Move the bar to the other edge if it would cover anything we point at. */
  function placeBar(points) {
    const vh = window.innerHeight, vw = window.innerWidth;
    const w = el.bar.offsetWidth || 560;
    const x0 = (vw - w) / 2 - BAR_AVOID_PX, x1 = (vw + w) / 2 + BAR_AVOID_PX;
    const bottomBand = [vh - 72 - 34 - BAR_AVOID_PX, vh];
    const topBand = [0, 10 + 34 + BAR_AVOID_PX];
    const hits = (band) => points.some((p) => p && p.x >= x0 && p.x <= x1 && p.y >= band[0] && p.y <= band[1]);
    if (hits(bottomBand) && !hits(topBand)) el.bar.classList.add('top');
    else if (hits(topBand) && !hits(bottomBand)) el.bar.classList.remove('top');
    else if (!hits(bottomBand)) el.bar.classList.remove('top');
  }

  // ───────────── Pointer ─────────────
  let ghostRaf = 0;
  function stopGhost() { cancelAnimationFrame(ghostRaf); ghostRaf = 0; el.dragGhost.hidden = true; }

  function hideDrag() {
    el.dragLayer.hidden = true;
    el.dragEnd.hidden = true;
    stopGhost();
  }

  function showDrag(a, b, drawBox) {
    el.dragLine.setAttribute('x1', a.x); el.dragLine.setAttribute('y1', a.y);
    // stop the line short of the end ring so the arrow head sits on its edge
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    el.dragLine.setAttribute('x2', b.x - (dx / len) * 18); el.dragLine.setAttribute('y2', b.y - (dy / len) * 18);
    if (drawBox) {
      el.dragBox.setAttribute('x', Math.min(a.x, b.x)); el.dragBox.setAttribute('y', Math.min(a.y, b.y));
      el.dragBox.setAttribute('width', Math.abs(dx)); el.dragBox.setAttribute('height', Math.abs(dy));
      el.dragBox.style.display = '';
    } else {
      el.dragBox.style.display = 'none';
    }
    el.dragEnd.style.transform = `translate(${b.x}px, ${b.y}px)`;
    el.dragLayer.hidden = false;
    el.dragEnd.hidden = false;

    // ghost cursor: press (hold) → move → release (hold) → repeat
    stopGhost();
    el.dragGhost.hidden = false;
    const t0 = performance.now(), HOLD = 450, MOVE = 1300, CYCLE = HOLD + MOVE + HOLD + 300;
    const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
    const frame = (now) => {
      const t = (now - t0) % CYCLE;
      const k = t < HOLD ? 0 : t < HOLD + MOVE ? ease((t - HOLD) / MOVE) : 1;
      el.dragGhost.style.transform = `translate(${a.x + dx * k}px, ${a.y + dy * k}px) scale(${t < HOLD || (t > HOLD + MOVE && t < HOLD + MOVE + HOLD) ? 0.8 : 1})`;
      el.dragGhost.style.opacity = t > HOLD + MOVE + HOLD ? '0' : '1';
      ghostRaf = requestAnimationFrame(frame);
    };
    ghostRaf = requestAnimationFrame(frame);
  }

  function showPointer(res) {
    const p = res.pointer.local;
    el.reticle.style.transform = `translate(${p.x}px, ${p.y}px)`;
    el.reticle.dataset.a = res.action || 'click';

    // label: ACTION / hint / exact text or keys
    el.labelAction.textContent = ACTION_LABEL[res.action] || '';
    el.labelHint.textContent = res.hint || res.target || '';
    const exact = res.type_text || (res.action === 'key' ? res.keys : '');
    el.labelText.textContent = exact;
    el.labelText.hidden = !exact;
    el.label.hidden = !(el.labelAction.textContent || el.labelHint.textContent || exact);

    // scroll arrows
    el.scroll.hidden = res.action !== 'scroll';
    if (res.action === 'scroll') el.scroll.dataset.d = res.scroll || 'down';

    // drag guide
    const end = res.action === 'drag' && res.pointerEnd ? res.pointerEnd.local : null;
    if (end) {
      const drawBox = /draw|frame|rectangle|shape|marquee|select|box|size|crop/i.test(`${res.step} ${res.hint}`);
      showDrag(p, end, drawBox);
    } else {
      hideDrag();
    }

    // keep label on-screen and away from the drag path
    const goingRight = end ? end.x > p.x : false;
    el.label.classList.toggle('left', p.x > window.innerWidth - 360 || (goingRight && p.x > 380));
    el.label.classList.toggle('below', p.y < 80 || (end && end.y < p.y && p.y < window.innerHeight - 120));

    // where to look closely for small changes (toolbar highlight, a few typed letters)
    const vw = window.innerWidth || 1, vh = window.innerHeight || 1;
    S.focus = focusOn && !maskOwnUi ? [p, end].filter(Boolean).map((q) => ({ fx: q.x / vw, fy: q.y / vh })) : [];

    el.reticle.classList.remove('stale', 'done', 'pop');
    el.reticle.hidden = false;
    void el.reticle.offsetWidth;
    el.reticle.classList.add('pop');
    S.pointerVisible = true;
    placeBar([p, end]);
  }
  function setPointerStale(on) {
    el.reticle.classList.toggle('stale', !!on);
    el.dragLayer.style.opacity = on ? '.45' : '';
    el.dragEnd.style.opacity = on ? '.45' : '';
    el.dragGhost.style.visibility = on ? 'hidden' : '';
  }
  // ───────────── Calibration: do the mapped points land where they should? (no API call) ─────────────
  let calibTimer = 0;
  function hideCalib() { clearTimeout(calibTimer); el.calib.hidden = true; el.calib.textContent = ''; }
  async function runCalibration() {
    if (S.running) await stopSession();
    hideCalib();
    const r = await api.calibrate();
    if (!r || !r.ok) { setBar('error', `Calibration failed: ${(r && r.error) || 'unknown'}`); return; }
    for (const m of r.marks) {
      const d = document.createElement('div');
      d.className = 'calib-mark';
      d.style.transform = `translate(${m.pointer.local.x}px, ${m.pointer.local.y}px)`;
      const t = document.createElement('span');
      t.textContent = `y${m.y} x${m.x}`;
      d.appendChild(t);
      el.calib.appendChild(d);
    }
    el.calib.hidden = false;
    const i = r.info, v = `${window.innerWidth}×${window.innerHeight}`, dd = `${i.displayBounds.width}×${i.displayBounds.height}`;
    const warn = [];
    if (v !== dd) warn.push(`VIEW ${v} ≠ DISPLAY ${dd}`);
    if (Math.abs(window.devicePixelRatio - i.scaleFactor) > 0.01) warn.push(`DPR ${window.devicePixelRatio} ≠ scale ${i.scaleFactor}`);
    if (i.overlayBounds.x !== i.displayBounds.x || i.overlayBounds.y !== i.displayBounds.y) warn.push('OVERLAY OFFSET');
    setBar('idle', `Calibrate: view ${v} · display ${dd} @${i.scaleFactor}x · capture ${i.imagePx.width}×${i.imagePx.height}${warn.length ? ' · ⚠ ' + warn.join(', ') : ' · OK'}`);
    console.log('[calibrate]', JSON.stringify({ view: v, dpr: window.devicePixelRatio, ...i, warn }));
    calibTimer = setTimeout(() => { hideCalib(); setBar('idle', IDLE_PLACEHOLDER()); }, 20000);
  }

  function hidePointer() {
    hideCalib();
    S.focus = [];
    el.reticle.hidden = true;
    el.reticle.classList.remove('stale', 'done');
    hideDrag();
    setPointerStale(false);
    S.pointerVisible = false;
  }

  function clearTimers() {
    clearTimeout(S.waitTimer); S.waitTimer = null;
    clearTimeout(S.doneTimer); S.doneTimer = null;
  }

  // ───────────── Guidance loop ─────────────
  async function startSession({ goal, goalAudio, reuseFrom }) {
    if (S.running) await endSession('stopped');
    clearTimers();
    hidePointer();
    Object.assign(S, {
      sessionId: null, goal: goal || '', goalAudio: goalAudio || null, reuseFrom: reuseFrom || null,
      history: [], plan: [], planIndex: 0, running: true, busy: false,
      lastStatus: 'next', last: null, waits: 0, lastStep: '',
    });
    watcher.disarm();
    setInteractive(false);
    await fetchStep();
  }

  async function endSession(status) {
    const id = S.sessionId;
    S.running = false;
    S.busy = false;
    watcher.disarm();
    clearTimers();
    if (id && status) await api.history('end', { id, status });
  }

  async function stopSession(msg) {
    await endSession('stopped');
    hidePointer();
    Voice.stopSpeaking();
    setBar('idle', msg || IDLE_PLACEHOLDER());
  }

  function markTrigger(trigger, note) {
    const last = S.history[S.history.length - 1];
    if (!last) return;
    last.trigger = trigger;
    if (note) last.userNote = last.userNote ? `${last.userNote} / ${note}` : note;
  }

  function progressPrefix() {
    return S.plan.length ? `${Math.min(S.planIndex + 1, S.plan.length)}/${S.plan.length} · ` : '';
  }

  async function fetchStep() {
    if (!S.running || S.busy) return;
    if (S.history.length >= MAX_STEPS) { stopSession('Step limit reached.'); return; }
    S.busy = true;
    clearTimeout(S.waitTimer); S.waitTimer = null;
    if (S.pointerVisible) setPointerStale(true);
    setBar('thinking', S.lastStep ? `${progressPrefix()}${S.lastStep}` : 'Looking at your screen…');

    const res = await api.nextStep({
      sessionId: S.sessionId, goal: S.goal, goalAudio: S.goalAudio, reuseFrom: S.reuseFrom, history: S.history,
    });

    if (!S.running) { S.busy = false; return; }
    if (!res || !res.ok) {
      S.busy = false;
      watcher.disarm();     // don't auto-retry against a failing / rate-limited API; Enter (or a new note) re-arms
      setPointerStale(false);
      setBar('error', `Error: ${(res && res.error) || 'unknown'} — press Enter to retry`);
      return;
    }

    if (res.sessionId) S.sessionId = res.sessionId;
    if (res.goal && !S.goal) S.goal = res.goal;
    S.goalAudio = null;
    S.reuseFrom = null;
    if (res.plan && res.plan.length) S.plan = res.plan;
    S.planIndex = res.plan_index || 0;
    S.lastStatus = res.status;
    S.last = res;

    S.history.push({
      step: res.step, action: res.action, hint: res.hint, target: res.target,
      point: res.point, end_point: res.end_point, scroll: res.scroll,
      status: res.status, plan: res.plan, plan_index: res.plan_index, observation: res.observation,
      type_text: res.type_text, keys: res.keys, done: res.done,
      trigger: 'change', userNote: '',
    });

    // Pointer stays until replaced; hidden only for gesture-less "next" steps (would mislead) or after done.
    if (res.pointer) showPointer(res);
    else if (res.status === 'wait' || res.status === 'ask' || res.done) setPointerStale(res.status !== 'done');
    else hidePointer();

    const sameAsBefore = res.step === S.lastStep;
    S.lastStep = res.step;
    if (res.status === 'wait') { S.waits += 1; if (!sameAsBefore) Voice.speak(res.step); }
    else { S.waits = 0; Voice.speak(res.step); }

    const text = `${progressPrefix()}${res.step}`;
    if (res.done) {
      S.running = false;
      setBar('done', `✓ ${res.step}`);
      if (S.pointerVisible) { el.reticle.classList.remove('stale'); el.reticle.classList.add('done'); hideDrag(); }
      S.doneTimer = setTimeout(() => { hidePointer(); setBar('idle', IDLE_PLACEHOLDER()); }, DONE_POINTER_MS);
      S.busy = false;
      return;
    }

    if (res.status === 'ask') {
      setBar('ask', text);
      el.input.focus();
    } else if (res.status === 'wait') {
      setBar('thinking', text);
      if (S.waits < MAX_CONSECUTIVE_WAITS) {
        S.waitTimer = setTimeout(() => { if (S.running && !S.busy) { markTrigger('wait'); fetchStep(); } }, WAIT_RECHECK_MS);
      }
    } else {
      setBar('waiting', text);
    }

    const s = await api.sampleScreen(S.focus);
    if (s && s.ok) watcher.arm(s.gray, s.crops); else watcher.disarm();
    S.busy = false;
  }

  // Cells covered by our own UI are ignored by the watcher
  function overlayMask(w, h) {
    const rects = [el.bar.getBoundingClientRect()];
    if (!el.reticle.hidden) {
      const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(el.reticle.style.transform);
      if (m) rects.push({ left: +m[1] - 60, top: +m[2] - 60, width: 120, height: 120 });
      if (!el.label.hidden) {
        const r = el.label.getBoundingClientRect();
        rects.push({ left: r.left - 8, top: r.top - 8, width: r.width + 16, height: r.height + 16 });
      }
    }
    if (!el.dragLayer.hidden) {
      const x1 = +el.dragLine.getAttribute('x1'), y1 = +el.dragLine.getAttribute('y1');
      const r = el.dragEnd.getBoundingClientRect();
      const x2 = r.left, y2 = r.top;
      const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 40));
      for (let i = 0; i <= n; i++) {
        const x = x1 + ((x2 - x1) * i) / n, y = y1 + ((y2 - y1) * i) / n;
        rects.push({ left: x - 30, top: y - 30, width: 60, height: 60 });
      }
      rects.push({ left: x2 - 40, top: y2 - 40, width: 140, height: 80 });
      if (el.dragBox.style.display !== 'none') {
        // the box outline is drawn too; mask its edges
        const bx = +el.dragBox.getAttribute('x'), by = +el.dragBox.getAttribute('y');
        const bw = +el.dragBox.getAttribute('width'), bh = +el.dragBox.getAttribute('height');
        rects.push({ left: bx - 6, top: by - 6, width: bw + 12, height: 12 }, { left: bx - 6, top: by + bh - 6, width: bw + 12, height: 12 },
          { left: bx - 6, top: by - 6, width: 12, height: bh + 12 }, { left: bx + bw - 6, top: by - 6, width: 12, height: bh + 12 });
      }
    }
    return PHash.maskFromRects(rects, window.innerWidth, window.innerHeight, w, h);
  }

  let ticking = false;
  async function watchTick() {
    if (ticking || !S.running || S.busy || !watcher.isArmed()) return;
    ticking = true;               // sampling can take longer than the interval; never overlap ticks
    try {
      const s = await api.sampleScreen(S.focus);
      if (!s || !s.ok || !S.running || S.busy) return;
      const r = watcher.tick(s.gray, maskOwnUi ? overlayMask(s.w, s.h) : null, s.crops);
      if (debugWatch && (r.cells || r.bits || r.local || r.fire)) console.log(`[watch] cells=${r.cells} bits=${r.bits} local=${r.local} changed=${r.changed}${r.fire ? ` → FIRE (${r.reason})` : ''}`);
      if (r.fire) { markTrigger('change'); fetchStep(); }
    } finally {
      ticking = false;
    }
  }
  setInterval(watchTick, WATCH_INTERVAL_MS);

  // ───────────── Type bar input ─────────────
  // Enter on an empty bar = re-check now. Words: "stop", "next", "repeat". Esc = stop.
  function submitText(raw) {
    const text = (raw || '').trim();
    const cmd = text.toLowerCase();
    if (!text) {
      if (S.running || (S.goal && S.lastStatus !== 'done')) { S.running = true; markTrigger('manual'); fetchStep(); }
      return;
    }
    if (cmd === 'calibrate') { runCalibration(); return; }
    if (cmd === 'stop' || cmd === 'cancel') { stopSession(); return; }
    if (cmd === 'repeat' || cmd === 'again') { Voice.speak(S.lastStep); return; }
    if (cmd === 'next' || cmd === 'done' || cmd === 'ok') {
      if (S.running || (S.goal && S.lastStatus !== 'done')) { S.running = true; markTrigger('manual'); fetchStep(); }
      return;
    }
    if (S.running) {
      markTrigger('note', text);
      if (!S.busy) fetchStep();
    } else {
      startSession({ goal: text });
    }
  }

  el.bar.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = el.input.value;
    el.input.value = '';
    el.input.blur();
    setInteractive(false);
    submitText(text);
  });

  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      el.input.value = '';
      el.input.blur();
      setInteractive(false);
      if (S.running) stopSession();
    }
  });

  // ───────────── Voice ─────────────
  async function toggleMic() {
    if (S.listening) { S.listening.stop(); return; }
    Voice.stopSpeaking();
    try {
      el.mic.classList.add('on');
      S.listening = await Voice.listen({ onInterim: (t) => { el.input.value = t; } });
      const r = await S.listening.done;
      S.listening = null;
      el.mic.classList.remove('on');
      el.input.value = '';
      if (r.text) submitText(r.text);
      else if (r.heardVoice && !S.running) startSession({ goal: '', goalAudio: r.audio });  // Gemini transcribes
      else if (r.heardVoice) setBar('error', 'Could not transcribe that — please type it');
    } catch (err) {
      S.listening = null;
      el.mic.classList.remove('on');
      setBar('error', `Microphone error: ${err.message}`);
    }
  }
  el.mic.addEventListener('click', toggleMic);

  // ───────────── Main-process events ─────────────
  api.onMainEvent((ev) => {
    if (!ev) return;
    if (ev.type === 'hotkey') {
      setInteractive(true);
      el.input.focus();
    } else if (ev.type === 'status') {
      hotkeyText = ev.hotkey || hotkeyText;
      if (typeof ev.ownUiCaptured === 'boolean') maskOwnUi = ev.ownUiCaptured;
      debugWatch = !!ev.debug;
      focusOn = ev.focusWatch !== false;
      if (ev.error) setBar('error', ev.error);
      else setBar('idle', IDLE_PLACEHOLDER());
      if (ev.db) el.bar.dataset.db = ev.db.kind;
    }
  });

  setBar('idle', IDLE_PLACEHOLDER());
  hidePointer();
})();
