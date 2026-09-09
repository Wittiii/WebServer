const assert = require('node:assert/strict');
const test = require('node:test');
const { once } = require('node:events');
const express = require('express');
const session = require('express-session');
const { safeReturnPath, credentialsMatch, createLoginAttemptLimiter } = require('../src/services/loginSecurityService');
const { BoundedMemorySessionStore } = require('../src/services/boundedMemorySessionStore');
const requestOriginGuard = require('../src/middlewares/requestOriginGuard');
const apiAuth = require('../src/middlewares/apiAuth');
const authRoutes = require('../src/routes/auth/auth');

test('redirect targets reject external URLs, backslashes and stripped controls', () => {
  for (const target of ['https://other.example', '//other.example', '/\\other.example', '/\t/other.example', '/\n/other.example', ['//other.example'], null]) {
    assert.equal(safeReturnPath(target), '/');
  }
  assert.equal(safeReturnPath('/energy?period=24h'), '/energy?period=24h');
});

test('credentials fail closed for missing config or malformed values', () => {
  assert.equal(credentialsMatch(undefined, undefined, undefined, undefined), false);
  assert.equal(credentialsMatch('admin', 'secret', 'admin', 'secret'), true);
  assert.equal(credentialsMatch('admin', 'wrong', 'admin', 'secret'), false);
  assert.equal(credentialsMatch(['admin'], 'secret', 'admin', 'secret'), false);
  assert.equal(credentialsMatch('', '', '', ''), false);
});

test('login throttling expires and a successful login clears its failures', () => {
  let now = 1000;
  const limiter = createLoginAttemptLimiter({ maxAttempts: 2, windowMs: 10000, now: () => now });
  limiter.recordFailure('client');
  assert.equal(limiter.retryAfter('client'), 0);
  limiter.recordFailure('client');
  assert.equal(limiter.retryAfter('client'), 10);
  assert.equal(limiter.retryAfter('other'), 0);
  now += 10000;
  assert.equal(limiter.retryAfter('client'), 0);
  limiter.recordFailure('client');
  limiter.recordFailure('client');
  limiter.reset('client');
  assert.equal(limiter.retryAfter('client'), 0);
});

function storeCall(store, method, ...args) {
  return new Promise((resolve, reject) => store[method](...args, (error, result) => error ? reject(error) : resolve(result)));
}

test('session store expires abandoned sessions, limits memory and preserves active sessions at capacity', async (t) => {
  let now = 1000;
  const store = new BoundedMemorySessionStore({ maxEntries: 2, maxSessionBytes: 1024, ttlMs: 1000, now: () => now });
  t.after(() => store.close());
  await storeCall(store, 'set', 'a', { cookie: {}, user: { username: 'admin' } });
  await storeCall(store, 'set', 'b', { cookie: {} });
  await assert.rejects(storeCall(store, 'set', 'c', { cookie: {} }), /capacity/);
  assert.equal((await storeCall(store, 'get', 'a')).user.username, 'admin');
  await assert.rejects(storeCall(store, 'set', 'a', { cookie: {}, value: 'x'.repeat(1024) }), /too large/);
  now += 500;
  await storeCall(store, 'touch', 'a', { cookie: { expires: new Date(now + 1000) } });
  now += 500;
  assert.equal(await storeCall(store, 'length'), 1);
  assert.equal(await storeCall(store, 'get', 'b'), null);
  assert.equal((await storeCall(store, 'get', 'a')).user.username, 'admin');
  now += 500;
  assert.equal(await storeCall(store, 'get', 'a'), null);
});

test('HTTP login rotates sessions, prevents cross-site writes and rate-limits repeated failures', async (t) => {
  const previous = { ADMIN_USER: process.env.ADMIN_USER, ADMIN_PASS: process.env.ADMIN_PASS };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const store = new BoundedMemorySessionStore();
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(session({ secret: 'test-only-session-secret', resave: false, saveUninitialized: false, store, cookie: { maxAge: 3600000, sameSite: 'lax' } }));
  app.use(requestOriginGuard);
  app.use('/login', authRoutes);
  app.post('/protected', apiAuth, (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    store.close();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const postLogin = (body, headers = {}) => fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body });

  delete process.env.ADMIN_USER;
  delete process.env.ADMIN_PASS;
  const unconfigured = await postLogin('');
  assert.equal(unconfigured.status, 503);
  assert.equal(unconfigured.headers.get('set-cookie'), null);
  await unconfigured.text();
  process.env.ADMIN_USER = 'admin';
  process.env.ADMIN_PASS = 'test-password';

  const landing = await fetch(`${base}/login?next=${encodeURIComponent('/energy')}`);
  const originalCookie = landing.headers.get('set-cookie').split(';')[0];
  await landing.text();
  const login = await postLogin('username=admin&password=test-password', { Cookie: originalCookie, Origin: base });
  const loggedInCookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal(login.status, 302);
  assert.equal(login.headers.get('location'), '/energy');
  assert.notEqual(loggedInCookie, originalCookie);
  assert.match(login.headers.get('set-cookie'), /SameSite=Lax/);
  await login.text();

  for (const [cookie, loggedIn] of [[originalCookie, false], [loggedInCookie, true]]) {
    const status = await fetch(`${base}/login/status`, { headers: { Cookie: cookie } });
    assert.equal(status.headers.get('cache-control'), 'no-store');
    assert.equal((await status.json()).loggedIn, loggedIn);
  }
  for (const headers of [{ Origin: 'https://attacker.example' }, { Origin: 'null' }, { Referer: 'https://attacker.example/form' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const response = await fetch(`${base}/protected`, { method: 'POST', headers: { Cookie: loggedInCookie, ...headers } });
    assert.equal(response.status, 403);
    await response.text();
  }
  for (const headers of [{ Origin: base }, {}]) {
    const response = await fetch(`${base}/protected`, { method: 'POST', headers: { Cookie: loggedInCookie, ...headers } });
    assert.equal(response.status, 200);
    await response.text();
  }
  const logout = await fetch(`${base}/login/logout`, { method: 'POST', redirect: 'manual', headers: { Cookie: loggedInCookie, Origin: base } });
  assert.equal(logout.status, 302);
  await logout.text();
  const afterLogout = await fetch(`${base}/login/status`, { headers: { Cookie: loggedInCookie } });
  assert.equal((await afterLogout.json()).loggedIn, false);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const failure = await postLogin('username=admin&password=wrong');
    assert.equal(failure.status, 401);
    await failure.text();
  }
  const blocked = await postLogin('username=admin&password=test-password', { 'X-Forwarded-For': '203.0.113.42' });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  await blocked.text();
});
