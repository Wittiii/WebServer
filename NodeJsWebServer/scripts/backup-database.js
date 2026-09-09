const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const Database = require('better-sqlite3');

// Importing db.js would run schema migrations. Backups open the source read-only.
async function backupDatabase({ databasePath, destinationRoot, envPath }) {
  const source = path.resolve(databasePath);
  const root = path.resolve(destinationRoot);
  const db = new Database(source, { readonly: true, fileMustExist: true });
  let directory;
  try {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    directory = await fs.mkdtemp(path.join(root, 'nodejs-backup-'));
    await fs.chmod(directory, 0o700);
    const target = path.join(directory, 'app.db');
    // SQLite's online backup includes committed WAL data and takes a consistent snapshot.
    await db.backup(target);
    await fs.chmod(target, 0o600);
    const copy = new Database(target, { readonly: true, fileMustExist: true });
    try {
      const result = copy.pragma('quick_check', { simple: true });
      if (result !== 'ok') throw new Error(`Database check failed: ${result}`);
    } finally {
      copy.close();
    }
    let envCopied = false;
    if (envPath) {
      try {
        await fs.copyFile(path.resolve(envPath), path.join(directory, '.env'), constants.COPYFILE_EXCL);
        await fs.chmod(path.join(directory, '.env'), 0o600);
        envCopied = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return { directory, database: target, envCopied };
  } catch (error) {
    if (directory) error.message += ` (incomplete backup kept at ${directory})`;
    throw error;
  } finally {
    db.close();
  }
}

async function main() {
  const destinationRoot = process.argv[2];
  if (!destinationRoot) throw new Error('Usage: npm run backup -- /path/outside/repository');
  const envPath = process.env.ENV_FILE || path.join(__dirname, '../src/config/.env');
  require('dotenv').config({ path: envPath });
  const result = await backupDatabase({
    databasePath: process.env.DATABASE_PATH || path.join(__dirname, '../src/database/app.db'),
    destinationRoot,
    envPath,
  });
  console.log(`Backup checked: ${result.database}`);
  console.log(result.envCopied ? 'Server configuration copied (.env).' : 'No .env found; environment supplied externally must be backed up separately.');
}

module.exports = { backupDatabase };
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
