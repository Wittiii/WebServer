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

let overviewState = null;
let activeCameraId = null;

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

function getCapabilityBadges(camera) {
  const badges = [];
  if (camera.capabilities.liveLed) badges.push("LED");
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
    button.addEventListener("click", () => {
      activeCameraId = button.dataset.cameraId;
      renderActiveCamera();
    });
  });
}

function renderState(camera) {
  if (!stateCardEl || !camera) return;

  const config = camera.stream.currentConfig || {};
  const stateBadge =
    camera.status.online === true && (camera.status.state === "streaming" || camera.status.state === "running" || camera.status.state === "ready")
      ? "status-online"
      : "status-offline";

  const primaryConfigRows =
    camera.kind === "esp32"
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
      <div><strong>Clients</strong><span>${escapeHtml(camera.status.clients || "-")}</span></div>
    </div>
    <div class="camera-error-box ${camera.status.error ? "camera-error-active" : ""}">
      ${escapeHtml(camera.status.error || camera.status.lastStatus || "Kein gemeldeter Fehler.")}
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
      camera.kind === "esp32"
        ? "ESP32-CAM liefert direkt RTSP und wird von MediaMTX im LAN uebernommen. Falls das IFrame leer bleibt, WebRTC oder HLS direkt oeffnen."
        : "Pi-Kamera publiziert ueber den Pi-Streamer nach MediaMTX. Falls WebRTC nicht sofort startet, oeffne die Links direkt.";
  }
}

function fieldCurrentValue(camera, field) {
  const config = camera.stream.currentConfig || {};
  if (Object.prototype.hasOwnProperty.call(config, field.key)) {
    return config[field.key];
  }
  return "";
}

function renderSettingsForm(camera) {
  if (!settingsForm || !camera) return;
  const fields = camera.controls?.fields || [];

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

function renderActiveCamera() {
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
  renderSettingsForm(activeCamera);
}

async function loadOverview() {
  const response = await fetch("/api/camera/overview");
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  overviewState = await response.json();
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
  overviewState = data.overview;
  return overviewState;
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
    await sendCommand(activeCamera.cameraId, "set", { settings });
    renderActiveCamera();
    setStatusLine(settingsStatusEl, `${activeCamera.label} Einstellungen uebernommen.`);
  } catch (error) {
    setStatusLine(settingsStatusEl, `Parameter konnten nicht gesetzt werden: ${error.message}`, true);
  }
});

loadOverview().catch((error) => {
  setStatusLine(commandStatusEl, `Kamera-Uebersicht konnte nicht geladen werden: ${error.message}`, true);
});

setInterval(() => {
  loadOverview().catch((error) => {
    setStatusLine(commandStatusEl, `Aktualisierung fehlgeschlagen: ${error.message}`, true);
  });
}, 5000);
