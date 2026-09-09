const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webserver-automation-'));
process.env.DATABASE_PATH = path.join(directory, 'test.db');
process.env.SQLITE_JOURNAL_MODE = 'DELETE';
const db = require('../src/database/db');
const published = [];
let publishImplementation = async (topic, payload) => published.push({ topic, payload });
const brokerPath = require.resolve('../src/mqttBroker');
require.cache[brokerPath] = {
  id: brokerPath,
  filename: brokerPath,
  loaded: true,
  exports: { publish: (...args) => publishImplementation(...args) },
};
const { processRules, startAutomationEngine, stopAutomationEngine } = require('../src/services/automationService');
const controller = require('../src/controllers/objectsController');
const now = new Date('2026-09-06T12:00:00Z');
const timestamp = now.toISOString();

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function createRule(overrides = {}, objectId = 1) {
  const res = response();
  controller.createAutomationRule({
    params: { id: objectId },
    body: {
      name: 'Temperature action', triggerType: 'value', valueKey: 'temperature',
      operator: '=', compareValue: '20',
      actions: [{ actionTopic: 'test/relay', actionPayload: 'ON' }],
      ...overrides,
    },
  }, res);
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  return res.body.id;
}

function reading(value) {
  db.prepare(`INSERT INTO object_readings
    (object_id, topic, value_key, value_text, raw_payload, created_at)
    VALUES (1, 'test/sensor', 'temperature', ?, '{}', ?)`)
    .run(String(value), timestamp);
}

test.beforeEach(() => {
  db.exec(`DELETE FROM object_automation_rule_actions;
    DELETE FROM object_automation_rules;
    DELETE FROM object_readings;
    DELETE FROM objects;`);
  db.prepare('INSERT INTO objects (id, name, created_at) VALUES (1, ?, ?), (2, ?, ?)')
    .run('First', timestamp, 'Second', timestamp);
  published.length = 0;
  publishImplementation = async (topic, payload) => published.push({ topic, payload });
});

test.after(async () => {
  await stopAutomationEngine();
  db.close();
  fs.rmSync(process.env.DATABASE_PATH, { force: true });
  fs.rmdirSync(directory);
  delete require.cache[brokerPath];
});

test('numeric equality and inequality rules fire once per condition transition', async () => {
  const equalId = createRule();
  const unequalId = createRule({ operator: '!=', compareValue: '20' });
  reading(20);
  await processRules(now);
  await processRules(now);
  assert.equal(published.length, 1);
  assert.equal(db.prepare('SELECT last_condition_state FROM object_automation_rules WHERE id = ?').get(equalId).last_condition_state, 1);
  reading(21);
  await processRules(now);
  assert.equal(published.length, 2);
  assert.equal(db.prepare('SELECT last_condition_state FROM object_automation_rules WHERE id = ?').get(unequalId).last_condition_state, 1);
});

test('text equality rules fire and zero-hysteresis comparisons rearm at the threshold', async () => {
  createRule({ compareValue: 'ON' });
  reading('ON');
  await processRules(now);
  assert.equal(published.length, 1);

  db.exec('UPDATE object_automation_rules SET enabled = 0');
  createRule({ operator: '>', compareValue: '20', hysteresisValue: 0 });
  reading(21);
  await processRules(now);
  reading(20);
  await processRules(now);
  reading(21);
  await processRules(now);
  assert.equal(published.length, 3);
});

test('positive hysteresis prevents repeated triggers inside the deadband', async () => {
  createRule({ operator: '>', compareValue: '20', hysteresisValue: 2 });
  for (const value of [21, 20, 19, 21, 17, 21]) {
    reading(value);
    await processRules(now);
  }
  assert.equal(published.length, 2);
});

test('failed publishes do not permanently consume the condition transition', async (t) => {
  t.mock.method(console, 'error', () => {});
  createRule();
  reading(20);
  publishImplementation = async () => { throw new Error('broker unavailable'); };
  await processRules(now);
  publishImplementation = async (topic, payload) => published.push({ topic, payload });
  await processRules(now);
  assert.deepEqual(published, [{ topic: 'test/relay', payload: 'ON' }]);
});

test('shutdown waits for an in-flight rule and overlapping polls share its task', async () => {
  createRule();
  reading(20);
  let finishPublish;
  publishImplementation = () => new Promise((resolve) => { finishPublish = resolve; });
  startAutomationEngine();
  const pending = processRules(now);
  assert.equal(processRules(now), pending);
  let stopped = false;
  const stopping = stopAutomationEngine().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  finishPublish();
  await stopping;
  assert.equal(stopped, true);
});

test('updating or deleting a rule through another object does not change its actions', () => {
  const ruleId = createRule();
  const before = db.prepare('SELECT * FROM object_automation_rule_actions WHERE rule_id = ?').all(ruleId);
  const updateResponse = response();
  controller.updateAutomationRule({
    params: { id: 2, ruleId },
    body: { name: 'Other', triggerType: 'value', valueKey: 'temperature', operator: '=', compareValue: '10',
      actions: [{ actionTopic: 'other/relay', actionPayload: 'OFF' }] },
  }, updateResponse);
  assert.equal(updateResponse.statusCode, 200);
  assert.equal(updateResponse.body.updated, 0);
  assert.deepEqual(db.prepare('SELECT * FROM object_automation_rule_actions WHERE rule_id = ?').all(ruleId), before);

  const deleteResponse = response();
  controller.deleteAutomationRule({ params: { id: 2, ruleId } }, deleteResponse);
  assert.equal(deleteResponse.body.deleted, 0);
  assert.deepEqual(db.prepare('SELECT * FROM object_automation_rule_actions WHERE rule_id = ?').all(ruleId), before);
});

test('time rules require a valid nonempty schedule', () => {
  const res = response();
  controller.createAutomationRule({ params: { id: 1 }, body: {
    name: 'Missing schedule', triggerType: 'time', scheduleTime: '',
    actions: [{ actionTopic: 'test/relay', actionPayload: 'ON' }],
  } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM object_automation_rules').get().count, 0);
});

test('reading limits default to 100 and remain bounded for fractional or all requests', () => {
  db.transaction(() => { for (let index = 0; index < 5200; index += 1) reading(index); })();
  for (const [query, count] of [[{}, 100], [{ limit: '7.8' }, 7], [{ limit: 'all' }, 5000]]) {
    const res = response();
    controller.listReadings({ params: { id: 1 }, query }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.length, count);
  }
});
