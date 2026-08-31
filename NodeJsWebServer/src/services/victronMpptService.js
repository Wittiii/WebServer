const db = require("../database/db");
const { getBatteryEstimation } = require("./victronBatterySettingsService");

function finite(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeSoc(value) {
  const number = finite(value);
  return number !== null && number >= 0 && number <= 100 ? number : null;
}

const DEFAULT_TOPIC_BASE = "camera/dfr1154-cam-01";
const configuredBaseTopic = String(
  process.env.CAMERA_DFR1154_TOPIC_BASE || DEFAULT_TOPIC_BASE
).replace(/^\/+|\/+$/g, "");
const sensorTopic = String(
  process.env.VICTRON_MPPT_JSON_TOPIC || `${configuredBaseTopic}/victron/mppt/json`
).trim();
const sampleIntervalMs = Math.max(0, Number(process.env.VICTRON_MPPT_SAMPLE_SECONDS || 10) * 1000);
const staleAfterMs = Math.max(10000, Number(process.env.VICTRON_MPPT_STALE_SECONDS || 30) * 1000);
const retentionDays = Math.max(1, Number(process.env.VICTRON_MPPT_RETENTION_DAYS || 365));

const insertReading = db.prepare(`
  INSERT INTO victron_mppt_readings (
    topic, status, charger_state, error_code, battery_voltage_v, battery_current_a,
    battery_soc_percent, panel_power_w, yield_today_wh, load_current_a, rssi,
    received_at_ms, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const latestReading = db.prepare(`
  SELECT * FROM victron_mppt_readings WHERE topic = ? ORDER BY received_at_ms DESC LIMIT 1
`);

let currentReading = null;
let currentStatus = null;
let lastStoredAt = latestReading.get(sensorTopic)?.received_at_ms || 0;
let lastCleanupAt = 0;

function parseVictronPayload(topic, payload, receivedAt = Date.now()) {
  if (topic !== sensorTopic) return null;

  let parsed;
  try {
    parsed = JSON.parse(String(payload));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const status = typeof parsed.status === "string" ? parsed.status.trim() : "unknown";
  const values = {
    errorCode: finite(parsed.error_code),
    batteryVoltageV: finite(parsed.battery_voltage_v),
    batteryCurrentA: finite(parsed.battery_current_a),
    panelPowerW: finite(parsed.panel_power_w),
    yieldTodayWh: finite(parsed.yield_today_wh),
    loadCurrentA: finite(parsed.load_current_a),
    rssi: finite(parsed.rssi),
  };
  const batterySocPercent = normalizeSoc(
    parsed.battery_soc_percent
      ?? parsed.battery_soc
      ?? parsed.battery_percentage
      ?? parsed.battery_state_of_charge
      ?? parsed.state_of_charge
      ?? parsed.soc_percent
      ?? parsed.soc
  );

  return {
    status,
    reading: Object.values(values).every((value) => value !== null)
      ? {
          topic,
          status,
          chargerState: typeof parsed.charger_state === "string" ? parsed.charger_state : "unknown",
          batterySocPercent,
          ...values,
          receivedAt,
        }
      : null,
    receivedAt,
  };
}

function cleanupOldReadings(now) {
  if (now - lastCleanupAt < 24 * 60 * 60 * 1000) return;
  lastCleanupAt = now;
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  db.prepare("DELETE FROM victron_mppt_readings WHERE received_at_ms < ?").run(cutoff);
}

function ingestVictronMessage(topic, payload, receivedAt = Date.now()) {
  const parsed = parseVictronPayload(topic, payload, receivedAt);
  if (!parsed) return false;

  currentStatus = { value: parsed.status, receivedAt };
  if (!parsed.reading) return true;

  currentReading = parsed.reading;
  cleanupOldReadings(receivedAt);
  if (receivedAt - lastStoredAt < sampleIntervalMs) return true;

  const reading = parsed.reading;
  insertReading.run(
    reading.topic,
    reading.status,
    reading.chargerState,
    reading.errorCode,
    reading.batteryVoltageV,
    reading.batteryCurrentA,
    reading.batterySocPercent,
    reading.panelPowerW,
    reading.yieldTodayWh,
    reading.loadCurrentA,
    reading.rssi,
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
    status: row.status,
    chargerState: row.charger_state,
    errorCode: row.error_code,
    batteryVoltageV: row.battery_voltage_v,
    batteryCurrentA: row.battery_current_a,
    batterySocPercent: row.battery_soc_percent,
    panelPowerW: row.panel_power_w,
    yieldTodayWh: row.yield_today_wh,
    loadCurrentA: row.load_current_a,
    rssi: row.rssi,
    receivedAt: row.received_at_ms,
  };
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

function getHistory(period, now) {
  const normalizedPeriod = normalizePeriod(period);
  const { durationMs, bucketMs } = PERIODS[normalizedPeriod];
  const rows = db.prepare(`
    SELECT
      CAST(received_at_ms / ? AS INTEGER) * ? AS timestamp,
      AVG(panel_power_w) AS panel_power_w,
      MAX(panel_power_w) AS peak_panel_power_w,
      AVG(battery_voltage_v) AS battery_voltage_v,
      AVG(battery_current_a) AS battery_current_a,
      AVG(battery_soc_percent) AS battery_soc_percent,
      MAX(yield_today_wh) AS yield_today_wh
    FROM victron_mppt_readings
    WHERE topic = ? AND received_at_ms >= ?
    GROUP BY CAST(received_at_ms / ? AS INTEGER)
    ORDER BY timestamp ASC
  `).all(bucketMs, bucketMs, sensorTopic, now - durationMs, bucketMs);

  return {
    period: normalizedPeriod,
    bucketMs,
    points: rows.map((row) => ({
      timestamp: row.timestamp,
      panelPowerW: row.panel_power_w,
      peakPanelPowerW: row.peak_panel_power_w,
      batteryVoltageV: row.battery_voltage_v,
      batteryCurrentA: row.battery_current_a,
      batterySocPercent: row.battery_soc_percent,
      yieldTodayWh: row.yield_today_wh,
    })),
  };
}

function getVictronOverview(period = "24h", now = Date.now()) {
  const reading = currentReading || rowToReading(latestReading.get(sensorTopic));
  const status = currentStatus?.value || reading?.status || "waiting";
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const stats = db.prepare(`
    SELECT AVG(panel_power_w) AS average_panel_power_w,
           MAX(panel_power_w) AS peak_panel_power_w,
           MIN(battery_voltage_v) AS minimum_battery_voltage_v,
           MAX(battery_voltage_v) AS maximum_battery_voltage_v,
           MAX(yield_today_wh) AS yield_today_wh,
           COUNT(*) AS samples
    FROM victron_mppt_readings
    WHERE topic = ? AND received_at_ms >= ?
  `).get(sensorTopic, todayStart.getTime());
  const totalYield = db.prepare(`
    SELECT SUM(daily_yield_wh) AS total_yield_wh,
           MIN(first_reading_ms) AS total_start_time
    FROM (
      SELECT MAX(yield_today_wh) AS daily_yield_wh,
             MIN(received_at_ms) AS first_reading_ms
      FROM victron_mppt_readings
      WHERE topic = ? AND received_at_ms <= ?
      GROUP BY date(received_at_ms / 1000, 'unixepoch', 'localtime')
    )
  `).get(sensorTopic, now);

  let socPercent = normalizeSoc(reading?.batterySocPercent);
  let socSource = socPercent === null ? "unavailable" : "mqtt";
  const estimation = getBatteryEstimation(reading?.batteryVoltageV);
  if (socPercent === null && estimation.socPercent !== null) {
    socPercent = estimation.socPercent;
    socSource = "voltage_estimate";
  }

  const batteryPowerW = reading
    ? reading.batteryVoltageV * reading.batteryCurrentA
    : null;
  const batteryCurrentA = Number(reading?.batteryCurrentA || 0);
  const batteryFlow = batteryCurrentA > 0.05
    ? "charging"
    : batteryCurrentA < -0.05 ? "discharging" : "idle";

  return {
    configuredTopic: sensorTopic,
    status,
    online: Boolean(reading && status === "ready" && now - reading.receivedAt <= staleAfterMs),
    staleAfterSeconds: staleAfterMs / 1000,
    reading,
    battery: {
      socPercent,
      socSource,
      socEstimateConfigured: estimation.enabled,
      estimation,
      powerW: batteryPowerW,
      flow: batteryFlow,
    },
    todayStats: {
      averagePanelPowerW: stats.average_panel_power_w || 0,
      peakPanelPowerW: stats.peak_panel_power_w || 0,
      minimumBatteryVoltageV: stats.minimum_battery_voltage_v || 0,
      maximumBatteryVoltageV: stats.maximum_battery_voltage_v || 0,
      yieldTodayWh: stats.yield_today_wh || reading?.yieldTodayWh || 0,
      samples: stats.samples || 0,
    },
    totalStats: {
      yieldWh: totalYield.total_yield_wh || reading?.yieldTodayWh || 0,
      startTime: totalYield.total_start_time || reading?.receivedAt || null,
    },
    history: getHistory(period, now),
  };
}

module.exports = {
  getVictronOverview,
  ingestVictronMessage,
  parseVictronPayload,
};
