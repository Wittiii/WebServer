const { Store } = require('express-session');

// Single-process session storage with proactive expiry and hard memory bounds.
// Like the previous MemoryStore, sessions deliberately do not survive restarts.
class BoundedMemorySessionStore extends Store {
  constructor({ maxEntries = 1000, maxSessionBytes = 16 * 1024, ttlMs = 60 * 60 * 1000, sweepMs = 60 * 1000, now = Date.now } = {}) {
    super();
    for (const value of [maxEntries, maxSessionBytes, ttlMs, sweepMs]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('Session store limits must be positive integers');
    }
    this.maxEntries = maxEntries;
    this.maxSessionBytes = maxSessionBytes;
    this.ttlMs = ttlMs;
    this.now = now;
    this.sessions = new Map();
    this.timer = setInterval(() => this.prune(), sweepMs);
    this.timer.unref();
  }

  prune() {
    const now = this.now();
    for (const [id, entry] of this.sessions) {
      if (entry.expiresAt <= now) this.sessions.delete(id);
    }
  }

  get(id, callback) {
    const entry = this.sessions.get(id);
    if (!entry || entry.expiresAt <= this.now()) {
      this.sessions.delete(id);
      return setImmediate(callback, null, null);
    }
    return setImmediate(callback, null, JSON.parse(entry.json));
  }

  set(id, value, callback) {
    let error;
    try {
      const json = JSON.stringify(value);
      if (Buffer.byteLength(json) > this.maxSessionBytes) throw new Error('Session is too large');
      if (!this.sessions.has(id) && this.sessions.size >= this.maxEntries) this.prune();
      if (!this.sessions.has(id) && this.sessions.size >= this.maxEntries) throw new Error('Session capacity reached');
      const configuredExpiry = value.cookie?.expires ? new Date(value.cookie.expires).getTime() : NaN;
      const expiresAt = Math.min(
        this.now() + this.ttlMs,
        Number.isFinite(configuredExpiry) ? configuredExpiry : Infinity
      );
      this.sessions.set(id, { json, expiresAt });
    } catch (cause) {
      error = cause;
    }
    if (callback) setImmediate(callback, error);
  }

  touch(id, value, callback) {
    const entry = this.sessions.get(id);
    if (!entry || entry.expiresAt <= this.now()) {
      this.sessions.delete(id);
      if (callback) setImmediate(callback);
      return;
    }
    const current = JSON.parse(entry.json);
    current.cookie = value.cookie;
    this.set(id, current, callback);
  }

  destroy(id, callback) {
    this.sessions.delete(id);
    if (callback) setImmediate(callback);
  }

  clear(callback) {
    this.sessions.clear();
    if (callback) setImmediate(callback);
  }

  length(callback) {
    this.prune();
    setImmediate(callback, null, this.sessions.size);
  }

  close() {
    clearInterval(this.timer);
    this.sessions.clear();
  }
}

module.exports = { BoundedMemorySessionStore };
