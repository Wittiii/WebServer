const fs = require('fs');
const path = require('path');

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

module.exports = {
  getDatabaseStats,
  optimizeDatabase
};
