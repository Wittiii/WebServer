const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

const { getCameraConfigs } = require("../config/cameraConfig");
const { publish, topics } = require("../mqttBroker");
const { getEsp32BridgeSnapshot } = require("./esp32TranscodeService");

const GIB = 1024 ** 3;
const jobs = new Map();
let supervisorTimer = null;
let captureOwner = null;

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value) {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "on") return true;
  if (normalized === "false" || normalized === "0" || normalized === "off") return false;
  return null;
}

function parseJson(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function getTopicValue(camera, suffix) {
  return topics.get(`${camera.mqttTopicBase}/status/${suffix}`)?.lastMessage || "";
}

function getJob(cameraId) {
  if (!jobs.has(cameraId)) {
    jobs.set(cameraId, {
      cameraId,
      state: "initializing",
      error: "",
      enabled: true,
      intervalSeconds: 60,
      storageBytes: 0,
      storageLimitBytes: 22 * GIB,
      outputDir: "",
      lastImage: "",
      lastCaptureAt: null,
      nextCaptureAt: 0,
      captureInFlight: false,
      evaluating: false,
      consecutiveErrors: 0,
      lastStorageScanAt: 0,
      serverFreeBytes: 0,
      reserveBytes: 0,
      globalStorageBytes: 0,
      globalStorageLimitBytes: 0,
      lastPublishedSignature: "",
      lastPublishedAt: 0,
    });
  }
  return jobs.get(cameraId);
}

function getSettings(camera) {
  const currentConfig = parseJson(getTopicValue(camera, "config")) || {};
  const prefix = camera.archive?.envPrefix || `CAMERA_${camera.kind.toUpperCase()}`;
  const statusEnabled = parseBoolean(getTopicValue(camera, "timelapse/enabled"));
  const configuredEnabled = parseBoolean(currentConfig.timelapse_enabled);
  const defaultEnabled = parseBoolean(process.env[`${prefix}_TIMELAPSE_ENABLED`]);
  const enabled = configuredEnabled ?? statusEnabled ?? defaultEnabled ?? true;
  const intervalSeconds = Math.max(
    10,
    toNumber(
      currentConfig.timelapse_interval_seconds || getTopicValue(camera, "timelapse/interval_seconds"),
      process.env[`${prefix}_TIMELAPSE_INTERVAL_SECONDS`] || 60
    )
  );
  const limitGb = Math.max(
    0.1,
    toNumber(currentConfig.timelapse_limit_gb, process.env[`${prefix}_TIMELAPSE_LIMIT_GB`] || 22)
  );

  return { enabled, intervalSeconds, storageLimitBytes: Math.floor(limitGb * GIB) };
}

function getOutputDir(camera) {
  return path.resolve(
    camera.archive?.localDir || path.join(process.cwd(), "data", "timelapse", camera.cameraId)
  );
}

function getMediaMtxUrl(camera) {
  const host = process.env.MEDIA_MTX_INTERNAL_HOST || "127.0.0.1";
  const port = toNumber(process.env.MEDIA_MTX_RTSP_PORT, 8554);
  return `rtsp://${host}:${port}/${camera.streamPath}`;
}

function frameName(now = new Date()) {
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
    now.getDate()
  ).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(
    now.getMinutes()
  ).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
  return `frame-${stamp}.jpg`;
}

async function refreshStorage(job) {
  await fs.mkdir(job.outputDir, { recursive: true });
  const entries = await fs.readdir(job.outputDir, { withFileTypes: true });
  let total = 0;
  let latestImage = "";
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(?:jpe?g|mp4)$/i.test(entry.name)) continue;
    const stats = await fs.stat(path.join(job.outputDir, entry.name));
    total += stats.size;
    if (/\.jpe?g$/i.test(entry.name) && entry.name > latestImage) latestImage = entry.name;
  }
  job.storageBytes = total;
  job.lastImage = latestImage;
  job.lastStorageScanAt = Date.now();
}

async function refreshDiskLimits(job) {
  const stats = await fs.statfs(job.outputDir);
  job.serverFreeBytes = Number(stats.bavail) * Number(stats.bsize);
  job.reserveBytes = Math.max(0, toNumber(process.env.CAMERA_TIMELAPSE_MIN_FREE_GB, 5)) * GIB;
  job.globalStorageBytes = [...jobs.values()].reduce((sum, item) => sum + item.storageBytes, 0);
  job.globalStorageLimitBytes = Math.max(
    0,
    toNumber(process.env.CAMERA_TIMELAPSE_TOTAL_LIMIT_GB, 0)
  ) * GIB;
}

function sourceIsReady(camera) {
  const online = parseBoolean(getTopicValue(camera, "online")) === true;
  if (!online) return false;
  if (camera.kind === "pi") {
    const state = getTopicValue(camera, "state");
    const publisherConnected = parseBoolean(getTopicValue(camera, "publisher_connected"));
    return publisherConnected === true || state === "streaming" || state === "running";
  }
  const bridge = getEsp32BridgeSnapshot(camera.cameraId);
  return Boolean(bridge?.pid) && !["error", "retry_wait", "stopped"].includes(bridge.state);
}

async function publishStatus(camera, job, force = false) {
  const payload = {
    state: job.state,
    error: job.error,
    enabled: job.enabled,
    interval_seconds: job.intervalSeconds,
    storage_bytes: job.storageBytes,
    storage_limit_bytes: job.storageLimitBytes,
    global_storage_bytes: job.globalStorageBytes,
    global_storage_limit_bytes: job.globalStorageLimitBytes,
    server_free_bytes: job.serverFreeBytes,
    server_reserve_bytes: job.reserveBytes,
    last_image: job.lastImage,
    last_capture_at: job.lastCaptureAt || "",
    output_dir: job.outputDir,
  };
  const signature = JSON.stringify(payload);
  if (!force && signature === job.lastPublishedSignature && Date.now() - job.lastPublishedAt < 30000) return;
  job.lastPublishedSignature = signature;
  job.lastPublishedAt = Date.now();
  await Promise.all(
    Object.entries(payload).map(([key, value]) =>
      publish(`${camera.mqttTopicBase}/status/server_capture/${key}`, String(value), {
        qos: 1,
        retain: true,
      })
    )
  ).catch((error) => console.error(`[Timelapse:${camera.cameraId}] MQTT status: ${error.message}`));
}

function captureTimeoutMs(camera) {
  const prefix = camera.archive?.envPrefix || `CAMERA_${camera.kind.toUpperCase()}`;
  return Math.max(
    5000,
    toNumber(process.env[`${prefix}_CAPTURE_TIMEOUT_MS`], process.env.CAMERA_TIMELAPSE_CAPTURE_TIMEOUT_MS || 20000)
  );
}

async function captureFrame(camera, job) {
  captureOwner = camera.cameraId;
  job.captureInFlight = true;
  job.state = "capturing";
  job.error = "";
  const name = frameName();
  const finalPath = path.join(job.outputDir, name);
  const temporaryPath = `${finalPath}.partial`;

  try {
    await refreshStorage(job);
    await refreshDiskLimits(job);
    if (job.storageBytes >= job.storageLimitBytes) throw new Error("camera_storage_limit_reached");
    if (job.globalStorageLimitBytes && job.globalStorageBytes >= job.globalStorageLimitBytes) {
      throw new Error("global_storage_limit_reached");
    }
    if (job.serverFreeBytes <= job.reserveBytes) throw new Error("server_free_space_reserve_reached");

    await fs.unlink(temporaryPath).catch(() => {});
    await new Promise((resolve, reject) => {
      const child = spawn(
        process.env.TIMELAPSE_FFMPEG_PATH || "ffmpeg",
        [
          "-y", "-nostdin", "-hide_banner", "-loglevel", "error",
          "-rtsp_transport", "tcp", "-i", getMediaMtxUrl(camera),
          "-map", "0:v:0", "-frames:v", "1", "-c:v", "mjpeg", "-q:v", "2",
          "-f", "image2", temporaryPath,
        ],
        { stdio: ["ignore", "ignore", "pipe"] }
      );
      let stderr = "";
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, captureTimeoutMs(camera));
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", (error) => { clearTimeout(timeout); reject(error); });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve();
        else reject(new Error(timedOut ? "snapshot_timeout" : stderr.trim() || `snapshot_ffmpeg_failed_${code}`));
      });
    });

    const stats = await fs.stat(temporaryPath);
    if (!stats.isFile() || stats.size === 0) throw new Error("snapshot_file_empty");
    await fs.rename(temporaryPath, finalPath);
    job.storageBytes += stats.size;
    job.lastImage = name;
    job.lastCaptureAt = new Date().toISOString();
    job.state = "running";
    job.consecutiveErrors = 0;
    console.log(`[Timelapse:${camera.cameraId}] saved ${name} (${stats.size} bytes)`);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => {});
    job.error = String(error?.message || error);
    job.state = /_limit_|_reserve_/.test(job.error) ? "storage_full" : "error";
    job.consecutiveErrors += 1;
    console.error(`[Timelapse:${camera.cameraId}] ${job.error}`);
  } finally {
    const retrySeconds = job.state === "error"
      ? Math.min(60, 5 * 2 ** Math.min(job.consecutiveErrors, 4))
      : job.intervalSeconds;
    job.nextCaptureAt = Date.now() + retrySeconds * 1000;
    job.captureInFlight = false;
    captureOwner = null;
    void publishStatus(camera, job, true);
  }
}

async function evaluateCamera(camera) {
  const job = getJob(camera.cameraId);
  if (job.evaluating) return;
  job.evaluating = true;
  try {
    const settings = getSettings(camera);
    Object.assign(job, settings, { outputDir: getOutputDir(camera) });
    if (Date.now() - job.lastStorageScanAt >= 30000) {
      await refreshStorage(job);
      await refreshDiskLimits(job);
    }
    if (!job.enabled) {
      job.state = "stopped";
      job.error = "";
    } else if (!sourceIsReady(camera)) {
      job.state = "waiting_stream";
      job.error = "";
    } else if (!job.captureInFlight && Date.now() >= job.nextCaptureAt) {
      if (captureOwner && captureOwner !== camera.cameraId) {
        job.state = "waiting_capture_slot";
      } else {
        void captureFrame(camera, job);
      }
    }
    void publishStatus(camera, job);
  } catch (error) {
    job.state = "error";
    job.error = String(error?.message || error);
    void publishStatus(camera, job, true);
  } finally {
    job.evaluating = false;
  }
}

function supervisorTick() {
  const cameras = getCameraConfigs("localhost").filter(
    (camera) => camera.archive?.type === "server_capture"
  );
  for (const camera of cameras) void evaluateCamera(camera);
}

function startCameraTimelapseCaptureSupervisor() {
  if (supervisorTimer) return;
  supervisorTick();
  supervisorTimer = setInterval(supervisorTick, 2000);
  console.log("[Timelapse] server capture supervisor started");
}

function getCameraTimelapseCaptureSnapshot(cameraId) {
  const job = jobs.get(cameraId);
  if (!job) return null;
  return {
    state: job.state,
    error: job.error,
    storageBytes: job.storageBytes,
    storageLimitBytes: job.storageLimitBytes,
    globalStorageBytes: job.globalStorageBytes,
    globalStorageLimitBytes: job.globalStorageLimitBytes,
    serverFreeBytes: job.serverFreeBytes,
    serverReserveBytes: job.reserveBytes,
    lastImage: job.lastImage,
    outputDir: job.outputDir,
    enabled: job.enabled,
    intervalSeconds: job.intervalSeconds,
    lastCaptureAt: job.lastCaptureAt,
    captureInFlight: job.captureInFlight,
    consecutiveErrors: job.consecutiveErrors,
  };
}

module.exports = {
  getCameraTimelapseCaptureSnapshot,
  startCameraTimelapseCaptureSupervisor,
};
