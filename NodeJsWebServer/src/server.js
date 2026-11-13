const https = require('node:https');
const path = require('node:path');

async function startServerRuntime(diagnostics) {
  if (!process.env.SESSION_SECRET) throw new Error('SESSION_SECRET must be configured in src/config/.env');
  const { installConsoleCapture } = require('./services/runtimeLogService');
  installConsoleCapture();
  const db = require('./database/db');
  const { startMqttBroker, stopMqttBroker } = require('./mqttBroker');
  const { startAutomationEngine, stopAutomationEngine } = require('./services/automationService');
  const { startEsp32TranscodeSupervisor, stopEsp32TranscodeSupervisor } = require('./services/esp32TranscodeService');
  const { startCameraTimelapseCaptureSupervisor, stopCameraTimelapseCaptureSupervisor } = require('./services/cameraTimelapseCaptureService');
  const { stopTimelapseVideoBuilds } = require('./services/timelapseService');
  const { startRuntimeHealthMonitor } = require('./services/runtimeHealthService');
  const { attachCameraIntercomWebSocket } = require('./services/cameraIntercomService');
  const { isHttpsEnabled, resolveHttpsPort, ensureLocalTlsCredentials } = require('./services/localHttpsService');
  const { createApp } = require('./app');
  const health = startRuntimeHealthMonitor();
  let app;
  let server;
  let httpsServer;
  let intercomWs;
  let httpsIntercomWs;
  let stopping;

  function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      const httpClosed = server ? new Promise((resolve) => server.close(resolve)) : Promise.resolve();
      const httpsClosed = httpsServer ? new Promise((resolve) => httpsServer.close(resolve)) : Promise.resolve();
      const drainTimer = setTimeout(() => {
        server?.closeAllConnections();
        httpsServer?.closeAllConnections();
      }, 3000);
      drainTimer.unref();
      const results = await Promise.allSettled([
        stopAutomationEngine(), stopCameraTimelapseCaptureSupervisor(),
        stopEsp32TranscodeSupervisor(), stopTimelapseVideoBuilds(),
      ]);
      intercomWs?.closeAll();
      httpsIntercomWs?.closeAll();
      await Promise.all([httpClosed, httpsClosed]);
      clearTimeout(drainTimer);
      await stopMqttBroker();
      health.stop();
      app?.locals.sessionStore.close();
      if (db.open) db.close();
      const failure = results.find((result) => result.status === 'rejected');
      if (failure) throw failure.reason;
    })();
    return stopping;
  }

  try {
    app = createApp({ health, diagnostics });
    const httpHost = process.env.HTTP_HOST || '0.0.0.0';
    server = await new Promise((resolve, reject) => {
      const listener = app.listen(Number(process.env.PORT || 3000), httpHost, () => {
        listener.removeListener('error', reject);
        resolve(listener);
      });
      listener.once('error', reject);
    });
    server.headersTimeout = 15000;
    server.requestTimeout = 30000;
    server.keepAliveTimeout = 5000;
    intercomWs = attachCameraIntercomWebSocket(server, {
      sessionMiddleware: app.locals.sessionMiddleware,
    });
    if (isHttpsEnabled()) {
      const tls = await ensureLocalTlsCredentials();
      httpsServer = await new Promise((resolve, reject) => {
        const listener = https.createServer({ key: tls.key, cert: tls.cert }, app);
        listener.once('error', reject);
        listener.listen(resolveHttpsPort(), httpHost, () => {
          listener.removeListener('error', reject);
          resolve(listener);
        });
      });
      httpsServer.headersTimeout = 15000;
      httpsServer.requestTimeout = 30000;
      httpsServer.keepAliveTimeout = 5000;
      httpsIntercomWs = attachCameraIntercomWebSocket(httpsServer, {
        sessionMiddleware: app.locals.sessionMiddleware,
      });
      console.log(`HTTPS Server laeuft auf Port ${httpsServer.address().port}`);
    }
    await startMqttBroker();
    startAutomationEngine();
    startEsp32TranscodeSupervisor();
    startCameraTimelapseCaptureSupervisor();
    console.log(`Server laeuft auf Port ${server.address().port}`);
    return { app, server, httpsServer, stop, health };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function startServer() {
  require('dotenv').config({ path: process.env.ENV_FILE || path.join(__dirname, 'config', '.env') });
  const { startDiagnosticsMonitor } = require('./services/diagnosticsMonitorService');
  let runtime;
  const diagnostics = startDiagnosticsMonitor({ getSnapshot: () => runtime?.health.snapshot() });
  diagnostics.event('server_starting', { pid: process.pid });
  try {
    runtime = await startServerRuntime(diagnostics);
    diagnostics.ready(runtime.server.address());
    let stopping;
    return {
      app: runtime.app, server: runtime.server, httpsServer: runtime.httpsServer, diagnostics,
      stop() {
        if (!stopping) {
          diagnostics.event('server_stopping');
          stopping = runtime.stop().finally(() => diagnostics.stop());
        }
        return stopping;
      },
    };
  } catch (error) {
    diagnostics.fatal(error, 'startup');
    await diagnostics.stop({ reason: 'startup_failed' });
    throw error;
  }
}

async function run() {
  try {
    const runtime = await startServer();
    let stopping = false;
    const shutdown = async (signal) => {
      if (stopping) return;
      stopping = true;
      console.log(`[Server] ${signal}: stopping background jobs and connections`);
      const timeout = setTimeout(() => {
        console.error('[Server] shutdown timed out');
        process.exit(1);
      }, 15000);
      timeout.unref();
      try {
        await runtime.stop();
        console.log('[Server] shutdown complete');
      } catch (error) {
        console.error('[Server] shutdown failed', error);
        process.exitCode = 1;
      } finally {
        clearTimeout(timeout);
      }
    };
    process.once('SIGINT', () => { void shutdown('SIGINT'); });
    process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  } catch (error) {
    console.error('[Server] startup failed', error);
    process.exitCode = 1;
  }
}

module.exports = { startServer, run };
if (require.main === module) void run();
