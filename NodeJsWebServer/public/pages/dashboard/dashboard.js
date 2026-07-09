const clientList = document.getElementById("client-list");
const topicList = document.getElementById("topic-list");
const clientsCountEl = document.getElementById("stats-clients-count");
const topicsCountEl = document.getElementById("stats-topics-count");
const trendCanvas = document.getElementById("dashboard-trend-chart");
const serverCpuUsageEl = document.getElementById("server-cpu-usage");
const serverCpuMetaEl = document.getElementById("server-cpu-meta");
const serverRamUsageEl = document.getElementById("server-ram-usage");
const serverRamMetaEl = document.getElementById("server-ram-meta");
const serverStorageFreeEl = document.getElementById("server-storage-free");
const serverStorageMetaEl = document.getElementById("server-storage-meta");
const serverDbSizeEl = document.getElementById("server-db-size");
const serverDbMetaEl = document.getElementById("server-db-meta");
const serverCpuCardEl = serverCpuUsageEl?.closest(".stats-card") || null;
const serverRamCardEl = serverRamUsageEl?.closest(".stats-card") || null;
const serverStorageCardEl = serverStorageFreeEl?.closest(".stats-card") || null;
const serverDbCardEl = serverDbSizeEl?.closest(".stats-card") || null;

const widgetForm = document.getElementById("quick-widget-form");
const widgetTypeEl = document.getElementById("quick-widget-type");
const widgetObjectEl = document.getElementById("quick-widget-object");
const widgetDetailEl = document.getElementById("quick-widget-detail");
const widgetDetailLabelEl = document.getElementById("quick-widget-detail-label");
const widgetTitleEl = document.getElementById("quick-widget-title");
const widgetCancelEl = document.getElementById("quick-widget-cancel");
const widgetStatusEl = document.getElementById("quick-widget-status");
const widgetListEl = document.getElementById("quick-widget-list");
const quickBoardSection = document.getElementById("dashboard-quick-board");
const quickBuilderSection = document.getElementById("dashboard-quick-builder");

const MAX_TREND_POINTS = 20;

let trendHistory = [];
let widgets = [];
let objectsCache = [];
let editingWidgetId = null;
let widgetStates = new Map();
let widgetFeedback = new Map();
const objectMetaCache = new Map();

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setWidgetStatus(text, isError = false) {
  if (!widgetStatusEl) return;
  widgetStatusEl.textContent = text;
  widgetStatusEl.style.color = isError ? "var(--danger)" : "var(--muted)";
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const decimals = size >= 100 || unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(decimals)} ${units[unitIndex]}`;
}

function formatPercent(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return "-";
  return `${numeric.toFixed(1)}%`;
}

function getUsageSeverity(usagePercent, warnAt, criticalAt) {
  const numeric = Number(usagePercent || 0);
  if (!Number.isFinite(numeric)) return "normal";
  if (numeric >= criticalAt) return "critical";
  if (numeric >= warnAt) return "warn";
  return "normal";
}

function applyHealthClass(cardElement, severity) {
  if (!cardElement) return;
  cardElement.classList.remove("health-warn", "health-critical");
  if (severity === "warn") {
    cardElement.classList.add("health-warn");
  } else if (severity === "critical") {
    cardElement.classList.add("health-critical");
  }
}

function createWidgetId() {
  return `widget-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function saveWidgets() {
  const response = await fetch("/dashboard/widgets", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ widgets }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok !== true) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
}

async function loadStoredWidgets() {
  const response = await fetch("/dashboard/widgets");
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.json();
  return Array.isArray(data?.widgets) ? data.widgets : [];
}

function openQuickBoard() {
  if (!quickBoardSection?.classList.contains("collapsed")) return;
  quickBoardSection.querySelector(".section-toggle")?.click();
}

function openQuickBuilder() {
  if (!quickBuilderSection?.classList.contains("collapsed")) return;
  quickBuilderSection.querySelector(".section-toggle")?.click();
}

function updateTrendHistory(clientsCount, topicsCount) {
  trendHistory.push({ time: new Date(), clients: clientsCount, topics: topicsCount });
  if (trendHistory.length > MAX_TREND_POINTS) {
    trendHistory.shift();
  }
  drawTrendChart();
}

function drawTrendChart() {
  if (!trendCanvas) return;
  const ctx = trendCanvas.getContext("2d");
  const width = trendCanvas.clientWidth;
  const height = trendCanvas.clientHeight;
  const ratio = window.devicePixelRatio || 1;

  trendCanvas.width = width * ratio;
  trendCanvas.height = height * ratio;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  if (!trendHistory.length) {
    ctx.fillStyle = "#91a7c5";
    ctx.font = "16px IBM Plex Sans, sans-serif";
    ctx.fillText("Keine Trenddaten", 20, 40);
    return;
  }

  const padding = 42;
  const valuesClients = trendHistory.map((entry) => entry.clients);
  const valuesTopics = trendHistory.map((entry) => entry.topics);
  const maxValue = Math.max(...valuesClients, ...valuesTopics, 1);
  const chartHeight = height - padding * 2;
  const stepX = (width - padding * 2) / Math.max(trendHistory.length - 1, 1);

  ctx.strokeStyle = "rgba(145, 167, 197, 0.2)";
  for (let i = 0; i < 5; i += 1) {
    const y = padding + (chartHeight / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padding, y);
    ctx.lineTo(width - padding, y);
    ctx.stroke();
  }

  const drawLine = (values, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    values.forEach((value, index) => {
      const x = padding + stepX * index;
      const y = height - padding - (value / maxValue) * chartHeight;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  };

  drawLine(valuesClients, "#63c8ff");
  drawLine(valuesTopics, "#ffd166");

  ctx.fillStyle = "#91a7c5";
  ctx.font = "12px IBM Plex Sans, sans-serif";
  trendHistory.forEach((entry, index) => {
    const x = padding + stepX * index;
    ctx.fillText(entry.time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), x - 24, height - 14);
  });

  ctx.fillStyle = "#63c8ff";
  ctx.fillText("Clients", padding, 18);
  ctx.fillStyle = "#ffd166";
  ctx.fillText("Topics", padding + 86, 18);
}

async function loadMqttClients() {
  if (!clientList) return;

  try {
    const list = await fetch("/api/mqtt/clients").then((r) => r.json());
    if (!Array.isArray(list)) throw new Error("ungueltiges Antwortformat");

    const onlineClients = list.filter((c) => c.connected).length;
    if (clientsCountEl) clientsCountEl.textContent = String(onlineClients);

    if (!list.length) {
      clientList.innerHTML = '<li>Keine Clients registriert</li>';
      return;
    }

    clientList.innerHTML = list
      .map((client) => {
        const badgeClass = client.connected ? "status-online" : "status-offline";
        const lastSeen = client.last ? new Date(client.last).toLocaleTimeString() : "-";
        const lastTopic = client.lastTopic ? escapeHtml(client.lastTopic) : "Keine Aktivitaet";
        return `
          <li>
            <strong class="obj-name">${escapeHtml(client.id)}</strong>
            <span class="obj-date">${lastSeen}</span>
            <span class="obj-topic">${lastTopic}</span>
            <span class="status-badge ${badgeClass}">${client.connected ? '<span class="pulse-online"></span>Online' : "Offline"}</span>
          </li>
        `;
      })
      .join("");
  } catch (error) {
    clientList.innerHTML = `<li class="error-msg">Fehler: ${escapeHtml(error.message || error)}</li>`;
    if (clientsCountEl) clientsCountEl.textContent = "0";
  }
}

async function loadMqttTopics() {
  if (!topicList) return;

  try {
    const list = await fetch("/api/mqtt/topics").then((r) => r.json());
    if (!Array.isArray(list)) throw new Error("ungueltiges Antwortformat");

    if (topicsCountEl) topicsCountEl.textContent = String(list.length);

    if (!list.length) {
      topicList.innerHTML = '<li>Keine Topics registriert</li>';
      return;
    }

    topicList.innerHTML = list
      .map((topic) => {
        const receivedAt = topic.timestamp ? new Date(topic.timestamp).toLocaleTimeString() : "-";
        return `
          <li>
            <strong class="obj-name">${escapeHtml(topic.topic)}</strong>
            <span class="obj-topic">${escapeHtml(topic.lastMessage)}</span>
            <span class="obj-date">${receivedAt}</span>
          </li>
        `;
      })
      .join("");
  } catch (error) {
    topicList.innerHTML = `<li class="error-msg">Fehler: ${escapeHtml(error.message || error)}</li>`;
    if (topicsCountEl) topicsCountEl.textContent = "0";
  }
}

async function loadSystemStats() {
  try {
    const data = await fetch("/dashboard/system").then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    });

    const cpuUsage = Number(data?.cpu?.usagePercent || 0);
    const cpuCores = Number(data?.cpu?.cores || 0);
    const cpuLoad = Array.isArray(data?.cpu?.loadAverage) ? data.cpu.loadAverage[0] : null;
    applyHealthClass(serverCpuCardEl, getUsageSeverity(cpuUsage, 65, 85));
    if (serverCpuUsageEl) serverCpuUsageEl.textContent = formatPercent(cpuUsage);
    if (serverCpuMetaEl) {
      const loadText = Number.isFinite(cpuLoad) ? ` | Load 1m ${cpuLoad.toFixed(2)}` : "";
      serverCpuMetaEl.textContent = `${cpuCores || "-"} Kerne${loadText}`;
    }

    const ramUsed = Number(data?.memory?.usedBytes || 0);
    const ramTotal = Number(data?.memory?.totalBytes || 0);
    const ramPercent = ramTotal > 0 ? (ramUsed / ramTotal) * 100 : 0;
    applyHealthClass(serverRamCardEl, getUsageSeverity(ramPercent, 75, 90));
    if (serverRamUsageEl) serverRamUsageEl.textContent = formatPercent(ramPercent);
    if (serverRamMetaEl) serverRamMetaEl.textContent = `${formatBytes(ramUsed)} von ${formatBytes(ramTotal)} belegt`;

    const storageFree = Number(data?.storage?.freeBytes || 0);
    const storageUsed = Number(data?.storage?.usedBytes || 0);
    const storageTotal = Number(data?.storage?.totalBytes || 0);
    const storageUsedPercent = storageTotal > 0 ? (storageUsed / storageTotal) * 100 : 0;
    applyHealthClass(serverStorageCardEl, getUsageSeverity(storageUsedPercent, 80, 92));
    if (serverStorageFreeEl) serverStorageFreeEl.textContent = formatBytes(storageFree);
    if (serverStorageMetaEl) {
      serverStorageMetaEl.textContent = `${formatBytes(storageUsed)} von ${formatBytes(storageTotal)} belegt (${formatPercent(storageUsedPercent)})`;
    }

    const dbSize = Number(data?.database?.sizeBytes || 0);
    const dbUsagePercent = storageTotal > 0 ? (dbSize / storageTotal) * 100 : 0;
    const dbSeverity = storageTotal > 0
      ? getUsageSeverity(dbUsagePercent, 10, 20)
      : getUsageSeverity(dbSize / (1024 * 1024), 512, 2048);
    applyHealthClass(serverDbCardEl, dbSeverity);
    if (serverDbSizeEl) serverDbSizeEl.textContent = formatBytes(dbSize);
    if (serverDbMetaEl) {
      const dbPercentText = storageTotal > 0 ? ` | ${formatPercent(dbUsagePercent)} vom Storage` : "";
      serverDbMetaEl.textContent = `${formatBytes(storageFree)} frei auf dem Server${dbPercentText}`;
    }
  } catch (error) {
    const message = `Fehler: ${error.message || error}`;
    applyHealthClass(serverCpuCardEl, "normal");
    applyHealthClass(serverRamCardEl, "normal");
    applyHealthClass(serverStorageCardEl, "normal");
    applyHealthClass(serverDbCardEl, "normal");
    if (serverCpuUsageEl) serverCpuUsageEl.textContent = "-";
    if (serverRamUsageEl) serverRamUsageEl.textContent = "-";
    if (serverStorageFreeEl) serverStorageFreeEl.textContent = "-";
    if (serverDbSizeEl) serverDbSizeEl.textContent = "-";
    if (serverCpuMetaEl) serverCpuMetaEl.textContent = message;
    if (serverRamMetaEl) serverRamMetaEl.textContent = message;
    if (serverStorageMetaEl) serverStorageMetaEl.textContent = message;
    if (serverDbMetaEl) serverDbMetaEl.textContent = message;
  }
}

async function refreshDashboard() {
  await Promise.all([loadMqttClients(), loadMqttTopics(), loadSystemStats()]);
  updateTrendHistory(Number(clientsCountEl?.textContent || 0), Number(topicsCountEl?.textContent || 0));
}

async function fetchObjects() {
  const response = await fetch("/api/objects");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const list = await response.json();
  return Array.isArray(list) ? list : [];
}

async function ensureObjectMeta(objectId) {
  if (!Number.isFinite(objectId)) {
    return { keys: [], commands: [] };
  }

  if (objectMetaCache.has(objectId)) {
    return objectMetaCache.get(objectId);
  }

  const metaPromise = Promise.all([
    fetch(`/api/objects/${objectId}/keys`).then((r) => (r.ok ? r.json() : [])),
    fetch(`/api/objects/${objectId}/commands`).then((r) => (r.ok ? r.json() : { commands: [] })),
  ]).then(([keys, commandPayload]) => ({
    keys: Array.isArray(keys) ? keys : [],
    commands: Array.isArray(commandPayload?.commands) ? commandPayload.commands : [],
  }));

  objectMetaCache.set(objectId, metaPromise);
  return metaPromise;
}

function renderObjectOptions(selectedId) {
  if (!widgetObjectEl) return;

  if (!objectsCache.length) {
    widgetObjectEl.innerHTML = '<option value="">Keine Objekte</option>';
    return;
  }

  widgetObjectEl.innerHTML = objectsCache
    .map((object) => {
      const selected = Number(object.id) === Number(selectedId) ? "selected" : "";
      return `<option value="${object.id}" ${selected}>${escapeHtml(object.name)}</option>`;
    })
    .join("");
}

async function populateDetailOptions(preferredWidget = null) {
  if (!widgetDetailEl || !widgetTypeEl || !widgetObjectEl) return;

  const objectId = Number(widgetObjectEl.value);
  const type = widgetTypeEl.value;
  const meta = await ensureObjectMeta(objectId);

  widgetDetailLabelEl.textContent = type === "command" ? "Befehl" : "Messwert";

  if (type === "command") {
    if (!meta.commands.length) {
      widgetDetailEl.innerHTML = '<option value="">Keine Befehle</option>';
      return;
    }

    widgetDetailEl.innerHTML = meta.commands
      .map((command, index) => {
        const selected =
          preferredWidget &&
          preferredWidget.type === "command" &&
          command.label === preferredWidget.commandLabel &&
          command.topic === preferredWidget.commandTopic &&
          command.payload === preferredWidget.commandPayload
            ? "selected"
            : "";
        return `
          <option
            value="${index}"
            data-label="${escapeHtml(command.label)}"
            data-topic="${escapeHtml(command.topic)}"
            data-payload="${escapeHtml(command.payload)}"
            ${selected}
          >
            ${escapeHtml(command.label)}
          </option>
        `;
      })
      .join("");
    return;
  }

  if (!meta.keys.length) {
    widgetDetailEl.innerHTML = '<option value="">Keine Keys</option>';
    return;
  }

  widgetDetailEl.innerHTML = meta.keys
    .map((key) => {
      const label = key.label ? `${key.label} (${key.value_key})` : key.value_key;
      const suffix = key.unit ? ` [${key.unit}]` : "";
      const selected = preferredWidget && preferredWidget.type === "value" && preferredWidget.keyName === key.value_key ? "selected" : "";
      return `
        <option
          value="${escapeHtml(key.value_key)}"
          data-label="${escapeHtml(key.label || "")}"
          data-unit="${escapeHtml(key.unit || "")}"
          ${selected}
        >
          ${escapeHtml(label + suffix)}
        </option>
      `;
    })
    .join("");
}

function resetWidgetForm() {
  editingWidgetId = null;
  widgetForm?.reset();
  widgetTypeEl.value = "value";
  renderObjectOptions(objectsCache[0]?.id || "");
  populateDetailOptions().catch(() => {});
  if (widgetCancelEl) widgetCancelEl.style.display = "none";
}

function getWidgetById(widgetId) {
  return widgets.find((widget) => widget.id === widgetId) || null;
}

function getSelectedOption(selectEl) {
  return selectEl?.selectedOptions?.[0] || null;
}

async function loadWidgetObjects() {
  objectsCache = await fetchObjects();
  renderObjectOptions(objectsCache[0]?.id || "");
  await populateDetailOptions();
}

function storeWidgetFeedback(widgetId, text, isError = false) {
  widgetFeedback.set(widgetId, { text, isError });
}

async function resolveWidgetState(widget) {
  if (widget.type === "command") {
    return {
      kind: "command",
      title: widget.title || widget.commandLabel || "Befehl",
      objectName: widget.objectName || "Objekt",
      topic: widget.commandTopic || "",
      payload: widget.commandPayload || "",
      status: widgetFeedback.get(widget.id) || null,
    };
  }

  try {
    const params = new URLSearchParams({ key: widget.keyName, limit: "1" });
    const response = await fetch(`/api/objects/${widget.objectId}/readings?${params.toString()}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const list = await response.json();
    const reading = Array.isArray(list) ? list[0] : null;

    return {
      kind: "value",
      title: widget.title || widget.keyLabel || widget.keyName,
      objectName: widget.objectName || "Objekt",
      value: reading?.value_text || "-",
      unit: widget.unit || "",
      timestamp: reading?.created_at ? new Date(reading.created_at).toLocaleString() : "Noch kein Wert",
      topic: reading?.topic || "",
      status: widgetFeedback.get(widget.id) || null,
    };
  } catch (error) {
    return {
      kind: "value",
      title: widget.title || widget.keyLabel || widget.keyName,
      objectName: widget.objectName || "Objekt",
      value: "Fehler",
      unit: "",
      timestamp: error.message || "Fehler",
      topic: "",
      status: { text: "Laden fehlgeschlagen", isError: true },
    };
  }
}

function renderWidgets() {
  if (!widgetListEl) return;

  if (!widgets.length) {
    widgetListEl.innerHTML = '<li class="quick-widget-empty">Noch keine Schnellkarten gespeichert.</li>';
    return;
  }

  widgetListEl.innerHTML = widgets
    .map((widget, index) => {
      const state = widgetStates.get(widget.id) || {};
      const statusLine = state.status
        ? `<span class="${state.status.isError ? "quick-widget-error" : "quick-widget-ok"}">${escapeHtml(state.status.text)}</span>`
        : "";

      if (state.kind === "command") {
        return `
          <li class="quick-widget-card" data-widget-id="${widget.id}">
            <div class="quick-widget-top">
              <div class="quick-widget-title">
                <strong>${escapeHtml(state.title || "Befehl")}</strong>
                <span>${escapeHtml(state.objectName || "")}</span>
              </div>
              <div class="quick-widget-actions">
                <button type="button" class="cmd-send" data-action="edit">Bearbeiten</button>
                <button type="button" class="cmd-send" data-action="up" ${index === 0 ? "disabled" : ""}>Hoch</button>
                <button type="button" class="cmd-send" data-action="down" ${index === widgets.length - 1 ? "disabled" : ""}>Runter</button>
                <button type="button" class="cmd-delete" data-action="delete">Loeschen</button>
              </div>
            </div>
            <button type="button" class="quick-widget-run" data-action="run">Senden</button>
            ${statusLine}
          </li>
        `;
      }

      const unit = state.unit ? ` ${escapeHtml(state.unit)}` : "";
      return `
        <li class="quick-widget-card" data-widget-id="${widget.id}">
          <div class="quick-widget-top">
            <div class="quick-widget-title">
              <strong>${escapeHtml(state.title || "Messwert")}</strong>
              <span>${escapeHtml(state.objectName || "")}</span>
            </div>
            <div class="quick-widget-actions">
              <button type="button" class="cmd-send" data-action="edit">Bearbeiten</button>
              <button type="button" class="cmd-send" data-action="up" ${index === 0 ? "disabled" : ""}>Hoch</button>
              <button type="button" class="cmd-send" data-action="down" ${index === widgets.length - 1 ? "disabled" : ""}>Runter</button>
              <button type="button" class="cmd-delete" data-action="delete">Loeschen</button>
            </div>
          </div>
          <div class="quick-widget-value">${escapeHtml(state.value || "-")}${unit}</div>
          <div class="quick-widget-meta">${escapeHtml(state.timestamp || "")}</div>
          ${statusLine}
        </li>
      `;
    })
    .join("");
}

async function refreshWidgetStates() {
  const resolved = await Promise.all(widgets.map((widget) => resolveWidgetState(widget)));
  widgetStates = new Map(resolved.map((state, index) => [widgets[index].id, state]));
  renderWidgets();
}

async function moveWidget(widgetId, direction) {
  const currentIndex = widgets.findIndex((widget) => widget.id === widgetId);
  if (currentIndex < 0) return;

  const nextIndex = currentIndex + direction;
  if (nextIndex < 0 || nextIndex >= widgets.length) return;

  const previousWidgets = widgets.slice();
  const [moved] = widgets.splice(currentIndex, 1);
  widgets.splice(nextIndex, 0, moved);
  try {
    await saveWidgets();
    await refreshWidgetStates();
  } catch (error) {
    widgets = previousWidgets;
    setWidgetStatus(`Reihenfolge konnte nicht gespeichert werden: ${error.message || error}`, true);
    await refreshWidgetStates();
  }
}

function startWidgetEdit(widgetId) {
  const widget = getWidgetById(widgetId);
  if (!widget) return;

  editingWidgetId = widget.id;
  widgetTypeEl.value = widget.type;
  renderObjectOptions(widget.objectId);
  widgetTitleEl.value = widget.title || "";
  if (widgetCancelEl) widgetCancelEl.style.display = "inline-flex";
  openQuickBuilder();

  populateDetailOptions(widget).catch(() => {
    setWidgetStatus("Bearbeiten konnte nicht vorbereitet werden.", true);
  });
}

async function publishWidgetCommand(widgetId) {
  const widget = getWidgetById(widgetId);
  if (!widget || widget.type !== "command") return;

  try {
    const response = await fetch("/api/mqtt/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic: widget.commandTopic,
        payload: widget.commandPayload,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok !== true) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    storeWidgetFeedback(widgetId, "Gesendet");
  } catch (error) {
    storeWidgetFeedback(widgetId, error.message || "Fehler", true);
  }

  await refreshWidgetStates();
}

widgetForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  setWidgetStatus("");

  const objectId = Number(widgetObjectEl.value);
  const object = objectsCache.find((entry) => Number(entry.id) === objectId);
  const detailOption = getSelectedOption(widgetDetailEl);

  if (!object) {
    setWidgetStatus("Bitte zuerst ein Objekt waehlen.", true);
    return;
  }

  if (!detailOption || !detailOption.value) {
    setWidgetStatus("Bitte einen Messwert oder Befehl waehlen.", true);
    return;
  }

  const widgetId = editingWidgetId || createWidgetId();
  const baseWidget = {
    id: widgetId,
    type: widgetTypeEl.value,
    objectId,
    objectName: object.name,
    title: widgetTitleEl.value.trim(),
  };

  let nextWidget;
  if (widgetTypeEl.value === "command") {
    nextWidget = {
      ...baseWidget,
      commandLabel: detailOption.dataset.label || detailOption.textContent.trim(),
      commandTopic: detailOption.dataset.topic || "",
      commandPayload: detailOption.dataset.payload || "",
    };
  } else {
    nextWidget = {
      ...baseWidget,
      keyName: detailOption.value,
      keyLabel: detailOption.dataset.label || "",
      unit: detailOption.dataset.unit || "",
    };
  }

  const existingIndex = widgets.findIndex((widget) => widget.id === widgetId);
  const previousWidgets = widgets.slice();
  if (existingIndex >= 0) {
    widgets.splice(existingIndex, 1, nextWidget);
  } else {
    widgets.push(nextWidget);
  }

  try {
    await saveWidgets();
    resetWidgetForm();
    setWidgetStatus(existingIndex >= 0 ? "Schnellkarte aktualisiert." : "Schnellkarte gespeichert.");
    await refreshWidgetStates();
  } catch (error) {
    widgets = previousWidgets;
    setWidgetStatus(`Schnellkarte konnte nicht gespeichert werden: ${error.message || error}`, true);
    await refreshWidgetStates();
  }
});

widgetCancelEl?.addEventListener("click", () => {
  resetWidgetForm();
  setWidgetStatus("");
});

widgetTypeEl?.addEventListener("change", () => {
  populateDetailOptions().catch(() => {
    setWidgetStatus("Optionen konnten nicht geladen werden.", true);
  });
});

widgetObjectEl?.addEventListener("change", () => {
  populateDetailOptions().catch(() => {
    setWidgetStatus("Optionen konnten nicht geladen werden.", true);
  });
});

widgetListEl?.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const card = button.closest("[data-widget-id]");
  const widgetId = card?.getAttribute("data-widget-id");
  if (!widgetId) return;

  const action = button.dataset.action;
  if (action === "edit") {
    startWidgetEdit(widgetId);
    return;
  }

  if (action === "delete") {
    const previousWidgets = widgets.slice();
    widgets = widgets.filter((widget) => widget.id !== widgetId);
    widgetFeedback.delete(widgetId);
    widgetStates.delete(widgetId);
    try {
      await saveWidgets();
      await refreshWidgetStates();
    } catch (error) {
      widgets = previousWidgets;
      setWidgetStatus(`Loeschen fehlgeschlagen: ${error.message || error}`, true);
      await refreshWidgetStates();
    }
    return;
  }

  if (action === "up") {
    await moveWidget(widgetId, -1);
    return;
  }

  if (action === "down") {
    await moveWidget(widgetId, 1);
    return;
  }

  if (action === "run") {
    button.disabled = true;
    await publishWidgetCommand(widgetId);
    button.disabled = false;
  }
});

async function initQuickBoard() {
  try {
    widgets = await loadStoredWidgets();
    await loadWidgetObjects();
    resetWidgetForm();
    openQuickBoard();
    await refreshWidgetStates();
  } catch (error) {
    setWidgetStatus(`Schnellzugriff konnte nicht geladen werden: ${error.message || error}`, true);
  }
}

refreshDashboard();
initQuickBoard();

setInterval(refreshDashboard, 10000);
setInterval(() => {
  refreshWidgetStates().catch(() => {});
}, 15000);
