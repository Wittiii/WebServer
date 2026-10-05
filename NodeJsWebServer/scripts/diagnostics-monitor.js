const http = require('node:http');
const { performance } = require('node:perf_hooks');
const { createDiagnosticsLog } = require('../src/services/diagnosticsLogService');
const { createSystemDiagnosticsSampler } = require('../src/services/systemDiagnosticsService');

function probeHttp({ host, port }, timeoutMs = 3000) {
  const started = performance.now();
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, durationMs: Math.round(performance.now() - started) });
    };
    const request = http.get({ hostname: host, port, path: '/healthz', agent: false }, (response) => {
      let body = '';
      response.on('data', (chunk) => {
        if (Buffer.byteLength(body) + chunk.length > 1024) {
          finish({ ok: false, statusCode: response.statusCode, error: 'invalid_health_response' });
          request.destroy();
        } else { body += chunk.toString('utf8'); }
      });
      response.on('end', () => {
        let valid = false;
        try { valid = JSON.parse(body).ok === true; } catch {}
        finish({ ok: response.statusCode === 200 && valid, statusCode: response.statusCode,
          ...(response.statusCode === 200 && valid ? {} : { error: 'invalid_health_response' }) });
      });
      response.on('error', (error) => finish({ ok: false, error: error.code || 'response_error' }));
    });
    request.on('error', (error) => finish({ ok: false, error: error.code || 'request_error' }));
    timer = setTimeout(() => {
      finish({ ok: false, error: 'timeout' });
      request.destroy();
    }, timeoutMs);
  });
}

function startCollector(config, { runId, parentPid }) {
  const log = createDiagnosticsLog(config);
  const sampler = createSystemDiagnosticsSampler({ targetPath: config.targetPath });
  const started = performance.now();
  let lastHeartbeat = started;
  let runtime = null;
  let eventLoopMaxMs = 0;
  let target = null;
  let phase = 'starting';
  let timer;
  let runningSample = null;
  let stopping = null;
  let lastErrorAt = -Infinity;
  let logWritable = null;

  function logState(writable) {
    if (logWritable === writable) return;
    logWritable = writable;
    if (process.connected) process.send({ type: 'log_state', writable }, () => {});
  }

  function notifyError(error) {
    if (performance.now() - lastErrorAt < 60000) return;
    lastErrorAt = performance.now();
    const safe = { code: error.code || 'DIAGNOSTICS_ERROR', message: 'Diagnostic collection or log write failed' };
    console.error('[Diagnostics]', safe.code);
    if (process.connected) process.send({ type: 'error', error: safe }, () => {});
  }
  function record(event, details = {}) {
    return log.write({ ...details, timestamp: new Date().toISOString(), event, runId })
      .then((written) => { if (written) logState(true); return written; })
      .catch((error) => { logState(false); notifyError(error); });
  }
  async function sample() {
    const sampleStarted = performance.now();
    const heartbeatAgeMs = Math.round(sampleStarted - lastHeartbeat);
    const runtimeSnapshot = runtime?.eventLoop
      ? { ...runtime, eventLoop: { ...runtime.eventLoop, maxMs: eventLoopMaxMs } } : runtime;
    eventLoopMaxMs = 0;
    const [systemResult, httpResult] = await Promise.allSettled([
      sampler.sample(), target ? probeHttp(target) : Promise.resolve({ ok: null, error: 'server_not_ready' }),
    ]);
    const system = systemResult.status === 'fulfilled' ? systemResult.value : null;
    const httpStatus = httpResult.status === 'fulfilled' ? httpResult.value : { ok: false, error: 'probe_failed' };
    const issues = [];
    if (!system) issues.push('system_sample_failed');
    if (heartbeatAgeMs > 15000) issues.push('parent_heartbeat_missing');
    if (phase === 'running' && httpStatus.ok === false) issues.push('local_http_unresponsive');
    if (runtimeSnapshot?.eventLoop?.maxMs > 500) issues.push('node_event_loop_delay');
    await record('sample', { parentPid, phase, heartbeatAgeMs, runtime: runtimeSnapshot, http: httpStatus,
      system, issues, collectionDurationMs: Math.round(performance.now() - sampleStarted) });
  }
  function tick() {
    if (stopping) return;
    runningSample = sample().catch(notifyError).finally(() => {
      runningSample = null;
      if (!stopping) timer = setTimeout(tick, config.intervalMs);
    });
  }
  function stop(event, details) {
    if (stopping) return stopping;
    clearTimeout(timer);
    phase = 'stopping';
    stopping = (async () => {
      // A disconnect/signal is evidence worth saving immediately. A clean-stop
      // marker belongs after the last sample; the parent already logged stopping.
      if (event !== 'server_stopped') await record(event, details);
      if (runningSample) await runningSample;
      if (event === 'server_stopped') await record(event, details);
      await log.flush();
      if (process.connected) process.disconnect();
    })();
    return stopping;
  }

  void record('monitor_start', { parentPid, monitorPid: process.pid, intervalMs: config.intervalMs,
    platform: process.platform, logMaxBytes: config.maxBytes * config.maxFiles }).then(() => {
    if (process.connected) process.send({ type: 'started' }, () => {});
    if (!stopping) tick();
  });
  return {
    message(message) {
      if (message?.type === 'heartbeat') {
        lastHeartbeat = performance.now();
        runtime = message.runtime;
        eventLoopMaxMs = Math.max(eventLoopMaxMs, Number(runtime?.eventLoop?.maxMs) || 0);
      }
      if (message?.type === 'ready') {
        target = { host: message.host, port: message.port };
        phase = 'running';
        void record('server_ready', { parentPid, port: message.port });
      }
      if (message?.type === 'event') {
        if (message.event === 'server_stopping') phase = 'stopping';
        void record(message.event, message.details);
      }
      if (message?.type === 'stop') void stop('server_stopped', { reason: message.reason });
    },
    stop,
  };
}

if (require.main === module) {
  let collector;
  const initializationTimeout = setTimeout(() => process.exit(1), 10000);
  process.on('message', (message) => {
    if (message?.type === 'init' && !collector) {
      clearTimeout(initializationTimeout);
      collector = startCollector(message.config, { runId: message.runId, parentPid: message.parentPid });
    } else { collector?.message(message); }
  });
  process.on('disconnect', () => {
    clearTimeout(initializationTimeout);
    if (collector) void collector.stop('parent_disconnect', { reason: 'parent_exited_or_ipc_closed' });
  });
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      clearTimeout(initializationTimeout);
      if (collector) void collector.stop('monitor_signal', { signal });
    });
  }
}

module.exports = { probeHttp, startCollector };
