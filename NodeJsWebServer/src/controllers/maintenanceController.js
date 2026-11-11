const {
  getDatabaseStats,
  optimizeDatabase
} = require('../services/databaseMaintenanceService');

const databaseStatus = (req, res) => {
  try {
    res.json({ ok: true, ...getDatabaseStats() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  optimizeDatabaseFile
};
