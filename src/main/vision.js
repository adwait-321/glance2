'use strict';
/**
 * Vision & Reasoning (Module 2)
 * Sends goal + history + screenshot to Gemini (v1beta) and gets back
 * the spoken step and the element to point at, as JSON with a [y, x] 0–1000 point.
 *
 * Reliability: primary model → fallback model on overload (503/429) or
 * unknown model (404), with exponential backoff + jitter.
 */
const { GoogleGenerativeAI } = require('@google/generative-ai');

const SYSTEM_PROMPT = `You are Glance, a patient software tutor that watches the user's screen.
The user wants to LEARN how to do a task themselves. You TEACH, you never DO.

Each turn you receive the user's goal, the steps you already gave, and a fresh screenshot of the user's current screen.
Look at the screenshot carefully and decide the single next action the user should take.

Rules:
- Give exactly ONE small step at a time (one click, one key combo, or one thing to type).
- Speak naturally and briefly (max ~25 words), as if sitting next to the user. Mention the element by its visible name.
- Point at the exact element the user must interact with.
- You may point and explain, but you never claim to click or type for the user.
- Compare the screenshot with the previous step: if the previous step was not done yet or went wrong, say so kindly and re-point.
- If the goal is already achieved on screen, set "done" to true, congratulate briefly, and use an empty point.
- If the target is not visible (e.g. off-screen or needs scrolling), tell the user how to reveal it and point at that control instead (e.g. the scrollbar or menu).

POINT FORMAT (critical): "point" is [y, x] — y FIRST — normalized to a 0–1000 grid over the screenshot
(0,0 = top-left, 1000,1000 = bottom-right). Point at the CENTRE of the target element.

Reply ONLY with JSON of this shape:
{"goal": string, "step": string, "target": string, "point": [y, x] or [], "done": boolean}
"goal" restates the user's goal in their words (if the goal came as audio, transcribe it here).`;

const RETRYABLE = new Set([429, 500, 503]);
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

/** Build the multi-turn contents. History is replayed every turn so the model remembers prior steps. */
function buildContents({ goal, goalAudio, history, imageB64, imageMime }) {
  const image = { inlineData: { mimeType: imageMime, data: imageB64 } };
  const goalParts = goalAudio
    ? [{ text: "The user's goal is spoken in this audio clip:" }, { inlineData: { mimeType: goalAudio.mimeType, data: goalAudio.data } }]
    : [{ text: `GOAL: ${goal}` }];

  const contents = [];
  if (!history || history.length === 0) {
    contents.push({ role: 'user', parts: [...goalParts, { text: 'Here is my current screen. What is the first step?' }, image] });
    return contents;
  }
  contents.push({ role: 'user', parts: [...goalParts, { text: '(Screenshot omitted for earlier turns.)' }] });
  history.forEach((h, i) => {
    contents.push({
      role: 'model',
      parts: [{ text: JSON.stringify({ goal: goal || '', step: h.step, target: h.target || '', point: h.point || [], done: !!h.done }) }],
    });
    const last = i === history.length - 1;
    const note = h.userNote ? ` Note from me: ${h.userNote}` : '';
    contents.push({
      role: 'user',
      parts: last
        ? [{ text: `I acted on that step and my screen changed.${note} Here is my screen now. What is the next step?` }, image]
        : [{ text: `Done.${note}` }],
    });
  });
  return contents;
}

class Vision {
  constructor({ apiKey, primaryModel, fallbackModel, log = console }) {
    this.mock = process.env.GLANCE_MOCK === '1';
    if (!apiKey && !this.mock) throw new Error('GEMINI_API_KEY is not set. Copy .env.example to .env and add your key.');
    this.client = this.mock ? null : new GoogleGenerativeAI(apiKey);
    this.models = [primaryModel, fallbackModel].filter(Boolean);
    this.log = log;
  }

  _model(name) {
    return this.client.getGenerativeModel(
      {
        model: name,
        systemInstruction: SYSTEM_PROMPT,
        generationConfig: { responseMimeType: 'application/json' },
      },
      { apiVersion: 'v1beta', timeout: 60000 },
    );
  }

  async _withFallback(fn) {
    const plan = this.models.map((m, i) => ({ model: m, retries: i === this.models.length - 1 ? 3 : 1 }));
    let lastErr;
    for (const { model, retries } of plan) {
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const out = await fn(model);
          return { ...out, model };
        } catch (err) {
          lastErr = err;
          const st = statusOf(err);
          this.log.warn(`[vision] ${model} attempt ${attempt + 1} failed (${st || 'no status'}): ${err.message}`);
          if (st === 404) break;                    // unknown model → next model
          if (!RETRYABLE.has(st)) throw err;        // auth / bad request → surface now
          if (attempt < retries) await sleep(800 * 2 ** attempt + Math.random() * 400);
        }
      }
    }
    throw lastErr;
  }

  /**
   * @returns {Promise<{goal, step, target, point, done, model}>}  point is raw [y,x] 0–1000 (or [])
   */
  async nextStep({ goal, goalAudio, history, imageB64, imageMime = 'image/jpeg' }) {
    if (this.mock) {
      await sleep(400);
      const n = (history || []).length;
      return {
        goal: goal || '(mock goal)',
        step: n >= 3 ? 'Mock run finished — that was the last step.' : `Mock step ${n + 1}: look at the centre of your screen.`,
        target: 'screen centre',
        point: n >= 3 ? [] : [500, 500],
        done: n >= 3,
        model: 'mock',
      };
    }
    const contents = buildContents({ goal, goalAudio, history, imageB64, imageMime });
    return this._withFallback(async (modelName) => {
      const res = await this._model(modelName).generateContent({ contents });
      const json = extractJson(res.response.text());
      return {
        goal: typeof json.goal === 'string' ? json.goal : goal,
        step: String(json.step || '').trim(),
        target: String(json.target || '').trim(),
        point: json.point,
        done: !!json.done,
      };
    });
  }
}

module.exports = { Vision, SYSTEM_PROMPT, buildContents, extractJson, statusOf };
