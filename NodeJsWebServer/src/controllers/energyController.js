const path = require("path");
const { getPowerMeterOverview } = require("../services/powerMeterService");

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

module.exports = { getEnergyPage, getEnergyOverview };
