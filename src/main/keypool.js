'use strict';
/**
 * API key pool — spreads requests over several Gemini keys and sidelines a key
 * when it is rate-limited.
 *
 * Quota on the Gemini API is counted per project AND per model, so cooldowns are tracked per
 * (key, model): a key that is out of quota for the primary model may still work for the fallback.
 *
 * Pure logic (no Electron, no network) so it is unit-tested with an injected clock.
 */

const DEFAULT_RPM_COOLDOWN_MS = 60 * 1000;        // unknown 429 → assume a per-minute window
const DAILY_COOLDOWN_MS = 30 * 60 * 1000;         // per-day quota → re-probe every 30 min (resets midnight Pacific)
const MIN_COOLDOWN_MS = 2000;
const MAX_COOLDOWN_MS = 60 * 60 * 1000;

/** GEMINI_API_KEYS=a,b,c (commas / newlines / spaces) plus the legacy single GEMINI_API_KEY. De-duplicated. */
function parseKeys(env = process.env) {
  const raw = [env.GEMINI_API_KEYS, env.GEMINI_API_KEY].filter(Boolean).join(',');
  const keys = raw
    .split(/[\s,;]+/)
    .map((k) => k.trim().replace(/^["']|["']$/g, ''))
    .filter((k) => k && k !== 'your_key_here');
  return [...new Set(keys)];
}

const mask = (key) => `...${String(key).slice(-4)}`;

/** How long should a 429'd key rest? Reads Google's retryDelay when present. */
function cooldownFromError(err, now = Date.now()) {
  const text = `${err && err.message ? err.message : ''} ${safeJson(err && err.errorDetails)}`;
  if (/PerDay|per day|requests_per_day/i.test(text)) return { ms: DAILY_COOLDOWN_MS, daily: true };
  let ms = 0;
  const m = /retry(?:Delay)?"?\s*(?:in|:)?\s*"?([\d.]+)\s*s/i.exec(text);
  if (m) ms = Math.ceil(parseFloat(m[1]) * 1000) + 500;
  if (!ms) ms = DEFAULT_RPM_COOLDOWN_MS;
  return { ms: Math.min(MAX_COOLDOWN_MS, Math.max(MIN_COOLDOWN_MS, ms)), daily: false };
}

function safeJson(v) { try { return v ? JSON.stringify(v) : ''; } catch { return ''; } }

class KeyPool {
  /**
   * @param {string[]} keys
   * @param {{ now?: () => number, log?: Console }} [opts]
   */
  constructor(keys, { now = Date.now, log = console } = {}) {
    this.entries = keys.map((key, i) => ({ key, id: i + 1, label: `key #${i + 1} (${mask(key)})`, dead: false, until: new Map() }));
    this.now = now;
    this.log = log;
    this.cursor = 0;            // round-robin start; advances on every acquire
  }

  get size() { return this.entries.length; }
  get alive() { return this.entries.filter((e) => !e.dead).length; }

  /** Next usable entry for this model (round-robin), or null if every key is cooling down / dead. */
  acquire(model) {
    const n = this.entries.length;
    const t = this.now();
    for (let i = 0; i < n; i++) {
      const e = this.entries[(this.cursor + i) % n];
      if (e.dead) continue;
      if ((e.until.get(model) || 0) > t) continue;
      this.cursor = (this.cursor + i + 1) % n;     // next request starts after this key → spreads load
      return e;
    }
    return null;
  }

  /** Is any key usable for this model right now? (does not advance the rotation) */
  hasUsable(model) {
    const t = this.now();
    return this.entries.some((e) => !e.dead && (e.until.get(model) || 0) <= t);
  }

  /** Put an entry on cooldown for one model. Returns the cooldown in ms. */
  cooldown(entry, model, ms) {
    entry.until.set(model, this.now() + ms);
    return ms;
  }

  /** Permanently sideline an entry (invalid / revoked key). */
  disable(entry) { entry.dead = true; }

  /** ms until some key is usable for ANY of these models; 0 if one already is, Infinity if all keys are dead. */
  soonestAvailableMs(models) {
    const t = this.now();
    let best = Infinity;
    for (const e of this.entries) {
      if (e.dead) continue;
      for (const m of models) best = Math.min(best, Math.max(0, (e.until.get(m) || 0) - t));
    }
    return best;
  }

  /** For logs / debugging. */
  snapshot() {
    const t = this.now();
    return this.entries.map((e) => ({
      key: e.label,
      dead: e.dead,
      cooling: Object.fromEntries([...e.until].filter(([, u]) => u > t).map(([m, u]) => [m, Math.ceil((u - t) / 1000) + 's'])),
    }));
  }
}

module.exports = { KeyPool, parseKeys, cooldownFromError, mask, DEFAULT_RPM_COOLDOWN_MS, DAILY_COOLDOWN_MS };
