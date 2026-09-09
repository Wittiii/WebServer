const path = require('node:path');

async function startServer() {
  require('dotenv').config({ path: process.env.ENV_FILE || path.join(__dirname, 'config', '.env') });
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
  const { createApp } = require('./app');
  const health = startRuntimeHealthMonitor();
  let app;
  let server;
  let stopping;

  function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      const httpClosed = server ? new Promise((resolve) => server.close(resolve)) : Promise.resolve();
      const drainTimer = setTimeout(() => server?.closeAllConnections(), 3000);
      drainTimer.unref();
      const results = await Promise.allSettled([
        stopAutomationEngine(), stopCameraTimelapseCaptureSupervisor(),
        stopEsp32TranscodeSupervisor(), stopTimelapseVideoBuilds(),
      ]);
      await httpClosed;
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
    app = createApp({ health });
    server = await new Promise((resolve, reject) => {
      const listener = app.listen(Number(process.env.PORT || 3000), process.env.HTTP_HOST || '0.0.0.0', () => {
        listener.removeListener('error', reject);
        resolve(listener);
      });
      listener.once('error', reject);
    });
    server.headersTimeout = 15000;
    server.requestTimeout = 30000;
    server.keepAliveTimeout = 5000;
    await startMqttBroker();
    startAutomationEngine();
    startEsp32TranscodeSupervisor();
    startCameraTimelapseCaptureSupervisor();
    console.log(`Server laeuft auf Port ${server.address().port}`);
    return { app, server, stop };
  } catch (error) {
    await stop();
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
