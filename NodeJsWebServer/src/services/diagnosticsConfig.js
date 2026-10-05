const path = require('node:path');

const PROJECT_DIRECTORY = path.resolve(__dirname, '../..');

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  return value == null || value === '' || !Number.isFinite(number)
    ? fallback : Math.min(max, Math.max(min, Math.trunc(number)));
}

function getDiagnosticsConfig(env = process.env, platform = process.platform) {
  return {
    enabled: env.DIAGNOSTICS_ENABLED == null || env.DIAGNOSTICS_ENABLED === ''
      ? platform === 'linux' : /^(true|1|yes)$/i.test(env.DIAGNOSTICS_ENABLED),
    directory: env.DIAGNOSTICS_DIR
      ? path.resolve(env.DIAGNOSTICS_DIR) : path.join(PROJECT_DIRECTORY, 'logs', 'diagnostics'),
    intervalMs: boundedNumber(env.DIAGNOSTICS_INTERVAL_MS, 30000, 5000, 300000),
    maxBytes: boundedNumber(env.DIAGNOSTICS_MAX_FILE_MB, 5, 1, 20) * 1024 * 1024,
    maxFiles: 4,
    targetPath: PROJECT_DIRECTORY,
  };
}

module.exports = { getDiagnosticsConfig, boundedNumber };
