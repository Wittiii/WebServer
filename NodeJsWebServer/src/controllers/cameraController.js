const fs = require("fs/promises");
const path = require("path");
const { randomUUID } = require("crypto");

const { getClientSnapshot, publish, topics } = require("../mqttBroker");
const { getCameraConfigs, getCameraConfigById, getCameraImageProfiles } = require("../config/cameraConfig");
const { getEsp32BridgeSnapshot } = require("../services/esp32TranscodeService");
const {
  captureCameraLiveSnapshot,
  getCameraTimelapseCaptureSnapshot,
} = require("../services/cameraTimelapseCaptureService");
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
      if ((config.kind === "pi" || config.kind === "esp32-p4") &&
          !((typeof rawValue === "number") || (typeof rawValue === "string" && rawValue.trim()))) {
        throw new Error(`invalid_number:${key}`);
      }
      const numberValue = Number(rawValue);
      if (!Number.isFinite(numberValue)) throw new Error(`invalid_number:${key}`);
      if (field.integer && !Number.isInteger(numberValue)) throw new Error(`invalid_number:${key}`);
      if (field.multipleOf && numberValue % field.multipleOf !== 0) throw new Error(`invalid_number:${key}`);
      if (config.kind === "esp32-p4" && field.step &&
          (numberValue - field.min) % field.step !== 0) throw new Error(`invalid_number:${key}`);
      if (config.kind === "pi" && key === "server_capture_interval_seconds" && !Number.isInteger(numberValue)) {
        throw new Error(`invalid_number:${key}`);
      }
      if (field.min != null && numberValue < field.min) throw new Error(`value_below_minimum:${key}`);
      if (field.max != null && numberValue > field.max) throw new Error(`value_above_maximum:${key}`);
      if (field.type === "select" && !field.options?.some((option) => Number(option.value) === numberValue)) {
        throw new Error(`invalid_option:${key}`);
      }
      normalized[key] = numberValue;
      continue;
    }

    if (field.type === "text") {
      if (typeof rawValue !== "string" || !rawValue.trim() || rawValue.length > (field.maxLength || 1024)) {
        throw new Error(`invalid_text:${key}`);
      }
      // The local RTSP path must remain a path, never a URL or traversal.
      if (key === "rtsp_path" && (!/^[A-Za-z0-9._/-]+$/.test(rawValue) || rawValue.includes(".."))) {
        throw new Error(`invalid_text:${key}`);
      }
      normalized[key] = rawValue.trim().replace(/^\/+/, "");
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

function resolveCameraControls(config, reportedConfig) {
  if (config.kind !== "esp32-p4") return config.controls;
  const reported = { ...reportedConfig?.image_controls, ...reportedConfig?.setting_controls };
  const emittedGroups = new Set();
  const fields = (config.controls.imageFields || []).flatMap((field) => {
    const control = reported?.[field.key];
    if (!control || !Number.isSafeInteger(control.min) || !Number.isSafeInteger(control.max) ||
        !Number.isSafeInteger(control.step) || control.step < 1 || control.min > control.max ||
        Math.abs(control.min) > 100000000 || Math.abs(control.max) > 100000000) return [];
    if (field.type === "checkbox" && (control.min !== 0 || control.max !== 1 || control.step !== 1)) return [];

    let options = field.options;
    if (field.type === "select") {
      options = (field.options || []).filter((option) =>
        Number.isSafeInteger(option.value) &&
        option.value >= control.min &&
        option.value <= control.max &&
        (option.value - control.min) % control.step === 0
      );
      if (!options.length) return [];
    }

    let section = field.section;
    if (!section && field.group && !emittedGroups.has(field.group)) {
      emittedGroups.add(field.group);
      section = field.group;
    }

    const resolved = {
      ...field,
      min: control.min,
      max: control.max,
      step: control.step,
      ...(options ? { options } : {}),
      ...(section ? { section } : {}),
      ...(Number.isSafeInteger(control.default) ? { default: control.default } : {}),
    };
    return [resolved];
  });
  return { profile: config.controls.profile, fields: [...fields, ...config.controls.fields] };
}

function resolveImageProfiles(config, reportedConfig) {
  const controls = resolveCameraControls(config, reportedConfig);
  return getCameraImageProfiles(config.kind).map((profile) => {
    try {
      const settings = normalizeCommandSettings({ ...config, controls }, profile.settings);
      return { ...profile, settings, available: true };
    } catch {
      return { ...profile, available: false };
    }
  });
}

function piReferenceSettings(target, hostname) {
  const source = getCameraConfigs(hostname).find((camera) => camera.kind === "pi");
  const sourceTopics = source ? collectCameraTopics(source.mqttTopicBase) : [];
  const entry = sourceTopics.find((topic) => topic.suffix === "config");
  const pi = parseJson(entry?.value);
  const targetConfig = parseJson(getLatestTopicValue(collectCameraTopics(target.mqttTopicBase), "config"));
  if (!pi || !targetConfig) throw new Error("pi_reference_unavailable");
  const controls = resolveCameraControls(target, targetConfig);
  const fields = new Map(controls.fields.map((field) => [field.key, field]));
  const imageControls = targetConfig.image_controls || {};
  const number = (key) => {
    if (typeof pi[key] !== "number" || !Number.isFinite(pi[key])) throw new Error(`invalid_pi_reference:${key}`);
    return pi[key];
  };
  const defaults = (key) => {
    const value = imageControls[key]?.default;
    if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid_pi_reference:${key}`);
    return value;
  };
  const settings = { fps: number("framerate"), bitrate_bps: number("bitrate"), gop: number("framerate") };
  const width = number("width"), height = number("height");
  const modes = [[1920, 1080], [1280, 960], [800, 640]];
  const resolution = modes.findIndex(([w, h]) => w === width && h === height);
  if (resolution < 0) throw new Error("pi_resolution_not_supported");
  if (fields.has("resolution")) settings.resolution = resolution;
  else if (targetConfig.width !== width || targetConfig.height !== height) throw new Error("pi_resolution_not_supported");
  // libcamera brightness is a fraction of the full 8-bit output range.
  // Contrast/saturation/sharpening are relative to their platform defaults.
  // These are comparable controls, not a port of libcamera's image algorithms.
  settings.brightness = Math.round(number("brightness") * 255);
  settings.contrast = Math.round(number("contrast") * defaults("contrast"));
  settings.saturation = Math.round(number("saturation") * defaults("saturation"));
  settings.sharpness = Math.round(number("sharpness") * defaults("sharpness"));
  const normalized = normalizeCommandSettings({ ...target, controls }, settings);
  return {
    settings: normalized,
    reference: {
      cameraId: source.cameraId,
      online: getLatestTopicValue(sourceTopics, "online") === "true" && Boolean(getClientSnapshot(source.mqttClientId)?.connected),
      timestamp: new Date(entry.timestamp).toISOString(),
      approximate: true,
    },
  };
}

function buildCameraOverview(config) {
  const statusTopics = collectCameraTopics(config.mqttTopicBase);
  const onlineValue = getLatestTopicValue(statusTopics, "online");
  const stateValue = getLatestTopicValue(statusTopics, "state");
  const errorValue = getLatestTopicValue(statusTopics, "error");
  const configValue = getLatestTopicValue(statusTopics, "config");
  const streamValue = getLatestTopicValue(statusTopics, "stream");
  const pongValue = getLatestTopicValue(statusTopics, "pong");
  const clientsValue = getLatestTopicValue(statusTopics, "clients");
  const directSessionsValue = getLatestTopicValue(statusTopics, "direct_sessions");
  const directStreamingClientsValue = getLatestTopicValue(statusTopics, "direct_streaming_clients");
  const frameFpsValue = getLatestTopicValue(statusTopics, "frame_fps");
  const publisherReadFpsValue = getLatestTopicValue(statusTopics, "publisher_read_fps");
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
  const timelapseStateValue = getLatestTopicValue(statusTopics, "timelapse/state")
    || getLatestTopicValue(statusTopics, "capture_request/state");
  const timelapseErrorValue = getLatestTopicValue(statusTopics, "timelapse/error")
    || getLatestTopicValue(statusTopics, "capture_request/error");
  const timelapseStorageBytesValue = getLatestTopicValue(statusTopics, "timelapse/storage_bytes");
  const timelapseLastImageValue = getLatestTopicValue(statusTopics, "timelapse/last_image");
  const timelapseOutputDirValue = getLatestTopicValue(statusTopics, "timelapse/output_dir");
  const timelapseEnabledValue = getLatestTopicValue(statusTopics, "timelapse/enabled")
    || getLatestTopicValue(statusTopics, "capture_request/enabled");
  const timelapseIntervalValue = getLatestTopicValue(statusTopics, "timelapse/interval_seconds")
    || getLatestTopicValue(statusTopics, "capture_request/interval_seconds");
  const ipValue = getLatestTopicValue(statusTopics, "ip");
  const rtspUrlValue = getLatestTopicValue(statusTopics, "rtsp_url");
  const lastStatusValue = getLatestTopicValue(statusTopics, "last_status");

  const mqttClient = getClientSnapshot(config.mqttClientId);
  const reportedOnline = parseBoolean(onlineValue);
  const reportedConfig = parseJson(configValue);
  const streamStatus = parseJson(streamValue);
  const streamConfig = {
    ...(streamStatus && typeof streamStatus === "object" ? streamStatus : {}),
    ...(reportedConfig && typeof reportedConfig === "object" ? reportedConfig : {}),
    ...(config.kind === "esp32-p4" && reportedConfig?.image && typeof reportedConfig.image === "object" ? reportedConfig.image : {}),
  };
  const commandAcknowledgement = statusTopics
    .filter((entry) => entry.suffix.startsWith("command/"))
    .map((entry) => ({ entry, payload: parseJson(entry.value) }))
    .find(({ entry, payload }) =>
      entry.suffix.slice("command/".length) && payload && typeof payload === "object"
    );
  const bridge = config.kind === "esp32" || config.kind === "dfr1154"
    ? getEsp32BridgeSnapshot(config.cameraId)
    : null;
  const serverCapture = config.archive?.type === "server_capture"
    ? getCameraTimelapseCaptureSnapshot(config.cameraId)
    : null;
  const online = mqttClient ? Boolean(mqttClient.connected && reportedOnline !== false) : reportedOnline;
  const cameraState = config.kind === "esp32-p4"
    ? (
        online === false
          ? "offline"
          : streamStatus?.active === true && online === true
            ? "streaming"
            : ["paused", "updating", "recovering"].includes(stateValue)
              ? stateValue
              : errorValue
                ? "error"
                : "idle"
      )
    : stateValue || "unknown";

  return {
    cameraId: config.cameraId,
    label: config.label,
    kind: config.kind,
    capabilities: config.capabilities,
    controls: resolveCameraControls(config, reportedConfig),
    imageProfiles: resolveImageProfiles(config, reportedConfig),
    requiresCommandAck: Boolean(config.requiresCommandAck),
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
      streamStatus: streamStatus && typeof streamStatus === "object" ? streamStatus : null,
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
      online,
      state: cameraState,
      error: errorValue || "",
      pong: pongValue || "",
      clients: clientsValue || "",
      directSessions: directSessionsValue || "",
      directStreamingClients: directStreamingClientsValue || "",
      frameFps: frameFpsValue || "",
      publisherReadFps: publisherReadFpsValue || "",
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
        id: commandAcknowledgement?.entry.suffix.slice("command/".length) || commandIdValue || "",
        name: commandAcknowledgement?.payload.command || commandNameValue || "",
        result: commandAcknowledgement
          ? (commandAcknowledgement.payload.ok === true ? "ok" : "error")
          : commandResultValue || "",
        message: commandAcknowledgement?.payload.error || commandMessageValue || "",
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

async function getSnapshot(req, res) {
  const cameraId = String(req.query.cameraId || "");
  const config = getCameraConfigById(cameraId, req.hostname);
  if (!config) {
    return res.status(400).json({ ok: false, error: "invalid_camera_id" });
  }
  if (typeof captureCameraLiveSnapshot !== "function") {
    return res.status(503).json({ ok: false, error: "snapshot_unavailable" });
  }

  try {
    const buffer = await captureCameraLiveSnapshot(config);
    res.set({
      "Content-Type": "image/jpeg",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "X-Snapshot-Timestamp": new Date().toISOString(),
    });
    return res.send(buffer);
  } catch (error) {
    const message = String(error?.message || error);
    const conflict = message === "snapshot_busy" || message === "camera_stream_inactive";
    return res.status(conflict ? 409 : 502).json({ ok: false, error: message });
  }
}

async function sendCommand(req, res) {
  const { cameraId, action, settings, payload, profileId } = req.body || {};
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
      case "reset":
        if (config.kind !== "esp32-p4") {
          return res.status(400).json({ ok: false, error: "unsupported_action" });
        }
        await publish(
          topicFor("reset"),
          JSON.stringify({
            _request_id: requestId,
            ...(payload === "all" ? { scope: "all" } : {}),
          }),
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
          JSON.stringify({ ...normalizeCommandSettings({ ...config, controls: resolveCameraControls(config,
            parseJson(getLatestTopicValue(collectCameraTopics(config.mqttTopicBase), "config"))) }, settings), _request_id: requestId }),
          { qos: 1 }
        );
        break;
      case "image_profile": {
        if (config.kind !== "esp32-p4") return res.status(400).json({ ok: false, error: "unsupported_action" });
        const reported = parseJson(getLatestTopicValue(collectCameraTopics(config.mqttTopicBase), "config"));
        const profile = resolveImageProfiles(config, reported).find((entry) => entry.id === profileId);
        if (!profile) return res.status(400).json({ ok: false, error: "invalid_image_profile" });
        if (!profile.available) return res.status(409).json({ ok: false, error: "image_profile_unavailable" });
        if (settings != null || payload != null) return res.status(400).json({ ok: false, error: "invalid_profile_override" });
        await publish(topicFor("set"), JSON.stringify({ ...profile.settings, _request_id: requestId }), { qos: 1 });
        return res.json({ ok: true, requestId, profileId: profile.id, settings: profile.settings, overview: buildOverview(req) });
      }
      case "match_pi": {
        if (config.kind !== "esp32-p4") return res.status(400).json({ ok: false, error: "unsupported_action" });
        const match = piReferenceSettings(config, req.hostname);
        await publish(topicFor("set"), JSON.stringify({ ...match.settings, _request_id: requestId }), { qos: 1 });
        return res.json({ ok: true, requestId, ...match, overview: buildOverview(req) });
      }
      default:
        return res.status(400).json({ ok: false, error: "invalid_action" });
    }

    res.json({ ok: true, requestId, overview: buildOverview(req) });
  } catch (error) {
    const message = String(error?.message || error);
    const invalidSetting = /^(?:unsupported_setting|invalid_boolean|invalid_number|invalid_text|value_below_minimum|value_above_maximum|invalid_option|invalid_pi_reference):/.test(message) ||
      ["pi_reference_unavailable", "pi_resolution_not_supported"].includes(message);
    res.status(invalidSetting ? 400 : 500).json({ ok: false, error: message });
  }
}

module.exports = {
  buildTimelapse,
  deleteTimelapse,
  getCameraPage,
  getOverview,
  getSnapshot,
  getTimelapse,
  getTimelapseFile,
  sendCommand,
};
