'use strict';
/**
 * Vision & Reasoning (Module 2)
 * Sends goal + plan + step history + screenshot to Gemini (v1beta) and gets back
 * the spoken step and the element to point at, as JSON with a [y, x] 0–1000 point.
 *
 * Multi-step tracking: the model keeps an explicit PLAN of milestones and a
 * plan_index, verifies every step against the new screenshot before advancing,
 * and reports a status (next / retry / recover / wait / ask / done).
 *
 * Reliability:
 *  - several API keys (GEMINI_API_KEYS) are used round-robin; a key that gets a 429 is put on
 *    cooldown (per model) and the same request is retried straight away on the next key
 *  - primary model → fallback model when every key is out of quota for the primary, on overload
 *    (503/500) or unknown model (404), with exponential backoff + jitter for server-side errors
 */
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { KeyPool, cooldownFromError } = require('./keypool');

const SYSTEM_PROMPT = `You are Glance, a patient expert tutor sitting next to the user and watching their screen.
The user wants to LEARN to do a task themselves. You TEACH; you never do it for them. You can only point and speak.

Each turn you receive: the user's GOAL, your PLAN so far, the steps you already gave (with what you observed),
optional notes from the user, and a fresh screenshot of the user's screen RIGHT NOW. Decide the single next action.

━━ 1. PLAN (multi-step tasks) ━━
- On the first turn, break the goal into an ordered PLAN of 3–15 milestones (outcomes, not clicks),
  e.g. for "deploy a web server on AWS": "Open EC2 console", "Launch an instance", "Choose Ubuntu AMI",
  "Pick t2.micro", "Create/select key pair", "Allow HTTP in security group", "Launch", "Connect via SSH",
  "Install nginx", "Open the public IP in a browser".
- Include prerequisites and steps outside the current app (open a terminal, switch browser tab, sign in).
- Return the FULL plan every turn. Keep it stable. Change it only when the screen proves it wrong
  (step already done, different UI version, an error, the user chose another path).
- "plan_index" = 0-based index of the milestone being worked on now. Advance it only when the screen shows that milestone is complete.

━━ 2. VERIFY BEFORE ADVANCING ━━
Compare the screenshot with what your previous step should have produced:
- It worked → status "next": give the next step.
- Nothing happened / not done yet → status "retry": calmly repeat or rephrase the same step, re-point.
- Something went wrong (error message, wrong page, wrong app, a popup/dialog in the way) → status "recover":
  explain briefly and guide back on track. Always handle blocking dialogs, cookie banners, and permission prompts first.
- Screen is loading / installing / spinner / progress bar → status "wait": say what to wait for, empty point.
- You need information only the user has or a choice that is theirs (region, project name, which account,
  ambiguous goal) → status "ask": ask ONE short question, empty point unless pointing helps. The reply arrives as a user note.
- The goal is visibly achieved → status "done", done=true, congratulate in one short sentence, empty point.

━━ 3. ONE STEP = ONE GESTURE, SAID EXACTLY ━━
Every step is exactly ONE physical gesture. Start "step" with the gesture verb so the user knows precisely what to do with the mouse/keyboard:
  "Click …", "Double-click …", "Right-click …", "Click and drag from … to …", "Hold Shift and drag …",
  "Scroll down in …", "Hover over …", "Type …", "Press …".
Then say WHERE (the element's visible label and its location, e.g. "in the left toolbar", "top-right corner")
and WHAT will happen ("…a menu opens", "…a frame appears"). At most ~35 words, no markdown, no coordinates.
For non-obvious steps add a very short "why" so the user learns.

Set "action" to the gesture:
- "click" | "double_click" | "right_click" | "hover" — point at the element.
- "drag" — anything done by press-hold-move-release: drawing a frame/shape/selection box (Figma, Photoshop, Canva),
  resizing with a handle, moving an object, dragging a slider, reordering layers/tabs, selecting text, drag-and-drop files.
  "point" = where to PRESS, "end_point" = where to RELEASE (both inside the screenshot).
  The step MUST describe the drag fully: where to press, which direction, roughly how far / what size, where to release,
  and any modifier ("hold Shift to keep it square", "hold Alt to duplicate").
  Example: "With the Frame tool active, click and drag on the empty canvas from here down and to the right until the size label reads about 400 × 300, then release."
  When a size matters, estimate end_point from what is visible (rulers, existing objects, the zoom level) and tell the user
  to watch the app's size/position read-out; mention the precise alternative (typing W/H in the properties panel) in one short clause if it helps.
- "scroll" — point at the area to scroll inside; set "scroll" to "up" | "down" | "left" | "right".
- "type" — point at the INPUT FIELD; exact text in "type_text" (commands, URLs, values). Never invent secrets
  (passwords, keys, account IDs): say "type your …".
- "key" — keyboard shortcut in "keys" (e.g. "Ctrl+Shift+P", "F" for Figma's Frame tool). Point at what it affects, or [].
- "none" — waiting, asking, or done.
If a step needs a tool to be selected first (e.g. the Frame or Rectangle tool), make selecting it its own step.
Destructive or costly actions (delete, terminate, overwrite, pay, publish, push to production) → warn clearly in "step".

"hint" = 2–6 word caption shown next to the pointer, e.g. "Click Share", "Drag to draw the frame", "Scroll down here".

━━ 4. POINTING ━━
- Point ONLY at something visible in THIS screenshot. Never guess where an off-screen element is.
- If the target is not visible, guide the user to reveal it (scroll, open the menu, expand a section,
  switch window/tab — point at the taskbar icon or the browser tab) and point at THAT control.
- Point at the centre of the clickable element: the input box itself (not its label), the menu item text,
  the centre of small icons, the checkbox/radio itself, the exact handle for resizing.
- Coordinates are [y, x] — y FIRST — normalized to a 0–1000 grid over the screenshot
  (0,0 = top-left, 1000,1000 = bottom-right). Use [] when there is nothing to point at.

━━ 5. DESIGN TOOLS (Figma, Canva, Photoshop, Illustrator, Sketch) ━━
- New objects start with defaults that are rarely what the design needs. NEW TEXT IS TINY (about 12–16 px). Right after
  the user types a heading, label or button text, give a separate step to select that text and set its font size
  (and weight) in the properties/typography panel, with a concrete value (e.g. a page title 32–40, labels 14–16).
  Check the screenshot: if text or a shape looks too small, too large or off-centre for the design, fix it BEFORE moving on.
- REPEATED / ALIGNED ELEMENTS (a second input field, the next button, a row of cards): do NOT freehand-drag a new one.
  Look at the previous element's X, Y, W and H in the properties panel of the screenshot, then guide this sequence as separate steps:
  select the previous element → duplicate it (Ctrl+D in Figma, Alt+drag, or copy/paste) → in the properties panel set Y to
  previous Y + previous height + a gap of 16–24, keeping the same X. Quote the exact numbers you computed from what you can read.
  This gives pixel-exact alignment with the element above.
- If a drag really is needed next to an existing shape, press at the existing shape's LEFT edge x (same x as it), a gap below it,
  and release so the size read-out matches the shape above; tell the user to look for the pink snap lines that show alignment.
- Centre things with the app's alignment buttons (e.g. Align horizontal centers in Figma's top-right panel) instead of by eye.
- A text layer is created in three gestures: pick the Text tool, click once on the canvas where it should start, then type.
  Make each its own step, and after typing tell the user to press Escape so the text is committed.

━━ OUTPUT ━━
Reply with ONLY this JSON object:
{
  "goal": string,            // the user's goal in their words (transcribe it if it came as audio)
  "observation": string,     // one sentence: what app/page/dialog is on screen and the state relevant to the goal
  "plan": [string],          // full milestone list
  "plan_index": integer,     // current milestone (0-based)
  "status": "next" | "retry" | "recover" | "wait" | "ask" | "done",
  "action": "click" | "double_click" | "right_click" | "hover" | "drag" | "scroll" | "type" | "key" | "none",
  "step": string,            // what to say to the user now
  "hint": string,            // 2–6 word caption for the pointer
  "target": string,          // visible name of the element to interact with ("" if none)
  "type_text": string,       // exact text to type, else ""
  "keys": string,            // key combo, else ""
  "scroll": string,          // "up" | "down" | "left" | "right" for action "scroll", else ""
  "point": [y, x] or [],     // where to click / press / type / scroll
  "end_point": [y, x] or [], // drag release point (action "drag" only), else []
  "done": boolean
}`;

const STATUSES = new Set(['next', 'retry', 'recover', 'wait', 'ask', 'done']);
const ACTIONS = new Set(['click', 'double_click', 'right_click', 'hover', 'drag', 'scroll', 'type', 'key', 'none']);
const SCROLLS = new Set(['up', 'down', 'left', 'right']);
const SERVER_RETRYABLE = new Set([500, 503]);   // 429 is handled by rotating keys, not by sleeping
const BAD_KEY = /API_KEY_INVALID|API key (?:not valid|expired)|key was reported as leaked|unregistered callers/i;
const REPLAY_WINDOW = 10;               // last N turns replayed verbatim; older ones summarised
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function statusOf(err) {
  if (err && typeof err.status === 'number') return err.status;
  const m = /\[(\d{3})[^\]]*\]/.exec(String(err && err.message));
  return m ? Number(m[1]) : 0;
}

function extractJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch { /* fall through */ }
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s >= 0 && e > s) return JSON.parse(t.slice(s, e + 1));
  throw new Error('Model did not return JSON: ' + t.slice(0, 200));
}

/** Normalise whatever the model returned into a strict shape. */
function normalizeResponse(json, fallbackGoal) {
  const plan = Array.isArray(json.plan) ? json.plan.map((p) => String(p).trim()).filter(Boolean).slice(0, 20) : [];
  let idx = Number.isInteger(json.plan_index) ? json.plan_index : parseInt(json.plan_index, 10);
  if (!Number.isFinite(idx) || idx < 0) idx = 0;
  if (plan.length) idx = Math.min(idx, plan.length - 1);
  let status = String(json.status || '').toLowerCase();
  const done = json.done === true || status === 'done';
  if (done) status = 'done';
  if (!STATUSES.has(status)) status = 'next';
  const type_text = String(json.type_text || '').trim();
  const keys = String(json.keys || '').trim();
  let action = String(json.action || '').toLowerCase().replace(/[\s-]+/g, '_');
  if (action === 'doubleclick') action = 'double_click';
  if (action === 'rightclick') action = 'right_click';
  if (!ACTIONS.has(action)) action = type_text ? 'type' : keys ? 'key' : (Array.isArray(json.point) && json.point.length ? 'click' : 'none');
  const endOk = Array.isArray(json.end_point) && json.end_point.length >= 2;
  if (action === 'drag' && !endOk) action = 'click';
  let scroll = String(json.scroll || '').toLowerCase();
  if (!SCROLLS.has(scroll)) scroll = action === 'scroll' ? 'down' : '';
  return {
    goal: typeof json.goal === 'string' && json.goal.trim() ? json.goal.trim() : fallbackGoal,
    observation: String(json.observation || '').trim(),
    plan,
    plan_index: done && plan.length ? plan.length - 1 : idx,
    status,
    action,
    step: String(json.step || '').trim(),
    hint: String(json.hint || '').trim().slice(0, 60),
    target: String(json.target || '').trim(),
    type_text,
    keys,
    scroll,
    point: json.point,
    end_point: action === 'drag' ? json.end_point : [],
    done,
  };
}

function modelTurnText(h, goal) {
  return JSON.stringify({
    goal: goal || '',
    observation: h.observation || '',
    plan: h.plan || [],
    plan_index: h.plan_index || 0,
    status: h.status || 'next',
    action: h.action || 'none',
    step: h.step || '',
    hint: h.hint || '',
    target: h.target || '',
    type_text: h.type_text || '',
    keys: h.keys || '',
    scroll: h.scroll || '',
    point: Array.isArray(h.point) ? h.point : [],
    end_point: Array.isArray(h.end_point) ? h.end_point : [],
    done: !!h.done,
  });
}

function triggerText(h) {
  switch (h.trigger) {
    case 'manual': return 'I pressed "Next step".';
    case 'wait': return 'Some time has passed.';
    case 'note': return 'I replied.';
    default: return 'My screen changed after your step.';
  }
}

/**
 * Build the multi-turn contents. History is replayed every turn so the model remembers prior steps;
 * only the newest user turn carries the screenshot. Older turns are summarised to bound context.
 */
function buildContents({ goal, goalAudio, history, imageB64, imageMime, reuse }) {
  const image = { inlineData: { mimeType: imageMime, data: imageB64 } };
  const goalParts = goalAudio
    ? [{ text: "The user's goal is spoken in this audio clip:" }, { inlineData: { mimeType: goalAudio.mimeType, data: goalAudio.data } }]
    : [{ text: `GOAL: ${goal}` }];

  const intro = [...goalParts];
  if (reuse && Array.isArray(reuse.steps) && reuse.steps.length) {
    const lines = reuse.steps.slice(0, 40).map((s, i) => `${i + 1}. ${s.action ? `(${s.action}) ` : ''}${s.step}${s.type_text ? ` [typed: ${s.type_text}]` : ''}${s.keys ? ` [keys: ${s.keys}]` : ''}`);
    intro.push({
      text: `For reference, this user previously completed a similar goal ("${reuse.goal}") with these steps:\n${lines.join('\n')}\n` +
        (reuse.plan && reuse.plan.length ? `Plan used then: ${reuse.plan.join(' → ')}\n` : '') +
        'Use it as a guide, but always trust the CURRENT screen — the UI or situation may differ.',
    });
  }

  const contents = [];
  const hist = history || [];
  if (hist.length === 0) {
    contents.push({ role: 'user', parts: [...intro, { text: 'Here is my current screen. Make the plan and give me the first step.' }, image] });
    return contents;
  }

  const older = hist.slice(0, Math.max(0, hist.length - REPLAY_WINDOW));
  const recent = hist.slice(older.length);
  if (older.length) {
    const summary = older.map((h, i) => `${i + 1}. [${h.status || 'next'}] ${h.step}${h.userNote ? ` (user: ${h.userNote})` : ''}`).join('\n');
    intro.push({ text: `Earlier steps already given (summary):\n${summary}` });
  }
  intro.push({ text: '(Screenshots of earlier turns are omitted.)' });
  contents.push({ role: 'user', parts: intro });

  recent.forEach((h, i) => {
    contents.push({ role: 'model', parts: [{ text: modelTurnText(h, goal) }] });
    const last = i === recent.length - 1;
    const note = h.userNote ? ` Note from me: "${h.userNote}".` : '';
    contents.push({
      role: 'user',
      parts: last
        ? [{ text: `${triggerText(h)}${note} Here is my screen now. Verify my progress against your last step and the plan, then give the next step.` }, image]
        : [{ text: `${triggerText(h)}${note}` }],
    });
  });
  return contents;
}

class Vision {
  /**
   * @param {{ apiKeys?: string[], apiKey?: string, primaryModel: string, fallbackModel?: string,
   *           log?: Console, maxKeyWaitMs?: number, backoffMs?: number }} opts
   */
  constructor({ apiKeys, apiKey, primaryModel, fallbackModel, log = console, maxKeyWaitMs = 15000, backoffMs = 800, now = Date.now }) {
    this.mock = process.env.GLANCE_MOCK === '1';
    const keys = apiKeys && apiKeys.length ? apiKeys : apiKey ? [apiKey] : [];
    if (!keys.length && !this.mock) {
      throw new Error('No Gemini API key found. Copy .env.example to .env and set GEMINI_API_KEYS=key1,key2,key3');
    }
    this.log = log;
    this.now = now;
    this.pool = new KeyPool(this.mock ? [] : keys, { log, now });
    // fallbackModel may be one id, a comma-separated list, or an array: tried in this order after the primary
    this.models = [...new Set([primaryModel, ...[].concat(fallbackModel || []).flatMap((m) => String(m).split(','))].map((m) => String(m || '').trim()).filter(Boolean))];
    this.modelState = new Map();      // model -> { dead: bool (404), downUntil: ms (overloaded) }
    this.maxKeyWaitMs = maxKeyWaitMs;
    this.backoffMs = backoffMs;
    if (!this.mock) this.log.log(`[vision] ${this.pool.size} API key${this.pool.size === 1 ? '' : 's'} loaded; models: ${this.models.join(' > ')}`);
  }

  /** Healthy models first; models that recently overloaded go last; models that 404'd are skipped (unless nothing else is left). */
  _modelOrder() {
    const t = this.now();
    const st = (m) => this.modelState.get(m) || {};
    const live = this.models.filter((m) => !st(m).dead);
    const use = live.length ? live : this.models;
    return [...use.filter((m) => (st(m).downUntil || 0) <= t), ...use.filter((m) => (st(m).downUntil || 0) > t)];
  }

  _client(entry) {
    if (!entry.client) entry.client = new GoogleGenerativeAI(entry.key);
    return entry.client;
  }

  _model(name, client) {
    return client.getGenerativeModel(
      {
        model: name,
        systemInstruction: SYSTEM_PROMPT,
        generationConfig: { responseMimeType: 'application/json' },
      },
      { apiVersion: 'v1beta', timeout: 90000 },
    );
  }

  /**
   * Run fn(model, client) with key rotation + model fallback.
   *  429          -> cool that key down for that model, retry immediately on the next key
   *  500/503/JSON -> back off, retry (on the next key), then fall through to the next model;
   *                  the overloaded model is tried last for the next 45 s so later requests don't wait on it
   *  404          -> model is not available to this account: skipped for the rest of the run
   *  bad key      -> disable that key for the rest of the run
   * When every key is cooling down, wait if the shortest cooldown is short, otherwise fail with a clear message.
   */
  async _withFallback(fn) {
    let lastErr = null;
    let lastRealStatus = 0;             // last status that wasn't a 404 (a retired model says nothing about service health)
    let sawRateLimit = false;
    const outcome = {};                 // model -> why it did not work (for the final error message)
    for (let round = 0; round < 2; round++) {
      const order = this._modelOrder();
      for (let mi = 0; mi < order.length; mi++) {
        const model = order[mi];
        const maxServerRetries = mi === order.length - 1 ? 3 : 1;
        let serverRetries = 0;
        let entry;
        while ((entry = this.pool.acquire(model))) {
          try {
            const out = await fn(model, this._client(entry));
            const ms = this.modelState.get(model);
            if (ms) ms.downUntil = 0;
            return { ...out, model };
          } catch (err) {
            lastErr = err;
            const st = statusOf(err);
            if (st !== 404) lastRealStatus = st || 0;
            const msg = String(err && err.message);
            this.log.warn(`[vision] ${model} via ${entry.label} failed (${st || 'no status'}): ${msg.slice(0, 300)}`);

            if (st === 404) {                                               // unknown / retired model -> skip it from now on
              this.modelState.set(model, { ...this.modelState.get(model), dead: true });
              outcome[model] = 'not available to your API key (404) - set GLANCE_FALLBACK_MODEL / GLANCE_PRIMARY_MODEL to a current model';
              this.log.warn(`[vision] model ${model} is not available (404) - skipping it. Change it in .env.`);
              break;
            }
            if (st === 429) {
              sawRateLimit = true;
              const { ms, daily } = cooldownFromError(err);
              this.pool.cooldown(entry, model, ms);
              outcome[model] = 'rate-limited on every key';
              this.log.warn(`[vision] ${entry.label} rate-limited on ${model} (${daily ? 'daily quota' : 'per-minute'}) - resting ${Math.round(ms / 1000)}s, switching key (${this.pool.alive} usable)`);
              continue;
            }
            if ([400, 401, 403].includes(st)) {
              if (BAD_KEY.test(msg)) {
                this.pool.disable(entry);
                outcome[model] = 'API key rejected';
                this.log.warn(`[vision] ${entry.label} was rejected as invalid - disabled for this run`);
                continue;
              }
              if (st === 403) { this.pool.cooldown(entry, model, 10 * 60 * 1000); outcome[model] = 'permission denied (403)'; continue; }  // key lacks access to this model
              throw err;                                                    // 400 = our request is bad; another key won't help
            }
            const retryable = SERVER_RETRYABLE.has(st) || err instanceof SyntaxError || /did not return JSON/.test(msg);
            if (!retryable) throw err;
            outcome[model] = st ? `overloaded / server error (${st})` : 'model returned invalid JSON';
            if (serverRetries++ >= maxServerRetries) {                      // give up on this model for now
              if (st) this.modelState.set(model, { ...this.modelState.get(model), downUntil: this.now() + 45000 });
              break;
            }
            await sleep(this.backoffMs * 2 ** (serverRetries - 1) + Math.random() * this.backoffMs / 2);
          }
        }
      }

      if (this.pool.alive === 0) throw new Error(`All ${this.pool.size} Gemini API key(s) were rejected as invalid. Check GEMINI_API_KEYS in .env.`);
      const wait = this.pool.soonestAvailableMs(this.models);
      if (!(sawRateLimit && wait > 0 && wait <= this.maxKeyWaitMs && round === 0)) break;
      this.log.warn(`[vision] every key is cooling down - waiting ${Math.ceil(wait / 1000)}s for the next one`);
      await sleep(wait);
    }

    const live = this.models.filter((m) => !(this.modelState.get(m) || {}).dead);
    if (sawRateLimit && live.every((m) => !this.pool.hasUsable(m))) {
      const wait = this.pool.soonestAvailableMs(live);
      const e = new Error(`All ${this.pool.alive} API key(s) are rate-limited right now${Number.isFinite(wait) ? ` - next one frees up in ~${Math.ceil(wait / 1000)}s` : ''}. Add more keys (from separate projects) to GEMINI_API_KEYS or wait a bit.`);
      e.status = 429;
      throw e;
    }
    const summary = this.models.map((m) => `${m}: ${outcome[m] || 'not tried'}`).join(' | ');
    const e = new Error(`No model could answer. ${summary}`);
    e.status = lastRealStatus;
    throw e;
  }

  _mock(goal, history) {
    const n = (history || []).length;
    const plan = ['Select the tool', 'Draw the frame', 'Scroll the panel', 'Confirm the result'];
    const steps = [
      { action: 'key', step: 'Press F to pick the Frame tool.', hint: 'Press F', keys: 'F', point: [500, 500] },
      { action: 'drag', step: 'Click and drag from here down and to the right until the size label reads about 400 × 300, then release.', hint: 'Drag to draw the frame', point: [350, 300], end_point: [650, 600] },
      { action: 'scroll', step: 'Scroll down in the right panel to find Export.', hint: 'Scroll down here', scroll: 'down', point: [500, 900] },
      { action: 'type', step: 'Click the name box and type the frame name.', hint: 'Type the name', type_text: 'Hero frame', point: [200, 500] },
    ];
    const done = n >= steps.length;
    const st = done ? { action: 'none', step: 'Mock run finished — that was the last step.', hint: '', point: [] } : steps[n];
    return {
      goal: goal || '(mock goal)', observation: 'Mock screen.', plan,
      plan_index: Math.min(n, plan.length - 1), status: done ? 'done' : 'next',
      target: '', type_text: '', keys: '', scroll: '', end_point: [], ...st, done, model: 'mock',
    };
  }

  /**
   * @returns {Promise<{goal, observation, plan, plan_index, status, action, step, hint, target, type_text, keys, scroll, point, end_point, done, model}>}
   *          point is raw [y,x] 0–1000 (or [])
   */
  async nextStep({ goal, goalAudio, history, imageB64, imageMime = 'image/jpeg', reuse = null }) {
    if (this.mock) { await sleep(400); return this._mock(goal, history); }
    const contents = buildContents({ goal, goalAudio, history, imageB64, imageMime, reuse });
    return this._withFallback(async (modelName, client) => {
      const res = await this._model(modelName, client).generateContent({ contents });
      return normalizeResponse(extractJson(res.response.text()), goal);
    });
  }
}

module.exports = { Vision, SYSTEM_PROMPT, ACTIONS, buildContents, extractJson, statusOf, normalizeResponse, REPLAY_WINDOW };
