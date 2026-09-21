// Synthetic, in-memory workload. Does not load .env or open the application DB.
const Database = require('better-sqlite3');
const { performance } = require('node:perf_hooks');
const { readChart } = require('../src/services/readingChartService');

async function main() {
  const rows = Number(process.argv[2] || 100000);
  if (!Number.isInteger(rows) || rows < 10000 || rows > 500000) throw new Error('Use 10000–500000 synthetic rows.');
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE object_readings(id INTEGER PRIMARY KEY,object_id INTEGER,topic TEXT,value_key TEXT,value_text TEXT,raw_payload TEXT,created_at TEXT);
      CREATE INDEX idx_object_readings_object_key_time ON object_readings(object_id,value_key,created_at,id);
      CREATE INDEX idx_object_readings_object_time ON object_readings(object_id,created_at,id);`);
    db.prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<?)
      INSERT INTO object_readings SELECT i,1,'sensor/temp','temperature',CAST(i%100 AS TEXT),'{"temperature":20}',
      strftime('%Y-%m-%dT%H:%M:%fZ','2026-01-01','+'||i||' minutes') FROM n`).run(rows);
    const runs = [];
    for (let run = 0; run < 3; run++) {
      const started = performance.now();
      let lastTick = started, maxGap = 0, ticks = 0;
      const timer = setInterval(() => {
        const now = performance.now();
        maxGap = Math.max(maxGap, now - lastTick); lastTick = now; ticks++;
      }, 5);
      let result;
      try { result = await readChart(db, { objectId: 1, key: 'temperature' }); }
      finally { clearInterval(timer); }
      maxGap = Math.max(maxGap, performance.now() - lastTick);
      runs.push({ durationMs: Math.round(performance.now() - started), maxTimerGapMs: Math.round(maxGap),
        timerTicks: ticks, returned: result.readings.length, responseBytes: Buffer.byteLength(JSON.stringify(result)) });
    }
    console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
      rows, storage: 'synthetic in-memory database; excludes SD-card and camera load', runs }, null, 2));
  } finally { db.close(); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
