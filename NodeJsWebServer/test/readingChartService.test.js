const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { readChart } = require('../src/services/readingChartService');

test('chart spans more than a day even with thousands of readings and stays bounded', async (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE object_readings (id INTEGER PRIMARY KEY, object_id INTEGER,
    topic TEXT, value_key TEXT, value_text TEXT, raw_payload TEXT, created_at TEXT); CREATE INDEX idx_test_key_time ON object_readings(object_id,value_key,created_at,id); CREATE INDEX idx_test_time ON object_readings(object_id,created_at,id)`);
  const start = Date.parse('2026-09-01T00:00:00Z');
  const insert = db.prepare('INSERT INTO object_readings VALUES (?, 1, ?, ?, ?, ?, ?)');
  db.transaction(() => {
    for (let i = 0; i < 12000; i++) {
      insert.run(i + 1, 'sensor/temp', 'temperature', String(i), '{}', new Date(start + i * 60000).toISOString());
    }
    insert.run(12001, 'sensor/humidity', 'humidity', '80', '{}', new Date(start).toISOString());
  })();
  const full = await readChart(db, { objectId: 1, key: 'temperature' });
  assert.equal(Object.hasOwn(full.readings[0], 'raw_payload'), false);
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
  const day = await readChart(db, { objectId: 1, key: 'temperature', from, to });
  assert.equal(day.total, 1441);
  assert.equal(day.readings.length, 1441);
  assert.equal(day.sampled, false);
  assert.equal(day.from, from);
  assert.equal(day.to, to);
  assert.equal((await readChart(db, { objectId: 2 })).total, 0);
  assert.equal((await readChart(db, { objectId: 1, topic: 'sensor/humidity' })).total, 1);
  const pair = await readChart(db, { objectId: 1, key: 'temperature', limit: 2 });
  assert.deepEqual(pair.readings.map((r) => r.id), [12000, 1]);
  assert.equal((await readChart(db, { objectId: 1, limit: 1000000 })).readings.length, 5000);
});

test('chart yields without a transaction, bounds concurrency and cancels obsolete requests', async (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE object_readings(id INTEGER PRIMARY KEY,object_id INTEGER,topic TEXT,value_key TEXT,value_text TEXT,raw_payload TEXT,created_at TEXT);
    CREATE INDEX idx_chart_time ON object_readings(object_id,value_key,created_at,id);
    WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<10000)
    INSERT INTO object_readings SELECT i,1,'t','k','20','{}',strftime('%Y-%m-%dT%H:%M:%fZ','2026-01-01','+'||i||' seconds') FROM n;`);
  const query = { objectId: 1, key: 'k', limit: 200 };
  const controller = new AbortController();
  let yielded = false;
  setImmediate(() => {
    yielded = true;
    assert.equal(db.inTransaction, false);
    controller.abort();
  });
  const results = await Promise.allSettled([
    readChart(db, query, { signal: controller.signal }), readChart(db, query),
    readChart(db, query), readChart(db, query),
  ]);
  assert.equal(yielded, true);
  assert.equal(results[0].reason.name, 'AbortError');
  assert.equal(results[1].status, 'fulfilled');
  assert.equal(results[2].status, 'fulfilled');
  assert.equal(results[3].reason.code, 'CHART_BUSY');
  assert.equal((await readChart(db, query)).readings.length, 200);
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM object_readings
    WHERE object_id=? AND value_key=? AND created_at>=? ORDER BY created_at,id LIMIT 1`).all(1,'k','2026-01-01');
  assert.ok(plan.some((row) => row.detail.includes('idx_chart_time')));
  assert.ok(plan.every((row) => !row.detail.includes('TEMP B-TREE')));
});

test('large text and raw payloads cannot inflate a graph response and source data stays intact', async (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE object_readings(id INTEGER PRIMARY KEY,object_id INTEGER,topic TEXT,value_key TEXT,value_text TEXT,raw_payload TEXT,created_at TEXT)');
  db.prepare('INSERT INTO object_readings VALUES(1,1,?,?,?,?,?)').run('t','k','x'.repeat(65536),'y'.repeat(65536),'2026-01-01T00:00:00.000Z');
  const result = await readChart(db, { objectId: 1 });
  assert.equal(result.readings[0].value_text, null);
  assert.equal(result.omittedTextValues, 1);
  assert.ok(JSON.stringify(result).length < 1000);
  assert.equal(db.prepare('SELECT length(raw_payload) AS size FROM object_readings').get().size, 65536);
});

test('chart orders by measurement time even when insertion order differs', async (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE object_readings (id INTEGER PRIMARY KEY, object_id INTEGER,
    topic TEXT, value_key TEXT, value_text TEXT, raw_payload TEXT, created_at TEXT);
    INSERT INTO object_readings VALUES
      (1,1,'t','k','10','{}','2026-09-03T00:00:00.000Z'),
      (2,1,'t','k','20','{}','2026-09-01T00:00:00.000Z'),
      (3,1,'t','k','30','{}','2026-09-02T00:00:00.000Z');`);
  assert.deepEqual((await readChart(db, { objectId: 1, limit: 2 })).readings.map((r) => r.id), [1, 2]);
});
