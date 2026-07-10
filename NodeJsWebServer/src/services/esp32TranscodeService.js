const { spawn } = require("child_process");

const { getCameraConfigs } = require("../config/cameraConfig");
const { topics } = require("../mqttBroker");

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

function getBridgeArgs(sourceRtspUrl, destinationRtspUrl, sourceConfig = {}) {
  const detectedSourceFps = toNumber(sourceConfig.stream_fps, 0);
  const outputFps = toNumber(process.env.ESP32_TRANSCODE_OUTPUT_FPS, 0) || detectedSourceFps;
  const gopSize = toNumber(process.env.ESP32_TRANSCODE_GOP, 0) || (outputFps > 0 ? outputFps * 2 : 24);
  const crf = toNumber(process.env.ESP32_TRANSCODE_CRF, 23);
  const bitrate = String(process.env.ESP32_TRANSCODE_BITRATE || "").trim();

  const args = [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    process.env.ESP32_TRANSCODE_LOGLEVEL || "warning",
    "-use_wallclock_as_timestamps",
    "1",
    "-fflags",
    "+genpts+nobuffer+discardcorrupt",
    "-flags",
    "low_delay",
    "-analyzeduration",
    "0",
    "-probesize",
    "32768",
    "-rtsp_transport",
    process.env.ESP32_SOURCE_RTSP_TRANSPORT || "tcp",
    "-i",
    sourceRtspUrl,
    "-an",
    "-c:v",
    process.env.ESP32_TRANSCODE_CODEC || "libx264",
    "-preset",
    process.env.ESP32_TRANSCODE_PRESET || "superfast",
    "-tune",
    process.env.ESP32_TRANSCODE_TUNE || "zerolatency",
    "-pix_fmt",
    process.env.ESP32_TRANSCODE_PIXEL_FORMAT || "yuv420p",
    "-profile:v",
    process.env.ESP32_TRANSCODE_PROFILE || "baseline",
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
  const args = getBridgeArgs(sourceRtspUrl, destinationRtspUrl, sourceConfig);
  const signature = JSON.stringify({ sourceRtspUrl, destinationRtspUrl, args });

  if (bridge.process && bridge.desiredSignature === signature) {
    bridge.state = "running";
    bridge.lastMessage = "bridge running";
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

  child.stdout.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) {
      bridge.state = "running";
      bridge.lastMessage = text.split(/\r?\n/).pop();
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) {
      bridge.state = "running";
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
      bridge.state = "idle";
      bridge.lastMessage = "bridge stopped";
      bridge.restartAfter = 0;
      console.log(`[ESP32-Bridge:${camera.cameraId}] stopped`);
      return;
    }

    bridge.state = "error";
    bridge.lastMessage = `bridge exited with code=${code ?? "-"} signal=${signal ?? "-"}`;
    bridge.restartAfter = Date.now() + getRestartDelayMs();
    console.warn(`[ESP32-Bridge:${camera.cameraId}] ${bridge.lastMessage}`);
  });
}

function evaluateBridge(camera) {
  const bridge = ensureBridge(camera.cameraId);

  if (!getEnabledFlag()) {
    stopBridgeProcess(bridge, "ESP32 transcoding disabled by env");
    return;
  }

  const online = parseBoolean(getCameraTopicValue(camera, "online")) === true;
  const sourceRtspUrl = getSourceRtspUrl(camera);
  const sourceConfig = parseJson(getCameraTopicValue(camera, "config")) || {};
  const streamEnabled = sourceConfig.stream_enabled !== false;

  if (!online) {
    stopBridgeProcess(bridge, "waiting for ESP32 online status");
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
  };
}

module.exports = {
  getEsp32BridgeSnapshot,
  startEsp32TranscodeSupervisor,
};
