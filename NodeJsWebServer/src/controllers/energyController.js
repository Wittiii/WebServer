const path = require("path");
const { getPowerMeterOverview, setSensorTopic } = require("../services/powerMeterService");
const { getVictronOverview } = require("../services/victronMpptService");
const {
  getBatteryEstimation,
  saveBatterySettings,
} = require("../services/victronBatterySettingsService");
const { topics } = require("../mqttBroker");
const {
  getEnergyLayout,
  saveEnergyLayout,
} = require("../services/energyLayoutService");

const VICTRON_SOC_TOPIC_KEYS = new Set([
  "battery_soc_percent",
  "battery_soc",
  "battery_percentage",
  "battery_state_of_charge",
  "state_of_charge",
  "soc_percent",
  "soc",
]);

function getEnergyPage(_req, res) {
  res.sendFile(path.join(__dirname, "..", "..", "public", "pages", "energy", "energy.html"));
}

function getVictronMqttTopics(configuredTopic, now = Date.now()) {
  const mpptRoot = configuredTopic.endsWith("/json")
    ? configuredTopic.slice(0, -"/json".length)
    : configuredTopic;
  const cameraRoot = mpptRoot.endsWith("/victron/mppt")
    ? mpptRoot.slice(0, -"/victron/mppt".length)
    : "";
  const statusTopic = cameraRoot ? `${cameraRoot}/status/victron_ble` : "";

  return [...topics.entries()]
    .filter(([topic]) => topic === statusTopic || topic.startsWith(`${mpptRoot}/`))
    .map(([topic, value]) => ({
      topic,
      key: topic === statusTopic ? "ble_status" : topic.slice(mpptRoot.length + 1),
      value: String(value?.lastMessage ?? "").slice(0, 1000),
      receivedAt: Number(value?.timestamp || 0) || null,
      ageSeconds: value?.timestamp
        ? Math.max(0, Math.round((now - value.timestamp) / 1000))
        : null,
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function getEnergyOverview(req, res) {
  try {
    const period = String(req.query.period || "24h");
    const victron = getVictronOverview(String(req.query.victronPeriod || period));
    victron.mqttTopics = getVictronMqttTopics(victron.configuredTopic);

    if (victron.battery.socSource !== "mqtt") {
      const reportedSoc = victron.mqttTopics.find((entry) =>
        VICTRON_SOC_TOPIC_KEYS.has(entry.key.toLowerCase())
      );
      const rawValue = reportedSoc?.value?.trim();
      const reportedValue = rawValue ? Number(rawValue) : Number.NaN;
      if (Number.isFinite(reportedValue) && reportedValue >= 0 && reportedValue <= 100) {
        victron.battery.socPercent = reportedValue;
        victron.battery.socSource = "mqtt_topic";
      }
    }

    res.json({
      ...getPowerMeterOverview(period),
      victron,
    });
  } catch (error) {
    console.error("[Energy] overview failed", error);
    res.status(500).json({ ok: false, error: "energy_overview_failed" });
  }
}

function updateEnergySettings(req, res) {
  try {
    const configuredTopic = setSensorTopic(req.body?.sensorTopic);
    res.json({ ok: true, configuredTopic });
  } catch (error) {
    if (error?.code === "invalid_sensor_topic") {
      return res.status(400).json({ ok: false, error: "invalid_sensor_topic" });
    }
    console.error("[Energy] settings update failed", error);
    return res.status(500).json({ ok: false, error: "energy_settings_update_failed" });
  }
}

function updateVictronBatterySettings(req, res) {
  try {
    const settings = saveBatterySettings(req.body);
    return res.json({ ok: true, settings: getBatteryEstimation(null, settings) });
  } catch (error) {
    if (error?.code === "invalid_victron_battery_settings") {
      return res.status(400).json({
        ok: false,
        error: "invalid_victron_battery_settings",
        message: error.message,
      });
    }
    console.error("[Energy] Victron battery settings update failed", error);
    return res.status(500).json({ ok: false, error: "victron_battery_settings_update_failed" });
  }
}

function getUserEnergyLayout(req, res) {
  const username = req.session?.user?.username;
  if (!username) return res.status(401).json({ ok: false, error: "not_logged_in" });

  try {
    return res.json({ ok: true, layout: getEnergyLayout(username) });
  } catch (error) {
    console.error("[Energy] layout load failed", error);
    return res.status(500).json({ ok: false, error: "energy_layout_load_failed" });
  }
}

function updateUserEnergyLayout(req, res) {
  const username = req.session?.user?.username;
  if (!username) return res.status(401).json({ ok: false, error: "not_logged_in" });

  try {
    const layout = saveEnergyLayout(username, req.body?.layout);
    return res.json({ ok: true, layout });
  } catch (error) {
    console.error("[Energy] layout save failed", error);
    return res.status(500).json({ ok: false, error: "energy_layout_save_failed" });
  }
}

module.exports = {
  getEnergyPage,
  getEnergyOverview,
  getUserEnergyLayout,
  updateEnergySettings,
  updateUserEnergyLayout,
  updateVictronBatterySettings,
};
