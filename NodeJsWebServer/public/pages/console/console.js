const elements = {
  output: document.getElementById("console-output"),
  empty: document.getElementById("console-empty"),
  search: document.getElementById("console-search"),
  level: document.getElementById("console-level"),
  pause: document.getElementById("console-pause"),
  clear: document.getElementById("console-clear"),
  autoScroll: document.getElementById("console-auto-scroll"),
  entryCount: document.getElementById("console-entry-count"),
  bufferStatus: document.getElementById("console-buffer-status"),
  connectionStatus: document.getElementById("console-connection-status"),
  connectionDot: document.getElementById("console-connection-dot"),
};

const MAX_BROWSER_ENTRIES = 3000;
let entries = [];
let visibleCount = 0;
let lastEventId = 0;
let paused = false;
let stream = null;
let pausedEntries = [];
let pendingCount = 0;
let initialLoading = false;
const retryButton = document.getElementById("console-retry");
const exportButton = document.getElementById("console-export");
const displayEntries = () => paused ? pausedEntries : entries;

function formatTimestamp(timestamp) {
  return new Date(timestamp).toLocaleTimeString("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
}

function matchesFilters(entry) {
  const selectedLevel = elements.level.value;
  if (selectedLevel !== "all" && entry.level !== selectedLevel) return false;
  const query = elements.search.value.trim().toLocaleLowerCase("de-DE");
  return !query || entry.message.toLocaleLowerCase("de-DE").includes(query);
}

function createLogLine(entry) {
  const row = document.createElement("div");
  row.className = `console-line console-line-${entry.level}`;
  row.dataset.entryId = String(entry.id);

  const timestamp = document.createElement("time");
  timestamp.dateTime = new Date(entry.timestamp).toISOString();
  timestamp.textContent = formatTimestamp(entry.timestamp);

  const level = document.createElement("span");
  level.className = "console-level-badge";
  level.textContent = entry.level.toUpperCase();

  const message = document.createElement("span");
  message.className = "console-message";
  message.textContent = entry.message;

  row.append(timestamp, level, message);
  return row;
}

function scrollToBottom() {
  if (!elements.autoScroll.checked) return;
  elements.output.scrollTop = elements.output.scrollHeight;
}

function updateCounters() {
  elements.entryCount.textContent = `${visibleCount} von ${displayEntries().length} Zeilen`;
  elements.empty.hidden = visibleCount > 0;
  elements.empty.textContent = displayEntries().length ? "Keine passenden Zeilen. Filter anpassen." : "Noch keine Zeilen in dieser Ansicht.";
  exportButton.disabled = visibleCount === 0;
  if (paused) elements.bufferStatus.textContent = `Anzeige pausiert. ${pendingCount} neue Zeilen empfangen. Fortsetzen zeigt die neuesten ${MAX_BROWSER_ENTRIES} verfügbaren Zeilen.`;
}

function renderAll() {
  elements.output.querySelectorAll(".console-line").forEach((node) => node.remove());
  const fragment = document.createDocumentFragment();
  visibleCount = 0;
  for (const entry of displayEntries()) {
    if (!matchesFilters(entry)) continue;
    fragment.append(createLogLine(entry));
    visibleCount += 1;
  }
  elements.output.append(fragment);
  updateCounters();
  scrollToBottom();
}

function appendEntry(entry) {
  if (!entry || !Number.isFinite(Number(entry.id)) || Number(entry.id) <= lastEventId) return;
  lastEventId = Number(entry.id);
  entries.push(entry);
  if (paused) pendingCount += 1;
  if (entries.length > MAX_BROWSER_ENTRIES) {
    const removed = entries.splice(0, entries.length - MAX_BROWSER_ENTRIES);
    for (const oldEntry of paused ? [] : removed) {
      const node = elements.output.querySelector(`[data-entry-id="${oldEntry.id}"]`);
      if (node) {
        node.remove();
        visibleCount = Math.max(0, visibleCount - 1);
      }
    }
  }

  if (!paused && matchesFilters(entry)) {
    elements.output.append(createLogLine(entry));
    visibleCount += 1;
    scrollToBottom();
  }
  updateCounters();
}

function setConnection(state, text) {
  elements.connectionStatus.textContent = text;
  elements.connectionDot.dataset.state = state;
}

function connectStream() {
  stream?.close();
  stream = new EventSource(`/console/stream?after=${encodeURIComponent(lastEventId)}`);
  stream.addEventListener("open", () => setConnection("online", "Verbunden"));
  stream.addEventListener("log", (event) => {
    try {
      appendEntry(JSON.parse(event.data));
    } catch {
      setConnection("warning", "Ungueltige Logzeile");
    }
  });
  stream.addEventListener("error", () => setConnection("warning", "Verbindung wird erneuert"));
}

async function loadInitialLogs() {
  if (initialLoading) return;
  initialLoading = true;
  retryButton.disabled = true;
  retryButton.hidden = true;
  setConnection("warning", "Verbinde …");
  try {
  const response = await fetch("/console/logs?limit=1500", {
    headers: { Accept: "application/json" },
    credentials: "same-origin",
    signal: AbortSignal.timeout(12000),
  });
  if (response.redirected) {
    window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
    return;
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  entries = Array.isArray(data.entries) ? data.entries.slice(-MAX_BROWSER_ENTRIES) : [];
  lastEventId = Math.max(Number(data.lastId || 0), ...entries.map((entry) => Number(entry.id || 0)));
  elements.bufferStatus.textContent = `Die letzten ${entries.length} Serverzeilen sind im Browser verfuegbar.`;
  renderAll();
  connectStream();
  } catch (error) {
    setConnection("offline", "Nicht verbunden");
    elements.bufferStatus.textContent = `Konsole konnte nicht geladen werden: ${error.message}`;
    retryButton.hidden = false;
  } finally {
    initialLoading = false;
    retryButton.disabled = false;
  }
}

elements.search.addEventListener("input", renderAll);
elements.level.addEventListener("change", renderAll);

elements.pause.addEventListener("click", () => {
  paused = !paused;
  pausedEntries = paused ? entries.slice() : [];
  pendingCount = 0;
  elements.pause.textContent = paused ? "Fortsetzen" : "Pausieren";
  elements.pause.classList.toggle("is-paused", paused);
  elements.pause.setAttribute("aria-pressed", String(paused));
  if (!paused) elements.bufferStatus.textContent = `Live-Ansicht. Bis zu ${MAX_BROWSER_ENTRIES} Zeilen bleiben im Browser.`;
  renderAll();
});

elements.clear.addEventListener("click", () => {
  entries = [];
  pausedEntries = [];
  pendingCount = 0;
  visibleCount = 0;
  elements.output.querySelectorAll(".console-line").forEach((node) => node.remove());
  elements.bufferStatus.textContent = "Lokale Ansicht geleert. Neue Meldungen werden weiter empfangen.";
  updateCounters();
});

elements.autoScroll.addEventListener("change", scrollToBottom);
elements.output.addEventListener("scroll", () => {
  const distanceFromBottom = elements.output.scrollHeight - elements.output.scrollTop - elements.output.clientHeight;
  if (distanceFromBottom > 60) elements.autoScroll.checked = false;
});

window.addEventListener("beforeunload", () => stream?.close());

retryButton.addEventListener("click", loadInitialLogs);
exportButton.addEventListener("click", () => {
  const lines = displayEntries().filter(matchesFilters).map((entry) =>
    `${new Date(entry.timestamp).toISOString()} [${entry.level.toUpperCase()}] ${entry.message}`);
  if (!lines.length) return;
  const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `serverlog-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
loadInitialLogs();
