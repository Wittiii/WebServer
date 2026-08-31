import { initDashboardOverview } from "./dashboard-overview.js";
import { escapeHtml } from "./dashboard-utils.js";

const widgetForm = document.getElementById("quick-widget-form");
const widgetTypeEl = document.getElementById("quick-widget-type");
const widgetObjectEl = document.getElementById("quick-widget-object");
const widgetDetailEl = document.getElementById("quick-widget-detail");
const widgetDetailLabelEl = document.getElementById("quick-widget-detail-label");
const widgetTitleEl = document.getElementById("quick-widget-title");
const widgetCancelEl = document.getElementById("quick-widget-cancel");
const widgetStatusEl = document.getElementById("quick-widget-status");
const widgetListEl = document.getElementById("quick-widget-list");
const widgetManageListEl = document.getElementById("quick-widget-manage-list");
const quickBoardSection = document.getElementById("dashboard-quick-board");
const quickBuilderSection = document.getElementById("dashboard-quick-builder");

let widgets = [];
let objectsCache = [];
let editingWidgetId = null;
let widgetStates = new Map();
let widgetFeedback = new Map();
const objectMetaCache = new Map();
let widgetRefreshInFlight = false;

function setWidgetStatus(text, isError = false) {
  if (!widgetStatusEl) return;
  widgetStatusEl.textContent = text;
  widgetStatusEl.style.color = isError ? "var(--danger)" : "var(--muted)";
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
    renderWidgetManagement();
    return;
  }

  widgetListEl.innerHTML = widgets
    .map((widget) => {
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
          </div>
          <div class="quick-widget-value">${escapeHtml(state.value || "-")}${unit}</div>
          <div class="quick-widget-meta">${escapeHtml(state.timestamp || "")}</div>
          ${statusLine}
        </li>
      `;
    })
    .join("");
  renderWidgetManagement();
}

function renderWidgetManagement() {
  if (!widgetManageListEl) return;
  if (!widgets.length) {
    widgetManageListEl.innerHTML = '<li class="quick-widget-empty">Keine Karten angelegt.</li>';
    return;
  }
  widgetManageListEl.innerHTML = widgets.map((widget, index) => `
    <li class="quick-manage-row" data-widget-id="${escapeHtml(widget.id)}">
      <span><strong>${escapeHtml(widget.title || widget.commandLabel || widget.keyLabel || widget.keyName || "Karte")}</strong><small>${escapeHtml(widget.objectName || "")}</small></span>
      <div class="quick-widget-actions">
        <button type="button" class="cmd-send" data-action="edit">Bearbeiten</button>
        <button type="button" class="cmd-send" data-action="up" ${index === 0 ? "disabled" : ""}>Hoch</button>
        <button type="button" class="cmd-send" data-action="down" ${index === widgets.length - 1 ? "disabled" : ""}>Runter</button>
        <button type="button" class="cmd-delete" data-action="delete">Loeschen</button>
      </div>
    </li>
  `).join("");
}

async function refreshWidgetStates() {
  if (widgetRefreshInFlight) return;
  widgetRefreshInFlight = true;
  try {
    const snapshot = widgets.slice();
    const resolved = await Promise.all(snapshot.map((widget) => resolveWidgetState(widget)));
    widgetStates = new Map(resolved.map((state, index) => [snapshot[index].id, state]));
    renderWidgets();
  } finally {
    widgetRefreshInFlight = false;
  }
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

async function handleWidgetAction(event) {
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
}

widgetListEl?.addEventListener("click", handleWidgetAction);
widgetManageListEl?.addEventListener("click", handleWidgetAction);

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

initDashboardOverview();
initQuickBoard();

setInterval(() => {
  if (document.hidden) return;
  refreshWidgetStates().catch(() => {});
}, 15000);
