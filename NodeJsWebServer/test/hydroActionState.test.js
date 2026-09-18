const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function setup() {
  const controls = [{ disabled: false, isConnected: true }, { disabled: true, isConnected: true }];
  const hint = { textContent: '' };
  const listeners = {};
  const element = { addEventListener: (event, fn) => { listeners[event] = fn; }, setAttribute() {} };
  const context = vm.createContext({ document: { querySelectorAll: () => controls, getElementById: () => hint } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/pages/hydroponic/action-state.js'), 'utf8'), context);
  return { controls, hint, element, listeners, actions: context.HydroActions };
}

test('pending object writes lock selection and reject repeated submissions until refresh completes', async () => {
  const { actions, controls, element, listeners, hint } = setup();
  let release, calls = 0;
  actions.bind(element, 'submit', async () => { calls++; await new Promise((resolve) => { release = resolve; }); });
  const event = { preventDefault() {} };
  const first = listeners.submit(event);
  assert.equal(actions.busy, true);
  assert.equal(controls[0].disabled, true);
  await listeners.submit(event);
  assert.equal(calls, 1);
  release(); await first;
  assert.equal(actions.busy, false);
  assert.equal(controls[0].disabled, false);
  assert.equal(controls[1].disabled, true);
  assert.equal(hint.textContent, '');
});

test('failed writes restore controls and show a recoverable error', async () => {
  const { actions, controls, element, listeners, hint } = setup();
  actions.bind(element, 'submit', async () => { throw new Error('offline'); });
  await listeners.submit({ preventDefault() {} });
  assert.equal(actions.busy, false);
  assert.equal(controls[0].disabled, false);
  assert.match(hint.textContent, /offline/);
});
