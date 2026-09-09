const fs = require("fs/promises");
const path = require("path");
const { randomUUID } = require("crypto");

const { getClientSnapshot, publish, topics } = require("../mqttBroker");
const { getCameraConfigs, getCameraConfigById } = require("../config/cameraConfig");
const { getEsp32BridgeSnapshot } = require("../services/esp32TranscodeService");
const { getCameraTimelapseCaptureSnapshot } = require("../services/cameraTimelapseCaptureService");
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

function normalizeCommandSettings(config, settings) {
  const fields = new Map((config.controls?.fields || []).map((field) => [field.key, field]));
  const normalized = {};

  for (const [key, rawValue] of Object.entries(settings)) {
    const field = fields.get(key);
    if (!field) throw new Error(`unsupported_setting:${key}`);

    if (field.type === "checkbox") {
      const booleanValue = typeof rawValue === "boolean"
        ? rawValue
        : parseBoolean(String(rawValue));
      if (booleanValue == null) throw new Error(`invalid_boolean:${key}`);
      normalized[key] = booleanValue;
      continue;
    }

    if (field.type === "number" || field.type === "select") {
      const numberValue = Number(rawValue);
      if (!Number.isFinite(numberValue)) throw new Error(`invalid_number:${key}`);
      if (field.min != null && numberValue < field.min) throw new Error(`value_below_minimum:${key}`);
      if (field.max != null && numberValue > field.max) throw new Error(`value_above_maximum:${key}`);
      if (field.type === "select" && !field.options?.some((option) => Number(option.value) === numberValue)) {
        throw new Error(`invalid_option:${key}`);
      }
      normalized[key] = numberValue;
      continue;
    }

    normalized[key] = String(rawValue);
  }

  return normalized;
}

function collectCameraTopics(topicBase) {
  const prefix = `${topicBase}/status/`;
  return [...topics.entries()]
    .filter(([topic]) => topic.startsWith(prefix))
    .map(([topic, data]) => ({
      topic,
      suffix: topic.slice(prefix.length),
      value: data.lastMessage,
      timestamp: data.timestamp,
    }))
    .sort((a, b) => b.timestamp - a.timestamp);
}

function getLatestTopicValue(entries, suffix) {
  const match = entries.find((entry) => entry.suffix === suffix);
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
  const configuredFpsValue = getLatestTopicValue(statusTopics, "configured_fps");
  const publisherConnectedValue = getLatestTopicValue(statusTopics, "publisher_connected");
  const mqttConnectedValue = getLatestTopicValue(statusTopics, "mqtt_connected");
  const reconnectCountValue = getLatestTopicValue(statusTopics, "reconnect_count");
  const wifiReconnectCountValue = getLatestTopicValue(statusTopics, "wifi_reconnect_count");
  const mqttReconnectCountValue = getLatestTopicValue(statusTopics, "mqtt_reconnect_count");
  const cameraRecoveryCountValue = getLatestTopicValue(statusTopics, "camera_recovery_count");
  const mqttPublishFailuresValue = getLatestTopicValue(statusTopics, "mqtt_publish_failures");
  const wifiRssiValue = getLatestTopicValue(statusTopics, "wifi_rssi");
  const uptimeValue = getLatestTopicValue(statusTopics, "uptime_seconds");
  const freeHeapValue = getLatestTopicValue(statusTopics, "free_heap_bytes");
  const commandIdValue = getLatestTopicValue(statusTopics, "command/id");
  const commandNameValue = getLatestTopicValue(statusTopics, "command/name");
  const commandResultValue = getLatestTopicValue(statusTopics, "command/result");
  const commandMessageValue = getLatestTopicValue(statusTopics, "command/message");
  const streamBytesValue = getLatestTopicValue(statusTopics, "stream_bytes_total");
  const streamUptimeValue = getLatestTopicValue(statusTopics, "stream_uptime_seconds");
  const streamDataAgeValue = getLatestTopicValue(statusTopics, "stream_last_data_age_seconds");
  const ambientLuxValue = getLatestTopicValue(statusTopics, "ambient_lux");
  const irModeValue = getLatestTopicValue(statusTopics, "ir_mode");
  const irEnabledValue = getLatestTopicValue(statusTopics, "ir_enabled");
  const lightSensorValue = getLatestTopicValue(statusTopics, "light_sensor");
  const sdValue = getLatestTopicValue(statusTopics, "sd");
  const archiveUrlValue = getLatestTopicValue(statusTopics, "archive_url");
  const timelapseStateValue = getLatestTopicValue(statusTopics, "timelapse/state");
  const timelapseErrorValue = getLatestTopicValue(statusTopics, "timelapse/error");
  const timelapseStorageBytesValue = getLatestTopicValue(statusTopics, "timelapse/storage_bytes");
  const timelapseLastImageValue = getLatestTopicValue(statusTopics, "timelapse/last_image");
  const timelapseOutputDirValue = getLatestTopicValue(statusTopics, "timelapse/output_dir");
  const timelapseEnabledValue = getLatestTopicValue(statusTopics, "timelapse/enabled");
  const timelapseIntervalValue = getLatestTopicValue(statusTopics, "timelapse/interval_seconds");
  const ipValue = getLatestTopicValue(statusTopics, "ip");
  const rtspUrlValue = getLatestTopicValue(statusTopics, "rtsp_url");
  const lastStatusValue = getLatestTopicValue(statusTopics, "last_status");

  const mqttClient = getClientSnapshot(config.mqttClientId);
  const reportedOnline = parseBoolean(onlineValue);
  const streamConfig = parseJson(configValue);
  const bridge = config.kind === "esp32" || config.kind === "dfr1154"
    ? getEsp32BridgeSnapshot(config.cameraId)
    : null;
  const serverCapture = config.archive?.type === "server_capture"
    ? getCameraTimelapseCaptureSnapshot(config.cameraId)
    : null;

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
      archiveUrl: archiveUrlValue || "",
    },
    timelapse: config.capabilities.timelapse
      ? {
          state: serverCapture?.state || timelapseStateValue || "unknown",
          error: serverCapture?.error || timelapseErrorValue || "",
          storageBytes: serverCapture?.storageBytes ?? Number(timelapseStorageBytesValue || 0),
          lastImage: serverCapture?.lastImage || timelapseLastImageValue || "",
          outputDir: serverCapture?.outputDir || timelapseOutputDirValue || "",
          enabled: serverCapture?.enabled ?? parseBoolean(timelapseEnabledValue),
          intervalSeconds:
            serverCapture?.intervalSeconds ?? Number(timelapseIntervalValue || 0),
          lastCaptureAt: serverCapture?.lastCaptureAt || null,
          globalStorageBytes: serverCapture?.globalStorageBytes ?? 0,
          globalStorageLimitBytes: serverCapture?.globalStorageLimitBytes ?? 0,
          serverFreeBytes: serverCapture?.serverFreeBytes ?? 0,
          serverReserveBytes: serverCapture?.serverReserveBytes ?? 0,
          captureInFlight: serverCapture?.captureInFlight ?? false,
          consecutiveErrors: serverCapture?.consecutiveErrors ?? 0,
        }
      : null,
    mediamtx: config.mediaMTX,
    bridge,
    status: {
      online: mqttClient
        ? Boolean(mqttClient.connected && reportedOnline !== false)
        : reportedOnline,
      state: stateValue || "unknown",
      error: errorValue || "",
      pong: pongValue || "",
      clients: clientsValue || "",
      directSessions: directSessionsValue || "",
      directStreamingClients: directStreamingClientsValue || "",
      frameFps: frameFpsValue || "",
      configuredFps: configuredFpsValue || "",
      publisherConnected: parseBoolean(publisherConnectedValue),
      mqttConnected: parseBoolean(mqttConnectedValue),
      reconnectCount: Number(reconnectCountValue || 0),
      wifiReconnectCount: Number(wifiReconnectCountValue || 0),
      mqttReconnectCount: Number(mqttReconnectCountValue || 0),
      cameraRecoveryCount: Number(cameraRecoveryCountValue || 0),
      mqttPublishFailures: Number(mqttPublishFailuresValue || 0),
      wifiRssi: wifiRssiValue === "" ? null : Number(wifiRssiValue),
      uptimeSeconds: Number(uptimeValue || 0),
      freeHeapBytes: Number(freeHeapValue || 0),
      lastCommand: {
        id: commandIdValue || "",
        name: commandNameValue || "",
        result: commandResultValue || "",
        message: commandMessageValue || "",
      },
      streamBytesTotal: Number(streamBytesValue || 0),
      streamUptimeSeconds: Number(streamUptimeValue || 0),
      streamLastDataAgeSeconds: streamDataAgeValue === "" ? null : Number(streamDataAgeValue),
      ambientLux: ambientLuxValue || "",
      irMode: irModeValue || "",
      irEnabled: parseBoolean(irEnabledValue),
      lightSensor: lightSensorValue || "",
      sd: sdValue || "",
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
    const listing = await listTimelapseFiles(overview, config);
    const requestedLimit = Number(req.query.limit);
    const requestedOffset = Number(req.query.offset);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.max(1, Math.min(500, Math.floor(requestedLimit))) : 200;
    const offset = Number.isFinite(requestedOffset) && requestedOffset >= 0
      ? Math.floor(requestedOffset) : 0;
    res.json({
      ok: true,
      cameraId,
      timelapse: overview.timelapse,
      files: listing.safeFiles.slice(offset, offset + limit),
      pagination: { offset, limit, total: listing.files.length, hasMore: offset + limit < listing.files.length },
      latestVideo: listing.latestVideo,
      latestImage: listing.latestImage,
      totals: {
        totalBytes: listing.totalBytes,
        imageCount: listing.imageFiles.length,
        videoCount: listing.videoFiles.length,
      },
      sync: listing.sync,
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
    await buildTimelapseVideo(overview, config);
    const listing = await listTimelapseFiles(overview, config, { syncRemote: false });
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
    const message = String(error?.message || error);
    res.status(message === "timelapse_build_busy" ? 409 : 500).json({ ok: false, error: message });
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
      await deleteTimelapseFile(overview, config, name);
    } else if (type === "video" || type === "image") {
      await deleteTimelapseByType(overview, config, type);
    } else {
      return res.status(400).json({ ok: false, error: "invalid_delete_target" });
    }

    const listing = await listTimelapseFiles(overview, config, { syncRemote: false });
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
    const message = String(error?.message || error);
    res.status(message === "timelapse_build_busy" ? 409 : 500).json({ ok: false, error: message });
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
    const filePath = await resolveTimelapseFilePath(overview, config, name);
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

  const mqttClient = getClientSnapshot(config.mqttClientId);
  if (!mqttClient?.connected) {
    return res.status(409).json({ ok: false, error: "camera_mqtt_offline" });
  }

  const topicFor = (suffix) => `${config.mqttTopicBase}/cmd/${suffix}`;
  const requestId = randomUUID();

  try {
    switch (action) {
      case "start":
      case "stop":
      case "restart":
        await publish(
          topicFor(action),
          JSON.stringify({ _request_id: requestId, value: payload ?? 1 }),
          { qos: 1 }
        );
        break;
      case "ping":
        await publish(
          topicFor("ping"),
          JSON.stringify({ _request_id: requestId, value: payload ?? new Date().toISOString() }),
          { qos: 1 }
        );
        break;
      case "set":
        if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
          return res.status(400).json({ ok: false, error: "invalid_settings" });
        }
        await publish(
          topicFor("set"),
          JSON.stringify({ ...normalizeCommandSettings(config, settings), _request_id: requestId }),
          { qos: 1 }
        );
        break;
      default:
        return res.status(400).json({ ok: false, error: "invalid_action" });
    }

    res.json({ ok: true, requestId, overview: buildOverview(req) });
  } catch (error) {
    const message = String(error?.message || error);
    const invalidSetting = /^(?:unsupported_setting|invalid_boolean|invalid_number|value_below_minimum|value_above_maximum|invalid_option):/.test(message);
    res.status(invalidSetting ? 400 : 500).json({ ok: false, error: message });
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
