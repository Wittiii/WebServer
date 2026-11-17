const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const db = require('../database/db');

let optimizationRunning = false;

function readPragmaNumber(database, name) {
  return Number(database.pragma(name, { simple: true })) || 0;
}

function checkpointWal(database) {
  const journalMode = String(database.pragma('journal_mode', { simple: true })).toLowerCase();
  if (journalMode === 'wal') database.pragma('wal_checkpoint(TRUNCATE)');
}

function getAvailableDiskBytes(databasePath) {
  if (typeof fs.statfsSync !== 'function') return null;
  try {
    const stats = fs.statfsSync(path.dirname(databasePath), { bigint: true });
    return Number(stats.bavail * stats.bsize);
  } catch {
    return null;
  }
}

function getDatabaseStats(database = db) {
  const pageSizeBytes = readPragmaNumber(database, 'page_size');
  const pageCount = readPragmaNumber(database, 'page_count');
  const freePageCount = readPragmaNumber(database, 'freelist_count');
  const fileSizeBytes = fs.statSync(database.name).size;
  const availableDiskBytes = getAvailableDiskBytes(database.name);

  return {
    fileSizeBytes,
    pageSizeBytes,
    pageCount,
    freePageCount,
    reclaimableBytes: freePageCount * pageSizeBytes,
    availableDiskBytes,
    optimizationRunning
  };
}

function optimizeDatabase(database = db) {
  if (optimizationRunning) {
    const error = new Error('database_optimization_running');
    error.code = 'DATABASE_OPTIMIZATION_RUNNING';
    throw error;
  }

  optimizationRunning = true;

  try {
    checkpointWal(database);
    const before = { ...getDatabaseStats(database), optimizationRunning: false };
    const requiredFreeBytes = before.fileSizeBytes + (16 * 1024 ** 2);
    if (before.availableDiskBytes !== null && before.availableDiskBytes < requiredFreeBytes) {
      const error = new Error('database_optimization_insufficient_space');
      error.code = 'DATABASE_OPTIMIZATION_INSUFFICIENT_SPACE';
      error.requiredFreeBytes = requiredFreeBytes;
      error.availableDiskBytes = before.availableDiskBytes;
      throw error;
    }
    database.exec('VACUUM');
    checkpointWal(database);
    const after = { ...getDatabaseStats(database), optimizationRunning: false };
    return {
      before,
      after,
      reclaimedBytes: Math.max(0, before.fileSizeBytes - after.fileSizeBytes)
    };
  } finally {
    optimizationRunning = false;
  }
}

async function getDirectorySizeBytes(rootPath) {
  let total = 0;
  let entries;
  try {
    entries = await fs.promises.readdir(rootPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const fullPath = path.join(rootPath, entry.name);
    try {
      if (entry.isDirectory()) {
        total += await getDirectorySizeBytes(fullPath);
      } else if (entry.isFile()) {
        const stat = await fs.promises.stat(fullPath);
        total += Number(stat.size || 0);
      }
    } catch {
      // Ignore transient/vanished files while scanning media folders.
    }
  }
  return total;
}

function getOptionalFileSizeBytes(targetPath) {
  try {
    return Number(fs.statSync(targetPath).size || 0);
  } catch {
    return 0;
  }
}

async function getStorageBreakdown(database = db) {
  const dbStats = getDatabaseStats(database);
  const walBytes = getOptionalFileSizeBytes(`${database.name}-wal`);
  const shmBytes = getOptionalFileSizeBytes(`${database.name}-shm`);
  const dataRoot = path.resolve(process.cwd(), 'data');
  const diagnosticsDir = path.resolve(
    process.env.DIAGNOSTICS_DIR || path.join(process.cwd(), 'logs', 'diagnostics')
  );

  const [timelapseBytes, clipsBytes, diagnosticsBytes] = await Promise.all([
    getDirectorySizeBytes(path.join(dataRoot, 'timelapse')),
    getDirectorySizeBytes(path.join(dataRoot, 'clips')),
    getDirectorySizeBytes(diagnosticsDir),
  ]);

  return {
    ...dbStats,
    walBytes,
    totalDatabaseBytes: dbStats.fileSizeBytes + walBytes + shmBytes,
    timelapseBytes,
    clipsBytes,
    diagnosticsBytes,
  };
}

function formatBackupFilename(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `backup-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours()
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}.db`;
}

async function createOnlineDatabaseBackup(database = db) {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'iot-db-backup-'));
  const filename = formatBackupFilename();
  const filePath = path.join(tmpDir, filename);

  try {
    await database.backup(filePath);
    const copy = new Database(filePath, { readonly: true, fileMustExist: true });
    try {
      const check = copy.pragma('quick_check', { simple: true });
      if (check !== 'ok') {
        throw new Error(`database_backup_check_failed: ${check}`);
      }
    } finally {
      copy.close();
    }
    const stat = await fs.promises.stat(filePath);
    return {
      filePath,
      filename,
      sizeBytes: Number(stat.size || 0),
      cleanup: () => fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {}),
    };
  } catch (err) {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

module.exports = {
  getDatabaseStats,
  optimizeDatabase,
  getDirectorySizeBytes,
  getStorageBreakdown,
  createOnlineDatabaseBackup,
};
