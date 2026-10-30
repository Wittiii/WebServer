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
    archive: {
      type: "server_capture",
      localDir: process.env.CAMERA_PI_TIMELAPSE_DIR || "",
      envPrefix: "CAMERA_PI",
    },
    capabilities: {
      liveLed: false,
      serverTimelapse: true,
      timelapse: true,
      directRtsp: false,
    },
    controls: {
      profile: "pi",
      fields: [
        { key: "width", label: "Breite", type: "number", min: 16, max: 4096, step: 2, integer: true, multipleOf: 2, placeholder: "1920", section: "Bild und Stream" },
        { key: "height", label: "Hoehe", type: "number", min: 16, max: 4096, step: 2, integer: true, multipleOf: 2, placeholder: "1080" },
        { key: "framerate", label: "FPS", type: "number", min: 1, max: 60, step: 1, integer: true, placeholder: "20" },
        { key: "bitrate", label: "Bitrate", type: "number", min: 10000, max: 50000000, step: 1, integer: true, placeholder: "2500000" },
        { key: "sharpness", label: "Schaerfe", type: "number", min: 0, max: 16, step: 0.1, slider: true, placeholder: "1.0" },
        { key: "brightness", label: "Helligkeit", type: "number", min: -1, max: 1, step: 0.05, slider: true, placeholder: "0.0" },
        { key: "contrast", label: "Kontrast", type: "number", min: 0, max: 32, step: 0.1, slider: true, placeholder: "1.0" },
        { key: "saturation", label: "Saettigung", type: "number", min: 0, max: 32, step: 0.1, slider: true, placeholder: "1.0" },
        { key: "server_capture_interval_seconds", label: "Serveraufnahme Intervall (s)", type: "number", min: 10, max: 86400, step: 1, placeholder: "60", section: "Serveraufnahme" },
        { key: "server_capture_enabled", label: "Serveraufnahme aktiv", type: "checkbox" },
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
    archive: {
      type: "server_capture",
      localDir: process.env.CAMERA_ESP32_TIMELAPSE_DIR || "",
      envPrefix: "CAMERA_ESP32",
    },
    capabilities: {
      liveLed: true,
      serverTimelapse: true,
      timelapse: true,
      directRtsp: true,
    },
    controls: {
      profile: "esp32",
      fields: [
        {
          key: "framesize",
          label: "Aufloesung",
          type: "select",
          section: "Bild und Stream",
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
        { key: "jpeg_quality", label: "JPEG Qualitaet", type: "number", min: 4, max: 63, step: 1, slider: true, placeholder: "10" },
        { key: "stream_fps", label: "RTSP FPS", type: "number", min: 1, max: 25, step: 1, slider: true, placeholder: "10" },
        { key: "brightness", label: "Helligkeit", type: "number", min: -2, max: 2, step: 1, slider: true, placeholder: "1" },
        { key: "contrast", label: "Kontrast", type: "number", min: -2, max: 2, step: 1, slider: true, placeholder: "0" },
        { key: "saturation", label: "Saettigung", type: "number", min: -2, max: 2, step: 1, slider: true, placeholder: "-1" },
        { key: "sharpness", label: "Schaerfe", type: "number", min: -2, max: 2, step: 1, slider: true, placeholder: "0" },
        { key: "hmirror", label: "Horizontal spiegeln", type: "checkbox" },
        { key: "vflip", label: "Vertikal spiegeln", type: "checkbox" },
        { key: "led", label: "Flash LED", type: "checkbox" },
        { key: "stream_enabled", label: "RTSP aktiv", type: "checkbox" },
        { key: "server_capture_interval_seconds", label: "Serveraufnahme Intervall (s)", type: "number", min: 10, max: 86400, step: 1, placeholder: "60", section: "Serveraufnahme" },
        { key: "server_capture_enabled", label: "Serveraufnahme aktiv", type: "checkbox" },
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
      type: "server_capture",
      localDir: process.env.CAMERA_DFR1154_TIMELAPSE_DIR || "",
      envPrefix: "CAMERA_DFR1154",
    },
    capabilities: {
      liveLed: true,
      infrared: true,
      ambientLight: true,
      sdCard: false,
      serverTimelapse: true,
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
          section: "Bild und Stream",
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
        { key: "jpeg_quality", label: "JPEG Qualitaet", type: "number", min: 4, max: 63, step: 1, slider: true, placeholder: "10" },
        { key: "stream_fps", label: "RTSP FPS", type: "number", min: 1, max: 20, step: 1, slider: true, placeholder: "10" },
        { key: "brightness", label: "Helligkeit", type: "number", min: -2, max: 2, step: 1, slider: true, placeholder: "1" },
        { key: "contrast", label: "Kontrast", type: "number", min: -2, max: 2, step: 1, slider: true, placeholder: "0" },
        { key: "saturation", label: "Saettigung", type: "number", min: -2, max: 2, step: 1, slider: true, placeholder: "-2" },
        { key: "sharpness", label: "Schaerfe", type: "number", min: -2, max: 2, step: 1, slider: true, placeholder: "0" },
        { key: "hmirror", label: "Horizontal spiegeln", type: "checkbox" },
        { key: "vflip", label: "Vertikal spiegeln", type: "checkbox" },
        { key: "led", label: "Status LED", type: "checkbox" },
        { key: "stream_enabled", label: "RTSP aktiv", type: "checkbox" },
        {
          key: "gainceiling",
          label: "Maximale Verstaerkung (OV3660)",
          type: "select",
          section: "Sensorautomatik und Bildaufbereitung",
          // These remain MQTT selection indices. DFR firmware maps them to
          // OV3660 register limits; they must not be sent as raw sensor values.
          options: [
            { value: 0, label: "2x" },
            { value: 1, label: "4x" },
            { value: 2, label: "8x" },
            { value: 3, label: "ca. 16x (OV3660-Standard)" },
            { value: 4, label: "32x" },
            { value: 5, label: "ca. 64x (Maximum)" },
          ],
        },
        { key: "awb", label: "Automatischer Weissabgleich", type: "checkbox" },
        { key: "awb_gain", label: "Weissabgleich-Verstaerkung", type: "checkbox" },
        {
          key: "wb_mode",
          label: "Weissabgleich-Modus",
          type: "select",
          options: [
            { value: 0, label: "Automatisch" },
            { value: 1, label: "Sonnig" },
            { value: 2, label: "Wolkig" },
            { value: 3, label: "Buero" },
            { value: 4, label: "Zuhause" },
          ],
        },
        { key: "agc", label: "Automatische Verstaerkung", type: "checkbox" },
        { key: "agc_gain", label: "Manuelle Verstaerkung", type: "number", min: 0, max: 30, step: 1, placeholder: "0" },
        { key: "aec", label: "Automatische Belichtung", type: "checkbox" },
        { key: "aec2", label: "DSP-Belichtungsregelung", type: "checkbox" },
        { key: "ae_level", label: "Belichtungskorrektur", type: "number", min: -2, max: 2, step: 1, placeholder: "0" },
        { key: "aec_value", label: "Manueller Belichtungswert", type: "number", min: 0, max: 1200, step: 1, placeholder: "300" },
        {
          key: "special_effect",
          label: "Bildeffekt",
          type: "select",
          options: [
            { value: 0, label: "Keiner" },
            { value: 1, label: "Negativ" },
            { value: 2, label: "Graustufen" },
            { value: 3, label: "Rotstich" },
            { value: 4, label: "Gruenstich" },
            { value: 5, label: "Blaustich" },
            { value: 6, label: "Sepia" },
          ],
        },
        { key: "colorbar", label: "Farbbalken-Testbild", type: "checkbox" },
        { key: "dcw", label: "Downsize aktiv", type: "checkbox" },
        { key: "bpc", label: "Schwarzpixel-Korrektur", type: "checkbox" },
        { key: "wpc", label: "Weisspixel-Korrektur", type: "checkbox" },
        { key: "raw_gma", label: "Gamma-Korrektur", type: "checkbox" },
        { key: "lenc", label: "Linsenkorrektur", type: "checkbox" },
        {
          key: "ir_mode",
          label: "IR Modus",
          type: "select",
          section: "Infrarot",
          options: [
            { value: 0, label: "Aus" },
            { value: 1, label: "An" },
            { value: 2, label: "Automatisch" },
          ],
        },
        { key: "ir_on_lux", label: "IR an unter Lux", type: "number", min: 0, max: 100000, step: 1, placeholder: "5" },
        { key: "ir_off_lux", label: "IR aus ueber Lux", type: "number", min: 1, max: 100000, step: 1, placeholder: "10" },
        { key: "server_capture_interval_seconds", label: "Serveraufnahme Intervall (s)", type: "number", min: 10, max: 86400, step: 1, placeholder: "60", section: "Serveraufnahme" },
        { key: "server_capture_enabled", label: "Serveraufnahme aktiv", type: "checkbox" },
      ],
    },
  };
}

function createEsp32P4CameraConfig(hostname, mediaConfig) {
  const cameraId = process.env.CAMERA_ESP32_P4_ID || "esp32-p4-cam-01";
  const mqttTopicBase = trimSlashes(
    process.env.CAMERA_ESP32_P4_TOPIC_BASE || `camera/${cameraId}`,
    { trailing: true }
  );
  const mqttClientId = process.env.CAMERA_ESP32_P4_MQTT_CLIENT_ID || cameraId;
  const streamPath = trimSlashes(process.env.CAMERA_ESP32_P4_STREAM_PATH || cameraId);

  return {
    cameraId,
    label: process.env.CAMERA_ESP32_P4_LABEL || "ESP32-P4 Kamera",
    kind: "esp32-p4",
    mqttClientId,
    mqttTopicBase,
    streamPath,
    mediaHost: mediaConfig.mediaHost || hostname,
    mediaMTX: mediaConfig,
    urls: buildUrls({ ...mediaConfig, streamPath }),
    archive: {
      type: "server_capture",
      localDir: process.env.CAMERA_ESP32_P4_TIMELAPSE_DIR || "",
      envPrefix: "CAMERA_ESP32_P4",
    },
    capabilities: {
      h264: true,
      directRtsp: true,
      requiresTranscode: false,
      serverTimelapse: true,
      timelapse: true,
      network: "wifi6-via-esp32-c6",
    },
    // The P4 acknowledges every command on status/command/<request-id>.
    requiresCommandAck: true,
    controls: {
      profile: "esp32-p4",
      imageFields: [
        {
          key: "preset",
          label: "Bildprofil (Preset)",
          type: "select",
          integer: true,
          group: "Bild & Farbabstimmung",
          options: [
            { value: 0, label: "Benutzerdefiniert" },
            { value: 1, label: "OV5647 Standard (Pi-Abgleich als Annaeherung)" },
            { value: 2, label: "Natuerlich / Sanft" },
            { value: 3, label: "Kraeftig & Klar (Vivid)" },
            { value: 4, label: "Schwachlicht (Wenig Rauschen)" },
          ],
        },
        { key: "brightness", label: "Helligkeit", type: "number", integer: true, slider: true, group: "Bild & Farbabstimmung" },
        { key: "contrast", label: "Kontrast", type: "number", integer: true, slider: true, group: "Bild & Farbabstimmung" },
        { key: "saturation", label: "Saettigung", type: "number", integer: true, slider: true, group: "Bild & Farbabstimmung" },
        { key: "hue", label: "Farbton", type: "number", integer: true, slider: true, group: "Bild & Farbabstimmung" },
        { key: "gamma", label: "Gamma / Tonwertkurve", type: "number", integer: true, slider: true, group: "Bild & Farbabstimmung" },
        { key: "sharpness", label: "Kantenschaerfe (ISP)", type: "number", integer: true, slider: true, group: "Bild & Farbabstimmung" },
        { key: "denoise", label: "Entrauschung (Bayer-Filter)", type: "number", integer: true, slider: true, group: "Bild & Farbabstimmung" },
        { key: "exposure_target", label: "Belichtungsziel (Automatik)", type: "number", integer: true, slider: true, group: "Bild & Farbabstimmung" },
        { key: "awb", label: "Auto-Weissabgleich (AWB)", type: "checkbox", group: "Weissabgleich & Ausrichtung" },
        { key: "red_balance", label: "Rot-Balance (1000 = 1.0x)", type: "number", integer: true, slider: true, group: "Weissabgleich & Ausrichtung" },
        { key: "blue_balance", label: "Blau-Balance (1000 = 1.0x)", type: "number", integer: true, slider: true, group: "Weissabgleich & Ausrichtung" },
        { key: "hflip", label: "Horizontal spiegeln", type: "checkbox", group: "Weissabgleich & Ausrichtung" },
        { key: "vflip", label: "Vertikal spiegeln", type: "checkbox", group: "Weissabgleich & Ausrichtung" },
        {
          key: "resolution",
          label: "Aufloesung / Sensormodus",
          type: "select",
          integer: true,
          group: "Livestream",
          options: [
            { value: 0, label: "1920x1080 (Full-HD 16:9)" },
            { value: 1, label: "1280x960 (Weitwinkel 2x2-Binning)" },
            { value: 2, label: "800x640 (Kompakt / Sparsam)" },
          ],
        },
        { key: "fps", label: "FPS", type: "number", integer: true, slider: true, group: "Livestream" },
        { key: "bitrate_bps", label: "Bitrate (bit/s)", type: "number", integer: true, group: "Livestream" },
        { key: "gop", label: "Keyframe-Abstand (Frames)", type: "number", integer: true, slider: true, group: "Livestream" },
        { key: "server_capture_enabled", label: "Zeitrafferaufnahme aktiv", type: "checkbox", group: "Zeitraffer" },
        { key: "server_capture_interval_seconds", label: "Aufnahmeintervall (Sekunden)", type: "number", integer: true, group: "Zeitraffer" },
      ],
      fields: [],
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
    createEsp32P4CameraConfig(hostname, mediaConfig),
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
