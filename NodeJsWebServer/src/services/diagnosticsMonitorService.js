const path = require('node:path');
const { fork } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { getDiagnosticsConfig } = require('./diagnosticsConfig');

function safeError(error, env = process.env) {
  let message = String(error?.message || error || 'unknown error');
  for (const key of ['SESSION_SECRET', 'ADMIN_PASS', 'MQTT_PASS']) {
    if (env[key]) message = message.split(env[key]).join('[redacted]');
  }
  message = message.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@');
  return { name: String(error?.name || 'Error').slice(0, 80),
    code: error?.code == null ? undefined : String(error.code).slice(0, 80), message: message.slice(0, 1000) };
}

function startDiagnosticsMonitor({ config = getDiagnosticsConfig(), getSnapshot } = {}) {
  const runId = randomUUID();
  let child;
  let stopping;
  let active = false;
  let logging = config.enabled ? null : false;
  let heartbeatTimer;
  let sendingHeartbeat = false;
  let lastError = null;

  const snapshot = () => ({ enabled: config.enabled, active, logging, runId,
    monitorPid: child?.pid || null, logDirectory: config.directory,
    intervalMs: config.intervalMs, lastError });

  function warn(error) {
    lastError = safeError(error);
    console.warn('[Diagnostics] monitor unavailable:', lastError.code || lastError.message);
  }
  function send(message, callback = () => {}) {
    if (!child?.connected) { callback(); return false; }
    try { return child.send(message, (error) => { if (error && !stopping) lastError = safeError(error); callback(error); }); }
    catch (error) { if (!stopping) lastError = safeError(error); callback(error); return false; }
  }
  function event(eventName, details = {}) {
    send({ type: 'event', event: eventName, details });
  }
  function heartbeat() {
    if (sendingHeartbeat || !child?.connected) return;
    sendingHeartbeat = true;
    let runtime;
    try { runtime = getSnapshot?.() || { uptimeSeconds: Math.floor(process.uptime()), memoryBytes: process.memoryUsage() }; }
    catch { runtime = { uptimeSeconds: Math.floor(process.uptime()) }; }
    send({ type: 'heartbeat', runtime }, () => { sendingHeartbeat = false; });
  }
  const onFatal = (error, origin) => event('fatal', { origin, error: safeError(error) });

  if (config.enabled) {
    try {
      // The collector does not need application credentials or MQTT payloads.
      const childEnv = { LANG: 'C', LC_ALL: 'C' };
      for (const key of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR']) {
        if (process.env[key] != null) childEnv[key] = process.env[key];
      }
      child = fork(path.join(__dirname, '../../scripts/diagnostics-monitor.js'), [], {
        env: childEnv, execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true,
        // Windows otherwise kills the collector with its parent, before its IPC
        // disconnect handler can flush. Linux retains normal service grouping.
        detached: process.platform === 'win32',
      });
      child.on('error', warn);
      child.on('message', (message) => {
        if (message?.type === 'started') {
          active = true;
          if (logging) console.log(`[Diagnostics] persistent samples: ${config.directory}`);
        }
        if (message?.type === 'log_state') {
          logging = message.writable;
          if (logging) lastError = null;
        }
        if (message?.type === 'error') { lastError = message.error; console.warn('[Diagnostics] log/collection error:', message.error?.code || message.error?.message); }
      });
      child.on('exit', (code, signal) => {
        active = false;
        logging = false;
        clearInterval(heartbeatTimer);
        process.removeListener('uncaughtExceptionMonitor', onFatal);
        if (!stopping) warn({ message: `collector exited (${signal || code})`, code: 'MONITOR_EXIT' });
      });
      send({ type: 'init', config, runId, parentPid: process.pid });
      heartbeat();
      heartbeatTimer = setInterval(heartbeat, 5000);
      heartbeatTimer.unref();
      process.on('uncaughtExceptionMonitor', onFatal);
      // Diagnostics must not keep an otherwise stopped server alive.
      child.unref();
      child.channel?.unref();
    } catch (error) { warn(error); }
  }

  function stop({ reason = 'shutdown' } = {}) {
    if (stopping) return stopping;
    stopping = new Promise((resolve) => {
      clearInterval(heartbeatTimer);
      process.removeListener('uncaughtExceptionMonitor', onFatal);
      if (!child || child.exitCode !== null || !child.connected) { active = false; resolve(); return; }
      let timeout;
      const done = () => { clearTimeout(timeout); child.removeListener('exit', done); active = false; resolve(); };
      child.once('exit', done);
      timeout = setTimeout(() => { child.kill('SIGKILL'); done(); }, 5000);
      send({ type: 'stop', reason });
    });
    return stopping;
  }

  return {
    snapshot, event, stop,
    ready(address) {
      if (address && typeof address === 'object') {
        const host = address.address === '::' ? '::1' : address.address === '0.0.0.0' ? '127.0.0.1' : address.address;
        send({ type: 'ready', host, port: address.port });
      }
    },
    fatal: (error, origin) => event('fatal', { origin, error: safeError(error) }),
  };
}

module.exports = { startDiagnosticsMonitor, safeError };
