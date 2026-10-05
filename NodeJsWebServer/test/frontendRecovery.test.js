const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');
const test = require('node:test');

function sourceBetween(relativeFile, start, end) {
  const source = fs.readFileSync(path.join(__dirname, '..', relativeFile), 'utf8');
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, 'production function boundaries must exist');
  return source.slice(first, last);
}

async function slowServer(t, { healthyBody = '[]' } = {}) {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (requests === 2) res.end(healthyBody);
    else {
      // Headers have arrived, but the response body never finishes.
      res.write(healthyBody.slice(0, 1));
      server.emit('body_pending', requests);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const timeouts = [];
  const browser = {
    fetch: (url, options) => fetch(origin + url, options),
    URLSearchParams,
    AbortSignal: {
      timeout(milliseconds) {
        timeouts.push(milliseconds);
        return AbortSignal.timeout(200);
      },
      any: (signals) => AbortSignal.any(signals),
    },
  };
  return { server, browser, timeouts, requests: () => requests };
}

test('energy refresh releases its guard after an unfinished response body and retries successfully', { timeout: 5000 }, async (t) => {
  const remote = await slowServer(t, { healthyBody: '{"ok":true}' });
  const rendered = [];
  const messages = [];
  const context = vm.createContext({
    ...remote.browser,
    document: { hidden: false },
    elements: { error: {} },
    setText: (_element, message) => messages.push(message),
    render: (data) => rendered.push(data),
  });
  vm.runInContext(`let refreshInFlight = false;
    const selectedPeriod = 'day', selectedVictronPeriod = 'day';
    ${sourceBetween('public/pages/energy/energy.js', 'async function refresh(force = false)', '\ndocument.querySelectorAll("[data-period]")')}`, context);

  await context.refresh();
  assert.equal(vm.runInContext('refreshInFlight', context), false);
  assert.ok(messages.some((message) => message.startsWith('Stromdaten konnten nicht geladen werden:')));
  await context.refresh();
  assert.equal(vm.runInContext('refreshInFlight', context), false);
  assert.deepEqual(rendered, [{ ok: true }]);
  assert.equal(remote.requests(), 2);
  assert.deepEqual(remote.timeouts, [12000, 12000]);
});

test('hydroponic polling recovers from an unfinished body and keeps caller cancellation', { timeout: 5000 }, async (t) => {
  const remote = await slowServer(t);
  let interval;
  const results = [];
  const context = vm.createContext({
    ...remote.browser,
    document: { hidden: false },
    autoRefreshSec: { value: 2 },
    getSelectedObject: () => ({ id: 7 }),
    getSelectedKey: () => 'temperature',
    getDateRange: () => ({}),
    isReadingsLogOpen: () => false,
    setInterval(callback) { interval = callback; return 1; },
    clearInterval() {},
  });
  vm.runInContext(`let autoRefreshTimer;
    ${sourceBetween('public/pages/hydroponic/hydroponic.js', 'async function fetchReadings(', '\nlet chartRequestController')}
    async function loadReadings() {
      try { results.push(await fetchReadings(20)); }
      catch (error) { results.push(error.name); }
    }
    ${sourceBetween('public/pages/hydroponic/hydroponic.js', 'function startAutoRefresh()', '\nfunction setupAutoRefresh()')}`, Object.assign(context, { results }));

  context.startAutoRefresh();
  await interval();
  assert.equal(results[0], 'TimeoutError');
  await interval();
  assert.equal(results[1].length, 0);
  assert.equal(remote.requests(), 2, 'the refresh guard must admit a retry');

  const controller = new AbortController();
  const pendingBody = once(remote.server, 'body_pending');
  const cancelled = context.fetchReadings(20, true, false, controller.signal);
  const rejection = assert.rejects(cancelled, { name: 'AbortError' });
  await pendingBody;
  controller.abort(new DOMException('Selection changed', 'AbortError'));
  await rejection;
  assert.equal(remote.requests(), 3);
  assert.deepEqual(remote.timeouts, [12000, 12000, 12000]);
});
