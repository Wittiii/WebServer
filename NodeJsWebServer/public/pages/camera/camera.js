const summaryEl = document.getElementById("camera-summary");
const pickerEl = document.getElementById("camera-picker");
const stateCardEl = document.getElementById("camera-state-card");
const topicLogEl = document.getElementById("camera-topic-log");
const targetsEl = document.getElementById("camera-targets");
const commandStatusEl = document.getElementById("camera-command-status");
const settingsStatusEl = document.getElementById("camera-settings-status");
const settingsForm = document.getElementById("camera-settings-form");
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
const timelapsePanelEl = document.getElementById("timelapse-panel");
const timelapseToggleEl = document.getElementById("timelapse-toggle");
const timelapseRefreshEl = document.getElementById("timelapse-refresh");
const timelapseBuildEl = document.getElementById("timelapse-build");
const timelapseDeleteVideoEl = document.getElementById("timelapse-delete-video");
const timelapseDeleteImagesEl = document.getElementById("timelapse-delete-images");
const timelapseSummaryEl = document.getElementById("timelapse-summary");
const timelapseStatusEl = document.getElementById("timelapse-status");
const timelapseFileListEl = document.getElementById("timelapse-file-list");
const timelapseVideoEl = document.getElementById("timelapse-video");
const timelapseVideoHintEl = document.getElementById("timelapse-video-hint");

let overviewState = null;
let activeCameraId = null;
let settingsDraftState = { cameraId: null, dirty: false, values: {} };
const pendingCameraSettings = new Map();
const CAMERA_CONFIG_PENDING_MS = 30000;
let settingsFeedbackState = { cameraId: null, text: "", isError: false, expiresAt: 0 };
let timelapseState = null;
let timelapseRefreshInFlight = false;
const TIMELAPSE_COLLAPSED_STORAGE_KEY = "camera-timelapse-collapsed";
let timelapseCollapsed = localStorage.getItem(TIMELAPSE_COLLAPSED_STORAGE_KEY) !== "false";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatTimestamp(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function normalizeFieldValue(value, field = {}) {
  if (field.type === "checkbox") {
    return Boolean(value);
  }

  if (value == null || value === "") {
    return "";
  }

  if (field.type === "number" || field.type === "select") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : String(value).trim();
  }

  return String(value).trim();
}

function setStatusLine(element, text, isError = false) {
  if (!element) return;
  element.textContent = text;
  element.style.color = isError ? "#f87171" : "#38bdf8";
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
  settingsDraftState = { cameraId, dirty: false, values: {} };
}

function captureSettingsDraft() {
  const camera = getActiveCamera();
  if (!settingsForm || !camera) return;

  const values = {};
  for (const field of camera.controls?.fields || []) {
    const input = settingsForm.elements.namedItem(field.key);
    if (!input) continue;
    values[field.key] = field.type === "checkbox" ? Boolean(input.checked) : input.value;
  }

  settingsDraftState = {
    cameraId: camera.cameraId,
    dirty: true,
    values,
  };
}

function setPendingCameraSettings(cameraId, settings) {
  if (!cameraId || !settings || typeof settings !== "object") return;
  pendingCameraSettings.set(cameraId, {
    settings: { ...settings },
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

  if (cameraConfigMatchesPending(camera, pendingEntry)) {
    pendingCameraSettings.delete(camera.cameraId);
    setSettingsFeedback(camera.cameraId, "Einstellungen uebernommen.", false, 6000);
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
  if (camera.capabilities.liveLed) badges.push("LED");
  if (camera.capabilities.infrared) badges.push("IR Auto");
  if (camera.capabilities.sdCard) badges.push("SD");
  if (camera.capabilities.timelapse) badges.push("Zeitraffer");
  if (camera.capabilities.directRtsp) badges.push("Direkt RTSP");
  return badges;
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
        >
          ${escapeHtml(camera.label)}
        </button>
      `
    )
    .join("");

  pickerEl.querySelectorAll("[data-camera-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      activeCameraId = button.dataset.cameraId;
      resetSettingsDraft(activeCameraId);
      if (timelapseState?.cameraId !== activeCameraId) timelapseState = null;
      renderActiveCamera({ forceSettings: true });

      const selectedCamera = getActiveCamera();
      if (!timelapseCollapsed && selectedCamera?.capabilities?.timelapse) {
        try {
          setStatusLine(timelapseStatusEl, `Lade Zeitraffer fuer ${selectedCamera.label}...`);
          await loadTimelapse(selectedCamera.cameraId);
          renderTimelapseSection(selectedCamera);
          setStatusLine(timelapseStatusEl, "Zeitrafferdaten geladen.");
        } catch (error) {
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

  const primaryConfigRows =
    camera.kind === "dfr1154"
      ? `
        <div><strong>Aufloesung</strong><span>${escapeHtml(config.framesize_name || "-")}</span></div>
        <div><strong>JPEG</strong><span>${escapeHtml(config.jpeg_quality ?? "-")}</span></div>
        <div><strong>RTSP FPS</strong><span>${escapeHtml(config.stream_fps ?? "-")}</span></div>
        <div><strong>Umgebungslicht</strong><span>${escapeHtml(camera.status.ambientLux || "-")} Lux</span></div>
        <div><strong>IR Modus</strong><span>${escapeHtml(camera.status.irMode || config.ir_mode_name || "-")}</span></div>
        <div><strong>IR Zustand</strong><span>${camera.status.irEnabled === true ? "AN" : camera.status.irEnabled === false ? "AUS" : "-"}</span></div>
        <div><strong>SD-Karte</strong><span>${escapeHtml(camera.status.sd || "-")}</span></div>
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
        <div><strong>FPS</strong><span>${escapeHtml(config.framerate || "-")}</span></div>
        <div><strong>Bitrate</strong><span>${escapeHtml(config.bitrate || "-")}</span></div>
        <div><strong>Modus</strong><span>${escapeHtml(config.mode || "-")}</span></div>
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
      <div><strong>Direkte Sessions</strong><span>${escapeHtml(camera.status.directSessions || camera.status.clients || "-")}</span></div>
      <div><strong>Direkt streamend</strong><span>${escapeHtml(camera.status.directStreamingClients || camera.status.clients || "-")}</span></div>
      <div><strong>Quell-FPS</strong><span>${escapeHtml(camera.status.frameFps || "-")}</span></div>
      <div><strong>Bridge Status</strong><span>${escapeHtml(bridge?.state || "-")}</span></div>
      <div><strong>Bridge PID</strong><span>${escapeHtml(bridge?.pid || "-")}</span></div>
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
        : "Pi-Kamera publiziert ueber den Pi-Streamer nach MediaMTX. Falls WebRTC nicht sofort startet, oeffne die Links direkt.";
  }
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
    localStorage.setItem(TIMELAPSE_COLLAPSED_STORAGE_KEY, String(timelapseCollapsed));
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

  timelapseFileListEl.innerHTML = files
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

  timelapseFileListEl.querySelectorAll("[data-timelapse-delete]").forEach((button) => {
    button.addEventListener("click", async () => {
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
    const archiveTotals = timelapseState?.cameraId === camera.cameraId ? timelapseState.totals : null;
    const sync = timelapseState?.cameraId === camera.cameraId ? timelapseState.sync : null;
    const rows = [
      ["Status", timelapse.state || "-"],
      ["Intervall", timelapse.intervalSeconds ? `${timelapse.intervalSeconds} s` : "-"],
      [
        camera.capabilities?.serverTimelapse ? "Serverspeicher" : "Geraetespeicher",
        `${formatBytes(timelapse.storageBytes)} / ${formatBytes(timelapse.storageLimitBytes)}`,
      ],
      ["Serverarchiv", archiveTotals ? formatBytes(archiveTotals.totalBytes) : "Archiv noch nicht geladen"],
      [
        "Archivdateien",
        archiveTotals ? `${archiveTotals.imageCount} JPG | ${archiveTotals.videoCount} MP4` : "Archiv noch nicht geladen",
      ],
      [
        "Synchronisierung",
        sync?.ok === false
          ? `Fehler: ${sync.error}`
          : sync?.running
            ? `${sync.downloaded} geladen | ${sync.scanned || 0} geprueft | laeuft`
          : sync?.ok === true
            ? `${sync.downloaded} geladen | ${sync.scanned || 0} geprueft | fertig`
            : camera.capabilities?.serverTimelapse
              ? "Direkte Aufnahme auf dem Server"
              : camera.kind === "dfr1154" ? "Noch nicht gestartet" : "Direkter Ordner",
      ],
      ["Ordner", timelapse.outputDir || "-"],
      ["Letztes Bild", timelapse.lastImage || "-"],
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
  if (settingsForm.dataset.cameraId === camera.cameraId && settingsDraftState.dirty && !force) {
    return;
  }

  const fields = camera.controls?.fields || [];
  settingsForm.dataset.cameraId = camera.cameraId;

  settingsForm.innerHTML = fields
    .map((field) => {
      const fieldId = `camera-field-${field.key}`;
      const value = fieldCurrentValue(camera, field);

      if (field.type === "checkbox") {
        return `
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

      return `
        <div class="form-group">
          <label for="${escapeHtml(fieldId)}">${escapeHtml(field.label)}</label>
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
    .join("") + '<div class="form-group camera-form-actions"><button type="submit">Einstellungen senden</button></div>';
}

function readSettingsFromForm(camera) {
  const settings = {};
  const fields = camera.controls?.fields || [];

  for (const field of fields) {
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

function renderActiveCamera(options = {}) {
  renderHeroSummary();
  renderSummaryCards();
  renderPicker();

  const activeCamera = getActiveCamera();
  if (!activeCamera) return;

  activeCameraId = activeCamera.cameraId;
  renderState(activeCamera);
  renderTopics(activeCamera);
  renderTargets(activeCamera);
  renderStream(activeCamera);
  renderSettingsForm(activeCamera, { force: Boolean(options.forceSettings) });
  syncSettingsStatus(activeCamera);
  renderTimelapseSection(activeCamera);
}

async function loadOverview() {
  const response = await fetch("/api/camera/overview");
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  setOverviewState(await response.json());
  if (!activeCameraId) {
    activeCameraId = overviewState.primaryCameraId;
  }
  if (!getActiveCamera() && overviewState.primaryCameraId) {
    activeCameraId = overviewState.primaryCameraId;
  }
  renderActiveCamera();
}

async function sendCommand(cameraId, action, body = {}) {
  const response = await fetch("/api/camera/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cameraId, action, ...body }),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  setOverviewState(data.overview);
  return overviewState;
}

async function loadTimelapse(cameraId) {
  const response = await fetch(`/api/camera/timelapse?cameraId=${encodeURIComponent(cameraId)}`);
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  timelapseState = data;
  return data;
}

async function postTimelapseBuild(cameraId) {
  const response = await fetch("/api/camera/timelapse/build", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cameraId }),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

async function postTimelapseDelete(payload) {
  const response = await fetch("/api/camera/timelapse/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

document.querySelectorAll("[data-camera-action]").forEach((button) => {
  button.addEventListener("click", async () => {
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

settingsForm?.addEventListener("submit", async (event) => {
  event.preventDefault();

  const activeCamera = getActiveCamera();
  if (!activeCamera) return;

  const settings = readSettingsFromForm(activeCamera);
  if (!Object.keys(settings).length) {
    setStatusLine(settingsStatusEl, "Keine gueltigen Werte zum Senden.", true);
    return;
  }

  try {
    setStatusLine(settingsStatusEl, `Sende Einstellungen an ${activeCamera.label}...`);
    setPendingCameraSettings(activeCamera.cameraId, settings);
    setSettingsFeedback(activeCamera.cameraId, "", false, 0);
    await sendCommand(activeCamera.cameraId, "set", { settings });
    resetSettingsDraft(activeCamera.cameraId);
    renderActiveCamera({ forceSettings: true });
  } catch (error) {
    pendingCameraSettings.delete(activeCamera.cameraId);
    setSettingsFeedback(activeCamera.cameraId, "", false, 0);
    setStatusLine(settingsStatusEl, `Parameter konnten nicht gesetzt werden: ${error.message}`, true);
  }
});

settingsForm?.addEventListener("input", () => {
  captureSettingsDraft();
});

settingsForm?.addEventListener("change", () => {
  captureSettingsDraft();
});

loadOverview().catch((error) => {
  setStatusLine(commandStatusEl, `Kamera-Uebersicht konnte nicht geladen werden: ${error.message}`, true);
});

timelapseToggleEl?.addEventListener("click", async () => {
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

timelapseRefreshEl?.addEventListener("click", async () => {
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

timelapseBuildEl?.addEventListener("click", async () => {
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

timelapseDeleteVideoEl?.addEventListener("click", async () => {
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

timelapseDeleteImagesEl?.addEventListener("click", async () => {
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
    activeCamera.kind !== "dfr1154"
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
