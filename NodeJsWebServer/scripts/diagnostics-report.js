const path = require('node:path');
const { parseCliArgs, resolveDiagnosticsDir, readRecentRecords, formatReport } = require('../src/services/diagnosticsReportService');

async function main(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv);
  if (options.help) {
    console.log('Aufruf: node scripts/diagnostics-report.js [--tail 1..200] [--json] [--dir PFAD]');
    return;
  }
  const envPath = process.env.ENV_FILE || path.join(__dirname, '..', 'src', 'config', '.env');
  require('dotenv').config({ path: envPath });
  const directory = options.dir ? path.resolve(options.dir) : resolveDiagnosticsDir();
  const result = await readRecentRecords(directory, options);
  console.log(options.json ? JSON.stringify(result.records, null, 2) : formatReport(result, { directory }));
  if (result.readErrors.length) process.exitCode = 1;
}

module.exports = { main };
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
