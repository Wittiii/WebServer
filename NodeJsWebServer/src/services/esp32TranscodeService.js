const { spawn } = require("child_process");

const { getCameraConfigs } = require("../config/cameraConfig");
const { publish, topics } = require("../mqttBroker");

const bridges = new Map();

let supervisorTimer = null;

function parseBoolean(value) {
  if (typeof value === "boolean") return value;
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

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getTopicValue(topic) {
  const entry = topics.get(topic);
  return entry ? entry.lastMessage : "";
}

function getCameraTopicValue(camera, suffix) {
  return getTopicValue(`${camera.mqttTopicBase}/status/${suffix}`);
}

function getEnabledFlag() {
  const value = String(process.env.ESP32_TRANSCODE_ENABLED || "true").trim().toLowerCase();
  return value !== "false" && value !== "0" && value !== "off";
}

function getFfmpegPath() {
  return process.env.ESP32_TRANSCODE_FFMPEG_PATH || "ffmpeg";
}

function getInternalRtspHost() {
  return process.env.MEDIA_MTX_INTERNAL_HOST || "127.0.0.1";
}

function getInternalRtspPort() {
  return toNumber(process.env.MEDIA_MTX_RTSP_PORT, 8554);
}

function getRestartDelayMs() {
  return Math.max(2000, toNumber(process.env.ESP32_TRANSCODE_RESTART_MS, 5000));
}

function getCheckIntervalMs() {
  return Math.max(1000, toNumber(process.env.ESP32_TRANSCODE_CHECK_MS, 3000));
}

function getStopTimeoutMs() {
  return Math.max(1000, toNumber(process.env.ESP32_TRANSCODE_STOP_TIMEOUT_MS, 4000));
}

function getSourceReadTimeoutMs() {
  return Math.max(3000, toNumber(process.env.ESP32_SOURCE_RW_TIMEOUT_MS, 15000));
}

function getStartupTimeoutMs() {
  return Math.max(10000, toNumber(process.env.ESP32_TRANSCODE_STARTUP_TIMEOUT_MS, 30000));
}

function getStallTimeoutMs() {
  return Math.max(10000, toNumber(process.env.ESP32_TRANSCODE_STALL_TIMEOUT_MS, 25000));
}

function getSourceRtspUrl(camera) {
  const explicitUrl = getCameraTopicValue(camera, "rtsp_url");
  if (explicitUrl) return explicitUrl;

  const ip = getCameraTopicValue(camera, "ip");
  if (!ip) return "";

  const port = toNumber(process.env.ESP32_SOURCE_RTSP_PORT, 8554);
  const path = process.env.ESP32_SOURCE_RTSP_PATH || "mjpeg/1";
  return `rtsp://${ip}:${port}/${String(path).replace(/^\/+/, "")}`;
}

function getBridgeDestinationUrl(camera) {
  return `rtsp://${getInternalRtspHost()}:${getInternalRtspPort()}/${camera.streamPath}`;
}

function getBridgeArgs(sourceRtspUrl, destinationRtspUrl, sourceConfig = {}, options = {}) {
  const detectedSourceFps = toNumber(sourceConfig.stream_fps, 0);
  const outputFps = toNumber(process.env.ESP32_TRANSCODE_OUTPUT_FPS, 0) || detectedSourceFps;
  const gopSize = toNumber(process.env.ESP32_TRANSCODE_GOP, 0) || (outputFps > 0 ? outputFps * 2 : 24);
  const crf = options.crf ?? toNumber(process.env.ESP32_TRANSCODE_CRF, 23);
  const bitrate = String(process.env.ESP32_TRANSCODE_BITRATE || "").trim();

  const args = [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    options.logLevel || process.env.ESP32_TRANSCODE_LOGLEVEL || "warning",
    "-progress",
    "pipe:1",
    "-nostats",
    "-use_wallclock_as_timestamps",
    "1",
    "-fflags",
    "+genpts+nobuffer+discardcorrupt",
    "-flags",
    "low_delay",
    "-analyzeduration",
    String(options.analyzeDuration ?? 5000000),
    "-probesize",
    String(options.probeSize ?? 5000000),
    "-rtsp_transport",
    options.sourceTransport || process.env.ESP32_SOURCE_RTSP_TRANSPORT || "tcp",
    "-timeout",
    String(getSourceReadTimeoutMs() * 1000),
    "-i",
    sourceRtspUrl,
    "-an",
    "-c:v",
    options.codec || process.env.ESP32_TRANSCODE_CODEC || "libx264",
    "-preset",
    options.preset || process.env.ESP32_TRANSCODE_PRESET || "superfast",
    "-tune",
    process.env.ESP32_TRANSCODE_TUNE || "zerolatency",
    "-pix_fmt",
    process.env.ESP32_TRANSCODE_PIXEL_FORMAT || "yuv420p",
    "-profile:v",
    options.profile || process.env.ESP32_TRANSCODE_PROFILE || "baseline",
    "-bf",
    "0",
    "-crf",
    String(crf),
  ];

  if (outputFps > 0) {
    args.push("-r", String(outputFps));
  }

  if (gopSize > 0) {
    args.push("-g", String(gopSize));
  }

  if (bitrate) {
    args.push("-b:v", bitrate);
  }

  args.push(
    "-f",
    "rtsp",
    "-rtsp_transport",
    process.env.ESP32_TRANSCODE_DEST_TRANSPORT || "tcp",
    destinationRtspUrl
  );

  return args;
}

function ensureBridge(cameraId) {
  const existing = bridges.get(cameraId);
  if (existing) return existing;

  const created = {
    cameraId,
    state: "idle",
    pid: null,
    process: null,
    sourceRtspUrl: "",
    destinationRtspUrl: "",
    lastMessage: "waiting for ESP32 status",
    lastError: "",
    lastExitCode: null,
    lastExitSignal: null,
    lastStartAt: null,
    lastStopAt: null,
    restartAfter: 0,
    desiredSignature: "",
    commandPreview: "",
    stopTimer: null,
    restartCount: 0,
    lastProgressAt: null,
    lastFrame: 0,
    lastOutputTimeUs: 0,
    progressBuffer: "",
    lastPublishedSignature: "",
    lastPublishedAt: 0,
  };
  bridges.set(cameraId, created);
  return created;
}

function clearStopTimer(bridge) {
  if (bridge.stopTimer) {
    clearTimeout(bridge.stopTimer);
    bridge.stopTimer = null;
  }
}

function stopBridgeProcess(bridge, reason) {
  if (!bridge.process) {
    bridge.state = "idle";
    bridge.lastMessage = reason;
    bridge.pid = null;
    return;
  }

  if (bridge.state === "stopping" && bridge.stopTimer) {
    bridge.lastMessage = reason;
    return;
  }

  clearStopTimer(bridge);
  bridge.state = "stopping";
  bridge.lastMessage = reason;
  bridge.lastStopAt = Date.now();
  console.log(`[ESP32-Bridge:${bridge.cameraId}] stopping: ${reason}`);

  const child = bridge.process;
  try {
    child.kill("SIGINT");
  } catch {
    // Ignore failed signal delivery; exit handler will tidy state.
  }

  bridge.stopTimer = setTimeout(() => {
    if (bridge.process === child) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Ignore failed hard kill.
      }
    }
  }, getStopTimeoutMs());
}

function startBridgeProcess(bridge, camera, sourceRtspUrl, destinationRtspUrl) {
  const ffmpegPath = getFfmpegPath();
  const sourceConfig = parseJson(getCameraTopicValue(camera, "config")) || {};
  const dfr1154Options = camera.kind === "dfr1154"
    ? {
        sourceTransport: process.env.DFR1154_SOURCE_RTSP_TRANSPORT || "tcp",
        analyzeDuration: toNumber(process.env.DFR1154_TRANSCODE_ANALYZEDURATION, 1000000),
        probeSize: toNumber(process.env.DFR1154_TRANSCODE_PROBESIZE, 1000000),
        logLevel: process.env.DFR1154_TRANSCODE_LOGLEVEL || "error",
        codec: process.env.DFR1154_TRANSCODE_CODEC || "libx264",
        preset: process.env.DFR1154_TRANSCODE_PRESET || "superfast",
        profile: process.env.DFR1154_TRANSCODE_PROFILE || "high",
        crf: toNumber(process.env.DFR1154_TRANSCODE_CRF, 17),
      }
    : {};
  const args = getBridgeArgs(sourceRtspUrl, destinationRtspUrl, sourceConfig, dfr1154Options);
  const signature = JSON.stringify({ sourceRtspUrl, destinationRtspUrl, args });

  // Do not let a supervisor tick undo an in-flight stop while ffmpeg exits.
  if (bridge.process && bridge.state === "stopping") {
    if (!bridge.stopTimer) stopBridgeProcess(bridge, bridge.lastMessage || "ffmpeg output ended");
    return;
  }

  if (bridge.process && bridge.desiredSignature === signature) {
    const now = Date.now();
    const hasProgress = Boolean(bridge.lastProgressAt);
    const activityAt = hasProgress ? bridge.lastProgressAt : bridge.lastStartAt;
    const timeoutMs = hasProgress ? getStallTimeoutMs() : getStartupTimeoutMs();
    if (activityAt && now - activityAt > timeoutMs) {
      bridge.lastError = hasProgress ? "ffmpeg progress stalled" : "ffmpeg startup timed out";
      bridge.restartAfter = now + getRestartDelayMs();
      stopBridgeProcess(bridge, bridge.lastError);
      return;
    }
    bridge.state = hasProgress ? "running" : "starting";
    bridge.lastMessage = hasProgress ? "bridge running" : "waiting for first encoded frame";
    return;
  }

  if (bridge.process) {
    stopBridgeProcess(bridge, "restarting bridge with new source settings");
    return;
  }

  if (Date.now() < bridge.restartAfter) {
    bridge.state = "retry_wait";
    bridge.lastMessage = "waiting before restart";
    return;
  }

  bridge.sourceRtspUrl = sourceRtspUrl;
  bridge.destinationRtspUrl = destinationRtspUrl;
  bridge.desiredSignature = signature;
  bridge.commandPreview = [ffmpegPath, ...args].join(" ");
  bridge.lastError = "";
  bridge.restartAfter = 0;
  bridge.state = "starting";
  bridge.lastMessage = `starting bridge for ${camera.label}`;
  console.log(
    `[ESP32-Bridge:${camera.cameraId}] starting ffmpeg: ${sourceRtspUrl} -> ${destinationRtspUrl}`
  );

  const child = spawn(ffmpegPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  bridge.process = child;
  bridge.pid = child.pid || null;
  bridge.lastStartAt = Date.now();
  bridge.lastProgressAt = null;
  bridge.lastFrame = 0;
  bridge.lastOutputTimeUs = 0;
  bridge.progressBuffer = "";
  bridge.restartCount += 1;

  child.stdout.on("data", (chunk) => {
    bridge.progressBuffer += String(chunk);
    const lines = bridge.progressBuffer.split(/\r?\n/);
    bridge.progressBuffer = lines.pop() || "";
    for (const line of lines) {
      const separator = line.indexOf("=");
      if (separator < 1) continue;
      const key = line.slice(0, separator);
      const value = line.slice(separator + 1);
      if (key === "frame") bridge.lastFrame = toNumber(value, bridge.lastFrame);
      if (key === "out_time_us") bridge.lastOutputTimeUs = toNumber(value, bridge.lastOutputTimeUs);
      if (key === "progress") {
        bridge.lastProgressAt = Date.now();
        bridge.state = value === "end" ? "stopping" : "running";
        bridge.lastMessage = value === "end" ? "ffmpeg output ended" : "bridge running";
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) {
      bridge.lastMessage = text.split(/\r?\n/).pop();
      if (/error|failed|unable|invalid|no route/i.test(text)) {
        bridge.lastError = text.split(/\r?\n/).pop();
      }
      console.log(`[ESP32-Bridge:${camera.cameraId}] ${text}`);
    }
  });

  child.on("error", (error) => {
    bridge.lastError = String(error?.message || error);
    bridge.lastMessage = `spawn failed: ${bridge.lastError}`;
    bridge.state = "error";
    bridge.process = null;
    bridge.pid = null;
    bridge.lastExitCode = null;
    bridge.lastExitSignal = null;
    bridge.restartAfter = Date.now() + getRestartDelayMs();
    console.error(`[ESP32-Bridge:${camera.cameraId}] spawn failed: ${bridge.lastError}`);
  });

  child.on("exit", (code, signal) => {
    if (bridge.process !== child) return;
    clearStopTimer(bridge);
    bridge.process = null;
    bridge.pid = null;
    bridge.lastExitCode = code;
    bridge.lastExitSignal = signal;
    bridge.lastStopAt = Date.now();

    const normalStop = code === 0 || signal === "SIGINT" || signal === "SIGKILL";
    if (normalStop) {
      const waitingToRestart = bridge.restartAfter > Date.now();
      bridge.state = waitingToRestart ? "retry_wait" : "idle";
      bridge.lastMessage = waitingToRestart ? "waiting before bridge restart" : "bridge stopped";
      if (!waitingToRestart) bridge.restartAfter = 0;
      console.log(`[ESP32-Bridge:${camera.cameraId}] stopped`);
      return;
    }

    bridge.state = "error";
    bridge.lastMessage = `bridge exited with code=${code ?? "-"} signal=${signal ?? "-"}`;
    bridge.restartAfter = Date.now() + getRestartDelayMs();
    console.warn(`[ESP32-Bridge:${camera.cameraId}] ${bridge.lastMessage}`);
  });
}

function publishBridgeStatus(camera, bridge) {
  const values = {
    state: bridge.state,
    error: bridge.lastError || "",
    message: bridge.lastMessage || "",
    source_url: bridge.sourceRtspUrl || "",
    destination_url: bridge.destinationRtspUrl || "",
    pid: bridge.pid || 0,
    restart_count: bridge.restartCount,
    last_start_at: bridge.lastStartAt ? new Date(bridge.lastStartAt).toISOString() : "",
    last_stop_at: bridge.lastStopAt ? new Date(bridge.lastStopAt).toISOString() : "",
  };
  const signature = JSON.stringify(values);
  if (signature === bridge.lastPublishedSignature && Date.now() - bridge.lastPublishedAt < 30000) return;
  bridge.lastPublishedSignature = signature;
  bridge.lastPublishedAt = Date.now();
  Promise.all(Object.entries(values).map(([key, value]) =>
    publish(`${camera.mqttTopicBase}/status/bridge/${key}`, String(value), { qos: 1, retain: true })
  )).catch((error) => console.error(`[ESP32-Bridge:${camera.cameraId}] MQTT status: ${error.message}`));
}

function evaluateBridge(camera) {
  const bridge = ensureBridge(camera.cameraId);

  if (!getEnabledFlag()) {
    stopBridgeProcess(bridge, "ESP32 transcoding disabled by env");
    return;
  }

  const online = parseBoolean(getCameraTopicValue(camera, "online")) === true;
  const sourceState = getCameraTopicValue(camera, "state");
  const sourceRtspUrl = getSourceRtspUrl(camera);
  const sourceConfig = parseJson(getCameraTopicValue(camera, "config")) || {};
  const streamEnabled = sourceConfig.stream_enabled !== false;

  if (!online) {
    stopBridgeProcess(bridge, "waiting for ESP32 online status");
    return;
  }

  if (["paused", "updating", "recovering", "camera_error", "wifi_down"].includes(sourceState)) {
    stopBridgeProcess(bridge, `ESP32 source state is ${sourceState}`);
    return;
  }

  if (!streamEnabled) {
    stopBridgeProcess(bridge, "ESP32 RTSP stream disabled");
    return;
  }

  if (!sourceRtspUrl) {
    stopBridgeProcess(bridge, "waiting for ESP32 RTSP source URL");
    return;
  }

  startBridgeProcess(bridge, camera, sourceRtspUrl, getBridgeDestinationUrl(camera));
}

function supervisorTick() {
  const cameras = getCameraConfigs("localhost").filter(
    (camera) => camera.kind === "esp32" || camera.kind === "dfr1154"
  );
  const activeCameraIds = new Set(cameras.map((camera) => camera.cameraId));

  for (const camera of cameras) {
    evaluateBridge(camera);
    publishBridgeStatus(camera, ensureBridge(camera.cameraId));
  }

  for (const [cameraId, bridge] of bridges.entries()) {
    if (!activeCameraIds.has(cameraId)) {
      stopBridgeProcess(bridge, "camera removed from configuration");
    }
  }
}

function startEsp32TranscodeSupervisor() {
  if (supervisorTimer) return;
  supervisorTick();
  supervisorTimer = setInterval(supervisorTick, getCheckIntervalMs());
  console.log("[ESP32-Bridge] supervisor started");
}

function getEsp32BridgeSnapshot(cameraId) {
  const bridge = bridges.get(cameraId);
  if (!bridge) return null;

  return {
    cameraId: bridge.cameraId,
    state: bridge.state,
    pid: bridge.pid,
    sourceRtspUrl: bridge.sourceRtspUrl || "",
    destinationRtspUrl: bridge.destinationRtspUrl || "",
    lastMessage: bridge.lastMessage || "",
    lastError: bridge.lastError || "",
    lastExitCode: bridge.lastExitCode,
    lastExitSignal: bridge.lastExitSignal,
    lastStartAt: bridge.lastStartAt ? new Date(bridge.lastStartAt).toISOString() : null,
    lastStopAt: bridge.lastStopAt ? new Date(bridge.lastStopAt).toISOString() : null,
    commandPreview: bridge.commandPreview || "",
    restartCount: bridge.restartCount,
    lastProgressAt: bridge.lastProgressAt ? new Date(bridge.lastProgressAt).toISOString() : null,
    progressAgeSeconds: bridge.lastProgressAt
      ? Math.max(0, Math.floor((Date.now() - bridge.lastProgressAt) / 1000))
      : null,
    encodedFrames: bridge.lastFrame,
    outputTimeUs: bridge.lastOutputTimeUs,
  };
}

module.exports = {
  getEsp32BridgeSnapshot,
  startEsp32TranscodeSupervisor,
};
