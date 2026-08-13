const path = require("path");
const { getPowerMeterOverview, setSensorTopic } = require("../services/powerMeterService");

function getEnergyPage(_req, res) {
  res.sendFile(path.join(__dirname, "..", "..", "public", "pages", "energy", "energy.html"));
}

function getEnergyOverview(req, res) {
  try {
    res.json(getPowerMeterOverview(String(req.query.period || "24h")));
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

module.exports = { getEnergyPage, getEnergyOverview, updateEnergySettings };
