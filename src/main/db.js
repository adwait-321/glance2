'use strict';
/**
 * Database (Module 7) — MongoDB
 *
 * Collections
 *   users     { _id, username (unique), displayName, createdAt, lastSeenAt, stats: { sessions, completed } }
 *   sessions  { _id, userId, goal, goalNorm, status, startedAt, updatedAt, endedAt, reusedFrom,
 *               plan, planIndex, stepCount, models[], steps: [ StepRecord ] }
 *   StepRecord { i, at, trigger, userNote, observation, status, step, target, type_text, keys,
 *                point:[y,x], pointer:{x,y} (display points), planIndex, model }
 *
 * If MongoDB is unreachable the app keeps working on a local JSON file with the
 * same interface (status shows "local"), so guidance never breaks.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STOP = new Set('a an the to in on of for and or with my me i how do does can you please into from at by is it this that be using use'.split(' '));
function normGoal(g) {
  return String(g || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w)).join(' ');
}
function similarity(a, b) {
  const A = new Set(normGoal(a).split(' ').filter(Boolean));
  const B = new Set(normGoal(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

function summarize(s) {
  return {
    id: String(s._id),
    goal: s.goal,
    status: s.status,
    startedAt: s.startedAt,
    endedAt: s.endedAt || null,
    stepCount: s.stepCount || (s.steps ? s.steps.length : 0),
    plan: s.plan || [],
    reusedFrom: s.reusedFrom || null,
  };
}
function full(s) {
  return { ...summarize(s), userId: String(s.userId), steps: s.steps || [], models: s.models || [] };
}

// ───────────────────────── MongoDB store ─────────────────────────
class MongoStore {
  constructor(uri, dbName) { this.uri = uri; this.dbName = dbName; this.kind = 'mongodb'; }

  async connect() {
    const { MongoClient } = require('mongodb');
    this.ObjectId = require('mongodb').ObjectId;
    this.client = new MongoClient(this.uri, { serverSelectionTimeoutMS: 3000, appName: 'glance' });
    try { await this.client.connect(); } catch (e) { await this.client.close().catch(() => {}); throw e; }
    const db = this.client.db(this.dbName);
    this.users = db.collection('users');
    this.sessions = db.collection('sessions');
    await Promise.all([
      this.users.createIndex({ username: 1 }, { unique: true }),
      this.sessions.createIndex({ userId: 1, startedAt: -1 }),
      this.sessions.createIndex({ userId: 1, status: 1, goalNorm: 1 }),
    ]);
  }

  _id(id) { try { return new this.ObjectId(String(id)); } catch { return null; } }

  async ensureUser(username, displayName) {
    const now = new Date();
    const r = await this.users.findOneAndUpdate(
      { username },
      { $setOnInsert: { username, displayName: displayName || username, createdAt: now, stats: { sessions: 0, completed: 0 } }, $set: { lastSeenAt: now } },
      { upsert: true, returnDocument: 'after' },
    );
    const u = r && r.value !== undefined ? r.value : r;   // driver v5 vs v6 shape
    return { id: String(u._id), username: u.username, displayName: u.displayName, stats: u.stats || {} };
  }

  async startSession({ userId, goal, reusedFrom = null }) {
    const now = new Date();
    const doc = {
      userId: this._id(userId), goal, goalNorm: normGoal(goal), status: 'active',
      startedAt: now, updatedAt: now, endedAt: null, reusedFrom,
      plan: [], planIndex: 0, stepCount: 0, models: [], steps: [],
    };
    const r = await this.sessions.insertOne(doc);
    await this.users.updateOne({ _id: doc.userId }, { $inc: { 'stats.sessions': 1 } });
    return String(r.insertedId);
  }

  async appendStep(sessionId, step, { goal, plan, planIndex, done }) {
    const _id = this._id(sessionId);
    const now = new Date();
    const set = { updatedAt: now, planIndex };
    if (goal) { set.goal = goal; set.goalNorm = normGoal(goal); }
    if (plan && plan.length) set.plan = plan;
    if (done) { set.status = 'completed'; set.endedAt = now; } else { set.status = 'active'; set.endedAt = null; }
    const upd = { $push: { steps: step }, $inc: { stepCount: 1 }, $set: set };
    if (step.model) upd.$addToSet = { models: step.model };
    const before = done ? await this.sessions.findOne({ _id }, { projection: { status: 1, userId: 1 } }) : null;
    await this.sessions.updateOne({ _id }, upd);
    if (done && before && before.status !== 'completed') {
      await this.users.updateOne({ _id: before.userId }, { $inc: { 'stats.completed': 1 } });
    }
  }

  async endSession(sessionId, status) {
    await this.sessions.updateOne(
      { _id: this._id(sessionId), status: 'active' },
      { $set: { status, endedAt: new Date(), updatedAt: new Date() } },
    );
  }

  async endAllActive(userId, status = 'abandoned') {
    await this.sessions.updateMany({ userId: this._id(userId), status: 'active' }, { $set: { status, endedAt: new Date() } });
  }

  async listSessions(userId, { limit = 30, search = '' } = {}) {
    const q = { userId: this._id(userId) };
    if (search) q.goal = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const rows = await this.sessions.find(q, { projection: { steps: 0 } }).sort({ startedAt: -1 }).limit(limit).toArray();
    return rows.map(summarize);
  }

  async getSession(id) {
    const s = await this.sessions.findOne({ _id: this._id(id) });
    return s ? full(s) : null;
  }

  async deleteSession(userId, id) {
    await this.sessions.deleteOne({ _id: this._id(id), userId: this._id(userId) });
  }

  async completedCandidates(userId) {
    return this.sessions.find({ userId: this._id(userId), status: 'completed' }, { projection: { goal: 1, plan: 1, steps: 1, endedAt: 1 } })
      .sort({ endedAt: -1 }).limit(100).toArray();
  }

  async close() { try { await this.client.close(); } catch { /* ignore */ } }
}

// ───────────────────────── Local JSON fallback ─────────────────────────
class LocalStore {
  constructor(file) { this.file = file; this.kind = 'local'; this.data = { users: [], sessions: [] }; this.timer = null; }

  async connect() {
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* new file */ }
    this.data.users = this.data.users || [];
    this.data.sessions = this.data.sessions || [];
  }

  _save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    clearTimeout(this.timer);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  _s(id) { return this.data.sessions.find((s) => s._id === String(id)); }

  async ensureUser(username, displayName) {
    const now = new Date().toISOString();
    let u = this.data.users.find((x) => x.username === username);
    if (!u) {
      u = { _id: crypto.randomUUID(), username, displayName: displayName || username, createdAt: now, stats: { sessions: 0, completed: 0 } };
      this.data.users.push(u);
    }
    u.lastSeenAt = now;
    this._save();
    return { id: u._id, username: u.username, displayName: u.displayName, stats: u.stats };
  }

  async startSession({ userId, goal, reusedFrom = null }) {
    const now = new Date().toISOString();
    const s = { _id: crypto.randomUUID(), userId, goal, goalNorm: normGoal(goal), status: 'active', startedAt: now, updatedAt: now,
      endedAt: null, reusedFrom, plan: [], planIndex: 0, stepCount: 0, models: [], steps: [] };
    this.data.sessions.push(s);
    const u = this.data.users.find((x) => x._id === userId); if (u) u.stats.sessions++;
    this._save();
    return s._id;
  }

  async appendStep(sessionId, step, { goal, plan, planIndex, done }) {
    const s = this._s(sessionId); if (!s) return;
    const now = new Date().toISOString();
    s.steps.push(step); s.stepCount++; s.updatedAt = now; s.planIndex = planIndex;
    if (goal) { s.goal = goal; s.goalNorm = normGoal(goal); }
    if (plan && plan.length) s.plan = plan;
    if (step.model && !s.models.includes(step.model)) s.models.push(step.model);
    if (!done && s.status !== 'completed') { s.status = 'active'; s.endedAt = null; }
    if (done && s.status !== 'completed') {
      s.status = 'completed'; s.endedAt = now;
      const u = this.data.users.find((x) => x._id === s.userId); if (u) u.stats.completed++;
    }
    this._save();
  }

  async endSession(sessionId, status) {
    const s = this._s(sessionId);
    if (s && s.status === 'active') { s.status = status; s.endedAt = new Date().toISOString(); this._save(); }
  }

  async endAllActive(userId, status = 'abandoned') {
    for (const s of this.data.sessions) if (s.userId === userId && s.status === 'active') { s.status = status; s.endedAt = new Date().toISOString(); }
    this._save();
  }

  async listSessions(userId, { limit = 30, search = '' } = {}) {
    let rows = this.data.sessions.filter((s) => s.userId === userId);
    if (search) rows = rows.filter((s) => similarity(s.goal, search) > 0 || s.goal.toLowerCase().includes(search.toLowerCase()));
    return rows.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).slice(0, limit).map(summarize);
  }

  async getSession(id) { const s = this._s(id); return s ? full(s) : null; }

  async deleteSession(userId, id) {
    this.data.sessions = this.data.sessions.filter((s) => !(s._id === String(id) && s.userId === userId));
    this._save();
  }

  async completedCandidates(userId) {
    return this.data.sessions.filter((s) => s.userId === userId && s.status === 'completed')
      .sort((a, b) => (a.endedAt < b.endedAt ? 1 : -1)).slice(0, 100);
  }

  async close() { this.flush(); }
}

// ───────────────────────── Facade ─────────────────────────
class Database {
  constructor({ uri, dbName, localFile, log = console }) {
    this.uri = uri; this.dbName = dbName; this.localFile = localFile; this.log = log;
    this.store = null; this.user = null; this.error = null;
  }

  get kind() { return this.store ? this.store.kind : 'none'; }

  async init(username, displayName) {
    if (this.uri) {
      try {
        const m = new MongoStore(this.uri, this.dbName);
        await m.connect();
        this.store = m;
      } catch (e) {
        this.error = `MongoDB unavailable (${e.message}) — using local history file.`;
        this.log.warn('[db]', this.error);
      }
    }
    if (!this.store) {
      this.store = new LocalStore(this.localFile);
      await this.store.connect();
    }
    this.user = await this.store.ensureUser(username, displayName);
    await this.store.endAllActive(this.user.id, 'abandoned');   // sessions left open by a crash / quit
    return this.user;
  }

  startSession(goal, reusedFrom) { return this.store.startSession({ userId: this.user.id, goal, reusedFrom }); }
  appendStep(id, step, meta) { return this.store.appendStep(id, step, meta); }
  endSession(id, status) { return this.store.endSession(id, status); }
  listSessions(opts) { return this.store.listSessions(this.user.id, opts); }
  async getSession(id) {
    const s = await this.store.getSession(id);
    return s && s.userId === this.user.id ? s : null;
  }
  deleteSession(id) { return this.store.deleteSession(this.user.id, id); }

  /** Best previously-completed session for a similar goal (Jaccard ≥ threshold), condensed for the prompt. */
  async findReusable(goal, threshold = 0.6) {
    if (!goal) return null;
    const rows = await this.store.completedCandidates(this.user.id);
    let best = null, score = 0;
    for (const s of rows) {
      const sc = similarity(goal, s.goal);
      if (sc > score) { score = sc; best = s; }
    }
    if (!best || score < threshold) return null;
    return condense(best, score);
  }

  async reusableById(id) {
    const s = await this.getSession(id);
    return s ? condense({ ...s, _id: s.id }, 1) : null;
  }

  close() { return this.store ? this.store.close() : undefined; }
}

function condense(s, score) {
  const steps = (s.steps || [])
    .filter((st) => st.status !== 'wait' && st.status !== 'ask' && st.step)
    .map((st) => ({ step: st.step, action: st.action || '', target: st.target || '', type_text: st.type_text || '', keys: st.keys || '' }));
  return { id: String(s._id), goal: s.goal, plan: s.plan || [], steps, score };
}

module.exports = { Database, MongoStore, LocalStore, normGoal, similarity };
