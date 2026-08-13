const db = require("../database/db");

const DEFAULT_TOPIC = "tele/tasmota_605AF0/SENSOR";
const environmentTopic = String(process.env.POWER_METER_SENSOR_TOPIC || DEFAULT_TOPIC).trim();
const sampleIntervalMs = Math.max(0, Number(process.env.POWER_METER_SAMPLE_SECONDS || 10) * 1000);
const staleAfterMs = Math.max(10000, Number(process.env.POWER_METER_STALE_SECONDS || 90) * 1000);
const retentionDays = Math.max(1, Number(process.env.POWER_METER_RETENTION_DAYS || 365));
const electricityPrice = Math.max(0, Number(process.env.POWER_METER_PRICE_EUR_KWH || 0.35));

const insertReading = db.prepare(`
  INSERT INTO power_meter_readings (
    topic, source_time, total_start_time, total_kwh, yesterday_kwh, today_kwh,
    power_w, apparent_power_va, reactive_power_var, power_factor, voltage_v,
    current_a, received_at_ms, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const latestReading = db.prepare(`
  SELECT * FROM power_meter_readings WHERE topic = ? ORDER BY received_at_ms DESC LIMIT 1
`);

const storedSettings = db.prepare(`
  SELECT sensor_topic FROM power_meter_settings WHERE id = 1
`);

const saveSettings = db.prepare(`
  INSERT INTO power_meter_settings (id, sensor_topic, updated_at)
  VALUES (1, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    sensor_topic = excluded.sensor_topic,
    updated_at = excluded.updated_at
`);

let sensorTopic = storedSettings.get()?.sensor_topic || environmentTopic;
let currentReading = null;
let lastStoredAt = latestReading.get(sensorTopic)?.received_at_ms || 0;
let lastCleanupAt = 0;

function normalizeSensorTopic(value) {
  const topic = String(value ?? "").trim();
  if (!topic || topic.length > 512 || topic.includes("\0") || topic.includes("#") || topic.includes("+")) {
    const error = new Error("invalid_sensor_topic");
    error.code = "invalid_sensor_topic";
    throw error;
  }
  return topic;
}

function setSensorTopic(value) {
  const topic = normalizeSensorTopic(value);
  saveSettings.run(topic, new Date().toISOString());
  if (topic === sensorTopic) return sensorTopic;

  sensorTopic = topic;
  currentReading = null;
  lastStoredAt = latestReading.get(sensorTopic)?.received_at_ms || 0;
  return sensorTopic;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseSensorPayload(topic, payload, receivedAt = Date.now()) {
  if (topic !== sensorTopic) return null;

  let parsed;
  try {
    parsed = JSON.parse(String(payload));
  } catch {
    return null;
  }

  const energy = parsed?.ENERGY;
  if (!energy || typeof energy !== "object") return null;

  const values = {
    totalKwh: finite(energy.Total),
    yesterdayKwh: finite(energy.Yesterday),
    todayKwh: finite(energy.Today),
    powerW: finite(energy.Power),
    apparentPowerVa: finite(energy.ApparentPower),
    reactivePowerVar: finite(energy.ReactivePower),
    powerFactor: finite(energy.Factor),
    voltageV: finite(energy.Voltage),
    currentA: finite(energy.Current),
  };
  if (Object.values(values).some((value) => value == null)) return null;

  return {
    topic,
    sourceTime: typeof parsed.Time === "string" ? parsed.Time : null,
    totalStartTime: typeof energy.TotalStartTime === "string" ? energy.TotalStartTime : null,
    ...values,
    receivedAt,
  };
}

function cleanupOldReadings(now) {
  if (now - lastCleanupAt < 24 * 60 * 60 * 1000) return;
  lastCleanupAt = now;
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  db.prepare("DELETE FROM power_meter_readings WHERE received_at_ms < ?").run(cutoff);
}

function ingestPowerMeterMessage(topic, payload, receivedAt = Date.now()) {
  const reading = parseSensorPayload(topic, payload, receivedAt);
  if (!reading) return false;

  currentReading = reading;
  cleanupOldReadings(receivedAt);
  if (receivedAt - lastStoredAt < sampleIntervalMs) return true;

  insertReading.run(
    reading.topic,
    reading.sourceTime,
    reading.totalStartTime,
    reading.totalKwh,
    reading.yesterdayKwh,
    reading.todayKwh,
    reading.powerW,
    reading.apparentPowerVa,
    reading.reactivePowerVar,
    reading.powerFactor,
    reading.voltageV,
    reading.currentA,
    reading.receivedAt,
    new Date(reading.receivedAt).toISOString()
  );
  lastStoredAt = receivedAt;
  return true;
}

function rowToReading(row) {
  if (!row) return null;
  return {
    topic: row.topic,
    sourceTime: row.source_time,
    totalStartTime: row.total_start_time,
    totalKwh: row.total_kwh,
    yesterdayKwh: row.yesterday_kwh,
    todayKwh: row.today_kwh,
    powerW: row.power_w,
    apparentPowerVa: row.apparent_power_va,
    reactivePowerVar: row.reactive_power_var,
    powerFactor: row.power_factor,
    voltageV: row.voltage_v,
    currentA: row.current_a,
    receivedAt: row.received_at_ms,
  };
}

function getCurrentReading() {
  return currentReading || rowToReading(latestReading.get(sensorTopic));
}

const PERIODS = {
  "1h": { durationMs: 60 * 60 * 1000, bucketMs: 60 * 1000 },
  "24h": { durationMs: 24 * 60 * 60 * 1000, bucketMs: 10 * 60 * 1000 },
  "7d": { durationMs: 7 * 24 * 60 * 60 * 1000, bucketMs: 60 * 60 * 1000 },
  "30d": { durationMs: 30 * 24 * 60 * 60 * 1000, bucketMs: 6 * 60 * 60 * 1000 },
};

function normalizePeriod(period) {
  return Object.prototype.hasOwnProperty.call(PERIODS, period) ? period : "24h";
}

function getHistory(period = "24h", now = Date.now()) {
  const normalizedPeriod = normalizePeriod(period);
  const { durationMs, bucketMs } = PERIODS[normalizedPeriod];
  const rows = db.prepare(`
    SELECT
      CAST(received_at_ms / ? AS INTEGER) * ? AS timestamp,
      AVG(power_w) AS power_w,
      MAX(power_w) AS peak_power_w,
      AVG(voltage_v) AS voltage_v,
      AVG(current_a) AS current_a,
      AVG(power_factor) AS power_factor,
      MAX(today_kwh) AS today_kwh
    FROM power_meter_readings
    WHERE topic = ? AND received_at_ms >= ?
    GROUP BY CAST(received_at_ms / ? AS INTEGER)
    ORDER BY timestamp ASC
  `).all(bucketMs, bucketMs, sensorTopic, now - durationMs, bucketMs);

  return {
    period: normalizedPeriod,
    bucketMs,
    points: rows.map((row) => ({
      timestamp: row.timestamp,
      powerW: row.power_w,
      peakPowerW: row.peak_power_w,
      voltageV: row.voltage_v,
      currentA: row.current_a,
      powerFactor: row.power_factor,
      todayKwh: row.today_kwh,
    })),
  };
}

function getPowerMeterOverview(period = "24h", now = Date.now()) {
  const reading = getCurrentReading();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const stats = db.prepare(`
    SELECT AVG(power_w) AS average_power_w, MAX(power_w) AS peak_power_w,
           MIN(voltage_v) AS minimum_voltage_v, MAX(voltage_v) AS maximum_voltage_v,
           COUNT(*) AS samples
    FROM power_meter_readings
    WHERE topic = ? AND received_at_ms >= ?
  `).get(sensorTopic, todayStart.getTime());

  return {
    ok: true,
    configuredTopic: sensorTopic,
    online: Boolean(reading && now - reading.receivedAt <= staleAfterMs),
    staleAfterSeconds: staleAfterMs / 1000,
    priceEurKwh: electricityPrice,
    estimatedCostTodayEur: reading ? reading.todayKwh * electricityPrice : 0,
    estimatedCostYesterdayEur: reading ? reading.yesterdayKwh * electricityPrice : 0,
    reading,
    todayStats: {
      averagePowerW: stats.average_power_w || 0,
      peakPowerW: stats.peak_power_w || 0,
      minimumVoltageV: stats.minimum_voltage_v || 0,
      maximumVoltageV: stats.maximum_voltage_v || 0,
      samples: stats.samples || 0,
    },
    history: getHistory(period, now),
  };
}

module.exports = {
  getPowerMeterOverview,
  ingestPowerMeterMessage,
  normalizeSensorTopic,
  parseSensorPayload,
  setSensorTopic,
};
