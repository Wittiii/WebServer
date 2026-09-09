const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'webserver-sensor-ingestion-'));
process.env.DATABASE_PATH = path.join(directory, 'test.db');
process.env.SQLITE_JOURNAL_MODE = 'DELETE';
process.env.POWER_METER_SENSOR_TOPIC = 'test/power';
process.env.VICTRON_MPPT_JSON_TOPIC = 'test/victron';
process.env.POWER_METER_SAMPLE_SECONDS = 'invalid';
process.env.VICTRON_MPPT_SAMPLE_SECONDS = 'invalid';
process.env.POWER_METER_STALE_SECONDS = 'invalid';
process.env.VICTRON_MPPT_STALE_SECONDS = 'invalid';
process.env.POWER_METER_PRICE_EUR_KWH = 'invalid';
process.env.VICTRON_MPPT_RETENTION_DAYS = '1';

const db = require('../src/database/db');
const power = require('../src/services/powerMeterService');
const victron = require('../src/services/victronMpptService');
const powerTopic = process.env.POWER_METER_SENSOR_TOPIC;
const victronTopic = process.env.VICTRON_MPPT_JSON_TOPIC;

function powerPayload(overrides = {}) {
  return JSON.stringify({ ENERGY: {
    Total: 100, Yesterday: 2, Today: 1, Power: 40, ApparentPower: 42,
    ReactivePower: 2, Factor: 0.98, Voltage: 230, Current: 0.18,
    ...overrides,
  } });
}

function victronPayload(overrides = {}) {
  return JSON.stringify({
    status: 'ready', charger_state: 'bulk', error_code: 0,
    battery_voltage_v: 13.5, battery_current_a: 4, panel_power_w: 58,
    yield_today_wh: 100, load_current_a: 0.8, rssi: -60,
    ...overrides,
  });
}

test.beforeEach(() => {
  db.exec('DELETE FROM power_meter_readings; DELETE FROM victron_mppt_readings; DELETE FROM victron_daily_yields;');
});

test.after(() => {
  db.close();
  fs.rmSync(process.env.DATABASE_PATH, { force: true });
  fs.rmdirSync(directory);
});

test('malformed numeric telemetry is not silently stored as zero', () => {
  for (const invalid of [null, '', ' ', true, false, [], [12], {}]) {
    assert.equal(power.parseSensorPayload(powerTopic, powerPayload({ Power: invalid })), null);
    assert.equal(victron.parseVictronPayload(victronTopic, victronPayload({ panel_power_w: invalid })).reading, null);
  }
  assert.equal(power.parseSensorPayload(powerTopic, powerPayload({ Power: '42.5' })).powerW, 42.5);
  assert.equal(victron.parseVictronPayload(victronTopic, victronPayload({ panel_power_w: '42.5' })).reading.panelPowerW, 42.5);
});

test('invalid timestamps are rejected before they can poison persistence or live state', () => {
  for (const timestamp of [NaN, Infinity, -1, 8640000000000001, '123']) {
    assert.equal(power.ingestPowerMeterMessage(powerTopic, powerPayload(), timestamp), false);
    assert.equal(victron.ingestVictronMessage(victronTopic, victronPayload(), timestamp), false);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM power_meter_readings').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM victron_mppt_readings').get().count, 0);
});

test('invalid interval configuration keeps sampling bounded and clock corrections resume writes', () => {
  const timestamp = Date.UTC(2026, 8, 6, 12);
  for (const offset of [0, 1000, 11000, -3600000]) {
    power.ingestPowerMeterMessage(powerTopic, powerPayload(), timestamp + offset);
    victron.ingestVictronMessage(victronTopic, victronPayload(), timestamp + offset);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM power_meter_readings').get().count, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM victron_mppt_readings').get().count, 3);
  assert.equal(power.getPowerMeterOverview('1h', timestamp).priceEurKwh, 0.35);
  assert.equal(power.getPowerMeterOverview('1h', timestamp).staleAfterSeconds, 90);
  assert.equal(victron.getVictronOverview('1h', timestamp).staleAfterSeconds, 30);
});

test('raw-data retention does not reduce the lifetime solar yield', () => {
  const firstDay = Date.UTC(2030, 0, 1, 12);
  const thirdDay = firstDay + 2 * 86400000;
  victron.ingestVictronMessage(victronTopic, victronPayload({ yield_today_wh: 100 }), firstDay);
  victron.ingestVictronMessage(victronTopic, victronPayload({ yield_today_wh: 200 }), thirdDay);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM victron_mppt_readings').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM victron_daily_yields').get().count, 2);
  assert.equal(victron.getVictronOverview('24h', thirdDay).totalStats.yieldWh, 300);
  assert.equal(victron.getVictronOverview('24h', thirdDay).totalStats.startTime, firstDay);
});
