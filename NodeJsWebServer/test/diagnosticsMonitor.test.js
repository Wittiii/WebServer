const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, fork } = require('node:child_process');
const { once } = require('node:events');
const { createDiagnosticsLog } = require('../src/services/diagnosticsLogService');
const { getDiagnosticsConfig } = require('../src/services/diagnosticsConfig');
const { safeError } = require('../src/services/diagnosticsMonitorService');
const { readRecentRecords } = require('../src/services/diagnosticsReportService');

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-outage-diagnostics-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('rotated diagnostic history survives reopening, stays bounded, and serializes concurrent writes', async (t) => {
  const directory = await temporaryDirectory(t);
  const log = createDiagnosticsLog({ directory, maxBytes: 450, maxFiles: 4 });
  await Promise.all(Array.from({ length: 12 }, (_, index) => log.write({
    timestamp: new Date(1700000000000 + index).toISOString(), event: 'sample', index, note: 'x'.repeat(120),
  })));
  await log.flush();
  const names = await fs.readdir(directory);
  assert.equal(names.length, 4);
  for (const name of names) assert.ok((await fs.stat(path.join(directory, name))).size <= 450);
  const result = await readRecentRecords(directory, { tail: 20 });
  assert.equal(result.skippedLines, 0);
  assert.equal(result.records.at(-1).index, 11);
  assert.ok(result.records.length < 12);
  const indices = result.records.map((record) => record.index);
  assert.deepEqual(indices, [...indices].sort((a, b) => a - b));
});

test('log-write failure can recover and oversized events cannot exhaust the disk budget', async (t) => {
  const directory = await temporaryDirectory(t);
  const occupied = path.join(directory, 'occupied');
  await fs.writeFile(occupied, 'not a directory');
  const log = createDiagnosticsLog({ directory: occupied, maxBytes: 512, maxFiles: 4 });
  await assert.rejects(log.write({ event: 'sample' }));
  await fs.unlink(occupied);
  await log.write({ timestamp: new Date().toISOString(), event: 'sample', payload: 'x'.repeat(10000) });
  const result = await readRecentRecords(occupied);
  assert.equal(result.records[0].event, 'record_truncated');
  assert.ok((await fs.stat(path.join(occupied, 'diagnostics.jsonl'))).size <= 512);
});

test('configuration enables Linux automatically and caps resource budgets; diagnostic errors redact credentials', () => {
  assert.equal(getDiagnosticsConfig({}, 'linux').enabled, true);
  assert.equal(getDiagnosticsConfig({}, 'win32').enabled, false);
  const config = getDiagnosticsConfig({ DIAGNOSTICS_ENABLED: 'false', DIAGNOSTICS_INTERVAL_MS: '1', DIAGNOSTICS_MAX_FILE_MB: '999' }, 'linux');
  assert.equal(config.enabled, false);
  assert.equal(config.intervalMs, 5000);
  assert.equal(config.maxBytes, 20 * 1024 * 1024);
  const secret = 'test-password';
  const result = safeError(new Error(`http://admin:password@camera.invalid/ ${secret}`), { ADMIN_PASS: secret });
  assert.ok(!result.message.includes(secret));
  assert.ok(!result.message.includes('admin:password'));
});

test('HTTP probe requires a valid health body and times out even if headers arrive', { timeout: 5000 }, async (t) => {
  const { probeHttp } = require('../scripts/diagnostics-monitor');
  const server = http.createServer((req, res) => {
    if (req.headers.host.startsWith('127.0.0.1')) { res.writeHead(200); res.write('{'); }
    else { res.end(JSON.stringify({ ok: true })); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const result = await probeHttp({ host: '127.0.0.1', port: server.address().port }, 150);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'timeout');
  server.removeAllListeners('request');
  server.on('request', (_req, res) => res.end(JSON.stringify({ ok: true })));
  const healthy = await probeHttp({ host: '127.0.0.1', port: server.address().port }, 1000);
  assert.equal(healthy.ok, true);
  assert.equal(healthy.statusCode, 200);
});

test('a separate monitor persists an HTTP timeout while the application event loop is blocked', { timeout: 15000 }, async (t) => {
  const directory = await temporaryDirectory(t);
  const supervisorPath = path.resolve(__dirname, '../src/services/diagnosticsMonitorService.js');
  const fixture = `
    const http = require('node:http');
    const fs = require('node:fs');
    const path = require('node:path');
    const { startDiagnosticsMonitor } = require(${JSON.stringify(supervisorPath)});
    (async () => {
      const directory = process.argv[1];
      const server = http.createServer((_req, res) => res.end(JSON.stringify({ ok: true })));
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const diagnostics = startDiagnosticsMonitor({ config: { enabled: true, directory,
        intervalMs: 200, maxBytes: 1048576, maxFiles: 4, targetPath: directory } });
      diagnostics.event('server_starting');
      diagnostics.ready(server.address());
      const deadline = Date.now() + 5000;
      let healthy = false;
      while (Date.now() < deadline && !healthy) {
        try { healthy = fs.readFileSync(path.join(directory, 'diagnostics.jsonl'), 'utf8').split('\\n')
          .filter(Boolean).map(line => JSON.parse(line)).some(record => record.event === 'sample' && record.http?.ok); } catch {}
        if (!healthy) await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!healthy) throw new Error('collector did not record healthy sample');
      process.send({ type: 'blocking' });
      const until = Date.now() + 4500;
      while (Date.now() < until) {}
      diagnostics.event('server_stopping');
      await new Promise(resolve => server.close(resolve));
      await diagnostics.stop();
      process.disconnect();
    })().catch(error => { console.error(error); process.exit(1); });
  `;
  const child = spawn(process.execPath, ['-e', fixture, directory], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
  });
  const completion = once(child, 'exit');
  const [message] = await once(child, 'message');
  assert.equal(message.type, 'blocking');
  let observed = false;
  const deadline = Date.now() + 4300;
  while (Date.now() < deadline && !observed) {
    const history = await readRecentRecords(directory, { tail: 50 });
    observed = history.records.some((record) => record.issues?.includes('local_http_unresponsive'));
    if (!observed) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(observed, true, 'timeout evidence must be saved before the blocked application recovers');
  assert.equal(child.exitCode, null, 'application is still running when evidence is recorded');
  const [exitCode] = await completion;
  assert.equal(exitCode, 0, errors);
  const history = await readRecentRecords(directory, { tail: 50 });
  assert.equal(history.records.at(-1).event, 'server_stopped');
});

test('fatal exceptions retain Node exit behavior, redact diagnostic errors, and stop the orphan monitor', { timeout: 12000 }, async (t) => {
  const directory = await temporaryDirectory(t);
  const supervisorPath = path.resolve(__dirname, '../src/services/diagnosticsMonitorService.js');
  const fixture = `
    const { startDiagnosticsMonitor } = require(${JSON.stringify(supervisorPath)});
    process.env.ADMIN_PASS = 'fixture-secret-password';
    (async () => {
      const diagnostics = startDiagnosticsMonitor({ config: { enabled: true, directory: process.argv[1],
        intervalMs: 200, maxBytes: 1048576, maxFiles: 4, targetPath: process.argv[1] } });
      const deadline = Date.now() + 5000;
      while (!diagnostics.snapshot().active && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      if (!diagnostics.snapshot().active) throw new Error('monitor startup failed');
      process.send({ monitorPid: diagnostics.snapshot().monitorPid });
      setTimeout(() => { throw new Error('failure containing fixture-secret-password'); }, 20);
    })();
  `;
  const child = spawn(process.execPath, ['-e', fixture, directory], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
  const completion = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
  });
  const [message] = await once(child, 'message');
  assert.ok(message.monitorPid > 0);
  const [exitCode] = await completion;
  assert.equal(exitCode, 1, 'the exception monitor must preserve the default fatal exit');
  let history;
  let alive = true;
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    history = await readRecentRecords(directory, { tail: 50 });
    try { process.kill(message.monitorPid, 0); alive = true; } catch { alive = false; }
    if (!alive && history.records.some((record) => record.event === 'parent_disconnect')) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const fatal = history.records.find((record) => record.event === 'fatal');
  assert.ok(fatal, 'fatal IPC evidence is persisted while Node performs its normal exit');
  assert.equal(fatal.origin, 'uncaughtException');
  assert.ok(!fatal.error.message.includes('fixture-secret-password'));
  assert.ok(history.records.some((record) => record.event === 'parent_disconnect'));
  assert.equal(alive, false, 'a lost application must not leave a permanent diagnostic process behind');
});

test('an IPC disconnect is persisted and the independent collector exits', { timeout: 8000 }, async (t) => {
  const directory = await temporaryDirectory(t);
  const child = fork(path.resolve(__dirname, '../scripts/diagnostics-monitor.js'), [], {
    execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
  });
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
  });
  const completion = once(child, 'exit');
  const started = new Promise((resolve) => child.on('message', (message) => {
    if (message?.type === 'started') resolve();
  }));
  child.send({ type: 'init', config: { directory, intervalMs: 200,
    maxBytes: 1048576, maxFiles: 4, targetPath: directory }, runId: 'disconnect-test', parentPid: process.pid });
  await started;
  child.disconnect();
  const [exitCode] = await completion;
  assert.equal(exitCode, 0);
  const history = await readRecentRecords(directory, { tail: 50 });
  assert.ok(history.records.some((record) => record.event === 'parent_disconnect'));
});
