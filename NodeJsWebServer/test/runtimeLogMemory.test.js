const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const path = require('node:path');

test('runtime logs keep their memory budget even when the configured line count is high', () => {
  const file = path.join(__dirname, '../src/services/runtimeLogService.js');
  const context = vm.createContext({
    require: createRequire(file), module: { exports: {} },
    process: { env: { RUNTIME_LOG_MAX_ENTRIES: '20000' } },
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  const logs = context.module.exports;
  logs.installConsoleCapture();
  for (let index = 0; index < 500; index++) context.console.log('x'.repeat(16000));
  const retained = logs.listEntries({ limit: 5000 });
  assert.ok(retained.length < 500);
  assert.ok(retained.length > 200);
  assert.ok(retained.reduce((bytes, entry) => bytes + entry.message.length * 2 + 160, 0) <= 8 * 1024 * 1024);
  assert.equal(logs.getLastId(), 500);
  assert.equal(retained.at(-1).id, 500);
  assert.equal(logs.listEntries({ after: 498 }).length, 2);
});
