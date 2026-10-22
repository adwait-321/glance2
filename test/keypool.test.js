'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { KeyPool, parseKeys, cooldownFromError } = require('../src/main/keypool');
const { Vision } = require('../src/main/vision');

const quiet = { log() {}, warn() {}, error() {} };

test('parseKeys: comma/newline lists, legacy single key, de-dupe, placeholder ignored', () => {
  assert.deepEqual(parseKeys({ GEMINI_API_KEYS: 'a, b\nc ; "d"' }), ['a', 'b', 'c', 'd']);
  assert.deepEqual(parseKeys({ GEMINI_API_KEYS: 'a,b', GEMINI_API_KEY: 'b' }), ['a', 'b']);
  assert.deepEqual(parseKeys({ GEMINI_API_KEY: 'solo' }), ['solo']);
  assert.deepEqual(parseKeys({ GEMINI_API_KEY: 'your_key_here' }), []);
  assert.deepEqual(parseKeys({}), []);
});

test('cooldownFromError: reads retry delay, detects daily quota, defaults to a minute', () => {
  assert.equal(cooldownFromError(new Error('[429] quota exceeded. Please retry in 12.3s.')).ms, 12800);
  assert.equal(cooldownFromError({ message: '429', errorDetails: [{ retryDelay: '7s' }] }).ms, 7500);
  const daily = cooldownFromError(new Error('quota metric GenerateRequestsPerDayPerProjectPerModel-FreeTier'));
  assert.equal(daily.daily, true);
  assert.equal(cooldownFromError(new Error('[429] too many')).ms, 60000);
});

test('pool: round-robins, skips cooling keys per model, recovers after cooldown', () => {
  let t = 1000;
  const pool = new KeyPool(['k1', 'k2', 'k3'], { now: () => t, log: quiet });
  assert.deepEqual([1, 2, 3, 1].map(() => pool.acquire('m').id), [1, 2, 3, 1]);
  pool.cooldown(pool.entries[1], 'm', 5000);                        // k2 rests on model m only
  const during = [1, 2, 3, 4].map(() => pool.acquire('m').id);
  assert.ok(!during.includes(2));                                   // k2 is resting for model m
  assert.ok(during.includes(1) && during.includes(3));
  assert.ok(pool.entries.every((e) => pool.hasUsable('other') && e));  // other model unaffected
  assert.equal(pool.soonestAvailableMs(['m']), 0);                  // k1/k3 still free
  t += 5001;
  const ids = new Set([1, 2, 3].map(() => pool.acquire('m').id));
  assert.ok(ids.has(2));                                            // k2 is back
});

test('pool: dead keys are never handed out; all dead → alive 0', () => {
  const pool = new KeyPool(['k1', 'k2'], { log: quiet });
  pool.disable(pool.entries[0]); pool.disable(pool.entries[1]);
  assert.equal(pool.alive, 0);
  assert.equal(pool.acquire('m'), null);
  assert.equal(pool.soonestAvailableMs(['m']), Infinity);
});

// ── Vision integration with a fake Gemini client ──
function visionWith(keys, behave, extra = {}) {
  const v = new Vision({ apiKeys: keys, primaryModel: 'primary', fallbackModel: 'fallback', log: quiet, maxKeyWaitMs: 0, backoffMs: 1, ...extra });
  const calls = [];
  v._model = (name, client) => ({
    generateContent: async () => {
      calls.push(`${client.apiKey}@${name}`);
      return behave(client.apiKey, name);
    },
  });
  return { v, calls };
}
const ok = (text = '{"step":"Click Save","plan":["a"],"point":[500,500],"action":"click"}') => ({ response: { text: () => text } });
const err = (status, msg = '') => Object.assign(new Error(`[${status}] ${msg}`), { status });
const args = { goal: 'g', history: [], imageB64: 'AAA' };

test('429 on one key → same request succeeds on the next key, no sleeping', async () => {
  const { v, calls } = visionWith(['k1', 'k2'], (key) => { if (key === 'k1') throw err(429, 'retry in 30s'); return ok(); });
  const r = await v.nextStep(args);
  assert.equal(r.step, 'Click Save');
  assert.equal(r.model, 'primary');
  assert.deepEqual(calls, ['k1@primary', 'k2@primary']);
});

test('a rate-limited key is skipped on later requests (until its cooldown ends)', async () => {
  const { v, calls } = visionWith(['k1', 'k2'], (key) => { if (key === 'k1') throw err(429, 'retry in 30s'); return ok(); });
  await v.nextStep(args);
  calls.length = 0;
  await v.nextStep(args); await v.nextStep(args);
  assert.deepEqual(calls, ['k2@primary', 'k2@primary']);
});

test('all keys out of quota on the primary model → fallback model with the same keys', async () => {
  const { v, calls } = visionWith(['k1', 'k2'], (key, model) => { if (model === 'primary') throw err(429); return ok(); });
  const r = await v.nextStep(args);
  assert.equal(r.model, 'fallback');
  assert.deepEqual(calls, ['k1@primary', 'k2@primary', 'k1@fallback']);
});

test('every key limited on every model → clear 429 error naming the wait, not a raw SDK error', async () => {
  const { v } = visionWith(['k1', 'k2'], () => { throw err(429, 'retry in 40s'); });
  await assert.rejects(() => v.nextStep(args), (e) => e.status === 429 && /All 2 API key\(s\) are rate-limited/.test(e.message) && /~4\ds/.test(e.message));
});

test('invalid key is disabled and skipped; the rest keep working', async () => {
  const { v, calls } = visionWith(['bad', 'good'], (key) => { if (key === 'bad') throw err(400, 'API key not valid. Please pass a valid API key.'); return ok(); });
  assert.equal((await v.nextStep(args)).step, 'Click Save');
  calls.length = 0;
  await v.nextStep(args);
  assert.deepEqual(calls, ['good@primary']);
});

test('all keys invalid → says so', async () => {
  const { v } = visionWith(['bad'], () => { throw err(400, 'API_KEY_INVALID'); });
  await assert.rejects(() => v.nextStep(args), /rejected as invalid/);
});

test('503 backs off, then moves to the next model; other 400s are not retried', async () => {
  const a = visionWith(['k1'], (key, model) => { if (model === 'primary') throw err(503); return ok(); });
  assert.equal((await a.v.nextStep(args)).model, 'fallback');
  const b = visionWith(['k1', 'k2'], () => { throw err(400, 'Invalid JSON payload'); });
  await assert.rejects(() => b.v.nextStep(args), /Invalid JSON payload/);
  assert.equal(b.calls.length, 1);
});

test('single legacy key still works (apiKey)', async () => {
  const v = new Vision({ apiKey: 'solo', primaryModel: 'p', log: quiet });
  assert.equal(v.pool.size, 1);
});

test('no keys and not mock → helpful error', () => {
  assert.throws(() => new Vision({ apiKeys: [], primaryModel: 'p', log: quiet }), /GEMINI_API_KEYS/);
});

test('404 (retired model) is skipped on later requests; fallback list can have several models', async () => {
  const v = new Vision({ apiKeys: ['k1'], primaryModel: 'p', fallbackModel: 'old, good', log: quiet, backoffMs: 1 });
  assert.deepEqual(v.models, ['p', 'old', 'good']);
  const calls = [];
  v._model = (name) => ({ generateContent: async () => { calls.push(name); if (name === 'p') throw err(503); if (name === 'old') throw err(404, 'no longer available'); return ok(); } });
  assert.equal((await v.nextStep(args)).model, 'good');
  calls.length = 0;
  await v.nextStep(args);
  assert.ok(!calls.includes('old'), `old model should be skipped, got ${calls}`);
});

test('an overloaded (503) model is tried last for a while so the next request goes straight to the healthy one', async () => {
  let t = 0;
  const v = new Vision({ apiKeys: ['k1', 'k2'], primaryModel: 'p', fallbackModel: 'f', log: quiet, backoffMs: 1, now: () => t });
  const calls = [];
  v._model = (name) => ({ generateContent: async () => { calls.push(name); if (name === 'p') throw err(503); return ok(); } });
  await v.nextStep(args);
  calls.length = 0;
  await v.nextStep(args);
  assert.deepEqual(calls, ['f']);                 // no wasted call on the overloaded primary
  t += 46000; calls.length = 0;
  await v.nextStep(args);
  assert.equal(calls[0], 'p');                    // primary is retried after the cooldown
});

test('final error explains what happened to every model instead of surfacing only the last raw error', async () => {
  const v = new Vision({ apiKeys: ['k1'], primaryModel: 'p', fallbackModel: 'old', log: quiet, backoffMs: 1 });
  v._model = (name) => ({ generateContent: async () => { throw name === 'p' ? err(503) : err(404); } });
  await assert.rejects(() => v.nextStep(args), (e) => /p: overloaded/.test(e.message) && /old: not available/.test(e.message) && /GLANCE_FALLBACK_MODEL/.test(e.message) && e.status === 503);
});
