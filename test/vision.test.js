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
