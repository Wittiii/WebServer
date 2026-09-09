const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Database = require('better-sqlite3');
const { backupDatabase } = require('../scripts/backup-database');

test('backup includes committed WAL data, preserves source and never overwrites an older backup', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-backup-test-'));
  let source;
  t.after(async () => {
    if (source?.open) source.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const databasePath = path.join(root, 'source.db');
  const envPath = path.join(root, 'source.env');
  await fs.writeFile(envPath, 'TEST_CONFIG=local-test-only\n');
  source = new Database(databasePath);
  source.pragma('journal_mode = WAL');
  source.pragma('wal_autocheckpoint = 0');
  source.exec('CREATE TABLE readings (value INTEGER); INSERT INTO readings VALUES (42)');
  assert.ok((await fs.stat(databasePath + '-wal')).size > 0);
  const options = { databasePath, destinationRoot: path.join(root, 'backups'), envPath };
  const first = await backupDatabase(options);
  assert.equal(first.envCopied, true);
  assert.equal(await fs.readFile(path.join(first.directory, '.env'), 'utf8'), 'TEST_CONFIG=local-test-only\n');
  source.exec('INSERT INTO readings VALUES (43)');
  const second = await backupDatabase(options);
  assert.notEqual(first.directory, second.directory);
  for (const [result, count] of [[first, 1], [second, 2]]) {
    const copy = new Database(result.database, { readonly: true, fileMustExist: true });
    try { assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM readings').get().n, count); }
    finally { copy.close(); }
  }
  assert.equal(source.prepare('SELECT COUNT(*) AS n FROM readings').get().n, 2);
});

test('missing backup source fails without creating an empty database', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-backup-missing-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'missing.db');
  await assert.rejects(backupDatabase({ databasePath, destinationRoot: root }), /unable to open/);
  await assert.rejects(fs.stat(databasePath), { code: 'ENOENT' });
});
