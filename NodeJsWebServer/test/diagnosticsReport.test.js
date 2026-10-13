const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { MAX_LINE_BYTES, MAX_NOTABLE_RECORDS, REPORT_READ_BUDGET_BYTES, parseCliArgs, resolveDiagnosticsDir, readRecentRecords, readReportRange, formatReport, formatRangeReport } = require('../src/services/diagnosticsReportService');

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

test('details flag preserves default text and exposes kernel context with missing sources only once', async (t) => {
  const directory = await temporaryDirectory(t);
  const unavailable = [
    { source: 'pressure.cpu', reason: 'not_available' },
    { source: 'pressure.memory', reason: 'not_available' },
    { source: 'kernel.previousBoot.access', reason: 'permission_denied' },
  ];
  const message = (index) => ({ timestamp: record(index).timestamp, message: `bcmgenet eth0 link transition ${index}` });
  const first = record(1, 'sample', { http: { ok: true }, system: { unavailable,
    kernel: { recentMessages: Array.from({ length: 6 }, (_, index) => message(index)) },
    issues: [{ code: 'network_carrier_changes', interface: 'eth0', delta: 6 }],
  } });
  const second = record(2, 'sample', { http: { ok: true }, system: { unavailable,
    kernel: { recentMessages: [message(6), message(7)] },
    issues: [{ code: 'network_carrier_changes', interface: 'eth0', delta: 2 }],
  } });
  const healthy = Array.from({ length: 48 }, (_, index) => record(index + 3, 'sample', {
    http: { ok: true }, system: { unavailable, kernel: { recentMessages: [] } },
  }));
  await fs.writeFile(path.join(directory, 'diagnostics.jsonl'), [first, second, ...healthy].map((entry) => JSON.stringify(entry)).join('\n'));
  const result = await readRecentRecords(directory, { tail: 50 });
  const compact = formatReport(result);
  assert.equal(compact, formatReport(result, { details: false }));
  assert.doesNotMatch(compact, /bcmgenet eth0 link transition|pressure\.cpu:|kernel\.previousBoot\.access:/);
  const expanded = formatReport(result, { details: true });
  assert.match(expanded, /Letzte 50 Einträge/);
  assert.match(expanded, /LAN-Signalwechsel: eth0, \+6/);
  assert.match(expanded, /LAN-Signalwechsel: eth0, \+2/);
  assert.equal((expanded.match(/^  Kernel \[/gm) || []).length, 8);
  assert.equal((expanded.match(/pressure\.cpu: not_available/g) || []).length, 1);
  assert.equal((expanded.match(/pressure\.memory: not_available/g) || []).length, 1);
  assert.equal((expanded.match(/kernel\.previousBoot\.access: permission_denied/g) || []).length, 1);
  assert.ok(expanded.indexOf('Fehlende Messquellen aus den angezeigten Einträgen') > expanded.lastIndexOf(healthy.at(-1).timestamp));
  assert.deepEqual(parseCliArgs(['--tail', '50', '--details']), { tail: 50, json: false, details: true });
});

test('details output bounds messages and sources, strips controls and never dumps other record fields', () => {
  const message = (index) => ({ timestamp: record(index).timestamp,
    message: `kernel_${index}\u0000\u001b\r\n\u202e${'m'.repeat(700)}` });
  const sample = (index) => record(index, 'sample', { system: {
    kernel: {
      recentMessages: Array.from({ length: 12 }, (_, offset) => message(index * 100 + offset)), truncated: true,
      previousBoot: { recentMessages: Array.from({ length: 12 }, (_, offset) => message(index * 100 + offset + 20)) },
      environment: 'do-not-dump-kernel-environment', argv: ['do-not-dump-kernel-argv'],
    },
    unavailable: Array.from({ length: 25 }, (_, offset) => ({ source: `source_${offset}`, reason: 'not_available',
      environment: 'do-not-dump-source-environment', argv: ['do-not-dump-source-argv'] })),
  } });
  const output = formatReport({ records: [sample(1), sample(2), sample(3)], notableRecords: [], filesRead: ['diagnostics.jsonl'], skippedLines: 0 }, { details: true });
  const kernelLines = output.split('\n').filter((line) => line.startsWith('  Kernel ['));
  assert.equal(kernelLines.length, 20);
  assert.ok(kernelLines.every((line) => line.length <= 620));
  assert.equal((output.match(/^  source_\d+:/gm) || []).length, 20);
  assert.match(output, /10 Meldungen je Eintrag und 20 insgesamt/);
  assert.match(output, /Liste ist auf 20 Quellen begrenzt/);
  assert.match(output, /Kernel-Erfassung dieses Eintrags war bereits begrenzt/);
  assert.doesNotMatch(output, /[\u0000\u001b\r\u202e]|do-not-dump/);
});

test('details include previous-boot messages and retain the latest reason despite notable-first display', () => {
  const previous = record(1, 'sample', { system: { unavailable: [{ source: 'kernel.access', reason: 'not_available' }],
    kernel: { recentMessages: [], previousBoot: { recentMessages: [{ timestamp: record(0).timestamp, message: 'previous boot diagnostic' }] } },
  } });
  const latest = record(2, 'sample', { system: { unavailable: [{ source: 'kernel.access', reason: 'permission_denied' }] } });
  const output = formatReport({ records: [previous, latest], notableRecords: [latest], filesRead: ['diagnostics.jsonl'], skippedLines: 0 }, { details: true });
  assert.match(output, /Kernel \[vorheriger Boot\].*previous boot diagnostic/);
  assert.equal((output.match(/kernel\.access:/g) || []).length, 1);
  assert.match(output, /kernel\.access: permission_denied/);
  assert.doesNotMatch(output, /kernel\.access: not_available/);
});

test('details CLI expands text while JSON remains the same tail array and config stays private', async (t) => {
  const directory = await temporaryDirectory(t);
  const latest = record(1, 'sample', { system: {
    unavailable: [{ source: 'pressure.io', reason: 'not_available' }],
    kernel: { recentMessages: [{ timestamp: record(0).timestamp, message: 'cli kernel detail' }] },
  } });
  const envFile = path.join(directory, 'test.env');
  await fs.writeFile(envFile, 'SESSION_SECRET=do-not-print-details-config\n');
  await fs.writeFile(path.join(directory, 'diagnostics.jsonl'), `${JSON.stringify(latest)}\n`);
  const run = (args) => spawnSync(process.execPath, [path.join(__dirname, '../scripts/diagnostics-report.js'), '--dir', directory, '--tail', '1', ...args], {
    env: { ...process.env, ENV_FILE: envFile }, encoding: 'utf8',
  });
  const compact = run([]);
  const expanded = run(['--details']);
  const json = run(['--details', '--json']);
  for (const result of [compact, expanded, json]) {
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /do-not-print-details-config/);
  }
  assert.doesNotMatch(compact.stdout, /cli kernel detail|pressure\.io:/);
  assert.match(expanded.stdout, /cli kernel detail/);
  assert.match(expanded.stdout, /pressure\.io: not_available/);
  assert.deepEqual(JSON.parse(json.stdout), [latest]);
});

test('48-hour range scans rotated history while retaining only a bounded tail and separate counters', async (t) => {
  const directory = await temporaryDirectory(t);
  const now = Date.parse('2026-10-13T16:00:00.000Z');
  const samples = Array.from({ length: 6000 }, (_, index) => ({
    timestamp: new Date(now - (5999 - index) * 30000).toISOString(), event: 'sample', runId: 'range-run',
    http: { ok: true, durationMs: 10 }, heartbeatAgeMs: 1000,
    runtime: { eventLoop: { maxMs: 60 }, memoryBytes: { rss: 104857600 } }, system: {
      cpu: { usagePercent: 5, ioWaitPercent: 0.2 }, memory: { availableBytes: 3 * 1073741824 },
      disk: { freeBytes: 4 * 1073741824 }, thermal: [{ temperatureCelsius: 40 }],
      unavailable: [{ source: 'pressure.cpu', reason: 'not_available' }], issues: [],
    },
  }));
  samples[100].http.ok = false;
  samples[100].runtime.eventLoop.maxMs = 9000;
  samples[300].http = { ok: false, durationMs: 900 };
  samples[300].runtime.eventLoop.maxMs = 1000;
  for (const index of [300, 310]) {
    const actor = { name: 'node', pid: 3546, state: 'D', startTimeTicks: 123, waitChannel: index === 310 ? 'folio_wait_bit_common' : null };
    samples[index].system.processes = { relevant: [actor, { name: 'node', pid: 3553, state: 'R' }], topRss: [actor] };
    samples[index].system.issues = [
      { code: 'network_carrier_changes', interface: 'eth0', delta: index === 300 ? 6 : 2 },
      { code: 'network_counter_increased', interface: 'eth0', counter: 'rxErrors', delta: 1 },
      { code: 'network_counter_increased', interface: 'eth0', counter: 'rxCrcErrors', delta: 1 },
      { code: 'network_counter_increased', interface: 'eth0', counter: 'rxDropped', delta: 30 },
    ];
  }
  samples[300].system.kernel = { recentMessages: [{ timestamp: samples[300].timestamp, message: 'range kernel detail' }] };
  const oldFatal = { timestamp: new Date(now - 5 * 86400000).toISOString(), event: 'fatal' };
  const future = { timestamp: new Date(now + 3600000).toISOString(), event: 'sample', http: { ok: false } };
  const names = ['diagnostics.3.jsonl', 'diagnostics.2.jsonl', 'diagnostics.1.jsonl', 'diagnostics.jsonl'];
  for (let index = 0; index < names.length; index += 1) {
    const entries = samples.slice(index * 1500, (index + 1) * 1500);
    if (index === 0) entries.unshift(oldFatal);
    if (index === 3) entries.push(future);
    await fs.writeFile(path.join(directory, names[index]), entries.map((entry) => JSON.stringify(entry)).join('\n'));
  }
  const result = await readReportRange(directory, { sinceMs: 48 * 3600000, untilMs: now });
  assert.equal(result.summary.sampleCount, 5761);
  assert.equal(result.summary.http.ok, 5760);
  assert.equal(result.summary.http.failed, 1);
  assert.equal(result.summary.http.atLeast500Ms, 1);
  assert.equal(result.summary.runtime.maxEventLoopDelayMs, 1000);
  assert.equal(result.summary.runtime.pausesOver500Ms, 1);
  assert.equal(result.summary.resources.memoryMinAvailableBytes, 3 * 1073741824);
  assert.equal(result.range.storedRecordCount, 6002);
  assert.equal(result.range.futureRecords, 1);
  assert.equal(result.range.storedFrom, oldFatal.timestamp);
  assert.equal(result.range.includedFrom, new Date(now - 48 * 3600000).toISOString());
  assert.equal(result.records.length, 20);
  assert.ok(result.notableRecords.length <= MAX_NOTABLE_RECORDS);
  assert.ok(result.notableRecords.every((entry) => Date.parse(entry.timestamp) >= now - 48 * 3600000 && Date.parse(entry.timestamp) <= now));
  assert.equal(result.summary.network[0].carrierChanges, 8);
  assert.equal(result.summary.network[0].counters.rxErrors, 2);
  assert.equal(result.summary.network[0].counters.rxCrcErrors, 2);
  assert.equal(result.summary.network[0].counters.rxDropped, 60);
  assert.equal(result.summary.processesD.length, 1);
  assert.equal(result.summary.processesD[0].pid, 3546);
  assert.equal(result.summary.processesD[0].observedSamples, 2);
  assert.equal(result.summary.processesD[0].httpAtLeast500Ms, 1);
  assert.equal(result.summary.processesD[0].waitChannel, 'folio_wait_bit_common');
  assert.equal(result.readBudget.exhausted, false);
  const output = formatRangeReport(result, { details: true });
  assert.match(output, /5761 Messungen/);
  assert.match(output, /Linkwechsel \+8/);
  assert.match(output, /Wait-Channel folio_wait_bit_common/);
  assert.match(output, /range kernel detail/);
  assert.match(output, /keine Verlustquote/);
  assert.doesNotMatch(output, /PID 3553/);
});

test('range reports actual partial coverage and enforce one byte budget across all files', async (t) => {
  const directory = await temporaryDirectory(t);
  const now = Date.parse(record(10).timestamp);
  const first = `${JSON.stringify(record(1))}\n`;
  const second = `${JSON.stringify(record(2))}\n`;
  await fs.writeFile(path.join(directory, 'diagnostics.3.jsonl'), first);
  await fs.writeFile(path.join(directory, 'diagnostics.2.jsonl'), second);
  await fs.writeFile(path.join(directory, 'diagnostics.jsonl'), `${JSON.stringify(record(3))}\n`);
  const maxBytes = Buffer.byteLength(first) + Buffer.byteLength(second) - 5;
  const result = await readReportRange(directory, { sinceMs: 48 * 3600000, untilMs: now, maxBytes });
  assert.equal(REPORT_READ_BUDGET_BYTES, 80 * 1024 * 1024);
  assert.equal(result.readBudget.bytesRead, maxBytes);
  assert.equal(result.readBudget.exhausted, true);
  assert.equal(result.summary.recordCount, 1);
  assert.equal(result.skippedLines, 1);
  assert.equal(result.range.requestedStartReached, false);
  const output = formatRangeReport(result);
  assert.match(output, /nicht vollständig/);
  assert.match(output, /weitere Daten könnten ungelesen sein/);
  await assert.rejects(readReportRange(directory, { sinceMs: 1, maxBytes: REPORT_READ_BUDGET_BYTES + 1 }), /Lesebudget/);
});

test('range statistics keep dynamic interfaces, missing sources, events and D actors bounded', async (t) => {
  const directory = await temporaryDirectory(t);
  const now = Date.parse(record(200).timestamp);
  const entries = Array.from({ length: 100 }, (_, index) => record(index, index % 2 ? `unknown_${index}` : 'sample', {
    http: { ok: true }, system: {
      issues: [{ code: 'network_counter_increased', interface: `network_${index}`, counter: 'rxDropped', delta: 1 }],
      unavailable: [{ source: `source_${index}`, reason: 'not_available' }],
      processes: { relevant: Array.from({ length: 20 }, (_, offset) => ({ name: 'ffmpeg', pid: 1000 + index * 20 + offset, state: 'D' })) },
    },
  }));
  await fs.writeFile(path.join(directory, 'diagnostics.jsonl'), entries.map((entry) => JSON.stringify(entry)).join('\n'));
  const result = await readReportRange(directory, { sinceMs: 3600000, untilMs: now, tail: 2 });
  assert.equal(result.records.length, 2);
  assert.ok(result.notableRecords.length <= 12);
  assert.equal(result.summary.network.length, 8);
  assert.equal(result.summary.networkLimited, true);
  assert.equal(result.summary.unavailable.length, 20);
  assert.equal(result.summary.unavailableLimited, true);
  assert.equal(result.summary.processesD.length, 10);
  assert.equal(result.summary.processesDLimited, true);
  assert.deepEqual(Object.keys(result.summary.events).sort(), ['other', 'sample']);
  await assert.rejects(readReportRange(directory, { sinceMs: 3600000, tail: 201 }), /1 bis 200/);
});

test('since arguments support bounded hours/days and JSON range mode changes only its own schema', async (t) => {
  assert.equal(parseCliArgs(['--since', '48h']).sinceMs, 48 * 3600000);
  assert.equal(parseCliArgs(['--since', '2d']).sinceMs, 48 * 3600000);
  assert.equal(parseCliArgs(['--since', '0.5h']).sinceMs, 1800000);
  for (const value of ['0h', '-1h', '31d', '721h', '48', 'Infinityh', '']) assert.throws(() => parseCliArgs(['--since', value]), /positive Dauer/);
  const directory = await temporaryDirectory(t);
  const latest = { timestamp: new Date().toISOString(), event: 'sample', http: { ok: true } };
  const envFile = path.join(directory, 'test.env');
  await fs.writeFile(envFile, 'SESSION_SECRET=range-config-must-stay-private\n');
  await fs.writeFile(path.join(directory, 'diagnostics.jsonl'), `${JSON.stringify(latest)}\n`);
  const cli = spawnSync(process.execPath, [path.join(__dirname, '../scripts/diagnostics-report.js'), '--dir', directory, '--since', '48h', '--tail', '1', '--json'], {
    env: { ...process.env, ENV_FILE: envFile }, encoding: 'utf8',
  });
  assert.equal(cli.status, 0, cli.stderr);
  const output = JSON.parse(cli.stdout);
  assert.deepEqual(output.records, [latest]);
  assert.equal(output.summary.sampleCount, 1);
  assert.equal(output.readBudget.maxBytes, REPORT_READ_BUDGET_BYTES);
  assert.doesNotMatch(cli.stdout + cli.stderr, /range-config-must-stay-private/);
});

test('wait-channel details are bounded, sanitized and emitted only for relevant D actors', () => {
  const actor = { name: 'node', pid: 3546, state: 'D', waitChannel: `folio_wait\u001b\n\u202e${'x'.repeat(200)}` };
  const sample = record(1, 'sample', { system: { processes: {
    relevant: [actor, { name: 'node', pid: 3553, state: 'R', waitChannel: 'must-not-show-r' },
      { name: 'python', pid: 4000, state: 'D', waitChannel: 'must-not-show-unrelated' }], topRss: [actor],
  } } });
  const fixture = { records: [sample], notableRecords: [sample], filesRead: ['diagnostics.jsonl'], skippedLines: 0 };
  assert.doesNotMatch(formatReport(fixture), /Wait-Channel/);
  const output = formatReport(fixture, { details: true });
  const lines = output.split('\n').filter((line) => line.includes('Wait-Channel'));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].split('Wait-Channel ')[1].slice(0, -1).length <= 128);
  assert.doesNotMatch(output, /[\u001b\u202e]|must-not-show/);
});

test('CLI returns failure status when the aggregate read budget is reached', async () => {
  const vm = require('node:vm');
  const file = path.join(__dirname, '../scripts/diagnostics-report.js');
  const module = { exports: {} };
  const state = { env: {}, exitCode: 0 };
  const output = [];
  const result = { records: [], notableRecords: [], readErrors: [], readBudget: { maxBytes: 10, bytesRead: 10, exhausted: true } };
  vm.runInNewContext(await fs.readFile(file, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(file), process: state,
    console: { log: (value) => output.push(value), error() {} },
    require(id) {
      if (id === 'node:path') return path;
      if (id === 'dotenv') return { config() {} };
      return { parseCliArgs, resolveDiagnosticsDir: () => '/test-logs', readReportRange: async () => result };
    },
  }, { filename: file });
  await module.exports.main(['--since', '48h', '--json']);
  assert.equal(state.exitCode, 1);
  assert.equal(JSON.parse(output[0]).readBudget.exhausted, true);
});
