const fs = require("fs/promises");
const path = require("path");
const { randomUUID } = require("node:crypto");
const { getCameraConfigs } = require("../config/cameraConfig");
const { runMediaProcess } = require("./mediaProcessService");

const MAX_EVENTS = 100;
const MAX_MARKERS = 500;
const DEFAULT_MAX_CLIPS = 50;

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  thresholdDb: -30,
  cooldownSeconds: 30,
  autoClip: true,
  clipDurationSeconds: 30,
  webhookUrl: "",
  saveTimelapseMarkers: true,
});

const liveState = new Map();
const settingsByCamera = new Map();
const eventsByCamera = new Map();
const markersByCamera = new Map();
const clipJobs = new Map();

let loaded = false;

function getDataRoot() {
  return path.resolve(process.env.CAMERA_AUDIO_DATA_DIR || path.join(process.cwd(), "data"));
}

function getConfigPath() {
  return path.join(getDataRoot(), "camera-audio-config.json");
}

function getEventsPath() {
  return path.join(getDataRoot(), "camera-audio-events.json");
}

function getClipsDir(cameraId) {
  const safeId = String(cameraId || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(getDataRoot(), "clips", safeId);
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeSettings(raw = {}) {
  const webhookUrl = String(raw.webhookUrl || "").trim();
  const safeWebhook =
    webhookUrl && /^https?:\/\//i.test(webhookUrl) ? webhookUrl : "";

  return {
    enabled: raw.enabled !== undefined ? Boolean(raw.enabled) : DEFAULT_SETTINGS.enabled,
    thresholdDb: clampNumber(raw.thresholdDb, -90, 0, DEFAULT_SETTINGS.thresholdDb),
    cooldownSeconds: clampNumber(raw.cooldownSeconds, 5, 3600, DEFAULT_SETTINGS.cooldownSeconds),
    autoClip: raw.autoClip !== undefined ? Boolean(raw.autoClip) : DEFAULT_SETTINGS.autoClip,
    clipDurationSeconds: clampNumber(raw.clipDurationSeconds, 5, 120, DEFAULT_SETTINGS.clipDurationSeconds),
    webhookUrl: safeWebhook,
    saveTimelapseMarkers:
      raw.saveTimelapseMarkers !== undefined
        ? Boolean(raw.saveTimelapseMarkers)
        : DEFAULT_SETTINGS.saveTimelapseMarkers,
  };
}

async function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const rawConfig = await fs.readFile(getConfigPath(), "utf8");
    const parsed = JSON.parse(rawConfig);
    if (parsed && typeof parsed === "object") {
      for (const [cameraId, cfg] of Object.entries(parsed)) {
        settingsByCamera.set(cameraId, normalizeSettings(cfg));
      }
    }
  } catch {
    // Missing or invalid config file falls back to defaults.
  }

  try {
    const rawEvents = await fs.readFile(getEventsPath(), "utf8");
    const parsed = JSON.parse(rawEvents);
    if (parsed && typeof parsed === "object") {
      for (const [cameraId, data] of Object.entries(parsed)) {
        if (Array.isArray(data?.events)) {
          eventsByCamera.set(cameraId, data.events.slice(0, MAX_EVENTS));
        }
        if (Array.isArray(data?.markers)) {
          markersByCamera.set(cameraId, data.markers.slice(0, MAX_MARKERS));
        }
      }
    }
  } catch {
    // Missing or invalid events file falls back to empty.
  }
}

async function persistSettings() {
  try {
    await fs.mkdir(getDataRoot(), { recursive: true });
    const obj = Object.fromEntries(settingsByCamera.entries());
    await fs.writeFile(getConfigPath(), JSON.stringify(obj, null, 2), "utf8");
  } catch (err) {
    console.error("[CameraAudio] failed to persist config", err?.message || err);
  }
}

async function persistEvents() {
  try {
    await fs.mkdir(getDataRoot(), { recursive: true });
    const obj = {};
    const ids = new Set([...eventsByCamera.keys(), ...markersByCamera.keys()]);
    for (const id of ids) {
      obj[id] = {
        events: (eventsByCamera.get(id) || []).slice(0, MAX_EVENTS),
        markers: (markersByCamera.get(id) || []).slice(0, MAX_MARKERS),
      };
    }
    await fs.writeFile(getEventsPath(), JSON.stringify(obj, null, 2), "utf8");
  } catch (err) {
    console.error("[CameraAudio] failed to persist events", err?.message || err);
  }
}

function getSettings(cameraId) {
  return settingsByCamera.get(cameraId) || { ...DEFAULT_SETTINGS };
}

async function updateSettings(cameraId, patch) {
  await ensureLoaded();
  const next = normalizeSettings({ ...getSettings(cameraId), ...(patch || {}) });
  settingsByCamera.set(cameraId, next);
  await persistSettings();
  return next;
}

function getLive(cameraId) {
  if (!liveState.has(cameraId)) {
    liveState.set(cameraId, {
      currentDb: null,
      lastDbAt: null,
      lastTriggeredAt: 0,
    });
  }
  return liveState.get(cameraId);
}

function formatClipFilename(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `clip_${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(
    date.getHours()
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}.mp4`;
}

function getFfmpegPath() {
  return process.env.TIMELAPSE_FFMPEG_PATH || "ffmpeg";
}

async function pruneOldClips(cameraId) {
  const maxClips = Math.max(5, Number(process.env.CAMERA_AUDIO_MAX_CLIPS || DEFAULT_MAX_CLIPS));
  const dir = getClipsDir(cameraId);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const mp4s = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".mp4")) continue;
      const fullPath = path.join(dir, entry.name);
      const stat = await fs.stat(fullPath);
      mp4s.push({ name: entry.name, fullPath, mtimeMs: stat.mtimeMs });
    }
    mp4s.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const stale of mp4s.slice(maxClips)) {
      await fs.unlink(stale.fullPath).catch(() => {});
    }
  } catch {
    // Directory might not exist yet.
  }
}

async function recordAudioClip(cameraConfig, eventRecord, options = {}) {
  const cameraId = cameraConfig.cameraId;
  if (clipJobs.get(cameraId)) {
    return null;
  }

  const rtspUrl = cameraConfig?.urls?.rtsp;
  if (!rtspUrl) return null;

  const settings = getSettings(cameraId);
  const durationSeconds = clampNumber(
    options.durationSeconds ?? settings.clipDurationSeconds,
    5,
    120,
    30
  );
  const dir = getClipsDir(cameraId);
  const filename = formatClipFilename();
  const outputPath = path.join(dir, filename);

  clipJobs.set(cameraId, filename);
  if (eventRecord) {
    eventRecord.clipName = filename;
    eventRecord.clipStatus = "recording";
  }

  try {
    await fs.mkdir(dir, { recursive: true });
    const runner = options.runner || runMediaProcess;
    const args = [
      "-y",
      "-rtsp_transport",
      "tcp",
      "-i",
      rtspUrl,
      "-t",
      String(durationSeconds),
      "-c:v",
      "copy",
      "-c:a",
      "copy",
      "-movflags",
      "+faststart",
      outputPath,
    ];
    await runner(getFfmpegPath(), args, { timeoutMs: (durationSeconds + 20) * 1000 });
    if (eventRecord) {
      eventRecord.clipStatus = "ready";
      await persistEvents();
    }
    await pruneOldClips(cameraId);
    return filename;
  } catch (err) {
    if (eventRecord) {
      eventRecord.clipStatus = "failed";
      eventRecord.clipError = err?.message || "ffmpeg_failed";
      await persistEvents();
    }
    await fs.unlink(outputPath).catch(() => {});
    return null;
  } finally {
    clipJobs.delete(cameraId);
  }
}

async function sendWebhook(webhookUrl, payload) {
  if (!webhookUrl) return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
  } catch (err) {
    console.error("[CameraAudio] webhook delivery failed:", err?.message || err);
  }
}

async function triggerAudioEvent(cameraConfig, { type, label, db, confidence = null, source = "server" }, options = {}) {
  await ensureLoaded();
  const cameraId = cameraConfig.cameraId;
  const settings = getSettings(cameraId);
  const now = Date.now();
  const timestamp = new Date(now).toISOString();

  const event = {
    id: randomUUID(),
    cameraId,
    type,
    label,
    db: db !== null && db !== undefined && Number.isFinite(Number(db)) ? Number(db) : null,
    confidence:
      confidence !== null && confidence !== undefined && Number.isFinite(Number(confidence))
        ? Number(confidence)
        : null,
    source,
    timestamp,
    clipName: null,
    clipStatus: null,
  };

  const list = eventsByCamera.get(cameraId) || [];
  list.unshift(event);
  eventsByCamera.set(cameraId, list.slice(0, MAX_EVENTS));

  if (settings.saveTimelapseMarkers) {
    const markers = markersByCamera.get(cameraId) || [];
    markers.unshift({
      id: event.id,
      cameraId,
      timestamp,
      db: event.db,
      type,
      label,
    });
    markersByCamera.set(cameraId, markers.slice(0, MAX_MARKERS));
  }

  await persistEvents();

  if (settings.autoClip && options.skipClip !== true) {
    // Fire-and-forget clip capture unless explicitly awaited in tests
    const clipPromise = recordAudioClip(cameraConfig, event, options);
    if (options.awaitSideEffects) {
      await clipPromise;
    }
  }

  if (settings.webhookUrl && options.skipWebhook !== true) {
    const webhookPromise = sendWebhook(settings.webhookUrl, event);
    if (options.awaitSideEffects) {
      await webhookPromise;
    }
  }

  return event;
}

async function ingestCameraAudioMessage(topic, payload, options = {}) {
  if (!topic) return null;
  const cameras = getCameraConfigs("127.0.0.1").filter((c) => c.capabilities?.audio);
  const camera = cameras.find(
    (c) =>
      topic === `${c.mqttTopicBase}/status/audio_db` ||
      topic === `${c.mqttTopicBase}/status/audio_event`
  );
  if (!camera) return null;

  await ensureLoaded();
  const cameraId = camera.cameraId;
  const settings = getSettings(cameraId);
  const live = getLive(cameraId);

  if (topic.endsWith("/status/audio_db")) {
    const db = Number(String(payload ?? "").trim());
    if (!Number.isFinite(db)) return null;
    live.currentDb = db;
    live.lastDbAt = new Date().toISOString();

    if (settings.enabled && db >= settings.thresholdDb) {
      const now = Date.now();
      if (now - live.lastTriggeredAt >= settings.cooldownSeconds * 1000) {
        live.lastTriggeredAt = now;
        return triggerAudioEvent(
          camera,
          {
            type: "threshold",
            label: `Pegel-Alarm (${db.toFixed(1)} dB >= ${settings.thresholdDb} dB)`,
            db,
            source: "mqtt_audio_db",
          },
          options
        );
      }
    }
    return null;
  }

  if (topic.endsWith("/status/audio_event")) {
    let parsed = null;
    try {
      parsed = JSON.parse(String(payload || ""));
    } catch {
      parsed = { label: String(payload || "").trim() };
    }
    const label = String(parsed?.label || parsed?.event || "Audio-Ereignis").trim();
    if (!label) return null;
    const db = parsed?.db !== undefined ? Number(parsed.db) : live.currentDb;
    const confidence = parsed?.confidence !== undefined ? Number(parsed.confidence) : null;
    return triggerAudioEvent(
      camera,
      {
        type: "ai_classification",
        label,
        db: Number.isFinite(db) ? db : null,
        confidence: Number.isFinite(confidence) ? confidence : null,
        source: "mqtt_audio_event",
      },
      options
    );
  }

  return null;
}

async function listAudioClips(cameraId) {
  const dir = getClipsDir(cameraId);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const items = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".mp4")) continue;
      const stat = await fs.stat(path.join(dir, entry.name));
      items.push({
        name: entry.name,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        url: `/api/camera/audio/clip?cameraId=${encodeURIComponent(cameraId)}&name=${encodeURIComponent(entry.name)}`,
      });
    }
    items.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
    return items;
  } catch {
    return [];
  }
}

async function resolveAudioClipFile(cameraId, name) {
  const safeName = path.basename(String(name || ""));
  if (!safeName || !safeName.endsWith(".mp4") || safeName !== String(name || "")) {
    return null;
  }
  const dir = getClipsDir(cameraId);
  const fullPath = path.resolve(dir, safeName);
  if (!fullPath.startsWith(path.resolve(dir) + path.sep)) {
    return null;
  }
  try {
    const stat = await fs.stat(fullPath);
    if (!stat.isFile()) return null;
    return { path: fullPath, name: safeName, sizeBytes: stat.size };
  } catch {
    return null;
  }
}

async function deleteAudioClip(cameraId, name) {
  const resolved = await resolveAudioClipFile(cameraId, name);
  if (!resolved) return false;
  await fs.unlink(resolved.path);
  return true;
}

async function getCameraAudioSnapshot(cameraId) {
  await ensureLoaded();
  const live = getLive(cameraId);
  const settings = getSettings(cameraId);
  const events = (eventsByCamera.get(cameraId) || []).slice(0, 25);
  const markers = (markersByCamera.get(cameraId) || []).slice(0, 150);
  const now = Date.now();
  const activeAlarm =
    Boolean(live.lastTriggeredAt) && now - live.lastTriggeredAt < settings.cooldownSeconds * 1000;

  return {
    settings,
    currentDb: live.currentDb,
    lastDbAt: live.lastDbAt,
    lastTriggeredAt: live.lastTriggeredAt ? new Date(live.lastTriggeredAt).toISOString() : null,
    activeAlarm,
    clipInFlight: clipJobs.get(cameraId) || null,
    events,
    markers,
  };
}

function getCameraAudioSnapshotSync(cameraId) {
  const live = getLive(cameraId);
  const settings = getSettings(cameraId);
  const events = (eventsByCamera.get(cameraId) || []).slice(0, 25);
  const markers = (markersByCamera.get(cameraId) || []).slice(0, 150);
  const now = Date.now();
  const activeAlarm =
    Boolean(live.lastTriggeredAt) && now - live.lastTriggeredAt < settings.cooldownSeconds * 1000;

  return {
    settings,
    currentDb: live.currentDb,
    lastDbAt: live.lastDbAt,
    lastTriggeredAt: live.lastTriggeredAt ? new Date(live.lastTriggeredAt).toISOString() : null,
    activeAlarm,
    clipInFlight: clipJobs.get(cameraId) || null,
    events,
    markers,
  };
}

function resetCameraAudioStateForTests() {
  liveState.clear();
  settingsByCamera.clear();
  eventsByCamera.clear();
  markersByCamera.clear();
  clipJobs.clear();
  loaded = false;
}

module.exports = {
  DEFAULT_SETTINGS,
  ensureLoaded,
  getSettings,
  updateSettings,
  ingestCameraAudioMessage,
  triggerAudioEvent,
  recordAudioClip,
  listAudioClips,
  resolveAudioClipFile,
  deleteAudioClip,
  getCameraAudioSnapshot,
  getCameraAudioSnapshotSync,
  resetCameraAudioStateForTests,
};
