const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('full server startup, protected APIs, login and orderly shutdown use only an isolated database', { timeout: 15000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'server-runtime-'));
  Object.assign(process.env, {
    ENV_FILE: path.join(directory, 'no-env'), DATABASE_PATH: path.join(directory, 'test.db'),
    SESSION_SECRET: 'test-only-session-secret-abcdefghijklmnopqrstuvwxyz',
    ADMIN_USER: 'test-admin', ADMIN_PASS: 'test-password',
    HTTP_HOST: '127.0.0.1', PORT: '0', MQTT_TCP_PORT: '0', MQTT_WS_PORT: '0',
    MQTT_USER: 'test-user', MQTT_PASS: 'test-password', MQTT_LOG_MESSAGES: 'false',
    ESP32_TRANSCODE_ENABLED: 'false',
    CAMERA_PI_TIMELAPSE_ENABLED: 'false', CAMERA_ESP32_TIMELAPSE_ENABLED: 'false', CAMERA_DFR1154_TIMELAPSE_ENABLED: 'false',
    CAMERA_PI_TIMELAPSE_DIR: path.join(directory, 'pi'),
    CAMERA_ESP32_TIMELAPSE_DIR: path.join(directory, 'esp'),
    CAMERA_DFR1154_TIMELAPSE_DIR: path.join(directory, 'dfr'),
  });
  delete process.env.TRUST_PROXY;
  const { startServer } = require('../src/server');
  const runtime = await startServer();
  const origin = `http://127.0.0.1:${runtime.server.address().port}`;
  try {
    const health = await fetch(`${origin}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    assert.equal(health.headers.get('x-powered-by'), null);
    for (const route of ['/api/mqtt/topics', '/api/mqtt/clients', '/api/objects', '/api/camera/overview', '/api/system/status']) {
      const response = await fetch(origin + route);
      assert.equal(response.status, 401, route);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    const denied = await fetch(`${origin}/login`, { method: 'POST', headers: { Origin: 'https://attacker.invalid' } });
    assert.equal(denied.status, 403);
    const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ username: 'test-admin', password: 'test-password' }) });
    assert.equal(login.status, 302);
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    const headers = { Cookie: cookie.split(';')[0] };
    const metrics = await fetch(`${origin}/api/system/status`, { headers });
    assert.equal(metrics.status, 200);
    assert.ok((await metrics.json()).memoryBytes.rss > 0);
    const topics = await fetch(`${origin}/api/mqtt/topics`, { headers });
    assert.equal(topics.status, 200);
    assert.ok(Array.isArray(await topics.json()));
    const malformed = await fetch(`${origin}/api/mqtt/publish`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{bad',
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { ok: false, error: 'invalid_request' });
  } finally {
    await runtime.stop();
    await runtime.stop();
    assert.equal(require('../src/database/db').open, false);
    assert.equal(runtime.server.listening, false);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
