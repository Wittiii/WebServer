const path = require('path');
const os = require('os');
const db = require('../database/db');
const { getPowerMeterOverview } = require('../services/powerMeterService');
const { getVictronOverview } = require('../services/victronMpptService');
const { getCameraConfigs } = require('../config/cameraConfig');
const { clients, topics, getClientSnapshot, isClientConnected } = require('../mqttBroker');

function getHome(req, res) {
  const filePath = path.join(__dirname, '..', '..', 'public', 'pages', 'home.html');
  res.sendFile(filePath);
}

function getHomeOverview(req, res) {
  try {
    const loggedIn = Boolean(req.session?.user);
    if (!loggedIn) {
      return res.json({ ok: true, loggedIn: false });
    }

    const now = Date.now();

    // 1. Stromnetz (Tasmota)
    let power = null;
    try {
      const pm = getPowerMeterOverview('24h', now);
      const reading = pm.reading;
      power = {
        online: pm.online,
        powerW: reading ? Math.round(reading.powerW) : null,
        todayKwh: reading ? Number(reading.todayKwh.toFixed(3)) : null,
        totalKwh: reading ? Number(reading.totalKwh.toFixed(1)) : null,
        costTodayEur: pm.estimatedCostTodayEur || 0,
      };
    } catch {}

    // 2. Solar & Akku (Victron)
    let solar = null;
    try {
      const vm = getVictronOverview('24h', now);
      const reading = vm.reading;
      const battery = vm.battery;
      solar = {
        online: vm.online,
        solarW: reading ? Math.round(reading.panelPowerW) : null,
        yieldTodayWh: vm.todayStats?.yieldTodayWh || 0,
        batterySocPercent: battery?.socPercent != null ? Math.round(battery.socPercent) : null,
        batteryVoltageV: reading ? Number(reading.batteryVoltageV.toFixed(2)) : null,
        batteryFlow: battery?.flow || 'idle',
        batteryPowerW: battery?.powerW ? Math.round(Math.abs(battery.powerW)) : null,
      };
    } catch {}

    // 3. Hydroponik
    let hydro = null;
    try {
      const totalObjects = db.prepare('SELECT COUNT(*) AS total FROM objects').get()?.total || 0;
      const primaryObj = db.prepare(`
        SELECT o.id, o.name,
               (SELECT COUNT(*) FROM object_automation_rules WHERE object_id = o.id AND enabled = 1) AS active_rules
        FROM objects o ORDER BY o.id ASC LIMIT 1
      `).get();
      let latest = null;
      if (primaryObj) {
        const row = db.prepare(`
          SELECT r.value_key, r.value_text AS value, r.created_at, k.label, k.unit
          FROM object_readings r
          LEFT JOIN object_value_keys k ON k.object_id = r.object_id AND k.value_key = r.value_key
          WHERE r.object_id = ?
          ORDER BY r.created_at DESC, r.id DESC LIMIT 1
        `).get(primaryObj.id);
        if (row) {
          latest = {
            key: row.value_key,
            label: row.label || row.value_key,
            value: row.value,
            unit: row.unit || '',
            createdAt: row.created_at,
          };
        }
      }
      const totalRules = db.prepare('SELECT COUNT(*) AS total FROM object_automation_rules WHERE enabled = 1').get()?.total || 0;
      hydro = {
        totalObjects,
        activeObjectName: primaryObj?.name || (totalObjects === 0 ? 'Kein Objekt' : null),
        activeRules: totalRules,
        latestReading: latest,
      };
    } catch {}

    // 4. Kameras & System
    let system = null;
    try {
      const configs = getCameraConfigs();
      let onlineCameras = 0;
      for (const config of configs) {
        const mqttClient = getClientSnapshot(config.mqttClientId);
        const topicBase = String(config.mqttTopicBase || `camera/${config.cameraId}`).replace(/\/+$/, '');
        const statusTopic = `${topicBase}/status/online`;
        const rawOnline = String(topics.get(statusTopic)?.lastMessage ?? '').trim().toLowerCase();
        const reportedOnline = rawOnline === 'true' ? true : rawOnline === 'false' ? false : null;
        const isOnline = mqttClient
          ? Boolean(mqttClient.connected && reportedOnline !== false)
          : reportedOnline === true;
        if (isOnline) onlineCameras += 1;
      }

      const connectedMqttClients = [...clients.values()].filter((c) => isClientConnected(c, now)).length;
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const ramPercent = totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 100) : null;

      system = {
        camerasTotal: configs.length,
        camerasOnline: onlineCameras,
        mqttClients: connectedMqttClients,
        ramPercent,
        uptimeSeconds: Math.floor(os.uptime()),
      };
    } catch {}

    res.json({
      ok: true,
      loggedIn: true,
      power,
      solar,
      hydro,
      system,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

module.exports = { getHome, getHomeOverview };
