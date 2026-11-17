const fs = require('fs');
const {
  createOnlineDatabaseBackup,
  getStorageBreakdown,
  optimizeDatabase
} = require('../services/databaseMaintenanceService');

const databaseStatus = async (_req, res) => {
  try {
    res.json({ ok: true, ...(await getStorageBreakdown()) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const downloadDatabaseBackup = async (_req, res) => {
  let backup;
  try {
    backup = await createOnlineDatabaseBackup();
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || 'backup_failed' });
  }

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    backup.cleanup();
  };

  res.set({
    'Content-Type': 'application/x-sqlite3',
    'Content-Disposition': `attachment; filename="${backup.filename}"`,
    'Content-Length': String(backup.sizeBytes),
    'Cache-Control': 'no-store'
  });

  const stream = fs.createReadStream(backup.filePath);
  stream.once('error', (err) => {
    cleanup();
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: err?.message || 'backup_stream_failed' });
    } else {
      res.destroy(err);
    }
  });
  res.once('close', cleanup);
  res.once('finish', cleanup);
  stream.pipe(res);
};

const optimizeDatabaseFile = (req, res) => {
  try {
    res.json({ ok: true, ...optimizeDatabase() });
  } catch (err) {
    if (err.code === 'DATABASE_OPTIMIZATION_RUNNING') {
      return res.status(409).json({ error: err.message });
    }
    if (err.code === 'DATABASE_OPTIMIZATION_INSUFFICIENT_SPACE') {
      return res.status(507).json({
        error: err.message,
        requiredFreeBytes: err.requiredFreeBytes,
        availableDiskBytes: err.availableDiskBytes
      });
    }
    res.status(500).json({ error: err.message });
  }
};

module.exports = {
  databaseStatus,
  downloadDatabaseBackup,
  optimizeDatabaseFile
};
