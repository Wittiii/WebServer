import {
  buildTimelapse,
  deleteTimelapse,
  fetchCameraOverview,
  fetchCameraSnapshot,
  fetchTimelapse,
  postCameraCommand,
} from "./camera-api.js";
import {
  escapeHtml,
  formatBytes,
  formatTimestamp,
  normalizeFieldValue,
  setStatusLine,
} from "./camera-utils.js";

const summaryEl = document.getElementById("camera-summary");
const pickerEl = document.getElementById("camera-picker");
const stateCardEl = document.getElementById("camera-state-card");
const topicLogEl = document.getElementById("camera-topic-log");
const targetsEl = document.getElementById("camera-targets");
const commandStatusEl = document.getElementById("camera-command-status");
const settingsStatusEl = document.getElementById("camera-settings-status");
const settingsForm = document.getElementById("camera-settings-form");
const liveApplyCheckboxEl = document.getElementById("camera-live-apply");
const resetDefaultsBtnEl = document.getElementById("camera-reset-defaults");
const streamFrame = document.getElementById("camera-stream-frame");
const streamHintEl = document.getElementById("camera-stream-hint");
const openWebRtcEl = document.getElementById("camera-open-webrtc");
const openHlsEl = document.getElementById("camera-open-hls");
const openRtspEl = document.getElementById("camera-open-rtsp");
const activeTitleEl = document.getElementById("camera-active-title");
const activeSubtitleEl = document.getElementById("camera-active-subtitle");
const heroCountEl = document.getElementById("camera-hero-count");
const heroOnlineEl = document.getElementById("camera-hero-online");
const heroStreamingEl = document.getElementById("camera-hero-streaming");
const snapshotCaptureEl = document.getElementById("camera-snapshot-capture");
const snapshotPinEl = document.getElementById("camera-snapshot-pin");
const snapshotDownloadEl = document.getElementById("camera-snapshot-download");
const snapshotClearEl = document.getElementById("camera-snapshot-clear");
const snapshotStatusEl = document.getElementById("camera-snapshot-status");
const snapshotCompareEl = document.getElementById("camera-snapshot-compare");
const snapshotBeforeCardEl = document.getElementById("camera-snapshot-before-card");
const snapshotBeforeImgEl = document.getElementById("camera-snapshot-before-img");
const snapshotBeforeMetaEl = document.getElementById("camera-snapshot-before-meta");
const snapshotCurrentImgEl = document.getElementById("camera-snapshot-current-img");
const snapshotCurrentMetaEl = document.getElementById("camera-snapshot-current-meta");
const timelapsePanelEl = document.getElementById("timelapse-panel");
const timelapseToggleEl = document.getElementById("timelapse-toggle");
const timelapseRefreshEl = document.getElementById("timelapse-refresh");
const timelapseBuildEl = document.getElementById("timelapse-build");
const timelapseDeleteVideoEl = document.getElementById("timelapse-delete-video");
const timelapseDeleteImagesEl = document.getElementById("timelapse-delete-images");
const timelapseSummaryEl = document.getElementById("timelapse-summary");
const timelapseStatusEl = document.getElementById("camera-timelapse-status") || document.getElementById("timelapse-status");
const timelapseFileListEl = document.getElementById("timelapse-file-list");
const timelapseVideoEl = document.getElementById("timelapse-video");
const timelapseVideoHintEl = document.getElementById("timelapse-video-hint");

let overviewState = null;
let activeCameraId = null;
let settingsDraftState = { cameraId: null, dirty: false, values: {}, touched: new Set() };
const settingsDrafts = new Map();
let cameraOperationInFlight = false;
let archiveRequestVersion = 0;
const overviewStatusEl = document.getElementById("camera-overview-status");
const overviewRefreshEl = document.getElementById("camera-overview-refresh");
const pendingCameraSettings = new Map();
const CAMERA_CONFIG_PENDING_MS = 30000;
let settingsFeedbackState = { cameraId: null, text: "", isError: false, expiresAt: 0 };
let timelapseState = null;
let timelapseRefreshInFlight = false;
let overviewRefreshInFlight = false;
const TIMELAPSE_COLLAPSED_STORAGE_KEY = "camera-timelapse-collapsed";
const LIVE_APPLY_STORAGE_KEY = "camera-live-apply";
const STREAM_RECONNECT_KEYS = new Set(["fps", "bitrate_bps", "gop", "width", "height", "framerate", "bitrate", "framesize"]);

let timelapseCollapsed = true;
try { timelapseCollapsed = localStorage.getItem(TIMELAPSE_COLLAPSED_STORAGE_KEY) !== "false"; } catch {}

let liveApplyEnabled = true;
try {
  const savedLive = localStorage.getItem(LIVE_APPLY_STORAGE_KEY);
  if (savedLive !== null) liveApplyEnabled = savedLive === "true";
} catch {}
if (liveApplyCheckboxEl) liveApplyCheckboxEl.checked = liveApplyEnabled;

let liveApplyTimer = null;
let liveApplyInFlight = false;
let liveApplyQueued = false;
let snapshotInFlight = false;
const cameraSnapshots = new Map(); // cameraId -> { current: { url, meta, filename } | null, before: { url, meta } | null }

function bindCameraAction(element, eventName, handler) {
  element?.addEventListener(eventName, async (event) => {
    if (eventName === "submit") event.preventDefault();
    if (cameraOperationInFlight) return;
    cameraOperationInFlight = true;
    const controls = [...document.querySelectorAll(".camera-picker button, [data-camera-action], #camera-reset-defaults, #camera-settings-form input, #camera-settings-form select, #camera-settings-form button, #timelapse-panel button, #camera-overview-refresh")];
    const previous = controls.map((control) => [control, control.disabled]);
    controls.forEach((control) => { control.disabled = true; });
    element.setAttribute("aria-busy", "true");
    try {
      await handler(event);
    } finally {
      previous.forEach(([control, disabled]) => { if (control.isConnected) control.disabled = disabled; });
      element.setAttribute("aria-busy", "false");
      cameraOperationInFlight = false;
      if (overviewRefreshEl) overviewRefreshEl.disabled = overviewRefreshInFlight;
      renderPicker();
      syncActionButtons(getActiveCamera());
    }
  });
}

function getCameras() {
  return overviewState?.cameras || [];
}

function getActiveCamera() {
  const cameras = getCameras();
  if (!cameras.length) return null;
  return cameras.find((camera) => camera.cameraId === activeCameraId) || cameras[0];
}

function getFieldByKey(camera, key) {
  return (camera?.controls?.fields || []).find((field) => field.key === key) || null;
}

function getReportedFieldValue(camera, field) {
  const config = camera?.stream?.currentConfig || {};
  if (Object.prototype.hasOwnProperty.call(config, field.key)) {
    return config[field.key];
  }

  if (field.type === "select" && Array.isArray(field.options)) {
    const namedValue = config[`${field.key}_name`];
    if (namedValue != null) {
      const option = field.options.find(
        (entry) => String(entry.label).trim().toLowerCase() === String(namedValue).trim().toLowerCase()
      );
      if (option) return option.value;
    }
  }

  return "";
}

function resetSettingsDraft(cameraId = null) {
  settingsDrafts.delete(cameraId);
  settingsDraftState = { cameraId, dirty: false, values: {}, touched: new Set() };
}

function captureSettingsDraft(target = null) {
  const camera = getActiveCamera();
  if (!settingsForm || !camera) return;

  const touched = settingsDraftState.cameraId === camera.cameraId
    ? new Set(settingsDraftState.touched || [])
    : new Set();
  if (target?.name) touched.add(target.name);

  const values = {};
  for (const field of camera.controls?.fields || []) {
    const input = settingsForm.elements.namedItem(field.key);
    if (!input) continue;
    values[field.key] = field.type === "checkbox" ? Boolean(input.checked) : input.value;
  }

  settingsDraftState = {
    cameraId: camera.cameraId,
    dirty: touched.size > 0,
    values,
    touched,
  };
  if (touched.size > 0) {
    settingsDrafts.set(camera.cameraId, settingsDraftState);
  } else {
    settingsDrafts.delete(camera.cameraId);
  }
  if (settingsFeedbackState.cameraId === camera.cameraId && settingsFeedbackState.isError) {
    setSettingsFeedback(camera.cameraId, "");
  }
  syncSettingsStatus(camera);
  const pickerButton = [...(pickerEl?.querySelectorAll("[data-camera-id]") || [])].find(
    (button) => button.dataset.cameraId === camera.cameraId
  );
  if (pickerButton && touched.size > 0 && !pickerButton.querySelector("small")) {
    const badge = document.createElement("small");
    badge.textContent = "Entwurf";
    pickerButton.append(badge);
  }
}

function setPendingCameraSettings(cameraId, settings, requestId = null, expandsRelated = false) {
  if (!cameraId || !settings || typeof settings !== "object") return;
  pendingCameraSettings.set(cameraId, {
    settings: { ...settings },
    requestId,
    expandsRelated,
    requestedAt: Date.now(),
  });
}

function setSettingsFeedback(cameraId, text, isError = false, durationMs = 8000) {
  settingsFeedbackState = {
    cameraId: cameraId || null,
    text: text || "",
    isError: Boolean(isError),
    expiresAt: durationMs > 0 ? Date.now() + durationMs : 0,
  };
}

function cameraConfigMatchesPending(camera, pendingEntry) {
  if (!camera || !pendingEntry?.settings) return true;

  return Object.entries(pendingEntry.settings).every(([key, expectedValue]) => {
    const field = getFieldByKey(camera, key) || { key, type: typeof expectedValue === "boolean" ? "checkbox" : "number" };
    const actualValue = getReportedFieldValue(camera, field);
    return normalizeFieldValue(actualValue, field) === normalizeFieldValue(expectedValue, field);
  });
}

function applyPendingSettingsToCamera(camera) {
  const pendingEntry = pendingCameraSettings.get(camera?.cameraId);
  if (!pendingEntry) return camera;

  const expired = Date.now() - pendingEntry.requestedAt > CAMERA_CONFIG_PENDING_MS;
  if (expired) {
    pendingCameraSettings.delete(camera.cameraId);
    setSettingsFeedback(camera.cameraId, "Rueckmeldung der Kamera steht noch aus.", true, 10000);
    return camera;
  }

  const command = camera.status?.lastCommand;
  if (
    pendingEntry.requestId &&
    command?.id === pendingEntry.requestId &&
    ["error", "partial"].includes(command.result)
  ) {
    pendingCameraSettings.delete(camera.cameraId);
    setSettingsFeedback(
      camera.cameraId,
      command.message || "Mindestens eine Einstellung wurde von der Kamera abgelehnt.",
      true,
      12000
    );
    return camera;
  }

  const commandAccepted = !camera.requiresCommandAck || (
    pendingEntry.requestId && command?.id === pendingEntry.requestId && command.result === "ok"
  );
  if (commandAccepted && cameraConfigMatchesPending(camera, pendingEntry)) {
    const shouldRefreshSliders = Boolean(pendingEntry.expandsRelated);
    pendingCameraSettings.delete(camera.cameraId);
    setSettingsFeedback(camera.cameraId, "Einstellungen uebernommen.", false, 6000);
    if (shouldRefreshSliders && camera.cameraId === activeCameraId && !settingsDraftState.dirty) {
      queueMicrotask(() => renderSettingsForm(getActiveCamera(), { force: true }));
    }
    return camera;
  }

  return {
    ...camera,
    stream: {
      ...camera.stream,
      currentConfig: {
        ...(camera.stream?.currentConfig || {}),
        ...pendingEntry.settings,
      },
    },
  };
}

function applyPendingSettingsToOverview(overview) {
  if (!overview || !Array.isArray(overview.cameras)) return overview;

  return {
    ...overview,
    cameras: overview.cameras.map((camera) => applyPendingSettingsToCamera({
      ...camera,
      mqtt: { ...(camera.mqtt || {}) },
      stream: {
        ...(camera.stream || {}),
        urls: { ...(camera.stream?.urls || {}) },
        currentConfig: { ...(camera.stream?.currentConfig || {}) },
      },
      status: {
        ...(camera.status || {}),
        recentTopics: Array.isArray(camera.status?.recentTopics) ? camera.status.recentTopics.slice() : [],
      },
    })),
  };
}

function setOverviewState(nextOverview) {
  overviewState = applyPendingSettingsToOverview(nextOverview);
}

function syncSettingsStatus(camera) {
  if (!settingsStatusEl) return;
  if (!camera) {
    setStatusLine(settingsStatusEl, "");
    return;
  }

  const pendingEntry = pendingCameraSettings.get(camera.cameraId);
  if (pendingEntry) {
    setStatusLine(settingsStatusEl, `${camera.label} Einstellungen gesendet. Warte auf Rueckmeldung...`);
    return;
  }

  if (
    settingsFeedbackState.cameraId === camera.cameraId &&
    settingsFeedbackState.text &&
    (settingsFeedbackState.expiresAt === 0 || settingsFeedbackState.expiresAt > Date.now())
  ) {
    setStatusLine(settingsStatusEl, settingsFeedbackState.text, settingsFeedbackState.isError);
    return;
  }

  if (settingsFeedbackState.expiresAt && settingsFeedbackState.expiresAt <= Date.now()) {
    settingsFeedbackState = { cameraId: null, text: "", isError: false, expiresAt: 0 };
  }

  if (settingsDraftState.cameraId === camera.cameraId && settingsDraftState.dirty) {
    setStatusLine(
      settingsStatusEl,
      liveApplyEnabled
        ? "Live-Änderung vorgemerkt …"
        : "Ungesendete Änderungen. Der Entwurf bleibt beim Kamerawechsel erhalten, bis du diese Seite verlässt."
    );
    return;
  }

  setStatusLine(settingsStatusEl, "");
}

function getStateColor(camera) {
  const state = camera?.status?.state || "unknown";
  if (camera?.status?.online === true && (state === "streaming" || state === "running" || state === "ready")) {
    return "#10b981";
  }
  if (state === "paused" || state === "wifi_down") {
    return "#f59e0b";
  }
  return "#f87171";
}

function isJpegCamera(camera) {
  return camera?.kind === "esp32" || camera?.kind === "dfr1154";
}

function getCapabilityBadges(camera) {
  const badges = [];
  if (camera.capabilities.h264) badges.push("H.264");
  if (camera.capabilities.liveLed) badges.push("LED");
  if (camera.capabilities.infrared) badges.push("IR Auto");
  if (camera.capabilities.sdCard) badges.push("SD");
  if (camera.capabilities.timelapse) badges.push("Zeitraffer");
  if (camera.capabilities.directRtsp) badges.push("Direkt RTSP");
  return badges;
}

function syncActionButtons(camera) {
  const isP4 = camera?.kind === "esp32-p4";
  if (resetDefaultsBtnEl) {
    resetDefaultsBtnEl.hidden = !isP4;
    resetDefaultsBtnEl.disabled = cameraOperationInFlight || !camera?.mqtt?.connected;
  }
  const pingBtn = document.querySelector('[data-camera-action="ping"]');
  if (pingBtn) {
    pingBtn.hidden = isP4;
  }
}

function renderHeroSummary() {
  if (!overviewState) return;
  if (heroCountEl) heroCountEl.textContent = `${overviewState.summary.total} Kameraquellen`;
  if (heroOnlineEl) heroOnlineEl.textContent = `${overviewState.summary.online} online`;
  if (heroStreamingEl) heroStreamingEl.textContent = `${overviewState.summary.streaming} aktiv`;
}

function renderSummaryCards() {
  if (!summaryEl) return;
  const cameras = getCameras();
  summaryEl.innerHTML = cameras
    .map((camera) => {
      const isActive = camera.cameraId === getActiveCamera()?.cameraId;
      const badges = getCapabilityBadges(camera)
        .map((badge) => `<span class="camera-capability-badge">${escapeHtml(badge)}</span>`)
        .join("");

      return `
        <article class="stats-card camera-source-card ${isActive ? "camera-source-active" : ""}">
          <div class="camera-source-top">
            <div>
              <h3>${escapeHtml(camera.label)}</h3>
              <div class="stats-val" style="color:${getStateColor(camera)};">${escapeHtml((camera.status.state || "unknown").toUpperCase())}</div>
            </div>
            <span class="status-badge ${camera.status.online ? "status-online" : "status-offline"}">
              ${camera.status.online ? "ONLINE" : "OFFLINE"}
            </span>
          </div>
          <p>ID: ${escapeHtml(camera.cameraId)}</p>
          <p>Topic: ${escapeHtml(camera.mqtt.topicBase)}</p>
          <div class="camera-capability-row">${badges || '<span class="camera-capability-badge">Standard</span>'}</div>
        </article>
      `;
    })
    .join("");
}

function renderPicker() {
  if (!pickerEl) return;
  const cameras = getCameras();
  pickerEl.innerHTML = cameras
    .map(
      (camera) => `
        <button
          type="button"
          class="btn btn-secondary camera-picker-btn ${camera.cameraId === getActiveCamera()?.cameraId ? "camera-picker-active" : ""}"
          data-camera-id="${escapeHtml(camera.cameraId)}"
          aria-pressed="${camera.cameraId === getActiveCamera()?.cameraId}"
          ${cameraOperationInFlight ? "disabled" : ""}
        >
          ${escapeHtml(camera.label)}
          ${settingsDrafts.has(camera.cameraId) ? "<small>Entwurf</small>" : ""}
        </button>
      `
    )
    .join("");

  pickerEl.querySelectorAll("[data-camera-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (cameraOperationInFlight || activeCameraId === button.dataset.cameraId) return;
      archiveRequestVersion += 1;
      activeCameraId = button.dataset.cameraId;
      settingsDraftState = settingsDrafts.get(activeCameraId) || { cameraId: activeCameraId, dirty: false, values: {}, touched: new Set() };
      if (timelapseState?.cameraId !== activeCameraId) timelapseState = null;
      setStatusLine(snapshotStatusEl, "");
      renderActiveCamera({ forceSettings: true });

      const selectedCamera = getActiveCamera();
      if (!timelapseCollapsed && selectedCamera?.capabilities?.timelapse) {
        try {
          setStatusLine(timelapseStatusEl, `Lade Zeitraffer fuer ${selectedCamera.label}...`);
          await loadTimelapse(selectedCamera.cameraId);
          if (activeCameraId !== selectedCamera.cameraId) return;
          renderTimelapseSection(selectedCamera);
          setStatusLine(timelapseStatusEl, "Zeitrafferdaten geladen.");
        } catch (error) {
          if (activeCameraId !== selectedCamera.cameraId) return;
          setStatusLine(timelapseStatusEl, `Zeitraffer konnte nicht geladen werden: ${error.message}`, true);
        }
      }
    });
  });
}

function renderState(camera) {
  if (!stateCardEl || !camera) return;

  const config = camera.stream.currentConfig || {};
  const bridge = camera.bridge || null;
  const stateBadge =
    camera.status.online === true && (camera.status.state === "streaming" || camera.status.state === "running" || camera.status.state === "ready")
      ? "status-online"
      : "status-offline";

  const codecMode = config.mode || (config.codec
    ? `${String(config.codec).toUpperCase()}${config.profile ? ` (${config.profile})` : ""}`
    : "-");

  const primaryConfigRows =
    camera.kind === "dfr1154"
      ? `
        <div><strong>Aufloesung</strong><span>${escapeHtml(config.framesize_name || "-")}</span></div>
        <div><strong>JPEG</strong><span>${escapeHtml(config.jpeg_quality ?? "-")}</span></div>
        <div><strong>RTSP FPS</strong><span>${escapeHtml(config.stream_fps ?? "-")}</span></div>
        <div><strong>Umgebungslicht</strong><span>${escapeHtml(camera.status.ambientLux || "-")} Lux</span></div>
        <div><strong>IR Modus</strong><span>${escapeHtml(camera.status.irMode || config.ir_mode_name || "-")}</span></div>
        <div><strong>IR Zustand</strong><span>${camera.status.irEnabled === true ? "AN" : camera.status.irEnabled === false ? "AUS" : "-"}</span></div>
        <div><strong>Lichtsensor</strong><span>${escapeHtml(camera.status.lightSensor || "-")}</span></div>
      `
      : camera.kind === "esp32"
      ? `
        <div><strong>Aufloesung</strong><span>${escapeHtml(config.framesize_name || "-")}</span></div>
        <div><strong>JPEG</strong><span>${escapeHtml(config.jpeg_quality ?? "-")}</span></div>
        <div><strong>RTSP FPS</strong><span>${escapeHtml(config.stream_fps ?? "-")}</span></div>
        <div><strong>LED</strong><span>${escapeHtml(String(config.led ?? "-"))}</span></div>
      `
      : `
        <div><strong>Aufloesung</strong><span>${escapeHtml(config.width || "-")} x ${escapeHtml(config.height || "-")}</span></div>
        <div><strong>FPS</strong><span>${escapeHtml(config.framerate ?? config.fps ?? "-")}</span></div>
        <div><strong>Bitrate</strong><span>${escapeHtml(config.bitrate ?? config.bitrate_bps ?? "-")}</span></div>
        <div><strong>Modus</strong><span>${escapeHtml(codecMode)}</span></div>
      `;

  stateCardEl.innerHTML = `
    <div class="camera-state-row">
      <span class="status-badge ${stateBadge}">${escapeHtml(camera.status.state || "unknown")}</span>
      <span class="obj-date">Online Topic: ${String(camera.status.online)}</span>
    </div>
    <div class="camera-state-grid">
      ${primaryConfigRows}
      <div><strong>Letzter Ping</strong><span>${escapeHtml(camera.status.pong || "-")}</span></div>
      <div><strong>RTSP Quelle</strong><span>${escapeHtml(camera.status.rtspUrl || "-")}</span></div>
      <div><strong>MQTT zuletzt</strong><span>${escapeHtml(camera.mqtt.lastTopic || "-")}</span></div>
      <div><strong>Direkte Sessions</strong><span>${escapeHtml(camera.status.directSessions ?? camera.status.clients ?? "-")}</span></div>
      <div><strong>Direkt streamend</strong><span>${escapeHtml(camera.status.directStreamingClients ?? camera.status.clients ?? "-")}</span></div>
      <div><strong>Quell-FPS</strong><span>${escapeHtml(camera.status.frameFps ?? "-")}</span></div>
      <div><strong>Publisher</strong><span>${camera.status.publisherConnected === true ? "VERBUNDEN" : camera.status.publisherConnected === false ? "GETRENNT" : "-"}</span></div>
      <div><strong>Reconnects</strong><span>${escapeHtml(camera.status.reconnectCount ?? "-")}</span></div>
      <div><strong>WLAN / MQTT Reconnects</strong><span>${escapeHtml(camera.status.wifiReconnectCount ?? 0)} / ${escapeHtml(camera.status.mqttReconnectCount ?? 0)}</span></div>
      <div><strong>Kamera-Recovery</strong><span>${escapeHtml(camera.status.cameraRecoveryCount ?? 0)}</span></div>
      <div><strong>MQTT Publish-Fehler</strong><span>${escapeHtml(camera.status.mqttPublishFailures ?? 0)}</span></div>
      <div><strong>WLAN Signal</strong><span>${camera.status.wifiRssi != null ? `${escapeHtml(camera.status.wifiRssi)} dBm` : "-"}</span></div>
      <div><strong>Geraete-Laufzeit</strong><span>${camera.status.uptimeSeconds ? `${escapeHtml(camera.status.uptimeSeconds)} s` : "-"}</span></div>
      <div><strong>Freier Geraetespeicher</strong><span>${camera.status.freeHeapBytes ? escapeHtml(formatBytes(camera.status.freeHeapBytes)) : "-"}</span></div>
      <div><strong>Stream Laufzeit</strong><span>${camera.status.streamUptimeSeconds ? `${escapeHtml(camera.status.streamUptimeSeconds)} s` : "-"}</span></div>
      <div><strong>Daten zuletzt</strong><span>${camera.status.streamLastDataAgeSeconds != null ? `${escapeHtml(camera.status.streamLastDataAgeSeconds)} s` : "-"}</span></div>
      <div><strong>Bridge Status</strong><span>${escapeHtml(bridge?.state || "-")}</span></div>
      <div><strong>Bridge PID</strong><span>${escapeHtml(bridge?.pid || "-")}</span></div>
      <div><strong>Bridge Fortschritt</strong><span>${bridge?.progressAgeSeconds != null ? `vor ${escapeHtml(bridge.progressAgeSeconds)} s` : "-"}</span></div>
      <div><strong>Letzter Befehl</strong><span>${escapeHtml(camera.status.lastCommand?.name || "-")} / ${escapeHtml(camera.status.lastCommand?.result || "-")}</span></div>
      <div><strong>Befehl Rueckmeldung</strong><span>${escapeHtml(camera.status.lastCommand?.message || "-")}</span></div>
    </div>
    <div class="camera-error-box ${camera.status.error ? "camera-error-active" : ""}">
      ${escapeHtml(camera.status.error || bridge?.lastError || bridge?.lastMessage || camera.status.lastStatus || "Kein gemeldeter Fehler.")}
    </div>
  `;
}

function renderTopics(camera) {
  if (!topicLogEl || !camera) return;
  const items = camera.status.recentTopics || [];

  if (!items.length) {
    topicLogEl.innerHTML = '<li style="justify-content:center; color: var(--text-muted);">Noch keine Kamera-Statusdaten vorhanden</li>';
    return;
  }

  topicLogEl.innerHTML = items
    .map(
      (entry) => `
        <li>
          <strong class="obj-name" style="font-family: monospace;">${escapeHtml(entry.topic)}</strong>
          <span class="obj-date">${escapeHtml(entry.value)}</span>
          <span class="obj-topic">${escapeHtml(formatTimestamp(entry.timestamp))}</span>
        </li>
      `
    )
    .join("");
}

function renderTargets(camera) {
  if (!targetsEl || !camera) return;
  const { urls } = camera.stream;
  const rows = [
    ["WebRTC", urls.webrtcPage],
    ["HLS Seite", urls.hlsPage],
    ["HLS Playlist", urls.hlsPlaylist],
    ["RTSP", urls.rtsp],
    ["MediaMTX API", urls.apiBase || "deaktiviert"],
    ["Direkte Kamera RTSP", camera.status.rtspUrl || "-"],
    ["Kamera Archiv", camera.stream.archiveUrl || "-"],
    ["Bridge Ziel RTSP", camera.bridge?.destinationRtspUrl || "-"],
    ["Bridge Status", camera.bridge?.state || "-"],
  ];

  targetsEl.innerHTML = rows
    .map(
      ([label, value]) => `
        <div class="camera-target-item">
          <strong>${escapeHtml(label)}</strong>
          <span>${escapeHtml(value)}</span>
        </div>
      `
    )
    .join("");
}

function renderSnapshotCompare(camera) {
  if (!snapshotCompareEl || !camera) return;
  const entry = cameraSnapshots.get(camera.cameraId) || { current: null, before: null };

  if (!entry.current) {
    snapshotCompareEl.hidden = true;
    if (snapshotPinEl) snapshotPinEl.disabled = true;
    if (snapshotDownloadEl) snapshotDownloadEl.hidden = true;
    if (snapshotClearEl) snapshotClearEl.hidden = true;
    return;
  }

  snapshotCompareEl.hidden = false;
  if (snapshotCurrentImgEl && snapshotCurrentImgEl.src !== entry.current.url) {
    snapshotCurrentImgEl.src = entry.current.url;
  }
  if (snapshotCurrentMetaEl) snapshotCurrentMetaEl.textContent = entry.current.meta;

  if (snapshotPinEl) snapshotPinEl.disabled = snapshotInFlight;
  if (snapshotDownloadEl) {
    snapshotDownloadEl.hidden = false;
    snapshotDownloadEl.href = entry.current.url;
    snapshotDownloadEl.download = entry.current.filename;
  }
  if (snapshotClearEl) snapshotClearEl.hidden = false;

  if (entry.before && snapshotBeforeCardEl) {
    snapshotBeforeCardEl.hidden = false;
    if (snapshotBeforeImgEl && snapshotBeforeImgEl.src !== entry.before.url) {
      snapshotBeforeImgEl.src = entry.before.url;
    }
    if (snapshotBeforeMetaEl) snapshotBeforeMetaEl.textContent = entry.before.meta;
  } else if (snapshotBeforeCardEl) {
    snapshotBeforeCardEl.hidden = true;
  }
}

function renderStream(camera) {
  if (!camera) return;
  const { urls } = camera.stream;

  if (activeTitleEl) activeTitleEl.textContent = `${camera.label} Live Stream`;
  if (activeSubtitleEl) {
    activeSubtitleEl.textContent = `${camera.cameraId} | ${camera.mqtt.topicBase} | ${camera.stream.path}`;
  }

  if (openWebRtcEl) openWebRtcEl.href = urls.webrtcPage;
  if (openHlsEl) openHlsEl.href = urls.hlsPage;
  if (openRtspEl) openRtspEl.href = urls.rtsp;

  if (streamFrame && streamFrame.dataset.src !== urls.webrtcPage) {
    streamFrame.src = urls.webrtcPage;
    streamFrame.dataset.src = urls.webrtcPage;
  }

  if (streamHintEl) {
    streamHintEl.textContent =
      isJpegCamera(camera)
        ? `${camera.label} liefert RTSP(MJPEG). Der Webserver startet im Hintergrund ffmpeg und published H264 an MediaMTX. Falls das IFrame leer bleibt, zuerst den Bridge-Status pruefen.`
        : camera.kind === "esp32-p4"
          ? "ESP32-P4 publiziert Hardware-H264 mit OV5647-ISP-Farbabstimmung direkt an MediaMTX. Nutze Schnappschuss & Referenzbild fuer den direkten Vorher/Nachher-Farbvergleich."
          : "Pi-Kamera publiziert ueber den Pi-Streamer nach MediaMTX. Falls WebRTC nicht sofort startet, oeffne die Links direkt.";
  }

  renderSnapshotCompare(camera);
}

function setTimelapsePanelCollapsed(isCollapsed, { persist = true } = {}) {
  if (!timelapsePanelEl || !timelapseToggleEl) return;
  timelapseCollapsed = Boolean(isCollapsed);
  timelapsePanelEl.classList.toggle("collapsed", timelapseCollapsed);
  const body = timelapsePanelEl.querySelector(":scope > .section-body");
  if (body) body.hidden = timelapseCollapsed;
  timelapseToggleEl.textContent = timelapseCollapsed ? "Einblenden" : "Ausblenden";
  timelapseToggleEl.setAttribute("aria-expanded", String(!timelapseCollapsed));
  if (persist) {
    try { localStorage.setItem(TIMELAPSE_COLLAPSED_STORAGE_KEY, String(timelapseCollapsed)); } catch {}
  }
}

function renderTimelapseData() {
  if (!timelapsePanelEl || timelapsePanelEl.hidden) return;

  const activeCamera = getActiveCamera();
  const currentTimelapseState =
    timelapseState?.cameraId === activeCamera?.cameraId ? timelapseState : null;

  if (!currentTimelapseState) {
    if (timelapseVideoEl) {
      timelapseVideoEl.removeAttribute("src");
      timelapseVideoEl.dataset.src = "";
      timelapseVideoEl.load();
    }
    if (timelapseFileListEl) {
      timelapseFileListEl.innerHTML = '<li style="justify-content:center; color: var(--muted);">Zeitrafferdaten werden geladen</li>';
    }
    if (timelapseVideoHintEl) {
      timelapseVideoHintEl.textContent = "Noch keine Zeitrafferdaten geladen.";
    }
    return;
  }

  const latestVideo = currentTimelapseState.latestVideo;
  if (timelapseVideoEl) {
    if (latestVideo?.url) {
      if (timelapseVideoEl.dataset.src !== latestVideo.url) {
        timelapseVideoEl.src = latestVideo.url;
        timelapseVideoEl.dataset.src = latestVideo.url;
      }
    } else {
      timelapseVideoEl.removeAttribute("src");
      timelapseVideoEl.dataset.src = "";
      timelapseVideoEl.load();
    }
  }

  if (timelapseVideoHintEl) {
    timelapseVideoHintEl.textContent = latestVideo
      ? `Letztes Video: ${latestVideo.name} | ${formatBytes(latestVideo.sizeBytes)} | ${formatTimestamp(latestVideo.modifiedAt)}`
      : "Noch kein MP4 vorhanden. Erzeuge zuerst ein Video aus den JPEG-Bildern.";
  }

  if (!timelapseFileListEl) return;

  const files = currentTimelapseState.files || [];
  if (!files.length) {
    timelapseFileListEl.innerHTML = '<li style="justify-content:center; color: var(--muted);">Keine Zeitrafferdateien vorhanden</li>';
    return;
  }

  const pagination = currentTimelapseState.pagination;
  const pager = pagination && (pagination.offset > 0 || pagination.hasMore)
    ? `<li class="camera-timelapse-file-row">
        <span>Dateien ${pagination.offset + 1}–${pagination.offset + files.length} von ${pagination.total}</span>
        <div class="camera-timelapse-file-actions">
          <button type="button" data-timelapse-offset="${Math.max(0, pagination.offset - pagination.limit)}" ${pagination.offset === 0 ? "disabled" : ""}>Zurueck</button>
          <button type="button" data-timelapse-offset="${pagination.offset + pagination.limit}" ${!pagination.hasMore ? "disabled" : ""}>Weiter</button>
        </div>
      </li>` : "";
  timelapseFileListEl.innerHTML = pager + files
    .map(
      (file) => `
        <li class="camera-timelapse-file-row">
          <div>
            <strong class="obj-name">${escapeHtml(file.name)}</strong>
            <div class="obj-date">${escapeHtml(file.type.toUpperCase())} | ${escapeHtml(formatBytes(file.sizeBytes))}</div>
            <div class="obj-topic">${escapeHtml(formatTimestamp(file.modifiedAt))}</div>
          </div>
          <div class="camera-timelapse-file-actions">
            ${file.type === "video" ? `<a class="btn btn-secondary" href="${escapeHtml(file.url)}" target="_blank" rel="noreferrer">Oeffnen</a>` : ""}
            <button type="button" class="btn-secondary" data-timelapse-delete="${escapeHtml(file.name)}">Loeschen</button>
          </div>
        </li>
      `
    )
    .join("");

  timelapseFileListEl.querySelectorAll("[data-timelapse-offset]").forEach((button) => {
    bindCameraAction(button, "click", async () => {
      const camera = getActiveCamera();
      if (!camera) return;
      button.disabled = true;
      try {
        await loadTimelapse(camera.cameraId, Number(button.dataset.timelapseOffset));
        renderTimelapseSection(getActiveCamera());
      } catch (error) {
        button.disabled = false;
        setStatusLine(timelapseStatusEl, `Archiv konnte nicht geladen werden: ${error.message}`, true);
      }
    });
  });

  timelapseFileListEl.querySelectorAll("[data-timelapse-delete]").forEach((button) => {
    bindCameraAction(button, "click", async () => {
      const activeCamera = getActiveCamera();
      if (!activeCamera) return;

      try {
        setStatusLine(timelapseStatusEl, `Loesche ${button.dataset.timelapseDelete}...`);
        await postTimelapseDelete({ cameraId: activeCamera.cameraId, name: button.dataset.timelapseDelete });
        await loadTimelapse(activeCamera.cameraId);
        renderTimelapseSection(activeCamera);
        setStatusLine(timelapseStatusEl, `${button.dataset.timelapseDelete} geloescht.`);
      } catch (error) {
        setStatusLine(timelapseStatusEl, `Loeschen fehlgeschlagen: ${error.message}`, true);
      }
    });
  });
}

function renderTimelapseSection(camera) {
  if (!timelapsePanelEl) return;

  if (!camera || !camera.capabilities?.timelapse) {
    timelapsePanelEl.hidden = true;
    return;
  }

  timelapsePanelEl.hidden = false;
  setTimelapsePanelCollapsed(timelapseCollapsed, { persist: false });

  if (timelapseSummaryEl) {
    const timelapse = camera.timelapse || {};
    const currentTimelapseState = timelapseState?.cameraId === camera.cameraId
      ? timelapseState
      : null;
    const archiveTotals = currentTimelapseState?.totals || null;
    const rows = [
      ["Status", timelapse.state || "-"],
      ["Aufnahme", timelapse.enabled === true ? "aktiv" : timelapse.enabled === false ? "deaktiviert" : "-"],
      ["Intervall", timelapse.intervalSeconds ? `${timelapse.intervalSeconds} s` : "-"],
      [
        "Kameraarchiv",
        archiveTotals
          ? formatBytes(archiveTotals.totalBytes)
          : formatBytes(timelapse.storageBytes),
      ],
      [
        "Archivdateien",
        archiveTotals ? `${archiveTotals.imageCount} JPG | ${archiveTotals.videoCount} MP4` : "Archiv noch nicht geladen",
      ],
      [
        "Server frei",
        timelapse.serverFreeBytes
          ? `${formatBytes(timelapse.serverFreeBytes)} frei, davon ${formatBytes(timelapse.serverReserveBytes)} geschuetzt`
          : "wird ermittelt",
      ],
      [
        "Gesamtarchiv",
        timelapse.globalStorageLimitBytes
          ? `${formatBytes(timelapse.globalStorageBytes)} / ${formatBytes(timelapse.globalStorageLimitBytes)}`
          : `${formatBytes(timelapse.globalStorageBytes)} fuer alle Kameras`,
      ],
      ["Aufnahmeart", "Direkte Aufnahme auf dem Server"],
      ["Ordner", timelapse.outputDir || "-"],
      ["Letztes Bild", currentTimelapseState?.latestImage?.name || timelapse.lastImage || "-"],
    ];

    timelapseSummaryEl.innerHTML = rows
      .map(
        ([label, value]) => `
          <div class="camera-target-item">
            <strong>${escapeHtml(label)}</strong>
            <span>${escapeHtml(value)}</span>
          </div>
        `
      )
      .join("");
  }

  renderTimelapseData();
}

function fieldCurrentValue(camera, field) {
  if (
    settingsDraftState.dirty &&
    settingsDraftState.cameraId === camera.cameraId &&
    Object.prototype.hasOwnProperty.call(settingsDraftState.values, field.key)
  ) {
    return settingsDraftState.values[field.key];
  }

  return getReportedFieldValue(camera, field);
}

function renderSettingsForm(camera, { force = false } = {}) {
  if (!settingsForm || !camera) return;
  if (settingsForm.dataset.cameraId === camera.cameraId && !force &&
      (settingsDraftState.dirty || settingsForm.contains(document.activeElement))) {
    return;
  }

  const fields = camera.controls?.fields || [];
  settingsForm.dataset.cameraId = camera.cameraId;

  if (!fields.length) {
    settingsForm.innerHTML = '<p class="camera-muted-line" style="grid-column: 1 / -1;">Noch keine Kamera-Regler gemeldet. Sobald die Kamera online ist und ihre unterstuetzten Einstellungen publiziert, erscheinen sie hier automatisch.</p>';
    return;
  }

  settingsForm.innerHTML = fields
    .map((field) => {
      const fieldId = `camera-field-${field.key}`;
      const value = fieldCurrentValue(camera, field);
      const section = field.section
        ? `<h3 class="camera-settings-section">${escapeHtml(field.section)}</h3>`
        : "";
      const hasDefault = field.default != null && field.type !== "checkbox" && field.type !== "select";
      const defaultPill = hasDefault
        ? `<button type="button" class="camera-default-pill" data-field-default="${escapeHtml(field.key)}" data-default-value="${escapeHtml(field.default)}" title="Auf Standardwert (${escapeHtml(field.default)}) setzen">Std: ${escapeHtml(field.default)}</button>`
        : "";

      if (field.type === "checkbox") {
        return `
          ${section}
          <div class="form-group camera-checkbox-group">
            <label class="switch-line" for="${escapeHtml(fieldId)}">
              <input id="${escapeHtml(fieldId)}" name="${escapeHtml(field.key)}" type="checkbox" ${value ? "checked" : ""}>
              <span>${escapeHtml(field.label)}</span>
            </label>
          </div>
        `;
      }

      if (field.type === "select") {
        return `
          ${section}
          <div class="form-group">
            <label for="${escapeHtml(fieldId)}">${escapeHtml(field.label)}</label>
            <select id="${escapeHtml(fieldId)}" name="${escapeHtml(field.key)}">
              <option value="">Nicht aendern</option>
              ${field.options
                .map(
                  (option) => `
                    <option value="${escapeHtml(option.value)}" ${String(option.value) === String(value) ? "selected" : ""}>
                      ${escapeHtml(option.label)}
                    </option>
                  `
                )
                .join("")}
            </select>
          </div>
        `;
      }

      if (field.slider && field.min != null && field.max != null) {
        const numericValue = value !== "" && Number.isFinite(Number(value))
          ? Number(value)
          : field.default != null
            ? Number(field.default)
            : Math.round((Number(field.min) + Number(field.max)) / 2);
        return `
          ${section}
          <div class="form-group camera-slider-group">
            <div class="camera-field-label-row">
              <label for="${escapeHtml(fieldId)}">${escapeHtml(field.label)}</label>
              ${defaultPill}
            </div>
            <div class="camera-slider-row">
              <input
                type="range"
                class="camera-range-input"
                data-range-for="${escapeHtml(field.key)}"
                min="${escapeHtml(field.min)}"
                max="${escapeHtml(field.max)}"
                step="${escapeHtml(field.step ?? 1)}"
                value="${escapeHtml(numericValue)}"
                aria-label="${escapeHtml(field.label)} Schieberegler"
              >
              <input
                id="${escapeHtml(fieldId)}"
                name="${escapeHtml(field.key)}"
                class="camera-number-input"
                type="${escapeHtml(field.type || "number")}"
                min="${escapeHtml(field.min)}"
                max="${escapeHtml(field.max)}"
                step="${escapeHtml(field.step ?? 1)}"
                placeholder="${escapeHtml(field.placeholder || "")}"
                value="${value !== "" ? escapeHtml(value) : ""}"
              >
            </div>
          </div>
        `;
      }

      return `
        ${section}
        <div class="form-group">
          <div class="camera-field-label-row">
            <label for="${escapeHtml(fieldId)}">${escapeHtml(field.label)}</label>
            ${defaultPill}
          </div>
          <input
            id="${escapeHtml(fieldId)}"
            name="${escapeHtml(field.key)}"
            type="${escapeHtml(field.type || "number")}"
            ${field.min != null ? `min="${escapeHtml(field.min)}"` : ""}
            ${field.max != null ? `max="${escapeHtml(field.max)}"` : ""}
            ${field.step != null ? `step="${escapeHtml(field.step)}"` : ""}
            placeholder="${escapeHtml(field.placeholder || "")}"
            value="${value !== "" ? escapeHtml(value) : ""}"
          >
        </div>
      `;
    })
    .join("") + '<div class="form-group camera-form-actions"><button type="submit">Änderungen senden</button><button type="button" class="btn-secondary" data-settings-reset>Entwurf verwerfen</button></div>';
}

function readSettingsFromForm(camera) {
  const settings = {};
  const fields = camera.controls?.fields || [];
  const touched = settingsDraftState.cameraId === camera.cameraId
    ? new Set(settingsDraftState.touched || [])
    : new Set();

  for (const field of fields) {
    if (!touched.has(field.key)) continue;
    const input = settingsForm.elements.namedItem(field.key);
    if (!input) continue;

    if (field.type === "checkbox") {
      settings[field.key] = Boolean(input.checked);
      continue;
    }

    const rawValue = input.value;
    if (rawValue === "") continue;

    if (field.type === "select" || field.type === "number") {
      const parsed = Number(rawValue);
      if (Number.isFinite(parsed)) {
        settings[field.key] = parsed;
      }
      continue;
    }

    settings[field.key] = rawValue;
  }

  return settings;
}

function settingsExpandRelatedControls(settings) {
  return (
    (Object.prototype.hasOwnProperty.call(settings, "preset") && Number(settings.preset) >= 1) ||
    Object.prototype.hasOwnProperty.call(settings, "red_balance") ||
    Object.prototype.hasOwnProperty.call(settings, "blue_balance")
  );
}

async function flushLiveApply() {
  if (!liveApplyEnabled || cameraOperationInFlight) return;
  if (liveApplyInFlight) {
    liveApplyQueued = true;
    return;
  }
  const activeCamera = getActiveCamera();
  if (!activeCamera || !activeCamera.mqtt?.connected) return;
  if (settingsDraftState.cameraId !== activeCamera.cameraId || !settingsDraftState.dirty) return;

  const settings = readSettingsFromForm(activeCamera);
  const keys = Object.keys(settings);
  if (!keys.length) return;

  liveApplyInFlight = true;
  const sentTouched = new Set(keys);
  try {
    setSettingsFeedback(activeCamera.cameraId, "", false, 0);
    const expandsRelated = settingsExpandRelatedControls(settings);
    const result = await sendCommand(activeCamera.cameraId, "set", { settings });
    setPendingCameraSettings(activeCamera.cameraId, settings, result.requestId, expandsRelated);
    setOverviewState(result.overview);

    // Clear only the touched keys that were not modified again while the request was in flight.
    if (settingsDraftState.cameraId === activeCamera.cameraId) {
      for (const key of sentTouched) {
        const currentInput = settingsForm?.elements?.namedItem(key);
        const currentVal = currentInput
          ? (currentInput.type === "checkbox" ? Boolean(currentInput.checked) : Number(currentInput.value))
          : undefined;
        if (currentVal === settings[key]) {
          settingsDraftState.touched.delete(key);
        }
      }
      if (settingsDraftState.touched.size === 0) {
        resetSettingsDraft(activeCamera.cameraId);
      }
    }
    syncSettingsStatus(getActiveCamera());
    renderPicker();
    if (expandsRelated) {
      setTimeout(() => { loadOverview().catch(() => {}); }, 450);
    }
  } catch (error) {
    pendingCameraSettings.delete(activeCamera.cameraId);
    setSettingsFeedback(activeCamera.cameraId, `Live-Übernahme fehlgeschlagen: ${error.message}`, true, 8000);
    syncSettingsStatus(getActiveCamera());
  } finally {
    liveApplyInFlight = false;
    if (liveApplyQueued) {
      liveApplyQueued = false;
      scheduleLiveApply(180);
    }
  }
}

function scheduleLiveApply(delayMs = 280) {
  if (!liveApplyEnabled) return;
  clearTimeout(liveApplyTimer);
  liveApplyTimer = setTimeout(() => {
    liveApplyTimer = null;
    flushLiveApply().catch(() => {});
  }, delayMs);
}

function renderActiveCamera(options = {}) {
  renderHeroSummary();
  renderSummaryCards();
  renderPicker();

  const activeCamera = getActiveCamera();
  if (!activeCamera) return;

  activeCameraId = activeCamera.cameraId;
  syncActionButtons(activeCamera);
  renderState(activeCamera);
  renderTopics(activeCamera);
  renderTargets(activeCamera);
  renderStream(activeCamera);
  renderSettingsForm(activeCamera, { force: Boolean(options.forceSettings) });
  syncSettingsStatus(activeCamera);
  renderTimelapseSection(activeCamera);
}

async function loadOverview() {
  if (overviewRefreshInFlight || cameraOperationInFlight) return;
  overviewRefreshInFlight = true;
  if (overviewRefreshEl) overviewRefreshEl.disabled = true;
  try {
    const overview = await fetchCameraOverview();
    if (cameraOperationInFlight) return;
    setOverviewState(overview);
    if (!activeCameraId) {
      activeCameraId = overviewState.primaryCameraId;
    }
    if (!getActiveCamera() && overviewState.primaryCameraId) {
      activeCameraId = overviewState.primaryCameraId;
    }
    renderActiveCamera();
    setStatusLine(overviewStatusEl, `Zuletzt aktualisiert: ${new Date().toLocaleTimeString()}`);
  } catch (error) {
    setStatusLine(overviewStatusEl, `Kameradaten nicht aktualisiert: ${error.message}. Vorhandene Werte bleiben stehen.`, true);
    throw error;
  } finally {
    overviewRefreshInFlight = false;
    if (overviewRefreshEl) overviewRefreshEl.disabled = cameraOperationInFlight;
  }
}

async function sendCommand(cameraId, action, body = {}) {
  const data = await postCameraCommand(cameraId, action, body);
  setOverviewState(data.overview);
  return data;
}

async function loadTimelapse(cameraId, offset = null) {
  const version = ++archiveRequestVersion;
  const currentOffset = timelapseState?.cameraId === cameraId ? timelapseState.pagination?.offset || 0 : 0;
  let data = await fetchTimelapse(cameraId, offset ?? currentOffset);
  // Deleting the last file on a page should take the user back to the archive start.
  if (!data.files?.length && data.pagination?.offset > 0) data = await fetchTimelapse(cameraId, 0);
  if (cameraId === activeCameraId && version === archiveRequestVersion) timelapseState = data;
  return data;
}

async function postTimelapseBuild(cameraId) {
  return buildTimelapse(cameraId);
}

async function postTimelapseDelete(payload) {
  return deleteTimelapse(payload);
}

document.querySelectorAll("[data-camera-action]").forEach((button) => {
  bindCameraAction(button, "click", async () => {
    const activeCamera = getActiveCamera();
    if (!activeCamera) return;

    const action = button.dataset.cameraAction;
    try {
      setStatusLine(commandStatusEl, `Sende ${action} an ${activeCamera.label}...`);
      await sendCommand(activeCamera.cameraId, action);
      renderActiveCamera();
      setStatusLine(commandStatusEl, `Befehl ${action} an ${activeCamera.label} gesendet.`);
    } catch (error) {
      setStatusLine(commandStatusEl, `Befehl fehlgeschlagen: ${error.message}`, true);
    }
  });
});

bindCameraAction(resetDefaultsBtnEl, "click", async () => {
  const activeCamera = getActiveCamera();
  if (!activeCamera || activeCamera.kind !== "esp32-p4") return;
  clearTimeout(liveApplyTimer);
  try {
    setStatusLine(settingsStatusEl, `Setze Bildwerte von ${activeCamera.label} auf Standard zurück...`);
    await sendCommand(activeCamera.cameraId, "reset");
    pendingCameraSettings.delete(activeCamera.cameraId);
    resetSettingsDraft(activeCamera.cameraId);
    setSettingsFeedback(activeCamera.cameraId, "Standard-Bildwerte angefordert …", false, 8000);
    renderActiveCamera({ forceSettings: true });
    setTimeout(async () => {
      try {
        await loadOverview();
        renderSettingsForm(getActiveCamera(), { force: true });
      } catch {}
    }, 600);
  } catch (error) {
    setSettingsFeedback(activeCamera.cameraId, `Zurücksetzen fehlgeschlagen: ${error.message}`, true, 10000);
    setStatusLine(settingsStatusEl, `Zurücksetzen fehlgeschlagen: ${error.message}`, true);
  }
});

liveApplyCheckboxEl?.addEventListener("change", () => {
  liveApplyEnabled = Boolean(liveApplyCheckboxEl.checked);
  try { localStorage.setItem(LIVE_APPLY_STORAGE_KEY, String(liveApplyEnabled)); } catch {}
  syncSettingsStatus(getActiveCamera());
  if (liveApplyEnabled && settingsDraftState.dirty) {
    scheduleLiveApply(80);
  }
});

bindCameraAction(settingsForm, "submit", async (event) => {
  event.preventDefault();
  clearTimeout(liveApplyTimer);

  const activeCamera = getActiveCamera();
  if (!activeCamera) return;

  const settings = readSettingsFromForm(activeCamera);
  if (!Object.keys(settings).length) {
    setStatusLine(settingsStatusEl, "Keine gueltigen Werte zum Senden.", true);
    return;
  }

  try {
    setStatusLine(settingsStatusEl, `Sende Einstellungen an ${activeCamera.label}...`);
    setSettingsFeedback(activeCamera.cameraId, "", false, 0);
    const expandsRelated = settingsExpandRelatedControls(settings);
    const result = await sendCommand(activeCamera.cameraId, "set", { settings });
    setPendingCameraSettings(activeCamera.cameraId, settings, result.requestId, expandsRelated);
    setOverviewState(result.overview);
    resetSettingsDraft(activeCamera.cameraId);
    renderActiveCamera({ forceSettings: true });
    if (expandsRelated) {
      setTimeout(() => { loadOverview().catch(() => {}); }, 500);
    }
  } catch (error) {
    pendingCameraSettings.delete(activeCamera.cameraId);
    setSettingsFeedback(activeCamera.cameraId, `Parameter konnten nicht gesetzt werden: ${error.message}`, true, 0);
    setStatusLine(settingsStatusEl, `Parameter konnten nicht gesetzt werden: ${error.message}`, true);
  }
});

settingsForm?.addEventListener("input", (event) => {
  const target = event.target;
  if (target?.matches?.("[data-range-for]")) {
    const key = target.dataset.rangeFor;
    const numberInput = settingsForm.elements.namedItem(key);
    if (numberInput) {
      numberInput.value = target.value;
      // Selecting an individual image slider switches preset draft indicator to custom (0) visually if present.
      if (key !== "preset") {
        const presetSelect = settingsForm.elements.namedItem("preset");
        if (presetSelect && !STREAM_RECONNECT_KEYS.has(key) && key !== "hflip" && key !== "vflip" &&
            !key.startsWith("server_capture_")) {
          presetSelect.value = "0";
        }
      }
      captureSettingsDraft(numberInput);
      if (!STREAM_RECONNECT_KEYS.has(key)) {
        scheduleLiveApply(260);
      }
    }
    return;
  }

  if (target?.name) {
    const slider = settingsForm.querySelector(`[data-range-for="${CSS.escape(target.name)}"]`);
    if (slider && target.value !== "" && Number.isFinite(Number(target.value))) {
      slider.value = target.value;
    }
    captureSettingsDraft(target);
  }
});

settingsForm?.addEventListener("change", (event) => {
  const target = event.target;
  if (target?.matches?.("[data-range-for]")) {
    const key = target.dataset.rangeFor;
    const numberInput = settingsForm.elements.namedItem(key);
    if (numberInput) {
      numberInput.value = target.value;
      captureSettingsDraft(numberInput);
      scheduleLiveApply(120);
    }
    return;
  }

  if (target?.name) {
    const slider = settingsForm.querySelector(`[data-range-for="${CSS.escape(target.name)}"]`);
    if (slider && target.value !== "" && Number.isFinite(Number(target.value))) {
      slider.value = target.value;
    }
    captureSettingsDraft(target);
    scheduleLiveApply(120);
  }
});

settingsForm?.addEventListener("click", (event) => {
  const defaultBtn = event.target.closest("[data-field-default]");
  if (defaultBtn && !cameraOperationInFlight) {
    const key = defaultBtn.dataset.fieldDefault;
    const defVal = defaultBtn.dataset.defaultValue;
    const input = settingsForm.elements.namedItem(key);
    if (input && defVal != null) {
      input.value = defVal;
      const slider = settingsForm.querySelector(`[data-range-for="${CSS.escape(key)}"]`);
      if (slider) slider.value = defVal;
      captureSettingsDraft(input);
      scheduleLiveApply(100);
    }
    return;
  }

  if (!event.target.closest("[data-settings-reset]") || cameraOperationInFlight) return;
  clearTimeout(liveApplyTimer);
  resetSettingsDraft(activeCameraId);
  setSettingsFeedback(activeCameraId, "");
  renderActiveCamera({ forceSettings: true });
});

snapshotCaptureEl?.addEventListener("click", async () => {
  const activeCamera = getActiveCamera();
  if (!activeCamera || snapshotInFlight) return;

  snapshotInFlight = true;
  snapshotCaptureEl.disabled = true;
  if (snapshotPinEl) snapshotPinEl.disabled = true;
  setStatusLine(snapshotStatusEl, `Nehme Live-Schnappschuss von ${activeCamera.label} auf...`);

  try {
    const { blob, timestamp } = await fetchCameraSnapshot(activeCamera.cameraId);
    const objectUrl = URL.createObjectURL(blob);
    const entry = cameraSnapshots.get(activeCamera.cameraId) || { current: null, before: null };
    if (entry.current?.url && entry.current.url !== entry.before?.url) {
      URL.revokeObjectURL(entry.current.url);
    }
    const stamp = new Date(timestamp);
    const timeText = Number.isNaN(stamp.getTime()) ? timestamp : stamp.toLocaleTimeString();
    const fileStamp = new Date().toISOString().replace(/[:.]/g, "-");
    entry.current = {
      url: objectUrl,
      meta: `${timeText} · ${formatBytes(blob.size)}`,
      filename: `${activeCamera.cameraId}-snapshot-${fileStamp}.jpg`,
    };
    cameraSnapshots.set(activeCamera.cameraId, entry);
    if (activeCamera.cameraId === getActiveCamera()?.cameraId) {
      renderSnapshotCompare(activeCamera);
      setStatusLine(
        snapshotStatusEl,
        entry.before
          ? "Neuer Schnappschuss geladen – direkter Vorher/Nachher-Vergleich aktiv."
          : "Schnappschuss aufgenommen. Klicke auf „Als Vorher-Referenz merken“, bevor du Regler verstellst."
      );
    }
  } catch (error) {
    const hint = error.message === "camera_stream_inactive"
      ? "Livestream ist aktuell nicht aktiv."
      : error.message;
    setStatusLine(snapshotStatusEl, `Schnappschuss fehlgeschlagen: ${hint}`, true);
  } finally {
    snapshotInFlight = false;
    snapshotCaptureEl.disabled = false;
    renderSnapshotCompare(getActiveCamera());
  }
});

snapshotPinEl?.addEventListener("click", () => {
  const activeCamera = getActiveCamera();
  if (!activeCamera) return;
  const entry = cameraSnapshots.get(activeCamera.cameraId);
  if (!entry?.current) return;

  if (entry.before?.url && entry.before.url !== entry.current.url) {
    URL.revokeObjectURL(entry.before.url);
  }
  entry.before = { ...entry.current };
  cameraSnapshots.set(activeCamera.cameraId, entry);
  renderSnapshotCompare(activeCamera);
  setStatusLine(snapshotStatusEl, "Als „Vorher“-Referenz gespeichert. Verstelle nun die Bildregler und nimm einen neuen Schnappschuss auf.");
});

snapshotClearEl?.addEventListener("click", () => {
  const activeCamera = getActiveCamera();
  if (!activeCamera) return;
  const entry = cameraSnapshots.get(activeCamera.cameraId);
  if (entry) {
    if (entry.current?.url) URL.revokeObjectURL(entry.current.url);
    if (entry.before?.url && entry.before.url !== entry.current?.url) URL.revokeObjectURL(entry.before.url);
    cameraSnapshots.delete(activeCamera.cameraId);
  }
  renderSnapshotCompare(activeCamera);
  setStatusLine(snapshotStatusEl, "");
});

overviewRefreshEl?.addEventListener("click", () => loadOverview().catch(() => {}));

loadOverview().catch((error) => {
  setStatusLine(commandStatusEl, `Kamera-Uebersicht konnte nicht geladen werden: ${error.message}`, true);
});

bindCameraAction(timelapseToggleEl, "click", async () => {
  const wasCollapsed = timelapseCollapsed;
  setTimelapsePanelCollapsed(!wasCollapsed);

  const activeCamera = getActiveCamera();
  if (!wasCollapsed || !activeCamera?.capabilities?.timelapse) return;

  try {
    setStatusLine(timelapseStatusEl, `Lade Zeitraffer fuer ${activeCamera.label}...`);
    await loadTimelapse(activeCamera.cameraId);
    renderTimelapseSection(activeCamera);
    setStatusLine(timelapseStatusEl, "Zeitrafferdaten geladen.");
  } catch (error) {
    setStatusLine(timelapseStatusEl, `Zeitraffer konnte nicht geladen werden: ${error.message}`, true);
  }
});

bindCameraAction(timelapseRefreshEl, "click", async () => {
  const activeCamera = getActiveCamera();
  if (!activeCamera?.capabilities?.timelapse) return;

  try {
    setStatusLine(timelapseStatusEl, "Aktualisiere Zeitrafferdateien...");
    await loadTimelapse(activeCamera.cameraId);
    renderTimelapseSection(activeCamera);
    setStatusLine(timelapseStatusEl, "Zeitrafferdateien aktualisiert.");
  } catch (error) {
    setStatusLine(timelapseStatusEl, `Aktualisierung fehlgeschlagen: ${error.message}`, true);
  }
});

bindCameraAction(timelapseBuildEl, "click", async () => {
  const activeCamera = getActiveCamera();
  if (!activeCamera?.capabilities?.timelapse) return;

  try {
    setStatusLine(timelapseStatusEl, "Erzeuge MP4 aus den JPEG-Bildern...");
    await postTimelapseBuild(activeCamera.cameraId);
    await loadTimelapse(activeCamera.cameraId);
    renderTimelapseSection(activeCamera);
    setStatusLine(timelapseStatusEl, "Zeitraffer-Video erstellt.");
  } catch (error) {
    setStatusLine(timelapseStatusEl, `Video konnte nicht erzeugt werden: ${error.message}`, true);
  }
});

bindCameraAction(timelapseDeleteVideoEl, "click", async () => {
  const activeCamera = getActiveCamera();
  if (!activeCamera?.capabilities?.timelapse) return;

  try {
    setStatusLine(timelapseStatusEl, "Loesche alle Zeitraffer-MP4...");
    await postTimelapseDelete({ cameraId: activeCamera.cameraId, type: "video" });
    await loadTimelapse(activeCamera.cameraId);
    renderTimelapseSection(activeCamera);
    setStatusLine(timelapseStatusEl, "Alle MP4 geloescht.");
  } catch (error) {
    setStatusLine(timelapseStatusEl, `Loeschen fehlgeschlagen: ${error.message}`, true);
  }
});

bindCameraAction(timelapseDeleteImagesEl, "click", async () => {
  const activeCamera = getActiveCamera();
  if (!activeCamera?.capabilities?.timelapse) return;

  try {
    setStatusLine(timelapseStatusEl, "Loesche alle Zeitraffer-JPG...");
    await postTimelapseDelete({ cameraId: activeCamera.cameraId, type: "image" });
    await loadTimelapse(activeCamera.cameraId);
    renderTimelapseSection(activeCamera);
    setStatusLine(timelapseStatusEl, "Alle JPG geloescht.");
  } catch (error) {
    setStatusLine(timelapseStatusEl, `Loeschen fehlgeschlagen: ${error.message}`, true);
  }
});

setInterval(async () => {
  if (document.hidden || cameraOperationInFlight) return;
  try {
    await loadOverview();
  } catch (error) {
    setStatusLine(commandStatusEl, `Aktualisierung fehlgeschlagen: ${error.message}`, true);
    return;
  }

  const activeCamera = getActiveCamera();
  if (
    timelapseRefreshInFlight ||
    timelapseCollapsed ||
    !activeCamera?.capabilities?.timelapse ||
    !activeCamera.capabilities?.serverTimelapse
  ) {
    return;
  }

  const currentSync = timelapseState?.cameraId === activeCamera.cameraId ? timelapseState?.sync : null;
  if (
    !activeCamera.capabilities?.serverTimelapse &&
    !currentSync?.running &&
    !(Number(currentSync?.pending || 0) > 0)
  ) {
    return;
  }

  timelapseRefreshInFlight = true;
  try {
    await loadTimelapse(activeCamera.cameraId);
    renderTimelapseSection(getActiveCamera());
  } catch {
    // Keep the last successful snapshot visible; the user can retry manually.
  } finally {
    timelapseRefreshInFlight = false;
  }
}, 5000);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) loadOverview().catch(() => {});
});
