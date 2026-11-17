const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('dashboard reports the configured database and includes its WAL size', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'iot-dashboard-system-'));
  const filename = path.join(directory, 'custom.db');
  process.env.DATABASE_PATH = filename;
  process.env.SQLITE_JOURNAL_MODE = 'WAL';
  const db = require('../src/database/db');
  const { createOnlineDatabaseBackup, getStorageBreakdown } = require('../src/services/databaseMaintenanceService');
  t.after(() => {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(filename + suffix)) fs.unlinkSync(filename + suffix);
    fs.rmdirSync(directory);
  });
  const { getDashboardSystem } = require('../src/controllers/dashboardController');
  let data;
  await getDashboardSystem({}, { json: (body) => { data = body; }, status: () => { throw new Error('request failed'); } });
  assert.equal(data.database.path, filename);
  assert.equal(data.database.mainBytes, fs.statSync(filename).size);
  assert.equal(data.database.walBytes, fs.statSync(filename + '-wal').size);
  assert.equal(data.database.sizeBytes, data.database.mainBytes + data.database.walBytes);
  assert.ok(data.database.walBytes > 0);
  assert.ok(data.storage.breakdown);

  const breakdown = await getStorageBreakdown(db);
  assert.ok(breakdown.totalDatabaseBytes >= data.database.mainBytes);
  assert.equal(typeof breakdown.timelapseBytes, 'number');
  assert.equal(typeof breakdown.clipsBytes, 'number');

  const backup = await createOnlineDatabaseBackup(db);
  try {
    assert.match(backup.filename, /^backup-\d{8}-\d{6}\.db$/);
    assert.ok(backup.sizeBytes > 0);
    assert.equal(fs.existsSync(backup.filePath), true);
  } finally {
    await backup.cleanup();
    assert.equal(fs.existsSync(backup.filePath), false);
  }
});
