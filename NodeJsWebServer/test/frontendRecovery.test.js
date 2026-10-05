const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function sourceBetween(relativeFile, start, end) {
  const source = fs.readFileSync(path.join(__dirname, '..', relativeFile), 'utf8');
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, 'production function boundaries must exist');
  return source.slice(first, last);
}

async function slowServer(t, { healthyBody = '[]', healthyDelayMs = 350 } = {}) {
  let requests = 0;
  const responseTimers = new Set();
  const server = http.createServer((_req, res) => {
    requests += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (requests === 2) {
      // A healthy response may take longer than the former 200 ms test limit,
      // particularly when the complete suite runs concurrently on a Pi.
      const timer = setTimeout(() => {
        responseTimers.delete(timer);
        res.end(healthyBody);
      }, healthyDelayMs);
      responseTimers.add(timer);
    } else {
      // Headers have arrived, but the response body never finishes.
      res.write(healthyBody.slice(0, 1));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const timer of responseTimers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const timeouts = [];
  const timeoutControllers = [];
  const bodyReads = [];
  let fetches = 0;
  function bodyRead(index) {
    if (!bodyReads[index]) {
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      bodyReads[index] = { promise, resolve };
    }
    return bodyReads[index];
  }
  const browser = {
    async fetch(url, options) {
      const index = fetches++;
      const response = await fetch(origin + url, options);
      const readJson = response.json.bind(response);
      response.json = (...args) => {
        const pending = readJson(...args);
        bodyRead(index).resolve();
        return pending;
      };
      return response;
    },
    URLSearchParams,
    AbortSignal: {
      timeout(milliseconds) {
        timeouts.push(milliseconds);
        // Advance the deadline explicitly once the client reads the hanging
        // body, never while an unrelated healthy request waits for CPU time.
        const controller = new AbortController();
        timeoutControllers.push(controller);
        return controller.signal;
      },
      any: (signals) => AbortSignal.any(signals),
    },
  };
  return {
    browser, timeouts, requests: () => requests,
    bodyStarted: (index) => bodyRead(index).promise,
    expireTimeout(index) {
      assert.ok(timeoutControllers[index], 'the production request must set a deadline');
      timeoutControllers[index].abort(new DOMException('Response deadline elapsed', 'TimeoutError'));
    },
  };
}

test('energy refresh releases its guard after an unfinished response body and retries successfully', { timeout: 10000 }, async (t) => {
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

  const stalled = context.refresh();
  await remote.bodyStarted(0);
  remote.expireTimeout(0);
  await stalled;
  assert.equal(vm.runInContext('refreshInFlight', context), false);
  assert.ok(messages.some((message) => message.startsWith('Stromdaten konnten nicht geladen werden:')));
  await context.refresh();
  assert.equal(vm.runInContext('refreshInFlight', context), false);
  assert.deepEqual(rendered, [{ ok: true }]);
  assert.equal(remote.requests(), 2);
  assert.deepEqual(remote.timeouts, [12000, 12000]);
});

test('hydroponic polling recovers from an unfinished body and keeps caller cancellation', { timeout: 10000 }, async (t) => {
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
  const stalled = interval();
  await remote.bodyStarted(0);
  remote.expireTimeout(0);
  await stalled;
  assert.equal(results[0], 'TimeoutError');
  await interval();
  assert.equal(results[1].length, 0);
  assert.equal(remote.requests(), 2, 'the refresh guard must admit a retry');

  const controller = new AbortController();
  const cancelled = context.fetchReadings(20, true, false, controller.signal);
  const rejection = assert.rejects(cancelled, { name: 'AbortError' });
  await remote.bodyStarted(2);
  controller.abort(new DOMException('Selection changed', 'AbortError'));
  await rejection;
  assert.equal(remote.requests(), 3);
  assert.deepEqual(remote.timeouts, [12000, 12000, 12000]);
});
