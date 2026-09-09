const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createRetentionCleanup } = require('../src/services/retentionCleanupService');

test('retention drains a backlog in bounded batches and preserves readings inside retention', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE readings (id INTEGER PRIMARY KEY, received_at_ms INTEGER); CREATE INDEX times ON readings(received_at_ms)');
    const insert = db.prepare('INSERT INTO readings (received_at_ms) VALUES (?)');
    db.transaction(() => { for (let i = 0; i < 1005; i++) insert.run(1); insert.run(200); })();
    const cleanup = createRetentionCleanup(db.prepare(`DELETE FROM readings WHERE id IN (
      SELECT id FROM readings WHERE received_at_ms < ? ORDER BY received_at_ms LIMIT ?
    )`));
    const count = () => db.prepare('SELECT COUNT(*) AS n FROM readings').get().n;
    cleanup(1000, 100);
    assert.equal(count(), 506);
    cleanup(1500, 100);
    assert.equal(count(), 506);
    cleanup(2000, 100);
    assert.equal(count(), 6);
    cleanup(3000, 100);
    assert.equal(count(), 1);
    assert.equal(db.prepare('SELECT received_at_ms FROM readings').get().received_at_ms, 200);
    insert.run(1);
    cleanup(4000, 100);
    assert.equal(count(), 2); // No need for another full check until tomorrow.
    cleanup(500, 100);
    assert.equal(count(), 1); // An NTP clock correction must not suspend cleanup.
  } finally { db.close(); }
});

test('a failed cleanup can be retried immediately after a transient database error', () => {
  let attempts = 0;
  const cleanup = createRetentionCleanup({ run() {
    if (++attempts === 1) throw new Error('SQLITE_BUSY');
    return { changes: 0 };
  } });
  assert.throws(() => cleanup(1000, 100), /SQLITE_BUSY/);
  cleanup(1000, 100);
  assert.equal(attempts, 2);
});
