const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const databasePath = path.join(
  os.tmpdir(),
  `webserver-victron-${process.pid}-${Date.now()}.db`
);
process.env.DATABASE_PATH = databasePath;
process.env.VICTRON_MPPT_JSON_TOPIC = "camera/test/victron/mppt/json";
process.env.VICTRON_MPPT_SAMPLE_SECONDS = "0";

const db = require("../src/database/db");
const {
  getVictronOverview,
  ingestVictronMessage,
  parseVictronPayload,
} = require("../src/services/victronMpptService");
const {
  getEnergyLayout,
  sanitizeEnergyLayout,
  saveEnergyLayout,
} = require("../src/services/energyLayoutService");
const {
  getBatteryEstimation,
  getBatterySettings,
  saveBatterySettings,
} = require("../src/services/victronBatterySettingsService");

const topic = process.env.VICTRON_MPPT_JSON_TOPIC;

function payload(overrides = {}) {
  return JSON.stringify({
    status: "ready",
    charger_state: "bulk",
    error_code: 0,
    battery_voltage_v: 13.42,
    battery_current_a: 4.2,
    panel_power_w: 58,
    yield_today_wh: 340,
    load_current_a: 0.8,
    rssi: -61,
    ...overrides,
  });
}

test.after(() => {
  db.close();
  fs.rmSync(databasePath, { force: true });
});

test("parses only the configured Victron JSON topic", () => {
  assert.equal(parseVictronPayload("camera/other/victron/mppt/json", payload()), null);
  assert.equal(parseVictronPayload(topic, "not-json"), null);
  assert.equal(parseVictronPayload(topic, payload(), 1233).reading.batterySocPercent, null);
  assert.equal(
    parseVictronPayload(topic, payload({ state_of_charge: 68 }), 1233).reading.batterySocPercent,
    68
  );

  const parsed = parseVictronPayload(topic, payload({ battery_soc_percent: 73 }), 1234);
  assert.equal(parsed.status, "ready");
  assert.equal(parsed.reading.panelPowerW, 58);
  assert.equal(parsed.reading.batteryVoltageV, 13.42);
  assert.equal(parsed.reading.batterySocPercent, 73);
  assert.equal(parsed.reading.receivedAt, 1234);
});

test("stores MPPT readings and returns live values plus history", () => {
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  const timestamp = now.getTime();

  assert.equal(ingestVictronMessage(topic, payload({ panel_power_w: 42 }), timestamp - 120000), true);
  assert.equal(
    ingestVictronMessage(
      topic,
      payload({ panel_power_w: 84, yield_today_wh: 410, battery_soc_percent: 74 }),
      timestamp
    ),
    true
  );

  const overview = getVictronOverview("24h", timestamp + 1000);
  assert.equal(overview.online, true);
  assert.equal(overview.reading.panelPowerW, 84);
  assert.equal(overview.reading.batterySocPercent, 74);
  assert.equal(overview.battery.socPercent, 74);
  assert.equal(overview.battery.socSource, "mqtt");
  assert.equal(overview.battery.flow, "charging");
  assert.equal(overview.battery.powerW, 13.42 * 4.2);
  assert.equal(overview.todayStats.peakPanelPowerW, 84);
  assert.equal(overview.todayStats.yieldTodayWh, 410);
  assert.equal(overview.history.points.length, 2);
  assert.equal(overview.history.points.at(-1).batterySocPercent, 74);
});

test("estimates LiFePO4 SOC and stores custom battery settings", () => {
  const defaults = getBatterySettings();
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.profile, "lifepo4");
  assert.equal(defaults.systemVoltage, "auto");

  const twelveVolt = getBatteryEstimation(12.35, defaults);
  assert.equal(twelveVolt.detectedSystemVoltage, 12);
  assert.equal(twelveVolt.emptyVoltageV, 11.2);
  assert.equal(twelveVolt.fullVoltageV, 13.5);
  assert.equal(Math.round(twelveVolt.socPercent), 50);

  const twentyFourVolt = getBatteryEstimation(24.7, defaults);
  assert.equal(twentyFourVolt.detectedSystemVoltage, 24);
  assert.equal(twentyFourVolt.emptyVoltageV, 22.4);
  assert.equal(twentyFourVolt.fullVoltageV, 27);
  assert.equal(Math.round(twentyFourVolt.socPercent), 50);

  const thirtySixVolt = getBatteryEstimation(37.05, defaults);
  assert.equal(thirtySixVolt.detectedSystemVoltage, 36);
  assert.equal(thirtySixVolt.emptyVoltageV, 33.6);
  assert.equal(thirtySixVolt.fullVoltageV, 40.5);
  assert.equal(Math.round(thirtySixVolt.socPercent), 50);

  saveBatterySettings({
    enabled: true,
    profile: "custom",
    systemVoltage: "12",
    useCustomRange: true,
    emptyVoltageV: 12,
    fullVoltageV: 14,
  });
  assert.equal(getBatterySettings().profile, "custom");
  assert.equal(Math.round(getBatteryEstimation(13).socPercent), 50);
  assert.throws(
    () => saveBatterySettings({
      enabled: true,
      profile: "custom",
      systemVoltage: "12",
      useCustomRange: true,
      emptyVoltageV: 14,
      fullVoltageV: 12,
    }),
    { code: "invalid_victron_battery_settings" }
  );

  saveBatterySettings({
    enabled: true,
    profile: "lifepo4",
    systemVoltage: "auto",
    useCustomRange: false,
  });
});

test("sanitizes Power layouts and restores omitted sections", () => {
  const layout = sanitizeEnergyLayout([
    { id: "victron", width: "half", visible: false },
    { id: "victron", width: "full", visible: true },
    { id: "unknown", width: "half", visible: true },
  ]);

  assert.equal(layout.length, 5);
  assert.deepEqual(layout[0], {
    id: "victron",
    width: "half",
    visible: false,
    collapsed: false,
  });
  assert.equal(layout.some((entry) => entry.id === "live-values"), true);
});

test("stores Power layouts separately for each user", () => {
  saveEnergyLayout("admin", [
    { id: "victron", width: "half", visible: true, collapsed: true },
    { id: "live-values", width: "full", visible: true },
  ]);
  saveEnergyLayout("guest", [
    { id: "energy-balance", width: "full", visible: false },
  ]);

  assert.equal(getEnergyLayout("admin")[0].id, "victron");
  assert.equal(getEnergyLayout("admin")[0].width, "half");
  assert.equal(getEnergyLayout("admin")[0].collapsed, true);
  assert.equal(getEnergyLayout("guest")[0].id, "energy-balance");
  assert.equal(getEnergyLayout("guest")[0].visible, false);
});
