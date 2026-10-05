const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { MAX_LINE_BYTES, MAX_NOTABLE_RECORDS, parseCliArgs, resolveDiagnosticsDir, readRecentRecords, formatReport } = require('../src/services/diagnosticsReportService');

function record(second, event = 'sample', extra = {}) {
  return { timestamp: new Date(Date.UTC(2026, 9, 5, 12, 0, second)).toISOString(), event, runId: 'test-run', ...extra };
}

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'diagnostics-report-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('report reads rotated logs in order, bounds tail and survives a truncated final line', async (t) => {
  const directory = await temporaryDirectory(t);
  const earlier = record(1, 'server_starting');
  const middle = record(2, 'server_ready');
  const latest = record(3, 'sample', { http: { ok: false, error: 'timeout' }, issues: ['http_timeout'] });
  await fs.writeFile(path.join(directory, 'diagnostics.3.jsonl'), `${JSON.stringify(earlier)}\n`);
  await fs.writeFile(path.join(directory, 'diagnostics.1.jsonl'), `not json\n${JSON.stringify(middle)}\n`);
  await fs.writeFile(path.join(directory, 'diagnostics.jsonl'), `${JSON.stringify(latest)}\n{"timestamp":`);
  const result = await readRecentRecords(directory, { tail: 2 });
  assert.deepEqual(result.records, [middle, latest]);
  assert.deepEqual(result.filesRead, ['diagnostics.3.jsonl', 'diagnostics.1.jsonl', 'diagnostics.jsonl']);
  assert.equal(result.skippedLines, 2);
  assert.deepEqual(result.readErrors, []);
});

test('damaged oversized lines do not swallow following records or require unbounded buffering', async (t) => {
  const directory = await temporaryDirectory(t);
  const latest = record(4);
  await fs.writeFile(path.join(directory, 'diagnostics.jsonl'), `${'x'.repeat(MAX_LINE_BYTES + 100000)}\n${JSON.stringify(latest)}\n${'x'.repeat(MAX_LINE_BYTES + 1)}`);
  const result = await readRecentRecords(directory);
  assert.deepEqual(result.records, [latest]);
  assert.equal(result.oversizedLines, 2);
  assert.equal(result.skippedLines, 2);
});

test('report accepts a complete final record without newline and skips invalid record shapes', async (t) => {
  const directory = await temporaryDirectory(t);
  const latest = record(5);
  await fs.writeFile(path.join(directory, 'diagnostics.jsonl'), `\nnull\n[]\n{"timestamp":"bad","event":"sample"}\n${JSON.stringify(latest)}`);
  const result = await readRecentRecords(directory);
  assert.deepEqual(result.records, [latest]);
  assert.equal(result.skippedLines, 3);
});

test('CLI rejects unbounded tails and resolves explicit relative log configuration', () => {
  assert.deepEqual(parseCliArgs(['--tail', '200', '--json', '--dir', 'custom']), { tail: 200, json: true, dir: 'custom' });
  for (const value of ['0', '201', '-1', '2.5', 'Infinity', '']) {
    assert.throws(() => parseCliArgs(['--tail', value]), /1 bis 200/);
  }
  assert.throws(() => parseCliArgs(['--dir']), /Verzeichnispfad/);
  assert.throws(() => parseCliArgs(['--unexpected']), /Unbekanntes/);
  assert.equal(resolveDiagnosticsDir({ DIAGNOSTICS_DIR: 'logs/custom' }, os.tmpdir()), path.resolve(os.tmpdir(), 'logs/custom'));
  assert.match(resolveDiagnosticsDir({}), /logs[\\/]diagnostics$/);
});

test('German report describes facts and issues without claiming an outage cause', () => {
  const result = {
    records: [record(1, 'server_ready'), record(2, 'sample', {
      http: { ok: false, durationMs: 3001, error: 'timeout' }, heartbeatAgeMs: 65000,
      runtime: { memoryBytes: { rss: 104857600 }, eventLoop: { maxMs: 1200 } },
      issues: ['http_timeout', 'stale_heartbeat'], system: { issues: ['stale_heartbeat', 'temperature_high'] },
    })], filesRead: ['diagnostics.jsonl'], skippedLines: 1, oversizedLines: 0, readErrors: [],
  };
  const output = formatReport(result);
  assert.match(output, /Webserver bereit/);
  assert.match(output, /HTTP-Prüfung fehlgeschlagen \(timeout\)/);
  assert.match(output, /Heartbeat 65 s alt/);
  assert.match(output, /Node-RSS 100 MiB/);
  assert.match(output, /Node-Pause max\. 1200 ms/);
  assert.match(output, /http_timeout, stale_heartbeat, temperature_high/);
  assert.match(output, /belegen allein keine Ausfallursache/);
  assert.match(output, /1 beschädigte\/unvollständige Zeilen/);
});

test('JSON CLI prints only recent full records and does not reveal dotenv configuration', async (t) => {
  const directory = await temporaryDirectory(t);
  const latest = record(2, 'sample', { system: { arbitraryFutureField: [1, 2] }, http: { ok: true, statusCode: 200 } });
  const envFile = path.join(directory, 'test.env');
  await fs.writeFile(envFile, `SESSION_SECRET=do-not-print-this-value\nDIAGNOSTICS_DIR=${directory.replace(/\\/g, '/')}\n`);
  await fs.writeFile(path.join(directory, 'diagnostics.jsonl'), `${JSON.stringify(record(1))}\n${JSON.stringify(latest)}\n`);
  const env = { ...process.env, ENV_FILE: envFile };
  delete env.DIAGNOSTICS_DIR;
  const cli = spawnSync(process.execPath, [path.join(__dirname, '../scripts/diagnostics-report.js'), '--tail', '1', '--json'], { env, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), [latest]);
  assert.doesNotMatch(cli.stdout + cli.stderr, /do-not-print-this-value/);
});

test('report includes system measurements and structured issues without printing kernel messages', () => {
  const output = formatReport({
    records: [record(3, 'sample', { system: {
      cpu: { usagePercent: 25.1, ioWaitPercent: 10.5 }, memory: { availableBytes: 52428800, swapUsedBytes: 1048576 },
      disk: { freeBytes: 104857600 }, thermal: [{ temperatureCelsius: 78.2 }], throttling: { raw: '0x10001' },
      network: [{ name: 'eth0', state: 'up', carrier: false }], kernel: { recentMessages: [{ message: 'raw-kernel-line' }] },
      unavailable: [{ source: 'previousBoot', reason: 'permission_denied' }],
      issues: [{ code: 'firmware_flag_current', flag: 'underVoltage' }, { code: 'network_counter_increased', interface: 'eth0', counter: 'rxErrors', delta: 2 }],
    } })], filesRead: ['diagnostics.jsonl'], skippedLines: 0, oversizedLines: 0,
  });
  assert.match(output, /CPU 25\.1 %/);
  assert.match(output, /RAM verfügbar 50 MiB/);
  assert.match(output, /Temperatur max\. 78\.2 °C/);
  assert.match(output, /Firmware-Flags 0x10001/);
  assert.match(output, /eth0=kein Signal/);
  assert.match(output, /Kernel-Hinweise 1/);
  assert.match(output, /firmware_flag_current \[flag=underVoltage\]/);
  assert.match(output, /network_counter_increased \[interface=eth0, counter=rxErrors, delta=2\]/);
  assert.doesNotMatch(output, /raw-kernel-line/);
});

test('empty directory yields an explicit lack of evidence', async (t) => {
  const directory = await temporaryDirectory(t);
  const result = await readRecentRecords(directory);
  assert.deepEqual(result.records, []);
  assert.match(formatReport(result), /kein Betriebszustand/);
});

test('failure remains visible from older rotated files after more than twenty healthy samples', async (t) => {
  const directory = await temporaryDirectory(t);
  const failure = record(1, 'sample', {
    http: { ok: false, error: 'timeout', durationMs: 3000 }, heartbeatAgeMs: 30000,
    runtime: { eventLoop: { maxMs: 1200 } }, issues: ['parent_heartbeat_missing', 'node_event_loop_delay'],
    system: { kernel: { recentMessages: [{ message: 'kernel-body-must-not-be-printed' }] } },
  });
  const healthy = Array.from({ length: 80 }, (_, index) => record(index + 10, 'sample', {
    http: { ok: true, statusCode: 200 }, heartbeatAgeMs: 2000, runtime: { eventLoop: { maxMs: 60 } },
    system: { issues: [{ code: 'pressure_observed', resource: 'cpu', scope: 'some', avg10Percent: 0.01 },
      { code: 'firmware_flag_since_boot', flag: 'underVoltage' }] },
  }));
  await fs.writeFile(path.join(directory, 'diagnostics.3.jsonl'), `${JSON.stringify(failure)}\n`);
  await fs.writeFile(path.join(directory, 'diagnostics.jsonl'), healthy.map((entry) => JSON.stringify(entry)).join('\n'));
  const result = await readRecentRecords(directory);
  assert.deepEqual(result.records, healthy.slice(-20));
  assert.deepEqual(result.notableRecords, [failure]);
  const output = formatReport(result);
  assert.match(output, /Letzte gespeicherte Auffälligkeiten/);
  assert.ok(output.indexOf(failure.timestamp) < output.indexOf('Letzte 20 Einträge'));
  assert.match(output, /HTTP-Prüfung fehlgeschlagen \(timeout\)/);
  assert.match(output, /Kernel-Hinweise 1/);
  assert.doesNotMatch(output, /kernel-body-must-not-be-printed/);
});

test('notable history stays bounded to twelve categories and retains the latest occurrence of each', async (t) => {
  const directory = await temporaryDirectory(t);
  const seeds = [
    { event: 'fatal', error: { message: 'test' } },
    { event: 'parent_disconnect' },
    { http: { ok: false, error: 'timeout' } },
    { issues: ['parent_heartbeat_missing'] },
    { issues: ['node_event_loop_delay'] },
    { system: { kernel: { recentMessages: [{ message: 'redacted from report' }] } } },
    { system: { issues: [{ code: 'firmware_flag_current', flag: 'underVoltage' }] } },
    { system: { issues: [{ code: 'network_carrier_lost', interface: 'eth0' }] } },
    { system: { issues: [{ code: 'network_counter_increased', interface: 'eth0', counter: 'rxErrors', delta: 1 }] } },
    { system: { issues: [{ code: 'low_memory_available' }] } },
    { system: { issues: [{ code: 'low_disk_space' }, { code: 'disk_inodes_exhausted' }] } },
    { system: { issues: [{ code: 'cpu_usage_high', usagePercent: 99 }, { code: 'io_wait_high', ioWaitPercent: 23 }] } },
  ];
  const entries = Array.from({ length: 8 }, (_, round) => seeds.map((seed, index) =>
    record(round * 60 + index, seed.event || 'sample', seed))).flat();
  await fs.writeFile(path.join(directory, 'diagnostics.jsonl'), entries.map((entry) => JSON.stringify(entry)).join('\n'));
  const result = await readRecentRecords(directory, { tail: 1 });
  assert.equal(MAX_NOTABLE_RECORDS, 12);
  assert.equal(result.notableRecords.length, 12);
  assert.deepEqual(result.notableRecords, entries.slice(-12));
  assert.equal(new Set(result.notableRecords).size, result.notableRecords.length);
  assert.strictEqual(result.notableRecords.at(-1), result.records[0]);
});

test('notable records are chronological even if record clocks changed and historical flags alone do not qualify', async (t) => {
  const directory = await temporaryDirectory(t);
  const laterTimestamp = record(50, 'fatal');
  const earlierTimestamp = record(30, 'monitor_signal', { signal: 'SIGTERM' });
  const onlyHistory = record(60, 'sample', { system: {
    throttling: { raw: '0x10000', current: { underVoltage: false }, occurredSinceBoot: { underVoltage: true } },
    issues: [{ code: 'firmware_flag_since_boot', flag: 'underVoltage' }, { code: 'pressure_observed', avg10Percent: 0.1 }],
  } });
  await fs.writeFile(path.join(directory, 'diagnostics.jsonl'), [laterTimestamp, earlierTimestamp, onlyHistory].map((entry) => JSON.stringify(entry)).join('\n'));
  const result = await readRecentRecords(directory);
  assert.deepEqual(result.notableRecords, [earlierTimestamp, laterTimestamp]);
});

test('brief carrier and speed changes remain notable when the next samples have a stable link', async (t) => {
  const directory = await temporaryDirectory(t);
  const changed = record(1, 'sample', { http: { ok: true, statusCode: 200 }, system: {
    network: [{ name: 'eth0', carrier: 1, state: 'up', speedMbps: 100, duplex: 'full', carrierChanges: 12,
      rxCrcErrors: 3, txCarrierErrors: 0, delta: { carrierChanges: 2, rxCrcErrors: 1 } }],
    issues: [{ code: 'network_carrier_changes', interface: 'eth0', delta: 2 },
      { code: 'network_speed_changed', interface: 'eth0', previousMbps: 1000, currentMbps: 100 },
      { code: 'network_counter_increased', interface: 'eth0', counter: 'rxCrcErrors', delta: 1 }],
  } });
  const stable = Array.from({ length: 30 }, (_, index) => record(index + 2, 'sample', { http: { ok: true }, system: {
    network: [{ name: 'eth0', carrier: 1, speedMbps: 100, duplex: 'full', carrierChanges: 12, rxCrcErrors: 3,
      delta: { carrierChanges: 0, rxCrcErrors: 0, txCarrierErrors: 0 } }], issues: [],
  } }));
  await fs.writeFile(path.join(directory, 'diagnostics.jsonl'), [changed, ...stable].map((entry) => JSON.stringify(entry)).join('\n'));
  const result = await readRecentRecords(directory, { tail: 1 });
  assert.deepEqual(result.notableRecords, [changed]);
  assert.equal(MAX_NOTABLE_RECORDS, 12);
  const output = formatReport(result);
  assert.match(output, /LAN-Signalwechsel: eth0, \+2 seit letzter Messung/);
  assert.match(output, /LAN-Geschwindigkeit geändert: eth0, 1000 → 100 Mbit\/s/);
  assert.match(output, /counter=rxCrcErrors, delta=1/);
  assert.match(output, /eth0=Signal \(100 Mbit\/s, Vollduplex\)/);
});

test('new carrier and speed observations share the existing carrier category', async (t) => {
  const directory = await temporaryDirectory(t);
  const carrier = record(1, 'sample', { system: { issues: [{ code: 'network_carrier_changes', interface: 'eth0', delta: 2 }] } });
  const speed = record(2, 'sample', { system: { issues: [{ code: 'network_speed_changed', interface: 'eth0', previousMbps: 100, currentMbps: 1000 }] } });
  await fs.writeFile(path.join(directory, 'diagnostics.jsonl'), [carrier, speed].map((entry) => JSON.stringify(entry)).join('\n'));
  const result = await readRecentRecords(directory);
  assert.deepEqual(result.notableRecords, [speed]);
});
