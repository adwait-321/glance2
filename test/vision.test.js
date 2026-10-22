'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildContents, extractJson, statusOf } = require('../src/main/vision');

test('first turn: goal + screenshot in one user message', () => {
  const c = buildContents({ goal: 'make a new folder', history: [], imageB64: 'AAA', imageMime: 'image/jpeg' });
  assert.equal(c.length, 1);
  assert.equal(c[0].role, 'user');
  assert.ok(c[0].parts.some((p) => p.inlineData && p.inlineData.data === 'AAA'));
});

test('history is replayed, only last user turn carries the screenshot', () => {
  const history = [{ step: 's1', point: [1, 2] }, { step: 's2', point: [3, 4] }];
  const c = buildContents({ goal: 'g', history, imageB64: 'IMG', imageMime: 'image/jpeg' });
  assert.deepEqual(c.map((m) => m.role), ['user', 'model', 'user', 'model', 'user']);
  const imgs = c.flatMap((m) => m.parts).filter((p) => p.inlineData);
  assert.equal(imgs.length, 1);
  assert.ok(c[4].parts.some((p) => p.inlineData));
  assert.equal(JSON.parse(c[1].parts[0].text).step, 's1');
});

test('extractJson tolerates code fences / chatter', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! {"a":2} hope that helps'), { a: 2 });
});

test('statusOf reads SDK errors', () => {
  assert.equal(statusOf({ status: 503 }), 503);
  assert.equal(statusOf(new Error('[GoogleGenerativeAI Error]: ... [429 Too Many Requests] quota')), 429);
});

const { normalizeResponse, REPLAY_WINDOW, SYSTEM_PROMPT } = require('../src/main/vision');

test('normalizeResponse: clamps plan_index, coerces status, done → status done', () => {
  const r = normalizeResponse({ plan: ['a', 'b'], plan_index: 7, status: 'weird', step: ' hi ', point: [1, 2] }, 'g');
  assert.equal(r.plan_index, 1);
  assert.equal(r.status, 'next');
  assert.equal(r.step, 'hi');
  assert.equal(r.goal, 'g');
  const d = normalizeResponse({ plan: ['a', 'b', 'c'], plan_index: 0, done: true }, 'g');
  assert.equal(d.status, 'done');
  assert.equal(d.plan_index, 2);
  assert.equal(normalizeResponse({ status: 'WAIT' }, '').status, 'wait');
});

test('long sessions: older turns summarised, recent turns replayed, one screenshot', () => {
  const history = Array.from({ length: REPLAY_WINDOW + 5 }, (_, i) => ({ step: `s${i}`, status: 'next', plan: ['p'], plan_index: 0, userNote: i === 2 ? 'used eu-west-1' : '' }));
  const c = buildContents({ goal: 'deploy', history, imageB64: 'IMG', imageMime: 'image/jpeg' });
  assert.equal(c.length, 1 + REPLAY_WINDOW * 2);
  const introText = c[0].parts.map((p) => p.text || '').join('\n');
  assert.match(introText, /Earlier steps already given/);
  assert.match(introText, /eu-west-1/);
  assert.equal(c.flatMap((m) => m.parts).filter((p) => p.inlineData).length, 1);
});

test('reuse hint and user notes are injected', () => {
  const reuse = { goal: 'old goal', plan: ['x', 'y'], steps: [{ step: 'Click A', type_text: 'ls' }] };
  const c0 = buildContents({ goal: 'g', history: [], imageB64: 'I', imageMime: 'image/jpeg', reuse });
  assert.match(c0[0].parts.map((p) => p.text || '').join(' '), /previously completed a similar goal/);
  const c1 = buildContents({ goal: 'g', history: [{ step: 's', trigger: 'note', userNote: 'us-east-1' }], imageB64: 'I', imageMime: 'image/jpeg' });
  assert.match(c1[2].parts[0].text, /us-east-1/);
  assert.match(c1[2].parts[0].text, /I replied/);
});

test('system prompt covers the multi-step contract', () => {
  for (const k of ['PLAN', 'plan_index', '"retry"', '"recover"', '"wait"', '"ask"', 'type_text', '[y, x]']) assert.ok(SYSTEM_PROMPT.includes(k), k);
});

test('gesture actions: drag needs an end point, aliases normalised, scroll default', () => {
  const drag = normalizeResponse({ action: 'drag', point: [300, 300], end_point: [600, 700], step: 'Click and drag…' }, 'g');
  assert.equal(drag.action, 'drag');
  assert.deepEqual(drag.end_point, [600, 700]);
  assert.equal(normalizeResponse({ action: 'drag', point: [1, 2] }, 'g').action, 'click');          // no end → click
  assert.equal(normalizeResponse({ action: 'Double-Click', point: [1, 2] }, 'g').action, 'double_click');
  assert.equal(normalizeResponse({ action: 'scroll', point: [1, 2] }, 'g').scroll, 'down');
  assert.equal(normalizeResponse({ keys: 'Ctrl+S' }, 'g').action, 'key');
  assert.deepEqual(normalizeResponse({ action: 'click', point: [1, 2], end_point: [3, 4] }, 'g').end_point, []);
});

test('system prompt explains drags', () => {
  for (const k of ['"drag"', 'end_point', 'Click and drag', 'release', 'hint']) assert.ok(SYSTEM_PROMPT.includes(k), k);
});
