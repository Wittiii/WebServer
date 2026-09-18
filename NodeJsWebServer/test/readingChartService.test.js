const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { readChart } = require('../src/services/readingChartService');

test('chart spans more than a day even with thousands of readings and stays bounded', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE object_readings (id INTEGER PRIMARY KEY, object_id INTEGER,
    topic TEXT, value_key TEXT, value_text TEXT, raw_payload TEXT, created_at TEXT)`);
  const start = Date.parse('2026-09-01T00:00:00Z');
  const insert = db.prepare('INSERT INTO object_readings VALUES (?, 1, ?, ?, ?, ?, ?)');
  db.transaction(() => {
    for (let i = 0; i < 12000; i++) {
      insert.run(i + 1, 'sensor/temp', 'temperature', String(i), '{}', new Date(start + i * 60000).toISOString());
    }
    insert.run(12001, 'sensor/humidity', 'humidity', '80', '{}', new Date(start).toISOString());
  })();
  const full = readChart(db, { objectId: 1, key: 'temperature' });
  assert.equal(full.total, 12000);
  assert.equal(full.readings.length, 2000);
  assert.equal(full.sampled, true);
  assert.equal(full.readings[0].id, 12000);
  assert.equal(full.readings.at(-1).id, 1);
  assert.ok(Date.parse(full.to) - Date.parse(full.from) > 7 * 86400000);
  assert.equal(new Set(full.readings.map((r) => r.id)).size, 2000);
  assert.equal(full.readings.some((r) => r.value_key === 'humidity'), false);

  const from = new Date(start + 2 * 86400000).toISOString();
  const to = new Date(start + 3 * 86400000).toISOString();
  const day = readChart(db, { objectId: 1, key: 'temperature', from, to });
  assert.equal(day.total, 1441);
  assert.equal(day.readings.length, 1441);
  assert.equal(day.sampled, false);
  assert.equal(day.from, from);
  assert.equal(day.to, to);
  assert.equal(readChart(db, { objectId: 2 }).total, 0);
  assert.equal(readChart(db, { objectId: 1, topic: 'sensor/humidity' }).total, 1);
  const pair = readChart(db, { objectId: 1, key: 'temperature', limit: 2 });
  assert.deepEqual(pair.readings.map((r) => r.id), [12000, 1]);
  assert.equal(readChart(db, { objectId: 1, limit: 1000000 }).readings.length, 5000);
});

test('chart orders by measurement time even when insertion order differs', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE object_readings (id INTEGER PRIMARY KEY, object_id INTEGER,
    topic TEXT, value_key TEXT, value_text TEXT, raw_payload TEXT, created_at TEXT);
    INSERT INTO object_readings VALUES
      (1,1,'t','k','10','{}','2026-09-03T00:00:00.000Z'),
      (2,1,'t','k','20','{}','2026-09-01T00:00:00.000Z'),
      (3,1,'t','k','30','{}','2026-09-02T00:00:00.000Z');`);
  assert.deepEqual(readChart(db, { objectId: 1, limit: 2 }).readings.map((r) => r.id), [1, 2]);
});
