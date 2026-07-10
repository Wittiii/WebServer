function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function trimSlashes(value, { leading = true, trailing = true } = {}) {
  let current = String(value ?? "");
  if (leading) {
    current = current.replace(/^\/+/, "");
  }
  if (trailing) {
    current = current.replace(/\/+$/, "");
  }
  return current;
}

function buildUrls({ mediaHost, webrtcPort, hlsPort, rtspPort, apiPort, apiEnabled, streamPath }) {
  return {
    webrtcPage: `http://${mediaHost}:${webrtcPort}/${streamPath}`,
    hlsPage: `http://${mediaHost}:${hlsPort}/${streamPath}`,
    hlsPlaylist: `http://${mediaHost}:${hlsPort}/${streamPath}/index.m3u8`,
    rtsp: `rtsp://${mediaHost}:${rtspPort}/${streamPath}`,
    apiBase: apiEnabled ? `http://${mediaHost}:${apiPort}` : null,
  };
}

function createPiCameraConfig(hostname, mediaConfig) {
  const cameraId = process.env.CAMERA_PI_ID || process.env.CAMERA_ID || "pi-zero-01";
  const mqttTopicBase = trimSlashes(
    process.env.CAMERA_PI_TOPIC_BASE || process.env.CAMERA_TOPIC_BASE || `camera/${cameraId}`,
    { trailing: true }
  );
  const mqttClientId =
    process.env.CAMERA_PI_MQTT_CLIENT_ID || process.env.CAMERA_MQTT_CLIENT_ID || cameraId;
  const streamPath = trimSlashes(process.env.CAMERA_PI_STREAM_PATH || process.env.CAMERA_STREAM_PATH || cameraId);

  return {
    cameraId,
    label: process.env.CAMERA_PI_LABEL || "Raspberry Pi Kamera",
    kind: "pi",
    mqttClientId,
    mqttTopicBase,
    streamPath,
    mediaHost: mediaConfig.mediaHost || hostname,
    mediaMTX: mediaConfig,
    urls: buildUrls({ ...mediaConfig, streamPath }),
    capabilities: {
      liveLed: false,
      timelapse: true,
      directRtsp: false,
    },
    controls: {
      profile: "pi",
      fields: [
        { key: "width", label: "Breite", type: "number", min: 160, step: 1, placeholder: "1920" },
        { key: "height", label: "Hoehe", type: "number", min: 120, step: 1, placeholder: "1080" },
        { key: "framerate", label: "FPS", type: "number", min: 1, step: 1, placeholder: "20" },
        { key: "bitrate", label: "Bitrate", type: "number", min: 100000, step: 100000, placeholder: "2500000" },
        { key: "sharpness", label: "Schaerfe", type: "number", step: 0.1, placeholder: "1.0" },
        { key: "brightness", label: "Helligkeit", type: "number", step: 0.05, placeholder: "0.0" },
        { key: "contrast", label: "Kontrast", type: "number", step: 0.1, placeholder: "1.0" },
        { key: "saturation", label: "Saettigung", type: "number", step: 0.1, placeholder: "1.0" },
      ],
    },
  };
}

function createEsp32CameraConfig(hostname, mediaConfig) {
  const cameraId = process.env.CAMERA_ESP32_ID || "esp32-cam-01";
  const mqttTopicBase = trimSlashes(
    process.env.CAMERA_ESP32_TOPIC_BASE || `camera/${cameraId}`,
    { trailing: true }
  );
  const mqttClientId = process.env.CAMERA_ESP32_MQTT_CLIENT_ID || cameraId;
  const streamPath = trimSlashes(process.env.CAMERA_ESP32_STREAM_PATH || cameraId);

  return {
    cameraId,
    label: process.env.CAMERA_ESP32_LABEL || "ESP32-CAM",
    kind: "esp32",
    mqttClientId,
    mqttTopicBase,
    streamPath,
    mediaHost: mediaConfig.mediaHost || hostname,
    mediaMTX: mediaConfig,
    urls: buildUrls({ ...mediaConfig, streamPath }),
    capabilities: {
      liveLed: true,
      timelapse: false,
      directRtsp: true,
    },
    controls: {
      profile: "esp32",
      fields: [
        {
          key: "framesize",
          label: "Aufloesung",
          type: "select",
          options: [
            { value: 0, label: "QVGA" },
            { value: 1, label: "VGA" },
            { value: 2, label: "SVGA" },
            { value: 3, label: "XGA" },
            { value: 4, label: "HD" },
            { value: 5, label: "SXGA" },
            { value: 6, label: "UXGA" },
          ],
        },
        { key: "jpeg_quality", label: "JPEG Qualitaet", type: "number", min: 4, max: 63, step: 1, placeholder: "10" },
        { key: "stream_fps", label: "RTSP FPS", type: "number", min: 1, max: 25, step: 1, placeholder: "10" },
        { key: "brightness", label: "Helligkeit", type: "number", min: -2, max: 2, step: 1, placeholder: "1" },
        { key: "contrast", label: "Kontrast", type: "number", min: -2, max: 2, step: 1, placeholder: "0" },
        { key: "saturation", label: "Saettigung", type: "number", min: -2, max: 2, step: 1, placeholder: "-1" },
        { key: "sharpness", label: "Schaerfe", type: "number", min: -2, max: 2, step: 1, placeholder: "0" },
        { key: "hmirror", label: "Horizontal spiegeln", type: "checkbox" },
        { key: "vflip", label: "Vertikal spiegeln", type: "checkbox" },
        { key: "led", label: "Flash LED", type: "checkbox" },
        { key: "stream_enabled", label: "RTSP aktiv", type: "checkbox" },
      ],
    },
  };
}

function createDfr1154CameraConfig(hostname, mediaConfig) {
  const cameraId = process.env.CAMERA_DFR1154_ID || "dfr1154-cam-01";
  const mqttTopicBase = trimSlashes(
    process.env.CAMERA_DFR1154_TOPIC_BASE || `camera/${cameraId}`,
    { trailing: true }
  );
  const mqttClientId = process.env.CAMERA_DFR1154_MQTT_CLIENT_ID || cameraId;
  const streamPath = trimSlashes(process.env.CAMERA_DFR1154_STREAM_PATH || cameraId);

  return {
    cameraId,
    label: process.env.CAMERA_DFR1154_LABEL || "DFRobot DFR1154",
    kind: "dfr1154",
    mqttClientId,
    mqttTopicBase,
    streamPath,
    mediaHost: mediaConfig.mediaHost || hostname,
    mediaMTX: mediaConfig,
    urls: buildUrls({ ...mediaConfig, streamPath }),
    archive: {
      type: "remote_http",
      baseUrl: String(process.env.CAMERA_DFR1154_ARCHIVE_URL || "").replace(/\/+$/, ""),
      port: toNumber(process.env.CAMERA_DFR1154_ARCHIVE_PORT, 8080),
      token: process.env.CAMERA_DFR1154_ARCHIVE_TOKEN || "1234",
      localDir: process.env.CAMERA_DFR1154_TIMELAPSE_DIR || "",
    },
    capabilities: {
      liveLed: true,
      infrared: true,
      ambientLight: true,
      sdCard: true,
      timelapse: true,
      directRtsp: true,
    },
    controls: {
      profile: "dfr1154",
      fields: [
        {
          key: "framesize",
          label: "Aufloesung",
          type: "select",
          options: [
            { value: 0, label: "QVGA" },
            { value: 1, label: "VGA" },
            { value: 2, label: "SVGA" },
            { value: 3, label: "XGA" },
            { value: 4, label: "HD" },
            { value: 5, label: "SXGA" },
            { value: 6, label: "UXGA" },
            { value: 7, label: "QXGA" },
          ],
        },
        { key: "jpeg_quality", label: "JPEG Qualitaet", type: "number", min: 4, max: 63, step: 1, placeholder: "10" },
        { key: "stream_fps", label: "RTSP FPS", type: "number", min: 1, max: 20, step: 1, placeholder: "10" },
        { key: "brightness", label: "Helligkeit", type: "number", min: -2, max: 2, step: 1, placeholder: "1" },
        { key: "contrast", label: "Kontrast", type: "number", min: -2, max: 2, step: 1, placeholder: "0" },
        { key: "saturation", label: "Saettigung", type: "number", min: -2, max: 2, step: 1, placeholder: "-2" },
        { key: "sharpness", label: "Schaerfe", type: "number", min: -2, max: 2, step: 1, placeholder: "0" },
        {
          key: "ir_mode",
          label: "IR Modus",
          type: "select",
          options: [
            { value: 0, label: "Aus" },
            { value: 1, label: "An" },
            { value: 2, label: "Automatisch" },
          ],
        },
        { key: "ir_on_lux", label: "IR an unter Lux", type: "number", min: 0, max: 100000, step: 1, placeholder: "5" },
        { key: "ir_off_lux", label: "IR aus ueber Lux", type: "number", min: 1, max: 100000, step: 1, placeholder: "10" },
        { key: "timelapse_interval_seconds", label: "Zeitraffer Intervall (s)", type: "number", min: 5, max: 86400, step: 1, placeholder: "60" },
        { key: "timelapse_limit_gb", label: "Zeitraffer Limit (GB)", type: "number", min: 1, max: 30, step: 1, placeholder: "22" },
        { key: "hmirror", label: "Horizontal spiegeln", type: "checkbox" },
        { key: "vflip", label: "Vertikal spiegeln", type: "checkbox" },
        { key: "led", label: "Status LED", type: "checkbox" },
        { key: "stream_enabled", label: "RTSP aktiv", type: "checkbox" },
        { key: "timelapse_enabled", label: "Zeitraffer aktiv", type: "checkbox" },
      ],
    },
  };
}

function getMediaConfig(hostname = "localhost") {
  const mediaHost = process.env.MEDIA_MTX_PUBLIC_HOST || hostname;
  const webrtcPort = toNumber(process.env.MEDIA_MTX_WEBRTC_PORT, 8889);
  const hlsPort = toNumber(process.env.MEDIA_MTX_HLS_PORT, 8888);
  const rtspPort = toNumber(process.env.MEDIA_MTX_RTSP_PORT, 8554);
  const apiPort = toNumber(process.env.MEDIA_MTX_API_PORT, 9997);
  const apiEnabled = String(process.env.MEDIA_MTX_API_ENABLED || "").toLowerCase() === "true";

  return {
    mediaHost,
    webrtcPort,
    hlsPort,
    rtspPort,
    apiPort,
    apiEnabled,
  };
}

function getCameraConfigs(hostname = "localhost") {
  const mediaConfig = getMediaConfig(hostname);
  return [
    createPiCameraConfig(hostname, mediaConfig),
    createEsp32CameraConfig(hostname, mediaConfig),
    createDfr1154CameraConfig(hostname, mediaConfig),
  ];
}

function getCameraConfigById(cameraId, hostname = "localhost") {
  const cameras = getCameraConfigs(hostname);
  return cameras.find((camera) => camera.cameraId === cameraId) || null;
}

module.exports = {
  getCameraConfigs,
  getCameraConfigById,
};
