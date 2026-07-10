const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

const { getCameraConfigs } = require("../config/cameraConfig");
const { topics } = require("../mqttBroker");
const { getEsp32BridgeSnapshot } = require("./esp32TranscodeService");

const jobs = new Map();
let supervisorTimer = null;

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseJson(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getTopicValue(camera, suffix) {
  return topics.get(`${camera.mqttTopicBase}/status/${suffix}`)?.lastMessage || "";
}

function getJob(cameraId) {
  let job = jobs.get(cameraId);
  if (!job) {
    job = {
      cameraId,
      state: "initializing",
      error: "",
      enabled: true,
      intervalSeconds: 60,
      storageBytes: 0,
      storageLimitBytes: 22 * 1024 ** 3,
      outputDir: "",
      lastImage: "",
      lastCaptureAt: null,
      nextCaptureAt: 0,
      captureInFlight: false,
      evaluating: false,
      lastStorageScanAt: 0,
    };
    jobs.set(cameraId, job);
  }
  return job;
}

function getSettings(camera) {
  const currentConfig = parseJson(getTopicValue(camera, "config")) || {};
  const defaultEnabled = String(process.env.CAMERA_DFR1154_TIMELAPSE_ENABLED || "true") !== "false";
  const enabled = typeof currentConfig.timelapse_enabled === "boolean"
    ? currentConfig.timelapse_enabled
    : defaultEnabled;
  const intervalSeconds = Math.max(
    10,
    toNumber(
      currentConfig.timelapse_interval_seconds,
      process.env.CAMERA_DFR1154_TIMELAPSE_INTERVAL_SECONDS || 60
    )
  );
  const limitGb = Math.max(
    1,
    toNumber(currentConfig.timelapse_limit_gb, process.env.CAMERA_DFR1154_TIMELAPSE_LIMIT_GB || 22)
  );

  return {
    enabled,
    intervalSeconds,
    storageLimitBytes: Math.floor(limitGb * 1024 ** 3),
  };
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
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
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
    if (/\.jpe?g$/i.test(entry.name) && (!latestImage || entry.name > latestImage)) {
      latestImage = entry.name;
    }
  }

  job.storageBytes = total;
  job.lastImage = latestImage;
  job.lastStorageScanAt = Date.now();
}

async function captureFrame(camera, job) {
  job.captureInFlight = true;
  job.state = "capturing";
  job.error = "";

  const name = frameName();
  const finalPath = path.join(job.outputDir, name);
  const temporaryPath = path.join(job.outputDir, `${name}.tmp.jpg`);
  const ffmpegPath = process.env.TIMELAPSE_FFMPEG_PATH || "ffmpeg";
  const timeoutMs = Math.max(
    5000,
    toNumber(process.env.CAMERA_DFR1154_CAPTURE_TIMEOUT_MS, 20000)
  );

  try {
    await refreshStorage(job);
    if (job.storageBytes >= job.storageLimitBytes) {
      job.state = "storage_full";
      job.error = "server_timelapse_storage_limit_reached";
      job.nextCaptureAt = Date.now() + job.intervalSeconds * 1000;
      return;
    }

    await fs.unlink(temporaryPath).catch(() => {});
    await new Promise((resolve, reject) => {
      const child = spawn(
        ffmpegPath,
        [
          "-y",
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-rtsp_transport",
          "tcp",
          "-i",
          getMediaMtxUrl(camera),
          "-map",
          "0:v:0",
          "-frames:v",
          "1",
          "-q:v",
          "2",
          "-f",
          "image2",
          temporaryPath,
        ],
        { stdio: ["ignore", "ignore", "pipe"] }
      );
      let stderr = "";
      const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `snapshot_ffmpeg_failed_${code}`));
      });
    });

    const stats = await fs.stat(temporaryPath);
    if (!stats.isFile() || stats.size === 0) throw new Error("snapshot_file_empty");
    await fs.rename(temporaryPath, finalPath);

    job.storageBytes += stats.size;
    job.lastImage = name;
    job.lastCaptureAt = new Date().toISOString();
    job.state = "running";
    console.log(`[DFR-Timelapse:${camera.cameraId}] saved ${name} (${stats.size} bytes)`);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => {});
    job.state = "error";
    job.error = String(error?.message || error);
    console.error(`[DFR-Timelapse:${camera.cameraId}] ${job.error}`);
  } finally {
    job.nextCaptureAt = Date.now() + (job.state === "error" ? 10000 : job.intervalSeconds * 1000);
    job.captureInFlight = false;
  }
}

async function evaluateCamera(camera) {
  const job = getJob(camera.cameraId);
  if (job.evaluating) return;
  job.evaluating = true;
  try {
    const settings = getSettings(camera);
    job.enabled = settings.enabled;
    job.intervalSeconds = settings.intervalSeconds;
    job.storageLimitBytes = settings.storageLimitBytes;
    job.outputDir = getOutputDir(camera);

    if (!job.enabled) {
      job.state = "stopped";
      job.error = "";
      return;
    }
    if (job.captureInFlight) return;

    const bridge = getEsp32BridgeSnapshot(camera.cameraId);
    if (!bridge?.pid || ["error", "retry_wait", "stopped"].includes(bridge.state)) {
      job.state = "waiting_stream";
      return;
    }

    if (Date.now() - job.lastStorageScanAt >= 30000) {
      await refreshStorage(job).catch((error) => {
        job.error = String(error?.message || error);
      });
    }
    if (Date.now() < job.nextCaptureAt) return;
    void captureFrame(camera, job);
  } finally {
    job.evaluating = false;
  }
}

function supervisorTick() {
  const cameras = getCameraConfigs("localhost").filter(
    (camera) => camera.kind === "dfr1154" && camera.archive?.type === "server_capture"
  );
  for (const camera of cameras) {
    void evaluateCamera(camera);
  }
}

function startDfrTimelapseCaptureSupervisor() {
  if (supervisorTimer) return;
  supervisorTick();
  supervisorTimer = setInterval(supervisorTick, 2000);
  console.log("[DFR-Timelapse] server capture supervisor started");
}

function getDfrTimelapseCaptureSnapshot(cameraId) {
  const job = jobs.get(cameraId);
  if (!job) return null;
  return {
    state: job.state,
    error: job.error,
    storageBytes: job.storageBytes,
    storageLimitBytes: job.storageLimitBytes,
    lastImage: job.lastImage,
    outputDir: job.outputDir,
    enabled: job.enabled,
    intervalSeconds: job.intervalSeconds,
    lastCaptureAt: job.lastCaptureAt,
  };
}

module.exports = {
  getDfrTimelapseCaptureSnapshot,
  startDfrTimelapseCaptureSupervisor,
};
