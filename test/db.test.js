'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Database, similarity, normGoal } = require('../src/main/db');

const step = (i, extra = {}) => ({ i, at: new Date(), status: 'next', step: `step ${i}`, target: 't', type_text: '', keys: '', point: [1, 2], pointer: { x: 1, y: 2 }, model: 'm', ...extra });

async function exercise(t, db) {
  try { await run(db); } finally { await db.close(); }
}

async function run(db) {
  const user = await db.init('tester', 'Tester');
  assert.ok(user.id);

  const id = await db.startSession('Deploy a web server on AWS EC2');
  await db.appendStep(id, step(0), { goal: 'Deploy a web server on AWS EC2', plan: ['Open EC2', 'Launch'], planIndex: 0, done: false });
  await db.appendStep(id, step(1, { type_text: 'sudo apt install nginx' }), { plan: ['Open EC2', 'Launch'], planIndex: 1, done: false });
  await db.appendStep(id, step(2, { status: 'done' }), { plan: ['Open EC2', 'Launch'], planIndex: 1, done: true });

  const s = await db.getSession(id);
  assert.equal(s.status, 'completed');
  assert.equal(s.steps.length, 3);
  assert.deepEqual(s.plan, ['Open EC2', 'Launch']);

  const list = await db.listSessions({ limit: 10 });
  assert.ok(list.some((x) => x.id === id));
  const found = await db.listSessions({ search: 'aws' });
  assert.ok(found.some((x) => x.id === id));

  const reuse = await db.findReusable('deploy web server on aws ec2');
  assert.ok(reuse, 'similar goal should be reusable');
  assert.equal(reuse.id, id);
  assert.equal(reuse.steps[1].type_text, 'sudo apt install nginx');
  assert.equal(await db.findReusable('change desktop wallpaper'), null);

  const id2 = await db.startSession('Open settings');
  await db.endSession(id2, 'stopped');
  assert.equal((await db.getSession(id2)).status, 'stopped');
  await db.appendStep(id2, step(0), { planIndex: 0, done: false });  // resume
  assert.equal((await db.getSession(id2)).status, 'active');

  await db.deleteSession(id2);
  assert.equal(await db.getSession(id2), null);
  await db.deleteSession(id);
}

test('similarity / normGoal', () => {
  assert.equal(normGoal('How do I open the Settings?'), 'open settings');
  assert.ok(similarity('deploy web server on AWS', 'Deploy a web server on AWS EC2') >= 0.6);
  assert.ok(similarity('open settings', 'deploy server') === 0);
});

test('local JSON store', async (t) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glance-')), 'db.json');
  const db = new Database({ uri: '', dbName: 'x', localFile: file, log: { warn() {} } });
  await exercise(t, db);
  assert.equal(db.kind, 'local');
  assert.ok(fs.existsSync(file));
});

test('MongoDB store (skipped if no server at MONGODB_TEST_URI)', async (t) => {
  const uri = process.env.MONGODB_TEST_URI;
  if (!uri) { t.skip('set MONGODB_TEST_URI to run'); return; }
  const db = new Database({ uri, dbName: `glance_test_${Date.now()}`, localFile: '/dev/null', log: { warn() {} } });
  await exercise(t, db);
  assert.equal(db.kind, 'mongodb');
});

test('falls back to local store when MongoDB is unreachable', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'glance-')), 'db.json');
  const db = new Database({ uri: 'mongodb://127.0.0.1:1', dbName: 'x', localFile: file, log: { warn() {} } });
  await db.init('u', 'U');
  assert.equal(db.kind, 'local');
  assert.match(db.error, /MongoDB unavailable/);
  await db.close();
});
