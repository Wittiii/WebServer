const fs = require("fs/promises");
const path = require("path");

const { getClientSnapshot, publish, topics } = require("../mqttBroker");
const { getCameraConfigs, getCameraConfigById } = require("../config/cameraConfig");
const { getEsp32BridgeSnapshot } = require("../services/esp32TranscodeService");
const {
  buildTimelapseVideo,
  deleteTimelapseByType,
  deleteTimelapseFile,
  listTimelapseFiles,
  resolveTimelapseFilePath,
} = require("../services/timelapseService");

function getCameraPage(req, res) {
  const filePath = path.join(__dirname, "..", "..", "public", "pages", "camera", "camera.html");
  res.sendFile(filePath);
}

function parseBoolean(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return null;
}

function parseJson(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function collectCameraTopics(topicBase) {
  const prefix = `${topicBase}/status/`;
  return [...topics.entries()]
    .filter(([topic]) => topic.startsWith(prefix))
    .map(([topic, data]) => ({
      topic,
      value: data.lastMessage,
      timestamp: data.timestamp,
    }))
    .sort((a, b) => b.timestamp - a.timestamp);
}

function getLatestTopicValue(entries, suffix) {
  const match = entries.find((entry) => entry.topic.endsWith(`/${suffix}`));
  return match ? match.value : "";
}

function getStateValue(overview) {
  return overview.status.state || "unknown";
}

function buildCameraOverview(config) {
  const statusTopics = collectCameraTopics(config.mqttTopicBase);
  const onlineValue = getLatestTopicValue(statusTopics, "online");
  const stateValue = getLatestTopicValue(statusTopics, "state");
  const errorValue = getLatestTopicValue(statusTopics, "error");
  const configValue = getLatestTopicValue(statusTopics, "config");
  const pongValue = getLatestTopicValue(statusTopics, "pong");
  const clientsValue = getLatestTopicValue(statusTopics, "clients");
  const directSessionsValue = getLatestTopicValue(statusTopics, "direct_sessions");
  const directStreamingClientsValue = getLatestTopicValue(statusTopics, "direct_streaming_clients");
  const frameFpsValue = getLatestTopicValue(statusTopics, "frame_fps");
  const timelapseStateValue = getLatestTopicValue(statusTopics, "timelapse/state");
  const timelapseErrorValue = getLatestTopicValue(statusTopics, "timelapse/error");
  const timelapseStorageBytesValue = getLatestTopicValue(statusTopics, "timelapse/storage_bytes");
  const timelapseStorageLimitBytesValue = getLatestTopicValue(statusTopics, "timelapse/storage_limit_bytes");
  const timelapseLastImageValue = getLatestTopicValue(statusTopics, "timelapse/last_image");
  const timelapseOutputDirValue = getLatestTopicValue(statusTopics, "timelapse/output_dir");
  const timelapseEnabledValue = getLatestTopicValue(statusTopics, "timelapse/enabled");
  const timelapseIntervalValue = getLatestTopicValue(statusTopics, "timelapse/interval_seconds");
  const ipValue = getLatestTopicValue(statusTopics, "ip");
  const rtspUrlValue = getLatestTopicValue(statusTopics, "rtsp_url");
  const lastStatusValue = getLatestTopicValue(statusTopics, "last_status");

  const mqttClient = getClientSnapshot(config.mqttClientId);
  const streamConfig = parseJson(configValue);
  const bridge = config.kind === "esp32" ? getEsp32BridgeSnapshot(config.cameraId) : null;

  return {
    cameraId: config.cameraId,
    label: config.label,
    kind: config.kind,
    capabilities: config.capabilities,
    controls: config.controls,
    mqtt: {
      topicBase: config.mqttTopicBase,
      clientId: config.mqttClientId,
      connected: Boolean(mqttClient?.connected),
      lastSeen: mqttClient?.last ? new Date(mqttClient.last).toISOString() : null,
      lastTopic: mqttClient?.lastTopic || null,
    },
    stream: {
      path: config.streamPath,
      mediaHost: config.mediaHost,
      urls: config.urls,
      currentConfig: streamConfig,
      sourceRtspUrl: rtspUrlValue || "",
    },
    timelapse: config.capabilities.timelapse
      ? {
          state: timelapseStateValue || "unknown",
          error: timelapseErrorValue || "",
          storageBytes: Number(timelapseStorageBytesValue || 0),
          storageLimitBytes: Number(timelapseStorageLimitBytesValue || 0),
          lastImage: timelapseLastImageValue || "",
          outputDir: timelapseOutputDirValue || "",
          enabled: parseBoolean(timelapseEnabledValue),
          intervalSeconds: Number(timelapseIntervalValue || 0),
        }
      : null,
    mediamtx: config.mediaMTX,
    bridge,
    status: {
      online: parseBoolean(onlineValue),
      state: stateValue || "unknown",
      error: errorValue || "",
      pong: pongValue || "",
      clients: clientsValue || "",
      directSessions: directSessionsValue || "",
      directStreamingClients: directStreamingClientsValue || "",
      frameFps: frameFpsValue || "",
      ip: ipValue || "",
      rtspUrl: rtspUrlValue || config.urls.rtsp,
      lastStatus: lastStatusValue || "",
      recentTopics: statusTopics.slice(0, 20).map((entry) => ({
        topic: entry.topic,
        value: entry.value,
        timestamp: new Date(entry.timestamp).toISOString(),
      })),
    },
  };
}

function buildOverview(req) {
  const configs = getCameraConfigs(req.hostname);
  const cameras = configs.map(buildCameraOverview);

  return {
    cameras,
    primaryCameraId: cameras[0]?.cameraId || null,
    summary: {
      total: cameras.length,
      online: cameras.filter((camera) => camera.status.online === true).length,
      mqttConnected: cameras.filter((camera) => camera.mqtt.connected).length,
      streaming: cameras.filter((camera) => getStateValue(camera) === "streaming" || getStateValue(camera) === "running").length,
    },
  };
}

function getOverview(req, res) {
  res.json(buildOverview(req));
}

async function getTimelapse(req, res) {
  const cameraId = String(req.query.cameraId || "");
  const config = getCameraConfigById(cameraId, req.hostname);
  if (!config || !config.capabilities.timelapse) {
    return res.status(400).json({ ok: false, error: "invalid_timelapse_camera" });
  }

  try {
    const overview = buildCameraOverview(config);
    const listing = await listTimelapseFiles(overview);
    res.json({
      ok: true,
      cameraId,
      timelapse: overview.timelapse,
      files: listing.safeFiles,
      latestVideo: listing.latestVideo,
      latestImage: listing.latestImage,
      totals: {
        totalBytes: listing.totalBytes,
        imageCount: listing.imageFiles.length,
        videoCount: listing.videoFiles.length,
      },
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
}

async function buildTimelapse(req, res) {
  const { cameraId } = req.body || {};
  const config = getCameraConfigById(cameraId, req.hostname);
  if (!config || !config.capabilities.timelapse) {
    return res.status(400).json({ ok: false, error: "invalid_timelapse_camera" });
  }

  try {
    const overview = buildCameraOverview(config);
    await buildTimelapseVideo(overview);
    const listing = await listTimelapseFiles(overview);
    res.json({
      ok: true,
      latestVideo: listing.latestVideo,
      totals: {
        totalBytes: listing.totalBytes,
        imageCount: listing.imageFiles.length,
        videoCount: listing.videoFiles.length,
      },
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
}

async function deleteTimelapse(req, res) {
  const { cameraId, name, type } = req.body || {};
  const config = getCameraConfigById(cameraId, req.hostname);
  if (!config || !config.capabilities.timelapse) {
    return res.status(400).json({ ok: false, error: "invalid_timelapse_camera" });
  }

  try {
    const overview = buildCameraOverview(config);
    if (name) {
      await deleteTimelapseFile(overview, name);
    } else if (type === "video" || type === "image") {
      await deleteTimelapseByType(overview, type);
    } else {
      return res.status(400).json({ ok: false, error: "invalid_delete_target" });
    }

    const listing = await listTimelapseFiles(overview);
    res.json({
      ok: true,
      latestVideo: listing.latestVideo,
      totals: {
        totalBytes: listing.totalBytes,
        imageCount: listing.imageFiles.length,
        videoCount: listing.videoFiles.length,
      },
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
}

async function getTimelapseFile(req, res) {
  const cameraId = String(req.query.cameraId || "");
  const name = String(req.query.name || "");
  const config = getCameraConfigById(cameraId, req.hostname);
  if (!config || !config.capabilities.timelapse) {
    return res.status(400).json({ ok: false, error: "invalid_timelapse_camera" });
  }

  try {
    const overview = buildCameraOverview(config);
    const filePath = await resolveTimelapseFilePath(overview, name);
    await fs.access(filePath);
    res.sendFile(filePath);
  } catch (error) {
    res.status(404).json({ ok: false, error: String(error?.message || error) });
  }
}

async function sendCommand(req, res) {
  const { cameraId, action, settings, payload } = req.body || {};
  const config = getCameraConfigById(cameraId, req.hostname);

  if (!config) {
    return res.status(400).json({ ok: false, error: "invalid_camera_id" });
  }

  const topicFor = (suffix) => `${config.mqttTopicBase}/cmd/${suffix}`;

  try {
    switch (action) {
      case "start":
      case "stop":
      case "restart":
        await publish(topicFor(action), payload || "1");
        break;
      case "ping":
        await publish(topicFor("ping"), payload || new Date().toISOString());
        break;
      case "set":
        if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
          return res.status(400).json({ ok: false, error: "invalid_settings" });
        }
        await publish(topicFor("set"), JSON.stringify(settings));
        break;
      default:
        return res.status(400).json({ ok: false, error: "invalid_action" });
    }

    res.json({ ok: true, overview: buildOverview(req) });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
}

module.exports = {
  buildTimelapse,
  deleteTimelapse,
  getCameraPage,
  getOverview,
  getTimelapse,
  getTimelapseFile,
  sendCommand,
};
