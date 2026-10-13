const path = require('node:path');
const { parseCliArgs, resolveDiagnosticsDir, readRecentRecords, readReportRange, formatReport, formatRangeReport } = require('../src/services/diagnosticsReportService');

async function main(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv);
  if (options.help) {
    console.log('Aufruf: node scripts/diagnostics-report.js [--since 48h|2d] [--tail 1..200] [--details] [--json] [--dir PFAD]');
    return;
  }
  const envPath = process.env.ENV_FILE || path.join(__dirname, '..', 'src', 'config', '.env');
  require('dotenv').config({ path: envPath });
  const directory = options.dir ? path.resolve(options.dir) : resolveDiagnosticsDir();
  const result = options.sinceMs
    ? await readReportRange(directory, options) : await readRecentRecords(directory, options);
  const report = options.sinceMs ? formatRangeReport : formatReport;
  console.log(options.json ? JSON.stringify(options.sinceMs ? result : result.records, null, 2)
    : report(result, { directory, details: options.details }));
  if (result.readErrors.length || result.readBudget?.exhausted) process.exitCode = 1;
}

module.exports = { main };
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
