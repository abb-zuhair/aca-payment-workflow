/**
 * Persistent session store backed by the app's existing SQLite database.
 *
 * Without this, express-session keeps sessions in memory: every restart or
 * redeploy logs everybody out, and sessions can't be shared across instances.
 * Storing them in the same DB file (on the data volume) makes logins survive
 * restarts and keeps everything in one backed-up place.
 */
const session = require('express-session');
const { db } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  sid     TEXT PRIMARY KEY,
  expires INTEGER NOT NULL,
  data    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);
`);

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000; // matches the cookie maxAge

class SqliteSessionStore extends session.Store {
  constructor(opts = {}) {
    super(opts);
    this.ttlMs = opts.ttlMs || DEFAULT_TTL_MS;
    this.purgeExpired();
    // tidy up expired rows periodically; unref so it never holds the process open
    const t = setInterval(() => this.purgeExpired(), 15 * 60 * 1000);
    if (t.unref) t.unref();
  }

  purgeExpired() {
    try { db.prepare(`DELETE FROM sessions WHERE expires <= ?`).run(Date.now()); }
    catch (e) { /* non-fatal */ }
  }

  _expiryFor(sess) {
    const maxAge = sess && sess.cookie && sess.cookie.maxAge ? Number(sess.cookie.maxAge) : this.ttlMs;
    return Date.now() + (isFinite(maxAge) && maxAge > 0 ? maxAge : this.ttlMs);
  }

  get(sid, cb) {
    try {
      const row = db.prepare(`SELECT data, expires FROM sessions WHERE sid=?`).get(sid);
      if (!row) return cb(null, null);
      if (row.expires <= Date.now()) {
        db.prepare(`DELETE FROM sessions WHERE sid=?`).run(sid);
        return cb(null, null);
      }
      return cb(null, JSON.parse(row.data));
    } catch (e) { return cb(e); }
  }

  set(sid, sess, cb) {
    try {
      db.prepare(`INSERT INTO sessions (sid,expires,data) VALUES (?,?,?)
                  ON CONFLICT(sid) DO UPDATE SET expires=excluded.expires, data=excluded.data`)
        .run(sid, this._expiryFor(sess), JSON.stringify(sess));
      return cb && cb(null);
    } catch (e) { return cb && cb(e); }
  }

  /* called on activity to slide the expiry without rewriting the payload */
  touch(sid, sess, cb) {
    try {
      db.prepare(`UPDATE sessions SET expires=? WHERE sid=?`).run(this._expiryFor(sess), sid);
      return cb && cb(null);
    } catch (e) { return cb && cb(e); }
  }

  destroy(sid, cb) {
    try {
      db.prepare(`DELETE FROM sessions WHERE sid=?`).run(sid);
      return cb && cb(null);
    } catch (e) { return cb && cb(e); }
  }

  length(cb) {
    try { cb(null, db.prepare(`SELECT COUNT(*) n FROM sessions WHERE expires > ?`).get(Date.now()).n); }
    catch (e) { cb(e); }
  }

  clear(cb) {
    try { db.prepare(`DELETE FROM sessions`).run(); return cb && cb(null); }
    catch (e) { return cb && cb(e); }
  }

  /* used when an account is locked or deactivated: kill that user's sessions */
  destroyForUser(userId) {
    try {
      const rows = db.prepare(`SELECT sid, data FROM sessions`).all();
      let n = 0;
      for (const r of rows) {
        try {
          const s = JSON.parse(r.data);
          if (s && s.user && s.user.id === userId) {
            db.prepare(`DELETE FROM sessions WHERE sid=?`).run(r.sid);
            n++;
          }
        } catch (e) { /* skip unparsable row */ }
      }
      return n;
    } catch (e) { return 0; }
  }
}

module.exports = { SqliteSessionStore };
