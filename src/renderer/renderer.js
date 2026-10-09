/**
 * Renderer (sandboxed): overlay UI, pointer reticle, step loop (Module 5),
 * screen-change watcher, voice in/out.
 * Talks to the main process only through window.glance (preload bridge).
 */
(function () {
  'use strict';

  const api = window.glance;
  const $ = (s) => document.querySelector(s);

  const el = {
    panel: $('#panel'),
    pill: $('#pill'),
    hotkey: $('#hotkey'),
    form: $('#goal-form'),
    input: $('#goal-input'),
    mic: $('#mic'),
    goal: $('#goal'),
    step: $('#step'),
    status: $('#status'),
    model: $('#model'),
    counter: $('#counter'),
    next: $('#btn-next'),
    repeat: $('#btn-repeat'),
    stop: $('#btn-stop'),
    close: $('#btn-close'),
    reticle: $('#reticle'),
    reticleLabel: $('#reticle-label'),
  };

  // ───────────── Config ─────────────
  const WATCH_INTERVAL_MS = 600;   // sampling period of the screen-change watcher
  const SETTLE_SAMPLES = 2;        // consecutive stable samples before fetching the next step
  const MAX_STEPS = 40;

  // ───────────── Session state (Module 5) ─────────────
  const S = {
    goal: '',
    goalAudio: null,     // only for the first request when STT failed
    history: [],         // [{step, target, point, done}]
    running: false,
    busy: false,
    baseline: null,      // gray sample right after the last step was shown
    prev: null,
    changed: false,
    stableCount: 0,
    lastStep: '',
    listening: null,
  };

  // ───────────── Click-through handling ─────────────
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

  // ───────────── UI helpers ─────────────
  function setStatus(text, kind) {
    el.status.textContent = text || '';
    el.status.dataset.kind = kind || '';
  }
  function openPanel() {
    el.panel.hidden = false;
    el.pill.hidden = true;
  }
  function closePanel() {
    el.panel.hidden = true;
    el.pill.hidden = false;
    setInteractive(false);
  }
  function showPointer(pointer, label) {
    if (!pointer) { hidePointer(); return; }
    const { x, y } = pointer.local;
    el.reticle.style.transform = `translate(${x}px, ${y}px)`;
    el.reticleLabel.textContent = label || '';
    el.reticleLabel.hidden = !label;
    // keep label on-screen
    el.reticleLabel.classList.toggle('left', x > window.innerWidth - 260);
    el.reticleLabel.classList.toggle('below', y < 70);
    el.reticle.hidden = false;
    el.reticle.classList.remove('pop'); void el.reticle.offsetWidth; el.reticle.classList.add('pop');
  }
  function hidePointer() { el.reticle.hidden = true; }

  function renderStep(res) {
    el.goal.textContent = S.goal;
    el.step.textContent = res.step || '';
    el.model.textContent = res.model || '';
    el.counter.textContent = `Step ${S.history.length}`;
    el.next.disabled = !S.running;
    el.repeat.disabled = !res.step;
  }

  // ───────────── Guidance loop ─────────────
  async function startSession({ goal, goalAudio }) {
    S.goal = goal || '';
    S.goalAudio = goalAudio || null;
    S.history = [];
    S.running = true;
    S.changed = false;
    openPanel();
    el.goal.textContent = S.goal || '…';
    el.step.textContent = '';
    setInteractive(false);
    await fetchStep();
  }

  function stopSession(msg) {
    S.running = false;
    S.busy = false;
    hidePointer();
    Voice.stopSpeaking();
    el.next.disabled = true;
    setStatus(msg || 'Stopped.', '');
  }

  async function fetchStep() {
    if (!S.running || S.busy) return;
    if (S.history.length >= MAX_STEPS) { stopSession('Step limit reached.'); return; }
    S.busy = true;
    hidePointer();
    setStatus('Looking at your screen…', 'busy');
    el.panel.classList.add('thinking');

    const res = await api.nextStep({ goal: S.goal, goalAudio: S.goalAudio, history: S.history });

    el.panel.classList.remove('thinking');
    if (!S.running) { S.busy = false; return; }   // stopped while waiting
    if (!res || !res.ok) {
      S.busy = false;
      setStatus(`Error: ${(res && res.error) || 'unknown'} — press Next to retry.`, 'error');
      el.next.disabled = false;
      return;
    }

    if (res.goal && !S.goal) S.goal = res.goal;
    S.goalAudio = null;   // audio only needed for the first turn
    S.history.push({ step: res.step, target: res.target, point: res.point, done: res.done });
    S.lastStep = res.step;

    renderStep(res);
    showPointer(res.pointer, res.target);
    Voice.speak(res.step);

    if (res.done) {
      S.running = false;
      el.next.disabled = true;
      setStatus('Goal complete ✓', 'ok');
      setTimeout(hidePointer, 4000);
      S.busy = false;
      return;
    }

    setStatus('Waiting for you to do this step…', 'wait');
    const s = await api.sampleScreen();
    S.baseline = s && s.ok ? s.gray : null;
    S.prev = S.baseline;
    S.changed = false;
    S.stableCount = 0;
    S.busy = false;
  }

  // Cells covered by our own UI (panel/pill + reticle) are ignored by the watcher
  function overlayMask(w, h) {
    const rects = [];
    for (const n of [el.panel, el.pill]) if (!n.hidden) rects.push(n.getBoundingClientRect());
    if (!el.reticle.hidden) {
      const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(el.reticle.style.transform);
      if (m) {
        const x = +m[1], y = +m[2];
        rects.push({ left: x - 50, top: y - 50, width: 100, height: 100 });
        if (!el.reticleLabel.hidden) {
          const r = el.reticleLabel.getBoundingClientRect();
          rects.push({ left: r.left - 8, top: r.top - 8, width: r.width + 16, height: r.height + 16 });
        }
      }
    }
    return PHash.maskFromRects(rects, window.innerWidth, window.innerHeight, w, h);
  }

  // Screen-change watcher: detect change → wait until it settles → next step
  async function watchTick() {
    if (!S.running || S.busy || !S.baseline) return;
    const s = await api.sampleScreen();
    if (!s || !s.ok || !S.running || S.busy) return;
    const mask = overlayMask(s.w, s.h);

    if (!S.changed) {
      if (PHash.compare(S.baseline, s.gray, { mask }).changed) {
        S.changed = true;
        S.stableCount = 0;
        hidePointer();                      // element probably moved — don't point at stale spot
        setStatus('Screen changed — waiting for it to settle…', 'busy');
      }
    } else {
      const d = PHash.compare(S.prev, s.gray, { changedCells: 2, changedBits: 6, mask });
      S.stableCount = d.changed ? 0 : S.stableCount + 1;
      if (S.stableCount >= SETTLE_SAMPLES) {
        S.changed = false;
        fetchStep();
      }
    }
    S.prev = s.gray;
  }
  setInterval(watchTick, WATCH_INTERVAL_MS);

  // ───────────── Input: text ─────────────
  el.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const goal = el.input.value.trim();
    if (!goal) return;
    el.input.value = '';
    el.input.blur();
    startSession({ goal });
  });

  // ───────────── Input: voice ─────────────
  async function toggleMic() {
    if (S.listening) { S.listening.stop(); return; }
    Voice.stopSpeaking();
    try {
      el.mic.classList.add('on');
      setStatus('Listening… say what you want to do', 'busy');
      S.listening = await Voice.listen({ onInterim: (t) => { el.input.value = t; } });
      const r = await S.listening.done;
      S.listening = null;
      el.mic.classList.remove('on');
      if (r.text) {
        el.input.value = '';
        startSession({ goal: r.text });
      } else if (r.heardVoice) {
        el.input.value = '';
        startSession({ goal: '', goalAudio: r.audio });  // Gemini transcribes
      } else {
        setStatus("Didn't hear anything — try again or type your goal.", 'error');
      }
    } catch (err) {
      S.listening = null;
      el.mic.classList.remove('on');
      setStatus(`Microphone error: ${err.message}`, 'error');
    }
  }
  el.mic.addEventListener('click', toggleMic);

  // ───────────── Controls ─────────────
  el.next.addEventListener('click', () => {
    if (!S.running) { if (S.goal) { S.running = true; } else return; }
    S.changed = false;
    fetchStep();
  });
  el.repeat.addEventListener('click', () => Voice.speak(S.lastStep));
  el.stop.addEventListener('click', () => stopSession());
  el.close.addEventListener('click', () => { stopSession('Closed.'); closePanel(); });
  el.pill.addEventListener('click', () => { openPanel(); el.input.focus(); });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { stopSession('Stopped.'); closePanel(); }
  });

  // ───────────── Main-process events ─────────────
  api.onMainEvent((ev) => {
    if (!ev) return;
    if (ev.type === 'hotkey') {
      openPanel();
      setInteractive(true);
      if (S.running) { el.next.focus(); }
      else { el.input.focus(); }
    } else if (ev.type === 'status') {
      el.hotkey.textContent = ev.hotkey || '';
      if (ev.error) setStatus(ev.error, 'error');
      else if (ev.mock) setStatus('Mock mode — no API calls.', 'wait');
    }
  });

  hidePointer();
})();
