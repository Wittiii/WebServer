const test = require('node:test');
const assert = require('node:assert/strict');
const { getHomeOverview } = require('../src/controllers/homeController');

test('home overview returns loggedIn false when unauthenticated', () => {
  const req = { session: {} };
  let jsonOutput = null;
  const res = {
    json(data) {
      jsonOutput = data;
    },
    status() {
      return this;
    }
  };

  getHomeOverview(req, res);
  assert.deepEqual(jsonOutput, { ok: true, loggedIn: false });
});

test('home overview returns telemetry structures when authenticated', () => {
  const req = { session: { user: 'admin' } };
  let jsonOutput = null;
  const res = {
    json(data) {
      jsonOutput = data;
    },
    status() {
      return this;
    }
  };

  getHomeOverview(req, res);
  assert.equal(jsonOutput.ok, true);
  assert.equal(jsonOutput.loggedIn, true);
  assert.ok('power' in jsonOutput);
  assert.ok('solar' in jsonOutput);
  assert.ok('hydro' in jsonOutput);
  assert.ok('system' in jsonOutput);

  if (jsonOutput.system) {
    assert.equal(typeof jsonOutput.system.camerasTotal, 'number');
    assert.equal(typeof jsonOutput.system.uptimeSeconds, 'number');
  }
});
